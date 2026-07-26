import fs from 'fs';
import path from 'path';

function lstatIfPresent(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Apply before Baileys creates any key material. Intentionally not restored. */
export function applyPrivateUmask(): void {
  process.umask(0o077);
}

/**
 * Create/fix the auth tree without following symlinks. Baileys creates new
 * files under umask 077; this also repairs permissions on an existing state.
 */
export function secureAuthDirectory(authDir: string): void {
  applyPrivateUmask();
  const parentDir = path.dirname(authDir);
  const parentStat = lstatIfPresent(parentDir);
  if (parentStat) {
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error('WhatsApp auth parent must be a real directory');
    }
  } else {
    fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  }
  const existing = lstatIfPresent(authDir);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error('WhatsApp auth path must be a real directory');
    }
  } else {
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  }
  const rootStat = fs.lstatSync(authDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('WhatsApp auth path must be a real directory');
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && rootStat.uid !== currentUid) {
    throw new Error('WhatsApp auth directory has an unexpected owner');
  }
  fs.chmodSync(authDir, 0o700);

  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error('WhatsApp auth tree must not contain symlinks');
      }
      if (currentUid !== undefined && stat.uid !== currentUid) {
        throw new Error('WhatsApp auth entry has an unexpected owner');
      }
      if (stat.isDirectory()) {
        fs.chmodSync(entryPath, 0o700);
        visit(entryPath);
      } else if (stat.isFile()) {
        fs.chmodSync(entryPath, 0o600);
      } else {
        throw new Error('WhatsApp auth tree contains a special file');
      }
    }
  };
  visit(authDir);
}

export function writePrivateFile(filePath: string, data: string): void {
  applyPrivateUmask();
  const parentDir = path.dirname(filePath);
  const parentStat = lstatIfPresent(parentDir);
  if (parentStat) {
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error('WhatsApp private file parent must be a real directory');
    }
  } else {
    fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  }
  const existing = lstatIfPresent(filePath);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error('WhatsApp private file path must be a regular file');
    }
  }
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC |
      fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK,
    0o600,
  );
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}
