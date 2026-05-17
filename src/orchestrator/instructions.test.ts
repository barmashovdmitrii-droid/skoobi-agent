import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  agentConfigWithTenantInstructions,
  findTenantInstructions,
  loadTenantInstructions,
} from './instructions.js';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-instructions-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('tenant instruction loader', () => {
  it('prefers AGENT.md over SKOOBI.md and CLAUDE.md', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'legacy');
    fs.writeFileSync(path.join(dir, 'SKOOBI.md'), 'skoobi');
    fs.writeFileSync(path.join(dir, 'AGENT.md'), 'agent');

    expect(path.basename(findTenantInstructions(dir)!)).toBe('AGENT.md');
    expect(loadTenantInstructions(dir)).toMatchObject({
      filename: 'AGENT.md',
      content: 'agent',
    });
  });

  it('falls back from SKOOBI.md to CLAUDE.md', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'legacy');

    expect(path.basename(findTenantInstructions(dir)!)).toBe('CLAUDE.md');

    fs.writeFileSync(path.join(dir, 'SKOOBI.md'), 'skoobi');
    expect(path.basename(findTenantInstructions(dir)!)).toBe('SKOOBI.md');
  });

  it('injects AGENT.md without duplicating CLAUDE.md system context', () => {
    const dir = makeTmpDir();
    const folder = path.basename(dir);
    const cwd = process.cwd();
    const groupsDir = path.join(cwd, 'groups', folder);
    fs.mkdirSync(groupsDir, { recursive: true });

    try {
      fs.writeFileSync(path.join(groupsDir, 'CLAUDE.md'), 'legacy only');
      expect(
        agentConfigWithTenantInstructions({
          name: 'Test',
          folder,
          trigger: '@Skoobi',
          added_at: new Date().toISOString(),
          agentConfig: { model: 'test-model' },
        }),
      ).toEqual({ model: 'test-model' });

      fs.writeFileSync(path.join(groupsDir, 'AGENT.md'), 'agent wins');
      expect(
        agentConfigWithTenantInstructions({
          name: 'Test',
          folder,
          trigger: '@Skoobi',
          added_at: new Date().toISOString(),
          agentConfig: { model: 'test-model', systemPrompt: 'existing' },
        })?.systemPrompt,
      ).toContain('agent wins');
    } finally {
      fs.rmSync(groupsDir, { recursive: true, force: true });
    }
  });
});
