import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { NewMessage } from './types.js';
import {
  _initTestDatabase, applyTelegramMessageEdit, canExecuteTelegramMessageSnapshot, getDb,
  getMessagesByIds, getMessagesSince, getNewMessages, getRecentConversationMessages,
  getRecentConversationMessagesForExactJids, getTelegramMessageEditRevision, getTelegramMessageEditBindingHash,
  hasQuarantinedTelegramInputAfter, INITIAL_INGESTION_CURSOR,
  isTelegramMessageSnapshotCurrent, markTelegramMessageSnapshotsAdmitted, storeMessage,
} from './db.js';
import {
  applyTelegramEdit, currentTelegramSnapshot, ensureTelegramMessageEditSchema,
  getTelegramMessageEditRevisionFrom, isTelegramMessageAdmissionCurrentFrom,
} from './telegram-message-edit-store.js';

const chat = 'tg:701';
const at = 1_700_000_000;

function original(id = '8'): NewMessage {
  return {
    id, chat_jid: chat, sender: '701', sender_name: 'Sample', content: 'First',
    timestamp: new Date(at * 1000).toISOString().replace('.000Z', '.500' + id.padStart(12, '0') + 'Z'),
    sender_identity: { channel: 'telegram', chat_id: '701', telegram_user_id: '701',
      identity_id: 'telegram_user_701', bot_id: 'telegram_default', persona_id: 'fixture',
      is_owner_sender: true, telegram_message_origin: 'direct' },
    telegram_editable: true, telegram_receiver_id: '42', telegram_edit_group_folder: 'fixture-a',
    telegram_update_id: '765', tenant_id: 'fixture',
  };
}

function read(msg: NewMessage): NewMessage | undefined {
  return getMessagesByIds(msg.chat_jid, [msg.id])[0];
}

function revision(msg: NewMessage): number | undefined {
  return getTelegramMessageEditRevision(msg.chat_jid, msg.id);
}

describe('bound Telegram corrections', () => {
  beforeEach(_initTestDatabase);

  it('edits the verified row and retains original identity, chronology and cursor across all readers', () => {
    const m = original();
    storeMessage(m);
    const first = read(m)!;
    expect(first.telegram_editable).toBe(true);
    expect(first.telegram_edit_revision).toBeUndefined();
    expect(revision(m)).toBe(0);
    expect(applyTelegramMessageEdit({ ...m, content: 'Second', telegram_update_id: '766' }, at + 1)).toBe('applied');
    for (const row of [
      read(m),
      getMessagesSince(chat, INITIAL_INGESTION_CURSOR, 'bot')[0],
      getMessagesSince(chat, '', 'bot')[0],
      getNewMessages([chat], INITIAL_INGESTION_CURSOR, 'bot').messages[0],
      getNewMessages([chat], '', 'bot').messages[0],
      getRecentConversationMessages(chat, '')[0],
      getRecentConversationMessagesForExactJids([chat], '')[0],
    ]) {
      expect(row).toMatchObject({ content: 'Second', timestamp: m.timestamp, sender_identity: m.sender_identity,
        telegram_editable: true, telegram_receiver_id: '42', telegram_edit_revision: 1,
        telegram_edit_group_folder: 'fixture-a', telegram_update_id: '765', tenant_id: 'fixture' });
      expect(isTelegramMessageSnapshotCurrent(row!)).toBe(true);
    }
    expect(read(m)!.ingestion_cursor).toBe(first.ingestion_cursor);
    expect(getNewMessages([chat], first.ingestion_cursor!, 'bot').messages).toEqual([]);
    expect(isTelegramMessageSnapshotCurrent(first)).toBe(false);
  });

  it('accepts newer versions, ignores old edits and same-body receipts even with another update id', () => {
    const m = original();
    storeMessage(m);
    const edit = { ...m, content: 'Edited' };
    expect(applyTelegramMessageEdit(edit, at + 3)).toBe('applied');
    expect(applyTelegramMessageEdit({ ...edit, telegram_update_id: '999' }, at + 3)).toBe('ignored');
    expect(applyTelegramMessageEdit(edit, at + 4)).toBe('ignored');
    expect(applyTelegramMessageEdit({ ...m, content: 'Earlier' }, at + 3)).toBe('ignored');
    storeMessage(m);
    expect(read(m)!.content).toBe('Edited');
    expect(revision(m)).toBe(1);
  });

  it('quarantines contradictory originals and does not clear uncertainty on replay', () => {
    const m = original();
    storeMessage(m);
    expect(storeMessage({ ...m, content: 'Conflicting original' })).toBe(true);
    expect(storeMessage({ ...m, content: 'Conflicting original' })).toBe(false);
    expect(read(m)).toBeUndefined();
    storeMessage(m);
    expect(read(m)).toBeUndefined();
    expect(revision(m)).toBe(1);
    expect(isTelegramMessageSnapshotCurrent(m)).toBe(false);
    expect(isTelegramMessageAdmissionCurrentFrom(getDb(), chat, m.id)).toBe(false);
    expect(applyTelegramMessageEdit({ ...m, content: 'Verified' }, at + 1)).toBe('applied');
    expect(read(m)!.content).toBe('Verified');
  });

  it('removes ambiguous bytes from legacy readers and accepts only a strictly later verified event', () => {
    const m = original();
    storeMessage(m);
    const first = read(m)!;
    expect(applyTelegramMessageEdit({ ...m, content: 'A' }, at + 2)).toBe('applied');
    expect(applyTelegramMessageEdit({ ...m, content: 'B' }, at + 2)).toBe('quarantined');
    expect(applyTelegramMessageEdit({ ...m, content: 'A' }, at + 2)).toBe('ignored');
    expect(applyTelegramMessageEdit({ ...m, content: 'B' }, at + 2)).toBe('ignored');
    expect(read(m)).toBeUndefined();
    expect(getDb().prepare('SELECT content FROM messages').pluck().get()).toBe('');
    expect(revision(m)).toBe(2);
    expect(applyTelegramMessageEdit({ ...m, content: 'B' }, at + 3)).toBe('applied');
    expect(read(m)!.ingestion_cursor).toBe(first.ingestion_cursor);
    expect(revision(m)).toBe(3);
  });

  it('retains only an early time barrier; a late original does not become runnable', () => {
    const m = original();
    const edit = { ...m, content: 'Unbound' };
    expect(applyTelegramMessageEdit(edit, at + 5)).toBe('ignored');
    expect(getDb().prepare('SELECT count(*) FROM messages').pluck().get()).toBe(0);
    expect(revision(m)).toBeUndefined();
    expect(getDb().prepare('SELECT original_hash, observed_hash FROM telegram_text_edit_state').get())
      .toEqual({ original_hash: null, observed_hash: null });
    expect(storeMessage(m)).toBe(true);
    expect(storeMessage(m)).toBe(false);
    expect(read(m)).toBeUndefined();
    expect(getMessagesSince(chat, INITIAL_INGESTION_CURSOR, 'bot')).toEqual([]);
    expect(applyTelegramMessageEdit(edit, at + 4)).toBe('ignored');
    expect(applyTelegramMessageEdit(edit, at + 5)).toBe('ignored');
    expect(applyTelegramMessageEdit(edit, at + 6)).toBe('applied');
    expect(read(m)!.content).toBe('Unbound');
    expect(getDb().prepare('SELECT count(*) FROM message_ingestion').pluck().get()).toBe(1);
  });

  it('rejects changed sender, chat, profile, receiver, tenant, folder, time and unsupported provenance', () => {
    const m = original();
    storeMessage(m);
    const edited = { ...m, content: 'Unexpected' };
    const identity = { ...m.sender_identity! };
    const variations: Partial<NewMessage>[] = [
      { sender: '702' }, { chat_jid: 'tg:702' }, { telegram_receiver_id: '43' }, { telegram_receiver_id: undefined },
      { telegram_edit_group_folder: 'fixture-b' }, { sender_identity: { ...identity, bot_id: 'other' } },
      { sender_identity: { ...identity, persona_id: 'other' } }, { tenant_id: 'other' }, { tenant_id: undefined },
      { sender_identity: { ...identity, is_owner_sender: false } }, { sender_identity: undefined },
      { sender_identity: { ...identity, telegram_message_origin: 'forwarded' } },
      { sender_identity: { ...identity, telegram_message_origin: 'quoted' } }, { is_bot_message: true },
      { is_from_me: true }, { timestamp: new Date(at * 1000).toISOString() }, { telegram_editable: undefined },
    ];
    for (const variation of variations) {
      expect(applyTelegramMessageEdit({ ...edited, ...variation }, at + 1)).toBe('ignored');
    }
    expect(applyTelegramMessageEdit(edited, at - 1)).toBe('ignored');
    expect(applyTelegramMessageEdit(edited, NaN)).toBe('ignored');
    storeMessage({ ...edited, telegram_editable: undefined, sender_identity: undefined });
    expect(read(m)!.content).toBe(m.content);
    expect(revision(m)).toBe(0);
  });

  it('a command edit arriving before its original blocks only the matching source, including after receiver rotation', () => {
    const m = original();
    const unsupported = { ...m, content: '', telegram_editable: false };
    for (let i = 0; i < 10; i++) {
      expect(applyTelegramMessageEdit({ ...unsupported, telegram_receiver_id: '43' }, at + 1)).toBe('ignored');
      expect(applyTelegramMessageEdit(unsupported, at + 3)).toBe('ignored');
    }
    expect(getDb().prepare('SELECT count(*) FROM telegram_text_edit_state').pluck().get()).toBe(2);
    const unrelated = original('7');
    storeMessage(unrelated);
    expect(read(unrelated)?.content).toBe(unrelated.content);
    storeMessage(m);
    expect(read(m)).toBeUndefined();
    expect(applyTelegramMessageEdit(m, at + 2)).toBe('ignored');
    expect(getDb().prepare('SELECT count(*) FROM telegram_text_edit_state WHERE original_hash IS NULL').pluck().get()).toBe(0);
    expect(applyTelegramMessageEdit({ ...m, content: 'Verified' }, at + 4)).toBe('applied');
    expect(read(m)?.content).toBe('Verified');
  });

  it('cleans unmatched markers on explicit chat purge; a legacy stored row never seeds an orphan', () => {
    const legacy = { ...original(), telegram_editable: undefined };
    storeMessage(legacy);
    expect(applyTelegramMessageEdit(original(), at + 1)).toBe('ignored');
    const missing = original('9');
    applyTelegramMessageEdit(missing, at + 3);
    expect(getDb().prepare('SELECT count(*) FROM telegram_text_edit_state').pluck().get()).toBe(1);
    getDb().prepare('DELETE FROM messages WHERE chat_jid = ?').run(chat);
    getDb().prepare('DELETE FROM chats WHERE jid = ?').run(chat);
    expect(getDb().prepare('SELECT count(*) FROM telegram_text_edit_state').pluck().get()).toBe(0);
  });

  it('storage errors roll the body, revision and time barrier back together', () => {
    const m = original();
    storeMessage(m);
    getDb().exec(`CREATE TRIGGER fail_edit BEFORE UPDATE OF revision ON telegram_text_edit_state BEGIN
      SELECT RAISE(ABORT, 'synthetic write failure'); END;`);
    expect(() => applyTelegramMessageEdit({ ...m, content: 'Second' }, at + 1)).toThrow('synthetic write failure');
    expect(read(m)?.content).toBe(m.content);
    expect(revision(m)).toBe(0);
    getDb().exec('DROP TRIGGER fail_edit');
    expect(applyTelegramMessageEdit({ ...m, content: 'Second' }, at + 1)).toBe('applied');
  });

  it('a different receiver cannot use a pending barrier to disqualify an original', () => {
    const m = original();
    expect(applyTelegramMessageEdit({ ...m, telegram_receiver_id: '43' }, at + 1)).toBe('ignored');
    storeMessage(m);
    expect(read(m)?.content).toBe(m.content);
    expect(revision(m)).toBe(0);
  });

  it('preserves a later ambiguous instruction as a barrier to reopening an older saved final', () => {
    const older = original('5'), newer = original('6'), unbound = original('7');
    storeMessage(older); storeMessage(newer);
    const start = read(older)!.ingestion_cursor!;
    const end = read(newer)!.ingestion_cursor!;
    expect(hasQuarantinedTelegramInputAfter(chat, start)).toBe(false);
    applyTelegramMessageEdit({ ...unbound, content: '', telegram_editable: false }, at + 2);
    expect(hasQuarantinedTelegramInputAfter(chat, start)).toBe(false);
    applyTelegramMessageEdit({ ...newer, content: '', telegram_editable: false }, at + 3);
    expect(getMessagesSince(chat, start, 'bot')).toEqual([]);
    expect(hasQuarantinedTelegramInputAfter(chat, start, start)).toBe(false);
    expect(hasQuarantinedTelegramInputAfter(chat, start, end)).toBe(true);
    expect(hasQuarantinedTelegramInputAfter(chat, start)).toBe(true);
    expect(hasQuarantinedTelegramInputAfter(chat, older.timestamp, newer.timestamp)).toBe(true);
    expect(hasQuarantinedTelegramInputAfter('tg:702', start)).toBe(false);
    expect(hasQuarantinedTelegramInputAfter(chat, end)).toBe(false);
    expect(hasQuarantinedTelegramInputAfter(chat, start, 'invalid')).toBe(true);
    expect(hasQuarantinedTelegramInputAfter('701@s.whatsapp.net', 'invalid')).toBe(false);
    applyTelegramMessageEdit({ ...newer, content: 'Verified' }, at + 4);
    expect(hasQuarantinedTelegramInputAfter(chat, start)).toBe(false);
    expect(getMessagesSince(chat, start, 'bot')[0].content).toBe('Verified');
  });

  it('accepts an unusable direct edit as invalidation without storing its payload or scheduling work', () => {
    const m = original();
    storeMessage(m);
    const unsupported = { ...m, content: '', telegram_editable: false };
    expect(applyTelegramMessageEdit({ ...unsupported, content: 'untrusted command' }, at + 1)).toBe('ignored');
    expect(applyTelegramMessageEdit(unsupported, at + 1)).toBe('quarantined');
    expect(applyTelegramMessageEdit(unsupported, at + 1)).toBe('ignored');
    expect(read(m)).toBeUndefined();
    expect(applyTelegramMessageEdit({ ...m, content: 'Supported' }, at + 2)).toBe('applied');
    expect(read(m)?.content).toBe('Supported');
  });

  it('uses local blockquote edits only to revoke a matching direct original and imports no quoted text', () => {
    const m = original();
    const quoted: NewMessage = { ...m, content: '', telegram_editable: false,
      sender_identity: { ...m.sender_identity!, telegram_message_origin: 'quoted' } };
    expect(applyTelegramMessageEdit(quoted, at + 1)).toBe('ignored');
    expect(getDb().prepare('SELECT count(*) FROM telegram_text_edit_state').pluck().get()).toBe(0);
    storeMessage(m);
    expect(applyTelegramMessageEdit({ ...quoted, telegram_receiver_id: '43' }, at + 1)).toBe('ignored');
    expect(applyTelegramMessageEdit({ ...quoted, content: 'Quoted words' }, at + 1)).toBe('ignored');
    expect(applyTelegramMessageEdit({ ...quoted, sender_identity: { ...m.sender_identity!, telegram_message_origin: 'forwarded' } }, at + 1)).toBe('ignored');
    expect(applyTelegramMessageEdit({ ...quoted, telegram_editable: true, content: 'Quoted words' }, at + 1)).toBe('ignored');
    expect(read(m)?.content).toBe(m.content);
    expect(applyTelegramMessageEdit(quoted, at + 1)).toBe('ignored');
    const local: NewMessage = { ...quoted, telegram_edit_local_quote: true };
    expect(applyTelegramMessageEdit(local, at + 1)).toBe('quarantined');
    expect(applyTelegramMessageEdit(local, at + 1)).toBe('ignored');
    const late = original('9');
    expect(applyTelegramMessageEdit({ ...late, content: '', telegram_editable: false, telegram_edit_local_quote: true,
      sender_identity: local.sender_identity }, at + 4)).toBe('ignored');
    expect(storeMessage(late)).toBe(true);
    expect(read(late)).toBeUndefined();
    expect(applyTelegramMessageEdit(late, at + 3)).toBe('ignored');
    expect(applyTelegramMessageEdit(late, at + 5)).toBe('applied');
    expect(read(m)).toBeUndefined();
    expect(canExecuteTelegramMessageSnapshot(m)).toBe(false);
  });

  it('preserves the binding proof across an edit and invalidates it after deleting and reinserting an identical source', () => {
    const m = original();
    storeMessage(m);
    const first = read(m)!;
    const binding = getTelegramMessageEditBindingHash(chat, m.id)!;
    expect(binding).toMatch(/^[a-f0-9]{64}$/);
    expect(getTelegramMessageEditBindingHash('tg:702', m.id)).toBeUndefined();
    expect(applyTelegramMessageEdit({ ...m, content: 'Another' }, at + 1)).toBe('applied');
    expect(getTelegramMessageEditBindingHash(chat, m.id)).toBe(binding);
    getDb().prepare('DELETE FROM messages WHERE id = ? AND chat_jid = ?').run(m.id, chat);
    expect(getTelegramMessageEditBindingHash(chat, m.id)).toBeUndefined();
    storeMessage(m);
    expect(read(m)!.content).toBe(first.content);
    expect(revision(m)).toBe(0);
    expect(getTelegramMessageEditBindingHash(chat, m.id)).not.toBe(binding);
    expect(isTelegramMessageSnapshotCurrent(first)).toBe(false);
    expect(markTelegramMessageSnapshotsAdmitted([first])).toBe(false);
    expect(isTelegramMessageSnapshotCurrent(read(m)!)).toBe(true);
  });

  it('pre-upgrade and forwarded rows receive no retrospective direct-text binding', () => {
    const m = original();
    const legacy = { ...m, telegram_editable: undefined, telegram_receiver_id: undefined, telegram_edit_group_folder: undefined };
    storeMessage(legacy);
    storeMessage(m);
    expect(applyTelegramMessageEdit({ ...m, content: 'Wrong' }, at + 2)).toBe('ignored');
    expect(read(m)?.content).toBe(m.content);
    expect(revision(m)).toBeUndefined();
    const unbound = read(m)!;
    expect(isTelegramMessageSnapshotCurrent(unbound)).toBe(true);
    expect(markTelegramMessageSnapshotsAdmitted([unbound])).toBe(true);
    const bare = new Database(':memory:');
    try {
      expect(getTelegramMessageEditRevisionFrom(bare, chat, m.id)).toBeUndefined();
      expect(isTelegramMessageAdmissionCurrentFrom(bare, chat, m.id)).toBe(true);
    } finally { bare.close(); }
  });

  it('verifies a batch atomically and persists admission across A→B→A and database reopen', async () => {
    const m = original(), other = original('9');
    storeMessage(m); storeMessage(other);
    const first = read(m)!, next = read(other)!;
    expect(markTelegramMessageSnapshotsAdmitted([next, { ...first, content: 'stale' }])).toBe(false);
    expect(getDb().prepare('SELECT count(*) FROM telegram_text_edit_state WHERE admitted_revision IS NOT NULL').pluck().get()).toBe(0);
    expect(markTelegramMessageSnapshotsAdmitted([first])).toBe(true);
    expect(markTelegramMessageSnapshotsAdmitted([first])).toBe(true);
    expect(applyTelegramMessageEdit({ ...m, content: 'Transient' }, at + 1)).toBe('applied');
    expect(applyTelegramMessageEdit(m, at + 2)).toBe('applied');
    const latest = read(m)!;
    expect(isTelegramMessageSnapshotCurrent(first)).toBe(false);
    expect(isTelegramMessageSnapshotCurrent(latest)).toBe(true);
    expect(canExecuteTelegramMessageSnapshot(latest)).toBe(false);
    expect(markTelegramMessageSnapshotsAdmitted([latest])).toBe(false);
    expect(isTelegramMessageAdmissionCurrentFrom(getDb(), chat, m.id)).toBe(false);
    expect(canExecuteTelegramMessageSnapshot(next)).toBe(true);
    const folder = mkdtempSync(join(tmpdir(), 'telegram-edit-test-'));
    const file = join(folder, 'fixture.sqlite');
    try {
      await getDb().backup(file);
      const reopened = new Database(file);
      try {
        ensureTelegramMessageEditSchema(reopened);
        expect(currentTelegramSnapshot(reopened, first)).toBe(false);
        expect(currentTelegramSnapshot(reopened, latest, true)).toBe(false);
        expect(getTelegramMessageEditRevisionFrom(reopened, chat, m.id)).toBe(2);
        expect(applyTelegramEdit(reopened, { ...m, content: 'Late replay' }, at + 1)).toBe('ignored');
        reopened.prepare('DELETE FROM messages WHERE chat_jid = ? AND id = ?').run(chat, m.id);
        expect(getTelegramMessageEditRevisionFrom(reopened, chat, m.id)).toBeUndefined();
        expect(currentTelegramSnapshot(reopened, latest)).toBe(false);
      } finally { reopened.close(); }
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
