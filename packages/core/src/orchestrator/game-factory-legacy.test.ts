import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FactoryActor,
  FactoryConfiguration,
  FactoryProject,
} from './game-factory-contracts.js';
import {
  ensureGameFactorySchema,
  factoryActorKey,
} from './game-factory-store.js';
import {
  bindGameFactoryLegacyJob,
  readFactoryLegacyBinding,
  readFactoryLegacyConfiguration,
  submitPersistedGameFactoryLegacyJob,
  observePersistedGameFactoryLegacyJob,
  cancelPersistedGameFactoryLegacyJob,
  inspectPersistedGameFactoryLegacySource,
} from './game-factory-legacy.js';
import { runGameFactoryMaintenanceTick } from './game-factory-maintenance.js';

const sourceRoot = process.env.SKOOBI_TEST_LEGACY_FACTORY_ROOT;
const python = ['/opt/homebrew/bin/python3', '/usr/bin/python3'].find((p) =>
  fs.existsSync(p),
);
const actor: FactoryActor = {
  identityId: 'fixture-owner-private',
  tenantId: 'fixture-tenant',
  chatJid: 'tg:fixture-private',
  sourceGroup: 'fixture-main',
  senderId: 'fixture-sender-private',
  runId: 'fixture-run',
  currentMessageIds: ['private-message'],
};
let root: string,
  db: Database.Database,
  config: FactoryConfiguration,
  project: FactoryProject,
  jobId: string,
  legacyConfig: string,
  state: string;
const now = '2026-11-04T00:00:00.000Z';
const persist = () =>
  db
    .prepare('UPDATE factory_projects SET document_json=? WHERE id=?')
    .run(JSON.stringify(project), project.id);
const writeConfig = () =>
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config), {
    mode: 0o600,
  });
const bind = () =>
  db
    .transaction(() =>
      bindGameFactoryLegacyJob({
        db,
        config,
        actor,
        project,
        task: project.tasks[0],
        jobId,
        createdAt: now,
      }),
    )
    .immediate();
const providerDb = () => new Database(path.join(state, 'queue.sqlite3'));
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-legacy-')),
  );
  fs.chmodSync(root, 0o700);
  for (const d of ['games', 'code', 'legacy-state'])
    fs.mkdirSync(path.join(root, d), { mode: 0o700 });
  state = path.join(root, 'legacy-state');
  legacyConfig = path.join(root, 'legacy.json');
  jobId = randomUUID();
  const script = path.join(root, 'code', 'factory.py');
  if (sourceRoot)
    for (const name of ['factory.py', 'managed_runtime.py'])
      fs.copyFileSync(
        path.join(sourceRoot, name),
        path.join(root, 'code', name),
      );
  else
    fs.writeFileSync(
      script,
      'raise RuntimeError("No worker calls in structural fixtures")\n',
      { mode: 0o600 },
    );
  fs.writeFileSync(
    legacyConfig,
    JSON.stringify({
      version: 1,
      pythonExecutable: fs.realpathSync(python || process.execPath),
      factoryScript: script,
      stateDirectory: state,
    }),
    { mode: 0o600 },
  );
  config = {
    version: 1,
    enabled: true,
    workspaceRoot: path.join(root, 'games'),
    databasePath: path.join(root, 'factory.db'),
    actors: [
      {
        identityId: actor.identityId,
        tenantId: actor.tenantId,
        alias: 'owner',
        canCreate: true,
        backends: ['legacy'],
        sourceRoots: [root],
      },
    ],
    legacy: { configurationPath: legacyConfig },
  };
  const key = factoryActorKey(actor),
    source = {
      actorKey: key,
      messageIds: ['private-message'],
      at: now,
      trust: 'agent_interpreted' as const,
    };
  project = {
    id: 'fixture-game',
    title: 'Friendly dragon',
    engine: 'canvas',
    ownerKey: key,
    revision: 1,
    status: 'active',
    workspace: path.join(root, 'games', 'fixture-game'),
    createdAt: now,
    updatedAt: now,
    brief: {
      revision: 1,
      goal: 'Save a small village',
      audience: 'New players',
      firstSession: 'One complete rescue',
      coreLoop: 'Fly and collect',
      artDirection: 'Friendly cartoon dragon',
      acceptance: ['Input and useful feedback'],
      devices: ['desktop', 'mobile'],
      platforms: ['crazygames'],
      exclusions: ['No paid assets'],
      budget: { currency: 'USD', limitMicros: 0 },
      publication: 'prepare_only',
      source,
    },
    briefHistory: [],
    decisions: [
      {
        key: 'hero',
        value: 'Friendly dragon',
        revision: 1,
        state: 'accepted',
        source,
      },
    ],
    tasks: [
      {
        id: 'play',
        stage: 'playable',
        title: 'Playable mission',
        acceptance: ['One completed rescue'],
        dependencies: [],
        briefRevision: 1,
        state: 'working',
        operationIds: ['op'],
      },
    ],
    taskHistory: [],
    lease: {
      token: 'fixture-lease',
      fencing: 1,
      actorKey: key,
      runId: actor.runId,
      taskId: 'play',
      backend: 'legacy',
      briefRevision: 1,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: '2099-01-01T00:00:00Z',
      state: 'active',
      workDirectory: path.join(root, 'games', 'fixture-game'),
    },
    fencing: 1,
    builds: [],
    operations: [
      {
        id: 'op',
        kind: 'legacy',
        externalId: jobId,
        taskId: 'play',
        briefRevision: 1,
        state: 'linked',
        evidence: 'host_observed',
        tracking: 'execution',
        observedAt: now,
      },
    ],
    evidence: [],
    releases: [],
    assets: [],
  };
  db = new Database(config.databasePath);
  fs.chmodSync(config.databasePath, 0o600);
  ensureGameFactorySchema(db);
  db.prepare('INSERT INTO factory_projects VALUES(?,?,?,?)').run(
    project.id,
    1,
    JSON.stringify(project),
    now,
  );
  db.prepare('INSERT INTO factory_members VALUES(?,?,?)').run(
    project.id,
    key,
    'owner',
  );
  writeConfig();
  vi.stubEnv('SKOOBI_GAME_FACTORY_CONFIG', path.join(root, 'config.json'));
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('legacy project binding', () => {
  it('captures a complete host route only for new direct dispatches, outside the generator payload', () => {
    const completeActor = { ...actor, channelChatId: 'fixture-chat' };
    const bound = db
      .transaction(() =>
        bindGameFactoryLegacyJob({
          db,
          config,
          actor: completeActor,
          project,
          task: project.tasks[0],
          jobId,
          createdAt: now,
        }),
      )
      .immediate();
    expect(bound.route).toEqual({
      chatJid: actor.chatJid,
      groupFolder: actor.sourceGroup,
      tenantId: actor.tenantId,
      identityId: actor.identityId,
      channelChatId: 'fixture-chat',
      senderId: actor.senderId,
    });
    expect(bound.request.brief).not.toContain(actor.senderId);
    expect(bound.request.brief).not.toContain('fixture-chat');
  });
  it('reserves one request with no music or personal chat provenance and exact replay', () => {
    const binding = bind();
    expect(bind()).toEqual(binding);
    expect(readFactoryLegacyBinding(db, jobId)).toEqual(binding);
    expect(binding.request).toMatchObject({
      request_id: `factory:${jobId}`,
      engine: 'canvas',
      music: false,
      timeout_seconds: 1200,
    });
    for (const value of [
      actor.identityId,
      actor.chatJid,
      actor.senderId,
      'private-message',
    ])
      expect(binding.request.brief).not.toContain(value);
    expect(binding.request.brief).toContain('Friendly dragon');
    project.brief.goal = 'Different mission';
    expect(bind).toThrow('legacy_binding_conflict');
  });
  it('refuses foreign actor, missing execution lease, unsupported engine and unsafe host config', async () => {
    bind();
    await expect(
      observePersistedGameFactoryLegacyJob(
        { ...actor, identityId: 'stranger' },
        jobId,
      ),
    ).rejects.toThrow('project_unavailable');
    await expect(
      observePersistedGameFactoryLegacyJob(actor, randomUUID()),
    ).rejects.toThrow('legacy_binding_unavailable');
    project.engine = 'roblox';
    expect(bind).toThrow('legacy_dispatch_not_allowed');
    project.engine = 'canvas';
    project.lease = null;
    expect(bind).toThrow('legacy_dispatch_not_allowed');
    fs.chmodSync(legacyConfig, 0o644);
    expect(() => readFactoryLegacyConfiguration(legacyConfig)).toThrow(
      'legacy_path_unsafe',
    );
    fs.chmodSync(legacyConfig, 0o600);
    const alias = path.join(root, 'alias.json');
    fs.symlinkSync(legacyConfig, alias);
    expect(() => readFactoryLegacyConfiguration(alias)).toThrow(
      'legacy_path_unsafe',
    );
    fs.unlinkSync(alias);
    fs.linkSync(legacyConfig, alias);
    expect(() => readFactoryLegacyConfiguration(legacyConfig)).toThrow(
      'legacy_path_unsafe',
    );
  });
});

/** Optional real provider-contract check: sources are copied; only submit/status/cancel run against a fresh private DB.
 * No worker, generation, authentication, music or provider/network endpoint is invoked. */
describe.skipIf(!sourceRoot || !python)(
  'real Python legacy protocol in a private fixture',
  () => {
    it('host maintenance retries persisted cancellation with the real private provider and no active chat', async () => {
      bind();
      await submitPersistedGameFactoryLegacyJob(actor, jobId);
      // Имитируем завершение процесса после commit намерения, но до adapter call.
      db.prepare('UPDATE factory_legacy_bindings SET cancel_requested=1').run();
      project.status = 'paused';
      project.operations[0].state = 'unknown';
      persist();
      const result = await runGameFactoryMaintenanceTick();
      expect(result.changed).toEqual([
        expect.objectContaining({
          jobId,
          state: 'failed',
          cancellationRequested: true,
          requirementsCurrent: false,
        }),
      ]);
      const queue = providerDb();
      try {
        expect(
          queue.prepare('SELECT status,cancel_requested FROM jobs').get(),
        ).toEqual({ status: 'cancelled', cancel_requested: 1 });
      } finally {
        queue.close();
      }
      const after = JSON.parse(
        (
          db
            .prepare('SELECT document_json FROM factory_projects WHERE id=?')
            .get(project.id) as { document_json: string }
        ).document_json,
      ) as FactoryProject;
      expect(after.tasks[0].state).toBe('working');
      expect(after.lease).toEqual(project.lease);
      expect(after.evidence).toEqual([]);
      expect(await runGameFactoryMaintenanceTick()).toEqual({
        processed: false,
        changed: [],
      });
    });
    it('cancels a late accepted submit after cancellation observed no provider row', async () => {
      bind();
      const script = path.join(root, 'code', 'factory.py'),
        entered = path.join(root, 'submit-entered'),
        proceed = path.join(root, 'submit-proceed');
      const original = fs.readFileSync(script, 'utf8');
      expect(original).toContain('result=f.submit(json.loads(raw))');
      fs.writeFileSync(
        script,
        original.replace(
          'result=f.submit(json.loads(raw))',
          `Path(${JSON.stringify(entered)}).write_text('entered')\n        while not Path(${JSON.stringify(proceed)}).exists():\n            time.sleep(0.01)\n        result=f.submit(json.loads(raw))`,
        ),
      );
      const pending = submitPersistedGameFactoryLegacyJob(actor, jobId);
      try {
        for (let tries = 0; !fs.existsSync(entered) && tries < 300; tries++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(fs.existsSync(entered)).toBe(true);
        expect(
          await cancelPersistedGameFactoryLegacyJob(actor, jobId),
        ).toMatchObject({
          state: 'not_submitted',
          operationState: 'unknown',
          cancellationRequested: true,
        });
      } finally {
        fs.writeFileSync(proceed, 'continue');
      }
      expect(await pending).toMatchObject({
        state: 'cancelled',
        operationState: 'failed',
        cancellationRequested: true,
      });
      const queue = providerDb();
      try {
        expect(queue.prepare('SELECT count(*) n FROM jobs').get()).toEqual({
          n: 1,
        });
        expect(
          queue.prepare('SELECT status,cancel_requested FROM jobs').get(),
        ).toEqual({ status: 'cancelled', cancel_requested: 1 });
      } finally {
        queue.close();
      }
    });
    it('readonly missing status creates nothing; concurrent identical submissions persist one queue entry', async () => {
      bind();
      const before = fs.readdirSync(state);
      expect(
        await observePersistedGameFactoryLegacyJob(actor, jobId),
      ).toMatchObject({ state: 'not_submitted', requirementsCurrent: true });
      expect(fs.readdirSync(state)).toEqual(before);
      const results = await Promise.all([
        submitPersistedGameFactoryLegacyJob(actor, jobId),
        submitPersistedGameFactoryLegacyJob(actor, jobId),
      ]);
      expect(results.every((r) => r.state === 'queued')).toBe(true);
      const queue = providerDb();
      try {
        expect(queue.prepare('SELECT count(*) n FROM jobs').get()).toEqual({
          n: 1,
        });
        expect(
          queue.prepare('SELECT music,source_job FROM jobs').get(),
        ).toEqual({ music: 0, source_job: null });
      } finally {
        queue.close();
      }
      const filename = path.join(state, 'queue.sqlite3'),
        bytes = fs.readFileSync(filename),
        modified = fs.statSync(filename).mtimeMs;
      const view = await observePersistedGameFactoryLegacyJob(actor, jobId);
      expect(fs.readFileSync(filename)).toEqual(bytes);
      expect(fs.statSync(filename).mtimeMs).toBe(modified);
      expect(JSON.stringify(view)).not.toMatch(
        /directory|request_id|pid|fixture-owner-private|Friendly dragon/,
      );
      expect(fs.existsSync(path.join(root, 'code', '__pycache__'))).toBe(false);
    });
    it('reconciles stale jobs without dispatch/import and can cancel after origin revocation', async () => {
      bind();
      await submitPersistedGameFactoryLegacyJob(actor, jobId);
      project.status = 'paused';
      project.brief.goal = 'Correction';
      persist();
      expect(
        await observePersistedGameFactoryLegacyJob(actor, jobId),
      ).toMatchObject({ state: 'queued', requirementsCurrent: false });
      await expect(
        submitPersistedGameFactoryLegacyJob(actor, jobId),
      ).rejects.toThrow('legacy_context_stale');
      await expect(
        inspectPersistedGameFactoryLegacySource(actor, jobId),
      ).rejects.toThrow('legacy_context_stale');
      const editor = { ...actor, identityId: 'current-editor' };
      db.prepare('INSERT INTO factory_members VALUES(?,?,?)').run(
        project.id,
        factoryActorKey(editor),
        'editor',
      );
      config.actors = [
        { ...config.actors[0], identityId: editor.identityId, alias: 'editor' },
      ];
      writeConfig();
      expect(
        await observePersistedGameFactoryLegacyJob(editor, jobId),
      ).toMatchObject({ state: 'queued', requirementsCurrent: false });
      expect(
        await cancelPersistedGameFactoryLegacyJob(editor, jobId),
      ).toMatchObject({
        state: 'cancelled',
        operationState: 'failed',
        cancellationRequested: true,
      });
      await expect(
        cancelPersistedGameFactoryLegacyJob(actor, jobId),
      ).rejects.toThrow('backend_not_allowed');
    });
    it('retains a cancellation tombstone before dispatch and never creates a worker task on retry', async () => {
      bind();
      expect(
        await cancelPersistedGameFactoryLegacyJob(actor, jobId),
      ).toMatchObject({
        state: 'not_submitted',
        cancellationRequested: true,
        operationState: 'unknown',
      });
      await expect(
        submitPersistedGameFactoryLegacyJob(actor, jobId),
      ).rejects.toThrow('legacy_cancel_requested');
      expect(fs.readdirSync(state)).toEqual([]);
    });
    it('rejects provider DB loss and same request ID with a changed payload', async () => {
      bind();
      await submitPersistedGameFactoryLegacyJob(actor, jobId);
      let queue = providerDb();
      queue
        .prepare('UPDATE jobs SET brief=?')
        .run('PRIVATE provider mismatch details');
      queue.close();
      await expect(
        observePersistedGameFactoryLegacyJob(actor, jobId),
      ).rejects.toThrow('legacy_response_scope_mismatch');
      fs.rmSync(state, { recursive: true });
      fs.mkdirSync(state, { mode: 0o700 });
      await expect(
        submitPersistedGameFactoryLegacyJob(actor, jobId),
      ).rejects.toThrow('legacy_provider_state_changed');
      expect(fs.readdirSync(state)).toEqual([]);
    });
    it('requires terminal process state and canonical source, and treats quarantine as unknown', async () => {
      bind();
      await submitPersistedGameFactoryLegacyJob(actor, jobId);
      const queue = providerDb();
      const row = queue.prepare('SELECT id FROM jobs').get() as { id: string };
      queue.prepare("UPDATE jobs SET status='quarantined'").run();
      expect(
        await observePersistedGameFactoryLegacyJob(actor, jobId),
      ).toMatchObject({ operationState: 'unknown', scopeComplete: false });
      queue.prepare("UPDATE jobs SET status='review_ready',pid=1").run();
      expect(
        await observePersistedGameFactoryLegacyJob(actor, jobId),
      ).toMatchObject({ operationState: 'running', scopeComplete: false });
      queue.prepare('UPDATE jobs SET pid=NULL').run();
      queue.close();
      const source = path.join(state, 'jobs', row.id, 'project');
      fs.mkdirSync(source, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(source, 'index.html'), '<html>fixture</html>');
      expect(
        await inspectPersistedGameFactoryLegacySource(actor, jobId),
      ).toMatchObject({ sourceRoot: source, entrypoint: 'index.html' });
      const view = await observePersistedGameFactoryLegacyJob(actor, jobId);
      expect(view).toMatchObject({
        operationState: 'completed',
        scopeComplete: true,
        requiresHumanReview: true,
      });
      expect(JSON.stringify(view)).not.toContain(source);
      fs.unlinkSync(path.join(source, 'index.html'));
      fs.symlinkSync(legacyConfig, path.join(source, 'index.html'));
      await expect(
        inspectPersistedGameFactoryLegacySource(actor, jobId),
      ).rejects.toThrow('legacy_path_unsafe');
    });
  },
);
