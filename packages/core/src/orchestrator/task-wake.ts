// Пустые проверки без модели (W26, этап 1).
//
// За одну неделю 18 из 61 фонового запуска закончились словами «Новых
// сообщений нет» / «Файл готовности ещё отсутствует» — каждый раз полный ход
// модели на xhigh. Задаче-слежке можно дать условие пробуждения wake_if, и хост
// проверяет его сам, ничего не запуская:
//   path_changed — файл или папка внутри папки группы появились, исчезли или
//                  у них изменились размер или время правки (только stat);
//   new_messages — в чате (своём или, для задачи владельца, в chat_jid)
//                  появились входящие сообщения после последнего пробуждения.
// Нет изменений — запуск записывается как skipped, без модели и agent_runs.
// Раз в max_sleep_hours (по умолчанию 6) модель будится всё равно — на случай,
// если условие сломано. Срок expires_at сам закрывает слежку.
//
// Этап 2 (скрипт-проверка wake_if.script) здесь сознательно не сделан.
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import type { ScheduledTask } from './types.js';

export const DEFAULT_WAKE_MAX_SLEEP_HOURS = 6;
const MAX_WAKE_PATH_CHARS = 512;
const MAX_CHAT_JID_CHARS = 256;

export interface WakeIf {
  /** Path relative to the group folder. */
  path_changed?: string;
  /** Incoming messages in the task's chat (or in chat_jid). */
  new_messages?: boolean;
  /** Another chat to watch for new_messages (owner tasks in main only). */
  chat_jid?: string;
  /** The model is woken at least this often anyway. */
  max_sleep_hours?: number;
}

export interface WakePathSignature {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
}

/** What the task saw when the model was last woken (or at creation). */
export interface WakeState {
  last_wake_at: string;
  path?: WakePathSignature | null;
  message_seq?: number;
}

export type WakeIfParse =
  | { ok: true; value: WakeIf }
  | { ok: false; reason: string };

const WAKE_IF_KEYS = new Set([
  'path_changed',
  'new_messages',
  'chat_jid',
  'max_sleep_hours',
]);

/** Lexically safe relative path, or null. */
export function normalizeWakePath(raw: string): string | null {
  if (
    !raw.trim() ||
    raw.length > MAX_WAKE_PATH_CHARS ||
    raw.includes('\0') ||
    path.isAbsolute(raw) ||
    raw.startsWith('~')
  ) {
    return null;
  }
  const normalized = path.posix.normalize(raw.trim().replace(/\\/g, '/'));
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/')
  ) {
    return null;
  }
  return normalized.replace(/\/+$/u, '');
}

/** The wake_if of a schedule_task envelope: strict, unknown keys refused. */
export function parseWakeIfInput(raw: unknown): WakeIfParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'wake_if_not_object' };
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!WAKE_IF_KEYS.has(key))
      return { ok: false, reason: `wake_if_unknown_${key}` };
  }
  const value: WakeIf = {};
  if (input.path_changed !== undefined) {
    if (typeof input.path_changed !== 'string') {
      return { ok: false, reason: 'wake_if_path_not_string' };
    }
    const normalized = normalizeWakePath(input.path_changed);
    if (!normalized) return { ok: false, reason: 'wake_if_path_outside_group' };
    value.path_changed = normalized;
  }
  if (input.new_messages !== undefined) {
    if (typeof input.new_messages !== 'boolean') {
      return { ok: false, reason: 'wake_if_new_messages_not_boolean' };
    }
    if (input.new_messages) value.new_messages = true;
  }
  if (input.chat_jid !== undefined) {
    if (
      typeof input.chat_jid !== 'string' ||
      !input.chat_jid.trim() ||
      input.chat_jid.length > MAX_CHAT_JID_CHARS
    ) {
      return { ok: false, reason: 'wake_if_chat_jid_invalid' };
    }
    if (!value.new_messages) {
      return { ok: false, reason: 'wake_if_chat_jid_without_new_messages' };
    }
    value.chat_jid = input.chat_jid.trim();
  }
  if (input.max_sleep_hours !== undefined) {
    const hours = input.max_sleep_hours;
    if (
      typeof hours !== 'number' ||
      !Number.isInteger(hours) ||
      hours < 1 ||
      hours > 24
    ) {
      return { ok: false, reason: 'wake_if_max_sleep_hours_invalid' };
    }
    value.max_sleep_hours = hours;
  }
  if (!value.path_changed && !value.new_messages) {
    return { ok: false, reason: 'wake_if_empty' };
  }
  return { ok: true, value };
}

/** Stored wake_if of a row; null when absent or unreadable. */
export function storedWakeIf(
  task: Pick<ScheduledTask, 'wake_if' | 'schedule_type'>,
): WakeIf | null {
  // A once-task has no next check: skipping it would end the task, and the
  // model that would schedule the next step never runs (W26, 11 of 18).
  if (!task.wake_if || task.schedule_type === 'once') return null;
  try {
    const parsed = parseWakeIfInput(JSON.parse(task.wake_if));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

function storedWakeState(raw: string | null | undefined): WakeState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WakeState;
    if (!parsed || typeof parsed.last_wake_at !== 'string') return null;
    if (Number.isNaN(Date.parse(parsed.last_wake_at))) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * stat of a path inside the group folder, never outside it: the path and the
 * deepest existing part of it must resolve (symlinks included) inside the
 * folder. null — unsafe or unreadable; the condition then does not fire, and
 * the periodic wake still comes.
 */
export function readWakePathSignature(
  groupDir: string,
  relativePath: string,
): WakePathSignature | null {
  let root: string;
  try {
    root = fs.realpathSync(groupDir);
  } catch (err) {
    // The group folder (host-made path) is not there yet: nothing in it is.
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { exists: false }
      : null;
  }
  const target = path.resolve(root, relativePath);
  if (!isWithin(root, target)) return null;
  let probe = target;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      if (!isWithin(root, real)) return null;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const parent = path.dirname(probe);
      if (parent === probe || !isWithin(root, parent)) return null;
      probe = parent;
    }
  }
  if (probe !== target) return { exists: false };
  try {
    const stat = fs.statSync(target);
    return {
      exists: true,
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

/** Newest message (any author) of the chat, by host ingestion order. */
export function latestMessageSequence(
  db: Database.Database,
  chatJid: string,
): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS seq FROM message_ingestion WHERE chat_jid = ?',
    )
    .get(chatJid) as { seq: number } | undefined;
  return Number(row?.seq) || 0;
}

/** Incoming (not the bot's) messages of the chat after `afterSeq`. */
export function incomingMessagesSince(
  db: Database.Database,
  chatJid: string,
  afterSeq: number,
): { count: number; latestSeq: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN COALESCE(m.is_bot_message, 0) = 0 THEN 1 ELSE 0 END), 0) AS incoming,
              COALESCE(MAX(mi.sequence), ?) AS latest
         FROM message_ingestion mi
         JOIN messages m ON m.id = mi.id AND m.chat_jid = mi.chat_jid
        WHERE mi.chat_jid = ? AND mi.sequence > ?`,
    )
    .get(afterSeq, chatJid, afterSeq) as
    | { incoming: number; latest: number }
    | undefined;
  return {
    count: Number(row?.incoming) || 0,
    latestSeq: Number(row?.latest) || afterSeq,
  };
}

export interface WakeContext {
  groupDir: string;
  db: Database.Database;
  /** The task's own chat: the default for new_messages. */
  chatJid: string;
  now: number;
}

/** What the conditions look like right now: the baseline at creation. */
export function captureWakeState(wakeIf: WakeIf, ctx: WakeContext): WakeState {
  const state: WakeState = { last_wake_at: new Date(ctx.now).toISOString() };
  if (wakeIf.path_changed) {
    state.path = readWakePathSignature(ctx.groupDir, wakeIf.path_changed);
  }
  if (wakeIf.new_messages) {
    state.message_seq = latestMessageSequence(
      ctx.db,
      wakeIf.chat_jid || ctx.chatJid,
    );
  }
  return state;
}

/**
 * The panel's «Запустить сейчас» (packages/dashboard actions.ts, task_run_now)
 * sets this key in wake_state next to next_run = now: the next due check wakes
 * the model whatever the condition says. Without it a watch with nothing new
 * was skipped as «без изменений», although the panel promised a run. The
 * state saved after a successful run is built anew, so the flag goes with
 * it; after an error it stays, like an unseen change.
 */
export const WAKE_RUN_NOW_KEY = 'run_now';

function manualWakeRequested(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      parsed[WAKE_RUN_NOW_KEY] === true
    );
  } catch {
    return false;
  }
}

export interface WakeDecision {
  wake: boolean;
  reason: 'changed' | 'manual' | 'max_sleep' | 'no_baseline' | 'unchanged';
  /** For the model: what the host saw (only when it wakes). */
  note?: string;
  /** Saved after a successful run (not on a skip, not after an error). */
  nextState?: WakeState;
}

function describePathChange(
  relativePath: string,
  before: WakePathSignature | null | undefined,
  now: WakePathSignature,
): string | null {
  if (!before) return now.exists ? `«${relativePath}» есть` : null;
  if (!before.exists && now.exists) return `появился «${relativePath}»`;
  if (before.exists && !now.exists) return `исчез «${relativePath}»`;
  if (!now.exists) return null;
  if (before.size !== now.size) {
    return `изменился «${relativePath}» (размер ${before.size ?? '?'} → ${now.size ?? '?'} байт)`;
  }
  if (before.mtimeMs !== now.mtimeMs) {
    return `изменился «${relativePath}» (время правки)`;
  }
  return null;
}

/**
 * Whether a due run of this task needs the model. Never throws on a broken
 * condition: an unreadable path or chat simply does not fire, and the
 * periodic wake (max_sleep_hours) still comes.
 */
export function evaluateTaskWake(
  task: Pick<ScheduledTask, 'wake_state'>,
  wakeIf: WakeIf,
  ctx: WakeContext,
): WakeDecision {
  const state = storedWakeState(task.wake_state);
  const nextState: WakeState = {
    last_wake_at: new Date(ctx.now).toISOString(),
  };
  const changes: string[] = [];

  if (wakeIf.path_changed) {
    const signature = readWakePathSignature(ctx.groupDir, wakeIf.path_changed);
    if (signature === null) {
      nextState.path = state?.path ?? null;
    } else {
      nextState.path = signature;
      if (state) {
        const change = describePathChange(
          wakeIf.path_changed,
          state.path,
          signature,
        );
        if (change) changes.push(change);
      }
    }
  }

  if (wakeIf.new_messages) {
    const chatJid = wakeIf.chat_jid || ctx.chatJid;
    if (state && typeof state.message_seq === 'number') {
      const seen = incomingMessagesSince(ctx.db, chatJid, state.message_seq);
      nextState.message_seq = seen.latestSeq;
      if (seen.count > 0) {
        changes.push(
          chatJid === ctx.chatJid
            ? `в этом чате новых входящих сообщений: ${seen.count}`
            : `в чате ${chatJid} новых входящих сообщений: ${seen.count}`,
        );
      }
    } else {
      nextState.message_seq = latestMessageSequence(ctx.db, chatJid);
    }
  }

  if (manualWakeRequested(task.wake_state)) {
    return {
      wake: true,
      reason: 'manual',
      note: `[Хост: задачу запустили вручную из панели — модель разбужена без проверки условия пробуждения (wake_if)${
        changes.length > 0 ? `; заодно изменилось: ${changes.join('; ')}` : ''
      }.]`,
      nextState,
    };
  }
  if (!state) {
    return {
      wake: true,
      reason: 'no_baseline',
      note: '[Хост: первая проверка условия пробуждения (wake_if) — исходного состояния не было, поэтому модель разбужена.]',
      nextState,
    };
  }
  if (changes.length > 0) {
    return {
      wake: true,
      reason: 'changed',
      note: `[Хост: условие пробуждения сработало — ${changes.join('; ')}. Проверки без изменений хост пропускал сам, без запуска модели.]`,
      nextState,
    };
  }
  const maxSleepHours = wakeIf.max_sleep_hours ?? DEFAULT_WAKE_MAX_SLEEP_HOURS;
  const sleptMs = ctx.now - Date.parse(state.last_wake_at);
  if (sleptMs >= maxSleepHours * 60 * 60 * 1000) {
    return {
      wake: true,
      reason: 'max_sleep',
      note: `[Хост: условие пробуждения (wake_if) не срабатывало ${Math.floor(sleptMs / 3_600_000)} ч — это плановая проверка раз в ${maxSleepHours} ч. Проверь, что условие всё ещё верное.]`,
      nextState,
    };
  }
  return { wake: false, reason: 'unchanged' };
}

// --- expires_at ---------------------------------------------------------------

/**
 * expires_at of a schedule_task envelope as an ISO string: local time like a
 * once-task's schedule_value, strictly in the future. null — invalid.
 */
export function parseTaskExpiresAt(raw: unknown, now: number): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 64) return null;
  const at = new Date(raw.trim()).getTime();
  if (Number.isNaN(at) || at <= now) return null;
  return new Date(at).toISOString();
}

/** A recurring task with a passed expires_at: ends instead of running. */
export function taskExpired(
  task: Pick<ScheduledTask, 'expires_at' | 'schedule_type'>,
  now: number,
): boolean {
  if (!task.expires_at || task.schedule_type === 'once') return false;
  const at = Date.parse(task.expires_at);
  return !Number.isNaN(at) && at <= now;
}

/**
 * The next run never goes past the expiry: the task then comes due exactly at
 * expires_at, and the scheduler closes it and says so in the chat.
 */
export function capNextRunAtExpiry(
  nextRun: string | null,
  task: Pick<ScheduledTask, 'expires_at' | 'schedule_type'>,
): string | null {
  if (!nextRun || !task.expires_at || task.schedule_type === 'once') {
    return nextRun;
  }
  const at = Date.parse(task.expires_at);
  if (Number.isNaN(at)) return nextRun;
  return Date.parse(nextRun) > at ? new Date(at).toISOString() : nextRun;
}
