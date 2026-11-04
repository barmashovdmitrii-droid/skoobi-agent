import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ readDb: vi.fn() }));

import Database from 'better-sqlite3';

import {
  cleanDialogText,
  collectChatMessages,
  collectChats,
  collectServices,
  collectTasks,
  countToolErrorsSince,
  taskResultHidden,
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
    expect(services).toMatchObject([
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

  it('reports a prior service crash using the configured public label', async () => {
    process.env.SKOOBI_SERVICE_LABEL = 'com.skoobi.team_1';
    const launchctlExecutor = vi.fn(async (_file: string, args: string[]) => ({
      stdout:
        args[0] === 'list'
          ? '123\t0\tcom.skoobi.team_1\n456\t0\tcom.skoobi.dashboard\n'
          : args[1].endsWith('/com.skoobi.team_1')
            ? 'last exit code = 2\nruns = 5\n'
            : 'last exit code = 0\nruns = 1\n',
    }));

    const services = await collectServices({ launchctlExecutor });

    expect(services).toHaveLength(2);
    expect(services[0]).toMatchObject({
      id: 'main',
      state: 'warn',
      lastExitCode: 2,
      runs: 5,
      detail: expect.stringContaining('прошлый выход с кодом 2'),
    });
    expect(services[1]).toMatchObject({ id: 'dashboard', state: 'ok' });
  });
});

describe('collectTasks: бейдж «результат скрыт» (T1)', () => {
  function tasksSchema(): void {
    db.exec(`
      CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, group_folder TEXT NOT NULL,
        chat_jid TEXT NOT NULL, prompt TEXT NOT NULL, schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL, next_run TEXT, last_run TEXT, last_result TEXT,
        status TEXT DEFAULT 'active', created_at TEXT NOT NULL);
      CREATE TABLE calendar_event_links (task_id TEXT PRIMARY KEY);
    `);
  }

  it('помечает разовую задачу, чей последний результат целиком <internal>', () => {
    tasksSchema();
    const insert = db.prepare(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type,
         schedule_value, next_run, last_result, status, created_at)
       VALUES (?, 'telegram_fixture', 'tg:100000002', ?, ?, '2026-10-01T15:00:00.000Z', NULL, ?, ?, '2026-09-28T00:00:00.000Z')`,
    );
    insert.run(
      'hidden',
      'тестовый пост @example',
      'once',
      '<internal>Пост не опубликован: меню Telegram не открылось.</internal>',
      'completed',
    );
    insert.run(
      'visible',
      'напоминание',
      'once',
      'Напомнил владельцу',
      'completed',
    );
    insert.run(
      'recurring',
      'утренний разбор',
      'cron',
      '<internal>без замечаний</internal>',
      'active',
    );
    insert.run('cancelled', 'отменённая', 'once', null, 'cancelled');

    const rows = collectTasks();
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.hidden).toMatchObject({
      resultHidden: true,
      lastResult: expect.stringContaining('Пост не опубликован'),
    });
    expect(byId.visible.resultHidden).toBe(false);
    // Повторяющийся «без замечаний» — рутина по замыслу, не бейдж.
    expect(byId.recurring.resultHidden).toBe(false);
    expect(byId.cancelled).toMatchObject({
      resultHidden: false,
      status: 'отменена',
      statusRaw: 'cancelled',
    });
  });

  it('taskResultHidden: только once и только текст, начинающийся с <internal>', () => {
    expect(taskResultHidden('once', '<internal>x</internal>')).toBe(true);
    expect(taskResultHidden('once', '  <INTERNAL>x</INTERNAL>')).toBe(true);
    expect(taskResultHidden('once', 'видимо <internal>x</internal>')).toBe(
      false,
    );
    expect(taskResultHidden('cron', '<internal>x</internal>')).toBe(false);
    expect(taskResultHidden('once', null)).toBe(false);
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
        aliases: { [whatsapp]: 'Контакт A в WhatsApp' },
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
      name: 'Контакт A в WhatsApp',
      sourceName: 'Контакт •••• 5678',
      localAlias: 'Контакт A в WhatsApp',
      linkedChats: [
        {
          jid: 'tg:123456789',
          name: 'Главный чат',
          channel: 'telegram',
        },
      ],
    });
    expect(chats[0].linkedChats).toEqual([
      { jid: whatsapp, name: 'Контакт A в WhatsApp', channel: 'whatsapp' },
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

describe('countToolErrorsSince (C41)', () => {
  it('sums tool_errors of session_finished in the window, ignoring junk', () => {
    db.exec(`
      CREATE TABLE events (type TEXT NOT NULL, created_at INTEGER NOT NULL,
        chat_id TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL);
    `);
    const insert = db.prepare(
      'INSERT INTO events (type, created_at, payload_json) VALUES (?, ?, ?)',
    );
    const now = Date.now();
    insert.run(
      'session_finished',
      now - 60_000,
      JSON.stringify({ tool_errors: { view_image: 2, exec: 1 } }),
    );
    insert.run(
      'session_finished',
      now - 120_000,
      JSON.stringify({ tool_calls: { exec_command: 9 } }),
    );
    insert.run(
      'session_finished',
      now - 180_000,
      JSON.stringify({ tool_errors: { mcp__x__memory_get: '1', bad: -4 } }),
    );
    // Older than the window, and another event type.
    insert.run(
      'session_finished',
      now - 25 * 3600_000,
      JSON.stringify({ tool_errors: { view_image: 7 } }),
    );
    insert.run(
      'error',
      now - 60_000,
      JSON.stringify({ tool_errors: { view_image: 5 } }),
    );
    expect(countToolErrorsSince(now - 24 * 3600_000)).toBe(4);
    expect(countToolErrorsSince(now)).toBe(0);
  });

  it('says 0 instead of failing the overview when the table is missing', () => {
    expect(countToolErrorsSince(0)).toBe(0);
  });
});
