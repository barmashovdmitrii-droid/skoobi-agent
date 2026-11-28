import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetCodexCliVersionCache,
  CODEX_ACCOUNT_READING_MAX_AGE_MS,
  codexAccountUsedPercentAcrossHomes,
  codexCliVersionOnce,
  codexFastAppliedUnrequested,
  codexFastTierDropReason,
  codexServiceTierForReading,
  codexTierMismatch,
  codexTurnTracePayload,
  createRunCostAccumulator,
  describeCodexTurnSettings,
  lastCodexRateLimits,
  mergeCodexTurnTelemetry,
  scheduledTaskFinishedPayload,
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

it('attributes the final turn to its own observed model, including missing observations', () => {
  const first = { requestedModel: 'first-config', observedModel: 'first-runtime' };
  const second = { requestedModel: 'second-config', observedModel: 'second-runtime' };
  expect(codexTurnTracePayload(mergeCodexTurnTelemetry(first, second))).toMatchObject({
    requested_model: 'second-config', effective_model: 'second-runtime',
  });
  const missing = codexTurnTracePayload(mergeCodexTurnTelemetry(first, { requestedModel: 'second-config' }));
  expect(missing.requested_model).toBe('second-config');
  expect(missing).not.toHaveProperty('effective_model');
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
    // A guest thread ran last and saw 72 %; the owner's home still says 40 %.
    writeRollout(
      path.join(dataDir, 'codex-homes', 'telegram_main'),
      'owner',
      [tokenCount('2026-10-09T08:00:00.000Z', 40)],
      new Date(now - 2 * 3_600_000),
    );
    writeRollout(
      path.join(dataDir, 'codex-homes', 'telegram_guest'),
      'guest',
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
    ).toEqual({
      at: '2026-10-09T09:41:00.000Z',
      usedPercent: 62,
      // Review r1111 (turn-2): the snapshot's windows come along.
      windows: [{ usedPercent: 62, windowMinutes: 10080 }],
    });
  });
});

describe('codexAccountUsedPercentAcrossHomes: a reading is fresh by its own time (r1110)', () => {
  // A fixed clock: a new thread asked for Fast with the quota at 95 %.
  const now = Date.parse('2026-11-09T12:15:32Z');
  let dataDir: string;
  let userHome: string;
  let seq = 0;

  const sessionMeta = (iso: string) =>
    JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id: 'fixture' } });
  /** A token_count line without a readable time of its own. */
  const tokenCountAt = (timestamp: unknown, primary: number) => {
    const row = JSON.parse(tokenCount('2026-01-01T00:00:00.000Z', primary));
    if (timestamp === undefined) delete row.timestamp;
    else row.timestamp = timestamp;
    return JSON.stringify(row);
  };
  /** `stamp` as in codex's file names: 2026-11-09T16-52-27. */
  const writeRollout = (
    home: string,
    stamp: string,
    lines: string[],
    mtime: Date | string | number,
    ext = '.jsonl',
  ) => {
    const [y, m, d] = stamp.slice(0, 10).split('-');
    const dir = path.join(home, 'sessions', y, m, d);
    fs.mkdirSync(dir, { recursive: true });
    seq += 1;
    const file = path.join(dir, `rollout-${stamp}-fixture-${seq}${ext}`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const time = new Date(mtime);
    fs.utimesSync(file, time, time);
    return file;
  };
  const botHome = () => path.join(dataDir, 'codex-homes', 'telegram_main');
  const read = (extra: Partial<Parameters<typeof codexAccountUsedPercentAcrossHomes>[0]> = {}) =>
    codexAccountUsedPercentAcrossHomes({
      dataDir,
      userCodexHome: userHome,
      now,
      readingTtlMs: 0,
      ...extra,
    });

  /**
   * ~/.codex and a chat's CODEX_HOME during an outage as far as the
   * reading goes: Codex Desktop touched an old session at 16:50 (its newest
   * snapshot: 24 %), and after the reboot the canary (every 7 minutes) and
   * the bot's new threads wrote rollouts without a single token_count. The
   * July session is the 7th newest file.
   */
  const writeOutageSilence = () => {
    writeRollout(
      userHome,
      '2026-07-18T19-06-19',
      [tokenCount('2026-07-18T14:06:32.879Z', 19), tokenCount('2026-07-18T14:58:38.637Z', 24)],
      '2026-11-09T11:50:01Z',
    );
    for (const [stamp, mtime] of [
      ['2026-11-09T16-50-59', '2026-11-09T11:51:29Z'],
      ['2026-11-09T16-58-03', '2026-11-09T11:58:33Z'],
      ['2026-11-09T17-05-05', '2026-11-09T12:05:35Z'],
      ['2026-11-09T17-12-08', '2026-11-09T12:12:38Z'],
    ]) {
      writeRollout(userHome, stamp, [sessionMeta(mtime)], mtime);
    }
    for (const [stamp, mtime] of [
      ['2026-11-09T16-40-27', '2026-11-09T11:44:00Z'],
      ['2026-11-09T16-44-21', '2026-11-09T11:47:53Z'],
      ['2026-11-09T16-48-18', '2026-11-09T11:51:52Z'],
      ['2026-11-09T16-52-27', '2026-11-09T12:15:17Z'],
    ]) {
      writeRollout(botHome(), stamp, [sessionMeta(mtime)], mtime);
    }
  };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acct-r1110-data-'));
    userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acct-r1110-user-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(userHome, { recursive: true, force: true });
  });

  it('an old session touched a moment ago and empty fresh rollouts give no reading (was 24 %)', () => {
    writeOutageSilence();
    expect(read()).toBeNull();
    // r1109, item 5: no reading — no Fast.
    expect(
      codexServiceTierForReading({ serviceTier: 'priority', serviceTierMaxUsedPercent: 70 }, read()),
    ).toEqual({ serviceTier: undefined, droppedReason: 'no_quota_reading' });
  });

  it('finds a fresh snapshot past the eight newest rollouts', () => {
    writeOutageSilence();
    // The last canary that got an answer before the outage (16:17) and an
    // older thread, both further back than the eight newest files.
    writeRollout(userHome, '2026-11-09T16-43-57', [sessionMeta('2026-11-09T11:44:27Z')], '2026-11-09T11:44:27Z');
    writeRollout(
      userHome,
      '2026-11-09T16-17-07',
      [sessionMeta('2026-11-09T11:17:07Z'), tokenCount('2026-11-09T11:17:12.111Z', 95)],
      '2026-11-09T11:17:12Z',
    );
    writeRollout(userHome, '2026-11-09T16-10-09', [sessionMeta('2026-11-09T11:10:09Z')], '2026-11-09T11:10:39Z');
    writeRollout(
      botHome(),
      '2026-11-03T13-14-21',
      [tokenCount('2026-11-09T10:33:05.366Z', 94)],
      '2026-11-09T11:02:06Z',
    );
    expect(read()).toBe(95);
    expect(
      codexServiceTierForReading({ serviceTier: 'priority', serviceTierMaxUsedPercent: 70 }, read()),
    ).toEqual({ serviceTier: undefined, droppedReason: 'quota_ceiling' });
  });

  it('gives codex_quota_status the snapshot\'s own time behind the percent, cached too (W27)', () => {
    writeOutageSilence();
    writeRollout(
      userHome,
      '2026-11-09T16-17-07',
      [sessionMeta('2026-11-09T11:17:07Z'), tokenCount('2026-11-09T11:17:12.111Z', 95)],
      '2026-11-09T11:17:12Z',
    );
    const seen: Array<{ usedPercent: number; atMs: number }> = [];
    expect(read({ onReading: (reading) => seen.push(reading) })).toBe(95);
    // Review r1111 (turn-2): with the snapshot's windows (here without resets_at).
    expect(seen).toEqual([{
      usedPercent: 95, atMs: Date.parse('2026-11-09T11:17:12.111Z'),
      windows: [{ usedPercent: 95, windowMinutes: 10080 }],
    }]);
    // From the 60 s cache: the same time, not the moment of the cache.
    expect(read({ readingTtlMs: 60_000 })).toBe(95);
    expect(read({ readingTtlMs: 60_000, now: now + 30_000, onReading: (reading) => seen.push(reading) })).toBe(95);
    expect(seen[1]).toEqual(seen[0]);
    // No reading — no call.
    const none: unknown[] = [];
    expect(read({ now: now + 7 * 3_600_000, onReading: (reading) => none.push(reading) })).toBeNull();
    expect(none).toEqual([]);
  });

  // Review r1111 (turn-2): the host passed only the percent and its time; after
  // a weekly reset the tool named the old 97 % to a chat without a snapshot
  // of its own (a guest's, almost always).
  it('passes the snapshot\'s windows with their reset times, from the cache too (turn-2)', () => {
    writeOutageSilence();
    const row = JSON.parse(tokenCount('2026-11-09T11:17:12.111Z', 97, 40));
    row.payload.rate_limits.primary.resets_at = 1_794_482_241;
    row.payload.rate_limits.secondary.resets_at = 1_794_470_000;
    writeRollout(userHome, '2026-11-09T16-17-07', [sessionMeta('2026-11-09T11:17:07Z'), JSON.stringify(row)], '2026-11-09T11:17:12Z');
    const seen: Array<{ windows?: unknown }> = [];
    expect(read({ onReading: (reading) => seen.push(reading) })).toBe(97);
    expect(seen[0].windows).toEqual([
      { usedPercent: 97, windowMinutes: 10080, resetsAtMs: 1_794_482_241_000 },
      { usedPercent: 40, windowMinutes: 300, resetsAtMs: 1_794_470_000_000 },
    ]);
    expect(read({ readingTtlMs: 60_000, now: now + 30_000, onReading: (reading) => seen.push(reading) })).toBe(97);
    expect(seen[1]).toEqual(seen[0]);
  });

  it('keeps reading while an older file may still hold a newer snapshot', () => {
    for (let i = 0; i < 8; i += 1) {
      writeRollout(userHome, '2026-11-09T17-00-00', [sessionMeta('2026-11-09T12:00:00Z')], now - (i + 1) * 60_000);
    }
    // The newer file's last snapshot is older than the older file's: the
    // newest snapshot counts, not the first one found.
    writeRollout(botHome(), '2026-11-09T16-00-00', [tokenCount(new Date(now - 50 * 60_000).toISOString(), 70)], now - 20 * 60_000);
    writeRollout(botHome(), '2026-11-09T16-10-00', [tokenCount(new Date(now - 35 * 60_000).toISOString(), 75)], now - 30 * 60_000);
    expect(read()).toBe(75);
  });

  it('judges a snapshot by its own time, not by the file\'s mtime', () => {
    const maxAge = CODEX_ACCOUNT_READING_MAX_AGE_MS;
    const file = writeRollout(
      botHome(),
      '2026-11-09T06-00-00',
      [tokenCount(new Date(now - maxAge - 1).toISOString(), 40)],
      now - 60_000,
    );
    expect(read()).toBeNull();
    fs.writeFileSync(file, tokenCount(new Date(now - maxAge).toISOString(), 40) + '\n');
    fs.utimesSync(file, new Date(now - 60_000), new Date(now - 60_000));
    expect(read()).toBe(40);
  });

  it('a snapshot from the future is no reading; a few minutes ahead is clock jitter', () => {
    writeRollout(botHome(), '2026-11-09T17-14-00', [tokenCount(new Date(now + 3_600_000).toISOString(), 12)], now - 60_000);
    expect(read()).toBeNull();
    writeRollout(botHome(), '2026-11-09T17-10-00', [tokenCount(new Date(now - 5 * 60_000).toISOString(), 80)], now - 5 * 60_000);
    expect(read()).toBe(80);
    // Within one file the last snapshot with a believable time counts.
    writeRollout(
      userHome,
      '2026-11-09T17-15-10',
      [tokenCount(new Date(now - 60_000).toISOString(), 82), tokenCount(new Date(now + 2 * 3_600_000).toISOString(), 3)],
      now - 30_000,
    );
    expect(read()).toBe(82);
    writeRollout(userHome, '2026-11-09T17-15-00', [tokenCount(new Date(now + 5 * 60_000).toISOString(), 81)], now - 10_000);
    expect(read()).toBe(81);
  });

  it('a snapshot without a readable time is no reading', () => {
    writeRollout(botHome(), '2026-11-09T17-00-00', [tokenCountAt(undefined, 30)], now - 60_000);
    expect(read()).toBeNull();
    writeRollout(botHome(), '2026-11-09T17-01-00', [tokenCountAt('вчера', 31)], now - 50_000);
    expect(read()).toBeNull();
    writeRollout(
      botHome(),
      '2026-11-09T17-02-00',
      [tokenCount(new Date(now - 10 * 60_000).toISOString(), 61), tokenCountAt(undefined, 32)],
      now - 40_000,
    );
    expect(read()).toBe(61);
  });

  it('skips sessions codex Desktop compressed (.jsonl.zst)', () => {
    writeRollout(
      userHome,
      '2026-07-18T10-48-42',
      [tokenCount(new Date(now - 60_000).toISOString(), 33)],
      now - 60_000,
      '.jsonl.zst',
    );
    expect(read()).toBeNull();
  });

  it('stops the walk at its file and byte caps', () => {
    for (let i = 0; i < 12; i += 1) {
      writeRollout(botHome(), '2026-11-09T17-00-00', [sessionMeta('2026-11-09T12:00:00Z')], now - (i + 1) * 60_000);
    }
    writeRollout(userHome, '2026-11-09T16-00-00', [tokenCount(new Date(now - 30 * 60_000).toISOString(), 77)], now - 30 * 60_000);
    expect(read()).toBe(77);
    expect(read({ maxScanFiles: 12 })).toBeNull();
    expect(read({ maxScanFiles: 13 })).toBe(77);
    expect(read({ maxScanBytes: 1 })).toBeNull();
  });

  it('stops the walk at a file last written before the newest snapshot found', () => {
    // The fixture is impossible on purpose: the ninth file was last written
    // 20 min ago yet holds a snapshot of 30 s ago. Only so does a file the
    // walk should have left unread show in the result — in real files a
    // snapshot is never newer than the file's mtime, and any honest fixture
    // gives the same answer with and without the stop. The stop keeps the
    // walk at the eight newest files, as before r1110, instead of every
    // rollout of the 6 h window once a minute.
    writeRollout(botHome(), '2026-11-09T17-14-00', [tokenCount(new Date(now - 60_000).toISOString(), 50)], now - 60_000);
    for (let i = 0; i < 7; i += 1) {
      writeRollout(userHome, '2026-11-09T17-00-00', [sessionMeta('2026-11-09T12:00:00Z')], now - (i + 2) * 60_000);
    }
    writeRollout(userHome, '2026-11-09T16-55-00', [tokenCount(new Date(now - 30_000).toISOString(), 99)], now - 20 * 60_000);
    expect(read()).toBe(50);
    // The newest few are read in any case: with minFiles 9 the ninth is too.
    expect(read({ minFiles: 9 })).toBe(99);
  });

  describe('a degenerate snapshot is no reading (so before r1110 as well)', () => {
    /**
     * A snapshot codex once wrote into a thread between two of 45 %:
     * the window's length 0, used 0 %,
     * resets_at about the snapshot's own time.
     */
    const degenerateTokenCount = (timestamp: string) =>
      JSON.stringify({
        timestamp,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 1 } },
          rate_limits: {
            limit_id: 'codex',
            limit_name: null,
            primary: {
              used_percent: 0.0,
              window_minutes: 0,
              resets_at: Math.floor(Date.parse(timestamp) / 1000) - 7,
            },
            secondary: null,
            plan_type: 'promax',
          },
        },
      });
    const windowsTokenCount = (timestamp: string, primary: unknown, secondary: unknown) =>
      JSON.stringify({
        timestamp,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 1 } },
          rate_limits: { limit_id: 'codex', primary, secondary },
        },
      });
    const iso = (ms: number) => new Date(ms).toISOString();

    it('the snapshot before it counts — was 0 % and Fast at a real 85 %', () => {
      const lines = [tokenCount(iso(now - 16_000), 85), degenerateTokenCount(iso(now - 7_000))];
      writeRollout(botHome(), '2026-11-03T13-14-21', lines, now - 7_000);
      expect(read()).toBe(85);
      expect(lastCodexRateLimits(lines.join('\n'), { now })).toMatchObject({
        at: iso(now - 16_000),
        usedPercent: 85,
      });
      expect(
        codexServiceTierForReading({ serviceTier: 'priority', serviceTierMaxUsedPercent: 70 }, read()),
      ).toEqual({ serviceTier: undefined, droppedReason: 'quota_ceiling' });
    });

    it('a rollout with only a degenerate snapshot is no reading; another home still says', () => {
      writeRollout(botHome(), '2026-11-09T17-15-00', [degenerateTokenCount(iso(now - 7_000))], now - 7_000);
      expect(read()).toBeNull();
      expect(
        codexServiceTierForReading({ serviceTier: 'priority', serviceTierMaxUsedPercent: 70 }, read()),
      ).toEqual({ serviceTier: undefined, droppedReason: 'no_quota_reading' });
      writeRollout(
        path.join(dataDir, 'codex-homes', 'telegram_guest'),
        '2026-11-09T17-13-00',
        [tokenCount(iso(now - 2 * 60_000), 85)],
        now - 2 * 60_000,
      );
      expect(read()).toBe(85);
    });

    it('a window without a number is no reading; a window without a length still is', () => {
      const cases: Array<[string, unknown, unknown, number | null]> = [
        ['used_percent null', { used_percent: null, window_minutes: 10080 }, null, null],
        ['primary null, secondary 88', null, { used_percent: 88, window_minutes: 300 }, 88],
        ['no window_minutes', { used_percent: 40 }, null, 40],
        [
          'degenerate primary, weekly secondary',
          { used_percent: 0, window_minutes: 0 },
          { used_percent: 86, window_minutes: 10080 },
          86,
        ],
      ];
      for (const [name, primary, secondary, expected] of cases) {
        fs.rmSync(path.join(dataDir, 'codex-homes'), { recursive: true, force: true });
        writeRollout(
          botHome(),
          '2026-11-09T17-14-00',
          [windowsTokenCount(iso(now - 60_000), primary, secondary)],
          now - 60_000,
        );
        expect({ name, reading: read() }).toEqual({ name, reading: expected });
      }
    });
  });
});

describe('codexTurnTracePayload / describeCodexTurnSettings', () => {
  it('records why the runner did not retry an overload or link failure (W10)', () => {
    expect(codexTurnTracePayload({ transientRetrySkipped: 'acted:command_execution' }))
      .toEqual({ transient_retry_skipped: 'acted:command_execution' });
    expect(codexTurnTracePayload({ modelRequests: 1 })).not.toHaveProperty('transient_retry_skipped');
  });

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
      // r1109: the reason is named; a runner from before r1109 sends none —
      // it dropped Fast at the ceiling only.
      fast_tier_dropped_reason: 'quota_ceiling',
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

  it('marks tier_mismatch when Fast was asked for and codex applied the settings without it (W02)', () => {
    // A resumed thread on codex 0.166.
    const resumed = {
      requestedServiceTier: 'priority' as const,
      serviceTier: null,
      threadServiceTier: null,
      reasoningEffort: 'xhigh',
      accountUsedPercent: 89,
    };
    expect(codexTierMismatch(resumed)).toBe(true);
    expect(codexTurnTracePayload(resumed)).toEqual({
      requested_service_tier: 'priority',
      service_tier: null,
      reasoning_effort: 'xhigh',
      used_percent: 89,
      thread_requested_service_tier: null,
      tier_mismatch: true,
    });
    // Any other applied tier is not Fast either.
    expect(
      codexTierMismatch({ requestedServiceTier: 'priority', serviceTier: 'flex' }),
    ).toBe(true);
    // The INFO line keeps its format: the log is grepped by that text.
    expect(describeCodexTurnSettings(resumed)).toBe(
      'tier=default (asked priority), effort=xhigh, used=89%',
    );
  });

  it('claims no mismatch when Fast was applied, not asked for, or not observed', () => {
    const applied = {
      requestedServiceTier: 'priority' as const,
      serviceTier: 'priority',
      threadServiceTier: 'priority' as const,
    };
    expect(codexTierMismatch(applied)).toBe(false);
    expect(codexTurnTracePayload(applied)).toEqual({
      requested_service_tier: 'priority',
      service_tier: 'priority',
      thread_requested_service_tier: 'priority',
    });
    // Dropped for quota: Fast was not asked for this turn.
    expect(
      codexTierMismatch({
        requestedServiceTier: null,
        serviceTier: null,
        fastTierDroppedForQuota: true,
      }),
    ).toBe(false);
    // Codex never reported its settings (no rollout): no evidence either way.
    expect(codexTierMismatch({ requestedServiceTier: 'priority' })).toBe(false);
    expect(codexTierMismatch(undefined)).toBe(false);
    // A thread older than the field: its tier is unknown, nothing is written.
    expect(
      codexTurnTracePayload({ requestedServiceTier: null, serviceTier: null }),
    ).toEqual({ requested_service_tier: null, service_tier: null });
    // A malformed value from the runner frame is not passed on.
    expect(
      codexTurnTracePayload({
        threadServiceTier: 'fast' as unknown as 'priority',
      }),
    ).toEqual({});
  });

  it('marks tier_mismatch on a resumed turn of a thread born with Fast that lost it (W02 variant B)', () => {
    const resumed = {
      requestedServiceTier: 'priority' as const,
      serviceTier: null,
      threadServiceTier: 'priority' as const,
    };
    expect(codexTierMismatch(resumed)).toBe(true);
    expect(codexFastAppliedUnrequested(resumed)).toBe(false);
    expect(codexTurnTracePayload(resumed)).toEqual({
      requested_service_tier: 'priority',
      service_tier: null,
      thread_requested_service_tier: 'priority',
      tier_mismatch: true,
    });
  });

  it('marks fast_applied_unrequested when codex applied Fast the runner did not ask for (W02 variant A)', () => {
    // A thread born with Fast, the ceiling dropped Fast for this turn, and
    // codex kept it: the quota goes at the Fast rate past the ceiling.
    const kept = {
      requestedServiceTier: null,
      serviceTier: 'priority',
      fastTierDroppedForQuota: true,
      threadServiceTier: 'priority' as const,
      accountUsedPercent: 75,
    };
    expect(codexFastAppliedUnrequested(kept)).toBe(true);
    expect(codexTierMismatch(kept)).toBe(false);
    expect(codexTurnTracePayload(kept)).toEqual({
      requested_service_tier: null,
      service_tier: 'priority',
      used_percent: 75,
      fast_tier_dropped_for_quota: true,
      fast_tier_dropped_reason: 'quota_ceiling',
      thread_requested_service_tier: 'priority',
      fast_applied_unrequested: true,
    });
    // The INFO line already tells it apart; its format stays.
    expect(describeCodexTurnSettings(kept)).toBe(
      'tier=priority (asked default, fast dropped for quota), effort=unknown, used=75%',
    );
    // Fast off in .env, the thread still born with it: the same marker.
    expect(
      codexFastAppliedUnrequested({ requestedServiceTier: null, serviceTier: 'priority' }),
    ).toBe(true);
    // Asked for and applied, or nothing applied, or the request unknown.
    expect(
      codexFastAppliedUnrequested({ requestedServiceTier: 'priority', serviceTier: 'priority' }),
    ).toBe(false);
    expect(
      codexFastAppliedUnrequested({
        requestedServiceTier: null,
        serviceTier: null,
        fastTierDroppedForQuota: true,
      }),
    ).toBe(false);
    expect(codexFastAppliedUnrequested({ serviceTier: 'priority' })).toBe(false);
    expect(codexFastAppliedUnrequested(undefined)).toBe(false);
    expect(codexTurnTracePayload({ serviceTier: 'priority' })).toEqual({
      service_tier: 'priority',
    });
  });

  it('names the reason when Fast was not asked for without a fresh quota reading (r1109, item 5)', () => {
    // The first turn after ≥ 6 h of quiet: no reading, Fast not asked for.
    const unknown = {
      requestedServiceTier: null,
      serviceTier: null,
      accountUsedPercent: 41,
      fastTierDroppedForQuota: true,
      fastTierDroppedReason: 'no_quota_reading' as const,
    };
    expect(codexTurnTracePayload(unknown)).toEqual({
      requested_service_tier: null,
      service_tier: null,
      used_percent: 41,
      fast_tier_dropped_for_quota: true,
      fast_tier_dropped_reason: 'no_quota_reading',
    });
    expect(describeCodexTurnSettings(unknown)).toBe(
      'tier=default (asked default, fast dropped: no quota reading), effort=unknown, used=41%',
    );
    expect(codexFastTierDropReason(unknown)).toBe('no_quota_reading');
    // The ceiling keeps its words; a malformed reason reads as the ceiling.
    const ceiling = { ...unknown, fastTierDroppedReason: 'quota_ceiling' as const };
    expect(codexTurnTracePayload(ceiling).fast_tier_dropped_reason).toBe('quota_ceiling');
    expect(describeCodexTurnSettings(ceiling)).toBe(
      'tier=default (asked default, fast dropped for quota), effort=unknown, used=41%',
    );
    expect(
      codexFastTierDropReason({
        fastTierDroppedForQuota: true,
        fastTierDroppedReason: 'whatever' as unknown as 'quota_ceiling',
      }),
    ).toBe('quota_ceiling');
    // Not dropped: no reason, even if one is sent.
    expect(
      codexTurnTracePayload({
        requestedServiceTier: 'priority',
        fastTierDroppedReason: 'no_quota_reading',
      }),
    ).toEqual({ requested_service_tier: 'priority' });
    expect(codexFastTierDropReason(undefined)).toBeUndefined();
  });

  it('a thread born with Fast keeping it on a turn without a quota reading is not fast_applied_unrequested (r1109)', () => {
    // Variant A (W02): codex keeps the birth tier on resume. Counted, the
    // deadman would say «Fast работает, хотя снят (квота у потолка или Fast
    // выключен)» every morning after a quiet night — neither is true.
    const morning = {
      requestedServiceTier: null,
      serviceTier: 'priority',
      threadServiceTier: 'priority' as const,
      fastTierDroppedForQuota: true,
      fastTierDroppedReason: 'no_quota_reading' as const,
    };
    expect(codexFastAppliedUnrequested(morning)).toBe(false);
    expect(codexTierMismatch(morning)).toBe(false);
    // The payload still tells what happened.
    expect(codexTurnTracePayload(morning)).toEqual({
      requested_service_tier: null,
      service_tier: 'priority',
      fast_tier_dropped_for_quota: true,
      fast_tier_dropped_reason: 'no_quota_reading',
      thread_requested_service_tier: 'priority',
    });
    // At the ceiling it still is.
    expect(
      codexFastAppliedUnrequested({ ...morning, fastTierDroppedReason: 'quota_ceiling' }),
    ).toBe(true);
  });
});

describe('codexServiceTierForReading (artifact jobs; the runner decides the same)', () => {
  const fast = { serviceTier: 'priority', serviceTierMaxUsedPercent: 70 };

  it('keeps Fast below the ceiling and drops it at or above, as before', () => {
    expect(codexServiceTierForReading(fast, 40)).toEqual({ serviceTier: 'priority' });
    expect(codexServiceTierForReading(fast, 69.9)).toEqual({ serviceTier: 'priority' });
    expect(codexServiceTierForReading(fast, 70)).toEqual({
      serviceTier: undefined,
      droppedReason: 'quota_ceiling',
    });
    expect(codexServiceTierForReading({ serviceTier: 'priority' }, 80).droppedReason).toBe(
      'quota_ceiling',
    );
    expect(codexServiceTierForReading({ serviceTier: 'priority' }, 79).serviceTier).toBe('priority');
  });

  it('no fresh reading: no Fast unless the owner set the switch to priority (r1109, item 5)', () => {
    expect(codexServiceTierForReading(fast, null)).toEqual({
      serviceTier: undefined,
      droppedReason: 'no_quota_reading',
    });
    expect(
      codexServiceTierForReading({ ...fast, serviceTierUnknownQuota: 'standard' }, null),
    ).toEqual({ serviceTier: undefined, droppedReason: 'no_quota_reading' });
    expect(
      codexServiceTierForReading({ ...fast, serviceTierUnknownQuota: 'nonsense' }, null).serviceTier,
    ).toBeUndefined();
    expect(
      codexServiceTierForReading({ ...fast, serviceTierUnknownQuota: 'priority' }, null),
    ).toEqual({ serviceTier: 'priority' });
    expect(codexServiceTierForReading(fast, Number.NaN).serviceTier).toBeUndefined();
  });

  it('never asks for Fast when .env does not', () => {
    for (const used of [null, 0, 99]) {
      expect(codexServiceTierForReading({}, used)).toEqual({ serviceTier: undefined });
      expect(
        codexServiceTierForReading({ serviceTierUnknownQuota: 'priority' }, used),
      ).toEqual({ serviceTier: undefined });
    }
  });

  it('a rollout older than 6 h is no reading — the same age the runner uses', () => {
    expect(CODEX_ACCOUNT_READING_MAX_AGE_MS).toBe(6 * 3_600_000);
  });
});

describe('scheduledTaskFinishedPayload (r1109, п. 6)', () => {
  const base = {
    groupFolder: 'telegram_main',
    taskId: 'task-1',
    taskTitle: 'Сводка продаж',
    taskKind: 'background' as const,
    durationMs: 61_000,
    turns: 4,
  };

  it('records what the run asked for, what codex applied, the quota and the ceiling', () => {
    const payload = scheduledTaskFinishedPayload({
      ...base,
      status: 'success',
      configuredServiceTier: 'priority',
      serviceTierCeilingPercent: 70,
      usedPercentAtStart: 87,
      codexTurn: {
        usageSource: 'cumulative_first_turn',
        modelRequests: 4,
        requestedServiceTier: 'priority',
        serviceTier: 'priority',
        reasoningEffort: 'xhigh',
        accountUsedPercent: 88,
        codexCliVersion: '0.166.0',
        subagentTokens: 1200,
      },
    });
    expect(payload).toMatchObject({
      trigger: 'scheduled_task',
      group_folder: 'telegram_main',
      task_id: 'task-1',
      task_title: 'Сводка продаж',
      task_kind: 'background',
      status: 'success',
      duration_ms: 61_000,
      turns: 4,
      configured_service_tier: 'priority',
      service_tier_ceiling_percent: 70,
      used_percent_at_start: 87,
      usage_source: 'cumulative_first_turn',
      model_requests: 4,
      requested_service_tier: 'priority',
      service_tier: 'priority',
      reasoning_effort: 'xhigh',
      used_percent: 88,
      codex_cli_version: '0.166.0',
      // Same field as session_finished; the event store masks it.
      subagent_tokens: 1200,
    });
    expect(typeof payload.timestamp).toBe('string');
    expect(payload).not.toHaveProperty('fast_tier_dropped_for_quota');
    expect(payload).not.toHaveProperty('fast_applied_unrequested');
  });

  it('names a quota drop and Fast applied though not asked for', () => {
    const payload = scheduledTaskFinishedPayload({
      ...base,
      status: 'error',
      configuredServiceTier: 'priority',
      serviceTierCeilingPercent: 70,
      usedPercentAtStart: null,
      codexTurn: {
        usageSource: 'cumulative_first_turn',
        requestedServiceTier: null,
        serviceTier: 'priority',
        fastTierDroppedForQuota: true,
        accountUsedPercent: 93,
      },
    });
    expect(payload).toMatchObject({
      status: 'error',
      used_percent_at_start: null,
      requested_service_tier: null,
      service_tier: 'priority',
      fast_tier_dropped_for_quota: true,
      // A runner from before r1109 names no reason: it dropped Fast at the
      // ceiling only. One field name for chats and tasks (r1109, items 5–6).
      fast_tier_dropped_reason: 'quota_ceiling',
      fast_applied_unrequested: true,
    });
    expect(payload).not.toHaveProperty('fast_tier_drop_reason');
  });

  it('a task run without a fresh quota reading carries the reason of item 5 (r1109)', () => {
    // 05:00, nothing written for 6 h: Fast on in .env, not asked for.
    const quiet = scheduledTaskFinishedPayload({
      ...base,
      status: 'success',
      configuredServiceTier: 'priority',
      serviceTierCeilingPercent: 70,
      usedPercentAtStart: null,
      codexTurn: {
        usageSource: 'cumulative_first_turn',
        requestedServiceTier: null,
        fastTierDroppedForQuota: true,
        fastTierDroppedReason: 'no_quota_reading',
        accountUsedPercent: 93,
      },
    });
    expect(quiet).toMatchObject({
      used_percent_at_start: null,
      requested_service_tier: null,
      fast_tier_dropped_for_quota: true,
      fast_tier_dropped_reason: 'no_quota_reading',
    });
    expect(quiet).not.toHaveProperty('fast_tier_drop_reason');
    // The same as session_finished writes for such a chat turn.
    const chatTurn = codexTurnTracePayload({
      usageSource: 'cumulative_first_turn',
      requestedServiceTier: null,
      fastTierDroppedForQuota: true,
      fastTierDroppedReason: 'no_quota_reading',
      accountUsedPercent: 93,
    });
    for (const key of Object.keys(chatTurn)) {
      expect(quiet[key]).toEqual(chatTurn[key]);
    }
    // Codex kept Fast anyway: the fact is in the payload, but — as for a
    // chat turn — no fast_applied_unrequested for want of a reading only.
    const kept = scheduledTaskFinishedPayload({
      ...base,
      status: 'success',
      configuredServiceTier: 'priority',
      serviceTierCeilingPercent: 70,
      usedPercentAtStart: null,
      codexTurn: {
        usageSource: 'cumulative_first_turn',
        requestedServiceTier: null,
        serviceTier: 'priority',
        fastTierDroppedForQuota: true,
        fastTierDroppedReason: 'no_quota_reading',
        accountUsedPercent: 93,
      },
    });
    expect(kept).toMatchObject({
      service_tier: 'priority',
      fast_tier_dropped_reason: 'no_quota_reading',
    });
    expect(kept).not.toHaveProperty('fast_applied_unrequested');
  });

  it('Fast off in .env: no ceiling fields; no rollout seen: usage_source none', () => {
    const payload = scheduledTaskFinishedPayload({
      ...base,
      turns: undefined,
      status: 'cancelled',
      codexTurn: undefined,
    });
    expect(payload).toMatchObject({
      status: 'cancelled',
      turns: 0,
      configured_service_tier: null,
      usage_source: 'none',
    });
    expect(payload).not.toHaveProperty('service_tier_ceiling_percent');
    expect(payload).not.toHaveProperty('used_percent_at_start');
    expect(payload).not.toHaveProperty('service_tier');
    expect(payload).not.toHaveProperty('requested_service_tier');
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
    // 19.36 M + 6.32 M + 0.109 M; agent_runs kept 109 426 and turns = 1.
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
    // The drop reason (r1109): the later turn's when it dropped Fast itself,
    // else the earlier one's.
    expect(
      mergeCodexTurnTelemetry(
        { fastTierDroppedForQuota: true, fastTierDroppedReason: 'no_quota_reading' },
        { fastTierDroppedForQuota: true, fastTierDroppedReason: 'quota_ceiling' },
      ),
    ).toEqual({ fastTierDroppedForQuota: true, fastTierDroppedReason: 'quota_ceiling' });
    expect(
      mergeCodexTurnTelemetry(
        { fastTierDroppedForQuota: true, fastTierDroppedReason: 'no_quota_reading' },
        { requestedServiceTier: 'priority' },
      ),
    ).toEqual({
      requestedServiceTier: 'priority',
      fastTierDroppedForQuota: true,
      fastTierDroppedReason: 'no_quota_reading',
    });
    // The thread's birth tier: the later turn's, the earlier one's if unsaid.
    expect(
      mergeCodexTurnTelemetry(
        { threadServiceTier: null, modelRequests: 1 },
        { modelRequests: 1 },
      ),
    ).toEqual({ threadServiceTier: null, modelRequests: 2 });
    expect(
      mergeCodexTurnTelemetry(
        { threadServiceTier: null },
        { threadServiceTier: 'priority' },
      ),
    ).toEqual({ threadServiceTier: 'priority' });
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
    // M-G2.3a (r1111): who drove the screen — summed, and in session_finished.
    const screen = mergeCodexTurnTelemetry(
      { screenControlCommands: { cliclick: 2, osascript_chrome: 1 } },
      { screenControlCommands: { cliclick: 1, screencapture: 4 } },
    );
    expect(screen).toEqual({ screenControlCommands: { cliclick: 3, osascript_chrome: 1, screencapture: 4 } });
    expect(codexTurnTracePayload(screen!)).toEqual({
      screen_control_commands: { cliclick: 3, osascript_chrome: 1, screencapture: 4 },
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

it('keeps classified memory refusals separate through telemetry merge and event serialization', () => {
  const earlier = { toolErrorClassificationVersion: 1 as const,
    toolRejections: { mcp__claudeclaw__memory_state: 7 },
    toolErrors: { view_image: 1 } };
  const later = { toolErrorClassificationVersion: 1 as const,
    toolRejections: { mcp__claudeclaw__memory_state: 12 },
    toolErrors: { exec: 2 } };
  const merged = mergeCodexTurnTelemetry(earlier, later)!;
  expect(codexTurnTracePayload(merged)).toMatchObject({
    tool_error_classification_version: 1,
    tool_rejections: { mcp__claudeclaw__memory_state: 19 },
    tool_errors: { view_image: 1, exec: 2 },
  });
  const mixed = mergeCodexTurnTelemetry(earlier, { toolErrors: { exec: 2 } });
  expect(codexTurnTracePayload(mixed).tool_error_classification_version).toBeUndefined();
  const copy = mergeCodexTurnTelemetry(undefined, earlier)!;
  copy.toolRejections!.mcp__claudeclaw__memory_state = 1;
  expect(earlier.toolRejections.mcp__claudeclaw__memory_state).toBe(7);
});
