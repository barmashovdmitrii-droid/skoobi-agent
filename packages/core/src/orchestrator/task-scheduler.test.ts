import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isScheduledHistoryMessage } from './continuation-context.js';

const runnerMocks = vi.hoisted(() => ({
  runContainerAgent: vi.fn(),
  runSandboxAgent: vi.fn(),
  writeTasksSnapshot: vi.fn(),
  createModelGateway: vi.fn(),
  loadModelGatewayConfig: vi.fn(),
}));

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Skoobi',
  // task-scheduler computes TASK_LEASE_TTL_MS from CONTAINER_TIMEOUT at module
  // eval time; it MUST be present in this mock or the constant becomes NaN and
  // lease inserts (an INTEGER column) break. (30 min, matching the real default.)
  CONTAINER_TIMEOUT: 1800000,
  DEFAULT_RUNTIME: 'container',
  GROUPS_DIR: '/tmp/claudeclaw-task-scheduler-groups',
  // task-scheduler imports IDLE_TIMEOUT for computeLeaseTtlMs (the per-group
  // lease ceiling); it MUST be present or the constant becomes NaN. (30 min.)
  IDLE_TIMEOUT: 1800000,
  SCHEDULER_POLL_INTERVAL: 60000,
  TIMEZONE: 'UTC',
}));

vi.mock('../runtimes/container-runner.js', () => ({
  runContainerAgent: runnerMocks.runContainerAgent,
  writeTasksSnapshot: runnerMocks.writeTasksSnapshot,
}));

vi.mock('../runtimes/sandbox-runner.js', () => ({
  runSandboxAgent: runnerMocks.runSandboxAgent,
}));

vi.mock('./model-gateway.js', () => ({
  createModelGateway: runnerMocks.createModelGateway,
  loadModelGatewayConfig: runnerMocks.loadModelGatewayConfig,
}));

// Pass-through spies: the real policy builders run, the read_only profile
// tests only check whether they were asked at all.
vi.mock('./google-workspace-policy.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./google-workspace-policy.js')>();
  return {
    ...actual,
    buildGoogleOperationPolicy: vi.fn(actual.buildGoogleOperationPolicy),
    buildStandingGoogleOperationPolicy: vi.fn(
      actual.buildStandingGoogleOperationPolicy,
    ),
  };
});

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getDb,
  getRecentConversationMessages,
  logTaskRun,
  getTaskById,
  updateTask,
} from './db.js';
import { logger } from './logger.js';
import {
  buildGoogleOperationPolicy,
  buildStandingGoogleOperationPolicy,
} from './google-workspace-policy.js';
import {
  GOOGLE_WORKSPACE_TOOL_NAMES,
  GOOGLE_WORKSPACE_WRITE_TOOLS,
} from './google-workspace-operation.js';
import { processGoogleWorkspaceRequest } from './google-workspace-broker.js';
import { getExtensionDbSchema } from './extensions.js';
import { authorizeTaskOperationRequest } from './task-authorization.js';
import { signedTaskAuthorizationRequestForTest } from './task-authorization.test-helpers.js';
import { createMessageRouter } from './outbound-router.js';
import { UNTRUSTED_CONTENT_QUARANTINED_TOOLS } from './run-trust.js';
import type { Channel } from './types.js';
import { _resetChatFileSendsForTests } from './chat-file-sends.js';
import {
  READ_ONLY_TASK_DISALLOWED_TOOLS,
  attachTaskLocalFileLinks,
  routeAndRecordTaskOutput,
  taskPromptRequestsGoogle,
  taskRunsReadOnly,
  finalizeUnhandledTaskFailure,
  _resetSchedulerLoopForTests,
  SCHEDULER_RESTART_GATE_TASK_ID,
  claimTaskForRun,
  computeLeaseTtlMs,
  computeNextRun,
  computeNextRunAfterTaskAttempt,
  releaseTaskLease,
  renewTaskLease,
  runTask,
  scheduledTaskChatId,
  scheduledTaskRunCeilingMs,
  startSchedulerLoop,
  taskFailureNoticeText,
} from './task-scheduler.js';

/** What a task run itself calls on the queue. */
const taskQueueMock = () =>
  ({
    noteRunActivity: vi.fn(),
    notifyIdle: vi.fn(),
    closeStdin: vi.fn(),
  }) as any;

describe('сбой задачи ДО запуска агента (OPS-1/H3/SCHED-1)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  const makeTask = (id: string) => {
    createTask({
      id,
      group_folder: 'telegram_main',
      chat_jid: 'tg:100000001',
      prompt: 'утренняя сводка',
      schedule_type: 'cron',
      schedule_value: '0 10 * * *',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-07-01T00:00:00.000Z',
    });
    return getTaskById(id)!;
  };

  const deps = (route: ReturnType<typeof vi.fn>) =>
    ({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: {} as any,
      onProcess: () => {},
      router: { route, send: async () => {}, addPreHook: () => {}, addPostHook: () => {} },
    }) as any;

  it('записывает попытку, двигает расписание и пишет владельцу', async () => {
    const task = makeTask('task-eacces');
    const route = vi.fn(async (_payload: any) => {});

    await finalizeUnhandledTaskFailure(
      task,
      deps(route),
      new Error("EACCES: permission denied, open 'current_tasks.json'"),
      Date.now() - 1_000,
    );

    const logs = getDb()
      .prepare('SELECT status, error FROM task_run_logs WHERE task_id = ?')
      .all('task-eacces') as { status: string; error: string }[];
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('error');
    expect(logs[0].error).toContain('EACCES');

    // Главное: next_run сдвинут. Раньше он оставался в прошлом, и планировщик
    // перезапускал задачу каждую минуту без следа.
    const after = getTaskById('task-eacces')!;
    expect(after.next_run).not.toBeNull();
    expect(Date.parse(after.next_run!)).toBeGreaterThan(Date.now());
    expect(after.status).toBe('active');

    expect(route).toHaveBeenCalledTimes(1);
    const notice = route.mock.calls[0]![0] as { text: string; meta: any };
    expect(notice.text).toContain('не выполнилась');
    expect(notice.meta.kind).toBe('task_failure_notice');
  });

  it('после пяти отказов подряд ставит задачу на паузу вместо вечного ретрая', async () => {
    const task = makeTask('task-broken');
    for (let i = 0; i < 4; i += 1) {
      logTaskRun({
        task_id: 'task-broken',
        run_at: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
        duration_ms: 5,
        status: 'error',
        result: null,
        error: 'EACCES',
      });
    }
    const route = vi.fn(async (_payload: any) => {});

    await finalizeUnhandledTaskFailure(task, deps(route), new Error('EACCES'), Date.now());

    const after = getTaskById('task-broken')!;
    expect(after.status).toBe('paused');
    expect(after.next_run).toBeNull();
    expect((route.mock.calls[0]![0] as { text: string }).text).toContain(
      'поставлена на паузу',
    );
  });

  it('не трогает задачу, удалённую во время прогона', async () => {
    const task = makeTask('task-gone');
    getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run('task-gone');
    const route = vi.fn(async (_payload: any) => {});

    await finalizeUnhandledTaskFailure(task, deps(route), new Error('boom'), Date.now());

    expect(route).not.toHaveBeenCalled();
    const logs = getDb()
      .prepare('SELECT COUNT(*) c FROM task_run_logs WHERE task_id = ?')
      .get('task-gone') as { c: number };
    expect(logs.c).toBe(0);
  });
});


// первые 80 символов инструкции боту.
describe('извещение о сбое напоминания показывает само напоминание', () => {
  const MONTHLY =
    'Каждого 5-го числа месяца в 09:00 напомни владельцу в текущем чате одним ' +
    'сообщением: «Сегодня проверить тестовый платёж — 100 условных единиц на учебный счёт». ' +
    'Без технических подробностей.';
  const retryNotice = (prompt: string) =>
    taskFailureNoticeText({
      prompt,
      error: 'spawn failed',
      outcome: 'retry',
      failureCount: 1,
    });
  const oldRetryNotice = (prompt: string) =>
    `⚠️ Запланированная задача не выполнилась: «${prompt.slice(0, 80)}…»\n` +
    'Ошибка: spawn failed\nПопробую снова по расписанию.';

  it('цитирует напоминание целиком во всех исходах и называет задачу', () => {
    const notice = (outcome: Parameters<typeof taskFailureNoticeText>[0]['outcome']) =>
      taskFailureNoticeText({
        prompt: MONTHLY,
        error: 'codex auth_error',
        outcome,
        failureCount: 5,
      });
    for (const outcome of ['uncertain', 'paused', 'retry', 'stopped'] as const) {
      expect(notice(outcome)).toContain(
        '«Сегодня проверить тестовый платёж — 100 условных единиц на учебный счёт»',
      );
      // A quote alone does not say which task failed or was paused.
      expect(notice(outcome)).toContain(`\nЗадача: «${MONTHLY.slice(0, 80)}…»`);
    }
    expect(notice('retry')).toBe(
      '⚠️ Не смог отправить напоминание как обычно, вот оно: «Сегодня проверить тестовый платёж — 100 условных единиц на учебный счёт»\n' +
        `Задача: «${MONTHLY.slice(0, 80)}…»\n` +
        'Ошибка: codex auth_error\nПопробую снова по расписанию.',
    );
    expect(notice('paused')).toContain('5 раз подряд и поставлена на паузу');
    expect(notice('uncertain')).toContain('внешнее действие могло уже выполниться');
  });

  it('короткая кавычка посреди задачи — название, а не напоминание', () => {
    const prompt = 'Напомни: сегодня забрать заказ из кафе «Ромашка» до 18:00';
    expect(retryNotice(prompt)).toBe(
      '⚠️ Не смог отправить напоминание как обычно, вот оно: ' +
        '«сегодня забрать заказ из кафе «Ромашка» до 18:00»\n' +
        'Ошибка: spawn failed\nПопробую снова по расписанию.',
    );
    // Even after a colon, a name is too short to be the message.
    expect(
      retryNotice('Напомни владельцу сверить остатки. Лист: «Склад-2». Ответь коротко.'),
    ).toContain('вот оно: «сверить остатки. Лист: «Склад-2». Ответь коротко.»');
  });

  it('длинная задача с названием листа в кавычках остаётся задачей', () => {
    const prompt =
      'Напоминание владельцу о возврате самоката №7, выдача ID test-scooter-07. ' +
      'Перед ответом прочитай актуальные строки листа «Журнал выдач» через Google API ' +
      'и найди выдачу по ID в колонке O, не по номеру строки. '.repeat(10) +
      'Если статус уже «Возвращён», ничего не отправляй.';
    expect(prompt.length).toBeGreaterThan(600);
    expect(retryNotice(prompt)).toBe(oldRetryNotice(prompt));
  });

  it('фраза для разговора в кавычках не теряет, кому позвонить', () => {
    const prompt =
      'Напомни: позвонить поставщику и сказать: «Нужна фотография паспорта клапанов и название производителя».';
    const text = retryNotice(prompt);
    expect(text).toContain(
      'вот оно: «Нужна фотография паспорта клапанов и название производителя»',
    );
    expect(text).toContain('\nЗадача: «Напомни: позвонить поставщику и сказать:');
  });

  it('вложенные кавычки не обрезают напоминание', () => {
    const prompt =
      'Напомни владельцу одним сообщением: «Сегодня сдать отчёт по ТОО «Пример» в налоговую до обеда».';
    expect(retryNotice(prompt)).toContain(
      'вот оно: «одним сообщением: «Сегодня сдать отчёт по ТОО «Пример» в налоговую до обеда».»',
    );
  });

  it('задача, которая говорит «а не напоминание», остаётся задачей', () => {
    const prompt =
      'Автономная разработка тестового проекта по поручению владельца. Это рабочий ' +
      'проход coding agent, а не напоминание владельцу. Продолжи этап «Глава три» и ' +
      'запиши итог в журнал.';
    expect(retryNotice(prompt)).toBe(oldRetryNotice(prompt));
  });

  it('слово «напомни» далеко в длинной задаче не делает её напоминанием', () => {
    const prompt =
      'В 11:00 отправь администратору короткое сообщение: предложи провести пробный ' +
      'тест нового видеоредактора на одном ролике для тестового проекта. Если тест уже ' +
      'был, коротко перечисли итоги. Напомни, что без согласия владельца ничего не ставим.';
    expect(prompt.toLowerCase().indexOf('напомни')).toBeGreaterThan(150);
    expect(retryNotice(prompt)).toBe(oldRetryNotice(prompt));
  });

  it('без кавычек берёт текст задачи без «напомни» и не режет его до 80 символов', () => {
    const prompt =
      'Напомни мне проверить тестовый стенд, обновить учебные данные и сохранить пример отчёта в синтетическом проекте';
    const text = taskFailureNoticeText({
      prompt,
      error: 'spawn failed',
      outcome: 'retry',
      failureCount: 1,
    });
    expect(text).toContain(
      '«проверить тестовый стенд, обновить учебные данные и сохранить пример отчёта в синтетическом проекте»',
    );
  });

  it('у обычной задачи прежний текст с началом задачи', () => {
    expect(
      taskFailureNoticeText({
        prompt: 'Проверь сайт и пришли итог',
        error: 'spawn failed',
        outcome: 'retry',
        failureCount: 1,
      }),
    ).toBe(
      '⚠️ Запланированная задача не выполнилась: «Проверь сайт и пришли итог»\nОшибка: spawn failed\nПопробую снова по расписанию.',
    );
  });

  it('сбой ДО запуска агента тоже приносит напоминание', async () => {
    _initTestDatabase();
    createTask({
      id: 'task-monthly-reminder',
      group_folder: 'telegram_admin',
      chat_jid: 'tg:100999',
      prompt: MONTHLY,
      schedule_type: 'cron',
      schedule_value: '0 9 5 * *',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-10-01T00:00:00.000Z',
    });
    const route = vi.fn(async (_payload: any) => {});

    await finalizeUnhandledTaskFailure(
      getTaskById('task-monthly-reminder')!,
      {
        registeredGroups: () => ({}),
        getSessions: () => ({}),
        queue: {} as any,
        onProcess: () => {},
        router: { route, send: async () => {}, addPreHook: () => {}, addPostHook: () => {} },
      } as any,
      new Error('EACCES'),
      Date.now() - 1_000,
    );

    expect(route).toHaveBeenCalledTimes(1);
    const notice = route.mock.calls[0]![0] as { text: string; meta: any };
    expect(notice.meta).toEqual({ kind: 'task_failure_notice' });
    expect(notice.text).toContain('100 условных единиц на учебный счёт');
  });
});

describe('результат задачи попадает в историю чата (TASKS-3)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  const envelope = {
    chatJid: 'tg:100000001',
    text: 'Тестовому клиенту нужно вернуть учебный комплект №4',
    triggerType: 'task-result' as const,
    groupFolder: 'telegram_main',
  };

  it('доставленное напоминание видно живому ходу как реплика бота', async () => {
    const router = {
      route: vi.fn().mockResolvedValue('Тестовому клиенту нужно вернуть учебный комплект №4'),
      send: vi.fn(),
    };
    const delivered = await routeAndRecordTaskOutput(router as never, envelope);
    expect(delivered).toBe('Тестовому клиенту нужно вернуть учебный комплект №4');
    const history = getRecentConversationMessages('tg:100000001', '', 10);
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('Тестовому клиенту нужно вернуть учебный комплект №4');
    expect(history[0].is_bot_message).toBeTruthy();
    expect(isScheduledHistoryMessage(history[0])).toBe(true);
  });

  it('ничего не пишет, если доставки не было', async () => {
    const router = { route: vi.fn().mockResolvedValue(null), send: vi.fn() };
    expect(await routeAndRecordTaskOutput(router as never, envelope)).toBeNull();
    expect(getRecentConversationMessages('tg:100000001', '', 10)).toHaveLength(0);
  });

  it('сбой записи в базу не отменяет уже состоявшуюся доставку', async () => {
    const router = { route: vi.fn().mockResolvedValue('текст'), send: vi.fn() };
    getDb().exec('DROP TABLE messages');
    await expect(
      routeAndRecordTaskOutput(router as never, envelope),
    ).resolves.toBe('текст');
  });
});

describe('ссылки на файлы на Mac в результате задачи (C38)', () => {
  const task = {
    id: 'task-local-links',
    chat_jid: 'tg:100200300',
    group_folder: 'telegram_tasklinks',
  };
  const groupRoot = () =>
    path.join(process.env.SKOOBI_TEST_STATE_ROOT!, 'groups', task.group_folder);

  beforeEach(() => {
    _initTestDatabase();
    _resetChatFileSendsForTests();
    fs.mkdirSync(groupRoot(), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(groupRoot(), { recursive: true, force: true });
  });

  it('прикладывает файл из папки чата до текста и пишет его в историю', async () => {
    const report = path.join(groupRoot(), 'report.pdf');
    fs.writeFileSync(report, 'pdf');
    const sendDocument = vi.fn().mockResolvedValue(true);
    const text = await attachTaskLocalFileLinks({
      router: { sendDocument } as never,
      task,
      ownerAuthorized: true,
      text: `Сводка готова: [report.pdf](${report})`,
    });
    expect(text).toBe('Сводка готова: report.pdf (файл выше)');
    expect(sendDocument).toHaveBeenCalledWith(
      task.chat_jid,
      fs.realpathSync(report),
      undefined,
      expect.objectContaining({ suppressCursorAdvance: true }),
    );
    const history = getRecentConversationMessages(task.chat_jid, '', 10);
    expect(history.map((message) => message.content)).toEqual([
      '[Document: report.pdf]',
    ]);
  });

  it('задача без прав владельца ничего не прикладывает и путь не показывает', async () => {
    const report = path.join(groupRoot(), 'report.pdf');
    fs.writeFileSync(report, 'pdf');
    const sendDocument = vi.fn().mockResolvedValue(true);
    const text = await attachTaskLocalFileLinks({
      router: { sendDocument } as never,
      task,
      ownerAuthorized: false,
      text: `[отчёт](${report})`,
    });
    expect(text).toBe('отчёт (файл «report.pdf»)');
    expect(sendDocument).not.toHaveBeenCalled();
  });

  it('ошибка разбора не отменяет доставку: текст уходит как был', async () => {
    const text = '[отчёт](/Users/example/report.pdf)';
    await expect(
      attachTaskLocalFileLinks({
        router: { sendDocument: vi.fn() } as never,
        task: { ...task, group_folder: '../escape' },
        ownerAuthorized: true,
        text,
      }),
    ).resolves.toBe(text);
  });

  it('runTask отдаёт в чат уже переписанный результат', async () => {
    const report = path.join(groupRoot(), 'report.pdf');
    fs.writeFileSync(report, 'pdf');
    createTask({
      id: 'task-local-links-run',
      group_folder: task.group_folder,
      chat_jid: task.chat_jid,
      prompt: 'сводка',
      schedule_type: 'once',
      schedule_value: '2026-10-26T10:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-10-26T09:00:00.000Z',
    });
    runnerMocks.runSandboxAgent.mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: `Готово: [отчёт](${report})`,
        });
        return { status: 'success', result: null };
      },
    );
    const route = vi.fn().mockResolvedValue('ok');
    const sendDocument = vi.fn().mockResolvedValue(true);
    await runTask(getTaskById('task-local-links-run')!, {
      registeredGroups: () => ({
        [task.chat_jid]: {
          name: 'Links',
          folder: task.group_folder,
          trigger: '@Skoobi',
          added_at: '2026-10-26T09:00:00.000Z',
          runtime: 'sandbox',
        },
      }),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route,
        send: async () => {},
        sendDocument,
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });
    // Not a main chat: the name stays, the path never reaches the chat.
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Готово: отчёт (файл «report.pdf»)' }),
    );
    expect(sendDocument).not.toHaveBeenCalled();
  });
});

describe('плановая задача и Google (SCHED-2)', () => {
  it('распознаёт задачи, которые просят Google', () => {
    expect(taskPromptRequestsGoogle('внеси смену в Google-таблицу')).toBe(true);
    expect(taskPromptRequestsGoogle('проверь почту')).toBe(true);
    expect(taskPromptRequestsGoogle('добавь событие в календарь')).toBe(true);
    expect(taskPromptRequestsGoogle('напомни выпить воды')).toBe(false);
    expect(taskPromptRequestsGoogle('собери сводку по продажам')).toBe(false);
  });
});

describe('task scheduler', () => {
  it('uses canonical Telegram chat ids for scheduled provider metadata', () => {
    expect(scheduledTaskChatId('tg:bot=123456:-100777')).toBe('-100777');
    expect(scheduledTaskChatId('tg:skoobi_friend:-100888')).toBe('-100888');
    expect(scheduledTaskChatId('tg:12345:67890')).toBe('12345');
  });

  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    runnerMocks.runContainerAgent.mockReset();
    runnerMocks.runSandboxAgent.mockReset();
    runnerMocks.writeTasksSnapshot.mockReset();
    runnerMocks.createModelGateway.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReset();
    // Absolute command path keeps resolveCodexCommandPath from shelling out
    // to `which` inside tests.
    runnerMocks.loadModelGatewayConfig.mockReturnValue({
      codex: {
        command: '/opt/homebrew/bin/codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'xhigh',
        webSearchEnabled: true,
      },
    });
    process.env.CLAUDECLAW_ENV_FILE = '/tmp/skoobi-task-scheduler-test.env';
    delete process.env.SKOOBI_CODEX_RESERVE_FALLBACK_ENABLED;
    delete process.env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CLAUDECLAW_ENV_FILE;
    delete process.env.SKOOBI_CODEX_RESERVE_FALLBACK_ENABLED;
    delete process.env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY;
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
        return true; // real enqueueTask returns true when the dispatch is accepted
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask, hasTask: () => false } as any,
      onProcess: () => {},
      router: {
        route: async () => {},
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('pauses due tasks whose group is unregistered to prevent busy-looping every poll', async () => {
    createTask({
      id: 'task-missing-group',
      group_folder: 'telegram_main',
      chat_jid: 'tg:7000000002',
      prompt: 'run scheduled task',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-10T09:00:00.000Z',
    });

    // Group is NOT in registeredGroups() — the 'group not found' branch.
    await runTask(getTaskById('task-missing-group')!, {
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route: vi.fn(),
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });

    // Neither runtime should have been invoked — the task bailed before running.
    expect(runnerMocks.runSandboxAgent).not.toHaveBeenCalled();
    expect(runnerMocks.runContainerAgent).not.toHaveBeenCalled();

    // Must be paused so getDueTasks() (status='active' AND next_run<=now)
    // no longer re-selects it every poll forever.
    const task = getTaskById('task-missing-group');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun returns null for an unparseable cron expression instead of throwing', () => {
    // A legacy/manually-edited row with a malformed cron value must NOT throw
    // out of the post-run bookkeeping path (that would strand next_run and spin
    // a re-execution loop). It completes the task instead (next_run = null).
    const task = {
      id: 'bad-cron',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'cron' as const,
      schedule_value: 'not a cron at all',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(() => computeNextRun(task)).not.toThrow();
    expect(computeNextRun(task)).toBeNull();
    // And the post-run wrapper must also not throw and must complete the task.
    expect(() => computeNextRunAfterTaskAttempt(task, true)).not.toThrow();
    expect(computeNextRunAfterTaskAttempt(task, false)).toBeNull();
  });

  it('computeNextRun still advances a valid cron expression', () => {
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();
    vi.setSystemTime(base);
    const task = {
      id: 'good-cron',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'cron' as const,
      schedule_value: '0 * * * *', // top of every hour
      context_mode: 'isolated' as const,
      next_run: new Date(base).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Next top-of-hour after 00:00 UTC is 01:00 UTC.
    expect(new Date(nextRun!).getTime()).toBe(base + 60 * 60 * 1000);
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('uses sandbox runtime for scheduled tasks when the group requests it', async () => {
    createTask({
      id: 'task-sandbox',
      group_folder: 'telegram_main',
      chat_jid: 'tg:7000000002',
      prompt: 'run scheduled task',
      schedule_type: 'once',
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-10T09:00:00.000Z',
    });

    runnerMocks.runSandboxAgent.mockImplementation(
      async (_group, input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'scheduled result',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-1',
        };
      },
    );
    const route = vi.fn().mockResolvedValue(undefined);

    await runTask(getTaskById('task-sandbox')!, {
      registeredGroups: () => ({
        'tg:7000000002': {
          name: 'User A',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
          agentConfig: { model: 'test-model' },
        },
      }),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route,
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });

    expect(runnerMocks.runSandboxAgent).toHaveBeenCalledTimes(1);
    expect(runnerMocks.runContainerAgent).not.toHaveBeenCalled();
    expect(runnerMocks.runSandboxAgent.mock.calls[0][1]).toMatchObject({
      prompt: 'run scheduled task',
      groupFolder: 'telegram_main',
      chatJid: 'tg:7000000002',
      isScheduledTask: true,
      agentConfig: { model: 'test-model' },
    });
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'tg:7000000002',
        text: 'scheduled result',
        triggerType: 'task-result',
      }),
    );
    expect(getTaskById('task-sandbox')?.status).toBe('completed');
  });

  it('restores owner runtime only for a host-authorized owner-created main task', async () => {
    const base = {
      group_folder: 'telegram_main',
      chat_jid: 'tg:-100123',
      prompt: 'run main scheduled task',
      schedule_type: 'once' as const,
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'group' as const,
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active' as const,
      created_at: '2026-05-10T09:00:00.000Z',
    };
    createTask({
      ...base,
      id: 'task-owner-provenance',
      creator_authorization: 'owner_sender',
      creator_identity_id: 'telegram:owner',
      creator_sender_id: '100000001',
    });
    createTask({ ...base, id: 'task-legacy-no-provenance' });
    runnerMocks.runSandboxAgent.mockResolvedValue({
      status: 'success',
      result: 'done',
    });
    const deps = {
      registeredGroups: () => ({
        'tg:-100123': {
          name: 'Main',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox' as const,
          isMain: true,
          agentConfig: { fullAccess: true, noSandbox: true },
        },
      }),
      getSessions: () => ({ telegram_main: 'owner-session-123' }),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route: vi.fn().mockResolvedValue(undefined),
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    };

    await runTask(getTaskById('task-owner-provenance')!, deps);
    await runTask(getTaskById('task-legacy-no-provenance')!, deps);

    expect(runnerMocks.runSandboxAgent.mock.calls[0][1]).toMatchObject({
      isMain: true,
      credentialProxyTier: 'owner',
      sessionId: 'owner-session-123',
      senderIdentity: {
        telegram_user_id: '100000001',
        identity_id: 'telegram:owner',
        is_owner_sender: true,
      },
      taskAuthorizationCapability: expect.stringMatching(
        /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      ),
    });
    expect(runnerMocks.runSandboxAgent.mock.calls[1][1]).toMatchObject({
      isMain: true,
      credentialProxyTier: 'guest',
    });
    expect(
      runnerMocks.runSandboxAgent.mock.calls[1][1].sessionId,
    ).toBeUndefined();
    expect(
      runnerMocks.runSandboxAgent.mock.calls[1][1].taskAuthorizationCapability,
    ).toBeUndefined();
    expect(runnerMocks.writeTasksSnapshot.mock.calls[0][1]).toBe(true);
    expect(runnerMocks.writeTasksSnapshot.mock.calls[1][1]).toBe(false);
    expect(runnerMocks.writeTasksSnapshot.mock.calls[1][2]).toEqual([]);
  });

  it('routes a durably owner-authorized main sandbox task through Codex primary', async () => {
    process.env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY = 'true';
    createTask({
      id: 'task-codex-primary',
      group_folder: 'telegram_main',
      chat_jid: 'tg:7000000002',
      prompt: 'send the morning digest',
      schedule_type: 'once',
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-10T09:00:00.000Z',
      creator_authorization: 'owner_sender',
      creator_identity_id: 'telegram:owner',
      creator_sender_id: '100000001',
    });

    runnerMocks.runSandboxAgent.mockImplementation(
      async (_group, input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'codex task result',
        });
        return {
          status: 'success',
          result: null,
        };
      },
    );
    const route = vi.fn().mockResolvedValue(undefined);

    await runTask(getTaskById('task-codex-primary')!, {
      registeredGroups: () => ({
        'tg:7000000002': {
          name: 'User A',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
          isMain: true,
          agentConfig: {
            model: 'test-model',
            codexTurnTimeoutMs: 45 * 60 * 1000,
            // Message-turn-only settings: must not touch scheduled tasks.
            codexTurnInactivityMs: 600_000,
            codexTurnMaxMs: 90 * 60 * 1000,
          },
        },
      }),
      // A live Claude session exists for the group; the codex run must NOT
      // resume (or rotate) it.
      getSessions: () => ({ telegram_main: 'claude-session-123' }),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route,
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });

    expect(runnerMocks.runSandboxAgent).toHaveBeenCalledTimes(1);
    const input = runnerMocks.runSandboxAgent.mock.calls[0][1];
    expect(input.provider).toBe('codex_cli');
    expect(input.credentialProxyTier).toBe('owner');
    expect(input.codex).toMatchObject({
      command: '/opt/homebrew/bin/codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      webSearchEnabled: true,
      timeoutMs: 45 * 60 * 1000,
    });
    // A scheduled task has no idle stop: only codexTurnTimeoutMs ends it.
    expect(input.codex.inactivityTimeoutMs).toBeUndefined();
    expect(input.codex.inactivityInFlightTimeoutMs).toBeUndefined();
    expect(input.sessionId).toBeUndefined();
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'tg:7000000002',
        text: 'codex task result',
        triggerType: 'task-result',
      }),
    );
    expect(getTaskById('task-codex-primary')?.status).toBe('completed');
  });

  it('writes the scheduled run to agent_runs with the runner\'s tokens, requests and model', async () => {
    // task-scheduler imports run-telemetry (which owns agent_runs);
    // _initTestDatabase builds the DB without extension schemas, so apply
    // them here the way production does.
    for (const sql of getExtensionDbSchema()) getDb().exec(sql);
    process.env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY = 'true';
    const taskBase = {
      group_folder: 'telegram_admin',
      chat_jid: 'tg:100999',
      prompt: 'send the morning digest',
      schedule_type: 'once' as const,
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'group' as const,
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active' as const,
      created_at: '2026-05-10T09:00:00.000Z',
      creator_authorization: 'owner_sender' as const,
      creator_identity_id: 'telegram:owner',
      creator_sender_id: '100000001',
    };
    createTask({ id: 'task-accounted', ...taskBase });
    createTask({ id: 'task-accounted-failed', ...taskBase });
    const deps = {
      registeredGroups: () => ({
        'tg:100999': {
          name: 'Admin',
          folder: 'telegram_admin',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox' as const,
          isMain: true,
          agentConfig: { model: 'test-model' },
        },
      }),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route: vi.fn().mockResolvedValue('codex task result'),
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    };

    // The runner reports the turn on its streamed success frame, as the
    // codex loop does: the delta of the thread totals, requests as turns.
    runnerMocks.runSandboxAgent.mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'codex task result',
          usage: { inputTokens: 350, outputTokens: 30, cacheReadInputTokens: 270 },
          turns: 3,
          codexTurn: {
            usageSource: 'turn_delta',
            modelRequests: 3,
            serviceTier: null,
            reasoningEffort: 'xhigh',
            accountUsedPercent: 48.5,
            toolCalls: { exec_command: 2 },
          },
        });
        return { status: 'success', result: null };
      },
    );
    await runTask(getTaskById('task-accounted')!, deps);
    const runs = () =>
      getDb()
        .prepare('SELECT * FROM agent_runs ORDER BY id ASC')
        .all() as Array<Record<string, unknown>>;
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({
      group_folder: 'telegram_admin',
      chat_jid: 'tg:100999',
      trigger_type: 'scheduled',
      input_tokens: 350,
      output_tokens: 30,
      cache_read_tokens: 270,
      turns: 3,
      model: 'codex-subscription',
      status: 'success',
    });
    expect(Number(runs()[0].duration_ms)).toBeGreaterThanOrEqual(0);

    // A failed run is a row too — the error share of scheduled runs is what
    // the morning review asks agent_runs for.
    runnerMocks.runSandboxAgent.mockImplementationOnce(async () => ({
      status: 'error',
      result: null,
      error: 'codex turn timed out after 900000ms',
    }));
    await runTask(getTaskById('task-accounted-failed')!, deps);
    expect(runs()).toHaveLength(2);
    expect(runs()[1]).toMatchObject({
      trigger_type: 'scheduled',
      input_tokens: 0,
      turns: 0,
      status: 'error',
    });


    // down as 0): the runner's error frame carries them, and so does the row.
    createTask({ id: 'task-accounted-capped', ...taskBase });
    runnerMocks.runSandboxAgent.mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'error',
          result: null,
          error: 'codex turn timed out after 1800000ms',
          usage: { inputTokens: 22_400_000, outputTokens: 110_000, cacheReadInputTokens: 21_000_000 },
          turns: 61,
          codexTurn: { usageSource: 'turn_delta', modelRequests: 61 },
        });
        return { status: 'error', result: null, error: 'Sandbox exited with code 1' };
      },
    );
    await runTask(getTaskById('task-accounted-capped')!, deps);
    expect(runs()).toHaveLength(3);
    expect(runs()[2]).toMatchObject({
      trigger_type: 'scheduled',
      input_tokens: 22_400_000,
      output_tokens: 110_000,
      cache_read_tokens: 21_000_000,
      turns: 61,
      status: 'error',
    });
  });

  it('keeps guest and unproven main sandbox tasks off Codex primary', async () => {
    process.env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY = 'true';
    const taskBase = {
      prompt: 'run scheduled task',
      schedule_type: 'once' as const,
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active' as const,
      created_at: '2026-05-10T09:00:00.000Z',
    };
    createTask({
      ...taskBase,
      id: 'task-codex-guest-guard',
      group_folder: 'guest_example',
      chat_jid: 'tg:7000000002',
      // Even a row carrying owner-looking provenance cannot authorize a
      // non-main group.
      creator_authorization: 'owner_sender',
      creator_identity_id: 'telegram:owner',
      creator_sender_id: '100000001',
    });
    createTask({
      ...taskBase,
      id: 'task-codex-unproven-main-guard',
      group_folder: 'telegram_main',
      chat_jid: 'tg:-100123',
    });
    runnerMocks.runSandboxAgent.mockResolvedValue({
      status: 'success',
      result: 'claude result',
    });
    const deps = {
      registeredGroups: () => ({
        'tg:7000000002': {
          name: 'Guest',
          folder: 'guest_example',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox' as const,
          agentConfig: { model: 'test-model' },
        },
        'tg:-100123': {
          name: 'Main',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox' as const,
          isMain: true,
          agentConfig: { model: 'test-model' },
        },
      }),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route: vi.fn().mockResolvedValue(undefined),
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    };

    await runTask(getTaskById('task-codex-guest-guard')!, deps);
    await runTask(getTaskById('task-codex-unproven-main-guard')!, deps);

    expect(runnerMocks.runSandboxAgent).toHaveBeenCalledTimes(2);
    for (const [, input] of runnerMocks.runSandboxAgent.mock.calls) {
      expect(input.credentialProxyTier).toBe('guest');
      expect(input.provider).toBeUndefined();
      expect(input.codex).toBeUndefined();
    }
    expect(runnerMocks.loadModelGatewayConfig).not.toHaveBeenCalled();
  });

  it('keeps the Claude SDK path for scheduled tasks when codex-primary is off', async () => {
    createTask({
      id: 'task-claude-default',
      group_folder: 'telegram_main',
      chat_jid: 'tg:7000000002',
      prompt: 'run scheduled task',
      schedule_type: 'once',
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-10T09:00:00.000Z',
    });

    runnerMocks.runSandboxAgent.mockResolvedValue({
      status: 'success',
      result: 'claude result',
    });

    await runTask(getTaskById('task-claude-default')!, {
      registeredGroups: () => ({
        'tg:7000000002': {
          name: 'User A',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
          agentConfig: { model: 'test-model' },
        },
      }),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route: vi.fn().mockResolvedValue(undefined),
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });

    expect(runnerMocks.runSandboxAgent).toHaveBeenCalledTimes(1);
    const input = runnerMocks.runSandboxAgent.mock.calls[0][1];
    expect(input.provider).toBeUndefined();
    expect(input.codex).toBeUndefined();
  });

  it('does not engage the codex provider on the container runtime even when codex-primary is on', async () => {
    process.env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY = 'true';
    createTask({
      id: 'task-container-guard',
      group_folder: 'telegram_main',
      chat_jid: 'tg:7000000002',
      prompt: 'run scheduled task',
      schedule_type: 'once',
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-10T09:00:00.000Z',
    });

    runnerMocks.runContainerAgent.mockResolvedValue({
      status: 'success',
      result: 'container result',
    });

    await runTask(getTaskById('task-container-guard')!, {
      registeredGroups: () => ({
        'tg:7000000002': {
          name: 'User A',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'container',
          agentConfig: { model: 'test-model' },
        },
      }),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route: vi.fn().mockResolvedValue(undefined),
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });

    expect(runnerMocks.runContainerAgent).toHaveBeenCalledTimes(1);
    expect(runnerMocks.runSandboxAgent).not.toHaveBeenCalled();
    const input = runnerMocks.runContainerAgent.mock.calls[0][1];
    expect(input.provider).toBeUndefined();
    expect(input.codex).toBeUndefined();
  });

  it('uses Codex reserve fallback for scheduled tasks when Claude hits its limit', async () => {
    process.env.SKOOBI_CODEX_RESERVE_FALLBACK_ENABLED = 'true';
    createTask({
      id: 'task-claude-limit',
      group_folder: 'telegram_main',
      chat_jid: 'tg:100000001',
      prompt: 'run scheduled task',
      schedule_type: 'once',
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-10T09:00:00.000Z',
      creator_authorization: 'owner_sender',
      creator_identity_id: 'telegram:owner',
      creator_sender_id: '100000001',
    });
    const complete = vi.fn().mockResolvedValue({
      text: 'codex scheduled result',
      tool_calls: [],
    });
    runnerMocks.createModelGateway.mockReturnValue({ complete });
    runnerMocks.runSandboxAgent.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'error',
          result: "You've hit your limit · resets Jun 9 at 1am (Asia/Almaty)",
          error: 'Claude limit',
        });
        return {
          status: 'error',
          result: null,
          error:
            "Sandbox exited with code 1: type=success text=You've hit your limit",
          newSessionId: 's1',
        };
      },
    );
    const route = vi.fn().mockResolvedValue(undefined);

    await runTask(getTaskById('task-claude-limit')!, {
      registeredGroups: () => ({
        'tg:100000001': {
          name: 'Admin',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route,
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model_role: 'owner',
        metadata: expect.objectContaining({
          channel: 'telegram',
          chat_id: '100000001',
          sender_id: 'scheduled_task',
          task_type: 'chat',
        }),
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: 'run scheduled task',
          }),
        ]),
      }),
    );
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0][0]).toMatchObject({
      chatJid: 'tg:100000001',
      text: 'codex scheduled result',
      triggerType: 'task-result',
      meta: { kind: 'codex_reserve_task_result' },
    });
    expect(JSON.stringify(route.mock.calls)).not.toContain(
      "You've hit your limit",
    );
    expect(getTaskById('task-claude-limit')?.status).toBe('completed');
  });

  it('does not leak raw Claude limit text when scheduled task reserve fallback fails', async () => {
    process.env.SKOOBI_CODEX_RESERVE_FALLBACK_ENABLED = 'true';
    createTask({
      id: 'task-claude-limit-codex-fails',
      group_folder: 'telegram_main',
      chat_jid: 'tg:100000001',
      prompt: 'run scheduled task',
      schedule_type: 'once',
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-10T09:00:00.000Z',
    });
    runnerMocks.createModelGateway.mockReturnValue({
      complete: vi.fn().mockRejectedValue(new Error('Codex unavailable')),
    });
    runnerMocks.runSandboxAgent.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'error',
          result: "You've hit your limit · resets Jun 9 at 1am (Asia/Almaty)",
          error: 'Claude limit',
        });
        return {
          status: 'error',
          result: null,
          error: "You've hit your limit",
          newSessionId: 's1',
        };
      },
    );
    const route = vi.fn().mockResolvedValue(undefined);

    await runTask(getTaskById('task-claude-limit-codex-fails')!, {
      registeredGroups: () => ({
        'tg:100000001': {
          name: 'Admin',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route,
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });

    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0][0].text).toContain(
      'основной и резервный AI-путь',
    );
    expect(JSON.stringify(route.mock.calls)).not.toContain(
      "You've hit your limit",
    );
    const task = getTaskById('task-claude-limit-codex-fails');
    expect(task?.status).toBe('active');
    expect(task?.next_run).toBeTruthy();
  });

  it('keeps the limit fallback on the Claude path when the reserve is off', async () => {
    createTask({
      id: 'task-claude-limit-no-reserve',
      group_folder: 'telegram_main',
      chat_jid: 'tg:100000001',
      prompt: 'run scheduled task',
      schedule_type: 'once',
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-10T09:00:00.000Z',
      creator_authorization: 'owner_sender',
      creator_identity_id: 'telegram:owner',
      creator_sender_id: '100000001',
    });
    runnerMocks.runSandboxAgent.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'API Error: 429 rate limit exceeded',
        });
        return { status: 'success', result: null };
      },
    );
    const route = vi.fn().mockResolvedValue(undefined);

    await runTask(getTaskById('task-claude-limit-no-reserve')!, {
      registeredGroups: () => ({
        'tg:100000001': {
          name: 'Admin',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route,
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });

    expect(runnerMocks.runSandboxAgent.mock.calls[0][1].provider).toBe(
      undefined,
    );
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0][0].text).toContain(
      'основной и резервный AI-путь',
    );
    expect(runnerMocks.createModelGateway).not.toHaveBeenCalled();
    const log = getDb()
      .prepare(
        'SELECT status, error FROM task_run_logs WHERE task_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get('task-claude-limit-no-reserve') as { status: string; error: string };
    expect(log.status).toBe('error');
    expect(log.error).toBe(
      'Primary scheduled-task runtime limit reached and reserve provider disabled',
    );
  });

  it('delivers a Codex-primary result that only mentions a limit, reserve or not', async () => {
    process.env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY = 'true';
    process.env.SKOOBI_CODEX_RESERVE_FALLBACK_ENABLED = 'true';
    createTask({
      id: 'task-codex-mentions-limit',
      group_folder: 'telegram_main',
      chat_jid: 'tg:100000001',
      prompt: 'run scheduled task',
      schedule_type: 'once',
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-10T09:00:00.000Z',
      creator_authorization: 'owner_sender',
      creator_identity_id: 'telegram:owner',
      creator_sender_id: '100000001',
    });
    const answer =
      "Учебный пример: Codex ответил «You've hit your usage limit» (HTTP 429, rate limit), затем ограничение снялось.";
    runnerMocks.runSandboxAgent.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({ status: 'success', result: answer });
        return { status: 'success', result: null };
      },
    );
    const route = vi.fn().mockResolvedValue(undefined);

    await runTask(getTaskById('task-codex-mentions-limit')!, {
      registeredGroups: () => ({
        'tg:100000001': {
          name: 'Admin',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route,
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });

    expect(runnerMocks.runSandboxAgent.mock.calls[0][1].provider).toBe(
      'codex_cli',
    );
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0][0]).toMatchObject({
      text: answer,
      triggerType: 'task-result',
    });
    expect(route.mock.calls[0][0].meta).toBeUndefined();
    // No reserve rerun either: the answer was never a limit banner.
    expect(runnerMocks.createModelGateway).not.toHaveBeenCalled();
    const log = getDb()
      .prepare(
        'SELECT status, result, error FROM task_run_logs WHERE task_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get('task-codex-mentions-limit') as {
      status: string;
      result: string;
      error: string | null;
    };
    expect(log).toEqual({ status: 'success', result: answer, error: null });
    expect(getTaskById('task-codex-mentions-limit')?.status).toBe('completed');
  });

  it('skips post-run bookkeeping when the task self-cancels mid-run (no FK violation)', async () => {
    createTask({
      id: 'task-self-cancel',
      group_folder: 'telegram_main',
      chat_jid: 'tg:7000000002',
      prompt: 'run scheduled task',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-10T09:00:00.000Z',
    });

    // Simulate a self-polling task that calls cancel_task during its own run:
    // the scheduled_tasks row is gone by the time runTask does its post-run
    // logTaskRun INSERT (which has a FK to scheduled_tasks).
    runnerMocks.runSandboxAgent.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        deleteTask('task-self-cancel');
        await onOutput?.({ status: 'success', result: 'done' });
        return { status: 'success', result: null, newSessionId: 's1' };
      },
    );

    await expect(
      runTask(getTaskById('task-self-cancel')!, {
        registeredGroups: () => ({
          'tg:7000000002': {
            name: 'User A',
            folder: 'telegram_main',
            trigger: '@Skoobi',
            added_at: '2026-05-10T09:00:00.000Z',
            runtime: 'sandbox',
          },
        }),
        getSessions: () => ({}),
        queue: taskQueueMock(),
        onProcess: vi.fn(),
        router: {
          route: vi.fn(),
          send: async () => {},
          addPreHook: () => {},
          addPostHook: () => {},
        } as any,
      }),
    ).resolves.toBeUndefined();

    // Task stays deleted, and no orphan log row was written for it.
    expect(getTaskById('task-self-cancel')).toBeUndefined();
    const logCount = getDb()
      .prepare('SELECT COUNT(*) AS c FROM task_run_logs WHERE task_id = ?')
      .get('task-self-cancel') as { c: number };
    expect(logCount.c).toBe(0);
  });

  it('logs the run but keeps status cancelled when the task is soft-cancelled mid-run', async () => {
    createTask({
      id: 'task-soft-cancel',
      group_folder: 'telegram_admin',
      chat_jid: 'tg:100999',
      prompt: 'run scheduled task',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-10T09:00:00.000Z',
    });

    // status 'cancelled' and next_run NULL (T2/C3).
    runnerMocks.runSandboxAgent.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        updateTask('task-soft-cancel', { status: 'cancelled', next_run: null });
        await onOutput?.({ status: 'success', result: 'done' });
        return { status: 'success', result: null, newSessionId: 's1' };
      },
    );
    const route = vi.fn().mockResolvedValue('done');

    await runTask(getTaskById('task-soft-cancel')!, {
      registeredGroups: () => ({
        'tg:100999': {
          name: 'Admin',
          folder: 'telegram_admin',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
        },
      }),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route,
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });

    // The run is history; the status is not rewritten and no interval is
    // re-armed (a cron/interval task would otherwise get a new next_run).
    expect(getTaskById('task-soft-cancel')).toMatchObject({
      status: 'cancelled',
      next_run: null,
    });
    const runs = getDb()
      .prepare('SELECT status FROM task_run_logs WHERE task_id = ?')
      .all('task-soft-cancel');
    expect(runs).toEqual([{ status: 'success' }]);
    // No failure notice either: the only delivery is the result itself.
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('says so at INFO when the whole result was <internal> and nothing reached the chat', async () => {
    createTask({
      id: 'task-internal-only',
      group_folder: 'telegram_admin',
      chat_jid: 'tg:100999',
      prompt: 'тестовый пост test channel',
      schedule_type: 'once',
      schedule_value: '2026-10-01T15:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-09-28T09:00:00.000Z',
    });
    const internalResult =
      '<internal>Пост не опубликован: Telegram не открыл сведения о канале.</internal>';
    runnerMocks.runSandboxAgent.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({ status: 'success', result: internalResult });
        return { status: 'success', result: internalResult, newSessionId: 's1' };
      },
    );
    const infoSpy = vi.spyOn(logger, 'info');
    const deps = (route: ReturnType<typeof vi.fn>) =>
      ({
        registeredGroups: () => ({
          'tg:100999': {
            name: 'Admin',
            folder: 'telegram_admin',
            trigger: '@Skoobi',
            added_at: '2026-05-10T09:00:00.000Z',
            runtime: 'sandbox',
          },
        }),
        getSessions: () => ({}),
        queue: taskQueueMock(),
        onProcess: vi.fn(),
        router: {
          route,
          send: async () => {},
          addPreHook: () => {},
          addPostHook: () => {},
        } as any,
      }) as Parameters<typeof runTask>[1];

    try {
      // The real router strips <internal> and returns null for such text.
      await runTask(
        getTaskById('task-internal-only')!,
        deps(vi.fn().mockResolvedValue(null)),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        { taskId: 'task-internal-only', group: 'telegram_admin' },
        'Task result fully internal, nothing delivered',
      );

      // A visible result that was delivered does not trigger the line.
      infoSpy.mockClear();
      runnerMocks.runSandboxAgent.mockImplementation(
        async (_group, _input, _onProcess, onOutput) => {
          await onOutput?.({ status: 'success', result: 'видимая строка' });
          return { status: 'success', result: 'видимая строка', newSessionId: 's1' };
        },
      );
      createTask({
        id: 'task-visible',
        group_folder: 'telegram_admin',
        chat_jid: 'tg:100999',
        prompt: 'видимый пост',
        schedule_type: 'once',
        schedule_value: '2026-10-01T15:00:00.000Z',
        context_mode: 'isolated',
        next_run: new Date(Date.now() - 60_000).toISOString(),
        status: 'active',
        created_at: '2026-09-28T09:00:00.000Z',
      });
      await runTask(
        getTaskById('task-visible')!,
        deps(vi.fn().mockResolvedValue('видимая строка')),
      );
      expect(infoSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        'Task result fully internal, nothing delivered',
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('keeps failed one-off tasks active for a retry instead of losing them', async () => {
    createTask({
      id: 'task-once-fails',
      group_folder: 'telegram_main',
      chat_jid: 'tg:7000000002',
      prompt: 'run scheduled task',
      schedule_type: 'once',
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-10T09:00:00.000Z',
    });
    runnerMocks.runSandboxAgent.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'spawn failed',
    });

    await runTask(getTaskById('task-once-fails')!, {
      registeredGroups: () => ({
        'tg:7000000002': {
          name: 'User A',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
        },
      }),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route: vi.fn(),
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });

    const task = getTaskById('task-once-fails');
    expect(task?.status).toBe('active');
    expect(task?.next_run).toBeTruthy();
    expect(task?.last_result).toBe('Error: spawn failed');
  });

  it('delivers a failure notice to the chat when a run fails with no output', async () => {
    createTask({
      id: 'task-silent-fail',
      group_folder: 'telegram_main',
      chat_jid: 'tg:7000000002',
      prompt: 'напомнить проверить тестовый стенд',
      schedule_type: 'once',
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-10T09:00:00.000Z',
    });
    runnerMocks.runSandboxAgent.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'spawn failed',
    });
    const route = vi.fn().mockResolvedValue(undefined);

    await runTask(getTaskById('task-silent-fail')!, {
      registeredGroups: () => ({
        'tg:7000000002': {
          name: 'User A',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
        },
      }),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route,
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });

    // The failed run produced no user-visible output — the notice is the only
    // delivery, marked so hooks can distinguish it from a real task result.
    expect(route).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'tg:7000000002',
        triggerType: 'task-result',
        groupFolder: 'telegram_main',
        meta: { kind: 'task_failure_notice' },
      }),
    );
    const text = route.mock.calls[0][0].text as string;
    expect(text).toContain('⚠️');
    expect(text).toContain('spawn failed');
    // A reminder's notice carries the reminder itself (C34).
    expect(text).toContain('вот оно: «проверить тестовый стенд»');
    // once-task failure keeps a retry (next_run set) → the notice promises one
    expect(text).toContain('Попробую снова по расписанию.');
  });

  it.each([
    { sideEffected: false, result: null, rejectDelivery: false },
    { sideEffected: true, result: null, rejectDelivery: false },
    { sideEffected: false, result: 'nonempty failed output', rejectDelivery: false },
    { sideEffected: true, result: 'nonempty failed output', rejectDelivery: false },
    { sideEffected: true, result: 'nonempty failed output', rejectDelivery: true },
  ])('pauses guarded failures and announces terminal state ($sideEffected/$result/$rejectDelivery)', async ({ sideEffected, result, rejectDelivery }) => {
    const id = 'audit-retry-budget';
    const jid = 'tg:12345';
    createTask({
      id, group_folder: 'audit_scheduler', chat_jid: jid, prompt: 'test reminder',
      schedule_type: 'once', schedule_value: new Date().toISOString(), context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(), status: 'active', created_at: new Date().toISOString(),
    });
    runnerMocks.runSandboxAgent.mockResolvedValue({ status: 'error', result, error: 'test failure', sideEffected });
    const route = vi.fn().mockResolvedValue(undefined);
    if (rejectDelivery) route.mockRejectedValue(new Error('synthetic delivery unavailable'));
    const deps = {
      registeredGroups: () => ({ [jid]: { name: 'Test', folder: 'audit_scheduler', trigger: '@Skoobi', added_at: new Date().toISOString(), runtime: 'sandbox' as const } }),
      getSessions: () => ({}), queue: taskQueueMock(), onProcess: vi.fn(),
      router: { route, send: async () => {}, addPreHook: () => {}, addPostHook: () => {} } as any,
    };
    for (let i = 0; i < (sideEffected ? 1 : 5); i++) await runTask(getTaskById(id)!, deps);
    expect(getTaskById(id)?.status).toBe('paused');
    expect(getTaskById(id)?.next_run).toBeNull();
    expect(route.mock.calls.at(-1)?.[0].text).toContain(sideEffected ? 'внешнее действие могло уже выполниться' : 'поставлена на паузу');
  });

  it('retries failed once-tasks with a bounded increasing delay', () => {
    const now = new Date('2026-05-10T05:00:00.000Z').getTime();
    const task = {
      id: 'once-retry',
      group_folder: 'telegram_main',
      chat_jid: 'tg:7000000002',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(now - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-05-10T09:00:00.000Z',
    };

    expect(computeNextRunAfterTaskAttempt(task, true, now)).toBe(
      '2026-05-10T05:05:00.000Z',
    );
    expect(computeNextRunAfterTaskAttempt(task, false, now)).toBeNull();
    expect(computeNextRunAfterTaskAttempt(task, true, now, 2)).toBe('2026-05-10T05:10:00.000Z');
    expect(computeNextRunAfterTaskAttempt(task, true, now, 4)).toBe('2026-05-10T05:40:00.000Z');
    expect(computeNextRunAfterTaskAttempt(task, true, now, 5)).toBeNull();
  });

  // --- L4: computeNextRun must not spin on a null/invalid next_run ---

  it('computeNextRun anchors a null next_run interval task to now without spinning', () => {
    const task = {
      id: 'null-next-run',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 60s
      context_mode: 'isolated' as const,
      next_run: null, // the dangerous case: new Date(null).getTime() === 0
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const before = Date.now();
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Anchored to ~now + ms, NOT to (epoch + ms) which would mean a 1970 date
    // produced after ~28M loop iterations.
    const t = new Date(nextRun!).getTime();
    expect(t).toBe(before + 60000);
    // Sanity: it is firmly in the present era, never near the epoch.
    expect(t).toBeGreaterThan(new Date('2026-01-01T00:00:00.000Z').getTime());
  });

  it('computeNextRun handles an unparseable next_run for an interval task', () => {
    const task = {
      id: 'bad-next-run',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '30000',
      context_mode: 'isolated' as const,
      next_run: 'not-a-date',
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const before = Date.now();
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    expect(new Date(nextRun!).getTime()).toBe(before + 30000);
  });

  it('computeNextRun returns a near-future slot for a long-past anchor in O(1)', () => {
    // 100 years in the past: with the old ms-stepping loop this would be tens
    // of billions of iterations. The result must still be grid-aligned and
    // strictly in the future.
    const ms = 60000;
    const base = new Date('1926-01-01T00:00:00.000Z').getTime();
    const task = {
      id: 'ancient-anchor',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: new Date(base).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '1926-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const t = new Date(nextRun!).getTime();
    expect(t).toBeGreaterThan(Date.now());
    expect((t - base) % ms).toBe(0);
  });

  // --- M3: DB-level in-flight lease prevents duplicate execution ---

  it('claimTaskForRun grants a lease once and denies a concurrent claim', () => {
    const now = 1_000_000;
    expect(claimTaskForRun('lease-task', now)).toBe(true);
    // A second claim while the lease is live must be denied — this is the
    // restart/double-poll duplicate-execution guard.
    expect(claimTaskForRun('lease-task', now + 1000)).toBe(false);
  });

  it('releaseTaskLease frees the task for re-claim', () => {
    const now = 2_000_000;
    expect(claimTaskForRun('release-task', now)).toBe(true);
    expect(claimTaskForRun('release-task', now)).toBe(false);
    releaseTaskLease('release-task');
    expect(claimTaskForRun('release-task', now)).toBe(true);
  });

  it('claimTaskForRun reclaims an orphaned (expired) lease', () => {
    const now = 3_000_000;
    expect(claimTaskForRun('orphan-task', now)).toBe(true);
    // Far enough past the TTL (CONTAINER_TIMEOUT + 5m, < 1h) that the lease is
    // presumed orphaned by a crashed process and may be reclaimed.
    const wayLater = now + 3 * 60 * 60 * 1000; // +3h
    expect(claimTaskForRun('orphan-task', wayLater)).toBe(true);
    // ...but a fresh live lease again blocks a concurrent claim.
    expect(claimTaskForRun('orphan-task', wayLater + 1000)).toBe(false);
  });

  it('releaseTaskLease is a no-op when no lease is held', () => {
    expect(() => releaseTaskLease('never-claimed')).not.toThrow();
    expect(claimTaskForRun('never-claimed', 4_000_000)).toBe(true);
  });

  it('restart gate atomically blocks new task claims until it expires', () => {
    const now = 4_500_000;
    expect(claimTaskForRun('restart-gate-bootstrap', now - 1)).toBe(true);
    releaseTaskLease('restart-gate-bootstrap');
    getDb()
      .prepare('INSERT INTO task_leases (task_id, locked_until) VALUES (?, ?)')
      .run(SCHEDULER_RESTART_GATE_TASK_ID, now + 10_000);

    expect(claimTaskForRun('restart-gated-task', now)).toBe(false);
    expect(claimTaskForRun(SCHEDULER_RESTART_GATE_TASK_ID, now)).toBe(false);

    // Normal task cleanup must never remove the worker-owned restart gate.
    releaseTaskLease(SCHEDULER_RESTART_GATE_TASK_ID);
    expect(claimTaskForRun('still-restart-gated-task', now + 1_000)).toBe(
      false,
    );

    expect(claimTaskForRun('post-restart-task', now + 10_001)).toBe(true);
  });

  it('computeLeaseTtlMs honors a per-group containerConfig.timeout larger than the global ceiling', () => {
    // No group / no override -> global floor (CONTAINER_TIMEOUT + 5m), but never
    // below the runtime's idle ceiling (IDLE_TIMEOUT + 30s + margin).
    const globalFloor = computeLeaseTtlMs();
    expect(globalFloor).toBe(1_800_000 + 30_000 + 5 * 60 * 1000);

    // A group whose run-time ceiling exceeds the global one must yield a LARGER
    // lease TTL, so a healthy long run is never reclaimed mid-flight.
    const bigTimeout = 3 * 60 * 60 * 1000; // 3h, well over CONTAINER_TIMEOUT
    const ttl = computeLeaseTtlMs({ containerConfig: { timeout: bigTimeout } });
    expect(ttl).toBe(bigTimeout + 5 * 60 * 1000);
    expect(ttl).toBeGreaterThan(globalFloor);

    const codexTtl = computeLeaseTtlMs({
      agentConfig: { codexTurnTimeoutMs: 45 * 60 * 1000 },
    });
    expect(codexTtl).toBe(50 * 60 * 1000);
    // The message-turn idle stop and cap never widen a task lease.
    expect(
      computeLeaseTtlMs({
        agentConfig: {
          codexTurnTimeoutMs: 45 * 60 * 1000,
          codexTurnInactivityMs: 600_000,
          codexTurnMaxMs: 90 * 60 * 1000,
        },
      }),
    ).toBe(50 * 60 * 1000);
  });

  it('claimTaskForRun keeps a long-timeout group leased past the global TTL', () => {
    const now = 5_000_000;
    const bigTimeout = 3 * 60 * 60 * 1000; // 3h
    const ttl = computeLeaseTtlMs({ containerConfig: { timeout: bigTimeout } });

    expect(claimTaskForRun('big-task', now, ttl)).toBe(true);
    // At a point past the GLOBAL TTL (CONTAINER_TIMEOUT + 5m) but well within the
    // per-group lease, a still-running task must NOT be reclaimable — this is the
    // duplicate-execution guard for groups with a large containerConfig.timeout.
    const pastGlobalTtl = now + 1_800_000 + 5 * 60 * 1000 + 60_000;
    expect(claimTaskForRun('big-task', pastGlobalTtl)).toBe(false);
    // Once the per-group lease itself expires, reclaim succeeds again.
    const pastGroupTtl = now + ttl + 1000;
    expect(claimTaskForRun('big-task', pastGroupTtl)).toBe(true);
  });

  it('claimTaskForRun never shortens a lease below the global floor', () => {
    const now = 6_000_000;
    const globalFloor = 1_800_000 + 5 * 60 * 1000; // CONTAINER_TIMEOUT + 5m
    // Even if a caller passes a TTL below the global floor, the claim must clamp
    // up to the floor — a healthy run can still take up to the runtime ceiling,
    // so a too-short lease could be reclaimed and re-executed mid-run.
    expect(claimTaskForRun('small-task', now, 1000)).toBe(true);
    // Just inside the global floor the lease is still live (not reclaimable).
    expect(claimTaskForRun('small-task', now + globalFloor - 1000)).toBe(false);
    // Past the floor it is reclaimable.
    expect(claimTaskForRun('small-task', now + globalFloor + 1000)).toBe(true);
  });

  it('does not dispatch a task twice while a prior run holds the lease', async () => {
    createTask({
      id: 'task-no-double-dispatch',
      group_folder: 'telegram_main',
      chat_jid: 'tg:7000000002',
      prompt: 'run scheduled task',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      // Due now; next_run is NOT advanced until the (hanging) run completes,
      // so getDueTasks() keeps returning it on every poll.
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-05-10T09:00:00.000Z',
    });

    // The run never settles, so the lease taken on the first dispatch stays
    // held — exactly the "still mid-run when the next poll fires" window.
    runnerMocks.runContainerAgent.mockReturnValue(new Promise(() => {}));

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
        return true; // real enqueueTask returns true when the dispatch is accepted
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'tg:7000000002': {
          name: 'User A',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'container',
        },
      }),
      getSessions: () => ({}),
      // The queue mock keeps no state: only the lease can stop the repeat.
      queue: {
        enqueueTask,
        hasTask: () => false,
        noteRunActivity: vi.fn(),
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: vi.fn(),
      router: {
        route: vi.fn(),
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    });

    // First poll: claims the lease and dispatches.
    await vi.advanceTimersByTimeAsync(1);
    // Second poll cycle (>= SCHEDULER_POLL_INTERVAL): the task is still due and
    // the lease is still held, so claimTaskForRun() denies a second dispatch.
    await vi.advanceTimersByTimeAsync(60000);
    await vi.advanceTimersByTimeAsync(60000);

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(runnerMocks.runContainerAgent).toHaveBeenCalledTimes(1);
  });
});

describe('аренда задачи живёт, пока задача ждёт очереди и идёт', () => {

  // A queued task keeps its lease while waiting for a long chat turn.
  const CHAT = 'tg:1000000000001';
  const FOLDER = 'telegram_synthetic_queue';
  const TASK_ID = 'task-synthetic-hourly';
  const groups = () => ({
    [CHAT]: {
      name: 'Synthetic',
      folder: FOLDER,
      trigger: '@Skoobi',
      added_at: '2026-10-01T00:00:00.000Z',
      runtime: 'container' as const,
      agentConfig: { codexTurnTimeoutMs: 30 * 60 * 1000 },
    },
  });
  const router = () =>
    ({
      route: vi.fn(),
      send: async () => {},
      addPreHook: () => {},
      addPostHook: () => {},
    }) as any;
  const leaseUntil = (taskId: string): number | undefined =>
    (
      getDb()
        .prepare('SELECT locked_until FROM task_leases WHERE task_id = ?')
        .get(taskId) as { locked_until: number } | undefined
    )?.locked_until;
  const createDueTask = () =>
    createTask({
      id: TASK_ID,
      group_folder: FOLDER,
      chat_jid: CHAT,
      prompt: 'автономный проход по проекту',
      schedule_type: 'interval',
      schedule_value: '3600000',
      context_mode: 'group',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-10-01T00:00:00.000Z',
    });
  // A queue that holds what it accepts and runs nothing by itself: the test
  // decides when the chat's slot frees up.
  const holdingQueue = () => {
    const held = new Map<string, () => Promise<void>>();
    return {
      held,
      queue: {
        hasTask: vi.fn((_jid: string, taskId: string) => held.has(taskId)),
        enqueueTask: vi.fn(
          (_jid: string, taskId: string, fn: () => Promise<void>) => {
            if (held.has(taskId)) return false;
            held.set(taskId, fn);
            return true;
          },
        ),
        noteRunActivity: vi.fn(),
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      },
    };
  };

  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    runnerMocks.runContainerAgent.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReturnValue({
      codex: { command: '/opt/homebrew/bin/codex', model: 'gpt-5.6-sol' },
    });
    process.env.CLAUDECLAW_ENV_FILE = '/tmp/skoobi-task-scheduler-test.env';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.CLAUDECLAW_ENV_FILE;
  });

  it('renewTaskLease двигает только существующую аренду и никогда не укорачивает', () => {
    const now = 7_000_000;
    const ttl = 2_130_000;
    expect(claimTaskForRun('renew-task', now, ttl)).toBe(true);
    expect(leaseUntil('renew-task')).toBe(now + ttl);

    expect(renewTaskLease('renew-task', now + 600_000, ttl)).toBe(true);
    expect(leaseUntil('renew-task')).toBe(now + 600_000 + ttl);
    // An older clock never pulls the lease back.
    expect(renewTaskLease('renew-task', now, ttl)).toBe(true);
    expect(leaseUntil('renew-task')).toBe(now + 600_000 + ttl);
    // A too-short TTL is clamped up to the global floor, like a claim
    // (CONTAINER_TIMEOUT + 5 min).
    expect(renewTaskLease('renew-task', now + 700_000, 1_000)).toBe(true);
    expect(leaseUntil('renew-task')).toBe(now + 700_000 + 2_100_000);

    // No row, no lease: renewal does not invent one.
    expect(renewTaskLease('never-claimed-task', now, ttl)).toBe(false);
    expect(leaseUntil('never-claimed-task')).toBeUndefined();
    // The restart worker's gate is never touched.
    expect(renewTaskLease(SCHEDULER_RESTART_GATE_TASK_ID, now, ttl)).toBe(
      false,
    );
  });

  it('задача ждёт за ходом чата дольше TTL — аренда жива, повторного захвата и «Found due tasks» нет', async () => {
    createDueTask();
    const { held, queue } = holdingQueue();
    const info = vi.spyOn(logger, 'info');
    const ttl = computeLeaseTtlMs(groups()[CHAT]);

    startSchedulerLoop({
      registeredGroups: groups,
      getSessions: () => ({}),
      queue: queue as any,
      onProcess: vi.fn(),
      router: router(),
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);
    expect(held.has(TASK_ID)).toBe(true);
    const foundDue = () =>
      info.mock.calls.filter((call) => call[1] === 'Found due tasks').length;
    expect(foundDue()).toBe(1);

    // 40 minutes behind the chat turn: past the 35.5-minute TTL that used to

    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(leaseUntil(TASK_ID)).toBeGreaterThan(Date.now() + ttl - 61_000);
    expect(claimTaskForRun(TASK_ID, Date.now())).toBe(false);
    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);
    // A held task is not «found» again every minute.
    expect(foundDue()).toBe(1);

    // The slot frees up: the real start renews the lease to a full TTL.
    runnerMocks.runContainerAgent.mockReturnValue(new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(17_000);
    const startedAt = Date.now();
    void held.get(TASK_ID)!();
    expect(leaseUntil(TASK_ID)).toBe(startedAt + ttl);

    // 31 minutes of the run itself: still leased all along.
    for (let minute = 0; minute < 31; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(leaseUntil(TASK_ID)!).toBeGreaterThan(Date.now());
    }
    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);
  });

  it('очередь отказала (останавливается) — аренда снимается, как раньше', async () => {
    createDueTask();
    const queue = {
      hasTask: vi.fn(() => false),
      enqueueTask: vi.fn(() => false),
      noteRunActivity: vi.fn(),
      notifyIdle: vi.fn(),
      closeStdin: vi.fn(),
    };
    startSchedulerLoop({
      registeredGroups: groups,
      getSessions: () => ({}),
      queue: queue as any,
      onProcess: vi.fn(),
      router: router(),
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);
    expect(leaseUntil(TASK_ID)).toBeUndefined();
  });

  it('потолок прогона задачи — жёсткий предел песочницы вокруг хода codex', () => {
    // codex task budget 30 min + 2 min of the sandbox on top.
    expect(
      scheduledTaskRunCeilingMs(
        { agentConfig: { codexTurnTimeoutMs: 30 * 60_000 } },
        {},
      ),
    ).toBe(32 * 60_000);
    // No group budget, no env: max(30 min, IDLE_TIMEOUT + 30 s, 15 + 2 min).
    expect(scheduledTaskRunCeilingMs({}, {})).toBe(30 * 60_000 + 30_000);
    expect(
      scheduledTaskRunCeilingMs(
        {},
        { SKOOBI_CODEX_RESERVE_TIMEOUT_MS: '3600000' },
      ),
    ).toBe(62 * 60_000);
    // A larger container timeout wins.
    expect(
      scheduledTaskRunCeilingMs(
        { containerConfig: { timeout: 3 * 3_600_000 } },
        {},
      ),
    ).toBe(3 * 3_600_000);
  });

  it('каждый кадр прогона, heartbeat тоже, — признак жизни для очереди (C19)', async () => {
    createDueTask();
    const queue = taskQueueMock();
    const livenessAtFrame: number[] = [];
    runnerMocks.runContainerAgent.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {

        // every one of them, not only the result.
        for (let minute = 0; minute < 30; minute += 1) {
          await onOutput?.({ status: 'heartbeat', result: null });
          livenessAtFrame.push(queue.noteRunActivity.mock.calls.length);
        }
        await onOutput?.({ status: 'success', result: 'проход готов' });
        return { status: 'success', result: 'проход готов' };
      },
    );

    await runTask(getTaskById(TASK_ID)!, {
      registeredGroups: groups,
      getSessions: () => ({}),
      queue,
      onProcess: vi.fn(),
      router: router(),
    });

    expect(runnerMocks.runContainerAgent).toHaveBeenCalledTimes(1);
    expect(livenessAtFrame).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
    expect(queue.noteRunActivity).toHaveBeenCalledTimes(31);
    for (const call of queue.noteRunActivity.mock.calls) {
      expect(call).toEqual([CHAT]);
    }
  });
});

describe('утренний разбор полётов: профиль read_only', () => {
  const OWNER_CHAT = 'tg:100000001';
  const REVIEW_PROMPT = 'Утренний разбор полётов: только чтение.';

  const mainGroup = (agentConfig: Record<string, unknown> = {}) => ({
    [OWNER_CHAT]: {
      name: 'Main',
      folder: 'telegram_main',
      trigger: '@Skoobi',
      added_at: '2026-05-10T09:00:00.000Z',
      runtime: 'sandbox' as const,
      isMain: true,
      agentConfig: {
        model: 'test-model',
        googleStandingAccess: true,
        codexTurnTimeoutMs: 30 * 60 * 1000,
        ...agentConfig,
      },
    },
  });

  const createReviewTask = (
    id: string,
    runProfile: 'read_only' | null = 'read_only',
    prompt = REVIEW_PROMPT,
  ) => {
    createTask({
      id,
      group_folder: 'telegram_main',
      chat_jid: OWNER_CHAT,
      prompt,
      schedule_type: 'cron',
      schedule_value: '0 7 * * *',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-09-28T00:00:00.000Z',
      creator_authorization: 'owner_sender',
      creator_identity_id: 'telegram_user_100000001',
      creator_sender_id: '100000001',
      run_profile: runProfile,
    });
    return getTaskById(id)!;
  };

  const depsWith = (router: any, agentConfig: Record<string, unknown> = {}) =>
    ({
      registeredGroups: () => mainGroup(agentConfig),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router,
    }) as any;

  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    runnerMocks.runSandboxAgent.mockReset();
    runnerMocks.writeTasksSnapshot.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReturnValue({
      codex: {
        command: '/opt/homebrew/bin/codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'xhigh',
        webSearchEnabled: true,
      },
    });
    vi.mocked(buildGoogleOperationPolicy).mockClear();
    vi.mocked(buildStandingGoogleOperationPolicy).mockClear();
    process.env.CLAUDECLAW_ENV_FILE = '/tmp/skoobi-task-scheduler-test.env';
    process.env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY = 'true';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CLAUDECLAW_ENV_FILE;
    delete process.env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY;
  });

  it('читает профиль: NULL — обычный прогон, неизвестное значение — read_only', () => {
    expect(taskRunsReadOnly({ id: 't', run_profile: null })).toBe(false);
    expect(taskRunsReadOnly({ id: 't' })).toBe(false);
    expect(taskRunsReadOnly({ id: 't', run_profile: 'read_only' })).toBe(true);
    expect(
      taskRunsReadOnly({ id: 't', run_profile: 'readonly' as never }),
    ).toBe(true);
  });

  it('read_only: без Google, без исходящих и постоянных инструментов, Codex только читает', async () => {
    createReviewTask('task-nightly-review');
    runnerMocks.runSandboxAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    await runTask(
      getTaskById('task-nightly-review')!,
      depsWith(
        {
          route: vi.fn().mockResolvedValue(null),
          send: async () => {},
          addPreHook: () => {},
          addPostHook: () => {},
        },
        { disallowedTools: ['memory_get'] },
      ),
    );

    expect(runnerMocks.runSandboxAgent).toHaveBeenCalledTimes(1);
    const input = runnerMocks.runSandboxAgent.mock.calls[0][1];
    // Tier and provider stay those of an owner task.
    expect(input.provider).toBe('codex_cli');
    expect(input.credentialProxyTier).toBe('owner');
    expect(input.taskAuthorizationCapability).toBeTruthy();

    const disallowed: string[] = input.agentConfig.disallowedTools;
    for (const tool of [
      ...UNTRUSTED_CONTENT_QUARANTINED_TOOLS,
      ...GOOGLE_WORKSPACE_WRITE_TOOLS,
      'send_message',
      'schedule_task',
      'memory_save',
      'skill_propose',
      'register_group',
      'codex_desktop_control',
      'codex_desktop_status',
      'computer_click',
      'gmail_search_threads',
    ]) {
      expect(disallowed).toContain(tool);
    }
    // The chat's own lockout is kept, nothing is listed twice, and the
    // reading tools the review needs are not taken away.
    expect(disallowed).toContain('memory_get');
    expect(new Set(disallowed).size).toBe(disallowed.length);
    for (const tool of [
      'list_tasks',
      'memory_search',
      'skill_list',
      'skill_view',
    ]) {
      expect(disallowed).not.toContain(tool);
    }
    expect(disallowed).toEqual(
      expect.arrayContaining([...READ_ONLY_TASK_DISALLOWED_TOOLS]),
    );

    expect(input.codex).toMatchObject({
      sandboxMode: 'read-only',
      webSearchEnabled: false,
      model: 'gpt-5.6-sol',
      timeoutMs: 30 * 60 * 1000,
    });

    // No Google policy is even built, standing access notwithstanding.
    expect(buildStandingGoogleOperationPolicy).not.toHaveBeenCalled();
    expect(buildGoogleOperationPolicy).not.toHaveBeenCalled();
  });

  it('строка без профиля получает ровно сегодняшние входные данные', async () => {
    createReviewTask('task-regular', null);
    expect(getTaskById('task-regular')!.run_profile).toBeNull();
    runnerMocks.runSandboxAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    await runTask(
      getTaskById('task-regular')!,
      depsWith(
        {
          route: vi.fn().mockResolvedValue(null),
          send: async () => {},
          addPreHook: () => {},
          addPostHook: () => {},
        },
        { disallowedTools: ['memory_get'] },
      ),
    );

    const input = runnerMocks.runSandboxAgent.mock.calls[0][1];
    expect(input.agentConfig.disallowedTools).toEqual(['memory_get']);
    expect(input.codex).toEqual({
      command: '/opt/homebrew/bin/codex',
      model: 'gpt-5.6-sol',
      fallbackModel: undefined,
      reasoningEffort: 'xhigh',
      webSearchEnabled: true,
      timeoutMs: 30 * 60 * 1000,
    });
    expect(input.codex).not.toHaveProperty('sandboxMode');
    expect(buildStandingGoogleOperationPolicy).toHaveBeenCalledTimes(1);
  });

  it('ответ целиком в <internal> — в чат ничего не уходит, прогон успешный', async () => {
    createReviewTask('task-nightly-review');
    const channel: Channel = {
      name: 'telegram',
      connect: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      isConnected: () => true,
      ownsJid: (jid: string) => jid.startsWith('tg:'),
      disconnect: vi.fn(),
    };
    const quietLine =
      '<internal>Учебный разбор: без замечаний (сообщений: 5, сбоев: 1)</internal>';
    runnerMocks.runSandboxAgent.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({ status: 'success', result: quietLine });
        return { status: 'success', result: null };
      },
    );

    await runTask(
      getTaskById('task-nightly-review')!,
      depsWith(createMessageRouter([channel])),
    );

    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(getRecentConversationMessages(OWNER_CHAT, '', 10)).toHaveLength(0);
    const log = getDb()
      .prepare(
        `SELECT status, result, error FROM task_run_logs
         WHERE task_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get('task-nightly-review') as {
      status: string;
      result: string | null;
      error: string | null;
    };
    expect(log.status).toBe('success');
    expect(log.error).toBeNull();
    expect(log.result).toContain('<internal>Учебный разбор');
    const after = getTaskById('task-nightly-review')!;
    expect(after.status).toBe('active');
    expect(after.next_run).not.toBeNull();
    expect(Date.parse(after.next_run!)).toBeGreaterThan(Date.now());
    expect(after.last_result).toContain('<internal>');
  });

  it('разбор, где упомянут rate limit, доходит как есть и прогон успешный', async () => {
    createReviewTask('task-nightly-review');
    const review = [
      'Учебный разбор:',
      '1. Тестовый пользователь, 10:00 — получен rate limit Codex (429) → пример: 10:00, rate_limit',
      '2. Тестовый администратор, 11:00 — ответ пришёл через 2 минуты → ок',
    ].join('\n');
    runnerMocks.runSandboxAgent.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({ status: 'success', result: review });
        return { status: 'success', result: null };
      },
    );
    const route = vi.fn().mockResolvedValue(review);

    await runTask(
      getTaskById('task-nightly-review')!,
      depsWith({
        route,
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      }),
    );

    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0][0].text).toBe(review);
    const log = getDb()
      .prepare(
        `SELECT status, result, error FROM task_run_logs
         WHERE task_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get('task-nightly-review') as {
      status: string;
      result: string | null;
      error: string | null;
    };
    expect(log).toEqual({ status: 'success', result: review, error: null });
    expect(getTaskById('task-nightly-review')!.last_result).toContain(
      'rate limit Codex',
    );
  });

  it('пустой финальный ответ — это падение: владелец получает извещение', async () => {
    // The text names tables and a calendar: a normal task would get the
    // «no Google tools» hint appended; a read_only one must not.
    createReviewTask(
      'task-nightly-review',
      'read_only',
      'Разбор полётов: не трогай таблицы и календарь.',
    );
    runnerMocks.runSandboxAgent.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'error',
          result: null,
          error: 'codex produced no final message',
        });
        return {
          status: 'error',
          result: null,
          error: 'codex produced no final message',
        };
      },
    );
    const route = vi.fn().mockResolvedValue('notice');

    await runTask(
      getTaskById('task-nightly-review')!,
      depsWith(
        {
          route,
          send: async () => {},
          addPreHook: () => {},
          addPostHook: () => {},
        },
        // Without standing access a normal task would derive no policy from
        // this text and get the hint.
        { googleStandingAccess: false },
      ),
    );

    expect(route).toHaveBeenCalledTimes(1);
    const notice = route.mock.calls[0][0];
    expect(notice.meta).toEqual({ kind: 'task_failure_notice' });
    expect(notice.text).toContain('codex produced no final message');
    // The read_only profile has no Google on purpose — no Google hint.
    expect(notice.text).not.toContain('Google');
    const after = getTaskById('task-nightly-review')!;
    expect(after.status).toBe('active');
    expect(after.next_run).not.toBeNull();
  });
});

describe('плановая задача владельца получает инструменты Google', () => {
  const OWNER_CHAT = 'tg:100000001';
  const GUEST_CHAT = 'tg:7000000002';
  const SHEET_ID = 'public-fixture-sheet-ledger-0001';
  const STANDING_PROMPT = 'Сверь таблицу самокатов и отметь, кто вернул.';

  const groups = (mainAgentConfig: Record<string, unknown> = {}) => ({
    [OWNER_CHAT]: {
      name: 'Main',
      folder: 'telegram_main',
      trigger: '@Skoobi',
      added_at: '2026-05-10T09:00:00.000Z',
      runtime: 'sandbox' as const,
      isMain: true,
      agentConfig: {
        model: 'test-model',
        googleStandingAccess: true,
        ...mainAgentConfig,
      },
    },
    [GUEST_CHAT]: {
      name: 'Guest',
      folder: 'guest_example',
      trigger: '@Skoobi',
      added_at: '2026-05-10T09:00:00.000Z',
      runtime: 'sandbox' as const,
      agentConfig: { model: 'test-model', googleStandingAccess: true },
    },
  });

  const createGoogleTask = (
    id: string,
    options: {
      prompt?: string;
      runProfile?: 'read_only' | null;
      owner?: boolean;
      groupFolder?: string;
      chatJid?: string;
      nextRun?: string;
      scheduleType?: 'cron' | 'once';
      creatorId?: string;
    } = {},
  ) => {
    const creatorId = options.creatorId ?? '100000001';
    createTask({
      id,
      group_folder: options.groupFolder ?? 'telegram_main',
      chat_jid: options.chatJid ?? OWNER_CHAT,
      prompt: options.prompt ?? STANDING_PROMPT,
      schedule_type: options.scheduleType ?? 'cron',
      schedule_value:
        (options.scheduleType ?? 'cron') === 'cron'
          ? '0 9 * * *'
          : '2026-09-28T09:00:00.000Z',
      context_mode: 'isolated',
      next_run: options.nextRun ?? new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-09-28T00:00:00.000Z',
      ...(options.owner === false
        ? {}
        : {
            creator_authorization: 'owner_sender' as const,
            creator_identity_id: `telegram_user_${creatorId}`,
            creator_sender_id: creatorId,
          }),
      run_profile: options.runProfile ?? null,
    });
    return getTaskById(id)!;
  };

  const depsWith = (
    mainAgentConfig: Record<string, unknown> = {},
    route = vi.fn().mockResolvedValue(null),
  ) =>
    ({
      registeredGroups: () => groups(mainAgentConfig),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route,
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      },
    }) as any;

  const updateEnvelope = (requestId: string) => ({
    type: 'google_api',
    request_id: requestId,
    tool: 'google_sheets_update_values',
    args: {
      spreadsheetId: SHEET_ID,
      range: 'Самокаты!F12',
      values: [['вернул']],
      inputMode: 'raw',
      expectedDigest: 'd'.repeat(64),
    },
  });

  /**
   * What the runner's MCP server does for one google_* call: ask the host for
   * a grant with the run's capability, then hand the request to the broker.
   * Must run while the task is running — the capability is revoked after.
   */
  const callGoogleThroughHost = async (
    capability: string,
    envelope: Record<string, unknown>,
    execute: ReturnType<typeof vi.fn>,
  ) => {
    const authorization = authorizeTaskOperationRequest(
      signedTaskAuthorizationRequestForTest(
        capability,
        envelope,
        `authorize_${String(envelope.request_id)}`,
      ),
      'telegram_main',
    );
    if (!authorization.ok) return { authorization, result: null };
    const result = await processGoogleWorkspaceRequest({
      raw: { ...envelope, ownerAuthorizationGrant: authorization.grant },
      sourceGroup: 'telegram_main',
      execute: execute as any,
    });
    return { authorization, result };
  };

  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    runnerMocks.runSandboxAgent.mockReset();
    runnerMocks.writeTasksSnapshot.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReturnValue({
      codex: {
        command: '/opt/homebrew/bin/codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'xhigh',
        webSearchEnabled: true,
      },
    });
    vi.mocked(buildGoogleOperationPolicy).mockClear();
    vi.mocked(buildStandingGoogleOperationPolicy).mockClear();
    process.env.CLAUDECLAW_ENV_FILE = '/tmp/skoobi-task-scheduler-test.env';
    process.env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY = 'true';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CLAUDECLAW_ENV_FILE;
    delete process.env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY;
    delete process.env.OWNER_TELEGRAM_USER_IDS;
    delete process.env.SKOOBI_GOOGLE_OWNER_TELEGRAM_USER_IDS;
    delete process.env.SKOOBI_GOOGLE_WORKSPACE_NAMED_SHEET_TARGETS_JSON;
  });

  it('постоянный доступ: раннер получает список политики, хост пропускает запись через капабилити задачи', async () => {
    createGoogleTask('task-standing');
    const execute = vi.fn().mockResolvedValue({ updatedCells: 1 });
    let hostCall: Awaited<ReturnType<typeof callGoogleThroughHost>> | null =
      null;
    runnerMocks.runSandboxAgent.mockImplementation(async (_group, input) => {
      hostCall = await callGoogleThroughHost(
        input.taskAuthorizationCapability,
        updateEnvelope('google_standing_update_1'),
        execute,
      );
      return { status: 'success', result: null };
    });

    await runTask(getTaskById('task-standing')!, depsWith());

    expect(runnerMocks.runSandboxAgent).toHaveBeenCalledTimes(1);
    const input = runnerMocks.runSandboxAgent.mock.calls[0][1];
    expect(input.provider).toBe('codex_cli');
    expect(input.credentialProxyTier).toBe('owner');
    expect(input.isScheduledTask).toBe(true);
    expect(input.taskAuthorizationCapability).toBeTruthy();

    // The runner input carries exactly the policy the capability holds.
    expect(buildStandingGoogleOperationPolicy).toHaveBeenCalledTimes(1);
    const policy = vi.mocked(buildStandingGoogleOperationPolicy).mock
      .results[0].value;
    expect(policy?.standing).toBe(true);
    expect(input.googleAllowedTools).toEqual(policy!.allowedTools);
    expect([...input.googleAllowedTools].sort()).toEqual(
      [...GOOGLE_WORKSPACE_TOOL_NAMES].sort(),
    );
    expect(input.googleSheetTargetHints).toEqual(
      policy!.allowedSheetAppendTargets,
    );

    // And the host honours it: a standing cell update from the task goes
    // through the grant and reaches the Google executor once.
    expect(hostCall!.authorization).toMatchObject({ ok: true });
    expect(hostCall!.result).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('read_only, гость, непроверенная строка, бывший владелец и чат без политики — без инструментов Google', async () => {
    createGoogleTask('task-read-only', { runProfile: 'read_only' });
    createGoogleTask('task-legacy', { owner: false });
    createGoogleTask('task-guest-chat', {
      groupFolder: 'guest_example',
      chatJid: GUEST_CHAT,
    });
    createGoogleTask('task-no-policy', { prompt: 'Напомни выпить воды.' });
    runnerMocks.runSandboxAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    await runTask(getTaskById('task-read-only')!, depsWith());
    await runTask(getTaskById('task-legacy')!, depsWith());
    await runTask(getTaskById('task-guest-chat')!, depsWith());
    // A main chat without standing access: this text derives no policy.
    await runTask(
      getTaskById('task-no-policy')!,
      depsWith({ googleStandingAccess: false }),
    );
    // The creator left OWNER_TELEGRAM_USER_IDS: the run is guest-tier.
    process.env.OWNER_TELEGRAM_USER_IDS = '100000002';
    await runTask(createGoogleTask('task-ex-owner'), depsWith());
    delete process.env.OWNER_TELEGRAM_USER_IDS;
    // Still an owner, but Google is narrowed to somebody else: no capability,
    // so no tools either.
    process.env.SKOOBI_GOOGLE_OWNER_TELEGRAM_USER_IDS = '100000002';
    await runTask(createGoogleTask('task-google-narrowed'), depsWith());

    const inputs = runnerMocks.runSandboxAgent.mock.calls.map(
      (call) => call[1],
    );
    expect(inputs).toHaveLength(6);
    for (const input of inputs) {
      expect(input).not.toHaveProperty('googleAllowedTools');
      expect(input).not.toHaveProperty('googleSheetTargetHints');
    }
    const [readOnly, legacy, guestChat, noPolicy, exOwner, narrowed] = inputs;
    expect(readOnly.credentialProxyTier).toBe('owner');
    expect(legacy.credentialProxyTier).toBe('guest');
    expect(guestChat.credentialProxyTier).toBe('guest');
    expect(noPolicy.credentialProxyTier).toBe('owner');
    expect(noPolicy.taskAuthorizationCapability).toBeTruthy();
    expect(exOwner.credentialProxyTier).toBe('guest');
    expect(narrowed.credentialProxyTier).toBe('owner');
    expect(narrowed.taskAuthorizationCapability).toBeUndefined();
  });

  it('чат без постоянного доступа: политика из текста задачи — тот же список и те же цели дописывания', async () => {
    process.env.SKOOBI_GOOGLE_WORKSPACE_NAMED_SHEET_TARGETS_JSON =
      JSON.stringify([
        {
          aliases: ['тестовая сотрудница', 'тестовой сотрудницы', 'тестовой сотруднице'],
          spreadsheetId: SHEET_ID,
          range: "'Лист1'!A46:G1000",
        },
      ]);
    createGoogleTask('task-fixture-employee', {
      prompt:
        'Сегодня тестовая сотрудница работала с 10 утра до 2 часов дня. Занеси ей в табличку.',
    });
    runnerMocks.runSandboxAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    await runTask(
      getTaskById('task-fixture-employee')!,
      depsWith({ googleStandingAccess: false }),
    );

    expect(buildStandingGoogleOperationPolicy).not.toHaveBeenCalled();
    const policy = vi.mocked(buildGoogleOperationPolicy).mock.results[0]
      .value;
    expect(policy).not.toBeNull();
    const input = runnerMocks.runSandboxAgent.mock.calls[0][1];
    expect(input.googleAllowedTools).toEqual(policy!.allowedTools);
    expect(input.googleAllowedTools).toContain('google_sheets_append_values');
    expect(input.googleSheetTargetHints).toEqual(
      policy!.allowedSheetAppendTargets,
    );
    expect(input.googleSheetTargetHints).toEqual([
      expect.objectContaining({ label: 'тестовая сотрудница', spreadsheetId: SHEET_ID }),
    ]);
  });

  it('каждое повторение задачи пишет своё, повторный запуск того же повторения — нет', async () => {
    const firstOccurrence = new Date(Date.now() - 60_000).toISOString();
    createGoogleTask('task-daily-mark', { nextRun: firstOccurrence });
    const execute = vi.fn().mockResolvedValue({ updatedCells: 1 });
    const results: unknown[] = [];
    let call = 0;
    runnerMocks.runSandboxAgent.mockImplementation(async (_group, input) => {
      call += 1;
      const { result } = await callGoogleThroughHost(
        input.taskAuthorizationCapability,
        // The same write every day; only the request ids differ.
        updateEnvelope(`google_daily_mark_${call}`),
        execute,
      );
      results.push(result);
      return { status: 'success', result: null };
    });

    await runTask(getTaskById('task-daily-mark')!, depsWith());
    // The next day's occurrence.
    const secondOccurrence = new Date(Date.now() - 30_000).toISOString();
    getDb()
      .prepare('UPDATE scheduled_tasks SET next_run = ? WHERE id = ?')
      .run(secondOccurrence, 'task-daily-mark');
    const nextDay = getTaskById('task-daily-mark')!;
    await runTask(nextDay, depsWith());
    // The same occurrence dispatched again (restart mid-run): answered from
    // the journal, not written a second time.
    await runTask(nextDay, depsWith());

    expect(results).toHaveLength(3);
    for (const result of results) expect(result).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('разовая задача, повторённая после ошибки, не пишет второй раз', async () => {
    createGoogleTask('task-once-mark', { scheduleType: 'once' });
    const execute = vi.fn().mockResolvedValue({ updatedCells: 1 });
    const results: unknown[] = [];
    let call = 0;
    runnerMocks.runSandboxAgent.mockImplementation(async (_group, input) => {
      call += 1;
      const { result } = await callGoogleThroughHost(
        input.taskAuthorizationCapability,
        updateEnvelope(`google_once_mark_${call}`),
        execute,
      );
      results.push(result);
      return { status: 'success', result: null };
    });

    await runTask(getTaskById('task-once-mark')!, depsWith());
    // A retry after an error moves next_run; schedule_value stays.
    getDb()
      .prepare(
        "UPDATE scheduled_tasks SET next_run = ?, status = 'active' WHERE id = ?",
      )
      .run(new Date(Date.now() + 60_000).toISOString(), 'task-once-mark');
    await runTask(getTaskById('task-once-mark')!, depsWith());

    expect(results).toHaveLength(2);
    for (const result of results) expect(result).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('извещение о сбое: подсказка про Google — только когда инструментов Google не было', async () => {
    const prompt = 'Проверь Google-таблицу продаж и пришли итог.';
    createGoogleTask('task-google-fails', { prompt, scheduleType: 'once' });
    createGoogleTask('task-google-fails-standing', {
      prompt,
      scheduleType: 'once',
    });
    runnerMocks.runSandboxAgent.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'codex produced no final message',
    });
    const withoutStanding = vi.fn().mockResolvedValue('notice');
    const withStanding = vi.fn().mockResolvedValue('notice');

    await runTask(
      getTaskById('task-google-fails')!,
      depsWith({ googleStandingAccess: false }, withoutStanding),
    );
    await runTask(
      getTaskById('task-google-fails-standing')!,
      depsWith({}, withStanding),
    );

    const [noTools, standing] = runnerMocks.runSandboxAgent.mock.calls.map(
      (call) => call[1],
    );
    expect(noTools).not.toHaveProperty('googleAllowedTools');
    expect(withoutStanding).toHaveBeenCalledTimes(1);
    expect(withoutStanding.mock.calls[0][0].text).toContain(
      'в плановом прогоне не было инструментов Google',
    );

    expect(standing.googleAllowedTools.length).toBeGreaterThan(0);
    expect(withStanding).toHaveBeenCalledTimes(1);
    expect(withStanding.mock.calls[0][0].meta).toEqual({
      kind: 'task_failure_notice',
    });
    expect(withStanding.mock.calls[0][0].text).not.toContain(
      'не было инструментов Google',
    );
  });

  it('постоянный доступ — только задаче хозяина чата: другой владелец из списка, поставивший задачу в этот чат, получает политику из текста', async () => {
    // Another configured admin owns a different chat; telegram_main
    // (tg:100000001) is not his chat.
    const OTHER_OWNER = '100000003';
    process.env.OWNER_TELEGRAM_USER_IDS = `100000001,${OTHER_OWNER}`;
    process.env.SKOOBI_GOOGLE_WORKSPACE_NAMED_SHEET_TARGETS_JSON =
      JSON.stringify([
        {
          aliases: ['тестовая сотрудница', 'тестовой сотрудницы', 'тестовой сотруднице'],
          spreadsheetId: SHEET_ID,
          range: "'Лист1'!A46:G1000",
        },
      ]);
    const prompt =
      'Сегодня тестовая сотрудница работала с 10 утра до 2 часов дня. Занеси ей в табличку.';
    createGoogleTask('task-own-chat', { prompt });
    createGoogleTask('task-other-owner', { prompt, creatorId: OTHER_OWNER });
    const execute = vi.fn().mockResolvedValue({ updatedCells: 1 });
    const hostCalls: Array<Awaited<ReturnType<typeof callGoogleThroughHost>>> =
      [];
    let call = 0;
    runnerMocks.runSandboxAgent.mockImplementation(async (_group, input) => {
      call += 1;
      hostCalls.push(
        await callGoogleThroughHost(
          input.taskAuthorizationCapability,
          updateEnvelope(`google_owner_split_${call}`),
          execute,
        ),
      );
      return { status: 'success', result: null };
    });

    await runTask(getTaskById('task-own-chat')!, depsWith());
    await runTask(getTaskById('task-other-owner')!, depsWith());

    const [own, other] = runnerMocks.runSandboxAgent.mock.calls.map(
      (c) => c[1],
    );
    // The chat's owner: the whole standing toolset, and the cell update goes
    // through without a confirmation.
    expect(buildStandingGoogleOperationPolicy).toHaveBeenCalledTimes(1);
    expect([...own.googleAllowedTools].sort()).toEqual(
      [...GOOGLE_WORKSPACE_TOOL_NAMES].sort(),
    );
    expect(hostCalls[0].authorization).toMatchObject({ ok: true });

    // Another allowlisted owner in the same chat: still an owner-tier run
    // with a capability, but only what the task's own text asks for.
    expect(other.credentialProxyTier).toBe('owner');
    expect(other.taskAuthorizationCapability).toBeTruthy();
    expect(buildGoogleOperationPolicy).toHaveBeenCalledTimes(1);
    const textPolicy = vi.mocked(buildGoogleOperationPolicy).mock.results[0]
      .value;
    expect(textPolicy?.standing).toBeUndefined();
    expect(other.googleAllowedTools).toEqual(textPolicy!.allowedTools);
    expect(other.googleAllowedTools).toContain('google_sheets_append_values');
    expect(other.googleAllowedTools).not.toContain(
      'google_sheets_update_values',
    );
    expect(other.googleSheetTargetHints).toEqual([
      expect.objectContaining({ label: 'тестовая сотрудница', spreadsheetId: SHEET_ID }),
    ]);
    // The host holds it to that: the same cell update is refused.
    expect(hostCalls[1].authorization).toMatchObject({
      ok: false,
      error: 'google_atomic_precondition_unavailable',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('повтор того же повторения после сбоя перечитывает таблицу: дописывание с новым digest отвечает из журнала, строка не дублируется', async () => {
    const appendEnvelope = (requestId: string, expectedDigest: string) => ({
      type: 'google_api',
      request_id: requestId,
      tool: 'google_sheets_append_values',
      args: {
        spreadsheetId: SHEET_ID,
        range: "'Самокаты'!A1:D1000",
        values: [['28.09', 'самокат 7', 'вернул']],
        expectedDigest,
      },
    });
    const firstOccurrence = new Date(Date.now() - 60_000).toISOString();
    createGoogleTask('task-daily-append', { nextRun: firstOccurrence });
    const execute = vi
      .fn()
      .mockResolvedValue({ updates: { updatedRange: "'Самокаты'!A12:C12" } });
    // What the agent reads before each append: the row it added changes the
    // table, so every read after the first write has a new digest.
    const digests = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const results: any[] = [];
    let call = 0;
    runnerMocks.runSandboxAgent.mockImplementation(async (_group, input) => {
      call += 1;
      const { result } = await callGoogleThroughHost(
        input.taskAuthorizationCapability,
        appendEnvelope(`google_daily_append_${call}`, digests[call - 1]),
        execute,
      );
      results.push(result);
      return { status: 'success', result: null };
    });

    const occurrence = getTaskById('task-daily-append')!;
    await runTask(occurrence, depsWith());
    // The host restarted before the run was recorded: the same occurrence
    // (same next_run) is dispatched again and re-reads the table first.
    await runTask(occurrence, depsWith());
    // The next day's occurrence appends its own row.
    getDb()
      .prepare('UPDATE scheduled_tasks SET next_run = ? WHERE id = ?')
      .run(new Date(Date.now() - 30_000).toISOString(), 'task-daily-append');
    await runTask(getTaskById('task-daily-append')!, depsWith());

    expect(results).toHaveLength(3);
    for (const result of results) expect(result).toMatchObject({ ok: true });
    // The re-dispatch got the first write's outcome, not a second row.
    expect(results[1].result).toEqual(results[0].result);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
