/** Canonical audio bindings живут в основном реестре; provider journal остаётся источником исполнения. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { getDb } from './db.js';
import {
  FactoryError,
  type FactoryActor,
  type FactoryConfiguration,
  type FactoryProject,
  type FactoryTask,
  type FactoryFile,
} from './game-factory-contracts.js';
import { factoryActorKey, GameFactoryStore } from './game-factory-store.js';
import {
  readGameFactoryConfiguration,
  validateGameFactoryDatabaseLocation,
  verifyFactoryCurrentSource,
} from './game-factory-service.js';
import {
  createGameFactoryAudioAdapter,
  prepareFactoryAudioReservation,
  readFactoryAudioConfiguration,
  type FactoryAudioAction,
  type FactoryAudioBinding,
  type FactoryAudioContext,
  type FactoryAudioGrant,
  type FactoryAudioRecord,
  type FactoryAudioHostDependencies,
  type FactoryPreparedAudioSource,
} from './game-factory-audio.js';
import { importFactorySourceAsync } from './game-factory-artifacts.js';
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function readFactoryAudioBinding(
  db: Database.Database,
  jobId: string,
): FactoryAudioRecord | undefined {
  const row = db
    .prepare(
      'SELECT binding_json,provider_job_id,observation_json FROM factory_audio_bindings WHERE job_id=?',
    )
    .get(jobId) as
    | {
        binding_json: string;
        provider_job_id: string | null;
        observation_json: string | null;
      }
    | undefined;
  if (!row) return undefined;
  try {
    const binding = JSON.parse(row.binding_json) as FactoryAudioBinding;
    if (binding.jobId !== jobId) throw new Error();
    return {
      binding,
      providerJobId: row.provider_job_id ?? undefined,
      observation: row.observation_json
        ? JSON.parse(row.observation_json)
        : undefined,
    };
  } catch {
    throw new FactoryError('audio_binding_invalid');
  }
}

/** Grant создаёт оператор после прямого согласия владельца. Проверяем реальное сохранённое сообщение. */
export function verifyFactoryAudioApproval(
  config: FactoryConfiguration,
  grant: FactoryAudioGrant,
  messages: Database.Database = getDb(),
): boolean {
  const owner = config.actors.find(
    (a) =>
      a.identityId === config.primaryOwnerIdentityId &&
      factoryActorKey(a) === grant.approval.approverActorKey,
  );
  if (!owner) return false;
  const source = grant.approval;
  const row = messages
    .prepare(
      `SELECT m.sender,m.content,m.is_bot_message,mm.sender_identity_json
    FROM messages m LEFT JOIN message_metadata mm ON mm.id=m.id AND mm.chat_jid=m.chat_jid
    WHERE m.chat_jid=? AND m.id=?`,
    )
    .get(source.chatJid, source.messageRef) as
    | {
        sender: string;
        content: string;
        is_bot_message: number;
        sender_identity_json: string | null;
      }
    | undefined;
  if (
    !row ||
    row.is_bot_message ||
    row.sender !== source.senderId ||
    !row.content.includes(source.quote) ||
    createHash('sha256').update(source.quote).digest('hex') !==
      source.quoteSha256
  )
    return false;
  try {
    const identity = JSON.parse(row.sender_identity_json ?? 'null');
    return (
      identity?.channel === 'telegram' &&
      identity.telegram_message_origin === 'direct' &&
      identity.identity_id === owner.identityId &&
      identity.telegram_user_id === source.senderId &&
      identity.chat_id === source.channelChatId &&
      identity.is_owner_sender === true
    );
  } catch {
    return false;
  }
}

function audioContext(
  config: FactoryConfiguration,
  actor: FactoryActor,
  project: FactoryProject,
  taskId: string,
): FactoryAudioContext {
  const policy = config.actors.find(
    (a) => factoryActorKey(a) === factoryActorKey(actor),
  );
  if (
    !config.enabled ||
    !policy ||
    !policy.backends.includes('agent') ||
    !config.audio
  )
    throw new FactoryError('audio_backend_not_allowed');
  const task = project.tasks.find((t) => t.id === taskId);
  return {
    actorKey: factoryActorKey(actor),
    projectId: project.id,
    taskId,
    briefRevision: project.brief.revision,
    configurationPath: config.audio.configurationPath,
    writableGameRoots: [
      config.workspaceRoot,
      ...config.actors.flatMap((a) => a.sourceRoots),
    ],
    requirementsCurrent:
      project.status === 'active' &&
      !!task &&
      task.briefRevision === project.brief.revision &&
      !['cancelled', 'superseded'].includes(task.state),
  };
}

/** Вызов только внутри project mutate transaction, до любых provider/подпроцессов. */
export function reserveFactoryAudioJob(input: {
  db: Database.Database;
  config: FactoryConfiguration;
  actor: FactoryActor;
  project: FactoryProject;
  task: FactoryTask;
  jobId: string;
  grantId: string;
  prompt: string;
  now: string;
}) {
  if (!input.db.inTransaction)
    throw new FactoryError('audio_reservation_requires_transaction');
  const { binding, grant } = prepareFactoryAudioReservation(
    audioContext(input.config, input.actor, input.project, input.task.id),
    {
      jobId: input.jobId,
      projectId: input.project.id,
      taskId: input.task.id,
      grantId: input.grantId,
      prompt: input.prompt,
    },
    new Date(input.now),
  );
  if (!verifyFactoryAudioApproval(input.config, grant))
    throw new FactoryError('audio_approval_not_host_verified');
  if (
    input.db
      .prepare(
        'SELECT 1 FROM factory_audio_bindings WHERE job_id=? OR grant_id=?',
      )
      .get(binding.jobId, binding.grantId)
  )
    throw new FactoryError('audio_grant_already_reserved');
  input.db
    .prepare(
      'INSERT INTO factory_audio_bindings(job_id,grant_id,project_id,actor_key,binding_json,updated_at)VALUES(?,?,?,?,?,?)',
    )
    .run(
      binding.jobId,
      binding.grantId,
      binding.projectId,
      binding.actorKey,
      JSON.stringify(binding),
      input.now,
    );
  return binding;
}

function access(
  actor: FactoryActor,
  action: FactoryAudioAction,
  ids: { jobId: string; projectId: string; taskId: string },
  readonly = true,
) {
  const config = readGameFactoryConfiguration();
  if (
    !config?.enabled ||
    !validateGameFactoryDatabaseLocation(config.databasePath)
  )
    throw new FactoryError('audio_unavailable');
  if (action !== 'status') verifyFactoryCurrentSource(actor, getDb());
  const db = new Database(config.databasePath, { readonly });
  try {
    const store = new GameFactoryStore(db);
    store.requireRole(
      actor,
      ids.projectId,
      action === 'status'
        ? ['owner', 'editor', 'reviewer', 'reader']
        : ['owner', 'editor'],
    );
    const record = readFactoryAudioBinding(db, ids.jobId);
    if (
      !record ||
      record.binding.projectId !== ids.projectId ||
      record.binding.taskId !== ids.taskId
    )
      throw new FactoryError('audio_binding_unavailable');
    const project = store.read(actor, ids.projectId);
    if (action === 'submit') {
      const lease = project.lease;
      if (
        !lease ||
        lease.backend !== 'agent' ||
        lease.state !== 'active' ||
        lease.actorKey !== factoryActorKey(actor) ||
        lease.runId !== actor.runId ||
        lease.taskId !== ids.taskId ||
        lease.briefRevision !== project.brief.revision ||
        Date.parse(lease.expiresAt) <= Date.now()
      )
        throw new FactoryError('audio_dispatch_lease_changed');
    }
    if (
      !project.operations.some(
        (o) =>
          o.kind === 'asset' &&
          o.externalId === ids.jobId &&
          o.taskId === ids.taskId &&
          o.evidence === 'host_observed',
      )
    )
      throw new FactoryError('audio_operation_unbound');
    const context = audioContext(config, actor, project, ids.taskId);
    return { db, config, project, record, context };
  } catch (error) {
    db.close();
    throw error;
  }
}
function loadRecord(jobId: string) {
  const config = readGameFactoryConfiguration();
  if (
    !config?.enabled ||
    !validateGameFactoryDatabaseLocation(config.databasePath)
  )
    throw new FactoryError('audio_unavailable');
  const db = new Database(config.databasePath, { readonly: true });
  try {
    return readFactoryAudioBinding(db, jobId);
  } finally {
    db.close();
  }
}

function productionDependencies(
  actor: FactoryActor,
): FactoryAudioHostDependencies {
  return {
    async authorize({ actor: caller, action, ...ids }) {
      if (factoryActorKey(caller) !== factoryActorKey(actor))
        throw new FactoryError('audio_actor_changed');
      const current = access(caller, action, ids);
      try {
        return current.context;
      } finally {
        current.db.close();
      }
    },
    async approvalCurrent(_context, grant) {
      const config = readGameFactoryConfiguration();
      return !!config?.enabled && verifyFactoryAudioApproval(config, grant);
    },
    async read(jobId) {
      return loadRecord(jobId);
    },
    async reserve(binding) {
      const current = access(actor, 'submit', binding, false);
      try {
        // Строка уже обязана существовать: provider adapter не создаёт новую очередь/задачу.
        return current.db
          .transaction(() => {
            const retained = readFactoryAudioBinding(current.db, binding.jobId);
            if (!retained || retained.binding.grantId !== binding.grantId)
              throw new FactoryError('audio_reservation_missing');
            return retained;
          })
          .immediate();
      } finally {
        current.db.close();
      }
    },
    async observe(jobId, observation) {
      const record = loadRecord(jobId);
      if (!record) throw new FactoryError('audio_binding_unavailable');
      // Даже поздний ACK сохраняется как факт исполнения, без принятия старой задачи.
      const current = access(actor, 'status', record.binding, false);
      try {
        current.db
          .transaction(() => {
            const latest = readFactoryAudioBinding(current.db, jobId)!;
            if (
              latest.providerJobId &&
              observation.providerJobId &&
              latest.providerJobId !== observation.providerJobId
            )
              throw new FactoryError('audio_provider_binding_changed');
            current.db
              .prepare(
                'UPDATE factory_audio_bindings SET provider_job_id=COALESCE(provider_job_id,?),observation_json=?,updated_at=? WHERE job_id=?',
              )
              .run(
                observation.providerJobId ?? null,
                JSON.stringify(observation),
                new Date().toISOString(),
                jobId,
              );
          })
          .immediate();
      } finally {
        current.db.close();
      }
    },
  };
}
export async function submitPersistedFactoryAudio(
  actor: FactoryActor,
  jobId: string,
) {
  const record = loadRecord(jobId);
  if (!record) throw new FactoryError('audio_binding_unavailable');
  const adapter = createGameFactoryAudioAdapter(productionDependencies(actor));
  if (record.providerJobId || record.observation?.state === 'unknown') {
    const observed = await adapter.status(actor, jobId);
    return record.observation?.state === 'unknown' &&
      observed.state === 'not_submitted'
      ? { ...observed, state: 'unknown' as const }
      : observed;
  }
  return adapter.submit(actor, record.binding);
}
export async function observePersistedFactoryAudio(
  actor: FactoryActor,
  jobId: string,
  poll = false,
) {
  const adapter = createGameFactoryAudioAdapter(productionDependencies(actor));
  return poll ? adapter.poll(actor, jobId) : adapter.status(actor, jobId);
}
export interface FactoryAudioImportReceipt {
  jobId: string;
  originBriefRevision: number;
  provider: 'apiframe';
  model: 'suno';
  modelVersion: 'V5_5';
  requestSha256: string;
  promptSha256: string;
  cost: { status: 'unknown' } | { status: 'known'; credits: number };
  rights: { status: 'needs-provider-confirmation' };
  tracks: Array<{ role: 'menu' | 'playing'; root: string; file: FactoryFile }>;
  receiptSha256: string;
}
export async function importPersistedFactoryAudio(input: {
  actor: FactoryActor;
  jobId: string;
  destinationRoot: string;
}): Promise<FactoryAudioImportReceipt> {
  const record = loadRecord(input.jobId);
  if (!record) throw new FactoryError('audio_binding_unavailable');
  const adapter = createGameFactoryAudioAdapter(
    productionDependencies(input.actor),
  );
  const before = access(input.actor, 'prepare', record.binding);
  let cached: FactoryPreparedAudioSource | undefined;
  try {
    const row = before.db
      .prepare(
        'SELECT prepared_json FROM factory_audio_bindings WHERE job_id=?',
      )
      .get(input.jobId) as { prepared_json: string | null };
    if (row.prepared_json) cached = JSON.parse(row.prepared_json);
  } finally {
    before.db.close();
  }
  // Даже cached output требует актуального ACL и неотозванного grant.
  const observation = await adapter.status(input.actor, input.jobId);
  if (observation.state !== 'completed')
    throw new FactoryError('audio_execution_not_complete');
  const prepared =
    cached ?? (await adapter.prepare(input.actor, input.jobId)).source;
  const fresh = access(input.actor, 'prepare', record.binding, false);
  let allowedRoot: string;
  try {
    const config = readFactoryAudioConfiguration(
      fresh.context.configurationPath,
      fresh.context.writableGameRoots,
    );
    allowedRoot = path.join(config.outputDirectory, input.jobId);
    if (
      path.dirname(prepared.directory) !== allowedRoot ||
      !path.basename(prepared.directory).startsWith('audio-result-') ||
      fs.realpathSync(prepared.directory) !== prepared.directory
    )
      throw new FactoryError('audio_cached_output_unsafe');
    const expected = path.join(
      fresh.project.workspace,
      'assets',
      `audio-${input.jobId}`,
    );
    if (input.destinationRoot !== expected)
      throw new FactoryError('audio_destination_unsafe');
    if (!cached)
      fresh.db
        .prepare(
          'UPDATE factory_audio_bindings SET prepared_json=? WHERE job_id=?',
        )
        .run(JSON.stringify(prepared), input.jobId);
  } finally {
    fresh.db.close();
  }
  const tracks: FactoryAudioImportReceipt['tracks'] = [];
  const copy = await importFactorySourceAsync({
    sourceRoot: path.join(prepared.directory, 'assets'),
    entrypoint: 'menu.mp3',
    allowedRoots: [allowedRoot],
    destinationRoot: path.join(input.destinationRoot, 'tracks'),
    limits: {
      maxFiles: 2,
      maxFileBytes: 25 * 1024 * 1024,
      maxTotalBytes: 50 * 1024 * 1024,
    },
  });
  if (copy.files.length !== 2)
    throw new FactoryError('audio_track_count_changed');
  for (const track of prepared.tracks) {
    if (
      !['menu', 'playing'].includes(track.role) ||
      track.path !== `assets/${track.role}.mp3`
    )
      throw new FactoryError('audio_track_invalid');
    const file = copy.files.find((f) => f.path === `${track.role}.mp3`);
    if (!file || file.sha256 !== track.sha256 || file.size !== track.bytes)
      throw new FactoryError('audio_copied_track_changed');
    tracks.push({ role: track.role, root: copy.sourceRoot, file });
  }
  await adapter.status(input.actor, input.jobId);
  const final = access(input.actor, 'prepare', record.binding);
  final.db.close();
  const receipt = {
    jobId: input.jobId,
    originBriefRevision: record.binding.briefRevision,
    provider: 'apiframe' as const,
    model: 'suno' as const,
    modelVersion: 'V5_5' as const,
    requestSha256: record.binding.requestSha256,
    promptSha256: createHash('sha256')
      .update(record.binding.prompt)
      .digest('hex'),
    cost: prepared.cost,
    rights: prepared.rights,
    tracks,
  };
  return { ...receipt, receiptSha256: digest(receipt) };
}
