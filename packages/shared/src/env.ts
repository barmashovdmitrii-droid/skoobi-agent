import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const MAX_ENV_FILE_BYTES = 1024 * 1024;

function readBoundedEnvFile(filePath: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 0 ||
      before.size > MAX_ENV_FILE_BYTES
    ) {
      throw new Error('unsafe env file metadata');
    }
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const read = fs.readSync(fd, data, offset, data.length - offset, null);
      if (read <= 0) break;
      offset += read;
    }
    const probe = Buffer.allocUnsafe(1);
    const extra = fs.readSync(fd, probe, 0, 1, null);
    const after = fs.fstatSync(fd);
    if (
      offset !== before.size ||
      extra !== 0 ||
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.gid !== before.gid ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error('env file changed while reading');
    }
    return data.toString('utf8');
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
/**
 * Resolve the .env file path.
 * Priority: CLAUDECLAW_ENV_FILE > cwd/.env
 */
function resolveEnvPath(): string {
  if (process.env.CLAUDECLAW_ENV_FILE) return process.env.CLAUDECLAW_ENV_FILE;
  return path.join(process.cwd(), '.env');
}

export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = resolveEnvPath();
  let content: string;
  try {
    content = readBoundedEnvFile(envFile);
  } catch (err) {
    logger.debug(
      {
        errorType: err instanceof Error ? err.name : 'unknown',
      },
      '.env file unavailable or unsafe, using defaults',
    );
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
