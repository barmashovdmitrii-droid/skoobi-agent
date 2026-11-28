import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import {
  ensureMemoryStateSchema,
  mutateMemoryState,
  getMemoryProject,
  type MemoryProjectCard,
} from './memory-state-store.js';
import {
  parseMemoryWorkCheckpoint,
  type MemoryWorkCheckpoint,
} from './memory-work-checkpoint.js';
const now = '2026-11-05T12:00:00.000Z';
const scope = {
  chatJid: 'fixture',
  identityId: 'fixture',
  tenantId: 'fixture',
};
const work = (requirementsRevision = 1): MemoryWorkCheckpoint => ({
  target: 'Fixture laptop / game',
  executor: 'fixture-worker',
  requirementsRevision,
  nextStep: null,
  criteria: [
    {
      key: 'player_path',
      description: 'Player can reach the lift without a long detour',
      state: 'passed',
      checkedRevision: 1,
      evidence: 'fixture-artifact-hash / replay report',
    },
  ],
});
const card = (
  w = work(),
  status: MemoryProjectCard['status'] = 'active',
): MemoryProjectCard => ({
  title: 'Fixture',
  goal: 'Remove unnecessary walking',
  status,
  pending: [],
  completed: [],
  waiting: null,
  artifacts: [],
  work: w,
});
describe('project acceptance checkpoint', () => {
  it('invalidates prior acceptance after a correction and does not accept invented future checks', () => {
    expect(parseMemoryWorkCheckpoint(work(2)).criteria[0].state).toBe(
      'pending',
    );
    expect(() =>
      parseMemoryWorkCheckpoint({
        ...work(),
        criteria: [{ ...work().criteria[0], checkedRevision: 2 }],
      }),
    ).toThrow();
    expect(() =>
      parseMemoryWorkCheckpoint({
        ...work(),
        criteria: [{ ...work().criteria[0], evidence: undefined }],
      }),
    ).toThrow();
  });
  it('persists resume context and refuses completion with stale criteria or changed requirements without a revision', () => {
    const db = new Database(':memory:');
    ensureMemoryStateSchema(db);
    const put = (c: MemoryProjectCard, revision: number) =>
      mutateMemoryState(
        db,
        scope,
        {
          kind: 'project_upsert',
          projectKey: 'fixture',
          card: c,
          expectedRevision: revision,
          operationId: `checkpoint-${revision}-${c.status}`,
        },
        { kind: 'assistant_report', at: now },
        { now },
      );
    try {
      put(card(), 0);
      const changed = { ...work(), target: 'Different computer' };
      expect(() => put(card(changed), 1)).toThrow(
        'work_requirements_revision_required',
      );
      expect(() => put(card(work(2), 'completed'), 1)).toThrow(
        'work_acceptance_incomplete',
      );
      put(card({ ...work(2), nextStep: 'Replay the corrected route' }), 1);
      const saved = getMemoryProject(db, scope, 'fixture', { now })!.project;
      expect(saved?.card.work?.requirementsRevision).toBe(2);
      expect(saved?.card.work?.criteria[0].state).toBe('pending');
      expect(saved?.card.work?.target).toBe('Fixture laptop / game');
      expect(() => put({ ...card(), work: undefined }, 2)).toThrow(
        'work_checkpoint_revision_required',
      );
    } finally {
      db.close();
    }
  });
  it('applies the card credential check to the new checkpoint fields', () => {
    const db = new Database(':memory:');
    ensureMemoryStateSchema(db);
    const credential = ['password', 'fixture'].join(': ');
    try {
      const checkpoints = [
        { ...work(), waitingOn: credential },
        {
          ...work(),
          criteria: [{ ...work().criteria[0], evidence: credential }],
        },
      ];
      for (const checkpoint of checkpoints) {
        expect(() =>
          mutateMemoryState(
            db,
            scope,
            {
              kind: 'project_upsert',
              projectKey: 'fixture',
              card: card(checkpoint),
              expectedRevision: 0,
              operationId: 'test-checkpoint-credentials',
            },
            { kind: 'assistant_report', at: now },
            { now },
          ),
        ).toThrow('credential_content');
      }
      expect(
        getMemoryProject(db, scope, 'fixture', { now })?.project,
      ).toBeFalsy();
    } finally {
      db.close();
    }
  });
  it('keeps legacy cards usable and requires all current criteria for a new completion', () => {
    const db = new Database(':memory:');
    ensureMemoryStateSchema(db);
    try {
      const result = mutateMemoryState(
        db,
        scope,
        {
          kind: 'project_upsert',
          projectKey: 'fixture',
          card: card(work(), 'completed'),
          expectedRevision: 0,
          operationId: 'complete-fixture',
        },
        { kind: 'assistant_report', at: now },
        { now },
      );
      expect(result).toBeDefined();
      expect(
        getMemoryProject(db, scope, 'fixture', { now })!.project?.evidence,
      ).toBe('reported_not_verified');
    } finally {
      db.close();
    }
  });
});

it('keeps an earlier run from becoming a new acceptance across intervening edits', () => {
  const db = new Database(':memory:');
  ensureMemoryStateSchema(db);
  const save = (checkpoint: MemoryWorkCheckpoint, revision: number, id: string) =>
    mutateMemoryState(db, scope, {
      kind: 'project_upsert', projectKey: 'fixture', card: card(checkpoint),
      expectedRevision: revision, operationId: id,
    }, { kind: 'assistant_report', at: now }, { now });
  const revised = work(2);
  revised.criteria[0].description = 'The revised route supports two stops';
  const newEvidence = 'Fixture run B for the two-stop requirement';
  try {
    save(work(), 0, 'initial-pass');
    save(revised, 1, 'new-rules');
    const pending = structuredClone(revised);
    pending.criteria[0] = { key: 'player_path', description: revised.criteria[0].description, state: 'pending' };
    save(pending, 2, 'intermediate-observation');
    revised.criteria[0].checkedRevision = 2;
    revised.criteria[0].evidence = 'fixture-artifact-hash   /  replay report';
    const unchanged = db.serialize();
    expect(() => save(revised, 3, 'incorrectly-relabelled')).toThrow('work_evidence_revision_required');
    expect(db.serialize()).toEqual(unchanged);
    revised.criteria[0].evidence = newEvidence;
    expect(save(revised, 3, 'new-run').replayed).toBe(false);
    expect(save(revised, 3, 'new-run').replayed).toBe(true);
    expect(getMemoryProject(db, scope, 'fixture')?.project?.card.work?.criteria[0].state).toBe('passed');
  } finally { db.close(); }
});

it('remembers which run belonged to old requirements after the version window rolls over', () => {
  const db = new Database(':memory:');
  ensureMemoryStateSchema(db);
  const put = (checkpoint: MemoryWorkCheckpoint, rev: number) =>
    mutateMemoryState(db, scope, { kind: 'project_upsert', projectKey: 'fixture', card: card(checkpoint),
      expectedRevision: rev, operationId: 'retention-' + rev }, { kind: 'assistant_report', at: now }, {now});
  const pending = work(2);
  pending.criteria[0] = { key: 'player_path', description: 'Revised goal', state: 'pending' };
  try {
    put(work(1),0);
    for (let rev = 1; rev <= 55; rev++) put(pending,rev);
    const relabelled = structuredClone(pending);
    relabelled.criteria[0] = { ...relabelled.criteria[0], state:'passed', checkedRevision:2, evidence:work().criteria[0].evidence };
    expect(() => put(relabelled,56)).toThrow('work_evidence_revision_required');
    expect(getMemoryProject(db,scope,'fixture')?.project?.card.work?.criteria[0].state).toBe('pending');
  } finally { db.close(); }
});
