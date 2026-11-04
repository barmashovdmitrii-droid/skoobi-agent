import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  FactoryActor,
  FactoryConfiguration,
} from './game-factory-contracts.js';
import { factoryActorKey } from './game-factory-store.js';

export type FactoryHostRunState = 'active' | 'finished' | 'unknown';
/** Получает только host actor после проверки provenance. Возвращённое замыкание
 * вызывается исключительно из finally конкретного запуска, а не по TTL. */
export type FactoryHostRunLifecycle = (
  actor: FactoryActor,
  diagnosticAttemptId?: string,
) => (() => void) | undefined;

const HOST_INSTANCE_ID = randomUUID();
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const hasTable = (db: Database.Database) =>
  Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_host_runs'",
      )
      .get(),
  );

type Binding = {
  runId: string;
  actorKey: string;
  hostInstanceId: string;
  diagnosticAttemptId: string | null;
  startedAt: string;
};

/** Схему создаёт только ensureGameFactorySchema на разрешённой мутации.
 * Этот модуль не создаёт БД/таблицы и не интерпретирует PID/trace как завершение. */
export function createFactoryHostRunLifecycle(options: {
  readConfiguration: () => Pick<
    FactoryConfiguration,
    'enabled' | 'databasePath' | 'actors'
  > | null;
  validateDatabaseLocation: (filename: string) => boolean;
  onPersistenceError?: (phase: 'started' | 'finished') => void;
}): FactoryHostRunLifecycle {
  return (actor, diagnosticAttemptId) => {
    if (!UUID.test(actor.runId)) return undefined;
    const scope = { identityId: actor.identityId, tenantId: actor.tenantId };
    const allowed = (config: ReturnType<typeof options.readConfiguration>) =>
      config?.enabled === true &&
      config.actors.some(
        (entry) =>
          entry.identityId === scope.identityId &&
          entry.tenantId === scope.tenantId,
      );
    let config: ReturnType<typeof options.readConfiguration>;
    try {
      config = options.readConfiguration();
    } catch {
      options.onPersistenceError?.('started');
      return undefined;
    }
    if (!allowed(config) || !config) return undefined;
    const databasePath = config.databasePath;
    const binding: Binding = {
      runId: actor.runId,
      actorKey: factoryActorKey(scope),
      hostInstanceId: HOST_INSTANCE_ID,
      diagnosticAttemptId:
        diagnosticAttemptId && UUID.test(diagnosticAttemptId)
          ? diagnosticAttemptId
          : null,
      startedAt: new Date().toISOString(),
    };
    const persist = (phase: 'started' | 'finished') => {
      let db: Database.Database | undefined;
      try {
        const current = options.readConfiguration();
        // Отзыв actor запрещает новую работу, но не стирает факт завершения
        // уже запущенного host invocation. Закрываем только прежнюю БД/связку.
        if (
          (phase === 'started' && !allowed(current)) ||
          current?.databasePath !== databasePath ||
          !options.validateDatabaseLocation(databasePath)
        )
          return;
        db = new Database(databasePath, { fileMustExist: true });
        db.pragma('busy_timeout = 250');
        if (!hasTable(db)) return;
        const finishedAt =
          phase === 'finished' ? new Date().toISOString() : null;
        const result = db
          .prepare(
            `INSERT INTO factory_host_runs
          (invocation_run_id,actor_key,host_instance_id,diagnostic_attempt_id,started_at,finished_at,completion_source)
          VALUES (@runId,@actorKey,@hostInstanceId,@diagnosticAttemptId,@startedAt,@finishedAt,@completionSource)
          ON CONFLICT(invocation_run_id) DO UPDATE SET
            finished_at=COALESCE(factory_host_runs.finished_at,excluded.finished_at),
            completion_source=COALESCE(factory_host_runs.completion_source,excluded.completion_source)
          WHERE factory_host_runs.actor_key=excluded.actor_key
            AND factory_host_runs.host_instance_id=excluded.host_instance_id
            AND factory_host_runs.started_at=excluded.started_at
            AND factory_host_runs.diagnostic_attempt_id IS excluded.diagnostic_attempt_id`,
          )
          .run({
            ...binding,
            finishedAt,
            completionSource: finishedAt ? 'host_finally' : null,
          });
        if (result.changes !== 1) throw new Error('host_run_binding_conflict');
      } catch {
        // Путь, actor и secret не попадают в журнал. Ошибка не подменяется
        // durable finished: после restart наблюдатель вернёт unknown.
        options.onPersistenceError?.(phase);
      } finally {
        db?.close();
      }
    };
    persist('started');
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      // БД могла появиться при первой create уже после mint capability.
      persist('finished');
    };
  };
}

export function inspectFactoryHostRun(
  db: Database.Database,
  runId: string,
  liveState: FactoryHostRunState = 'unknown',
): { state: FactoryHostRunState; reason: string } {
  if (liveState === 'active' || liveState === 'finished')
    return { state: liveState, reason: 'current_host_lifecycle' };
  if (!UUID.test(runId) || !hasTable(db))
    return { state: 'unknown', reason: 'host_completion_not_recorded' };
  const row = db
    .prepare(
      `SELECT started_at,finished_at,completion_source
    FROM factory_host_runs WHERE invocation_run_id=?`,
    )
    .get(runId) as
    | {
        started_at: string;
        finished_at: string | null;
        completion_source: string | null;
      }
    | undefined;
  if (
    row?.completion_source === 'host_finally' &&
    row.finished_at &&
    Number.isFinite(Date.parse(row.started_at)) &&
    Number.isFinite(Date.parse(row.finished_at))
  )
    return { state: 'finished', reason: 'durable_host_finally' };
  return {
    state: 'unknown',
    reason: row
      ? 'host_completion_missing_after_restart'
      : 'host_completion_not_recorded',
  };
}

export function observeFactoryHostRun(
  db: Database.Database,
  runId: string,
  liveState: FactoryHostRunState = 'unknown',
): FactoryHostRunState {
  return inspectFactoryHostRun(db, runId, liveState).state;
}
