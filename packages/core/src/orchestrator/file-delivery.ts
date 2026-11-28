import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/** A channel acknowledgement is not a human read receipt. No host paths here. */
export interface FileDeliveryReceipt {
  deliveryId: string;
  state: 'checking' | 'sending' | 'delivered' | 'blocked' | 'unknown';
  code: string;
  artifact: { name: string; sha256: string | null; bytes: number | null };
  acknowledgedAt?: string;
}
export interface FileDeliveryScope {
  sourceGroup: string;
  chatJid: string;
  ownerAuthorized?: boolean;
}
export interface FileTransportResult {
  state: 'delivered' | 'blocked' | 'unknown';
  code: string;
  sha256?: string;
}
interface Row {
  id: string;
  scope: string;
  origin_attempt: string | null;
  fingerprint: string;
  state: FileDeliveryReceipt['state'];
  code: string;
  name: string;
  sha256: string;
  bytes: number;
  updated_at: number;
  acknowledged_at: number | null;
  owner: string;
}
const processOwner = randomUUID();
const active = new Set<string>();
const RECENT_ACK_MS = 30 * 60_000;
const MAX_SCOPE_RECORDS = 2000;
const validId = (id: string) =>
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id);
const scopeKey = (s: FileDeliveryScope) =>
  createHash('sha256')
    .update(
      JSON.stringify([s.sourceGroup, s.chatJid, s.ownerAuthorized === true]),
    )
    .digest('hex');
function exists(db: Database.Database): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_delivery_receipts'",
    )
    .get();
}
function schema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS file_delivery_receipts (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, origin_attempt TEXT, fingerprint TEXT NOT NULL,
    state TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL, acknowledged_at INTEGER, owner TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS file_delivery_scope_hash ON file_delivery_receipts(scope,sha256);
  CREATE INDEX IF NOT EXISTS file_delivery_attempt ON file_delivery_receipts(origin_attempt,scope);
    CREATE TABLE IF NOT EXISTS file_delivery_attempts (delivery_id TEXT NOT NULL, scope TEXT NOT NULL, attempt TEXT NOT NULL, PRIMARY KEY(delivery_id,scope,attempt));`);
}
function publicRow(row: Row): FileDeliveryReceipt {
  const interrupted =
    ['checking', 'sending'].includes(row.state) &&
    (row.owner !== processOwner || !active.has(row.id));
  return {
    deliveryId: row.id,
    state: interrupted ? 'unknown' : row.state,
    code: interrupted ? 'interrupted_inspect_before_retry' : row.code,
    artifact: {
      name: row.name,
      sha256: row.sha256 || null,
      bytes: row.sha256 ? row.bytes : null,
    },
    ...(row.acknowledged_at
      ? { acknowledgedAt: new Date(row.acknowledged_at).toISOString() }
      : {}),
  };
}

/** Read-only, including after restart. Does not create a table or change state. */
export function readFileDelivery(
  db: Database.Database,
  scope: FileDeliveryScope,
  deliveryId: string,
): FileDeliveryReceipt | null {
  if (!validId(deliveryId) || !exists(db)) return null;
  const row = db
    .prepare('SELECT * FROM file_delivery_receipts WHERE id=? AND scope=?')
    .get(deliveryId, scopeKey(scope)) as Row | undefined;
  return row ? publicRow(row) : null;
}

/** Final-answer host guard: exact original attempt only, never a current-chat fallback. */
export function reconcileFileDeliveryFinal(
  db: Database.Database,
  scope: FileDeliveryScope,
  originAttempt: string,
): FileDeliveryReceipt[] {
  if (!validId(originAttempt) || !exists(db)) return [];
  return (
    db
      .prepare(
        `SELECT r.* FROM file_delivery_receipts r WHERE r.scope IN (?,?) AND
    (r.origin_attempt=? OR EXISTS (SELECT 1 FROM file_delivery_attempts a WHERE a.delivery_id=r.id AND a.scope=r.scope AND a.attempt=?))
    ORDER BY r.updated_at LIMIT 100`,
      )
      .all(
        scopeKey({ ...scope, ownerAuthorized: false }),
        scopeKey({ ...scope, ownerAuthorized: true }),
        originAttempt,
        originAttempt,
      ) as Row[]
  ).map(publicRow);
}

/** One host process owns execution. The DB is a receipt journal, not a new queue.
 * Unknown sends cannot be retried, even under a different request id/path. */
export async function deliverFileOnce(input: {
  db: Database.Database;
  scope: FileDeliveryScope;
  deliveryId: string;
  originAttempt?: string;
  artifact: { name: string; sha256: string; bytes: number };
  caption?: string;
  /** Caller checks the existing host authorization for an explicit resend. */
  authorizedResend?: boolean;
  now?: () => number;
  send: (beforeTransport: () => void) => Promise<FileTransportResult>;
}): Promise<FileDeliveryReceipt> {
  const { db, artifact } = input;
  const now = input.now ?? Date.now;
  if (
    !validId(input.deliveryId) ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes < 0 ||
    artifact.bytes > 50 * 1024 * 1024 ||
    !artifact.name ||
    artifact.name.length > 255 ||
    /[\\/\0]/.test(artifact.name)
  )
    throw new Error('invalid_delivery_request');
  schema(db);
  const scope = scopeKey(input.scope);
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([artifact.sha256, artifact.bytes, input.caption ?? '']),
    )
    .digest('hex');
  const reserved = db.transaction((): { row: Row; execute: boolean } => {
    // Keep ambiguous receipts. Storage pressure must never authorize a repost.
    db.prepare(
      "DELETE FROM file_delivery_receipts WHERE scope=? AND state IN ('delivered','blocked') AND updated_at<?",
    ).run(scope, now() - 30 * 86400_000);
    db.prepare(
      'DELETE FROM file_delivery_attempts WHERE scope=? AND delivery_id NOT IN (SELECT id FROM file_delivery_receipts)',
    ).run(scope);
    const old = db
      .prepare('SELECT * FROM file_delivery_receipts WHERE id=?')
      .get(input.deliveryId) as Row | undefined;
    if (old) {
      if (
        old.scope !== scope ||
        (old.sha256 !== '' && old.fingerprint !== fingerprint)
      )
        throw new Error('delivery_id_conflict');
      if (old.state !== 'blocked' || active.has(old.id))
        return { row: old, execute: false };
    }
    const same = db
      .prepare(
        "SELECT * FROM file_delivery_receipts WHERE scope=? AND sha256=? AND id<>? AND (state IN ('checking','sending','unknown') OR (state='delivered' AND updated_at>?)) ORDER BY updated_at DESC LIMIT 1",
      )
      .get(
        scope,
        artifact.sha256,
        input.deliveryId,
        input.authorizedResend
          ? Number.MAX_SAFE_INTEGER
          : now() - RECENT_ACK_MS,
      ) as Row | undefined;
    if (same) return { row: same, execute: false };
    if (
      !old &&
      (
        db
          .prepare(
            'SELECT count(*) n FROM file_delivery_receipts WHERE scope=?',
          )
          .get(scope) as { n: number }
      ).n >= MAX_SCOPE_RECORDS
    )
      throw new Error('delivery_receipt_limit');
    db.prepare(
      `INSERT INTO file_delivery_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state='checking',code='checking',updated_at=excluded.updated_at,owner=excluded.owner,sha256=excluded.sha256,bytes=excluded.bytes,name=excluded.name,fingerprint=excluded.fingerprint`,
    ).run(
      input.deliveryId,
      scope,
      input.originAttempt ?? null,
      fingerprint,
      'checking',
      'checking',
      artifact.name,
      artifact.sha256,
      artifact.bytes,
      now(),
      null,
      processOwner,
    );
    return {
      row: db
        .prepare('SELECT * FROM file_delivery_receipts WHERE id=?')
        .get(input.deliveryId) as Row,
      execute: true,
    };
  })();
  if (input.originAttempt && validId(input.originAttempt))
    db.prepare(
      'INSERT OR IGNORE INTO file_delivery_attempts VALUES(?,?,?)',
    ).run(reserved.row.id, scope, input.originAttempt);
  if (!reserved.execute) return publicRow(reserved.row);
  active.add(input.deliveryId);
  let started = false;
  try {
    const result = await input.send(() => {
      db.prepare(
        "UPDATE file_delivery_receipts SET state='sending',code='awaiting_channel_ack',updated_at=? WHERE id=? AND owner=? AND state='checking'",
      ).run(now(), input.deliveryId, processOwner);
      started = true;
    });
    if (result.sha256 && result.sha256 !== artifact.sha256)
      throw new Error('transport_artifact_changed');
    const state =
      result.state === 'delivered' && !started ? 'unknown' : result.state;
    db.prepare(
      'UPDATE file_delivery_receipts SET state=?,code=?,updated_at=?,acknowledged_at=? WHERE id=? AND owner=?',
    ).run(
      state,
      result.code,
      now(),
      state === 'delivered' ? now() : null,
      input.deliveryId,
      processOwner,
    );
  } catch {
    db.prepare(
      'UPDATE file_delivery_receipts SET state=?,code=?,updated_at=? WHERE id=? AND owner=?',
    ).run(
      started ? 'unknown' : 'blocked',
      started ? 'channel_outcome_unknown' : 'delivery_preflight_failed',
      now(),
      input.deliveryId,
      processOwner,
    );
  } finally {
    active.delete(input.deliveryId);
  }
  return readFileDelivery(db, input.scope, input.deliveryId)!;
}

/** Preserve a known pre-transport rejection even when file bytes are unavailable. */
export function recordFileDeliveryRejection(input: {
  db: Database.Database;
  scope: FileDeliveryScope;
  deliveryId: string;
  originAttempt?: string;
  name: string;
  code: string;
}): FileDeliveryReceipt {
  if (!validId(input.deliveryId)) throw new Error('invalid_delivery_id');
  schema(input.db);
  const scope = scopeKey(input.scope);
  const old = input.db
    .prepare('SELECT * FROM file_delivery_receipts WHERE id=?')
    .get(input.deliveryId) as Row | undefined;
  if (old && old.scope !== scope) throw new Error('delivery_id_conflict');
  if (!old) {
    if (
      (
        input.db
          .prepare(
            'SELECT count(*) n FROM file_delivery_receipts WHERE scope=?',
          )
          .get(scope) as { n: number }
      ).n >= MAX_SCOPE_RECORDS
    )
      throw new Error('delivery_receipt_limit');
    const name =
      input.name.replace(/[\\/\0\r\n]/g, '_').slice(0, 255) || 'file';
    input.db
      .prepare(
        'INSERT INTO file_delivery_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        input.deliveryId,
        scope,
        input.originAttempt ?? null,
        'unavailable',
        'blocked',
        input.code,
        name,
        '',
        0,
        Date.now(),
        null,
        processOwner,
      );
  }
  if (input.originAttempt && validId(input.originAttempt))
    input.db
      .prepare('INSERT OR IGNORE INTO file_delivery_attempts VALUES(?,?,?)')
      .run(input.deliveryId, scope, input.originAttempt);
  return readFileDelivery(input.db, input.scope, input.deliveryId)!;
}
