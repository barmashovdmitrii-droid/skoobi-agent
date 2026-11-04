import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildReplySeries,
  collectReplyLatency,
  latencyStats,
  parseMessageTime,
  readLatencyEvents,
  type ReplySeries,
} from './reply-latency.js';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const MIN = 60_000;
const CHAT_A = 'tg:100000001';
const CHAT_B = 'tg:100000002';
const UNREGISTERED = 'tg:100123';

let db: InstanceType<typeof Database>;
let seq = 0;

beforeEach(() => {
  seq = 0;
  db = new Database(':memory:');
  // Only the columns the collector reads; the live table has more.
  db.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL,
      is_main INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY, type TEXT NOT NULL, channel TEXT NOT NULL,
      chat_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL, trigger_type TEXT NOT NULL DEFAULT 'message',
      duration_ms INTEGER DEFAULT 0, status TEXT NOT NULL, run_at TEXT NOT NULL
    );
  `);
  const group = db.prepare(
    'INSERT INTO registered_groups (jid, name, folder, is_main) VALUES (?, ?, ?, 1)',
  );
  group.run(CHAT_A, 'Главный чат', 'telegram_fixture_a');
  group.run(CHAT_B, 'Второй админ', 'telegram_fixture_b');
});

afterEach(() => {
  db.close();
});

function insertEvent(
  type: string,
  jid: string,
  createdAt: number,
  payload: Record<string, unknown>,
): void {
  seq += 1;
  db.prepare(
    `INSERT INTO events (event_id, type, channel, chat_id, payload_json, created_at)
     VALUES (?, ?, 'telegram', ?, ?, ?)`,
  ).run(
    `evt-${seq}`,
    type,
    jid.replace(/^tg:/u, ''),
    JSON.stringify(payload),
    createdAt,
  );
}

function inbound(
  jid: string,
  at: number,
  opts: { sentAt?: string; bot?: boolean } = {},
): void {
  insertEvent('telegram_inbound_message', jid, at, {
    chat_jid: jid,
    content: 'вопрос',
    timestamp: opts.sentAt ?? new Date(at).toISOString(),
    is_from_me: false,
    is_bot_message: opts.bot === true,
  });
}

function outbound(
  jid: string,
  at: number,
  triggerType: string,
  metaKind?: string,
): void {
  insertEvent('telegram_outbound_message', jid, at, {
    chat_jid: jid,
    trigger_type: triggerType,
    text: 'ответ',
    ...(metaKind ? { meta_kind: metaKind } : {}),
    timestamp: new Date(at).toISOString(),
  });
}

function finished(
  jid: string,
  at: number,
  durationMs: number,
  extra: Record<string, unknown> = {},
): void {
  insertEvent('session_finished', jid, at, {
    reply_jid: jid,
    status: 'success',
    duration_ms: durationMs,
    ...extra,
  });
}

function series(since = 0): ReplySeries[] {
  return buildReplySeries(readLatencyEvents(db, since));
}

describe('parseMessageTime', () => {
  it('reads Telegram times with the message id fused into the fraction', () => {
    expect(parseMessageTime('2026-10-20T07:27:41.500000000012345Z')).toBe(
      Date.parse('2026-10-20T07:27:41.500Z'),
    );
    expect(parseMessageTime('2026-10-20T07:27:41Z')).toBe(
      Date.parse('2026-10-20T07:27:41.000Z'),
    );
    expect(parseMessageTime('2026-10-20T07:27:41.000Z')).toBe(
      Date.parse('2026-10-20T07:27:41.000Z'),
    );
    expect(parseMessageTime('not a date')).toBeNull();
    expect(parseMessageTime(null)).toBeNull();
  });
});

describe('buildReplySeries', () => {
  it('folds a burst into one wait from the send time; ⏳ is the first sign, the plain reply is final', () => {
    const t0 = NOW - 60 * MIN;
    // A voice note: recorded 6 s after it was sent (transcription).
    inbound(CHAT_A, t0 + 6_000, {
      sentAt: new Date(t0).toISOString().replace('.000Z', '.500000000000042Z'),
    });
    inbound(CHAT_A, t0 + 20_000);
    outbound(CHAT_A, t0 + 30_000, 'extension');
    outbound(CHAT_A, t0 + 50_000, 'agent-response', 'agent_progress');
    outbound(CHAT_A, t0 + 90_000, 'agent-response');
    finished(CHAT_A, t0 + 105_000, 100_000);

    const [only, ...rest] = series();
    expect(rest).toHaveLength(0);
    expect(only).toMatchObject({
      chatJid: CHAT_A,
      messages: 2,
      outcome: 'answered',
      startedAt: t0 + 500,
    });
    expect((only.firstSignAt as number) - only.startedAt).toBe(29_500);
    expect((only.finalAt as number) - only.startedAt).toBe(89_500);
  });

  it('ignores scheduled-task posts; «ау» status is a sign of life; a failure notice ends the wait', () => {
    const t0 = NOW - 60 * MIN;
    inbound(CHAT_A, t0);
    outbound(CHAT_A, t0 + 5_000, 'task-result');
    outbound(CHAT_A, t0 + 40_000, 'agent-response', 'active_run_status');
    outbound(
      CHAT_A,
      t0 + 70_000,
      'agent-response',
      'codex_only_fallback_disabled',
    );

    const [only] = series();
    expect(only.outcome).toBe('answered');
    expect((only.firstSignAt as number) - t0).toBe(40_000);
    expect((only.finalAt as number) - t0).toBe(70_000);
  });

  it('closes a send_message-only answer (a voice note) at its delivery when the run ends', () => {
    const t0 = NOW - 60 * MIN;
    inbound(CHAT_A, t0);
    outbound(CHAT_A, t0 + 20_000, 'extension');
    outbound(CHAT_A, t0 + 60_000, 'ipc', 'voice');
    finished(CHAT_A, t0 + 75_000, 74_000);
    // The next question is its own wait, not a continuation of the first.
    inbound(CHAT_A, t0 + 30 * MIN);
    outbound(CHAT_A, t0 + 31 * MIN, 'agent-response');

    const [first, second] = series();
    expect(first).toMatchObject({ outcome: 'answered', messages: 1 });
    expect((first.finalAt as number) - t0).toBe(60_000);
    expect(second).toMatchObject({ outcome: 'answered', messages: 1 });
    expect((second.finalAt as number) - second.startedAt).toBe(MIN);
  });

  it('a run that ends without a reply leaves the question unanswered instead of merging it with the next one', () => {
    const t0 = NOW - 10 * 60 * MIN;
    inbound(CHAT_A, t0); // «спасибо» — nothing to answer
    finished(CHAT_A, t0 + 20_000, 18_000);
    inbound(CHAT_A, t0 + 3 * 60 * MIN);
    outbound(CHAT_A, t0 + 3 * 60 * MIN + 45_000, 'agent-response');

    const [silent, next] = series();
    expect(silent).toMatchObject({ outcome: 'unanswered', finalAt: null });
    expect(next.outcome).toBe('answered');
    expect((next.finalAt as number) - next.startedAt).toBe(45_000);
  });

  it('a message landing in the previous run’s idle tail waits for the next run', () => {
    const t0 = NOW - 60 * MIN;
    inbound(CHAT_A, t0);
    outbound(CHAT_A, t0 + 30_000, 'agent-response');
    inbound(CHAT_A, t0 + 40_000); // during the 15 s idle wait
    finished(CHAT_A, t0 + 45_000, 44_000); // that run never saw it
    outbound(CHAT_A, t0 + 100_000, 'agent-response');
    finished(CHAT_A, t0 + 115_000, 60_000);

    const [, late] = series();
    expect(late.outcome).toBe('answered');
    expect((late.finalAt as number) - late.startedAt).toBe(60_000);
  });

  it('a message after hours of silence starts a new wait (no run ever took the old one)', () => {
    const t0 = NOW - 20 * 60 * MIN;
    inbound(CHAT_A, t0);
    inbound(CHAT_A, t0 + 7 * 60 * MIN);
    outbound(CHAT_A, t0 + 7 * 60 * MIN + 30_000, 'agent-response');

    const [stale, fresh] = series();
    expect(stale.outcome).toBe('unanswered');
    expect(fresh).toMatchObject({ outcome: 'answered', messages: 1 });
    expect((fresh.finalAt as number) - fresh.startedAt).toBe(30_000);
  });

  it('takes tier and effort from the run that delivered the answer', () => {
    const t0 = NOW - 60 * MIN;
    inbound(CHAT_A, t0);
    outbound(CHAT_A, t0 + 30_000, 'agent-response');
    finished(CHAT_A, t0 + 45_000, 44_000, {
      requested_service_tier: 'priority',
      service_tier: 'priority',
      reasoning_effort: 'xhigh',
    });
    inbound(CHAT_A, t0 + 10 * MIN);
    outbound(CHAT_A, t0 + 11 * MIN, 'agent-response');
    finished(CHAT_A, t0 + 11 * MIN + 15_000, 74_000, {
      requested_service_tier: null,
      service_tier: null,
      fast_tier_dropped_for_quota: true,
      reasoning_effort: 'xhigh',
    });
    inbound(CHAT_A, t0 + 20 * MIN);
    outbound(CHAT_A, t0 + 21 * MIN, 'agent-response');
    finished(CHAT_A, t0 + 21 * MIN + 15_000, 74_000, {
      requested_service_tier: null,
      service_tier: null,
    });
    inbound(CHAT_A, t0 + 30 * MIN);
    outbound(CHAT_A, t0 + 31 * MIN, 'agent-response');
    finished(CHAT_A, t0 + 31 * MIN + 15_000, 74_000);

    expect(series().map((s) => [s.tier, s.effort])).toEqual([
      ['fast', 'xhigh'],
      ['dropped', 'xhigh'],
      ['standard', null],
      ['unknown', null],
    ]);
  });
});

describe('latencyStats', () => {
  it('interpolates percentiles and counts answers over five minutes', () => {
    const stats = latencyStats([
      10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000,
      400_000,
    ]);
    expect(stats).toMatchObject({
      count: 10,
      medianMs: 55_000,
      p90Ms: 121_000,
      over5m: 1,
      over5mShare: 0.1,
      median: '55 сек',
      p90: '2 мин 1 с',
    });
    expect(latencyStats([])).toMatchObject({
      count: 0,
      medianMs: null,
      p90Ms: null,
      over5mShare: null,
      median: '—',
    });
  });
});

describe('collectReplyLatency', () => {
  it('reports 7/30-day waits per registered chat, with tier, effort and machine time', () => {
    // Chat A: one quick answer this week, one slow answer three weeks ago.
    const recent = NOW - 2 * 86400_000;
    inbound(CHAT_A, recent);
    outbound(CHAT_A, recent + 15_000, 'extension');
    outbound(CHAT_A, recent + 60_000, 'agent-response');
    finished(CHAT_A, recent + 75_000, 74_000, {
      service_tier: 'priority',
      requested_service_tier: 'priority',
      reasoning_effort: 'xhigh',
    });
    const old = NOW - 20 * 86400_000;
    inbound(CHAT_A, old);
    outbound(CHAT_A, old + 20_000, 'agent-response', 'agent_progress');
    outbound(CHAT_A, old + 10 * MIN, 'agent-response');
    finished(CHAT_A, old + 10 * MIN + 15_000, 10 * MIN + 14_000, {
      service_tier: null,
      requested_service_tier: null,
      fast_tier_dropped_for_quota: true,
      reasoning_effort: 'high',
    });
    // Chat B: a question still being worked on, and one nobody answered.
    inbound(CHAT_B, NOW - 3 * 86400_000);
    finished(CHAT_B, NOW - 3 * 86400_000 + 20_000, 19_000);
    inbound(CHAT_B, NOW - 5 * MIN);
    outbound(CHAT_B, NOW - 4 * MIN, 'extension');
    // Bot echoes and unregistered chats never count.
    inbound(CHAT_B, NOW - 4 * MIN, { bot: true });
    inbound(UNREGISTERED, NOW - 60 * MIN);
    // Outside both windows.
    inbound(CHAT_A, NOW - 40 * 86400_000);
    outbound(CHAT_A, NOW - 40 * 86400_000 + 5_000, 'agent-response');

    const runs = db.prepare(
      `INSERT INTO agent_runs (group_folder, chat_jid, trigger_type, duration_ms, status, run_at)
       VALUES ('telegram_fixture_a', ?, ?, ?, ?, ?)`,
    );
    runs.run(
      CHAT_A,
      'message',
      74_000,
      'success',
      new Date(recent + 75_000).toISOString(),
    );
    runs.run(
      CHAT_A,
      'message',
      614_000,
      'success',
      new Date(old + 615_000).toISOString(),
    );
    runs.run(
      CHAT_A,
      'scheduled',
      999_000,
      'success',
      new Date(recent).toISOString(),
    );
    runs.run(CHAT_A, 'message', 5_000, 'error', new Date(recent).toISOString());

    const report = collectReplyLatency(NOW, db);
    expect(report.generatedAt).toBe(new Date(NOW).toISOString());
    const [week, month] = report.windows;
    expect(week.days).toBe(7);
    expect(month.days).toBe(30);

    expect(week.chats.map((c) => c.jid)).toEqual([CHAT_B, CHAT_A]);
    const weekA = week.chats.find((c) => c.jid === CHAT_A)!;
    expect(weekA).toMatchObject({
      name: 'Главный чат',
      channel: 'telegram',
      series: 1,
      answered: 1,
      unanswered: 0,
      waiting: 0,
    });
    expect(weekA.first.medianMs).toBe(15_000);
    expect(weekA.final).toMatchObject({
      count: 1,
      medianMs: 60_000,
      over5m: 0,
    });
    expect(weekA.machine).toMatchObject({ runs: 1, medianMs: 74_000 });
    const weekB = week.chats.find((c) => c.jid === CHAT_B)!;
    expect(weekB).toMatchObject({
      series: 1,
      answered: 0,
      unanswered: 1,
      waiting: 1,
      machine: null,
    });
    expect(weekB.final.count).toBe(0);

    expect(month.all).toMatchObject({
      series: 3,
      answered: 2,
      unanswered: 1,
      waiting: 1,
    });
    expect(month.all.final).toMatchObject({
      count: 2,
      medianMs: 330_000,
      over5m: 1,
      over5mShare: 0.5,
    });
    expect(month.all.machine).toMatchObject({ runs: 2, medianMs: 344_000 });
    expect(month.byTier.map((r) => [r.key, r.label, r.final.count])).toEqual([
      ['fast', 'Быстрый тариф', 1],
      ['dropped', 'Быстрый снят из-за квоты', 1],
    ]);
    expect(month.byEffort.map((r) => [r.key, r.final.medianMs])).toEqual([
      ['xhigh', 60_000],
      ['high', 600_000],
    ]);
  });

  it('works on an instance without agent_runs and masks number-only chat names', () => {
    db.exec('DROP TABLE agent_runs');
    db.prepare(
      "INSERT INTO registered_groups (jid, name, folder) VALUES ('15551234567@s.whatsapp.net', '+7 000 000 00 77', 'whatsapp_admin')",
    ).run();
    const at = NOW - 60 * MIN;
    for (const [type, payload] of [
      [
        'whatsapp_inbound_message',
        {
          timestamp: new Date(at).toISOString(),
          is_from_me: true,
          is_bot_message: false,
        },
      ],
      ['whatsapp_outbound_message', { trigger_type: 'agent-response' }],
    ] as const) {
      seq += 1;
      db.prepare(
        `INSERT INTO events (event_id, type, channel, chat_id, payload_json, created_at)
         VALUES (?, ?, 'whatsapp', ?, ?, ?)`,
      ).run(
        `evt-${seq}`,
        type,
        '15551234567@s.whatsapp.net',
        JSON.stringify({ chat_jid: '15551234567@s.whatsapp.net', ...payload }),
        type === 'whatsapp_inbound_message' ? at : at + 20_000,
      );
    }

    const [week] = collectReplyLatency(NOW, db).windows;
    expect(week.chats).toEqual([
      expect.objectContaining({
        name: 'Чат •••• 4567',
        channel: 'whatsapp',
        answered: 1,
        machine: null,
      }),
    ]);
    expect(week.all.machine).toBeNull();
  });
});
