import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import {
  createTelegramSenderIdentity,
  loadOwnerAllowlistFromEnv,
  type OwnerAllowlistConfig,
} from '@skoobi/shared/telegram-identity';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { createEventStoreSchema } from './event-store.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { createProviderCircuitSchema } from './provider-circuit-breaker.js';
import { createQuotaSchema } from './quota.js';
import {
  CalendarEventLink,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  SenderIdentity,
  TaskRunLog,
} from './types.js';

let db: Database.Database;
let botReplySequence = 0;

/**
 * better-sqlite3 throws `duplicate column name: X` when an ALTER TABLE ADD
 * COLUMN targets a column that already exists — the expected "already applied"
 * signal for these idempotent migrations. Any other error (locked DB, disk
 * full, malformed SQL) is a genuine failure that must not be swallowed.
 */
function isAlreadyAppliedMigrationError(err: unknown): boolean {
  return err instanceof Error && /duplicate column name/i.test(err.message);
}

/**
 * Run an idempotent schema migration. The "column already exists" error is
 * expected on already-migrated databases and is ignored; anything else is
 * logged and rethrown so a partial or failed migration is never silent.
 */
function runMigration(label: string, migrate: () => void): void {
  try {
    migrate();
  } catch (err) {
    if (isAlreadyAppliedMigrationError(err)) return;
    logger.error({ err, migration: label }, 'Schema migration failed');
    throw err;
  }
}

const LEGACY_OWNER_DM_TASK_BACKFILL =
  'scheduled_tasks.owner_dm_creator_provenance.v1';

/**
 * One-time compatibility bridge for the narrowly provable legacy owner DM
 * case. Nullable provenance remains the fail-closed default: Telegram groups,
 * threads, bots, mismatched tenant metadata, and every ambiguous row stay
 * guest. The migration marker is written in the same transaction as updates,
 * so later guest-created null rows can never be upgraded on a future restart.
 */
export function backfillLegacyOwnerDmTaskProvenance(
  database: Database.Database,
  ownerAllowlist: OwnerAllowlistConfig = loadOwnerAllowlistFromEnv(),
): void {
  const alreadyApplied = database
    .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
    .get(LEGACY_OWNER_DM_TASK_BACKFILL);
  if (alreadyApplied) return;

  const trustedMappings: Array<{
    jid: string;
    folder: string;
    senderId: string;
    identityId: string;
  }> = [];
  const mainGroups = database
    .prepare(`SELECT jid, folder FROM registered_groups WHERE is_main = 1`)
    .all() as Array<{ jid: string; folder: string }>;
  const tenants = database
    .prepare(`SELECT folder, mode, channel, chat_id FROM tenants`)
    .all() as Array<{
    folder: string;
    mode: string;
    channel: string;
    chat_id: string;
  }>;
  for (const group of mainGroups) {
    if (!isValidGroupFolder(group.folder)) continue;
    const jidMatch = /^tg:([1-9][0-9]{0,19})$/.exec(group.jid);
    if (!jidMatch) continue;
    const senderId = jidMatch[1];
    // SQLite is the host-owned authority boundary. tenant.json lives in the
    // guest-writable workspace and is intentionally never consulted here.
    // Multiple rows for one folder are ambiguous and therefore fail closed.
    const candidates = tenants.filter(
      (tenant) => tenant.folder === group.folder,
    );
    if (candidates.length !== 1) continue;
    const tenant = candidates[0];
    if (
      tenant.mode !== 'owner' ||
      tenant.channel !== 'telegram' ||
      tenant.chat_id !== senderId ||
      group.jid !== `tg:${senderId}`
    ) {
      continue;
    }
    const identity = createTelegramSenderIdentity({
      chatId: senderId,
      fromId: senderId,
      ownerAllowlist,
    });
    if (
      identity.is_owner_sender !== true ||
      identity.telegram_user_id !== senderId ||
      !identity.identity_id
    ) {
      continue;
    }
    trustedMappings.push({
      jid: group.jid,
      folder: group.folder,
      senderId,
      identityId: identity.identity_id,
    });
  }

  const apply = database.transaction(() => {
    let upgraded = 0;
    const statement = database.prepare(`
      UPDATE scheduled_tasks
      SET creator_authorization = 'owner_sender',
          creator_identity_id = ?,
          creator_sender_id = ?
      WHERE group_folder = ?
        AND chat_jid = ?
        AND creator_authorization IS NULL
        AND creator_identity_id IS NULL
        AND creator_sender_id IS NULL
    `);
    for (const mapping of trustedMappings) {
      upgraded += statement.run(
        mapping.identityId,
        mapping.senderId,
        mapping.folder,
        mapping.jid,
      ).changes;
    }
    database
      .prepare(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`)
      .run(LEGACY_OWNER_DM_TASK_BACKFILL, new Date().toISOString());
    return upgraded;
  });
  const upgraded = apply();
  if (upgraded > 0) {
    logger.info(
      { upgraded },
      'Backfilled narrowly verified legacy owner-DM task provenance',
    );
  }
}

/**
 * Create (and idempotently migrate) the full schema on `database`. Exported as
 * `@internal` only so tests can drive the migration path against a pre-existing
 * legacy table; production callers go through initDatabase/_initTestDatabase.
 */
export function createSchema(
  database: Database.Database,
  pluginDbSchema: string[] = [],
  ownerAllowlist: OwnerAllowlistConfig = loadOwnerAllowlistFromEnv(),
): void {
  // Enforce foreign-key constraints on this connection. SQLite defaults FK
  // enforcement to OFF per-connection, so without this every FOREIGN KEY in
  // the schema below (messages->chats, task_run_logs->scheduled_tasks, plus
  // the quota and event-store chains) is inert. Both initDatabase() and
  // _initTestDatabase() route through here, so this covers prod and tests.
  // Must run outside a transaction (it is silently ignored inside one);
  // createSchema is always called immediately after the connection opens.
  database.pragma('foreign_keys = ON');
  if (database.pragma('foreign_keys', { simple: true }) !== 1) {
    logger.error(
      'Failed to enable foreign_keys enforcement; referential integrity is not guaranteed',
    );
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE TABLE IF NOT EXISTS message_metadata (
      id TEXT,
      chat_jid TEXT,
      telegram_update_id TEXT,
      sender_identity_json TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (id, chat_jid) REFERENCES messages(id, chat_jid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_message_metadata_update_id
      ON message_metadata(telegram_update_id);

    -- Passive WhatsApp observation is intentionally isolated from the normal
    -- message-processing table. Observed chats do not become registered agent
    -- chats, and retention can be enforced without affecting conversation
    -- state used by the message loop.
    CREATE TABLE IF NOT EXISTS observed_whatsapp_messages (
      message_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      local_chat_label TEXT NOT NULL DEFAULT '',
      local_sender_label TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 0 CHECK (from_me IN (0, 1)),
      message_kind TEXT NOT NULL DEFAULT 'text',
      upsert_type TEXT NOT NULL DEFAULT 'notify',
      media_enriched INTEGER NOT NULL DEFAULT 0 CHECK (media_enriched IN (0, 1)),
      observed_at TEXT NOT NULL,
      PRIMARY KEY (message_id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_observed_whatsapp_timestamp
      ON observed_whatsapp_messages(timestamp DESC, message_id DESC);
    CREATE INDEX IF NOT EXISTS idx_observed_whatsapp_chat_timestamp
      ON observed_whatsapp_messages(chat_jid, timestamp DESC, message_id DESC);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      creator_authorization TEXT,
      creator_identity_id TEXT,
      creator_sender_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS calendar_event_links (
      task_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_link TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_event_links_event
      ON calendar_event_links(provider, calendar_id, event_id);

    CREATE TABLE IF NOT EXISTS google_operation_journal (
      intent_id TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      operation_fingerprint TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      tool TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (intent_id, operation_key)
    );
    CREATE INDEX IF NOT EXISTS idx_google_operation_journal_updated
      ON google_operation_journal(updated_at);

    CREATE TABLE IF NOT EXISTS image_jobs (
      id TEXT PRIMARY KEY,
      request_key TEXT NOT NULL UNIQUE,
      chat_jid TEXT NOT NULL,
      reply_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'codex_builtin',
      status TEXT NOT NULL,
      artifact_paths_json TEXT,
      generation_attempts INTEGER NOT NULL DEFAULT 1,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      generated_at TEXT,
      generation_completed_at TEXT,
      generation_call_ids_json TEXT,
      delivered_at TEXT,
      failure_notice_claimed_at TEXT,
      failure_notified_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_image_jobs_chat_status
      ON image_jobs(chat_jid, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_image_jobs_recovery
      ON image_jobs(status, updated_at);

    CREATE TABLE IF NOT EXISTS image_job_artifacts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      staged_path TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'generated',
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE(job_id, call_id),
      UNIQUE(job_id, ordinal),
      FOREIGN KEY (job_id) REFERENCES image_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_image_job_artifacts_delivery
      ON image_job_artifacts(job_id, status, ordinal);
    CREATE INDEX IF NOT EXISTS idx_image_job_artifacts_recovery
      ON image_job_artifacts(status, updated_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

  `);

  createEventStoreSchema(database);
  createQuotaSchema(database);
  createProviderCircuitSchema(database);

  // Run plugin DB schema (plugins register on import before DB init)
  for (const sql of pluginDbSchema) {
    database.exec(sql);
  }

  // Each migration below is idempotent: ALTER TABLE ADD COLUMN throws
  // "duplicate column name" on already-migrated DBs (swallowed by
  // runMigration), while genuine failures are logged and rethrown.

  // Existing journal rows predate exact-payload binding. The added column is
  // deliberately nullable on migrated databases: there is not enough durable
  // information to reconstruct their exact operation. The broker treats NULL
  // as payload_mismatch and therefore never reuses an unverifiable result.
  // Fresh databases use the NOT NULL declaration in CREATE TABLE above.
  runMigration('google_operation_journal.operation_fingerprint', () => {
    database.exec(
      `ALTER TABLE google_operation_journal ADD COLUMN operation_fingerprint TEXT`,
    );
  });

  // Observer media is enriched asynchronously after the metadata row has
  // already been stored.  Keep an explicit quality bit so a later Baileys
  // history replay cannot replace a local transcript/frame reference with the
  // original empty media placeholder.
  runMigration('observed_whatsapp_messages.media_enriched', () => {
    database.exec(
      `ALTER TABLE observed_whatsapp_messages ADD COLUMN media_enriched INTEGER NOT NULL DEFAULT 0 CHECK (media_enriched IN (0, 1))`,
    );
  });

  // Persist terminal image-job notices separately from the failure itself.
  // Existing failures predate automatic recovery notices and are backfilled as
  // already notified, avoiding a burst of stale messages after deployment.
  runMigration('image_jobs.failure_notice_claimed_at', () => {
    database.exec(
      `ALTER TABLE image_jobs ADD COLUMN failure_notice_claimed_at TEXT`,
    );
  });
  runMigration('image_jobs.generation_completed_at', () => {
    database.transaction(() => {
      database.exec(
        `ALTER TABLE image_jobs ADD COLUMN generation_completed_at TEXT`,
      );
      database.exec(
        `UPDATE image_jobs
         SET generation_completed_at = COALESCE(generated_at, updated_at)
         WHERE generation_completed_at IS NULL
           AND status IN ('generated', 'delivering', 'delivered', 'failed')`,
      );
    })();
  });
  runMigration('image_jobs.generation_call_ids_json', () => {
    database.exec(
      `ALTER TABLE image_jobs ADD COLUMN generation_call_ids_json TEXT`,
    );
  });
  runMigration('image_jobs.failure_notified_at', () => {
    database.transaction(() => {
      database.exec(
        `ALTER TABLE image_jobs ADD COLUMN failure_notified_at TEXT`,
      );
      database.exec(
        `UPDATE image_jobs
         SET failure_notified_at = updated_at
         WHERE status = 'failed' AND failure_notified_at IS NULL`,
      );
    })();
  });

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  runMigration('scheduled_tasks.context_mode', () => {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  });

  // Creator provenance is nullable on purpose: existing/legacy tasks have no
  // authoritative per-run sender proof and must execute at guest tier until an
  // owner recreates them through the capability-gated IPC path.
  runMigration('scheduled_tasks.creator_authorization', () => {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN creator_authorization TEXT`,
    );
  });
  runMigration('scheduled_tasks.creator_identity_id', () => {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN creator_identity_id TEXT`,
    );
  });
  runMigration('scheduled_tasks.creator_sender_id', () => {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN creator_sender_id TEXT`,
    );
  });

  // Add is_bot_message column if it doesn't exist (migration for existing DBs).
  // The ALTER and its backfill are wrapped in a transaction so the column add
  // and the backfill commit atomically: a failure mid-migration (e.g.
  // SQLITE_FULL) can no longer leave the column present with the backfill
  // half-applied. If the column already exists the ALTER throws
  // "duplicate column name", the transaction rolls back as a no-op, and
  // runMigration swallows it.
  runMigration('messages.is_bot_message', () => {
    database.transaction(() => {
      database.exec(
        `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
      );
      // Backfill: mark existing bot messages that used the content prefix pattern
      database
        .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
        .run(`${ASSISTANT_NAME}:%`);
    })();
  });

  // Add is_main column if it doesn't exist (migration for existing DBs).
  // ALTER + backfill wrapped in a transaction so they apply atomically; see
  // the messages.is_bot_message migration above for the rationale.
  runMigration('registered_groups.is_main', () => {
    database.transaction(() => {
      database.exec(
        `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
      );
      // Backfill: existing rows with folder = 'main' are the main group
      database.exec(
        `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
      );
    })();
  });

  // Add agent_config column if it doesn't exist (migration for existing DBs)
  runMigration('registered_groups.agent_config', () => {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN agent_config TEXT`);
  });

  // Add runtime column if it doesn't exist (migration for existing DBs)
  runMigration('registered_groups.runtime', () => {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN runtime TEXT`);
  });

  backfillLegacyOwnerDmTaskProvenance(database, ownerAllowlist);

  // Add channel and is_group columns if they don't exist (migration for
  // existing DBs). Each column is a SEPARATE runMigration call: with both in
  // one callback, a legacy DB that already had `channel` would throw
  // "duplicate column name: channel" on the first ALTER, which runMigration
  // swallows — aborting the callback before `is_group` was ever added. Split so
  // each column's duplicate-column outcome is evaluated independently.
  runMigration('chats.channel', () => {
    database.transaction(() => {
      database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    })();
  });
  runMigration('chats.is_group', () => {
    database.transaction(() => {
      database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    })();
  });
  // Backfill from JID patterns. Kept OUT of the ALTER guards above: the
  // backfill touches both columns, so it must run only after both exist, and
  // gating it behind either ALTER's duplicate-column swallow would skip it on a
  // partially-migrated DB. It is idempotent (fixed values keyed by jid LIKE),
  // so running it on every init is safe.
  runMigration('chats.channel+is_group backfill', () => {
    database.transaction(() => {
      database.exec(
        `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
      );
      database.exec(
        `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
      );
      database.exec(
        `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
      );
      database.exec(
        `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
      );
    })();
  });
}

export function initDatabase(pluginDbSchema: string[] = []): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Concurrency hardening for the live, on-disk messages.db (finding #48). A
  // SEPARATE always-installed process (the managed DB-retention launchd
  // agent) periodically runs DELETE + VACUUM against this exact file. VACUUM
  // takes an EXCLUSIVE lock and can hold it for seconds on a non-trivial DB.
  // With better-sqlite3's default busy_timeout of 0ms, any concurrent
  // orchestrator write (e.g. storeMessage on inbound ingestion, event-store
  // INSERTs) would throw SQLITE_BUSY ('database is locked') immediately and
  // lose that message/event. WAL lets readers and writers proceed without
  // blocking each other, and a non-zero busy_timeout makes a writer WAIT for a
  // transient exclusive lock (the VACUUM window) instead of failing instantly.
  // These pragmas apply only to the file-backed connection; the in-memory test
  // DB in _initTestDatabase() has no cross-process contention and WAL is a
  // no-op there, so they are intentionally NOT set inside createSchema().
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  hardenDatabaseFilePermissions(dbPath);

  createSchema(db, pluginDbSchema);

  // Migrate from JSON files if they exist
  migrateJsonState();

  hardenDatabaseFilePermissions(dbPath);
}

/**
 * Restrict the local correspondence database and its SQLite sidecars to the
 * service account. Permission hardening is best-effort because a read-only
 * filesystem must not make an otherwise usable already-open database crash.
 * No paths or message content are logged from this boundary.
 *
 * @internal Exported so permission behaviour can be tested without opening the
 * live database.
 */
export function hardenDatabaseFilePermissions(databasePath: string): void {
  try {
    fs.chmodSync(path.dirname(databasePath), 0o700);
  } catch {
    // Best effort: the directory may be managed by a read-only mount.
  }

  for (const candidate of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ]) {
    try {
      if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600);
    } catch {
      // Best effort: SQLite has already established the connection.
    }
  }
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = CASE
          WHEN last_message_time IS NULL OR excluded.last_message_time > last_message_time
          THEN excluded.last_message_time
          ELSE last_message_time
        END,
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = CASE
          WHEN last_message_time IS NULL OR excluded.last_message_time > last_message_time
          THEN excluded.last_message_time
          ELSE last_message_time
        END,
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Guarantee a parent row exists in `chats` for the given JID. With
 * foreign_keys = ON, messages.chat_jid must reference chats.jid, but a few
 * paths store a message for a JID that has no chats row yet: thread
 * auto-creation (`${chatJid}:${triggerMsg.id}`, registered as a group but not
 * a chat) and webhook/extension ingestion. INSERT OR IGNORE is a cheap no-op
 * in the overwhelmingly common case where the chat already exists, and keeps
 * the foreign key satisfiable for every message-insert caller.
 */
function ensureChatExists(chatJid: string): void {
  db.prepare('INSERT OR IGNORE INTO chats (jid) VALUES (?)').run(chatJid);
}

type StoredMessageRow = Omit<NewMessage, 'sender_identity'> & {
  is_from_me?: number | boolean;
  is_bot_message?: number | boolean;
  telegram_update_id?: string | null;
  sender_identity_json?: string | null;
};

function parseSenderIdentityJson(
  value: string | null | undefined,
): SenderIdentity | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<SenderIdentity> | null;
    if (
      parsed?.channel === 'telegram' &&
      typeof parsed.chat_id === 'string' &&
      typeof parsed.telegram_user_id === 'string' &&
      typeof parsed.identity_id === 'string'
    ) {
      return {
        channel: 'telegram',
        chat_id: parsed.chat_id,
        telegram_user_id: parsed.telegram_user_id,
        identity_id: parsed.identity_id,
        bot_id: parsed.bot_id,
        persona_id: parsed.persona_id,
        username_hint: parsed.username_hint,
        display_name_hint: parsed.display_name_hint,
        is_owner_sender: parsed.is_owner_sender === true,
        telegram_message_origin:
          parsed.telegram_message_origin === 'direct' ||
          parsed.telegram_message_origin === 'forwarded' ||
          parsed.telegram_message_origin === 'quoted'
            ? parsed.telegram_message_origin
            : undefined,
      };
    }
  } catch {
    // Ignore malformed legacy metadata and fall back to sender id.
  }
  return undefined;
}

function hydrateStoredMessage(row: StoredMessageRow): NewMessage {
  const senderIdentity = parseSenderIdentityJson(row.sender_identity_json);
  return {
    id: row.id,
    chat_jid: row.chat_jid,
    sender: row.sender,
    sender_name: row.sender_name,
    content: row.content,
    timestamp: row.timestamp,
    is_from_me: row.is_from_me as boolean | undefined,
    is_bot_message: row.is_bot_message as boolean | undefined,
    tenant_id: row.tenant_id,
    telegram_update_id: row.telegram_update_id || undefined,
    sender_identity: senderIdentity,
  };
}

function hydrateStoredMessages(rows: StoredMessageRow[]): NewMessage[] {
  return rows.map(hydrateStoredMessage);
}

function storeMessageMetadata(msg: NewMessage): void {
  const telegramUpdateId = msg.telegram_update_id || null;
  const senderIdentityJson = msg.sender_identity
    ? JSON.stringify(msg.sender_identity)
    : null;
  if (!telegramUpdateId && !senderIdentityJson) return;
  db.prepare(
    `
    INSERT INTO message_metadata (id, chat_jid, telegram_update_id, sender_identity_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id, chat_jid) DO UPDATE SET
      telegram_update_id = COALESCE(excluded.telegram_update_id, telegram_update_id),
      sender_identity_json = COALESCE(excluded.sender_identity_json, sender_identity_json)
  `,
  ).run(msg.id, msg.chat_jid, telegramUpdateId, senderIdentityJson);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  ensureChatExists(msg.chat_jid);
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
  storeMessageMetadata(msg);
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  ensureChatExists(msg.chat_jid);
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function storeBotReply(
  chatJid: string,
  content: string,
  timestamp: string = new Date().toISOString(),
): void {
  botReplySequence = (botReplySequence + 1) % Number.MAX_SAFE_INTEGER;
  storeMessageDirect({
    id: `bot-${timestamp}-${botReplySequence}`,
    chat_jid: chatJid,
    sender: ASSISTANT_NAME,
    sender_name: ASSISTANT_NAME,
    content,
    timestamp,
    is_from_me: true,
    is_bot_message: true,
  });
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  //
  // Take the OLDEST `limit` unprocessed messages (ASC), not the newest. The
  // caller advances its cursor to the max timestamp returned, so on a burst of
  // more than `limit` messages in one poll window, returning the newest `limit`
  // would jump the cursor past the older overflow and skip it permanently.
  // Oldest-first means the cursor advances only to the oldest-unprocessed
  // boundary and subsequent polls page through the remainder, losing nothing.
  const sql = `
    SELECT
      m.id,
      m.chat_jid,
      m.sender,
      m.sender_name,
      m.content,
      m.timestamp,
      m.is_from_me,
      m.is_bot_message,
      mm.telegram_update_id,
      mm.sender_identity_json
    FROM messages m
    LEFT JOIN message_metadata mm
      ON mm.id = m.id AND mm.chat_jid = m.chat_jid
    WHERE m.timestamp > ? AND m.chat_jid IN (${placeholders})
      AND m.is_bot_message = 0 AND m.content NOT LIKE ?
      AND m.content != '' AND m.content IS NOT NULL
    ORDER BY m.timestamp ASC
    LIMIT ?
  `;

  let rows = db
    .prepare(sql)
    .all(
      lastTimestamp,
      ...jids,
      `[${botPrefix}]%`,
      limit,
    ) as StoredMessageRow[];

  // Cursor-safety for same-timestamp groups. Message timestamps are only
  // second-resolution (e.g. Telegram's `new Date(date * 1000)`), so when a
  // burst exceeds `limit` the cut can fall inside a group of messages that
  // share the boundary second. The caller advances its cursor to the newest
  // timestamp returned and re-queries with strict `timestamp > ?`, so it would
  // skip the rest of that group forever. When we hit the limit, drop the
  // trailing rows that share the newest timestamp so the cursor stops just
  // before that (possibly partial) group; the next poll re-fetches it in full.
  // If EVERY returned row shares that timestamp (more than `limit` messages in
  // one second), keep them all so the cursor still makes forward progress.
  if (rows.length === limit) {
    const boundaryTs = rows[rows.length - 1].timestamp;
    const beforeBoundary = rows.filter((row) => row.timestamp < boundaryTs);
    if (beforeBoundary.length > 0) rows = beforeBoundary;
  }

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: hydrateStoredMessages(rows), newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT
        m.id,
        m.chat_jid,
        m.sender,
        m.sender_name,
        m.content,
        m.timestamp,
        m.is_from_me,
        m.is_bot_message,
        mm.telegram_update_id,
        mm.sender_identity_json
      FROM messages m
      LEFT JOIN message_metadata mm
        ON mm.id = m.id AND mm.chat_jid = m.chat_jid
      WHERE m.chat_jid = ? AND m.timestamp > ?
        AND m.is_bot_message = 0 AND m.content NOT LIKE ?
        AND m.content != '' AND m.content IS NOT NULL
      ORDER BY m.timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const rows = db
    .prepare(sql)
    .all(
      chatJid,
      sinceTimestamp,
      `[${botPrefix}]%`,
      limit,
    ) as StoredMessageRow[];
  return hydrateStoredMessages(rows);
}

export function getRecentConversationMessages(
  chatJid: string,
  beforeTimestamp: string,
  limit: number = 50,
): NewMessage[] {
  const beforeSql = beforeTimestamp ? 'AND timestamp < ?' : '';
  const params = beforeTimestamp
    ? [chatJid, beforeTimestamp, limit]
    : [chatJid, limit];
  const sql = `
    SELECT * FROM (
      SELECT
        m.id,
        m.chat_jid,
        m.sender,
        m.sender_name,
        m.content,
        m.timestamp,
        m.is_from_me,
        m.is_bot_message,
        mm.telegram_update_id,
        mm.sender_identity_json
      FROM messages m
      LEFT JOIN message_metadata mm
        ON mm.id = m.id AND mm.chat_jid = m.chat_jid
      WHERE m.chat_jid = ? ${beforeSql}
        AND m.content != '' AND m.content IS NOT NULL
      ORDER BY m.timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return hydrateStoredMessages(
    db.prepare(sql).all(...params) as StoredMessageRow[],
  );
}

const MAX_RECENT_EXACT_CHAT_JIDS = 16;
const MAX_RECENT_EXACT_MESSAGES = 50;

/**
 * Read a bounded, chronological tail across an exact host-selected JID set.
 *
 * This is deliberately separate from the processing cursor queries above:
 * callers use it only to build read-only continuity context. Every JID is a
 * bound SQL parameter (never a prefix/pattern), and a large accidental scope
 * fails closed instead of widening the read.
 */
export function getRecentConversationMessagesForExactJids(
  chatJids: readonly string[],
  beforeTimestamp: string,
  limit: number = 20,
): NewMessage[] {
  const exactJids = [
    ...new Set(
      chatJids.filter(
        (jid): jid is string =>
          typeof jid === 'string' && jid.length > 0 && jid.trim() === jid,
      ),
    ),
  ];
  if (exactJids.length === 0) return [];
  if (exactJids.length > MAX_RECENT_EXACT_CHAT_JIDS) {
    throw new RangeError('Too many exact chat JIDs for recent context');
  }

  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : 20;
  const boundedLimit = Math.min(
    MAX_RECENT_EXACT_MESSAGES,
    Math.max(1, requestedLimit),
  );
  const placeholders = exactJids.map(() => '?').join(',');
  const beforeSql = beforeTimestamp ? 'AND m.timestamp < ?' : '';
  const params = beforeTimestamp
    ? [...exactJids, beforeTimestamp, boundedLimit]
    : [...exactJids, boundedLimit];
  const sql = `
    SELECT * FROM (
      SELECT
        m.id,
        m.chat_jid,
        m.sender,
        m.sender_name,
        m.content,
        m.timestamp,
        m.is_from_me,
        m.is_bot_message,
        mm.telegram_update_id,
        mm.sender_identity_json
      FROM messages m
      LEFT JOIN message_metadata mm
        ON mm.id = m.id AND mm.chat_jid = m.chat_jid
      WHERE m.chat_jid IN (${placeholders}) ${beforeSql}
        AND m.content != '' AND m.content IS NOT NULL
      ORDER BY m.timestamp DESC, m.chat_jid DESC, m.id DESC
      LIMIT ?
    ) ORDER BY timestamp, chat_jid, id
  `;
  return hydrateStoredMessages(
    db.prepare(sql).all(...params) as StoredMessageRow[],
  );
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (
      id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
      context_mode, next_run, status, created_at, creator_authorization,
      creator_identity_id, creator_sender_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
    task.creator_authorization || null,
    task.creator_identity_id || null,
    task.creator_sender_id || null,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint), then the parent, atomically.
  // Wrapping both DELETEs in a transaction means a failure between them can no
  // longer leave a scheduled_task whose run-log history was already wiped: the
  // pair commits together or not at all.
  db.transaction(() => {
    db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM calendar_event_links WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  })();
}

/**
 * List tasks in FINISHED states for bulk cleanup («удали завершённые задачи»).
 * Deliberately limited to completed/cancelled — bulk deletion must never be
 * able to touch active or paused tasks; those are cancelled one-by-one with
 * cancel_task. The caller deletes each id via deleteTask (dropping any linked
 * calendar event first), so run-log/calendar cleanup stays on the one audited
 * path.
 */
export function getFinishedTasks(
  statuses: Array<'completed' | 'cancelled'>,
  groupFolder?: string,
): ScheduledTask[] {
  const allowed = statuses.filter(
    (status) => status === 'completed' || status === 'cancelled',
  );
  if (allowed.length === 0) return [];
  const placeholders = allowed.map(() => '?').join(', ');
  const groupSql = groupFolder ? 'AND group_folder = ?' : '';
  const params: unknown[] = [...allowed];
  if (groupFolder) params.push(groupFolder);
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks WHERE status IN (${placeholders}) ${groupSql} ORDER BY created_at`,
    )
    .all(...params) as ScheduledTask[];
}

export function upsertCalendarEventLink(
  link: Omit<CalendarEventLink, 'created_at' | 'updated_at'> & {
    created_at?: string;
    updated_at?: string;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO calendar_event_links (
      task_id, provider, calendar_id, event_id, event_link, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      provider = excluded.provider,
      calendar_id = excluded.calendar_id,
      event_id = excluded.event_id,
      event_link = excluded.event_link,
      status = excluded.status,
      updated_at = excluded.updated_at
  `,
  ).run(
    link.task_id,
    link.provider,
    link.calendar_id,
    link.event_id,
    link.event_link,
    link.status,
    link.created_at || now,
    link.updated_at || now,
  );
}

export function getCalendarEventLink(
  taskId: string,
): CalendarEventLink | undefined {
  return db
    .prepare('SELECT * FROM calendar_event_links WHERE task_id = ?')
    .get(taskId) as CalendarEventLink | undefined;
}

export function getAllCalendarEventLinks(): CalendarEventLink[] {
  return db
    .prepare('SELECT * FROM calendar_event_links ORDER BY created_at DESC')
    .all() as CalendarEventLink[];
}

export function markCalendarEventLinkDeleted(taskId: string): void {
  db.prepare(
    `
    UPDATE calendar_event_links
    SET status = 'deleted', updated_at = ?
    WHERE task_id = ?
  `,
  ).run(new Date().toISOString(), taskId);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

/**
 * Drop a group's pinned session id. The next run starts a fresh conversation
 * (and persists its new id). Used by the transcript-size guard after it
 * archives a bloated transcript so the group rolls onto a clean session.
 */
export function clearSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
        agent_config: string | null;
        runtime: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    agentConfig: row.agent_config ? JSON.parse(row.agent_config) : undefined,
    runtime: (row.runtime as RegisteredGroup['runtime']) || undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  // registered_groups has BOTH `jid` PRIMARY KEY and `folder` UNIQUE. A naive
  // INSERT OR REPLACE resolves a conflict on EITHER unique constraint by
  // DELETING the conflicting row, so registering jidB with a folder already
  // owned by jidA would silently delete jidA's registration (cross-tenant data
  // loss). Scope the upsert to the jid via ON CONFLICT(jid): re-registering the
  // same jid updates its row in place, while a foreign-folder collision is NOT
  // resolvable by this clause and surfaces as a SQLITE_CONSTRAINT UNIQUE error
  // to the caller instead of destroying the victim's row.
  db.prepare(
    `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, agent_config, runtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       name = excluded.name,
       folder = excluded.folder,
       trigger_pattern = excluded.trigger_pattern,
       added_at = excluded.added_at,
       container_config = excluded.container_config,
       requires_trigger = excluded.requires_trigger,
       is_main = excluded.is_main,
       agent_config = excluded.agent_config,
       runtime = excluded.runtime`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
    group.agentConfig ? JSON.stringify(group.agentConfig) : null,
    group.runtime || null,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
    agent_config: string | null;
    runtime: string | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
      agentConfig: row.agent_config ? JSON.parse(row.agent_config) : undefined,
      runtime: (row.runtime as RegisteredGroup['runtime']) || undefined,
    };
  }
  return result;
}

/**
 * Returns the Database instance. Must be called after initDatabase() or _initTestDatabase().
 */
export function getDb(): Database.Database {
  return db;
}

export type ImageJobStatus =
  | 'queued'
  | 'generating'
  | 'generated'
  | 'delivering'
  | 'delivered'
  | 'failed';

export interface ImageJobRecord {
  id: string;
  request_key: string;
  chat_jid: string;
  reply_jid: string;
  group_folder: string;
  prompt_hash: string;
  provider: string;
  status: ImageJobStatus;
  artifact_paths_json: string | null;
  generation_attempts: number;
  delivery_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  generated_at: string | null;
  generation_completed_at: string | null;
  generation_call_ids_json: string | null;
  delivered_at: string | null;
  failure_notice_claimed_at: string | null;
  failure_notified_at: string | null;
}

export type ImageJobArtifactStatus =
  | 'generated'
  | 'delivering'
  | 'delivered'
  | 'failed';

export interface ImageJobArtifactRecord {
  id: string;
  job_id: string;
  call_id: string;
  source_path: string;
  staged_path: string;
  ordinal: number;
  status: ImageJobArtifactStatus;
  delivery_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

/**
 * Keep the legacy job-level columns as a projection of the normalized
 * artifacts. Older status/reporting callers can continue to read one row,
 * while delivery and recovery get independent durable state per image.
 */
function refreshImageJobArtifactProjection(
  id: string,
  now = new Date().toISOString(),
): void {
  const artifacts = db
    .prepare(
      `SELECT * FROM image_job_artifacts
       WHERE job_id = ?
       ORDER BY ordinal ASC`,
    )
    .all(id) as ImageJobArtifactRecord[];
  if (artifacts.length === 0) return;

  const generationRow = db
    .prepare(`SELECT generation_call_ids_json FROM image_jobs WHERE id = ?`)
    .get(id) as { generation_call_ids_json: string | null } | undefined;
  let expectedCallIds: string[] = [];
  try {
    const parsed = generationRow?.generation_call_ids_json
      ? (JSON.parse(generationRow.generation_call_ids_json) as unknown)
      : [];
    if (Array.isArray(parsed)) {
      expectedCallIds = parsed.filter(
        (callId): callId is string => typeof callId === 'string',
      );
    }
  } catch {
    expectedCallIds = [];
  }
  const materializedCallIds = new Set(
    artifacts.map((artifact) => artifact.call_id),
  );
  const hasMissingExpectedArtifact = expectedCallIds.some(
    (callId) => !materializedCallIds.has(callId),
  );

  let status: ImageJobStatus;
  if (artifacts.some((artifact) => artifact.status === 'delivering')) {
    status = 'delivering';
  } else if (artifacts.some((artifact) => artifact.status === 'generated')) {
    status = 'generated';
  } else if (artifacts.every((artifact) => artifact.status === 'delivered')) {
    status = hasMissingExpectedArtifact ? 'generated' : 'delivered';
  } else {
    // All artifacts are now terminal and at least one failed. Keep the job
    // recoverable while later artifacts are still generated, so one bad image
    // cannot prevent the rest of an ordered multi-image request from sending.
    status = 'failed';
  }
  const lastError =
    artifacts.find((artifact) => artifact.status === 'failed')?.last_error ||
    artifacts.find((artifact) => artifact.status === 'generated')?.last_error ||
    null;
  const deliveryAttempts = artifacts.reduce(
    (total, artifact) => total + artifact.delivery_attempts,
    0,
  );
  const deliveredAt =
    status === 'delivered'
      ? artifacts.reduce<string | null>(
          (latest, artifact) =>
            !latest || (artifact.delivered_at && artifact.delivered_at > latest)
              ? artifact.delivered_at
              : latest,
          null,
        ) || now
      : null;

  db.prepare(
    `UPDATE image_jobs
     SET status = ?, artifact_paths_json = ?, delivery_attempts = ?,
         generated_at = COALESCE(generated_at, ?), delivered_at = ?,
         updated_at = ?, last_error = ?,
         failure_notice_claimed_at = CASE WHEN ? = 'failed'
           THEN failure_notice_claimed_at ELSE NULL END,
         failure_notified_at = CASE WHEN ? = 'failed'
           THEN failure_notified_at ELSE NULL END
     WHERE id = ?`,
  ).run(
    status,
    JSON.stringify(artifacts.map((artifact) => artifact.staged_path)),
    deliveryAttempts,
    artifacts[0]?.created_at || now,
    deliveredAt,
    now,
    lastError,
    status,
    status,
    id,
  );
}

export function getImageJobArtifacts(jobId: string): ImageJobArtifactRecord[] {
  return db
    .prepare(
      `SELECT * FROM image_job_artifacts
       WHERE job_id = ?
       ORDER BY ordinal ASC`,
    )
    .all(jobId) as ImageJobArtifactRecord[];
}

export function getImageJobArtifactByCallId(
  jobId: string,
  callId: string,
): ImageJobArtifactRecord | null {
  return (
    (db
      .prepare(
        `SELECT * FROM image_job_artifacts
         WHERE job_id = ? AND call_id = ?`,
      )
      .get(jobId, callId) as ImageJobArtifactRecord | undefined) || null
  );
}

export function createImageJobArtifact(input: {
  id: string;
  jobId: string;
  callId: string;
  sourcePath: string;
  stagedPath: string;
  expectedGenerationAttempt?: number;
  now?: string;
}): ImageJobArtifactRecord {
  const now = input.now || new Date().toISOString();
  return db.transaction(() => {
    if (input.expectedGenerationAttempt !== undefined) {
      const owner = getImageJobById(input.jobId);
      if (
        !owner ||
        owner.generation_attempts !== input.expectedGenerationAttempt
      ) {
        throw new Error('Image artifact generation lease was superseded');
      }
    }
    const existing = getImageJobArtifactByCallId(input.jobId, input.callId);
    if (existing) return existing;
    const ordinalRow = db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
         FROM image_job_artifacts WHERE job_id = ?`,
      )
      .get(input.jobId) as { ordinal: number };
    db.prepare(
      `INSERT INTO image_job_artifacts (
         id, job_id, call_id, source_path, staged_path, ordinal,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'generated', ?, ?)
       ON CONFLICT(job_id, call_id) DO NOTHING`,
    ).run(
      input.id,
      input.jobId,
      input.callId,
      input.sourcePath,
      input.stagedPath,
      ordinalRow.ordinal,
      now,
      now,
    );
    refreshImageJobArtifactProjection(input.jobId, now);
    return getImageJobArtifactByCallId(input.jobId, input.callId)!;
  })();
}

export function markImageJobArtifactDelivering(
  artifactId: string,
  maxAttempts: number,
  now = new Date().toISOString(),
): boolean {
  return db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE image_job_artifacts AS artifact
       SET status = 'delivering',
           delivery_attempts = delivery_attempts + 1,
           updated_at = ?, last_error = NULL
       WHERE id = ?
         AND status = 'generated'
         AND delivery_attempts < ?
         AND NOT EXISTS (
           SELECT 1 FROM image_job_artifacts AS previous
           WHERE previous.job_id = artifact.job_id
             AND previous.ordinal < artifact.ordinal
             AND previous.status NOT IN ('delivered', 'failed')
         )`,
      )
      .run(now, artifactId, maxAttempts);
    const artifact = db
      .prepare('SELECT job_id FROM image_job_artifacts WHERE id = ?')
      .get(artifactId) as { job_id: string } | undefined;
    if (artifact) refreshImageJobArtifactProjection(artifact.job_id, now);
    return result.changes === 1;
  })();
}

export function markImageJobArtifactDelivered(
  artifactId: string,
  now = new Date().toISOString(),
): void {
  db.transaction(() => {
    const artifact = db
      .prepare('SELECT job_id FROM image_job_artifacts WHERE id = ?')
      .get(artifactId) as { job_id: string } | undefined;
    if (!artifact) return;
    db.prepare(
      `UPDATE image_job_artifacts
       SET status = 'delivered', delivered_at = ?, updated_at = ?,
           last_error = NULL
       WHERE id = ? AND status IN ('generated', 'delivering', 'delivered')`,
    ).run(now, now, artifactId);
    refreshImageJobArtifactProjection(artifact.job_id, now);
  })();
}

export function markImageJobArtifactDeliveryPending(
  artifactId: string,
  error: string,
  now = new Date().toISOString(),
): void {
  db.transaction(() => {
    const artifact = db
      .prepare('SELECT job_id FROM image_job_artifacts WHERE id = ?')
      .get(artifactId) as { job_id: string } | undefined;
    if (!artifact) return;
    db.prepare(
      `UPDATE image_job_artifacts
       SET status = 'generated', updated_at = ?, last_error = ?
       WHERE id = ? AND status = 'delivering'`,
    ).run(now, error.slice(0, 1000), artifactId);
    refreshImageJobArtifactProjection(artifact.job_id, now);
  })();
}

export function markImageJobArtifactFailed(
  artifactId: string,
  error: string,
  now = new Date().toISOString(),
): void {
  db.transaction(() => {
    const artifact = db
      .prepare('SELECT job_id FROM image_job_artifacts WHERE id = ?')
      .get(artifactId) as { job_id: string } | undefined;
    if (!artifact) return;
    db.prepare(
      `UPDATE image_job_artifacts
       SET status = 'failed', updated_at = ?, last_error = ?
       WHERE id = ? AND status != 'delivered'`,
    ).run(now, error.slice(0, 1000), artifactId);
    refreshImageJobArtifactProjection(artifact.job_id, now);
  })();
}

export function markAllImageJobArtifactsDelivered(
  jobId: string,
  now = new Date().toISOString(),
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE image_job_artifacts
       SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?),
           updated_at = ?, last_error = NULL
       WHERE job_id = ? AND status != 'delivered'`,
    ).run(now, now, jobId);
    refreshImageJobArtifactProjection(jobId, now);
  })();
}

export function claimImageJobGeneration(input: {
  id: string;
  maxAttempts: number;
  staleBefore: string;
  now?: string;
}): boolean {
  const now = input.now || new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE image_jobs
     SET status = 'generating',
         generation_attempts = generation_attempts + 1,
         generation_completed_at = NULL,
         generation_call_ids_json = NULL,
         updated_at = ?, last_error = NULL
     WHERE id = ?
       AND generation_attempts < ?
       AND NOT EXISTS (
         SELECT 1 FROM image_job_artifacts WHERE job_id = image_jobs.id
       )
       AND (artifact_paths_json IS NULL OR artifact_paths_json = '[]')
       AND (
         status = 'queued'
         OR (status = 'generating' AND updated_at <= ?)
       )`,
    )
    .run(now, input.id, input.maxAttempts, input.staleBefore);
  return result.changes === 1;
}

export function markImageJobGenerationRetryable(
  id: string,
  expectedGenerationAttempt: number,
  error: string,
  maxAttempts: number,
  now = new Date().toISOString(),
): 'retryable' | 'failed' | 'artifact_recorded' | 'superseded' {
  return db.transaction(() => {
    if (getImageJobArtifacts(id).length > 0) {
      refreshImageJobArtifactProjection(id, now);
      return 'artifact_recorded' as const;
    }
    const job = getImageJobById(id);
    if (!job) return 'failed' as const;
    if (job.generation_attempts !== expectedGenerationAttempt) {
      return 'superseded' as const;
    }
    const status = job.generation_attempts < maxAttempts ? 'queued' : 'failed';
    db.prepare(
      `UPDATE image_jobs
       SET status = ?, updated_at = ?, last_error = ?,
           failure_notice_claimed_at = NULL,
           failure_notified_at = NULL
       WHERE id = ? AND generation_attempts = ?
         AND status IN ('generating', 'queued')`,
    ).run(status, now, error.slice(0, 1000), id, expectedGenerationAttempt);
    return status === 'queued' ? ('retryable' as const) : ('failed' as const);
  })();
}

export function markImageJobGenerationCompleted(
  id: string,
  expectedGenerationAttempt: number,
  now = new Date().toISOString(),
): boolean {
  const result = db
    .prepare(
      `UPDATE image_jobs
     SET generation_completed_at = COALESCE(generation_completed_at, ?),
         updated_at = ?
     WHERE id = ? AND generation_attempts = ?`,
    )
    .run(now, now, id, expectedGenerationAttempt);
  return result.changes === 1;
}

export function renewImageJobGenerationLease(
  id: string,
  expectedGenerationAttempt: number,
  now = new Date().toISOString(),
): boolean {
  const result = db
    .prepare(
      `UPDATE image_jobs
       SET updated_at = ?
       WHERE id = ? AND generation_attempts = ?
         AND generation_completed_at IS NULL
         AND status IN ('generating', 'generated')`,
    )
    .run(now, id, expectedGenerationAttempt);
  return result.changes === 1;
}

export function recordImageJobGenerationCalls(input: {
  id: string;
  expectedGenerationAttempt: number;
  callIds: string[];
  now?: string;
}): boolean {
  const normalized = [
    ...new Set(input.callIds.map((callId) => callId.trim()).filter(Boolean)),
  ];
  if (normalized.length === 0) return true;
  const now = input.now || new Date().toISOString();
  return db.transaction(() => {
    const job = getImageJobById(input.id);
    if (!job || job.generation_attempts !== input.expectedGenerationAttempt) {
      return false;
    }
    let existing: string[] = [];
    try {
      const parsed = job.generation_call_ids_json
        ? (JSON.parse(job.generation_call_ids_json) as unknown)
        : [];
      if (Array.isArray(parsed)) {
        existing = parsed.filter(
          (callId): callId is string => typeof callId === 'string',
        );
      }
    } catch {
      existing = [];
    }
    const merged = [...new Set([...existing, ...normalized])];
    const result = db
      .prepare(
        `UPDATE image_jobs
         SET generation_call_ids_json = ?, updated_at = ?
         WHERE id = ? AND generation_attempts = ?`,
      )
      .run(
        JSON.stringify(merged),
        now,
        input.id,
        input.expectedGenerationAttempt,
      );
    if (result.changes === 1) {
      refreshImageJobArtifactProjection(input.id, now);
    }
    return result.changes === 1;
  })();
}

export function createImageJob(input: {
  id: string;
  requestKey: string;
  chatJid: string;
  replyJid: string;
  groupFolder: string;
  promptHash: string;
  provider?: string;
  now?: string;
}): ImageJobRecord {
  const now = input.now || new Date().toISOString();
  db.prepare(
    `INSERT INTO image_jobs (
       id, request_key, chat_jid, reply_jid, group_folder, prompt_hash,
       provider, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'generating', ?, ?)
     ON CONFLICT(request_key) DO NOTHING`,
  ).run(
    input.id,
    input.requestKey,
    input.chatJid,
    input.replyJid,
    input.groupFolder,
    input.promptHash,
    input.provider || 'codex_builtin',
    now,
    now,
  );
  return getImageJobByRequestKey(input.requestKey)!;
}

export function getImageJobByRequestKey(
  requestKey: string,
): ImageJobRecord | null {
  return (
    (db
      .prepare('SELECT * FROM image_jobs WHERE request_key = ?')
      .get(requestKey) as ImageJobRecord | undefined) || null
  );
}

export function getImageJobById(id: string): ImageJobRecord | null {
  return (
    (db.prepare('SELECT * FROM image_jobs WHERE id = ?').get(id) as
      | ImageJobRecord
      | undefined) || null
  );
}

export function markImageJobGenerated(
  id: string,
  artifactPaths: string[],
  now = new Date().toISOString(),
): void {
  db.prepare(
    `UPDATE image_jobs
     SET status = 'generated', artifact_paths_json = ?, generated_at = ?,
         generation_completed_at = ?, updated_at = ?, last_error = NULL
     WHERE id = ?`,
  ).run(JSON.stringify(artifactPaths), now, now, now, id);
}

export function markImageJobDelivering(
  id: string,
  maxAttempts: number,
  now = new Date().toISOString(),
): boolean {
  const result = db
    .prepare(
      `UPDATE image_jobs
     SET status = 'delivering', delivery_attempts = delivery_attempts + 1,
         updated_at = ?, last_error = NULL
     WHERE id = ? AND status = 'generated' AND delivery_attempts < ?`,
    )
    .run(now, id, maxAttempts);
  return result.changes === 1;
}

export function markImageJobDelivered(
  id: string,
  now = new Date().toISOString(),
): void {
  db.prepare(
    `UPDATE image_jobs
     SET status = 'delivered', delivered_at = ?, updated_at = ?, last_error = NULL
     WHERE id = ?`,
  ).run(now, now, id);
}

export function markImageJobDeliveryPending(
  id: string,
  error: string,
  now = new Date().toISOString(),
): void {
  db.prepare(
    `UPDATE image_jobs
     SET status = 'generated', updated_at = ?, last_error = ?
     WHERE id = ? AND status = 'delivering'`,
  ).run(now, error.slice(0, 1000), id);
}

export function markImageJobFailed(
  id: string,
  error: string,
  now = new Date().toISOString(),
): void {
  db.prepare(
    `UPDATE image_jobs
     SET status = 'failed', updated_at = ?, last_error = ?,
         failure_notice_claimed_at = CASE WHEN status = 'failed'
           THEN failure_notice_claimed_at ELSE NULL END,
         failure_notified_at = CASE WHEN status = 'failed'
           THEN failure_notified_at ELSE NULL END
     WHERE id = ?`,
  ).run(now, error.slice(0, 1000), id);
}

export function getRecentImageJob(
  chatJid: string,
  maxAgeMs = 2 * 60 * 60 * 1000,
): ImageJobRecord | null {
  const row = db
    .prepare(
      `SELECT * FROM image_jobs
       WHERE chat_jid = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(chatJid) as ImageJobRecord | undefined;
  if (!row) return null;
  const updatedAt = new Date(row.updated_at).getTime();
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > maxAgeMs) {
    return null;
  }
  return row;
}

export function getRecoverableImageJobs(): ImageJobRecord[] {
  return db
    .prepare(
      `SELECT * FROM image_jobs
       WHERE status IN ('queued', 'generating', 'generated', 'delivering')
       ORDER BY created_at ASC`,
    )
    .all() as ImageJobRecord[];
}

export function getImageJobsPendingFailureNotice(): ImageJobRecord[] {
  return db
    .prepare(
      `SELECT * FROM image_jobs
       WHERE status = 'failed' AND failure_notified_at IS NULL
       ORDER BY updated_at ASC`,
    )
    .all() as ImageJobRecord[];
}

export function claimImageJobFailureNotice(
  id: string,
  staleBefore: string,
  now = new Date().toISOString(),
): boolean {
  const result = db
    .prepare(
      `UPDATE image_jobs
     SET failure_notice_claimed_at = ?
     WHERE id = ? AND status = 'failed' AND failure_notified_at IS NULL
       AND (
         failure_notice_claimed_at IS NULL
         OR failure_notice_claimed_at <= ?
       )`,
    )
    .run(now, id, staleBefore);
  return result.changes === 1;
}

export function releaseImageJobFailureNotice(id: string): void {
  db.prepare(
    `UPDATE image_jobs
     SET failure_notice_claimed_at = NULL
     WHERE id = ? AND failure_notified_at IS NULL`,
  ).run(id);
}

export function markImageJobFailureNotified(
  id: string,
  now = new Date().toISOString(),
): void {
  db.prepare(
    `UPDATE image_jobs
     SET failure_notified_at = ?, failure_notice_claimed_at = NULL
     WHERE id = ? AND status = 'failed' AND failure_notified_at IS NULL`,
  ).run(now, id);
}

// --- JSON migration ---

function migrateJsonState(): void {
  // Read + parse a JSON source file WITHOUT touching it. The rename to
  // `.migrated` is deliberately NOT done here: it must happen only after the
  // corresponding DB writes have committed, so a failure mid-import (crash or
  // SQLITE_FULL) leaves the source file in place to be retried on next boot
  // rather than renamed-away with only some rows imported.
  const readFile = (
    filename: string,
  ): { data: unknown; filePath: string } | null => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return { data, filePath };
    } catch {
      return null;
    }
  };

  // Mark a successfully-imported source file as migrated. Failure to rename is
  // non-fatal (the import already committed): worst case the file is re-read
  // next boot and the idempotent upserts reapply the same rows.
  const markMigrated = (filePath: string): void => {
    try {
      fs.renameSync(filePath, `${filePath}.migrated`);
    } catch (err) {
      logger.warn({ filePath, err }, 'Failed to rename migrated JSON source');
    }
  };

  // Migrate router_state.json. All writes commit in one transaction; only then
  // is the source renamed.
  const routerFile = readFile('router_state.json');
  if (routerFile) {
    const routerState = routerFile.data as {
      last_timestamp?: string;
      last_agent_timestamp?: Record<string, string>;
    };
    db.transaction(() => {
      if (routerState.last_timestamp) {
        setRouterState('last_timestamp', routerState.last_timestamp);
      }
      if (routerState.last_agent_timestamp) {
        setRouterState(
          'last_agent_timestamp',
          JSON.stringify(routerState.last_agent_timestamp),
        );
      }
    })();
    markMigrated(routerFile.filePath);
  }

  // Migrate sessions.json
  const sessionsFile = readFile('sessions.json');
  if (sessionsFile) {
    const sessions = sessionsFile.data as Record<string, string>;
    db.transaction(() => {
      for (const [folder, sessionId] of Object.entries(sessions)) {
        setSession(folder, sessionId);
      }
    })();
    markMigrated(sessionsFile.filePath);
  }

  // Migrate registered_groups.json. Invalid-folder rows are skipped (logged)
  // rather than aborting the whole import, matching the prior behavior; the
  // valid rows still commit together as one transaction before the rename.
  const groupsFile = readFile('registered_groups.json');
  if (groupsFile) {
    const groups = groupsFile.data as Record<string, RegisteredGroup>;
    db.transaction(() => {
      for (const [jid, group] of Object.entries(groups)) {
        try {
          setRegisteredGroup(jid, group);
        } catch (err) {
          logger.warn(
            { jid, folder: group.folder, err },
            'Skipping migrated registered group with invalid folder',
          );
        }
      }
    })();
    markMigrated(groupsFile.filePath);
  }
}
