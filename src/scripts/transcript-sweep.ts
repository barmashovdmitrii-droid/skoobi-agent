#!/usr/bin/env node
//
// Additive CLI. Does NOT modify any existing file.
//
/**
 * Orphan / over-cap transcript sweep (dry-by-default).
 *
 * Walks every on-disk SDK transcript under
 *   data/sessions/<folder>/.claude/projects/<projectKey>/<id>.jsonl
 * and archives any file over CLAUDECLAW_MAX_TRANSCRIPT_BYTES (default 40 MB)
 * to store/archive/sessions/<id>.archived-<YYYYMMDD-HHMMSS>.jsonl — regardless
 * of whether the session is pinned. This catches the files the per-message
 * guard (transcript-rotation.ts) cannot: orphans with no `sessions` row and
 * idle pins that haven't sent a message.
 *
 * SAFETY: DRY-RUN by default. Without `--apply` the script ONLY reads and
 * stats files; it moves nothing and clears no session. `--apply` is the
 * explicit opt-in to actually archive over-cap files (and clear the matching
 * pinned-session rows).
 *
 * Usage:
 *   node dist/scripts/transcript-sweep.js [--apply] [--max-bytes <n>] \
 *        [--data-dir <path>] [--store-dir <path>] [--json]
 *
 *   --apply        actually move over-cap files (default: dry-run, report only)
 *   --max-bytes    override the byte cap (default: CLAUDECLAW_MAX_TRANSCRIPT_BYTES / 40MB)
 *   --data-dir     override DATA_DIR (default: <cwd>/data)
 *   --store-dir    override STORE_DIR (default: <cwd>/store)
 *   --json         emit a machine-readable JSON summary instead of text
 *   -h, --help     print usage
 *
 * Exit codes: 0 always on a clean run (even when files were swept). Non-zero
 * only on an unexpected crash.
 */
import path from 'path';

import Database from 'better-sqlite3';

import { MAX_TRANSCRIPT_BYTES, STORE_DIR } from '../orchestrator/config.js';
import {
  sweepOverCapTranscripts,
  type SweepResult,
} from '../orchestrator/transcript-sweep.js';

/**
 * Read the pinned `sessions` table via a dedicated READ-ONLY connection.
 *
 * The CLI is a separate process from the service, so it must NOT run the app's
 * full `initDatabase()` (schema creation + JSON migrations) against the live DB
 * just to read one table — a writable second connection running DDL on the live
 * messages.db is needless risk. A read-only SELECT is enough.
 *
 * We deliberately pass NO `clearSession` hook to the sweep: any over-cap PINNED
 * transcript we archive is picked up by the per-message guard's stale-session
 * fallback on that group's next message (it finds the `.jsonl` gone → starts a
 * fresh session and re-pins it), so the DB row needs no eager clearing here.
 * The pin info is used only to LABEL files pinned vs orphan in the report.
 */
function readPinnedSessions(): Record<string, string> {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare('SELECT group_folder, session_id FROM sessions')
      .all() as Array<{ group_folder: string; session_id: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.group_folder] = r.session_id;
    return out;
  } catch {
    return {}; // no DB / no sessions table → treat every file as an orphan
  } finally {
    db?.close();
  }
}

interface Args {
  apply: boolean;
  maxBytes: number;
  dataDir?: string;
  storeDir?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    maxBytes: MAX_TRANSCRIPT_BYTES,
    json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (a === '--max-bytes') args.maxBytes = parseInt(argv[++i], 10);
    else if (a === '--data-dir') args.dataDir = argv[++i];
    else if (a === '--store-dir') args.storeDir = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: transcript-sweep [--apply] [--max-bytes <n>] [--data-dir <path>] [--store-dir <path>] [--json]',
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.maxBytes) || args.maxBytes <= 0) {
    args.maxBytes = MAX_TRANSCRIPT_BYTES;
  }
  return args;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatText(r: SweepResult): string {
  const lines: string[] = [];
  lines.push(
    `Skoobi transcript sweep ${r.apply ? '(APPLY)' : '(DRY)'} — ${new Date().toISOString()}`,
  );
  lines.push(
    `cap=${humanBytes(r.maxBytes)} scanned=${r.scanned} over-cap=${r.overCap} reclaimable=${humanBytes(r.reclaimableBytes)}`,
  );
  for (const s of r.swept.sort((a, b) => b.bytes - a.bytes)) {
    const tag = s.pinned ? 'PINNED' : 'orphan';
    const cleared = s.sessionCleared ? ' cleared-session' : '';
    const where = s.archivedPath ? ` → ${s.archivedPath}` : '';
    const err = s.error ? ` ERROR=${s.error}` : '';
    lines.push(
      `  [${s.action}] ${tag} ${s.groupFolder}/${s.sessionId} ${humanBytes(s.bytes)}${where}${cleared}${err}`,
    );
  }
  if (r.overCap === 0) lines.push('  (nothing over cap)');
  return lines.join('\n') + '\n';
}

export function runSweep(argv = process.argv): SweepResult {
  const args = parseArgs(argv);
  const result = sweepOverCapTranscripts({
    apply: args.apply,
    maxBytes: args.maxBytes,
    dataDir: args.dataDir,
    storeDir: args.storeDir,
    getSessions: readPinnedSessions,
    // No clearSession: archived pinned sessions self-heal via the per-message
    // guard's stale-session fallback on the group's next message.
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(formatText(result));
  }
  return result;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/transcript-sweep.js') ||
  process.argv[1]?.endsWith('/transcript-sweep.ts');

if (isMain) {
  try {
    runSweep();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
