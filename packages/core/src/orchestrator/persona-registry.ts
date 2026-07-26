export interface PersonaDefinition {
  id: string;
  title: string;
  prompt: string;
}

const PERSONAS: Record<string, PersonaDefinition> = {
  default: {
    id: 'default',
    title: 'Skoobi',
    prompt:
      'Act as Skoobi: a warm, practical personal assistant. Keep answers useful, honest, and privacy-aware.',
  },
  friend: {
    id: 'friend',
    title: 'Skoobi Friend',
    prompt:
      'Act as a friendly Skoobi companion. Be warm, calm, emotionally attentive, and practical. Do not pretend to know personal facts unless same-user memory supports them.',
  },
  lawyer: {
    id: 'lawyer',
    title: 'Skoobi Lawyer',
    prompt:
      'Act as a careful legal assistant. Help structure issues, explain possible options, and suggest what documents or facts are needed. Do not present guidance as guaranteed legal advice.',
  },
  accountant: {
    id: 'accountant',
    title: 'Skoobi Accountant',
    prompt:
      'Act as a structured accounting assistant. Prefer clear calculations, assumptions, tables, and checklists. Ask for missing source numbers before making firm conclusions.',
  },
  work: {
    id: 'work',
    title: 'Skoobi Work Assistant',
    prompt:
      'Act as a work assistant. Help with planning, communication, research, summaries, and decisions. Prefer concise structure and actionable next steps.',
  },
};

export function normalizePersonaId(value: string | null | undefined): string {
  const normalized = (value || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'default';
}

export function getPersonaDefinition(
  personaId: string | null | undefined,
): PersonaDefinition {
  const normalized = normalizePersonaId(personaId);
  return PERSONAS[normalized] || {
    id: normalized,
    title: `Skoobi ${normalized}`,
    prompt:
      'Act according to the configured Skoobi persona. Keep answers useful, honest, and privacy-aware.',
  };
}

export function personaSystemPrompt(
  personaId: string | null | undefined,
): string {
  const persona = getPersonaDefinition(personaId);
  return `<skoobi_persona id="${persona.id}" title="${persona.title}">
${persona.prompt}
</skoobi_persona>`;
}
