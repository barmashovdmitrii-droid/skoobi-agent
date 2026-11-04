import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
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
import { handleMemoryStateRequest } from './memory-state-service.js';
import type { SenderIdentity } from './types.js';

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
  _clearMemoryWriteCapabilities();
  getDb().close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('authenticated structured-memory IPC boundary', () => {
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
      expect(call({ action: 'list' }, cap)).toMatchObject({
        ok: false,
        error: 'authoritative_direct_message_run_required',
      });
    },
  );
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
    latest('30', 'Мой api_key: synthetic-placeholder');
    expect(
      call({
        ...fact('credential-source'),
        source: {
          kind: 'direct_user',
          messageId: '30',
          quote: 'api_key: synthetic-placeholder',
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
