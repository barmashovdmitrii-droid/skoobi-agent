import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import {
  collectDialogMessagePageFromDb,
  decodeDialogMessageAnchor,
  DialogHistoryInputError,
  searchDialogsFromDb,
} from './dialog-history.js';

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL DEFAULT '',
      is_main INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      id TEXT,
      chat_jid TEXT NOT NULL,
      sender TEXT NOT NULL,
      sender_name TEXT,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      is_from_me INTEGER NOT NULL DEFAULT 0,
      is_bot_message INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (id, chat_jid)
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
});

afterEach(() => db.close());

function addTelegram(
  id: string,
  content: string,
  timestamp: string,
  jid = 'tg:123456789',
): void {
  db.prepare(
    `INSERT OR IGNORE INTO registered_groups (jid, name, folder, is_main)
     VALUES (?, 'Telegram', '', 0)`,
  ).run(jid);
  db.prepare(
    `INSERT INTO messages
       (id, chat_jid, sender, sender_name, content, timestamp,
        is_from_me, is_bot_message)
     VALUES (?, ?, 'owner', 'Owner', ?, ?, 0, 0)`,
  ).run(id, jid, content, timestamp);
}

function addWhatsapp(
  id: string,
  content: string,
  timestamp: string,
  options: {
    jid?: string;
    kind?: string;
    chatName?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO observed_whatsapp_messages
       (message_id, chat_jid, local_chat_label, local_sender_label, content,
        timestamp, from_me, message_kind, media_enriched)
     VALUES (?, ?, ?, 'Собеседник', ?, ?, 0, ?, 0)`,
  ).run(
    id,
    options.jid || '77012345678@s.whatsapp.net',
    options.chatName || 'WhatsApp',
    content,
    timestamp,
    options.kind || 'text',
  );
}

describe('dialog history cursor pagination', () => {
  it('does not skip or duplicate messages with identical timestamps', () => {
    const jid = 'tg:123456789';
    const sameTimestamp = '2026-07-15T10:00:00.000Z';
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      addTelegram(id, id.toUpperCase(), sameTimestamp, jid);
    }

    const latest = collectDialogMessagePageFromDb(db, jid, { limit: 2 });
    expect(latest.messages.map((message) => message.text)).toEqual(['D', 'E']);
    expect(latest.hasMore).toBe(true);
    expect(latest.nextCursor).toBeTruthy();

    // A newly arrived row sorts after the first page and must not leak into
    // its older continuation or shift the cursor.
    addTelegram('z', 'NEW', '2026-07-15T10:01:00.000Z', jid);
    const middle = collectDialogMessagePageFromDb(db, jid, {
      limit: 2,
      cursor: latest.nextCursor!,
    });
    const oldest = collectDialogMessagePageFromDb(db, jid, {
      limit: 2,
      cursor: middle.nextCursor!,
    });

    expect(middle.messages.map((message) => message.text)).toEqual(['B', 'C']);
    expect(oldest.messages.map((message) => message.text)).toEqual(['A']);
    expect(oldest.hasMore).toBe(false);
    expect(oldest.nextCursor).toBeNull();
    const originalHistory = [
      ...oldest.messages,
      ...middle.messages,
      ...latest.messages,
    ].map((message) => message.text);
    expect(originalHistory).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(new Set(originalHistory).size).toBe(originalHistory.length);
  });

  it('rejects malformed, cross-chat, and deleted anchors', () => {
    addTelegram('one', 'Найти это', '2026-07-15T10:00:00.000Z');
    const result = searchDialogsFromDb(db, 'найти', 10)[0];
    expect(result).toBeTruthy();

    expect(() =>
      collectDialogMessagePageFromDb(db, 'tg:123456789', {
        cursor: `${result.anchor}x`,
      }),
    ).toThrow(DialogHistoryInputError);
    expect(() =>
      collectDialogMessagePageFromDb(db, 'tg:987654321', {
        anchor: result.anchor,
      }),
    ).toThrow(DialogHistoryInputError);

    db.prepare('DELETE FROM messages WHERE id = ? AND chat_jid = ?').run(
      'one',
      'tg:123456789',
    );
    expect(() =>
      collectDialogMessagePageFromDb(db, 'tg:123456789', {
        anchor: result.anchor,
      }),
    ).toThrow(DialogHistoryInputError);
  });

  it('loads a bounded window that includes a search hit', () => {
    const jid = 'tg:123456789';
    for (let i = 0; i < 9; i += 1) {
      addTelegram(
        `m-${i}`,
        i === 4 ? 'Точное контрольное сообщение' : `Обычное ${i}`,
        `2026-07-15T10:00:0${i}.000Z`,
        jid,
      );
    }
    const hit = searchDialogsFromDb(db, 'контрольное', 10)[0];
    const page = collectDialogMessagePageFromDb(db, jid, {
      limit: 5,
      anchor: hit.anchor,
    });

    expect(page.anchored).toBe(true);
    expect(page.messages).toHaveLength(5);
    expect(page.messages.some((message) => message.anchor === hit.anchor)).toBe(
      true,
    );
    expect(page.messages.map((message) => message.text)).toContain(
      'Точное контрольное сообщение',
    );
  });

  it('uses the same stable cursor and anchor rules for WhatsApp media', () => {
    const jid = '77012345678@s.whatsapp.net';
    const insert = db.prepare(
      `INSERT INTO observed_whatsapp_messages
         (message_id, chat_jid, local_chat_label, local_sender_label, content,
          timestamp, from_me, message_kind, media_enriched)
       VALUES (?, ?, 'Контакт', 'Собеседник', ?, ?, 0, 'voice', 1)`,
    );
    const timestamp = '2026-07-15T12:00:00.000Z';
    for (const id of ['wa-a', 'wa-b', 'wa-c']) {
      insert.run(id, jid, `Голосовое: ${id}`, timestamp);
    }

    const latest = collectDialogMessagePageFromDb(db, jid, { limit: 2 });
    expect(latest.messages.map((message) => message.text)).toEqual([
      'wa-b',
      'wa-c',
    ]);
    const older = collectDialogMessagePageFromDb(db, jid, {
      limit: 2,
      cursor: latest.nextCursor!,
    });
    expect(older.messages.map((message) => message.text)).toEqual(['wa-a']);

    const hit = searchDialogsFromDb(db, 'wa-b', 10)[0];
    const anchored = collectDialogMessagePageFromDb(db, jid, {
      limit: 3,
      anchor: hit.anchor,
    });
    expect(
      anchored.messages.some((message) => message.anchor === hit.anchor),
    ).toBe(true);
    expect(decodeDialogMessageAnchor(jid, hit.anchor)).toEqual({ id: 'wa-b' });
    expect(Object.keys(hit)).not.toContain('id');
    expect(() => decodeDialogMessageAnchor('tg:123456789', hit.anchor)).toThrow(
      DialogHistoryInputError,
    );
    expect(() => decodeDialogMessageAnchor(jid, `${hit.anchor}x`)).toThrow(
      DialogHistoryInputError,
    );
  });

  it('caps a single page at one hundred messages', () => {
    for (let i = 0; i < 105; i += 1) {
      addTelegram(
        `limit-${String(i).padStart(3, '0')}`,
        `Сообщение ${i}`,
        `2026-07-15T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(
          i % 60,
        ).padStart(2, '0')}.000Z`,
      );
    }
    const page = collectDialogMessagePageFromDb(db, 'tg:123456789', {
      limit: 1_000,
    });
    expect(page.messages).toHaveLength(100);
    expect(page.hasMore).toBe(true);
  });
});

describe('local dialog search', () => {
  it('searches Telegram, WhatsApp labels, senders, and media locally', () => {
    db.prepare(
      `INSERT OR REPLACE INTO registered_groups (jid, name, folder, is_main)
       VALUES ('tg:123456789', 'Проект Актау', 'main', 1)`,
    ).run();
    addTelegram(
      'tg-contract',
      'Проверить договор завтра',
      '2026-07-15T10:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO observed_whatsapp_messages
         (message_id, chat_jid, local_chat_label, local_sender_label, content,
          timestamp, from_me, message_kind, media_enriched)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'wa-voice',
      '77012345678@s.whatsapp.net',
      'Артём',
      'Айгуль',
      'Голосовое WhatsApp: Встреча у моря\nфайл: received/private.ogg',
      '2026-07-15T11:00:00.000Z',
      0,
      'voice',
      1,
    );

    const byTelegramName = searchDialogsFromDb(db, 'актау', 10);
    expect(byTelegramName).toHaveLength(1);
    expect(byTelegramName[0]).toMatchObject({
      channel: 'telegram',
      jid: 'tg:123456789',
      chatName: 'Проект Актау',
      kind: 'text',
    });

    const byTranscript = searchDialogsFromDb(db, 'встреча', 10);
    expect(byTranscript).toHaveLength(1);
    expect(byTranscript[0]).toMatchObject({
      channel: 'whatsapp',
      kind: 'voice',
      sender: 'Айгуль',
    });
    expect(byTranscript[0].snippet).not.toContain('received/');
    expect(byTranscript[0].snippet).not.toContain('private.ogg');

    expect(searchDialogsFromDb(db, 'артём', 10)[0].chatName).toBe('Артём');
    expect(searchDialogsFromDb(db, 'айгуль', 10)[0].sender).toBe('Айгуль');
    expect(searchDialogsFromDb(db, 'voice', 10)[0].kind).toBe('voice');
  });

  it('caps results at eighty and validates query/limit', () => {
    for (let i = 0; i < 90; i += 1) {
      addTelegram(
        `search-${String(i).padStart(3, '0')}`,
        `Общее совпадение ${i}`,
        `2026-07-15T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(
          i % 60,
        ).padStart(2, '0')}.000Z`,
      );
    }
    expect(searchDialogsFromDb(db, 'совпадение', 1_000)).toHaveLength(80);
    expect(() => searchDialogsFromDb(db, 'я', 10)).toThrow(
      DialogHistoryInputError,
    );
    expect(() => searchDialogsFromDb(db, 'нормально', 0)).toThrow(
      DialogHistoryInputError,
    );
  });

  it('preserves Telegram media kind in history and search', () => {
    addTelegram(
      'voice-local',
      '[Voice: Контрольная расшифровка]',
      '2026-07-15T11:00:00.000Z',
    );
    const page = collectDialogMessagePageFromDb(db, 'tg:123456789');
    expect(page.messages[0].kind).toBe('voice');
    const result = searchDialogsFromDb(db, 'расшифровка', 10)[0];
    expect(result.kind).toBe('voice');
  });

  it('does not return orphan Telegram messages that cannot be opened in dialogs', () => {
    db.prepare(
      `INSERT INTO messages
         (id, chat_jid, sender, sender_name, content, timestamp,
          is_from_me, is_bot_message)
       VALUES ('orphan', 'tg:999999999', 'owner', 'Owner',
               'Старое контрольное совпадение', '2026-07-15T12:00:00.000Z', 0, 0)`,
    ).run();

    expect(searchDialogsFromDb(db, 'контрольное совпадение', 10)).toEqual([]);
  });

  it('applies channel, media, and allowed-dialog filters inside each SQL query', () => {
    addTelegram(
      'tg-text',
      'Общее совпадение в тексте',
      '2026-07-15T10:00:00.000Z',
    );
    addTelegram(
      'tg-voice',
      '[Voice: Общее совпадение в голосовом]',
      '2026-07-15T10:01:00.000Z',
    );
    addWhatsapp(
      'wa-text',
      'Общее совпадение в тексте',
      '2026-07-15T10:02:00.000Z',
    );
    addWhatsapp(
      'wa-image',
      'Фото: Общее совпадение',
      '2026-07-15T10:03:00.000Z',
      { kind: 'image' },
    );

    expect(
      searchDialogsFromDb(db, 'совпадение', 10, { channel: 'telegram' }).map(
        (result) => result.channel,
      ),
    ).toEqual(['telegram', 'telegram']);
    expect(
      searchDialogsFromDb(db, 'совпадение', 10, { channel: 'whatsapp' }).map(
        (result) => result.channel,
      ),
    ).toEqual(['whatsapp', 'whatsapp']);
    expect(
      searchDialogsFromDb(db, 'совпадение', 10, { mediaOnly: true }).map(
        (result) => result.kind,
      ),
    ).toEqual(['image', 'voice']);
    expect(
      searchDialogsFromDb(db, 'совпадение', 10, {
        allowedJids: ['tg:123456789'],
      }).map((result) => result.jid),
    ).toEqual(['tg:123456789', 'tg:123456789']);
  });

  it('does not lose filtered hits behind the unfiltered result limit', () => {
    const noisyJid = 'tg:111111111';
    for (let i = 0; i < 85; i += 1) {
      addTelegram(
        `newer-${String(i).padStart(3, '0')}`,
        `Контрольное совпадение ${i}`,
        `2026-07-15T12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(
          i % 60,
        ).padStart(2, '0')}.000Z`,
        noisyJid,
      );
    }
    const allowedJid = 'tg:222222222';
    addTelegram(
      'old-allowed',
      'Контрольное совпадение в нужном диалоге',
      '2026-07-14T09:00:00.000Z',
      allowedJid,
    );
    addWhatsapp(
      'old-wa-media',
      'Голосовое: контрольное совпадение',
      '2026-07-14T08:00:00.000Z',
      { kind: 'voice' },
    );

    expect(
      searchDialogsFromDb(db, 'контрольное совпадение', 1, {
        channel: 'whatsapp',
      })[0],
    ).toMatchObject({ channel: 'whatsapp', kind: 'voice' });
    expect(
      searchDialogsFromDb(db, 'контрольное совпадение', 1, {
        mediaOnly: true,
      })[0],
    ).toMatchObject({ channel: 'whatsapp', kind: 'voice' });
    expect(
      searchDialogsFromDb(db, 'контрольное совпадение', 1, {
        allowedJids: [allowedJid],
      })[0],
    ).toMatchObject({ jid: allowedJid });
  });

  it('validates bounded allowed JIDs and treats an empty list as no matches', () => {
    addTelegram(
      'allowed-validation',
      'Контрольное совпадение',
      '2026-07-15T10:00:00.000Z',
    );

    expect(
      searchDialogsFromDb(db, 'контрольное', 10, { allowedJids: [] }),
    ).toEqual([]);
    expect(() =>
      searchDialogsFromDb(db, 'контрольное', 10, {
        allowedJids: ['tg:123456789) OR 1=1 --'],
      }),
    ).toThrow(DialogHistoryInputError);
    expect(() =>
      searchDialogsFromDb(db, 'контрольное', 10, {
        allowedJids: new Array(1_001).fill('tg:123456789'),
      }),
    ).toThrow(DialogHistoryInputError);
    expect(() =>
      searchDialogsFromDb(db, 'контрольное', 10, {
        channel: 'email',
      } as any),
    ).toThrow(DialogHistoryInputError);
  });
});
