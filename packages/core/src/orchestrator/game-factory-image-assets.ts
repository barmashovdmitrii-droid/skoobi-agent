import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { GROUPS_DIR } from './config.js';
import {
  getDb,
  type ImageJobRecord,
  type ImageJobArtifactRecord,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { importFactoryFileAsync } from './game-factory-artifacts.js';
import {
  FactoryError,
  type FactoryActor,
  type FactoryFile,
} from './game-factory-contracts.js';
import { peerCanonicalJson } from './peer-context.js';

const JOB_ID =
  /^img-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const JOB_STATES = new Set([
  'queued',
  'generating',
  'generated',
  'delivering',
  'delivered',
  'failed',
]);
const ARTIFACT_STATES = new Set([
  'generated',
  'delivering',
  'delivered',
  'failed',
]);
const digest = (value: unknown) =>
  createHash('sha256').update(peerCanonicalJson(value)).digest('hex');
function unavailable(): never {
  throw new FactoryError('image_job_unavailable');
}

/** Host dependencies, never fields accepted from an IPC/model request. */
export interface FactoryImageHost {
  db?: Database.Database;
  groupsRoot?: string;
}
export interface FactoryImageJobObservation {
  jobId: string;
  provider: string;
  promptSha256: string;
  status: ImageJobRecord['status'];
  generationCompletedAt: string | null;
  updatedAt: string;
  artifacts: Array<Pick<ImageJobArtifactRecord, 'id' | 'ordinal' | 'status'>>;
  origin: { trust: 'host_verified'; receiptSha256: string };
  cost: { status: 'unknown' };
  rights: { status: 'not_verified' };
}
export interface FactoryImportedImageReceipt {
  root: string;
  file: FactoryFile;
  jobId: string;
  artifactId: string;
  provider: string;
  promptSha256: string;
  originReceiptSha256: string;
  receiptSha256: string;
  cost: { status: 'unknown' };
  rights: { status: 'not_verified' };
}

/** A folder/chat is not an identity. Reconstruct only a narrowly proven origin:
 * exact host ingestion cursor, direct SenderIdentity, registered tenant and
 * the host's image-generation event for this exact job. Legacy ambiguity fails
 * closed; no personal text or rollout/history is loaded or returned. */
function readOwnedImage(
  actor: FactoryActor,
  jobId: string,
  host: FactoryImageHost,
) {
  if (
    !JOB_ID.test(jobId) ||
    !actor.channelChatId ||
    !isValidGroupFolder(actor.sourceGroup)
  )
    unavailable();
  const db = host.db ?? getDb();
  const job = db.prepare('SELECT * FROM image_jobs WHERE id=?').get(jobId) as
    | ImageJobRecord
    | undefined;
  if (
    !job ||
    job.chat_jid !== actor.chatJid ||
    job.group_folder !== actor.sourceGroup ||
    job.provider !== 'codex_builtin' ||
    !HASH.test(job.prompt_hash) ||
    !JOB_STATES.has(job.status)
  )
    unavailable();
  const prefix = actor.chatJid + ':',
    cursor = job.request_key.slice(prefix.length);
  if (!job.request_key.startsWith(prefix) || !/^i:\d{16}$/.test(cursor))
    unavailable();
  const sequence = Number(cursor.slice(2));
  if (!Number.isSafeInteger(sequence) || sequence < 1) unavailable();
  const source = db
    .prepare(
      `SELECT m.id,m.sender,m.is_bot_message,m.is_from_me,mm.sender_identity_json
    FROM message_ingestion mi JOIN messages m ON m.id=mi.id AND m.chat_jid=mi.chat_jid
    JOIN message_metadata mm ON mm.id=m.id AND mm.chat_jid=m.chat_jid
    WHERE mi.sequence=? AND m.chat_jid=?`,
    )
    .get(sequence, actor.chatJid) as
    | {
        id: string;
        sender: string;
        is_bot_message: number;
        is_from_me: number;
        sender_identity_json: string;
      }
    | undefined;
  if (
    !source ||
    source.is_bot_message ||
    source.is_from_me ||
    source.sender !== actor.senderId
  )
    unavailable();
  let identity: Record<string, unknown>;
  try {
    identity = JSON.parse(source.sender_identity_json);
  } catch {
    return unavailable();
  }
  if (
    !identity ||
    identity.channel !== 'telegram' ||
    identity.telegram_message_origin !== 'direct' ||
    identity.is_owner_sender !== true ||
    identity.identity_id !== actor.identityId ||
    identity.telegram_user_id !== actor.senderId ||
    identity.chat_id !== actor.channelChatId
  )
    unavailable();
  const group = db
    .prepare('SELECT folder,is_main FROM registered_groups WHERE jid=?')
    .get(actor.chatJid) as { folder: string; is_main: number } | undefined;
  const tenant = db
    .prepare(
      'SELECT folder,mode,channel,chat_id FROM tenants WHERE tenant_id=?',
    )
    .get(actor.tenantId) as
    | { folder: string; mode: string; channel: string; chat_id: string }
    | undefined;
  if (
    !group ||
    group.folder !== actor.sourceGroup ||
    group.is_main !== 1 ||
    !tenant ||
    tenant.folder !== actor.sourceGroup ||
    tenant.mode !== 'owner' ||
    tenant.channel !== 'telegram' ||
    tenant.chat_id !== actor.channelChatId
  )
    unavailable();
  const event = db
    .prepare(
      `SELECT event_id,payload_json FROM events
    WHERE type='image_generation_requested' AND actor='system' AND channel='telegram'
      AND tenant_id=? AND chat_id=? AND sender_id=? AND json_valid(payload_json)
      AND json_extract(payload_json,'$.image_job_id')=? ORDER BY created_at,event_id LIMIT 1`,
    )
    .get(actor.tenantId, actor.channelChatId, actor.senderId, jobId) as
    | { event_id: string; payload_json: string }
    | undefined;
  if (!event) unavailable();
  const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
  if (
    payload.provider !== job.provider ||
    payload.group_folder !== actor.sourceGroup ||
    payload.prompt_hash !== job.prompt_hash.slice(0, 16)
  )
    unavailable();
  const artifacts = db
    .prepare(
      'SELECT * FROM image_job_artifacts WHERE job_id=? ORDER BY ordinal LIMIT 101',
    )
    .all(jobId) as ImageJobArtifactRecord[];
  if (
    artifacts.length > 100 ||
    artifacts.some(
      (a) =>
        a.job_id !== jobId ||
        !ARTIFACT_STATES.has(a.status) ||
        !Number.isSafeInteger(a.ordinal) ||
        a.ordinal < 0,
    )
  )
    unavailable();
  const originReceiptSha256 = digest({
    schema: 1,
    jobId,
    requestKey: job.request_key,
    promptSha256: job.prompt_hash,
    identityId: actor.identityId,
    tenantId: actor.tenantId,
    chatJid: actor.chatJid,
    groupFolder: actor.sourceGroup,
    senderId: actor.senderId,
    channelChatId: actor.channelChatId,
    sourceMessageId: source.id,
    eventId: event.event_id,
  });
  return { job, artifacts, originReceiptSha256 };
}

/** Status only. In particular, a delivery failure is not proof that a model
 * process stopped; the factory must not infer execution ownership from it. */
export function observeFactoryImageJob(
  actor: FactoryActor,
  jobId: string,
  host: FactoryImageHost = {},
): FactoryImageJobObservation {
  const { job, artifacts, originReceiptSha256 } = readOwnedImage(
    actor,
    jobId,
    host,
  );
  return {
    jobId,
    provider: job.provider,
    promptSha256: job.prompt_hash,
    status: job.status,
    generationCompletedAt: job.generation_completed_at,
    updatedAt: job.updated_at,
    artifacts: artifacts.map(({ id, ordinal, status }) => ({
      id,
      ordinal,
      status,
    })),
    origin: { trust: 'host_verified', receiptSha256: originReceiptSha256 },
    cost: { status: 'unknown' },
    rights: { status: 'not_verified' },
  };
}

/** Explicit import by the original actor makes these exact image bytes project
 * assets. Sharing the project never grants access to that actor's other jobs. */
export async function importFactoryImageAsset(
  input: {
    actor: FactoryActor;
    jobId: string;
    artifactId: string;
    destinationRoot: string;
  },
  host: FactoryImageHost = {},
): Promise<FactoryImportedImageReceipt> {
  const before = readOwnedImage(input.actor, input.jobId, host);
  const artifact = before.artifacts.find((a) => a.id === input.artifactId);
  if (!artifact) unavailable();
  const groupRoot = path.resolve(
    host.groupsRoot ?? GROUPS_DIR,
    input.actor.sourceGroup,
  );
  const allowedRoot = path.join(groupRoot, 'output', 'imagegen');
  const sourceFile = path.resolve(artifact.staged_path);
  const name = path.basename(sourceFile);
  if (
    !path.isAbsolute(artifact.staged_path) ||
    path.dirname(sourceFile) !== allowedRoot ||
    !new RegExp(
      `^${input.jobId}(?:-[a-f0-9]{16})?\\.(?:png|jpg|jpeg|webp)$`,
    ).test(name)
  )
    unavailable();
  // The primitive opens one selected file via descriptor-relative nofollow
  // traversal, never lists/copies sibling images or invokes a provider.
  const copied = await importFactoryFileAsync({
    sourceFile,
    allowedRoot,
    destinationRoot: input.destinationRoot,
    maxBytes: 49 * 1024 * 1024,
  });
  // A revocation/record replacement during IO cannot turn into a valid receipt.
  const after = readOwnedImage(input.actor, input.jobId, host);
  const retained = after.artifacts.find((a) => a.id === artifact.id);
  if (
    after.originReceiptSha256 !== before.originReceiptSha256 ||
    !retained ||
    retained.staged_path !== artifact.staged_path ||
    retained.call_id !== artifact.call_id ||
    retained.job_id !== artifact.job_id
  )
    throw new FactoryError('image_origin_changed');
  const rawFile = copied.file as {
    path: string;
    sha256: string;
    size?: number;
    bytes?: number;
  };
  const size = rawFile.size ?? rawFile.bytes;
  if (
    rawFile.path !== name ||
    !HASH.test(rawFile.sha256) ||
    !Number.isSafeInteger(size) ||
    size! < 1 ||
    size! > 49 * 1024 * 1024
  )
    throw new FactoryError('image_copy_receipt_invalid');
  const receipt = {
    root: copied.sourceRoot,
    file: { path: rawFile.path, sha256: rawFile.sha256, size: size! },
    jobId: input.jobId,
    artifactId: input.artifactId,
    provider: before.job.provider,
    promptSha256: before.job.prompt_hash,
    originReceiptSha256: before.originReceiptSha256,
    cost: { status: 'unknown' as const },
    rights: { status: 'not_verified' as const },
  };
  return { ...receipt, receiptSha256: digest(receipt) };
}
