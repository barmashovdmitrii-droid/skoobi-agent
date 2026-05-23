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

  it('loads instructions.md as tenant instructions', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'instructions.md'), 'plain instructions');

    expect(loadTenantInstructions(dir)).toMatchObject({
      filename: 'instructions.md',
      content: 'plain instructions',
    });
  });

  it('falls back to parent folder instructions for inherited customer folders', () => {
    const root = makeTmpDir();
    const parent = path.join(root, 'main');
    const child = path.join(root, 'main__wa_77010000000');
    fs.mkdirSync(parent, { recursive: true });
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(parent, 'instructions.md'), 'shared prompt');

    expect(loadTenantInstructions(child)).toMatchObject({
      filename: 'instructions.md',
      content: 'shared prompt',
    });
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
