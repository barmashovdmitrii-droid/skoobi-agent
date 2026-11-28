import { describe, expect, it } from 'vitest';

import {
  getPersonaDefinition,
  normalizePersonaId,
  personaSystemPrompt,
} from './persona-registry.js';

describe('persona registry', () => {
  it('normalizes persona ids for config and paths', () => {
    expect(normalizePersonaId('Skoobi Friend!')).toBe('skoobi_friend');
    expect(normalizePersonaId('')).toBe('default');
  });

  it('returns concise built-in persona instructions', () => {
    const lawyer = getPersonaDefinition('lawyer');

    expect(lawyer.title).toBe('Skoobi Lawyer');
    expect(lawyer.prompt).toContain('legal assistant');
    expect(personaSystemPrompt('friend')).toContain('id="friend"');
  });
});
