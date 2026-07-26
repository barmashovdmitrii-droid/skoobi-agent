import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ readDb: vi.fn() }));

import Database from 'better-sqlite3';

import {
  cleanDialogText,
  collectChatMessages,
  collectChats,
  collectServices,
} from './collectors.js';
import { readDb } from './db.js';
import type { DashboardDialogState } from './dialog-state.js';

let db: InstanceType<typeof Database>;
const originalServiceLabel = process.env.SKOOBI_SERVICE_LABEL;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function dialogState(
  overrides: Partial<DashboardDialogState> = {},
): DashboardDialogState {
  return {
    version: 1,
    pinned: [],
    aliases: {},
    links: {},
    updatedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      is_main INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      sender TEXT NOT NULL,
      sender_name TEXT,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      is_from_me INTEGER NOT NULL DEFAULT 0,
      is_bot_message INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE observed_whatsapp_messages (
      message_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      local_chat_label TEXT NOT NULL DEFAULT '',
      local_sender_label TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 0,
      message_kind TEXT NOT NULL DEFAULT 'text',
      media_enriched INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (message_id, chat_jid)
    );
  `);
  vi.mocked(readDb).mockReturnValue(db as never);
});

afterEach(() => {
  db.close();
  if (originalServiceLabel === undefined)
    delete process.env.SKOOBI_SERVICE_LABEL;
  else process.env.SKOOBI_SERVICE_LABEL = originalServiceLabel;
  vi.clearAllMocks();
});

describe('collectServices', () => {
  it('matches a custom main label without broadening the service set', async () => {
    process.env.SKOOBI_SERVICE_LABEL = 'com.skoobi.team_1';
    const launchctlExecutor = vi.fn(async () => ({
      stdout: '123\t0\tcom.skoobi.team_1\n456\t0\tcom.skoobi.dashboard\n',
    }));

    const services = await collectServices({ launchctlExecutor });

    expect(launchctlExecutor).toHaveBeenCalledWith('launchctl', ['list'], {
      timeout: 5000,
    });
    expect(services).toEqual([
      {
        id: 'main',
        name: 'Скуби',
        state: 'ok',
        detail: 'работает',
      },
      {
        id: 'dashboard',
        name: 'Локальная панель',
        state: 'ok',
        detail: 'работает',
      },
    ]);
  });
});

describe('collectChats (единые диалоги)', () => {
  it('объединяет Telegram и observed WhatsApp без дублей', () => {
    const directJid = '77012345678@s.whatsapp.net';
    const groupJid = '120363400001234567@g.us';
    const oldMainMessage = iso(-48 * 60 * 60_000);
    const recentDirectMessage = iso(-30 * 60_000);
    const recentGroupMessage = iso(-10 * 60_000);

    const insertGroup = db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, is_main)
       VALUES (?, ?, ?, ?)`,
    );
    insertGroup.run('tg:123456789', 'Главный чат', 'main', 1);
    insertGroup.run(directJid, 'Личный WhatsApp', 'whatsapp', 1);

    const insertMessage = db.prepare(
      `INSERT INTO messages
         (id, chat_jid, sender, sender_name, content, timestamp,
          is_from_me, is_bot_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertMessage.run(
      'tg-1',
      'tg:123456789',
      'owner',
      'Владелец',
      'Привет',
      oldMainMessage,
      1,
      0,
    );
    // Эта строка нужна именно для проверки дедупликации:
    // при наличии observer зарегистрированный WhatsApp не добавляется второй раз.
    insertMessage.run(
      'wa-registered',
      directJid,
      'owner',
      'Владелец',
      'Старая копия',
      iso(-20 * 60_000),
      1,
      0,
    );

    const insertObserved = db.prepare(
      `INSERT INTO observed_whatsapp_messages
         (message_id, chat_jid, local_chat_label, local_sender_label, content,
          timestamp, from_me, message_kind, media_enriched)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertObserved.run(
      'wa-1',
      directJid,
      'Контакт',
      'Собеседник',
      'Свежее сообщение',
      recentDirectMessage,
      0,
      'text',
      0,
    );
    insertObserved.run(
      'wa-2',
      groupJid,
      'Рабочая группа',
      'Участник',
      'Видео',
      recentGroupMessage,
      0,
      'video',
      1,
    );

    const chats = collectChats({ dialogState: dialogState() });

    expect(chats.map((chat) => chat.jid)).toEqual([
      'tg:123456789',
      groupJid,
      directJid,
    ]);
    expect(chats.filter((chat) => chat.jid === directJid)).toHaveLength(1);
    expect(chats.find((chat) => chat.jid === directJid)).toMatchObject({
      name: 'Контакт •••• 5678',
      needsReply: true,
      attentionReason: 'Ждёт ответа',
    });
    expect(chats[0]).toMatchObject({
      channel: 'telegram',
      isMain: true,
      canSend: true,
    });
    for (const chat of chats.filter((item) => item.channel === 'whatsapp')) {
      expect(chat).toMatchObject({
        canPause: false,
        readOnly: true,
        paused: false,
      });
    }
  });

  it('applies local pins, aliases, links and attention without changing channels', () => {
    const whatsapp = '77012345678@s.whatsapp.net';
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, is_main)
       VALUES (?, ?, ?, ?)`,
    ).run('tg:123456789', 'Главный чат', 'main', 1);
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, is_main)
       VALUES (?, ?, ?, ?)`,
    ).run('tg:987654321', 'Рабочий Telegram', 'work', 0);
    db.prepare(
      `INSERT INTO messages
         (id, chat_jid, sender, sender_name, content, timestamp,
          is_from_me, is_bot_message)
       VALUES ('tg-work', 'tg:987654321', 'person', 'Контакт', ?, ?, 0, 0)`,
    ).run('Сможешь проверить завтра?', iso(-20 * 60_000));
    db.prepare(
      `INSERT INTO observed_whatsapp_messages
         (message_id, chat_jid, local_chat_label, local_sender_label, content,
          timestamp, from_me, message_kind, media_enriched)
       VALUES ('wa-1', ?, 'Контакт', 'Собеседник', 'Привет', ?, 0, 'text', 0)`,
    ).run(whatsapp, iso(-10 * 60_000));

    const chats = collectChats({
      dialogState: dialogState({
        pinned: ['tg:987654321'],
        aliases: { [whatsapp]: 'Артём в WhatsApp' },
        links: {
          'tg:123456789': [whatsapp],
          [whatsapp]: ['tg:123456789'],
        },
      }),
    });

    expect(chats.map((chat) => chat.jid)).toEqual([
      'tg:123456789',
      'tg:987654321',
      whatsapp,
    ]);
    expect(chats[1]).toMatchObject({
      pinned: true,
      needsReply: true,
      attentionReason: 'Есть вопрос',
    });
    expect(chats[2]).toMatchObject({
      name: 'Артём в WhatsApp',
      sourceName: 'Контакт •••• 5678',
      localAlias: 'Артём в WhatsApp',
      linkedChats: [
        {
          jid: 'tg:123456789',
          name: 'Главный чат',
          channel: 'telegram',
        },
      ],
    });
    expect(chats[0].linkedChats).toEqual([
      { jid: whatsapp, name: 'Артём в WhatsApp', channel: 'whatsapp' },
    ]);
  });
});

describe('collectChatMessages (WhatsApp)', () => {
  it('сохраняет тип медиа и статус разбора, но скрывает локальные пути', () => {
    const jid = '77012345678@s.whatsapp.net';
    const insert = db.prepare(
      `INSERT INTO observed_whatsapp_messages
         (message_id, chat_jid, local_chat_label, local_sender_label, content,
          timestamp, from_me, message_kind, media_enriched)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      'media-1',
      jid,
      'Контакт',
      'Собеседник',
      'Фото\nфайл: received/private-photo.jpg',
      iso(-3_000),
      0,
      'image',
      1,
    );
    insert.run(
      'media-2',
      jid,
      'Контакт',
      'Собеседник',
      'Видео\nreceived/private-video.mp4',
      iso(-2_000),
      0,
      'video',
      0,
    );
    insert.run(
      'media-3',
      jid,
      'Контакт',
      'Владелец',
      'Голосовое\nreceived/private-audio.ogg',
      iso(-1_000),
      1,
      'voice',
      1,
    );

    const messages = collectChatMessages(jid);

    expect(messages.map((message) => message.kind)).toEqual([
      'image',
      'video',
      'voice',
    ]);
    expect(messages.map((message) => message.mediaEnriched)).toEqual([
      true,
      false,
      true,
    ]);
    expect(messages[2]).toMatchObject({
      outgoing: true,
      sender: 'Вы',
    });
    for (const message of messages) {
      expect(message.text).not.toContain('received/');
      expect(message.text).not.toMatch(/private-(?:photo|video|audio)/u);
    }
  });

  it('hides local media names with spaces and Cyrillic characters', () => {
    const cleaned = cleanDialogText(
      'Документ; файл: received/2026-07-15-прайс июль.xlsx. Подпись: свежий',
    );
    expect(cleaned).toBe('Документ; файл сохранён локально. Подпись: свежий');
    expect(cleaned).not.toContain('received/');
    expect(cleaned).not.toContain('прайс июль.xlsx');
  });
});

describe('collectChatMessages (Telegram media)', () => {
  it('recognizes locally stored Telegram media placeholders', () => {
    const jid = 'tg:123456789';
    db.prepare(
      `INSERT INTO messages
         (id, chat_jid, sender, sender_name, content, timestamp,
          is_from_me, is_bot_message)
       VALUES ('voice-1', ?, 'owner', 'Владелец', ?, ?, 0, 0)`,
    ).run(jid, '[Voice: Проверка расшифровки]', iso(-1_000));
    expect(collectChatMessages(jid)[0]).toMatchObject({
      kind: 'voice',
      text: '[Voice: Проверка расшифровки]',
    });
  });
});
