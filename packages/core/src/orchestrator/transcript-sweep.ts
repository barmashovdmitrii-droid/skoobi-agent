//
// Additive module. Does NOT modify any existing file. Reuses the existing
// rotation primitives (findTranscriptPath / rotateTranscriptIfTooLarge /
// MAX_TRANSCRIPT_BYTES) and config (DATA_DIR / STORE_DIR) verbatim.
//
/**
 * Host-side, pin-agnostic transcript SWEEP.
 *
 * The per-message guard (`resolveResumeSessionId` in transcript-rotation.ts)
 * only inspects the transcript of a group that is *being resumed right now* —
 * i.e. a session that is still PINNED in the `sessions` table and receiving
 * messages. That correctly unwedges active groups, but it never reclaims:
 *
 *   - ORPHANS: a `<id>.jsonl` whose session id has no row in `sessions`
 *     (the group was cleared/rotated, or never re-pinned). Such a file is
 *     never resumed, so the guard never stats it. For example, an unpinned
 *     over-cap transcript can otherwise remain on disk indefinitely.
 *   - IDLE PINS: a pinned session whose group simply hasn't sent a message,
 *     so the guard hasn't had a chance to run for it yet.
 *
 * This sweep walks every on-disk transcript under
 *   <DATA_DIR>/sessions/<folder>/.claude/projects/<projectKey>/<id>.jsonl
 * and archives any file over the cap, regardless of pin. It is DRY-RUN by
 * default (it only reports what it would do); an explicit opt-in (`apply:true`
 * / `--apply` from the CLI) is required to actually move files.
 *
 * Pin handling (simplest correct behavior):
 *   - We reuse `rotateTranscriptIfTooLarge`, which performs an *atomic*
 *     `fs.renameSync` (with an EXDEV copy+unlink fallback). The same atomic
 *     move is what the per-message guard uses, so the two cannot corrupt each
 *     other: whichever moves the file first wins, and the loser's
 *     `findTranscriptPath` then returns undefined → the rotate is a no-op
 *     (returns null). No locking is required.
 *   - If a swept file belongs to a CURRENTLY-PINNED session (its id matches a
 *     value returned by the injected `getSessions()`), we additionally invoke
 *     `clearSession(folder)` so the DB row and the live in-memory map are
 *     dropped and the group rolls onto a fresh session — exactly the end-state
 *     the per-message guard produces. For ORPHANS there is no row, so no
 *     clear is needed (and none is attempted).
 *
 * This runs host-side (the sandboxed guest cannot write to store/). It never
 * throws: a failure on one file is logged and the walk continues.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_TRANSCRIPT_BYTES, STORE_DIR } from './config.js';
import {
  rotateTranscriptIfTooLarge,
  type TranscriptRotation,
} from './transcript-rotation.js';

/** One transcript the sweep considered. */
export interface SweptTranscript {
  /** Group folder name, e.g. `guest_example`. */
  groupFolder: string;
  /** SDK session id parsed from the `<id>.jsonl` filename. */
  sessionId: string;
  /** Absolute path of the on-disk transcript. */
  transcriptPath: string;
  /** Size in bytes at inspection time. */
  bytes: number;
  /** True if the session id is still pinned in the `sessions` table. */
  pinned: boolean;
  /**
   * What the sweep did (or, in dry-run, would do):
   *   - 'archived'  : moved under store/archive/sessions/ (apply mode only)
   *   - 'would-archive': over cap, but dry-run so left in place
   *   - 'archive-failed': over cap, move attempted, move failed (file kept)
   */
  action: 'archived' | 'would-archive' | 'archive-failed';
  /** Set when action==='archived'. */
  archivedPath?: string;
  /** Set when action==='archive-failed'. */
  error?: string;
  /** True if a pinned session was cleared as a result (apply mode only). */
  sessionCleared?: boolean;
}

export interface SweepResult {
  /** Whether files were actually moved (apply) or only reported (dry). */
  apply: boolean;
  /** Size cap used, in bytes. */
  maxBytes: number;
  /** Every transcript file found (any size). */
  scanned: number;
  /** Transcripts that exceeded the cap. */
  overCap: number;
  /** Bytes in over-cap files (what was/would be reclaimed). */
  reclaimableBytes: number;
  /** Detailed per-file records for the over-cap files only. */
  swept: SweptTranscript[];
}

export interface SweepOptions {
  /** Override DATA_DIR root (tests). */
  dataDir?: string;
  /** Override STORE_DIR root (tests). */
  storeDir?: string;
  /** Override the size cap (tests / per-call). */
  maxBytes?: number;
  /** Clock injection (tests). */
  now?: () => Date;
  /**
   * Actually move over-cap files. Default FALSE (dry-run: report only).
   * Must be explicitly set to true to mutate the filesystem.
   */
  apply?: boolean;
  /**
   * Snapshot of pinned sessions (`group_folder` → `session_id`). Used to
   * decide whether a swept file is pinned (so we also clear the session) or
   * an orphan (archive only). Defaults to an empty map → everything treated
   * as an orphan (archive only, never clears a session). Inject
   * `getAllSessions` from db.ts at the call site.
   */
  getSessions?: () => Record<string, string>;
  /**
   * Drop a pinned group's session mapping (db.ts `clearSession`). Only called
   * in apply mode, only for files whose id is currently pinned. Optional: if
   * omitted, pinned files are still archived but the session row is left for
   * the per-message guard to clear on the group's next message.
   */
  clearSession?: (groupFolder: string) => void;
}

const SESSION_FILE_RE = /\.jsonl$/i;

/**
 * Enumerate every on-disk transcript:
 *   <dataDir>/sessions/<folder>/.claude/projects/<projectKey>/<id>.jsonl
 * Returns { groupFolder, sessionId, transcriptPath } tuples. Never throws;
 * unreadable subtrees are skipped.
 */
export function listAllTranscripts(
  dataDir: string = DATA_DIR,
): Array<{ groupFolder: string; sessionId: string; transcriptPath: string }> {
  const out: Array<{
    groupFolder: string;
    sessionId: string;
    transcriptPath: string;
  }> = [];
  const sessionsRoot = path.join(dataDir, 'sessions');

  let folders: fs.Dirent[];
  try {
    folders = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return out; // no sessions dir yet
  }

  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const groupFolder = folder.name;
    const projectsDir = path.join(
      sessionsRoot,
      groupFolder,
      '.claude',
      'projects',
    );
    let projects: fs.Dirent[];
    try {
      projects = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      continue; // no .claude/projects for this group (fresh / container mode)
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(projectsDir, project.name);
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !SESSION_FILE_RE.test(file.name)) continue;
        const sessionId = file.name.replace(SESSION_FILE_RE, '');
        out.push({
          groupFolder,
          sessionId,
          transcriptPath: path.join(projectDir, file.name),
        });
      }
    }
  }
  return out;
}

/**
 * Walk every transcript and archive (or, in dry-run, report) those over the
 * cap, regardless of pin. See module header for pin/orphan handling.
 *
 * Never throws. A per-file error is captured in that file's record and the
 * walk continues.
 */
export function sweepOverCapTranscripts(opts: SweepOptions = {}): SweepResult {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const storeDir = opts.storeDir ?? STORE_DIR;
  const maxBytes = opts.maxBytes ?? MAX_TRANSCRIPT_BYTES;
  const apply = opts.apply ?? false;
  const sessions = opts.getSessions ? opts.getSessions() : {};

  // Invert group→id into a set of pinned session ids for O(1) lookup.
  const pinnedIds = new Set(Object.values(sessions));

  const result: SweepResult = {
    apply,
    maxBytes,
    scanned: 0,
    overCap: 0,
    reclaimableBytes: 0,
    swept: [],
  };

  for (const t of listAllTranscripts(dataDir)) {
    result.scanned++;

    let bytes: number;
    try {
      bytes = fs.statSync(t.transcriptPath).size;
    } catch {
      continue; // disappeared between readdir and stat (concurrent move)
    }
    if (bytes <= maxBytes) continue;

    result.overCap++;
    result.reclaimableBytes += bytes;
    const pinned = pinnedIds.has(t.sessionId);

    if (!apply) {
      result.swept.push({
        groupFolder: t.groupFolder,
        sessionId: t.sessionId,
        transcriptPath: t.transcriptPath,
        bytes,
        pinned,
        action: 'would-archive',
      });
      continue;
    }

    // apply mode — reuse the existing atomic rotate primitive.
    let rotation: TranscriptRotation | null = null;
    let error: string | undefined;
    try {
      rotation = rotateTranscriptIfTooLarge(t.groupFolder, t.sessionId, {
        dataDir,
        storeDir,
        maxBytes,
        now: opts.now,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (!rotation) {
      // Lost a race (someone moved/shrank it first), or it errored.
      if (error) {
        result.swept.push({
          groupFolder: t.groupFolder,
          sessionId: t.sessionId,
          transcriptPath: t.transcriptPath,
          bytes,
          pinned,
          action: 'archive-failed',
          error,
        });
      }
      // No rotation and no error → already gone; nothing to record.
      continue;
    }

    const record: SweptTranscript = {
      groupFolder: t.groupFolder,
      sessionId: t.sessionId,
      transcriptPath: rotation.transcriptPath,
      bytes: rotation.bytes,
      pinned,
      action: rotation.archivedPath ? 'archived' : 'archive-failed',
      archivedPath: rotation.archivedPath,
      error: rotation.archiveError,
    };

    // Only clear a session that is actually pinned. Orphans have no row.
    if (pinned && opts.clearSession) {
      try {
        opts.clearSession(t.groupFolder);
        record.sessionCleared = true;
      } catch (err) {
        record.error =
          (record.error ? record.error + '; ' : '') +
          `clearSession failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    result.swept.push(record);
  }

  return result;
}
