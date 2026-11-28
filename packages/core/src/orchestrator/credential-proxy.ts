/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects the real OAuth token ONLY on that exact
 *             exchange path; every other path has its Authorization header
 *             stripped. For a signed guest, the returned raw_key is retained
 *             host-side and replaced by a random per-run opaque alias; only the
 *             proxy can translate that alias on later inference requests.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface CredentialProxyLimits {
  /** Maximum decoded request-body bytes accepted for one upstream request. */
  maxBodyBytes?: number;
  /** Maximum number of request bodies concurrently streaming to upstream. */
  maxConcurrentBodies?: number;
  /** Maximum requests kept alive through the complete upstream response/SSE. */
  maxConcurrentRequests?: number;
  /** Aggregate guest request cap; the remainder stays available to owner/main. */
  maxConcurrentGuestRequests?: number;
  /** Aggregate guest body-stream cap; the remainder stays available to owner. */
  maxConcurrentGuestBodies?: number;
  /** Per guest-tenant request cap, including open SSE responses. */
  maxConcurrentRequestsPerGuestTenant?: number;
  /** Per guest-tenant body-stream cap. */
  maxConcurrentBodiesPerGuestTenant?: number;
  /** Hard cap for accepted client TCP connections, including partial headers. */
  maxConnections?: number;
  /** Abort a body that stops producing bytes for this long. */
  bodyIdleTimeoutMs?: number;
  /** Absolute deadline for receiving one complete request body. */
  bodyDeadlineMs?: number;
}

const DEFAULT_CREDENTIAL_PROXY_LIMITS: Required<CredentialProxyLimits> = {
  maxBodyBytes: 64 * 1024 * 1024,
  maxConcurrentBodies: 16,
  maxConcurrentRequests: 64,
  maxConcurrentGuestRequests: 48,
  maxConcurrentGuestBodies: 12,
  maxConcurrentRequestsPerGuestTenant: 8,
  maxConcurrentBodiesPerGuestTenant: 4,
  maxConnections: 128,
  bodyIdleTimeoutMs: 30_000,
  bodyDeadlineMs: 5 * 60_000,
};

/**
 * Internal header planted by the host container runner. Its value is an HMAC
 * capability bound to either owner/main or one guest tenant. The signing key
 * stays on the host; a guest can replay its own token only while that exact run
 * remains registered and unexpired, but cannot mint an owner token or evade
 * its per-tenant quota. The proxy always strips this header upstream.
 */
export const CREDENTIAL_PROXY_IDENTITY_HEADER =
  'x-skoobi-credential-proxy-identity';

export interface CredentialProxyIdentity {
  tier: 'owner' | 'guest';
  tenantId: string;
}

interface CredentialProxyIdentityPayload {
  v: 2;
  tier: 'owner' | 'guest';
  tenantId: string;
  /** Per-run nonce: keeps guest OAuth aliases and exchange limits run-scoped. */
  runNonce: string;
  /** Signed wall-clock expiry; active registry membership is still mandatory. */
  expiresAt: number;
}

const CREDENTIAL_PROXY_CAPABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_CREDENTIAL_PROXY_CAPABILITIES = 4096;

interface ActiveCredentialProxyCapability {
  issuerId: string;
  identity: CredentialProxyIdentity;
  expiresAt: number;
}

// This registry is deliberately process-local. A valid HMAC proves that a
// token was minted here, while membership proves that its concrete run is
// still active. The capacity and expiry are fail-closed backups for lifecycle
// bugs; normal container/sandbox completion revokes immediately.
const activeCredentialProxyCapabilities = new Map<
  string,
  ActiveCredentialProxyCapability
>();
const credentialProxyCapabilityRevocationListeners = new Set<
  (capability: string) => void
>();

function credentialProxyCapabilityIssuerId(signingSecret: string): string {
  return createHmac('sha256', signingSecret)
    .update('skoobi-credential-proxy-capability-registry-v1')
    .digest('base64url');
}

function notifyCredentialProxyCapabilityRevoked(capability: string): void {
  for (const listener of credentialProxyCapabilityRevocationListeners) {
    try {
      listener(capability);
    } catch (err) {
      logger.error(
        { err },
        'Credential proxy capability revocation cleanup failed',
      );
    }
  }
}

function deleteCredentialProxyCapability(capability: string): void {
  activeCredentialProxyCapabilities.delete(capability);
  notifyCredentialProxyCapabilityRevoked(capability);
}

function sweepExpiredCredentialProxyCapabilities(now = Date.now()): void {
  for (const [capability, entry] of activeCredentialProxyCapabilities) {
    if (entry.expiresAt <= now) deleteCredentialProxyCapability(capability);
  }
}

function credentialProxyCapabilityIsActive(capability: string): boolean {
  const entry = activeCredentialProxyCapabilities.get(capability);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    deleteCredentialProxyCapability(capability);
    return false;
  }
  return true;
}

function revokeCredentialProxyCapabilitiesForIssuer(issuerId: string): void {
  for (const [capability, entry] of activeCredentialProxyCapabilities) {
    if (entry.issuerId === issuerId) {
      deleteCredentialProxyCapability(capability);
    }
  }
}

function validProxyTenantId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

/** Mint a process-local, tenant-bound proxy identity capability. */
export function createCredentialProxyIdentityToken(
  signingSecret: string,
  identity: CredentialProxyIdentity,
  options: { ttlMs?: number } = {},
): string {
  if (
    !signingSecret ||
    (identity.tier !== 'owner' && identity.tier !== 'guest') ||
    !validProxyTenantId(identity.tenantId)
  ) {
    throw new Error('Invalid credential proxy identity token input');
  }
  const now = Date.now();
  sweepExpiredCredentialProxyCapabilities(now);
  if (
    activeCredentialProxyCapabilities.size >=
    MAX_ACTIVE_CREDENTIAL_PROXY_CAPABILITIES
  ) {
    throw new Error('Credential proxy capability capacity reached');
  }
  const requestedTtlMs = options.ttlMs ?? CREDENTIAL_PROXY_CAPABILITY_TTL_MS;
  if (
    !Number.isSafeInteger(requestedTtlMs) ||
    requestedTtlMs <= 0 ||
    requestedTtlMs > CREDENTIAL_PROXY_CAPABILITY_TTL_MS
  ) {
    throw new Error('Invalid credential proxy capability TTL');
  }
  const expiresAt = now + requestedTtlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error('Invalid credential proxy capability expiry');
  }
  const payload: CredentialProxyIdentityPayload = {
    v: 2,
    tier: identity.tier,
    tenantId: identity.tenantId,
    runNonce: randomBytes(16).toString('base64url'),
    expiresAt,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const signature = createHmac('sha256', signingSecret)
    .update(encoded)
    .digest('base64url');
  const capability = `${encoded}.${signature}`;
  activeCredentialProxyCapabilities.set(capability, {
    issuerId: credentialProxyCapabilityIssuerId(signingSecret),
    identity: { ...identity },
    expiresAt,
  });
  return capability;
}

/** End one concrete run's authority and trigger proxy-side secret cleanup. */
export function revokeCredentialProxyIdentityToken(capability: string): void {
  if (!capability) return;
  deleteCredentialProxyCapability(capability);
}

function verifyCredentialProxyIdentityToken(
  rawHeader: string | number | string[] | undefined,
  signingSecret: string,
): CredentialProxyIdentity | null {
  if (typeof rawHeader !== 'string' || !signingSecret) return null;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(rawHeader);
  if (!match) return null;
  const [, encoded, suppliedSignature] = match;
  const expectedSignature = createHmac('sha256', signingSecret)
    .update(encoded)
    .digest('base64url');
  if (!secretMatches(suppliedSignature, expectedSignature)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<CredentialProxyIdentityPayload>;
    if (
      parsed.v !== 2 ||
      (parsed.tier !== 'owner' && parsed.tier !== 'guest') ||
      !validProxyTenantId(parsed.tenantId) ||
      typeof parsed.runNonce !== 'string' ||
      !/^[A-Za-z0-9_-]{22}$/.test(parsed.runNonce) ||
      !Number.isSafeInteger(parsed.expiresAt)
    ) {
      return null;
    }
    const now = Date.now();
    const active = activeCredentialProxyCapabilities.get(rawHeader);
    if (
      parsed.expiresAt! <= now ||
      !active ||
      active.expiresAt !== parsed.expiresAt ||
      active.expiresAt <= now ||
      active.issuerId !== credentialProxyCapabilityIssuerId(signingSecret) ||
      active.identity.tier !== parsed.tier ||
      active.identity.tenantId !== parsed.tenantId
    ) {
      if (active?.expiresAt !== undefined && active.expiresAt <= now) {
        deleteCredentialProxyCapability(rawHeader);
      }
      return null;
    }
    return { tier: parsed.tier, tenantId: parsed.tenantId };
  } catch {
    return null;
  }
}

function normalizePositiveLimit(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.max(1, Math.trunc(Number(value)))
    : fallback;
}

function normalizeNonNegativeLimit(
  value: number | undefined,
  fallback: number,
) {
  return Number.isFinite(value) && Number(value) >= 0
    ? Math.max(0, Math.trunc(Number(value)))
    : fallback;
}

/**
 * Constant-time string comparison of the caller-supplied credential against the
 * expected per-process shared secret. Returns false (never throws) when the
 * value is missing, is not a single string (e.g. a duplicated header arriving
 * as an array), or lengths differ — length is compared first so timingSafeEqual
 * only ever runs on equal-length Buffers.
 */
function secretMatches(
  provided: string | number | string[] | undefined,
  expected: string,
): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract the bearer token from an `Authorization: Bearer <token>` header. */
function extractBearer(
  authHeader: string | number | string[] | undefined,
): string | undefined {
  const value = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1] : undefined;
}

/**
 * The only upstream path on which the real OAuth token may be injected.
 * The container CLI exchanges its placeholder Bearer token for a temp API
 * key here; every other request must never receive the host OAuth token.
 */
const OAUTH_EXCHANGE_PATH = '/api/oauth/claude_cli/create_api_key';
const GUEST_INFERENCE_PATHS = new Set([
  '/v1/messages',
  '/v1/messages/count_tokens',
]);
const MAX_GUEST_OAUTH_EXCHANGE_RESPONSE_BYTES = 64 * 1024;
const GUEST_OAUTH_EXCHANGE_STATE_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_GUEST_OAUTH_EXCHANGE_STATES = 2048;

type GuestOAuthExchangeState =
  | { status: 'pending' }
  | { status: 'failed' }
  | {
      status: 'ready';
      opaqueKey: string;
      realKey: string;
      childResponse: Buffer;
    };

/**
 * A signed guest may use only the exact origin-form POST targets required by
 * Claude inference. Owner and legacy callers intentionally retain the broad
 * compatibility surface used by operator integrations.
 */
function guestProxyRequestAllowed(
  method: string | undefined,
  url: string | undefined,
  authMode: AuthMode,
): boolean {
  if (method !== 'POST' || !url) return false;
  if (GUEST_INFERENCE_PATHS.has(url)) return true;
  return authMode === 'oauth' && url === OAUTH_EXCHANGE_PATH;
}

function prepareGuestOAuthExchangeResponse(raw: Buffer):
  | {
      realKey: string;
      opaqueKey: string;
      childResponse: Buffer;
    }
  | undefined {
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const realKey = record.raw_key;
    if (
      typeof realKey !== 'string' ||
      realKey.length < 8 ||
      realKey.length > 16 * 1024 ||
      /[\x00-\x20\x7f]/.test(realKey)
    ) {
      return undefined;
    }

    const opaqueKey = `skoobi-guest-${randomBytes(32).toString('base64url')}`;
    const childResponse = Buffer.from(
      JSON.stringify(record, (key, value) => {
        if (key === 'raw_key') return opaqueKey;
        // The endpoint is expected to return raw_key plus harmless metadata.
        // Drop any unexpected additional credential-shaped field rather than
        // accidentally handing a second bearer to the untrusted child.
        if (
          key &&
          /(?:authorization|credential|secret|token|api[_-]?key)/i.test(key)
        ) {
          return undefined;
        }
        return typeof value === 'string'
          ? value.split(realKey).join(opaqueKey)
          : value;
      }),
      'utf8',
    );
    if (
      childResponse.length === 0 ||
      childResponse.length > MAX_GUEST_OAUTH_EXCHANGE_RESPONSE_BYTES ||
      childResponse.includes(realKey)
    ) {
      return undefined;
    }
    return { realKey, opaqueKey, childResponse };
  } catch {
    return undefined;
  }
}

const FORBIDDEN_CONFIGURED_HEADER_NAMES = new Set([
  'authorization',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-api-key',
  CREDENTIAL_PROXY_IDENTITY_HEADER,
]);

/**
 * Keep operator-configured upstream headers host-side. In sandbox mode the
 * Claude child must not receive ANTHROPIC_CUSTOM_HEADERS because deployments
 * commonly carry additional bearer/vendor credentials there.
 */
function parseHostCustomHeaders(
  raw: string | undefined,
): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of (raw || '').split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (
      !value ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      FORBIDDEN_CONFIGURED_HEADER_NAMES.has(name) ||
      /[\x00-\x1f\x7f]/.test(value)
    ) {
      continue;
    }
    parsed[name] = value;
  }
  return parsed;
}

/** True when req.url targets the OAuth token-exchange endpoint. */
function isOAuthExchangePath(url: string | undefined): boolean {
  if (!url) return false;
  // Accept only the HTTP origin-form request target that the Claude CLI emits.
  // URL() also accepts absolute-form and scheme-relative proxy targets; using
  // it here could authorize `https://other-host/...` even though that raw target
  // is forwarded upstream. Query strings remain legitimate.
  return (
    url === OAUTH_EXCHANGE_PATH || url.startsWith(`${OAUTH_EXCHANGE_PATH}?`)
  );
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  expectedClientSecret: string,
  configuredLimits: CredentialProxyLimits = {},
  identitySigningSecret?: string,
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;
  const hostCustomHeaders = parseHostCustomHeaders(
    secrets.ANTHROPIC_CUSTOM_HEADERS,
  );

  const maxConcurrentBodies = normalizePositiveLimit(
    configuredLimits.maxConcurrentBodies,
    DEFAULT_CREDENTIAL_PROXY_LIMITS.maxConcurrentBodies,
  );
  const maxConcurrentRequests = normalizePositiveLimit(
    configuredLimits.maxConcurrentRequests,
    DEFAULT_CREDENTIAL_PROXY_LIMITS.maxConcurrentRequests,
  );
  // Always retain at least one global slot for owner/main when signed guest
  // identities are enabled. Explicit guest values can make the pool stricter,
  // but cannot silently erase the owner reserve.
  const maxConcurrentGuestRequests = Math.min(
    Math.max(0, maxConcurrentRequests - 1),
    normalizeNonNegativeLimit(
      configuredLimits.maxConcurrentGuestRequests,
      Math.min(
        DEFAULT_CREDENTIAL_PROXY_LIMITS.maxConcurrentGuestRequests,
        Math.max(0, maxConcurrentRequests - 1),
      ),
    ),
  );
  const maxConcurrentGuestBodies = Math.min(
    Math.max(0, maxConcurrentBodies - 1),
    normalizeNonNegativeLimit(
      configuredLimits.maxConcurrentGuestBodies,
      Math.min(
        DEFAULT_CREDENTIAL_PROXY_LIMITS.maxConcurrentGuestBodies,
        Math.max(0, maxConcurrentBodies - 1),
      ),
    ),
  );
  const limits: Required<CredentialProxyLimits> = {
    maxBodyBytes: normalizePositiveLimit(
      configuredLimits.maxBodyBytes,
      DEFAULT_CREDENTIAL_PROXY_LIMITS.maxBodyBytes,
    ),
    maxConcurrentBodies,
    maxConcurrentRequests,
    maxConcurrentGuestRequests,
    maxConcurrentGuestBodies,
    maxConcurrentRequestsPerGuestTenant: Math.min(
      maxConcurrentGuestRequests,
      normalizeNonNegativeLimit(
        configuredLimits.maxConcurrentRequestsPerGuestTenant,
        Math.min(
          DEFAULT_CREDENTIAL_PROXY_LIMITS.maxConcurrentRequestsPerGuestTenant,
          maxConcurrentGuestRequests,
        ),
      ),
    ),
    maxConcurrentBodiesPerGuestTenant: Math.min(
      maxConcurrentGuestBodies,
      normalizeNonNegativeLimit(
        configuredLimits.maxConcurrentBodiesPerGuestTenant,
        Math.min(
          DEFAULT_CREDENTIAL_PROXY_LIMITS.maxConcurrentBodiesPerGuestTenant,
          maxConcurrentGuestBodies,
        ),
      ),
    ),
    maxConnections: normalizePositiveLimit(
      configuredLimits.maxConnections,
      DEFAULT_CREDENTIAL_PROXY_LIMITS.maxConnections,
    ),
    bodyIdleTimeoutMs: normalizePositiveLimit(
      configuredLimits.bodyIdleTimeoutMs,
      DEFAULT_CREDENTIAL_PROXY_LIMITS.bodyIdleTimeoutMs,
    ),
    bodyDeadlineMs: normalizePositiveLimit(
      configuredLimits.bodyDeadlineMs,
      DEFAULT_CREDENTIAL_PROXY_LIMITS.bodyDeadlineMs,
    ),
  };

  // Request bodies come from guest-controlled containers and are received by
  // the shared host process. Stream them directly to upstream instead of
  // retaining N complete bodies (and a second Buffer.concat copy) in host
  // memory. A concurrency gate bounds aggregate stream/socket buffers; byte and
  // time limits stop a single large or slow body. Response streaming remains
  // intentionally un-timed so long Anthropic SSE responses are not truncated.
  let activeBodyStreams = 0;
  let activeRequests = 0;
  let activeGuestBodyStreams = 0;
  let activeGuestRequests = 0;
  const activeGuestBodiesByTenant = new Map<string, number>();
  const activeGuestRequestsByTenant = new Map<string, number>();
  // Keyed by the signed per-run identity capability (which carries a random
  // runNonce), not merely tenantId. A successful OAuth exchange is therefore
  // minted at most once for one concrete guest run and cannot be shared across
  // concurrent runs of the same tenant.
  const guestOAuthExchanges = new Map<
    string,
    { state: GuestOAuthExchangeState; expiresAt: number }
  >();
  const disposeGuestOAuthExchangeState = (
    state: GuestOAuthExchangeState,
  ): void => {
    if (state.status !== 'ready') return;
    state.childResponse.fill(0);
    state.realKey = '';
    state.opaqueKey = '';
  };
  const deleteGuestOAuthExchange = (capability: string): void => {
    const entry = guestOAuthExchanges.get(capability);
    if (!entry) return;
    guestOAuthExchanges.delete(capability);
    disposeGuestOAuthExchangeState(entry.state);
  };
  const sweepGuestOAuthExchanges = (now = Date.now()): void => {
    for (const [capability, entry] of guestOAuthExchanges) {
      if (entry.expiresAt <= now) deleteGuestOAuthExchange(capability);
    }
  };
  const getGuestOAuthExchange = (
    capability: string,
  ): GuestOAuthExchangeState | undefined => {
    const entry = guestOAuthExchanges.get(capability);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      deleteGuestOAuthExchange(capability);
      return undefined;
    }
    return entry.state;
  };
  const setGuestOAuthExchange = (
    capability: string,
    state: GuestOAuthExchangeState,
  ): boolean => {
    const previous = guestOAuthExchanges.get(capability);
    if (previous) disposeGuestOAuthExchangeState(previous.state);
    if (!credentialProxyCapabilityIsActive(capability)) {
      guestOAuthExchanges.delete(capability);
      disposeGuestOAuthExchangeState(state);
      return false;
    }
    guestOAuthExchanges.set(capability, {
      state,
      expiresAt: Date.now() + GUEST_OAUTH_EXCHANGE_STATE_TTL_MS,
    });
    return true;
  };
  const onCredentialProxyCapabilityRevoked = (capability: string): void => {
    deleteGuestOAuthExchange(capability);
  };
  credentialProxyCapabilityRevocationListeners.add(
    onCredentialProxyCapabilityRevoked,
  );

  const incrementTenantCounter = (
    counters: Map<string, number>,
    tenantId: string,
  ): void => {
    counters.set(tenantId, (counters.get(tenantId) ?? 0) + 1);
  };
  const decrementTenantCounter = (
    counters: Map<string, number>,
    tenantId: string,
  ): void => {
    const next = Math.max(0, (counters.get(tenantId) ?? 0) - 1);
    if (next === 0) counters.delete(tenantId);
    else counters.set(tenantId, next);
  };

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const headers: Record<string, string | number | string[] | undefined> = {
        ...(req.headers as Record<string, string>),
        // Trusted deployment headers override guest-controlled values and are
        // injected only here, after the request crossed into the host process.
        ...hostCustomHeaders,
        host: upstreamUrl.host,
      };

      // Strip hop-by-hop headers that must not be forwarded by proxies. When
      // content-length is absent, Node will generate its own chunked framing as
      // bytes are written to the upstream ClientRequest.
      delete headers['connection'];
      delete headers['keep-alive'];
      delete headers['transfer-encoding'];

      // Production containers carry a host-signed identity capability on
      // every API request (including post-exchange OAuth traffic). Authenticate
      // it before reading the body, then strip it so Anthropic never receives
      // internal topology/tenant metadata. Legacy callers used by isolated
      // tests can omit identitySigningSecret and retain the old single-class
      // behavior.
      let clientIdentity: CredentialProxyIdentity = {
        tier: 'owner',
        tenantId: 'legacy',
      };
      let clientIdentityCapability = '';
      if (identitySigningSecret) {
        const rawIdentityCapability = headers[CREDENTIAL_PROXY_IDENTITY_HEADER];
        const verified = verifyCredentialProxyIdentityToken(
          rawIdentityCapability,
          identitySigningSecret,
        );
        if (!verified) {
          delete headers[CREDENTIAL_PROXY_IDENTITY_HEADER];
          logger.warn(
            { url: req.url, authMode },
            'Credential proxy rejected invalid tenant identity (403)',
          );
          res.writeHead(403, {
            'content-type': 'text/plain',
            connection: 'close',
          });
          req.resume();
          res.end('Forbidden', () => {
            if (!req.complete) req.destroy();
          });
          return;
        }
        clientIdentity = verified;
        clientIdentityCapability = rawIdentityCapability as string;
      }
      delete headers[CREDENTIAL_PROXY_IDENTITY_HEADER];

      const rejectBeforeBody = (
        status: number,
        message: string | Buffer,
        extraHeaders: Record<string, string> = {},
      ): void => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(status, {
          'content-type': 'text/plain',
          connection: 'close',
          ...extraHeaders,
        });
        // Discard any bytes already queued by Node, then close the connection
        // after the rejection is flushed so a slow sender cannot hold it open.
        req.resume();
        res.end(message, () => {
          if (!req.complete) req.destroy();
        });
      };

      // Authenticate from headers BEFORE accepting or buffering the body.
      const reject403 = (): void => {
        logger.warn(
          { url: req.url, authMode },
          'Credential proxy rejected unauthenticated caller (403)',
        );
        rejectBeforeBody(403, 'Forbidden');
      };

      const isGuest = clientIdentity.tier === 'guest';
      if (isGuest && !guestProxyRequestAllowed(req.method, req.url, authMode)) {
        logger.warn(
          {
            method: req.method,
            url: req.url,
            tenantId: clientIdentity.tenantId,
          },
          'Credential proxy rejected guest request outside inference allowlist (403)',
        );
        reject403();
        return;
      }

      const isGuestOAuthExchange =
        isGuest && authMode === 'oauth' && req.url === OAUTH_EXCHANGE_PATH;

      if (authMode === 'api-key') {
        if (!secretMatches(headers['x-api-key'], expectedClientSecret)) {
          reject403();
          return;
        }
        if (isGuest) delete headers['authorization'];
        headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
      } else if (isOAuthExchangePath(req.url)) {
        if (
          !secretMatches(
            extractBearer(headers['authorization']),
            expectedClientSecret,
          )
        ) {
          reject403();
          return;
        }
        delete headers['authorization'];
        if (isGuestOAuthExchange && !oauthToken) {
          rejectBeforeBody(503, 'Credential Proxy OAuth Unavailable');
          return;
        }
        if (isGuestOAuthExchange) {
          // We must inspect and rewrite the small JSON response. Do not let a
          // guest request compressed bytes that would bypass bounded JSON
          // parsing or force the host to run an attacker-selected decompressor.
          delete headers['accept-encoding'];
          delete headers['x-api-key'];
        }
        if (oauthToken) headers['authorization'] = `Bearer ${oauthToken}`;
      } else {
        delete headers['authorization'];
        if (isGuest) {
          const exchange = getGuestOAuthExchange(clientIdentityCapability);
          if (
            exchange?.status !== 'ready' ||
            !secretMatches(headers['x-api-key'], exchange.opaqueKey)
          ) {
            reject403();
            return;
          }
          // Only the opaque per-run alias ever entered the guest. Substitute the
          // real temporary key inside this host closure immediately before the
          // upstream request.
          headers['x-api-key'] = exchange.realKey;
        }
      }

      // Reject a declared oversize body before opening an upstream connection.
      // The streaming counter below remains authoritative when this header is
      // absent or dishonest.
      const declaredLength = req.headers['content-length'];
      if (declaredLength !== undefined) {
        if (!/^\d+$/.test(declaredLength)) {
          rejectBeforeBody(400, 'Invalid Content-Length');
          return;
        }
        if (BigInt(declaredLength) > BigInt(limits.maxBodyBytes)) {
          logger.warn(
            { url: req.url, declaredLength },
            'Credential proxy rejected declared oversize request body (413)',
          );
          rejectBeforeBody(413, 'Payload Too Large');
          return;
        }
      }

      if (isGuestOAuthExchange) {
        const exchange = getGuestOAuthExchange(clientIdentityCapability);
        if (exchange?.status === 'ready') {
          rejectBeforeBody(200, exchange.childResponse, {
            'content-type': 'application/json',
            'content-length': String(exchange.childResponse.length),
            'cache-control': 'no-store',
          });
          return;
        }
        if (exchange?.status === 'pending') {
          rejectBeforeBody(503, 'Credential Proxy OAuth Exchange Pending', {
            'retry-after': '1',
          });
          return;
        }
        if (exchange?.status === 'failed') {
          rejectBeforeBody(502, 'Credential Proxy OAuth Exchange Failed');
          return;
        }
        sweepGuestOAuthExchanges();
        if (guestOAuthExchanges.size >= MAX_GUEST_OAUTH_EXCHANGE_STATES) {
          rejectBeforeBody(503, 'Credential Proxy OAuth Capacity Reached', {
            'retry-after': '60',
          });
          return;
        }
      }

      // Keep this slot until the client-facing response finishes/closes, not
      // merely until req.end. Otherwise a guest can send unlimited tiny POSTs
      // whose upstream SSE responses remain open and exhaust host sockets/heap.
      const tenantRequestCount = isGuest
        ? (activeGuestRequestsByTenant.get(clientIdentity.tenantId) ?? 0)
        : 0;
      if (
        activeRequests >= limits.maxConcurrentRequests ||
        (isGuest &&
          (activeGuestRequests >= limits.maxConcurrentGuestRequests ||
            tenantRequestCount >= limits.maxConcurrentRequestsPerGuestTenant))
      ) {
        logger.warn(
          {
            url: req.url,
            activeRequests,
            activeGuestRequests,
            tenantId: clientIdentity.tenantId,
            tenantRequestCount,
          },
          'Credential proxy rejected excess concurrent request (503)',
        );
        rejectBeforeBody(503, 'Credential Proxy Busy', { 'retry-after': '1' });
        return;
      }
      activeRequests += 1;
      if (isGuest) {
        activeGuestRequests += 1;
        incrementTenantCounter(
          activeGuestRequestsByTenant,
          clientIdentity.tenantId,
        );
      }
      let requestSlotHeld = true;
      const releaseRequestSlot = (): void => {
        if (!requestSlotHeld) return;
        requestSlotHeld = false;
        activeRequests = Math.max(0, activeRequests - 1);
        if (isGuest) {
          activeGuestRequests = Math.max(0, activeGuestRequests - 1);
          decrementTenantCounter(
            activeGuestRequestsByTenant,
            clientIdentity.tenantId,
          );
        }
      };

      const tenantBodyCount = isGuest
        ? (activeGuestBodiesByTenant.get(clientIdentity.tenantId) ?? 0)
        : 0;
      if (
        activeBodyStreams >= limits.maxConcurrentBodies ||
        (isGuest &&
          (activeGuestBodyStreams >= limits.maxConcurrentGuestBodies ||
            tenantBodyCount >= limits.maxConcurrentBodiesPerGuestTenant))
      ) {
        logger.warn(
          {
            url: req.url,
            activeBodyStreams,
            activeGuestBodyStreams,
            tenantId: clientIdentity.tenantId,
            tenantBodyCount,
          },
          'Credential proxy rejected excess concurrent request body (503)',
        );
        releaseRequestSlot();
        rejectBeforeBody(503, 'Credential Proxy Busy', { 'retry-after': '1' });
        return;
      }
      activeBodyStreams += 1;
      if (isGuest) {
        activeGuestBodyStreams += 1;
        incrementTenantCounter(
          activeGuestBodiesByTenant,
          clientIdentity.tenantId,
        );
      }

      if (isGuestOAuthExchange) {
        // Install the pending marker before opening upstream. The Node handler is
        // synchronous up to this point, so a concurrent replay will observe it
        // and cannot mint a second real key.
        setGuestOAuthExchange(clientIdentityCapability, {
          status: 'pending',
        });
      }

      let bodyLength = 0;
      let bodySettled = false;
      let intentionalUpstreamAbort = false;
      let idleTimer: NodeJS.Timeout | undefined;
      let deadlineTimer: NodeJS.Timeout | undefined;

      const releaseBodySlot = (): void => {
        if (bodySettled) return;
        bodySettled = true;
        activeBodyStreams = Math.max(0, activeBodyStreams - 1);
        if (isGuest) {
          activeGuestBodyStreams = Math.max(0, activeGuestBodyStreams - 1);
          decrementTenantCounter(
            activeGuestBodiesByTenant,
            clientIdentity.tenantId,
          );
        }
        if (idleTimer) clearTimeout(idleTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
      };

      let upstream: ReturnType<typeof makeRequest>;

      const rejectStreamingBody = (
        status: number,
        message: string,
        logMessage: string,
      ): void => {
        if (bodySettled) return;
        if (isGuestOAuthExchange) {
          setGuestOAuthExchange(clientIdentityCapability, {
            status: 'failed',
          });
        }
        logger.warn({ url: req.url, bodyLength }, logMessage);
        releaseBodySlot();
        intentionalUpstreamAbort = true;
        req.pause();
        rejectBeforeBody(status, message);
        upstream.destroy();
      };

      const armIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          rejectStreamingBody(
            408,
            'Request Body Timeout',
            'Credential proxy rejected idle request body (408)',
          );
        }, limits.bodyIdleTimeoutMs);
        idleTimer.unref();
      };

      try {
        upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
            // Together with maxConcurrentBodies this bounds aggregate host-side
            // request buffering even when upstream applies backpressure.
            highWaterMark: 64 * 1024,
          } as RequestOptions,
          (upRes) => {
            if (isGuestOAuthExchange) {
              let settled = false;
              let total = 0;
              const chunks: Buffer[] = [];
              const failExchange = (): void => {
                if (settled) return;
                settled = true;
                for (const chunk of chunks) chunk.fill(0);
                setGuestOAuthExchange(clientIdentityCapability, {
                  status: 'failed',
                });
                intentionalUpstreamAbort = true;
                upRes.destroy();
                if (!upstream.destroyed) upstream.destroy();
                rejectBeforeBody(502, 'Credential Proxy OAuth Exchange Failed');
              };
              upRes.once('error', () => failExchange());

              const declaredResponseLength = upRes.headers['content-length'];
              if (
                declaredResponseLength !== undefined &&
                (!/^\d+$/.test(declaredResponseLength) ||
                  BigInt(declaredResponseLength) >
                    BigInt(MAX_GUEST_OAUTH_EXCHANGE_RESPONSE_BYTES))
              ) {
                failExchange();
                return;
              }
              if (
                typeof upRes.statusCode !== 'number' ||
                upRes.statusCode < 200 ||
                upRes.statusCode >= 300
              ) {
                failExchange();
                return;
              }

              upRes.on('data', (value: Buffer | string) => {
                if (settled) return;
                const chunk = Buffer.isBuffer(value)
                  ? value
                  : Buffer.from(value);
                total += chunk.length;
                if (total > MAX_GUEST_OAUTH_EXCHANGE_RESPONSE_BYTES) {
                  failExchange();
                  return;
                }
                chunks.push(chunk);
              });
              upRes.once('end', () => {
                if (settled) return;
                const rawResponse = Buffer.concat(chunks, total);
                const prepared = prepareGuestOAuthExchangeResponse(rawResponse);
                rawResponse.fill(0);
                for (const chunk of chunks) chunk.fill(0);
                if (!prepared) {
                  failExchange();
                  return;
                }
                settled = true;
                const stored = setGuestOAuthExchange(clientIdentityCapability, {
                  status: 'ready',
                  ...prepared,
                });
                if (!stored) {
                  rejectBeforeBody(403, 'Forbidden');
                  return;
                }
                if (res.destroyed) return;
                res.writeHead(200, {
                  'content-type': 'application/json',
                  'content-length': String(prepared.childResponse.length),
                  'cache-control': 'no-store',
                });
                res.end(prepared.childResponse);
              });
              return;
            }

            upRes.on('error', (err) => {
              logger.error(
                { err, url: req.url },
                'Credential proxy upstream response stream error',
              );
              res.destroy();
            });
            if (res.destroyed) {
              upRes.destroy();
              return;
            }
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );
      } catch (err) {
        if (isGuestOAuthExchange) {
          setGuestOAuthExchange(clientIdentityCapability, {
            status: 'failed',
          });
        }
        logger.error({ err, url: req.url }, 'Credential proxy setup error');
        releaseBodySlot();
        releaseRequestSlot();
        rejectBeforeBody(502, 'Bad Gateway');
        return;
      }

      upstream.on('error', (err) => {
        if (intentionalUpstreamAbort) return;
        if (isGuestOAuthExchange) {
          setGuestOAuthExchange(clientIdentityCapability, {
            status: 'failed',
          });
        }
        logger.error({ err, url: req.url }, 'Credential proxy upstream error');
        releaseBodySlot();
        req.pause();
        if (!res.headersSent) {
          rejectBeforeBody(502, 'Bad Gateway');
        } else {
          res.destroy();
        }
      });

      armIdleTimer();
      deadlineTimer = setTimeout(() => {
        rejectStreamingBody(
          408,
          'Request Body Deadline Exceeded',
          'Credential proxy rejected request body past deadline (408)',
        );
      }, limits.bodyDeadlineMs);
      deadlineTimer.unref();

      req.on('data', (value: Buffer | string) => {
        if (bodySettled) return;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const nextLength = bodyLength + chunk.length;
        if (nextLength > limits.maxBodyBytes) {
          bodyLength = nextLength;
          rejectStreamingBody(
            413,
            'Payload Too Large',
            'Credential proxy rejected streamed oversize request body (413)',
          );
          return;
        }
        bodyLength = nextLength;
        armIdleTimer();
        if (!upstream.write(chunk)) {
          req.pause();
          // This pause is imposed by upstream backpressure, not by an idle
          // client. The absolute body deadline still applies, but do not turn
          // a healthy slow upstream into a false 408.
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = undefined;
          }
          upstream.once('drain', () => {
            if (!bodySettled) {
              armIdleTimer();
              req.resume();
            }
          });
        }
      });

      req.on('end', () => {
        if (bodySettled) return;
        releaseBodySlot();
        upstream.end();
      });

      const abortForClientDisconnect = (): void => {
        if (!bodySettled) releaseBodySlot();
        if (
          isGuestOAuthExchange &&
          getGuestOAuthExchange(clientIdentityCapability)?.status === 'pending'
        ) {
          setGuestOAuthExchange(clientIdentityCapability, {
            status: 'failed',
          });
        }
        intentionalUpstreamAbort = true;
        if (!upstream.destroyed) upstream.destroy();
      };
      req.on('aborted', abortForClientDisconnect);
      req.on('error', abortForClientDisconnect);
      res.once('finish', releaseRequestSlot);
      res.on('close', () => {
        releaseRequestSlot();
        // A server may reject/respond before consuming the whole upload. Once
        // the client-facing response closes, do not keep forwarding an
        // attacker-controlled body in the background merely because the small
        // response itself reached writableEnded.
        if (res.writableEnded && req.complete) return;
        abortForClientDisconnect();
      });
    });

    // Header-only/slowloris sockets do not reach the request handler and hence
    // cannot consume an activeRequests slot. Bound them at the HTTP server too.
    server.maxConnections = limits.maxConnections;
    server.headersTimeout = Math.min(15_000, limits.bodyDeadlineMs);
    server.requestTimeout = limits.bodyDeadlineMs;
    server.keepAliveTimeout = 5_000;

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    const capabilityIssuerId = identitySigningSecret
      ? credentialProxyCapabilityIssuerId(identitySigningSecret)
      : undefined;
    server.once('error', (err) => {
      // A listen failure occurs after sandbox/container code minted its token
      // but before it received a Server to close. Revoke that issuer here.
      if (!server.listening && capabilityIssuerId) {
        revokeCredentialProxyCapabilitiesForIssuer(capabilityIssuerId);
      }
      if (!server.listening) {
        credentialProxyCapabilityRevocationListeners.delete(
          onCredentialProxyCapabilityRevoked,
        );
        for (const capability of guestOAuthExchanges.keys()) {
          deleteGuestOAuthExchange(capability);
        }
      }
      reject(err);
    });
    server.once('close', () => {
      if (capabilityIssuerId) {
        revokeCredentialProxyCapabilitiesForIssuer(capabilityIssuerId);
      }
      credentialProxyCapabilityRevocationListeners.delete(
        onCredentialProxyCapabilityRevoked,
      );
      // Drop and overwrite host-memory temporary OAuth keys as soon as this
      // proxy lifecycle ends (per-run sandbox or process-wide container).
      for (const capability of guestOAuthExchanges.keys()) {
        deleteGuestOAuthExchange(capability);
      }
    });
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
