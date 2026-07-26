import fs from 'fs';
import os from 'os';
import https from 'https';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { Api, Bot, InputFile } from 'grammy';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_RUNTIME,
  GROUPS_DIR,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './channel-config.js';
import { createAssistantMentionPattern } from '@skoobi/shared/assistant-name';
import { readEnvFile } from '@skoobi/shared/env';
import { logger } from '@skoobi/shared/logger';
import { hashShort } from '@skoobi/shared/log-sanitize';
import { tombstoneMarkdownTreeNoFollowSync } from '@skoobi/shared/safe-child-write';
import {
  isValidGroupFolder,
  resolveGroupFolderPath,
} from '@skoobi/shared/group-folder';
import { memoryTopicForFolder } from '@skoobi/memory/memory-context';
import {
  appendMediaEntry,
  listMedia,
  setKeep,
  type MediaEntry,
  type MediaType,
} from '@skoobi/shared/media-manifest';
import {
  createTelegramSenderIdentity,
  isDefaultTelegramBotId,
  loadOwnerAllowlistFromEnv,
  safeTelegramBotId,
  telegramJidForChatId,
  telegramJidToChatId,
  type OwnerAllowlistConfig,
} from '@skoobi/shared/telegram-identity';
import { telegramJidToBotId } from '@skoobi/shared/telegram-jid';
import type {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  OnTelegramCallbackQuery,
} from '@skoobi/shared/channel-types';
import { transcribeAudioFile } from '@skoobi/voice-stt';
import { downloadTelegramPhoto } from './photo-telegram.js';
import {
  pinLastMedia,
  storageForFolder,
  storageOverview,
} from './admin-storage.js';
import { downloadTelegramAudio } from './audio-telegram.js';
import {
  processTelegramVideoFile,
  processTelegramVideoNote,
} from './video-telegram.js';
import {
  documentPlaceholder,
  processTelegramDocument,
  safeTelegramDocumentName,
} from './document-telegram.js';
import { synthesizeVoice, ttsProvider, ttsVoiceName } from '@skoobi/voice-tts';
import {
  parseTelegramBotRuntimeConfigs,
  type TelegramBotRuntimeConfig,
} from './telegram-bot-config.js';

// --- Структурные view-типы ядра (пакет не импортирует root src) ---
// Ядровые TelegramRegisteredGroup / TelegramTenantView структурно шире этих view; обвязка
// (src/channels/telegram.ts) подставляет реальные объекты — совместимость
// проверяет tsc на границе сборки.

export interface TelegramRegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger?: boolean;
  isMain?: boolean;
  runtime?: 'container' | 'sandbox';
  agentConfig?: {
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
    systemPrompt?: string;
    personaId?: string;
    mediaIngestion?: boolean;
    codexFullAgentPrimary?: boolean;
    allowedTools?: string[];
    disallowedTools?: string[];
  };
}

export interface TelegramTenantView {
  tenant_id: string;
  folder: string;
  channel: 'telegram';
  chat_id: string;
  bot_id?: string;
  persona_id?: string;
}

export interface TelegramTenantRegistryView {
  resolveTelegramChat(
    chatId: string | number,
    botId?: string,
  ): TelegramTenantView | undefined;
}

export type TelegramPlanPurchase = (input: {
  /** Stable Telegram update/callback id, reused when delivery is retried. */
  purchaseId: string;
  planCode: string;
  chatJid: string;
  telegramUserId: string | number;
  tenantId?: string;
  channelUserId?: string;
  botUsername?: string;
}) => Promise<{ resultUrl: string } | null>;

// --- Host: узкая поверхность ядра, инжектится обвязкой ---
// SQL по chats/messages, события, квота и приватный админ-режим живут в ядре;
// канал получает только именованные функции.

export interface TelegramChannelHost {
  knownChatNames(jids: string[]): Array<{ jid: string; name: string | null }>;
  statsUsersToday(sinceIso: string): TelegramStatsUserRow[];
  statsTotalsToday(sinceIso: string): TelegramStatsTotalsRow | undefined;
  chatsLastSeen(
    jids: string[],
  ): Array<{ jid: string; last_message_time: string | null }>;
  messagesToday(): number;
  recordTenantEvent(event: {
    tenant: TelegramTenantView;
    type:
      | 'quota_balance_viewed'
      | 'memory_delete_requested'
      | 'memory_deleted'
      | 'memory_delete_unavailable';
    actor: string;
    senderId: string;
    payload: Record<string, unknown>;
  }): void;
  quotaStatusTextRu(input: {
    tenantId: string;
    channel: 'telegram';
    channelUserId: string;
  }): string;
  privateAdminModeEnabled(): boolean;
  isPrivateAdminTelegramUser(input: {
    telegramUserId?: string | number | null;
    ownerAllowlist?: OwnerAllowlistConfig;
  }): boolean;
  privateAdminClosedBotText(): string;
  captionPhoto(
    photoPath: string,
    costMeta?: { groupFolder?: string; chatJid?: string },
  ): Promise<string | null>;
}

const execFileAsync = promisify(execFile);

export function retentionScriptPath(
  moduleUrl: string | URL = import.meta.url,
): string {
  return path.resolve(
    path.dirname(fileURLToPath(moduleUrl)),
    '../../../dist/scripts/retention.js',
  );
}

const PUBLIC_BOT_COMMANDS = [
  { command: 'start', description: 'показать инструкцию' },
  { command: 'limit', description: 'статус доступа' },
  { command: 'chatid', description: 'показать ID этого чата' },
];

const COMMAND_ADMIN_BOT_COMMANDS = [
  { command: 'engine', description: 'движок чата: модели и подписки' },
  { command: 'stats', description: 'кто был онлайн сегодня' },
];

const OWNER_BOT_COMMANDS = [
  ...PUBLIC_BOT_COMMANDS,
  ...COMMAND_ADMIN_BOT_COMMANDS,
  { command: 'pending', description: 'заявки на доступ' },
  { command: 'users', description: 'список Telegram-пользователей' },
  { command: 'lastseen', description: 'последняя активность пользователей' },
  { command: 'health', description: 'состояние сервиса и очередей' },
  { command: 'status', description: 'подробный runtime status' },
  {
    command: 'storage',
    description: 'размер групп; /storage <folder> — детали',
  },
  { command: 'cleanup', description: '/cleanup dry — отчёт retention' },
  { command: 'keep', description: '/keep last — закрепить последнее медиа' },
  { command: 'limits', description: 'статус пользователя' },
  { command: 'pause', description: 'временно остановить пользователя' },
  { command: 'resume', description: 'снять паузу/бан с пользователя' },
  { command: 'ban', description: 'заблокировать пользователя' },
];

const DEFAULT_ADMIN_ALERT_JIDS: string[] = [];
const COMMAND_ADMIN_IDS_ENV_KEY = 'SKOOBI_TELEGRAM_COMMAND_ADMIN_IDS';

function adminAlertJids(): Set<string> {
  const env = readEnvFile(['SKOOBI_TELEGRAM_ADMIN_ALERT_JIDS']);
  const raw =
    process.env.SKOOBI_TELEGRAM_ADMIN_ALERT_JIDS ||
    env.SKOOBI_TELEGRAM_ADMIN_ALERT_JIDS ||
    DEFAULT_ADMIN_ALERT_JIDS.join(',');
  const jids = raw
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith('tg:') ? item : `tg:${item}`));
  return new Set(jids.length > 0 ? jids : DEFAULT_ADMIN_ALERT_JIDS);
}

function isAdminAlertRecipient(jid: string): boolean {
  return adminAlertJids().has(jid);
}

function commandAdminUserIds(): Set<string> {
  const env = readEnvFile([COMMAND_ADMIN_IDS_ENV_KEY]);
  const raw =
    process.env[COMMAND_ADMIN_IDS_ENV_KEY] ||
    env[COMMAND_ADMIN_IDS_ENV_KEY] ||
    '';
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter((item) => /^\d+$/.test(item)),
  );
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, TelegramRegisteredGroup>;
  registerGroup?: (jid: string, group: TelegramRegisteredGroup) => void;
  tenantRegistry?: () => TelegramTenantRegistryView;
  ownerAllowlist?: () => OwnerAllowlistConfig;
  onTelegramCallbackQuery?: OnTelegramCallbackQuery;
  onPlanPurchase?: TelegramPlanPurchase;
  host: TelegramChannelHost;
  botId?: string;
  personaId?: string;
}

interface PendingTelegramUser {
  jid: string;
  name: string;
  username?: string;
  isBot?: boolean;
  chatType: string;
  language?: TelegramLanguageCode;
  requestedAt: string;
  lastSeenAt: string;
  lastNotifiedAt?: string;
  status: 'pending' | 'approved' | 'denied';
  approvedAt?: string;
  deniedAt?: string;
  folder?: string;
}

type PendingTelegramUsers = Record<string, PendingTelegramUser>;

interface TelegramAccessEntry {
  status?: 'paused' | 'banned';
  reason?: string;
  updatedAt?: string;
  outboundBlockedAt?: string;
  outboundBlockedReason?: string;
  lastOutboundErrorAt?: string;
  lastOutboundError?: string;
  deferAgentUntil?: string;
  deferredReason?: string;
  deferredCount?: number;
  messageTimestamps?: string[];
  mediaTimestamps?: string[];
  daily?: {
    date: string;
    messages: number;
    media: number;
  };
  lastLimitNoticeAt?: string;
  lastAdminAlertAt?: string;
}

type TelegramAccessState = Record<string, TelegramAccessEntry>;

interface PendingMemoryDeleteConfirmation {
  tenantId: string;
  chatId: string;
  senderId: string;
  folder: string;
  requestedAt: string;
  expiresAtMs: number;
}

interface MemoryDeletionResult {
  status: 'deleted' | 'unavailable';
  deletedFiles: string[];
  tombstoneFile?: string;
  reason?: string;
}

const TELEGRAM_LANGUAGE_CODES = ['ru', 'kk', 'uz', 'ky', 'en'] as const;
type TelegramLanguageCode = (typeof TELEGRAM_LANGUAGE_CODES)[number];

interface TelegramUserSettings {
  language?: TelegramLanguageCode;
  updatedAt?: string;
}

type TelegramUserSettingsState = Record<string, TelegramUserSettings>;

type TelegramInboundKind =
  | 'text'
  | 'photo'
  | 'video'
  | 'video-note'
  | 'voice'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'other';

interface TelegramInboxEntry {
  received_at: string;
  chat_jid: string;
  group_folder: string;
  message_id: string;
  sender: string;
  sender_name: string;
  timestamp: string;
  kind: TelegramInboundKind;
  telegram_message_origin?: 'direct' | 'forwarded' | 'quoted';
  deferred?: boolean;
  text?: string;
  caption?: string;
  file_id?: string;
  file_unique_id?: string;
  file_name?: string;
  media_group_id?: string;
}

interface InboundAccessDecision {
  accept: boolean;
  processNow: boolean;
  reason?: string;
}

const PENDING_TELEGRAM_USERS_FILE = path.join(
  DATA_DIR,
  'pending-telegram-users.json',
);
const TELEGRAM_ACCESS_CONTROL_FILE = path.join(
  DATA_DIR,
  'telegram-access-control.json',
);
const TELEGRAM_USER_SETTINGS_FILE = path.join(
  DATA_DIR,
  'telegram-user-settings.json',
);
const TELEGRAM_INBOX_DIR = path.join(DATA_DIR, 'telegram-inbox');
const APPROVAL_CALLBACK_RE = /^tgaccess:(approve|deny):(.+)$/;
const LANGUAGE_CALLBACK_RE = /^tglang:(ru|kk|uz|ky|en)$/;
const QUOTA_CALLBACK_RE = /^quota:my_limit$/;
const PLAN_CALLBACK_RE = /^buy:([a-z][a-z0-9_-]{0,31})$/;
const APPROVAL_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;
const MEMORY_DELETE_CONFIRMATION_PHRASE = 'ПОДТВЕРЖДАЮ УДАЛИТЬ ПАМЯТЬ';
const MEMORY_DELETE_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const MAX_MEMORY_DELETE_TOMBSTONE_BYTES = 4 * 1024 * 1024;
const GUEST_RATE_WINDOW_MS = 10 * 60 * 1000;
const GUEST_DAILY_DEFER_MS = 24 * 60 * 60 * 1000;
const GUEST_PROBATION_MS = 24 * 60 * 60 * 1000;
const GUEST_NOTICE_COOLDOWN_MS = 10 * 60 * 1000;
const GUEST_ADMIN_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const NO_LIMIT = Number.POSITIVE_INFINITY;
// RELIABILITY (finding #42): guest inbound rate/daily limits are INTENTIONALLY
// disabled (NO_LIMIT). With every field set to Infinity the comparisons in
// allowRegisteredInbound (messageTimestamps.length >= messagesPerWindow, the
// media check, and daily.messages >= messagesPerDay) can never be true, so the
// defer/alert machinery below them is effectively dormant for guests while the
// per-window/daily bookkeeping (timestamp pruning, daily counters) still runs.
// This is a deliberate product decision, not an oversight: guest spend is
// bounded by quota/billing elsewhere, and the channel-layer throttle is kept
// structurally in place (and trivially re-armable) by setting finite values
// here. The /limits and accessSummary surfaces report this honestly as
// "guest rate/daily limits отключены" (see accessSummary). If you re-enable
// throttling, restore finite numbers below and the existing defer/alert path
// activates automatically — no other code change is required.
const GUEST_PROBATION_LIMITS = {
  messagesPerWindow: NO_LIMIT,
  mediaPerWindow: NO_LIMIT,
  messagesPerDay: NO_LIMIT,
};
const GUEST_STEADY_LIMITS = {
  messagesPerWindow: NO_LIMIT,
  mediaPerWindow: NO_LIMIT,
  messagesPerDay: NO_LIMIT,
};

function normalizeIntentText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[!?.,:;'"`*_()[\]{}<>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeShortIntent(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  if (normalized.length > 80) return false;
  return normalized.split(/\s+/).length <= 8;
}

const QUOTA_TEXT_INTENTS = new Set([
  'покажи мой лимит',
  'покажи лимит',
  'какой у меня лимит',
  'сколько осталось',
  'сколько токенов осталось',
  'остаток токенов',
  'мой баланс',
  'покажи баланс',
  'сколько кредитов осталось',
  'лимит на неделю',
  'недельный лимит',
  'show my limit',
  'my limit',
  'my balance',
  'token balance',
  'how many credits left',
  'weekly limit',
]);

function isQuotaTextIntent(text: string): boolean {
  return (
    looksLikeShortIntent(text) &&
    QUOTA_TEXT_INTENTS.has(normalizeIntentText(text))
  );
}

const MEMORY_DELETE_TEXT_INTENTS = new Set([
  'удали память',
  'сотри память',
  'забудь меня',
  'забудь это',
  'откати память',
  'откати всю память',
  'удали всю память',
  'очисти память',
  'delete my memory',
  'forget me',
  'clear memory',
]);

function isMemoryDeleteTextIntent(text: string): boolean {
  return (
    looksLikeShortIntent(text) &&
    MEMORY_DELETE_TEXT_INTENTS.has(normalizeIntentText(text))
  );
}

function isMemoryDeleteConfirmation(text: string): boolean {
  return (
    text.trim().replace(/\s+/g, ' ').toUpperCase() ===
    MEMORY_DELETE_CONFIRMATION_PHRASE
  );
}

function looksLikeLooseMemoryDeleteConfirmation(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return (
    looksLikeShortIntent(text) &&
    (normalized === 'да' ||
      normalized === 'да удаляй' ||
      normalized === 'yes' ||
      normalized === 'confirm' ||
      normalized === 'подтверждаю')
  );
}

const FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const GUEST_BOUNDARY_MARKER =
  'CURRENT PROJECT MODE: personal Telegram guest profile';
const adminContactEnv = readEnvFile(['SKOOBI_ADMIN_CONTACT']);
const configuredAdminContact = (
  process.env.SKOOBI_ADMIN_CONTACT ||
  adminContactEnv.SKOOBI_ADMIN_CONTACT ||
  ''
).trim();
const ADMIN_CONTACT = /^@[A-Za-z0-9_]{5,32}$/u.test(configuredAdminContact)
  ? configuredAdminContact
  : 'the bot owner';
const ADMIN_LABEL = `администратор ${ADMIN_CONTACT}`;

function renderAdminContact(text: string): string {
  return text.replaceAll('<ADMIN_CONTACT>', ADMIN_CONTACT);
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    if (!isTelegramMarkdownParseError(err)) throw err;
    logger.debug(
      { err: sanitizeTelegramError(err) },
      'Markdown send failed, falling back to plain text',
    );
    await api.sendMessage(chatId, text, options);
  }
}

function telegramRetryAfterSeconds(err: unknown): number | null {
  const anyErr = err as {
    parameters?: { retry_after?: unknown };
    error?: { parameters?: { retry_after?: unknown } };
    response?: { parameters?: { retry_after?: unknown } };
  };
  const raw =
    anyErr?.parameters?.retry_after ??
    anyErr?.error?.parameters?.retry_after ??
    anyErr?.response?.parameters?.retry_after;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function isTelegramMarkdownParseError(err: unknown): boolean {
  const anyErr = err as {
    message?: unknown;
    description?: unknown;
    error?: { description?: unknown };
  };
  const text = [
    anyErr?.message,
    anyErr?.description,
    anyErr?.error?.description,
  ]
    .filter(Boolean)
    .join(' ');
  return /can't parse entities|parse entities|markdown/i.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTelegramMessageWithRetry(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await sendTelegramMessage(api, chatId, text, options);
  } catch (err) {
    const retryAfter = telegramRetryAfterSeconds(err);
    if (retryAfter === null) throw err;
    logger.warn(
      { retryAfter, err: sanitizeTelegramError(err) },
      'Telegram rate limited message send, retrying once',
    );
    await sleep(retryAfter * 1000);
    await sendTelegramMessage(api, chatId, text, options);
  }
}

function replySafely(
  ctx: any,
  text: string,
  options: Record<string, any> = {},
): void {
  Promise.resolve()
    .then(() => ctx.reply(text, options))
    .catch(async (err) => {
      if (options.parse_mode) {
        logger.debug(
          { err: sanitizeTelegramError(err) },
          'Command reply parse mode failed, falling back to plain text',
        );
        const plainOptions = { ...options };
        delete plainOptions.parse_mode;
        await ctx.reply(text, plainOptions);
        return;
      }
      throw err;
    })
    .catch((err) => {
      logger.warn(
        { err: sanitizeTelegramError(err) },
        'Telegram command reply failed',
      );
    });
}

function redactTelegramToken(text: string): string {
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    .replace(/\d{8,}:[A-Za-z0-9_-]{20,}/g, '<telegram-token-redacted>');
}

function sanitizeTelegramError(err: unknown): unknown {
  if (!(err instanceof Error)) return sanitizeTelegramErrorShape(err);
  const wrapped = err as Error & {
    code?: unknown;
    description?: unknown;
    error_code?: unknown;
    parameters?: unknown;
    response?: unknown;
    error?: unknown;
  };
  const nested = wrapped.error as
    | { description?: unknown; error_code?: unknown; parameters?: unknown }
    | undefined;
  return {
    name: err.name,
    message: redactTelegramToken(err.message),
    stack: err.stack ? redactTelegramToken(err.stack) : undefined,
    code: wrapped.code,
    description:
      typeof wrapped.description === 'string'
        ? redactTelegramToken(wrapped.description)
        : wrapped.description,
    errorCode: wrapped.error_code ?? nested?.error_code,
    parameters: wrapped.parameters ?? nested?.parameters,
    response: sanitizeTelegramErrorShape(wrapped.response),
    error: wrapped.error ? sanitizeTelegramError(wrapped.error) : undefined,
  };
}

function sanitizeTelegramErrorShape(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const shaped = value as {
    message?: unknown;
    description?: unknown;
    error_code?: unknown;
    parameters?: unknown;
  };
  return {
    message:
      typeof shaped.message === 'string'
        ? redactTelegramToken(shaped.message)
        : shaped.message,
    description:
      typeof shaped.description === 'string'
        ? redactTelegramToken(shaped.description)
        : shaped.description,
    errorCode: shaped.error_code,
    parameters: shaped.parameters,
  };
}

function isExpiredTelegramCallbackQueryError(err: unknown): boolean {
  const anyErr = err as {
    message?: unknown;
    description?: unknown;
    error?: { description?: unknown };
  };
  const text = [
    anyErr?.message,
    anyErr?.description,
    anyErr?.error?.description,
  ]
    .filter(Boolean)
    .join(' ');
  return /query is too old|response timeout expired|query ID is invalid/i.test(
    text,
  );
}

type TelegramLanguageCopy = {
  button: string;
  label: string;
  agentLanguage: string;
  choose: string;
  chosen: string;
  changed: string;
  botBlocked: string;
  privateOnly: string;
  accessSent: string;
  accessSaved: string;
  denied: string;
  statusConnected: string;
  statusUnregistered: (chatJid: string) => string;
  onboarding: (status: string) => string[];
};

const TELEGRAM_LANGUAGES: Record<TelegramLanguageCode, TelegramLanguageCopy> = {
  ru: {
    button: 'Русский',
    label: 'русский',
    agentLanguage: 'Russian',
    choose: 'Выберите язык общения со Скуби:',
    chosen: 'Язык выбран: русский.',
    changed: 'Язык переключён на русский.',
    botBlocked: 'Боты не подключаются к Скуби.',
    privateOnly:
      'Для личного ассистента напишите мне в личный чат и отправьте /start.',
    accessSent:
      'Заявка отправлена администратору <ADMIN_CONTACT>. Я напишу сюда, когда доступ будет подтверждён.',
    accessSaved:
      'Заявка сохранена, но я не смог уведомить администратора <ADMIN_CONTACT>. Попробуйте позже.',
    denied:
      'Администратор <ADMIN_CONTACT> пока не подтвердил доступ к ассистенту.',
    statusConnected: 'Статус: подключён. Можно просто писать сюда.',
    statusUnregistered: (chatJid) =>
      `Статус: ещё не подключён. Отправьте администратору <ADMIN_CONTACT> этот Chat ID: ${chatJid}`,
    onboarding: (status) => [
      `${ASSISTANT_NAME} — твой персональный AI-ассистент в Telegram.`,
      'Голосом, текстом, фото — на «ты», без бюрократии, с памятью на важное из ваших прошлых разговоров.',
      '',
      status,
      '',
      '› 🎙 Голосовые туда-обратно',
      '› 📸 Понимаю фото и скрины',
      '› 🧠 Помню важный контекст вашего диалога',
      '› 🙋 Если есть вопросы по доступу или настройкам, пишите администратору <ADMIN_CONTACT>',
      '› 🌐 Сёрфлю интернет в реальном времени',
      '› 💰 Считаю депозиты, ипотеки, налоги',
      '› 🏦 Анализирую банки и финансы',
      '› 🏠 Помогаю подбирать квартиры и машины',
      '› 📊 Разбираю объявления, таблицы и цифры',
      '› 📄 Читаю PDF, договоры, чеки',
      '› ⚖️ Объясняю законы и права простым языком',
      '› 🛒 Сравниваю товары и цены',
      '› 🩺 Помогаю разобраться в теме здоровья и подготовить вопросы врачу',
      '› ✈️ Планирую поездки и маршруты',
      '› 🌍 Перевожу и адаптирую тексты',
      '› 📅 Помогаю с расписанием и напоминаниями',
      '› 💬 Говорю как друг, а не как робот',
      '',
      'Тестим неделю — потом решаешь 🐾',
      '',
      'Команды:',
      '/help — показать эту инструкцию',
      '/language — выбрать язык',
      '/chatid — показать ID этого чата',
      '/ping — проверить, что бот онлайн',
    ],
  },
  kk: {
    button: 'Қазақша',
    label: 'қазақша',
    agentLanguage: 'Kazakh',
    choose: 'Скубимен сөйлесу тілін таңдаңыз:',
    chosen: 'Тіл таңдалды: қазақша.',
    changed: 'Тіл қазақшаға ауыстырылды.',
    botBlocked: 'Боттар Скубиге қосылмайды.',
    privateOnly:
      'Жеке ассистент үшін маған жеке чатқа жазып, /start жіберіңіз.',
    accessSent:
      'Өтінім әкімші <ADMIN_CONTACT>-ға жіберілді. Қолжетімділік расталғанда осы жерге жазамын.',
    accessSaved:
      'Өтінім сақталды, бірақ әкімші <ADMIN_CONTACT>-ға хабарлама жібере алмадым. Кейінірек қайталап көріңіз.',
    denied:
      'Әкімші <ADMIN_CONTACT> ассистентке қолжетімділікті әзірге растаған жоқ.',
    statusConnected: 'Күйі: қосылған. Осында жаза беріңіз.',
    statusUnregistered: (chatJid) =>
      `Күйі: әлі қосылмаған. Әкімші <ADMIN_CONTACT>-ға осы Chat ID жіберіңіз: ${chatJid}`,
    onboarding: (status) => [
      `${ASSISTANT_NAME} — Telegram-дағы жеке AI-көмекшің.`,
      'Дауыс, мәтін, фото арқылы сөйлесемін, маңызды контексті есте сақтаймын.',
      '',
      status,
      '',
      '› 🎙 Дауыс хабарламаларын қабылдап, дауыспен жауап бере аламын',
      '› 📸 Фото мен скриндерді түсінемін',
      '› 🧠 Диалогтағы маңызды контексті есте сақтаймын',
      '› 🙋 Қолжетімділік немесе баптау бойынша сұрақ болса, <ADMIN_CONTACT> әкімшісіне жазыңыз',
      '› 🌐 Интернеттен өзекті ақпарат іздеймін',
      '› 💰 Депозит, ипотека, салық есептеймін',
      '› 🏦 Банк пен қаржыны талдаймын',
      '› 🏠 Пәтер мен көлік таңдауға көмектесемін',
      '› 📊 Хабарландыру, кесте және сандарды талдаймын',
      '› 📄 PDF, келісімшарт, чек оқимын',
      '› ⚖️ Заң мен құқықты қарапайым тілмен түсіндіремін',
      '› 🛒 Тауарлар мен бағаларды салыстырамын',
      '› 🩺 Денсаулық тақырыбында сұрақ дайындауға көмектесемін',
      '› ✈️ Сапар мен маршрут жоспарлаймын',
      '› 🌍 Мәтіндерді аударамын және бейімдеймін',
      '› 📅 Кесте мен еске салғыштарға көмектесемін',
      '› 💬 Робот сияқты емес, дос сияқты сөйлесемін',
      '',
      'Бір апта сынап көреміз — кейін өзіңіз шешесіз 🐾',
      '',
      'Командалар:',
      '/help — осы нұсқаулық',
      '/language — тілді таңдау',
      '/chatid — чат ID көрсету',
      '/ping — боттың онлайн екенін тексеру',
    ],
  },
  uz: {
    button: "O'zbekcha",
    label: "o'zbekcha",
    agentLanguage: 'Uzbek',
    choose: 'Skoobi bilan muloqot tilini tanlang:',
    chosen: "Til tanlandi: o'zbekcha.",
    changed: "Til o'zbekchaga almashtirildi.",
    botBlocked: 'Botlar Skoobi-ga ulanmaydi.',
    privateOnly:
      'Shaxsiy assistent uchun menga shaxsiy chatda yozing va /start yuboring.',
    accessSent:
      'So‘rov administrator <ADMIN_CONTACT>-ga yuborildi. Ruxsat tasdiqlanganda shu yerga yozaman.',
    accessSaved:
      'So‘rov saqlandi, lekin administrator <ADMIN_CONTACT>-ga xabar yubora olmadim. Keyinroq urinib ko‘ring.',
    denied:
      'Administrator <ADMIN_CONTACT> hozircha assistentga ruxsat bermadi.',
    statusConnected: 'Holat: ulangan. Shu yerga yozishingiz mumkin.',
    statusUnregistered: (chatJid) =>
      `Holat: hali ulanmagan. Administrator <ADMIN_CONTACT>-ga shu Chat ID ni yuboring: ${chatJid}`,
    onboarding: (status) => [
      `${ASSISTANT_NAME} — Telegram’dagi shaxsiy AI-assistentingiz.`,
      'Ovoz, matn va foto bilan ishlayman, muhim kontekstni eslab qolaman.',
      '',
      status,
      '',
      '› 🎙 Ovozli xabarlarni qabul qilaman va ovoz bilan javob bera olaman',
      '› 📸 Foto va skrinlarni tushunaman',
      '› 🧠 Suhbatdagi muhim kontekstni eslab qolaman',
      '› 🙋 Ruxsat yoki sozlamalar bo‘yicha savollar bo‘lsa, administrator <ADMIN_CONTACT>-ga yozing',
      '› 🌐 Internetdan dolzarb ma’lumot qidiraman',
      '› 💰 Depozit, ipoteka, soliqlarni hisoblayman',
      '› 🏦 Bank va moliyani tahlil qilaman',
      '› 🏠 Uy va mashina tanlashga yordam beraman',
      '› 📊 E’lonlar, jadval va raqamlarni tahlil qilaman',
      '› 📄 PDF, shartnoma va cheklarni o‘qiyman',
      '› ⚖️ Qonun va huquqlarni sodda tushuntiraman',
      '› 🛒 Mahsulot va narxlarni solishtiraman',
      '› 🩺 Sog‘liq mavzusida savollar tayyorlashga yordam beraman',
      '› ✈️ Sayohat va marshrut rejalayman',
      '› 🌍 Matnlarni tarjima va moslashtiraman',
      '› 📅 Jadval va eslatmalarga yordam beraman',
      '› 💬 Robotdek emas, do‘stdek gaplashaman',
      '',
      'Bir hafta test qilamiz — keyin o‘zingiz qaror qilasiz 🐾',
      '',
      'Buyruqlar:',
      '/help — shu yo‘riqnoma',
      '/language — tilni tanlash',
      '/chatid — chat ID ko‘rsatish',
      '/ping — bot onlaynligini tekshirish',
    ],
  },
  ky: {
    button: 'Кыргызча',
    label: 'кыргызча',
    agentLanguage: 'Kyrgyz',
    choose: 'Скуби менен сүйлөшүү тилин тандаңыз:',
    chosen: 'Тил тандалды: кыргызча.',
    changed: 'Тил кыргызчага алмаштырылды.',
    botBlocked: 'Боттор Скубиге кошулбайт.',
    privateOnly: 'Жеке ассистент үчүн мага жеке чатка жазып, /start жөнөтүңүз.',
    accessSent:
      'Өтүнмө администратор <ADMIN_CONTACT>-га жөнөтүлдү. Жеткилик ырасталганда ушул жерге жазам.',
    accessSaved:
      'Өтүнмө сакталды, бирок администратор <ADMIN_CONTACT>-га билдире алган жокмун. Кийинчерээк аракет кылыңыз.',
    denied:
      'Администратор <ADMIN_CONTACT> азырынча ассистентке жеткилик берген жок.',
    statusConnected: 'Абалы: кошулган. Ушул жерге жаза бериңиз.',
    statusUnregistered: (chatJid) =>
      `Абалы: азырынча кошула элек. Администратор <ADMIN_CONTACT>-га ушул Chat ID жөнөтүңүз: ${chatJid}`,
    onboarding: (status) => [
      `${ASSISTANT_NAME} — Telegramдагы жеке AI-жардамчыңыз.`,
      'Үн, текст жана фото менен иштейм, маанилүү контекстти эстеп калам.',
      '',
      status,
      '',
      '› 🎙 Үн билдирүүлөрүн кабыл алып, үн менен жооп бере алам',
      '› 📸 Фото жана скриндерди түшүнөм',
      '› 🧠 Диалогдогу маанилүү контекстти эстейм',
      '› 🙋 Жеткилик же жөндөөлөр боюнча суроолор болсо, администратор <ADMIN_CONTACT>-га жазыңыз',
      '› 🌐 Интернеттен актуалдуу маалымат издейм',
      '› 💰 Депозит, ипотека, салыктарды эсептейм',
      '› 🏦 Банк жана финансыны талдайм',
      '› 🏠 Үй жана машина тандоого жардам берем',
      '› 📊 Жарнама, таблица жана сандарды талдайм',
      '› 📄 PDF, келишим, чектерди окуйм',
      '› ⚖️ Мыйзам жана укукту жөнөкөй түшүндүрөм',
      '› 🛒 Товарлар менен бааларды салыштырам',
      '› 🩺 Ден соолук темасында суроо даярдоого жардам берем',
      '› ✈️ Сапар жана маршрут пландайм',
      '› 🌍 Тексттерди которуп, ылайыкташтырам',
      '› 📅 Расписание жана эскертмелерге жардам берем',
      '› 💬 Робот эмес, дос сыяктуу сүйлөшөм',
      '',
      'Бир жума тест кылабыз — анан өзүңүз чечесиз 🐾',
      '',
      'Командалар:',
      '/help — ушул нускама',
      '/language — тил тандоо',
      '/chatid — чат ID көрсөтүү',
      '/ping — бот онлайн экенин текшерүү',
    ],
  },
  en: {
    button: 'English',
    label: 'English',
    agentLanguage: 'English',
    choose: 'Choose your language for Skoobi:',
    chosen: 'Language selected: English.',
    changed: 'Language switched to English.',
    botBlocked: 'Bots cannot be connected to Skoobi.',
    privateOnly:
      'For a personal assistant, message me in a private chat and send /start.',
    accessSent:
      'Your request was sent to administrator <ADMIN_CONTACT>. I will message you here when access is approved.',
    accessSaved:
      'Your request was saved, but I could not notify administrator <ADMIN_CONTACT>. Please try again later.',
    denied:
      'Administrator <ADMIN_CONTACT> has not approved access to the assistant yet.',
    statusConnected: 'Status: connected. You can just write here.',
    statusUnregistered: (chatJid) =>
      `Status: not connected yet. Send this Chat ID to administrator <ADMIN_CONTACT>: ${chatJid}`,
    onboarding: (status) => [
      `${ASSISTANT_NAME} is your personal AI assistant in Telegram.`,
      'Voice, text, photos, no bureaucracy, with memory for important context from your conversations.',
      '',
      status,
      '',
      '› 🎙 Voice messages both ways',
      '› 📸 Understands photos and screenshots',
      '› 🧠 Remembers important context from your conversation',
      '› 🙋 For access or settings questions, write to administrator <ADMIN_CONTACT>',
      '› 🌐 Searches the web in real time',
      '› 💰 Calculates deposits, mortgages, taxes',
      '› 🏦 Helps analyze banks and finance',
      '› 🏠 Helps compare apartments and cars',
      '› 📊 Parses listings, tables, and numbers',
      '› 📄 Reads PDFs, contracts, receipts',
      '› ⚖️ Explains laws and rights in plain language',
      '› 🛒 Compares products and prices',
      '› 🩺 Helps prepare health questions for a doctor',
      '› ✈️ Plans trips and routes',
      '› 🌍 Translates and adapts text',
      '› 📅 Helps with schedules and reminders',
      '› 💬 Talks like a person, not a robot',
      '',
      'Test it for a week, then decide 🐾',
      '',
      'Commands:',
      '/help — show this guide',
      '/language — choose language',
      '/chatid — show this chat ID',
      '/ping — check that the bot is online',
    ],
  },
};

function languageCodeOrDefault(value: unknown): TelegramLanguageCode {
  return typeof value === 'string' &&
    (TELEGRAM_LANGUAGE_CODES as readonly string[]).includes(value)
    ? (value as TelegramLanguageCode)
    : 'ru';
}

function subscribeText(language: TelegramLanguageCode | undefined): string {
  if (languageCodeOrDefault(language) === 'en') {
    return [
      'Paid plans and subscriptions are disabled.',
      '',
      'Skoobi is not selling subscriptions right now. You do not need to pay or extend anything.',
    ].join('\n');
  }
  return [
    'Платные тарифы и подписки отключены.',
    '',
    'Скуби сейчас не продаёт подписки. Ничего оплачивать или продлевать не нужно.',
  ].join('\n');
}

function languageKeyboard(): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: [
      [
        { text: TELEGRAM_LANGUAGES.ru.button, callback_data: 'tglang:ru' },
        { text: TELEGRAM_LANGUAGES.kk.button, callback_data: 'tglang:kk' },
      ],
      [
        { text: TELEGRAM_LANGUAGES.uz.button, callback_data: 'tglang:uz' },
        { text: TELEGRAM_LANGUAGES.ky.button, callback_data: 'tglang:ky' },
      ],
      [{ text: TELEGRAM_LANGUAGES.en.button, callback_data: 'tglang:en' }],
    ],
  };
}

function languageChoiceText(): string {
  return [
    TELEGRAM_LANGUAGES.ru.choose,
    TELEGRAM_LANGUAGES.kk.choose,
    TELEGRAM_LANGUAGES.uz.choose,
    TELEGRAM_LANGUAGES.ky.choose,
    TELEGRAM_LANGUAGES.en.choose,
  ].join('\n');
}

function languageInstruction(language: TelegramLanguageCode): string {
  const copy = TELEGRAM_LANGUAGES[languageCodeOrDefault(language)];
  return `${copy.agentLanguage} is the user's selected language. Start in ${copy.agentLanguage}, then mirror the user's language if they switch.`;
}

function onboardingText(
  chatJid: string,
  isRegistered: boolean,
  language: TelegramLanguageCode = 'ru',
): string {
  const code = languageCodeOrDefault(language);
  const copy = TELEGRAM_LANGUAGES[code];
  const status = isRegistered
    ? copy.statusConnected
    : copy.statusUnregistered(chatJid);

  return renderAdminContact(copy.onboarding(status).join('\n'));
}

function commandText(text: string): string {
  return text.length <= 3900 ? text : text.slice(0, 3800) + '\n...truncated';
}

function isTechnicalTelegramName(jid: string, name?: string | null): boolean {
  const value = (name || '').trim();
  return !value || value === jid || /^tg:\d+$/.test(value);
}

function loadTelegramKnownNames(
  host: TelegramChannelHost,
  jids: string[],
): Map<string, string> {
  const names = new Map<string, string>();
  if (jids.length === 0) return names;
  try {
    const rows = host.knownChatNames(jids);
    for (const row of rows) {
      if (!names.has(row.jid) && !isTechnicalTelegramName(row.jid, row.name)) {
        names.set(row.jid, String(row.name).trim());
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load Telegram display names');
  }
  return names;
}

function telegramDisplayName(
  jid: string,
  group: TelegramRegisteredGroup,
  knownNames: Map<string, string>,
): string {
  return isTechnicalTelegramName(jid, group.name)
    ? knownNames.get(jid) || group.name
    : group.name;
}

function readPendingTelegramUsers(): PendingTelegramUsers {
  try {
    return JSON.parse(
      fs.readFileSync(PENDING_TELEGRAM_USERS_FILE, 'utf-8'),
    ) as PendingTelegramUsers;
  } catch {
    return {};
  }
}

function writePendingTelegramUsers(users: PendingTelegramUsers): void {
  fs.mkdirSync(path.dirname(PENDING_TELEGRAM_USERS_FILE), { recursive: true });
  const tmp = `${PENDING_TELEGRAM_USERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, PENDING_TELEGRAM_USERS_FILE);
}

function readTelegramAccessState(): TelegramAccessState {
  try {
    return JSON.parse(
      fs.readFileSync(TELEGRAM_ACCESS_CONTROL_FILE, 'utf-8'),
    ) as TelegramAccessState;
  } catch {
    return {};
  }
}

function writeTelegramAccessState(state: TelegramAccessState): void {
  fs.mkdirSync(path.dirname(TELEGRAM_ACCESS_CONTROL_FILE), {
    recursive: true,
  });
  const tmp = `${TELEGRAM_ACCESS_CONTROL_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, TELEGRAM_ACCESS_CONTROL_FILE);
}

function isTelegramBotBlockedError(err: unknown): boolean {
  const anyErr = err as {
    message?: unknown;
    description?: unknown;
    error_code?: unknown;
    errorCode?: unknown;
    error?: {
      message?: unknown;
      description?: unknown;
      error_code?: unknown;
    };
  };
  const code =
    anyErr?.error_code ?? anyErr?.errorCode ?? anyErr?.error?.error_code;
  const text = [
    anyErr?.message,
    anyErr?.description,
    anyErr?.error?.message,
    anyErr?.error?.description,
  ]
    .filter(Boolean)
    .join(' ');
  return Number(code) === 403 && /bot was blocked by the user/i.test(text);
}

/**
 * Best-effort extraction of a Telegram/grammy HTTP error code (e.g. 401, 409)
 * from the various shapes errors arrive in (GrammyError.error_code, a nested
 * `error.error_code`, or a leading "<code>:" in the message text). Returns
 * undefined when no numeric code can be determined.
 */
function telegramErrorCode(err: unknown): number | undefined {
  const anyErr = err as {
    message?: unknown;
    description?: unknown;
    error_code?: unknown;
    errorCode?: unknown;
    error?: { message?: unknown; error_code?: unknown };
  };
  const raw =
    anyErr?.error_code ?? anyErr?.errorCode ?? anyErr?.error?.error_code;
  const fromField = Number(raw);
  if (Number.isFinite(fromField) && fromField !== 0) return fromField;
  const text = [anyErr?.message, anyErr?.error?.message, anyErr?.description]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  const match = text.match(/\b(401|403|409|429)\b/);
  return match ? Number(match[1]) : undefined;
}

/**
 * fs.statSync size for logging that never throws. Returns the byte size, or 0
 * if the file is gone/unreadable. Used so a missing-file stat can never turn a
 * successful media send into a reported failure (finding #43).
 */
function statSizeSafe(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function markTelegramOutboundBlocked(jid: string, err: unknown): void {
  const state = readTelegramAccessState();
  const now = new Date().toISOString();
  state[jid] = {
    ...(state[jid] || {}),
    outboundBlockedAt: state[jid]?.outboundBlockedAt || now,
    outboundBlockedReason: 'bot_blocked_by_user',
    lastOutboundErrorAt: now,
    lastOutboundError: 'Forbidden: bot was blocked by the user',
    updatedAt: now,
  };
  writeTelegramAccessState(state);
  logger.warn(
    { jid, err: sanitizeTelegramError(err) },
    'Telegram chat marked unreachable',
  );
}

function clearTelegramOutboundBlocked(entry: TelegramAccessEntry): boolean {
  if (!entry.outboundBlockedReason && !entry.outboundBlockedAt) return false;
  delete entry.outboundBlockedAt;
  delete entry.outboundBlockedReason;
  delete entry.lastOutboundErrorAt;
  delete entry.lastOutboundError;
  return true;
}

function readTelegramUserSettings(): TelegramUserSettingsState {
  try {
    return JSON.parse(
      fs.readFileSync(TELEGRAM_USER_SETTINGS_FILE, 'utf-8'),
    ) as TelegramUserSettingsState;
  } catch {
    return {};
  }
}

function writeTelegramUserSettings(state: TelegramUserSettingsState): void {
  fs.mkdirSync(path.dirname(TELEGRAM_USER_SETTINGS_FILE), {
    recursive: true,
  });
  const tmp = `${TELEGRAM_USER_SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, TELEGRAM_USER_SETTINGS_FILE);
}

function telegramUserLanguage(jid: string): TelegramLanguageCode {
  return languageCodeOrDefault(readTelegramUserSettings()[jid]?.language);
}

function setTelegramUserLanguage(
  jid: string,
  language: TelegramLanguageCode,
): void {
  const state = readTelegramUserSettings();
  state[jid] = {
    ...state[jid],
    language,
    updatedAt: new Date().toISOString(),
  };
  writeTelegramUserSettings(state);
}

function appendTelegramInboxEntry(
  groupFolder: string,
  entry: TelegramInboxEntry,
): void {
  if (!FOLDER_PATTERN.test(groupFolder)) {
    throw new Error(`Invalid Telegram inbox folder: ${groupFolder}`);
  }
  fs.mkdirSync(TELEGRAM_INBOX_DIR, { recursive: true });
  fs.appendFileSync(
    path.join(TELEGRAM_INBOX_DIR, `${groupFolder}.jsonl`),
    JSON.stringify(entry) + '\n',
  );
}

function telegramChatId(jid: string): string | number {
  const raw = telegramJidToChatId(jid) || jid.replace(/^tg:/, '');
  const numeric = Number(raw);
  return Number.isSafeInteger(numeric) ? numeric : raw;
}

function telegramSenderName(ctx: any): string {
  const fullName = [ctx.from?.first_name, ctx.from?.last_name]
    .filter(Boolean)
    .join(' ');
  return (
    fullName || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown'
  );
}

const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/u;

type TelegramTextRange = {
  start: number;
  end: number;
};

function telegramRuntimeUsername(value: unknown): string | null {
  if (typeof value !== 'string' || !TELEGRAM_USERNAME_PATTERN.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

function telegramBotUserId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function unicodeCharacterBefore(content: string, index: number): string {
  if (index <= 0) return '';
  const trailingCodeUnit = content.charCodeAt(index - 1);
  if (trailingCodeUnit >= 0xdc00 && trailingCodeUnit <= 0xdfff && index >= 2) {
    const leadingCodeUnit = content.charCodeAt(index - 2);
    if (leadingCodeUnit >= 0xd800 && leadingCodeUnit <= 0xdbff) {
      return content.slice(index - 2, index);
    }
  }
  return content.slice(index - 1, index);
}

function telegramEntityRange(
  entity: any,
  content: string,
): TelegramTextRange | null {
  const start = entity?.offset;
  const length = entity?.length;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < 0 ||
    length < 1 ||
    start + length > content.length
  ) {
    return null;
  }
  const end = start + length;
  const splitsSurrogatePair = (index: number): boolean =>
    index > 0 &&
    index < content.length &&
    /[\uD800-\uDBFF]/u.test(content[index - 1]) &&
    /[\uDC00-\uDFFF]/u.test(content[index]);
  if (splitsSurrogatePair(start) || splitsSurrogatePair(end)) return null;
  return { start, end };
}

/**
 * Return only Telegram-authenticated entity ranges that address this runtime
 * bot. Telegram offsets are UTF-16 code-unit offsets, which are the same units
 * used by JavaScript's slice().
 */
function telegramBotMentionRanges(
  ctx: any,
  content: string,
): TelegramTextRange[] {
  const entities: any[] = Array.isArray(ctx.message?.entities)
    ? ctx.message.entities
    : [];
  const botUsername = telegramRuntimeUsername(ctx.me?.username);
  const botId = telegramBotUserId(ctx.me?.id);
  const uniqueRanges = new Map<string, TelegramTextRange>();

  for (const entity of entities) {
    const range = telegramEntityRange(entity, content);
    if (!range) continue;

    let addressesBot = false;
    if (entity.type === 'mention' && botUsername) {
      const previousCharacter = unicodeCharacterBefore(content, range.start);
      const nextCharacter = content.slice(range.end, range.end + 1);
      addressesBot =
        content.slice(range.start, range.end).toLowerCase() ===
          `@${botUsername}` &&
        !/[\p{L}\p{M}\p{N}_@-]/u.test(previousCharacter) &&
        !/[A-Za-z0-9_]/u.test(nextCharacter);
    } else if (
      entity.type === 'text_mention' &&
      botId !== null &&
      entity.user?.is_bot === true
    ) {
      addressesBot = telegramBotUserId(entity.user?.id) === botId;
    }
    if (!addressesBot) continue;

    uniqueRanges.set(`${range.start}:${range.end}`, range);
  }

  const ranges = [...uniqueRanges.values()].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      return [];
    }
  }
  return ranges;
}

function removeTelegramTextRanges(
  content: string,
  ranges: TelegramTextRange[],
): string {
  let result = content;
  for (const range of [...ranges].sort(
    (left, right) => right.start - left.start,
  )) {
    const before = result.slice(0, range.start).trimEnd();
    const after = result.slice(range.end).trimStart();
    result = before && after ? `${before} ${after}` : before || after;
  }
  return result.trim();
}

function configuredAssistantMentionRanges(
  content: string,
): TelegramTextRange[] {
  return [
    ...content.matchAll(createAssistantMentionPattern(ASSISTANT_NAME)),
  ].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function canonicalizeTelegramBotMentions(ctx: any, content: string): string {
  const runtimeMentionRanges = telegramBotMentionRanges(ctx, content);
  if (runtimeMentionRanges.length === 0) return content;

  const withoutRuntimeMentions = removeTelegramTextRanges(
    content,
    runtimeMentionRanges,
  );
  const tail = removeTelegramTextRanges(
    withoutRuntimeMentions,
    configuredAssistantMentionRanges(withoutRuntimeMentions),
  );
  return `@${ASSISTANT_NAME}${tail ? ` ${tail}` : ''}`;
}

export function telegramMessageTimestamp(ctx: any): string {
  const base = new Date(ctx.message.date * 1000).toISOString();
  const messageId = Number(ctx.message.message_id);
  if (!Number.isSafeInteger(messageId) || messageId < 0) return base;
  // Telegram's date is only second-resolution while our durable cursors use a
  // strict timestamp comparison. Preserve the per-chat message_id as fixed-
  // width fractional precision so two commands in one second remain ordered
  // and independently acknowledgeable. JS Date safely reads the leading 500ms
  // when code needs wall time; SQLite/string cursors retain the full suffix.
  const sequence = String(messageId).padStart(12, '0');
  return base.replace('.000Z', `.500${sequence}Z`);
}

function telegramMessageOriginForContext(
  ctx: any,
): 'direct' | 'forwarded' | 'quoted' {
  const message = ctx.message;
  if (
    message?.forward_origin != null ||
    message?.is_automatic_forward === true ||
    message?.via_bot != null ||
    message?.sender_business_bot != null ||
    message?.is_from_offline === true
  ) {
    return 'forwarded';
  }
  const nonAuthoritativeEntityTypes = new Set([
    'blockquote',
    'expandable_blockquote',
    'code',
    'pre',
  ]);
  const entities = [
    ...(Array.isArray(message?.entities) ? message.entities : []),
    ...(Array.isArray(message?.caption_entities)
      ? message.caption_entities
      : []),
  ];
  return entities.some((entity) =>
    nonAuthoritativeEntityTypes.has(entity?.type),
  )
    ? 'quoted'
    : 'direct';
}

function telegramUpdateId(ctx: any): string | undefined {
  const updateId = ctx.update?.update_id;
  if (updateId === undefined || updateId === null) return undefined;
  return String(updateId);
}

function telegramDayKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function pruneIsoTimestamps(
  timestamps: string[] | undefined,
  nowMs: number,
  windowMs: number,
): string[] {
  return (timestamps || []).filter((ts) => {
    const parsed = new Date(ts).getTime();
    return Number.isFinite(parsed) && nowMs - parsed < windowMs;
  });
}

function isProbationGroup(
  group: TelegramRegisteredGroup,
  nowMs: number,
): boolean {
  const addedAt = new Date(group.added_at).getTime();
  return Number.isFinite(addedAt) && nowMs - addedAt < GUEST_PROBATION_MS;
}

function guestLimitsFor(
  group: TelegramRegisteredGroup,
  nowMs: number,
): {
  messagesPerWindow: number;
  mediaPerWindow: number;
  messagesPerDay: number;
  probation: boolean;
} {
  const probation = isProbationGroup(group, nowMs);
  return {
    ...(probation ? GUEST_PROBATION_LIMITS : GUEST_STEADY_LIMITS),
    probation,
  };
}

function accessCooldownElapsed(
  value: string | undefined,
  nowMs: number,
  cooldownMs: number,
): boolean {
  if (!value) return true;
  const parsed = new Date(value).getTime();
  return !Number.isFinite(parsed) || nowMs - parsed >= cooldownMs;
}

function normalizeTelegramTarget(arg: string): string {
  const trimmed = arg.trim();
  if (/^\d+$/.test(trimmed)) return `tg:${trimmed}`;
  return trimmed;
}

function approvalKeyboard(jid: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const id = jid.replace(/^tg:/, '');
  return {
    inline_keyboard: [
      [
        { text: 'Одобрить', callback_data: `tgaccess:approve:${id}` },
        { text: 'Отклонить', callback_data: `tgaccess:deny:${id}` },
      ],
    ],
  };
}

function pendingUserText(user: PendingTelegramUser): string {
  const language = TELEGRAM_LANGUAGES[languageCodeOrDefault(user.language)];
  return [
    'Новая заявка на доступ',
    '',
    `Имя: ${user.name}`,
    user.username ? `Username: @${user.username}` : '',
    user.isBot ? 'Bot account: yes' : '',
    `Chat ID: ${user.jid}`,
    `Тип: ${user.chatType}`,
    `Язык: ${language.button}`,
    `Запрос: ${formatTimestamp(user.requestedAt)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function sanitizeFolderPart(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function uniqueTelegramFolder(
  user: PendingTelegramUser,
  groups: Record<string, TelegramRegisteredGroup>,
): string {
  const id = user.jid.replace(/^tg:/, '').replace(/[^a-zA-Z0-9_-]/g, '');
  const basePart =
    sanitizeFolderPart(user.username || user.name) || `user_${id}`;
  const used = new Set(Object.values(groups).map((group) => group.folder));
  let folder = `telegram_${basePart}`;
  let suffix = 1;
  while (
    !FOLDER_PATTERN.test(folder) ||
    used.has(folder) ||
    fs.existsSync(path.join(GROUPS_DIR, folder))
  ) {
    const tail = suffix === 1 ? id.slice(-8) : `${id.slice(-8)}_${suffix}`;
    folder = `telegram_${basePart.slice(0, 32)}_${tail}`;
    suffix += 1;
  }
  return folder;
}

function guestAgentConfig(
  name: string,
  jid: string,
  folder: string,
  language: TelegramLanguageCode,
): TelegramRegisteredGroup['agentConfig'] {
  const topic = memoryTopicForFolder(folder);
  return {
    model: 'claude-opus-4-8',
    effort: 'medium',
    systemPrompt: `You are Skoobi (Скуби), a warm and practical personal Telegram assistant administered by ${ADMIN_CONTACT}. You are talking with Telegram chat ${jid}. Display name: ${name} (unverified). Access granted by ${ADMIN_LABEL}.

Style: ${languageInstruction(language)} Be friendly, practical, concise, and useful. Help with text, voice notes, photos, calculations, web lookup, planning, and message drafting.

Memory: when continuity could help, use memory_get with file="memory/topics/${topic}-context.md". After durable facts, use memory_save with category="topic" topic="${topic}-context" or a more specific safe topic.

Relationship memory: build warm continuity with this user. Save stable preferences, goals, communication style, and important personal context to this chat's own memory only. Use it later naturally, without pretending to know facts that were not shared.

Identity safety: Telegram display names are not identity proof. If this name matches the administrator or another user, do not assume it is the same person. Use only this chat's own memory topic and current conversation.

${GUEST_BOUNDARY_MARKER}. Do not read the administrator's private files (.env, keys, store/messages.db, groups/owner_main, sessions, browser cookies) or other users' groups. No sudo, no destructive/system-changing commands. Do not use full-access/no-sandbox behaviour.

If the user asks to pass something to ${ADMIN_LABEL}, save it via memory_save category="topic" topic="${topic}-to-admin"; do not send it to the administrator's chat automatically without explicit administrator approval.

EXPLICIT SEND RULE: If you use mcp__claudeclaw__send_message, mcp__claudeclaw__send_voice_message, or mcp__claudeclaw__send_document, wrap the final acknowledgement in <internal>Отправил.</internal> so Telegram does not receive a duplicate service message.`,
    allowedTools: [
      'WebSearch',
      'WebFetch',
      'Read',
      'mcp__claudeclaw__send_message',
      'mcp__claudeclaw__send_voice_message',
      'mcp__claudeclaw__send_document',
      'mcp__claudeclaw__memory_save',
      'mcp__claudeclaw__memory_get',
      'mcp__claudeclaw__memory_search',
    ],
    disallowedTools: [
      'computer_click',
      'computer_key',
      'computer_type',
      'computer_open_app',
      'Bash',
      'Write',
      'Edit',
    ],
  };
}

function guestClaudeMd(
  name: string,
  jid: string,
  folder: string,
  language: TelegramLanguageCode,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const topic = memoryTopicForFolder(folder);
  return `- [${today}] Этот чат — личный диалог Скуби с Telegram chat_id ${jid}. Отображаемое имя: ${name} (не является подтверждением личности). Доступ выдан: ${ADMIN_LABEL}.
- [${today}] ЯЗЫК: ${languageInstruction(language)}
- [${today}] РОЛЬ: тёплый, спокойный и полезный личный помощник. Помогай с текстом, голосовыми, фото, расчётами, поиском информации, планами и формулировками.
- [${today}] ПАМЯТЬ: когда контекст может помочь, вызывай \`memory_get\` с \`file="memory/topics/${topic}-context.md"\`. После устойчивых фактов сохраняй через \`memory_save\` с \`category="topic"\` и \`topic="${topic}-context"\` или более точной безопасной темой.
- [${today}] ЭМОЦИОНАЛЬНАЯ СВЯЗЬ: запоминай устойчивые предпочтения, цели, стиль общения и важный личный контекст только в памяти этого chat_id. Используй это дальше естественно, без выдуманной близости и без доступа к чужой памяти.
- [${today}] БЕЗОПАСНОСТЬ ЛИЧНОСТИ: не определяй пользователя по отображаемому имени. Если имя совпадает с администратором или другим пользователем, это всё равно отдельный человек, пока собственная память этого chat_id явно не говорит обратное.
- [${today}] Это ГОСТЕВАЯ группа (sandbox). ЗАПРЕЩЕНО: sudo, разрушительные команды, изменение настроек системы, чтение приватных файлов администратора ${ADMIN_CONTACT} (.env, ключи, store/messages.db, groups/owner_main, sessions, cookies браузеров) и чужих групп.
- [${today}] Если попросят передать что-то администратору ${ADMIN_CONTACT} — сохранить через \`memory_save\` с \`category="topic"\` и \`topic="${topic}-to-admin"\`, не пересылать в его чат автоматически без явной просьбы администратора.
- [${today}] Если используешь \`send_message\`, \`send_voice_message\` или \`send_document\`, финальный stdout после explicit-send заворачивай в \`<internal>Отправил.</internal>\`, чтобы в чат не улетал лишний служебный дубль.
`;
}

function isMainChat(
  opts: TelegramChannelOpts,
  chatId: string | number,
): boolean {
  return Boolean(
    opts.registeredGroups()[telegramJidForChatId(chatId, opts.botId)]?.isMain ||
    opts.registeredGroups()[`tg:${chatId}`]?.isMain,
  );
}

function contextChatId(ctx: any): string | number | undefined {
  return ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
}

function contextFrom(ctx: any): any {
  return ctx.from || ctx.callbackQuery?.from;
}

async function captionVideoNoteFrames(
  host: TelegramChannelHost,
  framePaths: string[],
  costMeta: { groupFolder: string; chatJid: string },
): Promise<string[]> {
  const captions: string[] = [];
  for (const framePath of framePaths.slice(0, 3)) {
    const caption = await host.captionPhoto(framePath, costMeta);
    const trimmed = caption?.trim().replace(/[.!?…]+$/u, '');
    if (!trimmed) continue;
    if (!captions.includes(trimmed)) captions.push(trimmed);
  }
  return captions;
}

function isOwnerCommandContext(opts: TelegramChannelOpts, ctx: any): boolean {
  if (!ctx.callbackQuery && telegramMessageOriginForContext(ctx) !== 'direct') {
    return false;
  }
  const chatId = contextChatId(ctx);
  const from = contextFrom(ctx);
  const fromId = from?.id;
  if (chatId === undefined || chatId === null) return false;
  if (fromId === undefined || fromId === null) return false;
  if (!isMainChat(opts, chatId)) return false;

  const ownerAllowlist = opts.ownerAllowlist?.() || loadOwnerAllowlistFromEnv();
  const displayName = [from.first_name, from.last_name]
    .filter(Boolean)
    .join(' ');
  const identity = createTelegramSenderIdentity({
    chatId,
    fromId,
    usernameHint: from.username,
    displayNameHint: displayName || from.username || String(fromId),
    ownerAllowlist,
  });

  if (identity.is_owner_sender) return true;

  // Backward-compatible private-owner fallback: for existing private Telegram
  // owner chats, chat.id equals from.id. Group chats still need an explicit
  // OWNER_TELEGRAM_USER_IDS allowlist.
  return (
    ownerAllowlist.telegram_user_ids.size === 0 &&
    String(chatId) === String(fromId)
  );
}

function isCommandAdminContext(opts: TelegramChannelOpts, ctx: any): boolean {
  if (!ctx.callbackQuery && telegramMessageOriginForContext(ctx) !== 'direct') {
    return false;
  }
  if (isOwnerCommandContext(opts, ctx)) return true;
  const fromId = contextFrom(ctx)?.id;
  if (fromId === undefined || fromId === null) return false;
  return commandAdminUserIds().has(String(fromId));
}

function isPrivateAdminAllowedContext(
  opts: TelegramChannelOpts,
  ctx: any,
): boolean {
  const fromId = contextFrom(ctx)?.id;
  const ownerAllowlist = opts.ownerAllowlist?.() || loadOwnerAllowlistFromEnv();
  return opts.host.isPrivateAdminTelegramUser({
    telegramUserId: fromId,
    ownerAllowlist,
  });
}

function rejectUntrustedPrivateAdminContext(
  opts: TelegramChannelOpts,
  ctx: any,
): boolean {
  if (!opts.host.privateAdminModeEnabled()) return false;
  if (isPrivateAdminAllowedContext(opts, ctx)) return false;
  replySafely(ctx, opts.host.privateAdminClosedBotText());
  return true;
}

function requireCommandAdmin(opts: TelegramChannelOpts, ctx: any): boolean {
  if (isCommandAdminContext(opts, ctx)) return true;
  replySafely(ctx, 'Команда доступна только админу.');
  return false;
}

function requireMainChat(opts: TelegramChannelOpts, ctx: any): boolean {
  if (isOwnerCommandContext(opts, ctx)) return true;
  replySafely(ctx, 'Эта команда доступна только владельцу бота.');
  return false;
}

function formatTimestamp(ts?: string | null): string {
  if (!ts) return 'never';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

interface CodexCliConfig {
  model: string;
  fallback?: string;
}

interface SkoobiEngineRuntimeStatus {
  codexActive: boolean;
  model: string;
  fallbackModel?: string;
  degradedModel?: string;
  reasoningEffort?: string;
  route: string;
  claudeFallbackEnabled: boolean;
}

function parseTomlStringValue(raw: string): string | undefined {
  const value = raw.trim();
  const quoted = value.match(/^"([^"]+)"|^'([^']+)'/);
  if (quoted) return (quoted[1] || quoted[2] || '').trim() || undefined;
  const array = value.match(/^\[([^\]]+)\]/);
  if (!array) return undefined;
  const values = Array.from(
    array[1].matchAll(/"([^"]+)"|'([^']+)'/g),
    (match) => (match[1] || match[2] || '').trim(),
  ).filter(Boolean);
  return values.length > 0 ? values.join(', ') : undefined;
}

function readCodexCliConfig(): CodexCliConfig {
  try {
    const config = fs.readFileSync(
      path.join(os.homedir(), '.codex', 'config.toml'),
      'utf-8',
    );
    let model: string | undefined;
    let fallback: string | undefined;
    for (const line of config.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const modelMatch = trimmed.match(/^model\s*=\s*(.+)$/);
      if (modelMatch && !model) {
        model = parseTomlStringValue(modelMatch[1]);
        continue;
      }
      const fallbackMatch = trimmed.match(
        /^(?:fallback|model_?fallback|fallback_?model)\s*=\s*(.+)$/i,
      );
      if (fallbackMatch && !fallback) {
        fallback = parseTomlStringValue(fallbackMatch[1]);
      }
    }
    return { model: model || 'не определена', fallback };
  } catch {
    return { model: 'не определена' };
  }
}

function envFlagValue(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function readSkoobiEngineRuntimeStatus(
  group?: Pick<TelegramRegisteredGroup, 'isMain' | 'agentConfig'>,
): SkoobiEngineRuntimeStatus {
  const keys = [
    'SKOOBI_MODEL_GATEWAY_TYPE',
    'SKOOBI_CODEX_SUBSCRIPTION_ENABLED',
    'SKOOBI_CODEX_MODEL',
    'SKOOBI_CODEX_FALLBACK_MODEL',
    'SKOOBI_CODEX_ALLOW_MODEL_DOWNGRADE',
    'SKOOBI_CODEX_REASONING_EFFORT',
    'SKOOBI_QUOTA_DEGRADED_MODEL',
    'SKOOBI_SANDBOX_CODEX_PRIMARY',
    'SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED',
    'SKOOBI_TELEGRAM_OWNER_LIVE_ENABLED',
    'SKOOBI_CODEX_OWNER_FULL_AGENT_ENABLED',
    'SKOOBI_CLAUDE_FALLBACK_ENABLED',
  ] as const;
  const envFile = readEnvFile([...keys]);
  const value = (key: (typeof keys)[number]): string | undefined =>
    process.env[key] ?? envFile[key];
  const cliConfig = readCodexCliConfig();
  const gatewayType = value('SKOOBI_MODEL_GATEWAY_TYPE') || '';
  const subscriptionEnabled = envFlagValue(
    value('SKOOBI_CODEX_SUBSCRIPTION_ENABLED'),
    false,
  );
  const sandboxPrimary = envFlagValue(
    value('SKOOBI_SANDBOX_CODEX_PRIMARY'),
    false,
  );
  const guestLive = envFlagValue(
    value('SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED'),
    false,
  );
  const ownerLive = envFlagValue(
    value('SKOOBI_TELEGRAM_OWNER_LIVE_ENABLED'),
    false,
  );
  const ownerFullAgentEnabled = envFlagValue(
    value('SKOOBI_CODEX_OWNER_FULL_AGENT_ENABLED'),
    false,
  );
  const allowDowngrade = envFlagValue(
    value('SKOOBI_CODEX_ALLOW_MODEL_DOWNGRADE'),
    false,
  );
  const codexActive =
    gatewayType === 'codex_subscription_cli' &&
    subscriptionEnabled &&
    (sandboxPrimary || guestLive || ownerLive);
  const groupFullAgentActive = Boolean(
    codexActive &&
    ownerLive &&
    ownerFullAgentEnabled &&
    group?.isMain === true &&
    group.agentConfig?.codexFullAgentPrimary === true,
  );

  return {
    codexActive,
    model: value('SKOOBI_CODEX_MODEL') || cliConfig.model,
    fallbackModel: allowDowngrade
      ? value('SKOOBI_CODEX_FALLBACK_MODEL') || cliConfig.fallback
      : undefined,
    degradedModel: value('SKOOBI_QUOTA_DEGRADED_MODEL'),
    reasoningEffort: value('SKOOBI_CODEX_REASONING_EFFORT'),
    route: sandboxPrimary
      ? 'full-agent для всех sandbox-чатов'
      : groupFullAgentActive
        ? 'full-agent для этого owner-чата'
        : guestLive && ownerLive
          ? 'live для owner и guest'
          : ownerLive
            ? 'live для owner'
            : guestLive
              ? 'live для guest'
              : 'не активен',
    claudeFallbackEnabled: envFlagValue(
      value('SKOOBI_CLAUDE_FALLBACK_ENABLED'),
      true,
    ),
  };
}

function codexCommandOutput(err: unknown): string {
  const e = err as {
    message?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  return [e?.message, e?.stdout, e?.stderr]
    .filter(Boolean)
    .map((item) => String(item))
    .join('\n');
}

function codexLoginStatusIndicatesLoggedIn(output: string): boolean {
  const lower = output.toLowerCase();
  if (
    /not\s+logged\s+in|not\s+authenticated|unauthenticated|logged\s+out/.test(
      lower,
    )
  ) {
    return false;
  }
  return /logged\s+in|authenticated|signed\s+in/.test(lower);
}

function isCodexLoginStatusUnavailable(err: unknown): boolean {
  const lower = codexCommandOutput(err).toLowerCase();
  if (/not\s+logged\s+in|not\s+authenticated|unauthenticated/.test(lower)) {
    return false;
  }
  return (
    /unknown|unrecognized|unsupported|invalid/.test(lower) &&
    /command|subcommand|argument|login|status/.test(lower)
  );
}

async function codexCliStatus(): Promise<'включена' | 'недоступен'> {
  try {
    await execFileAsync('codex', ['--version'], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
  } catch {
    return 'недоступен';
  }

  try {
    const result = await execFileAsync('codex', ['login', 'status'], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const output =
      typeof result === 'string'
        ? result
        : [result.stdout, result.stderr].filter(Boolean).join('\n');
    return codexLoginStatusIndicatesLoggedIn(output)
      ? 'включена'
      : 'недоступен';
  } catch (err) {
    return isCodexLoginStatusUnavailable(err) ? 'включена' : 'недоступен';
  }
}

function timezoneDateParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value || '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

function timezoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value || '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - date.getTime();
}

function localMidnightUtcIso(date: Date = new Date()): string {
  const { year, month, day } = timezoneDateParts(date, TIMEZONE);
  const targetUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let utcMs = targetUtc;
  for (let i = 0; i < 3; i += 1) {
    utcMs = targetUtc - timezoneOffsetMs(new Date(utcMs), TIMEZONE);
  }
  return new Date(utcMs).toISOString();
}

export interface TelegramStatsUserRow {
  sender: string;
  display_name: string | null;
  message_count: number;
}

export interface TelegramStatsTotalsRow {
  user_messages: number | null;
  bot_messages: number | null;
}

function telegramStatsReport(host: TelegramChannelHost): string {
  const todayStart = localMidnightUtcIso();
  const users = host.statsUsersToday(todayStart);
  const totals = host.statsTotalsToday(todayStart);
  const userMessages = Number(totals?.user_messages ?? 0);
  const botMessages = Number(totals?.bot_messages ?? 0);
  const lines = [
    `Сегодня онлайн: ${users.length} юзеров`,
    ...users.map((row, index) => {
      const name = row.display_name?.trim() || row.sender;
      return `${index + 1}. ${name} — ${Number(row.message_count) || 0} сообщений`;
    }),
    `Всего сообщений: ${userMessages + botMessages} (от юзеров: ${userMessages}, от бота: ${botMessages})`,
  ];
  return commandText(lines.join('\n'));
}

function countIpcFiles(kind: 'input' | 'messages' | 'tasks'): number {
  const base = path.join(DATA_DIR, 'ipc');
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .reduce((sum, dirent) => {
        if (!dirent.isDirectory()) return sum;
        const dir = path.join(base, dirent.name, kind);
        if (!fs.existsSync(dir)) return sum;
        return (
          sum +
          fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((f) => f.isFile() && f.name !== '_close').length
        );
      }, 0);
  } catch {
    return -1;
  }
}

// Telegram clears chat actions ~5 seconds after they're sent, so a single
// `sendChatAction('typing')` only keeps the indicator visible for that long.
// Agent runs (especially after voice transcription) can take 30-90s, leaving
// the user staring at silence. Refreshing the action every 4s keeps the
// indicator alive continuously.
const TYPING_REFRESH_INTERVAL_MS = 4000;
// Hard cap on how long a single setTyping(true) can keep the indicator
// alive. Defends against any leak path where setTyping(false) is missed
// (e.g. the orchestrator throws between true/false calls, or a piped
// message path forgets to clear). setTyping(false) is reliably issued from
// the run's finally block and after each delivered turn, so this is a pure
// leak failsafe — it must NOT fire during legitimate long agent runs (the
// old 3-minute cap killed the indicator mid-run and users read the silence
// as a crash).
const TYPING_MAX_DURATION_MS = 30 * 60 * 1000;

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private ownerNotificationChannel?: TelegramChannel;
  private peerChannels: TelegramChannel[] = [];
  // jid -> interval handle for the active typing-refresh loop.
  // Indexed by full jid (e.g. "tg:100000001") so multiple chats can be
  // "typing" simultaneously without stomping on each other.
  private typingIntervals = new Map<string, NodeJS.Timeout>();
  private pendingMemoryDeletes = new Map<
    string,
    PendingMemoryDeleteConfirmation
  >();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = {
      ...opts,
      botId: opts.botId ? safeTelegramBotId(opts.botId) : undefined,
    };
  }

  setOwnerNotificationChannel(channel: TelegramChannel | undefined): void {
    this.ownerNotificationChannel = channel;
  }

  setPeerChannels(channels: TelegramChannel[]): void {
    this.peerChannels = channels;
  }

  isDefaultBotChannel(): boolean {
    return isDefaultTelegramBotId(safeTelegramBotId(this.opts.botId));
  }

  private channelForJid(jid: string): TelegramChannel | undefined {
    return (
      this.peerChannels.find((channel) => channel.ownsJid(jid)) ||
      (this.ownsJid(jid) ? this : undefined)
    );
  }

  private tenantIdForChat(chatId: string | number): string | undefined {
    return this.tenantForChat(chatId)?.tenant_id;
  }

  private tenantForChat(
    chatId: string | number,
  ): TelegramTenantView | undefined {
    return this.opts
      .tenantRegistry?.()
      .resolveTelegramChat(String(chatId), this.opts.botId);
  }

  private chatJidForChat(chatId: string | number): string {
    return telegramJidForChatId(chatId, this.opts.botId);
  }

  private telegramChatIdForJid(jid: string): string {
    const chatId = telegramJidToChatId(jid);
    if (!chatId) throw new Error(`Invalid Telegram JID: ${jid}`);
    return chatId;
  }

  private senderIdentityForContext(ctx: any, displayName: string) {
    const tenant = this.tenantForChat(ctx.chat.id);
    return {
      ...createTelegramSenderIdentity({
        chatId: ctx.chat.id,
        fromId: ctx.from?.id,
        botId: tenant?.bot_id || this.opts.botId,
        personaId: tenant?.persona_id || this.opts.personaId,
        usernameHint: ctx.from?.username,
        displayNameHint: displayName,
        ownerAllowlist:
          this.opts.ownerAllowlist?.() || loadOwnerAllowlistFromEnv(),
      }),
      telegram_message_origin: telegramMessageOriginForContext(ctx),
    };
  }

  private recordCallbackQuery(ctx: any, kind: string): void {
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
    if (chatId === undefined || chatId === null) return;

    const fromId = ctx.from?.id?.toString() || '';
    const displayName =
      ctx.from?.first_name || ctx.from?.username || fromId || 'Unknown';
    this.opts.onTelegramCallbackQuery?.({
      id: ctx.callbackQuery?.id || '',
      chat_jid: this.chatJidForChat(chatId),
      chat_id: String(chatId),
      from_id: fromId,
      timestamp: new Date().toISOString(),
      kind,
      data: ctx.callbackQuery?.data,
      message_id: ctx.callbackQuery?.message?.message_id?.toString(),
      username_hint: ctx.from?.username,
      display_name_hint: displayName,
    });
  }

  private recordQuotaBalanceViewed(
    tenant: TelegramTenantView,
    fromId: string,
    source: 'command' | 'callback',
  ): void {
    try {
      this.opts.host.recordTenantEvent({
        tenant,
        type: 'quota_balance_viewed',
        actor: `telegram_user:${fromId}`,
        senderId: fromId,
        payload: {
          source,
          channel_user_id: fromId,
        },
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to record Telegram quota balance event');
    }
  }

  private memoryDeleteKey(tenantId: string, senderId: string): string {
    return `${tenantId}:${senderId}`;
  }

  private recordMemoryDeleteEvent(
    tenant: TelegramTenantView,
    senderId: string,
    type:
      | 'memory_delete_requested'
      | 'memory_deleted'
      | 'memory_delete_unavailable',
    payload: Record<string, unknown>,
  ): void {
    try {
      this.opts.host.recordTenantEvent({
        tenant,
        type,
        actor: `telegram_user:${senderId}`,
        senderId,
        payload: {
          channel_user_id: senderId,
          ...payload,
        },
      });
    } catch (err) {
      logger.warn({ err, type }, 'Failed to record Telegram memory event');
    }
  }

  private tombstoneTenantMemory(
    tenant: TelegramTenantView,
    senderId: string,
  ): MemoryDeletionResult {
    const groupRoot = path.resolve(GROUPS_DIR, tenant.folder);
    const memoryRoot = path.join(groupRoot, 'memory');
    let groupReal: string;
    let memoryReal: string;
    try {
      const groupStat = fs.lstatSync(groupRoot);
      if (!groupStat.isDirectory() || groupStat.isSymbolicLink()) {
        throw new Error('unsafe tenant group folder');
      }
      groupReal = fs.realpathSync(groupRoot);
      try {
        fs.mkdirSync(memoryRoot, { mode: 0o700 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const memoryStat = fs.lstatSync(memoryRoot);
      memoryReal = fs.realpathSync(memoryRoot);
      if (
        !memoryStat.isDirectory() ||
        memoryStat.isSymbolicLink() ||
        path.dirname(memoryReal) !== groupReal ||
        path.basename(memoryReal) !== 'memory'
      ) {
        throw new Error('unsafe tenant memory folder');
      }
    } catch {
      return {
        status: 'unavailable',
        deletedFiles: [],
        reason: 'tenant_memory_folder_unsafe',
      };
    }

    const timestamp = new Date().toISOString();
    const stamp = timestamp.replace(/[:.]/g, '-');
    const tombstoneRel = `tombstones/memory-delete-${stamp}.json`;
    const tombstone = tombstoneMarkdownTreeNoFollowSync({
      memoryDirectory: memoryReal,
      tombstoneFileName: `memory-delete-${stamp}.json`,
      renameStamp: stamp,
      metadata: {
        tenant_id: tenant.tenant_id,
        chat_id: tenant.chat_id,
        folder: tenant.folder,
        sender_id: senderId,
        created_at: timestamp,
        note: 'Tenant memory markdown files were renamed to non-markdown tombstones. Audit/accounting/message tables were not deleted.',
      },
      maxBytes: MAX_MEMORY_DELETE_TOMBSTONE_BYTES,
      maxEntries: 10_000,
    });

    return {
      status: 'deleted',
      deletedFiles: tombstone.deletedFiles,
      tombstoneFile: tombstoneRel,
    };
  }

  /**
   * Whether an inbound text message is actually addressed to the bot. Private
   * chats are always a direct 1:1 conversation. In group/supergroup chats the
   * bot is "addressed" only when the message replies to one of the bot's own
   * messages, @mentions the bot (by username or text_mention), or carries the
   * configured text trigger (e.g. "@Skoobi ..."). Used to gate the deterministic
   * text-intent parsers (quota, memory deletion) so a bare phrase typed to
   * other group members does not trigger an unsolicited bot reply.
   */
  private isAddressedToBot(ctx: any, content: string): boolean {
    if (ctx.chat?.type === 'private') return true;

    if (TRIGGER_PATTERN.test(content.trim())) return true;

    if (telegramBotMentionRanges(ctx, content).length > 0) return true;

    const botId = telegramBotUserId(ctx.me?.id);
    const replyFromId = ctx.message?.reply_to_message?.from?.id;
    if (botId !== null && telegramBotUserId(replyFromId) === botId) {
      return true;
    }

    return false;
  }

  private async handleMemoryPrivacyTextIntent(
    ctx: any,
    text: string,
  ): Promise<boolean> {
    // Native forwards, inline-bot results, quoted/code entities and other
    // indirect Telegram origins are data, never authority for a destructive
    // two-step memory deletion flow. Returning false lets the downgraded agent
    // handle the text normally without creating or consuming a host challenge.
    if (telegramMessageOriginForContext(ctx) !== 'direct') return false;
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id?.toString();
    if (chatId === undefined || chatId === null || !fromId) return false;

    const tenant = this.tenantForChat(chatId);
    if (!tenant) return false;

    const key = this.memoryDeleteKey(tenant.tenant_id, fromId);
    const pending = this.pendingMemoryDeletes.get(key);
    const now = Date.now();

    // DATA-INTEGRITY (finding #41): memory deletion is TENANT-scoped — it
    // tombstones every markdown file under the tenant's memory folder, i.e. the
    // shared memory of the whole group, not just the requester's own context.
    // In a private chat the tenant is the single user, so self-deletion is fine.
    // In a group/supergroup the tenant is shared, so any member who triggers
    // the intent could wipe everyone's memory. Restrict the destructive flow to
    // the owner/command-admin in non-private chats. Only intercept recognised
    // memory-delete intents so unrelated text still falls through unchanged.
    const isPrivateChat = ctx.chat?.type === 'private';
    const isMemoryDeleteIntentText =
      isMemoryDeleteConfirmation(text) ||
      isMemoryDeleteTextIntent(text) ||
      (!!pending &&
        pending.expiresAtMs > now &&
        looksLikeLooseMemoryDeleteConfirmation(text));
    if (
      !isPrivateChat &&
      isMemoryDeleteIntentText &&
      !isCommandAdminContext(this.opts, ctx)
    ) {
      replySafely(
        ctx,
        'Удаление общей памяти этого чата доступно только владельцу/админу бота.',
      );
      return true;
    }

    if (isMemoryDeleteConfirmation(text)) {
      if (!pending || pending.expiresAtMs <= now) {
        this.pendingMemoryDeletes.delete(key);
        replySafely(
          ctx,
          `Нет активного запроса на удаление памяти. Сначала напиши: «удали память».`,
        );
        return true;
      }

      this.recordMemoryDeleteEvent(tenant, fromId, 'memory_delete_requested', {
        status: 'confirmed',
        requested_at: pending.requestedAt,
        confirmed_at: new Date(now).toISOString(),
        scope: 'tenant_user_memory',
      });
      let result: MemoryDeletionResult;
      try {
        result = this.tombstoneTenantMemory(tenant, fromId);
      } catch (err) {
        logger.error({ err, folder: tenant.folder }, 'Memory deletion failed');
        result = {
          status: 'unavailable',
          deletedFiles: [],
          reason: 'exception',
        };
      }
      this.pendingMemoryDeletes.delete(key);

      if (result.status === 'deleted') {
        this.recordMemoryDeleteEvent(tenant, fromId, 'memory_deleted', {
          status: 'deleted',
          deleted_files: result.deletedFiles,
          deleted_count: result.deletedFiles.length,
          tombstone_file: result.tombstoneFile,
          preserved_tables: [
            'messages',
            'events',
            'usage_ledger',
            'usage_events',
            'model_traces',
          ],
        });
        replySafely(
          ctx,
          [
            'Готово: сохранённая память этого чата удалена или помечена tombstone.',
            'Audit-история, сообщения, события и учёт расходов не удалялись, потому что это безопасность и accounting.',
          ].join('\n'),
        );
      } else {
        this.recordMemoryDeleteEvent(
          tenant,
          fromId,
          'memory_delete_unavailable',
          {
            status: 'unavailable',
            reason: result.reason || 'unknown',
          },
        );
        replySafely(
          ctx,
          'Запрос зафиксирован, но автоматическое удаление памяти пока не реализовано для этого хранилища.',
        );
      }
      return true;
    }

    if (
      pending &&
      pending.expiresAtMs > now &&
      looksLikeLooseMemoryDeleteConfirmation(text)
    ) {
      replySafely(
        ctx,
        `Для удаления памяти нужно точное подтверждение: ${MEMORY_DELETE_CONFIRMATION_PHRASE}`,
      );
      return true;
    }

    if (!isMemoryDeleteTextIntent(text)) return false;

    const requestedAt = new Date(now).toISOString();
    const expiresAtMs = now + MEMORY_DELETE_CONFIRMATION_TTL_MS;
    this.pendingMemoryDeletes.set(key, {
      tenantId: tenant.tenant_id,
      chatId: tenant.chat_id,
      senderId: fromId,
      folder: tenant.folder,
      requestedAt,
      expiresAtMs,
    });
    this.recordMemoryDeleteEvent(tenant, fromId, 'memory_delete_requested', {
      status: 'confirmation_required',
      scope: 'tenant_user_memory',
      requested_at: requestedAt,
      expires_at: new Date(expiresAtMs).toISOString(),
      confirmation_phrase: MEMORY_DELETE_CONFIRMATION_PHRASE,
      preserved_tables: [
        'messages',
        'events',
        'usage_ledger',
        'usage_events',
        'model_traces',
      ],
    });
    replySafely(
      ctx,
      [
        'Я могу удалить сохранённую память этого чата, но не audit-историю, события, сообщения и учёт расходов.',
        `Чтобы подтвердить, напиши: ${MEMORY_DELETE_CONFIRMATION_PHRASE}`,
      ].join('\n'),
    );
    return true;
  }

  private async answerCallbackQueryIfPresent(
    ctx: any,
    payload: string | { text: string; show_alert?: boolean },
  ): Promise<void> {
    if (!ctx.callbackQuery?.id || typeof ctx.answerCallbackQuery !== 'function')
      return;
    try {
      await ctx.answerCallbackQuery(payload);
    } catch (err) {
      if (isExpiredTelegramCallbackQueryError(err)) {
        logger.debug(
          { err: sanitizeTelegramError(err) },
          'Telegram callback answer expired',
        );
        return;
      }
      throw err;
    }
  }

  private async sendQuotaStatus(
    ctx: any,
    source: 'command' | 'callback',
  ): Promise<void> {
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
    const fromId =
      ctx.from?.id?.toString() || ctx.callbackQuery?.from?.id?.toString();
    if (chatId === undefined || chatId === null || !fromId) {
      await this.answerCallbackQueryIfPresent(
        ctx,
        'Не смог определить пользователя.',
      );
      replySafely(ctx, 'Не смог определить пользователя для статуса доступа.');
      return;
    }

    const tenant = this.tenantForChat(chatId);
    if (!tenant) {
      await this.answerCallbackQueryIfPresent(
        ctx,
        'Статус доступа доступен после подключения чата.',
      );
      replySafely(
        ctx,
        'Статус доступа доступен после подключения этого чата к Скуби.',
      );
      return;
    }

    let text: string;
    try {
      text = this.opts.host.quotaStatusTextRu({
        tenantId: tenant.tenant_id,
        channel: tenant.channel,
        channelUserId: fromId,
      });
      this.recordQuotaBalanceViewed(tenant, fromId, source);
    } catch (err) {
      logger.error({ err }, 'Telegram quota status command failed');
      await this.answerCallbackQueryIfPresent(
        ctx,
        'Не смог показать статус доступа. См. логи.',
      );
      replySafely(ctx, 'Не смог показать статус доступа. См. логи.');
      return;
    }

    const chatType = ctx.chat?.type || ctx.callbackQuery?.message?.chat?.type;
    if (chatType === 'private') {
      await this.answerCallbackQueryIfPresent(ctx, 'Показываю статус доступа.');
      replySafely(ctx, text);
      return;
    }

    try {
      const numericFromId = Number(fromId);
      const privateChatId = Number.isSafeInteger(numericFromId)
        ? numericFromId
        : fromId;
      await this.bot?.api.sendMessage(privateChatId, text);
      await this.answerCallbackQueryIfPresent(ctx, 'Отправил статус в личку.');
      replySafely(ctx, 'Отправил статус доступа в личку.');
    } catch (err) {
      logger.warn(
        { err: sanitizeTelegramError(err) },
        'Failed to send private Telegram quota status',
      );
      await this.answerCallbackQueryIfPresent(ctx, {
        text: 'Не смог написать в личку. Открой чат с ботом и отправь /limit.',
        show_alert: true,
      });
      replySafely(
        ctx,
        'Я могу показать статус доступа только лично. Открой чат с ботом и отправь /limit.',
      );
    }
  }

  private async handleQuotaTextIntent(
    ctx: any,
    text: string,
  ): Promise<boolean> {
    if (!isQuotaTextIntent(text)) return false;
    await this.sendQuotaStatus(ctx, 'command');
    return true;
  }

  private notifyMainChats(text: string): void {
    const notifier = this.ownerNotificationChannel || this;
    if (notifier !== this) {
      notifier.notifyMainChats(text);
      return;
    }
    if (!this.bot) return;
    for (const [jid, group] of Object.entries(this.opts.registeredGroups())) {
      if (!group.isMain || !jid.startsWith('tg:')) continue;
      if (!this.ownsJid(jid)) continue;
      if (!isAdminAlertRecipient(jid)) continue;
      this.bot.api
        .sendMessage(telegramChatId(jid), text)
        .catch((err) =>
          logger.warn(
            { err: sanitizeTelegramError(err), ownerJid: jid },
            'Failed to send Telegram admin alert',
          ),
        );
    }
  }

  private resolveTelegramTarget(rawArg: string):
    | {
        jid: string;
        group?: TelegramRegisteredGroup;
        pending?: PendingTelegramUser;
      }
    | undefined {
    const arg = normalizeTelegramTarget(rawArg);
    if (!arg) return undefined;
    const norm = arg.replace(/^@/, '').toLowerCase();
    const groups = this.opts.registeredGroups();
    const pending = readPendingTelegramUsers();

    for (const [jid, group] of Object.entries(groups)) {
      const candidatePending = pending[jid];
      if (
        jid === arg ||
        jid.replace(/^tg:/, '') === arg ||
        group.folder.toLowerCase() === norm ||
        group.name.toLowerCase() === norm ||
        candidatePending?.username?.toLowerCase() === norm
      ) {
        return { jid, group, pending: candidatePending };
      }
    }
    for (const [jid, user] of Object.entries(pending)) {
      if (
        jid === arg ||
        jid.replace(/^tg:/, '') === arg ||
        user.folder?.toLowerCase() === norm ||
        user.name.toLowerCase() === norm ||
        user.username?.toLowerCase() === norm
      ) {
        return { jid, group: groups[jid], pending: user };
      }
    }
    return undefined;
  }

  private accessSummary(jid: string, group?: TelegramRegisteredGroup): string {
    const state = readTelegramAccessState();
    const entry = state[jid] || {};
    const now = new Date();
    const nowMs = now.getTime();
    const messages = pruneIsoTimestamps(
      entry.messageTimestamps,
      nowMs,
      GUEST_RATE_WINDOW_MS,
    ).length;
    const media = pruneIsoTimestamps(
      entry.mediaTimestamps,
      nowMs,
      GUEST_RATE_WINDOW_MS,
    ).length;
    const limits = group?.isMain
      ? undefined
      : group
        ? guestLimitsFor(group, nowMs)
        : undefined;
    const daily =
      entry.daily?.date === telegramDayKey(now) ? entry.daily.messages : 0;
    return [
      `JID: ${jid}`,
      group
        ? `Пользователь: ${group.name}`
        : 'Пользователь: не зарегистрирован',
      group ? `Папка: ${group.folder}` : '',
      `Статус: ${entry.status || 'active'}`,
      entry.reason ? `Причина: ${entry.reason}` : '',
      entry.outboundBlockedReason
        ? `Исходящие: недоступно (${entry.outboundBlockedReason})`
        : '',
      group?.isMain
        ? 'Лимиты: администратор, без guest-лимитов'
        : limits
          ? 'Лимиты: guest rate/daily limits отключены'
          : 'Лимиты: нет данных',
      entry.deferAgentUntil
        ? `Обработка отложена до: ${formatTimestamp(entry.deferAgentUntil)}${entry.deferredReason ? ` (${entry.deferredReason})` : ''}`
        : '',
      `Сейчас: ${messages} сообщений / 10 минут, ${media} медиа / 10 минут, ${daily} сегодня`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private setTelegramAccessStatus(
    jid: string,
    status: 'paused' | 'banned' | 'active',
    reason: string,
  ): void {
    const state = readTelegramAccessState();
    if (status === 'active') {
      delete state[jid];
    } else {
      state[jid] = {
        ...(state[jid] || {}),
        status,
        reason,
        updatedAt: new Date().toISOString(),
      };
    }
    writeTelegramAccessState(state);
  }

  private recordTelegramInbox(
    ctx: any,
    group: TelegramRegisteredGroup,
    kind: TelegramInboundKind,
    details: Partial<TelegramInboxEntry> = {},
  ): void {
    const chatJid = this.chatJidForChat(ctx.chat.id);
    try {
      appendTelegramInboxEntry(group.folder, {
        received_at: new Date().toISOString(),
        chat_jid: chatJid,
        group_folder: group.folder,
        message_id: ctx.message?.message_id?.toString() || '',
        sender: ctx.from?.id?.toString() || '',
        sender_name: telegramSenderName(ctx),
        timestamp: telegramMessageTimestamp(ctx),
        kind,
        telegram_message_origin: telegramMessageOriginForContext(ctx),
        ...details,
      });
    } catch (err) {
      logger.warn(
        { err, chatJid, folder: group.folder, kind },
        'Failed to record Telegram durable inbox entry',
      );
    }
  }

  private allowRegisteredInbound(
    ctx: any,
    group: TelegramRegisteredGroup,
    kind: 'text' | 'media',
  ): InboundAccessDecision {
    if (rejectUntrustedPrivateAdminContext(this.opts, ctx)) {
      return { accept: false, processNow: false };
    }
    if (group.isMain) return { accept: true, processNow: true };

    const chatJid = this.chatJidForChat(ctx.chat.id);
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const state = readTelegramAccessState();
    const entry: TelegramAccessEntry = state[chatJid] || {};

    const shouldNotifyUser = () =>
      accessCooldownElapsed(
        entry.lastLimitNoticeAt,
        nowMs,
        GUEST_NOTICE_COOLDOWN_MS,
      );
    const markUserNotified = () => {
      entry.lastLimitNoticeAt = nowIso;
    };
    const maybeAlertAdmins = (reason: string) => {
      if (
        !accessCooldownElapsed(
          entry.lastAdminAlertAt,
          nowMs,
          GUEST_ADMIN_ALERT_COOLDOWN_MS,
        )
      ) {
        return;
      }
      entry.lastAdminAlertAt = nowIso;
      this.notifyMainChats(
        [
          'Скуби отложил обработку входящего потока. Сообщения сохраняются.',
          `Пользователь: ${group.name}`,
          `JID: ${chatJid}`,
          `Папка: ${group.folder}`,
          `Причина: ${reason}`,
          `Команды: /limits ${group.folder}, /pause ${group.folder}, /ban ${group.folder}`,
        ].join('\n'),
      );
    };

    if (ctx.from?.is_bot === true) {
      entry.status = 'banned';
      entry.reason = 'telegram-bot-account';
      entry.updatedAt = nowIso;
      markUserNotified();
      state[chatJid] = entry;
      writeTelegramAccessState(state);
      replySafely(ctx, 'Боты не подключаются к Скуби. Доступ заблокирован.');
      maybeAlertAdmins('telegram bot account');
      logger.warn(
        { chatJid, folder: group.folder },
        'Telegram bot user blocked',
      );
      return {
        accept: false,
        processNow: false,
        reason: 'telegram bot account',
      };
    }

    if (clearTelegramOutboundBlocked(entry)) {
      entry.updatedAt = nowIso;
      logger.info(
        { chatJid, folder: group.folder },
        'Telegram outbound unreachable marker cleared by inbound message',
      );
    }

    if (entry.status === 'banned') {
      if (shouldNotifyUser()) {
        markUserNotified();
        replySafely(ctx, 'Доступ к Скуби заблокирован администратором.');
      }
      state[chatJid] = entry;
      writeTelegramAccessState(state);
      logger.info(
        { chatJid, folder: group.folder, status: entry.status },
        'Telegram inbound blocked by manual access status',
      );
      return { accept: false, processNow: false, reason: 'banned' };
    }

    const paused = entry.status === 'paused';
    if (paused && shouldNotifyUser()) {
      markUserNotified();
      replySafely(
        ctx,
        'Скуби получил сообщение, но обработка временно приостановлена администратором.',
      );
    }

    const limits = guestLimitsFor(group, nowMs);
    entry.messageTimestamps = pruneIsoTimestamps(
      entry.messageTimestamps,
      nowMs,
      GUEST_RATE_WINDOW_MS,
    );
    entry.mediaTimestamps = pruneIsoTimestamps(
      entry.mediaTimestamps,
      nowMs,
      GUEST_RATE_WINDOW_MS,
    );
    const day = telegramDayKey(now);
    if (entry.daily?.date !== day) {
      entry.daily = { date: day, messages: 0, media: 0 };
    }
    const existingDeferredUntilMs = entry.deferAgentUntil
      ? new Date(entry.deferAgentUntil).getTime()
      : 0;
    const deferredActive =
      Number.isFinite(existingDeferredUntilMs) &&
      existingDeferredUntilMs > nowMs;

    const reasons: string[] = [];
    if (entry.messageTimestamps.length >= limits.messagesPerWindow) {
      reasons.push(`${limits.messagesPerWindow} сообщений за 10 минут`);
    }
    if (
      kind === 'media' &&
      entry.mediaTimestamps.length >= limits.mediaPerWindow
    ) {
      reasons.push(`${limits.mediaPerWindow} медиа за 10 минут`);
    }
    const dailyLimited = (entry.daily?.messages || 0) >= limits.messagesPerDay;
    if (dailyLimited) {
      reasons.push(`${limits.messagesPerDay} сообщений за день`);
    }

    entry.messageTimestamps.push(nowIso);
    entry.daily!.messages += 1;
    if (kind === 'media') {
      entry.mediaTimestamps.push(nowIso);
      entry.daily!.media += 1;
    }

    if (reasons.length > 0) {
      const reason = reasons.join(', ');
      const deferMs = dailyLimited
        ? GUEST_DAILY_DEFER_MS
        : GUEST_RATE_WINDOW_MS;
      const nextUntil = nowMs + deferMs;
      const currentUntil = Number.isFinite(existingDeferredUntilMs)
        ? existingDeferredUntilMs
        : 0;
      entry.deferAgentUntil = new Date(
        Math.max(currentUntil, nextUntil),
      ).toISOString();
      entry.deferredReason = reason;
      entry.deferredCount = (entry.deferredCount || 0) + 1;
      if (shouldNotifyUser()) {
        markUserNotified();
        replySafely(
          ctx,
          `Я получил сообщение и сохраню его, но обработаю чуть позже. Лимит: ${reason}.`,
        );
      }
      maybeAlertAdmins(reason);
      state[chatJid] = entry;
      writeTelegramAccessState(state);
      logger.warn(
        { chatJid, folder: group.folder, reason },
        'Telegram inbound processing deferred by rate limit',
      );
      return { accept: true, processNow: false, reason };
    }

    state[chatJid] = entry;
    writeTelegramAccessState(state);
    if (paused) {
      logger.info(
        { chatJid, folder: group.folder },
        'Telegram inbound stored while manual processing pause is active',
      );
      return { accept: true, processNow: false, reason: 'paused' };
    }
    if (deferredActive) {
      return {
        accept: true,
        processNow: false,
        reason: entry.deferredReason || 'deferred',
      };
    }
    return { accept: true, processNow: true };
  }

  private async publishBotCommands(): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.setMyCommands(PUBLIC_BOT_COMMANDS);
      // Owner chats get the full menu (a superset of the admin commands). Track
      // them so the admin loop below does NOT overwrite the owner menu for an
      // owner who is also listed as a command-admin (else the owner would only
      // see the admin commands and lose owner-only entries such as /health).
      const ownerChatIds = new Set<string>();
      for (const [jid, group] of Object.entries(this.opts.registeredGroups())) {
        if (!group.isMain || !jid.startsWith('tg:')) continue;
        if (!this.ownsJid(jid)) continue;
        const chatId = telegramChatId(jid);
        await this.bot.api.setMyCommands(OWNER_BOT_COMMANDS, {
          scope: {
            type: 'chat',
            chat_id: chatId,
          },
        });
        ownerChatIds.add(String(chatId));
        logger.info({ jid }, 'Telegram owner command menu published');
      }
      const adminCommands = [
        ...PUBLIC_BOT_COMMANDS,
        ...COMMAND_ADMIN_BOT_COMMANDS,
      ];
      for (const adminId of commandAdminUserIds()) {
        if (ownerChatIds.has(String(adminId))) continue;
        try {
          const numericId = Number(adminId);
          await this.bot.api.setMyCommands(adminCommands, {
            scope: {
              type: 'chat',
              chat_id: Number.isSafeInteger(numericId) ? numericId : adminId,
            },
          });
          logger.info({ adminId }, 'Telegram command admin menu published');
        } catch (err) {
          logger.warn(
            { adminId, err: sanitizeTelegramError(err) },
            'Failed to publish Telegram command admin menu',
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err: sanitizeTelegramError(err) },
        'Failed to publish Telegram command menu',
      );
    }
  }

  private pendingFromContext(
    ctx: any,
    language: TelegramLanguageCode,
  ): PendingTelegramUser {
    const jid = this.chatJidForChat(ctx.chat.id);
    const from = ctx.from || ctx.callbackQuery?.from;
    const username = from?.username
      ? String(from.username).replace(/^@/, '')
      : undefined;
    const name =
      [from?.first_name, from?.last_name].filter(Boolean).join(' ') ||
      username ||
      (ctx.chat as any).title ||
      jid;
    const now = new Date().toISOString();
    return {
      jid,
      name,
      username,
      isBot: from?.is_bot === true,
      chatType: ctx.chat.type || 'unknown',
      language,
      requestedAt: now,
      lastSeenAt: now,
      status: 'pending',
    };
  }

  private async notifyOwnersOfPending(
    user: PendingTelegramUser,
  ): Promise<number> {
    const notifier = this.ownerNotificationChannel || this;
    if (notifier !== this) {
      return notifier.notifyOwnersOfPending(user);
    }
    if (!this.bot) return 0;
    let sent = 0;
    for (const [jid, group] of Object.entries(this.opts.registeredGroups())) {
      if (!group.isMain || !jid.startsWith('tg:')) continue;
      if (!this.ownsJid(jid)) continue;
      try {
        await this.bot.api.sendMessage(
          telegramChatId(jid),
          pendingUserText(user),
          {
            reply_markup: approvalKeyboard(user.jid),
          },
        );
        sent += 1;
      } catch (err) {
        logger.warn(
          {
            err: sanitizeTelegramError(err),
            ownerJid: jid,
            applicantJid: user.jid,
          },
          'Failed to notify owner about pending Telegram user',
        );
      }
    }
    return sent;
  }

  // Subscription sales are disabled for the product. Keep this handler as a
  // safe sink for old deep links and stale inline buttons so they never create
  // a payment after the business model switch.
  private async handlePlanPurchase(
    ctx: any,
    planCode: string,
  ): Promise<boolean> {
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
    const language =
      chatId === undefined || chatId === null
        ? undefined
        : telegramUserLanguage(this.chatJidForChat(chatId));
    logger.info({ plan: planCode }, 'Telegram subscription purchase disabled');
    replySafely(ctx, subscribeText(language));
    return true;
  }

  private async requestTelegramAccess(
    ctx: any,
    selectedLanguage?: TelegramLanguageCode,
  ): Promise<void> {
    const initialLanguage = languageCodeOrDefault(
      selectedLanguage ||
        (ctx.chat?.id
          ? telegramUserLanguage(this.chatJidForChat(ctx.chat.id))
          : undefined),
    );
    if (ctx.from?.is_bot === true) {
      logger.warn(
        { jid: this.chatJidForChat(ctx.chat.id), username: ctx.from?.username },
        'Ignoring Telegram bot access request',
      );
      replySafely(ctx, TELEGRAM_LANGUAGES[initialLanguage].botBlocked);
      return;
    }
    if (rejectUntrustedPrivateAdminContext(this.opts, ctx)) return;

    if (ctx.chat.type !== 'private') {
      replySafely(ctx, TELEGRAM_LANGUAGES[initialLanguage].privateOnly);
      return;
    }

    const fresh = this.pendingFromContext(ctx, initialLanguage);
    this.opts.onChatMetadata(
      fresh.jid,
      fresh.lastSeenAt,
      fresh.name,
      'telegram',
      false,
    );

    const pending = readPendingTelegramUsers();
    const existing = pending[fresh.jid];
    const effectiveLanguage = selectedLanguage
      ? initialLanguage
      : languageCodeOrDefault(existing?.language || initialLanguage);
    setTelegramUserLanguage(fresh.jid, effectiveLanguage);
    const shouldNotify =
      !existing ||
      existing.status !== 'pending' ||
      !existing.lastNotifiedAt ||
      Date.now() - new Date(existing.lastNotifiedAt).getTime() >=
        APPROVAL_NOTIFY_COOLDOWN_MS;

    pending[fresh.jid] = {
      ...existing,
      ...fresh,
      language: effectiveLanguage,
      requestedAt:
        existing?.status === 'pending'
          ? existing.requestedAt
          : fresh.requestedAt,
      lastNotifiedAt: shouldNotify
        ? fresh.lastSeenAt
        : existing?.lastNotifiedAt,
      status: 'pending',
      approvedAt: undefined,
      deniedAt: undefined,
      folder: undefined,
    };
    writePendingTelegramUsers(pending);

    let notified = 0;
    if (shouldNotify) {
      notified = await this.notifyOwnersOfPending(pending[fresh.jid]);
    }

    replySafely(
      ctx,
      renderAdminContact(
        notified > 0 || !shouldNotify
          ? TELEGRAM_LANGUAGES[effectiveLanguage].accessSent
          : TELEGRAM_LANGUAGES[effectiveLanguage].accessSaved,
      ),
    );
  }

  private createGuestProfile(
    user: PendingTelegramUser,
  ): TelegramRegisteredGroup {
    const folder = uniqueTelegramFolder(user, this.opts.registeredGroups());
    const language = languageCodeOrDefault(user.language);
    const groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(groupDir, 'received'), { recursive: true });
    const claudePath = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudePath)) {
      fs.writeFileSync(
        claudePath,
        guestClaudeMd(user.name, user.jid, folder, language),
      );
    }
    return {
      name: user.name,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      runtime: 'sandbox',
      agentConfig: {
        ...guestAgentConfig(user.name, user.jid, folder, language),
        ...(this.opts.personaId ? { personaId: this.opts.personaId } : {}),
      },
    };
  }

  private async sendPendingList(ctx: any): Promise<void> {
    if (!requireMainChat(this.opts, ctx)) return;
    const users = Object.values(readPendingTelegramUsers()).filter(
      (user) => user.status === 'pending',
    );
    if (users.length === 0) {
      replySafely(ctx, 'Новых заявок нет.');
      return;
    }
    for (const user of users) {
      await ctx.reply(pendingUserText(user), {
        reply_markup: approvalKeyboard(user.jid),
      });
    }
  }

  private async handleApprovalCallback(ctx: any): Promise<void> {
    const data = String(ctx.callbackQuery?.data || '');
    const match = data.match(APPROVAL_CALLBACK_RE);
    if (!match) return;

    if (!isOwnerCommandContext(this.opts, ctx)) {
      await this.answerCallbackQueryIfPresent(
        ctx,
        'Только владелец может подтверждать заявки.',
      );
      return;
    }

    const action = match[1] as 'approve' | 'deny';
    const jid = `tg:${match[2].replace(/^tg:/, '')}`;
    const owningChannel = this.channelForJid(jid);
    if (owningChannel && owningChannel !== this) {
      await owningChannel.handleApprovalCallback(ctx);
      return;
    }
    const pending = readPendingTelegramUsers();
    const user = pending[jid];
    const language = languageCodeOrDefault(
      user?.language || telegramUserLanguage(jid),
    );
    const existingGroup = this.opts.registeredGroups()[jid];
    if (!user || user.status !== 'pending') {
      if (
        action === 'approve' &&
        (user?.status === 'approved' || existingGroup)
      ) {
        const folder = user?.folder || existingGroup?.folder;
        await this.answerCallbackQueryIfPresent(
          ctx,
          'Пользователь уже активирован.',
        );
        if (ctx.editMessageText) {
          const text = user
            ? `Активировано ранее:\n\n${pendingUserText(user)}${folder ? `\nПапка: ${folder}` : ''}`
            : `Активировано ранее:\n\nJID: ${jid}${folder ? `\nПапка: ${folder}` : ''}`;
          await ctx.editMessageText(text).catch(() => undefined);
        }
        return;
      }
      if (action === 'deny' && user?.status === 'denied') {
        await this.answerCallbackQueryIfPresent(ctx, 'Заявка уже отклонена.');
        if (ctx.editMessageText) {
          await ctx
            .editMessageText(`Отклонено ранее:\n\n${pendingUserText(user)}`)
            .catch(() => undefined);
        }
        return;
      }
      await this.answerCallbackQueryIfPresent(
        ctx,
        'Заявка не найдена или уже обработана.',
      );
      return;
    }

    if (user.isBot === true) {
      pending[jid] = {
        ...user,
        language,
        status: 'denied',
        deniedAt: new Date().toISOString(),
      };
      writePendingTelegramUsers(pending);
      await this.answerCallbackQueryIfPresent(
        ctx,
        'Bot-аккаунты не активируются.',
      );
      if (ctx.editMessageText) {
        await ctx
          .editMessageText(
            `Отклонено: bot-аккаунт.\n\n${pendingUserText(user)}`,
          )
          .catch(() => undefined);
      }
      return;
    }

    if (action === 'deny') {
      pending[jid] = {
        ...user,
        language,
        status: 'denied',
        deniedAt: new Date().toISOString(),
      };
      writePendingTelegramUsers(pending);
      await this.answerCallbackQueryIfPresent(ctx, 'Заявка отклонена.');
      if (ctx.editMessageText) {
        await ctx
          .editMessageText(`Отклонено:\n\n${pendingUserText(user)}`)
          .catch(() => undefined);
      }
      try {
        await this.bot?.api.sendMessage(
          telegramChatId(jid),
          renderAdminContact(TELEGRAM_LANGUAGES[language].denied),
        );
      } catch (err) {
        if (isTelegramBotBlockedError(err)) {
          markTelegramOutboundBlocked(jid, err);
        } else {
          throw err;
        }
      }
      return;
    }

    const group =
      existingGroup || this.createGuestProfile({ ...user, language });
    if (!existingGroup) {
      if (!this.opts.registerGroup) {
        throw new Error('registerGroup callback is not available');
      }
      this.opts.registerGroup(jid, group);
    }
    this.opts.onChatMetadata(
      jid,
      new Date().toISOString(),
      user.name,
      'telegram',
      false,
    );

    pending[jid] = {
      ...user,
      language,
      status: 'approved',
      approvedAt: new Date().toISOString(),
      folder: group.folder,
    };
    writePendingTelegramUsers(pending);
    setTelegramUserLanguage(jid, language);

    await this.answerCallbackQueryIfPresent(ctx, 'Пользователь активирован.');
    if (ctx.editMessageText) {
      await ctx
        .editMessageText(
          `Активировано:\n\n${pendingUserText({ ...user, language })}\nПапка: ${group.folder}`,
        )
        .catch(() => undefined);
    }
    try {
      await this.bot?.api.sendMessage(
        telegramChatId(jid),
        onboardingText(jid, true, language),
      );
    } catch (err) {
      if (isTelegramBotBlockedError(err)) {
        markTelegramOutboundBlocked(jid, err);
      } else {
        throw err;
      }
    }
  }

  private async handleLanguageCallback(ctx: any): Promise<void> {
    const data = String(ctx.callbackQuery?.data || '');
    const match = data.match(LANGUAGE_CALLBACK_RE);
    if (!match) return;

    const language = match[1] as TelegramLanguageCode;
    const chat =
      ctx.chat ||
      ctx.callbackQuery?.message?.chat ||
      (ctx.from?.id || ctx.callbackQuery?.from?.id
        ? {
            id: ctx.from?.id || ctx.callbackQuery.from.id,
            type: 'private',
          }
        : undefined);
    if (!chat?.id) {
      await this.answerCallbackQueryIfPresent(ctx, 'Не смог определить чат.');
      return;
    }
    const from = ctx.from || ctx.callbackQuery?.from;
    const replyToCallbackChat = (
      text: string,
      options: Record<string, any> = {},
    ) =>
      this.bot?.api.sendMessage(
        telegramChatId(this.chatJidForChat(chat.id)),
        text,
        options,
      );

    const accessCtx = {
      ...ctx,
      from,
      chat: {
        ...chat,
        type: chat.type || 'private',
      },
      reply: replyToCallbackChat,
    };
    const chatJid = this.chatJidForChat(accessCtx.chat.id);
    setTelegramUserLanguage(chatJid, language);
    await this.answerCallbackQueryIfPresent(
      ctx,
      TELEGRAM_LANGUAGES[language].chosen,
    );
    if (ctx.editMessageText) {
      await ctx
        .editMessageText(TELEGRAM_LANGUAGES[language].changed)
        .catch(() => undefined);
    }

    if (this.opts.registeredGroups()[chatJid]) {
      await this.bot?.api.sendMessage(
        telegramChatId(chatJid),
        onboardingText(chatJid, true, language),
      );
      return;
    }

    await this.requestTelegramAccess(accessCtx, language);
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatJid = this.chatJidForChat(chatId);
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      replySafely(
        ctx,
        `Chat ID: \`${chatJid}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    const sendOnboarding = (ctx: any) => {
      const chatJid = this.chatJidForChat(ctx.chat.id);
      const isRegistered = Boolean(this.opts.registeredGroups()[chatJid]);
      replySafely(
        ctx,
        onboardingText(chatJid, isRegistered, telegramUserLanguage(chatJid)),
      );
    };
    this.bot.command('start', async (ctx) => {
      const chatJid = this.chatJidForChat(ctx.chat.id);
      if (ctx.from?.is_bot === true) {
        replySafely(
          ctx,
          TELEGRAM_LANGUAGES[telegramUserLanguage(chatJid)].botBlocked,
        );
        return;
      }
      if (rejectUntrustedPrivateAdminContext(this.opts, ctx)) return;
      // Start payloads never create a payment. They follow the same onboarding
      // and access-request path as a plain /start command.
      if (this.opts.registeredGroups()[chatJid]) {
        sendOnboarding(ctx);
        return;
      }
      if (ctx.chat.type === 'private') {
        replySafely(ctx, languageChoiceText(), {
          reply_markup: languageKeyboard(),
        });
        // Create the admin access request immediately, before the user picks a
        // language. The 5-minute notify cooldown in requestTelegramAccess
        // prevents a duplicate admin ping when the tglang: callback re-runs it.
        await this.requestTelegramAccess(ctx);
        return;
      }
      await this.requestTelegramAccess(ctx);
    });
    this.bot.command('help', sendOnboarding);
    this.bot.command('language', (ctx) => {
      replySafely(ctx, languageChoiceText(), {
        reply_markup: languageKeyboard(),
      });
    });
    const sendSubscribe = (ctx: any) => {
      const language = telegramUserLanguage(this.chatJidForChat(ctx.chat.id));
      replySafely(ctx, subscribeText(language));
    };
    this.bot.command('subscribe', sendSubscribe);
    this.bot.command('tariffs', sendSubscribe);
    this.bot.command('pay', sendSubscribe);
    const sendLimit = async (ctx: any) => {
      await this.sendQuotaStatus(ctx, 'command');
    };
    this.bot.command('limit', sendLimit);
    this.bot.command('balance', sendLimit);

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      replySafely(ctx, `${ASSISTANT_NAME} is online.`);
    });

    this.bot.command('engine', async (ctx) => {
      if (!requireCommandAdmin(this.opts, ctx)) return;
      try {
        const chatId = contextChatId(ctx);
        const groups = this.opts.registeredGroups();
        const group =
          chatId !== undefined && chatId !== null
            ? groups[`tg:${chatId}`] || groups[this.chatJidForChat(chatId)]
            : undefined;
        const anthropicModel =
          group?.agentConfig?.model?.trim() || 'по умолчанию (SDK)';
        const engine = readSkoobiEngineRuntimeStatus(group);
        const codexStatus = await codexCliStatus();
        const lines = engine.codexActive
          ? [
              'Движок чата',
              '├ Активный LLM: OpenAI Codex (подписка ChatGPT)',
              `│   модель: ${engine.model}`,
              `│   reasoning: ${engine.reasoningEffort || 'по умолчанию'}`,
              `│   маршрут: ${engine.route}`,
              `│   статус Codex: ${codexStatus}`,
              `├ Degraded: ${engine.degradedModel || engine.model}`,
              engine.fallbackModel
                ? `├ Codex fallback: ${engine.fallbackModel}`
                : '├ Codex fallback: выключен',
              engine.claudeFallbackEnabled
                ? `└ Claude fallback: включён (${anthropicModel})`
                : `└ Claude fallback: выключен; legacy preset: ${anthropicModel}`,
            ]
          : [
              'Движок чата',
              '├ Активный LLM: Anthropic agent SDK',
              `│   модель: ${anthropicModel}`,
              '├ OpenAI Codex',
              `│   модель: ${engine.model}`,
              `│   статус Codex: ${codexStatus}`,
              '└ Codex-маршрут сейчас не активен',
            ];
        replySafely(ctx, commandText(lines.join('\n')));
      } catch (err) {
        logger.error({ err }, 'Telegram engine command failed');
        replySafely(ctx, 'Не смог собрать статус движка. См. логи.');
      }
    });

    this.bot.command('stats', (ctx) => {
      if (!requireCommandAdmin(this.opts, ctx)) return;
      try {
        replySafely(ctx, telegramStatsReport(this.opts.host));
      } catch (err) {
        logger.error({ err }, 'Telegram stats command failed');
        replySafely(ctx, 'Не смог прочитать статистику. См. логи.');
      }
    });

    this.bot.command('pending', async (ctx) => {
      try {
        await this.sendPendingList(ctx);
      } catch (err) {
        logger.error({ err }, 'Telegram pending command failed');
        replySafely(ctx, 'Не смог показать заявки. См. логи.');
      }
    });

    this.bot.command('users', (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      const entries = Object.entries(this.opts.registeredGroups()).filter(
        ([jid]) => jid.startsWith('tg:'),
      );
      const knownNames = loadTelegramKnownNames(
        this.opts.host,
        entries.map(([jid]) => jid),
      );
      const rows = entries
        .map(([jid, group]) => ({
          jid,
          group,
          displayName: telegramDisplayName(jid, group, knownNames),
        }))
        .sort(
          (a, b) =>
            Number(Boolean(b.group.isMain)) - Number(Boolean(a.group.isMain)) ||
            a.displayName.localeCompare(b.displayName, 'ru') ||
            a.jid.localeCompare(b.jid),
        );
      const lines = [
        `Telegram users: ${rows.length}`,
        ...rows.map(({ jid, group, displayName }) => {
          const role = group.isMain ? 'main' : 'guest';
          const runtime = group.runtime || DEFAULT_RUNTIME;
          return `- ${displayName} — ${jid} — ${group.folder} (${role}, ${runtime})`;
        }),
      ];
      replySafely(ctx, commandText(lines.join('\n')));
    });

    this.bot.command('lastseen', (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      const entries = Object.entries(this.opts.registeredGroups()).filter(
        ([jid]) => jid.startsWith('tg:'),
      );
      const knownNames = loadTelegramKnownNames(
        this.opts.host,
        entries.map(([jid]) => jid),
      );
      const rows = entries
        .map(([jid, group]) => ({
          jid,
          group,
          displayName: telegramDisplayName(jid, group, knownNames),
        }))
        .sort(
          (a, b) =>
            Number(Boolean(b.group.isMain)) - Number(Boolean(a.group.isMain)) ||
            a.displayName.localeCompare(b.displayName, 'ru') ||
            a.jid.localeCompare(b.jid),
        );
      const seen = new Map<string, string | null>();
      try {
        if (rows.length > 0) {
          const dbRows = this.opts.host.chatsLastSeen(
            rows.map((row) => row.jid),
          );
          for (const row of dbRows) seen.set(row.jid, row.last_message_time);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to build Telegram lastseen report');
        replySafely(ctx, 'Не смог прочитать last seen из базы. См. логи.');
        return;
      }
      const lines = [
        `Последняя активность (${TIMEZONE})`,
        ...rows.map(
          ({ jid, displayName }) =>
            `- ${displayName}: ${formatTimestamp(seen.get(jid))} (${jid})`,
        ),
      ];
      replySafely(ctx, commandText(lines.join('\n')));
    });

    this.bot.command('health', (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      const uptimeSec = Math.round(process.uptime());
      const uptime = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`;
      const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
      let msgsToday = 0;
      try {
        msgsToday = this.opts.host.messagesToday();
      } catch {
        msgsToday = -1;
      }
      const telegramUsers = Object.keys(this.opts.registeredGroups()).filter(
        (jid) => jid.startsWith('tg:'),
      ).length;
      const lines = [
        'Health: ok',
        `PID: ${process.pid}`,
        `Uptime: ${uptime}`,
        `Memory RSS: ${memMb} MB`,
        `Telegram users: ${telegramUsers}`,
        `Messages today: ${msgsToday >= 0 ? msgsToday : 'n/a'}`,
        `IPC input/messages/tasks: ${countIpcFiles('input')}/${countIpcFiles('messages')}/${countIpcFiles('tasks')}`,
      ];
      replySafely(ctx, lines.join('\n'));
    });

    // Detailed runtime status
    this.bot.command('status', (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      const env = readEnvFile(['WHISPER_MODEL', 'CONTEXT_TOKENS']);
      const whisperModel =
        process.env.WHISPER_MODEL || env.WHISPER_MODEL || '(not set)';
      const ctxTokens =
        process.env.CONTEXT_TOKENS || env.CONTEXT_TOKENS || 'sdk default';
      const chatId = contextChatId(ctx);
      const groups = this.opts.registeredGroups();
      const group =
        chatId !== undefined && chatId !== null
          ? groups[`tg:${chatId}`] || groups[this.chatJidForChat(chatId)]
          : undefined;
      const engine = readSkoobiEngineRuntimeStatus(group);
      const llmStatus = engine.codexActive
        ? `${engine.model} via Codex; ${engine.route}`
        : 'Anthropic agent SDK';
      const uptimeSec = Math.round(process.uptime());
      const h = Math.floor(uptimeSec / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      const s = uptimeSec % 60;
      const uptime = `${h}h ${m}m ${s}s`;
      const load = os
        .loadavg()
        .map((v) => v.toFixed(2))
        .join(' / ');
      const cpus = os.cpus().length;
      const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

      let msgsToday = 0;
      try {
        msgsToday = this.opts.host.messagesToday();
      } catch {
        msgsToday = -1;
      }

      const lines = [
        `*${ASSISTANT_NAME} status*`,
        `Runtime: \`${DEFAULT_RUNTIME}\``,
        `Node: \`${process.version}\` (${process.execPath})`,
        `LLM: \`${llmStatus}\``,
        `Whisper: \`${whisperModel.split('/').pop() || whisperModel}\``,
        `TTS: \`${ttsProvider()}\` (voice: \`${ttsVoiceName()}\`)`,
        `Context: ${ctxTokens}`,
        `Uptime: ${uptime}`,
        `CPU: ${cpus} cores, load ${load}`,
        `Memory (RSS): ${memMb} MB`,
        `Messages today: ${msgsToday >= 0 ? msgsToday : 'n/a'}`,
      ];
      replySafely(ctx, lines.join('\n'), { parse_mode: 'Markdown' });
    });

    // ─── Tier 1 admin commands (owner-only) ────────────────────────────────
    // /storage           — total size per group + top-3 media types
    // /storage <folder>  — detail: counts per type, total size, oldest mtime
    // /cleanup dry       — spawn retention.ts --dry, report aggregate output
    // /keep last         — pin the latest media entry of the current group
    this.bot.command('storage', async (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      const arg = (ctx.match || '').trim();
      if (arg && !isValidGroupFolder(arg)) {
        replySafely(ctx, `Недопустимое имя папки: ${arg}`);
        return;
      }
      try {
        const msg = arg
          ? await storageForFolder(GROUPS_DIR, arg)
          : await storageOverview(GROUPS_DIR);
        replySafely(ctx, msg);
      } catch (err) {
        logger.warn({ err }, '/storage failed');
        replySafely(ctx, 'Ошибка при подсчёте storage. См. логи.');
      }
    });

    this.bot.command('cleanup', async (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      const arg = (ctx.match || '').trim();
      if (arg !== 'dry') {
        replySafely(
          ctx,
          'Используй: /cleanup dry. Реальный /cleanup run пока не реализован.',
        );
        return;
      }
      try {
        const script = retentionScriptPath();
        const { stdout, stderr } = await new Promise<{
          stdout: string;
          stderr: string;
        }>((resolve, reject) => {
          execFile(
            process.execPath,
            [script, '--dry', '--no-report'],
            { timeout: 60_000 },
            (err, stdout, stderr) => {
              if (err) reject(err);
              else resolve({ stdout, stderr });
            },
          );
        });
        const out = (stdout || '').trim().slice(0, 3500);
        replySafely(
          ctx,
          out || (stderr || '').slice(0, 1500) || 'retention dry: no output',
        );
      } catch (err) {
        logger.warn({ err }, '/cleanup dry failed');
        replySafely(ctx, 'Не удалось запустить retention dry. См. логи.');
      }
    });

    this.bot.command('keep', async (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      const arg = (ctx.match || '').trim();
      if (arg !== 'last') {
        replySafely(ctx, 'Используй: /keep last (в чате нужной группы).');
        return;
      }
      const chatJid = this.chatJidForChat(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        replySafely(ctx, 'Этот чат не зарегистрирован как группа.');
        return;
      }
      try {
        const msg = await pinLastMedia(GROUPS_DIR, group.folder);
        replySafely(ctx, msg);
      } catch (err) {
        logger.warn({ err, folder: group.folder }, '/keep last failed');
        replySafely(ctx, 'Не удалось закрепить медиа. См. логи.');
      }
    });

    this.bot.command('limits', (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      const arg = (ctx.match || '').trim();
      if (arg) {
        const target = this.resolveTelegramTarget(arg);
        if (!target) {
          replySafely(ctx, `Не нашёл пользователя: ${arg}`);
          return;
        }
        replySafely(
          ctx,
          commandText(this.accessSummary(target.jid, target.group)),
        );
        return;
      }

      const state = readTelegramAccessState();
      const groups = this.opts.registeredGroups();
      const activeRows = Object.entries(state)
        .filter(([, entry]) => entry.status)
        .map(([jid, entry]) => {
          const group = groups[jid];
          return `- ${group?.name || jid}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ''}`;
        });
      const lines = [
        'Команды:',
        '/limits <folder|jid|username>',
        '/pause <folder|jid|username> [причина]',
        '/resume <folder|jid|username>',
        '/ban <folder|jid|username> [причина]',
        '',
        activeRows.length
          ? ['Остановленные/заблокированные:', ...activeRows].join('\n')
          : 'Остановленных/заблокированных нет.',
      ];
      replySafely(ctx, commandText(lines.join('\n')));
    });

    const setAccessFromCommand = (
      ctx: any,
      status: 'paused' | 'banned' | 'active',
    ) => {
      if (!requireMainChat(this.opts, ctx)) return;
      const arg = (ctx.match || '').trim();
      const [targetArg, ...reasonParts] = arg.split(/\s+/).filter(Boolean);
      if (!targetArg) {
        const cmd =
          status === 'active'
            ? '/resume'
            : status === 'paused'
              ? '/pause'
              : '/ban';
        replySafely(ctx, `Используй: ${cmd} <folder|jid|username> [причина]`);
        return;
      }
      const target = this.resolveTelegramTarget(targetArg);
      if (!target) {
        replySafely(ctx, `Не нашёл пользователя: ${targetArg}`);
        return;
      }
      if (target.group?.isMain && status !== 'active') {
        replySafely(
          ctx,
          'Администратора нельзя поставить на паузу или забанить.',
        );
        return;
      }
      const reason =
        reasonParts.join(' ').trim() ||
        (status === 'active' ? 'manual-resume' : 'manual-admin-action');
      this.setTelegramAccessStatus(target.jid, status, reason);
      const label =
        status === 'active'
          ? 'снова активен'
          : status === 'paused'
            ? 'поставлен на паузу'
            : 'заблокирован';
      replySafely(
        ctx,
        `${target.group?.name || target.pending?.name || target.jid}: ${label}.\n${this.accessSummary(target.jid, target.group)}`,
      );
    };

    this.bot.command('pause', (ctx) => setAccessFromCommand(ctx, 'paused'));
    this.bot.command('resume', (ctx) => setAccessFromCommand(ctx, 'active'));
    this.bot.command('ban', (ctx) => setAccessFromCommand(ctx, 'banned'));

    this.bot.callbackQuery(APPROVAL_CALLBACK_RE, async (ctx) => {
      this.recordCallbackQuery(ctx, 'access_approval');
      try {
        await this.handleApprovalCallback(ctx);
      } catch (err) {
        logger.error({ err }, 'Telegram approval callback failed');
        await this.answerCallbackQueryIfPresent(
          ctx,
          'Не смог обработать заявку. См. логи.',
        );
      }
    });

    this.bot.callbackQuery(LANGUAGE_CALLBACK_RE, async (ctx) => {
      this.recordCallbackQuery(ctx, 'language_selection');
      try {
        await this.handleLanguageCallback(ctx);
      } catch (err) {
        logger.error({ err }, 'Telegram language callback failed');
        await this.answerCallbackQueryIfPresent(
          ctx,
          'Не смог выбрать язык. См. логи.',
        );
      }
    });

    this.bot.callbackQuery(QUOTA_CALLBACK_RE, async (ctx) => {
      this.recordCallbackQuery(ctx, 'quota_my_limit');
      try {
        await this.sendQuotaStatus(ctx, 'callback');
      } catch (err) {
        logger.error({ err }, 'Telegram quota callback failed');
        await this.answerCallbackQueryIfPresent(
          ctx,
          'Не смог показать статус доступа. См. логи.',
        );
      }
    });

    this.bot.callbackQuery(PLAN_CALLBACK_RE, async (ctx) => {
      this.recordCallbackQuery(ctx, 'plan_purchase');
      const data = String(ctx.callbackQuery?.data || '');
      const planCode = data.match(PLAN_CALLBACK_RE)?.[1] || '';
      try {
        const ok = planCode
          ? await this.handlePlanPurchase(ctx, planCode)
          : false;
        await this.answerCallbackQueryIfPresent(
          ctx,
          ok ? 'Платные тарифы отключены.' : 'Платные тарифы отключены.',
        );
      } catch (err) {
        logger.error({ err }, 'Telegram plan purchase callback failed');
        await this.answerCallbackQueryIfPresent(
          ctx,
          'Не смог оформить. См. логи.',
        );
      }
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = this.chatJidForChat(ctx.chat.id);
      let content = ctx.message.text;
      const timestamp = telegramMessageTimestamp(ctx);
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const senderIdentity = this.senderIdentityForContext(ctx, senderName);
      const tenantId = this.tenantIdForChat(ctx.chat.id);
      const msgId = ctx.message.message_id.toString();

      if (rejectUntrustedPrivateAdminContext(this.opts, ctx)) return;

      // Deterministic quota/memory-deletion text intents reply directly,
      // bypassing the agent. In group chats only treat a message as such an
      // intent when the bot is actually addressed (reply, @mention, or text
      // trigger); otherwise a bare phrase like "мой баланс" typed to other
      // members triggers an unsolicited bot reply. Private chats are always 1:1.
      if (this.isAddressedToBot(ctx, content)) {
        if (await this.handleQuotaTextIntent(ctx, content)) return;
        if (await this.handleMemoryPrivacyTextIntent(ctx, content)) return;
      }

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Canonicalize only Telegram-authenticated mentions of this runtime bot.
      // The runtime @username can differ from the configured text trigger.
      content = canonicalizeTelegramBotMentions(ctx, content);

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        // First contact from a new private user who skipped /start: create the
        // admin access request immediately. Reuses the 5-minute notify cooldown
        // in requestTelegramAccess for spam control, respects an admin "deny",
        // and never auto-requests from groups or bot accounts.
        if (
          ctx.chat.type === 'private' &&
          ctx.from?.is_bot !== true &&
          readPendingTelegramUsers()[chatJid]?.status !== 'denied'
        ) {
          await this.requestTelegramAccess(ctx);
        } else {
          logger.debug(
            { chatJid, chatName },
            'Message from unregistered Telegram chat',
          );
        }
        return;
      }
      const decision = this.allowRegisteredInbound(ctx, group, 'text');
      if (!decision.accept) return;
      this.recordTelegramInbox(ctx, group, 'text', {
        text: content,
        deferred: !decision.processNow,
      });

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        tenant_id: tenantId,
        sender_identity: senderIdentity,
        telegram_update_id: telegramUpdateId(ctx),
      });

      logger.info(
        { chatJid, senderHash: hashShort(senderName) },
        'Telegram message stored',
      );
    });

    // Record a saved media artefact in the per-group manifest. Best effort —
    // failures must never break message ingestion.
    const recordMedia = async (
      ctx: any,
      groupFolder: string,
      savedPath: string,
      mediaType: MediaType,
      opts: {
        hasCaption?: boolean;
        hasTranscript?: boolean;
        transcriptChars?: number;
      } = {},
    ): Promise<void> => {
      try {
        const folderAbs = resolveGroupFolderPath(groupFolder);
        const basename = path.basename(savedPath);
        let sizeBytes = 0;
        try {
          const stat = await fs.promises.stat(savedPath);
          sizeBytes = stat.size;
        } catch {
          // file may have been moved/deleted; record entry with size 0
        }
        const entry: MediaEntry = {
          message_id: ctx.message.message_id.toString(),
          chat_jid: this.chatJidForChat(ctx.chat.id),
          basename,
          type: mediaType,
          size_bytes: sizeBytes,
          has_transcript: !!opts.hasTranscript,
          has_caption: !!opts.hasCaption,
          transcript_chars: opts.transcriptChars ?? 0,
          created_at: new Date().toISOString(),
          keep: false,
        };
        await appendMediaEntry(folderAbs, entry);
      } catch (err) {
        logger.warn(
          { err, groupFolder },
          'Failed to record media manifest entry',
        );
      }
    };

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (
      ctx: any,
      placeholder: string,
      opts: {
        skipAccessCheck?: boolean;
        skipInbox?: boolean;
        accessDecision?: InboundAccessDecision;
        kind?: TelegramInboundKind;
        inbox?: Partial<TelegramInboxEntry>;
      } = {},
    ) => {
      const chatJid = this.chatJidForChat(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      const decision =
        opts.accessDecision ||
        (opts.skipAccessCheck
          ? { accept: true, processNow: true }
          : this.allowRegisteredInbound(ctx, group, 'media'));
      if (!decision.accept) {
        return;
      }
      if (!opts.skipInbox) {
        this.recordTelegramInbox(ctx, group, opts.kind || 'other', {
          caption: ctx.message.caption,
          deferred: !decision.processNow,
          ...opts.inbox,
        });
      }

      const timestamp = telegramMessageTimestamp(ctx);
      const senderName = telegramSenderName(ctx);
      const senderIdentity = this.senderIdentityForContext(ctx, senderName);
      const tenantId = this.tenantIdForChat(ctx.chat.id);
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
        tenant_id: tenantId,
        sender_identity: senderIdentity,
        telegram_update_id: telegramUpdateId(ctx),
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = this.chatJidForChat(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      const decision = this.allowRegisteredInbound(ctx, group, 'media');
      if (!decision.accept) return;

      // Telegram sends `photo` as array of sizes; last is biggest
      const sizes = ctx.message.photo || [];
      const biggest = sizes[sizes.length - 1];
      const fileId = biggest?.file_id;
      this.recordTelegramInbox(ctx, group, 'photo', {
        caption: ctx.message.caption,
        deferred: !decision.processNow,
        file_id: fileId,
        file_unique_id: biggest?.file_unique_id,
        media_group_id: ctx.message.media_group_id,
      });
      if (!fileId) {
        storeNonText(ctx, '[Photo]', {
          skipAccessCheck: true,
          skipInbox: true,
        });
        return;
      }

      try {
        const savedPath = await downloadTelegramPhoto(
          this.botToken,
          fileId,
          group.folder,
        );

        // Vision caption (Tier 1): instead of leaking the absolute path in
        // the placeholder, ask Haiku for a 1–2 sentence Russian description
        // and use that as searchable context. Failure → null → '[Photo]'.
        let visionCaption: string | null = null;
        if (savedPath) {
          visionCaption = await this.opts.host.captionPhoto(savedPath, {
            groupFolder: group.folder,
            chatJid,
          });
        }

        let placeholder: string;
        const fileRef = savedPath
          ? ` File: received/${path.basename(savedPath)} — use Read tool to inspect visual context`
          : '';
        if (savedPath && visionCaption) {
          placeholder = `[Photo: ${visionCaption}.${fileRef}]`;
        } else if (savedPath) {
          placeholder = `[Photo.${fileRef}]`;
        } else {
          placeholder = '[Photo — download failed]';
        }

        storeNonText(ctx, placeholder, {
          skipAccessCheck: true,
          skipInbox: true,
        });
        if (savedPath) {
          await recordMedia(ctx, group.folder, savedPath, 'photo', {
            hasCaption: !!visionCaption || !!ctx.message.caption,
          });
        }
      } catch (err) {
        logger.warn(
          { err, chatJid, fileId },
          'Telegram photo handling failed after download attempt',
        );
        storeNonText(ctx, '[Photo — download failed]', {
          skipAccessCheck: true,
          skipInbox: true,
        });
      }
    });
    this.bot.on('message:video', async (ctx) => {
      const chatJid = this.chatJidForChat(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      const decision = this.allowRegisteredInbound(ctx, group, 'media');
      if (!decision.accept) return;

      const fileId = ctx.message.video?.file_id;
      this.recordTelegramInbox(ctx, group, 'video', {
        caption: ctx.message.caption,
        deferred: !decision.processNow,
        file_id: fileId,
        file_unique_id: ctx.message.video?.file_unique_id,
        media_group_id: ctx.message.media_group_id,
      });
      if (!fileId) {
        storeNonText(ctx, '[Video]', {
          skipAccessCheck: true,
          skipInbox: true,
        });
        return;
      }

      const result = await processTelegramVideoFile(
        this.botToken,
        fileId,
        group.folder,
      );
      const frameCaptions =
        result.framePaths.length > 0
          ? await captionVideoNoteFrames(this.opts.host, result.framePaths, {
              groupFolder: group.folder,
              chatJid,
            })
          : [];

      const parts: string[] = [];
      if (result.transcript) {
        parts.push(`Transcript: ${result.transcript}`);
      } else {
        parts.push('transcription failed or no speech detected');
      }
      if (frameCaptions.length > 0) {
        parts.push(`Visual summary: ${frameCaptions.join('. ')}`);
      }
      const frameRefs = result.framePaths.map(
        (framePath) => `received/${path.basename(framePath)}`,
      );
      if (frameRefs.length > 0) {
        parts.push(`Key-frame files: ${frameRefs.join(', ')}`);
      } else {
        parts.push('frame extraction failed');
      }

      const placeholder =
        result.videoPath || result.transcript || result.framePaths.length > 0
          ? `[Video ${parts.join('. ')}]`
          : '[Video — processing failed]';

      storeNonText(ctx, placeholder, {
        skipAccessCheck: true,
        skipInbox: true,
      });
      // DATA-INTEGRITY (finding #44): record the video file as 'video' but the
      // extracted key-frames (real .jpg images) as 'photo'. Tagging frames as
      // 'video' gave them the default (~30d) TTL instead of the photo TTL and
      // skipped the photo-needs-caption keep rule, and disagreed with the
      // backfill script, which infers the same `-frame-NN.jpg` files as 'photo'
      // by extension. Recording them as 'photo' keeps the live handler and the
      // backfill writer consistent for the same files.
      if (result.videoPath) {
        await recordMedia(ctx, group.folder, result.videoPath, 'video', {
          hasTranscript: !!result.transcript,
          transcriptChars: result.transcript ? result.transcript.length : 0,
        });
      }
      for (const framePath of result.framePaths.filter(Boolean)) {
        await recordMedia(ctx, group.folder, framePath, 'photo', {
          hasTranscript: !!result.transcript,
          transcriptChars: result.transcript ? result.transcript.length : 0,
        });
      }
    });
    this.bot.on('message:video_note', async (ctx) => {
      const chatJid = this.chatJidForChat(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      const decision = this.allowRegisteredInbound(ctx, group, 'media');
      if (!decision.accept) return;

      const fileId = ctx.message.video_note?.file_id;
      this.recordTelegramInbox(ctx, group, 'video-note', {
        deferred: !decision.processNow,
        file_id: fileId,
        file_unique_id: ctx.message.video_note?.file_unique_id,
      });
      if (!fileId) {
        storeNonText(ctx, '[Video note]', {
          skipAccessCheck: true,
          skipInbox: true,
        });
        return;
      }

      const result = await processTelegramVideoNote(
        this.botToken,
        fileId,
        group.folder,
      );
      const frameCaptions =
        result.framePaths.length > 0
          ? await captionVideoNoteFrames(this.opts.host, result.framePaths, {
              groupFolder: group.folder,
              chatJid,
            })
          : [];

      // Tier 1: placeholders go into the DB and must not leak absolute paths.
      // Guest live/Codex runs do not receive file tools, so we include a short
      // textual vision summary from key frames while keeping file refs relative.
      const parts: string[] = [];
      if (result.transcript) {
        parts.push(`Transcript: ${result.transcript}`);
      } else {
        parts.push('transcription failed or no speech detected');
      }
      if (frameCaptions.length > 0) {
        parts.push(`Visual summary: ${frameCaptions.join('. ')}`);
      }
      const frameRefs = result.framePaths.map(
        (framePath) => `received/${path.basename(framePath)}`,
      );
      if (frameRefs.length > 0) {
        parts.push(`Key-frame files: ${frameRefs.join(', ')}`);
      } else {
        parts.push('frame extraction failed');
      }

      const placeholder =
        result.videoPath || result.transcript || result.framePaths.length > 0
          ? `[Video note ${parts.join('. ')}]`
          : '[Video note — processing failed]';

      storeNonText(ctx, placeholder, {
        skipAccessCheck: true,
        skipInbox: true,
      });
      const savedMedia = [result.videoPath, ...result.framePaths].filter(
        (savedPath): savedPath is string => Boolean(savedPath),
      );
      for (const savedPath of savedMedia) {
        await recordMedia(ctx, group.folder, savedPath, 'video-note', {
          hasTranscript: !!result.transcript,
          transcriptChars: result.transcript ? result.transcript.length : 0,
        });
      }
    });
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = this.chatJidForChat(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      const decision = this.allowRegisteredInbound(ctx, group, 'media');
      if (!decision.accept) return;

      const fileId = ctx.message.voice?.file_id;
      this.recordTelegramInbox(ctx, group, 'voice', {
        deferred: !decision.processNow,
        file_id: fileId,
        file_unique_id: ctx.message.voice?.file_unique_id,
      });
      if (!fileId) {
        storeNonText(ctx, '[Voice message]', {
          skipAccessCheck: true,
          skipInbox: true,
        });
        return;
      }

      // Download once, keep the exact saved file for the media manifest, then
      // pass that same local path through the channel-agnostic STT pipeline.
      // The shared pipeline owns language auto-detection and any local retries.
      const savedPath = await downloadTelegramAudio(
        this.botToken,
        fileId,
        group.folder,
        'voice',
      );
      const transcriptResult = savedPath
        ? await transcribeAudioFile(savedPath).catch(() => null)
        : null;

      const transcript = transcriptResult || '';
      let placeholder: string;
      if (transcript) {
        placeholder = `[Voice: ${transcript}]`;
      } else if (savedPath) {
        placeholder = '[Voice — transcription failed]';
      } else {
        placeholder = '[Voice message - transcription unavailable]';
      }

      storeNonText(ctx, placeholder, {
        skipAccessCheck: true,
        skipInbox: true,
      });
      if (savedPath) {
        await recordMedia(ctx, group.folder, savedPath, 'voice', {
          hasTranscript: !!transcript,
          transcriptChars: transcript ? transcript.length : 0,
        });
      }
    });
    this.bot.on('message:audio', async (ctx) => {
      const chatJid = this.chatJidForChat(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      const decision = this.allowRegisteredInbound(ctx, group, 'media');
      if (!decision.accept) return;

      const fileId = ctx.message.audio?.file_id;
      this.recordTelegramInbox(ctx, group, 'audio', {
        caption: ctx.message.caption,
        deferred: !decision.processNow,
        file_id: fileId,
        file_unique_id: ctx.message.audio?.file_unique_id,
        file_name: ctx.message.audio?.file_name,
      });
      if (!fileId) {
        storeNonText(ctx, '[Audio]', {
          skipAccessCheck: true,
          skipInbox: true,
        });
        return;
      }

      const savedPath = await downloadTelegramAudio(
        this.botToken,
        fileId,
        group.folder,
        'audio',
      );
      const transcriptResult = savedPath
        ? await transcribeAudioFile(savedPath).catch(() => null)
        : null;

      const transcript = transcriptResult || '';
      let placeholder: string;
      if (transcript) {
        placeholder = `[Audio: ${transcript}]`;
      } else if (savedPath) {
        placeholder = '[Audio — transcription failed]';
      } else {
        placeholder = '[Audio - transcription unavailable]';
      }

      storeNonText(ctx, placeholder, {
        skipAccessCheck: true,
        skipInbox: true,
      });
      if (savedPath) {
        await recordMedia(ctx, group.folder, savedPath, 'audio', {
          hasTranscript: !!transcript,
          transcriptChars: transcript ? transcript.length : 0,
        });
      }
    });
    this.bot.on('message:document', async (ctx) => {
      const chatJid = this.chatJidForChat(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      const decision = this.allowRegisteredInbound(ctx, group, 'media');
      if (!decision.accept) return;

      const fileId = ctx.message.document?.file_id;
      const name = safeTelegramDocumentName(
        ctx.message.document?.file_name || 'file',
      );
      this.recordTelegramInbox(ctx, group, 'document', {
        caption: ctx.message.caption,
        deferred: !decision.processNow,
        file_id: fileId,
        file_unique_id: ctx.message.document?.file_unique_id,
        file_name: name,
      });
      if (!fileId) {
        storeNonText(ctx, `[Document: ${name}]`, {
          skipAccessCheck: true,
          skipInbox: true,
        });
        return;
      }

      const result = await processTelegramDocument(
        this.botToken,
        fileId,
        group.folder,
        name,
      );
      storeNonText(ctx, documentPlaceholder(result), {
        skipAccessCheck: true,
        skipInbox: true,
      });
      if (result.filePath) {
        await recordMedia(ctx, group.folder, result.filePath, 'document', {
          hasCaption: !!result.preview,
        });
      }
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`, {
        kind: 'sticker',
        inbox: {
          file_id: ctx.message.sticker?.file_id,
          file_unique_id: ctx.message.sticker?.file_unique_id,
        },
      });
    });
    this.bot.on('message:location', (ctx) =>
      storeNonText(ctx, '[Location]', { kind: 'location' }),
    );
    this.bot.on('message:contact', (ctx) =>
      storeNonText(ctx, '[Contact]', { kind: 'contact' }),
    );

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    await this.publishBotCommands();

    // Start polling. grammy's start() resolves only when the bot STOPS; it
    // rejects when startup (getMe/init/long-poll setup) fails before onStart
    // fires — e.g. a revoked or malformed token, a 401, or a network error.
    // The previous code never observed that rejection, so a bad token left
    // connect() pending until the orchestrator's 30s connect timeout and
    // surfaced as a floating unhandled rejection. Resolve connect() from
    // onStart on success and reject it on a pre-onStart failure so startup
    // fails fast and loudly. Promise.resolve() tolerates a stubbed start()
    // that returns a non-Promise.
    return new Promise<void>((resolve, reject) => {
      let onStartFired = false;
      const startResult = this.bot!.start({
        onStart: (botInfo) => {
          onStartFired = true;
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
      void Promise.resolve(startResult).catch((err: unknown) => {
        logger.error(
          { err: sanitizeTelegramError(err) },
          'Telegram bot start failed',
        );
        if (!onStartFired) {
          // Pre-onStart failure: startup never succeeded, reject connect().
          reject(err);
          return;
        }
        // RELIABILITY (finding #18): a failure AFTER onStart means grammy
        // rethrew a fatal polling error (401 revoked/invalid token, or 409
        // Conflict from a second getUpdates consumer) and the long-polling
        // loop is now permanently dead. connect() already resolved, so this
        // is otherwise just a log line — but the polling loop is dead while
        // `this.bot` stays non-null, leaving isConnected() falsely reporting
        // healthy. The orchestrator gates inbound health and outbound delivery
        // on isConnected(), so it would never notice inbound went deaf.
        // Surface reality: alert owners (best effort, via the separate owner
        // notification channel when available since our own bot is dead), then
        // null out the bot so isConnected() returns false and the
        // orchestrator's health/restart logic can act.
        this.handleFatalPollingExit(err);
      });
    });
  }

  /**
   * RELIABILITY (finding #18): handle a fatal, post-onStart polling exit.
   * grammy retries transient/network/429 errors internally but rethrows on a
   * 401 (revoked/invalid token) or 409 (Conflict — another getUpdates consumer
   * is sharing this token). Either way the long-polling loop is dead and the
   * bot will receive no further inbound messages. We distinguish the two for
   * alerting (a 409 may clear once the other consumer stops; a 401 means the
   * token is invalid and needs operator action) and, in both cases, null out
   * the bot so isConnected() reports the channel as down. That lets the
   * orchestrator's health/restart logic and the outbound-router's
   * isConnected() gate stop treating a deaf channel as healthy.
   */
  private handleFatalPollingExit(err: unknown): void {
    const deadBot = this.bot;
    if (!deadBot) return; // already torn down (e.g. disconnect() raced us)
    const code = telegramErrorCode(err);
    const isConflict = code === 409;
    const isUnauthorized = code === 401;
    const detail = isConflict
      ? 'Telegram getUpdates conflict (409) — another consumer is polling this bot token. Inbound polling has stopped; restart this instance after clearing the duplicate consumer.'
      : isUnauthorized
        ? 'Telegram bot token rejected (401) — token is invalid or revoked. Inbound polling has stopped; rotate/restore the token and restart this instance.'
        : 'Telegram inbound polling stopped due to a fatal error. Restart this instance to recover.';
    logger.error(
      { err: sanitizeTelegramError(err), code, isConflict, isUnauthorized },
      'Telegram inbound polling died — marking channel disconnected',
    );
    // Best-effort owner alert. Route through notifyMainChats, which prefers the
    // separate owner-notification channel — our own bot is about to be nulled.
    try {
      this.notifyMainChats(`Внимание: ${detail}`);
    } catch (alertErr) {
      logger.warn(
        { err: sanitizeTelegramError(alertErr) },
        'Failed to alert owners about dead Telegram polling',
      );
    }
    // Stop the (now-dead) client and null it so isConnected() returns false.
    try {
      void Promise.resolve(deadBot.stop()).catch(() => {});
    } catch {
      // stop() on an already-failed bot may throw synchronously; ignore.
    }
    this.bot = null;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      throw new Error('Telegram bot not initialized');
    }

    try {
      const numericId = this.telegramChatIdForJid(jid);
      const accessEntry = readTelegramAccessState()[jid];
      if (accessEntry?.outboundBlockedReason === 'bot_blocked_by_user') {
        throw new Error('Telegram chat unreachable: bot_blocked_by_user');
      }

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessageWithRetry(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessageWithRetry(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      if (isTelegramBotBlockedError(err)) {
        markTelegramOutboundBlocked(jid, err);
      }
      logger.error(
        { jid, err: sanitizeTelegramError(err) },
        'Failed to send Telegram message',
      );
      throw err;
    }
  }

  async sendPhoto(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`Photo file not found: ${path.basename(filePath)}`);
    }
    const numericId = this.telegramChatIdForJid(jid);
    // Telegram caption limit is 1024 chars — truncate if needed
    const safeCaption =
      caption && caption.length > 1024
        ? caption.slice(0, 1021) + '...'
        : caption;
    // CORRECTNESS (finding #43): capture the size BEFORE sending. A post-send
    // fs.statSync would throw if the source file is moved/deleted between the
    // send completing and the stat, turning a genuinely successful send into a
    // reported failure (the caller catches the throw → "Failed to send photo"),
    // which can trigger a duplicate resend. The size is only for logging.
    const photoBytes = statSizeSafe(filePath);
    await this.bot.api.sendPhoto(numericId, new InputFile(filePath), {
      caption: safeCaption,
    });
    logger.info(
      {
        jid,
        fileBasename: path.basename(filePath),
        bytes: photoBytes,
      },
      'Telegram photo sent',
    );
  }

  async sendDocument(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`Document file not found: ${path.basename(filePath)}`);
    }
    const numericId = this.telegramChatIdForJid(jid);
    const safeCaption =
      caption && caption.length > 1024
        ? caption.slice(0, 1021) + '...'
        : caption;
    // CORRECTNESS (finding #43): capture size before sending so a file that
    // disappears after delivery cannot turn a successful send into a failure.
    const documentBytes = statSizeSafe(filePath);
    await this.bot.api.sendDocument(numericId, new InputFile(filePath), {
      caption: safeCaption,
    });
    logger.info(
      {
        jid,
        fileBasename: path.basename(filePath),
        bytes: documentBytes,
      },
      'Telegram document sent',
    );
  }

  async sendVoice(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;
    const numericId = this.telegramChatIdForJid(jid);
    const result = await synthesizeVoice(trimmed);
    try {
      for (const file of result.files) {
        await this.bot.api.sendVoice(numericId, new InputFile(file));
      }
      logger.info(
        { jid, length: trimmed.length, chunks: result.files.length },
        'Telegram voice sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram voice');
      throw err;
    } finally {
      result.cleanup();
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    if (!jid.startsWith('tg:')) return false;
    const jidBotId = telegramJidToBotId(jid);
    const channelBotId = safeTelegramBotId(this.opts.botId);
    if (isDefaultTelegramBotId(channelBotId)) {
      return !jidBotId || jidBotId === channelBotId;
    }
    return jidBotId === channelBotId;
  }

  async disconnect(): Promise<void> {
    // Clear any in-flight typing refresh loops before stopping the bot, or
    // they'll keep firing API calls into a torn-down client.
    for (const timer of this.typingIntervals.values()) clearInterval(timer);
    this.typingIntervals.clear();
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot) return;
    const numericId = this.telegramChatIdForJid(jid);

    // Clear any existing refresh loop for this chat before doing anything
    // else — handles both the "stop typing" case and the "restart typing"
    // case (e.g. orchestrator calls setTyping(true) twice in a row).
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }

    if (!isTyping) return;

    // Fire one immediately so the indicator appears without waiting for the
    // first interval tick.
    this.bot.api.sendChatAction(numericId, 'typing').catch((err) => {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    });

    // Refresh every TYPING_REFRESH_INTERVAL_MS while the agent is working.
    // Cleared by setTyping(false), disconnect(), or the safety cap below.
    const startedAt = Date.now();
    const timer = setInterval(() => {
      // Bot might have been torn down between scheduling and firing.
      if (!this.bot) {
        clearInterval(timer);
        this.typingIntervals.delete(jid);
        return;
      }
      // Safety cap: kill the loop if it's been running absurdly long.
      // If we hit this, something upstream forgot to call setTyping(false);
      // log a warning so the leak path is visible.
      if (Date.now() - startedAt >= TYPING_MAX_DURATION_MS) {
        clearInterval(timer);
        this.typingIntervals.delete(jid);
        logger.warn(
          { jid, durationMs: Date.now() - startedAt },
          'Telegram typing indicator hit max duration — auto-clearing (likely missing setTyping(false) upstream)',
        );
        return;
      }
      this.bot.api.sendChatAction(numericId, 'typing').catch((err) => {
        logger.debug({ jid, err }, 'Failed to refresh Telegram typing');
      });
    }, TYPING_REFRESH_INTERVAL_MS);
    this.typingIntervals.set(jid, timer);
  }
}

export class TelegramMultiBotChannel implements Channel {
  name = 'telegram';

  constructor(private readonly channels: TelegramChannel[]) {}

  private channelForJid(jid: string): TelegramChannel | undefined {
    return this.channels.find((channel) => channel.ownsJid(jid));
  }

  async connect(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.connect()));
  }

  isConnected(): boolean {
    return this.channels.some((channel) => channel.isConnected());
  }

  ownsJid(jid: string): boolean {
    return this.channels.some((channel) => channel.ownsJid(jid));
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.disconnect()));
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channel = this.channelForJid(jid);
    if (!channel) throw new Error(`No Telegram bot owns JID: ${jid}`);
    await channel.sendMessage(jid, text);
  }

  async sendPhoto(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    const channel = this.channelForJid(jid);
    if (!channel) throw new Error(`No Telegram bot owns JID: ${jid}`);
    await channel.sendPhoto(jid, filePath, caption);
  }

  async sendDocument(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    const channel = this.channelForJid(jid);
    if (!channel) throw new Error(`No Telegram bot owns JID: ${jid}`);
    await channel.sendDocument(jid, filePath, caption);
  }

  async sendVoice(jid: string, text: string): Promise<void> {
    const channel = this.channelForJid(jid);
    if (!channel) throw new Error(`No Telegram bot owns JID: ${jid}`);
    await channel.sendVoice(jid, text);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const channel = this.channelForJid(jid);
    if (!channel) return;
    await channel.setTyping(jid, isTyping);
  }
}

export function telegramRuntimeConfigsFromEnv(): TelegramBotRuntimeConfig[] {
  const baseEnv = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'SKOOBI_TELEGRAM_BOT_ID',
    'SKOOBI_TELEGRAM_BOTS_JSON',
  ]);
  const tokenLookup = (envName: string): string | undefined =>
    process.env[envName] || baseEnv[envName] || readEnvFile([envName])[envName];

  return parseTelegramBotRuntimeConfigs({
    json:
      process.env.SKOOBI_TELEGRAM_BOTS_JSON ||
      baseEnv.SKOOBI_TELEGRAM_BOTS_JSON,
    defaultToken: tokenLookup('TELEGRAM_BOT_TOKEN'),
    defaultBotId: tokenLookup('SKOOBI_TELEGRAM_BOT_ID'),
    tokenLookup,
  });
}
