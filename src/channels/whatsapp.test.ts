import { describe, expect, it } from 'vitest';
import {
  baileysJidFromSkoobiJid,
  detectMediaKind,
  extractMessageText,
  normalizeWhatsappPhone,
  skoobiJidFromBaileysJid,
  WhatsAppChannel,
} from './whatsapp.js';
import type { NewMessage, RegisteredGroup } from '../orchestrator/types.js';

describe('normalizeWhatsappPhone', () => {
  it('strips +, spaces, parens, dashes', () => {
    expect(normalizeWhatsappPhone('+7 (701) 000-00-00')).toBe('77010000000');
  });
  it('converts leading 8 → 7 for 11-digit CIS numbers', () => {
    expect(normalizeWhatsappPhone('8 (701) 000-00-00')).toBe('77010000000');
  });
  it('leaves non-11-digit numbers alone', () => {
    expect(normalizeWhatsappPhone('+1 415 555 1234')).toBe('14155551234');
  });
  it('returns empty for empty input', () => {
    expect(normalizeWhatsappPhone('')).toBe('');
  });
});

describe('skoobiJidFromBaileysJid', () => {
  it('maps user JID', () => {
    expect(skoobiJidFromBaileysJid('77010000000@s.whatsapp.net')).toBe(
      'wa:77010000000',
    );
  });
  it('strips device suffix', () => {
    expect(skoobiJidFromBaileysJid('77010000000:5@s.whatsapp.net')).toBe(
      'wa:77010000000',
    );
  });
  it('returns null for group JIDs', () => {
    expect(skoobiJidFromBaileysJid('123-456@g.us')).toBeNull();
  });
  it('returns null for status broadcast', () => {
    expect(skoobiJidFromBaileysJid('status@broadcast')).toBeNull();
  });
});

describe('baileysJidFromSkoobiJid', () => {
  it('maps back to user JID', () => {
    expect(baileysJidFromSkoobiJid('wa:77010000000')).toBe(
      '77010000000@s.whatsapp.net',
    );
  });
  it('rejects non-wa prefix', () => {
    expect(baileysJidFromSkoobiJid('tg:12345')).toBeNull();
  });
  it('rejects empty digits', () => {
    expect(baileysJidFromSkoobiJid('wa:')).toBeNull();
  });
});

describe('extractMessageText', () => {
  it('reads conversation', () => {
    expect(
      extractMessageText({
        key: { id: '1' },
        message: { conversation: 'Hello' },
      } as any),
    ).toBe('Hello');
  });
  it('reads extendedTextMessage', () => {
    expect(
      extractMessageText({
        key: { id: '1' },
        message: { extendedTextMessage: { text: 'World' } },
      } as any),
    ).toBe('World');
  });
  it('reads image caption', () => {
    expect(
      extractMessageText({
        key: { id: '1' },
        message: { imageMessage: { caption: 'cap' } },
      } as any),
    ).toBe('cap');
  });
  it('returns empty when no body', () => {
    expect(extractMessageText({ key: { id: '1' }, message: null } as any)).toBe(
      '',
    );
  });
});

describe('detectMediaKind', () => {
  it('returns image for imageMessage', () => {
    expect(
      detectMediaKind({
        key: { id: '1' },
        message: { imageMessage: {} },
      } as any),
    ).toBe('image');
  });
  it('returns document for documentMessage', () => {
    expect(
      detectMediaKind({
        key: { id: '1' },
        message: { documentMessage: {} },
      } as any),
    ).toBe('document');
  });
  it('returns null when no media', () => {
    expect(
      detectMediaKind({
        key: { id: '1' },
        message: { conversation: 'plain' },
      } as any),
    ).toBeNull();
  });
});

function createHarness() {
  const groups: Record<string, RegisteredGroup> = {};
  const messages: NewMessage[] = [];
  const metadata: Array<{
    jid: string;
    displayName?: string;
    channel?: string;
  }> = [];
  const channel = new WhatsAppChannel({
    authDir: '/tmp/skoobi-wa-test-auth',
    defaultFolder: 'main',
    onMessage: (_jid, message) => messages.push(message),
    onChatMetadata: (jid, _timestamp, displayName, channelName) => {
      metadata.push({ jid, displayName, channel: channelName });
    },
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
    },
  });
  return { channel, groups, messages, metadata };
}

describe('WhatsAppChannel inbound handling', () => {
  it('uses per-chat unique folder, not the shared defaultFolder', () => {
    const { channel, groups } = createHarness();

    (channel as any).handleInbound({
      key: {
        id: 'm1',
        fromMe: false,
        remoteJid: '77010000000@s.whatsapp.net',
      },
      message: { conversation: 'hello' },
      pushName: 'Customer',
      messageTimestamp: 1_700_000_000,
    });

    expect(groups['wa:77010000000']).toMatchObject({
      name: 'Customer',
      folder: 'main__wa_77010000000',
      requiresTrigger: false,
    });
    expect(groups['wa:77010000000'].folder).not.toBe('main');
  });

  it('falls back to remoteJidAlt when remoteJid is a LID', () => {
    const { channel, messages, metadata } = createHarness();

    (channel as any).handleInbound({
      key: {
        id: 'm1',
        fromMe: false,
        remoteJid: '123456789@lid',
        remoteJidAlt: '77010000000@s.whatsapp.net',
      },
      message: { conversation: 'hello from lid' },
      pushName: 'LID Customer',
      messageTimestamp: 1_700_000_000,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      chat_jid: 'wa:77010000000',
      sender: '77010000000',
      content: 'hello from lid',
    });
    expect(metadata[0]).toMatchObject({
      jid: 'wa:77010000000',
      displayName: 'LID Customer',
      channel: 'whatsapp',
    });
  });
});
