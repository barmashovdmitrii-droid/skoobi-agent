import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import { verifySignature, verifyWebhookRequest, startWebhookServer } from './server.js';
import type { IngestionEnvelope, MessageIngestion } from '../orchestrator/types.js';

describe('verifySignature', () => {
  const secret = 'test-secret-key';
  const payload = JSON.stringify({ prompt: 'hello' });

  it('accepts valid HMAC signature', () => {
    const signature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    expect(verifySignature(secret, payload, signature)).toBe(true);
  });

  it('rejects invalid HMAC signature', () => {
    const badSignature = crypto
      .createHmac('sha256', 'wrong-secret')
      .update(payload)
      .digest('hex');
    expect(verifySignature(secret, payload, badSignature)).toBe(false);
  });

  it('rejects malformed signature', () => {
    expect(verifySignature(secret, payload, 'not-hex-at-all!!')).toBe(false);
  });

  it('rejects empty signature', () => {
    expect(verifySignature(secret, payload, '')).toBe(false);
  });
});

describe('verifyWebhookRequest', () => {
  const secret = 'test-secret-key';
  const nowMs = 1_700_000_000_000;
  const nowSeconds = Math.floor(nowMs / 1000);
  const body = JSON.stringify({ prompt: 'hello' });

  function signWithTimestamp(ts: number | string, payloadBody: string): string {
    return crypto
      .createHmac('sha256', secret)
      .update(`${ts}.${payloadBody}`)
      .digest('hex');
  }

  it('accepts a fresh, correctly-signed request', () => {
    const ts = nowSeconds;
    const result = verifyWebhookRequest(
      secret,
      { timestamp: String(ts), body, signature: signWithTimestamp(ts, body) },
      nowMs,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a missing timestamp', () => {
    const result = verifyWebhookRequest(
      secret,
      { body, signature: signWithTimestamp(nowSeconds, body) },
      nowMs,
    );
    expect(result).toMatchObject({ ok: false, status: 401, error: 'Invalid signature' });
  });

  it('rejects a missing signature', () => {
    const result = verifyWebhookRequest(secret, { timestamp: String(nowSeconds), body }, nowMs);
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects a non-numeric timestamp', () => {
    const result = verifyWebhookRequest(
      secret,
      { timestamp: 'not-a-number', body, signature: signWithTimestamp('not-a-number', body) },
      nowMs,
    );
    expect(result).toMatchObject({ ok: false, status: 401, error: 'Invalid timestamp' });
  });

  it('rejects a stale timestamp (outside ±5 min window)', () => {
    const staleTs = nowSeconds - 600; // 10 minutes ago
    const result = verifyWebhookRequest(
      secret,
      { timestamp: String(staleTs), body, signature: signWithTimestamp(staleTs, body) },
      nowMs,
    );
    expect(result).toMatchObject({ ok: false, status: 401, error: 'Stale timestamp' });
  });

  it('rejects a future timestamp (outside ±5 min window)', () => {
    const futureTs = nowSeconds + 600; // 10 minutes ahead
    const result = verifyWebhookRequest(
      secret,
      { timestamp: String(futureTs), body, signature: signWithTimestamp(futureTs, body) },
      nowMs,
    );
    expect(result).toMatchObject({ ok: false, status: 401, error: 'Stale timestamp' });
  });

  it('rejects a body-only signature (timestamp not bound into HMAC)', () => {
    // A signature over just the body — what a pre-hardening replay would carry.
    const bodyOnlySig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const result = verifyWebhookRequest(
      secret,
      { timestamp: String(nowSeconds), body, signature: bodyOnlySig },
      nowMs,
    );
    expect(result).toMatchObject({ ok: false, status: 401, error: 'Invalid signature' });
  });

  it('rejects a signature for a different body', () => {
    const result = verifyWebhookRequest(
      secret,
      { timestamp: String(nowSeconds), body, signature: signWithTimestamp(nowSeconds, 'other body') },
      nowMs,
    );
    expect(result).toMatchObject({ ok: false, status: 401, error: 'Invalid signature' });
  });

  it('canonicalizes an upper-case hex signature to lower-case', () => {
    // HMAC hex is case-insensitive on decode, so an upper-cased signature
    // verifies — but it must be returned canonicalized so the downstream
    // replay cache cannot be bypassed via case variation.
    const ts = nowSeconds;
    const upperSig = signWithTimestamp(ts, body).toUpperCase();
    const result = verifyWebhookRequest(
      secret,
      { timestamp: String(ts), body, signature: upperSig },
      nowMs,
    );
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ ok: true, signature: upperSig.toLowerCase() });
  });

  it('surfaces the parsed timestamp so the replay cache can anchor expiry to the validity horizon', () => {
    // A forward-skewed client: ts is ahead of "now" but still within the
    // window. The replay cache must be able to expire at ts+skew (not at
    // first-seen), so verifyWebhookRequest must return the parsed ts.
    const ts = nowSeconds + 250; // within ±300s
    const result = verifyWebhookRequest(
      secret,
      { timestamp: String(ts), body, signature: signWithTimestamp(ts, body) },
      nowMs,
    );
    expect(result).toMatchObject({ ok: true, timestamp: ts });
  });
});

describe('webhook server HTTP', () => {
  const secret = 'webhook-test-secret';

  /** Sign `${timestamp}.${body}` exactly as the server expects. */
  function sign(ts: number | string, payload: string): string {
    return crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  }

  /** Build the headers a legitimate caller sends (fresh timestamp + signature). */
  function signedHeaders(payload: string): Record<string, string> {
    const ts = Math.floor(Date.now() / 1000);
    return {
      'content-type': 'application/json',
      'x-timestamp': String(ts),
      'x-signature': sign(ts, payload),
    };
  }

  function makeRequest(
    port: number,
    method: string,
    urlPath: string,
    body?: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method, headers },
        (res) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => {
            resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : {} });
          });
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  let server: http.Server;
  let port: number;
  const ingestedEnvelopes: IngestionEnvelope[] = [];

  function createMockIngestion(): MessageIngestion {
    return {
      addPreHook: vi.fn(),
      addPostHook: vi.fn(),
      ingest: vi.fn(async (envelope: IngestionEnvelope) => {
        ingestedEnvelopes.push(envelope);
        return true;
      }),
    };
  }

  beforeEach(async () => {
    ingestedEnvelopes.length = 0;

    server = startWebhookServer(0, secret, {
      ingestion: createMockIngestion(),
      findGroupByFolder: (folder) => {
        if (folder === 'test-group') return { jid: 'test-jid@g.us', name: 'Test Group' };
        return undefined;
      },
    });

    // Wait for server to start and get the assigned port
    await new Promise<void>((resolve) => {
      server.on('listening', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(() => {
    server.close();
  });

  it('binds to the loopback interface (127.0.0.1) by default', () => {
    const addr = server.address();
    expect(typeof addr === 'object' && addr ? addr.address : '').toBe('127.0.0.1');
  });

  it('responds to health check', async () => {
    const res = await makeRequest(port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns 404 for missing group folder', async () => {
    const body = JSON.stringify({ prompt: 'test' });
    const res = await makeRequest(port, 'POST', '/webhook/nonexistent', body, signedHeaders(body));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Group not found');
  });

  it('returns 401 for invalid signature', async () => {
    const body = JSON.stringify({ prompt: 'test' });
    const ts = Math.floor(Date.now() / 1000);
    const res = await makeRequest(port, 'POST', '/webhook/test-group', body, {
      'content-type': 'application/json',
      'x-timestamp': String(ts),
      'x-signature': 'badsignature00000000000000000000000000000000000000000000000000000',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
  });

  it('returns 401 when the timestamp header is missing', async () => {
    const body = JSON.stringify({ prompt: 'test' });
    const ts = Math.floor(Date.now() / 1000);
    const res = await makeRequest(port, 'POST', '/webhook/test-group', body, {
      'content-type': 'application/json',
      'x-signature': sign(ts, body), // valid sig but no X-Timestamp header sent
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a stale timestamp', async () => {
    const body = JSON.stringify({ prompt: 'test' });
    const staleTs = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const res = await makeRequest(port, 'POST', '/webhook/test-group', body, {
      'content-type': 'application/json',
      'x-timestamp': String(staleTs),
      'x-signature': sign(staleTs, body), // correctly signed, but stale
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Stale timestamp');
  });

  it('accepts valid webhook and ingests', async () => {
    const body = JSON.stringify({ prompt: 'run report' });
    const res = await makeRequest(port, 'POST', '/webhook/test-group', body, signedHeaders(body));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(res.body.group).toBe('Test Group');
    expect(ingestedEnvelopes).toHaveLength(1);
    expect(ingestedEnvelopes[0].chatJid).toBe('test-jid@g.us');
    expect(ingestedEnvelopes[0].prompt).toBe('run report');
    expect(ingestedEnvelopes[0].triggerType).toBe('webhook');
    expect(ingestedEnvelopes[0].bypassTrigger).toBe(true);
  });

  it('rejects a replayed request (same signature twice)', async () => {
    const body = JSON.stringify({ prompt: 'run once' });
    const headers = signedHeaders(body); // fixed timestamp + signature, reused
    const first = await makeRequest(port, 'POST', '/webhook/test-group', body, headers);
    expect(first.status).toBe(200);
    const replay = await makeRequest(port, 'POST', '/webhook/test-group', body, headers);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('Replay detected');
    // Only the first request was ingested.
    expect(ingestedEnvelopes).toHaveLength(1);
  });

  it('keeps rejecting a replay until the signature falls out of its freshness window (skewed clock)', async () => {
    // Regression: the replay-cache entry must expire at the signature's
    // validity horizon (ts + skew), not at first-seen time. A client whose
    // clock runs ahead sends a future-but-fresh ts; the captured request stays
    // HMAC-acceptable until ts+skew. If the cache expired at first-seen+skew it
    // would be evicted *before* the signature went stale, reopening a replay
    // window. We drive the server clock with a spy (real timers untouched, so
    // socket handling is unaffected) to prove the entry survives that gap.
    const SKEW = 300; // MAX_TIMESTAMP_SKEW_SECONDS
    const baseMs = 1_700_000_000_000; // fixed virtual "now" at first-seen
    const skewedTs = Math.floor(baseMs / 1000) + 250; // 250s ahead, within ±300

    const body = JSON.stringify({ prompt: 'skewed once' });
    const headers = {
      'content-type': 'application/json',
      'x-timestamp': String(skewedTs),
      'x-signature': sign(skewedTs, body),
    };

    const nowSpy = vi.spyOn(Date, 'now');
    try {
      // First delivery, observed at base time.
      nowSpy.mockReturnValue(baseMs);
      const first = await makeRequest(port, 'POST', '/webhook/test-group', body, headers);
      expect(first.status).toBe(200);

      // Advance just past first-seen + skew — where a first-seen-anchored
      // entry would have already expired — but while the signature is still
      // fresh (|now - ts| = 51s <= 300s). The replay must STILL be rejected.
      nowSpy.mockReturnValue(baseMs + (SKEW + 1) * 1000);
      const replay = await makeRequest(port, 'POST', '/webhook/test-group', body, headers);
      expect(replay.status).toBe(401);
      expect(replay.body.error).toBe('Replay detected');

      // The replay was not ingested a second time.
      expect(ingestedEnvelopes).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('rejects a replay disguised by upper-casing the hex signature', async () => {
    const body = JSON.stringify({ prompt: 'run once' });
    const headers = signedHeaders(body);
    const first = await makeRequest(port, 'POST', '/webhook/test-group', body, headers);
    expect(first.status).toBe(200);
    // Same HMAC, just upper-cased — verifies (hex decode is case-insensitive)
    // but must hit the SAME replay-cache entry, so it is still a replay.
    const replay = await makeRequest(port, 'POST', '/webhook/test-group', body, {
      ...headers,
      'x-signature': headers['x-signature'].toUpperCase(),
    });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('Replay detected');
    // The case-variant replay was not ingested a second time.
    expect(ingestedEnvelopes).toHaveLength(1);
  });

  it('returns 413 for an oversized body (size cap before auth)', async () => {
    const big = 'x'.repeat(70 * 1024); // 70 KB > 64 KB cap
    const body = JSON.stringify({ prompt: big });
    // Set Content-Length explicitly so the server short-circuits before reading.
    const res = await makeRequest(port, 'POST', '/webhook/test-group', body, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      ...signedHeaders(body),
    });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('Payload too large');
    expect(ingestedEnvelopes).toHaveLength(0);
  });

  it('rate-limits authenticated requests per group and returns 429', async () => {
    // 10 distinct, valid requests succeed; the 11th is rate-limited.
    for (let i = 0; i < 10; i++) {
      const body = JSON.stringify({ prompt: `req-${i}` });
      const res = await makeRequest(port, 'POST', '/webhook/test-group', body, signedHeaders(body));
      expect(res.status).toBe(200);
    }
    const overBody = JSON.stringify({ prompt: 'req-over' });
    const over = await makeRequest(port, 'POST', '/webhook/test-group', overBody, signedHeaders(overBody));
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('Rate limit exceeded');
    expect(ingestedEnvelopes).toHaveLength(10);
  });

  it('does not rate-limit or track unknown folders (map not attacker-keyed)', async () => {
    // Many valid-signature requests to distinct unknown folders all 404 —
    // group lookup gates before the rate limiter, so no map entry is created
    // and none are ever rate-limited (would be 429 otherwise).
    for (let i = 0; i < 15; i++) {
      const body = JSON.stringify({ prompt: `probe-${i}` });
      const res = await makeRequest(port, 'POST', `/webhook/unknown-${i}`, body, signedHeaders(body));
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Group not found');
    }
  });

  it('returns 404 for non-POST non-GET requests', async () => {
    const res = await makeRequest(port, 'PUT', '/webhook/test-group');
    expect(res.status).toBe(404);
  });

  it('returns 500 (not a hung socket) when ingest() throws', async () => {
    // Finding #78: ingest() runs a synchronous SQLite write that can throw
    // (SQLITE_BUSY, locked DB, disk full). The request listener must catch it
    // and respond 500 rather than let the rejection escape as an unhandled
    // promise rejection, which would leave the response unanswered until the
    // request timeout. We stand up a dedicated server whose ingest rejects.
    const throwingServer = startWebhookServer(0, secret, {
      ingestion: {
        addPreHook: vi.fn(),
        addPostHook: vi.fn(),
        ingest: vi.fn(async () => {
          throw new Error('SQLITE_BUSY: database is locked');
        }),
      },
      findGroupByFolder: (folder) =>
        folder === 'test-group' ? { jid: 'test-jid@g.us', name: 'Test Group' } : undefined,
    });
    try {
      const throwingPort = await new Promise<number>((resolve) => {
        throwingServer.on('listening', () => {
          const addr = throwingServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });
      const body = JSON.stringify({ prompt: 'will throw' });
      const res = await makeRequest(
        throwingPort,
        'POST',
        '/webhook/test-group',
        body,
        signedHeaders(body),
      );
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('ingest failed');
    } finally {
      throwingServer.close();
    }
  });

  it('attaches an error listener so a server error does not become an uncaught exception', () => {
    // Finding #33: without a 'server.on("error")' listener, an emitted 'error'
    // event is re-thrown by Node as an uncaught exception, which the global
    // handler turns into process.exit(1), killing the whole orchestrator.
    // Assert a listener is registered and that emitting an error is contained
    // (the emit does not throw because a listener consumes it).
    expect(server.listenerCount('error')).toBeGreaterThan(0);
    expect(() => server.emit('error', new Error('simulated bind failure'))).not.toThrow();
  });
});
