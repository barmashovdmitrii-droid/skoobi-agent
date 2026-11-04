import { createHash, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  cosineSimilarity,
  validEmbedding,
  type SemanticEncoder,
} from '@skoobi/memory/semantic-retrieval';
import {
  listMemoryState,
  type MemoryStateRecord,
  type MemoryStateScope,
} from './memory-state-store.js';

/** Host configuration, never a scope supplied by a remote model or RPC. */
export interface PeerContextAuthority extends MemoryStateScope {
  networkId: string;
}
export interface PeerContextTask {
  id: string;
  revision: number;
  projectKey: string | null;
  query: string;
  expiresAt: string;
}
export interface PeerContextRecord {
  kind: 'fact' | 'project';
  key: string;
  projectKey: string | null;
  revision: number;
  updatedAt: string;
  validUntil: string | null;
  value: string;
  source: {
    kind: 'direct_user' | 'assistant_report';
    at: string;
    messageRef?: string;
    trust: 'agent_interpreted';
  };
}
export interface PeerTaskContext {
  schema: 1;
  taskId: string;
  revision: number;
  scopeHash: string;
  scopeRevisionHash: string;
  projectKey: string | null;
  createdAt: string;
  expiresAt: string;
  records: PeerContextRecord[];
  sha256: string;
  retrieval: {
    mode: 'lexical' | 'hybrid_partial';
    reason?: 'not_configured' | 'embedding_unavailable';
  };
}
const MAX_BYTES = 64 * 1024;
const MAX_RECORDS = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SECRET =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|парол[ья])\s*[:=]\s*\S+|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|-----BEGIN\s+(?:OPENSSH|RSA|EC|PRIVATE)\s+KEY-----/iu;

export function peerCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(peerCanonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${peerCanonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}
function digest(value: unknown): string {
  return createHash('sha256').update(peerCanonicalJson(value)).digest('hex');
}
function scopeHash(authority: PeerContextAuthority): string {
  for (const value of [
    authority.networkId,
    authority.chatJid,
    authority.tenantId,
    authority.identityId,
  ]) {
    if (typeof value !== 'string' || !value || value.length > 300)
      throw new Error('Invalid peer memory authority');
  }
  return digest([
    authority.networkId,
    authority.chatJid,
    authority.tenantId,
    authority.identityId,
  ]);
}
function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/ё/g, 'е');
}
function project(value: string | null): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,79}$/u.test(value)
  )
    throw new Error('Invalid peer project');
  return value.normalize('NFKC').toLowerCase();
}
function view(row: MemoryStateRecord): PeerContextRecord | null {
  // A remembered permission is historical data, never an execution grant.
  if (row.kind === 'fact' && row.factType === 'permission_note') return null;
  const value =
    row.kind === 'fact'
      ? row.value
      : JSON.stringify({
          title: row.card.title,
          goal: row.card.goal,
          status: row.card.status,
          pending: row.card.pending,
          completed: row.card.completed,
          waiting: row.card.waiting,
          evidence: 'reported_not_verified',
          activatesWork: false,
        });
  if (Buffer.byteLength(value) > 4000 || SECRET.test(value)) return null;
  return {
    kind: row.kind,
    key: row.key,
    projectKey: row.projectKey,
    revision: row.revision,
    updatedAt: row.updatedAt,
    validUntil: row.kind === 'fact' ? row.validUntil : null,
    value,
    source: {
      kind: row.source.kind,
      at: row.source.at,
      ...(row.source.messageId ? { messageRef: row.source.messageId } : {}),
      trust: 'agent_interpreted',
    },
  };
}
function rows(
  db: Database.Database,
  authority: PeerContextAuthority,
  projectKey: string | null,
  now: string,
): MemoryStateRecord[] {
  const global = listMemoryState(db, authority, {
    projectKey: null,
    now,
    limit: 200,
  });
  const scoped =
    projectKey === null
      ? null
      : listMemoryState(db, authority, { projectKey, now, limit: 200 });
  return [
    ...global.facts,
    ...(scoped?.projects ?? []),
    ...(scoped?.facts ?? []),
  ];
}
export function currentPeerScopeRevisionHash(
  db: Database.Database,
  authority: PeerContextAuthority,
  projectKey: string | null,
): string {
  scopeHash(authority);
  projectKey = project(projectKey);
  const scope = JSON.stringify([
    authority.chatJid.trim(),
    authority.identityId.trim(),
    authority.tenantId.trim(),
  ]);
  // Include tombstones and newly added constraints, even when not retrieved.
  // A conservative invalidation is safer than accepting an obsolete result.
  const metadata = db
    .prepare(
      "SELECT record_key,revision,updated_at,forgotten FROM memory_state_records WHERE scope_key=? AND (project_key='' OR project_key=?) ORDER BY record_key LIMIT 4001",
    )
    .all(scope, projectKey ?? '');
  if (metadata.length > 4000)
    throw new Error('Peer memory scope exceeds bound');
  return digest(metadata);
}

/** Reads current scoped rows only. Never exports legacy files, source quotations,
 * other projects, accounts, credentials, reminders or canonical write authority. */
function buildPeerTaskContextSnapshot(
  db: Database.Database,
  authority: PeerContextAuthority,
  task: PeerContextTask,
  options: {
    now?: string;
    recordKeys?: readonly string[];
    rankedRecords?: readonly {
      key: string;
      projectKey: string | null;
      revision: number;
    }[];
    retrieval?: PeerTaskContext['retrieval'];
  } = {},
): PeerTaskContext {
  const now = options.now ?? new Date().toISOString(),
    time = Date.parse(now);
  const expires = Date.parse(task.expiresAt),
    projectKey = project(task.projectKey);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(task.id) ||
    !Number.isSafeInteger(task.revision) ||
    task.revision < 1 ||
    !Number.isFinite(time) ||
    !Number.isFinite(expires) ||
    expires <= time ||
    typeof task.query !== 'string' ||
    task.query.length > 16000
  )
    throw new Error('Invalid peer context task');
  if (
    options.recordKeys &&
    (options.recordKeys.length > 10 ||
      options.recordKeys.some(
        (key) => typeof key !== 'string' || key.length > 80,
      ))
  )
    throw new Error('Invalid peer context request');
  const terms = [
    ...new Set(normalized(task.query).match(/[\p{L}\p{N}]{3,}/gu) ?? []),
  ].slice(0, 32);
  const rank = (row: MemoryStateRecord) =>
    options.rankedRecords?.findIndex(
      (ref) =>
        ref.key === row.key &&
        ref.projectKey === row.projectKey &&
        ref.revision === row.revision,
    ) ?? -1;
  const candidates = rows(db, authority, projectKey, now)
    .filter((row) => {
      if (options.recordKeys?.length)
        return options.recordKeys.includes(row.key);
      if (row.projectKey !== null) return row.projectKey === projectKey;
      return (
        row.kind === 'fact' &&
        (rank(row) >= 0 ||
          row.factType === 'preference' ||
          terms.some((term) =>
            normalized(`${row.key} ${row.value}`).includes(term),
          ))
      );
    })
    .map((row) => ({ row, record: view(row) }))
    .filter(
      (entry): entry is { row: MemoryStateRecord; record: PeerContextRecord } =>
        entry.record !== null,
    );
  candidates.sort((a, b) => {
    const score = (entry: typeof a) =>
      (rank(entry.row) >= 0 ? 100 - rank(entry.row) : 0) +
      (entry.row.projectKey === projectKey && projectKey !== null ? 20 : 0) +
      (entry.row.kind === 'project' ? 10 : 0) +
      terms.filter((term) =>
        normalized(`${entry.record.key} ${entry.record.value}`).includes(term),
      ).length;
    return score(b) - score(a) || a.record.key.localeCompare(b.record.key);
  });
  const body = {
    schema: 1 as const,
    taskId: task.id,
    revision: task.revision,
    scopeHash: scopeHash(authority),
    scopeRevisionHash: currentPeerScopeRevisionHash(db, authority, projectKey),
    projectKey,
    retrieval: options.retrieval ?? {
      mode: 'lexical' as const,
      reason: 'not_configured' as const,
    },
    createdAt: now,
    expiresAt: new Date(Math.min(expires, time + MAX_AGE_MS)).toISOString(),
    records: [] as PeerContextRecord[],
  };
  for (const { record } of candidates.slice(0, MAX_RECORDS)) {
    const next = { ...body, records: [...body.records, record] };
    if (Buffer.byteLength(peerCanonicalJson(next)) > MAX_BYTES - 100) break;
    body.records.push(record);
  }
  return { ...body, sha256: digest(body) };
}

export function buildPeerTaskContext(
  ...args: Parameters<typeof buildPeerTaskContextSnapshot>
): PeerTaskContext {
  return args[0].transaction(() => buildPeerTaskContextSnapshot(...args))();
}

/** Same local embedding engine as main memory. This path never writes canonical
 * memory or caches: it is safe over a readonly database. No cloud fallback. */
export async function buildSemanticPeerTaskContext(
  db: Database.Database,
  authority: PeerContextAuthority,
  task: PeerContextTask,
  options: {
    now?: string;
    encoder?: SemanticEncoder;
    recordKeys?: readonly string[];
  } = {},
): Promise<PeerTaskContext> {
  const baseline = buildPeerTaskContext(db, authority, task, options);
  if (!options.encoder || options.recordKeys?.length) return baseline;
  const encoder = options.encoder;
  if (
    !Number.isSafeInteger(encoder.dimensions) ||
    encoder.dimensions < 1 ||
    encoder.dimensions > 1024
  )
    return baseline;
  const current = rows(
    db,
    authority,
    project(task.projectKey),
    options.now ?? new Date().toISOString(),
  );
  const selectedKeys = new Set(
    baseline.records.map((row) => JSON.stringify([row.projectKey, row.key])),
  );
  const candidates = current
    .filter((row) => row.kind === 'fact' && view(row) !== null)
    .sort(
      (a, b) =>
        Number(selectedKeys.has(JSON.stringify([b.projectKey, b.key]))) -
          Number(selectedKeys.has(JSON.stringify([a.projectKey, a.key]))) ||
        a.key.localeCompare(b.key),
    )
    .slice(0, 64);
  if (!candidates.length) return baseline;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const encode = async () => {
      const vectors = await encoder.encode(
        candidates.map(
          (row) =>
            `${row.key} ${(row as Extract<MemoryStateRecord, { kind: 'fact' }>).value}`,
        ),
        'passage',
      );
      const query = await encoder.encode([task.query.slice(0, 1600)], 'query');
      if (
        vectors.length !== candidates.length ||
        !vectors.every((vector) =>
          validEmbedding(vector, encoder.dimensions),
        ) ||
        query.length !== 1 ||
        !validEmbedding(query[0], encoder.dimensions)
      )
        throw new Error('Invalid local vectors');
      return candidates
        .map((row, index) => ({
          row,
          score: cosineSimilarity(vectors[index], query[0]),
        }))
        .filter((item) => item.score >= 0.72)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((item) => ({
          key: item.row.key,
          projectKey: item.row.projectKey,
          revision: item.row.revision,
        }));
    };
    const rankedRecords = await Promise.race([
      encode(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          encoder.close?.();
          reject(new Error('Local recall timed out'));
        }, 15000);
      }),
    ]);
    // Re-read after asynchronous encoding; changed/forgotten records cannot be
    // reintroduced by detached ranking IDs. Scope revision covers all changes.
    return buildPeerTaskContext(db, authority, task, {
      ...options,
      rankedRecords,
      retrieval: { mode: 'hybrid_partial' },
    });
  } catch {
    return buildPeerTaskContext(db, authority, task, {
      ...options,
      retrieval: { mode: 'lexical', reason: 'embedding_unavailable' },
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A supplementary read is constrained by the original host task scope. */
export function requestPeerTaskContext(
  db: Database.Database,
  authority: PeerContextAuthority,
  task: PeerContextTask,
  request: { query: string; recordKeys?: string[]; reason: string },
  options: { now?: string } = {},
): PeerTaskContext {
  if (
    !request ||
    typeof request.query !== 'string' ||
    request.query.length > 1000 ||
    typeof request.reason !== 'string' ||
    !request.reason.trim() ||
    request.reason.length > 1000
  )
    throw new Error('Invalid peer context request');
  return buildPeerTaskContext(
    db,
    authority,
    { ...task, query: request.query },
    { ...options, recordKeys: request.recordKeys },
  );
}

/** Re-read before acceptance. A correction, forgetting, expiry or identity
 * mismatch invalidates old evidence; no forgotten body is returned. */
export function revalidatePeerTaskContext(
  db: Database.Database,
  authority: PeerContextAuthority,
  task: PeerContextTask,
  context: PeerTaskContext,
  now = new Date().toISOString(),
): {
  valid: boolean;
  reason?: 'invalid' | 'expired' | 'scope' | 'changed';
  changedKeys?: string[];
} {
  try {
    const { sha256, ...body } = context;
    if (
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !timingSafeEqual(
        Buffer.from(sha256, 'hex'),
        Buffer.from(digest(body), 'hex'),
      ) ||
      context.schema !== 1 ||
      context.records.length > MAX_RECORDS ||
      Buffer.byteLength(peerCanonicalJson(context)) > MAX_BYTES ||
      context.taskId !== task.id ||
      context.revision !== task.revision
    )
      return { valid: false, reason: 'invalid' };
    if (
      context.scopeHash !== scopeHash(authority) ||
      context.projectKey !== project(task.projectKey)
    )
      return { valid: false, reason: 'scope' };
    if (
      context.scopeRevisionHash !==
      currentPeerScopeRevisionHash(db, authority, context.projectKey)
    )
      return { valid: false, reason: 'changed' };
    if (
      !Number.isFinite(Date.parse(context.expiresAt)) ||
      Date.parse(context.expiresAt) <= Date.parse(now) ||
      Date.parse(context.createdAt) > Date.parse(now) ||
      Date.parse(context.expiresAt) - Date.parse(context.createdAt) > MAX_AGE_MS
    )
      return { valid: false, reason: 'expired' };
    const current = rows(db, authority, context.projectKey, now)
      .map(view)
      .filter((row): row is PeerContextRecord => row !== null);
    const changedKeys = context.records
      .filter((old) => !current.some((row) => digest(row) === digest(old)))
      .map((row) => row.key);
    return changedKeys.length
      ? { valid: false, reason: 'changed', changedKeys }
      : { valid: true };
  } catch {
    return { valid: false, reason: 'invalid' };
  }
}
