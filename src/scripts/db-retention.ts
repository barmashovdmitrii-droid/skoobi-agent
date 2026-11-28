#!/usr/bin/env node
/**
 * DB retention prune (dry-by-default) for the unbounded analytics table:
 *   - events        (telemetry / audit log; ~680 rows/day, unbounded)
 *
 * Nothing in the live codebase prunes this table today, so it grows
 * forever. This script DELETEs rows older than a configurable age while
 * PRESERVING audit-critical rows, and is the analogue of the media
 * `retention.ts` sweep: DRY by default, `--run` required to mutate, single
 * VACUUM only on a successful run.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CRITICAL — append-only triggers
 * ─────────────────────────────────────────────────────────────────────────
 * `events` carries a BEFORE DELETE
 * trigger that `RAISE(ABORT, '<table> is append-only')` (see
 * src/orchestrator/event-store.ts appendOnlyTriggers() and db.ts). A plain
 * DELETE therefore FAILS. This script deletes correctly by, inside a single
 * transaction per table:
 *   1. DROP TRIGGER <table>_…_no_delete     (the DELETE guard only)
 *   2. DELETE the eligible rows
 *   3. recreate the trigger with its EXACT original SQL
 * The no-UPDATE trigger is left untouched, so the append-only UPDATE
 * guarantee is never weakened, and the no-DELETE trigger is restored before
 * the transaction commits — if anything throws, the transaction rolls back
 * and the trigger is still present. We read each trigger's current SQL from
 * sqlite_master at runtime and restore THAT verbatim, so we can never drift
 * from the schema the app installs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Protected event kinds (events.type) — kept regardless of age
 * ─────────────────────────────────────────────────────────────────────────
 * The `events` table mixes high-volume chatter (inbound/outbound messages,
 * quota_checked, runtime_selected) with low-volume audit/forensic rows. We
 * KEEP, regardless of age, any row whose `type` is audit-, security-,
 * billing- or failure-critical, because those are the rows an operator needs
 * months later to reconstruct an incident, a charge dispute, or an outage.
 * The keep-list is defined in PROTECTED_EVENT_TYPES below with a per-entry
 * justification; everything else is prunable once older than --max-age-days.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Usage
 * ─────────────────────────────────────────────────────────────────────────
 *   node dist/scripts/db-retention.js               # DRY report, default db
 *   node dist/scripts/db-retention.js --run         # actually delete + VACUUM
 *   node dist/scripts/db-retention.js \
 *     --db /path/to/copy.db --max-age-days 60 --json
 *
 *   --db <path>               sqlite file (default: <cwd>/store/messages.db)
 *   --max-age-days <n>        prune events older than n days (default 60)
 *   --run                     ACTUALLY delete (irreversible). Default: dry.
 *   --no-vacuum               on --run, skip the VACUUM (DELETE only)
 *   --json                    emit the report as JSON instead of text
 *   -h, --help
 *
 * SAFETY: in dry mode the script opens the DB read-only and ONLY COUNTs what
 * it WOULD delete. It never writes. `--run` is irreversible — TAKE A BACKUP
 * FIRST (see APPLY.md).
 */

import path from 'path';

import Database from 'better-sqlite3';

const MS_PER_DAY = 86_400_000;

/**
 * events.type values that are NEVER pruned, with the reason each is
 * audit/security/billing/failure-critical. Anything NOT in this set is
 * ordinary high-volume telemetry and is prunable past the age cutoff.
 *
 * Source of truth for the universe of types: the `EventType` union in
 * src/orchestrator/event-store.ts. Keep this list a strict subset of that
 * union; new audit-grade event types should be added here deliberately.
 */
export const PROTECTED_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  // ── errors / failures: the forensic trail for outages & bugs ──
  'error',
  'codex_model_unavailable',
  'codex_model_downgraded',
  'codex_circuit_open',
  'provider_failover_attempt',
  'provider_failover_used',
  'provider_failover_exhausted',
  'provider_circuit_opened',
  'provider_circuit_half_open',
  'provider_circuit_closed',
  'web_search_failed',
  'image_generation_failed',
  'tool_call_failed',

  // ── security / tool-policy: who tried to run what, and was it denied ──
  'tool_policy_denied',

  // ── historical quota events: no longer emitted since the billing
  //    teardown, but the rows already in `events` are kept so
  //    the sweep never silently erases what the old system did. ──
  'quota_charged',
  'quota_blocked',
  'quota_adjusted',
  'quota_charge_skipped_shadow',
  'quota_charge_skipped_failed_model',

  // ── data-subject / privacy actions: must be provable after the fact ──
  'memory_delete_requested',
  'memory_deleted',
  'memory_delete_unavailable',
]);

export interface Args {
  dbPath: string;
  maxAgeDays: number;
  run: boolean;
  vacuum: boolean;
  json: boolean;
  /**
   * @deprecated No-op since the billing teardown dropped
   * usage_ledger. Still parsed and still defaulted to 0 so existing cron
   * entries and wrapper scripts that pass `--ledger-max-age-days` keep working
   * instead of dying on an unknown flag; the value is never read. Remove once
   * no scheduled caller passes it.
   */
  ledgerMaxAgeDays: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    dbPath: path.resolve(process.cwd(), 'store/messages.db'),
    maxAgeDays: 60,
    run: false,
    vacuum: true,
    json: false,
    ledgerMaxAgeDays: 0,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') args.run = true;
    else if (a === '--no-vacuum') args.vacuum = false;
    else if (a === '--json') args.json = true;
    else if (a === '--db') args.dbPath = path.resolve(argv[++i]);
    else if (a === '--max-age-days') args.maxAgeDays = parseInt(argv[++i], 10);
    // Accepted and ignored — see Args.ledgerMaxAgeDays.
    else if (a === '--ledger-max-age-days')
      args.ledgerMaxAgeDays = parseInt(argv[++i], 10);
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'Usage: db-retention [--db <path>] [--max-age-days <n>] ' +
          '[--run] [--no-vacuum] [--json]\n',
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.maxAgeDays) || args.maxAgeDays <= 0) {
    throw new Error(`--max-age-days must be a positive number`);
  }
  return args;
}

export interface TablePlan {
  table: string;
  /** rows that match the age cutoff (i.e. candidates before protection). */
  matched: number;
  /** rows kept because protected (events keep-list); 0 for other tables. */
  protectedKept: number;
  /** rows that WOULD be / WERE deleted. */
  deletable: number;
  /** total rows in the table (for context). */
  total: number;
  /** cutoff epoch ms; rows with created_at < cutoff are eligible. */
  cutoff: number;
  /** true when this table is disabled (e.g. ledger age 0). */
  skipped: boolean;
}

export interface Report {
  dbPath: string;
  now: number;
  maxAgeDays: number;
  mode: 'dry' | 'run';
  vacuumed: boolean;
  tables: TablePlan[];
}

/**
 * Build the WHERE clause that selects DELETABLE rows for a table.
 * For `events` we exclude protected types so they survive forever.
 */
function deletableWhere(table: string): {
  sql: string;
  params: (n: number) => unknown[];
} {
  if (table === 'events') {
    const placeholders = Array.from(PROTECTED_EVENT_TYPES, () => '?').join(',');
    return {
      sql: `created_at < ? AND type NOT IN (${placeholders})`,
      params: (cutoff: number) => [cutoff, ...PROTECTED_EVENT_TYPES],
    };
  }
  return {
    sql: `created_at < ?`,
    params: (cutoff: number) => [cutoff],
  };
}

function countMatched(db: Database.Database, table: string, cutoff: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE created_at < ?`)
    .get(cutoff) as { c: number };
  return row.c;
}

function countDeletable(
  db: Database.Database,
  table: string,
  cutoff: number,
): number {
  const w = deletableWhere(table);
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${w.sql}`)
    .get(...w.params(cutoff)) as { c: number };
  return row.c;
}

function countTotal(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number })
    .c;
}

/**
 * Read the EXACT SQL of the BEFORE DELETE append-only trigger on `table`,
 * so it can be recreated verbatim after the prune. Returns null if no such
 * trigger exists (e.g. a table that was never guarded), in which case the
 * delete needs no trigger dance.
 */
function findDeleteTrigger(
  db: Database.Database,
  table: string,
): { name: string; sql: string } | null {
  const rows = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'trigger' AND tbl_name = ?`,
    )
    .all(table) as { name: string; sql: string }[];
  for (const r of rows) {
    // A BEFORE DELETE guard. Match on the SQL body rather than the name so
    // we are resilient to the two historical naming schemes
    // (e.g. events_append_only_no_delete).
    if (/\bBEFORE\s+DELETE\b/i.test(r.sql)) {
      return { name: r.name, sql: r.sql };
    }
  }
  return null;
}

/**
 * Delete the deletable rows for one table, working AROUND the append-only
 * BEFORE DELETE trigger by dropping it, deleting, and recreating it with its
 * original SQL — all inside one transaction so a failure rolls back with the
 * trigger intact. Returns the number of rows deleted.
 */
function pruneTable(
  db: Database.Database,
  table: string,
  cutoff: number,
): number {
  const w = deletableWhere(table);
  const trigger = findDeleteTrigger(db, table);
  const tx = db.transaction(() => {
    if (trigger) db.exec(`DROP TRIGGER ${trigger.name}`);
    try {
      const res = db
        .prepare(`DELETE FROM ${table} WHERE ${w.sql}`)
        .run(...w.params(cutoff));
      return res.changes;
    } finally {
      // Recreate verbatim. Inside the same transaction; if the DELETE threw,
      // this still runs (finally) and the whole tx rolls back, leaving the
      // original trigger in place regardless.
      if (trigger) db.exec(trigger.sql);
    }
  });
  return tx() as number;
}

export function run(argv = process.argv): Report {
  const args = parseArgs(argv);
  const now = Date.now();

  // DRY opens read-only so it physically cannot mutate; RUN opens writable.
  const db = new Database(args.dbPath, {
    readonly: !args.run,
    fileMustExist: true,
  });
  // Re-arm foreign-key + trigger semantics to match the app (db.ts).
  db.pragma('foreign_keys = ON');
  // Wait out a transient lock instead of failing instantly (finding #48). This
  // retention process shares messages.db with the live orchestrator; its
  // DELETE + VACUUM takes an exclusive lock, and without a busy_timeout a
  // concurrent orchestrator write would throw SQLITE_BUSY and lose the
  // message/event. Match the app's pragma so both sides wait rather than drop.
  db.pragma('busy_timeout = 5000');

  const plan: TablePlan[] = [];
  const tableSpecs: { table: string; ageDays: number }[] = [
    { table: 'events', ageDays: args.maxAgeDays },
  ];

  try {
    for (const spec of tableSpecs) {
      const skipped = spec.ageDays <= 0; // ledger default 0 → never prune
      const cutoff = now - spec.ageDays * MS_PER_DAY;
      if (skipped) {
        plan.push({
          table: spec.table,
          matched: 0,
          protectedKept: 0,
          deletable: 0,
          total: countTotal(db, spec.table),
          cutoff,
          skipped: true,
        });
        continue;
      }
      const matched = countMatched(db, spec.table, cutoff);
      const deletable = countDeletable(db, spec.table, cutoff);
      plan.push({
        table: spec.table,
        matched,
        protectedKept: matched - deletable,
        deletable,
        total: countTotal(db, spec.table),
        cutoff,
        skipped: false,
      });
    }

    let vacuumed = false;
    if (args.run) {
      for (const p of plan) {
        if (p.skipped) continue;
        const cutoff = p.cutoff;
        const deleted = pruneTable(db, p.table, cutoff);
        // deletable was a pre-count; reconcile to what actually went.
        p.deletable = deleted;
      }
      // Single VACUUM after all deletes, inside a clear guard. VACUUM cannot
      // run inside a transaction and reclaims the freed pages to disk.
      const anyDeleted = plan.some((p) => !p.skipped && p.deletable > 0);
      if (args.vacuum && anyDeleted) {
        db.exec('VACUUM');
        vacuumed = true;
      }
    }

    return {
      dbPath: args.dbPath,
      now,
      maxAgeDays: args.maxAgeDays,
      mode: args.run ? 'run' : 'dry',
      vacuumed,
      tables: plan,
    };
  } finally {
    db.close();
  }
}

export function formatReport(r: Report): string {
  const lines: string[] = [];
  lines.push(
    `Skoobi DB retention ${r.mode === 'dry' ? '(DRY)' : '(RUN)'} — ${new Date(
      r.now,
    ).toISOString()}`,
  );
  lines.push(`  db: ${r.dbPath}`);
  lines.push(
    `  age cutoff: events=${r.maxAgeDays}d`,
  );
  for (const t of r.tables) {
    if (t.skipped) {
      lines.push(
        `  ${t.table}: SKIPPED (age 0) — total ${t.total} rows, untouched`,
      );
      continue;
    }
    const verb = r.mode === 'dry' ? 'would delete' : 'deleted';
    lines.push(
      `  ${t.table}: total ${t.total} | older-than-cutoff ${t.matched} | ` +
        `protected-kept ${t.protectedKept} | ${verb} ${t.deletable}`,
    );
  }
  lines.push(`  vacuum: ${r.vacuumed ? 'yes' : 'no'}`);
  return lines.join('\n') + '\n';
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/db-retention.js') ||
  process.argv[1]?.endsWith('/db-retention.ts');

if (isMain) {
  try {
    const report = run();
    const out = report.mode === 'dry' ? report : report;
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    } else {
      process.stdout.write(formatReport(out));
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
