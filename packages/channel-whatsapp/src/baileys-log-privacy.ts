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
