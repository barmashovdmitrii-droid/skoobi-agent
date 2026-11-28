import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createTelegramSenderIdentity, parseOwnerAllowlistConfig } from '@skoobi/shared/telegram-identity';
import {
  _initTestDatabase, getDb, getMessagesByIds, getMessagesSince, INITIAL_INGESTION_CURSOR,
  markTelegramMessageSnapshotsAdmitted, storeChatMetadata, storeMessage,
} from './db.js';
import { isTelegramEditHostControl } from './message-loop.js';
import { receiveTelegramMessageEdit } from './telegram-edit-intake.js';
import { registerMemoryWriteCapability, _clearMemoryWriteCapabilities, authorizeMemoryStateRequest } from './memory-provenance.js';
import { handleMemoryStateRequest } from './memory-state-service.js';
import { buildRecalledStructuredMemoryContext } from './memory-prompt-recall.js';
import type { NewMessage } from './types.js';

const jid = 'tg:207', folder = 'edit-fixture', tenantId = 'tg_chat_207';
const seconds = 1770000000;
const identity = { ...createTelegramSenderIdentity({ chatId: 207, fromId: 207,
  botId: 'telegram_default', personaId: 'default',
  ownerAllowlist: parseOwnerAllowlistConfig({telegram_user_ids: ['207']}) }), telegram_message_origin: 'direct' as const };
const original: NewMessage = { chat_jid:jid, id:'21', sender:'207', sender_name:'Fixture', content:'Подтверждаю тестовый выбор.',
  timestamp: new Date(seconds * 1000).toISOString(), tenant_id:tenantId, sender_identity:identity,
  telegram_editable:true, telegram_receiver_id:'506', telegram_edit_group_folder:folder };
let dir: string;
function host() {
  return { authorized: () => true, isControl: isTelegramEditHostControl,
    invalidateActive: vi.fn(() => false), consumedThrough: () => INITIAL_INGESTION_CURSOR,
    router: { route: vi.fn(async (_envelope: unknown, _allowed?: () => boolean) => 'sent') },
    noticeFailed: vi.fn() };
}
beforeEach(() => {
  _initTestDatabase();
  dir = mkdtempSync(path.join(os.tmpdir(),'edit-memory-'));
  storeChatMetadata(jid, original.timestamp);
  storeMessage(original);
});
afterEach(() => {
  _clearMemoryWriteCapabilities();
  getDb().close();
  rmSync(dir,{recursive:true,force:true});
});

it('polls corrected pending work once with the original cursor and no notice', () => {
  const h=host();
  const cursor=getMessagesByIds(jid,[original.id])[0].ingestion_cursor;
  const corrected={...original,content:'Новый текст.'};
  receiveTelegramMessageEdit(h,jid,corrected,seconds+1);
  receiveTelegramMessageEdit(h,jid,corrected,seconds+1);
  const pending=getMessagesSince(jid,INITIAL_INGESTION_CURSOR,'fixture');
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({content:corrected.content,ingestion_cursor:cursor});
  expect(getMessagesSince(jid,cursor!,'fixture')).toHaveLength(0);
  expect(h.router.route).not.toHaveBeenCalled();
  expect(h.invalidateActive).toHaveBeenCalledTimes(1);
});

it('requires fresh instruction for admitted work and withdraws an obsolete or revoked notice', () => {
  let authorized=true;
  const h={...host(),authorized:()=>authorized};
  expect(markTelegramMessageSnapshotsAdmitted(getMessagesByIds(jid,[original.id]))).toBe(true);
  receiveTelegramMessageEdit(h,jid,{...original,content:'Первое изменение.'},seconds+1);
  const first=h.router.route.mock.calls[0][1]!;
  expect(first()).toBe(true);
  receiveTelegramMessageEdit(h,jid,{...original,content:'перезапусти агента'},seconds+2);
  expect(getMessagesByIds(jid,[original.id])).toHaveLength(0);
  const second=h.router.route.mock.calls[1][1]!;
  expect(first()).toBe(false);
  expect(second()).toBe(true);
  authorized=false;
  expect(second()).toBe(false);
  receiveTelegramMessageEdit(h,jid,original,seconds+3);
  expect(h.router.route).toHaveBeenCalledTimes(2);
});

it('invalidates a signed write and old citation even if an edit restores the exact original bytes during recall', async () => {
  const cap=registerMemoryWriteCapability({groupFolder:folder,chatJid:jid,isMain:true,tenantId,
    senderIdentity:identity,memoryWriteAllowed:true,currentMessageIds:[original.id]},dir).capability;
  const call=(payload:unknown)=>{
    const fields={type:'memory_state' as const,request_id:randomUUID(),payload};
    return handleMemoryStateRequest({...fields,...authorizeMemoryStateRequest(cap,fields)},folder);
  };
  expect(markTelegramMessageSnapshotsAdmitted(getMessagesByIds(jid,[original.id]))).toBe(true);
  const op={action:'mutate',operation:{kind:'fact_upsert',projectKey:null,key:'fixture-choice',value:'fixtureChosenMaterial',
    operationId:'fixture-write',expectedRevision:0},source:{kind:'direct_user',messageId:original.id,quote:original.content}};
  expect(call(op)).toMatchObject({ok:true,data:{record:{value:op.operation.value}}});
  const recallInput={chatJid:jid,senderId:original.sender,senderIdentity:identity,tenant:{tenant_id:tenantId},
    currentText:'Какой fixtureChosenMaterial выбрали?'};
  let edited=false;
  const h=host();
  const recalled=await buildRecalledStructuredMemoryContext(getDb(),recallInput,{encoder:{
    fingerprint:'edit-fixture',dimensions:3,
    async encode(texts,kind) {
      if(kind==='query' && !edited) {
        edited=true;
        receiveTelegramMessageEdit(h,jid,{...original,content:'Противоположное решение.'},seconds+1);
        receiveTelegramMessageEdit(h,jid,original,seconds+2);
      }
      return texts.map(()=>[1,0,0]);
    },
  }});
  expect(edited).toBe(true);
  expect(recalled.context).not.toContain(op.operation.value);
  expect(call({action:'list'})).toMatchObject({ok:true,data:{facts:[{value:'',requiresSourceReview:true}]}});
  expect(call({...op,operation:{...op.operation,operationId:'second-write',expectedRevision:1}}))
    .toMatchObject({ok:false,error:'current_direct_source_required'});
  expect(call({action:'operation_status',operationId:'fixture-write'})).toMatchObject({ok:true});
});

it.each(['стоп', 'останови текущую задачу', 'пришли готовый ответ', '/codex_gui input', '/remote-control', 'перезапусти агента'])(
  'editing into a host command withdraws the input without executing the command (%s)', text => {
    const h=host();
    receiveTelegramMessageEdit(h,jid,{...original,content:text},seconds+1);
    expect(getMessagesByIds(jid,[original.id])).toEqual([]);
    expect(h.router.route).toHaveBeenCalledTimes(1);
  },
);
