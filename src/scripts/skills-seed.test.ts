import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The seeding script is a one-shot CLI that builds its list at start, so the
// tests run it as a process and hand it a synthetic instance profile through
// SKOOBI_INSTANCE_PROFILE_FILE: the profile of a real installation
// (config/instance.json) is never read here.
const BUILT_IN = [
  'web-search-workflow',
  'voice-response',
  'memory-continuity',
  'admin-ops-safety',
  'self-improvement-skills',
];

function extraSkill(name: string, before?: string) {
  return {
    frontmatter: {
      name,
      description: `Fixture seed skill ${name}`,
      status: 'active',
      created_by: 'memory_seed',
      triggers: ['fixture'],
      folders: ['telegram_fixture_user'],
      channels: ['tg'],
      version: '1.0.0',
    },
    body: `\n# ${name}\n\nFixture body of ${name}.\n`,
    ...(before === undefined ? {} : { before }),
  };
}

describe('skills-seed', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-seed-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seed(profileFile: string): string[] {
    const run = spawnSync(
      process.execPath,
      [
        path.resolve('node_modules/tsx/dist/cli.mjs'),
        path.resolve('src/scripts/skills-seed.ts'),
        '--root',
        root,
        '--json',
      ],
      {
        cwd: process.cwd(),
        timeout: 20_000,
        encoding: 'utf8',
        env: { ...process.env, SKOOBI_INSTANCE_PROFILE_FILE: profileFile },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      results: { name: string; action: string }[];
    };
    expect(parsed.results.every((row) => row.action === 'created')).toBe(true);
    return parsed.results.map((row) => row.name);
  }

  function skillFile(name: string): string {
    return fs.readFileSync(
      path.join(root, 'data', 'skills', name, 'SKILL.md'),
      'utf8',
    );
  }

  it('without an instance profile seeds only the built-in skills for the main chat', () => {
    expect(seed(path.join(root, 'missing-instance.json'))).toEqual(BUILT_IN);
    expect(skillFile('admin-ops-safety')).toContain(
      'folders: ["telegram_main"]',
    );
  }, 25_000);

  it('takes the admin folders and the extra skills from the instance profile', () => {
    const profileFile = path.join(root, 'instance.json');
    fs.writeFileSync(
      profileFile,
      JSON.stringify({
        skillsSeed: {
          adminFolders: ['telegram_main', 'telegram_fixture_user'],
          extraSkills: [
            extraSkill('fixture-last'),
            extraSkill('fixture-before-admin', 'admin-ops-safety'),
            extraSkill('fixture-unknown-anchor', 'no-such-built-in'),
            extraSkill('fixture-first', 'web-search-workflow'),
          ],
        },
      }),
    );

    expect(seed(profileFile)).toEqual([
      'fixture-first',
      'web-search-workflow',
      'voice-response',
      'memory-continuity',
      'fixture-before-admin',
      'admin-ops-safety',
      'self-improvement-skills',
      'fixture-last',
      'fixture-unknown-anchor',
    ]);
    expect(skillFile('admin-ops-safety')).toContain(
      'folders: ["telegram_main", "telegram_fixture_user"]',
    );
    const extra = skillFile('fixture-before-admin');
    expect(extra).toContain(
      'description: Fixture seed skill fixture-before-admin',
    );
    expect(extra).toContain('folders: ["telegram_fixture_user"]');
    expect(extra).toContain('Fixture body of fixture-before-admin.');
    // `before` only places the skill; it is not written into the file.
    expect(extra).not.toContain('before:');
  }, 25_000);
});
