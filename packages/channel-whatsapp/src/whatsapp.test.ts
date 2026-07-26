import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mocks ---

const mediaManifestMock = vi.hoisted(() => ({
  append: vi.fn().mockResolvedValue(undefined),
}));

// Mock channel config (пакетная реплика core-config, волна 7d)
vi.mock('./channel-config.js', () => ({
  STORE_DIR: '/tmp/claudeclaw-test-store',
  ASSISTANT_NAME: 'skoobi_bot',
  ASSISTANT_HAS_OWN_NUMBER: false,
  WHATSAPP_PERSONAL_OBSERVER: {
    enabled: false,
    ownerFolder: 'whatsapp_main',
    retentionDays: 90,
    maxRows: 50_000,
  },
}));

vi.mock('./auth-storage.js', () => ({
  secureAuthDirectory: vi.fn(),
}));

// Mock logger
vi.mock('@skoobi/shared/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@skoobi/shared/group-folder', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/claudeclaw-test-groups/${folder}`,
  ),
}));

vi.mock('@skoobi/shared/media-manifest', () => ({
  appendMediaEntry: mediaManifestMock.append,
}));

// Host-фейки: с волны 7d канал получает БД-операции (имена чатов, метка
// последнего group-sync) через инжектируемый WhatsAppChannelHost, а не через
// импорты ядра (исторический мок ../orchestrator/db.js) — тесты собирают host
// из этих же hoisted-моков (createTestOpts).
const hostMock = vi.hoisted(() => ({
  getLastGroupSync: vi.fn((): string | null => null),
  setLastGroupSync: vi.fn(),
  updateChatName: vi.fn(),
  isOwnerMediaSender: vi.fn(() => false),
  onObservedMessage: vi.fn(),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
    },
  };
});

// Mock child_process (used for osascript notification)
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

// Build a fake WASocket that's an EventEmitter with the methods we need
function createFakeSocket() {
  const ev = new EventEmitter();
  const sock = {
    ev: {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        ev.on(event, handler);
      },
      emit: (event: string, payload: unknown) => ev.emit(event, payload),
    },
    user: {
      id: '1234567890:1@s.whatsapp.net',
      lid: '9876543210:1@lid',
    },
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    fetchMessageHistory: vi.fn().mockResolvedValue('history-request-1'),
    groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
    end: vi.fn(),
    // Expose the event emitter for triggering events in tests
    _ev: ev,
  };
  return sock;
}

let fakeSocket: ReturnType<typeof createFakeSocket>;

// Mock Baileys
vi.mock('@whiskeysockets/baileys', () => {
  return {
    default: vi.fn(() => fakeSocket),
    Browsers: { macOS: vi.fn(() => ['macOS', 'Chrome', '']) },
    DisconnectReason: {
      loggedOut: 401,
      badSession: 500,
      connectionClosed: 428,
      connectionLost: 408,
      connectionReplaced: 440,
      timedOut: 408,
      restartRequired: 515,
    },
    fetchLatestWaWebVersion: vi
      .fn()
      .mockResolvedValue({ version: [2, 3000, 0] }),
    jidNormalizedUser: vi.fn((jid?: string) => {
      if (!jid) return '';
      const [user, server] = jid.split('@');
      return `${user.split(':')[0]}@${server}`;
    }),
    normalizeMessageContent: vi.fn((content: unknown) => content),
    makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
    useMultiFileAuthState: vi.fn().mockResolvedValue({
      state: {
        creds: {},
        keys: {},
      },
      saveCreds: vi.fn(),
    }),
  };
});

// Mock media helpers — tests configure return values per-case to avoid
// real Baileys decryption / whisper-cli execution.
vi.mock('./whatsapp-media.js', () => ({
  downloadWhatsappMedia: vi.fn(),
}));
vi.mock('./whatsapp-video.js', () => ({
  processDownloadedWhatsappVideo: vi.fn(),
}));
vi.mock('./local-vision.js', () => ({
  analyzeImageLocally: vi.fn().mockResolvedValue(null),
  formatLocalVisualDescription: vi.fn(() => ''),
}));
vi.mock('./local-document.js', () => ({
  extractDocumentTextLocally: vi.fn().mockResolvedValue(null),
}));
vi.mock('@skoobi/voice-stt', () => ({
  transcribeAudioFile: vi.fn(),
}));

import {
  WhatsAppChannel,
  WhatsAppChannelOpts,
  type WhatsAppObserverMediaBackfillProgress,
} from './whatsapp.js';
import { downloadWhatsappMedia } from './whatsapp-media.js';
import { transcribeAudioFile } from '@skoobi/voice-stt';
import { processDownloadedWhatsappVideo } from './whatsapp-video.js';
import {
  analyzeImageLocally,
  formatLocalVisualDescription,
} from './local-vision.js';
import { extractDocumentTextLocally } from './local-document.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<WhatsAppChannelOpts>,
): WhatsAppChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'registered@g.us': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@skoobi_bot',
        added_at: '2024-01-01T00:00:00.000Z',
        // Default test group opts in to media ingestion so the 3.5M media
        // tests below see the new behaviour. The 3.5G gated tests override
        // this to validate the legacy drop-on-empty path.
        agentConfig: { mediaIngestion: true },
      },
    })),
    host: hostMock,
    ...overrides,
  };
}

function triggerConnection(state: string, extra?: Record<string, unknown>) {
  fakeSocket._ev.emit('connection.update', { connection: state, ...extra });
}

function triggerDisconnect(statusCode: number) {
  fakeSocket._ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: {
      error: { output: { statusCode } },
    },
  });
}

async function triggerMessages(messages: unknown[], type: string = 'notify') {
  const listeners = fakeSocket._ev.listeners('messages.upsert');
  await Promise.all(
    listeners.map((listener) =>
      Promise.resolve(listener.call(fakeSocket._ev, { messages, type })),
    ),
  );
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for state');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// --- Tests ---

describe('WhatsAppChannel', () => {
  beforeEach(() => {
    // Clear mock call history between tests so toHaveBeenCalled assertions
    // don't see leftover calls from previous tests' media-ingestion paths.
    // (mockResolvedValueOnce consumes implementation but does NOT clear
    // mock.calls.)
    vi.clearAllMocks();
    vi.mocked(downloadWhatsappMedia).mockReset().mockResolvedValue(null);
    vi.mocked(transcribeAudioFile).mockReset().mockResolvedValue(null);
    vi.mocked(processDownloadedWhatsappVideo).mockReset();
    vi.mocked(analyzeImageLocally).mockReset().mockResolvedValue(null);
    vi.mocked(extractDocumentTextLocally).mockReset().mockResolvedValue(null);
    vi.mocked(formatLocalVisualDescription)
      .mockReset()
      .mockImplementation((description) =>
        description
          ? [
              description.text.length > 0
                ? `Распознанный текст: ${description.text.join(' / ')}`
                : '',
              description.labels.length > 0
                ? `Объекты/сцена: ${description.labels.join(', ')}`
                : '',
            ]
              .filter(Boolean)
              .join('. ')
          : '',
      );
    fakeSocket = createFakeSocket();
    hostMock.getLastGroupSync.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: start connect, flush microtasks so event handlers are registered,
   * then trigger the connection open event. Returns the resolved promise.
   */
  async function connectChannel(channel: WhatsAppChannel): Promise<void> {
    const p = channel.connect();
    // Flush microtasks so connectInternal completes its await and registers handlers
    await new Promise((r) => setTimeout(r, 0));
    triggerConnection('open');
    return p;
  }

  // --- Version fetch ---

  describe('version fetch', () => {
    it('connects with fetched version', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      const { fetchLatestWaWebVersion } =
        await import('@whiskeysockets/baileys');
      expect(fetchLatestWaWebVersion).toHaveBeenCalledWith({});
      const { default: makeWASocket } = await import('@whiskeysockets/baileys');
      const socketConfig = vi.mocked(makeWASocket).mock.calls[0][0];
      expect(socketConfig.logger).not.toBe(
        (await import('@skoobi/shared/logger')).logger,
      );
      expect(socketConfig.logger!.level).toBe('warn');
    });

    it('falls back gracefully when version fetch fails', async () => {
      const { fetchLatestWaWebVersion } =
        await import('@whiskeysockets/baileys');
      vi.mocked(fetchLatestWaWebVersion).mockRejectedValueOnce(
        new Error('network error'),
      );

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      // Should still connect successfully despite fetch failure
      expect(channel.isConnected()).toBe(true);
    });

    it('never forwards raw Baileys session, key, or JID payloads to the app logger', async () => {
      const channel = new WhatsAppChannel(createTestOpts());
      await connectChannel(channel);
      const { default: makeWASocket } = await import('@whiskeysockets/baileys');
      const socketConfig = vi.mocked(makeWASocket).mock.calls[0][0];
      const privateLogger = socketConfig.logger!;
      privateLogger.warn(
        {
          session: 'SessionEntry PRIVATE_SESSION',
          key: Buffer.from('PRIVATE_KEY_BYTES'),
          jid: 'private-number@s.whatsapp.net',
        },
        'transport warning with private payload',
      );

      const { logger } = await import('@skoobi/shared/logger');
      expect(logger.warn).toHaveBeenCalledWith(
        { source: 'baileys' },
        'WhatsApp transport warning',
      );
      const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
      expect(logged).not.toContain('PRIVATE_SESSION');
      expect(logged).not.toContain('PRIVATE_KEY_BYTES');
      expect(logged).not.toContain('private-number');
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when connection opens', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      expect(channel.isConnected()).toBe(true);
    });

    it('sets up LID to phone mapping on open', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // The channel should have mapped the LID from sock.user
      // We can verify by sending a message from a LID JID
      // and checking the translated JID in the callback
    });

    it('does not acknowledge a response while disconnected', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Disconnect
      (channel as any).connected = false;

      await expect(
        channel.sendMessage('test@g.us', 'Undelivered message'),
      ).rejects.toThrow('WhatsApp is disconnected');
      expect(fakeSocket.sendMessage).not.toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(fakeSocket.end).toHaveBeenCalled();
    });
  });

  // --- QR code and auth ---

  describe('authentication', () => {
    it('rejects only the channel connection when QR is emitted', async () => {
      const mockExit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      const connecting = channel.connect();

      // Flush microtasks so connectInternal registers handlers
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Emit QR code event
      fakeSocket._ev.emit('connection.update', { qr: 'some-qr-data' });

      await expect(connecting).rejects.toThrow(
        'WhatsApp authentication required',
      );
      expect(mockExit).not.toHaveBeenCalled();
      mockExit.mockRestore();
    });
  });

  // --- Reconnection behavior ---

  describe('reconnection', () => {
    it('reconnects on non-loggedOut disconnect', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      expect(channel.isConnected()).toBe(true);

      // Disconnect with a non-loggedOut reason (e.g., connectionClosed = 428)
      triggerDisconnect(428);

      expect(channel.isConnected()).toBe(false);
      // The channel should attempt to reconnect (calls connectInternal again)
    });

    it('does not exit the host process on loggedOut disconnect', async () => {
      const mockExit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Disconnect with loggedOut reason (401)
      triggerDisconnect(401);

      expect(channel.isConnected()).toBe(false);
      expect(mockExit).not.toHaveBeenCalled();
      mockExit.mockRestore();
    });

    it('retries reconnection after 5s on failure', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Disconnect with stream error 515
      triggerDisconnect(515);

      // The channel sets a 5s retry — just verify it doesn't crash
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-1',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { conversation: 'Hello skoobi_bot' },
          pushName: 'Alice',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'registered@g.us',
        expect.any(String),
        undefined,
        'whatsapp',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          id: 'msg-1',
          content: 'Hello skoobi_bot',
          sender_name: 'Alice',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered groups', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-2',
            remoteJid: 'unregistered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { conversation: 'Hello' },
          pushName: 'Bob',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'unregistered@g.us',
        expect.any(String),
        undefined,
        'whatsapp',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores status@broadcast messages', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-3',
            remoteJid: 'status@broadcast',
            fromMe: false,
          },
          message: { conversation: 'Status update' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores messages with no content', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-4',
            remoteJid: 'registered@g.us',
            fromMe: false,
          },
          message: null,
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('extracts text from extendedTextMessage', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-5',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            extendedTextMessage: { text: 'A reply message' },
          },
          pushName: 'Charlie',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({ content: 'A reply message' }),
      );
    });

    it('downloads image and surfaces saved path with caption', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/test-group/received/2026-04-28T12-00-00-000Z-image-12345678.jpg',
        filename: '2026-04-28T12-00-00-000Z-image-12345678.jpg',
        originalName: null,
        mimetype: 'image/jpeg',
      });

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-6',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            imageMessage: {
              caption: 'Check this photo',
              mimetype: 'image/jpeg',
            },
          },
          pushName: 'Diana',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(downloadWhatsappMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          key: expect.objectContaining({ id: 'msg-6' }),
        }),
        'test-group',
        'image',
        { tier: 'guest', tenantId: 'test-group' },
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content:
            '[Photo saved as received/2026-04-28T12-00-00-000Z-image-12345678.jpg. Caption: Check this photo]',
        }),
      );
      expect(mediaManifestMock.append).toHaveBeenCalledWith(
        '/tmp/claudeclaw-test-groups/test-group',
        expect.objectContaining({
          message_id: 'msg-6',
          chat_jid: 'registered@g.us',
          basename: '2026-04-28T12-00-00-000Z-image-12345678.jpg',
          type: 'photo',
          has_caption: true,
          has_transcript: false,
          keep: false,
        }),
      );
    });

    it('keeps a co-member media message in a main group on guest resource limits', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/test-group/received/co-member.jpg',
        filename: 'co-member.jpg',
        originalName: null,
        mimetype: 'image/jpeg',
      });
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'registered@g.us': {
            name: 'Main Group',
            folder: 'test-group',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
            isMain: true,
            agentConfig: { mediaIngestion: true },
          },
        })),
      });
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-main-co-member',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { imageMessage: { mimetype: 'image/jpeg' } },
          pushName: 'Co-member',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(hostMock.isOwnerMediaSender).toHaveBeenCalledWith({
        chatJid: 'registered@g.us',
        senderJid: '5551234@s.whatsapp.net',
        fromMe: false,
      });
      expect(downloadWhatsappMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          key: expect.objectContaining({ id: 'msg-main-co-member' }),
        }),
        'test-group',
        'image',
        { tier: 'guest', tenantId: 'test-group' },
      );
    });

    it('preserves owner reserve for a host-authorized sender in the main group', async () => {
      hostMock.isOwnerMediaSender.mockReturnValueOnce(true);
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/test-group/received/owner.jpg',
        filename: 'owner.jpg',
        originalName: null,
        mimetype: 'image/jpeg',
      });
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'registered@g.us': {
            name: 'Main Group',
            folder: 'test-group',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
            isMain: true,
            agentConfig: { mediaIngestion: true },
          },
        })),
      });
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-main-owner',
            remoteJid: 'registered@g.us',
            participant: '7770000@s.whatsapp.net',
            fromMe: true,
          },
          message: { imageMessage: { mimetype: 'image/jpeg' } },
          pushName: 'Owner',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(downloadWhatsappMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          key: expect.objectContaining({ id: 'msg-main-owner' }),
        }),
        'test-group',
        'image',
        { tier: 'owner', tenantId: 'test-group' },
      );
    });

    it('downloads image without caption and surfaces saved path only', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/test-group/received/2026-04-28T12-00-00-000Z-image-aaaaaaaa.jpg',
        filename: '2026-04-28T12-00-00-000Z-image-aaaaaaaa.jpg',
        originalName: null,
        mimetype: 'image/jpeg',
      });

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-6b',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            imageMessage: { mimetype: 'image/jpeg' },
          },
          pushName: 'Diana',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content:
            '[Photo saved as received/2026-04-28T12-00-00-000Z-image-aaaaaaaa.jpg]',
        }),
      );
    });

    it('still delivers successful owner media when manifest append fails', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/test-group/received/owner-photo.jpg',
        filename: 'owner-photo.jpg',
        originalName: null,
        mimetype: 'image/jpeg',
      });
      mediaManifestMock.append.mockRejectedValueOnce(
        new Error('manifest temporarily unavailable'),
      );

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);
      await triggerMessages([
        {
          key: {
            id: 'msg-manifest-failure',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            imageMessage: { caption: 'Owner photo', mimetype: 'image/jpeg' },
          },
          pushName: 'Owner',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(mediaManifestMock.append).toHaveBeenCalledOnce();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content:
            '[Photo saved as received/owner-photo.jpg. Caption: Owner photo]',
        }),
      );
    });

    it('falls back to "download failed" placeholder when image download returns null', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce(null);

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-6c',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            imageMessage: {
              caption: 'Check this photo',
              mimetype: 'image/jpeg',
            },
          },
          pushName: 'Diana',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content: '[Image — download failed. Caption: Check this photo]',
        }),
      );
      expect(mediaManifestMock.append).not.toHaveBeenCalled();
    });

    it('extracts caption from videoMessage', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-7',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            videoMessage: { caption: 'Watch this', mimetype: 'video/mp4' },
          },
          pushName: 'Eve',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content: '[Video — download failed. Caption: Watch this]',
        }),
      );
    });

    it('downloads voice note and surfaces transcript with saved path', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/test-group/received/2026-04-28T12-00-00-000Z-voice-bbbbbbbb.oga',
        filename: '2026-04-28T12-00-00-000Z-voice-bbbbbbbb.oga',
        originalName: null,
        mimetype: 'audio/ogg; codecs=opus',
      });
      vi.mocked(transcribeAudioFile).mockResolvedValueOnce(
        'Поликарбонат четыре миллиметра',
      );

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-8',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true },
          },
          pushName: 'Frank',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(downloadWhatsappMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          key: expect.objectContaining({ id: 'msg-8' }),
        }),
        'test-group',
        'voice',
        { tier: 'guest', tenantId: 'test-group' },
      );
      // No language argument: the common voice-stt default is auto-detection.
      expect(transcribeAudioFile).toHaveBeenCalledTimes(1);
      expect(transcribeAudioFile).toHaveBeenCalledWith(
        '/tmp/test-group/received/2026-04-28T12-00-00-000Z-voice-bbbbbbbb.oga',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content: '[Voice; local transcript: Поликарбонат четыре миллиметра]',
        }),
      );
      expect(mediaManifestMock.append).toHaveBeenCalledWith(
        '/tmp/claudeclaw-test-groups/test-group',
        expect.objectContaining({
          message_id: 'msg-8',
          chat_jid: 'registered@g.us',
          type: 'voice',
          has_transcript: true,
          transcript_chars: 'Поликарбонат четыре миллиметра'.length,
          has_caption: false,
        }),
      );
    });

    it('treats audioMessage without ptt as audio (auto language) and delivers transcript', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/test-group/received/2026-04-28T12-00-00-000Z-audio-cccccccc.mp3',
        filename: '2026-04-28T12-00-00-000Z-audio-cccccccc.mp3',
        originalName: null,
        mimetype: 'audio/mpeg',
      });
      vi.mocked(transcribeAudioFile).mockResolvedValueOnce('audio transcript');

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-8b',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            audioMessage: { mimetype: 'audio/mpeg' },
          },
          pushName: 'Frank',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(downloadWhatsappMedia).toHaveBeenCalledWith(
        expect.anything(),
        'test-group',
        'audio',
        { tier: 'guest', tenantId: 'test-group' },
      );
      // Generic audio uses the same shared auto-detect default as voice notes.
      expect(transcribeAudioFile).toHaveBeenCalledTimes(1);
      expect(transcribeAudioFile).toHaveBeenCalledWith(
        '/tmp/test-group/received/2026-04-28T12-00-00-000Z-audio-cccccccc.mp3',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content: '[Audio; local transcript: audio transcript]',
        }),
      );
    });

    it('falls back when voice transcription returns null', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/test-group/received/2026-04-28T12-00-00-000Z-voice-dddddddd.oga',
        filename: '2026-04-28T12-00-00-000Z-voice-dddddddd.oga',
        originalName: null,
        mimetype: 'audio/ogg; codecs=opus',
      });
      vi.mocked(transcribeAudioFile).mockResolvedValueOnce(null);

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-8c',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true },
          },
          pushName: 'Frank',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content: '[Voice; local transcription failed]',
        }),
      );
      expect(mediaManifestMock.append).toHaveBeenCalledWith(
        '/tmp/claudeclaw-test-groups/test-group',
        expect.objectContaining({
          message_id: 'msg-8c',
          type: 'voice',
          has_transcript: false,
          transcript_chars: 0,
        }),
      );
    });

    it('downloads document and surfaces original filename', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/test-group/received/2026-04-28T12-00-00-000Z-eeeeeeee-pricelist.xlsx',
        filename: '2026-04-28T12-00-00-000Z-eeeeeeee-pricelist.xlsx',
        originalName: 'pricelist.xlsx',
        mimetype:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-8d',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            documentMessage: {
              fileName: 'pricelist.xlsx',
              mimetype:
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            },
          },
          pushName: 'Frank',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(downloadWhatsappMedia).toHaveBeenCalledWith(
        expect.anything(),
        'test-group',
        'document',
        { tier: 'guest', tenantId: 'test-group' },
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content:
            '[Document "pricelist.xlsx" saved as received/2026-04-28T12-00-00-000Z-eeeeeeee-pricelist.xlsx.]',
        }),
      );
      expect(mediaManifestMock.append).toHaveBeenCalledWith(
        '/tmp/claudeclaw-test-groups/test-group',
        expect.objectContaining({
          message_id: 'msg-8d',
          type: 'document',
          has_caption: false,
          has_transcript: false,
        }),
      );
    });

    it('skips media when group has no agentConfig.mediaIngestion (legacy drop-on-empty)', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'registered@g.us': {
            name: 'Test Group',
            folder: 'test-group',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
            // No agentConfig at all → mediaIngestion is undefined → gate off.
          },
        })),
      });
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-gate-1',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true },
          },
          pushName: 'Frank',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(downloadWhatsappMedia).not.toHaveBeenCalled();
      expect(transcribeAudioFile).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('with mediaIngestion=false, image-with-caption falls back to caption text only (pre-3.5M behaviour)', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'registered@g.us': {
            name: 'Test Group',
            folder: 'test-group',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
            agentConfig: { mediaIngestion: false },
          },
        })),
      });
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-gate-2',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            imageMessage: {
              caption: 'Check this photo',
              mimetype: 'image/jpeg',
            },
          },
          pushName: 'Diana',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      // Gate off → no download attempted; caption survives via the
      // text-fallback path (matches pre-3.5M behaviour exactly).
      expect(downloadWhatsappMedia).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({ content: 'Check this photo' }),
      );
    });

    it('uses sender JID when pushName is absent', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-9',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { conversation: 'No push name' },
          // pushName is undefined
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({ sender_name: '5551234' }),
      );
    });

    // --- Media-placeholder bot-message regression ---
    // Media placeholders begin with `[` (e.g. `[Image saved at …]`) so the
    // earlier `/^\[.+?\]/` heuristic mis-flagged them as bot messages, which
    // then caused getNewMessages to filter them out before the agent saw them.

    it('does not flag image media placeholder as bot message', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/test-group/received/2026-04-28T12-00-00-000Z-image-ffffffff.jpg',
        filename: '2026-04-28T12-00-00-000Z-image-ffffffff.jpg',
        originalName: null,
        mimetype: 'image/jpeg',
      });

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-bot-1',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            imageMessage: { caption: 'photo', mimetype: 'image/jpeg' },
          },
          pushName: 'Diana',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content: expect.stringMatching(/^\[Photo saved as /),
          is_bot_message: false,
        }),
      );
    });

    it('does not flag voice media placeholder as bot message', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/test-group/received/2026-04-28T12-00-00-000Z-voice-ffffffff.oga',
        filename: '2026-04-28T12-00-00-000Z-voice-ffffffff.oga',
        originalName: null,
        mimetype: 'audio/ogg; codecs=opus',
      });
      vi.mocked(transcribeAudioFile).mockResolvedValueOnce('hello world');

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-bot-2',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true },
          },
          pushName: 'Frank',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content: expect.stringMatching(/^\[Voice; local transcript:/),
          is_bot_message: false,
        }),
      );
    });

    it('does not flag audio media placeholder as bot message', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/test-group/received/2026-04-28T12-00-00-000Z-audio-ffffffff.mp3',
        filename: '2026-04-28T12-00-00-000Z-audio-ffffffff.mp3',
        originalName: null,
        mimetype: 'audio/mpeg',
      });
      vi.mocked(transcribeAudioFile).mockResolvedValueOnce('a transcript');

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-bot-3',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            audioMessage: { mimetype: 'audio/mpeg' },
          },
          pushName: 'Frank',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content: expect.stringMatching(/^\[Audio; local transcript:/),
          is_bot_message: false,
        }),
      );
    });

    it('does not flag document media placeholder as bot message', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/test-group/received/2026-04-28T12-00-00-000Z-ffffffff-pricelist.xlsx',
        filename: '2026-04-28T12-00-00-000Z-ffffffff-pricelist.xlsx',
        originalName: 'pricelist.xlsx',
        mimetype:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-bot-4',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            documentMessage: {
              fileName: 'pricelist.xlsx',
              mimetype:
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            },
          },
          pushName: 'Frank',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content: expect.stringMatching(/^\[Document /),
          is_bot_message: false,
        }),
      );
    });

    it('flags an authenticated fromMe + [skoobi_bot] prefixed text as bot message', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-bot-5',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: true,
          },
          message: { conversation: '[skoobi_bot] 🧊 reply text' },
          pushName: 'skoobi_bot',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content: '[skoobi_bot] 🧊 reply text',
          is_bot_message: true,
        }),
      );
    });

    it('does not let a contact spoof the shared-number bot prefix', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-bot-spoof',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { conversation: '[skoobi_bot] 🧊 forged reply' },
          pushName: 'Mallory',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({ is_bot_message: false }),
      );
    });

    // A bracketed prefix from an unknown bot name must remain user content.
    // Otherwise legitimate media placeholders and similarly formatted text
    // can be filtered out before the agent sees them.
    it('does not flag unknown bracketed prefix as bot message', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-bot-6',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { conversation: '[Some Random Bot] hello' },
          pushName: 'Other',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          content: '[Some Random Bot] hello',
          is_bot_message: false,
        }),
      );
    });
  });

  // --- LID ↔ JID translation ---

  describe('LID to JID translation', () => {
    it('translates known LID to phone JID', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          '1234567890@s.whatsapp.net': {
            name: 'Self Chat',
            folder: 'self-chat',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // The socket has lid '9876543210:1@lid' → phone '1234567890@s.whatsapp.net'
      // Send a message from the LID
      await triggerMessages([
        {
          key: {
            id: 'msg-lid',
            remoteJid: '9876543210@lid',
            fromMe: false,
          },
          message: { conversation: 'From LID' },
          pushName: 'Self',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      // Should be translated to phone JID
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        '1234567890@s.whatsapp.net',
        expect.any(String),
        undefined,
        'whatsapp',
        false,
      );
    });

    it('passes through non-LID JIDs unchanged', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-normal',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { conversation: 'Normal JID' },
          pushName: 'Grace',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'registered@g.us',
        expect.any(String),
        undefined,
        'whatsapp',
        true,
      );
    });

    it('passes through unknown LID JIDs unchanged', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-unknown-lid',
            remoteJid: '0000000000@lid',
            fromMe: false,
          },
          message: { conversation: 'Unknown LID' },
          pushName: 'Unknown',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      // Unknown LID passes through unchanged
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        '0000000000@lid',
        expect.any(String),
        undefined,
        'whatsapp',
        false,
      );
    });
  });

  // --- Outgoing delivery acknowledgement ---

  describe('outgoing delivery acknowledgement', () => {
    it('sends message directly when connected', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.sendMessage('test@g.us', 'Hello');
      // Group messages get prefixed with assistant name
      expect(fakeSocket.sendMessage).toHaveBeenCalledWith('test@g.us', {
        text: '[skoobi_bot] 🧊 Hello',
      });
    });

    it('prefixes direct chat messages on shared number', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.sendMessage('123@s.whatsapp.net', 'Hello');
      // Shared number: DMs also get prefixed (needed for self-chat distinction)
      expect(fakeSocket.sendMessage).toHaveBeenCalledWith(
        '123@s.whatsapp.net',
        { text: '[skoobi_bot] 🧊 Hello' },
      );
    });

    it('rejects message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      // Don't connect — channel starts disconnected
      await expect(channel.sendMessage('test@g.us', 'Queued')).rejects.toThrow(
        'WhatsApp is disconnected',
      );
      expect(fakeSocket.sendMessage).not.toHaveBeenCalled();
    });

    it('rejects message on send failure so the host does not advance cursor', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Make sendMessage fail
      fakeSocket.sendMessage.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        channel.sendMessage('test@g.us', 'Will fail'),
      ).rejects.toThrow('Network error');
    });

    it('delivers normally after a later successful connection', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await expect(channel.sendMessage('test@g.us', 'Before')).rejects.toThrow(
        'WhatsApp is disconnected',
      );
      await connectChannel(channel);
      await channel.sendMessage('test@g.us', 'After');

      expect(fakeSocket.sendMessage).toHaveBeenCalledOnce();
      expect(fakeSocket.sendMessage).toHaveBeenCalledWith('test@g.us', {
        text: '[skoobi_bot] 🧊 After',
      });
    });
  });

  // --- Group metadata sync ---

  describe('group metadata sync', () => {
    it('syncs group metadata on first connection', async () => {
      fakeSocket.groupFetchAllParticipating.mockResolvedValue({
        'group1@g.us': { subject: 'Group One' },
        'group2@g.us': { subject: 'Group Two' },
      });

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Wait for async sync to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(fakeSocket.groupFetchAllParticipating).toHaveBeenCalled();
      expect(hostMock.updateChatName).toHaveBeenCalledWith(
        'group1@g.us',
        'Group One',
      );
      expect(hostMock.updateChatName).toHaveBeenCalledWith(
        'group2@g.us',
        'Group Two',
      );
      expect(hostMock.setLastGroupSync).toHaveBeenCalled();
    });

    it('skips sync when synced recently', async () => {
      // Last sync was 1 hour ago (within 24h threshold)
      hostMock.getLastGroupSync.mockReturnValue(
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      );

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await new Promise((r) => setTimeout(r, 50));

      expect(fakeSocket.groupFetchAllParticipating).not.toHaveBeenCalled();
    });

    it('forces sync regardless of cache', async () => {
      hostMock.getLastGroupSync.mockReturnValue(
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      );

      fakeSocket.groupFetchAllParticipating.mockResolvedValue({
        'group@g.us': { subject: 'Forced Group' },
      });

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.syncGroupMetadata(true);

      expect(fakeSocket.groupFetchAllParticipating).toHaveBeenCalled();
      expect(hostMock.updateChatName).toHaveBeenCalledWith(
        'group@g.us',
        'Forced Group',
      );
    });

    it('handles group sync failure gracefully', async () => {
      fakeSocket.groupFetchAllParticipating.mockRejectedValue(
        new Error('Network timeout'),
      );

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Should not throw
      await expect(channel.syncGroupMetadata(true)).resolves.toBeUndefined();
    });

    it('skips groups with no subject', async () => {
      fakeSocket.groupFetchAllParticipating.mockResolvedValue({
        'group1@g.us': { subject: 'Has Subject' },
        'group2@g.us': { subject: '' },
        'group3@g.us': {},
      });

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Clear any calls from the automatic sync on connect
      hostMock.updateChatName.mockClear();

      await channel.syncGroupMetadata(true);

      expect(hostMock.updateChatName).toHaveBeenCalledTimes(1);
      expect(hostMock.updateChatName).toHaveBeenCalledWith(
        'group1@g.us',
        'Has Subject',
      );
    });
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns @g.us JIDs (WhatsApp groups)', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(true);
    });

    it('owns @s.whatsapp.net JIDs (WhatsApp DMs)', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(true);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('tg:12345')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  describe('personal observer mode', () => {
    const personalConfig = {
      enabled: true,
      ownerFolder: 'wa-owner',
      templateGroupFolder: 'owner-template',
      retentionDays: 90,
      maxRows: 50_000,
    } as const;

    function createPersonalOpts(
      overrides?: Partial<WhatsAppChannelOpts>,
    ): WhatsAppChannelOpts {
      return createTestOpts({
        personalObserver: personalConfig,
        registerGroup: vi.fn(),
        registeredGroups: vi.fn(() => ({
          'template@g.us': {
            name: 'Exact template',
            folder: 'owner-template',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
            runtime: undefined,
            isMain: true,
            agentConfig: {
              model: 'test-model',
              effort: 'high' as const,
              personaId: 'skoobi-owner',
              mediaIngestion: true,
              skillsEnabled: false,
              codexFullAgentPrimary: true,
              curatedMemory: false,
              allowedTools: ['Read'],
              allowedDomains: ['internal.invalid'],
              inboundOnly: true,
              suppressAgentStdoutRouting: true,
              maxTurns: 99,
              costLimitUsd: 999,
              fullAccess: true,
              noSandbox: true,
              systemPrompt: 'Template rules.',
            },
          },
          'unrelated@g.us': {
            name: 'Must not be cloned',
            folder: 'other-main',
            trigger: '@skoobi_bot',
            added_at: '2024-01-01T00:00:00.000Z',
            isMain: true,
            agentConfig: { model: 'wrong-model' },
          },
        })),
        ...overrides,
      });
    }

    it('registers only the authenticated self-chat with safe template fields', async () => {
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      expect(opts.registerGroup).toHaveBeenCalledOnce();
      expect(opts.registerGroup).toHaveBeenCalledWith(
        '1234567890@s.whatsapp.net',
        expect.objectContaining({
          folder: 'wa-owner',
          trigger: '',
          requiresTrigger: false,
          isMain: true,
          runtime: 'sandbox',
          agentConfig: expect.objectContaining({
            model: 'test-model',
            effort: 'high',
            personaId: 'skoobi-owner',
            mediaIngestion: true,
            skillsEnabled: false,
            codexFullAgentPrimary: true,
            curatedMemory: false,
            disallowedTools: ['*'],
            fullAccess: false,
            noSandbox: false,
            instructionSourceFolder: 'owner-template',
            memoryContextFolder: 'owner-template',
            lazyMemory: false,
            whatsappObserverAccess: true,
            systemPrompt: expect.stringContaining('drafts only'),
          }),
        }),
      );
      const registered = vi.mocked(opts.registerGroup!).mock.calls[0][1];
      expect(registered.agentConfig).not.toHaveProperty('allowedTools');
      expect(registered.agentConfig).not.toHaveProperty('allowedDomains');
      expect(registered.agentConfig).not.toHaveProperty('inboundOnly');
      expect(registered.agentConfig).not.toHaveProperty(
        'suppressAgentStdoutRouting',
      );
      expect(registered.agentConfig).not.toHaveProperty('maxTurns');
      expect(registered.agentConfig).not.toHaveProperty('costLimitUsd');
      expect(channel.ownsJid('1234567890@s.whatsapp.net')).toBe(true);
      expect(channel.ownsJid('someone-else@s.whatsapp.net')).toBe(false);
      expect(channel.ownsJid('unrelated@g.us')).toBe(false);
    });

    it('routes third-party notify and append events only to passive storage', async () => {
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);
      fakeSocket.sendMessage.mockClear();
      fakeSocket.sendPresenceUpdate.mockClear();

      const contactMessage = {
        key: {
          id: 'observer-1',
          remoteJid: '5551234@s.whatsapp.net',
          fromMe: false,
        },
        message: { conversation: '@skoobi_bot [skoobi_bot] 🧊 please answer' },
        pushName: 'Alice',
        messageTimestamp: Math.floor(Date.now() / 1000),
      };
      await triggerMessages([contactMessage], 'notify');
      await triggerMessages(
        [
          {
            ...contactMessage,
            key: { ...contactMessage.key, id: 'observer-2' },
          },
        ],
        'append',
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(downloadWhatsappMedia).not.toHaveBeenCalled();
      expect(fakeSocket.sendMessage).not.toHaveBeenCalled();
      expect(fakeSocket.sendPresenceUpdate).not.toHaveBeenCalled();
      expect(hostMock.onObservedMessage).toHaveBeenCalledTimes(2);
      expect(hostMock.onObservedMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          chatJid: '5551234@s.whatsapp.net',
          senderName: 'Alice',
          eventType: 'notify',
          contentType: 'text',
        }),
      );
      expect(hostMock.onObservedMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ eventType: 'append' }),
      );
    });

    it('enriches third-party voice asynchronously with shared local STT', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/wa-owner/received/contact-voice.oga',
        filename: 'contact-voice.oga',
        originalName: null,
        mimetype: 'audio/ogg',
      });
      vi.mocked(transcribeAudioFile).mockResolvedValueOnce(
        'Скуби, встреча завтра в десять',
      );
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'observer-voice',
            remoteJid: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } },
          pushName: 'Alice',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);
      await waitUntil(() => hostMock.onObservedMessage.mock.calls.length >= 2);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(hostMock.onObservedMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          id: 'observer-voice',
          mediaEnriched: false,
          content: expect.stringContaining('ожидает локальной расшифровки'),
        }),
      );
      expect(hostMock.onObservedMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          id: 'observer-voice',
          mediaEnriched: true,
          content: expect.stringContaining(
            'Локальная расшифровка: Скуби, встреча завтра в десять',
          ),
        }),
      );
      expect(downloadWhatsappMedia).toHaveBeenCalledWith(
        expect.anything(),
        'wa-owner',
        'voice',
        { tier: 'guest', tenantId: 'wa-owner' },
      );
      expect(transcribeAudioFile).toHaveBeenCalledWith(
        '/tmp/wa-owner/received/contact-voice.oga',
      );
    });

    it('enriches third-party photos with local OCR and a safe media ref', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/wa-owner/received/contact-photo.jpg',
        filename: 'contact-photo.jpg',
        originalName: null,
        mimetype: 'image/jpeg',
      });
      vi.mocked(analyzeImageLocally).mockResolvedValueOnce({
        text: ['Счёт на оплату'],
        labels: ['document'],
      });
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'observer-photo',
            remoteJid: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            imageMessage: { mimetype: 'image/jpeg', caption: 'Посмотри' },
          },
          pushName: 'Alice',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);
      await waitUntil(() => hostMock.onObservedMessage.mock.calls.length >= 2);

      expect(hostMock.onObservedMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: 'observer-photo',
          mediaEnriched: true,
          content: expect.stringContaining('файл: received/contact-photo.jpg'),
        }),
      );
      expect(hostMock.onObservedMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(
            'Распознанный текст: Счёт на оплату',
          ),
        }),
      );
    });

    it('extracts searchable text from third-party documents locally', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/wa-owner/received/brief.pdf',
        filename: 'brief.pdf',
        originalName: 'brief.pdf',
        mimetype: 'application/pdf',
      });
      vi.mocked(extractDocumentTextLocally).mockResolvedValueOnce(
        'Срок выполнения — пятница.',
      );
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'observer-document',
            remoteJid: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            documentMessage: {
              mimetype: 'application/pdf',
              fileName: 'brief.pdf',
            },
          },
          pushName: 'Alice',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);
      await waitUntil(() => hostMock.onObservedMessage.mock.calls.length >= 2);

      expect(hostMock.onObservedMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: 'observer-document',
          mediaEnriched: true,
          content: expect.stringContaining(
            'Локально извлечённый текст: Срок выполнения — пятница.',
          ),
        }),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('enriches third-party video with local audio and selected frames', async () => {
      vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
        path: '/tmp/wa-owner/received/contact-video.mp4',
        filename: 'contact-video.mp4',
        originalName: null,
        mimetype: 'video/mp4',
      });
      vi.mocked(processDownloadedWhatsappVideo).mockResolvedValueOnce({
        durationSeconds: 12,
        transcript: 'Показываю готовую работу',
        transcriptionAttempted: true,
        framePaths: ['/tmp/wa-owner/received/contact-video-frame-1.jpg'],
        frameTimestampsSeconds: [3],
      });
      vi.mocked(analyzeImageLocally).mockResolvedValueOnce({
        text: [],
        labels: ['building'],
      });
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'observer-video',
            remoteJid: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { videoMessage: { mimetype: 'video/mp4' } },
          pushName: 'Alice',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);
      await waitUntil(() => hostMock.onObservedMessage.mock.calls.length >= 2);

      expect(hostMock.onObservedMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: 'observer-video',
          mediaEnriched: true,
          content: expect.stringMatching(
            /Локальная расшифровка звука: Показываю готовую работу.*received\/contact-video-frame-1\.jpg/s,
          ),
        }),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('allows only live notify messages from self-chat to reach the agent', async () => {
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);
      const selfMessage = {
        key: {
          id: 'self-live',
          remoteJid: '1234567890@s.whatsapp.net',
          fromMe: true,
        },
        message: { conversation: 'Скуби, помоги' },
        pushName: 'Owner',
        messageTimestamp: Math.floor(Date.now() / 1000),
      };

      await triggerMessages(
        [{ ...selfMessage, key: { ...selfMessage.key, id: 'self-history' } }],
        'append',
      );
      await triggerMessages(
        [
          {
            ...selfMessage,
            key: { ...selfMessage.key, id: 'self-unknown-sync' },
          },
        ],
        'history-sync',
      );
      expect(opts.onMessage).not.toHaveBeenCalled();

      await triggerMessages([selfMessage], 'notify');
      expect(opts.onMessage).toHaveBeenCalledOnce();
      expect(opts.onMessage).toHaveBeenCalledWith(
        '1234567890@s.whatsapp.net',
        expect.objectContaining({
          content: 'Скуби, помоги',
          sender_name: 'Владелец',
          is_from_me: true,
          is_bot_message: false,
        }),
      );
      expect(hostMock.onObservedMessage).toHaveBeenCalledTimes(3);
      expect(hostMock.onObservedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'self-history',
          chatName: 'Чат с собой (skoobi_bot)',
          eventType: 'append',
        }),
      );
    });

    it('drops stale notify replay from self-chat but delivers a fresh post-connect notify', async () => {
      const connectedAtSeconds = 2_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(connectedAtSeconds * 1000);
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      const selfMessage = (
        id: string,
        messageTimestamp?: number,
      ): Record<string, unknown> => ({
        key: {
          id,
          remoteJid: '1234567890@s.whatsapp.net',
          fromMe: true,
        },
        message: { conversation: `self ${id}` },
        pushName: 'Owner',
        ...(messageTimestamp === undefined ? {} : { messageTimestamp }),
      });

      // Live startup can replay old history as notify rather than append.
      // Neither old timestamps nor a missing timestamp are allowed to wake
      // the assistant merely because the event carries that label.
      const staleReplay = [
        selfMessage('stale-no-timestamp'),
        ...Array.from({ length: 76 }, (_, index) =>
          selfMessage(`stale-${index}`, connectedAtSeconds - index - 1),
        ),
      ];
      expect(staleReplay).toHaveLength(77);
      await triggerMessages(staleReplay, 'notify');
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(hostMock.onObservedMessage).toHaveBeenCalledTimes(77);
      expect(hostMock.onObservedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'stale-no-timestamp',
          chatName: 'Чат с собой (skoobi_bot)',
        }),
      );

      await triggerMessages(
        [selfMessage('fresh-after-open', connectedAtSeconds)],
        'notify',
      );
      expect(opts.onMessage).toHaveBeenCalledOnce();
      expect(opts.onMessage).toHaveBeenCalledWith(
        '1234567890@s.whatsapp.net',
        expect.objectContaining({
          id: 'fresh-after-open',
          content: 'self fresh-after-open',
          is_from_me: true,
          is_bot_message: false,
        }),
      );
    });

    it('hard-blocks outbound text and typing to every non-self destination', async () => {
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);
      fakeSocket.sendMessage.mockClear();
      fakeSocket.sendPresenceUpdate.mockClear();

      await expect(
        channel.sendMessage('5551234@s.whatsapp.net', 'Do not send'),
      ).rejects.toThrow('only permits the authenticated self-chat');
      await expect(
        channel.setTyping('5551234@s.whatsapp.net', true),
      ).rejects.toThrow('only permits the authenticated self-chat');
      expect(fakeSocket.sendMessage).not.toHaveBeenCalled();
      expect(fakeSocket.sendPresenceUpdate).not.toHaveBeenCalled();
      const { logger } = await import('@skoobi/shared/logger');
      const warningLog = JSON.stringify(vi.mocked(logger.warn).mock.calls);
      expect(warningLog).not.toContain('5551234@s.whatsapp.net');
      expect(warningLog).toContain('destinationHash');

      await channel.sendMessage('1234567890@s.whatsapp.net', 'Owner answer');
      await channel.setTyping('1234567890@s.whatsapp.net', true);
      expect(fakeSocket.sendMessage).toHaveBeenCalledOnce();
      expect(fakeSocket.sendPresenceUpdate).toHaveBeenCalledWith(
        'composing',
        '1234567890@s.whatsapp.net',
      );
    });

    it('uses Baileys v7 remoteJidAlt and participantAlt PN addresses', async () => {
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'self-alt',
            remoteJid: '9876543210@lid',
            remoteJidAlt: '1234567890@s.whatsapp.net',
            participant: '777777@lid',
            participantAlt: '1234567890@s.whatsapp.net',
            fromMe: true,
          },
          message: { conversation: 'Alt self message' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        '1234567890@s.whatsapp.net',
        expect.objectContaining({ sender: '1234567890@s.whatsapp.net' }),
      );

      vi.mocked(opts.onMessage).mockClear();
      await triggerMessages([
        {
          key: {
            id: 'group-mixed-alt',
            remoteJid: 'safe-group@g.us',
            remoteJidAlt: '1234567890@s.whatsapp.net',
            participant: '888888@lid',
            participantAlt: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { conversation: 'Group stays passive' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(hostMock.onObservedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatJid: 'safe-group@g.us',
          senderJid: '5551234@s.whatsapp.net',
          isGroup: true,
        }),
      );
    });

    it('uses contact events for observer display names', async () => {
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);
      fakeSocket._ev.emit('contacts.upsert', [
        { id: '5551234@s.whatsapp.net', name: 'Saved Contact' },
      ]);

      await triggerMessages([
        {
          key: {
            id: 'named-observer',
            remoteJid: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { conversation: 'Hello' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);
      expect(hostMock.onObservedMessage).toHaveBeenCalledWith(
        expect.objectContaining({ senderName: 'Saved Contact' }),
      );
    });

    it('imports protocol history passively with chat and contact names', async () => {
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      fakeSocket._ev.emit('messaging-history.set', {
        chats: [{ id: 'project@g.us', name: 'Project Alpha' }],
        contacts: [
          {
            id: 'contact-lid@lid',
            phoneNumber: '5551234@s.whatsapp.net',
            name: 'Saved Contact',
          },
        ],
        messages: [
          {
            key: {
              id: 'history-observer',
              remoteJid: 'project@g.us',
              participant: 'contact-lid@lid',
              participantAlt: '5551234@s.whatsapp.net',
              fromMe: false,
            },
            message: { conversation: 'Earlier project update' },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
          {
            key: {
              id: 'history-self',
              remoteJid: '1234567890@s.whatsapp.net',
              fromMe: true,
            },
            message: { conversation: 'Old self command must not run' },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(hostMock.onObservedMessage).toHaveBeenCalledTimes(2);
      expect(hostMock.onObservedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'history-observer',
          chatName: 'Project Alpha',
          senderName: 'Saved Contact',
          eventType: 'append',
        }),
      );
      expect(hostMock.onObservedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'history-self',
          chatName: 'Чат с собой (skoobi_bot)',
          eventType: 'append',
        }),
      );
    });

    it('delivers a 100+ message history import through one passive batch callback', async () => {
      const onObservedMessages = vi.fn();
      const opts = createPersonalOpts({
        host: { ...hostMock, onObservedMessages },
      });
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);
      const messages = Array.from({ length: 125 }, (_, index) => ({
        key: {
          id: `history-batch-${index}`,
          remoteJid: '5551234@s.whatsapp.net',
          fromMe: false,
        },
        message: { conversation: `Earlier message ${index}` },
        messageTimestamp: Math.floor(Date.now() / 1000),
      }));

      fakeSocket._ev.emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onObservedMessages).toHaveBeenCalledOnce();
      expect(onObservedMessages).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'history-batch-0',
            eventType: 'append',
          }),
          expect.objectContaining({
            id: 'history-batch-124',
            eventType: 'append',
          }),
        ]),
      );
      expect(onObservedMessages.mock.calls[0][0]).toHaveLength(125);
      expect(hostMock.onObservedMessage).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('falls back to the legacy single observer callback for one multi-message upsert', async () => {
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);
      const messages = Array.from({ length: 3 }, (_, index) => ({
        key: {
          id: `fallback-${index}`,
          remoteJid: '5551234@s.whatsapp.net',
          fromMe: false,
        },
        message: { conversation: `Passive ${index}` },
        messageTimestamp: Math.floor(Date.now() / 1000),
      }));

      await triggerMessages(messages, 'append');

      expect(hostMock.onObservedMessage).toHaveBeenCalledTimes(3);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('logs only bounded metadata when a passive batch callback fails', async () => {
      const onObservedMessages = vi.fn(() => {
        throw new Error('private contact text must not reach logs');
      });
      const opts = createPersonalOpts({
        host: { ...hostMock, onObservedMessages },
      });
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'batch-error',
            remoteJid: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { conversation: 'Private content' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      const { logger } = await import('@skoobi/shared/logger');
      expect(logger.error).toHaveBeenCalledWith(
        { errorKind: 'Error', count: 1 },
        'Failed to store passive WhatsApp observer batch',
      );
      expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
        'private contact text',
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses history LID-to-PN mappings before passive import', async () => {
      fakeSocket.user.lid = '';
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      fakeSocket._ev.emit('messaging-history.set', {
        chats: [],
        contacts: [],
        lidPnMappings: [
          {
            lid: '4444444:1@lid',
            pn: '5551234:1@s.whatsapp.net',
          },
          {
            lid: '9876543210:1@lid',
            pn: '1234567890:1@s.whatsapp.net',
          },
        ],
        messages: [
          {
            key: {
              id: 'history-lid-contact',
              remoteJid: '4444444@lid',
              fromMe: false,
            },
            message: { conversation: 'LID-only old contact message' },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
          {
            key: {
              id: 'history-lid-self',
              remoteJid: '9876543210@lid',
              fromMe: true,
            },
            message: { conversation: 'Old self command' },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(hostMock.onObservedMessage).toHaveBeenCalledTimes(2);
      expect(hostMock.onObservedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'history-lid-contact',
          chatJid: '5551234@s.whatsapp.net',
          eventType: 'append',
        }),
      );
      expect(hostMock.onObservedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'history-lid-self',
          chatJid: '1234567890@s.whatsapp.net',
          eventType: 'append',
        }),
      );
    });

    describe('observer media history backfill pump', () => {
      const firstAnchor = {
        chatJid: '1111111@s.whatsapp.net',
        messageId: 'anchor-1',
        timestamp: '2026-07-14T10:00:00.000Z',
        fromMe: false,
      } as const;
      const secondAnchor = {
        chatJid: '2222222@s.whatsapp.net',
        messageId: 'anchor-2',
        timestamp: '2026-07-14T09:00:00.000Z',
        fromMe: true,
      } as const;

      afterEach(() => {
        vi.useRealTimers();
      });

      function fairAnchorHost(
        anchors: readonly {
          chatJid: string;
          messageId: string;
          timestamp: string;
          fromMe: boolean;
        }[] = [firstAnchor, secondAnchor],
      ) {
        const getObservedMediaBackfillAnchors = vi.fn(
          (limit: number, excludedChatJids: readonly string[] = []) =>
            anchors
              .filter((anchor) => !excludedChatJids.includes(anchor.chatJid))
              .slice(0, limit),
        );
        return {
          host: {
            ...hostMock,
            getObservedMediaBackfillAnchors,
          },
          getObservedMediaBackfillAnchors,
        };
      }

      async function connectBackfillChannel(opts: WhatsAppChannelOpts) {
        const channel = new WhatsAppChannel(opts);
        const connecting = channel.connect();
        await vi.advanceTimersByTimeAsync(0);
        triggerConnection('open');
        await connecting;
        await vi.advanceTimersByTimeAsync(2_000);
        return channel;
      }

      function emitHistory(input: {
        syncType: number;
        sessionId: string;
        messages?: unknown[];
      }): void {
        fakeSocket._ev.emit('messaging-history.set', {
          chats: [],
          contacts: [],
          messages: input.messages || [],
          syncType: input.syncType,
          peerDataRequestSessionId: input.sessionId,
        });
      }

      it('requests at most 32 messages and keeps one correlated request in flight', async () => {
        vi.useFakeTimers();
        fakeSocket.fetchMessageHistory
          .mockResolvedValueOnce('request-1')
          .mockResolvedValueOnce('request-2');
        const { host, getObservedMediaBackfillAnchors } = fairAnchorHost();
        const channel = await connectBackfillChannel(
          createPersonalOpts({ host }),
        );

        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledWith(
          32,
          {
            remoteJid: firstAnchor.chatJid,
            id: firstAnchor.messageId,
            fromMe: firstAnchor.fromMe,
          },
          Date.parse(firstAnchor.timestamp),
        );
        expect(
          fakeSocket.fetchMessageHistory.mock.calls[0][0],
        ).toBeLessThanOrEqual(50);
        expect(getObservedMediaBackfillAnchors).toHaveBeenNthCalledWith(
          1,
          1,
          [],
        );

        emitHistory({ syncType: 3, sessionId: 'request-1' });
        emitHistory({ syncType: 6, sessionId: 'different-request' });
        await vi.advanceTimersByTimeAsync(3_000);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);

        emitHistory({ syncType: 6, sessionId: 'request-1' });
        await vi.advanceTimersByTimeAsync(4_999);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(14_999);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(0);

        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(2);
        expect(getObservedMediaBackfillAnchors).toHaveBeenNthCalledWith(2, 1, [
          firstAnchor.chatJid,
        ]);
        const { logger } = await import('@skoobi/shared/logger');
        const operationalLogs = JSON.stringify([
          vi.mocked(logger.info).mock.calls,
          vi.mocked(logger.warn).mock.calls,
          vi.mocked(logger.error).mock.calls,
        ]);
        expect(operationalLogs).not.toContain(firstAnchor.chatJid);
        expect(operationalLogs).not.toContain(firstAnchor.messageId);
        await channel.disconnect();
      });

      it('uses the hard timeout to rotate fairly when no response arrives', async () => {
        vi.useFakeTimers();
        fakeSocket.fetchMessageHistory
          .mockResolvedValueOnce('request-timeout')
          .mockResolvedValueOnce('request-after-timeout');
        const { host } = fairAnchorHost();
        const channel = await connectBackfillChannel(
          createPersonalOpts({ host }),
        );

        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(44_999);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(2);
        await channel.disconnect();
      });

      it('pauses historical backfill for twenty-four hours after two hard timeouts', async () => {
        vi.useFakeTimers({ now: new Date('2026-07-15T00:00:00.000Z') });
        const thirdAnchor = {
          chatJid: '3333333@s.whatsapp.net',
          messageId: 'anchor-3',
          timestamp: '2026-07-14T08:00:00.000Z',
          fromMe: false,
        } as const;
        let persisted: WhatsAppObserverMediaBackfillProgress = {
          version: 1,
          visitedChatJids: [],
          nextAllowedAtMs: 0,
          consecutiveTimeouts: 0,
        };
        const getObservedMediaBackfillProgress = vi.fn(() => ({
          ...persisted,
          visitedChatJids: [...persisted.visitedChatJids],
        }));
        const setObservedMediaBackfillProgress = vi.fn(
          (progress: WhatsAppObserverMediaBackfillProgress) => {
            persisted = {
              ...progress,
              visitedChatJids: [...progress.visitedChatJids],
            };
          },
        );
        fakeSocket.fetchMessageHistory
          .mockResolvedValueOnce('request-timeout-1')
          .mockResolvedValueOnce('request-timeout-2')
          .mockResolvedValueOnce('request-after-pause');
        const { host } = fairAnchorHost([
          firstAnchor,
          secondAnchor,
          thirdAnchor,
        ]);
        const channel = await connectBackfillChannel(
          createPersonalOpts({
            host: {
              ...host,
              getObservedMediaBackfillProgress,
              setObservedMediaBackfillProgress,
            },
          }),
        );

        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(45_000);
        await vi.advanceTimersByTimeAsync(0);
        expect(persisted.consecutiveTimeouts).toBe(1);
        expect(persisted.nextAllowedAtMs - Date.now()).toBe(15 * 60_000);

        await vi.advanceTimersByTimeAsync(15 * 60_000);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(45_000);
        await vi.advanceTimersByTimeAsync(0);
        expect(persisted.consecutiveTimeouts).toBe(2);
        expect(persisted.nextAllowedAtMs - Date.now()).toBe(24 * 60 * 60_000);
        const pauseDeadline = persisted.nextAllowedAtMs;

        // A late response to the timed-out request may still enrich local
        // history, but it must not shorten or clear the durable pause.
        emitHistory({ syncType: 6, sessionId: 'request-timeout-2' });
        await vi.advanceTimersByTimeAsync(0);
        expect(persisted.consecutiveTimeouts).toBe(2);
        expect(persisted.nextAllowedAtMs).toBe(pauseDeadline);

        // Reconnects replace only the socket/controller. The persisted pause
        // must continue to block history requests on the new connection.
        triggerDisconnect(408);
        await vi.advanceTimersByTimeAsync(1_000);
        triggerConnection('open');
        await vi.advanceTimersByTimeAsync(2_000);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(pauseDeadline - Date.now() - 1);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(3);
        expect(persisted.consecutiveTimeouts).toBe(0);
        const { logger } = await import('@skoobi/shared/logger');
        expect(logger.info).toHaveBeenCalledWith(
          {
            reason: 'consecutive_timeouts',
            timeoutCount: 2,
            pauseMs: 24 * 60 * 60_000,
          },
          'WhatsApp observer media history backfill paused',
        );
        await channel.disconnect();
      });

      it('resets the timeout streak after a matched history page', async () => {
        vi.useFakeTimers({ now: new Date('2026-07-15T00:00:00.000Z') });
        let persisted: WhatsAppObserverMediaBackfillProgress = {
          version: 1,
          visitedChatJids: [],
          nextAllowedAtMs: 0,
          consecutiveTimeouts: 1,
        };
        const { host } = fairAnchorHost();
        fakeSocket.fetchMessageHistory
          .mockResolvedValueOnce('request-matched-reset')
          .mockResolvedValueOnce('request-timeout-after-match');
        const channel = await connectBackfillChannel(
          createPersonalOpts({
            host: {
              ...host,
              getObservedMediaBackfillProgress: () => ({
                ...persisted,
                visitedChatJids: [...persisted.visitedChatJids],
              }),
              setObservedMediaBackfillProgress: (progress) => {
                persisted = {
                  ...progress,
                  visitedChatJids: [...progress.visitedChatJids],
                };
              },
            },
          }),
        );

        emitHistory({ syncType: 6, sessionId: 'request-matched-reset' });
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(0);
        expect(persisted.consecutiveTimeouts).toBe(0);
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(45_000);
        await vi.advanceTimersByTimeAsync(0);
        expect(persisted.consecutiveTimeouts).toBe(1);
        expect(persisted.nextAllowedAtMs - Date.now()).toBe(15 * 60_000);
        await channel.disconnect();
      });

      it('does not count a transport failure as a hard timeout', async () => {
        vi.useFakeTimers({ now: new Date('2026-07-15T00:00:00.000Z') });
        let persisted: WhatsAppObserverMediaBackfillProgress = {
          version: 1,
          visitedChatJids: [],
          nextAllowedAtMs: 0,
          consecutiveTimeouts: 1,
        };
        fakeSocket.fetchMessageHistory
          .mockRejectedValueOnce(new Error('private transport detail'))
          .mockResolvedValueOnce('request-after-failure');
        const { host } = fairAnchorHost();
        const channel = await connectBackfillChannel(
          createPersonalOpts({
            host: {
              ...host,
              getObservedMediaBackfillProgress: () => persisted,
              setObservedMediaBackfillProgress: (progress) => {
                persisted = progress;
              },
            },
          }),
        );
        await vi.advanceTimersByTimeAsync(0);

        expect(persisted.consecutiveTimeouts).toBe(0);
        expect(persisted.nextAllowedAtMs - Date.now()).toBe(60_000);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(2);
        await channel.disconnect();
      });

      it('fails closed while saving a twenty-four-hour pause checkpoint', async () => {
        vi.useFakeTimers({ now: new Date('2026-07-15T00:00:00.000Z') });
        let persisted: WhatsAppObserverMediaBackfillProgress = {
          version: 1,
          visitedChatJids: [],
          nextAllowedAtMs: 0,
          consecutiveTimeouts: 1,
        };
        let rejectPauseOnce = true;
        const setObservedMediaBackfillProgress = vi.fn(
          (progress: WhatsAppObserverMediaBackfillProgress) => {
            if (progress.consecutiveTimeouts === 2 && rejectPauseOnce) {
              rejectPauseOnce = false;
              throw new Error('private checkpoint detail');
            }
            persisted = {
              ...progress,
              visitedChatJids: [...progress.visitedChatJids],
            };
          },
        );
        fakeSocket.fetchMessageHistory.mockResolvedValueOnce(
          'request-before-pause-save-failure',
        );
        const { host } = fairAnchorHost();
        const channel = await connectBackfillChannel(
          createPersonalOpts({
            host: {
              ...host,
              getObservedMediaBackfillProgress: () => persisted,
              setObservedMediaBackfillProgress,
            },
          }),
        );

        await vi.advanceTimersByTimeAsync(45_000);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        expect(persisted.consecutiveTimeouts).toBe(2);
        expect(persisted.nextAllowedAtMs - Date.now()).toBe(
          24 * 60 * 60_000 - 60_000,
        );
        const { logger } = await import('@skoobi/shared/logger');
        expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
          'private checkpoint detail',
        );
        await channel.disconnect();
      });

      it('does not fetch until an expired pause reset is durable', async () => {
        vi.useFakeTimers({ now: new Date('2026-07-15T00:00:00.000Z') });
        const pauseDeadline = Date.now() + 10_000;
        let persisted: WhatsAppObserverMediaBackfillProgress = {
          version: 1,
          visitedChatJids: [],
          nextAllowedAtMs: pauseDeadline,
          consecutiveTimeouts: 2,
        };
        let rejectResetOnce = true;
        const { host } = fairAnchorHost();
        const channel = await connectBackfillChannel(
          createPersonalOpts({
            host: {
              ...host,
              getObservedMediaBackfillProgress: () => persisted,
              setObservedMediaBackfillProgress: (progress) => {
                if (
                  progress.consecutiveTimeouts === 0 &&
                  progress.nextAllowedAtMs === 0 &&
                  rejectResetOnce
                ) {
                  rejectResetOnce = false;
                  throw new Error('private reset detail');
                }
                persisted = {
                  ...progress,
                  visitedChatJids: [...progress.visitedChatJids],
                };
              },
            },
          }),
        );

        expect(fakeSocket.fetchMessageHistory).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(pauseDeadline - Date.now());
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(59_999);
        expect(fakeSocket.fetchMessageHistory).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        expect(persisted.consecutiveTimeouts).toBe(0);
        const { logger } = await import('@skoobi/shared/logger');
        expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
          'private reset detail',
        );
        await channel.disconnect();
      });

      it('loads, validates, deduplicates, and caps persisted progress once', () => {
        const persistedJids = Array.from(
          { length: 50_001 },
          (_, index) => `${index + 10_000}@s.whatsapp.net`,
        );
        const getObservedMediaBackfillProgress = vi.fn(
          () =>
            ({
              version: 1,
              visitedChatJids: [
                firstAnchor.chatJid,
                firstAnchor.chatJid,
                'unsafe',
                ...persistedJids,
              ],
              nextAllowedAtMs: Number.NaN,
            }) as unknown as WhatsAppObserverMediaBackfillProgress,
        );
        const { host } = fairAnchorHost();
        const channel = new WhatsAppChannel(
          createPersonalOpts({
            host: { ...host, getObservedMediaBackfillProgress },
          }),
        );

        expect((channel as any).loadObserverHistoryBackfillProgress()).toBe(
          true,
        );
        expect((channel as any).loadObserverHistoryBackfillProgress()).toBe(
          true,
        );
        const progress = (channel as any)
          .observerHistoryBackfillProgress as WhatsAppObserverMediaBackfillProgress;
        expect(getObservedMediaBackfillProgress).toHaveBeenCalledOnce();
        expect(progress.version).toBe(1);
        expect(progress.visitedChatJids).toHaveLength(50_000);
        expect(new Set(progress.visitedChatJids).size).toBe(50_000);
        expect(progress.visitedChatJids).toContain(firstAnchor.chatJid);
        expect(progress.visitedChatJids).not.toContain('unsafe');
        expect(progress.nextAllowedAtMs).toBe(0);
        expect(progress.consecutiveTimeouts).toBe(0);
      });

      it('derives the visited cap from maxRows and clamps restored deadlines to fifteen minutes', () => {
        vi.useFakeTimers();
        const nowMs = Date.now();
        const getObservedMediaBackfillProgress = vi.fn(() => ({
          version: 1 as const,
          visitedChatJids: [
            '1@s.whatsapp.net',
            '2@s.whatsapp.net',
            '3@s.whatsapp.net',
            '4@s.whatsapp.net',
          ],
          nextAllowedAtMs: nowMs + 24 * 60 * 60_000,
          consecutiveTimeouts: 999,
        }));
        const { host } = fairAnchorHost();
        const channel = new WhatsAppChannel(
          createPersonalOpts({
            personalObserver: { ...personalConfig, maxRows: 3 },
            host: { ...host, getObservedMediaBackfillProgress },
          }),
        );

        expect((channel as any).loadObserverHistoryBackfillProgress()).toBe(
          true,
        );
        const progress = (channel as any)
          .observerHistoryBackfillProgress as WhatsAppObserverMediaBackfillProgress;
        expect(progress.visitedChatJids).toEqual([
          '1@s.whatsapp.net',
          '2@s.whatsapp.net',
          '3@s.whatsapp.net',
        ]);
        expect(progress.nextAllowedAtMs).toBe(nowMs + 15 * 60_000);
        expect(progress.consecutiveTimeouts).toBe(0);
      });

      it('restores a validated twenty-four-hour timeout pause', () => {
        vi.useFakeTimers({ now: new Date('2026-07-15T00:00:00.000Z') });
        const nowMs = Date.now();
        const { host } = fairAnchorHost();
        const channel = new WhatsAppChannel(
          createPersonalOpts({
            host: {
              ...host,
              getObservedMediaBackfillProgress: () => ({
                version: 1,
                visitedChatJids: [firstAnchor.chatJid],
                nextAllowedAtMs: nowMs + 48 * 60 * 60_000,
                consecutiveTimeouts: 2,
              }),
            },
          }),
        );

        expect((channel as any).loadObserverHistoryBackfillProgress()).toBe(
          true,
        );
        const progress = (channel as any)
          .observerHistoryBackfillProgress as WhatsAppObserverMediaBackfillProgress;
        expect(progress.consecutiveTimeouts).toBe(2);
        expect(progress.nextAllowedAtMs).toBe(nowMs + 24 * 60 * 60_000);
      });

      it('keeps live self-chat messages active while historical backfill is paused', async () => {
        vi.useFakeTimers({ now: new Date('2026-07-15T00:00:00.000Z') });
        const pauseDeadline = Date.now() + 24 * 60 * 60_000;
        const { host } = fairAnchorHost();
        const opts = createPersonalOpts({
          host: {
            ...host,
            getObservedMediaBackfillProgress: () => ({
              version: 1,
              visitedChatJids: [firstAnchor.chatJid],
              nextAllowedAtMs: pauseDeadline,
              consecutiveTimeouts: 2,
            }),
            setObservedMediaBackfillProgress: vi.fn(),
          },
        });
        const channel = await connectBackfillChannel(opts);
        expect(fakeSocket.fetchMessageHistory).not.toHaveBeenCalled();

        await triggerMessages([
          {
            key: {
              id: 'self-live-during-history-pause',
              remoteJid: '1234567890@s.whatsapp.net',
              fromMe: true,
            },
            message: { conversation: 'Скуби, ты здесь?' },
            pushName: 'Owner',
            messageTimestamp: Math.floor(Date.now() / 1_000),
          },
        ]);
        expect(opts.onMessage).toHaveBeenCalledOnce();

        vi.mocked(downloadWhatsappMedia).mockResolvedValueOnce({
          path: '/tmp/wa-owner/received/live-during-pause.oga',
          filename: 'live-during-pause.oga',
          originalName: null,
          mimetype: 'audio/ogg',
        });
        vi.mocked(transcribeAudioFile).mockResolvedValueOnce(
          'Новое голосовое работает',
        );
        await triggerMessages([
          {
            key: {
              id: 'voice-live-during-history-pause',
              remoteJid: '5551234@s.whatsapp.net',
              fromMe: false,
            },
            message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } },
            pushName: 'Alice',
            messageTimestamp: Math.floor(Date.now() / 1_000),
          },
        ]);
        await (channel as any).observerAudioQueue.waitForIdle();
        expect(transcribeAudioFile).toHaveBeenCalledWith(
          '/tmp/wa-owner/received/live-during-pause.oga',
        );
        expect(hostMock.onObservedMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({
            id: 'voice-live-during-history-pause',
            mediaEnriched: true,
            content: expect.stringContaining('Новое голосовое работает'),
          }),
        );
        expect(fakeSocket.fetchMessageHistory).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(pauseDeadline - Date.now() - 1);
        expect(fakeSocket.fetchMessageHistory).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await channel.disconnect();
      });

      it('persists an in-flight fifteen-minute boundary before fetching', async () => {
        vi.useFakeTimers();
        const setObservedMediaBackfillProgress = vi.fn();
        const { host } = fairAnchorHost();
        const channel = await connectBackfillChannel(
          createPersonalOpts({
            host: { ...host, setObservedMediaBackfillProgress },
          }),
        );

        expect(setObservedMediaBackfillProgress).toHaveBeenCalledTimes(2);
        expect(setObservedMediaBackfillProgress).toHaveBeenLastCalledWith({
          version: 1,
          visitedChatJids: [firstAnchor.chatJid],
          nextAllowedAtMs: Date.now() + 15 * 60_000,
          consecutiveTimeouts: 0,
        });
        expect(
          setObservedMediaBackfillProgress.mock.invocationCallOrder[1],
        ).toBeLessThan(
          fakeSocket.fetchMessageHistory.mock.invocationCallOrder[0],
        );
        await channel.disconnect();
      });

      it('blocks the fetch when saving the in-flight boundary fails', async () => {
        vi.useFakeTimers();
        const setObservedMediaBackfillProgress = vi
          .fn<(progress: WhatsAppObserverMediaBackfillProgress) => void>()
          .mockImplementationOnce(() => undefined)
          .mockImplementationOnce(() => {
            throw new Error('private persistence failure');
          })
          .mockImplementation(() => undefined);
        const { host } = fairAnchorHost();
        const channel = await connectBackfillChannel(
          createPersonalOpts({
            host: { ...host, setObservedMediaBackfillProgress },
          }),
        );

        expect(setObservedMediaBackfillProgress).toHaveBeenCalledTimes(2);
        expect(fakeSocket.fetchMessageHistory).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fakeSocket.fetchMessageHistory).not.toHaveBeenCalled();
        const { logger } = await import('@skoobi/shared/logger');
        expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
          'private persistence failure',
        );
        await channel.disconnect();
      });

      it('persists cancellation cooldown and resumes with the next chat after reconnect', async () => {
        vi.useFakeTimers();
        let persisted: WhatsAppObserverMediaBackfillProgress = {
          version: 1,
          visitedChatJids: [],
          nextAllowedAtMs: 0,
        };
        const getObservedMediaBackfillProgress = vi.fn(() => ({
          ...persisted,
          visitedChatJids: [...persisted.visitedChatJids],
        }));
        const setObservedMediaBackfillProgress = vi.fn(
          (progress: WhatsAppObserverMediaBackfillProgress) => {
            persisted = {
              ...progress,
              visitedChatJids: [...progress.visitedChatJids],
            };
          },
        );
        fakeSocket.fetchMessageHistory
          .mockResolvedValueOnce('request-before-reconnect')
          .mockResolvedValueOnce('request-after-reconnect');
        const { host, getObservedMediaBackfillAnchors } = fairAnchorHost();
        const channel = await connectBackfillChannel(
          createPersonalOpts({
            host: {
              ...host,
              getObservedMediaBackfillProgress,
              setObservedMediaBackfillProgress,
            },
          }),
        );
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        expect(persisted.visitedChatJids).toEqual([firstAnchor.chatJid]);

        triggerDisconnect(408);
        const cooldownDeadline = persisted.nextAllowedAtMs;
        expect(cooldownDeadline).toBe(Date.now() + 15 * 60_000);
        await vi.advanceTimersByTimeAsync(1_000);
        triggerConnection('open');
        await vi.advanceTimersByTimeAsync(2_000);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        expect(getObservedMediaBackfillProgress).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(cooldownDeadline - Date.now() - 1);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(2);
        expect(getObservedMediaBackfillAnchors).toHaveBeenLastCalledWith(1, [
          firstAnchor.chatJid,
        ]);
        await channel.disconnect();
      });

      it('paces a failed request for sixty seconds before rotating', async () => {
        vi.useFakeTimers();
        fakeSocket.fetchMessageHistory
          .mockRejectedValueOnce(new Error('private transport detail'))
          .mockResolvedValueOnce('request-after-failure');
        const { host } = fairAnchorHost();
        const channel = await connectBackfillChannel(
          createPersonalOpts({ host }),
        );

        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(2);
        const { logger } = await import('@skoobi/shared/logger');
        expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
          'private transport detail',
        );
        await channel.disconnect();
      });

      it('treats an empty history request id as failed rather than cancelled', async () => {
        vi.useFakeTimers();
        fakeSocket.fetchMessageHistory
          .mockResolvedValueOnce('')
          .mockResolvedValueOnce('request-after-invalid-id');
        const { host } = fairAnchorHost();
        const channel = await connectBackfillChannel(
          createPersonalOpts({ host }),
        );
        await vi.advanceTimersByTimeAsync(0);

        expect((channel as any).observerHistoryResponseWaiter).toBeNull();
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(2);
        await channel.disconnect();
      });

      it('does not fetch when progress saving fails and retries persistence after sixty seconds', async () => {
        vi.useFakeTimers();
        const getObservedMediaBackfillProgress = vi.fn(() => ({
          version: 1 as const,
          visitedChatJids: [],
          nextAllowedAtMs: 0,
        }));
        const setObservedMediaBackfillProgress = vi
          .fn<(progress: WhatsAppObserverMediaBackfillProgress) => void>()
          .mockImplementationOnce(() => {
            throw new Error('private database path');
          })
          .mockImplementation(() => undefined);
        const { host } = fairAnchorHost();
        const channel = await connectBackfillChannel(
          createPersonalOpts({
            host: {
              ...host,
              getObservedMediaBackfillProgress,
              setObservedMediaBackfillProgress,
            },
          }),
        );

        expect(fakeSocket.fetchMessageHistory).not.toHaveBeenCalled();
        expect(setObservedMediaBackfillProgress).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(59_999);
        expect(fakeSocket.fetchMessageHistory).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledWith(
          32,
          expect.objectContaining({ remoteJid: secondAnchor.chatJid }),
          Date.parse(secondAnchor.timestamp),
        );
        const { logger } = await import('@skoobi/shared/logger');
        expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
          'private database path',
        );
        await channel.disconnect();
      });

      it('persists an empty visited set and a fifteen-minute cooldown at sweep completion', async () => {
        vi.useFakeTimers();
        const setObservedMediaBackfillProgress = vi.fn();
        const { host } = fairAnchorHost([firstAnchor]);
        const channel = await connectBackfillChannel(
          createPersonalOpts({
            host: {
              ...host,
              getObservedMediaBackfillProgress: () => ({
                version: 1,
                visitedChatJids: [firstAnchor.chatJid],
                nextAllowedAtMs: 0,
              }),
              setObservedMediaBackfillProgress,
            },
          }),
        );

        expect(fakeSocket.fetchMessageHistory).not.toHaveBeenCalled();
        expect(setObservedMediaBackfillProgress).toHaveBeenCalledWith({
          version: 1,
          visitedChatJids: [],
          nextAllowedAtMs: Date.now() + 15 * 60_000,
          consecutiveTimeouts: 0,
        });
        await channel.disconnect();
      });

      it('waits for both media lanes and retries a full enqueue instead of dropping it', async () => {
        vi.useFakeTimers();
        fakeSocket.fetchMessageHistory.mockResolvedValueOnce('request-full');
        const { host } = fairAnchorHost([firstAnchor]);
        const channel = await connectBackfillChannel(
          createPersonalOpts({ host }),
        );
        const audioQueue = (channel as any).observerAudioQueue;
        const visualQueue = (channel as any).observerVisualQueue;
        let releaseActive!: () => void;
        let releaseVisual!: () => void;
        expect(
          audioQueue.enqueue({
            key: 'blocking-active',
            priority: 'append',
            run: () =>
              new Promise<void>((resolve) => {
                releaseActive = resolve;
              }),
          }),
        ).toEqual({ accepted: true });
        for (let index = 0; index < 64; index += 1) {
          expect(
            audioQueue.enqueue({
              key: `waiting-${index}`,
              priority: 'append',
              run: async () => undefined,
            }),
          ).toEqual({ accepted: true });
        }
        expect(audioQueue.snapshot().waiting).toBe(64);
        expect(
          visualQueue.enqueue({
            key: 'blocking-visual',
            priority: 'append',
            run: () =>
              new Promise<void>((resolve) => {
                releaseVisual = resolve;
              }),
          }),
        ).toEqual({ accepted: true });

        emitHistory({
          syncType: 6,
          sessionId: 'request-full',
          messages: [
            {
              key: {
                id: 'backfill-voice',
                remoteJid: firstAnchor.chatJid,
                fromMe: false,
              },
              message: {
                audioMessage: { mimetype: 'audio/ogg', ptt: true },
              },
              messageTimestamp: Math.floor(Date.now() / 1_000),
            },
          ],
        });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(downloadWhatsappMedia).not.toHaveBeenCalled();

        releaseActive();
        await audioQueue.waitForIdle();
        await vi.advanceTimersByTimeAsync(0);
        expect(downloadWhatsappMedia).not.toHaveBeenCalled();
        releaseVisual();
        await visualQueue.waitForIdle();
        await vi.advanceTimersByTimeAsync(0);
        await audioQueue.waitForIdle();
        expect(downloadWhatsappMedia).toHaveBeenCalledWith(
          expect.objectContaining({
            key: expect.objectContaining({ id: 'backfill-voice' }),
          }),
          'wa-owner',
          'voice',
          { tier: 'guest', tenantId: 'wa-owner' },
        );
        await channel.disconnect();
      });

      it('cancels the correlated waiter and every pump timer on socket close', async () => {
        vi.useFakeTimers();
        fakeSocket.fetchMessageHistory.mockResolvedValueOnce('request-cancel');
        const { host } = fairAnchorHost();
        const channel = await connectBackfillChannel(
          createPersonalOpts({ host }),
        );
        expect((channel as any).observerHistoryResponseWaiter).not.toBeNull();

        triggerDisconnect(401);
        expect((channel as any).observerHistoryResponseWaiter).toBeNull();
        expect((channel as any).observerHistoryBackfillTimer).toBeNull();
        expect((channel as any).observerHistoryBackfillController).toBeNull();

        emitHistory({ syncType: 6, sessionId: 'request-cancel' });
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(fakeSocket.fetchMessageHistory).toHaveBeenCalledTimes(1);
      });
    });

    it('fails closed when the authenticated account has no PN self JID', async () => {
      fakeSocket.user.id = '9876543210:1@lid';
      const opts = createPersonalOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      expect(opts.registerGroup).not.toHaveBeenCalled();
      expect(channel.ownsJid('9876543210@lid')).toBe(false);
      await expect(
        channel.sendMessage('9876543210@lid', 'blocked'),
      ).rejects.toThrow('only permits the authenticated self-chat');
      expect(fakeSocket.sendMessage).not.toHaveBeenCalled();
    });
  });

  // --- Typing indicator ---

  describe('setTyping', () => {
    it('sends composing presence when typing', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.setTyping('test@g.us', true);
      expect(fakeSocket.sendPresenceUpdate).toHaveBeenCalledWith(
        'composing',
        'test@g.us',
      );
    });

    it('sends paused presence when stopping', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.setTyping('test@g.us', false);
      expect(fakeSocket.sendPresenceUpdate).toHaveBeenCalledWith(
        'paused',
        'test@g.us',
      );
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      fakeSocket.sendPresenceUpdate.mockRejectedValueOnce(new Error('Failed'));

      // Should not throw
      await expect(
        channel.setTyping('test@g.us', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "whatsapp"', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.name).toBe('whatsapp');
    });

    it('does not expose prefixAssistantName (prefix handled internally)', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect('prefixAssistantName' in channel).toBe(false);
    });
  });
});
