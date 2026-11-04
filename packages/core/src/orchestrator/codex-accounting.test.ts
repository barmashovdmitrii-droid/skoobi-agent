import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetCodexCliVersionCache,
  codexAccountUsedPercentAcrossHomes,
  codexCliVersionOnce,
  codexTurnTracePayload,
  createRunCostAccumulator,
  describeCodexTurnSettings,
  lastCodexRateLimits,
  mergeCodexTurnTelemetry,
  withRunningCodexCliVersion,
} from './codex-accounting.js';

const tokenCount = (
  timestamp: string,
  primary: number,
  secondary: number | null = null,
  limitId = 'codex',
) =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 1 } },
      rate_limits: {
        limit_id: limitId,
        primary: { used_percent: primary, window_minutes: 10080 },
        secondary: secondary === null ? null : { used_percent: secondary, window_minutes: 300 },
      },
    },
  });

describe('codexAccountUsedPercentAcrossHomes', () => {
  let dataDir: string;
  let userHome: string;
  const now = Date.parse('2026-10-09T10:00:00Z');

  const writeRollout = (
    sessionsRoot: string,
    name: string,
    lines: string[],
    mtime: Date,
  ) => {
    const dir = path.join(sessionsRoot, 'sessions', '2026', '10', '05');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-10-05T11-33-22-${name}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    fs.utimesSync(file, mtime, mtime);
    return file;
  };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acct-data-'));
    userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acct-user-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(userHome, { recursive: true, force: true });
  });

  it('takes the newest snapshot across every CODEX_HOME, not the group that asks', () => {
    writeRollout(
      path.join(dataDir, 'codex-homes', 'telegram_main'),
      'owner',
      [tokenCount('2026-10-09T08:00:00.000Z', 40)],
      new Date(now - 2 * 3_600_000),
    );
    writeRollout(
      path.join(dataDir, 'codex-homes', 'telegram_main'),
      'User A',
      [tokenCount('2026-10-09T09:30:00.000Z', 70), tokenCount('2026-10-09T09:55:00.000Z', 72)],
      new Date(now - 5 * 60_000),
    );
    expect(
      codexAccountUsedPercentAcrossHomes({ dataDir, userCodexHome: null, now }),
    ).toBe(72);
  });

  it('counts the user\'s own ~/.codex sessions and the larger of the limit windows', () => {
    writeRollout(
      path.join(dataDir, 'codex-homes', 'telegram_main'),
      'owner',
      [tokenCount('2026-10-09T09:00:00.000Z', 40)],
      new Date(now - 60 * 60_000),
    );
    // The synthetic user rollout is newer and has a larger short-window value.
    writeRollout(
      userHome,
      'canary',
      [tokenCount('2026-10-09T09:58:00.000Z', 44, 81)],
      new Date(now - 2 * 60_000),
    );
    expect(codexAccountUsedPercentAcrossHomes({ dataDir, userCodexHome: userHome, now })).toBe(81);
  });

  it('ignores stale rollouts, other limits and partial lines; null when nothing recent says', () => {
    writeRollout(
      path.join(dataDir, 'codex-homes', 'telegram_main'),
      'old',
      [tokenCount('2026-10-08T09:00:00.000Z', 95)],
      new Date(now - 25 * 3_600_000),
    );
    // readingTtlMs: 0 — this test is about the reading, not the memo.
    expect(
      codexAccountUsedPercentAcrossHomes({ dataDir, userCodexHome: null, now, readingTtlMs: 0 }),
    ).toBeNull();
    writeRollout(
      path.join(dataDir, 'codex-homes', 'telegram_main'),
      'fresh',
      [
        tokenCount('2026-10-09T09:40:00.000Z', 61),
        tokenCount('2026-10-09T09:41:00.000Z', 99, null, 'other-limit'),
        '{"timestamp":"2026-10-09T09:42:00.000Z","payload":{"rate_limits":{"primary":{"used_per',
      ],
      new Date(now - 60_000),
    );
    expect(
      codexAccountUsedPercentAcrossHomes({ dataDir, userCodexHome: null, now, readingTtlMs: 0 }),
    ).toBe(61);
    expect(
      codexAccountUsedPercentAcrossHomes({
        dataDir: path.join(dataDir, 'nowhere'),
        userCodexHome: null,
        now,
        readingTtlMs: 0,
      }),
    ).toBeNull();
  });

  it('serves one reading per minute and reads again after it', () => {
    const home = path.join(dataDir, 'codex-homes', 'telegram_main');
    writeRollout(home, 'first', [tokenCount('2026-10-09T09:50:00.000Z', 50)], new Date(now - 60_000));
    expect(codexAccountUsedPercentAcrossHomes({ dataDir, userCodexHome: null, now })).toBe(50);
    writeRollout(home, 'second', [tokenCount('2026-10-09T09:59:00.000Z', 55)], new Date(now - 10_000));
    // Within the window the earlier reading stands, the rollouts are not walked.
    expect(
      codexAccountUsedPercentAcrossHomes({ dataDir, userCodexHome: null, now: now + 30_000 }),
    ).toBe(50);
    expect(
      codexAccountUsedPercentAcrossHomes({ dataDir, userCodexHome: null, now: now + 61_000 }),
    ).toBe(55);
    // A caller that wants it fresh says so.
    writeRollout(home, 'third', [tokenCount('2026-10-09T09:59:30.000Z', 56)], new Date(now - 5_000));
    expect(
      codexAccountUsedPercentAcrossHomes({
        dataDir,
        userCodexHome: null,
        now: now + 62_000,
        readingTtlMs: 0,
      }),
    ).toBe(56);
  });

  it('lastCodexRateLimits returns the last usable snapshot of a chunk', () => {
    expect(lastCodexRateLimits('')).toBeNull();
    expect(
      lastCodexRateLimits(
        [tokenCount('2026-10-09T09:40:00.000Z', 61), tokenCount('2026-10-09T09:41:00.000Z', 62)].join('\n'),
      ),
    ).toEqual({ at: '2026-10-09T09:41:00.000Z', usedPercent: 62 });
  });
});

describe('codexTurnTracePayload / describeCodexTurnSettings', () => {
  it('maps the runner\'s telemetry to snake_case payload fields and one INFO line', () => {
    const codexTurn = {
      usageSource: 'turn_delta' as const,
      modelRequests: 6,
      requestedServiceTier: null,
      serviceTier: null,
      reasoningEffort: 'xhigh',
      accountUsedPercent: 71,
      fastTierDroppedForQuota: true,
      toolCalls: { exec_command: 4, view_image: 2 },
    };
    expect(codexTurnTracePayload(codexTurn)).toEqual({
      usage_source: 'turn_delta',
      model_requests: 6,
      requested_service_tier: null,
      service_tier: null,
      reasoning_effort: 'xhigh',
      used_percent: 71,
      fast_tier_dropped_for_quota: true,
      tool_calls: { exec_command: 4, view_image: 2 },
    });
    expect(describeCodexTurnSettings(codexTurn)).toBe(
      'tier=default (asked default, fast dropped for quota), effort=xhigh, used=71%',
    );
    expect(
      describeCodexTurnSettings({
        serviceTier: 'priority',
        requestedServiceTier: 'priority',
        reasoningEffort: 'xhigh',
        accountUsedPercent: 47,
      }),
    ).toBe('tier=priority (asked priority), effort=xhigh, used=47%');
    // A Claude turn, or a runner without CODEX_HOME: nothing is claimed.
    expect(codexTurnTracePayload(undefined)).toEqual({});
    expect(codexTurnTracePayload({})).toEqual({});
    expect(describeCodexTurnSettings(undefined)).toBe('tier=unknown, effort=unknown, used=?%');
  });
});

describe('createRunCostAccumulator / mergeCodexTurnTelemetry', () => {
  const turn = (
    inputTokens: number,
    outputTokens: number,
    cacheReadInputTokens: number,
    modelRequests: number,
    extra: Record<string, unknown> = {},
  ) => ({
    status: 'success' as const,
    result: 'answer',
    usage: { inputTokens, outputTokens, cacheReadInputTokens },
    turns: modelRequests,
    codexTurn: {
      usageSource: 'turn_delta' as const,
      modelRequests,
      ...extra,
    },
  });

  it('sums every codex turn of a run — run 6717 was three turns, recorded as the last', () => {

    const cost = createRunCostAccumulator();
    cost.add(
      turn(19_300_000, 60_000, 18_900_000, 41, {
        serviceTier: 'priority',
        accountUsedPercent: 52,
        toolCalls: { exec_command: 30, view_image: 4 },
      }),
    );
    cost.add({ status: 'heartbeat', result: null });
    cost.add(
      turn(6_300_000, 20_000, 6_100_000, 9, {
        serviceTier: null,
        toolCalls: { exec_command: 5 },
      }),
    );
    cost.add(turn(108_000, 1_426, 100_000, 1, { accountUsedPercent: 54 }));
    // Streaming mode: the final output carries nothing of its own.
    expect(cost.total({ status: 'success', result: null })).toEqual({
      usage: {
        inputTokens: 25_708_000,
        outputTokens: 81_426,
        cacheReadInputTokens: 25_100_000,
      },
      turns: 51,
      codexTurn: {
        usageSource: 'turn_delta',
        modelRequests: 51,
        // The newest observation wins — null (standard tier) included.
        serviceTier: null,
        accountUsedPercent: 54,
        toolCalls: { exec_command: 35, view_image: 4 },
      },
    });
  });

  it('counts a failed turn\'s frame and keeps the weaker usage source', () => {
    const cost = createRunCostAccumulator();
    cost.add({
      status: 'error',
      result: null,
      error: 'codex turn timed out after 1800000ms',
      usage: { inputTokens: 22_400_000, outputTokens: 110_000 },
      turns: 61,
      codexTurn: { usageSource: 'cumulative_first_turn', modelRequests: 61 },
    });
    cost.add(turn(1_000, 10, 0, 1));
    expect(cost.total()).toMatchObject({
      usage: { inputTokens: 22_401_000, outputTokens: 110_010, cacheReadInputTokens: 0 },
      turns: 62,
      codexTurn: { usageSource: 'cumulative_first_turn', modelRequests: 62 },
    });
  });

  it('keeps last-frame-wins for frames without codex telemetry (the legacy path repeats usage)', () => {
    // The Claude path sends a query's usage on its result frame and again on
    // the session-update frame: summing would double it.
    const legacyUsage = { inputTokens: 500, outputTokens: 50 };
    const cost = createRunCostAccumulator();
    cost.add({ status: 'success', result: 'hi', usage: legacyUsage, turns: 2 });
    cost.add({ status: 'success', result: null, usage: legacyUsage, turns: 2 });
    expect(cost.total({ status: 'success', result: null })).toEqual({
      usage: legacyUsage,
      turns: 2,
    });
    // Non-streaming mode: no frame was seen, the final output stands as is.
    const finalOnly = createRunCostAccumulator();
    expect(
      finalOnly.total({
        status: 'success',
        result: 'x',
        usage: { inputTokens: 7, outputTokens: 1 },
        turns: 1,
        codexTurn: { usageSource: 'turn_delta' },
      }),
    ).toEqual({
      usage: { inputTokens: 7, outputTokens: 1 },
      turns: 1,
      codexTurn: { usageSource: 'turn_delta' },
    });
    expect(createRunCostAccumulator().total()).toEqual({});
  });

  it('merges two turns\' telemetry: sums, newest settings, any fast-tier drop', () => {
    expect(
      mergeCodexTurnTelemetry(
        {
          usageSource: 'cumulative_counter_reset',
          modelRequests: 2,
          requestedServiceTier: 'priority',
          reasoningEffort: 'xhigh',
          fastTierDroppedForQuota: true,
          toolCalls: { a: 1 },
        },
        { usageSource: 'turn_delta', modelRequests: 3, requestedServiceTier: null, toolCalls: { a: 2, b: 1 } },
      ),
    ).toEqual({
      usageSource: 'cumulative_counter_reset',
      modelRequests: 5,
      requestedServiceTier: null,
      reasoningEffort: 'xhigh',
      fastTierDroppedForQuota: true,
      toolCalls: { a: 3, b: 1 },
    });
    expect(
      mergeCodexTurnTelemetry({ subagentTokens: 4_770_000 }, { modelRequests: 1 }),
    ).toEqual({ modelRequests: 1, subagentTokens: 4_770_000 });
    expect(codexTurnTracePayload({ subagentTokens: 4_770_000 })).toEqual({
      subagent_tokens: 4_770_000,
    });
    // Tool failures and timings: summed per tool, the longest script kept.
    const tools = mergeCodexTurnTelemetry(
      {
        toolErrors: { view_image: 1 },
        toolExitNonzero: 2,
        toolWallMsTotal: 1_000,
        toolWallMsMax: 800,
        codexCliVersion: '0.156.0',
      },
      { toolErrors: { view_image: 1, exec: 1 }, toolWallMsTotal: 3_000, toolWallMsMax: 3_000 },
    );
    expect(tools).toEqual({
      toolErrors: { view_image: 2, exec: 1 },
      toolExitNonzero: 2,
      toolWallMsTotal: 4_000,
      toolWallMsMax: 3_000,
      codexCliVersion: '0.156.0',
    });
    expect(codexTurnTracePayload(tools)).toEqual({
      tool_errors: { view_image: 2, exec: 1 },
      tool_exit_nonzero: 2,
      tool_wall_ms_total: 4_000,
      tool_wall_ms_max: 3_000,
      codex_cli_version: '0.156.0',
    });
    const only = { modelRequests: 1, toolCalls: { a: 1 } };
    const copy = mergeCodexTurnTelemetry(undefined, only)!;
    expect(copy).toEqual(only);
    copy.toolCalls!.a = 9;
    expect(only.toolCalls.a).toBe(1);
    expect(mergeCodexTurnTelemetry(undefined, undefined)).toBeUndefined();
  });
});

describe('codexCliVersionOnce', () => {
  afterEach(() => _resetCodexCliVersionCache());

  it('asks the CLI once per command and process, and survives a CLI that does not answer', async () => {
    const calls: string[] = [];
    const exec = (command: string, done: (err: Error | null, stdout: string) => void) => {
      calls.push(command);
      done(null, 'codex-cli 0.156.0\n');
    };
    expect(await codexCliVersionOnce('/opt/test/codex', exec)).toBe('0.156.0');
    expect(await codexCliVersionOnce('/opt/test/codex', exec)).toBe('0.156.0');
    expect(calls).toEqual(['/opt/test/codex']);
    expect(
      await codexCliVersionOnce('/opt/test/broken', (_c, done) => done(new Error('ENOENT'), '')),
    ).toBeNull();
    expect(
      await codexCliVersionOnce('/opt/test/throws', () => {
        throw new Error('spawn failed');
      }),
    ).toBeNull();
    expect(await codexCliVersionOnce(undefined, exec)).toBeNull();
  });

  it('does not keep a null: a CLI that did not answer is asked again', async () => {
    let answer: string | null = null;
    let calls = 0;
    const exec = (_command: string, done: (err: Error | null, stdout: string) => void) => {
      calls += 1;
      if (answer) done(null, `codex-cli ${answer}\n`);
      else done(new Error('timed out'), '');
    };
    expect(await codexCliVersionOnce('/opt/test/flaky', exec)).toBeNull();
    answer = '0.157.0';
    expect(await codexCliVersionOnce('/opt/test/flaky', exec)).toBe('0.157.0');
    expect(await codexCliVersionOnce('/opt/test/flaky', exec)).toBe('0.157.0');
    expect(calls).toBe(2);
  });
});

describe('withRunningCodexCliVersion', () => {
  afterEach(() => _resetCodexCliVersionCache());

  const answers =
    (version: string) => (_command: string, done: (err: Error | null, stdout: string) => void) =>
      done(null, `codex-cli ${version}\n`);

  it('keeps the runner\'s version of a thread the run created', async () => {
    let asked = false;
    const exec = (_command: string, done: (err: Error | null, stdout: string) => void) => {
      asked = true;
      done(null, 'codex-cli 0.156.0\n');
    };
    const res = await withRunningCodexCliVersion(
      { modelRequests: 1, codexCliVersion: '0.157.0' },
      '/opt/test/codex-run',
      { exec },
    );
    expect(res).toEqual({ codexTurn: { modelRequests: 1, codexCliVersion: '0.157.0' }, cliVersion: '0.157.0' });
    expect(asked).toBe(false);
  });

  it('names the running CLI for a resumed thread, whose head says nothing about it', async () => {
    // After a pin bump the resumed thread's session_meta still says the old
    // version; the runner leaves the field unset and the host asks the CLI.
    const res = await withRunningCodexCliVersion(
      { modelRequests: 2 },
      '/opt/test/codex-0.157.0',
      { exec: answers('0.157.0') },
    );
    expect(res).toEqual({ codexTurn: { modelRequests: 2, codexCliVersion: '0.157.0' }, cliVersion: '0.157.0' });
    // A run that left no telemetry still gets the version for its log line.
    expect(await withRunningCodexCliVersion(undefined, '/opt/test/codex-0.157.0')).toEqual({
      codexTurn: undefined,
      cliVersion: '0.157.0',
    });
  });

  it('waits for a slow CLI only so long, and has the answer for the next run', async () => {
    let finish: (() => void) | undefined;
    const exec = (_command: string, done: (err: Error | null, stdout: string) => void) => {
      finish = () => done(null, 'codex-cli 0.157.0\n');
    };
    const turn = { modelRequests: 1 };
    const started = Date.now();
    expect(await withRunningCodexCliVersion(turn, '/opt/test/codex-slow', { exec, waitMs: 20 })).toEqual({
      codexTurn: turn,
      cliVersion: undefined,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    finish?.();
    expect((await withRunningCodexCliVersion(turn, '/opt/test/codex-slow', { exec })).cliVersion).toBe('0.157.0');
    // No command, no version.
    expect(await withRunningCodexCliVersion(turn, undefined)).toEqual({ codexTurn: turn, cliVersion: undefined });
  });
});
