import type Database from 'better-sqlite3';

export interface SourceMessage {
  id: string;
  sender: string;
  content: string;
  timestamp: string;
  is_bot_message: number;
  sender_identity_json: string | null;
  sequence: number;
}
type SourceContext = { chatJid: string; senderIdentity: { telegram_user_id?: string; identity_id?: string; chat_id?: string } };
export function directSource(
  db: Database.Database,
  context: SourceContext,
  messageId: string,
): SourceMessage | null {
  const row = db
    .prepare(
      `SELECT m.id,m.sender,m.content,m.timestamp,m.is_bot_message,mm.sender_identity_json,mi.sequence
    FROM messages m JOIN message_ingestion mi ON mi.id=m.id AND mi.chat_jid=m.chat_jid
    LEFT JOIN message_metadata mm ON mm.id=m.id AND mm.chat_jid=m.chat_jid WHERE m.chat_jid=? AND m.id=?`,
    )
    .get(context.chatJid, messageId) as SourceMessage | undefined;
  return verifyDirectRow(row, context);
}

export function directTurnsAfter(db: Database.Database, context: SourceContext, sequence: number): SourceMessage[] | undefined {
  const rows = db.prepare(`SELECT m.id,m.sender,m.content,m.timestamp,m.is_bot_message,mm.sender_identity_json,mi.sequence
    FROM message_ingestion mi JOIN messages m ON m.chat_jid=mi.chat_jid AND m.id=mi.id
    LEFT JOIN message_metadata mm ON mm.chat_jid=m.chat_jid AND mm.id=m.id
    WHERE m.chat_jid=? AND m.sender=? AND m.is_bot_message=0 AND mi.sequence>?
    ORDER BY mi.sequence LIMIT 201`).all(context.chatJid, context.senderIdentity.telegram_user_id, sequence) as SourceMessage[];
  if (rows.length > 200) return;
  return rows.map(row => verifyDirectRow(row, context)).filter(row => row !== null);
}

function verifyDirectRow(row: SourceMessage | undefined, context: SourceContext): SourceMessage | null {
  if (
    !row ||
    row.is_bot_message ||
    row.sender !== context.senderIdentity.telegram_user_id
  )
    return null;
  try {
    const identity = JSON.parse(row.sender_identity_json || 'null');
    if (
      identity?.telegram_message_origin !== 'direct' ||
      identity.identity_id !== context.senderIdentity.identity_id ||
      identity.telegram_user_id !== context.senderIdentity.telegram_user_id ||
      identity.chat_id !== context.senderIdentity.chat_id ||
      identity.channel !== 'telegram'
    )
      return null;
  } catch {
    return null;
  }
  // Telegram's durable cursor embeds message_id below millisecond precision.
  // Memory stores canonical wall time; messageId remains the tie-breaker for
  // sources in the same millisecond. Do not alter the original message cursor.
  const timestamp = Date.parse(row.timestamp);
  if (!Number.isFinite(timestamp)) return null;
  return { ...row, timestamp: new Date(timestamp).toISOString() };
}
