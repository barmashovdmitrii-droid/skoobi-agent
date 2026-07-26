import { describe, expect, it } from 'vitest';

import {
  createAssistantMentionPattern,
  createAssistantTriggerPattern,
  DEFAULT_ASSISTANT_NAME,
  normalizeAssistantName,
} from './assistant-name.js';

describe('normalizeAssistantName', () => {
  it('trims and NFC-normalizes valid Unicode letters and numbers', () => {
    expect(normalizeAssistantName('  Skoobi_2-Я  ')).toBe('Skoobi_2-Я');
    expect(normalizeAssistantName('  A\u0301gent  ')).toBe('Ágent');
  });

  it('accepts one through 64 Unicode code points', () => {
    expect(normalizeAssistantName('Б')).toBe('Б');
    expect(normalizeAssistantName('𐐀'.repeat(64))).toBe('𐐀'.repeat(64));
  });

  it.each([
    undefined,
    null,
    '',
    '   ',
    'Skoobi bot',
    'Skoobi.bot',
    'Skoobi/../../x',
    'a'.repeat(65),
    'A\u0301\u0301',
  ])('fails closed for invalid input %#', (value) => {
    expect(normalizeAssistantName(value)).toBe(DEFAULT_ASSISTANT_NAME);
  });
});

describe('assistant address patterns', () => {
  it('uses a Unicode-safe end boundary instead of an ASCII word boundary', () => {
    const trigger = createAssistantTriggerPattern('Бот');

    expect(trigger.test('@Бот привет')).toBe(true);
    expect(trigger.test('@БОТ: привет')).toBe(true);
    expect(trigger.test('@Ботик привет')).toBe(false);
    expect(trigger.test('@Бот\u0301 привет')).toBe(false);
    expect(trigger.test('текст @Бот')).toBe(false);
  });

  it('escapes the normalized value and fails closed on regex syntax', () => {
    const trigger = createAssistantTriggerPattern('Skoobi|.*');

    expect(trigger.test('@Skoobi ok')).toBe(true);
    expect(trigger.test('@anything')).toBe(false);
  });

  it('matches complete mentions globally without accepting name prefixes', () => {
    const text =
      '@Skoobi один @skoobi, owner@Skoobi.example @@Skoobi x-@Skoobi @Skoobi2';

    expect(text.match(createAssistantMentionPattern('Skoobi'))).toEqual([
      '@Skoobi',
      '@skoobi',
    ]);
  });

  it.each([
    'A@Skoobi',
    '1@Skoobi',
    '_@Skoobi',
    '-@Skoobi',
    '@@Skoobi',
    '\u0301@Skoobi',
  ])('requires a Unicode-safe left boundary for %s', (text) => {
    expect(text.match(createAssistantMentionPattern('Skoobi'))).toBeNull();
  });
});
