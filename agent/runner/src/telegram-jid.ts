/**
 * Standalone Telegram JID parsing for the copied agent-runner bundle.
 * Keep this dependency-free: agent/runner is built and shipped separately
 * from the monorepo packages.
 */

const EXPLICIT_NUMERIC_BOT_PREFIX = 'bot=';

function isNumericTelegramId(value: string): boolean {
  return /^-?\d+$/.test(value);
}

export function telegramChatIdFromJid(jid: string): string | null {
  if (!jid.startsWith('tg:')) return null;
  const parts = jid.slice(3).split(':');
  if (!parts[0]) return null;

  if (parts[0].startsWith(EXPLICIT_NUMERIC_BOT_PREFIX)) {
    const botId = parts[0].slice(EXPLICIT_NUMERIC_BOT_PREFIX.length);
    if (
      !isNumericTelegramId(botId) ||
      (parts.length !== 2 && parts.length !== 3) ||
      !parts[1] ||
      (parts.length === 3 && !parts[2])
    ) {
      return null;
    }
    return parts[1];
  }

  if (!isNumericTelegramId(parts[0])) {
    if (parts.length === 1) return parts[0];
    if (
      (parts.length === 2 || parts.length === 3) &&
      parts[1] &&
      (parts.length === 2 || parts[2])
    ) {
      return parts[1];
    }
    return null;
  }

  if (
    (parts.length !== 1 && parts.length !== 2) ||
    (parts.length === 2 && !parts[1])
  ) {
    return null;
  }
  return parts[0];
}

export function isMultiSenderChatJid(jid: string): boolean {
  if (jid.endsWith('@g.us') || jid.startsWith('dc:')) return true;
  if (!jid.startsWith('tg:')) return false;
  const chatId = telegramChatIdFromJid(jid);
  // Malformed Telegram scopes fail closed: they must not regain automatic or
  // unsigned memory merely because a future/invalid prefix was not parsed.
  return chatId === null || chatId.startsWith('-');
}
