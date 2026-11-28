import { getTelegramMessageEditBindingHashFrom, getTelegramMessageEditRevisionFrom } from './telegram-message-edit-store.js';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { parseTelegramJid, safeTelegramBotId } from '@skoobi/shared';
import { directSource } from './memory-source-message.js';
import type { MemoryStateSource } from './memory-state-store.js';

const completeSchemas = new WeakSet<Database.Database>();
function hasSourceTables(db: Database.Database): boolean {
  if (completeSchemas.has(db)) return true;
  const {n} = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('messages','message_metadata','message_ingestion')").get() as {n: number};
  if (n === 3) completeSchemas.add(db);
  return n === 3;
}

export type ProjectNameProof = {
  senderId: string;
  messageId: string;
  at: string;
  sha256: string;
  editRevision?: number;
  bindingHash?: string;
};

/** Verify the complete original command in its own chat/bot/profile.
 * Removing or editing a source disables only the entries it actually added. */
export function projectNameProofMatches(db: Database.Database, scopeKey: string, proof: ProjectNameProof): boolean {
  if (!proof?.senderId || !proof.messageId || !proof.sha256 || !proof.at || !hasSourceTables(db)) return false;
  const [chatJid, identityId] = JSON.parse(scopeKey) as [string, string, string];
  const jid = parseTelegramJid(chatJid);
  if (!jid) return false;
  const message = directSource(db, {
    chatJid, senderIdentity: {telegram_user_id: proof.senderId, identity_id: identityId, chat_id: jid.chatId},
  }, proof.messageId);
  if (!message || message.timestamp !== proof.at) return false;
  const identity = JSON.parse(message.sender_identity_json!);
  return (getTelegramMessageEditRevisionFrom(db, chatJid, message.id) ?? 0) === (proof.editRevision ?? 0)
    && getTelegramMessageEditBindingHashFrom(db, chatJid, message.id) === proof.bindingHash
    && identity.is_owner_sender === true && safeTelegramBotId(identity.bot_id) === safeTelegramBotId(jid.botId)
    && createHash('sha256').update(message.content).digest('hex') === proof.sha256;
}

export function projectNameProof(db: Database.Database, scopeKey: string, source: MemoryStateSource): ProjectNameProof | undefined {
  if (!source.projectNamesMessage || !source.messageId || !hasSourceTables(db)) return;
  const [chatJid] = JSON.parse(scopeKey) as [string, string, string];
  const original = db.prepare('SELECT sender FROM messages WHERE chat_jid=? AND id=?')
    .get(chatJid, source.messageId) as {sender: string} | undefined;
  if (!original) return;
  const proof = {senderId: original.sender, messageId: source.messageId,
    at: source.at, editRevision: source.messageEditRevision, bindingHash: source.messageBindingHash, sha256: createHash('sha256').update(source.projectNamesMessage).digest('hex')};
  return projectNameProofMatches(db, scopeKey, proof) ? proof : undefined;
}
