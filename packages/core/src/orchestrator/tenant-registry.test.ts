import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTelegramSenderIdentity,
  defaultTelegramIdentityId,
  defaultTelegramTenantId,
  parseTelegramJid,
  parseOwnerAllowlistConfig,
  parseSkoobiRuntimeMode,
  parseTenantJson,
  telegramJidForChatId,
  telegramJidToBotId,
  telegramJidToChatId,
  trustedTelegramTenantId,
  TenantRegistry,
} from './tenant-registry.js';
import type { RegisteredGroup } from './types.js';

let tmpDirs: string[] = [];

function makeTmpGroupsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-tenants-'));
  tmpDirs.push(dir);
  return dir;
}

function group(folder: string, overrides: Partial<RegisteredGroup> = {}) {
  return {
    name: folder,
    folder,
    trigger: '@Skoobi',
    added_at: '2026-05-15T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('tenant registry', () => {
  it('resolves Telegram chat_id to a legacy tenant when tenant.json is missing', () => {
    const groupsDir = makeTmpGroupsDir();
    fs.mkdirSync(path.join(groupsDir, 'telegram_guest'), { recursive: true });

    const registry = TenantRegistry.fromRegisteredGroups(
      {
        'tg:-1001234567890': group('telegram_guest'),
      },
      { groupsDir },
    );

    const tenant = registry.resolveTelegramChat('-1001234567890');
    expect(tenant).toMatchObject({
      tenant_id: defaultTelegramTenantId('-1001234567890'),
      folder: 'telegram_guest',
      channel: 'telegram',
      chat_id: '-1001234567890',
      runtime: 'claude_sdk',
      source: 'legacy_registered_group',
    });
  });

  it('loads tenant.json metadata without changing the legacy folder mapping', () => {
    const groupsDir = makeTmpGroupsDir();
    const folder = path.join(groupsDir, 'telegram_guest');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, 'tenant.json'),
      JSON.stringify({
        tenant_id: 'tg_group_-1001234567890',
        folder: 'telegram_guest',
        channel: 'telegram',
        chat_id: '-1001234567890',
        bot_id: 'skoobi_lawyer_bot',
        persona_id: 'lawyer',
        mode: 'guest',
        language: 'ru',
        runtime: 'skoobi_shadow',
        approved_senders: [{ telegram_user_id: '42', role: 'guest' }],
        models: { default: 'skoobi-balanced' },
        quota: { enabled: true },
      }),
    );

    const registry = TenantRegistry.fromRegisteredGroups(
      {
        'tg:-1001234567890': group('telegram_guest'),
      },
      { groupsDir },
    );

    expect(registry.resolveTelegramChat('-1001234567890')).toMatchObject({
      // Finding #30: an untrusted (non-main) group cannot pick its own
      // tenant_id; it is bound to the trusted (default bot, chat_id) pair.
      tenant_id: defaultTelegramTenantId('-1001234567890'),
      folder: 'telegram_guest',
      runtime: 'skoobi_shadow',
      bot_id: 'skoobi_lawyer_bot',
      persona_id: 'lawyer',
      language: 'ru',
      mode: 'guest',
      approved_senders: [{ telegram_user_id: '42', role: 'guest' }],
      models: { default: 'skoobi-balanced' },
      quota: { enabled: true },
      source: 'tenant_json',
    });
  });

  it('ignores mismatched tenant.json chat ids and falls back to legacy lookup', () => {
    const groupsDir = makeTmpGroupsDir();
    const folder = path.join(groupsDir, 'telegram_guest');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, 'tenant.json'),
      JSON.stringify({
        tenant_id: 'wrong',
        folder: 'telegram_guest',
        channel: 'telegram',
        chat_id: '999',
      }),
    );

    const registry = TenantRegistry.fromRegisteredGroups(
      {
        'tg:-1001234567890': group('telegram_guest'),
      },
      { groupsDir },
    );

    expect(registry.resolveTelegramChat('-1001234567890')).toMatchObject({
      tenant_id: defaultTelegramTenantId('-1001234567890'),
      source: 'legacy_registered_group',
    });
  });

  it('rejects an oversized guest tenant.json without reading it into host memory', () => {
    const groupsDir = makeTmpGroupsDir();
    const folder = path.join(groupsDir, 'telegram_guest');
    fs.mkdirSync(folder, { recursive: true });
    const tenantFile = path.join(folder, 'tenant.json');
    fs.writeFileSync(tenantFile, '{');
    fs.truncateSync(tenantFile, 256 * 1024 + 1);

    const registry = TenantRegistry.fromRegisteredGroups(
      { 'tg:-1001234567890': group('telegram_guest') },
      { groupsDir },
    );

    expect(registry.resolveTelegramChat('-1001234567890')).toMatchObject({
      tenant_id: defaultTelegramTenantId('-1001234567890'),
      source: 'legacy_registered_group',
    });
  });

  it.each(['symlink', 'hardlink'] as const)(
    'rejects a guest tenant.json %s instead of following a mutable alias',
    (kind) => {
      const groupsDir = makeTmpGroupsDir();
      const folder = path.join(groupsDir, 'telegram_guest');
      fs.mkdirSync(folder, { recursive: true });
      const outside = path.join(groupsDir, 'outside-tenant.json');
      fs.writeFileSync(
        outside,
        JSON.stringify({
          tenant_id: 'forged',
          folder: 'telegram_guest',
          channel: 'telegram',
          chat_id: '-1001234567890',
          persona_id: 'forged-persona',
        }),
      );
      const tenantFile = path.join(folder, 'tenant.json');
      if (kind === 'symlink') fs.symlinkSync(outside, tenantFile);
      else fs.linkSync(outside, tenantFile);

      const registry = TenantRegistry.fromRegisteredGroups(
        { 'tg:-1001234567890': group('telegram_guest') },
        { groupsDir },
      );

      expect(registry.resolveTelegramChat('-1001234567890')).toMatchObject({
        tenant_id: defaultTelegramTenantId('-1001234567890'),
        persona_id: 'default',
        source: 'legacy_registered_group',
      });
    },
  );

  it('resolves Telegram thread JIDs back to the parent chat tenant', () => {
    const groupsDir = makeTmpGroupsDir();
    fs.mkdirSync(path.join(groupsDir, 'telegram_guest'), { recursive: true });
    fs.mkdirSync(path.join(groupsDir, 'telegram_guest_thread_123'), {
      recursive: true,
    });

    const registry = TenantRegistry.fromRegisteredGroups(
      {
        'tg:-1001234567890': group('telegram_guest'),
        'tg:-1001234567890:123': group('telegram_guest_thread_123'),
      },
      { groupsDir },
    );

    expect(registry.resolveTelegramJid('tg:-1001234567890:123')).toMatchObject({
      tenant_id: defaultTelegramTenantId('-1001234567890'),
      folder: 'telegram_guest',
      chat_id: '-1001234567890',
    });
  });

  it('parses bot-prefixed Telegram JIDs without confusing them with threads', () => {
    expect(telegramJidForChatId(12345, 'skoobi_friend')).toBe(
      'tg:skoobi_friend:12345',
    );
    expect(telegramJidToChatId('tg:skoobi_friend:12345')).toBe('12345');
    expect(parseTelegramJid('tg:skoobi_friend:12345')).toMatchObject({
      botId: 'skoobi_friend',
      chatId: '12345',
    });
    expect(parseTelegramJid('tg:-1001234567890:777')).toMatchObject({
      chatId: '-1001234567890',
      threadId: '777',
    });
  });

  it('round-trips an all-numeric bot id without stealing the chat id', () => {
    const jid = telegramJidForChatId(12345, '9000000001');
    expect(jid).toBe('tg:bot=9000000001:12345');
    expect(parseTelegramJid(jid)).toEqual({
      botId: '9000000001',
      chatId: '12345',
      threadId: undefined,
    });
    expect(telegramJidToBotId(jid)).toBe('9000000001');
    expect(telegramJidToChatId(jid)).toBe('12345');
  });

  it('keeps legacy numeric chat:thread JIDs and rejects malformed bot markers', () => {
    // Backward compatibility: this form cannot be reinterpreted as bot:chat.
    expect(parseTelegramJid('tg:9000000001:12345')).toEqual({
      chatId: '9000000001',
      threadId: '12345',
    });
    expect(parseTelegramJid('tg:bot=:12345')).toBeNull();
    expect(parseTelegramJid('tg:bot=not-numeric:12345')).toBeNull();
    expect(parseTelegramJid('tg:bot=9000000001')).toBeNull();
    expect(parseTelegramJid('tg:bot=9000000001:12345:7:extra')).toBeNull();
    expect(parseTelegramJid('tg:skoobi_friend:12345:7:extra')).toBeNull();
  });

  it('keeps two numeric-bot tenants for the same chat id isolated', () => {
    const groupsDir = makeTmpGroupsDir();
    fs.mkdirSync(path.join(groupsDir, 'telegram_numeric_a'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(groupsDir, 'telegram_numeric_b'), {
      recursive: true,
    });
    const firstJid = telegramJidForChatId(12345, '9000000001');
    const secondJid = telegramJidForChatId(12345, '7000000002');
    const registry = TenantRegistry.fromRegisteredGroups(
      {
        [firstJid]: group('telegram_numeric_a'),
        [secondJid]: group('telegram_numeric_b'),
      },
      { groupsDir },
    );

    expect(registry.resolveTelegramJid(firstJid)).toMatchObject({
      tenant_id: 'tg_9000000001_chat_12345',
      chat_id: '12345',
      bot_id: '9000000001',
    });
    expect(registry.resolveTelegramJid(secondJid)).toMatchObject({
      tenant_id: 'tg_7000000002_chat_12345',
      chat_id: '12345',
      bot_id: '7000000002',
    });
  });

  it('can keep two persona bot tenants for the same Telegram chat_id separate', () => {
    const groupsDir = makeTmpGroupsDir();
    for (const [folder, botId, personaId] of [
      ['telegram_friend_same_user', 'skoobi_friend', 'friend'],
      ['telegram_lawyer_same_user', 'skoobi_lawyer', 'lawyer'],
    ] as const) {
      const dir = path.join(groupsDir, folder);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'tenant.json'),
        JSON.stringify({
          tenant_id: `${botId}_12345`,
          folder,
          channel: 'telegram',
          chat_id: '12345',
          bot_id: botId,
          persona_id: personaId,
          mode: 'guest',
        }),
      );
    }

    const registry = TenantRegistry.fromRegisteredGroups(
      {
        'tg:skoobi_friend:12345': group('telegram_friend_same_user'),
        'tg:skoobi_lawyer:12345': group('telegram_lawyer_same_user'),
      },
      { groupsDir },
    );

    // Finding #30: guest tenant_ids are derived from the trusted (botId,
    // chatId) pair, so persona bots sharing a chat_id still stay distinct.
    expect(registry.resolveTelegramJid('tg:skoobi_friend:12345')).toMatchObject(
      {
        tenant_id: 'tg_skoobi_friend_chat_12345',
        persona_id: 'friend',
      },
    );
    expect(registry.resolveTelegramJid('tg:skoobi_lawyer:12345')).toMatchObject(
      {
        tenant_id: 'tg_skoobi_lawyer_chat_12345',
        persona_id: 'lawyer',
      },
    );
  });

  it('does not leak a persona-bot tenant on a botless lookup when bots share a chat_id', () => {
    const groupsDir = makeTmpGroupsDir();
    for (const [folder, botId, personaId] of [
      ['telegram_friend_shared', 'skoobi_friend', 'friend'],
      ['telegram_lawyer_shared', 'skoobi_lawyer', 'lawyer'],
    ] as const) {
      const dir = path.join(groupsDir, folder);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'tenant.json'),
        JSON.stringify({
          tenant_id: `${botId}_55555`,
          folder,
          channel: 'telegram',
          chat_id: '55555',
          bot_id: botId,
          persona_id: personaId,
          mode: 'guest',
        }),
      );
    }

    const registry = TenantRegistry.fromRegisteredGroups(
      {
        'tg:skoobi_friend:55555': group('telegram_friend_shared'),
        'tg:skoobi_lawyer:55555': group('telegram_lawyer_shared'),
      },
      { groupsDir },
    );

    // Each persona bot still resolves deterministically when its botId is known.
    // Finding #30: guest tenant_ids come from the trusted (botId, chatId) pair.
    expect(
      registry.resolveTelegramChat('55555', 'skoobi_friend'),
    ).toMatchObject({
      tenant_id: 'tg_skoobi_friend_chat_55555',
      persona_id: 'friend',
    });
    expect(
      registry.resolveTelegramChat('55555', 'skoobi_lawyer'),
    ).toMatchObject({
      tenant_id: 'tg_skoobi_lawyer_chat_55555',
      persona_id: 'lawyer',
    });

    // A botless lookup (default-bot hot path) must NOT guess a persona-bot
    // tenant via a chat_id-only scan — that would leak persona/tenant_id/quota.
    expect(registry.resolveTelegramChat('55555')).toBeUndefined();
    expect(registry.resolveTelegramJid('tg:55555')).toBeUndefined();
  });

  it('maps a botless default-bot lookup to the default-bot tenant even when a persona bot shares the chat_id', () => {
    const groupsDir = makeTmpGroupsDir();
    const defaultDir = path.join(groupsDir, 'telegram_default_shared');
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultDir, 'tenant.json'),
      JSON.stringify({
        tenant_id: 'default_77777',
        folder: 'telegram_default_shared',
        channel: 'telegram',
        chat_id: '77777',
        persona_id: 'default',
        mode: 'guest',
      }),
    );
    const lawyerDir = path.join(groupsDir, 'telegram_lawyer_shared2');
    fs.mkdirSync(lawyerDir, { recursive: true });
    fs.writeFileSync(
      path.join(lawyerDir, 'tenant.json'),
      JSON.stringify({
        tenant_id: 'skoobi_lawyer_77777',
        folder: 'telegram_lawyer_shared2',
        channel: 'telegram',
        chat_id: '77777',
        bot_id: 'skoobi_lawyer',
        persona_id: 'lawyer',
        mode: 'guest',
      }),
    );

    const registry = TenantRegistry.fromRegisteredGroups(
      {
        'tg:77777': group('telegram_default_shared'),
        'tg:skoobi_lawyer:77777': group('telegram_lawyer_shared2'),
      },
      { groupsDir },
    );

    // Finding #30: guest tenant_ids derive from the trusted (botId, chatId)
    // pair — the default bot keeps the legacy `tg_chat_<chatId>` id.
    expect(registry.resolveTelegramChat('77777')).toMatchObject({
      tenant_id: defaultTelegramTenantId('77777'),
      persona_id: 'default',
    });
    expect(
      registry.resolveTelegramChat('77777', 'skoobi_lawyer'),
    ).toMatchObject({
      tenant_id: 'tg_skoobi_lawyer_chat_77777',
      persona_id: 'lawyer',
    });
  });

  it('derives bot_id from bot-prefixed legacy group JIDs', () => {
    const groupsDir = makeTmpGroupsDir();
    fs.mkdirSync(path.join(groupsDir, 'telegram_friend'), { recursive: true });

    const registry = TenantRegistry.fromRegisteredGroups(
      {
        'tg:skoobi_friend:12345': group('telegram_friend'),
      },
      { groupsDir },
    );

    expect(registry.resolveTelegramJid('tg:skoobi_friend:12345')).toMatchObject(
      {
        chat_id: '12345',
        bot_id: 'skoobi_friend',
      },
    );
  });

  it('ignores a guest-supplied tenant.json mode and never escalates to owner (finding #30)', () => {
    const groupsDir = makeTmpGroupsDir();
    const folder = path.join(groupsDir, 'telegram_guest');
    fs.mkdirSync(folder, { recursive: true });
    // The group dir is mounted read-write into the guest sandbox, so a guest
    // agent can overwrite tenant.json to try to escalate its privilege mode.
    fs.writeFileSync(
      path.join(folder, 'tenant.json'),
      JSON.stringify({
        folder: 'telegram_guest',
        channel: 'telegram',
        chat_id: '-1001234567890',
        mode: 'owner',
      }),
    );

    const registry = TenantRegistry.fromRegisteredGroups(
      // group() defaults isMain to undefined => untrusted guest group.
      { 'tg:-1001234567890': group('telegram_guest') },
      { groupsDir },
    );

    expect(registry.resolveTelegramChat('-1001234567890')?.mode).toBe('guest');
  });

  it('keeps owner mode for a main group even if tenant.json omits/forges mode (finding #30)', () => {
    const groupsDir = makeTmpGroupsDir();
    const folder = path.join(groupsDir, 'telegram_main');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, 'tenant.json'),
      JSON.stringify({
        folder: 'telegram_main',
        channel: 'telegram',
        chat_id: '999',
        mode: 'guest',
      }),
    );

    const registry = TenantRegistry.fromRegisteredGroups(
      { 'tg:999': group('telegram_main', { isMain: true }) },
      { groupsDir },
    );

    expect(registry.resolveTelegramChat('999')?.mode).toBe('owner');
  });

  it('binds a guest tenant_id to the trusted chat and ignores a forged tenant_id (finding #30)', () => {
    const groupsDir = makeTmpGroupsDir();
    const folder = path.join(groupsDir, 'telegram_guest');
    fs.mkdirSync(folder, { recursive: true });
    // Guest tries to charge usage against another tenant by claiming its id.
    fs.writeFileSync(
      path.join(folder, 'tenant.json'),
      JSON.stringify({
        folder: 'telegram_guest',
        channel: 'telegram',
        chat_id: '-1001234567890',
        tenant_id: 'victim_paid_tenant',
      }),
    );

    const registry = TenantRegistry.fromRegisteredGroups(
      { 'tg:-1001234567890': group('telegram_guest') },
      { groupsDir },
    );

    const tenant = registry.resolveTelegramChat('-1001234567890');
    expect(tenant?.tenant_id).toBe(trustedTelegramTenantId('-1001234567890'));
    expect(tenant?.tenant_id).not.toBe('victim_paid_tenant');
  });

  it('honors a custom tenant_id only for a trusted main group (finding #30)', () => {
    const groupsDir = makeTmpGroupsDir();
    const folder = path.join(groupsDir, 'telegram_main');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, 'tenant.json'),
      JSON.stringify({
        folder: 'telegram_main',
        channel: 'telegram',
        chat_id: '12345',
        tenant_id: 'operator_chosen_id',
      }),
    );

    const registry = TenantRegistry.fromRegisteredGroups(
      { 'tg:12345': group('telegram_main', { isMain: true }) },
      { groupsDir },
    );

    expect(registry.resolveTelegramChat('12345')?.tenant_id).toBe(
      'operator_chosen_id',
    );
  });

  it('derives distinct, bot-scoped guest tenant_ids per persona bot (finding #30)', () => {
    expect(trustedTelegramTenantId('12345')).toBe('tg_chat_12345');
    expect(trustedTelegramTenantId('12345', 'telegram_default')).toBe(
      'tg_chat_12345',
    );
    expect(trustedTelegramTenantId('12345', 'skoobi_friend')).toBe(
      'tg_skoobi_friend_chat_12345',
    );
    expect(trustedTelegramTenantId('12345', 'skoobi_lawyer')).toBe(
      'tg_skoobi_lawyer_chat_12345',
    );
  });
});

describe('tenant parsing and sender identity', () => {
  it('defaults unknown runtime modes to claude_sdk', () => {
    expect(parseSkoobiRuntimeMode(undefined)).toBe('claude_sdk');
    expect(parseSkoobiRuntimeMode('claude_sdk')).toBe('claude_sdk');
    expect(parseSkoobiRuntimeMode('skoobi_shadow')).toBe('skoobi_shadow');
    expect(parseSkoobiRuntimeMode('skoobi_live')).toBe('skoobi_live');
    expect(parseSkoobiRuntimeMode('other')).toBe('claude_sdk');
    expect(parseTenantJson({ runtime: 'other' }).runtime).toBe('claude_sdk');
  });

  it('uses Telegram from.id as stable identity, not display name or username', () => {
    const allowlist = parseOwnerAllowlistConfig({
      telegram_user_ids: '123',
      telegram_chat_ids: '-100123',
    });
    const original = createTelegramSenderIdentity({
      chatId: '-100123',
      fromId: 123,
      usernameHint: 'real_user',
      displayNameHint: 'Alice',
      ownerAllowlist: allowlist,
    });
    const spoofed = createTelegramSenderIdentity({
      chatId: '-100123',
      fromId: 123,
      usernameHint: 'different_username',
      displayNameHint: 'Totally Different',
      ownerAllowlist: allowlist,
    });

    expect(original.telegram_user_id).toBe('123');
    expect(original.identity_id).toBe(defaultTelegramIdentityId('123'));
    expect(spoofed.telegram_user_id).toBe(original.telegram_user_id);
    expect(spoofed.identity_id).toBe(original.identity_id);
    expect(spoofed.display_name_hint).not.toBe(original.display_name_hint);
    expect(spoofed.is_owner_sender).toBe(true);
  });

  it('can annotate the same Telegram identity with bot and persona metadata', () => {
    const lawyer = createTelegramSenderIdentity({
      chatId: '100',
      fromId: 555,
      botId: 'skoobi_lawyer_bot',
      personaId: 'lawyer',
      usernameHint: 'same_user',
      displayNameHint: 'User',
    });
    const friend = createTelegramSenderIdentity({
      chatId: '200',
      fromId: 555,
      botId: 'skoobi_friend_bot',
      personaId: 'friend',
      usernameHint: 'renamed_user',
      displayNameHint: 'Renamed',
    });

    expect(friend.identity_id).toBe(lawyer.identity_id);
    expect(lawyer.bot_id).toBe('skoobi_lawyer_bot');
    expect(friend.bot_id).toBe('skoobi_friend_bot');
    expect(lawyer.persona_id).toBe('lawyer');
    expect(friend.persona_id).toBe('friend');
  });

  it('does not mark a sender owner when only the display name matches', () => {
    const allowlist = parseOwnerAllowlistConfig({
      telegram_user_ids: '123',
      telegram_chat_ids: '-100123',
    });

    expect(
      createTelegramSenderIdentity({
        chatId: '-100123',
        fromId: 999,
        usernameHint: 'owner',
        displayNameHint: 'Owner',
        ownerAllowlist: allowlist,
      }).is_owner_sender,
    ).toBe(false);
  });

  it('marks Owner and User B as owner/admin senders from the global Telegram allowlist', () => {
    const allowlist = parseOwnerAllowlistConfig({
      telegram_user_ids: '100000001,7000000002',
    });

    expect(
      createTelegramSenderIdentity({
        chatId: '100000001',
        fromId: 100000001,
        displayNameHint: 'Owner',
        ownerAllowlist: allowlist,
      }).is_owner_sender,
    ).toBe(true);

    expect(
      createTelegramSenderIdentity({
        chatId: '7000000002',
        fromId: 7000000002,
        displayNameHint: 'User B',
        ownerAllowlist: allowlist,
      }).is_owner_sender,
    ).toBe(true);

    expect(
      createTelegramSenderIdentity({
        chatId: '555',
        fromId: 555,
        displayNameHint: 'Random',
        ownerAllowlist: allowlist,
      }).is_owner_sender,
    ).toBe(false);
  });
});
