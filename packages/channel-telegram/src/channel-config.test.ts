import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});
