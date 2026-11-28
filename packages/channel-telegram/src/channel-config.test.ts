import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetInstanceProfileForTests,
  setInstanceProfileForTests,
} from '@skoobi/shared/instance-profile';

vi.mock('@skoobi/shared/env', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

describe('Telegram channel config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    resetInstanceProfileForTests();
  });

  it('uses the shared assistant-name normalization and trigger boundary', async () => {
    process.env.ASSISTANT_NAME = '  Бот_2  ';

    const config = await import('./channel-config.js');

    expect(config.ASSISTANT_NAME).toBe('Бот_2');
    expect(config.TRIGGER_PATTERN.test('@Бот_2 привет')).toBe(true);
    expect(config.TRIGGER_PATTERN.test('@Бот_20 привет')).toBe(false);
  });

  it('fails closed instead of compiling invalid regex configuration', async () => {
    process.env.ASSISTANT_NAME = '[a-z]+';

    const config = await import('./channel-config.js');

    expect(config.ASSISTANT_NAME).toBe('Skoobi');
    expect(config.TRIGGER_PATTERN.test('@Skoobi ok')).toBe(true);
    expect(config.TRIGGER_PATTERN.test('@aaaa')).toBe(false);
  });

  it('defaults to the neutral product name when nothing sets a name', async () => {
    delete process.env.ASSISTANT_NAME;

    const config = await import('./channel-config.js');

    expect(config.ASSISTANT_NAME).toBe('Skoobi');
    expect(config.TRIGGER_PATTERN.test('@Skoobi привет')).toBe(true);
  });

  it('takes the unset name from the instance profile, like core config', async () => {
    setInstanceProfileForTests({ assistant: { defaultName: 'fixture_bot' } });
    delete process.env.ASSISTANT_NAME;

    const config = await import('./channel-config.js');

    expect(config.ASSISTANT_NAME).toBe('fixture_bot');
    expect(config.TRIGGER_PATTERN.test('@fixture_bot привет')).toBe(true);
    expect(config.TRIGGER_PATTERN.test('@Skoobi привет')).toBe(false);
  });

  it('lets ASSISTANT_NAME from the environment win over the profile name', async () => {
    setInstanceProfileForTests({ assistant: { defaultName: 'fixture_bot' } });
    process.env.ASSISTANT_NAME = 'Envbot';

    const config = await import('./channel-config.js');

    expect(config.ASSISTANT_NAME).toBe('Envbot');
  });
});
