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
