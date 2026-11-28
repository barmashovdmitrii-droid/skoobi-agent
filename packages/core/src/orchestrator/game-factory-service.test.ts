import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FactoryActor,
  FactoryConfiguration,
  FactoryProject,
  FactoryRequest,
} from './game-factory-contracts.js';
import { FactoryError } from './game-factory-contracts.js';
import {
  ensureGameFactorySchema,
  GameFactoryStore,
} from './game-factory-store.js';
import {
  GameFactoryService,
  readGameFactoryActorPolicy,
  readGameFactoryConfiguration,
  verifyFactoryCurrentSource,
} from './game-factory-service.js';

const owner: FactoryActor = {
  identityId: 'test-owner',
  tenantId: 'test-tenant-a',
  chatJid: 'tg:test-owner',
  channelChatId: 'test-owner',
  sourceGroup: 'test-owner-group',
  senderId: 'test-sender-a',
  currentMessageIds: ['message-a'],
  runId: 'run-a',
  isPrimaryOwner: true,
};
const editor: FactoryActor = {
  identityId: 'test-editor',
  tenantId: 'test-tenant-b',
  chatJid: 'tg:test-editor',
  channelChatId: 'test-editor',
  sourceGroup: 'test-editor-group',
  senderId: 'test-sender-b',
  currentMessageIds: ['message-b'],
  runId: 'run-b',
};
const outsider: FactoryActor = {
  ...editor,
  identityId: 'test-outsider',
  tenantId: 'test-tenant-c',
};
const brief = {
  goal: 'Завершить маленькую игру',
  audience: 'Новые игроки',
  firstSession: 'Понятная первая цель',
  coreLoop: 'Выбор, действие, награда',
  artDirection: 'Единый стиль',
  acceptance: ['Цикл доступен обычным вводом'],
  devices: ['desktop'],
  platforms: ['crazygames'],
  exclusions: ['Не публиковать'],
  budget: { currency: 'USD', limitMicros: 0 },
  publication: 'prepare_only',
};
let db: Database.Database,
  store: GameFactoryStore,
  service: GameFactoryService,
  temp: string;
let config: FactoryConfiguration, sequence: number, now: string;
let verifyCurrentSource = vi.fn();
const request = (
  action: string,
  args: Record<string, unknown> = {},
  projectId = 'test-game',
  expectedRevision?: number,
): FactoryRequest => ({
  operationId: `request-${++sequence}`,
  action,
  args,
  projectId,
  expectedRevision,
});
const mutate = (
  actor: FactoryActor,
  action: string,
  args: Record<string, unknown> = {},
) =>
  service.execute(
    actor,
    request(action, args, 'test-game', store.read(actor, 'test-game').revision),
  );
const create = () =>
  service.execute(
    owner,
    request(
      'create',
      { title: 'Тестовая игра', engine: 'canvas', brief },
      'test-game',
      0,
    ),
  );
const tasks = [
  {
    id: 'first-task',
    stage: 'playable',
    title: 'Законченный эпизод',
    acceptance: ['Работает управление'],
    dependencies: [],
  },
];

beforeEach(() => {
  temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-service-test-')),
  );
  db = new Database(':memory:');
  ensureGameFactorySchema(db);
  store = new GameFactoryStore(db);
  config = {
    version: 1,
    enabled: true,
    primaryOwnerIdentityId: owner.identityId,
    workspaceRoot: path.join(temp, 'work'),
    databasePath: path.join(temp, 'state.db'),
    actors: [
      {
        identityId: owner.identityId,
        tenantId: owner.tenantId,
        alias: 'owner',
        canCreate: true,
        backends: ['agent', 'peer', 'codex_desktop'],
        sourceRoots: [temp],
      },
      {
        identityId: editor.identityId,
        tenantId: editor.tenantId,
        alias: 'editor',
        canCreate: true,
        backends: ['agent', 'codex_desktop'],
        sourceRoots: [temp],
      },
      {
        identityId: outsider.identityId,
        tenantId: outsider.tenantId,
        alias: 'outsider',
        canCreate: false,
        backends: ['agent'],
        sourceRoots: [temp],
      },
    ],
  };
  fs.mkdirSync(config.workspaceRoot, { mode: 0o700 });
  sequence = 0;
  now = '2026-11-04T15:00:00.000Z';
  verifyCurrentSource = vi.fn();
  service = new GameFactoryService(config, store, {
    now: () => now,
    verifyCurrentSource,
  });
});
afterEach(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('game factory project ownership and revisions', () => {
  it('filters lists, rejects guessed IDs and shares only an explicit project', () => {
    create();
    expect(store.list(editor)).toEqual([]);
    expect(() => service.execute(editor, request('inspect'))).toThrow(
      'project_unavailable',
    );
    expect(() =>
      service.execute(outsider, request('inspect', {}, 'other-game')),
    ).toThrow('project_unavailable');
    mutate(owner, 'share', { alias: 'editor', role: 'editor' });
    expect(store.list(editor).map((p) => p.id)).toEqual(['test-game']);
    expect(store.list(outsider)).toEqual([]);
    expect(() =>
      mutate(editor, 'share', { alias: 'outsider', role: 'reader' }),
    ).toThrow('project_unavailable');
  });

  it('does not trust an identity copied into another tenant or a model actor field', () => {
    create();
    expect(() =>
      service.execute({ ...owner, tenantId: editor.tenantId }, request('list')),
    ).toThrow('factory_actor_disabled');
    expect(() =>
      service.execute(editor, {
        ...request('list'),
        actor: owner,
      } as FactoryRequest),
    ).toThrow('invalid_input');
  });

  it('replays the same operation once, rejects changed content and stale updates', () => {
    create();
    const q = request(
      'decision',
      { key: 'visual-style', value: 'Тёплые цвета', state: 'accepted' },
      'test-game',
      1,
    );
    const first = service.execute(owner, q);
    expect(service.execute(owner, q)).toEqual(first);
    expect(store.read(owner, 'test-game').decisions).toHaveLength(1);
    expect(() =>
      service.execute(owner, {
        ...q,
        args: { ...q.args, value: 'Холодные цвета' },
      }),
    ).toThrow('operation_id_conflict');
    expect(() =>
      service.execute(
        owner,
        request(
          'decision',
          { key: 'music-style', value: 'Тихая музыка', state: 'proposed' },
          'test-game',
          1,
        ),
      ),
    ).toThrow('revision_conflict');
    expect(store.read(owner, 'test-game').revision).toBe(2);
  });

  it('revocation prevents replaying a previously authorized read-bearing mutation', () => {
    create();
    mutate(owner, 'share', { alias: 'editor', role: 'editor' });
    const q = request(
      'decision',
      { key: 'shared-note', value: 'Игровое решение', state: 'proposed' },
      'test-game',
      2,
    );
    service.execute(editor, q);
    mutate(owner, 'share', { alias: 'editor', role: null });
    expect(() => service.execute(editor, q)).toThrow('project_unavailable');
  });

  it('blocks owner-only desktop for a shared editor even when backend appears in policy', () => {
    create();
    mutate(owner, 'share', { alias: 'editor', role: 'editor' });
    mutate(owner, 'plan', { tasks });
    expect(() =>
      mutate(editor, 'claim', {
        taskId: 'first-task',
        backend: 'codex_desktop',
      }),
    ).toThrow('backend_owner_only');
    expect(store.read(owner, 'test-game').lease).toBeNull();
    mutate(editor, 'claim', { taskId: 'first-task', backend: 'agent' });
    expect(store.read(editor, 'test-game').lease?.actorKey).not.toEqual(
      store.read(editor, 'test-game').ownerKey,
    );
  });

  it('rolls back member/state changes if callback fails', () => {
    create();
    expect(() =>
      store.mutate(
        owner,
        request('share', {}, 'test-game', 1),
        ['owner'],
        now,
        (project) => {
          store.setMember(project, 'synthetic-key', 'editor');
          project.title = 'Не сохранять';
          throw new FactoryError('probe_failure');
        },
      ),
    ).toThrow('probe_failure');
    expect(store.read(owner, 'test-game').title).toBe('Тестовая игра');
    expect(store.members(owner, 'test-game')).toHaveLength(1);
  });

  it('forgets decision text and removes old response snapshots without reviving tombstones', () => {
    create();
    const q = request(
      'decision',
      {
        key: 'old-idea',
        value: 'Удаляемое игровое решение',
        state: 'accepted',
      },
      'test-game',
      1,
    );
    service.execute(owner, q);
    mutate(owner, 'forget_decision', { key: 'old-idea' });
    expect(JSON.stringify(store.read(owner, 'test-game'))).not.toContain(
      'Удаляемое игровое решение',
    );
    expect(service.execute(owner, q)).toMatchObject({
      historicalResultRedacted: true,
    });
    expect(() =>
      mutate(owner, 'decision', {
        key: 'old-idea',
        value: 'Воскресшее старое решение',
        state: 'accepted',
      }),
    ).toThrow('forgotten_decision_requires_new_explicit_source');
  });
});

describe('writer fencing and continuity', () => {
  it('allows one writer and rejects expired takeover, copied token and new run identity', () => {
    create();
    mutate(owner, 'share', { alias: 'editor', role: 'editor' });
    mutate(owner, 'plan', { tasks });
    mutate(owner, 'claim', {
      taskId: 'first-task',
      backend: 'agent',
      ttlSeconds: 60,
    });
    const token = store.read(owner, 'test-game').lease!.token;
    expect(() =>
      mutate(editor, 'claim', { taskId: 'first-task', backend: 'agent' }),
    ).toThrow('writer_already_claimed');
    expect(() =>
      mutate(editor, 'checkpoint', {
        token,
        summary: 'Чужой токен',
        state: 'working',
      }),
    ).toThrow('writer_lease_mismatch');
    expect(() =>
      mutate({ ...owner, runId: 'another-run' }, 'checkpoint', {
        token,
        summary: 'Другой запуск',
        state: 'working',
      }),
    ).toThrow('writer_lease_mismatch');
    now = '2026-11-04T15:02:00.000Z';
    expect(() =>
      mutate(editor, 'claim', { taskId: 'first-task', backend: 'agent' }),
    ).toThrow('lease_reconciliation_required');
    expect(() =>
      mutate(owner, 'checkpoint', {
        token,
        summary: 'Просрочено',
        state: 'working',
      }),
    ).toThrow('lease_reconciliation_required');
  });

  it('new brief supersedes pending work and fences the active writer', () => {
    create();
    mutate(owner, 'plan', { tasks });
    mutate(owner, 'claim', { taskId: 'first-task', backend: 'agent' });
    const token = store.read(owner, 'test-game').lease!.token;
    mutate(owner, 'brief', {
      ...brief,
      goal: 'Спасти героя вместо разрушения',
    });
    const project = store.read(owner, 'test-game');
    expect(project.brief.revision).toBe(2);
    expect(project.briefHistory).toHaveLength(1);
    expect(project.tasks[0].state).toBe('superseded');
    expect(project.lease?.state).toBe('reconcile_required');
    expect(() =>
      mutate(owner, 'checkpoint', {
        token,
        summary: 'Старая работа',
        state: 'submitted',
      }),
    ).toThrow('writer_lease_mismatch');
  });

  it('current input guard runs before all writes but status remains available', () => {
    create();
    verifyCurrentSource.mockImplementation(() => {
      throw new FactoryError('newer_user_input_pending');
    });
    expect(() => mutate(owner, 'pause')).toThrow('newer_user_input_pending');
    expect(store.read(owner, 'test-game').status).toBe('active');
    expect(service.execute(owner, request('inspect'))).toMatchObject({
      role: 'owner',
    });
  });

  it('a reported reference neither claims execution nor permanently locks a writer', () => {
    create();
    mutate(owner, 'plan', { tasks });
    mutate(owner, 'claim', { taskId: 'first-task', backend: 'agent' });
    const token = store.read(owner, 'test-game').lease!.token;
    mutate(owner, 'operation_link', {
      kind: 'peer',
      externalId: 'synthetic-job',
      taskId: 'first-task',
    });
    expect(store.read(owner, 'test-game').operations[0]).toMatchObject({
      evidence: 'reported',
      tracking: 'reference_only',
    });
    mutate(owner, 'release_claim', { token });
    expect(store.read(owner, 'test-game').lease).toBeNull();
  });

  it('does not label an unverified model report as host execution or publication', () => {
    create();
    const linked = mutate(owner, 'operation_link', {
      kind: 'peer',
      externalId: 'synthetic-job',
    }) as { operation: { evidence: string; state: string } };
    expect(linked.operation).toMatchObject({
      evidence: 'reported',
      state: 'linked',
    });
    expect(() =>
      mutate(owner, 'operation_link', {
        kind: 'peer',
        externalId: 'forged-job',
        evidence: 'host_observed',
        state: 'completed',
      }),
    ).toThrow('invalid_input');
    expect(service.execute(owner, request('capabilities'))).toMatchObject({
      publication: 'prepare_only',
    });
  });

  it('pause cannot resurrect a cancelled project', () => {
    create();
    mutate(owner, 'cancel');
    expect(() => mutate(owner, 'pause')).toThrow(
      'only_active_project_can_pause',
    );
    expect(() => mutate(owner, 'resume')).toThrow(
      'only_paused_project_can_resume',
    );
    expect(store.read(owner, 'test-game').status).toBe('cancelled');
  });

  it('a changed accepted decision invalidates the writer even without editing goal text', () => {
    create();
    mutate(owner, 'decision', {
      key: 'art-style',
      value: 'Яркий стиль',
      state: 'accepted',
    });
    mutate(owner, 'plan', { tasks });
    mutate(owner, 'claim', { taskId: 'first-task', backend: 'agent' });
    const revision = store.read(owner, 'test-game').brief.revision;
    mutate(owner, 'decision', {
      key: 'art-style',
      value: 'Нужно пересмотреть',
      state: 'proposed',
    });
    const p = store.read(owner, 'test-game');
    expect(p.brief.revision).toBe(revision + 1);
    expect(p.lease?.state).toBe('reconcile_required');
  });

  it('releases the same stopped writer after a correction but does not accept its stale result', () => {
    create();
    mutate(owner, 'plan', { tasks });
    mutate(owner, 'claim', { taskId: 'first-task', backend: 'agent' });
    const token = store.read(owner, 'test-game').lease!.token;
    mutate(owner, 'brief', { ...brief, goal: 'Уточнённая цель' });
    mutate(owner, 'release_claim', { token });
    expect(store.read(owner, 'test-game').lease).toBeNull();
    expect(store.read(owner, 'test-game').tasks[0].state).toBe('superseded');
  });

  it('reconciles only a host-confirmed finished run and gives the next writer a new directory', () => {
    create();
    mutate(owner, 'plan', { tasks });
    const first = mutate(owner, 'claim', {
      taskId: 'first-task',
      backend: 'agent',
    }) as { workDirectory: string };
    const observeRun = vi.fn(
      (): 'active' | 'finished' | 'unknown' => 'unknown',
    );
    service = new GameFactoryService(config, store, {
      now: () => now,
      verifyCurrentSource,
      observeRun,
    });
    expect(() => mutate({ ...owner, runId: 'run-next' }, 'reconcile')).toThrow(
      'previous_execution_not_confirmed_finished',
    );
    observeRun.mockReturnValue('active');
    expect(() => mutate({ ...owner, runId: 'run-next' }, 'reconcile')).toThrow(
      'previous_execution_not_confirmed_finished',
    );
    observeRun.mockReturnValue('finished');
    mutate({ ...owner, runId: 'run-next' }, 'reconcile');
    const next = mutate({ ...owner, runId: 'run-next' }, 'claim', {
      taskId: 'first-task',
      backend: 'agent',
    }) as { workDirectory: string };
    expect(next.workDirectory).not.toBe(first.workDirectory);
    expect(fs.existsSync(first.workDirectory)).toBe(true);
  });

  it('replanning preserves task lineage and rejects reusing an old task ID', () => {
    create();
    mutate(owner, 'plan', { tasks });
    expect(() => mutate(owner, 'plan', { tasks })).toThrow(
      'task_id_already_used',
    );
    mutate(owner, 'plan', { tasks: [{ ...tasks[0], id: 'new-task' }] });
    expect(store.read(owner, 'test-game').taskHistory[0]).toMatchObject({
      id: 'first-task',
      state: 'superseded',
    });
    expect(store.read(owner, 'test-game').tasks[0].id).toBe('new-task');
  });
});

describe('private configuration and read-only inspection', () => {
  it('does not create state during empty inspection', () => {
    const empty = new Database(':memory:');
    try {
      const emptyStore = new GameFactoryStore(empty);
      expect(emptyStore.list(owner)).toEqual([]);
      expect(emptyStore.hasSchema()).toBe(false);
    } finally {
      empty.close();
    }
  });

  it('missing config is disabled and world-readable or duplicate actors fail closed', () => {
    const file = path.join(temp, 'factory.json');
    vi.stubEnv('SKOOBI_GAME_FACTORY_CONFIG', file);
    expect(readGameFactoryActorPolicy()).toEqual({
      enabledActorIdentityIds: [],
    });
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    expect(readGameFactoryActorPolicy().enabledActorIdentityIds).toHaveLength(
      3,
    );
    fs.chmodSync(file, 0o644);
    expect(() => readGameFactoryConfiguration()).toThrow(
      'configuration_not_private',
    );
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...config,
        actors: [...config.actors, config.actors[0]],
      }),
    );
    expect(readGameFactoryActorPolicy()).toEqual({
      enabledActorIdentityIds: [],
    });
  });

  it('checks durable direct provenance and ingested corrections, not timestamp sorting', () => {
    db.exec(`CREATE TABLE messages(id TEXT,chat_jid TEXT,sender TEXT,is_bot_message INTEGER);
      CREATE TABLE message_ingestion(id TEXT,chat_jid TEXT,sequence INTEGER);
      CREATE TABLE message_metadata(id TEXT,chat_jid TEXT,sender_identity_json TEXT);`);
    const insert = (messageId: string, sequence: number, origin = 'direct') => {
      db.prepare('INSERT INTO messages VALUES(?,?,?,0)').run(
        messageId,
        owner.chatJid,
        owner.senderId,
      );
      db.prepare('INSERT INTO message_ingestion VALUES(?,?,?)').run(
        messageId,
        owner.chatJid,
        sequence,
      );
      db.prepare('INSERT INTO message_metadata VALUES(?,?,?)').run(
        messageId,
        owner.chatJid,
        JSON.stringify({
          telegram_message_origin: origin,
          channel: 'telegram',
          chat_id: owner.channelChatId,
          identity_id: owner.identityId,
          telegram_user_id: owner.senderId,
          is_owner_sender: true,
        }),
      );
    };
    insert('message-a', 1);
    expect(() => verifyFactoryCurrentSource(owner, db)).not.toThrow();
    insert('forwarded-a', 2, 'forwarded');
    expect(() => verifyFactoryCurrentSource(owner, db)).not.toThrow();
    insert('correction-a', 3);
    expect(() => verifyFactoryCurrentSource(owner, db)).toThrow(
      'newer_user_input_pending',
    );
    expect(() =>
      verifyFactoryCurrentSource(
        { ...owner, currentMessageIds: ['message-a', 'correction-a'] },
        db,
      ),
    ).not.toThrow();
    expect(() =>
      verifyFactoryCurrentSource(
        { ...owner, currentMessageIds: ['forwarded-a'] },
        db,
      ),
    ).toThrow('current_direct_source_required');
  });
});
