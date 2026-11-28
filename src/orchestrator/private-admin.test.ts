import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isPrivateAdminTelegramUser,
  loadPrivateAdminConfig,
} from './private-admin.js';

const previousEnv: Record<string, string | undefined> = {};

function rememberEnv(key: string) {
  if (!(key in previousEnv)) previousEnv[key] = process.env[key];
}

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(previousEnv)) delete previousEnv[key];
}

function isolatedEnvFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-private-admin-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(
    envFile,
    `SKOOBI_CONFIG_FILE=${path.join(dir, 'missing.yaml')}\n`,
    'utf8',
  );
  return envFile;
}

beforeEach(() => {
  for (const key of [
    'CLAUDECLAW_ENV_FILE',
    'SKOOBI_RUNTIME_MODE',
    'SKOOBI_PRIVATE_ADMIN_MODE',
    'SKOOBI_PRIVATE_ADMIN_TELEGRAM_USER_IDS',
  ]) {
    rememberEnv(key);
    delete process.env[key];
  }
  process.env.CLAUDECLAW_ENV_FILE = isolatedEnvFile();
});

afterEach(() => {
  const envFile = process.env.CLAUDECLAW_ENV_FILE;
  restoreEnv();
  if (envFile) fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
});

describe('private admin mode', () => {
  it('loads private_admin from env and keeps owner/admin allowlist simple', () => {
    process.env.SKOOBI_RUNTIME_MODE = 'private_admin';
    process.env.SKOOBI_PRIVATE_ADMIN_TELEGRAM_USER_IDS = '7000000002';

    const config = loadPrivateAdminConfig();

    expect(config.enabled).toBe(true);
    expect(config.trustedTelegramUserIds.has('7000000002')).toBe(true);
    expect(
      isPrivateAdminTelegramUser({
        telegramUserId: '100000001',
        ownerAllowlist: {
          telegram_user_ids: new Set(['100000001']),
          telegram_chat_ids: new Set(),
        },
        config,
      }),
    ).toBe(true);
    expect(
      isPrivateAdminTelegramUser({ telegramUserId: '555', config }),
    ).toBe(false);
  });

});
