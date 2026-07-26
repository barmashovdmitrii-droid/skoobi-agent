import { createHash } from 'crypto';
import { constants, promises as fs, type Dirent } from 'fs';
import type http from 'http';
import path from 'path';

import {
  isSafeMediaBasename,
  listMedia,
  type MediaEntry,
  type MediaType,
} from '@skoobi/shared/media-manifest';

const NOFOLLOW = constants.O_NOFOLLOW || 0;
const MEDIA_ID_RE = /^[a-f0-9]{24}$/u;
const MAX_MESSAGE_ID_CHARS = 256;

export type DashboardMediaKind = 'image' | 'audio' | 'video' | 'document';

export type DashboardMediaDescriptor = {
  mediaId: string;
  type: MediaType;
  kind: DashboardMediaKind;
  label: string;
  sizeBytes: number;
  mime: string;
};

type MediaCandidate = DashboardMediaDescriptor & {
  folderPath: string;
  basename: string;
};

type OpenMedia = MediaCandidate & {
  handle: Awaited<ReturnType<typeof fs.open>>;
  extension: string;
};

const MIME_BY_EXTENSION: Record<string, string> = {
  '.aac': 'audio/aac',
  '.csv': 'text/csv; charset=utf-8',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function mediaKind(type: MediaType): DashboardMediaKind {
  if (type === 'photo') return 'image';
  if (type === 'voice' || type === 'audio') return 'audio';
  if (type === 'video' || type === 'video-note') return 'video';
  return 'document';
}

function mediaLabel(type: MediaType): string {
  switch (type) {
    case 'photo':
      return 'Фото';
    case 'voice':
      return 'Голосовое';
    case 'audio':
      return 'Аудио';
    case 'video-note':
      return 'Видеосообщение';
    case 'video':
      return 'Видео';
    default:
      return 'Документ';
  }
}

function candidateId(folder: string, basename: string): string {
  return createHash('sha256')
    .update(folder)
    .update('\0')
    .update(basename)
    .digest('hex')
    .slice(0, 24);
}

function mimeFor(entry: MediaEntry): string {
  const extension = path.extname(entry.basename).toLowerCase();
  const byExtension = MIME_BY_EXTENSION[extension];
  if (byExtension) return byExtension;
  switch (mediaKind(entry.type)) {
    case 'image':
      return 'application/octet-stream';
    case 'audio':
      return 'application/octet-stream';
    case 'video':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

function isPlainDirectory(stat: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

async function safeDirectories(groupsRoot: string): Promise<string[]> {
  let rootReal: string;
  let entries: Dirent[];
  try {
    const rootStat = await fs.lstat(groupsRoot);
    if (!isPlainDirectory(rootStat)) return [];
    rootReal = await fs.realpath(groupsRoot);
    entries = await fs.readdir(groupsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const directories: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(entry.name)) continue;
    const folderPath = path.join(groupsRoot, entry.name);
    try {
      const folderStat = await fs.lstat(folderPath);
      if (!isPlainDirectory(folderStat)) continue;
      const folderReal = await fs.realpath(folderPath);
      if (path.dirname(folderReal) !== rootReal) continue;
      const receivedPath = path.join(folderPath, 'received');
      const receivedStat = await fs.lstat(receivedPath);
      if (!isPlainDirectory(receivedStat)) continue;
      const receivedReal = await fs.realpath(receivedPath);
      if (path.dirname(receivedReal) !== folderReal) continue;
      directories.push(folderPath);
    } catch {
      // A group without a real received/ directory simply has no playable media.
    }
  }
  return directories.sort();
}

async function candidateExists(candidate: MediaCandidate): Promise<boolean> {
  if (!isSafeMediaBasename(candidate.basename)) return false;
  const filePath = path.join(
    candidate.folderPath,
    'received',
    candidate.basename,
  );
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
  } catch {
    return false;
  }
}

async function collectCandidates(
  jid: string,
  messageIds: ReadonlySet<string>,
  groupsRoot: string,
): Promise<Map<string, MediaCandidate[]>> {
  const result = new Map<string, MediaCandidate[]>();
  if (messageIds.size === 0) return result;

  for (const folderPath of await safeDirectories(groupsRoot)) {
    let entries: MediaEntry[];
    try {
      entries = await listMedia(
        folderPath,
        (entry) =>
          entry.chat_jid === jid &&
          messageIds.has(entry.message_id) &&
          !entry.deleted_at &&
          isSafeMediaBasename(entry.basename),
      );
    } catch {
      // One damaged manifest must not make all dialogs unavailable.
      continue;
    }
    for (const entry of entries) {
      const kind = mediaKind(entry.type);
      const candidate: MediaCandidate = {
        mediaId: candidateId(path.basename(folderPath), entry.basename),
        type: entry.type,
        kind,
        label: mediaLabel(entry.type),
        sizeBytes: Number.isFinite(entry.size_bytes)
          ? Math.max(0, entry.size_bytes)
          : 0,
        mime: mimeFor(entry),
        folderPath,
        basename: entry.basename,
      };
      if (!(await candidateExists(candidate))) continue;
      const current = result.get(entry.message_id) || [];
      if (!current.some((item) => item.mediaId === candidate.mediaId)) {
        current.push(candidate);
        result.set(entry.message_id, current);
      }
    }
  }

  for (const candidates of result.values()) {
    candidates.sort((a, b) =>
      `${a.kind}\0${a.mediaId}`.localeCompare(`${b.kind}\0${b.mediaId}`),
    );
  }
  return result;
}

export async function listDashboardMediaForMessages(
  jid: string,
  messageIds: readonly string[],
  groupsRoot = path.resolve(process.cwd(), 'groups'),
): Promise<Map<string, DashboardMediaDescriptor[]>> {
  const validIds = new Set(
    messageIds.filter(
      (id) =>
        typeof id === 'string' &&
        id.length > 0 &&
        id.length <= MAX_MESSAGE_ID_CHARS,
    ),
  );
  const candidates = await collectCandidates(jid, validIds, groupsRoot);
  return new Map(
    [...candidates].map(([messageId, items]) => [
      messageId,
      items.map(
        ({ folderPath: _folder, basename: _basename, ...item }) => item,
      ),
    ]),
  );
}

async function openDashboardMedia(
  jid: string,
  messageId: string,
  mediaId: string,
  groupsRoot: string,
): Promise<OpenMedia | null> {
  if (
    !messageId ||
    messageId.length > MAX_MESSAGE_ID_CHARS ||
    !MEDIA_ID_RE.test(mediaId)
  ) {
    return null;
  }
  const candidates = await collectCandidates(
    jid,
    new Set([messageId]),
    groupsRoot,
  );
  const candidate = (candidates.get(messageId) || []).find(
    (item) => item.mediaId === mediaId,
  );
  if (!candidate) return null;

  const filePath = path.join(
    candidate.folderPath,
    'received',
    candidate.basename,
  );
  const receivedPath = path.dirname(filePath);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const receivedBefore = await fs.lstat(receivedPath);
    if (!isPlainDirectory(receivedBefore)) return null;
    const receivedReal = await fs.realpath(receivedPath);
    const before = await fs.lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      return null;
    }
    handle = await fs.open(filePath, constants.O_RDONLY | NOFOLLOW);
    const after = await handle.stat();
    const receivedAfter = await fs.lstat(receivedPath);
    const pathAfter = await fs.lstat(filePath);
    const fileReal = await fs.realpath(filePath);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      !isPlainDirectory(receivedAfter) ||
      receivedAfter.dev !== receivedBefore.dev ||
      receivedAfter.ino !== receivedBefore.ino ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      pathAfter.nlink !== 1 ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      path.dirname(fileReal) !== receivedReal ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      await handle.close();
      return null;
    }
    return {
      ...candidate,
      sizeBytes: after.size,
      extension: path.extname(candidate.basename).toLowerCase(),
      handle,
    };
  } catch {
    if (handle) await handle.close().catch(() => {});
    return null;
  }
}

export type ParsedByteRange = { start: number; end: number };

export function parseDashboardMediaRange(
  value: string | undefined,
  size: number,
): ParsedByteRange | null {
  if (!value) return null;
  if (!Number.isSafeInteger(size) || size <= 0) throw new RangeError('range');
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2])) throw new RangeError('range');
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      throw new RangeError('range');
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= size ||
      end < start
    ) {
      throw new RangeError('range');
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export async function serveDashboardMedia(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: { jid: string; messageId: string; mediaId: string },
  groupsRoot = path.resolve(process.cwd(), 'groups'),
): Promise<'served' | 'not-found'> {
  const media = await openDashboardMedia(
    params.jid,
    params.messageId,
    params.mediaId,
    groupsRoot,
  );
  if (!media) return 'not-found';

  let range: ParsedByteRange | null;
  try {
    range = parseDashboardMediaRange(req.headers.range, media.sizeBytes);
  } catch {
    await media.handle.close();
    res.writeHead(416, {
      'content-range': `bytes */${media.sizeBytes}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end();
    return 'served';
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, media.sizeBytes - 1);
  const inline = media.kind !== 'document';
  const safeExtension = /^\.[a-z0-9]{1,8}$/u.test(media.extension)
    ? media.extension
    : '';
  const headers: Record<string, string | number> = {
    'content-type': media.mime,
    'content-length': media.sizeBytes === 0 ? 0 : end - start + 1,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="skoobi-${media.mediaId}${safeExtension}"`,
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  };
  if (range)
    headers['content-range'] = `bytes ${start}-${end}/${media.sizeBytes}`;
  res.writeHead(range ? 206 : 200, headers);

  if (req.method === 'HEAD' || media.sizeBytes === 0) {
    await media.handle.close();
    res.end();
    return 'served';
  }

  await new Promise<void>((resolve) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      void media.handle.close().finally(resolve);
    };
    const stream = media.handle.createReadStream({
      autoClose: false,
      start,
      end,
    });
    stream.on('error', () => {
      if (!res.destroyed) res.destroy();
      close();
    });
    stream.on('end', close);
    res.on('close', () => {
      stream.destroy();
      close();
    });
    stream.pipe(res);
  });
  return 'served';
}
