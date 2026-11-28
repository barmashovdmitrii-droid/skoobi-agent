import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  buildGameFactoryPeerContext,
  createGameFactoryPeerHostAdapter,
  type GameFactoryPeerState,
} from './game-factory-peer-adapter.js';
import {
  createPeerInboxPump,
  ingestPeerInboxEvent,
  isAuthenticatedPeerInboxEvent,
  peerInboxPromptContext,
  signPeerInboxEvent,
  type PeerBridgeConfig,
  type PeerInboxEvent,
} from './peer-inbox.js';

const mock = vi.hoisted(() => ({
  states: new Map<string, unknown>(),
  record: vi.fn(),
}));
vi.mock('./game-factory-peer-state.js', () => ({
  readGameFactoryPeerState: (id: string) => {
    const state = mock.states.get(id);
    if (state instanceof Error) throw state;
    return state ?? null;
  },
  recordGameFactoryPeerEvent: mock.record,
}));
let root: string,
  db: Database.Database,
  config: PeerBridgeConfig,
  state: GameFactoryPeerState;
const jobId = '00000000-0000-4000-8000-000000000051';
beforeEach(() => {
  mock.states.clear();
  mock.record.mockReset();
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-peer-test-')),
  );
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, 'key'), Buffer.alloc(32, 1), {
    mode: 0o600,
  });
  db = new Database(':memory:');
  config = {
    schema: 1,
    root,
    projectRoot: root,
    signingKeyPath: path.join(root, 'key'),
    ownerGroupFolder: 'primary-main',
    ownerJid: 'tg:primary-fixture',
    identityId: 'primary-fixture',
    tenantId: 'primary-tenant',
    networkId: '0'.repeat(24),
  };
  const now = new Date().toISOString();
  state = {
    jobId,
    parentTaskId: 'factory:' + jobId,
    projectId: 'game-fixture',
    peerRevision: 1,
    briefRevision: 1,
    actorKey: 'a'.repeat(64),
    networkId: config.networkId,
    scopeHash: 'b'.repeat(64),
    scopeRevisionHash: 'c'.repeat(64),
    createdAt: now,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    current: true,
    routeAllowed: true,
    records: [
      {
        kind: 'project',
        key: 'brief',
        projectKey: 'game-fixture',
        revision: 1,
        updatedAt: now,
        validUntil: null,
        value: 'Shared game instructions only',
        source: {
          kind: 'assistant_report',
          at: now,
          trust: 'agent_interpreted',
        },
      },
    ],
    route: {
      chatJid: 'tg:second-fixture',
      tenantId: 'second-tenant',
      identityId: 'second-fixture',
      groupFolder: 'second-main',
    },
  };
  mock.states.set(jobId, state);
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const payload = () => ({
  contract: {
    parentTaskId: state.parentTaskId,
    projectKey: state.projectId,
    revision: 1,
    execution: {
      expiresAt: state.expiresAt,
      mode: 'isolated',
      guiAuthorized: false,
    },
  },
});
const event = (): PeerInboxEvent => ({
  schema: 1,
  eventId: 'factory-test-event',
  jobId,
  revision: 1,
  parentTaskId: state.parentTaskId,
  projectKey: state.projectId,
  receivedAt: new Date().toISOString(),
  resultReceivedAt: new Date().toISOString(),
  eventKind: 'result',
  notify: true,
  resultState: 'succeeded',
  resultHash: 'd'.repeat(64),
  contextHash: buildGameFactoryPeerContext(state).sha256,
  contextValidity: {
    scopeRevisionHash: state.scopeRevisionHash,
    expiresAt: state.expiresAt,
  },
  verification: { status: 'passed', summary: 'Exact declared checks passed' },
  summary: 'Game build returned',
  artifacts: [],
});

it('builds bounded project context and never allows personal/global records', async () => {
  const adapter = createGameFactoryPeerHostAdapter(config, jobId, payload())!;
  const context = await adapter.context(jobId, payload());
  expect(context.records).toEqual(state.records);
  expect(context.records.every((r) => r.projectKey === state.projectId)).toBe(
    true,
  );
  expect(
    await adapter.contextCurrent(jobId, { ...payload(), context }),
  ).toEqual({ valid: true });
  expect(() =>
    buildGameFactoryPeerContext(state, [
      { ...state.records[0], projectKey: null },
    ]),
  ).toThrow();
  expect(() =>
    buildGameFactoryPeerContext(state, [
      {
        ...state.records[0],
        source: {
          ...state.records[0].source,
          messageRef: 'private-chat-message',
        },
      },
    ]),
  ).toThrow();
});

it('fails closed on missing factory binding, identity mismatch, GUI and stale context', async () => {
  expect(() =>
    createGameFactoryPeerHostAdapter(config, 'missing-job', payload()),
  ).toThrow('binding unavailable');
  expect(
    createGameFactoryPeerHostAdapter(config, 'owner-job', {
      ...payload(),
      contract: { ...payload().contract, parentTaskId: 'legacy-parent' },
    }),
  ).toBeNull();
  expect(() =>
    createGameFactoryPeerHostAdapter(
      { ...config, networkId: '1'.repeat(24) },
      jobId,
      payload(),
    ),
  ).toThrow();
  expect(() =>
    createGameFactoryPeerHostAdapter(config, jobId, {
      ...payload(),
      contract: {
        ...payload().contract,
        execution: {
          ...payload().contract.execution,
          mode: 'gui',
          guiAuthorized: true,
        },
      },
    }),
  ).toThrow();
  const adapter = createGameFactoryPeerHostAdapter(config, jobId, payload())!;
  const context = await adapter.context(jobId, payload());
  state.current = false;
  await expect(adapter.context(jobId, payload())).rejects.toThrow('stale');
  expect(
    await adapter.contextCurrent(jobId, { ...payload(), context }),
  ).toEqual({ valid: false, reason: 'changed' });
});

it('routes authenticated factory results to their submitting administrator, not the primary owner', async () => {
  const route = vi.fn(async () => 'delivered'),
    notify = vi.fn(() => true);
  mock.record.mockImplementation((received: unknown) =>
    expect(isAuthenticatedPeerInboxEvent(received)).toBe(true),
  );
  const raw = event();
  expect(isAuthenticatedPeerInboxEvent(raw)).toBe(false);
  ingestPeerInboxEvent(db, config, signPeerInboxEvent(config, raw));
  const pump = createPeerInboxPump(config, {
    db,
    router: { route, send: async () => {} } as never,
    ownerAvailable: () => true,
    notifyActive: notify,
  });
  await pump();
  expect(route).toHaveBeenCalledWith(
    expect.objectContaining({ chatJid: state.route.chatJid }),
  );
  expect(notify).toHaveBeenCalledWith(
    state.route.chatJid,
    expect.stringContaining('Game build returned'),
    { identityId: state.route.identityId, tenantId: state.route.tenantId },
  );
  expect(peerInboxPromptContext(db, config.ownerJid, config)).toBe('');
  expect(
    peerInboxPromptContext(
      db,
      state.route.chatJid,
      config,
      new Date().toISOString(),
      state.route,
    ),
  ).toContain('Game build returned');
  expect(mock.record).toHaveBeenCalledTimes(1);
  const receipt = JSON.parse(
    fs.readFileSync(path.join(root, 'receipts', raw.eventId + '.json'), 'utf8'),
  );
  expect(receipt).toMatchObject({
    received: true,
    contextState: 'current',
    delivery: 'complete',
  });
});

it('does not expose a revoked or hash-mismatched result, and never accepts unsigned event authority', async () => {
  const raw = { ...event(), contextHash: 'f'.repeat(64) };
  ingestPeerInboxEvent(db, config, signPeerInboxEvent(config, raw));
  expect(
    peerInboxPromptContext(
      db,
      state.route.chatJid,
      config,
      new Date().toISOString(),
      state.route,
    ),
  ).not.toContain('Game build returned');
  state.routeAllowed = false;
  const route = vi.fn(async () => 'delivered');
  const pump = createPeerInboxPump(config, {
    db,
    router: { route } as never,
    ownerAvailable: () => true,
    notifyActive: () => true,
  });
  await pump();
  expect(route).not.toHaveBeenCalled();
  expect(
    peerInboxPromptContext(
      db,
      state.route.chatJid,
      config,
      new Date().toISOString(),
      state.route,
    ),
  ).toBe('');
  expect(() =>
    ingestPeerInboxEvent(db, config, { ...event(), signature: '0'.repeat(64) }),
  ).toThrow();
});

it('keeps legacy jobs usable if the optional factory configuration is unavailable', () => {
  mock.states.set(
    'legacy-config-failure',
    new Error('factory configuration unavailable'),
  );
  expect(
    createGameFactoryPeerHostAdapter(config, 'legacy-config-failure', {
      ...payload(),
      contract: { ...payload().contract, parentTaskId: 'legacy-parent' },
    }),
  ).toBeNull();
  mock.states.set(jobId, new Error('factory configuration unavailable'));
  expect(() =>
    createGameFactoryPeerHostAdapter(config, jobId, payload()),
  ).toThrow();
});
