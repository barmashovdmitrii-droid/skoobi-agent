/**
 * Process heartbeat: store/heartbeat.json, rewritten every minute.
 *
 * Records the process phase, message-loop freshness, channel connectivity,
 * memory use, and active group folders for local health monitoring. Process
 * existence alone does not establish that the message loop is responsive.
 *
 * Uses an atomic replacement and an unreferenced timer. Write errors are
 * reported once per distinct error code without interrupting the service.
 *
 * Only approved fields are recorded. Group folder names can identify chats;
 * treat this file as private runtime state and never publish it.
 */
import fs from 'fs';
import path from 'path';
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';

import { logger } from './logger.js';

export const HEARTBEAT_INTERVAL_MS = 60_000;

export type HeartbeatPhase = 'starting' | 'running';

export interface HeartbeatActiveRun {
  /** ISO time the run took the group's queue slot. */
  startedAt: string;
  /** A scheduled-task container, not an answer to a chat message. */
  task: boolean;
}

export interface HeartbeatSnapshot {
  v: 1;
  ts: string;
  pid: number;
  startedAt: string;
  uptimeSec: number;
  phase: HeartbeatPhase;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  loopTickAgeSec: number | null;
  eventLoopDelayMaxMs: number | null;
  channels: Record<string, boolean>;
  activeRunCount: number;
  /** group folder -> the run in flight there. */
  activeRuns: Record<string, HeartbeatActiveRun>;
}

/** What GroupQueue.getActiveRunsSummary() returns, one entry per busy group. */
export interface HeartbeatRunInfo {
  groupFolder: string | null;
  startedAt: number;
  isTaskContainer: boolean;
}

export interface HeartbeatInput {
  pid: number;
  processStartedAtMs: number;
  channels: Record<string, boolean>;
  /** Start of the last message-loop iteration; undefined before the first. */
  loopTickAt: number | undefined;
  eventLoopDelayMaxMs: number | null;
  activeRuns?: readonly HeartbeatRunInfo[];
}

type MemoryUsageLike = Pick<
  NodeJS.MemoryUsage,
  'rss' | 'heapUsed' | 'heapTotal' | 'external'
>;

// Folder names are validated elsewhere (group-folder.ts); this is only a last
// guard so nothing that looks like a JID or a path can end up in the file.
const SAFE_FOLDER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function toMb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) return 0;
  return Math.round(bytes / (1024 * 1024));
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Pure: builds the snapshot from explicit inputs, copying whitelisted fields only. */
export function buildHeartbeat(
  input: HeartbeatInput,
  mem: MemoryUsageLike = process.memoryUsage(),
  now: number = Date.now(),
): HeartbeatSnapshot {
  const channels: Record<string, boolean> = {};
  for (const [name, connected] of Object.entries(input.channels)) {
    channels[String(name)] = connected === true;
  }

  const activeRuns: Record<string, HeartbeatActiveRun> = {};
  let activeRunCount = 0;
  for (const run of input.activeRuns ?? []) {
    if (!Number.isFinite(run.startedAt)) continue;
    activeRunCount += 1;
    const folder = run.groupFolder;
    if (!folder || !SAFE_FOLDER.test(folder)) continue;
    const entry: HeartbeatActiveRun = {
      startedAt: toIso(run.startedAt),
      task: run.isTaskContainer === true,
    };
    const prev = activeRuns[folder];
    // One run per group is the queue's invariant; if two ever map to the same
    // folder, a chat run wins over a task (the deadman only trusts chat runs),
    // and between equals the older start is kept (the stricter reading).
    if (
      !prev ||
      (prev.task && !entry.task) ||
      (prev.task === entry.task && entry.startedAt < prev.startedAt)
    ) {
      activeRuns[folder] = entry;
    }
  }

  const loopTickAgeSec =
    typeof input.loopTickAt === 'number' && Number.isFinite(input.loopTickAt)
      ? Math.max(0, Math.round((now - input.loopTickAt) / 1000))
      : null;

  return {
    v: 1,
    ts: toIso(now),
    pid: input.pid,
    startedAt: toIso(input.processStartedAtMs),
    uptimeSec: Math.max(
      0,
      Math.round((now - input.processStartedAtMs) / 1000),
    ),
    phase: loopTickAgeSec === null ? 'starting' : 'running',
    rssMb: toMb(mem.rss),
    heapUsedMb: toMb(mem.heapUsed),
    heapTotalMb: toMb(mem.heapTotal),
    externalMb: toMb(mem.external),
    loopTickAgeSec,
    eventLoopDelayMaxMs:
      typeof input.eventLoopDelayMaxMs === 'number' &&
      Number.isFinite(input.eventLoopDelayMaxMs)
        ? Math.round(input.eventLoopDelayMaxMs)
        : null,
    channels,
    activeRunCount,
    activeRuns,
  };
}

/**
 * Channel name -> connected. A channel whose isConnected() throws counts as
 * disconnected; two channels under one name are connected when either is
 * (the same any-connected rule the multi-bot Telegram channel uses).
 */
export function channelConnectivity(
  channels: ReadonlyArray<{ name: string; isConnected(): boolean }>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const channel of channels) {
    let connected = false;
    try {
      connected = channel.isConnected() === true;
    } catch {
      connected = false;
    }
    out[channel.name] = (out[channel.name] ?? false) || connected;
  }
  return out;
}

const moduleWarnedCodes = new Set<string>();

/**
 * Write the snapshot atomically (temp file 0600 + rename). Never throws:
 * returns false on failure and warns once per distinct error code until a
 * write succeeds again.
 */
export function writeHeartbeatFile(
  file: string,
  snap: HeartbeatSnapshot,
  warnedCodes: Set<string> = moduleWarnedCodes,
): boolean {
  const tmp = `${file}.tmp-${process.pid}`;
  let fd: number | null = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // A temp left behind by a failed rename would make O_EXCL fail forever.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // usually ENOENT
    }
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, `${JSON.stringify(snap)}\n`);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    if (warnedCodes.size > 0) {
      warnedCodes.clear();
      logger.info({ file }, 'Heartbeat file is being written again');
    }
    return true;
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    const code =
      (err as NodeJS.ErrnoException | undefined)?.code || 'UNKNOWN';
    if (!warnedCodes.has(code)) {
      warnedCodes.add(code);
      logger.warn(
        { file, code, err: err instanceof Error ? err.message : String(err) },
        'Heartbeat file write failed; the deadman will report a stale heartbeat',
      );
    }
    return false;
  }
}

export interface StartHeartbeatOptions {
  file: string;
  intervalMs?: number;
  getChannels: () => Record<string, boolean>;
  getLoopTickAt: () => number | undefined;
  getActiveRuns?: () => readonly HeartbeatRunInfo[] | undefined;
  now?: () => number;
}

export interface HeartbeatHandle {
  stop(): void;
}

/**
 * Write a beat now, then every intervalMs, on an unref'd timer. Each callback
 * is isolated: a throwing getter degrades that field, never the beat.
 */
export function startHeartbeat(opts: StartHeartbeatOptions): HeartbeatHandle {
  const intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const processStartedAtMs = now() - process.uptime() * 1000;
  const warnedCodes = new Set<string>();

  let histogram: IntervalHistogram | null = null;
  try {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  } catch {
    histogram = null;
  }

  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  let stopped = false;
  const beat = (): void => {
    if (stopped) return;
    try {
      let eventLoopDelayMaxMs: number | null = null;
      if (histogram) {
        // Nanoseconds; 0 until the first sample.
        eventLoopDelayMaxMs = histogram.max / 1e6;
        histogram.reset();
      }
      const loopTickAt = safe(opts.getLoopTickAt, undefined);
      const snap = buildHeartbeat(
        {
          pid: process.pid,
          processStartedAtMs,
          channels: safe(opts.getChannels, {}),
          loopTickAt,
          eventLoopDelayMaxMs,
          activeRuns: opts.getActiveRuns
            ? (safe(opts.getActiveRuns, undefined) ?? [])
            : [],
        },
        process.memoryUsage(),
        now(),
      );
      writeHeartbeatFile(opts.file, snap, warnedCodes);
    } catch (err) {
      const code = 'BUILD';
      if (!warnedCodes.has(code)) {
        warnedCodes.add(code);
        logger.warn({ err }, 'Heartbeat snapshot failed');
      }
    }
  };

  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        histogram?.disable();
      } catch {
        // ignore
      }
    },
  };
}
