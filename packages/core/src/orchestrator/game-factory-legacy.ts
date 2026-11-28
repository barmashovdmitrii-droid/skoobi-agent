import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import {
  FactoryError,
  type FactoryActor,
  type FactoryConfiguration,
  type FactoryProject,
  type FactoryTask,
} from './game-factory-contracts.js';
import { factoryActorKey, GameFactoryStore } from './game-factory-store.js';
import {
  readGameFactoryConfiguration,
  validateGameFactoryDatabaseLocation,
} from './game-factory-service.js';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';
import { peerCanonicalJson } from './peer-context.js';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const digest = (value: unknown): string =>
  createHash('sha256').update(peerCanonicalJson(value)).digest('hex');
const configurationSchema = z
  .object({
    version: z.literal(1),
    pythonExecutable: z.string().min(1).max(4096),
    factoryScript: z.string().min(1).max(4096),
    stateDirectory: z.string().min(1).max(4096),
  })
  .strict();
export type FactoryLegacyConfiguration = z.infer<typeof configurationSchema>;

export interface FactoryLegacyBinding {
  jobId: string;
  projectId: string;
  taskId: string;
  actorKey: string;
  actor: Pick<FactoryActor, 'identityId' | 'tenantId'>;
  briefRevision: number;
  fencing: number;
  requirementsSha256: string;
  configurationSha256: string;
  createdAt: string;
  /** Только новый dispatch с полной проверенной direct-source идентичностью. */
  route?: FactoryLegacyNoticeRoute;
  request: {
    request_id: string;
    brief: string;
    engine: 'canvas' | 'phaser';
    timeout_seconds: number;
    music: false;
  };
}
export interface FactoryLegacyNoticeRoute {
  chatJid: string;
  groupFolder: string;
  tenantId: string;
  identityId: string;
  channelChatId: string;
  senderId: string;
}

/** Только безопасная проекция для канала; brief, пути, PID, usage и ошибки CLI не выходят наружу. */
export interface FactoryLegacyObservation {
  jobId: string;
  state:
    | 'not_submitted'
    | 'queued'
    | 'generating'
    | 'validating'
    | 'music'
    | 'packaging'
    | 'review_ready'
    | 'failed'
    | 'cancelled'
    | 'quarantined';
  operationState: 'linked' | 'running' | 'completed' | 'failed' | 'unknown';
  scopeComplete: boolean;
  requirementsCurrent: boolean;
  cancellationRequested: boolean;
  requiresHumanReview: true;
  observedAt: string;
}

function canonical(
  filename: string,
  directory: boolean,
  privateMode = false,
): fs.Stats {
  if (!path.isAbsolute(filename) || fs.realpathSync(filename) !== filename)
    throw new FactoryError('legacy_path_unsafe');
  const stat = fs.lstatSync(filename);
  if (
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    stat.isSymbolicLink() ||
    stat.mode & (privateMode ? 0o077 : 0o022) ||
    (privateMode && stat.uid !== process.getuid?.())
  )
    throw new FactoryError('legacy_path_unsafe');
  return stat;
}

/** Этот конфиг создаёт оператор; аргументы модели не задают executable/state/env. */
export function readFactoryLegacyConfiguration(
  filename: string,
): FactoryLegacyConfiguration {
  canonical(filename, false, true);
  canonical(path.dirname(filename), true, true);
  const raw = readBoundedRegularFileNoFollowSync(filename, {
    maxBytes: 16 * 1024,
    oversize: 'reject',
    requireSingleLink: true,
  });
  let parsed: ReturnType<typeof configurationSchema.safeParse>;
  try {
    parsed = configurationSchema.safeParse(
      JSON.parse(raw.buffer.toString('utf8')),
    );
  } catch {
    throw new FactoryError('legacy_configuration_invalid');
  }
  if (!parsed.success) throw new FactoryError('legacy_configuration_invalid');
  const config = parsed.data;
  if (!(canonical(config.pythonExecutable, false).mode & 0o111))
    throw new FactoryError('legacy_python_unavailable');
  canonical(config.factoryScript, false);
  canonical(path.dirname(config.factoryScript), true);
  canonical(config.stateDirectory, true, true);
  return config;
}

function provider(config: FactoryConfiguration): FactoryLegacyConfiguration {
  if (!config.legacy?.configurationPath)
    throw new FactoryError('legacy_configuration_unavailable');
  const result = readFactoryLegacyConfiguration(
    config.legacy.configurationPath,
  );
  // Рабочая копия игры никогда не определяет исполняемый код или служебную БД.
  for (const name of [result.factoryScript, result.stateDirectory]) {
    const relative = path.relative(config.workspaceRoot, name);
    if (
      !relative ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== '..' &&
        !path.isAbsolute(relative))
    )
      throw new FactoryError('legacy_runtime_inside_game_workspace');
  }
  return result;
}

function context(project: FactoryProject, task: FactoryTask): unknown {
  const { source: _source, ...brief } = project.brief;
  const latest = new Map(project.decisions.map((d) => [d.key, d]));
  return {
    title: project.title,
    engine: project.engine,
    brief,
    task: {
      id: task.id,
      title: task.title,
      stage: task.stage,
      acceptance: task.acceptance,
      dependencies: task.dependencies,
      briefRevision: task.briefRevision,
    },
    decisions: [...latest.values()]
      .filter((d) => d.state === 'accepted' || d.state === 'forgotten')
      .map(({ key, value, state, revision }) => ({
        key,
        value: state === 'forgotten' ? '' : value,
        state,
        revision,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/** Вызывается в той же транзакции, что и резервирование canonical operation. Очередь остаётся Python. */
export function bindGameFactoryLegacyJob(input: {
  db: Database.Database;
  config: FactoryConfiguration;
  actor: FactoryActor;
  project: FactoryProject;
  task: FactoryTask;
  jobId: string;
  createdAt: string;
  timeoutSeconds?: number;
}): FactoryLegacyBinding {
  const { db, config, actor, project, task } = input;
  new GameFactoryStore(db).requireRole(actor, project.id, ['owner', 'editor']);
  const policy = config.actors.find(
    (a) => a.identityId === actor.identityId && a.tenantId === actor.tenantId,
  );
  const timeout = input.timeoutSeconds ?? 1200;
  if (
    !config.enabled ||
    !policy?.backends.includes('legacy') ||
    !UUID.test(input.jobId) ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    !Number.isInteger(timeout) ||
    timeout < 120 ||
    timeout > 1800 ||
    !['canvas', 'phaser'].includes(project.engine) ||
    project.status !== 'active' ||
    project.lease?.actorKey !== factoryActorKey(actor) ||
    project.lease.taskId !== task.id ||
    project.lease.backend !== 'legacy' ||
    project.lease.fencing !== project.fencing ||
    project.lease.state !== 'active' ||
    task.briefRevision !== project.brief.revision ||
    task.state !== 'working' ||
    !project.tasks.some((t) => t.id === task.id)
  )
    throw new FactoryError('legacy_dispatch_not_allowed');
  const payload = context(project, task);
  const brief =
    'Create a local HTML5 prototype for this project/task only. No publication, external purchases, personal memory, or generated paid music. Legacy output is a candidate requiring independent factory QA and human review.\n' +
    JSON.stringify(payload);
  if ([...brief].length > 12000 || Buffer.byteLength(brief) > 45000)
    throw new FactoryError('legacy_context_too_large');
  const binding: FactoryLegacyBinding = {
    jobId: input.jobId,
    projectId: project.id,
    taskId: task.id,
    actorKey: factoryActorKey(actor),
    actor: { identityId: actor.identityId, tenantId: actor.tenantId },
    briefRevision: project.brief.revision,
    fencing: project.fencing,
    requirementsSha256: digest(payload),
    configurationSha256: digest(provider(config)),
    createdAt: input.createdAt,
    ...(actor.chatJid &&
    actor.sourceGroup &&
    actor.tenantId &&
    actor.identityId &&
    actor.channelChatId &&
    actor.senderId
      ? {
          route: {
            chatJid: actor.chatJid,
            groupFolder: actor.sourceGroup,
            tenantId: actor.tenantId,
            identityId: actor.identityId,
            channelChatId: actor.channelChatId,
            senderId: actor.senderId,
          },
        }
      : {}),
    request: {
      request_id: `factory:${input.jobId}`,
      brief,
      engine: project.engine as 'canvas' | 'phaser',
      timeout_seconds: timeout,
      music: false,
    },
  };
  const prior = readFactoryLegacyBinding(db, input.jobId);
  if (prior) {
    if (digest(prior) !== digest(binding))
      throw new FactoryError('legacy_binding_conflict');
    return prior;
  }
  db.prepare(
    'INSERT INTO factory_legacy_bindings(job_id,project_id,actor_key,binding_json,updated_at) VALUES(?,?,?,?,?)',
  ).run(
    binding.jobId,
    binding.projectId,
    binding.actorKey,
    JSON.stringify(binding),
    input.createdAt,
  );
  return binding;
}

export function readFactoryLegacyBinding(
  db: Database.Database,
  jobId: string,
): FactoryLegacyBinding | null {
  if (
    !UUID.test(jobId) ||
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_legacy_bindings'",
      )
      .get()
  )
    return null;
  const row = db
    .prepare('SELECT binding_json FROM factory_legacy_bindings WHERE job_id=?')
    .get(jobId) as { binding_json: string } | undefined;
  return row ? (JSON.parse(row.binding_json) as FactoryLegacyBinding) : null;
}

function authorized(
  actor: FactoryActor,
  jobId: string,
  mode: 'submit' | 'observe' | 'cancel' | 'source',
) {
  const config = readGameFactoryConfiguration();
  if (
    !config?.enabled ||
    !validateGameFactoryDatabaseLocation(config.databasePath)
  )
    throw new FactoryError('legacy_binding_unavailable');
  const db = new Database(config.databasePath, { readonly: true });
  try {
    const binding = readFactoryLegacyBinding(db, jobId);
    if (!binding) throw new FactoryError('legacy_binding_unavailable');
    const store = new GameFactoryStore(db);
    store.requireRole(actor, binding.projectId, ['owner', 'editor']);
    const allowed = (who: Pick<FactoryActor, 'identityId' | 'tenantId'>) =>
      config.actors.some(
        (a) =>
          a.identityId === who.identityId &&
          a.tenantId === who.tenantId &&
          a.backends.includes('legacy'),
      );
    const origin = { ...actor, ...binding.actor };
    if (
      !allowed(actor) ||
      (mode === 'submit' &&
        (!allowed(origin) ||
          !['owner', 'editor'].includes(
            store.role(origin, binding.projectId) || '',
          )))
    )
      throw new FactoryError('backend_not_allowed');
    const project = store.read(actor, binding.projectId),
      task = project.tasks.find((t) => t.id === binding.taskId);
    const operation = project.operations.find(
      (o) =>
        o.kind === 'legacy' &&
        o.externalId === jobId &&
        o.taskId === binding.taskId &&
        o.tracking === 'execution',
    );
    const runtime = provider(config);
    if (!operation || digest(runtime) !== binding.configurationSha256)
      throw new FactoryError('legacy_binding_mismatch');
    const requirementsMatch =
      !!task &&
      task.briefRevision === binding.briefRevision &&
      project.brief.revision === binding.briefRevision &&
      digest(context(project, task)) === binding.requirementsSha256;
    const running =
      project.fencing === binding.fencing &&
      project.lease?.fencing === binding.fencing &&
      project.lease.taskId === binding.taskId &&
      project.lease.backend === 'legacy' &&
      project.lease.actorKey === binding.actorKey;
    const finished =
      operation.evidence === 'host_observed' &&
      ['completed', 'failed'].includes(operation.state);
    const requirementsCurrent =
      requirementsMatch && project.status === 'active' && (running || finished);
    // Сверка/отмена старой операции остаётся доступной после поправки или отзыва origin.
    if (
      (mode === 'submit' || mode === 'source') &&
      (!requirementsCurrent || (mode === 'submit' && !running))
    )
      throw new FactoryError('legacy_context_stale');
    const receipt = db
      .prepare(
        'SELECT provider_job_id,cancel_requested FROM factory_legacy_bindings WHERE job_id=?',
      )
      .get(jobId) as {
      provider_job_id: string | null;
      cancel_requested: number;
    };
    if (mode === 'submit' && receipt.cancel_requested)
      throw new FactoryError('legacy_cancel_requested');
    return {
      binding,
      runtime,
      finished,
      databasePath: config.databasePath,
      providerJobId: receipt.provider_job_id,
      requirementsCurrent,
      cancellationRequested: !!receipt.cancel_requested,
    };
  } finally {
    db.close();
  }
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
function cli(
  config: FactoryLegacyConfiguration,
  args: string[],
  input = '',
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      config.pythonExecutable,
      [
        '-B',
        '-s',
        '-E',
        config.factoryScript,
        '--state',
        config.stateDirectory,
        ...args,
      ],
      {
        cwd: path.dirname(config.factoryScript),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: `${path.dirname(config.pythonExecutable)}:/usr/bin:/bin`,
          HOME: config.stateDirectory,
          LANG: 'en_US.UTF-8',
        },
      },
    );
    let stdout = '',
      stderr = '',
      bytes = 0,
      failed = false;
    const stop = () => {
      failed = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(stop, 20000);
    for (const [stream, output] of [
      [child.stdout, true],
      [child.stderr, false],
    ] as const)
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) {
          stop();
          return;
        }
        if (output) stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      });
    child.once('error', () => {
      failed = true;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failed) reject(new FactoryError('legacy_cli_unavailable'));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const statusSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{12}$/),
  request_id: z.string(),
  brief: z.string(),
  timeout_seconds: z.number(),
  engine: z.enum(['canvas', 'phaser']),
  music: z.literal(false),
  music_prompt: z.literal(''),
  source_job: z.null(),
  status: z.enum([
    'queued',
    'generating',
    'validating',
    'music',
    'packaging',
    'review_ready',
    'failed',
    'cancelled',
    'quarantined',
  ]),
  scope_complete: z.boolean(),
  cancel_requested: z.union([z.boolean(), z.literal(0), z.literal(1)]),
  pid: z.number().nullable(),
});
type Status = z.infer<typeof statusSchema>;
function decoded(result: CliResult): unknown {
  try {
    return JSON.parse(result.code === 0 ? result.stdout : result.stderr);
  } catch {
    throw new FactoryError('legacy_response_invalid');
  }
}
function status(
  result: CliResult,
  binding: FactoryLegacyBinding,
): Status | null {
  const raw = decoded(result);
  if (result.code !== 0) {
    if (
      raw &&
      typeof raw === 'object' &&
      'error' in raw &&
      ['Job not found', 'Factory state is not initialized'].includes(
        String(raw.error),
      )
    )
      return null;
    throw new FactoryError('legacy_cli_rejected');
  }
  const parsed = statusSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.request_id !== binding.request.request_id ||
    parsed.data.brief !== binding.request.brief ||
    parsed.data.timeout_seconds !== binding.request.timeout_seconds ||
    parsed.data.engine !== binding.request.engine
  )
    throw new FactoryError('legacy_response_scope_mismatch');
  return parsed.data;
}
function observation(
  input: ReturnType<typeof authorized>,
  row: Status | null,
): FactoryLegacyObservation {
  const terminal =
    row &&
    ['review_ready', 'failed', 'cancelled'].includes(row.status) &&
    row.pid === null;
  return {
    jobId: input.binding.jobId,
    state: row?.status ?? 'not_submitted',
    operationState:
      !row && input.cancellationRequested
        ? 'unknown'
        : !row || row.status === 'queued'
          ? 'linked'
          : row.status === 'quarantined'
            ? 'unknown'
            : terminal
              ? row.status === 'review_ready'
                ? 'completed'
                : 'failed'
              : 'running',
    scopeComplete:
      row?.status === 'review_ready' && row.pid === null && row.scope_complete,
    requirementsCurrent: input.requirementsCurrent,
    cancellationRequested:
      input.cancellationRequested || !!row?.cancel_requested,
    requiresHumanReview: true,
    observedAt: new Date().toISOString(),
  };
}
async function lookup(
  input: ReturnType<typeof authorized>,
): Promise<Status | null> {
  const row = status(
    await cli(input.runtime, [
      'status',
      '--request-id',
      input.binding.request.request_id,
    ]),
    input.binding,
  );
  if (input.providerJobId && row?.id !== input.providerJobId)
    throw new FactoryError('legacy_provider_state_changed');
  return row;
}

function rememberProviderJob(
  input: ReturnType<typeof authorized>,
  row: Status,
): void {
  // Потеря/подмена SQLite провайдера после подтверждения не создаёт вторую генерацию.
  const db = new Database(input.databasePath);
  try {
    db.pragma('busy_timeout = 5000');
    const updated = db
      .prepare(
        'UPDATE factory_legacy_bindings SET provider_job_id=? WHERE job_id=? AND (provider_job_id IS NULL OR provider_job_id=?)',
      )
      .run(row.id, input.binding.jobId, row.id);
    if (updated.changes !== 1)
      throw new FactoryError('legacy_provider_state_changed');
  } finally {
    db.close();
  }
}

/** При потере ответа submit повторяется с тем же request_id: Python проверяет весь payload транзакционно. */
export async function submitPersistedGameFactoryLegacyJob(
  actor: FactoryActor,
  jobId: string,
): Promise<FactoryLegacyObservation> {
  const input = authorized(actor, jobId, 'submit');
  const existing = await lookup(input);
  authorized(actor, jobId, 'submit');
  if (existing) {
    rememberProviderJob(input, existing);
    return observation(authorized(actor, jobId, 'observe'), existing);
  }
  const row = status(
    await cli(input.runtime, ['submit'], JSON.stringify(input.binding.request)),
    input.binding,
  );
  authorized(actor, jobId, 'observe');
  if (!row) throw new FactoryError('legacy_submit_unconfirmed');
  rememberProviderJob(input, row);
  const afterSubmit = authorized(actor, jobId, 'observe');
  // Отмена могла увидеть отсутствие row, пока CLI ещё принимал этот submit.
  // Сверяем tombstone после ack и останавливаем именно подтверждённый request.
  if (afterSubmit.cancellationRequested)
    return cancelPersistedGameFactoryLegacyJob(actor, jobId);
  return observation(afterSubmit, row);
}

export async function observePersistedGameFactoryLegacyJob(
  actor: FactoryActor,
  jobId: string,
): Promise<FactoryLegacyObservation> {
  const input = authorized(actor, jobId, 'observe'),
    row = await lookup(input);
  return observation(authorized(actor, jobId, 'observe'), row);
}

export async function cancelPersistedGameFactoryLegacyJob(
  actor: FactoryActor,
  jobId: string,
): Promise<FactoryLegacyObservation> {
  let input = authorized(actor, jobId, 'cancel');
  const db = new Database(input.databasePath);
  try {
    db.prepare(
      'UPDATE factory_legacy_bindings SET cancel_requested=1 WHERE job_id=?',
    ).run(jobId);
  } finally {
    db.close();
  }
  input = authorized(actor, jobId, 'cancel');
  const row = await lookup(input);
  authorized(actor, jobId, 'cancel');
  if (!row) return observation(input, null);
  const cancelled = status(
    await cli(input.runtime, ['cancel', row.id]),
    input.binding,
  );
  return observation(authorized(actor, jobId, 'cancel'), cancelled);
}

/** HOST ONLY: путь передаётся importFactorySource, никогда в IPC/model response.
 * Ни прошлый QA legacy, ни review_ready не являются приёмкой нового build. */
export async function inspectPersistedGameFactoryLegacySource(
  actor: FactoryActor,
  jobId: string,
): Promise<{
  sourceRoot: string;
  entrypoint: 'index.html';
  allowedRoots: string[];
  legacyJobId: string;
}> {
  const input = authorized(actor, jobId, 'source'),
    row = await lookup(input);
  if (!row || !observation(input, row).scopeComplete)
    throw new FactoryError('legacy_source_not_ready');
  const sourceRoot = path.join(
    input.runtime.stateDirectory,
    'jobs',
    row.id,
    'project',
  );
  canonical(sourceRoot, true);
  canonical(path.join(sourceRoot, 'index.html'), false);
  authorized(actor, jobId, 'source');
  return {
    sourceRoot,
    entrypoint: 'index.html',
    allowedRoots: [path.join(input.runtime.stateDirectory, 'jobs', row.id)],
    legacyJobId: row.id,
  };
}
