import fs from 'fs';

export interface BoundedRegularFileRead {
  buffer: Buffer;
  size: number;
  truncated: boolean;
}

export interface BoundedRegularFileReadOptions {
  maxBytes: number;
  oversize: 'reject' | 'truncate';
  requireSingleLink?: boolean;
}

/**
 * Read a bounded regular file without ever reopening its pathname.
 *
 * O_NOFOLLOW rejects a symlink at the final path component. O_NONBLOCK keeps a
 * malicious FIFO from blocking the host in open(2); fstat then rejects every
 * non-regular file. All size checks and reads apply to the same open inode.
 */
export function readBoundedRegularFileNoFollowSync(
  filePath: string,
  options: BoundedRegularFileReadOptions,
): BoundedRegularFileRead {
  const { maxBytes, oversize, requireSingleLink = false } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }

  const flags =
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const fd = fs.openSync(filePath, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Refusing to read non-regular file: ${filePath}`);
    }
    if (requireSingleLink && stat.nlink !== 1) {
      throw new Error(
        `Refusing file with multiple hard links (${stat.nlink}): ${filePath}`,
      );
    }
    if (oversize === 'reject' && stat.size > maxBytes) {
      throw new Error(
        `File too large (${stat.size} bytes > ${maxBytes} byte cap)`,
      );
    }

    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    let bytesRead = 0;
    while (bytesRead < bytesToRead) {
      const count = fs.readSync(
        fd,
        buffer,
        bytesRead,
        bytesToRead - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }

    if (oversize === 'reject') {
      // A file can grow after fstat. Probe one byte past the observed size so a
      // concurrent append is rejected instead of silently parsing a prefix.
      const probe = Buffer.allocUnsafe(1);
      const extra = fs.readSync(fd, probe, 0, 1, null);
      if (extra > 0) {
        throw new Error(`File grew while being read; refusing unstable input`);
      }
    }
    const finalStat = fs.fstatSync(fd);
    if (
      !finalStat.isFile() ||
      (requireSingleLink && finalStat.nlink !== 1) ||
      finalStat.dev !== stat.dev ||
      finalStat.ino !== stat.ino ||
      finalStat.mode !== stat.mode ||
      finalStat.uid !== stat.uid ||
      finalStat.gid !== stat.gid ||
      finalStat.size !== stat.size ||
      finalStat.mtimeMs !== stat.mtimeMs ||
      finalStat.ctimeMs !== stat.ctimeMs ||
      (oversize === 'reject' && bytesRead !== stat.size)
    ) {
      throw new Error(`File changed while being read; refusing unstable input`);
    }

    return {
      buffer: buffer.subarray(0, bytesRead),
      size: stat.size,
      truncated: stat.size > bytesRead,
    };
  } finally {
    fs.closeSync(fd);
  }
}
