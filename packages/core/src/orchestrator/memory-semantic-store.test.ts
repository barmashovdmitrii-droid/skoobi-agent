import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureMemoryStateSchema,
  mutateMemoryState,
  type MemoryStateScope,
} from './memory-state-store.js';
import {
  ensureMemorySemanticSchema,
  recallStructuredMemory,
} from './memory-semantic-store.js';
import type { SemanticEncoder } from '@skoobi/memory/semantic-retrieval';

const scope = {
  chatJid: 'tg:semantic-fixture',
  identityId: 'synthetic-owner',
  tenantId: 'synthetic-tenant',
};
const now = '2026-11-04T08:00:00.000Z';
describe('current scoped hybrid memory', () => {
  let db: Database.Database, dir: string, seq: number;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-memory-'));
    db = new Database(path.join(dir, 'memory.sqlite'));
    seq = 0;
    ensureMemoryStateSchema(db);
    ensureMemorySemanticSchema(db);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const put = (
    key: string,
    value: string,
    extra: {
      projectKey?: string | null;
      revision?: number;
      scope?: MemoryStateScope;
      validUntil?: string;
      quote?: string;
    } = {},
  ) =>
    mutateMemoryState(
      db,
      extra.scope ?? scope,
      {
        kind: 'fact_upsert',
        key,
        value,
        projectKey: extra.projectKey ?? null,
        expectedRevision: extra.revision ?? 0,
        operationId: `fixture-${++seq}`,
        validUntil: extra.validUntil,
      },
      {
        kind: 'direct_user',
        at: now,
        messageId: String(seq),
        quote: extra.quote ?? value,
      },
      { now },
    );
  const project = (key: string) =>
    mutateMemoryState(
      db,
      scope,
      {
        kind: 'project_upsert',
        projectKey: key,
        expectedRevision: 0,
        operationId: `project-${key}`,
        card: {
          title: key,
          goal: 'Synthetic task',
          status: 'active',
          pending: [],
          completed: [],
          waiting: null,
          artifacts: [],
        },
      },
      { kind: 'direct_user', at: now, quote: key, messageId: `project-${key}` },
      { now },
    );
  const fake = (
    onEncode?: (texts: readonly string[], kind: string) => void,
  ): SemanticEncoder => ({
    fingerprint: 'synthetic-test-v1',
    dimensions: 3,
    async encode(texts, kind) {
      onEncode?.(texts, kind);
      return texts.map(() => [1, 0, 0]);
    },
  });
  const read = (
    query: string,
    encoder?: SemanticEncoder,
    projectKey: string | null = null,
  ) => recallStructuredMemory(db, scope, { query, encoder, projectKey, now });

  it('filters tenant, identity, chat, project and expiry before sending text to the encoder', async () => {
    project('alpha');
    project('beta');
    put('global', 'Current global rule');
    put('alpha', 'Current selected rule', { projectKey: 'alpha' });
    put('beta', 'FOREIGN_PROJECT', { projectKey: 'beta' });
    put('foreign', 'FOREIGN_IDENTITY', {
      scope: { ...scope, identityId: 'other' },
    });
    put('foreign', 'FOREIGN_CHAT', { scope: { ...scope, chatJid: 'other' } });
    put('foreign', 'FOREIGN_TENANT', {
      scope: { ...scope, tenantId: 'other' },
    });
    put('expired', 'EXPIRED', { validUntil: '2026-11-04T07:59:00.000Z' });
    const seen: string[] = [];
    const result = await read(
      'rule',
      fake((texts) => seen.push(...texts)),
      'alpha',
    );
    expect(result.facts.map((item) => item.key).sort()).toEqual([
      'alpha',
      'global',
    ]);
    expect(seen.join(' ')).not.toMatch(/FOREIGN|EXPIRED/);
    expect(result.mode).toBe('hybrid');
  });
  it('persists vectors across a real SQLite restart and only embeds the query again', async () => {
    put('format', 'Use short paragraphs');
    const first = await read('paragraphs', fake());
    expect(first.embedded).toBe(1);
    db.close();
    db = new Database(path.join(dir, 'memory.sqlite'));
    ensureMemorySemanticSchema(db);
    const calls: string[] = [];
    const result = await read(
      'paragraphs',
      fake((_, kind) => calls.push(kind)),
    );
    expect(calls).toEqual(['query']);
    expect(result.cached).toBe(1);
    expect(result.facts[0].value).toBe('Use short paragraphs');
  });
  it('correction invalidates vectors and FTS in the same transaction; rollback restores both', async () => {
    put('decision', 'Previous amount 100');
    await read('100', fake());
    expect(() =>
      db.transaction(() => {
        put('decision', 'New amount 200', { revision: 1 });
        expect(
          db.prepare('SELECT count(*) n FROM memory_semantic_vectors').get(),
        ).toEqual({ n: 0 });
        expect(
          db
            .prepare(
              "SELECT count(*) n FROM memory_semantic_fts WHERE text MATCH '100'",
            )
            .get(),
        ).toEqual({ n: 0 });
        throw new Error('rollback');
      })(),
    ).toThrow('rollback');
    expect(
      db.prepare('SELECT count(*) n FROM memory_semantic_vectors').get(),
    ).toEqual({ n: 1 });
    put('decision', 'New amount 200', { revision: 1 });
    expect(
      db.prepare('SELECT count(*) n FROM memory_semantic_vectors').get(),
    ).toEqual({ n: 0 });
    const result = await read('200', fake());
    expect(result.facts[0]).toMatchObject({
      revision: 2,
      value: 'New amount 200',
    });
  });
  it('does not resurrect a forgotten record while embedding is in flight', async () => {
    put('private', 'Synthetic sensitive value');
    let changed = false;
    const result = await read(
      'value',
      fake((_, kind) => {
        if (kind === 'passage' && !changed) {
          changed = true;
          mutateMemoryState(
            db,
            scope,
            {
              kind: 'forget',
              target: 'fact',
              projectKey: null,
              key: 'private',
              expectedRevision: 1,
              operationId: 'forget-fixture',
            },
            {
              kind: 'direct_user',
              at: now,
              messageId: '99',
              quote: 'Forget this record',
              explicitForget: true,
            },
            { now },
          );
        }
      }),
    );
    expect(result.facts).toEqual([]);
    expect(
      db.prepare('SELECT count(*) n FROM memory_semantic_vectors').get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT count(*) n FROM memory_semantic_fts').get(),
    ).toEqual({ n: 0 });
  });
  it('does not return old values on a concurrent correction and never indexes ordinary historical quotes', async () => {
    put('decision', 'Current amount 200', {
      quote: 'Replace the old amount 100 with 200',
    });
    let changed = false;
    const seen: string[] = [];
    const result = await read(
      'amount',
      fake((texts, kind) => {
        seen.push(...texts);
        if (kind === 'query' && !changed) {
          changed = true;
          put('decision', 'Corrected amount 300', { revision: 1 });
        }
      }),
    );
    expect(seen.join(' ')).not.toContain('100');
    expect(result.facts[0]).toMatchObject({
      value: 'Corrected amount 300',
      revision: 2,
    });
    expect(
      db.prepare('SELECT count(*) n FROM memory_semantic_vectors').get(),
    ).toEqual({ n: 0 });
  });
  it('expired rows disappear from both derived caches and returned records', async () => {
    put('temporary', 'Temporary rule', {
      validUntil: '2026-11-04T08:01:00.000Z',
    });
    await read('rule', fake());
    const result = await recallStructuredMemory(db, scope, {
      query: 'rule',
      projectKey: null,
      encoder: fake(),
      now: '2026-11-04T08:02:00.000Z',
    });
    expect(result.facts).toEqual([]);
    expect(
      db.prepare('SELECT count(*) n FROM memory_semantic_vectors').get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT count(*) n FROM memory_semantic_fts').get(),
    ).toEqual({ n: 0 });
  });
  it('keeps lexical exact-number matches first even when a vector favors the wrong amount', async () => {
    put('a', 'Synthetic amount 6200');
    put('b', 'Synthetic amount 9200');
    const encoder: SemanticEncoder = {
      fingerprint: 'synthetic-contradictory',
      dimensions: 3,
      async encode(texts, kind) {
        return texts.map((text) =>
          kind === 'query' || text.includes('9200') ? [1, 0, 0] : [0, 1, 0],
        );
      },
    };
    const result = await read('Какой лимит 6200?', encoder);
    expect(result.facts[0].key).toBe('a');
  });
  it('falls back to existing lexical retrieval on encoder failure and quotes FTS syntax', async () => {
    put('needle', 'Synthetic Alpha-42 rule');
    const encoder = fake();
    encoder.encode = async () => {
      throw new Error('synthetic secret exception must not be returned');
    };
    const result = await read('Alpha-42 OR " *', encoder);
    expect(result.mode).toBe('lexical');
    expect(result.reason).toBe('embedding_unavailable');
    expect(result.facts[0].key).toBe('needle');
    expect(JSON.stringify(result)).not.toContain('secret exception');
  });
  it('ignores malformed cached vectors and rejects invalid scope without broad lookup', async () => {
    put('rule', 'Rule fixture');
    await read('rule', fake());
    db.prepare('UPDATE memory_semantic_vectors SET vector=?').run(
      Buffer.from('invalid'),
    );
    const result = await read('rule', fake());
    expect(result.cached).toBe(0);
    expect(result.embedded).toBe(1);
    await expect(
      recallStructuredMemory(
        db,
        { ...scope, identityId: '' },
        { query: 'rule', projectKey: null },
      ),
    ).rejects.toThrow('invalid_memory_scope');
  });
  it('changing the model fingerprint cannot reuse the old model cache', async () => {
    put('rule', 'Rule fixture');
    await read('rule', fake());
    const encoder = fake();
    Object.defineProperty(encoder, 'fingerprint', { value: 'synthetic-v2' });
    const result = await read('rule', encoder);
    expect(result.cached).toBe(0);
    expect(result.embedded).toBe(1);
  });
  it('indexes only literal editorial feedback, never its tentative taste interpretation', async () => {
    project('alpha');
    mutateMemoryState(
      db,
      scope,
      {
        kind: 'fact_upsert',
        operationId: 'editorial',
        expectedRevision: 0,
        projectKey: 'alpha',
        key: 'feedback',
        factType: 'preference',
        value: 'INFERRED_PRIVATE_TASTE',
        detail: {
          kind: 'editorial_feedback',
          artifact: {
            kind: 'reported_reference',
            reference: 'Synthetic draft',
            version: 'v1',
          },
          interpretation: 'INFERRED_PRIVATE_TASTE',
          criterionQuote: 'Shorter introduction',
        },
      },
      {
        kind: 'direct_user',
        at: now,
        quote: 'Shorter introduction',
        messageId: 'editorial-source',
      },
      { now },
    );
    const seen: string[] = [];
    await read(
      'introduction',
      fake((texts) => seen.push(...texts)),
      'alpha',
    );
    expect(seen.join(' ')).toContain('Shorter introduction');
    expect(seen.join(' ')).not.toContain('INFERRED_PRIVATE_TASTE');
  });
  it('foreign identities and nonselected projects cannot perturb lexical ranking', async () => {
    project('alpha');
    project('beta');
    put('a', 'Rare matching word', { projectKey: 'alpha' });
    put('b', 'Common matching word', { projectKey: 'alpha' });
    const initial = (await read('rare common', undefined, 'alpha')).facts.map(
      (f) => f.key,
    );
    for (let i = 0; i < 40; i++) {
      put(`noise-${i}`, 'Rare rare rare matching', {
        scope: { ...scope, identityId: 'foreign' },
      });
      put(`noise-${i}`, 'Rare matching', { projectKey: 'beta' });
    }
    await recallStructuredMemory(
      db,
      { ...scope, identityId: 'foreign' },
      { query: 'rare', projectKey: null, now },
    );
    await read('rare', undefined, 'beta');
    expect(
      (await read('rare common', undefined, 'alpha')).facts.map((f) => f.key),
    ).toEqual(initial);
  });
});
