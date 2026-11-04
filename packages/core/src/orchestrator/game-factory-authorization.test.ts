import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactoryError } from './game-factory-contracts.js';
import {
  handleGameFactoryWireRequest,
  getGameFactoryRunState,
  registerGameFactoryCapability,
  revokeGameFactoryCapability,
  extendGameFactoryCapabilitiesForChat,
} from './game-factory-authorization.js';

const input = {
  groupFolder: 'shared-game-admins',
  chatJid: 'tg:factory-test',
  tenantId: 'tenant-test',
  isMain: true,
  credentialProxyTier: 'owner' as const,
  homogeneousOwnerBatch: true,
  currentMessageIds: ['message-test'],
  allowControl: true,
  senderIdentity: {
    channel: 'telegram' as const,
    chat_id: 'factory-test',
    telegram_user_id: 'second-admin-test',
    identity_id: 'second-admin-identity',
    is_owner_sender: true,
    telegram_message_origin: 'direct' as const,
  },
  policy: {
    enabledActorIdentityIds: ['second-admin-identity'],
    primaryOwnerIdentityId: 'primary-admin-identity',
  },
};
const caps: string[] = [];
function cap(
  overrides: Partial<Parameters<typeof registerGameFactoryCapability>[0]> = {},
): string {
  const value = registerGameFactoryCapability({ ...input, ...overrides });
  expect(value).toBeTruthy();
  caps.push(value!);
  return value!;
}
function wire(
  capability: string,
  mode = 'control',
  payload: unknown = { action: 'create', operationId: 'operation-test' },
  id = 'request-test-001',
) {
  const [capabilityId, secret] = capability.split('.');
  const key = createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update('skoobi.game_factory.request.key.v1')
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([
        'skoobi.game_factory.request.v1',
        id,
        capabilityId,
        input.groupFolder,
      ]),
    ),
  );
  return {
    type: 'game_factory',
    request_id: id,
    capability_id: capabilityId,
    sealed_payload: {
      v: 1,
      iv: iv.toString('base64url'),
      ciphertext: Buffer.concat([
        cipher.update(JSON.stringify({ mode, payload })),
        cipher.final(),
      ]).toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    },
  };
}
function open(
  capability: string,
  response: Awaited<ReturnType<typeof handleGameFactoryWireRequest>>,
) {
  const [capabilityId, secret] = capability.split('.');
  const body = response.sealed_payload!;
  const key = createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update('skoobi.game_factory.response.key.v1')
    .digest();
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(body.iv, 'base64url'),
  );
  decipher.setAAD(
    Buffer.from(
      JSON.stringify([
        'skoobi.game_factory.response.v1',
        response.request_id,
        capabilityId,
        input.groupFolder,
      ]),
    ),
  );
  decipher.setAuthTag(Buffer.from(body.tag, 'base64url'));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(body.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8'),
  );
}
afterEach(() => {
  caps.splice(0).forEach(revokeGameFactoryCapability);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('host game-factory authority', () => {
  it('authorizes a configured second admin independently of Google and binds host identity', async () => {
    vi.stubEnv('SKOOBI_GOOGLE_OWNER_TELEGRAM_USER_IDS', 'primary-only');
    const capability = cap();
    const handler = vi.fn(async (_actor: unknown, _payload: unknown) => ({
      privateProject: 'shared game only',
    }));
    const request = wire(capability, 'control', {
      action: 'create',
      actor: { identityId: 'forged' },
    });
    expect(JSON.stringify(request)).not.toContain('forged');
    expect(JSON.stringify(request)).not.toContain(capability.split('.')[1]);
    const response = await handleGameFactoryWireRequest(
      request,
      input.groupFolder,
      handler,
    );
    expect(handler.mock.calls[0][0]).toMatchObject({
      identityId: input.senderIdentity.identity_id,
      tenantId: input.tenantId,
      chatJid: input.chatJid,
      sourceGroup: input.groupFolder,
      senderId: input.senderIdentity.telegram_user_id,
      channelChatId: input.senderIdentity.chat_id,
      currentMessageIds: input.currentMessageIds,
      isPrimaryOwner: false,
    });
    expect(JSON.stringify(response)).not.toContain('shared game only');
    expect(open(capability, response)).toMatchObject({
      ok: true,
      data: { privateProject: 'shared game only' },
    });
  });
  it('primary-owner status comes only from host policy', async () => {
    const capability = cap({
      policy: {
        ...input.policy,
        primaryOwnerIdentityId: input.senderIdentity.identity_id,
      },
    });
    const handler = vi.fn(async (actor) => actor.isPrimaryOwner);
    expect(
      open(
        capability,
        await handleGameFactoryWireRequest(
          wire(capability),
          input.groupFolder,
          handler,
        ),
      ),
    ).toEqual({ ok: true, data: true });
  });
  it.each([
    { isMain: false },
    { credentialProxyTier: 'guest' },
    { homogeneousOwnerBatch: false },
    { currentMessageIds: [] },
    { tenantId: '' },
    { policy: { enabledActorIdentityIds: [] } },
    { senderIdentity: { ...input.senderIdentity, is_owner_sender: false } },
    {
      senderIdentity: {
        ...input.senderIdentity,
        telegram_message_origin: 'forwarded',
      },
    },
    {
      senderIdentity: {
        ...input.senderIdentity,
        telegram_message_origin: undefined,
      },
    },
  ])(
    'does not issue a capability for untrusted or unconfigured input %j',
    (overrides) => {
      expect(
        registerGameFactoryCapability({ ...input, ...overrides } as Parameters<
          typeof registerGameFactoryCapability
        >[0]),
      ).toBeNull();
    },
  );
  it('rejects group substitution, request tampering and replay without executing', async () => {
    const capability = cap();
    const request = wire(capability);
    const handler = vi.fn(async () => 'ok');
    expect(
      await handleGameFactoryWireRequest(request, 'other-group', handler),
    ).toMatchObject({ error: 'source_group_mismatch' });
    const tampered = { ...request, request_id: 'request-changed' };
    expect(
      await handleGameFactoryWireRequest(tampered, input.groupFolder, handler),
    ).toMatchObject({ error: 'invalid_sealed_request' });
    await handleGameFactoryWireRequest(request, input.groupFolder, handler);
    expect(
      await handleGameFactoryWireRequest(request, input.groupFolder, handler),
    ).toMatchObject({ error: 'replayed_request' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('revokes authority at run end and after a bounded lifetime', async () => {
    const handler = vi.fn(async () => 'ok');
    const revoked = cap();
    revokeGameFactoryCapability(revoked);
    expect(
      await handleGameFactoryWireRequest(
        wire(revoked),
        input.groupFolder,
        handler,
      ),
    ).toMatchObject({ error: 'invalid_or_expired_capability' });
    vi.useFakeTimers();
    const expired = cap();
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(
      await handleGameFactoryWireRequest(
        wire(expired),
        input.groupFolder,
        handler,
      ),
    ).toMatchObject({ error: 'invalid_or_expired_capability' });
    expect(handler).not.toHaveBeenCalled();
  });
  it('cannot turn status into a write or bypass host mutation quarantine', async () => {
    const capability = cap({ allowControl: false });
    const handler = vi.fn(async () => 'ok');
    for (const [mode, action, id] of [
      ['status', 'create', 'request-001'],
      ['control', 'create', 'request-002'],
      ['status', 'unknown', 'request-003'],
    ]) {
      expect(
        open(
          capability,
          await handleGameFactoryWireRequest(
            wire(capability, mode, { action }, id),
            input.groupFolder,
            handler,
          ),
        ),
      ).toMatchObject({ error: 'operation_not_authorized' });
    }
    expect(handler).not.toHaveBeenCalled();
    expect(
      open(
        capability,
        await handleGameFactoryWireRequest(
          wire(capability, 'status', { action: 'inspect' }, 'request-004'),
          input.groupFolder,
          handler,
        ),
      ),
    ).toMatchObject({ ok: true });
  });
  it('burns request IDs before awaiting and suppresses late results after revocation', async () => {
    const capability = cap();
    const request = wire(capability);
    let finish!: (value: unknown) => void;
    const handler = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = handleGameFactoryWireRequest(
      request,
      input.groupFolder,
      handler,
    );
    expect(
      await handleGameFactoryWireRequest(request, input.groupFolder, handler),
    ).toMatchObject({ error: 'replayed_request' });
    revokeGameFactoryCapability(capability);
    finish('private result');
    expect(await pending).toMatchObject({ error: 'capability_revoked' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('returns typed revision conflicts while hiding arbitrary backend exception text', async () => {
    const capability = cap();
    const conflict = await handleGameFactoryWireRequest(
      wire(capability),
      input.groupFolder,
      async () => {
        throw new FactoryError('revision_conflict', 7);
      },
    );
    expect(open(capability, conflict)).toEqual({
      ok: false,
      error: 'revision_conflict',
      currentRevision: 7,
    });
    const failure = await handleGameFactoryWireRequest(
      wire(capability, 'control', {}, 'request-failure'),
      input.groupFolder,
      async () => {
        throw new Error('secret=private-value');
      },
    );
    expect(open(capability, failure)).toEqual({
      ok: false,
      error: 'factory_request_failed',
    });
  });
  it('extends a live run only with acknowledged sources from the same trusted sender', async () => {
    const capability = cap();
    extendGameFactoryCapabilitiesForChat(input.groupFolder, input.chatJid, [
      { id: 'correction-message', senderIdentity: input.senderIdentity },
    ]);
    extendGameFactoryCapabilitiesForChat(input.groupFolder, input.chatJid, [
      {
        id: 'other-admin-message',
        senderIdentity: { ...input.senderIdentity, identity_id: 'other-admin' },
      },
    ]);
    extendGameFactoryCapabilitiesForChat(input.groupFolder, input.chatJid, [
      {
        id: 'forwarded-message',
        senderIdentity: {
          ...input.senderIdentity,
          telegram_message_origin: 'forwarded',
        },
      },
    ]);
    extendGameFactoryCapabilitiesForChat('other-group', input.chatJid, [
      { id: 'wrong-group-message', senderIdentity: input.senderIdentity },
    ]);
    const response = await handleGameFactoryWireRequest(
      wire(capability),
      input.groupFolder,
      async (actor) => actor.currentMessageIds,
    );
    expect(open(capability, response).data).toEqual([
      'message-test',
      'correction-message',
    ]);
  });
  it('sanitizes invalid response filenames and denies plaintext requests', async () => {
    const handler = vi.fn(async () => 'ok');
    expect(
      await handleGameFactoryWireRequest(
        { type: 'game_factory', request_id: '../../escape' },
        input.groupFolder,
        handler,
      ),
    ).toMatchObject({ request_id: 'invalid', error: 'invalid_request' });
    const capability = cap();
    expect(
      await handleGameFactoryWireRequest(
        {
          ...wire(capability),
          sealed_payload: undefined,
          payload: { action: 'create' },
        },
        input.groupFolder,
        handler,
      ),
    ).toMatchObject({ error: 'invalid_sealed_request' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('factory executor lifecycle evidence', () => {
  it('keeps an expired capability active until the actual host finally revokes it', async () => {
    vi.useFakeTimers();
    const diagnosticAttemptId = '00000000-0000-4000-8000-000000000031';
    const finished = vi.fn();
    const started = vi.fn(() => finished);
    const capability = cap({ diagnosticAttemptId, hostRunLifecycle: started });
    const response = await handleGameFactoryWireRequest(
      wire(capability),
      input.groupFolder,
      async (actor) => actor.runId,
    );
    const hostRunId = open(capability, response).data;
    expect(hostRunId).not.toBe(diagnosticAttemptId);
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ runId: hostRunId }),
      diagnosticAttemptId,
    );
    expect(getGameFactoryRunState(hostRunId)).toBe('active');
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(
      await handleGameFactoryWireRequest(
        wire(capability, 'status', { action: 'list' }, 'request-expired'),
        input.groupFolder,
        async () => 'unused',
      ),
    ).toMatchObject({ error: 'invalid_or_expired_capability' });
    expect(getGameFactoryRunState(hostRunId)).toBe('active');
    expect(finished).not.toHaveBeenCalled();
    revokeGameFactoryCapability(capability);
    expect(getGameFactoryRunState(hostRunId)).toBe('finished');
    expect(finished).toHaveBeenCalledOnce();
  });
  it('uses distinct invocation IDs for simultaneous and sequential capabilities in one attempt', async () => {
    const diagnosticAttemptId = '00000000-0000-4000-8000-000000000032';
    const seen: string[] = [];
    const hostRunLifecycle = vi.fn((actor) => {
      seen.push(actor.runId);
      return vi.fn();
    });
    const first = cap({ diagnosticAttemptId, hostRunLifecycle });
    const parallel = cap({ diagnosticAttemptId, hostRunLifecycle });
    expect(new Set(seen).size).toBe(2);
    revokeGameFactoryCapability(first);
    expect(getGameFactoryRunState(seen[0])).toBe('finished');
    expect(getGameFactoryRunState(seen[1])).toBe('active');
    const retry = cap({ diagnosticAttemptId, hostRunLifecycle });
    expect(new Set(seen).size).toBe(3);
    expect(getGameFactoryRunState(seen[2])).toBe('active');
    revokeGameFactoryCapability(retry);
    expect(getGameFactoryRunState(seen[2])).toBe('finished');
    expect(getGameFactoryRunState(seen[1])).toBe('active');
    revokeGameFactoryCapability(parallel);
    expect(getGameFactoryRunState(diagnosticAttemptId)).toBe('unknown');
    expect(getGameFactoryRunState('unobserved-restarted-run')).toBe('unknown');
  });
});
