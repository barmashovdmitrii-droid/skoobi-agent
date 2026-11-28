import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureMemoryStateSchema,
  getMemoryProject,
  listMemoryState,
  MemoryStateError,
  mutateMemoryState,
  type MemoryProjectCard,
  type MemoryStateOperation,
  type MemoryStateScope,
  type MemoryStateSource,
} from './memory-state-store.js';

const scope: MemoryStateScope = {
  chatJid: 'tg:fixture',
  identityId: 'fixture-user',
  tenantId: 'fixture-tenant',
};
const now = '2026-11-03T18:00:00.000Z';
const opts = { now };
const direct = (
  minute = 1,
  extra: Partial<MemoryStateSource> = {},
): MemoryStateSource => ({
  kind: 'direct_user',
  at: `2026-11-03T17:${String(minute).padStart(2, '0')}:00.000Z`,
  messageId: String(minute),
  quote: `Fixture direct source ${minute}`,
  currentDirectInput: true,
  ...extra,
});
const report = (minute = 1): MemoryStateSource => ({
  kind: 'assistant_report',
  at: direct(minute).at,
});
const card = (
  status: MemoryProjectCard['status'] = 'active',
): MemoryProjectCard => ({
  title: 'Fixture project',
  goal: 'Prepare the agreed package',
  status,
  pending: ['Review package'],
  completed: [],
  waiting: null,
  artifacts: [],
});
const fact = (
  value: string,
  revision = 0,
  extra: Partial<Extract<MemoryStateOperation, { kind: 'fact_upsert' }>> = {},
): MemoryStateOperation => ({
  kind: 'fact_upsert',
  operationId: `fact-${revision}-${value.replace(/\W/g, '').slice(0, 30)}`,
  expectedRevision: revision,
  projectKey: null,
  key: 'company',
  value,
  ...extra,
});
function errorCode(fn: () => unknown, code: string, revision?: number) {
  try {
    fn();
    throw new Error('Expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryStateError);
    expect((error as MemoryStateError).code).toBe(code);
    if (revision !== undefined)
      expect((error as MemoryStateError).currentRevision).toBe(revision);
  }
}
describe('durable scoped memory state', () => {
  let root: string, db: Database.Database, dbPath: string;
  const put = (op: MemoryStateOperation, source = direct(), s = scope) =>
    mutateMemoryState(db, s, op, source, opts);
  const read = (s = scope) => listMemoryState(db, s, opts);
  const project = (
    projectKey: string,
    status: MemoryProjectCard['status'] = 'active',
    source = direct(),
  ) =>
    put(
      {
        kind: 'project_upsert',
        projectKey,
        card: card(status),
        operationId: `create-${projectKey}`,
        expectedRevision: 0,
      },
      source,
    );
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-state-'));
    dbPath = path.join(root, 'state.sqlite');
    db = new Database(dbPath);
    ensureMemoryStateSchema(db);
  });
  afterEach(() => {
    if (db.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('makes A→B the only current decision while retaining the previous version as history', () => {
    put(fact('Company A', 0, { factType: 'decision' }));
    const result = put(
      fact('Company B', 1, { factType: 'decision' }),
      direct(2),
    );
    expect(result.revision).toBe(2);
    expect(read().facts.map((item) => item.value)).toEqual(['Company B']);
    const history = db
      .prepare('SELECT body_json FROM memory_state_versions ORDER BY revision')
      .all() as { body_json: string }[];
    expect(history.map((row) => JSON.parse(row.body_json).value)).toEqual([
      'Company A',
      'Company B',
    ]);
    expect(read().facts[0].source).toMatchObject({
      sourceReferenceTrust: 'verified_quote',
      contentTrust: 'agent_interpreted',
    });
    expect(read().facts[0].evidence).toBe('reported_not_verified');
  });

  it('survives a real close/reopen and does not reapply the same operation', () => {
    const op = fact('Persisted');
    put(op);
    db.close();
    db = new Database(dbPath);
    ensureMemoryStateSchema(db);
    expect(read().facts[0].value).toBe('Persisted');
    expect(put(op)).toMatchObject({ revision: 1, replayed: true });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM memory_state_versions').get(),
    ).toEqual({ n: 1 });
    errorCode(
      () => put({ ...op, value: 'Changed' } as MemoryStateOperation),
      'idempotency_conflict',
    );
  });

  it('rejects a concurrent stale edit from a second SQLite connection', () => {
    put(fact('A'));
    const other = new Database(dbPath);
    try {
      const staleRevision = listMemoryState(other, scope, opts).facts[0]
        .revision;
      put(fact('B', 1), direct(2));
      errorCode(
        () =>
          mutateMemoryState(
            other,
            scope,
            fact('C', staleRevision),
            direct(3),
            opts,
          ),
        'revision_conflict',
        2,
      );
      expect(read().facts[0].value).toBe('B');
    } finally {
      other.close();
    }
  });

  it('replays the same request after host authorization context changes without refocusing or reviving', () => {
    const create: MemoryStateOperation = {
      kind: 'project_upsert',
      projectKey: 'alpha',
      card: card(),
      expectedRevision: 0,
      operationId: 'original-project',
    };
    put(create, direct(1));
    project('beta', 'active', direct(2));
    put(
      {
        kind: 'project_upsert',
        projectKey: 'alpha',
        card: { ...card(), completed: ['Reported progress'] },
        expectedRevision: 1,
        operationId: 'progress-later',
      },
      report(3),
    );
    const replay = put(create, direct(1, { currentDirectInput: false }));
    expect(replay).toMatchObject({
      revision: 1,
      replayed: true,
      record: { revision: 2, card: { completed: ['Reported progress'] } },
    });
    expect(read().focusedProjectKey).toBe('beta');
    const forget: MemoryStateOperation = {
      kind: 'forget',
      target: 'project',
      projectKey: 'alpha',
      expectedRevision: 2,
      operationId: 'forget-original',
    };
    put(forget, direct(4, { explicitForget: true }));
    expect(put(create, direct(1, { currentDirectInput: false }))).toMatchObject(
      { record: null, revision: 1, replayed: true },
    );
    expect(
      put(
        forget,
        direct(4, { currentDirectInput: false, explicitForget: false }),
      ),
    ).toMatchObject({ record: null, revision: 3, replayed: true });
    expect(read().focusedProjectKey).toBe('beta');
    expect(getMemoryProject(db, scope, 'alpha', opts)).toBeNull();
    errorCode(
      () =>
        put(
          {
            ...forget,
            operationId: 'new-unapproved-forget',
            expectedRevision: 3,
          },
          direct(5, { currentDirectInput: false }),
        ),
      'explicit_forget_required',
      3,
    );
  });

  it('rejects older direct decisions, including same-timestamp lower message IDs, and assistant replacement', () => {
    put(fact('Current'), direct(4, { messageId: '40' }));
    errorCode(() => put(fact('Old', 1), direct(3)), 'stale_source', 1);
    errorCode(
      () => put(fact('Old sibling', 1), direct(4, { messageId: '39' })),
      'stale_source',
      1,
    );
    errorCode(
      () => put(fact('Assistant guess', 1), report(5)),
      'direct_fact_priority',
      1,
    );
    expect(read().facts[0].value).toBe('Current');
  });

  it('keeps identical keys separate across host scopes and project namespaces', () => {
    project('alpha');
    project('beta');
    put(fact('Global'));
    put(fact('Alpha', 0, { projectKey: 'alpha' }));
    put(fact('Beta', 0, { projectKey: 'beta' }));
    const other = { ...scope, identityId: 'another-user' };
    put(fact('Other identity'), direct(), other);
    expect(
      getMemoryProject(db, scope, 'alpha', opts)?.facts.map((f) => f.value),
    ).toEqual(['Alpha']);
    expect(
      listMemoryState(db, scope, { ...opts, projectKey: null }).facts.map(
        (f) => f.value,
      ),
    ).toEqual(['Global']);
    expect(read(other).facts.map((f) => f.value)).toEqual(['Other identity']);
    expect(read({ ...scope, chatJid: 'tg:other' }).facts).toEqual([]);
    expect(read({ ...scope, tenantId: 'other-tenant' }).facts).toEqual([]);
  });

  it('excludes expired fact content and source quotes while exposing only revision metadata for management', () => {
    const operation = fact('Expired private value', 0, { validUntil: now });
    expect(
      put(operation, direct(1, { quote: 'Expired source quote' })).record,
    ).toBeNull();
    expect(
      put(operation, direct(1, { quote: 'Expired source quote' })).record,
    ).toBeNull();
    const listing = read();
    expect(listing.facts).toEqual([]);
    expect(listing.expired).toEqual([
      { projectKey: null, key: 'company', revision: 1, validUntil: now },
    ]);
    expect(JSON.stringify(listing)).not.toContain('Expired');
    expect(
      listMemoryState(db, scope, { now: '2026-11-03T17:59:59.999Z' }).facts,
    ).toHaveLength(1);
  });

  it.each(['completed', 'cancelled'] as const)(
    'never silently reactivates a %s project',
    (status) => {
      project('alpha', status);
      errorCode(
        () =>
          put(
            {
              kind: 'project_upsert',
              projectKey: 'alpha',
              card: card('active'),
              operationId: 'silent',
              expectedRevision: 1,
            },
            direct(2),
          ),
        'activation_required',
        1,
      );
      const activate: MemoryStateOperation = {
        kind: 'project_activate',
        projectKey: 'alpha',
        operationId: 'activate',
        expectedRevision: 1,
      };
      errorCode(
        () => put(activate, report(2)),
        'explicit_activation_required',
        1,
      );
      errorCode(
        () => put(activate, direct(2)),
        'explicit_activation_required',
        1,
      );
      const result = put(activate, direct(2, { explicitActivate: true }));
      expect(result.record).toMatchObject({
        kind: 'project',
        card: { status: 'active' },
        evidence: 'reported_not_verified',
      });
      expect(
        getMemoryProject(db, scope, 'alpha', opts)?.project.card.status,
      ).toBe('active');
    },
  );

  it('allows reported progress but protects the directly sourced goal and its source age', () => {
    project('alpha', 'active', direct(5));
    const completed = {
      ...card('completed'),
      completed: ['Package prepared'],
      artifacts: [{ path: 'fixture.zip', state: 'delivered' as const }],
    };
    put(
      {
        kind: 'project_upsert',
        projectKey: 'alpha',
        card: completed,
        expectedRevision: 1,
        operationId: 'progress',
      },
      report(6),
    );
    const record = getMemoryProject(db, scope, 'alpha', opts)!.project;
    expect(record.card.artifacts[0].state).toBe('delivered');
    expect(record.source.sourceReferenceTrust).toBe('agent_reported');
    expect(record.evidence).toBe('reported_not_verified');
    errorCode(
      () =>
        put(
          {
            kind: 'project_upsert',
            projectKey: 'alpha',
            card: { ...completed, goal: 'Invented goal' },
            expectedRevision: 2,
            operationId: 'drift',
          },
          report(7),
        ),
      'direct_goal_priority',
      2,
    );
    errorCode(
      () =>
        put(
          {
            kind: 'project_activate',
            projectKey: 'alpha',
            expectedRevision: 2,
            operationId: 'old-activate',
          },
          direct(4, { explicitActivate: true }),
        ),
      'stale_source',
      2,
    );
  });

  it('forgets exact content and quotes from every version without leaking them through replay', () => {
    const original = fact('PRIVATE-VALUE-ONE');
    put(original, direct(1, { quote: 'PRIVATE-QUOTE-ONE' }));
    put(
      fact('PRIVATE-VALUE-TWO', 1),
      direct(2, { quote: 'PRIVATE-QUOTE-TWO' }),
    );
    const forget: MemoryStateOperation = {
      kind: 'forget',
      target: 'fact',
      projectKey: null,
      key: 'company',
      expectedRevision: 2,
      operationId: 'forget',
    };
    errorCode(() => put(forget, direct(3)), 'explicit_forget_required', 2);
    put(
      forget,
      direct(3, { explicitForget: true, quote: 'FORGET-QUOTE-PRIVATE' }),
    );
    expect(read().facts).toEqual([]);
    expect(read().hasTombstones).toBe(true);
    expect(read().tombstones[0]).toMatchObject({ key: 'company', revision: 3 });
    for (const table of [
      'memory_state_records',
      'memory_state_versions',
      'memory_state_tombstones',
      'memory_state_operations',
    ]) {
      const stored = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
      expect(stored).not.toContain('PRIVATE');
    }
    expect(
      put(original, direct(1, { quote: 'PRIVATE-QUOTE-ONE' })),
    ).toMatchObject({ record: null, revision: 1, replayed: true });
    expect(read().facts).toEqual([]);
  });

  it('requires a newer explicit direct remember to recreate a forgotten key', () => {
    put(fact('Before'));
    put(
      {
        kind: 'forget',
        target: 'fact',
        projectKey: null,
        key: 'company',
        expectedRevision: 1,
        operationId: 'forget',
      },
      direct(2, { explicitForget: true }),
    );
    const recreate = fact('After', 2);
    errorCode(() => put(recreate, report(3)), 'forgotten', 2);
    errorCode(() => put(recreate, direct(3)), 'forgotten', 2);
    errorCode(
      () => put(recreate, direct(2, { explicitRemember: true })),
      'forgotten',
      2,
    );
    put(recreate, direct(3, { explicitRemember: true }));
    expect(read().facts[0].value).toBe('After');
    expect(read().hasTombstones).toBe(true); // Prevent legacy memory resurrection.
    const history = JSON.stringify(
      db.prepare('SELECT * FROM memory_state_versions').all(),
    );
    expect(history).not.toContain('Before');
  });

  it('project forgetting purges its facts only, and prevents absent forgotten keys from silently appearing', () => {
    project('alpha');
    project('beta');
    put(fact('Global'));
    put(fact('Alpha', 0, { projectKey: 'alpha' }));
    put(fact('Beta', 0, { projectKey: 'beta' }));
    put(
      {
        kind: 'forget',
        target: 'project',
        projectKey: 'alpha',
        expectedRevision: 1,
        operationId: 'forget-alpha',
      },
      direct(2, { explicitForget: true }),
    );
    expect(getMemoryProject(db, scope, 'alpha', opts)).toBeNull();
    expect(
      read()
        .facts.map((f) => f.value)
        .sort(),
    ).toEqual(['Beta', 'Global']);
    expect(read().tombstones).toHaveLength(2);
    put(
      {
        kind: 'forget',
        target: 'fact',
        projectKey: null,
        key: 'absent',
        expectedRevision: 0,
        operationId: 'forget-absent',
      },
      direct(3, { explicitForget: true }),
    );
    errorCode(
      () => put(fact('Unsolicited', 1, { key: 'absent' }), report(4)),
      'forgotten',
      1,
    );
  });

  it('makes a cascading forget atomic when any child has a newer direct source', () => {
    project('alpha');
    put(fact('Recent', 0, { projectKey: 'alpha' }), direct(5));
    errorCode(
      () =>
        put(
          {
            kind: 'forget',
            target: 'project',
            projectKey: 'alpha',
            expectedRevision: 1,
            operationId: 'stale-forget',
          },
          direct(4, { explicitForget: true }),
        ),
      'stale_source',
      1,
    );
    expect(getMemoryProject(db, scope, 'alpha', opts)?.facts[0].value).toBe(
      'Recent',
    );
    expect(read().tombstones).toEqual([]);
  });

  it('rolls back a mutation if the historical version cannot be persisted', () => {
    db.exec(
      "CREATE TRIGGER fail_version BEFORE INSERT ON memory_state_versions BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
    );
    expect(() => put(fact('Uncommitted'))).toThrow('fixture failure');
    expect(read().facts).toEqual([]);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM memory_state_operations').get(),
    ).toEqual({ n: 0 });
  });

  it('bounds input, rejects malformed keys and dates, and treats permission notes only as interpreted memory', () => {
    errorCode(() => put(fact('x'.repeat(4001))), 'invalid_input');
    errorCode(() => put(fact('Value', 0, { key: '../escape' })), 'invalid_key');
    errorCode(
      () => put(fact('Value', 0, { validUntil: 'tomorrow' })),
      'invalid_date',
    );
    errorCode(
      () => put(fact('Value'), direct(1, { at: '2027-01-01T00:00:00.000Z' })),
      'future_source',
    );
    put(fact('Reported prior permission', 0, { factType: 'permission_note' }));
    expect(read().facts[0]).toMatchObject({
      factType: 'permission_note',
      evidence: 'reported_not_verified',
      source: { contentTrust: 'agent_interpreted' },
    });
    expect(read().facts[0]).not.toHaveProperty('authorization');
  });

  it('focuses an existing working card after a current direct correction, without background or historical focus changes', () => {
    project('alpha', 'active', direct(1));
    project('beta', 'active', direct(2));
    expect(read().focusedProjectKey).toBe('beta');
    put(
      {
        kind: 'project_upsert',
        projectKey: 'alpha',
        card: {
          ...card('waiting'),
          waiting: 'Use the latest corrected condition',
        },
        expectedRevision: 1,
        operationId: 'current-alpha-correction',
      },
      direct(3),
    );
    expect(read().focusedProjectKey).toBe('alpha');
    put(
      {
        kind: 'project_upsert',
        projectKey: 'beta',
        card: { ...card(), completed: ['Background result'] },
        expectedRevision: 1,
        operationId: 'background-beta',
      },
      report(4),
    );
    expect(read().focusedProjectKey).toBe('alpha');
    put(
      {
        kind: 'project_upsert',
        projectKey: 'beta',
        card: card(),
        expectedRevision: 2,
        operationId: 'historical-beta',
      },
      direct(5, { currentDirectInput: false }),
    );
    expect(read().focusedProjectKey).toBe('alpha');
    // Current-source marking cannot bypass ordering of the scope's focus.
    put(
      {
        kind: 'project_upsert',
        projectKey: 'alpha',
        card: card(),
        expectedRevision: 2,
        operationId: 'newer-alpha',
      },
      direct(7),
    );
    put(
      {
        kind: 'project_upsert',
        projectKey: 'beta',
        card: card(),
        expectedRevision: 3,
        operationId: 'late-beta',
      },
      direct(6),
    );
    expect(read().focusedProjectKey).toBe('alpha');
  });

  it('keeps direct focus separate from background progress and clears it without selecting an old active project', () => {
    project('historical', 'active', direct(1, { currentDirectInput: false }));
    expect(read().focusedProjectKey).toBeNull();
    project('alpha', 'active', direct(1));
    project('beta', 'active', direct(2));
    expect(read().focusedProjectKey).toBe('beta');
    put(
      {
        kind: 'project_upsert',
        projectKey: 'alpha',
        card: { ...card(), completed: ['Background check complete'] },
        expectedRevision: 1,
        operationId: 'background-alpha',
      },
      report(3),
    );
    expect(read().focusedProjectKey).toBe('beta');
    project('old-import', 'active', direct(1));
    expect(read().focusedProjectKey).toBe('beta');
    put(
      {
        kind: 'project_upsert',
        projectKey: 'beta',
        card: card('completed'),
        expectedRevision: 1,
        operationId: 'finish-beta',
      },
      report(4),
    );
    expect(read().focusedProjectKey).toBeNull();
    expect(
      getMemoryProject(db, scope, 'alpha', opts)?.project.card.status,
    ).toBe('active');
    put(
      {
        kind: 'project_activate',
        projectKey: 'alpha',
        expectedRevision: 2,
        operationId: 'resume-alpha',
      },
      direct(5, { explicitActivate: true }),
    );
    expect(read().focusedProjectKey).toBe('alpha');
    put(
      {
        kind: 'forget',
        target: 'project',
        projectKey: 'alpha',
        expectedRevision: 3,
        operationId: 'forget-focus',
      },
      direct(6, { explicitForget: true }),
    );
    expect(read().focusedProjectKey).toBeNull();
  });

  it('does not crowd cards or a valid fact out with many more recent expired facts', () => {
    project('alpha');
    put(fact('Keep current', 0, { key: 'zz-current' }));
    for (let i = 0; i < 205; i++)
      put(
        fact(`Expired ${i}`, 0, {
          key: `expired-${i}`,
          operationId: `expiry-${i}`,
          validUntil: now,
        }),
        direct(2),
      );
    expect(read().projects.map((p) => p.projectKey)).toEqual(['alpha']);
    expect(read().facts.map((f) => f.value)).toEqual(['Keep current']);
    expect(read().expired).toHaveLength(100);
    expect(getMemoryProject(db, scope, 'alpha', opts)?.project.card.title).toBe(
      'Fixture project',
    );
  });

  it('rejects credential values, quotes and artifacts without persisting a partial record', () => {
    errorCode(
      () => put(fact('password=fixture-sensitive')),
      'credential_content',
    );
    errorCode(
      () =>
        put(
          fact('Benign fact'),
          direct(1, { quote: 'api_key=fixture-sensitive' }),
        ),
      'credential_content',
    );
    errorCode(
      () =>
        put({
          kind: 'project_upsert',
          projectKey: 'alpha',
          card: {
            ...card(),
            artifacts: [
              {
                path: 'file.txt',
                state: 'created',
                note: 'пароль: fixture-sensitive',
              },
            ],
          },
          expectedRevision: 0,
          operationId: 'credential-card',
        }),
      'credential_content',
    );
    expect(read().projects).toEqual([]);
    expect(read().facts).toEqual([]);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM memory_state_operations').get(),
    ).toEqual({ n: 0 });
  });
});
