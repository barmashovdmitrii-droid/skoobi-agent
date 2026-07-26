// Конфиг-значения канала — точная реплика дериваций orchestrator/config.ts
// (волна 7c): те же .env-ключи через @skoobi/shared readEnvFile, те же
// fallback'и, GROUPS_DIR/DATA_DIR — от process.cwd() (сервис бежит из
// рабочего дерева). Пакет не импортирует core-config; при изменении этих
// дериваций в config.ts — менять синхронно (значения обязаны совпадать).
import path from 'path';

import {
  createAssistantTriggerPattern,
  normalizeAssistantName,
} from '@skoobi/shared/assistant-name';
import { readEnvFile } from '@skoobi/shared/env';

const envConfig = readEnvFile(['ASSISTANT_NAME', 'RUNTIME', 'TZ']);

export const ASSISTANT_NAME = normalizeAssistantName(
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME,
);
export const TRIGGER_PATTERN = createAssistantTriggerPattern(ASSISTANT_NAME);

export const DEFAULT_RUNTIME: 'container' | 'sandbox' =
  (process.env.RUNTIME || envConfig.RUNTIME || 'container') === 'sandbox'
    ? 'sandbox'
    : 'container';

export const TIMEZONE =
  process.env.TZ ||
  envConfig.TZ ||
  Intl.DateTimeFormat().resolvedOptions().timeZone;

export const GROUPS_DIR = path.resolve(process.cwd(), 'groups');
export const DATA_DIR = path.resolve(process.cwd(), 'data');
