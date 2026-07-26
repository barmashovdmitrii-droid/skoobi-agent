#!/usr/bin/env node
/**
 * Rewrite legacy `messages.content` rows that embed absolute user paths.
 *
 * Historical placeholders looked like:
 *   `[Voice saved at /Users/example/.../groups/<folder>/received/<file>.oga: <transcript>]`
 *   `[Voice saved at /Users/example/.../...oga — transcription failed]`
 *   `[Image saved at /Users/example/.../received/<file>.jpg — use Read tool to view it.]`
 *   `[Video note saved at /Users/example/.../...mp4 ...]`
 *
 * The new format strips the path while keeping the transcript / caption:
 *   `[Voice: <transcript>]`
 *   `[Voice — transcription failed]`
 *   `[Photo]` / `[Photo Caption: ...]`
 *   `[Video note ...]`
 *
 * Usage:
 *   node dist/scripts/sanitize-messages-content.js --dry [--db <path>]
 *   node dist/scripts/sanitize-messages-content.js       [--db <path>]
 *
 * Defaults: --db <cwd>/store/messages.db. --dry is enabled by default unless
 * you pass --run explicitly — this avoids accidental writes when the script
 * is invoked without arguments. Without --dry (i.e. --run), the script
 * makes a timestamped sibling backup of the DB file before issuing UPDATEs.
 *
 * SAFETY: only the `messages.content` column is touched. No schema changes.
 * No other tables are read or written.
 */

import { promises as fs } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

interface Args {
  dry: boolean;
  dbPath: string;
}

function parseArgs(argv: string[]): Args {
  // Default to --dry to make accidental invocation safe.
  const args: Args = {
    dry: true,
    dbPath: path.resolve(process.cwd(), 'store/messages.db'),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') args.dry = true;
    else if (a === '--run') args.dry = false;
    else if (a === '--db') args.dbPath = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: sanitize-messages-content [--dry|--run] [--db <messages.db>]',
      );
      process.exit(0);
    }
  }
  return args;
}

/**
 * Legacy media placeholders all begin with `[<Type>` where <Type> is one of
 * the known attachment kinds, and embed an absolute macOS user-home path after
 * the ` saved at ` marker. We only ever rewrite content that matches BOTH
 * conditions, so
 * a free-form user message that merely *mentions* a /Users/ path (e.g.
 * "check /Users/you/app.log") is never touched. SQLite has no anchored/word
 * matching, so this guard also runs in `sanitizeContent` itself as the
 * authoritative scope.
 */
const LEGACY_PLACEHOLDER_PREFIX =
  /^\[(?:Voice|Image|Photo|Video note|Video|Document|Audio)\b/;
const MACOS_USERS_ROOT = ['/', 'Users', '/'].join('');
const LEGACY_SAVED_AT_MARKER = ` saved at ${MACOS_USERS_ROOT}`;

/** True only for legacy media placeholders that embed an absolute path. */
export function isLegacyPathPlaceholder(content: string): boolean {
  return (
    typeof content === 'string' &&
    LEGACY_PLACEHOLDER_PREFIX.test(content) &&
    content.includes(LEGACY_SAVED_AT_MARKER)
  );
}

/**
 * Apply legacy-path-removal regexes. Exported for unit tests so we can
 * verify a handful of synthetic content shapes without touching SQLite.
 *
 * The destructive absolute-home-path substitutions run ONLY when `content` is
 * a legacy media placeholder (see {@link isLegacyPathPlaceholder}). Any other
 * content — including real user messages that quote a /Users/ path — is
 * returned verbatim.
 */
export function sanitizeContent(content: string): string {
  if (typeof content !== 'string' || !content) return content;
  if (!isLegacyPathPlaceholder(content)) return content;
  let out = content;
  // Saved path followed by `Caption: ...` -> ` Caption: ...`
  out = out.replace(/ saved at \/Users\/[^\]\n]+?\s+Caption: /g, ' Caption: ');
  // Saved clip path followed by `. Transcript` -> ` Transcript`
  out = out.replace(/ saved at \/Users\/[^\]\n]+?\. /g, ' ');
  // Saved path followed by `: <transcript>` -> `: <transcript>`
  out = out.replace(/ saved at \/Users\/[^:\]\n]+: /g, ': ');
  // Saved path followed by an em dash -> the em dash
  out = out.replace(/ saved at \/Users\/[^—\]\n]+ — /g, ' — ');
  // Catch-all inside brackets, including filenames that contain spaces.
  out = out.replace(/ saved at \/Users\/[^\]\n]+(?=\])/g, '');
  // Belt-and-braces: a residual saved-path artefact (e.g. a path
  // whose terminator didn't match the targeted forms above). SECURITY/data-
  // integrity (finding #76): this MUST stay anchored to the ` saved at `
  // marker. The previous unanchored `/\/Users\/.../g` matched the WHOLE
  // content and silently deleted legitimate /Users/ tokens that a user
  // authored inside the trailing caption/transcript (e.g.
  // `Caption: see /Users/you/secret.txt`). We only ever strip the embedded
  // save-path artefact, never user-supplied path mentions.
  out = out.replace(/ saved at \/Users\/[^\s/\])]+(?:\/[^\s\])]*)*/g, '');
  // Strip lone trailing period/dot that may remain after the path is gone:
  // ` saved at /path/clip.mp4. Transcript` → `. Transcript` (period kept by
  // path-strip), normalise to `Transcript`. We only do this when the bare
  // dot sits between bracket-content (no preceding non-whitespace word
  // ending in `.` other than the artefact).
  out = out.replace(/\[Video note \. /g, '[Video note ');
  // Drop the now-redundant `Image saved at` → `Image`, and the trailing
  // `— use Read tool to view it.` artefact left after path removal.
  out = out.replace(/\[Image(\s+Caption:)/g, '[Photo$1');
  out = out.replace(/\[Image\s+—\s+use Read tool to view it\.?/g, '[Photo');
  out = out.replace(/\[Image\]/g, '[Photo]');
  out = out.replace(/\s+\]/g, ']');
  out = out.replace(/\s+—\s+use Read tool to view it\.?/g, '');
  // Normalize stray double-spaces produced by the substitutions.
  out = out.replace(/ {2,}/g, ' ');
  return out;
}

interface MessageRow {
  id: string;
  chat_jid: string;
  content: string;
}

export async function main(argv = process.argv): Promise<void> {
  const args = parseArgs(argv);

  let stat;
  try {
    stat = await fs.stat(args.dbPath);
  } catch {
    process.stderr.write(`DB not found: ${args.dbPath}\n`);
    process.exit(2);
  }
  if (!stat.isFile()) {
    process.stderr.write(`DB path is not a file: ${args.dbPath}\n`);
    process.exit(2);
  }

  if (!args.dry) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${args.dbPath}.before-sanitize-${ts}.db`;
    await fs.copyFile(args.dbPath, backup);
    process.stdout.write(`Backup written: ${backup}\n`);
  }

  const db = new Database(args.dbPath, { readonly: args.dry });
  try {
    // Only legacy media placeholders are candidates: content must start with
    // a known `[<Type>` bracket AND embed the absolute macOS home-path marker.
    // This keeps free-form user messages that merely mention a /Users/ path
    // out of the candidate set entirely. (Note: in
    // SQLite LIKE, `[` is a literal — bracket character-classes are GLOB-only.)
    const rows = db
      .prepare(
        `SELECT id, chat_jid, content
         FROM messages
         WHERE content LIKE ?
           AND (
                content LIKE '[Voice%'
             OR content LIKE '[Image%'
             OR content LIKE '[Photo%'
             OR content LIKE '[Video note%'
             OR content LIKE '[Video%'
             OR content LIKE '[Document%'
             OR content LIKE '[Audio%'
           )`,
      )
      .all(`%${LEGACY_SAVED_AT_MARKER}%`) as MessageRow[];

    let changed = 0;
    let unchanged = 0;
    const update = args.dry
      ? null
      : db.prepare(
          'UPDATE messages SET content = ? WHERE id = ? AND chat_jid = ?',
        );

    const tx = args.dry
      ? null
      : db.transaction((items: MessageRow[]) => {
          for (const row of items) {
            const next = sanitizeContent(row.content);
            if (next !== row.content) {
              update!.run(next, row.id, row.chat_jid);
              changed++;
            } else {
              unchanged++;
            }
          }
        });

    if (args.dry) {
      for (const row of rows) {
        const next = sanitizeContent(row.content);
        if (next !== row.content) changed++;
        else unchanged++;
      }
    } else {
      tx!(rows);
    }

    process.stdout.write(
      `rows matched: ${rows.length} | changed: ${changed} | unchanged: ${unchanged}${args.dry ? ' (dry)' : ''}\n`,
    );
  } finally {
    db.close();
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/sanitize-messages-content.js') ||
  process.argv[1]?.endsWith('/sanitize-messages-content.ts');

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
