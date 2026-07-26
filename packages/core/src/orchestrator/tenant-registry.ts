import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { isValidGroupFolder } from './group-folder.js';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';
import {
  defaultTelegramIdentityId,
  parseTelegramJid,
  telegramJidToBotId,
} from '@skoobi/shared/telegram-jid';
import {
  createTelegramSenderIdentity,
  DEFAULT_PERSONA_ID,
  defaultTelegramBotId,
  isDefaultTelegramBotId,
  loadOwnerAllowlistFromEnv,
  parseOwnerAllowlistConfig,
  safeTelegramBotId,
  telegramJidForChatId,
  telegramJidToChatId,
  type OwnerAllowlistConfig,
} from '@skoobi/shared/telegram-identity';
import type {
  RegisteredGroup,
  SenderIdentity,
  SkoobiRuntimeMode,
} from './types.js';

// Чистые tg:-JID утилиты переехали в @skoobi/shared (волна 5), а env+pure
// identity-семейство (bot id, owner-allowlist, SenderIdentity) — в
// @skoobi/shared/telegram-identity (волна 7a). Ре-экспорт сохраняет прежний
// публичный API tenant-registry.
export { defaultTelegramIdentityId, parseTelegramJid, telegramJidToBotId };
export {
  createTelegramSenderIdentity,
  defaultTelegramBotId,
  isDefaultTelegramBotId,
  loadOwnerAllowlistFromEnv,
  parseOwnerAllowlistConfig,
  safeTelegramBotId,
  telegramJidForChatId,
  telegramJidToChatId,
  type OwnerAllowlistConfig,
};

export interface TenantApprovedSender {
  telegram_user_id: string;
  role?: string;
}

export interface TenantJson {
  tenant_id?: string;
  folder?: string;
  channel?: 'telegram';
  chat_id?: string;
  bot_id?: string;
  persona_id?: string;
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
  bot_id?: string;
  persona_id?: string;
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

const RUNTIME_MODES = new Set<SkoobiRuntimeMode>([
  'claude_sdk',
  'skoobi_shadow',
  'skoobi_live',
]);
const MAX_TENANT_JSON_BYTES = 256 * 1024;

export function parseSkoobiRuntimeMode(value: unknown): SkoobiRuntimeMode {
  return typeof value === 'string' &&
    RUNTIME_MODES.has(value as SkoobiRuntimeMode)
    ? (value as SkoobiRuntimeMode)
    : 'claude_sdk';
}

function isTelegramThreadJid(jid: string): boolean {
  return Boolean(parseTelegramJid(jid)?.threadId);
}

export function defaultTelegramTenantId(chatId: string): string {
  const safe = chatId.trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return `tg_chat_${safe || 'unknown'}`;
}

// Finding #30: trusted, deterministic tenant_id derived ONLY from the
// host-controlled (botId, chatId) pair. For the default bot this is exactly the
// legacy `tg_chat_<chatId>` id (so existing default-bot tenants/quota accounts
// keep their key); for a persona bot it is namespaced by the bot id so that two
// persona bots sharing a chat_id still get distinct, unforgeable ids. Used as
// the canonical tenant_id for untrusted (guest) groups, which must never be
// allowed to pick their own tenant_id (quota/plan grants key on tenant_id, so a
// guest-chosen id enables quota reset/evasion or charging a victim tenant).
export function trustedTelegramTenantId(
  chatId: string,
  botId?: string,
): string {
  const safeBotId = safeTelegramBotId(botId);
  if (isDefaultTelegramBotId(safeBotId)) return defaultTelegramTenantId(chatId);
  const safeChat = chatId.trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
  return `tg_${safeBotId}_chat_${safeChat}`;
}

function telegramChatKey(chatId: string | number, botId?: string): string {
  return `${safeTelegramBotId(botId)}:${String(chatId)}`;
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
    bot_id: stringValue(obj.bot_id),
    persona_id: stringValue(obj.persona_id),
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
  const parsedJid = parseTelegramJid(jid);
  if (!parsedJid) return null;
  const chatId = parsedJid.chatId;

  const groupDir = resolveGroupDir(groupsDir, group.folder);
  if (!groupDir) return null;

  let parsed: TenantJson;
  try {
    const tenantJson = readBoundedRegularFileNoFollowSync(
      path.join(groupDir, 'tenant.json'),
      {
        maxBytes: MAX_TENANT_JSON_BYTES,
        oversize: 'reject',
        requireSingleLink: true,
      },
    ).buffer.toString('utf8');
    parsed = parseTenantJson(
      JSON.parse(tenantJson),
    );
  } catch {
    return null;
  }

  if (parsed.channel && parsed.channel !== 'telegram') return null;
  if (parsed.chat_id && parsed.chat_id !== chatId) return null;
  if (parsed.bot_id && parsedJid.botId && parsed.bot_id !== parsedJid.botId) {
    return null;
  }
  if (parsed.folder && parsed.folder !== group.folder) return null;

  return parsed;
}

function tenantRecordFromGroup(
  groupsDir: string,
  jid: string,
  group: RegisteredGroup,
): TenantRecord | null {
  const parsedJid = parseTelegramJid(jid);
  if (!parsedJid) return null;
  const chatId = parsedJid.chatId;

  const tenant = loadTenantJson(groupsDir, jid, group);
  // Finding #30: the group dir (and therefore tenant.json) is mounted
  // read-WRITE into the guest sandbox, so for an UNTRUSTED group every
  // trust-relevant field must come from host state, not the file. Only a
  // trusted MAIN group (group.isMain, sourced from the DB / directory layout,
  // never from tenant.json) may carry an operator-provisioned custom tenant_id.
  const isTrustedGroup = group.isMain === true;
  // bot_id is host-derived here: the JID's botId is set by the host event loop,
  // and loadTenantJson() already rejects any file bot_id that disagrees with it.
  const botId = parsedJid.botId || defaultTelegramBotId();
  return {
    // Bind tenant_id to the trusted (botId, chatId) pair for guests so an
    // untrusted guest cannot reset its quota with a fresh id or charge a
    // victim by claiming another tenant's id. Custom ids are honored only for
    // trusted main groups.
    tenant_id:
      (isTrustedGroup && tenant?.tenant_id) ||
      trustedTelegramTenantId(chatId, botId),
    folder: group.folder,
    channel: 'telegram',
    chat_id: chatId,
    bot_id: tenant?.bot_id || botId,
    persona_id:
      tenant?.persona_id || group.agentConfig?.personaId || DEFAULT_PERSONA_ID,
    // mode is computed solely from trusted host state (group.isMain). A
    // guest-supplied tenant.json `mode:"owner"` must NOT escalate the record.
    mode: group.isMain ? 'owner' : 'guest',
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
  private readonly byTelegramChatKey = new Map<string, TenantRecord>();
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
        !registry.byTelegramChatKey.has(
          telegramChatKey(record.chat_id, record.bot_id),
        ) ||
        !isTelegramThreadJid(jid)
      ) {
        registry.byTelegramChatKey.set(
          telegramChatKey(record.chat_id, record.bot_id),
          record,
        );
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

  resolveTelegramChat(
    chatId: string | number,
    botId?: string,
  ): TenantRecord | undefined {
    // Bot-explicit on the hot path: a missing botId resolves to the default
    // bot id so default-bot JIDs map deterministically against records keyed
    // under defaultTelegramBotId().
    const resolvedBotId = botId ?? defaultTelegramBotId();
    const explicit = this.byTelegramChatKey.get(
      telegramChatKey(chatId, resolvedBotId),
    );
    if (explicit || botId) return explicit;

    // Default-bot fallback only resolves when the chat_id is unambiguous (a
    // single tenant). When multiple persona bots share a chat_id we must NOT
    // guess, since a chat_id-only scan can resolve to the wrong tenant and
    // leak its persona/tenant_id/quota across bots.
    const chatKey = String(chatId);
    let match: TenantRecord | undefined;
    for (const record of this.byTelegramChatKey.values()) {
      if (record.chat_id !== chatKey) continue;
      if (match) return undefined;
      match = record;
    }
    return match;
  }

  resolveTelegramJid(jid: string): TenantRecord | undefined {
    const parsed = parseTelegramJid(jid);
    return parsed
      ? this.resolveTelegramChat(parsed.chatId, parsed.botId)
      : undefined;
  }

  resolveTenant(tenantId: string): TenantRecord | undefined {
    return this.byTenantId.get(tenantId);
  }

  all(): TenantRecord[] {
    return [...this.byTenantId.values()];
  }
}
