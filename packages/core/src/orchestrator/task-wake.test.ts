import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb, storeMessage } from './db.js';
import {
  capNextRunAtExpiry,
  captureWakeState,
  evaluateTaskWake,
  normalizeWakePath,
  parseTaskExpiresAt,
  parseWakeIfInput,
  readWakePathSignature,
  storedWakeIf,
  taskExpired,
  type WakeIf,
} from './task-wake.js';

const CHAT = 'tg:123456789';
const OTHER_CHAT = 'tg:987654321';

let root: string;
let groupDir: string;

beforeEach(() => {
  _initTestDatabase();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-wake-'));
  groupDir = path.join(root, 'telegram_main');
  fs.mkdirSync(path.join(groupDir, 'output'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

let messageNo = 0;
function message(chatJid: string, bot = false) {
  messageNo += 1;
  storeMessage({
    id: `m-${messageNo}`,
    chat_jid: chatJid,
    sender: bot ? 'bot' : '123456789',
    sender_name: bot ? 'Skoobi' : 'Owner',
    content: `сообщение ${messageNo}`,
    timestamp: new Date(Date.UTC(2026, 10, 8, 10, 0, messageNo)).toISOString(),
    is_bot_message: bot,
  });
}

const ctx = (now: number) => ({
  groupDir,
  db: getDb(),
  chatJid: CHAT,
  now,
});

describe('wake_if: что принимает хост (W26)', () => {
  it('путь — только внутри папки группы', () => {
    expect(normalizeWakePath('output/report/READY.json')).toBe(
      'output/report/READY.json',
    );
    expect(normalizeWakePath('./output//x/')).toBe('output/x');
    for (const bad of [
      '/etc/passwd',
      '../telegram_admin/x',
      '~/x',
      'a/../../b',
      '.',
      '',
    ]) {
      expect(normalizeWakePath(bad)).toBeNull();
    }
  });

  it('строгая проверка полей', () => {
    expect(parseWakeIfInput({ path_changed: 'output/x' })).toEqual({
      ok: true,
      value: { path_changed: 'output/x' },
    });
    expect(
      parseWakeIfInput({
        new_messages: true,
        chat_jid: OTHER_CHAT,
        max_sleep_hours: 3,
      }),
    ).toEqual({
      ok: true,
      value: { new_messages: true, chat_jid: OTHER_CHAT, max_sleep_hours: 3 },
    });
    for (const bad of [
      null,
      [],
      {},
      { new_messages: false },
      { path_changed: '../x' },
      { chat_jid: OTHER_CHAT },
      { path_changed: 'x', max_sleep_hours: 0 },
      { path_changed: 'x', max_sleep_hours: 25 },
      { path_changed: 'x', script: 'rm -rf /' },
    ]) {
      expect(parseWakeIfInput(bad).ok).toBe(false);
    }
  });

  it('у разовой задачи условие не действует (пропуск закрыл бы её)', () => {
    const wake_if = JSON.stringify({ path_changed: 'output/x' });
    expect(storedWakeIf({ wake_if, schedule_type: 'once' })).toBeNull();
    expect(storedWakeIf({ wake_if, schedule_type: 'interval' })).toEqual({
      path_changed: 'output/x',
    });
    expect(storedWakeIf({ wake_if: '{bad', schedule_type: 'cron' })).toBeNull();
  });
});

describe('path_changed (W26)', () => {
  it('появление, изменение и исчезновение файла', () => {
    const wakeIf: WakeIf = { path_changed: 'output/READY.json' };
    const t0 = Date.parse('2026-11-08T10:00:00Z');
    const baseline = captureWakeState(wakeIf, ctx(t0));
    expect(baseline.path).toEqual({ exists: false });

    // Nothing yet: skip.
    expect(
      evaluateTaskWake(
        { wake_state: JSON.stringify(baseline) },
        wakeIf,
        ctx(t0 + 600_000),
      ),
    ).toEqual({ wake: false, reason: 'unchanged' });

    fs.writeFileSync(
      path.join(groupDir, 'output', 'READY.json'),
      '{"ready":true}',
    );
    const appeared = evaluateTaskWake(
      { wake_state: JSON.stringify(baseline) },
      wakeIf,
      ctx(t0 + 1_200_000),
    );
    expect(appeared.wake).toBe(true);
    expect(appeared.reason).toBe('changed');
    expect(appeared.note).toContain('появился «output/READY.json»');
    expect(appeared.nextState?.path).toMatchObject({ exists: true, size: 14 });

    // After the model handled it, the same file is no news.
    const handled = JSON.stringify(appeared.nextState);
    expect(
      evaluateTaskWake({ wake_state: handled }, wakeIf, ctx(t0 + 1_800_000))
        .wake,
    ).toBe(false);

    fs.writeFileSync(
      path.join(groupDir, 'output', 'READY.json'),
      '{"ready":true,"n":2}',
    );
    const changed = evaluateTaskWake(
      { wake_state: handled },
      wakeIf,
      ctx(t0 + 2_400_000),
    );
    expect(changed.note).toContain('размер 14 → 20 байт');

    fs.rmSync(path.join(groupDir, 'output', 'READY.json'));
    expect(
      evaluateTaskWake({ wake_state: handled }, wakeIf, ctx(t0 + 3_000_000))
        .note,
    ).toContain('исчез «output/READY.json»');
  });

  it('ссылка наружу из папки группы не читается — условие просто не срабатывает', () => {
    const outside = path.join(root, 'secret.txt');
    fs.writeFileSync(outside, 'x');
    fs.symlinkSync(outside, path.join(groupDir, 'output', 'link.txt'));
    fs.symlinkSync(root, path.join(groupDir, 'up'));
    expect(readWakePathSignature(groupDir, 'output/link.txt')).toBeNull();
    expect(readWakePathSignature(groupDir, 'up/secret.txt')).toBeNull();
    expect(readWakePathSignature(groupDir, 'up/missing.txt')).toBeNull();
    expect(readWakePathSignature(groupDir, '../secret.txt')).toBeNull();
    expect(
      readWakePathSignature(groupDir, 'output/missing/deeper.txt'),
    ).toEqual({
      exists: false,
    });
  });
});

describe('new_messages (W26)', () => {
  it('будит только на входящие после последнего пробуждения, ответы бота не считаются', () => {
    message(CHAT);
    const wakeIf: WakeIf = { new_messages: true };
    const t0 = Date.parse('2026-11-08T10:00:00Z');
    const baseline = captureWakeState(wakeIf, ctx(t0));
    message(CHAT, true);
    message(OTHER_CHAT);
    expect(
      evaluateTaskWake(
        { wake_state: JSON.stringify(baseline) },
        wakeIf,
        ctx(t0 + 60_000),
      ).wake,
    ).toBe(false);
    message(CHAT);
    message(CHAT);
    const woke = evaluateTaskWake(
      { wake_state: JSON.stringify(baseline) },
      wakeIf,
      ctx(t0 + 120_000),
    );
    expect(woke.wake).toBe(true);
    expect(woke.note).toContain('в этом чате новых входящих сообщений: 2');
    expect(
      evaluateTaskWake(
        { wake_state: JSON.stringify(woke.nextState) },
        wakeIf,
        ctx(t0 + 180_000),
      ).wake,
    ).toBe(false);
  });

  it('другой чат (chat_jid)', () => {
    const wakeIf: WakeIf = { new_messages: true, chat_jid: OTHER_CHAT };
    const t0 = Date.parse('2026-11-08T10:00:00Z');
    const baseline = captureWakeState(wakeIf, ctx(t0));
    message(CHAT);
    expect(
      evaluateTaskWake(
        { wake_state: JSON.stringify(baseline) },
        wakeIf,
        ctx(t0 + 60_000),
      ).wake,
    ).toBe(false);
    message(OTHER_CHAT);
    expect(
      evaluateTaskWake(
        { wake_state: JSON.stringify(baseline) },
        wakeIf,
        ctx(t0 + 120_000),
      ).note,
    ).toContain(`в чате ${OTHER_CHAT} новых входящих сообщений: 1`);
  });
});

describe('страховка и срок (W26)', () => {
  it('раз в max_sleep_hours модель будится и без изменений; без исходного состояния — тоже', () => {
    const wakeIf: WakeIf = { path_changed: 'output/READY.json' };
    const t0 = Date.parse('2026-11-08T10:00:00Z');
    const state = JSON.stringify(captureWakeState(wakeIf, ctx(t0)));
    expect(
      evaluateTaskWake({ wake_state: state }, wakeIf, ctx(t0 + 5.9 * 3_600_000))
        .wake,
    ).toBe(false);
    const forced = evaluateTaskWake(
      { wake_state: state },
      wakeIf,
      ctx(t0 + 6 * 3_600_000),
    );
    expect(forced).toMatchObject({ wake: true, reason: 'max_sleep' });
    expect(forced.note).toContain('раз в 6 ч');
    expect(
      evaluateTaskWake(
        { wake_state: state },
        { ...wakeIf, max_sleep_hours: 2 },
        ctx(t0 + 2 * 3_600_000),
      ).reason,
    ).toBe('max_sleep');
    expect(
      evaluateTaskWake({ wake_state: null }, wakeIf, ctx(t0)),
    ).toMatchObject({
      wake: true,
      reason: 'no_baseline',
    });
  });

  it('«Запустить сейчас» из панели будит модель без проверки условия; пометка снимается после прогона', () => {
    const wakeIf: WakeIf = { path_changed: 'output/READY.json' };
    const t0 = Date.parse('2026-11-08T10:00:00Z');
    const baseline = captureWakeState(wakeIf, ctx(t0));
    const flagged = JSON.stringify({ ...baseline, run_now: true });
    const manual = evaluateTaskWake(
      { wake_state: flagged },
      wakeIf,
      ctx(t0 + 3_600_000),
    );
    expect(manual).toMatchObject({ wake: true, reason: 'manual' });
    expect(manual.note).toContain('вручную из панели');
    // The state saved after a successful run has no flag: the next check is
    // an ordinary one again.
    expect(manual.nextState).not.toHaveProperty('run_now');
    expect(manual.nextState?.path).toEqual({ exists: false });
    // The flag alone (no baseline yet) is a manual run too.
    expect(
      evaluateTaskWake({ wake_state: '{"run_now":true}' }, wakeIf, ctx(t0)),
    ).toMatchObject({ wake: true, reason: 'manual' });
    // What else changed is still said.
    fs.writeFileSync(path.join(groupDir, 'output', 'READY.json'), 'ok');
    expect(
      evaluateTaskWake({ wake_state: flagged }, wakeIf, ctx(t0 + 60_000)).note,
    ).toContain('появился «output/READY.json»');
    // Without the flag nothing changes for an unchanged path.
    fs.rmSync(path.join(groupDir, 'output', 'READY.json'));
    expect(
      evaluateTaskWake(
        { wake_state: JSON.stringify(baseline) },
        wakeIf,
        ctx(t0 + 3_600_000),
      ).wake,
    ).toBe(false);
  });

  it('expires_at: только будущее время; следующий запуск не позже срока', () => {
    const now = Date.parse('2026-11-08T10:00:00Z');
    expect(parseTaskExpiresAt('2026-11-09T18:00:00Z', now)).toBe(
      '2026-11-09T18:00:00.000Z',
    );
    expect(parseTaskExpiresAt('2026-11-07T18:00:00Z', now)).toBeNull();
    expect(parseTaskExpiresAt('завтра', now)).toBeNull();
    expect(parseTaskExpiresAt(42, now)).toBeNull();

    const task = {
      expires_at: '2026-11-08T12:00:00.000Z',
      schedule_type: 'interval' as const,
    };
    expect(capNextRunAtExpiry('2026-11-08T11:00:00.000Z', task)).toBe(
      '2026-11-08T11:00:00.000Z',
    );
    expect(capNextRunAtExpiry('2026-11-08T13:00:00.000Z', task)).toBe(
      '2026-11-08T12:00:00.000Z',
    );
    expect(capNextRunAtExpiry(null, task)).toBeNull();
    expect(taskExpired(task, Date.parse('2026-11-08T11:59:59Z'))).toBe(false);
    expect(taskExpired(task, Date.parse('2026-11-08T12:00:00Z'))).toBe(true);
    expect(
      taskExpired(
        { ...task, schedule_type: 'once' },
        Date.parse('2026-11-09T00:00:00Z'),
      ),
    ).toBe(false);
  });
});
