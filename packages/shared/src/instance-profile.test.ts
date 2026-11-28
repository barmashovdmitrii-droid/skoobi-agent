import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INSTANCE_PROFILE_ENV,
  NEUTRAL_INSTANCE_PROFILE as RUNNER_NEUTRAL_INSTANCE_PROFILE,
  adoptInstanceProfile,
  derivedFromInstanceProfile as runnerSideDerivedFromInstanceProfile,
  instanceProfile as runnerSideInstanceProfile,
  instanceProfileEnvValue,
  normalizeInstanceProfile as normalizeRunnerInstanceProfile,
  resetInstanceProfileForTests as resetRunnerInstanceProfileForTests,
} from '../../../agent/runner/src/instance-profile.js';
import {
  INSTANCE_PROFILE_FILE_ENV,
  NEUTRAL_INSTANCE_PROFILE,
  type InstanceProfileInput,
  type InstanceProfileProblems,
  derivedFromInstanceProfile,
  instanceProfile,
  instanceProfileCandidatePaths,
  instanceProfileNeedsAttention,
  instanceProfileStatus,
  loadInstanceProfile,
  normalizeInstanceProfile,
  resetInstanceProfileForTests,
  runnerInstanceProfile,
  setInstanceProfileForTests,
} from './instance-profile.js';
import { logger } from './logger.js';

// Synthetic values only: reserved example domains and the fixture ids, handles
// and names the public export scanner treats as test data.
const SYNTHETIC_PROFILE: InstanceProfileInput = {
  assistant: {
    defaultName: 'FixtureBot',
    notificationTitle: 'Fixture Bot',
    addressHandles: ['@fixture_bot'],
  },
  owner: {
    taskResultNameForms: ['Образца', 'Примера'],
    reminderLeadForms: ['образцу', 'образца'],
    workFolders: ['Desktop/fixture-work'],
    adminObjectStems: ['fixturebox', 'образец'],
  },
  telegram: {
    adminAlertJids: ['tg:100123'],
    adminContact: '@owner_fixture',
    guestPromptOwnerFolder: 'fixture_main',
  },
  google: { defaultCalendarId: 'calendar@example.com' },
  dashboard: {
    panelSenderName: 'Образец (панель)',
    restartableUnits: { extra: 'com.example.extra' },
    legacyCrmTopicFile: 'groups/fixture_main/memory/topics/crm.md',
  },
  launchd: {
    mainLabel: 'com.example.main',
    fallbackHome: '/Users/example/fixture-home',
    instanceDir: '{home}/fixture-instance',
    watchdogDir: '{home}/fixture-watchdog',
    units: [
      { id: 'main', name: 'Main', label: 'com.example.main', kind: 'daemon' },
      {
        id: 'sweep',
        name: 'Sweep',
        label: 'com.example.sweep',
        kind: 'periodic',
        periodSec: 3600,
        heartbeatLog: '{instance}/logs/sweep.log',
      },
    ],
  },
  voice: {
    edgeVoice: 'en-US-FixtureNeural',
    azureVoice: 'en-US-Fixture:HDLatestNeural',
    edgeProviderAliases: ['edge-fixture'],
  },
  memory: { curatorKeywords: ['fixtureword', 'образец'] },
  chatSecrets: { unitWords: ['образцов', 'fixtures'] },
  credentialDetector: {
    peopleWords: ['образец', 'образца', "sample's"],
    nameWords: ['fixturename'],
    serviceWords: ['fixturepay'],
    accountWords: ['fixturepay'],
  },
  prompts: {
    ownerName: 'Sample Owner',
    secretHolderExample: 'Образца',
    helperUnreachableHint: 'check that com.example.helper is loaded.',
    helperPermissionTarget: '/usr/local/bin/node',
    workTargetHint: 'Exact computer and project.',
    taskTitleExample: 'Слежка за сборкой образца',
  },
  retention: { reportChatId: 100123 },
  skillsSeed: {
    adminFolders: ['fixture_main', 'fixture_admin'],
    extraSkills: [
      {
        frontmatter: {
          name: 'fixture-skill',
          description: 'A synthetic seed skill.',
          triggers: ['fixture'],
          pinned: true,
        },
        body: '\n# Fixture Skill\n\n1. Do the fixture thing.\n',
        before: 'voice-response',
      },
    ],
  },
  skills: {
    selectionPatterns: [
      { nameIncludes: 'fixture', stems: ['fixtur', 'образц'], bonus: 9 },
    ],
  },
};

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-instance-profile-')),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function writeProfile(root: string, contents: string): string {
  const file = path.join(root, 'config', 'instance.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function problems(): InstanceProfileProblems {
  return { invalidKeys: [], unknownKeys: [] };
}

const INJECTED_PROFILE_KEY = Symbol.for(
  'skoobi.instance-profile.test-override',
);

/**
 * What production has: no injected profile, the loader reads its file. The
 * test setup injects an empty profile and a reset goes back to it, so the
 * tests of the file path remove it by hand.
 */
function withoutInjectedProfile(): void {
  resetInstanceProfileForTests();
  resetRunnerInstanceProfileForTests();
  delete (globalThis as Record<symbol, unknown>)[INJECTED_PROFILE_KEY];
}

afterEach(() => {
  vi.restoreAllMocks();
  resetInstanceProfileForTests();
  resetRunnerInstanceProfileForTests();
  delete process.env[INSTANCE_PROFILE_ENV];
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('normalizeInstanceProfile', () => {
  it('gives the neutral defaults for a missing or empty profile', () => {
    expect(normalizeInstanceProfile(undefined)).toEqual(
      NEUTRAL_INSTANCE_PROFILE,
    );
    expect(normalizeInstanceProfile({})).toEqual(NEUTRAL_INSTANCE_PROFILE);
  });

  it('keeps the neutral defaults equal to what the public line does', () => {
    expect(NEUTRAL_INSTANCE_PROFILE.google.defaultCalendarId).toBe('');
    expect(NEUTRAL_INSTANCE_PROFILE.telegram.adminAlertJids).toEqual([]);
    expect(NEUTRAL_INSTANCE_PROFILE.telegram.adminContact).toBe(
      'the bot owner',
    );
    expect(NEUTRAL_INSTANCE_PROFILE.telegram.guestPromptOwnerFolder).toBe(
      'owner_main',
    );
    expect(NEUTRAL_INSTANCE_PROFILE.assistant.defaultName).toBe('Skoobi');
    expect(NEUTRAL_INSTANCE_PROFILE.assistant.addressHandles).toEqual([]);
    expect(NEUTRAL_INSTANCE_PROFILE.owner.reminderLeadForms).toEqual([
      'владельцу',
      'владельца',
    ]);
    expect(NEUTRAL_INSTANCE_PROFILE.dashboard.panelSenderName).toBe(
      'Owner (dashboard)',
    );
    expect(NEUTRAL_INSTANCE_PROFILE.dashboard.restartableUnits).toEqual({});
    expect(NEUTRAL_INSTANCE_PROFILE.launchd.mainLabel).toBe(
      'com.skoobi.default',
    );
    expect(
      NEUTRAL_INSTANCE_PROFILE.launchd.units.map((unit) => unit.id),
    ).toEqual(['main', 'dashboard']);
    expect(NEUTRAL_INSTANCE_PROFILE.retention.reportChatId).toBeNull();
    expect(NEUTRAL_INSTANCE_PROFILE.skillsSeed).toEqual({
      adminFolders: ['telegram_main'],
      extraSkills: [],
    });
    expect(NEUTRAL_INSTANCE_PROFILE.owner.adminObjectStems).toEqual([]);
    expect(NEUTRAL_INSTANCE_PROFILE.skills).toEqual({ selectionPatterns: [] });
    expect(NEUTRAL_INSTANCE_PROFILE.credentialDetector).toEqual({
      peopleWords: [],
      nameWords: [],
      serviceWords: [],
      accountWords: [],
    });
  });

  it('takes every key of a full profile exactly as written', () => {
    const found = problems();
    const profile = normalizeInstanceProfile(SYNTHETIC_PROFILE, found);

    expect(profile).toEqual(SYNTHETIC_PROFILE);
    expect(found).toEqual({ invalidKeys: [], unknownKeys: [] });
  });

  it('fills keys that are absent with their neutral defaults', () => {
    const found = problems();
    const profile = normalizeInstanceProfile(
      { telegram: { adminContact: '@owner_fixture' } },
      found,
    );

    expect(profile.telegram).toEqual({
      ...NEUTRAL_INSTANCE_PROFILE.telegram,
      adminContact: '@owner_fixture',
    });
    expect(profile.google).toEqual(NEUTRAL_INSTANCE_PROFILE.google);
    expect(found).toEqual({ invalidKeys: [], unknownKeys: [] });
  });

  it('falls back per key when a value has the wrong type or shape', () => {
    const found = problems();
    const profile = normalizeInstanceProfile(
      {
        google: { defaultCalendarId: 'https://calendar.example/not an id' },
        telegram: {
          adminAlertJids: ['tg:100123', 42],
          adminContact: '@owner_fixture',
          guestPromptOwnerFolder: '../escape',
        },
        owner: {
          workFolders: ['/absolute'],
          reminderLeadForms: ['a|b'],
          adminObjectStems: ['stem\\w*'],
        },
        launchd: {
          units: [
            {
              id: 'one',
              name: 'One',
              label: 'com.example.one',
              kind: 'daemon',
            },
            {
              id: 'one',
              name: 'Twice',
              label: 'com.example.two',
              kind: 'daemon',
            },
          ],
          mainLabel: 'com.example.main; rm -rf',
        },
        dashboard: { restartableUnits: { main: 'com.example.main' } },
        retention: { reportChatId: '100123' },
        credentialDetector: { peopleWords: ['two words'] },
        prompts: {
          ownerName: 'line\nbreak',
          taskTitleExample: 'a "quoted" title',
        },
        skillsSeed: { extraSkills: [{ frontmatter: { name: 'x' }, body: '' }] },
        skills: {
          selectionPatterns: [
            { nameIncludes: 'fixture', stems: ['a(b'], bonus: 9 },
          ],
        },
        voice: {
          edgeVoice: 'two words',
          azureVoice: 'en-US-"Quoted"Neural',
          edgeProviderAliases: ['edge-fixture', 'azure'],
        },
        memory: 'not an object',
      },
      found,
    );

    expect(profile).toEqual({
      ...NEUTRAL_INSTANCE_PROFILE,
      telegram: {
        ...NEUTRAL_INSTANCE_PROFILE.telegram,
        adminContact: '@owner_fixture',
      },
    });
    expect(found.invalidKeys.sort()).toEqual(
      [
        'credentialDetector.peopleWords',
        'dashboard.restartableUnits',
        'google.defaultCalendarId',
        'launchd.mainLabel',
        'launchd.units',
        'memory',
        'owner.adminObjectStems',
        'owner.reminderLeadForms',
        'owner.workFolders',
        'prompts.ownerName',
        'prompts.taskTitleExample',
        'retention.reportChatId',
        'skills.selectionPatterns',
        'skillsSeed.extraSkills',
        'telegram.adminAlertJids',
        'telegram.guestPromptOwnerFolder',
        'voice.azureVoice',
        'voice.edgeProviderAliases',
        'voice.edgeVoice',
      ].sort(),
    );
  });

  it('checks the shape of a selection pattern and of a seed skill', () => {
    const pattern = { nameIncludes: 'fixture', stems: ['fixtur'], bonus: 9 };
    const skill = {
      frontmatter: { name: 'fixture-skill', description: 'Synthetic.' },
      body: '',
    };
    const accepts = (input: unknown): boolean => {
      const found = problems();
      normalizeInstanceProfile(input, found);
      return found.invalidKeys.length === 0 && found.unknownKeys.length === 0;
    };

    expect(accepts({ skills: { selectionPatterns: [pattern] } })).toBe(true);
    for (const broken of [
      { ...pattern, nameIncludes: 'Fixture Skill' },
      { ...pattern, stems: [] },
      { ...pattern, stems: ['two words'] },
      { ...pattern, stems: 'fixtur' },
      { ...pattern, bonus: 0 },
      { ...pattern, bonus: 1.5 },
      { ...pattern, bonus: '9' },
      { ...pattern, pattern: 'fixtur.*' },
    ]) {
      expect(accepts({ skills: { selectionPatterns: [broken] } })).toBe(false);
    }

    expect(accepts({ skillsSeed: { extraSkills: [skill] } })).toBe(true);
    expect(
      accepts({
        skillsSeed: { extraSkills: [{ ...skill, before: 'built-in-skill' }] },
      }),
    ).toBe(true);
    for (const broken of [
      { ...skill, before: 'Not A Skill Name' },
      { ...skill, before: 3 },
      { ...skill, after: 'built-in-skill' },
    ]) {
      expect(accepts({ skillsSeed: { extraSkills: [broken] } })).toBe(false);
    }
    // A skill without a position has no `before` key at all.
    expect(
      Object.keys(
        normalizeInstanceProfile({ skillsSeed: { extraSkills: [skill] } })
          .skillsSeed.extraSkills[0],
      ),
    ).toEqual(['frontmatter', 'body']);
  });

  it('reports unknown keys and skips note keys', () => {
    const found = problems();
    const profile = normalizeInstanceProfile(
      {
        _readme: 'a note for people',
        googel: { defaultCalendarId: 'calendar@example.com' },
        google: { _note: 'kept out', defaultCalendar: 'calendar@example.com' },
      },
      found,
    );

    expect(profile).toEqual(NEUTRAL_INSTANCE_PROFILE);
    expect(found).toEqual({
      invalidKeys: [],
      unknownKeys: ['googel', 'google.defaultCalendar'],
    });
  });

  it('treats a profile that is not an object as empty', () => {
    for (const raw of [null, [], 'text', 42]) {
      const found = problems();
      expect(normalizeInstanceProfile(raw, found)).toEqual(
        NEUTRAL_INSTANCE_PROFILE,
      );
      expect(found.invalidKeys).toEqual(['<root>']);
    }
  });

  it('returns a frozen profile that does not alias its input', () => {
    const input = JSON.parse(JSON.stringify(SYNTHETIC_PROFILE));
    const profile = normalizeInstanceProfile(input);
    input.telegram.adminAlertJids.push('tg:100777');
    input.launchd.units[0].label = 'com.example.changed';
    input.skillsSeed.extraSkills[0].frontmatter.triggers.push('changed');

    expect(profile.telegram.adminAlertJids).toEqual(['tg:100123']);
    expect(profile.launchd.units[0].label).toBe('com.example.main');
    expect(profile.skillsSeed.extraSkills[0].frontmatter.triggers).toEqual([
      'fixture',
    ]);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.telegram)).toBe(true);
    expect(Object.isFrozen(profile.telegram.adminAlertJids)).toBe(true);
    expect(Object.isFrozen(profile.launchd.units[1])).toBe(true);
    expect(Object.isFrozen(profile.dashboard.restartableUnits)).toBe(true);
    expect(Object.isFrozen(NEUTRAL_INSTANCE_PROFILE.launchd.units[0])).toBe(
      true,
    );
  });
});

describe('loadInstanceProfile', () => {
  it('looks in the working directory first, then in the code root', () => {
    expect(
      instanceProfileCandidatePaths({
        env: {},
        cwd: '/srv/instance',
        codeRoot: '/srv/app',
      }),
    ).toEqual([
      '/srv/instance/config/instance.json',
      '/srv/app/config/instance.json',
    ]);
    // One directory is both: a single candidate.
    expect(
      instanceProfileCandidatePaths({
        env: {},
        cwd: '/srv/app',
        codeRoot: '/srv/app',
      }),
    ).toEqual(['/srv/app/config/instance.json']);
    // An explicit file is the only candidate.
    expect(
      instanceProfileCandidatePaths({
        env: { [INSTANCE_PROFILE_FILE_ENV]: '/srv/elsewhere/profile.json' },
        cwd: '/srv/instance',
        codeRoot: '/srv/app',
      }),
    ).toEqual(['/srv/elsewhere/profile.json']);
  });

  it('takes the repository this module runs from as the code root', () => {
    const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

    expect(
      instanceProfileCandidatePaths({ env: {}, cwd: '/srv/instance' }),
    ).toEqual([
      '/srv/instance/config/instance.json',
      path.join(repositoryRoot, 'config', 'instance.json'),
    ]);
  });

  it('does not throw when the working directory is gone', () => {
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw Object.assign(new Error('uv_cwd'), { code: 'ENOENT' });
    });
    const codeRoot = '/srv/app';

    // Without a working directory only the code root is left.
    expect(instanceProfileCandidatePaths({ env: {}, codeRoot })).toEqual([
      '/srv/app/config/instance.json',
    ]);
    // A relative explicit path cannot be resolved: there is no file to read.
    const env = { [INSTANCE_PROFILE_FILE_ENV]: 'relative/profile.json' };
    expect(instanceProfileCandidatePaths({ env, codeRoot })).toEqual([]);
    const loaded = loadInstanceProfile({ env, codeRoot });
    expect(loaded.profile).toEqual(NEUTRAL_INSTANCE_PROFILE);
    expect(loaded.file).toBeNull();

    withoutInjectedProfile();
    process.env[INSTANCE_PROFILE_FILE_ENV] = 'relative/profile.json';
    expect(instanceProfile()).toEqual(NEUTRAL_INSTANCE_PROFILE);
  });

  it('gives the neutral defaults when no file exists', () => {
    const loaded = loadInstanceProfile({
      env: {},
      cwd: temporaryDirectory(),
      codeRoot: temporaryDirectory(),
    });

    expect(loaded.profile).toEqual(NEUTRAL_INSTANCE_PROFILE);
    expect(loaded.file).toBeNull();
    expect(loaded.unusable).toBeNull();
  });

  it('reads the file of the working directory', () => {
    const cwd = temporaryDirectory();
    const file = writeProfile(cwd, JSON.stringify(SYNTHETIC_PROFILE));

    const loaded = loadInstanceProfile({
      env: {},
      cwd,
      codeRoot: temporaryDirectory(),
    });

    expect(loaded.file).toBe(file);
    expect(loaded.profile).toEqual(SYNTHETIC_PROFILE);
    expect(loaded.problems).toEqual({ invalidKeys: [], unknownKeys: [] });
  });

  it('falls back to the code root when the working directory has no file', () => {
    const codeRoot = temporaryDirectory();
    const file = writeProfile(
      codeRoot,
      // A byte order mark in front is tolerated.
      `${String.fromCharCode(0xfeff)}${JSON.stringify({ google: { defaultCalendarId: 'calendar@example.com' } })}`,
    );

    const loaded = loadInstanceProfile({
      env: {},
      cwd: temporaryDirectory(),
      codeRoot,
    });

    expect(loaded.file).toBe(file);
    expect(loaded.profile.google.defaultCalendarId).toBe(
      'calendar@example.com',
    );
  });

  it('does not merge files: the working directory file wins as a whole', () => {
    const cwd = temporaryDirectory();
    const codeRoot = temporaryDirectory();
    writeProfile(
      cwd,
      JSON.stringify({ telegram: { adminContact: '@owner_fixture' } }),
    );
    writeProfile(codeRoot, JSON.stringify(SYNTHETIC_PROFILE));

    const loaded = loadInstanceProfile({ env: {}, cwd, codeRoot });

    expect(loaded.profile.telegram.adminContact).toBe('@owner_fixture');
    expect(loaded.profile.google).toEqual(NEUTRAL_INSTANCE_PROFILE.google);
  });

  it('uses only the explicit file when one is configured', () => {
    const cwd = temporaryDirectory();
    writeProfile(cwd, JSON.stringify(SYNTHETIC_PROFILE));
    const missing = path.join(temporaryDirectory(), 'missing.json');

    const loaded = loadInstanceProfile({
      env: { [INSTANCE_PROFILE_FILE_ENV]: missing },
      cwd,
      codeRoot: cwd,
    });

    expect(loaded.profile).toEqual(NEUTRAL_INSTANCE_PROFILE);
    expect(loaded.file).toBeNull();
  });

  it.each([
    ['broken JSON', '{ "google": ', 'invalid JSON'],
    ['a JSON array', '[]', 'not a JSON object'],
    ['a JSON string', '"text"', 'not a JSON object'],
  ])('ignores %s as a whole without throwing', (_name, contents, reason) => {
    const cwd = temporaryDirectory();
    const file = writeProfile(cwd, contents);
    // A valid file further down the list is not used instead.
    const codeRoot = temporaryDirectory();
    writeProfile(codeRoot, JSON.stringify(SYNTHETIC_PROFILE));

    const loaded = loadInstanceProfile({ env: {}, cwd, codeRoot });

    expect(loaded.profile).toEqual(NEUTRAL_INSTANCE_PROFILE);
    expect(loaded.file).toBe(file);
    expect(loaded.unusable).toBe(reason);
  });

  it('ignores a directory in place of the file and an oversized file', () => {
    const cwd = temporaryDirectory();
    fs.mkdirSync(path.join(cwd, 'config', 'instance.json'), {
      recursive: true,
    });
    expect(loadInstanceProfile({ env: {}, cwd, codeRoot: cwd }).unusable).toBe(
      'not a file',
    );

    const big = temporaryDirectory();
    writeProfile(big, `{"_readme":"${'x'.repeat(1024 * 1024)}"}`);
    expect(
      loadInstanceProfile({ env: {}, cwd: big, codeRoot: big }).unusable,
    ).toBe('file is too large');
  });
});

describe('instanceProfile', () => {
  it('is neutral in tests unless a profile is injected', () => {
    expect(instanceProfile()).toEqual(NEUTRAL_INSTANCE_PROFILE);
    // Also without the injected profile: the test environment points the
    // loader at a missing file.
    withoutInjectedProfile();
    expect(instanceProfile()).toEqual(NEUTRAL_INSTANCE_PROFILE);
  });

  it('goes back to the injected empty profile on reset, not to a file', () => {
    const root = temporaryDirectory();
    process.env[INSTANCE_PROFILE_FILE_ENV] = writeProfile(
      root,
      JSON.stringify(SYNTHETIC_PROFILE),
    );
    setInstanceProfileForTests({
      telegram: { adminContact: '@owner_fixture' },
    });

    resetInstanceProfileForTests();

    // The file is there and configured, and still not read.
    expect(instanceProfile()).toEqual(NEUTRAL_INSTANCE_PROFILE);
    resetRunnerInstanceProfileForTests();
    expect(instanceProfile()).toEqual(NEUTRAL_INSTANCE_PROFILE);
  });

  it('returns the injected profile and goes back to neutral on reset', () => {
    setInstanceProfileForTests({
      google: { defaultCalendarId: 'calendar@example.com' },
    });

    expect(instanceProfile().google.defaultCalendarId).toBe(
      'calendar@example.com',
    );
    expect(instanceProfile().telegram).toEqual(
      NEUTRAL_INSTANCE_PROFILE.telegram,
    );
    // The same object every time: callers may compare by identity.
    expect(instanceProfile()).toBe(instanceProfile());

    resetInstanceProfileForTests();
    expect(instanceProfile()).toEqual(NEUTRAL_INSTANCE_PROFILE);
  });

  it('keeps the injected profile across a module reset', async () => {
    setInstanceProfileForTests({
      telegram: { adminContact: '@owner_fixture' },
    });
    vi.resetModules();

    const fresh = await import('./instance-profile.js');

    expect(fresh.instanceProfile().telegram.adminContact).toBe(
      '@owner_fixture',
    );
  });

  it('refuses to inject a profile production would not accept', () => {
    expect(() =>
      setInstanceProfileForTests({
        google: { defaultCalendarId: 'not a calendar id' },
      }),
    ).toThrow(/google\.defaultCalendarId/u);
    expect(() =>
      setInstanceProfileForTests({
        googel: { defaultCalendarId: 'calendar@example.com' },
      } as InstanceProfileInput),
    ).toThrow(/googel/u);
    expect(instanceProfile()).toEqual(NEUTRAL_INSTANCE_PROFILE);
  });

  it('keeps a derived value until the profile changes', () => {
    const compute = vi.fn(
      (profile: ReturnType<typeof instanceProfile>) =>
        new Set(profile.memory.curatorKeywords),
    );
    const keywords = derivedFromInstanceProfile(compute);

    expect(keywords().size).toBe(0);
    expect(keywords()).toBe(keywords());
    expect(compute).toHaveBeenCalledTimes(1);

    setInstanceProfileForTests({ memory: { curatorKeywords: ['образец'] } });
    expect([...keywords()]).toEqual(['образец']);
    expect(keywords()).toBe(keywords());
    expect(compute).toHaveBeenCalledTimes(2);

    resetInstanceProfileForTests();
    expect(keywords().size).toBe(0);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('loads the configured file once and logs nothing for a valid one', () => {
    const root = temporaryDirectory();
    const file = writeProfile(root, JSON.stringify(SYNTHETIC_PROFILE));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    withoutInjectedProfile();
    process.env[INSTANCE_PROFILE_FILE_ENV] = file;

    expect(instanceProfile()).toEqual(SYNTHETIC_PROFILE);
    // Read once per process: an edit needs a restart.
    fs.writeFileSync(file, '{}');
    expect(instanceProfile()).toEqual(SYNTHETIC_PROFILE);
    expect(warn).not.toHaveBeenCalled();
    expect(instanceProfileStatus()).toEqual({
      file,
      unusable: null,
      invalidKeys: [],
      unknownKeys: [],
    });
    expect(instanceProfileNeedsAttention()).toBe(false);
  });

  it('reports once, as an error with key names only, a file it cannot fully use', () => {
    const root = temporaryDirectory();
    const file = writeProfile(
      root,
      JSON.stringify({
        google: { defaultCalendarId: 'secret value that must not be logged' },
        typo: true,
      }),
    );
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    withoutInjectedProfile();
    process.env[INSTANCE_PROFILE_FILE_ENV] = file;

    expect(instanceProfile()).toEqual(NEUTRAL_INSTANCE_PROFILE);
    expect(instanceProfile()).toEqual(NEUTRAL_INSTANCE_PROFILE);

    // A value fell back to its default: louder than a warning.
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toEqual({
      file,
      invalidKeys: ['google.defaultCalendarId'],
      unknownKeys: ['typo'],
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret value');

    // The same outcome is there to ask for, again without values.
    const status = instanceProfileStatus();
    expect(status).toEqual({
      file,
      unusable: null,
      invalidKeys: ['google.defaultCalendarId'],
      unknownKeys: ['typo'],
    });
    expect(JSON.stringify(status)).not.toContain('secret value');
    expect(instanceProfileNeedsAttention()).toBe(true);
    expect(Object.isFrozen(status) && Object.isFrozen(status.invalidKeys)).toBe(
      true,
    );
  });

  it('only warns about keys it does not know: nothing fell back to a default', () => {
    const root = temporaryDirectory();
    const file = writeProfile(
      root,
      JSON.stringify({ ...SYNTHETIC_PROFILE, typo: true, _note: 'ignored' }),
    );
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    withoutInjectedProfile();
    process.env[INSTANCE_PROFILE_FILE_ENV] = file;

    expect(instanceProfile()).toEqual(SYNTHETIC_PROFILE);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      file,
      invalidKeys: [],
      unknownKeys: ['typo'],
    });
    expect(instanceProfileStatus().unknownKeys).toEqual(['typo']);
    expect(instanceProfileNeedsAttention()).toBe(true);
  });

  it('reports an error and stays neutral when the file is malformed or logging fails', () => {
    const root = temporaryDirectory();
    const file = writeProfile(
      root,
      '{ "google": { "defaultCalendarId": "secret value"',
    );
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {
      throw new Error('logger fixture failure');
    });
    withoutInjectedProfile();
    process.env[INSTANCE_PROFILE_FILE_ENV] = file;

    expect(instanceProfile()).toEqual(NEUTRAL_INSTANCE_PROFILE);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toEqual({ file, reason: 'invalid JSON' });
    expect(instanceProfileStatus()).toEqual({
      file,
      unusable: 'invalid JSON',
      invalidKeys: [],
      unknownKeys: [],
    });
    expect(instanceProfileNeedsAttention()).toBe(true);
  });

  it('has nothing to report for a missing file or an injected profile', () => {
    const root = temporaryDirectory();
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    withoutInjectedProfile();
    process.env[INSTANCE_PROFILE_FILE_ENV] = path.join(root, 'missing.json');

    // Asking for the status loads the profile when nothing has yet.
    expect(instanceProfileStatus()).toEqual({
      file: null,
      unusable: null,
      invalidKeys: [],
      unknownKeys: [],
    });
    expect(instanceProfileNeedsAttention()).toBe(false);
    expect(instanceProfile()).toEqual(NEUTRAL_INSTANCE_PROFILE);

    // A test's injected profile is never a problem of the installation.
    setInstanceProfileForTests(SYNTHETIC_PROFILE);
    expect(instanceProfileNeedsAttention()).toBe(false);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the neutral profile file of the public export', () => {
  // The overlay exists in the private tree only. In the public tree it IS
  // config/instance.json, which tests never read.
  const overlay = fileURLToPath(
    new URL(
      '../../../public-release/overlay/config/instance.json',
      import.meta.url,
    ),
  );

  it.skipIf(!fs.existsSync(overlay))(
    'carries exactly the neutral defaults of the loader',
    () => {
      const found = problems();
      const raw = JSON.parse(fs.readFileSync(overlay, 'utf8'));
      const { _readme: readme, ...values } = raw;

      expect(typeof readme).toBe('string');
      expect(values).toEqual(NEUTRAL_INSTANCE_PROFILE);
      expect(normalizeInstanceProfile(raw, found)).toEqual(
        NEUTRAL_INSTANCE_PROFILE,
      );
      expect(found).toEqual({ invalidKeys: [], unknownKeys: [] });
    },
  );
});

describe('the profile sent to the agent runner', () => {
  it('is the detector word lists and the prompt fragments', () => {
    const profile = normalizeInstanceProfile(SYNTHETIC_PROFILE);

    expect(runnerInstanceProfile(profile)).toEqual({
      credentialDetector: SYNTHETIC_PROFILE.credentialDetector,
      prompts: SYNTHETIC_PROFILE.prompts,
    });
    expect(Object.keys(runnerInstanceProfile())).toEqual([
      'credentialDetector',
      'prompts',
    ]);
  });

  it('has the same neutral defaults on the runner side', () => {
    expect(RUNNER_NEUTRAL_INSTANCE_PROFILE).toEqual(
      runnerInstanceProfile(NEUTRAL_INSTANCE_PROFILE),
    );
    expect(normalizeRunnerInstanceProfile(undefined)).toEqual(
      runnerInstanceProfile(NEUTRAL_INSTANCE_PROFILE),
    );
  });

  it('survives the trip host → run input → runner → MCP server environment', () => {
    const sent = JSON.parse(
      JSON.stringify({
        instanceProfile: runnerInstanceProfile(
          normalizeInstanceProfile(SYNTHETIC_PROFILE),
        ),
      }),
    ).instanceProfile;
    const expected = {
      credentialDetector: SYNTHETIC_PROFILE.credentialDetector,
      prompts: SYNTHETIC_PROFILE.prompts,
    };
    // The test environment starts from an injected (empty) profile; these
    // checks are about what the runner does without one.
    withoutInjectedProfile();

    // The main runner process adopts what came on stdin…
    adoptInstanceProfile(sent);
    expect(runnerSideInstanceProfile()).toEqual(expected);

    // …and the MCP server, a separate process, reads it from its environment.
    withoutInjectedProfile();
    process.env[INSTANCE_PROFILE_ENV] = instanceProfileEnvValue(sent);
    expect(runnerSideInstanceProfile()).toEqual(expected);
  });

  it('sends nothing for a neutral profile and stays neutral without one', () => {
    expect(
      instanceProfileEnvValue(runnerInstanceProfile(NEUTRAL_INSTANCE_PROFILE)),
    ).toBe('');
    expect(instanceProfileEnvValue(undefined)).toBe('');

    withoutInjectedProfile();
    expect(runnerSideInstanceProfile()).toEqual(
      RUNNER_NEUTRAL_INSTANCE_PROFILE,
    );

    withoutInjectedProfile();
    process.env[INSTANCE_PROFILE_ENV] = '{ not json';
    const stderr = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    expect(runnerSideInstanceProfile()).toEqual(
      RUNNER_NEUTRAL_INSTANCE_PROFILE,
    );
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it('applies the same checks to the same values on both sides', () => {
    const samples: unknown[] = [
      SYNTHETIC_PROFILE,
      {},
      { credentialDetector: { peopleWords: ['two words'], nameWords: ['ok'] } },
      { credentialDetector: { serviceWords: 'not a list' } },
      { credentialDetector: { accountWords: ['a|b'] } },
      { prompts: { ownerName: '', workTargetHint: 'x'.repeat(401) } },
      { prompts: { secretHolderExample: 'two  spaces' } },
      { prompts: { helperPermissionTarget: 'line\nbreak' } },
      { prompts: { taskTitleExample: 'with a "quote" inside' } },
      { prompts: { taskTitleExample: 'x'.repeat(61) } },
      { prompts: { taskTitleExample: 'x'.repeat(60) } },
      { prompts: 'not an object' },
    ];

    for (const sample of samples) {
      expect(normalizeRunnerInstanceProfile(sample)).toEqual(
        runnerInstanceProfile(normalizeInstanceProfile(sample)),
      );
    }
  });

  it('rebuilds a derived value on the runner side when the run input arrives', () => {
    // The main runner process has no profile until it has read its input.
    withoutInjectedProfile();
    const people = runnerSideDerivedFromInstanceProfile(
      (profile) => new Set(profile.credentialDetector.peopleWords),
    );
    expect(people().size).toBe(0);

    adoptInstanceProfile({ credentialDetector: { peopleWords: ['образец'] } });

    expect([...people()]).toEqual(['образец']);
    expect(people()).toBe(people());
  });

  it('goes back to the injected empty profile on a runner-side reset', () => {
    setInstanceProfileForTests({
      credentialDetector: { peopleWords: ['образец'] },
    });
    adoptInstanceProfile({ credentialDetector: { peopleWords: ['пример'] } });

    resetRunnerInstanceProfileForTests();

    expect(runnerSideInstanceProfile()).toEqual(
      RUNNER_NEUTRAL_INSTANCE_PROFILE,
    );
    expect(
      (globalThis as Record<symbol, unknown>)[INJECTED_PROFILE_KEY],
    ).toEqual({});
  });

  it('reaches the runner copy through one injection on the host', () => {
    setInstanceProfileForTests({
      credentialDetector: { peopleWords: ['образец'] },
    });

    expect(runnerSideInstanceProfile().credentialDetector.peopleWords).toEqual([
      'образец',
    ]);
    expect(instanceProfile().credentialDetector.peopleWords).toEqual([
      'образец',
    ]);
  });
});
