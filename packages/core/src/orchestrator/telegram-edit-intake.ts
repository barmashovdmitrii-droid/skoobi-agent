import { isPrivateAdminTelegramUser } from '@skoobi/shared/private-admin';
import { createTelegramSenderIdentity, safeTelegramBotId, type OwnerAllowlistConfig } from '@skoobi/shared/telegram-identity';
import type { TelegramTenantRecord } from './tenant-registry.js';
import type { MessageRouter, NewMessage } from './types.js';
import {
  applyTelegramMessageEdit, canExecuteTelegramMessageSnapshot,
  getMessagesByIds, getTelegramMessageEditRevision,
} from './db.js';

export function telegramEditAuthorized(chatJid: string, msg: NewMessage, access: {
  groupFolder?: string;
  tenant?: TelegramTenantRecord;
  hold?: string;
  ownerAllowlist: OwnerAllowlistConfig;
  privateAdminOnly: boolean;
  senderAllowed: boolean;
}): boolean {
  const { tenant, groupFolder, ownerAllowlist } = access;
  const identity = msg.sender_identity;
  const localQuoteWithdrawal = msg.telegram_edit_local_quote === true && msg.telegram_editable === false
    && msg.content === '' && identity?.telegram_message_origin === 'quoted';
  if (msg.chat_jid !== chatJid || !groupFolder || groupFolder !== msg.telegram_edit_group_folder ||
      !tenant || tenant.folder !== groupFolder || tenant.tenant_id !== msg.tenant_id ||
      !identity || identity.chat_id !== msg.sender || identity.chat_id !== tenant.chat_id ||
      identity.telegram_user_id !== msg.sender || (identity.telegram_message_origin !== 'direct' && !localQuoteWithdrawal)) return false;
  if (!access.senderAllowed || access.hold === 'paused' || access.hold === 'banned') return false;
  if (access.privateAdminOnly && !isPrivateAdminTelegramUser({ telegramUserId: msg.sender, ownerAllowlist })) return false;
  const principal = createTelegramSenderIdentity({ chatId: tenant.chat_id, fromId: msg.sender,
    botId: tenant.bot_id, personaId: tenant.persona_id, ownerAllowlist });
  return principal.identity_id === identity.identity_id && principal.is_owner_sender === identity.is_owner_sender
    && safeTelegramBotId(principal.bot_id) === safeTelegramBotId(identity.bot_id)
    && principal.persona_id === identity.persona_id;
}

export interface TelegramEditHost {
  authorized(chatJid: string, edit: NewMessage): boolean;
  isControl(content: string): boolean;
  invalidateActive(chatJid: string, messageId: string): boolean;
  consumedThrough(chatJid: string): string;
  router: Pick<MessageRouter, 'route'>;
  noticeHeld?(chatJid: string): boolean;
  noticeFailed(): void;
}

/** Edits replace an authenticated input in place. The original cursor remains
 * the only queue position for this message, including after a restart. */
export function receiveTelegramMessageEdit(
  host: TelegramEditHost, chatJid: string, edit: NewMessage, editedAt: number,
): void {
  if (chatJid !== edit.chat_jid || !host.authorized(chatJid, edit)) return;
  const replacement = edit.telegram_editable && host.isControl(edit.content)
    ? { ...edit, content: '', telegram_editable: false } : edit;
  const result = applyTelegramMessageEdit(replacement, editedAt);
  if (result !== 'ignored') reportChangedTelegramSource(host, chatJid, edit, result);
}

export function reportChangedTelegramSource(host: TelegramEditHost, chatJid: string, edit: NewMessage,
  result: 'applied' | 'quarantined'): void {
  const active = host.invalidateActive(chatJid, edit.id);
  const revision = getTelegramMessageEditRevision(chatJid, edit.id);
  if (revision === undefined) return;
  const [stored] = getMessagesByIds(chatJid, [edit.id]);
  const alreadyHandled = active || (stored && (!canExecuteTelegramMessageSnapshot(stored)
    || (stored.ingestion_cursor && stored.ingestion_cursor <= host.consumedThrough(chatJid))));
  if (result !== 'quarantined' && !alreadyHandled) return;

  const text = result === 'quarantined'
    ? 'Увидел изменение сообщения. Чтобы я точно получил нужную формулировку, пришлите её новым сообщением.'
    : 'Учёл правку. Прежний текст уже был взят в работу. Пришлите новым сообщением то, что осталось выполнить с учётом правки.';
  const current = () => !host.noticeHeld?.(chatJid) && host.authorized(chatJid, edit)
    && getTelegramMessageEditRevision(chatJid, edit.id) === revision;
  void host.router.route({ chatJid, groupFolder: edit.telegram_edit_group_folder,
    triggerType: 'extension', text }, current).catch(() => host.noticeFailed());
}
