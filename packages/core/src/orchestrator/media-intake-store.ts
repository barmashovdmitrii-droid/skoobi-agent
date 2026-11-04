import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type Database from 'better-sqlite3';
import type { NewMessage } from '@skoobi/shared/channel-types';
import { parseLocalTranscriptionResult, type LocalTranscriptionResult } from '@skoobi/shared/transcription-result';
import {
  MediaIntakePersistenceError,
  type ClaimedMediaIntake,
  type DownloadedMedia,
  type MediaIntakeAdapter,
  type MediaIntakeAttempt,
  type MediaIntakeFailure,
  type MediaIntakeInput,
  type MediaIntakeJob,
  type MediaIntakeLease,
  type MediaIntakeScope,
  type MediaIntakeWorkStage,
  type TranscribedMedia,
} from '@skoobi/shared/media-intake';

const OWNER_ID = randomUUID();
const HOST_KEY = createHash('sha256').update(hostname()).digest('hex');
const DEADLINE_MS = 20 * 60_000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ATTEMPTS = 2;
const TERMINAL = new Set(['materialized', 'cancelled', 'failed']);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const FAILURE_CODES = new Set<MediaIntakeFailure>([
  'transport_timeout',
  'transport_failure',
  'invalid_response',
  'source_unavailable',
  'source_changed',
  'source_too_large',
  'transcription_timeout',
  'transcription_technical_error',
  'storage_failure',
  'deadline_expired',
  'attempts_exhausted',
  'access_revoked',
  'scope_changed',
  'interrupted',
  'transcription_unusable',
  'no_speech',
  'empty',
  'capacity',
]);

export interface MediaIntakeStoreOptions {
  botId: string;
  resolveScope(input: MediaIntakeInput): MediaIntakeScope | undefined;
  isAdmitted(scope: MediaIntakeScope, input: MediaIntakeInput): boolean;
  /** Temporary pause/quota hold; distinct from permission revocation. */
  canProcess?(scope: MediaIntakeScope, input: MediaIntakeInput): boolean;
  /** MUST synchronously use this exact database; production asserts getDb() identity.
   * Called inside the outer transaction for both empty reservation and final input.
   */
  writeMessage(database: Database.Database, message: NewMessage): void;
  now?: () => number;
}
interface Row {
  job_id: string;
  scope_key: string;
  bot_id: string;
  chat_jid: string;
  message_id: string;
  source_hash: string;
  job_json: string;
  stage: MediaIntakeJob['stage'];
  sequence: number;
  revision: number;
  lease_token: string | null;
  owner_id: string | null;
  work_stage: MediaIntakeWorkStage | null;
  work_path: string | null;
  dispatch_pending: number;
  updated_at: number;
}
function persisted<T>(body: () => T): T {
  try {
    return body();
  } catch {
    throw new MediaIntakePersistenceError();
  }
}
function now(options: Pick<MediaIntakeStoreOptions, 'now'>): number {
  const value = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid clock');
  return value;
}
function cursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new Error('Invalid sequence');
  return `i:${String(sequence).padStart(16, '0')}`;
}
function sequence(value: string): number {
  if (
    !/^i:\d{16}$/.test(value) ||
    !Number.isSafeInteger(Number(value.slice(2)))
  )
    throw new Error('Invalid cursor');
  return Number(value.slice(2));
}
function text(value: unknown, max: number, empty = false): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    (empty || value.length > 0) &&
    !value.includes('\0')
  );
}
function scopeKey(scope: MediaIntakeScope): string {
  if (
    ![scope.botId, scope.tenantId, scope.chatJid].every((v) => text(v, 512)) ||
    !text(scope.groupFolder, 128) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(scope.groupFolder)
  )
    throw new Error('Invalid scope');
  return createHash('sha256')
    .update(
      JSON.stringify([
        scope.botId,
        scope.tenantId,
        scope.chatJid,
        scope.groupFolder,
      ]),
    )
    .digest('hex');
}
function normalizeInput(input: MediaIntakeInput): MediaIntakeInput | undefined {
  const m = input?.message,
    media = input?.media;
  if (
    !m ||
    !media ||
    !text(m.id, 256) ||
    !text(m.chat_jid, 512) ||
    !text(m.sender, 256) ||
    !text(m.sender_name, 512, true) ||
    !text(m.timestamp, 64) ||
    !Number.isFinite(Date.parse(m.timestamp)) ||
    !['voice', 'audio'].includes(media.kind) ||
    !text(media.fileId, 2048) ||
    typeof input.isGroup !== 'boolean'
  )
    return undefined;
  if (input.caption !== undefined && !text(input.caption, 4096, true))
    return undefined;
  for (const [value, max] of [
    [media.fileUniqueId, 512],
    [media.fileName, 512],
    [media.mimeType, 256],
    [m.telegram_update_id, 256],
  ] as const) {
    if (value !== undefined && !text(value, max, true)) return undefined;
  }
  if (
    media.declaredBytes !== undefined &&
    (!Number.isSafeInteger(media.declaredBytes) || media.declaredBytes < 0)
  )
    return undefined;
  if (
    media.durationSeconds !== undefined &&
    (!Number.isFinite(media.durationSeconds) || media.durationSeconds < 0)
  )
    return undefined;
  const identity = m.sender_identity;
  if (
    identity &&
    (identity.channel !== 'telegram' ||
      !text(identity.chat_id, 256) ||
      !text(identity.telegram_user_id, 256) ||
      identity.telegram_user_id !== m.sender ||
      !text(identity.identity_id, 512) ||
      typeof identity.is_owner_sender !== 'boolean' ||
      (identity.telegram_message_origin !== undefined &&
        !['direct', 'forwarded', 'quoted'].includes(
          identity.telegram_message_origin,
        )))
  )
    return undefined;
  if (
    identity &&
    [
      identity.bot_id,
      identity.persona_id,
      identity.username_hint,
      identity.display_name_hint,
    ].some((value) => value !== undefined && !text(value, 512, true))
  )
    return undefined;
  const result: MediaIntakeInput = {
    message: {
      id: m.id,
      chat_jid: m.chat_jid,
      sender: m.sender,
      sender_name: m.sender_name,
      timestamp: m.timestamp,
      ...(m.telegram_update_id !== undefined
        ? { telegram_update_id: m.telegram_update_id }
        : {}),
      ...(identity
        ? {
            sender_identity: {
              channel: 'telegram',
              chat_id: identity.chat_id,
              telegram_user_id: identity.telegram_user_id,
              identity_id: identity.identity_id,
              is_owner_sender: identity.is_owner_sender,
              ...(identity.bot_id !== undefined
                ? { bot_id: identity.bot_id }
                : {}),
              ...(identity.persona_id !== undefined
                ? { persona_id: identity.persona_id }
                : {}),
              ...(identity.username_hint !== undefined
                ? { username_hint: identity.username_hint }
                : {}),
              ...(identity.display_name_hint !== undefined
                ? { display_name_hint: identity.display_name_hint }
                : {}),
              ...(identity.telegram_message_origin !== undefined
                ? { telegram_message_origin: identity.telegram_message_origin }
                : {}),
            },
          }
        : {}),
    },
    media: {
      kind: media.kind,
      fileId: media.fileId,
      ...(media.fileUniqueId !== undefined
        ? { fileUniqueId: media.fileUniqueId }
        : {}),
      ...(media.fileName !== undefined ? { fileName: media.fileName } : {}),
      ...(media.mimeType !== undefined ? { mimeType: media.mimeType } : {}),
      ...(media.declaredBytes !== undefined
        ? { declaredBytes: media.declaredBytes }
        : {}),
      ...(media.durationSeconds !== undefined
        ? { durationSeconds: media.durationSeconds }
        : {}),
    },
    ...(input.caption !== undefined ? { caption: input.caption } : {}),
    isGroup: input.isGroup,
  };
  return Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024
    ? result
    : undefined;
}
function job(row: Row): MediaIntakeJob {
  return {
    ...JSON.parse(row.job_json),
    id: row.job_id,
    revision: row.revision,
    stage: row.stage,
    ingestionCursor: cursor(row.sequence),
  };
}
function save(
  db: Database.Database,
  row: Row,
  value: MediaIntakeJob,
  at: number,
): void {
  row.revision++;
  row.stage = value.stage;
  value.revision = row.revision;
  row.job_json = JSON.stringify(value);
  row.updated_at = at;
  db.prepare(
    `UPDATE media_intake_jobs SET revision=?, stage=?, job_json=?, lease_token=?, owner_id=?,
    work_stage=?, work_path=?, dispatch_pending=?, updated_at=? WHERE job_id=?`,
  ).run(
    row.revision,
    row.stage,
    row.job_json,
    row.lease_token,
    row.owner_id,
    row.work_stage,
    row.work_path,
    row.dispatch_pending,
    row.updated_at,
    row.job_id,
  );
}
function claimed(row: Row): ClaimedMediaIntake {
  return {
    job: job(row),
    lease: {
      jobId: row.job_id,
      token: row.lease_token!,
      revision: row.revision,
    },
  };
}
function attempt(row: Row): MediaIntakeAttempt {
  const value = job(row);
  return {
    ...claimed(row),
    stage: row.work_stage!,
    attempt:
      row.work_stage === 'download'
        ? value.downloadAttempts
        : value.transcriptionAttempts,
    deadlineAtMs: value.deadlineAtMs,
    ...(row.work_path ? { destinationRelativePath: row.work_path } : {}),
  };
}
function releaseRow(row: Row): void {
  row.lease_token = null;
  row.owner_id = null;
  row.work_stage = null;
  row.work_path = null;
}

/** Durable control state: failures are fatal to acceptance, unlike diagnostics. */
export function ensureMediaIntakeSchema(db: Database.Database): void {
  persisted(() =>
    db
      .transaction(() =>
        db.exec(`
    CREATE TABLE IF NOT EXISTS media_intake_jobs (
      job_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, bot_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL, message_id TEXT NOT NULL, source_hash TEXT NOT NULL,
      job_json TEXT NOT NULL, stage TEXT NOT NULL, sequence INTEGER NOT NULL,
      revision INTEGER NOT NULL, lease_token TEXT, owner_id TEXT, work_stage TEXT,
      work_path TEXT, dispatch_pending INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      UNIQUE(chat_jid,message_id)
    );
    CREATE INDEX IF NOT EXISTS media_intake_ready ON media_intake_jobs(bot_id,stage,sequence);
    CREATE INDEX IF NOT EXISTS media_intake_chat_order ON media_intake_jobs(chat_jid,sequence);
    CREATE TABLE IF NOT EXISTS media_intake_owners (
      owner_id TEXT PRIMARY KEY, host_key TEXT NOT NULL, pid INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_intake_notices (
      notice_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, bot_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL,
      owner_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      checked_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS media_intake_notices_ready ON media_intake_notices(bot_id,status,created_at);
    CREATE TRIGGER IF NOT EXISTS media_intake_source_delete AFTER DELETE ON messages BEGIN
      UPDATE media_intake_jobs SET stage='cancelled', revision=revision+1, lease_token=NULL,
        owner_id=NULL, work_stage=NULL, work_path=NULL, dispatch_pending=1
        WHERE chat_jid=OLD.chat_jid AND message_id=OLD.id AND stage NOT IN ('materialized','failed','cancelled');
    END;
  `),
      )
      .immediate(),
  );
}
function enqueueNotice(
  db: Database.Database,
  row: Row,
  reason: MediaIntakeFailure,
  at: number,
): void {
  // Capacity bursts share one pending notification per chat, not one send per input.
  if (
    reason === 'capacity' &&
    db
      .prepare(
        "SELECT 1 FROM media_intake_notices WHERE chat_jid=? AND reason='capacity' AND status IN ('pending','sending')",
      )
      .get(row.chat_jid)
  )
    return;
  db.prepare(
    `INSERT OR IGNORE INTO media_intake_notices (notice_id,job_id,bot_id,chat_jid,reason,status,owner_id,created_at,updated_at)
    VALUES(?,?,?,?,?,'pending',NULL,?,?)`,
  ).run(randomUUID(), row.job_id, row.bot_id, row.chat_jid, reason, at, at);
}
function terminalFailure(
  db: Database.Database,
  row: Row,
  reason: MediaIntakeFailure,
  at: number,
  options?: MediaIntakeStoreOptions,
): void {
  const value = job(row);
  let captionPreserved = false;
  if (
    options &&
    value.input.caption?.trim() &&
    !['scope_changed', 'access_revoked', 'source_changed'].includes(reason)
  ) {
    const currentScope = options.resolveScope(value.input);
    if (
      currentScope &&
      scopeKey(currentScope) === row.scope_key &&
      options.isAdmitted(currentScope, value.input)
    ) {
      const kind = value.input.media.kind === 'voice' ? 'Voice' : 'Audio';
      captionPreserved = writeCapturedContent(
        db,
        row,
        value,
        `[${kind} — media unavailable: ${reason}] ${value.input.caption}`,
        options,
      );
    }
  }
  value.stage = 'failed';
  value.failure = reason;
  releaseRow(row);
  row.dispatch_pending = 1;
  save(db, row, value, at);
  if (!captionPreserved) enqueueNotice(db, row, reason, at);
}

function writeCapturedContent(
  db: Database.Database,
  row: Row,
  value: MediaIntakeJob,
  content: string,
  options: MediaIntakeStoreOptions,
): boolean {
  if (
    createHash('sha256').update(JSON.stringify(value.input)).digest('hex') !==
    row.source_hash
  )
    return false;
  // Plain UPDATE respects the reserved ingestion trigger's conflict policy;
  // the existing UPSERT writer then preserves metadata in the same transaction.
  const changed = db
    .prepare(
      `UPDATE messages SET content=? WHERE id=? AND chat_jid=? AND content='' AND sender=?
    AND EXISTS(SELECT 1 FROM message_ingestion WHERE id=? AND chat_jid=? AND sequence=?)`,
    )
    .run(
      content,
      row.message_id,
      row.chat_jid,
      value.input.message.sender,
      row.message_id,
      row.chat_jid,
      row.sequence,
    ).changes;
  if (changed !== 1) return false;
  options.writeMessage(db, message(value, content));
  return true;
}
function ownerDead(db: Database.Database, id: string): boolean {
  const owner = db
    .prepare('SELECT host_key,pid FROM media_intake_owners WHERE owner_id=?')
    .get(id) as { host_key: string; pid: number } | undefined;
  if (
    !owner ||
    owner.host_key !== HOST_KEY ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1 ||
    owner.pid > 2 ** 31 - 1
  )
    return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
function message(value: MediaIntakeJob, content: string): NewMessage {
  return {
    ...value.input.message,
    content,
    is_from_me: false,
    is_bot_message: false,
    tenant_id: value.scope.tenantId,
  };
}
function matchesDownload(
  result: DownloadedMedia,
  expectedPath: string | null,
): boolean {
  return (
    !!result &&
    result.relativePath === expectedPath &&
    DIGEST.test(result.sha256) &&
    Number.isSafeInteger(result.bytes) &&
    result.bytes > 0 &&
    result.bytes <= MAX_BYTES
  );
}

export function createMediaIntakeStore(
  db: Database.Database,
  options: MediaIntakeStoreOptions,
): MediaIntakeAdapter {
  if (!text(options.botId, 512)) throw new MediaIntakePersistenceError();
  const transact = <T>(body: () => T): T =>
    persisted(() => db.transaction(body).immediate());
  const read = (id: string): Row | undefined =>
    UUID.test(id)
      ? (db
          .prepare(
            'SELECT * FROM media_intake_jobs WHERE job_id=? AND bot_id=?',
          )
          .get(id, options.botId) as Row | undefined)
      : undefined;
  const permitted = (row: Row): boolean => {
    const value = job(row),
      scope = options.resolveScope(value.input),
      at = now(options);
    if (
      !scope ||
      scopeKey(scope) !== row.scope_key ||
      scope.botId !== options.botId
    ) {
      terminalFailure(db, row, 'scope_changed', at, options);
      return false;
    }
    if (!options.isAdmitted(scope, value.input)) {
      terminalFailure(db, row, 'access_revoked', at, options);
      return false;
    }
    if (at >= value.deadlineAtMs) {
      terminalFailure(db, row, 'deadline_expired', at, options);
      return false;
    }
    return options.canProcess?.(scope, value.input) !== false;
  };
  const current = (lease: MediaIntakeLease): Row | undefined => {
    if (
      !lease ||
      !UUID.test(lease.token) ||
      !Number.isSafeInteger(lease.revision)
    )
      return undefined;
    const row = read(lease.jobId);
    if (
      !row ||
      TERMINAL.has(row.stage) ||
      row.lease_token !== lease.token ||
      row.owner_id !== OWNER_ID ||
      row.revision !== lease.revision
    )
      return undefined;
    return permitted(row) ? row : undefined;
  };
  const ownsAttempt = (
    lease: MediaIntakeAttempt,
    work: MediaIntakeWorkStage,
  ): Row | undefined => {
    const row = current(lease?.lease);
    return row?.work_stage === work ? row : undefined;
  };
  return {
    accept(raw) {
      return transact(() => {
        const input = normalizeInput(raw);
        if (!input) return { kind: 'rejected', reason: 'source_conflict' };
        const scope = options.resolveScope(input);
        if (
          !scope ||
          scope.botId !== options.botId ||
          scope.chatJid !== input.message.chat_jid ||
          !options.isAdmitted(scope, input)
        )
          return { kind: 'rejected', reason: 'not_admitted' };
        if (
          input.message.sender_identity?.bot_id &&
          input.message.sender_identity.bot_id !== scope.botId
        )
          return { kind: 'rejected', reason: 'source_conflict' };
        const key = scopeKey(scope);
        const sourceHash = createHash('sha256')
          .update(JSON.stringify(input))
          .digest('hex');
        const prior = db
          .prepare(
            'SELECT * FROM media_intake_jobs WHERE chat_jid=? AND message_id=?',
          )
          .get(scope.chatJid, input.message.id) as Row | undefined;
        if (prior) {
          if (prior.scope_key !== key || prior.source_hash !== sourceHash)
            return { kind: 'rejected', reason: 'source_conflict' };
          return prior.stage === 'materialized'
            ? {
                kind: 'already_materialized',
                ingestionCursor: cursor(prior.sequence),
              }
            : { kind: 'duplicate', job: job(prior) };
        }
        // A legacy materialization is not replaced by a replay or a new empty row.
        const existing = db
          .prepare(
            'SELECT content,sender FROM messages WHERE id=? AND chat_jid=?',
          )
          .get(input.message.id, scope.chatJid) as
          | { content: string; sender: string }
          | undefined;
        if (existing) {
          const found = db
            .prepare(
              'SELECT sequence FROM message_ingestion WHERE id=? AND chat_jid=?',
            )
            .get(input.message.id, scope.chatJid) as
            | { sequence: number }
            | undefined;
          if (
            existing.content &&
            existing.sender === input.message.sender &&
            found
          )
            return {
              kind: 'already_materialized',
              ingestionCursor: cursor(found.sequence),
            };
          return { kind: 'rejected', reason: 'source_conflict' };
        }
        const at = now(options),
          id = randomUUID();
        const value: MediaIntakeJob = {
          id,
          revision: 1,
          scope,
          input,
          ingestionCursor: '',
          acceptedAtMs: at,
          deadlineAtMs: at + DEADLINE_MS,
          stage: 'accepted',
          downloadAttempts: 0,
          transcriptionAttempts: 0,
        };
        options.writeMessage(db, message(value, ''));
        db.prepare(
          'INSERT OR IGNORE INTO message_ingestion(id,chat_jid) VALUES(?,?)',
        ).run(input.message.id, scope.chatJid);
        const reserved = db
          .prepare(
            'SELECT sequence FROM message_ingestion WHERE id=? AND chat_jid=?',
          )
          .get(input.message.id, scope.chatJid) as { sequence: number };
        value.ingestionCursor = cursor(reserved.sequence);
        const pending = db
          .prepare(
            "SELECT count(*) AS total, sum(chat_jid=?) AS chat FROM media_intake_jobs WHERE bot_id=? AND stage NOT IN ('materialized','failed','cancelled')",
          )
          .get(scope.chatJid, options.botId) as {
          total: number;
          chat: number | null;
        };
        const capacity = pending.total >= 256 || (pending.chat ?? 0) >= 32;
        if (capacity) {
          value.stage = 'failed';
          value.failure = 'capacity';
        } else if ((input.media.declaredBytes ?? 0) > MAX_BYTES) {
          value.stage = 'failed';
          value.failure = 'source_too_large';
        }
        db.prepare(
          `INSERT INTO media_intake_jobs VALUES(?,?,?,?,?,?,?,?,?,1,NULL,NULL,NULL,NULL,?,?)`,
        ).run(
          id,
          key,
          options.botId,
          scope.chatJid,
          input.message.id,
          sourceHash,
          JSON.stringify(value),
          value.stage,
          reserved.sequence,
          value.stage === 'failed' ? 1 : 0,
          at,
        );
        const row = read(id)!;
        if (value.failure) terminalFailure(db, row, value.failure, at, options);
        return capacity
          ? { kind: 'rejected', reason: 'capacity', job: job(row) }
          : { kind: 'accepted', job: job(row) };
      });
    },
    listReady(limit) {
      return persisted(() => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) return [];
        return (
          db
            .prepare(
              `SELECT j.* FROM media_intake_jobs j WHERE j.bot_id=? AND j.stage NOT IN ('materialized','failed','cancelled')
               AND NOT EXISTS (SELECT 1 FROM media_intake_jobs earlier WHERE earlier.chat_jid=j.chat_jid
                 AND earlier.sequence<j.sequence AND earlier.stage NOT IN ('materialized','failed','cancelled'))
               ORDER BY j.sequence LIMIT ?`,
            )
            .all(options.botId, limit) as Row[]
        ).map(job);
      });
    },
    claim(id) {
      return transact(() => {
        const row = read(id);
        if (!row || TERMINAL.has(row.stage)) return undefined;
        if (row.owner_id && !ownerDead(db, row.owner_id)) return undefined;
        if (!permitted(row)) return undefined;
        const first = db
          .prepare(
            "SELECT job_id FROM media_intake_jobs WHERE chat_jid=? AND stage NOT IN ('materialized','failed','cancelled') ORDER BY sequence LIMIT 1",
          )
          .get(row.chat_jid) as { job_id: string };
        if (first.job_id !== row.job_id) return undefined;
        const value = job(row);
        // A dead owner's in-flight attempt remains charged; neither counters nor deadline reset.
        row.owner_id = OWNER_ID;
        row.lease_token = randomUUID();
        row.work_stage =
          value.preparedDownload && !value.downloaded ? 'download' : null;
        row.work_path =
          row.work_stage === 'download'
            ? value.preparedDownload!.relativePath
            : null;
        db.prepare(
          'INSERT OR IGNORE INTO media_intake_owners VALUES(?,?,?)',
        ).run(OWNER_ID, HOST_KEY, process.pid);
        save(db, row, value, now(options));
        return claimed(row);
      });
    },
    beginAttempt(lease, stage) {
      return transact(() => {
        const row = current(lease);
        if (!row || !['download', 'transcribe'].includes(stage))
          return undefined;
        const value = job(row);
        if (
          stage === 'download' &&
          value.preparedDownload &&
          row.work_stage === 'download'
        )
          return attempt(row);
        if (
          row.work_stage ||
          (stage === 'download'
            ? row.stage !== 'accepted'
            : row.stage !== 'downloaded')
        )
          return undefined;
        const field =
          stage === 'download' ? 'downloadAttempts' : 'transcriptionAttempts';
        if (value[field] >= MAX_ATTEMPTS) {
          terminalFailure(db, row, 'attempts_exhausted', now(options), options);
          return undefined;
        }
        value[field]++;
        row.work_stage = stage;
        row.work_path =
          stage === 'download'
            ? `received/media-intake/${row.job_id}/${randomUUID()}-${value[field]}.media`
            : null;
        save(db, row, value, now(options));
        return attempt(row);
      });
    },
    prepareDownload(proposed, result) {
      return transact(() => {
        const row = ownsAttempt(proposed, 'download');
        if (!row || !matchesDownload(result, row.work_path)) return undefined;
        const value = job(row);
        if (value.preparedDownload)
          return value.preparedDownload.sha256 === result.sha256 &&
            value.preparedDownload.bytes === result.bytes &&
            value.preparedDownload.relativePath === result.relativePath
            ? attempt(row)
            : undefined;
        value.preparedDownload = {
          relativePath: result.relativePath,
          bytes: result.bytes,
          sha256: result.sha256,
        };
        save(db, row, value, now(options));
        return attempt(row);
      });
    },
    checkpointDownload(proposed, result) {
      return transact(() => {
        const row = ownsAttempt(proposed, 'download');
        if (!row || !matchesDownload(result, row.work_path)) return undefined;
        const value = job(row),
          prepared = value.preparedDownload;
        if (
          !prepared ||
          prepared.relativePath !== result.relativePath ||
          prepared.sha256 !== result.sha256 ||
          prepared.bytes !== result.bytes
        )
          return undefined;
        value.downloaded = { ...prepared };
        value.stage = 'downloaded';
        row.work_stage = null;
        row.work_path = null;
        save(db, row, value, now(options));
        return claimed(row);
      });
    },
    checkpointTranscription(proposed, result) {
      return transact(() => {
        const row = ownsAttempt(proposed, 'transcribe');
        if (!row) return undefined;
        const value = job(row);
        if (
          !value.downloaded ||
          result?.sourceSha256 !== value.downloaded.sha256 ||
          (result.text !== null &&
            (typeof result.text !== 'string' ||
              Buffer.byteLength(result.text) > 64 * 1024)) ||
          (result.unusableReason !== undefined &&
            ![
              'empty',
              'no_speech',
              'invalid_transcript',
              'transcription_unavailable',
            ].includes(result.unusableReason))
        )
          return undefined;
        const detail = result.result === undefined ? undefined : parseLocalTranscriptionResult(result.result);
        if (result.result !== undefined && (!detail || detail.text !== result.text)) return undefined;
        if (detail) {
          const evidence = value.transcriptionAttemptsEvidence ?? [];
          if (evidence.length >= MAX_ATTEMPTS) return undefined;
          value.transcriptionAttemptsEvidence = [...evidence, detail];
          if (detail.status === 'cancelled') {
            value.stage = 'cancelled';
            releaseRow(row);
            row.dispatch_pending = 1;
            save(db, row, value, now(options));
            return { job: job(row), lease: { ...proposed.lease, revision: row.revision } };
          }
          if (detail.status === 'technical_error') {
            const retry = detail.error?.retryable === true && value.transcriptionAttempts < MAX_ATTEMPTS;
            if (retry) {
              releaseRow(row);
              save(db, row, value, now(options));
            } else {
              // Persist evidence inside this transaction before the common
              // terminal path reloads the authoritative row for caption handling.
              save(db, row, value, now(options));
              terminalFailure(db, row, detail.error?.code === 'process_timeout'
                ? 'transcription_timeout' : 'transcription_technical_error', now(options), options);
            }
            // Returned evidence is a checkpoint receipt. This old token has
            // been released and grants no continuation or new attempt.
            return { job: job(row), lease: { ...proposed.lease, revision: row.revision } };
          }
        }
        value.transcribed = {
          text: result.text?.trim() ? result.text : null,
          sourceSha256: result.sourceSha256,
          ...(detail?.status === 'empty'
            ? { unusableReason: detail.emptyReason! }
            : result.unusableReason
            ? { unusableReason: result.unusableReason }
            : {}),
          ...(detail ? { result: detail } : {}),
        };
        value.stage = 'transcribed';
        row.work_stage = null;
        save(db, row, value, now(options));
        return claimed(row);
      });
    },
    materialize(lease) {
      return transact(() => {
        const previous = read(lease?.jobId);
        if (previous?.stage === 'materialized')
          return {
            kind: 'already_materialized',
            ingestionCursor: cursor(previous.sequence),
          };
        if (previous?.stage === 'cancelled') return { kind: 'cancelled' };
        const row = current(lease);
        if (!row)
          return { kind: previous?.stage === 'failed' ? 'failed' : 'stale' };
        const value = job(row);
        if (row.stage !== 'transcribed' || !value.transcribed)
          return { kind: 'stale' };
        const original = db
          .prepare(
            'SELECT content,sender FROM messages WHERE id=? AND chat_jid=?',
          )
          .get(row.message_id, row.chat_jid) as
          | { content: string; sender: string }
          | undefined;
        const reserved = db
          .prepare(
            'SELECT sequence FROM message_ingestion WHERE id=? AND chat_jid=?',
          )
          .get(row.message_id, row.chat_jid) as
          | { sequence: number }
          | undefined;
        if (
          !original ||
          original.content !== '' ||
          original.sender !== value.input.message.sender ||
          reserved?.sequence !== row.sequence
        ) {
          terminalFailure(db, row, 'source_changed', now(options), options);
          return { kind: 'dropped' };
        }
        const transcript = value.transcribed.text,
          caption = value.input.caption || '';
        if (!transcript && !caption.trim()) {
          const reason = value.transcribed.unusableReason;
          terminalFailure(
            db,
            row,
            reason === 'no_speech' || reason === 'empty'
              ? reason
              : 'transcription_unusable',
            now(options),
            options,
          );
          return { kind: 'failed' };
        }
        const kind = value.input.media.kind === 'voice' ? 'Voice' : 'Audio';
        const content = `${transcript ? `[${kind}: ${transcript}]` : `[${kind} — transcription unavailable]`}${caption ? ` ${caption}` : ''}`;
        if (!writeCapturedContent(db, row, value, content, options)) {
          terminalFailure(db, row, 'source_changed', now(options), options);
          return { kind: 'dropped' };
        }
        value.stage = 'materialized';
        releaseRow(row);
        row.dispatch_pending = 1;
        save(db, row, value, now(options));
        return { kind: 'materialized', ingestionCursor: cursor(row.sequence) };
      });
    },
    failAttempt(proposed, reason) {
      transact(() => {
        const row = current(proposed?.lease);
        if (!row?.work_stage || !FAILURE_CODES.has(reason)) return;
        const value = job(row),
          stage = row.work_stage;
        const retry =
          stage === 'download'
            ? [
                'transport_timeout',
                'transport_failure',
                'interrupted',
              ].includes(reason)
            : [
                'transcription_timeout',
                'transcription_technical_error',
                'interrupted',
              ].includes(reason);
        const remaining =
          (stage === 'download'
            ? value.downloadAttempts
            : value.transcriptionAttempts) < MAX_ATTEMPTS;
        if (retry && remaining) {
          releaseRow(row);
          save(db, row, value, now(options));
        } else terminalFailure(db, row, reason, now(options), options);
      });
    },
    release(lease, reason) {
      transact(() => {
        if (!['shutdown', 'interrupted'].includes(reason)) return;
        const row = read(lease?.jobId);
        // Only relinquishes ownership after work has stopped. A checkpoint may
        // have committed despite a lost callback, so its newer revision is safe.
        if (
          !row ||
          TERMINAL.has(row.stage) ||
          row.owner_id !== OWNER_ID ||
          row.lease_token !== lease.token
        )
          return;
        const value = job(row);
        releaseRow(row);
        save(db, row, value, now(options));
      });
    },
    terminate(lease, reason) {
      transact(() => {
        if (
          ![
            'source_changed',
            'source_unavailable',
            'deadline_expired',
            'storage_failure',
          ].includes(reason)
        )
          return;
        const row = current(lease);
        if (row) terminalFailure(db, row, reason, now(options), options);
      });
    },
    isCurrent(lease) {
      return transact(() => !!current(lease));
    },
  };
}

/** Host-only ordering/cancellation/dispatch APIs; never exposed as model tools. */
export function readMediaTranscriptionEvidence(
  db: Database.Database,
  scope: MediaIntakeScope,
  messageIds: readonly string[],
  isAdmitted: MediaIntakeStoreOptions['isAdmitted'],
): { messageId: string; result: LocalTranscriptionResult }[] {
  const key = scopeKey(scope);
  const query = db.prepare(`SELECT j.*,m.content,m.sender,mm.sender_identity_json
    FROM media_intake_jobs j JOIN messages m ON m.id=j.message_id AND m.chat_jid=j.chat_jid
    JOIN message_metadata mm ON mm.id=m.id AND mm.chat_jid=m.chat_jid
    WHERE j.scope_key=? AND j.message_id=? AND j.stage='materialized' LIMIT 1`);
  const results: { messageId: string; result: LocalTranscriptionResult }[] = [];
  for (const id of [...new Set(messageIds)].slice(-32)) {
    const row = query.get(key, id) as (Row & { content: string; sender: string; sender_identity_json: string }) | undefined;
    if (!row) continue;
    const value = job(row);
    if (value.input.message.sender !== row.sender || !isAdmitted(scope, value.input) ||
        row.sender_identity_json !== JSON.stringify(value.input.message.sender_identity ?? null)) continue;
    const detail = parseLocalTranscriptionResult(value.transcribed?.result);
    if (!detail || detail.status !== 'doubtful') continue;
    const kind = value.input.media.kind === 'voice' ? 'Voice' : 'Audio';
    const expected = `[${kind}: ${detail.text}]${value.input.caption ? ` ${value.input.caption}` : ''}`;
    // A deleted, corrected, or replaced message cannot resurrect old speech.
    if (row.content !== expected) continue;
    results.push({ messageId: id, result: detail });
  }
  return results;
}

export function earliestMediaIntakeCursor(
  db: Database.Database,
  chatJid: string,
): string | undefined {
  return persisted(() => {
    const row = db
      .prepare(
        "SELECT sequence FROM media_intake_jobs WHERE chat_jid=? AND stage NOT IN ('materialized','cancelled','failed') ORDER BY sequence LIMIT 1",
      )
      .get(chatJid) as { sequence: number } | undefined;
    return row ? cursor(row.sequence) : undefined;
  });
}
export function cancelMediaIntakeBefore(
  db: Database.Database,
  scope: MediaIntakeScope,
  senderId: string,
  throughCursor: string,
  options: { now?: () => number } = {},
): number {
  return persisted(() =>
    db
      .transaction(() => {
        const rows = db
          .prepare(
            "SELECT * FROM media_intake_jobs WHERE scope_key=? AND sequence<=? AND stage NOT IN ('materialized','cancelled','failed')",
          )
          .all(scopeKey(scope), sequence(throughCursor)) as Row[];
        let count = 0;
        for (const row of rows) {
          const value = job(row);
          if (value.input.message.sender !== senderId) continue;
          value.stage = 'cancelled';
          releaseRow(row);
          row.dispatch_pending = 1;
          save(db, row, value, now(options));
          count++;
        }
        return count;
      })
      .immediate(),
  );
}
export function pendingMediaIntakeDispatches(
  db: Database.Database,
  limit = 100,
): Array<{ jobId: string; chatJid: string }> {
  return persisted(() => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) return [];
    return (
      db
        .prepare(
          'SELECT job_id,chat_jid FROM media_intake_jobs WHERE dispatch_pending=1 ORDER BY sequence LIMIT ?',
        )
        .all(limit) as Array<{ job_id: string; chat_jid: string }>
    ).map((row) => ({ jobId: row.job_id, chatJid: row.chat_jid }));
  });
}
export function acknowledgeMediaIntakeDispatch(
  db: Database.Database,
  jobId: string,
): void {
  persisted(() =>
    db
      .prepare('UPDATE media_intake_jobs SET dispatch_pending=0 WHERE job_id=?')
      .run(jobId),
  );
}

export interface MediaIntakeNotice {
  id: string;
  jobId: string;
  botId: string;
  chatJid: string;
  reason: MediaIntakeFailure;
}
export function claimMediaIntakeNotice(
  db: Database.Database,
  options: {
    now?: () => number;
    /** Private host input only. Revalidate current scope/sender/access and transport. */
    canDeliver?: (
      notice: Readonly<MediaIntakeNotice>,
      job: Readonly<MediaIntakeJob>,
    ) => boolean;
  } = {},
): MediaIntakeNotice | undefined {
  return persisted(() =>
    db
      .transaction(() => {
        const rows = db
          .prepare(
            "SELECT notice_id,owner_id FROM media_intake_notices WHERE status='sending'",
          )
          .all() as { notice_id: string; owner_id: string }[];
        for (const row of rows)
          if (ownerDead(db, row.owner_id))
            db.prepare(
              "UPDATE media_intake_notices SET status='unknown',updated_at=? WHERE notice_id=? AND status='sending'",
            ).run(now(options), row.notice_id);
        const candidates = db
          .prepare(
            "SELECT notice_id,job_id,bot_id,chat_jid,reason FROM media_intake_notices WHERE status='pending' ORDER BY checked_order,created_at,notice_id LIMIT 128",
          )
          .all() as {
          notice_id: string;
          job_id: string;
          bot_id: string;
          chat_jid: string;
          reason: MediaIntakeFailure;
        }[];
        for (const next of candidates) {
          const notice = {
            id: next.notice_id,
            jobId: next.job_id,
            botId: next.bot_id,
            chatJid: next.chat_jid,
            reason: next.reason,
          };
          const source = db
            .prepare('SELECT * FROM media_intake_jobs WHERE job_id=?')
            .get(next.job_id) as Row | undefined;
          let deliverable = !!source;
          try {
            if (source && options.canDeliver)
              deliverable = options.canDeliver(notice, job(source)) === true;
          } catch {
            deliverable = false;
          }
          if (!deliverable) {
            db.prepare(
              'UPDATE media_intake_notices SET checked_order=(SELECT COALESCE(MAX(checked_order),0)+1 FROM media_intake_notices) WHERE notice_id=?',
            ).run(next.notice_id);
            continue;
          }
          db.prepare(
            'INSERT OR IGNORE INTO media_intake_owners VALUES(?,?,?)',
          ).run(OWNER_ID, HOST_KEY, process.pid);
          db.prepare(
            "UPDATE media_intake_notices SET status='sending',owner_id=?,updated_at=? WHERE notice_id=? AND status='pending'",
          ).run(OWNER_ID, now(options), next.notice_id);
          return notice;
        }
        return undefined;
      })
      .immediate(),
  );
}
export function settleMediaIntakeNotice(
  db: Database.Database,
  noticeId: string,
  outcome: 'confirmed' | 'unknown',
  options: { now?: () => number } = {},
): void {
  persisted(() => {
    if (!['confirmed', 'unknown'].includes(outcome)) return;
    db.prepare(
      "UPDATE media_intake_notices SET status=?,updated_at=? WHERE notice_id=? AND owner_id=? AND status='sending'",
    ).run(outcome, now(options), noticeId, OWNER_ID);
  });
}
