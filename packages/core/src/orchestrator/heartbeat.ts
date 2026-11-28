/**
 * Process heartbeat: store/heartbeat.json, rewritten every minute.
 *
 * The deadman (scripts/skoobi-deadman.mjs) could only ask `pgrep` whether a
 * service process exists. A process whose event loop is blocked, whose message
 * loop stopped ticking, or whose Telegram polling died (the channel nulls its
 * client and never comes back) or keeps failing (no network; see W41 in
 * channelConnectivity) looks exactly as alive as a healthy one. The
 * heartbeat is the in-process view the watchdog lacks: when it was last
 * written, which phase the process is in, how old the last message-loop tick
 * is, whether each channel reports itself connected, memory use, and which
 * chat folders have a run in flight right now.
 *
 * Deliberately tiny and dumb: one sync write every 60 s through a temp file and
 * rename, an unref'd timer, never throws. A broken store/ produces one warning
 * per distinct error code, not a crash and not a log flood.
 *
 * Privacy: no chat ids, no JIDs, no tokens, no paths; active runs are listed
 * by group folder name only.
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
  /**
   * Review r1111 (channels-3): why a channel is down. 'stalled' — the client
   * lives but its polling fails (W41: no network), it comes back by itself;
   * 'stopped' — the client is gone (409 second consumer, 401, a fatal intake
   * error) and nothing reconnects it without a restart. Absent from an older
   * bot.
   */
  channelInbound?: Record<string, HeartbeatChannelInbound>;
  activeRunCount: number;
  /** group folder -> the run in flight there. */
  activeRuns: Record<string, HeartbeatActiveRun>;
}

export type HeartbeatChannelInbound = 'ok' | 'stalled' | 'stopped';
const CHANNEL_INBOUND_STATES: readonly HeartbeatChannelInbound[] = ['ok', 'stalled', 'stopped'];

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
  channelInbound?: Record<string, HeartbeatChannelInbound>;
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
  // Whitelisted values only: the deadman reads them as words, not as data.
  const channelInbound: Record<string, HeartbeatChannelInbound> = {};
  for (const [name, state] of Object.entries(input.channelInbound ?? {})) {
    if (CHANNEL_INBOUND_STATES.includes(state)) channelInbound[String(name)] = state;
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
    ...(Object.keys(channelInbound).length > 0 ? { channelInbound } : {}),
    activeRunCount,
    activeRuns,
  };
}

/**
 * Channel name -> connected. A channel whose isConnected() throws counts as
 * disconnected; two channels under one name are connected when either is
 * (the same any-connected rule the multi-bot Telegram channel uses).
 *
 * W41: a channel may also say whether its inbound side actually works
 * (isInboundHealthy). Telegram stays "connected" while grammY silently
 * retries a getUpdates that fails for hours; such a channel is reported as
 * down here so the beat — and the deadman reading it — stop claiming
 * telegram:true. A throwing isInboundHealthy is ignored (no false alarm from
 * a bug in the probe).
 */
export function channelConnectivity(
  channels: ReadonlyArray<{
    name: string;
    isConnected(): boolean;
    isInboundHealthy?(): boolean;
  }>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const channel of channels) {
    let connected = false;
    try {
      connected = channel.isConnected() === true;
    } catch {
      connected = false;
    }
    if (connected && typeof channel.isInboundHealthy === 'function') {
      try {
        connected = channel.isInboundHealthy() !== false;
      } catch {
        // keep isConnected()'s answer
      }
    }
    out[channel.name] = (out[channel.name] ?? false) || connected;
  }
  return out;
}

/**
 * Review r1111 (channels-3): channel name -> how its inbound side is. The
 * deadman tells «нет сети, вернётся сам» (stalled) from «опрос остановлен,
 * нужен перезапуск» (stopped): both were one telegram:false. Two channels
 * under one name: the better state wins, as in channelConnectivity (the
 * multi-bot Telegram channel is stopped only when every bot is).
 */
export function channelInboundState(
  channels: ReadonlyArray<{
    name: string;
    isConnected(): boolean;
    isInboundHealthy?(): boolean;
  }>,
): Record<string, HeartbeatChannelInbound> {
  const rank: Record<HeartbeatChannelInbound, number> = { ok: 2, stalled: 1, stopped: 0 };
  const out: Record<string, HeartbeatChannelInbound> = {};
  for (const channel of channels) {
    let state: HeartbeatChannelInbound = 'stopped';
    try {
      if (channel.isConnected() === true) state = 'ok';
    } catch {
      state = 'stopped';
    }
    if (state === 'ok' && typeof channel.isInboundHealthy === 'function') {
      try {
        if (channel.isInboundHealthy() === false) state = 'stalled';
      } catch {
        // keep 'ok', as channelConnectivity does
      }
    }
    const prev = out[channel.name];
    if (!prev || rank[state] > rank[prev]) out[channel.name] = state;
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
  getChannelInbound?: () => Record<string, HeartbeatChannelInbound>;
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
          ...(opts.getChannelInbound
            ? { channelInbound: safe(opts.getChannelInbound, {}) }
            : {}),
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
