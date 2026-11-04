import type Database from 'better-sqlite3';
import type { NewMessage } from '@skoobi/shared/channel-types';
import type { MediaIntakeInput, MediaIntakeScope } from '@skoobi/shared/media-intake';
import { safeTelegramBotId } from '@skoobi/shared/telegram-identity';
import { parseTelegramJid } from '@skoobi/shared/telegram-jid';
import type { TenantRegistry } from './tenant-registry.js';
import {
  acknowledgeMediaIntakeDispatch,
  cancelMediaIntakeBefore,
  pendingMediaIntakeDispatches,
} from './media-intake-store.js';

/** Resolve from current host registration, not a replayed tenant/owner claim. */
export function resolveTelegramMediaScope(
  registry: TenantRegistry,
  botId: string | undefined,
  input: MediaIntakeInput,
): MediaIntakeScope | undefined {
  const parsed = parseTelegramJid(input.message.chat_jid);
  const tenant = registry.resolveTelegramJid(input.message.chat_jid);
  const boundBot = safeTelegramBotId(botId);
  if (!parsed || !tenant || safeTelegramBotId(tenant.bot_id) !== boundBot ||
      (parsed.botId && safeTelegramBotId(parsed.botId) !== boundBot)) return undefined;
  const identity = input.message.sender_identity;
  if (identity && (identity.channel !== 'telegram' || identity.chat_id !== parsed.chatId ||
      identity.telegram_user_id !== input.message.sender ||
      safeTelegramBotId(identity.bot_id) !== boundBot ||
      (identity.telegram_message_origin !== undefined &&
       !['direct', 'forwarded', 'quoted'].includes(identity.telegram_message_origin)))) return undefined;
  return { botId: boundBot, tenantId: tenant.tenant_id, chatJid: input.message.chat_jid,
    groupFolder: tenant.folder };
}

/** A reserved empty media input is a frontier, never a command for the model.
 * Display timestamps cannot substitute for the durable ordering cursor.
 */
export function messagesBeforePendingMedia<T extends Pick<NewMessage, 'ingestion_cursor'>>(
  messages: readonly T[],
  earliestPendingCursor: string | undefined,
): T[] {
  if (earliestPendingCursor === undefined) return [...messages];
  if (!/^i:\d{16}$/.test(earliestPendingCursor)) return [];
  return messages.filter(message => typeof message.ingestion_cursor === 'string' &&
    /^i:\d{16}$/.test(message.ingestion_cursor) && message.ingestion_cursor < earliestPendingCursor);
}

/** Host control must not be hidden behind a 200-message agent-input page.
 * The indexed reverse scan returns only an exact direct-owner stop, never a
 * broad historical batch for the model. The parser is host code, not SQL input.
 */
export function latestPendingMediaStop(
  database: Database.Database,
  chatJid: string,
  afterCursor: string,
  isStop: (text: string) => boolean,
): NewMessage | undefined {
  if (!/^i:\d{16}$/.test(afterCursor)) return undefined;
  database.function('skoobi_media_direct_stop', { deterministic: true }, (content, identityJson, sender) => {
    try {
      if (typeof content !== 'string' || content.length > 256 || typeof identityJson !== 'string') return 0;
      const identity = JSON.parse(identityJson);
      return identity?.channel === 'telegram' && identity.is_owner_sender === true &&
        identity.telegram_message_origin === 'direct' && identity.telegram_user_id === sender && isStop(content) ? 1 : 0;
    } catch { return 0; }
  });
  const row = database.prepare(`SELECT m.*, mi.sequence, mm.sender_identity_json, mm.telegram_update_id
    FROM message_ingestion mi JOIN messages m ON m.id=mi.id AND m.chat_jid=mi.chat_jid
    JOIN message_metadata mm ON mm.id=m.id AND mm.chat_jid=m.chat_jid
    WHERE mi.chat_jid=? AND mi.sequence>? AND m.is_bot_message=0
      AND skoobi_media_direct_stop(m.content,mm.sender_identity_json,m.sender)=1
    ORDER BY mi.sequence DESC LIMIT 1`).get(chatJid, Number(afterCursor.slice(2))) as
    (NewMessage & { sequence: number; sender_identity_json: string }) | undefined;
  if (!row) return undefined;
  return { id: row.id, chat_jid: row.chat_jid, sender: row.sender, sender_name: row.sender_name,
    content: row.content, timestamp: row.timestamp, is_bot_message: false,
    is_from_me: row.is_from_me === true || (row.is_from_me as unknown) === 1,
    ingestion_cursor: `i:${String(row.sequence).padStart(16, '0')}`,
    sender_identity: JSON.parse(row.sender_identity_json), telegram_update_id: row.telegram_update_id };
}

/** The caller selects an actual stop with the existing host command parser. */
export function cancelMediaForDirectOwnerStop(
  database: Database.Database,
  scope: MediaIntakeScope,
  stop: NewMessage,
): number {
  const identity = stop.sender_identity;
  if (stop.chat_jid !== scope.chatJid || stop.is_bot_message === true || (stop.is_bot_message as unknown) === 1 ||
      !identity || identity.is_owner_sender !== true || identity.telegram_message_origin !== 'direct' ||
      identity.telegram_user_id !== stop.sender || identity.chat_id !== parseTelegramJid(scope.chatJid)?.chatId ||
      safeTelegramBotId(identity.bot_id) !== scope.botId || !stop.ingestion_cursor) return 0;
  return cancelMediaIntakeBefore(database, scope, stop.sender, stop.ingestion_cursor);
}

/** A failed queue admission leaves a durable wakeup, including after restart. */
export function dispatchMaterializedMedia(
  database: Database.Database,
  enqueue: (chatJid: string) => boolean,
): number {
  let accepted = 0;
  for (const pending of pendingMediaIntakeDispatches(database)) {
    if (enqueue(pending.chatJid)) {
      acknowledgeMediaIntakeDispatch(database, pending.jobId);
      accepted++;
    }
  }
  return accepted;
}
