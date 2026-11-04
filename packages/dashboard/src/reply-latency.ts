import type Database from 'better-sqlite3';

import { logger } from '@skoobi/shared/logger';

import { readDb } from './db.js';
import { formatDuration } from './humanize.js';

// «Сколько ждут ответа»: сколько человек на самом деле ждал —
// первого признака жизни и окончательного ответа. Считается целиком из того,
// что бот УЖЕ пишет в events (входящие, исходящие с trigger_type/meta_kind,
// session_finished с тарифом и усилием), поэтому сам бот не меняется.
//
// agent_runs.duration_ms для этого не годится: это вся жизнь процесса,
// включая ~15 с ожидания новых сообщений после ответа (RUNNER_IDLE_WAIT_MS) и
// несколько вопросов подряд, склеенных в один запуск. Панель показывает его
// рядом, но подписывает честно — «время работы машины», а не «время ответа».

/**
 * One question → answer cycle. It opens with the first inbound message while
 * nothing is open and absorbs every follow-up until the first final reply:
 * three messages sent in a row are one wait, not three.
 */
export type ReplySeries = {
  chatJid: string;
  /** Telegram/WhatsApp time of the first message (not when the host saw it). */
  startedAt: number;
  /** Host time the first message was recorded; used to match runs to it. */
  receivedAt: number;
  messages: number;
  firstSignAt: number | null;
  finalAt: number | null;
  outcome: 'answered' | 'unanswered' | 'open';
  tier: TierKey;
  effort: string | null;
};

export type TierKey = 'fast' | 'dropped' | 'standard' | 'unknown';

export type LatencyEventRow = {
  created_at: number;
  type: string;
  channel: string | null;
  chat_id: string | null;
  jid: string | null;
  trigger_type: string | null;
  meta_kind: string | null;
  msg_timestamp: string | null;
  is_bot_message: number | null;
  status: string | null;
  duration_ms: number | null;
  service_tier: string | null;
  tier_known: number | null;
  fast_dropped: number | null;
  reasoning_effort: string | null;
};

export type LatencyStats = {
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
  /** «Ответов дольше 5 минут» — count and share of `count`. */
  over5m: number;
  over5mShare: number | null;
  median: string;
  p90: string;
};

export type MachineStats = {
  runs: number;
  medianMs: number | null;
  p90Ms: number | null;
  median: string;
  p90: string;
};

export type ReplyWindowSummary = {
  /** Series that are finished one way or another (waiting ones excluded). */
  series: number;
  answered: number;
  unanswered: number;
  waiting: number;
  first: LatencyStats;
  final: LatencyStats;
  machine: MachineStats | null;
};

export type ReplyLatencyChat = ReplyWindowSummary & {
  jid: string;
  name: string;
  channel: 'telegram' | 'whatsapp';
};

export type ReplyBreakdownRow = {
  key: string;
  label: string;
  final: LatencyStats;
};

export type ReplyLatencyWindow = {
  days: number;
  all: ReplyWindowSummary;
  chats: ReplyLatencyChat[];
  byTier: ReplyBreakdownRow[];
  byEffort: ReplyBreakdownRow[];
};

export type ReplyLatencyReport = {
  generatedAt: string;
  windows: ReplyLatencyWindow[];
};

const INBOUND_TYPES = new Set([
  'telegram_inbound_message',
  'whatsapp_inbound_message',
]);
const OUTBOUND_TYPES = new Set([
  'telegram_outbound_message',
  'whatsapp_outbound_message',
]);

/**
 * Outbound trigger types a person sees as «the bot is on it». task-result is
 * a scheduled task talking on its own — not an answer to anything asked.
 */
const SIGN_OF_LIFE_TRIGGERS = new Set(['agent-response', 'extension', 'ipc']);

/**
 * agent-response kinds that are NOT the answer: the model's interim «⏳ …»
 * lines and the reply to «ау» while a run is busy. Every other
 * agent-response — plain text, a failure notice, «Остановил.» — ends the wait.
 */
const INTERIM_REPLY_KINDS = new Set(['agent_progress', 'active_run_status']);

const OVER_LIMIT_MS = 5 * 60_000;
/** An open series younger than this is «ждут сейчас», older — «без ответа». */
const WAITING_GRACE_MS = 2 * 3600_000;
/**
 * Silence inside an open series after which a new message starts a new one.
 * Longer than the supported turn budget, but bounded so unanswered
 * messages cannot swallow the following day.
 */
const STALE_GAP_MS = 6 * 3600_000;
/** Telegram keeps undelivered updates for a day; older message times are noise. */
const MAX_DELIVERY_DELAY_MS = 24 * 3600_000;
/** Lookback before the widest window so a series straddling its edge is whole. */
const LOOKBACK_MS = 6 * 3600_000;
/** Slack between a run's recorded start and its first delivery. */
const RUN_MATCH_SLACK_MS = 5_000;
const WINDOWS_DAYS = [7, 30] as const;

/**
 * Message time as the person sent it. Telegram stores second precision with
 * a message id fused into a fractional suffix. Date.parse rejects extended
 * fractions, so keep only the first three fractional digits.
 */
export function parseMessageTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/u);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}.${(m[2] || '0').slice(0, 3).padEnd(3, '0')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function inboundStart(row: LatencyEventRow): number {
  const sent = parseMessageTime(row.msg_timestamp);
  // A voice note is recorded only after transcription (~3–6 s later), so the
  // send time is the honest start. A time from the future or from days ago
  // is clock noise / a replay, and the host time is safer.
  if (
    sent !== null &&
    sent <= row.created_at + RUN_MATCH_SLACK_MS &&
    sent >= row.created_at - MAX_DELIVERY_DELAY_MS
  ) {
    return Math.min(sent, row.created_at);
  }
  return row.created_at;
}

function rowJid(row: LatencyEventRow): string | null {
  if (row.jid) return row.jid;
  if (!row.chat_id) return null;
  return row.channel === 'telegram' ? `tg:${row.chat_id}` : row.chat_id;
}

function tierOf(row: LatencyEventRow): TierKey {
  if (row.fast_dropped === 1) return 'dropped';
  if (row.service_tier === 'priority') return 'fast';
  if (row.tier_known === 1) return 'standard';
  return 'unknown';
}

type OpenSeries = ReplySeries & {
  /** Last delivery through the send_message tool (voice, document, text). */
  lastIpcAt: number | null;
  /** Last inbound or sign of life; drives the stale-gap split. */
  lastActivityAt: number;
};

/**
 * Walk the events of every chat in time order and cut them into series.
 *
 * Besides «the first final agent-response ends the wait», three rules keep
 * series from bleeding into each other:
 *  - a run that answered only through the send_message tool (a voice note, a
 *    document) ends with no final agent-response; its session_finished closes
 *    the series at the last such delivery;
 *  - a run that started for this series and finished successfully without a
 *    final reply leaves the question unanswered — without this, a silent
 *    «спасибо» would merge with tomorrow's question into a day-long «wait»;
 *  - a message that arrives after STALE_GAP_MS of silence in an open series
 *    (no run was ever started for the earlier one — a chat the bot does not
 *    answer by design, an outage) closes the old series as unanswered
 *    instead of stretching it over days.
 */
export function buildReplySeries(
  rows: readonly LatencyEventRow[],
): ReplySeries[] {
  const done: ReplySeries[] = [];
  const open = new Map<string, OpenSeries>();
  // Answered series whose run has not reported its tier/effort yet.
  const awaitingRun = new Map<string, ReplySeries[]>();

  const close = (
    jid: string,
    series: OpenSeries,
    outcome: 'answered' | 'unanswered',
    finalAt: number | null,
  ): void => {
    open.delete(jid);
    const {
      lastIpcAt: _lastIpcAt,
      lastActivityAt: _activity,
      ...rest
    } = series;
    const closed: ReplySeries = { ...rest, outcome, finalAt };
    done.push(closed);
    if (outcome === 'answered') {
      const list = awaitingRun.get(jid) || [];
      list.push(closed);
      awaitingRun.set(jid, list);
    }
  };

  for (const row of rows) {
    const jid = rowJid(row);
    if (!jid) continue;
    let current = open.get(jid);

    if (INBOUND_TYPES.has(row.type)) {
      if (row.is_bot_message === 1) continue;
      const start = inboundStart(row);
      if (current && row.created_at - current.lastActivityAt > STALE_GAP_MS) {
        close(jid, current, 'unanswered', null);
        current = undefined;
      }
      if (!current) {
        open.set(jid, {
          chatJid: jid,
          startedAt: start,
          receivedAt: row.created_at,
          messages: 1,
          firstSignAt: null,
          finalAt: null,
          outcome: 'open',
          tier: 'unknown',
          effort: null,
          lastIpcAt: null,
          lastActivityAt: row.created_at,
        });
      } else {
        current.messages += 1;
        current.startedAt = Math.min(current.startedAt, start);
        current.lastActivityAt = row.created_at;
      }
      continue;
    }

    if (OUTBOUND_TYPES.has(row.type)) {
      if (!current) continue;
      const trigger = row.trigger_type || '';
      if (!SIGN_OF_LIFE_TRIGGERS.has(trigger)) continue;
      if (current.firstSignAt === null) current.firstSignAt = row.created_at;
      current.lastActivityAt = row.created_at;
      if (trigger === 'ipc') current.lastIpcAt = row.created_at;
      if (
        trigger === 'agent-response' &&
        !INTERIM_REPLY_KINDS.has(row.meta_kind || '')
      ) {
        close(jid, current, 'answered', row.created_at);
      }
      continue;
    }

    if (row.type === 'session_finished') {
      const runStart =
        typeof row.duration_ms === 'number' && row.duration_ms >= 0
          ? row.created_at - row.duration_ms
          : null;
      const tier = tierOf(row);
      const effort = row.reasoning_effort || null;

      if (current && row.status === 'success') {
        if (
          current.lastIpcAt !== null &&
          (runStart === null ||
            current.lastIpcAt >= runStart - RUN_MATCH_SLACK_MS)
        ) {
          close(jid, current, 'answered', current.lastIpcAt);
        } else if (runStart !== null && runStart >= current.receivedAt) {
          // Only a run that began after the question can have consumed it;
          // a message that landed in the previous run's idle tail is picked
          // up by the next run instead.
          close(jid, current, 'unanswered', null);
        }
      }

      const waiting = awaitingRun.get(jid);
      if (waiting) {
        for (const series of waiting) {
          if (
            series.finalAt !== null &&
            series.finalAt <= row.created_at &&
            (runStart === null ||
              series.finalAt >= runStart - RUN_MATCH_SLACK_MS)
          ) {
            series.tier = tier;
            series.effort = effort;
          }
        }
        awaitingRun.delete(jid);
      }
    }
  }

  for (const series of open.values()) {
    const {
      lastIpcAt: _lastIpcAt,
      lastActivityAt: _activity,
      ...rest
    } = series;
    done.push(rest);
  }
  return done.sort((a, b) => a.startedAt - b.startedAt);
}

/** Linear-interpolated percentile. */
export function percentile(
  sorted: readonly number[],
  p: number,
): number | null {
  if (sorted.length === 0) return null;
  const k = (sorted.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

function fmt(ms: number | null): string {
  return ms === null ? '—' : formatDuration(ms);
}

export function latencyStats(values: readonly number[]): LatencyStats {
  const sorted = [...values].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);
  const over5m = sorted.filter((v) => v > OVER_LIMIT_MS).length;
  return {
    count: sorted.length,
    medianMs: median === null ? null : Math.round(median),
    p90Ms: p90 === null ? null : Math.round(p90),
    over5m,
    over5mShare: sorted.length ? over5m / sorted.length : null,
    median: fmt(median),
    p90: fmt(p90),
  };
}

function machineStats(durations: readonly number[]): MachineStats | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);
  return {
    runs: sorted.length,
    medianMs: median === null ? null : Math.round(median),
    p90Ms: p90 === null ? null : Math.round(p90),
    median: fmt(median),
    p90: fmt(p90),
  };
}

function isWaiting(series: ReplySeries, now: number): boolean {
  return series.outcome === 'open' && now - series.startedAt < WAITING_GRACE_MS;
}

function summarize(
  series: readonly ReplySeries[],
  now: number,
  machine: MachineStats | null,
): ReplyWindowSummary {
  const settled = series.filter((s) => !isWaiting(s, now));
  const answered = settled.filter(
    (s) => s.outcome === 'answered' && s.finalAt !== null,
  );
  return {
    series: settled.length,
    answered: answered.length,
    unanswered: settled.length - answered.length,
    waiting: series.length - settled.length,
    first: latencyStats(
      settled
        .filter((s) => s.firstSignAt !== null)
        .map((s) => (s.firstSignAt as number) - s.startedAt),
    ),
    final: latencyStats(
      answered.map((s) => (s.finalAt as number) - s.startedAt),
    ),
    machine,
  };
}

const TIER_LABELS: Record<TierKey, string> = {
  fast: 'Быстрый тариф',
  dropped: 'Быстрый снят из-за квоты',
  standard: 'Обычный тариф',
  unknown: 'Тариф не записан',
};

function breakdown(
  answered: readonly ReplySeries[],
  keyOf: (s: ReplySeries) => string,
  labelOf: (key: string) => string,
  order: readonly string[] = [],
): ReplyBreakdownRow[] {
  const groups = new Map<string, number[]>();
  for (const s of answered) {
    const key = keyOf(s);
    const list = groups.get(key) || [];
    list.push((s.finalAt as number) - s.startedAt);
    groups.set(key, list);
  }
  const rank = (key: string) => {
    const i = order.indexOf(key);
    return i === -1 ? order.length : i;
  };
  return [...groups.entries()]
    .map(([key, values]) => ({
      key,
      label: labelOf(key),
      final: latencyStats(values),
    }))
    .sort(
      (a, b) =>
        rank(a.key) - rank(b.key) ||
        b.final.count - a.final.count ||
        a.key.localeCompare(b.key),
    );
}

const EFFORT_ORDER = ['xhigh', 'high', 'medium', 'low', 'minimal', 'unknown'];

function chatChannel(jid: string): 'telegram' | 'whatsapp' {
  return jid.startsWith('tg:') ? 'telegram' : 'whatsapp';
}

/** A registered name that is just a phone number is shown masked. */
function chatLabel(name: string | undefined, jid: string): string {
  const clean = String(name || '').trim();
  const digits = clean.replace(/\D/gu, '');
  if (clean && !(digits.length >= 5 && /^\+?[\d\s().-]+$/u.test(clean))) {
    return clean;
  }
  const suffix = jid.replace(/\D/gu, '').slice(-4);
  return suffix ? `Чат •••• ${suffix}` : 'Чат';
}

type RunRow = { chat_jid: string; duration_ms: number; run_at: string };

function readMachineRuns(db: Database.Database, sinceIso: string): RunRow[] {
  try {
    return db
      .prepare(
        `SELECT chat_jid, duration_ms, run_at FROM agent_runs
          WHERE trigger_type = 'message' AND status = 'success'
            AND run_at >= ? AND duration_ms > 0`,
      )
      .all(sinceIso) as RunRow[];
  } catch (err) {
    // Older instance without the table: the tile still works, just without
    // the «время работы машины» line.
    logger.warn({ err }, 'dashboard: agent_runs read failed');
    return [];
  }
}

export function readLatencyEvents(
  db: Database.Database,
  since: number,
): LatencyEventRow[] {
  // json_extract keeps the reply texts out of the panel process; json_valid
  // keeps one malformed payload from failing the whole tile. json_type tells
  // «tier recorded as null» from «tier not recorded at all».
  return db
    .prepare(
      `SELECT created_at, type, channel, chat_id,
              COALESCE(json_extract(payload_json, '$.chat_jid'),
                       json_extract(payload_json, '$.reply_jid')) AS jid,
              json_extract(payload_json, '$.trigger_type') AS trigger_type,
              json_extract(payload_json, '$.meta_kind') AS meta_kind,
              json_extract(payload_json, '$.timestamp') AS msg_timestamp,
              json_extract(payload_json, '$.is_bot_message') AS is_bot_message,
              json_extract(payload_json, '$.status') AS status,
              json_extract(payload_json, '$.duration_ms') AS duration_ms,
              json_extract(payload_json, '$.service_tier') AS service_tier,
              (json_type(payload_json, '$.service_tier') IS NOT NULL OR
               json_type(payload_json, '$.requested_service_tier') IS NOT NULL) AS tier_known,
              json_extract(payload_json, '$.fast_tier_dropped_for_quota') AS fast_dropped,
              json_extract(payload_json, '$.reasoning_effort') AS reasoning_effort
         FROM events
        WHERE type IN ('telegram_inbound_message', 'whatsapp_inbound_message',
                       'telegram_outbound_message', 'whatsapp_outbound_message',
                       'session_finished')
          AND created_at >= ?
          AND json_valid(payload_json)
        ORDER BY created_at, rowid`,
    )
    .all(since) as LatencyEventRow[];
}

export function collectReplyLatency(
  now: number = Date.now(),
  db: Database.Database = readDb(),
): ReplyLatencyReport {
  const widest = Math.max(...WINDOWS_DAYS) * 86400_000;
  const names = new Map<string, string>();
  for (const row of db
    .prepare('SELECT jid, name FROM registered_groups')
    .all() as Array<{ jid: string; name: string }>) {
    names.set(row.jid, row.name);
  }
  // Only chats the bot serves: inbound from an unregistered (removed or
  // paused guest) chat never gets an answer and would only add noise.
  const allSeries = buildReplySeries(
    readLatencyEvents(db, now - widest - LOOKBACK_MS),
  ).filter((s) => names.has(s.chatJid));
  const runs = readMachineRuns(db, new Date(now - widest).toISOString()).filter(
    (r) => names.has(r.chat_jid),
  );

  const windows = WINDOWS_DAYS.map((days): ReplyLatencyWindow => {
    const from = now - days * 86400_000;
    const fromIso = new Date(from).toISOString();
    const series = allSeries.filter((s) => s.startedAt >= from);
    const windowRuns = runs.filter((r) => r.run_at >= fromIso);
    const byChat = new Map<string, ReplySeries[]>();
    for (const s of series) {
      const list = byChat.get(s.chatJid) || [];
      list.push(s);
      byChat.set(s.chatJid, list);
    }
    const chats = [...byChat.entries()]
      .map(
        ([jid, list]): ReplyLatencyChat => ({
          jid,
          name: chatLabel(names.get(jid), jid),
          channel: chatChannel(jid),
          ...summarize(
            list,
            now,
            machineStats(
              windowRuns
                .filter((r) => r.chat_jid === jid)
                .map((r) => r.duration_ms),
            ),
          ),
        }),
      )
      .sort((a, b) => b.series + b.waiting - (a.series + a.waiting));
    const answered = series.filter(
      (s) => s.outcome === 'answered' && s.finalAt !== null,
    );
    return {
      days,
      all: summarize(
        series,
        now,
        machineStats(windowRuns.map((r) => r.duration_ms)),
      ),
      chats,
      byTier: breakdown(
        answered,
        (s) => s.tier,
        (key) => TIER_LABELS[key as TierKey] || key,
        ['fast', 'dropped', 'standard', 'unknown'],
      ),
      byEffort: breakdown(
        answered,
        (s) => s.effort || 'unknown',
        (key) => (key === 'unknown' ? 'Не записано' : key),
        EFFORT_ORDER,
      ),
    };
  });

  return { generatedAt: new Date(now).toISOString(), windows };
}
