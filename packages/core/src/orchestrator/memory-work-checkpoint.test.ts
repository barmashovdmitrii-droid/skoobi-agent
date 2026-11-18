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
