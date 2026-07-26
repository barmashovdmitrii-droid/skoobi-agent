import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('config path resolution', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses cwd as STATE_ROOT', async () => {
    const config = await import('./config.js');
    expect(config.STATE_ROOT).toBe(process.cwd());
  });

  it('decodes spaces and Unicode when resolving CODE_ROOT', async () => {
    const tempRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-code-root-')),
    );
    const codeRoot = path.join(tempRoot, 'Skoobi path Юникод');
    const modulePath = path.join(
      codeRoot,
      'packages',
      'core',
      'dist',
      'orchestrator',
      'config.js',
    );
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, '');

    try {
      const config = await import('./config.js');
      expect(
        config.resolveCodeRootFromModuleUrl(pathToFileURL(modulePath)),
      ).toBe(codeRoot);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('derives STORE_DIR from STATE_ROOT', async () => {
    const config = await import('./config.js');
    expect(config.STORE_DIR).toContain('store');
  });

  it('derives GROUPS_DIR from STATE_ROOT', async () => {
    const config = await import('./config.js');
    expect(config.GROUPS_DIR).toContain('groups');
  });

  it('derives LOG_DIR from STATE_ROOT', async () => {
    const config = await import('./config.js');
    expect(config.LOG_DIR).toContain('logs');
  });

  it('derives DATA_DIR from STATE_ROOT', async () => {
    const config = await import('./config.js');
    expect(config.DATA_DIR).toContain('data');
    expect(config.DATA_DIR).toBe(
      require('path').resolve(process.cwd(), 'data'),
    );
  });

  it('normalizes the configured assistant name once', async () => {
    process.env.ASSISTANT_NAME = '  A\u0301gent_2-Я  ';

    const config = await import('./config.js');

    expect(config.ASSISTANT_NAME).toBe('Ágent_2-Я');
    expect(config.TRIGGER_PATTERN.test('@Ágent_2-Я привет')).toBe(true);
  });

  it('fails closed for an invalid assistant name', async () => {
    process.env.ASSISTANT_NAME = 'Skoobi).*';

    const config = await import('./config.js');

    expect(config.ASSISTANT_NAME).toBe('Skoobi');
    expect(config.TRIGGER_PATTERN.test('@Skoobi привет')).toBe(true);
    expect(config.TRIGGER_PATTERN.test('@anything')).toBe(false);
  });

  it('does not accept a longer Unicode address as the trigger', async () => {
    process.env.ASSISTANT_NAME = 'Бот';

    const config = await import('./config.js');

    expect(config.TRIGGER_PATTERN.test('@Бот привет')).toBe(true);
    expect(config.TRIGGER_PATTERN.test('@Ботик привет')).toBe(false);
    expect(config.TRIGGER_PATTERN.test('@Бот\u0301 привет')).toBe(false);
  });
});
