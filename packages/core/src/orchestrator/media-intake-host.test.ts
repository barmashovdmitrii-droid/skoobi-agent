import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaIntakeAdapter, MediaIntakeInput, MediaIntakeScope } from '@skoobi/shared/media-intake';
import { _initTestDatabase, getDb, getMessagesSince, getNewMessages, INITIAL_INGESTION_CURSOR, storeMessage } from './db.js';
import { createMediaIntakeStore, earliestMediaIntakeCursor, pendingMediaIntakeDispatches } from './media-intake-store.js';
import { cancelMediaForDirectOwnerStop, dispatchMaterializedMedia, messagesBeforePendingMedia, latestPendingMediaStop } from './media-intake-host.js';
import { isCodexDesktopStopCommandText } from './message-loop.js';

const scope: MediaIntakeScope = { botId: 'testbot', tenantId: 'test-tenant', chatJid: 'tg:testbot:101', groupFolder: 'media-host-test' };
function input(id: string): MediaIntakeInput {
  return { message: { id, chat_jid: scope.chatJid, sender: '201', sender_name: 'Test sender',
    timestamp: '2026-01-01T00:00:00.000Z', sender_identity: {
      channel: 'telegram', chat_id: '101', telegram_user_id: '201', identity_id: 'telegram_user_201',
      bot_id: scope.botId, is_owner_sender: true, telegram_message_origin: 'direct',
    } }, media: { kind: 'voice', fileId: `synthetic-${id}` }, isGroup: false };
}

describe('durable media frontier with real message storage', () => {
  let adapter: MediaIntakeAdapter;
  beforeEach(() => {
    _initTestDatabase();
    adapter = createMediaIntakeStore(getDb(), { botId: scope.botId, resolveScope: () => scope,
      isAdmitted: () => true, now: () => 1000,
      writeMessage: (database, message) => { expect(database).toBe(getDb()); storeMessage(message); },
    });
  });
  function finish(id: string): void {
    const accepted = adapter.accept(input(id));
    if (!('job' in accepted)) throw new Error('Expected persisted job');
    const claim = adapter.claim(accepted.job.id)!;
    const download = adapter.beginAttempt(claim.lease, 'download')!;
    const saved = { relativePath: download.destinationRelativePath!, bytes: 20, sha256: 'a'.repeat(64) };
    const prepared = adapter.prepareDownload(download, saved)!;
    const downloaded = adapter.checkpointDownload(prepared, saved)!;
    const recognition = adapter.beginAttempt(downloaded.lease, 'transcribe')!;
    const transcribed = adapter.checkpointTranscription(recognition, { text: 'Original voice request', sourceSha256: saved.sha256 })!;
    expect(adapter.materialize(transcribed.lease).kind).toBe('materialized');
  }

  it('holds a later correction until the earlier voice is materialized, even after the global cursor passed it', () => {
    const accepted = adapter.accept(input('voice-a'));
    if (!('job' in accepted)) throw new Error('Expected persisted job');
    storeMessage({ ...input('text-b').message, content: 'Correction of the voice request' });
    const poll = getNewMessages([scope.chatJid], INITIAL_INGESTION_CURSOR, 'Bot');
    expect(poll.messages.map(m => m.id)).toEqual(['text-b']);
    expect(messagesBeforePendingMedia(poll.messages, earliestMediaIntakeCursor(getDb(), scope.chatJid))).toEqual([]);
    finish('voice-a');
    expect(getNewMessages([scope.chatJid], poll.newTimestamp, 'Bot').messages).toEqual([]);
    const ordered = messagesBeforePendingMedia(getMessagesSince(scope.chatJid, INITIAL_INGESTION_CURSOR, 'Bot'), earliestMediaIntakeCursor(getDb(), scope.chatJid));
    expect(ordered.map(m => m.id)).toEqual(['voice-a', 'text-b']);
    expect(ordered[0].ingestion_cursor).toBe(accepted.job.ingestionCursor);
    expect(dispatchMaterializedMedia(getDb(), () => false)).toBe(0);
    expect(pendingMediaIntakeDispatches(getDb())).toHaveLength(1);
    const chats: string[] = [];
    expect(dispatchMaterializedMedia(getDb(), chat => { chats.push(chat); return true; })).toBe(1);
    expect(chats).toEqual([scope.chatJid]);
    expect(pendingMediaIntakeDispatches(getDb())).toEqual([]);
    expect(getMessagesSince(scope.chatJid, INITIAL_INGESTION_CURSOR, 'Bot')).toHaveLength(2);
  });

  it('does not consume a durable wakeup when queue admission throws', () => {
    finish('voice-a');
    expect(() => dispatchMaterializedMedia(getDb(), () => { throw new Error('Queue unavailable'); })).toThrow('Queue unavailable');
    expect(pendingMediaIntakeDispatches(getDb())).toHaveLength(1);
    expect(dispatchMaterializedMedia(getDb(), () => true)).toBe(1);
    expect(dispatchMaterializedMedia(getDb(), () => true)).toBe(0);
  });

  it('finds a direct stop beyond a full agent page without admitting the intervening backlog', () => {
    adapter.accept(input('voice-a'));
    for (let i = 0; i < 201; i++) storeMessage({ ...input(`pending-${i}`).message, content: `Pending request ${i}` });
    storeMessage({ ...input('stop-c').message, content: 'стоп' });
    storeMessage({ ...input('forwarded-stop').message, content: 'стоп',
      sender_identity: { ...input('forwarded-stop').message.sender_identity!, telegram_message_origin: 'forwarded' } });
    const page = getMessagesSince(scope.chatJid, INITIAL_INGESTION_CURSOR, 'Bot');
    expect(page).toHaveLength(200);
    expect(page.some(m => m.id === 'stop-c')).toBe(false);
    expect(messagesBeforePendingMedia(page, earliestMediaIntakeCursor(getDb(), scope.chatJid))).toEqual([]);
    const stop = latestPendingMediaStop(getDb(), scope.chatJid, INITIAL_INGESTION_CURSOR, isCodexDesktopStopCommandText)!;
    expect(stop.id).toBe('stop-c');
    expect(cancelMediaForDirectOwnerStop(getDb(), scope, stop)).toBe(1);
    expect(latestPendingMediaStop(getDb(), scope.chatJid, stop.ingestion_cursor!, isCodexDesktopStopCommandText)).toBeUndefined();
  });

  it('lets a direct authorized stop cancel only older media and rejects forwarded or other-bot cancellation', () => {
    const first = adapter.accept(input('voice-a'));
    if (!('job' in first)) throw new Error('Expected persisted job');
    const running = adapter.claim(first.job.id)!;
    const work = adapter.beginAttempt(running.lease, 'download')!;
    storeMessage({ ...input('stop-c').message, content: 'стоп' });
    const stop = getMessagesSince(scope.chatJid, INITIAL_INGESTION_CURSOR, 'Bot')[0];
    const newer = adapter.accept(input('voice-d'));
    if (!('job' in newer)) throw new Error('Expected persisted job');
    expect(cancelMediaForDirectOwnerStop(getDb(), scope, { ...stop,
      sender_identity: { ...stop.sender_identity!, telegram_message_origin: 'forwarded' } })).toBe(0);
    expect(cancelMediaForDirectOwnerStop(getDb(), scope, { ...stop,
      sender_identity: { ...stop.sender_identity!, bot_id: 'other-bot' } })).toBe(0);
    expect(cancelMediaForDirectOwnerStop(getDb(), scope, stop)).toBe(1);
    expect(adapter.isCurrent(work.lease)).toBe(false);
    expect(adapter.prepareDownload(work, { relativePath: work.destinationRelativePath!, bytes: 20, sha256: 'a'.repeat(64) })).toBeUndefined();
    expect(earliestMediaIntakeCursor(getDb(), scope.chatJid)).toBe(newer.job.ingestionCursor);
    expect(adapter.claim(newer.job.id)?.job.id).toBe(newer.job.id);
  });
});
