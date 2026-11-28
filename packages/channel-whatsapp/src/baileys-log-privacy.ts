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
  /** Tag of the stream:error reason node (conflict, xml-not-well-formed, …). */
  streamErrorTag?: string;
  /** Letters-only `type` attribute of the reason node (conflict type=replaced). */
  streamErrorType?: string;
  /** Short numeric `code` attribute of the stream:error node (515, 503, …). */
  streamErrorCode?: number;
}

/** What of a Baileys disconnect error may reach the «Connection closed» line. */
export type BaileysDisconnectSummary = Pick<
  BaileysLogSummary,
  'streamErrorTag' | 'streamErrorType'
>;

const BAILEYS_MESSAGE_MAX_CHARS = 160;
const ERROR_NAME_RE = /^[A-Za-z][A-Za-z0-9_.]{0,59}$/;
const BAILEYS_STREAM_ERROR_MESSAGE = 'stream errored out';
// Node tags and types are protocol words: letters, «:», «_», «-», no digits,
// so a phone number, LID or message id can never pass. Codes are short
// protocol statuses (401, 503, 515); anything longer is dropped.
const STREAM_ERROR_WORD_RE = /^[A-Za-z][A-Za-z:_-]{0,39}$/;
const STREAM_ERROR_CODE_RE = /^\d{1,4}$/;

type NodeLike = { tag?: unknown; attrs?: unknown };

function asNode(value: unknown): NodeLike | undefined {
  return value && typeof value === 'object' ? (value as NodeLike) : undefined;
}

function nodeAttr(node: NodeLike | undefined, name: string): unknown {
  const attrs = node?.attrs;
  return attrs && typeof attrs === 'object'
    ? (attrs as Record<string, unknown>)[name]
    : undefined;
}

function safeStreamWord(value: unknown): string | undefined {
  return typeof value === 'string' && STREAM_ERROR_WORD_RE.test(value)
    ? value
    : undefined;
}

function safeStreamCode(value: unknown): number | undefined {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && STREAM_ERROR_CODE_RE.test(text)
    ? Number(text)
    : undefined;
}

function streamReasonSummary(
  reasonNode: NodeLike | undefined,
): BaileysDisconnectSummary {
  const out: BaileysDisconnectSummary = {};
  const tag = safeStreamWord(reasonNode?.tag);
  if (tag) out.streamErrorTag = tag;
  const type = safeStreamWord(nodeAttr(reasonNode, 'type'));
  if (type) out.streamErrorType = type;
  return out;
}

/**
 * Baileys logs `{ reasonNode, fullErrorNode }` with «stream errored out»
 * right before it closes the socket (lib/Socket/socket.js, CB:stream:error).
 */
export function isBaileysStreamErrorLogCall(args: readonly unknown[]): boolean {
  const [first, second] = args;
  const message =
    typeof second === 'string'
      ? second
      : typeof first === 'string'
        ? first
        : undefined;
  if (message === BAILEYS_STREAM_ERROR_MESSAGE) return true;
  return Boolean(
    first &&
      typeof first === 'object' &&
      'fullErrorNode' in (first as Record<string, unknown>),
  );
}

/**
 * The reason tag (and letters-only type) of the Boom Baileys closes the
 * socket with: for a stream error its `data` is the reason node, or the
 * stream:error node itself when there is no child. CB:failure puts the
 * node's attributes there instead — no tag, nothing reported. The rest of
 * `data` (jids, ids, content) never passes.
 */
export function summarizeBaileysDisconnect(err: unknown): BaileysDisconnectSummary {
  if (!err || typeof err !== 'object') return {};
  return streamReasonSummary(asNode((err as { data?: unknown }).data));
}

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
 * nodes and peer ids there. 55 «WhatsApp transport error» lines of the month
 * carried nothing but source: baileys (C41). Of a stream error only the
 * reason tag, its letters-only type and the short numeric code pass (J03).
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
  if (obj && ('reasonNode' in obj || 'fullErrorNode' in obj)) {
    const reasonNode = asNode(obj.reasonNode);
    const fullErrorNode = asNode(obj.fullErrorNode);
    Object.assign(out, streamReasonSummary(reasonNode));
    const code =
      safeStreamCode(nodeAttr(fullErrorNode, 'code')) ??
      safeStreamCode(nodeAttr(reasonNode, 'code'));
    if (code !== undefined) out.streamErrorCode = code;
  }
  return out;
}
