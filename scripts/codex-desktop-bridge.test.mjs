import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CodexAppServerClient,
  CodexDesktopBridge,
  codexRequestLogFields,
  commandProcessIdentities,
  configuredMcpServerNames,
  defaultCodexDesktopStateFile,
  isolatedAppServerArgs,
  isPathWithin,
  parseMacProcessTable,
  summarizeThread,
} from '../helper/codex-desktop-bridge.js';
import {
  CodexControlRunRevocations,
  codexControlRequestError,
  codexDesktopErrorResponse,
  codexGuiAuthorizationRequired,
  isCodexApplicationName,
  parseHelperRequestUrl,
  safeHelperRequestLogFields,
  secureScreenshotDirectory,
  secureScreenshotFile,
} from '../helper/skoobi-helper-policy.js';

class FakeClient extends EventEmitter {
  constructor(cwd) {
    super();
    this.cwd = cwd;
    this.calls = [];
    this.readTurnStatus = 'inProgress';
    this.threadStatus = 'idle';
    this.threadStatusSequence = [];
    this.nextTurnId = 'turn-1';
    this.waitTurnStatus = 'completed';
    this.threadStartBlock = null;
    this.turnInterruptBlock = null;
    this.threadListError = null;
    this.waitCalls = [];
    this.listData = null;
    this.readCwdByThreadId = new Map();
    this.backgroundTerminals = [];
    this.instanceId = 'fake-server-instance';
  }

  status() {
    return { running: true, startedAt: 'now', lastError: null };
  }

  processPid() {
    return null;
  }

  serverInstanceId() {
    return this.instanceId;
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') {
      if (this.threadStartBlock) await this.threadStartBlock;
      return {
        thread: {
          id: 'thread-1',
          cwd: params.cwd,
          preview: '',
          status: { type: 'idle' },
          turns: [],
        },
      };
    }
    if (method === 'turn/start') {
      return {
        turn: { id: this.nextTurnId, status: 'inProgress', items: [] },
      };
    }
    if (method === 'turn/interrupt') {
      if (this.turnInterruptBlock) await this.turnInterruptBlock;
      this.readTurnStatus = 'interrupted';
      this.waitTurnStatus = 'interrupted';
      this.threadStatus = 'idle';
      return {};
    }
    if (method === 'thread/list') {
      if (this.threadListError) throw this.threadListError;
      const stateDbStatus =
        params.useStateDbOnly && this.threadStatusSequence.length > 0
          ? this.threadStatusSequence.shift()
          : this.threadStatus;
      return {
        data: this.listData || [
          {
            id: 'thread-1',
            cwd: this.cwd,
            preview: 'existing task',
            status: { type: stateDbStatus },
            turns: [{ id: 'turn-hidden', status: 'completed', items: [] }],
          },
        ],
        nextCursor: params.useStateDbOnly ? null : 'next-page',
      };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          cwd: this.readCwdByThreadId.get(params.threadId) || this.cwd,
          preview: 'existing task',
          status: { type: this.threadStatus },
          turns: params.includeTurns
            ? [
                {
                  id: 'turn-1',
                  status: this.readTurnStatus,
                  items: [],
                },
              ]
            : [],
        },
      };
    }
    if (method === 'thread/resume') {
      return {
        thread: {
          id: params.threadId,
          cwd: params.cwd,
          status: { type: this.threadStatus },
          turns: params.excludeTurns
            ? []
            : [
                {
                  id: 'turn-1',
                  status: this.readTurnStatus,
                  items: [],
                },
              ],
        },
      };
    }
    if (method === 'thread/backgroundTerminals/list') {
      return { data: [...this.backgroundTerminals], nextCursor: null };
    }
    if (method === 'thread/backgroundTerminals/terminate') {
      this.backgroundTerminals = this.backgroundTerminals.filter(
        (terminal) => terminal.processId !== params.processId,
      );
      return {};
    }
    return {};
  }

  async waitForTurn(_threadId, turnId, timeoutMs) {
    this.waitCalls.push({ threadId: _threadId, turnId, timeoutMs });
    return {
      id: turnId,
      status: this.waitTurnStatus,
      items: [{ id: 'a', type: 'agentMessage', text: 'Verified result' }],
    };
  }

  stop() {}
}

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-codex-bridge-'));
  tempRoots.push(root);
  const worktree = path.join(root, 'safe-worktree');
  fs.mkdirSync(worktree);
  const client = new FakeClient(worktree);
  const openedThreads = [];
  const bridge = new CodexDesktopBridge({
    client,
    stateFile: path.join(root, 'state.json'),
    allowedRoots: [worktree],
    openThread: async (threadId) => openedThreads.push(threadId),
  });
  return { root, worktree, client, bridge, openedThreads };
}

function protocolFixture(onMessage, options = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes = [];
  const logs = [];
  let buffered = '';
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.exitCode = null;
  const send = (message) => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffered += chunk.toString('utf8');
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        writes.push(message);
        onMessage?.(message, send);
        if (message.method === 'mcpServerStatus/list') {
          send({
            id: message.id,
            result: {
              data: options.mcpStatusData || [],
              nextCursor: null,
            },
          });
        }
      }
      callback();
    },
  });
  child.kill = () => {
    if (child.exitCode !== null) return true;
    child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0, 'SIGTERM'));
    return true;
  };
  const spawnCalls = [];
  const client = new CodexAppServerClient({
    codexBin: '/test/codex',
    codexHome: '/test/codex-home',
    processEnv: {
      PATH: '/safe/bin',
      HOME: '/safe/home',
      LANG: 'en_US.UTF-8',
      HELPER_SECRET: 'MUST_NOT_REACH_APP_SERVER',
      OPENAI_API_KEY: 'MUST_NOT_REACH_APP_SERVER',
      SSH_AUTH_SOCK: '/private/agent.sock',
    },
    spawnProcess(command, args, options) {
      spawnCalls.push({ command, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    log(level, message, fields) {
      logs.push({ level, message, fields });
    },
    mcpServerNames: [],
  });
  return { child, client, logs, send, spawnCalls, writes };
}

function nextEventLoopTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function savedState(worktree, overrides = {}) {
  return {
    version: 1,
    taskId: 'task-1',
    taskTitle: 'Existing task',
    threadId: 'thread-1',
    turnId: 'turn-1',
    cwd: fs.realpathSync(worktree),
    status: 'inProgress',
    startedAt: 'earlier',
    updatedAt: 'earlier',
    commandItemIds: [],
    completedCommandItemIds: [],
    commandProcesses: [],
    terminalBaselineItemIds: [],
    appServerInstanceId: 'fake-server-instance',
    ...overrides,
  };
}

describe('CodexDesktopBridge safety', () => {
  it('confines a new task to the authorized worktree without command network access', async () => {
    const { bridge, client, worktree } = fixture();
    const result = await bridge.start({
      prompt: 'Implement the local change and run tests.',
      cwd: worktree,
      taskTitle: 'Safe task',
    });

    expect(result.task.status).toBe('inProgress');
    const resolvedWorktree = fs.realpathSync(worktree);
    const threadStart = client.calls.find(
      (call) => call.method === 'thread/start',
    );
    expect(threadStart.params).toMatchObject({
      cwd: resolvedWorktree,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      runtimeWorkspaceRoots: [resolvedWorktree],
      config: {
        web_search: 'disabled',
        apps: {
          _default: {
            enabled: false,
            destructive_enabled: false,
            open_world_enabled: false,
          },
        },
      },
      dynamicTools: [],
    });
    expect(threadStart.params).not.toHaveProperty('environments');
    expect(threadStart.params.config).not.toHaveProperty('tools');
    expect(
      client.calls.filter(
        (call) =>
          call.method === 'thread/list' && call.params.useStateDbOnly === true,
      ),
    ).toHaveLength(2);
    const turnStart = client.calls.find((call) => call.method === 'turn/start');
    expect(turnStart.params.clientUserMessageId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(turnStart.params.input).toEqual([
      {
        type: 'text',
        text: 'Implement the local change and run tests.',
        text_elements: [],
      },
    ]);
    expect(turnStart.params).not.toHaveProperty('environments');
    expect(turnStart.params.sandboxPolicy).toMatchObject({
      type: 'workspaceWrite',
      writableRoots: [resolvedWorktree],
      networkAccess: false,
    });
  });

  it('rejects writes outside the configured project roots', async () => {
    const { bridge, root, worktree } = fixture();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    await expect(
      bridge.start({ prompt: 'change it', cwd: outside }),
    ).rejects.toThrow(/outside the locally authorized/i);

    const linkedOutside = path.join(worktree, 'linked-outside');
    fs.symlinkSync(outside, linkedOutside, 'dir');
    await expect(
      bridge.start({ prompt: 'follow link', cwd: linkedOutside }),
    ).rejects.toThrow(/outside the locally authorized/i);
  });

  it('fails closed when no writable project root is configured', async () => {
    const { root, worktree, client } = fixture();
    const bridge = new CodexDesktopBridge({
      client,
      stateFile: path.join(root, 'unconfigured-state.json'),
      allowedRoots: [],
      openThread: async () => {},
    });
    await expect(
      bridge.start({ prompt: 'must not start', cwd: worktree }),
    ).rejects.toThrow(/outside the locally authorized/i);
    expect(
      client.calls.filter((call) => call.method === 'thread/start'),
    ).toHaveLength(0);
  });

  it('allows only one Skoobi-managed task at a time', async () => {
    const { bridge, worktree } = fixture();
    await bridge.start({ prompt: 'first', cwd: worktree });
    await expect(
      bridge.start({ prompt: 'second', cwd: worktree }),
    ).rejects.toThrow(/still running/i);
  });

  it('opens a completed task and starts exactly one new task after it', async () => {
    const { bridge, client, worktree, openedThreads } = fixture();
    const first = await bridge.start({
      prompt: 'first',
      cwd: worktree,
      requestKey: 'a'.repeat(64),
    });
    await bridge.wait({
      threadId: first.task.threadId,
      turnId: first.task.turnId,
      timeoutMs: 1_000,
    });

    await expect(bridge.open(first.task.threadId)).resolves.toMatchObject({
      ok: true,
      threadId: first.task.threadId,
    });
    client.nextTurnId = 'turn-2';
    await expect(
      bridge.start({
        prompt: 'second',
        cwd: worktree,
        requestKey: 'b'.repeat(64),
      }),
    ).resolves.toMatchObject({
      task: {
        status: 'inProgress',
        turnId: 'turn-2',
        commandItemIds: [],
        commandProcesses: [],
      },
    });

    expect(openedThreads).toEqual([first.task.threadId]);
    expect(
      client.calls.filter((call) => call.method === 'thread/start'),
    ).toHaveLength(2);
    expect(
      client.calls.filter((call) => call.method === 'turn/start'),
    ).toHaveLength(2);
  });

  it('ignores dead process metadata from a completed task', async () => {
    const { bridge, client, root, worktree } = fixture();
    fs.writeFileSync(
      path.join(root, 'state.json'),
      JSON.stringify(
        savedState(worktree, {
          status: 'completed',
          completedAt: 'later',
          commandItemIds: ['exec-stale'],
          completedCommandItemIds: ['exec-stale'],
          commandProcesses: [
            {
              itemId: 'exec-stale',
              pid: 999_999_999,
              pgid: 999_999_999,
              uid: typeof process.getuid === 'function' ? process.getuid() : 0,
              startedAt: 'Tue Jul 21 23:35:55 2026',
              commandHash: 'c'.repeat(64),
            },
          ],
          appServerInstanceId: 'old-server-instance',
        }),
      ),
      { mode: 0o600 },
    );

    await expect(
      bridge.start({
        prompt: 'new task',
        cwd: worktree,
        requestKey: 'd'.repeat(64),
      }),
    ).resolves.toMatchObject({
      task: {
        status: 'inProgress',
        commandItemIds: [],
        completedCommandItemIds: [],
        commandProcesses: [],
      },
    });
    expect(
      client.calls.filter((call) => call.method === 'thread/start'),
    ).toHaveLength(1);
  });

  it('replays a completed start after a lost response without duplication', async () => {
    const { bridge, client, worktree } = fixture();
    const request = {
      prompt: 'fast task',
      cwd: worktree,
      taskTitle: 'Fast task',
      requestKey: 'e'.repeat(64),
    };
    const first = await bridge.start(request);
    await bridge.wait({
      threadId: first.task.threadId,
      turnId: first.task.turnId,
      timeoutMs: 1_000,
    });

    const replay = await bridge.start(request);
    expect(replay).toMatchObject({
      replayed: true,
      task: {
        taskId: first.task.taskId,
        threadId: first.task.threadId,
        turnId: first.task.turnId,
        status: 'completed',
      },
    });
    expect(
      client.calls.filter((call) => call.method === 'thread/start'),
    ).toHaveLength(1);
    expect(
      client.calls.filter((call) => call.method === 'turn/start'),
    ).toHaveLength(1);
  });

  it('keeps a real active turn protected from a different start key', async () => {
    const { bridge, client, worktree } = fixture();
    await bridge.start({
      prompt: 'first',
      cwd: worktree,
      requestKey: 'f'.repeat(64),
    });
    await expect(
      bridge.start({
        prompt: 'conflicting',
        cwd: worktree,
        requestKey: '0'.repeat(64),
      }),
    ).rejects.toThrow(/still running/i);
    expect(
      client.calls.filter((call) => call.method === 'thread/start'),
    ).toHaveLength(1);
  });

  it('serializes concurrent starts so only one thread can be created', async () => {
    const { bridge, client, worktree } = fixture();
    let releaseThreadStart;
    client.threadStartBlock = new Promise((resolve) => {
      releaseThreadStart = resolve;
    });

    const first = bridge.start({ prompt: 'first', cwd: worktree });
    await nextEventLoopTurn();
    const second = bridge.start({ prompt: 'second', cwd: worktree });
    releaseThreadStart();

    await first;
    await expect(second).rejects.toThrow(/still running/i);
    expect(
      client.calls.filter((call) => call.method === 'thread/start'),
    ).toHaveLength(1);
  });

  it('serializes separate controller instances through the state lock', async () => {
    const { root, worktree, client } = fixture();
    const stateFile = path.join(root, 'shared-controller-state.json');
    const first = new CodexDesktopBridge({
      client,
      stateFile,
      allowedRoots: [worktree],
      openThread: async () => {},
    });
    const second = new CodexDesktopBridge({
      client,
      stateFile,
      allowedRoots: [worktree],
      openThread: async () => {},
    });
    let releaseThreadStart;
    client.threadStartBlock = new Promise((resolve) => {
      releaseThreadStart = resolve;
    });

    const firstStart = first.start({ prompt: 'first', cwd: worktree });
    await nextEventLoopTurn();
    const secondStart = second.start({ prompt: 'second', cwd: worktree });
    releaseThreadStart();

    await firstStart;
    await expect(secondStart).rejects.toThrow(/still running/i);
    expect(
      client.calls.filter((call) => call.method === 'thread/start'),
    ).toHaveLength(1);
  });

  it('recovers a lock left by a dead controller without weakening the state file', async () => {
    const { root, worktree, client } = fixture();
    const stateFile = path.join(root, 'stale-lock-state.json');
    fs.writeFileSync(
      `${stateFile}.lock`,
      JSON.stringify({ pid: 999_999_999, token: 'stale-lock-token' }),
      { mode: 0o600 },
    );
    const bridge = new CodexDesktopBridge({
      client,
      stateFile,
      allowedRoots: [worktree],
      openThread: async () => {},
    });

    await expect(
      bridge.start({ prompt: 'safe start', cwd: worktree }),
    ).resolves.toMatchObject({ task: { status: 'inProgress' } });
    expect(fs.existsSync(`${stateFile}.lock`)).toBe(false);
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
  });

  it('detects an active Desktop turn on a later state-database page', async () => {
    const { bridge, client, worktree } = fixture();
    const originalRequest = client.request.bind(client);
    client.request = async (method, params) => {
      if (method === 'thread/list' && params.useStateDbOnly === true) {
        client.calls.push({ method, params });
        if (!params.cursor) {
          return {
            data: [
              {
                id: 'thread-1',
                cwd: worktree,
                status: { type: 'idle' },
              },
            ],
            nextCursor: 'page-2',
          };
        }
        return {
          data: [
            {
              id: 'thread-active-elsewhere',
              cwd: worktree,
              status: { type: 'active' },
            },
          ],
          nextCursor: null,
        };
      }
      return originalRequest(method, params);
    };

    await expect(
      bridge.start({ prompt: 'must wait', cwd: worktree }),
    ).rejects.toThrow(/Desktop turn is already active/i);
    expect(
      client.calls.filter((call) => call.method === 'thread/start'),
    ).toHaveLength(0);
  });

  it('ignores active Codex runs outside the authorized worktrees', async () => {
    const { bridge, client, worktree, root } = fixture();
    const outside = path.join(root, 'outside-project');
    fs.mkdirSync(outside);
    client.listData = [
      {
        id: 'thread-outside-active',
        cwd: outside,
        status: { type: 'active' },
        turns: [],
      },
    ];

    await expect(
      bridge.start({ prompt: 'safe local task', cwd: worktree }),
    ).resolves.toMatchObject({ task: { status: 'inProgress' } });
  });

  it('requires wait or steer instead of starting another turn in the active chat', async () => {
    const { bridge, client, worktree } = fixture();
    await bridge.start({ prompt: 'first', cwd: worktree });
    await expect(
      bridge.continueThread({ threadId: 'thread-1', prompt: 'second turn' }),
    ).rejects.toThrow(/still running/i);
    expect(
      client.calls.filter((call) => call.method === 'thread/resume'),
    ).toHaveLength(0);
  });

  it('uses installed-protocol payloads for steering and interruption', async () => {
    const { bridge, client, worktree } = fixture();
    await bridge.start({ prompt: 'first', cwd: worktree });
    await bridge.steer({
      threadId: 'thread-1',
      turnId: 'turn-1',
      prompt: 'Please also cover the race.',
    });
    const steer = client.calls.find((call) => call.method === 'turn/steer');
    expect(steer.params).toMatchObject({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [
        {
          type: 'text',
          text: 'Please also cover the race.',
          text_elements: [],
        },
      ],
    });
    const stopped = await bridge.interrupt({
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(stopped).toMatchObject({
      ok: true,
      confirmed: true,
      task: { status: 'interrupted' },
      turn: { status: 'interrupted' },
    });
    expect(
      client.calls.find((call) => call.method === 'turn/interrupt')?.params,
    ).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
  });

  it('persists the stop request before waiting for the interrupt RPC', async () => {
    const { bridge, client, worktree, root } = fixture();
    await bridge.start({ prompt: 'long task', cwd: worktree });
    let releaseInterrupt;
    client.turnInterruptBlock = new Promise((resolve) => {
      releaseInterrupt = resolve;
    });

    const stopping = bridge.interrupt({});
    await nextEventLoopTurn();
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')),
    ).toMatchObject({
      status: 'stopping',
      stopRequestedAt: expect.any(String),
    });

    releaseInterrupt();
    await expect(stopping).resolves.toMatchObject({
      confirmed: true,
      task: { status: 'interrupted' },
    });
  });

  it('terminates command terminals belonging to the managed turn', async () => {
    const { bridge, client, worktree, root } = fixture();
    const started = await bridge.start({ prompt: 'long task', cwd: worktree });
    client.backgroundTerminals = [
      {
        itemId: 'exec-managed',
        processId: 'process-managed',
        cwd: worktree,
      },
    ];
    client.emit('item/started', {
      threadId: started.task.threadId,
      turnId: started.task.turnId,
      item: {
        id: 'exec-managed',
        type: 'commandExecution',
        cwd: worktree,
        status: 'inProgress',
      },
    });
    await nextEventLoopTurn();
    await nextEventLoopTurn();
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')),
    ).toMatchObject({ commandItemIds: ['exec-managed'] });

    await expect(bridge.interrupt({})).resolves.toMatchObject({
      confirmed: true,
      processes: { confirmed: true, terminated: 1 },
    });
    expect(
      client.calls.find(
        (call) =>
          call.method === 'thread/backgroundTerminals/terminate' &&
          call.params.processId === 'process-managed',
      ),
    ).toBeTruthy();
    expect(client.backgroundTerminals).toEqual([]);
  });

  it('records command completion without persisting command text', async () => {
    const { bridge, client, worktree, root } = fixture();
    const started = await bridge.start({ prompt: 'local task', cwd: worktree });
    const event = {
      threadId: started.task.threadId,
      turnId: started.task.turnId,
      item: {
        id: 'exec-completed',
        type: 'commandExecution',
        cwd: worktree,
        command: 'SENSITIVE_COMMAND_TEXT',
        status: 'completed',
      },
    };
    client.emit('item/completed', event);
    await nextEventLoopTurn();
    await nextEventLoopTurn();

    const rawState = fs.readFileSync(path.join(root, 'state.json'), 'utf8');
    expect(JSON.parse(rawState)).toMatchObject({
      commandItemIds: ['exec-completed'],
      completedCommandItemIds: ['exec-completed'],
    });
    expect(rawState).not.toContain('SENSITIVE_COMMAND_TEXT');
  });

  it('fails closed after app-server restart when a command has no safe process identity', async () => {
    const { bridge, client, worktree } = fixture();
    const started = await bridge.start({ prompt: 'local task', cwd: worktree });
    client.emit('item/started', {
      threadId: started.task.threadId,
      turnId: started.task.turnId,
      item: {
        id: 'exec-unresolved',
        type: 'commandExecution',
        cwd: worktree,
        status: 'inProgress',
      },
    });
    await nextEventLoopTurn();
    await nextEventLoopTurn();
    client.instanceId = 'fake-server-restarted';

    await expect(bridge.interrupt({})).resolves.toMatchObject({
      confirmed: false,
      processes: { confirmed: false, unresolved: 1 },
      task: { status: 'stopping' },
    });
  });

  it('preserves pre-existing manual terminals while stopping a continued chat', async () => {
    const { bridge, client, worktree } = fixture();
    client.backgroundTerminals = [
      {
        itemId: 'exec-manual-before-task',
        processId: 'process-manual',
        cwd: worktree,
      },
    ];
    const started = await bridge.continueThread({
      threadId: 'thread-1',
      prompt: 'managed follow-up',
    });
    client.backgroundTerminals.push({
      itemId: 'exec-managed-after-baseline',
      processId: 'process-managed',
      cwd: worktree,
    });

    await expect(
      bridge.interrupt({
        threadId: started.task.threadId,
        turnId: started.task.turnId,
      }),
    ).resolves.toMatchObject({ confirmed: true });
    expect(client.backgroundTerminals).toEqual([
      {
        itemId: 'exec-manual-before-task',
        processId: 'process-manual',
        cwd: worktree,
      },
    ]);
  });

  it('does not let a long wait block an immediate interrupt', async () => {
    const { bridge, client, worktree } = fixture();
    await bridge.start({ prompt: 'long task', cwd: worktree });
    let releaseWait;
    let waitCall = 0;
    client.waitForTurn = async (_threadId, turnId) => {
      waitCall += 1;
      if (waitCall === 1) {
        await new Promise((resolve) => {
          releaseWait = resolve;
        });
      }
      return { id: turnId, status: 'interrupted', items: [] };
    };

    const waiting = bridge.wait({ timeoutMs: 45_000 });
    await nextEventLoopTurn();
    await expect(bridge.interrupt({})).resolves.toMatchObject({
      confirmed: true,
      task: { status: 'interrupted' },
    });
    releaseWait();
    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      task: { status: 'interrupted' },
    });
  });

  it('returns an already completed managed turn to a late repeated wait', async () => {
    const { bridge, client, worktree } = fixture();
    const started = await bridge.start({ prompt: 'quick task', cwd: worktree });
    const first = await bridge.wait({
      threadId: started.task.threadId,
      turnId: started.task.turnId,
      timeoutMs: 1_000,
    });
    expect(first).toMatchObject({
      timedOut: false,
      task: { status: 'completed' },
      turn: { status: 'completed' },
    });

    const repeated = await bridge.wait({
      threadId: started.task.threadId,
      turnId: started.task.turnId,
      timeoutMs: 1_000,
    });
    expect(repeated).toMatchObject({
      timedOut: false,
      task: { status: 'completed' },
      turn: { id: started.task.turnId, status: 'completed' },
    });
    expect(client.waitCalls).toHaveLength(1);
  });

  it('cannot interrupt an unrelated Desktop turn', async () => {
    const { bridge, client, worktree } = fixture();
    await bridge.start({ prompt: 'managed', cwd: worktree });
    await expect(
      bridge.interrupt({
        threadId: 'thread-other',
        turnId: 'turn-other',
      }),
    ).rejects.toThrow(/not the active Skoobi-managed task/i);
    expect(
      client.calls.filter((call) => call.method === 'turn/interrupt'),
    ).toHaveLength(0);
  });

  it('does not confirm stop when only an unmanaged Codex turn is active', async () => {
    const { bridge, client } = fixture();
    client.threadStatus = 'active';

    await expect(bridge.interrupt({})).resolves.toMatchObject({
      ok: true,
      confirmed: false,
      unmanagedActive: true,
      authorizedActiveThreadCount: 1,
      task: null,
    });
    expect(
      client.calls.filter((call) => call.method === 'turn/interrupt'),
    ).toHaveLength(0);
  });

  it('does not mistake a later manual turn for an already stopped managed task', async () => {
    const { bridge, client, worktree } = fixture();
    const started = await bridge.start({ prompt: 'quick task', cwd: worktree });
    await bridge.wait({
      threadId: started.task.threadId,
      turnId: started.task.turnId,
      timeoutMs: 1_000,
    });
    client.threadStatus = 'active';

    await expect(bridge.interrupt({})).resolves.toMatchObject({
      ok: true,
      confirmed: false,
      unmanagedActive: true,
      task: { status: 'completed' },
    });
    expect(
      client.calls.filter((call) => call.method === 'turn/interrupt'),
    ).toHaveLength(0);
  });

  it('reports no managed task instead of claiming that stop succeeded', async () => {
    const { bridge } = fixture();
    await expect(bridge.interrupt({})).resolves.toMatchObject({
      ok: true,
      confirmed: false,
      noManagedTask: true,
      task: null,
    });
  });

  it('fails closed when active Codex tasks cannot be inspected', async () => {
    const { bridge, client } = fixture();
    client.threadListError = new Error('state database unavailable');
    await expect(bridge.interrupt({})).resolves.toMatchObject({
      ok: true,
      confirmed: false,
      inspectionFailed: true,
      task: null,
    });
  });

  it('lists and reads chats without returning list history', async () => {
    const { bridge, client, worktree } = fixture();
    const listed = await bridge.list({ cwd: worktree, searchTerm: 'existing' });
    expect(listed.nextCursor).toBe('next-page');
    expect(listed.threads[0].turns).toEqual([]);
    expect(
      client.calls.find((call) => call.method === 'thread/list')?.params,
    ).toMatchObject({
      cwd: fs.realpathSync(worktree),
      searchTerm: 'existing',
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });

    const read = await bridge.read('thread-1');
    expect(read.thread.id).toBe('thread-1');
    expect(read.thread.turns[0].id).toBe('turn-1');
  });

  it('does not list, read, or open chats outside authorized roots', async () => {
    const { bridge, client, root, worktree, openedThreads } = fixture();
    const outside = path.join(root, 'outside-project');
    fs.mkdirSync(outside);
    client.listData = [
      {
        id: 'thread-safe',
        cwd: worktree,
        preview: 'safe',
        status: { type: 'idle' },
        turns: [],
      },
      {
        id: 'thread-outside',
        cwd: outside,
        preview: 'must stay private',
        status: { type: 'idle' },
        turns: [],
      },
    ];
    client.readCwdByThreadId.set('thread-outside', outside);

    const listed = await bridge.list({});
    expect(listed.threads.map((thread) => thread.id)).toEqual(['thread-safe']);
    await expect(bridge.list({ cwd: outside })).rejects.toThrow(
      /outside the locally authorized/i,
    );
    await expect(bridge.read('thread-outside')).rejects.toThrow(
      /outside the locally authorized/i,
    );
    await expect(bridge.open('thread-outside')).rejects.toThrow(
      /outside the locally authorized/i,
    );
    expect(
      client.calls.filter(
        (call) =>
          call.method === 'thread/read' &&
          call.params.threadId === 'thread-outside',
      ),
    ).toHaveLength(0);
    expect(openedThreads).toEqual([]);
  });

  it('does not let waiting on an unrelated turn overwrite active task state', async () => {
    const { bridge, worktree } = fixture();
    await bridge.start({ prompt: 'managed', cwd: worktree });
    await expect(
      bridge.wait({
        threadId: 'thread-other',
        turnId: 'turn-other',
        timeoutMs: 250,
      }),
    ).rejects.toThrow(/not the active Skoobi-managed task/i);
    const status = await bridge.status();
    expect(status.task).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'inProgress',
    });
  });

  it('opens the selected thread through the Desktop callback', async () => {
    const { bridge, openedThreads } = fixture();
    await expect(bridge.open('thread-1')).resolves.toEqual({
      ok: true,
      threadId: 'thread-1',
    });
    expect(openedThreads).toEqual(['thread-1']);
  });

  it('can open the managed chat while its turn is still running', async () => {
    const { bridge, worktree, openedThreads } = fixture();
    await bridge.start({ prompt: 'keep working', cwd: worktree });
    await expect(bridge.open('thread-1')).resolves.toMatchObject({ ok: true });
    expect(openedThreads).toEqual(['thread-1']);
  });

  it('reads and opens only the freshly managed thread while its state-db projection lags', async () => {
    const { bridge, client, worktree, openedThreads } = fixture();
    client.listData = [];
    const started = await bridge.start({
      prompt: 'finish quickly',
      cwd: worktree,
    });

    await expect(bridge.read(started.task.threadId)).resolves.toMatchObject({
      thread: {
        id: started.task.threadId,
        cwd: worktree,
      },
    });
    await expect(bridge.open(started.task.threadId)).resolves.toMatchObject({
      ok: true,
      threadId: started.task.threadId,
    });
    await expect(bridge.open('thread-unmanaged')).rejects.toThrow(
      /not visible in the state database/i,
    );
    expect(openedThreads).toEqual([started.task.threadId]);
  });

  it('persists a completed turn so it can be recovered after restart', async () => {
    const { bridge, worktree, root } = fixture();
    await bridge.start({ prompt: 'finish it', cwd: worktree });
    const waited = await bridge.wait({});
    expect(waited.task.status).toBe('completed');
    expect(waited.turn.messages[0].text).toBe('Verified result');
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).status,
    ).toBe('completed');
    expect(fs.statSync(path.join(root, 'state.json')).mode & 0o777).toBe(0o600);
    expect(bridge.client.waitCalls[0].timeoutMs).toBe(10_000);
  });

  it('reports the exact authorized roots without changing them', async () => {
    const { bridge, worktree } = fixture();
    await expect(bridge.status()).resolves.toMatchObject({
      authorizedRoots: [fs.realpathSync(worktree)],
    });
  });

  it('fails closed when state is a symlink or hardlink', async () => {
    const { root, worktree, client } = fixture();
    const externalState = path.join(root, 'external-state.json');
    fs.writeFileSync(externalState, JSON.stringify(savedState(worktree)), {
      mode: 0o600,
    });

    for (const kind of ['symlink', 'hardlink']) {
      const stateFile = path.join(root, `${kind}-state.json`);
      if (kind === 'symlink') fs.symlinkSync(externalState, stateFile);
      else fs.linkSync(externalState, stateFile);
      const bridge = new CodexDesktopBridge({
        client,
        stateFile,
        allowedRoots: [worktree],
        openThread: async () => {},
      });
      expect(bridge.state).toBeNull();
      expect((await bridge.status()).stateError).toBe('state_file_invalid');
      await expect(
        bridge.start({ prompt: 'must not start', cwd: worktree }),
      ).rejects.toThrow(/state is unsafe or invalid/i);
      fs.unlinkSync(stateFile);
    }
  });

  it('fails closed on malformed or overly-permissive state', async () => {
    const { root, worktree, client } = fixture();
    for (const [name, contents, mode] of [
      ['malformed', '{not-json', 0o600],
      ['insecure', JSON.stringify(savedState(worktree)), 0o644],
    ]) {
      const stateFile = path.join(root, `${name}.json`);
      fs.writeFileSync(stateFile, contents, { mode });
      const bridge = new CodexDesktopBridge({
        client,
        stateFile,
        allowedRoots: [worktree],
        openThread: async () => {},
      });
      expect((await bridge.status()).stateError).toBe('state_file_invalid');
      await expect(
        bridge.start({ prompt: 'must not start', cwd: worktree }),
      ).rejects.toThrow(/state is unsafe or invalid/i);
    }
    expect(
      client.calls.filter((call) => call.method === 'thread/start'),
    ).toHaveLength(0);
  });

  it('keeps controller state outside writable roots, including symlinked parents', () => {
    const { root, worktree, client } = fixture();
    expect(
      () =>
        new CodexDesktopBridge({
          client,
          stateFile: path.join(worktree, 'controller-state.json'),
          allowedRoots: [worktree],
          openThread: async () => {},
        }),
    ).toThrow(/state must be outside/i);

    const linkedStateDir = path.join(root, 'linked-state-dir');
    fs.symlinkSync(worktree, linkedStateDir, 'dir');
    expect(
      () =>
        new CodexDesktopBridge({
          client,
          stateFile: path.join(linkedStateDir, 'controller-state.json'),
          allowedRoots: [worktree],
          openThread: async () => {},
        }),
    ).toThrow(/state must be outside/i);
  });

  it('resumes an authorized unfinished task after the controller restarts', async () => {
    const { client, worktree, root } = fixture();
    const stateFile = path.join(root, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(savedState(worktree)), {
      mode: 0o600,
    });
    client.readTurnStatus = 'interrupted';
    client.threadStatus = 'idle';
    client.nextTurnId = 'turn-2';
    const restarted = new CodexDesktopBridge({
      client,
      stateFile,
      allowedRoots: [worktree],
      openThread: async () => {},
    });

    const recovered = await restarted.recoverActiveTask();
    expect(recovered.action).toBe('resumed');
    expect(recovered.task.turnId).toBe('turn-2');
    expect(recovered.task.recoveryCount).toBe(1);
    expect(client.calls.some((call) => call.method === 'thread/resume')).toBe(
      true,
    );
    const resume = client.calls.find((call) => call.method === 'thread/resume');
    expect(resume.params.config).toMatchObject({
      web_search: 'disabled',
      apps: { _default: { enabled: false } },
    });
    const recoveryTurn = client.calls
      .filter((call) => call.method === 'turn/start')
      .at(-1);
    expect(recoveryTurn.params.input[0]).toMatchObject({
      type: 'text',
      text_elements: [],
    });
  });

  it('observes an active saved turn after restart without taking it over', async () => {
    const { client, worktree, root } = fixture();
    const stateFile = path.join(root, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(savedState(worktree)), {
      mode: 0o600,
    });
    client.threadStatus = 'active';
    const restarted = new CodexDesktopBridge({
      client,
      stateFile,
      allowedRoots: [worktree],
      openThread: async () => {},
    });

    await expect(restarted.recoverActiveTask()).resolves.toMatchObject({
      action: 'already_running',
      task: { turnId: 'turn-1', status: 'inProgress' },
    });
    expect(
      client.calls.filter(
        (call) =>
          call.method === 'thread/resume' || call.method === 'turn/start',
      ),
    ).toHaveLength(0);
  });

  it('rejoins only the saved managed turn to stop it after restart', async () => {
    const { client, worktree, root } = fixture();
    const stateFile = path.join(root, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(savedState(worktree)), {
      mode: 0o600,
    });
    client.threadStatus = 'active';
    const restarted = new CodexDesktopBridge({
      client,
      stateFile,
      allowedRoots: [worktree],
      openThread: async () => {},
    });

    await expect(restarted.interrupt({})).resolves.toMatchObject({
      ok: true,
      confirmed: true,
      task: { status: 'interrupted' },
    });
    expect(
      client.calls.filter((call) => call.method === 'thread/resume'),
    ).toHaveLength(1);
    expect(
      client.calls.filter((call) => call.method === 'turn/interrupt'),
    ).toHaveLength(1);
  });

  it('does not attach to a newer manual turn in the saved thread', async () => {
    const { client, worktree, root } = fixture();
    const stateFile = path.join(root, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(savedState(worktree)), {
      mode: 0o600,
    });
    client.threadStatus = 'active';
    client.readTurnStatus = 'completed';
    const restarted = new CodexDesktopBridge({
      client,
      stateFile,
      allowedRoots: [worktree],
      openThread: async () => {},
    });

    await expect(restarted.interrupt({})).resolves.toMatchObject({
      ok: true,
      confirmed: false,
      task: { status: 'stopping' },
    });
    expect(
      client.calls.filter(
        (call) =>
          call.method === 'thread/resume' || call.method === 'turn/interrupt',
      ),
    ).toHaveLength(0);
  });

  it('never resumes a task whose durable state says stop was requested', async () => {
    const { client, worktree, root } = fixture();
    const stateFile = path.join(root, 'state.json');
    fs.writeFileSync(
      stateFile,
      JSON.stringify(
        savedState(worktree, {
          status: 'stopping',
          stopRequestedAt: 'now',
        }),
      ),
      { mode: 0o600 },
    );
    client.threadStatus = 'idle';
    client.readTurnStatus = 'interrupted';
    const restarted = new CodexDesktopBridge({
      client,
      stateFile,
      allowedRoots: [worktree],
      openThread: async () => {},
    });

    await expect(restarted.recoverActiveTask()).resolves.toMatchObject({
      action: 'interrupted',
      task: { status: 'interrupted' },
    });
    expect(
      client.calls.filter((call) => call.method === 'turn/start'),
    ).toHaveLength(0);
  });
});

describe('CodexAppServerClient protocol', () => {
  it('initializes with the capabilities required by Codex 0.144.1', async () => {
    const fixture = protocolFixture((message, send) => {
      if (message.method === 'initialize') {
        send({ id: message.id, result: { userAgent: 'test' } });
      }
    });

    await fixture.client.ensureStarted();
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.spawnCalls[0]).toMatchObject({
      command: '/test/codex',
      options: {
        env: {
          PATH: '/safe/bin',
          HOME: '/safe/home',
          LANG: 'en_US.UTF-8',
          CODEX_HOME: '/test/codex-home',
        },
      },
    });
    expect(fixture.spawnCalls[0].args).toEqual(isolatedAppServerArgs([]));
    expect(fixture.spawnCalls[0].options.env).not.toHaveProperty(
      'HELPER_SECRET',
    );
    expect(fixture.spawnCalls[0].options.env).not.toHaveProperty(
      'OPENAI_API_KEY',
    );
    expect(fixture.spawnCalls[0].options.env).not.toHaveProperty(
      'SSH_AUTH_SOCK',
    );
    const initialize = fixture.writes.find(
      (message) => message.method === 'initialize',
    );
    expect(initialize.params.capabilities).toEqual({
      experimentalApi: true,
      requestAttestation: false,
    });
    const initialized = fixture.writes.find(
      (message) => message.method === 'initialized',
    );
    expect(initialized).toEqual({ method: 'initialized' });
    fixture.client.stop();
  });

  it('fails closed if any configured MCP server still exposes tools', async () => {
    const fixture = protocolFixture(
      (message, send) => {
        if (message.method === 'initialize') {
          send({ id: message.id, result: {} });
        }
      },
      {
        mcpStatusData: [
          {
            name: 'unexpected',
            serverInfo: { name: 'unexpected', version: '1' },
            tools: { dangerous: { name: 'dangerous' } },
            resources: [],
            resourceTemplates: [],
            authStatus: 'unsupported',
          },
        ],
      },
    );

    await expect(fixture.client.ensureStarted()).rejects.toThrow(
      /exposed an MCP tool/i,
    );
    expect(fixture.child.exitCode).toBe(0);
  });

  it('does not send concurrent requests before initialize completes', async () => {
    let initializeRequest;
    const fixture = protocolFixture((message, send) => {
      if (message.method === 'initialize') {
        initializeRequest = message;
      } else if (message.method === 'thread/list') {
        send({ id: message.id, result: { data: [], nextCursor: null } });
      }
    });

    const first = fixture.client.request('thread/list', { limit: 1 });
    const second = fixture.client.request('thread/list', { limit: 2 });
    await nextEventLoopTurn();
    await nextEventLoopTurn();
    expect(fixture.writes.map((message) => message.method)).toEqual([
      'initialize',
    ]);

    fixture.send({ id: initializeRequest.id, result: {} });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { data: [], nextCursor: null },
      { data: [], nextCursor: null },
    ]);
    expect(
      fixture.writes.filter((message) => message.method === 'thread/list'),
    ).toHaveLength(2);
    fixture.client.stop();
  });

  it('keeps waiting when fresh rollout metadata is briefly unreadable', async () => {
    const sensitive = 'PROMPT_OR_RESULT_MUST_NOT_REACH_LOGS';
    const fixture = protocolFixture((message, send) => {
      if (message.method === 'initialize') {
        send({ id: message.id, result: {} });
      } else if (message.method === 'thread/read') {
        send({
          id: message.id,
          error: { code: -32000, message: `rollout missing: ${sensitive}` },
        });
        setImmediate(() => {
          send({
            method: 'turn/completed',
            params: {
              threadId: 'thread-fresh',
              turn: {
                id: 'turn-fresh',
                status: 'completed',
                items: [],
              },
            },
          });
        });
      }
    });

    await fixture.client.ensureStarted();
    fixture.child.stderr.write(`${sensitive}\n`);
    const turn = await fixture.client.waitForTurn(
      'thread-fresh',
      'turn-fresh',
      1_000,
    );
    expect(turn).toMatchObject({ id: 'turn-fresh', status: 'completed' });
    expect(
      fixture.logs.some(
        (entry) => entry.message === 'codex_thread_initial_read_failed',
      ),
    ).toBe(true);
    expect(JSON.stringify(fixture.logs)).not.toContain(sensitive);
    fixture.client.stop();
  });

  it('polls history when completion happened before the listener attached', async () => {
    let reads = 0;
    const fixture = protocolFixture((message, send) => {
      if (message.method === 'initialize') {
        send({ id: message.id, result: {} });
      } else if (message.method === 'thread/read') {
        reads += 1;
        send({
          id: message.id,
          result: {
            thread: {
              id: 'thread-race',
              turns: [
                {
                  id: 'turn-race',
                  status: reads === 1 ? 'inProgress' : 'interrupted',
                  items: [],
                },
              ],
            },
          },
        });
      }
    });

    await fixture.client.ensureStarted();
    await expect(
      fixture.client.waitForTurn('thread-race', 'turn-race', 2_000),
    ).resolves.toMatchObject({ id: 'turn-race', status: 'interrupted' });
    expect(reads).toBeGreaterThanOrEqual(2);
    fixture.client.stop();
  });

  it('declines approvals and interactive requests without elevation', async () => {
    const fixture = protocolFixture((message, send) => {
      if (message.method === 'initialize') {
        send({ id: message.id, result: {} });
      }
    });
    await fixture.client.ensureStarted();

    fixture.send({
      id: 90,
      method: 'item/commandExecution/requestApproval',
      params: {},
    });
    fixture.send({
      id: 91,
      method: 'item/fileChange/requestApproval',
      params: {},
    });
    fixture.send({ id: 92, method: 'applyPatchApproval', params: {} });
    fixture.send({ id: 93, method: 'execCommandApproval', params: {} });
    fixture.send({
      id: 94,
      method: 'item/tool/requestUserInput',
      params: {},
    });
    fixture.send({
      id: 95,
      method: 'mcpServer/elicitation/request',
      params: {},
    });
    fixture.send({
      id: 96,
      method: 'item/permissions/requestApproval',
      params: {},
    });
    await nextEventLoopTurn();

    const byId = new Map(
      fixture.writes
        .filter((message) => Number(message.id) >= 90)
        .map((message) => [message.id, message]),
    );
    expect(byId.get(90)?.result).toEqual({ decision: 'decline' });
    expect(byId.get(91)?.result).toEqual({ decision: 'decline' });
    expect(byId.get(92)?.result).toEqual({ decision: 'denied' });
    expect(byId.get(93)?.result).toEqual({ decision: 'denied' });
    expect(byId.get(94)?.result).toEqual({ answers: {} });
    expect(byId.get(95)?.result).toEqual({
      action: 'decline',
      content: null,
      _meta: null,
    });
    expect(byId.get(96)?.error?.code).toBe(-32001);
    fixture.client.stop();
  });
});

describe('Codex Desktop summaries', () => {
  it('binds an OS process group only to a matching app-server descendant', () => {
    const rows = parseMacProcessTable(
      [
        ' 100 1 100 501 Sat Jul 18 14:00:00 2026 /usr/bin/node codex',
        ' 101 100 100 501 Sat Jul 18 14:00:00 2026 /path/codex app-server',
        ' 200 101 200 501 Sat Jul 18 14:01:00 2026 /bin/zsh -c safe-loop-command',
        ' 201 200 200 501 Sat Jul 18 14:01:01 2026 sleep 1',
        ' 300 1 300 501 Sat Jul 18 14:01:00 2026 /bin/zsh -c safe-loop-command',
      ].join('\n'),
    );
    const identities = commandProcessIdentities(
      rows,
      100,
      'safe-loop-command',
      501,
    );
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      pid: 200,
      pgid: 200,
      uid: 501,
      startedAt: 'Sat Jul 18 14:01:00 2026',
    });
    expect(identities[0].commandHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the shell payload when macOS ps normalizes the command wrapper', () => {
    const rows = parseMacProcessTable(
      [
        ' 100 1 100 501 Sat Jul 18 14:00:00 2026 /usr/bin/node codex',
        ' 200 100 200 501 Sat Jul 18 14:01:00 2026 /bin/zsh -c for ((i=0; i<600; i++)); do print tick; sleep 0.2; done',
      ].join('\n'),
    );
    const identities = commandProcessIdentities(
      rows,
      100,
      "/bin/zsh -lc 'for ((i=0; i<600; i++)); do print tick; sleep 0.2; done'",
      501,
    );
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ pid: 200, pgid: 200, uid: 501 });
  });

  it('decodes standard nested shell quote escaping before process matching', () => {
    const rows = parseMacProcessTable(
      " 200 100 200 501 Sat Jul 18 14:01:00 2026 /bin/zsh -c printf '%s\\n' tick",
    );
    const command = `/bin/zsh -lc 'printf '"'"'%s\\n'"'"' tick'`;
    const identities = commandProcessIdentities(rows, 100, command, 501);
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ pid: 200, pgid: 200, uid: 501 });
  });

  it('safely binds a private app-server process group when ps rewrites argv', () => {
    const rows = parseMacProcessTable(
      [
        ' 200 100 200 501 Sat Jul 18 14:01:00 2026 /bin/zsh -c line-one\\012line-two',
        ' 300 1 300 501 Sat Jul 18 14:01:00 2026 /bin/zsh -c unrelated',
      ].join('\n'),
    );
    const identities = commandProcessIdentities(
      rows,
      100,
      "/bin/zsh -lc 'line-one\nline-two'",
      501,
    );
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ pid: 200, pgid: 200, uid: 501 });
  });

  it('keeps durable controller state outside project worktrees by default', () => {
    const syntheticHome = path.join('/', 'Users', 'example');
    const stateFile = defaultCodexDesktopStateFile(syntheticHome);
    expect(path.isAbsolute(stateFile)).toBe(true);
    expect(stateFile).not.toContain('/project/');
    expect(stateFile).toContain('codex-desktop');
  });

  it('extracts configured MCP names and builds fail-closed app-server overrides', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-'));
    tempRoots.push(root);
    const configFile = path.join(root, 'config.toml');
    fs.writeFileSync(
      configFile,
      '[mcp_servers.node_repl]\ncommand = "node"\n\n[mcp_servers.node_repl.env]\nSAFE = "1"\n\n[mcp_servers.docs]\nurl = "https://example.invalid"\n',
    );
    const names = configuredMcpServerNames(configFile);
    expect(names).toEqual(['docs', 'node_repl']);
    const args = isolatedAppServerArgs(names);
    expect(args).toContain('mcp_servers.docs.enabled=false');
    expect(args).toContain('mcp_servers.node_repl.enabled=false');
    expect(args).toContain('sandbox_permissions=[]');
    expect(args).toContain('browser_use_full_cdp_access');
    expect(args).toContain('tool_call_mcp_elicitation');
    expect(args.slice(-3)).toEqual(['app-server', '--listen', 'stdio://']);
  });

  it('rejects MCP config names that cannot be safely overridden', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-'));
    tempRoots.push(root);
    const configFile = path.join(root, 'config.toml');
    fs.writeFileSync(
      configFile,
      '[mcp_servers."unexpected.name"]\nurl = "https://example.invalid"\n',
    );
    expect(() => configuredMcpServerNames(configFile)).toThrow(
      /unsupported server name/i,
    );
  });

  it('redacts prompts, titles, and results from helper log fields', () => {
    const sensitive = 'SENSITIVE_PROMPT_OR_RESULT';
    const fields = codexRequestLogFields({
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      cwd: '/safe/project',
      task_title: sensitive,
      prompt: sensitive,
      result: sensitive,
    });
    expect(fields).toMatchObject({
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      cwd: '/safe/project',
      task_title_length: sensitive.length,
      prompt_length: sensitive.length,
    });
    expect(JSON.stringify(fields)).not.toContain(sensitive);
    expect(fields).not.toHaveProperty('result');
  });

  it('returns useful results without leaking aggregated command output', () => {
    const summarized = summarizeThread({
      id: 'thread',
      cwd: '/project',
      preview: 'Task',
      status: { type: 'idle' },
      turns: [
        {
          id: 'turn',
          status: 'completed',
          items: [
            { id: 'm', type: 'agentMessage', text: 'Done' },
            {
              id: 'c',
              type: 'commandExecution',
              command: 'npm test',
              status: 'completed',
              exitCode: 0,
              aggregatedOutput: 'SECRET_OUTPUT_SHOULD_NOT_BE_EXPOSED',
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(summarized)).toContain('npm test');
    expect(JSON.stringify(summarized)).not.toContain('SECRET_OUTPUT');
  });

  it('handles root containment without prefix confusion', () => {
    expect(isPathWithin('/tmp/project/worktree', '/tmp/project')).toBe(true);
    expect(isPathWithin('/tmp/project-other', '/tmp/project')).toBe(false);
  });
});

describe('Skoobi helper hardening policy', () => {
  it('parses request targets against a fixed loopback origin', () => {
    const parsed = parseHelperRequestUrl('/health?probe=1');
    expect(parsed?.origin).toBe('http://127.0.0.1');
    expect(parsed?.pathname).toBe('/health');
    expect(parseHelperRequestUrl('//example.invalid/health')).toBeNull();
    expect(parseHelperRequestUrl('http://example.invalid/health')).toBeNull();
    expect(parseHelperRequestUrl(undefined)).toBeNull();
  });

  it('maps bridge failures to useful public errors without leaking internals', () => {
    expect(
      codexDesktopErrorResponse(
        new Error(
          'This project is outside the locally authorized Codex Desktop roots.',
        ),
      ),
    ).toEqual({
      status: 403,
      body: {
        error: 'cwd_not_authorized',
        detail:
          'cwd is outside the authorized Codex Desktop project roots. Inspect status before retrying.',
      },
    });
    expect(
      codexDesktopErrorResponse(new Error('threadId is required')),
    ).toMatchObject({
      status: 400,
      body: { error: 'thread_id_required' },
    });
    expect(
      codexDesktopErrorResponse(
        new Error('cwd must be an existing absolute project directory'),
      ),
    ).toMatchObject({
      status: 400,
      body: { error: 'cwd_invalid' },
    });

    const sensitive =
      'SECRET_TOKEN=must-not-leak at /private/credentials/service.json';
    const internal = codexDesktopErrorResponse(new Error(sensitive));
    expect(internal).toMatchObject({
      status: 500,
      body: {
        error: 'codex_desktop_internal_error',
        detail: expect.stringMatching(/Inspect status and the helper log/i),
      },
    });
    expect(JSON.stringify(internal)).not.toContain(sensitive);
    expect(JSON.stringify(internal)).not.toContain('/private/credentials');
  });

  it('durably rejects a delayed Codex mutation after its run is stopped', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-codex-revocations-'),
    );
    tempRoots.push(root);
    fs.chmodSync(root, 0o700);
    const stateFile = path.join(root, 'revoked-runs.json');
    const stoppedRunId = '00000000-0000-4000-8000-000000000007';
    const freshRunId = '00000000-0000-4000-8000-000000000008';
    const now = 1_800_000_000_000;
    const revocations = new CodexControlRunRevocations(stateFile, {
      now: () => now,
    });

    expect(
      codexControlRequestError(
        '/codex_desktop/start',
        stoppedRunId,
        revocations,
      ),
    ).toBeNull();
    expect(
      codexControlRequestError('/codex_desktop/start', undefined, revocations),
    ).toBe('codex_control_run_id_required');

    // Model the observed order: stop reaches the helper before the delayed
    // start request finishes arriving.
    revocations.revoke(stoppedRunId);
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(
      codexControlRequestError(
        '/codex_desktop/start',
        stoppedRunId,
        revocations,
      ),
    ).toBe('codex_control_run_revoked');
    expect(
      codexControlRequestError(
        '/codex_desktop/continue',
        freshRunId,
        revocations,
      ),
    ).toBeNull();
    expect(
      codexControlRequestError('/codex_desktop/read', undefined, revocations),
    ).toBeNull();

    const afterRestart = new CodexControlRunRevocations(stateFile, {
      now: () => now,
    });
    expect(afterRestart.isRevoked(stoppedRunId)).toBe(true);
  });

  it('recognizes Codex GUI control and requires per-turn authorization', () => {
    expect(isCodexApplicationName('Codex')).toBe(true);
    expect(isCodexApplicationName('Codex.app')).toBe(true);
    expect(isCodexApplicationName('Codex Desktop')).toBe(true);
    expect(isCodexApplicationName('/Applications/Codex.app')).toBe(true);
    expect(isCodexApplicationName('com.openai.codex')).toBe(true);
    expect(isCodexApplicationName('Safari')).toBe(false);
    expect(
      codexGuiAuthorizationRequired({
        endpoint: '/open_app',
        body: { name: 'Codex' },
        frontmostApplication: 'Safari',
      }),
    ).toBe(true);
    expect(
      codexGuiAuthorizationRequired({
        endpoint: '/type',
        body: { text: 'secret prompt' },
        frontmostApplication: 'Codex',
      }),
    ).toBe(true);
    expect(
      codexGuiAuthorizationRequired({
        endpoint: '/type',
        body: { text: 'ordinary text' },
        frontmostApplication: 'Safari',
      }),
    ).toBe(false);
  });

  it('logs typed text length without retaining any preview', () => {
    const sensitive = 'SENSITIVE_TYPED_PROMPT';
    const fields = safeHelperRequestLogFields('/type', { text: sensitive });
    expect(fields).toEqual({ text_length: sensitive.length });
    expect(JSON.stringify(fields)).not.toContain(sensitive);
  });

  it('makes screenshots private and removes old or excess managed files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-screenshots-'));
    tempRoots.push(root);
    const directory = path.join(root, 'shots');
    fs.mkdirSync(directory, { mode: 0o755 });
    const nowMs = Date.now();
    const oldFile = path.join(directory, `${nowMs - 60_000}.png`);
    const recentFiles = [1, 2, 3].map((offset) =>
      path.join(directory, `${nowMs + offset}.png`),
    );
    const unrelated = path.join(directory, 'keep.txt');
    for (const file of [oldFile, ...recentFiles]) {
      fs.writeFileSync(file, 'image', { mode: 0o644 });
    }
    fs.writeFileSync(unrelated, 'unrelated', { mode: 0o644 });
    fs.utimesSync(oldFile, new Date(nowMs - 60_000), new Date(nowMs - 60_000));
    recentFiles.forEach((file, index) => {
      const modified = new Date(nowMs - index * 1_000);
      fs.utimesSync(file, modified, modified);
    });

    const result = secureScreenshotDirectory(directory, {
      nowMs,
      retentionMs: 30_000,
      maxFiles: 2,
    });

    expect(result).toEqual({ deleted: 2, retained: 2 });
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(recentFiles[2])).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
    for (const file of recentFiles.slice(0, 2)) {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }

    const newFile = path.join(
      directory,
      `${nowMs}-00000000-0000-4000-8000-000000000000.png`,
    );
    fs.writeFileSync(newFile, 'new image', { mode: 0o644 });
    expect(secureScreenshotFile(newFile, directory)).toBe(9);
    expect(fs.statSync(newFile).mode & 0o777).toBe(0o600);

    const symlink = path.join(root, 'shots-link');
    fs.symlinkSync(directory, symlink);
    expect(() => secureScreenshotDirectory(symlink)).toThrow(
      /not a directory/i,
    );
  });
});
