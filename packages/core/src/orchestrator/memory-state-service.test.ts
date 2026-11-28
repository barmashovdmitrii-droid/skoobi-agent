import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _initTestDatabase,
  getDb,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  _clearMemoryWriteCapabilities,
  authorizeMemoryStateRequest,
  extendMemoryWriteCapabilitiesForChat,
  registerMemoryWriteCapability,
  revokeMemoryWriteCapability,
} from './memory-provenance.js';
import {
  handleMemoryStateRequest,
  handleMemoryStateWireRequest,
  handleMemoryStateWireRequestWithReason,
  memoryStateRefusalHint,
} from './memory-state-service.js';
import type { SenderIdentity } from './types.js';
import { scheduleStructuredMemoryWarm } from './memory-prompt-recall.js';
import {
  resetInstanceProfileForTests,
  setInstanceProfileForTests,
} from './instance-profile.js';

vi.mock('./memory-prompt-recall.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memory-prompt-recall.js')>()),
  scheduleStructuredMemoryWarm: vi.fn(),
}));

const identity: SenderIdentity = {
  channel: 'telegram',
  chat_id: '101',
  telegram_user_id: '101',
  identity_id: 'identity-a',
  telegram_message_origin: 'direct',
  is_owner_sender: true,
};
const chatJid = 'tg:101';
const folder = 'test-memory-main';
let dataDir: string;
let capability: string;
function message(
  id: string,
  content: string,
  options: {
    chatJid?: string;
    identity?: SenderIdentity;
    bot?: boolean;
    timestamp?: string;
  } = {},
) {
  const chat = options.chatJid ?? chatJid;
  const sender = options.identity ?? identity;
  storeChatMetadata(chat, '2026-10-01T00:00:00.000Z');
  storeMessage({
    id,
    chat_jid: chat,
    sender: sender.telegram_user_id,
    sender_name: 'Test sender',
    content,
    timestamp:
      options.timestamp ??
      `2026-10-01T00:00:${String(Number(id) % 60).padStart(2, '0')}.000Z`,
    is_bot_message: options.bot ?? false,
    sender_identity: sender,
  });
}
function envelope(payload: unknown, cap = capability) {
  const fields = {
    type: 'memory_state' as const,
    request_id: randomUUID(),
    payload,
  };
  return { ...fields, ...authorizeMemoryStateRequest(cap, fields) };
}
function call(payload: unknown, cap = capability) {
  return handleMemoryStateRequest(envelope(payload, cap), folder);
}
function fact(
  operationId = 'create-coffee',
  expectedRevision = 0,
  value = 'Prefers coffee',
) {
  return {
    action: 'mutate',
    operation: {
      kind: 'fact_upsert',
      operationId,
      expectedRevision,
      projectKey: null,
      key: 'coffee',
      value,
    },
    source: {
      kind: 'direct_user',
      messageId: '10',
      quote: 'Я предпочитаю кофе.',
    },
  };
}
function latest(id: string, text: string) {
  message(id, text);
  extendMemoryWriteCapabilitiesForChat(folder, chatJid, [id]);
}

beforeEach(() => {
  _initTestDatabase();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-state-service-'));
  message('10', 'Я предпочитаю кофе.');
  capability = registerMemoryWriteCapability(
    {
      groupFolder: folder,
      chatJid,
      isMain: true,
      tenantId: 'tenant-a',
      senderIdentity: identity,
      memoryWriteAllowed: true,
      currentMessageIds: ['10'],
    },
    dataDir,
  ).capability;
});
afterEach(() => {
  vi.useRealTimers();
  resetInstanceProfileForTests();
  _clearMemoryWriteCapabilities();
  getDb().close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('authenticated structured-memory IPC boundary', () => {
  it('rechecks complete cited messages on manual reads and replays even when an excerpt survives an edit', () => {
    const original = 'В тестовом плане согласовано использовать латунь.';
    const updated = 'В тестовом плане запрещено использовать латунь.';
    message('10', original);
    const request = fact('audit-source-version', 0, 'Подтверждён прежний материал');
    request.source.quote = 'использовать латунь';
    const first = call(request);
    expect(first).toMatchObject({ok:true,data:{record:{
      value:request.operation.value,source:{referenceStatus:'same_chat_message'},
    }}});
    expect(JSON.stringify(first)).not.toContain('messageContentSha256');
    message('10', updated);
    const list = call({action:'list'});
    expect(list).toMatchObject({ok:true,data:{facts:[{
      value:'', requiresSourceReview:true, source:{referenceStatus:'source_edited_review_required'},
    }]}});
    const search = call({action:'search',query:'coffee'});
    expect(search).toMatchObject({ok:true,data:{results:[{
      excerpt:'', requiresSourceReview:true, referenceStatus:'source_edited_review_required',
    }]}});
    const replay = call(request);
    expect(replay).toMatchObject({ok:true,data:{replayed:true,revision:1,record:{
      value:'',requiresSourceReview:true,
    }}});
    for (const response of [list,search,replay]) {
      expect(JSON.stringify(response)).not.toContain(request.operation.value);
      expect(JSON.stringify(response)).not.toContain('messageContentSha256');
    }
  });

  it('refuses oversized cards and outdated requirements with bounded, scoped repair details', () => {
    const project = (
      id: string,
      revision: number,
      requirements: number,
      artifacts: Array<{ path: string; state: string }>,
    ) => ({
      action: 'mutate',
      operation: {
        kind: 'project_upsert',
        operationId: id,
        expectedRevision: revision,
        projectKey: 'fixture-ledger',
        card: {
          title: 'Fixture',
          goal: 'Synthetic target',
          status: 'active',
          completed: [],
          pending: [],
          waiting: null,
          artifacts,
          work: {
            target: 'Fixture',
            executor: 'tester',
            requirementsRevision: requirements,
            nextStep: 'recheck',
            criteria: [
              {
                key: 'route_ok',
                description: 'Fixture criterion',
                state: 'pending',
              },
            ],
          },
        },
      },
      source: { kind: 'assistant_report' },
    });
    const retained = Array.from({ length: 20 }, (_, i) => ({
      path: 'kept-' + i,
      state: 'created',
    }));
    expect(call(project('receipt-init', 0, 3, retained)).ok).toBe(true);
    expect(
      call({ action: 'get_project', projectKey: 'fixture-ledger' }).data,
    ).toMatchObject({
      project: { card: { artifacts: retained } },
    });
    const before = getDb().serialize();
    const tooMany = call(
      project(
        'oversize-check',
        1,
        3,
        Array.from({ length: 21 }, (_, i) => ({
          path: 'fixture-' + i,
          state: 'created',
        })),
      ),
    );
    expect(tooMany).toMatchObject({
      ok: false,
      error: 'invalid_memory_state_payload',
    });
    expect(tooMany.hint).toMatch(/operation\.card\.artifacts.*21.*20.*index/);
    for (const [revision, requirements] of [
      [1, 2],
      [0, 3],
    ]) {
      const conflict = call(
        project('revision-check', revision, requirements, []),
      );
      expect(conflict).toMatchObject({ ok: false, currentRevision: 1 });
      expect(conflict.hint).toMatch(/requirementsRevision 3.*route_ok/);
    }
    expect(getDb().serialize()).toEqual(before);
  });

  it('writes a sourced decision from a Telegram cursor without changing the original timestamp', () => {
    const timestamp = '2026-10-01T00:00:10.500000000000011Z';
    message('11', 'Я предпочитаю кофе.', { timestamp });
    extendMemoryWriteCapabilitiesForChat(folder, chatJid, ['11']);
    expect(call({ ...fact(), source: { kind: 'direct_user', messageId: '11', quote: 'Я предпочитаю кофе.' } })).toMatchObject({
      ok: true,
      data: {
        revision: 1,
        record: {
          source: {
            at: '2026-10-01T00:00:10.500Z',
            messageId: '11',
            quote: 'Я предпочитаю кофе.',
            sourceReferenceTrust: 'verified_quote',
          },
        },
      },
    });
    expect(
      getDb().prepare('SELECT timestamp FROM messages WHERE id=? AND chat_jid=?').get('11', chatJid),
    ).toEqual({ timestamp });
  });

  it('accepts validUntil without seconds as before the zod upgrade and stores full ISO (SEC-02)', () => {
    // zod 4.6 requires seconds in datetime(); 4.3 took «…T18:00Z».
    const request = fact();
    const withMinutes = {
      ...request,
      operation: { ...request.operation, validUntil: '2099-11-30T18:00Z' },
    };
    expect(call(withMinutes)).toMatchObject({
      ok: true,
      data: { record: { validUntil: '2099-11-30T18:00:00.000Z' } },
    });
    const hourOnly = {
      ...request,
      operation: {
        ...request.operation,
        operationId: 'create-coffee-hour',
        expectedRevision: 1,
        validUntil: '2099-11-30T18Z',
      },
    };
    expect(call(hourOnly)).toMatchObject({ ok: false });
  });

  it('saves an assistant project card from a Telegram cursor and reads it back', () => {
    message('11', 'Я предпочитаю кофе.', {
      timestamp: '2026-10-01T00:00:10.500000000000011Z',
    });
    extendMemoryWriteCapabilitiesForChat(folder, chatJid, ['11']);
    const result = call({
      action: 'mutate',
      operation: {
        kind: 'project_upsert',
        projectKey: 'date-repair',
        operationId: 'telegram-card',
        expectedRevision: 0,
        card: {
          title: 'Date repair',
          goal: 'Verify Telegram source interoperability',
          status: 'active',
          completed: [],
          pending: ['Check persistence'],
          waiting: null,
          artifacts: [],
        },
      },
      source: { kind: 'assistant_report' },
    });
    expect(result).toMatchObject({ ok: true, data: { revision: 1 } });
    expect(call({ action: 'get_project', projectKey: 'date-repair' })).toMatchObject({
      ok: true,
      data: {
        project: {
          revision: 1,
          card: { goal: 'Verify Telegram source interoperability' },
          source: { at: '2026-10-01T00:00:10.500Z' },
        },
      },
    });
  });

  it('preserves latest-correction priority for Telegram messages in the same second', () => {
    message('11', 'Я предпочитаю кофе.', {
      timestamp: '2026-10-01T00:00:10.500000000000011Z',
    });
    message('12', 'Я предпочитаю чай.', {
      timestamp: '2026-10-01T00:00:10.500000000000012Z',
    });
    extendMemoryWriteCapabilitiesForChat(folder, chatJid, ['11', '12']);
    expect(call({
      ...fact('newer-tea', 0, 'Prefers tea'),
      source: { kind: 'direct_user', messageId: '12', quote: 'Я предпочитаю чай.' },
    })).toMatchObject({ ok: true, data: { revision: 1 } });
    expect(call({ ...fact('older-coffee', 1), source: { kind: 'direct_user', messageId: '11', quote: 'Я предпочитаю кофе.' } })).toMatchObject({
      ok: false, error: 'stale_source', currentRevision: 1,
    });
    expect(call({ action: 'list' }).data).toMatchObject({
      facts: [{ revision: 1, value: 'Prefers tea' }],
    });
  });

  it('rejects an invalid stored source timestamp without creating a record', () => {
    message('11', 'Я предпочитаю кофе.', { timestamp: 'invalid timestamp' });
    extendMemoryWriteCapabilitiesForChat(folder, chatJid, ['11']);
    expect(call(fact())).toMatchObject({ ok: false, error: 'current_direct_source_required' });
  });

  it('writes then reads exact identity-scoped state and distinguishes a verified quote from interpretation', () => {
    const result = call(fact());
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      revision: 1,
      record: {
        value: 'Prefers coffee',
        source: {
          kind: 'direct_user',
          quote: 'Я предпочитаю кофе.',
          sourceReferenceTrust: 'verified_quote',
          contentTrust: 'agent_interpreted',
        },
        evidence: 'reported_not_verified',
      },
    });
    const read = call({ action: 'list' });
    expect(read.ok).toBe(true);
    expect(read.data).toMatchObject({
      facts: [{ key: 'coffee', revision: 1 }],
    });
    expect(call(fact()).data).toMatchObject({ replayed: true, revision: 1 });
  });
  it('rejects forged payload, copied request, wrong group, revoked and expired capabilities', () => {
    const raw = envelope(fact());
    expect(
      handleMemoryStateRequest({ ...raw, payload: { action: 'list' } }, folder),
    ).toMatchObject({ ok: false, error: 'invalid_proof' });
    expect(handleMemoryStateRequest(raw, 'another-group')).toMatchObject({
      ok: false,
      error: 'capability_group_mismatch',
    });
    expect(handleMemoryStateRequest(raw, folder).ok).toBe(true);
    expect(handleMemoryStateRequest(raw, folder)).toMatchObject({
      ok: false,
      error: 'replayed_request_id',
    });
    const pending = envelope({ action: 'list' });
    revokeMemoryWriteCapability(capability);
    expect(handleMemoryStateRequest(pending, folder)).toMatchObject({
      ok: false,
      error: 'invalid_or_expired_capability',
    });
    capability = registerMemoryWriteCapability(
      {
        groupFolder: folder,
        chatJid,
        isMain: true,
        tenantId: 'tenant-a',
        senderIdentity: identity,
        memoryWriteAllowed: true,
        currentMessageIds: ['10'],
      },
      dataDir,
    ).capability;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60 * 60 * 1000);
    expect(call({ action: 'list' })).toMatchObject({
      ok: false,
      error: 'invalid_or_expired_capability',
    });
    vi.restoreAllMocks();
  });
  it('does not accept caller scope or authority fields even with a valid HMAC', () => {
    expect(call({ ...fact(), tenantId: 'victim' })).toMatchObject({
      ok: false,
      error: 'invalid_memory_state_payload',
    });
    expect(
      call({
        ...fact(),
        source: {
          kind: 'direct_user',
          messageId: '10',
          quote: 'Я предпочитаю кофе.',
          explicitForget: true,
        },
      }),
    ).toMatchObject({ ok: false, error: 'invalid_memory_state_payload' });
  });
  it('rejects foreign chat, sender, forwarded sources, bot output and invented quotes', () => {
    message('11', 'Foreign quote', {
      chatJid: 'tg:202',
      identity: { ...identity, chat_id: '202' },
    });
    message('12', 'Another sender', {
      identity: {
        ...identity,
        telegram_user_id: '303',
        identity_id: 'identity-b',
      },
    });
    message('13', 'Forwarded quote', {
      identity: { ...identity, telegram_message_origin: 'forwarded' },
    });
    message('14', 'Assistant quote', { bot: true });
    for (const [messageId, quote] of [
      ['11', 'Foreign quote'],
      ['12', 'Another sender'],
      ['13', 'Forwarded quote'],
      ['14', 'Assistant quote'],
      ['10', 'Invented quote'],
    ]) {
      expect(
        call({ ...fact(), source: { kind: 'direct_user', messageId, quote } }),
      ).toMatchObject({ ok: false, error: 'source_quote_mismatch' });
    }
  });
  it.each([
    { memoryWriteAllowed: false },
    { senderIdentity: undefined },
    { currentMessageIds: [] },
    {
      senderIdentity: {
        ...identity,
        telegram_message_origin: 'forwarded' as const,
      },
    },
  ])(
    'fails closed for foreign, scheduled or unknown-identity contexts: %o',
    (over) => {
      const cap = registerMemoryWriteCapability(
        {
          groupFolder: folder,
          chatJid,
          isMain: true,
          tenantId: 'tenant-a',
          senderIdentity: identity,
          memoryWriteAllowed: true,
          currentMessageIds: ['10'],
          ...over,
        },
        dataDir,
      ).capability;
      expect(call({ action: 'operation_status', operationId:'fixture-receipt' }, cap)).toMatchObject({
        ok: false, error: 'authoritative_direct_message_run_required',
      });
      expect(call({ action: 'list' }, cap)).toMatchObject({
        ok: false,
        error: 'authoritative_direct_message_run_required',
      });
    },
  );
  it('reports a receipt-store fault without claiming the operation is unknown', () => {
    expect(call(fact()).ok).toBe(true);
    getDb().exec(
      'ALTER TABLE memory_state_operations RENAME COLUMN applied_revision TO unavailable_revision',
    );
    expect(
      call({ action: 'operation_status', operationId: 'create-coffee' }),
    ).toMatchObject({
      ok: false,
      error: 'memory_state_operation_failed',
    });
  });

  it('isolates another real identity even if it cites the same key', () => {
    expect(call(fact()).ok).toBe(true);
    const other = {
      ...identity,
      chat_id: '202',
      telegram_user_id: '202',
      identity_id: 'identity-b',
    };
    message('20', 'Own data', { chatJid: 'tg:202', identity: other });
    const cap = registerMemoryWriteCapability(
      {
        groupFolder: folder,
        chatJid: 'tg:202',
        isMain: false,
        tenantId: 'tenant-b',
        senderIdentity: other,
        memoryWriteAllowed: true,
        currentMessageIds: ['20'],
      },
      dataDir,
    ).capability;
    expect(call({ action: 'list' }, cap).data).toMatchObject({ facts: [] });
  });
  it('requires a current direct exact-target command to forget; keeps tombstone, permits only explicitly requested newer recreation', () => {
    expect(call(fact()).ok).toBe(true);
    latest('21', 'Забудь coffee.');
    const forget = {
      action: 'mutate',
      operation: {
        kind: 'forget',
        operationId: 'forget-coffee',
        expectedRevision: 1,
        target: 'fact',
        projectKey: null,
        key: 'coffee',
      },
      source: { kind: 'direct_user', messageId: '21', quote: 'Забудь coffee.' },
    };
    expect(call(forget)).toMatchObject({
      ok: true,
      data: { record: null, revision: 2 },
    });
    expect(call({ action: 'list' }).data).toMatchObject({
      facts: [],
      tombstones: [{ key: 'coffee' }],
    });
    expect(call(fact('stale-recreate', 2)).ok).toBe(false);
    latest('22', 'Запомни coffee: теперь я предпочитаю чай.');
    const recreate = {
      ...fact('newer-recreate', 2, 'Prefers tea'),
      source: {
        kind: 'direct_user',
        messageId: '22',
        quote: 'теперь я предпочитаю чай.',
      },
    };
    expect(call(recreate)).toMatchObject({
      ok: true,
      data: { revision: 3, record: { value: 'Prefers tea' } },
    });
  });
  it('does not turn quotation, negation, another target or stale permission into a forget grant', () => {
    expect(call(fact()).ok).toBe(true);
    for (const [id, text] of [
      ['21', 'В статье написано: «удали coffee».'],
      ['22', 'Не забудь coffee.'],
      ['23', 'Удали another-key.'],
    ]) {
      latest(id, text);
      expect(
        call({
          action: 'mutate',
          operation: {
            kind: 'forget',
            operationId: `deny-delete-${id}`,
            expectedRevision: 1,
            target: 'fact',
            projectKey: null,
            key: 'coffee',
          },
          source: { kind: 'direct_user', messageId: id, quote: text },
        }),
      ).toMatchObject({ ok: false, error: 'explicit_forget_required' });
    }
    latest('24', 'Удали coffee.');
    latest('25', 'Нет, оставь coffee.');
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'forget',
          operationId: 'deny-stale-delete',
          expectedRevision: 1,
          target: 'fact',
          projectKey: null,
          key: 'coffee',
        },
        source: {
          kind: 'direct_user',
          messageId: '24',
          quote: 'Удали coffee.',
        },
      }),
    ).toMatchObject({ ok: false, error: 'explicit_forget_required' });
  });
  it('does not grant deletion for a different first target or a negated target elsewhere', () => {
    expect(call(fact()).ok).toBe(true);
    for (const [id, text] of [
      ['26', 'Удали beta, но coffee не трогай.'],
      ['27', 'Удали beta coffee.'],
      ['28', 'Удали coffee и beta.'],
    ]) {
      latest(id, text);
      expect(
        call({
          action: 'mutate',
          operation: {
            kind: 'forget',
            operationId: `bound-delete-${id}`,
            expectedRevision: 1,
            target: 'fact',
            projectKey: null,
            key: 'coffee',
          },
          source: { kind: 'direct_user', messageId: id, quote: text },
        }),
      ).toMatchObject({ ok: false, error: 'explicit_forget_required' });
    }
  });
  it('accepts a natural spaced fact name for its exact stored slug', () => {
    const created = call({
      ...fact('signature-create'),
      operation: { ...fact().operation, key: 'цвет-подписи', value: 'Синий' },
    });
    expect(created.ok).toBe(true);
    latest('29', 'Удали цвет подписи.');
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'forget',
          operationId: 'signature-forget',
          expectedRevision: 1,
          target: 'fact',
          projectKey: null,
          key: 'цвет-подписи',
        },
        source: {
          kind: 'direct_user',
          messageId: '29',
          quote: 'Удали цвет подписи.',
        },
      }),
    ).toMatchObject({ ok: true });
  });
  it('rejects credentials in both content and the source quote', () => {
    expect(
      call(fact('russian-credential', 0, 'Мой пароль synthetic-placeholder')),
    ).toMatchObject({ ok: false, error: 'memory_content_looks_secret' });
    expect(
      call(fact('credential-note', 0, 'password: synthetic-placeholder')),
    ).toMatchObject({ ok: false, error: 'memory_content_looks_secret' });
    // Review r1111 (memory detector): words joined by «-» after «:» read as
    // prose («API key: read-only»), so the placeholder value carries a digit.
    latest('30', 'Мой api_key: synthetic-placeholder-42');
    expect(
      call({
        ...fact('credential-source'),
        source: {
          kind: 'direct_user',
          messageId: '30',
          quote: 'api_key: synthetic-placeholder-42',
        },
      }),
    ).toMatchObject({ ok: false, error: 'memory_content_looks_secret' });
  });
  it('allows a clear scoped forget followed by an unrelated no-send constraint', () => {
    const card = {
      title: 'Atlas',
      goal: 'Prepare a draft',
      status: 'waiting',
      pending: ['Review'],
      completed: [],
      waiting: 'User review',
      artifacts: [],
    };
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'project_upsert',
          operationId: 'project-atlas-create',
          expectedRevision: 0,
          projectKey: 'atlas',
          card,
        },
        source: { kind: 'assistant_report' },
      }).ok,
    ).toBe(true);
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'fact_upsert',
          operationId: 'color-atlas-create',
          expectedRevision: 0,
          projectKey: 'atlas',
          key: 'цвет',
          value: 'Синий',
        },
        source: { kind: 'assistant_report' },
      }).ok,
    ).toBe(true);
    const text =
      'Забудь цвет в проекте atlas. Остальную карточку проекта сохрани. Ничего не отправляй.';
    latest('31', text);
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'forget',
          operationId: 'color-atlas-forget',
          expectedRevision: 1,
          target: 'fact',
          projectKey: 'atlas',
          key: 'цвет',
        },
        source: { kind: 'direct_user', messageId: '31', quote: text },
      }),
    ).toMatchObject({ ok: true });
    expect(
      call({ action: 'get_project', projectKey: 'atlas' }).data,
    ).toMatchObject({ project: { projectKey: 'atlas' }, facts: [] });
  });
  it('rejects a later explicit retraction of the same target in one message', () => {
    expect(call(fact()).ok).toBe(true);
    const text = 'Забудь coffee. Нет, оставь coffee.';
    latest('32', text);
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'forget',
          operationId: 'retracted-coffee-forget',
          expectedRevision: 1,
          target: 'fact',
          projectKey: null,
          key: 'coffee',
        },
        source: { kind: 'direct_user', messageId: '32', quote: text },
      }),
    ).toMatchObject({ ok: false, error: 'explicit_forget_required' });
  });
  it('rejects an old forget command when a newer cancellation is ingested but not yet piped', () => {
    expect(call(fact()).ok).toBe(true);
    latest('33', 'Удали coffee.');
    message('34', 'Нет, оставь coffee.'); // deliberately absent from currentMessageIds
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'forget',
          operationId: 'unpipedbackoff-forget',
          expectedRevision: 1,
          target: 'fact',
          projectKey: null,
          key: 'coffee',
        },
        source: {
          kind: 'direct_user',
          messageId: '33',
          quote: 'Удали coffee.',
        },
      }),
    ).toMatchObject({ ok: false, error: 'explicit_forget_required' });
    expect(call({ action: 'list' }).data).toMatchObject({
      facts: [{ key: 'coffee' }],
    });
  });
  it('does not use a duplicate human project title as authority for either exact project', () => {
    const card = {
      title: 'Общий проект',
      goal: 'Draft',
      status: 'waiting',
      pending: [],
      completed: [],
      waiting: 'Review',
      artifacts: [],
    };
    for (const projectKey of ['alpha', 'beta'])
      expect(
        call({
          action: 'mutate',
          operation: {
            kind: 'project_upsert',
            operationId: `duplicate-title-${projectKey}`,
            expectedRevision: 0,
            projectKey,
            card,
          },
          source: { kind: 'assistant_report' },
        }).ok,
      ).toBe(true);
    latest('35', 'Удали проект Общий проект.');
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'forget',
          operationId: 'duplicate-title-forget',
          expectedRevision: 1,
          target: 'project',
          projectKey: 'alpha',
        },
        source: {
          kind: 'direct_user',
          messageId: '35',
          quote: 'Удали проект Общий проект.',
        },
      }),
    ).toMatchObject({ ok: false, error: 'explicit_forget_required' });
    latest('36', 'Удали проект alpha.');
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'forget',
          operationId: 'exact-alpha-forget',
          expectedRevision: 1,
          target: 'project',
          projectKey: 'alpha',
        },
        source: {
          kind: 'direct_user',
          messageId: '36',
          quote: 'Удали проект alpha.',
        },
      }).ok,
    ).toBe(true);
    expect(
      call({ action: 'get_project', projectKey: 'beta' }).data,
    ).toMatchObject({ project: { projectKey: 'beta' } });
  });
  it('binds a project-scoped fact command to that namespace, preserving the same global key', () => {
    const card = {
      title: 'Atlas',
      goal: 'Draft',
      status: 'waiting',
      pending: [],
      completed: [],
      waiting: 'Review',
      artifacts: [],
    };
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'project_upsert',
          operationId: 'namespace-project',
          expectedRevision: 0,
          projectKey: 'atlas',
          card,
        },
        source: { kind: 'assistant_report' },
      }).ok,
    ).toBe(true);
    for (const projectKey of [null, 'atlas'])
      expect(
        call({
          action: 'mutate',
          operation: {
            kind: 'fact_upsert',
            operationId: `namespace-color-${projectKey ?? 'global'}`,
            expectedRevision: 0,
            projectKey,
            key: 'цвет',
            value: 'Синий',
          },
          source: { kind: 'assistant_report' },
        }).ok,
      ).toBe(true);
    latest('37', 'Удали цвет в проекте atlas.');
    const source = {
      kind: 'direct_user',
      messageId: '37',
      quote: 'Удали цвет в проекте atlas.',
    };
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'forget',
          operationId: 'wrong-global-color',
          expectedRevision: 1,
          target: 'fact',
          projectKey: null,
          key: 'цвет',
        },
        source,
      }),
    ).toMatchObject({ ok: false, error: 'explicit_forget_required' });
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'forget',
          operationId: 'right-project-color',
          expectedRevision: 1,
          target: 'fact',
          projectKey: 'atlas',
          key: 'цвет',
        },
        source,
      }).ok,
    ).toBe(true);
    expect(call({ action: 'list', projectKey: null }).data).toMatchObject({
      facts: [{ key: 'цвет' }],
    });
  });
  it('does not confuse a project command with a same-key global fact', () => {
    expect(
      call({
        ...fact('atlas-fact'),
        operation: { ...fact().operation, key: 'atlas' },
      }).ok,
    ).toBe(true);
    latest('38', 'Удали проект atlas.');
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'forget',
          operationId: 'wrong-kind-atlas',
          expectedRevision: 1,
          target: 'fact',
          projectKey: null,
          key: 'atlas',
        },
        source: {
          kind: 'direct_user',
          messageId: '38',
          quote: 'Удали проект atlas.',
        },
      }),
    ).toMatchObject({ ok: false, error: 'explicit_forget_required' });
  });
  it.each(['Voice', 'Audio'])(
    'accepts an exact wrapped %s forget command and keeps quote verification verbatim',
    (wrapper) => {
      expect(call(fact()).ok).toBe(true);
      const text = `[${wrapper}: Удали coffee.]`;
      latest('39', text);
      expect(
        call({
          action: 'mutate',
          operation: {
            kind: 'forget',
            operationId: `voice-forget-${wrapper}`,
            expectedRevision: 1,
            target: 'fact',
            projectKey: null,
            key: 'coffee',
          },
          source: { kind: 'direct_user', messageId: '39', quote: text },
        }).ok,
      ).toBe(true);
    },
  );
  it('does not convert a negated voice message into a forget grant', () => {
    expect(call(fact()).ok).toBe(true);
    const text = '[Voice: Не удаляй coffee.]';
    latest('40', text);
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'forget',
          operationId: 'voice-negated-forget',
          expectedRevision: 1,
          target: 'fact',
          projectKey: null,
          key: 'coffee',
        },
        source: { kind: 'direct_user', messageId: '40', quote: text },
      }),
    ).toMatchObject({ ok: false, error: 'explicit_forget_required' });
  });
  it('labels assistant progress as reported and cannot use it to forget', () => {
    const created = call({ ...fact(), source: { kind: 'assistant_report' } });
    expect(created.data).toMatchObject({
      record: {
        source: {
          kind: 'assistant_report',
          sourceReferenceTrust: 'agent_reported',
        },
        evidence: 'reported_not_verified',
      },
    });
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'forget',
          operationId: 'assistant-delete',
          expectedRevision: 1,
          target: 'fact',
          projectKey: null,
          key: 'coffee',
        },
        source: { kind: 'assistant_report' },
      }),
    ).toMatchObject({ ok: false, error: 'explicit_forget_required' });
  });
});

// Regression: references to credentials are not credential values.
it.each([
  ['quota', 'Проверку только один день, а то токены жалко'],
  ['files', '.env неизменён, Desktop сохранён'],
  ['authorization', 'Операторскую сверку завершили'],
  ['terms', 'API key, token, password, secret, authorization and cookie are field names.'],
])('accepts harmless content and source: %s', (id, value) => {
  latest('41', value);
  expect(call({ ...fact(`regression-${id}`, 0, value), source: {
    kind: 'direct_user', messageId: '41', quote: value,
  } })).toMatchObject({ ok: true });
});
it.each([
  'password: synthetic-placeholder', 'Мой пароль synthetic-placeholder',
  'пароль: 4829', 'api_key=synthetic-placeholder',
  'Bearer synthetic-placeholder', 'token=synthetic-placeholder',
  '-----BEGIN RSA ' + 'PRIVATE KEY-----', 'Cookie: session=synthetic-placeholder',
])('blocks credential values: %s', (value) => {
  expect(call(fact('unsafe-regression', 0, value))).toMatchObject({
    ok: false, error: 'memory_content_looks_secret',
  });
});

// Week review (W12): a refused activation said only
// «explicit_activation_required»; the agent retried the same source 13+5 times
// a week. The host now tells which words of the person unlock it.
describe('memory refusals explain what unlocks them', () => {
  function card() {
    return call({
      action: 'mutate',
      operation: {
        kind: 'project_upsert',
        projectKey: 'date-repair',
        operationId: 'hint-card',
        expectedRevision: 0,
        card: {
          title: 'Date repair', goal: 'Fix dates', status: 'waiting',
          completed: [], pending: ['Check'], waiting: 'Owner reply', artifacts: [],
        },
      },
      source: { kind: 'assistant_report' },
    });
  }
  const activate = (operationId: string, source: unknown) => ({
    action: 'mutate',
    operation: { kind: 'project_activate', operationId, expectedRevision: 1, projectKey: 'date-repair' },
    source,
  });

  it('a refused activation names the words and the project, and still refuses', () => {
    expect(card()).toMatchObject({ ok: true });
    latest('51', 'Занимайся date-repair');
    for (const source of [
      { kind: 'direct_user', messageId: '51', quote: 'Занимайся date-repair' },
      { kind: 'assistant_report' },
    ]) {
      const refused = call(activate(`hint-activate-${source.kind}`, source));
      expect(refused).toMatchObject({ ok: false, error: 'explicit_activation_required' });
      expect(refused.hint).toContain('Продолжай date-repair');
      expect(refused.hint).toContain('direct_user');
    }
    latest('52', 'Продолжай date-repair');
    expect(
      call(activate('hint-activate-ok', { kind: 'direct_user', messageId: '52', quote: 'Продолжай date-repair' })),
    ).toMatchObject({ ok: true });
  });

  // Every word the hint offers must really unlock «<word> <project>»; the
  // natural «Вернись к date-repair» does not, so «вернись» is not offered.
  const offered = /\(also: ([^)]+)\)/
    .exec(memoryStateRefusalHint('explicit_activation_required', 'date-repair') ?? '')?.[1]
    .split(', ') ?? [];
  it('the activation hint offers no «вернись» and lists words', () => {
    expect(offered.length).toBeGreaterThan(3);
    expect(memoryStateRefusalHint('explicit_activation_required', 'date-repair')).not.toMatch(/вернись/i);
  });
  it.each(offered)('the offered activation word «%s» is accepted', (word) => {
    expect(card()).toMatchObject({ ok: true });
    const text = `${word[0].toUpperCase()}${word.slice(1)} date-repair`;
    latest('57', text);
    expect(
      call(activate(`hint-word-${offered.indexOf(word)}`, { kind: 'direct_user', messageId: '57', quote: text })),
    ).toMatchObject({ ok: true });
  });
  it('«Вернись к date-repair» is still refused (the check is unchanged)', () => {
    expect(card()).toMatchObject({ ok: true });
    latest('58', 'Вернись к date-repair');
    expect(
      call(activate('hint-vernis', { kind: 'direct_user', messageId: '58', quote: 'Вернись к date-repair' })),
    ).toMatchObject({ ok: false, error: 'explicit_activation_required' });
  });

  it('a refused forget and a refused credential carry their own hint; success has none', () => {
    expect(call(fact())).toMatchObject({ ok: true });
    expect(call(fact()).hint).toBeUndefined();
    latest('53', 'coffee больше не нужен');
    const forget = call({
      action: 'mutate',
      operation: { kind: 'forget', operationId: 'hint-forget', expectedRevision: 1, target: 'fact', projectKey: null, key: 'coffee' },
      source: { kind: 'direct_user', messageId: '53', quote: 'coffee больше не нужен' },
    });
    expect(forget).toMatchObject({ ok: false, error: 'explicit_forget_required' });
    expect(forget.hint).toContain('Забудь coffee');
    const secret = call(fact('hint-secret', 1, 'password: synthetic' + '-placeholder'));
    expect(secret).toMatchObject({ ok: false, error: 'memory_content_looks_secret' });
    expect(secret.hint).toMatch(/without the value/);
    // Review r1111 (memory detector): only the value goes, the fact stays.
    expect(secret.hint).toMatch(/without the value itself and keep the fact/);
    // Round 0: moving the value elsewhere is named as no way around.
    expect(secret.hint).toMatch(/another field, or splitting it, does not help/);
    // Review r1111 (turn-3): the hint used to say «words … alone are fine»
    // right after refusing; now it says what to change and not to resend.
    expect(secret.hint).not.toMatch(/alone are fine/);
    expect(secret.hint).toMatch(/same text again gets the same refusal/);
    // Round 1: a lone word after «Пароль:» is a value; name the holder instead.
    expect(secret.hint).toMatch(/single word after «Пароль:»/);
    expect(secret.hint).toMatch(/«пароль у Гульнары»/);
    // The holder in the last example is the neutral role unless the instance
    // profile names one.
    expect(secret.hint).toMatch(/«пароль хранится у бухгалтера»/);
  });

  it('the credential hint names the holder of the instance profile and stays one the detector accepts', () => {
    const example = (hint: string | undefined) =>
      /«(пароль хранится у [^»]+)»/u.exec(hint ?? '')?.[1];
    const neutral = memoryStateRefusalHint('credential_content');
    expect(example(neutral)).toBe('пароль хранится у бухгалтера');
    expect(memoryStateRefusalHint('memory_content_looks_secret')).toBe(neutral);

    setInstanceProfileForTests({
      credentialDetector: { peopleWords: ['образец', 'образца'] },
      prompts: { secretHolderExample: 'Образца' },
    });
    const named = memoryStateRefusalHint('credential_content');
    expect(example(named)).toBe('пароль хранится у Образца');
    // Only the holder differs.
    expect(named?.replace('у Образца»', 'у бухгалтера»')).toBe(neutral);
    // The rewrite the hint suggests must not be refused in its turn.
    expect(call(fact('hint-holder', 0, example(named)!))).toMatchObject({
      ok: true,
    });
  });

  // Review r1111 (turn-3): a live card had a
  // line «SSH key <word>.»; the sentence-ending period read as a value and
  // every update of the card was refused. Notes about whose password it is
  // must not be refused either; a value after them still is.
  it('a card with key names and password notes updates; a value in it is refused', () => {
    const upsert = (operationId: string, expectedRevision: number, completed: string[]) => call({
      action: 'mutate',
      operation: {
        kind: 'project_upsert', projectKey: 'peer-copy', operationId, expectedRevision,
        card: {
          title: 'Peer copy', goal: 'Keep the copy running', status: 'waiting',
          completed, pending: ['Check'], waiting: 'Owner reply', artifacts: [],
        },
      },
      source: { kind: 'assistant_report' },
    });
    expect(upsert('peer-card-1', 0, [
      'Проверено: SSH key accepted.', 'Добавил SSH key deploy_key на VDS',
      'Пароль от Wi-Fi в офисе знает Гульнара', 'пароль администратора сменили 09.11',
    ])).toMatchObject({ ok: true });
    expect(upsert('peer-card-2', 1, ['пароль сменён на ' + 'Xyz' + '123'])).toMatchObject({
      ok: false, error: 'memory_content_looks_secret',
    });
  });

  // Every fact in prod belongs to a project; «Забудь deadline» alone is refused
  // for it, so the hint must give the phrase that actually goes through.
  it('a refused forget of a project fact gives a phrase that is then accepted', () => {
    expect(card()).toMatchObject({ ok: true });
    expect(call({
      action: 'mutate',
      operation: {
        kind: 'fact_upsert', operationId: 'hint-deadline', expectedRevision: 0,
        projectKey: 'date-repair', key: 'deadline', value: 'Friday',
      },
      source: { kind: 'assistant_report' },
    })).toMatchObject({ ok: true });
    const forget = (id: string, quote: string) => call({
      action: 'mutate',
      operation: {
        kind: 'forget', operationId: `hint-forget-deadline-${id}`, expectedRevision: 1,
        target: 'fact', projectKey: 'date-repair', key: 'deadline',
      },
      source: { kind: 'direct_user', messageId: id, quote },
    });
    latest('54', 'deadline уже не важен');
    const refused = forget('54', 'deadline уже не важен');
    expect(refused).toMatchObject({ ok: false, error: 'explicit_forget_required' });
    const phrase = /«([^»]+)»/.exec(String(refused.hint))?.[1];
    expect(phrase).toBe('Забудь deadline в проекте date-repair');
    latest('55', 'Забудь deadline');
    expect(forget('55', 'Забудь deadline')).toMatchObject({ ok: false, error: 'explicit_forget_required' });
    latest('56', phrase as string);
    expect(forget('56', phrase as string)).toMatchObject({ ok: true });
  });
});

// W12: the journal only saw «memory_state_rejected» — the real code is sealed
// for the run. The host now keeps the plain code for its own log line.
describe('sealed memory_state refusals keep their code for the host journal', () => {
  function sealed(payload: unknown) {
    const inner = envelope(payload);
    const [capabilityId, secret] = capability.split('.');
    const key = createHmac('sha256', Buffer.from(secret, 'base64url'))
      .update('skoobi.memory_state.request.key.v1')
      .digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([
      'skoobi.memory_state.request.v1', inner.request_id, capabilityId, folder,
    ])));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(inner)), cipher.final()]);
    return {
      type: 'memory_state', request_id: inner.request_id, capability_id: capabilityId,
      sealed_payload: {
        v: 1, iv: iv.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
      },
    };
  }

  it('a refusal: the wire says only memory_state_rejected, the host keeps the real code', () => {
    const refused = handleMemoryStateWireRequestWithReason(
      sealed(fact('wire-secret', 0, 'password: synthetic' + '-placeholder')), folder);
    expect(refused.wire).toMatchObject({ ok: false, error: 'memory_state_rejected' });
    expect(JSON.stringify(refused.wire)).not.toContain('memory_content_looks_secret');
    expect(refused.reason).toBe('memory_content_looks_secret');
  });

  it('success has no reason; a broken transport reports its own outer code', () => {
    const saved = handleMemoryStateWireRequestWithReason(sealed(fact()), folder);
    expect(saved.wire).toMatchObject({ ok: true });
    expect(saved.reason).toBeUndefined();
    const broken = handleMemoryStateWireRequestWithReason({ type: 'memory_state', request_id: 'broken-request-1' }, folder);
    expect(broken.wire).toMatchObject({ ok: false, error: 'invalid_memory_state_transport' });
    expect(broken.reason).toBe('invalid_memory_state_transport');
  });

  // setup/ MCP checks and the evals model trial import the wire-only form.
  it('the wire-only form returns the same sealed envelope without the code', () => {
    const wire = handleMemoryStateWireRequest(
      sealed(fact('wire-only-secret', 0, 'password: synthetic' + '-placeholder')), folder);
    expect(wire).toMatchObject({ ok: false, error: 'memory_state_rejected' });
    expect(wire).not.toHaveProperty('reason');
    expect(handleMemoryStateWireRequest(sealed(fact()), folder)).toMatchObject({ ok: true });
  });
});

// Week review (W07): a successful write asks the host to warm the
// vectors of that project in the background; a refusal or forget does not.
describe('memory writes warm the semantic vectors of their project', () => {
  it('upsert of a global fact and of a project schedule a warm with the real scope', () => {
    const warm = vi.mocked(scheduleStructuredMemoryWarm);
    warm.mockClear();
    expect(call(fact())).toMatchObject({ ok: true });
    expect(call({
      action: 'mutate',
      operation: {
        kind: 'project_upsert', projectKey: 'date-repair', operationId: 'warm-card', expectedRevision: 0,
        card: { title: 'Date repair', goal: 'Fix dates', status: 'active', completed: [], pending: [], waiting: null, artifacts: [] },
      },
      source: { kind: 'assistant_report' },
    })).toMatchObject({ ok: true });
    const scope = { chatJid, tenantId: 'tenant-a', identityId: 'identity-a' };
    expect(warm.mock.calls.map((args) => [args[1], args[2]])).toEqual([
      [scope, null],
      [scope, 'date-repair'],
    ]);
    warm.mockClear();
    expect(call(fact('warm-secret', 1, 'password: synthetic' + '-placeholder')).ok).toBe(false);
    latest('42', 'Забудь coffee.');
    expect(call({
      action: 'mutate',
      operation: { kind: 'forget', operationId: 'warm-forget', expectedRevision: 1, target: 'fact', projectKey: null, key: 'coffee' },
      source: { kind: 'direct_user', messageId: '42', quote: 'Забудь coffee.' },
    })).toMatchObject({ ok: true });
    expect(warm).not.toHaveBeenCalled();
  });
});

// Week review (W07): decisions and task state go to memory_state,
// while memory_search read only files. The host search makes them
// findable in the same chat and for the same person only.
describe('structured memory search', () => {
  const card = (
    title: string,
    goal: string,
    status: 'active' | 'waiting' | 'completed' | 'cancelled',
    extra: Record<string, unknown> = {},
  ) => ({
    title,
    goal,
    status,
    completed: [],
    pending: [],
    waiting: null,
    artifacts: [],
    ...extra,
  });
  const upsert = (projectKey: string, value: unknown) =>
    call({
      action: 'mutate',
      operation: {
        kind: 'project_upsert',
        projectKey,
        operationId: `card-${projectKey}`,
        expectedRevision: 0,
        card: value,
      },
      source: { kind: 'assistant_report' },
    });
  const search = (query: string, extra: Record<string, unknown> = {}, cap = capability) =>
    call({ action: 'search', query, ...extra }, cap) as {
      ok: boolean;
      error?: string;
      data?: {
        terms: number;
        results: Array<Record<string, unknown> & { key: string; excerpt: string }>;
      };
    };

  beforeEach(() => {
    expect(
      upsert(
        'sample-plan-comparison',
        card(
          'Тарифы Basic и Max — сравнение подготовлено',
          'Сравнить два тарифа сервиса без покупки.',
          'completed',
          {
            completed: [
              'Тариф Max включает больше квоты и режим Ultrafast.',
            ],
          },
        ),
      ).ok,
    ).toBe(true);
    expect(
      upsert(
        'atlas2-upgrade-agent',
        card('Обновление Атлас2 и просьбы заказчика', 'Обновить Атлас2.', 'active', {
          pending: ['Дизайнер просит доступ к новой версии'],
        }),
      ).ok,
    ).toBe(true);
    latest('11', 'Проверку ставь только на один день, а то токены жалко.');
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'fact_upsert',
          operationId: 'token-economy-rule',
          expectedRevision: 0,
          projectKey: null,
          key: 'token-economy',
          value: 'Пример решения: проверять расход раз в день, беречь токены.',
          factType: 'decision',
        },
        source: { kind: 'direct_user', messageId: '11', quote: 'токены жалко' },
      }).ok,
    ).toBe(true);
  });

  it('finds a card by a word in its completed steps and marks closed work', () => {
    const found = search('мощности Ultra');
    expect(found.ok).toBe(true);
    const hit = found.data!.results.find(
      (row) => row.key === 'sample-plan-comparison',
    );
    expect(hit).toMatchObject({
      kind: 'project',
      projectKey: 'sample-plan-comparison',
      revision: 1,
      status: 'completed',
      closed: true,
    });
    expect(hit!.excerpt).toContain('Ultrafast');
    expect(hit!.excerpt.length).toBeLessThanOrEqual(300);
  });

  it('ranks the card with most of the words first and finds global decisions', () => {
    const upgrade = search('заказчик дизайнер обновление доступ');
    expect(upgrade.data!.results[0]).toMatchObject({
      key: 'atlas2-upgrade-agent',
      status: 'active',
      closed: false,
    });
    expect(search('токены').data!.results).toEqual([
      expect.objectContaining({
        kind: 'fact',
        projectKey: null,
        key: 'token-economy',
        factType: 'decision',
        status: null,
        closed: false,
      }),
    ]);
    // Narrowed to one project: its card only, no global facts.
    expect(
      search('токены заказчик', { projectKey: 'atlas2-upgrade-agent' }).data!
        .results.map((row) => row.key),
    ).toEqual(['atlas2-upgrade-agent']);
  });

  it('keeps an excerpt of a long record within 300 characters around the hit', () => {
    expect(
      upsert(
        'long-goal',
        card('Длинная задача', `${'вступление '.repeat(150)}редкоеслово в конце.`, 'waiting'),
      ).ok,
    ).toBe(true);
    const hit = search('редкоеслово').data!.results[0];
    expect(hit.key).toBe('long-goal');
    expect(hit.excerpt.length).toBeLessThanOrEqual(300);
    expect(hit.excerpt).toContain('редкоеслово');
  });

  it('never returns another identity records and refuses a search without a current direct message', () => {
    const other = {
      ...identity,
      chat_id: '202',
      telegram_user_id: '202',
      identity_id: 'identity-b',
    };
    message('20', 'Own data', { chatJid: 'tg:202', identity: other });
    const cap = registerMemoryWriteCapability(
      {
        groupFolder: folder,
        chatJid: 'tg:202',
        isMain: false,
        tenantId: 'tenant-b',
        senderIdentity: other,
        memoryWriteAllowed: true,
        currentMessageIds: ['20'],
      },
      dataDir,
    ).capability;
    expect(search('Ultra', {}, cap)).toMatchObject({
      ok: true,
      data: { results: [] },
    });
    const indirect = registerMemoryWriteCapability(
      {
        groupFolder: folder,
        chatJid,
        isMain: true,
        tenantId: 'tenant-a',
        senderIdentity: identity,
        memoryWriteAllowed: true,
        currentMessageIds: ['missing-message'],
      },
      dataDir,
    ).capability;
    expect(search('Ultra', {}, indirect)).toMatchObject({
      ok: false,
      error: 'current_direct_source_required',
    });
  });

  it('accepts a global decision or preference only from the person own words', () => {
    for (const factType of ['decision', 'preference'] as const)
      expect(
        call({
          action: 'mutate',
          operation: {
            kind: 'fact_upsert',
            operationId: `assistant-global-${factType}`,
            expectedRevision: 0,
            projectKey: null,
            key: `assistant-${factType}`,
            value: 'Всегда отвечать коротко.',
            factType,
          },
          source: { kind: 'assistant_report' },
        }),
      ).toMatchObject({ ok: false, error: 'global_rule_requires_direct_user' });
    // An assistant may still record a plain global fact or a project decision.
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'fact_upsert',
          operationId: 'assistant-global-fact',
          expectedRevision: 0,
          projectKey: null,
          key: 'mac-mini-count',
          value: 'В доме два Mac mini.',
          factType: 'fact',
        },
        source: { kind: 'assistant_report' },
      }).ok,
    ).toBe(true);
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'fact_upsert',
          operationId: 'assistant-project-decision',
          expectedRevision: 0,
          projectKey: 'atlas2-upgrade-agent',
          key: 'rollout-order',
          value: 'Сначала обновить копию, потом основной.',
          factType: 'decision',
        },
        source: { kind: 'assistant_report' },
      }).ok,
    ).toBe(true);
  });
});

describe('owner confirmation and lifetime of project read metadata', () => {
  const ordinary = (title: string) => ({
    title, goal: 'Учебная задача', status: 'active', pending: [], completed: [], waiting: null, artifacts: [],
  });
  const done = { ...ordinary('Учебный архив'), status: 'completed' };
  const upsert = (key: string, expectedRevision: number, card: object, source: object,
    operationId: string = randomUUID(), cap = capability) => call({ action: 'mutate', operation: {
    kind: 'project_upsert', projectKey: key, operationId, expectedRevision, card,
  }, source }, cap);
  const report = {kind: 'assistant_report'};
  const direct = (id: string, quote: string) => ({kind: 'direct_user', messageId: id, quote});
  const project = (key: string) => call({ action: 'get_project', projectKey: key }).data as {
    project: {revision: number; card: {aliases?: string[]; relatedProjectKeys?: string[]; goal: string}};
  };
  const main = ordinary('Учебный фасад');
  const aliasLine = 'Добавь имя «линия света» проекту facade';
  const linkLine = 'Свяжи проект facade с проектом archive';
  const metadata = {...main, aliases: ['линия света'], relatedProjectKeys: ['archive']};

  beforeEach(() => {
    expect(upsert('archive', 0, done, report).ok).toBe(true);
    expect(upsert('facade', 0, main, report).ok).toBe(true);
  });

  it('requires the exact latest owner directive for every change and preserves non-metadata fields', () => {
    const combined = aliasLine + '\n' + linkLine;
    const denied = [
      'Учебный фасад и линия света относятся к архиву.',
      'Не выполняй это:\n' + combined,
      combined + '\nНет, отмени это.',
      aliasLine,
      combined.replace('facade', 'другой-проект'),
    ];
    denied.forEach((text, index) => {
      const id=String(index+12);
      latest(id,text);
      const quote = text.includes(combined) ? combined : text;
      expect(upsert('facade',1,metadata,direct(id,quote))).toMatchObject({
        ok:false,error:'project_names_require_direct_source',hint:expect.stringContaining('Свяжи проект'),
      });
    });
    latest('21',combined);
    expect(upsert('facade',1,{...metadata,goal:'несогласованная смена задачи'},direct('21',combined))).toMatchObject({
      ok:false,error:'project_names_require_direct_source',
    });
    latest('22','Другая задача.');
    expect(upsert('facade',1,metadata,direct('21',combined))).toMatchObject({ok:false,error:'project_names_require_direct_source'});
    expect(upsert('facade',1,metadata,report)).toMatchObject({ok:false,error:'project_names_require_direct_source'});
    expect(project('facade').project.revision).toBe(1);
    latest('23',combined);
    const id='consent-lost-reply';
    expect(upsert('facade',1,metadata,direct('23',combined),id)).toMatchObject({ok:true,data:{revision:2,replayed:false}});
    expect(upsert('facade',2,{...metadata,goal:'не поручено'},direct('23',combined))).toMatchObject({ok:false,error:'project_names_require_direct_source'});
    expect(upsert('archive',1,done,report)).toMatchObject({ok:false,error:'project_names_require_direct_source'});
    expect(call({action:'mutate',operation:{kind:'fact_upsert',projectKey:'facade',key:'unsolicited',value:'unconfirmed',
      expectedRevision:0,operationId:'new-unrelated-fact'},source:report})).toMatchObject({ok:false,error:'project_names_require_direct_source'});
    latest('24','Другая задача.');
    expect(upsert('facade',1,metadata,direct('23',combined),id)).toMatchObject({ok:true,data:{revision:2,replayed:true}});
    expect(call({action:'operation_status',operationId:id})).toMatchObject({ok:true,data:{status:'applied',appliedRevision:2}});
    expect(upsert('facade',2,{...main,pending:['Следующий шаг']},report).ok).toBe(true);
    expect(project('facade').project.card).toMatchObject({aliases:['линия света'],relatedProjectKeys:['archive']});
    expect(upsert('facade',3,{...main,aliases:[],relatedProjectKeys:[]},report)).toMatchObject({ok:false,error:'project_names_require_direct_source'});
    const extraNames={...metadata,aliases:['линия света','третье имя']};
    expect(upsert('facade',3,extraNames,direct('23',combined))).toMatchObject({ok:false,error:'project_names_require_direct_source'});
    latest('25','Забудь facade');
    expect(call({action:'mutate',operation:{kind:'forget',target:'project',projectKey:'facade',expectedRevision:3,operationId:'forget-consent-source'},
      source:direct('25','Забудь facade')})).toMatchObject({ok:true});
    expect(upsert('facade',1,metadata,direct('23',combined),id)).toMatchObject({ok:true,data:{record:null,revision:2,replayed:true}});
    expect(project('facade')).toBeNull();
  });

  it('rechecks each distinct addition against the full original command before supplying read context', () => {
    const first = aliasLine+'\n'+linkLine;
    latest('30',first);
    expect(upsert('facade',1,metadata,direct('30',first)).ok).toBe(true);
    const second = 'Добавь имя «узел отчёта» проекту facade';
    latest('31',second);
    expect(upsert('facade',2,{...metadata,aliases:['линия света','узел отчёта']},direct('31',second)).ok).toBe(true);
    message('30',first+'\nОтмена прежней привязки.');
    expect(project('facade').project.card.aliases).toEqual(['узел отчёта']);
    expect(project('facade').project.card.relatedProjectKeys ?? []).toEqual([]);
    const secondWithDifferentBot = {...identity,bot_id:'wrong-bot'};
    message('31',second,{identity:secondWithDifferentBot});
    expect(project('facade').project.card.aliases ?? []).toEqual([]);
  });

  it('can bind only existing exact-key projects and rejects a non-owner source', () => {
    latest('21',linkLine);
    const alternate = registerMemoryWriteCapability({
      groupFolder:folder,chatJid,isMain:true,tenantId:'tenant-a',
      senderIdentity:{...identity,is_owner_sender:false},memoryWriteAllowed:true,currentMessageIds:['21'],
    },dataDir).capability;
    expect(upsert('facade',1,{...main,relatedProjectKeys:['archive']},direct('21',linkLine),randomUUID(),alternate)).toMatchObject({
      ok:false,error:'project_names_require_direct_source',
    });
    latest('22','Свяжи проект facade с проектом отсутствует');
    expect(upsert('facade',1,{...main,relatedProjectKeys:['отсутствует']},direct('22','Свяжи проект facade с проектом отсутствует'))).toMatchObject({ok:false,error:'related_project_missing'});
    latest('23','Добавь имя «линия света» проекту новый');
    expect(upsert('новый',0,{...main,aliases:['линия света']},direct('23','Добавь имя «линия света» проекту новый'))).toMatchObject({ok:false,error:'project_names_require_direct_source'});
  });

  it('a forgotten key cannot reconnect a replacement through old metadata, including an old-client update', () => {
    latest('20',linkLine);
    expect(upsert('facade',1,{...main,relatedProjectKeys:['archive']},direct('20',linkLine)).ok).toBe(true);
    latest('21','Забудь archive');
    expect(call({action:'mutate',operation:{kind:'forget',target:'project',projectKey:'archive',expectedRevision:1,operationId:'forget-original-archive'},source:direct('21','Забудь archive')}).ok).toBe(true);
    latest('22','Запомни archive');
    expect(upsert('archive',2,{...done,title:'Отдельная новая работа'},direct('22','Запомни archive')).ok).toBe(true);
    expect(project('facade').project.card.relatedProjectKeys ?? []).toEqual([]);
    const liveMetadata=getDb().prepare('SELECT metadata_json FROM memory_project_read_metadata WHERE project_key=?').get('facade');
    expect(JSON.stringify(liveMetadata)).not.toContain('archive');
    expect(upsert('facade',2,main,report).ok).toBe(true);
    expect(project('facade').project.card.relatedProjectKeys ?? []).toEqual([]);
    expect(upsert('facade',3,{...main,relatedProjectKeys:['archive']},report)).toMatchObject({ok:false,error:'project_names_require_direct_source'});
    latest('23',linkLine);
    expect(upsert('facade',3,{...main,relatedProjectKeys:['archive']},direct('23',linkLine)).ok).toBe(true);
    expect(project('facade').project.card.relatedProjectKeys).toEqual(['archive']);
    latest('24','Убери связь проекта facade с проектом archive');
    expect(upsert('facade',4,{...main,relatedProjectKeys:[]},direct('24','Убери связь проекта facade с проектом archive')).ok).toBe(true);
    expect(project('facade').project.card.relatedProjectKeys ?? []).toEqual([]);
  });
});
