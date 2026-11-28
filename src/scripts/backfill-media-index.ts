#!/usr/bin/env node
/**
 * Backfill `groups/<folder>/.media-index.jsonl` from the existing inventory
 * of saved media under `groups/<folder>/received/`.
 *
 * Usage:
 *   node dist/scripts/backfill-media-index.js [--folder <name>] [--dry] \
 *        [--groups-dir <abs path>] [--db <abs path to messages.db>]
 *
 * Defaults:
 *   --groups-dir = <repo root>/groups
 *   --db         = <repo root>/store/messages.db
 *
 * Behavior:
 *   - Walks every `groups/<folder>/received/*` file.
 *   - Infers media type from the filename pattern.
 *   - Joins against the `messages` table to find the originating message_id
 *     by matching timestamp within ±5s of the filename's ISO timestamp.
 *   - Idempotent: skips basenames that already appear in the manifest.
 *   - --dry prints what would be appended without writing.
 *
 * SAFETY: This script is read-mostly. With --dry it does not write at all.
 * Without --dry it only appends to per-group `.media-index.jsonl` files.
 * It NEVER touches the `messages` table.
 */

import { promises as fs } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import {
  appendMediaEntry,
  listMedia,
  type MediaEntry,
  type MediaType,
} from '../media-manifest.js';

interface Args {
  folder?: string;
  dry: boolean;
  groupsDir: string;
  dbPath: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dry: false,
    groupsDir: path.resolve(process.cwd(), 'groups'),
    dbPath: path.resolve(process.cwd(), 'store/messages.db'),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') args.dry = true;
    else if (a === '--folder') args.folder = argv[++i];
    else if (a === '--groups-dir') args.groupsDir = path.resolve(argv[++i]);
    else if (a === '--db') args.dbPath = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: backfill-media-index [--folder <name>] [--dry] [--groups-dir <path>] [--db <path>]',
      );
      process.exit(0);
    }
  }
  return args;
}

const TYPE_PATTERNS: { re: RegExp; type: MediaType }[] = [
  { re: /-voice-/, type: 'voice' },
  { re: /-video-note-/, type: 'video-note' },
  { re: /-audio-/, type: 'audio' },
  // Heuristic by extension:
  { re: /\.(jpg|jpeg|png|webp|gif)$/i, type: 'photo' },
  { re: /\.(mp4|mov|m4v|webm)$/i, type: 'video' },
];

function inferType(basename: string): MediaType {
  for (const p of TYPE_PATTERNS) {
    if (p.re.test(basename)) return p.type;
  }
  return 'document';
}

/**
 * Parse a basename's leading ISO timestamp `YYYY-MM-DDTHH-MM-SS-XXXZ` into
 * a Date. Returns null if the pattern is absent.
 */
export function parseTimestampFromBasename(name: string): Date | null {
  // Matches: 2026-05-11T10-00-00-000Z-...
  const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

interface MessageRow {
  id: string;
  chat_jid: string;
  timestamp: string;
}

function findMessageForFile(
  db: Database.Database,
  fileTs: Date,
  chatJidHint: string | null,
): MessageRow | null {
  // SECURITY/CORRECTNESS (finding #73): never resolve a message_id by a
  // timestamp-only match across all tenants. Without a chat_jid hint, the
  // nearest message within ±5s could belong to an unrelated group, writing
  // cross-tenant chat_jid/message_id into this group's manifest. Require a
  // chat filter; if we can't scope the match to this group, leave it
  // unresolved (the caller falls back to message_id='' + the group's hint).
  if (!chatJidHint) return null;
  const fromIso = new Date(fileTs.getTime() - 5_000).toISOString();
  const toIso = new Date(fileTs.getTime() + 5_000).toISOString();
  const args: unknown[] = [fromIso, toIso, chatJidHint];
  let sql =
    'SELECT id, chat_jid, timestamp FROM messages WHERE timestamp BETWEEN ? AND ? AND chat_jid = ?';
  sql += " ORDER BY ABS(strftime('%s', timestamp) - strftime('%s', ?)) ASC LIMIT 1";
  args.push(fileTs.toISOString());
  const row = db.prepare(sql).get(...args) as MessageRow | undefined;
  return row ?? null;
}

async function backfillFolder(
  folderAbs: string,
  folderName: string,
  db: Database.Database | null,
  dry: boolean,
): Promise<{ scanned: number; added: number; skipped: number }> {
  const receivedDir = path.join(folderAbs, 'received');
  let files: string[];
  try {
    files = await fs.readdir(receivedDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { scanned: 0, added: 0, skipped: 0 };
    }
    throw err;
  }

  const existing = new Set(
    (await listMedia(folderAbs)).map((e) => e.basename),
  );

  // Resolve a stable chat_jid hint for this group folder from
  // registered_groups. SECURITY/CORRECTNESS (finding #73): the production
  // schema (src/orchestrator/db.ts) keys this table on `jid` (which IS the
  // chat jid) — there is NO `chat_jid` column. Selecting `chat_jid` here threw
  // SQLite "no such column" on the real DB, the catch swallowed it, and the
  // hint stayed null for every folder. With a null hint, findMessageForFile()
  // drops its `AND chat_jid = ?` filter and matches the nearest message across
  // ALL tenants by timestamp, so a file could be attributed to another group's
  // message_id/chat_jid. Query the real column (`jid AS chat_jid`) so the
  // per-tenant filter is always applied.
  let chatJidHint: string | null = null;
  if (db) {
    try {
      const row = db
        .prepare(
          'SELECT jid AS chat_jid FROM registered_groups WHERE folder = ? LIMIT 1',
        )
        .get(folderName) as { chat_jid?: string } | undefined;
      chatJidHint = row?.chat_jid ?? null;
    } catch {
      // registered_groups schema may not match; we proceed without hint
    }
  }

  let added = 0;
  let skipped = 0;
  for (const file of files.sort()) {
    if (file.startsWith('.')) continue;
    if (existing.has(file)) {
      skipped++;
      continue;
    }
    const filePath = path.join(receivedDir, file);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const type = inferType(file);
    const fileTs = parseTimestampFromBasename(file) ?? stat.mtime;
    let message_id = '';
    let chat_jid = chatJidHint ?? '';
    if (db) {
      const hit = findMessageForFile(db, fileTs, chatJidHint);
      if (hit) {
        message_id = hit.id;
        chat_jid = hit.chat_jid;
      }
    }

    const entry: MediaEntry = {
      message_id,
      chat_jid,
      basename: file,
      type,
      size_bytes: stat.size,
      has_transcript: false,
      has_caption: false,
      transcript_chars: 0,
      created_at: fileTs.toISOString(),
      keep: false,
    };

    if (dry) {
      process.stdout.write(
        `DRY ${folderName}: would append ${JSON.stringify({
          basename: entry.basename,
          type: entry.type,
          size_bytes: entry.size_bytes,
          message_id: entry.message_id || '(unknown)',
          chat_jid: entry.chat_jid || '(unknown)',
        })}\n`,
      );
    } else {
      await appendMediaEntry(folderAbs, entry);
    }
    added++;
  }

  return { scanned: files.length, added, skipped };
}

export async function main(argv = process.argv): Promise<void> {
  const args = parseArgs(argv);

  let db: Database.Database | null = null;
  try {
    db = new Database(args.dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    process.stderr.write(
      `WARN: cannot open DB at ${args.dbPath} (${(err as Error).message}); proceeding without message_id resolution\n`,
    );
    db = null;
  }

  let folders: string[];
  if (args.folder) {
    folders = [args.folder];
  } else {
    try {
      const entries = await fs.readdir(args.groupsDir, { withFileTypes: true });
      folders = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        process.stderr.write(`groups dir missing: ${args.groupsDir}\n`);
        process.exit(2);
      }
      throw err;
    }
  }

  let totalAdded = 0;
  let totalSkipped = 0;
  let totalScanned = 0;
  for (const name of folders) {
    const folderAbs = path.join(args.groupsDir, name);
    const { scanned, added, skipped } = await backfillFolder(
      folderAbs,
      name,
      db,
      args.dry,
    );
    totalScanned += scanned;
    totalAdded += added;
    totalSkipped += skipped;
    process.stdout.write(
      `${name}: scanned=${scanned} added=${added} skipped=${skipped} ${args.dry ? '(dry)' : ''}\n`,
    );
  }

  process.stdout.write(
    `TOTAL: scanned=${totalScanned} added=${totalAdded} skipped=${totalSkipped} ${args.dry ? '(dry)' : ''}\n`,
  );

  if (db) db.close();
}

// Only auto-run when invoked as a script (not when imported by tests).
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/backfill-media-index.js') ||
  process.argv[1]?.endsWith('/backfill-media-index.ts');

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
