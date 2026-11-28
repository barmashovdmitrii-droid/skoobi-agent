import { ownerReadNameSource } from '../../test/read-name-message.js';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runners = vi.hoisted(() => ({ container: vi.fn(), sandbox: vi.fn(), reserve: vi.fn() }));
vi.mock('../runtimes/container-runner.js', async original => ({
  ...await original<typeof import('../runtimes/container-runner.js')>(),
  runContainerAgent: runners.container, writeTasksSnapshot: vi.fn(),
}));
vi.mock('../runtimes/sandbox-runner.js', () => ({ runSandboxAgent: runners.sandbox }));
vi.mock('./model-gateway.js', async original => ({
  ...await original<typeof import('./model-gateway.js')>(), createModelGateway: runners.reserve,
}));

import { _initTestDatabase, createTask, getDb, getTaskById, updateTask } from './db.js';
import { TenantRegistry, createTelegramSenderIdentity, loadOwnerAllowlistFromEnv } from './tenant-registry.js';
import { ensureMemoryStateSchema, getMemoryProject, mutateMemoryState, type MemoryStateScope } from './memory-state-store.js';
import { _clearMemoryWriteCapabilities, authorizeMemoryStateRequest, authorizeMemorySigningRequest,
  revokeMemoryReadCapability, signMemoryWriteRequest } from './memory-provenance.js';
import { handleMemoryStateRequest } from './memory-state-service.js';
import { bindScheduledMemoryRead, prepareScheduledMemoryRead, validateScheduledMemoryBinding } from './memory-task-scope.js';
import { registerTaskAuthorizationCapability, authorizeTaskOperationRequest, _clearTaskAuthorizationState } from './task-authorization.js';
import { signedTaskAuthorizationRequestForTest } from './task-authorization.test-helpers.js';
import { processTaskIpc } from './ipc.js';
import { runTask } from './task-scheduler.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';

const jid = 'tg:101', folder = 'scheduled-memory-fixture';
let groups: Record<string, RegisteredGroup>;
let scope: MemoryStateScope;
let task: ScheduledTask;
let creator: ReturnType<typeof createTelegramSenderIdentity>;
let sourceTime: string;
function project(key: string, privateText: string) {
  mutateMemoryState(getDb(), scope, { kind: 'project_upsert', projectKey: key,
    operationId: randomUUID(), expectedRevision: 0,
    card: { title: key, goal: privateText, status: 'active', pending: ['Verify ordinary controls'],
      completed: [], waiting: null, artifacts: [] } },
  { kind: 'direct_user', at: sourceTime, messageId: randomUUID(), quote: privateText, currentDirectInput: true });
}
function bind(key: string | null = 'alpha') {
  const current = getTaskById(task.id)!;
  const validated = validateScheduledMemoryBinding(getDb(), current, key, groups,
    { sourceGroup: folder, creatorIdentityId: creator.identity_id, creatorSenderId: '101' });
  bindScheduledMemoryRead(getDb(), current, key, validated);
}
function grant() {
  const result = prepareScheduledMemoryRead(getDb(), getTaskById(task.id)!, () => groups);
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error(JSON.stringify(result));
  return result;
}
function read(capability: string, payload: unknown = { action: 'get_project', projectKey: 'alpha' }, from = folder) {
  const fields = { type: 'memory_state' as const, request_id: randomUUID(), payload };
  return handleMemoryStateRequest({ ...fields, ...authorizeMemoryStateRequest(capability, fields) }, from);
}
function taskGrant(envelope: Record<string, unknown>, allow = true) {
  const capability = registerTaskAuthorizationCapability({ groupFolder: folder, isMain: true,
    credentialProxyTier: 'owner', senderIdentity: creator, homogeneousOwnerBatch: true,
    allowMemoryProjectBinding: allow })!;
  return authorizeTaskOperationRequest(signedTaskAuthorizationRequestForTest(capability, envelope, randomUUID()), folder);
}
function ipcDeps() {
  return { registeredGroups: () => groups, calendarAdapter: null,
    router: { route: vi.fn(), send: vi.fn() } } as any;
}
beforeEach(() => {
  vi.stubEnv('OWNER_TELEGRAM_USER_IDS', '101');
  vi.stubEnv('SKOOBI_GOOGLE_OWNER_TELEGRAM_USER_IDS', '101');
  _initTestDatabase();
  ensureMemoryStateSchema(getDb());
  sourceTime = new Date().toISOString();
  groups = { [jid]: { name: 'Fixture', folder, isMain: true, runtime: 'container',
    trigger: '@test', added_at: sourceTime } };
  creator = createTelegramSenderIdentity({ chatId: '101', fromId: '101', ownerAllowlist: loadOwnerAllowlistFromEnv() });
  creator.telegram_message_origin = 'direct';
  scope = { chatJid: jid, identityId: creator.identity_id,
    tenantId: TenantRegistry.fromRegisteredGroups(groups).resolveTelegramJid(jid)!.tenant_id };
  project('alpha', 'Alpha work only');
  project('beta', 'Unrelated private project');
  createTask({ id: 'scheduled-memory-task', group_folder: folder, chat_jid: jid,
    prompt: 'Review alpha criteria without changing the project.', schedule_type: 'interval',
    schedule_value: '3600000', context_mode: 'isolated', status: 'active',
    next_run: sourceTime, created_at: sourceTime, creator_authorization: 'owner_sender',
    creator_identity_id: creator.identity_id, creator_sender_id: '101' });
  task = getTaskById('scheduled-memory-task')!;
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks();
  _clearMemoryWriteCapabilities(); _clearTaskAuthorizationState();
});

describe('scheduled project memory is a revocable read grant, never a direct-user write', () => {
  it('reads only the explicitly bound project, even without current direct messages', () => {
    bind(); const { capability, context } = grant();
    expect(context).toContain('Verify ordinary controls');
    expect(context).not.toContain('Unrelated private project');
    expect(read(capability)).toMatchObject({ ok: true, data: { project: { projectKey: 'alpha' } } });
    for (const payload of [{ action: 'list' }, { action: 'list', projectKey: null },
      { action: 'get_project', projectKey: 'beta' }, { action: 'compare_projects', projectKeys: ['alpha', 'beta'] }])
      expect(read(capability, payload).ok).toBe(false);
    expect(read(capability, undefined, 'another-group')).toMatchObject({ ok: false, error: 'capability_group_mismatch' });
    const result = read(capability, { action: 'list', projectKey: 'alpha' });
    expect(JSON.stringify(result)).not.toContain('beta');
  });

  it('redacts other project keys from every project-bound read without changing stored links', () => {
    const db = getDb();
    for (const key of ['beta', 'alpha']) {
      const original = getMemoryProject(db, scope, key)!.project;
      mutateMemoryState(db, scope, {
        kind: 'project_upsert', projectKey: key, operationId: randomUUID(), expectedRevision: original.revision,
        card: key === 'alpha'
          ? { ...original.card, relatedProjectKeys: ['beta'] }
          : { ...original.card, status: 'cancelled' },
      }, { kind: 'direct_user', at: new Date().toISOString(), messageId: randomUUID(),
        quote: key === 'alpha' ? 'Свяжи проект alpha с проектом beta' : 'Fixture project update',
        ...(key === 'alpha' ? ownerReadNameSource(db,scope,randomUUID(),new Date().toISOString(),'Свяжи проект alpha с проектом beta') : {}), currentDirectInput: true });
    }
    bind();
    const { capability, context } = grant();
    expect(context).toContain('Alpha work only');
    expect(context).not.toMatch(/beta|Unrelated private project|relatedProjectKeys/);
    for (const action of ['list', 'get_project', 'search']) {
      const payload = { action, projectKey: 'alpha', ...(action === 'search' ? { query: 'ordinary' } : {}) };
      const result = read(capability, payload);
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result.data)).toContain('alpha');
      expect(JSON.stringify(result.data)).not.toMatch(/beta|Unrelated private project|relatedProjectKeys/);
    }
    expect(read(capability, { action: 'search', query: 'beta', projectKey: 'alpha' }))
      .toMatchObject({ ok: true, data: { results: [] } });
    expect(getMemoryProject(db, scope, 'alpha')!.project.card.relatedProjectKeys).toEqual(['beta']);
  });

  it('searches only inside the bound project', () => {
    bind(); const { capability } = grant();
    const found = read(capability, { action: 'search', query: 'private ordinary', projectKey: 'alpha' });
    expect(found).toMatchObject({ ok: true, data: { results: [{ projectKey: 'alpha' }] } });
    expect(JSON.stringify(found)).not.toContain('beta');
    for (const payload of [{ action: 'search', query: 'private' },
      { action: 'search', query: 'private', projectKey: null },
      { action: 'search', query: 'private', projectKey: 'beta' }])
      expect(read(capability, payload).ok).toBe(false);
  });

  // The runner quarantines every read of a scheduled run on scheduled_memory_*:
  // a blank query or a bad cursor must not look like a revoked scope.
  it('answers a caller mistake with its own error, not as a revoked scope', () => {
    bind(); const { capability } = grant();
    expect(read(capability, { action: 'search', query: '   ', projectKey: 'alpha' }))
      .toMatchObject({ ok: false, error: 'invalid_memory_state_payload' });
    expect(read(capability, { action: 'list', projectKey: 'alpha', cursor: 'not-a-cursor' }))
      .toMatchObject({ ok: false, error: 'invalid_cursor' });
    expect(read(capability, { action: 'search', query: '  ordinary  ', projectKey: 'alpha' }))
      .toMatchObject({ ok: true, data: { results: [{ projectKey: 'alpha' }] } });
    expect(read(capability)).toMatchObject({ ok: true });
  });

  it('rejects both structured mutations and legacy signing with the read token', () => {
    bind(); const { capability } = grant();
    expect(read(capability, { action: 'operation_status', operationId: 'scheduled-probe' }))
      .toMatchObject({ ok: false, error: 'scheduled_memory_read_only' });
    expect(read(capability, { action: 'mutate', operation: {} })).toMatchObject({ ok: false, error: 'scheduled_memory_read_only' });
    const fields = { type: 'memory_sign' as const, request_id: randomUUID(), content: 'Attempted write', category: 'daily' as const };
    expect(signMemoryWriteRequest({ ...fields, ...authorizeMemorySigningRequest(capability, fields) }, folder).ok).toBe(false);
  });

  it('expires and explicitly revokes the run token', () => {
    bind(); const { capability } = grant();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 2 * 60 * 60_000 + 1);
    expect(read(capability)).toMatchObject({ ok: false, error: 'invalid_or_expired_capability' });
    vi.useRealTimers();
    const next = grant(); revokeMemoryReadCapability(next.capability);
    expect(read(next.capability).ok).toBe(false);
  });

  it.each(['paused', 'cancelled'] as const)('revokes a running grant when the task becomes %s', status => {
    bind(); const { capability } = grant(); updateTask(task.id, { status });
    expect(read(capability)).toMatchObject({ ok: false, error: 'scheduled_memory_task_changed_or_revoked' });
  });

  it('does not revive an old token after unbind and rebind to the same project', () => {
    bind(); const first = grant(); bind(null); bind();
    expect(read(first.capability)).toMatchObject({ ok: false, error: 'scheduled_memory_task_changed_or_revoked' });
    expect(read(grant().capability).ok).toBe(true);
  });

  it('invalidates the binding after task edits and requires explicit rebinding', () => {
    bind(); const old = grant(); updateTask(task.id, { prompt: 'Changed task' });
    expect(read(old.capability).ok).toBe(false);
    expect(prepareScheduledMemoryRead(getDb(), getTaskById(task.id)!, () => groups).status).toBe('unavailable');
    bind(); expect(read(grant().capability).ok).toBe(true);
  });

  it('checks owner revocation on every request, not only at launch', () => {
    bind(); const old = grant(); vi.stubEnv('OWNER_TELEGRAM_USER_IDS', '202');
    expect(read(old.capability)).toMatchObject({ ok: false, error: 'scheduled_memory_owner_scope_revoked' });
  });

  it('invalidates a snapshot after a project fact changes, not just its card', () => {
    bind(); const old = grant();
    mutateMemoryState(getDb(), scope, { kind: 'fact_upsert', projectKey: 'alpha', key: 'correction',
      value: 'New current correction', factType: 'decision', operationId: randomUUID(), expectedRevision: 0 },
    { kind: 'direct_user', at: sourceTime, messageId: randomUUID(), quote: 'New current correction', currentDirectInput: true });
    expect(read(old.capability)).toMatchObject({ ok: false, error: 'scheduled_memory_project_revision_changed' });
    expect(grant().context).toContain('New current correction');
  });

  it('leaves legacy tasks unbound without inferring permission from prompt or active focus', () => {
    expect(prepareScheduledMemoryRead(getDb(), task, () => groups)).toEqual({ status: 'unbound', context: '' });
    expect(getDb().prepare("SELECT 1 FROM sqlite_master WHERE name='memory_task_read_bindings'").get()).toBeUndefined();
  });

  it('binds through the actual authenticated schedule/update host path and denies field tampering', async () => {
    const envelope = { type: 'schedule_task', taskId: 'new-task', targetJid: jid,
      prompt: 'Read alpha', schedule_type: 'interval', schedule_value: '3600000',
      context_mode: 'isolated', calendar_event: false, memory_project_key: 'alpha' };
    expect(taskGrant(envelope, false)).toMatchObject({ ok: false, error: 'direct_owner_memory_binding_required' });
    const authorization = taskGrant(envelope); expect(authorization.ok).toBe(true);
    await processTaskIpc({ ...envelope, memory_project_key: 'beta', ownerAuthorizationGrant: authorization.grant } as any, folder, true, ipcDeps());
    expect(getTaskById('new-task')).toBeUndefined();
    await processTaskIpc({ ...envelope, ownerAuthorizationGrant: taskGrant(envelope).grant } as any, folder, true, ipcDeps());
    const created = getTaskById('new-task')!;
    expect(prepareScheduledMemoryRead(getDb(), created, () => groups).status).toBe('ready');
    const update = { type: 'update_task', taskId: 'new-task', memory_project_key: null };
    await processTaskIpc({ ...update, ownerAuthorizationGrant: taskGrant(update).grant }, folder, true, ipcDeps());
    expect(prepareScheduledMemoryRead(getDb(), created, () => groups).status).toBe('unbound');
  });

  it('uses the real scheduler path, supplies no write token and revokes on exit', async () => {
    bind(); let receivedToken = '';
    runners.container.mockImplementation(async (_group, input) => {
      expect(input.memoryWriteCapability).toBeUndefined();
      expect(input.isScheduledTask).toBe(true);
      expect(input.prompt).toContain('Verify ordinary controls');
      receivedToken = input.memoryReadCapability;
      expect(read(receivedToken).ok).toBe(true);
      return { status: 'success', result: null };
    });
    await runTask(task, { registeredGroups: () => groups, getSessions: () => ({}), onProcess: () => {},
      queue: { noteRunActivity: vi.fn(), notifyIdle: vi.fn(), closeStdin: vi.fn() },
      router: { route: vi.fn(async () => undefined), send: vi.fn() } } as any);
    expect(runners.container).toHaveBeenCalledOnce();
    expect(read(receivedToken).ok).toBe(false);
  });

  it('fails a declared stale memory prerequisite before invoking an agent', async () => {
    bind(); updateTask(task.id, { prompt: 'Changed without re-binding memory' });
    await runTask(getTaskById(task.id)!, { registeredGroups: () => groups,
      getSessions: () => ({}), onProcess: () => {},
      queue: { noteRunActivity: vi.fn(), notifyIdle: vi.fn(), closeStdin: vi.fn() },
      router: { route: vi.fn(async () => undefined), send: vi.fn() } } as any);
    expect(runners.container).not.toHaveBeenCalled();
    expect(runners.sandbox).not.toHaveBeenCalled();
    const log = getDb().prepare('SELECT error FROM task_run_logs WHERE task_id=?').get(task.id) as { error: string };
    expect(log.error).toContain('memory_project_key');
    expect(log.error).toContain('no model work was started');
  });

  it('does not replace a memory-dependent result with a tool-less fallback', async () => {
    bind(); vi.stubEnv('SKOOBI_CODEX_RESERVE_FALLBACK_ENABLED', 'true');
    runners.container.mockImplementation(async (_group, _input, _process, onOutput) => {
      await onOutput({ status: 'success', result: "You've hit your usage limit" });
      return { status: 'success', result: null };
    });
    const route = vi.fn(async () => undefined);
    await runTask(task, { registeredGroups: () => groups, getSessions: () => ({}), onProcess: () => {},
      queue: { noteRunActivity: vi.fn(), notifyIdle: vi.fn(), closeStdin: vi.fn() },
      router: { route, send: vi.fn() } } as any);
    expect(runners.reserve).not.toHaveBeenCalled();
    const log = getDb().prepare('SELECT error FROM task_run_logs WHERE task_id=?').get(task.id) as { error: string };
    expect(log.error).toContain('tool-less reserve was not used');
  });
});
