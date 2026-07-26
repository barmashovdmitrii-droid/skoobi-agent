import { describe, expect, it } from 'vitest';

import {
  isMultiSenderChatJid,
  telegramChatIdFromJid,
} from './telegram-jid.js';

describe('standalone runner Telegram JID parsing', () => {
  it('preserves legacy chat:thread and explicit numeric-bot forms', () => {
    expect(telegramChatIdFromJid('tg:123:456')).toBe('123');
    expect(telegramChatIdFromJid('tg:bot=9000000001:-100123:77')).toBe(
      '-100123',
    );
    expect(isMultiSenderChatJid('tg:bot=9000000001:-100123')).toBe(true);
    expect(isMultiSenderChatJid('tg:bot=9000000001:100000001')).toBe(false);
  });

  it('fails closed on empty or malformed thread segments', () => {
    for (const jid of [
      'tg:bot=9000000001:100000001:',
      'tg:skoobi_friend:100000001:',
      'tg:100000001:',
    ]) {
      expect(telegramChatIdFromJid(jid)).toBeNull();
      expect(isMultiSenderChatJid(jid)).toBe(true);
    }
  });
});
