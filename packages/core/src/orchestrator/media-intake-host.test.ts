import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaIntakeAdapter, MediaIntakeInput, MediaIntakeScope } from '@skoobi/shared/media-intake';
import { _initTestDatabase, getDb, getMessagesSince, getNewMessages, INITIAL_INGESTION_CURSOR, storeMessage } from './db.js';
import { createMediaIntakeStore, earliestMediaIntakeCursor, pendingMediaIntakeDispatches } from './media-intake-store.js';
import { cancelMediaForDirectOwnerStop, dispatchMaterializedMedia, messagesBeforePendingMedia, latestPendingMediaStop, writeMediaIntakeMessage } from './media-intake-host.js';
import { isCodexDesktopStopCommandText } from './message-loop.js';
import { getEventsForTenant, recordTenantEvent } from './event-store.js';
import type { TenantRecord } from './tenant-registry.js';

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

const eventTenant: TenantRecord = {
  tenant_id: scope.tenantId, folder: scope.groupFolder, channel: 'telegram', chat_id: '101', mode: 'admin',
  runtime: 'claude_sdk', approved_senders: [], models: {}, quota: { enabled: false }, legacy_jid: scope.chatJid,
  source: 'legacy_registered_group',
  group: { name: 'Media host test', folder: scope.groupFolder, trigger: '@Skoobi', added_at: '2026-01-01T00:00:00.000Z' },
};

describe('inbound event for a voice note of the media pipeline (W13)', () => {
  it('writes exactly one event per message: none for the reservation, one for the transcript, none on repeats', () => {
    _initTestDatabase();
    const events: Array<{ chatJid: string; content: string; timestamp: string }> = [];
    const pipeline = createMediaIntakeStore(getDb(), { botId: scope.botId, resolveScope: () => scope,
      isAdmitted: () => true, now: () => 1000,
      writeMessage: (database, message) => {
        expect(database).toBe(getDb());
        writeMediaIntakeMessage(message, {
          store: storeMessage,
          recordInbound: (chatJid, stored) => {
            events.push({ chatJid, content: stored.content, timestamp: stored.timestamp });
            // The real append-only store, nested in the pipeline's transaction.
            recordTenantEvent({ tenant: eventTenant, type: 'telegram_inbound_message',
              actor: `telegram_user:${stored.sender}`, senderId: stored.sender,
              payload: { message_id: stored.id, content: stored.content, timestamp: stored.timestamp } });
          },
        });
      },
    });
    const accepted = pipeline.accept(input('voice-event'));
    if (!('job' in accepted)) throw new Error('Expected persisted job');
    expect(events).toEqual([]); // the empty reservation is not a message yet
    const claim = pipeline.claim(accepted.job.id)!;
    const download = pipeline.beginAttempt(claim.lease, 'download')!;
    const saved = { relativePath: download.destinationRelativePath!, bytes: 20, sha256: 'a'.repeat(64) };
    const downloaded = pipeline.checkpointDownload(pipeline.prepareDownload(download, saved)!, saved)!;
    const recognition = pipeline.beginAttempt(downloaded.lease, 'transcribe')!;
    const transcribed = pipeline.checkpointTranscription(recognition, { text: 'Купи хлеба', sourceSha256: saved.sha256 })!;
    expect(pipeline.materialize(transcribed.lease).kind).toBe('materialized');
    // The original send time, not the moment the transcript was ready.
    expect(events).toEqual([{ chatJid: scope.chatJid, content: '[Voice: Купи хлеба]', timestamp: '2026-01-01T00:00:00.000Z' }]);
    expect(pipeline.materialize(transcribed.lease).kind).toBe('already_materialized');
    expect(pipeline.accept(input('voice-event')).kind).toBe('already_materialized');
    expect(events).toHaveLength(1);
    const stored = getEventsForTenant(eventTenant.tenant_id).filter((event) => event.type === 'telegram_inbound_message');
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].payload_json)).toMatchObject({ message_id: 'voice-event', content: '[Voice: Купи хлеба]' });
  });

  it('records nothing for an empty write and stores the message either way', () => {
    const stored: string[] = [];
    const recorded: string[] = [];
    const deps = { store: (m: { id: string }) => stored.push(m.id),
      recordInbound: (_jid: string, m: { id: string }) => recorded.push(m.id) };
    const base = input('blank').message;
    writeMediaIntakeMessage({ ...base, content: '' }, deps);
    writeMediaIntakeMessage({ ...base, content: '   ' }, deps);
    writeMediaIntakeMessage({ ...base, content: '[Voice — media unavailable: capacity] подпись' }, deps);
    expect(stored).toEqual(['blank', 'blank', 'blank']);
    expect(recorded).toEqual(['blank']);
  });
});

describe('inbound event for a voice note that could not be heard (W13 review)', () => {
  function pipelineWith(failed: NewMessageLike[], written: NewMessageLike[]) {
    return createMediaIntakeStore(getDb(), { botId: scope.botId, resolveScope: () => scope,
      isAdmitted: () => true, now: () => 1000,
      writeMessage: (_database, message) => {
        writeMediaIntakeMessage(message, { store: storeMessage,
          recordInbound: (_jid, stored) => written.push({ id: stored.id, content: stored.content, timestamp: stored.timestamp }) });
      },
      recordFailedInbound: (message) => failed.push({ id: message.id, content: message.content, timestamp: message.timestamp }),
    });
  }
  function transcribe(pipeline: MediaIntakeAdapter, value: MediaIntakeInput, text: string | null) {
    const accepted = pipeline.accept(value);
    if (!('job' in accepted)) throw new Error('Expected persisted job');
    const claim = pipeline.claim(accepted.job.id)!;
    const download = pipeline.beginAttempt(claim.lease, 'download')!;
    const saved = { relativePath: download.destinationRelativePath!, bytes: 20, sha256: 'b'.repeat(64) };
    const downloaded = pipeline.checkpointDownload(pipeline.prepareDownload(download, saved)!, saved)!;
    const recognition = pipeline.beginAttempt(downloaded.lease, 'transcribe')!;
    return pipeline.checkpointTranscription(recognition, { text, sourceSha256: saved.sha256,
      ...(text === null ? { unusableReason: 'no_speech' as const } : {}) })!;
  }
  const content = (id: string) => (getDb().prepare('SELECT content FROM messages WHERE id=?').get(id) as { content: string }).content;

  it('records one event with a placeholder, keeps the row empty and still sends the notice', () => {
    _initTestDatabase();
    const failed: NewMessageLike[] = [], written: NewMessageLike[] = [];
    const pipeline = pipelineWith(failed, written);
    const ready = transcribe(pipeline, input('voice-silent'), null);
    expect(pipeline.materialize(ready.lease).kind).toBe('failed');
    expect(failed).toEqual([{ id: 'voice-silent', content: '[Voice — media unavailable: no_speech]',
      timestamp: '2026-01-01T00:00:00.000Z' }]);
    expect(written).toEqual([]);
    // The agent does not get a turn for it: the chat gets the notice instead.
    expect(content('voice-silent')).toBe('');
    expect(getDb().prepare('SELECT reason FROM media_intake_notices').all()).toEqual([{ reason: 'no_speech' }]);
    // Terminal: a repeat changes nothing.
    expect(pipeline.materialize(ready.lease).kind).not.toBe('materialized');
    expect(pipeline.accept(input('voice-silent')).kind).not.toBe('accepted');
    expect(failed).toHaveLength(1);
  });

  it('leaves the event to the message writer when the caption is kept', () => {
    _initTestDatabase();
    const failed: NewMessageLike[] = [], written: NewMessageLike[] = [];
    const pipeline = pipelineWith(failed, written);
    const ready = transcribe(pipeline, { ...input('voice-caption'), caption: 'смета' }, null);
    expect(pipeline.materialize(ready.lease).kind).toBe('materialized');
    expect(failed).toEqual([]);
    expect(written).toEqual([{ id: 'voice-caption', content: '[Voice — transcription unavailable] смета',
      timestamp: '2026-01-01T00:00:00.000Z' }]);
  });

  it('on a terminal failure: the kept caption is the message, without it the placeholder event', () => {
    _initTestDatabase();
    const failed: NewMessageLike[] = [], written: NewMessageLike[] = [];
    const pipeline = pipelineWith(failed, written);
    for (const value of [{ ...input('lost-caption'), caption: 'смета' }, input('lost-bare')]) {
      const accepted = pipeline.accept(value);
      if (!('job' in accepted)) throw new Error('Expected persisted job');
      pipeline.terminate(pipeline.claim(accepted.job.id)!.lease, 'source_unavailable');
    }
    expect(written).toEqual([{ id: 'lost-caption', content: '[Voice — media unavailable: source_unavailable] смета',
      timestamp: '2026-01-01T00:00:00.000Z' }]);
    expect(failed).toEqual([{ id: 'lost-bare', content: '[Voice — media unavailable: source_unavailable]',
      timestamp: '2026-01-01T00:00:00.000Z' }]);
    expect(content('lost-bare')).toBe('');
  });

  it('records nothing when another writer already owns the row (source_changed)', () => {
    _initTestDatabase();
    const failed: NewMessageLike[] = [], written: NewMessageLike[] = [];
    const pipeline = pipelineWith(failed, written);
    const ready = transcribe(pipeline, input('voice-edited'), 'Купи хлеба');
    getDb().prepare("UPDATE messages SET content='исправленный текст' WHERE id='voice-edited'").run();
    expect(pipeline.materialize(ready.lease).kind).toBe('dropped');
    expect(failed).toEqual([]);
    expect(written).toEqual([]);
  });
});

interface NewMessageLike { id: string; content: string; timestamp: string }
