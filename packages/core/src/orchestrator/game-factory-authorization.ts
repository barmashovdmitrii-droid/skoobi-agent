import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from 'crypto';

import {
  FACTORY_READ_ACTIONS,
  FactoryError,
  type FactoryActor,
  type FactoryRequest,
} from './game-factory-contracts.js';
import type { SenderIdentity } from './types.js';
import type { FactoryHostRunLifecycle } from './game-factory-run-state.js';

const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_REQUESTS = 500;
const MAX_PLAINTEXT_BYTES = 128 * 1024;
const finishedRuns = new Map<string, true>();
const active = new Map<
  string,
  {
    secret: Buffer;
    actor: FactoryActor;
    expiresAt: number;
    allowControl: boolean;
    seen: Set<string>;
    onHostFinished?: () => void;
  }
>();

export interface GameFactoryActorPolicy {
  enabledActorIdentityIds: string[];
  primaryOwnerIdentityId?: string;
}

/** Only host-verified direct sender provenance can mint factory authority.
 * This deliberately does not use the primary owner's Google/mail capability. */
export function registerGameFactoryCapability(input: {
  groupFolder: string;
  chatJid: string;
  tenantId?: string;
  isMain: boolean;
  credentialProxyTier?: 'owner' | 'guest';
  senderIdentity?: SenderIdentity;
  homogeneousOwnerBatch: boolean;
  currentMessageIds?: string[];
  allowControl: boolean;
  /** Trace correlation only; every capability has a distinct invocation UUID. */
  diagnosticAttemptId?: string;
  hostRunLifecycle?: FactoryHostRunLifecycle;
  policy: GameFactoryActorPolicy;
}): string | null {
  const sender = input.senderIdentity;
  if (
    !input.isMain ||
    input.credentialProxyTier !== 'owner' ||
    !input.homogeneousOwnerBatch ||
    sender?.is_owner_sender !== true ||
    sender.channel !== 'telegram' ||
    sender.telegram_message_origin !== 'direct' ||
    !sender.identity_id ||
    !sender.telegram_user_id ||
    !sender.chat_id ||
    !input.tenantId ||
    !input.chatJid ||
    !input.groupFolder ||
    !input.currentMessageIds?.length ||
    input.currentMessageIds.length > 200 ||
    !input.currentMessageIds.every(
      (id) => typeof id === 'string' && id.length > 0,
    ) ||
    !input.policy.enabledActorIdentityIds.includes(sender.identity_id)
  )
    return null;
  const id = randomBytes(24).toString('base64url');
  const secret = randomBytes(32);
  const actor: FactoryActor = {
    identityId: sender.identity_id,
    senderId: sender.telegram_user_id,
    channelChatId: sender.chat_id,
    tenantId: input.tenantId,
    chatJid: input.chatJid,
    sourceGroup: input.groupFolder,
    currentMessageIds: [...input.currentMessageIds],
    runId: randomUUID(),
    isPrimaryOwner: input.policy.primaryOwnerIdentityId === sender.identity_id,
  };
  let onHostFinished: (() => void) | undefined;
  try {
    onHostFinished = input.hostRunLifecycle?.(actor, input.diagnosticAttemptId);
  } catch {
    /* Недоступная запись не доказывает завершения после restart. */
  }
  active.set(id, {
    secret,
    actor,
    onHostFinished,
    allowControl: input.allowControl,
    expiresAt: Date.now() + TTL_MS,
    seen: new Set(),
  });
  return `${id}.${secret.toString('base64url')}`;
}

export function revokeGameFactoryCapability(capability: string): void {
  const id = capability.split('.')[0];
  const cap = active.get(id);
  if (cap) {
    cap.secret.fill(0);
    // This function is called by the host's run finally, not by the TTL path.
    try {
      cap.onHostFinished?.();
    } catch {
      /* Отзыв capability обязан завершиться даже при отказе диска. */
    }
    finishedRuns.delete(cap.actor.runId);
    finishedRuns.set(cap.actor.runId, true);
    if (finishedRuns.size > 1000)
      finishedRuns.delete(finishedRuns.keys().next().value!);
  }
  active.delete(id);
}

/** Expired authority is not evidence that its executor has stopped. */
export function getGameFactoryRunState(
  runId: string,
): 'active' | 'finished' | 'unknown' {
  if ([...active.values()].some((cap) => cap.actor.runId === runId))
    return 'active';
  return finishedRuns.has(runId) ? 'finished' : 'unknown';
}

export interface GameFactoryFollowUpSource {
  id: string;
  senderIdentity?: SenderIdentity;
}

/** Called only for host-recorded batches the runner has acknowledged consuming.
 * Piping alone must not let an old turn act before reading a new correction. */
export function extendGameFactoryCapabilitiesForChat(
  groupFolder: string,
  chatJid: string,
  sources: GameFactoryFollowUpSource[],
): void {
  if (!sources.length) return;
  for (const cap of active.values()) {
    if (
      cap.expiresAt <= Date.now() ||
      cap.actor.sourceGroup !== groupFolder ||
      cap.actor.chatJid !== chatJid
    )
      continue;
    if (
      !sources.every(
        ({ id, senderIdentity: sender }) =>
          id &&
          sender?.identity_id === cap.actor.identityId &&
          sender.telegram_user_id === cap.actor.senderId &&
          sender.chat_id === cap.actor.channelChatId &&
          sender.telegram_message_origin === 'direct' &&
          sender.is_owner_sender === true,
      )
    )
      continue;
    cap.actor.currentMessageIds = [
      ...new Set([
        ...cap.actor.currentMessageIds,
        ...sources.map(({ id }) => id),
      ]),
    ].slice(-200);
  }
}

function key(secret: Buffer, purpose: 'request' | 'response'): Buffer {
  return createHmac('sha256', secret)
    .update(`skoobi.game_factory.${purpose}.key.v1`)
    .digest();
}

function aad(
  purpose: 'request' | 'response',
  requestId: string,
  capabilityId: string,
  group: string,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      `skoobi.game_factory.${purpose}.v1`,
      requestId,
      capabilityId,
      group,
    ]),
  );
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface GameFactoryWireResponse {
  type: 'game_factory_result';
  request_id: string;
  capability_id?: string;
  ok?: boolean;
  error?: string;
  sealed_payload?: { v: 1; iv: string; tag: string; ciphertext: string };
}

/** The filesystem group is host supplied. Actor identity is never read from
 * model arguments, persisted IPC, or a group's isMain flag. AES-GCM binds each
 * private request/response to the run, group, direction and unique request ID. */
export async function handleGameFactoryWireRequest(
  raw: unknown,
  sourceGroup: string,
  handler: (actor: FactoryActor, request: FactoryRequest) => Promise<unknown>,
): Promise<GameFactoryWireResponse> {
  const wire = record(raw);
  const requestId =
    typeof wire.request_id === 'string' &&
    /^[A-Za-z0-9_-]{8,128}$/.test(wire.request_id)
      ? wire.request_id
      : 'invalid';
  const deny = (error: string): GameFactoryWireResponse => ({
    type: 'game_factory_result',
    request_id: requestId,
    ok: false,
    error,
  });
  if (
    wire.type !== 'game_factory' ||
    requestId === 'invalid' ||
    typeof wire.capability_id !== 'string'
  )
    return deny('invalid_request');
  const cap = active.get(wire.capability_id);
  if (!cap || cap.expiresAt <= Date.now()) {
    // Keep the active executor marker until host finally. A lease TTL or
    // request-capability expiry cannot prove terminal state or grant takeover.
    return deny('invalid_or_expired_capability');
  }
  if (sourceGroup !== cap.actor.sourceGroup)
    return deny('source_group_mismatch');
  if (cap.seen.has(requestId)) return deny('replayed_request');
  if (cap.seen.size >= MAX_REQUESTS) return deny('request_limit');
  const sealed = record(wire.sealed_payload);
  if (
    sealed.v !== 1 ||
    typeof sealed.iv !== 'string' ||
    !/^[A-Za-z0-9_-]{16}$/.test(sealed.iv) ||
    typeof sealed.tag !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(sealed.tag) ||
    typeof sealed.ciphertext !== 'string' ||
    sealed.ciphertext.length > 180_000 ||
    !/^[A-Za-z0-9_-]+$/.test(sealed.ciphertext)
  )
    return deny('invalid_sealed_request');
  const requestKey = key(cap.secret, 'request');
  let plaintext: Buffer | undefined;
  let body: Record<string, unknown>;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      requestKey,
      Buffer.from(sealed.iv, 'base64url'),
    );
    decipher.setAAD(aad('request', requestId, wire.capability_id, sourceGroup));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    if (plaintext.length > MAX_PLAINTEXT_BYTES)
      return deny('request_too_large');
    body = record(JSON.parse(plaintext.toString('utf8')));
  } catch {
    return deny('invalid_sealed_request');
  } finally {
    requestKey.fill(0);
    plaintext?.fill(0);
  }
  // Burn before await so concurrent requests cannot replay a mutation.
  cap.seen.add(requestId);
  let result: Record<string, unknown>;
  const payload = record(body.payload);
  if (
    (body.mode !== 'status' && body.mode !== 'control') ||
    (body.mode === 'status' &&
      !(FACTORY_READ_ACTIONS as readonly string[]).includes(
        String(payload.action),
      )) ||
    (body.mode === 'control' && !cap.allowControl)
  ) {
    result = { ok: false, error: 'operation_not_authorized' };
  } else {
    try {
      // Give the service a copy: actor authority remains immutable in the map.
      result = {
        ok: true,
        data: await handler(
          { ...cap.actor, currentMessageIds: [...cap.actor.currentMessageIds] },
          payload as unknown as FactoryRequest,
        ),
      };
    } catch (error) {
      // Only typed public service codes cross this boundary, never driver text.
      result =
        error instanceof FactoryError && /^[a-z0-9_]{1,100}$/.test(error.code)
          ? {
              ok: false,
              error: error.code,
              ...(error.revision !== undefined
                ? { currentRevision: error.revision }
                : {}),
            }
          : { ok: false, error: 'factory_request_failed' };
    }
  }
  // Revocation while a backend is running must not expose its late result to a
  // new runner. Durable operation IDs allow the next authorized run to inspect.
  if (active.get(wire.capability_id) !== cap) return deny('capability_revoked');
  let responseText = JSON.stringify(result);
  if (Buffer.byteLength(responseText) > MAX_PLAINTEXT_BYTES)
    responseText = JSON.stringify({ ok: false, error: 'result_too_large' });
  const responseKey = key(cap.secret, 'response');
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', responseKey, iv);
    cipher.setAAD(aad('response', requestId, wire.capability_id, sourceGroup));
    const ciphertext = Buffer.concat([
      cipher.update(responseText),
      cipher.final(),
    ]);
    return {
      type: 'game_factory_result',
      request_id: requestId,
      capability_id: wire.capability_id,
      sealed_payload: {
        v: 1,
        iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
      },
    };
  } finally {
    responseKey.fill(0);
  }
}
