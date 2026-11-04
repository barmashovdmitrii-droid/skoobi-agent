import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import { buildPromptMemoryContexts } from './message-loop.js';
import {
  buildStructuredMemoryContext,
  latestMemoryRecallQuery,
} from './memory-state-context.js';
import {
  listMemoryState,
  mutateMemoryState,
  type MemoryProjectCard,
  type MemoryStateScope,
} from './memory-state-store.js';
import { formatMessages } from './router.js';
import type { RegisteredGroup, SenderIdentity } from './types.js';
import type { TenantRecord } from './tenant-registry.js';

const identity: SenderIdentity = {
  channel: 'telegram',
  chat_id: '101',
  telegram_user_id: '101',
  identity_id: 'fixture_101',
  telegram_message_origin: 'direct',
  is_owner_sender: true,
};
const scope: MemoryStateScope = {
  chatJid: 'tg:101',
  identityId: identity.identity_id,
  tenantId: 'fixture_tenant',
};
const source = (id: number) => ({
  kind: 'direct_user' as const,
  at: `2026-10-01T12:00:${String(id).padStart(2, '0')}.000Z`,
  messageId: String(id),
  quote: 'Прямое поручение пользователя',
  currentDirectInput: true,
});
const card = (title: string): MemoryProjectCard => ({
  title,
  goal: `Подготовить документы ${title}`,
  status: 'active',
  pending: ['Проверить пакет у получателя'],
  completed: ['Черновик создан'],
  waiting: null,
  artifacts: [{ path: '/fixture/package.zip', state: 'created' }],
});
const project = (key: string, title: string, id: number) =>
  mutateMemoryState(
    getDb(),
    scope,
    {
      kind: 'project_upsert',
      projectKey: key,
      card: card(title),
      expectedRevision: 0,
      operationId: `project-${id}`,
    },
    source(id),
  );
const fact = (
  projectKey: string,
  key: string,
  value: string,
  revision: number,
  id: number,
) =>
  mutateMemoryState(
    getDb(),
    scope,
    {
      kind: 'fact_upsert',
      projectKey,
      key,
      value,
      factType: 'decision',
      expectedRevision: revision,
      operationId: `fact-${id}`,
    },
    source(id),
  );
let root: string;
beforeEach(() => {
  _initTestDatabase();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-prompt-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('memory used for the next decision', () => {
  it('uses the latest user correction after a long earlier batch message', () => {
    project('atlas', 'Атлас', 1);
    project('orbit', 'Орбита', 2);
    const query = latestMemoryRecallQuery([
      { content: `Подготовь Атлас. ${'Старое описание. '.repeat(300)}` },
      { content: 'Теперь продолжи Орбита: подпись синяя.' },
      { content: '  ' },
      { content: 'Служебный ответ', is_bot_message: true },
    ]);
    const state = buildStructuredMemoryContext(
      listMemoryState(getDb(), scope),
      query,
    );
    expect(state.selectedProjectKey).toBe('orbit');
    expect(state.recallQuery).toContain('подпись синяя');
    const longCorrection = buildStructuredMemoryContext(
      listMemoryState(getDb(), scope),
      `${'Дополнительные подробности. '.repeat(300)} Теперь нужна синяя подпись.`,
    );
    expect(longCorrection.recallQuery).toHaveLength(1600);
    expect(longCorrection.recallQuery).toContain('Теперь нужна синяя подпись.');
  });

  it('continues the explicitly focused project after background updates to another unfinished project', () => {
    project('atlas', 'Атлас', 1);
    project('orbit', 'Орбита', 2);
    mutateMemoryState(
      getDb(),
      scope,
      {
        kind: 'project_upsert',
        projectKey: 'atlas',
        expectedRevision: 1,
        operationId: 'background-progress',
        card: { ...card('Атлас'), completed: ['Фоновая сборка завершена'] },
      },
      { kind: 'assistant_report', at: source(3).at },
    );
    const result = buildStructuredMemoryContext(
      listMemoryState(getDb(), scope),
      'продолжай',
    );
    expect(result.selectedProjectKey).toBe('orbit');
    expect(result.context).toContain('Орбита');
    expect(result.context).not.toContain('Фоновая сборка завершена');
    expect(result.recallQuery).toContain('Орбита');
    expect(
      buildStructuredMemoryContext(
        listMemoryState(getDb(), scope),
        '[Voice: продолжай]',
      ).selectedProjectKey,
    ).toBe('orbit');
  });

  it('an explicit project name overrides focus and receives only the latest decision in its own scope', () => {
    project('atlas', 'Атлас', 1);
    project('orbit', 'Орбита', 2);
    fact('atlas', 'заказчик', 'Компания А', 0, 3);
    fact('atlas', 'заказчик', 'Компания Б', 1, 4);
    fact('orbit', 'заказчик', 'Компания В', 0, 5);
    const result = buildStructuredMemoryContext(
      listMemoryState(getDb(), scope),
      'Продолжи Атлас, пожалуйста.',
    );
    expect(result.selectedProjectKey).toBe('atlas');
    expect(result.context).toContain('Компания Б');
    expect(result.context).not.toContain('Компания А');
    expect(result.context).not.toContain('Компания В');
    expect(result.context).toContain('messageId');
    expect(result.context).toContain('verified_quote');
  });

  it('does not pick another old task after the focused task closes or hijack a new unrelated request', () => {
    project('atlas', 'Атлас', 1);
    project('orbit', 'Орбита', 2);
    expect(
      buildStructuredMemoryContext(
        listMemoryState(getDb(), scope),
        'Расскажи о вулканах',
      ).selectedProjectKey,
    ).toBeNull();
    expect(
      buildStructuredMemoryContext(
        listMemoryState(getDb(), scope),
        'Подготовь новые документы для другого клиента',
      ).selectedProjectKey,
    ).toBeNull();
    mutateMemoryState(
      getDb(),
      scope,
      {
        kind: 'project_upsert',
        projectKey: 'orbit',
        expectedRevision: 1,
        operationId: 'finish-orbit',
        card: { ...card('Орбита'), status: 'completed', pending: [] },
      },
      source(3),
    );
    expect(
      buildStructuredMemoryContext(listMemoryState(getDb(), scope), 'продолжай')
        .selectedProjectKey,
    ).toBeNull();
  });

  it('marks ambiguous project references and keeps claims separate from verified delivery', () => {
    project('atlas', 'Атлас', 1);
    project('orbit', 'Орбита', 2);
    const result = buildStructuredMemoryContext(
      listMemoryState(getDb(), scope),
      'Атлас или Орбита',
    );
    expect(result.selectedProjectKey).toBeNull();
    expect(result.context).toContain('ambiguous_projects');
    const exact = buildStructuredMemoryContext(
      listMemoryState(getDb(), scope),
      'Атлас',
    );
    expect(exact.context).toContain('reported_not_verified');
    expect(exact.context).toContain('created');
    expect(exact.context).not.toContain('reportedState&quot;:&quot;delivered');
  });

  it('bounds the prompt and preserves an exact project reference when details are long', () => {
    mutateMemoryState(
      getDb(),
      scope,
      {
        kind: 'project_upsert',
        projectKey: 'atlas',
        expectedRevision: 0,
        operationId: 'large-project',
        card: {
          ...card('Атлас'),
          goal: 'документы '.repeat(390),
          pending: Array(18).fill('Проверить '.repeat(45)),
        },
      },
      source(1),
    );
    for (let i = 2; i < 18; i++)
      fact('atlas', `выбор-${i}`, 'Уточнение '.repeat(390), 0, i);
    const result = buildStructuredMemoryContext(
      listMemoryState(getDb(), scope),
      'Атлас',
    );
    expect(result.context.length).toBeLessThanOrEqual(6500);
    expect(result.context).toContain('atlas');
    expect(result.context).toContain('readFullRecord');
  });
});

describe('host prompt integration', () => {
  const group: RegisteredGroup = {
    name: 'Fixture',
    folder: 'fixture_memory',
    trigger: '',
    added_at: '2026-01-01T00:00:00.000Z',
    isMain: true,
    agentConfig: { lazyMemory: true, curatedMemory: false },
  };
  const tenant: TenantRecord = {
    tenant_id: scope.tenantId,
    folder: group.folder,
    channel: 'telegram',
    chat_id: '101',
    bot_id: 'telegram_default',
    persona_id: 'default',
    mode: 'owner',
    runtime: 'claude_sdk',
    approved_senders: [],
    models: {},
    quota: { enabled: true },
    legacy_jid: scope.chatJid,
    source: 'legacy_registered_group',
    group,
  };
  const contexts = (senderIdentity = identity) =>
    buildPromptMemoryContexts({
      chatJid: scope.chatJid,
      senderId: senderIdentity.telegram_user_id,
      senderIdentity,
      tenant,
      group,
      groups: { [scope.chatJid]: group },
      groupsDir: path.join(root, 'groups'),
      dataDir: path.join(root, 'data'),
      currentText: 'продолжай Атлас',
    }).join('\n');

  it('injects the current card and relevant older notes, then suppresses raw automatic recall after forgetting', () => {
    const file = path.join(root, 'groups', group.folder, 'memory', 'old.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '- Атлас: исходные документы находятся в архиве.');
    project('atlas', 'Атлас', 1);
    fact('atlas', 'цвет', 'ультрамарин', 0, 2);
    expect(contexts()).toContain('<structured_memory>');
    expect(contexts()).toContain('исходные документы находятся');
    mutateMemoryState(
      getDb(),
      scope,
      {
        kind: 'forget',
        target: 'fact',
        projectKey: 'atlas',
        key: 'цвет',
        expectedRevision: 1,
        operationId: 'forget-color',
      },
      { ...source(3), explicitForget: true },
    );
    const after = contexts();
    expect(after).not.toContain('ультрамарин');
    expect(after).not.toContain('исходные документы находятся');
    expect(after).not.toContain('<chat_memory_index>');
    expect(after).toContain('autoLegacyRecallDisabled');
    const forwarded = contexts({
      ...identity,
      telegram_message_origin: 'forwarded',
    });
    expect(forwarded).not.toContain('исходные документы находятся');
    expect(forwarded).not.toContain('<chat_memory_index>');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('does not inject another identity project or treat an indirect message as a personal state grant', () => {
    project('atlas', 'Private title', 1);
    expect(
      contexts({
        ...identity,
        telegram_user_id: '202',
        identity_id: 'fixture_202',
      }),
    ).not.toContain('Private title');
    expect(
      contexts({ ...identity, telegram_message_origin: 'forwarded' }),
    ).not.toContain('Private title');
  });

  it('provides escaped real source ids without permitting attribute injection', () => {
    const formatted = formatMessages(
      [
        {
          id: '12" injected="yes',
          chat_jid: 'tg:101',
          sender: '101',
          sender_name: 'Owner',
          content: 'Оставь исходную музыку',
          timestamp: source(1).at,
          sender_identity: identity,
        },
      ],
      'UTC',
    );
    expect(formatted).toContain('id="12&quot; injected=&quot;yes"');
    expect(formatted).not.toContain(' injected="yes"');
  });
});
