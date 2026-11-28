import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { telegramJidForChatId } from '@skoobi/shared/telegram-identity';
import { defaultTelegramIdentityId } from '@skoobi/shared/telegram-jid';
import { isValidGroupFolder } from './group-folder.js';
import type { NewMessage } from './types.js';

type Db = Database.Database;
export type TelegramEditResult = 'applied' | 'quarantined' | 'ignored';

interface EditState {
  binding_hash: string;
  sequence: number;
  original_hash: string | null;
  observed_hash: string | null;
  last_edit: number | null;
  uncertain: number;
  revision: number;
  admitted_revision: number | null;
}

export function ensureTelegramMessageEditSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_text_edit_state (
      chat_jid TEXT NOT NULL,
      id TEXT NOT NULL,
      binding_hash TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      tenant_id TEXT,
      group_folder TEXT NOT NULL,
      original_hash TEXT,
      observed_hash TEXT,
      last_edit INTEGER,
      uncertain INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      admitted_revision INTEGER,
      PRIMARY KEY(chat_jid, id, binding_hash)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS telegram_text_edit_original
    ON telegram_text_edit_state(chat_jid, id) WHERE original_hash IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS telegram_text_edit_delete AFTER DELETE ON messages
    BEGIN
      DELETE FROM telegram_text_edit_state WHERE chat_jid = OLD.chat_jid AND id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS telegram_chat_edit_delete AFTER DELETE ON chats
    BEGIN
      DELETE FROM telegram_text_edit_state WHERE chat_jid = OLD.jid;
    END;
  `);
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function binding(msg: NewMessage, allowQuotedRevocation = false): string | undefined {
  const sender = msg.sender_identity;
  if (!sender || !(sender.telegram_message_origin === 'direct' ||
    (allowQuotedRevocation && sender.telegram_message_origin === 'quoted')) || sender.channel !== 'telegram'
    || sender.telegram_user_id !== msg.sender || sender.chat_id !== msg.sender
    || !/^[1-9]\d*$/.test(msg.sender) || sender.identity_id !== defaultTelegramIdentityId(msg.sender)
    || !sender.bot_id || telegramJidForChatId(msg.sender, sender.bot_id) !== msg.chat_jid
    || !msg.telegram_receiver_id || !/^[1-9]\d*$/.test(msg.telegram_receiver_id)
    || !msg.telegram_edit_group_folder || !isValidGroupFolder(msg.telegram_edit_group_folder)
    || !/^[1-9]\d*$/.test(msg.id) || !Number.isFinite(Date.parse(msg.timestamp))
    || msg.is_from_me || msg.is_bot_message) return undefined;
  return hash(JSON.stringify([msg.chat_jid, msg.id, msg.timestamp, sender.identity_id, sender.bot_id,
    sender.persona_id ?? null, sender.is_owner_sender, msg.tenant_id ?? null, msg.telegram_receiver_id,
    msg.telegram_edit_group_folder]));
}

function state(db: Db, msg: Pick<NewMessage, 'id' | 'chat_jid'>): EditState | undefined {
  return db.prepare(`SELECT te.*, mi.sequence FROM telegram_text_edit_state te
    JOIN message_ingestion mi ON mi.chat_jid = te.chat_jid AND mi.id = te.id
    WHERE te.chat_jid = ? AND te.id = ? AND te.original_hash IS NOT NULL`)
    .get(msg.chat_jid, msg.id) as EditState | undefined;
}

function earlyBarrier(db: Db, msg: NewMessage, scope: string): number | undefined {
  return db.prepare(`SELECT last_edit FROM telegram_text_edit_state
    WHERE chat_jid = ? AND id = ? AND binding_hash = ? AND original_hash IS NULL`)
    .pluck().get(msg.chat_jid, msg.id, scope) as number | undefined;
}

function clearEarlyBarriers(db: Db, msg: NewMessage): void {
  db.prepare('DELETE FROM telegram_text_edit_state WHERE chat_jid = ? AND id = ? AND original_hash IS NULL')
    .run(msg.chat_jid, msg.id);
}

function seed(db: Db, msg: NewMessage, scope: string, original: string | null, edit: number | null): void {
  db.prepare(`INSERT INTO telegram_text_edit_state
    (chat_jid, id, binding_hash, receiver_id, tenant_id, group_folder, original_hash, observed_hash, last_edit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(msg.chat_jid, msg.id, scope, msg.telegram_receiver_id, msg.tenant_id ?? null,
      msg.telegram_edit_group_folder, original, original, edit);
}

function exists(db: Db, msg: NewMessage): boolean {
  return !!db.prepare('SELECT 1 FROM messages WHERE chat_jid = ? AND id = ?').get(msg.chat_jid, msg.id);
}

function quarantine(db: Db, msg: NewMessage, alreadyUncertain: number): TelegramEditResult {
  if (alreadyUncertain) return 'ignored';
  // Some readers (including memory source verification) use messages.content
  // directly. Make the ambiguous bytes unavailable to all of them atomically.
  db.prepare("UPDATE messages SET content = '' WHERE chat_jid = ? AND id = ?").run(msg.chat_jid, msg.id);
  db.prepare(`UPDATE telegram_text_edit_state SET uncertain = 1, revision = revision + 1
    WHERE chat_jid = ? AND id = ?`).run(msg.chat_jid, msg.id);
  return 'quarantined';
}

/** Called inside the original ingress transaction, before its normal UPSERT. Signals a newly quarantined original for one host notice. */
export function storeTelegramOriginal(db: Db, msg: NewMessage, writeMessage: () => void): boolean {
  if (!msg.chat_jid.startsWith('tg:') || !/^[1-9]\d*$/.test(msg.id)) {
    writeMessage();
    return false;
  }
  const row = state(db, msg);
  const scope = msg.telegram_editable === true && msg.content.trim() ? binding(msg) : undefined;
  if (row?.original_hash) {
    // A channel replay cannot roll the latest correction back, adopt new
    // provenance, nor repair a quarantined row with a historical original.
    return scope === row.binding_hash && hash(msg.content) !== row.original_hash
      && quarantine(db, msg, row.uncertain) === 'quarantined';
  }
  if (!scope) {
    writeMessage();
    clearEarlyBarriers(db, msg);
    return false;
  }
  // Existing history lacks the adapter's positive direct-text proof. Receiving
  // a duplicate after upgrade must not retroactively confer such authority.
  if (exists(db, msg)) return false;
  writeMessage();
  const original = hash(msg.content);
  const early = earlyBarrier(db, msg, scope);
  clearEarlyBarriers(db, msg);
  seed(db, msg, scope, original, early ?? null);
  return early !== undefined && quarantine(db, msg, 0) === 'quarantined';
}

export function applyTelegramEdit(db: Db, msg: NewMessage, editedAt: number): TelegramEditResult {
  // A user can add blockquote formatting to their own ordinary text. The
  // adapter can revoke its prior direct status, never import the quoted words.
  const quotedRevocation = msg.telegram_edit_local_quote === true && msg.telegram_editable === false && msg.content === ''
    && msg.sender_identity?.telegram_message_origin === 'quoted';
  const scope = binding(msg, quotedRevocation);
  if (!scope || typeof msg.telegram_editable !== 'boolean'
    || (msg.telegram_editable ? !msg.content.trim() : msg.content !== '')
    || !Number.isSafeInteger(editedAt) || editedAt < Math.floor(Date.parse(msg.timestamp) / 1000)) return 'ignored';
  return db.transaction((): TelegramEditResult => {
    const row = state(db, msg);
    if (row && row.binding_hash !== scope) return 'ignored';
    if (!row?.original_hash) {
      if (exists(db, msg)) return 'ignored';
      // No original yet. Keep only an exact, body-free time barrier per
      // verified source. Never merge different messages or receiving accounts.
      const early = earlyBarrier(db, msg, scope);
      if (early === undefined) seed(db, msg, scope, null, editedAt);
      else if (editedAt > early) db.prepare(`UPDATE telegram_text_edit_state SET last_edit = ?
        WHERE chat_jid = ? AND id = ? AND binding_hash = ? AND original_hash IS NULL`)
        .run(editedAt, msg.chat_jid, msg.id, scope);
      return 'ignored';
    }
    if (row.last_edit !== null && editedAt < row.last_edit) return 'ignored';
    const observed = msg.telegram_editable ? hash(msg.content) : null;
    if (row.last_edit === editedAt) {
      return observed === row.observed_hash ? 'ignored' : quarantine(db, msg, row.uncertain);
    }
    db.prepare(`UPDATE telegram_text_edit_state SET last_edit = ?, observed_hash = ?
      WHERE chat_jid = ? AND id = ?`).run(editedAt, observed, msg.chat_jid, msg.id);
    if (!msg.telegram_editable) return quarantine(db, msg, row.uncertain);
    if (!row.uncertain && row.observed_hash === observed) return 'ignored';
    db.prepare('UPDATE messages SET content = ? WHERE chat_jid = ? AND id = ?')
      .run(msg.content, msg.chat_jid, msg.id);
    db.prepare(`UPDATE telegram_text_edit_state SET revision = revision + 1, uncertain = 0
      WHERE chat_jid = ? AND id = ?`).run(msg.chat_jid, msg.id);
    return 'applied';
  }).immediate();
}

function legacyCompatibleState(db: Db, chatJid: string, id: string): EditState | undefined {
  if (!chatJid.startsWith('tg:')) return undefined;
  // Isolated memory stores can have no message ingress schema at all.
  if (db.prepare("SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name IN ('telegram_text_edit_state','message_ingestion')").pluck().get() !== 2) {
    return undefined;
  }
  return state(db, { chat_jid: chatJid, id });
}

export function getTelegramMessageEditRevisionFrom(db: Db, chatJid: string, id: string): number | undefined {
  const row = legacyCompatibleState(db, chatJid, id);
  return row?.original_hash ? row.revision : undefined;
}

/** Distinguishes a retained source from a new insertion even if its Telegram
 * id, original date, sender and text are all identical. Edits keep this hash. */
export function getTelegramMessageEditBindingHashFrom(db: Db, chatJid: string, id: string): string | undefined {
  const row = legacyCompatibleState(db, chatJid, id);
  return row ? hash(JSON.stringify([row.binding_hash, row.sequence])) : undefined;
}

export function isTelegramMessageAdmissionCurrentFrom(db: Db, chatJid: string, id: string): boolean {
  const row = legacyCompatibleState(db, chatJid, id);
  return !row?.original_hash || (!row.uncertain && (row.admitted_revision === null || row.admitted_revision === row.revision));
}

function snapshotMatches(msg: NewMessage, row?: EditState): boolean {
  if (!row?.original_hash) return !msg.telegram_editable && msg.telegram_edit_revision === undefined;
  return !row.uncertain && row.revision === (msg.telegram_edit_revision ?? 0)
    && (!msg.ingestion_cursor || msg.ingestion_cursor === 'i:' + String(row.sequence).padStart(16, '0'))
    && binding(msg) === row.binding_hash && hash(msg.content) === row.observed_hash;
}

export function currentTelegramSnapshot(db: Db, msg: NewMessage, forExecution = false): boolean {
  if (!msg.chat_jid.startsWith('tg:')) return true;
  const row = state(db, msg);
  return snapshotMatches(msg, row) && (!forExecution || row?.admitted_revision == null || row.admitted_revision === row.revision);
}

export function admitTelegramSnapshots(db: Db, messages: readonly NewMessage[]): boolean {
  const candidates = messages.filter(msg => msg.chat_jid.startsWith('tg:'));
  if (!candidates.length) return true;
  return db.transaction(() => {
    if (!candidates.every(msg => currentTelegramSnapshot(db, msg, true))) return false;
    const admit = db.prepare(`UPDATE telegram_text_edit_state SET admitted_revision = revision
      WHERE chat_jid = ? AND id = ? AND admitted_revision IS NULL AND original_hash IS NOT NULL`);
    for (const msg of candidates) admit.run(msg.chat_jid, msg.id);
    return true;
  }).immediate();
}
