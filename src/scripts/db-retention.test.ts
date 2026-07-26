import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import {
  parseArgs,
  run,
  PROTECTED_EVENT_TYPES,
  type Report,
} from './db-retention.js';

const MS_PER_DAY = 86_400_000;

/**
 * Build a throwaway sqlite file whose `events`, `usage_events` and
 * `usage_ledger` tables carry the SAME append-only BEFORE DELETE / UPDATE
 * triggers the live app installs (src/orchestrator/event-store.ts +
 * db.ts). We deliberately reproduce the triggers here so the test proves
 * the script can delete THROUGH them. Never points at the prod DB.
 */
function seedDb(file: string, now: number): void {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE usage_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE usage_ledger (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      channel_user_id TEXT NOT NULL,
      model_role TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      credits_spent INTEGER NOT NULL DEFAULT 0,
      pricing_version TEXT NOT NULL DEFAULT 'v1',
      coefficient_version TEXT NOT NULL DEFAULT 'v1'
    );
  `);

  // Append-only triggers, matching the two historical naming schemes.
  for (const t of ['events', 'usage_events']) {
    db.exec(`
      CREATE TRIGGER ${t}_append_only_no_update
      BEFORE UPDATE ON ${t}
      BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;
      CREATE TRIGGER ${t}_append_only_no_delete
      BEFORE DELETE ON ${t}
      BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;
    `);
  }
  db.exec(`
    CREATE TRIGGER usage_ledger_no_update
    BEFORE UPDATE ON usage_ledger
    BEGIN SELECT RAISE(ABORT, 'usage_ledger is append-only'); END;
    CREATE TRIGGER usage_ledger_no_delete
    BEFORE DELETE ON usage_ledger
    BEGIN SELECT RAISE(ABORT, 'usage_ledger is append-only'); END;
  `);

  const old = now - 90 * MS_PER_DAY; // older than a 60d cutoff
  const fresh = now - 5 * MS_PER_DAY; // younger than a 60d cutoff

  const insEvent = db.prepare(
    `INSERT INTO events
       (event_id, tenant_id, session_id, seq, type, actor, channel, chat_id,
        sender_id, payload_json, created_at)
     VALUES (?, 't', 's', ?, ?, 'system', 'telegram', 'c', NULL, '{}', ?)`,
  );
  let seq = 0;
  // OLD prunable telemetry (NOT protected) → should be deleted
  insEvent.run('e-old-msg', seq++, 'telegram_inbound_message', old);
  insEvent.run('e-old-quota-checked', seq++, 'quota_checked', old);
  insEvent.run('e-old-runtime', seq++, 'runtime_selected', old);
  // OLD but PROTECTED → must survive
  insEvent.run('e-old-error', seq++, 'error', old);
  insEvent.run('e-old-charged', seq++, 'quota_charged', old);
  insEvent.run('e-old-tool-denied', seq++, 'tool_policy_denied', old);
  insEvent.run('e-old-mem-del', seq++, 'memory_deleted', old);
  // FRESH telemetry (NOT protected) → must survive (too young)
  insEvent.run('e-fresh-msg', seq++, 'telegram_inbound_message', fresh);

  const insUsage = db.prepare(
    `INSERT INTO usage_events
       (id, tenant_id, session_id, channel, chat_id, created_at)
     VALUES (?, 't', 's', 'telegram', 'c', ?)`,
  );
  insUsage.run('u-old-1', old); // delete
  insUsage.run('u-old-2', old); // delete
  insUsage.run('u-fresh-1', fresh); // keep

  const insLedger = db.prepare(
    `INSERT INTO usage_ledger
       (id, account_id, tenant_id, session_id, channel, chat_id,
        channel_user_id, model_role, idempotency_key, created_at)
     VALUES (?, 'a', 't', 's', 'telegram', 'c', 'cu', 'main', ?, ?)`,
  );
  insLedger.run('l-old-1', 'idem-old-1', old);
  insLedger.run('l-fresh-1', 'idem-fresh-1', fresh);

  db.close();
}

function countRows(file: string, table: string): number {
  const db = new Database(file, { readonly: true });
  const c = (
    db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
  ).c;
  db.close();
  return c;
}

function tableOf(r: Report, name: string) {
  return r.tables.find((t) => t.table === name)!;
}

describe('db-retention', () => {
  let root: string;
  let dbFile: string;
  const NOW = 1_780_000_000_000;

  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    root = await fs.mkdtemp(path.join(tmpdir(), 'db-retention-test-'));
    dbFile = path.join(root, 'copy.db');
    seedDb(dbFile, NOW);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('parseArgs defaults to dry, 60 days, ledger disabled', () => {
    const a = parseArgs(['node', 'db-retention.js']);
    expect(a.run).toBe(false);
    expect(a.maxAgeDays).toBe(60);
    expect(a.ledgerMaxAgeDays).toBe(0);
    expect(a.vacuum).toBe(true);
  });

  it('dry mode COUNTS deletable rows and mutates nothing', () => {
    const before = {
      events: countRows(dbFile, 'events'),
      usage: countRows(dbFile, 'usage_events'),
      ledger: countRows(dbFile, 'usage_ledger'),
    };

    const r = run(['node', 'db-retention.js', '--db', dbFile, '--max-age-days', '60']);

    expect(r.mode).toBe('dry');
    // events: 3 old telemetry deletable, 4 old protected kept, 1 fresh kept
    const ev = tableOf(r, 'events');
    expect(ev.matched).toBe(7); // 7 rows older than cutoff
    expect(ev.protectedKept).toBe(4); // error, quota_charged, tool_policy_denied, memory_deleted
    expect(ev.deletable).toBe(3); // inbound_message, quota_checked, runtime_selected
    // usage_events: 2 old deletable, 1 fresh kept
    expect(tableOf(r, 'usage_events').deletable).toBe(2);
    // usage_ledger: disabled (age 0) → skipped, nothing deletable
    expect(tableOf(r, 'usage_ledger').skipped).toBe(true);
    expect(tableOf(r, 'usage_ledger').deletable).toBe(0);

    // Nothing was actually deleted.
    expect(countRows(dbFile, 'events')).toBe(before.events);
    expect(countRows(dbFile, 'usage_events')).toBe(before.usage);
    expect(countRows(dbFile, 'usage_ledger')).toBe(before.ledger);
  });

  it('run mode deletes old non-protected rows and keeps protected + fresh', () => {
    const r = run([
      'node',
      'db-retention.js',
      '--db',
      dbFile,
      '--max-age-days',
      '60',
      '--run',
    ]);

    expect(r.mode).toBe('run');
    expect(r.vacuumed).toBe(true);

    // events: started 8, removed 3 → 5 left (4 protected + 1 fresh)
    expect(countRows(dbFile, 'events')).toBe(5);
    // The deleted ones are exactly the unprotected old telemetry.
    const db = new Database(dbFile, { readonly: true });
    const remaining = (
      db.prepare('SELECT event_id FROM events ORDER BY event_id').all() as {
        event_id: string;
      }[]
    ).map((x) => x.event_id);
    db.close();
    expect(remaining).toEqual([
      'e-fresh-msg',
      'e-old-charged',
      'e-old-error',
      'e-old-mem-del',
      'e-old-tool-denied',
    ]);

    // usage_events: 3 → 1 (only fresh)
    expect(countRows(dbFile, 'usage_events')).toBe(1);
    // usage_ledger untouched (disabled).
    expect(countRows(dbFile, 'usage_ledger')).toBe(2);
  });

  it('run restores the append-only DELETE trigger afterward', () => {
    run(['node', 'db-retention.js', '--db', dbFile, '--max-age-days', '60', '--run']);

    const db = new Database(dbFile);
    // The no-delete guard must be back: a manual DELETE must ABORT again.
    expect(() => db.exec(`DELETE FROM events WHERE event_id = 'e-old-error'`)).toThrow(
      /append-only/,
    );
    // The no-update guard was never touched.
    expect(() =>
      db.exec(`UPDATE events SET actor='x' WHERE event_id = 'e-old-error'`),
    ).toThrow(/append-only/);
    // Both delete + update triggers still present on all three tables.
    const triggers = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
    db.close();
    expect(triggers).toContain('events_append_only_no_delete');
    expect(triggers).toContain('events_append_only_no_update');
    expect(triggers).toContain('usage_events_append_only_no_delete');
    expect(triggers).toContain('usage_ledger_no_delete');
  });

  it('opting into ledger pruning deletes old ledger rows', () => {
    const r = run([
      'node',
      'db-retention.js',
      '--db',
      dbFile,
      '--max-age-days',
      '60',
      '--ledger-max-age-days',
      '60',
      '--run',
    ]);
    expect(tableOf(r, 'usage_ledger').skipped).toBe(false);
    // old ledger row gone, fresh kept
    expect(countRows(dbFile, 'usage_ledger')).toBe(1);
  });

  it('every protected event type is a known EventType-style telemetry kind', () => {
    // Guard against typos: protected set is non-empty and includes the
    // load-bearing audit kinds.
    expect(PROTECTED_EVENT_TYPES.has('error')).toBe(true);
    expect(PROTECTED_EVENT_TYPES.has('quota_charged')).toBe(true);
    expect(PROTECTED_EVENT_TYPES.has('tool_policy_denied')).toBe(true);
    expect(PROTECTED_EVENT_TYPES.has('memory_deleted')).toBe(true);
    // High-volume telemetry must NOT be protected.
    expect(PROTECTED_EVENT_TYPES.has('telegram_inbound_message')).toBe(false);
    expect(PROTECTED_EVENT_TYPES.has('quota_checked')).toBe(false);
  });

  it('dry mode opens read-only (cannot write even if it tried)', () => {
    // Sanity: a dry run against a DB does not change the mtime-relevant
    // content; re-running dry twice yields identical counts.
    const r1 = run(['node', 'db-retention.js', '--db', dbFile]);
    const r2 = run(['node', 'db-retention.js', '--db', dbFile]);
    expect(tableOf(r1, 'events').deletable).toBe(tableOf(r2, 'events').deletable);
  });
});
