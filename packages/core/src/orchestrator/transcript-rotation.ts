/**
 * Size-capped auto-rotation guard for Claude Agent SDK transcripts.
 *
 * Each group is pinned to one SDK session id; the runner resumes it with
 * `claude --resume <id>` on every inbound message and the SDK appends every
 * turn to `<DATA_DIR>/sessions/<folder>/.claude/projects/<projectKey>/<id>.jsonl`
 * forever. SDK auto-compaction (the runner's PreCompact hook) only shrinks the
 * in-context window, never the on-disk file — so the transcript grows unbounded
 * until even compaction cannot fit it and every resume fails with
 * "Prompt is too long".
 *
 * Before resuming, the host stats the target transcript; once it exceeds
 * MAX_TRANSCRIPT_BYTES it is archived under store/archive/sessions/ and the
 * group's session mapping is cleared so it rolls onto a fresh session. Working
 * memory survives — it lives in groups/<folder>/memory + conversations +
 * CLAUDE.md, not in the transcript.
 *
 * This runs host-side (not in the runner): the sandboxed guest is denied writes
 * to store/, and the host owns DATA_DIR, the archive dir, and the sessions
 * table.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_TRANSCRIPT_BYTES, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { isSafeRuntimeSessionId } from './runtime-namespace.js';

export interface TranscriptRotation {
  /** Size of the transcript at rotation time, in bytes. */
  bytes: number;
  /** Absolute path the transcript was read from before rotation. */
  transcriptPath: string;
  /** Where the transcript was archived; undefined if the archive move failed. */
  archivedPath?: string;
  /** Error message if archiving failed — the session is rotated regardless. */
  archiveError?: string;
}

export interface RotateTranscriptOptions {
  /** Override DATA_DIR root (tests). */
  dataDir?: string;
  /** Override STORE_DIR root (tests). */
  storeDir?: string;
  /** Override the size cap (tests / per-call). */
  maxBytes?: number;
  /** Clock injection (tests). */
  now?: () => Date;
}

/**
 * Locate the on-disk SDK transcript for a (group, session). The session id is a
 * UUID, unique across project dirs, so we match the filename rather than
 * reconstructing Claude Code's projectKey path-encoding. Returns undefined when
 * no matching transcript exists yet.
 */
export function findTranscriptPath(
  groupFolder: string,
  sessionId: string,
  dataDir: string = DATA_DIR,
): string | undefined {
  if (!isValidGroupFolder(groupFolder) || !isSafeRuntimeSessionId(sessionId)) {
    return undefined;
  }

  const directRealDirectory = (
    parentReal: string,
    candidate: string,
  ): string | null => {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      const real = fs.realpathSync(candidate);
      return path.dirname(real) === parentReal ? real : null;
    } catch {
      return null;
    }
  };

  let sessionsReal: string;
  try {
    const sessionsDir = path.resolve(dataDir, 'sessions');
    const stat = fs.lstatSync(sessionsDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    sessionsReal = fs.realpathSync(sessionsDir);
  } catch {
    return undefined;
  }
  const groupReal = directRealDirectory(
    sessionsReal,
    path.join(sessionsReal, groupFolder),
  );
  if (!groupReal) return undefined;
  const claudeReal = directRealDirectory(
    groupReal,
    path.join(groupReal, '.claude'),
  );
  if (!claudeReal) return undefined;
  const projectsDir = directRealDirectory(
    claudeReal,
    path.join(claudeReal, 'projects'),
  );
  if (!projectsDir) return undefined;
  let entries: string[];
  try {
    entries = fs.readdirSync(projectsDir);
  } catch {
    return undefined; // no projects dir yet (fresh group, container mode, etc.)
  }
  for (const entry of entries) {
    const projectReal = directRealDirectory(
      projectsDir,
      path.join(projectsDir, entry),
    );
    if (!projectReal) continue;
    const candidate = path.join(projectReal, `${sessionId}.jsonl`);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        continue;
      }
      const real = fs.realpathSync(candidate);
      if (path.dirname(real) === projectReal) return real;
    } catch {
      // Missing/unsafe candidates are skipped; another project may contain it.
    }
  }
  return undefined;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local-time YYYYMMDD-HHMMSS, matching the manual-archive naming convention. */
function archiveStamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

function moveFile(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      // Archive dir on a different device than DATA_DIR — copy then unlink.
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
      return;
    }
    throw err;
  }
}

/**
 * If the on-disk transcript for (groupFolder, sessionId) exceeds the cap,
 * archive it under store/archive/sessions/ and return rotation details.
 * Returns null when there is nothing to rotate (transcript absent or within the
 * cap).
 *
 * Archiving is best-effort: if the move fails the rotation is still reported
 * (archivedPath undefined, archiveError set) so the caller drops the session
 * and starts fresh anyway — unwedging the group takes priority over preserving
 * the file, which remains on disk for manual recovery.
 */
export function rotateTranscriptIfTooLarge(
  groupFolder: string,
  sessionId: string,
  opts: RotateTranscriptOptions = {},
): TranscriptRotation | null {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const storeDir = opts.storeDir ?? STORE_DIR;
  const maxBytes = opts.maxBytes ?? MAX_TRANSCRIPT_BYTES;

  const transcriptPath = findTranscriptPath(groupFolder, sessionId, dataDir);
  if (!transcriptPath) return null;

  let bytes: number;
  try {
    const stat = fs.lstatSync(transcriptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      return null;
    }
    bytes = stat.size;
  } catch {
    return null;
  }
  if (bytes <= maxBytes) return null;

  const result: TranscriptRotation = { bytes, transcriptPath };
  try {
    const archiveDir = path.join(storeDir, 'archive', 'sessions');
    fs.mkdirSync(archiveDir, { recursive: true });
    const stamp = archiveStamp(opts.now ? opts.now() : new Date());
    const archivedPath = path.join(
      archiveDir,
      `${sessionId}.archived-${stamp}.jsonl`,
    );
    moveFile(transcriptPath, archivedPath);
    result.archivedPath = archivedPath;
  } catch (err) {
    result.archiveError = err instanceof Error ? err.message : String(err);
  }
  return result;
}

export interface RotateHooks {
  /** Remove the group→session mapping (in-memory map + persistent store). */
  clearSession: (groupFolder: string) => void;
  /** Called once when a rotation happened — for the caller's warn log. */
  onRotated: (info: TranscriptRotation, groupFolder: string) => void;
  /** Called if the guard itself errors; the existing session is kept. */
  onError?: (err: unknown, groupFolder: string) => void;
}

/**
 * Resolve the session id a group should resume, first rotating the on-disk
 * transcript if it has grown past the cap. Returns the id to resume — the same
 * id when the transcript is healthy or absent, or `undefined` to force a fresh
 * session after a rotation.
 *
 * Never throws: a guard failure falls back to resuming the existing session so
 * it can't block message handling. (Worst case it stays as-is until the next
 * message, exactly as before this guard existed.)
 */
export function resolveResumeSessionId(
  groupFolder: string,
  sessionId: string | undefined,
  hooks: RotateHooks,
  opts: RotateTranscriptOptions = {},
): string | undefined {
  if (!sessionId) return sessionId;
  if (!isValidGroupFolder(groupFolder) || !isSafeRuntimeSessionId(sessionId)) {
    try {
      hooks.clearSession(groupFolder);
    } catch (err) {
      hooks.onError?.(err, groupFolder);
    }
    return undefined;
  }
  let rotation: TranscriptRotation | null = null;
  try {
    rotation = rotateTranscriptIfTooLarge(groupFolder, sessionId, opts);
  } catch (err) {
    hooks.onError?.(err, groupFolder);
    return sessionId;
  }
  if (!rotation) return sessionId;
  try {
    hooks.clearSession(groupFolder);
  } catch (err) {
    hooks.onError?.(err, groupFolder);
  }
  hooks.onRotated(rotation, groupFolder);
  return undefined;
}
