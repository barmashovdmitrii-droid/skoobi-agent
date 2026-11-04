import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface DocumentSnapshot {
  path: string;
  sha256: string;
  size: number;
}
export interface DocumentCell {
  address: string;
  type: string;
  value: string;
  formula?: string;
}
export type DocumentContent =
  | { format: 'pdf'; pages: Array<{ number: number; lines: string[] }> }
  | { format: 'xlsx'; sheets: Array<{ name: string; cells: DocumentCell[] }> };
export interface DocumentEvidence {
  snapshot: DocumentSnapshot;
  coverage: 'complete';
  content: DocumentContent;
}
export interface DocumentReaderOptions {
  /** Shipped host reader, never a script supplied inside a document. */
  readerPath: string;
  pythonCommand?: string;
}

export function snapshotDocument(filename: string): {
  snapshot: DocumentSnapshot;
  bytes: Buffer;
} {
  const canonical = fs.realpathSync(filename);
  const fd = fs.openSync(
    canonical,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || stat.size === 0)
      throw new Error('document_size_or_type');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!count) throw new Error('document_changed_during_read');
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error('document_changed_during_read');
    return {
      snapshot: {
        path: canonical,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      },
      bytes,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export async function readDocumentEvidence(
  filename: string,
  options: DocumentReaderOptions,
): Promise<DocumentEvidence> {
  const { snapshot, bytes } = snapshotDocument(filename);
  const extension = path.extname(filename).toLowerCase();
  if (extension !== '.pdf' && extension !== '.xlsx')
    throw new Error('unsupported_format');
  const content = await new Promise<DocumentContent>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--max-old-space-size=192',
        options.readerPath,
        extension.slice(1),
        options.pythonCommand || 'python3',
      ],
      {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH || '' },
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > 4 * 1024 * 1024)
        return reject(new Error('document_reader_incomplete'));
      try {
        resolve(
          JSON.parse(Buffer.concat(chunks).toString()) as DocumentContent,
        );
      } catch {
        reject(new Error('document_reader_incomplete'));
      }
    });
    child.stdin.end(bytes);
  });
  return { snapshot, coverage: 'complete', content };
}

export function documentSnapshotsCurrent(
  snapshots: DocumentSnapshot[],
): boolean {
  try {
    return snapshots.every((expected) => {
      const actual = snapshotDocument(expected.path).snapshot;
      return actual.sha256 === expected.sha256 && actual.size === expected.size;
    });
  } catch {
    return false;
  }
}
