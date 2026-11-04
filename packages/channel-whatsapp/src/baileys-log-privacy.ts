import { redactString } from '@skoobi/shared/log-sanitize';

type GuardedConsoleMethodName =
  | 'debug'
  | 'error'
  | 'info'
  | 'log'
  | 'warn';
type ConsoleMethod = (...args: unknown[]) => void;

const GUARDED_CONSOLE_METHODS: readonly GuardedConsoleMethodName[] = [
  'debug',
  'error',
  'info',
  'log',
  'warn',
];
const GUARD_STATE = Symbol.for('@skoobi/channel-whatsapp/baileys-console-guard');

interface ConsoleGuardState {
  originals: Record<GuardedConsoleMethodName, ConsoleMethod>;
  wrappers: Record<GuardedConsoleMethodName, ConsoleMethod>;
}

type GuardHost = typeof globalThis & Record<symbol, unknown>;

/**
 * Baileys' libsignal dependency bypasses the injected logger and calls the
 * global console with SessionEntry objects. Those objects contain base keys,
 * ratchet buffers, and identity material. Match by the caller's module path,
 * never by inspecting/stringifying the potentially secret arguments.
 */
export function isBaileysPrivateConsoleStack(
  stack: string | undefined,
): boolean {
  if (!stack) return false;
  const normalized = stack.replaceAll('\\', '/');
  const immediateCaller = normalized
    .split('\n')
    .map((line) => line.trim())
    .find(
      (line) =>
        line.startsWith('at ') && !line.includes('/baileys-log-privacy.'),
    );
  if (!immediateCaller) return false;
  return (
    immediateCaller.includes('/node_modules/libsignal/') ||
    immediateCaller.includes('/node_modules/@whiskeysockets/baileys/')
  );
}

export function createBaileysPrivateConsoleMethod(
  original: ConsoleMethod,
  stackProvider: () => string | undefined = () => new Error().stack,
): ConsoleMethod {
  return (...args: unknown[]): void => {
    if (isBaileysPrivateConsoleStack(stackProvider())) return;
    Reflect.apply(original, console, args);
  };
}

/**
 * Install once per process. The wrapper suppresses only console calls whose
 * immediate stack originates inside Baileys/libsignal; normal application and
 * auth CLI console output is untouched. Raw transport arguments are never
 * forwarded to another logger.
 */
export function installBaileysConsolePrivacyGuard(): void {
  const host = globalThis as GuardHost;
  if (host[GUARD_STATE]) return;

  const originals = {} as Record<GuardedConsoleMethodName, ConsoleMethod>;
  const wrappers = {} as Record<GuardedConsoleMethodName, ConsoleMethod>;
  for (const method of GUARDED_CONSOLE_METHODS) {
    const original = console[method] as ConsoleMethod;
    const wrapper = createBaileysPrivateConsoleMethod(original);
    originals[method] = original;
    wrappers[method] = wrapper;
    Object.defineProperty(console, method, {
      configurable: true,
      enumerable: true,
      value: wrapper,
      writable: true,
    });
  }

  host[GUARD_STATE] = { originals, wrappers } satisfies ConsoleGuardState;
}

/** What of one Baileys log call may reach the application log. */
export interface BaileysLogSummary {
  /** Baileys' own message text, redacted (JIDs, paths, tokens, long digit runs). */
  baileysMessage?: string;
  /** Name of the attached error (Error, TypeError, …). */
  errorName?: string;
  /** Status code of the attached error (a Boom disconnect reason, HTTP status). */
  statusCode?: number;
}

const BAILEYS_MESSAGE_MAX_CHARS = 160;
const ERROR_NAME_RE = /^[A-Za-z][A-Za-z0-9_.]{0,59}$/;

function errorStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const candidate = err as {
    output?: { statusCode?: unknown };
    statusCode?: unknown;
    status?: unknown;
  };
  for (const value of [
    candidate.output?.statusCode,
    candidate.statusCode,
    candidate.status,
  ]) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 10_000) {
      return value;
    }
  }
  return undefined;
}

/**
 * The safe part of a Baileys log call (pino signature: an object and a
 * message, or a message alone): the message text after redactString with
 * every run of six or more digits masked — Baileys interpolates phone
 * numbers and LIDs without a JID suffix («Invalid LID-PN mapping: …») —
 * and the name and status code of an attached error. Never the objects
 * themselves, nor the error's message: Baileys puts session entries, keys,
 * nodes and peer ids there. Keep only bounded, non-sensitive diagnostics.
 */
export function summarizeBaileysLogCall(args: readonly unknown[]): BaileysLogSummary {
  const [first, second] = args;
  const message =
    typeof second === 'string'
      ? second
      : typeof first === 'string'
        ? first
        : undefined;
  const out: BaileysLogSummary = {};
  if (message) {
    const safe = redactString(message)
      .replace(/\d{6,}/g, '<n>')
      .slice(0, BAILEYS_MESSAGE_MAX_CHARS)
      .trim();
    if (safe) out.baileysMessage = safe;
  }
  const obj = first && typeof first === 'object' ? (first as Record<string, unknown>) : undefined;
  const err =
    first instanceof Error
      ? first
      : (obj?.err ?? obj?.error ?? obj?.e);
  if (err instanceof Error && ERROR_NAME_RE.test(err.name)) {
    out.errorName = err.name;
  }
  const statusCode = errorStatusCode(err) ?? errorStatusCode(obj);
  if (statusCode !== undefined) out.statusCode = statusCode;
  return out;
}
