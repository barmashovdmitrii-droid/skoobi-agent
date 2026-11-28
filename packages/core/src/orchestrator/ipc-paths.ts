import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

export const IPC_CATEGORY_DIRECTORY_NAMES = [
  'messages',
  'tasks',
  'swe',
  'memory',
  'google',
  'input',
] as const;

export type IpcCategoryDirectoryName =
  (typeof IPC_CATEGORY_DIRECTORY_NAMES)[number];

export interface IpcDirectoryLayout {
  root: string;
  categories: Record<IpcCategoryDirectoryName, string>;
}

function pathIsWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (Boolean(relative) &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative))
  );
}

function realDirectoryOrNull(directory: string): string | null {
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    return fs.realpathSync(directory);
  } catch {
    return null;
  }
}

/**
 * Provision the fixed IPC directory structure without accepting a pre-planted
 * symlink/non-directory as a mount source. Callers fail closed on an unsafe
 * legacy layout; an operator can then remove the bad entry explicitly.
 */
export function ensureIpcDirectoryLayout(
  groupIpcDir: string,
): IpcDirectoryLayout {
  fs.mkdirSync(groupIpcDir, { recursive: true });
  const root = realDirectoryOrNull(groupIpcDir);
  if (!root) {
    throw new Error(
      `Unsafe IPC root (expected a real directory): ${groupIpcDir}`,
    );
  }

  const categories = {} as Record<IpcCategoryDirectoryName, string>;
  for (const name of IPC_CATEGORY_DIRECTORY_NAMES) {
    const candidate = path.join(root, name);
    fs.mkdirSync(candidate, { recursive: true });
    const real = realDirectoryOrNull(candidate);
    if (!real || !pathIsWithin(root, real)) {
      throw new Error(
        `Unsafe IPC ${name} directory (symlink/non-directory/outside root): ${candidate}`,
      );
    }
    categories[name] = real;
  }

  return { root, categories };
}

/**
 * Resolve an already-existing category for the host watcher/queue. Returns
 * null for missing, symlinked, non-directory, or escaping legacy layouts.
 */
export function resolveExistingSafeIpcCategoryDirectory(
  groupIpcDir: string,
  category: IpcCategoryDirectoryName,
): string | null {
  const root = realDirectoryOrNull(groupIpcDir);
  if (!root) return null;
  const real = realDirectoryOrNull(path.join(root, category));
  if (!real || !pathIsWithin(root, real)) return null;
  return real;
}

/**
 * Atomically replace one file without following a hostile final symlink.
 * The unpredictable same-directory temp is created O_EXCL + O_NOFOLLOW, then
 * rename(2) replaces the directory entry itself (including a symlink), never
 * the symlink target.
 */
export function writeFileAtomicNoFollowSync(
  filePath: string,
  data: string | Buffer,
): void {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const tempPath = path.join(
    directory,
    `.${basename}.${process.pid}.${randomUUID()}.tmp`,
  );
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      // Preserve the old writeFileSync default visibility: when the host
      // service runs as root, the container may still run as uid 1000 and must
      // be able to read snapshots/input envelopes.
      0o644,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Atomic IPC temp is not a regular file: ${tempPath}`);
    }
    let written = 0;
    while (written < buffer.length) {
      const count = fs.writeSync(
        fd,
        buffer,
        written,
        buffer.length - written,
        null,
      );
      if (count <= 0) {
        throw new Error(`Short write while creating IPC file: ${tempPath}`);
      }
      written += count;
    }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort close after a failed write */
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* temp was renamed or never created */
    }
  }
}
