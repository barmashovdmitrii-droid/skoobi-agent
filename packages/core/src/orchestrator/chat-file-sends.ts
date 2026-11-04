
import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from './group-folder.js';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';

/**
 * Secret-bearing files: a guest's IPC send of one is refused (ipc.ts), and the
 * host never attaches one to an answer that linked it (local-file-links.ts).
 */
export function isSensitiveSendPath(realPath: string): boolean {
  const parts = realPath.split(path.sep);
  const base = path.basename(realPath);
  // Credential-bearing config dirs. Kept consistent with mount-security.ts's
  // DEFAULT_BLOCKED_PATTERNS (.aws/.azure/.gcloud/.kube/.docker/.gnupg, .config
  // for XDG creds like .config/gh/hosts.yml or .config/gcloud) so the IPC send
  // surface and the mount surface treat the same paths as sensitive.
  const inSensitiveDir =
    parts.includes('.ssh') ||
    parts.includes('store') ||
    parts.includes('secrets') ||
    parts.includes('.aws') ||
    parts.includes('.azure') ||
    parts.includes('.gcloud') ||
    parts.includes('.kube') ||
    parts.includes('.docker') ||
    parts.includes('.gnupg') ||
    parts.includes('.config');
  const isSensitiveName =
    // dotenv and all variants: .env, .env.local, .env.production, .env.bak ...
    /^\.env(\..+)?$/i.test(base) ||
    // SQLite databases + WAL/SHM/journal sidecars: messages.db, mem0-*.db, *.sqlite
    /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i.test(base) ||
    // SSH/host private key files
    /^id_(rsa|dsa|ecdsa|ed25519)$/i.test(base) ||
    // package/registry auth tokens, FTP/HTTP creds, and PyPI upload creds
    /^\.(npmrc|netrc|pypirc)$/i.test(base) ||
    // GCP/service-account & generic credential dumps; kubeconfig clusters/tokens
    /^credentials(\.json|\.ya?ml)?$/i.test(base) ||
    /(^|\.)kubeconfig$/i.test(base) ||
    // private key files named by convention
    /^private_key/i.test(base) ||
    // key material, certificate bundles, and keystores
    /\.(pem|key|p12|pfx|keystore|jks|crt|cer|der|asc|gpg)$/i.test(base);
  return inSensitiveDir || isSensitiveName;
}



export function ipcVoiceHistoryPlaceholder(text: string): string {
  return `[Voice: ${text.trim()}]`;
}

export function ipcPhotoHistoryPlaceholder(
  filePath: string,
  caption?: string,
): string {
  return ipcFileHistoryPlaceholder('Photo', filePath, caption);
}

export function ipcDocumentHistoryPlaceholder(
  filePath: string,
  caption?: string,
): string {
  return ipcFileHistoryPlaceholder('Document', filePath, caption);
}

function ipcFileHistoryPlaceholder(
  kind: 'Photo' | 'Document',
  filePath: string,
  caption?: string,
): string {
  const name = path.basename(filePath).trim();
  const head = name ? `[${kind}: ${name}]` : `[${kind}]`;
  const text = typeof caption === 'string' ? caption.trim() : '';
  return text ? `${head} ${text}` : head;
}

/** A send this old no longer makes «файл выше» true enough to skip a resend. */
export const RECENT_CHAT_FILE_SEND_MS = 30 * 60 * 1000;
const MAX_TRACKED_SENDS_PER_FOLDER = 200;
const MAX_QUEUED_ENVELOPES_SCANNED = 50;
const MAX_ENVELOPE_BYTES = 256 * 1024;

export type ChatFileSendState = 'sending' | 'sent';

const sendsByFolder = new Map<
  string,
  Map<string, { state: ChatFileSendState; atMs: number }>
>();

function realOrResolved(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function folderSends(
  groupFolder: string,
  nowMs: number,
): Map<string, { state: ChatFileSendState; atMs: number }> {
  let sends = sendsByFolder.get(groupFolder);
  if (!sends) {
    sends = new Map();
    sendsByFolder.set(groupFolder, sends);
  }
  for (const [filePath, entry] of sends) {
    if (nowMs - entry.atMs > RECENT_CHAT_FILE_SEND_MS) sends.delete(filePath);
  }
  while (sends.size >= MAX_TRACKED_SENDS_PER_FOLDER) {
    const oldest = sends.keys().next().value;
    if (oldest === undefined) break;
    sends.delete(oldest);
  }
  return sends;
}

/** The IPC watcher (or the host itself) is about to send this file. */
export function noteChatFileSendStarted(
  groupFolder: string,
  filePath: string,
  nowMs: number = Date.now(),
): void {
  const key = realOrResolved(filePath);
  const sends = folderSends(groupFolder, nowMs);
  sends.delete(key);
  sends.set(key, { state: 'sending', atMs: nowMs });
}

/** The send finished: confirmed, or forgotten when the channel refused it. */
export function noteChatFileSendFinished(
  groupFolder: string,
  filePath: string,
  delivered: boolean,
  nowMs: number = Date.now(),
): void {
  const key = realOrResolved(filePath);
  const sends = folderSends(groupFolder, nowMs);
  sends.delete(key);
  if (delivered) sends.set(key, { state: 'sent', atMs: nowMs });
}

/** How this file went to this group's chat in the last 30 minutes, if at all. */
export function recentChatFileSend(
  groupFolder: string,
  realPath: string,
  nowMs: number = Date.now(),
): ChatFileSendState | null {
  const entry = sendsByFolder.get(groupFolder)?.get(realPath);
  if (!entry || nowMs - entry.atMs > RECENT_CHAT_FILE_SEND_MS) return null;
  return entry.state;
}

/**
 * Real paths of photo/document envelopes still waiting in the group's IPC
 * messages directory: send_document returns as soon as the envelope is
 * written, so the final text can reach the host before the watcher's next
 * poll. Best-effort and read-only; any unreadable entry is skipped.
 */
export function queuedIpcFileSends(
  groupFolder: string,
  messagesDir?: string,
): Set<string> {
  const queued = new Set<string>();
  let dir: string;
  let files: string[];
  try {
    dir =
      messagesDir ?? path.join(resolveGroupIpcPath(groupFolder), 'messages');
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return queued;
    files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .slice(0, MAX_QUEUED_ENVELOPES_SCANNED);
  } catch {
    return queued;
  }
  for (const name of files) {
    try {
      const { buffer } = readBoundedRegularFileNoFollowSync(
        path.join(dir, name),
        { maxBytes: MAX_ENVELOPE_BYTES, oversize: 'reject' },
      );
      const data = JSON.parse(buffer.toString('utf-8')) as {
        type?: unknown;
        filePath?: unknown;
      };
      if (
        (data.type === 'document' || data.type === 'photo') &&
        typeof data.filePath === 'string' &&
        data.filePath
      ) {
        queued.add(realOrResolved(data.filePath));
      }
    } catch {
      // Being written, already consumed, or not an envelope: not queued.
    }
  }
  return queued;
}

/** @internal Test-only reset of the per-process send registry. */
export function _resetChatFileSendsForTests(): void {
  sendsByFolder.clear();
}
