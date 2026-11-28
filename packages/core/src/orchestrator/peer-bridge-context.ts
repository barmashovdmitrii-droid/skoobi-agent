import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  buildSemanticPeerTaskContext,
  revalidatePeerTaskContext,
  type PeerTaskContext,
  type PeerContextAuthority,
} from './peer-context.js';
import { loadPeerBridgeConfig, type PeerBridgeConfig } from './peer-inbox.js';
import { createConfiguredMemoryEncoderProvider } from './memory-prompt-recall.js';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';

function open(c: PeerBridgeConfig): Database.Database {
  const file = path.join(c.projectRoot, 'store/messages.db');
  const s = fs.lstatSync(file);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.nlink !== 1 ||
    s.mode & 0o077 ||
    fs.realpathSync(file) !== file
  )
    throw new Error('Unsafe canonical memory database');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const group = db
      .prepare('SELECT folder,is_main FROM registered_groups WHERE jid=?')
      .get(c.ownerJid) as { folder: string; is_main: number } | undefined;
    if (group?.folder !== c.ownerGroupFolder || group.is_main !== 1)
      throw new Error('Peer owner registration changed');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function authority(c: PeerBridgeConfig): PeerContextAuthority {
  return {
    chatJid: c.ownerJid,
    identityId: c.identityId,
    tenantId: c.tenantId,
    networkId: c.networkId,
  };
}
function semanticConfig(
  c: PeerBridgeConfig,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  try {
    const bytes = readBoundedRegularFileNoFollowSync(
      path.join(c.projectRoot, '.env'),
      { maxBytes: 1024 * 1024, oversize: 'reject', requireSingleLink: true },
    ).buffer;
    for (const line of bytes.toString('utf8').split('\n')) {
      const match = line.match(
        /^\s*(SKOOBI_MEMORY_SEMANTIC|SKOOBI_MEMORY_EMBEDDINGS_DIR)\s*=\s*(.*?)\s*$/,
      );
      if (match) result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    /* Explicit lexical fallback; no inherited process secrets. */
  }
  return result;
}
export async function buildPeerContextForCoordinator(
  configPath: string,
  input: {
    taskId: string;
    revision: number;
    projectKey: string | null;
    query: string;
    expiresAt: string;
    recordKeys?: string[];
    reason?: string;
  },
): Promise<PeerTaskContext> {
  const c = loadPeerBridgeConfig(configPath),
    db = open(c);
  const provider = createConfiguredMemoryEncoderProvider({
    readConfig: () => semanticConfig(c),
    codeRoot: c.projectRoot,
    stateRoot: c.projectRoot,
  });
  const encoder = provider();
  try {
    if (
      input.recordKeys &&
      (input.recordKeys.length > 10 ||
        !input.reason?.trim() ||
        input.reason.length > 1000 ||
        input.query.length > 1000)
    )
      throw new Error('Invalid supplementary peer context request');
    return await buildSemanticPeerTaskContext(
      db,
      authority(c),
      {
        id: input.taskId,
        revision: input.revision,
        projectKey: input.projectKey,
        query: input.query,
        expiresAt: input.expiresAt,
      },
      { encoder, recordKeys: input.recordKeys },
    );
  } finally {
    encoder?.close?.();
    db.close();
  }
}
export function revalidatePeerContextForCoordinator(
  configPath: string,
  context: PeerTaskContext,
): ReturnType<typeof revalidatePeerTaskContext> {
  const c = loadPeerBridgeConfig(configPath),
    db = open(c);
  try {
    return revalidatePeerTaskContext(
      db,
      authority(c),
      {
        id: context.taskId,
        revision: context.revision,
        projectKey: context.projectKey,
        query: '',
        expiresAt: context.expiresAt,
      },
      context,
    );
  } finally {
    db.close();
  }
}
