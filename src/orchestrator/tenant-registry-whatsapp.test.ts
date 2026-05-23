import { describe, expect, it } from 'vitest';
import {
  createWhatsAppSenderIdentity,
  defaultWhatsappTenantId,
  parseOwnerAllowlistConfig,
  parseTenantJson,
  TenantRegistry,
  whatsappJidToChatId,
} from './tenant-registry.js';
import type { RegisteredGroup } from './types.js';

describe('whatsappJidToChatId', () => {
  it('strips wa: prefix and non-digits', () => {
    expect(whatsappJidToChatId('wa:77026132017')).toBe('77026132017');
    expect(whatsappJidToChatId('wa:7-701-000-00-00')).toBe('77010000000');
  });
  it('returns null for non-wa jids', () => {
    expect(whatsappJidToChatId('tg:12345')).toBeNull();
    expect(whatsappJidToChatId('77010000000@s.whatsapp.net')).toBeNull();
  });
});

describe('defaultWhatsappTenantId', () => {
  it('returns wa_chat_<sanitized>', () => {
    expect(defaultWhatsappTenantId('77026132017')).toBe('wa_chat_77026132017');
  });
  it('handles empty', () => {
    expect(defaultWhatsappTenantId('')).toBe('wa_chat_unknown');
  });
});

describe('parseTenantJson with whatsapp channel', () => {
  it('accepts whatsapp channel', () => {
    const t = parseTenantJson({
      tenant_id: 'autoparts',
      folder: 'autoparts',
      channel: 'whatsapp',
      chat_id: '77026132017',
    });
    expect(t.channel).toBe('whatsapp');
    expect(t.tenant_id).toBe('autoparts');
  });
  it('still accepts telegram channel', () => {
    const t = parseTenantJson({ channel: 'telegram', chat_id: '111' });
    expect(t.channel).toBe('telegram');
  });
  it('rejects unknown channel', () => {
    expect(() => parseTenantJson({ channel: 'sms' })).toThrow(
      /Unsupported tenant channel/,
    );
  });
});

describe('parseOwnerAllowlistConfig with whatsapp_phones', () => {
  it('normalizes whatsapp phones', () => {
    const c = parseOwnerAllowlistConfig({
      OWNER_WHATSAPP_PHONES: '+7 (701) 000-00-00, 77026132017',
    });
    expect(c.whatsapp_phones?.has('77010000000')).toBe(true);
    expect(c.whatsapp_phones?.has('77026132017')).toBe(true);
  });
  it('returns empty set when no phones', () => {
    const c = parseOwnerAllowlistConfig({});
    expect(c.whatsapp_phones?.size ?? 0).toBe(0);
  });
});

describe('createWhatsAppSenderIdentity', () => {
  it('builds identity with phone and is_owner_sender=false by default', () => {
    const id = createWhatsAppSenderIdentity({ phone: '77026132017' });
    expect(id.channel).toBe('whatsapp');
    expect(id.whatsapp_phone).toBe('77026132017');
    expect(id.chat_id).toBe('77026132017');
    expect(id.telegram_user_id).toBe('');
    expect(id.is_owner_sender).toBe(false);
  });
  it('flags owner when phone in allowlist', () => {
    const allow = parseOwnerAllowlistConfig({
      OWNER_WHATSAPP_PHONES: '77026132017',
    });
    const id = createWhatsAppSenderIdentity({
      phone: '+7 702 613 20 17',
      ownerAllowlist: allow,
    });
    expect(id.is_owner_sender).toBe(true);
  });
});

describe('TenantRegistry: whatsapp branch', () => {
  it('indexes whatsapp tenants by chat id', () => {
    const groups: Record<string, RegisteredGroup> = {
      'wa:77026132017': {
        name: 'Customer',
        folder: 'autoparts',
        trigger: '',
        added_at: '2026-05-23T00:00:00Z',
      },
    };
    const reg = TenantRegistry.fromRegisteredGroups(groups, {
      groupsDir: '/nonexistent',
    });
    const tenant = reg.resolveWhatsappJid('wa:77026132017');
    expect(tenant).toBeDefined();
    expect(tenant?.channel).toBe('whatsapp');
    expect(tenant?.chat_id).toBe('77026132017');
    expect(tenant?.tenant_id).toBe('wa_chat_77026132017');
  });

  it('keeps telegram and whatsapp registries separate', () => {
    const groups: Record<string, RegisteredGroup> = {
      'wa:111': {
        name: 'wa',
        folder: 'wa-folder',
        trigger: '',
        added_at: '2026-05-23T00:00:00Z',
      },
      'tg:222': {
        name: 'tg',
        folder: 'tg-folder',
        trigger: '',
        added_at: '2026-05-23T00:00:00Z',
      },
    };
    const reg = TenantRegistry.fromRegisteredGroups(groups, {
      groupsDir: '/nonexistent',
    });
    expect(reg.resolveWhatsappChat('111')).toBeDefined();
    expect(reg.resolveTelegramChat('222')).toBeDefined();
    expect(reg.resolveWhatsappChat('222')).toBeUndefined();
    expect(reg.resolveTelegramChat('111')).toBeUndefined();
    expect(reg.all().length).toBe(2);
  });
});
