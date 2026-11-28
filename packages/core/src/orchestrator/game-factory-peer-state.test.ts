import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FactoryActor,
  FactoryConfiguration,
  FactoryProject,
} from './game-factory-contracts.js';
import { GameFactoryService } from './game-factory-service.js';
import {
  ensureGameFactorySchema,
  GameFactoryStore,
} from './game-factory-store.js';
import {
  readFactoryPeerBinding,
  projectFactoryPeerState,
  factoryPeerRequirementsHash,
  readGameFactoryPeerState,
  recordGameFactoryPeerEvent,
} from './game-factory-peer-state.js';
import { buildGameFactoryPeerContext } from './game-factory-peer-adapter.js';
import {
  ingestPeerInboxEvent,
  signPeerInboxEvent,
  type PeerInboxEvent,
  type PeerBridgeConfig,
} from './peer-inbox.js';

const actor: FactoryActor = {
  identityId: 'fixture-owner',
  tenantId: 'fixture-tenant',
  chatJid: 'tg:fixture',
  channelChatId: 'fixture',
  sourceGroup: 'fixture-group',
  senderId: 'fixture-sender',
  currentMessageIds: ['fixture-message'],
  runId: 'fixture-run',
  isPrimaryOwner: true,
};
let root: string,
  db: Database.Database,
  store: GameFactoryStore,
  service: GameFactoryService,
  config: FactoryConfiguration,
  counter: number;
let createdAt: string;
const brief = {
  goal: 'Игровая миссия',
  audience: 'Новые игроки',
  firstSession: 'Спасти персонажа',
  coreLoop: 'Действие и результат',
  artDirection: 'Согласованное оформление',
  acceptance: ['Первый успех'],
  devices: ['desktop'],
  platforms: ['crazygames'],
  exclusions: ['Личная память не передаётся'],
};
const command = (
  action: string,
  args: Record<string, unknown>,
  revision = store.read(actor, 'fixture-game').revision,
) =>
  service.execute(actor, {
    action,
    args,
    projectId: 'fixture-game',
    expectedRevision: revision,
    operationId: `fixture-command-${++counter}`,
  });
function dispatch(): string {
  const token = store.read(actor, 'fixture-game').lease!.token;
  return (
    command('peer_dispatch', {
      token,
      expectedOutputs: [{ name: 'result.txt', kind: 'document' }],
      acceptance: [
        {
          id: 'result-file',
          description: 'Файл результата',
          kind: 'file_present',
          outputName: 'result.txt',
        },
      ],
    }) as { peerJobId: string }
  ).peerJobId;
}
beforeEach(async () => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-peer-state-')),
  );
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(path.join(root, 'work'), { mode: 0o700 });
  config = {
    version: 1,
    enabled: true,
    primaryOwnerIdentityId: actor.identityId,
    databasePath: path.join(root, 'factory.db'),
    workspaceRoot: path.join(root, 'work'),
    actors: [
      {
        identityId: actor.identityId,
        tenantId: actor.tenantId,
        alias: 'owner',
        canCreate: true,
        backends: ['peer', 'agent'],
        sourceRoots: [root],
      },
    ],
    peer: {
      networkId: '1'.repeat(24),
      coordinatorConfigPath: path.join(root, 'coordinator.json'),
      model: 'fixture-model',
      reasoningEffort: 'high',
    },
  };
  db = new Database(config.databasePath);
  fs.chmodSync(config.databasePath, 0o600);
  ensureGameFactorySchema(db);
  store = new GameFactoryStore(db);
  createdAt = new Date().toISOString();
  counter = 0;
  const validators = await import(
    new URL('../../../../ops/peer/skoobi-peer-contract.mjs', import.meta.url)
      .href
  );
  service = new GameFactoryService(config, store, {
    now: () => createdAt,
    verifyCurrentSource: () => {},
    validatePeerPayload: ({ jobId, contract, context }) => {
      validators.validatePeerContract(contract);
      validators.validatePeerContext(context, { id: jobId, contract });
    },
  });
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  vi.stubEnv('SKOOBI_GAME_FACTORY_CONFIG', file);
  command('create', { title: 'Тестовый проект', engine: 'canvas', brief }, 0);
  command('plan', {
    tasks: [
      {
        id: 'fixture-task',
        stage: 'playable',
        title: 'Рабочая миссия',
        acceptance: ['Получить проверяемый файл'],
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

describe('factory-specific durable peer authority', () => {
  it('persists a scoped dispatch before submission and never includes private chat sources', () => {
    const jobId = dispatch(),
      binding = readFactoryPeerBinding(db, jobId)!;
    expect(binding.parentTaskId).toBe(`factory:${jobId}`);
    expect(binding.dispatch.options.inputs).toEqual([]);
    expect(binding.dispatch.options.contract).toMatchObject({
      execution: { mode: 'isolated', guiAuthorized: false },
      runtime: { model: 'fixture-model' },
    });
    const state = projectFactoryPeerState(db, config, binding, createdAt),
      context = buildGameFactoryPeerContext(state);
    expect(state.current).toBe(true);
    expect(state.routeAllowed).toBe(true);
    expect(
      context.records.every(
        (r) =>
          r.projectKey === 'fixture-game' && r.source.messageRef === undefined,
      ),
    ).toBe(true);
    expect(JSON.stringify(context)).not.toContain(actor.chatJid);
    expect(JSON.stringify(context)).not.toContain(actor.identityId);
    expect(readGameFactoryPeerState(jobId)?.scopeRevisionHash).toBe(
      state.scopeRevisionHash,
    );
  });

  it('refuses a second outstanding peer job and replay returns the original reservation', () => {
    const token = store.read(actor, 'fixture-game').lease!.token;
    const args = {
      token,
      expectedOutputs: [{ name: 'result.txt', kind: 'document' }],
      acceptance: [
        {
          id: 'file',
          description: 'Результат',
          kind: 'file_present',
          outputName: 'result.txt',
        },
      ],
    };
    const request = {
      operationId: 'fixture-dispatch-once',
      action: 'peer_dispatch',
      args,
      projectId: 'fixture-game',
      expectedRevision: store.read(actor, 'fixture-game').revision,
    };
    const first = service.execute(actor, request);
    expect(service.execute(actor, request)).toEqual(first);
    expect(() => command('peer_dispatch', args)).toThrow(
      'peer_task_already_dispatched',
    );
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM factory_peer_bindings').get(),
    ).toEqual({ n: 1 });
  });

  it('progress does not invalidate requirements, but a new brief does', () => {
    const jobId = dispatch(),
      binding = readFactoryPeerBinding(db, jobId)!;
    const before = store.read(actor, 'fixture-game');
    const token = before.lease!.token;
    command('checkpoint', { token, summary: 'Работа идёт', state: 'working' });
    const updated = store.read(actor, 'fixture-game');
    expect(factoryPeerRequirementsHash(updated, updated.tasks[0], [])).toBe(
      binding.scopeRevisionHash,
    );
    expect(
      projectFactoryPeerState(db, config, binding, createdAt).current,
    ).toBe(true);
    command('brief', { ...brief, goal: 'Исправленная миссия' });
    expect(
      projectFactoryPeerState(db, config, binding, createdAt),
    ).toMatchObject({ current: false, routeAllowed: true });
  });

  it('retains the marker after policy revocation, but denies routing and context', () => {
    const jobId = dispatch(),
      binding = readFactoryPeerBinding(db, jobId)!;
    const revoked = { ...config, actors: [] };
    expect(
      projectFactoryPeerState(db, revoked, binding, createdAt),
    ).toMatchObject({ current: false, routeAllowed: false, jobId });
  });

  it('rejects malformed acceptance before persisting any job', () => {
    const token = store.read(actor, 'fixture-game').lease!.token;
    expect(() =>
      command('peer_dispatch', {
        token,
        expectedOutputs: [{ name: 'result.txt', kind: 'document' }],
        acceptance: [
          {
            id: 'bad',
            description: 'Другой файл',
            kind: 'file_present',
            outputName: 'secret.txt',
          },
        ],
      }),
    ).toThrow('peer_acceptance_invalid');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM factory_peer_bindings').get(),
    ).toEqual({ n: 0 });
  });

  it('only the authenticated inbox can record execution and does not accept game quality', () => {
    const jobId = dispatch(),
      state = readGameFactoryPeerState(jobId)!;
    const now = new Date().toISOString();
    const event: PeerInboxEvent = {
      schema: 1,
      eventId: 'fixture-peer-result',
      jobId,
      revision: 1,
      parentTaskId: state.parentTaskId,
      projectKey: state.projectId,
      receivedAt: now,
      resultReceivedAt: now,
      eventKind: 'result',
      notify: false,
      resultState: 'succeeded',
      resultHash: 'a'.repeat(64),
      contextHash: buildGameFactoryPeerContext(state).sha256,
      contextValidity: {
        scopeRevisionHash: state.scopeRevisionHash,
        expiresAt: state.expiresAt,
      },
      verification: { status: 'inconclusive', summary: 'Нужна оценка игры' },
      summary: 'Исполнитель закончил',
      artifacts: [],
    };
    expect(() => recordGameFactoryPeerEvent(event)).toThrow(
      'authenticated_peer_event_required',
    );
    fs.writeFileSync(path.join(root, 'key'), Buffer.alloc(32, 7), {
      mode: 0o600,
    });
    const bridge: PeerBridgeConfig = {
      schema: 1,
      root,
      projectRoot: root,
      ownerGroupFolder: actor.sourceGroup,
      ownerJid: actor.chatJid,
      identityId: actor.identityId,
      tenantId: actor.tenantId,
      networkId: config.peer!.networkId,
      signingKeyPath: path.join(root, 'key'),
    };
    const inbox = new Database(':memory:');
    try {
      const signed = signPeerInboxEvent(bridge, event);
      expect(ingestPeerInboxEvent(inbox, bridge, signed)).toMatchObject({
        duplicate: false,
      });
      expect(ingestPeerInboxEvent(inbox, bridge, signed)).toMatchObject({
        duplicate: true,
      });
      const project = store.read(actor, 'fixture-game');
      expect(project.operations[0]).toMatchObject({
        state: 'completed',
        evidence: 'host_observed',
      });
      expect(project.tasks[0].state).toBe('working');
      expect(project.evidence).toEqual([]);
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM factory_peer_events').get(),
      ).toEqual({ n: 1 });
      const binding = readFactoryPeerBinding(db, jobId)!;
      const afterExpiry = projectFactoryPeerState(
        db,
        config,
        binding,
        new Date(Date.parse(binding.expiresAt) + 1000).toISOString(),
      );
      expect(afterExpiry.current).toBe(false);
      expect(afterExpiry.retainedResultCurrent).toBe(true);
      const delayed = {
        ...event,
        eventId: 'fixture-delayed-review',
        resultState: 'needs_review' as const,
        resultHash: 'b'.repeat(64),
      };
      ingestPeerInboxEvent(inbox, bridge, signPeerInboxEvent(bridge, delayed));
      expect(store.read(actor, 'fixture-game').operations[0]).toMatchObject({
        state: 'completed',
        resultHash: event.resultHash,
      });
      expect(
        store.read(actor, 'fixture-game').operations[0].resultConflict,
      ).toBeUndefined();
      const conflicting = {
        ...event,
        eventId: 'fixture-conflicting-result',
        resultState: 'failed' as const,
        resultHash: 'c'.repeat(64),
      };
      ingestPeerInboxEvent(
        inbox,
        bridge,
        signPeerInboxEvent(bridge, conflicting),
      );
      expect(store.read(actor, 'fixture-game').operations[0]).toMatchObject({
        state: 'completed',
        resultHash: event.resultHash,
        resultConflict: true,
      });
    } finally {
      inbox.close();
    }
  });
});
