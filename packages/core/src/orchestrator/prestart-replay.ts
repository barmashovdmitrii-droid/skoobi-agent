/**
 * A turn that failed before Codex started is kept and answered later.
 *
 * Such a turn used to get «повтори через минуту» and its messages were
 * marked handled. Neither advice helped once: a login was gone for
 * 25 minutes (401 on every turn) and one sandbox could not
 * reach the provider for a day and a half («workspace routing
 * discovery failed»). The user had to notice the fix himself and ask again.
 *
 * Now the chat's cursor stays where it was, the chat gets ONE notice
 * («сохранил, отвечу сам»), and the held messages are tried again — at once
 * when the Codex login changes or another chat's turn goes through, with
 * every new message of the chat, and after a growing pause (a lost login
 * only seldom: see PRESTART_REPLAY_AUTH_BACKOFF_MS). The model then
 * gets everything that waited in one batch and answers once. After
 * PRESTART_REPLAY_MAX_AGE_MS the series ends with an honest notice and the
 * cursor moves past the held messages.
 *
 * «Before Codex started» is decided by the cause (lost login, failed workspace
 * routing, a lost link, an open breaker) AND by the absence of any sign of
 * work: no answer from the provider, no request to the model, nothing sent,
 * no side effect.
 * Zero tokens alone prove nothing — two turns of September had zero tokens
 * and still answered by voice.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  classifyProviderFailure,
  isProviderLinkFailure,
  type ProviderFailoverReason,
} from './provider-failover.js';

/** How long held messages wait before the series gives up. */
export const PRESTART_REPLAY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Pause before the next try, by failed attempts so far (then the last). */
export const PRESTART_REPLAY_BACKOFF_MS = [2, 5, 10, 20, 40, 60].map(
  (minutes) => minutes * 60 * 1000,
);

/**
 * The same for a lost login, only a fallback. A new login and another chat's
 * turn going through wake the series at once; a try in between gives the
 * same 401 — and a resume that fails on it still writes the held batch into
 * the chat's kept thread, so every timed try left
 * one more copy of the prompt for the first good turn to swallow.
 */
export const PRESTART_REPLAY_AUTH_BACKOFF_MS = [15, 60].map(
  (minutes) => minutes * 60 * 1000,
);

/**
 * «Selected model is at capacity» before the model did anything (W10). Every
 * overload seen in a week lasted 30–70 s and the runner's own 2/15/45 s
 * retries usually outlast it; this hold is for the ones that do not: the
 * message waits and is tried again after 1.5, 5 and 10 minutes (sooner when
 * another chat gets through), then the series ends with an honest notice.
 * The user no longer has to write «Повторяй».
 */
export const PRESTART_REPLAY_OVERLOAD_BACKOFF_MS = [90 * 1000, 5 * 60 * 1000, 10 * 60 * 1000];
export const PRESTART_REPLAY_OVERLOAD_MAX_AGE_MS = 20 * 60 * 1000;

/** Causes every chat shares: one chat getting through means all may. */
const SHARED_PRESTART_REASONS: ReadonlySet<ProviderFailoverReason> = new Set([
  'auth_error',
  'circuit_open',
  'model_overloaded',
]);

/** How long a held series of this cause waits before it gives up. */
export function preStartReplayMaxAgeMs(reason?: ProviderFailoverReason): number {
  return reason === 'model_overloaded'
    ? PRESTART_REPLAY_OVERLOAD_MAX_AGE_MS
    : PRESTART_REPLAY_MAX_AGE_MS;
}

/** An attempt woken by a changed login comes no sooner than this. */
const PRESTART_REPLAY_AUTH_MIN_GAP_MS = 60 * 1000;

/**
 * A series held on a lost link is woken by another chat's success no sooner
 * than this after its own last attempt: a link that flaps cannot turn the
 * wake into a busy loop.
 */
const PRESTART_REPLAY_LINK_WAKE_MIN_GAP_MS = 60 * 1000;

/** Messages that waited at least this long get a note for the model. */
const PRESTART_REPLAY_NOTE_MIN_WAIT_MS = 2 * 60 * 1000;

/**
 * codex fails its workspace routing before the thread starts: «workspace
 * routing discovery failed» (TLS in the sandbox) and «… unauthorized
 * (401)» (lost login).
 */
const CODEX_PRESTART_ERROR_RE = /workspace routing discovery/i;

export interface PreStartReplayEntry {
  /**
   * When the first turn of this series failed (ISO). Kept when the cause
   * changes: the held messages have waited since then.
   */
  firstFailureAt: string;
  /**
   * When the series took its current cause (ISO); absent — since
   * firstFailureAt. The cause's own time limit counts from here.
   */
  reasonSince?: string;
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
  /**
   * reason 'unavailable': the machine's link to Codex is down (network, DNS,
   * the runner's network stop, a routing that timed out) — every chat shares
   * it, so another chat getting through wakes this series too
   * (isMachineLinkFailure). A failed routing of one sandbox is not flagged.
   */
  link?: boolean;
}

/**
 * The machine lost its link to Codex — a cause every chat shares — as opposed
 * to «workspace routing discovery failed», which can be one sandbox's
 * own trouble (one channel failed for a day and a half while another worked).
 * «… timed out» is the network.
 */
export function isMachineLinkFailure(
  reason: ProviderFailoverReason | undefined,
  error: string | undefined,
): boolean {
  return (
    reason === 'unavailable' &&
    isProviderLinkFailure(error) &&
    !/workspace routing discovery failed/i.test(error ?? '')
  );
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
  if (CODEX_PRESTART_ERROR_RE.test(input.error ?? '')) return true;
  // A lost link before the model answered anything (a network gone after a
  // reboot, «Reconnecting…» until the runner's network stop): held and tried
  // again like an overload (W10). «workspace routing discovery timed
  // out» used to pass for our own timeout and was not held: the chat read
  // «Задача длинная… напиши «продолжай»» while Codex was out of reach.
  return input.reason === 'unavailable' && isProviderLinkFailure(input.error);
}

/**
 * A lost link before Codex started (isCodexPreStartFailure with reason
 * 'unavailable'), from the run's raw error. Used where a correction was piped
 * into the attempt (a recoverable deferred checkpoint): 4 of 5 outage
 * failures went that way — no hold, no breaker count, «уточнения прервались…
 * промежуточный результат сохранены» and five quick queue retries ending in
 * «повторите сами» — while J02 held only the fifth.
 */
export function isCodexLinkFailureBeforeStart(input: {
  error?: string;
  providerResponded?: boolean;
  modelRequests?: number;
  /**
   * Tokens the run reported (input + output). The model processed a request
   * — it started: the deferred path keeps the work it did (a held draft).
   */
  usageTokens?: number;
  outputSentToUser?: boolean;
  sideEffected?: boolean;
}): boolean {
  if (!input.error || (input.usageTokens ?? 0) > 0) return false;
  const reason = classifyProviderFailure(new Error(input.error));
  return (
    reason === 'unavailable' &&
    isCodexPreStartFailure({
      reason,
      error: input.error,
      providerResponded: input.providerResponded,
      modelRequests: input.modelRequests,
      outputSentToUser: input.outputSentToUser,
      sideEffected: input.sideEffected,
    })
  );
}

/**
 * The provider refused the turn as overloaded before the model did anything:
 * nothing came back from it (no item, no message), nothing was sent, no side
 * effect (W10). The runner may still have counted one request — codex writes
 * a token_count for the refused request — so model requests do not decide
 * here; the absence of any answer from the provider does. A turn that already
 * worked (a shell command, then «at capacity») is not held: its
 * thread is kept and «продолжай» resumes it.
 */
export function isCodexOverloadHoldable(input: {
  reason?: ProviderFailoverReason;
  providerResponded?: boolean;
  outputSentToUser?: boolean;
  sideEffected?: boolean;
}): boolean {
  return (
    input.reason === 'model_overloaded' &&
    input.providerResponded !== true &&
    input.outputSentToUser !== true &&
    input.sideEffected !== true
  );
}

/**
 * Whether a failed owner turn counts toward the shared provider breaker.
 *
 * A pre-start failure of a cause local to one sandbox (a failed workspace
 * routing) says nothing about the provider: one channel once failed for a
 * day and a half while another worked. Its first failure still counts, so a
 * routing outage that really is global opens the breaker through every
 * chat's first one. The replays and follow-ups of a series already held do
 * not: they have their own pause, and three of them within ten minutes
 * opened the breaker for the owner's healthy chats. A turn holding the
 * half-open probe always settles it, or its lease keeps every other chat out.
 */
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
      : reason === 'model_overloaded'
        ? PRESTART_REPLAY_OVERLOAD_BACKOFF_MS
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

/** When the series took its current cause (see reasonSince). */
function causeSinceMs(entry: PreStartReplayEntry, firstMs: number): number {
  const since = parsedMs(entry.reasonSince);
  return Number.isFinite(since) ? since : firstMs;
}

export function preStartReplayExpired(
  entry: PreStartReplayEntry,
  nowMs: number,
): boolean {
  const first = parsedMs(entry.firstFailureAt);
  // A corrupt entry must not hold a chat forever.
  if (!Number.isFinite(first)) return true;
  // However often the cause changed, nothing waits longer than this.
  if (nowMs - first >= PRESTART_REPLAY_MAX_AGE_MS) return true;
  return (
    nowMs - causeSinceMs(entry, first) >= preStartReplayMaxAgeMs(entry.reason)
  );
}

/**
 * What the notice of an expired series says it waited out: its cause's own
 * limit (an overload — its 20 minutes), or the overall six hours when the
 * series changed its cause late and ran out of those first.
 */
export function preStartReplayExpiredCause(
  entry: PreStartReplayEntry,
  nowMs: number,
): { reason?: ProviderFailoverReason; maxAgeMs: number } {
  const own = preStartReplayMaxAgeMs(entry.reason);
  const first = parsedMs(entry.firstFailureAt);
  if (
    own >= PRESTART_REPLAY_MAX_AGE_MS ||
    !Number.isFinite(first) ||
    nowMs - causeSinceMs(entry, first) >= own
  ) {
    return { reason: entry.reason, maxAgeMs: own };
  }
  return { maxAgeMs: PRESTART_REPLAY_MAX_AGE_MS };
}

export function preStartReplayDue(
  entry: PreStartReplayEntry,
  nowMs: number,
  loginFingerprint?: string,
): boolean {
  const next = parsedMs(entry.nextAttemptAt);
  if (!Number.isFinite(next) || nowMs >= next) return true;
  // The login changed (or appeared) since the last attempt: someone logged in
  // again (the first turn after it went through 10 s later). Not sooner
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

/** Why the held batch waited, in the note's words (W41-ост). */
function preStartPauseCause(reason: ProviderFailoverReason): string {
  switch (reason) {
    case 'auth_error':
      return 'слетел вход в Codex';
    case 'model_overloaded':
      return 'модель была перегружена';
    case 'circuit_open':
      return 'Codex был временно отключён после серии сбоев';
    default:
      return 'Codex был недоступен';
  }
}

const PROMPT_NOTE_TAIL =
  'Если там просьба о действии с последствиями (отправить, удалить, оплатить, изменить что-то вне этого чата) и ждёт она больше 30 мин — сначала коротко переспроси, актуально ли.';

/**
 * The note the model gets with a batch that waited out an outage. The wait
 * counts from the earliest held message when it is older than the first
 * failure: a message had come 1 h 39 min before it, and the note said
 * «ждёт 2 мин» (W41-ост).
 */
export function preStartReplayPromptNote(
  entry: PreStartReplayEntry,
  nowMs: number,
  options: { earliestMessageAt?: string } = {},
): string | null {
  const first = parsedMs(entry.firstFailureAt);
  if (!Number.isFinite(first)) return null;
  const earliest = parsedMs(options.earliestMessageAt);
  const since = Number.isFinite(earliest) ? Math.min(first, earliest) : first;
  const waited = nowMs - since;
  if (waited < PRESTART_REPLAY_NOTE_MIN_WAIT_MS) return null;
  return `[Самое раннее из этих сообщений ждёт ответа уже ${formatWait(waited)}: ${preStartPauseCause(entry.reason)}, теперь снова работает. Ответь на всё одним ответом, о паузе — не больше одной фразы. ${PROMPT_NOTE_TAIL}]`;
}

/** A message that reached the bot this much after Telegram's time was late. */
export const LATE_DELIVERY_NOTE_MIN_LAG_MS = 2 * 60 * 1000;
const LATE_ARRIVALS_MAX = 2000;

export interface LateArrival {
  /** Telegram's time of the earliest late message of the batch. */
  earliestSentMs: number;
  /** The longest gap between Telegram's time and our receipt. */
  maxLagMs: number;
  /** Late messages in the batch. */
  count: number;
}

/**
 * Messages that reached the bot late: received this much after the time
 * Telegram gave them — the bot was down or its polling had stopped, and
 * Telegram handed the backlog over on return (W41-ост). Kept in memory: the
 * backlog arrives in the same process that answers it.
 */
export class LateArrivalBook {
  private readonly lags = new Map<string, { sentMs: number; lagMs: number }>();

  constructor(private readonly max = LATE_ARRIVALS_MAX) {}

  /** Returns the lag when the message was late, else null. */
  note(
    chatJid: string,
    messageId: string,
    sentAt: string,
    receivedAtMs: number,
  ): number | null {
    const sentMs = parsedMs(sentAt);
    if (!Number.isFinite(sentMs)) return null;
    const lagMs = receivedAtMs - sentMs;
    if (lagMs < LATE_DELIVERY_NOTE_MIN_LAG_MS) return null;
    const key = `${chatJid}\0${messageId}`;
    this.lags.delete(key);
    this.lags.set(key, { sentMs, lagMs });
    while (this.lags.size > this.max) {
      const oldest = this.lags.keys().next().value;
      if (oldest === undefined) break;
      this.lags.delete(oldest);
    }
    return lagMs;
  }

  lateFor(chatJid: string, messageIds: readonly string[]): LateArrival | null {
    let result: LateArrival | null = null;
    for (const id of messageIds) {
      const lag = this.lags.get(`${chatJid}\0${id}`);
      if (!lag) continue;
      result = result
        ? {
            earliestSentMs: Math.min(result.earliestSentMs, lag.sentMs),
            maxLagMs: Math.max(result.maxLagMs, lag.lagMs),
            count: result.count + 1,
          }
        : { earliestSentMs: lag.sentMs, maxLagMs: lag.lagMs, count: 1 };
    }
    return result;
  }
}

/** The note the model gets with a batch that reached the bot late. */
export function lateDeliveryPromptNote(late: LateArrival, nowMs: number): string {
  return `[Часть этих сообщений дошла до бота с опозданием: самое раннее отправлено ${formatWait(nowMs - late.earliestSentMs)} назад, а бот получил его только через ${formatWait(late.maxLagMs)} — бот был недоступен. Ответь на всё одним ответом, о задержке — не больше одной фразы. ${PROMPT_NOTE_TAIL}]`;
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
            ...(typeof entry.reasonSince === 'string'
              ? { reasonSince: entry.reasonSince }
              : {}),
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
            ...(entry.link === true ? { link: true } : {}),
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
      /** See PreStartReplayEntry.link. */
      link?: boolean;
    },
  ): { entry: PreStartReplayEntry; firstInSeries: boolean } {
    const entries = this.load();
    const previous = entries[chatJid];
    const nowIso = new Date(input.nowMs).toISOString();
    // An open breaker only skipped this attempt: the series keeps the cause
    // it was held for (a lost login stays one — its wake and its schedule).
    const reason =
      input.reason === 'circuit_open' && previous
        ? previous.reason
        : input.reason;
    // Another cause within the series (the login came back, then «at
    // capacity»): its own count and limit start now. Kept, the 20 minutes of
    // an overload counted from a login lost 40 minutes earlier ended the
    // series at the next tick with «перегружен все 20 мин» and none of its
    // 1.5/5/10-minute tries (review r1108). firstFailureAt stays — the
    // messages have waited since then, and the six hours cap the whole
    // series; the notice already sent is not sent again (noticeSent).
    const causeChanged = previous !== undefined && previous.reason !== reason;
    const attempts = previous && !causeChanged ? previous.attempts + 1 : 1;
    // The breaker only skipped this attempt: the series keeps its flag, like
    // its cause. Otherwise the attempt itself says whether the link was down.
    const link =
      input.reason === 'circuit_open' && previous
        ? previous.link === true
        : reason === 'unavailable' && input.link === true;
    const reasonSince = causeChanged ? nowIso : previous?.reasonSince;
    const entry: PreStartReplayEntry = {
      firstFailureAt: previous?.firstFailureAt ?? nowIso,
      ...(reasonSince !== undefined ? { reasonSince } : {}),
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
      ...(link ? { link: true } : {}),
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

  /**
   * Another chat's turn went through: try now every series held for a cause
   * all chats share (the account's login, the provider's breaker, the
   * machine's lost link — entry.link). A failed workspace routing may be one
   * sandbox's own trouble — one channel once failed for a day and a half
   * while another worked — so it keeps its pause. Without the link wake, a
   * series in its 40- or 60-minute pause answered up to an hour after the
   * network came back, though its notice says «отвечу сам, как только
   * заработает».
   */
  wakeAll(exceptChatJid: string, nowMs: number): number {
    const entries = this.load();
    const nowIso = new Date(nowMs).toISOString();
    let woken = 0;
    for (const [chatJid, entry] of Object.entries(entries)) {
      if (chatJid === exceptChatJid) continue;
      const shared = SHARED_PRESTART_REASONS.has(entry.reason);
      const linkDown = entry.reason === 'unavailable' && entry.link === true;
      if (!shared && !linkDown) continue;
      if (parsedMs(entry.nextAttemptAt) <= nowMs) continue;
      if (
        !shared &&
        nowMs - parsedMs(entry.lastAttemptAt) < PRESTART_REPLAY_LINK_WAKE_MIN_GAP_MS
      ) {
        continue;
      }
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
  /** See PreStartReplayEntry.link. */
  link?: boolean;
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
    // The series ran out on its own cause, and its notice says that one.
    const { entry } = input.book.noteFailure(input.chatJid, {
      nowMs: input.nowMs,
      reason: previous.reason,
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
    link: input.link,
  });
  return { entry, firstInSeries, noticeDelivered, expired: false };
}

/**
 * Fingerprint of the Codex login a new `codex login` would change: the
 * operator's ~/.codex/auth.json (written by `codex login` and the desktop app,
 * never by the bot). Only on a machine without it, the bot's central copy.
 *
 * The central copy is no signal while the host file exists: the runner
 * rewrites it after every main-chat run, a failed one included
 * (prepareCodexHomeForRun, then persistTrustedCodexAuthRefresh), so its mtime
 * moved every few minutes and two chats held on a lost login woke each other
 * in turn. The content decides, not the mtime: a copy with the same tokens is
 * the same login. A short hash only, never the tokens themselves.
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
