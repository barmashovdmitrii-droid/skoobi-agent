import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getCalendarEventLink,
  getDb,
  getDueTasks,
  getRegisteredGroup,
  getTaskById,
  logTaskRun,
  setRegisteredGroup,
  updateTask,
  updateTaskAfterRun,
  upsertCalendarEventLink,
} from './db.js';
import {
  authorizeIpcSendEnvelope,
  isIpcSendAuthorized,
  processTaskIpc as processTaskIpcRaw,
  validateIpcSendEnvelope,
  validateIpcSendFilePath,
  readIpcEnvelopeJson,
  MAX_IPC_ENVELOPE_BYTES,
  IpcDeps,
} from './ipc.js';
import { RegisteredGroup } from './types.js';
import { registerExtension } from './extensions.js';
import { logger } from './logger.js';
import {
  _clearTaskAuthorizationState,
  authorizeTaskOperationRequest,
  registerTaskAuthorizationCapability,
} from './task-authorization.js';
import { signedTaskAuthorizationRequestForTest } from './task-authorization.test-helpers.js';

// Set up registered groups used across tests
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@skoobi_bot',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@skoobi_bot',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let cleanupPaths: string[] = [];
let ownerTaskSequence = 0;

function ownerAuthorizedEnvelope(
  raw: Record<string, unknown>,
  sourceGroup: string,
): Record<string, unknown> {
  const envelope = { ...raw };
  if (envelope.type === 'schedule_task' && !envelope.taskId) {
    ownerTaskSequence += 1;
    envelope.taskId = `owner-test-task-${ownerTaskSequence}`;
  }
  const capability = registerTaskAuthorizationCapability({
    groupFolder: sourceGroup,
    isMain: true,
    credentialProxyTier: 'owner',
    homogeneousOwnerBatch: true,
    senderIdentity: {
      channel: 'telegram',
      chat_id: '-100123',
      telegram_user_id: '100000001',
      identity_id: 'telegram_user_100000001',
      is_owner_sender: true,
      telegram_message_origin: 'direct',
    },
  });
  if (!capability) return envelope;
  const requestId = `ipc_owner_request_${++ownerTaskSequence}`;
  const response = authorizeTaskOperationRequest(
    signedTaskAuthorizationRequestForTest(capability, envelope, requestId),
    sourceGroup,
  );
  return response.ok
    ? { ...envelope, ownerAuthorizationGrant: response.grant }
    : envelope;
}

async function processTaskIpc(
  data: Parameters<typeof processTaskIpcRaw>[0],
  sourceGroup: string,
  isMain: boolean,
  ipcDeps: IpcDeps,
): Promise<void> {
  const authorized = isMain
    ? ownerAuthorizedEnvelope(
        data as unknown as Record<string, unknown>,
        sourceGroup,
      )
    : data;
  await processTaskIpcRaw(
    authorized as Parameters<typeof processTaskIpcRaw>[0],
    sourceGroup,
    isMain,
    ipcDeps,
  );
}

beforeEach(() => {
  _initTestDatabase();
  _clearTaskAuthorizationState();
  ownerTaskSequence = 0;

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    router: {
      route: async () => 'sent',
      send: async () => {},
      sendPhoto: async () => false,
      sendDocument: async () => false,
      sendVoice: async () => false,
      addPreHook: () => {},
      addPostHook: () => {},
    },
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
      // Mock the fs.mkdirSync that registerGroup does
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
  };
});

afterEach(() => {
  for (const cleanupPath of cleanupPaths.splice(0)) {
    fs.rmSync(cleanupPath, { recursive: true, force: true });
  }
});

function fakeCalendarAdapter(
  overrides: Partial<NonNullable<IpcDeps['calendarAdapter']>> = {},
): NonNullable<IpcDeps['calendarAdapter']> {
  return {
    config: {
      enabled: true,
      calendarId: 'owner@example.com',
      keyFile: '/secret/calendar-robot.json',
      scope: 'https://www.googleapis.com/auth/calendar.events',
      timeZone: 'Asia/Almaty',
      eventDurationMinutes: 15,
      reminderMinutes: 0,
    },
    createReminderEvent: vi.fn(async () => ({
      id: 'google-event-1',
      summary: 'проверить календарь',
      description: null,
      start: '2026-07-09T10:00:00',
      end: '2026-07-09T10:15:00',
      htmlLink: 'https://calendar.google.com/event?eid=google-event-1',
      status: 'confirmed',
    })),
    listEvents: vi.fn(async () => []),
    deleteEvent: vi.fn(async () => {}),
    ...overrides,
  };
}

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify task was created in DB for the other group
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'unknown@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('creates a Google Calendar event link for user-facing once reminders', async () => {
    const calendarAdapter = fakeCalendarAdapter();
    deps.calendarAdapter = calendarAdapter;

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Напомни владельцу: проверить календарь',
        schedule_type: 'once',
        schedule_value: '2026-07-09T10:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const task = getAllTasks()[0];
    expect(calendarAdapter.createReminderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        prompt: 'Напомни владельцу: проверить календарь',
        scheduleValue: '2026-07-09T10:00:00',
      }),
    );
    expect(getCalendarEventLink(task.id)).toMatchObject({
      task_id: task.id,
      provider: 'google_calendar',
      calendar_id: 'owner@example.com',
      event_id: 'google-event-1',
      status: 'active',
    });
  });

  it('logs only a safe summary when Google/Gaxios includes bearer credentials', async () => {
    const bearer = 'ya29.CALENDAR_ACCESS_TOKEN_MUST_NOT_REACH_LOGS';
    const providerError = Object.assign(
      new Error(`Google request failed with ${bearer}`),
      {
        name: 'GaxiosError',
        status: 403,
        config: {
          headers: { Authorization: `Bearer ${bearer}` },
        },
        response: {
          status: 403,
          config: {
            headers: { Authorization: `Bearer ${bearer}` },
          },
        },
      },
    );
    deps.calendarAdapter = fakeCalendarAdapter({
      createReminderEvent: vi.fn(async () => {
        throw providerError;
      }),
    });
    const warnSpy = vi
      .spyOn(logger, 'warn')
      .mockImplementation(() => undefined);

    try {
      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'Напомни владельцу: проверить безопасный лог',
          schedule_type: 'once',
          schedule_value: '2026-07-09T10:00:00',
          targetJid: 'other@g.us',
        },
        'whatsapp_main',
        true,
        deps,
      );

      const call = warnSpy.mock.calls.find(
        (entry) =>
          entry[1] ===
          'Failed to create Google Calendar event for scheduled task',
      );
      expect(call?.[0]).toMatchObject({
        provider: 'google_calendar',
        errorType: 'provider_request_failed',
        httpStatus: 403,
      });
      expect(call?.[0]).not.toHaveProperty('err');
      const logged = JSON.stringify(call);
      expect(logged).not.toContain(bearer);
      expect(logged).not.toContain('Authorization');
      expect(logged).not.toContain('config');
      expect(logged).not.toContain('Google request failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('skips Google Calendar for explicit internal once tasks', async () => {
    const createReminderEvent = vi.fn();
    deps.calendarAdapter = fakeCalendarAdapter({ createReminderEvent });

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: '<internal>Проверить сервис',
        schedule_type: 'once',
        schedule_value: '2026-07-09T10:00:00',
        calendar_event: false,
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(createReminderEvent).not.toHaveBeenCalled();
    expect(getAllTasks()).toHaveLength(1);
  });

  it('does NOT mirror a guest tenant reminder into the owner calendar (ultra-review #6)', async () => {
    const createReminderEvent = vi.fn();
    deps.calendarAdapter = fakeCalendarAdapter({ createReminderEvent });

    // A guest (isMain=false) schedules a once-reminder for its OWN folder and
    // forces calendar_event=true with attacker-controlled prompt text.
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'напомни: verify account http://evil.example/login',
        schedule_type: 'once',
        schedule_value: '2027-01-01T09:00:00',
        calendar_event: true,
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    // The task is created (guest may schedule for itself) but nothing is written
    // to the owner's personal Google Calendar.
    expect(getAllTasks()).toHaveLength(1);
    expect(createReminderEvent).not.toHaveBeenCalled();
  });
});

describe('main IPC directory is not owner authority', () => {
  it('treats direct co-member main JSON as guest and ignores forged creator fields', async () => {
    const createReminderEvent = vi.fn();
    deps.calendarAdapter = fakeCalendarAdapter({ createReminderEvent });
    await processTaskIpcRaw(
      {
        type: 'schedule_task',
        taskId: 'co-member-main-task',
        prompt: 'co-member reminder',
        schedule_type: 'once',
        schedule_value: '2027-01-01T09:00:00',
        context_mode: 'isolated',
        calendar_event: true,
        targetJid: 'main@g.us',
        creator_authorization: 'owner_sender',
        creator_identity_id: 'forged-owner',
      } as any,
      'whatsapp_main',
      true,
      deps,
    );

    expect(getTaskById('co-member-main-task')).toMatchObject({
      group_folder: 'whatsapp_main',
      creator_authorization: null,
      creator_identity_id: null,
      creator_sender_id: null,
    });
    expect(createReminderEvent).not.toHaveBeenCalled();

    await processTaskIpcRaw(
      {
        type: 'schedule_task',
        taskId: 'co-member-cross-group',
        prompt: 'cross group',
        schedule_type: 'once',
        schedule_value: '2027-01-01T09:00:00',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('co-member-cross-group')).toBeUndefined();
  });

  it('cannot mutate or clean owner and legacy main tasks without an exact owner grant', async () => {
    createTask({
      id: 'protected-owner-task',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'owner prompt',
      schedule_type: 'once',
      schedule_value: '2027-01-01T09:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'completed',
      created_at: '2026-07-11T00:00:00.000Z',
      creator_authorization: 'owner_sender',
      creator_identity_id: 'telegram_user_100000001',
      creator_sender_id: '100000001',
    });
    createTask({
      id: 'legacy-main-task',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'legacy prompt',
      schedule_type: 'once',
      schedule_value: '2027-01-01T09:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'completed',
      created_at: '2026-07-11T00:00:00.000Z',
    });

    await processTaskIpcRaw(
      {
        type: 'update_task',
        taskId: 'protected-owner-task',
        prompt: 'ATTACKER REPLACEMENT',
      },
      'whatsapp_main',
      true,
      deps,
    );
    await processTaskIpcRaw(
      { type: 'cancel_task', taskId: 'protected-owner-task' },
      'whatsapp_main',
      true,
      deps,
    );
    await processTaskIpcRaw(
      { type: 'cleanup_tasks' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getTaskById('protected-owner-task')).toMatchObject({
      prompt: 'owner prompt',
      status: 'completed',
    });
    expect(getTaskById('legacy-main-task')).toBeDefined();
  });

  it('blocks raw main register/refresh authority and passes false to extensions', async () => {
    const syncGroups = vi.fn(async () => {});
    deps.syncGroups = syncGroups;
    const extensionHandler = vi.fn(async () => {});
    registerExtension({
      name: `ipc-auth-test-${Date.now()}-${Math.random()}`,
      ipcHandlers: { direct_owner_probe: extensionHandler },
    });

    await processTaskIpcRaw(
      {
        type: 'register_group',
        jid: 'attacker@g.us',
        name: 'Attacker',
        folder: 'attacker-group',
        trigger: '@skoobi_bot',
      },
      'whatsapp_main',
      true,
      deps,
    );
    await processTaskIpcRaw(
      { type: 'refresh_groups' },
      'whatsapp_main',
      true,
      deps,
    );
    await processTaskIpcRaw(
      { type: 'direct_owner_probe' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['attacker@g.us']).toBeUndefined();
    expect(syncGroups).not.toHaveBeenCalled();
    expect(extensionHandler).toHaveBeenCalledWith(
      expect.anything(),
      'whatsapp_main',
      false,
      expect.anything(),
    );
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-other',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can pause any task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-main' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'third-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- resume_task re-arms a task the scheduler gave up on ---

describe('resume_task re-arms a recurring task paused with next_run NULL', () => {
  const NOW = Date.parse('2026-09-28T10:00:00.000Z');

  const createRecurring = (
    id: string,
    schedule_type: 'cron' | 'interval' | 'once',
    schedule_value: string,
  ) =>
    createTask({
      id,
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: `task ${id}`,
      schedule_type,
      schedule_value,
      context_mode: 'isolated',
      next_run: new Date(NOW - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-09-01T00:00:00.000Z',
    });

  // Exactly what runTask does when it gives up on a run (an uncertain side
  // effect, or MAX_CONSECUTIVE_TASK_FAILURES): next_run NULL, then paused.
  const pauseLikeTheScheduler = (id: string) => {
    updateTaskAfterRun(id, null, 'Error: codex produced no final message');
    updateTask(id, { status: 'paused' });
  };

  const resume = (taskId: string) =>
    processTaskIpc({ type: 'resume_task', taskId }, 'other-group', false, deps);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a cron task is active with a future next_run and becomes due again', async () => {
    createRecurring('task-daily-cron', 'cron', '0 9 * * *');
    pauseLikeTheScheduler('task-daily-cron');
    expect(getTaskById('task-daily-cron')).toMatchObject({
      status: 'paused',
      next_run: null,
    });

    await resume('task-daily-cron');

    const resumed = getTaskById('task-daily-cron')!;
    expect(resumed.status).toBe('active');
    expect(resumed.next_run).not.toBeNull();
    const nextRun = Date.parse(resumed.next_run!);
    expect(nextRun).toBeGreaterThan(NOW);
    expect(nextRun).toBeLessThanOrEqual(NOW + 24 * 60 * 60 * 1000);
    expect(getDueTasks().map((t) => t.id)).not.toContain('task-daily-cron');
    vi.setSystemTime(nextRun + 1000);
    expect(getDueTasks().map((t) => t.id)).toContain('task-daily-cron');
  });

  it('an interval task is re-armed one interval from now', async () => {
    createRecurring('task-hourly', 'interval', String(60 * 60 * 1000));
    pauseLikeTheScheduler('task-hourly');

    await resume('task-hourly');

    expect(getTaskById('task-hourly')).toMatchObject({
      status: 'active',
      next_run: new Date(NOW + 60 * 60 * 1000).toISOString(),
    });
  });

  it('a once-task the scheduler gave up on is re-armed and due again', async () => {
    // Its time has passed: due right away.
    createRecurring('task-once', 'once', '2026-09-28T09:00:00.000Z');
    pauseLikeTheScheduler('task-once');
    // Its time is still ahead: armed at that time.
    createRecurring('task-once-later', 'once', '2026-09-28T15:00:00.000Z');
    pauseLikeTheScheduler('task-once-later');

    await resume('task-once');
    await resume('task-once-later');

    expect(getTaskById('task-once')).toMatchObject({
      status: 'active',
      next_run: new Date(NOW).toISOString(),
    });
    expect(getDueTasks().map((t) => t.id)).toContain('task-once');
    expect(getTaskById('task-once-later')).toMatchObject({
      status: 'active',
      next_run: '2026-09-28T15:00:00.000Z',
    });
  });

  it('a task that still has next_run and a completed once-task keep what they had', async () => {
    createRecurring('task-armed', 'cron', '0 9 * * *');
    updateTask('task-armed', { status: 'paused' });
    const armedNextRun = getTaskById('task-armed')!.next_run;
    createRecurring('task-once-done', 'once', '2026-09-28T09:00:00.000Z');
    updateTaskAfterRun('task-once-done', null, 'ok');

    await resume('task-armed');
    await resume('task-once-done');

    expect(getTaskById('task-armed')).toMatchObject({
      status: 'active',
      next_run: armedNextRun,
    });
    expect(getTaskById('task-once-done')!.next_run).toBeNull();
  });
});

// --- cancel_task authorization ---

// Cancellation preserves the task row and run history; physical deletion
// is reserved for the explicit bulk cleanup_tasks path.
describe('cancel_task authorization', () => {
  it('deletes a linked Google Calendar event and marks the link, keeping the task row', async () => {
    const deleteEvent = vi.fn(async () => {});
    deps.calendarAdapter = fakeCalendarAdapter({
      createReminderEvent: vi.fn(async () => ({
        id: 'google-event-delete',
        summary: null,
        description: null,
        start: null,
        end: null,
        htmlLink: null,
        status: 'confirmed',
      })),
      deleteEvent,
    });

    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'task-with-calendar',
        prompt: 'Напомни владельцу: удалить тест',
        schedule_type: 'once',
        schedule_value: '2026-07-09T10:00:00',
        calendar_event: true,
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-with-calendar' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(deleteEvent).toHaveBeenCalledWith(
      'google-event-delete',
      'owner@example.com',
    );
    expect(getTaskById('task-with-calendar')).toMatchObject({
      status: 'cancelled',
      next_run: null,
    });
    expect(getCalendarEventLink('task-with-calendar')?.status).toBe('deleted');
  });

  it('keeps the run history of a cancelled task and never runs it again', async () => {
    createTask({
      id: 'task-ran-then-cancelled',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'Тестовое напоминание о доступе',
      schedule_type: 'once',
      schedule_value: '2026-10-01T09:00:00',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-09-30T00:00:00.000Z',
    });
    logTaskRun({
      task_id: 'task-ran-then-cancelled',
      run_at: '2026-10-01T04:01:07.000Z',
      duration_ms: 12_000,
      status: 'success',
      result: 'Сегодня истёк тестовый доступ…',
      error: null,
    });
    expect(getDueTasks().map((task) => task.id)).toContain(
      'task-ran-then-cancelled',
    );

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-ran-then-cancelled' },
      'other-group',
      false,
      deps,
    );

    expect(getTaskById('task-ran-then-cancelled')).toMatchObject({
      status: 'cancelled',
      next_run: null,
      prompt: 'Тестовое напоминание о доступе',
    });
    const runs = getDb()
      .prepare('SELECT status, result FROM task_run_logs WHERE task_id = ?')
      .all('task-ran-then-cancelled');
    expect(runs).toEqual([
      { status: 'success', result: 'Сегодня истёк тестовый доступ…' },
    ]);
    expect(getDueTasks().map((task) => task.id)).not.toContain(
      'task-ran-then-cancelled',
    );

    // Neither resume nor pause turns a cancelled task back into a schedule.
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-ran-then-cancelled' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-ran-then-cancelled')).toMatchObject({
      status: 'cancelled',
      next_run: null,
    });
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-ran-then-cancelled' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-ran-then-cancelled')!.status).toBe('cancelled');

    // Only the bulk cleanup physically removes it, together with its run log.
    await processTaskIpc(
      { type: 'cleanup_tasks', statuses: ['cancelled'] },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-ran-then-cancelled')).toBeUndefined();
    expect(
      getDb()
        .prepare('SELECT COUNT(*) AS c FROM task_run_logs WHERE task_id = ?')
        .get('task-ran-then-cancelled'),
    ).toEqual({ c: 0 });
  });

  it('does not let a guest delete an owner-linked calendar event through its task folder', async () => {
    const deleteEvent = vi.fn(async () => {});
    deps.calendarAdapter = fakeCalendarAdapter({ deleteEvent });
    createTask({
      id: 'guest-folder-owner-calendar',
      group_folder: 'guest-group',
      chat_jid: 'tg:guest',
      prompt: 'legacy owner-created reminder',
      schedule_type: 'once',
      schedule_value: '2026-07-12T10:00:00Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-07-11T00:00:00Z',
    });
    upsertCalendarEventLink({
      task_id: 'guest-folder-owner-calendar',
      provider: 'google_calendar',
      calendar_id: 'owner@example.com',
      event_id: 'owner-event',
      event_link: null,
      status: 'active',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'guest-folder-owner-calendar' },
      'guest-group',
      false,
      deps,
    );

    expect(deleteEvent).not.toHaveBeenCalled();
    expect(getTaskById('guest-folder-owner-calendar')).toBeDefined();
    expect(getCalendarEventLink('guest-folder-owner-calendar')?.status).toBe(
      'active',
    );
  });

  it('main group can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-to-cancel' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-to-cancel')!.status).toBe('cancelled');
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-own' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-own')!.status).toBe('cancelled');
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-foreign' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-foreign')!.status).toBe('active');
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@skoobi_bot',
      },
      'other-group',
      false,
      deps,
    );

    // registeredGroups should not have changed
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@skoobi_bot',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });

  it('rejects a non-boolean requiresTrigger instead of coercing null to false', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'null-trigger@g.us',
        name: 'Null Trigger',
        folder: 'null-trigger-group',
        trigger: '@skoobi_bot',
        requiresTrigger: null as unknown as boolean,
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['null-trigger@g.us']).toBeUndefined();
  });

  it('does not silently remap an existing jid to a different folder', async () => {
    // 'other@g.us' is already mapped to 'other-group'. A register_group reusing
    // that jid with a different folder must be rejected, not overwrite the
    // existing tenant's folder/identity binding.
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'other@g.us',
        name: 'Hijacked',
        folder: 'attacker-folder',
        trigger: '@skoobi_bot',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Existing mapping must be preserved unchanged.
    expect(groups['other@g.us'].folder).toBe('other-group');
    expect(groups['other@g.us'].name).toBe('Other');
  });

  it('rejects register_group with a malformed jid', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'bad jid with spaces/and slashes',
        name: 'Bad',
        folder: 'bad-jid-group',
        trigger: '@skoobi_bot',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['bad jid with spaces/and slashes']).toBeUndefined();
  });

  it('still allows re-registering the same jid with the SAME folder (idempotent update)', async () => {
    // Updating other metadata (name/trigger) for an already-registered jid is a
    // legitimate in-place update as long as the folder binding is unchanged.
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'other@g.us',
        name: 'Other Renamed',
        folder: 'other-group',
        trigger: '@skoobi_bot',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['other@g.us'].folder).toBe('other-group');
    expect(groups['other@g.us'].name).toBe('Other Renamed');
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('IPC message authorization', () => {
  it('an effectively owner-authorized send can target any group', () => {
    expect(
      isIpcSendAuthorized('whatsapp_main', true, 'other@g.us', groups),
    ).toBe(true);
    expect(
      isIpcSendAuthorized('whatsapp_main', true, 'third@g.us', groups),
    ).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(
      isIpcSendAuthorized('other-group', false, 'other@g.us', groups),
    ).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isIpcSendAuthorized('other-group', false, 'main@g.us', groups)).toBe(
      false,
    );
    expect(
      isIpcSendAuthorized('other-group', false, 'third@g.us', groups),
    ).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(
      isIpcSendAuthorized('other-group', false, 'unknown@g.us', groups),
    ).toBe(false);
  });

  it('an effectively owner-authorized send can target an unregistered JID', () => {
    expect(
      isIpcSendAuthorized('whatsapp_main', true, 'unknown@g.us', groups),
    ).toBe(true);
  });

  it('raw JSON in the main directory has no owner authority for cross-group sends', () => {
    const raw = {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'co-member bypass attempt',
    };
    expect(authorizeIpcSendEnvelope(raw, 'whatsapp_main', groups)).toEqual({
      authorized: false,
      effectiveOwner: false,
    });
  });

  it('an exact one-shot owner grant preserves legitimate cross-group sends', () => {
    const raw = {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'legitimate owner delivery',
    };
    const granted = ownerAuthorizedEnvelope(raw, 'whatsapp_main');
    expect(authorizeIpcSendEnvelope(granted, 'whatsapp_main', groups)).toEqual({
      authorized: true,
      effectiveOwner: true,
    });
    // A copied/replayed envelope loses the one-shot authority.
    expect(authorizeIpcSendEnvelope(granted, 'whatsapp_main', groups)).toEqual({
      authorized: false,
      effectiveOwner: false,
    });
  });

  it('raw main-directory document JSON cannot unlock an arbitrary host path', () => {
    const outside = path.join(os.tmpdir(), `ipc-owner-secret-${Date.now()}`);
    cleanupPaths.push(outside);
    fs.writeFileSync(outside, 'HOST_SECRET');
    const raw = {
      type: 'document',
      chatJid: 'main@g.us',
      filePath: outside,
    };
    const authorization = authorizeIpcSendEnvelope(
      raw,
      'whatsapp_main',
      groups,
    );
    expect(authorization).toEqual({
      authorized: true,
      effectiveOwner: false,
    });
    expect(
      validateIpcSendFilePath({
        sourceGroup: 'whatsapp_main',
        isMain: authorization.effectiveOwner,
        filePath: outside,
        kind: 'document',
      }),
    ).toMatchObject({
      allowed: false,
      reason: 'guest_file_outside_workspace',
    });
  });

  it('an exact owner document grant preserves legitimate absolute host-file sends', () => {
    const outside = path.join(os.tmpdir(), `ipc-owner-report-${Date.now()}`);
    cleanupPaths.push(outside);
    fs.writeFileSync(outside, 'OWNER_REPORT');
    const raw = {
      type: 'document',
      chatJid: 'other@g.us',
      filePath: outside,
      caption: 'owner report',
    };
    const granted = ownerAuthorizedEnvelope(raw, 'whatsapp_main');
    const authorization = authorizeIpcSendEnvelope(
      granted,
      'whatsapp_main',
      groups,
    );
    expect(authorization).toEqual({
      authorized: true,
      effectiveOwner: true,
    });
    expect(
      validateIpcSendFilePath({
        sourceGroup: 'whatsapp_main',
        isMain: authorization.effectiveOwner,
        filePath: outside,
        kind: 'document',
      }),
    ).toMatchObject({
      allowed: true,
      realPath: fs.realpathSync(outside),
      staged: false,
    });
  });

  it('maps downgraded main /workspace/group only to its fixed isolated namespace', () => {
    const isolatedRoot = path.join(
      DATA_DIR,
      'untrusted-main',
      'whatsapp_main',
      'workspace',
    );
    const isolatedFile = path.join(isolatedRoot, 'output', 'guest-report.txt');
    const canonicalFile = path.join(
      GROUPS_DIR,
      'whatsapp_main',
      'owner-secret.txt',
    );
    const receivedFile = path.join(
      GROUPS_DIR,
      'whatsapp_main',
      'received',
      'photo.txt',
    );
    cleanupPaths.push(
      path.join(DATA_DIR, 'untrusted-main', 'whatsapp_main'),
      path.join(GROUPS_DIR, 'whatsapp_main'),
    );
    fs.mkdirSync(path.dirname(isolatedFile), { recursive: true });
    fs.mkdirSync(path.dirname(receivedFile), { recursive: true });
    fs.writeFileSync(isolatedFile, 'ISOLATED_REPORT');
    fs.writeFileSync(canonicalFile, 'OWNER_SECRET');
    fs.writeFileSync(receivedFile, 'RECEIVED');

    const isolated = validateIpcSendFilePath({
      sourceGroup: 'whatsapp_main',
      isMain: false,
      sourceIsMultiSenderMain: true,
      filePath: '/workspace/group/output/guest-report.txt',
      kind: 'document',
    });
    expect(isolated.allowed).toBe(true);
    if (isolated.allowed) {
      expect(fs.readFileSync(isolated.realPath, 'utf8')).toBe(
        'ISOLATED_REPORT',
      );
      cleanupPaths.push(isolated.realPath);
    }

    expect(
      validateIpcSendFilePath({
        sourceGroup: 'whatsapp_main',
        isMain: false,
        sourceIsMultiSenderMain: true,
        filePath: canonicalFile,
        kind: 'document',
      }),
    ).toMatchObject({
      allowed: false,
      reason: 'guest_file_outside_workspace',
    });

    const received = validateIpcSendFilePath({
      sourceGroup: 'whatsapp_main',
      isMain: false,
      sourceIsMultiSenderMain: true,
      filePath: '/workspace/group/received/photo.txt',
      kind: 'document',
    });
    expect(received.allowed).toBe(true);
    if (received.allowed) cleanupPaths.push(received.realPath);
  });
});

describe('IPC send_photo path authorization', () => {
  function writeGroupFile(groupFolder: string, relPath: string): string {
    const groupRoot = path.join(GROUPS_DIR, groupFolder);
    cleanupPaths.push(groupRoot);
    const filePath = path.join(groupRoot, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'image-bytes');
    return filePath;
  }

  it('stages a guest photo into a host-only copy, not the guest-writable path (TOCTOU defense)', () => {
    const filePath = writeGroupFile('other-group', 'out/photo.png');

    const result = validateIpcSendFilePath({
      sourceGroup: 'other-group',
      isMain: false,
      filePath,
      kind: 'photo',
    });

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      // Must NOT hand back the guest-writable original (a guest could swap it for
      // a symlink before the deferred read). It is a host-only staging copy with
      // identical bytes, outside the groups/ tree.
      expect(result.realPath).not.toBe(filePath);
      expect(result.realPath).toContain('ipc-staging');
      expect(result.realPath).not.toContain(`${path.sep}groups${path.sep}`);
      expect(fs.readFileSync(result.realPath, 'utf8')).toBe('image-bytes');
      cleanupPaths.push(result.realPath);
    }
  });

  it('blocks guest send_photo path traversal and another tenant folder', () => {
    const otherTenantFile = writeGroupFile('third-group', 'secret.png');
    const traversal = path.join(
      GROUPS_DIR,
      'other-group',
      '..',
      'third-group',
      'secret.png',
    );

    expect(
      validateIpcSendFilePath({
        sourceGroup: 'other-group',
        isMain: false,
        filePath: traversal,
        kind: 'photo',
      }),
    ).toMatchObject({ allowed: false });
    expect(
      validateIpcSendFilePath({
        sourceGroup: 'other-group',
        isMain: false,
        filePath: otherTenantFile,
        kind: 'photo',
      }),
    ).toMatchObject({ allowed: false });
  });

  it('blocks guest send_photo symlink escapes, .env, ssh keys, and raw DB files', () => {
    const sourceRoot = path.join(GROUPS_DIR, 'other-group');
    const outsideDir = path.join(GROUPS_DIR, 'outside-sensitive');
    cleanupPaths.push(sourceRoot, outsideDir);
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'secret.png');
    fs.writeFileSync(outsideFile, 'secret');
    const symlinkPath = path.join(sourceRoot, 'escape.png');
    fs.symlinkSync(outsideFile, symlinkPath);

    const envPath = path.join(sourceRoot, '.env');
    const sshPath = path.join(sourceRoot, '.ssh', 'id_ed25519');
    const dbPath = path.join(sourceRoot, 'store', 'messages.db');
    fs.writeFileSync(envPath, 'SECRET=value');
    fs.mkdirSync(path.dirname(sshPath), { recursive: true });
    fs.writeFileSync(sshPath, 'key');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'db');

    for (const filePath of [symlinkPath, envPath, sshPath, dbPath]) {
      expect(
        validateIpcSendFilePath({
          sourceGroup: 'other-group',
          isMain: false,
          filePath,
          kind: 'photo',
        }),
      ).toMatchObject({ allowed: false });
    }
  });

  it('blocks guest sends of db sidecars, dotenv variants, key material, certs, and secrets/', () => {
    const sensitiveRelPaths = [
      // SQLite databases + WAL/SHM/journal sidecars
      'store/messages.db-wal',
      'store/messages.db-shm',
      'store/messages.db-journal',
      'data/mem0-history.db',
      'data/mem0-vec.sqlite',
      'data/cache.sqlite3',
      // dotenv variants
      '.env.local',
      '.env.production',
      '.env.bak',
      // key material / certs / keystores
      'keys/server.pem',
      'keys/private.key',
      'certs/client.p12',
      'certs/bundle.pfx',
      'certs/chain.crt',
      'id_rsa',
      'id_ed25519',
      // anything under a secrets/ component
      'secrets/payment-client-cert.txt',
    ];

    for (const relPath of sensitiveRelPaths) {
      const filePath = writeGroupFile('other-group', relPath);
      expect(
        validateIpcSendFilePath({
          sourceGroup: 'other-group',
          isMain: false,
          filePath,
          kind: 'document',
        }),
        `expected ${relPath} to be denied`,
      ).toMatchObject({
        allowed: false,
        reason: 'guest_sensitive_file_denied',
      });
    }
  });

  it('blocks guest sends of credential files that carry no key/cert name or extension (.aws/credentials, .npmrc, credentials.json, .netrc, kubeconfig, .config creds)', () => {
    const credentialRelPaths = [
      // cloud / infra credential dirs (consistent with mount-security blocklist)
      '.aws/credentials',
      '.aws/config',
      '.azure/accessTokens.json',
      '.gcloud/application_default_credentials.json',
      '.kube/config',
      '.docker/config.json',
      '.gnupg/secring.gpg',
      // XDG config dir credentials (e.g. gh CLI host tokens, gcloud)
      '.config/gh/hosts.yml',
      '.config/gcloud/credentials.db-shm', // also dir-blocked, sanity
      // package/registry and FTP/HTTP auth tokens by filename
      '.npmrc',
      '.netrc',
      '.pypirc',
      // generic credential dumps with no telltale extension
      'credentials.json',
      'credentials.yml',
      'credentials',
      // kubeconfig variants
      'kubeconfig',
      'cluster.kubeconfig',
      'private_key.txt',
    ];

    for (const relPath of credentialRelPaths) {
      const filePath = writeGroupFile('other-group', relPath);
      expect(
        validateIpcSendFilePath({
          sourceGroup: 'other-group',
          isMain: false,
          filePath,
          kind: 'document',
        }),
        `expected ${relPath} to be denied`,
      ).toMatchObject({
        allowed: false,
        reason: 'guest_sensitive_file_denied',
      });
    }
  });

  it('still allows legitimate guest image/document sends from its own workspace', () => {
    for (const relPath of [
      'out/report.pdf',
      'out/chart.png',
      'received/photo.jpg',
      'output/notes.txt',
      'output/data.csv',
    ]) {
      const filePath = writeGroupFile('other-group', relPath);
      expect(
        validateIpcSendFilePath({
          sourceGroup: 'other-group',
          isMain: false,
          filePath,
          kind: 'document',
        }),
        `expected ${relPath} to be allowed`,
      ).toMatchObject({ allowed: true });
    }
  });

  it('does not apply the guest denylist to the main group', () => {
    const filePath = writeGroupFile('whatsapp_main', 'store/messages.db');
    expect(
      validateIpcSendFilePath({
        sourceGroup: 'whatsapp_main',
        isMain: true,
        filePath,
        kind: 'document',
      }),
    ).toMatchObject({ allowed: true });
  });

  it('rejects an oversized guest send before staging (host OOM DoS guard)', () => {
    // The guest-only staging copy buffers the whole file into one Node Buffer.
    // A file just over the 50MB cap must be rejected up front (no bytes read)
    // so a guest cannot OOM-crash the shared host orchestrator.
    const groupRoot = path.join(GROUPS_DIR, 'other-group');
    cleanupPaths.push(groupRoot);
    const filePath = path.join(groupRoot, 'out', 'huge.bin');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Sparse file just over 50MB: ftruncate sets size without writing 50MB.
    const fd = fs.openSync(filePath, 'w');
    fs.ftruncateSync(fd, 50 * 1024 * 1024 + 1);
    fs.closeSync(fd);

    expect(
      validateIpcSendFilePath({
        sourceGroup: 'other-group',
        isMain: false,
        filePath,
        kind: 'document',
      }),
    ).toMatchObject({ allowed: false, reason: 'guest_file_too_large' });
  });

  it('allows a guest send at the size cap (boundary, not over)', () => {
    const groupRoot = path.join(GROUPS_DIR, 'other-group');
    cleanupPaths.push(groupRoot);
    const filePath = path.join(groupRoot, 'out', 'atcap.bin');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(filePath, 'w');
    fs.ftruncateSync(fd, 50 * 1024 * 1024); // exactly at the cap
    fs.closeSync(fd);

    const result = validateIpcSendFilePath({
      sourceGroup: 'other-group',
      isMain: false,
      filePath,
      kind: 'document',
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) cleanupPaths.push(result.realPath);
  });

  it('rejects a guest file that grows after same-inode fstat without reading the growth', () => {
    const filePath = writeGroupFile('other-group', 'out/grow-during-stage.bin');
    const originalFstatSync = fs.fstatSync;
    let grown = false;
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((fd) => {
      const stat = originalFstatSync(fd);
      if (!grown) {
        grown = true;
        // Sparse growth after the stage's descriptor stat. The bounded reader
        // must allocate only the original bytes, detect the extra byte, and
        // reject rather than following EOF into 50+ MiB of attacker growth.
        fs.truncateSync(filePath, 50 * 1024 * 1024 + 1);
      }
      return stat;
    });

    try {
      expect(
        validateIpcSendFilePath({
          sourceGroup: 'other-group',
          isMain: false,
          filePath,
          kind: 'document',
        }),
      ).toMatchObject({
        allowed: false,
        reason: 'file_changed_or_unreadable',
      });
    } finally {
      fstatSpy.mockRestore();
    }
  });
});

// --- IPC send envelope field-type validation ---
// A sandboxed guest can write arbitrary JSON directly into its IPC messages
// dir (bypassing the agent-side MCP server), so the host must assert field
// types before routing instead of trusting truthiness.

describe('validateIpcSendEnvelope', () => {
  it('accepts well-formed message/voice envelopes', () => {
    expect(
      validateIpcSendEnvelope({
        type: 'message',
        chatJid: 'x@g.us',
        text: 'hi',
      }),
    ).toEqual({ ok: true });
    expect(
      validateIpcSendEnvelope({ type: 'voice', chatJid: 'x@g.us', text: 'hi' }),
    ).toEqual({ ok: true });
    // empty-string text is still a string (downstream truthiness drops it)
    expect(
      validateIpcSendEnvelope({ type: 'message', chatJid: 'x@g.us', text: '' }),
    ).toEqual({ ok: true });
  });

  it('accepts well-formed photo/document envelopes with or without caption', () => {
    expect(
      validateIpcSendEnvelope({
        type: 'photo',
        chatJid: 'x@g.us',
        filePath: '/tmp/a.png',
      }),
    ).toEqual({ ok: true });
    expect(
      validateIpcSendEnvelope({
        type: 'document',
        chatJid: 'x@g.us',
        filePath: '/tmp/a.pdf',
        caption: 'see attached',
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a non-string chatJid for any send type', () => {
    for (const type of ['message', 'voice', 'photo', 'document']) {
      expect(
        validateIpcSendEnvelope({ type, chatJid: 123 as unknown, text: 'hi' }),
      ).toMatchObject({ ok: false, reason: 'invalid_chat_jid' });
    }
    expect(
      validateIpcSendEnvelope({ type: 'message', chatJid: '   ', text: 'hi' }),
    ).toMatchObject({ ok: false, reason: 'invalid_chat_jid' });
    expect(
      validateIpcSendEnvelope({ type: 'message', text: 'hi' }),
    ).toMatchObject({ ok: false, reason: 'invalid_chat_jid' });
  });

  it('rejects non-string text on message/voice envelopes', () => {
    expect(
      validateIpcSendEnvelope({
        type: 'message',
        chatJid: 'x@g.us',
        text: 123,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_text' });
    expect(
      validateIpcSendEnvelope({
        type: 'voice',
        chatJid: 'x@g.us',
        text: { nested: true } as unknown,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_text' });
    expect(
      validateIpcSendEnvelope({ type: 'message', chatJid: 'x@g.us' }),
    ).toMatchObject({ ok: false, reason: 'invalid_text' });
  });

  it('rejects non-string filePath or caption on photo/document envelopes', () => {
    expect(
      validateIpcSendEnvelope({
        type: 'photo',
        chatJid: 'x@g.us',
        filePath: 42 as unknown,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_file_path' });
    expect(
      validateIpcSendEnvelope({
        type: 'document',
        chatJid: 'x@g.us',
        filePath: '/tmp/a.pdf',
        caption: 99 as unknown,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_caption' });
  });

  it('enforces host-side ceilings even when raw JSON bypasses the runner', () => {
    expect(
      validateIpcSendEnvelope({
        type: 'voice',
        chatJid: 'x@g.us',
        text: 'v'.repeat(12_001),
      }),
    ).toMatchObject({ ok: false, reason: 'voice_text_too_long' });
    expect(
      validateIpcSendEnvelope({
        type: 'message',
        chatJid: 'x@g.us',
        text: 'm'.repeat(64 * 1024 + 1),
      }),
    ).toMatchObject({ ok: false, reason: 'message_text_too_long' });
    expect(
      validateIpcSendEnvelope({
        type: 'photo',
        chatJid: 'x@g.us',
        filePath: '/tmp/a.png',
        caption: 'c'.repeat(1025),
      }),
    ).toMatchObject({ ok: false, reason: 'caption_too_long' });
    expect(
      validateIpcSendEnvelope({
        type: 'document',
        chatJid: 'x'.repeat(257),
        filePath: '/tmp/a.pdf',
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_chat_jid' });
    expect(
      validateIpcSendEnvelope({
        type: 'document',
        chatJid: 'x@g.us',
        filePath: `/${'p'.repeat(4096)}`,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_file_path' });
  });

  it('keeps legitimate boundary-sized send envelopes valid', () => {
    expect(
      validateIpcSendEnvelope({
        type: 'voice',
        chatJid: 'x@g.us',
        text: 'v'.repeat(12_000),
      }),
    ).toEqual({ ok: true });
    expect(
      validateIpcSendEnvelope({
        type: 'message',
        chatJid: 'x@g.us',
        text: 'm'.repeat(64 * 1024),
      }),
    ).toEqual({ ok: true });
    expect(
      validateIpcSendEnvelope({
        type: 'photo',
        chatJid: 'x@g.us',
        filePath: '/tmp/a.png',
        caption: 'c'.repeat(1024),
      }),
    ).toEqual({ ok: true });
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // every day at 9am
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
  });

  it('rejects invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000', // 1 hour
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    // next_run should be ~1 hour from now
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'zero interval',
        schedule_type: 'interval',
        schedule_value: '0',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'group',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'bogus' as any,
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_group success path ---

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@skoobi_bot',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify group was registered in DB
    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@skoobi_bot');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // missing folder and trigger
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });
});

describe('cleanup_tasks (bulk deletion of finished tasks)', () => {
  function seedTask(
    id: string,
    groupFolder: string,
    chatJid: string,
    status: 'active' | 'paused' | 'completed' | 'cancelled',
  ): void {
    createTask({
      id,
      group_folder: groupFolder,
      chat_jid: chatJid,
      prompt: `task ${id}`,
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status,
      created_at: '2025-06-01T00:00:00.000Z',
    });
  }

  it('main deletes finished tasks across all groups, never active/paused', async () => {
    seedTask('done-main', 'whatsapp_main', 'main@g.us', 'completed');
    seedTask('cancelled-other', 'other-group', 'other@g.us', 'cancelled');
    seedTask('active-main', 'whatsapp_main', 'main@g.us', 'active');
    seedTask('paused-other', 'other-group', 'other@g.us', 'paused');

    await processTaskIpc(
      { type: 'cleanup_tasks' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getTaskById('done-main')).toBeUndefined();
    expect(getTaskById('cancelled-other')).toBeUndefined();
    expect(getTaskById('active-main')).toBeDefined();
    expect(getTaskById('paused-other')).toBeDefined();
  });

  it('honors the statuses filter (completed only keeps cancelled)', async () => {
    seedTask('done-1', 'whatsapp_main', 'main@g.us', 'completed');
    seedTask('cancelled-1', 'whatsapp_main', 'main@g.us', 'cancelled');

    await processTaskIpc(
      { type: 'cleanup_tasks', statuses: ['completed'] },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getTaskById('done-1')).toBeUndefined();
    expect(getTaskById('cancelled-1')).toBeDefined();
  });

  it('a hostile statuses list can never touch active tasks', async () => {
    seedTask('active-hostile', 'whatsapp_main', 'main@g.us', 'active');

    await processTaskIpc(
      { type: 'cleanup_tasks', statuses: ['active'] },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getTaskById('active-hostile')).toBeDefined();
  });

  it('a non-main group cleans only its own finished tasks', async () => {
    seedTask('done-other', 'other-group', 'other@g.us', 'completed');
    seedTask('done-third', 'third-group', 'third@g.us', 'completed');

    await processTaskIpc({ type: 'cleanup_tasks' }, 'other-group', false, deps);

    expect(getTaskById('done-other')).toBeUndefined();
    expect(getTaskById('done-third')).toBeDefined();
  });

  it('guest bulk cleanup skips its owner-linked calendar tasks', async () => {
    seedTask('done-owner-calendar', 'other-group', 'other@g.us', 'completed');
    seedTask('done-plain-guest', 'other-group', 'other@g.us', 'completed');
    upsertCalendarEventLink({
      task_id: 'done-owner-calendar',
      provider: 'google_calendar',
      calendar_id: 'owner@example.com',
      event_id: 'owner-event-bulk',
      event_link: null,
      status: 'active',
    });
    const deleteEvent = vi.fn(async () => {});
    deps.calendarAdapter = fakeCalendarAdapter({ deleteEvent });

    await processTaskIpc({ type: 'cleanup_tasks' }, 'other-group', false, deps);

    expect(getTaskById('done-owner-calendar')).toBeDefined();
    expect(getCalendarEventLink('done-owner-calendar')?.status).toBe('active');
    expect(getTaskById('done-plain-guest')).toBeUndefined();
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it('a non-main group cannot target another group folder', async () => {
    seedTask('done-third-2', 'third-group', 'third@g.us', 'completed');

    await processTaskIpc(
      { type: 'cleanup_tasks', targetGroupFolder: 'third-group' },
      'other-group',
      false,
      deps,
    );

    expect(getTaskById('done-third-2')).toBeDefined();
  });

  it('main can limit cleanup to one group folder', async () => {
    seedTask('done-other-3', 'other-group', 'other@g.us', 'completed');
    seedTask('done-main-3', 'whatsapp_main', 'main@g.us', 'completed');

    await processTaskIpc(
      { type: 'cleanup_tasks', targetGroupFolder: 'other-group' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getTaskById('done-other-3')).toBeUndefined();
    expect(getTaskById('done-main-3')).toBeDefined();
  });
});

describe('readIpcEnvelopeJson size cap (ultra-review #2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-envelope-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses a normal small envelope', () => {
    const p = path.join(dir, 'm.json');
    fs.writeFileSync(p, JSON.stringify({ type: 'message', text: 'hi' }));
    expect(readIpcEnvelopeJson(p)).toMatchObject({
      type: 'message',
      text: 'hi',
    });
  });

  it('accepts a valid regular JSON envelope exactly at the byte cap', () => {
    const p = path.join(dir, 'exact-cap.json');
    const prefix = '{"text":"';
    const suffix = '"}';
    const payloadLength =
      MAX_IPC_ENVELOPE_BYTES - Buffer.byteLength(prefix + suffix);
    fs.writeFileSync(p, prefix + 'x'.repeat(payloadLength) + suffix);

    expect(fs.statSync(p).size).toBe(MAX_IPC_ENVELOPE_BYTES);
    expect(readIpcEnvelopeJson(p).text).toHaveLength(payloadLength);
  });

  it('throws on an over-cap file BEFORE reading it into host memory (OOM guard)', () => {
    const p = path.join(dir, 'huge.json');
    // Sparse file just over the cap: ftruncate gives the logical size statSync
    // reads, without writing hundreds of MB. readFileSync must never run.
    const fd = fs.openSync(p, 'w');
    fs.ftruncateSync(fd, MAX_IPC_ENVELOPE_BYTES + 1);
    fs.closeSync(fd);
    expect(() => readIpcEnvelopeJson(p)).toThrow(/too large/i);
  });

  it('still rejects a malformed (non-JSON) small envelope by throwing', () => {
    const p = path.join(dir, 'bad.json');
    fs.writeFileSync(p, '{not valid json');
    expect(() => readIpcEnvelopeJson(p)).toThrow();
  });

  it('rejects a symlinked envelope instead of reading its target', () => {
    const target = path.join(dir, 'outside-target');
    const p = path.join(dir, 'link.json');
    fs.writeFileSync(
      target,
      JSON.stringify({ type: 'message', text: 'secret' }),
    );
    fs.symlinkSync(target, p);

    expect(() => readIpcEnvelopeJson(p)).toThrow();
  });

  it('rejects a hard-linked envelope', () => {
    const target = path.join(dir, 'hardlink-target');
    const p = path.join(dir, 'hardlink.json');
    fs.writeFileSync(target, JSON.stringify({ type: 'message', text: 'data' }));
    fs.linkSync(target, p);

    expect(() => readIpcEnvelopeJson(p)).toThrow(/multiple hard links/i);
  });

  it('rejects a FIFO envelope promptly instead of blocking the IPC watcher', () => {
    if (process.platform === 'win32') return;
    const p = path.join(dir, 'pipe.json');
    execFileSync('mkfifo', [p]);
    const readerUrl = pathToFileURL(
      path.resolve('packages/core/src/orchestrator/safe-file-read.ts'),
    ).href;
    const script = `
      import { readBoundedRegularFileNoFollowSync } from ${JSON.stringify(readerUrl)};
      try {
        readBoundedRegularFileNoFollowSync(process.env.TEST_FIFO_PATH, {
          maxBytes: 1024,
          oversize: 'reject',
        });
        process.exit(2);
      } catch (error) {
        if (!/non-regular/i.test(String(error))) {
          console.error(error);
          process.exit(3);
        }
      }
    `;

    expect(() =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        {
          cwd: process.cwd(),
          env: { ...process.env, TEST_FIFO_PATH: p },
          timeout: 2_000,
          stdio: 'pipe',
        },
      ),
    ).not.toThrow();
  });

  it('fails closed when the pathname is replaced after open', () => {
    const p = path.join(dir, 'swap.json');
    fs.writeFileSync(p, JSON.stringify({ text: 'opened inode' }));

    const originalFstatSync = fs.fstatSync;
    let replaced = false;
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((fd) => {
      const stat = originalFstatSync(fd);
      if (!replaced) {
        replaced = true;
        fs.renameSync(p, `${p}.old`);
        fs.writeFileSync(p, JSON.stringify({ text: 'replacement' }));
      }
      return stat;
    });

    try {
      expect(() => readIpcEnvelopeJson(p)).toThrow(/changed while being read/i);
    } finally {
      fstatSpy.mockRestore();
    }
  });

  it('rejects an envelope that grows after fstat without reading the growth', () => {
    const p = path.join(dir, 'growing.json');
    fs.writeFileSync(p, '{}');

    const originalFstatSync = fs.fstatSync;
    let grown = false;
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((fd) => {
      const stat = originalFstatSync(fd);
      if (!grown) {
        grown = true;
        fs.truncateSync(p, MAX_IPC_ENVELOPE_BYTES + 1);
      }
      return stat;
    });

    try {
      expect(() => readIpcEnvelopeJson(p)).toThrow(/grew while being read/i);
    } finally {
      fstatSpy.mockRestore();
    }
  });
});

// --- W25: human title and background/reminder kind ---

describe('schedule_task: название и признак фона (W25)', () => {
  const schedule = (extra: Record<string, unknown>) =>
    processTaskIpc(
      {
        type: 'schedule_task',
        schedule_type: 'interval',
        schedule_value: '3600000',
        targetJid: 'other@g.us',
        ...extra,
      } as Parameters<typeof processTaskIpc>[0],
      'whatsapp_main',
      true,
      deps,
    );

  it('название от модели сохраняется очищенным', async () => {
    await schedule({
      prompt: '<internal>Проверь, готова ли сборка',
      title: '  Слежка за <b>сборкой</b>\n Атлас2 ',
      calendar_event: false,
    });
    const [task] = getAllTasks();
    expect(task.title).toBe('Слежка за сборкой Атлас2');
    expect(task.task_kind).toBe('background');
  });

  it('без названия и с плохим названием задача всё равно создаётся', async () => {
    await schedule({ prompt: 'Напомни оплатить интернет' });
    await schedule({ prompt: 'Напомни про отчёт', title: { bad: true } });
    const tasks = getAllTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.title)).toEqual([null, null]);
    expect(tasks.map((task) => task.task_kind)).toEqual([
      'reminder',
      'reminder',
    ]);
  });

  it('calendar_event=false без <internal> — тоже фон', async () => {
    await schedule({ prompt: 'Контроль обновления', calendar_event: false });
    expect(getAllTasks()[0].task_kind).toBe('background');
  });

  it('cancel_task по-прежнему мягко отменяет задачу', async () => {
    await schedule({ prompt: '<internal>Слежка', taskId: 'task-w25-cancel' });
    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-w25-cancel' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-w25-cancel')).toMatchObject({
      status: 'cancelled',
      next_run: null,
    });
  });
});

// --- W26: wake_if and expires_at ---

describe('schedule_task: wake_if и expires_at (W26)', () => {
  // Local wall time without a zone, as the runner sends it (like once).
  const localTime = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const future = () => localTime(Date.now() + 24 * 3_600_000);

  it('слежка: условие и срок сохраняются, исходное состояние снято, первый запуск не позже срока', async () => {
    const expires = localTime(Date.now() + 30 * 60_000);
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Проверь, готова ли сборка',
        schedule_type: 'interval',
        schedule_value: '3600000',
        targetJid: 'other@g.us',
        wake_if: { path_changed: './output/READY.json', max_sleep_hours: 4 },
        expires_at: expires,
      } as Parameters<typeof processTaskIpc>[0],
      'whatsapp_main',
      true,
      deps,
    );
    const [task] = getAllTasks();
    expect(JSON.parse(task.wake_if!)).toEqual({
      path_changed: 'output/READY.json',
      max_sleep_hours: 4,
    });
    expect(JSON.parse(task.wake_state!)).toMatchObject({
      path: { exists: false },
    });
    expect(task.expires_at).toBe(new Date(expires).toISOString());
    // Interval 1 h, expiry in 30 min: the first run is the expiry itself.
    expect(task.next_run).toBe(task.expires_at);
    // Watching is background work.
    expect(task.task_kind).toBe('background');
  });

  it('слежка никогда не попадает в календарь владельца', async () => {
    const calendarAdapter = fakeCalendarAdapter();
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Напомни мне, когда появится отчёт',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        targetJid: 'main@g.us',
        calendar_event: true,
        wake_if: { path_changed: 'output/report.pdf' },
      } as Parameters<typeof processTaskIpc>[0],
      'whatsapp_main',
      true,
      { ...deps, calendarAdapter },
    );
    expect(getAllTasks()).toHaveLength(1);
    expect(calendarAdapter.createReminderEvent).not.toHaveBeenCalled();
  });

  it('напоминание со сроком: событие в календаре кончается вместе с задачей (UNTIL)', async () => {
    const calendarAdapter = fakeCalendarAdapter();
    const expires = localTime(Date.now() + 4 * 24 * 3_600_000);
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Напоминай каждый день в 9 проверить отчёт',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        targetJid: 'main@g.us',
        expires_at: expires,
      } as Parameters<typeof processTaskIpc>[0],
      'whatsapp_main',
      true,
      { ...deps, calendarAdapter },
    );
    const [task] = getAllTasks();
    expect(task.expires_at).toBe(new Date(expires).toISOString());
    expect(calendarAdapter.createReminderEvent).toHaveBeenCalledTimes(1);
    const { recurrence } = vi.mocked(calendarAdapter.createReminderEvent).mock
      .calls[0][0];
    expect(recurrence).toHaveLength(1);
    const until = /^RRULE:FREQ=DAILY;UNTIL=(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/.exec(
      recurrence![0],
    );
    expect(until).not.toBeNull();
    const [, y, mo, d, h, mi, sec] = until!;
    expect(Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}Z`)).toBe(
      Date.parse(task.expires_at!) - 1_000,
    );
  });

  it('напоминание, которое закроется раньше первого запуска, в календарь не идёт', async () => {
    const calendarAdapter = fakeCalendarAdapter();
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Напоминай раз в день проверить отчёт',
        schedule_type: 'interval',
        schedule_value: String(24 * 3_600_000),
        targetJid: 'main@g.us',
        calendar_event: true,
        expires_at: localTime(Date.now() + 30 * 60_000),
      } as Parameters<typeof processTaskIpc>[0],
      'whatsapp_main',
      true,
      { ...deps, calendarAdapter },
    );
    const [task] = getAllTasks();
    expect(task.next_run).toBe(task.expires_at);
    expect(calendarAdapter.createReminderEvent).not.toHaveBeenCalled();
  });

  it('update_task с новым расписанием не уводит следующий запуск за срок', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'task-watch-resched',
        prompt: '<internal>Проверь сборку',
        schedule_type: 'interval',
        schedule_value: '3600000',
        targetJid: 'other@g.us',
        calendar_event: false,
        expires_at: localTime(Date.now() + 3 * 3_600_000),
      } as Parameters<typeof processTaskIpc>[0],
      'whatsapp_main',
      true,
      deps,
    );
    const created = getTaskById('task-watch-resched')!;
    expect(Date.parse(created.next_run!)).toBeLessThan(
      Date.parse(created.expires_at!),
    );
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-watch-resched',
        schedule_value: String(24 * 3_600_000),
      },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-watch-resched')!.next_run).toBe(created.expires_at);
  });

  it('разовой задаче условие и срок не даются — задача не создаётся', async () => {
    for (const extra of [
      { wake_if: { new_messages: true } },
      { expires_at: future() },
    ]) {
      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'once',
          schedule_type: 'once',
          schedule_value: '2026-12-01T10:00:00',
          targetJid: 'other@g.us',
          ...extra,
        } as Parameters<typeof processTaskIpc>[0],
        'whatsapp_main',
        true,
        deps,
      );
    }
    expect(getAllTasks()).toHaveLength(0);
  });

  it('плохое условие или прошедший срок — отказ', async () => {
    for (const extra of [
      { wake_if: { path_changed: '../telegram_fixture_secondary/secret' } },
      { wake_if: { script: 'check.sh' } },
      { expires_at: '2020-01-01T00:00:00' },
      { expires_at: 'завтра' },
    ]) {
      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'watch',
          schedule_type: 'interval',
          schedule_value: '3600000',
          targetJid: 'other@g.us',
          ...extra,
        } as Parameters<typeof processTaskIpc>[0],
        'whatsapp_main',
        true,
        deps,
      );
    }
    expect(getAllTasks()).toHaveLength(0);
  });

  it('чужой чат смотреть может только задача владельца в главном чате', async () => {
    const watchOther = {
      type: 'schedule_task',
      prompt: 'watch other chat',
      schedule_type: 'interval',
      schedule_value: '3600000',
      wake_if: { new_messages: true, chat_jid: 'third@g.us' },
    };
    // A guest, even for its own chat as the target.
    await processTaskIpc(
      { ...watchOther, targetJid: 'other@g.us' } as Parameters<typeof processTaskIpc>[0],
      'other-group',
      false,
      deps,
    );
    expect(getAllTasks()).toHaveLength(0);
    // The owner, from main, into main.
    await processTaskIpc(
      { ...watchOther, targetJid: 'main@g.us' } as Parameters<typeof processTaskIpc>[0],
      'whatsapp_main',
      true,
      deps,
    );
    expect(getAllTasks()).toHaveLength(1);
    // Its own chat: anyone.
    await processTaskIpc(
      {
        ...watchOther,
        targetJid: 'other@g.us',
        wake_if: { new_messages: true },
      } as Parameters<typeof processTaskIpc>[0],
      'other-group',
      false,
      deps,
    );
    expect(getAllTasks()).toHaveLength(2);
  });

  it('разрешение владельца привязано к условию: подменённый chat_jid не проходит', async () => {
    const authorized = ownerAuthorizedEnvelope(
      {
        type: 'schedule_task',
        prompt: 'watch',
        schedule_type: 'interval',
        schedule_value: '3600000',
        targetJid: 'main@g.us',
        wake_if: { new_messages: true },
      },
      'whatsapp_main',
    );
    expect(authorized.ownerAuthorizationGrant).toBeTruthy();
    await processTaskIpcRaw(
      {
        ...authorized,
        wake_if: { new_messages: true, chat_jid: 'third@g.us' },
      } as Parameters<typeof processTaskIpcRaw>[0],
      'whatsapp_main',
      true,
      deps,
    );
    expect(getAllTasks()).toHaveLength(0);
  });
});

// W14: the runner waits for this receipt so its tool answers with what the
// host really applied. Authority is unchanged: the receipt goes only to the
// requester's own IPC directory and leaks nothing about tasks it may not manage.
describe('task operation receipts (W14)', () => {
  const receiptDir = (folder: string): string => {
    const dir = path.join(DATA_DIR, 'ipc', folder, 'memory');
    fs.mkdirSync(dir, { recursive: true });
    cleanupPaths.push(path.join(DATA_DIR, 'ipc', folder));
    return dir;
  };
  const readReceipt = (folder: string, id: string): Record<string, unknown> | null => {
    const file = path.join(DATA_DIR, 'ipc', folder, 'memory', `${id}.task.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  };
  const task = (id: string, folder: string, jid: string, status: 'active' | 'paused' | 'cancelled' = 'active') =>
    createTask({
      id, group_folder: folder, chat_jid: jid, prompt: 'контроль', schedule_type: 'interval',
      schedule_value: '3600000', context_mode: 'isolated', next_run: '2026-11-07T10:00:00.000Z',
      status, created_at: '2026-11-01T00:00:00.000Z',
    });

  it('confirms a cancel the host applied', async () => {
    receiptDir('whatsapp_main');
    task('task-fixture-cancel', 'other-group', 'other@g.us');
    const receiptId = '0b6c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    await processTaskIpc({ type: 'cancel_task', taskId: 'task-fixture-cancel', receiptId } as never, 'whatsapp_main', true, deps);
    expect(getTaskById('task-fixture-cancel')!.status).toBe('cancelled');
    expect(readReceipt('whatsapp_main', receiptId)).toEqual({
      action: 'cancel_task', taskId: 'task-fixture-cancel', state: 'cancelled', status: 'cancelled', nextRun: null,
    });
  });

  it('confirms a created task and a pause', async () => {
    receiptDir('other-group');
    const createId = '1b6c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    await processTaskIpc({
      type: 'schedule_task', taskId: 'task-new-1', receiptId: createId, prompt: 'напомни',
      schedule_type: 'once', schedule_value: '2026-12-01T09:00:00', targetJid: 'other@g.us',
    } as never, 'other-group', false, deps);
    expect(readReceipt('other-group', createId)).toMatchObject({
      action: 'schedule_task', taskId: 'task-new-1', state: 'created', status: 'active',
    });
    const pauseId = '2b6c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    await processTaskIpc({ type: 'pause_task', taskId: 'task-new-1', receiptId: pauseId } as never, 'other-group', false, deps);
    expect(readReceipt('other-group', pauseId)).toMatchObject({ state: 'paused', status: 'paused' });
  });

  // An interval of 2 h that expires in 1 h first runs at the expiry (W26). The
  // receipt must name that moment, not the uncapped slot an hour later.
  it('a created task with expires_at reports the next run the database holds', async () => {
    receiptDir('other-group');
    const at = new Date(Date.now() + 3_600_000);
    const p = (n: number) => String(n).padStart(2, '0');
    const expires = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`;
    const id = '9b6c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    await processTaskIpc({
      type: 'schedule_task', taskId: 'task-expiring', receiptId: id, prompt: 'проверь сборку',
      schedule_type: 'interval', schedule_value: '7200000', targetJid: 'other@g.us', expires_at: expires,
    } as never, 'other-group', false, deps);
    const created = getTaskById('task-expiring')!;
    expect(created.next_run).toBe(created.expires_at);
    expect(readReceipt('other-group', id)).toMatchObject({
      action: 'schedule_task', taskId: 'task-expiring', state: 'created', nextRun: created.expires_at,
    });
  });

  it('reports «not applied» without revealing a task the chat may not manage', async () => {
    receiptDir('other-group');
    task('task-main-only', 'whatsapp_main', 'main@g.us');
    const id = '3b6c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    await processTaskIpc({ type: 'cancel_task', taskId: 'task-main-only', receiptId: id } as never, 'other-group', false, deps);
    expect(getTaskById('task-main-only')!.status).toBe('active');
    expect(readReceipt('other-group', id)).toEqual({
      action: 'cancel_task', taskId: 'task-main-only', state: 'not_applied', code: 'not_found_or_not_allowed',
    });
    const missing = '4b6c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    await processTaskIpc({ type: 'pause_task', taskId: 'no-such-task', receiptId: missing } as never, 'other-group', false, deps);
    // A missing task reads exactly like one the chat may not manage.
    expect(readReceipt('other-group', missing)).toEqual({
      action: 'pause_task', taskId: 'no-such-task', state: 'not_applied', code: 'not_found_or_not_allowed',
    });
  });

  it('says a cancelled task stays cancelled, and writes nothing without a valid receipt id', async () => {
    const dir = receiptDir('other-group');
    task('task-done', 'other-group', 'other@g.us', 'cancelled');
    const id = '5b6c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    await processTaskIpc({ type: 'resume_task', taskId: 'task-done', receiptId: id } as never, 'other-group', false, deps);
    expect(readReceipt('other-group', id)).toMatchObject({ state: 'not_applied', code: 'task_cancelled' });
    const before = fs.readdirSync(dir).length;
    await processTaskIpc({ type: 'pause_task', taskId: 'task-done' } as never, 'other-group', false, deps);
    await processTaskIpc({ type: 'pause_task', taskId: 'task-done', receiptId: '../../evil' } as never, 'other-group', false, deps);
    expect(fs.readdirSync(dir).length).toBe(before);
  });

  // Google Calendar answered in up to 4.5 s in prod; the receipt used to wait
  // for it, and the runner (then 5 s) told the model «not confirmed» for a
  // reminder that already existed. The receipt now goes out as soon as the
  // database has the change, and only once: the runner deletes it on reading,
  // so a second write would be a stale file nobody reads.
  const slowCall = () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release };
  };
  const receiptPath = (folder: string, id: string) =>
    path.join(DATA_DIR, 'ipc', folder, 'memory', `${id}.task.json`);

  it('sends the schedule_task receipt before a slow calendar call finishes, and only once', async () => {
    receiptDir('whatsapp_main');
    const google = slowCall();
    const createReminderEvent = vi.fn(async () => {
      await google.gate;
      return {
        id: 'google-event-slow', summary: null, description: null, start: null,
        end: null, htmlLink: null, status: 'confirmed',
      };
    });
    deps.calendarAdapter = fakeCalendarAdapter({ createReminderEvent });
    const id = '6b6c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    const processing = processTaskIpc({
      type: 'schedule_task', taskId: 'task-slow-calendar', receiptId: id,
      prompt: 'Напомни владельцу: позвонить', schedule_type: 'once',
      schedule_value: '2026-12-01T09:00:00', calendar_event: true, targetJid: 'other@g.us',
    } as never, 'whatsapp_main', true, deps);
    try {
      await vi.waitFor(() => expect(createReminderEvent).toHaveBeenCalledTimes(1));
      // Google has not answered yet, the receipt is already there.
      expect(readReceipt('whatsapp_main', id)).toMatchObject({
        action: 'schedule_task', taskId: 'task-slow-calendar', state: 'created', status: 'active',
      });
      fs.unlinkSync(receiptPath('whatsapp_main', id)); // the runner consumed it
    } finally {
      google.release();
      await processing;
    }
    expect(getCalendarEventLink('task-slow-calendar')?.event_id).toBe('google-event-slow');
    expect(readReceipt('whatsapp_main', id)).toBeNull();
  });

  it('sends the cancel_task receipt once the row is cancelled, before a slow calendar delete', async () => {
    receiptDir('whatsapp_main');
    task('task-cancel-slow', 'other-group', 'other@g.us');
    upsertCalendarEventLink({
      task_id: 'task-cancel-slow', provider: 'google_calendar', calendar_id: 'owner@example.com',
      event_id: 'google-event-cancel', event_link: null, status: 'active',
    });
    const google = slowCall();
    const deleteEvent = vi.fn(async () => {
      await google.gate;
    });
    deps.calendarAdapter = fakeCalendarAdapter({ deleteEvent });
    const id = '7b6c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    const processing = processTaskIpc(
      { type: 'cancel_task', taskId: 'task-cancel-slow', receiptId: id } as never, 'whatsapp_main', true, deps,
    );
    try {
      await vi.waitFor(() => expect(deleteEvent).toHaveBeenCalledTimes(1));
      // The task can no longer fire while Google answers.
      expect(getTaskById('task-cancel-slow')).toMatchObject({ status: 'cancelled', next_run: null });
      expect(getCalendarEventLink('task-cancel-slow')?.status).toBe('active');
      expect(readReceipt('whatsapp_main', id)).toEqual({
        action: 'cancel_task', taskId: 'task-cancel-slow', state: 'cancelled', status: 'cancelled', nextRun: null,
      });
      fs.unlinkSync(receiptPath('whatsapp_main', id));
    } finally {
      google.release();
      await processing;
    }
    expect(deleteEvent).toHaveBeenCalledWith('google-event-cancel', 'owner@example.com');
    expect(getCalendarEventLink('task-cancel-slow')?.status).toBe('deleted');
    expect(readReceipt('whatsapp_main', id)).toBeNull();
  });

  it('sends the update_task receipt before the calendar re-mirror finishes', async () => {
    receiptDir('whatsapp_main');
    task('task-move', 'other-group', 'other@g.us');
    upsertCalendarEventLink({
      task_id: 'task-move', provider: 'google_calendar', calendar_id: 'owner@example.com',
      event_id: 'google-event-old', event_link: null, status: 'active',
    });
    const google = slowCall();
    const deleteEvent = vi.fn(async () => {
      await google.gate;
    });
    deps.calendarAdapter = fakeCalendarAdapter({ deleteEvent });
    const id = '8b6c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    const processing = processTaskIpc({
      type: 'update_task', taskId: 'task-move', receiptId: id, schedule_value: '7200000',
    } as never, 'whatsapp_main', true, deps);
    try {
      await vi.waitFor(() => expect(deleteEvent).toHaveBeenCalledTimes(1));
      expect(readReceipt('whatsapp_main', id)).toMatchObject({
        action: 'update_task', taskId: 'task-move', state: 'updated', status: 'active',
        nextRun: getTaskById('task-move')!.next_run,
      });
      fs.unlinkSync(receiptPath('whatsapp_main', id));
    } finally {
      google.release();
      await processing;
    }
    expect(getTaskById('task-move')!.schedule_value).toBe('7200000');
    expect(readReceipt('whatsapp_main', id)).toBeNull();
  });
});
