/**
 * service-lifecycle.ts — records WHY the service started and stopped.
 *
 * Distinguishes planned restarts from unexpected exits using timestamped
 * lifecycle records. Supervisor counters alone cannot explain why a
 * process restarted.
 *
 * Every start and every stop is appended to logs/service-lifecycle.jsonl, one
 * JSON object per line. On start we also look at the PREVIOUS record: if the
 * last thing written was a `start` with no matching `stop`, the previous
 * process died without ever running its shutdown path — that is a crash, and
 * it is labelled as one.
 *
 *   SIGTERM  -> launchd unload / kickstart / `launchctl stop`  == deploy or manual
 *   SIGINT   -> someone hit Ctrl-C                             == manual
 *   SIGHUP   -> terminal went away
 *   no stop record at all                                      == CRASH
 *
 * Written with plain fs.appendFileSync on purpose: this must still work when
 * the DB is locked, the logger transport has fallen over, or the process is
 * being torn down mid-signal. It is deliberately tiny and dependency-free —
 * a diagnostic that needs healthy infrastructure to record an unhealthy
 * shutdown is worth nothing.
 */
import fs from 'fs';
import path from 'path';

import { logger } from '@skoobi/shared/logger';

const LIFECYCLE_FILE = path.join(
  process.cwd(),
  'logs',
  'service-lifecycle.jsonl',
);

/** Keep the file bounded without needing the log roller to know about it. */
const MAX_RECORDS = 2000;

type LifecycleRecord = {
  event: 'start' | 'stop';
  at: string;
  pid: number;
  /** For `stop`: what ended the process. For `start`: how the previous run ended. */
  reason: string;
  uptimeSec?: number;
  /** Set on `start` when the previous run left no stop record. */
  previousUnclean?: boolean;
  nodeVersion?: string;
  commit?: string;
};

const startedAt = Date.now();
let stopRecorded = false;
let initialized = false;

function readLastRecord(): LifecycleRecord | null {
  try {
    const raw = fs.readFileSync(LIFECYCLE_FILE, 'utf8');
    const lines = raw.trimEnd().split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]) as LifecycleRecord;
  } catch {
    return null;
  }
}

function append(record: LifecycleRecord): void {
  try {
    fs.mkdirSync(path.dirname(LIFECYCLE_FILE), { recursive: true });
    fs.appendFileSync(LIFECYCLE_FILE, `${JSON.stringify(record)}\n`);
  } catch {
    // Never let bookkeeping take the service down or block a shutdown path.
  }
}

/** Trim the file to MAX_RECORDS, oldest first. Called only on start. */
function trim(): void {
  try {
    const raw = fs.readFileSync(LIFECYCLE_FILE, 'utf8');
    const lines = raw.trimEnd().split('\n').filter(Boolean);
    if (lines.length <= MAX_RECORDS) return;
    fs.writeFileSync(
      LIFECYCLE_FILE,
      `${lines.slice(-MAX_RECORDS).join('\n')}\n`,
    );
  } catch {
    /* ignore */
  }
}

function currentCommit(): string | undefined {
  // Read the git ref directly rather than shelling out to `git`: this runs on
  // the startup path and must not spawn a process or block.
  try {
    const head = fs
      .readFileSync(path.join(process.cwd(), '.git', 'HEAD'), 'utf8')
      .trim();
    const m = head.match(/^ref:\s*(.+)$/);
    if (!m) return head.slice(0, 12);
    const ref = fs
      .readFileSync(path.join(process.cwd(), '.git', m[1]), 'utf8')
      .trim();
    return ref.slice(0, 12);
  } catch {
    return undefined;
  }
}

function recordStop(reason: string): void {
  if (stopRecorded) return; // a signal may arrive more than once
  stopRecorded = true;
  append({
    event: 'stop',
    at: new Date().toISOString(),
    pid: process.pid,
    reason,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  });
}

/**
 * Install the lifecycle recorder. Call once, as early in startup as possible.
 *
 * Preserve an existing shutdown handler: it may need time to drain work.
 * Before that handler is installed, restore the default signal disposition
 * after recording the signal so this observer cannot keep the process alive.
 */
export function initServiceLifecycle(): void {
  if (initialized) return;
  initialized = true;

  const previous = readLastRecord();
  // A `start` as the newest record means the last process never reached its
  // stop path: it was killed -9, panicked, OOMed, or the machine lost power.
  const previousUnclean = previous?.event === 'start';

  append({
    event: 'start',
    at: new Date().toISOString(),
    pid: process.pid,
    reason: previous
      ? previousUnclean
        ? 'previous run ended without a stop record (crash / kill -9 / power loss)'
        : `previous run stopped: ${previous.reason}`
      : 'first recorded start',
    previousUnclean,
    nodeVersion: process.version,
    commit: currentCommit(),
  });
  trim();

  if (previousUnclean) {
    logger.warn(
      { previousPid: previous?.pid, previousAt: previous?.at },
      'Service lifecycle: previous run ended without a clean stop — treating as a crash',
    );
  }

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const) {
    const observeSignal = () => {
      recordStop(`signal ${sig}`);
      const hasShutdownHandler = process
        .listeners(sig)
        .some((listener) => listener !== observeSignal);
      if (hasShutdownHandler) return;

      // Installing a signal listener suppresses Node's default termination.
      // Remove only our observer, then deliver the original signal again.
      // An independently installed handler keeps responsibility for shutdown.
      process.removeListener(sig, observeSignal);
      process.kill(process.pid, sig);
    };
    // Observe before once-handlers remove themselves during signal dispatch.
    process.prependListener(sig, observeSignal);
  }
  process.on('beforeExit', () => recordStop('event loop drained'));
  process.on('exit', (code) => recordStop(`process.exit(${code})`));
}
