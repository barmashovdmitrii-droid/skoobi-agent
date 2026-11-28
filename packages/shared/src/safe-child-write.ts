import { spawnSync } from 'child_process';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HELPER = fileURLToPath(
  new URL('../../../scripts/safe-write-direct-child.py', import.meta.url),
);
const PYTHON = process.platform === 'darwin' ? '/usr/bin/python3' : 'python3';
const MAX_HELPER_INPUT_BYTES = 8 * 1024 * 1024;

interface DirectWriteHelperResult {
  status?: unknown;
  path?: unknown;
  reason?: unknown;
  deleted_files?: unknown;
}

export interface SafeDirectChildWriteInput {
  parentDirectory: string;
  childDirectoryName: string;
  fileName: string;
  data: string | Buffer;
  maxBytes: number;
}

export interface SafeMarkdownTombstoneInput {
  memoryDirectory: string;
  tombstoneFileName: string;
  renameStamp: string;
  metadata: Record<string, unknown>;
  maxBytes: number;
  maxEntries?: number;
}

function safeSingleName(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('\0') &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

/**
 * Write through Python's dir_fd/openat primitives, which Node does not expose.
 * The returned path is only reported after the direct child still names the
 * opened directory and the final inode is a single-link regular file.
 */
export function writeDirectChildFileNoFollowSync(
  input: SafeDirectChildWriteInput,
): string {
  if (
    !safeSingleName(input.childDirectoryName) ||
    !safeSingleName(input.fileName) ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes <= 0 ||
    input.maxBytes > MAX_HELPER_INPUT_BYTES
  ) {
    throw new Error('Unsafe direct-child write input');
  }
  const data = Buffer.isBuffer(input.data)
    ? input.data
    : Buffer.from(input.data, 'utf8');
  if (data.length > input.maxBytes) {
    throw new Error('Direct-child write exceeds size limit');
  }

  const parentStat = fs.lstatSync(input.parentDirectory);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('Unsafe direct-child write parent');
  }
  // realpath removes stable platform ancestors such as macOS /var -> /private/var;
  // the helper then opens every remaining component with O_NOFOLLOW.
  const parent = fs.realpathSync(input.parentDirectory);
  const result = spawnSync(
    PYTHON,
    [
      HELPER,
      '--parent',
      parent,
      '--child',
      input.childDirectoryName,
      '--file',
      input.fileName,
      '--max-bytes',
      String(input.maxBytes),
      '--expected-dev',
      String(parentStat.dev),
      '--expected-ino',
      String(parentStat.ino),
    ],
    {
      input: data,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    },
  );
  let parsed: DirectWriteHelperResult | null = null;
  try {
    parsed = JSON.parse(result.stdout || 'null') as DirectWriteHelperResult;
  } catch {
    parsed = null;
  }
  if (
    result.status !== 0 ||
    parsed?.status !== 'written' ||
    typeof parsed.path !== 'string'
  ) {
    const reason =
      typeof parsed?.reason === 'string'
        ? parsed.reason
        : result.error?.message || result.stderr || 'helper-failed';
    throw new Error(`Unsafe direct-child write rejected: ${reason}`);
  }
  return parsed.path;
}

/**
 * Rename every regular, single-link Markdown file below one memory root using
 * renameat on verified directory descriptors, then publish the audit marker in
 * an already-open `tombstones` child. Symlink directories are never traversed.
 */
export function tombstoneMarkdownTreeNoFollowSync(
  input: SafeMarkdownTombstoneInput,
): { tombstonePath: string; deletedFiles: string[] } {
  if (
    !safeSingleName(input.tombstoneFileName) ||
    !safeSingleName(input.renameStamp) ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes <= 0 ||
    input.maxBytes > MAX_HELPER_INPUT_BYTES ||
    !Number.isSafeInteger(input.maxEntries ?? 10_000) ||
    (input.maxEntries ?? 10_000) <= 0 ||
    Object.hasOwn(input.metadata, 'deleted_files')
  ) {
    throw new Error('Unsafe Markdown tombstone input');
  }
  const memoryStat = fs.lstatSync(input.memoryDirectory);
  if (!memoryStat.isDirectory() || memoryStat.isSymbolicLink()) {
    throw new Error('Unsafe Markdown tombstone root');
  }
  const memory = fs.realpathSync(input.memoryDirectory);
  const data = Buffer.from(JSON.stringify(input.metadata), 'utf8');
  if (data.length > input.maxBytes) {
    throw new Error('Markdown tombstone metadata exceeds size limit');
  }
  const result = spawnSync(
    PYTHON,
    [
      HELPER,
      '--operation',
      'tombstone-markdown',
      '--parent',
      memory,
      '--file',
      input.tombstoneFileName,
      '--rename-stamp',
      input.renameStamp,
      '--max-bytes',
      String(input.maxBytes),
      '--max-entries',
      String(input.maxEntries ?? 10_000),
      '--expected-dev',
      String(memoryStat.dev),
      '--expected-ino',
      String(memoryStat.ino),
    ],
    {
      input: data,
      encoding: 'utf8',
      maxBuffer: input.maxBytes + 64 * 1024,
      timeout: 30_000,
    },
  );
  let parsed: DirectWriteHelperResult | null = null;
  try {
    parsed = JSON.parse(result.stdout || 'null') as DirectWriteHelperResult;
  } catch {
    parsed = null;
  }
  if (
    result.status !== 0 ||
    parsed?.status !== 'written' ||
    typeof parsed.path !== 'string' ||
    !Array.isArray(parsed.deleted_files) ||
    !parsed.deleted_files.every((value: unknown) => typeof value === 'string')
  ) {
    const reason =
      typeof parsed?.reason === 'string'
        ? parsed.reason
        : result.error?.message || result.stderr || 'helper-failed';
    throw new Error(`Unsafe Markdown tombstone rejected: ${reason}`);
  }
  return {
    tombstonePath: parsed.path,
    deletedFiles: parsed.deleted_files as string[],
  };
}
