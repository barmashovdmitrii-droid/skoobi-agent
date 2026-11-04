import { createHash } from 'crypto';
import type Database from 'better-sqlite3';

/** All scope/source fields come from the authenticated host, never tool arguments. */
export interface MemoryStateScope {
  chatJid: string;
  identityId: string;
  tenantId: string;
}
export interface MemoryStateSource {
  kind: 'direct_user' | 'assistant_report';
  at: string;
  messageId?: string;
  quote?: string;
  explicitRemember?: boolean;
  explicitActivate?: boolean;
  explicitForget?: boolean;
  /** Host-only: this source is the current direct input, not a historical quote. */
  currentDirectInput?: boolean;
}
export interface StoredMemoryStateSource {
  kind: MemoryStateSource['kind'];
  at: string;
  messageId?: string;
  quote?: string;
  sourceReferenceTrust: 'verified_quote' | 'agent_reported';
  contentTrust: 'agent_interpreted';
}
export type MemoryFactType =
  | 'fact'
  | 'decision'
  | 'preference'
  | 'permission_note';
export interface MemoryProjectCard {
  title: string;
  goal: string;
  status: 'active' | 'waiting' | 'completed' | 'cancelled';
  pending: string[];
  completed: string[];
  waiting: string | null;
  /** These states are claims, never host delivery receipts or proof. */
  artifacts: Array<{
    path: string;
    state: 'created' | 'verified' | 'delivered';
    note?: string;
  }>;
}
type MutationBase = { operationId: string; expectedRevision: number };
export type MemoryStateOperation = MutationBase &
  (
    | { kind: 'project_upsert'; projectKey: string; card: MemoryProjectCard }
    | { kind: 'project_activate'; projectKey: string }
    | {
        kind: 'fact_upsert';
        projectKey: string | null;
        key: string;
        value: string;
        factType?: MemoryFactType;
        validUntil?: string | null;
      }
    | {
        kind: 'forget';
        target: 'fact' | 'project';
        projectKey: string | null;
        key?: string;
      }
  );
interface RecordBase {
  projectKey: string | null;
  key: string;
  revision: number;
  updatedAt: string;
  source: StoredMemoryStateSource;
  evidence: 'reported_not_verified';
}
export type MemoryStateRecord =
  | (RecordBase & {
      kind: 'project';
      projectKey: string;
      card: MemoryProjectCard;
    })
  | (RecordBase & {
      kind: 'fact';
      value: string;
      factType: MemoryFactType;
      validUntil: string | null;
    });
export interface MemoryStateTombstone {
  kind: 'fact' | 'project';
  projectKey: string | null;
  key: string;
  revision: number;
  forgottenAt: string;
  sourceAt: string;
}
export interface MemoryStateListing {
  projects: Array<Extract<MemoryStateRecord, { kind: 'project' }>>;
  facts: Array<Extract<MemoryStateRecord, { kind: 'fact' }>>;
  tombstones: MemoryStateTombstone[];
  expired: Array<{
    projectKey: string | null;
    key: string;
    revision: number;
    validUntil: string;
  }>;
  hasTombstones: boolean;
  focusedProjectKey: string | null;
}
export class MemoryStateError extends Error {
  constructor(
    public code: string,
    public currentRevision?: number,
  ) {
    super(
      `Memory state: ${code}${currentRevision === undefined ? '' : ` (revision ${currentRevision})`}`,
    );
    this.name = 'MemoryStateError';
  }
}
type Row = {
  scope_key: string;
  record_key: string;
  kind: 'project' | 'fact';
  project_key: string;
  item_key: string;
  revision: number;
  body_json: string | null;
  source_json: string | null;
  updated_at: string;
  direct_at: string | null;
  direct_message_id: string | null;
  forgotten: number;
};
const LIMIT_RECORDS = 2000;
const MAX_VERSIONS = 50;
const KEY = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,79}$/u;
const SECRET =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|парол[ья])\s*[:=]\s*\S+|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|-----BEGIN\s+(?:OPENSSH|RSA|EC|PRIVATE)\s+KEY-----/iu;
const fail = (code: string, revision?: number): never => {
  throw new MemoryStateError(code, revision);
};
function text(value: unknown, max: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim())
  )
    return fail('invalid_input');
  return value.trim();
}
function key(value: unknown): string {
  const result = text(value, 80).normalize('NFKC').toLowerCase();
  return KEY.test(result) ? result : fail('invalid_key');
}
function date(value: unknown): string {
  const raw = text(value, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw) ||
    !Number.isFinite(Date.parse(raw))
  )
    return fail('invalid_date');
  return new Date(raw).toISOString();
}
function scopeKey(scope: MemoryStateScope): string {
  if (!scope || typeof scope !== 'object') return fail('invalid_scope');
  return JSON.stringify([
    text(scope.chatJid, 400),
    text(scope.identityId, 400),
    text(scope.tenantId, 400),
  ]);
}
function sourceView(
  source: MemoryStateSource,
  now: string,
): StoredMemoryStateSource {
  if (!source || typeof source !== 'object') return fail('invalid_source');
  if (source.kind !== 'direct_user' && source.kind !== 'assistant_report')
    return fail('invalid_source');
  const at = date(source.at);
  if (Date.parse(at) > Date.parse(now) + 300_000) return fail('future_source');
  const messageId =
    source.messageId === undefined ? undefined : text(source.messageId, 256);
  const quote =
    source.quote === undefined ? undefined : text(source.quote, 2000);
  if (quote && SECRET.test(quote)) return fail('credential_content');
  if (source.kind === 'direct_user' && (!messageId || !quote))
    return fail('direct_source_required');
  return {
    kind: source.kind,
    at,
    ...(messageId ? { messageId } : {}),
    ...(quote ? { quote } : {}),
    sourceReferenceTrust:
      source.kind === 'direct_user' ? 'verified_quote' : 'agent_reported',
    contentTrust: 'agent_interpreted',
  };
}
function cardView(card: MemoryProjectCard): MemoryProjectCard {
  if (
    !card ||
    !['active', 'waiting', 'completed', 'cancelled'].includes(card.status)
  )
    return fail('invalid_card');
  const lines = (input: unknown): string[] => {
    if (!Array.isArray(input) || input.length > 30) return fail('invalid_card');
    return input.map((line) => text(line, 1000));
  };
  if (!Array.isArray(card.artifacts) || card.artifacts.length > 20)
    return fail('invalid_card');
  const result: MemoryProjectCard = {
    title: text(card.title, 200),
    goal: text(card.goal, 4000),
    status: card.status,
    pending: lines(card.pending),
    completed: lines(card.completed),
    waiting: card.waiting === null ? null : text(card.waiting, 2000),
    artifacts: card.artifacts.map((artifact) => {
      if (
        !artifact ||
        !['created', 'verified', 'delivered'].includes(artifact.state)
      )
        return fail('invalid_artifact');
      return {
        path: text(artifact.path, 2048),
        state: artifact.state,
        ...(artifact.note === undefined
          ? {}
          : { note: text(artifact.note, 500) }),
      };
    }),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 32768)
    return fail('card_too_large');
  if (
    SECRET.test(
      [
        result.title,
        result.goal,
        ...result.pending,
        ...result.completed,
        result.waiting ?? '',
        ...result.artifacts.flatMap((a) => [a.path, a.note ?? '']),
      ].join('\n'),
    )
  )
    return fail('credential_content');
  return result;
}
function target(op: MemoryStateOperation): {
  kind: 'project' | 'fact';
  projectKey: string | null;
  key: string;
  recordKey: string;
} {
  const kind =
    op.kind === 'fact_upsert' || (op.kind === 'forget' && op.target === 'fact')
      ? 'fact'
      : 'project';
  const projectKey = op.projectKey === null ? null : key(op.projectKey);
  if (kind === 'project' && projectKey === null)
    return fail('project_required');
  const itemKey =
    kind === 'project' ? projectKey! : key('key' in op ? op.key : undefined);
  return {
    kind,
    projectKey,
    key: itemKey,
    recordKey: JSON.stringify([kind, projectKey, itemKey]),
  };
}
function readRow(
  db: Database.Database,
  scope: string,
  record: string,
): Row | undefined {
  return db
    .prepare(
      'SELECT * FROM memory_state_records WHERE scope_key=? AND record_key=?',
    )
    .get(scope, record) as Row | undefined;
}
function publicRecord(row: Row | undefined): MemoryStateRecord | null {
  if (!row || row.forgotten || !row.body_json || !row.source_json) return null;
  return {
    kind: row.kind,
    projectKey: row.project_key || null,
    key: row.item_key,
    revision: row.revision,
    updatedAt: row.updated_at,
    source: JSON.parse(row.source_json),
    evidence: 'reported_not_verified',
    ...JSON.parse(row.body_json),
  } as MemoryStateRecord;
}
function currentRecord(
  row: Row | undefined,
  now: string,
): MemoryStateRecord | null {
  const record = publicRecord(row);
  return record?.kind === 'fact' &&
    record.validUntil !== null &&
    record.validUntil <= now
    ? null
    : record;
}
function olderSource(
  at: string,
  id: string | undefined,
  thanAt: string | null,
  thanId: string | null,
): boolean {
  if (!thanAt) return false;
  if (at !== thanAt) return at < thanAt;
  return Boolean(
    id &&
    thanId &&
    /^\d+$/.test(id) &&
    /^\d+$/.test(thanId) &&
    BigInt(id) < BigInt(thanId),
  );
}
function strictlyNewer(
  at: string,
  id: string | undefined,
  thanAt: string,
  thanId: string | null,
): boolean {
  if (at !== thanAt) return at > thanAt;
  return Boolean(
    id &&
    thanId &&
    /^\d+$/.test(id) &&
    /^\d+$/.test(thanId) &&
    BigInt(id) > BigInt(thanId),
  );
}
export function ensureMemoryStateSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_state_records (
      scope_key TEXT NOT NULL, record_key TEXT NOT NULL, kind TEXT NOT NULL,
      project_key TEXT NOT NULL, item_key TEXT NOT NULL, revision INTEGER NOT NULL,
      body_json TEXT, source_json TEXT, updated_at TEXT NOT NULL,
      direct_at TEXT, direct_message_id TEXT, forgotten INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(scope_key,record_key)
    );
    CREATE INDEX IF NOT EXISTS memory_state_namespace ON memory_state_records(scope_key,project_key,updated_at);
    CREATE TABLE IF NOT EXISTS memory_state_versions (
      scope_key TEXT NOT NULL, record_key TEXT NOT NULL, revision INTEGER NOT NULL,
      body_json TEXT, source_json TEXT, updated_at TEXT NOT NULL, forgotten INTEGER NOT NULL,
      PRIMARY KEY(scope_key,record_key,revision)
    );
    CREATE TABLE IF NOT EXISTS memory_state_tombstones (
      scope_key TEXT NOT NULL, record_key TEXT NOT NULL, kind TEXT NOT NULL,
      project_key TEXT NOT NULL, item_key TEXT NOT NULL, revision INTEGER NOT NULL,
      forgotten_at TEXT NOT NULL, source_at TEXT NOT NULL, source_message_id TEXT,
      PRIMARY KEY(scope_key,record_key)
    );
    CREATE TABLE IF NOT EXISTS memory_state_operations (
      scope_key TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      record_key TEXT NOT NULL, applied_revision INTEGER NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(scope_key,operation_id)
    );
    CREATE TABLE IF NOT EXISTS memory_state_focus (
      scope_key TEXT PRIMARY KEY, project_key TEXT, source_at TEXT NOT NULL, source_message_id TEXT
    );
  `);
}

/** CAS + idempotency + all cascading erasure happen in one SQLite transaction. */
export function mutateMemoryState(
  db: Database.Database,
  scope: MemoryStateScope,
  operation: MemoryStateOperation,
  source: MemoryStateSource,
  options: { now?: string } = {},
): { record: MemoryStateRecord | null; revision: number; replayed: boolean } {
  const scopeId = scopeKey(scope),
    now = date(options.now ?? new Date().toISOString());
  const src = sourceView(source, now),
    op = operation;
  if (
    !op ||
    !['project_upsert', 'project_activate', 'fact_upsert', 'forget'].includes(
      op.kind,
    )
  )
    return fail('invalid_operation');
  const operationId = text(op.operationId, 128);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(operationId) ||
    !Number.isSafeInteger(op.expectedRevision) ||
    op.expectedRevision < 0
  )
    return fail('invalid_revision');
  // Caller-chosen operation IDs can themselves contain a forgotten value.
  const operationKey = createHash('sha256').update(operationId).digest('hex');
  if (op.kind === 'forget' && !['fact', 'project'].includes(op.target))
    return fail('invalid_operation');
  const dest = target(op);
  const body =
    op.kind === 'project_upsert'
      ? { card: cardView(op.card) }
      : op.kind === 'fact_upsert'
        ? {
            value: text(op.value, 4000),
            factType: op.factType ?? 'fact',
            validUntil: op.validUntil == null ? null : date(op.validUntil),
          }
        : null;
  if (
    op.kind === 'fact_upsert' &&
    !['fact', 'decision', 'preference', 'permission_note'].includes(
      (body as { factType: string }).factType,
    )
  )
    return fail('invalid_fact_type');
  if (
    op.kind === 'fact_upsert' &&
    SECRET.test((body as { value: string }).value)
  )
    return fail('credential_content');
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        operationKind: op.kind,
        ...dest,
        body,
        expectedRevision: op.expectedRevision,
        source: src,
        // Authorization flags describe this host run, not the stable request.
        // A recorded operation may be retried after its source becomes history;
        // replay below returns current state without applying, reviving or focusing.
      }),
    )
    .digest('hex');
  return db
    .transaction(() => {
      const prior = db
        .prepare(
          'SELECT request_hash,record_key,applied_revision FROM memory_state_operations WHERE scope_key=? AND operation_id=?',
        )
        .get(scopeId, operationKey) as
        | { request_hash: string; record_key: string; applied_revision: number }
        | undefined;
      if (prior) {
        if (prior.request_hash !== requestHash)
          return fail('idempotency_conflict');
        return {
          record: currentRecord(readRow(db, scopeId, prior.record_key), now),
          revision: prior.applied_revision,
          replayed: true,
        };
      }
      const current = readRow(db, scopeId, dest.recordKey);
      const focus = db
        .prepare(
          'SELECT project_key,source_at,source_message_id FROM memory_state_focus WHERE scope_key=?',
        )
        .get(scopeId) as
        | {
            project_key: string | null;
            source_at: string;
            source_message_id: string | null;
          }
        | undefined;
      const revision = current?.revision ?? 0;
      if (revision !== op.expectedRevision)
        return fail('revision_conflict', revision);
      if (
        source.kind === 'direct_user' &&
        olderSource(
          src.at,
          src.messageId,
          current?.direct_at ?? null,
          current?.direct_message_id ?? null,
        )
      )
        return fail('stale_source', revision);
      if (
        op.kind === 'forget' &&
        (source.kind !== 'direct_user' || source.explicitForget !== true)
      )
        return fail('explicit_forget_required', revision);
      if (
        op.kind === 'project_activate' &&
        (source.kind !== 'direct_user' || source.explicitActivate !== true)
      )
        return fail('explicit_activation_required', revision);
      if (
        op.kind === 'project_activate' &&
        focus &&
        olderSource(
          src.at,
          src.messageId,
          focus.source_at,
          focus.source_message_id,
        )
      )
        return fail('stale_focus_source', revision);
      if (current?.forgotten && op.kind !== 'forget') {
        if (
          source.kind !== 'direct_user' ||
          source.explicitRemember !== true ||
          !strictlyNewer(
            src.at,
            src.messageId,
            current.direct_at!,
            current.direct_message_id,
          )
        )
          return fail('forgotten', revision);
        if (op.kind === 'project_activate')
          return fail('project_missing', revision);
      }
      if (!current) {
        const count = db
          .prepare(
            'SELECT COUNT(*) AS n FROM memory_state_records WHERE scope_key=?',
          )
          .get(scopeId) as { n: number };
        if (count.n >= LIMIT_RECORDS) return fail('scope_limit');
      }
      if (
        dest.kind === 'fact' &&
        dest.projectKey !== null &&
        op.kind !== 'forget'
      ) {
        const project = readRow(
          db,
          scopeId,
          JSON.stringify(['project', dest.projectKey, dest.projectKey]),
        );
        if (!project || project.forgotten) return fail('project_missing');
      }
      if (
        op.kind === 'fact_upsert' &&
        source.kind === 'assistant_report' &&
        current?.direct_at
      )
        return fail('direct_fact_priority', revision);
      let nextBody: unknown = body;
      if (op.kind === 'project_activate') {
        if (!current || current.forgotten)
          return fail('project_missing', revision);
        const existing = JSON.parse(current.body_json!)
          .card as MemoryProjectCard;
        nextBody = { card: { ...existing, status: 'active' } };
      }
      if (op.kind === 'project_upsert' && current) {
        const existing = current.body_json
          ? (JSON.parse(current.body_json).card as MemoryProjectCard)
          : null;
        const next = (body as { card: MemoryProjectCard }).card;
        if (
          (current.forgotten ||
            existing?.status === 'completed' ||
            existing?.status === 'cancelled') &&
          ['active', 'waiting'].includes(next.status)
        )
          return fail('activation_required', revision);
        if (
          source.kind === 'assistant_report' &&
          current.direct_at &&
          existing &&
          (next.goal !== existing.goal || next.title !== existing.title)
        )
          return fail('direct_goal_priority', revision);
      }
      const write = (
        item: typeof dest,
        old: Row | undefined,
        value: unknown,
        forgotten: boolean,
      ): number => {
        const nextRevision = (old?.revision ?? 0) + 1;
        const directAt =
          source.kind === 'direct_user' ? src.at : (old?.direct_at ?? null);
        const directId =
          source.kind === 'direct_user'
            ? (src.messageId ?? null)
            : (old?.direct_message_id ?? null);
        const bodyJson = forgotten ? null : JSON.stringify(value),
          sourceJson = forgotten ? null : JSON.stringify(src);
        if (forgotten) {
          db.prepare(
            'DELETE FROM memory_state_versions WHERE scope_key=? AND record_key=?',
          ).run(scopeId, item.recordKey);
          db.prepare(
            `INSERT INTO memory_state_tombstones VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_key,record_key) DO UPDATE SET revision=excluded.revision,forgotten_at=excluded.forgotten_at,source_at=excluded.source_at,source_message_id=excluded.source_message_id`,
          ).run(
            scopeId,
            item.recordKey,
            item.kind,
            item.projectKey ?? '',
            item.key,
            nextRevision,
            now,
            src.at,
            src.messageId ?? null,
          );
        }
        db.prepare(
          `INSERT INTO memory_state_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_key,record_key) DO UPDATE SET revision=excluded.revision,body_json=excluded.body_json,source_json=excluded.source_json,updated_at=excluded.updated_at,direct_at=excluded.direct_at,direct_message_id=excluded.direct_message_id,forgotten=excluded.forgotten`,
        ).run(
          scopeId,
          item.recordKey,
          item.kind,
          item.projectKey ?? '',
          item.key,
          nextRevision,
          bodyJson,
          sourceJson,
          now,
          directAt,
          directId,
          forgotten ? 1 : 0,
        );
        db.prepare(
          'INSERT INTO memory_state_versions VALUES (?,?,?,?,?,?,?)',
        ).run(
          scopeId,
          item.recordKey,
          nextRevision,
          bodyJson,
          sourceJson,
          now,
          forgotten ? 1 : 0,
        );
        db.prepare(
          'DELETE FROM memory_state_versions WHERE scope_key=? AND record_key=? AND revision<=?',
        ).run(scopeId, item.recordKey, nextRevision - MAX_VERSIONS);
        return nextRevision;
      };
      if (op.kind === 'forget' && dest.kind === 'project') {
        const children = db
          .prepare(
            "SELECT * FROM memory_state_records WHERE scope_key=? AND project_key=? AND kind='fact'",
          )
          .all(scopeId, dest.projectKey) as Row[];
        if (
          children.some((child) =>
            olderSource(
              src.at,
              src.messageId,
              child.direct_at,
              child.direct_message_id,
            ),
          )
        )
          return fail('stale_source', revision);
        for (const child of children)
          write(
            {
              kind: 'fact',
              projectKey: dest.projectKey,
              key: child.item_key,
              recordKey: child.record_key,
            },
            child,
            null,
            true,
          );
      }
      const appliedRevision = write(
        dest,
        current,
        nextBody,
        op.kind === 'forget',
      );
      if (dest.kind === 'project') {
        const status = (nextBody as { card?: MemoryProjectCard } | null)?.card
          ?.status;
        if (
          focus?.project_key === dest.projectKey &&
          (op.kind === 'forget' ||
            status === 'completed' ||
            status === 'cancelled')
        ) {
          // Keep the last direct focus boundary even when progress clears it.
          db.prepare(
            'UPDATE memory_state_focus SET project_key=NULL WHERE scope_key=?',
          ).run(scopeId);
        } else if (
          op.kind === 'project_activate' ||
          (op.kind === 'project_upsert' &&
            source.kind === 'direct_user' &&
            source.currentDirectInput === true &&
            (status === 'active' || status === 'waiting'))
        ) {
          // A current direct correction can select an existing working card.
          // This changes recall focus only; closed-card activation was gated
          // above, and assistant/historical updates cannot select a task.
          if (
            !focus ||
            !olderSource(
              src.at,
              src.messageId,
              focus.source_at,
              focus.source_message_id,
            )
          )
            db.prepare(
              `INSERT INTO memory_state_focus VALUES (?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET project_key=excluded.project_key,source_at=excluded.source_at,source_message_id=excluded.source_message_id`,
            ).run(scopeId, dest.projectKey, src.at, src.messageId ?? null);
        }
      }
      // The replay log contains no body/quote, so forgetting cannot leak an old result.
      db.prepare(
        'INSERT INTO memory_state_operations VALUES (?,?,?,?,?,?)',
      ).run(
        scopeId,
        operationKey,
        requestHash,
        dest.recordKey,
        appliedRevision,
        now,
      );
      return {
        record: currentRecord(readRow(db, scopeId, dest.recordKey), now),
        revision: appliedRevision,
        replayed: false,
      };
    })
    .immediate();
}

export function listMemoryState(
  db: Database.Database,
  scope: MemoryStateScope,
  options: { projectKey?: string | null; now?: string; limit?: number } = {},
): MemoryStateListing {
  const scopeId = scopeKey(scope),
    now = date(options.now ?? new Date().toISOString());
  const namespace =
    options.projectKey === undefined
      ? undefined
      : options.projectKey === null
        ? ''
        : key(options.projectKey);
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)));
  if (!Number.isFinite(limit)) return fail('invalid_limit');
  const focus = db
    .prepare('SELECT project_key FROM memory_state_focus WHERE scope_key=?')
    .get(scopeId) as { project_key: string | null } | undefined;
  // Separate budgets: many new facts must not crowd the active cards out.
  const rows = (['project', 'fact'] as const).flatMap(
    (kind) =>
      db
        .prepare(
          `SELECT * FROM memory_state_records WHERE scope_key=? AND kind=? AND forgotten=0 ${namespace === undefined ? '' : 'AND project_key=?'} ${kind === 'fact' ? "AND (json_extract(body_json,'$.validUntil') IS NULL OR json_extract(body_json,'$.validUntil')>?)" : ''} ORDER BY ${kind === 'project' ? 'CASE WHEN project_key=? THEN 0 ELSE 1 END,' : ''} updated_at DESC,record_key LIMIT ?`,
        )
        .all(
          scopeId,
          kind,
          ...(namespace === undefined ? [] : [namespace]),
          ...(kind === 'fact' ? [now] : [focus?.project_key ?? '']),
          limit,
        ) as Row[],
  );
  const listing: MemoryStateListing = {
    projects: [],
    facts: [],
    tombstones: [],
    expired: [],
    hasTombstones: false,
    focusedProjectKey: focus?.project_key ?? null,
  };
  for (const row of rows) {
    const record = publicRecord(row);
    if (!record) continue;
    if (record.kind === 'project') listing.projects.push(record);
    else listing.facts.push(record);
  }
  const expired = db
    .prepare(
      `SELECT project_key,item_key,revision,json_extract(body_json,'$.validUntil') AS valid_until FROM memory_state_records WHERE scope_key=? AND kind='fact' AND forgotten=0 AND json_extract(body_json,'$.validUntil')<=? ${namespace === undefined ? '' : 'AND project_key=?'} ORDER BY updated_at DESC,record_key LIMIT ?`,
    )
    .all(
      scopeId,
      now,
      ...(namespace === undefined ? [] : [namespace]),
      limit,
    ) as Array<{
    project_key: string;
    item_key: string;
    revision: number;
    valid_until: string;
  }>;
  listing.expired = expired.map((row) => ({
    projectKey: row.project_key || null,
    key: row.item_key,
    revision: row.revision,
    validUntil: row.valid_until,
  }));
  const tombstones = db
    .prepare(
      `SELECT * FROM memory_state_tombstones WHERE scope_key=? ${namespace === undefined ? '' : 'AND project_key=?'} ORDER BY forgotten_at DESC,record_key LIMIT ?`,
    )
    .all(
      ...(namespace === undefined
        ? [scopeId, limit]
        : [scopeId, namespace, limit]),
    ) as Array<{
    kind: 'project' | 'fact';
    project_key: string;
    item_key: string;
    revision: number;
    forgotten_at: string;
    source_at: string;
  }>;
  listing.tombstones = tombstones.map((row) => ({
    kind: row.kind,
    projectKey: row.project_key || null,
    key: row.item_key,
    revision: row.revision,
    forgottenAt: row.forgotten_at,
    sourceAt: row.source_at,
  }));
  listing.hasTombstones = Boolean(
    db
      .prepare(
        'SELECT 1 FROM memory_state_tombstones WHERE scope_key=? LIMIT 1',
      )
      .get(scopeId),
  );
  return listing;
}

export function getMemoryProject(
  db: Database.Database,
  scope: MemoryStateScope,
  projectKey: string,
  options: { now?: string } = {},
): {
  project: Extract<MemoryStateRecord, { kind: 'project' }>;
  facts: Array<Extract<MemoryStateRecord, { kind: 'fact' }>>;
} | null {
  const listing = listMemoryState(db, scope, {
    projectKey,
    now: options.now,
    limit: 200,
  });
  const project = listing.projects[0];
  return project ? { project, facts: listing.facts } : null;
}

export interface MemoryStatePageOptions {
  projectKey?: string | null;
  cursor?: string;
  pageSize?: number;
  now?: string;
}
export type MemoryStatePage = MemoryStateListing & {
  nextCursor: string | null;
  pageSize: number;
};
export type MemoryProjectPage = Omit<MemoryStatePage, 'projects'> & {
  project: Extract<MemoryStateRecord, { kind: 'project' }>;
};
const MEMORY_STATE_PAGE_BYTES = 96 * 1024;
type MemoryPagePosition = { source: 'record' | 'tombstone'; key: string };

/** A cursor selects a position only; authenticated host scope is always in SQL. */
function memoryPageCursor(
  scopeId: string,
  namespace: string | undefined,
  mode: 'list' | 'project',
  position: MemoryPagePosition,
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      scope: createHash('sha256').update(scopeId).digest('hex'),
      namespace: namespace ?? null,
      mode,
      position,
    }),
  ).toString('base64url');
}
function memoryPagePosition(
  raw: string | undefined,
  scopeId: string,
  namespace: string | undefined,
  mode: 'list' | 'project',
): MemoryPagePosition | null {
  if (raw === undefined) return null;
  if (
    typeof raw !== 'string' ||
    raw.length > 2048 ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  )
    return fail('invalid_cursor');
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      decoded?.v !== 1 ||
      decoded.scope !== createHash('sha256').update(scopeId).digest('hex') ||
      decoded.namespace !== (namespace ?? null) ||
      decoded.mode !== mode
    )
      return fail('invalid_cursor_scope');
    if (
      !decoded.position ||
      !['record', 'tombstone'].includes(decoded.position.source) ||
      typeof decoded.position.key !== 'string' ||
      decoded.position.key.length > 512
    )
      return fail('invalid_cursor');
    const parts = JSON.parse(decoded.position.key);
    if (
      !Array.isArray(parts) ||
      parts.length !== 3 ||
      !['project', 'fact'].includes(parts[0]) ||
      (parts[1] !== null && typeof parts[1] !== 'string') ||
      typeof parts[2] !== 'string'
    )
      return fail('invalid_cursor');
    return decoded.position;
  } catch (error) {
    if (error instanceof MemoryStateError) throw error;
    return fail('invalid_cursor');
  }
}

function memoryStatePage(
  db: Database.Database,
  scope: MemoryStateScope,
  options: MemoryStatePageOptions,
  mode: 'list' | 'project',
): MemoryStatePage | MemoryProjectPage | null {
  const scopeId = scopeKey(scope),
    now = date(options.now ?? new Date().toISOString());
  const namespace =
    options.projectKey === undefined
      ? undefined
      : options.projectKey === null
        ? ''
        : key(options.projectKey);
  if (mode === 'project' && !namespace) return fail('project_required');
  const pageSize = options.pageSize ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
    return fail('invalid_page_size');
  const after = memoryPagePosition(options.cursor, scopeId, namespace, mode);
  const focus = db
    .prepare('SELECT project_key FROM memory_state_focus WHERE scope_key=?')
    .get(scopeId) as { project_key: string } | undefined;
  const listing: MemoryStatePage = {
    projects: [],
    facts: [],
    tombstones: [],
    expired: [],
    hasTombstones: Boolean(
      db
        .prepare(
          'SELECT 1 FROM memory_state_tombstones WHERE scope_key=? LIMIT 1',
        )
        .get(scopeId),
    ),
    focusedProjectKey: focus?.project_key ?? null,
    nextCursor: null,
    pageSize,
  };
  let result: MemoryStatePage | MemoryProjectPage = listing;
  if (mode === 'project') {
    const project = publicRecord(
      readRow(db, scopeId, JSON.stringify(['project', namespace, namespace])),
    );
    if (!project || project.kind !== 'project') return null;
    const { projects, ...rest } = listing;
    result = { ...rest, project };
  }
  const where = namespace === undefined ? '' : ' AND project_key=?';
  const args = [
    scopeId,
    ...(namespace === undefined ? [] : [namespace]),
    scopeId,
    ...(namespace === undefined ? [] : [namespace]),
    after?.source ?? '',
    after?.source ?? '',
    after?.key ?? '',
    pageSize + 1,
  ];
  const positions = db
    .prepare(
      `SELECT source,record_key FROM (
    SELECT 'record' AS source,record_key FROM memory_state_records WHERE scope_key=? AND forgotten=0 ${where} ${mode === 'project' ? "AND kind='fact'" : ''}
    UNION ALL SELECT 'tombstone' AS source,record_key FROM memory_state_tombstones WHERE scope_key=? ${where}
  ) WHERE source>? OR (source=? AND record_key>?) ORDER BY source,record_key LIMIT ?`,
    )
    .all(...args) as Array<{
    source: 'record' | 'tombstone';
    record_key: string;
  }>;
  let included = 0;
  for (let index = 0; index < positions.length; index++) {
    const position = positions[index];
    if (included >= pageSize) break;
    let field: 'projects' | 'facts' | 'expired' | 'tombstones';
    let item: unknown;
    if (position.source === 'tombstone') {
      const row = db
        .prepare(
          'SELECT kind,project_key,item_key,revision,forgotten_at,source_at FROM memory_state_tombstones WHERE scope_key=? AND record_key=?',
        )
        .get(scopeId, position.record_key) as {
        kind: 'fact' | 'project';
        project_key: string;
        item_key: string;
        revision: number;
        forgotten_at: string;
        source_at: string;
      };
      field = 'tombstones';
      item = {
        kind: row.kind,
        projectKey: row.project_key || null,
        key: row.item_key,
        revision: row.revision,
        forgottenAt: row.forgotten_at,
        sourceAt: row.source_at,
      };
    } else {
      const record = publicRecord(readRow(db, scopeId, position.record_key));
      if (!record) return fail('memory_page_changed_retry');
      if (record.kind === 'project') {
        field = 'projects';
        item = record;
      } else if (record.validUntil !== null && record.validUntil <= now) {
        field = 'expired';
        item = {
          projectKey: record.projectKey,
          key: record.key,
          revision: record.revision,
          validUntil: record.validUntil,
        };
      } else {
        field = 'facts';
        item = record;
      }
    }
    const items = (result as unknown as Record<string, unknown[]>)[field];
    items.push(item);
    const next = memoryPageCursor(scopeId, namespace, mode, {
      source: position.source,
      key: position.record_key,
    });
    const previous = result.nextCursor;
    result.nextCursor = next; // Budget includes the largest required continuation metadata.
    if (
      Buffer.byteLength(JSON.stringify(result), 'utf8') >
      MEMORY_STATE_PAGE_BYTES
    ) {
      items.pop();
      result.nextCursor = previous;
      if (included === 0) return fail('memory_record_too_large');
      return result;
    }
    included++;
    if (index === positions.length - 1) result.nextCursor = null;
  }
  return result;
}

/** Full records, bounded bytes, stable key pagination; no context-loader changes. */
export function readMemoryStatePage(
  db: Database.Database,
  scope: MemoryStateScope,
  options: MemoryStatePageOptions = {},
): MemoryStatePage {
  return memoryStatePage(db, scope, options, 'list') as MemoryStatePage;
}
export function getMemoryProjectPage(
  db: Database.Database,
  scope: MemoryStateScope,
  projectKey: string,
  options: Omit<MemoryStatePageOptions, 'projectKey'> = {},
): MemoryProjectPage | null {
  return memoryStatePage(
    db,
    scope,
    { ...options, projectKey },
    'project',
  ) as MemoryProjectPage | null;
}
