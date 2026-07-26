import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('readEnvFile', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reads from CLAUDECLAW_ENV_FILE when set', async () => {
    const tmpEnv = path.join(
      process.env.TMPDIR || '/tmp',
      'test-claudeclaw.env',
    );
    fs.writeFileSync(tmpEnv, 'TEST_KEY=from_env_file\n');
    process.env.CLAUDECLAW_ENV_FILE = tmpEnv;

    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile(['TEST_KEY']);
    expect(result.TEST_KEY).toBe('from_env_file');

    fs.unlinkSync(tmpEnv);
  });

  it('reads from cwd/.env by default', async () => {
    delete process.env.CLAUDECLAW_ENV_FILE;

    const { readEnvFile } = await import('./env.js');
    // Should not throw even if .env doesn't exist — returns empty
    const result = readEnvFile(['NONEXISTENT_KEY']);
    expect(result).toEqual({});
  });

  it('fails closed for symlinked and oversized env files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-env-test-'));
    const target = path.join(root, 'target.env');
    const link = path.join(root, 'link.env');
    const oversized = path.join(root, 'oversized.env');
    fs.writeFileSync(target, 'TEST_KEY=must-not-leak\n', { mode: 0o600 });
    fs.symlinkSync(target, link);
    fs.writeFileSync(oversized, 'x'.repeat(1024 * 1024 + 1), {
      mode: 0o600,
    });
    try {
      const { readEnvFile } = await import('./env.js');
      process.env.CLAUDECLAW_ENV_FILE = link;
      expect(readEnvFile(['TEST_KEY'])).toEqual({});
      process.env.CLAUDECLAW_ENV_FILE = oversized;
      expect(readEnvFile(['TEST_KEY'])).toEqual({});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when same-fd metadata changes during the read', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-env-race-'));
    const envFile = path.join(root, '.env');
    fs.writeFileSync(envFile, 'TEST_KEY=original\n', { mode: 0o600 });
    process.env.CLAUDECLAW_ENV_FILE = envFile;
    const originalFstat = fs.fstatSync.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const stat = originalFstat(fd);
      calls += 1;
      if (calls === 2) {
        Object.defineProperty(stat, 'ctimeMs', {
          value: stat.ctimeMs + 1,
        });
      }
      return stat;
    }) as typeof fs.fstatSync);
    try {
      const { readEnvFile } = await import('./env.js');
      expect(readEnvFile(['TEST_KEY'])).toEqual({});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
