// Конфиг-значения канала — точная реплика дериваций orchestrator/config.ts
// (паттерн волны 7c): те же .env-ключи через @skoobi/shared readEnvFile, те же
// fallback'и. Для runtime STATE_ROOT остаётся cwd; auth CLI, который npm
// запускает из workspace-папки, возвращается к instance root через INIT_CWD.
// Явный SKOOBI_WHATSAPP_STATE_ROOT имеет высший приоритет.
import path from 'path';

import { normalizeAssistantName } from '@skoobi/shared/assistant-name';
import { readEnvFile } from '@skoobi/shared/env';
import { isValidGroupFolder } from '@skoobi/shared/group-folder';

const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'SKOOBI_WHATSAPP_STATE_ROOT',
  'SKOOBI_WHATSAPP_PERSONAL_OBSERVER_ENABLED',
  'SKOOBI_WHATSAPP_OWNER_FOLDER',
  'SKOOBI_WHATSAPP_TEMPLATE_GROUP',
  'SKOOBI_WHATSAPP_OBSERVER_RETENTION_DAYS',
  'SKOOBI_WHATSAPP_OBSERVER_MAX_ROWS',
]);

function envValue(name: keyof typeof envConfig): string | undefined {
  return process.env[name] || envConfig[name];
}

function safeFolder(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return isValidGroupFolder(trimmed) ? trimmed : undefined;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export const ASSISTANT_NAME = normalizeAssistantName(
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME,
);

export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

/**
 * npm changes cwd to the workspace for `npm run auth -w ...`. INIT_CWD keeps
 * the instance root selected by the operator. The explicit override is useful
 * for service managers, but is never inferred from a phone number/JID.
 */
export const WHATSAPP_STATE_ROOT = path.resolve(
  envValue('SKOOBI_WHATSAPP_STATE_ROOT') ||
    process.env.INIT_CWD ||
    process.cwd(),
);

export const STORE_DIR = path.join(WHATSAPP_STATE_ROOT, 'store');

export interface WhatsAppPersonalObserverConfig {
  enabled: boolean;
  ownerFolder: string;
  templateGroupFolder?: string;
  retentionDays: number;
  maxRows: number;
}

export const WHATSAPP_PERSONAL_OBSERVER: WhatsAppPersonalObserverConfig = {
  enabled:
    envValue('SKOOBI_WHATSAPP_PERSONAL_OBSERVER_ENABLED')
      ?.trim()
      .toLowerCase() === 'true',
  ownerFolder:
    safeFolder(envValue('SKOOBI_WHATSAPP_OWNER_FOLDER')) || 'whatsapp_main',
  templateGroupFolder: safeFolder(envValue('SKOOBI_WHATSAPP_TEMPLATE_GROUP')),
  retentionDays: boundedInteger(
    envValue('SKOOBI_WHATSAPP_OBSERVER_RETENTION_DAYS'),
    90,
    1,
    3650,
  ),
  maxRows: boundedInteger(
    envValue('SKOOBI_WHATSAPP_OBSERVER_MAX_ROWS'),
    50_000,
    100,
    1_000_000,
  ),
};
