import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('@skoobi/shared/env', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock channel config (пакетная реплика core-config, волна 7c)
vi.mock('./channel-config.js', () => ({
  ASSISTANT_NAME: 'skoobi_bot',
  DATA_DIR: '/tmp/claudeclaw-telegram-test-data',
  DEFAULT_RUNTIME: 'sandbox',
  GROUPS_DIR: '/tmp/claudeclaw-telegram-test-groups',
  TIMEZONE: 'Asia/Almaty',
  TRIGGER_PATTERN: /^@skoobi_bot(?![\p{L}\p{M}\p{N}_-])/iu,
}));

// group-folder живёт в @skoobi/shared (волна 7a) и выводит GROUPS_DIR из
// process.cwd(), а не из config — мокаем на ту же тестовую базу, что и
// channel-config выше.
vi.mock('@skoobi/shared/group-folder', () => ({
  isValidGroupFolder: (folder: string) =>
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(folder),
  assertValidGroupFolder: () => {},
  resolveGroupFolderPath: (folder: string) =>
    `/tmp/claudeclaw-telegram-test-groups/${folder}`,
  resolveGroupIpcPath: (folder: string) =>
    `/tmp/claudeclaw-telegram-test-data/ipc/${folder}`,
}));

// Mock logger
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@skoobi/shared/logger', () => ({
  logger: loggerMock,
}));

const execFileMock = vi.hoisted(() =>
  vi.fn((file: string, args: any, options: any, callback?: any) => {
    const cb = typeof options === 'function' ? options : callback;
    cb?.(null, '', '');
    return {} as any;
  }),
);

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: execFileMock,
}));

// Host-фейки: с волны 7c канал получает БД-чтения/события/квоту/приватный
// админ-режим/подпись фото через инжектируемый TelegramChannelHost, а не через
// импорты ядра — тесты собирают host из этих же hoisted-моков (testHost()).
const hostDbMock = vi.hoisted(() => ({
  knownChatNames: vi.fn(
    () => [] as Array<{ jid: string; name: string | null }>,
  ),
  statsUsersToday: vi.fn(),
  statsTotalsToday: vi.fn(),
  chatsLastSeen: vi.fn(),
  messagesToday: vi.fn(() => 0),
}));

const eventStoreMock = vi.hoisted(() => ({
  recordTenantEvent: vi.fn(),
}));

const quotaMock = vi.hoisted(() => ({
  getQuotaStatus: vi.fn(),
  formatQuotaStatusRu: vi.fn(),
}));

const captionPhotoMock = vi.hoisted(() => vi.fn());

vi.mock('./video-telegram.js', () => ({
  processTelegramVideoFile: vi.fn(),
  processTelegramVideoNote: vi.fn(),
}));

vi.mock('./photo-telegram.js', () => ({
  downloadTelegramPhoto: vi.fn(),
}));

vi.mock('./audio-telegram.js', () => ({
  downloadTelegramAudio: vi.fn(),
}));

vi.mock('@skoobi/voice-stt', () => ({
  transcribeAudioFile: vi.fn(),
}));

vi.mock('./document-telegram.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./document-telegram.js')>();
  return {
    ...actual,
    processTelegramDocument: vi.fn(),
  };
});

const adminStorageMock = vi.hoisted(() => ({
  pinLastMedia: vi.fn(),
  storageForFolder: vi.fn(),
  storageOverview: vi.fn(),
}));
vi.mock('./admin-storage.js', () => adminStorageMock);

// --- Grammy mock ---

type Handler = (...args: any[]) => any;

const botRef = vi.hoisted(() => ({ current: null as any }));
// When set, the mock bot.start() rejects (modeling grammy startup failure such
// as a revoked token / 401) instead of invoking onStart. Reset in beforeEach.
// postStartError models a fatal polling error that grammy rethrows AFTER
// onStart has already fired (e.g. a 409 Conflict or 401 mid-flight): onStart
// runs, connect() resolves, then start()'s promise rejects (finding #18).
const botControl = vi.hoisted(() => ({
  startError: null as any,
  postStartError: null as any,
}));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    callbackQueryHandlers: Array<{ trigger: any; handler: Handler }> = [];
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      setMyCommands: vi.fn().mockResolvedValue(true),
    };

    constructor(token: string) {
      this.token = token;
      botRef.current = this;
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    callbackQuery(trigger: any, handler: Handler) {
      this.callbackQueryHandlers.push({ trigger, handler });
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    start(opts: { onStart: (botInfo: any) => void }) {
      if (botControl.startError) {
        // grammy's start() rejects when startup fails before onStart fires.
        return Promise.reject(botControl.startError);
      }
      opts.onStart({ username: 'skoobi_bot', id: 12345 });
      if (botControl.postStartError) {
        // grammy rethrows a fatal polling error (409 Conflict, 401) AFTER
        // onStart fired; the long-poll loop is then permanently dead.
        return Promise.reject(botControl.postStartError);
      }
      // grammy's start() resolves only when the bot stops; model that as a
      // promise that stays pending for the lifetime of the connection.
      return new Promise<void>(() => {});
    }

    stop() {}
  },
  InputFile: class MockInputFile {
    path: string;

    constructor(path: string) {
      this.path = path;
    }
  },
}));

import {
  readSkoobiEngineRuntimeStatus,
  retentionScriptPath,
  TelegramChannel,
  TelegramChannelOpts,
  telegramMessageTimestamp,
} from './telegram.js';
import {
  processTelegramVideoFile,
  processTelegramVideoNote,
} from './video-telegram.js';
import { processTelegramDocument } from './document-telegram.js';
import { downloadTelegramPhoto } from './photo-telegram.js';
import { downloadTelegramAudio } from './audio-telegram.js';
import { transcribeAudioFile } from '@skoobi/voice-stt';

describe('retentionScriptPath', () => {
  it('resolves the root retention script from a built Telegram package', () => {
    expect(
      retentionScriptPath(
        'file:///opt/skoobi/app/packages/channel-telegram/dist/telegram.js',
      ),
    ).toBe('/opt/skoobi/app/dist/scripts/retention.js');
  });
});

describe('telegramMessageTimestamp', () => {
  it('keeps same-second Telegram messages strictly ordered by message id', () => {
    const first = telegramMessageTimestamp({
      message: { date: 1_784_000_000, message_id: 41 },
    });
    const second = telegramMessageTimestamp({
      message: { date: 1_784_000_000, message_id: 42 },
    });

    expect(first).toBe('2026-07-14T03:33:20.500000000000041Z');
    expect(second).toBe('2026-07-14T03:33:20.500000000000042Z');
    expect(second > first).toBe(true);
    expect(new Date(first).getTime()).toBe(1_784_000_000_500);
  });
});

// --- Test helpers ---

function testHost() {
  return {
    knownChatNames: hostDbMock.knownChatNames,
    statsUsersToday: hostDbMock.statsUsersToday,
    statsTotalsToday: hostDbMock.statsTotalsToday,
    chatsLastSeen: hostDbMock.chatsLastSeen,
    messagesToday: hostDbMock.messagesToday,
    recordTenantEvent: eventStoreMock.recordTenantEvent,
    quotaStatusTextRu: (input: {
      tenantId: string;
      channel: 'telegram';
      channelUserId: string;
    }) => quotaMock.formatQuotaStatusRu(quotaMock.getQuotaStatus(input)),
    // Env-зависимые фейки повторяют семантику core private-admin: тесты
    // включают режим через SKOOBI_PRIVATE_ADMIN_MODE, доступ — по
    // owner-allowlist + SKOOBI_PRIVATE_ADMIN_TELEGRAM_USER_IDS.
    privateAdminModeEnabled: () =>
      /^(1|true|yes|on)$/i.test(process.env.SKOOBI_PRIVATE_ADMIN_MODE || ''),
    isPrivateAdminTelegramUser: ({
      telegramUserId,
      ownerAllowlist,
    }: {
      telegramUserId?: string | number | null;
      ownerAllowlist?: { telegram_user_ids: Set<string> };
    }) =>
      Boolean(
        ownerAllowlist?.telegram_user_ids.has(String(telegramUserId ?? '')),
      ) ||
      (process.env.SKOOBI_PRIVATE_ADMIN_TELEGRAM_USER_IDS || '')
        .split(/[,\s]+/)
        .filter(Boolean)
        .includes(String(telegramUserId ?? '')),
    privateAdminClosedBotText: () => 'Это закрытый private/admin бот.',
    captionPhoto: captionPhotoMock,
  };
}

function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@skoobi_bot',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    host: testHost(),
    ...overrides,
  };
}

function createAdminOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return createTestOpts({
    registeredGroups: vi.fn(() => ({
      'tg:100200300': {
        name: 'Admin',
        folder: 'telegram_main',
        trigger: '@skoobi_bot',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
        runtime: 'sandbox' as const,
      },
      'tg:555': {
        name: 'Guest',
        folder: 'telegram_guest',
        trigger: '@skoobi_bot',
        added_at: '2024-01-02T00:00:00.000Z',
        runtime: 'sandbox' as const,
      },
    })),
    ...overrides,
  });
}

function createTextCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  text: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: any[];
  forwardOrigin?: Record<string, any>;
  isAutomaticForward?: boolean;
  viaBot?: Record<string, any>;
  updateId?: number;
  // When true, mark the message as a reply to one of the bot's own messages
  // (the addressing signal used in groups). 12345 matches the mock bot id.
  replyToBot?: boolean;
}) {
  const chatId = overrides.chatId ?? 100200300;
  const chatType = overrides.chatType ?? 'group';
  return {
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      text: overrides.text,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      entities: overrides.entities ?? [],
      ...(overrides.forwardOrigin
        ? { forward_origin: overrides.forwardOrigin }
        : {}),
      ...(overrides.isAutomaticForward ? { is_automatic_forward: true } : {}),
      ...(overrides.viaBot ? { via_bot: overrides.viaBot } : {}),
      ...(overrides.replyToBot
        ? {
            reply_to_message: {
              from: { id: 12345, is_bot: true, username: 'skoobi_bot' },
            },
          }
        : {}),
    },
    ...(overrides.updateId !== undefined
      ? { update: { update_id: overrides.updateId } }
      : {}),
    me: { username: 'skoobi_bot', id: 12345 },
    reply: vi.fn(),
  };
}

function createMediaCtx(overrides: {
  chatId?: number;
  chatType?: string;
  fromId?: number;
  firstName?: string;
  date?: number;
  messageId?: number;
  caption?: string;
  extra?: Record<string, any>;
}) {
  const chatId = overrides.chatId ?? 100200300;
  return {
    chat: {
      id: chatId,
      type: overrides.chatType ?? 'group',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice_user',
    },
    message: {
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption,
      ...(overrides.extra || {}),
    },
    me: { username: 'skoobi_bot' },
  };
}

function currentBot() {
  return botRef.current;
}

// Flush several microtask turns so deferred .then/.catch chains (e.g. the
// post-onStart start()-rejection handler) settle before assertions run.
async function flushMicrotasks(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

async function triggerTextMessage(ctx: ReturnType<typeof createTextCtx>) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

async function triggerMediaMessage(
  filter: string,
  ctx: ReturnType<typeof createMediaCtx>,
) {
  const handlers = currentBot().filterHandlers.get(filter) || [];
  for (const h of handlers) await h(ctx);
}

async function triggerCallbackQuery(data: string, ctxOverrides: any = {}) {
  return triggerCallbackQueryOn(currentBot(), data, ctxOverrides);
}

async function triggerCallbackQueryOn(
  bot: any,
  data: string,
  ctxOverrides: any = {},
) {
  const handlers = bot.callbackQueryHandlers || [];
  const ctx = {
    chat: { id: 100200300, type: 'private' as const },
    from: { id: 100200300 },
    callbackQuery: { data, id: 'callback-1' },
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessageText: vi.fn().mockResolvedValue(true),
    reply: vi.fn().mockResolvedValue(undefined),
    ...ctxOverrides,
  };
  for (const { trigger, handler } of handlers) {
    if (
      (typeof trigger === 'string' && trigger === data) ||
      (trigger instanceof RegExp && trigger.test(data))
    ) {
      await handler(ctx);
    }
  }
  return ctx;
}

async function requestAccessForUser(
  overrides: {
    chatId?: number;
    firstName?: string;
    lastName?: string;
    username?: string;
    language?: 'ru' | 'kk' | 'uz' | 'ky' | 'en';
  } = {},
) {
  const chatId = overrides.chatId ?? 777;
  const from = {
    id: chatId,
    first_name: overrides.firstName ?? 'New',
    last_name: overrides.lastName,
    username: overrides.username ?? 'new_user',
  };
  const startCtx = {
    chat: { id: chatId, type: 'private' as const },
    from,
    reply: vi.fn(),
  };
  const startHandler = currentBot().commandHandlers.get('start')!;
  await startHandler(startCtx);
  const languageCtx = await triggerCallbackQuery(
    `tglang:${overrides.language ?? 'ru'}`,
    {
      chat: { id: chatId, type: 'private' as const },
      from,
      reply: vi.fn().mockResolvedValue(undefined),
    },
  );
  return { startCtx, languageCtx };
}

// --- Tests ---

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    botControl.startError = null;
    botControl.postStartError = null;
    delete process.env.SKOOBI_TELEGRAM_ADMIN_ALERT_JIDS;
    delete process.env.SKOOBI_TELEGRAM_COMMAND_ADMIN_IDS;
    delete process.env.SKOOBI_PRIVATE_ADMIN_MODE;
    delete process.env.SKOOBI_PRIVATE_ADMIN_TELEGRAM_USER_IDS;
    delete process.env.OWNER_TELEGRAM_USER_IDS;
    delete process.env.OWNER_TELEGRAM_CHAT_IDS;
    delete process.env.SKOOBI_MODEL_GATEWAY_TYPE;
    delete process.env.SKOOBI_CODEX_SUBSCRIPTION_ENABLED;
    delete process.env.SKOOBI_CODEX_MODEL;
    delete process.env.SKOOBI_CODEX_FALLBACK_MODEL;
    delete process.env.SKOOBI_CODEX_ALLOW_MODEL_DOWNGRADE;
    delete process.env.SKOOBI_CODEX_REASONING_EFFORT;
    delete process.env.SKOOBI_QUOTA_DEGRADED_MODEL;
    delete process.env.SKOOBI_SANDBOX_CODEX_PRIMARY;
    delete process.env.SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED;
    delete process.env.SKOOBI_TELEGRAM_OWNER_LIVE_ENABLED;
    delete process.env.SKOOBI_CODEX_OWNER_FULL_AGENT_ENABLED;
    delete process.env.SKOOBI_CLAUDE_FALLBACK_ENABLED;
    execFileMock.mockImplementation(
      (file: string, args: any, options: any, callback?: any) => {
        const cb = typeof options === 'function' ? options : callback;
        cb?.(null, '', '');
        return {} as any;
      },
    );
    fs.rmSync('/tmp/claudeclaw-telegram-test-data', {
      recursive: true,
      force: true,
    });
    fs.rmSync('/tmp/claudeclaw-telegram-test-groups', {
      recursive: true,
      force: true,
    });
    hostDbMock.knownChatNames.mockImplementation(() => []);
    hostDbMock.statsUsersToday.mockImplementation(() => []);
    hostDbMock.statsTotalsToday.mockImplementation(() => undefined);
    hostDbMock.chatsLastSeen.mockImplementation(() => []);
    hostDbMock.messagesToday.mockImplementation(() => 0);
    eventStoreMock.recordTenantEvent.mockReturnValue({ event_id: 'event-1' });
    quotaMock.getQuotaStatus.mockReturnValue({});
    quotaMock.formatQuotaStatusRu.mockReturnValue('quota status text');
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.SKOOBI_TELEGRAM_COMMAND_ADMIN_IDS;
    delete process.env.SKOOBI_PRIVATE_ADMIN_MODE;
    delete process.env.SKOOBI_PRIVATE_ADMIN_TELEGRAM_USER_IDS;
    delete process.env.OWNER_TELEGRAM_USER_IDS;
    delete process.env.OWNER_TELEGRAM_CHAT_IDS;
    fs.rmSync('/tmp/claudeclaw-telegram-test-data', {
      recursive: true,
      force: true,
    });
    fs.rmSync('/tmp/claudeclaw-telegram-test-groups', {
      recursive: true,
      force: true,
    });
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when bot starts', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('rejects connect() when bot.start() fails before onStart (e.g. bad token)', async () => {
      // grammy's start() rejects on startup failure (revoked/malformed token,
      // 401, network) before onStart fires. connect() must reject fast instead
      // of hanging until the orchestrator's 30s timeout.
      botControl.startError = new Error('401: Unauthorized');
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await expect(channel.connect()).rejects.toThrow('401: Unauthorized');
      expect(channel.isConnected()).toBe(false);
      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.objectContaining({ message: '401: Unauthorized' }),
        }),
        'Telegram bot start failed',
      );
    });

    it('registers command and message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().commandHandlers.has('chatid')).toBe(true);
      expect(currentBot().commandHandlers.has('start')).toBe(true);
      expect(currentBot().commandHandlers.has('help')).toBe(true);
      expect(currentBot().commandHandlers.has('language')).toBe(true);
      expect(currentBot().commandHandlers.has('limit')).toBe(true);
      expect(currentBot().commandHandlers.has('balance')).toBe(true);
      expect(currentBot().commandHandlers.has('ping')).toBe(true);
      expect(currentBot().commandHandlers.has('engine')).toBe(true);
      expect(currentBot().commandHandlers.has('stats')).toBe(true);
      expect(currentBot().commandHandlers.has('pending')).toBe(true);
      expect(currentBot().commandHandlers.has('users')).toBe(true);
      expect(currentBot().commandHandlers.has('lastseen')).toBe(true);
      expect(currentBot().commandHandlers.has('health')).toBe(true);
      expect(currentBot().commandHandlers.has('subscribe')).toBe(true);
      expect(currentBot().commandHandlers.has('roy')).toBe(false);
      expect(currentBot().callbackQueryHandlers).toHaveLength(4);
      expect(currentBot().filterHandlers.has('message:text')).toBe(true);
      expect(currentBot().filterHandlers.has('message:photo')).toBe(true);
      expect(currentBot().filterHandlers.has('message:video')).toBe(true);
      expect(currentBot().filterHandlers.has('message:video_note')).toBe(true);
      expect(currentBot().filterHandlers.has('message:voice')).toBe(true);
      expect(currentBot().filterHandlers.has('message:audio')).toBe(true);
      expect(currentBot().filterHandlers.has('message:document')).toBe(true);
      expect(currentBot().filterHandlers.has('message:sticker')).toBe(true);
      expect(currentBot().filterHandlers.has('message:location')).toBe(true);
      expect(currentBot().filterHandlers.has('message:contact')).toBe(true);
    });

    it('publishes public bot commands on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().api.setMyCommands).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ command: 'start' }),
          expect.objectContaining({ command: 'limit' }),
          expect.objectContaining({ command: 'chatid' }),
        ]),
      );
      // These stay as working handlers but are intentionally hidden from the menu.
      const publishedCommands = (
        currentBot().api.setMyCommands as ReturnType<typeof vi.fn>
      ).mock.calls
        .flatMap((call) => call[0] as Array<{ command: string }>)
        .map((entry) => entry.command);
      for (const hidden of [
        'help',
        'balance',
        'language',
        'ping',
        'subscribe',
      ]) {
        expect(publishedCommands).not.toContain(hidden);
      }
    });

    it('publishes owner bot commands for the main chat scope', async () => {
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().api.setMyCommands).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ command: 'users' }),
          expect.objectContaining({ command: 'lastseen' }),
          expect.objectContaining({ command: 'health' }),
          expect.objectContaining({ command: 'engine' }),
          expect.objectContaining({ command: 'stats' }),
        ]),
        expect.objectContaining({
          scope: { type: 'chat', chat_id: 100200300 },
        }),
      );
    });

    it('publishes limited command-admin menus for configured admin ids', async () => {
      process.env.SKOOBI_TELEGRAM_COMMAND_ADMIN_IDS = '777 888';
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().api.setMyCommands).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ command: 'start' }),
          expect.objectContaining({ command: 'engine' }),
          expect.objectContaining({ command: 'stats' }),
        ]),
        expect.objectContaining({
          scope: { type: 'chat', chat_id: 777 },
        }),
      );
      const adminCall = (
        currentBot().api.setMyCommands as ReturnType<typeof vi.fn>
      ).mock.calls.find((call) => call[1]?.scope?.chat_id === 777);
      expect(
        adminCall?.[0].map((entry: { command: string }) => entry.command),
      ).not.toContain('users');
    });

    it('keeps the full owner menu for an owner who is also a command admin', async () => {
      process.env.SKOOBI_TELEGRAM_COMMAND_ADMIN_IDS = '100200300 888';
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      const calls = (currentBot().api.setMyCommands as ReturnType<typeof vi.fn>)
        .mock.calls;
      // The owner chat must receive ONLY the full owner menu, never the shorter
      // admin menu that would otherwise clobber it (hiding /health, …).
      const ownerScopeCalls = calls.filter(
        (call) => call[1]?.scope?.chat_id === 100200300,
      );
      expect(ownerScopeCalls).toHaveLength(1);
      const ownerCmds = (
        ownerScopeCalls[0][0] as Array<{ command: string }>
      ).map((entry) => entry.command);
      expect(ownerCmds).toContain('users');
      expect(ownerCmds).not.toContain('roy');
      // A non-owner admin still gets the limited admin menu.
      const adminCall = calls.find((call) => call[1]?.scope?.chat_id === 888);
      expect(adminCall).toBeTruthy();
      expect(
        (adminCall?.[0] as Array<{ command: string }>).map((e) => e.command),
      ).not.toContain('users');
    });

    it('registers error handler on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().errorHandler).not.toBeNull();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });

    it('marks the channel disconnected when polling dies after onStart (finding #18)', async () => {
      // grammy rethrows a fatal polling error (e.g. 409 Conflict from a second
      // getUpdates consumer, or a mid-flight 401) AFTER onStart fired. connect()
      // still resolves, but the long-poll loop is dead, so isConnected() must
      // flip to false instead of falsely reporting healthy.
      botControl.postStartError = { error_code: 409, message: 'Conflict' };
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();
      // Let the async start()-rejection .catch handler run. The rejected
      // start() promise is adopted by Promise.resolve(), so its .catch is a
      // microtask; flush a few turns to be safe.
      await flushMicrotasks();

      expect(channel.isConnected()).toBe(false);
      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.objectContaining({ code: 409, isConflict: true }),
        'Telegram inbound polling died — marking channel disconnected',
      );
    });

    it('classifies a post-onStart 401 polling death as a token failure (finding #18)', async () => {
      botControl.postStartError = { error_code: 401, message: 'Unauthorized' };
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();
      await flushMicrotasks();

      expect(channel.isConnected()).toBe(false);
      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.objectContaining({ code: 401, isUnauthorized: true }),
        'Telegram inbound polling died — marking channel disconnected',
      );
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello everyone' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          id: '1',
          chat_jid: 'tg:100200300',
          sender: '99001',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
          sender_identity: expect.objectContaining({
            telegram_message_origin: 'direct',
          }),
        }),
      );
    });

    it('delivers a retired-Roy phrase unchanged through the ordinary message path', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const text = 'Скуби, попроси рой проверить сборку';
      await triggerTextMessage(createTextCtx({ text }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: text }),
      );
    });

    it.each([
      [
        'native forward',
        { forwardOrigin: { type: 'user', sender_user: { id: 123 } } },
        'forwarded',
      ],
      ['automatic channel forward', { isAutomaticForward: true }, 'forwarded'],
      ['inline bot result', { viaBot: { id: 321, is_bot: true } }, 'forwarded'],
      [
        'blockquote entity',
        { entities: [{ type: 'blockquote', offset: 0, length: 5 }] },
        'quoted',
      ],
      [
        'code entity',
        { entities: [{ type: 'code', offset: 0, length: 5 }] },
        'quoted',
      ],
    ])('records %s authority provenance', async (_name, overrides, origin) => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerTextMessage(createTextCtx({ text: 'Hello', ...overrides }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          sender_identity: expect.objectContaining({
            telegram_message_origin: origin,
          }),
        }),
      );
    });

    it('delivers bot-prefixed messages for additional persona bots', async () => {
      const opts = createTestOpts({
        botId: 'skoobi_friend',
        personaId: 'friend',
        registeredGroups: vi.fn(() => ({
          'tg:skoobi_friend:100200300': {
            name: 'Friend Bot Chat',
            folder: 'friend-chat',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello friend' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:skoobi_friend:100200300',
        expect.objectContaining({
          chat_jid: 'tg:skoobi_friend:100200300',
          sender_identity: expect.objectContaining({
            identity_id: 'telegram_user_99001',
            bot_id: 'skoobi_friend',
            persona_id: 'friend',
          }),
        }),
      );
    });

    it('attaches Telegram update_id to inbound messages when available', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello', updateId: 777888 });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ telegram_update_id: '777888' }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ chatId: 999999, text: 'Unknown chat' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:999999',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips command messages (starting with /)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: '/start' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('blocks registered Telegram bot accounts before storing messages', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'bot spam' });
      (ctx.from as any).is_bot = true;
      await triggerTextMessage(ctx);
      await Promise.resolve();

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Боты не подключаются'),
        {},
      );
    });

    it('clears Telegram outbound blocked marker after a real inbound message', async () => {
      fs.mkdirSync('/tmp/claudeclaw-telegram-test-data', { recursive: true });
      fs.writeFileSync(
        '/tmp/claudeclaw-telegram-test-data/telegram-access-control.json',
        JSON.stringify({
          'tg:100200300': {
            outboundBlockedAt: '2026-05-16T00:00:00.000Z',
            outboundBlockedReason: 'bot_blocked_by_user',
            lastOutboundErrorAt: '2026-05-16T00:00:00.000Z',
            lastOutboundError: 'Forbidden: bot was blocked by the user',
          },
        }),
      );

      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerTextMessage(createTextCtx({ text: 'я снова тут' }));

      const state = JSON.parse(
        fs.readFileSync(
          '/tmp/claudeclaw-telegram-test-data/telegram-access-control.json',
          'utf-8',
        ),
      );
      expect(state['tg:100200300'].outboundBlockedReason).toBeUndefined();
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });

    it('does not defer guest processing by removed guest rate limits', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'New Guest',
            folder: 'telegram_new_guest',
            trigger: '@skoobi_bot',
            added_at: new Date().toISOString(),
            runtime: 'sandbox' as const,
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      for (let i = 0; i < 21; i += 1) {
        await triggerTextMessage(
          createTextCtx({ text: `msg ${i}`, messageId: i + 1 }),
        );
      }

      expect(opts.onMessage).toHaveBeenCalledTimes(21);
      const inbox = fs
        .readFileSync(
          '/tmp/claudeclaw-telegram-test-data/telegram-inbox/telegram_new_guest.jsonl',
          'utf-8',
        )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(inbox).toHaveLength(21);
      expect(inbox[20]).toEqual(
        expect.objectContaining({
          kind: 'text',
          text: 'msg 20',
          deferred: false,
        }),
      );
      const state = JSON.parse(
        fs.readFileSync(
          '/tmp/claudeclaw-telegram-test-data/telegram-access-control.json',
          'utf-8',
        ),
      );
      expect(state['tg:100200300'].deferAgentUntil).toBeUndefined();
    });

    it('routes "Покажи мой лимит" to quota status without model path', async () => {
      const tenant = {
        tenant_id: 'tenant-100200300',
        channel: 'telegram',
        chat_id: '100200300',
      };
      const opts = createTestOpts({
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => tenant),
        })) as any,
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: 100200300,
        chatType: 'private',
        text: 'Покажи мой лимит',
        fromId: 42,
      });
      await triggerTextMessage(ctx);

      expect(quotaMock.getQuotaStatus).toHaveBeenCalledWith({
        tenantId: 'tenant-100200300',
        channel: 'telegram',
        channelUserId: '42',
      });
      expect(ctx.reply).toHaveBeenCalledWith('quota status text', {});
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(eventStoreMock.recordTenantEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant,
          type: 'quota_balance_viewed',
          actor: 'telegram_user:42',
          senderId: '42',
        }),
      );
    });

    it('routes "Сколько токенов осталось?" to quota status', async () => {
      const opts = createTestOpts({
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => ({
            tenant_id: 'tenant-100200300',
            channel: 'telegram',
            chat_id: '100200300',
          })),
        })) as any,
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: 100200300,
        chatType: 'private',
        text: 'Сколько токенов осталось?',
        fromId: 42,
      });
      await triggerTextMessage(ctx);

      expect(quotaMock.getQuotaStatus).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('quota status text', {});
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('does not intercept long messages that merely mention a limit', async () => {
      const opts = createTestOpts({
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => ({
            tenant_id: 'tenant-100200300',
            channel: 'telegram',
            chat_id: '100200300',
          })),
        })) as any,
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Я готовлю документ и хочу описать лимит ответственности по договору, помоги сформулировать.',
      });
      await triggerTextMessage(ctx);

      expect(quotaMock.getQuotaStatus).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: expect.stringContaining('лимит ответственности'),
        }),
      );
    });

    it('keeps group quota status private for addressed natural-language requests', async () => {
      const tenant = {
        tenant_id: 'tenant-group',
        channel: 'telegram',
        chat_id: '-1001',
      };
      const opts = createTestOpts({
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => tenant),
        })) as any,
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: -1001,
        chatType: 'group',
        text: 'мой баланс',
        fromId: 42,
        replyToBot: true,
      });
      await triggerTextMessage(ctx);

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        42,
        'quota status text',
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        'Отправил статус доступа в личку.',
        {},
      );
      expect(ctx.reply).not.toHaveBeenCalledWith('quota status text', {});
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('does not fire the quota intent for unaddressed group messages', async () => {
      const tenant = {
        tenant_id: 'tenant-100200300',
        channel: 'telegram',
        chat_id: '100200300',
      };
      const opts = createTestOpts({
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => tenant),
        })) as any,
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatType: 'group',
        text: 'мой баланс',
        fromId: 42,
      });
      await triggerTextMessage(ctx);

      // No deterministic quota reply when the bot is not addressed in a group.
      expect(quotaMock.getQuotaStatus).not.toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalledWith('quota status text', {});
      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
      // The message is delivered normally instead.
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: 'мой баланс' }),
      );
    });

    it('accepts only this bot text_mention as group addressing', async () => {
      const tenant = {
        tenant_id: 'tenant-100200300',
        channel: 'telegram',
        chat_id: '100200300',
      };
      const opts = createTestOpts({
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => tenant),
        })) as any,
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const otherUserCtx = createTextCtx({
        chatType: 'group',
        text: 'мой баланс',
        fromId: 42,
        entities: [
          {
            type: 'text_mention',
            offset: 0,
            length: 3,
            user: { id: 54321 },
          },
        ],
      });
      await triggerTextMessage(otherUserCtx);
      expect(quotaMock.getQuotaStatus).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: 'мой баланс' }),
      );

      vi.clearAllMocks();
      const botCtx = createTextCtx({
        chatType: 'group',
        text: 'мой баланс',
        fromId: 42,
        entities: [
          {
            type: 'text_mention',
            offset: 0,
            length: 3,
            user: { id: 12345, is_bot: true },
          },
        ],
      });
      await triggerTextMessage(botCtx);
      expect(quotaMock.getQuotaStatus).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('starts memory deletion confirmation without deleting immediately', async () => {
      // Finding #41: deleting a group's shared memory is owner/admin-only in
      // non-private chats. Make the requester (fromId 42) a command-admin so
      // this self-deletion flow test exercises the confirmation, not the gate.
      process.env.SKOOBI_TELEGRAM_COMMAND_ADMIN_IDS = '42';
      const tenant = {
        tenant_id: 'tenant-100200300',
        channel: 'telegram',
        chat_id: '100200300',
        folder: 'test-group',
      };
      const opts = createTestOpts({
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => tenant),
        })) as any,
      });
      const memoryFile =
        '/tmp/claudeclaw-telegram-test-groups/test-group/memory/topics/user.md';
      fs.mkdirSync(
        '/tmp/claudeclaw-telegram-test-groups/test-group/memory/topics',
        {
          recursive: true,
        },
      );
      fs.writeFileSync(memoryFile, 'remembered fact');
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Откати всю память',
        fromId: 42,
        replyToBot: true,
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(fs.existsSync(memoryFile)).toBe(true);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('ПОДТВЕРЖДАЮ УДАЛИТЬ ПАМЯТЬ'),
        {},
      );
      expect(eventStoreMock.recordTenantEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant,
          type: 'memory_delete_requested',
          actor: 'telegram_user:42',
          senderId: '42',
        }),
      );
    });

    it('requires exact memory deletion confirmation and preserves other tenants', async () => {
      // Finding #41: shared-memory deletion is owner/admin-only in non-private
      // chats. Authorize the requester (fromId 42) so this test still exercises
      // the exact-confirmation + tenant-isolation behavior.
      process.env.SKOOBI_TELEGRAM_COMMAND_ADMIN_IDS = '42';
      const tenant = {
        tenant_id: 'tenant-100200300',
        channel: 'telegram',
        chat_id: '100200300',
        folder: 'test-group',
      };
      const opts = createTestOpts({
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => tenant),
        })) as any,
      });
      const targetMemoryDir =
        '/tmp/claudeclaw-telegram-test-groups/test-group/memory/topics';
      const targetMemory = `${targetMemoryDir}/user.md`;
      const otherTenantMemory =
        '/tmp/claudeclaw-telegram-test-groups/other-group/memory/topics/other.md';
      const ownerMemory =
        '/tmp/claudeclaw-telegram-test-groups/telegram_main/memory/topics/owner.md';
      fs.mkdirSync(targetMemoryDir, { recursive: true });
      fs.mkdirSync(
        '/tmp/claudeclaw-telegram-test-groups/other-group/memory/topics',
        { recursive: true },
      );
      fs.mkdirSync(
        '/tmp/claudeclaw-telegram-test-groups/telegram_main/memory/topics',
        { recursive: true },
      );
      fs.writeFileSync(targetMemory, 'target remembered fact');
      fs.writeFileSync(otherTenantMemory, 'other remembered fact');
      fs.writeFileSync(ownerMemory, 'owner remembered fact');
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const requestCtx = createTextCtx({
        text: 'удали память',
        fromId: 42,
        messageId: 1,
        replyToBot: true,
      });
      const wrongConfirmCtx = createTextCtx({
        text: 'Да удаляй',
        fromId: 42,
        messageId: 2,
        replyToBot: true,
      });
      await triggerTextMessage(requestCtx);
      await triggerTextMessage(wrongConfirmCtx);

      expect(fs.existsSync(targetMemory)).toBe(true);
      expect(eventStoreMock.recordTenantEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'memory_deleted' }),
      );

      const confirmCtx = createTextCtx({
        text: 'ПОДТВЕРЖДАЮ УДАЛИТЬ ПАМЯТЬ',
        fromId: 42,
        messageId: 3,
        replyToBot: true,
      });
      await triggerTextMessage(confirmCtx);

      expect(fs.existsSync(targetMemory)).toBe(false);
      expect(
        fs
          .readdirSync(targetMemoryDir)
          .some((name) => name.includes('.tombstone')),
      ).toBe(true);
      expect(fs.existsSync(otherTenantMemory)).toBe(true);
      expect(fs.existsSync(ownerMemory)).toBe(true);
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(eventStoreMock.recordTenantEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant,
          type: 'memory_deleted',
          actor: 'telegram_user:42',
          senderId: '42',
        }),
      );
      for (const ctx of [requestCtx, wrongConfirmCtx, confirmCtx]) {
        for (const [text] of ctx.reply.mock.calls) {
          expect(text).not.toContain('передал администратору');
        }
      }
    });

    it('does not consume a private memory-deletion challenge from an indirect message', async () => {
      const tenant = {
        tenant_id: 'tenant-private-42',
        channel: 'telegram',
        chat_id: '42',
        folder: 'test-group',
      };
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:42': {
            name: 'Private owner',
            folder: 'test-group',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => tenant),
        })) as any,
      });
      const memoryFile =
        '/tmp/claudeclaw-telegram-test-groups/test-group/memory/topics/private.md';
      fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
      fs.writeFileSync(memoryFile, 'keep this memory');
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerTextMessage(
        createTextCtx({
          chatId: 42,
          chatType: 'private',
          fromId: 42,
          text: 'удали память',
          messageId: 30,
        }),
      );
      await triggerTextMessage(
        createTextCtx({
          chatId: 42,
          chatType: 'private',
          fromId: 42,
          text: 'ПОДТВЕРЖДАЮ УДАЛИТЬ ПАМЯТЬ',
          messageId: 31,
          forwardOrigin: { type: 'user', sender_user: { id: 777 } },
        }),
      );

      expect(fs.existsSync(memoryFile)).toBe(true);
      expect(eventStoreMock.recordTenantEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'memory_deleted' }),
      );
    });

    it('rejects a guest-planted tombstones directory symlink before deleting memory', async () => {
      process.env.SKOOBI_TELEGRAM_COMMAND_ADMIN_IDS = '42';
      const tenant = {
        tenant_id: 'tenant-100200300',
        channel: 'telegram',
        chat_id: '100200300',
        folder: 'test-group',
      };
      const opts = createTestOpts({
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => tenant),
        })) as any,
      });
      const memoryRoot =
        '/tmp/claudeclaw-telegram-test-groups/test-group/memory';
      const source = path.join(memoryRoot, 'topics', 'user.md');
      const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), 'telegram-memory-tombstone-outside-'),
      );
      const sentinel = path.join(outside, 'host-sentinel');
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, 'remembered fact');
      fs.writeFileSync(sentinel, 'DO_NOT_TOUCH');
      fs.symlinkSync(outside, path.join(memoryRoot, 'tombstones'));
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerTextMessage(
        createTextCtx({
          text: 'удали память',
          fromId: 42,
          messageId: 1,
          replyToBot: true,
        }),
      );
      const confirm = createTextCtx({
        text: 'ПОДТВЕРЖДАЮ УДАЛИТЬ ПАМЯТЬ',
        fromId: 42,
        messageId: 2,
        replyToBot: true,
      });
      await triggerTextMessage(confirm);

      expect(fs.readFileSync(source, 'utf8')).toBe('remembered fact');
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('DO_NOT_TOUCH');
      expect(
        fs
          .readdirSync(outside)
          .some((name) => name.startsWith('memory-delete-')),
      ).toBe(false);
      expect(eventStoreMock.recordTenantEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant,
          type: 'memory_delete_unavailable',
          actor: 'telegram_user:42',
        }),
      );
      expect(confirm.reply).toHaveBeenCalledWith(
        expect.stringContaining('автоматическое удаление памяти'),
        {},
      );

      fs.rmSync(outside, { recursive: true, force: true });
    });

    it('does not start memory deletion for unaddressed group messages', async () => {
      const tenant = {
        tenant_id: 'tenant-100200300',
        channel: 'telegram',
        chat_id: '100200300',
        folder: 'test-group',
      };
      const opts = createTestOpts({
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => tenant),
        })) as any,
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatType: 'group',
        text: 'удали память',
        fromId: 42,
      });
      await triggerTextMessage(ctx);

      // No confirmation flow is started for an unaddressed group message.
      expect(eventStoreMock.recordTenantEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'memory_delete_requested' }),
      );
      expect(ctx.reply).not.toHaveBeenCalledWith(
        expect.stringContaining('ПОДТВЕРЖДАЮ УДАЛИТЬ ПАМЯТЬ'),
        {},
      );
      // The message is delivered normally instead.
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: 'удали память' }),
      );
    });

    it('refuses shared-memory deletion from a non-admin group member (finding #41)', async () => {
      // No command-admin configured, so fromId 42 is a plain group member.
      const tenant = {
        tenant_id: 'tenant-100200300',
        channel: 'telegram',
        chat_id: '100200300',
        folder: 'test-group',
      };
      const opts = createTestOpts({
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => tenant),
        })) as any,
      });
      const memoryDir =
        '/tmp/claudeclaw-telegram-test-groups/test-group/memory/topics';
      const memoryFile = `${memoryDir}/user.md`;
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(memoryFile, 'shared group memory');
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // A non-admin member addresses the bot with the destructive intent and
      // confirmation. Both must be refused, and the memory must survive.
      const requestCtx = createTextCtx({
        chatType: 'group',
        text: 'удали память',
        fromId: 42,
        messageId: 1,
        replyToBot: true,
      });
      await triggerTextMessage(requestCtx);
      const confirmCtx = createTextCtx({
        chatType: 'group',
        text: 'ПОДТВЕРЖДАЮ УДАЛИТЬ ПАМЯТЬ',
        fromId: 42,
        messageId: 2,
        replyToBot: true,
      });
      await triggerTextMessage(confirmCtx);

      expect(fs.existsSync(memoryFile)).toBe(true);
      expect(eventStoreMock.recordTenantEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'memory_deleted' }),
      );
      expect(requestCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining('только владельцу/админу'),
        {},
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('allows shared-memory deletion from a command-admin in a group (finding #41)', async () => {
      process.env.SKOOBI_TELEGRAM_COMMAND_ADMIN_IDS = '42';
      const tenant = {
        tenant_id: 'tenant-100200300',
        channel: 'telegram',
        chat_id: '100200300',
        folder: 'test-group',
      };
      const opts = createTestOpts({
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => tenant),
        })) as any,
      });
      const memoryDir =
        '/tmp/claudeclaw-telegram-test-groups/test-group/memory/topics';
      const memoryFile = `${memoryDir}/user.md`;
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(memoryFile, 'shared group memory');
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const requestCtx = createTextCtx({
        chatType: 'group',
        text: 'удали память',
        fromId: 42,
        messageId: 1,
        replyToBot: true,
      });
      await triggerTextMessage(requestCtx);
      const confirmCtx = createTextCtx({
        chatType: 'group',
        text: 'ПОДТВЕРЖДАЮ УДАЛИТЬ ПАМЯТЬ',
        fromId: 42,
        messageId: 2,
        replyToBot: true,
      });
      await triggerTextMessage(confirmCtx);

      expect(fs.existsSync(memoryFile)).toBe(false);
      expect(eventStoreMock.recordTenantEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'memory_deleted' }),
      );
    });

    it('extracts sender name from first_name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', firstName: 'Bob' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'Bob' }),
      );
    });

    it('falls back to username when first_name missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi' });
      ctx.from.first_name = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'alice_user' }),
      );
    });

    it('falls back to user ID when name and username missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', fromId: 42 });
      ctx.from.first_name = undefined as any;
      ctx.from.username = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: '42' }),
      );
    });

    it('uses sender name as chat name for private chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Private',
            folder: 'private',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'private',
        firstName: 'Alice',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Alice', // Private chats use sender name
        'telegram',
        false,
      );
    });

    it('uses chat title as name for group chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'supergroup',
        chatTitle: 'Project Team',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Project Team',
        'telegram',
        true,
      );
    });

    it('converts message.date to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      const ctx = createTextCtx({ text: 'Hello', date: unixTime });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.500000000000001Z',
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('canonicalizes a different runtime @username to one configured trigger', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@runtime_bot what time is it?',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      });
      ctx.me.username = 'runtime_bot';
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@skoobi_bot what time is it?',
        }),
      );
    });

    it('deduplicates UTF-16 entity ranges and removes every true runtime mention once', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const runtimeMention = '@runtime_bot';
      const text = `🙂 hi ${runtimeMention} and ${runtimeMention} @skoobi_bot`;
      const firstOffset = text.indexOf(runtimeMention);
      const secondOffset = text.indexOf(runtimeMention, firstOffset + 1);
      const ctx = createTextCtx({
        text,
        entities: [
          {
            type: 'mention',
            offset: firstOffset,
            length: runtimeMention.length,
          },
          {
            type: 'mention',
            offset: firstOffset,
            length: runtimeMention.length,
          },
          {
            type: 'mention',
            offset: secondOffset,
            length: runtimeMention.length,
          },
        ],
      });
      ctx.me.username = 'runtime_bot';
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@skoobi_bot 🙂 hi and',
        }),
      );
    });

    it('does not translate mentions of other bots', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@some_other_bot hi',
        entities: [{ type: 'mention', offset: 0, length: 15 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@some_other_bot hi', // No translation
        }),
      );
    });

    it('handles mention in middle of message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'hey @runtime_bot check this',
        entities: [{ type: 'mention', offset: 4, length: 12 }],
      });
      ctx.me.username = 'runtime_bot';
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@skoobi_bot hey check this',
        }),
      );
    });

    it.each([
      ['invalid characters', 'bad-name'],
      ['too short', 'bot'],
      ['too long', 'a'.repeat(33)],
    ])('ignores a runtime username with %s', async (_case, username) => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const mention = `@${username}`;
      const ctx = createTextCtx({
        text: `${mention} hello`,
        entities: [{ type: 'mention', offset: 0, length: mention.length }],
      });
      ctx.me.username = username;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: `${mention} hello` }),
      );
    });

    it('does not trust plain mention-shaped text without a Telegram entity', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: '@runtime_bot hello' });
      ctx.me.username = 'runtime_bot';
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '@runtime_bot hello' }),
      );
    });

    it('ignores an entity that covers only a username prefix', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@runtime_botExtra hello',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      });
      ctx.me.username = 'runtime_bot';
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '@runtime_botExtra hello' }),
      );
    });

    it.each(['x@runtime_bot hello', '𐐀@runtime_bot hello'])(
      'does not trust an email-like partial runtime mention entity in %s',
      async (text) => {
        const opts = createTestOpts();
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        const ctx = createTextCtx({
          text,
          entities: [
            {
              type: 'mention',
              offset: text.indexOf('@runtime_bot'),
              length: '@runtime_bot'.length,
            },
          ],
        });
        ctx.me.username = 'runtime_bot';
        await triggerTextMessage(ctx);

        expect(opts.onMessage).toHaveBeenCalledWith(
          'tg:100200300',
          expect.objectContaining({ content: text }),
        );
      },
    );

    it('preserves email-like configured-name text during canonicalization', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const text = '@runtime_bot email owner@Skoobi.example';
      const ctx = createTextCtx({
        text,
        entities: [
          {
            type: 'mention',
            offset: 0,
            length: '@runtime_bot'.length,
          },
        ],
      });
      ctx.me.username = 'runtime_bot';
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@skoobi_bot email owner@Skoobi.example',
        }),
      );
    });

    it('canonicalizes a text_mention of this bot even without a username', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const text = '🙂 Skoobi please help';
      const ctx = createTextCtx({
        text,
        entities: [
          {
            type: 'text_mention',
            offset: text.indexOf('Skoobi'),
            length: 'Skoobi'.length,
            user: { id: 12345, is_bot: true },
          },
        ],
      });
      ctx.me.username = undefined as unknown as string;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '@skoobi_bot 🙂 please help' }),
      );
    });

    it('ignores a text_mention range that splits a UTF-16 surrogate pair', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const text = '🙂 please help';
      const ctx = createTextCtx({
        text,
        entities: [
          {
            type: 'text_mention',
            offset: 1,
            length: 1,
            user: { id: 12345, is_bot: true },
          },
        ],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: text }),
      );
    });

    it('does not canonicalize a text_mention of another user', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const text = 'Skoobi please help';
      const ctx = createTextCtx({
        text,
        entities: [
          {
            type: 'text_mention',
            offset: 0,
            length: 'Skoobi'.length,
            user: { id: 54321 },
          },
          {
            type: 'text_mention',
            offset: 0,
            length: 'Skoobi'.length,
            user: { id: 12345, is_bot: false },
          },
        ],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: text }),
      );
    });

    it('handles message with no entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'plain message' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });

    it('ignores non-mention entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'check https://example.com',
        entities: [{ type: 'url', offset: 6, length: 19 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'check https://example.com',
        }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('stores photo with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });

    it('stores photo with caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ caption: 'Look at this' });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] Look at this' }),
      );
    });

    it.each([
      [
        'forwarded caption',
        { forward_origin: { type: 'user', sender_user: { id: 123 } } },
        'forwarded',
      ],
      [
        'quoted caption',
        { caption_entities: [{ type: 'pre', offset: 0, length: 12 }] },
        'quoted',
      ],
    ])('records %s authority provenance', async (_name, extra, origin) => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerMediaMessage(
        'message:photo',
        createMediaCtx({ caption: 'Replace this', extra }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          sender_identity: expect.objectContaining({
            telegram_message_origin: origin,
          }),
        }),
      );
    });

    it('stores saved photo with a relative file reference for agent vision', async () => {
      vi.mocked(downloadTelegramPhoto).mockResolvedValueOnce(
        '/tmp/test-group/received/photo.jpg',
      );
      captionPhotoMock.mockResolvedValueOnce(null);
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: {
          photo: [
            {
              file_id: 'small-photo-file',
              file_unique_id: 'small',
            },
            {
              file_id: 'big-photo-file',
              file_unique_id: 'big',
            },
          ],
        },
      });
      await triggerMediaMessage('message:photo', ctx);

      expect(downloadTelegramPhoto).toHaveBeenCalledWith(
        'test-token',
        'big-photo-file',
        'test-group',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content:
            '[Photo. File: received/photo.jpg — use Read tool to inspect visual context]',
        }),
      );
    });

    it('keeps Grammy context getters when storing saved photos', async () => {
      vi.mocked(downloadTelegramPhoto).mockResolvedValueOnce(
        '/tmp/test-group/received/photo.jpg',
      );
      captionPhotoMock.mockResolvedValueOnce(null);
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const plainCtx = createMediaCtx({
        extra: {
          photo: [{ file_id: 'photo-file-id', file_unique_id: 'photo-unique' }],
        },
      });
      const ctx = Object.create({
        get chat() {
          return plainCtx.chat;
        },
        get from() {
          return plainCtx.from;
        },
        get message() {
          return plainCtx.message;
        },
      });
      ctx.me = plainCtx.me;
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content:
            '[Photo. File: received/photo.jpg — use Read tool to inspect visual context]',
        }),
      );
    });

    it('stores video fallback when file id is missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:video', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('stores processed video with transcript and frames', async () => {
      vi.mocked(processTelegramVideoFile).mockResolvedValueOnce({
        videoPath: '/tmp/test-group/received/video.mp4',
        transcript: 'Посмотри ролик',
        framePaths: [
          '/tmp/test-group/received/video-frame-01.jpg',
          '/tmp/test-group/received/video-frame-02.jpg',
        ],
      });
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { video: { file_id: 'video-file', file_unique_id: 'video-u' } },
      });
      await triggerMediaMessage('message:video', ctx);

      expect(processTelegramVideoFile).toHaveBeenCalledWith(
        'test-token',
        'video-file',
        'test-group',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content:
            '[Video Transcript: Посмотри ролик. Key-frame files: received/video-frame-01.jpg, received/video-frame-02.jpg]',
        }),
      );
    });

    it('records extracted video key-frames as photo, not video (finding #44)', async () => {
      vi.mocked(processTelegramVideoFile).mockResolvedValueOnce({
        videoPath: '/tmp/test-group/received/video.mp4',
        transcript: 'Посмотри ролик',
        framePaths: [
          '/tmp/test-group/received/video-frame-01.jpg',
          '/tmp/test-group/received/video-frame-02.jpg',
        ],
      });
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { video: { file_id: 'video-file', file_unique_id: 'video-u' } },
      });
      await triggerMediaMessage('message:video', ctx);

      // recordMedia appends to <GROUPS_DIR>/<folder>/.media-index.jsonl.
      const manifest =
        '/tmp/claudeclaw-telegram-test-groups/test-group/.media-index.jsonl';
      const entries = fs
        .readFileSync(manifest, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { basename: string; type: string });

      const byBasename = Object.fromEntries(
        entries.map((e) => [e.basename, e.type]),
      );
      // The video file keeps type 'video'; the .jpg key-frames are 'photo' so
      // retention uses the photo TTL and stays consistent with the backfill
      // script (which infers '-frame-NN.jpg' as photo by extension).
      expect(byBasename['video.mp4']).toBe('video');
      expect(byBasename['video-frame-01.jpg']).toBe('photo');
      expect(byBasename['video-frame-02.jpg']).toBe('photo');
    });

    it('stores video frame captions for guest live without requiring old history frames', async () => {
      vi.mocked(processTelegramVideoFile).mockResolvedValueOnce({
        videoPath: '/tmp/test-group/received/video.mp4',
        transcript: null,
        framePaths: [
          '/tmp/test-group/received/video-frame-01.jpg',
          '/tmp/test-group/received/video-frame-02.jpg',
        ],
      });
      captionPhotoMock
        .mockResolvedValueOnce('На кадре человек на улице.')
        .mockResolvedValueOnce('Виден навес и красная футболка.');
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { video: { file_id: 'video-file', file_unique_id: 'video-u' } },
      });
      await triggerMediaMessage('message:video', ctx);

      expect(captionPhotoMock).toHaveBeenCalledWith(
        '/tmp/test-group/received/video-frame-01.jpg',
        { groupFolder: 'test-group', chatJid: 'tg:100200300' },
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content:
            '[Video transcription failed or no speech detected. Visual summary: На кадре человек на улице. Виден навес и красная футболка. Key-frame files: received/video-frame-01.jpg, received/video-frame-02.jpg]',
        }),
      );
    });

    it('stores video note fallback when file id is missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:video_note', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Video note]' }),
      );
    });

    it('stores processed video note with transcript and frames', async () => {
      vi.mocked(processTelegramVideoNote).mockResolvedValueOnce({
        videoPath: '/tmp/test-group/received/note.mp4',
        transcript: 'Привет из кружочка',
        framePaths: [
          '/tmp/test-group/received/note-frame-01.jpg',
          '/tmp/test-group/received/note-frame-02.jpg',
        ],
      });
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { video_note: { file_id: 'video-note-file' } },
      });
      await triggerMediaMessage('message:video_note', ctx);

      expect(processTelegramVideoNote).toHaveBeenCalledWith(
        'test-token',
        'video-note-file',
        'test-group',
      );
      // Tier 1 privacy: video note placeholder must not embed absolute
      // host paths, but it should expose relative key-frame paths so the
      // agent can inspect the visual context with the Read tool.
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content:
            '[Video note Transcript: Привет из кружочка. Key-frame files: received/note-frame-01.jpg, received/note-frame-02.jpg]',
        }),
      );
    });

    it('stores video note frame captions for guest live without requiring file tools', async () => {
      vi.mocked(processTelegramVideoNote).mockResolvedValueOnce({
        videoPath: '/tmp/test-group/received/note.mp4',
        transcript: 'Я на пляже',
        framePaths: [
          '/tmp/test-group/received/note-frame-01.jpg',
          '/tmp/test-group/received/note-frame-02.jpg',
        ],
      });
      captionPhotoMock
        .mockResolvedValueOnce('Человек стоит у воды на улице.')
        .mockResolvedValueOnce('В кадре виден пляж и светлое небо.');
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { video_note: { file_id: 'video-note-file' } },
      });
      await triggerMediaMessage('message:video_note', ctx);

      expect(captionPhotoMock).toHaveBeenCalledWith(
        '/tmp/test-group/received/note-frame-01.jpg',
        { groupFolder: 'test-group', chatJid: 'tg:100200300' },
      );
      expect(captionPhotoMock).toHaveBeenCalledWith(
        '/tmp/test-group/received/note-frame-02.jpg',
        { groupFolder: 'test-group', chatJid: 'tg:100200300' },
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content:
            '[Video note Transcript: Я на пляже. Visual summary: Человек стоит у воды на улице. В кадре виден пляж и светлое небо. Key-frame files: received/note-frame-01.jpg, received/note-frame-02.jpg]',
        }),
      );
    });

    it('stores voice message with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Voice message]' }),
      );
    });

    it('downloads voice once and transcribes the saved file through shared STT with auto default', async () => {
      vi.mocked(downloadTelegramAudio).mockResolvedValueOnce(
        '/tmp/claudeclaw-telegram-test-groups/test-group/received/voice.oga',
      );
      vi.mocked(transcribeAudioFile).mockResolvedValueOnce(
        'Привет из голосового',
      );
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: {
          voice: {
            file_id: 'voice-file-id',
            file_unique_id: 'voice-unique-id',
          },
        },
      });
      await triggerMediaMessage('message:voice', ctx);

      expect(downloadTelegramAudio).toHaveBeenCalledTimes(1);
      expect(downloadTelegramAudio).toHaveBeenCalledWith(
        'test-token',
        'voice-file-id',
        'test-group',
        'voice',
      );
      expect(transcribeAudioFile).toHaveBeenCalledTimes(1);
      // No language argument: the common voice-stt default is auto-detection.
      expect(transcribeAudioFile).toHaveBeenCalledWith(
        '/tmp/claudeclaw-telegram-test-groups/test-group/received/voice.oga',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Voice: Привет из голосового]' }),
      );
    });

    it('stores audio with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:audio', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('downloads audio once and transcribes the saved file through shared STT with auto default', async () => {
      vi.mocked(downloadTelegramAudio).mockResolvedValueOnce(
        '/tmp/claudeclaw-telegram-test-groups/test-group/received/audio.mp3',
      );
      vi.mocked(transcribeAudioFile).mockResolvedValueOnce('audio transcript');
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: {
          audio: {
            file_id: 'audio-file-id',
            file_unique_id: 'audio-unique-id',
            file_name: 'sample.mp3',
          },
        },
      });
      await triggerMediaMessage('message:audio', ctx);

      expect(downloadTelegramAudio).toHaveBeenCalledTimes(1);
      expect(downloadTelegramAudio).toHaveBeenCalledWith(
        'test-token',
        'audio-file-id',
        'test-group',
        'audio',
      );
      expect(transcribeAudioFile).toHaveBeenCalledTimes(1);
      expect(transcribeAudioFile).toHaveBeenCalledWith(
        '/tmp/claudeclaw-telegram-test-groups/test-group/received/audio.mp3',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Audio: audio transcript]' }),
      );
    });

    it('stores document with filename', async () => {
      vi.mocked(processTelegramDocument).mockResolvedValueOnce({
        filePath: '/tmp/test-group/received/report.pdf',
        originalName: 'report.pdf',
        preview: 'Итого: 120 000 тенге',
        extractedChars: 20,
        extractionStatus: 'ok',
      });
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: {
          document: { file_id: 'doc-file-id', file_name: 'report.pdf' },
        },
      });
      await triggerMediaMessage('message:document', ctx);

      expect(processTelegramDocument).toHaveBeenCalledWith(
        'test-token',
        'doc-file-id',
        'test-group',
        'report.pdf',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content:
            '[Document: report.pdf. File: received/report.pdf. Preview: Итого: 120 000 тенге]',
        }),
      );
    });

    it('stores document with fallback name when filename missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ extra: { document: {} } });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document: file]' }),
      );
    });

    it('stores sticker with emoji', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { sticker: { emoji: '😂' } },
      });
      await triggerMediaMessage('message:sticker', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Sticker 😂]' }),
      );
    });

    it('stores location with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores contact with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('ignores non-text messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ chatId: 999999 });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        { parse_mode: 'Markdown' },
      );
    });

    it('strips tg: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Group message');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'Group message',
        { parse_mode: 'Markdown' },
      );
    });

    it('strips bot-prefixed tg JID before sending through that bot', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', {
        ...opts,
        botId: 'skoobi_friend',
      });
      await channel.connect();

      await channel.sendMessage('tg:skoobi_friend:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        { parse_mode: 'Markdown' },
      );
    });

    it('splits messages exceeding 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('tg:100200300', longText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'x'.repeat(4096),
        { parse_mode: 'Markdown' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(904),
        { parse_mode: 'Markdown' },
      );
    });

    it('sends exactly one message at 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const exactText = 'y'.repeat(4096);
      await channel.sendMessage('tg:100200300', exactText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('throws when message delivery fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      await expect(
        channel.sendMessage('tg:100200300', 'Will fail'),
      ).rejects.toThrow('Network error');
    });

    it('marks Telegram chats unreachable after bot-blocked 403 and skips later sends', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const blocked = Object.assign(
        new Error(
          "Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)",
        ),
        {
          error_code: 403,
          description: 'Forbidden: bot was blocked by the user',
        },
      );

      currentBot().api.sendMessage.mockRejectedValueOnce(blocked);

      await expect(
        channel.sendMessage('tg:100200300', 'Will fail'),
      ).rejects.toThrow('bot was blocked by the user');

      const state = JSON.parse(
        fs.readFileSync(
          '/tmp/claudeclaw-telegram-test-data/telegram-access-control.json',
          'utf-8',
        ),
      );
      expect(state['tg:100200300'].outboundBlockedReason).toBe(
        'bot_blocked_by_user',
      );

      currentBot().api.sendMessage.mockClear();

      await expect(channel.sendMessage('tg:100200300', 'skip')).rejects.toThrow(
        'Telegram chat unreachable: bot_blocked_by_user',
      );
      expect(currentBot().api.sendMessage).not.toHaveBeenCalled();
    });

    it('falls back to plain text only for Markdown parse errors', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot()
        .api.sendMessage.mockRejectedValueOnce(
          new Error("Bad Request: can't parse entities"),
        )
        .mockResolvedValueOnce(undefined);

      await channel.sendMessage('tg:100200300', '*broken');

      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        '*broken',
        { parse_mode: 'Markdown' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        '*broken',
        {},
      );
    });

    it('retries once when Telegram returns retry_after', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const rateLimit = Object.assign(new Error('Too Many Requests'), {
        error: { parameters: { retry_after: 0 } },
      });

      currentBot()
        .api.sendMessage.mockRejectedValueOnce(rateLimit)
        .mockResolvedValueOnce(undefined);

      await channel.sendMessage('tg:100200300', 'retry me');

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('throws when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await expect(
        channel.sendMessage('tg:100200300', 'No bot'),
      ).rejects.toThrow('Telegram bot not initialized');
    });
  });

  describe('sendDocument', () => {
    it('sends a document via bot API with a safe caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const file = '/tmp/claudeclaw-telegram-test-document.txt';
      fs.writeFileSync(file, 'document bytes');

      await channel.sendDocument('tg:100200300', file, 'Ready');

      expect(currentBot().api.sendDocument).toHaveBeenCalledWith(
        '100200300',
        expect.objectContaining({ path: file }),
        { caption: 'Ready' },
      );
      fs.rmSync(file, { force: true });
    });

    it('does not report failure when the file disappears during delivery (finding #43)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const file = '/tmp/claudeclaw-telegram-test-document-race.txt';
      fs.writeFileSync(file, 'document bytes');

      // Model the file being moved/deleted between the send completing and the
      // post-send size logging. Pre-fix this threw on the post-send statSync
      // and surfaced a successful send as a failure (risking a duplicate).
      (
        currentBot().api.sendDocument as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(async () => {
        fs.rmSync(file, { force: true });
        return undefined;
      });

      await expect(
        channel.sendDocument('tg:100200300', file, 'Ready'),
      ).resolves.toBeUndefined();
      fs.rmSync(file, { force: true });
    });
  });

  describe('sendPhoto', () => {
    it('does not report failure when the file disappears during delivery (finding #43)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const file = '/tmp/claudeclaw-telegram-test-photo-race.jpg';
      fs.writeFileSync(file, 'photo bytes');

      (
        currentBot().api.sendPhoto as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(async () => {
        fs.rmSync(file, { force: true });
        return undefined;
      });

      await expect(
        channel.sendPhoto('tg:100200300', file, 'Caption'),
      ).resolves.toBeUndefined();
      fs.rmSync(file, { force: true });
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(true);
    });

    it('owns tg: JIDs with negative IDs (groups)', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('routes bot-prefixed JIDs only to the matching bot instance', () => {
      const friend = new TelegramChannel('test-token', {
        ...createTestOpts(),
        botId: 'skoobi_friend',
      });
      const lawyer = new TelegramChannel('test-token', {
        ...createTestOpts(),
        botId: 'skoobi_lawyer',
      });

      expect(friend.ownsJid('tg:skoobi_friend:123456')).toBe(true);
      expect(friend.ownsJid('tg:skoobi_lawyer:123456')).toBe(false);
      expect(friend.ownsJid('tg:123456')).toBe(false);
      expect(lawyer.ownsJid('tg:skoobi_lawyer:123456')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', true);

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
        '100200300',
        'typing',
      );
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', false);

      expect(currentBot().api.sendChatAction).not.toHaveBeenCalled();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('tg:100200300', true);

      // No error, no API call
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendChatAction.mockRejectedValueOnce(
        new Error('Rate limited'),
      );

      await expect(
        channel.setTyping('tg:100200300', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat ID and metadata', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'group' as const },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:100200300'),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('/chatid shows chat type', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 555, type: 'private' as const },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('private'),
        expect.any(Object),
      );
    });

    it('/start replies with onboarding for registered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('start')!;
      const ctx = {
        chat: { id: 100200300, type: 'private' as const },
        from: { id: 100200300 },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Статус: подключён'),
        {},
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('/help includes chat ID for unregistered chats', async () => {
      const opts = createTestOpts({ registeredGroups: vi.fn(() => ({})) });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('help')!;
      const ctx = {
        chat: { id: 555, type: 'private' as const },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:555'),
        {},
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('/limit shows the current Telegram sender quota in private chat', async () => {
      const tenant = {
        tenant_id: 'tenant-100200300',
        channel: 'telegram',
        chat_id: '100200300',
      };
      const opts = createTestOpts({
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => tenant),
        })) as any,
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('limit')!;
      const ctx = createTextCtx({
        chatId: 100200300,
        chatType: 'private',
        text: '/limit',
        fromId: 42,
      });
      (ctx as any).answerCallbackQuery = vi
        .fn()
        .mockRejectedValue(new Error('commands are not callback queries'));

      await handler(ctx);

      expect(quotaMock.getQuotaStatus).toHaveBeenCalledWith({
        tenantId: 'tenant-100200300',
        channel: 'telegram',
        channelUserId: '42',
      });
      expect(ctx.reply).toHaveBeenCalledWith('quota status text', {});
      expect((ctx as any).answerCallbackQuery).not.toHaveBeenCalled();
      expect(eventStoreMock.recordTenantEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant,
          type: 'quota_balance_viewed',
          actor: 'telegram_user:42',
          senderId: '42',
        }),
      );
    });

    it('/balance sends quota details privately when used in a group', async () => {
      const tenant = {
        tenant_id: 'tenant-group',
        channel: 'telegram',
        chat_id: '-1001',
      };
      const opts = createTestOpts({
        tenantRegistry: vi.fn(() => ({
          resolveTelegramChat: vi.fn(() => tenant),
        })) as any,
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('balance')!;
      const ctx = createTextCtx({
        chatId: -1001,
        chatType: 'group',
        text: '/balance',
        fromId: 42,
      });

      await handler(ctx);

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        42,
        'quota status text',
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        'Отправил статус доступа в личку.',
        {},
      );
      expect(quotaMock.getQuotaStatus).toHaveBeenCalledWith({
        tenantId: 'tenant-group',
        channel: 'telegram',
        channelUserId: '42',
      });
    });

    it('/start from an unregistered private chat shows language choice and creates the approval request immediately', async () => {
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('start')!;
      const ctx = {
        chat: { id: 777, type: 'private' as const },
        from: {
          id: 777,
          first_name: 'New',
          last_name: 'User',
          username: 'new_user',
        },
        reply: vi.fn(),
      };

      await handler(ctx);

      // The language chooser is still shown.
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Выберите язык'),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        }),
      );
      // The admin request is now created immediately on /start, without waiting
      // for the language callback.
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:777',
        expect.any(String),
        'New User',
        'telegram',
        false,
      );
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        100200300,
        expect.stringContaining('tg:777'),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        }),
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Заявка отправлена администратору'),
        {},
      );

      // Selecting a language afterwards notifies the applicant but must not
      // re-notify the admin within the 5-minute cooldown.
      currentBot().api.sendMessage.mockClear();
      const languageCtx = await triggerCallbackQuery('tglang:en', {
        chat: { id: 777, type: 'private' as const },
        from: {
          id: 777,
          first_name: 'New',
          last_name: 'User',
          username: 'new_user',
        },
        reply: vi.fn().mockResolvedValue(undefined),
      });

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        777,
        expect.stringContaining('Your request was sent'),
        {},
      );
      expect(currentBot().api.sendMessage).not.toHaveBeenCalledWith(
        100200300,
        expect.any(String),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        }),
      );
      expect(languageCtx.reply).not.toHaveBeenCalled();
    });

    it('private_admin rejects untrusted /start without commercial onboarding or approval request', async () => {
      process.env.SKOOBI_PRIVATE_ADMIN_MODE = 'true';
      process.env.OWNER_TELEGRAM_USER_IDS = '100000001,7000000002';
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('start')!;
      const ctx = {
        chat: { id: 777, type: 'private' as const },
        from: {
          id: 777,
          first_name: 'Random',
          username: 'random_user',
        },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('закрытый private/admin бот'),
        {},
      );
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(currentBot().api.sendMessage).not.toHaveBeenCalledWith(
        100200300,
        expect.any(String),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        }),
      );
    });

    it('private_admin rejects registered random text before the agent path', async () => {
      process.env.SKOOBI_PRIVATE_ADMIN_MODE = 'true';
      process.env.OWNER_TELEGRAM_USER_IDS = '100000001,7000000002';
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:555': {
            name: 'Random',
            folder: 'telegram_random',
            trigger: '@skoobi_bot',
            added_at: '2024-01-03T00:00:00.000Z',
            isMain: true,
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: 555,
        chatType: 'private',
        text: 'Скуби, сделай задачу',
        fromId: 555,
        firstName: 'Random',
      });
      await triggerTextMessage(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('закрытый private/admin бот'),
        {},
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('creates an approval request on the first ordinary message from an unregistered private chat', async () => {
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: 777,
        chatType: 'private',
        text: 'Здравствуйте, хочу пользоваться ассистентом',
        fromId: 777,
        firstName: 'New',
        username: 'new_user',
      });
      await triggerTextMessage(ctx);

      // Admin is notified with an approval keyboard, even though the user never
      // sent /start or picked a language.
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        100200300,
        expect.stringContaining('tg:777'),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        }),
      );
      // The unregistered message itself is not delivered to the agent.
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('does not re-create an approval request for a denied user who keeps messaging', async () => {
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Seed a previously denied applicant.
      fs.mkdirSync('/tmp/claudeclaw-telegram-test-data', { recursive: true });
      fs.writeFileSync(
        '/tmp/claudeclaw-telegram-test-data/pending-telegram-users.json',
        JSON.stringify({
          'tg:779': {
            jid: 'tg:779',
            name: 'Denied User',
            username: 'denied_user',
            chatType: 'private',
            language: 'ru',
            requestedAt: '2026-05-01T00:00:00.000Z',
            lastSeenAt: '2026-05-01T00:00:00.000Z',
            status: 'denied',
            deniedAt: '2026-05-01T00:00:00.000Z',
          },
        }),
      );

      const ctx = createTextCtx({
        chatId: 779,
        chatType: 'private',
        text: 'Ну пожалуйста, дайте доступ',
        fromId: 779,
        firstName: 'Denied',
        username: 'denied_user',
      });
      await triggerTextMessage(ctx);

      // No admin notification for a denied user.
      expect(currentBot().api.sendMessage).not.toHaveBeenCalledWith(
        100200300,
        expect.any(String),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        }),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
      // The denied status is preserved.
      const pending = JSON.parse(
        fs.readFileSync(
          '/tmp/claudeclaw-telegram-test-data/pending-telegram-users.json',
          'utf-8',
        ),
      );
      expect(pending['tg:779'].status).toBe('denied');
    });

    it('keeps applicant name from callbackQuery.from during language selection', async () => {
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerCallbackQuery('tglang:ru', {
        chat: { id: 778, type: 'private' as const },
        from: undefined,
        callbackQuery: {
          data: 'tglang:ru',
          id: 'callback-1',
          from: {
            id: 778,
            first_name: 'Getter',
            last_name: 'Only',
            username: 'getter_only',
          },
        },
        reply: vi.fn().mockResolvedValue(undefined),
      });

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:778',
        expect.any(String),
        'Getter Only',
        'telegram',
        false,
      );
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        100200300,
        expect.stringContaining('Имя: Getter Only'),
        expect.any(Object),
      );
    });

    it('routes persona-bot access notifications through the default admin bot', async () => {
      const groups = {
        'tg:100200300': {
          name: 'Admin',
          folder: 'telegram_main',
          trigger: '@skoobi_bot',
          added_at: '2024-01-01T00:00:00.000Z',
          isMain: true,
          runtime: 'sandbox' as const,
        },
      };
      const baseOpts = createAdminOpts({
        registeredGroups: vi.fn(() => groups),
      });
      const defaultChannel = new TelegramChannel('default-token', baseOpts);
      await defaultChannel.connect();
      const defaultBot = currentBot();

      const friendChannel = new TelegramChannel('friend-token', {
        ...baseOpts,
        botId: 'skoobi_friend',
        personaId: 'friend',
      });
      defaultChannel.setPeerChannels([defaultChannel, friendChannel]);
      friendChannel.setPeerChannels([defaultChannel, friendChannel]);
      defaultChannel.setOwnerNotificationChannel(defaultChannel);
      friendChannel.setOwnerNotificationChannel(defaultChannel);
      await friendChannel.connect();
      const friendBot = currentBot();

      defaultBot.api.sendMessage.mockClear();
      friendBot.api.sendMessage.mockClear();

      const startHandler = friendBot.commandHandlers.get('start')!;
      await startHandler({
        chat: { id: 777, type: 'private' as const },
        from: {
          id: 777,
          first_name: 'New',
          last_name: 'Friend',
          username: 'new_friend',
        },
        reply: vi.fn(),
      });
      await triggerCallbackQueryOn(friendBot, 'tglang:ru', {
        chat: { id: 777, type: 'private' as const },
        from: {
          id: 777,
          first_name: 'New',
          last_name: 'Friend',
          username: 'new_friend',
        },
        reply: vi.fn().mockResolvedValue(undefined),
      });

      expect(defaultBot.api.sendMessage).toHaveBeenCalledWith(
        100200300,
        expect.stringContaining('tg:skoobi_friend:777'),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        }),
      );
      expect(friendBot.api.sendMessage).not.toHaveBeenCalledWith(
        100200300,
        expect.any(String),
        expect.any(Object),
      );
    });

    it('approves persona-bot pending users from the default admin callback through the owning bot', async () => {
      const groups: Record<string, any> = {
        'tg:100200300': {
          name: 'Admin',
          folder: 'telegram_main',
          trigger: '@skoobi_bot',
          added_at: '2024-01-01T00:00:00.000Z',
          isMain: true,
          runtime: 'sandbox' as const,
        },
      };
      const registerGroup = vi.fn((jid: string, group: any) => {
        groups[jid] = group;
      });
      const baseOpts = createAdminOpts({
        registeredGroups: vi.fn(() => groups),
        registerGroup,
      });
      const defaultChannel = new TelegramChannel('default-token', baseOpts);
      await defaultChannel.connect();
      const defaultBot = currentBot();

      const friendChannel = new TelegramChannel('friend-token', {
        ...baseOpts,
        botId: 'skoobi_friend',
        personaId: 'friend',
      });
      defaultChannel.setPeerChannels([defaultChannel, friendChannel]);
      friendChannel.setPeerChannels([defaultChannel, friendChannel]);
      defaultChannel.setOwnerNotificationChannel(defaultChannel);
      friendChannel.setOwnerNotificationChannel(defaultChannel);
      await friendChannel.connect();
      const friendBot = currentBot();

      const startHandler = friendBot.commandHandlers.get('start')!;
      await startHandler({
        chat: { id: 777, type: 'private' as const },
        from: {
          id: 777,
          first_name: 'New',
          last_name: 'Friend',
          username: 'new_friend',
        },
        reply: vi.fn(),
      });
      await triggerCallbackQueryOn(friendBot, 'tglang:ru', {
        chat: { id: 777, type: 'private' as const },
        from: {
          id: 777,
          first_name: 'New',
          last_name: 'Friend',
          username: 'new_friend',
        },
        reply: vi.fn().mockResolvedValue(undefined),
      });

      defaultBot.api.sendMessage.mockClear();
      friendBot.api.sendMessage.mockClear();

      await triggerCallbackQueryOn(
        defaultBot,
        'tgaccess:approve:skoobi_friend:777',
        {
          chat: { id: 100200300, type: 'private' as const },
          from: { id: 100200300 },
        },
      );

      expect(registerGroup).toHaveBeenCalledWith(
        'tg:skoobi_friend:777',
        expect.objectContaining({
          agentConfig: expect.objectContaining({ personaId: 'friend' }),
        }),
      );
      expect(friendBot.api.sendMessage).toHaveBeenCalledWith(
        777,
        expect.stringContaining('Статус: подключён'),
      );
      expect(defaultBot.api.sendMessage).not.toHaveBeenCalledWith(
        777,
        expect.any(String),
      );
    });

    it('handles expired language callbacks without surfacing a bot error', async () => {
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const expired = new Error(
        "Call to 'answerCallbackQuery' failed! (400: Bad Request: query is too old and response timeout expired or query ID is invalid)",
      );
      const languageCtx = await triggerCallbackQuery('tglang:ru', {
        chat: { id: 779, type: 'private' as const },
        from: {
          id: 779,
          first_name: 'Slow',
          last_name: 'Click',
          username: 'slow_click',
        },
        answerCallbackQuery: vi.fn().mockRejectedValue(expired),
        reply: vi.fn().mockRejectedValue(new Error('ctx.reply should not run')),
      });

      expect(languageCtx.answerCallbackQuery).toHaveBeenCalled();
      expect(languageCtx.reply).not.toHaveBeenCalled();
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        779,
        expect.stringContaining('Заявка отправлена'),
        {},
      );
    });

    it('/subscribe explains that paid plans are disabled', async () => {
      const opts = createTestOpts({ onPlanPurchase: vi.fn() });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const handler = currentBot().commandHandlers.get('subscribe')!;
      const ctx = {
        chat: { id: 777, type: 'private' as const },
        from: { id: 777 },
        reply: vi.fn(),
      };
      await handler(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Платные тарифы и подписки отключены'),
        {},
      );
      expect(opts.onPlanPurchase).not.toHaveBeenCalled();
    });

    it('keeps onboarding active for an old payment start payload', async () => {
      const onPlanPurchase = vi.fn();
      const opts = createTestOpts({ onPlanPurchase });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const handler = currentBot().commandHandlers.get('start')!;
      const ctx = {
        match: 'pay_legacy',
        chat: { id: 777, type: 'private' as const },
        from: { id: 777, is_bot: false },
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await handler(ctx);

      expect(onPlanPurchase).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:777',
        expect.any(String),
        expect.any(String),
        'telegram',
        false,
      );
    });

    it('tapping a stale plan button does not create a payment', async () => {
      const onPlanPurchase = vi.fn().mockResolvedValue({
        resultUrl: 'https://checkout.example.invalid/order/ORD',
      });
      const opts = createTestOpts({ onPlanPurchase });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      const ctx = await triggerCallbackQuery('buy:legacy', {
        chat: { id: 777, type: 'private' as const },
        from: { id: 777 },
        reply: vi.fn().mockResolvedValue(undefined),
      });
      expect(onPlanPurchase).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Платные тарифы и подписки отключены'),
        {},
      );
    });

    it('/ping replies with bot status', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = { reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('skoobi_bot is online.', {});
    });

    it('/pending lists pending users with approval buttons for the main chat', async () => {
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      await requestAccessForUser();

      const handler = currentBot().commandHandlers.get('pending')!;
      const ctx = {
        chat: { id: 100200300, type: 'private' as const },
        from: { id: 100200300 },
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:777'),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        }),
      );
    });

    it.each([
      [
        'forwarded command',
        { forward_origin: { type: 'user', sender_user: { id: 777 } } },
      ],
      ['inline-bot command', { via_bot: { id: 321, is_bot: true } }],
    ])(
      'rejects an owner %s before privileged command handling',
      async (_name, metadata) => {
        const opts = createAdminOpts();
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        const handler = currentBot().commandHandlers.get('pending')!;
        const ctx = {
          chat: { id: 100200300, type: 'private' as const },
          from: { id: 100200300 },
          message: {
            text: '/pending',
            date: Math.floor(Date.now() / 1000),
            message_id: 9,
            entities: [{ type: 'bot_command', offset: 0, length: 8 }],
            ...metadata,
          },
          reply: vi.fn().mockResolvedValue(undefined),
        };

        await handler(ctx);

        expect(ctx.reply).toHaveBeenCalledWith(
          'Эта команда доступна только владельцу бота.',
          {},
        );
      },
    );

    it('sends operational admin alerts only to configured alert recipients', async () => {
      process.env.SKOOBI_TELEGRAM_ADMIN_ALERT_JIDS = 'tg:100000001';
      const opts = createAdminOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100000001': {
            name: 'Owner',
            folder: 'telegram_main',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
            isMain: true,
          },
          'tg:7000000002': {
            name: 'User A',
            folder: 'guest_example',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
            isMain: true,
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      currentBot().api.sendMessage.mockClear();

      (channel as any).notifyMainChats('system alert');

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        100000001,
        'system alert',
      );
      expect(currentBot().api.sendMessage).not.toHaveBeenCalledWith(
        7000000002,
        expect.any(String),
      );
    });

    it('logs unreachable pending-owner notifications as warn, not error', async () => {
      const opts = createAdminOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100000001': {
            name: 'Owner',
            folder: 'telegram_main',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
            isMain: true,
          },
          'tg:7000000002': {
            name: 'User A',
            folder: 'guest_example',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
            isMain: true,
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      currentBot().api.sendMessage.mockImplementation((chatId: number) => {
        if (chatId === 7000000002) {
          return Promise.reject({
            name: 'GrammyError',
            error_code: 400,
            description: 'Bad Request: chat not found',
          });
        }
        return Promise.resolve(undefined);
      });

      await requestAccessForUser();

      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerJid: 'tg:7000000002',
          applicantJid: 'tg:777',
        }),
        'Failed to notify owner about pending Telegram user',
      );
      expect(loggerMock.error).not.toHaveBeenCalledWith(
        expect.anything(),
        'Failed to notify owner about pending Telegram user',
      );
    });

    it('approves a pending Telegram user from an owner button', async () => {
      const registerGroup = vi.fn();
      const opts = createAdminOpts({
        registerGroup,
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Admin',
            folder: 'telegram_main',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
            isMain: true,
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      await requestAccessForUser();

      const cbCtx = await triggerCallbackQuery('tgaccess:approve:777');

      expect(registerGroup).toHaveBeenCalledWith(
        'tg:777',
        expect.objectContaining({
          name: 'New',
          folder: 'telegram_new_user',
          requiresTrigger: false,
          runtime: 'sandbox',
          agentConfig: expect.objectContaining({
            systemPrompt: expect.stringContaining('Relationship memory'),
          }),
        }),
      );
      const registeredGroup = registerGroup.mock.calls[0][1];
      expect(registeredGroup.agentConfig.systemPrompt).toContain(
        'memory_get with file="memory/topics/new-user-context.md"',
      );
      expect(registeredGroup.agentConfig.systemPrompt).toContain(
        'memory_save with category="topic" topic="new-user-context"',
      );
      const claudeMd = fs.readFileSync(
        '/tmp/claudeclaw-telegram-test-groups/telegram_new_user/CLAUDE.md',
        'utf-8',
      );
      expect(claudeMd).toContain('memory/topics/new-user-context.md');
      expect(claudeMd).toContain('category="topic"');
      expect(cbCtx.answerCallbackQuery).toHaveBeenCalledWith(
        'Пользователь активирован.',
      );
      expect(cbCtx.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Активировано'),
      );
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        777,
        expect.stringContaining('Статус: подключён'),
      );
    });

    it('treats a repeated approve callback as already activated', async () => {
      const registerGroup = vi.fn();
      const groups: Record<string, any> = {
        'tg:100200300': {
          name: 'Admin',
          folder: 'telegram_main',
          trigger: '@skoobi_bot',
          added_at: '2024-01-01T00:00:00.000Z',
          isMain: true,
        },
      };
      registerGroup.mockImplementation((jid, group) => {
        groups[jid] = group;
      });
      const registeredGroups = vi.fn(() => groups);
      const opts = createAdminOpts({ registerGroup, registeredGroups });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      await requestAccessForUser();

      const firstCtx = await triggerCallbackQuery('tgaccess:approve:777');
      const secondCtx = await triggerCallbackQuery('tgaccess:approve:777');

      expect(registerGroup).toHaveBeenCalledOnce();
      expect(firstCtx.answerCallbackQuery).toHaveBeenCalledWith(
        'Пользователь активирован.',
      );
      expect(secondCtx.answerCallbackQuery).toHaveBeenCalledWith(
        'Пользователь уже активирован.',
      );
      expect(secondCtx.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Активировано ранее'),
      );
    });

    it('reports already activated when an old approve button points to an existing group', async () => {
      const registerGroup = vi.fn();
      const registeredGroups = vi.fn(() => ({
        'tg:100200300': {
          name: 'Admin',
          folder: 'telegram_main',
          trigger: '@skoobi_bot',
          added_at: '2024-01-01T00:00:00.000Z',
          isMain: true,
        },
        'tg:777': {
          name: 'New',
          folder: 'telegram_new_user',
          trigger: '@skoobi_bot',
          added_at: '2024-01-02T00:00:00.000Z',
          runtime: 'sandbox' as const,
        },
      }));
      const opts = createAdminOpts({ registerGroup, registeredGroups });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      await requestAccessForUser();

      const cbCtx = await triggerCallbackQuery('tgaccess:approve:777');

      expect(cbCtx.answerCallbackQuery).toHaveBeenCalledWith(
        'Пользователь уже активирован.',
      );
      expect(cbCtx.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Активировано ранее'),
      );
      expect(registerGroup).not.toHaveBeenCalled();
    });

    it('rejects approval callbacks from non-owner users', async () => {
      const registerGroup = vi.fn();
      const opts = createAdminOpts({ registerGroup });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();
      await requestAccessForUser();

      const cbCtx = await triggerCallbackQuery('tgaccess:approve:777', {
        from: { id: 777 },
      });

      expect(registerGroup).not.toHaveBeenCalled();
      expect(cbCtx.answerCallbackQuery).toHaveBeenCalledWith(
        'Только владелец может подтверждать заявки.',
      );
    });

    it('/users lists Telegram users for the main chat', async () => {
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('users')!;
      const ctx = {
        chat: { id: 100200300, type: 'private' as const },
        from: { id: 100200300 },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Telegram users: 2'),
        {},
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:555'),
        {},
      );
    });

    it('/users requires Telegram from.id even in a main chat', async () => {
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('users')!;
      const ctx = {
        chat: { id: 100200300, type: 'private' as const },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('только владельцу'),
        {},
      );
      expect(hostDbMock.knownChatNames).not.toHaveBeenCalled();
    });

    it('/users rejects display-name spoofing without owner from.id', async () => {
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('users')!;
      const ctx = {
        chat: { id: 100200300, type: 'private' as const },
        from: { id: 555, first_name: 'Admin', username: 'owner' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('только владельцу'),
        {},
      );
      expect(hostDbMock.knownChatNames).not.toHaveBeenCalled();
    });

    it('/users prefers recovered DB names over technical tg IDs', async () => {
      hostDbMock.knownChatNames.mockReturnValueOnce([
        { jid: 'tg:555', name: 'Recovered Guest' },
      ]);
      const opts = createAdminOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Admin',
            folder: 'telegram_main',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
            isMain: true,
            runtime: 'sandbox' as const,
          },
          'tg:555': {
            name: 'tg:555',
            folder: 'telegram_guest',
            trigger: '@skoobi_bot',
            added_at: '2024-01-02T00:00:00.000Z',
            runtime: 'sandbox' as const,
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('users')!;
      const ctx = {
        chat: { id: 100200300, type: 'private' as const },
        from: { id: 100200300 },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Recovered Guest — tg:555'),
        {},
      );
    });

    it('/users rejects non-main chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('users')!;
      const ctx = {
        chat: { id: 100200300, type: 'private' as const },
        from: { id: 100200300 },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('только владельцу'),
        {},
      );
      expect(hostDbMock.knownChatNames).not.toHaveBeenCalled();
    });

    it('/lastseen reports DB activity for the main chat', async () => {
      hostDbMock.knownChatNames.mockReturnValueOnce([]);
      hostDbMock.chatsLastSeen.mockReturnValueOnce([
        {
          jid: 'tg:555',
          last_message_time: '2026-05-11T05:30:00.000Z',
        },
      ]);
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('lastseen')!;
      const ctx = {
        chat: { id: 100200300, type: 'private' as const },
        from: { id: 100200300 },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Последняя активность'),
        {},
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Guest: 11.05.2026'),
        {},
      );
    });

    it('/health reports process and queue status for the main chat', async () => {
      hostDbMock.messagesToday.mockReturnValueOnce(42);
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('health')!;
      const ctx = {
        chat: { id: 100200300, type: 'private' as const },
        from: { id: 100200300 },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Health: ok'),
        {},
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Messages today: 42'),
        {},
      );
    });

    it('/health allows global owner/admin allowlist users and rejects random callers', async () => {
      process.env.OWNER_TELEGRAM_USER_IDS = '100000001,7000000002';
      hostDbMock.messagesToday.mockReturnValue(7);
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100000001': {
            name: 'Owner',
            folder: 'telegram_main',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
            isMain: true,
          },
          'tg:7000000002': {
            name: 'User A',
            folder: 'guest_example',
            trigger: '@skoobi_bot',
            added_at: '2024-01-02T00:00:00.000Z',
            isMain: true,
          },
          'tg:555': {
            name: 'Random',
            folder: 'telegram_random',
            trigger: '@skoobi_bot',
            added_at: '2024-01-03T00:00:00.000Z',
            isMain: true,
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('health')!;
      const ownerCtx = {
        chat: { id: 100000001, type: 'private' as const },
        from: { id: 100000001, first_name: 'Owner' },
        reply: vi.fn(),
      };
      const userBCtx = {
        chat: { id: 7000000002, type: 'private' as const },
        from: { id: 7000000002, first_name: 'User B' },
        reply: vi.fn(),
      };
      const randomCtx = {
        chat: { id: 555, type: 'private' as const },
        from: { id: 555, first_name: 'Random' },
        reply: vi.fn(),
      };

      await handler(ownerCtx);
      await handler(userBCtx);
      await handler(randomCtx);

      expect(ownerCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Health: ok'),
        {},
      );
      expect(userBCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Health: ok'),
        {},
      );
      expect(randomCtx.reply).toHaveBeenCalledWith(
        'Эта команда доступна только владельцу бота.',
        {},
      );
    });

    it('/stats reports today online users and message totals without content', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
      process.env.SKOOBI_TELEGRAM_COMMAND_ADMIN_IDS = '777';
      hostDbMock.statsUsersToday.mockReturnValueOnce([
        { sender: '42', display_name: 'Alice', message_count: 2 },
        { sender: '43', display_name: 'Bob', message_count: 1 },
      ]);
      hostDbMock.statsTotalsToday.mockReturnValueOnce({
        user_messages: 3,
        bot_messages: 1,
      });
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('stats')!;
      const ctx = {
        chat: { id: 999, type: 'private' as const },
        from: { id: 777 },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(hostDbMock.statsUsersToday).toHaveBeenCalledWith(
        '2026-06-09T19:00:00.000Z',
      );
      expect(hostDbMock.statsTotalsToday).toHaveBeenCalledWith(
        '2026-06-09T19:00:00.000Z',
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Сегодня онлайн: 2 юзеров'),
        {},
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('1. Alice — 2 сообщений'),
        {},
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining(
          'Всего сообщений: 4 (от юзеров: 3, от бота: 1)',
        ),
        {},
      );
      expect(ctx.reply.mock.calls[0][0]).not.toContain('secret message');
    });

    it('/engine reports live engine structure without usage remainders', async () => {
      process.env.SKOOBI_TELEGRAM_COMMAND_ADMIN_IDS = '777';
      process.env.SKOOBI_MODEL_GATEWAY_TYPE = 'codex_subscription_cli';
      process.env.SKOOBI_CODEX_SUBSCRIPTION_ENABLED = 'true';
      process.env.SKOOBI_CODEX_MODEL = 'gpt-5.6-sol';
      process.env.SKOOBI_CODEX_FALLBACK_MODEL = 'gpt-5.6-terra';
      process.env.SKOOBI_CODEX_ALLOW_MODEL_DOWNGRADE = 'false';
      process.env.SKOOBI_CODEX_REASONING_EFFORT = 'xhigh';
      process.env.SKOOBI_QUOTA_DEGRADED_MODEL = 'gpt-5.6-terra';
      process.env.SKOOBI_SANDBOX_CODEX_PRIMARY = 'true';
      process.env.SKOOBI_CLAUDE_FALLBACK_ENABLED = 'false';
      const home = '/tmp/claudeclaw-telegram-test-home';
      const previousHome = process.env.HOME;
      process.env.HOME = home;
      fs.mkdirSync(`${home}/.codex`, { recursive: true });
      fs.writeFileSync(
        `${home}/.codex/config.toml`,
        'model = "gpt-5.2"\nmodel_fallback = "gpt-5.1"\n',
      );
      execFileMock.mockImplementation(
        (file: string, args: any, options: any, callback?: any) => {
          const cb = typeof options === 'function' ? options : callback;
          if (file === 'codex' && args?.[0] === '--version') {
            cb?.(null, 'codex 1.0.0', '');
            return {} as any;
          }
          if (
            file === 'codex' &&
            args?.[0] === 'login' &&
            args?.[1] === 'status'
          ) {
            cb?.(null, 'Logged in as test@example.com', '');
            return {} as any;
          }
          cb?.(null, '', '');
          return {} as any;
        },
      );
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:999': {
            name: 'Admin Chat',
            folder: 'admin-chat',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
            agentConfig: { model: 'claude-sonnet-4-5' },
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('engine')!;
      const ctx = {
        chat: { id: 999, type: 'private' as const },
        from: { id: 777 },
        reply: vi.fn(),
      };

      try {
        await handler(ctx);
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }

      const reply = ctx.reply.mock.calls[0][0] as string;
      expect(reply).toContain('Движок чата');
      expect(reply).toContain('├ Активный LLM: OpenAI Codex');
      expect(reply).toContain('│   модель: gpt-5.6-sol');
      expect(reply).toContain('│   reasoning: xhigh');
      expect(reply).toContain('│   маршрут: full-agent');
      expect(reply).toContain('├ Degraded: gpt-5.6-terra');
      expect(reply).toContain('├ Codex fallback: выключен');
      expect(reply).toContain(
        '└ Claude fallback: выключен; legacy preset: claude-sonnet-4-5',
      );
      expect(reply).toContain('│   статус Codex: включена');
      expect(reply).not.toContain('осталось');
    });

    it('reports a per-group full-agent route only while the global kill switch is enabled', () => {
      process.env.SKOOBI_MODEL_GATEWAY_TYPE = 'codex_subscription_cli';
      process.env.SKOOBI_CODEX_SUBSCRIPTION_ENABLED = 'true';
      process.env.SKOOBI_CODEX_MODEL = 'gpt-5.6-sol';
      process.env.SKOOBI_TELEGRAM_OWNER_LIVE_ENABLED = 'true';
      process.env.SKOOBI_CODEX_OWNER_FULL_AGENT_ENABLED = 'true';
      const group = {
        isMain: true,
        agentConfig: { codexFullAgentPrimary: true },
      };

      expect(readSkoobiEngineRuntimeStatus(group).route).toBe(
        'full-agent для этого owner-чата',
      );
      process.env.SKOOBI_CODEX_OWNER_FULL_AGENT_ENABLED = 'false';
      expect(readSkoobiEngineRuntimeStatus(group).route).toBe('live для owner');
    });

    it('/status reports the effective Codex model instead of hardcoded Opus', async () => {
      process.env.SKOOBI_MODEL_GATEWAY_TYPE = 'codex_subscription_cli';
      process.env.SKOOBI_CODEX_SUBSCRIPTION_ENABLED = 'true';
      process.env.SKOOBI_CODEX_MODEL = 'gpt-5.6-sol';
      process.env.SKOOBI_SANDBOX_CODEX_PRIMARY = 'true';
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('status')!;
      const ctx = {
        chat: { id: 100200300, type: 'private' as const },
        from: { id: 100200300 },
        reply: vi.fn(),
      };

      await handler(ctx);

      const reply = ctx.reply.mock.calls[0][0] as string;
      expect(reply).toContain('LLM: `gpt-5.6-sol via Codex');
      expect(reply).not.toContain('Opus 4.8');
    });

    it('/stats rejects non-admin command callers', async () => {
      const opts = createAdminOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('stats')!;
      const ctx = {
        chat: { id: 100200300, type: 'private' as const },
        from: { id: 555, first_name: 'Guest' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        'Команда доступна только админу.',
        {},
      );
      expect(hostDbMock.statsUsersToday).not.toHaveBeenCalled();
    });
  });

  // --- Owner-only command + callback hardening ---

  describe('/storage folder guard (path traversal)', () => {
    function ownerCtx(arg: string) {
      return {
        chat: { id: 100200300, type: 'private' as const },
        from: { id: 100200300 },
        match: arg,
        reply: vi.fn().mockResolvedValue(undefined),
      };
    }

    it('rejects a path-traversal folder arg without calling storageForFolder', async () => {
      const channel = new TelegramChannel('test-token', createAdminOpts());
      await channel.connect();

      const handler = currentBot().commandHandlers.get('storage')!;
      const ctx = ownerCtx('../../../../etc');
      await handler(ctx);
      // flush replySafely's deferred ctx.reply microtask
      await new Promise((r) => setTimeout(r, 0));

      expect(adminStorageMock.storageForFolder).not.toHaveBeenCalled();
      expect(adminStorageMock.storageOverview).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Недопустимое имя папки'),
        {},
      );
    });

    it('rejects folder args containing slashes or backslashes', async () => {
      const channel = new TelegramChannel('test-token', createAdminOpts());
      await channel.connect();

      const handler = currentBot().commandHandlers.get('storage')!;
      for (const bad of ['a/b', 'a\\b', '..', 'foo/../bar']) {
        adminStorageMock.storageForFolder.mockClear();
        await handler(ownerCtx(bad));
        expect(adminStorageMock.storageForFolder).not.toHaveBeenCalled();
      }
    });

    it('still serves a valid folder name through storageForFolder', async () => {
      adminStorageMock.storageForFolder.mockResolvedValue(
        'Storage / test-group',
      );
      const channel = new TelegramChannel('test-token', createAdminOpts());
      await channel.connect();

      const handler = currentBot().commandHandlers.get('storage')!;
      const ctx = ownerCtx('test-group');
      await handler(ctx);
      await new Promise((r) => setTimeout(r, 0));

      expect(adminStorageMock.storageForFolder).toHaveBeenCalledWith(
        expect.any(String),
        'test-group',
      );
      expect(ctx.reply).toHaveBeenCalledWith('Storage / test-group', {});
    });

    it('serves the overview when no folder arg is given', async () => {
      adminStorageMock.storageOverview.mockResolvedValue('overview');
      const channel = new TelegramChannel('test-token', createAdminOpts());
      await channel.connect();

      const handler = currentBot().commandHandlers.get('storage')!;
      await handler(ownerCtx(''));

      expect(adminStorageMock.storageOverview).toHaveBeenCalled();
      expect(adminStorageMock.storageForFolder).not.toHaveBeenCalled();
    });
  });

  describe('quota callback error handler swallows expired-query errors', () => {
    it('does not rethrow when answering an expired callback in the catch path', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();

      // Force the QUOTA_CALLBACK_RE handler into its catch block.
      vi.spyOn(channel as any, 'sendQuotaStatus').mockRejectedValue(
        new Error('boom'),
      );

      // The error-path answerCallbackQuery itself fails because the underlying
      // callback query already expired. The fixed handler routes this through
      // answerCallbackQueryIfPresent, which swallows expired-query errors; the
      // buggy direct ctx.answerCallbackQuery call would rethrow it.
      const answerCallbackQuery = vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Call to 'answerCallbackQuery' failed! (400: Bad Request: query is too old and response timeout expired)",
          ),
        );

      await expect(
        triggerCallbackQuery('quota:my_limit', { answerCallbackQuery }),
      ).resolves.toBeDefined();

      expect(answerCallbackQuery).toHaveBeenCalledWith(
        'Не смог показать статус доступа. См. логи.',
      );
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.name).toBe('telegram');
    });
  });
});
