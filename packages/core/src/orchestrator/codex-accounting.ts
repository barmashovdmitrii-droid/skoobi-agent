import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  CodexTurnTelemetry,
  ContainerOutput,
} from '../runtimes/container-runner.js';




const ROLLOUT_TAIL_BYTES = 512 * 1024;
/** A rollout older than this says nothing about the limit now. */
const DEFAULT_MAX_ROLLOUT_AGE_MS = 6 * 3_600_000;
/** The newest rollouts whose tails are read (the deadman reads 8 as well). */
const DEFAULT_MAX_ROLLOUTS = 8;


const DEFAULT_READING_TTL_MS = 60_000;

const readingCache = new Map<string, { at: number; value: number | null }>();

interface RateLimitsSnapshot {
  /** The record's ISO timestamp — the newest snapshot wins, not the newest file. */
  at: string;
  usedPercent: number;
}

function walkRollouts(
  dir: string,
  out: Array<{ file: string; mtimeMs: number }>,
): void {
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
        out.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs });
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

/** The larger used_percent of the limit windows; null when none is a number. */
function usedPercentOf(rateLimits: unknown): number | null {
  const limits = rateLimits as
    | {
        limit_id?: unknown;
        primary?: { used_percent?: unknown } | null;
        secondary?: { used_percent?: unknown } | null;
      }
    | null
    | undefined;
  if (!limits || typeof limits !== 'object') return null;
  // Codex names the account limit `codex`; anything else is not this quota.
  if (limits.limit_id !== undefined && limits.limit_id !== 'codex') return null;
  const values = [limits.primary?.used_percent, limits.secondary?.used_percent]
    .map(Number)
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}

/** The last rate_limits snapshot in a chunk of a rollout file. */
export function lastCodexRateLimits(text: string): RateLimitsSnapshot | null {
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
    last = {
      at: typeof row.timestamp === 'string' ? row.timestamp : '',
      usedPercent,
    };
  }
  return last;
}

/**
 * How much of the shared ChatGPT account's Codex limit is used, per the
 * newest rate_limits snapshot across every CODEX_HOME under
 * `<dataDir>/codex-homes` and the user's own ~/.codex. Returns null when
 * there is no sufficiently recent rollout with rate-limit information.
 */
export function codexAccountUsedPercentAcrossHomes(opts: {
  dataDir: string;
  /** Default os.homedir()/.codex; null leaves the user's sessions out. */
  userCodexHome?: string | null;
  now?: number;
  maxAgeMs?: number;
  maxFiles?: number;
  /** 0 reads the rollouts every time. */
  readingTtlMs?: number;
}): number | null {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_ROLLOUT_AGE_MS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_ROLLOUTS;
  const readingTtlMs = opts.readingTtlMs ?? DEFAULT_READING_TTL_MS;
  const userHome =
    opts.userCodexHome === undefined
      ? path.join(os.homedir(), '.codex')
      : opts.userCodexHome;
  const cacheKey = `${opts.dataDir}\0${userHome ?? ''}`;
  const cached = readingCache.get(cacheKey);
  if (cached && readingTtlMs > 0 && now - cached.at < readingTtlMs && now >= cached.at) {
    return cached.value;
  }
  const value = readAccountUsedPercent({ dataDir: opts.dataDir, userHome, now, maxAgeMs, maxFiles });
  readingCache.set(cacheKey, { at: now, value });
  return value;
}

function readAccountUsedPercent(opts: {
  dataDir: string;
  userHome: string | null;
  now: number;
  maxAgeMs: number;
  maxFiles: number;
}): number | null {
  const { userHome, now, maxAgeMs, maxFiles } = opts;
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
  const files: Array<{ file: string; mtimeMs: number }> = [];
  for (const dir of sessionDirs) walkRollouts(dir, files);
  const recent = files
    .filter((entry) => now - entry.mtimeMs <= maxAgeMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles);
  let latest: RateLimitsSnapshot | null = null;
  for (const { file } of recent) {
    const tail = readTail(file, ROLLOUT_TAIL_BYTES);
    if (tail === null) continue;
    const found = lastCodexRateLimits(tail);
    if (found && (!latest || found.at > latest.at)) latest = found;
  }
  return latest ? latest.usedPercent : null;
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
  }
  if (codexTurn.toolCalls && Object.keys(codexTurn.toolCalls).length > 0) {
    out.tool_calls = { ...codexTurn.toolCalls };
  }
  if (codexTurn.subagentTokens) {
    out.subagent_tokens = codexTurn.subagentTokens;
  }

  // feeds the watchdog's daily notice and the panel; non-zero exits are for
  // reference only (grep with no match exits 1).
  if (codexTurn.toolErrors && Object.keys(codexTurn.toolErrors).length > 0) {
    out.tool_errors = { ...codexTurn.toolErrors };
  }
  if (codexTurn.toolExitNonzero) {
    out.tool_exit_nonzero = codexTurn.toolExitNonzero;
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
        }
      : undefined;
  }
  const out: CodexTurnTelemetry = {};
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
  ] as const) {
    const value = later[key] !== undefined ? later[key] : earlier[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  if (earlier.fastTierDroppedForQuota || later.fastTierDroppedForQuota) {
    out.fastTierDroppedForQuota = true;
  }
  const toolCalls = sumCounts(earlier.toolCalls, later.toolCalls);
  if (toolCalls && Object.keys(toolCalls).length > 0) out.toolCalls = toolCalls;
  const subagentTokens =
    (earlier.subagentTokens ?? 0) + (later.subagentTokens ?? 0);
  if (subagentTokens > 0) out.subagentTokens = subagentTokens;
  const toolErrors = sumCounts(earlier.toolErrors, later.toolErrors);
  if (toolErrors && Object.keys(toolErrors).length > 0) out.toolErrors = toolErrors;
  const toolExitNonzero =
    (earlier.toolExitNonzero ?? 0) + (later.toolExitNonzero ?? 0);
  if (toolExitNonzero > 0) out.toolExitNonzero = toolExitNonzero;
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
      : ` (asked ${codexTurn.requestedServiceTier ?? 'default'}${codexTurn.fastTierDroppedForQuota ? ', fast dropped for quota' : ''})`;
  const effort = codexTurn?.reasoningEffort ?? 'unknown';
  const used =
    codexTurn?.accountUsedPercent === undefined ||
    codexTurn.accountUsedPercent === null
      ? '?'
      : String(codexTurn.accountUsedPercent);
  return `tier=${tier}${asked}, effort=${effort}, used=${used}%`;
}
