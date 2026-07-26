/**
 * WhatsApp media download → saves to group folder so the agent can Read it.
 * Covers image/video/audio/document payloads and uses Baileys-compatible
 * media decryption instead of Telegram's plain HTTP file API.
 */

import {
  createDecipheriv,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { createWriteStream, promises as fs, type Stats } from 'fs';
import path from 'path';
import { Readable, Transform, type TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'stream/web';

import {
  getMediaKeys,
  getUrlFromDirectPath,
  type MediaType,
  type WAMessage,
} from '@whiskeysockets/baileys';

import { logger } from '@skoobi/shared/logger';
import { resolveGroupFolderPath } from '@skoobi/shared/group-folder';

export type WhatsappMediaKind =
  | 'image'
  | 'video'
  | 'voice'
  | 'audio'
  | 'document';

export interface WhatsappMediaAdmission {
  tier: 'owner' | 'guest';
  /** Stable host tenant id/folder; never a per-message or thread id. */
  tenantId: string;
}

// Baileys' 'buffer' download materializes the ENTIRE file in the shared process
// heap. Its rc13 stream path is not safely cancellable either: getHttpStream()
// drops RequestInit.signal before calling fetch. Use a native abortable fetch and
// stream the Baileys-compatible decrypt path into a temporary file instead.
// Declared fileLength remains only a fast reject; the security boundary is the
// byte counter over the actual decrypted plaintext (ultra-review #5/#14).
const MAX_WA_MEDIA_BYTES = 25 * 1024 * 1024;
const WA_DOWNLOAD_TIMEOUT_MS = 60_000;
// A single Baileys socket can receive many media messages in one upsert burst.
// Each active download owns an HTTP response, decrypt pipeline and file
// descriptor, so the per-file byte cap alone is not an aggregate resource
// bound. Keep both the active set and the waiting set finite. Four concurrent
// downloads preserve normal owner throughput; a short bounded queue absorbs an
// ordinary burst without allowing a sender to allocate unbounded promises/FDs.
const MAX_CONCURRENT_WA_DOWNLOADS = 4;
const MAX_QUEUED_WA_DOWNLOADS = 16;
const MAX_CONCURRENT_GUEST_WA_DOWNLOADS = 3;
const MAX_QUEUED_GUEST_WA_DOWNLOADS = 12;
const MAX_CONCURRENT_WA_DOWNLOADS_PER_GUEST = 2;
const MAX_QUEUED_WA_DOWNLOADS_PER_GUEST = 4;
const WA_DOWNLOAD_QUEUE_TIMEOUT_MS = 60_000;
const MAX_GUEST_WA_MEDIA_STORED_BYTES = 512 * 1024 * 1024;
const MAX_RECEIVED_DIRECTORY_ENTRIES = 50_000;
const WA_MEDIA_MAC_BYTES = 10;
const AES_BLOCK_BYTES = 16;

type WhatsappDownloadRelease = () => void;

interface WhatsappDownloadWaiter {
  admission: WhatsappMediaAdmission;
  grant: (release: WhatsappDownloadRelease | null) => void;
  timer: NodeJS.Timeout;
}

let activeWhatsappDownloads = 0;
let activeGuestWhatsappDownloads = 0;
let queuedGuestWhatsappDownloads = 0;
const queuedWhatsappDownloads: WhatsappDownloadWaiter[] = [];
const activeGuestDownloadsByTenant = new Map<string, number>();
const queuedGuestDownloadsByTenant = new Map<string, number>();
const guestStorageReservations = new Map<string, number>();

function mapIncrement(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mapDecrement(map: Map<string, number>, key: string): void {
  const next = Math.max(0, (map.get(key) ?? 0) - 1);
  if (next === 0) map.delete(key);
  else map.set(key, next);
}

function canActivateWhatsappDownload(
  admission: WhatsappMediaAdmission,
): boolean {
  if (activeWhatsappDownloads >= MAX_CONCURRENT_WA_DOWNLOADS) return false;
  if (admission.tier === 'owner') return true;
  return (
    activeGuestWhatsappDownloads < MAX_CONCURRENT_GUEST_WA_DOWNLOADS &&
    (activeGuestDownloadsByTenant.get(admission.tenantId) ?? 0) <
      MAX_CONCURRENT_WA_DOWNLOADS_PER_GUEST
  );
}

function releaseQueuedCounter(admission: WhatsappMediaAdmission): void {
  if (admission.tier !== 'guest') return;
  queuedGuestWhatsappDownloads = Math.max(0, queuedGuestWhatsappDownloads - 1);
  mapDecrement(queuedGuestDownloadsByTenant, admission.tenantId);
}

function activateWhatsappDownload(
  admission: WhatsappMediaAdmission,
): WhatsappDownloadRelease {
  activeWhatsappDownloads += 1;
  if (admission.tier === 'guest') {
    activeGuestWhatsappDownloads += 1;
    mapIncrement(activeGuestDownloadsByTenant, admission.tenantId);
  }
  return createWhatsappDownloadRelease(admission);
}

function drainWhatsappDownloadQueue(): void {
  while (activeWhatsappDownloads < MAX_CONCURRENT_WA_DOWNLOADS) {
    let index = queuedWhatsappDownloads.findIndex(
      (waiter) => waiter.admission.tier === 'owner',
    );
    if (index === -1) {
      index = queuedWhatsappDownloads.findIndex((waiter) =>
        canActivateWhatsappDownload(waiter.admission),
      );
    }
    if (index === -1) return;
    const [next] = queuedWhatsappDownloads.splice(index, 1);
    clearTimeout(next.timer);
    releaseQueuedCounter(next.admission);
    next.grant(activateWhatsappDownload(next.admission));
  }
}

function createWhatsappDownloadRelease(
  admission: WhatsappMediaAdmission,
): WhatsappDownloadRelease {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWhatsappDownloads = Math.max(0, activeWhatsappDownloads - 1);
    if (admission.tier === 'guest') {
      activeGuestWhatsappDownloads = Math.max(
        0,
        activeGuestWhatsappDownloads - 1,
      );
      mapDecrement(activeGuestDownloadsByTenant, admission.tenantId);
    }
    drainWhatsappDownloadQueue();
  };
}

async function acquireWhatsappDownloadSlot(
  admission: WhatsappMediaAdmission,
): Promise<WhatsappDownloadRelease | null> {
  if (canActivateWhatsappDownload(admission)) {
    return activateWhatsappDownload(admission);
  }
  if (queuedWhatsappDownloads.length >= MAX_QUEUED_WA_DOWNLOADS) {
    return null;
  }
  if (
    admission.tier === 'guest' &&
    (queuedGuestWhatsappDownloads >= MAX_QUEUED_GUEST_WA_DOWNLOADS ||
      (queuedGuestDownloadsByTenant.get(admission.tenantId) ?? 0) >=
        MAX_QUEUED_WA_DOWNLOADS_PER_GUEST)
  ) {
    return null;
  }

  return new Promise((resolve) => {
    const waiter: WhatsappDownloadWaiter = {
      admission,
      grant: resolve,
      timer: setTimeout(() => {
        const index = queuedWhatsappDownloads.indexOf(waiter);
        if (index === -1) return;
        queuedWhatsappDownloads.splice(index, 1);
        releaseQueuedCounter(admission);
        resolve(null);
      }, WA_DOWNLOAD_QUEUE_TIMEOUT_MS),
    };
    waiter.timer.unref();
    queuedWhatsappDownloads.push(waiter);
    if (admission.tier === 'guest') {
      queuedGuestWhatsappDownloads += 1;
      mapIncrement(queuedGuestDownloadsByTenant, admission.tenantId);
    }
  });
}

class WhatsappMediaTooLargeError extends Error {
  constructor(readonly actualBytes: number) {
    super(
      `WhatsApp media exceeds ${MAX_WA_MEDIA_BYTES} bytes of decrypted content`,
    );
    this.name = 'WhatsappMediaTooLargeError';
  }
}

class WhatsappMediaTimeoutError extends Error {
  constructor() {
    super('WhatsApp media download timed out');
    this.name = 'WhatsappMediaTimeoutError';
  }
}

/**
 * WhatsApp media is AES-CBC ciphertext followed by a 10-byte HMAC. Keep the
 * final cipher block and MAC buffered, so plaintext can be streamed with
 * backpressure while the final file remains hidden until integrity succeeds.
 */
class WhatsappMediaDecryptStream extends Transform {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly decipher;
  private readonly hmac;

  constructor(cipherKey: Uint8Array, iv: Uint8Array, macKey: Uint8Array) {
    super();
    this.decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
    this.hmac = createHmac('sha256', macKey).update(iv);
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, encoding);
      this.pending = this.pending.length
        ? Buffer.concat([this.pending, bytes])
        : bytes;

      // Retain one complete cipher block plus the trailing MAC for _flush().
      const available =
        this.pending.length - WA_MEDIA_MAC_BYTES - AES_BLOCK_BYTES;
      const decryptBytes =
        available > 0
          ? Math.floor(available / AES_BLOCK_BYTES) * AES_BLOCK_BYTES
          : 0;
      if (decryptBytes > 0) {
        const ciphertext = this.pending.subarray(0, decryptBytes);
        this.pending = this.pending.subarray(decryptBytes);
        this.hmac.update(ciphertext);
        const plaintext = this.decipher.update(ciphertext);
        if (plaintext.length) this.push(plaintext);
      }
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (this.pending.length < AES_BLOCK_BYTES + WA_MEDIA_MAC_BYTES) {
        throw new Error('WhatsApp media payload is truncated');
      }
      const ciphertext = this.pending.subarray(
        0,
        this.pending.length - WA_MEDIA_MAC_BYTES,
      );
      const suppliedMac = this.pending.subarray(-WA_MEDIA_MAC_BYTES);
      if (
        ciphertext.length < AES_BLOCK_BYTES ||
        ciphertext.length % AES_BLOCK_BYTES !== 0
      ) {
        throw new Error('WhatsApp media ciphertext has an invalid length');
      }

      this.hmac.update(ciphertext);
      const expectedMac = this.hmac.digest().subarray(0, WA_MEDIA_MAC_BYTES);
      if (!timingSafeEqual(suppliedMac, expectedMac)) {
        throw new Error('WhatsApp media integrity check failed');
      }

      const plaintext = Buffer.concat([
        this.decipher.update(ciphertext),
        this.decipher.final(),
      ]);
      if (plaintext.length) this.push(plaintext);
      this.pending = Buffer.alloc(0);
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}

class WhatsappMediaSizeLimitStream extends Transform {
  bytes = 0;

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    const nextSize = this.bytes + bytes.length;
    if (nextSize > MAX_WA_MEDIA_BYTES) {
      callback(new WhatsappMediaTooLargeError(nextSize));
      return;
    }
    this.bytes = nextSize;
    callback(null, bytes);
  }
}

function declaredMediaByteLength(
  msg: WAMessage,
  kind: WhatsappMediaKind,
): number | null {
  const content = msg.message;
  if (!content) return null;
  let raw: unknown;
  switch (kind) {
    case 'image':
      raw = content.imageMessage?.fileLength;
      break;
    case 'video':
      raw = content.videoMessage?.fileLength;
      break;
    case 'voice':
    case 'audio':
      raw = content.audioMessage?.fileLength;
      break;
    case 'document':
      raw =
        content.documentMessage?.fileLength ??
        content.documentWithCaptionMessage?.message?.documentMessage
          ?.fileLength;
      break;
  }
  if (raw == null) return null;
  // Baileys stores fileLength as a protobuf Long | number.
  const n =
    typeof raw === 'number'
      ? raw
      : typeof (raw as { toNumber?: () => number }).toNumber === 'function'
        ? (raw as { toNumber: () => number }).toNumber()
        : Number(raw);
  return Number.isFinite(n) ? n : null;
}

interface WhatsappDownloadDescriptor {
  url?: string | null;
  directPath?: string | null;
  mediaKey?: Uint8Array | null;
}

function mediaDownloadDescriptor(
  msg: WAMessage,
  kind: WhatsappMediaKind,
): WhatsappDownloadDescriptor | null {
  const content = msg.message;
  if (!content) return null;
  switch (kind) {
    case 'image':
      return content.imageMessage ?? null;
    case 'video':
      return content.videoMessage ?? null;
    case 'voice':
    case 'audio':
      return content.audioMessage ?? null;
    case 'document':
      return (
        content.documentMessage ??
        content.documentWithCaptionMessage?.message?.documentMessage ??
        null
      );
  }
}

function mediaDownloadUrl(media: WhatsappDownloadDescriptor): string {
  if (media.directPath) {
    let host: string | undefined;
    if (media.url) {
      try {
        host = new URL(media.url).host;
      } catch {
        // Match Baileys: an invalid optional URL must not override the default
        // WhatsApp media host when directPath itself is usable.
      }
    }
    return getUrlFromDirectPath(media.directPath, host);
  }
  if (media.url) return media.url;
  throw new Error('WhatsApp media has no URL or directPath');
}

function baileysMediaType(kind: WhatsappMediaKind): MediaType {
  return kind === 'voice' ? 'audio' : kind;
}

export interface DownloadedMedia {
  path: string;
  filename: string;
  originalName: string | null;
  mimetype: string | null;
}

// Common mimetype → extension. Anything unknown falls back to a sensible default
// or — for documents — the last `/`-segment of the mimetype.
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/3gpp': '.3gp',
  'audio/ogg': '.oga',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/msword': '.doc',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'text/csv': '.csv',
};

function defaultExt(kind: WhatsappMediaKind): string {
  switch (kind) {
    case 'image':
      return '.jpg';
    case 'video':
      return '.mp4';
    case 'voice':
      return '.oga';
    case 'audio':
      return '.mp3';
    case 'document':
      return '.bin';
  }
}

function extensionFromMime(
  mimetype: string | null | undefined,
  kind: WhatsappMediaKind,
): string {
  if (!mimetype) return defaultExt(kind);
  const base = mimetype.split(';')[0].trim().toLowerCase();
  if (MIME_TO_EXT[base]) return MIME_TO_EXT[base];
  // Fallback: take the part after the last `/` (e.g. application/foo → .foo)
  const slash = base.lastIndexOf('/');
  if (slash !== -1 && slash < base.length - 1) {
    const ext = base.slice(slash + 1).replace(/[^a-z0-9]/g, '');
    if (ext) return `.${ext.slice(0, 8)}`;
  }
  return defaultExt(kind);
}

/**
 * Sanitize a user-supplied filename so it can't escape the destination directory.
 * Strips path separators, NUL, leading dots; limits length.
 */
function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[\x00\\/]/g, '_');
  const cleaned = base.replace(/^\.+/, '').slice(0, 120);
  return cleaned || 'file';
}

interface MediaMetadata {
  mimetype: string | null;
  fileName: string | null;
}

/**
 * Pull mimetype + (for documents) original filename from a normalized WA message.
 * Caller is expected to have already run normalizeMessageContent so that the
 * relevant *Message field is at the top level of `msg.message`.
 */
function readMediaMetadata(
  msg: WAMessage,
  kind: WhatsappMediaKind,
): MediaMetadata {
  const content = msg.message;
  if (!content) return { mimetype: null, fileName: null };

  switch (kind) {
    case 'image':
      return {
        mimetype: content.imageMessage?.mimetype ?? null,
        fileName: null,
      };
    case 'video':
      return {
        mimetype: content.videoMessage?.mimetype ?? null,
        fileName: null,
      };
    case 'voice':
    case 'audio':
      return {
        mimetype: content.audioMessage?.mimetype ?? null,
        fileName: null,
      };
    case 'document': {
      const doc =
        content.documentMessage ??
        content.documentWithCaptionMessage?.message?.documentMessage ??
        null;
      return {
        mimetype: doc?.mimetype ?? null,
        fileName: doc?.fileName ?? null,
      };
    }
  }
}

interface SafeReceivedDirectory {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
}

async function prepareSafeReceivedDirectory(
  groupDir: string,
): Promise<SafeReceivedDirectory> {
  const receivedDir = path.join(groupDir, 'received');
  try {
    await fs.mkdir(receivedDir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const [stat, groupReal, receivedReal] = await Promise.all([
    fs.lstat(receivedDir),
    fs.realpath(groupDir),
    fs.realpath(receivedDir),
  ]);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    path.dirname(receivedReal) !== groupReal ||
    path.basename(receivedReal) !== 'received'
  ) {
    throw new Error('Unsafe WhatsApp received directory');
  }
  return {
    path: receivedDir,
    realPath: receivedReal,
    dev: stat.dev,
    ino: stat.ino,
  };
}

async function receivedDirectoryStillMatches(
  expected: SafeReceivedDirectory,
): Promise<boolean> {
  try {
    const [stat, real] = await Promise.all([
      fs.lstat(expected.path),
      fs.realpath(expected.path),
    ]);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === expected.dev &&
      stat.ino === expected.ino &&
      real === expected.realPath
    );
  } catch {
    return false;
  }
}

async function guestStoredMediaBytes(
  received: SafeReceivedDirectory,
): Promise<number> {
  let entries = 0;
  let bytes = 0;
  const dir = await fs.opendir(received.path);
  try {
    for await (const entry of dir) {
      entries += 1;
      if (entries > MAX_RECEIVED_DIRECTORY_ENTRIES) {
        throw new Error('WhatsApp received directory entry limit exceeded');
      }
      if (!entry.isFile()) continue;
      let stat: Stats;
      try {
        stat = await fs.lstat(path.join(received.path, entry.name));
      } catch (err) {
        // Another admitted download may atomically publish/remove its .part
        // between readdir and lstat. That is normal concurrent owner behavior.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      bytes += Math.max(0, stat.size);
      if (bytes > MAX_GUEST_WA_MEDIA_STORED_BYTES) return bytes;
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  if (!(await receivedDirectoryStillMatches(received))) {
    throw new Error('WhatsApp received directory changed during quota scan');
  }
  return bytes;
}

async function reserveGuestMediaStorage(
  admission: WhatsappMediaAdmission,
  received: SafeReceivedDirectory,
): Promise<(() => void) | null> {
  if (admission.tier === 'owner') return () => {};
  const storedBytes = await guestStoredMediaBytes(received);
  const reservedBytes = guestStorageReservations.get(admission.tenantId) ?? 0;
  if (
    storedBytes + reservedBytes + MAX_WA_MEDIA_BYTES >
    MAX_GUEST_WA_MEDIA_STORED_BYTES
  ) {
    return null;
  }
  guestStorageReservations.set(
    admission.tenantId,
    reservedBytes + MAX_WA_MEDIA_BYTES,
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = Math.max(
      0,
      (guestStorageReservations.get(admission.tenantId) ?? 0) -
        MAX_WA_MEDIA_BYTES,
    );
    if (next === 0) guestStorageReservations.delete(admission.tenantId);
    else guestStorageReservations.set(admission.tenantId, next);
  };
}

/**
 * Download a WhatsApp media message via Baileys and save it to
 * <group>/received/. Returns absolute host path the agent can Read,
 * along with the filename used and the source mimetype for logging.
 *
 * `msg` MUST be a normalized WAMessage (i.e. msg.message has imageMessage /
 * audioMessage / documentMessage at the top level — caller runs
 * normalizeMessageContent first).
 *
 * On any failure (download error, write error, missing media) returns null.
 */
export async function downloadWhatsappMedia(
  msg: WAMessage,
  groupFolder: string,
  kind: WhatsappMediaKind,
  requestedAdmission?: WhatsappMediaAdmission,
): Promise<DownloadedMedia | null> {
  let releaseDownloadSlot: WhatsappDownloadRelease | undefined;
  let releaseStorageReservation: (() => void) | undefined;
  let tempPath: string | null = null;
  let receivedDirectory: SafeReceivedDirectory | undefined;
  let timer: NodeJS.Timeout | undefined;
  let source: Readable | undefined;
  let decryptStream: WhatsappMediaDecryptStream | undefined;
  let sizeLimitStream: WhatsappMediaSizeLimitStream | undefined;
  let fileStream: ReturnType<typeof createWriteStream> | undefined;
  const abortController = new AbortController();
  const admission: WhatsappMediaAdmission = {
    tier: requestedAdmission?.tier === 'owner' ? 'owner' : 'guest',
    tenantId: (requestedAdmission?.tenantId || groupFolder).slice(0, 256),
  };

  const cancel = (reason: Error): void => {
    if (!abortController.signal.aborted) abortController.abort(reason);
    source?.destroy(reason);
    decryptStream?.destroy(reason);
    sizeLimitStream?.destroy(reason);
    fileStream?.destroy(reason);
  };

  try {
    const declared = declaredMediaByteLength(msg, kind);
    if (declared != null && declared > MAX_WA_MEDIA_BYTES) {
      logger.warn(
        { msgId: msg.key?.id, kind, declared, cap: MAX_WA_MEDIA_BYTES },
        'WhatsApp media exceeds size cap (declared fileLength); skipping download',
      );
      return null;
    }

    releaseDownloadSlot =
      (await acquireWhatsappDownloadSlot(admission)) ?? undefined;
    if (!releaseDownloadSlot) {
      logger.warn(
        {
          msgId: msg.key?.id,
          kind,
          active: activeWhatsappDownloads,
          queued: queuedWhatsappDownloads.length,
        },
        'WhatsApp media download capacity exhausted; skipping download',
      );
      return null;
    }

    const meta = readMediaMetadata(msg, kind);
    const media = mediaDownloadDescriptor(msg, kind);
    if (!media?.mediaKey) {
      throw new Error('WhatsApp media message has no media key');
    }
    const downloadUrl = mediaDownloadUrl(media);

    const groupDir = resolveGroupFolderPath(groupFolder);
    receivedDirectory = await prepareSafeReceivedDirectory(groupDir);
    const receivedDir = receivedDirectory.path;
    releaseStorageReservation =
      (await reserveGuestMediaStorage(admission, receivedDirectory)) ??
      undefined;
    if (!releaseStorageReservation) {
      logger.warn(
        { msgId: msg.key?.id, kind, tenantId: admission.tenantId },
        'WhatsApp guest media storage quota exhausted; skipping download',
      );
      return null;
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const idShort = (msg.key?.id || 'noid')
      .slice(-8)
      .replace(/[^A-Za-z0-9_-]/g, '_');

    let filename: string;
    if (kind === 'document' && meta.fileName) {
      // Preserve the supplier's original filename (after sanitizing) so the
      // agent — and any human reviewer — can recognise "прайс.xlsx" etc.
      filename = `${ts}-${idShort}-${sanitizeFilename(meta.fileName)}`;
    } else {
      const ext = extensionFromMime(meta.mimetype, kind);
      filename = `${ts}-${kind}-${idShort}${ext}`;
    }

    const dest = path.join(receivedDir, filename);
    tempPath = path.join(receivedDir, `.${filename}.${randomUUID()}.part`);

    let rejectTimeout!: (reason: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    timer = setTimeout(() => {
      const err = new WhatsappMediaTimeoutError();
      cancel(err);
      rejectTimeout(err);
    }, WA_DOWNLOAD_TIMEOUT_MS);

    const keys = await Promise.race([
      getMediaKeys(media.mediaKey, baileysMediaType(kind)),
      timeoutPromise,
    ]);
    if (!keys.macKey) {
      throw new Error('WhatsApp media key derivation returned no MAC key');
    }
    const response = await Promise.race([
      fetch(downloadUrl, {
        method: 'GET',
        headers: { Origin: 'https://web.whatsapp.com' },
        signal: abortController.signal,
      }),
      timeoutPromise,
    ]);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `WhatsApp media download failed with HTTP ${response.status}`,
      );
    }
    if (!response.body) {
      throw new Error('WhatsApp media response has no body');
    }

    source = Readable.fromWeb(
      response.body as unknown as NodeWebReadableStream<Uint8Array>,
    );
    decryptStream = new WhatsappMediaDecryptStream(
      keys.cipherKey,
      keys.iv,
      keys.macKey,
    );
    sizeLimitStream = new WhatsappMediaSizeLimitStream();
    fileStream = createWriteStream(tempPath, {
      // O_CREAT|O_EXCL (`wx`) also refuses an existing final-component
      // symlink; the parent directory identity is checked separately.
      flags: 'wx',
      mode: 0o600,
    });

    // Abort the HTTP request immediately when the actual plaintext crosses the
    // cap; pipeline() then destroys decrypt/file streams and propagates failure.
    sizeLimitStream.once('error', (err) => cancel(err));
    await Promise.race([
      pipeline(source, decryptStream, sizeLimitStream, fileStream),
      timeoutPromise,
    ]);
    clearTimeout(timer);
    timer = undefined;

    if (sizeLimitStream.bytes === 0) {
      if (await receivedDirectoryStillMatches(receivedDirectory)) {
        await fs.unlink(tempPath).catch(() => undefined);
      }
      tempPath = null;
      logger.warn(
        { msgId: msg.key?.id, kind },
        'WhatsApp media downloaded but plaintext is empty',
      );
      return null;
    }

    // Atomic no-clobber publish. Re-check the parent directory identity before
    // resolving either pathname; a stable symlink is rejected at setup and a
    // swapped directory is never used for cleanup/publication.
    if (!(await receivedDirectoryStillMatches(receivedDirectory))) {
      throw new Error('WhatsApp received directory changed before publish');
    }
    await fs.link(tempPath, dest);
    if (await receivedDirectoryStillMatches(receivedDirectory)) {
      await fs.unlink(tempPath);
    }
    tempPath = null;

    logger.info(
      { msgId: msg.key?.id, kind, dest, bytes: sizeLimitStream.bytes },
      'Saved WhatsApp media',
    );

    return {
      path: dest,
      filename,
      originalName: meta.fileName,
      mimetype: meta.mimetype,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    cancel(error);
    if (
      tempPath &&
      receivedDirectory &&
      (await receivedDirectoryStillMatches(receivedDirectory))
    ) {
      await fs.unlink(tempPath).catch(() => undefined);
    }
    logger.error(
      {
        err,
        msgId: msg.key?.id,
        kind,
        ...(err instanceof WhatsappMediaTooLargeError
          ? { size: err.actualBytes, cap: MAX_WA_MEDIA_BYTES }
          : {}),
      },
      'WhatsApp media download failed',
    );
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    releaseStorageReservation?.();
    releaseDownloadSlot?.();
  }
}
