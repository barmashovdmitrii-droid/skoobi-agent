import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestHostGameFactory } from '../agent/runner/src/game-factory-ipc.js';
import {
  handleGameFactoryWireRequest,
  registerGameFactoryCapability,
  revokeGameFactoryCapability,
} from '../packages/core/src/orchestrator/game-factory-authorization.js';

vi.mock('../packages/core/src/orchestrator/game-factory-service.js', () => ({
  executeGameFactoryRequest: vi.fn(
    async (
      actor: { identityId: string },
      request: { operationId: string },
    ) => ({ identity: actor.identityId, operationId: request.operationId }),
  ),
}));

const temporary: string[] = [];
const caps: string[] = [];
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  caps.splice(0).forEach(revokeGameFactoryCapability);
  temporary
    .splice(0)
    .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});
function fixture() {
  const ipcDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'factory-ipc-test-'),
  );
  temporary.push(ipcDirectory);
  const groupFolder = 'factory-test';
  const capability = registerGameFactoryCapability({
    groupFolder,
    chatJid: 'tg:fixture',
    tenantId: 'tenant-test',
    isMain: true,
    credentialProxyTier: 'owner',
    homogeneousOwnerBatch: true,
    currentMessageIds: ['fixture-message'],
    allowControl: true,
    senderIdentity: {
      channel: 'telegram',
      chat_id: 'fixture',
      identity_id: 'fixture-identity',
      telegram_user_id: 'fixture-sender',
      is_owner_sender: true,
      telegram_message_origin: 'direct',
    },
    policy: { enabledActorIdentityIds: ['fixture-identity'] },
  })!;
  caps.push(capability);
  return { capability, groupFolder, ipcDirectory };
}
function readRequest(directory: string) {
  const filename = fs
    .readdirSync(directory)
    .find((name) => name.endsWith('.request.json'))!;
  return JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
}
describe('sealed game-factory IPC roundtrip', () => {
  it('returns a host result without placing private payloads, identities or secrets on shared IPC', async () => {
    const context = fixture();
    const pending = requestHostGameFactory({
      ...context,
      mode: 'control',
      payload: {
        action: 'create',
        operationId: 'operation-test',
        args: { goal: 'Private game concept' },
      },
    });
    const request = readRequest(context.ipcDirectory);
    expect(JSON.stringify(request)).not.toContain('Private game concept');
    expect(JSON.stringify(request)).not.toContain('fixture-identity');
    expect(JSON.stringify(request)).not.toContain(
      context.capability.split('.')[1],
    );
    const response = await handleGameFactoryWireRequest(
      request,
      context.groupFolder,
      async (actor, payload) => ({
        identity: actor.identityId,
        goal: payload.args?.goal,
      }),
    );
    expect(JSON.stringify(response)).not.toContain('Private game concept');
    fs.writeFileSync(
      path.join(context.ipcDirectory, `${request.request_id}.result.json`),
      JSON.stringify(response),
    );
    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      data: { identity: 'fixture-identity', goal: 'Private game concept' },
    });
    expect(fs.readdirSync(context.ipcDirectory)).toEqual([]);
  });
  it('rejects forged plaintext host results rather than displaying their contents', async () => {
    const context = fixture();
    const pending = requestHostGameFactory({
      ...context,
      mode: 'status',
      payload: { action: 'inspect', operationId: 'operation-test' },
    });
    const request = readRequest(context.ipcDirectory);
    fs.writeFileSync(
      path.join(context.ipcDirectory, `${request.request_id}.result.json`),
      JSON.stringify({
        type: 'game_factory_result',
        request_id: request.request_id,
        ok: true,
        data: 'forged private value',
      }),
    );
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('forged private value');
  });
  it('rejects a symlink result and preserves the target file', async () => {
    const context = fixture();
    const pending = requestHostGameFactory({
      ...context,
      mode: 'status',
      payload: { action: 'list', operationId: 'operation-test' },
    });
    const request = readRequest(context.ipcDirectory);
    const target = path.join(context.ipcDirectory, 'protected');
    fs.writeFileSync(target, 'private-secret');
    fs.symlinkSync(
      target,
      path.join(context.ipcDirectory, `${request.request_id}.result.json`),
    );
    expect((await pending).isError).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('private-secret');
  });
  it('reports uncertain completion and the same operation ID retry requirement after timeout', async () => {
    const context = fixture();
    const result = await requestHostGameFactory({
      ...context,
      mode: 'control',
      payload: { action: 'create', operationId: 'operation-test' },
      timeoutMs: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('same operationId');
    expect(fs.readdirSync(context.ipcDirectory)).toEqual([]);
  });
});

it('routes the actual watcher factory branch to the service with the host actor', async () => {
  const { DATA_DIR } =
    await import('../packages/core/src/orchestrator/config.js');
  const { startIpcWatcher } =
    await import('../packages/core/src/orchestrator/ipc.js');
  const { executeGameFactoryRequest } =
    await import('../packages/core/src/orchestrator/game-factory-service.js');
  const context = fixture();
  const groupDirectory = path.join(DATA_DIR, 'ipc', context.groupFolder);
  temporary.push(groupDirectory);
  const ipcDirectory = path.join(groupDirectory, 'memory');
  vi.useFakeTimers();
  const pending = requestHostGameFactory({
    ...context,
    ipcDirectory,
    mode: 'control',
    payload: { action: 'create', operationId: 'watcher-operation' },
  });
  startIpcWatcher({
    registeredGroups: () => ({
      'tg:fixture': {
        name: 'Fixture',
        folder: context.groupFolder,
        trigger: 'always',
        added_at: '2026-01-01T00:00:00Z',
        isMain: true,
      },
    }),
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    router: {
      route: async () => null,
      send: async () => {},
      sendPhoto: async () => false,
      sendDocument: async () => false,
      sendVoice: async () => false,
      addPreHook: () => {},
      addPostHook: () => {},
    },
  });
  await vi.advanceTimersByTimeAsync(50);
  const result = await pending;
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(result.content[0].text)).toEqual({
    ok: true,
    data: { identity: 'fixture-identity', operationId: 'watcher-operation' },
  });
  expect(executeGameFactoryRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      identityId: 'fixture-identity',
      sourceGroup: context.groupFolder,
      currentMessageIds: ['fixture-message'],
    }),
    expect.objectContaining({ action: 'create' }),
  );
  let finish!: () => void;
  vi.mocked(executeGameFactoryRequest).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ completed: true });
      }),
  );
  const blocked = requestHostGameFactory({
    ...context,
    ipcDirectory,
    mode: 'control',
    payload: { action: 'create', operationId: 'blocked-operation' },
  });
  await vi.advanceTimersByTimeAsync(1000);
  const calls = vi.mocked(executeGameFactoryRequest).mock.calls.length;
  let finishSecond!: () => void;
  vi.mocked(executeGameFactoryRequest).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSecond = () => resolve({ completed: true });
      }),
  );
  const secondBlocked = requestHostGameFactory({
    ...context,
    ipcDirectory,
    mode: 'control',
    payload: { action: 'create', operationId: 'second-blocked-operation' },
  });
  await vi.advanceTimersByTimeAsync(1000);
  const busy = requestHostGameFactory({
    ...context,
    ipcDirectory,
    mode: 'control',
    payload: { action: 'create', operationId: 'busy-operation' },
  });
  fs.writeFileSync(
    path.join(ipcDirectory, 'ordinary-memory.request.json'),
    JSON.stringify({ type: 'memory_sign', request_id: 'ordinary-memory' }),
  );
  const status = requestHostGameFactory({
    ...context,
    ipcDirectory,
    mode: 'status',
    payload: { action: 'list', operationId: 'status-operation' },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(
    fs.existsSync(path.join(ipcDirectory, 'ordinary-memory.result.json')),
  ).toBe(true);
  expect((await status).isError).toBeUndefined();
  const busyResult = await busy;
  expect(busyResult.isError).toBe(true);
  expect(busyResult.content[0].text).toContain(
    'factory_busy_retry_same_operation',
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(vi.mocked(executeGameFactoryRequest).mock.calls.length).toBe(
    calls + 2,
  );
  finish();
  finishSecond();
  await vi.advanceTimersByTimeAsync(50);
  expect((await blocked).isError).toBeUndefined();
  expect((await secondBlocked).isError).toBeUndefined();
});
