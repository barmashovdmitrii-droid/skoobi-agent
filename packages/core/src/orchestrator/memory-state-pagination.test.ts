import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureMemoryStateSchema,
  mutateMemoryState,
  readMemoryStatePage,
  getMemoryProjectPage,
  type MemoryStatePage,
} from './memory-state-store.js';
const scope = {
  chatJid: 'tg:page-fixture',
  identityId: 'identity-page',
  tenantId: 'tenant-page',
};
const source = {
  kind: 'assistant_report' as const,
  at: '2026-10-01T00:00:00.000Z',
};
const now = '2026-11-03T00:00:00.000Z';
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  ensureMemoryStateSchema(db);
});
afterEach(() => db.close());
function fact(
  index: number,
  projectKey: string | null = null,
  validUntil?: string,
) {
  return mutateMemoryState(
    db,
    scope,
    {
      kind: 'fact_upsert',
      operationId: `fact-${projectKey ?? 'global'}-${index}`,
      expectedRevision: 0,
      projectKey,
      key: `факт-${String(index).padStart(3, '0')}`,
      value: 'Ж'.repeat(4000),
      ...(validUntil ? { validUntil } : {}),
    },
    source,
    { now },
  );
}
describe('bounded whole-record structured-memory pagination', () => {
  it('reads a >128KiB scope through byte-capped pages without skipping or duplicating rows', () => {
    for (let i = 0; i < 60; i++) fact(i);
    const keys: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = readMemoryStatePage(db, scope, {
        cursor,
        pageSize: 100,
        now,
      });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        96 * 1024,
      );
      expect(page.facts.every((row) => row.value === 'Ж'.repeat(4000))).toBe(
        true,
      );
      keys.push(...page.facts.map((row) => row.key));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 20);
    expect(cursor).toBeUndefined();
    expect(pages).toBeGreaterThan(1);
    expect(keys).toHaveLength(60);
    expect(new Set(keys).size).toBe(60);
    expect(keys).toEqual([...keys].sort());
  });
  it('retains the complete project card on every fact page; never reveals expired/forgotten contents', () => {
    const card = {
      title: 'Большая карточка',
      goal: 'Ц'.repeat(4000),
      status: 'waiting' as const,
      pending: Array.from({ length: 10 }, () => 'Я'.repeat(500)),
      completed: [],
      waiting: 'Review',
      artifacts: [],
    };
    mutateMemoryState(
      db,
      scope,
      {
        kind: 'project_upsert',
        operationId: 'large-project',
        expectedRevision: 0,
        projectKey: 'atlas',
        card,
      },
      source,
      { now },
    );
    for (let i = 0; i < 40; i++) fact(i, 'atlas');
    fact(98, 'atlas', '2026-10-02T00:00:00.000Z');
    fact(99, 'atlas');
    mutateMemoryState(
      db,
      scope,
      {
        kind: 'forget',
        operationId: 'forget-last',
        expectedRevision: 1,
        target: 'fact',
        projectKey: 'atlas',
        key: 'факт-099',
      },
      {
        kind: 'direct_user',
        at: '2026-10-02T00:00:00.000Z',
        messageId: '2',
        quote: 'Забудь факт-099',
        explicitForget: true,
      },
      { now },
    );
    let cursor: string | undefined;
    const keys: string[] = [];
    let expired = 0,
      tombstones = 0,
      pages = 0;
    do {
      const page = getMemoryProjectPage(db, scope, 'atlas', {
        cursor,
        pageSize: 100,
        now,
      })!;
      expect(page.project.card).toEqual(card);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        96 * 1024,
      );
      keys.push(...page.facts.map((row) => row.key));
      expired += page.expired.length;
      tombstones += page.tombstones.length;
      expect(JSON.stringify(page.expired)).not.toContain('Ж');
      expect(JSON.stringify(page.tombstones)).not.toContain('quote');
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 20);
    expect(new Set(keys).size).toBe(40);
    expect(keys).toHaveLength(40);
    expect(expired).toBe(1);
    expect(tombstones).toBe(1);
    expect(pages).toBeGreaterThan(1);
  });
  it('pages near-maximum UTF-8 cards with complete quotes inside the actual byte budget', () => {
    const card = {
      title: 'Large Unicode card',
      goal: '引'.repeat(4000),
      status: 'waiting' as const,
      pending: Array.from({ length: 20 }, () => '引'.repeat(300)),
      completed: [],
      waiting: null,
      artifacts: [],
    };
    for (let index = 0; index < 3; index++)
      mutateMemoryState(
        db,
        scope,
        {
          kind: 'project_upsert',
          operationId: `unicode-card-${index}`,
          expectedRevision: 0,
          projectKey: `card-${index}`,
          card,
        },
        {
          kind: 'direct_user',
          at: source.at,
          messageId: String(index),
          quote: '引'.repeat(2000),
        },
        { now },
      );
    let cursor: string | undefined;
    const keys: string[] = [];
    let pages = 0;
    do {
      const page = readMemoryStatePage(db, scope, {
        cursor,
        pageSize: 100,
        now,
      });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        96 * 1024,
      );
      for (const project of page.projects) {
        expect(project.card).toEqual(card);
        expect(project.source.quote).toBe('引'.repeat(2000));
        keys.push(project.projectKey);
      }
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(keys).toEqual(['card-0', 'card-1', 'card-2']);
    expect(pages).toBeGreaterThan(1);
  });
  it('binds cursor to host scope, namespace and action, including global-vs-all distinction', () => {
    fact(1);
    fact(2);
    const first = readMemoryStatePage(db, scope, { pageSize: 1, now });
    const cursor = first.nextCursor!;
    expect(
      readMemoryStatePage(db, scope, { pageSize: 1, cursor, now }).facts[0].key,
    ).toBe('факт-002');
    expect(() =>
      readMemoryStatePage(
        db,
        { ...scope, identityId: 'other' },
        { cursor, now },
      ),
    ).toThrow('invalid_cursor_scope');
    expect(() =>
      readMemoryStatePage(db, scope, { projectKey: null, cursor, now }),
    ).toThrow('invalid_cursor_scope');
    expect(() =>
      getMemoryProjectPage(db, scope, 'atlas', { cursor, now }),
    ).toThrow('invalid_cursor_scope');
    expect(() =>
      readMemoryStatePage(db, scope, { cursor: 'not-json', now }),
    ).toThrow('invalid_cursor');
  });
});
