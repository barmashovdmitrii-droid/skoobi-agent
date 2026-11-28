import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  CodexTurnTelemetry,
  ContainerOutput,
} from '../runtimes/container-runner.js';

/**
 * Honest accounting of codex turns (проверка п. 7–8).
 *
 * Two things live here. The account-limit reading across every CODEX_HOME on
 * the machine, which the host hands to the runner for the fast-tier ceiling:
 * a runner can only read its own group's rollouts, and that view goes stale
 * while the other chat burns the quota (one group once still asked for
 * the fast tier at 88–96 % because its own newest rollout said less). And the
 * shape of a turn's telemetry for model_traces / session_finished payloads
 * and the one INFO line per turn.
 */

const ROLLOUT_TAIL_BYTES = 512 * 1024;
/**
 * A snapshot older than this says nothing about the limit now. The runner
 * applies the same age to its own group's reading (agent/runner codex-exec.ts
 * CODEX_ACCOUNT_READING_MAX_AGE_MS; setup/codex-fast-tier-wire.test.ts keeps
 * the two equal): without a reading this fresh the fast tier is not asked
 * for (r1109, item 5).
 *
 * The age is the snapshot's own (the timestamp of its token_count record),
 * not the file's mtime (r1110): codex Desktop once touched an old session,
 * its old snapshot (24 %) passed for a fresh one, and a
 * new thread asked for Fast at a real 95 %. The mtime only narrows the walk:
 * a file last written before the window holds nothing newer.
 */
export const CODEX_ACCOUNT_READING_MAX_AGE_MS = 6 * 3_600_000;
/**
 * A snapshot further ahead of this host's clock than this is no reading
 * (r1110): it was written under a wrong clock, and as «the newest» it would
 * outrank every honest snapshot for hours. A few minutes ahead is ordinary
 * drift. The runner allows the same (setup/codex-quota-freshness.test.ts).
 */
export const CODEX_ACCOUNT_READING_MAX_FUTURE_MS = 10 * 60_000;
const DEFAULT_MAX_ROLLOUT_AGE_MS = CODEX_ACCOUNT_READING_MAX_AGE_MS;
/**
 * The newest rollouts whose tails are always read (the deadman reads 8 as
 * well). Past them the walk goes on, newest first, only while no fresh
 * snapshot is found or an older file may still hold a newer one (r1110).
 */
const DEFAULT_MIN_ROLLOUTS = 8;
/**
 * Hard caps of that walk: the canary leaves ~50 rollouts without a snapshot
 * in 6 h of an outage, a tail is at most ROLLOUT_TAIL_BYTES.
 */
const DEFAULT_MAX_SCAN_ROLLOUTS = 200;
const DEFAULT_MAX_SCAN_BYTES = 32 * 1024 * 1024;
/**
 * One reading serves every run started within this window: the limit moves
 * ~1 pp/hour, and the walk stats every rollout of ~/.codex (2 265 files
 * took 140 ms) — not something to repeat on each turn.
 */
const DEFAULT_READING_TTL_MS = 60_000;

const readingCache = new Map<
  string,
  { at: number; value: CodexHostAccountReading | null }
>();

/** One window of the host's snapshot (review r1111, turn-2). */
export interface CodexHostLimitWindow {
  usedPercent: number;
  windowMinutes?: number;
  /** When codex says this window resets, ms. */
  resetsAtMs?: number;
}

/** The host's account limit reading: the percent and its snapshot's own time. */
export interface CodexHostAccountReading {
  usedPercent: number;
  /** The snapshot's own time (its token_count timestamp), ms. */
  atMs: number;
  /**
   * The snapshot's windows that are a reading, with their reset times
   * (turn-2): codex_quota_status drops a window whose reset has passed, as
   * it does for this chat's own snapshot. The Fast ceiling keeps reading
   * usedPercent — after a reset the larger, old percent is the safe side.
   */
  windows?: CodexHostLimitWindow[];
}

interface RateLimitsSnapshot {
  /** The record's ISO timestamp — the newest snapshot wins, not the newest file. */
  at: string;
  usedPercent: number;
  windows: CodexHostLimitWindow[];
}

interface RolloutFile {
  file: string;
  mtimeMs: number;
  size: number;
}

/**
 * Plain rollouts only: the sessions codex Desktop compressed
 * (rollout-*.jsonl.zst) are old ones and are not read.
 */
function walkRollouts(dir: string, out: RolloutFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRollouts(full, out);
    } else if (/^rollout-.*\.jsonl$/.test(entry.name)) {
      try {
        const { mtimeMs, size } = fs.statSync(full);
        out.push({ file: full, mtimeMs, size });
      } catch {
        /* rotated away between readdir and stat */
      }
    }
  }
}

function readTail(file: string, bytes: number): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * A limit window's used_percent when the window says how much is used: the
 * share is a number, and the window's length, when given, is above zero.
 * Otherwise null — the window is no reading.
 *
 * codex once wrote a degenerate snapshot between two of
 * 45 %: primary {used_percent: 0, window_minutes: 0, resets_at ≈ the
 * snapshot's own time}. Read as 0 % it let Fast through at any quota. A
 * used_percent of null read as 0 % the same way (Number(null) is 0). This
 * was so before r1110. The runner's rateLimitWindowUsedPercent
 * (agent/runner codex-exec.ts) keeps the same rule.
 */
function windowUsedPercent(window: unknown): number | null {
  if (!window || typeof window !== 'object') return null;
  const { used_percent: used, window_minutes: minutes } = window as {
    used_percent?: unknown;
    window_minutes?: unknown;
  };
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  if (minutes !== undefined && minutes !== null && !(Number(minutes) > 0)) return null;
  return used;
}

/** The windows of a snapshot that are a reading, with their reset times. */
function limitWindowsOf(rateLimits: unknown): CodexHostLimitWindow[] {
  const limits = rateLimits as { limit_id?: unknown; primary?: unknown; secondary?: unknown } | null | undefined;
  if (!limits || typeof limits !== 'object') return [];
  if (limits.limit_id !== undefined && limits.limit_id !== 'codex') return [];
  const out: CodexHostLimitWindow[] = [];
  for (const window of [limits.primary, limits.secondary]) {
    const usedPercent = windowUsedPercent(window);
    if (usedPercent === null) continue;
    const { window_minutes: minutes, resets_at: resetsAt } = window as {
      window_minutes?: unknown;
      resets_at?: unknown;
    };
    out.push({
      usedPercent,
      ...(typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
        ? { windowMinutes: minutes }
        : {}),
      // codex writes resets_at in seconds.
      ...(typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0
        ? { resetsAtMs: resetsAt * 1000 }
        : {}),
    });
  }
  return out;
}

/** The larger used_percent of the limit windows that are a reading; null when none is. */
function usedPercentOf(rateLimits: unknown): number | null {
  const limits = rateLimits as
    | {
        limit_id?: unknown;
        primary?: unknown;
        secondary?: unknown;
      }
    | null
    | undefined;
  if (!limits || typeof limits !== 'object') return null;
  // Codex names the account limit `codex`; anything else is not this quota.
  if (limits.limit_id !== undefined && limits.limit_id !== 'codex') return null;
  const values = [limits.primary, limits.secondary]
    .map(windowUsedPercent)
    .filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

/**
 * A record's own time in ms; null when it has none that reads as an ISO
 * date — codex stamps every record so (2026-11-09T11:17:12.111Z).
 */
function codexSnapshotTimeMs(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The last rate_limits snapshot in a chunk of a rollout file that has a time
 * of its own (r1110: without one it is no reading). Given `now`, a snapshot
 * more than `maxFutureMs` ahead of it is skipped as well, and so is one
 * without a window that is a reading (windowUsedPercent: a degenerate
 * snapshot) — the one before it counts.
 */
export function lastCodexRateLimits(
  text: string,
  opts: { now?: number; maxFutureMs?: number } = {},
): RateLimitsSnapshot | null {
  const latestAllowed =
    opts.now === undefined
      ? Number.POSITIVE_INFINITY
      : opts.now + (opts.maxFutureMs ?? CODEX_ACCOUNT_READING_MAX_FUTURE_MS);
  let last: RateLimitsSnapshot | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"rate_limits"')) continue;
    let row: { timestamp?: unknown; payload?: { rate_limits?: unknown } };
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a partial line at the tail cut
    }
    const usedPercent = usedPercentOf(row?.payload?.rate_limits);
    if (usedPercent === null) continue;
    const atMs = codexSnapshotTimeMs(row.timestamp);
    if (atMs === null || atMs > latestAllowed) continue;
    last = {
      at: row.timestamp as string,
      usedPercent,
      windows: limitWindowsOf(row?.payload?.rate_limits),
    };
  }
  return last;
}

/**
 * How much of the shared ChatGPT account's Codex limit is used, per the
 * newest rate_limits snapshot across every CODEX_HOME under
 * `<dataDir>/codex-homes` and the user's own ~/.codex (the desktop app and
 * the canary write there). null when no snapshot of the last
 * CODEX_ACCOUNT_READING_MAX_AGE_MS (by its own time) is found.
 */
export function codexAccountUsedPercentAcrossHomes(opts: {
  dataDir: string;
  /** Default os.homedir()/.codex; null leaves the user's sessions out. */
  userCodexHome?: string | null;
  now?: number;
  maxAgeMs?: number;
  maxFutureMs?: number;
  /** The newest rollouts read in any case. */
  minFiles?: number;
  /** Caps of the walk past them. */
  maxScanFiles?: number;
  maxScanBytes?: number;
  /** 0 reads the rollouts every time. */
  readingTtlMs?: number;
  /**
   * Called with the reading behind the percent — its snapshot's own time
   * goes to codex_quota_status, which applies the same freshness rule at
   * the moment it is asked (W27, r1111). Not called without a reading.
   */
  onReading?: (reading: CodexHostAccountReading) => void;
}): number | null {
  const now = opts.now ?? Date.now();
  const readingTtlMs = opts.readingTtlMs ?? DEFAULT_READING_TTL_MS;
  const userHome =
    opts.userCodexHome === undefined
      ? path.join(os.homedir(), '.codex')
      : opts.userCodexHome;
  const cacheKey = `${opts.dataDir}\0${userHome ?? ''}`;
  const cached = readingCache.get(cacheKey);
  if (cached && readingTtlMs > 0 && now - cached.at < readingTtlMs && now >= cached.at) {
    if (cached.value) opts.onReading?.(copyReading(cached.value));
    return cached.value?.usedPercent ?? null;
  }
  const value = readAccountUsedPercent({
    dataDir: opts.dataDir,
    userHome,
    now,
    maxAgeMs: opts.maxAgeMs ?? DEFAULT_MAX_ROLLOUT_AGE_MS,
    maxFutureMs: opts.maxFutureMs ?? CODEX_ACCOUNT_READING_MAX_FUTURE_MS,
    minFiles: opts.minFiles ?? DEFAULT_MIN_ROLLOUTS,
    maxScanFiles: opts.maxScanFiles ?? DEFAULT_MAX_SCAN_ROLLOUTS,
    maxScanBytes: opts.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES,
  });
  readingCache.set(cacheKey, { at: now, value });
  if (value) opts.onReading?.(copyReading(value));
  return value?.usedPercent ?? null;
}

function copyReading(reading: CodexHostAccountReading): CodexHostAccountReading {
  return {
    ...reading,
    ...(reading.windows ? { windows: reading.windows.map((window) => ({ ...window })) } : {}),
  };
}

function readAccountUsedPercent(opts: {
  dataDir: string;
  userHome: string | null;
  now: number;
  maxAgeMs: number;
  maxFutureMs: number;
  minFiles: number;
  maxScanFiles: number;
  maxScanBytes: number;
}): CodexHostAccountReading | null {
  const { userHome, now, maxAgeMs, maxFutureMs, minFiles, maxScanFiles, maxScanBytes } =
    opts;
  const sessionDirs: string[] = [];
  if (userHome) sessionDirs.push(path.join(userHome, 'sessions'));
  const homesDir = path.join(opts.dataDir, 'codex-homes');
  let homes: string[] = [];
  try {
    homes = fs.readdirSync(homesDir);
  } catch {
    homes = [];
  }
  for (const home of homes) {
    sessionDirs.push(path.join(homesDir, home, 'sessions'));
  }
  const files: RolloutFile[] = [];
  for (const dir of sessionDirs) walkRollouts(dir, files);
  // A file last written before the window holds no snapshot inside it.
  const recent = files
    .filter((entry) => now - entry.mtimeMs <= maxAgeMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  let latest: CodexHostAccountReading | null = null;
  let scannedFiles = 0;
  let scannedBytes = 0;
  for (const [index, entry] of recent.entries()) {
    // Past the newest few: a file last written before the newest snapshot
    // found cannot hold a newer one (the list is newest first).
    if (index >= minFiles && latest && entry.mtimeMs < latest.atMs) break;
    if (scannedFiles >= maxScanFiles || scannedBytes >= maxScanBytes) break;
    scannedFiles += 1;
    scannedBytes += Math.min(entry.size, ROLLOUT_TAIL_BYTES);
    const tail = readTail(entry.file, ROLLOUT_TAIL_BYTES);
    if (tail === null) continue;
    const found = lastCodexRateLimits(tail, { now, maxFutureMs });
    if (!found) continue;
    const atMs = codexSnapshotTimeMs(found.at);
    // Stale by its own time: this file says nothing of the limit now, an
    // older one still may (a touched old session).
    if (atMs === null || now - atMs > maxAgeMs) continue;
    if (!latest || atMs > latest.atMs) {
      latest = { atMs, usedPercent: found.usedPercent, windows: found.windows };
    }
  }
  return latest;
}

/** Why the fast tier was not asked for although .env has it on. */
export type CodexFastTierDropReason = NonNullable<
  CodexTurnTelemetry['fastTierDroppedReason']
>;

/**
 * The fast-tier decision for a codex run the host starts itself (artifact
 * jobs) — the same rule as the runner's effectiveCodexServiceTier /
 * resolveCodexTurnServiceTier (setup/codex-fast-tier-wire.test.ts checks
 * they agree): Fast only when .env has it on and the limit is known to be
 * below the ceiling; without a fresh reading (null) only when the owner set
 * SKOOBI_CODEX_SERVICE_TIER_UNKNOWN_QUOTA=priority (r1109, item 5).
 */
export function codexServiceTierForReading(
  config: {
    serviceTier?: string;
    serviceTierMaxUsedPercent?: number;
    serviceTierUnknownQuota?: string;
  },
  usedPercent: number | null,
): { serviceTier: 'priority' | undefined; droppedReason?: CodexFastTierDropReason } {
  if (config.serviceTier !== 'priority') return { serviceTier: undefined };
  if (usedPercent === null || !Number.isFinite(usedPercent)) {
    return config.serviceTierUnknownQuota === 'priority'
      ? { serviceTier: 'priority' }
      : { serviceTier: undefined, droppedReason: 'no_quota_reading' };
  }
  return usedPercent >= (config.serviceTierMaxUsedPercent ?? 80)
    ? { serviceTier: undefined, droppedReason: 'quota_ceiling' }
    : { serviceTier: 'priority' };
}

/**
 * The reason a payload gets for a dropped fast tier: what the runner said,
 * else 'quota_ceiling' — a runner from before r1109 dropped Fast at the
 * ceiling only. undefined when Fast was not dropped.
 */
export function codexFastTierDropReason(
  codexTurn: CodexTurnTelemetry | undefined,
): CodexFastTierDropReason | undefined {
  if (!codexTurn?.fastTierDroppedForQuota) return undefined;
  return codexTurn.fastTierDroppedReason === 'no_quota_reading'
    ? 'no_quota_reading'
    : 'quota_ceiling';
}

/**
 * Fast was asked for and codex reported the settings it applied, without
 * it. W02: every resumed turn of two threads born without Fast
 * asked for priority and ran on the standard tier (154 log lines
 * «tier=default (asked priority)»), while the bot said three times
 * that Fast was on. A tier codex never reported (undefined) is no evidence.
 */
export function codexTierMismatch(
  codexTurn: CodexTurnTelemetry | undefined,
): boolean {
  return (
    codexTurn?.requestedServiceTier === 'priority' &&
    codexTurn.serviceTier !== undefined &&
    codexTurn.serviceTier !== 'priority'
  );
}

/**
 * The reverse of codexTierMismatch: the runner did NOT ask for Fast (the
 * quota ceiling dropped it, or Fast is off in .env) and codex applied it all
 * the same. W02: if codex keeps the tier a thread was born with (variant A,
 * unconfirmed), a thread born with Fast keeps spending the quota
 * at the Fast rate past the ceiling — the owner must see that. An unknown
 * request (undefined, an older runner) is no evidence.
 *
 * A turn that did not ask for Fast only for want of a fresh limit reading
 * (r1109, item 5) is not counted: that is the first turn after ≥ 6 h of
 * silence, and the next one has a reading again — counted, the deadman's
 * «Fast работает, хотя снят (квота у потолка или Fast выключен)» would come
 * every such morning under variant A, naming a reason that is not there.
 * The payload still says what happened (requested_service_tier null,
 * service_tier priority, fast_tier_dropped_reason no_quota_reading), and the
 * deadman reads that reason: such a turn is neutral there — it neither
 * extends the «Fast без запроса» run nor closes an episode already open.
 */
export function codexFastAppliedUnrequested(
  codexTurn: CodexTurnTelemetry | undefined,
): boolean {
  return (
    codexTurn?.requestedServiceTier === null &&
    codexTurn.serviceTier === 'priority' &&
    codexFastTierDropReason(codexTurn) !== 'no_quota_reading'
  );
}

/**
 * The turn's telemetry as payload fields of model_traces / session_finished
 * (snake_case like the rest of those payloads). Nothing when the runner saw
 * no rollout, so a Claude turn's payload stays as it was.
 */
export function codexTurnTracePayload(
  codexTurn: CodexTurnTelemetry | undefined,
): Record<string, unknown> {
  if (!codexTurn) return {};
  const out: Record<string, unknown> = {};
  if (codexTurn.requestedModel) out.requested_model = codexTurn.requestedModel;
  if (codexTurn.observedModel) out.effective_model = codexTurn.observedModel;
  if (codexTurn.usageSource !== undefined) {
    out.usage_source = codexTurn.usageSource;
  }
  if (codexTurn.modelRequests !== undefined) {
    out.model_requests = codexTurn.modelRequests;
  }
  if (codexTurn.requestedServiceTier !== undefined) {
    out.requested_service_tier = codexTurn.requestedServiceTier;
  }
  if (codexTurn.serviceTier !== undefined) {
    out.service_tier = codexTurn.serviceTier;
  }
  if (codexTurn.reasoningEffort !== undefined) {
    out.reasoning_effort = codexTurn.reasoningEffort;
  }
  if (codexTurn.accountUsedPercent !== undefined) {
    out.used_percent = codexTurn.accountUsedPercent;
  }
  if (codexTurn.fastTierDroppedForQuota) {
    out.fast_tier_dropped_for_quota = true;
    out.fast_tier_dropped_reason = codexFastTierDropReason(codexTurn);
  }
  if (
    codexTurn.threadServiceTier === 'priority' ||
    codexTurn.threadServiceTier === null
  ) {
    out.thread_requested_service_tier = codexTurn.threadServiceTier;
  }
  if (codexTierMismatch(codexTurn)) out.tier_mismatch = true;
  if (codexFastAppliedUnrequested(codexTurn)) out.fast_applied_unrequested = true;
  if (codexTurn.toolCalls && Object.keys(codexTurn.toolCalls).length > 0) {
    out.tool_calls = { ...codexTurn.toolCalls };
  }
  if (codexTurn.subagentTokens) {
    out.subagent_tokens = codexTurn.subagentTokens;
  }
  // Tool failures and timings (check C41): the per-tool failure map
  // feeds the watchdog's daily notice and the panel; non-zero exits are for
  // reference only (grep with no match exits 1).
  if (codexTurn.toolErrors && Object.keys(codexTurn.toolErrors).length > 0) {
    out.tool_errors = { ...codexTurn.toolErrors };
  }
  if (codexTurn.toolRejections) out.tool_rejections = { ...codexTurn.toolRejections };
  // Why an «at capacity»/link failure was not retried (W10).
  if (codexTurn.transientRetrySkipped) {
    out.transient_retry_skipped = codexTurn.transientRetrySkipped.slice(0, 80);
  }
  if (codexTurn.toolErrorClassificationVersion === 1) out.tool_error_classification_version = 1;
  if (codexTurn.toolExitNonzero) {
    out.tool_exit_nonzero = codexTurn.toolExitNonzero;
  }
  // M-G2.3a (r1111): shell commands that drove the screen, by kind.
  if (codexTurn.screenControlCommands && Object.keys(codexTurn.screenControlCommands).length > 0) {
    out.screen_control_commands = { ...codexTurn.screenControlCommands };
  }
  if (codexTurn.toolWallMsTotal !== undefined) {
    out.tool_wall_ms_total = codexTurn.toolWallMsTotal;
  }
  if (codexTurn.toolWallMsMax !== undefined) {
    out.tool_wall_ms_max = codexTurn.toolWallMsMax;
  }
  if (codexTurn.codexCliVersion) {
    out.codex_cli_version = codexTurn.codexCliVersion;
  }
  return out;
}

/** What the host knows about one finished Codex run of a scheduled task. */
export interface ScheduledTaskRunTelemetry {
  groupFolder: string;
  taskId: string;
  /** taskTelemetryTitle(): never a word of the prompt. */
  taskTitle: string;
  taskKind: 'background' | 'reminder';
  status: 'success' | 'error' | 'cancelled';
  durationMs: number;
  turns?: number;
  /** The run's telemetry summed over its frames (runCost.total). */
  codexTurn: CodexTurnTelemetry | undefined;
  /** The tier .env asks for ('priority'), undefined when Fast is off. */
  configuredServiceTier?: 'priority';
  /** SKOOBI_CODEX_SERVICE_TIER_MAX_USED_PERCENT the runner got. */
  serviceTierCeilingPercent?: number;
  /** The host's reading of the account limit handed to the runner at start. */
  usedPercentAtStart?: number | null;
}

/**
 * The payload of scheduled_task_finished (r1109, item 6). 40 of 43 runs
 * with Fast were scheduled tasks — 9 runs of one task in a day at
 * 87–95 % of the quota — and none of it reached the watchdog or the panel:
 * the task path wrote agent_runs (tokens, no tier) and an INFO line only.
 *
 * The turn's own fields are codexTurnTracePayload's, as in session_finished
 * (usage_source, requested/applied tier, used_percent, effort, CLI version,
 * fast_applied_unrequested …). Token counts stay in agent_runs: the event
 * store masks every key with «token» in it, here as in session_finished. No
 * prompt text: the title is taskTelemetryTitle().
 */
export function scheduledTaskFinishedPayload(
  run: ScheduledTaskRunTelemetry,
): Record<string, unknown> {
  const turn = codexTurnTracePayload(run.codexTurn);
  const usedAtStart = Number(run.usedPercentAtStart);
  return {
    trigger: 'scheduled_task',
    group_folder: run.groupFolder,
    task_id: run.taskId,
    task_title: run.taskTitle,
    task_kind: run.taskKind,
    status: run.status,
    duration_ms: run.durationMs,
    turns: run.turns ?? 0,
    configured_service_tier: run.configuredServiceTier ?? null,
    ...(run.configuredServiceTier && Number.isFinite(run.serviceTierCeilingPercent)
      ? { service_tier_ceiling_percent: run.serviceTierCeilingPercent }
      : {}),
    ...(run.configuredServiceTier
      ? {
          used_percent_at_start:
            run.usedPercentAtStart === null ||
            run.usedPercentAtStart === undefined ||
            !Number.isFinite(usedAtStart)
              ? null
              : usedAtStart,
        }
      : {}),
    // No rollout seen (codex died before writing one): say so instead of
    // leaving the source out.
    usage_source: 'none',
    // fast_tier_dropped_reason comes with the turn's fields, as in
    // session_finished: 'quota_ceiling' or 'no_quota_reading' (r1109, item 5;
    // a runner from before r1109 — 'quota_ceiling').
    ...turn,
    timestamp: new Date().toISOString(),
  };
}

type UsageSource = NonNullable<CodexTurnTelemetry['usageSource']>;

/** The weaker of two usage sources: a sum is as honest as its weaker part. */
function weakerUsageSource(
  a: UsageSource | undefined,
  b: UsageSource | undefined,
): UsageSource | undefined {
  if (b && b !== 'turn_delta') return b;
  if (a && a !== 'turn_delta') return a;
  return b ?? a;
}

function sumCounts(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, number> = { ...(a ?? {}) };
  for (const [name, count] of Object.entries(b ?? {})) {
    const n = Number(count);
    if (Number.isFinite(n)) out[name] = (out[name] ?? 0) + n;
  }
  return out;
}

/**
 * Two turns' telemetry as one: requests and tool counts add up, the applied
 * settings and the account limit are the later turn's (the earlier one's when
 * the later did not say), the usage source is the weaker of the two.
 */
export function mergeCodexTurnTelemetry(
  earlier: CodexTurnTelemetry | undefined,
  later: CodexTurnTelemetry | undefined,
): CodexTurnTelemetry | undefined {
  if (!earlier || !later) {
    const only = earlier ?? later;
    return only
      ? {
          ...only,
          ...(only.toolCalls ? { toolCalls: { ...only.toolCalls } } : {}),
          ...(only.toolErrors ? { toolErrors: { ...only.toolErrors } } : {}),
          ...(only.toolRejections ? { toolRejections: { ...only.toolRejections } } : {}),
          ...(only.screenControlCommands
            ? { screenControlCommands: { ...only.screenControlCommands } }
            : {}),
        }
      : undefined;
  }
  const out: CodexTurnTelemetry = {};
  // Model identity belongs to the latest contributing turn, including unknown.
  if (later.requestedModel) out.requestedModel = later.requestedModel;
  if (later.observedModel) out.observedModel = later.observedModel;
  const usageSource = weakerUsageSource(earlier.usageSource, later.usageSource);
  if (usageSource) out.usageSource = usageSource;
  const modelRequests =
    (earlier.modelRequests ?? 0) + (later.modelRequests ?? 0);
  if (modelRequests > 0) out.modelRequests = modelRequests;
  for (const key of [
    'requestedServiceTier',
    'serviceTier',
    'reasoningEffort',
    'accountUsedPercent',
    'threadServiceTier',
  ] as const) {
    const value = later[key] !== undefined ? later[key] : earlier[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  if (earlier.fastTierDroppedForQuota || later.fastTierDroppedForQuota) {
    out.fastTierDroppedForQuota = true;
    // The later turn's reason when it dropped Fast itself.
    const reason = later.fastTierDroppedForQuota
      ? later.fastTierDroppedReason
      : earlier.fastTierDroppedReason;
    if (reason) out.fastTierDroppedReason = reason;
  }
  const toolCalls = sumCounts(earlier.toolCalls, later.toolCalls);
  if (toolCalls && Object.keys(toolCalls).length > 0) out.toolCalls = toolCalls;
  const subagentTokens =
    (earlier.subagentTokens ?? 0) + (later.subagentTokens ?? 0);
  if (subagentTokens > 0) out.subagentTokens = subagentTokens;
  const toolErrors = sumCounts(earlier.toolErrors, later.toolErrors);
  if (toolErrors && Object.keys(toolErrors).length > 0) out.toolErrors = toolErrors;
  const toolRejections = sumCounts(earlier.toolRejections, later.toolRejections);
  if (toolRejections && Object.keys(toolRejections).length) out.toolRejections = toolRejections;
  const parts = [earlier, later];
  if (parts.some(p => p.toolErrorClassificationVersion === 1) &&
      parts.every(p => p.toolErrorClassificationVersion === 1 || !Object.keys(p.toolErrors ?? {}).length)) {
    out.toolErrorClassificationVersion = 1;
  }

  const toolExitNonzero =
    (earlier.toolExitNonzero ?? 0) + (later.toolExitNonzero ?? 0);
  if (toolExitNonzero > 0) out.toolExitNonzero = toolExitNonzero;
  const screenControl = sumCounts(earlier.screenControlCommands, later.screenControlCommands);
  if (screenControl && Object.keys(screenControl).length > 0) out.screenControlCommands = screenControl;
  if (
    earlier.toolWallMsTotal !== undefined ||
    later.toolWallMsTotal !== undefined
  ) {
    out.toolWallMsTotal =
      (earlier.toolWallMsTotal ?? 0) + (later.toolWallMsTotal ?? 0);
    out.toolWallMsMax = Math.max(
      earlier.toolWallMsMax ?? 0,
      later.toolWallMsMax ?? 0,
    );
  }
  const codexCliVersion = later.codexCliVersion ?? earlier.codexCliVersion;
  if (codexCliVersion) out.codexCliVersion = codexCliVersion;
  return out;
}

type RunCost = Pick<ContainerOutput, 'usage' | 'turns' | 'codexTurn'>;
/** Any frame of the run (or its final output); only the cost fields are read. */
type RunCostFrame = Partial<ContainerOutput>;

/**
 * What one run cost, over all of its frames (G1.4). A run is
 * often several codex turns: messages that arrive while Скуби answers are
 * answered as turns of their own in the same run, each with its own success
 * frame. The host kept only the last frame's usage, so one run of three
 * turns (19.4 M + 6.3 M + 0.1 M) went into agent_runs as 0.1 M and 26 of 165
 * runs were undercounted — 80 % of the 112 M that were missing.
 *
 * Codex frames (they carry codexTurn) are summed: every one is the delta of
 * its own turn. A frame without codexTurn — the legacy Claude path, which
 * repeats a query's usage on the result frame and on the session frame —
 * keeps the old last-frame-wins rule, so a return of that path cannot double
 * count. With no frame at all (non-streaming mode) the final output stands.
 */
export function createRunCostAccumulator(): {
  add(frame: RunCostFrame): void;
  total(final?: RunCostFrame): RunCost;
} {
  let codexFrames = 0;
  let usage: ContainerOutput['usage'] | undefined;
  let turns: number | undefined;
  let codexTurn: CodexTurnTelemetry | undefined;
  let legacyUsage: ContainerOutput['usage'] | undefined;
  let legacyTurns: number | undefined;
  const count = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    add(frame) {
      if (!frame.codexTurn) {
        if (frame.usage) legacyUsage = frame.usage;
        if (frame.turns !== undefined) legacyTurns = frame.turns;
        return;
      }
      codexFrames += 1;
      if (frame.usage) {
        const cacheCreation =
          usage?.cacheCreationInputTokens !== undefined ||
          frame.usage.cacheCreationInputTokens !== undefined
            ? count(usage?.cacheCreationInputTokens) +
              count(frame.usage.cacheCreationInputTokens)
            : undefined;
        const cacheRead =
          usage?.cacheReadInputTokens !== undefined ||
          frame.usage.cacheReadInputTokens !== undefined
            ? count(usage?.cacheReadInputTokens) +
              count(frame.usage.cacheReadInputTokens)
            : undefined;
        usage = {
          inputTokens: count(usage?.inputTokens) + count(frame.usage.inputTokens),
          outputTokens:
            count(usage?.outputTokens) + count(frame.usage.outputTokens),
          ...(cacheCreation !== undefined
            ? { cacheCreationInputTokens: cacheCreation }
            : {}),
          ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
        };
      }
      if (frame.turns !== undefined) turns = (turns ?? 0) + count(frame.turns);
      codexTurn = mergeCodexTurnTelemetry(codexTurn, frame.codexTurn);
    },
    total(final) {
      if (codexFrames > 0) {
        return {
          ...(usage ? { usage } : {}),
          ...(turns !== undefined ? { turns } : {}),
          ...(codexTurn ? { codexTurn } : {}),
        };
      }
      const finalUsage = final?.usage || legacyUsage;
      const finalTurns = final?.turns ?? legacyTurns;
      return {
        ...(finalUsage ? { usage: finalUsage } : {}),
        ...(finalTurns !== undefined ? { turns: finalTurns } : {}),
        ...(final?.codexTurn ? { codexTurn: final.codexTurn } : {}),
      };
    },
  };
}

const cliVersionByCommand = new Map<string, Promise<string | null>>();

type ExecVersion = (
  command: string,
  done: (err: Error | null, stdout: string) => void,
) => void;

const execVersion: ExecVersion = (command, done) => {
  execFile(
    command,
    ['--version'],
    {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    },
    (err, stdout) => done(err, String(stdout ?? '')),
  );
};

/**
 * The version of the codex CLI the host hands the runner. The runner names it
 * only for a thread the turn created: codex writes session_meta (with
 * cli_version) once, when it creates a thread, so a resumed thread's names
 * the CLI that created it, maybe days and an upgrade ago. «Sandbox agent
 * error» («workspace routing discovery failed») was once written without
 * a version, and which codex had failed could not be told afterwards (C41).
 * One `codex --version` per command and process while it answers; a null
 * (an error, a timeout) is not kept, so the next call asks again.
 */
export function codexCliVersionOnce(
  command: string | undefined,
  exec: ExecVersion = execVersion,
): Promise<string | null> {
  if (!command) return Promise.resolve(null);
  const cached = cliVersionByCommand.get(command);
  if (cached) return cached;
  const pending: Promise<string | null> = new Promise<string | null>((resolve) => {
    try {
      exec(command, (err, stdout) => {
        if (err) return resolve(null);
        resolve(/\b(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(stdout)?.[1] ?? null);
      });
    } catch {
      resolve(null);
    }
  }).then((version) => {
    if (version === null && cliVersionByCommand.get(command) === pending) {
      cliVersionByCommand.delete(command);
    }
    return version;
  });
  cliVersionByCommand.set(command, pending);
  return pending;
}

/**
 * The run's codex telemetry with the version of the CLI that ran: the
 * runner's (a thread the run created), else codexCliVersionOnce, waited for
 * at most `waitMs`. `cliVersion` is the same value for a log line, also when
 * the run left no telemetry.
 */
export async function withRunningCodexCliVersion(
  codexTurn: CodexTurnTelemetry | undefined,
  command: string | undefined,
  opts: { waitMs?: number; exec?: ExecVersion } = {},
): Promise<{ codexTurn: CodexTurnTelemetry | undefined; cliVersion: string | undefined }> {
  if (codexTurn?.codexCliVersion) {
    return { codexTurn, cliVersion: codexTurn.codexCliVersion };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const version = await Promise.race([
    codexCliVersionOnce(command, opts.exec),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), opts.waitMs ?? 3_000);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
  if (!version) return { codexTurn, cliVersion: undefined };
  return {
    codexTurn: codexTurn ? { ...codexTurn, codexCliVersion: version } : undefined,
    cliVersion: version,
  };
}

/** For tests: forget the versions read so far. */
export function _resetCodexCliVersionCache(): void {
  cliVersionByCommand.clear();
}

/** The one INFO line per turn: «tier=priority, effort=xhigh, used=47%». */
export function describeCodexTurnSettings(
  codexTurn: CodexTurnTelemetry | undefined,
): string {
  const tier =
    codexTurn?.serviceTier === undefined
      ? 'unknown'
      : (codexTurn.serviceTier ?? 'default');
  const asked =
    codexTurn?.requestedServiceTier === undefined
      ? ''
      : ` (asked ${codexTurn.requestedServiceTier ?? 'default'}${
          codexFastTierDropReason(codexTurn) === 'no_quota_reading'
            ? ', fast dropped: no quota reading'
            : codexTurn.fastTierDroppedForQuota
              ? ', fast dropped for quota'
              : ''
        })`;
  const effort = codexTurn?.reasoningEffort ?? 'unknown';
  const used =
    codexTurn?.accountUsedPercent === undefined ||
    codexTurn.accountUsedPercent === null
      ? '?'
      : String(codexTurn.accountUsedPercent);
  return `tier=${tier}${asked}, effort=${effort}, used=${used}%`;
}
