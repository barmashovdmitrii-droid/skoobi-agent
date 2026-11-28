import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adoptLegacySkillVerification } from '../orchestrator/skill-registry.js';
import {
  formatSkillWindowReport,
  inspectSkillWindows,
} from './skills-window.js';

function skillFile(dir: string, name: string, markdown: string): string {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(file, markdown);
  return file;
}

const LONG_SKILL = [
  '---',
  'name: long-game',
  'description: "Игры: длинный навык"',
  'status: active',
  'created_by: operator',
  'triggers: ["сделай игру","crazy games"]',
  'folders: ["telegram_main"]',
  'channels: ["tg"]',
  'version: 1.0.0',
  '---',
  '',
  'Режим `prepare_only`: подготовка, не публикация. Кавычки "как есть" & <теги>.',
  '',
  '## Подробно',
  '',
  'Подробность. '.repeat(200),
  'Правило за окном.',
  '',
].join('\n');

describe('skills-window: what a skill puts into a turn', () => {
  let root: string;
  let skills: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-window-'));
    skills = path.join(root, 'data', 'skills');
    fs.mkdirSync(skills, { recursive: true });
    skillFile(
      skills,
      'short-one',
      '---\nname: short-one\ndescription: Short\ntriggers: ["коротко"]\n---\nВсё помещается.\n',
    );
    skillFile(skills, 'long-game', LONG_SKILL);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports the fill of every skill window, frontmatter included', () => {
    const report = inspectSkillWindows({ skillsDir: skills });
    expect(report.limit).toBe(1800);
    const long = report.rows.find((row) => row.name === 'long-game');
    expect(long).toMatchObject({
      fileChars: LONG_SKILL.length,
      frontmatterChars: LONG_SKILL.indexOf('\n---', 4) + 4,
      truncated: true,
      lostChars: LONG_SKILL.length - 1800,
    });
    expect(report.rows.find((row) => row.name === 'short-one')).toMatchObject({
      truncated: false,
      lostChars: 0,
    });
    expect(formatSkillWindowReport(report)).toContain(
      `- long-game [active]: ${LONG_SKILL.length} знаков`,
    );
  });

  it('runs the real substitution and finds which rules are outside the window', () => {
    const report = inspectSkillWindows({
      skillsDir: skills,
      skill: 'long-game',
      require: ['`prepare_only`', 'Кавычки "как есть" & <теги>', 'Правило за окном.'],
    });
    const check = report.check!;
    // Default message: the first trigger; default chat: the skill's folder/channel.
    expect(check).toMatchObject({
      text: 'сделай игру',
      folder: 'telegram_main',
      chatJid: 'tg:0',
      selected: true,
      selectedSkills: ['long-game'],
      present: ['`prepare_only`', 'Кавычки "как есть" & <теги>'],
      missing: ['Правило за окном.'],
      ok: false,
    });
    // The window is the injected block, unescaped back from XML.
    expect(check.window.startsWith('---\nname: long-game\n')).toBe(true);
    expect(check.window.endsWith('\n...')).toBe(true);
    expect(check.window.length).toBeLessThanOrEqual(1800 + '\n...'.length);
    expect(formatSkillWindowReport(report)).toContain('НЕТ    «Правило за окном.»');
  });

  it('says so when the message does not select the skill', () => {
    const report = inspectSkillWindows({
      skillsDir: skills,
      skill: 'long-game',
      text: 'погода на завтра',
      require: ['`prepare_only`'],
    });
    expect(report.check).toMatchObject({
      selected: false,
      selectedSkills: [],
      window: '',
      ok: false,
    });
  });

  it('honours host skill proofs the way the bot does', () => {
    const markdown =
      '---\nname: proven\ndescription: Needs proof\nstatus: active\ntriggers: ["доказано"]\nverification: required\n---\nПроверенное правило.\n';
    skillFile(skills, 'proven', markdown);
    const stateDir = path.join(root, 'host-state');
    const host = {
      stateDir,
      agentWritableRoots: [skills],
      checkerPath: path.join(stateDir, 'checker.mjs'),
      boundary: 'owner-full-access' as const,
    };
    const check = () =>
      inspectSkillWindows({
        skillsDir: skills,
        skill: 'proven',
        require: ['Проверенное правило.'],
        verificationHost: host,
      });
    // Without a host record the skill needs proof: stale, never injected.
    expect(check().rows.find((row) => row.name === 'proven')?.status).toBe(
      'stale',
    );
    expect(check().check?.selected).toBe(false);
    adoptLegacySkillVerification({ name: 'proven', markdown, host });
    expect(check().rows.find((row) => row.name === 'proven')?.status).toBe(
      'active',
    );
    expect(check().check).toMatchObject({ selected: true, ok: true });
  });

  it('never writes into the real skills folder and skips symlinked skills', () => {
    const usage = path.join(skills, '.usage.json');
    fs.writeFileSync(usage, '{"long-game":{"view_count":7}}');
    const secret = path.join(root, 'not-a-skill.txt');
    fs.writeFileSync(secret, '---\nname: leak\n---\nне навык');
    fs.mkdirSync(path.join(skills, 'leak'));
    fs.symlinkSync(secret, path.join(skills, 'leak', 'SKILL.md'));

    const report = inspectSkillWindows({
      skillsDir: skills,
      skill: 'long-game',
      require: ['`prepare_only`'],
    });
    expect(report.check?.ok).toBe(true);
    expect(report.rows.map((row) => row.name)).toEqual([
      'long-game',
      'short-one',
    ]);
    expect(fs.readFileSync(usage, 'utf8')).toBe(
      '{"long-game":{"view_count":7}}',
    );
    expect(() =>
      inspectSkillWindows({ skillsDir: skills, skill: 'leak' }),
    ).toThrow('Навык не найден: leak');
  });

  it('exits 1 from the command line when a rule is outside the window', () => {
    // One real process: the CLI reads its arguments, prints the check and sets
    // the exit code the deploy check relies on.
    const run = spawnSync(
      process.execPath,
      [
        path.resolve('node_modules/tsx/dist/cli.mjs'),
        path.resolve('src/scripts/skills-window.ts'),
        '--root',
        root,
        '--skill',
        'long-game',
        '--require',
        '`prepare_only`',
        '--require',
        'Правило за окном.',
      ],
      { cwd: process.cwd(), timeout: 20_000, encoding: 'utf8' },
    );
    expect(run.status, run.stderr).toBe(1);
    expect(run.stdout).toContain('есть   «`prepare_only`»');
    expect(run.stdout).toContain('НЕТ    «Правило за окном.»');
    expect(run.stdout).toContain('Итог: проверка не прошла');
  }, 25_000);
});
