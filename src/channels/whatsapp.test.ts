import { describe, expect, it } from 'vitest';
import {
  baileysJidFromSkoobiJid,
  detectMediaKind,
  extractMessageText,
  normalizeWhatsappPhone,
  skoobiJidFromBaileysJid,
} from './whatsapp.js';

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
