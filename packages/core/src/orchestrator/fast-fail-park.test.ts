import { describe, expect, it } from 'vitest';

import {
  FAST_FAIL_NOTICE_REPEAT_MS,
  FAST_FAIL_PARK_MAX_MS,
  FAST_FAIL_PARK_MS,
  clearFastFail,
  dueFastFailParks,
  fastFailNoticeDue,
  fastFailParkDelayMs,
  fastFailParkedNoticeText,
  fastFailRunDecision,
  fastFailSignature,
  getFastFailEntry,
  hasFastFailEntries,
  isInstantModelFailure,
  markFastFailNoticeSent,
  noteInstantFailure,
} from './fast-fail-park.js';

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      get: (key: string) => values.get(key),
      set: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  };
}

const instant = {
  status: 'error' as const,
  durationMs: 12,
  outputSentToUser: false,
};

describe('instant model failure (W05)', () => {
  it('is a failure in which the model never started', () => {
    expect(isInstantModelFailure(instant)).toBe(true);
    expect(isInstantModelFailure({ ...instant, durationMs: 1_999 })).toBe(true);
  });

  it('is not a slow failure, a failure after model work, or a success', () => {
    expect(isInstantModelFailure({ ...instant, durationMs: 2_000 })).toBe(false);
    expect(isInstantModelFailure({ ...instant, turns: 1 })).toBe(false);
    expect(isInstantModelFailure({ ...instant, modelRequests: 1 })).toBe(false);
    expect(isInstantModelFailure({ ...instant, inputTokens: 10 })).toBe(false);
    expect(isInstantModelFailure({ ...instant, outputTokens: 1 })).toBe(false);
    expect(isInstantModelFailure({ ...instant, providerResponded: true })).toBe(false);
    expect(isInstantModelFailure({ ...instant, sideEffected: true })).toBe(false);
    expect(isInstantModelFailure({ ...instant, outputSentToUser: true })).toBe(false);
    expect(isInstantModelFailure({ ...instant, status: 'success' })).toBe(false);
    expect(isInstantModelFailure({ ...instant, durationMs: undefined })).toBe(false);
  });

  it('treats errors that differ only in numbers and ids as one cause', () => {
    expect(fastFailSignature('spawn failed after 12ms (pid 4411)')).toBe(
      fastFailSignature('spawn failed after 7ms (pid 9)'),
    );
    expect(fastFailSignature('ECONNRESET')).not.toBe(fastFailSignature('spawn EACCES'));
    expect(fastFailSignature(undefined)).toBe('unknown');
  });
});

describe('fast-fail park (W05)', () => {
  const chat = 'tg:owner';
  const t0 = Date.parse('2026-03-10T16:17:29Z');

  it('parks the chat on the third instant failure in a row with the same cause', () => {
    const { store } = memoryStore();
    const note = (n: number) =>
      noteInstantFailure(store, chat, { signature: 'blocked', nowMs: t0 + n, cursor: 'i:0000000000000010' });
    expect(note(1).parkNow).toBe(false);
    expect(note(2).parkNow).toBe(false);
    const third = note(3);
    expect(third.parkNow).toBe(true);
    expect(third.firstPark).toBe(true);
    expect(third.entry.parkedCursor).toBe('i:0000000000000010');
  });

  it('starts counting anew when the cause changes, and clears on real work', () => {
    const { store } = memoryStore();
    noteInstantFailure(store, chat, { signature: 'a', nowMs: t0, cursor: 'i:0000000000000001' });
    noteInstantFailure(store, chat, { signature: 'a', nowMs: t0, cursor: 'i:0000000000000001' });
    expect(
      noteInstantFailure(store, chat, { signature: 'b', nowMs: t0, cursor: 'i:0000000000000001' }).parkNow,
    ).toBe(false);
    expect(getFastFailEntry(store, chat)?.count).toBe(1);
    expect(clearFastFail(store, chat)).toBe(true);
    expect(getFastFailEntry(store, chat)).toBeUndefined();
    expect(clearFastFail(store, chat)).toBe(false);
  });

  it('skips runs of a parked chat until a new message, then allows exactly one try', () => {
    const { store } = memoryStore();
    for (let i = 0; i < 3; i++) {
      noteInstantFailure(store, chat, { signature: 'x', nowMs: t0, cursor: 'i:0000000000000005' });
    }
    // An orphan retry or the same batch again: no run.
    expect(fastFailRunDecision(store, chat, { nowMs: t0 + 5_000, cursor: 'i:0000000000000005' })).toBe('skip');
    // A new message gets one try.
    expect(fastFailRunDecision(store, chat, { nowMs: t0 + 60_000, cursor: 'i:0000000000000007' })).toBe('retry_message');
    // Retrying that same batch again is parked again.
    expect(fastFailRunDecision(store, chat, { nowMs: t0 + 61_000, cursor: 'i:0000000000000007' })).toBe('skip');
    // The try failed instantly again: parked again, silently (firstPark false).
    const again = noteInstantFailure(store, chat, { signature: 'x', nowMs: t0 + 61_000, cursor: 'i:0000000000000007' });
    expect(again.parkNow).toBe(true);
    expect(again.firstPark).toBe(false);
  });

  it('lets the timer give one more try after 30 minutes', () => {
    const { store } = memoryStore();
    for (let i = 0; i < 3; i++) {
      noteInstantFailure(store, chat, { signature: 'x', nowMs: t0, cursor: 'i:0000000000000005' });
    }
    const idle = () => false;
    expect(dueFastFailParks(store, { nowMs: t0 + FAST_FAIL_PARK_MS - 1, isActive: idle })).toEqual([]);
    expect(dueFastFailParks(store, { nowMs: t0 + FAST_FAIL_PARK_MS, isActive: idle })).toEqual([chat]);
    // Not woken again on the next loop pass.
    expect(dueFastFailParks(store, { nowMs: t0 + FAST_FAIL_PARK_MS + 2_000, isActive: idle })).toEqual([]);
    expect(fastFailRunDecision(store, chat, { nowMs: t0 + FAST_FAIL_PARK_MS + 3_000, cursor: 'i:0000000000000005' })).toBe('retry_timer');
    expect(fastFailRunDecision(store, chat, { nowMs: t0 + FAST_FAIL_PARK_MS + 4_000, cursor: 'i:0000000000000005' })).toBe('skip');
  });

  it('spaces the timer attempts out: 30 min, 1 h, 2 h, then every 4 h (review r1108)', () => {
    expect(fastFailParkDelayMs()).toBe(FAST_FAIL_PARK_MS);
    expect([1, 2, 3, 4, 50].map(fastFailParkDelayMs)).toEqual([
      60 * 60_000, 120 * 60_000, FAST_FAIL_PARK_MAX_MS, FAST_FAIL_PARK_MAX_MS, FAST_FAIL_PARK_MAX_MS,
    ]);
    expect(fastFailParkDelayMs(Number.NaN)).toBe(FAST_FAIL_PARK_MS);
    const { store } = memoryStore();
    const fail = (nowMs: number) =>
      noteInstantFailure(store, chat, { signature: 'x', nowMs, cursor: 'i:0000000000000005' });
    for (let i = 0; i < 3; i++) fail(t0);
    const idle = () => false;
    let now = t0;
    const wakes: number[] = [];
    // Eight hours, checked every minute; each attempt fails at once again.
    for (let minute = 1; minute <= 8 * 60; minute++) {
      now = t0 + minute * 60_000;
      if (dueFastFailParks(store, { nowMs: now, isActive: idle }).length === 0) continue;
      expect(fastFailRunDecision(store, chat, { nowMs: now, cursor: 'i:0000000000000005' })).toBe('retry_timer');
      fail(now);
      wakes.push(minute);
    }
    expect(wakes).toEqual([30, 90, 210, 450]);
    expect(getFastFailEntry(store, chat)?.timerRounds).toBe(4);
  });

  it('sends the park notice once per series: never again on a timer attempt, on a new message only hours later (review r1108)', () => {
    const { store } = memoryStore();
    const fail = (nowMs: number) =>
      noteInstantFailure(store, chat, { signature: 'x', nowMs, cursor: 'i:0000000000000005' });
    fail(t0);
    fail(t0);
    const parked = fail(t0);
    expect(fastFailNoticeDue(parked.entry, { nowMs: t0, attempt: 'run' })).toBe(true);
    markFastFailNoticeSent(store, chat, t0);
    // The mark stays with the series through the next failures.
    const again = fail(t0 + FAST_FAIL_PARK_MS);
    expect(again.entry.noticeAt).toBe(new Date(t0).toISOString());
    for (const attempt of ['run', 'retry_timer'] as const) {
      expect(fastFailNoticeDue(again.entry, { nowMs: t0 + 10 * FAST_FAIL_NOTICE_REPEAT_MS, attempt })).toBe(false);
    }
    expect(fastFailNoticeDue(again.entry, {
      nowMs: t0 + FAST_FAIL_NOTICE_REPEAT_MS - 1, attempt: 'retry_message',
    })).toBe(false);
    expect(fastFailNoticeDue(again.entry, {
      nowMs: t0 + FAST_FAIL_NOTICE_REPEAT_MS, attempt: 'retry_message',
    })).toBe(true);
    // Real work ends the series and its mark.
    clearFastFail(store, chat);
    for (let i = 0; i < 3; i++) fail(t0 + 2 * FAST_FAIL_NOTICE_REPEAT_MS);
    expect(getFastFailEntry(store, chat)?.noticeAt).toBeUndefined();
    // A different cause before a park starts a new series without the mark.
    markFastFailNoticeSent(store, 'tg:other', t0);
    expect(getFastFailEntry(store, 'tg:other')).toBeUndefined();
  });

  it('does not wake a chat that has a run in progress', () => {
    const { store } = memoryStore();
    for (let i = 0; i < 3; i++) {
      noteInstantFailure(store, chat, { signature: 'x', nowMs: t0, cursor: 'i:0000000000000005' });
    }
    expect(dueFastFailParks(store, { nowMs: t0 + FAST_FAIL_PARK_MS, isActive: () => true })).toEqual([]);
  });

  it('runs a chat that is not parked and reports no entries when empty', () => {
    const { store } = memoryStore();
    expect(hasFastFailEntries(store)).toBe(false);
    expect(fastFailRunDecision(store, chat, { nowMs: t0, cursor: 'i:0000000000000001' })).toBe('run');
    noteInstantFailure(store, chat, { signature: 'x', nowMs: t0, cursor: 'i:0000000000000001' });
    expect(hasFastFailEntries(store)).toBe(true);
    expect(fastFailRunDecision(store, chat, { nowMs: t0, cursor: 'i:0000000000000001' })).toBe('run');
  });

  it('ignores a corrupt record instead of holding a chat forever', () => {
    const store = { get: () => '{"tg:owner":{"count":"x"}}', set: () => undefined };
    expect(fastFailRunDecision(store, chat, { nowMs: t0, cursor: 'i:0000000000000001' })).toBe('run');
  });
});

describe('fast-fail park notice (W05)', () => {
  it('says plainly what happened and what comes next', () => {
    const text = fastFailParkedNoticeText();
    expect(text).toContain('Не могу запустить модель');
    expect(text).toContain('сообщения сохранены');
    expect(text).toContain('через 30 минут');
    expect(text).not.toContain('черновик');
  });

  it('names the real next timer attempt, not always 30 minutes', () => {
    expect(fastFailParkedNoticeText(null, fastFailParkDelayMs(0))).toContain('через 30 минут');
    expect(fastFailParkedNoticeText(null, fastFailParkDelayMs(1))).toContain('через час');
    expect(fastFailParkedNoticeText(null, fastFailParkDelayMs(2))).toContain('через пару часов');
    for (const rounds of [3, 4, 8]) {
      const text = fastFailParkedNoticeText(null, fastFailParkDelayMs(rounds));
      expect(text).toContain('через несколько часов');
      expect(text).not.toContain('30 минут');
    }
  });

  it('adds the unsent draft marked as unchecked, cut to a sane length', () => {
    const text = fastFailParkedNoticeText('Скуби запущен на ноутбуке. ' + 'слово '.repeat(2000));
    expect(text).toContain('неотправленный черновик');
    expect(text).toContain('не проверен с учётом твоих последних сообщений');
    expect(text).toContain('Скуби запущен на ноутбуке.');
    expect(text.length).toBeLessThan(3_600);
    expect(text.endsWith('…')).toBe(true);
  });
});
