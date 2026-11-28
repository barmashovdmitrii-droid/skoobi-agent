import type Database from 'better-sqlite3';
import { parseTelegramJid } from '@skoobi/shared';
import type { MemoryStateScope } from '../src/orchestrator/memory-state-store.js';

export function ownerReadNameSource(db: Database.Database, scope: MemoryStateScope,
  id: string, at: string, content: string, fromId?: string) {
  const jid = parseTelegramJid(scope.chatJid)!;
  const sender = fromId ?? jid.chatId;
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (chat_jid TEXT,id TEXT,sender TEXT,content TEXT,timestamp TEXT,is_bot_message INTEGER,PRIMARY KEY(chat_jid,id));
    CREATE TABLE IF NOT EXISTS message_metadata (chat_jid TEXT,id TEXT,sender_identity_json TEXT,PRIMARY KEY(chat_jid,id));
    CREATE TABLE IF NOT EXISTS message_ingestion (sequence INTEGER PRIMARY KEY AUTOINCREMENT,chat_jid TEXT,id TEXT,UNIQUE(chat_jid,id));
  `);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='chats'").get())
    db.prepare('INSERT OR IGNORE INTO chats(jid,name,last_message_time) VALUES(?,?,?)').run(scope.chatJid,'Fixture',at);
  db.prepare('INSERT OR REPLACE INTO messages(chat_jid,id,sender,content,timestamp,is_bot_message) VALUES(?,?,?,?,?,0)')
    .run(scope.chatJid,id,sender,content,at);
  db.prepare('INSERT OR IGNORE INTO message_ingestion(chat_jid,id) VALUES(?,?)').run(scope.chatJid,id);
  db.prepare('INSERT OR REPLACE INTO message_metadata(chat_jid,id,sender_identity_json) VALUES(?,?,?)')
    .run(scope.chatJid,id,JSON.stringify({channel:'telegram',chat_id:jid.chatId,bot_id:jid.botId,identity_id:scope.identityId,
      telegram_user_id:sender,telegram_message_origin:'direct',is_owner_sender:true}));
  return {kind:'direct_user' as const,at,messageId:id,quote:content,currentDirectInput:true,projectNamesMessage:content};
}
