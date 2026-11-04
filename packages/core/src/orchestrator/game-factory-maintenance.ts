import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  FactoryError,
  type FactoryActor,
  type FactoryConfiguration,
  type FactoryProject,
} from './game-factory-contracts.js';
import { factoryActorKey, GameFactoryStore } from './game-factory-store.js';
import {
  readGameFactoryConfiguration,
  validateGameFactoryDatabaseLocation,
} from './game-factory-service.js';
import {
  cancelPersistedGameFactoryLegacyJob,
  observePersistedGameFactoryLegacyJob,
  type FactoryLegacyObservation,
} from './game-factory-legacy.js';

export interface FactoryMaintenanceChange {
  projectId: string;
  jobId: string;
  operationId: string;
  /** Хост выбирает дальнейший маршрут по текущим ACL; это не chat id или разрешение отправки. */
  actorKey: string;
  state: FactoryLegacyObservation['operationState'];
  requirementsCurrent: boolean;
  cancellationRequested: boolean;
}
export interface FactoryMaintenanceResult {
  processed: boolean;
  changed: FactoryMaintenanceChange[];
  skipped?:
    | 'busy'
    | 'disabled'
    | 'uninitialized'
    | 'no_authorized_member'
    | 'revision_changed'
    | 'provider_unavailable'
    | 'authority_changed';
}
export interface FactoryMaintenanceDependencies {
  /** Только host/test injection, не IPC и не пользовательские аргументы. */
  observe?: typeof observePersistedGameFactoryLegacyJob;
  cancel?: typeof cancelPersistedGameFactoryLegacyJob;
  now?: () => string;
}
let active = false;

/** Фоновая сверка не выдаёт capability и не подделывает сообщение пользователя.
 * Здесь actor — внутренний селектор уже существующей project ACL для read/cancel.
 * Submit и любые творческие действия этот модуль не импортирует. */
function authority(
  db: Database.Database,
  config: FactoryConfiguration,
  projectId: string,
): FactoryActor | null {
  const store = new GameFactoryStore(db);
  const candidates = config.actors
    .filter((p) => p.backends.includes('legacy'))
    .map((p) => {
      const actor: FactoryActor = {
        identityId: p.identityId,
        tenantId: p.tenantId,
        chatJid: '',
        sourceGroup: '',
        senderId: '',
        currentMessageIds: [],
        runId: '',
      };
      return { actor, role: store.role(actor, projectId) };
    });
  return (
    candidates.find((c) => c.role === 'owner')?.actor ??
    candidates.find((c) => c.role === 'editor')?.actor ??
    null
  );
}
function sameRuntime(
  a: FactoryConfiguration,
  b: FactoryConfiguration,
): boolean {
  return (
    a.databasePath === b.databasePath &&
    a.legacy?.configurationPath === b.legacy?.configurationPath &&
    a.workspaceRoot === b.workspaceRoot
  );
}
function comparable(observation: FactoryLegacyObservation): string {
  const { observedAt: _time, ...value } = observation;
  return JSON.stringify(value);
}

/** Один bounded serial проход существующей execution-записи. Нет новой очереди,
 * startup submit, model/API генерации, публикации или автоматической приёмки. */
export async function runGameFactoryMaintenanceTick(
  deps: FactoryMaintenanceDependencies = {},
): Promise<FactoryMaintenanceResult> {
  if (active) return { processed: false, changed: [], skipped: 'busy' };
  active = true;
  let db: Database.Database | undefined;
  try {
    const config = readGameFactoryConfiguration();
    if (!config?.enabled || !config.legacy)
      return { processed: false, changed: [], skipped: 'disabled' };
    if (!validateGameFactoryDatabaseLocation(config.databasePath))
      return { processed: false, changed: [], skipped: 'uninitialized' };
    db = new Database(config.databasePath);
    db.pragma('busy_timeout = 1000');
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_legacy_bindings'",
        )
        .get()
    )
      return { processed: false, changed: [], skipped: 'uninitialized' };
    const row = db
      .prepare(
        `SELECT b.job_id,b.project_id,b.cancel_requested,p.revision,p.document_json FROM factory_legacy_bindings b
      JOIN factory_projects p ON p.id=b.project_id
      WHERE EXISTS (SELECT 1 FROM json_each(p.document_json,'$.operations') o
        WHERE json_extract(o.value,'$.kind')='legacy' AND json_extract(o.value,'$.externalId')=b.job_id
        AND json_extract(o.value,'$.tracking')='execution' AND json_extract(o.value,'$.state') IN ('linked','running','unknown'))
      ORDER BY b.updated_at,b.job_id LIMIT 1`,
      )
      .get() as
      | {
          job_id: string;
          project_id: string;
          cancel_requested: number;
          revision: number;
          document_json: string;
        }
      | undefined;
    if (!row) return { processed: false, changed: [] };
    const now = deps.now?.() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(now)))
      throw new FactoryError('invalid_clock');
    // Это время последней сверки ссылки, не второй scheduler. Неуспешная запись
    // не монополизирует наблюдателя и не скрывает следующие проекты.
    db.prepare(
      'UPDATE factory_legacy_bindings SET updated_at=? WHERE job_id=?',
    ).run(now, row.job_id);
    const actor = authority(db, config, row.project_id);
    if (!actor)
      return { processed: true, changed: [], skipped: 'no_authorized_member' };
    db.close();
    db = undefined;
    let observed: FactoryLegacyObservation;
    try {
      // Только ранее записанный cancel_requested разрешает внешнюю отмену.
      observed = await (
        row.cancel_requested
          ? (deps.cancel ?? cancelPersistedGameFactoryLegacyJob)
          : (deps.observe ?? observePersistedGameFactoryLegacyJob)
      )(actor, row.job_id);
    } catch {
      return { processed: true, changed: [], skipped: 'provider_unavailable' };
    }
    if (
      observed.jobId !== row.job_id ||
      !Number.isFinite(Date.parse(observed.observedAt))
    )
      return { processed: true, changed: [], skipped: 'provider_unavailable' };
    const current = readGameFactoryConfiguration();
    if (
      !current?.enabled ||
      !sameRuntime(config, current) ||
      !validateGameFactoryDatabaseLocation(current.databasePath)
    )
      return { processed: true, changed: [], skipped: 'authority_changed' };
    db = new Database(current.databasePath);
    db.pragma('busy_timeout = 1000');
    const database = db;
    return database
      .transaction((): FactoryMaintenanceResult => {
        const currentActor = authority(database, current, row.project_id);
        if (
          !currentActor ||
          factoryActorKey(currentActor) !== factoryActorKey(actor)
        )
          return { processed: true, changed: [], skipped: 'authority_changed' };
        const latest = database
          .prepare(
            'SELECT revision,document_json FROM factory_projects WHERE id=?',
          )
          .get(row.project_id) as
          | { revision: number; document_json: string }
          | undefined;
        if (!latest || latest.revision !== row.revision)
          return { processed: true, changed: [], skipped: 'revision_changed' };
        const project = JSON.parse(latest.document_json) as FactoryProject;
        const operation = project.operations.find(
          (o) =>
            o.kind === 'legacy' &&
            o.externalId === row.job_id &&
            o.tracking === 'execution',
        );
        if (
          !operation ||
          !['linked', 'running', 'unknown'].includes(operation.state)
        )
          return { processed: true, changed: [], skipped: 'revision_changed' };
        let unchanged = false;
        try {
          unchanged =
            operation.state === observed.operationState &&
            operation.evidence === 'host_observed' &&
            comparable(JSON.parse(operation.detail || 'null')) ===
              comparable(observed);
        } catch {
          /* Нет прежней host-наблюдаемой проекции. */
        }
        if (unchanged) return { processed: true, changed: [] };
        operation.state = observed.operationState;
        operation.evidence = 'host_observed';
        operation.observedAt = observed.observedAt;
        operation.detail = JSON.stringify(observed);
        project.revision++;
        project.updatedAt = now;
        const changed = database
          .prepare(
            'UPDATE factory_projects SET revision=?,document_json=?,updated_at=? WHERE id=? AND revision=?',
          )
          .run(
            project.revision,
            JSON.stringify(project),
            now,
            project.id,
            row.revision,
          );
        if (changed.changes !== 1) throw new FactoryError('revision_conflict');
        database
          .prepare(
            'INSERT INTO factory_events(project_id,revision,actor_key,action,operation_id,at) VALUES(?,?,?,?,?,?)',
          )
          .run(
            project.id,
            project.revision,
            factoryActorKey(actor),
            'legacy_maintenance',
            `maintenance:${randomUUID()}`,
            now,
          );
        return {
          processed: true,
          changed: [
            {
              projectId: project.id,
              jobId: row.job_id,
              operationId: operation.id,
              actorKey: factoryActorKey(actor),
              state: observed.operationState,
              requirementsCurrent: observed.requirementsCurrent,
              cancellationRequested: observed.cancellationRequested,
            },
          ],
        };
      })
      .immediate();
  } finally {
    db?.close();
    active = false;
  }
}
