import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDeferredAnswerDraft, readDeferredInputCheckpoints, registerDeferredInputSource } from './deferred-continuation.js';
import { archiveSupersededContinuationInputs } from './timeout-continuation.js';
import { ensureIpcDirectoryLayout } from './ipc-paths.js';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Channel, NewMessage } from './types.js';
import { _initTestDatabase, applyTelegramMessageEdit, getDb, getMessagesByIds, setRegisteredGroup, storeMessage } from './db.js';
import { createMessageRouter } from './outbound-router.js';
import { admitTelegramEditInputs, currentTelegramEditGuard, invalidateTelegramEditTurn,
  issueTelegramEditIpcBinding, withTelegramEditIpcGuard, withTelegramEditTurn } from './telegram-edit-turn.js';

const chat = 'tg:701';
const at = 1_700_000_000;
function source(id: string): NewMessage {
  return {id, chat_jid: chat, sender: '701', sender_name: 'Fixture', content: 'First',
    timestamp: new Date(at * 1000).toISOString(),
    sender_identity: {channel: 'telegram', chat_id: '701', telegram_user_id: '701', identity_id: 'telegram_user_701',
      bot_id: 'telegram_default', is_owner_sender: true, telegram_message_origin: 'direct'},
    telegram_editable: true, telegram_receiver_id: '42', telegram_edit_group_folder: 'fixture'};
}
function registerFolder(folder: string) {
  setRegisteredGroup(chat, {name: 'Sample', folder, trigger: '', added_at: new Date(at * 1000).toISOString()});
}
beforeEach(() => {
  _initTestDatabase();
  registerFolder('fixture');
});

it('binds initial and piped sources, checks only the matching group and drops late text even after the text changes back', async () => {
  const initial = source('1'), piped = source('2');
  storeMessage(initial); storeMessage(piped);
  let token: string | undefined;
  await withTelegramEditTurn(chat, async () => {
    expect(admitTelegramEditInputs(chat, getMessagesByIds(chat, ['1']))).toBe(true);
    token = issueTelegramEditIpcBinding('fixture');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(admitTelegramEditInputs(chat, getMessagesByIds(chat, ['2']))).toBe(true);
    expect(invalidateTelegramEditTurn('tg:other', '1')).toBe(false);
    expect(invalidateTelegramEditTurn(chat, '3')).toBe(false);
    expect(currentTelegramEditGuard()?.()).toBe(true);
  });
  const channel = {name: 'telegram', ownsJid: () => true, isConnected: () => true, sendMessage: vi.fn(async () => {})};
  const router = createMessageRouter([channel as unknown as Channel]);
  const deliver = (folder: string, binding: unknown) => withTelegramEditIpcGuard(folder, binding, () =>
    router.route({chatJid: chat, groupFolder: folder, triggerType: 'ipc', text: 'Fixture result'}));
  expect(await deliver('fixture', token)).toBe('Fixture result');
  registerFolder('replacement');
  expect(await deliver('fixture', token)).toBeNull();
  registerFolder('fixture');
  expect(await deliver('another', token)).toBeNull();
  expect(await deliver('fixture', 'wrong')).toBeNull();
  router.addPreHook(async () => {
    await Promise.resolve();
    applyTelegramMessageEdit({...piped,content:'Revised'}, at + 1);
    applyTelegramMessageEdit(piped, at + 2);
    return {action:'continue'};
  });
  expect(await deliver('fixture', token)).toBeNull();
  expect(channel.sendMessage).toHaveBeenCalledTimes(1);
  // A legacy/background item has neither these sources nor this token.
  expect(await deliver('fixture', undefined)).toBe('Fixture result');
});

it('an edit in another source does not revoke the active batch', async () => {
  const m = source('3'), other = source('4');
  storeMessage(m); storeMessage(other);
  await withTelegramEditTurn(chat, async () => {
    admitTelegramEditInputs(chat, getMessagesByIds(chat, ['3']));
    applyTelegramMessageEdit({...other, content:'Other'}, at + 1);
    expect(invalidateTelegramEditTurn(chat, '4')).toBe(false);
    expect(currentTelegramEditGuard()?.()).toBe(true);
    applyTelegramMessageEdit({...m, content:'New'}, at + 2);
    expect(invalidateTelegramEditTurn(chat, '3')).toBe(true);
    expect(currentTelegramEditGuard()?.()).toBe(false);
  });
});

it('an unsent hold draft also covers the initial instruction that preceded its piped follow-up', async () => {
  const initial = source('5'), followup = source('6');
  storeMessage(initial); storeMessage(followup);
  const dir = mkdtempSync(join(tmpdir(), 'test-held-edit-'));
  try {
    ensureIpcDirectoryLayout(dir);
    await withTelegramEditTurn(chat, async () => {
      const rows = getMessagesByIds(chat, ['5', '6']);
      admitTelegramEditInputs(chat, rows);
      const file = 'pending.json';
      registerDeferredInputSource(chat, file, {messageIds:['6'], ingestionCursors:[rows[1].ingestion_cursor!]});
      writeFileSync(join(dir, 'input', file), JSON.stringify({type:'message', afterFailedHold:true, holdOriginalText:'Draft'}));
      expect(readDeferredInputCheckpoints(dir, chat)[0]).toMatchObject({name: file, recoverable: true});
      expect(readDeferredInputCheckpoints(dir, chat)[0].telegramEditSuperseded).toBeUndefined();
      expect(readDeferredAnswerDraft(dir, chat)).toBe('Draft');
    });
    expect(applyTelegramMessageEdit({...initial, content:'Edited'}, at + 1)).toBe('applied');
    expect(readDeferredInputCheckpoints(dir, chat)[0].telegramEditSuperseded).toBe(true);
    expect(readDeferredAnswerDraft(dir, chat)).toBeNull();
    const obsolete = readDeferredInputCheckpoints(dir, chat).filter(entry => entry.telegramEditSuperseded);
    expect(obsolete.map(entry => entry.name)).toEqual(['pending.json']);
    archiveSupersededContinuationInputs(dir, obsolete.map(entry => entry.name));
    expect(readDeferredInputCheckpoints(dir, chat)).toEqual([]);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

it('deleting and re-registering an identical message ID and body cannot revive a previous runner binding', async () => {
  const original = source('7');
  storeMessage(original);
  const binding = await withTelegramEditTurn(chat, async () => {
    admitTelegramEditInputs(chat, getMessagesByIds(chat, ['7']));
    return issueTelegramEditIpcBinding('fixture');
  });
  getDb().prepare('DELETE FROM messages WHERE chat_jid=? AND id=?').run(chat, '7');
  storeMessage(original);
  const allowed = await withTelegramEditIpcGuard('fixture', binding, async () => currentTelegramEditGuard()?.());
  expect(allowed).toBe(false);
});

it('drops stale empty IPC and records a late transport acknowledgement without moving the next batch cursor', async () => {
  const original = source('8');
  storeMessage(original);
  const binding = await withTelegramEditTurn(chat, async () => {
    admitTelegramEditInputs(chat, getMessagesByIds(chat, ['8']));
    return issueTelegramEditIpcBinding('fixture');
  });
  const sendMessage = vi.fn(async () => {
    await Promise.resolve();
    applyTelegramMessageEdit({...original,content:'Changed during transport'}, at + 1);
  });
  const router = createMessageRouter([{name:'telegram',ownsJid:()=>true,isConnected:()=>true,sendMessage} as unknown as Channel]);
  const receipt = vi.fn();
  router.addPostHook(receipt);
  const send = (text: string) => withTelegramEditIpcGuard('fixture', binding, () =>
    router.route({chatJid:chat, groupFolder:'fixture', triggerType:'ipc', text}));
  expect(await send('Sent before correction')).toBe('Sent before correction');
  expect(receipt.mock.calls[0][0].meta.suppressCursorAdvance).toBe(true);
  expect(await send('<internal>empty</internal>')).toBeNull();
  expect(receipt).toHaveBeenCalledTimes(1);
  expect(sendMessage).toHaveBeenCalledTimes(1);
});
