import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb, storeChatMetadata, storeMessage } from './db.js';
import {
  buildPromptMemoryContexts,
  buildPromptMemoryContextsWithRecall,
} from './message-loop.js';
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
const assignmentStart = Date.now() - 120_000;
const source = (id: number) => ({
  kind: 'direct_user' as const,
  at: new Date(assignmentStart + id * 1000).toISOString(),
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
const project = (key: string, title: string, id: number, quote = source(id).quote) =>
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
    {...source(id),quote},
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
  it('reads a legacy waiting condition and respects its latest revision and recorded dependency', () => {
    const waiting = { ...card('Атлас'), status: 'waiting' as const, waiting: 'Ждём сигнал', pending: ['Продолжить только по сигналу'] };
    const put = (updated: MemoryProjectCard, revision: number) => mutateMemoryState(getDb(), scope, {
      kind: 'project_upsert', projectKey: 'atlas', card: updated, expectedRevision: revision, operationId: 'wait-' + revision,
    }, source(revision + 1));
    put(waiting, 0);
    expect(listMemoryState(getDb(), scope).projects[0]?.waitingState).toEqual({
      condition: 'Ждём сигнал', waitingOn: null, nextStep: 'Продолжить только по сигналу', stepSource: 'recorded_pending',
    });
    put({ ...waiting, waiting: 'Ждём макет', pending: [], work: { target: 'Макет', executor: 'Студия',
      waitingOn: 'Дизайнер', requirementsRevision: 1, nextStep: 'Сверить размер', criteria: [
        {key: 'size', description: 'Проверить размер', state: 'pending'},
      ] } }, 1);
    const listing = listMemoryState(getDb(), scope);
    expect(listing.projects[0]?.waitingState).toMatchObject({ waitingOn: 'Дизайнер', nextStep: 'Сверить размер', stepSource: 'checkpoint' });
    const context = buildStructuredMemoryContext(listing, 'Атлас').context;
    expect(context).toContain('Дизайнер');
    expect(context).not.toContain('Продолжить только по сигналу');
    expect(listMemoryState(getDb(), { ...scope, identityId: 'other' }).projects).toHaveLength(0);
  });

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
    // A listing alone cannot recheck its message against the current chat.
    expect(result.context).toContain('current_source_unavailable');
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

  it('puts a global preference into every prompt only when the person said it', () => {
    const preference = (key: string, kind: 'direct_user' | 'assistant_report') => ({
      kind: 'fact' as const,
      projectKey: null,
      key,
      value: `Правило ${key}`,
      factType: 'preference' as const,
      validUntil: null,
      revision: 1,
      updatedAt: '2026-10-01T12:00:00.000Z',
      evidence: 'reported_not_verified' as const,
      source: {
        kind,
        at: '2026-10-01T12:00:00.000Z',
        sourceReferenceTrust:
          kind === 'direct_user' ? ('verified_quote' as const) : ('agent_reported' as const),
        contentTrust: 'agent_interpreted' as const,
      },
    });
    const listing = {
      ...listMemoryState(getDb(), scope),
      facts: [
        preference('short-answers', 'direct_user'),
        preference('legacy-guess', 'assistant_report'),
      ],
    };
    const result = buildStructuredMemoryContext(listing, 'Расскажи о вулканах');
    expect(result.context).toContain('short-answers');
    expect(result.context).not.toContain('legacy-guess');
    expect(result).toMatchObject({ injectedFacts: 1, injectedGlobalFacts: 1 });
  });

  // Week review (W32): «делай / Что дальше» during a security
  // audit were resolved to an unrelated card changed ~17 hours earlier.
  it('continues a focused project on a short follow-up only while its card is fresh, without file recall', () => {
    project('atlas', 'Атлас', 1);
    const listing = listMemoryState(getDb(), scope);
    const updated = Date.parse(listing.projects[0].updatedAt);
    const at = (hours: number) =>
      new Date(updated + hours * 60 * 60 * 1000).toISOString();
    const fresh = buildStructuredMemoryContext(listing, 'делай', { now: at(1) });
    expect(fresh).toMatchObject({
      selectedProjectKey: 'atlas',
      selectedBy: 'continuation',
      fileRecallQuery: '',
    });
    // Structured recall still ranks the card's own facts by its words.
    expect(fresh.recallQuery).toContain('Атлас');
    const stale = buildStructuredMemoryContext(listing, 'Что дальше', {
      now: at(7),
    });
    expect(stale.selectedProjectKey).toBeNull();
    expect(stale.context).not.toContain('Атлас');
    expect(stale.fileRecallQuery).toBe('Что дальше');
    // Naming the project still works at any age.
    expect(
      buildStructuredMemoryContext(listing, 'Как там Атлас?', { now: at(48) })
        .selectedBy,
    ).toBe('explicit');
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
  const contexts = (senderIdentity = identity, currentText = 'продолжай Атлас: где исходные документы?') =>
    buildPromptMemoryContexts({
      chatJid: scope.chatJid,
      senderId: senderIdentity.telegram_user_id,
      senderIdentity,
      tenant,
      group,
      groups: { [scope.chatJid]: group },
      groupsDir: path.join(root, 'groups'),
      dataDir: path.join(root, 'data'),
      // Two significant words: file recall abstains on one (W32).
      currentText,
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

  it('reports what the structured block holds through onRecall, without any text', async () => {
    project('atlas', 'Атлас', 1);
    fact('atlas', 'цвет', 'ультрамарин', 0, 2);
    const summaries: Record<string, unknown>[] = [];
    const joined = (
      await buildPromptMemoryContextsWithRecall(
        {
          chatJid: scope.chatJid,
          senderId: identity.telegram_user_id,
          senderIdentity: identity,
          tenant,
          group,
          groups: { [scope.chatJid]: group },
          groupsDir: path.join(root, 'groups'),
          dataDir: path.join(root, 'data'),
          currentText: 'продолжай Атлас',
        },
        (summary) => summaries.push(summary),
      )
    ).join('\n');
    expect(joined).toContain('ультрамарин');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      structured: {
        mode: 'lexical',
        reason: 'not_configured',
        project_selected: true,
        project_selected_by: 'explicit',
        facts_injected: 1,
        global_facts_injected: 0,
      },
    });
    expect(JSON.stringify(summaries[0])).not.toMatch(/Атлас|atlas|ультрамарин/);
    const forwarded: Record<string, unknown>[] = [];
    await buildPromptMemoryContextsWithRecall(
      {
        chatJid: scope.chatJid,
        senderId: identity.telegram_user_id,
        senderIdentity: { ...identity, telegram_message_origin: 'forwarded' },
        tenant,
        group,
        groups: { [scope.chatJid]: group },
        groupsDir: path.join(root, 'groups'),
        dataDir: path.join(root, 'data'),
        currentText: 'продолжай Атлас',
      },
      (summary) => forwarded.push(summary),
    );
    expect(forwarded[0]).toMatchObject({
      structured: { scoped: false, unavailable: false },
    });
  });

  it('reports which memory files went in, and recalls none for a follow-up that continues a card', async () => {
    const file = path.join(root, 'groups', group.folder, 'memory', 'old.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      '- Атлас: подготовить документы, исходные документы в архиве.',
    );
    const assignment = 'Подготовь документы по проекту Атлас';
    storeChatMetadata(scope.chatJid, source(1).at);
    const saveTurn = (id: number, content: string) => storeMessage({
      chat_jid:scope.chatJid, id:String(id), sender:identity.telegram_user_id, sender_name:'Test',
      content, timestamp:source(id).at,sender_identity:identity,
    });
    saveTurn(1,assignment);
    project('atlas', 'Атлас', 1, assignment);
    let id = 1;
    const run = async (currentText: string) => {
      saveTurn(++id, currentText);
      const summaries: Record<string, unknown>[] = [];
      const joined = (
        await buildPromptMemoryContextsWithRecall(
          {
            chatJid: scope.chatJid,
            senderId: identity.telegram_user_id,
            senderIdentity: identity,
            tenant,
            group,
            groups: { [scope.chatJid]: group },
            groupsDir: path.join(root, 'groups'),
            dataDir: path.join(root, 'data'),
            currentText, currentMessageId:String(id),
          },
          (summary) => summaries.push(summary),
        )
      ).join('\n');
      return { joined, summary: summaries[0] as Record<string, any> };
    };
    const followUp = await run('делай');
    expect(followUp.joined).toContain('<structured_memory>');
    expect(followUp.joined).toContain('Атлас');
    expect(followUp.joined).not.toContain('<relevant_memory>');
    expect(followUp.summary.files).toEqual({
      snippets: 0,
      files: [],
      block_chars: 0,
      query_terms: 0,
      query_source: 'project_card',
      legacy_excluded: false,
    });
    expect(followUp.summary.structured).toMatchObject({
      project_selected: true,
      project_selected_by: 'continuation',
    });
    const asked = await run('Где исходные документы по Атласу?');
    expect(asked.joined).toContain('<relevant_memory>');
    expect(asked.summary.files).toMatchObject({
      snippets: 1,
      files: ['memory/old.md'],
      query_source: 'text',
    });
    expect(asked.summary.files.query_terms).toBeGreaterThanOrEqual(2);
    expect(asked.summary.files.block_chars).toBeGreaterThan(0);
    expect(JSON.stringify(asked.summary)).not.toMatch(/архив|исходные/);
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

  it('checks the same chat and bot for synchronous recall of an otherwise matching identity and tenant', () => {
    project('atlas', 'Private candidate', 1);
    fact('atlas', 'color', 'sensitive synthetic choice', 0, 2);
    storeChatMetadata(scope.chatJid, source(2).at);
    storeMessage({ id: '2', chat_jid: scope.chatJid, sender: identity.telegram_user_id,
      sender_name: 'Test', content: source(2).quote, timestamp: source(2).at, sender_identity: identity });
    const direct = contexts(identity, 'Private candidate');
    expect(direct).toContain('sensitive synthetic choice');
    // This legacy fixture predates whole-message fingerprints.
    expect(direct).toContain('unversioned_quote_match');
    expect(direct).toContain('&quot;messageId&quot;:&quot;2&quot;');
    expect(direct).not.toContain('https://t.me/c/');
    for (const sender of [
      { ...identity, chat_id: '990' },
      { ...identity, bot_id: 'alternate-bot' },
    ]) {
      expect(contexts(sender, 'Private candidate')).not.toContain('sensitive synthetic choice');
      expect(contexts(sender, 'Private candidate')).not.toContain('<structured_memory>');
    }
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
