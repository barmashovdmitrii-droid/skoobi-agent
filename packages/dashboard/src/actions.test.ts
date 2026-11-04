import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ writeDb: vi.fn(), readDb: vi.fn() }));
// collectMainChat ходит в readDb — подменяем только его, остальное настоящее.
vi.mock('./collectors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./collectors.js')>();
  return { ...actual, collectMainChat: vi.fn() };
});

import Database from 'better-sqlite3';

import { writeDb } from './db.js';
import { collectMainChat } from './collectors.js';
import { humanizeActionError, runAction, setEnvToggle } from './actions.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dash-actions-'));
});
afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('allowlist панели', () => {
  it('неизвестное действие и неизвестная служба отклоняются', async () => {
    expect((await runAction({ type: 'exec_shell', params: {} })).ok).toBe(
      false,
    );
    expect(
      (await runAction({ type: 'restart_service', params: { unit: 'sshd' } }))
        .ok,
    ).toBe(false);
    expect(
      (
        await runAction({
          type: 'restart_service',
          params: { unit: '../../evil' },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await runAction({
          type: 'restart_service',
          params: { unit: 'art' },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await runAction({
          type: 'restart_service',
          params: { unit: 'comfyui' },
        })
      ).ok,
    ).toBe(false);
  });

  it('не запускает launchctl при некорректной метке основной службы', async () => {
    const previous = process.env.SKOOBI_SERVICE_LABEL;
    process.env.SKOOBI_SERVICE_LABEL = 'com.skoobi.main/../other';
    try {
      const result = await runAction({
        type: 'restart_service',
        params: { unit: 'main' },
      });
      expect(result).toEqual({
        ok: false,
        message: 'Некорректно настроена служба Скуби',
      });
    } finally {
      if (previous === undefined) delete process.env.SKOOBI_SERVICE_LABEL;
      else process.env.SKOOBI_SERVICE_LABEL = previous;
    }
  });

  it('перезапускает только точную custom-instance службу через launchctl argv', async () => {
    const previous = process.env.SKOOBI_SERVICE_LABEL;
    process.env.SKOOBI_SERVICE_LABEL = 'com.skoobi.team_1';
    const launchctlExecutor = vi.fn(async () => ({}));
    try {
      const result = await runAction(
        {
          type: 'restart_service',
          params: { unit: 'main' },
        },
        { launchctlExecutor },
      );
      const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
      expect(result).toEqual({ ok: true, message: 'Служба перезапущена' });
      expect(launchctlExecutor).toHaveBeenCalledOnce();
      expect(launchctlExecutor).toHaveBeenCalledWith(
        'launchctl',
        ['kickstart', '-k', `gui/${uid}/com.skoobi.team_1`],
        { timeout: 10_000 },
      );
    } finally {
      if (previous === undefined) delete process.env.SKOOBI_SERVICE_LABEL;
      else process.env.SKOOBI_SERVICE_LABEL = previous;
    }
  });

  it('dialog actions keep pins, aliases and links in the isolated local state', async () => {
    const dialogStateFile = path.join(dir, 'dialog-state.json');
    const telegram = 'tg:123456789';
    const whatsapp = '77012345678@s.whatsapp.net';
    const call = (type: string, params: Record<string, unknown>) =>
      runAction(
        { type, params },
        { dialogStateFile, accessControlFile: path.join(dir, 'acl.json') },
      );

    expect(
      await call('dialog_pin', { jid: telegram, value: true }),
    ).toMatchObject({ ok: true });
    expect(
      await call('dialog_alias', { jid: whatsapp, value: 'Рабочий контакт' }),
    ).toMatchObject({ ok: true });
    expect(
      await call('dialog_link', {
        jid: telegram,
        targetJid: whatsapp,
        value: true,
      }),
    ).toMatchObject({ ok: true });

    const state = JSON.parse(fs.readFileSync(dialogStateFile, 'utf-8'));
    expect(state.pinned).toEqual([telegram]);
    expect(state.aliases[whatsapp]).toBe('Рабочий контакт');
    expect(state.links).toEqual({
      [telegram]: [whatsapp],
      [whatsapp]: [telegram],
    });
  });

  it('dialog actions reject malformed identifiers without creating state', async () => {
    const dialogStateFile = path.join(dir, 'dialog-state.json');
    const result = await runAction(
      {
        type: 'dialog_link',
        params: {
          jid: 'tg:123456789',
          targetJid: '../../secret',
          value: true,
        },
      },
      { dialogStateFile },
    );
    expect(result.ok).toBe(false);
    expect(fs.existsSync(dialogStateFile)).toBe(false);
  });

  it('module_toggle принимает только известные тумблеры', async () => {
    const res = await runAction({
      type: 'module_toggle',
      params: { module: 'PATH', value: true },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('нет');
  });

  it('chat_pause валидирует jid и не трогает файл при мусоре', async () => {
    const aclFile = path.join(dir, 'acl.json');
    fs.writeFileSync(aclFile, '{}');
    const res = await runAction(
      { type: 'chat_pause', params: { jid: '../etc/passwd', value: true } },
      { accessControlFile: aclFile },
    );
    expect(res.ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(aclFile, 'utf-8'))).toEqual({});
  });

  it('task-действия валидируют id до похода в БД', async () => {
    const run = vi.fn();
    vi.mocked(writeDb).mockReturnValue({
      prepare: () => ({ run }),
      transaction: (fn: any) => fn,
    } as any);
    const res = await runAction({
      type: 'task_delete',
      params: { id: 'x; DROP TABLE scheduled_tasks' },
    });
    expect(res.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('chat_pause не перекрывает и не снимает чужой статус (бан)', async () => {
    const aclFile = path.join(dir, 'acl.json');
    fs.writeFileSync(
      aclFile,
      JSON.stringify({ 'tg:555': { status: 'banned', reason: 'спам' } }),
    );
    const unpause = await runAction(
      { type: 'chat_pause', params: { jid: 'tg:555', value: false } },
      { accessControlFile: aclFile },
    );
    expect(unpause.ok).toBe(false);
    const pause = await runAction(
      { type: 'chat_pause', params: { jid: 'tg:555', value: true } },
      { accessControlFile: aclFile },
    );
    expect(pause.ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(aclFile, 'utf-8'))['tg:555'].status).toBe(
      'banned',
    );
  });

  it('битый ACL-файл не перезаписывается действием', async () => {
    const aclFile = path.join(dir, 'acl.json');
    fs.writeFileSync(aclFile, '{broken json');
    const res = await runAction(
      { type: 'chat_pause', params: { jid: 'tg:1', value: true } },
      { accessControlFile: aclFile },
    );
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(aclFile, 'utf-8')).toBe('{broken json');
  });
});

describe('task_pause: включение задачи, которую поставил на паузу планировщик', () => {
  const NOW = Date.parse('2026-09-28T10:00:00.000Z');

  function tasksDb(): InstanceType<typeof Database> {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, group_folder TEXT NOT NULL,
        chat_jid TEXT NOT NULL, prompt TEXT NOT NULL, schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL, next_run TEXT, last_run TEXT, last_result TEXT,
        status TEXT DEFAULT 'active', created_at TEXT NOT NULL);
    `);
    const insert = db.prepare(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type,
         schedule_value, next_run, status, created_at)
       VALUES (?, 'telegram_main', 'tg:1', 'x', ?, ?, ?, ?, '2026-09-01T00:00:00.000Z')`,
    );
    // Paused by the scheduler after an uncertain run: next_run NULL.
    insert.run('daily', 'cron', '0 9 * * *', null, 'paused');
    insert.run('hourly', 'interval', String(60 * 60 * 1000), null, 'paused');
    insert.run('once', 'once', '2026-09-28T09:00:00.000Z', null, 'paused');
    // Paused by hand: keeps its next_run.
    insert.run(
      'armed',
      'cron',
      '0 9 * * *',
      '2026-09-29T04:00:00.000Z',
      'paused',
    );
    insert.run('done', 'cron', '0 9 * * *', null, 'completed');
    // Soft-cancelled by the bot (cancel_task keeps the row).
    insert.run('cancelled', 'once', '2026-09-20T09:00:00.000Z', null, 'cancelled');
    return db;
  }

  const toggle = (id: string, value: boolean) =>
    runAction({ type: 'task_pause', params: { id, value } });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('повторяющейся задаче снова назначается ближайший запуск', async () => {
    const db = tasksDb();
    vi.mocked(writeDb).mockReturnValue(db as never);
    const row = (id: string) =>
      db
        .prepare('SELECT status, next_run FROM scheduled_tasks WHERE id = ?')
        .get(id) as { status: string; next_run: string | null };

    expect(await toggle('daily', false)).toMatchObject({ ok: true });
    expect(await toggle('hourly', false)).toMatchObject({ ok: true });
    expect(await toggle('once', false)).toMatchObject({ ok: true });
    expect(await toggle('armed', false)).toMatchObject({ ok: true });
    expect(await toggle('done', false)).toMatchObject({ ok: false });
    // A cancelled task is history: neither ▶ nor ⏸ may revive it (it would
    // otherwise become active with next_run = now and fire immediately).
    expect(await toggle('cancelled', false)).toMatchObject({ ok: false });
    expect(await toggle('cancelled', true)).toMatchObject({ ok: false });

    const daily = row('daily');
    expect(daily.status).toBe('active');
    expect(daily.next_run).not.toBeNull();
    expect(Date.parse(daily.next_run!)).toBeGreaterThan(NOW);
    expect(Date.parse(daily.next_run!)).toBeLessThanOrEqual(
      NOW + 24 * 60 * 60 * 1000,
    );
    expect(row('hourly')).toEqual({
      status: 'active',
      next_run: new Date(NOW + 60 * 60 * 1000).toISOString(),
    });
    // A once-task the scheduler gave up on is due again right away (its time
    // has passed); a task that still had next_run and a completed task stay
    // as they were.
    expect(row('once')).toEqual({
      status: 'active',
      next_run: new Date(NOW).toISOString(),
    });
    expect(row('armed')).toEqual({
      status: 'active',
      next_run: '2026-09-29T04:00:00.000Z',
    });
    expect(row('done')).toEqual({ status: 'completed', next_run: null });
    expect(row('cancelled')).toEqual({ status: 'cancelled', next_run: null });
  });

  it('пауза из панели next_run не трогает', async () => {
    const db = tasksDb();
    db.prepare(
      `UPDATE scheduled_tasks SET status = 'active', next_run = ? WHERE id = 'daily'`,
    ).run('2026-09-29T04:00:00.000Z');
    vi.mocked(writeDb).mockReturnValue(db as never);

    expect(await toggle('daily', true)).toMatchObject({
      ok: true,
      message: 'Задача на паузе',
    });
    expect(
      db
        .prepare('SELECT status, next_run FROM scheduled_tasks WHERE id = ?')
        .get('daily'),
    ).toEqual({ status: 'paused', next_run: '2026-09-29T04:00:00.000Z' });
  });
});

// Previously: «▶️ сейчас» у отменённой/завершённой задачи
// отвечал «не найдена или на паузе (включи кнопкой ▶)», а та кнопка для
// таких строк отключена — тупик без объяснения.
describe('task_run_now: отменённую и завершённую задачу не оживить', () => {
  const NOW = Date.parse('2026-10-09T10:00:00.000Z');

  function tasksDb(): InstanceType<typeof Database> {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, group_folder TEXT NOT NULL,
        chat_jid TEXT NOT NULL, prompt TEXT NOT NULL, schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL, next_run TEXT, last_run TEXT, last_result TEXT,
        status TEXT DEFAULT 'active', created_at TEXT NOT NULL);
    `);
    const insert = db.prepare(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type,
         schedule_value, next_run, status, created_at)
       VALUES (?, 'telegram_main', 'tg:1', 'x', 'cron', '0 9 * * *', ?, ?, '2026-09-01T00:00:00.000Z')`,
    );
    insert.run('active', '2026-10-10T04:00:00.000Z', 'active');
    insert.run('paused', '2026-10-10T04:00:00.000Z', 'paused');
    insert.run('done', null, 'completed');
    insert.run('cancelled', null, 'cancelled');
    return db;
  }

  const runNow = (id: string) =>
    runAction({ type: 'task_run_now', params: { id } });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('активная запускается, паузная просит включить, история — создать заново', async () => {
    const db = tasksDb();
    vi.mocked(writeDb).mockReturnValue(db as never);
    const row = (id: string) =>
      db
        .prepare('SELECT status, next_run FROM scheduled_tasks WHERE id = ?')
        .get(id) as { status: string; next_run: string | null };

    expect(await runNow('active')).toMatchObject({ ok: true });
    expect(row('active')).toEqual({
      status: 'active',
      next_run: new Date(NOW).toISOString(),
    });

    const paused = await runNow('paused');
    expect(paused.ok).toBe(false);
    expect(paused.message).toMatch(/на паузе/);
    expect(paused.message).toMatch(/▶/);

    const cancelled = await runNow('cancelled');
    expect(cancelled.ok).toBe(false);
    expect(cancelled.message).toMatch(/отменена/);
    expect(cancelled.message).toMatch(/создай заново/);
    expect(cancelled.message).not.toMatch(/на паузе/);

    const done = await runNow('done');
    expect(done.ok).toBe(false);
    expect(done.message).toMatch(/завершена/);
    expect(done.message).toMatch(/создай заново/);

    expect(await runNow('missing')).toMatchObject({
      ok: false,
      message: 'Задача не найдена',
    });

    // History rows are untouched: no next_run, same status.
    expect(row('paused')).toEqual({
      status: 'paused',
      next_run: '2026-10-10T04:00:00.000Z',
    });
    expect(row('done')).toEqual({ status: 'completed', next_run: null });
    expect(row('cancelled')).toEqual({ status: 'cancelled', next_run: null });
  });
});

describe('setEnvToggle', () => {
  it('атомарно правит ключ, делает бэкап и не трогает остальное', () => {
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(
      envFile,
      'RUNTIME=sandbox\nSKOOBI_PAYMENT_ENABLED=false\nTELEGRAM_BOT_TOKEN=secret\n',
    );
    setEnvToggle('SKOOBI_PAYMENT_ENABLED', true, envFile);
    const next = fs.readFileSync(envFile, 'utf-8');
    expect(next).toContain('SKOOBI_PAYMENT_ENABLED=true');
    expect(next).toContain('TELEGRAM_BOT_TOKEN=secret');
    expect(next).toContain('RUNTIME=sandbox');
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('.env.bak-dashboard-'));
    expect(backups).toHaveLength(1);
  });

  it('дописывает ключ, которого не было', () => {
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'RUNTIME=sandbox\n');
    setEnvToggle('SKOOBI_IMAGE_GENERATION_ENABLED', false, envFile);
    expect(fs.readFileSync(envFile, 'utf-8')).toContain(
      'SKOOBI_IMAGE_GENERATION_ENABLED=false',
    );
  });
});

describe('humanizeActionError', () => {
  it('типовые сбои — по-русски', () => {
    expect(
      humanizeActionError(new Error('Command failed: launchctl kickstart')),
    ).toContain('команда завершилась с ошибкой');
    expect(humanizeActionError(new Error('ENOENT: no such file'))).toContain(
      'файл не найден',
    );
    expect(humanizeActionError(new Error('SQLITE_BUSY'))).toContain(
      'база занята',
    );
    expect(
      humanizeActionError(new Error('boom /private/secret token=hidden')),
    ).toBe(
      'Не получилось выполнить действие. Подробности есть в журнале панели.',
    );
  });
});

describe('chat_send (чат со Скуби)', () => {
  function memDbWithSchema(): InstanceType<typeof Database> {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT, channel TEXT, is_group INTEGER);
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, sender TEXT, sender_name TEXT,
        content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER);
      CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT);
    `);
    return db;
  }

  it('пустой текст и отсутствие main-чата отклоняются', async () => {
    vi.mocked(collectMainChat).mockReturnValue({
      jid: 'tg:1',
      name: 'Main',
      folder: 'telegram_main',
    });
    expect(
      (await runAction({ type: 'chat_send', params: { text: '  ' } })).ok,
    ).toBe(false);
    vi.mocked(collectMainChat).mockReturnValue(null);
    expect(
      (await runAction({ type: 'chat_send', params: { text: 'привет' } })).ok,
    ).toBe(false);
  });

  it('вкладывает сообщение владельца поверх курсора бота', async () => {
    const db = memDbWithSchema();
    vi.mocked(writeDb).mockReturnValue(db as never);
    vi.mocked(collectMainChat).mockReturnValue({
      jid: 'tg:100000001',
      name: 'администратор',
      folder: 'telegram_main',
    });
    const r1 = await runAction({
      type: 'chat_send',
      params: { text: 'Скуби, ты тут?' },
    });
    expect(r1.ok).toBe(true);
    const row = db.prepare('SELECT * FROM messages').get() as Record<
      string,
      unknown
    >;
    expect(row.sender_name).toBe('Owner (dashboard)');
    expect(row.chat_jid).toBe('tg:100000001');
    expect(row.is_bot_message).toBe(0);
    expect(row.is_from_me).toBe(0);
    // второе сообщение — строго позже первого (курсор двигается по timestamp)
    await runAction({ type: 'chat_send', params: { text: 'и ещё' } });
    const ts = db
      .prepare('SELECT timestamp FROM messages ORDER BY timestamp')
      .all() as Array<{ timestamp: string }>;
    expect(Date.parse(ts[1].timestamp)).toBeGreaterThan(
      Date.parse(ts[0].timestamp),
    );
    // и чат-строка обновлена
    const chat = db.prepare('SELECT * FROM chats').get() as Record<
      string,
      unknown
    >;
    expect(chat.jid).toBe('tg:100000001');
  });

  it('отказывается писать поверх курсора из будущего (>60с)', async () => {
    const db = memDbWithSchema();
    db.prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES ('future', 'tg:1', '1', 'x', 'x', ?, 0, 0)`,
    ).run(new Date(Date.now() + 120_000).toISOString());
    vi.mocked(writeDb).mockReturnValue(db as never);
    vi.mocked(collectMainChat).mockReturnValue({
      jid: 'tg:1',
      name: 'Main',
      folder: 'telegram_main',
    });
    const r = await runAction({
      type: 'chat_send',
      params: { text: 'привет' },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Часы');
  });
});
