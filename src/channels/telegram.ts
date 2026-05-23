import fs from 'fs';
import os from 'os';
import https from 'https';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Api, Bot, InputFile } from 'grammy';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_RUNTIME,
  GROUPS_DIR,
  TIMEZONE,
  TRIGGER_PATTERN,
} from '../orchestrator/config.js';
import { readEnvFile } from '../orchestrator/env.js';
import { logger } from '../orchestrator/logger.js';
import { hashShort } from '../lib/log-sanitize.js';
import { getDb } from '../orchestrator/db.js';
import { recordTenantEvent } from '../orchestrator/event-store.js';
import { resolveGroupFolderPath } from '../orchestrator/group-folder.js';
import { memoryTopicForFolder } from '../orchestrator/memory-context.js';
import {
  appendMediaEntry,
  listMedia,
  setKeep,
  type MediaEntry,
  type MediaType,
} from '../media-manifest.js';
import {
  registerChannel,
  ChannelOpts,
} from '../orchestrator/channel-registry.js';
import {
  createTelegramSenderIdentity,
  loadOwnerAllowlistFromEnv,
  type TenantRecord,
} from '../orchestrator/tenant-registry.js';
import { formatQuotaStatusRu, getQuotaStatus } from '../orchestrator/quota.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  OnTelegramCallbackQuery,
  RegisteredGroup,
} from '../orchestrator/types.js';
import { transcribeTelegramVoice } from '../transcription-telegram.js';
import { downloadTelegramPhoto } from '../photo-telegram.js';
import { captionPhoto } from '../photo-caption.js';
import {
  pinLastMedia,
  storageForFolder,
  storageOverview,
} from '../admin-storage.js';
import { downloadTelegramAudio } from '../audio-telegram.js';
import {
  processTelegramVideoFile,
  processTelegramVideoNote,
} from '../video-telegram.js';
import {
  documentPlaceholder,
  processTelegramDocument,
  safeTelegramDocumentName,
} from '../document-telegram.js';
import { synthesizeVoice, ttsProvider, ttsVoiceName } from '../tts.js';

const execFileAsync = promisify(execFile);

const PUBLIC_BOT_COMMANDS = [
  { command: 'start', description: 'показать инструкцию' },
  { command: 'help', description: 'показать инструкцию' },
  { command: 'language', description: 'выбрать язык' },
  { command: 'limit', description: 'мой лимит' },
  { command: 'balance', description: 'мой лимит' },
  { command: 'chatid', description: 'показать ID этого чата' },
  { command: 'ping', description: 'проверить, что бот онлайн' },
];

const OWNER_BOT_COMMANDS = [
  ...PUBLIC_BOT_COMMANDS,
  { command: 'pending', description: 'заявки на доступ' },
  { command: 'users', description: 'список Telegram-пользователей' },
  { command: 'lastseen', description: 'последняя активность пользователей' },
  { command: 'health', description: 'состояние сервиса и очередей' },
  { command: 'status', description: 'подробный runtime status' },
  { command: 'selftest', description: 'запустить self-test' },
  { command: 'morningstatus', description: 'статус утреннего брифинга' },
  { command: 'morningon', description: 'включить утренний брифинг' },
  { command: 'morningoff', description: 'выключить утренний брифинг' },
  {
    command: 'storage',
    description: 'размер групп; /storage <folder> — детали',
  },
  { command: 'cleanup', description: '/cleanup dry — отчёт retention' },
  { command: 'keep', description: '/keep last — закрепить последнее медиа' },
  { command: 'limits', description: 'лимиты/статус пользователя' },
  { command: 'pause', description: 'временно остановить пользователя' },
  { command: 'resume', description: 'снять паузу/бан с пользователя' },
  { command: 'ban', description: 'заблокировать пользователя' },
];

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  tenantRegistry?: ChannelOpts['tenantRegistry'];
  ownerAllowlist?: ChannelOpts['ownerAllowlist'];
  onTelegramCallbackQuery?: OnTelegramCallbackQuery;
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
const APPROVAL_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;
const MEMORY_DELETE_CONFIRMATION_PHRASE = 'ПОДТВЕРЖДАЮ УДАЛИТЬ ПАМЯТЬ';
const MEMORY_DELETE_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const GUEST_RATE_WINDOW_MS = 10 * 60 * 1000;
const GUEST_DAILY_DEFER_MS = 24 * 60 * 60 * 1000;
const GUEST_PROBATION_MS = 24 * 60 * 60 * 1000;
const GUEST_NOTICE_COOLDOWN_MS = 10 * 60 * 1000;
const GUEST_ADMIN_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const NO_LIMIT = Number.POSITIVE_INFINITY;
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
const ADMIN_LABEL = 'администратор @Admanpro';

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
      logger.error(
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
      'Заявка отправлена администратору @Admanpro. Я напишу сюда, когда доступ будет подтверждён.',
    accessSaved:
      'Заявка сохранена, но я не смог уведомить администратора @Admanpro. Попробуйте позже.',
    denied: 'Администратор @Admanpro пока не подтвердил доступ к ассистенту.',
    statusConnected: 'Статус: подключён. Можно просто писать сюда.',
    statusUnregistered: (chatJid) =>
      `Статус: ещё не подключён. Отправьте администратору @Admanpro этот Chat ID: ${chatJid}`,
    onboarding: (status) => [
      `${ASSISTANT_NAME} — твой персональный AI-ассистент в Telegram.`,
      'Голосом, текстом, фото — на «ты», без бюрократии, с памятью на важное из ваших прошлых разговоров.',
      '',
      status,
      '',
      '› 🎙 Голосовые туда-обратно',
      '› 📸 Понимаю фото и скрины',
      '› 🧠 Помню важный контекст вашего диалога',
      '› 🙋 Если есть вопросы по доступу или настройкам, пишите администратору @Admanpro',
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
      'Өтінім әкімші @Admanpro-ға жіберілді. Қолжетімділік расталғанда осы жерге жазамын.',
    accessSaved:
      'Өтінім сақталды, бірақ әкімші @Admanpro-ға хабарлама жібере алмадым. Кейінірек қайталап көріңіз.',
    denied: 'Әкімші @Admanpro ассистентке қолжетімділікті әзірге растаған жоқ.',
    statusConnected: 'Күйі: қосылған. Осында жаза беріңіз.',
    statusUnregistered: (chatJid) =>
      `Күйі: әлі қосылмаған. Әкімші @Admanpro-ға осы Chat ID жіберіңіз: ${chatJid}`,
    onboarding: (status) => [
      `${ASSISTANT_NAME} — Telegram-дағы жеке AI-көмекшің.`,
      'Дауыс, мәтін, фото арқылы сөйлесемін, маңызды контексті есте сақтаймын.',
      '',
      status,
      '',
      '› 🎙 Дауыс хабарламаларын қабылдап, дауыспен жауап бере аламын',
      '› 📸 Фото мен скриндерді түсінемін',
      '› 🧠 Диалогтағы маңызды контексті есте сақтаймын',
      '› 🙋 Қолжетімділік немесе баптау бойынша сұрақ болса, @Admanpro әкімшісіне жазыңыз',
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
      'So‘rov administrator @Admanpro-ga yuborildi. Ruxsat tasdiqlanganda shu yerga yozaman.',
    accessSaved:
      'So‘rov saqlandi, lekin administrator @Admanpro-ga xabar yubora olmadim. Keyinroq urinib ko‘ring.',
    denied: 'Administrator @Admanpro hozircha assistentga ruxsat bermadi.',
    statusConnected: 'Holat: ulangan. Shu yerga yozishingiz mumkin.',
    statusUnregistered: (chatJid) =>
      `Holat: hali ulanmagan. Administrator @Admanpro-ga shu Chat ID ni yuboring: ${chatJid}`,
    onboarding: (status) => [
      `${ASSISTANT_NAME} — Telegram’dagi shaxsiy AI-assistentingiz.`,
      'Ovoz, matn va foto bilan ishlayman, muhim kontekstni eslab qolaman.',
      '',
      status,
      '',
      '› 🎙 Ovozli xabarlarni qabul qilaman va ovoz bilan javob bera olaman',
      '› 📸 Foto va skrinlarni tushunaman',
      '› 🧠 Suhbatdagi muhim kontekstni eslab qolaman',
      '› 🙋 Ruxsat yoki sozlamalar bo‘yicha savollar bo‘lsa, administrator @Admanpro-ga yozing',
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
      'Өтүнмө администратор @Admanpro-га жөнөтүлдү. Жеткилик ырасталганда ушул жерге жазам.',
    accessSaved:
      'Өтүнмө сакталды, бирок администратор @Admanpro-га билдире алган жокмун. Кийинчерээк аракет кылыңыз.',
    denied: 'Администратор @Admanpro азырынча ассистентке жеткилик берген жок.',
    statusConnected: 'Абалы: кошулган. Ушул жерге жаза бериңиз.',
    statusUnregistered: (chatJid) =>
      `Абалы: азырынча кошула элек. Администратор @Admanpro-га ушул Chat ID жөнөтүңүз: ${chatJid}`,
    onboarding: (status) => [
      `${ASSISTANT_NAME} — Telegramдагы жеке AI-жардамчыңыз.`,
      'Үн, текст жана фото менен иштейм, маанилүү контекстти эстеп калам.',
      '',
      status,
      '',
      '› 🎙 Үн билдирүүлөрүн кабыл алып, үн менен жооп бере алам',
      '› 📸 Фото жана скриндерди түшүнөм',
      '› 🧠 Диалогдогу маанилүү контекстти эстейм',
      '› 🙋 Жеткилик же жөндөөлөр боюнча суроолор болсо, администратор @Admanpro-га жазыңыз',
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
      'Your request was sent to administrator @Admanpro. I will message you here when access is approved.',
    accessSaved:
      'Your request was saved, but I could not notify administrator @Admanpro. Please try again later.',
    denied:
      'Administrator @Admanpro has not approved access to the assistant yet.',
    statusConnected: 'Status: connected. You can just write here.',
    statusUnregistered: (chatJid) =>
      `Status: not connected yet. Send this Chat ID to administrator @Admanpro: ${chatJid}`,
    onboarding: (status) => [
      `${ASSISTANT_NAME} is your personal AI assistant in Telegram.`,
      'Voice, text, photos, no bureaucracy, with memory for important context from your conversations.',
      '',
      status,
      '',
      '› 🎙 Voice messages both ways',
      '› 📸 Understands photos and screenshots',
      '› 🧠 Remembers important context from your conversation',
      '› 🙋 For access or settings questions, write to administrator @Admanpro',
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

  return copy.onboarding(status).join('\n');
}

function commandText(text: string): string {
  return text.length <= 3900 ? text : text.slice(0, 3800) + '\n...truncated';
}

function isTechnicalTelegramName(jid: string, name?: string | null): boolean {
  const value = (name || '').trim();
  return !value || value === jid || /^tg:\d+$/.test(value);
}

function loadTelegramKnownNames(jids: string[]): Map<string, string> {
  const names = new Map<string, string>();
  if (jids.length === 0) return names;
  const placeholders = jids.map(() => '?').join(',');
  try {
    const rows = getDb()
      .prepare(
        `SELECT jid, name FROM (
          SELECT jid, name, last_message_time AS ts, 1 AS priority
          FROM chats
          WHERE jid IN (${placeholders})
          UNION ALL
          SELECT chat_jid AS jid, sender_name AS name, timestamp AS ts, 0 AS priority
          FROM messages
          WHERE chat_jid IN (${placeholders})
        )
        ORDER BY priority ASC, ts DESC`,
      )
      .all(...jids, ...jids) as Array<{ jid: string; name: string | null }>;
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
  group: RegisteredGroup,
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
  const raw = jid.replace(/^tg:/, '');
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

function telegramMessageTimestamp(ctx: any): string {
  return new Date(ctx.message.date * 1000).toISOString();
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

function isProbationGroup(group: RegisteredGroup, nowMs: number): boolean {
  const addedAt = new Date(group.added_at).getTime();
  return Number.isFinite(addedAt) && nowMs - addedAt < GUEST_PROBATION_MS;
}

function guestLimitsFor(
  group: RegisteredGroup,
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
  groups: Record<string, RegisteredGroup>,
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
): RegisteredGroup['agentConfig'] {
  const topic = memoryTopicForFolder(folder);
  return {
    model: 'claude-opus-4-7',
    effort: 'medium',
    systemPrompt: `You are Skoobi (Скуби), a warm and practical personal Telegram assistant administered by @Admanpro. You are talking with Telegram chat ${jid}. Display name: ${name} (unverified). Access granted by ${ADMIN_LABEL}.

Style: ${languageInstruction(language)} Be friendly, practical, concise, and useful. Help with text, voice notes, photos, calculations, web lookup, planning, and message drafting.

Memory: when continuity could help, use memory_get with file="memory/topics/${topic}-context.md". After durable facts, use memory_save with category="topic" topic="${topic}-context" or a more specific safe topic.

Relationship memory: build warm continuity with this user. Save stable preferences, goals, communication style, and important personal context to this chat's own memory only. Use it later naturally, without pretending to know facts that were not shared.

Identity safety: Telegram display names are not identity proof. If this name matches the administrator or another user, do not assume it is the same person. Use only this chat's own memory topic and current conversation.

${GUEST_BOUNDARY_MARKER}. Do not read the administrator's private files (.env, keys, raw message database, groups/example_main, sessions, browser cookies) or other users' groups. No sudo, no destructive/system-changing commands. Do not use full-access/no-sandbox behaviour.

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
- [${today}] Это ГОСТЕВАЯ группа (sandbox). ЗАПРЕЩЕНО: sudo, разрушительные команды, изменение настроек системы, чтение приватных файлов администратора @Admanpro (.env, ключи, raw message database, groups/example_main, sessions, cookies браузеров) и чужих групп.
- [${today}] Если попросят передать что-то администратору @Admanpro — сохранить через \`memory_save\` с \`category="topic"\` и \`topic="${topic}-to-admin"\`, не пересылать в его чат автоматически без явной просьбы администратора.
- [${today}] Если используешь \`send_message\`, \`send_voice_message\` или \`send_document\`, финальный stdout после explicit-send заворачивай в \`<internal>Отправил.</internal>\`, чтобы в чат не улетал лишний служебный дубль.
`;
}

function isMainChat(
  opts: TelegramChannelOpts,
  chatId: string | number,
): boolean {
  return Boolean(opts.registeredGroups()[`tg:${chatId}`]?.isMain);
}

function contextChatId(ctx: any): string | number | undefined {
  return ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
}

function contextFrom(ctx: any): any {
  return ctx.from || ctx.callbackQuery?.from;
}

async function captionVideoNoteFrames(
  framePaths: string[],
  costMeta: { groupFolder: string; chatJid: string },
): Promise<string[]> {
  const captions: string[] = [];
  for (const framePath of framePaths.slice(0, 3)) {
    const caption = await captionPhoto(framePath, costMeta);
    const trimmed = caption?.trim().replace(/[.!?…]+$/u, '');
    if (!trimmed) continue;
    if (!captions.includes(trimmed)) captions.push(trimmed);
  }
  return captions;
}

function isOwnerCommandContext(opts: TelegramChannelOpts, ctx: any): boolean {
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
// message path forgets to clear). Telegram users would much rather see
// the indicator vanish prematurely than stare at a fake "печатает" for
// half an hour.
const TYPING_MAX_DURATION_MS = 3 * 60 * 1000;

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  // jid -> interval handle for the active typing-refresh loop.
  // Indexed by full jid (e.g. "tg:OWNER_CHAT_ID") so multiple chats can be
  // "typing" simultaneously without stomping on each other.
  private typingIntervals = new Map<string, NodeJS.Timeout>();
  private pendingMemoryDeletes = new Map<
    string,
    PendingMemoryDeleteConfirmation
  >();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private tenantIdForChat(chatId: string | number): string | undefined {
    return this.opts.tenantRegistry?.().resolveTelegramChat(String(chatId))
      ?.tenant_id;
  }

  private tenantForChat(chatId: string | number): TenantRecord | undefined {
    return this.opts.tenantRegistry?.().resolveTelegramChat(String(chatId));
  }

  private senderIdentityForContext(ctx: any, displayName: string) {
    return createTelegramSenderIdentity({
      chatId: ctx.chat.id,
      fromId: ctx.from?.id,
      usernameHint: ctx.from?.username,
      displayNameHint: displayName,
      ownerAllowlist:
        this.opts.ownerAllowlist?.() || loadOwnerAllowlistFromEnv(),
    });
  }

  private recordCallbackQuery(ctx: any, kind: string): void {
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
    if (chatId === undefined || chatId === null) return;

    const fromId = ctx.from?.id?.toString() || '';
    const displayName =
      ctx.from?.first_name || ctx.from?.username || fromId || 'Unknown';
    this.opts.onTelegramCallbackQuery?.({
      id: ctx.callbackQuery?.id || '',
      chat_jid: `tg:${chatId}`,
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
    tenant: TenantRecord,
    fromId: string,
    source: 'command' | 'callback',
  ): void {
    try {
      recordTenantEvent({
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
    tenant: TenantRecord,
    senderId: string,
    type:
      | 'memory_delete_requested'
      | 'memory_deleted'
      | 'memory_delete_unavailable',
    payload: Record<string, unknown>,
  ): void {
    try {
      recordTenantEvent({
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

  private collectTenantMemoryMarkdownFiles(memoryRoot: string): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'tombstones') continue;
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(full);
        }
      }
    };
    walk(memoryRoot);
    return files;
  }

  private tombstoneTenantMemory(
    tenant: TenantRecord,
    senderId: string,
  ): MemoryDeletionResult {
    const groupRoot = path.resolve(GROUPS_DIR, tenant.folder);
    const memoryRoot = path.join(groupRoot, 'memory');
    let groupReal: string;
    try {
      groupReal = fs.realpathSync(groupRoot);
    } catch {
      return {
        status: 'unavailable',
        deletedFiles: [],
        reason: 'tenant_group_folder_missing',
      };
    }
    const memoryReal = fs.existsSync(memoryRoot)
      ? fs.realpathSync(memoryRoot)
      : memoryRoot;
    const relMemory = path.relative(groupReal, path.resolve(memoryReal));
    if (
      relMemory.startsWith('..') ||
      path.isAbsolute(relMemory) ||
      (relMemory !== 'memory' && !relMemory.startsWith(`memory${path.sep}`))
    ) {
      return {
        status: 'unavailable',
        deletedFiles: [],
        reason: 'memory_path_rejected',
      };
    }

    const timestamp = new Date().toISOString();
    const stamp = timestamp.replace(/[:.]/g, '-');
    const tombstoneDir = path.join(memoryRoot, 'tombstones');
    fs.mkdirSync(tombstoneDir, { recursive: true });

    const deletedFiles: string[] = [];
    for (const file of this.collectTenantMemoryMarkdownFiles(memoryRoot)) {
      const rel = path.relative(memoryRoot, file).split(path.sep).join('/');
      let target = `${file}.deleted-${stamp}.tombstone`;
      let suffix = 1;
      while (fs.existsSync(target)) {
        target = `${file}.deleted-${stamp}.${suffix}.tombstone`;
        suffix += 1;
      }
      fs.renameSync(file, target);
      deletedFiles.push(rel);
    }

    const tombstoneRel = `tombstones/memory-delete-${stamp}.json`;
    const tombstonePath = path.join(memoryRoot, tombstoneRel);
    fs.writeFileSync(
      tombstonePath,
      `${JSON.stringify(
        {
          tenant_id: tenant.tenant_id,
          chat_id: tenant.chat_id,
          folder: tenant.folder,
          sender_id: senderId,
          deleted_files: deletedFiles,
          created_at: timestamp,
          note: 'Tenant memory markdown files were renamed to non-markdown tombstones. Audit/accounting/message tables were not deleted.',
        },
        null,
        2,
      )}\n`,
    );

    return {
      status: 'deleted',
      deletedFiles,
      tombstoneFile: tombstoneRel,
    };
  }

  private async handleMemoryPrivacyTextIntent(
    ctx: any,
    text: string,
  ): Promise<boolean> {
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id?.toString();
    if (chatId === undefined || chatId === null || !fromId) return false;

    const tenant = this.tenantForChat(chatId);
    if (!tenant) return false;

    const key = this.memoryDeleteKey(tenant.tenant_id, fromId);
    const pending = this.pendingMemoryDeletes.get(key);
    const now = Date.now();

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
    await ctx.answerCallbackQuery(payload);
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
      replySafely(ctx, 'Не смог определить пользователя для лимита.');
      return;
    }

    const tenant = this.tenantForChat(chatId);
    if (!tenant) {
      await this.answerCallbackQueryIfPresent(
        ctx,
        'Лимит доступен после подключения чата.',
      );
      replySafely(ctx, 'Лимит доступен после подключения этого чата к Скуби.');
      return;
    }

    let text: string;
    try {
      text = formatQuotaStatusRu(
        getQuotaStatus({
          tenantId: tenant.tenant_id,
          channel: tenant.channel,
          channelUserId: fromId,
        }),
      );
      this.recordQuotaBalanceViewed(tenant, fromId, source);
    } catch (err) {
      logger.error({ err }, 'Telegram quota status command failed');
      await this.answerCallbackQueryIfPresent(
        ctx,
        'Не смог посчитать лимит. См. логи.',
      );
      replySafely(ctx, 'Не смог посчитать лимит. См. логи.');
      return;
    }

    const chatType = ctx.chat?.type || ctx.callbackQuery?.message?.chat?.type;
    if (chatType === 'private') {
      await this.answerCallbackQueryIfPresent(ctx, 'Показываю твой лимит.');
      replySafely(ctx, text);
      return;
    }

    try {
      const numericFromId = Number(fromId);
      const privateChatId = Number.isSafeInteger(numericFromId)
        ? numericFromId
        : fromId;
      await this.bot?.api.sendMessage(privateChatId, text);
      await this.answerCallbackQueryIfPresent(ctx, 'Отправил лимит в личку.');
      replySafely(ctx, 'Отправил твой лимит в личку.');
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
        'Я могу показать лимит только лично. Открой чат с ботом и отправь /limit.',
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
    if (!this.bot) return;
    for (const [jid, group] of Object.entries(this.opts.registeredGroups())) {
      if (!group.isMain || !jid.startsWith('tg:')) continue;
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
    | { jid: string; group?: RegisteredGroup; pending?: PendingTelegramUser }
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

  private accessSummary(jid: string, group?: RegisteredGroup): string {
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
    group: RegisteredGroup,
    kind: TelegramInboundKind,
    details: Partial<TelegramInboxEntry> = {},
  ): void {
    const chatJid = `tg:${ctx.chat.id}`;
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
    group: RegisteredGroup,
    kind: 'text' | 'media',
  ): InboundAccessDecision {
    if (group.isMain) return { accept: true, processNow: true };

    const chatJid = `tg:${ctx.chat.id}`;
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
      for (const [jid, group] of Object.entries(this.opts.registeredGroups())) {
        if (!group.isMain || !jid.startsWith('tg:')) continue;
        const rawChatId = jid.replace(/^tg:/, '');
        const numericChatId = Number(rawChatId);
        await this.bot.api.setMyCommands(OWNER_BOT_COMMANDS, {
          scope: {
            type: 'chat',
            chat_id: Number.isSafeInteger(numericChatId)
              ? numericChatId
              : rawChatId,
          },
        });
        logger.info({ jid }, 'Telegram owner command menu published');
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
    const jid = `tg:${ctx.chat.id}`;
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
    if (!this.bot) return 0;
    let sent = 0;
    for (const [jid, group] of Object.entries(this.opts.registeredGroups())) {
      if (!group.isMain || !jid.startsWith('tg:')) continue;
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
        logger.error(
          { err, ownerJid: jid, applicantJid: user.jid },
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
        (ctx.chat?.id ? telegramUserLanguage(`tg:${ctx.chat.id}`) : undefined),
    );
    if (ctx.from?.is_bot === true) {
      logger.warn(
        { jid: `tg:${ctx.chat.id}`, username: ctx.from?.username },
        'Ignoring Telegram bot access request',
      );
      replySafely(ctx, TELEGRAM_LANGUAGES[initialLanguage].botBlocked);
      return;
    }

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
      notified > 0 || !shouldNotify
        ? TELEGRAM_LANGUAGES[effectiveLanguage].accessSent
        : TELEGRAM_LANGUAGES[effectiveLanguage].accessSaved,
    );
  }

  private createGuestProfile(user: PendingTelegramUser): RegisteredGroup {
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
      agentConfig: guestAgentConfig(user.name, user.jid, folder, language),
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
      await ctx.answerCallbackQuery?.(
        'Только владелец может подтверждать заявки.',
      );
      return;
    }

    const action = match[1] as 'approve' | 'deny';
    const jid = `tg:${match[2].replace(/^tg:/, '')}`;
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
        await ctx.answerCallbackQuery?.('Пользователь уже активирован.');
        if (ctx.editMessageText) {
          const text = user
            ? `Активировано ранее:\n\n${pendingUserText(user)}${folder ? `\nПапка: ${folder}` : ''}`
            : `Активировано ранее:\n\nJID: ${jid}${folder ? `\nПапка: ${folder}` : ''}`;
          await ctx.editMessageText(text).catch(() => undefined);
        }
        return;
      }
      if (action === 'deny' && user?.status === 'denied') {
        await ctx.answerCallbackQuery?.('Заявка уже отклонена.');
        if (ctx.editMessageText) {
          await ctx
            .editMessageText(`Отклонено ранее:\n\n${pendingUserText(user)}`)
            .catch(() => undefined);
        }
        return;
      }
      await ctx.answerCallbackQuery?.('Заявка не найдена или уже обработана.');
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
      await ctx.answerCallbackQuery?.('Bot-аккаунты не активируются.');
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
      await ctx.answerCallbackQuery?.('Заявка отклонена.');
      if (ctx.editMessageText) {
        await ctx
          .editMessageText(`Отклонено:\n\n${pendingUserText(user)}`)
          .catch(() => undefined);
      }
      await this.bot?.api.sendMessage(
        telegramChatId(jid),
        TELEGRAM_LANGUAGES[language].denied,
      );
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

    await ctx.answerCallbackQuery?.('Пользователь активирован.');
    if (ctx.editMessageText) {
      await ctx
        .editMessageText(
          `Активировано:\n\n${pendingUserText({ ...user, language })}\nПапка: ${group.folder}`,
        )
        .catch(() => undefined);
    }
    await this.bot?.api.sendMessage(
      telegramChatId(jid),
      onboardingText(jid, true, language),
    );
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
      await ctx.answerCallbackQuery?.('Не смог определить чат.');
      return;
    }
    const from = ctx.from || ctx.callbackQuery?.from;

    const accessCtx = {
      ...ctx,
      from,
      chat: {
        ...chat,
        type: chat.type || 'private',
      },
      reply:
        ctx.reply ||
        ((text: string, options: Record<string, any> = {}) =>
          this.bot?.api.sendMessage(
            telegramChatId(`tg:${chat.id}`),
            text,
            options,
          )),
    };
    const chatJid = `tg:${accessCtx.chat.id}`;
    setTelegramUserLanguage(chatJid, language);
    await ctx.answerCallbackQuery?.(TELEGRAM_LANGUAGES[language].chosen);
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
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      replySafely(
        ctx,
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    const sendOnboarding = (ctx: any) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const isRegistered = Boolean(this.opts.registeredGroups()[chatJid]);
      replySafely(
        ctx,
        onboardingText(chatJid, isRegistered, telegramUserLanguage(chatJid)),
      );
    };
    this.bot.command('start', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      if (ctx.from?.is_bot === true) {
        replySafely(
          ctx,
          TELEGRAM_LANGUAGES[telegramUserLanguage(chatJid)].botBlocked,
        );
        return;
      }
      if (this.opts.registeredGroups()[chatJid]) {
        sendOnboarding(ctx);
        return;
      }
      if (ctx.chat.type === 'private') {
        replySafely(ctx, languageChoiceText(), {
          reply_markup: languageKeyboard(),
        });
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
    const sendLimit = async (ctx: any) => {
      await this.sendQuotaStatus(ctx, 'command');
    };
    this.bot.command('limit', sendLimit);
    this.bot.command('balance', sendLimit);

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      replySafely(ctx, `${ASSISTANT_NAME} is online.`);
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
      const knownNames = loadTelegramKnownNames(entries.map(([jid]) => jid));
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
      const knownNames = loadTelegramKnownNames(entries.map(([jid]) => jid));
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
          const placeholders = rows.map(() => '?').join(',');
          const dbRows = getDb()
            .prepare(
              `SELECT jid, last_message_time FROM chats WHERE jid IN (${placeholders})`,
            )
            .all(...rows.map((row) => row.jid)) as Array<{
            jid: string;
            last_message_time: string | null;
          }>;
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
        const row = getDb()
          .prepare(
            `SELECT COUNT(*) AS c FROM messages WHERE date(timestamp) = date('now', 'localtime')`,
          )
          .get() as { c: number } | undefined;
        msgsToday = row?.c ?? 0;
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
        const row = getDb()
          .prepare(
            `SELECT COUNT(*) AS c FROM messages WHERE date(timestamp) = date('now', 'localtime')`,
          )
          .get() as { c: number } | undefined;
        msgsToday = row?.c ?? 0;
      } catch {
        msgsToday = -1;
      }

      const lines = [
        `*${ASSISTANT_NAME} status*`,
        `Runtime: \`${DEFAULT_RUNTIME}\``,
        `Node: \`${process.version}\` (${process.execPath})`,
        `LLM: agent SDK default (Opus 4.7)`,
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

    // Safe all-up health check. This does not restart services, send voice, or
    // mutate persistent state except for one temporary memory add/forget smoke.
    this.bot.command('selftest', async (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      replySafely(ctx, 'Self-test started. I will post the report shortly.');
      try {
        const { stdout, stderr } = await execFileAsync(
          'bash',
          ['scripts/selftest.sh'],
          {
            cwd: process.cwd(),
            timeout: 60_000,
            maxBuffer: 64 * 1024,
            env: {
              ...process.env,
              PATH: [
                path.dirname(process.execPath),
                '/opt/homebrew/bin',
                '/usr/local/bin',
                '/usr/bin',
                '/bin',
                process.env.PATH || '',
              ]
                .filter(Boolean)
                .join(':'),
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

    this.bot.command('morningstatus', (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      const env = readEnvFile(['MORNING_BRIEF', 'BRIEF_CHAT_ID']);
      const groupDir = './groups/example_main';
      const flagPath = `${groupDir}/morning-brief.enabled`;
      const envToggle = process.env.MORNING_BRIEF || env.MORNING_BRIEF || '';
      let fileToggle = '';
      try {
        fileToggle = fs.readFileSync(flagPath, 'utf-8').trim();
      } catch {
        fileToggle = '';
      }
      const effective = envToggle || fileToggle || 'on';
      const chatId = process.env.BRIEF_CHAT_ID || env.BRIEF_CHAT_ID || '0';
      let lastLog = 'n/a';
      try {
        const logLines = fs
          .readFileSync('./logs/morning-brief.log', 'utf-8')
          .trim()
          .split('\n')
          .filter(Boolean);
        lastLog = logLines.at(-1) || 'n/a';
      } catch {
        lastLog = 'n/a';
      }
      replySafely(
        ctx,
        [
          'Morning brief status',
          `Enabled: ${effective === 'on' ? 'yes' : 'no'} (${envToggle ? 'env' : fileToggle ? 'file' : 'default'})`,
          'Schedule: 08:00 daily',
          `Chat: tg:${chatId}`,
          `Last log: ${lastLog.slice(0, 180)}`,
        ].join('\n'),
      );
    });

    // Toggle morning briefing on/off (writes a flag file the cron script reads)
    const setMorningBrief = (state: 'on' | 'off') => {
      const groupDir = './groups/example_main';
      const flagPath = `${groupDir}/morning-brief.enabled`;
      try {
        fs.mkdirSync(groupDir, { recursive: true });
        fs.writeFileSync(flagPath, state + '\n');
        return true;
      } catch (err) {
        logger.error({ err }, 'Failed to write morning-brief flag');
        return false;
      }
    };
    this.bot.command('morningon', (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      replySafely(
        ctx,
        setMorningBrief('on')
          ? 'Утренний брифинг включён (08:00 ежедневно).'
          : 'Не получилось записать флаг. См. логи.',
      );
    });
    this.bot.command('morningoff', (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      replySafely(
        ctx,
        setMorningBrief('off')
          ? 'Утренний брифинг отключён.'
          : 'Не получилось записать флаг. См. логи.',
      );
    });

    // ─── Tier 1 admin commands (owner-only) ────────────────────────────────
    // /storage           — total size per group + top-3 media types
    // /storage <folder>  — detail: counts per type, total size, oldest mtime
    // /cleanup dry       — spawn retention.ts --dry, report aggregate output
    // /keep last         — pin the latest media entry of the current group
    this.bot.command('storage', async (ctx) => {
      if (!requireMainChat(this.opts, ctx)) return;
      const arg = (ctx.match || '').trim();
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
        const script = path.join(
          process.cwd(),
          'dist',
          'scripts',
          'retention.js',
        );
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
      const chatJid = `tg:${ctx.chat.id}`;
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
        await ctx.answerCallbackQuery?.('Не смог обработать заявку. См. логи.');
      }
    });

    this.bot.callbackQuery(LANGUAGE_CALLBACK_RE, async (ctx) => {
      this.recordCallbackQuery(ctx, 'language_selection');
      try {
        await this.handleLanguageCallback(ctx);
      } catch (err) {
        logger.error({ err }, 'Telegram language callback failed');
        await ctx.answerCallbackQuery?.('Не смог выбрать язык. См. логи.');
      }
    });

    this.bot.callbackQuery(QUOTA_CALLBACK_RE, async (ctx) => {
      this.recordCallbackQuery(ctx, 'quota_my_limit');
      try {
        await this.sendQuotaStatus(ctx, 'callback');
      } catch (err) {
        logger.error({ err }, 'Telegram quota callback failed');
        await ctx.answerCallbackQuery?.('Не смог показать лимит. См. логи.');
      }
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const senderIdentity = this.senderIdentityForContext(ctx, senderName);
      const tenantId = this.tenantIdForChat(ctx.chat.id);
      const msgId = ctx.message.message_id.toString();

      if (await this.handleQuotaTextIntent(ctx, content)) return;
      if (await this.handleMemoryPrivacyTextIntent(ctx, content)) return;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

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
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
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
          chat_jid: `tg:${ctx.chat.id}`,
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
      const chatJid = `tg:${ctx.chat.id}`;
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
      const chatJid = `tg:${ctx.chat.id}`;
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
          visionCaption = await captionPhoto(savedPath, {
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
      const chatJid = `tg:${ctx.chat.id}`;
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
          ? await captionVideoNoteFrames(result.framePaths, {
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
      const savedMedia = [result.videoPath, ...result.framePaths].filter(
        (savedPath): savedPath is string => Boolean(savedPath),
      );
      for (const savedPath of savedMedia) {
        await recordMedia(ctx, group.folder, savedPath, 'video', {
          hasTranscript: !!result.transcript,
          transcriptChars: result.transcript ? result.transcript.length : 0,
        });
      }
    });
    this.bot.on('message:video_note', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
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
          ? await captionVideoNoteFrames(result.framePaths, {
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
      const chatJid = `tg:${ctx.chat.id}`;
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

      const [transcriptResult, savedPath] = await Promise.all([
        transcribeTelegramVoice(this.botToken, fileId).catch(() => null),
        downloadTelegramAudio(this.botToken, fileId, group.folder, 'voice'),
      ]);

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
      const chatJid = `tg:${ctx.chat.id}`;
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

      const [transcriptResult, savedPath] = await Promise.all([
        transcribeTelegramVoice(this.botToken, fileId, 'auto').catch(
          () => null,
        ),
        downloadTelegramAudio(this.botToken, fileId, group.folder, 'audio'),
      ]);

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
      const chatJid = `tg:${ctx.chat.id}`;
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

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
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
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      throw new Error('Telegram bot not initialized');
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
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
    const numericId = jid.replace(/^tg:/, '');
    // Telegram caption limit is 1024 chars — truncate if needed
    const safeCaption =
      caption && caption.length > 1024
        ? caption.slice(0, 1021) + '...'
        : caption;
    await this.bot.api.sendPhoto(numericId, new InputFile(filePath), {
      caption: safeCaption,
    });
    logger.info(
      {
        jid,
        fileBasename: path.basename(filePath),
        bytes: fs.statSync(filePath).size,
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
    const numericId = jid.replace(/^tg:/, '');
    const safeCaption =
      caption && caption.length > 1024
        ? caption.slice(0, 1021) + '...'
        : caption;
    await this.bot.api.sendDocument(numericId, new InputFile(filePath), {
      caption: safeCaption,
    });
    logger.info(
      {
        jid,
        fileBasename: path.basename(filePath),
        bytes: fs.statSync(filePath).size,
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
    const numericId = jid.replace(/^tg:/, '');
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
    return jid.startsWith('tg:');
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
    const numericId = jid.replace(/^tg:/, '');

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

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
