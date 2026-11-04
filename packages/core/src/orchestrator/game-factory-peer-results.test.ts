import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CODE_ROOT } from './config.js';
import { GameFactoryService } from './game-factory-service.js';
import {
  ensureGameFactorySchema,
  GameFactoryStore,
  factoryActorKey,
} from './game-factory-store.js';
import {
  readFactoryPeerBinding,
  readGameFactoryPeerState,
} from './game-factory-peer-state.js';
import { buildGameFactoryPeerContext } from './game-factory-peer-adapter.js';
import {
  ingestPeerInboxEvent,
  signPeerInboxEvent,
  type PeerBridgeConfig,
  type PeerInboxEvent,
} from './peer-inbox.js';
import {
  inspectFactoryPeerResult,
  importFactoryPeerResult,
} from './game-factory-peer-results.js';
import type {
  FactoryActor,
  FactoryConfiguration,
} from './game-factory-contracts.js';

const actor: FactoryActor = {
  identityId: 'fixture-peer-owner',
  tenantId: 'fixture-owner-tenant',
  chatJid: 'tg:7000001',
  channelChatId: '7000001',
  senderId: '7000001',
  sourceGroup: 'telegram_main',
  currentMessageIds: ['fixture-message'],
  runId: 'fixture-run',
};
const editor: FactoryActor = {
  ...actor,
  identityId: 'fixture-editor',
  tenantId: 'fixture-editor-tenant',
  chatJid: 'tg:7000002',
  channelChatId: '7000002',
  senderId: '7000002',
  sourceGroup: 'editor-main',
};
const sha = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');
let root: string,
  db: Database.Database,
  inbox: Database.Database,
  store: GameFactoryStore,
  service: GameFactoryService,
  config: FactoryConfiguration,
  bridge: PeerBridgeConfig,
  jobs: any,
  core: any,
  acceptance: any,
  jobId: string,
  sequence: number,
  artifactPath: string,
  destination: string;
const projectId = 'fixture-game';
function request(
  action: string,
  args: Record<string, unknown>,
  revision = store.read(actor, projectId).revision,
) {
  return service.execute(actor, {
    action,
    args,
    operationId: `fixture-op-${++sequence}`,
    projectId,
    expectedRevision: revision,
  }) as any;
}
function zip(
  entries: Array<{
    name: string;
    data?: string;
    mode?: number;
    repeat?: number;
  }>,
): Buffer {
  const result = spawnSync(
    '/usr/bin/python3',
    [
      '-I',
      '-c',
      `import io,json,sys,zipfile
q=json.load(sys.stdin);out=io.BytesIO()
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED) as z:
 for e in q:
  i=zipfile.ZipInfo(e['name']);i.compress_type=zipfile.ZIP_DEFLATED;i.external_attr=e.get('mode',0o100600)<<16
  z.writestr(i,e.get('data','')*e.get('repeat',1))
sys.stdout.buffer.write(out.getvalue())`,
    ],
    { input: JSON.stringify(entries), maxBuffer: 20 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error('Fixture zip failed');
  return result.stdout;
}
const validZip = () =>
  zip([
    {
      name: 'index.html',
      data: '<!doctype html><html><title>Fixture game</title><script src="game.js"></script><canvas></canvas></html>',
    },
    { name: 'game.js', data: 'document.querySelector("canvas").width=320;' },
  ]);

beforeEach(async () => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-peer-result-test-')),
  );
  fs.chmodSync(root, 0o700);
  for (const dir of ['peer', 'bridge', 'workspace', 'builds'])
    fs.mkdirSync(path.join(root, dir), { mode: 0o700 });
  destination = path.join(root, 'builds', 'selected');
  const coordinatorPath = path.join(root, 'coordinator.json');
  fs.writeFileSync(
    coordinatorPath,
    JSON.stringify({
      schema: 1,
      role: 'coordinator',
      nodeId: 'fixture-mini',
      networkId: 'a'.repeat(24),
      ownerJid: actor.chatJid,
      ownerGroupFolder: 'telegram_main',
      projectRoot: root,
      stateRoot: path.join(root, 'peer'),
    }),
    { mode: 0o600 },
  );
  config = {
    version: 1,
    enabled: true,
    primaryOwnerIdentityId: actor.identityId,
    databasePath: path.join(root, 'factory.db'),
    workspaceRoot: path.join(root, 'workspace'),
    actors: [actor, editor].map((a, i) => ({
      identityId: a.identityId,
      tenantId: a.tenantId,
      alias: i ? 'fixture-editor' : 'fixture-owner',
      canCreate: true,
      backends: ['peer', 'agent'],
      sourceRoots: [path.join(root, 'workspace')],
    })),
    peer: {
      networkId: 'a'.repeat(24),
      coordinatorConfigPath: coordinatorPath,
      model: 'fixture-model',
      reasoningEffort: 'high',
    },
  };
  const configPath = path.join(root, 'factory.json');
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  vi.stubEnv('SKOOBI_GAME_FACTORY_CONFIG', configPath);
  db = new Database(config.databasePath);
  fs.chmodSync(config.databasePath, 0o600);
  ensureGameFactorySchema(db);
  store = new GameFactoryStore(db);
  inbox = new Database(':memory:');
  core = await import(
    pathToFileURL(path.join(CODE_ROOT, 'ops/peer/skoobi-peer-core.mjs')).href
  );
  acceptance = await import(
    pathToFileURL(path.join(CODE_ROOT, 'ops/peer/skoobi-peer-acceptance.mjs'))
      .href
  );
  service = new GameFactoryService(config, store, {
    verifyCurrentSource: () => {},
    validatePeerPayload: ({ jobId, contract, context }) => {
      core.validatePeerContract(contract);
      core.validatePeerContext(context, { id: jobId, contract });
    },
  });
  sequence = 0;
  request(
    'create',
    {
      title: 'Fixture shared game',
      engine: 'canvas',
      brief: {
        goal: 'Build a complete small game',
        audience: 'Players',
        firstSession: 'Play one round',
        coreLoop: 'Collect and return',
        artDirection: 'Simple shapes',
        acceptance: ['Can start and finish'],
        devices: ['desktop'],
        platforms: ['crazygames'],
        exclusions: [],
      },
    },
    0,
  );
  request('plan', {
    tasks: [
      {
        id: 'fixture-task',
        stage: 'playable',
        title: 'Produce game files',
        acceptance: ['Return a game'],
        dependencies: [],
      },
    ],
  });
  request('claim', { taskId: 'fixture-task', backend: 'peer' });
  const key = path.join(root, 'bridge', 'key');
  fs.writeFileSync(key, Buffer.alloc(32, 8), { mode: 0o600 });
  bridge = {
    schema: 1,
    root: path.join(root, 'bridge'),
    ownerGroupFolder: actor.sourceGroup,
    ownerJid: actor.chatJid,
    identityId: actor.identityId,
    tenantId: actor.tenantId,
    networkId: config.peer!.networkId,
    signingKeyPath: key,
    projectRoot: root,
  };
  jobs = new core.JobStore(path.join(root, 'peer'));
});
afterEach(() => {
  db.close();
  inbox.close();
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function complete(
  outputs: Array<{ name: string; data: Buffer }>,
  state = 'succeeded',
  declaredNames = outputs.map((output) => output.name),
) {
  jobId = request('peer_dispatch', {
    token: store.read(actor, projectId).lease!.token,
    expectedOutputs: declaredNames.map((name) => ({ name, kind: 'document' })),
    acceptance: declaredNames.map((name, i) => ({
      id: `file-${i}`,
      description: 'Return declared file',
      kind: 'file_present',
      outputName: name,
    })),
  }).peerJobId;
  const binding = readFactoryPeerBinding(db, jobId)!,
    context = buildGameFactoryPeerContext(readGameFactoryPeerState(jobId)!);
  jobs.submit({ schema: 2, id: jobId, ...binding.dispatch.options, context });
  const artifactRoot = path.join(jobs.dir(jobId), 'artifacts');
  fs.mkdirSync(artifactRoot, { mode: 0o700 });
  fs.mkdirSync(path.join(bridge.root, 'artifacts'), { mode: 0o700 });
  const signedRoot = path.join(bridge.root, 'artifacts', jobId);
  fs.mkdirSync(signedRoot, { mode: 0o700 });
  const artifacts = outputs.map((output) => {
    const hash = sha(output.data),
      name = hash + path.extname(output.name),
      localPath = path.join(artifactRoot, name);
    fs.writeFileSync(localPath, output.data, { mode: 0o600 });
    fs.writeFileSync(path.join(signedRoot, name), output.data, { mode: 0o600 });
    return {
      name,
      displayName: output.name,
      localPath,
      sha256: hash,
      bytes: output.data.length,
      kind: 'document',
    };
  });
  artifactPath = artifacts[0].localPath;
  const remote = {
    id: jobId,
    revision: 1,
    state,
    result: {
      revision: 1,
      contextSha256: context.sha256,
      runtime: { requestedModel: 'fixture-model', requestedEffort: 'high' },
      summary: 'Worker claim',
    },
    deliveries: [],
    artifacts: artifacts.map(({ localPath: _path, ...rest }) => rest),
  };
  const resultHash = acceptance.peerResultDigest(remote, artifacts),
    eventId = 'fixture-peer-result';
  jobs.update(jobId, {
    state,
    remoteResult: remote,
    localArtifacts: artifacts,
    assessment: { resultHash, status: 'passed' },
    resultEventId: eventId,
  });
  const at = new Date().toISOString();
  const event: PeerInboxEvent = {
    schema: 1,
    eventId,
    eventKind: 'result',
    jobId,
    revision: 1,
    parentTaskId: binding.parentTaskId,
    projectKey: projectId,
    receivedAt: at,
    resultReceivedAt: at,
    resultState: state,
    resultHash,
    contextHash: context.sha256,
    contextValidity: {
      scopeRevisionHash: binding.scopeRevisionHash,
      expiresAt: binding.expiresAt,
    },
    notify: false,
    verification: {
      status: 'passed',
      summary: 'Fixture transport receipt, no gameplay approval',
    },
    summary: 'Worker claim',
    artifacts: artifacts.map((a) => ({
      name: a.name,
      path: path.join(signedRoot, a.name),
      sha256: a.sha256,
      bytes: a.bytes,
      kind: 'document',
    })),
  };
  ingestPeerInboxEvent(inbox, bridge, signPeerInboxEvent(bridge, event));
}
const inspect = (who = actor, project = projectId) =>
  inspectFactoryPeerResult(
    who,
    { projectId: project, jobId },
    { inboxDb: inbox },
  );
const copy = (extra: Record<string, unknown> = {}) =>
  importFactoryPeerResult(
    {
      actor,
      projectId,
      jobId,
      artifactName: 'game.zip',
      entrypoint: 'index.html',
      destinationRoot: destination,
      ...extra,
    },
    { inboxDb: inbox },
  );

it('imports a real received signed game.zip into an immutable manifest without accepting game quality', async () => {
  complete([{ name: 'game.zip', data: validZip() }]);
  const observation = await inspect();
  expect(observation.artifacts[0].name).toBe('game.zip');
  expect(JSON.stringify(observation)).not.toContain(root);
  expect(JSON.stringify(observation)).not.toContain('Worker claim');
  const manifest = await copy();
  expect(manifest.sourceRoot).toBe(destination);
  expect(manifest.files.map((f) => f.path)).toEqual(['game.js', 'index.html']);
  expect(manifest.qualityAccepted).toBe(false);
  expect(manifest.peerReceipt.resultSha256).toBe(observation.resultSha256);
  expect(await copy()).toEqual(manifest);
  expect(store.read(actor, projectId).tasks[0].state).not.toBe('accepted');
  jobs.update(jobId, { resultEventId: 'a-later-review-event' });
  expect(await inspect()).toEqual(observation);
});
it('imports the exact flat-file set and allows another explicitly authorized project editor', async () => {
  complete([
    {
      name: 'index.html',
      data: Buffer.from('<html><script src="game.js"></script></html>'),
    },
    { name: 'game.js', data: Buffer.from('const fixture=1;') },
  ]);
  request('share', { alias: 'fixture-editor', role: 'editor' });
  const result = await importFactoryPeerResult(
    {
      actor: editor,
      projectId,
      jobId,
      entrypoint: 'index.html',
      destinationRoot: destination,
    },
    { inboxDb: inbox },
  );
  expect(result.files.map((f) => f.path)).toEqual(['game.js', 'index.html']);
  expect(result.qualityAccepted).toBe(false);
});
it('rejects a wrong project, revoked actor, changed requirements and a pending/uncertain result', async () => {
  complete([{ name: 'game.zip', data: validZip() }]);
  await expect(inspect(actor, 'unavailable-project')).rejects.toThrow();
  await expect(inspect(editor)).rejects.toThrow();
  request('share', { alias: 'fixture-editor', role: 'editor' });
  expect((await inspect(editor)).jobId).toBe(jobId);
  request('share', { alias: 'fixture-editor', role: null });
  await expect(inspect(editor)).rejects.toThrow();
  const {
    source: _source,
    revision: _revision,
    ...brief
  } = store.read(actor, projectId).brief;
  request('brief', { ...brief, goal: 'Changed goal' });
  await expect(copy()).rejects.toThrow();
  expect(fs.existsSync(destination)).toBe(false);
});
it('does not import needs_review or unsigned/manual state even when files exist', async () => {
  complete([{ name: 'game.zip', data: validZip() }], 'needs_review');
  await expect(copy()).rejects.toThrow();
  expect(fs.existsSync(destination)).toBe(false);
});
it.each(['bytes', 'event', 'receipt', 'localPath', 'symlink', 'hardlink'])(
  'rejects changed %s in the authenticated receipt/file chain',
  async (kind) => {
    complete([{ name: 'game.zip', data: validZip() }]);
    if (kind === 'bytes') fs.appendFileSync(artifactPath, 'tampered');
    else if (kind === 'event')
      inbox.exec("UPDATE peer_result_events SET payload_json='{}'");
    else if (kind === 'receipt') db.exec('DELETE FROM factory_peer_events');
    else if (kind === 'localPath') {
      const artifacts = jobs.state(jobId).localArtifacts;
      artifacts[0].localPath = path.join(root, 'private.zip');
      jobs.update(jobId, { localArtifacts: artifacts });
    } else {
      const original = artifactPath + '.original';
      fs.renameSync(artifactPath, original);
      if (kind === 'symlink') fs.symlinkSync(original, artifactPath);
      else fs.linkSync(original, artifactPath);
    }
    await expect(copy()).rejects.toThrow();
    expect(fs.existsSync(destination)).toBe(false);
  },
);
it.each([
  { name: '../escape.js', data: 'x' },
  { name: '/absolute.js', data: 'x' },
  { name: 'C:\\escape.js', data: 'x' },
  { name: '.env', data: 'private' },
  { name: 'auth.json', data: '{}' },
  { name: 'memory/personal.json', data: '{}' },
  { name: 'link.js', data: 'target', mode: 0o120777 },
  { name: 'oversized.js', data: 'A', repeat: 1000000 },
])('rejects unsafe ZIP entry $name rather than omitting it', async (entry) => {
  complete([
    {
      name: 'game.zip',
      data: zip([{ name: 'index.html', data: '<html></html>' }, entry]),
    },
  ]);
  await expect(copy()).rejects.toThrow('peer_archive_invalid');
  expect(fs.existsSync(destination)).toBe(false);
  expect(fs.existsSync(path.join(root, 'escape.js'))).toBe(false);
});
it('rejects case-colliding archive names and a missing entrypoint', async () => {
  complete([
    {
      name: 'game.zip',
      data: zip([
        { name: 'index.html', data: '<html></html>' },
        { name: 'INDEX.html', data: 'different' },
      ]),
    },
  ]);
  await expect(copy()).rejects.toThrow('peer_archive_invalid');
});
it('rejects case-colliding parent directories and ZIP directory/file collisions', async () => {
  complete([
    {
      name: 'game.zip',
      data: zip([
        { name: 'index.html', data: '<html></html>' },
        { name: 'Assets/a.js', data: 'const a=1;' },
        { name: 'assets/b.js', data: 'const b=1;' },
      ]),
    },
  ]);
  await expect(copy()).rejects.toThrow('peer_archive_invalid');
  expect(fs.existsSync(destination)).toBe(false);
});
it('rejects archives exceeding the entry-count cap', async () => {
  complete([
    {
      name: 'game.zip',
      data: zip([
        { name: 'index.html', data: '<html></html>' },
        ...Array.from({ length: 4096 }, (_, index) => ({
          name: `file-${index}.js`,
          data: 'x',
        })),
      ]),
    },
  ]);
  await expect(copy()).rejects.toThrow('peer_archive_invalid');
});
it('rejects private flat files instead of silently excluding them', async () => {
  complete([
    { name: 'index.html', data: Buffer.from('<html></html>') },
    { name: 'auth.json', data: Buffer.from('{}') },
  ]);
  await expect(copy({ artifactName: undefined })).rejects.toThrow(
    'peer_archive_invalid',
  );
});
it('does not label an incomplete flat-file response a complete build', async () => {
  complete(
    [{ name: 'index.html', data: Buffer.from('<html></html>') }],
    'succeeded',
    ['index.html', 'missing.js'],
  );
  await expect(copy({ artifactName: undefined })).rejects.toThrow(
    'peer_result_incomplete',
  );
  expect(fs.existsSync(destination)).toBe(false);
});
it('does not let a shared editor import with revoked peer backend permission', async () => {
  complete([{ name: 'game.zip', data: validZip() }]);
  request('share', { alias: 'fixture-editor', role: 'editor' });
  config.actors[1].backends = ['agent'];
  fs.writeFileSync(
    process.env.SKOOBI_GAME_FACTORY_CONFIG!,
    JSON.stringify(config),
    { mode: 0o600 },
  );
  await expect(copy({ actor: editor })).rejects.toThrow(
    'peer_result_unavailable',
  );
  expect(fs.existsSync(destination)).toBe(false);
});
it('imports a completed unchanged result after transport expiry without reviving the old execution', async () => {
  complete([{ name: 'game.zip', data: validZip() }]);
  const before = jobs.payload(jobId);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(Date.now() + 25 * 60 * 60 * 1000));
  expect(readGameFactoryPeerState(jobId)).toMatchObject({
    current: false,
    retainedResultCurrent: true,
    routeAllowed: true,
  });
  expect((await inspect()).jobId).toBe(jobId);
  const imported = await copy();
  expect(imported.files.map((file) => file.path)).toEqual([
    'game.js',
    'index.html',
  ]);
  expect(jobs.payload(jobId)).toEqual(before);
  expect(jobs.state(jobId).state).toBe('succeeded');
});
it('rejects empty output selection and undeclared ZIP content without pretending a complete build', async () => {
  complete([{ name: 'game.zip', data: validZip() }]);
  await expect(copy({ artifactName: 'not-declared.zip' })).rejects.toThrow();
  await expect(copy({ entrypoint: 'missing.html' })).rejects.toThrow(
    'peer_archive_invalid',
  );
});
