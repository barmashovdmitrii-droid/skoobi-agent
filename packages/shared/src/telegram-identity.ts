// Telegram-identity семейство (env+pure): дефолтный bot id, owner-allowlist,
// построение SenderIdentity — вынесено из orchestrator/tenant-registry в
// @skoobi/shared (волна 7a): нужно и ядру, и каналу telegram как отдельному
// кирпичу. Ни БД, ни core-config — только .env (readEnvFile) и текст.
import { readEnvFile } from './env.js';
import {
  defaultTelegramIdentityId,
  parseTelegramJid,
  telegramBotIdJidSegment,
} from './telegram-jid.js';
import type { SenderIdentity } from './channel-types.js';

export interface OwnerAllowlistConfig {
  telegram_user_ids: Set<string>;
  telegram_chat_ids: Set<string>;
}

const OWNER_ALLOWLIST_ENV_KEYS = [
  'OWNER_TELEGRAM_USER_IDS',
  'OWNER_TELEGRAM_CHAT_IDS',
];
const TELEGRAM_BOT_ENV_KEYS = ['SKOOBI_TELEGRAM_BOT_ID'];
const DEFAULT_BOT_ID = 'telegram_default';
// Экспортирован (был приватным в tenant-registry): нужен и ядру (persona по
// умолчанию для tenant'а), и каналу.
export const DEFAULT_PERSONA_ID = 'default';

export function safeTelegramBotId(value: string | undefined): string {
  return (
    (value || DEFAULT_BOT_ID)
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .replace(/^_+|_+$/g, '') || DEFAULT_BOT_ID
  );
}

export function isDefaultTelegramBotId(value: string | undefined): boolean {
  return safeTelegramBotId(value) === DEFAULT_BOT_ID;
}

export function telegramJidToChatId(jid: string): string | null {
  const parsed = parseTelegramJid(jid);
  return parsed?.chatId ?? null;
}

export function telegramJidForChatId(
  chatId: string | number,
  botId?: string,
): string {
  const safeBotId = safeTelegramBotId(botId);
  return isDefaultTelegramBotId(safeBotId)
    ? `tg:${chatId}`
    : `tg:${telegramBotIdJidSegment(safeBotId)}:${chatId}`;
}

export function defaultTelegramBotId(): string {
  const envConfig = readEnvFile(TELEGRAM_BOT_ENV_KEYS);
  const value = (
    process.env.SKOOBI_TELEGRAM_BOT_ID ||
    envConfig.SKOOBI_TELEGRAM_BOT_ID ||
    DEFAULT_BOT_ID
  ).trim();
  return safeTelegramBotId(value || DEFAULT_BOT_ID);
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
  botId?: string;
  personaId?: string;
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
    identity_id: defaultTelegramIdentityId(telegramUserId),
    bot_id: args.botId || defaultTelegramBotId(),
    persona_id: args.personaId,
    username_hint: args.usernameHint,
    display_name_hint: args.displayNameHint,
    is_owner_sender:
      telegramUserId.length > 0 &&
      ownerAllowlist.telegram_user_ids.has(telegramUserId) &&
      chatAllowed,
  };
}
