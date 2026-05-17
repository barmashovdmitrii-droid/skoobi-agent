/**
 * Log sanitization helpers for Skoobi (Tier 1 privacy).
 *
 * - `basenameOnly(p)`: return the basename of a path so logs do not leak
 *   absolute filesystem locations (which include the macOS username and
 *   per-group folder names).
 * - `hashShort(s)`: short stable hash for low-entropy sender names so logs
 *   stay correlatable across a session without revealing the name.
 * - `redactString(s)`: scrub bot tokens, generic long-id:secret tokens, and
 *   local absolute paths from a free-form string. Used by the
 *   pino `formatters.log` hook so any nested object value carrying such
 *   strings is cleaned before it reaches stderr.
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

/**
 * Redact tokens and user-specific absolute paths from a free-form string.
 * Non-string inputs are coerced via String(); null/undefined → ''.
 */
export function redactString(s: unknown): string {
  if (s === null || s === undefined) return '';
  const str = typeof s === 'string' ? s : String(s);
  return str
    .replace(BOT_TOKEN_RE, 'bot<redacted>')
    .replace(GENERIC_TOKEN_RE, '<token-redacted>')
    .replace(LOCAL_PATH_RE, '<path-redacted>');
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

function redactValue(value: unknown, depth: number): unknown {
  if (depth <= 0) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth - 1));
  }
  if (value && typeof value === 'object') {
    // Avoid touching Error instances' prototype chain — pino has its own
    // serializer for `err`. Just rewrite enumerable string fields.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, depth - 1);
    }
    return out;
  }
  return value;
}

/**
 * Paths to feed pino's built-in `redact` option. These are common locations
 * where secrets live as object fields (so the structured-log replacer hits
 * them even if they are not embedded in a string we scan with redactString).
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
];
