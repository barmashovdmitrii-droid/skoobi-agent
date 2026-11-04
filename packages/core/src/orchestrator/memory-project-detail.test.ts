import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
} from './memory-provenance.js';
import { handleMemoryStateRequest } from './memory-state-service.js';
import { buildStructuredMemoryContext } from './memory-state-context.js';
import { listMemoryState, mutateMemoryState } from './memory-state-store.js';
import type { SenderIdentity } from './types.js';

const chatJid = 'tg:101',
  folder = 'fixture-project-memory';
const identity: SenderIdentity = {
  channel: 'telegram',
  chat_id: '101',
  telegram_user_id: '101',
  identity_id: 'fixture-owner',
  telegram_message_origin: 'direct',
  is_owner_sender: true,
};
const scope = {
  chatJid,
  identityId: identity.identity_id,
  tenantId: 'fixture-tenant',
};
let directory: string, capability: string, sequence: number;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function message(id: string, content: string, chat = chatJid, bot = false) {
  storeChatMetadata(chat, '2026-01-01T00:00:00Z');
  storeMessage({
    id,
    chat_jid: chat,
    sender: identity.telegram_user_id,
    sender_name: 'Fixture',
    content,
    timestamp: `2026-01-01T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
    is_bot_message: bot,
    sender_identity: identity,
  });
}
function source(quote: string) {
  const id = String(++sequence);
  message(id, quote);
  extendMemoryWriteCapabilitiesForChat(folder, chatJid, [id]);
  return { kind: 'direct_user', messageId: id, quote };
}
function call(payload: unknown) {
  const fields = {
    type: 'memory_state' as const,
    request_id: randomUUID(),
    payload,
  };
  return handleMemoryStateRequest(
    { ...fields, ...authorizeMemoryStateRequest(capability, fields) },
    folder,
  );
}
function project(projectKey: string, status = 'active') {
  expect(
    call({
      action: 'mutate',
      operation: {
        kind: 'project_upsert',
        operationId: randomUUID(),
        expectedRevision: 0,
        projectKey,
        card: {
          title: `Project ${projectKey}`,
          goal: 'Synthetic project',
          status,
          pending: [],
          completed: [],
          waiting: null,
          artifacts: [],
        },
      },
      source: { kind: 'assistant_report' },
    }).ok,
  ).toBe(true);
}
function fact(
  projectKey: string,
  key: string,
  value: string,
  detail: unknown,
  options: {
    revision?: number;
    quote?: string;
    factType?: string;
    assistant?: boolean;
  } = {},
) {
  return call({
    action: 'mutate',
    operation: {
      kind: 'fact_upsert',
      operationId: randomUUID(),
      expectedRevision: options.revision ?? 0,
      projectKey,
      key,
      value,
      factType: options.factType ?? 'fact',
      detail,
    },
    source: options.assistant
      ? { kind: 'assistant_report' }
      : source(options.quote ?? value),
  });
}
function artifact(
  text = 'Synthetic scene version one.',
  id = 'bot-fixture-one',
  chat = chatJid,
) {
  message(id, text, chat, true);
  return {
    kind: 'assistant_message',
    messageId: id,
    contentSha256: hash(text),
    fragment: text,
  };
}
beforeEach(() => {
  _initTestDatabase();
  sequence = 10;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-memory-detail-'));
  message('10', 'Synthetic current request');
  capability = registerMemoryWriteCapability(
    {
      groupFolder: folder,
      chatJid,
      isMain: true,
      tenantId: scope.tenantId,
      senderIdentity: identity,
      memoryWriteAllowed: true,
      currentMessageIds: ['10'],
    },
    directory,
  ).capability;
});
afterEach(() => {
  _clearMemoryWriteCapabilities();
  getDb().close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('source-bound project value and editorial memory', () => {
  it('compares canonical project keys and rejects aliases of the same project', () => {
    project('alpha');
    project('beta');
    expect(
      fact('alpha', 'observed', 'The synthetic check completed.', {
        kind: 'project_value',
        category: 'observed_result',
        basis: 'user_reported',
      }).ok,
    ).toBe(true);
    const response = call({
      action: 'compare_projects',
      projectKeys: ['ＡＬＰＨＡ', 'Beta'],
    });
    expect(response.ok).toBe(true);
    expect((response.data as any).projects[0]).toMatchObject({
      projectKey: 'alpha',
      observations: [{ key: 'observed' }],
    });
    expect(
      call({ action: 'compare_projects', projectKeys: ['Alpha', 'alpha'] }).ok,
    ).toBe(false);
  });
  it('retains estimated costs but still asks for reported actual cost evidence', () => {
    project('alpha');
    project('beta');
    expect(
      fact('alpha', 'observed', 'The synthetic check completed.', {
        kind: 'project_value',
        category: 'observed_result',
        basis: 'user_reported',
      }).ok,
    ).toBe(true);
    expect(
      fact('alpha', 'next', 'Run one additional example.', {
        kind: 'project_value',
        category: 'next_check',
        basis: 'expectation',
        successCriterion: 'The example completes.',
      }).ok,
    ).toBe(true);
    expect(
      fact('alpha', 'estimated-cost', 'Estimated cost is 12 USD.', {
        kind: 'project_value',
        category: 'cost',
        basis: 'expectation',
        amount: { decimal: '12', currency: 'USD' },
      }).ok,
    ).toBe(true);
    const response = call({
      action: 'compare_projects',
      projectKeys: ['alpha', 'beta'],
    });
    const projectA = (response.data as any).projects[0];
    expect(
      projectA.observations.find((item: any) => item.category === 'cost'),
    ).toMatchObject({
      basis: 'expectation',
      amount: { decimal: '12', currency: 'USD' },
    });
    expect(projectA.nextEvidenceNeeded).toBe(
      'Record actual known costs or keep them explicitly unknown.',
    );
  });

  it('bounds a large requested comparison and marks omitted observations for full reading', () => {
    for (const projectKey of ['alpha', 'beta', 'gamma']) {
      project(projectKey);
      for (let index = 0; index < 24; index++)
        mutateMemoryState(
          getDb(),
          scope,
          {
            kind: 'fact_upsert',
            operationId: `large-${projectKey}-${index}`,
            expectedRevision: 0,
            projectKey,
            key: `cost-${index}`,
            value: 'Ж'.repeat(4000),
            detail: {
              kind: 'project_value',
              category: 'cost',
              basis: 'agent_reported',
              amount: { decimal: String(index), currency: 'USD' },
            },
          },
          { kind: 'assistant_report', at: '2026-01-01T00:00:00.000Z' },
        );
    }
    const response = call({
      action: 'compare_projects',
      projectKeys: ['alpha', 'beta', 'gamma'],
    });
    expect(response.ok).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(response.data)),
    ).toBeLessThanOrEqual(96 * 1024);
    expect(
      (response.data as any).projects.some(
        (project: any) => project.readFullRecords,
      ),
    ).toBe(true);
  });

  it('compares requested projects read-only, keeps unknown distinct from zero and never infers profit', () => {
    project('alpha');
    project('beta', 'waiting');
    project('gamma', 'completed');
    expect(
      fact('alpha', 'benefit', 'Reduce manual checking.', {
        kind: 'project_value',
        category: 'expected_benefit',
        basis: 'expectation',
      }).ok,
    ).toBe(true);
    expect(
      fact('alpha', 'cost', 'Actual reported cost is zero USD.', {
        kind: 'project_value',
        category: 'cost',
        basis: 'user_reported',
        amount: { decimal: '0', currency: 'USD' },
      }).ok,
    ).toBe(true);
    expect(
      fact('beta', 'cost', 'Costs are unknown.', {
        kind: 'project_value',
        category: 'cost',
        basis: 'unknown',
      }).ok,
    ).toBe(true);
    expect(
      fact('beta', 'revenue', 'Reported revenue is 25 USD.', {
        kind: 'project_value',
        category: 'revenue',
        basis: 'user_reported',
        amount: { decimal: '25', currency: 'USD' },
      }).ok,
    ).toBe(true);
    expect(
      fact('gamma', 'profit', 'Reported profit is -2 EUR.', {
        kind: 'project_value',
        category: 'profit',
        basis: 'user_reported',
        amount: { decimal: '-2', currency: 'EUR' },
      }).ok,
    ).toBe(true);
    expect(
      fact(
        'alpha',
        'check',
        'Try the proposed flow on two synthetic examples.',
        {
          kind: 'project_value',
          category: 'next_check',
          basis: 'expectation',
          successCriterion: 'Both examples finish without manual repair.',
        },
      ).ok,
    ).toBe(true);
    const before = getDb().serialize();
    const response = call({
      action: 'compare_projects',
      projectKeys: ['alpha', 'beta', 'gamma'],
    });
    expect(response.ok).toBe(true);
    expect(getDb().serialize()).toEqual(before);
    const data = response.data as any;
    expect(data.readOnly).toBe(true);
    expect(data.projects.map((item: any) => item.status)).toEqual([
      'active',
      'waiting',
      'completed',
    ]);
    expect(
      data.projects[0].observations.find(
        (item: any) => item.category === 'cost',
      ).amount,
    ).toEqual({ decimal: '0', currency: 'USD' });
    expect(
      data.projects[1].observations.find(
        (item: any) => item.category === 'cost',
      ).amount,
    ).toBeNull();
    expect(
      data.projects[1].observations.some(
        (item: any) => item.category === 'profit',
      ),
    ).toBe(false);
    expect(
      data.projects[2].observations.find(
        (item: any) => item.category === 'profit',
      ).amount,
    ).toEqual({ decimal: '-2', currency: 'EUR' });
    expect(data.projects[0].proposedNextChecks[0].successCriterion).toBe(
      'Both examples finish without manual repair.',
    );
    expect(JSON.stringify(data)).toContain(
      'Subscription token counts are not monetary spending',
    );
    expect(JSON.stringify(data)).toContain('not_independently_verified');
  });

  it('rejects financial contradictions and agent claims labelled as direct user reports', () => {
    project('alpha');
    expect(
      fact('alpha', 'bad-observation', 'Expected outcome.', {
        kind: 'project_value',
        category: 'observed_result',
        basis: 'expectation',
      }).ok,
    ).toBe(false);
    expect(
      fact('alpha', 'bad-unknown', 'Unknown costs.', {
        kind: 'project_value',
        category: 'cost',
        basis: 'unknown',
        amount: { decimal: '0', currency: 'USD' },
      }).ok,
    ).toBe(false);
    expect(
      fact('alpha', 'bad-number', 'A value.', {
        kind: 'project_value',
        category: 'cost',
        basis: 'expectation',
        amount: { decimal: 1, currency: 'USD' },
      }).ok,
    ).toBe(false);
    expect(
      fact('alpha', 'bad-benefit', 'Expected benefit.', {
        kind: 'project_value',
        category: 'expected_benefit',
        basis: 'user_reported',
      }).ok,
    ).toBe(false);
    expect(
      fact(
        'alpha',
        'bad-source',
        'Claimed costs.',
        {
          kind: 'project_value',
          category: 'cost',
          basis: 'user_reported',
          amount: { decimal: '1', currency: 'USD' },
        },
        { assistant: true },
      ).ok,
    ).toBe(false);
    expect(
      fact('alpha', 'bad-check', 'Do something.', {
        kind: 'project_value',
        category: 'next_check',
        basis: 'expectation',
      }).ok,
    ).toBe(false);
  });

  it('checks exact same-chat assistant bytes and fragments, rejecting foreign or invented versions', () => {
    project('alpha');
    const reference = artifact();
    const quote = 'В этой сцене оставь короткие предложения.';
    const good = fact(
      'alpha',
      'стиль',
      'Feedback for the scene.',
      {
        kind: 'editorial_feedback',
        artifact: reference,
        criterionQuote: 'оставь короткие предложения',
        interpretation: 'A tentative hypothesis.',
      },
      { factType: 'preference', quote },
    );
    expect(good).toMatchObject({
      ok: true,
      data: {
        record: {
          detail: {
            artifactVerification: 'host_checked_message',
            associationTrust: 'agent_interpreted',
          },
        },
      },
    });
    for (const [key, changed] of [
      ['wrong-hash', { ...reference, contentSha256: '0'.repeat(64) }],
      ['wrong-fragment', { ...reference, fragment: 'Not in the artifact' }],
      ['foreign', artifact('Foreign scene.', 'foreign-version', 'tg:202')],
    ] as const)
      expect(
        fact(
          'alpha',
          key,
          'Feedback.',
          { kind: 'editorial_feedback', artifact: changed },
          { factType: 'preference', quote },
        ).error,
      ).toBe('editorial_artifact_version_mismatch');
    expect(
      fact(
        'alpha',
        'invented-rule',
        'Feedback.',
        {
          kind: 'editorial_feedback',
          artifact: reference,
          criterionQuote: 'Always use green backgrounds',
        },
        { factType: 'preference', quote },
      ).ok,
    ).toBe(false);
  });

  it('does not turn generic praise or an agent interpretation into automatic taste, and keeps reported references unverified', () => {
    project('alpha');
    project('beta');
    const reference = {
      kind: 'reported_reference',
      reference: 'output/scene.txt',
      version: 'draft-one',
    };
    expect(
      fact(
        'alpha',
        'praise',
        'INVENTED preference for green.',
        {
          kind: 'editorial_feedback',
          artifact: reference,
          interpretation: 'INVENTED preference for green.',
        },
        { factType: 'preference', quote: 'Красиво!' },
      ).ok,
    ).toBe(true);
    expect(
      fact(
        'alpha',
        'bad-praise',
        'Feedback.',
        {
          kind: 'editorial_feedback',
          artifact: reference,
          criterionQuote: 'Отлично!',
        },
        { factType: 'preference', quote: 'Отлично!' },
      ).ok,
    ).toBe(false);
    expect(
      fact(
        'beta',
        'other',
        'Other project feedback.',
        {
          kind: 'editorial_feedback',
          artifact: { ...reference, version: 'BETA_PRIVATE_VERSION' },
        },
        { factType: 'preference', quote: 'Сократи этот фрагмент.' },
      ).ok,
    ).toBe(true);
    const listing = listMemoryState(getDb(), scope);
    const context = buildStructuredMemoryContext(listing, 'alpha').context;
    expect(context).toContain('Красиво!');
    expect(context).toContain('reported_not_verified');
    expect(context).not.toContain('INVENTED');
    expect(context).not.toContain('BETA_PRIVATE_VERSION');
    expect(
      listing.facts.find((item) => item.key === 'praise')?.detail,
    ).toMatchObject({ interpretation: 'INVENTED preference for green.' });
  });

  it('revisions and exact forgetting replace the active feedback version without changing another project', () => {
    project('alpha');
    project('beta');
    expect(
      fact(
        'alpha',
        'стиль',
        'Old feedback.',
        {
          kind: 'editorial_feedback',
          artifact: artifact('OLD_VERSION_SCENE', 'bot-old'),
        },
        { factType: 'preference', quote: 'Сделай сцену короче.' },
      ).ok,
    ).toBe(true);
    expect(
      fact(
        'beta',
        'стиль',
        'Other feedback.',
        {
          kind: 'editorial_feedback',
          artifact: {
            kind: 'reported_reference',
            reference: 'Other scene',
            version: 'OTHER_PROJECT',
          },
        },
        { factType: 'preference', quote: 'Сохрани этот ритм.' },
      ).ok,
    ).toBe(true);
    expect(
      fact(
        'alpha',
        'стиль',
        'New feedback.',
        {
          kind: 'editorial_feedback',
          artifact: artifact('NEW_VERSION_SCENE', 'bot-new'),
          criterionQuote: 'Оставь подробное описание',
        },
        {
          revision: 1,
          factType: 'preference',
          quote: 'Оставь подробное описание.',
        },
      ).ok,
    ).toBe(true);
    let listing = listMemoryState(getDb(), scope);
    const context = buildStructuredMemoryContext(listing, 'alpha').context;
    expect(context).toContain('NEW_VERSION_SCENE');
    expect(context).not.toContain('OLD_VERSION_SCENE');
    expect(context).not.toContain('OTHER_PROJECT');
    const forgotten = call({
      action: 'mutate',
      operation: {
        kind: 'forget',
        operationId: randomUUID(),
        expectedRevision: 2,
        target: 'fact',
        projectKey: 'alpha',
        key: 'стиль',
      },
      source: source('Забудь стиль в проекте alpha.'),
    });
    expect(forgotten.ok).toBe(true);
    listing = listMemoryState(getDb(), scope);
    expect(
      listing.facts.filter((item) => item.projectKey === 'alpha'),
    ).toHaveLength(0);
    expect(
      listing.facts.filter((item) => item.projectKey === 'beta'),
    ).toHaveLength(1);
    expect(
      buildStructuredMemoryContext(listing, 'alpha').context,
    ).not.toContain('NEW_VERSION_SCENE');
    expect(
      getDb()
        .prepare(
          "SELECT count(*) AS n FROM memory_state_versions WHERE body_json LIKE '%OLD_VERSION_SCENE%' OR body_json LIKE '%NEW_VERSION_SCENE%'",
        )
        .get(),
    ).toEqual({ n: 0 });
  });
});
