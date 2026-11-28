/**
 * Остановка бота с пределом времени (J06).
 *
 * До этого обработчик SIGTERM ждал очередь и отключение каналов без всякого
 * предела. Отключение канала может повиснуть (WhatsApp, долгий опрос
 * Telegram), и launchd через 20 с добивал процесс kill -9 —
 * трижды, без последней строки в журнале о том, что именно повисло.
 *
 * Теперь каждый шаг ждёт не дольше своего предела, ошибка шага не мешает
 * следующим, а весь выход укладывается в общий предел
 * (SKOOBI_SHUTDOWN_DEADLINE_MS, по умолчанию 12 с — раньше 20 с launchd).
 * Повторный сигнал во время остановки её не перезапускает.
 */

import { readEnvFile } from './env.js';

export const SHUTDOWN_DEADLINE_DEFAULT_MS = 12_000;
export const SHUTDOWN_STEP_TIMEOUT_DEFAULT_MS = 5_000;
const SHUTDOWN_DEADLINE_MIN_MS = 1_000;
/** launchd sends SIGKILL 20 s after SIGTERM (no ExitTimeOut in the plist). */
const SHUTDOWN_DEADLINE_MAX_MS = 18_000;

const SHUTDOWN_DEADLINE_KEY = 'SKOOBI_SHUTDOWN_DEADLINE_MS';

/**
 * The setting as the rest of SKOOBI_* is read: the process environment (the
 * plist) first, then .env — which is never loaded into process.env, so a
 * value put only there used to be ignored. Read when the signal comes.
 */
function shutdownDeadlineSetting(): Record<string, string | undefined> {
  return {
    [SHUTDOWN_DEADLINE_KEY]:
      process.env[SHUTDOWN_DEADLINE_KEY] ||
      readEnvFile([SHUTDOWN_DEADLINE_KEY])[SHUTDOWN_DEADLINE_KEY],
  };
}

export function resolveShutdownDeadlineMs(
  env: Record<string, string | undefined> = shutdownDeadlineSetting(),
): number {
  const raw = Number(env.SKOOBI_SHUTDOWN_DEADLINE_MS);
  if (!Number.isFinite(raw) || raw <= 0) return SHUTDOWN_DEADLINE_DEFAULT_MS;
  return Math.min(
    SHUTDOWN_DEADLINE_MAX_MS,
    Math.max(SHUTDOWN_DEADLINE_MIN_MS, Math.floor(raw)),
  );
}

export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown> | unknown;
}

interface ShutdownLog {
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
}

const TIMED_OUT = Symbol('timed-out');

function within<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, limit]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * The SIGTERM/SIGINT handler. `steps` is read when the signal comes, so the
 * list sees the channels connected by then.
 */
export function createGracefulShutdown(input: {
  steps: () => ShutdownStep[];
  exit: (code: number) => void;
  log: ShutdownLog;
  deadlineMs?: number;
  stepTimeoutMs?: number;
  now?: () => number;
}): (signal: string) => Promise<void> {
  let started = false;
  const now = input.now ?? (() => Date.now());
  return async (signal: string) => {
    if (started) {
      input.log.info({ signal }, 'Shutdown already in progress');
      return;
    }
    started = true;
    const deadlineMs = input.deadlineMs ?? resolveShutdownDeadlineMs();
    const stepTimeoutMs = input.stepTimeoutMs ?? SHUTDOWN_STEP_TIMEOUT_DEFAULT_MS;
    const startedAt = now();
    input.log.info({ signal, deadlineMs }, 'Shutdown signal received');
    let current = '';
    const sequence = (async () => {
      for (const step of input.steps()) {
        current = step.name;
        const left = deadlineMs - (now() - startedAt);
        if (left <= 0) break;
        let outcome: unknown;
        try {
          outcome = await within(
            Promise.resolve().then(() => step.run()),
            Math.min(stepTimeoutMs, left),
          );
        } catch (err) {
          input.log.warn(
            { step: step.name, err },
            'Shutdown step failed; going on',
          );
          continue;
        }
        if (outcome === TIMED_OUT) {
          input.log.warn(
            { step: step.name, waitedMs: now() - startedAt },
            'Shutdown step did not finish in time; going on without it',
          );
        }
      }
      current = '';
    })();
    const outcome = await within(sequence, deadlineMs);
    if (outcome === TIMED_OUT) {
      input.log.warn(
        { step: current || undefined, deadlineMs },
        'Shutdown deadline reached; exiting without waiting further',
      );
    } else {
      input.log.info(
        { signal, tookMs: now() - startedAt },
        'Shutdown complete',
      );
    }
    input.exit(0);
  };
}
