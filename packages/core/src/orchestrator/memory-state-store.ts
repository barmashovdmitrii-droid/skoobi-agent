import { linkedMemoryReadProjects, matchMemoryReadProjects, memoryReadProjectRequest, memorySearchStem } from './memory-project-match.js';
import { containsMemoryCredentials } from './memory-credential-content.js';
import { parseMemoryWorkCheckpoint, validateMemoryWorkTransition, type MemoryWorkCheckpoint } from './memory-work-checkpoint.js';
import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'node:util';
import { projectNameProof, projectNameProofMatches, type ProjectNameProof } from './memory-project-name-source.js';
import type Database from 'better-sqlite3';
import { parseProjectValueDetail, type ProjectValueDetail } from './project-insights.js';
import { parseEditorialFeedbackDetail, type EditorialFeedbackDetail, type EditorialFeedbackDetailInput, type EditorialArtifactEvidence } from './editorial-feedback.js';

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
  /** Host-only complete latest owner message; a caller's chosen substring cannot grant names. */
  projectNamesMessage?: string;
  /** The public host permits these commands only on existing cards, with other fields unchanged. */
  projectNamesOnly?: boolean;
  /** The active host turn is a scoped metadata command, not a work assignment. */
  metadataTurn?: boolean;
  /** Host observation of the complete, authenticated direct message at write time. */
  messageContentSha256?: string;
  messageEditRevision?: number;
  messageBindingHash?: string;
  /** Host-only proof from exact same-chat assistant message bytes. */
  editorialArtifactEvidence?: EditorialArtifactEvidence;
}
export interface StoredMemoryStateSource {
  kind: MemoryStateSource['kind'];
  at: string;
  messageId?: string;
  quote?: string;
  /** Optional in pre-existing records; omitted from normal JSON reads. */
  messageContentSha256?: string;
  messageEditRevision?: number;
  messageBindingHash?: string;
  sourceReferenceTrust: 'verified_quote' | 'agent_reported';
  contentTrust: 'agent_interpreted';
}
export type MemoryFactType =
  | 'fact'
  | 'decision'
  | 'preference'
  | 'permission_note';
export interface MemoryProjectCard {
  /** Read-only names and direct historical links. Missing fields are valid on older cards. */
  aliases?: string[];
  relatedProjectKeys?: string[];
  work?: MemoryWorkCheckpoint;
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
export function projectWaitingState(card: MemoryProjectCard) {
  if (card.status !== 'waiting') return undefined;
  const checkpointStep = card.work?.nextStep;
  return {
    condition: card.waiting,
    waitingOn: card.work?.waitingOn ?? null,
    nextStep: checkpointStep ?? card.pending[0] ?? null,
    stepSource: checkpointStep ? 'checkpoint' : card.pending.length ? 'recorded_pending' : 'unknown',
  } as const;
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
        detail?: ProjectValueDetail | EditorialFeedbackDetailInput;
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
      waitingState?: ReturnType<typeof projectWaitingState>;
    })
  | (RecordBase & {
      kind: 'fact';
      value: string;
      factType: MemoryFactType;
      validUntil: string | null;
      detail?: ProjectValueDetail | EditorialFeedbackDetail;
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
  /** Time of the verified message selecting the focus, independent of later progress. */
  focusedSourceAt?: string;
  focusedSourceId?: string;
  projectsTruncated?: boolean;
}
export class MemoryStateError extends Error {
  constructor(
    public code: string,
    public currentRevision?: number,
    public workReview?: { requirementsRevision: number; criterionKeys: string[] },
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

const fail = (code: string, revision?: number): never => {
  throw new MemoryStateError(code, revision);
};
function failProjectRevision(code: string, revision: number, work?: MemoryWorkCheckpoint): never {
  throw new MemoryStateError(code, revision, work && {
    requirementsRevision: work.requirementsRevision,
    criterionKeys: work.criteria.map(criterion => criterion.key),
  });
}
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
// Срок факта (validUntil) модель пишет и без секунд: «2026-11-30T18:00Z»
// проходит проверку инструмента (iso-date-time.ts) и хранится полным ISO.
const DATE_WITH_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DATE_SECONDS_OPTIONAL =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
function date(value: unknown, secondsOptional = false): string {
  const raw = text(value, 40);
  if (
    !(secondsOptional ? DATE_SECONDS_OPTIONAL : DATE_WITH_SECONDS).test(raw) ||
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
  if (quote && containsMemoryCredentials(quote)) return fail('credential_content');
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
  let work: MemoryWorkCheckpoint | undefined;
  if (card.work !== undefined) {
    try { work = parseMemoryWorkCheckpoint(card.work); } catch { return fail('invalid_work_checkpoint'); }
    if (card.status === 'completed' && (card.pending.length || card.waiting || work.nextStep || work.waitingOn || work.criteria.some(c => c.state !== 'passed')))
      return fail('work_acceptance_incomplete');
  }
  function names(values: unknown, max: number, format: (value: unknown) => string): string[] {
    if (!Array.isArray(values) || values.length > max) return fail('invalid_card');
    return [...new Set(values.map(format))];
  }
  const result: MemoryProjectCard = {
    ...(card.aliases === undefined ? {} : { aliases: names(card.aliases, 8, value => {
      const alias = text(value, 80);
      if (/[\r\n«»]/.test(alias)) return fail('invalid_card');
      return alias.length >= 3 ? alias : fail('invalid_card');
    }) }),
    ...(card.relatedProjectKeys === undefined ? {} : { relatedProjectKeys: names(card.relatedProjectKeys, 3, key) }),
    ...(work ? {work} : {}),
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
  // Each checkpoint text is also read on its own: inside the serialized
  // checkpoint a word-shaped value («password: <word>» in waitingOn) followed
  // by the next JSON field is not recognized as a credential value.
  const workTexts = result.work
    ? [
        result.work.target,
        result.work.executor,
        result.work.waitingOn ?? '',
        result.work.nextStep ?? '',
        ...result.work.criteria.flatMap((c) => [c.description, c.evidence ?? '']),
      ]
    : [];
  if (
    containsMemoryCredentials(
      [
        JSON.stringify(result.work ?? {}),
        ...(result.aliases ?? []), ...(result.relatedProjectKeys ?? []),
        result.title,
        result.goal,
        ...result.pending,
        ...result.completed,
        result.waiting ?? '',
        ...result.artifacts.flatMap((a) => [a.path, a.note ?? '']),
      ].join('\n'),
    ) ||
    workTexts.some((value) => containsMemoryCredentials(value))
  )
    return fail('credential_content');
  return result;
}
function factDetail(
  operation: Extract<MemoryStateOperation, { kind: 'fact_upsert' }>,
  source: MemoryStateSource,
): ProjectValueDetail | EditorialFeedbackDetail | undefined {
  if (operation.detail === undefined) return;
  if (operation.projectKey === null) return fail('detail_requires_project');
  const detail =
    operation.detail.kind === 'project_value'
      ? ['fact', 'decision'].includes(operation.factType ?? 'fact')
        ? parseProjectValueDetail(operation.detail, source.kind)
        : undefined
      : operation.factType === 'preference'
        ? parseEditorialFeedbackDetail(operation.detail, source)
        : undefined;
  if (!detail) return fail('invalid_fact_detail');
  if (containsMemoryCredentials(JSON.stringify(detail))) return fail('credential_content');
  return detail;
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
/** A target's last forget revision is its lifetime boundary. Metadata from an
 * earlier experimental writer has no verified marker and grants no read route. */
function linkedProjectEpoch(db: Database.Database, scope: string, projectKey: string): number {
  const tombstone = db.prepare('SELECT revision FROM memory_state_tombstones WHERE scope_key=? AND record_key=?')
    .get(scope, JSON.stringify(['project', projectKey, projectKey])) as {revision: number} | undefined;
  return tombstone?.revision ?? 0;
}

function projectNamesCommands(projectKey: string, old: MemoryProjectCard | null, next: MemoryProjectCard): string[] {
  const changes: string[] = [];
  for (const field of ['aliases', 'relatedProjectKeys'] as const) {
    const before = old?.[field] ?? [], after = next[field] ?? before;
    for (const name of before.filter(name => !after.includes(name)))
      changes.push(field === 'aliases' ? `Удали имя «${name}» у проекта ${projectKey}` : `Убери связь проекта ${projectKey} с проектом ${name}`);
    for (const name of after.filter(name => !before.includes(name)))
      changes.push(field === 'aliases' ? `Добавь имя «${name}» проекту ${projectKey}` : `Свяжи проект ${projectKey} с проектом ${name}`);
  }
  return changes;
}

function exactMetadataConsent(source: MemoryStateSource, commands: string[]): boolean {
  if (source.kind !== 'direct_user' || !source.currentDirectInput || !source.projectNamesMessage ||
      source.projectNamesMessage.trim() !== source.quote?.trim()) return false;
  const canonical = (line: string) => line.trim().replace(/[.]$/, '').normalize('NFC').toLowerCase();
  const lines = source.projectNamesMessage.trim().split(/\r?\n/).map(canonical).sort();
  return JSON.stringify(lines) === JSON.stringify(commands.map(canonical).sort());
}

const metadataSchemas = new WeakSet<Database.Database>();
function hasProjectMetadata(db: Database.Database): boolean {
  if (metadataSchemas.has(db)) return true;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_project_read_metadata'").get()) return false;
  metadataSchemas.add(db);
  return true;
}

type ProjectAlias = {name: string; proof: ProjectNameProof};
type ProjectReadMetadata = { aliases: ProjectAlias[]; links: Array<{key: string; epoch: number; proof: ProjectNameProof}> };

function savedAliasNames(aliases: ProjectAlias[], verified: (proof: ProjectNameProof) => boolean): string[] {
  return aliases.filter(alias => verified(alias.proof)).map(alias => alias.name);
}

function proofReader(db: Database.Database, scopeId: string) {
  const checked = new Map<string, boolean>();
  return (proof: ProjectNameProof) => {
    if (!proof) return false;
    const key = JSON.stringify([proof.messageId, proof.senderId, proof.at, proof.sha256, proof.editRevision ?? 0, proof.bindingHash]);
    if (!checked.has(key)) checked.set(key, projectNameProofMatches(db, scopeId, proof));
    return checked.get(key)!;
  };
}

function confirmedProjectMetadata(db: Database.Database, row: Row): ProjectReadMetadata | undefined {
  if (!hasProjectMetadata(db)) return;
  const saved = db.prepare(`SELECT n.metadata_json FROM memory_project_read_metadata n
    LEFT JOIN memory_state_tombstones t ON t.scope_key=n.scope_key AND t.record_key=?
    WHERE n.scope_key=? AND n.project_key=? AND n.project_epoch=COALESCE(t.revision,0)`)
    .get(row.record_key, row.scope_key, row.project_key) as {metadata_json: string} | undefined;
  if (!saved) return;
  const metadata = JSON.parse(saved.metadata_json) as ProjectReadMetadata;
  const verified = proofReader(db, row.scope_key);
  return {
    aliases: metadata.aliases.filter(alias => verified(alias.proof)),
    links: metadata.links.filter(link => verified(link.proof) && link.epoch === linkedProjectEpoch(db, row.scope_key, link.key)),
  };
}

function ordinaryProjectFields(card: MemoryProjectCard): MemoryProjectCard {
  const { aliases: _aliases, relatedProjectKeys: _links, ...fields } = card;
  return fields;
}

function publicRecord(db: Database.Database, row: Row | undefined): MemoryStateRecord | null {
  if (!row || row.forgotten || !row.body_json || !row.source_json) return null;
  const source = JSON.parse(row.source_json) as StoredMemoryStateSource;
  if (source.messageContentSha256 !== undefined)
    Object.defineProperty(source, 'messageContentSha256', { enumerable: false });
  if (source.messageEditRevision !== undefined)
    Object.defineProperty(source, 'messageEditRevision', { enumerable: false });
  if (source.messageBindingHash !== undefined)
    Object.defineProperty(source, 'messageBindingHash', { enumerable: false });
  const body = JSON.parse(row.body_json);
  const record = {
    kind: row.kind,
    projectKey: row.project_key || null,
    key: row.item_key,
    revision: row.revision,
    updatedAt: row.updated_at,
    source,
    evidence: 'reported_not_verified',
    ...body,
  } as MemoryStateRecord;
  if (record.kind === 'project') {
    // Prototype card fields were never a host confirmation. Read the scoped
    // metadata separately so an old reader cannot expose linked project keys.
    record.card = ordinaryProjectFields(record.card);
    const names = confirmedProjectMetadata(db, row);
    if (names?.aliases.length) record.card.aliases = names.aliases.map(alias => alias.name);
    if (names?.links.length) record.card.relatedProjectKeys = names.links.map(link => link.key);
    const waitingState = projectWaitingState(record.card);
    if (waitingState) record.waitingState = waitingState;
  }
  return record;
}
/** Used again inside semantic recall's authoritative post-await read. */
export function currentMemoryLinkKeys(db: Database.Database, scope: string, project: string): string[] {
  const card = publicRecord(db, readRow(db, scope, JSON.stringify(['project', project, project])));
  return card?.kind === 'project' ? card.card.relatedProjectKeys ?? [] : [];
}

function currentRecord(
  db: Database.Database,
  row: Row | undefined,
  now: string,
): MemoryStateRecord | null {
  const record = publicRecord(db, row);
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
    CREATE TABLE IF NOT EXISTS memory_project_read_metadata (
      scope_key TEXT NOT NULL, project_key TEXT NOT NULL, project_epoch INTEGER NOT NULL,
      metadata_json TEXT NOT NULL, PRIMARY KEY(scope_key,project_key)
    );
    CREATE TABLE IF NOT EXISTS memory_work_check_runs (
      scope_key TEXT NOT NULL, record_key TEXT NOT NULL, generation INTEGER NOT NULL,
      evidence_hash TEXT NOT NULL, first_requirements_revision INTEGER NOT NULL,
      PRIMARY KEY(scope_key,record_key,generation,evidence_hash)
    );
    CREATE TABLE IF NOT EXISTS memory_state_focus (
      scope_key TEXT PRIMARY KEY, project_key TEXT, source_at TEXT NOT NULL, source_message_id TEXT
    );
  `);
  metadataSchemas.add(db);
}

/** Bounded, content-free revision of the exact project, including erasures/expiry. */
export function memoryProjectRevisionFingerprint(
  db: Database.Database, scope: MemoryStateScope, projectKey: string,
): string {
  const rows = db.prepare(`SELECT record_key, revision, forgotten,
    json_extract(body_json,'$.validUntil') AS valid_until
    FROM memory_state_records WHERE scope_key=? AND project_key=?
    ORDER BY record_key LIMIT 2001`).all(scopeKey(scope), key(projectKey)) as Array<{
      record_key: string; revision: number; forgotten: number; valid_until: string | null;
    }>;
  if (rows.length > 2000) return fail('project_revision_budget_exceeded');
  const now = new Date().toISOString();
  return createHash('sha256').update(JSON.stringify(rows.map(row => [
    row.record_key, row.revision, row.forgotten,
    row.valid_until, row.valid_until !== null && row.valid_until <= now,
  ]))).digest('hex');
}

/** A missing receipt (possibly still in flight) does not prove the operation failed. */
export function readMemoryOperationStatus(db: Database.Database, scope: MemoryStateScope, operationId: string) {
  // An untouched legacy database has no receipt ledger yet. A read must not create it.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_state_operations'").get())
    return { status: 'unknown' as const };
  const operationKey = createHash('sha256').update(operationId).digest('hex');
  const applied = db.prepare(
    'SELECT applied_revision FROM memory_state_operations WHERE scope_key=? AND operation_id=?',
  ).get(scopeKey(scope), operationKey) as { applied_revision: number } | undefined;
  return applied ? { status: 'applied' as const, appliedRevision: applied.applied_revision }
    : { status: 'unknown' as const };
}

// A previous run cannot prove new requirements even after ordinary card
// versions age out. Keep only one digest per piece of evidence for this
// scoped lifetime. The caller owns the surrounding mutation transaction.
function rememberWorkCheckEvidence(
  db: Database.Database, scopeId: string, recordKey: string, recordRevision: number,
  previous: MemoryWorkCheckpoint | undefined, next: MemoryWorkCheckpoint,
): void {
  const tombstone = db.prepare(
    'SELECT revision FROM memory_state_tombstones WHERE scope_key=? AND record_key=?'
  ).get(scopeId, recordKey) as { revision: number } | undefined;
  const generation = tombstone?.revision ?? 0;
  db.prepare('DELETE FROM memory_work_check_runs WHERE scope_key=? AND record_key=? AND generation<>?')
    .run(scopeId, recordKey, generation);
  const digest = (value: string) => createHash('sha256')
    .update(value.normalize('NFKC').trim().replace(/\s+/gu, ' ')).digest('hex');
  const insert = db.prepare(`INSERT INTO memory_work_check_runs VALUES (?,?,?,?,?)
    ON CONFLICT(scope_key,record_key,generation,evidence_hash) DO UPDATE SET
    first_requirements_revision=MIN(first_requirements_revision,excluded.first_requirements_revision)`);
  const existing = db.prepare(`SELECT first_requirements_revision FROM memory_work_check_runs
    WHERE scope_key=? AND record_key=? AND generation=? AND evidence_hash=?`);
  const hasKnownRun = (criterion: MemoryWorkCheckpoint['criteria'][number]) =>
    criterion.evidence && existing.get(scopeId, recordKey, generation, digest(criterion.evidence));
  const newlyReported = next.requirementsRevision > 1 && next.criteria.some(c =>
    c.state === 'passed' && !hasKnownRun(c));
  if (previous && (newlyReported || !db.prepare(`SELECT 1 FROM memory_work_check_runs
    WHERE scope_key=? AND record_key=? AND generation=? LIMIT 1`).get(scopeId, recordKey, generation))) {
    // Import only still-readable versions when upgrading a legacy database.
    const past = db.prepare(`SELECT DISTINCT json_extract(c.value,'$.evidence') AS evidence,
      json_extract(c.value,'$.checkedRevision') AS checked FROM memory_state_versions v,
      json_each(v.body_json,'$.card.work.criteria') c WHERE v.scope_key=? AND v.record_key=?
      AND v.revision>? AND v.forgotten=0 AND json_type(c.value,'$.evidence')='text'
      AND json_type(c.value,'$.checkedRevision')='integer'`).all(scopeId,recordKey,generation) as
      {evidence: string; checked: number}[];
    for (const row of past) insert.run(scopeId, recordKey, generation, digest(row.evidence), row.checked);
  }
  for (const criterion of next.criteria) {
    if (!criterion.checkedRevision || !criterion.evidence) continue;
    const hash = digest(criterion.evidence);
    if (previous && criterion.state === 'passed' && next.requirementsRevision > 1) {
      const prior = existing.get(scopeId, recordKey, generation, hash) as
        {first_requirements_revision: number} | undefined;
      const retained = previous.criteria.some(c => c.key === criterion.key && c.state === 'passed' &&
        c.checkedRevision === criterion.checkedRevision && c.evidence === criterion.evidence);
      if (prior && prior.first_requirements_revision < next.requirementsRevision && !retained)
        return failProjectRevision('work_evidence_revision_required', recordRevision, previous);
    }
    insert.run(scopeId, recordKey, generation, hash, criterion.checkedRevision);
  }
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
            validUntil: op.validUntil == null ? null : date(op.validUntil, true),
            ...(op.detail === undefined ? {} : {detail:factDetail(op,source)}),
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
    containsMemoryCredentials((body as { value: string }).value)
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
          record: currentRecord(db, readRow(db, scopeId, prior.record_key), now),
          revision: prior.applied_revision,
          replayed: true,
        };
      }
      if (source.metadataTurn && op.kind !== 'project_upsert') return fail('project_names_require_direct_source');
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
      if (revision !== op.expectedRevision) {
        const existingWork = op.kind === 'project_upsert' && current?.body_json && !current.forgotten
          ? (JSON.parse(current.body_json).card as MemoryProjectCard).work : undefined;
        return failProjectRevision('revision_conflict', revision, existingWork);
      }
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
      // A global decision or preference is a standing rule for every later
      // turn of this person (global preferences are attached to every
      // prompt). Only the person's own quoted words may create or change one,
      // never an assistant report.
      if (
        op.kind === 'fact_upsert' &&
        dest.projectKey === null &&
        ['decision', 'preference'].includes(
          (body as { factType: string }).factType,
        ) &&
        source.kind !== 'direct_user'
      )
        return fail('global_rule_requires_direct_user', revision);
      let nextBody: unknown = body;
      let changedReadNames = false;
      let namesOnly = false;
      if (op.kind === 'project_activate') {
        if (!current || current.forgotten)
          return fail('project_missing', revision);
        const existing = JSON.parse(current.body_json!);
        nextBody = { ...existing, card: { ...existing.card, status: 'active' } };
      }
      if (op.kind === 'project_upsert') {
        const visible = publicRecord(db, current);
        const existing = visible?.kind === 'project' ? visible.card : null;
        const next = (body as { card: MemoryProjectCard }).card;
        for (const field of ['aliases', 'relatedProjectKeys'] as const) {
          if (next[field] === undefined && existing?.[field]) next[field] = existing[field];
        }
        const commands = projectNamesCommands(dest.projectKey!, existing, next);
        changedReadNames = commands.length > 0;
        if (source.metadataTurn && !changedReadNames) return fail('project_names_require_direct_source', revision);
        if (changedReadNames) {
          if (!exactMetadataConsent(source, commands)) return fail('project_names_require_direct_source', revision);
          namesOnly = existing !== null && isDeepStrictEqual(ordinaryProjectFields(existing), ordinaryProjectFields(next));
          if (source.projectNamesOnly && !namesOnly) return fail('project_names_require_direct_source', revision);
        }
        if (next.relatedProjectKeys?.includes(dest.projectKey!)) return fail('invalid_card');
        for (const targetKey of next.relatedProjectKeys ?? []) {
          const linked = readRow(db, scopeId, JSON.stringify(['project', targetKey, targetKey]));
          if (!linked || linked.forgotten) return fail('related_project_missing', revision);
        }
        if (changedReadNames) {
          const proof = projectNameProof(db, scopeId, source);
          if (!proof) return fail('project_names_require_direct_source', revision);
          const carry = current && confirmedProjectMetadata(db, current);
          const names: ProjectReadMetadata = {
            aliases: (next.aliases ?? []).map(name => carry?.aliases.find(alias => alias.name === name) ?? {name, proof}),
            links: (next.relatedProjectKeys ?? []).map(key => carry?.links.find(link => link.key === key)
              ?? {key, epoch: linkedProjectEpoch(db, scopeId, key), proof}),
          };
          if (names.aliases.length || names.links.length) {
            db.prepare(`INSERT INTO memory_project_read_metadata(scope_key,project_key,project_epoch,metadata_json)
              VALUES (?,?,?,?) ON CONFLICT(scope_key,project_key) DO UPDATE SET
              project_epoch=excluded.project_epoch,metadata_json=excluded.metadata_json`)
              .run(scopeId, dest.projectKey, linkedProjectEpoch(db, scopeId, dest.projectKey!), JSON.stringify(names));
          } else {
            db.prepare('DELETE FROM memory_project_read_metadata WHERE scope_key=? AND project_key=?').run(scopeId, dest.projectKey);
          }
        }
        nextBody = {card: ordinaryProjectFields(next)};
        if (Buffer.byteLength(JSON.stringify(next)) > 32768) return fail('card_too_large');
        try { validateMemoryWorkTransition(existing?.work, next.work); }
        catch (error) { return failProjectRevision((error as Error).message, revision, existing?.work); }
        if (next.work)
          rememberWorkCheckEvidence(db, scopeId, dest.recordKey, revision, existing?.work, next.work);
        if (
          (current?.forgotten ||
            existing?.status === 'completed' ||
            existing?.status === 'cancelled') &&
          ['active', 'waiting'].includes(next.status)
        )
          return fail('activation_required', revision);
        if (
          source.kind === 'assistant_report' &&
          current?.direct_at &&
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
          source.kind === 'direct_user' && !namesOnly ? src.at : (old?.direct_at ?? null);
        const directId =
          source.kind === 'direct_user' && !namesOnly
            ? (src.messageId ?? null)
            : (old?.direct_message_id ?? null);
        const bodyJson = forgotten ? null : JSON.stringify(value),
          sourceJson = forgotten ? null : namesOnly && old ? old.source_json : JSON.stringify(
            source.kind === 'direct_user' && source.messageContentSha256
              ? { ...src, messageContentSha256: source.messageContentSha256, messageEditRevision: source.messageEditRevision, messageBindingHash: source.messageBindingHash } : src,
          );
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
        db.prepare('DELETE FROM memory_work_check_runs WHERE scope_key=? AND record_key=?').run(scopeId, dest.recordKey);
        db.prepare('DELETE FROM memory_project_read_metadata WHERE scope_key=? AND project_key=?').run(scopeId, dest.projectKey);
        // Erase incoming key references on a current writer. Lifetime checks
        // also protect a later re-open after an older binary performed a forget.
        db.prepare(`UPDATE memory_project_read_metadata SET metadata_json=json_set(metadata_json,'$.links',
          (SELECT json_group_array(json(edge.value)) FROM json_each(metadata_json,'$.links') edge
            WHERE json_extract(edge.value,'$.key')<>?))
          WHERE scope_key=? AND EXISTS(SELECT 1 FROM json_each(metadata_json,'$.links') edge
            WHERE json_extract(edge.value,'$.key')=?)`).run(dest.projectKey, scopeId, dest.projectKey);
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
          (op.kind === 'project_upsert' && !changedReadNames &&
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
        record: currentRecord(db, readRow(db, scopeId, dest.recordKey), now),
        revision: appliedRevision,
        replayed: false,
      };
    })
    .immediate();
}

export interface MemoryStateSearchHit {
  kind: 'project' | 'fact';
  projectKey: string | null;
  key: string;
  revision: number;
  updatedAt: string;
  factType?: MemoryFactType;
  /** The card's title; for a fact, the title of its project. */
  title?: string;
  /** The card's status; for a fact, its project's status; null when global. */
  status: MemoryProjectCard['status'] | null;
  /** Completed or cancelled work: shown to the model as «do not resume». */
  closed: boolean;
  excerpt: string;
  matchedTerms: number;
  relatedHistory?: true;
}
export interface MemoryStateSearchResult {
  results: MemoryStateSearchHit[];
  terms: number;
  scanned: number;
}
const SEARCH_EXCERPT_CHARS = 300;
const SEARCH_STOP_WORDS = new Set(
  (
    'что как где когда кто какой какая какие который это эта эти этот тот для про при или еще уже ' +
    'надо нужно пожалуйста найди найти покажи вспомни есть был была были будет мне меня мой наш ' +
    'скуби skoobi the and for with from that this what which how are was were you your'
  ).split(' '),
);
function searchForm(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е');
}
function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const word of searchForm(query.normalize('NFKC')).match(
    /[\p{L}\p{N}]+/gu,
  ) ?? []) {
    if (word.length < 3 || SEARCH_STOP_WORDS.has(word)) continue;
    const stem = memorySearchStem(word);
    if (!terms.includes(stem)) terms.push(stem);
    if (terms.length >= 16) break;
  }
  return terms;
}
/** At most `max` characters, ellipses included, around the first hit. */
function searchExcerpt(text: string, terms: string[], max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const width = max - 2;
  const form = searchForm(clean);
  let start = 0;
  if (form.length === clean.length) {
    const first = Math.min(
      ...terms.map((term) => form.indexOf(term)).filter((at) => at >= 0),
    );
    if (Number.isFinite(first))
      start = Math.max(
        0,
        Math.min(first - Math.floor(width / 3), clean.length - width),
      );
  }
  let end = start + width;
  // Never cut a surrogate pair (emoji) in half at the window edges.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(clean[start])) start += 1;
  if (end < clean.length && /[\uD800-\uDBFF]/.test(clean[end - 1])) end -= 1;
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
}

/**
 * Word search over the current facts and project cards of exactly one
 * authenticated scope (chat + person + tenant). memory_search used to read
 * only files, while decisions and task state went to this store
 * (week review, W07). Matching ignores case and ё/е and finds word
 * forms by a crude stem; a card matches by key, title, goal, steps, waiting
 * note and work checkpoint. `projectKey` narrows to one project (its card and
 * facts), `null` to the global facts. Expired facts and forgotten records are
 * never returned; closed cards are marked so the model does not resume them.
 */
export function searchMemoryState(
  db: Database.Database,
  scope: MemoryStateScope,
  options: {
    query: string;
    reviewSearchHit?: (hit: MemoryStateSearchHit, record: MemoryStateRecord) => MemoryStateSearchHit;
    projectKey?: string | null;
    limit?: number;
    now?: string;
  },
): MemoryStateSearchResult {
  const scopeId = scopeKey(scope),
    now = date(options.now ?? new Date().toISOString());
  const namespace =
    options.projectKey === undefined
      ? undefined
      : options.projectKey === null
        ? ''
        : key(options.projectKey);
  const limit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 8)));
  if (!Number.isFinite(limit)) return fail('invalid_limit');
  const terms = searchTerms(text(options.query, 500));
  const rows = db
    .prepare(
      `SELECT * FROM memory_state_records WHERE scope_key=? AND forgotten=0 AND body_json IS NOT NULL ${namespace === undefined ? '' : 'AND project_key=?'} ORDER BY updated_at DESC,record_key LIMIT ?`,
    )
    .all(
      scopeId,
      ...(namespace === undefined ? [] : [namespace]),
      LIMIT_RECORDS,
    ) as Row[];
  const records = rows
    .map((row) => currentRecord(db, row, now))
    .filter((record): record is MemoryStateRecord => record !== null);
  const result: MemoryStateSearchResult = {
    results: [],
    terms: terms.length,
    scanned: records.length,
  };
  if (!terms.length) return result;
  const cards = new Map<string, MemoryProjectCard>();
  for (const record of records)
    if (record.kind === 'project') cards.set(record.projectKey, record.card);
  // A fact of a project outside this namespace page still shows its status.
  const cardOf = (projectKey: string): MemoryProjectCard | undefined => {
    if (cards.has(projectKey)) return cards.get(projectKey);
    const row = readRow(
      db,
      scopeId,
      JSON.stringify(['project', projectKey, projectKey]),
    );
    const record = publicRecord(db, row);
    const card = record?.kind === 'project' ? record.card : undefined;
    if (card) cards.set(projectKey, card);
    return card;
  };
  const visibleProjects = records.filter((r): r is Extract<MemoryStateRecord, { kind: 'project' }> => r.kind === 'project');
  const { projects: matched, restricted } = memoryReadProjectRequest(visibleProjects, options.query);
  if (restricted && !matched.length) return result;
  const primary = matched.length === 1 ? matched[0] : undefined;
  const linked = new Set(!restricted && primary && namespace === undefined
    ? linkedMemoryReadProjects(primary, visibleProjects).map(p => p.projectKey) : []);
  const candidateKeys = new Set(matched.map(p => p.projectKey));
  const required =
    terms.length <= 2 ? 1 : Math.max(1, Math.ceil(terms.length / 3));
  const scored: Array<{ hit: MemoryStateSearchHit; record: MemoryStateRecord; score: number }> = [];
  for (const record of records) {
    const names =
      record.kind === 'project'
        ? [record.projectKey, record.card.title]
        : [record.projectKey ?? '', record.key];
    const fields =
      record.kind === 'project'
        ? [
            record.card.title,
            record.card.goal,
            ...record.card.pending,
            ...record.card.completed,
            record.card.waiting ?? '',
            record.card.work?.target ?? '',
            record.card.work?.nextStep ?? '',
          ]
        : [record.value];
    const nameForm = searchForm(names.join(' '));
    const forms = fields.map(searchForm);
    const hits = terms.filter(
      (term) =>
        nameForm.includes(term) || forms.some((form) => form.includes(term)),
    );
    const primaryNameMatch = record.projectKey !== null && candidateKeys.has(record.projectKey);
    const historyNameMatch = record.projectKey !== null && linked.has(record.projectKey);
    if (restricted && !primaryNameMatch) continue;
    if (matched.length > 1 && (!primaryNameMatch || record.kind !== 'project')) continue;
    if (namespace === undefined && primary && !primaryNameMatch && !historyNameMatch) continue;
    if (!primaryNameMatch && !historyNameMatch && hits.length < required) continue;
    const nameHits = terms.filter((term) => nameForm.includes(term)).length;
    let best = 0;
    let bestHits = -1;
    fields.forEach((field, index) => {
      const count = terms.filter((term) => forms[index].includes(term)).length;
      if (field.trim() && count > bestHits) {
        best = index;
        bestHits = count;
      }
    });
    const card =
      record.kind === 'project'
        ? record.card
        : record.projectKey
          ? cardOf(record.projectKey)
          : undefined;
    const title = card?.title;
    const prefix =
      record.kind === 'project' && best !== 0 ? `${record.card.title}: ` : '';
    const excerpt = searchExcerpt(
      `${prefix}${fields[best] ?? ''}`,
      terms,
      SEARCH_EXCERPT_CHARS,
    );
    const status = card?.status ?? null;
    scored.push({
      record,
      score: hits.length + nameHits * 0.5 + (primaryNameMatch ? (record.kind === 'project' ? 6 : 5) : historyNameMatch ? 1 : 0),
      hit: {
        kind: record.kind,
        projectKey: record.projectKey,
        key: record.key,
        revision: record.revision,
        updatedAt: record.updatedAt,
        ...(record.kind === 'fact' ? { factType: record.factType } : {}),
        ...(title ? { title } : {}),
        status,
        closed: status === 'completed' || status === 'cancelled',
        excerpt,
        matchedTerms: hits.length,
        ...(historyNameMatch ? { relatedHistory: true as const } : {}),
      },
    });
  }
  result.results = scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.hit.updatedAt.localeCompare(a.hit.updatedAt) ||
        a.hit.key.localeCompare(b.hit.key),
    )
    .slice(0, limit)
    .map(item => options.reviewSearchHit?.(item.hit, item.record) ?? item.hit);
  return result;
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
    .prepare('SELECT project_key,source_at,source_message_id FROM memory_state_focus WHERE scope_key=?')
    .get(scopeId) as { project_key: string | null; source_at: string; source_message_id: string | null } | undefined;
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
          kind === 'project' ? limit + 1 : limit,
        ) as Row[],
  );
  const listing: MemoryStateListing = {
    projects: [],
    facts: [],
    tombstones: [],
    expired: [],
    hasTombstones: false,
    focusedProjectKey: focus?.project_key ?? null,
    ...(focus?.source_message_id && focus.project_key ? { focusedSourceAt: focus.source_at, focusedSourceId: focus.source_message_id } : {}),
  };
  for (const row of rows) {
    const record = publicRecord(db, row);
    if (!record) continue;
    if (record.kind === 'project') {
      if (listing.projects.length < limit) listing.projects.push(record);
      else listing.projectsTruncated = true;
    }
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

/** A focus may survive a background report; its original direct citation
 * must still exist in the bounded version history before continuing on it. */
export function focusSourceCitation(db: Database.Database, scope: MemoryStateScope, listing: MemoryStateListing): {quote:string; digest:string|null; editRevision:number|null; bindingHash:string|null} | undefined {
  if (!listing.focusedProjectKey || !listing.focusedSourceId || !listing.focusedSourceAt) return;
  const row = db.prepare(`SELECT json_extract(source_json,'$.quote') AS quote, json_extract(source_json,'$.messageContentSha256') AS digest,
    json_extract(source_json,'$.messageEditRevision') AS editRevision, json_extract(source_json,'$.messageBindingHash') AS bindingHash FROM memory_state_versions
    WHERE scope_key=? AND record_key=? AND forgotten=0 AND json_extract(source_json,'$.kind')='direct_user'
    AND json_extract(source_json,'$.at')=? AND json_extract(source_json,'$.messageId')=?
    ORDER BY revision DESC LIMIT 1`).get(scopeKey(scope),
      JSON.stringify(['project', listing.focusedProjectKey, listing.focusedProjectKey]),
      listing.focusedSourceAt, listing.focusedSourceId) as {quote:string; digest:string|null; editRevision:number|null; bindingHash:string|null} | undefined;
  return row?.quote ? row : undefined;
}

/** For a large namespace, check all live names within the store's existing
 * scope budget. Fetch full bodies only for prompt candidates and their links. */
export function listPromptMemoryState(db: Database.Database, scope: MemoryStateScope, query: string, now: string): MemoryStateListing {
  const listing = listMemoryState(db, scope, { now, limit: 200 });
  if (!listing.projectsTruncated) return listing;
  const scopeId = scopeKey(scope);
  const metadata = hasProjectMetadata(db);
  const names = db.prepare(`SELECT p.project_key, json_extract(p.body_json,'$.card.title') AS title,
    ${metadata ? "json_extract(n.metadata_json,'$.aliases')" : 'NULL'} AS aliases FROM memory_state_records p
    ${metadata ? `LEFT JOIN memory_state_tombstones t ON t.scope_key=p.scope_key AND t.record_key=p.record_key
      LEFT JOIN memory_project_read_metadata n ON n.scope_key=p.scope_key AND n.project_key=p.project_key
        AND n.project_epoch=COALESCE(t.revision,0)` : ''}
    WHERE p.scope_key=? AND p.kind='project' AND p.forgotten=0 AND p.body_json IS NOT NULL
    ORDER BY p.project_key LIMIT ?`).all(scopeId, LIMIT_RECORDS + 1) as Array<{project_key: string; title: string; aliases: string | null}>;
  if (names.length > LIMIT_RECORDS) return listing;
  const verified = proofReader(db, scopeId);
  const targets = matchMemoryReadProjects(names.map(row => ({projectKey: row.project_key,
    card: {title: row.title, aliases: row.aliases ? savedAliasNames(JSON.parse(row.aliases), verified) : undefined},
  })), query);
  const keys = targets.slice(0, 4).map(p => p.projectKey);
  if (!targets.length && listing.focusedProjectKey) keys.push(listing.focusedProjectKey);
  const fetchProjects = (names: string[]) => names.flatMap(projectKey => {
    const record = publicRecord(db, readRow(db, scopeId, JSON.stringify(['project', projectKey, projectKey])));
    return record?.kind === 'project' ? [record] : [];
  });
  listing.projects = fetchProjects(keys);
  if (listing.projects.length === 1) {
    listing.projects.push(...fetchProjects(listing.projects[0].card.relatedProjectKeys ?? []));
  }
  listing.projectsTruncated = targets.length > keys.length;
  return listing;
}

/** Supplement a full scope-wide page from the exact, currently visible read
 * route. Each project gets its own budget, including explicit one-hop history. */
export function appendPromptProjectFacts(
  db: Database.Database,
  scope: MemoryStateScope,
  listing: MemoryStateListing,
  projectKeys: readonly string[],
  now: string,
): void {
  if (!projectKeys.length) return;
  const scopeId = scopeKey(scope);
  const read = db.prepare(`SELECT * FROM memory_state_records
    WHERE scope_key=? AND project_key=? AND kind='fact' AND forgotten=0 AND body_json IS NOT NULL
      AND (json_extract(body_json,'$.validUntil') IS NULL OR json_extract(body_json,'$.validUntil')>?)
    ORDER BY (json_extract(source_json,'$.kind')='direct_user') DESC,
      (json_extract(body_json,'$.factType')='decision') DESC, updated_at DESC,record_key
    LIMIT 10`);
  const listed = new Set(listing.facts.map(f => JSON.stringify([f.projectKey, f.key])));
  for (const projectKey of projectKeys.slice(0, 4)) {
    const rows = read.all(scopeId, projectKey, now) as Row[];
    for (const row of rows) {
      const fact = currentRecord(db, row, now);
      if (fact?.kind === 'fact' && !listed.has(JSON.stringify([fact.projectKey, fact.key])))
        listing.facts.push(fact);
    }
  }
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
    const project = publicRecord(db,
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
      const record = publicRecord(db, readRow(db, scopeId, position.record_key));
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
