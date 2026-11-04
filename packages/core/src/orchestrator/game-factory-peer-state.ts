import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  FactoryActor,
  FactoryConfiguration,
  FactoryProject,
  FactoryTask,
} from './game-factory-contracts.js';
import { FactoryError } from './game-factory-contracts.js';
import { factoryActorKey, GameFactoryStore } from './game-factory-store.js';
import {
  readGameFactoryConfiguration,
  validateGameFactoryDatabaseLocation,
} from './game-factory-service.js';
import { peerCanonicalJson, type PeerContextRecord } from './peer-context.js';
import {
  buildGameFactoryPeerContext,
  prepareFactoryPeerJob,
  type GameFactoryPeerState,
} from './game-factory-peer-adapter.js';
import {
  isAuthenticatedPeerInboxEvent,
  type PeerInboxEvent,
} from './peer-inbox.js';

const digest = (value: unknown): string =>
  createHash('sha256').update(peerCanonicalJson(value)).digest('hex');
const JOB = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface FactoryPeerBinding extends Omit<
  GameFactoryPeerState,
  'current' | 'routeAllowed'
> {
  taskId: string;
  fencing: number;
  inputBuildIds: string[];
  dispatch: {
    coordinatorConfigPath: string;
    options: {
      title: string;
      prompt: string;
      notify: boolean;
      inputs: unknown[];
      contract: unknown;
    };
  };
}

/** Прогресс и доставка не меняют требования собственного задания. */
export function factoryPeerRequirementsHash(
  project: FactoryProject,
  task: FactoryTask,
  inputBuildIds: string[],
): string {
  const { source: _source, ...brief } = project.brief;
  const decisions = new Map(project.decisions.map((d) => [d.key, d]));
  return digest({
    brief,
    decisions: [...decisions.values()]
      .filter((d) => d.state === 'accepted' || d.state === 'forgotten')
      .map(({ key, value, state, revision }) => ({
        key,
        value,
        state,
        revision,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    task: {
      id: task.id,
      stage: task.stage,
      title: task.title,
      acceptance: task.acceptance,
      dependencies: task.dependencies,
      briefRevision: task.briefRevision,
      humanReviewRequired: task.humanReviewRequired === true,
    },
    inputs: inputBuildIds.map((id) => {
      const build = project.builds.find((b) => b.id === id);
      if (!build) throw new FactoryError('peer_input_build_unavailable');
      return { id: build.id, manifestSha256: build.manifestSha256 };
    }),
  });
}

function recordsFor(
  project: FactoryProject,
  task: FactoryTask,
  at: string,
  inputBuildIds: string[],
): PeerContextRecord[] {
  const records: PeerContextRecord[] = [];
  const add = (
    key: string,
    value: unknown,
    revision: number,
    updatedAt: string,
  ) => {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    const chunks: string[] = [];
    let chunk = '',
      bytes = 0;
    for (const char of raw) {
      const size = Buffer.byteLength(char);
      if (bytes + size > 3500) {
        chunks.push(chunk);
        chunk = '';
        bytes = 0;
      }
      chunk += char;
      bytes += size;
    }
    if (chunk) chunks.push(chunk);
    const stableKey =
      key.length > 60 ? `${key.slice(0, 36)}_${digest(key).slice(0, 20)}` : key;
    chunks.forEach((part, index) =>
      records.push({
        kind: key.startsWith('decision_') ? 'fact' : 'project',
        key: `${stableKey}${chunks.length > 1 ? `_${index + 1}` : ''}`,
        projectKey: project.id,
        revision,
        updatedAt,
        validUntil: null,
        value: part,
        source: {
          kind: 'assistant_report',
          at: updatedAt,
          trust: 'agent_interpreted',
        },
      }),
    );
  };
  const { source: _source, ...brief } = project.brief;
  add(
    'brief',
    { title: project.title, engine: project.engine, ...brief },
    project.brief.revision,
    project.brief.source.at,
  );
  add(
    'task',
    {
      id: task.id,
      stage: task.stage,
      title: task.title,
      acceptance: task.acceptance,
      dependencies: task.dependencies,
      rules:
        'Работать только внутри переданной задачи. Отчёт исполнителя не является приёмкой. Не читать личную память или конфигурацию владельца. Не публиковать и не оплачивать внешние действия.',
    },
    task.briefRevision,
    at,
  );
  for (const decision of project.decisions.filter(
    (d) => d.state === 'accepted',
  ))
    add(
      `decision_${decision.key}`,
      decision.value,
      decision.revision,
      decision.source.at,
    );
  if (inputBuildIds.length)
    add(
      'input_builds',
      inputBuildIds.map((id) => {
        const b = project.builds.find((build) => build.id === id);
        if (!b) throw new FactoryError('peer_input_build_unavailable');
        return {
          id: b.id,
          version: b.version,
          entrypoint: b.entrypoint,
          manifestSha256: b.manifestSha256,
          files: b.files.map((f) => f.path),
        };
      }),
      project.brief.revision,
      at,
    );
  if (
    records.length > 20 ||
    Buffer.byteLength(peerCanonicalJson(records)) > 60 * 1024
  )
    throw new FactoryError('peer_project_context_too_large');
  return records;
}

/** Вызывается хостом внутри той же транзакции, что и резервирование операции. */
export function bindGameFactoryPeerJob(input: {
  db: Database.Database;
  config: FactoryConfiguration;
  actor: FactoryActor;
  project: FactoryProject;
  task: FactoryTask;
  jobId: string;
  createdAt: string;
  expiresAt: string;
  inputBuildIds: string[];
  options: FactoryPeerBinding['dispatch']['options'];
}): FactoryPeerBinding {
  const { db, config, actor, project, task } = input;
  if (!config.peer || !JOB.test(input.jobId))
    throw new FactoryError('peer_configuration_unavailable');
  const policy = config.actors.find(
    (a) => a.identityId === actor.identityId && a.tenantId === actor.tenantId,
  );
  new GameFactoryStore(db).requireRole(actor, project.id, ['owner', 'editor']);
  if (
    !policy?.backends.includes('peer') ||
    project.status !== 'active' ||
    !project.lease ||
    project.lease.actorKey !== factoryActorKey(actor) ||
    project.lease.taskId !== task.id ||
    project.lease.backend !== 'peer'
  )
    throw new FactoryError('peer_dispatch_not_allowed');
  if (
    Date.parse(input.expiresAt) <= Date.parse(input.createdAt) ||
    Date.parse(input.expiresAt) - Date.parse(input.createdAt) >
      24 * 60 * 60 * 1000
  )
    throw new FactoryError('peer_context_expiry_invalid');
  const binding: FactoryPeerBinding = {
    jobId: input.jobId,
    parentTaskId: `factory:${input.jobId}`,
    projectId: project.id,
    taskId: task.id,
    peerRevision: 1,
    briefRevision: project.brief.revision,
    actorKey: factoryActorKey(actor),
    networkId: config.peer.networkId,
    scopeHash: digest([
      'skoobi.game_factory.peer.scope.v1',
      config.peer.networkId,
      factoryActorKey(actor),
      project.id,
    ]),
    scopeRevisionHash: factoryPeerRequirementsHash(
      project,
      task,
      input.inputBuildIds,
    ),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    records: recordsFor(project, task, input.createdAt, input.inputBuildIds),
    fencing: project.fencing,
    inputBuildIds: input.inputBuildIds,
    route: {
      chatJid: actor.chatJid,
      tenantId: actor.tenantId,
      identityId: actor.identityId,
      groupFolder: actor.sourceGroup,
    },
    dispatch: {
      coordinatorConfigPath: config.peer.coordinatorConfigPath,
      options: input.options,
    },
  };
  // Проверяем итоговый размер и точную форму до создания внешнего задания.
  buildGameFactoryPeerContext({
    ...binding,
    current: true,
    routeAllowed: true,
  });
  const prior = db
    .prepare('SELECT binding_json FROM factory_peer_bindings WHERE job_id=?')
    .get(binding.jobId) as { binding_json: string } | undefined;
  if (prior) {
    if (
      peerCanonicalJson(JSON.parse(prior.binding_json)) !==
      peerCanonicalJson(binding)
    )
      throw new FactoryError('peer_binding_conflict');
    return JSON.parse(prior.binding_json) as FactoryPeerBinding;
  }
  db.prepare(
    'INSERT INTO factory_peer_bindings(job_id,project_id,actor_key,binding_json,updated_at) VALUES(?,?,?,?,?)',
  ).run(
    binding.jobId,
    project.id,
    binding.actorKey,
    JSON.stringify(binding),
    input.createdAt,
  );
  return binding;
}

export function readFactoryPeerBinding(
  db: Database.Database,
  jobId: string,
): FactoryPeerBinding | null {
  if (!JOB.test(jobId)) return null;
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_peer_bindings'",
      )
      .get()
  )
    return null;
  const row = db
    .prepare('SELECT binding_json FROM factory_peer_bindings WHERE job_id=?')
    .get(jobId) as { binding_json: string } | undefined;
  return row ? (JSON.parse(row.binding_json) as FactoryPeerBinding) : null;
}

export function projectFactoryPeerState(
  db: Database.Database,
  config: FactoryConfiguration,
  binding: FactoryPeerBinding,
  at = new Date().toISOString(),
): GameFactoryPeerState {
  const actor: FactoryActor = {
    ...binding.route,
    sourceGroup: binding.route.groupFolder,
    identityId: binding.route.identityId,
    senderId: '',
    currentMessageIds: [],
    runId: '',
  };
  const store = new GameFactoryStore(db);
  const policy = config.actors.find(
    (p) => p.identityId === actor.identityId && p.tenantId === actor.tenantId,
  );
  const role = store.role(actor, binding.projectId);
  const routeAllowed =
    config.enabled &&
    !!policy?.backends.includes('peer') &&
    (role === 'owner' || role === 'editor');
  let current = false,
    retainedResultCurrent = false;
  if (routeAllowed && config.peer?.networkId === binding.networkId) {
    const project = store.read(actor, binding.projectId);
    const task = project.tasks.find((t) => t.id === binding.taskId);
    const operation = project.operations.find(
      (o) => o.kind === 'peer' && o.externalId === binding.jobId,
    );
    const finished =
      operation?.evidence === 'host_observed' &&
      ['completed', 'failed'].includes(operation.state);
    const writerCurrent =
      project.fencing === binding.fencing &&
      project.lease?.taskId === binding.taskId &&
      project.lease.backend === 'peer';
    const requirementsCurrent =
      !!task &&
      project.status === 'active' &&
      project.brief.revision === binding.briefRevision &&
      (writerCurrent || finished) &&
      task.briefRevision === project.brief.revision &&
      factoryPeerRequirementsHash(project, task, binding.inputBuildIds) ===
        binding.scopeRevisionHash;
    current =
      requirementsCurrent && Date.parse(binding.expiresAt) > Date.parse(at);
    retainedResultCurrent =
      requirementsCurrent &&
      operation?.state === 'completed' &&
      operation.evidence === 'host_observed' &&
      !operation.resultConflict;
  }
  const {
    taskId: _task,
    fencing: _fence,
    inputBuildIds: _inputs,
    dispatch: _dispatch,
    ...snapshot
  } = binding;
  return { ...snapshot, current, retainedResultCurrent, routeAllowed };
}

export function readGameFactoryPeerState(
  jobId: string,
): GameFactoryPeerState | null {
  if (!JOB.test(jobId)) return null;
  const config = readGameFactoryConfiguration();
  if (!config || !validateGameFactoryDatabaseLocation(config.databasePath))
    return null;
  const db = new Database(config.databasePath, { readonly: true });
  try {
    const binding = readFactoryPeerBinding(db, jobId);
    return binding ? projectFactoryPeerState(db, config, binding) : null;
  } finally {
    db.close();
  }
}

export async function preparePersistedGameFactoryPeerJob(
  actor: FactoryActor,
  jobId: string,
): Promise<unknown> {
  const config = readGameFactoryConfiguration();
  if (
    !config?.enabled ||
    !validateGameFactoryDatabaseLocation(config.databasePath)
  )
    throw new FactoryError('peer_binding_unavailable');
  const db = new Database(config.databasePath, { readonly: true });
  let binding: FactoryPeerBinding;
  try {
    const stored = readFactoryPeerBinding(db, jobId);
    if (!stored) throw new FactoryError('peer_binding_unavailable');
    new GameFactoryStore(db).requireRole(actor, stored.projectId, [
      'owner',
      'editor',
    ]);
    const callerPolicy = config.actors.find(
      (a) => a.identityId === actor.identityId && a.tenantId === actor.tenantId,
    );
    if (!callerPolicy?.backends.includes('peer'))
      throw new FactoryError('backend_not_allowed');
    if (!projectFactoryPeerState(db, config, stored).current)
      throw new FactoryError('peer_context_stale');
    binding = stored;
  } finally {
    db.close();
  }
  return prepareFactoryPeerJob({ jobId, ...binding.dispatch });
}

/** Подписанный inbox подтверждает исполнение, но не интерес/качество игры. */
export function recordGameFactoryPeerEvent(event: PeerInboxEvent): void {
  if (!isAuthenticatedPeerInboxEvent(event))
    throw new FactoryError('authenticated_peer_event_required');
  const config = readGameFactoryConfiguration();
  if (!config || !validateGameFactoryDatabaseLocation(config.databasePath))
    throw new FactoryError('peer_binding_unavailable');
  const db = new Database(config.databasePath);
  try {
    db.pragma('busy_timeout = 5000');
    db.transaction(() => {
      const binding = readFactoryPeerBinding(db, event.jobId);
      if (!binding) throw new FactoryError('peer_binding_unavailable');
      const state = projectFactoryPeerState(db, config, binding);
      if (
        event.parentTaskId !== binding.parentTaskId ||
        event.projectKey !== binding.projectId ||
        event.revision !== binding.peerRevision ||
        event.contextHash !== buildGameFactoryPeerContext(state).sha256 ||
        event.contextValidity.scopeRevisionHash !== binding.scopeRevisionHash ||
        event.contextValidity.expiresAt !== binding.expiresAt
      )
        throw new FactoryError('peer_event_context_mismatch');
      const eventHash = digest(event);
      const prior = db
        .prepare(
          'SELECT event_sha256 FROM factory_peer_events WHERE event_id=?',
        )
        .get(event.eventId) as { event_sha256: string } | undefined;
      if (prior) {
        if (prior.event_sha256 !== eventHash)
          throw new FactoryError('peer_event_id_conflict');
        return;
      }
      db.prepare(
        'INSERT INTO factory_peer_events(event_id,job_id,event_sha256,received_at) VALUES(?,?,?,?)',
      ).run(event.eventId, event.jobId, eventHash, event.receivedAt);
      const row = db
        .prepare('SELECT document_json FROM factory_projects WHERE id=?')
        .get(binding.projectId) as { document_json: string };
      const project = JSON.parse(row.document_json) as FactoryProject;
      const operation = project.operations.find(
        (o) => o.kind === 'peer' && o.externalId === event.jobId,
      );
      if (!operation) throw new FactoryError('peer_operation_unavailable');
      if (['completed', 'failed'].includes(operation.state)) {
        const incomingTerminal =
          event.eventKind === 'result' &&
          ['succeeded', 'failed', 'cancelled'].includes(event.resultState);
        const incomingState =
          event.resultState === 'succeeded' ? 'completed' : 'failed';
        const conflict =
          incomingTerminal &&
          (incomingState !== operation.state ||
            (!!operation.resultHash &&
              operation.resultHash !== event.resultHash));
        // Durable inbox delivery may arrive out of order. A delayed provisional
        // result cannot reopen a finished worker. Conflicting final results are
        // retained as uncertainty for review, never silently substituted.
        if (conflict) {
          operation.resultConflict = true;
          project.revision++;
          project.updatedAt = event.receivedAt;
          db.prepare(
            'UPDATE factory_projects SET revision=?,document_json=?,updated_at=? WHERE id=?',
          ).run(
            project.revision,
            JSON.stringify(project),
            project.updatedAt,
            project.id,
          );
        }
        db.prepare(
          'INSERT INTO factory_events(project_id,revision,actor_key,action,operation_id,at) VALUES(?,?,?,?,?,?)',
        ).run(
          project.id,
          project.revision,
          binding.actorKey,
          conflict ? 'peer_result_conflict' : 'peer_late_event',
          event.eventId,
          event.receivedAt,
        );
        return;
      }
      operation.state =
        event.eventKind === 'progress'
          ? 'running'
          : event.resultState === 'succeeded'
            ? 'completed'
            : ['failed', 'cancelled'].includes(event.resultState)
              ? 'failed'
              : 'unknown';
      operation.evidence = 'host_observed';
      operation.observedAt = event.receivedAt;
      if (event.eventKind === 'result') operation.resultHash = event.resultHash;
      operation.detail = JSON.stringify({
        resultState: event.resultState,
        verification: event.verification.status,
        requirementsCurrent: state.current,
        routeAllowed: state.routeAllowed,
        eventId: event.eventId,
        workerClaimsAreNotAcceptance: true,
      }).slice(0, 2000);
      project.revision++;
      project.updatedAt = event.receivedAt;
      db.prepare(
        'UPDATE factory_projects SET revision=?,document_json=?,updated_at=? WHERE id=?',
      ).run(
        project.revision,
        JSON.stringify(project),
        project.updatedAt,
        project.id,
      );
      db.prepare(
        'INSERT INTO factory_events(project_id,revision,actor_key,action,operation_id,at) VALUES(?,?,?,?,?,?)',
      ).run(
        project.id,
        project.revision,
        binding.actorKey,
        'peer_event',
        event.eventId,
        event.receivedAt,
      );
    }).immediate();
  } finally {
    db.close();
  }
}
