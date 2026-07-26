import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@skoobi/shared/env', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

const ENV_KEYS = [
  'ASSISTANT_NAME',
  'SKOOBI_WHATSAPP_STATE_ROOT',
  'SKOOBI_WHATSAPP_PERSONAL_OBSERVER_ENABLED',
  'SKOOBI_WHATSAPP_OWNER_FOLDER',
  'SKOOBI_WHATSAPP_TEMPLATE_GROUP',
  'SKOOBI_WHATSAPP_OBSERVER_RETENTION_DAYS',
  'SKOOBI_WHATSAPP_OBSERVER_MAX_ROWS',
  'INIT_CWD',
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe('WhatsApp personal observer config', () => {
  it('uses the shared Unicode assistant-name normalization', async () => {
    process.env.ASSISTANT_NAME = '  A\u0301gent_2-Я  ';
    vi.resetModules();

    const config = await import('./channel-config.js');

    expect(config.ASSISTANT_NAME).toBe('Ágent_2-Я');
  });

  it('fails closed for invalid or missing assistant names', async () => {
    process.env.ASSISTANT_NAME = '[a-z]+';
    vi.resetModules();
    expect((await import('./channel-config.js')).ASSISTANT_NAME).toBe('Skoobi');

    delete process.env.ASSISTANT_NAME;
    vi.resetModules();
    expect((await import('./channel-config.js')).ASSISTANT_NAME).toBe('Skoobi');
  });

  it('uses explicit state root and parses bounded observer settings', async () => {
    process.env.SKOOBI_WHATSAPP_STATE_ROOT = '/tmp/skoobi-wa-explicit';
    process.env.INIT_CWD = '/tmp/skoobi-wa-init';
    process.env.SKOOBI_WHATSAPP_PERSONAL_OBSERVER_ENABLED = 'true';
    process.env.SKOOBI_WHATSAPP_OWNER_FOLDER = 'wa_owner';
    process.env.SKOOBI_WHATSAPP_TEMPLATE_GROUP = 'telegram_template';
    process.env.SKOOBI_WHATSAPP_OBSERVER_RETENTION_DAYS = '365';
    process.env.SKOOBI_WHATSAPP_OBSERVER_MAX_ROWS = '75000';
    vi.resetModules();

    const config = await import('./channel-config.js');
    expect(config.WHATSAPP_STATE_ROOT).toBe('/tmp/skoobi-wa-explicit');
    expect(config.STORE_DIR).toBe('/tmp/skoobi-wa-explicit/store');
    expect(config.WHATSAPP_PERSONAL_OBSERVER).toEqual({
      enabled: true,
      ownerFolder: 'wa_owner',
      templateGroupFolder: 'telegram_template',
      retentionDays: 365,
      maxRows: 75_000,
    });
  });

  it('uses INIT_CWD for npm workspace auth and rejects unsafe/unbounded values', async () => {
    delete process.env.SKOOBI_WHATSAPP_STATE_ROOT;
    process.env.INIT_CWD = '/tmp/skoobi-wa-init';
    process.env.SKOOBI_WHATSAPP_PERSONAL_OBSERVER_ENABLED = 'yes';
    process.env.SKOOBI_WHATSAPP_OWNER_FOLDER = 'whatsapp.main';
    process.env.SKOOBI_WHATSAPP_TEMPLATE_GROUP = 'also/unsafe';
    process.env.SKOOBI_WHATSAPP_OBSERVER_RETENTION_DAYS = '999999';
    process.env.SKOOBI_WHATSAPP_OBSERVER_MAX_ROWS = '1';
    vi.resetModules();

    const config = await import('./channel-config.js');
    expect(config.WHATSAPP_STATE_ROOT).toBe(
      path.resolve('/tmp/skoobi-wa-init'),
    );
    expect(config.WHATSAPP_PERSONAL_OBSERVER).toEqual({
      enabled: false,
      ownerFolder: 'whatsapp_main',
      templateGroupFolder: undefined,
      retentionDays: 90,
      maxRows: 50_000,
    });
  });
});
