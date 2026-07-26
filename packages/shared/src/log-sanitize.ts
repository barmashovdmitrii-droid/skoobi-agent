/**
 * Log sanitization helpers for Skoobi (Tier 1 privacy).
 *
 * - `basenameOnly(p)`: return the basename of a path so logs do not leak
 *   absolute filesystem locations (which include the macOS username and
 *   per-group folder names).
 * - `hashShort(s)`: short stable hash for low-entropy sender names so logs
 *   stay correlatable across a session without revealing the name.
 * - `redactString(s)`: scrub bot tokens, generic long-id:secret tokens,
 *   OpenAI/Anthropic `sk` API keys, Slack (`xox*-`/`xapp-`) and GitHub
 *   (`gh*_`/`github_pat_`) tokens, `authorization`/`x-api-key` header values,
 *   credential-bearing URL query params, raw WhatsApp JIDs, and local
 *   absolute paths from a free-form string. Used by the pino
 *   `formatters.log` hook so any nested object value carrying such strings is
 *   cleaned before it reaches stderr.
 *
 * These helpers are deliberately small and side-effect free so unit tests
 * cover them directly. The pino wiring lives next to where the logger is
 * constructed (see `orchestrator/logger.ts` and `orchestrator/mount-security.ts`).
 */

import crypto from 'crypto';
import path from 'path';

/** Return just the basename of a filesystem path. Empty string for falsy input. */
export function basenameOnly(p: unknown): string {
  if (typeof p !== 'string' || !p) return '';
  return path.basename(p);
}

/** SHA-256 → first 8 hex chars. Stable but non-reversible label for senders. */
export function hashShort(s: unknown): string {
  const input = typeof s === 'string' ? s : String(s ?? '');
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

// Compiled patterns, evaluated once.
// 1. Telegram-style `bot<digits>:<token-body>` (full prefix). We replace the
//    whole thing so the bot id is not retained either.
const BOT_TOKEN_RE = /bot\d+:[A-Za-z0-9_-]{30,}/g;
// 2. Generic `<longDigits>:<long token body>` (Telegram tokens without the
//    `bot` prefix or similar credentials embedded in URLs/strings).
const GENERIC_TOKEN_RE = /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/g;
// 3. Absolute paths under common local roots. We greedy-match up to the
//    next whitespace or quote so we do not eat surrounding JSON/log syntax.
const LOCAL_PATH_RE =
  /(?:\/Users\/[^/\s"'\]]+|\/private\/var\/folders|\/var\/folders|\/tmp)\/[^\s"'\]]+/g;
// 4. Authorization / x-api-key headers (e.g. `authorization: Bearer <key>`,
//    `x-api-key=<key>`). Keep the header name; redact the value (and any
//    `Bearer ` scheme prefix). Matched before the bare-key rule below so the
//    field name survives with a clear marker.
const AUTH_HEADER_RE =
  /\b(authorization|x-api-key)(\s*[:=]\s*)(?:bearer\s+)?[^\s,"']+/gi;
const BARE_BEARER_RE = /\bBearer\s+[^\s,"'}]+/gi;
// 5. Credential-bearing URL query params (`?key=...`, `&token=...`,
//    `&secret=...`, `&api_key=...`, `&apikey=...`). Keep the param name;
//    redact the value up to the next param/whitespace/quote.
const QUERY_SECRET_RE = /([?&](?:api[_-]?key|key|token|secret)=)[^&\s"']+/gi;
// 6. Anthropic / OpenAI style API keys, including provider and project
//    variants. Match 20+ chars of key body; the provider-specific alternative
//    is listed first so it wins the longest match.
const SK_KEY_RE = /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g;
// 7. Slack tokens (finding #45): bot/app/user/refresh tokens `xox[baprs]-...`
//    and app-level tokens `xapp-...`. These are dot/dash-segmented; match the
//    whole token body up to the next whitespace/quote so the secret is fully
//    removed if interpolated into a Slack API error message or URL.
const SLACK_TOKEN_RE =
  /\bxox[baprs]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/g;
// 8. GitHub tokens (finding #45): personal-access / OAuth / server / refresh
//    tokens `gh[pousr]_<base62>` and fine-grained PATs `github_pat_<base62_>`.
//    Listed with `github_pat_` first so the longer prefix wins the match.
const GH_TOKEN_RE =
  /\bgithub_pat_[A-Za-z0-9_]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}/g;
// 9. WhatsApp peer identifiers. Baileys can expose phone-number, device,
//    group and LID forms (for example `user:device@s.whatsapp.net`,
//    `group-timestamp@g.us`, and `id@lid`). Replace the complete identifier
//    while leaving ordinary email addresses and Telegram identifiers alone.
const WHATSAPP_JID_RE = /[A-Za-z0-9._:+~-]+@(?:s\.whatsapp\.net|g\.us|lid)\b/gi;

function whatsappPeerLabel(jid: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`whatsapp-peer:${jid.toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
  return `<whatsapp-peer:${digest}>`;
}

/**
 * Redact tokens, API keys (incl. Slack/GitHub tokens), auth headers,
 * credential query params, WhatsApp JIDs, and user-specific absolute paths
 * from a free-form string. Header/query rules keep the field name and redact
 * only the value; the bare-key/token rules replace the whole match. WhatsApp
 * JIDs become a stable hash label so related log events remain correlatable
 * without retaining the phone number or raw JID. Non-string inputs are
 * coerced via String(); null/undefined → ''.
 */
export function redactString(s: unknown): string {
  if (s === null || s === undefined) return '';
  const str = typeof s === 'string' ? s : String(s);
  return (
    str
      .replace(AUTH_HEADER_RE, '$1$2<redacted>')
      .replace(BARE_BEARER_RE, 'Bearer <redacted>')
      .replace(QUERY_SECRET_RE, '$1<redacted>')
      .replace(SK_KEY_RE, '<key-redacted>')
      // Slack/GitHub tokens (finding #45): the highest-value credentials this
      // codebase holds outside sk-/bot- shapes. Run before the bare-token rules.
      .replace(SLACK_TOKEN_RE, '<slack-token-redacted>')
      .replace(GH_TOKEN_RE, '<gh-token-redacted>')
      .replace(BOT_TOKEN_RE, 'bot<redacted>')
      .replace(GENERIC_TOKEN_RE, '<token-redacted>')
      .replace(WHATSAPP_JID_RE, whatsappPeerLabel)
      .replace(LOCAL_PATH_RE, '<path-redacted>')
  );
}

/**
 * Recursively walk a pino log object and apply `redactString` to every
 * string-valued leaf. Numbers/booleans/null are returned as-is. Bounded
 * recursion depth keeps the work cheap even on pathological inputs.
 */
export function redactLogObject(
  obj: Record<string, unknown>,
  maxDepth = 6,
): Record<string, unknown> {
  return redactValue(obj, maxDepth) as Record<string, unknown>;
}

function sensitiveLogKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase();
  return (
    [
      'authorization',
      'proxyauthorization',
      'xapikey',
      'apikey',
      'token',
      'password',
      'pass',
      'certpass',
      'login',
      'credential',
      'credentials',
      'cookie',
      'setcookie',
      'session',
      'sessionid',
      'capability',
      'privatekey',
    ].includes(normalized) ||
    normalized.endsWith('token') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('password') ||
    normalized.endsWith('capability') ||
    normalized.endsWith('privatekey')
  );
}

function redactValue(value: unknown, depth: number): unknown {
  // At the depth cutoff, stop descending but still scrub scalar string leaves
  // so the recursion limit degrades safely rather than emitting a raw secret.
  if (depth <= 0) {
    if (typeof value === 'string') return redactString(value);
    if (value && typeof value === 'object') return '<max-depth-redacted>';
    return value;
  }
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth - 1));
  }
  if (value && typeof value === 'object') {
    // Pino's formatter receives Error instances before its normal error
    // serializer. Error diagnostics are non-enumerable, so a generic
    // Object.entries() walk would turn `{ err }` into `{ err: {} }`. Preserve
    // the useful fields explicitly, but scrub them before they reach stdout.
    if (value instanceof Error) {
      const out: Record<string, unknown> = {
        type: redactString(value.name || 'Error'),
        message: redactString(value.message),
      };
      if (value.stack) out.stack = redactString(value.stack);
      for (const [k, v] of Object.entries(value)) {
        if (k === 'name' || k === 'message' || k === 'stack') continue;
        out[k] = sensitiveLogKey(k) ? '<redacted>' : redactValue(v, depth - 1);
      }
      return out;
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sensitiveLogKey(k) ? '<redacted>' : redactValue(v, depth - 1);
    }
    return out;
  }
  return value;
}

/**
 * Paths to feed pino's built-in `redact` option. These cover the object
 * field names under which this codebase's secrets live (tokens, `apiKey`,
 * payment `certPass`/`pass`/`login`, `x-api-key` headers, etc.) so the
 * structured-log replacer hits them even if they are not embedded in a
 * string we scan with redactString. Not exhaustive; redactString is the
 * free-form backstop. Wildcard-prefixed globs cover nested config objects.
 */
export const PINO_REDACT_PATHS: string[] = [
  '*.token',
  '*.botToken',
  '*.bot_token',
  'token',
  'botToken',
  'bot_token',
  'headers.authorization',
  '*.headers.authorization',
  'env.TELEGRAM_BOT_TOKEN',
  'env.ANTHROPIC_API_KEY',
  // Field names the secret-bearing config/header objects in this codebase
  // actually use (model-gateway/image-gateway `apiKey`; payment-gateway
  // `certPass`/`pass`/`login`; credential-proxy `x-api-key`; plus common
  // synonyms). Wildcard-prefixed forms cover nested config objects.
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
  'certPass',
  '*.certPass',
  'pass',
  '*.pass',
  'login',
  '*.login',
  'secret',
  '*.secret',
  'webhookSecret',
  '*.webhookSecret',
  // x-api-key needs fast-redact bracket notation (hyphenated key). Use the
  // documented wildcard form plus the explicit headers locations; avoid a
  // bare-root `["x-api-key"]` accessor, which is not a portable fast-redact
  // path and could throw at logger construction.
  '*["x-api-key"]',
  'headers["x-api-key"]',
  '*.headers["x-api-key"]',
];
