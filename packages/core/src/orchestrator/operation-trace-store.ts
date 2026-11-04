import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type Database from 'better-sqlite3';
import {
  isOperationTraceOutcome,
  isOperationTraceStage,
  NOOP_OPERATION_TRACE_SPAN,
  sanitizeOperationTraceDetails,
  type OperationTraceDetails,
  type OperationTraceObserver,
  type OperationTraceOutcome,
  type OperationTraceStage,
} from '@skoobi/shared/operation-trace';

export interface OperationTraceScope {
  tenantId: string;
  chatId: string;
}
export type OperationTraceChannel =
  | 'telegram'
  | 'whatsapp'
  | 'webhook'
  | 'other';
export interface OperationTraceOptions {
  now?: () => number;
  /** No error object is exposed: errors can contain SQL, paths or identifiers. */
  onFailure?: () => void;
}
const CHANNELS: readonly string[] = [
  'telegram',
  'whatsapp',
  'webhook',
  'other',
];
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RETENTION_MS = 30 * 86400_000;
const MAX_OPERATIONS = 10_000;
const MAX_ATTEMPTS = 20_000;
const MAX_SPANS = 100_000;
const MAX_INPUTS = 512;
const MAX_CONTEXT_SPANS = 512;
const MAX_OPERATION_ATTEMPTS = 128;
const PROCESS_OWNER_ID = randomUUID();
// This database belongs to one local instance, not shared hosts with equal names.
const HOST_KEY = createHash('sha256').update(hostname()).digest('hex');

function safe<T>(options: OperationTraceOptions, body: () => T): T | undefined {
  try {
    return body();
  } catch {
    try {
      options.onFailure?.();
    } catch {
      /* diagnostics remain optional */
    }
    return undefined;
  }
}
function clock(options: OperationTraceOptions): number {
  const now = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error('Invalid trace clock');
  return now;
}
function boundedIdentity(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512)
    throw new Error('Invalid trace identity');
  return value;
}
function hash(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
function scopeKey(scope: OperationTraceScope): string {
  return hash([boundedIdentity(scope.tenantId), boundedIdentity(scope.chatId)]);
}
function inputIds(ids: readonly string[]): string[] {
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MAX_INPUTS ||
    ids.some((id) => typeof id !== 'string' || !UUID.test(id))
  )
    throw new Error('Invalid trace inputs');
  return [...new Set(ids)];
}
function count(db: Database.Database, table: string): number {
  // Table names are internal constants, never caller input.
  return (
    db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}

/** Additive and safe on an old database. Does not change the legacy event store. */
export function ensureOperationTraceSchema(
  db: Database.Database,
  options: OperationTraceOptions = {},
): boolean {
  return (
    safe(options, () => {
      db.exec(`
      CREATE TABLE IF NOT EXISTS operation_trace_operations (
        operation_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, input_key TEXT NOT NULL,
        channel TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(scope_key, input_key)
      );
      CREATE INDEX IF NOT EXISTS operation_trace_operations_age ON operation_trace_operations(created_at);
      CREATE TABLE IF NOT EXISTS operation_trace_attempts (
        attempt_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operation_trace_attempt_inputs (
        attempt_id TEXT NOT NULL, operation_id TEXT NOT NULL, scope_key TEXT NOT NULL,
        linked_at INTEGER NOT NULL,
        PRIMARY KEY(attempt_id, operation_id)
      );
      CREATE INDEX IF NOT EXISTS operation_trace_inputs_operation ON operation_trace_attempt_inputs(scope_key, operation_id);
      CREATE TABLE IF NOT EXISTS operation_trace_owners (
        owner_id TEXT PRIMARY KEY, host_key TEXT NOT NULL, pid INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operation_trace_spans (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, span_id TEXT NOT NULL UNIQUE,
        scope_key TEXT NOT NULL, operation_id TEXT, attempt_id TEXT,
        owner_id TEXT NOT NULL,
        stage TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL,
        finished_at INTEGER, details_json TEXT NOT NULL,
        CHECK ((operation_id IS NULL) != (attempt_id IS NULL))
      );
      CREATE INDEX IF NOT EXISTS operation_trace_spans_operation ON operation_trace_spans(scope_key, operation_id, sequence);
      CREATE INDEX IF NOT EXISTS operation_trace_spans_attempt ON operation_trace_spans(scope_key, attempt_id, sequence);
      CREATE TABLE IF NOT EXISTS operation_trace_ipc_bindings (
        token_hash TEXT PRIMARY KEY, source_hash TEXT NOT NULL, scope_key TEXT NOT NULL,
        attempt_id TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
      return true;
    }) ?? false
  );
}

/** Host-created, bounded metadata correlation survives an orchestrator restart.
 * Possession never authorizes delivery; caller must apply the normal IPC policy.
 */
export function createOperationTraceIpcBinding(
  db: Database.Database,
  scope: OperationTraceScope,
  sourceGroup: string,
  attemptId: string,
  options: OperationTraceOptions = {},
): string | undefined {
  return safe(options, () =>
    db.transaction(() => {
      const key = scopeKey(scope),
        source = hash(['ipc-source', boundedIdentity(sourceGroup)]),
        at = clock(options);
      if (
        !UUID.test(attemptId) ||
        !db
          .prepare(
            'SELECT 1 FROM operation_trace_attempts WHERE attempt_id=? AND scope_key=?',
          )
          .get(attemptId, key)
      )
        return undefined;
      db.prepare(
        'DELETE FROM operation_trace_ipc_bindings WHERE expires_at<=? OR attempt_id NOT IN (SELECT attempt_id FROM operation_trace_attempts)',
      ).run(at);
      if (count(db, 'operation_trace_ipc_bindings') >= 256) return undefined;
      const token = randomBytes(32).toString('base64url');
      db.prepare(
        'INSERT INTO operation_trace_ipc_bindings VALUES(?,?,?,?,?)',
      ).run(
        hash(['ipc-token', token]),
        source,
        key,
        attemptId,
        at + 2 * 60 * 60_000,
      );
      return token;
    })(),
  );
}

export function releaseOperationTraceIpcBinding(
  db: Database.Database,
  token: string,
  options: OperationTraceOptions = {},
): void {
  safe(options, () => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    db.prepare(
      'UPDATE operation_trace_ipc_bindings SET expires_at=MIN(expires_at,?) WHERE token_hash=?',
    ).run(clock(options) + 5 * 60_000, hash(['ipc-token', token]));
  });
}

export function findOperationTraceForIpc(
  db: Database.Database,
  sourceGroup: string,
  token: unknown,
  options: OperationTraceOptions = {},
): OperationTraceObserver | undefined {
  return safe(options, () => {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      return undefined;
    const row = db
      .prepare(
        `SELECT b.scope_key,b.attempt_id FROM operation_trace_ipc_bindings b
      JOIN operation_trace_attempts a ON a.attempt_id=b.attempt_id AND a.scope_key=b.scope_key
      WHERE b.token_hash=? AND b.source_hash=? AND b.expires_at>?`,
      )
      .get(
        hash(['ipc-token', token]),
        hash(['ipc-source', boundedIdentity(sourceGroup)]),
        clock(options),
      ) as { scope_key: string; attempt_id: string } | undefined;
    if (!row) return undefined;
    const inputs = db
      .prepare(
        'SELECT operation_id FROM operation_trace_attempt_inputs WHERE scope_key=? AND attempt_id=? LIMIT ?',
      )
      .all(row.scope_key, row.attempt_id, MAX_INPUTS) as {
      operation_id: string;
    }[];
    const ids = inputIds(inputs.map((input) => input.operation_id));
    requireOperations(db, row.scope_key, ids);
    return observer(db, row.scope_key, ids, row.attempt_id, options);
  });
}

/** Scope is authenticated by the caller. IDs are correlation, never authority. */
export function findOperationTraceForMessage(
  db: Database.Database,
  scope: OperationTraceScope,
  messageId: string,
  channel: OperationTraceChannel,
  options: OperationTraceOptions = {},
): OperationTraceObserver | undefined {
  return safe(options, () => {
    const key = scopeKey(scope);
    if (!CHANNELS.includes(channel)) return undefined;
    const inputKey = hash([channel, boundedIdentity(messageId)]);
    const row = db
      .prepare(
        'SELECT operation_id FROM operation_trace_operations WHERE scope_key = ? AND input_key = ?',
      )
      .get(key, inputKey) as { operation_id: string } | undefined;
    return row
      ? observer(db, key, [row.operation_id], undefined, options)
      : undefined;
  });
}

export function getOrCreateOperationTrace(
  db: Database.Database,
  scope: OperationTraceScope,
  messageId: string,
  channel: OperationTraceChannel,
  options: OperationTraceOptions = {},
): OperationTraceObserver | undefined {
  return safe(options, () => {
    const key = scopeKey(scope);
    if (!CHANNELS.includes(channel)) throw new Error('Invalid trace channel');
    const inputKey = hash([channel, boundedIdentity(messageId)]);
    const operationId = db.transaction(() => {
      const old = db
        .prepare(
          'SELECT operation_id FROM operation_trace_operations WHERE scope_key = ? AND input_key = ?',
        )
        .get(key, inputKey) as { operation_id: string } | undefined;
      if (old) return old.operation_id;
      if (count(db, 'operation_trace_operations') >= MAX_OPERATIONS)
        return undefined;
      const id = randomUUID();
      db.prepare(
        'INSERT INTO operation_trace_operations VALUES (?, ?, ?, ?, ?)',
      ).run(id, key, inputKey, channel, clock(options));
      return id;
    })();
    return operationId
      ? observer(db, key, [operationId], undefined, options)
      : undefined;
  });
}

function requireOperations(
  db: Database.Database,
  key: string,
  ids: string[],
): void {
  const get = db.prepare(
    'SELECT 1 FROM operation_trace_operations WHERE scope_key = ? AND operation_id = ?',
  );
  for (const id of ids)
    if (!get.get(key, id)) throw new Error('Trace scope mismatch');
}

export function startOperationTraceAttempt(
  db: Database.Database,
  scope: OperationTraceScope,
  operationIds: readonly string[],
  options: OperationTraceOptions = {},
): OperationTraceObserver | undefined {
  return safe(options, () =>
    db.transaction(() => {
      const key = scopeKey(scope),
        ids = inputIds(operationIds);
      requireOperations(db, key, ids);
      if (count(db, 'operation_trace_attempts') >= MAX_ATTEMPTS)
        return undefined;
      for (const id of ids) {
        const n = (
          db
            .prepare(
              'SELECT count(*) AS n FROM operation_trace_attempt_inputs WHERE scope_key = ? AND operation_id = ?',
            )
            .get(key, id) as { n: number }
        ).n;
        if (n >= MAX_OPERATION_ATTEMPTS) return undefined;
      }
      const attemptId = randomUUID();
      db.prepare('INSERT INTO operation_trace_attempts VALUES (?, ?, ?)').run(
        attemptId,
        key,
        clock(options),
      );
      const insert = db.prepare(
        'INSERT INTO operation_trace_attempt_inputs VALUES (?, ?, ?, ?)',
      );
      for (const id of ids) insert.run(attemptId, id, key, clock(options));
      return observer(db, key, ids, attemptId, options);
    })(),
  );
}

/** Late corrections keep their own inbound ID and join the already-running attempt. */
export function linkOperationTraceInputs(
  db: Database.Database,
  scope: OperationTraceScope,
  attemptId: string,
  operationIds: readonly string[],
  options: OperationTraceOptions = {},
): boolean {
  return (
    safe(options, () =>
      db.transaction(() => {
        const key = scopeKey(scope),
          ids = inputIds(operationIds);
        if (
          !UUID.test(attemptId) ||
          !db
            .prepare(
              'SELECT 1 FROM operation_trace_attempts WHERE scope_key = ? AND attempt_id = ?',
            )
            .get(key, attemptId)
        )
          return false;
        requireOperations(db, key, ids);
        const existing = db
          .prepare(
            'SELECT operation_id FROM operation_trace_attempt_inputs WHERE scope_key = ? AND attempt_id = ?',
          )
          .all(key, attemptId) as { operation_id: string }[];
        if (
          new Set([...existing.map((row) => row.operation_id), ...ids]).size >
          MAX_INPUTS
        )
          return false;
        for (const id of ids) {
          if (existing.some((row) => row.operation_id === id)) continue;
          const n = (
            db
              .prepare(
                'SELECT count(*) AS n FROM operation_trace_attempt_inputs WHERE scope_key = ? AND operation_id = ?',
              )
              .get(key, id) as { n: number }
          ).n;
          if (n >= MAX_OPERATION_ATTEMPTS) return false;
        }
        const insert = db.prepare(
          'INSERT OR IGNORE INTO operation_trace_attempt_inputs VALUES (?, ?, ?, ?)',
        );
        for (const id of ids) insert.run(attemptId, id, key, clock(options));
        return true;
      })(),
    ) ?? false
  );
}

/** Idempotent across polls; the waiting observation itself is persisted. */
export function queueOperationTrace(
  db: Database.Database,
  scope: OperationTraceScope,
  operationId: string,
  options: OperationTraceOptions = {},
): boolean {
  return (
    safe(options, () =>
      db.transaction(() => {
        const key = scopeKey(scope);
        requireOperations(db, key, inputIds([operationId]));
        const pending = db.prepare(
          "SELECT 1 FROM operation_trace_spans WHERE scope_key = ? AND operation_id = ? AND stage = 'queue' AND status = 'waiting'",
        );
        if (pending.get(key, operationId)) return true;
        observer(db, key, [operationId], undefined, options).startStage(
          'queue',
        );
        return !!pending.get(key, operationId);
      })(),
    ) ?? false
  );
}

/** Does not mutate earlier attempts, outcomes, or any other scope's queue. */
export function settleOperationTraceQueue(
  db: Database.Database,
  scope: OperationTraceScope,
  operationId: string,
  outcome: OperationTraceOutcome,
  options: OperationTraceOptions = {},
): boolean {
  return (
    safe(options, () => {
      const key = scopeKey(scope);
      if (!UUID.test(operationId) || !isOperationTraceOutcome(outcome))
        return false;
      return (
        db
          .prepare(
            "UPDATE operation_trace_spans SET status = ?, finished_at = MAX(started_at, ?) WHERE scope_key = ? AND operation_id = ? AND stage = 'queue' AND status = 'waiting'",
          )
          .run(outcome, clock(options), key, operationId).changes > 0
      );
    }) ?? false
  );
}

function observer(
  db: Database.Database,
  key: string,
  ids: string[],
  attemptId: string | undefined,
  options: OperationTraceOptions,
): OperationTraceObserver {
  return Object.freeze({
    get operationIds() {
      const linked = attemptId
        ? safe(options, () =>
            (
              db
                .prepare(
                  'SELECT operation_id FROM operation_trace_attempt_inputs WHERE scope_key = ? AND attempt_id = ? ORDER BY linked_at, operation_id LIMIT ?',
                )
                .all(key, attemptId, MAX_INPUTS) as { operation_id: string }[]
            )
              .map((row) => row.operation_id)
              .filter((id) => UUID.test(id)),
          )
        : undefined;
      return Object.freeze(linked ?? [...ids]);
    },
    ...(attemptId ? { attemptId } : {}),
    startStage(stage: OperationTraceStage, details?: OperationTraceDetails) {
      return (
        safe(options, () => {
          if (!isOperationTraceStage(stage)) return NOOP_OPERATION_TRACE_SPAN;
          const spanId = randomUUID();
          const initial = sanitizeOperationTraceDetails(details);
          const inserted = db.transaction(() => {
            const table = attemptId
              ? 'operation_trace_attempts'
              : 'operation_trace_operations';
            const column = attemptId ? 'attempt_id' : 'operation_id';
            const id = attemptId ?? ids[0];
            if (
              !db
                .prepare(
                  `SELECT 1 FROM ${table} WHERE scope_key = ? AND ${column} = ?`,
                )
                .get(key, id)
            )
              return false;
            if (count(db, 'operation_trace_spans') >= MAX_SPANS) return false;
            const n = (
              db
                .prepare(
                  `SELECT count(*) AS n FROM operation_trace_spans WHERE scope_key = ? AND ${column} = ?`,
                )
                .get(key, id) as { n: number }
            ).n;
            if (n >= MAX_CONTEXT_SPANS) return false;
            const now = clock(options);
            db.prepare(
              'INSERT OR IGNORE INTO operation_trace_owners VALUES (?, ?, ?, ?)',
            ).run(PROCESS_OWNER_ID, HOST_KEY, process.pid, now);
            db.prepare(
              `INSERT INTO operation_trace_spans (span_id, scope_key, operation_id, attempt_id, owner_id, stage, status, started_at, details_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              spanId,
              key,
              attemptId ? null : ids[0],
              attemptId ?? null,
              PROCESS_OWNER_ID,
              stage,
              stage === 'queue' || stage === 'stt_queue'
                ? 'waiting'
                : 'running',
              now,
              JSON.stringify(initial),
            );
            return true;
          })();
          if (!inserted) return NOOP_OPERATION_TRACE_SPAN;
          return {
            finish(
              outcome: OperationTraceOutcome,
              finalDetails?: OperationTraceDetails,
            ) {
              safe(options, () => {
                if (!isOperationTraceOutcome(outcome)) return;
                const merged = {
                  ...initial,
                  ...sanitizeOperationTraceDetails(finalDetails),
                };
                db.prepare(
                  `UPDATE operation_trace_spans SET status = ?, finished_at = MAX(started_at, ?), details_json = ?
                WHERE scope_key = ? AND span_id = ? AND status IN ('running','waiting')`,
                ).run(
                  outcome,
                  clock(options),
                  JSON.stringify(merged),
                  key,
                  spanId,
                );
              });
            },
          };
        }) ?? NOOP_OPERATION_TRACE_SPAN
      );
    },
  });
}

export interface OperationTraceTimeline {
  operationId: string;
  channel: OperationTraceChannel;
  createdAt: number;
  /** linkedAt distinguishes a late correction from inputs present at attempt start. */
  attempts: Array<{
    attemptId: string;
    createdAt: number;
    linkedAt: number;
    inputCount: number;
  }>;
  spans: Array<{
    sequence: number;
    spanId: string;
    attemptId?: string;
    stage: OperationTraceStage;
    status: 'running' | 'waiting' | OperationTraceOutcome;
    startedAt: number;
    finishedAt?: number;
    details: OperationTraceDetails;
  }>;
  /** Pass as afterSequence; absence means no further currently stored observations. */
  nextSequence?: number;
}

/** A strict metadata export. Never reads legacy payloads or raw chat records. */
export function queryOperationTimeline(
  db: Database.Database,
  scope: OperationTraceScope,
  operationId: string,
  options: OperationTraceOptions & {
    afterSequence?: number;
    limit?: number;
  } = {},
): OperationTraceTimeline | undefined {
  return safe(options, () => {
    const key = scopeKey(scope),
      after = options.afterSequence ?? 0,
      limit = options.limit ?? 100;
    if (
      !UUID.test(operationId) ||
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      return undefined;
    const op = db
      .prepare(
        'SELECT channel, created_at FROM operation_trace_operations WHERE scope_key = ? AND operation_id = ?',
      )
      .get(key, operationId) as
      | { channel: OperationTraceChannel; created_at: number }
      | undefined;
    if (!op || !CHANNELS.includes(op.channel)) return undefined;
    const rows = db
      .prepare(
        `SELECT sequence, span_id, attempt_id, stage, status, started_at, finished_at, details_json
      FROM operation_trace_spans s WHERE s.scope_key = ? AND s.sequence > ? AND
      (s.operation_id = ? OR s.attempt_id IN (SELECT attempt_id FROM operation_trace_attempt_inputs WHERE scope_key = ? AND operation_id = ?))
      ORDER BY s.sequence LIMIT ?`,
      )
      .all(key, after, operationId, key, operationId, limit + 1) as Array<{
      sequence: number;
      span_id: string;
      attempt_id: string | null;
      stage: OperationTraceStage;
      status: 'running' | 'waiting' | OperationTraceOutcome;
      started_at: number;
      finished_at: number | null;
      details_json: string;
    }>;
    const page = rows.slice(0, limit);
    const attempts = db
      .prepare(
        `SELECT a.attempt_id, a.created_at, i.linked_at,
      (SELECT count(*) FROM operation_trace_attempt_inputs j WHERE j.scope_key = a.scope_key AND j.attempt_id = a.attempt_id) AS input_count
      FROM operation_trace_attempts a JOIN operation_trace_attempt_inputs i ON i.scope_key = a.scope_key AND i.attempt_id = a.attempt_id
      WHERE a.scope_key = ? AND i.operation_id = ? ORDER BY a.created_at, a.attempt_id LIMIT ?`,
      )
      .all(key, operationId, MAX_OPERATION_ATTEMPTS) as Array<{
      attempt_id: string;
      created_at: number;
      linked_at: number;
      input_count: number;
    }>;
    return {
      operationId,
      channel: op.channel,
      createdAt: op.created_at,
      attempts: attempts
        .filter((row) => UUID.test(row.attempt_id))
        .map((row) => ({
          attemptId: row.attempt_id,
          createdAt: row.created_at,
          linkedAt: row.linked_at,
          inputCount: row.input_count,
        })),
      spans: page
        .filter(
          (row) =>
            UUID.test(row.span_id) &&
            (!row.attempt_id || UUID.test(row.attempt_id)) &&
            isOperationTraceStage(row.stage) &&
            (row.status === 'running' ||
              row.status === 'waiting' ||
              isOperationTraceOutcome(row.status)),
        )
        .map((row) => ({
          sequence: row.sequence,
          spanId: row.span_id,
          ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
          stage: row.stage,
          status: row.status,
          startedAt: row.started_at,
          ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
          details: sanitizeOperationTraceDetails(JSON.parse(row.details_json)),
        })),
      ...(rows.length > limit
        ? { nextSequence: page[page.length - 1].sequence }
        : {}),
    };
  });
}

/** Local-instance database only: hostname is a boundary, not a distributed lease.
 * Only ESRCH proves the prior local owner dead. EPERM, a reused/live PID or another
 * host remain unresolved. No global lock is assumed and no action is replayed.
 */
export function recoverDeadOwnerOperationTraces(
  db: Database.Database,
  options: OperationTraceOptions = {},
): number | undefined {
  return safe(options, () => {
    const owners = db
      .prepare(
        `SELECT owner_id, pid FROM operation_trace_owners WHERE host_key = ? AND owner_id != ?
      AND owner_id IN (SELECT owner_id FROM operation_trace_spans WHERE status IN ('running','waiting')) LIMIT 1000`,
      )
      .all(HOST_KEY, PROCESS_OWNER_ID) as Array<{
      owner_id: string;
      pid: number;
    }>;
    let changed = 0;
    for (const owner of owners) {
      if (
        !Number.isSafeInteger(owner.pid) ||
        owner.pid < 1 ||
        owner.pid > 2 ** 31 - 1
      )
        continue;
      try {
        process.kill(owner.pid, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
      }
      changed += db
        .prepare(
          `UPDATE operation_trace_spans SET
        status = CASE WHEN stage IN ('agent','model','model_turn','tool','delivery') THEN 'unknown' ELSE 'interrupted' END,
        finished_at = MAX(started_at, ?), details_json = '{"reason":"restart"}'
        WHERE owner_id = ? AND status IN ('running','waiting')`,
        )
        .run(clock(options), owner.owner_id).changes;
    }
    return changed;
  });
}

/** Retention is explicit host maintenance, not a user action or replay signal.
 * Hard capacity limits above fail open by dropping further diagnostics until prune.
 */
export function pruneOperationTraces(
  db: Database.Database,
  options: OperationTraceOptions & { retentionMs?: number } = {},
): { operations: number; attempts: number; spans: number } | undefined {
  return safe(options, () =>
    db.transaction(() => {
      const retention = options.retentionMs ?? RETENTION_MS;
      if (
        !Number.isSafeInteger(retention) ||
        retention < 1 ||
        retention > RETENTION_MS
      )
        throw new Error('Invalid trace retention');
      const cutoff = clock(options) - retention;
      const operations = db
        .prepare('DELETE FROM operation_trace_operations WHERE created_at < ?')
        .run(cutoff).changes;
      db.prepare(
        'DELETE FROM operation_trace_attempt_inputs WHERE operation_id NOT IN (SELECT operation_id FROM operation_trace_operations)',
      ).run();
      const attempts = db
        .prepare(
          'DELETE FROM operation_trace_attempts WHERE created_at < ? OR attempt_id NOT IN (SELECT attempt_id FROM operation_trace_attempt_inputs)',
        )
        .run(cutoff).changes;
      db.prepare(
        'DELETE FROM operation_trace_attempt_inputs WHERE attempt_id NOT IN (SELECT attempt_id FROM operation_trace_attempts)',
      ).run();
      const spans = db
        .prepare(
          `DELETE FROM operation_trace_spans WHERE started_at < ?
      OR (operation_id IS NOT NULL AND operation_id NOT IN (SELECT operation_id FROM operation_trace_operations))
      OR (attempt_id IS NOT NULL AND attempt_id NOT IN (SELECT attempt_id FROM operation_trace_attempts))`,
        )
        .run(cutoff).changes;
      db.prepare(
        'DELETE FROM operation_trace_owners WHERE owner_id NOT IN (SELECT owner_id FROM operation_trace_spans)',
      ).run();
      db.prepare(
        'DELETE FROM operation_trace_ipc_bindings WHERE expires_at<=? OR attempt_id NOT IN (SELECT attempt_id FROM operation_trace_attempts)',
      ).run(clock(options));
      return { operations, attempts, spans };
    })(),
  );
}
