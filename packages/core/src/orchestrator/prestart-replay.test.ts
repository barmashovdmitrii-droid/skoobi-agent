import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  codexLoginFingerprint,
  holdPreStartFailure,
  isCodexLinkFailureBeforeStart,
  isCodexOverloadHoldable,
  isCodexPreStartFailure,
  isMachineLinkFailure,
  PRESTART_REPLAY_MAX_AGE_MS,
  PRESTART_REPLAY_OVERLOAD_MAX_AGE_MS,
  preStartReplayMaxAgeMs,
  PreStartReplayBook,
  preStartReplayDelayMs,
  preStartReplayDue,
  preStartReplayExpired,
  preStartReplayExpiredCause,
  preStartReplayPromptNote,
  shouldRecordPreStartBreakerFailure,
  LateArrivalBook,
  lateDeliveryPromptNote,
} from './prestart-replay.js';
import { classifyProviderFailure } from './provider-failover.js';

const CHAT = 'tg:100000001';
const OTHER_CHAT = 'tg:100000002';
const T0 = Date.parse('2026-10-26T02:02:13.000Z');
const MIN = 60_000;

describe('isCodexPreStartFailure', () => {
  const base = {
    providerResponded: false,
    outputSentToUser: false,
    sideEffected: false,
  };

  it('holds a lost login and a failed workspace routing', () => {
    expect(
      isCodexPreStartFailure({
        ...base,
        reason: 'auth_error',
        error: 'workspace routing discovery unauthorized (401)',
      }),
    ).toBe(true);
    expect(
      isCodexPreStartFailure({
        ...base,
        reason: 'runtime_error',
        error: 'workspace routing discovery failed',
      }),
    ).toBe(true);
  });

  it('takes the runner errors of both incidents as they are classified', () => {
    for (const error of [
      'workspace routing discovery unauthorized (401)',
      'workspace routing discovery failed',
    ]) {
      expect(
        isCodexPreStartFailure({
          ...base,
          reason: classifyProviderFailure(new Error(error)),
          error,
        }),
      ).toBe(true);
    }
  });

  it('holds a lost link before the model answered, as classified', () => {
    // The routing used to time out with no hold: «Задача длинная», and the
    // retries of the next hour went through the queue every few seconds.
    for (const error of [
      'workspace routing discovery timed out',
      'codex provider temporarily unavailable: no connection for 600000ms',
      'Reconnecting... waiting for network (Connection failed: tls handshake eof)',
      'error sending request: dns error: failed to lookup address information',
    ]) {
      const reason = classifyProviderFailure(new Error(error));
      expect(reason).toBe('unavailable');
      expect(isCodexPreStartFailure({ ...base, reason, error })).toBe(true);
      // The model already answered in this run: «продолжай», not a replay.
      expect(
        isCodexPreStartFailure({ ...base, reason, error, providerResponded: true }),
      ).toBe(false);
      expect(
        isCodexPreStartFailure({ ...base, reason, error, modelRequests: 1 }),
      ).toBe(false);
    }
    // An unavailable provider that is no link failure is not held.
    expect(
      isCodexPreStartFailure({
        ...base,
        reason: 'unavailable',
        error: 'Codex CLI is not installed',
      }),
    ).toBe(false);
  });

  it('does not hold a refusal of the provider filter: it is no lost link (review r1111)', () => {
    const filter =
      'stream disconnected before completion: Incomplete response returned, reason: content_filter';
    for (const error of [filter, `Codex exec failed: ${filter}`]) {
      const reason = classifyProviderFailure(new Error(error));
      expect(reason).not.toBe('unavailable');
      expect(isCodexPreStartFailure({ ...base, reason, error })).toBe(false);
    }
    // Real drops of the stream are still held.
    for (const error of [
      'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
      'workspace routing discovery timed out',
    ]) {
      const reason = classifyProviderFailure(new Error(error));
      expect(isCodexPreStartFailure({ ...base, reason, error })).toBe(true);
    }
  });

  it('isCodexLinkFailureBeforeStart: a lost link before Codex answered, from the raw error (review J02)', () => {
    const quiet = { providerResponded: false, outputSentToUser: false, sideEffected: false };
    expect(
      isCodexLinkFailureBeforeStart({ ...quiet, error: 'workspace routing discovery timed out', modelRequests: 0 }),
    ).toBe(true);
    expect(
      isCodexLinkFailureBeforeStart({ ...quiet, error: 'workspace routing discovery timed out', providerResponded: true }),
    ).toBe(false);
    expect(
      isCodexLinkFailureBeforeStart({ ...quiet, error: 'workspace routing discovery timed out', sideEffected: true }),
    ).toBe(false);
    // The model processed a request (tokens): it started, nothing to hold.
    expect(
      isCodexLinkFailureBeforeStart({ ...quiet, error: 'stream disconnected before completion: ECONNRESET', usageTokens: 1200 }),
    ).toBe(false);
    expect(
      isCodexLinkFailureBeforeStart({ ...quiet, error: 'stream disconnected before completion: ECONNRESET', usageTokens: 0 }),
    ).toBe(true);
    // Not a link: a lost login, the runner not starting, the provider filter.
    for (const error of [
      'workspace routing discovery unauthorized (401)',
      'spawn EACCES: runner could not start',
      'stream disconnected before completion: Incomplete response returned, reason: content_filter',
      undefined,
    ]) {
      expect(isCodexLinkFailureBeforeStart({ ...quiet, error }), String(error)).toBe(false);
    }
  });

  it('holds a turn the open breaker skipped, and only that skip', () => {
    expect(
      isCodexPreStartFailure({ reason: 'circuit_open', skipped: true }),
    ).toBe(true);
    expect(
      isCodexPreStartFailure({ reason: 'unavailable', skipped: true }),
    ).toBe(false);
  });

  it('never holds a turn where the model worked or anything left', () => {
    const lost = {
      reason: 'auth_error' as const,
      error: 'workspace routing discovery unauthorized (401)',
    };
    expect(
      isCodexPreStartFailure({ ...base, ...lost, providerResponded: true }),
    ).toBe(false);
    // Zero tokens are no proof, but a counted request to the model is.
    expect(isCodexPreStartFailure({ ...base, ...lost, modelRequests: 1 })).toBe(
      false,
    );
    expect(
      isCodexPreStartFailure({ ...base, ...lost, outputSentToUser: true }),
    ).toBe(false);
    expect(
      isCodexPreStartFailure({ ...base, ...lost, sideEffected: true }),
    ).toBe(false);
  });

  it('keeps timeouts and other errors out', () => {
    expect(
      isCodexPreStartFailure({
        ...base,
        reason: 'timeout',
        error: 'codex turn timed out after 900000ms',
      }),
    ).toBe(false);
    expect(
      isCodexPreStartFailure({
        ...base,
        reason: 'runtime_error',
        error: 'codex exited with code 1: bad config',
      }),
    ).toBe(false);
    expect(
      isCodexPreStartFailure({
        ...base,
        reason: 'policy_blocked',
        error: 'GUEST_CODEX_PROVIDER_BLOCKED',
      }),
    ).toBe(false);
  });
});

describe('shouldRecordPreStartBreakerFailure', () => {
  const routing = {
    preStart: true,
    reason: 'runtime_error' as const,
    holdsProbe: false,
  };

  it("keeps one sandbox's failed routing out of the shared breaker after the first failure", () => {
    // One sandbox fails at t0, its replays at +2 and +7 min. Only the
    // first counts, so the healthy turns of another channel never meet an open
    // breaker (3 failures within 10 minutes open it).
    const counted = [false, true, true].filter((alreadyHeld) =>
      shouldRecordPreStartBreakerFailure({ ...routing, alreadyHeld }),
    ).length;
    expect(counted).toBe(1);
  });

  it('still counts shared causes, probes and every ordinary failure', () => {
    for (const reason of ['auth_error', 'circuit_open'] as const) {
      expect(
        shouldRecordPreStartBreakerFailure({
          ...routing,
          reason,
          alreadyHeld: true,
        }),
      ).toBe(true);
    }
    // A half-open probe must be settled, or its lease shuts everyone out.
    expect(
      shouldRecordPreStartBreakerFailure({
        ...routing,
        alreadyHeld: true,
        holdsProbe: true,
      }),
    ).toBe(true);
    // Not held (the model worked, a timeout, Claude fallback on): as before.
    expect(
      shouldRecordPreStartBreakerFailure({
        ...routing,
        preStart: false,
        alreadyHeld: true,
      }),
    ).toBe(true);
  });
});

describe('pre-start replay timing', () => {
  it('waits longer after every failed attempt, then hourly', () => {
    expect(
      [1, 2, 3, 4, 5, 6, 7, 12].map((n) => preStartReplayDelayMs(n) / MIN),
    ).toEqual([2, 5, 10, 20, 40, 60, 60, 60]);
    // A lost login: a quarter of an hour, then hourly.
    expect(
      [1, 2, 3, 12].map((n) => preStartReplayDelayMs(n, 'auth_error') / MIN),
    ).toEqual([15, 60, 60, 60]);
  });

  it('gives a series up after 6 hours', () => {
    const entry = {
      firstFailureAt: new Date(T0).toISOString(),
      lastAttemptAt: new Date(T0).toISOString(),
      nextAttemptAt: new Date(T0 + 2 * MIN).toISOString(),
      attempts: 1,
      reason: 'auth_error' as const,
      heldCursor: 'c1',
      noticeSent: true,
    };
    expect(
      preStartReplayExpired(entry, T0 + PRESTART_REPLAY_MAX_AGE_MS - 1),
    ).toBe(false);
    expect(preStartReplayExpired(entry, T0 + PRESTART_REPLAY_MAX_AGE_MS)).toBe(
      true,
    );
    expect(
      preStartReplayExpired({ ...entry, firstFailureAt: 'garbage' }, T0),
    ).toBe(true);
  });

  it('is due after the pause, or once the login file changed', () => {
    const entry = {
      firstFailureAt: new Date(T0).toISOString(),
      lastAttemptAt: new Date(T0).toISOString(),
      nextAttemptAt: new Date(T0 + 10 * MIN).toISOString(),
      attempts: 3,
      reason: 'auth_error' as const,
      heldCursor: 'c1',
      noticeSent: true,
      loginFingerprint: 'login-a',
    };
    expect(preStartReplayDue(entry, T0 + 5 * MIN, 'login-a')).toBe(false);
    expect(preStartReplayDue(entry, T0 + 10 * MIN, 'login-a')).toBe(true);
    // Logged in again: no need to wait out the pause…
    expect(preStartReplayDue(entry, T0 + 5 * MIN, 'login-b')).toBe(true);
    // …but not within a minute of the last attempt.
    expect(preStartReplayDue(entry, T0 + 30_000, 'login-b')).toBe(false);
    // An unreadable login is no signal.
    expect(preStartReplayDue(entry, T0 + 5 * MIN, undefined)).toBe(false);
    // Only a lost login is fixed by logging in.
    expect(
      preStartReplayDue(
        { ...entry, reason: 'runtime_error' },
        T0 + 5 * MIN,
        'login-b',
      ),
    ).toBe(false);
  });

  it('tells the model how long the batch waited, only after a real wait', () => {
    const entry = {
      firstFailureAt: new Date(T0).toISOString(),
      lastAttemptAt: new Date(T0).toISOString(),
      nextAttemptAt: new Date(T0).toISOString(),
      attempts: 1,
      reason: 'auth_error' as const,
      heldCursor: 'c1',
      noticeSent: true,
    };
    expect(preStartReplayPromptNote(entry, T0 + 30_000)).toBeNull();
    const note = preStartReplayPromptNote(entry, T0 + 25 * MIN);
    expect(note).toContain('ждёт ответа уже 25 мин');
    expect(note).toContain('сначала коротко переспроси');
    expect(preStartReplayPromptNote(entry, T0 + 135 * MIN)).toContain(
      '2 ч 15 мин',
    );
  });

  it('ожидание считается от самого раннего сообщения, а не от первого сбоя (W41-ост)', () => {
    // Сообщение пришло за 1 ч 39 мин до первого сбоя, а заметка говорила «2 мин».
    const entry = {
      firstFailureAt: new Date(T0).toISOString(),
      lastAttemptAt: new Date(T0).toISOString(),
      nextAttemptAt: new Date(T0).toISOString(),
      attempts: 1,
      reason: 'runtime_error' as const,
      heldCursor: 'c1',
      noticeSent: true,
    };
    const earliestMessageAt = new Date(T0 - 99 * MIN).toISOString();
    const note = preStartReplayPromptNote(entry, T0 + 2 * MIN, { earliestMessageAt });
    expect(note).toContain('ждёт ответа уже 1 ч 41 мин');
    // Сообщение моложе первого сбоя срок не укорачивает.
    expect(
      preStartReplayPromptNote(entry, T0 + 25 * MIN, {
        earliestMessageAt: new Date(T0 + 10 * MIN).toISOString(),
      }),
    ).toContain('ждёт ответа уже 25 мин');
    // Битое время сообщения — как раньше.
    expect(
      preStartReplayPromptNote(entry, T0 + 25 * MIN, { earliestMessageAt: 'не время' }),
    ).toContain('ждёт ответа уже 25 мин');
  });

  it('причина паузы — по причине серии, а не всегда «Codex был недоступен» (W41-ост)', () => {
    const base = {
      firstFailureAt: new Date(T0).toISOString(),
      lastAttemptAt: new Date(T0).toISOString(),
      nextAttemptAt: new Date(T0).toISOString(),
      attempts: 1,
      heldCursor: 'c1',
      noticeSent: true,
    };
    const at = T0 + 25 * MIN;
    expect(preStartReplayPromptNote({ ...base, reason: 'auth_error' }, at)).toContain(
      'слетел вход в Codex, теперь снова работает',
    );
    expect(preStartReplayPromptNote({ ...base, reason: 'model_overloaded' }, at)).toContain(
      'модель была перегружена, теперь снова работает',
    );
    expect(preStartReplayPromptNote({ ...base, reason: 'circuit_open' }, at)).toContain(
      'Codex был временно отключён после серии сбоев, теперь снова работает',
    );
    expect(preStartReplayPromptNote({ ...base, reason: 'runtime_error' }, at)).toContain(
      'Codex был недоступен, теперь снова работает',
    );
  });
});

describe('сообщения, дошедшие до бота с опозданием (W41-ост)', () => {
  it('отмечает только опоздание приёма не меньше двух минут', () => {
    const book = new LateArrivalBook();
    book.note('tg:1', 'a', new Date(T0 - 30_000).toISOString(), T0);
    expect(book.lateFor('tg:1', ['a'])).toBeNull();
    book.note('tg:1', 'b', new Date(T0 - 101 * MIN).toISOString(), T0);
    book.note('tg:1', 'c', new Date(T0 - 40 * MIN).toISOString(), T0);
    expect(book.lateFor('tg:1', ['a', 'b', 'c'])).toEqual({
      earliestSentMs: T0 - 101 * MIN,
      maxLagMs: 101 * MIN,
      count: 2,
    });
    // Другой чат — своё.
    expect(book.lateFor('tg:2', ['b'])).toBeNull();
    // Битое время — не опоздание.
    book.note('tg:1', 'd', 'не время', T0);
    expect(book.lateFor('tg:1', ['d'])).toBeNull();
  });

  it('держит ограниченное число отметок', () => {
    const book = new LateArrivalBook(3);
    for (const id of ['1', '2', '3', '4']) {
      book.note('tg:1', id, new Date(T0 - 10 * MIN).toISOString(), T0);
    }
    expect(book.lateFor('tg:1', ['1'])).toBeNull();
    expect(book.lateFor('tg:1', ['4'])?.count).toBe(1);
  });

  it('заметка модели: сколько ждали и что делать с давними просьбами', () => {
    const note = lateDeliveryPromptNote(
      { earliestSentMs: T0 - 101 * MIN, maxLagMs: 99 * MIN, count: 2 },
      T0,
    );
    expect(note).toContain('отправлено 1 ч 41 мин назад');
    expect(note).toContain('бот получил его только через 1 ч 39 мин');
    expect(note).toContain('о задержке — не больше одной фразы');
    expect(note).toContain('сначала коротко переспроси');
  });
});

describe('PreStartReplayBook', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prestart-replay-'));
    file = path.join(dir, 'data', 'codex-prestart-replays.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens a series once and only grows it on later failures', () => {
    const book = new PreStartReplayBook(file);
    const first = book.noteFailure(CHAT, {
      nowMs: T0,
      reason: 'auth_error',
      heldCursor: '2026-10-26T02:01:47.000Z',
      noticeSent: true,
      loginFingerprint: 'login-a',
    });
    expect(first.firstInSeries).toBe(true);
    expect(first.entry.attempts).toBe(1);
    expect(Date.parse(first.entry.nextAttemptAt) - T0).toBe(15 * MIN);

    // «Ау» a minute later joins the batch; the notice is not sent again.
    const second = book.noteFailure(CHAT, {
      nowMs: T0 + MIN,
      reason: 'auth_error',
      heldCursor: '2026-10-26T02:02:51.000Z',
      noticeSent: false,
    });
    expect(second.firstInSeries).toBe(false);
    expect(second.entry).toMatchObject({
      attempts: 2,
      firstFailureAt: new Date(T0).toISOString(),
      heldCursor: '2026-10-26T02:02:51.000Z',
      noticeSent: true,
      loginFingerprint: 'login-a',
    });
    expect(Date.parse(second.entry.nextAttemptAt) - (T0 + MIN)).toBe(60 * MIN);
  });

  it('keeps the cause of a series when an open breaker skips an attempt', () => {
    const book = new PreStartReplayBook(file);
    book.noteFailure(CHAT, {
      nowMs: T0,
      reason: 'auth_error',
      heldCursor: 'c1',
      noticeSent: true,
      loginFingerprint: 'login-a',
    });
    const skipped = book.noteFailure(CHAT, {
      nowMs: T0 + MIN,
      reason: 'circuit_open',
      heldCursor: 'c2',
      noticeSent: false,
    });
    // Still a lost login: woken by a new one, on the login schedule.
    expect(skipped.entry).toMatchObject({
      reason: 'auth_error',
      loginFingerprint: 'login-a',
    });
    expect(preStartReplayDue(skipped.entry, T0 + 3 * MIN, 'login-b')).toBe(
      true,
    );
    // A series that began on the breaker takes the real cause when one
    // shows up.
    book.noteFailure(OTHER_CHAT, {
      nowMs: T0,
      reason: 'circuit_open',
      heldCursor: 'c1',
      noticeSent: true,
    });
    expect(
      book.noteFailure(OTHER_CHAT, {
        nowMs: T0 + 3 * MIN,
        reason: 'runtime_error',
        heldCursor: 'c1',
        noticeSent: false,
      }).entry.reason,
    ).toBe('runtime_error');
  });

  it('tries a lost login on the timer only seldom; the wakes do the work', () => {
    // An outage of 6 hours, nobody logs in, nobody writes: the timer
    // alone used to try 10 times, each try one more copy of the prompt in
    // the chat's kept thread.
    const book = new PreStartReplayBook(file);
    let nowMs = T0;
    book.noteFailure(CHAT, {
      nowMs,
      reason: 'auth_error',
      heldCursor: 'c1',
      noticeSent: true,
      loginFingerprint: 'login-a',
    });
    let attempts = 1;
    while (nowMs < T0 + PRESTART_REPLAY_MAX_AGE_MS - MIN) {
      nowMs += MIN;
      const { due } = book.tick({
        nowMs,
        isActive: () => false,
        loginFingerprint: () => 'login-a',
      });
      if (due.length === 0) continue;
      attempts += 1;
      book.noteFailure(CHAT, {
        nowMs,
        reason: 'auth_error',
        heldCursor: 'c1',
        noticeSent: false,
        loginFingerprint: 'login-a',
      });
    }
    expect(attempts).toBeLessThanOrEqual(7);
    // A breaker skip or a failed routing keeps the quick schedule.
    expect(preStartReplayDelayMs(1, 'circuit_open')).toBe(2 * MIN);
    expect(preStartReplayDelayMs(1, 'runtime_error')).toBe(2 * MIN);
  });

  it('survives a restart: the series and its age come back from disk', () => {
    new PreStartReplayBook(file).noteFailure(CHAT, {
      nowMs: T0,
      reason: 'runtime_error',
      heldCursor: 'c1',
      noticeSent: true,
    });
    const reloaded = new PreStartReplayBook(file);
    expect(reloaded.get(CHAT)).toMatchObject({
      firstFailureAt: new Date(T0).toISOString(),
      attempts: 1,
      reason: 'runtime_error',
    });
  });

  it('ignores a corrupt file instead of holding chats forever', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    expect(new PreStartReplayBook(file).size()).toBe(0);
  });

  it('settles a series once the cursor reached the held messages', () => {
    const book = new PreStartReplayBook(file);
    book.noteFailure(CHAT, {
      nowMs: T0,
      reason: 'auth_error',
      heldCursor: 'c5',
      noticeSent: true,
    });
    expect(book.settleIfPassed(CHAT, 'c4')).toBeUndefined();
    expect(book.get(CHAT)).toBeDefined();
    expect(book.settleIfPassed(CHAT, 'c5')).toMatchObject({ attempts: 1 });
    expect(book.get(CHAT)).toBeUndefined();
    // The file goes with the last series.
    expect(fs.existsSync(file)).toBe(false);
  });

  it('replays a due chat once per pause, not on every tick', () => {
    const book = new PreStartReplayBook(file);
    book.noteFailure(CHAT, {
      nowMs: T0,
      reason: 'runtime_error',
      heldCursor: 'c1',
      noticeSent: true,
    });
    const idle = { isActive: () => false };
    expect(book.tick({ ...idle, nowMs: T0 + MIN }).due).toEqual([]);
    expect(book.tick({ ...idle, nowMs: T0 + 2 * MIN }).due).toEqual([CHAT]);
    // Queued already: the next ticks leave it alone.
    expect(book.tick({ ...idle, nowMs: T0 + 2 * MIN + 2000 }).due).toEqual([]);
    // A chat with a run in progress is never touched.
    expect(
      book.tick({ nowMs: T0 + 30 * MIN, isActive: () => true }).due,
    ).toEqual([]);
  });

  it('wakes a held login series as soon as the login changes', () => {
    const book = new PreStartReplayBook(file);
    book.noteFailure(CHAT, {
      nowMs: T0,
      reason: 'auth_error',
      heldCursor: 'c1',
      noticeSent: true,
      loginFingerprint: 'login-a',
    });
    let login = 'login-a';
    const tick = (nowMs: number) =>
      book.tick({ nowMs, isActive: () => false, loginFingerprint: () => login })
        .due;
    expect(tick(T0 + 90_000)).toEqual([]);
    login = 'login-b'; // `codex login` on the host
    expect(tick(T0 + 95_000)).toEqual([CHAT]);
    expect(tick(T0 + 100_000)).toEqual([]);
  });

  it("does not wake on the runner's own rewrite of the central copy", () => {
    // Two main chats held on one lost login (the owner and an admin). Every
    // failed attempt of either rewrote data/codex-auth/auth.json — same
    // tokens, fresh mtime — and woke the other one: no pause ever applied.
    const homeDir = path.join(dir, 'home');
    const dataDir = path.join(dir, 'data');
    const host = path.join(homeDir, '.codex', 'auth.json');
    const central = path.join(dataDir, 'codex-auth', 'auth.json');
    const login = (tokens: string) =>
      JSON.stringify({
        tokens: { account_id: 'acct-1', refresh_token: tokens },
      });
    const writeAt = (target: string, body: string, mtimeMs: number) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // The runner's copy is atomic: a temp file renamed over the target.
      fs.writeFileSync(`${target}.tmp`, body);
      fs.renameSync(`${target}.tmp`, target);
      fs.utimesSync(target, new Date(mtimeMs), new Date(mtimeMs));
    };
    writeAt(host, login('rt-old'), T0 - 60 * MIN);
    writeAt(central, login('rt-old'), T0 - MIN);
    const now = () => codexLoginFingerprint({ homeDir, dataDir });

    const book = new PreStartReplayBook(file);
    for (const chat of [CHAT, OTHER_CHAT]) {
      book.noteFailure(chat, {
        nowMs: T0,
        reason: 'auth_error',
        heldCursor: 'c1',
        noticeSent: true,
        loginFingerprint: now(),
      });
    }
    // CHAT's next failed attempt (a new message): prepare + write-back leave
    // the central copy with the same tokens and a newer mtime.
    writeAt(central, login('rt-old'), T0 + MIN);
    book.noteFailure(CHAT, {
      nowMs: T0 + MIN,
      reason: 'auth_error',
      heldCursor: 'c2',
      noticeSent: true,
      loginFingerprint: now(),
    });
    const tick = (nowMs: number) =>
      book.tick({ nowMs, isActive: () => false, loginFingerprint: now }).due;
    // OTHER_CHAT's pause runs to T0 + 2 min; nothing woke it.
    expect(tick(T0 + 100_000)).toEqual([]);

    // The owner logs in again on the host: each wakes a minute after its own
    // last attempt.
    writeAt(host, login('rt-new'), T0 + 105_000);
    expect(tick(T0 + 110_000)).toEqual([OTHER_CHAT]);
    expect(tick(T0 + 125_000)).toEqual([CHAT]);
  });

  it('wakes the other chats held on a shared cause when one gets through', () => {
    const book = new PreStartReplayBook(file);
    const THIRD_CHAT = '0000000000@s.whatsapp.net';
    for (const chat of [CHAT, OTHER_CHAT]) {
      book.noteFailure(chat, {
        nowMs: T0,
        reason: 'auth_error',
        heldCursor: 'c1',
        noticeSent: true,
      });
    }
    // One sandbox's failed routing is not fixed by another chat's success.
    book.noteFailure(THIRD_CHAT, {
      nowMs: T0,
      reason: 'runtime_error',
      heldCursor: 'c1',
      noticeSent: true,
    });
    expect(book.wakeAll(CHAT, T0 + MIN)).toBe(1);
    expect(book.tick({ nowMs: T0 + MIN, isActive: () => false }).due).toEqual([
      OTHER_CHAT,
    ]);
  });

  it('wakes a series held on a lost link when another chat gets through (review J02)', () => {
    const book = new PreStartReplayBook(file);
    const ROUTING_CHAT = '77000000001@s.whatsapp.net';
    // The network was down for ~1.5 h: the owner's series sits in a long pause.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      book.noteFailure(CHAT, {
        nowMs: T0 + attempt * 10 * MIN,
        reason: 'unavailable',
        heldCursor: 'c1',
        noticeSent: true,
        link: true,
      });
    }
    expect(book.get(CHAT)).toMatchObject({ reason: 'unavailable', link: true, attempts: 6 });
    // One sandbox's failed routing is no link of the machine: it keeps its pause.
    book.noteFailure(ROUTING_CHAT, {
      nowMs: T0 + 59 * MIN,
      reason: 'unavailable',
      heldCursor: 'c1',
      noticeSent: true,
      link: false,
    });
    expect(book.get(ROUTING_CHAT)?.link).toBeUndefined();
    // An open breaker only skipped an attempt: the flag stays.
    book.noteFailure(CHAT, {
      nowMs: T0 + 55 * MIN,
      reason: 'circuit_open',
      heldCursor: 'c1',
      noticeSent: true,
    });
    expect(book.get(CHAT)).toMatchObject({ reason: 'unavailable', link: true });
    // The flag survives a restart.
    const reloaded = new PreStartReplayBook(file);
    expect(reloaded.get(CHAT)?.link).toBe(true);
    // No busy loop: not within a minute of the series' own last attempt.
    expect(reloaded.wakeAll(OTHER_CHAT, T0 + 55 * MIN + 30_000)).toBe(0);
    // The second admin's turn went through at minute 60: the owner's series is due now,
    // not after its 60-minute pause.
    expect(reloaded.wakeAll(OTHER_CHAT, T0 + 60 * MIN)).toBe(1);
    expect(
      reloaded.tick({ nowMs: T0 + 60 * MIN, isActive: () => false }).due,
    ).toEqual([CHAT]);
  });

  it('flags only a lost link of the machine, not one sandbox\'s failed routing', () => {
    for (const error of [
      'workspace routing discovery timed out',
      'codex provider temporarily unavailable: no connection for 600000ms',
      'error sending request: dns error: failed to lookup address information',
      'Reconnecting... waiting for network (Connection failed: tls handshake eof)',
    ]) {
      expect(
        isMachineLinkFailure(classifyProviderFailure(new Error(error)), error),
        error,
      ).toBe(true);
    }
    expect(
      isMachineLinkFailure('unavailable', 'workspace routing discovery failed'),
    ).toBe(false);
    expect(isMachineLinkFailure('auth_error', 'workspace routing discovery unauthorized (401)')).toBe(false);
    expect(
      isMachineLinkFailure(
        'runtime_error',
        'stream disconnected before completion: Incomplete response returned, reason: content_filter',
      ),
    ).toBe(false);
  });

  it('ends a series after 6 hours, and only when the chat is idle', () => {
    const book = new PreStartReplayBook(file);
    book.noteFailure(CHAT, {
      nowMs: T0,
      reason: 'auth_error',
      heldCursor: 'c1',
      noticeSent: true,
    });
    const late = T0 + PRESTART_REPLAY_MAX_AGE_MS;
    expect(book.tick({ nowMs: late, isActive: () => true }).expired).toEqual(
      [],
    );
    const { due, expired } = book.tick({ nowMs: late, isActive: () => false });
    expect(due).toEqual([]);
    expect(expired).toEqual([
      expect.objectContaining({
        chatJid: CHAT,
        entry: expect.objectContaining({ heldCursor: 'c1' }),
      }),
    ]);
    expect(book.get(CHAT)).toBeUndefined();
  });
});

describe('holdPreStartFailure', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prestart-hold-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends one notice per series, however many attempts fail', async () => {
    const book = new PreStartReplayBook(path.join(dir, 'replays.json'));
    let sent = 0;
    const sendNotice = async () => {
      sent += 1;
      return true;
    };
    // «Ты тут?», then «Ау» three times, all on a lost login.
    for (let i = 0; i < 4; i += 1) {
      await holdPreStartFailure({
        book,
        chatJid: CHAT,
        nowMs: T0 + i * 4 * MIN,
        reason: 'auth_error',
        heldCursor: `c${i}`,
        sendNotice,
      });
    }
    expect(sent).toBe(1);
    expect(book.get(CHAT)).toMatchObject({ attempts: 4, heldCursor: 'c3' });
  });

  it('ends a series past its age inside the hold, busy chat or not', async () => {
    const book = new PreStartReplayBook(path.join(dir, 'replays.json'));
    let sent = 0;
    const sendNotice = async () => {
      sent += 1;
      return true;
    };
    const first = await holdPreStartFailure({
      book,
      chatJid: CHAT,
      nowMs: T0,
      reason: 'auth_error',
      heldCursor: 'c1',
      sendNotice,
    });
    expect(first.expired).toBe(false);
    // A chat that keeps failing is never idle on a tick, so tick() never
    // ends its series: the next failure past 6 hours does.
    expect(
      book.tick({
        nowMs: T0 + PRESTART_REPLAY_MAX_AGE_MS,
        isActive: () => true,
      }).expired,
    ).toEqual([]);
    const late = await holdPreStartFailure({
      book,
      chatJid: CHAT,
      nowMs: T0 + PRESTART_REPLAY_MAX_AGE_MS,
      reason: 'auth_error',
      heldCursor: 'c9',
      sendNotice,
    });
    expect(late.expired).toBe(true);
    expect(late.noticeDelivered).toBe(false);
    // The caller moves the cursor past everything held, the newest included.
    expect(late.entry.heldCursor).toBe('c9');
    expect(book.get(CHAT)).toBeUndefined();
    expect(sent).toBe(1);
  });

  it('tries the notice again while it has not reached the chat', async () => {
    const book = new PreStartReplayBook(path.join(dir, 'replays.json'));
    const outcomes = [false, true, true];
    let sent = 0;
    const sendNotice = async () => {
      const ok = outcomes[sent];
      sent += 1;
      if (!ok) throw new Error('telegram down');
      return ok;
    };
    for (let i = 0; i < 3; i += 1) {
      const held = await holdPreStartFailure({
        book,
        chatJid: CHAT,
        nowMs: T0 + i * MIN,
        reason: 'runtime_error',
        heldCursor: 'c1',
        sendNotice,
      });
      expect(held.noticeDelivered).toBe(i === 1);
    }
    expect(sent).toBe(2);
  });
});

describe('codexLoginFingerprint', () => {
  it('reads the host login; the central copy only when there is none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prestart-login-'));
    try {
      const homeDir = path.join(dir, 'home');
      const dataDir = path.join(dir, 'data');
      expect(codexLoginFingerprint({ homeDir, dataDir })).toBeUndefined();
      const host = path.join(homeDir, '.codex', 'auth.json');
      const central = path.join(dataDir, 'codex-auth', 'auth.json');
      const write = (file: string, body: string) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
      };
      write(central, JSON.stringify({ tokens: { refresh_token: 'rt-1' } }));
      const centralOnly = codexLoginFingerprint({ homeDir, dataDir });
      expect(centralOnly).toMatch(/^[0-9a-f]{16}$/);

      write(host, JSON.stringify({ tokens: { refresh_token: 'rt-2' } }));
      const hostLogin = codexLoginFingerprint({ homeDir, dataDir });
      expect(hostLogin).not.toBe(centralOnly);
      // The central copy no longer matters, whatever it holds.
      write(central, JSON.stringify({ tokens: { refresh_token: 'rt-3' } }));
      expect(codexLoginFingerprint({ homeDir, dataDir })).toBe(hostLogin);
      // Same tokens rewritten: the same login. The hash never holds them.
      write(
        host,
        JSON.stringify({
          last_refresh: 'later',
          tokens: { refresh_token: 'rt-2' },
        }),
      );
      expect(codexLoginFingerprint({ homeDir, dataDir })).toBe(hostLogin);
      expect(hostLogin).not.toContain('rt-2');
      // A half-written file is no signal.
      write(host, '{"tokens":');
      expect(codexLoginFingerprint({ homeDir, dataDir })).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


// W10: «Selected model is at capacity» before the model did anything is held
// and tried again by the host — the user no longer writes «Повторяй».
describe('model overload hold (W10)', () => {
  const capacity = 'Selected model is at capacity. Please try a different model.';

  it('holds a turn refused in 2.5 s: nothing came back', () => {
    const reason = classifyProviderFailure(new Error(capacity));
    expect(reason).toBe('model_overloaded');
    // codex wrote a token_count for the refused request: one «request» was
    // counted, yet the model never answered (providerResponded false).
    expect(isCodexPreStartFailure({ reason, error: capacity, modelRequests: 1,
      providerResponded: false, outputSentToUser: false, sideEffected: false })).toBe(false);
    expect(isCodexOverloadHoldable({ reason, providerResponded: false,
      outputSentToUser: false, sideEffected: false })).toBe(true);
  });

  it('does not hold a turn that already worked (ssh, then «at capacity»)', () => {
    const reason = 'model_overloaded' as const;
    expect(isCodexOverloadHoldable({ reason, providerResponded: true })).toBe(false);
    expect(isCodexOverloadHoldable({ reason, outputSentToUser: true })).toBe(false);
    expect(isCodexOverloadHoldable({ reason, sideEffected: true })).toBe(false);
    expect(isCodexOverloadHoldable({ reason: 'timeout' })).toBe(false);
    expect(isCodexOverloadHoldable({ reason: 'runtime_error' })).toBe(false);
  });

  it('tries again after 1.5, 5 and 10 minutes and gives up after 20', () => {
    expect(preStartReplayDelayMs(1, 'model_overloaded')).toBe(90_000);
    expect(preStartReplayDelayMs(2, 'model_overloaded')).toBe(5 * MIN);
    expect(preStartReplayDelayMs(3, 'model_overloaded')).toBe(10 * MIN);
    expect(preStartReplayDelayMs(9, 'model_overloaded')).toBe(10 * MIN);
    expect(preStartReplayMaxAgeMs('model_overloaded')).toBe(PRESTART_REPLAY_OVERLOAD_MAX_AGE_MS);
    expect(preStartReplayMaxAgeMs('auth_error')).toBe(PRESTART_REPLAY_MAX_AGE_MS);
    const entry = {
      firstFailureAt: new Date(T0).toISOString(),
      lastAttemptAt: new Date(T0).toISOString(),
      nextAttemptAt: new Date(T0 + 90_000).toISOString(),
      attempts: 1,
      reason: 'model_overloaded' as const,
      heldCursor: 'i:0000000000000001',
      noticeSent: true,
    };
    expect(preStartReplayExpired(entry, T0 + 19 * MIN)).toBe(false);
    expect(preStartReplayExpired(entry, T0 + 20 * MIN)).toBe(true);
    // The other causes keep their six hours.
    expect(preStartReplayExpired({ ...entry, reason: 'auth_error' }, T0 + 20 * MIN)).toBe(false);
  });

  describe('book', () => {
    let dir: string;
    let file: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prestart-overload-'));
      file = path.join(dir, 'replays.json');
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('another chat getting through wakes a held overload series at once', () => {
      const book = new PreStartReplayBook(file);
      book.noteFailure(CHAT, { nowMs: T0, reason: 'model_overloaded',
        heldCursor: 'i:0000000000000001', noticeSent: true });
      expect(book.wakeAll(OTHER_CHAT, T0 + 10_000)).toBe(1);
      expect(book.tick({ nowMs: T0 + 10_000, isActive: () => false }).due).toEqual([CHAT]);
    });

    it('ends the series with the honest notice once its 20 minutes are over', () => {
      const book = new PreStartReplayBook(file);
      book.noteFailure(CHAT, { nowMs: T0, reason: 'model_overloaded',
        heldCursor: 'i:0000000000000001', noticeSent: true });
      expect(book.tick({ nowMs: T0 + 19 * MIN, isActive: () => false }).expired).toEqual([]);
      const { expired } = book.tick({ nowMs: T0 + 20 * MIN, isActive: () => false });
      expect(expired.map((item) => item.chatJid)).toEqual([CHAT]);
      expect(book.get(CHAT)).toBeUndefined();
    });
  });
});

// W01×W10 (review r1108): the cause changes within a held series — the login
// came back, then «at capacity». The overload's own 20 minutes and tries
// count from then, not from the login lost long before.
describe('a held series that changes its cause', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prestart-cause-'));
    file = path.join(dir, 'replays.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a lost login, then an overload 40 min later: tried after 1.5 min, not ended at the next tick', async () => {
    const book = new PreStartReplayBook(file);
    let notices = 0;
    const sendNotice = async () => {
      notices += 1;
      return true;
    };
    await holdPreStartFailure({ book, chatJid: CHAT, nowMs: T0, reason: 'auth_error',
      heldCursor: 'c1', loginFingerprint: 'login-a', sendNotice });
    const overloadAt = T0 + 40 * MIN;
    const held = await holdPreStartFailure({ book, chatJid: CHAT, nowMs: overloadAt,
      reason: 'model_overloaded', heldCursor: 'c2', sendNotice });
    expect(held.expired).toBe(false);
    // One notice for the whole series: the chat already heard it.
    expect(notices).toBe(1);
    expect(held.entry).toMatchObject({
      reason: 'model_overloaded',
      attempts: 1,
      firstFailureAt: new Date(T0).toISOString(),
      reasonSince: new Date(overloadAt).toISOString(),
      heldCursor: 'c2',
      noticeSent: true,
    });
    expect(Date.parse(held.entry.nextAttemptAt) - overloadAt).toBe(90_000);
    // The tick two seconds later: neither ended nor due yet.
    expect(book.tick({ nowMs: overloadAt + 2_000, isActive: () => false }))
      .toEqual({ due: [], expired: [] });
    expect(book.tick({ nowMs: overloadAt + 90_000, isActive: () => false }).due)
      .toEqual([CHAT]);
    // The model's note still counts the wait from the first failure.
    expect(preStartReplayPromptNote(book.get(CHAT)!, overloadAt + 2 * MIN))
      .toContain('уже 42 мин');
    // The overload's own 20 minutes end it, with the overload's notice.
    expect(book.tick({ nowMs: overloadAt + 19 * MIN, isActive: () => false }).expired)
      .toEqual([]);
    const { expired } = book.tick({ nowMs: overloadAt + 20 * MIN, isActive: () => false });
    expect(expired.map((item) => item.chatJid)).toEqual([CHAT]);
    expect(preStartReplayExpiredCause(expired[0].entry, overloadAt + 20 * MIN)).toEqual({
      reason: 'model_overloaded',
      maxAgeMs: PRESTART_REPLAY_OVERLOAD_MAX_AGE_MS,
    });
  });

  it('an open breaker in between changes nothing: the lost login keeps its count', () => {
    const book = new PreStartReplayBook(file);
    book.noteFailure(CHAT, { nowMs: T0, reason: 'auth_error', heldCursor: 'c1', noticeSent: true });
    const skipped = book.noteFailure(CHAT, { nowMs: T0 + MIN, reason: 'circuit_open',
      heldCursor: 'c1', noticeSent: false });
    expect(skipped.entry).toMatchObject({ reason: 'auth_error', attempts: 2 });
    expect(skipped.entry.reasonSince).toBeUndefined();
  });

  it('the same cause again keeps counting; the reason start survives a restart', () => {
    const book = new PreStartReplayBook(file);
    book.noteFailure(CHAT, { nowMs: T0, reason: 'auth_error', heldCursor: 'c1', noticeSent: true });
    book.noteFailure(CHAT, { nowMs: T0 + 40 * MIN, reason: 'model_overloaded',
      heldCursor: 'c1', noticeSent: false });
    const again = book.noteFailure(CHAT, { nowMs: T0 + 42 * MIN, reason: 'model_overloaded',
      heldCursor: 'c1', noticeSent: false });
    expect(again.entry).toMatchObject({
      attempts: 2,
      reasonSince: new Date(T0 + 40 * MIN).toISOString(),
    });
    expect(new PreStartReplayBook(file).get(CHAT)).toEqual(again.entry);
  });

  it('changing causes never hold the messages past six hours in all', () => {
    const book = new PreStartReplayBook(file);
    book.noteFailure(CHAT, { nowMs: T0, reason: 'auth_error', heldCursor: 'c1', noticeSent: true });
    const lateOverload = T0 + PRESTART_REPLAY_MAX_AGE_MS - 10 * MIN;
    book.noteFailure(CHAT, { nowMs: lateOverload, reason: 'model_overloaded',
      heldCursor: 'c1', noticeSent: false });
    expect(preStartReplayExpired(book.get(CHAT)!, T0 + PRESTART_REPLAY_MAX_AGE_MS - MIN))
      .toBe(false);
    const end = T0 + PRESTART_REPLAY_MAX_AGE_MS;
    const { expired } = book.tick({ nowMs: end, isActive: () => false });
    expect(expired.map((item) => item.chatJid)).toEqual([CHAT]);
    // Ten minutes of overload were not «все 20 мин»: the notice speaks of the
    // six hours the messages waited.
    expect(preStartReplayExpiredCause(expired[0].entry, end)).toEqual({
      maxAgeMs: PRESTART_REPLAY_MAX_AGE_MS,
    });
  });

  it('a series past its own limit ends with its own cause, whatever failed last', async () => {
    const book = new PreStartReplayBook(file);
    const sendNotice = async () => true;
    await holdPreStartFailure({ book, chatJid: CHAT, nowMs: T0, reason: 'model_overloaded',
      heldCursor: 'c1', sendNotice });
    const late = await holdPreStartFailure({ book, chatJid: CHAT, nowMs: T0 + 25 * MIN,
      reason: 'auth_error', heldCursor: 'c2', sendNotice });
    expect(late.expired).toBe(true);
    expect(late.entry).toMatchObject({ reason: 'model_overloaded', heldCursor: 'c2' });
    expect(preStartReplayExpiredCause(late.entry, T0 + 25 * MIN)).toEqual({
      reason: 'model_overloaded',
      maxAgeMs: PRESTART_REPLAY_OVERLOAD_MAX_AGE_MS,
    });
  });
});
