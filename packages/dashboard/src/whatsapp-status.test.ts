import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readEnvFile: vi.fn(),
  readDb: vi.fn(),
}));

vi.mock('@skoobi/shared/env', () => ({ readEnvFile: mocks.readEnvFile }));
vi.mock('./db.js', () => ({ readDb: mocks.readDb }));

import { collectWhatsAppStatus } from './whatsapp-status.js';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');

function createDb(withTable = true): Database.Database {
  const db = new Database(':memory:');
  if (withTable) {
    db.exec(`
      CREATE TABLE observed_whatsapp_messages (
        message_id TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        timestamp TEXT NOT NULL,
        message_kind TEXT NOT NULL DEFAULT 'text',
        media_enriched INTEGER NOT NULL DEFAULT 0,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (message_id, chat_jid)
      );
    `);
  }
  return db;
}

function enableWhatsApp() {
  mocks.readEnvFile.mockReturnValue({
    SKOOBI_WHATSAPP_CHANNEL_ENABLED: 'true',
    SKOOBI_WHATSAPP_PERSONAL_OBSERVER_ENABLED: 'true',
  });
}

describe('collectWhatsAppStatus', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.SKOOBI_WHATSAPP_CHANNEL_ENABLED;
    delete process.env.SKOOBI_WHATSAPP_PERSONAL_OBSERVER_ENABLED;
    mocks.readEnvFile.mockReset();
    mocks.readDb.mockReset();
  });

  it('считает свежие сообщения и локальную очередь медиа без чтения content', () => {
    enableWhatsApp();
    const db = createDb();
    const insert = db.prepare(
      `INSERT INTO observed_whatsapp_messages
         (message_id, chat_jid, content, timestamp, message_kind,
          media_enriched, observed_at)
       VALUES (?, '1@s.whatsapp.net', ?, ?, ?, ?, ?)`,
    );
    insert.run(
      'text-1',
      'private text',
      '2026-07-15T11:00:00.000Z',
      'text',
      0,
      '2026-07-15T11:00:01.000Z',
    );
    insert.run(
      'voice-1',
      'private transcript',
      '2026-07-15T10:00:00.000Z',
      'voice',
      1,
      '2026-07-15T10:05:00.000Z',
    );
    insert.run(
      'image-1',
      'private description',
      '2026-07-15T09:00:00.000Z',
      'image',
      0,
      '2026-07-15T09:00:01.000Z',
    );
    insert.run(
      'old-video',
      'private description',
      '2026-07-10T09:00:00.000Z',
      'video',
      0,
      '2026-07-10T09:10:00.000Z',
    );
    mocks.readDb.mockReturnValue(db);

    expect(collectWhatsAppStatus(NOW)).toEqual({
      state: 'warn',
      detail:
        'Данные WhatsApp поступали 59 мин назад; 1 медиафайл за сутки пока без локального разбора.',
      channelEnabled: true,
      observerEnabled: true,
      tableAvailable: true,
      lastObservedAt: '2026-07-15T11:00:01.000Z',
      lastObservedAgo: '59 мин назад',
      messages24h: 3,
      media24h: 2,
      unprocessedMedia: 1,
      lastEnrichedAt: '2026-07-15T10:05:00.000Z',
      lastEnrichedAgo: '1 ч 55 м назад',
    });
    db.close();
  });

  it('возвращает ok только для свежих данных с обработанной media-очередью', () => {
    enableWhatsApp();
    const db = createDb();
    db.prepare(
      `INSERT INTO observed_whatsapp_messages
         (message_id, chat_jid, timestamp, message_kind,
          media_enriched, observed_at)
       VALUES ('voice-1', '1@s.whatsapp.net', ?, 'voice', 1, ?)`,
    ).run('2026-07-15T11:30:00.000Z', '2026-07-15T11:31:00.000Z');
    mocks.readDb.mockReturnValue(db);

    const status = collectWhatsAppStatus(NOW);
    expect(status.state).toBe('ok');
    expect(status.detail).toBe(
      'Данные WhatsApp поступали 29 мин назад; за последние сутки не осталось медиа без локального разбора.',
    );
    db.close();
  });

  it('не выдаёт env-флаги за живое подключение при старых данных', () => {
    enableWhatsApp();
    const db = createDb();
    db.prepare(
      `INSERT INTO observed_whatsapp_messages
         (message_id, chat_jid, timestamp, message_kind,
          media_enriched, observed_at)
       VALUES ('text-1', '1@s.whatsapp.net', ?, 'text', 0, ?)`,
    ).run('2026-07-12T12:00:00.000Z', '2026-07-12T12:00:00.000Z');
    mocks.readDb.mockReturnValue(db);

    const status = collectWhatsAppStatus(NOW);
    expect(status.state).toBe('warn');
    expect(status.detail).toContain('последний раз поступали 3 дн назад');
    expect(status.detail).toContain('подключение');
    expect(status.detail).not.toMatch(
      /(?:^|\s)подключ[её]н(?:о|а|ы)?(?:\s|$)/i,
    );
    db.close();
  });

  it('честно сообщает о выключенном канале и частичной конфигурации', () => {
    const db = createDb();
    mocks.readDb.mockReturnValue(db);
    mocks.readEnvFile.mockReturnValue({});
    expect(collectWhatsAppStatus(NOW)).toMatchObject({
      state: 'down',
      channelEnabled: false,
      observerEnabled: false,
      detail: 'Канал WhatsApp выключен в локальной конфигурации.',
    });

    mocks.readEnvFile.mockReturnValue({
      SKOOBI_WHATSAPP_CHANNEL_ENABLED: 'true',
    });
    expect(collectWhatsAppStatus(NOW)).toMatchObject({
      state: 'warn',
      channelEnabled: true,
      observerEnabled: false,
      detail:
        'Канал включён, но синхронизация личных диалогов WhatsApp выключена.',
    });
    db.close();
  });

  it('обрабатывает отсутствие таблицы и недоступную БД без исключения', () => {
    enableWhatsApp();
    const db = createDb(false);
    mocks.readDb.mockReturnValue(db);
    expect(collectWhatsAppStatus(NOW)).toMatchObject({
      state: 'down',
      tableAvailable: false,
      messages24h: 0,
      unprocessedMedia: 0,
      detail: 'Локальное хранилище синхронизации WhatsApp недоступно.',
    });
    db.close();

    mocks.readDb.mockImplementation(() => {
      throw new Error('/private/path/messages.db unavailable');
    });
    expect(collectWhatsAppStatus(NOW)).toMatchObject({
      state: 'down',
      tableAvailable: false,
    });
  });

  it('использует process env как runtime override', () => {
    mocks.readEnvFile.mockReturnValue({
      SKOOBI_WHATSAPP_CHANNEL_ENABLED: 'false',
      SKOOBI_WHATSAPP_PERSONAL_OBSERVER_ENABLED: 'false',
    });
    vi.stubEnv('SKOOBI_WHATSAPP_CHANNEL_ENABLED', 'yes');
    vi.stubEnv('SKOOBI_WHATSAPP_PERSONAL_OBSERVER_ENABLED', '1');
    const db = createDb();
    mocks.readDb.mockReturnValue(db);

    expect(collectWhatsAppStatus(NOW)).toMatchObject({
      channelEnabled: true,
      observerEnabled: true,
      state: 'warn',
    });
    db.close();
  });
});
