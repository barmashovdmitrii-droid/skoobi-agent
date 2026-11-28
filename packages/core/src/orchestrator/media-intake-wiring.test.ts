/**
 * W13: the media pipeline exactly as message-loop wires it
 * (mediaIntakeForBot → writeMediaIntakeMessage / recordFailedInbound →
 * recordInboundEvent → the tenant's event store), not a parallel callback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaIntakeAdapter, MediaIntakeInput } from '@skoobi/shared/media-intake';

// The sender allowlist lives in the real home folder (~/.config/claudeclaw);
// this Mac's own file («drop» by default) must not decide a hermetic test.
vi.mock('./sender-allowlist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sender-allowlist.js')>();
  return {
    ...actual,
    loadSenderAllowlist: () =>
      actual.loadSenderAllowlist('/nonexistent/skoobi-test/sender-allowlist.json'),
  };
});

import { _initTestDatabase, getDb, storeBotReply } from './db.js';
import { getEventsForTenant } from './event-store.js';
import { _mediaIntakeForBotForTest, _setRegisteredGroups } from './message-loop.js';
import { TenantRegistry } from './tenant-registry.js';
import type { RegisteredGroup } from './types.js';

const botId = 'wiringbot';
const chatJid = `tg:${botId}:301`;
const group: RegisteredGroup = {
  name: 'Media wiring', folder: 'media_wiring_test', trigger: '@Skoobi',
  added_at: '2026-01-01T00:00:00.000Z', isMain: true,
};

function input(id: string): MediaIntakeInput {
  return { message: { id, chat_jid: chatJid, sender: '401', sender_name: 'Test sender',
    timestamp: '2026-11-08T09:00:00.000Z', sender_identity: {
      channel: 'telegram', chat_id: '301', telegram_user_id: '401', identity_id: 'telegram_user_401',
      bot_id: botId, is_owner_sender: false, telegram_message_origin: 'direct',
    } }, media: { kind: 'voice', fileId: `synthetic-${id}` }, isGroup: false };
}

function heard(pipeline: MediaIntakeAdapter, id: string, text: string | null) {
  const accepted = pipeline.accept(input(id));
  if (!('job' in accepted)) throw new Error(`Expected persisted job, got ${accepted.kind}`);
  const claim = pipeline.claim(accepted.job.id);
  if (!claim) throw new Error('Expected a claim: the fixture chat must be admitted');
  const download = pipeline.beginAttempt(claim.lease, 'download')!;
  const saved = { relativePath: download.destinationRelativePath!, bytes: 20, sha256: 'c'.repeat(64) };
  const downloaded = pipeline.checkpointDownload(pipeline.prepareDownload(download, saved)!, saved)!;
  const recognition = pipeline.beginAttempt(downloaded.lease, 'transcribe')!;
  const ready = pipeline.checkpointTranscription(recognition, { text, sourceSha256: saved.sha256,
    ...(text === null ? { unusableReason: 'no_speech' as const } : {}) })!;
  return pipeline.materialize(ready.lease).kind;
}

afterEach(() => _setRegisteredGroups({}));

describe('media pipeline wiring of message-loop (W13)', () => {
  it('writes one telegram_inbound_message per voice note: heard or not, never for the reservation', () => {
    _initTestDatabase();
    _setRegisteredGroups({ [chatJid]: group });
    const tenantId = TenantRegistry.fromRegisteredGroups({ [chatJid]: group })
      .resolveTelegramJid(chatJid)!.tenant_id;
    const inbound = () => getEventsForTenant(tenantId)
      .filter((event) => event.type === 'telegram_inbound_message')
      .map((event) => JSON.parse(event.payload_json) as Record<string, unknown>);
    const pipeline = _mediaIntakeForBotForTest(botId);

    expect(pipeline.accept(input('wired-reservation')).kind).toBe('accepted');
    expect(inbound()).toEqual([]);
    expect(heard(pipeline, 'wired-reservation', 'Купи хлеба')).toBe('materialized');
    expect(heard(pipeline, 'wired-silent', null)).toBe('failed');
    // Repeats of either add nothing.
    expect(pipeline.accept(input('wired-reservation')).kind).toBe('already_materialized');
    pipeline.accept(input('wired-silent'));

    expect(inbound()).toEqual([
      expect.objectContaining({ message_id: 'wired-reservation', chat_jid: chatJid, sender_id: '401',
        content: '[Voice: Купи хлеба]', timestamp: '2026-11-08T09:00:00.000Z' }),
      expect.objectContaining({ message_id: 'wired-silent', chat_jid: chatJid,
        content: '[Voice — media unavailable: no_speech]', timestamp: '2026-11-08T09:00:00.000Z' }),
    ]);
    const rows = getDb().prepare('SELECT id, content FROM messages WHERE chat_jid=? ORDER BY id').all(chatJid);
    expect(rows).toEqual([
      { id: 'wired-reservation', content: '[Voice: Купи хлеба]' },
      { id: 'wired-silent', content: '' },
    ]);
  });

  it('пароль голосом после просьбы бота: в журнал — маска, в историю для модели — как сказано (W19)', () => {
    _initTestDatabase();
    _setRegisteredGroups({ [chatJid]: group });
    const tenantId = TenantRegistry.fromRegisteredGroups({ [chatJid]: group })
      .resolveTelegramJid(chatJid)!.tenant_id;
    storeBotReply(chatJid, 'Продиктуй пароль администратора Mac', '2026-11-08T08:58:00.000Z');
    const pipeline = _mediaIntakeForBotForTest(botId);

    expect(heard(pipeline, 'wired-password', '4821')).toBe('materialized');

    const inbound = getEventsForTenant(tenantId)
      .filter((event) => event.type === 'telegram_inbound_message')
      .map((event) => JSON.parse(event.payload_json) as Record<string, unknown>);
    expect(inbound).toEqual([
      expect.objectContaining({ message_id: 'wired-password', content: '[Voice: [скрыто]]' }),
    ]);
    const stored = getDb()
      .prepare('SELECT content FROM messages WHERE id = ?')
      .get('wired-password') as { content: string };
    expect(stored.content).toBe('[Voice: 4821]');
  });
});
