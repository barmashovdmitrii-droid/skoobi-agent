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
  accountUsedPercent: vi.fn(
    (_opts?: {
      onReading?: (reading: { usedPercent: number; atMs: number; windows?: Array<{ usedPercent: number; windowMinutes?: number; resetsAtMs?: number }> }) => void;
    }): number | null => null,
  ),
}));

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Skoobi',
  // task-scheduler computes TASK_LEASE_TTL_MS from CONTAINER_TIMEOUT at module
  // eval time; it MUST be present in this mock or the constant becomes NaN and
  // lease inserts (an INTEGER column) break. (30 min, matching the real default.)
  CONTAINER_TIMEOUT: 1800000,
  // Only the Fast ceiling's account reading uses it, and that is mocked.
  DATA_DIR: '/tmp/claudeclaw-task-scheduler-data',
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

// The account-limit reading walks every CODEX_HOME on the machine; a test
// that turns Fast on gets a fixed reading instead.
vi.mock('./codex-accounting.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./codex-accounting.js')>()),
  codexAccountUsedPercentAcrossHomes: runnerMocks.accountUsedPercent,
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
  consecutiveTaskFailures,
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
  announceExpiredTask,
  gateDueTask,
  attachTaskLocalFileLinks,
  routeAndRecordTaskOutput,
  taskPromptRequestsGoogle,
  taskRunsReadOnly,
  finalizeUnhandledTaskFailure,
  hiddenTaskFailureSentence,
  EARLY_RETRY_LOG_MARK,
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

  // Задача — cron: у повторяющейся два ранних повтора первого слота тоже
  // отказы, поэтому пауза после семи (пять упавших слотов), M-C34b-ш2.
  it('после пяти упавших слотов подряд ставит задачу на паузу вместо вечного ретрая', async () => {
    const task = makeTask('task-broken');
    for (let i = 0; i < 6; i += 1) {
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

// Проверка C34: извещение о сбое несёт само напоминание, а не
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
      retryNotice('Напомни мне сверить остатки. Лист: «Склад-2». Ответь коротко.'),
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
      'Напомни мне одним сообщением: «Сегодня сдать отчёт по ТОО «Пример» в налоговую до обеда».';
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

  it.each(['once', 'interval'] as const)('reports a policy limit and schedules no early retry for a %s task', async scheduleType => {
    const { sandboxPolicyRefusal } = await import('../runtimes/sandbox-policy-budget.js');
    const { sandboxPolicyNotices } = await import('./sandbox-policy-notice.js');
    const chat = 'tg:7000000002';
    const taskId = 'policy-budget-' + scheduleType;
    const intervalMs = 86_400_000;
    const planned = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: taskId, group_folder: 'telegram_main', chat_jid: chat, prompt: 'Fixture task',
      schedule_type: scheduleType, schedule_value: scheduleType === 'once' ? planned : String(intervalMs),
      context_mode: 'isolated', next_run: planned, status: 'active', created_at: planned,
    });
    const task = getTaskById(taskId)!;
    const normalSlot = computeNextRun(task);
    runnerMocks.runSandboxAgent.mockResolvedValue(sandboxPolicyRefusal('total_entries'));
    const route = vi.fn(async envelope => envelope.text);
    await runTask(task, {
      registeredGroups: () => ({ [chat]: { name: 'Policy fixture', folder: task.group_folder,
        trigger: '', added_at: planned, runtime: 'sandbox' } }),
      getSessions: () => ({}), queue: taskQueueMock(), onProcess: vi.fn(),
      router: { route } as any,
    });
    expect(runnerMocks.runSandboxAgent).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0][0]).toMatchObject({ chatJid: chat,
      text: sandboxPolicyNotices.total_entries + (scheduleType === 'once' ? ' Плановая задача приостановлена.' : '') });
    expect(getTaskById(taskId)).toMatchObject({
      status: scheduleType === 'once' ? 'paused' : 'active',
      next_run: scheduleType === 'once' ? null : normalSlot,
    });
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

    // A run cut at its cap still burned its tokens (22.6 M were once written
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

  it('writes scheduled_task_finished with the tier of every Codex run, without the task text (r1109, п. 6)', async () => {
    for (const sql of getExtensionDbSchema()) getDb().exec(sql);
    process.env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY = 'true';
    runnerMocks.loadModelGatewayConfig.mockReturnValue({
      codex: {
        command: '/opt/homebrew/bin/codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'xhigh',
        webSearchEnabled: true,
        serviceTier: 'priority',
        serviceTierMaxUsedPercent: 70,
      },
    });
    // The host reading and its snapshot's own time (W27: codex_quota_status
    // judges the reading's freshness by it, as r1110 does).
    const readingAtMs = Date.parse('2026-05-10T09:58:00.000Z');
    // Review r1111 (turn-2): the snapshot's windows go to the runner too.
    const readingWindows = [{ usedPercent: 87, windowMinutes: 10080, resetsAtMs: readingAtMs + 86_400_000 }];
    runnerMocks.accountUsedPercent.mockImplementation((opts) => {
      opts?.onReading?.({ usedPercent: 87, atMs: readingAtMs, windows: readingWindows });
      return 87;
    });
    const taskBase = {
      group_folder: 'telegram_admin',
      chat_jid: 'tg:100999',
      prompt: 'секретное поручение: сверь склад и напиши тестовой сотруднице',
      schedule_type: 'once' as const,
      schedule_value: '2026-05-10T10:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active' as const,
      created_at: '2026-05-10T09:00:00.000Z',
      creator_authorization: 'owner_sender' as const,
      creator_identity_id: 'telegram:owner',
      creator_sender_id: '100000001',
    };
    const deps = {
      registeredGroups: () => ({
        'tg:100999': {
          name: 'Admin',
          folder: 'telegram_admin',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox' as const,
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      queue: taskQueueMock(),
      onProcess: vi.fn(),
      router: {
        route: vi.fn().mockResolvedValue('готово'),
        send: async () => {},
        addPreHook: () => {},
        addPostHook: () => {},
      } as any,
    };
    const events = () =>
      (
        getDb()
          .prepare(
            "SELECT type, actor, chat_id, payload_json FROM events WHERE type IN ('scheduled_task_finished', 'session_finished') ORDER BY created_at, seq",
          )
          .all() as Array<{ type: string; actor: string; chat_id: string; payload_json: string }>
      ).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));

    // A task run at 87 % with Fast applied used to be only an INFO line.
    createTask({ id: 'task-tier', ...taskBase, title: 'Сводка продаж' });
    runnerMocks.runSandboxAgent.mockImplementationOnce(
      async (_group, input, _onProcess, onOutput) => {
        expect(input.codex).toMatchObject({
          serviceTier: 'priority',
          serviceTierMaxUsedPercent: 70,
          accountUsedPercent: 87,
          accountReadingAtMs: readingAtMs,
          accountWindows: readingWindows,
        });
        await onOutput?.({
          status: 'success',
          result: 'готово',
          usage: { inputTokens: 900, outputTokens: 40 },
          turns: 2,
          codexTurn: {
            usageSource: 'cumulative_first_turn',
            modelRequests: 2,
            requestedServiceTier: 'priority',
            serviceTier: 'priority',
            reasoningEffort: 'xhigh',
            accountUsedPercent: 88,
            codexCliVersion: '0.166.0',
          },
        });
        return { status: 'success', result: null };
      },
    );
    await runTask(getTaskById('task-tier')!, deps);
    expect(events()).toHaveLength(1);
    const [ok] = events();
    expect(ok).toMatchObject({ type: 'scheduled_task_finished', actor: 'system', chat_id: '100999' });
    expect(ok.payload).toMatchObject({
      trigger: 'scheduled_task',
      group_folder: 'telegram_admin',
      task_id: 'task-tier',
      task_title: 'Сводка продаж',
      task_kind: 'reminder',
      status: 'success',
      turns: 2,
      configured_service_tier: 'priority',
      service_tier_ceiling_percent: 70,
      used_percent_at_start: 87,
      usage_source: 'cumulative_first_turn',
      requested_service_tier: 'priority',
      service_tier: 'priority',
      reasoning_effort: 'xhigh',
      used_percent: 88,
      codex_cli_version: '0.166.0',
    });
    expect(Number(ok.payload.duration_ms)).toBeGreaterThanOrEqual(0);
    expect(ok.payload_json).not.toMatch(/секрет|склад|сотрудниц/);

    // A run that died before codex wrote a rollout: still a row, an error,
    // its title made by the host from the date only.
    createTask({ id: 'task-tier-failed', ...taskBase, prompt: '<internal>сверь склад' });
    runnerMocks.accountUsedPercent.mockReset();
    runnerMocks.accountUsedPercent.mockReturnValue(null);
    runnerMocks.runSandboxAgent.mockImplementationOnce(async (_group, input) => {
      // No reading — no time either.
      expect(input.codex?.accountUsedPercent).toBeNull();
      expect(input.codex).not.toHaveProperty('accountReadingAtMs');
      expect(input.codex).not.toHaveProperty('accountWindows');
      return {
        status: 'error' as const,
        result: null,
        error: 'codex turn timed out after 900000ms',
      };
    });
    await runTask(getTaskById('task-tier-failed')!, deps);
    const failed = events()[1];
    expect(failed.payload).toMatchObject({
      task_id: 'task-tier-failed',
      task_title: 'Фоновая задача от 10.05 09:00',
      task_kind: 'background',
      status: 'error',
      turns: 0,
      configured_service_tier: 'priority',
      used_percent_at_start: null,
      usage_source: 'none',
    });
    expect(failed.payload).not.toHaveProperty('service_tier');

    // Fast off in .env: the run says so, with no ceiling.
    runnerMocks.loadModelGatewayConfig.mockReturnValue({
      codex: { command: '/opt/homebrew/bin/codex', model: 'gpt-5.6-sol' },
    });
    createTask({ id: 'task-tier-off', ...taskBase });
    runnerMocks.runSandboxAgent.mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'готово',
          codexTurn: { usageSource: 'cumulative_first_turn', requestedServiceTier: null, serviceTier: null },
        });
        return { status: 'success', result: null };
      },
    );
    await runTask(getTaskById('task-tier-off')!, deps);
    const off = events()[2];
    expect(off.payload).toMatchObject({
      task_id: 'task-tier-off',
      configured_service_tier: null,
      requested_service_tier: null,
      service_tier: null,
    });
    expect(off.payload).not.toHaveProperty('service_tier_ceiling_percent');
    // The chat checks read session_finished: a task run never writes one.
    expect(events().map((e) => e.type)).toEqual([
      'scheduled_task_finished',
      'scheduled_task_finished',
      'scheduled_task_finished',
    ]);

    // Not a Codex run (the provider switch off): no event.
    delete process.env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY;
    createTask({ id: 'task-tier-claude', ...taskBase });
    runnerMocks.runSandboxAgent.mockImplementationOnce(async () => ({
      status: 'success',
      result: 'готово',
    }));
    await runTask(getTaskById('task-tier-claude')!, deps);
    expect(events()).toHaveLength(3);
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
    // cancel_task is a soft cancel: the row stays with
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

  const adminDeps = (route: ReturnType<typeof vi.fn>, queue: any) => ({
    registeredGroups: () => ({
      'tg:100999': {
        name: 'Admin',
        folder: 'telegram_admin',
        trigger: '@Skoobi',
        added_at: '2026-05-10T09:00:00.000Z',
        runtime: 'sandbox' as const,
      },
    }),
    getSessions: () => ({}),
    queue,
    onProcess: vi.fn(),
    router: {
      route,
      send: async () => {},
      addPreHook: () => {},
      addPostHook: () => {},
    } as any,
  });

  it('W25: задача, остановленная кнопкой, пока ждала в очереди, не запускается', async () => {
    createTask({
      id: 'task-stopped-in-queue',
      group_folder: 'telegram_admin',
      chat_jid: 'tg:100999',
      prompt: '<internal>Продолжи работу',
      schedule_type: 'once',
      schedule_value: '2026-11-08T10:00:00',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-11-08T09:00:00.000Z',
    });
    // The scheduler captured the row at enqueue; the button cancels it later.
    const captured = getTaskById('task-stopped-in-queue')!;
    updateTask('task-stopped-in-queue', { status: 'cancelled', next_run: null });
    const route = vi.fn();

    await runTask(captured, adminDeps(route, taskQueueMock()));

    expect(runnerMocks.runSandboxAgent).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(getTaskById('task-stopped-in-queue')).toMatchObject({
      status: 'cancelled',
      next_run: null,
    });
    const runs = getDb()
      .prepare('SELECT COUNT(*) AS c FROM task_run_logs WHERE task_id = ?')
      .get('task-stopped-in-queue') as { c: number };
    expect(runs.c).toBe(0);
  });

  it('W25: прерванный кнопкой запуск — «stopped», не ошибка; повтор не назначается, извещения о сбое нет', async () => {
    // agent_runs is an extension table: applied here as production does.
    for (const sql of getExtensionDbSchema()) getDb().exec(sql);
    createTask({
      id: 'task-stopped-mid-run',
      group_folder: 'telegram_admin',
      chat_jid: 'tg:100999',
      prompt: '<internal>Слежка',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-11-08T09:00:00.000Z',
    });
    // The button: status first, then SIGTERM — the run dies with an error.
    runnerMocks.runSandboxAgent.mockImplementation(async () => {
      updateTask('task-stopped-mid-run', { status: 'cancelled', next_run: null });
      return { status: 'error', result: null, error: 'killed by SIGTERM' };
    });
    const route = vi.fn().mockResolvedValue('ok');
    const queue = { ...taskQueueMock(), isCancelRequested: vi.fn(() => true) };

    await runTask(getTaskById('task-stopped-mid-run')!, adminDeps(route, queue));

    expect(getTaskById('task-stopped-mid-run')).toMatchObject({
      status: 'cancelled',
      next_run: null,
    });
    expect(
      getDb()
        .prepare('SELECT status, error FROM task_run_logs WHERE task_id = ?')
        .all('task-stopped-mid-run'),
    ).toEqual([
      { status: 'stopped', error: 'Остановлено владельцем кнопкой' },
    ]);
    // agent_runs too: 'cancelled' like a chat turn stopped by «стоп», so the
    // reviews that count failures of the background by agent_runs do not take
    // the owner's stop for one.
    expect(
      getDb()
        .prepare("SELECT status FROM agent_runs WHERE trigger_type = 'scheduled'")
        .all(),
    ).toEqual([{ status: 'cancelled' }]);
    expect(route).not.toHaveBeenCalled();
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
  // Synthetic chat and folder; the shape: an hourly task due while a
  // 49-minute chat turn held the slot, then a 30-minute run of its own.
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
    // expire in the queue.
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
        // 30 minutes of heartbeats: the queue must hear
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


describe('пустые проверки без модели и срок слежки (W26)', () => {
  const FOLDER = 'telegram_admin';
  const CHAT = 'tg:100999';
  const groupDir = () =>
    path.join(process.env.SKOOBI_TEST_STATE_ROOT!, 'groups', FOLDER);
  const deps = (route: ReturnType<typeof vi.fn>) =>
    ({
      registeredGroups: () => ({
        [CHAT]: {
          name: 'Admin',
          folder: FOLDER,
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
    }) as any;

  const watchTask = (overrides: Record<string, unknown> = {}) => {
    createTask({
      id: 'task-watch',
      group_folder: FOLDER,
      chat_jid: CHAT,
      prompt: '<internal>Проверь, готова ли сборка',
      schedule_type: 'interval',
      schedule_value: '600000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1_000).toISOString(),
      status: 'active',
      created_at: '2026-11-08T09:00:00.000Z',
      title: 'Слежка за сборкой',
      task_kind: 'background',
      wake_if: JSON.stringify({ path_changed: 'output/READY.json' }),
      wake_state: JSON.stringify({
        last_wake_at: new Date(Date.now() - 3_600_000).toISOString(),
        path: { exists: false },
      }),
      ...overrides,
    });
    return getTaskById('task-watch')!;
  };

  beforeEach(() => {
    _initTestDatabase();
    for (const sql of getExtensionDbSchema()) getDb().exec(sql);
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    runnerMocks.runSandboxAgent.mockReset();
    runnerMocks.runContainerAgent.mockReset();
    runnerMocks.writeTasksSnapshot.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReturnValue({
      codex: { command: '/opt/homebrew/bin/codex', model: 'm', reasoningEffort: 'xhigh' },
    });
    fs.rmSync(groupDir(), { recursive: true, force: true });
    fs.mkdirSync(path.join(groupDir(), 'output'), { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('без изменений: skipped без модели и agent_runs, следующий запуск сдвинут, это не сбой', () => {
    const task = watchTask();
    expect(gateDueTask(task)).toEqual({ action: 'skipped' });

    const after = getTaskById('task-watch')!;
    expect(after.status).toBe('active');
    expect(Date.parse(after.next_run!)).toBeGreaterThan(Date.now());
    expect(after.last_result).toBe('Пропущено — без изменений');
    expect(
      getDb()
        .prepare('SELECT status, result FROM task_run_logs WHERE task_id = ?')
        .all('task-watch'),
    ).toEqual([{ status: 'skipped', result: 'Без изменений' }]);
    expect(
      (getDb().prepare('SELECT COUNT(*) AS c FROM agent_runs').get() as { c: number }).c,
    ).toBe(0);
    expect(runnerMocks.runSandboxAgent).not.toHaveBeenCalled();
  });

  it('«Запустить сейчас» из панели: слежка без изменений всё равно будит модель', () => {
    // The panel's task_run_now: next_run = now plus the run_now flag.
    const task = watchTask({
      wake_state: JSON.stringify({
        last_wake_at: new Date(Date.now() - 3_600_000).toISOString(),
        path: { exists: false },
        run_now: true,
      }),
    });
    const gate = gateDueTask(task);
    expect(gate.action).toBe('run');
    expect(gate.action === 'run' ? gate.wake?.reason : undefined).toBe('manual');
    expect(
      getDb()
        .prepare('SELECT COUNT(*) AS c FROM task_run_logs WHERE task_id = ?')
        .get('task-watch'),
    ).toEqual({ c: 0 });
  });

  it('пропуски не обрывают серию ошибок (автопауза после сбоев работает)', () => {
    watchTask();
    const log = (status: 'error' | 'skipped', at: string) =>
      logTaskRun({ task_id: 'task-watch', run_at: at, duration_ms: 1, status, result: null, error: status === 'error' ? 'x' : null });
    log('error', '2026-11-08T10:00:00.000Z');
    log('skipped', '2026-11-08T10:10:00.000Z');
    log('error', '2026-11-08T10:20:00.000Z');
    log('skipped', '2026-11-08T10:30:00.000Z');
    expect(consecutiveTaskFailures('task-watch')).toBe(2);
  });

  it('изменилось: модель будится, в начале задания — что изменилось; состояние сохраняется только после успеха', async () => {
    const task = watchTask();
    fs.writeFileSync(path.join(groupDir(), 'output', 'READY.json'), 'ok');
    const gate = gateDueTask(task);
    expect(gate.action).toBe('run');
    const wake = gate.action === 'run' ? gate.wake : undefined;
    expect(wake?.reason).toBe('changed');

    runnerMocks.runSandboxAgent.mockResolvedValueOnce({ status: 'error', result: null, error: 'boom' });
    await runTask(task, deps(vi.fn().mockResolvedValue('ok')), { wake });
    expect(runnerMocks.runSandboxAgent.mock.calls[0][1].prompt).toMatch(
      /^\[Хост: условие пробуждения сработало — появился «output\/READY\.json»/,
    );
    // After an error the change is not lost: the old state stays.
    expect(JSON.parse(getTaskById('task-watch')!.wake_state!).path).toEqual({ exists: false });

    runnerMocks.runSandboxAgent.mockResolvedValueOnce({ status: 'success', result: null });
    await runTask(getTaskById('task-watch')!, deps(vi.fn().mockResolvedValue('ok')), { wake });
    expect(JSON.parse(getTaskById('task-watch')!.wake_state!).path).toMatchObject({ exists: true, size: 2 });
  });

  it('срок вышел: задача закрыта без модели, в чат — короткое сообщение', async () => {
    const task = watchTask({
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(gateDueTask(task)).toEqual({ action: 'expired' });
    expect(getTaskById('task-watch')).toMatchObject({
      status: 'completed',
      next_run: null,
    });
    const route = vi.fn().mockResolvedValue('ok');
    await announceExpiredTask(task, { router: { route } as any });
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: CHAT,
        text: expect.stringMatching(/^⏹ Плановая задача «Слежка за сборкой» закончена: вышел её срок \(\d\d\.\d\d \d\d:\d\d\)\.$/),
        meta: { kind: 'task_expired' },
      }),
    );
    expect(runnerMocks.runSandboxAgent).not.toHaveBeenCalled();
  });

  it('следующий запуск после прогона не позже срока', async () => {
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const task = watchTask({ wake_if: null, wake_state: null, expires_at: expiresAt });
    runnerMocks.runSandboxAgent.mockResolvedValueOnce({ status: 'success', result: null });
    await runTask(task, deps(vi.fn().mockResolvedValue('ok')));
    expect(getTaskById('task-watch')!.next_run).toBe(expiresAt);
  });

  it('цикл планировщика: пропущенная проверка не занимает очередь чата, бронь снята', async () => {
    watchTask();
    const enqueueTask = vi.fn(() => true);
    startSchedulerLoop({
      ...deps(vi.fn()),
      queue: { enqueueTask, hasTask: () => false } as any,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(claimTaskForRun('task-watch')).toBe(true);
    releaseTaskLease('task-watch');
  });
});

// r1111, M-C34b-ш2: упавшая повторяющаяся задача не ждёт следующего слота —
// ежемесячное напоминание больше не пропадает на месяц.
describe('повтор упавшей cron/interval задачи (M-C34b-ш2)', () => {
  const FOLDER = 'telegram_admin';
  const CHAT = 'tg:100999';
  const deps = (route: ReturnType<typeof vi.fn>) =>
    ({
      registeredGroups: () => ({
        [CHAT]: {
          name: 'Admin',
          folder: FOLDER,
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
    }) as any;
  const REMINDER = 'Напомни: оплатить аренду склада до обеда';
  // Review r1111 (channels-1): a reminder's failure notice hands the reminder
  // over, so it gets no early retry; the retry tests use an ordinary task.
  const SUMMARY = 'Пришли сводку продаж склада за вчера';
  const recurring = (
    schedule_type: 'cron' | 'interval',
    schedule_value: string,
    next_run: string,
    prompt: string = REMINDER,
  ) => ({
    id: 'recurring-retry',
    group_folder: FOLDER,
    chat_jid: CHAT,
    prompt,
    schedule_type,
    schedule_value,
    context_mode: 'isolated' as const,
    next_run,
    last_run: null,
    last_result: null,
    status: 'active' as const,
    created_at: '2026-10-01T00:00:00.000Z',
  });

  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    runnerMocks.runSandboxAgent.mockReset();
    runnerMocks.runContainerAgent.mockReset();
    runnerMocks.writeTasksSnapshot.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReturnValue({
      codex: { command: '/opt/homebrew/bin/codex', model: 'm', reasoningEffort: 'xhigh' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ежемесячная задача после сбоя пробует снова через 5 и 10 минут, потом ждёт слота', () => {
    const now = Date.parse('2026-11-19T09:00:30.000Z');
    vi.setSystemTime(now);
    const task = recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z');
    expect(computeNextRunAfterTaskAttempt(task, true, now, 1)).toBe('2026-11-19T09:05:30.000Z');
    // Второй сбой — это упавший первый повтор (он уже был в серии).
    expect(computeNextRunAfterTaskAttempt(task, true, now, 2, 1)).toBe('2026-11-19T09:10:30.000Z');
    // Третий сбой подряд: дальше — обычное расписание, без частых повторов.
    expect(computeNextRunAfterTaskAttempt(task, true, now, 3, 2)).toBe('2026-12-19T09:00:00.000Z');
    expect(computeNextRunAfterTaskAttempt(task, false, now)).toBe('2026-12-19T09:00:00.000Z');
  });

  it('ранний повтор — только у первого упавшего слота серии (r1111, T2)', () => {
    const now = Date.parse('2026-11-19T09:00:30.000Z');
    vi.setSystemTime(now);
    const task = recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z');
    // Первый сбой серии повтора не получил (действие могло выполниться,
    // или текст уже ушёл в чат): второй сбой — обычный слот, без повтора.
    expect(computeNextRunAfterTaskAttempt(task, true, now, 2, 0)).toBe('2026-12-19T09:00:00.000Z');
    // Первый повтор был, а второй сбой серии уже ничего не получил.
    expect(computeNextRunAfterTaskAttempt(task, true, now, 3, 1)).toBe('2026-12-19T09:00:00.000Z');
  });

  it('повтор не позже обычного слота: частой задаче ранний повтор не нужен', () => {
    const now = Date.parse('2026-11-19T10:00:30.000Z');
    vi.setSystemTime(now);
    expect(
      computeNextRunAfterTaskAttempt(
        recurring('cron', '*/5 * * * *', '2026-11-19T10:00:00.000Z'),
        true,
        now,
        1,
      ),
    ).toBe('2026-11-19T10:05:00.000Z');
    expect(
      computeNextRunAfterTaskAttempt(
        recurring('interval', '3600000', '2026-11-19T10:00:00.000Z'),
        true,
        now,
        1,
      ),
    ).toBe('2026-11-19T10:05:30.000Z');
  });

  it('пауза повторяющейся задачи — после пяти упавших слотов, а не после повторов одного', () => {
    const now = Date.parse('2026-11-19T09:00:30.000Z');
    vi.setSystemTime(now);
    const task = recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z');
    // 3 попытки первого слота + 3 следующих слота = 6 — ещё не пауза.
    expect(computeNextRunAfterTaskAttempt(task, true, now, 6, 2)).toBe('2026-12-19T09:00:00.000Z');
    // Пятый упавший слот подряд (7 попыток) — пауза, как и раньше после пяти.
    expect(computeNextRunAfterTaskAttempt(task, true, now, 7, 2)).toBeNull();
    // Один повтор в серии — порог 6.
    expect(computeNextRunAfterTaskAttempt(task, true, now, 5, 1)).toBe('2026-12-19T09:00:00.000Z');
    expect(computeNextRunAfterTaskAttempt(task, true, now, 6, 1)).toBeNull();
  });

  it('без ранних повторов порог — пять сбоев, а не семь (r1111, T2)', () => {
    const now = Date.parse('2026-11-19T09:00:30.000Z');
    vi.setSystemTime(now);
    const daily = recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z');
    expect(computeNextRunAfterTaskAttempt(daily, true, now, 4, 0)).toBe('2026-12-19T09:00:00.000Z');
    expect(computeNextRunAfterTaskAttempt(daily, true, now, 5, 0)).toBeNull();
    // Задача каждые 5 минут ранних повторов не получает никогда: пауза на 5-м.
    const frequent = recurring('cron', '*/5 * * * *', '2026-11-19T09:00:00.000Z');
    expect(computeNextRunAfterTaskAttempt(frequent, true, now, 4, 0)).toBe('2026-11-19T09:05:00.000Z');
    expect(computeNextRunAfterTaskAttempt(frequent, true, now, 5, 0)).toBeNull();
  });

  it('прогон: упавшая задача повторяется через 5 минут, в чате — когда', async () => {
    vi.setSystemTime(Date.parse('2026-11-19T09:00:30.000Z'));
    createTask({
      ...recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z', SUMMARY),
    });
    runnerMocks.runSandboxAgent.mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'spawn failed',
    });
    const route = vi.fn().mockResolvedValue('ok');

    await runTask(getTaskById('recurring-retry')!, deps(route));

    const after = getTaskById('recurring-retry')!;
    expect(after.status).toBe('active');
    expect(after.next_run).toBe('2026-11-19T09:05:30.000Z');
    expect(route).toHaveBeenCalledTimes(1);
    const text = route.mock.calls[0][0].text as string;
    expect(text).toContain(SUMMARY);
    expect(text).toContain('Попробую ещё раз через 5 мин.');
    expect(text).not.toContain('Попробую снова по расписанию.');
  });

  it('сбой ДО запуска агента у повторяющейся задачи тоже даёт ранний повтор', async () => {
    vi.setSystemTime(Date.parse('2026-11-19T09:00:30.000Z'));
    createTask({
      ...recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z', SUMMARY),
    });
    const route = vi.fn().mockResolvedValue('ok');

    await finalizeUnhandledTaskFailure(
      getTaskById('recurring-retry')!,
      deps(route),
      new Error('EACCES'),
      Date.now() - 1_000,
    );

    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-11-19T09:05:30.000Z');
    expect(route.mock.calls[0][0].text).toContain('Попробую ещё раз через 5 мин.');
  });

  const runLogErrors = () =>
    (
      getDb()
        .prepare('SELECT error FROM task_run_logs WHERE task_id = ? ORDER BY id')
        .all('recurring-retry') as Array<{ error: string | null }>
    ).map((row) => row.error);

  it('прогон: серия — слот и два повтора, потом ещё четыре слота, пауза на пятом слоте (r1111, T2)', async () => {
    vi.setSystemTime(Date.parse('2026-11-19T09:00:30.000Z'));
    createTask({ ...recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z', SUMMARY) });
    runnerMocks.runSandboxAgent.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'spawn failed',
    });
    const route = vi.fn().mockResolvedValue('ok');
    const runAt = async (iso: string) => {
      vi.setSystemTime(Date.parse(iso));
      await runTask(getTaskById('recurring-retry')!, deps(route));
      return getTaskById('recurring-retry')!;
    };

    expect((await runAt('2026-11-19T09:00:30.000Z')).next_run).toBe('2026-11-19T09:05:30.000Z');
    expect((await runAt('2026-11-19T09:05:40.000Z')).next_run).toBe('2026-11-19T09:15:40.000Z');
    expect(route.mock.calls[1][0].text).toContain('Попробую ещё раз через 10 мин.');
    expect((await runAt('2026-11-19T09:15:50.000Z')).next_run).toBe('2026-12-19T09:00:00.000Z');
    // Только прогоны, после которых назначен ранний повтор, помечены в журнале.
    expect(runLogErrors()).toEqual([
      `${EARLY_RETRY_LOG_MARK}spawn failed`,
      `${EARLY_RETRY_LOG_MARK}spawn failed`,
      'spawn failed',
    ]);
    expect((await runAt('2026-12-19T09:00:30.000Z')).status).toBe('active');
    expect((await runAt('2027-01-19T09:00:30.000Z')).status).toBe('active');
    expect((await runAt('2027-02-19T09:00:30.000Z')).status).toBe('active');
    expect(await runAt('2027-03-19T09:00:30.000Z')).toMatchObject({ status: 'paused', next_run: null });
    expect(route.mock.calls.at(-1)?.[0].text).toContain('не выполнилась 7 раз подряд');
  });

  it('прогон: после сбоя с возможным внешним действием повторов нет, пауза на пятом слоте (r1111, T2)', async () => {
    createTask({ ...recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z') });
    runnerMocks.runSandboxAgent.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'codex turn timed out after 1800000ms',
      sideEffected: true,
    });
    const route = vi.fn().mockResolvedValue('ok');
    const slots = [
      '2026-11-19T09:00:30.000Z',
      '2026-12-19T09:00:30.000Z',
      '2027-01-19T09:00:30.000Z',
      '2027-02-19T09:00:30.000Z',
    ];
    for (const at of slots) {
      vi.setSystemTime(Date.parse(at));
      await runTask(getTaskById('recurring-retry')!, deps(route));
      expect(getTaskById('recurring-retry')!.status).toBe('active');
    }
    vi.setSystemTime(Date.parse('2027-03-19T09:00:30.000Z'));
    await runTask(getTaskById('recurring-retry')!, deps(route));

    expect(getTaskById('recurring-retry')).toMatchObject({ status: 'paused', next_run: null });
    expect(runLogErrors().some((error) => error?.startsWith(EARLY_RETRY_LOG_MARK))).toBe(false);
  });

  it('прогон: следующий слот после сбоя с внешним действием не получает раннего повтора (r1111, T2)', async () => {
    createTask({ ...recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z') });
    const route = vi.fn().mockResolvedValue('ok');
    runnerMocks.runSandboxAgent.mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'codex turn timed out after 1800000ms',
      sideEffected: true,
    });
    vi.setSystemTime(Date.parse('2026-11-19T09:30:30.000Z'));
    await runTask(getTaskById('recurring-retry')!, deps(route));
    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-12-19T09:00:00.000Z');

    runnerMocks.runSandboxAgent.mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'spawn failed',
    });
    vi.setSystemTime(Date.parse('2026-12-19T09:00:30.000Z'));
    await runTask(getTaskById('recurring-retry')!, deps(route));

    expect(getTaskById('recurring-retry')!.next_run).toBe('2027-01-19T09:00:00.000Z');
    expect(route.mock.calls.at(-1)?.[0].text).toContain('Попробую снова по расписанию.');
  });

  // Review r1111 (channels-1): the notice of a failed reminder carries the
  // reminder; with early retries the person got it two or three times in 15
  // minutes (the only active prod task is such a monthly reminder).
  it('прогон: упавшее напоминание приходит один раз — в извещении, следующий запуск по расписанию (r1111, channels-1)', async () => {
    vi.setSystemTime(Date.parse('2026-11-19T09:00:30.000Z'));
    createTask({ ...recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z') });
    runnerMocks.runSandboxAgent.mockResolvedValueOnce({
      status: 'error', result: null, error: 'stream disconnected before completion',
    });
    const route = vi.fn().mockResolvedValue('ok');

    await runTask(getTaskById('recurring-retry')!, deps(route));

    expect(getTaskById('recurring-retry')).toMatchObject({ status: 'active', next_run: '2026-12-19T09:00:00.000Z' });
    expect(route).toHaveBeenCalledTimes(1);
    const text = route.mock.calls[0][0].text as string;
    expect(text).toContain('оплатить аренду склада до обеда');
    expect(text).toContain('Попробую снова по расписанию.');
    expect(runLogErrors().some((entry) => entry?.startsWith(EARLY_RETRY_LOG_MARK))).toBe(false);
  });

  it('извещение с напоминанием не дошло — ранний повтор возвращается (r1111, channels-1)', async () => {
    vi.setSystemTime(Date.parse('2026-11-19T09:00:30.000Z'));
    createTask({ ...recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z') });
    runnerMocks.runSandboxAgent.mockResolvedValueOnce({
      status: 'error', result: null, error: 'stream disconnected before completion',
    });
    const route = vi.fn().mockResolvedValue(null);

    await runTask(getTaskById('recurring-retry')!, deps(route));

    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-11-19T09:05:30.000Z');
    expect(runLogErrors()[0]?.startsWith(EARLY_RETRY_LOG_MARK)).toBe(true);
    // Извещение упало с ошибкой — то же самое.
    vi.setSystemTime(Date.parse('2026-11-19T09:05:40.000Z'));
    runnerMocks.runSandboxAgent.mockResolvedValueOnce({
      status: 'error', result: null, error: 'stream disconnected before completion',
    });
    await runTask(getTaskById('recurring-retry')!, deps(vi.fn().mockRejectedValue(new Error('telegram down'))));
    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-11-19T09:15:40.000Z');
  });

  // Review r1111 delta (turnflow-3): the retry came back only for the first
  // failed slot of a streak; on the second day the reminder was lost silently.
  it('извещение не дошло во втором упавшем слоте серии — ранний повтор всё равно есть (ревью r1111 дельта, turnflow-3)', async () => {
    const daily = { ...recurring('cron', '0 9 * * *', '2026-11-19T09:00:00.000Z') };
    createTask(daily);
    runnerMocks.runSandboxAgent.mockResolvedValue({
      status: 'error', result: null, error: 'stream disconnected before completion',
    });
    vi.setSystemTime(Date.parse('2026-11-19T09:00:30.000Z'));
    await runTask(getTaskById('recurring-retry')!, deps(vi.fn().mockResolvedValue('ok')));
    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-11-20T09:00:00.000Z');

    vi.setSystemTime(Date.parse('2026-11-20T09:00:30.000Z'));
    await runTask(getTaskById('recurring-retry')!, deps(vi.fn().mockResolvedValue(null)));
    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-11-20T09:05:30.000Z');
    expect(runLogErrors()[1]?.startsWith(EARLY_RETRY_LOG_MARK)).toBe(true);

    // The retry fails too and its notice gets through: the next slot.
    vi.setSystemTime(Date.parse('2026-11-20T09:05:40.000Z'));
    await runTask(getTaskById('recurring-retry')!, deps(vi.fn().mockResolvedValue('ok')));
    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-11-21T09:00:00.000Z');

    // Same before the agent starts, the router throwing: the second retry of
    // the streak, in 10 min.
    vi.setSystemTime(Date.parse('2026-11-21T09:00:30.000Z'));
    await finalizeUnhandledTaskFailure(
      getTaskById('recurring-retry')!,
      deps(vi.fn().mockRejectedValue(new Error('telegram down'))),
      new Error('EACCES'),
      Date.now() - 1_000,
    );
    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-11-21T09:10:30.000Z');

    // Two retries per streak at most: then the next slot.
    vi.setSystemTime(Date.parse('2026-11-21T09:10:40.000Z'));
    await runTask(getTaskById('recurring-retry')!, deps(vi.fn().mockResolvedValue(null)));
    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-11-22T09:00:00.000Z');
    expect(getTaskById('recurring-retry')!.status).toBe('active');
  });

  it('сбой ДО запуска агента у напоминания — тоже одно извещение и обычный слот (r1111, channels-1)', async () => {
    vi.setSystemTime(Date.parse('2026-11-19T09:00:30.000Z'));
    createTask({ ...recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z') });
    const route = vi.fn().mockResolvedValue('ok');

    await finalizeUnhandledTaskFailure(getTaskById('recurring-retry')!, deps(route), new Error('EACCES'), Date.now() - 1_000);

    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-12-19T09:00:00.000Z');
    expect(route.mock.calls[0][0].text).toContain('Попробую снова по расписанию.');
    expect(route.mock.calls[0][0].text).toContain('оплатить аренду склада до обеда');

    // Не дошло — повтор через 5 мин.
    createTask({ ...recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z'), id: 'recurring-retry-2' });
    await finalizeUnhandledTaskFailure(getTaskById('recurring-retry-2')!, deps(vi.fn().mockResolvedValue(null)), new Error('EACCES'), Date.now() - 1_000);
    expect(getTaskById('recurring-retry-2')!.next_run).toBe('2026-11-19T09:05:30.000Z');
  });

  it('пять упавших слотов ежемесячного напоминания — пауза на пятом, пять сообщений (r1111, channels-1)', async () => {
    createTask({ ...recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z') });
    runnerMocks.runSandboxAgent.mockResolvedValue({ status: 'error', result: null, error: 'spawn failed' });
    const route = vi.fn().mockResolvedValue('ok');
    for (const at of ['2026-11-19', '2026-12-19', '2027-01-19', '2027-02-19']) {
      vi.setSystemTime(Date.parse(`${at}T09:00:30.000Z`));
      await runTask(getTaskById('recurring-retry')!, deps(route));
      expect(getTaskById('recurring-retry')!.status).toBe('active');
    }
    vi.setSystemTime(Date.parse('2027-03-19T09:00:30.000Z'));
    await runTask(getTaskById('recurring-retry')!, deps(route));
    expect(getTaskById('recurring-retry')).toMatchObject({ status: 'paused', next_run: null });
    expect(route).toHaveBeenCalledTimes(5);
    expect(route.mock.calls.at(-1)?.[0].text).toContain('поставлена на паузу');
  });

  // Review r1111 (channels-2): the host counts only claudeclaw MCP actions as
  // side effects; a run that clicked through osascript/cliclick or sent with
  // curl and then timed out was retried in 5 minutes and did it again.
  const shellObservation = (phase: 'started' | 'finished', callId: string) => ({
    status: 'heartbeat' as const,
    result: null,
    toolObservation: { phase, callId, family: 'shell' as const, startedObserved: true, source: 'codex_cli' as const },
  });
  const hourly = () => ({ ...recurring('cron', '0 9-21 * * *', '2026-11-19T09:30:00.000Z'), prompt: 'Опубликуй пост дня в канале' });

  it('прогон: упавший после команд оболочки — ждёт своего слота, без раннего повтора (r1111, channels-2)', async () => {
    vi.setSystemTime(Date.parse('2026-11-19T09:30:30.000Z'));
    createTask(hourly());
    const error = 'codex turn timed out after 1800000ms';
    runnerMocks.runSandboxAgent.mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
      await onOutput?.(shellObservation('started', 'c1'));
      await onOutput?.(shellObservation('finished', 'c1'));
      await onOutput?.({ status: 'error', result: null, error, sideEffected: false });
      return { status: 'error', result: null, error, sideEffected: false };
    });
    const route = vi.fn().mockResolvedValue('ok');

    await runTask(getTaskById('recurring-retry')!, deps(route));

    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-11-19T10:00:00.000Z');
    expect(route.mock.calls.at(-1)?.[0].text).toContain('Попробую снова по расписанию.');
    expect(runLogErrors().some((entry) => entry?.startsWith(EARLY_RETRY_LOG_MARK))).toBe(false);
  });

  // Review r1111 delta (turnflow-2): a reminder whose notice did not get
  // through got its early retry back even after shell commands.
  it('напоминание после команд оболочки: извещение не дошло — повтора всё равно нет (ревью r1111 дельта, turnflow-2)', async () => {
    vi.setSystemTime(Date.parse('2026-11-19T09:00:30.000Z'));
    createTask({ ...recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z') });
    const error = 'codex turn timed out after 1800000ms';
    runnerMocks.runSandboxAgent.mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
      await onOutput?.(shellObservation('started', 'c1'));
      await onOutput?.(shellObservation('finished', 'c1'));
      return { status: 'error', result: null, error, sideEffected: false };
    });
    const route = vi.fn().mockResolvedValue(null);

    await runTask(getTaskById('recurring-retry')!, deps(route));

    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-12-19T09:00:00.000Z');
    expect(runLogErrors().some((entry) => entry?.startsWith(EARLY_RETRY_LOG_MARK))).toBe(false);
  });

  it('прогон: «нет движения» после одной curl-команды — тоже без раннего повтора (r1111, channels-2)', async () => {
    vi.setSystemTime(Date.parse('2026-11-19T09:30:30.000Z'));
    createTask(hourly());
    const error = 'codex turn timed out: no activity for 600000ms';
    runnerMocks.runSandboxAgent.mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
      await onOutput?.(shellObservation('started', 'curl-1'));
      return { status: 'error', result: null, error };
    });
    const route = vi.fn().mockResolvedValue('ok');

    await runTask(getTaskById('recurring-retry')!, deps(route));

    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-11-19T10:00:00.000Z');
  });

  it('прогон: без живых кадров оболочки хватает телеметрии хода (экран, acted:command_execution)', async () => {
    vi.setSystemTime(Date.parse('2026-11-19T09:30:30.000Z'));
    createTask(hourly());
    const error = 'codex turn timed out after 1800000ms';
    runnerMocks.runSandboxAgent.mockResolvedValueOnce({
      status: 'error', result: null, error,
      codexTurn: { screenControlCommands: { osascript: 2, cliclick: 3 } },
    });
    const route = vi.fn().mockResolvedValue('ok');
    await runTask(getTaskById('recurring-retry')!, deps(route));
    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-11-19T10:00:00.000Z');

    vi.setSystemTime(Date.parse('2026-11-19T10:00:30.000Z'));
    runnerMocks.runSandboxAgent.mockResolvedValueOnce({
      status: 'error', result: null, error: 'stream disconnected before completion',
      codexTurn: { transientRetrySkipped: 'acted:command_execution' },
    });
    await runTask(getTaskById('recurring-retry')!, deps(route));
    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-11-19T11:00:00.000Z');
  });

  it('прогон: сбой до первой команды по-прежнему даёт ранний повтор (r1111, channels-2)', async () => {
    vi.setSystemTime(Date.parse('2026-11-19T09:30:30.000Z'));
    createTask(hourly());
    runnerMocks.runSandboxAgent.mockResolvedValueOnce({
      status: 'error', result: null, error: 'stream disconnected before completion',
    });
    const route = vi.fn().mockResolvedValue('ok');
    await runTask(getTaskById('recurring-retry')!, deps(route));
    expect(getTaskById('recurring-retry')!.next_run).toBe('2026-11-19T09:35:30.000Z');
  });

  it('прогон: задача уже прислала текст и упала — ждёт своего слота, без раннего повтора (r1111, T4)', async () => {
    vi.setSystemTime(Date.parse('2026-11-19T09:00:30.000Z'));
    createTask({ ...recurring('cron', '0 9 19 * *', '2026-11-19T09:00:00.000Z') });
    runnerMocks.runSandboxAgent.mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({ status: 'success', result: 'Сводка: продажи 120 000 ₸' });
        await onOutput?.({
          status: 'error',
          result: null,
          error: 'codex turn timed out: no activity for 600000ms',
        });
        return {
          status: 'error',
          result: null,
          error: 'codex turn timed out: no activity for 600000ms',
        };
      },
    );
    const route = vi.fn().mockResolvedValue('ok');

    await runTask(getTaskById('recurring-retry')!, deps(route));

    expect(getTaskById('recurring-retry')).toMatchObject({
      status: 'active',
      next_run: '2026-12-19T09:00:00.000Z',
    });
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0][0].text).toBe('Сводка: продажи 120 000 ₸');
    expect(runLogErrors()).toEqual(['codex turn timed out: no activity for 600000ms']);
  });

  // Сверка метки со сторожем (scripts/skoobi-deadman.mjs) живёт в
  // setup/deadman-early-retry-mark.test.ts: сторожа в поставке нет.
});

// r1111, M-C18a: извещение после обрыва по времени называет причину, а
// повторяющаяся задача после «могло уже выполниться» не встаёт на паузу:
// следующий слот — новое событие, а не повтор.
describe('обрыв плановой задачи: причина и пауза только у разовой (M-C18a)', () => {
  const FOLDER = 'telegram_admin';
  const CHAT = 'tg:100999';
  const TIMEOUT = 'codex turn timed out after 1800000ms';
  const deps = (route: ReturnType<typeof vi.fn>) =>
    ({
      registeredGroups: () => ({
        [CHAT]: {
          name: 'Admin',
          folder: FOLDER,
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
    }) as any;
  const makeTask = (schedule_type: 'cron' | 'once', schedule_value: string) => {
    createTask({
      id: 'task-uncertain',
      group_folder: FOLDER,
      chat_jid: CHAT,
      prompt: 'Опубликуй пост в канале и проверь, что он вышел',
      schedule_type,
      schedule_value,
      context_mode: 'isolated',
      next_run: '2026-11-19T09:00:00.000Z',
      status: 'active',
      created_at: '2026-10-01T00:00:00.000Z',
    });
    return getTaskById('task-uncertain')!;
  };

  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-11-19T09:30:30.000Z'));
    runnerMocks.runSandboxAgent.mockReset();
    runnerMocks.runContainerAgent.mockReset();
    runnerMocks.writeTasksSnapshot.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReturnValue({
      codex: { command: '/opt/homebrew/bin/codex', model: 'm', reasoningEffort: 'xhigh' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const notice = (
    error: string,
    outcome: Parameters<typeof taskFailureNoticeText>[0]['outcome'],
  ) =>
    taskFailureNoticeText({
      prompt: 'Опубликуй пост в канале',
      error,
      outcome,
      failureCount: 1,
    });

  it('«могло уже выполниться» теперь с причиной: не уложилась в 30 мин', () => {
    const text = notice(TIMEOUT, 'uncertain');
    expect(text).toContain('внешнее действие могло уже выполниться');
    expect(text).toContain('Причина: не уложилась в отведённые 30 мин');
    expect(text).not.toContain('1800000ms');
    expect(notice('test failure', 'uncertain')).toContain('Причина: test failure');
  });

  it('обрывы по времени — простыми словами и в остальных извещениях', () => {
    expect(notice(TIMEOUT, 'paused')).toContain('Ошибка: не уложилась в отведённые 30 мин');
    expect(notice('codex turn timed out: no activity for 600000ms', 'retry')).toContain(
      'Ошибка: 10 мин не было никакого движения, работа остановлена',
    );
    expect(notice('Sandbox timed out after 1920000ms', 'stopped')).toContain(
      'Ошибка: не уложилась в отведённые 32 мин',
    );
    expect(notice('Container timed out with no output', 'retry')).toContain(
      'Ошибка: долго не было никакого ответа, работа остановлена',
    );
    expect(notice('spawn failed', 'retry')).toContain('Ошибка: spawn failed');
  });

  it('cron-задача после обрыва с внешним действием не встаёт на паузу, ждёт следующего слота', async () => {
    makeTask('cron', '0 9 19 * *');
    runnerMocks.runSandboxAgent.mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: TIMEOUT,
      sideEffected: true,
    });
    const route = vi.fn().mockResolvedValue('ok');

    await runTask(getTaskById('task-uncertain')!, deps(route));

    const after = getTaskById('task-uncertain')!;
    expect(after.status).toBe('active');
    // Без раннего повтора: действие могло уже выполниться.
    expect(after.next_run).toBe('2026-12-19T09:00:00.000Z');
    expect(route).toHaveBeenCalledTimes(1);
    const text = route.mock.calls[0][0].text as string;
    expect(route.mock.calls[0][0].meta).toEqual({ kind: 'task_failure_notice' });
    expect(text).toContain('внешнее действие (отправка, клик) могло уже выполниться');
    expect(text).toContain('не уложилась в отведённые 30 мин');
    expect(text).toContain('Следующий запуск — по расписанию.');
    expect(text).not.toContain('остановлена');
  });

  it('извещение приходит, даже если упавший прогон что-то написал в чат', async () => {
    makeTask('cron', '0 9 19 * *');
    runnerMocks.runSandboxAgent.mockResolvedValueOnce({
      status: 'error',
      result: 'Начал публикацию…',
      error: TIMEOUT,
      sideEffected: true,
    });
    const route = vi.fn().mockResolvedValue('ok');

    await runTask(getTaskById('task-uncertain')!, deps(route));

    expect(route.mock.calls.at(-1)?.[0].text).toContain(
      'могло уже выполниться',
    );
  });

  it('пять упавших слотов подряд — пауза и у повторяющейся', async () => {
    makeTask('cron', '0 9 19 * *');
    for (let i = 0; i < 6; i += 1) {
      logTaskRun({
        task_id: 'task-uncertain',
        run_at: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
        duration_ms: 5,
        status: 'error',
        result: null,
        error: 'boom',
      });
    }
    runnerMocks.runSandboxAgent.mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: TIMEOUT,
      sideEffected: true,
    });
    const route = vi.fn().mockResolvedValue('ok');

    await runTask(getTaskById('task-uncertain')!, deps(route));

    expect(getTaskById('task-uncertain')).toMatchObject({ status: 'paused', next_run: null });
  });

  it('разовая задача после обрыва с внешним действием по-прежнему встаёт на паузу', async () => {
    makeTask('once', '2026-11-19T09:00:00.000Z');
    runnerMocks.runSandboxAgent.mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: TIMEOUT,
      sideEffected: true,
    });
    const route = vi.fn().mockResolvedValue('ok');

    await runTask(getTaskById('task-uncertain')!, deps(route));

    expect(getTaskById('task-uncertain')).toMatchObject({ status: 'paused', next_run: null });
    const text = route.mock.calls[0][0].text as string;
    expect(text).toContain('Задача остановлена после ошибки');
    expect(text).toContain('Причина: не уложилась в отведённые 30 мин');
  });
});

// r1111, M-C32a: задача, которая сама записала провал только в <internal>,
// больше не проходит молча.
describe('скрытый провал плановой задачи виден одной строкой (M-C32a)', () => {
  const FOLDER = 'telegram_admin';
  const CHAT = 'tg:100999';
  // Выдуманные итоги: первое предложение сообщает о провале, дальше — подробности.
  const HIDDEN_FAILURE_FIRST =
    '<internal>Отчёт не опубликован: страница канала не открылась, заголовок сверить ' +
    'не удалось. Черновик сохранён в drafts/report.md. Остановлено без отправки и без ' +
    'повторов.</internal>';
  const HIDDEN_FAILURE_SECOND =
    '<internal>Вторая попытка: публикация остановлена — окно входа не открылось, отправок не было. ' +
    'Без повторов. Черновик лежит в drafts/report.md.</internal>';
  // Выдуманные «тихие» итоги: проверка без новостей — не провал, хотя слова
  // «не отправлял», «не подтверждена», «не выполнял», «не было» в них есть.
  const QUIET = [
    '<internal>Без новых изменений</internal>',
    '<internal>Новых изменений для отчёта нет.</internal>',
    '<internal>Новых сообщений по заказу нет; заказчику ничего не отправлял. Приёмка пока не подтверждена. Состояние сохранено, следующая проверка назначена на 18:00.</internal>',
    '<internal>Готовность ещё не объявлена; в папке появились новые правки. Итоговую проверку и доставку не выполнял.</internal>',
    '<internal>Проверка сохранена: все 12 файлов совпали по контрольной сумме. Новых запусков, отправок и публикаций не было.</internal>',
    '<internal>Проверены 4 загруженных файла; один завершился ошибкой обработки. Ошибки и снимки экрана сохранены.</internal>',
  ];

  const deps = (route: ReturnType<typeof vi.fn>) =>
    ({
      registeredGroups: () => ({
        [CHAT]: {
          name: 'Admin',
          folder: FOLDER,
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
    }) as any;
  // Как настоящий роутер: текст целиком в <internal> никуда не уходит.
  const routeLikeRouter = () =>
    vi.fn(async (envelope: { text: string }) =>
      envelope.text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim() || null,
    );
  const makeTask = () => {
    createTask({
      id: 'task-channel-post',
      group_folder: FOLDER,
      chat_jid: CHAT,
      prompt: 'Опубликуй тестовый пост в канале @example',
      schedule_type: 'once',
      schedule_value: '2026-03-10T15:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-03-08T09:00:00.000Z',
      title: 'Пост в @example',
    });
    return getTaskById('task-channel-post')!;
  };
  const succeedWith = (result: string) =>
    runnerMocks.runSandboxAgent.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({ status: 'success', result });
        return { status: 'success', result, newSessionId: 's1' };
      },
    );

  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    runnerMocks.runSandboxAgent.mockReset();
    runnerMocks.runContainerAgent.mockReset();
    runnerMocks.writeTasksSnapshot.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReset();
    runnerMocks.loadModelGatewayConfig.mockReturnValue({
      codex: { command: '/opt/homebrew/bin/codex', model: 'm', reasoningEffort: 'xhigh' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('находит фразу о провале в скрытом итоге', () => {
    expect(hiddenTaskFailureSentence(HIDDEN_FAILURE_FIRST)).toBe(
      'Отчёт не опубликован: страница канала не открылась, заголовок сверить не удалось.',
    );
    expect(hiddenTaskFailureSentence(HIDDEN_FAILURE_SECOND)).toBe(
      'Вторая попытка: публикация остановлена — окно входа не открылось, отправок не было.',
    );
  });

  // Review r1111 (security-5): the hidden sentence goes to the task's chat
  // (maybe a group) and to the messages history: masked like «⏳ Сейчас».
  it('пароль из скрытой фразы о провале в чат не уходит', () => {
    const pw = 'Qx7' + 'mZ-pl9r';
    const sentence = hiddenTaskFailureSentence(
      `<internal>Проверил кабинет. Не удалось войти в личный кабинет: логин admin, пароль ${pw} не подошёл.</internal>`,
    );
    expect(sentence).toContain('Не удалось войти');
    expect(sentence).toContain('[скрыто]');
    expect(sentence).not.toContain(pw);
    // Пароль на границе 300 знаков не попадает в чат и половиной.
    const long = hiddenTaskFailureSentence(
      `<internal>Не удалось войти ${'в кабинет '.repeat(27)}пароль ${pw} не подошёл.</internal>`,
    );
    expect(long).not.toContain(pw.slice(0, 4));
  });

  it('тихий итог без провала и видимый текст — не скрытый провал', () => {
    for (const quiet of QUIET) expect(hiddenTaskFailureSentence(quiet)).toBeNull();
    expect(
      hiddenTaskFailureSentence(`${HIDDEN_FAILURE_FIRST}\nНе получилось опубликовать пост.`),
    ).toBeNull();
    expect(hiddenTaskFailureSentence('')).toBeNull();
  });

  it('прогон: одна видимая строка с названием задачи и её итогом', async () => {
    makeTask();
    succeedWith(HIDDEN_FAILURE_FIRST);
    const route = routeLikeRouter();

    await runTask(getTaskById('task-channel-post')!, deps(route));

    const notices = route.mock.calls
      .map((call) => call[0] as { text: string; meta?: unknown })
      .filter((envelope) => envelope.meta !== undefined);
    expect(notices).toHaveLength(1);
    expect(notices[0].meta).toEqual({ kind: 'task_hidden_failure_notice' });
    expect(notices[0].text).toBe(
      '⚠️ Плановая задача «Пост в @example» не довела дело до конца и ничего не написала в чат. ' +
        'Её итог: «Отчёт не опубликован: страница канала не открылась, заголовок сверить не удалось.»',
    );
    // Прогон остаётся успешным: это не сбой хоста, а итог самой задачи.
    const log = getDb()
      .prepare('SELECT status FROM task_run_logs WHERE task_id = ?')
      .get('task-channel-post') as { status: string };
    expect(log.status).toBe('success');
  });

  const succeedWithTools = (result: string, sideEffectTools: string[]) =>
    runnerMocks.runSandboxAgent.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({ status: 'success', result, sideEffected: true, sideEffectTools });
        return { status: 'success', result, newSessionId: 's1', sideEffected: true, sideEffectTools };
      },
    );
  const MAIL_FAILURE =
    '<internal>Не удалось войти в почту, сообщил владельцу через send_message.</internal>';

  it('задача сама написала в чат через send_message — второго извещения нет (r1111, T1)', async () => {
    makeTask();
    succeedWithTools(MAIL_FAILURE, ['send_message']);
    const route = routeLikeRouter();

    await runTask(getTaskById('task-channel-post')!, deps(route));

    expect(
      route.mock.calls.filter((call) => (call[0] as { meta?: unknown }).meta !== undefined),
    ).toHaveLength(0);
  });

  it('фото или документ задачи — тоже её собственное сообщение (r1111, T1)', async () => {
    for (const tool of ['send_photo', 'send_document', 'send_voice_message', 'send_voice_audio']) {
      _initTestDatabase();
      makeTask();
      succeedWithTools(MAIL_FAILURE, [tool]);
      const route = routeLikeRouter();
      await runTask(getTaskById('task-channel-post')!, deps(route));
      expect(
        route.mock.calls.filter((call) => (call[0] as { meta?: unknown }).meta !== undefined),
      ).toHaveLength(0);
    }
  });

  it('memory_save сам по себе извещение не гасит (r1111, T1)', async () => {
    makeTask();
    succeedWithTools(MAIL_FAILURE, ['memory_save']);
    const route = routeLikeRouter();

    await runTask(getTaskById('task-channel-post')!, deps(route));

    const notices = route.mock.calls
      .map((call) => call[0] as { text: string; meta?: unknown })
      .filter((envelope) => envelope.meta !== undefined);
    expect(notices).toHaveLength(1);
    expect(notices[0].meta).toEqual({ kind: 'task_hidden_failure_notice' });
    expect(notices[0].text).toContain('Не удалось войти в почту');
  });

  it('прогон: тихая проверка без новостей ничего не пишет', async () => {
    makeTask();
    succeedWith(QUIET[2]);
    const route = routeLikeRouter();

    await runTask(getTaskById('task-channel-post')!, deps(route));

    expect(
      route.mock.calls.filter((call) => (call[0] as { meta?: unknown }).meta !== undefined),
    ).toHaveLength(0);
  });
});
