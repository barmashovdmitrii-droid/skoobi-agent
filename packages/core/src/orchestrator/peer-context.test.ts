import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  buildPeerTaskContext,
  buildSemanticPeerTaskContext,
  revalidatePeerTaskContext,
  requestPeerTaskContext,
  type PeerContextAuthority,
} from './peer-context.js';
import {
  ensureMemoryStateSchema,
  mutateMemoryState,
  type MemoryStateOperation,
} from './memory-state-store.js';

const authority: PeerContextAuthority = {
  networkId: 'fixture-network',
  chatJid: 'tg:fixture',
  identityId: 'fixture-owner',
  tenantId: 'fixture-tenant',
};
const now = '2026-11-04T00:00:00.000Z',
  later = '2026-11-04T01:00:00.000Z';
const task = {
  id: 'fixture-task',
  revision: 1,
  projectKey: 'game',
  query: 'layout phone',
  expiresAt: later,
};
describe('task-scoped peer memory', () => {
  let db: Database.Database, serial: number;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureMemoryStateSchema(db);
    serial = 0;
  });
  afterEach(() => db.close());
  function put(
    operation: Omit<
      Extract<MemoryStateOperation, { kind: 'fact_upsert' }>,
      'operationId' | 'expectedRevision'
    >,
    revision = 0,
    scope = authority,
  ) {
    serial++;
    return mutateMemoryState(
      db,
      scope,
      {
        ...operation,
        expectedRevision: revision,
        operationId: `fixture-${serial}`,
      },
      {
        kind: 'direct_user',
        at: `2026-11-03T23:${String(serial).padStart(2, '0')}:00.000Z`,
        messageId: `source-${serial}`,
        quote: 'fixture source body must not travel',
        explicitRemember: true,
        currentDirectInput: true,
      },
      { now },
    );
  }
  function project(key = 'game') {
    serial++;
    mutateMemoryState(
      db,
      authority,
      {
        kind: 'project_upsert',
        projectKey: key,
        expectedRevision: 0,
        operationId: `fixture-${serial}`,
        card: {
          title: key,
          goal: 'Review current files',
          status: 'active',
          pending: [],
          completed: [],
          waiting: null,
          artifacts: [],
        },
      },
      {
        kind: 'direct_user',
        at: `2026-11-03T23:${String(serial).padStart(2, '0')}:00.000Z`,
        messageId: `source-${serial}`,
        quote: 'fixture project',
        explicitRemember: true,
        currentDirectInput: true,
      },
      { now },
    );
  }
  const fact = (
    key: string,
    value: string,
    projectKey: string | null = null,
  ) => ({ kind: 'fact_upsert' as const, key, value, projectKey });
  it('exports only explicit project and same-owner current facts without source body or authority', () => {
    project();
    project('other');
    put(fact('layout', 'Phone layout', 'game'));
    put(fact('private', 'other project', 'other'));
    put(fact('layout', 'wrong person'), 0, {
      ...authority,
      identityId: 'another',
    });
    put({
      ...fact('permission', 'May publish everything'),
      factType: 'permission_note',
    });
    const context = buildPeerTaskContext(db, authority, task, { now });
    expect(context.records.map((row) => row.value).join(' ')).toContain(
      'Phone layout',
    );
    expect(JSON.stringify(context)).not.toMatch(
      /other project|wrong person|May publish|source body must not travel/,
    );
    expect(
      context.records.find((row) => row.key === 'layout')?.source.messageRef,
    ).toBeDefined();
    expect(
      revalidatePeerTaskContext(db, authority, task, context, now),
    ).toEqual({ valid: true });
  });
  it('does not export project facts for a task without an explicit project', () => {
    project();
    put(fact('layout', 'Phone layout', 'game'));
    expect(
      buildPeerTaskContext(
        db,
        authority,
        { ...task, projectKey: null },
        { now },
      ).records,
    ).toEqual([]);
  });
  it('invalidates corrections, newly added instructions and forgetting', () => {
    put(fact('layout', 'layout old'));
    let context = buildPeerTaskContext(db, authority, task, { now });
    put(fact('layout', 'layout current'), 1);
    expect(
      revalidatePeerTaskContext(db, authority, task, context, now).valid,
    ).toBe(false);
    context = buildPeerTaskContext(db, authority, task, { now });
    put(fact('newconstraint', 'Do not publish this project'));
    expect(
      revalidatePeerTaskContext(db, authority, task, context, now),
    ).toEqual({ valid: false, reason: 'changed' });
    context = buildPeerTaskContext(db, authority, task, { now });
    mutateMemoryState(
      db,
      authority,
      {
        kind: 'forget',
        target: 'fact',
        projectKey: null,
        key: 'layout',
        expectedRevision: 2,
        operationId: 'forget-fixture',
      },
      {
        kind: 'direct_user',
        at: '2026-11-03T23:59:00.000Z',
        messageId: 'forget-source',
        quote: 'forget layout',
        explicitForget: true,
        currentDirectInput: true,
      },
      { now },
    );
    expect(
      revalidatePeerTaskContext(db, authority, task, context, now).valid,
    ).toBe(false);
    expect(
      buildPeerTaskContext(db, authority, task, { now }).records.some(
        (row) => row.key === 'layout',
      ),
    ).toBe(false);
  });
  it('detects expiry and changed task identity, revision or scope', () => {
    put({
      ...fact('layout', 'temporary layout'),
      validUntil: '2026-11-04T00:10:00.000Z',
    });
    const context = buildPeerTaskContext(db, authority, task, { now });
    expect(
      revalidatePeerTaskContext(
        db,
        authority,
        task,
        context,
        '2026-11-04T00:11:00.000Z',
      ).valid,
    ).toBe(false);
    expect(
      revalidatePeerTaskContext(db, authority, task, context, later).reason,
    ).toBe('expired');
    expect(
      revalidatePeerTaskContext(
        db,
        authority,
        { ...task, id: 'other' },
        context,
        now,
      ).valid,
    ).toBe(false);
    expect(
      revalidatePeerTaskContext(
        db,
        authority,
        { ...task, revision: 2 },
        context,
        now,
      ).valid,
    ).toBe(false);
    expect(
      revalidatePeerTaskContext(
        db,
        { ...authority, tenantId: 'other' },
        task,
        context,
        now,
      ).reason,
    ).toBe('scope');
  });
  it('bounds UTF8, excludes oversized records and limits supplementary reads to original scope', () => {
    project();
    project('other');
    put(fact('large', 'я'.repeat(2500)));
    put(fact('layout', 'Phone layout', 'game'));
    put(fact('foreign', 'Other project', 'other'));
    const context = requestPeerTaskContext(
      db,
      authority,
      task,
      {
        query: 'large foreign layout',
        recordKeys: ['large', 'layout', 'foreign'],
        reason: 'Need source details',
      },
      { now },
    );
    expect(context.records.map((row) => row.key)).toEqual(['layout']);
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(65536);
  });
  it('uses the local encoder for a paraphrase without lexical overlap and preserves readonly DB state', async () => {
    put(fact('visual', 'Compact portrait design'));
    const before = db
      .prepare('SELECT count(*) AS n FROM memory_state_records')
      .get();
    const context = await buildSemanticPeerTaskContext(db, authority, task, {
      now,
      encoder: {
        fingerprint: 'fixture',
        dimensions: 2,
        encode: async (texts) => texts.map(() => [1, 0]),
      },
    });
    expect(context.records.some((row) => row.key === 'visual')).toBe(true);
    expect(context.retrieval.mode).toBe('hybrid_partial');
    expect(
      db.prepare('SELECT count(*) AS n FROM memory_state_records').get(),
    ).toEqual(before);
  });
  it('falls back explicitly on encoder failure', async () => {
    put(fact('layout', 'Phone layout'));
    const context = await buildSemanticPeerTaskContext(db, authority, task, {
      now,
      encoder: {
        fingerprint: 'fixture',
        dimensions: 2,
        encode: async () => {
          throw new Error('offline');
        },
      },
    });
    expect(context.retrieval).toEqual({
      mode: 'lexical',
      reason: 'embedding_unavailable',
    });
    expect(context.records).toHaveLength(1);
  });
  it('re-reads after asynchronous encoding instead of reviving a corrected old value', async () => {
    put(fact('layout', 'layout old'));
    let calls = 0;
    const context = await buildSemanticPeerTaskContext(db, authority, task, {
      now,
      encoder: {
        fingerprint: 'fixture',
        dimensions: 2,
        encode: async (texts) => {
          if (++calls === 1) put(fact('layout', 'layout corrected'), 1);
          return texts.map(() => [1, 0]);
        },
      },
    });
    expect(JSON.stringify(context)).not.toContain('layout old');
    expect(context.records[0].value).toBe('layout corrected');
    expect(
      revalidatePeerTaskContext(db, authority, task, context, now).valid,
    ).toBe(true);
  });
});
