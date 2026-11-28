import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { FactoryActor, FactoryProject } from './game-factory-contracts.js';
import type {
  FactoryLegacyBinding,
  FactoryLegacyNoticeRoute,
} from './game-factory-legacy.js';
import { factoryActorKey, GameFactoryStore } from './game-factory-store.js';
import {
  readGameFactoryConfiguration,
  validateGameFactoryDatabaseLocation,
} from './game-factory-service.js';
import type { MessageRouter, RegisteredGroup } from './types.js';

export interface FactoryLegacyNotice {
  state:
    | 'pending'
    | 'sending'
    | 'sent'
    | 'unknown'
    | 'suppressed'
    | 'unavailable';
  updatedAt: string;
  attemptId?: string;
  reason?: string;
  textSha256?: string;
  receipt?: {
    kind: 'router_ack';
    id: string;
    acknowledgedAt: string;
    textSha256: string;
  };
}
export interface FactoryLegacyNoticeDependencies {
  router: Pick<MessageRouter, 'route'>;
  groups: () => Record<string, RegisteredGroup>;
  /** Проверка текущей host identity/tenant/channel, не аргумент модели. */
  routeAllowed: (route: FactoryLegacyNoticeRoute) => boolean;
  connected: (chatJid: string) => boolean;
  deliveryTimeoutMs?: number;
}
export interface FactoryLegacyNoticeResult {
  processed: boolean;
  jobId?: string;
  state?: FactoryLegacyNotice['state'];
  reason?: string;
}
const hash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');
const routeSchema = z
  .object({
    chatJid: z.string().min(1).max(512),
    groupFolder: z.string().min(1).max(256),
    tenantId: z.string().min(1).max(256),
    identityId: z.string().min(1).max(256),
    channelChatId: z.string().min(1).max(256),
    senderId: z.string().min(1).max(256),
  })
  .strict();
type Row = {
  job_id: string;
  project_id: string;
  actor_key: string;
  binding_json: string;
  document_json: string;
  notice_json: string | null;
};

/** Служебное уведомление содержит только наблюдаемый terminal fact и название проекта. */
function terminalText(project: FactoryProject, jobId: string): string | null {
  const operation = project.operations.find(
    (o) =>
      o.kind === 'legacy' &&
      o.externalId === jobId &&
      o.tracking === 'execution',
  );
  if (
    !operation ||
    operation.evidence !== 'host_observed' ||
    !['completed', 'failed'].includes(operation.state)
  )
    return null;
  let observation: Record<string, unknown>;
  try {
    observation = JSON.parse(operation.detail || 'null');
  } catch {
    return null;
  }
  if (
    !observation ||
    observation.jobId !== jobId ||
    observation.operationState !== operation.state
  )
    return null;
  const outcome = observation.state;
  if (
    (operation.state === 'completed' && outcome !== 'review_ready') ||
    (operation.state === 'failed' &&
      !['failed', 'cancelled'].includes(String(outcome)))
  )
    return null;
  const title =
    project.title
      .replace(/[\p{Cc}\p{Cf}<>`*_\[\]]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 120) || 'Игровой проект';
  const fact =
    outcome === 'cancelled'
      ? 'Задание генератора отменено. Остановка подтверждена.'
      : outcome === 'failed'
        ? 'Генератор завершился с ошибкой. Результат не принят; состояние сохранено в проекте.'
        : observation.scopeComplete === true
          ? 'Генератор подготовил кандидат прототипа. Нужны проверка игры и ваша оценка; публикация не выполнялась.'
          : 'Генератор подготовил неполный кандидат прототипа. Задание требует доработки; публикация не выполнялась.';
  return `Завод игр · «${title}»\n\n${fact}`;
}
function authorizedRoute(
  db: Database.Database,
  row: Row,
  deps: FactoryLegacyNoticeDependencies,
): FactoryLegacyNoticeRoute | null {
  const config = readGameFactoryConfiguration();
  if (!config?.enabled || config.databasePath !== db.name) return null;
  let binding: FactoryLegacyBinding;
  try {
    binding = JSON.parse(row.binding_json);
  } catch {
    return null;
  }
  const parsed = routeSchema.safeParse(binding.route);
  if (
    !parsed.success ||
    binding.jobId !== row.job_id ||
    binding.projectId !== row.project_id
  )
    return null;
  const route = parsed.data;
  if (
    binding.actor?.identityId !== route.identityId ||
    binding.actor?.tenantId !== route.tenantId ||
    binding.actorKey !== row.actor_key ||
    factoryActorKey(route) !== row.actor_key
  )
    return null;
  const policy = config.actors.find(
    (a) => a.identityId === route.identityId && a.tenantId === route.tenantId,
  );
  if (!policy?.backends.includes('legacy')) return null;
  const actor: FactoryActor = {
    ...route,
    sourceGroup: route.groupFolder,
    currentMessageIds: [],
    runId: '',
  };
  if (
    !['owner', 'editor'].includes(
      new GameFactoryStore(db).role(actor, row.project_id) || '',
    )
  )
    return null;
  const group = deps.groups()[route.chatJid];
  if (
    !group ||
    group.folder !== route.groupFolder ||
    group.isMain !== true ||
    group.agentConfig?.inboundOnly ||
    !deps.routeAllowed(route)
  )
    return null;
  return route;
}

/** Хранится на уже существующей binding: это receipt доставки, не новая очередь заданий.
 * Один pump на host. sending после перезапуска становится unknown и не отправляется повторно. */
export function createGameFactoryLegacyNoticePump(
  deps: FactoryLegacyNoticeDependencies,
): () => Promise<FactoryLegacyNoticeResult> {
  let busy = false,
    recoveredPath: string | undefined;
  const timeoutMs = Math.max(
    10,
    Math.min(deps.deliveryTimeoutMs ?? 15000, 60000),
  );
  return async () => {
    if (busy) return { processed: false, reason: 'busy' };
    busy = true;
    let db: Database.Database | undefined;
    try {
      const config = readGameFactoryConfiguration();
      if (
        !config?.enabled ||
        !validateGameFactoryDatabaseLocation(config.databasePath)
      )
        return { processed: false, reason: 'disabled_or_uninitialized' };
      db = new Database(config.databasePath);
      db.pragma('busy_timeout = 1000');
      if (
        !db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_legacy_bindings'",
          )
          .get()
      )
        return { processed: false, reason: 'uninitialized' };
      const now = () => new Date().toISOString();
      if (recoveredPath !== config.databasePath) {
        db.prepare(
          "UPDATE factory_legacy_bindings SET notice_json=json_set(notice_json,'$.state','unknown','$.reason','interrupted_delivery','$.updatedAt',?) WHERE json_extract(notice_json,'$.state')='sending'",
        ).run(now());
        recoveredPath = config.databasePath;
      }
      const row = db
        .prepare(
          `SELECT b.job_id,b.project_id,b.actor_key,b.binding_json,b.notice_json,p.document_json FROM factory_legacy_bindings b JOIN factory_projects p ON p.id=b.project_id
        WHERE (b.notice_json IS NULL OR json_extract(b.notice_json,'$.state')='pending') AND EXISTS (
          SELECT 1 FROM json_each(p.document_json,'$.operations') o WHERE json_extract(o.value,'$.kind')='legacy' AND json_extract(o.value,'$.externalId')=b.job_id
          AND json_extract(o.value,'$.tracking')='execution' AND json_extract(o.value,'$.evidence')='host_observed' AND json_extract(o.value,'$.state') IN ('completed','failed'))
        ORDER BY COALESCE(json_extract(b.notice_json,'$.updatedAt'),b.updated_at),b.job_id LIMIT 1`,
        )
        .get() as Row | undefined;
      if (!row) return { processed: false };
      const update = (notice: FactoryLegacyNotice) =>
        db!
          .prepare(
            'UPDATE factory_legacy_bindings SET notice_json=? WHERE job_id=?',
          )
          .run(JSON.stringify(notice), row.job_id);
      const unavailable = (
        state: 'suppressed' | 'unavailable',
        reason: string,
      ): FactoryLegacyNoticeResult => {
        update({ state, reason, updatedAt: now() });
        return { processed: true, jobId: row.job_id, state, reason };
      };
      const project = JSON.parse(row.document_json) as FactoryProject;
      const text = terminalText(project, row.job_id);
      if (!text) return unavailable('unavailable', 'terminal_evidence_missing');
      if (!JSON.parse(row.binding_json).route)
        return unavailable('unavailable', 'historical_route_missing');
      let route = authorizedRoute(db, row, deps);
      if (!route) return unavailable('suppressed', 'original_route_revoked');
      if (!deps.connected(route.chatJid)) {
        update({
          state: 'pending',
          reason: 'channel_disconnected',
          updatedAt: now(),
        });
        return {
          processed: true,
          jobId: row.job_id,
          state: 'pending',
          reason: 'channel_disconnected',
        };
      }
      const attemptId = randomUUID();
      const claimed = db
        .transaction(() => {
          route = authorizedRoute(db!, row, deps);
          if (!route) return false;
          const fresh = db!
            .prepare('SELECT document_json FROM factory_projects WHERE id=?')
            .get(row.project_id) as { document_json: string } | undefined;
          if (
            !fresh ||
            terminalText(JSON.parse(fresh.document_json), row.job_id) !== text
          )
            return false;
          const notice: FactoryLegacyNotice = {
            state: 'sending',
            attemptId,
            textSha256: hash(text),
            updatedAt: now(),
          };
          return (
            db!
              .prepare(
                "UPDATE factory_legacy_bindings SET notice_json=? WHERE job_id=? AND (notice_json IS NULL OR json_extract(notice_json,'$.state')='pending')",
              )
              .run(JSON.stringify(notice), row.job_id).changes === 1
          );
        })
        .immediate();
      if (!claimed || !route)
        return {
          processed: true,
          jobId: row.job_id,
          reason: 'claim_unavailable',
        };
      const finish = (notice: FactoryLegacyNotice) =>
        db!
          .prepare(
            "UPDATE factory_legacy_bindings SET notice_json=? WHERE job_id=? AND json_extract(notice_json,'$.state')='sending' AND json_extract(notice_json,'$.attemptId')=?",
          )
          .run(JSON.stringify(notice), row.job_id, attemptId);
      // Последняя проверка перед синхронным вызовом доверенного router. Никакой
      // маршрутизации в owner/default чат при отзыве первоначального получателя.
      const latest = db
        .prepare('SELECT document_json FROM factory_projects WHERE id=?')
        .get(row.project_id) as { document_json: string } | undefined;
      if (
        !authorizedRoute(db, row, deps) ||
        !latest ||
        terminalText(JSON.parse(latest.document_json), row.job_id) !== text
      ) {
        finish({
          state: 'suppressed',
          attemptId,
          reason: 'original_route_revoked',
          updatedAt: now(),
        });
        return { processed: true, jobId: row.job_id, state: 'suppressed' };
      }
      if (!deps.connected(route.chatJid)) {
        finish({
          state: 'pending',
          reason: 'channel_disconnected',
          updatedAt: now(),
        });
        return { processed: true, jobId: row.job_id, state: 'pending' };
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const acknowledged = await Promise.race([
          deps.router.route({
            chatJid: route.chatJid,
            groupFolder: route.groupFolder,
            triggerType: 'task-result',
            text,
            meta: {
              kind: 'factory_legacy_notice',
              factoryJobId: row.job_id,
              factoryProjectId: row.project_id,
              suppressCursorAdvance: true,
            },
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('ack_timeout')),
              timeoutMs,
            );
          }),
        ]);
        if (!acknowledged) {
          finish({
            state: 'pending',
            attemptId,
            reason: 'router_not_delivered',
            updatedAt: now(),
          });
          return { processed: true, jobId: row.job_id, state: 'pending' };
        }
        const at = now();
        finish({
          state: 'sent',
          attemptId,
          updatedAt: at,
          textSha256: hash(text),
          receipt: {
            kind: 'router_ack',
            id: attemptId,
            acknowledgedAt: at,
            textSha256: hash(acknowledged),
          },
        });
        return { processed: true, jobId: row.job_id, state: 'sent' };
      } catch {
        finish({
          state: 'unknown',
          attemptId,
          reason: 'acknowledgement_unknown',
          updatedAt: now(),
        });
        return { processed: true, jobId: row.job_id, state: 'unknown' };
      } finally {
        if (timer) clearTimeout(timer);
      }
    } finally {
      db?.close();
      busy = false;
    }
  };
}
