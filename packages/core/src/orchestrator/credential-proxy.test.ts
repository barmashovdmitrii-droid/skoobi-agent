import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
  CREDENTIAL_PROXY_IDENTITY_HEADER,
  createCredentialProxyIdentityToken,
  revokeCredentialProxyIdentityToken,
  startCredentialProxy,
  type CredentialProxyLimits,
} from './credential-proxy.js';

// Obvious placeholder standing in for the per-process shared secret that
// container-runner.ts plants as the container's credential. NOT a real-shaped
// Anthropic secret on purpose.
const CLIENT_SECRET = 'test-client-secret-placeholder';
const IDENTITY_SIGNING_SECRET = 'host-only-test-identity-signing-secret';

function identityHeader(
  tier: 'owner' | 'guest',
  tenantId: string,
  ttlMs?: number,
): string {
  return createCredentialProxyIdentityToken(
    IDENTITY_SIGNING_SECRET,
    {
      tier,
      tenantId,
    },
    ttlMs === undefined ? {} : { ttlMs },
  );
}

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let upstreamRequestCount: number;

  beforeEach(async () => {
    lastUpstreamHeaders = {};
    upstreamRequestCount = 0;

    upstreamServer = http.createServer((req, res) => {
      upstreamRequestCount += 1;
      lastUpstreamHeaders = { ...req.headers };
      // Consume the full request like the real API. Responding immediately on
      // headers would mask whether the proxy enforces its streaming body cap.
      req.on('data', () => undefined);
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(
    env: Record<string, string>,
    limits: CredentialProxyLimits = {},
    identitySigningSecret?: string,
  ): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(
      0,
      '127.0.0.1',
      CLIENT_SECRET,
      limits,
      identitySigningSecret,
    );
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects real key for an authenticated caller', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          // Authenticated caller presents the shared secret as x-api-key.
          'x-api-key': CLIENT_SECRET,
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    expect(lastUpstreamHeaders['x-api-key']).toBe('REAL-KEY-PLACEHOLDER');
  });

  it('injects configured custom headers host-side and rejects auth/hop-by-hop overrides', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER',
      ANTHROPIC_CUSTOM_HEADERS: [
        'x-vendor-account: host-only-account',
        'authorization: Bearer must-not-override',
        'x-api-key: must-not-override',
        `${CREDENTIAL_PROXY_IDENTITY_HEADER}: forged-owner`,
        'connection: keep-alive',
      ].join('\n'),
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': CLIENT_SECRET,
          'x-vendor-account': 'guest-override',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    expect(lastUpstreamHeaders['x-vendor-account']).toBe('host-only-account');
    expect(lastUpstreamHeaders['x-api-key']).toBe('REAL-KEY-PLACEHOLDER');
    expect(lastUpstreamHeaders.authorization).toBeUndefined();
    expect(
      lastUpstreamHeaders[CREDENTIAL_PROXY_IDENTITY_HEADER],
    ).toBeUndefined();
  });

  it('requires a valid host-signed tenant identity in production mode and strips it upstream', async () => {
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' },
      {},
      IDENTITY_SIGNING_SECRET,
    );

    const missing = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'x-api-key': CLIENT_SECRET },
      },
      '{}',
    );
    expect(missing.statusCode).toBe(403);

    const validToken = identityHeader('guest', 'guest-a');
    const [payload, signature] = validToken.split('.');
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...decoded, tier: 'owner' }),
      'utf8',
    ).toString('base64url');
    const forged = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': CLIENT_SECRET,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: `${forgedPayload}.${signature}`,
        },
      },
      '{}',
    );
    expect(forged.statusCode).toBe(403);

    const accepted = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': CLIENT_SECRET,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: validToken,
        },
      },
      '{}',
    );
    expect(accepted.statusCode).toBe(200);
    expect(
      lastUpstreamHeaders[CREDENTIAL_PROXY_IDENTITY_HEADER],
    ).toBeUndefined();
  });

  it('accepts only active capabilities and rejects revoked or expired runs', async () => {
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' },
      {},
      IDENTITY_SIGNING_SECRET,
    );
    const requestWith = (capability: string) =>
      makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'x-api-key': CLIENT_SECRET,
            [CREDENTIAL_PROXY_IDENTITY_HEADER]: capability,
          },
        },
        '{}',
      );

    const activeGuest = identityHeader('guest', 'active-guest');
    expect((await requestWith(activeGuest)).statusCode).toBe(200);

    revokeCredentialProxyIdentityToken(activeGuest);
    const beforeRevoked = upstreamRequestCount;
    expect((await requestWith(activeGuest)).statusCode).toBe(403);
    expect(upstreamRequestCount).toBe(beforeRevoked);

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const expiredGuest = identityHeader('guest', 'expired-guest', 1_000);
    nowSpy.mockReturnValue(1_001_001);
    const beforeExpired = upstreamRequestCount;
    expect((await requestWith(expiredGuest)).statusCode).toBe(403);
    expect(upstreamRequestCount).toBe(beforeExpired);
    nowSpy.mockRestore();

    // Owner/main uses the same lifecycle gate, without losing its broad route
    // compatibility while the concrete run remains active.
    const activeOwner = identityHeader('owner', 'active-owner');
    const ownerResponse = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/v1/files?owner-compatible=1',
      headers: {
        'x-api-key': CLIENT_SECRET,
        [CREDENTIAL_PROXY_IDENTITY_HEADER]: activeOwner,
      },
    });
    expect(ownerResponse.statusCode).toBe(200);
  });

  it('revokes capabilities when their proxy server closes', async () => {
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' },
      {},
      IDENTITY_SIGNING_SECRET,
    );
    const staleCapability = identityHeader('guest', 'closed-proxy-run');
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));

    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' },
      {},
      IDENTITY_SIGNING_SECRET,
    );
    const stale = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': CLIENT_SECRET,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: staleCapability,
        },
      },
      '{}',
    );
    expect(stale.statusCode).toBe(403);

    const fresh = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': CLIENT_SECRET,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: identityHeader(
            'guest',
            'fresh-proxy-run',
          ),
        },
      },
      '{}',
    );
    expect(fresh.statusCode).toBe(200);
  });

  it('fails token minting closed at the active capability capacity', async () => {
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' },
      {},
      IDENTITY_SIGNING_SECRET,
    );
    const capabilities = Array.from({ length: 4096 }, (_, index) =>
      identityHeader('guest', `capacity-${index}`),
    );
    expect(() => identityHeader('guest', 'capacity-overflow')).toThrow(
      /capacity reached/i,
    );

    // Capacity protects minting without invalidating a run that was already
    // admitted. Normal lifecycle cleanup below releases all slots again.
    const active = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': CLIENT_SECRET,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: capabilities[0],
        },
      },
      '{}',
    );
    expect(active.statusCode).toBe(200);
    for (const capability of capabilities) {
      revokeCredentialProxyIdentityToken(capability);
    }
  });

  it('OAuth mode injects real token on exchange path for an authenticated caller', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          // Authenticated caller presents the shared secret as the Bearer token.
          authorization: `Bearer ${CLIENT_SECRET}`,
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('signed guests can POST only exact inference paths while owner remains broad', async () => {
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' },
      {},
      IDENTITY_SIGNING_SECRET,
    );
    const guestIdentity = identityHeader('guest', 'guest-routes');
    const guestHeaders = {
      'x-api-key': CLIENT_SECRET,
      [CREDENTIAL_PROXY_IDENTITY_HEADER]: guestIdentity,
    };

    for (const request of [
      { method: 'GET', path: '/v1/messages' },
      { method: 'POST', path: '/v1/messages?smuggled=/v1/messages' },
      { method: 'POST', path: '/v1/files' },
      { method: 'POST', path: '/v1/message_batches' },
      { method: 'POST', path: '/v1/models' },
      { method: 'POST', path: '/v1/organizations/admin' },
      { method: 'POST', path: 'https://api.anthropic.com/v1/messages' },
      { method: 'POST', path: '//api.anthropic.com/v1/messages' },
      { method: 'POST', path: '/api/oauth/claude_cli/create_api_key' },
    ]) {
      const before = upstreamRequestCount;
      const response = await makeRequest(proxyPort, {
        ...request,
        headers: guestHeaders,
      });
      expect(response.statusCode, `${request.method} ${request.path}`).toBe(
        403,
      );
      expect(upstreamRequestCount).toBe(before);
    }

    for (const path of ['/v1/messages', '/v1/messages/count_tokens']) {
      const response = await makeRequest(
        proxyPort,
        { method: 'POST', path, headers: guestHeaders },
        '{}',
      );
      expect(response.statusCode).toBe(200);
      expect(lastUpstreamHeaders['x-api-key']).toBe('REAL-KEY-PLACEHOLDER');
    }

    const ownerResponse = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/v1/files?owner-compatible=1',
      headers: {
        'x-api-key': CLIENT_SECRET,
        [CREDENTIAL_PROXY_IDENTITY_HEADER]: identityHeader(
          'owner',
          'owner-routes',
        ),
      },
    });
    expect(ownerResponse.statusCode).toBe(200);
    expect(lastUpstreamHeaders['x-api-key']).toBe('REAL-KEY-PLACEHOLDER');
  });

  it('tokenizes one guest OAuth exchange and substitutes the real key only host-side', async () => {
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    const realTemporaryKey = 'real-temporary-oauth-api-key';
    let exchangeCount = 0;
    upstreamServer = http.createServer((req, res) => {
      upstreamRequestCount += 1;
      lastUpstreamHeaders = { ...req.headers };
      req.resume();
      req.on('end', () => {
        if (req.url === '/api/oauth/claude_cli/create_api_key') {
          exchangeCount += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              raw_key: realTemporaryKey,
              expires_at: '2099-01-01T00:00:00Z',
            }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
    proxyPort = await startProxy(
      { CLAUDE_CODE_OAUTH_TOKEN: 'real-host-oauth-token' },
      {
        maxConcurrentRequests: 2,
        maxConcurrentGuestRequests: 1,
        maxConcurrentBodies: 2,
        maxConcurrentGuestBodies: 1,
      },
      IDENTITY_SIGNING_SECRET,
    );

    const guestIdentity = identityHeader('guest', 'guest-oauth');
    const exchangeRequest = () =>
      makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/api/oauth/claude_cli/create_api_key',
          headers: {
            authorization: `Bearer ${CLIENT_SECRET}`,
            [CREDENTIAL_PROXY_IDENTITY_HEADER]: guestIdentity,
          },
        },
        '{}',
      );
    const exchanged = await exchangeRequest();
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.body).not.toContain(realTemporaryKey);
    const childPayload = JSON.parse(exchanged.body) as { raw_key: string };
    expect(childPayload.raw_key).toMatch(/^skoobi-guest-/);
    expect(exchangeCount).toBe(1);

    // Retry gets the same opaque result without minting another upstream key.
    const retry = await exchangeRequest();
    expect(retry.statusCode).toBe(200);
    expect(JSON.parse(retry.body).raw_key).toBe(childPayload.raw_key);
    expect(exchangeCount).toBe(1);

    const inference = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': childPayload.raw_key,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: guestIdentity,
        },
      },
      '{}',
    );
    expect(inference.statusCode).toBe(200);
    expect(lastUpstreamHeaders['x-api-key']).toBe(realTemporaryKey);

    // Even knowledge of the real temp key is not accepted on the guest channel.
    const beforeRejectedKey = upstreamRequestCount;
    const capturedKeyAttempt = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': realTemporaryKey,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: guestIdentity,
        },
      },
      '{}',
    );
    expect(capturedKeyAttempt.statusCode).toBe(403);
    expect(upstreamRequestCount).toBe(beforeRejectedKey);

    revokeCredentialProxyIdentityToken(guestIdentity);
    const beforeRevokedRun = upstreamRequestCount;
    const revokedRun = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': childPayload.raw_key,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: guestIdentity,
        },
      },
      '{}',
    );
    expect(revokedRun.statusCode).toBe(403);
    expect(upstreamRequestCount).toBe(beforeRevokedRun);

    // A replacement run for the same tenant cannot inherit the revoked run's
    // opaque alias or cached exchange state; it must exchange afresh.
    const replacementIdentity = identityHeader('guest', 'guest-oauth');
    const inheritedAlias = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': childPayload.raw_key,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: replacementIdentity,
        },
      },
      '{}',
    );
    expect(inheritedAlias.statusCode).toBe(403);

    const replacementExchange = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          authorization: `Bearer ${CLIENT_SECRET}`,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: replacementIdentity,
        },
      },
      '{}',
    );
    expect(replacementExchange.statusCode).toBe(200);
    expect(JSON.parse(replacementExchange.body).raw_key).not.toBe(
      childPayload.raw_key,
    );
    expect(exchangeCount).toBe(2);
  });

  it('fails a zero-byte guest OAuth exchange once without leaking slots or mint retries', async () => {
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    let exchangeCount = 0;
    upstreamServer = http.createServer((req, res) => {
      upstreamRequestCount += 1;
      req.resume();
      req.on('end', () => {
        exchangeCount += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end();
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
    proxyPort = await startProxy(
      { CLAUDE_CODE_OAUTH_TOKEN: 'real-host-oauth-token' },
      {
        maxConcurrentRequests: 2,
        maxConcurrentGuestRequests: 1,
        maxConcurrentBodies: 2,
        maxConcurrentGuestBodies: 1,
      },
      IDENTITY_SIGNING_SECRET,
    );
    const guestIdentity = identityHeader('guest', 'guest-empty-oauth');
    const request = () =>
      makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/api/oauth/claude_cli/create_api_key',
          headers: {
            authorization: `Bearer ${CLIENT_SECRET}`,
            [CREDENTIAL_PROXY_IDENTITY_HEADER]: guestIdentity,
          },
        },
        '{}',
      );

    expect((await request()).statusCode).toBe(502);
    expect(exchangeCount).toBe(1);
    // Terminal cached failure: do not retry an exchange that may have minted a
    // key upstream but returned a malformed/truncated body.
    expect((await request()).statusCode).toBe(502);
    expect(exchangeCount).toBe(1);
  });

  it('does not resurrect OAuth state when a run is revoked mid-exchange', async () => {
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    let markExchangeArrived!: () => void;
    const exchangeArrived = new Promise<void>(
      (resolve) => (markExchangeArrived = resolve),
    );
    let releaseExchange!: () => void;
    const exchangeRelease = new Promise<void>(
      (resolve) => (releaseExchange = resolve),
    );
    upstreamServer = http.createServer((req, res) => {
      upstreamRequestCount += 1;
      req.resume();
      req.on('end', () => {
        markExchangeArrived();
        void exchangeRelease.then(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ raw_key: 'revoked-run-real-key' }));
        });
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
    proxyPort = await startProxy(
      { CLAUDE_CODE_OAUTH_TOKEN: 'real-host-oauth-token' },
      {},
      IDENTITY_SIGNING_SECRET,
    );

    const guestIdentity = identityHeader('guest', 'revoked-mid-exchange');
    const exchange = makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          authorization: `Bearer ${CLIENT_SECRET}`,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: guestIdentity,
        },
      },
      '{}',
    );
    await exchangeArrived;
    revokeCredentialProxyIdentityToken(guestIdentity);
    releaseExchange();

    const result = await exchange;
    expect(result.statusCode).toBe(403);
    expect(result.body).not.toContain('revoked-run-real-key');
    expect(upstreamRequestCount).toBe(1);
  });

  it('keeps signed owner OAuth exchange response behavior unchanged', async () => {
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    upstreamServer = http.createServer((req, res) => {
      upstreamRequestCount += 1;
      lastUpstreamHeaders = { ...req.headers };
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ raw_key: 'owner-visible-temp-key' }));
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
    proxyPort = await startProxy(
      { CLAUDE_CODE_OAUTH_TOKEN: 'real-host-oauth-token' },
      {},
      IDENTITY_SIGNING_SECRET,
    );

    const ownerExchange = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key?owner-compatible=1',
        headers: {
          authorization: `Bearer ${CLIENT_SECRET}`,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: identityHeader(
            'owner',
            'owner-oauth',
          ),
        },
      },
      '{}',
    );
    expect(ownerExchange.statusCode).toBe(200);
    expect(ownerExchange.body).toContain('owner-visible-temp-key');
    expect(lastUpstreamHeaders.authorization).toBe(
      'Bearer real-host-oauth-token',
    );
  });

  it('OAuth mode does NOT inject token on non-exchange paths even with Authorization', async () => {
    // A guest tries to exfiltrate the host OAuth token by sending an
    // Authorization header to an arbitrary upstream path.
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer attacker-controlled',
        },
      },
      '{}',
    );

    // The real token must never reach upstream, and the attacker's own
    // Authorization header must be stripped rather than forwarded.
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('OAuth mode injects token on exchange path even with a query string', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key?beta=true',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${CLIENT_SECRET}`,
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not leak token when exchange path is smuggled via query', async () => {
    // Path traversal / smuggling attempt: the real path is not the exchange
    // endpoint, the exchange path only appears in the query string.
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages?x=/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer attacker-controlled',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('OAuth mode does not inject token into a path that merely extends the exchange endpoint', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key_attacker',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer attacker-controlled',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it.each([
    'https://attacker.invalid/api/oauth/claude_cli/create_api_key',
    '//attacker.invalid/api/oauth/claude_cli/create_api_key',
  ])('OAuth mode rejects non-origin-form exchange target %s', async (path) => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer attacker-controlled',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': CLIENT_SECRET,
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add its
    // own Connection and Transfer-Encoding headers (standard HTTP/1.1
    // behavior); the caller's custom keep-alive value must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBe('chunked');
  });

  it('streams an authenticated body upstream before the client finishes it', async () => {
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    let firstChunkResolve!: () => void;
    const firstChunk = new Promise<void>((resolve) => {
      firstChunkResolve = resolve;
    });
    upstreamServer = http.createServer((req, res) => {
      req.once('data', () => firstChunkResolve());
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' });

    let clientReq!: http.ClientRequest;
    const response = new Promise<number>((resolve, reject) => {
      clientReq = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          method: 'POST',
          path: '/v1/messages',
          headers: { 'x-api-key': CLIENT_SECRET },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        },
      );
      clientReq.on('error', reject);
      clientReq.write('first');
    });

    // This resolves while clientReq is still open. A Buffer.concat/end-based
    // proxy would deadlock here and fail the test.
    await firstChunk;
    clientReq.end('-last');
    await expect(response).resolves.toBe(200);
  });

  it('rejects a chunked body whose real byte count exceeds the cap', async () => {
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' },
      { maxBodyBytes: 8 },
    );

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'x-api-key': CLIENT_SECRET },
      },
      '123456789',
    );

    expect(res.statusCode).toBe(413);
    expect(res.body).toBe('Payload Too Large');
  });

  it('bounds aggregate slow bodies with a concurrency gate', async () => {
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    let firstRequestResolve!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      firstRequestResolve = resolve;
    });
    upstreamServer = http.createServer((req, res) => {
      firstRequestResolve();
      req.on('data', () => undefined);
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' },
      { maxConcurrentBodies: 1 },
    );

    const slow = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      method: 'POST',
      path: '/v1/messages',
      headers: { 'x-api-key': CLIENT_SECRET },
    });
    slow.on('error', () => undefined);
    slow.write('held-open');
    await firstRequest;

    const rejected = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'x-api-key': CLIENT_SECRET },
      },
      '{}',
    );
    expect(rejected.statusCode).toBe(503);
    expect(rejected.headers['retry-after']).toBe('1');
    slow.destroy();
  });

  it('reserves a body-stream slot for owner while a guest upload is slow', async () => {
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    let firstRequestResolve!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      firstRequestResolve = resolve;
    });
    upstreamServer = http.createServer((req, res) => {
      firstRequestResolve();
      req.on('data', () => undefined);
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' },
      {
        maxConcurrentBodies: 2,
        maxConcurrentGuestBodies: 1,
        maxConcurrentBodiesPerGuestTenant: 1,
        maxConcurrentRequests: 4,
        maxConcurrentGuestRequests: 3,
      },
      IDENTITY_SIGNING_SECRET,
    );

    const slowGuest = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'x-api-key': CLIENT_SECRET,
        [CREDENTIAL_PROXY_IDENTITY_HEADER]: identityHeader('guest', 'guest-a'),
      },
    });
    slowGuest.on('error', () => undefined);
    slowGuest.write('held-open');
    await firstRequest;

    const secondGuest = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': CLIENT_SECRET,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: identityHeader(
            'guest',
            'guest-b',
          ),
        },
      },
      '{}',
    );
    expect(secondGuest.statusCode).toBe(503);

    const owner = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': CLIENT_SECRET,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: identityHeader('owner', 'main'),
        },
      },
      '{}',
    );
    expect(owner.statusCode).toBe(200);
    slowGuest.destroy();
  });

  it('keeps a request slot until a long upstream response closes', async () => {
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    let upstreamCount = 0;
    let heldUpstreamClosedResolve!: () => void;
    const heldUpstreamClosed = new Promise<void>((resolve) => {
      heldUpstreamClosedResolve = resolve;
    });
    upstreamServer = http.createServer((req, res) => {
      upstreamCount += 1;
      req.resume();
      req.on('end', () => {
        if (upstreamCount === 1) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: held-open\n\n');
          res.on('close', () => heldUpstreamClosedResolve());
          return;
        }
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' },
      { maxConcurrentRequests: 1 },
    );

    let heldResponse!: http.IncomingMessage;
    let heldRequest!: http.ClientRequest;
    const firstResponseStarted = new Promise<void>((resolve, reject) => {
      heldRequest = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          method: 'POST',
          path: '/v1/messages',
          headers: { 'x-api-key': CLIENT_SECRET },
        },
        (res) => {
          heldResponse = res;
          res.once('data', () => resolve());
          res.on('error', () => undefined);
        },
      );
      heldRequest.on('error', reject);
      heldRequest.end('{}');
    });
    await firstResponseStarted;

    // The first request body is complete, but its SSE response is still alive;
    // it must continue to occupy the aggregate request slot.
    const rejected = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'x-api-key': CLIENT_SECRET },
      },
      '{}',
    );
    expect(rejected.statusCode).toBe(503);
    expect(upstreamCount).toBe(1);

    heldResponse.destroy();
    heldRequest.destroy();
    await heldUpstreamClosed;

    // Closing the long response releases exactly one slot; normal traffic can
    // proceed instead of leaving the proxy permanently busy.
    const after = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'x-api-key': CLIENT_SECRET },
      },
      '{}',
    );
    expect(after.statusCode).toBe(200);
    expect(upstreamCount).toBe(2);
  });

  it('reserves owner capacity and applies per-tenant quotas to long guest SSE requests', async () => {
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    let upstreamCount = 0;
    upstreamServer = http.createServer((req, res) => {
      upstreamCount += 1;
      req.resume();
      req.on('end', () => {
        if (req.headers['x-test-hold'] === '1') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: held-open\n\n');
          return;
        }
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' },
      {
        maxConcurrentRequests: 3,
        maxConcurrentGuestRequests: 2,
        maxConcurrentRequestsPerGuestTenant: 1,
      },
      IDENTITY_SIGNING_SECRET,
    );

    const startHeldGuest = async (
      tenantId: string,
    ): Promise<{
      request: http.ClientRequest;
      response: http.IncomingMessage;
    }> => {
      let request!: http.ClientRequest;
      const response = await new Promise<http.IncomingMessage>(
        (resolve, reject) => {
          request = http.request(
            {
              hostname: '127.0.0.1',
              port: proxyPort,
              method: 'POST',
              path: '/v1/messages',
              headers: {
                'x-api-key': CLIENT_SECRET,
                'x-test-hold': '1',
                [CREDENTIAL_PROXY_IDENTITY_HEADER]: identityHeader(
                  'guest',
                  tenantId,
                ),
              },
            },
            (res) => {
              res.once('data', () => resolve(res));
              res.on('error', () => undefined);
            },
          );
          request.on('error', reject);
          request.end('{}');
        },
      );
      return { request, response };
    };

    const guestA = await startHeldGuest('guest-a');

    // Reusing the same signed tenant capability cannot evade its one-slot cap.
    const sameTenantRejected = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': CLIENT_SECRET,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: identityHeader(
            'guest',
            'guest-a',
          ),
        },
      },
      '{}',
    );
    expect(sameTenantRejected.statusCode).toBe(503);

    const guestB = await startHeldGuest('guest-b');
    const guestPoolRejected = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': CLIENT_SECRET,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: identityHeader(
            'guest',
            'guest-c',
          ),
        },
      },
      '{}',
    );
    expect(guestPoolRejected.statusCode).toBe(503);

    // Two guests hold their SSE slots, but the third global slot remains
    // available to owner/main instead of letting guests consume the pool.
    const owner = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': CLIENT_SECRET,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: identityHeader('owner', 'main'),
        },
      },
      '{}',
    );
    expect(owner.statusCode).toBe(200);
    expect(upstreamCount).toBe(3);

    guestA.response.destroy();
    guestA.request.destroy();
    guestB.response.destroy();
    guestB.request.destroy();

    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    const guestAfterRelease = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': CLIENT_SECRET,
          [CREDENTIAL_PROXY_IDENTITY_HEADER]: identityHeader(
            'guest',
            'guest-c',
          ),
        },
      },
      '{}',
    );
    expect(guestAfterRelease.statusCode).toBe(200);
  });

  it('aborts the upstream upload when a request body becomes idle', async () => {
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    let upstreamAbortedResolve!: () => void;
    const upstreamAborted = new Promise<void>((resolve) => {
      upstreamAbortedResolve = resolve;
    });
    upstreamServer = http.createServer((req) => {
      req.on('data', () => undefined);
      req.on('aborted', () => upstreamAbortedResolve());
      req.on('error', () => undefined);
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' },
      { bodyIdleTimeoutMs: 30, bodyDeadlineMs: 1_000 },
    );

    const response = await new Promise<{ statusCode: number; body: string }>(
      (resolve, reject) => {
        let responseStarted = false;
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: proxyPort,
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': CLIENT_SECRET },
          },
          (res) => {
            responseStarted = true;
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                statusCode: res.statusCode!,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        req.on('error', (err) => {
          if (!responseStarted) reject(err);
        });
        req.write('partial');
      },
    );

    expect(response).toEqual({
      statusCode: 408,
      body: 'Request Body Timeout',
    });
    await upstreamAborted;
  });

  it('survives a mid-stream upstream failure without crashing (finding #47)', async () => {
    // Replace the healthy default upstream with one that writes headers and
    // then abruptly destroys the connection mid-body, simulating a transient
    // api.anthropic.com drop after the proxy has already piped headers to the
    // client. Without an 'error' listener on the upstream response, this would
    // surface as an unhandled stream error on the shared host process.
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      // Write a partial body, then kill the underlying socket mid-stream.
      res.write('{"partial":');
      res.socket?.destroy();
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' });

    // Issue a request and settle regardless of whether the torn-down response
    // surfaces to the client as an error or a truncated body — the load-bearing
    // assertion is that the proxy did not crash on the unhandled upstream
    // stream error, not the exact client-side outcome.
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': CLIENT_SECRET,
        },
      },
      '{}',
    ).catch(() => undefined);

    // The proxy must have stayed alive (the 'error' listener on upRes prevented
    // an unhandled stream error from reaching the global handler). Prove the
    // proxy's HTTP server is still listening and serving by issuing a follow-up
    // request that hits the auth gate (403) — this path never touches upstream,
    // so it isolates "did the proxy survive?" from upstream health and avoids a
    // flaky port-rebind race.
    const after = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'wrong-secret',
        },
      },
      '{}',
    );
    expect(after.statusCode).toBe(403);
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0, '127.0.0.1', CLIENT_SECRET);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          // Authenticated caller so we exercise the upstream path, not the gate.
          'x-api-key': CLIENT_SECRET,
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  // --- Shared-secret auth gate ---------------------------------------------

  it('API-key mode: wrong secret -> 403 and real key never forwarded', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'wrong-secret',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(403);
    // Upstream must never have been contacted, so no headers were captured and
    // the real key was never forwarded.
    expect(lastUpstreamHeaders['x-api-key']).toBeUndefined();
    expect(Object.keys(lastUpstreamHeaders)).toHaveLength(0);
  });

  it('API-key mode: missing secret -> 403 and real key never forwarded', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'REAL-KEY-PLACEHOLDER' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(403);
    expect(lastUpstreamHeaders['x-api-key']).toBeUndefined();
    expect(Object.keys(lastUpstreamHeaders)).toHaveLength(0);
  });

  it('OAuth mode: wrong secret on exchange path -> 403 and real token never forwarded', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer wrong-secret',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(403);
    // The real OAuth token must never reach upstream.
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
    expect(Object.keys(lastUpstreamHeaders)).toHaveLength(0);
  });

  it('OAuth mode: missing Authorization on exchange path -> 403 and real token never forwarded', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(403);
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
    expect(Object.keys(lastUpstreamHeaders)).toHaveLength(0);
  });
});
