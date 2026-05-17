/**
 * Media manifest (Tier 1 retention helper).
 *
 * Each group folder gets a sidecar JSONL at `<folder>/.media-index.jsonl`.
 * Every line is one MediaEntry. We append on save and patch in place when
 * transcription/captioning completes. The file is the source of truth for
 * the retention sweep — it lets us decide what to delete without scanning
 * every file or hitting the DB.
 *
 * Design notes:
 * - JSONL (one JSON object per line) keeps appends O(1) and is friendly to
 *   `tail -n` debugging.
 * - Patches rewrite the whole file via a tmp + atomic rename. The file is
 *   small (one entry per inbound media message) so this is acceptable, and
 *   we avoid in-place edits to keep the manifest consistent on crash.
 * - We do NOT store transcripts or captions here. Those go into the
 *   `messages` table content. The manifest only needs to know whether they
 *   exist so retention can keep media that still lacks a transcript.
 */

import { promises as fs } from 'fs';
import path from 'path';

export type MediaType =
  | 'voice'
  | 'video-note'
  | 'video'
  | 'photo'
  | 'document'
  | 'audio';

export interface MediaEntry {
  message_id: string;
  chat_jid: string;
  basename: string;
  type: MediaType;
  size_bytes: number;
  has_transcript: boolean;
  has_caption: boolean;
  transcript_chars: number;
  created_at: string;
  keep: boolean;
  /** Set by retention sweep when the file is physically removed. ISO timestamp. */
  deleted_at?: string;
}

const MANIFEST_FILENAME = '.media-index.jsonl';

function manifestPath(folderAbsPath: string): string {
  return path.join(folderAbsPath, MANIFEST_FILENAME);
}

/**
 * Append an entry to a folder's media manifest. Creates the file if missing.
 * Concurrency: relies on POSIX append semantics — a single flush is atomic
 * for small JSON lines. Multiple producers append safely on macOS.
 */
export async function appendMediaEntry(
  folderAbsPath: string,
  entry: MediaEntry,
): Promise<void> {
  const file = manifestPath(folderAbsPath);
  await fs.mkdir(folderAbsPath, { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(file, line, 'utf8');
}

/**
 * Read every manifest entry for the folder. Returns [] if the file is
 * missing or empty. Malformed lines are skipped with no error — the
 * retention sweep treats them as not-present.
 */
export async function listMedia(
  folderAbsPath: string,
  filter?: (entry: MediaEntry) => boolean,
): Promise<MediaEntry[]> {
  const file = manifestPath(folderAbsPath);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const entries: MediaEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as MediaEntry;
      if (filter && !filter(parsed)) continue;
      entries.push(parsed);
    } catch {
      // Skip malformed line — manifest is best-effort.
    }
  }
  return entries;
}

/**
 * Patch an entry identified by basename. The patch is shallow-merged on top
 * of the latest matching entry. If multiple entries share a basename (which
 * should not happen in practice), the most-recent one is updated.
 * Rewrites the manifest via tmp + atomic rename.
 */
export async function updateMediaEntry(
  folderAbsPath: string,
  basename: string,
  patch: Partial<MediaEntry>,
): Promise<boolean> {
  const file = manifestPath(folderAbsPath);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  const lines = raw.split('\n');
  let lastMatch = -1;
  const parsed: (MediaEntry | null)[] = lines.map((line, idx) => {
    if (!line.trim()) return null;
    try {
      const entry = JSON.parse(line) as MediaEntry;
      if (entry.basename === basename) lastMatch = idx;
      return entry;
    } catch {
      return null;
    }
  });

  if (lastMatch === -1) return false;

  const merged: MediaEntry = { ...(parsed[lastMatch] as MediaEntry), ...patch };
  parsed[lastMatch] = merged;

  const out =
    parsed
      .filter((e): e is MediaEntry => e !== null)
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n';

  const tmp = file + '.tmp';
  await fs.writeFile(tmp, out, 'utf8');
  await fs.rename(tmp, file);
  return true;
}

/**
 * Get the manifest entry for a specific (message_id, chat_jid). Returns the
 * most-recent match (last write wins), or null if absent.
 */
export async function getMediaForMessage(
  folderAbsPath: string,
  message_id: string,
  chat_jid: string,
): Promise<MediaEntry | null> {
  const entries = await listMedia(folderAbsPath);
  let found: MediaEntry | null = null;
  for (const e of entries) {
    if (e.message_id === message_id && e.chat_jid === chat_jid) found = e;
  }
  return found;
}

/** Convenience helper: flip the keep flag for an entry by basename. */
export async function setKeep(
  folderAbsPath: string,
  basename: string,
  keep: boolean,
): Promise<boolean> {
  return updateMediaEntry(folderAbsPath, basename, { keep });
}

/**
 * Given a media file path under a group folder (typically inside
 * `groups/<folder>/received/`), return the group folder name (one level
 * up from `received`). Returns null if the path does not match the
 * expected layout (e.g. tmp files outside groups/).
 */
export function folderFromMediaPath(p: string): string | null {
  if (typeof p !== 'string' || !p) return null;
  // Walk up the path components until we find ../received/<file>.
  const parts = p.split(path.sep);
  const receivedIdx = parts.lastIndexOf('received');
  if (receivedIdx <= 0) return null;
  // The folder name is one above 'received'.
  return parts[receivedIdx - 1] || null;
}

/**
 * Resolve the absolute folder path that owns the given media file. This is
 * the directory that contains both `received/` and the `.media-index.jsonl`
 * sidecar. Returns null for paths outside the expected layout.
 */
export function folderAbsFromMediaPath(p: string): string | null {
  if (typeof p !== 'string' || !p) return null;
  const receivedDir = path.dirname(p);
  if (path.basename(receivedDir) !== 'received') return null;
  return path.dirname(receivedDir);
}
