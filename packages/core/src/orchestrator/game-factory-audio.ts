/** Узкий host adapter. Нет scheduler, SQL/модельного budget grant или публикации. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FactoryError, type FactoryActor } from './game-factory-contracts.js';
import { factoryActorKey } from './game-factory-store.js';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const identifier = z.string().min(1).max(256);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().uuid();
const configSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean().default(false),
    pythonExecutable: z.string().min(1),
    musicScript: z.string().min(1),
    stateDirectory: z.string().min(1),
    outputDirectory: z.string().min(1),
    secretFile: z.string().min(1),
    grantsFile: z.string().min(1),
  })
  .strict();
export type FactoryAudioConfiguration = z.infer<typeof configSchema>;
const grantSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    actorKey: identifier,
    projectId: identifier,
    taskId: identifier,
    briefRevision: z.number().int().positive(),
    promptSha256: sha,
    provider: z.literal('apiframe'),
    model: z.literal('suno'),
    modelVersion: z.literal('V5_5'),
    maxCredits: z.number().int().min(11),
    estimatedCredits: z.literal(11),
    expiresAt: z.string().datetime({ offset: true }),
    approval: z
      .object({
        kind: z.literal('host_verified_direct_user'),
        approverActorKey: identifier,
        chatJid: identifier,
        channelChatId: identifier,
        senderId: identifier,
        messageRef: identifier,
        quote: z.string().min(1).max(4000),
        quoteSha256: sha,
      })
      .strict(),
  })
  .strict();
export type FactoryAudioGrant = z.infer<typeof grantSchema>;
const grantsSchema = z
  .object({ version: z.literal(1), grants: z.array(grantSchema).max(1000) })
  .strict();
const costSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown') }).strict(),
  z
    .object({
      status: z.literal('known'),
      credits: z.number().finite().nonnegative(),
    })
    .strict(),
]);
const observedSchema = z
  .object({
    state: z.enum([
      'not_submitted',
      'accepted',
      'processing',
      'completed',
      'failed',
      'unknown',
    ]),
    providerJobId: uuid.optional(),
    requestSha256: sha.optional(),
    cost: costSchema,
    requiresHumanReview: z.literal(true),
  })
  .strict();
export type FactoryAudioProviderObservation = z.infer<typeof observedSchema>;
type ProviderObservation = FactoryAudioProviderObservation;
const preparedSchema = z
  .object({
    directory: z.string(),
    tracks: z
      .array(
        z
          .object({
            role: z.enum(['menu', 'playing']),
            path: z.string(),
            originalSha256: sha,
            originalAudio: z
              .object({
                duration: z.number().finite(),
                sampleRate: z.number().int(),
                channels: z.number().int(),
              })
              .strict(),
            duration: z.number().finite(),
            sha256: sha,
            bytes: z.number().int().positive(),
            targetLUFS: z.number(),
            truePeakLimitDB: z.number(),
            crossfadeSeconds: z.number(),
          })
          .strict(),
      )
      .length(2),
    rights: z
      .object({ status: z.literal('needs-provider-confirmation') })
      .strict(),
    cost: costSchema,
  })
  .strict();
const replySchema = z
  .object({
    ok: z.boolean(),
    observation: observedSchema.optional(),
    prepared: preparedSchema.optional(),
    error: z.literal('music_operation_failed').optional(),
  })
  .strict();
type HostReply = z.infer<typeof replySchema>;
export type FactoryPreparedAudioSource = z.infer<typeof preparedSchema>;
export type FactoryAudioAction = 'submit' | 'status' | 'poll' | 'prepare';

export interface FactoryAudioContext {
  actorKey: string;
  projectId: string;
  taskId: string;
  briefRevision: number;
  configurationPath: string;
  /** Все каталоги, в которые игровые исполнители могут писать/импортировать. */
  writableGameRoots: string[];
  requirementsCurrent: boolean;
}
export interface FactoryAudioBinding {
  jobId: string;
  projectId: string;
  taskId: string;
  actorKey: string;
  briefRevision: number;
  grantId: string;
  prompt: string;
  requestSha256: string;
  configurationSha256: string;
  grantSha256: string;
  maxCredits: number;
  createdAt: string;
}
export interface FactoryAudioRecord {
  binding: FactoryAudioBinding;
  /** Сохраняется отдельно от model-visible observation и никогда не забывается. */
  providerJobId?: string;
  observation?: ProviderObservation;
}
export interface FactoryAudioObservation {
  jobId: string;
  state: ProviderObservation['state'];
  cost: ProviderObservation['cost'];
  requirementsCurrent: boolean;
  requiresHumanReview: true;
}
export interface FactoryAudioHostDependencies {
  /** Сервер проверяет текущие actor/project/action/backend/task права; никогда не доверяет args. */
  authorize(input: {
    actor: FactoryActor;
    action: FactoryAudioAction;
    projectId: string;
    taskId: string;
    jobId: string;
  }): Promise<FactoryAudioContext>;
  /** Повторно сверяет реальное direct-user согласие, не только текст quote из файла. */
  approvalCurrent(
    context: FactoryAudioContext,
    grant: FactoryAudioGrant,
  ): Promise<boolean>;
  /** Одна SQL transaction основного registry: unique(grant_id), unique(job_id), exact replay only.
   * Резерв сохраняется при unknown/timeout/failed; автоматического освобождения нет. */
  reserve(binding: FactoryAudioBinding): Promise<FactoryAudioRecord>;
  read(jobId: string): Promise<FactoryAudioRecord | undefined>;
  /** Только execution facts; сохраняет первый providerJobId и отклоняет его подмену. Не принимает качество. */
  observe(jobId: string, observation: ProviderObservation): Promise<void>;
  now?: () => Date;
}

function canonical(
  filename: string,
  directory: boolean,
  privateMode: boolean,
): fs.Stats {
  if (!path.isAbsolute(filename) || fs.realpathSync(filename) !== filename)
    throw new FactoryError('audio_path_unsafe');
  const s = fs.lstatSync(filename);
  if (
    (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) ||
    s.isSymbolicLink() ||
    s.mode & (privateMode ? 0o077 : 0o022) ||
    (privateMode && s.uid !== process.getuid?.())
  )
    throw new FactoryError('audio_path_unsafe');
  return s;
}
function privateJson(filename: string, limit: number): unknown {
  canonical(filename, false, true);
  canonical(path.dirname(filename), true, true);
  const file = readBoundedRegularFileNoFollowSync(filename, {
    maxBytes: limit,
    oversize: 'reject',
    requireSingleLink: true,
  });
  try {
    return JSON.parse(file.buffer.toString('utf8'));
  } catch {
    throw new FactoryError('audio_configuration_invalid');
  }
}
function inside(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}
export function readFactoryAudioConfiguration(
  filename: string,
  writableGameRoots: string[],
): FactoryAudioConfiguration {
  let config: FactoryAudioConfiguration;
  try {
    config = configSchema.parse(privateJson(filename, 16 * 1024));
  } catch {
    throw new FactoryError('audio_configuration_invalid');
  }
  if (!(canonical(config.pythonExecutable, false, false).mode & 0o111))
    throw new FactoryError('audio_python_unavailable');
  canonical(config.musicScript, false, false);
  canonical(path.dirname(config.musicScript), true, false);
  canonical(
    path.join(path.dirname(config.musicScript), 'music.py'),
    false,
    false,
  );
  canonical(config.stateDirectory, true, true);
  canonical(config.outputDirectory, true, true);
  // Секрет не открывается и не проверяется status; путь проверяется только лексически.
  if (
    !path.isAbsolute(config.secretFile) ||
    path.normalize(config.secretFile) !== config.secretFile
  )
    throw new FactoryError('audio_secret_path_unsafe');
  for (const candidate of [
    filename,
    config.pythonExecutable,
    config.musicScript,
    config.stateDirectory,
    config.outputDirectory,
    config.secretFile,
    config.grantsFile,
  ])
    if (writableGameRoots.some((root) => inside(root, candidate)))
      throw new FactoryError('audio_runtime_inside_game_workspace');
  return config;
}
export function factoryAudioRequestSha256(prompt: string): string {
  // Тот же canonical JSON, что Python request_digest(sort_keys=True, ensure_ascii=False).
  return hash(
    JSON.stringify({
      model: 'suno',
      prompt,
      sunoParams: {
        custom_mode: false,
        instrumental: true,
        model_version: 'V5_5',
      },
    }),
  );
}
function configurationDigest(config: FactoryAudioConfiguration): string {
  const { enabled: _enabled, ...runtime } = config;
  // Отключение новых сетевых действий не отнимает readonly status старого receipt.
  return hash(JSON.stringify(runtime));
}
function checkedGrant(
  config: FactoryAudioConfiguration,
  id: string,
  context: FactoryAudioContext,
  prompt: string,
  now: Date,
  allowExpired = false,
): FactoryAudioGrant {
  let grants: FactoryAudioGrant[];
  try {
    grants = grantsSchema.parse(
      privateJson(config.grantsFile, 1024 * 1024),
    ).grants;
  } catch {
    throw new FactoryError('audio_grants_invalid');
  }
  if (new Set(grants.map((g) => g.id)).size !== grants.length)
    throw new FactoryError('audio_grants_duplicate');
  const grant = grants.find((g) => g.id === id);
  if (
    !grant ||
    grant.actorKey !== context.actorKey ||
    grant.projectId !== context.projectId ||
    grant.taskId !== context.taskId ||
    grant.briefRevision !== context.briefRevision ||
    grant.promptSha256 !== hash(prompt) ||
    grant.approval.quoteSha256 !== hash(grant.approval.quote) ||
    (!allowExpired && Date.parse(grant.expiresAt) <= now.getTime())
  )
    throw new FactoryError('audio_budget_not_authorized');
  return grant;
}
export function prepareFactoryAudioReservation(
  ctx: FactoryAudioContext,
  input: {
    jobId: string;
    projectId: string;
    taskId: string;
    grantId: string;
    prompt: string;
  },
  now = new Date(),
) {
  uuid.parse(input.jobId);
  z.string().min(15).max(500).parse(input.prompt);
  if (
    !ctx.requirementsCurrent ||
    input.projectId !== ctx.projectId ||
    input.taskId !== ctx.taskId
  )
    throw new FactoryError('audio_requirements_stale');
  const config = readFactoryAudioConfiguration(
    ctx.configurationPath,
    ctx.writableGameRoots,
  );
  if (!config.enabled) throw new FactoryError('audio_live_disabled');
  const grant = checkedGrant(config, input.grantId, ctx, input.prompt, now);
  const binding: FactoryAudioBinding = {
    ...input,
    actorKey: ctx.actorKey,
    briefRevision: ctx.briefRevision,
    requestSha256: factoryAudioRequestSha256(input.prompt),
    configurationSha256: configurationDigest(config),
    grantSha256: hash(JSON.stringify(grant)),
    maxCredits: grant.maxCredits,
    createdAt: now.toISOString(),
  };
  return { binding, grant, config };
}
function authorization(binding: FactoryAudioBinding, grant: FactoryAudioGrant) {
  return {
    grantId: grant.id,
    reservationId: binding.jobId,
    requestSha256: binding.requestSha256,
    provider: grant.provider,
    model: grant.model,
    modelVersion: grant.modelVersion,
    maxCredits: grant.maxCredits,
    estimatedCredits: grant.estimatedCredits,
    maxRequests: 1,
    expiresAt: grant.expiresAt,
    approvalSource: {
      kind: 'direct_user_message',
      messageRef: grant.approval.messageRef,
      quoteSha256: grant.approval.quoteSha256,
    },
  };
}
function jobDirectory(parent: string, jobId: string, create: boolean): string {
  uuid.parse(jobId);
  const directory = path.join(parent, jobId);
  if (!fs.existsSync(directory)) {
    if (!create) return directory;
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  canonical(directory, true, true);
  return directory;
}
function runHost(
  config: FactoryAudioConfiguration,
  request: Record<string, unknown>,
): Promise<HostReply> {
  const input = JSON.stringify({ version: 1, ...request });
  if (Buffer.byteLength(input) > 32 * 1024)
    throw new FactoryError('audio_request_too_large');
  return new Promise((resolve, reject) => {
    const child = spawn(
      config.pythonExecutable,
      ['-B', '-s', '-E', config.musicScript],
      {
        cwd: path.dirname(config.musicScript),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          LANG: 'en_US.UTF-8',
        },
      },
    );
    let stdout = '';
    let bytes = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timeout = setTimeout(
      stop,
      request.action === 'prepare' ? 360_000 : 50_000,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 128 * 1024) stop();
      else stdout += chunk.toString('utf8');
    });
    // Провайдерный stderr никогда не копируется в текст для модели/пользователя.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timeout);
      reject(new FactoryError('audio_host_unavailable'));
    });
    child.on('close', () => {
      clearTimeout(timeout);
      if (stopped)
        return reject(new FactoryError('audio_host_outcome_unknown'));
      try {
        resolve(replySchema.parse(JSON.parse(stdout)));
      } catch {
        reject(new FactoryError('audio_host_outcome_unknown'));
      }
    });
    child.stdin.end(input);
  });
}
function publicObservation(
  jobId: string,
  observed: ProviderObservation,
  current: boolean,
): FactoryAudioObservation {
  return {
    jobId,
    state: observed.state,
    cost: observed.cost,
    requiresHumanReview: true,
    requirementsCurrent: current,
  };
}
const unknown = (): ProviderObservation => ({
  state: 'unknown',
  cost: { status: 'unknown' },
  requiresHumanReview: true,
});

/** Authorize/reserve callbacks принадлежат core registry; не подменять их реализацией из model args. */
export function createGameFactoryAudioAdapter(
  deps: FactoryAudioHostDependencies,
) {
  async function context(
    actor: FactoryActor,
    action: FactoryAudioAction,
    binding: Pick<FactoryAudioBinding, 'jobId' | 'projectId' | 'taskId'> & {
      briefRevision?: number;
    },
  ) {
    const result = await deps.authorize({
      actor,
      action,
      projectId: binding.projectId,
      taskId: binding.taskId,
      jobId: binding.jobId,
    });
    if (
      result.actorKey !== factoryActorKey(actor) ||
      result.projectId !== binding.projectId ||
      result.taskId !== binding.taskId
    )
      throw new FactoryError('audio_context_mismatch');
    result.requirementsCurrent =
      result.requirementsCurrent &&
      (binding.briefRevision === undefined ||
        binding.briefRevision === result.briefRevision);
    if (action === 'submit' && !result.requirementsCurrent)
      throw new FactoryError('audio_requirements_stale');
    return result;
  }
  async function bound(
    actor: FactoryActor,
    action: FactoryAudioAction,
    jobId: string,
  ) {
    uuid.parse(jobId);
    const record = await deps.read(jobId);
    if (!record) throw new FactoryError('audio_binding_unavailable');
    const ctx = await context(actor, action, record.binding);
    const config = readFactoryAudioConfiguration(
      ctx.configurationPath,
      ctx.writableGameRoots,
    );
    if (configurationDigest(config) !== record.binding.configurationSha256)
      throw new FactoryError('audio_configuration_changed');
    // Истёкший grant не разрешает новый POST, но сохраняет доступ к уже
    // оплаченному результату. Удаление/изменение grant отзывает такой доступ.
    const retained = checkedGrant(
      config,
      record.binding.grantId,
      {
        ...ctx,
        actorKey: record.binding.actorKey,
        briefRevision: record.binding.briefRevision,
      },
      record.binding.prompt,
      deps.now?.() ?? new Date(),
      true,
    );
    if (
      hash(JSON.stringify(retained)) !== record.binding.grantSha256 ||
      !(await deps.approvalCurrent(ctx, retained))
    )
      throw new FactoryError('audio_retained_access_revoked');
    return { record, ctx, config };
  }
  async function remember(
    actor: FactoryActor,
    action: FactoryAudioAction,
    record: FactoryAudioRecord,
    observation: ProviderObservation,
  ) {
    await context(
      actor,
      action === 'prepare' || action === 'submit' ? 'status' : action,
      record.binding,
    );
    validateObservation(record, observation);
    await deps.observe(record.binding.jobId, observation);
    // Сохраняем квитанцию как факт исполнения, но не возвращаем данные после
    // отзыва доступа/grant во время внешнего I/O.
    const { ctx: current } = await bound(actor, 'status', record.binding.jobId);
    return publicObservation(
      record.binding.jobId,
      observation,
      current.requirementsCurrent,
    );
  }
  function validateObservation(
    record: FactoryAudioRecord,
    observation: ProviderObservation,
  ) {
    if (
      (observation.providerJobId || observation.requestSha256) &&
      observation.requestSha256 !== record.binding.requestSha256
    )
      throw new FactoryError('audio_provider_request_changed');
    if (
      record.providerJobId &&
      observation.providerJobId &&
      record.providerJobId !== observation.providerJobId
    )
      throw new FactoryError('audio_provider_binding_changed');
    if (record.providerJobId && observation.state === 'not_submitted')
      throw new FactoryError('audio_provider_receipt_missing');
  }
  async function observe(
    actor: FactoryActor,
    jobId: string,
    poll = false,
  ): Promise<FactoryAudioObservation> {
    const action = poll ? 'poll' : 'status';
    const { record, config } = await bound(actor, action, jobId);
    const folder = jobDirectory(config.stateDirectory, jobId, false);
    let observed: ProviderObservation;
    if (!fs.existsSync(folder))
      observed = {
        state: 'not_submitted',
        cost: { status: 'unknown' },
        requiresHumanReview: true,
      };
    else {
      if (poll) {
        const before = await runHost(config, {
          action: 'status',
          journal: path.join(folder, 'provider.json'),
        });
        validateObservation(record, before.observation ?? unknown());
        await bound(actor, action, jobId);
      }
      const reply = await runHost(config, {
        action,
        journal: path.join(folder, 'provider.json'),
        ...(poll ? { liveEnabled: true, secretFile: config.secretFile } : {}),
      });
      observed = reply.observation ?? unknown();
    }
    if (!poll) {
      const { ctx: current } = await bound(actor, 'status', jobId);
      validateObservation(record, observed);
      return publicObservation(jobId, observed, current.requirementsCurrent);
    }
    return remember(actor, action, record, observed);
  }
  return {
    async submit(
      actor: FactoryActor,
      input: {
        jobId: string;
        projectId: string;
        taskId: string;
        grantId: string;
        prompt: string;
      },
    ): Promise<FactoryAudioObservation> {
      const ctx = await context(actor, 'submit', input);
      const { binding, config, grant } = prepareFactoryAudioReservation(
        ctx,
        input,
        deps.now?.() ?? new Date(),
      );
      if (!(await deps.approvalCurrent(ctx, grant)))
        throw new FactoryError('audio_approval_not_host_verified');
      // Единственное место расходного намерения: атомарная reservation в основной БД до filesystem/HTTP.
      const record = await deps.reserve(binding);
      for (const key of [
        'jobId',
        'projectId',
        'taskId',
        'actorKey',
        'briefRevision',
        'grantId',
        'prompt',
        'requestSha256',
        'configurationSha256',
        'grantSha256',
        'maxCredits',
      ] as const)
        if (record.binding[key] !== binding[key])
          throw new FactoryError('audio_reservation_mismatch');
      const fresh = await context(actor, 'submit', record.binding);
      const freshConfig = readFactoryAudioConfiguration(
        fresh.configurationPath,
        fresh.writableGameRoots,
      );
      const freshGrant = checkedGrant(
        freshConfig,
        input.grantId,
        fresh,
        input.prompt,
        deps.now?.() ?? new Date(),
      );
      if (
        !freshConfig.enabled ||
        configurationDigest(freshConfig) !== binding.configurationSha256 ||
        hash(JSON.stringify(freshGrant)) !== binding.grantSha256 ||
        !(await deps.approvalCurrent(fresh, freshGrant))
      )
        throw new FactoryError('audio_authorization_changed');
      const folder = jobDirectory(config.stateDirectory, input.jobId, true);
      const journal = path.join(folder, 'provider.json');
      if (record.providerJobId) {
        const status = await runHost(config, { action: 'status', journal });
        validateObservation(record, status.observation ?? unknown());
        if (status.observation?.providerJobId !== record.providerJobId)
          throw new FactoryError('audio_provider_receipt_missing');
      }
      let result: HostReply;
      try {
        result = await runHost(config, {
          action: 'submit',
          journal,
          prompt: input.prompt,
          authorization: authorization(record.binding, freshGrant),
          liveEnabled: true,
          secretFile: config.secretFile,
        });
      } catch {
        await deps.observe(input.jobId, unknown());
        throw new FactoryError('audio_host_outcome_unknown');
      }
      return remember(actor, 'submit', record, result.observation ?? unknown());
    },
    status: (actor: FactoryActor, jobId: string) => observe(actor, jobId),
    poll: (actor: FactoryActor, jobId: string) => observe(actor, jobId, true),
    /** HOST ONLY source descriptor. Caller imports immutable assets; never expose directory to model args. */
    async prepare(actor: FactoryActor, jobId: string) {
      const { record, config } = await bound(actor, 'prepare', jobId);
      const state = jobDirectory(config.stateDirectory, jobId, false);
      if (!fs.existsSync(state))
        throw new FactoryError('audio_provider_receipt_missing');
      const before = await runHost(config, {
        action: 'status',
        journal: path.join(state, 'provider.json'),
      });
      validateObservation(record, before.observation ?? unknown());
      if (!record.providerJobId || before.observation?.state !== 'completed')
        throw new FactoryError('audio_completed_binding_required');
      await bound(actor, 'prepare', jobId);
      const output = jobDirectory(config.outputDirectory, jobId, true);
      const reply = await runHost(config, {
        action: 'prepare',
        journal: path.join(state, 'provider.json'),
        outputParent: output,
        allowDownload: true,
      });
      await bound(actor, 'prepare', jobId);
      if (!reply.ok || !reply.prepared)
        throw new FactoryError('audio_prepare_failed');
      const source = reply.prepared;
      canonical(source.directory, true, true);
      if (
        path.dirname(source.directory) !== output ||
        !path.basename(source.directory).startsWith('audio-result-')
      )
        throw new FactoryError('audio_output_outside_binding');
      if (
        source.tracks
          .map((t) => t.role)
          .sort()
          .join(',') !== 'menu,playing'
      )
        throw new FactoryError('audio_tracks_invalid');
      for (const track of source.tracks) {
        if (track.path !== `assets/${track.role}.mp3`)
          throw new FactoryError('audio_track_path_invalid');
        const file = path.join(source.directory, track.path);
        canonical(file, false, true);
        const data = readBoundedRegularFileNoFollowSync(file, {
          maxBytes: 25 * 1024 * 1024,
          oversize: 'reject',
          requireSingleLink: true,
        });
        if (
          data.buffer.length !== track.bytes ||
          createHash('sha256').update(data.buffer).digest('hex') !==
            track.sha256
        )
          throw new FactoryError('audio_track_changed');
      }
      return {
        observation: await remember(
          actor,
          'prepare',
          record,
          reply.observation ?? unknown(),
        ),
        source,
      };
    },
  };
}
