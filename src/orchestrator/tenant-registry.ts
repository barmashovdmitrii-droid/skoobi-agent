import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { isValidGroupFolder } from './group-folder.js';
import type {
  RegisteredGroup,
  SenderIdentity,
  SkoobiRuntimeMode,
} from './types.js';

export interface TenantApprovedSender {
  telegram_user_id: string;
  role?: string;
}

export interface TenantJson {
  tenant_id?: string;
  folder?: string;
  channel?: 'telegram';
  chat_id?: string;
  mode?: string;
  language?: string;
  runtime?: SkoobiRuntimeMode;
  approved_senders?: TenantApprovedSender[];
  models?: Record<string, string>;
  quota?: {
    enabled?: boolean;
  };
}

export interface TenantRecord {
  tenant_id: string;
  folder: string;
  channel: 'telegram';
  chat_id: string;
  mode: string;
  runtime: SkoobiRuntimeMode;
  language?: string;
  approved_senders: TenantApprovedSender[];
  models: Record<string, string>;
  quota: {
    enabled: boolean;
  };
  legacy_jid: string;
  source: 'tenant_json' | 'legacy_registered_group';
  group: RegisteredGroup;
}

export interface TenantRegistryOptions {
  groupsDir?: string;
}

export interface OwnerAllowlistConfig {
  telegram_user_ids: Set<string>;
  telegram_chat_ids: Set<string>;
}

const RUNTIME_MODES = new Set<SkoobiRuntimeMode>([
  'claude_sdk',
  'skoobi_shadow',
  'skoobi_live',
]);

const OWNER_ALLOWLIST_ENV_KEYS = [
  'OWNER_TELEGRAM_USER_IDS',
  'OWNER_TELEGRAM_CHAT_IDS',
];

export function parseSkoobiRuntimeMode(value: unknown): SkoobiRuntimeMode {
  return typeof value === 'string' &&
    RUNTIME_MODES.has(value as SkoobiRuntimeMode)
    ? (value as SkoobiRuntimeMode)
    : 'claude_sdk';
}

export function telegramJidToChatId(jid: string): string | null {
  if (!jid.startsWith('tg:')) return null;
  const value = jid.slice(3);
  const threadSep = value.indexOf(':');
  return threadSep === -1 ? value : value.slice(0, threadSep);
}

function isTelegramThreadJid(jid: string): boolean {
  return jid.startsWith('tg:') && jid.slice(3).includes(':');
}

export function defaultTelegramTenantId(chatId: string): string {
  const safe = chatId.trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return `tg_chat_${safe || 'unknown'}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') result[key] = raw;
  }
  return result;
}

function approvedSenders(value: unknown): TenantApprovedSender[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Record<string, unknown>;
      const telegramUserId = stringValue(raw.telegram_user_id);
      if (!telegramUserId) return null;
      const role = stringValue(raw.role);
      return role
        ? { telegram_user_id: telegramUserId, role }
        : { telegram_user_id: telegramUserId };
    })
    .filter((item): item is TenantApprovedSender => item !== null);
}

export function parseTenantJson(raw: unknown): TenantJson {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('tenant.json must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;
  const channel = stringValue(obj.channel);
  if (channel && channel !== 'telegram') {
    throw new Error(`Unsupported tenant channel: ${channel}`);
  }

  const quota =
    obj.quota && typeof obj.quota === 'object' && !Array.isArray(obj.quota)
      ? { enabled: (obj.quota as Record<string, unknown>).enabled === true }
      : undefined;

  return {
    tenant_id: stringValue(obj.tenant_id),
    folder: stringValue(obj.folder),
    channel: channel === 'telegram' ? 'telegram' : undefined,
    chat_id: stringValue(obj.chat_id),
    mode: stringValue(obj.mode),
    language: stringValue(obj.language),
    runtime: parseSkoobiRuntimeMode(obj.runtime),
    approved_senders: approvedSenders(obj.approved_senders),
    models: stringRecord(obj.models),
    quota,
  };
}

function resolveGroupDir(groupsDir: string, folder: string): string | null {
  if (!isValidGroupFolder(folder)) return null;
  const baseDir = path.resolve(groupsDir);
  const groupDir = path.resolve(baseDir, folder);
  const rel = path.relative(baseDir, groupDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return groupDir;
}

function loadTenantJson(
  groupsDir: string,
  jid: string,
  group: RegisteredGroup,
): TenantJson | null {
  const chatId = telegramJidToChatId(jid);
  if (!chatId) return null;

  const groupDir = resolveGroupDir(groupsDir, group.folder);
  if (!groupDir) return null;

  let parsed: TenantJson;
  try {
    parsed = parseTenantJson(
      JSON.parse(fs.readFileSync(path.join(groupDir, 'tenant.json'), 'utf8')),
    );
  } catch {
    return null;
  }

  if (parsed.channel && parsed.channel !== 'telegram') return null;
  if (parsed.chat_id && parsed.chat_id !== chatId) return null;
  if (parsed.folder && parsed.folder !== group.folder) return null;

  return parsed;
}

function tenantRecordFromGroup(
  groupsDir: string,
  jid: string,
  group: RegisteredGroup,
): TenantRecord | null {
  const chatId = telegramJidToChatId(jid);
  if (!chatId) return null;

  const tenant = loadTenantJson(groupsDir, jid, group);
  return {
    tenant_id: tenant?.tenant_id || defaultTelegramTenantId(chatId),
    folder: group.folder,
    channel: 'telegram',
    chat_id: chatId,
    mode: tenant?.mode || (group.isMain ? 'owner' : 'guest'),
    runtime: parseSkoobiRuntimeMode(tenant?.runtime),
    language: tenant?.language,
    approved_senders: tenant?.approved_senders || [],
    models: tenant?.models || {},
    quota: { enabled: tenant?.quota?.enabled === true },
    legacy_jid: jid,
    source: tenant ? 'tenant_json' : 'legacy_registered_group',
    group,
  };
}

export class TenantRegistry {
  private readonly byTelegramChatId = new Map<string, TenantRecord>();
  private readonly byTenantId = new Map<string, TenantRecord>();

  static fromRegisteredGroups(
    groups: Record<string, RegisteredGroup>,
    options: TenantRegistryOptions = {},
  ): TenantRegistry {
    const registry = new TenantRegistry();
    const groupsDir = options.groupsDir || GROUPS_DIR;
    for (const [jid, group] of Object.entries(groups)) {
      const record = tenantRecordFromGroup(groupsDir, jid, group);
      if (!record) continue;
      if (
        !registry.byTelegramChatId.has(record.chat_id) ||
        !isTelegramThreadJid(jid)
      ) {
        registry.byTelegramChatId.set(record.chat_id, record);
      }
      if (
        !registry.byTenantId.has(record.tenant_id) ||
        !isTelegramThreadJid(jid)
      ) {
        registry.byTenantId.set(record.tenant_id, record);
      }
    }
    return registry;
  }

  resolveTelegramChat(chatId: string | number): TenantRecord | undefined {
    return this.byTelegramChatId.get(String(chatId));
  }

  resolveTelegramJid(jid: string): TenantRecord | undefined {
    const chatId = telegramJidToChatId(jid);
    return chatId ? this.resolveTelegramChat(chatId) : undefined;
  }

  resolveTenant(tenantId: string): TenantRecord | undefined {
    return this.byTenantId.get(tenantId);
  }

  all(): TenantRecord[] {
    return [...this.byTenantId.values()];
  }
}

function stringSet(value: unknown): Set<string> {
  if (Array.isArray(value)) {
    return new Set(
      value
        .map((item) =>
          item === undefined || item === null ? '' : String(item),
        )
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }
  if (typeof value === 'string') {
    return new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }
  return new Set();
}

export function parseOwnerAllowlistConfig(
  raw: Record<string, unknown>,
): OwnerAllowlistConfig {
  return {
    telegram_user_ids: stringSet(
      raw.telegram_user_ids ??
        raw.telegramUserIds ??
        raw.OWNER_TELEGRAM_USER_IDS,
    ),
    telegram_chat_ids: stringSet(
      raw.telegram_chat_ids ??
        raw.telegramChatIds ??
        raw.OWNER_TELEGRAM_CHAT_IDS,
    ),
  };
}

export function loadOwnerAllowlistFromEnv(): OwnerAllowlistConfig {
  const envConfig = readEnvFile(OWNER_ALLOWLIST_ENV_KEYS);
  return parseOwnerAllowlistConfig({
    OWNER_TELEGRAM_USER_IDS:
      process.env.OWNER_TELEGRAM_USER_IDS || envConfig.OWNER_TELEGRAM_USER_IDS,
    OWNER_TELEGRAM_CHAT_IDS:
      process.env.OWNER_TELEGRAM_CHAT_IDS || envConfig.OWNER_TELEGRAM_CHAT_IDS,
  });
}

export function createTelegramSenderIdentity(args: {
  chatId: string | number;
  fromId: string | number | null | undefined;
  usernameHint?: string;
  displayNameHint?: string;
  ownerAllowlist?: OwnerAllowlistConfig;
}): SenderIdentity {
  const chatId = String(args.chatId);
  const telegramUserId =
    args.fromId === undefined || args.fromId === null
      ? ''
      : String(args.fromId);
  const ownerAllowlist =
    args.ownerAllowlist ||
    parseOwnerAllowlistConfig({
      telegram_user_ids: [],
      telegram_chat_ids: [],
    });
  const chatAllowed =
    ownerAllowlist.telegram_chat_ids.size === 0 ||
    ownerAllowlist.telegram_chat_ids.has(chatId);

  return {
    channel: 'telegram',
    chat_id: chatId,
    telegram_user_id: telegramUserId,
    username_hint: args.usernameHint,
    display_name_hint: args.displayNameHint,
    is_owner_sender:
      telegramUserId.length > 0 &&
      ownerAllowlist.telegram_user_ids.has(telegramUserId) &&
      chatAllowed,
  };
}
