import fs from 'fs';
import os from 'os';
import https from 'https';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { Api, Bot, InputFile, type Transformer } from 'grammy';
import type { Message, ReactionTypeEmoji } from 'grammy/types';
import { ProgressMessages } from './progress-message.js';
import {
  DEFAULT_TELEGRAM_POLL_STALL_SEC,
  pollHealthTransformer,
  TelegramPollHealth,
} from './poll-health.js';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_RUNTIME,
  GROUPS_DIR,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './channel-config.js';
import { readEnvFile } from '@skoobi/shared/env';
import {
  instanceProfile,
  instanceProfileStatus,
  type InstanceProfileStatus,
} from '@skoobi/shared/instance-profile';
import {
  collectLaunchdServices,
  listedMainServiceLabel,
  type LaunchdProbeDeps,
  type LaunchdServicesReport,
} from '@skoobi/shared/launchd-services';
import { logger } from '@skoobi/shared/logger';
import { hashShort } from '@skoobi/shared/log-sanitize';
import {
  followsSecretRequest,
  maskChatSecrets,
  SECRET_REQUEST_WINDOW_MS,
  type ChatSecretContext,
} from '@skoobi/shared/chat-secrets';
import {
  MediaIntakePersistenceError,
  type MediaIntakeAdapter,
  type MediaIntakeKind,
} from '@skoobi/shared/media-intake';
import { MediaIntakeWorker, MediaIntakeWorkError } from './media-intake-worker.js';
import { publishMaterializedMedia } from './media-intake-manifest.js';
import {
  startOperationTraceStage,
  type OperationTraceObserver,
} from '@skoobi/shared/operation-trace';
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
import {
  parseTaskControlCallbackData,
  TASK_CONTROL_CALLBACK_RE,
  type Channel,
  type NewMessage,
  type OnChatMetadata,
  type OnInboundMessage,
  type OnTaskControl,
  type OnTelegramCallbackQuery,
  type OnTelegramMessageEdit,
  type OutboundButton,
  type SendMessageOptions,
} from '@skoobi/shared/channel-types';
import { transcribeAudioFile, transcribeAudioFileDetailed } from '@skoobi/voice-stt';
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
import { synthesizeVoice, synthesizeReusableVoice, ttsProvider, ttsVoiceName } from '@skoobi/voice-tts';
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
      | 'memory_delete_requested'
      | 'memory_deleted'
      | 'memory_delete_unavailable';
    actor: string;
    senderId: string;
    payload: Record<string, unknown>;
  }): void;
  privateAdminModeEnabled(): boolean;
  isPrivateAdminTelegramUser(input: {
    telegramUserId?: string | number | null;
    ownerAllowlist?: OwnerAllowlistConfig;
  }): boolean;
  privateAdminClosedBotText(): string;
  /**
   * The bot's latest stored reply in a chat before `beforeTimestamp` (W19):
   * a short code right after «пришли пароль» is a password. Optional — without
   * it only the context-free rules mask the inbox copy.
   */
  lastBotReply?(
    chatJid: string,
    beforeTimestamp?: string,
  ): { content: string; timestamp: string } | undefined;
  /**
   * The bot's stored replies in a chat before `beforeTimestamp`, not older
   * than `sinceTimestamp`, newest first (W19 review): a request within the
   * hour counts even after a later «Хорошо, жду». Preferred over
   * lastBotReply when both are given.
   */
  recentBotReplies?(
    chatJid: string,
    beforeTimestamp?: string,
    sinceTimestamp?: string,
  ): Array<{ content: string; timestamp: string }>;
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

/**
 * W41: how long getUpdates may keep failing before the heartbeat reports
 * Telegram as down. Read from the environment / .env on every check, so it
 * changes without a rebuild; 0 turns the verdict off (log lines stay).
 */
function telegramPollStallSec(): number {
  const raw =
    process.env.SKOOBI_TELEGRAM_POLL_STALL_SEC ??
    readEnvFile(['SKOOBI_TELEGRAM_POLL_STALL_SEC'])
      .SKOOBI_TELEGRAM_POLL_STALL_SEC;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_TELEGRAM_POLL_STALL_SEC;
  }
  const sec = Number(raw);
  return Number.isFinite(sec) && sec >= 0 ? sec : DEFAULT_TELEGRAM_POLL_STALL_SEC;
}

/**
 * The launchd jobs /status reports. The main row is asked under the same
 * label as in the local panel (listedMainServiceLabel()), so the two cannot
 * disagree: the label the instance profile gives its main unit, or, without
 * one, SKOOBI_SERVICE_LABEL. A label the installer could not have written is
 * not asked about: the profile label is, as it was before the setting
 * existed.
 */
export async function collectStatusServices(
  deps: LaunchdProbeDeps = {},
): Promise<LaunchdServicesReport> {
  let mainLabel = deps.mainLabel;
  if (mainLabel === undefined) {
    try {
      mainLabel = listedMainServiceLabel();
    } catch (err) {
      logger.warn({ err }, '/status: invalid main service label');
    }
  }
  return collectLaunchdServices({ ...deps, mainLabel });
}

/**
 * The /status problem line about the instance profile, or null when the file
 * was read cleanly or there is none. A profile that is ignored or only partly
 * used leaves the service running on neutral defaults (no alert chat, another
 * job list), which nothing else shows. Key names only, never values.
 */
export function instanceProfileProblemRu(
  status: InstanceProfileStatus,
): string | null {
  if (status.unusable !== null) {
    return 'файл config/instance.json не читается, работаю на значениях по умолчанию';
  }
  const listed = (keys: readonly string[]) =>
    keys.slice(0, 5).join(', ') +
    (keys.length > 5 ? ` и ещё ${keys.length - 5}` : '');
  const parts: string[] = [];
  if (status.invalidKeys.length > 0) {
    parts.push(
      `неверные значения (взяты по умолчанию): ${listed(status.invalidKeys)}`,
    );
  }
  if (status.unknownKeys.length > 0) {
    parts.push(`неизвестные ключи: ${listed(status.unknownKeys)}`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

/** M-C48: «2 дн 3 ч», «3 ч 12 мин», «5 мин», «меньше минуты». */
export function formatUptimeRu(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const days = Math.floor(sec / 86_400);
  const hours = Math.floor((sec % 86_400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days} дн ${hours} ч` : `${days} дн`;
  if (hours > 0) return minutes > 0 ? `${hours} ч ${minutes} мин` : `${hours} ч`;
  if (minutes > 0) return `${minutes} мин`;
  return 'меньше минуты';
}

/**
 * J12: whether a failed Bot API call is worth repeating later — no network
 * (no error code), a Telegram 5xx or a 429. A 4xx such as «400 chat not
 * found» or «403 blocked» will not fix itself, so it is not retried.
 */
function isTransientTelegramError(err: unknown): boolean {
  const code = telegramErrorCode(err);
  return code === undefined || code === 429 || code >= 500;
}

/** J12: result of one command-menu publish round. */
type CommandMenuOutcome = 'published' | 'transient' | 'permanent';

/** J12: command-menu publish retry backoff (doubles up to the cap). */
const COMMAND_MENU_RETRY_BASE_MS = 30_000;
const COMMAND_MENU_RETRY_MAX_MS = 30 * 60_000;

const PUBLIC_BOT_COMMANDS = [
  { command: 'start', description: 'показать инструкцию' },
  { command: 'chatid', description: 'показать ID этого чата' },
];

const COMMAND_ADMIN_BOT_COMMANDS = [
  { command: 'engine', description: 'движок чата: модели и подписки' },
  { command: 'stats', description: 'кто был онлайн сегодня' },
];

const OWNER_BOT_COMMANDS = [
  ...PUBLIC_BOT_COMMANDS,
  ...COMMAND_ADMIN_BOT_COMMANDS,
  // Not a bot.command: «/tasks» goes to the chat like text, and the host
  // answers it without the model (message-loop task_list fast command).
  { command: 'tasks', description: 'что крутится в фоне' },
  { command: 'pending', description: 'заявки на доступ' },
  { command: 'users', description: 'список Telegram-пользователей' },
  { command: 'lastseen', description: 'последняя активность пользователей' },
  { command: 'health', description: 'состояние сервиса и очередей' },
  { command: 'status', description: 'всё ли в порядке у бота' },
  { command: 'selftest', description: 'запустить self-test' },
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

const SELFTEST_COMMAND = 'selftest';
/** /selftest runs this script of the working directory (see its handler). */
const SELFTEST_SCRIPT = 'scripts/selftest.sh';

/**
 * Where the self-test script is looked for: the working directory (the copy
 * the handler runs) and the code tree this module belongs to.
 */
export function selftestScriptCandidates(
  cwd: string = process.cwd(),
  moduleUrl: string | URL = import.meta.url,
): string[] {
  return [
    path.resolve(cwd, SELFTEST_SCRIPT),
    path.resolve(
      path.dirname(fileURLToPath(moduleUrl)),
      '../../..',
      SELFTEST_SCRIPT,
    ),
  ];
}

/**
 * The self-test script belongs to a full installation and is not part of
 * every distribution. Where it is missing /selftest is neither registered nor
 * listed in the owner menu, and a typed «/selftest» is ordinary text.
 */
export function selftestScriptInstalled(
  candidates: readonly string[] = selftestScriptCandidates(),
): boolean {
  return candidates.some((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/** The owner menu; /selftest is listed only where its script is installed. */
function ownerBotCommands(selftest: boolean): typeof OWNER_BOT_COMMANDS {
  return selftest
    ? OWNER_BOT_COMMANDS
    : OWNER_BOT_COMMANDS.filter((entry) => entry.command !== SELFTEST_COMMAND);
}

const COMMAND_ADMIN_IDS_ENV_KEY = 'SKOOBI_TELEGRAM_COMMAND_ADMIN_IDS';

/**
 * Chats that get operational alerts when SKOOBI_TELEGRAM_ADMIN_ALERT_JIDS is
 * not set: the ones of this installation (instance profile), none by default.
 */
function defaultAdminAlertJids(): string[] {
  return instanceProfile().telegram.adminAlertJids.map((item) =>
    item.startsWith('tg:') ? item : `tg:${item}`,
  );
}

function adminAlertJids(): Set<string> {
  const env = readEnvFile(['SKOOBI_TELEGRAM_ADMIN_ALERT_JIDS']);
  const defaultJids = defaultAdminAlertJids();
  const raw =
    process.env.SKOOBI_TELEGRAM_ADMIN_ALERT_JIDS ||
    env.SKOOBI_TELEGRAM_ADMIN_ALERT_JIDS ||
    defaultJids.join(',');
  const jids = raw
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith('tg:') ? item : `tg:${item}`));
  return new Set(jids.length > 0 ? jids : defaultJids);
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
  onTelegramMessageEdit?: OnTelegramMessageEdit;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, TelegramRegisteredGroup>;
  registerGroup?: (jid: string, group: TelegramRegisteredGroup) => void;
  tenantRegistry?: () => TelegramTenantRegistryView;
  ownerAllowlist?: () => OwnerAllowlistConfig;
  onTelegramCallbackQuery?: OnTelegramCallbackQuery;
  /** «Остановить» buttons under /tasks and task notices (W25). */
  onTaskControl?: OnTaskControl;
  /** Host-scoped observations only; never an authorization decision. */
  operationTrace?: (
    chatJid: string,
    messageId: string,
  ) => OperationTraceObserver | undefined;
  mediaIntake?: (botId?: string) => MediaIntakeAdapter | undefined;
  /** M-C48: launchd health for /status; tests inject a fake. */
  serviceHealth?: () => Promise<LaunchdServicesReport>;
  /**
   * How the instance profile was loaded, for /status (default:
   * instanceProfileStatus); tests inject a fake.
   */
  instanceProfileStatus?: () => InstanceProfileStatus;
  /**
   * Whether the self-test script is installed (default:
   * selftestScriptInstalled); tests inject a fake.
   */
  selftestInstalled?: () => boolean;
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
const ADMIN_CONTACT_HANDLE = /^@[A-Za-z0-9_]{5,32}$/u;

/**
 * How users are told to reach the administrator: SKOOBI_ADMIN_CONTACT when it
 * is a Telegram @username, otherwise the contact of this installation
 * (instance profile; a neutral phrase by default).
 */
function adminContact(): string {
  return ADMIN_CONTACT_HANDLE.test(configuredAdminContact)
    ? configuredAdminContact
    : instanceProfile().telegram.adminContact;
}

function adminLabel(): string {
  return `администратор ${adminContact()}`;
}

function renderAdminContact(text: string): string {
  const contact = adminContact();
  return text.replaceAll('<ADMIN_CONTACT>', () => contact);
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
/**
 * Telegram Markdown v1 silently EATS intra-word `_`
 * and `*`. `some_file_name.py` parses fine — Telegram just renders "file name"
 * in italics and drops both underscores — so the existing parse-error fallback
 * below never fires and the reader cannot tell anything was removed. It is
 * exactly file paths, column names and identifiers that get corrupted.
 *
 * Escape those markers, and ONLY those: a marker is rewritten only when it sits
 * between two word characters (i.e. inside a token), never when it delimits
 * prose. Deliberately additive — intentional *bold*, _italic_, `code` and
 * ```fences``` are untouched, and text inside code spans/fences is skipped
 * entirely because it is already rendered literally.
 */
/** Commands registered on the bot — see the `this.bot.command(...)` calls. */
const HANDLED_BOT_COMMANDS = new Set([
  'ban', 'chatid', 'cleanup', 'engine', 'health', 'help', 'keep', 'language',
  'lastseen', 'limits', 'pause', 'pending', 'ping', 'resume', 'selftest',
  'start', 'stats', 'status', 'storage', 'users',
]);

// Chat/desktop controls handled in the host rather than grammY command middleware.
const HOST_EDIT_COMMANDS = new Set([
  'tasks', 'unstick', 'stop', 'codex-gui', 'codex_gui', 'remote-control', 'remote-control-end',
]);

/** /selftest counts as registered only where its script is installed. */
function isRegisteredCommandName(name: string, selftest: boolean): boolean {
  return (
    HANDLED_BOT_COMMANDS.has(name) && (selftest || name !== SELFTEST_COMMAND)
  );
}

/**
 * True only for a real, registered slash command (bot_command entity at offset
 * 0).
 */
export function isHandledBotCommand(
  message: {
    text?: string;
    entities?: readonly { type: string; offset: number; length: number }[];
  },
  selftest: boolean = selftestScriptInstalled(),
): boolean {
  const text = message.text;
  if (!text) return false;
  const first = message.entities?.[0];
  if (!first || first.type !== 'bot_command' || first.offset !== 0) return false;
  // `/status@SkoobiBot` → `status`
  const name = text
    .slice(1, first.length)
    .split('@')[0]
    .toLowerCase();
  return isRegisteredCommandName(name, selftest);
}

/**
 * Rewrite CommonMark emphasis into the dialect Telegram's legacy `Markdown`
 * parse mode actually understands: `*bold*`, `_italic_` — one delimiter, not two.
 *
 * The model writes `**жирный**`, which legacy Markdown cannot render, so the
 * asterisks would otherwise reach the chat as literal characters.
 *
 * Code fences and inline code are split out first and left byte-for-byte —
 * asterisks inside a snippet are content, not formatting. Empty emphasis
 * (`****`) is left alone rather than collapsed: it is not markup either way,
 * and rewriting it risks producing an empty entity, which Telegram rejects
 * outright.
 */
export function normalizeMarkdownForTelegram(text: string): string {
  const parts = normalizeTelegramBlocks(text).split(
    /(```[\s\S]*?```|`[^`\n]*`)/g,
  );
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            // ***bold italic*** → *_bold italic_*
            .replace(/\*\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*\*/g, '*_$1_*')
            .replace(/\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*/g, '*$1*')
            .replace(/__([^\s_](?:[\s\S]*?[^\s_])?)__/g, '_$1_'),
    )
    .join('');
}

/**
 * Rewrite the block-level CommonMark that legacy `Markdown` cannot render into
 * something that reads well in a chat bubble. Tables, `###` headings and `>`
 * quotes otherwise appear as raw pipes, hashes and angle brackets.
 *
 * - a GFM table (header row + `|---|` separator) becomes one `• first — rest`
 *   line per data row; with more than two columns the header names label the
 *   values (`Цена: 5 000 ₸ · Срок: 2 дня`);
 * - a heading becomes a bold line (`**…**`, normalised to `*…*` downstream);
 * - a quote marker (`>` or an HTML-escaped `&gt;`) becomes `» `.
 *
 * Code fences are left byte-for-byte. Idempotent: its own output contains no
 * tables, headings or quote markers.
 */
export function normalizeTelegramBlocks(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : normalizeTelegramProseBlocks(part)))
    .join('');
}

const TELEGRAM_TABLE_SEPARATOR_ROW =
  /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isTelegramTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.indexOf('|', 1) > 0;
}

function splitTelegramTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body.split('|').map((cell) => cell.trim());
}

function telegramTableToLines(rows: string[]): string[] {
  const header = splitTelegramTableRow(rows[0]);
  const out: string[] = [];
  for (const row of rows.slice(2)) {
    if (TELEGRAM_TABLE_SEPARATOR_ROW.test(row)) continue;
    const cells = splitTelegramTableRow(row);
    if (cells.every((cell) => !cell)) continue;
    const [first, ...rest] = cells;
    const labelled = rest
      .map((value, idx) => {
        if (!value) return '';
        const label = header[idx + 1];
        return rest.length > 1 && label ? `${label}: ${value}` : value;
      })
      .filter(Boolean);
    const tail = labelled.join(' · ');
    if (first && tail) out.push(`• ${first} — ${tail}`);
    else out.push(`• ${first || tail}`);
  }
  return out;
}

function normalizeTelegramProseBlocks(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      isTelegramTableRow(line) &&
      i + 1 < lines.length &&
      TELEGRAM_TABLE_SEPARATOR_ROW.test(lines[i + 1]) &&
      lines[i + 1].includes('|')
    ) {
      let end = i + 2;
      while (end < lines.length && isTelegramTableRow(lines[end])) end++;
      out.push(...telegramTableToLines(lines.slice(i, end)));
      i = end - 1;
      continue;
    }
    const heading = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (heading) {
      const title = heading[1].replace(/\*+/g, '').trim();
      out.push(title ? `**${title}**` : line);
      continue;
    }
    const quote = /^ {0,3}(?:(?:>|&gt;)[ \t]?)+(.*)$/.exec(line);
    // «> 100 000 ₸» / «>5 мин» mean "more than", not a quote.
    if (quote && !/^[\d.,+\-−–]/.test(quote[1])) {
      out.push(quote[1].trim() ? `» ${quote[1]}` : '');
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * What to send when Telegram rejects the Markdown: the same text with the
 * CommonMark emphasis markers dropped, so the fallback does not show `**` and
 * raw tables either.
 */
export function plainTelegramText(text: string): string {
  const parts = normalizeTelegramBlocks(text).split(
    /(```[\s\S]*?```|`[^`\n]*`)/g,
  );
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\*\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*\*/g, '$1')
            .replace(/\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*/g, '$1')
            .replace(/__([^\s_](?:[\s\S]*?[^\s_])?)__/g, '$1'),
    )
    .join('');
}

/**
 * Split a long answer into Telegram-sized messages at a paragraph, then line,
 * then word boundary. A blind 4096-character slice cut words and formatting
 * entities in half, and a cut entity sent the whole part down the plain-text
 * fallback.
 */
export function splitTelegramText(text: string, maxLength = 3900): string[] {
  // One message whenever it fits once formatted; only a real overflow is cut,
  // and then with a margin for the escapes added per part.
  if (
    escapeIntraWordMarkdown(normalizeMarkdownForTelegram(text)).length <= 4096
  ) {
    return text.trim() ? [text] : [];
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength);
    let cut = window.lastIndexOf('\n\n');
    if (cut < maxLength / 2) cut = window.lastIndexOf('\n');
    if (cut < maxLength / 2) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = maxLength;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.trim()) chunks.push(rest);
  return chunks.filter((chunk) => chunk.trim());
}

/** The Bot API's getFile refuses anything larger ("file is too big"). */
export const TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * Explain when a file exceeds the Bot API download limit instead of reporting
 * a generic processing failure. The size check needs no network call.
 */
export function telegramOversizePlaceholder(
  label: string,
  fileSize: number | undefined,
): string | null {
  if (!fileSize || fileSize <= TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES) return null;
  const mb = Math.round(fileSize / (1024 * 1024));
  return (
    `[${label} — ${mb} MB, not downloaded: the Telegram Bot API refuses files ` +
    'over 20 MB, so its content is unknown — do not guess it. Ask for a cloud ' +
    'link (Yandex Disk, Google Drive, iCloud) or a part under 20 MB]'
  );
}

/**
 * A `[text](url)` link exactly as legacy Markdown reads it: the text up to the
 * first `]`, the URL up to the first `)`.
 */
const TELEGRAM_MARKDOWN_LINK = /(\[[^\]\n]*\]\([^\s)]*\))/g;

/**
 * A `[text](url)` link whose URL holds balanced parentheses
 * (`…/wiki/Foo_(bar)`) — read the way the runner's link check reads it.
 */
const MARKDOWN_LINK_WITH_PARENS =
  /\[([^\]\n]*)\]\(([^\s()]*(?:\([^\s()]*\)[^\s()]*)+)\)/g;

/**
 * Legacy Markdown ends a link's URL at the first `)` and has no escape for
 * it: `[Меркурий](https://ru.wikipedia.org/wiki/Меркурий_(планета))` went out
 * as a link to `…Меркурий_(планета` plus a stray `)`, while the link check had
 * opened the full address and called it fine. Inside the URL the parentheses
 * become %28/%29 — the same address for the site — so the whole URL arrives.
 */
export function encodeMarkdownLinkParens(text: string): string {
  return text.replace(
    MARKDOWN_LINK_WITH_PARENS,
    (_m, label: string, url: string) =>
      `[${label}](${url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`,
  );
}

/**
 * Escape `_`/`*` inside words (`some_file_name`) so Telegram does not take
 * them for italics/bold. Code and `[text](url)` links are left verbatim, but
 * for parentheses inside a link's URL (encodeMarkdownLinkParens).
 *
 * Legacy Markdown copies a link's text and URL raw — a backslash there is not
 * an escape but a character. A backslash in an escaped URL can be interpreted
 * as a path separator by a browser. A bare URL keeps the escape: outside an
 * entity Telegram removes the backslash, while a raw `_` could open italics.
 */
export function escapeIntraWordMarkdown(text: string): string {
  // Split on code fences and inline code so their contents are left verbatim.
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? part
        : encodeMarkdownLinkParens(part)
            .split(TELEGRAM_MARKDOWN_LINK)
            .map((piece, j) =>
              j % 2 === 1
                ? piece
                : piece.replace(
                    /(?<=\w)([_*])(?=\w)/g,
                    (_m, ch: string) => `\\${ch}`,
                  ),
            )
            .join(''),
    )
    .join('');
}

type TelegramInlineKeyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

/** Host buttons as a Telegram inline keyboard; undefined when there are none. */
export function telegramInlineKeyboard(
  buttons: OutboundButton[][] | undefined,
): TelegramInlineKeyboard | undefined {
  const rows = (buttons || [])
    .map((row) =>
      row
        .filter(
          (button) =>
            button.text.trim() &&
            Buffer.byteLength(button.callbackData, 'utf8') <= 64,
        )
        .map((button) => ({
          text: button.text,
          callback_data: button.callbackData,
        })),
    )
    .filter((row) => row.length > 0);
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

type TelegramSendOptions = {
  message_thread_id?: number;
  reply_markup?: TelegramInlineKeyboard;
};

async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: TelegramSendOptions = {},
  canSend?: () => boolean,
): Promise<void> {
  if (canSend && !canSend()) throw new Error('saved_final_superseded');
  // Nothing to say. Telegram rejects a blank message with a 400, which used to
  // surface as an outbound delivery failure and hold the cursor back so the
  // whole turn was retried.
  if (!text.trim()) {
    logger.debug({ chatId }, 'Skipping empty Telegram message');
    return;
  }
  const formatted = escapeIntraWordMarkdown(normalizeMarkdownForTelegram(text));
  if (!formatted.trim()) {
    // Formatting emptied it (a bare «>»): send it exactly as written.
    await api.sendMessage(chatId, text, options);
    return;
  }
  try {
    await api.sendMessage(chatId, formatted, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // A one-character answer that is nothing but markdown punctuation ("*",
    // "_", "`") survives the trim above but renders to nothing once Telegram
    // parses the entities, and the resulting "text must be non-empty" is NOT a
    // parse error — so it used to bypass this fallback and fail the delivery.
    // Observed on real turns: an agent output of exactly one character.
    if (!isTelegramMarkdownParseError(err) && !isTelegramEmptyTextError(err)) {
      throw err;
    }
    logger.debug(
      { err: sanitizeTelegramError(err) },
      'Markdown send failed, falling back to plain text',
    );
    const plain = plainTelegramText(text);
    if (canSend && !canSend()) throw new Error('saved_final_superseded');
    await api.sendMessage(chatId, plain.trim() ? plain : text, options);
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

/** Telegram's 400 for a message whose text is empty after entity parsing. */
function isTelegramEmptyTextError(err: unknown): boolean {
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
  return /text must be non-empty/i.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A send that failed on the way (Wi-Fi drop, DNS, Telegram 5xx) rather than
 * on Telegram's verdict. Before, only 429 was retried: any other failure
 * failed the delivery, and the host then re-ran the WHOLE model turn to
 * produce the answer again.
 */
export function isTelegramTransientSendError(err: unknown): boolean {
  const anyErr = err as {
    name?: unknown;
    message?: unknown;
    error_code?: unknown;
    error?: { message?: unknown; code?: unknown };
  };
  const code = Number(anyErr?.error_code);
  if (Number.isFinite(code) && code >= 500 && code < 600) return true;
  if (anyErr?.name === 'HttpError') return true;
  const text = [anyErr?.message, anyErr?.error?.message, anyErr?.error?.code]
    .filter(Boolean)
    .join(' ');
  return /Network request for '[^']+' failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|Bad Gateway|Gateway Timeout|Internal Server Error/i.test(
    text,
  );
}

/** Waits before re-sending after a transient failure (see above). */
export const TELEGRAM_TRANSIENT_SEND_RETRY_DELAYS_MS: readonly number[] = [
  1500, 4000, 8000,
];

async function sendTelegramMessageWithRetry(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: TelegramSendOptions = {},
  canSend?: () => boolean,
  transientDelaysMs: readonly number[] = TELEGRAM_TRANSIENT_SEND_RETRY_DELAYS_MS,
): Promise<void> {
  let transientAttempt = 0;
  let rateLimitRetried = false;
  for (;;) {
    try {
      await sendTelegramMessage(api, chatId, text, options, canSend);
      return;
    } catch (err) {
      const retryAfter = telegramRetryAfterSeconds(err);
      if (retryAfter !== null && !rateLimitRetried) {
        rateLimitRetried = true;
        logger.warn(
          { retryAfter, err: sanitizeTelegramError(err) },
          'Telegram rate limited message send, retrying once',
        );
        await sleep(retryAfter * 1000);
        continue;
      }
      if (
        retryAfter === null &&
        !canSend && // A saved reply with a lost ACK waits for an explicit resend.
        isTelegramTransientSendError(err) &&
        transientAttempt < transientDelaysMs.length
      ) {
        const delay = transientDelaysMs[transientAttempt];
        transientAttempt += 1;
        logger.warn(
          { attempt: transientAttempt, delay, err: sanitizeTelegramError(err) },
          'Telegram send failed on the network, retrying',
        );
        await sleep(delay);
        continue;
      }
      throw err;
    }
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

function readTelegramAccessState(strict = false): TelegramAccessState {
  try {
    const state = JSON.parse(fs.readFileSync(TELEGRAM_ACCESS_CONTROL_FILE, 'utf-8'));
    if (strict && (!state || typeof state !== 'object' || Array.isArray(state))) {
      throw new Error('Invalid Telegram access state');
    }
    return state as TelegramAccessState;
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
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

/**
 * A forward whose original author is this very bot, or the forwarding user
 * themselves, carries no third party's words. The watchdog sends its alerts
 * through the bot's own token, so "forward the alert and say fix it" lands
 * here. Telegram sets forward_origin server-side; a user cannot forge it.
 *
 * Bot-authored forwards should remain usable as context for owner requests.
 */
function isSelfAuthoredForward(ctx: any, origin: any): boolean {
  if (origin?.type !== 'user') return false;
  const senderId = origin.sender_user?.id;
  if (senderId === undefined || senderId === null) return false;
  const botId = ctx.me?.id;
  if (
    botId !== undefined &&
    botId !== null &&
    origin.sender_user?.is_bot === true &&
    String(senderId) === String(botId)
  ) {
    return true;
  }
  const fromId = ctx.from?.id;
  return fromId !== undefined && fromId !== null && String(senderId) === String(fromId);
}

function telegramMessageOriginForContext(
  ctx: any,
  message = ctx.message,
): 'direct' | 'forwarded' | 'quoted' {
  if (
    message?.is_automatic_forward === true ||
    message?.via_bot != null ||
    message?.sender_business_bot != null ||
    message?.is_from_offline === true
  ) {
    return 'forwarded';
  }
  if (
    message?.forward_origin != null &&
    !isSelfAuthoredForward(ctx, message.forward_origin)
  ) {
    return 'forwarded';
  }
  // A quote marks someone else's words. `code`/`pre` do not: they are the
  // author's own formatting of a PID or a log line, and counting them made the
  // owner's own message unauthorised whenever it contained one.
  const nonAuthoritativeEntityTypes = new Set([
    'blockquote',
    'expandable_blockquote',
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

// Bot API IDs are numeric. A profile name alone is not the receiving bot's identity.
function isPositiveTelegramId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

function privateTelegramTextOrigin(
  ctx: any, message: Message.TextMessage,
): 'direct' | 'quoted' | undefined {
  if (!(
    message.chat?.type === 'private' &&
    message.from?.is_bot === false &&
    isPositiveTelegramId(message.from.id) &&
    message.from.id === message.chat.id &&
    ctx.me?.is_bot === true &&
    isPositiveTelegramId(ctx.me.id) &&
    isPositiveTelegramId(message.message_id) &&
    Number.isSafeInteger(message.date) && message.date >= 0 &&
    Number.isFinite(new Date(message.date * 1000).getTime()) &&
    message.forward_origin == null &&
    message.sender_chat == null &&
    message.quote == null &&
    message.external_reply == null &&
    message.business_connection_id == null
  )) return undefined;
  const origin = telegramMessageOriginForContext(ctx, message);
  return origin === 'forwarded' ? undefined : origin;
}

function telegramTextContent(message: Message.TextMessage, username?: string): string {
  const text = message.text;
  const mentioned = username && message.entities?.some(entity =>
    entity.type === 'mention' &&
    text.substring(entity.offset, entity.offset + entity.length).toLowerCase() === `@${username.toLowerCase()}`
  );
  return mentioned && !TRIGGER_PATTERN.test(text) ? `@${ASSISTANT_NAME} ${text}` : text;
}

class TelegramTextPersistenceError extends Error {
  constructor(kind: 'original' | 'edit') {
    super(`Unable to persist Telegram text ${kind}`);
  }
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
    systemPrompt: `You are Skoobi (Скуби), a warm and practical personal Telegram assistant administered by ${adminContact()}. You are talking with Telegram chat ${jid}. Display name: ${name} (unverified). Access granted by ${adminLabel()}.

Style: ${languageInstruction(language)} Be friendly, practical, concise, and useful. Help with text, voice notes, photos, calculations, web lookup, planning, and message drafting.

Memory: when continuity could help, use memory_get with file="memory/topics/${topic}-context.md". After durable facts, use memory_save with category="topic" topic="${topic}-context" or a more specific safe topic.

Relationship memory: build warm continuity with this user. Save stable preferences, goals, communication style, and important personal context to this chat's own memory only. Use it later naturally, without pretending to know facts that were not shared.

Identity safety: Telegram display names are not identity proof. If this name matches the administrator or another user, do not assume it is the same person. Use only this chat's own memory topic and current conversation.

${GUEST_BOUNDARY_MARKER}. Do not read the administrator's private files (.env, keys, store/messages.db, groups/${instanceProfile().telegram.guestPromptOwnerFolder}, sessions, browser cookies) or other users' groups. No sudo, no destructive/system-changing commands. Do not use full-access/no-sandbox behaviour.

If the user asks to pass something to ${adminLabel()}, save it via memory_save category="topic" topic="${topic}-to-admin"; do not send it to the administrator's chat automatically without explicit administrator approval.

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
  return `- [${today}] Этот чат — личный диалог Скуби с Telegram chat_id ${jid}. Отображаемое имя: ${name} (не является подтверждением личности). Доступ выдан: ${adminLabel()}.
- [${today}] ЯЗЫК: ${languageInstruction(language)}
- [${today}] РОЛЬ: тёплый, спокойный и полезный личный помощник. Помогай с текстом, голосовыми, фото, расчётами, поиском информации, планами и формулировками.
- [${today}] ПАМЯТЬ: когда контекст может помочь, вызывай \`memory_get\` с \`file="memory/topics/${topic}-context.md"\`. После устойчивых фактов сохраняй через \`memory_save\` с \`category="topic"\` и \`topic="${topic}-context"\` или более точной безопасной темой.
- [${today}] ЭМОЦИОНАЛЬНАЯ СВЯЗЬ: запоминай устойчивые предпочтения, цели, стиль общения и важный личный контекст только в памяти этого chat_id. Используй это дальше естественно, без выдуманной близости и без доступа к чужой памяти.
- [${today}] БЕЗОПАСНОСТЬ ЛИЧНОСТИ: не определяй пользователя по отображаемому имени. Если имя совпадает с администратором или другим пользователем, это всё равно отдельный человек, пока собственная память этого chat_id явно не говорит обратное.
- [${today}] Это ГОСТЕВАЯ группа (sandbox). ЗАПРЕЩЕНО: sudo, разрушительные команды, изменение настроек системы, чтение приватных файлов администратора ${adminContact()} (.env, ключи, store/messages.db, groups/${instanceProfile().telegram.guestPromptOwnerFolder}, sessions, cookies браузеров) и чужих групп.
- [${today}] Если попросят передать что-то администратору ${adminContact()} — сохранить через \`memory_save\` с \`category="topic"\` и \`topic="${topic}-to-admin"\`, не пересылать в его чат автоматически без явной просьбы администратора.
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
    'SKOOBI_CHEAP_MODEL',
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
    degradedModel:
      value('SKOOBI_CHEAP_MODEL') || value('SKOOBI_QUOTA_DEGRADED_MODEL'),
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

/**
 * The Codex binary the bot actually runs (SEC-13). The model gateway takes
 * SKOOBI_CODEX_COMMAND from .env — in prod a pinned copy under node_modules —
 * so /engine must probe that one, not whatever `codex` PATH happens to hold
 * (Homebrew lags behind the pin). Same precedence as the gateway: .env first,
 * then the process environment, then plain `codex`.
 */
function resolveCodexCommand(): string {
  const fromFile = readEnvFile(['SKOOBI_CODEX_COMMAND']).SKOOBI_CODEX_COMMAND;
  return (
    fromFile?.trim() || process.env.SKOOBI_CODEX_COMMAND?.trim() || 'codex'
  );
}

function codexVersionFromOutput(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/);
  return match ? match[1] : null;
}

async function codexCliStatus(): Promise<string> {
  const command = resolveCodexCommand();
  let version: string | null = null;
  try {
    const result = await execFileAsync(command, ['--version'], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    version = codexVersionFromOutput(
      typeof result === 'string'
        ? result
        : [result.stdout, result.stderr].filter(Boolean).join('\n'),
    );
  } catch {
    return 'недоступен';
  }
  const withVersion = (status: string) =>
    version ? `${status} (${version})` : status;

  try {
    const result = await execFileAsync(command, ['login', 'status'], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const output =
      typeof result === 'string'
        ? result
        : [result.stdout, result.stderr].filter(Boolean).join('\n');
    return codexLoginStatusIndicatesLoggedIn(output)
      ? withVersion('включена')
      : withVersion('недоступен');
  } catch (err) {
    return isCodexLoginStatusUnavailable(err)
      ? withVersion('включена')
      : withVersion('недоступен');
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
// as a crash). Admin turns may run up to 90 minutes and the sandbox allows
// two more on top (resolveSandboxGlobalTimeoutMs), so the cap sits just past
// both configured limits.
export const TYPING_MAX_DURATION_MS = 95 * 60 * 1000;

function telegramProgressAbortSignal(signal: AbortSignal): NonNullable<Parameters<Api['sendMessage']>[3]> {
  // grammY's declarations name its historical abort-controller polyfill.
  // Its fetch transport also accepts the standard Node/Web AbortSignal.
  return AbortSignal.any([signal, AbortSignal.timeout(8000)]) as unknown as NonNullable<Parameters<Api['sendMessage']>[3]>;
}

export class TelegramChannel implements Channel {
  private mediaIntakeAdapter?: MediaIntakeAdapter;
  private mediaIntakeWorker?: MediaIntakeWorker;
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private ownerNotificationChannel?: TelegramChannel;
  private peerChannels: TelegramChannel[] = [];
  private progressMessages = new ProgressMessages();
  // jid -> interval handle for the active typing-refresh loop.
  // Indexed by full jid (e.g. "tg:100000001") so multiple chats can be
  // "typing" simultaneously without stomping on each other.
  private typingIntervals = new Map<string, NodeJS.Timeout>();
  /** W41: getUpdates outcomes of the current bot, for the heartbeat. */
  private pollHealth: TelegramPollHealth | null = null;
  /** J12: pending retry of a command-menu publish that failed (e.g. at boot). */
  private commandMenuRetryTimer: NodeJS.Timeout | null = null;
  private commandMenuRetryAttempt = 0;
  /** Whether /selftest exists here: decided once, see hasSelftest(). */
  private selftestAvailable: boolean | null = null;
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

  /**
   * Decided once per channel, so the owner menu, the command handler and the
   * plain-text filter always agree.
   */
  private hasSelftest(): boolean {
    if (this.selftestAvailable === null) {
      this.selftestAvailable = (
        this.opts.selftestInstalled ?? selftestScriptInstalled
      )();
    }
    return this.selftestAvailable;
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

  private senderIdentityForContext(ctx: any, displayName: string, message = ctx.message) {
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
      telegram_message_origin: telegramMessageOriginForContext(ctx, message),
    };
  }

  private isEditableText(message: Message.TextMessage): boolean {
    const text = message.text.trim();
    const slashName = /^\/([a-z0-9_-]+)(?:@[a-z0-9_]+)?(?:\s|$)/i.exec(text)?.[1].toLowerCase();
    if (
      !text || (slashName && (isRegisteredCommandName(slashName, this.hasSelftest()) || HOST_EDIT_COMMANDS.has(slashName))) ||
      message.entities?.some(entity => entity.type === 'bot_command' && entity.offset === 0) ||
      isMemoryDeleteTextIntent(text) || isMemoryDeleteConfirmation(text)
    ) return false;
    if (!looksLikeLooseMemoryDeleteConfirmation(text) || !message.from) return true;
    const tenant = this.tenantForChat(message.chat.id);
    const pending = tenant && this.pendingMemoryDeletes.get(this.memoryDeleteKey(tenant.tenant_id, String(message.from.id)));
    return !pending || pending.expiresAtMs <= Date.now();
  }

  private inboundText(
    ctx: any,
    message: Message.TextMessage,
    group: TelegramRegisteredGroup,
    content: string,
    editable?: boolean,
  ): NewMessage {
    const senderName = ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
    return {
      id: String(message.message_id),
      chat_jid: this.chatJidForChat(ctx.chat.id),
      sender: ctx.from?.id?.toString() || '',
      sender_name: senderName,
      content,
      timestamp: telegramMessageTimestamp({ message }),
      is_from_me: false,
      tenant_id: this.tenantIdForChat(ctx.chat.id),
      sender_identity: this.senderIdentityForContext(ctx, senderName, message),
      telegram_update_id: telegramUpdateId(ctx),
      ...(editable === undefined ? {} : {
        telegram_editable: editable,
        telegram_receiver_id: String(ctx.me.id),
        telegram_edit_group_folder: group.folder,
      }),
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

    const botId = ctx.me?.id;
    const botUsername = ctx.me?.username?.toLowerCase();
    const entities: any[] = ctx.message?.entities || [];
    const mentioned = entities.some((entity) => {
      if (entity.type === 'mention' && botUsername) {
        const mentionText = content
          .substring(entity.offset, entity.offset + entity.length)
          .toLowerCase();
        return mentionText === `@${botUsername}`;
      }
      // Bots without a public @username are referenced via text_mention,
      // which carries the user object directly.
      if (entity.type === 'text_mention' && botId !== undefined) {
        return entity.user?.id === botId;
      }
      return false;
    });
    if (mentioned) return true;

    const replyFromId = ctx.message?.reply_to_message?.from?.id;
    if (
      botId !== undefined &&
      replyFromId !== undefined &&
      replyFromId === botId
    ) {
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

  private resolveTelegramTarget(
    rawArg: string,
  ):
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
    trace?: OperationTraceObserver,
  ): void {
    const chatJid = this.chatJidForChat(ctx.chat.id);
    const span = startOperationTraceStage(trace, 'inbox');
    try {
      const timestamp = telegramMessageTimestamp(ctx);
      appendTelegramInboxEntry(group.folder, {
        received_at: new Date().toISOString(),
        chat_jid: chatJid,
        group_folder: group.folder,
        message_id: ctx.message?.message_id?.toString() || '',
        sender: ctx.from?.id?.toString() || '',
        sender_name: telegramSenderName(ctx),
        timestamp,
        kind,
        telegram_message_origin: telegramMessageOriginForContext(ctx),
        ...this.inboxDetailsWithoutSecrets(chatJid, timestamp, details),
      });
      span.finish('succeeded');
    } catch (err) {
      span.finish('failed', { reason: 'storage_failure' });
      logger.warn(
        { err, chatJid, folder: group.folder, kind },
        'Failed to record Telegram durable inbox entry',
      );
    }
  }

  /**
   * W19: the inbox copy keeps «[скрыто]» instead of a password, a code or a
   * key; onMessage still delivers the original text to the agent.
   */
  private inboxDetailsWithoutSecrets(
    chatJid: string,
    timestamp: string,
    details: Partial<TelegramInboxEntry>,
  ): Partial<TelegramInboxEntry> {
    if (!details.text && !details.caption) return details;
    let context: ChatSecretContext = {};
    const parsed = Date.parse(timestamp);
    const at = Number.isFinite(parsed) ? parsed : Date.now();
    let replies: ReturnType<
      NonNullable<TelegramChannelHost['recentBotReplies']>
    > = [];
    try {
      const host = this.opts.host;
      if (host.recentBotReplies) {
        replies = host.recentBotReplies(
          chatJid,
          timestamp,
          new Date(at - SECRET_REQUEST_WINDOW_MS).toISOString(),
        );
      } else {
        const last = host.lastBotReply?.(chatJid, timestamp);
        replies = last ? [last] : [];
      }
    } catch {
      // Without the bot's stored replies only the noted requests remain.
    }
    try {
      context = {
        afterSecretRequest: followsSecretRequest(replies, at, chatJid),
      };
    } catch {
      // Only the context-free rules apply.
    }
    return {
      ...details,
      ...(details.text !== undefined
        ? { text: maskChatSecrets(details.text, context) }
        : {}),
      ...(details.caption !== undefined
        ? { caption: maskChatSecrets(details.caption, context) }
        : {}),
    };
  }

  private traceInboundMessage(ctx: any): OperationTraceObserver | undefined {
    try {
      const trace = this.opts.operationTrace?.(
        this.chatJidForChat(ctx.chat.id),
        ctx.message.message_id.toString(),
      );
      startOperationTraceStage(trace, 'received').finish('succeeded');
      return trace;
    } catch {
      // Optional diagnostics must never reject a valid inbound message.
      return undefined;
    }
  }

  private acceptMediaIntake(
    ctx: any,
    kind: MediaIntakeKind,
    trace?: OperationTraceObserver,
  ): boolean {
    if (!this.mediaIntakeAdapter) return false;
    const accepted = startOperationTraceStage(trace, 'accepted');
    try {
      const media = ctx.message[kind];
      const senderName = telegramSenderName(ctx);
      const chatJid = this.chatJidForChat(ctx.chat.id);
      const result = this.mediaIntakeAdapter.accept({
        message: {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          timestamp: telegramMessageTimestamp(ctx),
          sender_identity: this.senderIdentityForContext(ctx, senderName),
          telegram_update_id: telegramUpdateId(ctx),
        },
        media: {
          kind,
          fileId: media.file_id,
          fileUniqueId: media.file_unique_id,
          fileName: media.file_name,
          mimeType: media.mime_type,
          declaredBytes: media.file_size,
          durationSeconds: media.duration,
        },
        caption: ctx.message.caption,
        isGroup: ctx.chat.type === 'group' || ctx.chat.type === 'supergroup',
      });
      accepted.finish(
        result.kind === 'rejected' && result.reason !== 'capacity'
          ? 'skipped'
          : 'succeeded',
      );
      if (result.kind === 'accepted' || result.kind === 'duplicate') {
        try {
          this.opts.onChatMetadata(
            chatJid,
            telegramMessageTimestamp(ctx),
            undefined,
            'telegram',
            ctx.chat.type === 'group' || ctx.chat.type === 'supergroup',
          );
        } catch {
          logger.warn(
            { code: 'metadata_unavailable' },
            'Accepted media chat metadata unavailable',
          );
        }
        void this.mediaIntakeWorker?.wake();
      }
      return true;
    } catch {
      accepted.finish('failed', { reason: 'storage_failure' });
      // Continuing polling would acknowledge an update that was never saved.
      throw new MediaIntakePersistenceError();
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

  /**
   * J12: the menu lives on Telegram's side, so one failed publish (no network
   * yet right after a reboot) used to leave it stale until the next restart.
   * Retry with backoff — 30 s, 1, 2, 4 … min, at most every 30 min — until it
   * goes through or the channel disconnects.
   */
  private scheduleCommandMenuRetry(): void {
    if (this.commandMenuRetryTimer || !this.bot) return;
    const delayMs = Math.min(
      COMMAND_MENU_RETRY_BASE_MS * 2 ** this.commandMenuRetryAttempt,
      COMMAND_MENU_RETRY_MAX_MS,
    );
    this.commandMenuRetryTimer = setTimeout(() => {
      this.commandMenuRetryTimer = null;
      void this.retryCommandMenu();
    }, delayMs);
    this.commandMenuRetryTimer.unref?.();
  }

  private async retryCommandMenu(): Promise<void> {
    if (!this.bot) return;
    this.commandMenuRetryAttempt += 1;
    const attempt = this.commandMenuRetryAttempt;
    const outcome = await this.publishBotCommands();
    if (outcome === 'transient') {
      this.scheduleCommandMenuRetry();
      return;
    }
    // A permanent error (4xx) is already logged and will not fix itself.
    this.commandMenuRetryAttempt = 0;
    if (outcome === 'published') {
      logger.info({ attempt }, 'Telegram command menu published after retry');
    }
  }

  private clearCommandMenuRetry(): void {
    if (this.commandMenuRetryTimer) clearTimeout(this.commandMenuRetryTimer);
    this.commandMenuRetryTimer = null;
    this.commandMenuRetryAttempt = 0;
  }

  /**
   * 'published' when the main menu went through; per-owner and per-admin
   * menus are best effort (one broken chat does not block the others).
   * 'transient' when something failed in a way worth retrying (network, 5xx,
   * 429); 'permanent' when the main menu failed with a 4xx.
   */
  private async publishBotCommands(): Promise<CommandMenuOutcome> {
    if (!this.bot) return 'transient';
    try {
      await this.bot.api.setMyCommands(PUBLIC_BOT_COMMANDS);
    } catch (err) {
      const willRetry = isTransientTelegramError(err);
      logger.warn(
        { err: sanitizeTelegramError(err), willRetry },
        'Failed to publish Telegram command menu',
      );
      return willRetry ? 'transient' : 'permanent';
    }
    let transientFailure = false;
    // Owner chats get the full menu (a superset of the admin commands). Track
    // them so the admin loop below does NOT overwrite the owner menu for an
    // owner who is also listed as a command-admin (else the owner would only
    // see the admin commands and lose owner-only entries such as /health).
    const ownerChatIds = new Set<string>();
    for (const [jid, group] of Object.entries(this.opts.registeredGroups())) {
      if (!group.isMain || !jid.startsWith('tg:')) continue;
      if (!this.ownsJid(jid)) continue;
      const chatId = telegramChatId(jid);
      ownerChatIds.add(String(chatId));
      try {
        await this.bot.api.setMyCommands(ownerBotCommands(this.hasSelftest()), {
          scope: {
            type: 'chat',
            chat_id: chatId,
          },
        });
        logger.info({ jid }, 'Telegram owner command menu published');
      } catch (err) {
        const willRetry = isTransientTelegramError(err);
        if (willRetry) transientFailure = true;
        logger.warn(
          { jid, err: sanitizeTelegramError(err), willRetry },
          'Failed to publish Telegram owner command menu',
        );
      }
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
        const willRetry = isTransientTelegramError(err);
        if (willRetry) transientFailure = true;
        logger.warn(
          { adminId, err: sanitizeTelegramError(err), willRetry },
          'Failed to publish Telegram command admin menu',
        );
      }
    }
    return transientFailure ? 'transient' : 'published';
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

  /**
   * «Остановить» under /tasks or a task notice: only the owner of this main
   * chat (OWNER_TELEGRAM_USER_IDS, as for /pending); the host decides the
   * rest and gives the new text of the message.
   */
  private async handleTaskControlCallback(ctx: any): Promise<void> {
    const action = parseTaskControlCallbackData(
      String(ctx.callbackQuery?.data || ''),
    );
    if (!action) return;
    if (!isOwnerCommandContext(this.opts, ctx)) {
      await this.answerCallbackQueryIfPresent(
        ctx,
        'Останавливать задачи может только владелец этого чата.',
      );
      return;
    }
    const chatId = contextChatId(ctx);
    if (!this.opts.onTaskControl || chatId === undefined || chatId === null) {
      await this.answerCallbackQueryIfPresent(ctx, 'Сейчас это недоступно.');
      return;
    }
    const result = await this.opts.onTaskControl({
      chatJid: this.chatJidForChat(chatId),
      senderId: String(contextFrom(ctx)?.id ?? ''),
      action,
    });
    await this.answerCallbackQueryIfPresent(ctx, result.toast);
    if (!result.text) return;
    const replyMarkup = telegramInlineKeyboard(result.buttons);
    const options = replyMarkup ? { reply_markup: replyMarkup } : {};
    try {
      // Without reply_markup Telegram drops the old buttons.
      if (typeof ctx.editMessageText !== 'function') throw new Error('no edit');
      await ctx.editMessageText(result.text, options);
    } catch (err) {
      logger.debug(
        { err: sanitizeTelegramError(err) },
        'Task control: message not edited, sending the result anew',
      );
      await this.bot?.api.sendMessage(chatId, result.text, options);
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
    await this.mediaIntakeWorker?.stop();
    this.mediaIntakeWorker = undefined;
    this.mediaIntakeAdapter = undefined;
    if (this.opts.mediaIntake) {
      const adapter = this.opts.mediaIntake(this.opts.botId);
      if (!adapter) throw new MediaIntakePersistenceError();
      this.mediaIntakeAdapter = adapter;
      this.mediaIntakeWorker = new MediaIntakeWorker({
        adapter,
        groupDirectory: (job) => resolveGroupFolderPath(job.scope.groupFolder),
        operationTrace: (job) =>
          this.opts.operationTrace?.(job.scope.chatJid, job.input.message.id),
        download: async (job, control) => {
          const result = await downloadTelegramAudio(
            this.botToken,
            job.input.media.fileId,
            job.scope.groupFolder,
            job.input.media.kind,
            control.trace,
            { ...control, maxAttempts: 1 },
          );
          if (!result) throw new MediaIntakeWorkError('transport_failure');
        },
        transcribe: (sourcePath, control) =>
          transcribeAudioFile(sourcePath, undefined, control.trace, control),
        transcribeDetailed: (sourcePath, control) =>
          transcribeAudioFileDetailed(sourcePath, undefined, control.trace, control),
        // W13: back into the media manifest, as before the pipeline.
        onMaterialized: async (job, media) => {
          try {
            await publishMaterializedMedia({
              groupDirectory: resolveGroupFolderPath(job.scope.groupFolder),
              job,
              bytes: media.bytes,
            });
          } catch (err) {
            logger.warn(
              {
                groupFolder: job.scope.groupFolder,
                code: (err as NodeJS.ErrnoException)?.code,
              },
              'Failed to record media manifest entry',
            );
          }
        },
        onError: (code) =>
          logger.warn({ code }, 'Media intake worker unavailable'),
      });
    }
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
        // grammY's default is 500 s: one request hung on a dead Wi-Fi link
        // held a reply for over eight minutes. 180 s still covers large
        // uploads and the 30 s long poll.
        timeoutSeconds: 180,
      },
    });
    // W41: grammY retries a failing getUpdates silently (debug log only);
    // watch it so an outage reaches the journal and the heartbeat.
    this.pollHealth = new TelegramPollHealth({
      log: logger,
      stallSec: telegramPollStallSec,
      describeError: sanitizeTelegramError,
    });
    // W41: until onStart fires (getMe/deleteWebhook retried for up to 20 min
    // apart without network) inbound does not work either.
    this.pollHealth.onStartupBegin();
    this.bot.api.config?.use?.(
      pollHealthTransformer(this.pollHealth) as unknown as Transformer,
    );

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

    // M-C48: plain-Russian status for the owner — one verdict line first
    // («✅ всё в порядке» / «⚠️ проблем: N»), then what the problems are,
    // then a few human facts. Technical details live in /health and /engine.
    this.bot.command('status', async (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      const env = readEnvFile(['WHISPER_MODEL']);
      const whisperModel = process.env.WHISPER_MODEL || env.WHISPER_MODEL || '';
      const chatId = contextChatId(ctx);
      const groups = this.opts.registeredGroups();
      const group =
        chatId !== undefined && chatId !== null
          ? groups[`tg:${chatId}`] || groups[this.chatJidForChat(chatId)]
          : undefined;
      const engine = readSkoobiEngineRuntimeStatus(group);

      let msgsToday = 0;
      try {
        msgsToday = this.opts.host.messagesToday();
      } catch {
        msgsToday = -1;
      }

      let health: LaunchdServicesReport;
      try {
        health = await (this.opts.serviceHealth ?? collectStatusServices)();
      } catch (err) {
        logger.warn({ err }, '/status: service check failed');
        health = { checked: false, services: [], problems: [] };
      }

      const problems = health.problems;
      let profileProblem: string | null = null;
      try {
        profileProblem = instanceProfileProblemRu(
          (this.opts.instanceProfileStatus ?? instanceProfileStatus)(),
        );
      } catch (err) {
        logger.warn({ err }, '/status: instance profile check failed');
      }
      const problemCount = problems.length + (profileProblem ? 1 : 0);
      const verdict =
        problemCount > 0
          ? `⚠️ проблем: ${problemCount}`
          : health.checked
            ? '✅ всё в порядке'
            : '✅ бот работает';
      const lines = [`${ASSISTANT_NAME}: ${verdict}`];
      for (const problem of problems) {
        lines.push(`• ${problem.name} — ${problem.detail}`);
      }
      if (profileProblem) {
        lines.push(`• Профиль инстанса — ${profileProblem}`);
      }
      if (!health.checked) {
        lines.push('Службы этого компьютера проверить не удалось.');
      }
      lines.push(
        '',
        engine.codexActive
          ? `Отвечает: ${engine.model} через Codex`
          : 'Отвечает: Claude (Anthropic)',
        `Работает без перезапуска: ${formatUptimeRu(process.uptime())}`,
        `Сообщений сегодня: ${msgsToday >= 0 ? msgsToday : 'не удалось посчитать'}`,
        `Голос: распознаёт ${whisperModel.split('/').pop() || 'по умолчанию'}, ` +
          `озвучивает ${ttsProvider()} (${ttsVoiceName()})`,
      );
      replySafely(ctx, lines.join('\n'));
    });

    // Safe all-up health check. This does not restart services, send voice, or
    // mutate persistent state except for one temporary memory add/forget smoke.
    // Registered only where the self-test script is installed.
    const selftestBot = this.hasSelftest() ? this.bot : null;
    selftestBot?.command(SELFTEST_COMMAND, async (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      replySafely(ctx, 'Self-test started. I will post the report shortly.');
      try {
        const { stdout, stderr } = await execFileAsync(
          'bash',
          [SELFTEST_SCRIPT],
          {
            cwd: process.cwd(),
            timeout: 60_000,
            maxBuffer: 64 * 1024,
            env: {
              ...process.env,
              PATH:
                '/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' +
                (process.env.PATH || ''),
            },
          },
        );
        let text = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (!text) text = 'Self-test finished with no output.';
        if (text.length > 3900) {
          text = text.slice(0, 3800) + '\n...truncated';
        }
        replySafely(ctx, text);
      } catch (err) {
        const e = err as {
          message?: string;
          stdout?: string | Buffer;
          stderr?: string | Buffer;
        };
        const output = [e.stdout, e.stderr]
          .filter(Boolean)
          .map((v) => String(v))
          .join('\n')
          .trim();
        let text = [
          'Self-test command failed.',
          e.message ? `Error: ${e.message}` : '',
          output,
        ]
          .filter(Boolean)
          .join('\n');
        if (text.length > 3900) {
          text = text.slice(0, 3800) + '\n...truncated';
        }
        replySafely(ctx, text);
      }
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

    this.bot.callbackQuery(TASK_CONTROL_CALLBACK_RE, async (ctx) => {
      this.recordCallbackQuery(ctx, 'task_control');
      try {
        await this.handleTaskControlCallback(ctx);
      } catch (err) {
        logger.error({ err }, 'Telegram task control callback failed');
        await this.answerCallbackQueryIfPresent(
          ctx,
          'Не смог остановить задачу. См. логи.',
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

    this.bot.on('edited_message:text', (ctx) => {
      const receiveEdit = this.opts.onTelegramMessageEdit;
      const message = ctx.editedMessage;
      const origin = privateTelegramTextOrigin(ctx, message);
      if (!receiveEdit || !origin || !Number.isSafeInteger(message.edit_date) || message.edit_date < message.date) return;
      const jid = this.chatJidForChat(message.chat.id);
      try {
        const group = this.opts.registeredGroups()[jid];
        if (!group || (this.opts.host.privateAdminModeEnabled() && !isPrivateAdminAllowedContext(this.opts, ctx))) return;
        // An edit must not consume guest quota, clear a ban or open an access request.
        const state = readTelegramAccessState(true);
        const access = state[jid];
        if (jid in state && (!access || typeof access !== 'object' || Array.isArray(access))) {
          throw new Error('Invalid Telegram access entry');
        }
        if (access?.status) return;
        // Rate deferral holds the existing queue position. Its contents may
        // still be corrected while the worker is waiting for that hold to lift.
        if (access?.deferAgentUntil && !Number.isFinite(Date.parse(access.deferAgentUntil))) return;
        // Adding blockquote formatting withdraws the previous direct text.
        // The quote itself is never given to the host as replacement content.
        const editable = origin === 'direct' && this.isEditableText(message);
        const content = editable ? telegramTextContent(message, ctx.me.username) : '';
        const edit = this.inboundText(ctx, message, group, content, editable);
        if (origin === 'quoted') edit.telegram_edit_local_quote = true;
        receiveEdit(jid, edit, message.edit_date);
      } catch {
        // A failed write must stop this poll batch before its offset is acknowledged.
        throw new TelegramTextPersistenceError('edit');
      }
    });

    this.bot.on('message:text', async (ctx) => {
      // a bare `startsWith('/')` discarded EVERY
      // message beginning with a slash — a pasted path like /Users/example/...,
      // a typo, a Russian phrase with a slash — silently, with no reply at all.
      // grammy has already routed real commands to their own handlers by now,
      // so only skip when Telegram itself marked the text as a bot_command at
      // offset 0 AND the command is one this bot actually registers. Anything
      // else is ordinary text and must reach the agent.
      if (isHandledBotCommand(ctx.message, this.hasSelftest())) return;

      const chatJid = this.chatJidForChat(ctx.chat.id);
      const text = ctx.message.text;
      const timestamp = telegramMessageTimestamp(ctx);
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';

      if (rejectUntrustedPrivateAdminContext(this.opts, ctx)) return;

      // Deterministic quota/memory-deletion text intents reply directly,
      // bypassing the agent. In group chats only treat a message as such an
      // intent when the bot is actually addressed (reply, @mention, or text
      // trigger); otherwise a bare phrase like "мой баланс" typed to other
      // members triggers an unsolicited bot reply. Private chats are always 1:1.
      if (this.isAddressedToBot(ctx, text)) {
        if (await this.handleMemoryPrivacyTextIntent(ctx, text)) return;
      }

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate a Telegram mention of the bot's username into the
      // TRIGGER_PATTERN format: the username (e.g. @fixture_bot) does not match
      // the trigger (e.g. ^@Skoobi\b), so the trigger is prepended.
      const content = telegramTextContent(ctx.message, ctx.me?.username);

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      try {
        this.opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);
      } catch (error) {
        // The chat upsert precedes source storage. If SQLite fails here, an
        // eligible update still needs the same polling retry as a failed write.
        if (
          this.opts.onTelegramMessageEdit && this.opts.registeredGroups()[chatJid] &&
          privateTelegramTextOrigin(ctx, ctx.message) === 'direct' && this.isEditableText(ctx.message) &&
          !readTelegramAccessState()[chatJid]?.status
        ) throw new TelegramTextPersistenceError('original');
        throw error;
      }

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
      const editable = Boolean(this.opts.onTelegramMessageEdit) && decision.reason !== 'paused' &&
        privateTelegramTextOrigin(ctx, ctx.message) === 'direct' && this.isEditableText(ctx.message);
      const message = this.inboundText(ctx, ctx.message, group, content, editable || undefined);
      try {
        this.opts.onMessage(chatJid, message);
      } catch (error) {
        if (editable) throw new TelegramTextPersistenceError('original');
        throw error;
      }

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

        const fileRef = savedPath
          ? ` File: received/${path.basename(savedPath)} — use Read tool to inspect visual context`
          : '';
        const placeholder = savedPath
          ? `[Photo.${fileRef}]`
          : '[Photo — download failed]';

        storeNonText(ctx, placeholder, {
          skipAccessCheck: true,
          skipInbox: true,
        });
        if (savedPath) {
          await recordMedia(ctx, group.folder, savedPath, 'photo', {
            hasCaption: !!ctx.message.caption,
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
      const videoTooBig = telegramOversizePlaceholder(
        'Video',
        ctx.message.video?.file_size,
      );
      if (videoTooBig) {
        storeNonText(ctx, videoTooBig, {
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
      const parts: string[] = [];
      if (result.transcript) {
        parts.push(`Transcript: ${result.transcript}`);
      } else {
        parts.push('transcription failed or no speech detected');
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
      // Tier 1: placeholders go into the DB and must not leak absolute paths,
      // so key frames are referenced by relative path.
      const parts: string[] = [];
      if (result.transcript) {
        parts.push(`Transcript: ${result.transcript}`);
      } else {
        parts.push('transcription failed or no speech detected');
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

      const trace = this.traceInboundMessage(ctx);
      const fileId = ctx.message.voice?.file_id;
      this.recordTelegramInbox(
        ctx,
        group,
        'voice',
        {
          deferred: !decision.processNow,
          file_id: fileId,
          file_unique_id: ctx.message.voice?.file_unique_id,
        },
        trace,
      );
      if (!fileId) {
        storeNonText(ctx, '[Voice message]', {
          skipAccessCheck: true,
          skipInbox: true,
        });
        return;
      }
      if (this.acceptMediaIntake(ctx, 'voice', trace)) return;

      // Download once, keep the exact saved file for the media manifest, then
      // pass that same local path through the channel-agnostic STT pipeline.
      // The shared pipeline owns language auto-detection and any local retries.
      const savedPath = await downloadTelegramAudio(
        this.botToken,
        fileId,
        group.folder,
        'voice',
        trace,
      );
      const transcriptResult = savedPath
        ? await transcribeAudioFile(savedPath, undefined, trace).catch(
            () => null,
          )
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

      const trace = this.traceInboundMessage(ctx);
      const fileId = ctx.message.audio?.file_id;
      this.recordTelegramInbox(
        ctx,
        group,
        'audio',
        {
          caption: ctx.message.caption,
          deferred: !decision.processNow,
          file_id: fileId,
          file_unique_id: ctx.message.audio?.file_unique_id,
          file_name: ctx.message.audio?.file_name,
        },
        trace,
      );
      if (!fileId) {
        storeNonText(ctx, '[Audio]', {
          skipAccessCheck: true,
          skipInbox: true,
        });
        return;
      }
      if (this.acceptMediaIntake(ctx, 'audio', trace)) return;
      const audioTooBig = telegramOversizePlaceholder(
        'Audio',
        ctx.message.audio?.file_size,
      );
      if (audioTooBig) {
        storeNonText(ctx, audioTooBig, {
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
        trace,
      );
      const transcriptResult = savedPath
        ? await transcribeAudioFile(savedPath, undefined, trace).catch(
            () => null,
          )
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
      const documentTooBig = telegramOversizePlaceholder(
        `Document: ${name}`,
        ctx.message.document?.file_size,
      );
      if (documentTooBig) {
        storeNonText(ctx, documentTooBig, {
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
      if (err.error instanceof MediaIntakePersistenceError || err.error instanceof TelegramTextPersistenceError) throw err;
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    if ((await this.publishBotCommands()) === 'transient') {
      this.scheduleCommandMenuRetry();
    }

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
          this.pollHealth?.onStartupComplete();
          this.mediaIntakeWorker?.start();
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
          const failedBot = this.bot;
          this.bot = null;
          try {
            void Promise.resolve(failedBot?.stop()).catch(() => {});
          } catch {
            // A client that failed during initialization may also reject stop.
          }
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

  async sendProgress(jid: string, text: string, turnKey: string, options?: Pick<SendMessageOptions, 'canSend'>): Promise<boolean> {
    const bot = this.bot;
    if (!bot) throw new Error('Telegram bot not initialized');
    const chatId = this.telegramChatIdForJid(jid);
    if (readTelegramAccessState()[jid]?.outboundBlockedReason === 'bot_blocked_by_user') {
      throw new Error('Telegram chat unreachable: bot_blocked_by_user');
    }
    // Plain text keeps edits valid even when a progress excerpt cuts Markdown.
    const visible = plainTelegramText(text).slice(0, 3900);
    if (!visible.trim()) return false;
    const delivered = await this.progressMessages.update({
      chat: jid,
      turn: turnKey,
      text: visible,
      canSend: options?.canSend,
      send: async (value, signal) => {
        const message = await bot.api.sendMessage(chatId, value, {
          disable_notification: true,
        }, telegramProgressAbortSignal(signal));
        return message.message_id;
      },
      edit: async (id, value, signal) => {
        await bot.api.editMessageText(chatId, id, value, {}, telegramProgressAbortSignal(signal));
      },
    });
    if (delivered) logger.info({ jid, length: visible.length }, 'Telegram progress updated');
    return delivered;
  }

  async finishProgress(jid: string, turnKey: string): Promise<void> {
    await this.progressMessages.finish(jid, turnKey);
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void> {
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

      // Telegram has a 4096 character limit per message — split if needed.
      // Tables are rewritten before the split so a long table is not cut
      // between its header and its rows; the margin under 4096 absorbs the
      // escapes added per part.
      const parts = splitTelegramText(normalizeTelegramBlocks(text));
      // A reply that formatting empties (e.g. a bare «>») still goes out as
      // typed instead of silently vanishing while logged as sent.
      if (parts.length === 0 && text.trim()) parts.push(text);
      // Buttons go under the last part: that is where the reader ends up.
      const replyMarkup = telegramInlineKeyboard(options?.buttons);
      for (const [index, part] of parts.entries()) {
        const markup = replyMarkup && index === parts.length - 1 ? { reply_markup: replyMarkup } : {};
        await sendTelegramMessageWithRetry(this.bot.api, numericId, part, markup, options?.canSend);
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
      // The router treats normal completion as a channel ACK. A disconnected
      // bot must fail explicitly, including a disconnect during file checks.
      throw new Error('Telegram bot not initialized');
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

  async generateVoiceAudio(jid:string,text:string) {
    if(!this.bot||!this.ownsJid(jid))throw new Error('voice_generation_unavailable');
    return synthesizeReusableVoice(text);
  }
  async sendVoiceFile(jid:string,filePath:string):Promise<void> {
    if(!this.bot)throw new Error('voice_channel_unavailable');
    await this.bot.api.sendVoice(this.telegramChatIdForJid(jid),new InputFile(filePath));
  }

  async sendVoice(jid: string, text: string, options?: Pick<SendMessageOptions, 'canSend'>): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;
    const numericId = this.telegramChatIdForJid(jid);
    if (options?.canSend && !options.canSend()) throw new Error('saved_final_superseded');
    const result = await synthesizeVoice(trimmed);
    try {
      for (const file of result.files) {
        if (options?.canSend && !options.canSend()) throw new Error('saved_final_superseded');
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

  /**
   * W41: false while getUpdates has kept failing (or hung) past
   * SKOOBI_TELEGRAM_POLL_STALL_SEC. The heartbeat reads it; outbound delivery
   * still goes by isConnected().
   */
  isInboundHealthy(): boolean {
    if (!this.bot || !this.pollHealth) return true;
    return this.pollHealth.status().healthy;
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
    this.clearCommandMenuRetry();
    await this.mediaIntakeWorker?.stop();
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

  /**
   * Реакция на входящее сообщение — например, 👀 «увидел, возьму следом»,
   * пока модель занята долгой задачей. Строго best-effort: реакции в чате
   * могут быть выключены, сообщение — слишком старым, эмодзи — не из списка
   * Telegram. Поэтому ни одного ретрая и никакого ожидания retry_after: вызов
   * идёт мимо sendTelegramMessageWithRetry, ошибка пишется в debug, а наружу
   * возвращается false.
   */
  async reactToMessage(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<boolean> {
    if (!this.bot) return false;
    const numericMessageId = Number(messageId);
    if (
      !/^\d+$/.test(messageId) ||
      !Number.isSafeInteger(numericMessageId) ||
      numericMessageId <= 0
    ) {
      return false;
    }
    try {
      await this.bot.api.setMessageReaction(
        this.telegramChatIdForJid(jid),
        numericMessageId,
        [{ type: 'emoji', emoji } as ReactionTypeEmoji],
      );
      return true;
    } catch (err) {
      logger.debug(
        { jid, err: sanitizeTelegramError(err) },
        'Telegram reaction was not set',
      );
      return false;
    }
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

  /** W41: inbound works when at least one connected bot still polls. */
  isInboundHealthy(): boolean {
    return this.channels.some(
      (channel) => channel.isConnected() && channel.isInboundHealthy(),
    );
  }

  ownsJid(jid: string): boolean {
    return this.channels.some((channel) => channel.ownsJid(jid));
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.disconnect()));
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    const channel = this.channelForJid(jid);
    if (!channel) throw new Error(`No Telegram bot owns JID: ${jid}`);
    if (options) await channel.sendMessage(jid, text, options);
    else await channel.sendMessage(jid, text);
  }

  async sendProgress(jid: string, text: string, turnKey: string, options?: Pick<SendMessageOptions, 'canSend'>): Promise<boolean> {
    const channel = this.channelForJid(jid);
    if (!channel) throw new Error(`No Telegram bot owns JID: ${jid}`);
    return channel.sendProgress(jid, text, turnKey, options);
  }

  async finishProgress(jid: string, turnKey: string): Promise<void> {
    const channel = this.channelForJid(jid);
    if (!channel) throw new Error(`No Telegram bot owns JID: ${jid}`);
    await channel.finishProgress(jid, turnKey);
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

  async generateVoiceAudio(jid:string,text:string) {
    const channel=this.channelForJid(jid);
    if(!channel)throw new Error('voice_generation_unavailable');
    return channel.generateVoiceAudio(jid,text);
  }
  async sendVoiceFile(jid:string,filePath:string):Promise<void> {
    const channel=this.channelForJid(jid);
    if(!channel)throw new Error('voice_channel_unavailable');
    return channel.sendVoiceFile(jid,filePath);
  }

  async sendVoice(jid: string, text: string, options?: Pick<SendMessageOptions, 'canSend'>): Promise<void> {
    const channel = this.channelForJid(jid);
    if (!channel) throw new Error(`No Telegram bot owns JID: ${jid}`);
    await channel.sendVoice(jid, text, options);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const channel = this.channelForJid(jid);
    if (!channel) return;
    await channel.setTyping(jid, isTyping);
  }

  async reactToMessage(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<boolean> {
    const channel = this.channelForJid(jid);
    if (!channel) return false;
    return channel.reactToMessage(jid, messageId, emoji);
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
