import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  getDb: vi.fn(),
  getRouterState: vi.fn(),
  setRouterState: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  prune: vi.fn(() => ({ pruned: 0, remaining: 0 })),
  registerChannel: vi.fn(),
  storeObserved: vi.fn(),
  storeObservedBatch: vi.fn(),
  WhatsAppChannel: vi.fn(function MockWhatsAppChannel(_opts: unknown) {}),
}));

vi.mock('fs', () => ({
  default: { existsSync: mocks.existsSync },
}));
vi.mock('@skoobi/core/config', () => ({
  ASSISTANT_HAS_OWN_NUMBER: false,
}));
vi.mock('@skoobi/core/db', () => ({
  getDb: mocks.getDb,
  getRouterState: mocks.getRouterState,
  setRouterState: mocks.setRouterState,
}));
vi.mock('@skoobi/core/whatsapp-observer', () => ({
  pruneObservedWhatsAppMessages: mocks.prune,
  storeObservedWhatsAppMessage: mocks.storeObserved,
  storeObservedWhatsAppMessagesBatch: mocks.storeObservedBatch,
}));
vi.mock('@skoobi/shared/logger', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}));
vi.mock('@skoobi/core/channel-registry', () => ({
  registerChannel: mocks.registerChannel,
}));
vi.mock('./index.js', () => ({
  STORE_DIR: '/private/skoobi/store',
  WHATSAPP_PERSONAL_OBSERVER: {
    enabled: true,
    ownerFolder: 'whatsapp_main',
    retentionDays: 90,
    maxRows: 50_000,
  },
  WhatsAppChannel: mocks.WhatsAppChannel,
}));

async function importFactory(): Promise<(opts: object) => unknown> {
  await import('./wiring.js');
  expect(mocks.registerChannel).toHaveBeenCalledOnce();
  return mocks.registerChannel.mock.calls[0][1] as (opts: object) => unknown;
}

describe('WhatsApp observer retention wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
    mocks.getDb.mockReset();
    mocks.getRouterState.mockReset().mockReturnValue(undefined);
    mocks.setRouterState.mockReset();
    mocks.prune.mockReturnValue({ pruned: 0, remaining: 0 });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not abort channel startup when retention maintenance throws', async () => {
    mocks.prune.mockImplementationOnce(() => {
      throw new Error('private SQL and filesystem details');
    });
    const factory = await importFactory();

    expect(() => factory({ onMessage: vi.fn() })).not.toThrow();
    expect(mocks.WhatsAppChannel).toHaveBeenCalledOnce();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { errorKind: 'Error' },
      'WhatsApp observer retention deferred after local database error',
    );
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain(
      'private SQL',
    );
  });

  it('contains SQLITE_BUSY from the periodic six-hour maintenance run', async () => {
    const factory = await importFactory();
    factory({ onMessage: vi.fn() });
    mocks.prune.mockImplementationOnce(() => {
      const error = new Error('database path must stay private') as Error & {
        code: string;
      };
      error.code = 'SQLITE_BUSY';
      throw error;
    });

    expect(() => vi.advanceTimersByTime(6 * 60 * 60 * 1000)).not.toThrow();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { errorKind: 'SQLITE_BUSY' },
      'WhatsApp observer retention deferred after local database error',
    );
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain(
      'database path',
    );
  });

  it('writes passive history in bounded batches while retaining the single path', async () => {
    const factory = await importFactory();
    factory({ onMessage: vi.fn() });
    const channelOpts = mocks.WhatsAppChannel.mock.calls[0][0] as {
      host: {
        onObservedMessage: (message: Record<string, unknown>) => void;
        onObservedMessages: (messages: Record<string, unknown>[]) => void;
      };
    };
    const observed = Array.from({ length: 2_101 }, (_, index) => ({
      id: `message-${index}`,
      chatJid: 'contact@s.whatsapp.net',
      chatName: 'Contact',
      senderJid: 'contact@s.whatsapp.net',
      senderName: 'Contact',
      content: `text-${index}`,
      contentType: 'text',
      timestamp: '2026-07-14T00:00:00.000Z',
      fromMe: false,
      isGroup: false,
      eventType: 'append',
    }));

    channelOpts.host.onObservedMessages(observed);
    expect(mocks.storeObservedBatch).toHaveBeenCalledTimes(3);
    expect(
      mocks.storeObservedBatch.mock.calls.map(([batch]) => batch.length),
    ).toEqual([1_000, 1_000, 101]);

    channelOpts.host.onObservedMessage(observed[0]);
    expect(mocks.storeObserved).toHaveBeenCalledOnce();
  });

  it('selects one fair media-gap anchor at a strictly newer timestamp', async () => {
    const all = vi.fn().mockReturnValue([
      {
        messageId: 'anchor-message',
        chatJid: 'next-chat@s.whatsapp.net',
        timestamp: '2026-07-14T00:00:01.000Z',
        fromMe: 1,
      },
    ]);
    const prepare = vi.fn((_sql: string) => ({ all }));
    mocks.getDb.mockReturnValue({ prepare });
    const factory = await importFactory();
    factory({ onMessage: vi.fn() });
    const channelOpts = mocks.WhatsAppChannel.mock.calls[0][0] as {
      host: {
        getObservedMediaBackfillAnchors: (
          limit: number,
          excludedChatJids?: readonly string[],
        ) => unknown[];
      };
    };

    expect(
      channelOpts.host.getObservedMediaBackfillAnchors(1, [
        'visited@s.whatsapp.net',
        'visited@s.whatsapp.net',
        'unsafe-value',
      ]),
    ).toEqual([
      {
        messageId: 'anchor-message',
        chatJid: 'next-chat@s.whatsapp.net',
        timestamp: '2026-07-14T00:00:01.000Z',
        fromMe: true,
      },
    ]);
    const sql = prepare.mock.calls[0][0] as string;
    expect(sql).toContain('json_each(?)');
    expect(sql).toContain('newer.timestamp > gap.gap_timestamp');
    expect(sql).toContain("'document'");
    expect(sql).toContain("chat_jid GLOB '*@s.whatsapp.net'");
    expect(sql).toContain("chat_jid GLOB '*@g.us'");
    expect(sql).toContain('missing_media_count DESC');
    expect(all).toHaveBeenCalledWith(
      JSON.stringify(['visited@s.whatsapp.net']),
      1,
    );
    const prepareCalls = prepare.mock.calls.length;
    expect(
      channelOpts.host.getObservedMediaBackfillAnchors(Number.NaN),
    ).toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(prepareCalls);
  });

  it('persists bounded backfill progress in local router state', async () => {
    const progress = {
      version: 1 as const,
      visitedChatJids: ['visited@s.whatsapp.net'],
      nextAllowedAtMs: 1_784_000_000_000,
      consecutiveTimeouts: 2,
    };
    mocks.getRouterState.mockReturnValue(JSON.stringify(progress));
    const factory = await importFactory();
    factory({ onMessage: vi.fn() });
    const channelOpts = mocks.WhatsAppChannel.mock.calls[0][0] as {
      host: {
        getObservedMediaBackfillProgress: () => unknown;
        setObservedMediaBackfillProgress: (value: typeof progress) => void;
      };
    };

    expect(channelOpts.host.getObservedMediaBackfillProgress()).toEqual(
      progress,
    );
    expect(mocks.getRouterState).toHaveBeenCalledWith(
      'whatsapp_observer_media_backfill.v1',
    );

    channelOpts.host.setObservedMediaBackfillProgress(progress);
    expect(mocks.setRouterState).toHaveBeenCalledWith(
      'whatsapp_observer_media_backfill.v1',
      JSON.stringify(progress),
    );
  });

  it('ignores malformed local backfill progress without logging its value', async () => {
    mocks.getRouterState.mockReturnValue('{PRIVATE_JID_NOT_VALID_JSON');
    const factory = await importFactory();
    factory({ onMessage: vi.fn() });
    const channelOpts = mocks.WhatsAppChannel.mock.calls[0][0] as {
      host: { getObservedMediaBackfillProgress: () => unknown };
    };

    expect(channelOpts.host.getObservedMediaBackfillProgress()).toBeUndefined();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { errorKind: 'SyntaxError' },
      'WhatsApp observer media backfill progress ignored',
    );
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain(
      'PRIVATE_JID',
    );
  });

  it('walks past two hundred incomplete chats without repeating or starving one', async () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE observed_whatsapp_messages (
          message_id TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          from_me INTEGER NOT NULL,
          message_kind TEXT NOT NULL,
          media_enriched INTEGER NOT NULL,
          PRIMARY KEY (message_id, chat_jid)
        )
      `);
      const insert = db.prepare(
        `INSERT INTO observed_whatsapp_messages
          (message_id, chat_jid, timestamp, from_me, message_kind, media_enriched)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (let index = 0; index < 205; index += 1) {
        const suffix = String(index).padStart(3, '0');
        const chatJid = `chat-${suffix}@s.whatsapp.net`;
        const gapTime = new Date(
          Date.UTC(2026, 6, 1, 0, index * 2, 0),
        ).toISOString();
        const anchorTime = new Date(Date.parse(gapTime) + 1_000).toISOString();
        insert.run(
          `gap-${suffix}`,
          chatJid,
          gapTime,
          0,
          index % 2 === 0 ? 'voice' : 'image',
          0,
        );
        insert.run(`anchor-${suffix}`, chatJid, anchorTime, 1, 'text', 0);
      }
      insert.run(
        'tie-gap',
        'tie@s.whatsapp.net',
        '2026-06-01T00:00:00.000Z',
        0,
        'video',
        0,
      );
      insert.run(
        'same-time-is-not-an-anchor',
        'tie@s.whatsapp.net',
        '2026-06-01T00:00:00.000Z',
        1,
        'text',
        0,
      );
      insert.run(
        'strictly-newer-anchor',
        'tie@s.whatsapp.net',
        '2026-06-01T00:00:01.000Z',
        1,
        'text',
        0,
      );
      insert.run(
        'terminal-gap',
        'terminal@s.whatsapp.net',
        '2026-07-04T00:00:00.000Z',
        0,
        'document',
        0,
      );
      // LID history can be observed before it is resolved to a phone JID,
      // but Baileys fetchMessageHistory cannot use it as a safe backfill
      // anchor. Give it a valid newer row and verify SQL still excludes it.
      insert.run(
        'lid-gap',
        'unresolved@lid',
        '2026-07-05T00:00:00.000Z',
        0,
        'voice',
        0,
      );
      insert.run(
        'lid-anchor',
        'unresolved@lid',
        '2026-07-05T00:00:01.000Z',
        1,
        'text',
        0,
      );
      mocks.getDb.mockReturnValue(db);
      const factory = await importFactory();
      factory({ onMessage: vi.fn() });
      const channelOpts = mocks.WhatsAppChannel.mock.calls[0][0] as {
        host: {
          getObservedMediaBackfillAnchors: (
            limit: number,
            excludedChatJids?: readonly string[],
          ) => Array<{ chatJid: string; messageId: string }>;
        };
      };
      const visited: string[] = [];
      for (let index = 0; index < 205; index += 1) {
        const [anchor] = channelOpts.host.getObservedMediaBackfillAnchors(
          1,
          visited,
        );
        expect(anchor).toBeDefined();
        visited.push(anchor.chatJid);
      }

      expect(new Set(visited).size).toBe(205);
      expect(visited).toContain('chat-004@s.whatsapp.net');
      expect(visited).toContain('chat-204@s.whatsapp.net');
      const [tieAnchor] = channelOpts.host.getObservedMediaBackfillAnchors(
        1,
        visited,
      );
      expect(tieAnchor).toMatchObject({
        chatJid: 'tie@s.whatsapp.net',
        messageId: 'strictly-newer-anchor',
        timestamp: '2026-06-01T00:00:01.000Z',
      });
      expect(
        channelOpts.host.getObservedMediaBackfillAnchors(1, [
          ...visited,
          'tie@s.whatsapp.net',
        ]),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});
