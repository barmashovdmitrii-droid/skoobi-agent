// Чистые утилиты формата tg:-JID (парсинг chat/bot/thread из строкового
// идентификатора) — вынесены из orchestrator/tenant-registry в @skoobi/shared
// (волна 5 модуляризации): нужны и ядру, и пакету памяти (скоуп памяти по
// tenant/identity), позже — каналу telegram. Ни I/O, ни env — только текст.

function isTelegramChatIdSegment(value: string): boolean {
  return /^-?\d+$/.test(value);
}

// `tg:<number>:<number>` is already the legacy chat:thread representation, so
// an all-numeric bot id needs a reserved, non-chat marker to round-trip without
// changing existing symbolic-bot or thread JIDs. `=` cannot occur in a bot id
// after safeTelegramBotId(), making this prefix unambiguous.
const EXPLICIT_NUMERIC_BOT_PREFIX = 'bot=';

export function telegramBotIdJidSegment(botId: string): string {
  return isTelegramChatIdSegment(botId)
    ? `${EXPLICIT_NUMERIC_BOT_PREFIX}${botId}`
    : botId;
}

export function parseTelegramJid(
  jid: string,
): { botId?: string; chatId: string; threadId?: string } | null {
  if (!jid.startsWith('tg:')) return null;
  const value = jid.slice(3);
  if (!value) return null;
  const parts = value.split(':');
  if (parts[0].startsWith(EXPLICIT_NUMERIC_BOT_PREFIX)) {
    const botId = parts[0].slice(EXPLICIT_NUMERIC_BOT_PREFIX.length);
    // This explicit form is emitted only for the otherwise ambiguous numeric
    // bot-id case. Reject malformed marker strings rather than silently
    // treating them as a legacy symbolic bot.
    if (
      !isTelegramChatIdSegment(botId) ||
      (parts.length !== 2 && parts.length !== 3) ||
      !parts[1] ||
      (parts.length === 3 && !parts[2])
    ) {
      return null;
    }
    return {
      botId,
      chatId: parts[1],
      threadId: parts[2],
    };
  }
  if (!isTelegramChatIdSegment(parts[0])) {
    if (
      (parts.length !== 2 && parts.length !== 3) ||
      !parts[1] ||
      (parts.length === 3 && !parts[2])
    ) {
      // Preserve the historical single-segment non-numeric chat form used by
      // local tools while rejecting malformed bot-prefixed identifiers.
      return parts.length === 1 ? { chatId: parts[0] } : null;
    }
    return {
      botId: parts[0],
      chatId: parts[1],
      threadId: parts[2],
    };
  }
  if (
    (parts.length !== 1 && parts.length !== 2) ||
    (parts.length === 2 && !parts[1])
  ) {
    return null;
  }
  return {
    chatId: parts[0],
    threadId: parts[1],
  };
}

export function telegramJidToBotId(jid: string): string | undefined {
  return parseTelegramJid(jid)?.botId;
}

export function defaultTelegramIdentityId(fromId: string | number): string {
  const safe = String(fromId).trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return `telegram_user_${safe || 'unknown'}`;
}
