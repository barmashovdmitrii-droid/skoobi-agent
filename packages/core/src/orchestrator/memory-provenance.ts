import {
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  publicKeyPemFromPrivate,
  safeSharedMemoryKey,
  signedMemoryEntryLine,
  type SignedMemoryMetadata,
  type SignedMemoryPayload,
} from '@skoobi/memory';
import { parseTelegramJid } from '@skoobi/shared/telegram-jid';

import { DATA_DIR } from './config.js';
import type { SenderIdentity } from './types.js';

const MEMORY_PRIVATE_KEY_FILE = 'memory-provenance-ed25519-private.pem';
const MAX_MEMORY_CONTENT_CHARS = 64 * 1024;
const MAX_MEMORY_WRITES_PER_CAPABILITY = 100;
const MAX_MEMORY_REQUESTS_PER_CAPABILITY = 200;
const MEMORY_CAPABILITY_TTL_MS = 2 * 60 * 60 * 1000;
const MEMORY_SECRET_RE =
  /(api[_-]?key|token|password|secret|authorization|cookie|\.env|private key|ssh key)/i;

export interface MemoryWriteCapabilityContext {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  tenantId?: string;
  senderIdentity?: SenderIdentity;
  /** False for an initial batch containing more than one member identity. */
  memoryWriteAllowed?: boolean;
}

interface ActiveMemoryCapability extends MemoryWriteCapabilityContext {
  secret: Buffer;
  expiresAt: number;
  writes: number;
  requests: number;
  usedRequestIds: Set<string>;
}

export interface MemorySigningRequest {
  type: 'memory_sign';
  request_id: string;
  capability_id: string;
  proof: string;
  content: string;
  category: 'daily' | 'topic' | 'longterm';
  topic?: string;
  source_type?:
    | 'user_message'
    | 'assistant_message'
    | 'photo_caption'
    | 'document'
    | 'manual'
    | 'summary';
  confidence?: number;
  message_id?: string;
  event_id?: string;
}

export interface SignedMemoryTarget {
  target: 'group' | 'shared';
  label: string;
  entry_line: string;
}

export interface MemorySigningResponse {
  type: 'memory_sign_result';
  request_id: string;
  ok: boolean;
  entries?: SignedMemoryTarget[];
  error?: string;
}

const activeCapabilities = new Map<string, ActiveMemoryCapability>();

export type MemorySigningProofFields = Pick<
  MemorySigningRequest,
  | 'type'
  | 'request_id'
  | 'content'
  | 'category'
  | 'topic'
  | 'source_type'
  | 'confidence'
  | 'message_id'
  | 'event_id'
>;

function parseMemoryCapability(
  capability: string,
): { id: string; secret: Buffer } | null {
  const [id, encodedSecret, extra] = capability.split('.');
  if (
    extra !== undefined ||
    !id ||
    !encodedSecret ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(id) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(encodedSecret)
  ) {
    return null;
  }
  try {
    const secret = Buffer.from(encodedSecret, 'base64url');
    return secret.length === 32 ? { id, secret } : null;
  } catch {
    return null;
  }
}

/**
 * Stable proof payload shared with the isolated MCP process. Optional values
 * are represented as null so omitted fields cannot change canonicalization.
 */
function memorySigningProofPayload(raw: MemorySigningProofFields): string {
  return JSON.stringify([
    'skoobi.memory_sign.v1',
    raw.type,
    raw.request_id,
    raw.content,
    raw.category,
    raw.topic ?? null,
    raw.source_type ?? null,
    raw.confidence ?? null,
    raw.message_id ?? null,
    raw.event_id ?? null,
  ]);
}

/** Build a disk-safe proof: the returned object never contains the secret. */
export function authorizeMemorySigningRequest(
  capability: string,
  raw: MemorySigningProofFields,
): { capability_id: string; proof: string } {
  const parsed = parseMemoryCapability(capability);
  if (!parsed) throw new Error('Invalid memory write capability');
  return {
    capability_id: parsed.id,
    proof: createHmac('sha256', parsed.secret)
      .update(memorySigningProofPayload(raw))
      .digest('base64url'),
  };
}

function privateKeyPath(dataDir: string): string {
  return path.join(dataDir, '.security', MEMORY_PRIVATE_KEY_FILE);
}

function readPrivateKey(dataDir: string): string | null {
  try {
    const securityDir = path.join(dataDir, '.security');
    const securityStat = fs.lstatSync(securityDir);
    if (!securityStat.isDirectory() || securityStat.isSymbolicLink()) {
      return null;
    }
    const keyPath = privateKeyPath(dataDir);
    const stat = fs.lstatSync(keyPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size <= 0 ||
      stat.size > 16 * 1024
    ) {
      return null;
    }
    return fs.readFileSync(keyPath, 'utf8');
  } catch {
    return null;
  }
}

export function ensureMemoryProvenanceKeyPair(
  dataDir = DATA_DIR,
): { privateKeyPem: string; publicKeyPem: string } {
  const existing = readPrivateKey(dataDir);
  if (existing) {
    return {
      privateKeyPem: existing,
      publicKeyPem: publicKeyPemFromPrivate(existing),
    };
  }

  const securityDir = path.join(dataDir, '.security');
  fs.mkdirSync(securityDir, { recursive: true, mode: 0o700 });
  const securityStat = fs.lstatSync(securityDir);
  if (!securityStat.isDirectory() || securityStat.isSymbolicLink()) {
    throw new Error('Unsafe memory provenance security directory');
  }
  fs.chmodSync(securityDir, 0o700);

  const generated = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const keyPath = privateKeyPath(dataDir);
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      keyPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, generated.privateKey, 'utf8');
    fs.closeSync(fd);
    fd = null;
    return {
      privateKeyPem: generated.privateKey,
      publicKeyPem: generated.publicKey,
    };
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
    const raced = readPrivateKey(dataDir);
    if (!raced) throw err;
    return {
      privateKeyPem: raced,
      publicKeyPem: publicKeyPemFromPrivate(raced),
    };
  }
}

export function registerMemoryWriteCapability(
  context: MemoryWriteCapabilityContext,
  dataDir = DATA_DIR,
): { capability: string; publicKeyPem: string } {
  const capabilityId = randomBytes(32).toString('base64url');
  const secret = randomBytes(32);
  const capability = `${capabilityId}.${secret.toString('base64url')}`;
  const { publicKeyPem } = ensureMemoryProvenanceKeyPair(dataDir);
  activeCapabilities.set(capabilityId, {
    ...context,
    secret,
    expiresAt: Date.now() + MEMORY_CAPABILITY_TTL_MS,
    writes: 0,
    requests: 0,
    usedRequestIds: new Set(),
  });
  return { capability, publicKeyPem };
}

export function revokeMemoryWriteCapability(capability: string): void {
  const parsed = parseMemoryCapability(capability);
  if (parsed) activeCapabilities.delete(parsed.id);
}

function telegramChatIdFromJid(jid: string): string | null {
  return parseTelegramJid(jid)?.chatId || null;
}

function isMultiSenderChatJid(jid: string): boolean {
  if (jid.endsWith('@g.us') || jid.startsWith('dc:')) return true;
  if (!jid.startsWith('tg:')) return false;
  const parsed = parseTelegramJid(jid);
  return parsed === null || parsed.chatId.startsWith('-');
}

function isAdminOrHandoffMemory(
  category: MemorySigningRequest['category'],
  topic: string | undefined,
): boolean {
  const haystack = `${category}\n${topic || ''}`;
  return /(admin|to-admin|to_admin|for-admin|for_admin|owner|админ|администратору)/i.test(
    haystack,
  );
}

function sharedMemoryLabel(
  context: ActiveMemoryCapability,
  category: MemorySigningRequest['category'],
  safeTopic: string | null,
  rawTopic: string | undefined,
  date: string,
): { label: string; scope: string } | null {
  // Handoff/admin notes belong only to the originating chat. The legacy local
  // writer intentionally excluded them from cross-persona shared-user memory;
  // keep the host-signed path behaviorally identical.
  if (isAdminOrHandoffMemory(category, rawTopic)) return null;
  if (context.isMain || !context.senderIdentity?.identity_id) return null;
  const senderId = context.senderIdentity.telegram_user_id.trim();
  if (!senderId || senderId.startsWith('-')) return null;
  if (telegramChatIdFromJid(context.chatJid) !== senderId) return null;

  let rel: string;
  if (category === 'daily') rel = `shared/daily/${date}.md`;
  else if (category === 'topic' && safeTopic)
    rel = `shared/topics/${safeTopic}.md`;
  else rel = 'shared/longterm.md';
  const identityKey = safeSharedMemoryKey(context.senderIdentity.identity_id);
  if (identityKey === 'unknown') return null;
  return {
    label: `shared_user_memory/${rel}`,
    scope: `shared:${identityKey}:${rel}`,
  };
}

function groupMemoryLabel(
  context: ActiveMemoryCapability,
  category: MemorySigningRequest['category'],
  safeTopic: string | null,
  date: string,
): { label: string; scope: string } {
  let label: string;
  if (category === 'daily') label = `memory/${date}.md`;
  else if (category === 'topic' && safeTopic)
    label = `memory/topics/${safeTopic}.md`;
  else if (
    !context.isMain &&
    isMultiSenderChatJid(context.chatJid)
  ) {
    // A multi-member workspace has one shared CLAUDE.md, which both Claude
    // and Codex treat as executable standing instructions. Long-term personal
    // memory must therefore stay in the signed per-entry memory tree; writing
    // it to CLAUDE.md would deliberately bypass sender filtering.
    const senderKey = safeSharedMemoryKey(
      context.senderIdentity?.telegram_user_id || 'unknown',
    );
    label = `memory/topics/member-${senderKey}-longterm.md`;
  } else label = 'CLAUDE.md';
  return {
    label,
    scope: `group:${context.groupFolder}:${label}`,
  };
}

function validOptionalId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 256 ? trimmed : undefined;
}

function denyResponse(
  requestId: string,
  error: string,
): MemorySigningResponse {
  return {
    type: 'memory_sign_result',
    request_id: requestId,
    ok: false,
    error,
  };
}

/**
 * Host authority boundary for guest memory writes. The run secret stays in the
 * MCP process environment and is never serialized into the shared per-group
 * IPC directory. Each request carries only a public capability id and an HMAC
 * over its exact fields. Request sender_id/tenant_id fields are not accepted at
 * all. Only the host-held Ed25519 private key can create trusted entries.
 */
export function signMemoryWriteRequest(
  raw: unknown,
  sourceGroup: string,
  dataDir = DATA_DIR,
): MemorySigningResponse {
  const record =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const requestId =
    typeof record.request_id === 'string' &&
    /^[A-Za-z0-9_-]{8,128}$/.test(record.request_id)
      ? record.request_id
      : 'invalid';
  if (record.type !== 'memory_sign') {
    return denyResponse(requestId, 'invalid_request_type');
  }
  if (requestId === 'invalid') {
    return denyResponse(requestId, 'invalid_request_id');
  }
  if (typeof record.capability_id !== 'string') {
    return denyResponse(requestId, 'missing_capability_id');
  }
  const context = activeCapabilities.get(record.capability_id);
  if (!context || context.expiresAt < Date.now()) {
    activeCapabilities.delete(record.capability_id);
    return denyResponse(requestId, 'invalid_or_expired_capability');
  }
  if (context.groupFolder !== sourceGroup) {
    return denyResponse(requestId, 'capability_group_mismatch');
  }
  if (typeof record.proof !== 'string') {
    return denyResponse(requestId, 'missing_proof');
  }
  let suppliedProof: Buffer;
  try {
    suppliedProof = Buffer.from(record.proof, 'base64url');
  } catch {
    return denyResponse(requestId, 'invalid_proof');
  }
  const expectedProof = createHmac('sha256', context.secret)
    .update(
      memorySigningProofPayload(record as unknown as MemorySigningProofFields),
    )
    .digest();
  if (
    suppliedProof.length !== expectedProof.length ||
    !timingSafeEqual(suppliedProof, expectedProof)
  ) {
    return denyResponse(requestId, 'invalid_proof');
  }
  if (context.usedRequestIds.has(requestId)) {
    return denyResponse(requestId, 'replayed_request_id');
  }
  if (context.requests >= MAX_MEMORY_REQUESTS_PER_CAPABILITY) {
    return denyResponse(requestId, 'memory_request_limit_reached');
  }
  // A valid proof spends its request id before semantic validation. Retrying a
  // malformed signed envelope therefore cannot become a probing/replay oracle.
  context.usedRequestIds.add(requestId);
  context.requests += 1;
  if (
    !context.isMain &&
    isMultiSenderChatJid(context.chatJid) &&
    (!context.senderIdentity?.telegram_user_id ||
      !context.senderIdentity.identity_id)
  ) {
    // Scheduled/background group runs often have no originating member. A
    // sender-less signed entry would pass the old optional-field filter for
    // every participant, recreating file-level shared ownership. Such a task
    // may still run, but cannot persist personal memory until its creator
    // identity is carried authoritatively by the scheduler.
    return denyResponse(requestId, 'authoritative_sender_required');
  }
  if (
    !context.isMain &&
    isMultiSenderChatJid(context.chatJid) &&
    !context.tenantId
  ) {
    return denyResponse(requestId, 'authoritative_tenant_required');
  }
  if (
    !context.isMain &&
    isMultiSenderChatJid(context.chatJid) &&
    context.memoryWriteAllowed !== true
  ) {
    return denyResponse(requestId, 'mixed_sender_batch_denied');
  }
  if (
    context.memoryWriteAllowed !== true ||
    (context.chatJid.startsWith('tg:') &&
      context.senderIdentity?.telegram_message_origin !== 'direct')
  ) {
    return denyResponse(requestId, 'authoritative_direct_sender_required');
  }
  if (context.writes >= MAX_MEMORY_WRITES_PER_CAPABILITY) {
    return denyResponse(requestId, 'memory_write_limit_reached');
  }
  if (
    typeof record.content !== 'string' ||
    record.content.trim().length === 0 ||
    record.content.length > MAX_MEMORY_CONTENT_CHARS
  ) {
    return denyResponse(requestId, 'invalid_memory_content');
  }
  if (MEMORY_SECRET_RE.test(record.content)) {
    return denyResponse(requestId, 'memory_content_looks_secret');
  }
  if (!['daily', 'topic', 'longterm'].includes(String(record.category))) {
    return denyResponse(requestId, 'invalid_memory_category');
  }
  const category = record.category as MemorySigningRequest['category'];
  const safeTopic =
    category === 'topic' && typeof record.topic === 'string'
      ? record.topic.toLowerCase().replace(/[^a-z0-9-]/g, '-') || null
      : null;
  if (category === 'topic' && !safeTopic) {
    return denyResponse(requestId, 'topic_required');
  }

  const allowedSourceTypes = new Set([
    'user_message',
    'assistant_message',
    'photo_caption',
    'document',
    'manual',
    'summary',
  ]);
  const requestedSource =
    typeof record.source_type === 'string' &&
    allowedSourceTypes.has(record.source_type)
      ? record.source_type
      : 'manual';
  const sourceType =
    requestedSource === 'assistant_message' ? 'summary' : requestedSource;
  const requestedConfidence = Number(record.confidence);
  let confidence = Number.isFinite(requestedConfidence)
    ? Math.max(0, Math.min(1, requestedConfidence))
    : 0.7;
  if (
    requestedSource === 'photo_caption' ||
    requestedSource === 'assistant_message'
  ) {
    confidence = Math.min(confidence, 0.5);
  }

  const now = new Date();
  const timestamp = now.toISOString();
  const date = timestamp.slice(0, 10);
  const time = timestamp.slice(11, 19);
  const stamp = category === 'daily' ? time : `${date} ${time}`;
  const metadata: SignedMemoryMetadata = {
    source_type: sourceType,
    confidence,
    created_at: timestamp,
    group_folder: context.groupFolder,
    chat_jid: context.chatJid,
    tenant_id: context.tenantId || null,
    sender_id: context.senderIdentity?.telegram_user_id || null,
    identity_id: context.senderIdentity?.identity_id || null,
    bot_id: context.senderIdentity?.bot_id || null,
    persona_id: context.senderIdentity?.persona_id || null,
    message_id: validOptionalId(record.message_id) || null,
    event_id: validOptionalId(record.event_id) || null,
    // Identity/scope is host-attested. message_id/event_id remain an agent
    // reference and are explicitly not upgraded into source proof.
    provenance: 'host_signed_identity',
    source_reference_trust:
      validOptionalId(record.message_id) || validOptionalId(record.event_id)
        ? 'agent_claimed'
        : 'missing',
  };

  const { privateKeyPem } = ensureMemoryProvenanceKeyPair(dataDir);
  const targets: SignedMemoryTarget[] = [];
  const groupTarget = groupMemoryLabel(context, category, safeTopic, date);
  const groupPayload: SignedMemoryPayload = {
    v: 1,
    entry_id: randomUUID(),
    scope: groupTarget.scope,
    stamp,
    content: record.content,
    metadata,
  };
  targets.push({
    target: 'group',
    label: groupTarget.label,
    entry_line: signedMemoryEntryLine(groupPayload, privateKeyPem),
  });

  const sharedTarget = sharedMemoryLabel(
    context,
    category,
    safeTopic,
    typeof record.topic === 'string' ? record.topic : undefined,
    date,
  );
  if (sharedTarget) {
    const sharedPayload: SignedMemoryPayload = {
      ...groupPayload,
      entry_id: randomUUID(),
      scope: sharedTarget.scope,
    };
    targets.push({
      target: 'shared',
      label: sharedTarget.label,
      entry_line: signedMemoryEntryLine(sharedPayload, privateKeyPem),
    });
  }

  context.writes += 1;
  return {
    type: 'memory_sign_result',
    request_id: requestId,
    ok: true,
    entries: targets,
  };
}

/** @internal tests only */
export function _clearMemoryWriteCapabilities(): void {
  activeCapabilities.clear();
}
