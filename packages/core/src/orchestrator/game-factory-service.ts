import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { DATA_DIR, CODE_ROOT } from './config.js';
import { getDb, getMessagesByIds } from './db.js';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';
import {
  captureFactoryManifest,
  importFactorySource,
  ensureFactoryPrivateDirectory,
  captureFactoryManifestAsync,
  importFactorySourceAsync,
  ensureFactoryPrivateDirectoryAsync,
  bundleFactorySource,
  archiveFactoryBuild,
} from './game-factory-artifacts.js';
import { getGameFactoryRunState } from './game-factory-authorization.js';
import { observeFactoryHostRun } from './game-factory-run-state.js';
import {
  inspectFactoryPeerResult,
  importFactoryPeerResult,
  type FactoryPeerResultInspection,
} from './game-factory-peer-results.js';
import { checkFactoryPlatformManifest } from './game-factory-platforms.js';
import {
  observeFactoryImageJob,
  importFactoryImageAsset,
  type FactoryImportedImageReceipt,
} from './game-factory-image-assets.js';
import {
  bindGameFactoryLegacyJob,
  submitPersistedGameFactoryLegacyJob,
  observePersistedGameFactoryLegacyJob,
  cancelPersistedGameFactoryLegacyJob,
  inspectPersistedGameFactoryLegacySource,
  type FactoryLegacyObservation,
} from './game-factory-legacy.js';
import {
  bindGameFactoryPeerJob,
  preparePersistedGameFactoryPeerJob,
} from './game-factory-peer-state.js';
import { buildGameFactoryPeerContext } from './game-factory-peer-adapter.js';
import { peerCanonicalJson } from './peer-context.js';
import {
  verifyFactoryHtml5Build,
  type FactoryHtml5CheckInput,
  type FactoryHtml5CheckReceipt,
} from './game-factory-html5-check.js';
import {
  FACTORY_READ_ACTIONS,
  FactoryError,
  type FactoryActor,
  type FactoryActorPolicy,
  type FactoryBrief,
  type FactoryConfiguration,
  type FactoryProject,
  type FactoryRequest,
  type FactorySource,
  type FactoryBuild,
} from './game-factory-contracts.js';
import {
  ensureGameFactorySchema,
  factoryActorKey,
  GameFactoryStore,
  publicProjectView,
} from './game-factory-store.js';

const id = z.string().regex(/^[a-z][a-z0-9_-]{2,79}$/);
const operationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const texts = (max = 20) => z.array(text(500)).max(max);
const platform = z.enum(['local', 'yandex', 'crazygames', 'roblox']);
const backend = z.enum([
  'agent',
  'peer',
  'legacy',
  'codex_desktop',
  'claude_desktop',
  'gemini_desktop',
]);
const stage = z.enum([
  'brief',
  'playable',
  'art',
  'content',
  'qa',
  'package',
  'release',
  'learn',
]);
const requestSchema = z
  .object({
    operationId,
    action: text(40),
    projectId: id.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const briefSchema = z
  .object({
    goal: text(4000),
    audience: text(2000),
    firstSession: text(2000),
    coreLoop: text(2000),
    artDirection: text(3000),
    acceptance: texts().min(1),
    devices: z
      .array(z.enum(['desktop', 'mobile']))
      .min(1)
      .max(2),
    platforms: z.array(platform).min(1).max(4),
    exclusions: texts().default([]),
    budget: z
      .object({
        currency: z.literal('USD'),
        limitMicros: z.number().int().nonnegative().max(1_000_000_000_000),
      })
      .strict()
      .default({ currency: 'USD', limitMicros: 0 }),
    publication: z.literal('prepare_only').default('prepare_only'),
  })
  .strict();
const configSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    primaryOwnerIdentityId: text(256).optional(),
    actors: z
      .array(
        z
          .object({
            identityId: text(256),
            tenantId: text(256),
            alias: id,
            canCreate: z.boolean(),
            backends: z.array(backend).max(6),
            sourceRoots: z.array(text(4096)).max(30),
          })
          .strict(),
      )
      .max(20),
    workspaceRoot: text(4096),
    databasePath: text(4096),
    accounts: z
      .array(
        z
          .object({
            alias: id,
            platform,
            actorAliases: z.array(id).min(1).max(20),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    peer: z
      .object({
        coordinatorConfigPath: text(4096),
        networkId: z.string().regex(/^[a-f0-9]{24}$/),
        model: text(128),
        reasoningEffort: z.enum([
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
          'ultra',
        ]),
      })
      .strict()
      .optional(),
    legacy: z
      .object({ configurationPath: text(4096) })
      .strict()
      .optional(),
  })
  .strict();
const READ = new Set<string>(FACTORY_READ_ACTIONS);
const MUTATIONS = new Set([
  'create',
  'share',
  'brief',
  'decision',
  'forget_decision',
  'plan',
  'claim',
  'checkpoint',
  'release_claim',
  'pause',
  'resume',
  'cancel',
  'operation_link',
  'source_import',
  'build_capture',
  'evidence_record',
  'release_prepare',
  'release_observe',
  'asset_register',
  'renew_claim',
  'reconcile',
  'peer_dispatch',
  'peer_refresh',
  'verify_build',
  'human_feedback',
  'task_review',
  'release_package',
  'image_job_link',
  'image_asset_import',
  'asset_review',
  'legacy_dispatch',
  'legacy_refresh',
  'legacy_cancel',
  'legacy_import',
  'peer_import',
]);
const SECRET =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|парол[ья])\s*[:=]\s*\S+|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|-----BEGIN\s+(?:OPENSSH|RSA|EC|PRIVATE)\s+KEY-----/iu;
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new FactoryError('invalid_input');
  return parsed.data;
}
function assertInside(filename: string, root: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new FactoryError('path_outside_workspace');
}
function hasUnresolvedExecution(
  project: FactoryProject,
  taskId: string,
): boolean {
  return project.operations.some(
    (o) =>
      o.taskId === taskId &&
      o.tracking !== 'reference_only' &&
      ['linked', 'running', 'unknown'].includes(o.state),
  );
}

/** Отсутствие конфигурации выключает модуль; чтение не создаёт ни БД, ни каталоги. */
export function readGameFactoryConfiguration(): FactoryConfiguration | null {
  const filename =
    process.env.SKOOBI_GAME_FACTORY_CONFIG ||
    path.join(DATA_DIR, 'game-factory', 'config.json');
  if (!fs.existsSync(filename)) return null;
  const stat = fs.lstatSync(filename);
  if (
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new FactoryError('configuration_not_private');
  }
  const raw = readBoundedRegularFileNoFollowSync(filename, {
    maxBytes: 64 * 1024,
    oversize: 'reject',
    requireSingleLink: true,
  });
  let json: unknown;
  try {
    json = JSON.parse(raw.buffer.toString('utf8'));
  } catch {
    throw new FactoryError('configuration_invalid');
  }
  const config = parse(configSchema, json);
  if (
    !path.isAbsolute(config.workspaceRoot) ||
    !path.isAbsolute(config.databasePath) ||
    config.actors.some((a) => a.sourceRoots.some((r) => !path.isAbsolute(r)))
  )
    throw new FactoryError('configuration_paths_must_be_absolute');
  if (
    new Set(config.actors.map((a) => a.alias)).size !== config.actors.length ||
    new Set(config.actors.map(factoryActorKey)).size !== config.actors.length
  )
    throw new FactoryError('configuration_duplicate_actor');
  return config;
}

export function readGameFactoryActorPolicy(): {
  enabledActorIdentityIds: string[];
  primaryOwnerIdentityId?: string;
} {
  try {
    const config = readGameFactoryConfiguration();
    return config?.enabled
      ? {
          enabledActorIdentityIds: config.actors.map((a) => a.identityId),
          primaryOwnerIdentityId: config.primaryOwnerIdentityId,
        }
      : { enabledActorIdentityIds: [] };
  } catch {
    return { enabledActorIdentityIds: [] };
  }
}

/** Новое прямое сообщение отзывает право старого запуска менять требования. */
export function verifyFactoryCurrentSource(
  actor: FactoryActor,
  db: Database.Database,
): void {
  const direct = (messageId: string) => {
    const row = db
      .prepare(
        `SELECT m.sender,m.is_bot_message,mm.sender_identity_json,mi.sequence
      FROM messages m JOIN message_ingestion mi ON mi.id=m.id AND mi.chat_jid=m.chat_jid
      LEFT JOIN message_metadata mm ON mm.id=m.id AND mm.chat_jid=m.chat_jid
      WHERE m.chat_jid=? AND m.id=?`,
      )
      .get(actor.chatJid, messageId) as
      | {
          sender: string;
          is_bot_message: number;
          sender_identity_json: string | null;
          sequence: number;
        }
      | undefined;
    if (!row || row.is_bot_message || row.sender !== actor.senderId)
      return null;
    try {
      const identity = JSON.parse(row.sender_identity_json || 'null');
      if (
        identity?.telegram_message_origin !== 'direct' ||
        identity.channel !== 'telegram' ||
        identity.identity_id !== actor.identityId ||
        identity.telegram_user_id !== actor.senderId ||
        !actor.channelChatId ||
        identity.chat_id !== actor.channelChatId ||
        !identity.is_owner_sender
      )
        return null;
    } catch {
      return null;
    }
    return row;
  };
  if (!actor.currentMessageIds.length || actor.currentMessageIds.length > 200)
    throw new FactoryError('current_direct_source_required');
  const rows = actor.currentMessageIds.map(direct);
  if (rows.some((r) => r === null))
    throw new FactoryError('current_direct_source_required');
  const sequence = Math.max(...rows.map((r) => r!.sequence));
  const recent = db
    .prepare(
      `SELECT m.id FROM messages m JOIN message_ingestion mi ON mi.id=m.id AND mi.chat_jid=m.chat_jid
    WHERE m.chat_jid=? AND m.sender=? AND m.is_bot_message=0 AND mi.sequence>?
    ORDER BY mi.sequence DESC LIMIT 200`,
    )
    .all(actor.chatJid, actor.senderId, sequence) as Array<{ id: string }>;
  if (recent.some((r) => direct(r.id)))
    throw new FactoryError('newer_user_input_pending');
}

export interface FactoryArtifactSnapshot {
  sourceRoot: string;
  entrypoint: string;
  manifestSha256: string;
  files: FactoryBuild['files'];
  totalBytes: number;
}
export interface FactoryServiceDependencies {
  now?: () => string;
  verifyCurrentSource: (actor: FactoryActor) => void;
  capture?: (input: {
    sourceRoot: string;
    entrypoint: string;
    allowedRoots: string[];
  }) => FactoryArtifactSnapshot;
  importSource?: (input: {
    sourceRoot: string;
    entrypoint: string;
    allowedRoots: string[];
    destinationRoot: string;
  }) => FactoryArtifactSnapshot;
  observeRun?: (runId: string) => 'active' | 'finished' | 'unknown';
  ensureDirectory?: typeof ensureFactoryPrivateDirectory;
  bundle?: (
    input: Parameters<typeof bundleFactorySource>[0],
  ) => Awaited<ReturnType<typeof bundleFactorySource>>;
  validatePeerPayload?: (input: {
    jobId: string;
    contract: unknown;
    context: unknown;
  }) => void;
  verifyHtml5?: (input: FactoryHtml5CheckInput) => FactoryHtml5CheckReceipt;
  verifyFeedback?: (
    actor: FactoryActor,
    input: { messageId: string; quote: string },
  ) => boolean;
  archive?: (
    input: Parameters<typeof archiveFactoryBuild>[0],
  ) => Awaited<ReturnType<typeof archiveFactoryBuild>>;
  observeImage?: typeof observeFactoryImageJob;
  importImage?: (
    input: Parameters<typeof importFactoryImageAsset>[0],
  ) => FactoryImportedImageReceipt;
  observeLegacy?: (
    actor: FactoryActor,
    jobId: string,
  ) => FactoryLegacyObservation;
  importLegacy?: (input: {
    actor: FactoryActor;
    jobId: string;
    destinationRoot: string;
  }) => FactoryArtifactSnapshot;
  inspectPeerResult?: (
    actor: FactoryActor,
    input: { projectId: string; jobId: string },
  ) => FactoryPeerResultInspection;
  importPeerResult?: (
    input: Parameters<typeof importFactoryPeerResult>[0],
  ) => Awaited<ReturnType<typeof importFactoryPeerResult>>;
}

export class GameFactoryService {
  constructor(
    readonly config: FactoryConfiguration,
    readonly store: GameFactoryStore,
    readonly deps: FactoryServiceDependencies,
  ) {}

  private policy(actor: FactoryActor): FactoryActorPolicy {
    const policy = this.config.actors.find(
      (p) => p.identityId === actor.identityId && p.tenantId === actor.tenantId,
    );
    if (!this.config.enabled || !policy)
      throw new FactoryError('factory_actor_disabled');
    return policy;
  }

  execute(actor: FactoryActor, raw: FactoryRequest): unknown {
    const policy = this.policy(actor);
    const request = parse(requestSchema, raw);
    if (!READ.has(request.action) && !MUTATIONS.has(request.action))
      throw new FactoryError('unknown_action');
    const args = request.args ?? {};
    const now = this.deps.now?.() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(now)))
      throw new FactoryError('invalid_clock');
    const source = (): FactorySource => ({
      actorKey: factoryActorKey(actor),
      messageIds: [...actor.currentMessageIds],
      at: now,
      trust: 'agent_interpreted',
    });
    if (request.action === 'capabilities') {
      parse(z.object({}).strict(), args);
      return {
        enabled: true,
        alias: policy.alias,
        canCreate: policy.canCreate,
        backends: policy.backends.filter(
          (b) =>
            b === 'agent' ||
            (b === 'peer' && !!this.config.peer) ||
            (b === 'legacy' && !!this.config.legacy),
        ),
        backendCapabilities: policy.backends
          .filter(
            (b) =>
              b !== 'codex_desktop' ||
              (actor.isPrimaryOwner === true &&
                actor.identityId === this.config.primaryOwnerIdentityId),
          )
          .map((b) => ({
            backend: b,
            availability:
              b === 'agent'
                ? 'current_authorized_session'
                : (b === 'peer' && this.config.peer) ||
                    (b === 'legacy' && this.config.legacy)
                  ? 'configured_requires_live_worker_check'
                  : 'unavailable_adapter_not_configured',
          })),
        execution: 'existing_agent_and_peer_operations',
        publication: 'prepare_only',
        paidGeneration: 'disabled_without_separate_budget_authorization',
        desktop: 'installation_is_not_verification',
        publicationAccounts: (this.config.accounts ?? [])
          .filter((a) => a.actorAliases.includes(policy.alias))
          .map((a) => ({ alias: a.alias, platform: a.platform })),
      };
    }
    if (request.action === 'list') {
      parse(z.object({}).strict(), args);
      return { projects: this.store.list(actor) };
    }
    if (READ.has(request.action)) {
      if (!request.projectId) throw new FactoryError('project_required');
      const project = this.store.read(actor, request.projectId);
      if (request.action === 'peer_result') {
        const input = parse(
          z.object({ jobId: z.string().uuid() }).strict(),
          args,
        );
        if (!this.deps.inspectPeerResult)
          throw new FactoryError('peer_result_adapter_unavailable');
        return this.deps.inspectPeerResult(actor, {
          projectId: project.id,
          jobId: input.jobId,
        });
      }
      if (request.action === 'context') {
        const input = parse(z.object({ taskId: id.optional() }).strict(), args);
        const relevantTasks = project.tasks.filter(
          (t) =>
            t.briefRevision === project.brief.revision &&
            !['superseded', 'cancelled'].includes(t.state) &&
            (input.taskId
              ? t.id === input.taskId
              : t.id === project.lease?.taskId || t.state === 'pending'),
        );
        return {
          projectId: project.id,
          revision: project.revision,
          brief: project.brief,
          decisions: project.decisions
            .filter((d) => d.state === 'accepted' || d.state === 'proposed')
            .slice(-5),
          tasks: relevantTasks.slice(0, 2),
          status: project.status,
          lease: project.lease
            ? {
                taskId: project.lease.taskId,
                state: project.lease.state,
                expiresAt: project.lease.expiresAt,
              }
            : null,
          source: 'shared_project_only_no_personal_memory',
          moreContext:
            'inspect paginated decisions/tasks before acting; this is a bounded summary',
        };
      }
      const input = parse(
        z
          .object({
            section: z
              .enum([
                'overview',
                'tasks',
                'taskHistory',
                'decisions',
                'builds',
                'operations',
                'evidence',
                'releases',
                'assets',
                'briefHistory',
                'check',
              ])
              .default('overview'),
            receiptId: id.optional(),
            cursor: z.number().int().nonnegative().default(0),
            limit: z.number().int().min(1).max(10).default(5),
          })
          .strict(),
        args,
      );
      if (input.section === 'check') {
        if (!input.receiptId) throw new FactoryError('receipt_required');
        const row = this.store.db
          .prepare(
            'SELECT receipt_json,receipt_sha256 FROM factory_check_receipts WHERE id=? AND project_id=?',
          )
          .get(input.receiptId, project.id) as
          | { receipt_json: string; receipt_sha256: string }
          | undefined;
        if (!row) throw new FactoryError('receipt_unavailable');
        return {
          projectId: project.id,
          receiptId: input.receiptId,
          sha256: row.receipt_sha256,
          receipt: JSON.parse(row.receipt_json),
        };
      }
      if (input.section !== 'overview') {
        const records = project[input.section] ?? [];
        const items = records
          .slice(input.cursor, input.cursor + input.limit)
          .map((item) => {
            if (input.section !== 'builds') return item;
            const build = item as FactoryBuild;
            return {
              ...build,
              files: build.files.slice(0, 20),
              totalFiles: build.files.length,
              fileListComplete: build.files.length <= 20,
            };
          });
        return {
          projectId: project.id,
          revision: project.revision,
          section: input.section,
          items,
          total: records.length,
          nextCursor:
            input.cursor + items.length < records.length
              ? input.cursor + items.length
              : null,
        };
      }
      return {
        project: publicProjectView(project, actor),
        role: this.store.role(actor, project.id),
      };
    }
    this.deps.verifyCurrentSource(actor);
    if (SECRET.test(JSON.stringify(args)))
      throw new FactoryError('project_content_looks_secret');
    if (request.action === 'create') {
      if (!policy.canCreate) throw new FactoryError('create_not_allowed');
      if (!request.projectId || request.expectedRevision !== 0)
        throw new FactoryError('create_requires_id_and_zero_revision');
      const input = parse(
        z
          .object({
            title: text(200),
            engine: z.enum(['canvas', 'phaser', 'threejs', 'roblox', 'other']),
            brief: briefSchema,
            origin: z
              .object({ projectId: id.optional(), note: text(2000) })
              .strict()
              .optional(),
          })
          .strict(),
        args,
      );
      if (input.origin?.projectId)
        this.store.read(actor, input.origin.projectId);
      const project: FactoryProject = {
        id: request.projectId,
        title: input.title,
        engine: input.engine,
        ownerKey: factoryActorKey(actor),
        revision: 1,
        status: 'active',
        workspace: path.join(this.config.workspaceRoot, request.projectId),
        createdAt: now,
        updatedAt: now,
        origin: input.origin,
        brief: { ...input.brief, revision: 1, source: source() },
        briefHistory: [],
        decisions: [],
        tasks: [],
        taskHistory: [],
        lease: null,
        fencing: 0,
        builds: [],
        operations: [],
        evidence: [],
        releases: [],
        assets: [],
      };
      return this.store.create(actor, request, project);
    }
    if (!request.projectId || request.expectedRevision === undefined)
      throw new FactoryError('project_and_revision_required');
    const roles = ['share', 'resume', 'cancel'].includes(request.action)
      ? (['owner'] as const)
      : [
            'evidence_record',
            'verify_build',
            'human_feedback',
            'task_review',
          ].includes(request.action)
        ? (['owner', 'editor', 'reviewer'] as const)
        : (['owner', 'editor'] as const);
    return this.store.mutate(actor, request, roles, now, (project) => {
      const active = () => {
        if (project.status !== 'active')
          throw new FactoryError('project_not_active');
      };
      const reviseRequirements = (
        brief: Omit<FactoryBrief, 'revision' | 'source'> = project.brief,
      ) => {
        project.briefHistory.push(project.brief);
        project.brief = {
          ...brief,
          revision: project.brief.revision + 1,
          source: source(),
        };
        for (const t of project.tasks)
          if (!['accepted', 'cancelled'].includes(t.state))
            t.state = 'superseded';
        if (project.lease) project.lease.state = 'reconcile_required';
        project.fencing++;
      };
      const lease = (token: string) => {
        active();
        const current = project.lease;
        if (
          !current ||
          current.token !== token ||
          current.actorKey !== factoryActorKey(actor) ||
          current.runId !== actor.runId ||
          current.briefRevision !== project.brief.revision
        )
          throw new FactoryError('writer_lease_mismatch');
        if (
          current.state !== 'active' ||
          Date.parse(current.expiresAt) <= Date.parse(now)
        )
          throw new FactoryError('lease_reconciliation_required');
        return current;
      };
      switch (request.action) {
        case 'share': {
          const input = parse(
            z
              .object({
                alias: id,
                role: z.enum(['editor', 'reviewer', 'reader']).nullable(),
              })
              .strict(),
            args,
          );
          const member = this.config.actors.find(
            (a) => a.alias === input.alias,
          );
          if (!member) throw new FactoryError('member_unavailable');
          this.store.setMember(project, factoryActorKey(member), input.role);
          if (
            project.lease?.actorKey === factoryActorKey(member) &&
            input.role !== 'editor'
          ) {
            project.lease.state = 'reconcile_required';
            project.fencing++;
          }
          return { memberAlias: input.alias, memberRole: input.role };
        }
        case 'brief': {
          active();
          const input = parse(briefSchema, args);
          reviseRequirements(input);
          return { previousExecutionMustReconcile: project.lease !== null };
        }
        case 'decision': {
          const input = parse(
            z
              .object({
                key: id,
                value: text(4000),
                state: z.enum(['proposed', 'accepted']),
              })
              .strict(),
            args,
          );
          const previous = project.decisions
            .filter((d) => d.key === input.key)
            .at(-1);
          if (previous?.state === 'forgotten')
            throw new FactoryError(
              'forgotten_decision_requires_new_explicit_source',
            );
          const replacedAccepted = previous?.state === 'accepted';
          if (previous) previous.state = 'superseded';
          project.decisions.push({
            ...input,
            revision: (previous?.revision ?? 0) + 1,
            replaces: previous?.revision,
            source: source(),
          });
          if (input.state === 'accepted' || replacedAccepted)
            reviseRequirements();
          if (project.decisions.length > 500)
            throw new FactoryError('decision_limit');
          return {};
        }
        case 'forget_decision': {
          const input = parse(z.object({ key: id }).strict(), args);
          const previous = project.decisions
            .filter((d) => d.key === input.key)
            .at(-1);
          if (!previous) throw new FactoryError('decision_unavailable');
          const affectedRequirements = previous.state === 'accepted';
          for (const d of project.decisions.filter(
            (d) => d.key === input.key,
          )) {
            d.value = '';
            d.state = 'forgotten';
          }
          project.decisions.push({
            key: input.key,
            value: '',
            state: 'forgotten',
            revision: previous.revision + 1,
            source: source(),
          });
          this.store.redactHistoricalResults(project.id);
          if (affectedRequirements) reviseRequirements();
          return {};
        }
        case 'plan': {
          active();
          if (project.lease)
            throw new FactoryError('writer_must_reconcile_before_replan');
          const input = parse(
            z
              .object({
                tasks: z
                  .array(
                    z
                      .object({
                        id,
                        stage,
                        title: text(400),
                        acceptance: texts(20).min(1),
                        dependencies: z.array(id).max(30),
                        humanReviewRequired: z.boolean().default(false),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(50),
              })
              .strict(),
            args,
          );
          const seen = new Set<string>();
          const historicalIds = new Set(
            [...(project.taskHistory ?? []), ...project.tasks].map((t) => t.id),
          );
          for (const task of input.tasks) {
            if (historicalIds.has(task.id))
              throw new FactoryError('task_id_already_used');
            if (
              seen.has(task.id) ||
              task.dependencies.some((d) => !seen.has(d))
            )
              throw new FactoryError('task_dependencies_not_topological');
            seen.add(task.id);
          }
          project.taskHistory = [
            ...(project.taskHistory ?? []),
            ...project.tasks.map((t) => ({
              ...t,
              state: t.state === 'accepted' ? t.state : ('superseded' as const),
            })),
          ];
          if (project.taskHistory.length > 1000)
            throw new FactoryError('task_history_limit');
          project.tasks = input.tasks.map((t) => ({
            ...t,
            briefRevision: project.brief.revision,
            state: 'pending',
            operationIds: [],
          }));
          return {};
        }
        case 'claim': {
          active();
          const input = parse(
            z
              .object({
                taskId: id,
                backend,
                baseBuildId: id.optional(),
                ttlSeconds: z.number().int().min(60).max(3600).default(600),
              })
              .strict(),
            args,
          );
          if (!policy.backends.includes(input.backend))
            throw new FactoryError('backend_not_allowed');
          if (
            input.backend === 'codex_desktop' &&
            !(
              actor.isPrimaryOwner === true &&
              actor.identityId === this.config.primaryOwnerIdentityId
            )
          )
            throw new FactoryError('backend_owner_only');
          if (
            input.backend.endsWith('_desktop') ||
            (input.backend === 'legacy' && !this.config.legacy)
          )
            throw new FactoryError('backend_adapter_unavailable');
          if (input.backend === 'peer' && !this.config.peer)
            throw new FactoryError('peer_not_configured');
          if (project.lease)
            throw new FactoryError(
              Date.parse(project.lease.expiresAt) <= Date.parse(now)
                ? 'lease_reconciliation_required'
                : 'writer_already_claimed',
            );
          const task = project.tasks.find((t) => t.id === input.taskId);
          if (
            !task ||
            task.briefRevision !== project.brief.revision ||
            !['pending', 'blocked'].includes(task.state)
          )
            throw new FactoryError('task_not_available');
          if (
            task.dependencies.some(
              (d) =>
                project.tasks.find((t) => t.id === d)?.state !== 'accepted',
            )
          )
            throw new FactoryError('task_dependencies_pending');
          project.fencing++;
          const workDirectory = (
            this.deps.ensureDirectory ?? ensureFactoryPrivateDirectory
          )({
            root: this.config.workspaceRoot,
            relativePath: `${project.id}/work/${project.fencing}-${request.operationId}`,
          });
          project.lease = {
            token: randomUUID(),
            fencing: project.fencing,
            actorKey: factoryActorKey(actor),
            runId: actor.runId,
            taskId: task.id,
            backend: input.backend,
            briefRevision: project.brief.revision,
            acquiredAt: now,
            heartbeatAt: now,
            expiresAt: new Date(
              Date.parse(now) + input.ttlSeconds * 1000,
            ).toISOString(),
            state: 'active',
            workDirectory,
          };
          task.state = 'working';
          let sourceDirectory: string | undefined;
          if (input.baseBuildId) {
            const base = project.builds.find((b) => b.id === input.baseBuildId);
            if (!base || !this.deps.capture || !this.deps.importSource)
              throw new FactoryError('base_build_unavailable');
            const before = this.deps.capture({
              sourceRoot: base.root,
              entrypoint: base.entrypoint,
              allowedRoots: [project.workspace],
            });
            if (before.manifestSha256 !== base.manifestSha256)
              throw new FactoryError('base_build_changed');
            sourceDirectory = path.join(workDirectory, 'source');
            const seeded = this.deps.importSource({
              sourceRoot: base.root,
              entrypoint: base.entrypoint,
              allowedRoots: [project.workspace],
              destinationRoot: sourceDirectory,
            });
            if (seeded.manifestSha256 !== base.manifestSha256)
              throw new FactoryError('base_build_changed');
          }
          return {
            claim: project.lease,
            workDirectory,
            ...(sourceDirectory ? { sourceDirectory } : {}),
          };
        }
        case 'checkpoint': {
          const input = parse(
            z
              .object({
                token: text(100),
                summary: text(4000),
                state: z.enum(['working', 'submitted', 'blocked']),
                buildId: id.optional(),
              })
              .strict(),
            args,
          );
          const current = lease(input.token);
          const task = project.tasks.find((t) => t.id === current.taskId)!;
          if (
            input.buildId &&
            !project.builds.some(
              (b) =>
                b.id === input.buildId &&
                b.briefRevision === project.brief.revision,
            )
          )
            throw new FactoryError('build_not_current');
          if (
            input.state === 'submitted' &&
            !input.buildId &&
            task.stage !== 'brief' &&
            task.stage !== 'learn'
          )
            throw new FactoryError('submitted_task_requires_build');
          task.checkpoint = input.summary;
          task.state = input.state;
          task.buildId = input.buildId;
          current.heartbeatAt = now;
          current.expiresAt = new Date(Date.parse(now) + 600_000).toISOString();
          return { acceptance: 'submission_is_not_quality_acceptance' };
        }
        case 'release_claim': {
          const input = parse(z.object({ token: text(100) }).strict(), args);
          const current = project.lease;
          // Подтвердивший поправку тот же исполнитель может освободить старую
          // блокировку. Это не разрешение продолжать устаревшую работу.
          if (
            !current ||
            current.token !== input.token ||
            current.actorKey !== factoryActorKey(actor) ||
            current.runId !== actor.runId
          )
            throw new FactoryError('writer_lease_mismatch');
          if (hasUnresolvedExecution(project, current.taskId))
            throw new FactoryError('external_execution_unresolved');
          const task = project.tasks.find((t) => t.id === current.taskId);
          if (task?.state === 'working') task.state = 'pending';
          project.lease = null;
          return {};
        }
        case 'renew_claim': {
          active();
          const input = parse(z.object({ token: text(100) }).strict(), args);
          const current = project.lease;
          if (
            !current ||
            current.token !== input.token ||
            current.actorKey !== factoryActorKey(actor) ||
            current.runId !== actor.runId ||
            current.briefRevision !== project.brief.revision ||
            current.state !== 'active'
          )
            throw new FactoryError('writer_lease_mismatch');
          current.heartbeatAt = now;
          current.expiresAt = new Date(Date.parse(now) + 600_000).toISOString();
          return { claim: current };
        }
        case 'reconcile': {
          parse(z.object({}).strict(), args);
          const current = project.lease;
          if (!current) return { reconciled: true, reason: 'no_writer' };
          if (
            current.actorKey !== factoryActorKey(actor) &&
            this.store.role(actor, project.id) !== 'owner'
          )
            throw new FactoryError('writer_owned_by_another_actor');
          if (this.deps.observeRun?.(current.runId) !== 'finished')
            throw new FactoryError('previous_execution_not_confirmed_finished');
          if (hasUnresolvedExecution(project, current.taskId))
            throw new FactoryError('external_execution_unresolved');
          const task = project.tasks.find((t) => t.id === current.taskId);
          if (task?.state === 'working')
            task.state =
              task.briefRevision === project.brief.revision
                ? 'pending'
                : 'superseded';
          project.lease = null;
          project.fencing++;
          return {
            reconciled: true,
            previousWorkspaceMustRemainIsolated: true,
          };
        }
        case 'pause':
        case 'cancel':
        case 'resume': {
          parse(z.object({}).strict(), args);
          if (request.action === 'resume') {
            if (project.status !== 'paused')
              throw new FactoryError('only_paused_project_can_resume');
            if (project.lease)
              throw new FactoryError('writer_reconciliation_required');
            project.status = 'active';
          } else {
            if (request.action === 'pause' && project.status !== 'active')
              throw new FactoryError('only_active_project_can_pause');
            if (
              request.action === 'cancel' &&
              !['active', 'paused'].includes(project.status)
            )
              throw new FactoryError('project_already_terminal');
            project.status =
              request.action === 'pause' ? 'paused' : 'cancelled';
            if (project.lease) project.lease.state = 'reconcile_required';
            project.fencing++;
            if (project.status === 'cancelled')
              for (const t of project.tasks)
                if (t.state !== 'accepted') t.state = 'cancelled';
          }
          return { externalCancellationRequired: project.lease !== null };
        }
        case 'operation_link': {
          active();
          const input = parse(
            z
              .object({
                kind: z.enum([
                  'peer',
                  'image',
                  'legacy',
                  'desktop',
                  'delivery',
                  'asset',
                ]),
                externalId: text(256),
                taskId: id.optional(),
              })
              .strict(),
            args,
          );
          if (
            input.taskId &&
            !project.tasks.some(
              (t) =>
                t.id === input.taskId &&
                t.briefRevision === project.brief.revision,
            )
          )
            throw new FactoryError('task_not_available');
          const previous = project.operations.find(
            (o) => o.kind === input.kind && o.externalId === input.externalId,
          );
          if (previous) return { operation: previous };
          const operation = {
            ...input,
            id: `op-${randomUUID()}`,
            briefRevision: project.brief.revision,
            state: 'linked' as const,
            evidence: 'reported' as const,
            tracking: 'reference_only' as const,
            observedAt: now,
          };
          project.operations.push(operation);
          if (input.taskId)
            project.tasks
              .find((t) => t.id === input.taskId)!
              .operationIds.push(operation.id);
          return {
            operation,
            executionVerified: false,
            limitation:
              'Reference only; use the typed dispatch/refresh adapter to track execution.',
          };
        }
        case 'legacy_dispatch': {
          const input = parse(
            z
              .object({
                token: text(100),
                timeoutSeconds: z
                  .number()
                  .int()
                  .min(120)
                  .max(1800)
                  .default(1200),
              })
              .strict(),
            args,
          );
          const current = lease(input.token);
          if (
            current.backend !== 'legacy' ||
            !policy.backends.includes('legacy') ||
            !this.config.legacy
          )
            throw new FactoryError('legacy_dispatch_not_allowed');
          const task = project.tasks.find((t) => t.id === current.taskId)!;
          if (hasUnresolvedExecution(project, task.id))
            throw new FactoryError('external_execution_unresolved');
          const jobId = randomUUID();
          bindGameFactoryLegacyJob({
            db: this.store.db,
            config: this.config,
            actor,
            project,
            task,
            jobId,
            createdAt: now,
            timeoutSeconds: input.timeoutSeconds,
          });
          const operation = {
            id: `op-${randomUUID()}`,
            kind: 'legacy' as const,
            externalId: jobId,
            taskId: task.id,
            briefRevision: project.brief.revision,
            state: 'linked' as const,
            evidence: 'host_observed' as const,
            tracking: 'execution' as const,
            observedAt: now,
          };
          project.operations.push(operation);
          task.operationIds.push(operation.id);
          return {
            legacyJobId: jobId,
            operation,
            paidMusicEnabled: false,
            generationAccepted: false,
          };
        }
        case 'legacy_refresh':
        case 'legacy_cancel': {
          const input = parse(
            z.object({ jobId: z.string().uuid() }).strict(),
            args,
          );
          if (!policy.backends.includes('legacy'))
            throw new FactoryError('backend_not_allowed');
          const operation = project.operations.find(
            (o) =>
              o.kind === 'legacy' &&
              o.externalId === input.jobId &&
              o.tracking === 'execution',
          );
          if (!operation) throw new FactoryError('legacy_binding_unavailable');
          if (request.action === 'legacy_cancel') {
            const tombstone = this.store.db
              .prepare(
                'UPDATE factory_legacy_bindings SET cancel_requested=1 WHERE job_id=? AND project_id=?',
              )
              .run(input.jobId, project.id);
            if (tombstone.changes !== 1)
              throw new FactoryError('legacy_binding_unavailable');
            operation.state = 'unknown';
            operation.observedAt = now;
            operation.detail =
              'Cancellation requested; refresh is required to confirm that execution stopped.';
            return { legacyJobId: input.jobId, operation, stopped: false };
          }
          if (!this.deps.observeLegacy)
            throw new FactoryError('legacy_adapter_unavailable');
          const observed = this.deps.observeLegacy(actor, input.jobId);
          operation.state = observed.operationState;
          operation.evidence = 'host_observed';
          operation.observedAt = observed.observedAt;
          operation.detail = JSON.stringify(observed);
          return {
            operation,
            observation: observed,
            gameQualityAccepted: false,
          };
        }
        case 'legacy_import': {
          active();
          const input = parse(
            z.object({ jobId: z.string().uuid(), version: text(100) }).strict(),
            args,
          );
          if (
            !policy.backends.includes('legacy') ||
            !this.deps.importLegacy ||
            !this.deps.ensureDirectory
          )
            throw new FactoryError('legacy_adapter_unavailable');
          const operation = project.operations.find(
            (o) =>
              o.kind === 'legacy' &&
              o.externalId === input.jobId &&
              o.tracking === 'execution' &&
              o.briefRevision === project.brief.revision,
          );
          if (
            !operation ||
            operation.state !== 'completed' ||
            operation.evidence !== 'host_observed'
          )
            throw new FactoryError('legacy_execution_not_finished');
          const parent = this.deps.ensureDirectory({
            root: this.config.workspaceRoot,
            relativePath: `${project.id}/builds`,
          });
          const snapshot = this.deps.importLegacy({
            actor,
            jobId: input.jobId,
            destinationRoot: path.join(parent, `legacy-${input.jobId}`),
          });
          const existing = project.builds.find(
            (b) => b.id === `legacy-${input.jobId}`,
          );
          if (existing) {
            if (existing.manifestSha256 !== snapshot.manifestSha256)
              throw new FactoryError('legacy_result_changed');
            return {
              imported: {
                ...existing,
                files: existing.files.slice(0, 10),
                totalFiles: existing.files.length,
                fileListComplete: existing.files.length <= 10,
              },
            };
          }
          const build: FactoryBuild = {
            id: `legacy-${input.jobId}`,
            briefRevision: project.brief.revision,
            version: input.version,
            root: snapshot.sourceRoot,
            entrypoint: snapshot.entrypoint,
            manifestSha256: snapshot.manifestSha256,
            files: snapshot.files,
            totalBytes: snapshot.totalBytes,
            capturedAt: now,
            capturedBy: factoryActorKey(actor),
          };
          project.builds.push(build);
          if (project.builds.length > 50) throw new FactoryError('build_limit');
          return {
            imported: {
              ...build,
              files: build.files.slice(0, 10),
              totalFiles: build.files.length,
              fileListComplete: build.files.length <= 10,
            },
            qualityAccepted: false,
          };
        }
        case 'peer_import': {
          active();
          const input = parse(
            z
              .object({
                jobId: z.string().uuid(),
                artifactName: text(128).optional(),
                entrypoint: text(1024),
                version: text(100),
              })
              .strict(),
            args,
          );
          if (
            !policy.backends.includes('peer') ||
            !this.deps.importPeerResult ||
            !this.deps.ensureDirectory
          )
            throw new FactoryError('peer_result_adapter_unavailable');
          const operation = project.operations.find(
            (o) =>
              o.kind === 'peer' &&
              o.externalId === input.jobId &&
              o.tracking === 'execution' &&
              o.briefRevision === project.brief.revision,
          );
          if (
            !operation ||
            operation.state !== 'completed' ||
            operation.evidence !== 'host_observed' ||
            operation.resultConflict
          )
            throw new FactoryError('peer_execution_not_finished');
          const selector = createHash('sha256')
            .update(
              JSON.stringify([input.artifactName ?? null, input.entrypoint]),
            )
            .digest('hex')
            .slice(0, 8);
          const buildId = `peer-${input.jobId}-${selector}`;
          const parent = this.deps.ensureDirectory({
            root: this.config.workspaceRoot,
            relativePath: `${project.id}/builds`,
          });
          const snapshot = this.deps.importPeerResult({
            actor,
            projectId: project.id,
            jobId: input.jobId,
            artifactName: input.artifactName,
            entrypoint: input.entrypoint,
            destinationRoot: path.join(parent, buildId),
          });
          const existing = project.builds.find((b) => b.id === buildId);
          if (existing) {
            if (existing.manifestSha256 !== snapshot.manifestSha256)
              throw new FactoryError('peer_result_changed');
            return {
              imported: {
                ...existing,
                files: existing.files.slice(0, 10),
                totalFiles: existing.files.length,
                fileListComplete: existing.files.length <= 10,
              },
              peerReceipt: snapshot.peerReceipt,
            };
          }
          const build: FactoryBuild = {
            id: buildId,
            briefRevision: project.brief.revision,
            version: input.version,
            root: snapshot.sourceRoot,
            entrypoint: snapshot.entrypoint,
            manifestSha256: snapshot.manifestSha256,
            files: snapshot.files,
            totalBytes: snapshot.totalBytes,
            capturedAt: now,
            capturedBy: factoryActorKey(actor),
          };
          project.builds.push(build);
          if (project.builds.length > 50) throw new FactoryError('build_limit');
          return {
            imported: {
              ...build,
              files: build.files.slice(0, 10),
              totalFiles: build.files.length,
              fileListComplete: build.files.length <= 10,
            },
            peerReceipt: snapshot.peerReceipt,
            qualityAccepted: false,
          };
        }
        case 'peer_dispatch': {
          const output = z
            .object({
              name: text(128).refine(
                (s) =>
                  Buffer.byteLength(s) <= 128 &&
                  !s.startsWith('.') &&
                  !/[\\/\r\n\0]/.test(s),
              ),
              kind: z.enum(['text', 'document', 'photo', 'code']),
            })
            .strict();
          const criterion = z
            .object({
              id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
              description: text(1000),
              kind: z.enum([
                'manual',
                'text_contains',
                'file_present',
                'file_contains',
                'file_sha256',
                'json_parse',
                'artifact',
              ]),
              outputName: text(128).optional(),
              expected: text(2000)
                .refine((s) => Buffer.byteLength(s) <= 4000)
                .optional(),
              scenario: z
                .record(z.string(), z.unknown())
                .refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 32000)
                .optional(),
            })
            .strict();
          const input = parse(
            z
              .object({
                token: text(100),
                goal: text(4000).optional(),
                inputBuildId: id.optional(),
                expectedOutputs: z.array(output).min(1).max(20),
                acceptance: z.array(criterion).min(1).max(30),
                timeoutSeconds: z
                  .number()
                  .int()
                  .min(60)
                  .max(7200)
                  .default(1200),
                allowBattery: z.boolean().default(false),
              })
              .strict(),
            args,
          );
          const current = lease(input.token);
          if (
            current.backend !== 'peer' ||
            !policy.backends.includes('peer') ||
            !this.config.peer
          )
            throw new FactoryError('peer_dispatch_not_allowed');
          if (!this.deps.validatePeerPayload)
            throw new FactoryError('peer_contract_validator_unavailable');
          const task = project.tasks.find((t) => t.id === current.taskId)!;
          if (
            project.operations.some(
              (o) =>
                o.taskId === task.id &&
                o.kind === 'peer' &&
                o.tracking !== 'reference_only' &&
                ['linked', 'running', 'unknown'].includes(o.state),
            )
          )
            throw new FactoryError('peer_task_already_dispatched');
          const outputNames = new Set(input.expectedOutputs.map((o) => o.name));
          if (
            outputNames.size !== input.expectedOutputs.length ||
            new Set(input.acceptance.map((a) => a.id)).size !==
              input.acceptance.length ||
            input.acceptance.some(
              (a) =>
                (a.outputName && !outputNames.has(a.outputName)) ||
                ([
                  'file_present',
                  'file_contains',
                  'file_sha256',
                  'json_parse',
                  'artifact',
                ].includes(a.kind) &&
                  !a.outputName) ||
                (['text_contains', 'file_contains'].includes(a.kind) &&
                  !a.expected) ||
                (a.kind === 'file_sha256' &&
                  !/^[a-f0-9]{64}$/.test(a.expected || '')),
            )
          )
            throw new FactoryError('peer_acceptance_invalid');
          const inputs: unknown[] = [];
          if (input.inputBuildId) {
            const build = project.builds.find(
              (b) => b.id === input.inputBuildId,
            );
            if (!build || !this.deps.bundle)
              throw new FactoryError('peer_input_build_unavailable');
            const bundled = this.deps.bundle({
              sourceRoot: build.root,
              entrypoint: build.entrypoint,
              allowedRoots: [project.workspace],
              expectedManifestSha256: build.manifestSha256,
            });
            inputs.push({
              name: bundled.name,
              sha256: bundled.sha256,
              data: bundled.data,
            });
          }
          const jobId = randomUUID(),
            expiresAt = new Date(
              Date.parse(now) + 24 * 60 * 60 * 1000,
            ).toISOString();
          const goal =
            input.goal ?? `${task.title}\n${task.acceptance.join('\n')}`;
          if (Buffer.byteLength(goal) > 16000)
            throw new FactoryError('peer_goal_too_large');
          const contract = {
            schema: 1,
            revision: 1,
            parentTaskId: `factory:${jobId}`,
            projectKey: project.id,
            source: { messageId: actor.currentMessageIds.at(-1) },
            goal,
            expectedOutputs: input.expectedOutputs,
            acceptance: input.acceptance,
            execution: {
              mode: 'isolated',
              timeoutMs: input.timeoutSeconds * 1000,
              expiresAt,
              maxOutputBytes: 16 * 1024 * 1024,
              maxWorkspaceBytes: 128 * 1024 * 1024,
              allowBattery: input.allowBattery,
              guiAuthorized: false,
            },
            runtime: {
              model: this.config.peer.model,
              reasoningEffort: this.config.peer.reasoningEffort,
            },
            dependsOnParent: false,
          };
          const options = {
            title: task.title.slice(0, 200),
            prompt: `${goal}\nИспользуй только переданный проектный контекст и source.zip, если он приложен. Не читай личную память, другие проекты и аккаунтную конфигурацию. Верни объявленные файлы и правдивый отчёт проверок. Не публикуй, не отправляй сообщения и не запускай платные сервисы.`,
            notify: true,
            inputs,
            contract,
          };
          const binding = bindGameFactoryPeerJob({
            db: this.store.db,
            config: this.config,
            actor,
            project,
            task,
            jobId,
            createdAt: now,
            expiresAt,
            inputBuildIds: input.inputBuildId ? [input.inputBuildId] : [],
            options,
          });
          this.deps.validatePeerPayload({
            jobId,
            contract,
            context: buildGameFactoryPeerContext({
              ...binding,
              current: true,
              routeAllowed: true,
            }),
          });
          const operation = {
            id: `op-${randomUUID()}`,
            kind: 'peer' as const,
            externalId: jobId,
            briefRevision: project.brief.revision,
            taskId: task.id,
            state: 'linked' as const,
            evidence: 'host_observed' as const,
            tracking: 'execution' as const,
            observedAt: now,
            detail: 'Reserved locally; remote acceptance is not yet confirmed.',
          };
          project.operations.push(operation);
          task.operationIds.push(operation.id);
          return { peerJobId: jobId, operation, remoteAccepted: false };
        }
        case 'peer_refresh': {
          if (!policy.backends.includes('peer'))
            throw new FactoryError('backend_not_allowed');
          const input = parse(
            z.object({ operationId: text(128) }).strict(),
            args,
          );
          const operation = project.operations.find(
            (o) => o.id === input.operationId && o.kind === 'peer',
          );
          if (!operation) throw new FactoryError('peer_operation_unavailable');
          return { peerJobId: operation.externalId, operation };
        }
        case 'source_import': {
          active();
          if (project.lease) throw new FactoryError('writer_already_claimed');
          if (project.builds.length >= 50)
            throw new FactoryError('build_limit');
          if (!this.deps.importSource)
            throw new FactoryError('import_adapter_unavailable');
          const input = parse(
            z
              .object({
                sourceRoot: text(4096),
                entrypoint: text(256),
                note: text(2000),
                version: text(80).default('source-import'),
              })
              .strict(),
            args,
          );
          const destinationRoot = path.join(
            project.workspace,
            'imports',
            request.operationId,
          );
          (this.deps.ensureDirectory ?? ensureFactoryPrivateDirectory)({
            root: this.config.workspaceRoot,
            relativePath: `${project.id}/imports`,
          });
          const snapshot = this.deps.importSource({
            sourceRoot: input.sourceRoot,
            entrypoint: input.entrypoint,
            allowedRoots: policy.sourceRoots,
            destinationRoot,
          });
          project.origin = {
            ...project.origin,
            sourceRoot: input.sourceRoot,
            note: input.note,
          };
          const build: FactoryBuild = {
            id: `import-${randomUUID()}`,
            briefRevision: project.brief.revision,
            version: input.version,
            root: snapshot.sourceRoot,
            entrypoint: snapshot.entrypoint,
            manifestSha256: snapshot.manifestSha256,
            files: snapshot.files,
            totalBytes: snapshot.totalBytes,
            capturedAt: now,
            capturedBy: factoryActorKey(actor),
          };
          project.builds.push(build);
          return {
            imported: {
              ...build,
              files: build.files.slice(0, 10),
              totalFiles: build.files.length,
              fileListComplete: build.files.length <= 10,
            },
            workingCopy: destinationRoot,
          };
        }
        case 'build_capture': {
          const input = parse(
            z
              .object({
                token: text(100),
                sourceRoot: text(4096),
                entrypoint: text(256),
                version: text(80),
              })
              .strict(),
            args,
          );
          const current = lease(input.token);
          if (project.builds.length >= 50)
            throw new FactoryError('build_limit');
          if (!this.deps.importSource)
            throw new FactoryError('artifact_adapter_unavailable');
          assertInside(input.sourceRoot, current.workDirectory);
          (this.deps.ensureDirectory ?? ensureFactoryPrivateDirectory)({
            root: this.config.workspaceRoot,
            relativePath: `${project.id}/builds`,
          });
          const snapshot = this.deps.importSource({
            sourceRoot: input.sourceRoot,
            entrypoint: input.entrypoint,
            allowedRoots: [current.workDirectory],
            destinationRoot: path.join(
              project.workspace,
              'builds',
              request.operationId,
            ),
          });
          const build: FactoryBuild = {
            id: `build-${randomUUID()}`,
            briefRevision: project.brief.revision,
            version: input.version,
            root: snapshot.sourceRoot,
            entrypoint: snapshot.entrypoint,
            manifestSha256: snapshot.manifestSha256,
            files: snapshot.files,
            totalBytes: snapshot.totalBytes,
            capturedAt: now,
            capturedBy: factoryActorKey(actor),
          };
          project.builds.push(build);
          if (project.builds.length > 50) throw new FactoryError('build_limit');
          return {
            build: {
              ...build,
              files: build.files.slice(0, 10),
              totalFiles: build.files.length,
              fileListComplete: build.files.length <= 10,
            },
          };
        }
        case 'evidence_record': {
          const input = parse(
            z
              .object({
                buildId: id,
                kind: z.enum([
                  'technical',
                  'browser',
                  'device',
                  'human',
                  'platform',
                ]),
                criterion: text(2000),
                result: z.enum(['pass', 'fail', 'unknown']),
              })
              .strict(),
            args,
          );
          const build = project.builds.find((b) => b.id === input.buildId);
          if (!build) throw new FactoryError('build_unavailable');
          const evidence = {
            ...input,
            id: `ev-${randomUUID()}`,
            manifestSha256: build.manifestSha256,
            trust: 'reported' as const,
            source: source(),
          };
          project.evidence.push(evidence);
          return {
            evidence,
            warning: 'agent_report_does_not_prove_execution_or_human_approval',
          };
        }
        case 'verify_build': {
          active();
          const input = parse(z.object({ buildId: id }).strict(), args);
          const build = project.builds.find(
            (b) =>
              b.id === input.buildId &&
              b.briefRevision === project.brief.revision,
          );
          if (!build) throw new FactoryError('build_not_current');
          if (project.engine === 'roblox')
            throw new FactoryError('roblox_requires_studio_verification');
          if (!this.deps.verifyHtml5)
            throw new FactoryError('html5_checker_unavailable');
          const receipt = this.deps.verifyHtml5({
            sourceRoot: build.root,
            entrypoint: build.entrypoint,
            allowedRoots: [project.workspace],
            expectedManifestSha256: build.manifestSha256,
          });
          if (
            receipt.manifestSha256 !== build.manifestSha256 ||
            receipt.kind !== 'html5_startup_smoke' ||
            receipt.trust !== 'host_verified'
          )
            throw new FactoryError('check_receipt_mismatch');
          const receiptId = `check-${randomUUID()}`,
            serialized = peerCanonicalJson(receipt),
            receiptSha256 = createHash('sha256')
              .update(serialized)
              .digest('hex');
          if (Buffer.byteLength(serialized) > 96 * 1024)
            throw new FactoryError('check_receipt_too_large');
          this.store.db
            .prepare(
              'INSERT INTO factory_check_receipts(id,project_id,build_id,manifest_sha256,receipt_sha256,receipt_json,created_at) VALUES(?,?,?,?,?,?,?)',
            )
            .run(
              receiptId,
              project.id,
              build.id,
              build.manifestSha256,
              receiptSha256,
              serialized,
              now,
            );
          const evidence = {
            id: `ev-${randomUUID()}`,
            buildId: build.id,
            manifestSha256: build.manifestSha256,
            kind: 'technical' as const,
            criterion: 'html5_startup_smoke',
            result:
              receipt.status === 'passed'
                ? ('pass' as const)
                : receipt.status === 'failed'
                  ? ('fail' as const)
                  : ('unknown' as const),
            trust: 'host_verified' as const,
            source: source(),
            receiptId,
            receiptSha256,
            assurance: 'startup_only' as const,
          };
          project.evidence.push(evidence);
          return {
            evidence,
            checkStatus: receipt.status,
            limitations: receipt.limitations,
            fullGameplayVerified: false,
            humanAcceptanceRecorded: false,
          };
        }
        case 'human_feedback': {
          const input = parse(
            z
              .object({
                buildId: id,
                messageId: text(256),
                quote: text(4000),
                result: z.enum(['pass', 'fail', 'unknown']),
              })
              .strict(),
            args,
          );
          const build = project.builds.find((b) => b.id === input.buildId);
          if (!build) throw new FactoryError('build_unavailable');
          if (
            !actor.currentMessageIds.includes(input.messageId) ||
            !this.deps.verifyFeedback?.(actor, input)
          )
            throw new FactoryError('human_feedback_source_not_verified');
          const receiptId = `feedback-${randomUUID()}`;
          const serialized = peerCanonicalJson({
            kind: 'verified_user_quote',
            messageId: input.messageId,
            quote: input.quote,
            interpretation: input.result,
            interpretationTrust: 'agent_interpreted',
            buildId: build.id,
            manifestSha256: build.manifestSha256,
            actorKey: factoryActorKey(actor),
          });
          const receiptSha256 = createHash('sha256')
            .update(serialized)
            .digest('hex');
          this.store.db
            .prepare(
              'INSERT INTO factory_check_receipts(id,project_id,build_id,manifest_sha256,receipt_sha256,receipt_json,created_at) VALUES(?,?,?,?,?,?,?)',
            )
            .run(
              receiptId,
              project.id,
              build.id,
              build.manifestSha256,
              receiptSha256,
              serialized,
              now,
            );
          const evidence = {
            id: `ev-${randomUUID()}`,
            buildId: build.id,
            manifestSha256: build.manifestSha256,
            kind: 'human' as const,
            criterion: 'human_feedback',
            result: input.result,
            trust: 'host_verified' as const,
            source: source(),
            receiptId,
            receiptSha256,
            assurance: 'verified_user_quote' as const,
          };
          project.evidence.push(evidence);
          return {
            evidence,
            interpretationTrust: 'agent_interpreted',
            publicationAuthorized: false,
          };
        }
        case 'task_review': {
          active();
          const input = parse(
            z
              .object({
                taskId: id,
                decision: z.enum(['accepted', 'changes_requested']),
                note: text(4000),
                evidenceIds: z.array(id).max(30),
              })
              .strict(),
            args,
          );
          const task = project.tasks.find(
            (t) =>
              t.id === input.taskId &&
              t.briefRevision === project.brief.revision,
          );
          if (!task || task.state !== 'submitted')
            throw new FactoryError('task_not_submitted');
          if (
            project.lease?.taskId === task.id ||
            hasUnresolvedExecution(project, task.id)
          )
            throw new FactoryError('execution_not_reconciled');
          if (
            input.decision === 'accepted' &&
            project.operations.some(
              (o) => o.taskId === task.id && o.resultConflict,
            )
          )
            throw new FactoryError('conflicting_execution_results');
          const evidence = input.evidenceIds.map((id) =>
            project.evidence.find(
              (e) => e.id === id && e.buildId === task.buildId,
            ),
          );
          if (evidence.some((e) => !e))
            throw new FactoryError('review_evidence_unavailable');
          if (
            input.decision === 'accepted' &&
            !['brief', 'learn'].includes(task.stage)
          ) {
            const build = project.builds.find(
              (b) =>
                b.id === task.buildId &&
                b.briefRevision === project.brief.revision,
            );
            if (
              !build ||
              !evidence.some(
                (e) =>
                  e?.trust === 'host_verified' &&
                  e.kind === 'technical' &&
                  e.result === 'pass',
              )
            )
              throw new FactoryError('technical_evidence_required');
            if (
              !this.deps.capture ||
              this.deps.capture({
                sourceRoot: build.root,
                entrypoint: build.entrypoint,
                allowedRoots: [project.workspace],
              }).manifestSha256 !== build.manifestSha256
            )
              throw new FactoryError('review_build_changed');
            if (evidence.some((e) => e?.result !== 'pass'))
              throw new FactoryError('review_has_unresolved_evidence');
            if (
              task.humanReviewRequired &&
              !evidence.some(
                (e) =>
                  e?.kind === 'human' &&
                  e.assurance === 'verified_user_quote' &&
                  e.result === 'pass',
              )
            )
              throw new FactoryError('human_review_required');
          }
          task.review = {
            actorKey: factoryActorKey(actor),
            at: now,
            decision: input.decision,
            note: input.note,
            evidenceIds: input.evidenceIds,
            assurance: 'coordinator_judgment',
          };
          task.state = input.decision === 'accepted' ? 'accepted' : 'blocked';
          return {
            review: task.review,
            factualAssurance:
              'See exact evidence; coordinator judgment is not full gameplay proof.',
          };
        }
        case 'release_prepare': {
          active();
          const input = parse(
            z
              .object({
                buildId: id,
                platform,
                mode: z.enum(['preview', 'basic', 'full']),
                accountAlias: id,
                sourceOfFirstPlayers: text(2000),
                reviewAt: z.string().datetime(),
              })
              .strict(),
            args,
          );
          const build = project.builds.find(
            (b) =>
              b.id === input.buildId &&
              b.briefRevision === project.brief.revision,
          );
          if (!build) throw new FactoryError('build_not_current');
          if (
            !this.deps.capture ||
            this.deps.capture({
              sourceRoot: build.root,
              entrypoint: build.entrypoint,
              allowedRoots: [project.workspace],
            }).manifestSha256 !== build.manifestSha256
          )
            throw new FactoryError('release_build_changed');
          if (!project.brief.platforms.includes(input.platform))
            throw new FactoryError('platform_outside_brief');
          if (
            !this.config.accounts?.some(
              (a) =>
                a.alias === input.accountAlias &&
                a.platform === input.platform &&
                a.actorAliases.includes(policy.alias),
            )
          )
            throw new FactoryError('publication_account_unavailable');
          const release = {
            ...input,
            id: `release-${randomUUID()}`,
            state: 'prepared' as const,
          };
          project.releases.push(release);
          return { release, publicationAuthorized: false };
        }
        case 'release_observe': {
          const input = parse(
            z
              .object({
                releaseId: id,
                state: z.enum([
                  'reported_submitted',
                  'reported_live',
                  'rejected',
                ]),
                receipt: text(4000),
              })
              .strict(),
            args,
          );
          const release = project.releases.find(
            (r) => r.id === input.releaseId,
          );
          if (!release) throw new FactoryError('release_unavailable');
          release.state = input.state;
          release.receipt = input.receipt;
          release.observedAt = now;
          return { release, evidence: 'reported_not_host_verified' };
        }
        case 'release_package': {
          active();
          const input = parse(z.object({ releaseId: id }).strict(), args);
          const release = project.releases.find(
            (r) => r.id === input.releaseId,
          );
          if (!release || release.state !== 'prepared')
            throw new FactoryError('release_not_prepared');
          const build = project.builds.find(
            (b) =>
              b.id === release.buildId &&
              b.briefRevision === project.brief.revision,
          );
          if (!build) throw new FactoryError('build_not_current');
          if (!project.brief.platforms.includes(release.platform))
            throw new FactoryError('platform_outside_brief');
          if (
            !this.config.accounts?.some(
              (a) =>
                a.alias === release.accountAlias &&
                a.platform === release.platform &&
                a.actorAliases.includes(policy.alias),
            )
          )
            throw new FactoryError('publication_account_unavailable');
          if (!this.deps.archive || !this.deps.ensureDirectory)
            throw new FactoryError('packager_unavailable');
          const preflight = checkFactoryPlatformManifest({
            manifest: { ...build, sourceRoot: build.root },
            platform: release.platform,
            mode: release.mode,
          });
          if (preflight.status !== 'pass')
            throw new FactoryError('platform_manifest_check_failed');
          const directory = this.deps.ensureDirectory({
            root: this.config.workspaceRoot,
            relativePath: `${project.id}/releases/${release.id}`,
          });
          const bundle = this.deps.archive({
            sourceRoot: build.root,
            entrypoint: build.entrypoint,
            allowedRoots: [project.workspace],
            expectedManifestSha256: build.manifestSha256,
            destinationFile: path.join(directory, 'game.zip'),
          });
          if (bundle.manifestSha256 !== build.manifestSha256)
            throw new FactoryError('package_manifest_mismatch');
          release.bundle = {
            ...bundle,
            createdAt: now,
            profileId: preflight.profile.id,
          };
          return {
            release,
            preflight,
            publicationAuthorized: false,
            releaseReady: false,
            limitation:
              'Exact candidate archive only. SDK integration, gameplay, media and portal review remain separate requirements.',
          };
        }
        case 'image_job_link': {
          active();
          const input = parse(
            z.object({ jobId: text(128), taskId: id.optional() }).strict(),
            args,
          );
          if (!this.deps.observeImage)
            throw new FactoryError('image_adapter_unavailable');
          if (
            input.taskId &&
            !project.tasks.some(
              (t) =>
                t.id === input.taskId &&
                t.briefRevision === project.brief.revision,
            )
          )
            throw new FactoryError('task_not_available');
          const observed = this.deps.observeImage(actor, input.jobId);
          let operation = project.operations.find(
            (o) => o.kind === 'image' && o.externalId === input.jobId,
          );
          if (operation?.taskId && operation.taskId !== input.taskId)
            throw new FactoryError('image_task_binding_mismatch');
          if (!operation) {
            operation = {
              id: `op-${randomUUID()}`,
              kind: 'image',
              externalId: input.jobId,
              taskId: input.taskId,
              briefRevision: project.brief.revision,
              state: 'linked',
              evidence: 'host_observed',
              tracking: 'reference_only',
              observedAt: now,
            };
            project.operations.push(operation);
            if (input.taskId)
              project.tasks
                .find((t) => t.id === input.taskId)!
                .operationIds.push(operation.id);
          }
          // Generation belongs to the existing image pipeline; observing it does
          // not create a new factory executor or claim that delivery succeeded.
          operation.state = observed.generationCompletedAt
            ? 'completed'
            : observed.status === 'failed'
              ? 'failed'
              : 'running';
          operation.evidence = 'host_observed';
          operation.tracking = 'reference_only';
          operation.observedAt = now;
          operation.detail = JSON.stringify({
            provider: observed.provider,
            status: observed.status,
            origin: observed.origin,
            cost: observed.cost,
          });
          return { operation, observation: observed, startsGeneration: false };
        }
        case 'image_asset_import': {
          active();
          const input = parse(
            z
              .object({
                jobId: text(128),
                artifactId: text(128),
                rights: text(2000),
              })
              .strict(),
            args,
          );
          if (!this.deps.importImage || !this.deps.ensureDirectory)
            throw new FactoryError('image_adapter_unavailable');
          const parent = this.deps.ensureDirectory({
            root: this.config.workspaceRoot,
            relativePath: `${project.id}/assets`,
          });
          const key = createHash('sha256')
            .update(JSON.stringify([input.jobId, input.artifactId]))
            .digest('hex')
            .slice(0, 32);
          const receipt = this.deps.importImage({
            actor,
            jobId: input.jobId,
            artifactId: input.artifactId,
            destinationRoot: path.join(parent, `image-${key}`),
          });
          const relativePath = path.relative(
            project.workspace,
            path.join(receipt.root, receipt.file.path),
          );
          assertInside(
            path.join(project.workspace, relativePath),
            project.workspace,
          );
          const existing = project.assets.find(
            (a) => a.relativePath === relativePath,
          );
          if (existing) {
            if (existing.file.sha256 !== receipt.file.sha256)
              throw new FactoryError('image_asset_changed');
            return {
              asset: existing,
              receipt,
              qualityAccepted: existing.state === 'accepted',
            };
          }
          const asset = {
            id: `asset-${randomUUID()}`,
            file: receipt.file,
            relativePath,
            kind: 'image' as const,
            provenance: JSON.stringify({
              provider: receipt.provider,
              jobId: receipt.jobId,
              artifactId: receipt.artifactId,
              promptSha256: receipt.promptSha256,
              originReceiptSha256: receipt.originReceiptSha256,
              receiptSha256: receipt.receiptSha256,
            }),
            rights: input.rights,
            provider: receipt.provider,
            externalId: receipt.jobId,
            state: 'candidate' as const,
            source: source(),
          };
          project.assets.push(asset);
          return {
            asset,
            receipt,
            qualityAccepted: false,
            rightsEvidence: 'reported_not_license_verification',
            paidGenerationStarted: false,
          };
        }
        case 'asset_review': {
          active();
          const input = parse(
            z
              .object({
                assetId: id,
                state: z.enum(['accepted', 'rejected']),
                note: text(4000),
              })
              .strict(),
            args,
          );
          const asset = project.assets.find((a) => a.id === input.assetId);
          if (!asset || !this.deps.capture)
            throw new FactoryError('asset_unavailable');
          const file = path.resolve(project.workspace, asset.relativePath);
          assertInside(file, project.workspace);
          const observed = this.deps.capture({
            sourceRoot: path.dirname(file),
            entrypoint: path.basename(file),
            allowedRoots: [project.workspace],
          });
          const current = observed.files.find(
            (f) => f.path === path.basename(file),
          );
          if (current?.sha256 !== asset.file.sha256)
            throw new FactoryError('asset_changed_before_review');
          asset.state = input.state;
          asset.review = {
            state: input.state,
            note: input.note,
            source: source(),
          };
          return {
            asset,
            reviewAssurance: 'coordinator_judgment',
            humanApprovalVerified: false,
          };
        }
        case 'asset_register': {
          const input = parse(
            z
              .object({
                relativePath: text(1024),
                kind: z.enum([
                  'image',
                  'audio',
                  'video',
                  'font',
                  'model',
                  'other',
                ]),
                provenance: text(4000),
                rights: text(2000),
                provider: text(100).optional(),
                externalId: text(256).optional(),
                costMicros: z.number().int().nonnegative().optional(),
                state: z.enum(['candidate', 'accepted', 'rejected']),
              })
              .strict(),
            args,
          );
          if (!this.deps.capture)
            throw new FactoryError('artifact_adapter_unavailable');
          const filePath = path.resolve(project.workspace, input.relativePath);
          assertInside(filePath, project.workspace);
          const snapshot = this.deps.capture({
            sourceRoot: path.dirname(filePath),
            entrypoint: path.basename(filePath),
            allowedRoots: [project.workspace],
          });
          const file = snapshot.files.find(
            (f) => f.path === path.basename(filePath),
          );
          if (!file) throw new FactoryError('asset_unavailable');
          const asset = {
            ...input,
            id: `asset-${randomUUID()}`,
            file,
            source: source(),
          };
          project.assets.push(asset);
          return { asset, costEvidence: 'reported_requires_provider_receipt' };
        }
        default:
          throw new FactoryError('unknown_action');
      }
    });
  }
}

type FactoryIoKind =
  | 'capture'
  | 'import'
  | 'directory'
  | 'bundle'
  | 'html5_check'
  | 'archive'
  | 'image_import'
  | 'legacy_observe'
  | 'legacy_import'
  | 'peer_inspect'
  | 'peer_import';
class FactoryIoPreparation extends Error {
  constructor(
    readonly kind: FactoryIoKind,
    readonly input: unknown,
    readonly key: string,
  ) {
    super('Host filesystem preparation required');
  }
}

export function validateGameFactoryDatabaseLocation(filename: string): boolean {
  const parent = path.dirname(filename);
  if (!fs.existsSync(parent))
    throw new FactoryError('database_parent_unavailable');
  const parentStat = fs.lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    fs.realpathSync(parent) !== parent ||
    (parentStat.mode & 0o077) !== 0 ||
    (process.getuid && parentStat.uid !== process.getuid())
  )
    throw new FactoryError('database_parent_not_private');
  if (!fs.existsSync(filename)) return false;
  const stat = fs.lstatSync(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new FactoryError('database_not_private');
  return true;
}

async function executeGameFactoryRequestInner(
  actor: FactoryActor,
  payload: FactoryRequest,
): Promise<unknown> {
  const request = parse(requestSchema, payload);
  const readOnly = READ.has(request.action);
  if (!readOnly && !MUTATIONS.has(request.action))
    throw new FactoryError('unknown_action');
  const peerContracts =
    request.action === 'peer_dispatch'
      ? await import(
          pathToFileURL(
            path.join(CODE_ROOT, 'ops/peer/skoobi-peer-contract.mjs'),
          ).href
        )
      : null;
  const prepared = new Map<string, unknown>();
  const io = <T>(kind: FactoryIoKind, input: unknown): T => {
    const key = JSON.stringify([kind, input]);
    if (prepared.has(key)) return prepared.get(key) as T;
    throw new FactoryIoPreparation(kind, input, key);
  };
  for (let round = 0; round < 6; round++) {
    // После внешнего чтения заново проверяем и политику, и свежесть команды.
    const config = readGameFactoryConfiguration();
    if (!config?.enabled) throw new FactoryError('factory_disabled');
    if (
      !config.actors.some(
        (a) =>
          a.identityId === actor.identityId && a.tenantId === actor.tenantId,
      )
    )
      throw new FactoryError('factory_actor_disabled');
    if (!readOnly) verifyFactoryCurrentSource(actor, getDb());
    const exists = validateGameFactoryDatabaseLocation(config.databasePath);
    const db = new Database(
      !exists && readOnly ? ':memory:' : config.databasePath,
      { readonly: exists && readOnly },
    );
    let pending: FactoryIoPreparation | undefined;
    try {
      if (!readOnly) {
        fs.chmodSync(config.databasePath, 0o600);
        db.pragma('foreign_keys = ON');
        db.pragma('busy_timeout = 5000');
        ensureGameFactorySchema(db);
      }
      const result = new GameFactoryService(config, new GameFactoryStore(db), {
        verifyCurrentSource: (current) =>
          verifyFactoryCurrentSource(current, getDb()),
        capture: (input) => io<FactoryArtifactSnapshot>('capture', input),
        importSource: (input) => io<FactoryArtifactSnapshot>('import', input),
        ensureDirectory: (input) => io<string>('directory', input),
        bundle: (input) =>
          io<Awaited<ReturnType<typeof bundleFactorySource>>>('bundle', input),
        archive: (input) =>
          io<Awaited<ReturnType<typeof archiveFactoryBuild>>>('archive', input),
        observeImage: observeFactoryImageJob,
        importImage: (input) =>
          io<FactoryImportedImageReceipt>('image_import', input),
        observeLegacy: (actor, jobId) =>
          io<FactoryLegacyObservation>('legacy_observe', { actor, jobId }),
        importLegacy: (input) =>
          io<FactoryArtifactSnapshot>('legacy_import', input),
        inspectPeerResult: (actor, input) =>
          io<FactoryPeerResultInspection>('peer_inspect', { actor, ...input }),
        importPeerResult: (input) =>
          io<Awaited<ReturnType<typeof importFactoryPeerResult>>>(
            'peer_import',
            input,
          ),
        verifyHtml5: (input) =>
          io<FactoryHtml5CheckReceipt>('html5_check', input),
        verifyFeedback: (current, input) =>
          getMessagesByIds(current.chatJid, [input.messageId]).some(
            (m) =>
              m.sender === current.senderId &&
              m.sender_identity?.identity_id === current.identityId &&
              m.sender_identity?.telegram_message_origin === 'direct' &&
              m.content.includes(input.quote),
          ),
        validatePeerPayload: peerContracts
          ? ({ jobId, contract, context }) => {
              peerContracts.validatePeerContract(contract);
              peerContracts.validatePeerContext(context, {
                id: jobId,
                contract,
              });
            }
          : undefined,
        observeRun: (runId) =>
          observeFactoryHostRun(db, runId, getGameFactoryRunState(runId)),
      }).execute(actor, request);
      if (
        ['peer_dispatch', 'peer_refresh'].includes(request.action) &&
        result &&
        typeof result === 'object' &&
        'peerJobId' in result &&
        typeof result.peerJobId === 'string'
      ) {
        // Локальная очередь existing peer заполняется после коммита binding.
        // Повтор использует тот же jobId даже после потери первого ответа.
        const queue = await preparePersistedGameFactoryPeerJob(
          actor,
          result.peerJobId,
        );
        return { ...result, queue };
      }
      if (
        ['legacy_dispatch', 'legacy_cancel'].includes(request.action) &&
        result &&
        typeof result === 'object' &&
        'legacyJobId' in result &&
        typeof result.legacyJobId === 'string'
      ) {
        const observation = await (
          request.action === 'legacy_cancel'
            ? cancelPersistedGameFactoryLegacyJob
            : submitPersistedGameFactoryLegacyJob
        )(actor, result.legacyJobId);
        return { ...result, observation, requiresRefresh: true };
      }
      return result;
    } catch (error) {
      if (!(error instanceof FactoryIoPreparation)) throw error;
      pending = error;
    } finally {
      db.close();
    }
    // Транзакция уже отменена. Долгий обход файлов не держит SQLite lock и
    // выполняется дочерним процессом, не блокируя event loop Скуби.
    const result =
      pending.kind === 'directory'
        ? await ensureFactoryPrivateDirectoryAsync(
            pending.input as Parameters<
              typeof ensureFactoryPrivateDirectory
            >[0],
          )
        : pending.kind === 'bundle'
          ? await bundleFactorySource(
              pending.input as Parameters<typeof bundleFactorySource>[0],
            )
          : pending.kind === 'html5_check'
            ? await verifyFactoryHtml5Build(
                pending.input as FactoryHtml5CheckInput,
              )
            : pending.kind === 'archive'
              ? await archiveFactoryBuild(
                  pending.input as Parameters<typeof archiveFactoryBuild>[0],
                )
              : pending.kind === 'image_import'
                ? await importFactoryImageAsset(
                    pending.input as Parameters<
                      typeof importFactoryImageAsset
                    >[0],
                  )
                : pending.kind === 'legacy_observe'
                  ? await observePersistedGameFactoryLegacyJob(
                      (pending.input as { actor: FactoryActor }).actor,
                      (pending.input as { jobId: string }).jobId,
                    )
                  : pending.kind === 'legacy_import'
                    ? await importLegacySource(
                        pending.input as {
                          actor: FactoryActor;
                          jobId: string;
                          destinationRoot: string;
                        },
                      )
                    : pending.kind === 'peer_inspect'
                      ? await inspectFactoryPeerResult(
                          (pending.input as { actor: FactoryActor }).actor,
                          pending.input as { projectId: string; jobId: string },
                        )
                      : pending.kind === 'peer_import'
                        ? await importFactoryPeerResult(
                            pending.input as Parameters<
                              typeof importFactoryPeerResult
                            >[0],
                          )
                        : pending.kind === 'capture'
                          ? await captureFactoryManifestAsync(
                              pending.input as Parameters<
                                typeof captureFactoryManifest
                              >[0],
                            )
                          : await importFactorySourceAsync(
                              pending.input as Parameters<
                                typeof importFactorySource
                              >[0],
                            );
    prepared.set(pending.key, result);
  }
  throw new FactoryError('filesystem_preparation_did_not_converge');
}

async function importLegacySource(input: {
  actor: FactoryActor;
  jobId: string;
  destinationRoot: string;
}): Promise<FactoryArtifactSnapshot> {
  const source = await inspectPersistedGameFactoryLegacySource(
    input.actor,
    input.jobId,
  );
  const snapshot = await importFactorySourceAsync({
    ...source,
    destinationRoot: input.destinationRoot,
  });
  await inspectPersistedGameFactoryLegacySource(input.actor, input.jobId);
  return snapshot;
}

const factoryRequestsInFlight = new Map<
  string,
  { hash: string; result: Promise<unknown> }
>();
/** Повтор IPC после тайм-аута наблюдает ту же локальную операцию. */
export async function executeGameFactoryRequest(
  actor: FactoryActor,
  payload: FactoryRequest,
): Promise<unknown> {
  const request = parse(requestSchema, payload);
  if (READ.has(request.action))
    return executeGameFactoryRequestInner(actor, request);
  const key = JSON.stringify([factoryActorKey(actor), request.operationId]);
  const hash = createHash('sha256')
    .update(peerCanonicalJson(request))
    .digest('hex');
  const pending = factoryRequestsInFlight.get(key);
  if (pending) {
    if (pending.hash !== hash) throw new FactoryError('operation_id_conflict');
    return pending.result;
  }
  const result = executeGameFactoryRequestInner(actor, request);
  factoryRequestsInFlight.set(key, { hash, result });
  try {
    return await result;
  } finally {
    if (factoryRequestsInFlight.get(key)?.result === result)
      factoryRequestsInFlight.delete(key);
  }
}
