import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('operator skill approval CLI', () => {
  it('refuses self-attested draft approval even with --yes and keeps the original draft', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-cli-'));
    try {
      const skills = path.join(root, 'data', 'skills');
      const draft = path.join(skills, '.proposals', 'candidate', 'SKILL.md');
      fs.mkdirSync(path.dirname(draft), { recursive: true });
      const original =
        '---\nname: candidate\nversion: 1.0.0\nstatus: draft\ncreated_by: agent_proposal\nverified: true\n---\nSelf assertion does not establish evidence.';
      fs.writeFileSync(draft, original);
      const child = spawnSync(
        process.execPath,
        [
          path.resolve('node_modules/tsx/dist/cli.mjs'),
          path.resolve('src/scripts/skills-manage.ts'),
          'approve',
          'candidate',
          '--yes',
          '--root',
          root,
          '--json',
        ],
        {
          cwd: process.cwd(),
          timeout: 15_000,
          encoding: 'utf8',
          env: { ...process.env, SKOOBI_TEST_STATE_ROOT: root },
        },
      );
      expect(child.status).toBe(1);
      expect(child.stderr).toContain('Skill verification required');
      expect(fs.readFileSync(draft, 'utf8')).toBe(original);
      expect(fs.existsSync(path.join(skills, 'candidate'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
