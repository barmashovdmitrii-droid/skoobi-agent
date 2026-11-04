

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { ProviderFailoverReason } from './provider-failover.js';

/** How long held messages wait before the series gives up. */
export const PRESTART_REPLAY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Pause before the next try, by failed attempts so far (then the last). */
export const PRESTART_REPLAY_BACKOFF_MS = [2, 5, 10, 20, 40, 60].map(
  (minutes) => minutes * 60 * 1000,
);



export const PRESTART_REPLAY_AUTH_BACKOFF_MS = [15, 60].map(
  (minutes) => minutes * 60 * 1000,
);

/** Causes every chat shares: one chat getting through means all may. */
const SHARED_PRESTART_REASONS: ReadonlySet<ProviderFailoverReason> = new Set([
  'auth_error',
  'circuit_open',
]);

/** An attempt woken by a changed login comes no sooner than this. */
const PRESTART_REPLAY_AUTH_MIN_GAP_MS = 60 * 1000;

/** Messages that waited at least this long get a note for the model. */
const PRESTART_REPLAY_NOTE_MIN_WAIT_MS = 2 * 60 * 1000;



const CODEX_PRESTART_ERROR_RE = /workspace routing discovery/i;

export interface PreStartReplayEntry {
  /** When the first turn of this series failed (ISO). */
  firstFailureAt: string;
  /** When the latest attempt failed (ISO). */
  lastAttemptAt: string;
  /** Not before this the series is tried again on its own (ISO). */
  nextAttemptAt: string;
  /** Failed attempts in the series, the first one included. */
  attempts: number;
  reason: ProviderFailoverReason;
  /** The newest message cursor a failed attempt covered. */
  heldCursor: string;
  /** The «сохранил, отвечу сам» notice reached the chat. */
  noticeSent: boolean;
  /**
   * Fingerprint of the Codex login at the latest auth_error attempt
   * (codexLoginFingerprint): a new login is a different one.
   */
  loginFingerprint?: string;
}

export function isCodexPreStartFailure(input: {
  reason?: ProviderFailoverReason;
  error?: string;
  /** The runner was never started (the breaker skipped the turn). */
  skipped?: boolean;
  /** The provider answered at least once (the runner's heartbeat). */
  providerResponded?: boolean;
  /** Requests to the model the runner counted. */
  modelRequests?: number;
  outputSentToUser?: boolean;
  sideEffected?: boolean;
}): boolean {
  if (input.outputSentToUser === true || input.sideEffected === true) {
    return false;
  }
  if (input.skipped === true) return input.reason === 'circuit_open';
  if (input.providerResponded === true || (input.modelRequests ?? 0) > 0) {
    return false;
  }
  // Our own limit or a guest refusal: the model worked, or a replay would be
  // refused the same way.
  if (input.reason === 'timeout' || input.reason === 'policy_blocked') {
    return false;
  }
  if (input.reason === 'auth_error') return true;
  return CODEX_PRESTART_ERROR_RE.test(input.error ?? '');
}



export function shouldRecordPreStartBreakerFailure(input: {
  /** This failure is held for a replay (isCodexPreStartFailure). */
  preStart: boolean;
  reason: ProviderFailoverReason;
  /** The chat had a held series before this attempt. */
  alreadyHeld: boolean;
  /** This attempt runs as the breaker's half-open probe. */
  holdsProbe: boolean;
}): boolean {
  if (!input.preStart || !input.alreadyHeld || input.holdsProbe) return true;
  return SHARED_PRESTART_REASONS.has(input.reason);
}

export function preStartReplayDelayMs(
  attempts: number,
  reason?: ProviderFailoverReason,
): number {
  const schedule =
    reason === 'auth_error'
      ? PRESTART_REPLAY_AUTH_BACKOFF_MS
      : PRESTART_REPLAY_BACKOFF_MS;
  const index = Math.min(
    Math.max(1, Math.floor(attempts)) - 1,
    schedule.length - 1,
  );
  return schedule[index];
}

function parsedMs(iso: string | undefined): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}

export function preStartReplayExpired(
  entry: PreStartReplayEntry,
  nowMs: number,
): boolean {
  const first = parsedMs(entry.firstFailureAt);
  // A corrupt entry must not hold a chat forever.
  if (!Number.isFinite(first)) return true;
  return nowMs - first >= PRESTART_REPLAY_MAX_AGE_MS;
}

export function preStartReplayDue(
  entry: PreStartReplayEntry,
  nowMs: number,
  loginFingerprint?: string,
): boolean {
  const next = parsedMs(entry.nextAttemptAt);
  if (!Number.isFinite(next) || nowMs >= next) return true;
  // The login changed (or appeared) since the last attempt: someone logged in

  // than a minute after the last attempt, so a login that keeps changing for
  // another reason cannot turn this into a busy loop.
  return (
    entry.reason === 'auth_error' &&
    typeof loginFingerprint === 'string' &&
    loginFingerprint !== entry.loginFingerprint &&
    !(nowMs - parsedMs(entry.lastAttemptAt) < PRESTART_REPLAY_AUTH_MIN_GAP_MS)
  );
}

function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

/** The note the model gets with a batch that waited out an outage. */
export function preStartReplayPromptNote(
  entry: PreStartReplayEntry,
  nowMs: number,
): string | null {
  const first = parsedMs(entry.firstFailureAt);
  if (!Number.isFinite(first)) return null;
  const waited = nowMs - first;
  if (waited < PRESTART_REPLAY_NOTE_MIN_WAIT_MS) return null;
  return `[Самое раннее из этих сообщений ждёт ответа уже ${formatWait(waited)}: Codex был недоступен, теперь снова работает. Ответь на всё одним ответом, о паузе — не больше одной фразы. Если там просьба о действии с последствиями (отправить, удалить, оплатить, изменить что-то вне этого чата) и ждёт она больше 30 мин — сначала коротко переспроси, актуально ли.]`;
}

/**
 * The held series of every chat, in one small JSON file. Read once, written
 * on every change (atomically), so a restart keeps the series and its age.
 */
export class PreStartReplayBook {
  private entries: Record<string, PreStartReplayEntry> | null = null;

  constructor(private readonly file: string) {}

  private load(): Record<string, PreStartReplayEntry> {
    if (this.entries) return this.entries;
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch {
      /* missing or corrupt — no held series */
    }
    const entries: Record<string, PreStartReplayEntry> = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [chatJid, raw] of Object.entries(parsed)) {
        const entry = raw as Partial<PreStartReplayEntry> | null;
        if (
          entry &&
          typeof entry.firstFailureAt === 'string' &&
          typeof entry.heldCursor === 'string' &&
          typeof entry.reason === 'string'
        ) {
          entries[chatJid] = {
            firstFailureAt: entry.firstFailureAt,
            lastAttemptAt: String(entry.lastAttemptAt ?? entry.firstFailureAt),
            nextAttemptAt: String(entry.nextAttemptAt ?? entry.firstFailureAt),
            attempts:
              typeof entry.attempts === 'number' && entry.attempts > 0
                ? Math.floor(entry.attempts)
                : 1,
            reason: entry.reason as ProviderFailoverReason,
            heldCursor: entry.heldCursor,
            noticeSent: entry.noticeSent === true,
            ...(typeof entry.loginFingerprint === 'string'
              ? { loginFingerprint: entry.loginFingerprint }
              : {}),
          };
        }
      }
    }
    this.entries = entries;
    return entries;
  }

  private persist(): void {
    const entries = this.load();
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (Object.keys(entries).length === 0) {
        fs.rmSync(this.file, { force: true });
        return;
      }
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
      fs.renameSync(tmp, this.file);
    } catch {
      // Best-effort: the series still works in memory until a restart.
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* never created */
      }
    }
  }

  size(): number {
    return Object.keys(this.load()).length;
  }

  get(chatJid: string): PreStartReplayEntry | undefined {
    return this.load()[chatJid];
  }

  chats(): string[] {
    return Object.keys(this.load());
  }

  /** A turn of this chat failed before Codex started. */
  noteFailure(
    chatJid: string,
    input: {
      nowMs: number;
      reason: ProviderFailoverReason;
      heldCursor: string;
      noticeSent: boolean;
      loginFingerprint?: string;
    },
  ): { entry: PreStartReplayEntry; firstInSeries: boolean } {
    const entries = this.load();
    const previous = entries[chatJid];
    const nowIso = new Date(input.nowMs).toISOString();
    const attempts = previous ? previous.attempts + 1 : 1;
    // An open breaker only skipped this attempt: the series keeps the cause
    // it was held for (a lost login stays one — its wake and its schedule).
    const reason =
      input.reason === 'circuit_open' && previous
        ? previous.reason
        : input.reason;
    const entry: PreStartReplayEntry = {
      firstFailureAt: previous?.firstFailureAt ?? nowIso,
      lastAttemptAt: nowIso,
      nextAttemptAt: new Date(
        input.nowMs + preStartReplayDelayMs(attempts, reason),
      ).toISOString(),
      attempts,
      reason,
      heldCursor:
        previous && previous.heldCursor > input.heldCursor
          ? previous.heldCursor
          : input.heldCursor,
      noticeSent: previous?.noticeSent === true || input.noticeSent,
      ...(typeof input.loginFingerprint === 'string'
        ? { loginFingerprint: input.loginFingerprint }
        : previous?.loginFingerprint !== undefined
          ? { loginFingerprint: previous.loginFingerprint }
          : {}),
    };
    entries[chatJid] = entry;
    this.persist();
    return { entry, firstInSeries: !previous };
  }

  /**
   * The chat's cursor reached the held messages (answered, or moved on any
   * other way): the series is over. Returns the finished entry.
   */
  settleIfPassed(
    chatJid: string,
    cursor: string | undefined,
  ): PreStartReplayEntry | undefined {
    const entries = this.load();
    const entry = entries[chatJid];
    if (!entry || !cursor || cursor < entry.heldCursor) return undefined;
    delete entries[chatJid];
    this.persist();
    return entry;
  }

  delete(chatJid: string): void {
    const entries = this.load();
    if (!entries[chatJid]) return;
    delete entries[chatJid];
    this.persist();
  }



  wakeAll(exceptChatJid: string, nowMs: number): number {
    const entries = this.load();
    const nowIso = new Date(nowMs).toISOString();
    let woken = 0;
    for (const [chatJid, entry] of Object.entries(entries)) {
      if (chatJid === exceptChatJid) continue;
      if (!SHARED_PRESTART_REASONS.has(entry.reason)) continue;
      if (parsedMs(entry.nextAttemptAt) <= nowMs) continue;
      entry.nextAttemptAt = nowIso;
      woken += 1;
    }
    if (woken > 0) this.persist();
    return woken;
  }

  /**
   * One pass of the main loop. `expired` series are removed (the caller moves
   * the cursor and says so); `due` ones get their next pause right away, so a
   * queued retry is not queued again on every tick — a failure of the retry
   * sets the pause anew. Chats with a run in progress are left alone.
   */
  tick(input: {
    nowMs: number;
    isActive: (chatJid: string) => boolean;
    loginFingerprint?: () => string | undefined;
  }): {
    due: string[];
    expired: Array<{ chatJid: string; entry: PreStartReplayEntry }>;
  } {
    const entries = this.load();
    const due: string[] = [];
    const expired: Array<{ chatJid: string; entry: PreStartReplayEntry }> = [];
    if (Object.keys(entries).length === 0) return { due, expired };
    let login: string | undefined;
    let loginRead = false;
    let changed = false;
    for (const [chatJid, entry] of Object.entries(entries)) {
      if (input.isActive(chatJid)) continue;
      if (preStartReplayExpired(entry, input.nowMs)) {
        delete entries[chatJid];
        expired.push({ chatJid, entry });
        changed = true;
        continue;
      }
      if (entry.reason === 'auth_error' && !loginRead) {
        loginRead = true;
        try {
          login = input.loginFingerprint?.();
        } catch {
          login = undefined;
        }
      }
      if (!preStartReplayDue(entry, input.nowMs, login)) continue;
      entry.nextAttemptAt = new Date(
        input.nowMs + preStartReplayDelayMs(entry.attempts, entry.reason),
      ).toISOString();
      if (typeof login === 'string' && entry.reason === 'auth_error') {
        entry.loginFingerprint = login;
      }
      due.push(chatJid);
      changed = true;
    }
    if (changed) this.persist();
    return { due, expired };
  }
}

/**
 * A turn failed before Codex started: note it in the chat's series and send
 * the notice — once per series. A later failure (a retry, or a new message
 * that joined the batch) stays silent unless the first notice never arrived.
 *
 * A series already past PRESTART_REPLAY_MAX_AGE_MS ends right here
 * (`expired`): the caller moves the cursor and says so. tick() does that only
 * for an idle chat, and a chat that keeps failing may never be idle on a tick.
 */
export async function holdPreStartFailure(input: {
  book: PreStartReplayBook;
  chatJid: string;
  nowMs: number;
  reason: ProviderFailoverReason;
  heldCursor: string;
  loginFingerprint?: string;
  /** Sends the notice; true when it reached the chat. */
  sendNotice: () => Promise<boolean>;
}): Promise<{
  entry: PreStartReplayEntry;
  firstInSeries: boolean;
  noticeDelivered: boolean;
  expired: boolean;
}> {
  const previous = input.book.get(input.chatJid);
  if (previous && preStartReplayExpired(previous, input.nowMs)) {
    // The newest held message is covered too: it moves past with the rest.
    const { entry } = input.book.noteFailure(input.chatJid, {
      nowMs: input.nowMs,
      reason: input.reason,
      heldCursor: input.heldCursor,
      noticeSent: false,
    });
    input.book.delete(input.chatJid);
    return {
      entry,
      firstInSeries: false,
      noticeDelivered: false,
      expired: true,
    };
  }
  let noticeDelivered = false;
  if (previous?.noticeSent !== true) {
    try {
      noticeDelivered = await input.sendNotice();
    } catch {
      noticeDelivered = false;
    }
  }
  const { entry, firstInSeries } = input.book.noteFailure(input.chatJid, {
    nowMs: input.nowMs,
    reason: input.reason,
    heldCursor: input.heldCursor,
    noticeSent: noticeDelivered,
    loginFingerprint: input.loginFingerprint,
  });
  return { entry, firstInSeries, noticeDelivered, expired: false };
}

/**
 * Fingerprint the host Codex login, falling back to the central copy only
 * when the host auth file is absent. Runner refreshes may rewrite the central
 * file without changing credentials, so compare content rather than mtime.
 * Retain only a short hash, never the authentication tokens themselves.
 */
export function codexLoginFingerprint(input: {
  homeDir: string;
  dataDir: string;
}): string | undefined {
  for (const file of [
    path.join(input.homeDir, '.codex', 'auth.json'),
    path.join(input.dataDir, 'codex-auth', 'auth.json'),
  ]) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue; // absent: try the next one
    }
    try {
      const parsed = JSON.parse(raw) as {
        OPENAI_API_KEY?: unknown;
        tokens?: unknown;
      } | null;
      const credentials = JSON.stringify([
        parsed?.OPENAI_API_KEY ?? null,
        parsed?.tokens ?? null,
      ]);
      return createHash('sha256')
        .update(credentials)
        .digest('hex')
        .slice(0, 16);
    } catch {
      // Caught mid-write: no signal this time, the next tick reads it again.
      return undefined;
    }
  }
  return undefined;
}
