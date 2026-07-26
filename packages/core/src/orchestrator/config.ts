import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';

import {
  createAssistantTriggerPattern,
  normalizeAssistantName,
} from '@skoobi/shared/assistant-name';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'RUNTIME',
  'CONTAINER_IMAGE',
  'CONTAINER_TIMEOUT',
  'CONTAINER_MAX_OUTPUT_SIZE',
  'CLAUDECLAW_MAX_TRANSCRIPT_BYTES',
  'CREDENTIAL_PROXY_PORT',
  'CREDENTIAL_PROXY_HOST',
  'IDLE_TIMEOUT',
  'RUNNER_IDLE_WAIT_MS',
  'MAX_CONCURRENT_CONTAINERS',
  'TZ',
]);

export const ASSISTANT_NAME = normalizeAssistantName(
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME,
);
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'claudeclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'claudeclaw',
  'sender-allowlist.json',
);
// Code root: where the claudeclaw source/dist lives (the repo root — agent/,
// scripts/ and extensions/ are resolved against it, see sandbox-runner).
// Derived from this file's location inside the @skoobi/core package:
// packages/core/{src|dist}/orchestrator/config.{ts|js} → ../../../../
// In developer mode: same as STATE_ROOT.
// In plugin mode: the plugin code directory (different from STATE_ROOT).
export function resolveCodeRootFromModuleUrl(moduleUrl: string | URL): string {
  const thisDir = path.dirname(fileURLToPath(moduleUrl));
  return path.resolve(thisDir, '..', '..', '..', '..');
}

export const CODE_ROOT = resolveCodeRootFromModuleUrl(import.meta.url);

// State lives in the current working directory — always.
// In developer mode: cwd is the claudeclaw repo.
// In plugin mode: cwd is whatever directory the user ran `claude` from.
// The directory IS the instance. Multiple instances = multiple directories.
export const STATE_ROOT = process.cwd();

export const STORE_DIR = path.resolve(STATE_ROOT, 'store');
export const GROUPS_DIR = path.resolve(STATE_ROOT, 'groups');
export const LOG_DIR = path.resolve(STATE_ROOT, 'logs');
export const DATA_DIR = path.resolve(STATE_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE ||
  envConfig.CONTAINER_IMAGE ||
  'claudeclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || envConfig.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE ||
    envConfig.CONTAINER_MAX_OUTPUT_SIZE ||
    '10485760',
  10,
); // 10MB default
// Hard cap on a group's on-disk Claude SDK transcript (.jsonl) before the
// host archives it and rolls the group onto a fresh session. SDK
// auto-compaction only trims the in-context window, never the on-disk file,
// so a long-lived group's transcript grows unbounded until even compaction
// cannot fit it and every `claude --resume` fails with "Prompt is too long".
// The 40MB default leaves a wide margin below that failure point.
// NaN-guarded and floored at 1MB so a
// misconfiguration can't disable the guard or trigger pathological churn.
export const MAX_TRANSCRIPT_BYTES = Math.max(
  1024 * 1024,
  parseInt(
    process.env.CLAUDECLAW_MAX_TRANSCRIPT_BYTES ||
      envConfig.CLAUDECLAW_MAX_TRANSCRIPT_BYTES ||
      String(40 * 1024 * 1024),
    10,
  ) || 40 * 1024 * 1024,
);
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT ||
    envConfig.CREDENTIAL_PROXY_PORT ||
    '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || envConfig.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const RUNNER_IDLE_WAIT_MS = Math.max(
  1000,
  parseInt(
    process.env.RUNNER_IDLE_WAIT_MS ||
      envConfig.RUNNER_IDLE_WAIT_MS ||
      '15000',
    10,
  ) || 15000,
);
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(
    process.env.MAX_CONCURRENT_CONTAINERS ||
      envConfig.MAX_CONCURRENT_CONTAINERS ||
      '5',
    10,
  ) || 5,
);

export const TRIGGER_PATTERN = createAssistantTriggerPattern(ASSISTANT_NAME);

// Webhook server configuration
const webhookEnv = readEnvFile(['WEBHOOK_PORT', 'WEBHOOK_SECRET', 'WEBHOOK_HOST']);
export const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || webhookEnv.WEBHOOK_PORT || '3100', 10);
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || webhookEnv.WEBHOOK_SECRET || '';
// Bind to loopback by default; only expose on other interfaces behind an
// authenticated reverse proxy by setting WEBHOOK_HOST explicitly.
export const WEBHOOK_HOST = process.env.WEBHOOK_HOST || webhookEnv.WEBHOOK_HOST || '127.0.0.1';

// Runtime selection: 'container' (default, Apple Container / Docker) or 'sandbox' (srt)
export const DEFAULT_RUNTIME: 'container' | 'sandbox' =
  (process.env.RUNTIME || envConfig.RUNTIME || 'container') === 'sandbox'
    ? 'sandbox'
    : 'container';

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ ||
  envConfig.TZ ||
  Intl.DateTimeFormat().resolvedOptions().timeZone;
