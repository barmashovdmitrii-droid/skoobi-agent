/**
 * W09 (разбор недели): «Делается?», «ну как?», когда хода в чате нет, но
 * работа идёт в фоне — цепочка плановых проверок, Codex Desktop, второй
 * ассистент на другом компьютере. Хост отвечает из сохранённого состояния и модель не запускает;
 * «что дальше» по-прежнему уходит модели.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
  ACTIVE_RUN_PING_PATTERN,
  IDLE_TRACKED_WORK_WINDOW_MS,
  idleTrackedChain,
  idleTrackedWorkStatusText,
  isActiveRunPingText,
  ownerLineFromTaskResult,
  pingsUnansweredByScheduledTask,
  resolveActiveRunPing,
  resolveActiveRunProgressQuestion,
} from './message-loop.js';
import {
  resetInstanceProfileForTests,
  setInstanceProfileForTests,
} from './instance-profile.js';
import { idleTrackedWorkStatusEnabledForGroup } from './live-mode.js';
import type { NewMessage } from './types.js';

function ownerMessage(content: string, seq: number): NewMessage {
  return {
    id: String(27000 + seq),
    chat_jid: 'tg:123456789',
    sender: '123456789',
    sender_name: 'Owner',
    content,
    timestamp: `2026-03-10T10:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    ingestion_cursor: `i:${String(seq).padStart(16, '0')}`,
    is_bot_message: false,
    sender_identity: {
      channel: 'telegram',
      chat_id: '123456789',
      telegram_user_id: '123456789',
      identity_id: 'telegram:owner',
      is_owner_sender: true,
      telegram_message_origin: 'direct',
    },
  };
}

describe('W09: фразы статуса', () => {
  it.each(['Делается?', 'Делает?', 'делаешь?', 'ну как?', 'Ну как ты', 'Ну чо там', 'Почему молчишь?'])(
    'точный пинг: %s',
    (text) => {
      expect(isActiveRunPingText(text)).toBe(true);
    },
  );

  it.each(['Что дальше', 'дальше что?', 'готово', 'А сейчас', 'Ну как там игра'])(
    'не точный пинг (нужна модель): %s',
    (text) => {
      expect(isActiveRunPingText(text)).toBe(false);
    },
  );

  it('«А сейчас» — вопрос о ходе работы: статус сразу, но модель его тоже видит', () => {
    const message = ownerMessage('А сейчас', 1);
    expect(resolveActiveRunPing([message])).toBeNull();
    expect(resolveActiveRunProgressQuestion([message])).toEqual([message]);
    expect(resolveActiveRunProgressQuestion([ownerMessage('а сейчас что?', 2)])).toHaveLength(1);
  });

  it('шаблон экспортирован и совпадает с тем, что проверяет раннер', () => {
    // The runner's parity test reads this literal from the source file.
    const source = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), 'message-loop.ts'),
      'utf8',
    );
    expect(source).toContain(`export const ACTIVE_RUN_PING_PATTERN =\n  /${ACTIVE_RUN_PING_PATTERN.source}/u;`);
  });
});

describe('W09: цепочка проверок из расписания', () => {
  // Проверка закончилась в 10:16:30Z, следующая — 10:29Z.
  const tasks = [
    {
      chat_jid: 'tg:123456789',
      status: 'completed',
      prompt: '<internal>Продолжи разрешённую владельцем доработку действующего проекта</internal>',
      next_run: null,
      last_run: '2026-03-10T10:16:30.000Z',
      last_result: '<internal>Все проверки прошли; жду агента.\nДля владельца: Версия 1.2 собирается, агент правит экран.</internal>',
    },
    {
      chat_jid: 'tg:123456789',
      status: 'active',
      prompt: '<internal>Продолжи разрешённую владельцем доработку действующего проекта</internal>',
      next_run: '2026-03-10T10:29:00.000Z',
      last_run: null,
      last_result: null,
      // Scheduled by the check that ran 10:15–10:16:30.
      created_at: '2026-03-10T10:16:10.000Z',
    },
    {
      chat_jid: 'tg:other',
      status: 'active',
      prompt: 'чужая',
      next_run: '2026-03-10T10:21:00.000Z',
      last_run: '2026-03-10T10:19:00.000Z',
      last_result: null,
    },
  ];
  const now = Date.parse('2026-03-10T10:20:00.000Z');

  it('находит свежую проверку и ближайшую следующую в этом чате', () => {
    const chain = idleTrackedChain(tasks, 'tg:123456789', now, undefined, 'Asia/Almaty');
    expect(chain).toMatchObject({
      lastRunAt: Date.parse('2026-03-10T10:16:30.000Z'),
      nextRunAt: Date.parse('2026-03-10T10:29:00.000Z'),
      ownerLine: 'Версия 1.2 собирается, агент правит экран.',
    });
    // The task's name as W25 shows it (no title — the host-made one), never
    // the head of the prompt (review r1108).
    expect(chain?.preview).toBe('Фоновая задача от 10.03 15:16');
    expect(chain?.preview).not.toContain('Продолжи разрешённую');
  });

  it('в ответе — название задачи (W25), а не служебное начало задания (ревью r1108)', () => {
    // The prompt of a watch task.
    const prompt = '<internal>ВАЖНАЯ ПОПРАВКА ВЛАДЕЛЬЦА12345: контроль только на одни сутки, дальше не продлевать</internal>';
    const named = [
      { ...tasks[0], prompt, title: 'Контроль выгрузки' },
      { ...tasks[1], prompt, title: null },
    ];
    const chain = idleTrackedChain(named, 'tg:123456789', now, undefined, 'Asia/Almaty')!;
    expect(chain.preview).toBe('Контроль выгрузки');
    const text = idleTrackedWorkStatusText({ chain }, now, 'Asia/Almaty')!;
    expect(text).toContain('• Плановая проверка «Контроль выгрузки»: последняя была в 15:16, следующая — в 15:29.');
    expect(text).not.toMatch(/ВАЖНАЯ|ПОПРАВКА|12345/);
    // The next check's own title wins.
    expect(
      idleTrackedChain(
        [named[0], { ...named[1], title: 'Контроль выгрузки, вторые сутки' }],
        'tg:123456789', now, undefined, 'Asia/Almaty',
      )?.preview,
    ).toBe('Контроль выгрузки, вторые сутки');
  });

  it('нет цепочки: проверка давно, следующая далеко, задача просрочена', () => {
    expect(idleTrackedChain(tasks, 'tg:123456789', now + IDLE_TRACKED_WORK_WINDOW_MS)).toBeUndefined();
    expect(
      idleTrackedChain(tasks, 'tg:123456789', Date.parse('2026-03-10T10:05:00.000Z')),
    ).toBeUndefined();
    expect(
      idleTrackedChain(tasks, 'tg:123456789', Date.parse('2026-03-10T10:31:00.000Z')),
    ).toBeUndefined();
    expect(idleTrackedChain(tasks, 'tg:nobody', now)).toBeUndefined();
  });

  it('напоминание, поставленное давно, — не цепочка; повторяющаяся задача — цепочка', () => {
    const reminder = [
      { ...tasks[0] },
      { ...tasks[1], created_at: '2026-03-09T08:00:00.000Z' },
    ];
    expect(idleTrackedChain(reminder, 'tg:123456789', now)).toBeUndefined();
    const recurring = [
      {
        id: 'interval',
        chat_jid: 'tg:123456789',
        status: 'active',
        prompt: 'Проверять сборку каждые 10 минут',
        next_run: '2026-03-10T10:26:00.000Z',
        last_run: '2026-03-10T10:16:00.000Z',
        last_result: 'ok',
        created_at: '2026-03-08T08:00:00.000Z',
      },
    ];
    expect(idleTrackedChain(recurring, 'tg:123456789', now)).toMatchObject({
      nextRunAt: Date.parse('2026-03-10T10:26:00.000Z'),
    });
  });

  it('окно — по шагу цепочки: при шаге 30 и 60 мин хост отвечает во всём промежутке (ревью r1108)', () => {
    const chatJid = 'tg:123456789';
    const T = Date.parse('2026-03-08T10:00:00.000Z');
    const MIN = 60_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const once = (stepMin: number) => [
      { id: 'step-done', chat_jid: chatJid, status: 'completed', prompt: '<internal>Проверка</internal>',
        next_run: null, last_run: iso(T), last_result: 'Для владельца: идёт сборка.',
        created_at: iso(T - 40 * MIN) },
      { id: 'step-next', chat_jid: chatJid, status: 'active', prompt: '<internal>Проверка</internal>',
        next_run: iso(T + stepMin * MIN), last_run: null, last_result: null,
        // Scheduled by the check that ended at T.
        created_at: iso(T - 30_000) },
    ];
    for (const stepMin of [30, 60]) {
      for (let minute = 1; minute <= stepMin; minute += 1) {
        expect(idleTrackedChain(once(stepMin), chatJid, T + minute * MIN), `шаг ${stepMin}, минута ${minute}`)
          .toMatchObject({ lastRunAt: T, nextRunAt: T + stepMin * MIN, ownerLine: 'идёт сборка.' });
      }
      // Overdue by half a minute — still the chain; by more than a minute — no.
      expect(idleTrackedChain(once(stepMin), chatJid, T + stepMin * MIN + 30_000)).toBeDefined();
      expect(idleTrackedChain(once(stepMin), chatJid, T + stepMin * MIN + 61_000)).toBeUndefined();
    }
    // A step over 65 minutes is no chain.
    expect(idleTrackedChain(once(70), chatJid, T + 35 * MIN)).toBeUndefined();
    // A task every 30 minutes: the same row ran and is due again.
    const every30 = [{
      id: 'every30', chat_jid: chatJid, status: 'active', prompt: '<internal>Слежка</internal>',
      title: 'Слежка за Codex Desktop',
      next_run: iso(T + 30 * MIN), last_run: iso(T), last_result: 'ok', created_at: iso(T - 5 * 60 * MIN),
    }];
    expect(idleTrackedChain(every30, chatJid, T + 3 * MIN)?.preview).toBe('Слежка за Codex Desktop');
    expect(idleTrackedChain(every30, chatJid, T + 28 * MIN)).toBeDefined();
    // A reminder that ran a minute ago does not hide the chain.
    const withReminder = [
      ...once(60),
      { id: 'reminder', chat_jid: chatJid, status: 'completed', prompt: 'Напомни про оплату',
        next_run: null, last_run: iso(T + 40 * MIN), last_result: 'Напомнил', created_at: iso(T - 24 * 60 * MIN) },
    ];
    expect(idleTrackedChain(withReminder, chatJid, T + 41 * MIN)).toMatchObject({
      lastRunAt: T, nextRunAt: T + 60 * MIN,
    });
  });

  it('шаг больше 15 мин — только фоновая работа, напоминания не считаются проверками (финальная проверка r1108)', () => {
    const chatJid = 'tg:123456789';
    const T = Date.parse('2026-03-08T10:00:00.000Z');
    const MIN = 60_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const hourly = (extra: Record<string, unknown>) => [{
      id: 'hourly', chat_jid: chatJid, status: 'active', prompt: 'Выпить воды',
      next_run: iso(T + 60 * MIN), last_run: iso(T + 5_000), last_result: 'Напомнил',
      created_at: iso(T - 5 * 60 * MIN), ...extra,
    }];
    // An hourly reminder is no chain of checks.
    expect(idleTrackedChain(hourly({ task_kind: 'reminder' }), chatJid, T + 30 * MIN)).toBeUndefined();
    // A legacy row without the kind and without <internal> — a reminder too.
    expect(idleTrackedChain(hourly({}), chatJid, T + 30 * MIN)).toBeUndefined();
    // Background work every hour is a chain.
    expect(idleTrackedChain(hourly({ task_kind: 'background' }), chatJid, T + 30 * MIN)).toBeDefined();
    expect(idleTrackedChain(hourly({ prompt: '<internal>Слежка за сборкой' }), chatJid, T + 30 * MIN)).toBeDefined();
    // Two unrelated reminders 50 minutes apart are no chain.
    const pair = [
      { id: 'meeting', chat_jid: chatJid, status: 'completed', prompt: 'Планёрка', task_kind: 'reminder' as const,
        next_run: null, last_run: iso(T + 30_000), last_result: 'Напомнил', created_at: iso(T - 24 * 60 * MIN) },
      { id: 'call', chat_jid: chatJid, status: 'active', prompt: 'Позвонить Ивану', task_kind: 'reminder' as const,
        next_run: iso(T + 50 * MIN), last_run: null, last_result: null, created_at: iso(T - 15 * MIN) },
    ];
    expect(idleTrackedChain(pair, chatJid, T + 20 * MIN)).toBeUndefined();
    // Two reminders within 15 minutes of each other are no chain either.
    const close = [
      { ...pair[0] },
      { ...pair[1], next_run: iso(T + 10 * MIN) },
    ];
    expect(idleTrackedChain(close, chatJid, T + 5 * MIN)).toBeUndefined();
    // A background check that also set a reminder for the owner: the next check,
    // not the reminder, continues the chain.
    const withOwnReminder = [
      { id: 'check-1', chat_jid: chatJid, status: 'completed', prompt: '<internal>Проверка сборки',
        next_run: null, last_run: iso(T), last_result: 'Для владельца: собирается.', created_at: iso(T - 40 * MIN) },
      { id: 'remind', chat_jid: chatJid, status: 'active', prompt: 'Напомни владельцу про оплату', task_kind: 'reminder' as const,
        next_run: iso(T + 20 * MIN), last_run: null, last_result: null, created_at: iso(T - 60_000) },
      { id: 'check-2', chat_jid: chatJid, status: 'active', prompt: '<internal>Проверка сборки',
        next_run: iso(T + 30 * MIN), last_run: null, last_result: null, created_at: iso(T - 30_000) },
    ];
    expect(idleTrackedChain(withOwnReminder, chatJid, T + 10 * MIN)).toMatchObject({
      lastRunAt: T, nextRunAt: T + 30 * MIN, ownerLine: 'собирается.',
    });
  });

  it('из итога проверки берётся только строка для владельца', () => {
    expect(ownerLineFromTaskResult('<internal>delivered_0.7.0_await_owner_playtest</internal>')).toBeUndefined();
    expect(ownerLineFromTaskResult('Для владельца — сборка 0.7.0 готова, жду твоей проверки')).toBe(
      'сборка 0.7.0 готова, жду твоей проверки',
    );
    expect(ownerLineFromTaskResult(null)).toBeUndefined();
  });

  it('формы имени владельца из профиля установки тоже открывают его строку', () => {
    // Without a profile only the built-in «владельца» marks the owner line.
    const chatJid = 'tg:123456789';
    const T = Date.parse('2026-03-08T10:00:00.000Z');
    const MIN = 60_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const chain = (lastResult: string) => [
      { id: 'check-1', chat_jid: chatJid, status: 'completed', prompt: '<internal>Проверка сборки',
        next_run: null, last_run: iso(T), last_result: lastResult, created_at: iso(T - 40 * MIN) },
      { id: 'check-2', chat_jid: chatJid, status: 'active', prompt: '<internal>Проверка сборки',
        next_run: iso(T + 30 * MIN), last_run: null, last_result: null, created_at: iso(T - 30_000) },
    ];
    expect(ownerLineFromTaskResult('Для Образца — сборка 0.7.0 готова')).toBeUndefined();
    expect(idleTrackedChain(chain('Для Образца: собирается.'), chatJid, T + 10 * MIN)?.ownerLine).toBeUndefined();

    setInstanceProfileForTests({ owner: { taskResultNameForms: ['Образца', 'Примера'] } });
    try {
      expect(ownerLineFromTaskResult('Для Образца — сборка 0.7.0 готова')).toBe('сборка 0.7.0 готова');
      expect(ownerLineFromTaskResult('<internal>шаги выполнены\nДля Примера: жду проверки</internal>')).toBe('жду проверки');
      expect(idleTrackedChain(chain('Для Образца: собирается.'), chatJid, T + 10 * MIN)).toMatchObject({
        lastRunAt: T, nextRunAt: T + 30 * MIN, ownerLine: 'собирается.',
      });
      // The built-in word keeps working next to the profile forms; another name does not.
      expect(ownerLineFromTaskResult('Для владельца: идёт сборка.')).toBe('идёт сборка.');
      expect(ownerLineFromTaskResult('Для Соседа: идёт сборка.')).toBeUndefined();
    } finally {
      resetInstanceProfileForTests();
    }
    expect(ownerLineFromTaskResult('Для Образца — сборка 0.7.0 готова')).toBeUndefined();
  });

  it('строка «Для владельца» после 200-го знака берётся из полного итога запуска', () => {
    // The scheduler keeps only result.slice(0, 200) in last_result; the owner
    // line ends a check's result, so it is in task_run_logs only.
    const full =
      '<internal>' + 'Проверил сборку, логи и тесты; агент ещё правит экран. '.repeat(5) +
      '\nДля владельца: Версия 1.2 почти готова, жду агента.</internal>';
    expect(full.indexOf('Для владельца')).toBeGreaterThan(200);
    const cut = [{ ...tasks[0], id: 'chain-done', last_result: full.slice(0, 200) }, tasks[1]];
    expect(idleTrackedChain(cut, 'tg:123456789', now)?.ownerLine).toBeUndefined();
    const lookups: string[] = [];
    const chain = idleTrackedChain(cut, 'tg:123456789', now, (taskId) => {
      lookups.push(taskId);
      return full;
    });
    expect(lookups).toEqual(['chain-done']);
    expect(chain?.ownerLine).toBe('Версия 1.2 почти готова, жду агента.');
    // No run log (or no line in it): last_result is still used.
    expect(
      idleTrackedChain(
        [{ ...tasks[0], id: 'chain-done' }, tasks[1]],
        'tg:123456789',
        now,
        () => null,
      )?.ownerLine,
    ).toBe('Версия 1.2 собирается, агент правит экран.');
  });

  it('текст ответа: простыми словами, время по Алматы, без внутренних заметок', () => {
    const chain = idleTrackedChain(tasks, 'tg:123456789', now)!;
    const text = idleTrackedWorkStatusText(
      {
        chain,
        codexDesktop: {
          startedAt: Date.parse('2026-03-10T10:01:00.000Z'),
          updatedAt: Date.parse('2026-03-10T10:18:00.000Z'),
        },
      },
      now,
      'Asia/Almaty',
    )!;
    expect(text).toContain('последняя была в 15:16, следующая — в 15:29');
    expect(text).toContain('По последней проверке: Версия 1.2 собирается');
    expect(text).toContain('Codex Desktop делает задачу: начал в 15:01, последнее обновление в 15:18');
    expect(text).toContain('«проверь сейчас»');
    expect(text).not.toContain('Все проверки прошли');
    expect(idleTrackedWorkStatusText({}, now, 'Asia/Almaty')).toBeNull();
  });
});

describe('W09: ответ хоста без хода — только в чате владельца', () => {
  it('чат второго администратора по умолчанию не отвечает статусом, хотя ответ на «ау» во время хода у него есть', () => {
    const keys = ['SKOOBI_ACTIVE_RUN_ACK_GROUPS', 'SKOOBI_IDLE_STATUS_GROUPS'] as const;
    const saved = keys.map((key) => process.env[key]);
    try {
      // The usual setup: the answer during a run is on for both admin chats.
      process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS = 'telegram_main,telegram_admin';
      delete process.env.SKOOBI_IDLE_STATUS_GROUPS;
      expect(idleTrackedWorkStatusEnabledForGroup('telegram_main')).toBe(true);
      expect(idleTrackedWorkStatusEnabledForGroup('telegram_admin')).toBe(false);
      process.env.SKOOBI_IDLE_STATUS_GROUPS = 'telegram_main,telegram_admin';
      expect(idleTrackedWorkStatusEnabledForGroup('telegram_admin')).toBe(true);
      process.env.SKOOBI_IDLE_STATUS_GROUPS = 'off';
      expect(idleTrackedWorkStatusEnabledForGroup('telegram_main')).toBe(false);
      // Without the answer during a run there is no answer from saved state.
      delete process.env.SKOOBI_IDLE_STATUS_GROUPS;
      process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS = 'telegram_admin';
      expect(idleTrackedWorkStatusEnabledForGroup('telegram_main')).toBe(false);
    } finally {
      keys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      });
    }
  });
});

describe('W09: пинг во время тихой плановой задачи', () => {
  it('возвращается модели, если задача после него ничего не прислала', () => {
    const entries = [
      { cursor: 'i:1', answeredAt: 100 },
      { cursor: 'i:2', answeredAt: 200 },
      { cursor: 'i:3', answeredAt: 300 },
    ];
    const pending = new Set(['i:1', 'i:2']);
    // The task replied at 150: covers the ping from 100, not the one from 200.
    expect(
      pingsUnansweredByScheduledTask(entries, pending, (at) => at < 150),
    ).toEqual(['i:2']);
    expect(pingsUnansweredByScheduledTask(entries, pending, () => true)).toEqual([]);
  });
});

describe('W09: настоящий диспетчер без хода в чате', () => {
  async function setup(folder: string, chatJid: string) {
    const db = await import('./db.js');
    const runtime = await import('../runtimes/sandbox-runner.js');
    const loop = await import('./message-loop.js');
    const group = {
      name: 'Owner', folder, trigger: '@test', added_at: '2026-01-01T00:00:00Z',
      requiresTrigger: false, isMain: true, runtime: 'sandbox' as const,
      agentConfig: { fullAccess: true },
    };
    const channel = {
      name: 'idle-status-test', ownsJid: (jid: string) => jid === chatJid,
      isConnected: () => true, setTyping: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      reactToMessage: vi.fn(async () => true),
    };
    const routed: string[] = [];
    const router = {
      send: vi.fn(async () => undefined),
      route: vi.fn(async (envelope: { text: string }) => {
        routed.push(envelope.text);
        return envelope.text;
      }),
    };
    const runner = vi.fn(async () => ({ status: 'success' as const, result: 'Ответ модели' }));
    db.initDatabase();
    db.setRegisteredGroup(chatJid, group);
    loop._setRegisteredGroups({ [chatJid]: group });
    loop._setChannelsForTest([channel as never]);
    vi.spyOn(runtime, 'runSandboxAgent').mockImplementation(runner as never);
    const ping = (id: string, content: string, at: string) =>
      db.storeMessage({
        id, chat_jid: chatJid, sender: chatJid.slice(3), sender_name: 'Owner', content,
        timestamp: at, sender_identity: {
          channel: 'telegram', chat_id: chatJid.slice(3), telegram_user_id: chatJid.slice(3),
          identity_id: `telegram:${chatJid.slice(3)}`, bot_id: 'test', is_owner_sender: true,
          telegram_message_origin: 'direct',
        },
      });
    return { db, loop, router, runner, routed, ping };
  }

  it('«Делается?» при живой цепочке: ответ хоста, модель не запускается, курсор пройден', async () => {
    const previous = process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS;
    const chatJid = 'tg:100000001';
    const folder = 'idle-status-chain';
    process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS = folder;
    const previousIdle = process.env.SKOOBI_IDLE_STATUS_GROUPS;
    // The answer from saved state is for the owner's chat only (telegram_main
    // by default); the test chat stands for it.
    process.env.SKOOBI_IDLE_STATUS_GROUPS = folder;
    try {
      const { db, loop, router, runner, routed, ping } = await setup(folder, chatJid);
      const now = Date.now();
      db.createTask({
        id: 'chain-done', group_folder: folder, chat_jid: chatJid,
        prompt: '<internal>Проверить сборку игры</internal>', schedule_type: 'once',
        schedule_value: '2026-03-10T15:15:00', context_mode: 'group',
        next_run: new Date(now - 60_000).toISOString(), status: 'active',
        created_at: new Date(now - 20 * 60_000).toISOString(),
      });
      db.updateTaskAfterRun('chain-done', null, 'Для владельца: агент правит экран, сборка ещё не готова.');
      db.createTask({
        id: 'chain-next', group_folder: folder, chat_jid: chatJid,
        prompt: '<internal>Проверить сборку игры</internal>', schedule_type: 'once',
        schedule_value: '2026-03-10T15:29:00', context_mode: 'group',
        next_run: new Date(now + 10 * 60_000).toISOString(), status: 'active',
        created_at: new Date(now - 60_000).toISOString(),
        title: 'Сборка игры',
      });
      ping('27101', 'Делается?', new Date(now - 1_000).toISOString());
      expect(await loop.processGroupMessages(chatJid, router as never)).toBe(true);
      expect(runner).not.toHaveBeenCalled();
      expect(routed).toHaveLength(1);
      // The task's name (W25), not the head of its prompt.
      expect(routed[0]).toContain('Плановая проверка «Сборка игры»');
      expect(routed[0]).not.toContain('Проверить сборку игры');
      expect(routed[0]).toContain('По последней проверке: агент правит экран');
      // The reply IS the answer here: not an interim kind for reply latency.
      expect(router.route.mock.calls[0][0]).toMatchObject({
        meta: { kind: 'idle_tracked_work_status' },
      });
      // The cursor passed the ping: a second dispatch has nothing to do.
      expect(await loop.processGroupMessages(chatJid, router as never)).toBe(true);
      expect(runner).not.toHaveBeenCalled();
      expect(routed).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS;
      else process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS = previous;
      if (previousIdle === undefined) delete process.env.SKOOBI_IDLE_STATUS_GROUPS;
      else process.env.SKOOBI_IDLE_STATUS_GROUPS = previousIdle;
      vi.restoreAllMocks();
    }
  }, 30_000);

  it('без отслеживаемой работы «ну как?» по-прежнему уходит модели (1d1138d)', async () => {
    const previous = process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS;
    const chatJid = 'tg:100000002';
    const folder = 'idle-status-none';
    process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS = folder;
    const previousIdle = process.env.SKOOBI_IDLE_STATUS_GROUPS;
    // The answer from saved state is for the owner's chat only (telegram_main
    // by default); the test chat stands for it.
    process.env.SKOOBI_IDLE_STATUS_GROUPS = folder;
    try {
      const { loop, router, runner, routed, ping } = await setup(folder, chatJid);
      ping('27102', 'ну как?', new Date(Date.now() - 1_000).toISOString());
      await loop.processGroupMessages(chatJid, router as never);
      expect(runner).toHaveBeenCalledTimes(1);
      expect(routed.some((text) => text.includes('Работа идёт в фоне'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS;
      else process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS = previous;
      if (previousIdle === undefined) delete process.env.SKOOBI_IDLE_STATUS_GROUPS;
      else process.env.SKOOBI_IDLE_STATUS_GROUPS = previousIdle;
      vi.restoreAllMocks();
    }
  }, 30_000);

  it('вопрос плюс поручение — всегда модели, даже при живой цепочке', async () => {
    const previous = process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS;
    const chatJid = 'tg:100000003';
    const folder = 'idle-status-mixed';
    process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS = folder;
    const previousIdle = process.env.SKOOBI_IDLE_STATUS_GROUPS;
    // The answer from saved state is for the owner's chat only (telegram_main
    // by default); the test chat stands for it.
    process.env.SKOOBI_IDLE_STATUS_GROUPS = folder;
    try {
      const { db, loop, router, runner, ping } = await setup(folder, chatJid);
      const now = Date.now();
      db.createTask({
        id: 'mixed-done', group_folder: folder, chat_jid: chatJid, prompt: 'Проверка',
        schedule_type: 'once', schedule_value: 'x', context_mode: 'group',
        next_run: new Date(now - 60_000).toISOString(), status: 'active',
        created_at: new Date(now - 20 * 60_000).toISOString(),
      });
      db.updateTaskAfterRun('mixed-done', null, 'ok');
      db.createTask({
        id: 'mixed-next', group_folder: folder, chat_jid: chatJid, prompt: 'Проверка',
        schedule_type: 'once', schedule_value: 'x', context_mode: 'group',
        next_run: new Date(now + 5 * 60_000).toISOString(), status: 'active',
        created_at: new Date(now - 60_000).toISOString(),
      });
      ping('27103', 'Делает?', new Date(now - 2_000).toISOString());
      ping('27104', 'И пришли архив', new Date(now - 1_000).toISOString());
      await loop.processGroupMessages(chatJid, router as never);
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS;
      else process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS = previous;
      if (previousIdle === undefined) delete process.env.SKOOBI_IDLE_STATUS_GROUPS;
      else process.env.SKOOBI_IDLE_STATUS_GROUPS = previousIdle;
      vi.restoreAllMocks();
    }
  }, 30_000);
  function withEnv(values: Record<string, string | undefined>): () => void {
    const saved = Object.fromEntries(
      Object.keys(values).map((key) => [key, process.env[key]]),
    );
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
  }

  function liveChain(
    db: typeof import('./db.js'),
    folder: string,
    chatJid: string,
    prefix: string,
    result: string,
  ): void {
    const now = Date.now();
    db.createTask({
      id: `${prefix}-done`, group_folder: folder, chat_jid: chatJid,
      prompt: '<internal>Проверить сборку игры</internal>', schedule_type: 'once',
      schedule_value: 'x', context_mode: 'group',
      next_run: new Date(now - 60_000).toISOString(), status: 'active',
      created_at: new Date(now - 20 * 60_000).toISOString(),
    });
    // Exactly what the scheduler does: the full result in the run log, its
    // first 200 characters in last_result.
    db.logTaskRun({
      task_id: `${prefix}-done`, run_at: new Date(now - 2 * 60_000).toISOString(),
      duration_ms: 60_000, status: 'success', result, error: null,
    });
    db.updateTaskAfterRun(`${prefix}-done`, null, result.slice(0, 200));
    db.createTask({
      id: `${prefix}-next`, group_folder: folder, chat_jid: chatJid,
      prompt: '<internal>Проверить сборку игры</internal>', schedule_type: 'once',
      schedule_value: 'x', context_mode: 'group',
      next_run: new Date(now + 10 * 60_000).toISOString(), status: 'active',
      created_at: new Date(now - 60_000).toISOString(),
    });
  }

  it('строка «Для владельца» в конце длинного итога доходит до ответа хоста', async () => {
    const chatJid = 'tg:100123';
    const folder = 'idle-status-long';
    const restore = withEnv({
      SKOOBI_ACTIVE_RUN_ACK_GROUPS: folder,
      SKOOBI_IDLE_STATUS_GROUPS: folder,
    });
    try {
      const { db, loop, router, runner, routed, ping } = await setup(folder, chatJid);
      const result =
        '<internal>' + 'Проверил сборку, логи и тесты; агент ещё правит экран. '.repeat(5) +
        '\nДля владельца: экран почти готов, следующая сборка через 10 минут.</internal>';
      liveChain(db, folder, chatJid, 'long', result);
      ping('27102', 'ну как?', new Date(Date.now() - 1_000).toISOString());
      await loop.processGroupMessages(chatJid, router as never);
      expect(runner).not.toHaveBeenCalled();
      expect(routed).toHaveLength(1);
      expect(routed[0]).toContain('По последней проверке: экран почти готов');
      expect(routed[0]).not.toContain('Проверил сборку, логи');
    } finally {
      restore();
      vi.restoreAllMocks();
    }
  }, 30_000);

  it('после пропуска по wake_if строка «Для владельца» — из последней настоящей проверки (ревью r1108)', async () => {
    const chatJid = 'tg:100200300';
    const folder = 'idle-status-skipped';
    const restore = withEnv({
      SKOOBI_ACTIVE_RUN_ACK_GROUPS: folder,
      SKOOBI_IDLE_STATUS_GROUPS: folder,
    });
    try {
      const { db, loop, router, runner, routed, ping } = await setup(folder, chatJid);
      const now = Date.now();
      // A watch every 30 minutes that wakes the model only on a change (W26).
      db.createTask({
        id: 'watch-skipped', group_folder: folder, chat_jid: chatJid,
        prompt: '<internal>Следить за сборкой</internal>', schedule_type: 'interval',
        schedule_value: String(30 * 60_000), context_mode: 'isolated',
        next_run: new Date(now + 25 * 60_000).toISOString(), status: 'active',
        created_at: new Date(now - 3 * 60 * 60_000).toISOString(),
        title: 'Слежка за сборкой',
      });
      db.logTaskRun({
        task_id: 'watch-skipped', run_at: new Date(now - 35 * 60_000).toISOString(),
        duration_ms: 90_000, status: 'success',
        result: '<internal>Логи чистые.\nДля владельца: сборка 0.7 собрана, жду твоей проверки.</internal>',
        error: null,
      });
      // Exactly what gateDueTask writes for a check without a change.
      db.logTaskRun({
        task_id: 'watch-skipped', run_at: new Date(now - 5 * 60_000).toISOString(),
        duration_ms: 3, status: 'skipped', result: 'Без изменений', error: null,
      });
      db.updateTaskAfterRun('watch-skipped', new Date(now + 25 * 60_000).toISOString(),
        'Пропущено — без изменений');
      ping('27105', 'ну как?', new Date(now - 1_000).toISOString());
      await loop.processGroupMessages(chatJid, router as never);
      expect(runner).not.toHaveBeenCalled();
      expect(routed).toHaveLength(1);
      expect(routed[0]).toContain('Плановая проверка «Слежка за сборкой»');
      expect(routed[0]).toContain('По последней проверке: сборка 0.7 собрана, жду твоей проверки.');
    } finally {
      restore();
      vi.restoreAllMocks();
    }
  }, 30_000);

  it('чат второго администратора (основной, ответ на «ау» во время хода включён): пинг уходит модели', async () => {
    const chatJid = 'tg:100777';
    const folder = 'idle-status-admin';
    // The usual setup: the answer during a run is on for the second admin, the list of chats
    // for the answer from saved state is not set (owner's chat only).
    const restore = withEnv({
      SKOOBI_ACTIVE_RUN_ACK_GROUPS: `telegram_main,${folder}`,
      SKOOBI_IDLE_STATUS_GROUPS: undefined,
    });
    try {
      const { db, loop, router, runner, routed, ping } = await setup(folder, chatJid);
      liveChain(db, folder, chatJid, 'admin', 'Для владельца: сборка идёт.');
      ping('27400', 'Ты тут?', new Date(Date.now() - 1_000).toISOString());
      await loop.processGroupMessages(chatJid, router as never);
      expect(runner).toHaveBeenCalledTimes(1);
      expect(routed.some((text) => text.includes('Работа идёт в фоне'))).toBe(false);
    } finally {
      restore();
      vi.restoreAllMocks();
    }
  }, 30_000);

  it('статус Codex Desktop — только в чате его владельца', async () => {
    const chatJid = 'tg:100999';
    const folder = 'idle-status-desktop';
    const restore = withEnv({
      SKOOBI_ACTIVE_RUN_ACK_GROUPS: folder,
      SKOOBI_IDLE_STATUS_GROUPS: folder,
      HELPER_SECRET: 'test-' + 'helper',
      CODEX_DESKTOP_OWNER_CHAT_JID: 'tg:someone-else',
    });
    const statusCalls: string[] = [];
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const href = String(url);
      if (!href.includes('/codex_desktop/status')) {
        return new Response('{}', { status: 404 });
      }
      statusCalls.push(href);
      return new Response(
        JSON.stringify({
          task: { status: 'inProgress', startedAt, updatedAt: startedAt, completedAt: null },
        }),
        { status: 200 },
      );
    });
    try {
      const { loop, router, runner, routed, ping } = await setup(folder, chatJid);
      ping('27401', 'Делается?', new Date(Date.now() - 2_000).toISOString());
      await loop.processGroupMessages(chatJid, router as never);
      // Not the Codex owner's chat: the helper is not asked, the model answers.
      expect(statusCalls).toHaveLength(0);
      expect(runner).toHaveBeenCalledTimes(1);
      expect(routed.some((text) => text.includes('Codex Desktop'))).toBe(false);

      process.env.CODEX_DESKTOP_OWNER_CHAT_JID = chatJid;
      ping('27402', 'Делается?', new Date(Date.now() - 1_000).toISOString());
      await loop.processGroupMessages(chatJid, router as never);
      expect(statusCalls).toHaveLength(1);
      expect(runner).toHaveBeenCalledTimes(1);
      expect(routed.at(-1)).toContain('Codex Desktop делает задачу');
    } finally {
      fetchSpy.mockRestore();
      restore();
      vi.restoreAllMocks();
    }
  }, 30_000);
});
