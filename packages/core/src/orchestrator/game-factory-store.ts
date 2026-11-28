import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  FactoryError,
  type FactoryActor,
  type FactoryProject,
  type FactoryRequest,
  type FactoryRole,
} from './game-factory-contracts.js';

export const factoryActorKey = (
  actor: Pick<FactoryActor, 'identityId' | 'tenantId'>,
): string =>
  createHash('sha256')
    .update(JSON.stringify([actor.tenantId, actor.identityId]))
    .digest('hex');

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

export function ensureGameFactorySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_projects (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS factory_members (
      project_id TEXT NOT NULL REFERENCES factory_projects(id) ON DELETE CASCADE,
      actor_key TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','editor','reviewer','reader')),
      PRIMARY KEY(project_id, actor_key)
    );
    CREATE INDEX IF NOT EXISTS factory_members_actor ON factory_members(actor_key);
    CREATE TABLE IF NOT EXISTS factory_requests (
      actor_key TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(actor_key, operation_id)
    );
    CREATE TABLE IF NOT EXISTS factory_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      actor_key TEXT NOT NULL,
      action TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS factory_peer_bindings (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      actor_key TEXT NOT NULL,
      binding_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS factory_peer_events (
      event_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES factory_peer_bindings(job_id),
      event_sha256 TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS factory_legacy_bindings (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      actor_key TEXT NOT NULL,
      binding_json TEXT NOT NULL,
      provider_job_id TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      notice_json TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS factory_audio_bindings (
      job_id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      actor_key TEXT NOT NULL,
      binding_json TEXT NOT NULL,
      provider_job_id TEXT,
      observation_json TEXT,
      prepared_json TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS factory_check_receipts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      build_id TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS factory_host_runs (
      invocation_run_id TEXT PRIMARY KEY,
      actor_key TEXT NOT NULL,
      host_instance_id TEXT NOT NULL,
      diagnostic_attempt_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      completion_source TEXT CHECK(completion_source IS NULL OR completion_source='host_finally')
    );
  `);
}

type StoredProject = { document_json: string; revision: number };
type Replay = {
  project_id: string;
  payload_sha256: string;
  result_json: string;
};

/** Реестр хранит проекты и ссылки на операции. Он не исполняет вторую очередь. */
export class GameFactoryStore {
  constructor(readonly db: Database.Database) {}

  hasSchema(): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_projects'",
        )
        .get(),
    );
  }

  role(actor: FactoryActor, projectId: string): FactoryRole | null {
    if (!this.hasSchema()) return null;
    const row = this.db
      .prepare(
        'SELECT role FROM factory_members WHERE project_id=? AND actor_key=?',
      )
      .get(projectId, factoryActorKey(actor)) as
      | { role: FactoryRole }
      | undefined;
    return row?.role ?? null;
  }

  requireRole(
    actor: FactoryActor,
    projectId: string,
    roles: readonly FactoryRole[],
  ): FactoryRole {
    const role = this.role(actor, projectId);
    // Не различаем чужую и несуществующую игру для постороннего автора.
    if (!role || !roles.includes(role))
      throw new FactoryError('project_unavailable');
    return role;
  }

  list(
    actor: FactoryActor,
  ): Array<
    Pick<
      FactoryProject,
      'id' | 'title' | 'revision' | 'status' | 'updatedAt'
    > & { role: FactoryRole }
  > {
    if (!this.hasSchema()) return [];
    const rows = this.db
      .prepare(
        `SELECT p.document_json, m.role FROM factory_projects p
      JOIN factory_members m ON m.project_id=p.id WHERE m.actor_key=? ORDER BY p.updated_at DESC LIMIT 200`,
      )
      .all(factoryActorKey(actor)) as Array<{
      document_json: string;
      role: FactoryRole;
    }>;
    return rows.map((row) => {
      const p = JSON.parse(row.document_json) as FactoryProject;
      return {
        id: p.id,
        title: p.title,
        revision: p.revision,
        status: p.status,
        updatedAt: p.updatedAt,
        role: row.role,
      };
    });
  }

  read(actor: FactoryActor, projectId: string): FactoryProject {
    this.requireRole(actor, projectId, [
      'owner',
      'editor',
      'reviewer',
      'reader',
    ]);
    const row = this.db
      .prepare('SELECT document_json FROM factory_projects WHERE id=?')
      .get(projectId) as StoredProject | undefined;
    if (!row) throw new FactoryError('project_unavailable');
    return JSON.parse(row.document_json) as FactoryProject;
  }

  members(
    actor: FactoryActor,
    projectId: string,
  ): Array<{ actorKey: string; role: FactoryRole }> {
    this.requireRole(actor, projectId, ['owner']);
    return (
      this.db
        .prepare(
          'SELECT actor_key, role FROM factory_members WHERE project_id=?',
        )
        .all(projectId) as Array<{ actor_key: string; role: FactoryRole }>
    ).map((r) => ({ actorKey: r.actor_key, role: r.role }));
  }

  private replay(
    actor: FactoryActor,
    request: FactoryRequest,
  ): unknown | undefined {
    const row = this.db
      .prepare(
        'SELECT project_id,payload_sha256,result_json FROM factory_requests WHERE actor_key=? AND operation_id=?',
      )
      .get(factoryActorKey(actor), request.operationId) as Replay | undefined;
    if (!row) return undefined;
    this.requireRole(actor, row.project_id, [
      'owner',
      'editor',
      'reviewer',
      'reader',
    ]);
    if (
      row.payload_sha256 !==
      createHash('sha256').update(canonical(request)).digest('hex')
    ) {
      throw new FactoryError('operation_id_conflict');
    }
    return JSON.parse(row.result_json);
  }

  private record(
    actor: FactoryActor,
    request: FactoryRequest,
    project: FactoryProject,
    result: unknown,
  ): void {
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) > 2 * 1024 * 1024)
      throw new FactoryError('result_too_large');
    this.db
      .prepare(
        'INSERT INTO factory_requests(actor_key,operation_id,project_id,payload_sha256,result_json,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        factoryActorKey(actor),
        request.operationId,
        project.id,
        createHash('sha256').update(canonical(request)).digest('hex'),
        encoded,
        project.updatedAt,
      );
    this.db
      .prepare(
        'INSERT INTO factory_events(project_id,revision,actor_key,action,operation_id,at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        project.id,
        project.revision,
        factoryActorKey(actor),
        request.action,
        request.operationId,
        project.updatedAt,
      );
  }

  create(
    actor: FactoryActor,
    request: FactoryRequest,
    project: FactoryProject,
  ): unknown {
    return this.db
      .transaction(() => {
        const prior = this.replay(actor, request);
        if (prior !== undefined) return prior;
        if (
          this.db
            .prepare('SELECT 1 FROM factory_projects WHERE id=?')
            .get(project.id)
        )
          throw new FactoryError('project_unavailable');
        this.db
          .prepare(
            'INSERT INTO factory_projects(id,revision,document_json,updated_at) VALUES(?,?,?,?)',
          )
          .run(
            project.id,
            project.revision,
            JSON.stringify(project),
            project.updatedAt,
          );
        this.db
          .prepare(
            'INSERT INTO factory_members(project_id,actor_key,role) VALUES(?,?,?)',
          )
          .run(project.id, factoryActorKey(actor), 'owner');
        const result = {
          project: publicProjectView(project, actor),
          role: 'owner',
        };
        this.record(actor, request, project, result);
        return result;
      })
      .immediate();
  }

  mutate(
    actor: FactoryActor,
    request: FactoryRequest,
    roles: readonly FactoryRole[],
    now: string,
    update: (project: FactoryProject, role: FactoryRole) => unknown,
  ): unknown {
    if (!request.projectId) throw new FactoryError('project_required');
    return this.db
      .transaction(() => {
        // Отзыв прав действует и для повторов ранее разрешённой операции.
        const role = this.requireRole(actor, request.projectId!, roles);
        const prior = this.replay(actor, request);
        if (prior !== undefined) return prior;
        const project = this.read(actor, request.projectId!);
        if (project.revision !== request.expectedRevision)
          throw new FactoryError('revision_conflict', project.revision);
        const extra = update(project, role);
        project.revision++;
        project.updatedAt = now;
        const encoded = JSON.stringify(project);
        if (Buffer.byteLength(encoded) > 4 * 1024 * 1024)
          throw new FactoryError('project_too_large_archive_builds');
        const changed = this.db
          .prepare(
            'UPDATE factory_projects SET revision=?,document_json=?,updated_at=? WHERE id=? AND revision=?',
          )
          .run(
            project.revision,
            encoded,
            now,
            project.id,
            request.expectedRevision,
          );
        if (changed.changes !== 1) throw new FactoryError('revision_conflict');
        const result = {
          project: publicProjectView(project, actor),
          ...(extra && typeof extra === 'object' ? extra : {}),
        };
        this.record(actor, request, project, result);
        return result;
      })
      .immediate();
  }

  setMember(
    project: FactoryProject,
    actorKey: string,
    role: Exclude<FactoryRole, 'owner'> | null,
  ): void {
    if (actorKey === project.ownerKey)
      throw new FactoryError('owner_cannot_be_replaced');
    if (role === null) {
      this.db
        .prepare(
          'DELETE FROM factory_members WHERE project_id=? AND actor_key=?',
        )
        .run(project.id, actorKey);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO factory_members(project_id,actor_key,role) VALUES(?,?,?)
      ON CONFLICT(project_id,actor_key) DO UPDATE SET role=excluded.role`,
      )
      .run(project.id, actorKey, role);
  }

  redactHistoricalResults(projectId: string): void {
    this.db
      .prepare('UPDATE factory_requests SET result_json=? WHERE project_id=?')
      .run(
        JSON.stringify({ projectId, historicalResultRedacted: true }),
        projectId,
      );
  }
}

export function publicProjectView(
  project: FactoryProject,
  actor: FactoryActor,
): FactoryProject & { view: Record<string, unknown> } {
  const result = structuredClone(project);
  if (result.lease && result.lease.actorKey !== factoryActorKey(actor))
    result.lease.token = '[held by another actor]';
  const counts: Record<string, number> = {};
  for (const section of [
    'briefHistory',
    'decisions',
    'tasks',
    'taskHistory',
    'builds',
    'operations',
    'evidence',
    'releases',
    'assets',
  ] as const) {
    counts[section] = (result[section] ?? []).length;
    // Полные разделы читаются постранично; краткий ответ не переполняет IPC.
    (result[section] as unknown[]) = (result[section] ?? []).slice(-3);
  }
  for (const build of result.builds) build.files = build.files.slice(0, 5);
  return {
    ...result,
    view: {
      kind: 'summary',
      counts,
      complete: false,
      detailAction: 'inspect',
      fileLists: 'manifest_sample_only',
    },
  };
}
