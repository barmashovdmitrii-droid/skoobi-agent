/**
 * Media manifest (Tier 1 retention helper).
 *
 * Each group folder gets a sidecar JSONL at `<folder>/.media-index.jsonl`.
 * Every line is one MediaEntry or logical patch record. We append both saves
 * and later transcription/caption updates. The file is the source of truth for
 * the retention sweep — it lets us decide what to delete without scanning
 * every file or hitting the DB.
 *
 * Design notes:
 * - JSONL (one JSON object per line) keeps appends O(1) and is friendly to
 *   `tail -n` debugging.
 * - Updates are append-only patch records. Readers fold them in order, so an
 *   independent process can append without a stale read/rewrite losing data.
 * - We do NOT store transcripts or captions here. Those go into the
 *   `messages` table content. The manifest only needs to know whether they
 *   exist so retention can keep media that still lacks a transcript.
 */

import { constants, promises as fs, type Stats } from 'fs';
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
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_LINE_BYTES = 64 * 1024;
const MAX_MANIFEST_WRITABLE_RECORDS = 50_000;
// Two independent host processes can both observe record 49,999 immediately
// before their atomic O_APPEND writes. Keep a small bounded read headroom so
// that unavoidable boundary overshoot remains readable; all subsequent writers
// recount/reject at the strict writable cap instead of permanently poisoning
// the manifest. The byte limit remains the primary memory bound.
const MAX_MANIFEST_READ_RECORDS = MAX_MANIFEST_WRITABLE_RECORDS + 128;
const MAX_PENDING_WRITES_PER_MANIFEST = 32;
const MAX_PENDING_WRITES_GLOBAL = 128;
const MANIFEST_QUEUE_WAIT_DEADLINE_MS = 5_000;
const MAX_MANIFEST_SHAPE_CACHE_ENTRIES = 1_024;
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const NONBLOCK = constants.O_NONBLOCK || 0;

interface ManifestShapeCacheEntry {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  records: number;
}

const manifestShapeCache = new Map<string, ManifestShapeCacheEntry>();

function cacheManifestShape(
  file: string,
  stat: Stats,
  records: number,
): void {
  // Refresh insertion order so the simple first-key eviction behaves as LRU.
  manifestShapeCache.delete(file);
  manifestShapeCache.set(file, {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    records,
  });
  if (manifestShapeCache.size > MAX_MANIFEST_SHAPE_CACHE_ENTRIES) {
    const oldest = manifestShapeCache.keys().next().value;
    if (oldest !== undefined) manifestShapeCache.delete(oldest);
  }
}

function manifestPath(folderAbsPath: string): string {
  return path.join(folderAbsPath, MANIFEST_FILENAME);
}

function manifestError(message: string, code = 'EACCES'): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function assertSafeManifestStat(stat: Stats): void {
  if (!stat.isFile() || stat.nlink !== 1) {
    throw manifestError('Unsafe media manifest: expected one regular file');
  }
  if (stat.size > MAX_MANIFEST_BYTES) {
    throw manifestError('Media manifest exceeds byte limit', 'EFBIG');
  }
}

function assertManifestTextShape(
  raw: string,
  maxRecords = MAX_MANIFEST_READ_RECORDS,
): number {
  let entries = 0;
  let start = 0;
  while (start <= raw.length) {
    const newline = raw.indexOf('\n', start);
    const end = newline === -1 ? raw.length : newline;
    const line = raw.slice(start, end);
    if (Buffer.byteLength(line, 'utf8') > MAX_MANIFEST_LINE_BYTES) {
      throw manifestError('Media manifest line exceeds byte limit', 'EFBIG');
    }
    if (line.trim()) {
      entries += 1;
      if (entries > maxRecords) {
        throw manifestError('Media manifest exceeds entry limit', 'EFBIG');
      }
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return entries;
}

async function readManifestSafely(file: string): Promise<string> {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | NOFOLLOW | NONBLOCK,
  );
  try {
    const before = await handle.stat();
    assertSafeManifestStat(before);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, MAX_MANIFEST_BYTES + 1 - total),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_MANIFEST_BYTES) {
        throw manifestError('Media manifest exceeds byte limit', 'EFBIG');
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    assertSafeManifestStat(after);
    const raw = Buffer.concat(chunks, total).toString('utf8');
    const records = assertManifestTextShape(raw);
    if (
      after.dev === before.dev &&
      after.ino === before.ino &&
      after.size === before.size &&
      after.mtimeMs === before.mtimeMs &&
      after.ctimeMs === before.ctimeMs
    ) {
      cacheManifestShape(file, after, records);
    }
    return raw;
  } finally {
    await handle.close();
  }
}

/**
 * True only for a plain, single-segment file name that is safe to join onto a
 * media directory.
 *
 * SECURITY: `MediaEntry.basename` originates from `<group>/.media-index.jsonl`,
 * which lives inside a tenant's own (writable) group folder — i.e. it is
 * ATTACKER-CONTROLLED. The retention sweep joins it onto `<folder>/received/`
 * and `fs.unlink`s the result; a basename like `../../../.env` or an absolute
 * path would then delete arbitrary host files (the prod DB, `.env`, payment
 * artifacts, another tenant's media). Requiring `path.basename(b) === b` (plus
 * no NUL, no `.`/`..`, bounded length) guarantees the join cannot escape the
 * intended directory. Callers MUST gate any filesystem use of a manifest
 * basename through this check.
 */
export function isSafeMediaBasename(basename: unknown): basename is string {
  return (
    typeof basename === 'string' &&
    basename.length > 0 &&
    basename.length <= 255 &&
    !basename.includes('\0') &&
    basename !== '.' &&
    basename !== '..' &&
    !basename.includes('/') &&
    !basename.includes('\\') &&
    path.basename(basename) === basename
  );
}

/**
 * Append an entry to a folder's media manifest. Creates the file if missing.
 * Concurrency: relies on POSIX append semantics — each JSON line is emitted by
 * one write syscall, so independent producers cannot overwrite one another.
 * The in-process lock also bounds/serializes local writers and maintains the
 * cached record count used by the fail-before-write cap.
 */
async function appendManifestLineUnlocked(
  folderAbsPath: string,
  file: string,
  line: string,
): Promise<void> {
  if (Buffer.byteLength(line, 'utf8') > MAX_MANIFEST_LINE_BYTES) {
    throw manifestError('Media manifest entry exceeds line limit', 'EFBIG');
  }
  await fs.mkdir(folderAbsPath, { recursive: true });
  const handle = await fs.open(
    file,
    constants.O_RDWR |
      constants.O_APPEND |
      constants.O_CREAT |
      NOFOLLOW |
      NONBLOCK,
    0o600,
  );
  try {
    const before = await handle.stat();
    assertSafeManifestStat(before);
    // The record cap is a read-side safety boundary. Enforce it before every
    // append so a valid 50,000-record manifest cannot be
    // poisoned by one successful 50,001st write and become permanently
    // unreadable. Read through this already-open descriptor: a pathname swap
    // cannot make us count one inode and append to another.
    const cached = manifestShapeCache.get(file);
    let recordCount: number;
    if (
      cached &&
      cached.dev === before.dev &&
      cached.ino === before.ino &&
      cached.size === before.size &&
      cached.mtimeMs === before.mtimeMs &&
      cached.ctimeMs === before.ctimeMs
    ) {
      recordCount = cached.records;
    } else {
      const chunks: Buffer[] = [];
      let total = 0;
      while (total < before.size) {
        const chunk = Buffer.allocUnsafe(
          Math.min(64 * 1024, before.size - total),
        );
        const { bytesRead } = await handle.read(
          chunk,
          0,
          chunk.length,
          total,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const counted = await handle.stat();
      if (
        counted.dev !== before.dev ||
        counted.ino !== before.ino ||
        counted.size !== before.size ||
        counted.nlink !== before.nlink ||
        counted.mtimeMs !== before.mtimeMs ||
        counted.ctimeMs !== before.ctimeMs ||
        total !== before.size
      ) {
        throw manifestError(
          'Media manifest changed while counting records',
          'EBUSY',
        );
      }
      recordCount = assertManifestTextShape(
        Buffer.concat(chunks, total).toString('utf8'),
      );
      cacheManifestShape(file, before, recordCount);
    }
    if (recordCount >= MAX_MANIFEST_WRITABLE_RECORDS) {
      throw manifestError('Media manifest exceeds entry limit', 'EFBIG');
    }
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (before.size + lineBytes > MAX_MANIFEST_BYTES) {
      throw manifestError('Media manifest exceeds byte limit', 'EFBIG');
    }
    // One O_APPEND write syscall: independent bot/retention processes cannot
    // overwrite or split each other's small JSONL records.
    const { bytesWritten } = await handle.write(line, null, 'utf8');
    if (bytesWritten !== lineBytes) {
      throw manifestError('Short media manifest append', 'EIO');
    }
    const after = await handle.stat();
    assertSafeManifestStat(after);
    if (after.size === before.size + lineBytes) {
      cacheManifestShape(file, after, recordCount + 1);
    } else {
      // Another process appended concurrently. Its record remains safe under
      // O_APPEND, but the next local writer must recount before enforcing cap.
      manifestShapeCache.delete(file);
    }
  } finally {
    await handle.close();
  }
}

export async function appendMediaEntry(
  folderAbsPath: string,
  entry: MediaEntry,
): Promise<void> {
  const file = manifestPath(folderAbsPath);
  const line = JSON.stringify(entry) + '\n';
  await withFileLock(file, () =>
    appendManifestLineUnlocked(folderAbsPath, file, line),
  );
}

interface MediaPatchRecord {
  skoobi_media_patch_v1: 1;
  basename: string;
  patch: Partial<MediaEntry>;
}

function parseManifestEntries(raw: string): MediaEntry[] {
  const entries: MediaEntry[] = [];
  const latestByBasename = new Map<string, number>();
  let start = 0;
  while (start <= raw.length) {
    const newline = raw.indexOf('\n', start);
    const end = newline === -1 ? raw.length : newline;
    const line = raw.slice(start, end);
    if (line.trim()) {
      try {
        const parsed = JSON.parse(line) as MediaEntry | MediaPatchRecord;
        if (
          'skoobi_media_patch_v1' in parsed &&
          parsed.skoobi_media_patch_v1 === 1 &&
          isSafeMediaBasename(parsed.basename) &&
          parsed.patch &&
          typeof parsed.patch === 'object' &&
          !Array.isArray(parsed.patch)
        ) {
          const index = latestByBasename.get(parsed.basename);
          if (index !== undefined) {
            const previousBasename = entries[index].basename;
            entries[index] = { ...entries[index], ...parsed.patch };
            if (latestByBasename.get(previousBasename) === index) {
              latestByBasename.delete(previousBasename);
            }
            if (isSafeMediaBasename(entries[index].basename)) {
              latestByBasename.set(entries[index].basename, index);
            }
          }
        } else {
          const entry = parsed as MediaEntry;
          entries.push(entry);
          if (isSafeMediaBasename(entry.basename)) {
            latestByBasename.set(entry.basename, entries.length - 1);
          }
        }
      } catch {
        // Skip malformed line — manifest is best-effort.
      }
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return entries;
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
    raw = await readManifestSafely(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const entries = parseManifestEntries(raw);
  return filter ? entries.filter(filter) : entries;
}

/**
 * In-process write lock keyed by manifest file path. The bot is single-process
 * but highly concurrent (many async tasks). Serializing local appends keeps
 * records ordered, bounds backlog, and makes the record-count cache reliable.
 */
interface ManifestWriteLock {
  tail: Promise<void>;
  pending: number;
}

const writeLocks = new Map<string, ManifestWriteLock>();
let pendingManifestWrites = 0;

async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const state =
    writeLocks.get(file) ?? { tail: Promise.resolve(), pending: 0 };
  if (
    state.pending >= MAX_PENDING_WRITES_PER_MANIFEST ||
    pendingManifestWrites >= MAX_PENDING_WRITES_GLOBAL
  ) {
    throw manifestError('Media manifest write queue is full', 'EBUSY');
  }
  state.pending += 1;
  pendingManifestWrites += 1;
  const prev = state.tail;
  let started = false;
  let cancelledWhileQueued = false;
  let timer: NodeJS.Timeout | undefined;
  const queueTimeout = manifestError(
    'Media manifest write queue timed out',
    'ETIMEDOUT',
  );
  const start = (): Promise<T> => {
    // A caller that timed out while still waiting must not leave a latent write
    // behind. The turn remains in the promise chain only as a no-op so pending
    // accounting is released in order when the preceding holder finishes.
    if (cancelledWhileQueued) return Promise.reject(queueTimeout);
    started = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    return fn();
  };
  // Chain our turn onto the prior holder; its rejection must not prevent a new
  // independent write from starting.
  const run = prev.then(start, start);
  // Tail marker for the queue: resolves (never rejects) when `run` settles, so
  // the next waiter chains cleanly regardless of how our section finished.
  const tail = run.then(
    () => {},
    () => {},
  );
  state.tail = tail.finally(() => {
    state.pending = Math.max(0, state.pending - 1);
    pendingManifestWrites = Math.max(0, pendingManifestWrites - 1);
    if (state.pending === 0 && writeLocks.get(file) === state) {
      writeLocks.delete(file);
    }
  });
  writeLocks.set(file, state);
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      if (started) return;
      cancelledWhileQueued = true;
      reject(queueTimeout);
    }, MANIFEST_QUEUE_WAIT_DEADLINE_MS);
    timer.unref();
    run.then(resolve, reject);
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Patch an entry identified by basename. The patch is shallow-merged on top
 * of the latest matching entry. If multiple entries share a basename (which
 * should not happen in practice), the most-recent one is updated.
 * The update itself is an append-only patch record. Readers fold patches in
 * order, so a concurrent append from another process can never be erased by a
 * stale read→rewrite→rename cycle.
 */
export async function updateMediaEntry(
  folderAbsPath: string,
  basename: string,
  patch: Partial<MediaEntry>,
): Promise<boolean> {
  const file = manifestPath(folderAbsPath);
  return withFileLock(file, async () => {
    // Read inside the lock so we only append a patch for an entry that exists in
    // the latest locally-observed manifest. The patch write itself is O_APPEND;
    // no stale snapshot is ever renamed over another process's records.
    let raw: string;
    try {
      raw = await readManifestSafely(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }

    const matched = parseManifestEntries(raw).some(
      (entry) => entry.basename === basename,
    );
    if (!matched) return false;
    const record: MediaPatchRecord = {
      skoobi_media_patch_v1: 1,
      basename,
      patch,
    };
    await appendManifestLineUnlocked(
      folderAbsPath,
      file,
      `${JSON.stringify(record)}\n`,
    );
    return true;
  });
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
