import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  FactoryActor,
  FactoryConfiguration,
  FactoryProject,
} from './game-factory-contracts.js';
import type { FactoryLegacyObservation } from './game-factory-legacy.js';
import {
  ensureGameFactorySchema,
  factoryActorKey,
} from './game-factory-store.js';
import { runGameFactoryMaintenanceTick } from './game-factory-maintenance.js';

const actor: FactoryActor = {
  identityId: 'current-project-owner',
  tenantId: 'fixture-tenant',
  chatJid: 'not-used',
  sourceGroup: 'not-used',
  senderId: 'not-used',
  runId: 'not-used',
  currentMessageIds: [],
};
let root: string,
  db: Database.Database,
  config: FactoryConfiguration,
  jobId: string,
  project: FactoryProject;
const writeConfig = () =>
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config), {
    mode: 0o600,
  });
const read = () =>
  JSON.parse(
    (
      db
        .prepare('SELECT document_json FROM factory_projects WHERE id=?')
        .get(project.id) as { document_json: string }
    ).document_json,
  ) as FactoryProject;
const observed = (
  state: FactoryLegacyObservation['operationState'] = 'running',
): FactoryLegacyObservation => ({
  jobId,
  state: state === 'completed' ? 'review_ready' : 'generating',
  operationState: state,
  scopeComplete: state === 'completed',
  requirementsCurrent: false,
  cancellationRequested: false,
  requiresHumanReview: true,
  observedAt: new Date().toISOString(),
});
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-maintenance-')),
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
        identityId: actor.identityId,
        tenantId: actor.tenantId,
        alias: 'current',
        canCreate: true,
        backends: ['legacy'],
        sourceRoots: [],
      },
    ],
    legacy: { configurationPath: path.join(root, 'legacy.json') },
  };
  db = new Database(config.databasePath);
  fs.chmodSync(config.databasePath, 0o600);
  ensureGameFactorySchema(db);
  jobId = randomUUID();
  project = {
    id: 'shared-game',
    revision: 1,
    status: 'paused',
    title: 'Scoped project',
    engine: 'canvas',
    ownerKey: factoryActorKey(actor),
    workspace: path.join(root, 'games', 'shared-game'),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    brief: {
      revision: 1,
      goal: 'A local mission',
      audience: 'New players',
      firstSession: 'One rescue',
      coreLoop: 'Fly and help',
      artDirection: 'Friendly cartoon',
      acceptance: ['Complete one mission'],
      devices: ['desktop'],
      platforms: ['local'],
      exclusions: ['Paid generation'],
      budget: { currency: 'USD', limitMicros: 0 },
      publication: 'prepare_only',
      source: {
        actorKey: factoryActorKey(actor),
        messageIds: ['fixture-message'],
        at: '2026-01-01T00:00:00Z',
        trust: 'agent_interpreted',
      },
    },
    briefHistory: [],
    decisions: [],
    taskHistory: [],
    builds: [],
    releases: [],
    assets: [],
    fencing: 1,
    tasks: [
      {
        id: 'task',
        state: 'working',
        stage: 'playable',
        title: 'Local mission',
        acceptance: ['One rescue'],
        dependencies: [],
        briefRevision: 1,
        operationIds: ['operation'],
      },
    ],
    lease: {
      token: 'unchanged',
      fencing: 1,
      actorKey: factoryActorKey(actor),
      runId: 'former-run',
      taskId: 'task',
      backend: 'legacy',
      briefRevision: 1,
      acquiredAt: '2026-01-01T00:00:00Z',
      heartbeatAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-01T01:00:00Z',
      state: 'reconcile_required',
      workDirectory: path.join(root, 'games', 'shared-game'),
    },
    evidence: [],
    operations: [
      {
        id: 'operation',
        kind: 'legacy',
        externalId: jobId,
        taskId: 'task',
        briefRevision: 1,
        state: 'unknown',
        evidence: 'host_observed',
        tracking: 'execution',
        observedAt: '2026-01-01T00:00:00Z',
      },
    ],
  };
  db.prepare('INSERT INTO factory_projects VALUES(?,?,?,?)').run(
    project.id,
    1,
    JSON.stringify(project),
    project.updatedAt,
  );
  db.prepare('INSERT INTO factory_members VALUES(?,?,?)').run(
    project.id,
    factoryActorKey(actor),
    'owner',
  );
  // Старый инициатор отозван. Доступ остаётся только у явно включённого текущего project owner.
  db.prepare(
    'INSERT INTO factory_legacy_bindings(job_id,project_id,actor_key,binding_json,updated_at) VALUES(?,?,?,?,?)',
  ).run(jobId, project.id, 'revoked-origin', '{}', project.updatedAt);
  writeConfig();
  vi.stubEnv('SKOOBI_GAME_FACTORY_CONFIG', path.join(root, 'config.json'));
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('reconciles one scoped execution after origin revocation without accepting tasks or releasing lease', async () => {
  const observe = vi.fn(async () => observed('completed')),
    cancel = vi.fn();
  const result = await runGameFactoryMaintenanceTick({ observe, cancel });
  expect(observe).toHaveBeenCalledWith(
    expect.objectContaining({
      identityId: actor.identityId,
      currentMessageIds: [],
      chatJid: '',
    }),
    jobId,
  );
  expect(cancel).not.toHaveBeenCalled();
  expect(result.changed).toEqual([
    expect.objectContaining({
      projectId: project.id,
      jobId,
      state: 'completed',
      requirementsCurrent: false,
    }),
  ]);
  const after = read();
  expect(after.operations[0].state).toBe('completed');
  expect(after.tasks).toEqual(project.tasks);
  expect(after.lease).toEqual(project.lease);
  expect(after.evidence).toEqual([]);
  expect(db.prepare('SELECT action FROM factory_events').get()).toEqual({
    action: 'legacy_maintenance',
  });
  expect(await runGameFactoryMaintenanceTick({ observe })).toEqual({
    processed: false,
    changed: [],
  });
  expect(observe).toHaveBeenCalledTimes(1);
});

it('retries cancellation only from the durable tombstone and preserves unknown if stop is not proved', async () => {
  db.prepare('UPDATE factory_legacy_bindings SET cancel_requested=1').run();
  const observe = vi.fn(),
    cancel = vi.fn(async () => ({
      ...observed('unknown'),
      state: 'not_submitted' as const,
      cancellationRequested: true,
    }));
  const result = await runGameFactoryMaintenanceTick({ observe, cancel });
  expect(observe).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(result.changed[0].state).toBe('unknown');
  expect(read().tasks[0].state).toBe('working');
  expect(read().lease).toEqual(project.lease);
});

it('does not overwrite a concurrent brief/project mutation with a stale provider observation', async () => {
  const observe = async () => {
    project.revision = 2;
    project.title = 'User correction';
    db.prepare(
      'UPDATE factory_projects SET revision=2,document_json=? WHERE id=?',
    ).run(JSON.stringify(project), project.id);
    return observed('completed');
  };
  expect(await runGameFactoryMaintenanceTick({ observe })).toMatchObject({
    processed: true,
    changed: [],
    skipped: 'revision_changed',
  });
  expect(read().title).toBe('User correction');
  expect(read().operations[0].state).toBe('unknown');
  expect(db.prepare('SELECT count(*) n FROM factory_events').get()).toEqual({
    n: 0,
  });
});

it('rechecks project authority after asynchronous provider I/O', async () => {
  const observe = async () => {
    config.actors = [];
    writeConfig();
    return observed('completed');
  };
  expect(await runGameFactoryMaintenanceTick({ observe })).toMatchObject({
    skipped: 'authority_changed',
    changed: [],
  });
  expect(read().operations[0].state).toBe('unknown');
});

it('produces no repeated event or revision for an unchanged status timestamp', async () => {
  const observe = vi.fn(async () => observed());
  expect(
    (await runGameFactoryMaintenanceTick({ observe })).changed,
  ).toHaveLength(1);
  const revision = read().revision;
  expect(
    (await runGameFactoryMaintenanceTick({ observe })).changed,
  ).toHaveLength(0);
  expect(read().revision).toBe(revision);
  expect(db.prepare('SELECT count(*) n FROM factory_events').get()).toEqual({
    n: 1,
  });
});

it('bounds work to one execution and rejects overlapping ticks without starting another task', async () => {
  let finish!: (value: FactoryLegacyObservation) => void;
  const observe = vi.fn(
    () =>
      new Promise<FactoryLegacyObservation>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = runGameFactoryMaintenanceTick({ observe });
  expect(await runGameFactoryMaintenanceTick({ observe })).toEqual({
    processed: false,
    changed: [],
    skipped: 'busy',
  });
  finish(observed());
  await pending;
  expect(observe).toHaveBeenCalledTimes(1);
});

it('does not contact the provider for readers, missing members, or disabled module', async () => {
  const observe = vi.fn();
  db.prepare("UPDATE factory_members SET role='reader'").run();
  expect(await runGameFactoryMaintenanceTick({ observe })).toMatchObject({
    skipped: 'no_authorized_member',
  });
  config.enabled = false;
  writeConfig();
  expect(await runGameFactoryMaintenanceTick({ observe })).toMatchObject({
    skipped: 'disabled',
  });
  expect(observe).not.toHaveBeenCalled();
});

it('rotates observed bindings instead of letting a running or broken job starve later jobs', async () => {
  const secondId = randomUUID();
  project.operations.push({
    ...project.operations[0],
    id: 'second-operation',
    externalId: secondId,
  });
  db.prepare('UPDATE factory_projects SET document_json=? WHERE id=?').run(
    JSON.stringify(project),
    project.id,
  );
  db.prepare(
    'INSERT INTO factory_legacy_bindings(job_id,project_id,actor_key,binding_json,updated_at) VALUES(?,?,?,?,?)',
  ).run(secondId, project.id, 'revoked-origin', '{}', project.updatedAt);
  const visited: string[] = [];
  const observe = async (_actor: FactoryActor, id: string) => {
    visited.push(id);
    throw new Error('Synthetic provider failure');
  };
  await runGameFactoryMaintenanceTick({ observe });
  await runGameFactoryMaintenanceTick({ observe });
  expect(new Set(visited)).toEqual(new Set([jobId, secondId]));
  expect(visited).toHaveLength(2);
});
