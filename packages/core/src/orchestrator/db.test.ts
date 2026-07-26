import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ASSISTANT_NAME } from './config.js';
import {
  _initTestDatabase,
  createSchema,
  createTask,
  deleteTask,
  getAllCalendarEventLinks,
  getAllChats,
  getDb,
  getAllRegisteredGroups,
  getCalendarEventLink,
  getMessagesSince,
  getNewMessages,
  getRecentConversationMessages,
  getRecentConversationMessagesForExactJids,
  getTaskById,
  hardenDatabaseFilePermissions,
  logTaskRun,
  setRegisteredGroup,
  storeBotReply,
  storeChatMetadata,
  storeMessage,
  updateTask,
  upsertCalendarEventLink,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
    is_bot_message: overrides.is_bot_message ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'skoobi_bot',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('persists Telegram update metadata for the message loop', () => {
    storeChatMetadata(
      'tg:100000001',
      '2026-07-05T06:11:16.000Z',
      'Owner',
      'telegram',
      true,
    );

    storeMessage({
      id: '16601',
      chat_jid: 'tg:100000001',
      sender: '100000001',
      sender_name: 'Owner',
      content: 'Скуби, проверь статус сервиса',
      timestamp: '2026-07-05T06:11:16.000Z',
      is_from_me: false,
      is_bot_message: false,
      telegram_update_id: '600000001',
      sender_identity: {
        channel: 'telegram',
        chat_id: '100000001',
        telegram_user_id: '100000001',
        identity_id: 'telegram_user_100000001',
        is_owner_sender: true,
        telegram_message_origin: 'direct',
      },
    });

    const { messages } = getNewMessages(
      ['tg:100000001'],
      '2026-07-05T06:11:15.000Z',
      'skoobi_bot',
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].telegram_update_id).toBe('600000001');
    expect(messages[0].sender_identity).toMatchObject({
      telegram_user_id: '100000001',
      identity_id: 'telegram_user_100000001',
      is_owner_sender: true,
      telegram_message_origin: 'direct',
    });
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'skoobi_bot',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'skoobi_bot',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'skoobi_bot',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'skoobi_bot',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'skoobi_bot',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'skoobi_bot');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: '[skoobi_bot] old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'skoobi_bot',
    );
    expect(msgs).toHaveLength(0);
  });
});

describe('recent conversation context', () => {
  beforeEach(() => {
    storeChatMetadata('tg:1', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('tg:2', '2024-01-01T00:00:00.000Z');
    store({
      id: 'u1',
      chat_jid: 'tg:1',
      sender: 'tg:1',
      sender_name: 'User',
      content: 'sent document',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    storeBotReply('tg:1', 'I read the document', '2024-01-01T00:00:02.000Z');
    store({
      id: 'u2',
      chat_jid: 'tg:1',
      sender: 'tg:1',
      sender_name: 'User',
      content: 'new question',
      timestamp: '2024-01-01T00:00:03.000Z',
    });
    store({
      id: 'other',
      chat_jid: 'tg:2',
      sender: 'tg:2',
      sender_name: 'Other',
      content: 'other chat secret',
      timestamp: '2024-01-01T00:00:02.500Z',
    });
  });

  it('includes prior bot replies for the same chat only', () => {
    const messages = getRecentConversationMessages(
      'tg:1',
      '2024-01-01T00:00:03.000Z',
      10,
    );

    expect(messages.map((m) => m.content)).toEqual([
      'sent document',
      'I read the document',
    ]);
    expect(messages[1].is_from_me).toBe(1);
    expect(messages[1].is_bot_message).toBe(1);
    expect(messages.some((m) => m.content.includes('secret'))).toBe(false);
  });

  it('caps recent context to the most recent rows in chronological order', () => {
    const messages = getRecentConversationMessages(
      'tg:1',
      '2024-01-01T00:00:03.000Z',
      1,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('I read the document');
  });

  it('reads a bounded chronological tail across only the exact JID list', () => {
    const messages = getRecentConversationMessagesForExactJids(
      ['tg:1', 'tg:2', 'tg:1'],
      '2024-01-01T00:00:04.000Z',
      3,
    );

    expect(messages.map((message) => message.content)).toEqual([
      'I read the document',
      'other chat secret',
      'new question',
    ]);
    expect(
      getRecentConversationMessagesForExactJids(
        ['tg:%'],
        '2024-01-01T00:00:04.000Z',
        10,
      ),
    ).toEqual([]);
    expect(getRecentConversationMessagesForExactJids([], '', 10)).toEqual([]);
  });

  it('fails closed when the exact JID scope is unexpectedly large', () => {
    expect(() =>
      getRecentConversationMessagesForExactJids(
        Array.from({ length: 17 }, (_, index) => `tg:${index + 1}`),
        '',
        10,
      ),
    ).toThrow(/too many exact chat JIDs/i);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'skoobi_bot',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'skoobi_bot',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'skoobi_bot');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });

  it('updates timestamp when existing chat timestamp is null', () => {
    getDb()
      .prepare(
        `INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, NULL, ?, ?)`,
      )
      .run('tg:123', 'Existing', 'telegram', 0);

    storeChatMetadata(
      'tg:123',
      '2024-01-01T00:00:05.000Z',
      'Existing',
      'telegram',
      false,
    );

    const chat = getAllChats().find((row) => row.jid === 'tg:123');
    expect(chat?.last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });

  it('stores and cascades Google Calendar event links for tasks', () => {
    createTask({
      id: 'task-calendar',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'Напомни про звонок',
      schedule_type: 'once',
      schedule_value: '2026-07-09T10:00:00',
      context_mode: 'isolated',
      next_run: '2026-07-09T05:00:00.000Z',
      status: 'active',
      created_at: '2026-07-07T00:00:00.000Z',
    });

    upsertCalendarEventLink({
      task_id: 'task-calendar',
      provider: 'google_calendar',
      calendar_id: 'owner@example.com',
      event_id: 'event-1',
      event_link: 'https://calendar.google.com/event?eid=event-1',
      status: 'active',
    });

    expect(getCalendarEventLink('task-calendar')).toMatchObject({
      task_id: 'task-calendar',
      provider: 'google_calendar',
      event_id: 'event-1',
      status: 'active',
    });

    deleteTask('task-calendar');

    expect(getCalendarEventLink('task-calendar')).toBeUndefined();
    expect(getAllCalendarEventLinks()).toHaveLength(0);
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages pages oldest-first and defers the boundary row to a clean timestamp', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'skoobi_bot',
      3,
    );
    // Oldest-first, not newest-first. On hitting the limit, the row at the
    // boundary timestamp (message 3) is deferred so the cursor never advances
    // into a possibly-split same-second group; the next poll returns it. This
    // is what makes a burst past the limit page through instead of skipping —
    // see the paging and same-second tests below.
    expect(messages.map((m) => m.content)).toEqual(['message 1', 'message 2']);
    expect(newTimestamp).toBe('2024-01-01T00:00:02.000Z');
  });

  it('pages through a burst larger than the limit without skipping any message', () => {
    // Simulate the poller: repeatedly fetch with a small limit, advancing the
    // cursor by exactly what was returned. Every message must be seen once.
    let cursor = '2024-01-01T00:00:00.000Z';
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const { messages, newTimestamp } = getNewMessages(
        ['group@g.us'],
        cursor,
        'skoobi_bot',
        3,
      );
      if (messages.length === 0) break;
      seen.push(...messages.map((m) => m.content));
      cursor = newTimestamp;
    }
    expect(seen).toEqual(
      Array.from({ length: 10 }, (_, i) => `message ${i + 1}`),
    );
  });

  it('does not skip messages sharing the boundary second when a burst exceeds the limit', () => {
    // Three messages share one second (00:09). Plain oldest-first paging would
    // fetch [b1, b2, one-of-09], advance the cursor to 00:09, then skip the
    // other two 00:09 messages forever (strict `timestamp > cursor`). The
    // boundary trim must defer the whole 00:09 group and page it next poll.
    _initTestDatabase();
    storeChatMetadata('burst@g.us', '2024-01-01T00:00:00.000Z');
    const fixture: Array<[string, string]> = [
      ['b1', '2024-01-01T00:00:01.000Z'],
      ['b2', '2024-01-01T00:00:02.000Z'],
      ['b3', '2024-01-01T00:00:09.000Z'],
      ['b4', '2024-01-01T00:00:09.000Z'],
      ['b5', '2024-01-01T00:00:09.000Z'],
    ];
    for (const [id, timestamp] of fixture) {
      store({
        id,
        chat_jid: 'burst@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: id,
        timestamp,
      });
    }
    let cursor = '2024-01-01T00:00:00.000Z';
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { messages, newTimestamp } = getNewMessages(
        ['burst@g.us'],
        cursor,
        'skoobi_bot',
        3,
      );
      if (messages.length === 0) break;
      seen.push(...messages.map((m) => m.content));
      cursor = newTimestamp;
    }
    expect([...seen].sort()).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'skoobi_bot',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'skoobi_bot',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@skoobi_bot',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@skoobi_bot',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- setRegisteredGroup folder-collision safety ---

describe('setRegisteredGroup folder collision', () => {
  it('throws and preserves the existing owner when a different jid claims a taken folder', () => {
    // registered_groups has BOTH `jid` PRIMARY KEY and `folder` UNIQUE. A naive
    // INSERT OR REPLACE would resolve the folder-UNIQUE conflict by DELETING
    // jidA's row, silently handing the folder to jidB (cross-tenant data loss).
    // The scoped ON CONFLICT(jid) upsert must instead surface a constraint
    // error and leave jidA untouched.
    setRegisteredGroup('jidA@g.us', {
      name: 'Tenant A',
      folder: 'shared_folder',
      trigger: '@skoobi_bot',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    expect(() =>
      setRegisteredGroup('jidB@g.us', {
        name: 'Tenant B',
        folder: 'shared_folder',
        trigger: '@skoobi_bot',
        added_at: '2024-01-02T00:00:00.000Z',
      }),
    ).toThrow();

    const groups = getAllRegisteredGroups();
    // The victim's registration survives intact...
    expect(groups['jidA@g.us']).toBeDefined();
    expect(groups['jidA@g.us'].name).toBe('Tenant A');
    expect(groups['jidA@g.us'].folder).toBe('shared_folder');
    // ...and the attacker never got registered.
    expect(groups['jidB@g.us']).toBeUndefined();
  });

  it('throws and preserves the prior owner when an existing jid moves onto a taken folder', () => {
    setRegisteredGroup('jidA@g.us', {
      name: 'Tenant A',
      folder: 'folder_a',
      trigger: '@skoobi_bot',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    setRegisteredGroup('jidB@g.us', {
      name: 'Tenant B',
      folder: 'folder_b',
      trigger: '@skoobi_bot',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    // jidB tries to take over folder_a (already owned by jidA). The UPDATE
    // branch hits the folder UNIQUE constraint and must raise rather than
    // delete jidA.
    expect(() =>
      setRegisteredGroup('jidB@g.us', {
        name: 'Tenant B',
        folder: 'folder_a',
        trigger: '@skoobi_bot',
        added_at: '2024-01-01T00:00:00.000Z',
      }),
    ).toThrow();

    const groups = getAllRegisteredGroups();
    expect(groups['jidA@g.us']).toBeDefined();
    expect(groups['jidA@g.us'].folder).toBe('folder_a');
    // jidB keeps its original folder, unchanged.
    expect(groups['jidB@g.us']).toBeDefined();
    expect(groups['jidB@g.us'].folder).toBe('folder_b');
  });

  it('still upserts in place when the same jid re-registers (same and new folder)', () => {
    setRegisteredGroup('jidA@g.us', {
      name: 'Original',
      folder: 'folder_a',
      trigger: '@skoobi_bot',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    // Re-register the SAME jid with its SAME folder: must update in place.
    setRegisteredGroup('jidA@g.us', {
      name: 'Renamed',
      folder: 'folder_a',
      trigger: '@Bot',
      added_at: '2024-01-03T00:00:00.000Z',
    });

    let groups = getAllRegisteredGroups();
    expect(Object.keys(groups)).toHaveLength(1);
    expect(groups['jidA@g.us'].name).toBe('Renamed');
    expect(groups['jidA@g.us'].trigger).toBe('@Bot');
    expect(groups['jidA@g.us'].folder).toBe('folder_a');

    // Re-register the SAME jid moving to a FREE folder: also updates in place.
    setRegisteredGroup('jidA@g.us', {
      name: 'Renamed',
      folder: 'folder_a_moved',
      trigger: '@Bot',
      added_at: '2024-01-03T00:00:00.000Z',
    });

    groups = getAllRegisteredGroups();
    expect(Object.keys(groups)).toHaveLength(1);
    expect(groups['jidA@g.us'].folder).toBe('folder_a_moved');
  });
});

// --- Foreign-key enforcement ---

describe('foreign-key enforcement', () => {
  it('has foreign_keys enforcement enabled on the connection', () => {
    expect(getDb().pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('auto-creates the parent chat row when storing a message for an unknown JID', () => {
    // Thread auto-creation (`${chatJid}:${msgId}`) and webhook ingestion can
    // store a message for a JID with no chats row yet. The guard keeps the FK
    // satisfied rather than throwing SQLITE_CONSTRAINT_FOREIGNKEY.
    expect(() =>
      store({
        id: 'orphan-1',
        chat_jid: 'tg:123:456',
        sender: 'tg:123',
        sender_name: 'User',
        content: 'thread reply',
        timestamp: '2024-01-01T00:00:01.000Z',
      }),
    ).not.toThrow();
    expect(getAllChats().some((c) => c.jid === 'tg:123:456')).toBe(true);
  });

  it('stores a bot reply to a thread JID with no pre-existing chat row', () => {
    expect(() =>
      storeBotReply('group@g.us:thread-7', 'hi', '2024-01-01T00:00:02.000Z'),
    ).not.toThrow();
    expect(getAllChats().some((c) => c.jid === 'group@g.us:thread-7')).toBe(
      true,
    );
  });

  it('rejects a task_run_log referencing a non-existent task', () => {
    expect(() =>
      logTaskRun({
        task_id: 'no-such-task',
        run_at: '2024-01-01T00:00:00.000Z',
        duration_ms: 1,
        status: 'success',
        result: 'ok',
        error: null,
      }),
    ).toThrow();
  });

  it('allows a task_run_log for an existing task and deletes both in FK order', () => {
    createTask({
      id: 'task-fk',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'x',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    expect(() =>
      logTaskRun({
        task_id: 'task-fk',
        run_at: '2024-01-01T00:00:00.000Z',
        duration_ms: 1,
        status: 'success',
        result: 'ok',
        error: null,
      }),
    ).not.toThrow();
    // deleteTask removes child run logs first, so the parent delete succeeds.
    expect(() => deleteTask('task-fk')).not.toThrow();
    expect(getTaskById('task-fk')).toBeUndefined();
  });
});

// --- Schema migrations ---

describe('schema migrations', () => {
  it('creates the isolated observed WhatsApp message table and indexes', () => {
    const columns = getDb()
      .prepare(`PRAGMA table_info(observed_whatsapp_messages)`)
      .all() as Array<{ name: string; pk: number }>;
    expect(columns.map((column) => column.name)).toEqual([
      'message_id',
      'chat_jid',
      'local_chat_label',
      'local_sender_label',
      'content',
      'timestamp',
      'from_me',
      'message_kind',
      'upsert_type',
      'media_enriched',
      'observed_at',
    ]);
    expect(
      columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name),
    ).toEqual(['message_id', 'chat_jid']);

    const indexes = getDb()
      .prepare(`PRAGMA index_list(observed_whatsapp_messages)`)
      .all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'idx_observed_whatsapp_timestamp',
        'idx_observed_whatsapp_chat_timestamp',
      ]),
    );
  });

  it('initializes without throwing when columns already exist (idempotent)', () => {
    // The fresh schema already declares messages.is_bot_message and
    // chats.channel, so those ALTERs throw a duplicate-column error that
    // runMigration must swallow. Re-initializing must stay clean.
    expect(() => _initTestDatabase()).not.toThrow();
    // Migrated columns are present and queryable.
    expect(() =>
      getDb().prepare('SELECT context_mode FROM scheduled_tasks').all(),
    ).not.toThrow();
    expect(() =>
      getDb()
        .prepare('SELECT runtime, agent_config, is_main FROM registered_groups')
        .all(),
    ).not.toThrow();
  });

  it('treats re-adding an existing column as a duplicate-column error', () => {
    // Locks the error-message contract that isAlreadyAppliedMigrationError
    // relies on to distinguish "already applied" from genuine failures.
    expect(() =>
      getDb().exec(
        `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
      ),
    ).toThrow(/duplicate column name/i);
  });

  it('adds the Google operation fingerprint without trusting legacy journal rows', () => {
    const legacy = new Database(':memory:');
    try {
      legacy.exec(`
        CREATE TABLE google_operation_journal (
          intent_id TEXT NOT NULL,
          operation_key TEXT NOT NULL,
          group_folder TEXT NOT NULL,
          tool TEXT NOT NULL,
          status TEXT NOT NULL,
          result_json TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (intent_id, operation_key)
        );
        INSERT INTO google_operation_journal
          (intent_id, operation_key, group_folder, tool, status, result_json,
           created_at, updated_at)
        VALUES
          ('legacy-intent', 'legacy-slot', 'telegram_main',
           'google_docs_create', 'succeeded', '{"id":"legacy-result"}',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);

      expect(() => createSchema(legacy)).not.toThrow();
      expect(
        legacy
          .prepare(
            `SELECT operation_fingerprint
               FROM google_operation_journal
              WHERE intent_id = 'legacy-intent' AND operation_key = 'legacy-slot'`,
          )
          .get(),
      ).toEqual({ operation_fingerprint: null });
      expect(() => createSchema(legacy)).not.toThrow();
    } finally {
      legacy.close();
    }
  });
});

describe('legacy scheduled-task owner provenance migration', () => {
  it('uses only authoritative SQLite tenant state, rejects forged tenant.json/group JIDs, and runs once', () => {
    const groupsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'legacy-owner-task-groups-'),
    );
    const legacy = new Database(':memory:');
    try {
      legacy.exec(`
        CREATE TABLE scheduled_tasks (
          id TEXT PRIMARY KEY,
          group_folder TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule_type TEXT NOT NULL,
          schedule_value TEXT NOT NULL,
          next_run TEXT,
          last_run TEXT,
          last_result TEXT,
          status TEXT DEFAULT 'active',
          created_at TEXT NOT NULL
        );
        CREATE TABLE registered_groups (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL UNIQUE,
          trigger_pattern TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          requires_trigger INTEGER DEFAULT 1,
          is_main INTEGER DEFAULT 0
        );
        CREATE TABLE tenants (
          tenant_id TEXT PRIMARY KEY,
          folder TEXT NOT NULL,
          mode TEXT NOT NULL,
          channel TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      const insertGroup = legacy.prepare(`
        INSERT INTO registered_groups
          (jid, name, folder, trigger_pattern, added_at, is_main)
        VALUES (?, ?, ?, 'always', '2026-01-01T00:00:00.000Z', 1)
      `);
      insertGroup.run('tg:100000001', 'Owner DM', 'telegram_owner-dm');
      insertGroup.run('tg:-100123', 'Telegram Group', 'telegram_owner-group');
      insertGroup.run('tg:777', 'Forged guest DM', 'telegram_forged-main');
      const insertTask = legacy.prepare(`
        INSERT INTO scheduled_tasks
          (id, group_folder, chat_jid, prompt, schedule_type,
           schedule_value, status, created_at)
        VALUES (?, ?, ?, 'legacy', 'once', '2027-01-01T00:00:00',
                'active', '2026-01-01T00:00:00.000Z')
      `);
      insertTask.run('legacy-owner-dm', 'telegram_owner-dm', 'tg:100000001');
      insertTask.run(
        'legacy-negative-group',
        'telegram_owner-group',
        'tg:-100123',
      );
      insertTask.run(
        'legacy-forged-tenant-json',
        'telegram_forged-main',
        'tg:777',
      );

      const insertTenant = legacy.prepare(`
        INSERT INTO tenants
          (tenant_id, folder, mode, channel, chat_id, created_at)
        VALUES (?, ?, ?, 'telegram', ?, 1)
      `);
      insertTenant.run(
        'tenant_owner_dm',
        'telegram_owner-dm',
        'owner',
        '100000001',
      );
      // Even an authoritative owner-mode row cannot turn a negative Telegram
      // group JID into single-sender provenance.
      insertTenant.run(
        'tenant_owner_group',
        'telegram_owner-group',
        'owner',
        '-100123',
      );
      // Host SQLite also says owner, but the durable host owner allowlist used
      // below does not contain sender 777. Directory/main flags and tenant mode
      // alone therefore still cannot synthesize is_owner_sender.
      insertTenant.run(
        'tenant_forged_guest',
        'telegram_forged-main',
        'owner',
        '777',
      );

      const forgedDir = path.join(groupsDir, 'telegram_forged-main');
      fs.mkdirSync(forgedDir, { recursive: true });
      fs.writeFileSync(
        path.join(forgedDir, 'tenant.json'),
        JSON.stringify({
          tenant_id: 'attacker_forged_owner',
          folder: 'telegram_forged-main',
          channel: 'telegram',
          chat_id: '777',
          mode: 'owner',
        }),
      );

      const ownerAllowlist = {
        telegram_user_ids: new Set(['100000001']),
        telegram_chat_ids: new Set<string>(),
      };
      createSchema(legacy, [], ownerAllowlist);
      const rows = legacy
        .prepare(
          `SELECT id, creator_authorization, creator_identity_id,
                  creator_sender_id
           FROM scheduled_tasks ORDER BY id`,
        )
        .all() as Array<Record<string, string | null>>;
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      expect(byId['legacy-owner-dm']).toMatchObject({
        creator_authorization: 'owner_sender',
        creator_identity_id: 'telegram_user_100000001',
        creator_sender_id: '100000001',
      });
      expect(byId['legacy-negative-group']).toMatchObject({
        creator_authorization: null,
        creator_identity_id: null,
        creator_sender_id: null,
      });
      expect(byId['legacy-forged-tenant-json']).toMatchObject({
        creator_authorization: null,
        creator_identity_id: null,
        creator_sender_id: null,
      });

      // The marker prevents a future guest/co-member task in the same folder
      // from being mistaken for legacy owner work on the next restart.
      legacy
        .prepare(
          `INSERT INTO scheduled_tasks
             (id, group_folder, chat_jid, prompt, schedule_type,
              schedule_value, status, created_at)
           VALUES ('later-null-task', 'telegram_owner-dm', 'tg:100000001',
                   'guest', 'once', '2027-02-01T00:00:00', 'active',
                   '2026-07-11T00:00:00.000Z')`,
        )
        .run();
      createSchema(legacy, [], ownerAllowlist);
      expect(
        legacy
          .prepare(
            `SELECT creator_authorization FROM scheduled_tasks
             WHERE id = 'later-null-task'`,
          )
          .get(),
      ).toEqual({ creator_authorization: null });
    } finally {
      legacy.close();
      fs.rmSync(groupsDir, { recursive: true, force: true });
    }
  });
});

// --- chats.channel / chats.is_group split migration (legacy partial DBs) ---

describe('chats channel/is_group migration on partially-migrated legacy DBs', () => {
  // Reproduces a DB created before BOTH columns existed where a previous
  // migration attempt added only ONE of them (e.g. it crashed between the two
  // ALTERs, or an older build only added `channel`). createSchema's
  // `CREATE TABLE IF NOT EXISTS chats` is a no-op against the pre-existing
  // table, so the ADD COLUMN migrations run against the legacy shape — exactly
  // the production code path on such a DB.
  //
  // With both ALTERs in one runMigration callback, the duplicate-column error
  // from the already-present column was swallowed and ABORTED the callback, so
  // the missing column was never added and the backfill never ran.

  function buildLegacyDb(columns: {
    channel: boolean;
    isGroup: boolean;
  }): Database.Database {
    const legacy = new Database(':memory:');
    const cols = [
      'jid TEXT PRIMARY KEY',
      'name TEXT',
      'last_message_time TEXT',
    ];
    if (columns.channel) cols.push('channel TEXT');
    if (columns.isGroup) cols.push('is_group INTEGER DEFAULT 0');
    legacy.exec(`CREATE TABLE chats (${cols.join(', ')});`);
    // Seed rows whose channel/is_group must be derived by the backfill.
    legacy
      .prepare(
        `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
      )
      .run('123@g.us', 'WA Group', '2024-01-01T00:00:00.000Z');
    legacy
      .prepare(
        `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
      )
      .run('456@s.whatsapp.net', 'WA DM', '2024-01-01T00:00:00.000Z');
    legacy
      .prepare(
        `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
      )
      .run('tg:789', 'TG Group', '2024-01-01T00:00:00.000Z');
    return legacy;
  }

  type ChatRow = {
    jid: string;
    channel: string | null;
    is_group: number | null;
  };

  function readChats(legacy: Database.Database): Record<string, ChatRow> {
    const rows = legacy
      .prepare('SELECT jid, channel, is_group FROM chats')
      .all() as ChatRow[];
    return Object.fromEntries(rows.map((r) => [r.jid, r]));
  }

  it('adds the missing is_group column when only channel pre-exists, and backfills', () => {
    const legacy = buildLegacyDb({ channel: true, isGroup: false });
    try {
      // Must not throw: `channel`'s duplicate-column error is swallowed in its
      // OWN runMigration without blocking the separate is_group ALTER.
      expect(() => createSchema(legacy)).not.toThrow();

      // The previously-missing column now exists and is queryable.
      const chats = readChats(legacy);
      // Backfill ran (it lives outside the ALTER guard, so it executes even
      // when one ALTER no-oped on the duplicate column).
      expect(chats['123@g.us']).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });
      expect(chats['456@s.whatsapp.net']).toMatchObject({
        channel: 'whatsapp',
        is_group: 0,
      });
      expect(chats['tg:789']).toMatchObject({
        channel: 'telegram',
        is_group: 1,
      });
    } finally {
      legacy.close();
    }
  });

  it('adds the missing channel column when only is_group pre-exists, and backfills', () => {
    const legacy = buildLegacyDb({ channel: false, isGroup: true });
    try {
      expect(() => createSchema(legacy)).not.toThrow();
      const chats = readChats(legacy);
      expect(chats['123@g.us']).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });
      expect(chats['456@s.whatsapp.net']).toMatchObject({
        channel: 'whatsapp',
        is_group: 0,
      });
      expect(chats['tg:789']).toMatchObject({
        channel: 'telegram',
        is_group: 1,
      });
    } finally {
      legacy.close();
    }
  });

  it('adds both columns and backfills on a fully-legacy DB missing both', () => {
    const legacy = buildLegacyDb({ channel: false, isGroup: false });
    try {
      expect(() => createSchema(legacy)).not.toThrow();
      const chats = readChats(legacy);
      expect(chats['123@g.us']).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });
      expect(chats['tg:789']).toMatchObject({
        channel: 'telegram',
        is_group: 1,
      });
    } finally {
      legacy.close();
    }
  });
});

// --- messages.is_bot_message ALTER+backfill is transactional and applies atomically ---

describe('messages.is_bot_message migration atomicity', () => {
  // Build a legacy `messages` table that predates the is_bot_message column,
  // seeded with a bot-prefixed row that the backfill must flag. createSchema's
  // `CREATE TABLE IF NOT EXISTS` no-ops against the pre-existing table, so the
  // ADD COLUMN + backfill migration runs against the legacy shape — the real
  // production path on such a DB. The ALTER and backfill are wrapped in one
  // transaction; this proves the column is added AND the backfill commits
  // together (the backfill is no longer left unapplied / half-applied).
  function buildLegacyMessagesDb(): Database.Database {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE chats (jid TEXT PRIMARY KEY);
      CREATE TABLE messages (
        id TEXT,
        chat_jid TEXT,
        sender TEXT,
        sender_name TEXT,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER,
        PRIMARY KEY (id, chat_jid)
      );
    `);
    legacy.prepare('INSERT INTO chats (jid) VALUES (?)').run('group@g.us');
    // A pre-migration bot message that used the content-prefix pattern...
    legacy
      .prepare(
        `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'old-bot',
        'group@g.us',
        ASSISTANT_NAME,
        ASSISTANT_NAME,
        `${ASSISTANT_NAME}: hello from before the migration`,
        '2024-01-01T00:00:01.000Z',
        1,
      );
    // ...and an ordinary user message that must stay unflagged.
    legacy
      .prepare(
        `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'user-1',
        'group@g.us',
        'u@s.whatsapp.net',
        'User',
        'just a normal message',
        '2024-01-01T00:00:02.000Z',
        0,
      );
    return legacy;
  }

  it('adds the column and applies the backfill together on a legacy DB', () => {
    const legacy = buildLegacyMessagesDb();
    try {
      expect(() => createSchema(legacy)).not.toThrow();
      const rows = legacy
        .prepare('SELECT id, is_bot_message FROM messages ORDER BY id')
        .all() as Array<{ id: string; is_bot_message: number }>;
      const byId = Object.fromEntries(
        rows.map((r) => [r.id, r.is_bot_message]),
      );
      // Backfill ran inside the transaction that added the column.
      expect(byId['old-bot']).toBe(1);
      expect(byId['user-1']).toBe(0);
    } finally {
      legacy.close();
    }
  });
});

// --- deleteTask is atomic (both deletes in one transaction) ---

describe('deleteTask transaction atomicity', () => {
  let originalPrepare: Database.Database['prepare'] | null = null;

  afterEach(() => {
    // Restore the patched prepare so other tests use the real connection.
    if (originalPrepare) {
      const database = getDb();
      (database as { prepare: Database.Database['prepare'] }).prepare =
        originalPrepare;
      originalPrepare = null;
    }
  });

  it('rolls back the child-log delete when the parent delete fails', () => {
    createTask({
      id: 'atomic-task',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'x',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    logTaskRun({
      task_id: 'atomic-task',
      run_at: '2024-01-01T00:00:00.000Z',
      duration_ms: 1,
      status: 'success',
      result: 'ok',
      error: null,
    });

    const database = getDb();
    const countLogs = () =>
      (
        database
          .prepare('SELECT COUNT(*) AS n FROM task_run_logs WHERE task_id = ?')
          .get('atomic-task') as { n: number }
      ).n;

    // Sanity: the child log exists before the delete.
    expect(countLogs()).toBe(1);

    // Make the SECOND statement deleteTask runs (the scheduled_tasks DELETE)
    // throw at .run() time, simulating a failure between the two deletes.
    // Without a wrapping transaction the first DELETE (task_run_logs) would
    // already be committed and the log lost; with the transaction it rolls
    // back and both the log and the parent task survive intact.
    originalPrepare = database.prepare.bind(database);
    (database as { prepare: Database.Database['prepare'] }).prepare = ((
      sql: string,
    ) => {
      const stmt = originalPrepare!(sql);
      if (/DELETE FROM scheduled_tasks/i.test(sql)) {
        return new Proxy(stmt, {
          get(target, prop, receiver) {
            if (prop === 'run') {
              return () => {
                throw new Error('simulated failure mid-deleteTask');
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
      }
      return stmt;
    }) as Database.Database['prepare'];

    expect(() => deleteTask('atomic-task')).toThrow(
      /simulated failure mid-deleteTask/,
    );

    // Restore before asserting so the count query uses the real prepare.
    (database as { prepare: Database.Database['prepare'] }).prepare =
      originalPrepare;
    originalPrepare = null;

    // The child run-log was NOT deleted (transaction rolled back)...
    expect(countLogs()).toBe(1);
    // ...and the parent task is still present.
    expect(getTaskById('atomic-task')).toBeDefined();
  });

  it('deletes both the task and its run logs on the happy path', () => {
    createTask({
      id: 'happy-task',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'x',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    logTaskRun({
      task_id: 'happy-task',
      run_at: '2024-01-01T00:00:00.000Z',
      duration_ms: 1,
      status: 'success',
      result: 'ok',
      error: null,
    });

    deleteTask('happy-task');

    expect(getTaskById('happy-task')).toBeUndefined();
    const remaining = (
      getDb()
        .prepare('SELECT COUNT(*) AS n FROM task_run_logs WHERE task_id = ?')
        .get('happy-task') as { n: number }
    ).n;
    expect(remaining).toBe(0);
  });
});

// --- Concurrency hardening (finding #48) ---
//
// initDatabase() reads STORE_DIR resolved at import time, so it cannot be
// re-pointed at a temp dir from a test without polluting the real store. These
// tests instead assert the exact pragma SEMANTICS the fix depends on against a
// throwaway file-backed connection: that this better-sqlite3 build accepts the
// pragma strings used in initDatabase() and reports the expected values back.
// A regression in those pragmas (e.g. WAL not taking, or busy_timeout staying
// at the unsafe 0ms default) is what reintroduces the nightly-VACUUM
// SQLITE_BUSY data loss this finding fixes.
describe('concurrency pragmas (file-backed connection)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-pragma-test-'));
    dbPath = path.join(tmpDir, 'messages.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('journal_mode = WAL takes effect on an on-disk database', () => {
    const fileDb = new Database(dbPath);
    try {
      // Mirrors the pragma set in initDatabase(). On a file-backed DB the mode
      // switch persists; the pragma returns the resulting mode string.
      fileDb.pragma('journal_mode = WAL');
      expect(fileDb.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      fileDb.close();
    }
  });

  it('busy_timeout is set to 5000 (waits out a transient VACUUM lock)', () => {
    const fileDb = new Database(dbPath);
    try {
      // initDatabase() sets `busy_timeout = 5000` explicitly so a writer WAITS
      // for a transient exclusive lock (the retention VACUUM window) instead of
      // throwing SQLITE_BUSY and losing the message/event. (better-sqlite3's
      // constructor `timeout` option also defaults to 5000ms; we set the pragma
      // explicitly to make the intent self-documenting and lock it independent
      // of the constructor default.)
      fileDb.pragma('busy_timeout = 5000');
      expect(fileDb.pragma('busy_timeout', { simple: true })).toBe(5000);
    } finally {
      fileDb.close();
    }
  });

  it('restricts the database directory, database, and SQLite sidecars', () => {
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    fs.writeFileSync(dbPath, 'db');
    fs.writeFileSync(walPath, 'wal');
    fs.writeFileSync(shmPath, 'shm');
    fs.chmodSync(tmpDir, 0o755);
    fs.chmodSync(dbPath, 0o644);
    fs.chmodSync(walPath, 0o644);
    fs.chmodSync(shmPath, 0o644);

    hardenDatabaseFilePermissions(dbPath);

    const mode = (filePath: string) => fs.statSync(filePath).mode & 0o777;
    expect(mode(tmpDir)).toBe(0o700);
    expect(mode(dbPath)).toBe(0o600);
    expect(mode(walPath)).toBe(0o600);
    expect(mode(shmPath)).toBe(0o600);
  });
});
