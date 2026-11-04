import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  FactoryActor,
  FactoryConfiguration,
} from '../packages/core/src/orchestrator/game-factory-contracts.js';
import { GameFactoryService } from '../packages/core/src/orchestrator/game-factory-service.js';
import {
  ensureGameFactorySchema,
  GameFactoryStore,
} from '../packages/core/src/orchestrator/game-factory-store.js';
import {
  readFactoryPeerBinding,
  readGameFactoryPeerState,
} from '../packages/core/src/orchestrator/game-factory-peer-state.js';
import { buildGameFactoryPeerContext } from '../packages/core/src/orchestrator/game-factory-peer-adapter.js';
import {
  ingestPeerInboxEvent,
  signPeerInboxEvent,
  type PeerBridgeConfig,
  type PeerInboxEvent,
} from '../packages/core/src/orchestrator/peer-inbox.js';

const codeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const source = (file: string) =>
  pathToFileURL(path.join(codeRoot, 'packages/core/src/orchestrator', file))
    .href;
const peerModule = pathToFileURL(
  path.join(codeRoot, 'ops/peer/skoobi-peer-core.mjs'),
).href;
const actor: FactoryActor = {
  identityId: 'fixture-second-admin',
  tenantId: 'fixture-second-tenant',
  chatJid: 'tg:7000002',
  channelChatId: '7000002',
  sourceGroup: 'fixture-second-main',
  senderId: '7000002',
  currentMessageIds: ['fixture-direct-message'],
  runId: 'fixture-controller-run',
  isPrimaryOwner: false,
};
const brief = {
  goal: 'Make a small game prototype',
  audience: 'New players',
  firstSession: 'Win the first short mission',
  coreLoop: 'Move, collect, finish',
  artDirection: 'Readable silhouettes',
  acceptance: ['First mission is playable'],
  devices: ['desktop'],
  platforms: ['crazygames'],
  exclusions: ['No personal memory or account data'],
};
let root: string,
  db: Database.Database,
  store: GameFactoryStore,
  service: GameFactoryService,
  config: FactoryConfiguration,
  bridge: PeerBridgeConfig,
  configPath: string,
  coordinatorPath: string,
  stateRoot: string,
  sequence: number;

function writePrivate(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}
function command(
  action: string,
  args: Record<string, unknown>,
  revision = store.read(actor, 'fixture-game').revision,
) {
  return service.execute(actor, {
    action,
    args,
    operationId: `fixture-operation-${++sequence}`,
    projectId: 'fixture-game',
    expectedRevision: revision,
  });
}
function dispatch(): string {
  return (
    command('peer_dispatch', {
      token: store.read(actor, 'fixture-game').lease!.token,
      expectedOutputs: [{ name: 'game.txt', kind: 'document' }],
      acceptance: [
        {
          id: 'game-file',
          description: 'Return the declared artifact',
          kind: 'file_present',
          outputName: 'game.txt',
        },
      ],
    }) as { peerJobId: string }
  ).peerJobId;
}

/** A fresh native process on each call simulates coordinator restart. The
 * coordinator fixture has no peer address or key: it cannot make an SSH call. */
function freshProcess(body: string): Record<string, unknown> {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--import',
        path.join(codeRoot, 'node_modules/tsx/dist/loader.mjs'),
        '--input-type=module',
        '-e',
        body + '\nprocess.stdout.write(\"\", () => process.exit(0));',
      ],
      {
        cwd: root,
        env: { ...process.env, SKOOBI_GAME_FACTORY_CONFIG: configPath },
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 256 * 1024,
      },
    ),
  );
}
function prepareAfterRestart(jobId: string): Record<string, unknown> {
  return freshProcess(
    `const host = await import(${JSON.stringify(source('game-factory-peer-state.ts'))}); console.log(JSON.stringify(await host.preparePersistedGameFactoryPeerJob(${JSON.stringify(actor)}, ${JSON.stringify(jobId)})));`,
  );
}

beforeEach(async () => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-peer-prepare-')),
  );
  fs.chmodSync(root, 0o700);
  stateRoot = path.join(root, 'coordinator-state');
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  const bridgeRoot = path.join(root, 'bridge');
  fs.mkdirSync(bridgeRoot, { mode: 0o700 });
  const workspaceRoot = path.join(root, 'game-workspace');
  fs.mkdirSync(workspaceRoot, { mode: 0o700 });
  const keyPath = path.join(bridgeRoot, 'key');
  fs.writeFileSync(keyPath, Buffer.alloc(32, 9), { mode: 0o600 });
  bridge = {
    schema: 1,
    root: bridgeRoot,
    projectRoot: root,
    ownerGroupFolder: 'telegram_main',
    ownerJid: 'tg:7000001',
    identityId: 'fixture-primary-admin',
    tenantId: 'fixture-primary-tenant',
    networkId: '1'.repeat(24),
    signingKeyPath: keyPath,
  };
  const bridgePath = path.join(root, 'bridge-config.json');
  writePrivate(bridgePath, bridge);
  coordinatorPath = path.join(root, 'coordinator.json');
  writePrivate(coordinatorPath, {
    schema: 1,
    role: 'coordinator',
    nodeId: 'mini-fixture',
    networkId: bridge.networkId,
    ownerJid: bridge.ownerJid,
    ownerGroupFolder: bridge.ownerGroupFolder,
    projectRoot: root,
    stateRoot,
    bridgeConfigPath: bridgePath,
  });
  // Production resolves these entrypoints under dist. These transparent source
  // re-exports keep the fixture independent of a prior build; no logic is mocked.
  const entrypoints = path.join(root, 'packages/core/dist/orchestrator');
  fs.mkdirSync(entrypoints, { recursive: true, mode: 0o700 });
  for (const file of [
    'peer-inbox',
    'peer-bridge-context',
    'game-factory-peer-adapter',
  ])
    fs.writeFileSync(
      path.join(entrypoints, `${file}.js`),
      `export * from ${JSON.stringify(source(file + '.ts'))};\n`,
      { mode: 0o600 },
    );
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}', {
    mode: 0o600,
  });
  const ownerRoot = path.join(root, 'groups', 'telegram_main');
  fs.mkdirSync(ownerRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(ownerRoot, 'CLAUDE.md'),
    'OWNER_PERSONAL_MEMORY_MUST_NOT_TRAVEL',
    { mode: 0o600 },
  );
  config = {
    version: 1,
    enabled: true,
    primaryOwnerIdentityId: bridge.identityId,
    databasePath: path.join(root, 'factory.db'),
    workspaceRoot,
    actors: [
      {
        identityId: actor.identityId,
        tenantId: actor.tenantId,
        alias: 'second-admin',
        canCreate: true,
        backends: ['peer', 'agent'],
        sourceRoots: [workspaceRoot],
      },
    ],
    peer: {
      networkId: bridge.networkId,
      coordinatorConfigPath: coordinatorPath,
      model: 'fixture-model',
      reasoningEffort: 'high',
    },
  };
  configPath = path.join(root, 'factory-config.json');
  writePrivate(configPath, config);
  vi.stubEnv('SKOOBI_GAME_FACTORY_CONFIG', configPath);
  db = new Database(config.databasePath);
  fs.chmodSync(config.databasePath, 0o600);
  ensureGameFactorySchema(db);
  store = new GameFactoryStore(db);
  sequence = 0;
  const validators = await import(
    pathToFileURL(path.join(codeRoot, 'ops/peer/skoobi-peer-contract.mjs')).href
  );
  service = new GameFactoryService(config, store, {
    verifyCurrentSource: () => {},
    validatePeerPayload: ({ jobId, contract, context }) => {
      validators.validatePeerContract(contract);
      validators.validatePeerContext(context, { id: jobId, contract });
    },
  });
  command(
    'create',
    { title: 'Second administrator game', engine: 'canvas', brief },
    0,
  );
  command('plan', {
    tasks: [
      {
        id: 'fixture-task',
        stage: 'playable',
        title: 'Make a playable game',
        acceptance: ['Return the declared artifact'],
        dependencies: [],
      },
    ],
  });
  command('claim', { taskId: 'fixture-task', backend: 'peer' });
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it(
  'prepares the real existing JobStore once across fresh host processes, with only project context',
  { timeout: 45_000 },
  async () => {
    const jobId = dispatch();
    const peer = await import(peerModule),
      jobs = new peer.JobStore(stateRoot);
    expect(jobs.list()).toHaveLength(0);
    expect(readFactoryPeerBinding(db, jobId)).not.toBeNull();
    const first = prepareAfterRestart(jobId);
    expect(first).toMatchObject({ id: jobId, accepted: false, revision: 1 });
    const retained = jobs.payload(jobId),
      before = fs.readFileSync(
        path.join(jobs.dir(jobId), 'state.json'),
        'utf8',
      );
    const bound = readGameFactoryPeerState(jobId)!;
    expect(bound.route).toEqual({
      chatJid: actor.chatJid,
      identityId: actor.identityId,
      tenantId: actor.tenantId,
      groupFolder: actor.sourceGroup,
    });
    expect(retained.context).toEqual(buildGameFactoryPeerContext(bound));
    expect(
      retained.context.records.every(
        (r: { projectKey: string }) => r.projectKey === 'fixture-game',
      ),
    ).toBe(true);
    expect(JSON.stringify(retained)).not.toContain(
      'OWNER_PERSONAL_MEMORY_MUST_NOT_TRAVEL',
    );
    expect(retained.contract.execution).toMatchObject({
      mode: 'isolated',
      guiAuthorized: false,
    });
    expect(prepareAfterRestart(jobId)).toMatchObject({
      id: jobId,
      accepted: false,
    });
    expect(jobs.list()).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(jobs.dir(jobId), 'state.json'), 'utf8'),
    ).toBe(before);
    expect(jobs.payload(jobId)).toEqual(retained);
  },
);

it(
  'fails closed on an orphan factory marker before creating a peer job',
  { timeout: 30_000 },
  async () => {
    const existing = dispatch(),
      binding = readFactoryPeerBinding(db, existing)!,
      missing = randomUUID();
    const options = structuredClone(binding.dispatch.options) as {
      contract: Record<string, unknown>;
    };
    options.contract.parentTaskId = 'factory:' + missing;
    const response = freshProcess(
      `const core = await import(${JSON.stringify(peerModule)}); const peer = await import(${JSON.stringify(pathToFileURL(path.join(codeRoot, 'ops/peer/skoobi-peer-v2.mjs')).href)}); try { await peer.preparePeerV2(core.loadConfig(${JSON.stringify(coordinatorPath)}), ${JSON.stringify(options)}, undefined, ${JSON.stringify(missing)}); console.log(JSON.stringify({unexpectedSuccess:true})); } catch (e) { console.log(JSON.stringify({denied:e.message})); }`,
    );
    expect(response).toEqual({ denied: 'Factory peer binding unavailable' });
    const peer = await import(peerModule);
    expect(new peer.JobStore(stateRoot).list()).toHaveLength(0);
  },
);

it(
  'retains uncertain termination as unknown, preserves completed context after release, and enforces caller backend revocation',
  { timeout: 45_000 },
  () => {
    const jobId = dispatch();
    prepareAfterRestart(jobId);
    const snapshot = readGameFactoryPeerState(jobId)!,
      token = store.read(actor, 'fixture-game').lease!.token;
    const inbox = new Database(':memory:');
    const receive = (resultState: string, eventId: string) => {
      const now = new Date().toISOString();
      const event: PeerInboxEvent = {
        schema: 1,
        eventId,
        jobId,
        revision: 1,
        parentTaskId: snapshot.parentTaskId,
        projectKey: snapshot.projectId,
        receivedAt: now,
        resultReceivedAt: now,
        eventKind: 'result',
        notify: false,
        resultState,
        resultHash: (resultState === 'succeeded' ? 'b' : 'a').repeat(64),
        contextHash: buildGameFactoryPeerContext(snapshot).sha256,
        contextValidity: {
          scopeRevisionHash: snapshot.scopeRevisionHash,
          expiresAt: snapshot.expiresAt,
        },
        verification: {
          status: 'inconclusive',
          summary: 'Only execution status observed',
        },
        summary: 'Synthetic receipt',
        artifacts: [],
      };
      ingestPeerInboxEvent(inbox, bridge, signPeerInboxEvent(bridge, event));
    };
    try {
      receive('needs_review', 'fixture-uncertain-result');
      expect(store.read(actor, 'fixture-game').operations[0].state).toBe(
        'unknown',
      );
      expect(() => command('release_claim', { token })).toThrow(
        'external_execution_unresolved',
      );
      receive('succeeded', 'fixture-completed-result');
      expect(store.read(actor, 'fixture-game').operations[0].state).toBe(
        'completed',
      );
      command('release_claim', { token });
      expect(readGameFactoryPeerState(jobId)).toMatchObject({
        current: true,
        routeAllowed: true,
      });
      expect(store.read(actor, 'fixture-game').tasks[0].state).not.toBe(
        'accepted',
      );
      config.actors[0].backends = ['agent'];
      writePrivate(configPath, config);
      const operation = store.read(actor, 'fixture-game').operations[0];
      expect(() =>
        command('peer_refresh', { operationId: operation.id }),
      ).toThrow('backend_not_allowed');
      const result = freshProcess(
        `const host = await import(${JSON.stringify(source('game-factory-peer-state.ts'))}); try { await host.preparePersistedGameFactoryPeerJob(${JSON.stringify(actor)},${JSON.stringify(jobId)}); console.log(JSON.stringify({unexpectedSuccess:true})); } catch(e) { console.log(JSON.stringify({denied:e.code})); }`,
      );
      expect(result).toEqual({ denied: 'backend_not_allowed' });
    } finally {
      inbox.close();
    }
  },
);
