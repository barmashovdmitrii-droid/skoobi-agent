import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  codexLoginFingerprint,
  holdPreStartFailure,
  isCodexPreStartFailure,
  PRESTART_REPLAY_MAX_AGE_MS,
  PreStartReplayBook,
  preStartReplayDelayMs,
  preStartReplayDue,
  preStartReplayExpired,
  preStartReplayPromptNote,
  shouldRecordPreStartBreakerFailure,
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

    // first counts, so the owner's healthy Telegram turns never meet an open
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
