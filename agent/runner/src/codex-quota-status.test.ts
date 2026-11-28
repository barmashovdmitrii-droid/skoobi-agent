import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { codexAccountReading, codexAccountUsedPercent } from './codex-exec.js';
import { codexQuotaStatus, parseCodexHostWindows } from './codex-quota-status.js';

// W27-ост (r1111): бот называл время сброса окна как факт, без оговорки
// «не позже, часто раньше», а сводки «сколько осталось» не было.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function home(lines: Array<{ at: number; rateLimits: unknown }>): string {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-status-'));
  roots.push(codexHome);
  const dir = path.join(codexHome, 'sessions', '2026', '11', '09');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-2026-11-09T10-00-00-quota.jsonl');
  fs.writeFileSync(file, lines.map(({ at, rateLimits }) => JSON.stringify({
    timestamp: new Date(at).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', info: {}, rate_limits: rateLimits },
  })).join('\n') + '\n');
  const last = new Date(Math.max(...lines.map(l => l.at)));
  fs.utimesSync(file, last, last);
  return codexHome;
}

const NOW = Date.parse('2026-11-09T16:45:00.000Z');
const WEEK_RESET = Date.parse('2026-11-12T11:17:21.000Z');

describe('codexAccountReading', () => {
  it('returns the newest snapshot with its windows, reset times and credits', () => {
    const codexHome = home([
      { at: NOW - 3_600_000, rateLimits: { limit_id: 'codex', primary: { used_percent: 90, window_minutes: 10080, resets_at: WEEK_RESET / 1000 } } },
      { at: NOW - 60_000, rateLimits: {
        limit_id: 'codex',
        primary: { used_percent: 96, window_minutes: 10080, resets_at: WEEK_RESET / 1000 },
        secondary: { used_percent: 0, window_minutes: 0, resets_at: NOW / 1000 },
        credits: { has_credits: true, unlimited: false, balance: '12.5' },
      } },
    ]);
    const reading = codexAccountReading(codexHome, { now: NOW });
    expect(reading).toEqual({
      usedPercent: 96,
      atMs: NOW - 60_000,
      // The degenerate window (0 minutes) is no reading (r1110).
      windows: [{ usedPercent: 96, windowMinutes: 10080, resetsAtMs: WEEK_RESET }],
      hasCredits: true,
    });
    // The percent alone stays what the fast-tier ceiling reads.
    expect(codexAccountUsedPercent(codexHome, { now: NOW })).toBe(96);
    expect(codexAccountReading(codexHome, { now: NOW + 7 * 3_600_000 })).toBeNull();
  });
});

describe('codexQuotaStatus', () => {
  const reading = {
    usedPercent: 96, atMs: NOW - 60_000,
    windows: [{ usedPercent: 96, windowMinutes: 10080, resetsAtMs: WEEK_RESET }],
    hasCredits: true,
  };

  it('says how much is left and gives the reset only as «не позже»', () => {
    const status = codexQuotaStatus({ local: reading, hostUsedPercent: 95, now: NOW, timeZone: 'Asia/Almaty' });
    expect(status).toMatchObject({
      known: true, usedPercent: 96, leftPercent: 4,
      readingAgeMinutes: 1,
      paidCreditsAfterLimit: true,
      windows: [{
        window: 'неделя', usedPercent: 96, leftPercent: 4,
        resetsNotLaterThanUtc: '2026-11-12T11:17:21.000Z',
      }],
    });
    expect(status.windows?.[0].resetsNotLaterThanLocal).toMatch(/12\.11.*16:17/);
    expect(status.howToSay).toContain('не позже');
    expect(status.howToSay).toContain('часто раньше');
    // No credit balance or other account details leave the tool.
    expect(JSON.stringify(status)).not.toContain('12.5');
  });

  it('without the host reading\'s time the larger percent counts', () => {
    expect(codexQuotaStatus({ local: reading, hostUsedPercent: 99, now: NOW }).usedPercent).toBe(99);
    const hostOnly = codexQuotaStatus({ local: null, hostUsedPercent: 70, now: NOW });
    expect(hostOnly).toMatchObject({ known: true, usedPercent: 70, leftPercent: 30, windows: [] });
    expect(hostOnly.howToSay).toContain('дату сброса не называй');
  });

  it('does not guess without a fresh reading', () => {
    const none = codexQuotaStatus({ local: null, hostUsedPercent: null, now: NOW });
    expect(none.known).toBe(false);
    expect(none.usedPercent).toBeUndefined();
    expect(none.howToSay).toContain('не называй');
  });

  it('a reset time already past is not offered as the next one', () => {
    const status = codexQuotaStatus({ local: { ...reading, windows: [{ usedPercent: 96, windowMinutes: 300, resetsAtMs: NOW - 1000 }] }, hostUsedPercent: null, now: NOW });
    expect(status.windows?.[0]).toMatchObject({ window: '5 часов', resetPassed: true });
    expect(status.windows?.[0].resetsNotLaterThanUtc).toBeUndefined();
  });

  // W27-1: недельное окно уже сбросилось. Снимок этого чата —
  // с прошлого хода (96 %, до сброса), у хоста тоже 96 % со старта хода.
  // Раньше инструмент велел сказать «использовано 96 %, осталось 4 %».
  it('after the window\'s reset the old percent, its own or the host\'s, is not reported', () => {
    const reset = WEEK_RESET;
    const before = { usedPercent: 96, atMs: reset - 2 * 3_600_000, windows: [{ usedPercent: 96, windowMinutes: 10080, resetsAtMs: reset }] };
    for (const hostReadByMs of [reset - 60_000, reset + 25 * 60_000, null]) {
      const status = codexQuotaStatus({ local: before, hostUsedPercent: 96, hostReadByMs, now: reset + 30 * 60_000 });
      expect(status.known).toBe(false);
      expect(status.usedPercent).toBeUndefined();
      expect(status.resetPassedSinceReading).toBe(true);
      expect(status.windows?.[0]).toEqual({ window: 'неделя', resetPassed: true });
      expect(status.howToSay).toContain('по сроку лимит уже обновился');
      expect(status.howToSay).not.toContain('96');
    }
    // A live window still counts; the one that reset does not.
    const mixed = codexQuotaStatus({
      local: { usedPercent: 96, atMs: reset - 3_600_000, windows: [
        { usedPercent: 96, windowMinutes: 300, resetsAtMs: reset },
        { usedPercent: 40, windowMinutes: 10080, resetsAtMs: reset + 86_400_000 },
      ] },
      hostUsedPercent: 96, hostReadByMs: reset - 60_000, now: reset + 60_000,
    });
    expect(mixed).toMatchObject({ known: true, usedPercent: 40, leftPercent: 60, resetPassedSinceReading: true });
    expect(mixed.howToSay).toContain('resetPassed');
  });

  it('the newer reading counts, not the larger: a fresh snapshot of this chat beats the host\'s from run start', () => {
    const runStart = NOW - 20 * 60_000;
    const fresh = { usedPercent: 1, atMs: NOW - 5_000, windows: [{ usedPercent: 1, windowMinutes: 10080, resetsAtMs: WEEK_RESET + 7 * 86_400_000 }] };
    const status = codexQuotaStatus({ local: fresh, hostUsedPercent: 96, hostReadByMs: runStart, now: NOW });
    expect(status).toMatchObject({ known: true, usedPercent: 1, leftPercent: 99, readingAgeMinutes: 0 });
    expect(status.howToSay).toContain('использовано 1 %, осталось 99 %');
    // This chat's snapshot older than the run start: the host read every home
    // then, this one included, so its percent is the newer one, even smaller.
    const old = { ...reading, usedPercent: 96, atMs: runStart - 3 * 3_600_000 };
    const host = codexQuotaStatus({ local: old, hostUsedPercent: 70, hostReadByMs: runStart, now: NOW });
    expect(host).toMatchObject({ known: true, usedPercent: 70, leftPercent: 30 });
    expect(host.readingAgeMinutes).toBeUndefined();
  });

  // Сведение с r1110: показание свежее по времени своего снимка, не старше
  // 6 ч — в момент вопроса, а не только на старте хода.
  it('the host reading is fresh by its own snapshot time, as the local one is (r1110)', () => {
    const SIX_H = 6 * 3_600_000;
    // Хост на старте хода взял снимок 5 ч 50 мин давности; вопрос — через
    // 20 мин: снимку уже больше 6 ч, это не показание.
    const stale = codexQuotaStatus({
      local: null, hostUsedPercent: 64, hostReadByMs: NOW - 20 * 60_000,
      hostReadingAtMs: NOW - SIX_H - 10 * 60_000, now: NOW,
    });
    expect(stale.known).toBe(false);
    expect(stale.usedPercent).toBeUndefined();
    expect(stale.howToSay).toContain('за последние 6 ч');
    // Ровно 6 ч — ещё показание (граница та же, что у codexAccountReading).
    expect(codexQuotaStatus({
      local: null, hostUsedPercent: 64, hostReadingAtMs: NOW - SIX_H, now: NOW,
    })).toMatchObject({ known: true, usedPercent: 64, readingAgeMinutes: 360 });
    // Снимок «из будущего» дальше допуска — не показание.
    expect(codexQuotaStatus({
      local: null, hostUsedPercent: 64, hostReadingAtMs: NOW + 11 * 60_000, now: NOW,
    }).known).toBe(false);
    // Устаревший хост не перебивает свежий снимок чата.
    const local = { usedPercent: 50, atMs: NOW - 3 * 3_600_000, windows: [{ usedPercent: 50, windowMinutes: 10080, resetsAtMs: WEEK_RESET }] };
    expect(codexQuotaStatus({
      local, hostUsedPercent: 99, hostReadByMs: NOW - 60_000,
      hostReadingAtMs: NOW - SIX_H - 60_000, now: NOW,
    })).toMatchObject({ known: true, usedPercent: 50, readingAgeMinutes: 180 });
  });

  it('with both times known the newer snapshot wins and its age is told', () => {
    const local = { usedPercent: 80, atMs: NOW - 2 * 3_600_000, windows: [{ usedPercent: 80, windowMinutes: 10080, resetsAtMs: WEEK_RESET }] };
    // Хост новее (снимок другого чата 10 мин назад) — его процент, его возраст.
    expect(codexQuotaStatus({
      local, hostUsedPercent: 83, hostReadByMs: NOW - 60_000, hostReadingAtMs: NOW - 10 * 60_000, now: NOW,
    })).toMatchObject({ known: true, usedPercent: 83, readingAgeMinutes: 10 });
    // Снимок чата новее хоста, хотя и старше старта хода: побеждает он.
    expect(codexQuotaStatus({
      local, hostUsedPercent: 70, hostReadByMs: NOW - 60_000, hostReadingAtMs: NOW - 4 * 3_600_000, now: NOW,
    })).toMatchObject({ known: true, usedPercent: 80, readingAgeMinutes: 120 });
  });

  it('a host snapshot taken after the window\'s reset still counts; one taken before does not', () => {
    const reset = WEEK_RESET;
    const before = { usedPercent: 96, atMs: reset - 2 * 3_600_000, windows: [{ usedPercent: 96, windowMinutes: 10080, resetsAtMs: reset }] };
    const after = codexQuotaStatus({
      local: before, hostUsedPercent: 3, hostReadByMs: reset + 20 * 60_000,
      hostReadingAtMs: reset + 15 * 60_000, now: reset + 30 * 60_000,
    });
    expect(after).toMatchObject({ known: true, usedPercent: 3, leftPercent: 97, readingAgeMinutes: 15, resetPassedSinceReading: true });
    const beforeReset = codexQuotaStatus({
      local: before, hostUsedPercent: 96, hostReadByMs: reset + 20 * 60_000,
      hostReadingAtMs: reset - 60_000, now: reset + 30 * 60_000,
    });
    expect(beforeReset.known).toBe(false);
    expect(beforeReset.howToSay).toContain('по сроку лимит уже обновился');
  });

  // Review r1111 (turn-2): a chat without its own snapshot (a member's, usually)
  // got the host's 97 % taken before the weekly reset, while the owner's chat
  // at the same minute said «по сроку лимит уже обновился».
  it('without its own snapshot the chat judges the host\'s windows: a passed reset is no reading (turn-2)', () => {
    const reset = WEEK_RESET;
    const weekly = { usedPercent: 97, windowMinutes: 10080, resetsAtMs: reset };
    const passed = codexQuotaStatus({
      local: null, hostUsedPercent: 97, hostReadingAtMs: reset - 47 * 60_000,
      hostWindows: [weekly], now: reset + 23 * 60_000,
    });
    expect(passed).toMatchObject({ known: false, resetPassedSinceReading: true });
    expect(passed.howToSay).toContain('по сроку лимит уже обновился');
    expect(passed.usedPercent).toBeUndefined();
    // A 5-hour window past, the weekly one live at 90 %: 90, not «обновился».
    const fiveHours = { usedPercent: 99, windowMinutes: 300, resetsAtMs: reset - 60 * 60_000 };
    const live = codexQuotaStatus({
      local: null, hostUsedPercent: 99, hostReadingAtMs: reset - 2 * 3_600_000,
      hostWindows: [fiveHours, { ...weekly, usedPercent: 90 }], now: reset - 30 * 60_000,
    });
    expect(live).toMatchObject({ known: true, usedPercent: 90, leftPercent: 10 });
    expect(live.windows?.map((window) => window.window)).toEqual(['5 часов', 'неделя']);
    // A host snapshot taken after the reset: its own percent.
    const fresh = codexQuotaStatus({
      local: null, hostUsedPercent: 3, hostReadingAtMs: reset + 10 * 60_000,
      hostWindows: [{ ...weekly, usedPercent: 3, resetsAtMs: reset + 7 * 86_400_000 }], now: reset + 23 * 60_000,
    });
    expect(fresh).toMatchObject({ known: true, usedPercent: 3 });
    // An older host without windows: as before.
    expect(codexQuotaStatus({ local: null, hostUsedPercent: 97, hostReadingAtMs: reset - 47 * 60_000, now: reset + 23 * 60_000 }))
      .toMatchObject({ known: true, usedPercent: 97 });
  });

  it('reads the host windows from the env safely (turn-2)', () => {
    expect(parseCodexHostWindows(JSON.stringify([{ usedPercent: 97, windowMinutes: 10080, resetsAtMs: 1 }])))
      .toEqual([{ usedPercent: 97, windowMinutes: 10080, resetsAtMs: 1 }]);
    for (const bad of ['', 'nope', '{}', JSON.stringify([{ usedPercent: 'x' }]),
      JSON.stringify([{ usedPercent: 1, windowMinutes: 0 }]), JSON.stringify(Array(5).fill({ usedPercent: 1 })),
      JSON.stringify([{ usedPercent: 1, note: 'x'.repeat(3000) }])]) {
      expect(parseCodexHostWindows(bad)).toEqual([]);
    }
  });
});
