import { describe, expect, it, vi } from 'vitest';

import { parseTaskControlCallbackData } from '@skoobi/shared/channel-types';

import {
  applyTaskControl,
  buildChatTasksOverview,
  describeTaskSchedule,
  formatTaskWhen,
  taskControlOutcomeText,
} from './task-control.js';
import type { ScheduledTask } from './types.js';

const TZ = 'Asia/Almaty';
const CHAT = 'tg:123456789';
const NOW = Date.parse('2026-11-08T10:00:00.000Z'); // 15:00 в Алматы

function task(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'task-1',
    group_folder: 'telegram_main',
    chat_jid: CHAT,
    prompt: '<internal>Продолжи работу',
    schedule_type: 'once',
    schedule_value: '2026-11-08T16:00:00',
    context_mode: 'isolated',
    next_run: '2026-11-08T11:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-11-08T09:00:00.000Z',
    ...overrides,
  };
}

describe('/tasks без модели (W25)', () => {
  it('фон с кнопками, напоминания отдельным блоком и без кнопок', () => {
    const watcher = task({
      id: 'task-watch',
      title: 'Слежка за обновлением Атлас2',
      task_kind: 'background',
      schedule_type: 'interval',
      schedule_value: '1800000',
    });
    const followUp = task({ id: 'task-follow', status: 'paused' });
    const reminder = task({
      id: 'task-remind',
      prompt: 'Напомни владельцу оплатить интернет',
      task_kind: 'reminder',
      schedule_type: 'cron',
      schedule_value: '0 9 19 * *',
      next_run: '2026-11-19T04:00:00.000Z',
    });
    const done = task({ id: 'task-done', status: 'completed' });
    const overview = buildChatTasksOverview({
      tasks: [watcher, followUp, reminder, done],
      runTotals: new Map([
        ['task-watch', { runs: 12, durationMs: 34 * 60_000 }],
        ['task-done', { runs: 3, durationMs: 6 * 60_000 }],
        ['task-remind', { runs: 1, durationMs: 60_000 }],
      ]),
      activeRun: { taskId: 'task-watch', startedAt: NOW - 4 * 60_000 },
      now: NOW,
      timeZone: TZ,
    });

    expect(overview.text).toContain(
      'Сейчас идёт «Слежка за обновлением Атлас2» — 4 мин.',
    );
    expect(overview.text).toContain('Фоновые задачи (2):');
    expect(overview.text).toContain(
      '1. «Слежка за обновлением Атлас2» — каждые 30 мин, идёт сейчас, 4 мин',
    );
    expect(overview.text).toContain('за 7 дней: 12 запусков, 34 мин');
    expect(overview.text).toContain(
      '2. «Фоновая задача от 08.11 14:00» — разово, на паузе',
    );
    expect(overview.text).toContain('Напоминания (1):');
    expect(overview.text).toContain(
      '• «Напомни владельцу оплатить интернет» — по расписанию, следующий запуск 19.11 в 09:00',
    );
    // Завершённые не в списке, но их минуты — в итоге фона; напоминание — нет.
    expect(overview.text).not.toContain('task-done');
    expect(overview.text).toContain(
      'За 7 дней фоновые задачи этого чата: 15 запусков, 40 мин работы.',
    );
    expect(overview.text).not.toMatch(/internal/);

    const actions = overview.buttons
      .flat()
      .map((button) => parseTaskControlCallbackData(button.callbackData));
    expect(actions).toEqual([
      { kind: 'stop', taskId: 'task-watch' },
      { kind: 'stop', taskId: 'task-follow' },
      { kind: 'stop_all_background' },
    ]);
    expect(overview.buttons.flat()[0].text).toBe(
      '⏹ Слежка за обновлением Атлас2',
    );
  });

  it('пустой чат — простой ответ без кнопок', () => {
    const overview = buildChatTasksOverview({
      tasks: [],
      runTotals: new Map(),
      activeRun: null,
      now: NOW,
      timeZone: TZ,
    });
    expect(overview.text).toBe(
      'Сейчас в фоне ничего не выполняется.\n\nПлановых задач в этом чате нет.',
    );
    expect(overview.buttons).toEqual([]);
  });

  it('одна фоновая задача — без кнопки «все фоновые»', () => {
    const overview = buildChatTasksOverview({
      tasks: [task({ id: 'task-a' })],
      runTotals: new Map(),
      activeRun: null,
      now: NOW,
      timeZone: TZ,
    });
    expect(overview.buttons).toHaveLength(1);
    expect(overview.text).toContain('следующий запуск сегодня в 16:00');
  });

  it('время и расписание по-человечески', () => {
    expect(formatTaskWhen('2026-11-09T03:30:00.000Z', NOW, TZ)).toBe(
      'завтра в 08:30',
    );
    expect(
      describeTaskSchedule({
        schedule_type: 'interval',
        schedule_value: '3600000',
      }),
    ).toBe('каждый час');
    expect(
      describeTaskSchedule({
        schedule_type: 'interval',
        schedule_value: '7200000',
      }),
    ).toBe('каждые 2 ч');
    expect(
      describeTaskSchedule({ schedule_type: 'interval', schedule_value: 'x' }),
    ).toBe('повторяется');
  });
});

describe('кнопка «Остановить» (W25)', () => {
  const deps = (tasks: ScheduledTask[], runningTaskId?: string) => {
    const order: string[] = [];
    return {
      order,
      listChatTasks: vi.fn((chatJid: string) =>
        tasks.filter((item) => item.chat_jid === chatJid),
      ),
      cancelTask: vi.fn(async (taskId: string) => {
        order.push(`cancel:${taskId}`);
      }),
      interruptRun: vi.fn((_chatJid: string, taskId: string) => {
        order.push(`interrupt:${taskId}`);
        return taskId === runningTaskId;
      }),
    };
  };

  it('сначала отмена в базе, потом прерывание текущего запуска', async () => {
    const d = deps([task({ id: 'task-a' })], 'task-a');
    const outcome = await applyTaskControl(
      CHAT,
      { kind: 'stop', taskId: 'task-a' },
      d,
    );
    expect(d.order).toEqual(['cancel:task-a', 'interrupt:task-a']);
    expect(outcome.interrupted).toBe(true);
    expect(taskControlOutcomeText(outcome, TZ).line).toBe(
      '⏹ Остановил «Фоновая задача от 08.11 14:00». Текущий запуск прерван.',
    );
  });

  it('чужой чат и напоминание кнопкой не останавливаются', async () => {
    const d = deps([
      task({ id: 'task-other', chat_jid: 'tg:987654321' }),
      task({ id: 'task-remind', prompt: 'Напомни', task_kind: 'reminder' }),
    ]);
    const foreign = await applyTaskControl(
      CHAT,
      { kind: 'stop', taskId: 'task-other' },
      d,
    );
    expect(foreign.notFound).toBe(true);
    const reminder = await applyTaskControl(
      CHAT,
      { kind: 'stop', taskId: 'task-remind' },
      d,
    );
    expect(reminder.reminder?.id).toBe('task-remind');
    expect(d.cancelTask).not.toHaveBeenCalled();
  });

  it('уже завершённая задача не трогается', async () => {
    const d = deps([task({ id: 'task-a', status: 'cancelled' })]);
    const outcome = await applyTaskControl(
      CHAT,
      { kind: 'stop', taskId: 'task-a' },
      d,
    );
    expect(outcome.alreadyStopped?.id).toBe('task-a');
    expect(d.cancelTask).not.toHaveBeenCalled();
  });

  it('«Остановить все фоновые» не трогает напоминания людям и задачи других чатов', async () => {
    const d = deps([
      task({ id: 'bg-1' }),
      task({
        id: 'bg-2',
        status: 'paused',
        task_kind: 'background',
        prompt: 'Слежка',
      }),
      task({ id: 'remind', prompt: 'Напомни оплатить', task_kind: 'reminder' }),
      task({
        id: 'legacy-remind',
        prompt: 'Каждый месяц напомни про отчёт',
        task_kind: null,
      }),
      task({ id: 'bg-done', status: 'completed' }),
      task({ id: 'bg-other-chat', chat_jid: 'tg:987654321' }),
    ]);
    const outcome = await applyTaskControl(
      CHAT,
      { kind: 'stop_all_background' },
      d,
    );
    expect(outcome.stopped.map((item) => item.id)).toEqual(['bg-1', 'bg-2']);
    expect(d.cancelTask.mock.calls.map((call) => call[0])).toEqual([
      'bg-1',
      'bg-2',
    ]);
    expect(taskControlOutcomeText(outcome, TZ).line).toBe(
      '⏹ Остановил фоновые задачи: 2. Напоминания не трогал.',
    );
  });
});

describe('/tasks: слежка с условием и сроком (W26)', () => {
  it('показывает срок, режим «только при изменениях» и пропущенные проверки', () => {
    const watch = task({
      id: 'task-watch',
      title: 'Слежка за сборкой',
      task_kind: 'background',
      schedule_type: 'interval',
      schedule_value: '600000',
      next_run: '2026-11-08T10:10:00.000Z',
      wake_if: JSON.stringify({ path_changed: 'output/READY.json' }),
      expires_at: '2026-11-09T13:00:00.000Z',
    });
    const overview = buildChatTasksOverview({
      tasks: [watch],
      runTotals: new Map([
        ['task-watch', { runs: 2, durationMs: 4 * 60_000, skipped: 30 }],
      ]),
      activeRun: null,
      now: NOW,
      timeZone: TZ,
    });
    expect(overview.text).toContain(
      '1. «Слежка за сборкой» — каждые 10 мин до 09.11 18:00, будит модель только при изменениях, следующий запуск сегодня в 15:10',
    );
    expect(overview.text).toContain(
      '   за 7 дней: 2 запуска, 4 мин; без изменений пропущено 30',
    );
  });
});
