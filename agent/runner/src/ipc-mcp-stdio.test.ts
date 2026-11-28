import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
} from 'crypto';

import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  resetInstanceProfileForTests,
  setInstanceProfileForTests,
} from './instance-profile.js';
import {
  FOREIGN_URLS_FILE,
  foreignUrlsFilePath,
  readForeignUrls,
} from './link-check.js';

// Capture every server.tool(name, description, schema, handler) registration so
// tests can invoke the real handlers without a live MCP transport.
const registeredTools = new Map<
  string,
  (args: unknown, extra?: unknown) => unknown
>();
// The descriptions are what the model reads: tests check they promise only
// what the host really does (SR-3, INT-3).
const registeredToolDescriptions = new Map<string, string>();
// W15: annotations (server.tool's 4th of 5 arguments) and raw zod shapes.
const registeredToolAnnotations = new Map<string, unknown>();
const registeredToolSchemas = new Map<string, unknown>();

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    constructor(_opts: unknown) {}
    tool(...callArgs: unknown[]) {
      const name = callArgs[0] as string;
      const handler = callArgs[callArgs.length - 1] as (
        args: unknown,
        extra?: unknown,
      ) => unknown;
      registeredTools.set(name, handler);
      if (typeof callArgs[1] === 'string') {
        registeredToolDescriptions.set(name, callArgs[1]);
      }
      registeredToolAnnotations.set(
        name,
        callArgs.length === 5 ? callArgs[3] : undefined,
      );
      if (callArgs.length >= 4) registeredToolSchemas.set(name, callArgs[2]);
      return {};
    }
    async connect() {
      /* no-op: never opens stdio in tests */
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

const COMPUTER_TOOLS = [
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_open_app',
  'computer_mouse_move',
  'computer_screen_size',
];

const CODEX_DESKTOP_TOOLS = ['codex_desktop_status', 'codex_desktop_control'];

const MINIMAL_ARGS: Record<string, unknown> = {
  computer_screenshot: {},
  computer_click: { x: 10, y: 20 },
  computer_type: { text: 'hi' },
  computer_key: { keys: 'return' },
  computer_open_app: { name: 'Safari' },
  computer_mouse_move: { x: 5, y: 5 },
  computer_screen_size: {},
  codex_desktop_status: { action: 'status' },
  codex_desktop_control: {
    action: 'open',
    thread_id: '00000000-0000-0000-0000-000000000000',
  },
};

function openTaskAuthorizationEnvelopeForTest(
  request: Record<string, unknown>,
  capabilitySecret: string,
): Record<string, unknown> {
  const capabilityId = String(request.capability_id);
  const requestId = String(request.request_id);
  const action = String(request.action);
  const sealed = request.sealed_envelope as Record<string, unknown>;
  const key = createHmac('sha256', Buffer.from(capabilitySecret, 'base64url'))
    .update('skoobi.task_authorization.envelope.key.v1')
    .update('\0')
    .update(capabilityId)
    .digest();
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(String(sealed.iv), 'base64url'),
    );
    decipher.setAAD(
      Buffer.from(
        JSON.stringify([
          'skoobi.task_authorization.envelope.aad.v1',
          capabilityId,
          requestId,
          action,
        ]),
      ),
    );
    decipher.setAuthTag(Buffer.from(String(sealed.tag), 'base64url'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(String(sealed.ciphertext), 'base64url')),
        decipher.final(),
      ]).toString('utf8'),
    ) as Record<string, unknown>;
  } finally {
    key.fill(0);
  }
}

/**
 * A stand-in for the host's structured-memory IPC (memory-state-service):
 * opens each sealed memory_state request of this run's capability, records
 * its payload and answers with a sealed, proof-carrying result.
 */
function startMemoryStateHost(opts: {
  memoryIpcDir: string;
  capabilityId: string;
  capabilitySecret: string;
  groupFolder: string;
  respond: (payload: Record<string, unknown>) => {
    ok: boolean;
    data?: unknown;
    error?: string;
  };
}): { requests: Record<string, unknown>[]; stop: () => void } {
  const secret = Buffer.from(opts.capabilitySecret, 'base64url');
  const key = (purpose: 'request' | 'response') =>
    createHmac('sha256', secret)
      .update(`skoobi.memory_state.${purpose}.key.v1`)
      .digest();
  const aad = (purpose: 'request' | 'response', requestId: string) =>
    Buffer.from(
      JSON.stringify([
        `skoobi.memory_state.${purpose}.v1`,
        requestId,
        opts.capabilityId,
        opts.groupFolder,
      ]),
    );
  const requests: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let stopped = false;
  const poll = () => {
    if (stopped) return;
    try {
      for (const name of fs.readdirSync(opts.memoryIpcDir)) {
        if (!name.endsWith('.request.json') || seen.has(name)) continue;
        const raw = JSON.parse(
          fs.readFileSync(path.join(opts.memoryIpcDir, name), 'utf8'),
        ) as Record<string, any>;
        if (raw.type !== 'memory_state' || !raw.sealed_payload) continue;
        seen.add(name);
        const requestId = String(raw.request_id);
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key('request'),
          Buffer.from(raw.sealed_payload.iv, 'base64url'),
        );
        decipher.setAAD(aad('request', requestId));
        decipher.setAuthTag(Buffer.from(raw.sealed_payload.tag, 'base64url'));
        const request = JSON.parse(
          Buffer.concat([
            decipher.update(
              Buffer.from(raw.sealed_payload.ciphertext, 'base64url'),
            ),
            decipher.final(),
          ]).toString('utf8'),
        ) as { payload: Record<string, unknown> };
        requests.push(request.payload);
        const answer = opts.respond(request.payload);
        const response = {
          type: 'memory_state_result',
          request_id: requestId,
          ok: answer.ok,
          ...(answer.data === undefined ? {} : { data: answer.data }),
          ...(answer.error === undefined ? {} : { error: answer.error }),
        };
        const proof = createHmac('sha256', secret)
          .update(
            JSON.stringify([
              'skoobi.memory_state.response.v1',
              response.type,
              response.request_id,
              response.ok,
              answer.data ?? null,
              answer.error ?? null,
              null,
            ]),
          )
          .digest('base64url');
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key('response'), iv);
        cipher.setAAD(aad('response', requestId));
        const ciphertext = Buffer.concat([
          cipher.update(
            Buffer.from(JSON.stringify({ ...response, response_proof: proof })),
          ),
          cipher.final(),
        ]);
        const resultPath = path.join(
          opts.memoryIpcDir,
          `${requestId}.result.json`,
        );
        fs.writeFileSync(
          `${resultPath}.tmp`,
          JSON.stringify({
            type: 'memory_state_result',
            request_id: requestId,
            capability_id: opts.capabilityId,
            sealed_payload: {
              v: 1,
              iv: iv.toString('base64url'),
              ciphertext: ciphertext.toString('base64url'),
              tag: cipher.getAuthTag().toString('base64url'),
            },
          }),
        );
        fs.renameSync(`${resultPath}.tmp`, resultPath);
      }
    } catch {
      // A request still being written: look again on the next tick.
    }
    setTimeout(poll, 10);
  };
  poll();
  return {
    requests,
    stop: () => {
      stopped = true;
    },
  };
}

function setBaseEnv() {
  process.env.CLAUDECLAW_CHAT_JID = 'tg:-100123:456';
  process.env.CLAUDECLAW_GROUP_FOLDER = 'telegram_guest-chat';
  process.env.CLAUDECLAW_IPC_DIR = '/tmp/ipc-mcp-stdio-test';
  delete process.env.CLAUDECLAW_GROUP_DIR;
  delete process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN;
  delete process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN;
  delete process.env.CLAUDECLAW_CODEX_GUI_CONTROL_AUTHORIZED;
  delete process.env.CLAUDECLAW_CODEX_CONTROL_RUN_ID;
  delete process.env.CLAUDECLAW_OPERATION_TRACE_CAPABILITY;
  delete process.env.CLAUDECLAW_TELEGRAM_EDIT_BINDING;
  // HELPER_SECRET present so that, absent the gate, callHelper would attempt a
  // real fetch — letting the test prove the gate short-circuits before that.
  process.env.HELPER_SECRET = 'test-secret';
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  registeredTools.clear();
  registeredToolDescriptions.clear();
  registeredToolAnnotations.clear();
  registeredToolSchemas.clear();
  vi.resetModules();
  setBaseEnv();
  fetchSpy = vi.fn(async () => {
    throw new Error('fetch must not be called for a denied guest');
  });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLAUDECLAW_IS_MAIN;
  delete process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN;
  delete process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN;
  delete process.env.CLAUDECLAW_CODEX_GUI_CONTROL_AUTHORIZED;
  delete process.env.CLAUDECLAW_CODEX_CONTROL_RUN_ID;
  delete process.env.CLAUDECLAW_GROUP_DIR;
  delete process.env.CLAUDECLAW_SKILLS_DIR;
  delete process.env.CLAUDECLAW_MEMORY_WRITE_CAPABILITY;
  delete process.env.CLAUDECLAW_MEMORY_PROVENANCE_PUBLIC_KEY;
  delete process.env.CLAUDECLAW_TENANT_ID;
  delete process.env.CLAUDECLAW_SENDER_ID;
  delete process.env.CLAUDECLAW_IDENTITY_ID;
  delete process.env.CLAUDECLAW_BOT_ID;
  delete process.env.CLAUDECLAW_PERSONA_ID;
  delete process.env.CLAUDECLAW_SHARED_USER_MEMORY_DIR;
  delete process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY;
  delete process.env.CLAUDECLAW_GAME_FACTORY_CAPABILITY;
  delete process.env.CLAUDECLAW_OPERATION_TRACE_CAPABILITY;
  delete process.env.CLAUDECLAW_TELEGRAM_EDIT_BINDING;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CLAUDECLAW_CHAT_HISTORY_')) delete process.env[key];
  }
});

describe('host diagnostic IPC correlation', () => {
  it('forwards only the environment binding and does not add delivery authority', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-trace-test-'));
    try {
      process.env.CLAUDECLAW_IPC_DIR = dir;
      process.env.CLAUDECLAW_IS_MAIN = '0';
      process.env.CLAUDECLAW_OPERATION_TRACE_CAPABILITY = 'a'.repeat(43);
      process.env.CLAUDECLAW_TELEGRAM_EDIT_BINDING = 'b'.repeat(43);
      await import('./ipc-mcp-stdio.js');
      const response = await registeredTools.get('send_message')!({
        text: 'Synthetic trace message',
        operationTraceCapability: 'forged',
      });
      const files = fs.readdirSync(path.join(dir, 'messages'));
      expect(files).toHaveLength(1);
      const envelope = JSON.parse(
        fs.readFileSync(path.join(dir, 'messages', files[0]), 'utf8'),
      );
      expect(envelope.operationTraceCapability).toBe('a'.repeat(43));
      expect(envelope.telegramEditBinding).toBe('b'.repeat(43));
      expect(JSON.stringify(response)).not.toContain('b'.repeat(43));
      expect(envelope.ownerAuthorizationGrant).toBeUndefined();
      expect(JSON.stringify(response)).not.toContain('a'.repeat(43));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A minimal host for tests that send schedule_task: it answers every task
// envelope with a «created» receipt, as the real host does since W14. Without
// it each call waits the full TASK_RECEIPT_TIMEOUT_MS (10 s) — even one call
// blows the test timeout (seen with two calls at 5 s when r1108 merged W14
// with W25/W26).
function startFakeTaskHost(ipcDir: string): () => void {
  const tasksDir = path.join(ipcDir, 'tasks');
  const memoryDir = path.join(ipcDir, 'memory');
  const answered = new Set<string>();
  const timer = setInterval(() => {
    if (!fs.existsSync(tasksDir)) return;
    for (const file of fs.readdirSync(tasksDir)) {
      if (!file.endsWith('.json') || answered.has(file)) continue;
      answered.add(file);
      const envelope = JSON.parse(
        fs.readFileSync(path.join(tasksDir, file), 'utf8'),
      ) as { receiptId?: string; taskId?: string };
      if (!envelope.receiptId) continue;
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(
        path.join(memoryDir, `${envelope.receiptId}.task.json`),
        JSON.stringify({
          action: 'schedule_task',
          taskId: envelope.taskId,
          state: 'created',
          status: 'active',
        }),
      );
    }
  }, 20);
  return () => clearInterval(timer);
}

describe('schedule_task: человеческое название (W25)', () => {
  it('описание просит название, а поле title уходит хосту как есть', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-runner-title-'));
    const stopHost = startFakeTaskHost(ipcDir);
    try {
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      process.env.CLAUDECLAW_IS_MAIN = '0';
      await import('./ipc-mcp-stdio.js');
      const description = registeredToolDescriptions.get('schedule_task') ?? '';
      expect(description).toContain('TITLE: always give a short human title');
      expect(description).toContain('/tasks');

      await registeredTools.get('schedule_task')!({
        prompt: '<internal>Проверь сборку',
        schedule_type: 'interval',
        schedule_value: '3600000',
        context_mode: 'isolated',
        title: 'Слежка за сборкой',
        calendar_event: false,
      });
      await registeredTools.get('schedule_task')!({
        prompt: 'Напомни про отчёт',
        schedule_type: 'interval',
        schedule_value: '3600000',
        context_mode: 'isolated',
      });
      const envelopes = fs
        .readdirSync(path.join(ipcDir, 'tasks'))
        .filter((f) => f.endsWith('.json'))
        .map((f) =>
          JSON.parse(fs.readFileSync(path.join(ipcDir, 'tasks', f), 'utf8')),
        );
      expect(envelopes).toHaveLength(2);
      const titled = envelopes.find((e) => e.prompt.startsWith('<internal>'));
      const untitled = envelopes.find((e) => !e.prompt.startsWith('<internal>'));
      expect(titled.title).toBe('Слежка за сборкой');
      expect('title' in untitled).toBe(false);
    } finally {
      stopHost();
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });
});

describe('schedule_task: фон любого расписания помечается как фон (W25)', () => {
  // Повторяющаяся фоновая работа без <internal> и calendar_event=false
  // становилась «напоминанием»: кнопки /tasks её не останавливали (в проде так
  // шли «Автономная локальная разработка…» каждый час и read-only проверка).
  it('описание требует <internal> и calendar_event=false и для interval/cron', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '0';
    await import('./ipc-mcp-stdio.js');
    const description = registeredToolDescriptions.get('schedule_task') ?? '';
    expect(description).toContain(
      'For internal/background tasks of ANY schedule type (once, interval or cron',
    );
    expect(description).not.toContain('For internal/background one-shot tasks');
    expect(description).toContain('buttons under /tasks');
  });
});

describe('schedule_task: слежка через wake_if и expires_at (W26)', () => {
  it('описание запрещает следить за файлом, который задача пишет сама', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '0';
    await import('./ipc-mcp-stdio.js');
    const description = registeredToolDescriptions.get('schedule_task') ?? '';
    expect(description).toContain(
      'Never point wake_if.path_changed at a file or folder the task itself writes',
    );
  });

  it('описание требует одну interval-задачу вместо цепочки разовых', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '0';
    await import('./ipc-mcp-stdio.js');
    const description = registeredToolDescriptions.get('schedule_task') ?? '';
    expect(description).toContain(
      'для слежки — одна interval-задача с wake_if и expires_at',
    );
    expect(description).toContain('NOT a chain of once tasks');
    expect(description).toContain('max_sleep_hours (default 6)');
  });

  it('проверка полей до записи IPC — понятные ошибки для модели', async () => {
    const { scheduleTaskWatchError } = await import('./ipc-mcp-stdio.js');
    const now = Date.parse('2026-11-08T10:00:00');
    expect(
      scheduleTaskWatchError(
        { schedule_type: 'once', wake_if: { new_messages: true } },
        true,
        now,
      ),
    ).toMatch(/only for interval\/cron tasks/);
    expect(
      scheduleTaskWatchError({ schedule_type: 'interval', wake_if: {} }, true, now),
    ).toMatch(/path_changed and\/or new_messages/);
    expect(
      scheduleTaskWatchError(
        { schedule_type: 'interval', wake_if: { path_changed: '../x' } },
        true,
        now,
      ),
    ).toMatch(/relative to this group folder/);
    expect(
      scheduleTaskWatchError(
        {
          schedule_type: 'interval',
          wake_if: { new_messages: true, chat_jid: 'tg:1' },
        },
        false,
        now,
      ),
    ).toMatch(/only in the main chat/);
    expect(
      scheduleTaskWatchError(
        { schedule_type: 'cron', expires_at: '2026-11-09T18:00:00Z' },
        true,
        now,
      ),
    ).toMatch(/without timezone suffix/);
    expect(
      scheduleTaskWatchError(
        { schedule_type: 'cron', expires_at: '2026-11-07T18:00:00' },
        true,
        now,
      ),
    ).toMatch(/future local time/);
    expect(
      scheduleTaskWatchError(
        {
          schedule_type: 'interval',
          wake_if: { path_changed: 'output/READY.json', max_sleep_hours: 3 },
          expires_at: '2026-11-09T18:00:00',
        },
        true,
        now,
      ),
    ).toBeNull();
  });

  it('условие и срок уходят хосту; разовая задача с условием не записывается', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-runner-wake-'));
    const stopHost = startFakeTaskHost(ipcDir);
    try {
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      process.env.CLAUDECLAW_IS_MAIN = '0';
      await import('./ipc-mcp-stdio.js');
      const expires = new Date(Date.now() + 86_400_000);
      const p = (n: number) => String(n).padStart(2, '0');
      const local = `${expires.getFullYear()}-${p(expires.getMonth() + 1)}-${p(expires.getDate())}T18:00:00`;
      await registeredTools.get('schedule_task')!({
        prompt: '<internal>Проверь сборку',
        schedule_type: 'interval',
        schedule_value: '600000',
        context_mode: 'isolated',
        wake_if: { path_changed: 'output/READY.json' },
        expires_at: local,
      });
      const refused = (await registeredTools.get('schedule_task')!({
        prompt: '<internal>Проверь сборку',
        schedule_type: 'once',
        schedule_value: local,
        context_mode: 'isolated',
        wake_if: { path_changed: 'output/READY.json' },
      })) as { isError?: boolean };
      expect(refused.isError).toBe(true);
      const envelopes = fs
        .readdirSync(path.join(ipcDir, 'tasks'))
        .filter((f) => f.endsWith('.json'))
        .map((f) =>
          JSON.parse(fs.readFileSync(path.join(ipcDir, 'tasks', f), 'utf8')),
        );
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0].wake_if).toEqual({ path_changed: 'output/READY.json' });
      expect(envelopes[0].expires_at).toBe(local);
    } finally {
      stopHost();
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });
});

describe('task tool descriptions match what the host does (check 09.10, SR-3 + INT-3)', () => {
  it('cancel_task keeps the row, only cleanup_tasks deletes; pause/resume are paused-only and return the host-applied status; list_tasks hides cancelled', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    await import('./ipc-mcp-stdio.js');

    const cancel = registeredToolDescriptions.get('cancel_task') ?? '';
    // The host marks the row cancelled (runtime-namespace / task-scheduler);
    // «Cancel and delete» made the model answer «удалил» and call it again.
    expect(cancel).not.toMatch(/cancel and delete/i);
    expect(cancel).toContain('stays in history with status "cancelled"');
    expect(cancel).toContain('hidden from list_tasks');
    expect(cancel).toContain('Only cleanup_tasks removes');
    expect(cancel).toContain('cannot be resumed');

    const resume = registeredToolDescriptions.get('resume_task') ?? '';
    expect(resume).toContain('PAUSED task only');
    expect(resume).toContain('A cancelled task cannot be resumed');
    expect(resume).toContain('schedule_task');
    // W14: the tools answer with the host's receipt; list_tasks is a snapshot
    // from the start of the run and cannot confirm a change made in it.
    expect(resume).toContain('status the host actually applied');
    expect(resume).not.toContain('confirm the new status with list_tasks');

    const pause = registeredToolDescriptions.get('pause_task') ?? '';
    expect(pause).toContain('ACTIVE scheduled task');
    expect(pause).toContain('A cancelled task cannot be paused');
    expect(pause).toContain('status the host actually applied');
    expect(pause).not.toContain('confirm the new status with list_tasks');

    expect(cancel).toContain('status the host actually applied');
    expect(registeredToolDescriptions.get('update_task') ?? '').toContain('status the host actually applied');

    const list = registeredToolDescriptions.get('list_tasks') ?? '';
    expect(list).toContain('active, paused and completed');
    expect(list).toContain('Cancelled tasks are HIDDEN');
    expect(list).toContain('cleanup_tasks');
    expect(list).toContain('SNAPSHOT taken when this run started');

    expect(registeredTools.get('cancel_task')).toBeTypeOf('function');
    expect(registeredTools.get('resume_task')).toBeTypeOf('function');
  });
});

describe('task operations return the host receipt (W14)', () => {
  it('cancel_task answers with the status the host applied', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-receipt-'));
    const tasksDir = path.join(ipcDir, 'tasks');
    const memoryDir = path.join(ipcDir, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    process.env.CLAUDECLAW_IPC_DIR = ipcDir;
    process.env.CLAUDECLAW_IS_MAIN = '1';
    try {
      await import('./ipc-mcp-stdio.js');
      // A minimal host: picks the envelope up and writes its receipt.
      let envelope: Record<string, unknown> | undefined;
      const host = setInterval(() => {
        if (envelope || !fs.existsSync(tasksDir)) return;
        const file = fs.readdirSync(tasksDir).find((name) => name.endsWith('.json'));
        if (!file) return;
        envelope = JSON.parse(fs.readFileSync(path.join(tasksDir, file), 'utf8'));
        fs.writeFileSync(path.join(memoryDir, `${envelope!.receiptId}.task.json`), JSON.stringify({
          action: 'cancel_task', taskId: envelope!.taskId, state: 'cancelled', status: 'cancelled', nextRun: null,
        }));
      }, 20);
      const result = (await registeredTools.get('cancel_task')!({ task_id: 'task-1700000000000-fixture' })) as {
        content: Array<{ text: string }>; isError?: boolean;
      };
      clearInterval(host);
      expect(envelope?.type).toBe('cancel_task');
      expect(envelope?.receiptId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(
        'Task task-1700000000000-fixture cancelled — confirmed by the host. It will not run again.',
      );
      // The receipt is consumed.
      expect(fs.readdirSync(memoryDir)).toEqual([]);
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });

  it('says plainly when the host did not apply the change, and when it has not confirmed yet', async () => {
    const mod = await import('./ipc-mcp-stdio.js');
    expect(mod.taskOperationResultText('pause_task', 't1', { state: 'not_applied', code: 'task_cancelled' }))
      .toEqual({ text: expect.stringContaining('did NOT apply pause_task'), isError: true });
    expect(mod.taskOperationResultText('resume_task', 't1', { state: 'resumed', nextRun: '2026-11-09T04:00:00.000Z' }).text)
      .toBe('Task t1 resumed — confirmed by the host (status active; next run: 2026-11-09T04:00:00.000Z).');
    const pending = mod.taskOperationResultText('cancel_task', 't1', null);
    expect(pending.isError).toBeUndefined();
    expect(pending.text).toContain('do not tell the user it failed');
    // A model that retries an unconfirmed schedule_task makes a second reminder.
    expect(pending.text).toContain('within 10 s');
    expect(pending.text).toContain(
      'Do not call cancel_task again for this request — that would make a duplicate.',
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-receipt-wait-'));
    try {
      const started = Date.now();
      expect(await mod.waitForTaskOperationReceipt(dir, randomUUID(), 120)).toBeNull();
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('waits long enough for a receipt that comes after 5 s (IPC tick + slow host)', async () => {
    const mod = await import('./ipc-mcp-stdio.js');
    expect(mod.TASK_RECEIPT_TIMEOUT_MS).toBe(10_000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-receipt-late-'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const receiptId = randomUUID();
      // Default timeout, as sendTaskOperation uses it.
      const waiting = mod.waitForTaskOperationReceipt(dir, receiptId);
      await vi.advanceTimersByTimeAsync(6_500);
      fs.writeFileSync(
        path.join(dir, `${receiptId}.task.json`),
        JSON.stringify({ action: 'schedule_task', taskId: 't1', state: 'created', status: 'active' }),
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(await waiting).toMatchObject({ state: 'created', taskId: 't1' });
    } finally {
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('memory_save trusted provenance boundary', () => {
  it('queues only content hints and appends a host-signed identity-bound entry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-save-signed-'));
    const groupDir = path.join(root, 'group');
    const ipcDir = path.join(root, 'ipc');
    const memoryIpcDir = path.join(ipcDir, 'memory');
    fs.mkdirSync(path.join(groupDir, 'memory', 'topics'), {
      recursive: true,
    });
    fs.mkdirSync(memoryIpcDir, { recursive: true });
    const keys = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    process.env.CLAUDECLAW_GROUP_DIR = groupDir;
    process.env.CLAUDECLAW_IPC_DIR = ipcDir;
    process.env.CLAUDECLAW_CHAT_JID = 'tg:-100123';
    process.env.CLAUDECLAW_GROUP_FOLDER = 'telegram_guest-chat';
    process.env.CLAUDECLAW_IS_MAIN = '0';
    process.env.CLAUDECLAW_TENANT_ID = 'tenant_a';
    process.env.CLAUDECLAW_SENDER_ID = 'sender_a';
    process.env.CLAUDECLAW_IDENTITY_ID = 'identity_a';
    process.env.CLAUDECLAW_BOT_ID = 'bot_a';
    process.env.CLAUDECLAW_PERSONA_ID = 'persona_a';
    const capabilityId = 'm'.repeat(43);
    const capabilitySecret = Buffer.alloc(32, 0x5a).toString('base64url');
    process.env.CLAUDECLAW_MEMORY_WRITE_CAPABILITY = `${capabilityId}.${capabilitySecret}`;
    process.env.CLAUDECLAW_MEMORY_PROVENANCE_PUBLIC_KEY = keys.publicKey;

    try {
      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_save');
      expect(handler).toBeTypeOf('function');

      let observedRequest: Record<string, unknown> | undefined;
      let hostEnvelope = '';
      const responder = new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const poll = () => {
          try {
            const requestFile = fs
              .readdirSync(memoryIpcDir)
              .find((name) => name.endsWith('.request.json'));
            if (!requestFile) {
              if (Date.now() >= deadline) {
                reject(new Error('memory signing request not observed'));
                return;
              }
              setTimeout(poll, 10);
              return;
            }
            observedRequest = JSON.parse(
              fs.readFileSync(path.join(memoryIpcDir, requestFile), 'utf8'),
            ) as Record<string, unknown>;
            const requestId = String(observedRequest.request_id);
            const label = 'memory/topics/profile.md';
            const payload = {
              v: 1,
              entry_id: randomUUID(),
              scope: `group:telegram_guest-chat:${label}`,
              stamp: '2026-07-11 12:00:00',
              content: observedRequest.content,
              metadata: {
                source_type: 'user_message',
                confidence: 0.9,
                group_folder: 'telegram_guest-chat',
                chat_jid: 'tg:-100123',
                tenant_id: 'tenant_a',
                sender_id: 'sender_a',
                identity_id: 'identity_a',
                bot_id: 'bot_a',
                persona_id: 'persona_a',
                provenance: 'host_signed_identity',
              },
            };
            const payloadBytes = Buffer.from(JSON.stringify(payload));
            const envelope = `${payloadBytes.toString('base64url')}.${cryptoSign(null, payloadBytes, keys.privateKey).toString('base64url')}`;
            hostEnvelope = envelope;
            fs.writeFileSync(
              path.join(memoryIpcDir, `${requestId}.result.json`),
              JSON.stringify({
                type: 'memory_sign_result',
                request_id: requestId,
                ok: true,
                entries: [
                  {
                    target: 'group',
                    label,
                    entry_line: `- [${payload.stamp}] ${payload.content} <!-- skoobi_memory_v2=${envelope} -->\n`,
                  },
                ],
              }),
            );
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        poll();
      });

      const result = (await handler!({
        content: 'Likes concise answers',
        category: 'topic',
        topic: 'profile',
        source_type: 'user_message',
        confidence: 0.9,
        sender_id: 'ATTACKER_SELECTED_SENDER',
        tenant_id: 'ATTACKER_SELECTED_TENANT',
      })) as { isError?: boolean; content: { text: string }[] };
      await responder;

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('memory/topics/profile.md');
      expect(observedRequest).not.toHaveProperty('sender_id');
      expect(observedRequest).not.toHaveProperty('tenant_id');
      expect(observedRequest).not.toHaveProperty('capability');
      expect(observedRequest).toMatchObject({ capability_id: capabilityId });
      expect(observedRequest?.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(observedRequest)).not.toContain(capabilitySecret);
      const saved = fs.readFileSync(
        path.join(groupDir, 'memory', 'topics', 'profile.md'),
        'utf8',
      );
      expect(saved).toContain('Likes concise answers');
      expect(saved).toContain('skoobi_memory_v2=');
      expect(saved).not.toContain('ATTACKER_SELECTED_SENDER');
      expect(saved).not.toContain('ATTACKER_SELECTED_TENANT');

      const memoryFile = path.join(groupDir, 'memory', 'topics', 'profile.md');
      const [encodedPayload, originalSignature] = hostEnvelope.split('.');
      const changedPayload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      changedPayload.content = 'TAMPERED SIGNED PAYLOAD';
      const invalidChangedEnvelope = `${Buffer.from(JSON.stringify(changedPayload)).toString('base64url')}.${originalSignature}`;
      fs.appendFileSync(
        memoryFile,
        `- FORGED UNSIGNED DIRECT APPEND <!-- skoobi_memory_meta={"sender_id":"sender_a","tenant_id":"tenant_a"} -->\n` +
          `- CHANGED VISIBLE COPY <!-- skoobi_memory_v2=${hostEnvelope} -->\n` +
          `- TAMPERED SIGNED PAYLOAD <!-- skoobi_memory_v2=${invalidChangedEnvelope} -->\n`,
      );

      const getHandler = registeredTools.get('memory_get');
      const getResult = (await getHandler!({
        file: 'memory/topics/profile.md',
      })) as { content: { text: string }[] };
      expect(getResult.content[0].text).toContain('Likes concise answers');
      expect(
        getResult.content[0].text.match(/Likes concise answers/g),
      ).toHaveLength(1);
      expect(getResult.content[0].text).not.toContain('FORGED UNSIGNED');
      expect(getResult.content[0].text).not.toContain('CHANGED VISIBLE');
      expect(getResult.content[0].text).not.toContain('TAMPERED SIGNED');

      // With a memory grant memory_search also asks the host's structured
      // memory (W07); this stand-in host has no matching records.
      const stateHost = startMemoryStateHost({
        memoryIpcDir,
        capabilityId,
        capabilitySecret,
        groupFolder: 'telegram_guest-chat',
        respond: () => ({ ok: true, data: { results: [], terms: 2, scanned: 0 } }),
      });
      try {
        const searchHandler = registeredTools.get('memory_search');
        const forgedSearch = (await searchHandler!({
          query: 'FORGED UNSIGNED',
          max_results: 10,
        })) as { content: { text: string }[] };
        expect(forgedSearch.content[0].text).toMatch(/no matches found/i);
        expect(forgedSearch.content[0].text).toContain(
          '[база] No matching current records',
        );
        const validSearch = (await searchHandler!({
          query: 'concise answers',
          max_results: 10,
        })) as { content: { text: string }[] };
        expect(validSearch.content[0].text).toContain('Likes concise answers');
        expect(stateHost.requests).toEqual([
          { action: 'search', query: 'FORGED UNSIGNED', limit: 8 },
          { action: 'search', query: 'concise answers', limit: 8 },
        ]);
      } finally {
        stateHost.stop();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for a guest when the host signer grant is absent', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'memory-save-nosigner-'),
    );
    process.env.CLAUDECLAW_GROUP_DIR = root;
    process.env.CLAUDECLAW_IS_MAIN = '0';
    try {
      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_save');
      const result = (await handler!({
        content: 'Unsigned fallback must not be saved',
        category: 'daily',
        source_type: 'manual',
        confidence: 0.7,
      })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/signer is unavailable/i);
      expect(fs.existsSync(path.join(root, 'memory'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the trusted main/owner local-save fallback during signer outages', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-save-main-'));
    process.env.CLAUDECLAW_GROUP_DIR = root;
    process.env.CLAUDECLAW_IS_MAIN = '1';
    try {
      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_save');
      const result = (await handler!({
        content: 'Owner operational preference',
        category: 'topic',
        topic: 'operations',
        source_type: 'manual',
        confidence: 0.8,
      })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('memory/topics/operations.md');
      expect(
        fs.readFileSync(
          path.join(root, 'memory', 'topics', 'operations.md'),
          'utf8',
        ),
      ).toContain('Owner operational preference');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// W12: the runner refused any note with the words token, password,
// secret or .env before the host ever saw it. Only real values are refused now.
describe('memory_save refuses credential values, not words', () => {
  it('saves notes that mention tokens or .env and refuses an actual value', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-save-words-'));
    process.env.CLAUDECLAW_GROUP_DIR = root;
    process.env.CLAUDECLAW_IS_MAIN = '1';
    try {
      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_save');
      const save = (content: string) =>
        handler!({ content, category: 'daily', source_type: 'manual', confidence: 0.8 }) as Promise<{
          isError?: boolean;
          content: { text: string }[];
        }>;
      const note = await save('Токены жалко, .env не трогали, token budget обновлён');
      expect(note.content[0].text).not.toMatch(/looks like a secret/i);
      const day = fs.readdirSync(path.join(root, 'memory')).find((name) => name.endsWith('.md'));
      expect(fs.readFileSync(path.join(root, 'memory', day!), 'utf8')).toContain('Токены жалко');
      const secret = await save('password=' + 'synthetic-placeholder');
      expect(secret.content[0].text).toMatch(/looks like a secret/i);
      // Review r1111 (turn-3, security-4): the refusal says what to change.
      expect(secret.content[0].text).toMatch(/Remove the value/);
      // Review r1111 (memory detector): only the value goes, the note stays.
      expect(secret.content[0].text).toMatch(/Remove the value itself and keep the rest of the note/);
      // Round 0: the hint no longer lists the forms it catches (a table or
      // «value (пароль)» read as a way around); it says any form is refused.
      expect(secret.content[0].text).toMatch(/refused in any form/);
      expect(secret.content[0].text).toMatch(/in a table, a list, a field or a variable/);
      expect(secret.content[0].text).toMatch(/same text again gets the same refusal/);
      // Round 1: a lone word after «Пароль:» is a value; the hint shows how to
      // name a holder instead («пароль у Гульнары»).
      expect(secret.content[0].text).toMatch(/single word after «Пароль:»/);
      expect(secret.content[0].text).toMatch(/«пароль у Гульнары»/);
      // Notes about whose password it is are saved (3c5ff5d saved them too).
      const who = await save('Пароль от почты хранится у Ивана, не спрашивать');
      expect(who.content[0].text).not.toMatch(/looks like a secret/i);
      // A state word no longer hides the value after it (security-1).
      const changed = await save('пароль сменён на ' + 'Xyz' + '123');
      expect(changed.content[0].text).toMatch(/looks like a secret/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('denyHostControlIfNotMain', () => {
  it('returns an isError deny result for guest groups', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '0';
    const mod = await import('./ipc-mcp-stdio.js');
    const denied = mod.denyHostControlIfNotMain(false);
    expect(denied).not.toBeNull();
    expect(denied?.isError).toBe(true);
    expect(denied?.content[0].text).toMatch(/main\/owner group/i);
  });

  it('returns null for the main group (allowed)', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    const mod = await import('./ipc-mcp-stdio.js');
    expect(mod.denyHostControlIfNotMain(true)).toBeNull();
  });
});

describe('computer_* tools are gated behind isMain', () => {
  it('denies every host-control tool for a guest chat without calling the helper', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '0';
    await import('./ipc-mcp-stdio.js');

    for (const name of COMPUTER_TOOLS) {
      const handler = registeredTools.get(name);
      expect(handler, `tool ${name} should be registered`).toBeTypeOf(
        'function',
      );
      const result = (await handler!(MINIMAL_ARGS[name])) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError, `${name} must be denied for guests`).toBe(true);
      expect(result.content[0].text).toMatch(/main\/owner group/i);
    }

    // The gate must short-circuit before any helper network call.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets the main group reach the helper (proxies past the gate)', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    // For main, the gate returns null and the handler proceeds to callHelper,
    // which performs a fetch. Stub a successful helper response.
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ path: '/tmp/shot.png', bytes: 1234 });
      },
    }));
    await import('./ipc-mcp-stdio.js');

    const handler = registeredTools.get('computer_screenshot');
    expect(handler).toBeTypeOf('function');
    const result = (await handler!({})) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      'X-Skoobi-Codex-Gui-Authorized',
    );
    expect(result.content[0].text).toMatch(/Screenshot saved/);
  });

  it('adds Codex GUI authorization only for the explicit direct owner run', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '1';
    process.env.CLAUDECLAW_CODEX_GUI_CONTROL_AUTHORIZED = '1';
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ path: '/tmp/shot.png', bytes: 1234 });
      },
    }));
    await import('./ipc-mcp-stdio.js');

    await registeredTools.get('computer_screenshot')!({});
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      'X-Skoobi-Codex-Gui-Authorized': '1',
    });
  });

  it('ignores a forged Codex GUI flag in a scheduled owner run', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '0';
    process.env.CLAUDECLAW_CODEX_GUI_CONTROL_AUTHORIZED = '1';
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ path: '/tmp/shot.png', bytes: 1234 });
      },
    }));
    await import('./ipc-mcp-stdio.js');

    await registeredTools.get('computer_screenshot')!({});
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      'X-Skoobi-Codex-Gui-Authorized',
    );
  });
});

describe('computer_screenshot geometry and screenshot_id coordinates', () => {
  type ToolResult = { isError?: boolean; content: { text: string }[] };
  type HelperRoute = (
    body: Record<string, unknown> | undefined,
  ) => Record<string, unknown>;

  const FULL_SHOT = {
    path: '/tmp/skoobi-screenshots/1-00000000-0000-4000-8000-000000000000.jpg',
    bytes: 190000,
    format: 'jpeg',
    width: 1280,
    height: 803,
    region: { x: 0, y: 0, width: 1512, height: 949 },
    display: { width: 1512, height: 949, scale: 2, screens: 1 },
    source_width: 3024,
    source_height: 1898,
    downscaled: true,
  };

  function routeHelper(routes: Record<string, HelperRoute>) {
    fetchSpy.mockImplementation(
      async (url: string, init?: { body?: string }) => {
        const endpoint = new URL(url).pathname;
        const route = routes[endpoint];
        if (!route) throw new Error(`unexpected helper call ${endpoint}`);
        const body = init?.body
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
        const answer = route(body);
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify(answer);
          },
        };
      },
    );
  }

  function helperBodies(endpoint: string): unknown[] {
    return fetchSpy.mock.calls
      .filter(
        (call: unknown[]) => new URL(String(call[0])).pathname === endpoint,
      )
      .map((call: unknown[]) => {
        const init = call[1] as { body?: string } | undefined;
        return init?.body ? JSON.parse(init.body) : undefined;
      });
  }

  async function tool(name: string, args: unknown): Promise<ToolResult> {
    const handler = registeredTools.get(name);
    expect(handler, `tool ${name} should be registered`).toBeTypeOf('function');
    return (await handler!(args)) as ToolResult;
  }

  function screenshotIdOf(result: ToolResult): string {
    const match = result.content[0].text.match(/screenshot_id="([^"]+)"/);
    expect(match, result.content[0].text).not.toBeNull();
    return match![1];
  }

  beforeEach(() => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
  });

  it('asks for a 1280 px JPEG and keeps the parseable "Screenshot saved" prefix', async () => {
    routeHelper({ '/screenshot': () => FULL_SHOT });
    await import('./ipc-mcp-stdio.js');

    const result = await tool('computer_screenshot', {});
    expect(result.isError).toBeUndefined();
    expect(helperBodies('/screenshot')).toEqual([
      { format: 'jpeg', max_side: 1280, quality: 70 },
    ]);
    const text = result.content[0].text;
    // Models extract the path with exactly this pattern.
    expect(text.match(/Screenshot saved: (.+?) \(/)?.[1]).toBe(FULL_SHOT.path);
    expect(
      text.startsWith(`Screenshot saved: ${FULL_SHOT.path} (190000 bytes).`),
    ).toBe(true);
    expect(screenshotIdOf(result)).toMatch(/^s1-[0-9a-f]{4}$/);
    expect(text).toContain(
      'Image 1280x803 px (JPEG) covers screen points x=0..1512, y=0..949 (1 image px ≈ 1.181 pt).',
    );
    expect(text).toContain('do not rescale yourself');
    expect(text).toContain('view_image');
    expect(text).not.toContain('Use Read');
  });

  it('converts image pixels of a screenshot to screen points for clicks', async () => {
    routeHelper({
      '/screenshot': () => FULL_SHOT,
      '/click': (body) => ({ ok: true, ...body }),
    });
    await import('./ipc-mcp-stdio.js');

    const id = screenshotIdOf(await tool('computer_screenshot', {}));
    const result = await tool('computer_click', {
      x: 640,
      y: 400,
      screenshot_id: id,
    });
    expect(result.isError).toBeUndefined();
    const [body] = helperBodies('/click') as { x: number; y: number }[];
    expect(body.x).toBeCloseTo(756, 5);
    expect(body.y).toBeCloseTo(472.73, 2);
    expect(Object.keys(body).sort()).toEqual(['x', 'y']);
    expect(result.content[0].text).toContain(
      `image px (640, 400) of screenshot ${id} = screen point (756, 472.73)`,
    );
  });

  it('passes button and double through with converted coordinates', async () => {
    routeHelper({
      '/screenshot': () => FULL_SHOT,
      '/click': (body) => ({ ok: true, ...body }),
    });
    await import('./ipc-mcp-stdio.js');

    const id = screenshotIdOf(await tool('computer_screenshot', {}));
    await tool('computer_click', {
      x: 0,
      y: 803,
      screenshot_id: id,
      button: 'left',
      double: true,
    });
    expect(helperBodies('/click')).toEqual([
      { x: 0, y: 949, button: 'left', double: true },
    ]);
  });

  it('converts mouse_move the same way', async () => {
    routeHelper({
      '/screenshot': () => FULL_SHOT,
      '/mouse_move': (body) => ({ ok: true, ...body }),
    });
    await import('./ipc-mcp-stdio.js');

    const id = screenshotIdOf(await tool('computer_screenshot', {}));
    const result = await tool('computer_mouse_move', {
      x: 1280,
      y: 0,
      screenshot_id: id,
    });
    expect(result.isError).toBeUndefined();
    expect(helperBodies('/mouse_move')).toEqual([{ x: 1512, y: 0 }]);
    expect(result.content[0].text).toContain(
      `Mouse moved to (1512, 0) — screen points for image px (1280, 0) of screenshot ${id}.`,
    );
  });

  it('maps clicks inside a region screenshot relative to that region', async () => {
    routeHelper({
      '/screenshot': () => ({
        ...FULL_SHOT,
        width: 600,
        height: 400,
        region: { x: 100, y: 50, width: 300, height: 200 },
        downscaled: false,
      }),
      '/click': (body) => ({ ok: true, ...body }),
    });
    await import('./ipc-mcp-stdio.js');

    const shot = await tool('computer_screenshot', {
      region: { x: 100, y: 50, width: 300, height: 200 },
    });
    expect(helperBodies('/screenshot')).toEqual([
      {
        format: 'jpeg',
        max_side: 1280,
        quality: 70,
        region: { x: 100, y: 50, width: 300, height: 200 },
      },
    ]);
    expect(shot.content[0].text).toContain(
      'covers screen points x=100..400, y=50..250 (1 image px ≈ 0.500 pt)',
    );
    await tool('computer_click', {
      x: 300,
      y: 200,
      screenshot_id: screenshotIdOf(shot),
    });
    expect(helperBodies('/click')).toEqual([{ x: 250, y: 150 }]);
  });

  it('converts a zoom region given in screenshot pixels to screen points', async () => {
    routeHelper({ '/screenshot': () => FULL_SHOT });
    await import('./ipc-mcp-stdio.js');

    const id = screenshotIdOf(await tool('computer_screenshot', {}));
    const result = await tool('computer_screenshot', {
      region: { x: 0, y: 0, width: 640, height: 400 },
      screenshot_id: id,
      max_side: 1600,
    });
    expect(result.isError).toBeUndefined();
    const bodies = helperBodies('/screenshot') as Record<string, unknown>[];
    expect(bodies[1]).toEqual({
      format: 'jpeg',
      max_side: 1600,
      quality: 70,
      region: { x: 0, y: 0, width: 756, height: 472.73 },
    });
    // The second screenshot gets its own id.
    const secondId = screenshotIdOf(result);
    expect(secondId).not.toBe(id);
    expect(secondId).toMatch(/^s2-/);
    // Later screenshots of the turn repeat only the essentials.
    const text = result.content[0].text;
    expect(text.match(/Screenshot saved: (.+?) \(/)?.[1]).toBe(FULL_SHOT.path);
    expect(text).toContain('covers screen points x=0..1512, y=0..949');
    expect(text).toContain(
      `Click with IMAGE pixel x/y: computer_click({x, y, screenshot_id:"${secondId}"})`,
    );
    expect(text).not.toContain('do not rescale yourself');
  });

  it('clips a zoom region to the source image and refuses one outside it', async () => {
    routeHelper({ '/screenshot': () => FULL_SHOT });
    await import('./ipc-mcp-stdio.js');

    const id = screenshotIdOf(await tool('computer_screenshot', {}));
    await tool('computer_screenshot', {
      region: { x: 1200, y: 700, width: 400, height: 400 },
      screenshot_id: id,
    });
    const bodies = helperBodies('/screenshot') as Record<string, unknown>[];
    const region = bodies[1].region as Record<string, number>;
    expect(region.x).toBeCloseTo(1417.5, 2);
    expect(region.x + region.width).toBeCloseTo(1512, 1);
    expect(region.y + region.height).toBeCloseTo(949, 1);

    const outside = await tool('computer_screenshot', {
      region: { x: 1300, y: 0, width: 100, height: 100 },
      screenshot_id: id,
    });
    expect(outside.isError).toBe(true);
    expect(outside.content[0].text).toMatch(/outside screenshot/);
    expect(helperBodies('/screenshot')).toHaveLength(2);
  });

  it('refuses an unknown screenshot_id before calling the helper', async () => {
    routeHelper({ '/click': (body) => ({ ok: true, ...body }) });
    await import('./ipc-mcp-stdio.js');

    for (const name of ['computer_click', 'computer_mouse_move']) {
      const result = await tool(name, { x: 10, y: 10, screenshot_id: 's9' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Unknown screenshot_id "s9"/);
      expect(result.content[0].text).toMatch(/new computer_screenshot/);
    }
    const zoom = await tool('computer_screenshot', {
      region: { x: 0, y: 0, width: 10, height: 10 },
      screenshot_id: 's9',
    });
    expect(zoom.isError).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses image pixels outside the screenshot', async () => {
    routeHelper({
      '/screenshot': () => FULL_SHOT,
      '/click': (body) => ({ ok: true, ...body }),
    });
    await import('./ipc-mcp-stdio.js');

    const id = screenshotIdOf(await tool('computer_screenshot', {}));
    for (const [x, y] of [
      [1281, 10],
      [10, 804],
      [-1, 10],
      [1512, 900],
    ]) {
      const result = await tool('computer_click', { x, y, screenshot_id: id });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/outside screenshot/);
    }
    expect(helperBodies('/click')).toHaveLength(0);
  });

  it('keeps plain screen points when no screenshot_id is given', async () => {
    routeHelper({
      '/click': (body) => ({ ok: true, ...body }),
      '/mouse_move': (body) => ({ ok: true, ...body }),
    });
    await import('./ipc-mcp-stdio.js');

    const click = await tool('computer_click', { x: 10, y: 20 });
    expect(helperBodies('/click')).toEqual([{ x: 10, y: 20 }]);
    expect(click.content[0].text).toBe('Clicked: {"ok":true,"x":10,"y":20}');
    const move = await tool('computer_mouse_move', { x: 5, y: 5 });
    expect(helperBodies('/mouse_move')).toEqual([{ x: 5, y: 5 }]);
    expect(move.content[0].text).toBe('Mouse moved to (5, 5).');
  });

  it('falls back to the legacy text with an old helper that reports no geometry', async () => {
    routeHelper({
      '/screenshot': () => ({ path: '/tmp/shot.png', bytes: 1234 }),
      '/click': (body) => ({ ok: true, ...body }),
    });
    await import('./ipc-mcp-stdio.js');

    const result = await tool('computer_screenshot', {});
    const text = result.content[0].text;
    expect(text).toBe(
      'Screenshot saved: /tmp/shot.png (1234 bytes). View it with view_image (path). Coordinates for computer_click are screen points (see computer_screen_size).',
    );
    expect(text).not.toContain('screenshot_id');

    const zoom = await tool('computer_screenshot', {
      region: { x: 0, y: 0, width: 100, height: 100 },
    });
    expect(zoom.content[0].text).toContain('ignored region/max_side');

    const click = await tool('computer_click', {
      x: 10,
      y: 10,
      screenshot_id: 's1',
    });
    expect(click.isError).toBe(true);
    expect(helperBodies('/click')).toHaveLength(0);
  });

  it('explains a current helper answer that has no geometry', async () => {
    routeHelper({
      '/screenshot': () => ({
        path: '/tmp/skoobi-screenshots/3.png',
        bytes: 2_000_000,
        format: 'png',
        width: 3024,
        height: 1898,
      }),
    });
    await import('./ipc-mcp-stdio.js');

    const text = (await tool('computer_screenshot', {})).content[0].text;
    expect(text).toMatch(
      /^Screenshot saved: \/tmp\/skoobi-screenshots\/3\.png \(2000000 bytes\)\./,
    );
    expect(text).toContain('could not work out the screen geometry');
    expect(text).not.toContain('screenshot_id=');
  });

  it('says so when the helper had to fall back to the full-size PNG', async () => {
    routeHelper({
      '/screenshot': () => ({
        ...FULL_SHOT,
        path: '/tmp/skoobi-screenshots/2.png',
        format: 'png',
        width: 3024,
        height: 1898,
        downscaled: false,
        fallback: true,
        display: { width: 1512, height: 949, scale: 2, screens: 2 },
      }),
    });
    await import('./ipc-mcp-stdio.js');

    const text = (await tool('computer_screenshot', {})).content[0].text;
    expect(text).toContain('Image 3024x1898 px (PNG)');
    expect(text).toContain('(1 image px ≈ 0.500 pt)');
    expect(text).toContain('could not shrink this capture');
    expect(text).toContain('Only the main display is captured (2 displays');
  });

  it('queues the returned JPEG when send_to_user is set', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-send-'));
    process.env.CLAUDECLAW_IPC_DIR = ipcDir;
    routeHelper({ '/screenshot': () => FULL_SHOT });
    try {
      await import('./ipc-mcp-stdio.js');
      const result = await tool('computer_screenshot', {
        send_to_user: true,
        caption: 'экран',
      });
      expect(result.content[0].text).toContain(
        `Screenshot saved: ${FULL_SHOT.path} (190000 bytes). (queued for delivery to user) screenshot_id=`,
      );
      const messagesDir = path.join(ipcDir, 'messages');
      const [file] = fs.readdirSync(messagesDir);
      const envelope = JSON.parse(
        fs.readFileSync(path.join(messagesDir, file), 'utf8'),
      );
      expect(envelope).toMatchObject({
        type: 'photo',
        filePath: FULL_SHOT.path,
        caption: 'экран',
      });
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });

  it('prints the Retina scale and the screenshot_id hint in computer_screen_size', async () => {
    routeHelper({
      '/screen_size': () => ({ width: 1512, height: 949, scale: 2 }),
    });
    await import('./ipc-mcp-stdio.js');

    const text = (await tool('computer_screen_size', {})).content[0].text;
    expect(text).toMatch(/^Screen size: 1512x949 \(points; Retina scale 2\)\./);
    expect(text).toContain('screenshot_id');
  });

  it('exports pure geometry helpers', async () => {
    const mod = await import('./ipc-mcp-stdio.js');
    expect(mod.parseHelperScreenshotGeometry(FULL_SHOT)).toEqual({
      path: FULL_SHOT.path,
      imageWidth: 1280,
      imageHeight: 803,
      region: { x: 0, y: 0, width: 1512, height: 949 },
    });
    expect(
      mod.parseHelperScreenshotGeometry({ path: '/tmp/a.png', bytes: 1 }),
    ).toBeNull();
    expect(
      mod.parseHelperScreenshotGeometry({ ...FULL_SHOT, width: 0 }),
    ).toBeNull();
    expect(
      mod.parseHelperScreenshotGeometry({
        ...FULL_SHOT,
        region: { x: 0, y: 0, width: 'wide', height: 949 },
      }),
    ).toBeNull();

    const geom = {
      id: 't1',
      path: FULL_SHOT.path,
      imageWidth: 1280,
      imageHeight: 803,
      region: { x: 0, y: 0, width: 1512, height: 949 },
    };
    const point = mod.imagePointToScreen(geom, 1280, 803);
    expect(point.x).toBeCloseTo(1512, 6);
    expect(point.y).toBeCloseTo(949, 6);
    // Separate factors per axis (1512/1280 vs 949/803).
    expect(mod.imagePointToScreen(geom, 100, 100).x).toBeCloseTo(118.125, 6);
    expect(mod.imagePointToScreen(geom, 100, 100).y).toBeCloseTo(118.182, 3);
    expect(() => mod.imagePointToScreen(geom, Number.NaN, 1)).toThrow(
      /outside screenshot t1/,
    );
    expect(
      mod.imageRectToScreen(
        {
          ...geom,
          imageWidth: 600,
          imageHeight: 400,
          region: { x: 100, y: 50, width: 300, height: 200 },
        },
        { x: 100, y: 100, width: 200, height: 100 },
      ),
    ).toEqual({ x: 150, y: 100, width: 100, height: 50 });
  });

  it('forgets the oldest screenshots beyond the per-turn cap', async () => {
    const mod = await import('./ipc-mcp-stdio.js');
    const ids: string[] = [];
    for (let i = 0; i < 51; i += 1) {
      ids.push(
        mod.rememberScreenshotGeometry({
          path: `/tmp/${i}.jpg`,
          imageWidth: 100,
          imageHeight: 100,
          region: { x: 0, y: 0, width: 100, height: 100 },
        }).id,
      );
    }
    expect(() => mod.lookupScreenshotGeometry(ids[0])).toThrow(
      /Unknown screenshot_id/,
    );
    expect(mod.lookupScreenshotGeometry(ids[1]).path).toBe('/tmp/1.jpg');
    expect(mod.lookupScreenshotGeometry(ids[50]).path).toBe('/tmp/50.jpg');
  });
});

describe('Codex Desktop tools are main-only', () => {
  it('does not register either bridge tool for a guest chat', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '0';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '1';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY = 'forged';
    await import('./ipc-mcp-stdio.js');

    for (const name of CODEX_DESKTOP_TOOLS) {
      expect(
        registeredTools.has(name),
        `${name} must be absent for guests`,
      ).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('registers both bridge tools for the trusted main group', async () => {
    const codexControlRunId = '00000000-0000-4000-8000-000000000002';
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '1';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY =
      'direct-owner-run-capability';
    process.env.CLAUDECLAW_CODEX_CONTROL_RUN_ID = codexControlRunId;
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ appServer: { running: true }, task: null });
      },
    }));
    await import('./ipc-mcp-stdio.js');

    for (const name of CODEX_DESKTOP_TOOLS) {
      expect(registeredTools.get(name)).toBeTypeOf('function');
    }
    const status = (await registeredTools.get('codex_desktop_status')!({
      action: 'status',
    })) as { isError?: boolean; content: { text: string }[] };
    expect(status.isError).toBeUndefined();
    expect(status.content[0].text).toContain('appServer');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      'X-Skoobi-Chat-Jid': process.env.CLAUDECLAW_CHAT_JID,
      // M-G2.3a: the helper log names the chat by its folder.
      'X-Skoobi-Group-Folder': process.env.CLAUDECLAW_GROUP_FOLDER,
      'X-Skoobi-Codex-Control-Run-Id': codexControlRunId,
    });

    await registeredTools.get('codex_desktop_control')!({
      action: 'start',
      cwd: '/tmp/safe-project',
      prompt: 'safe test',
    });
    expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({
      'X-Skoobi-Codex-Control-Run-Id': codexControlRunId,
    });
  });

  it('surfaces safe bridge diagnostics and rejects unsafe raw detail', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '1';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY =
      'direct-owner-run-capability';
    process.env.CLAUDECLAW_CODEX_CONTROL_RUN_ID =
      '00000000-0000-4000-8000-000000000003';
    fetchSpy
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        async text() {
          return JSON.stringify({
            error: 'cwd_not_authorized',
            detail:
              'cwd is outside the authorized Codex Desktop project roots. Inspect status before retrying.',
          });
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        async text() {
          return JSON.stringify({
            error: 'codex_desktop_internal_error',
            detail:
              'SECRET_TOKEN=must-not-leak at /private/credentials/service.json',
          });
        },
      });
    await import('./ipc-mcp-stdio.js');

    const handler = registeredTools.get('codex_desktop_control');
    const publicFailure = (await handler!({
      action: 'start',
      cwd: '/outside',
      prompt: 'safe test',
    })) as { isError?: boolean; content: { text: string }[] };
    expect(publicFailure.isError).toBe(true);
    expect(publicFailure.content[0].text).toContain('cwd_not_authorized');
    expect(publicFailure.content[0].text).toContain(
      'Inspect status before retrying',
    );

    const internalFailure = (await handler!({
      action: 'open',
      thread_id: '00000000-0000-0000-0000-000000000000',
    })) as { isError?: boolean; content: { text: string }[] };
    expect(internalFailure.isError).toBe(true);
    expect(internalFailure.content[0].text).toContain(
      'codex_desktop_internal_error',
    );
    expect(internalFailure.content[0].text).not.toContain('SECRET_TOKEN');
    expect(internalFailure.content[0].text).not.toContain(
      '/private/credentials',
    );
  });

  it('keeps every bridge tool absent from a main-group guest run', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '0';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '1';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY = 'forged';
    await import('./ipc-mcp-stdio.js');

    expect(registeredTools.has('codex_desktop_status')).toBe(false);
    expect(registeredTools.has('codex_desktop_control')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps every bridge tool absent from a trusted scheduled owner run', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '0';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY =
      'scheduled-owner-capability';
    await import('./ipc-mcp-stdio.js');

    expect(registeredTools.has('codex_desktop_status')).toBe(false);
    expect(registeredTools.has('codex_desktop_control')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('memory_search', () => {
  it('rejects oversized and hardlinked memory before get/search can read it', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-memory-bounds-'),
    );
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_CHAT_JID = 'tg:123';
      process.env.CLAUDECLAW_IS_MAIN = '1';
      const topics = path.join(root, 'memory', 'topics');
      fs.mkdirSync(topics, { recursive: true });
      const large = path.join(topics, 'large.md');
      fs.writeFileSync(large, 'OVERSIZED_MEMORY_MARKER');
      fs.truncateSync(large, 2 * 1024 * 1024 + 1);
      const original = path.join(root, 'original.md');
      fs.writeFileSync(original, 'HARDLINK_MEMORY_MARKER');
      fs.linkSync(original, path.join(topics, 'hardlink.md'));

      await import('./ipc-mcp-stdio.js');
      const getHandler = registeredTools.get('memory_get');
      for (const file of [
        'memory/topics/large.md',
        'memory/topics/hardlink.md',
      ]) {
        const result = (await getHandler!({ file })) as {
          content: { text: string }[];
        };
        expect(result.content[0].text).toBe('');
      }

      const searchHandler = registeredTools.get('memory_search');
      for (const query of [
        'OVERSIZED_MEMORY_MARKER',
        'HARDLINK_MEMORY_MARKER',
      ]) {
        const result = (await searchHandler!({ query, max_results: 5 })) as {
          content: { text: string }[];
        };
        expect(result.content[0].text).not.toContain(query);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for sender-less background reads in a multi-member chat', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-memory-background-'),
    );
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_CHAT_JID = 'tg:-100123';
      process.env.CLAUDECLAW_IS_MAIN = '0';
      fs.mkdirSync(path.join(root, 'memory', 'topics'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'memory', 'topics', 'other-member.md'),
        'OTHER_MEMBER_PRIVATE_MARKER',
      );

      await import('./ipc-mcp-stdio.js');
      const getHandler = registeredTools.get('memory_get');
      const getResult = (await getHandler!({
        file: 'memory/topics/other-member.md',
      })) as { content: { text: string }[] };
      expect(getResult.content[0].text).toBe('');

      const searchHandler = registeredTools.get('memory_search');
      const searchResult = (await searchHandler!({
        query: 'OTHER_MEMBER_PRIVATE_MARKER',
        max_results: 5,
      })) as { content: { text: string }[] };
      expect(searchResult.content[0].text).toMatch(/no matches found/i);
      expect(searchResult.content[0].text).not.toContain('other-member.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses SQLite FTS5/BM25 when the local index is available', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-fts-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      fs.mkdirSync(path.join(root, 'memory', 'topics'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'memory', 'topics', 'suppliers.md'),
        'Fixture City: библиотека Example хранит книги и журналы.',
      );

      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_search');
      expect(handler).toBeTypeOf('function');
      const result = (await handler!({
        query: 'библиотека Fixture City',
        max_results: 5,
      })) as { content: { text: string }[] };

      expect(result.content[0].text).toContain('SQLite FTS5/BM25');
      expect(result.content[0].text).toContain('memory/topics/suppliers.md');
      expect(result.content[0].text).toContain('библиотека');
      // A new file for the trigram schema; the v1 index is never touched.
      expect(
        fs.existsSync(path.join(root, '.skoobi', 'memory-search-v2.sqlite')),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(root, '.skoobi', 'memory-search.sqlite')),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to grep when the SQLite index path is broken', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-grep-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      fs.mkdirSync(path.join(root, 'memory', 'topics'), { recursive: true });
      fs.writeFileSync(path.join(root, '.skoobi'), 'not a directory');
      fs.writeFileSync(
        path.join(root, 'memory', 'topics', 'fallback.md'),
        'Fallback search should find this rare-keyword line.',
      );

      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_search');
      expect(handler).toBeTypeOf('function');
      const result = (await handler!({
        query: 'rare-keyword',
        max_results: 5,
      })) as { content: { text: string }[] };

      expect(result.content[0].text).toContain('grep fallback');
      expect(result.content[0].text).toContain('memory/topics/fallback.md');
      expect(result.content[0].text).toContain('rare-keyword');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Month review 26.10 (C04): the 32 MiB budget was spent alphabetically, so
  // conversations/ dumps filled it and fresh memory/ topics never got indexed.
  it('finds a 1 MB memory/ topic while conversations/ holds 40 MB of dumps', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-memory-budget-'),
    );
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      const conversations = path.join(root, 'conversations');
      fs.mkdirSync(conversations, { recursive: true });
      for (let i = 0; i < 20; i++) {
        const dump = Buffer.alloc(
          2 * 1024 * 1024 - 4096,
          'old conversation dump line\n',
        );
        fs.writeFileSync(
          path.join(
            conversations,
            `2026-06-${String(i + 1).padStart(2, '0')}-chat.md`,
          ),
          i === 0
            ? Buffer.concat([dump, Buffer.from('CONVERSATION_ONLY_MARKER\n')])
            : dump,
        );
      }
      const topics = path.join(root, 'memory', 'topics');
      fs.mkdirSync(topics, { recursive: true });
      const signature = `<!-- skoobi_memory_v2=SIGPAYLOADxyz${'A'.repeat(300)}.${'B'.repeat(86)} -->`;
      const lines: string[] = ['# Game notes', ''];
      for (let n = 0, bytes = 0; bytes < 1024 * 1024; n++) {
        const line = `- [2026-10-25 12:00] Заметка ${n}: уровень пройден ${signature}`;
        lines.push(line);
        bytes += Buffer.byteLength(line) + 1;
      }
      lines.push(
        `- [2026-10-25 12:21] Roblox: два игрока, Server и Clients, версия 0.3 ${signature}`,
      );
      fs.writeFileSync(path.join(topics, 'zz-game-notes.md'), lines.join('\n'));

      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_search')!;
      const search = async (query: string) =>
        (
          (await handler({ query, max_results: 5 })) as {
            content: { text: string }[];
          }
        ).content[0].text;

      const found = await search('Roblox Server');
      expect(found).toMatch(/^Found 1 matches via SQLite FTS5\/BM25:/);
      expect(found).toContain('memory/topics/zz-game-notes.md');
      expect(found).toContain('>>>Roblox<<<');
      expect(found).not.toContain('conversations/');
      // Provenance markers are stripped before indexing: no base64 noise.
      expect(found).not.toContain('skoobi_memory_v2');
      expect(await search('SIGPAYLOADxyz')).toMatch(/^No matches found/);
      // The frozen dumps are out of the index (chat_history reads the chats).
      expect(await search('CONVERSATION_ONLY_MARKER')).toMatch(
        /^No matches found/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Week review (W07): decisions and task state live in memory_state,
  // so memory_search also asks the host for them.
  it('adds structured memory hits marked [база] after the file hits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-state-search-'));
    try {
      const groupDir = path.join(root, 'group');
      const ipcDir = path.join(root, 'ipc');
      const memoryIpcDir = path.join(ipcDir, 'memory');
      fs.mkdirSync(path.join(groupDir, 'memory', 'topics'), { recursive: true });
      fs.mkdirSync(memoryIpcDir, { recursive: true });
      fs.writeFileSync(
        path.join(groupDir, 'memory', 'topics', 'codex.md'),
        'Тариф сервиса Codex обсуждали в октябре.',
      );
      process.env.CLAUDECLAW_GROUP_DIR = groupDir;
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      process.env.CLAUDECLAW_CHAT_JID = 'tg:123';
      process.env.CLAUDECLAW_GROUP_FOLDER = 'telegram_main';
      process.env.CLAUDECLAW_IS_MAIN = '1';
      const capabilityId = 's'.repeat(43);
      const capabilitySecret = Buffer.alloc(32, 0x3c).toString('base64url');
      process.env.CLAUDECLAW_MEMORY_WRITE_CAPABILITY = `${capabilityId}.${capabilitySecret}`;
      const host = startMemoryStateHost({
        memoryIpcDir,
        capabilityId,
        capabilitySecret,
        groupFolder: 'telegram_main',
        respond: () => ({
          ok: true,
          data: {
            terms: 2,
            scanned: 3,
            results: [
              {
                kind: 'project',
                projectKey: 'sample-plan-comparison',
                key: 'sample-plan-comparison',
                revision: 2,
                updatedAt: '2026-01-15T10:00:00.000Z',
                title: 'Тарифы Basic и Max — сравнение подготовлено',
                status: 'completed',
                closed: true,
                excerpt: 'Тариф Max включает больше квоты и Ultrafast',
                matchedTerms: 1,
              },
              {
                kind: 'fact',
                projectKey: null,
                key: 'token-economy',
                revision: 1,
                updatedAt: '2026-01-16T10:00:00.000Z',
                factType: 'decision',
                status: null,
                closed: false,
                excerpt: 'Пример решения: беречь токены.',
                matchedTerms: 1,
              },
            ],
          },
        }),
      });
      try {
        await import('./ipc-mcp-stdio.js');
        const text = (
          (await registeredTools.get('memory_search')!({
            query: 'Codex Ultra',
            max_results: 5,
          })) as { content: { text: string }[] }
        ).content[0].text;
        expect(text.indexOf('memory/topics/codex.md')).toBeGreaterThanOrEqual(0);
        expect(text.indexOf('memory/topics/codex.md')).toBeLessThan(
          text.indexOf('[база]'),
        );
        expect(text).toContain(
          '[база] project sample-plan-comparison rev 2, completed — завершено, не возобновлять, updated 2026-01-15: Тариф Max включает больше квоты и Ultrafast',
        );
        expect(text).toContain(
          '[база] decision global/token-economy rev 1, updated 2026-01-16: Пример решения: беречь токены.',
        );
        expect(host.requests).toEqual([
          { action: 'search', query: 'Codex Ultra', limit: 8 },
        ]);
        expect(registeredToolDescriptions.get('memory_search')).toContain(
          '[база]',
        );
      } finally {
        host.stop();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('takes an answer that arrived while the wait was blocked past its deadline', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-state-late-'));
    try {
      const ipcDir = path.join(root, 'ipc');
      const memoryIpcDir = path.join(ipcDir, 'memory');
      fs.mkdirSync(memoryIpcDir, { recursive: true });
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      process.env.CLAUDECLAW_CHAT_JID = 'tg:123';
      process.env.CLAUDECLAW_GROUP_FOLDER = 'telegram_main';
      process.env.CLAUDECLAW_IS_MAIN = '1';
      const capabilityId = 'l'.repeat(43);
      const capabilitySecret = Buffer.alloc(32, 0x4d).toString('base64url');
      process.env.CLAUDECLAW_MEMORY_WRITE_CAPABILITY = `${capabilityId}.${capabilitySecret}`;
      const host = startMemoryStateHost({
        memoryIpcDir,
        capabilityId,
        capabilitySecret,
        groupFolder: 'telegram_main',
        respond: () => ({ ok: true, data: { results: [], terms: 1, scanned: 0 } }),
      });
      try {
        const mod = await import('./ipc-mcp-stdio.js');
        // memory_search starts the request, then searches files synchronously:
        // the deadline can pass before the wait looks again.
        const result = await mod.requestHostMemoryState(
          { action: 'search', query: 'склад' },
          1,
        );
        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true });
      } finally {
        host.stop();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('narrows a scheduled run search to its bound project and reports a refusal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-state-scheduled-'));
    try {
      const groupDir = path.join(root, 'group');
      const ipcDir = path.join(root, 'ipc');
      const memoryIpcDir = path.join(ipcDir, 'memory');
      fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
      fs.mkdirSync(memoryIpcDir, { recursive: true });
      fs.writeFileSync(path.join(groupDir, 'memory', 'note.md'), 'Заметка.');
      process.env.CLAUDECLAW_GROUP_DIR = groupDir;
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      process.env.CLAUDECLAW_CHAT_JID = 'tg:123';
      process.env.CLAUDECLAW_GROUP_FOLDER = 'telegram_main';
      process.env.CLAUDECLAW_IS_MAIN = '1';
      const capabilityId = 'r'.repeat(43);
      const capabilitySecret = Buffer.alloc(32, 0x2b).toString('base64url');
      process.env.CLAUDECLAW_MEMORY_READ_CAPABILITY = `${capabilityId}.${capabilitySecret}`;
      process.env.CLAUDECLAW_MEMORY_READ_PROJECT_KEY = 'fixture-project-1';
      const host = startMemoryStateHost({
        memoryIpcDir,
        capabilityId,
        capabilitySecret,
        groupFolder: 'telegram_main',
        respond: (payload) =>
          payload.action === 'search' && payload.query === 'отказ'
            ? { ok: false, error: 'scheduled_memory_project_mismatch' }
            : { ok: true, data: { results: [], terms: 1, scanned: 0 } },
      });
      try {
        await import('./ipc-mcp-stdio.js');
        const search = async (query: string) =>
          (
            (await registeredTools.get('memory_search')!({
              query,
              max_results: 5,
            })) as { content: { text: string }[] }
          ).content[0].text;
        expect(await search('заказы')).toContain(
          '[база] No matching current records',
        );
        expect(host.requests[0]).toEqual({
          action: 'search',
          query: 'заказы',
          limit: 8,
          projectKey: 'fixture-project-1',
        });
        const direct = (await registeredTools.get('memory_state_read')!({
          action: 'search',
          query: 'заказы',
        })) as { content: { text: string }[]; isError?: boolean };
        expect(direct.isError).toBeUndefined();
        expect(host.requests.at(-1)).toEqual({
          action: 'search',
          query: 'заказы',
          projectKey: 'fixture-project-1',
        });
        const missing = (await registeredTools.get('memory_state_read')!({
          action: 'search',
        })) as { content: { text: string }[]; isError?: boolean };
        expect(missing.isError).toBe(true);
        expect(missing.content[0].text).toContain('search requires query');
        expect(await search('отказ')).toContain(
          '[база] Structured memory (memory_state) was not searched: scheduled_memory_project_mismatch',
        );
        // A revoked scope is not asked again in this run.
        const requestsBefore = host.requests.length;
        expect(await search('заказы')).toContain(
          '[база] Structured memory (memory_state) was not searched: Structured memory scope is no longer valid',
        );
        expect(host.requests).toHaveLength(requestsBefore);
      } finally {
        host.stop();
      }
    } finally {
      delete process.env.CLAUDECLAW_MEMORY_READ_CAPABILITY;
      delete process.env.CLAUDECLAW_MEMORY_READ_PROJECT_KEY;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Review of r1108/memory: a scheduled run must not lose its own project
  // because of a search the host cannot or may not answer.
  it('keeps scheduled reads open after a search an old host does not know, a foreign projectKey or a blank query', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-state-old-host-'));
    try {
      const groupDir = path.join(root, 'group');
      const ipcDir = path.join(root, 'ipc');
      const memoryIpcDir = path.join(ipcDir, 'memory');
      fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
      fs.mkdirSync(memoryIpcDir, { recursive: true });
      fs.writeFileSync(path.join(groupDir, 'memory', 'note.md'), 'Заметка.');
      process.env.CLAUDECLAW_GROUP_DIR = groupDir;
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      process.env.CLAUDECLAW_CHAT_JID = 'tg:123';
      process.env.CLAUDECLAW_GROUP_FOLDER = 'telegram_main';
      process.env.CLAUDECLAW_IS_MAIN = '1';
      const capabilityId = 'o'.repeat(43);
      const capabilitySecret = Buffer.alloc(32, 0x3c).toString('base64url');
      process.env.CLAUDECLAW_MEMORY_READ_CAPABILITY = `${capabilityId}.${capabilitySecret}`;
      process.env.CLAUDECLAW_MEMORY_READ_PROJECT_KEY = 'fixture-project-1';
      // The r1108/w01 host: list and get_project only, search is refused.
      const host = startMemoryStateHost({
        memoryIpcDir,
        capabilityId,
        capabilitySecret,
        groupFolder: 'telegram_main',
        respond: (payload) =>
          payload.action === 'search'
            ? { ok: false, error: 'scheduled_memory_read_only' }
            : { ok: true, data: { project: { projectKey: 'fixture-project-1' } } },
      });
      try {
        await import('./ipc-mcp-stdio.js');
        const getProject = async () =>
          (await registeredTools.get('memory_state_read')!({
            action: 'get_project',
            projectKey: 'fixture-project-1',
          })) as { content: { text: string }[]; isError?: boolean };

        const text = (
          (await registeredTools.get('memory_search')!({
            query: 'заказы',
            max_results: 5,
          })) as { content: { text: string }[] }
        ).content[0].text;
        expect(text).toContain(
          '[база] Structured memory (memory_state) was not searched: scheduled_memory_read_only',
        );
        const afterOldHost = await getProject();
        expect(afterOldHost.isError).toBeUndefined();
        expect(host.requests.at(-1)).toMatchObject({ action: 'get_project' });

        const requestsBefore = host.requests.length;
        for (const projectKey of [null, 'another-project']) {
          const foreign = (await registeredTools.get('memory_state_read')!({
            action: 'search',
            query: 'правила',
            projectKey,
          })) as { content: { text: string }[]; isError?: boolean };
          expect(foreign.isError).toBe(true);
          expect(foreign.content[0].text).toContain(
            'search covers only its bound project fixture-project-1',
          );
        }
        const blank = (await registeredTools.get('memory_state_read')!({
          action: 'search',
          query: '   ',
        })) as { content: { text: string }[]; isError?: boolean };
        expect(blank.isError).toBe(true);
        expect(blank.content[0].text).toContain('search requires query');
        expect(host.requests).toHaveLength(requestsBefore);

        const afterRefusals = await getProject();
        expect(afterRefusals.isError).toBeUndefined();
        expect(afterRefusals.content[0].text).not.toContain(
          'no longer valid',
        );
        expect(host.requests).toHaveLength(requestsBefore + 1);
      } finally {
        host.stop();
      }
    } finally {
      delete process.env.CLAUDECLAW_MEMORY_READ_CAPABILITY;
      delete process.env.CLAUDECLAW_MEMORY_READ_PROJECT_KEY;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Week review (W37): 28 % of memory_search hits came from output/,
  // and its 11 500 entries ended the walk before later folders were seen.
  // Creates over 10 000 files: allow for a loaded machine.
  it('keeps output/ and files/ out of the default search, even with 12 000 entries in output/', { timeout: 30_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-work-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      const bulk = path.join(root, 'output', 'aaa-bulk');
      fs.mkdirSync(bulk, { recursive: true });
      for (let i = 0; i < 12_000; i++) {
        fs.writeFileSync(path.join(bulk, `${i}.txt`), '');
      }
      fs.writeFileSync(
        path.join(root, 'output', 'report.md'),
        'qreportonlyq отчёт по складу',
      );
      fs.mkdirSync(path.join(root, 'files'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'files', 'doc.md'),
        'qfilesonlyq доверенность',
      );
      fs.mkdirSync(path.join(root, 'memory', 'topics'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'memory', 'topics', 'late.md'),
        'Ключ от склада у сторожа.',
      );
      fs.mkdirSync(path.join(root, 'handoffs'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'handoffs', 'shift.md'),
        'Передача смены: сторож Иван.',
      );
      // Sorts after output/: the old walk never reached it.
      fs.mkdirSync(path.join(root, 'zz-notes'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'zz-notes', 'plan.md'),
        'qzznotesq план склада',
      );

      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_search')!;
      const search = async (query: string, include_work_files?: boolean) =>
        (
          (await handler({ query, max_results: 10, include_work_files })) as {
            content: { text: string }[];
          }
        ).content[0].text;

      const memory = await search('сторож');
      expect(memory).toContain('memory/topics/late.md');
      expect(memory).toContain('handoffs/shift.md');
      expect(await search('qzznotesq')).toContain('zz-notes/plan.md');
      const noReport = await search('qreportonlyq');
      expect(noReport).toMatch(/^No matches found/);
      expect(noReport).toContain('include_work_files=true');
      expect(await search('qfilesonlyq')).toMatch(/^No matches found/);
      expect(
        fs.existsSync(
          path.join(root, '.skoobi', 'memory-search-work-v1.sqlite'),
        ),
      ).toBe(false);

      expect(await search('qreportonlyq', true)).toContain(
        'output/report.md',
      );
      expect(await search('qfilesonlyq', true)).toContain(
        'files/doc.md',
      );
      // Its own index file: the default index keeps only memory and notes.
      expect(
        fs.existsSync(
          path.join(root, '.skoobi', 'memory-search-work-v1.sqlite'),
        ),
      ).toBe(true);
      const index = new Database(
        path.join(root, '.skoobi', 'memory-search-v2.sqlite'),
        { readonly: true },
      );
      try {
        const labels = (
          index.prepare('SELECT label FROM memory_search_docs').all() as {
            label: string;
          }[]
        ).map((row) => row.label);
        expect(labels).not.toContain('output/report.md');
        expect(labels).not.toContain('files/doc.md');
      } finally {
        index.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Creates over 10 000 files: allow for a loaded machine.
  it('with include_work_files reaches the freshest job before an old bulky one', { timeout: 30_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-jobs-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      const old = path.join(root, 'output', 'aaa-old-assets');
      fs.mkdirSync(old, { recursive: true });
      for (let i = 0; i < 10_050; i++) {
        fs.writeFileSync(path.join(old, `${i}.png`), '');
      }
      const longAgo = new Date('2026-01-01T00:00:00Z');
      fs.utimesSync(old, longAgo, longAgo);
      const fresh = path.join(root, 'output', 'zzz-fresh-job');
      fs.mkdirSync(fresh, { recursive: true });
      fs.writeFileSync(
        path.join(fresh, 'summary.md'),
        'qfreshjobq итог задания',
      );

      await import('./ipc-mcp-stdio.js');
      const result = (await registeredTools.get('memory_search')!({
        query: 'qfreshjobq',
        max_results: 5,
        include_work_files: true,
      })) as { content: { text: string }[] };
      expect(result.content[0].text).toContain('output/zzz-fresh-job/summary.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never indexes downloaded sources/ trees or third-party README files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-vendor-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      const job = path.join(root, 'output', 'cc0-game-materials-2026-11-01');
      const write = (rel: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
      };
      write(
        path.relative(root, path.join(job, 'README.md')),
        'qjobreadmeq что скачано и зачем',
      );
      write(
        path.relative(root, path.join(job, 'sources', 'kenney', 'README.md')),
        'qvendorreadmeq Leia-me primeiro',
      );
      write(
        path.relative(root, path.join(job, 'assets', 'docs', 'README.md')),
        'qnestedreadmeq Lees mij',
      );
      write(
        path.relative(root, path.join(job, 'assets', 'docs', 'guide.md')),
        'qnestedguideq наш разбор ассетов',
      );
      write(
        path.relative(root, path.join(job, 'node_modules', 'x', 'notes.md')),
        'qnodemodulesq',
      );
      write('output/public-source-abc/notes.md', 'qpublicsourceq');
      write('work/vendor/lib/notes.md', 'qnotesvendorq');
      write('work/repo/docs/CHANGELOG.md', 'qnoteschangelogq');
      write('work/plan.md', 'qworkplanq');

      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_search')!;
      const search = async (query: string, include_work_files?: boolean) =>
        (
          (await handler({ query, max_results: 10, include_work_files })) as {
            content: { text: string }[];
          }
        ).content[0].text;

      expect(await search('qjobreadmeq', true)).toContain(
        'output/cc0-game-materials-2026-11-01/README.md',
      );
      expect(await search('qnestedguideq', true)).toContain(
        'output/cc0-game-materials-2026-11-01/assets/docs/guide.md',
      );
      for (const marker of [
        'qvendorreadmeq',
        'qnestedreadmeq',
        'qnodemodulesq',
        'qpublicsourceq',
      ]) {
        expect(await search(marker, true)).toMatch(/^No matches found/);
      }
      expect(await search('qworkplanq')).toContain('work/plan.md');
      expect(await search('qnotesvendorq')).toMatch(/^No matches found/);
      expect(await search('qnoteschangelogq')).toMatch(
        /^No matches found/,
      );
      const index = new Database(
        path.join(root, '.skoobi', 'memory-search-work-v1.sqlite'),
        { readonly: true },
      );
      try {
        const labels = (
          index.prepare('SELECT label FROM memory_search_docs').all() as {
            label: string;
          }[]
        ).map((row) => row.label);
        expect(labels.some((label) => /sources\/|node_modules\//.test(label))).toBe(false);
        expect(labels).not.toContain(
          'output/cc0-game-materials-2026-11-01/assets/docs/README.md',
        );
      } finally {
        index.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Creates over 10 000 files: allow for a loaded machine (CQ-02, r1111).
  it('walks memory/ first even when other folders exhaust the scan budget', { timeout: 30_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-scan-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      // Sorts before memory/ and has more entries than the walk may scan.
      const media = path.join(root, 'attachments');
      fs.mkdirSync(media, { recursive: true });
      for (let i = 0; i < 10_050; i++) {
        fs.writeFileSync(path.join(media, `${i}.jpg`), '');
      }
      fs.mkdirSync(path.join(root, 'memory', 'topics'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'memory', 'topics', 'late.md'),
        'Ключ от склада у сторожа.',
      );

      await import('./ipc-mcp-stdio.js');
      const result = (await registeredTools.get('memory_search')!({
        query: 'склад сторож',
        max_results: 5,
      })) as { content: { text: string }[] };
      expect(result.content[0].text).toContain('memory/topics/late.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries by word stems, folds ё into е and finds parts of words and numbers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-stem-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      fs.mkdirSync(path.join(root, 'memory', 'topics'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'memory', 'topics', 'warehouse-shifts.md'),
        '# Смены склада\n\nВыдали тележку на день, обзвоном занималась Тестовый оператор.\nКладовщик Пётр, телефон +15550000006.\n',
      );

      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_search')!;
      const search = async (query: string) =>
        (
          (await handler({ query, max_results: 5 })) as {
            content: { text: string }[];
          }
        ).content[0].text;

      const stems = await search('тележки');
      expect(stems).toContain('by word stems');
      expect(stems).toContain('memory/topics/warehouse-shifts.md');
      expect(stems).toContain('>>>тележк<<<');

      const partOfWord = await search('обзвон');
      expect(partOfWord).toMatch(/^Found 1 matches via SQLite FTS5\/BM25:/);
      expect(partOfWord).toContain('>>>обзвон<<<ом');

      const yo = await search('Петр Кладовщик');
      expect(yo).toMatch(/^Found 1 matches via SQLite FTS5\/BM25:/);
      // The excerpt shows the original spelling.
      expect(yo).toContain('>>>Пётр<<<');

      expect(await search('5550000006')).toContain(
        'memory/topics/warehouse-shifts.md',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps all-words precision and falls back to any word only on a miss', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-any-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      const topics = path.join(root, 'memory', 'topics');
      fs.mkdirSync(topics, { recursive: true });
      fs.writeFileSync(
        path.join(topics, 'bim.md'),
        'Проект Bim: бот Бим для детей.',
      );
      fs.writeFileSync(
        path.join(topics, 'alpha.md'),
        'Проект Альфа: бот для садоводов.',
      );

      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_search')!;
      const search = async (query: string) =>
        (
          (await handler({ query, max_results: 5 })) as {
            content: { text: string }[];
          }
        ).content[0].text;

      const exact = await search('Проект Bim');
      expect(exact).toMatch(/^Found 1 matches via SQLite FTS5\/BM25:/);
      expect(exact).toContain('memory/topics/bim.md');
      expect(exact).not.toContain('memory/topics/alpha.md');

      const both = await search('проект бот');
      expect(both).toMatch(/^Found 2 matches via SQLite FTS5\/BM25:/);

      const partial = await search('Bim Beam Бим');
      expect(partial).toMatch(
        /^No memory file contains every word of "Bim Beam Бим"\. 1 closest matches/,
      );
      expect(partial).toContain('memory/topics/bim.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds a topic by its file name and searches notes outside memory/', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-title-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      fs.mkdirSync(path.join(root, 'memory', 'topics'), { recursive: true });
      fs.mkdirSync(path.join(root, 'handoffs'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'memory', 'topics', 'hardware-setup.md'),
        'Два сервера и ноутбук, доступ по SSH.',
      );
      fs.writeFileSync(
        path.join(root, 'memory', '2026-10-20.md'),
        'Обсуждали hardware: setup стола, hardware для склада, hardware.',
      );
      fs.writeFileSync(
        path.join(root, 'handoffs', 'repair-handoff.md'),
        'Передача: ремонт тренажёра ждёт мастера.',
      );

      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_search')!;
      const search = async (query: string) =>
        (
          (await handler({ query, max_results: 5 })) as {
            content: { text: string }[];
          }
        ).content[0].text;

      const byName = await search('hardware-setup');
      expect(byName.split('\n')[2]).toMatch(
        /^memory\/topics\/hardware-setup\.md: /,
      );
      expect(await search('тренажер')).toContain('handoffs/repair-handoff.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers one- and two-letter terms through grep, as whole words', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-short-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      fs.mkdirSync(path.join(root, 'memory', 'topics'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'memory', 'topics', 'company.md'),
        'Какого типа договор?\nОткрыть ИП в городе.\n',
      );

      await import('./ipc-mcp-stdio.js');
      const result = (await registeredTools.get('memory_search')!({
        query: 'ИП',
        max_results: 5,
      })) as { content: { text: string }[] };
      const text = result.content[0].text;
      expect(text).toContain('via grep fallback');
      expect(text).toContain('memory/topics/company.md:2: Открыть ИП в городе.');
      expect(text).not.toContain('company.md:1:');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // The trigram index cannot see «2» or «ИП»; an all-words answer must still
  // hold them, as the old whole-word index did.
  it('requires one- and two-letter words in an all-words answer', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-memory-short-all-'),
    );
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      const topics = path.join(root, 'memory', 'topics');
      fs.mkdirSync(topics, { recursive: true });
      fs.writeFileSync(
        path.join(topics, 'node-b.md'),
        'Lab host 2: Tailscale настроен.',
      );
      // Long, older and with one hit per word: it ranks below the short notes
      // about the other machine, so a filter over the top rows alone misses it.
      fs.writeFileSync(
        path.join(topics, 'node-c.md'),
        [
          '# Третья машина',
          ...Array.from(
            { length: 40 },
            () => '- Проверить диск, обновления и питание.',
          ),
          'Lab host 3: Tailscale ещё не настроен, ждёт ключа.',
        ].join('\n'),
      );
      const older = new Date(Date.now() - 86_400_000);
      fs.utimesSync(path.join(topics, 'node-c.md'), older, older);
      for (const name of ['ab', 'cd', 'ef', 'gh', 'ij', 'kl']) {
        fs.writeFileSync(
          path.join(topics, `log-${name}.md`),
          'Tailscale Tailscale: Lab host 2, host 2, Lab 2.',
        );
      }
      fs.writeFileSync(
        path.join(topics, 'lab-host-1.md'),
        'Tailscale стоит, ключ у владельца.',
      );
      fs.writeFileSync(
        path.join(topics, 'firm-a.md'),
        'ИП Тестов: отчёт сдан.',
      );
      fs.writeFileSync(
        path.join(topics, 'driver.md'),
        'Тестов Пётр — водитель, смена с утра.',
      );

      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_search')!;
      const search = async (query: string, maxResults = 3) =>
        (
          (await handler({ query, max_results: maxResults })) as {
            content: { text: string }[];
          }
        ).content[0].text;

      const third = await search('Tailscale Lab host 3');
      expect(third).toMatch(/^Found 1 matches via SQLite FTS5\/BM25:/);
      expect(third).toContain('memory/topics/node-c.md');
      expect(third).toContain('>>>Lab<<< >>>host<<< >>>3<<<');
      expect(third).not.toContain('node-b.md');
      expect(third).not.toContain('log-');

      const second = await search('Tailscale Lab host 2', 20);
      expect(second).toMatch(/^Found 7 matches via SQLite FTS5\/BM25:/);
      expect(second).toContain('memory/topics/node-b.md');
      expect(second).not.toContain('node-c.md');

      const firm = await search('ИП Тестов');
      expect(firm).toMatch(/^Found 1 matches via SQLite FTS5\/BM25:/);
      expect(firm).toContain('memory/topics/firm-a.md');
      expect(firm).not.toContain('driver.md');

      // A whole word in the file name counts, as the name is searched too.
      const byName = await search('Tailscale host 1');
      expect(byName).toMatch(/^Found 1 matches via SQLite FTS5\/BM25:/);
      expect(byName).toContain('memory/topics/lab-host-1.md');

      // No file has «4»: the all-words steps give way to the any-word step.
      const missing = await search('Tailscale Lab host 4');
      expect(missing).toMatch(
        /^No memory file contains every word of "Tailscale Lab host 4"\./,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reindexes a changed file and drops a deleted one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-sync-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      const topics = path.join(root, 'memory', 'topics');
      fs.mkdirSync(topics, { recursive: true });
      fs.writeFileSync(path.join(topics, 'keep.md'), 'Постоянная заметка.');
      const changing = path.join(topics, 'changing.md');
      fs.writeFileSync(changing, 'Пароль от роутера у Вани.');

      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_search')!;
      const search = async (query: string) =>
        (
          (await handler({ query, max_results: 5 })) as {
            content: { text: string }[];
          }
        ).content[0].text;

      expect(await search('роутер')).toContain('memory/topics/changing.md');
      fs.writeFileSync(changing, 'Ключи от гаража у соседа, второй комплект.');
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(changing, later, later);
      expect(await search('роутер')).toMatch(/^No matches found/);
      expect(await search('гараж')).toContain('memory/topics/changing.md');
      fs.rmSync(changing);
      expect(await search('гараж')).toMatch(/^No matches found/);
      expect(await search('заметка')).toContain('memory/topics/keep.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not follow a symlinked memory/ folder out of the chat', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-link-'));
    try {
      const group = path.join(root, 'group');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(group, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'secret.md'), 'OUTSIDE_LINK_MARKER');
      fs.writeFileSync(path.join(group, 'CLAUDE.md'), 'Правила чата.');
      fs.symlinkSync(outside, path.join(group, 'memory'));
      process.env.CLAUDECLAW_GROUP_DIR = group;
      process.env.CLAUDECLAW_IS_MAIN = '1';

      await import('./ipc-mcp-stdio.js');
      const result = (await registeredTools.get('memory_search')!({
        query: 'OUTSIDE_LINK_MARKER',
        max_results: 5,
      })) as { content: { text: string }[] };
      expect(result.content[0].text).toMatch(/^No matches found/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds terms, stems and the cascade plan from a query', async () => {
    const mod = await import('./ipc-mcp-stdio.js');
    expect(mod.memorySearchStem('тележки')).toBe('тележк');
    expect(mod.memorySearchStem('гостиница')).toBe('гостиниц');
    expect(mod.memorySearchStem('армией')).toBe('арми');
    expect(mod.memorySearchStem('робот')).toBe('робот');
    expect(mod.memorySearchStem('clients')).toBe('client');
    expect(mod.memorySearchStem('access')).toBe('access');
    expect(
      mod.memorySearchTerms(
        '"Red Barn" резерв OR Пётр* (trip-2099-example) резерв',
      ),
    ).toEqual(['red barn', 'резерв', 'петр', 'trip-2099-example']);
    expect(mod.memorySearchPlan('Lab host 2')).toEqual([
      {
        step: 'exact',
        match: '"lab" "host"',
        terms: ['lab', 'host'],
        wholeWords: ['2'],
      },
      {
        step: 'any',
        match: '"lab" OR "host"',
        terms: ['lab', 'host'],
        wholeWords: [],
      },
    ]);
    expect(
      mod.memorySearchPlan('ИП Тестову').map((s) => [s.step, s.wholeWords]),
    ).toEqual([
      ['exact', ['ип']],
      ['stems', ['ип']],
    ]);
    expect(mod.memorySearchPlan('копии снимки').map((s) => s.match)).toEqual([
      '"копии" "снимки"',
      '"копи" "снимк"',
      '"копи" OR "снимк"',
    ]);
    // The any-word step also tries the parts of compound terms and phrases.
    expect(
      mod.memorySearchPlan('hardware-setup iMac').map((s) => s.match),
    ).toEqual([
      '"hardware-setup" "imac"',
      '"hardware-setup" OR "imac" OR "hardware" OR "setup"',
    ]);
    expect(mod.memorySearchPlan('"Red Barn"').map((s) => s.match)).toEqual([
      '"red barn"',
      '"red barn" OR "red" OR "barn"',
    ]);
    expect(mod.memorySearchPlan('ИП 2')).toEqual([]);
    expect(
      mod.stripMemorySignatures(
        '- [2026-10-01] факт <!-- skoobi_memory_v2=abc.def -->\n',
      ),
    ).toBe('- [2026-10-01] факт\n');
  });

  it('strips provenance markers line by line and in linear time', async () => {
    const mod = await import('./ipc-mcp-stdio.js');
    expect(
      mod.stripMemorySignatures(
        '- [s] hi  \t<!--  skoobi_memory_v2=aa.bb -->\n<!-- skoobi_memory_v2=cc.dd -->next\n',
      ),
    ).toBe('- [s] hi\nnext\n');
    // An unclosed marker stays; the entries after it are kept.
    expect(
      mod.stripMemorySignatures(
        '- [a] x <!-- skoobi_memory_v2=abc\n- [b] Пароль у соседа.\n- [d] y <!-- skoobi_memory_v2=def.ghi -->',
      ),
    ).toBe(
      '- [a] x <!-- skoobi_memory_v2=abc\n- [b] Пароль у соседа.\n- [d] y',
    );
    // The old pattern needed seconds to minutes on such lines (quadratic).
    const spaces = `a${' '.repeat(200_000)}b`;
    const unclosed = 'x <!-- skoobi_memory_v2=abc '.repeat(20_000);
    const started = performance.now();
    expect(mod.stripMemorySignatures(spaces)).toBe(spaces);
    expect(mod.stripMemorySignatures(unclosed)).toBe(unclosed);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('keeps entries after an unclosed marker searchable at their line', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-memory-unclosed-'),
    );
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      const topics = path.join(root, 'memory', 'topics');
      fs.mkdirSync(topics, { recursive: true });
      fs.writeFileSync(
        path.join(topics, 'notes.md'),
        [
          '# Заметки',
          '- [a] Склад закрыт <!-- skoobi_memory_v2=abc',
          '- [b] Пароль от роутера у соседа.',
          '- [c] Ключи у сторожа <!-- skoobi_memory_v2=def.ghi -->',
        ].join('\n'),
      );

      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_search')!;
      const search = async (query: string) =>
        (
          (await handler({ query, max_results: 5 })) as {
            content: { text: string }[];
          }
        ).content[0].text;

      const indexed = await search('роутера соседа');
      expect(indexed).toMatch(/^Found 1 matches via SQLite FTS5\/BM25:/);
      expect(indexed).toContain('>>>роутера<<<');

      // Grep (here forced by a broken index path) reports the file's own line.
      fs.rmSync(path.join(root, '.skoobi'), { recursive: true, force: true });
      fs.writeFileSync(path.join(root, '.skoobi'), 'not a directory');
      const grepped = await search('роутера');
      expect(grepped).toContain('grep fallback');
      expect(grepped).toContain(
        'memory/topics/notes.md:3: - [b] Пароль от роутера у соседа.',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('owner send exact-authorization boundary', () => {
  it('uses PoP without serializing the secret and queues only the returned exact grant', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-send-auth-'));
    const ipcDir = path.join(root, 'ipc');
    const memoryDir = path.join(ipcDir, 'memory');
    const messagesDir = path.join(ipcDir, 'messages');
    const reportPath = path.join(root, 'owner-report.pdf');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(reportPath, 'OWNER_REPORT');
    const capabilityId = 't'.repeat(22);
    const capabilitySecret = Buffer.alloc(32, 0x6b).toString('base64url');
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IPC_DIR = ipcDir;
    process.env.CLAUDECLAW_CHAT_JID = 'tg:100000001';
    process.env.CLAUDECLAW_GROUP_FOLDER = 'telegram_main';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY = `${capabilityId}.${capabilitySecret}`;

    try {
      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('send_document');
      expect(handler).toBeTypeOf('function');

      let observedRequest: Record<string, unknown> | undefined;
      const exactGrant = 'g'.repeat(43);
      const responder = new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const poll = () => {
          try {
            const requestFile = fs
              .readdirSync(memoryDir)
              .find((name) => name.endsWith('.request.json'));
            if (!requestFile) {
              if (Date.now() >= deadline) {
                reject(new Error('task authorization request not observed'));
                return;
              }
              setTimeout(poll, 10);
              return;
            }
            observedRequest = JSON.parse(
              fs.readFileSync(path.join(memoryDir, requestFile), 'utf8'),
            ) as Record<string, unknown>;
            const requestId = String(observedRequest.request_id);
            const proofPayload = {
              type: observedRequest.type,
              request_id: observedRequest.request_id,
              action: observedRequest.action,
              sealed_envelope: observedRequest.sealed_envelope,
            };
            expect(observedRequest).toMatchObject({
              type: 'task_authorize',
              action: 'document',
              capability_id: capabilityId,
            });
            expect(observedRequest).not.toHaveProperty('capability');
            expect(observedRequest).not.toHaveProperty('envelope');
            expect(observedRequest.sealed_envelope).toMatchObject({
              v: 1,
              alg: 'A256GCM',
            });
            expect(JSON.stringify(observedRequest)).not.toContain(
              fs.realpathSync(reportPath),
            );
            expect(JSON.stringify(observedRequest)).not.toContain(
              'owner report',
            );
            expect(JSON.stringify(observedRequest)).not.toContain(
              capabilitySecret,
            );
            expect(observedRequest.proof).toBe(
              createHmac('sha256', capabilitySecret)
                .update(JSON.stringify(proofPayload))
                .digest('base64url'),
            );
            expect(
              openTaskAuthorizationEnvelopeForTest(
                observedRequest,
                capabilitySecret,
              ),
            ).toMatchObject({
              type: 'document',
              chatJid: 'tg:100000001',
              filePath: fs.realpathSync(reportPath),
              caption: 'owner report',
            });
            fs.writeFileSync(
              path.join(memoryDir, `${requestId}.result.json`),
              JSON.stringify({
                type: 'task_authorize_result',
                request_id: requestId,
                ok: true,
                grant: exactGrant,
              }),
            );
            const sendEnvelope=openTaskAuthorizationEnvelopeForTest(observedRequest,capabilitySecret) as Record<string,unknown>;
            fs.writeFileSync(path.join(memoryDir,`${sendEnvelope.deliveryRequestId}.delivery.json`),JSON.stringify({deliveryId:sendEnvelope.deliveryId,state:'delivered',code:'api_acknowledged'}));
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        poll();
      });

      const result = (await handler!({
        filePath: fs.realpathSync(reportPath),
        caption: 'owner report',
      })) as { isError?: boolean; content: { text: string }[] };
      await responder;

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toMatchObject({state:'delivered',code:'api_acknowledged'});
      const queuedFiles = fs
        .readdirSync(messagesDir)
        .filter((name) => name.endsWith('.json'));
      expect(queuedFiles).toHaveLength(1);
      const queued = JSON.parse(
        fs.readFileSync(path.join(messagesDir, queuedFiles[0]), 'utf8'),
      ) as Record<string, unknown>;
      expect(queued).toMatchObject({
        type: 'document',
        chatJid: 'tg:100000001',
        filePath: fs.realpathSync(reportPath),
        caption: 'owner report',
        ownerAuthorizationGrant: exactGrant,
      });
      expect(JSON.stringify(queued)).not.toContain(capabilitySecret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bounded same-fd IPC response reads', () => {
  it('reads exact regular files at the task and memory limits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-ipc-response-'));
    try {
      const { readBoundedIpcResponseFile } = await import('./ipc-mcp-stdio.js');
      const taskResponse = path.join(root, 'task.result.json');
      const taskData = Buffer.from('{"ok":true}');
      fs.writeFileSync(taskResponse, taskData);
      expect(readBoundedIpcResponseFile(taskResponse, 64 * 1024)).toEqual(
        taskData,
      );

      const memoryResponse = path.join(root, 'memory.result.json');
      fs.writeFileSync(memoryResponse, Buffer.alloc(2 * 1024 * 1024, 0x61));
      expect(
        readBoundedIpcResponseFile(memoryResponse, 2 * 1024 * 1024),
      ).toHaveLength(2 * 1024 * 1024);
      fs.appendFileSync(memoryResponse, 'x');
      expect(() =>
        readBoundedIpcResponseFile(memoryResponse, 2 * 1024 * 1024),
      ).toThrow(/oversized/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinks, hardlinks, and FIFOs without blocking', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-ipc-unsafe-'));
    try {
      const { readBoundedIpcResponseFile } = await import('./ipc-mcp-stdio.js');
      const target = path.join(root, 'target.json');
      fs.writeFileSync(target, '{"ok":true}');

      const symlink = path.join(root, 'symlink.result.json');
      fs.symlinkSync(target, symlink);
      expect(() => readBoundedIpcResponseFile(symlink, 64 * 1024)).toThrow(
        /safe regular file/i,
      );

      const hardlink = path.join(root, 'hardlink.result.json');
      fs.linkSync(target, hardlink);
      expect(() => readBoundedIpcResponseFile(hardlink, 64 * 1024)).toThrow(
        /unsafe/i,
      );

      const fifo = path.join(root, 'fifo.result.json');
      execFileSync('mkfifo', [fifo]);
      const started = Date.now();
      expect(() => readBoundedIpcResponseFile(fifo, 64 * 1024)).toThrow(
        /unsafe/i,
      );
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('send_voice_message input-size cap (finding #14)', () => {
  it('rejects oversized text before writing an IPC voice envelope', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-voice-cap-'));
    try {
      process.env.CLAUDECLAW_IS_MAIN = '0';
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('send_voice_message');
      expect(handler).toBeTypeOf('function');

      // 12001 chars is one over the cap → fan-out abuse, must be rejected.
      const result = (await handler!({ text: 'a'.repeat(12001) })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/voice_text_too_long/i);

      // No voice envelope should have been enqueued for the rejected call.
      const messagesDir = path.join(ipcDir, 'messages');
      const enqueued = fs.existsSync(messagesDir)
        ? fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'))
        : [];
      expect(enqueued).toHaveLength(0);
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });

  it('accepts text at the cap but reports pending generation without claiming delivery', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-voice-ok-'));
    try {
      process.env.CLAUDECLAW_IS_MAIN = '0';
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('send_voice_message');
      expect(handler).toBeTypeOf('function');

      const responder=new Promise<void>((resolve,reject)=>{
        const deadline=Date.now()+2000;const poll=()=>{try{
          const messagesDir=path.join(ipcDir,'messages');const file=fs.existsSync(messagesDir)?fs.readdirSync(messagesDir).find(f=>f.endsWith('.json')):undefined;
          if(!file){if(Date.now()>deadline)return reject(new Error('generation intent absent'));setTimeout(poll,10);return;}
          const intent=JSON.parse(fs.readFileSync(path.join(messagesDir,file),'utf8'));
          fs.writeFileSync(path.join(ipcDir,'memory',`${intent.voiceRequestId}.voice.json`),JSON.stringify({assetId:intent.voiceAssetId,state:'generating',code:'audio_generation_pending'}));resolve();
        }catch(error){reject(error);}};poll();
      });
      const result = (await handler!({ text: 'a'.repeat(12000) })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).toBeUndefined();
      await responder;
      expect(JSON.parse(result.content[0].text)).toMatchObject({state:'generating',code:'audio_generation_pending'});

      const messages = fs
        .readdirSync(path.join(ipcDir, 'messages'))
        .filter((f) => f.endsWith('.json'));
      expect(messages).toHaveLength(1);
      const envelope = JSON.parse(
        fs.readFileSync(path.join(ipcDir, 'messages', messages[0]), 'utf8'),
      );
      expect(envelope.type).toBe('voice');
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });
});

describe('send_photo/send_document sensitive-file blocklist (finding #35)', () => {
  it('denies a guest sending a credential file from its own workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-send-deny-'));
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-send-ipc-'));
    try {
      process.env.CLAUDECLAW_IS_MAIN = '0';
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      // A real credential-bearing file inside the guest's own workspace.
      fs.writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=sk-secret');

      await import('./ipc-mcp-stdio.js');
      const sendPhoto = registeredTools.get('send_photo');
      expect(sendPhoto).toBeTypeOf('function');

      const result = (await sendPhoto!({ filePath: '.env' })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/credential or key files/i);

      // Nothing should have been queued for delivery.
      const messagesDir = path.join(ipcDir, 'messages');
      const enqueued = fs.existsSync(messagesDir)
        ? fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'))
        : [];
      expect(enqueued).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });

  it('still allows a guest to send a normal image from its workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-send-ok-'));
    const ipcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-send-ok-ipc-'),
    );
    try {
      process.env.CLAUDECLAW_IS_MAIN = '0';
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      fs.mkdirSync(path.join(root, 'output'), { recursive: true });
      fs.writeFileSync(path.join(root, 'output', 'chart.png'), 'PNGDATA');

      await import('./ipc-mcp-stdio.js');
      const sendPhoto = registeredTools.get('send_photo');
      expect(sendPhoto).toBeTypeOf('function');

      const result = (await sendPhoto!({
        filePath: 'output/chart.png',
      })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toMatch(/queued for delivery/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });
});

describe('skill_* tools', () => {
  it("does not let model-written frontmatter substitute for protected host evidence", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "skoobi-skill-evidence-"),
    );
    try {
      process.env.CLAUDECLAW_SKILLS_DIR = root;
      fs.mkdirSync(path.join(root, "candidate"));
      fs.writeFileSync(
        path.join(root, "candidate", "SKILL.md"),
        "---\nname: candidate\nstatus: active\ncreated_by: agent_proposal\nverified: true\n---\nUnverified candidate body.",
      );
      await import("./ipc-mcp-stdio.js");
      const listed = (await registeredTools.get("skill_list")!({})) as {
        content: { text: string }[];
      };
      expect(listed.content[0].text).toContain("host_check_required");
      const viewed = (await registeredTools.get("skill_view")!({
        name: "candidate",
      })) as { isError?: boolean; content: { text: string }[] };
      expect(viewed.isError).toBe(true);
      expect(viewed.content[0].text).not.toContain("Unverified candidate body");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('lists and views active skills without loading drafts by default', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-runner-skills-'),
    );
    try {
      process.env.CLAUDECLAW_SKILLS_DIR = root;
      fs.mkdirSync(path.join(root, 'web-search-workflow'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(root, 'web-search-workflow', 'SKILL.md'),
        [
          '---',
          'name: web-search-workflow',
          'description: Search workflow.',
          'status: active',
          'created_by: operator',
          'triggers: ["найди"]',
          '---',
          '',
          'Use SearchGateway.',
        ].join('\n'),
      );
      fs.mkdirSync(path.join(root, 'draft-skill'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'draft-skill', 'SKILL.md'),
        [
          '---',
          'name: draft-skill',
          'description: Draft.',
          'status: draft',
          'created_by: agent_proposal',
          '---',
          '',
          'Draft body.',
        ].join('\n'),
      );

      await import('./ipc-mcp-stdio.js');
      const list = registeredTools.get('skill_list');
      const view = registeredTools.get('skill_view');
      expect(list).toBeTypeOf('function');
      expect(view).toBeTypeOf('function');

      const listResult = (await list!({})) as { content: { text: string }[] };
      expect(listResult.content[0].text).toContain('web-search-workflow');
      expect(listResult.content[0].text).not.toContain('draft-skill');

      const viewResult = (await view!({
        name: 'web-search-workflow',
      })) as { content: { text: string }[] };
      expect(viewResult.content[0].text).toContain('Use SearchGateway.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unsafe skill names and secret-looking proposals', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-runner-skill-deny-'),
    );
    try {
      process.env.CLAUDECLAW_SKILLS_DIR = root;
      await import('./ipc-mcp-stdio.js');
      const view = registeredTools.get('skill_view');
      const propose = registeredTools.get('skill_propose');
      expect(view).toBeTypeOf('function');
      expect(propose).toBeTypeOf('function');

      const unsafe = (await view!({ name: '../escape' })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(unsafe.isError).toBe(true);

      const secret = (await propose!({
        name: 'bad-skill',
        description: 'bad',
        body: 'OPENAI_API_KEY=sk-test-secret',
      })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(secret.isError).toBe(true);
      expect(secret.content[0].text).toMatch(/credential|secret/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes skill proposals to the host over IPC (never writes the active skills dir)', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-runner-skill-propose-'),
    );
    const ipcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-runner-skill-ipc-'),
    );
    try {
      // Skills dir is mounted READ-ONLY for guests; the proposal must NOT be
      // written to it directly — it is enqueued as an IPC 'propose_skill' task
      // for the host to validate and write into `.proposals`.
      process.env.CLAUDECLAW_SKILLS_DIR = root;
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      await import('./ipc-mcp-stdio.js');
      const propose = registeredTools.get('skill_propose');
      const list = registeredTools.get('skill_list');
      expect(propose).toBeTypeOf('function');
      expect(list).toBeTypeOf('function');

      const proposed = (await propose!({
        name: 'repeatable-check',
        description: 'A repeatable check.',
        body: '# Repeatable Check\n\n1. Inspect.\n2. Verify.',
        tags: ['ops'],
        triggers: ['проверка'],
      })) as { content: { text: string }[] };
      expect(proposed.content[0].text).toMatch(
        /submitted for operator review/i,
      );
      expect(proposed.content[0].text).toMatch(/verify-register.*verify.*verification.*approve/i);
      expect(proposed.content[0].text).toContain('receipt confirms queuing only');

      // No direct write into the (read-only) skills dir.
      expect(
        fs.existsSync(
          path.join(root, '.proposals', 'repeatable-check', 'SKILL.md'),
        ),
      ).toBe(false);

      // Exactly one IPC task envelope of type 'propose_skill' was enqueued.
      const taskFiles = fs
        .readdirSync(path.join(ipcDir, 'tasks'))
        .filter((f) => f.endsWith('.json'));
      expect(taskFiles).toHaveLength(1);
      const envelope = JSON.parse(
        fs.readFileSync(path.join(ipcDir, 'tasks', taskFiles[0]), 'utf8'),
      );
      expect(envelope.type).toBe('propose_skill');
      expect(envelope.name).toBe('repeatable-check');
      expect(envelope.body).toContain('Repeatable Check');
      expect(envelope.tags).toEqual(['ops']);

      const activeList = (await list!({})) as { content: { text: string }[] };
      expect(activeList.content[0].text).not.toContain('repeatable-check');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Server-side tool lockout (CLAUDECLAW_DISALLOWED_TOOLS). The Claude SDK
// enforces disallowedTools client-side; alternate-provider runs (codex
// reserve) rely on the server not registering the tool at all.
// ---------------------------------------------------------------------------
describe('CLAUDECLAW_DISALLOWED_TOOLS server-side lockout', () => {
  it('parses bare, prefixed and wildcard entries', async () => {
    const { parseDisallowedTools } = await import('./ipc-mcp-stdio.js');
    const parsed = parseDisallowedTools(
      'mcp__claudeclaw__memory_save, memory_search,, *',
    );
    expect(parsed.has('memory_save')).toBe(true);
    expect(parsed.has('memory_search')).toBe(true);
    expect(parsed.has('*')).toBe(true);
    expect(parseDisallowedTools(undefined).size).toBe(0);
  });

  it('does not register disallowed tools (fresh import with env set)', async () => {
    const prev = process.env.CLAUDECLAW_DISALLOWED_TOOLS;
    try {
      vi.resetModules();
      registeredTools.clear();
      process.env.CLAUDECLAW_DISALLOWED_TOOLS =
        'mcp__claudeclaw__memory_save,memory_search';
      await import('./ipc-mcp-stdio.js');
      expect(registeredTools.has('memory_save')).toBe(false);
      expect(registeredTools.has('memory_search')).toBe(false);
      // Non-disallowed tools still register.
      expect(registeredTools.has('send_message')).toBe(true);
      expect(registeredTools.has('memory_get')).toBe(true);
    } finally {
      // Restore the full registration set for any later tests.
      if (prev !== undefined) process.env.CLAUDECLAW_DISALLOWED_TOOLS = prev;
      else delete process.env.CLAUDECLAW_DISALLOWED_TOOLS;
      vi.resetModules();
      registeredTools.clear();
      await import('./ipc-mcp-stdio.js');
    }
  });
});

describe('Google Workspace per-turn server-side allowlist', () => {
  it('parses only closed public tool names', async () => {
    const { parseAllowedGoogleTools, parseGoogleSheetTargetHints } =
      await import('./ipc-mcp-stdio.js');
    expect(
      [
        ...parseAllowedGoogleTools(
          'google_docs_read,mcp__claudeclaw__google_calendar_list_events,gmail_search_threads,google_sheets_append_values,google_drive_delete',
        ),
      ].sort(),
    ).toEqual([
      'gmail_search_threads',
      'google_calendar_list_events',
      'google_docs_read',
      'google_sheets_append_values',
    ]);
    expect(parseAllowedGoogleTools(undefined).size).toBe(0);

    const exactHint = {
      label: 'ledger',
      spreadsheetId: 'public-fixture-spreadsheet-id-0001',
      range: "'Ledger'!A2:G1000",
      columnCount: 7,
      maxRowsPerCall: 1,
    };
    expect(parseGoogleSheetTargetHints(JSON.stringify([exactHint]))).toEqual([
      exactHint,
    ]);
    expect(
      parseGoogleSheetTargetHints(
        JSON.stringify([{ ...exactHint, maxRowsPerCall: 2 }]),
      ),
    ).toEqual([]);
    expect(
      parseGoogleSheetTargetHints(
        JSON.stringify([{ ...exactHint, credential: 'must-not-pass' }]),
      ),
    ).toEqual([]);
  });

  it('registers exactly the host-published Google wrappers', async () => {
    const previousAllowed = process.env.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS;
    const previousDisallowed = process.env.CLAUDECLAW_DISALLOWED_TOOLS;
    try {
      vi.resetModules();
      registeredTools.clear();
      process.env.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS =
        'google_docs_read,gmail_search_threads';
      delete process.env.CLAUDECLAW_DISALLOWED_TOOLS;
      await import('./ipc-mcp-stdio.js');
      expect(registeredTools.has('google_docs_read')).toBe(true);
      expect(registeredTools.has('gmail_search_threads')).toBe(true);
      expect(registeredTools.has('gmail_get_thread')).toBe(false);
      expect(registeredTools.has('google_docs_replace_content')).toBe(false);
      expect(registeredTools.has('google_workspace_status')).toBe(false);
    } finally {
      if (previousAllowed === undefined) {
        delete process.env.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS;
      } else {
        process.env.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS = previousAllowed;
      }
      if (previousDisallowed === undefined) {
        delete process.env.CLAUDECLAW_DISALLOWED_TOOLS;
      } else {
        process.env.CLAUDECLAW_DISALLOWED_TOOLS = previousDisallowed;
      }
      vi.resetModules();
      registeredTools.clear();
      await import('./ipc-mcp-stdio.js');
    }
  });
});

describe('Google reads mark the link check of the run', () => {
  const token = randomUUID();
  let ipcDir: string;
  let marker: string;
  const hostOperation = vi.fn();

  beforeEach(() => {
    ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-foreign-read-'));
    marker = path.join(ipcDir, `.foreign-read-${token}`);
    hostOperation.mockReset();
    vi.doMock('./google-workspace.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./google-workspace.js')>()),
      requestHostGoogleOperation: hostOperation,
    }));
    process.env.CLAUDECLAW_IPC_DIR = ipcDir;
    process.env.CLAUDECLAW_FOREIGN_READ_MARKER = token;
    process.env.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS =
      'gmail_search_threads,gmail_get_thread,google_docs_read,google_workspace_status';
  });

  afterEach(async () => {
    vi.doUnmock('./google-workspace.js');
    delete process.env.CLAUDECLAW_FOREIGN_READ_MARKER;
    delete process.env.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS;
    fs.rmSync(ipcDir, { recursive: true, force: true });
    vi.resetModules();
    registeredTools.clear();
  });

  async function call(tool: string, args: Record<string, unknown>) {
    vi.resetModules();
    registeredTools.clear();
    await import('./ipc-mcp-stdio.js');
    const handler = registeredTools.get(tool);
    expect(handler, tool).toBeTypeOf('function');
    return (await handler!(args)) as { isError?: boolean };
  }

  it('marks mail and document reads, not status checks or failures', async () => {
    hostOperation.mockResolvedValue({ ok: true });
    await call('google_workspace_status', {});
    expect(fs.existsSync(marker)).toBe(false);

    hostOperation.mockRejectedValue(new Error('broker down'));
    await call('gmail_get_thread', { thread_id: 'abc' });
    expect(fs.existsSync(marker)).toBe(false);

    hostOperation.mockResolvedValue({ messages: [] });
    await call('gmail_search_threads', { query: 'from:x' });
    await call('gmail_get_thread', { thread_id: 'abc' });
    await call('google_docs_read', { document_id: 'doc' });
    expect(fs.readFileSync(marker, 'utf-8').split('\n')).toEqual([
      'gmail_search_threads',
      'gmail_get_thread',
      'google_docs_read',
      '',
    ]);
  });

  it('keeps the links of a read in the chat list of the group dir', async () => {
    const groupDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mcp-foreign-urls-'),
    );
    const previousGroupDir = process.env.CLAUDECLAW_GROUP_DIR;
    process.env.CLAUDECLAW_GROUP_DIR = groupDir;
    try {
      const LINK = 'https://app.x.io/emailverification/Q2x9abcDEF';
      const PLAIN = 'https://app.x.io/onboarding/step-2';
      hostOperation.mockResolvedValue({
        messages: [
          { bodyText: `Подтвердите почту:\n${LINK}\nНачните тут: ${PLAIN}` },
        ],
      });
      await call('gmail_get_thread', { thread_id: 'abc' });
      const file = foreignUrlsFilePath(groupDir);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const list = readForeignUrls(file);
      expect(list.has(LINK)).toBe(true);
      expect(list.has(PLAIN)).toBe(true);
      expect(list.has('https://app.x.io/other')).toBe(false);
      expect(fs.existsSync(path.join(ipcDir, FOREIGN_URLS_FILE))).toBe(false);

      // A status check hands out nothing foreign.
      fs.rmSync(file);
      hostOperation.mockResolvedValue({ note: PLAIN });
      await call('google_workspace_status', {});
      expect(fs.existsSync(file)).toBe(false);

      // Link check off for the run (no token): no list either.
      delete process.env.CLAUDECLAW_FOREIGN_READ_MARKER;
      hostOperation.mockResolvedValue({ messages: [{ bodyText: LINK }] });
      await call('gmail_get_thread', { thread_id: 'abc' });
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      if (previousGroupDir === undefined) {
        delete process.env.CLAUDECLAW_GROUP_DIR;
      } else {
        process.env.CLAUDECLAW_GROUP_DIR = previousGroupDir;
      }
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// chat_history: read-only history, registered only for a host-granted owner
// main run. The DB below uses the production DDL of the tables it reads.
// ---------------------------------------------------------------------------
describe('chat_history', () => {
  const OWNER_JID = 'tg:100';
  const LEGACY_JID = 'tg:300';
  const WA_PHONE = ['1', '555', '000', '0001'].join('');
  const WA_JID = `${WA_PHONE}@s.whatsapp.net`;
  let root: string;
  let dbPath: string;

  function seedChatHistoryDb(file: string) {
    const db = new Database(file);
    try {
      db.pragma('journal_mode = WAL');
      db.exec(`
        CREATE TABLE messages (
          id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT,
          timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0,
          PRIMARY KEY (id, chat_jid)
        );
        CREATE INDEX idx_messages_chat_timestamp ON messages(chat_jid, timestamp DESC);
        CREATE TABLE observed_whatsapp_messages (
          message_id TEXT NOT NULL, chat_jid TEXT NOT NULL,
          local_chat_label TEXT NOT NULL DEFAULT '',
          local_sender_label TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '', timestamp TEXT NOT NULL,
          from_me INTEGER NOT NULL DEFAULT 0 CHECK (from_me IN (0, 1)),
          message_kind TEXT NOT NULL DEFAULT 'text',
          upsert_type TEXT NOT NULL DEFAULT 'notify',
          observed_at TEXT NOT NULL,
          media_enriched INTEGER NOT NULL DEFAULT 0 CHECK (media_enriched IN (0, 1)),
          PRIMARY KEY (message_id, chat_jid)
        );
        CREATE INDEX idx_observed_whatsapp_chat_timestamp
          ON observed_whatsapp_messages(chat_jid, timestamp DESC, message_id DESC);
        CREATE TABLE registered_groups (
          jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
          trigger_pattern TEXT NOT NULL, added_at TEXT NOT NULL,
          container_config TEXT, requires_trigger INTEGER DEFAULT 1,
          is_main INTEGER DEFAULT 0, agent_config TEXT, runtime TEXT
        );
      `);
      db.prepare(
        `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main)
         VALUES (?, 'Owner chat', 'telegram_main', '', '2026-07-01T00:00:00.000Z', 1)`,
      ).run(OWNER_JID);
      const observed = db.prepare(
        `INSERT INTO observed_whatsapp_messages
           (message_id, chat_jid, local_chat_label, local_sender_label, content, timestamp, from_me, observed_at)
         VALUES (?, ?, 'Ivan Primerov', ?, ?, ?, ?, ?)`,
      );
      observed.run(
        'a1',
        WA_JID,
        'Ivan Primerov',
        'Про участок',
        '2026-09-27T09:00:00.000Z',
        0,
        '2026-09-27T09:00:00.000Z',
      );
      observed.run(
        'a2',
        WA_JID,
        'Owner',
        'Понял',
        '2026-09-27T09:01:00.000Z',
        1,
        '2026-09-27T09:01:00.000Z',
      );
      const message = db.prepare(
        `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      message.run(
        '1',
        OWNER_JID,
        '100',
        'Владелец',
        'Проверь участок',
        '2026-09-28T04:36:19.500000000023764Z',
        0,
        0,
      );
      message.run(
        '9',
        LEGACY_JID,
        '300',
        'Legacy',
        'участок легаси',
        '2026-09-28T04:00:00.000Z',
        0,
        0,
      );
    } finally {
      db.close();
    }
  }

  function setOwnerChatHistoryEnv(overrides: Record<string, string> = {}) {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_CHAT_JID = OWNER_JID;
    process.env.CLAUDECLAW_GROUP_FOLDER = 'telegram_main';
    process.env.CLAUDECLAW_CHAT_HISTORY_DB = dbPath;
    process.env.CLAUDECLAW_CHAT_HISTORY_TZ = 'Asia/Almaty';
    process.env.CLAUDECLAW_CHAT_HISTORY_SOURCES = 'whatsapp,bot';
    process.env.CLAUDECLAW_CHAT_HISTORY_BOT_JIDS = OWNER_JID;
    process.env.CLAUDECLAW_CHAT_HISTORY_MEDIA_ROOTS_JSON = '{}';
    Object.assign(process.env, overrides);
  }

  async function freshImport() {
    vi.resetModules();
    registeredTools.clear();
    return import('./ipc-mcp-stdio.js');
  }

  async function callChatHistory(args: Record<string, unknown>) {
    const handler = registeredTools.get('chat_history');
    expect(handler).toBeTypeOf('function');
    return (await handler!(args)) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-history-mcp-'));
    fs.mkdirSync(path.join(root, 'store'));
    dbPath = path.join(root, 'store', 'messages.db');
    seedChatHistoryDb(dbPath);
  });

  afterEach(async () => {
    delete process.env.CLAUDECLAW_DISALLOWED_TOOLS;
    fs.rmSync(root, { recursive: true, force: true });
    await freshImport();
  });

  it('registers only for a granted owner-tier main run', async () => {
    setOwnerChatHistoryEnv();
    await freshImport();
    expect(registeredTools.has('chat_history')).toBe(true);

    const denied: Array<Record<string, string>> = [
      { CLAUDECLAW_IS_MAIN: '0' },
      { CLAUDECLAW_IS_TRUSTED_OWNER_RUN: '0' },
      { CLAUDECLAW_CHAT_HISTORY_DB: '' },
      { CLAUDECLAW_CHAT_HISTORY_SOURCES: '' },
      { CLAUDECLAW_CHAT_HISTORY_DB: 'relative/messages.db' },
    ];
    for (const overrides of denied) {
      setOwnerChatHistoryEnv(overrides);
      await freshImport();
      expect(
        registeredTools.has('chat_history'),
        JSON.stringify(overrides),
      ).toBe(false);
      expect(registeredTools.has('memory_search')).toBe(true);
    }
  });

  it('honours the server-side lockout', async () => {
    for (const disallowed of ['mcp__claudeclaw__chat_history', '*']) {
      setOwnerChatHistoryEnv({ CLAUDECLAW_DISALLOWED_TOOLS: disallowed });
      await freshImport();
      expect(registeredTools.has('chat_history')).toBe(false);
    }
  });

  it('reads history without writing to the database', async () => {
    setOwnerChatHistoryEnv();
    await freshImport();
    // Like production: the live writer keeps the WAL database open.
    const writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    const before = fs.statSync(dbPath);
    const walPath = `${dbPath}-wal`;
    const walBefore = fs.existsSync(walPath) ? fs.statSync(walPath).size : -1;

    const read = await callChatHistory({
      contact: 'Иван',
      source: 'whatsapp',
    });
    expect(read.isError).toBeUndefined();
    expect(read.content[0].text).toContain('WhatsApp «Ivan Primerov»');
    expect(read.content[0].text).toContain(
      '27.09 14:00 Ivan Primerov: Про участок',
    );
    expect(read.content[0].text).toContain('27.09 14:01 Я: Понял');

    const bot = await callChatHistory({ chat: 'current' });
    expect(bot.content[0].text).toContain(
      '28.09 09:36 Владелец: Проверь участок',
    );

    // The legacy chat is not on the host allowlist.
    const all = await callChatHistory({ query: 'участ', source: 'bot' });
    expect(all.content[0].text).not.toContain('легаси');

    // Hostile strings only ever reach SQL as bound parameters.
    const crafted = await callChatHistory({
      query: "x'); DROP TABLE messages; --|' OR 1=1 --",
      contact: "'; DELETE FROM observed_whatsapp_messages; --",
    });
    expect(crafted.isError).toBeUndefined();

    const after = fs.statSync(dbPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(fs.existsSync(walPath) ? fs.statSync(walPath).size : -1).toBe(
      walBefore,
    );
    writer.close();
    const check = new Database(dbPath, { readonly: true });
    try {
      expect(
        (
          check.prepare('SELECT COUNT(*) AS n FROM messages').get() as {
            n: number;
          }
        ).n,
      ).toBe(2);
      expect(
        (
          check
            .prepare('SELECT COUNT(*) AS n FROM observed_whatsapp_messages')
            .get() as { n: number }
        ).n,
      ).toBe(2);
    } finally {
      check.close();
    }
  });

  it('never prints JIDs or phone numbers', async () => {
    setOwnerChatHistoryEnv();
    await freshImport();
    for (const args of [
      { mode: 'chats' },
      { query: 'а' },
      { contact: WA_PHONE },
    ]) {
      const text = (await callChatHistory(args)).content[0].text;
      expect(text).not.toContain('@s.whatsapp.net');
      expect(text).not.toMatch(/1555\d{7}/);
    }
  });

  it('refuses the WhatsApp source on a bot-only grant', async () => {
    setOwnerChatHistoryEnv({ CLAUDECLAW_CHAT_HISTORY_SOURCES: 'bot' });
    await freshImport();
    const refused = await callChatHistory({ source: 'whatsapp' });
    expect(refused.content[0].text).toMatch(
      /^source='whatsapp' is not available/,
    );
    const own = await callChatHistory({});
    expect(own.content[0].text).toContain('Проверь участок');
    expect(own.content[0].text).not.toContain('Про участок');
  });

  it('returns an error, not a crash, when the database is missing', async () => {
    setOwnerChatHistoryEnv({
      CLAUDECLAW_CHAT_HISTORY_DB: path.join(root, 'missing', 'messages.db'),
    });
    await freshImport();
    const result = await callChatHistory({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(
      /^Chat history is unavailable right now: /,
    );
    expect(fs.existsSync(path.join(root, 'missing'))).toBe(false);
  });

  it('marks a successful read for the link check of its run only', async () => {
    const token = randomUUID();
    const marker = path.join(root, `.foreign-read-${token}`);
    try {
      // No token (link check off for the run): nothing is written.
      setOwnerChatHistoryEnv({ CLAUDECLAW_IPC_DIR: root });
      await freshImport();
      await callChatHistory({ contact: 'Иван', source: 'whatsapp' });
      expect(fs.readdirSync(root).filter((f) => f.startsWith('.'))).toEqual([]);

      setOwnerChatHistoryEnv({
        CLAUDECLAW_IPC_DIR: root,
        CLAUDECLAW_FOREIGN_READ_MARKER: token,
      });
      await freshImport();
      await callChatHistory({ contact: 'Иван', source: 'whatsapp' });
      expect(fs.readFileSync(marker, 'utf-8')).toBe('chat_history\n');

      // A failed read hands out nothing foreign and marks nothing.
      fs.unlinkSync(marker);
      setOwnerChatHistoryEnv({
        CLAUDECLAW_IPC_DIR: root,
        CLAUDECLAW_FOREIGN_READ_MARKER: token,
        CLAUDECLAW_CHAT_HISTORY_DB: path.join(root, 'missing', 'messages.db'),
      });
      await freshImport();
      expect((await callChatHistory({})).isError).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);

      // A token that is not a token never becomes a path.
      setOwnerChatHistoryEnv({
        CLAUDECLAW_IPC_DIR: root,
        CLAUDECLAW_FOREIGN_READ_MARKER: '../../escape',
      });
      await freshImport();
      await callChatHistory({ contact: 'Иван', source: 'whatsapp' });
      expect(fs.readdirSync(root).filter((f) => f.startsWith('.'))).toEqual([]);
    } finally {
      delete process.env.CLAUDECLAW_FOREIGN_READ_MARKER;
    }
  });

  it('keeps the links of a WhatsApp read in the chat list of the group dir', async () => {
    const token = randomUUID();
    const groupDir = path.join(root, 'group');
    fs.mkdirSync(groupDir);
    const LINK = 'https://app.x.io/join/Zx81kQpL0mN2vB7tR4sY';
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO observed_whatsapp_messages
           (message_id, chat_jid, local_chat_label, local_sender_label, content, timestamp, from_me, observed_at)
         VALUES ('a3', ?, 'Ivan Primerov', 'Ivan Primerov', ?, '2026-09-27T09:02:00.000Z', 0, '2026-09-27T09:02:00.000Z')`,
      ).run(WA_JID, `Заходи: ${LINK}`);
    } finally {
      db.close();
    }
    const previousGroupDir = process.env.CLAUDECLAW_GROUP_DIR;
    try {
      setOwnerChatHistoryEnv({
        CLAUDECLAW_IPC_DIR: root,
        CLAUDECLAW_GROUP_DIR: groupDir,
        CLAUDECLAW_FOREIGN_READ_MARKER: token,
      });
      await freshImport();
      const result = await callChatHistory({
        contact: 'Иван',
        source: 'whatsapp',
      });
      expect(result.content[0].text).toContain(LINK);
      expect(readForeignUrls(foreignUrlsFilePath(groupDir)).has(LINK)).toBe(
        true,
      );
    } finally {
      delete process.env.CLAUDECLAW_FOREIGN_READ_MARKER;
      if (previousGroupDir === undefined) {
        delete process.env.CLAUDECLAW_GROUP_DIR;
      } else {
        process.env.CLAUDECLAW_GROUP_DIR = previousGroupDir;
      }
    }
  });

  it('maps a busy database to a retryable error', async () => {
    const { chatHistoryErrorText, denyChatHistoryIfNotOwner } =
      await import('./ipc-mcp-stdio.js');
    const busy = Object.assign(new Error('database is locked'), {
      code: 'SQLITE_BUSY',
    });
    expect(chatHistoryErrorText(busy)).toMatch(
      /SQLITE_BUSY.*retry in a few seconds/,
    );
    expect(denyChatHistoryIfNotOwner(true, true, true)).toBeNull();
    expect(denyChatHistoryIfNotOwner(true, false, true)?.isError).toBe(true);
    expect(denyChatHistoryIfNotOwner(false, true, true)?.isError).toBe(true);
    expect(denyChatHistoryIfNotOwner(true, true, false)?.isError).toBe(true);
  });
});


describe('game factory tool authority', () => {
  it('exposes configured second-admin factory tools without Google or desktop grants', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_GAME_FACTORY_CAPABILITY = 'fixture-capability';
    delete process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY;
    await import('./ipc-mcp-stdio.js');
    expect(registeredTools.has('game_factory_status')).toBe(true);
    expect(registeredTools.has('game_factory_control')).toBe(true);
    expect(registeredTools.has('codex_desktop_control')).toBe(false);
  });
  it('withholds tools when the host did not issue factory authority', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    await import('./ipc-mcp-stdio.js');
    expect(registeredTools.has('game_factory_status')).toBe(false);
    expect(registeredTools.has('game_factory_control')).toBe(false);
  });
  it('quarantines control while retaining the read surface', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_GAME_FACTORY_CAPABILITY = 'fixture-capability';
    process.env.CLAUDECLAW_DISALLOWED_TOOLS = 'game_factory_control';
    try {
      await import('./ipc-mcp-stdio.js');
      expect(registeredTools.has('game_factory_status')).toBe(true);
      expect(registeredTools.has('game_factory_control')).toBe(false);
    } finally { delete process.env.CLAUDECLAW_DISALLOWED_TOOLS; }
  });
});

describe('W23: wait_until hears the user while it waits', () => {
  const directOwner = () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-until-ipc-'));
    fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
    process.env.CLAUDECLAW_IPC_DIR = ipcDir;
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '1';
    return ipcDir;
  };
  const message = (ipcDir: string, text: string, name = '100-new.json') =>
    fs.writeFileSync(path.join(ipcDir, 'input', name), JSON.stringify({ type: 'message', text }));
  type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

  it('wakes as soon as a new message arrives and shows it', async () => {
    const ipcDir = directOwner();
    try {
      await import('./ipc-mcp-stdio.js');
      const wait = registeredTools.get('wait_until')!;
      expect(wait).toBeTypeOf('function');
      expect(registeredToolAnnotations.get('wait_until')).toEqual({ readOnlyHint: true });
      setTimeout(() => message(ipcDir, 'Стоп, сначала пришли смету'), 300);
      const started = Date.now();
      const result = (await wait({ seconds: 30, reason: 'жду сборку' })) as ToolResult;
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(result.isError).toBeUndefined();
      const text = result.content.map((c) => c.text).join('\n');
      expect(text).toContain('сначала пришли смету');
      expect(JSON.parse(result.content.at(-1)!.text)).toMatchObject({ kind: 'wait_result', wokeBy: 'user_input' });
      // The message stays queued for the runner: nothing is consumed.
      expect(fs.readdirSync(path.join(ipcDir, 'input'))).toEqual(['100-new.json']);
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
      delete process.env.CLAUDECLAW_IPC_DIR;
    }
  });

  it('returns at once with input already pending, instead of a paused-tool error', async () => {
    const ipcDir = directOwner();
    message(ipcDir, 'Уже написал раньше');
    try {
      await import('./ipc-mcp-stdio.js');
      const result = (await registeredTools.get('wait_until')!({ seconds: 30 })) as ToolResult;
      expect(result.isError).toBeUndefined();
      expect(result.content.map((c) => c.text).join('\n')).toContain('Уже написал раньше');
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
      delete process.env.CLAUDECLAW_IPC_DIR;
    }
  });

  it('waits the time out when nobody writes, and caps one call under the MCP limit', async () => {
    const ipcDir = directOwner();
    try {
      await import('./ipc-mcp-stdio.js');
      const started = Date.now();
      const result = (await registeredTools.get('wait_until')!({ seconds: 1 })) as ToolResult;
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(JSON.parse(result.content.at(-1)!.text)).toMatchObject({ kind: 'wait_result', wokeBy: 'timeout', waitedSeconds: 1 });
      const schema = registeredToolSchemas.get('wait_until') as { seconds: { safeParse: (v: unknown) => { success: boolean } } };
      expect(schema.seconds.safeParse(50).success).toBe(true);
      expect(schema.seconds.safeParse(51).success).toBe(false);
      expect(registeredToolDescriptions.get('wait_until')).toMatch(/sleep/);
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
      delete process.env.CLAUDECLAW_IPC_DIR;
    }
  });

  it('is offered only where new input can be seen (a direct owner run)', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '0';
    await import('./ipc-mcp-stdio.js');
    expect(registeredTools.has('wait_until')).toBe(false);
  });
});

describe('W27: codex_quota_status', () => {
  it('is a read-only owner tool that never guesses without a reading', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_CODEX_QUOTA_HOME = path.join(os.tmpdir(), 'no-such-codex-home-w27');
    process.env.CLAUDECLAW_CODEX_HOST_USED_PERCENT = '';
    try {
      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('codex_quota_status');
      expect(handler).toBeTypeOf('function');
      expect(registeredToolAnnotations.get('codex_quota_status')).toEqual({ readOnlyHint: true });
      expect(registeredToolDescriptions.get('codex_quota_status')).toContain('не позже');
      const result = (await handler!({})) as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toMatchObject({ kind: 'codex_quota_status', known: false });
      process.env.CLAUDECLAW_CODEX_HOST_USED_PERCENT = '96';
      const host = (await handler!({})) as { content: Array<{ text: string }> };
      expect(JSON.parse(host.content[0].text)).toMatchObject({ known: true, usedPercent: 96, leftPercent: 4 });
      // W27-1: the host reading's time reaches the tool.
      process.env.CLAUDECLAW_CODEX_HOST_READ_BY_MS = String(Date.now() - 60_000);
      const timed = (await handler!({})) as { content: Array<{ text: string }> };
      expect(JSON.parse(timed.content[0].text)).toMatchObject({ known: true, usedPercent: 96 });
      // Сведение с r1110: the host snapshot's own time — fresh, it counts
      // with its age; older than 6 h, it is no reading.
      process.env.CLAUDECLAW_CODEX_HOST_READING_AT_MS = String(Date.now() - 30 * 60_000);
      const fresh = (await handler!({})) as { content: Array<{ text: string }> };
      expect(JSON.parse(fresh.content[0].text)).toMatchObject({ known: true, usedPercent: 96, readingAgeMinutes: 30 });
      process.env.CLAUDECLAW_CODEX_HOST_READING_AT_MS = String(Date.now() - 7 * 3_600_000);
      const stale = (await handler!({})) as { content: Array<{ text: string }> };
      expect(JSON.parse(stale.content[0].text)).toMatchObject({ known: false });
      // Review r1111 (turn-2): the host windows reach the tool; a passed
      // reset makes the old percent no reading; broken JSON — no windows.
      process.env.CLAUDECLAW_CODEX_HOST_READING_AT_MS = String(Date.now() - 60 * 60_000);
      process.env.CLAUDECLAW_CODEX_HOST_WINDOWS = JSON.stringify([
        { usedPercent: 96, windowMinutes: 10080, resetsAtMs: Date.now() - 20 * 60_000 },
      ]);
      const reset = (await handler!({})) as { content: Array<{ text: string }> };
      expect(JSON.parse(reset.content[0].text)).toMatchObject({ known: false, resetPassedSinceReading: true });
      process.env.CLAUDECLAW_CODEX_HOST_WINDOWS = '[{broken';
      const broken = (await handler!({})) as { content: Array<{ text: string }> };
      expect(JSON.parse(broken.content[0].text)).toMatchObject({ known: true, usedPercent: 96 });
    } finally {
      delete process.env.CLAUDECLAW_CODEX_QUOTA_HOME;
      delete process.env.CLAUDECLAW_CODEX_HOST_USED_PERCENT;
      delete process.env.CLAUDECLAW_CODEX_HOST_READ_BY_MS;
      delete process.env.CLAUDECLAW_CODEX_HOST_READING_AT_MS;
      delete process.env.CLAUDECLAW_CODEX_HOST_WINDOWS;
    }
  });
  it('is not offered to a guest run', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '0';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '0';
    process.env.CLAUDECLAW_CODEX_QUOTA_HOME = '';
    await import('./ipc-mcp-stdio.js');
    expect(registeredTools.has('codex_quota_status')).toBe(false);
    delete process.env.CLAUDECLAW_CODEX_QUOTA_HOME;
  });
});

describe('W15: small tool breakages', () => {
  it('marks only the reading tools read-only, so a forwarded-text turn can still read memory', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '1';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY =
      'direct-owner-run-capability';
    await import('./ipc-mcp-stdio.js');
    for (const name of [
      'memory_search',
      'memory_get',
      'list_tasks',
      'skill_list',
      'skill_view',
      'delivery_status',
      'check_user_updates',
    ]) {
      expect(registeredTools.get(name), name).toBeTypeOf('function');
      expect(registeredToolAnnotations.get(name), name).toEqual({
        readOnlyHint: true,
      });
    }
    for (const name of [
      'send_message',
      'send_document',
      'send_photo',
      'memory_save',
      'schedule_task',
      'cancel_task',
      'codex_desktop_status',
      'codex_desktop_control',
    ]) {
      expect(registeredTools.get(name), name).toBeTypeOf('function');
      expect(registeredToolAnnotations.get(name), name).toBeUndefined();
    }
  });

  it('send_document takes a path relative to the chat folder and keeps it inside', async () => {
    // A relative send_document used to be refused, although
    // the description said guests use workspace-relative paths.
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'send-document-relative-')),
    );
    const groupDir = path.join(root, 'group');
    const ipcDir = path.join(root, 'ipc');
    fs.mkdirSync(path.join(groupDir, 'output'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'output', 'смета.pdf'), 'pdf');
    fs.writeFileSync(path.join(root, 'outside.pdf'), 'pdf');
    process.env.CLAUDECLAW_GROUP_DIR = groupDir;
    process.env.CLAUDECLAW_IPC_DIR = ipcDir;
    process.env.CLAUDECLAW_IS_MAIN = '0';
    try {
      await import('./ipc-mcp-stdio.js');
      const send = registeredTools.get('send_document')!;
      const answer = (async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const dir = path.join(ipcDir, 'messages');
          const files = fs.existsSync(dir)
            ? fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
            : [];
          if (files.length) {
            const envelope = JSON.parse(
              fs.readFileSync(path.join(dir, files[0]), 'utf8'),
            ) as Record<string, string>;
            fs.writeFileSync(
              path.join(ipcDir, 'memory', `${envelope.deliveryRequestId}.delivery.json`),
              JSON.stringify({
                deliveryId: envelope.deliveryId,
                state: 'delivered',
                code: 'api_acknowledged',
              }),
            );
            return envelope;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('send_document envelope not written');
      })();
      const result = (await send({ filePath: 'output/смета.pdf' })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      const envelope = await answer;
      expect(envelope.filePath).toBe(path.join(groupDir, 'output', 'смета.pdf'));
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('delivered');

      for (const escape of ['../outside.pdf', 'output/../../outside.pdf']) {
        const refused = (await send({ filePath: escape })) as {
          isError?: boolean;
          content: { text: string }[];
        };
        expect(refused.isError, escape).toBe(true);
        expect(refused.content[0].text).toContain(
          'send_document path must stay inside this chat workspace.',
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('codex_desktop_status cuts a long wait to 10 s instead of refusing it', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '1';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY =
      'direct-owner-run-capability';
    process.env.CLAUDECLAW_CODEX_CONTROL_RUN_ID =
      '00000000-0000-4000-8000-000000000015';
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ turn: { status: 'inProgress' } });
      },
    }));
    await import('./ipc-mcp-stdio.js');
    const { z } = await import('zod');
    const shape = registeredToolSchemas.get('codex_desktop_status') as Record<
      string,
      import('zod').ZodTypeAny
    >;
    // 45 s and 30 s used to fail schema validation.
    expect(
      z.object(shape).safeParse({ action: 'wait', timeout_seconds: 45 }).success,
    ).toBe(true);
    for (const [asked, sent] of [
      [45, 10],
      [3, 3],
    ] as const) {
      fetchSpy.mockClear();
      await registeredTools.get('codex_desktop_status')!({
        action: 'wait',
        thread_id: 'thread-1',
        timeout_seconds: asked,
      });
      const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(body.timeout_seconds, String(asked)).toBe(sent);
    }
  });
});

describe('memory_state keeps time without seconds valid (zod 4.6, SEC-02)', () => {
  it('accepts validUntil and lastObservedAt with or without seconds, not «…T18Z»', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    await import('./ipc-mcp-stdio.js');
    const { z } = await import('zod');
    const shape = registeredToolSchemas.get('memory_state') as Record<
      string,
      import('zod').ZodTypeAny
    >;
    const schema = z.object(shape);
    const source = { kind: 'assistant_report' };
    const fact = (validUntil: unknown) => ({
      operation: {
        kind: 'fact_upsert',
        operationId: 'fact-minutes-1',
        expectedRevision: 0,
        projectKey: null,
        key: 'deadline',
        value: 'Срок проверки',
        validUntil,
      },
      source,
    });
    const project = (lastObservedAt: string) => ({
      operation: {
        kind: 'project_upsert',
        operationId: 'card-minutes-1',
        expectedRevision: 0,
        projectKey: 'site',
        card: {
          title: 'Сайт',
          status: 'active',
          goal: 'Запустить сайт',
          pending: [],
          completed: [],
          waiting: null,
          artifacts: [],
          work: {
            target: 'Сервер, проект сайта',
            executor: 'Codex',
            lastObservedAt,
            requirementsRevision: 1,
            nextStep: null,
            criteria: [
              { key: 'deploy', description: 'Сайт открывается', state: 'pending' },
            ],
          },
        },
      },
      source,
    });
    // Before the zod upgrade (4.4.3) the time without seconds passed.
    for (const at of [
      '2026-11-30T18:00Z',
      '2026-11-30T18:00:00Z',
      '2026-11-30T18:00:00.000Z',
    ]) {
      expect(schema.safeParse(fact(at)).success, `validUntil ${at}`).toBe(true);
      const card = schema.safeParse(project(at));
      expect(card.success, `lastObservedAt ${at}: ${card.error?.message}`).toBe(
        true,
      );
    }
    expect(schema.safeParse(fact(null)).success).toBe(true);
    for (const at of ['2026-11-30T18Z', '2026-11-30', 'завтра']) {
      expect(schema.safeParse(fact(at)).success, `validUntil ${at}`).toBe(false);
      expect(
        schema.safeParse(project(at)).success,
        `lastObservedAt ${at}`,
      ).toBe(false);
    }
  });
});

describe('delivery tool descriptions keep the chat quiet (W24)', () => {
  it('send_message is for results, milestones, problems and questions, not routine progress', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    await import('./ipc-mcp-stdio.js');
    const send = registeredToolDescriptions.get('send_message') ?? '';
    // «Use this for progress updates» led to 19 separate reports in one day.
    expect(send).not.toMatch(/progress updates/i);
    expect(send).toContain('only for the opening plan of a long task, a result, a milestone, a problem or a question');
    expect(send).toContain('Do not repeat a file caption or your final answer');
    // A scheduled run has no «⏳» status: silent checks made people ask «ну как?».
    expect(send).toContain('In a chat turn routine progress is already shown in one quiet status message');
    expect(send).toContain('a scheduled run has no quiet status');
    expect(send).toContain('its final answer is delivered on its own unless wrapped in <internal>');
    expect(send).toContain('send the result yourself only when the final answer is <internal> — never both');
    expect(send).not.toContain('send its milestone or result there');
  });

  it('file captions are short and the final answer does not repeat them', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    const { FILE_CAPTION_GUIDANCE } = await import('./ipc-mcp-stdio.js');
    expect(FILE_CAPTION_GUIDANCE).toContain('about 300 characters');
    expect(FILE_CAPTION_GUIDANCE).toContain('must not repeat the caption');
    for (const name of ['send_photo', 'send_document']) {
      expect(registeredToolDescriptions.get(name), name).toContain(FILE_CAPTION_GUIDANCE);
    }
  });
});

describe('screen rules travel with the screen tools (W33)', () => {
  // A skill reaches the model only on trigger words: 40 % of screen actions in
  // a week ran without these rules, and every «front window» read and
  // full-screen capture happened in those turns.
  const rules = [
    /window id/,
    /«front window», «window 1» or the active tab/,
    /only your own window's region, not the whole screen/,
    /do not use the clipboard yourself/,
    /close your own window when done/,
  ];

  it('every computer_* tool carries all five rules', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    const { screenHygieneRules } = await import('./ipc-mcp-stdio.js');
    for (const rule of rules) expect(screenHygieneRules()).toMatch(rule);
    for (const name of COMPUTER_TOOLS) {
      expect(registeredToolDescriptions.get(name), name).toContain(screenHygieneRules());
    }
  });

  it('keeps the skill\'s exceptions: a window the person asked for, /codex_gui, the whole screen when nothing else works', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    const { screenHygieneRules } = await import('./ipc-mcp-stdio.js');
    expect(screenHygieneRules()).toContain('except a window the person asked you to use, or Codex Desktop under /codex_gui');
    expect(screenHygieneRules()).toContain('the whole screen only if the person asked for it or nothing else works');
  });

  it('Codex Desktop tools get a note instead: they are chats behind a bridge, not windows to close', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '1';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY = 'direct-owner-run-capability';
    const { screenHygieneRules, CODEX_DESKTOP_SCREEN_NOTE } = await import('./ipc-mcp-stdio.js');
    // Closing Codex Desktop on a worker machine cuts its remote user off (W34).
    expect(CODEX_DESKTOP_SCREEN_NOTE).toContain('do not close Codex Desktop or its chats');
    expect(CODEX_DESKTOP_SCREEN_NOTE).toContain('do not create extra chats');
    for (const name of CODEX_DESKTOP_TOOLS) {
      const description = registeredToolDescriptions.get(name) ?? '';
      expect(description, name).toContain(CODEX_DESKTOP_SCREEN_NOTE);
      expect(description, name).not.toContain(screenHygieneRules());
      expect(description, name).not.toContain('close your own window');
    }
  });
});

// The words that belong to one installation (who sits at the screen, how its
// helper is found, who keeps a password in the examples) come from the
// instance profile; without one the text is the general wording.
describe('installation wording of the tools comes from the instance profile', () => {
  afterEach(() => resetInstanceProfileForTests());

  const helperFails = (message: string) =>
    fetchSpy.mockImplementation(async () => {
      throw new Error(message);
    });
  const screenSize = async () =>
    (
      (await registeredTools.get('computer_screen_size')!({})) as {
        isError?: boolean;
        content: { text: string }[];
      }
    ).content[0].text;
  const refusal = async () =>
    (
      (await registeredTools.get('memory_save')!({
        content: 'password=' + 'synthetic-placeholder',
        source_type: 'user_message',
        confidence: 0.7,
      })) as { content: { text: string }[] }
    ).content[0].text;
  const workTargetHint = async () => {
    const { z } = await import('zod');
    const shape = registeredToolSchemas.get('memory_state') as Record<
      string,
      import('zod').ZodTypeAny
    >;
    const found: string[] = [];
    const walk = (node: unknown, key = ''): void => {
      if (Array.isArray(node)) return node.forEach((item) => walk(item));
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (key === 'target' && typeof record.description === 'string') {
        found.push(record.description);
      }
      for (const [name, value] of Object.entries(record)) walk(value, name);
    };
    walk(z.toJSONSchema(z.object(shape), { unrepresentable: 'any' }));
    return found;
  };

  it('uses the general wording when no profile is set', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-profile-text-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      const { screenHygieneRules } = await import('./ipc-mcp-stdio.js');
      expect(screenHygieneRules()).toMatch(
        /^Shared screen rules \(the owner may be using this Mac and his Chrome\): 1\) /,
      );
      expect(registeredToolDescriptions.get('computer_click')).toContain(
        'Shared screen rules (the owner may be using this Mac and his Chrome): 1) ',
      );
      expect(await workTargetHint()).toEqual([
        'Exact execution environment and project.',
      ]);
      expect(registeredToolDescriptions.get('schedule_task')).toContain(
        'TITLE: always give a short human title in Russian (title, up to 60 characters), e.g. "Слежка за обновлением сервиса" or "Напоминание об оплате интернета". People see it',
      );
      expect(await refusal()).toContain(
        '(«токен истёк», «пароль хранится у бухгалтера», «ключ API в .env»,',
      );
      helperFails('fetch failed');
      expect(await screenSize()).toBe(
        'Computer-control error: fetch failed — check that the configured local helper service is running and that its loopback port is reachable.',
      );
      helperFails('screencapture: operation not permitted');
      expect(await screenSize()).toBe(
        'Computer-control error: screencapture: operation not permitted — macOS permission missing. Grant Screen Recording and Accessibility to the Node.js executable that runs the helper in System Settings → Privacy & Security.',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the words of the profile in the descriptions, the refusal and the helper hints', async () => {
    setInstanceProfileForTests({
      prompts: {
        ownerName: 'Sample Owner',
        secretHolderExample: 'образца',
        helperUnreachableHint:
          'check that com.example.helper is loaded and that 127.0.0.1:9 is reachable.',
        helperPermissionTarget: '/Users/example/bin/node',
        workTargetHint: 'Exact machine and project; keep machines apart.',
        taskTitleExample: 'Слежка за сборкой образца',
      },
    });
    process.env.CLAUDECLAW_IS_MAIN = '1';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-profile-text-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      const { screenHygieneRules } = await import('./ipc-mcp-stdio.js');
      expect(screenHygieneRules()).toMatch(
        /^Shared screen rules \(Sample Owner may be using this Mac and his Chrome\): 1\) /,
      );
      for (const name of COMPUTER_TOOLS) {
        expect(registeredToolDescriptions.get(name), name).toContain(
          'Shared screen rules (Sample Owner may be using this Mac and his Chrome): 1) ',
        );
      }
      expect(await workTargetHint()).toEqual([
        'Exact machine and project; keep machines apart.',
      ]);
      expect(registeredToolDescriptions.get('schedule_task')).toContain(
        'TITLE: always give a short human title in Russian (title, up to 60 characters), e.g. "Слежка за сборкой образца" or "Напоминание об оплате интернета". People see it',
      );
      expect(registeredToolDescriptions.get('schedule_task')).not.toContain(
        'Слежка за обновлением сервиса',
      );
      const text = await refusal();
      expect(text).toContain(
        '(«токен истёк», «пароль хранится у образца», «ключ API в .env»,',
      );
      expect(text).not.toContain('бухгалтера');
      helperFails('connect ECONNREFUSED 127.0.0.1:9');
      expect(await screenSize()).toBe(
        'Computer-control error: connect ECONNREFUSED 127.0.0.1:9 — check that com.example.helper is loaded and that 127.0.0.1:9 is reachable.',
      );
      helperFails('Accessibility is not granted');
      expect(await screenSize()).toBe(
        'Computer-control error: Accessibility is not granted — macOS permission missing. Grant Screen Recording and Accessibility to /Users/example/bin/node in System Settings → Privacy & Security.',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
