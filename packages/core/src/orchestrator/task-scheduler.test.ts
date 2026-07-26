import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getDb,
  getTaskById,
} from './db.js';
import {
  _resetSchedulerLoopForTests,
  SCHEDULER_RESTART_GATE_TASK_ID,
  claimTaskForRun,
  computeLeaseTtlMs,
  computeNextRun,
  computeNextRunAfterTaskAttempt,
  releaseTaskLease,
  runTask,
  scheduledTaskChatId,
  startSchedulerLoop,
} from './task-scheduler.js';

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
      queue: { enqueueTask } as any,
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
      group_folder: 'guest_example',
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
      queue: { notifyIdle: vi.fn(), closeStdin: vi.fn() } as any,
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
      group_folder: 'guest_example',
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
          folder: 'guest_example',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
          agentConfig: { model: 'test-model' },
        },
      }),
      getSessions: () => ({}),
      queue: { notifyIdle: vi.fn(), closeStdin: vi.fn() } as any,
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
      groupFolder: 'guest_example',
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
      queue: { notifyIdle: vi.fn(), closeStdin: vi.fn() } as any,
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
      chat_jid: 'tg:-100123',
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
        'tg:-100123': {
          name: 'Main',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
          isMain: true,
          agentConfig: { model: 'test-model' },
        },
      }),
      // A live Claude session exists for the group; the codex run must NOT
      // resume (or rotate) it.
      getSessions: () => ({ telegram_main: 'claude-session-123' }),
      queue: { notifyIdle: vi.fn(), closeStdin: vi.fn() } as any,
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
    });
    expect(input.sessionId).toBeUndefined();
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'tg:-100123',
        text: 'codex task result',
        triggerType: 'task-result',
      }),
    );
    expect(getTaskById('task-codex-primary')?.status).toBe('completed');
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
      queue: { notifyIdle: vi.fn(), closeStdin: vi.fn() } as any,
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
      chat_jid: 'tg:-100123',
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

    runnerMocks.runSandboxAgent.mockResolvedValue({
      status: 'success',
      result: 'claude result',
    });

    await runTask(getTaskById('task-claude-default')!, {
      registeredGroups: () => ({
        'tg:-100123': {
          name: 'Main',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
          isMain: true,
          agentConfig: { model: 'test-model' },
        },
      }),
      getSessions: () => ({}),
      queue: { notifyIdle: vi.fn(), closeStdin: vi.fn() } as any,
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
      chat_jid: 'tg:-100123',
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

    runnerMocks.runContainerAgent.mockResolvedValue({
      status: 'success',
      result: 'container result',
    });

    await runTask(getTaskById('task-container-guard')!, {
      registeredGroups: () => ({
        'tg:-100123': {
          name: 'Main',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'container',
          isMain: true,
          agentConfig: { model: 'test-model' },
        },
      }),
      getSessions: () => ({}),
      queue: { notifyIdle: vi.fn(), closeStdin: vi.fn() } as any,
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
      queue: { notifyIdle: vi.fn(), closeStdin: vi.fn() } as any,
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
      queue: { notifyIdle: vi.fn(), closeStdin: vi.fn() } as any,
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

  it('skips post-run bookkeeping when the task self-cancels mid-run (no FK violation)', async () => {
    createTask({
      id: 'task-self-cancel',
      group_folder: 'guest_example',
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
            folder: 'guest_example',
            trigger: '@Skoobi',
            added_at: '2026-05-10T09:00:00.000Z',
            runtime: 'sandbox',
          },
        }),
        getSessions: () => ({}),
        queue: { notifyIdle: vi.fn(), closeStdin: vi.fn() } as any,
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

  it('keeps failed one-off tasks active for a retry instead of losing them', async () => {
    createTask({
      id: 'task-once-fails',
      group_folder: 'guest_example',
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
          folder: 'guest_example',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
        },
      }),
      getSessions: () => ({}),
      queue: { notifyIdle: vi.fn(), closeStdin: vi.fn() } as any,
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
      group_folder: 'guest_example',
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
          folder: 'guest_example',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'sandbox',
        },
      }),
      getSessions: () => ({}),
      queue: { notifyIdle: vi.fn(), closeStdin: vi.fn() } as any,
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
        groupFolder: 'guest_example',
        meta: { kind: 'task_failure_notice' },
      }),
    );
    const text = route.mock.calls[0][0].text as string;
    expect(text).toContain('⚠️');
    expect(text).toContain('spawn failed');
    expect(text).toContain('напомнить проверить тестовый стенд');
    // once-task failure keeps a retry (next_run set) → the notice promises one
    expect(text).toContain('Попробую снова по расписанию.');
  });

  it('retries failed once-tasks five minutes later', () => {
    const now = new Date('2026-05-10T05:00:00.000Z').getTime();
    const task = {
      id: 'once-retry',
      group_folder: 'guest_example',
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
      group_folder: 'guest_example',
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
          folder: 'guest_example',
          trigger: '@Skoobi',
          added_at: '2026-05-10T09:00:00.000Z',
          runtime: 'container',
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask, notifyIdle: vi.fn(), closeStdin: vi.fn() } as any,
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
