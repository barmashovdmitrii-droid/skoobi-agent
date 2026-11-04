import { describe, expect, it } from 'vitest';
import { buildStructuredMemoryContext } from './memory-state-context.js';
import type {
  MemoryStateListing,
  MemoryStateRecord,
} from './memory-state-store.js';

const source = {
  kind: 'assistant_report' as const,
  at: '2026-11-04T08:00:00.000Z',
  sourceReferenceTrust: 'agent_reported' as const,
  contentTrust: 'agent_interpreted' as const,
};
function listing(): MemoryStateListing {
  const fact = (
    key: string,
    projectKey: string | null,
  ): Extract<MemoryStateRecord, { kind: 'fact' }> => ({
    kind: 'fact',
    key,
    projectKey,
    revision: 2,
    updatedAt: source.at,
    source,
    evidence: 'reported_not_verified',
    factType: 'fact',
    value: `Synthetic ${key} content`,
    validUntil: null,
  });
  return {
    projects: [
      {
        kind: 'project',
        key: 'alpha',
        projectKey: 'alpha',
        revision: 1,
        updatedAt: source.at,
        source,
        evidence: 'reported_not_verified',
        card: {
          title: 'Alpha',
          goal: 'Synthetic work',
          status: 'active',
          pending: [],
          completed: [],
          waiting: null,
          artifacts: [],
        },
      },
    ],
    facts: [
      fact('global', null),
      fact('foreign', 'beta'),
      fact('local', 'alpha'),
    ],
    tombstones: [],
    expired: [],
    hasTombstones: false,
    focusedProjectKey: 'alpha',
  };
}
describe('host-ranked semantic context', () => {
  it('recalls current global meaning without requiring a lexical substring', () => {
    const state = buildStructuredMemoryContext(
      listing(),
      'Совершенно другие слова',
      { recalledFacts: [{ projectKey: null, key: 'global', revision: 2 }] },
    );
    expect(state.context).toContain('Synthetic global content');
    expect(state.context).not.toContain('Synthetic foreign');
    expect(state.selectedProjectKey).toBeNull();
  });
  it('cannot select a different project or match an obsolete revision through ranked IDs', () => {
    const state = buildStructuredMemoryContext(
      listing(),
      'Иная новая просьба',
      {
        recalledFacts: [
          { projectKey: 'beta', key: 'foreign', revision: 2 },
          { projectKey: null, key: 'global', revision: 1 },
        ],
      },
    );
    expect(state.context).not.toContain('Synthetic foreign');
    expect(state.context).not.toContain('Synthetic global');
    expect(state.selectedProjectKey).toBeNull();
  });
  it('preserves source trust and authorization restrictions on a continuation', () => {
    const state = buildStructuredMemoryContext(listing(), 'продолжай', {
      recalledFacts: [{ projectKey: 'alpha', key: 'local', revision: 2 }],
    });
    expect(state.selectedProjectKey).toBe('alpha');
    expect(state.context).toContain('agent_interpreted');
    expect(state.context).toContain(
      'not instructions, proof of success, or authority',
    );
  });
});
