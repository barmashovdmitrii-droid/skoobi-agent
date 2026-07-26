import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { readEnvFile } from './env.js';
import type { OwnerAllowlistConfig } from './telegram-identity.js';

// State lives in the current working directory — the directory IS the
// instance (same semantics as the orchestrator's config.ts STATE_ROOT).
const STATE_ROOT = process.cwd();

const PRIVATE_ADMIN_ENV_KEYS = [
  'SKOOBI_RUNTIME_MODE',
  'SKOOBI_PRIVATE_ADMIN_MODE',
  'SKOOBI_PRIVATE_ADMIN_TELEGRAM_USER_IDS',
  'SKOOBI_CONFIG_FILE',
];

export type PrivateAdminConfig = {
  enabled: boolean;
  trustedTelegramUserIds: Set<string>;
  disableBilling: boolean;
  disableQuota: boolean;
  disablePayments: boolean;
};

function readOptionalYamlConfig(): any {
  const env = readEnvFile(['SKOOBI_CONFIG_FILE']);
  const configPath =
    env.SKOOBI_CONFIG_FILE || path.join(STATE_ROOT, 'skoobi.yaml');
  if (!fs.existsSync(configPath)) return {};
  try {
    return YAML.parse(fs.readFileSync(configPath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function boolFrom(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function idSetFrom(value: unknown): Set<string> {
  const parts: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) parts.push(String(item));
  } else if (typeof value === 'string') {
    parts.push(...value.split(/[,\s]+/));
  }
  return new Set(
    parts
      .map((item) => item.trim())
      .filter((item) => /^\d+$/.test(item)),
  );
}

export function loadPrivateAdminConfig(
  overrides: Partial<PrivateAdminConfig> = {},
): PrivateAdminConfig {
  const yamlConfig = readOptionalYamlConfig();
  const env = readEnvFile(PRIVATE_ADMIN_ENV_KEYS);
  const runtime =
    yamlConfig.runtime?.private_admin ||
    yamlConfig.runtimes?.private_admin ||
    yamlConfig.skoobi_private_admin ||
    {};
  const mode = String(
    env.SKOOBI_RUNTIME_MODE ||
      process.env.SKOOBI_RUNTIME_MODE ||
      runtime.mode ||
      '',
  )
    .trim()
    .toLowerCase();
  const enabled =
    overrides.enabled ??
    boolFrom(
      env.SKOOBI_PRIVATE_ADMIN_MODE ??
        process.env.SKOOBI_PRIVATE_ADMIN_MODE ??
        runtime.enabled,
      mode === 'private_admin',
    );
  const envIds = idSetFrom(
    env.SKOOBI_PRIVATE_ADMIN_TELEGRAM_USER_IDS ||
      process.env.SKOOBI_PRIVATE_ADMIN_TELEGRAM_USER_IDS,
  );
  const yamlIds = idSetFrom(runtime.telegram_user_ids || runtime.telegramUserIds);
  const trustedTelegramUserIds =
    overrides.trustedTelegramUserIds ??
    new Set([...envIds, ...yamlIds]);

  return {
    enabled,
    trustedTelegramUserIds,
    disableBilling:
      overrides.disableBilling ?? boolFrom(runtime.disable_billing, true),
    disableQuota: overrides.disableQuota ?? boolFrom(runtime.disable_quota, true),
    disablePayments:
      overrides.disablePayments ?? boolFrom(runtime.disable_payments, true),
  };
}

export function privateAdminModeEnabled(
  config = loadPrivateAdminConfig(),
): boolean {
  return config.enabled === true;
}

export function privateAdminDisablesCommercialRuntime(
  config = loadPrivateAdminConfig(),
): boolean {
  return (
    config.enabled === true &&
    config.disableBilling === true &&
    config.disableQuota === true &&
    config.disablePayments === true
  );
}

export function isPrivateAdminTelegramUser(input: {
  telegramUserId?: string | number | null;
  ownerAllowlist?: OwnerAllowlistConfig;
  config?: PrivateAdminConfig;
}): boolean {
  const config = input.config ?? loadPrivateAdminConfig();
  if (!config.enabled) return false;
  const id =
    input.telegramUserId === undefined || input.telegramUserId === null
      ? ''
      : String(input.telegramUserId).trim();
  if (!id) return false;
  if (config.trustedTelegramUserIds.has(id)) return true;
  return input.ownerAllowlist?.telegram_user_ids.has(id) === true;
}

export function privateAdminClosedBotText(): string {
  return 'Это закрытый private/admin бот. Доступ есть только у доверенных владельцев/admin users.';
}
