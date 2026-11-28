import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  FactoryConfiguration,
  FactoryProject,
} from './game-factory-contracts.js';
import type {
  FactoryLegacyBinding,
  FactoryLegacyNoticeRoute,
} from './game-factory-legacy.js';
import {
  ensureGameFactorySchema,
  factoryActorKey,
} from './game-factory-store.js';
import {
  createGameFactoryLegacyNoticePump,
  type FactoryLegacyNoticeDependencies,
  type FactoryLegacyNotice,
} from './game-factory-legacy-notices.js';

let root: string,
  db: Database.Database,
  config: FactoryConfiguration,
  binding: FactoryLegacyBinding,
  project: FactoryProject,
  deps: FactoryLegacyNoticeDependencies;
const route: FactoryLegacyNoticeRoute = {
  chatJid: 'tg:fixture-private',
  groupFolder: 'fixture-main',
  tenantId: 'fixture-tenant',
  identityId: 'fixture-owner',
  channelChatId: 'fixture-private',
  senderId: 'fixture-owner-sender',
};
const writeConfig = () =>
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config), {
    mode: 0o600,
  });
const persist = () => {
  db.prepare('UPDATE factory_projects SET document_json=? WHERE id=?').run(
    JSON.stringify(project),
    project.id,
  );
  db.prepare(
    'UPDATE factory_legacy_bindings SET binding_json=? WHERE job_id=?',
  ).run(JSON.stringify(binding), binding.jobId);
};
const notice = (): FactoryLegacyNotice | null =>
  JSON.parse(
    (
      db
        .prepare(
          'SELECT notice_json FROM factory_legacy_bindings WHERE job_id=?',
        )
        .get(binding.jobId) as { notice_json: string | null }
    ).notice_json || 'null',
  );
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-notices-')),
  );
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(path.join(root, 'games'), { mode: 0o700 });
  config = {
    version: 1,
    enabled: true,
    databasePath: path.join(root, 'factory.db'),
    workspaceRoot: path.join(root, 'games'),
    actors: [
      {
        identityId: route.identityId,
        tenantId: route.tenantId,
        alias: 'owner',
        canCreate: true,
        backends: ['legacy'],
        sourceRoots: [],
      },
    ],
  };
  db = new Database(config.databasePath);
  fs.chmodSync(config.databasePath, 0o600);
  ensureGameFactorySchema(db);
  const actorKey = factoryActorKey(route),
    at = new Date().toISOString(),
    jobId = randomUUID();
  binding = {
    jobId,
    projectId: 'fixture-game',
    taskId: 'task',
    actorKey,
    actor: { identityId: route.identityId, tenantId: route.tenantId },
    briefRevision: 1,
    fencing: 1,
    requirementsSha256: 'a'.repeat(64),
    configurationSha256: 'b'.repeat(64),
    createdAt: at,
    route: { ...route },
    request: {
      request_id: `factory:${jobId}`,
      brief: 'private model prose must never be sent',
      engine: 'canvas',
      timeout_seconds: 1200,
      music: false,
    },
  };
  project = {
    id: binding.projectId,
    title: 'Friendly dragon',
    engine: 'canvas',
    ownerKey: actorKey,
    revision: 1,
    status: 'active',
    workspace: path.join(root, 'games', binding.projectId),
    createdAt: at,
    updatedAt: at,
    brief: {
      revision: 1,
      goal: 'One rescue',
      audience: 'New players',
      firstSession: 'One rescue',
      coreLoop: 'Fly and help',
      artDirection: 'Cartoon',
      acceptance: ['A local mission'],
      devices: ['desktop'],
      platforms: ['local'],
      exclusions: [],
      budget: { currency: 'USD', limitMicros: 0 },
      publication: 'prepare_only',
      source: {
        actorKey,
        messageIds: ['private-source'],
        at,
        trust: 'agent_interpreted',
      },
    },
    briefHistory: [],
    decisions: [],
    taskHistory: [],
    builds: [],
    evidence: [],
    releases: [],
    assets: [],
    fencing: 1,
    lease: null,
    tasks: [
      {
        id: 'task',
        stage: 'playable',
        title: 'Mission',
        state: 'working',
        acceptance: ['Rescue'],
        dependencies: [],
        briefRevision: 1,
        operationIds: ['op'],
      },
    ],
    operations: [
      {
        id: 'op',
        kind: 'legacy',
        externalId: jobId,
        taskId: 'task',
        briefRevision: 1,
        state: 'completed',
        evidence: 'host_observed',
        tracking: 'execution',
        observedAt: at,
        detail: JSON.stringify({
          jobId,
          state: 'review_ready',
          operationState: 'completed',
          scopeComplete: true,
          requirementsCurrent: true,
          cancellationRequested: false,
          requiresHumanReview: true,
          observedAt: at,
        }),
      },
    ],
  };
  db.prepare('INSERT INTO factory_projects VALUES(?,?,?,?)').run(
    project.id,
    1,
    JSON.stringify(project),
    at,
  );
  db.prepare('INSERT INTO factory_members VALUES(?,?,?)').run(
    project.id,
    actorKey,
    'owner',
  );
  db.prepare(
    'INSERT INTO factory_legacy_bindings(job_id,project_id,actor_key,binding_json,updated_at) VALUES(?,?,?,?,?)',
  ).run(jobId, project.id, actorKey, JSON.stringify(binding), at);
  deps = {
    router: { route: vi.fn(async (envelope) => envelope.text) },
    groups: () => ({
      [route.chatJid]: {
        name: 'Fixture',
        folder: route.groupFolder,
        isMain: true,
        trigger: 'x',
        added_at: at,
      },
    }),
    routeAllowed: vi.fn(() => true),
    connected: vi.fn(() => true),
    deliveryTimeoutMs: 30,
  };
  writeConfig();
  vi.stubEnv('SKOOBI_GAME_FACTORY_CONFIG', path.join(root, 'config.json'));
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('claims before sending one factual inactive-chat notice and stores a truthful router ACK receipt', async () => {
  const before = JSON.stringify(project);
  deps.router.route = vi.fn(async (envelope) => {
    expect(notice()?.state).toBe('sending');
    expect(envelope).toMatchObject({
      chatJid: route.chatJid,
      groupFolder: route.groupFolder,
      triggerType: 'task-result',
      meta: { suppressCursorAdvance: true },
    });
    expect(envelope.text).toContain('кандидат прототипа');
    expect(envelope.text).toContain('Friendly dragon');
    expect(envelope.text).not.toMatch(
      /private|fixture-owner|request_id|sqlite|\/private\/|принята|опубликована/,
    );
    return envelope.text;
  });
  const tick = createGameFactoryLegacyNoticePump(deps);
  expect(await tick()).toMatchObject({ state: 'sent' });
  expect(notice()?.receipt).toMatchObject({
    kind: 'router_ack',
    id: notice()?.attemptId,
  });
  expect(notice()?.receipt?.textSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await tick()).toEqual({ processed: false });
  expect(deps.router.route).toHaveBeenCalledTimes(1);
  expect(
    (
      db.prepare('SELECT document_json FROM factory_projects').get() as {
        document_json: string;
      }
    ).document_json,
  ).toBe(before);
});

it('leaves disconnected delivery pending without an attempt and sends only after connection returns', async () => {
  deps.connected = vi.fn(() => false);
  const tick = createGameFactoryLegacyNoticePump(deps);
  expect(await tick()).toMatchObject({
    state: 'pending',
    reason: 'channel_disconnected',
  });
  expect(notice()?.attemptId).toBeUndefined();
  expect(deps.router.route).not.toHaveBeenCalled();
  deps.connected = () => true;
  expect(await tick()).toMatchObject({ state: 'sent' });
  expect(deps.router.route).toHaveBeenCalledTimes(1);
});

it.each(['throw', 'timeout'] as const)(
  'records unknown after %s and never blindly resends',
  async (mode) => {
    deps.router.route = vi.fn(() =>
      mode === 'throw'
        ? Promise.reject(new Error('Private transport error'))
        : new Promise<string | null>(() => {}),
    );
    const tick = createGameFactoryLegacyNoticePump(deps);
    expect(await tick()).toMatchObject({ state: 'unknown' });
    expect(notice()?.reason).toBe('acknowledgement_unknown');
    expect(JSON.stringify(notice())).not.toContain('Private transport error');
    expect(await tick()).toEqual({ processed: false });
    expect(deps.router.route).toHaveBeenCalledTimes(1);
  },
);

it('recovers a crash-after-claim as unknown rather than a second delivery', async () => {
  db.prepare('UPDATE factory_legacy_bindings SET notice_json=?').run(
    JSON.stringify({
      state: 'sending',
      attemptId: randomUUID(),
      updatedAt: new Date().toISOString(),
    }),
  );
  expect(await createGameFactoryLegacyNoticePump(deps)()).toEqual({
    processed: false,
  });
  expect(notice()).toMatchObject({
    state: 'unknown',
    reason: 'interrupted_delivery',
  });
  expect(deps.router.route).not.toHaveBeenCalled();
});

it.each([
  'backend',
  'membership',
  'group',
  'identity',
  'tenant',
  'inbound_only',
] as const)('suppresses revoked %s without an owner fallback', async (kind) => {
  if (kind === 'backend') {
    config.actors[0].backends = ['agent'];
    writeConfig();
  }
  if (kind === 'membership') db.prepare('DELETE FROM factory_members').run();
  if (kind === 'group')
    deps.groups = () => ({
      [route.chatJid]: {
        name: 'Different',
        folder: 'different-main',
        isMain: true,
        trigger: 'x',
        added_at: '',
      },
    });
  if (kind === 'identity') deps.routeAllowed = () => false;
  if (kind === 'tenant') {
    binding.route!.tenantId = 'foreign-tenant';
    persist();
  }
  if (kind === 'inbound_only')
    deps.groups = () => ({
      [route.chatJid]: {
        name: 'Fixture',
        folder: route.groupFolder,
        isMain: true,
        trigger: 'x',
        added_at: '',
        agentConfig: { inboundOnly: true },
      },
    });
  expect(await createGameFactoryLegacyNoticePump(deps)()).toMatchObject({
    state: 'suppressed',
  });
  expect(deps.router.route).not.toHaveBeenCalled();
});

it('does not infer historical routes or treat reported references as terminal execution evidence', async () => {
  delete binding.route;
  persist();
  expect(await createGameFactoryLegacyNoticePump(deps)()).toMatchObject({
    state: 'unavailable',
    reason: 'historical_route_missing',
  });
  expect(deps.router.route).not.toHaveBeenCalled();
  db.prepare('UPDATE factory_legacy_bindings SET notice_json=NULL').run();
  binding.route = route;
  project.operations[0].evidence = 'reported';
  persist();
  expect(await createGameFactoryLegacyNoticePump(deps)()).toEqual({
    processed: false,
  });
});

it('rechecks host identity after claiming and never sends if the recipient changed', async () => {
  let checks = 0;
  deps.routeAllowed = () => ++checks < 3;
  expect(await createGameFactoryLegacyNoticePump(deps)()).toMatchObject({
    state: 'suppressed',
  });
  expect(deps.router.route).not.toHaveBeenCalled();
});

it.each(['cancelled', 'failed'] as const)(
  'uses distinct host facts for %s without raw provider prose',
  async (state) => {
    project.operations[0].state = 'failed';
    project.operations[0].detail = JSON.stringify({
      jobId: binding.jobId,
      operationState: 'failed',
      state,
      scopeComplete: false,
      error: 'PRIVATE provider error',
    });
    persist();
    await createGameFactoryLegacyNoticePump(deps)();
    const envelope = vi.mocked(deps.router.route).mock.calls[0][0];
    expect(envelope.text).toContain(
      state === 'cancelled' ? 'отменено' : 'с ошибкой',
    );
    expect(envelope.text).not.toContain('PRIVATE');
  },
);

it('allows a proven router non-delivery to remain pending without claiming success', async () => {
  deps.router.route = vi.fn(async () => null);
  const tick = createGameFactoryLegacyNoticePump(deps);
  expect(await tick()).toMatchObject({ state: 'pending' });
  expect(notice()?.receipt).toBeUndefined();
  deps.router.route = vi.fn(async (e) => e.text);
  expect(await tick()).toMatchObject({ state: 'sent' });
});
