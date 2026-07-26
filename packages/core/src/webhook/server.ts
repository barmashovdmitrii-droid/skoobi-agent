import { createServer, IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import { logger } from '../orchestrator/logger.js';
import type { MessageIngestion } from '../orchestrator/types.js';

export interface WebhookDeps {
  ingestion: MessageIngestion;
  findGroupByFolder: (folder: string) => { jid: string; name: string } | undefined;
  /** Send a message directly to a registered group's chat without spawning
   * an agent. Used for owner-approved canned replies routed via webhook. */
  sendDirect?: (folder: string, text: string) => Promise<void>;
}

// Rate limiting: per-group request counter (applied only to authenticated,
// real groups — see handler ordering below).
const RATE_LIMIT = 10; // requests per minute
const RATE_WINDOW = 60_000;
const MAX_RATE_ENTRIES = 1000; // hard cap on the rate-limit map size

// Hard cap on the request body, enforced *before* authentication so an
// unauthenticated client cannot make the process buffer an arbitrary amount.
const MAX_BODY_BYTES = 64 * 1024; // 64 KB

// Replay protection: signed payload must carry a fresh X-Timestamp, and a
// given signature is accepted at most once within the freshness window.
const MAX_TIMESTAMP_SKEW_SECONDS = 300; // ±5 min
const MAX_SEEN_SIGNATURES = 5000; // hard cap on the replay-cache map size

// Socket-level timeouts (slow-loris mitigation). Generous for small,
// loopback-only webhook payloads but bounded so a trickling client cannot
// hold a connection open indefinitely.
const REQUEST_TIMEOUT_MS = 15_000;
const HEADERS_TIMEOUT_MS = 10_000;

class BodyTooLargeError extends Error {}

export function verifySignature(secret: string, payload: string, signature: string): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    return false;
  }
}

export type WebhookAuthResult =
  | { ok: true; signature: string; timestamp: number }
  | { ok: false; status: number; error: string };

/**
 * Verify an incoming webhook request. Requires an `X-Timestamp` within the
 * freshness window and an `X-Signature` that is HMAC-SHA256 over
 * `${timestamp}.${body}`. Binding the timestamp into the signed material is
 * what makes a captured request un-replayable once it falls outside the
 * window. Pure and stateless — replay (nonce) tracking is layered on top by
 * the server so this stays unit-testable.
 */
export function verifyWebhookRequest(
  secret: string,
  parts: { timestamp?: string; body: string; signature?: string },
  nowMs: number,
): WebhookAuthResult {
  const { timestamp, body, signature } = parts;
  if (!signature || !timestamp) {
    return { ok: false, status: 401, error: 'Invalid signature' };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, status: 401, error: 'Invalid timestamp' };
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - ts) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return { ok: false, status: 401, error: 'Stale timestamp' };
  }
  const signedPayload = `${timestamp}.${body}`;
  if (!verifySignature(secret, signedPayload, signature)) {
    return { ok: false, status: 401, error: 'Invalid signature' };
  }
  // Normalize to canonical lower-case hex before handing the signature
  // downstream. verifySignature decodes hex case-insensitively, so e.g.
  // `abcd` and `ABCD` both verify yet would be distinct replay-cache keys —
  // canonicalizing here closes that case-variation replay bypass.
  // Also surface the parsed timestamp so the replay cache can anchor its
  // expiry to the signature's validity horizon rather than first-seen time.
  return { ok: true, signature: signature.toLowerCase(), timestamp: ts };
}

function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    // Reject early when the client declares an oversized body.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      // Enforce the cap as bytes arrive, in case Content-Length lied or was
      // absent (chunked transfer). Destroy the socket to stop the flood.
      if (size > maxBytes) {
        settled = true;
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startWebhookServer(
  port: number,
  secret: string,
  deps: WebhookDeps,
  host = '127.0.0.1',
): ReturnType<typeof createServer> {
  // Per-server state, isolated to this process and reset on restart. Keeping
  // it in a closure (rather than module scope) bounds it to a single server
  // instance and keeps tests free of cross-instance state bleed.
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  const seenSignatures = new Map<string, number>(); // signature -> expiry (epoch ms)

  function checkRateLimit(groupFolder: string): boolean {
    const now = Date.now();
    const entry = requestCounts.get(groupFolder);
    if (!entry || now > entry.resetAt) {
      // Opportunistically evict expired entries before growing the map, and
      // never let it exceed a hard cap (defense-in-depth — only authenticated
      // real groups reach here, so this is normally bounded by group count).
      if (requestCounts.size >= MAX_RATE_ENTRIES) {
        for (const [key, e] of requestCounts) {
          if (now > e.resetAt) requestCounts.delete(key);
        }
      }
      requestCounts.set(groupFolder, { count: 1, resetAt: now + RATE_WINDOW });
      return true;
    }
    if (entry.count >= RATE_LIMIT) return false;
    entry.count++;
    return true;
  }

  /** Returns false if this (already-verified) signature was seen within the
   * freshness window — i.e. a replay. Records fresh signatures in a bounded,
   * self-expiring map.
   *
   * `tsSeconds` is the signature's own (verified) X-Timestamp. The cache entry
   * expires at the signature's validity horizon (`ts + skew`), NOT at
   * first-seen time. A client clock skewed forward yields a signature that
   * stays HMAC-fresh until `ts + skew`; anchoring expiry to first-seen would
   * evict the entry while the signature was still acceptable, reopening a
   * residual replay window. Anchoring to `ts + skew` keeps the cache entry
   * alive for exactly as long as the signature can pass the freshness check. */
  function checkAndRecordReplay(signature: string, tsSeconds: number): boolean {
    const now = Date.now();
    const existing = seenSignatures.get(signature);
    if (existing !== undefined && now <= existing) {
      return false;
    }
    if (seenSignatures.size >= MAX_SEEN_SIGNATURES) {
      for (const [sig, exp] of seenSignatures) {
        if (now > exp) seenSignatures.delete(sig);
      }
    }
    seenSignatures.set(signature, tsSeconds * 1000 + MAX_TIMESTAMP_SKEW_SECONDS * 1000);
    return true;
  }

  const server = createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // Routes: POST /webhook/:folder (spawn agent) and POST /send/:folder (direct send)
    const isSend = req.method === 'POST' && req.url?.startsWith('/send/');
    const isAgent = req.method === 'POST' && req.url?.startsWith('/webhook/');
    if (!isSend && !isAgent) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const prefix = isSend ? '/send/' : '/webhook/';
    const groupFolder = req.url!.slice(prefix.length).split('?')[0];
    if (!groupFolder) {
      sendJson(res, 400, { error: 'Missing group folder' });
      return;
    }

    // Read body with a hard size cap *before* authentication so an
    // unauthenticated client cannot exhaust memory.
    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: 'Payload too large' });
      } else {
        sendJson(res, 400, { error: 'Bad request' });
      }
      return;
    }

    // Verify HMAC signature + timestamp freshness.
    const auth = verifyWebhookRequest(
      secret,
      {
        timestamp: req.headers['x-timestamp'] as string | undefined,
        body,
        signature: req.headers['x-signature'] as string | undefined,
      },
      Date.now(),
    );
    if (!auth.ok) {
      sendJson(res, auth.status, { error: auth.error });
      return;
    }

    // Lookup group. Doing this before rate-limiting means the rate-limit map
    // is only ever keyed on real, registered groups (bounded), never on
    // attacker-supplied path segments.
    const group = deps.findGroupByFolder(groupFolder);
    if (!group) {
      sendJson(res, 404, { error: 'Group not found' });
      return;
    }

    // Reject replays of an already-seen (valid) signature within the window.
    if (!checkAndRecordReplay(auth.signature, auth.timestamp)) {
      sendJson(res, 401, { error: 'Replay detected' });
      return;
    }

    // Rate limit *after* authentication, keyed on the verified group folder,
    // so unauthenticated/unknown traffic can neither burn a real group's
    // budget nor grow the map.
    if (!checkRateLimit(groupFolder)) {
      sendJson(res, 429, { error: 'Rate limit exceeded' });
      return;
    }

    // Parse payload
    let payload: { prompt?: string; text?: string; [key: string]: unknown };
    try {
      payload = JSON.parse(body);
    } catch {
      payload = { prompt: body };
    }

    if (isSend) {
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (!text.trim()) {
        sendJson(res, 400, { error: 'text required' });
        return;
      }
      if (!deps.sendDirect) {
        sendJson(res, 501, { error: 'sendDirect not configured' });
        return;
      }
      try {
        await deps.sendDirect(groupFolder, text);
        logger.info(
          { groupFolder, jid: group.jid, length: text.length },
          'Direct send delivered',
        );
        sendJson(res, 200, { status: 'sent', group: group.name });
      } catch (err) {
        logger.error({ err, groupFolder }, 'Direct send failed');
        sendJson(res, 500, { error: 'send failed' });
      }
      return;
    }

    const prompt = payload.prompt || JSON.stringify(payload);

    // Ingest via the routing service. ingest() runs a synchronous better-sqlite3
    // write and can throw (SQLITE_BUSY, locked DB during backup/migration, disk
    // full, constraint). Without this try/catch the rejection would escape the
    // async request listener as an *unhandled* promise rejection (the http
    // server does not await it), leaving the response object unanswered until
    // requestTimeout forcibly closes the hung socket. Mirror the /send/ branch:
    // log and return 500 so the caller always gets a response.
    let accepted: boolean;
    try {
      accepted = await deps.ingestion.ingest({
        groupFolder,
        chatJid: group.jid,
        sender: 'webhook',
        senderName: 'Webhook',
        triggerType: 'webhook',
        prompt,
        bypassTrigger: true,
      });
    } catch (err) {
      logger.error({ err, groupFolder }, 'Webhook ingest failed');
      sendJson(res, 500, { error: 'ingest failed' });
      return;
    }

    if (accepted) {
      logger.info({ groupFolder, jid: group.jid }, 'Webhook triggered');
      sendJson(res, 200, { status: 'accepted', group: group.name });
    } else {
      sendJson(res, 200, { status: 'dropped', group: group.name });
    }
  });

  // Bound how long a single request (and its headers) may take, mitigating
  // slow-loris style holds on the shared process.
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  // Contain server-level errors (e.g. EADDRINUSE at bind time, or post-listen
  // socket/listener errors). Without a listener Node re-throws an emitted
  // 'error' as an uncaught exception, which the global handler turns into
  // process.exit(1) — taking down the whole shared multi-tenant orchestrator,
  // not just the webhook subsystem. Log and contain instead.
  server.on('error', (err) => {
    logger.error({ err, port, host }, 'Webhook server error');
  });

  server.listen(port, host, () => {
    logger.info({ port, host }, 'Webhook server listening');
  });

  return server;
}
