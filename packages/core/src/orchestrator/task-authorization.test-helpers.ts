import { createCipheriv, createHmac, randomBytes } from 'crypto';

import type {
  SealedTaskAuthorizationEnvelope,
  TaskAuthorizationAction,
} from './task-authorization.js';

const TASK_AUTHORIZATION_ENVELOPE_KEY_CONTEXT =
  'skoobi.task_authorization.envelope.key.v1';
const TASK_AUTHORIZATION_ENVELOPE_AAD_CONTEXT =
  'skoobi.task_authorization.envelope.aad.v1';

function envelopeKey(capabilityId: string, secret: string): Buffer {
  const decoded = Buffer.from(secret, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== secret) {
    throw new Error('invalid task authorization test capability');
  }
  return createHmac('sha256', decoded)
    .update(TASK_AUTHORIZATION_ENVELOPE_KEY_CONTEXT)
    .update('\0')
    .update(capabilityId)
    .digest();
}

function envelopeAad(
  capabilityId: string,
  requestId: string,
  action: TaskAuthorizationAction,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      TASK_AUTHORIZATION_ENVELOPE_AAD_CONTEXT,
      capabilityId,
      requestId,
      action,
    ]),
  );
}

export function sealTaskAuthorizationEnvelopeForTest(input: {
  capabilityId: string;
  secret: string;
  requestId: string;
  action: TaskAuthorizationAction;
  envelope: Record<string, unknown>;
  iv?: Buffer;
}): SealedTaskAuthorizationEnvelope {
  const iv = input.iv ?? randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    envelopeKey(input.capabilityId, input.secret),
    iv,
  );
  cipher.setAAD(envelopeAad(input.capabilityId, input.requestId, input.action));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(input.envelope))),
    cipher.final(),
  ]);
  return {
    v: 1,
    alg: 'A256GCM',
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

export function signedTaskAuthorizationRequestForTest(
  capability: string,
  envelope: Record<string, unknown>,
  requestId: string,
  action = envelope.type as TaskAuthorizationAction,
) {
  const [capabilityId, secret, ...extra] = capability.split('.');
  if (!capabilityId || !secret || extra.length > 0) {
    throw new Error('invalid task authorization test capability');
  }
  const sealedEnvelope = sealTaskAuthorizationEnvelopeForTest({
    capabilityId,
    secret,
    requestId,
    action,
    envelope,
  });
  const proofPayload = {
    type: 'task_authorize',
    request_id: requestId,
    action,
    sealed_envelope: sealedEnvelope,
  };
  return {
    ...proofPayload,
    capability_id: capabilityId,
    proof: createHmac('sha256', secret)
      .update(JSON.stringify(proofPayload))
      .digest('base64url'),
  };
}

export function resignTaskAuthorizationRequestForTest(
  capability: string,
  request: Record<string, unknown>,
): string {
  const [, secret] = capability.split('.');
  const proofPayload = {
    type: request.type,
    request_id: request.request_id,
    action: request.action,
    sealed_envelope: request.sealed_envelope,
  };
  return createHmac('sha256', secret)
    .update(JSON.stringify(proofPayload))
    .digest('base64url');
}
