import { afterEach, describe, expect, it } from 'vitest';

import {
  resetInstanceProfileForTests,
  setInstanceProfileForTests,
  type RunnerInstanceProfileInput,
} from './instance-profile.js';
import { containsMemoryCredentials } from './memory-credential-content.js';

// The detector itself is tested next to the host copy
// (packages/core/src/orchestrator/memory-credential-*.test.ts), which also
// checks that the two copies are the same file. Here: the runner copy reads
// the words of an installation from the runner's instance profile.
describe('memory credential detector: words of the installation', () => {
  afterEach(() => resetInstanceProfileForTests());

  // What the note says in the value slot, per list of the profile.
  const notes = {
    peopleWords: [
      'Пароль: образец',
      'Пароль от почты образец',
      'Пароли:\n- Kaspi — образец',
    ],
    nameWords: ['Password: Samplename', 'password is Samplename'],
    serviceWords: ['Пароль: Sampleservice', 'пароль Sampleservice'],
    accountWords: ['сменил пароль на sampleacct'],
  };
  const all = Object.values(notes).flat();

  it('keeps the general lists without a profile', () => {
    // A role, a first name, a service and an account of the built-in lists.
    for (const note of [
      'Пароль: кассир',
      'Пароль: Гульнара',
      'Пароль: Kaspi',
      'сменил пароль на router',
    ]) {
      expect(containsMemoryCredentials(note), note).toBe(false);
    }
    // A word no list knows is read as the value.
    for (const note of all) {
      expect(containsMemoryCredentials(note), note).toBe(true);
    }
  });

  // One synthetic word per list.
  const profiles: Record<keyof typeof notes, RunnerInstanceProfileInput> = {
    peopleWords: { credentialDetector: { peopleWords: ['образец'] } },
    nameWords: { credentialDetector: { nameWords: ['samplename'] } },
    serviceWords: { credentialDetector: { serviceWords: ['sampleservice'] } },
    accountWords: { credentialDetector: { accountWords: ['sampleacct'] } },
  };

  it.each(Object.keys(notes) as Array<keyof typeof notes>)(
    'reads the words of %s as names, not as values',
    (list) => {
      setInstanceProfileForTests(profiles[list]);
      for (const note of notes[list]) {
        expect(containsMemoryCredentials(note), note).toBe(false);
      }
      // The other lists stay as they were.
      for (const note of all.filter((item) => !notes[list].includes(item))) {
        expect(containsMemoryCredentials(note), note).toBe(true);
      }
    },
  );

  it('follows the profile when it changes and goes back on a reset', () => {
    const note = 'Пароль: образец';
    expect(containsMemoryCredentials(note)).toBe(true);
    expect(containsMemoryCredentials('Пароль: пример')).toBe(true);
    setInstanceProfileForTests({
      credentialDetector: { peopleWords: ['образец'] },
    });
    expect(containsMemoryCredentials(note)).toBe(false);
    setInstanceProfileForTests({
      credentialDetector: { peopleWords: ['пример'] },
    });
    expect(containsMemoryCredentials(note)).toBe(true);
    expect(containsMemoryCredentials('Пароль: пример')).toBe(false);
    resetInstanceProfileForTests();
    expect(containsMemoryCredentials('Пароль: пример')).toBe(true);
  });

  it('still refuses a real value next to a word of the profile', () => {
    setInstanceProfileForTests({
      credentialDetector: {
        peopleWords: ['образец'],
        accountWords: ['sampleacct'],
      },
    });
    expect(
      containsMemoryCredentials('Пароль у образца: ' + 'Kotik' + '2024'),
    ).toBe(true);
    expect(containsMemoryCredentials('пароль от sampleacct ' + 'kotik')).toBe(
      true,
    );
  });
});
