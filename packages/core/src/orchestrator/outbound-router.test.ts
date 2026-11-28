import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
const fixtures=fs.mkdtempSync(path.join(os.tmpdir(),'router-files-'));
const fixtureFile=(name:string)=>{const p=path.join(fixtures,name);fs.writeFileSync(p,'fixture bytes');return p;};
afterAll(()=>fs.rmSync(fixtures,{recursive:true,force:true}));
import { createMessageRouter } from './outbound-router.js';
import {_initTestDatabase,getDb} from './db.js';
import type { Channel, OutboundEnvelope } from './types.js';
import { logger } from './logger.js';
import {rewriteLocalFileLinks} from './local-file-links.js';
import {_resetChatFileSendsForTests} from './chat-file-sends.js';
import {reconcileFileDeliveryFinal} from './file-delivery.js';
import {withOperationTraceRun,bindOperationTraceInputs} from './runtime-operation-trace.js';
import {
  _resetNotedSecretRequests,
  followsSecretRequest,
} from '@skoobi/shared/chat-secrets';

function mockChannel(name: string, jidPrefix: string): Channel {
  return {
    name,
    connect: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    ownsJid: (jid: string) => jid.startsWith(jidPrefix),
    disconnect: vi.fn(),
  };
}

describe('MessageRouter', () => {
  it.each([true, false])('journals a final attachment after transport and protects replay after restart (acknowledged=%s)', async (acknowledged) => {
    _initTestDatabase();
    const db = getDb();
    const file = fixtureFile('linked-report.txt');
    const scope = {sourceGroup:'fixture', chatJid:'tg:local', ownerAuthorized:true};
    const channel = mockChannel('telegram', 'tg:');
    channel.sendDocument = vi.fn(async () => {
      if (!acknowledged) throw new Error('response lost after upload');
    });
    const router = createMessageRouter([channel]);
    const input = {
      text: `[Report](${file})`, groupRoot:fixtures, groupFolder:scope.sourceGroup,
      chatJid:scope.chatJid, ownerAuthorized:true, isMain:true, canSendDocuments:true, router,
    };
    await withOperationTraceRun(scope.chatJid, async () => {
      const trace = bindOperationTraceInputs(db, {tenantId:'fixture',chatId:scope.chatJid}, ['source-1'], 'telegram')!;
      const first = await rewriteLocalFileLinks(input);
      expect(first.sentFiles.length).toBe(acknowledged ? 1 : 0);
      expect(reconcileFileDeliveryFinal(db,scope,trace.attemptId!)).toMatchObject([
        {state: acknowledged ? 'delivered' : 'unknown', artifact: {name:'linked-report.txt'}},
      ]);
    });
    _resetChatFileSendsForTests(); // Same persisted receipts, fresh volatile path hints.
    const second = await rewriteLocalFileLinks(input);
    expect(second.sentFiles).toEqual([]);
    expect(second.links[0].outcome).toBe(acknowledged ? 'already_sent' : 'text_only');
    expect(channel.sendDocument).toHaveBeenCalledTimes(1);
    await rewriteLocalFileLinks({...input, chatJid:'tg:other'});
    expect(channel.sendDocument).toHaveBeenCalledTimes(2);
    _resetChatFileSendsForTests();
  });

  it('rechecks a linked final after async acceptance and before every upload', async () => {
    _initTestDatabase();
    const first = fixtureFile('first-corrected.txt');
    const second = fixtureFile('second-corrected.txt');
    fs.writeFileSync(second, 'different content');
    let current = true;
    const channel = mockChannel('telegram','tg:');
    channel.sendDocument = vi.fn();
    const router = createMessageRouter([channel], {artifactAcceptance: async () => {
      await Promise.resolve();
      current = false;
      return {required:false, status:'not_required', code:'not_applicable'};
    }});
    const result = await rewriteLocalFileLinks({
      text:`[First](${first}) [Second](${second})`, router, canSend:() => current,
      chatJid:'tg:correction', groupFolder:'fixture', groupRoot:fixtures,
      isMain:true, ownerAuthorized:true, canSendDocuments:true,
    });
    expect(result.sentFiles).toEqual([]);
    expect(result.links.map(link => link.reason)).toEqual(['send_failed:final_superseded','send_failed:final_superseded']);
    expect(channel.sendDocument).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT state,code FROM file_delivery_receipts').all())
      .toEqual(Array(2).fill({state:'blocked',code:'final_superseded'}));
  });

  it('remembers a delivered request for a password or a code, not a plain reply (W19 review)', async () => {
    _resetNotedSecretRequests();
    try {
      const channel = mockChannel('telegram', 'tg:');
      const router = createMessageRouter([channel]);
      const later = Date.now() + 30_000;
      await router.route({ chatJid: 'tg:555', text: 'Готово, отчёт в таблице', triggerType: 'agent-response' });
      expect(followsSecretRequest(undefined, later, 'tg:555')).toBe(false);
      // An interim reply is never stored in messages: only this note remembers it.
      await router.route({
        chatJid: 'tg:555',
        text: '⏳ Окно входа открыто — пришли код из SMS, введу сам',
        triggerType: 'agent-response',
        meta: { kind: 'agent_progress' },
      });
      expect(followsSecretRequest(undefined, later, 'tg:555')).toBe(true);
      // Not delivered — not remembered.
      const offline = mockChannel('telegram', 'tg:');
      offline.sendMessage = vi.fn().mockRejectedValue(new Error('network down'));
      await expect(
        createMessageRouter([offline]).route({ chatJid: 'tg:556', text: 'Пришли пароль от Mac', triggerType: 'agent-response' }),
      ).rejects.toThrow();
      expect(followsSecretRequest(undefined, later, 'tg:556')).toBe(false);
    } finally {
      _resetNotedSecretRequests();
    }
  });

  it('drops a saved answer if middleware selects a different recipient', async () => {
    const channel = mockChannel('telegram', 'tg:');
    const router = createMessageRouter([channel]);
    router.addPreHook(async envelope => ({action: 'modify', envelope: {...envelope, chatJid: 'tg:other'}}));
    const delivered = await router.route({chatJid: 'tg:fixture', text: 'saved', triggerType: 'agent-response'}, () => true);
    expect(delivered).toBeNull();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('rechecks a linked document after asynchronous acceptance and releases its snapshot', async () => {
    const channel = mockChannel('telegram', 'tg:');
    channel.sendDocument = vi.fn();
    const cleanup = vi.fn();
    let active = true;
    const snapshotPath = fixtureFile('checked.zip');
    const router = createMessageRouter([channel], {artifactAcceptance: async () => {
      await Promise.resolve();
      active = false;
      return {required: true, status: 'passed', code: 'checks_passed', snapshotPath, cleanup};
    }});
    // The router reads the frozen snapshot before the liveness recheck, so the
    // fixture files exist: the refusal below is the superseded request alone.
    const delivered = await router.sendDocumentResult!('tg:fixture', fixtureFile('file.zip'), undefined, {canSend: () => active});
    expect(delivered).toMatchObject({state: 'blocked', code: 'final_superseded'});
    expect(channel.sendDocument).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('sends the verified immutable snapshot and cleans it even after a transport failure', async () => {
    const channel = mockChannel('telegram', 'tg:');
    channel.sendDocument = vi.fn().mockRejectedValue(new Error('send outcome unknown'));
    const cleanup = vi.fn();
    const policy = vi.fn().mockResolvedValue({ required: true, status: 'passed', code: 'checks_passed',
      snapshotPath: fixtureFile('snapshot.zip'), cleanup });
    const router = createMessageRouter([channel], { artifactAcceptance: policy });
    expect(await router.sendDocument('tg:123', '/synthetic-workspace/artifact.zip', 'Result')).toBe(false);
    expect(channel.sendDocument).toHaveBeenCalledExactlyOnceWith('tg:123', expect.stringContaining('skoobi-document-'), 'Result');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('blocks only required unverified artifacts and cannot take a model-supplied pass in metadata', async () => {
    const channel = mockChannel('telegram', 'tg:');
    channel.sendDocument = vi.fn();
    const policy = vi.fn().mockResolvedValue({ required: true, status: 'stale', code: 'artifact_changed' });
    const router = createMessageRouter([channel], { artifactAcceptance: policy });
    const observed = vi.fn(); router.addPostHook(observed);
    expect(await router.sendDocument('tg:123', '/synthetic/artifact.zip', 'Result', { meta: { verified: true, status: 'passed' } })).toBe(false);
    expect(channel.sendDocument).not.toHaveBeenCalled();
    expect(observed).not.toHaveBeenCalled();
    await router.route({ chatJid: 'tg:123', text: 'Ordinary reply', triggerType: 'agent-response' });
    expect(channel.sendMessage).toHaveBeenCalledOnce();
    policy.mockResolvedValue({ required: false, status: 'not_required', code: 'contract_missing' });
    expect(await router.sendDocument('tg:123', fixtureFile('ordinary.pdf'))).toBe(true);
    expect(channel.sendDocument).toHaveBeenCalledExactlyOnceWith('tg:123', expect.stringContaining('skoobi-document-'), undefined);
  });

  it('pins bytes through transport and reports acknowledged hash', async()=>{
    const document=fixtureFile('immutable.pdf'), expected=createHash('sha256').update('fixture bytes').digest('hex');
    const channel=mockChannel('telegram','tg:');let sentPath='';
    channel.sendDocument=vi.fn(async(_jid,p)=>{sentPath=p;fs.writeFileSync(document,'changed original');expect(fs.readFileSync(p,'utf8')).toBe('fixture bytes');});
    const beforeTransport=vi.fn();const router=createMessageRouter([channel]);
    expect(await router.sendDocumentResult!('tg:fixture',document,undefined,{expectedSha256:expected,beforeTransport})).toEqual({state:'delivered',code:'api_acknowledged',sha256:expected});
    expect(beforeTransport).toHaveBeenCalledOnce();expect(fs.existsSync(sentPath)).toBe(false);
  });
  it('blocks bytes changed during acceptance before any transport',async()=>{
    const document=fixtureFile('mutated.pdf'),expected=createHash('sha256').update('fixture bytes').digest('hex');const channel=mockChannel('telegram','tg:');channel.sendDocument=vi.fn();const beforeTransport=vi.fn();
    const router=createMessageRouter([channel],{artifactAcceptance:async()=>{fs.writeFileSync(document,'changed');return {required:false,status:'not_required',code:'contract_missing'};}});
    expect(await router.sendDocumentResult!('tg:fixture',document,undefined,{expectedSha256:expected,beforeTransport})).toMatchObject({state:'blocked',code:'artifact_changed'});expect(beforeTransport).not.toHaveBeenCalled();expect(channel.sendDocument).not.toHaveBeenCalled();
  });
  it('logs the real code of a document refused before Telegram (W08)',async()=>{
    const warn=vi.spyOn(logger,'warn').mockImplementation(()=>undefined);
    try{
      const channel=mockChannel('telegram','tg:');channel.sendDocument=vi.fn();
      const router=createMessageRouter([channel],{artifactAcceptance:async()=>{throw new Error('checker missing');}});
      expect(await router.sendDocumentResult!('tg:fixture',fixtureFile('game.zip'))).toEqual({state:'blocked',code:'acceptance_unavailable'});
      expect(channel.sendDocument).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({state:'blocked',code:'acceptance_unavailable',fileBasename:'game.zip'}),'Document not delivered');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('tg:fixture');
    }finally{warn.mockRestore();}
  });
  it('logs only the class and code of a Telegram refusal, never its payload (W08 review)',async()=>{
    const warn=vi.spyOn(logger,'warn').mockImplementation(()=>undefined);
    try{
      // The shape of grammY's GrammyError: the call's payload rides along.
      const refusal=Object.assign(new Error('Call to sendDocument failed! (400: Bad Request: chat not found)'),
        {name:'GrammyError',error_code:400,method:'sendDocument',payload:{chat_id:987654321,caption:'подпись из ответа'}});
      const channel=mockChannel('telegram','tg:');channel.sendDocument=vi.fn().mockRejectedValue(refusal);
      expect(await createMessageRouter([channel]).sendDocumentResult!('tg:987654321',fixtureFile('refused.pdf'),'подпись из ответа'))
        .toMatchObject({state:'unknown',code:'channel_outcome_unknown'});
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({errName:'GrammyError',errCode:400,transportStarted:true,fileBasename:'refused.pdf'}),'Document send failed');
      const logged=JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain('987654321');
      expect(logged).not.toContain('подпись из ответа');
      expect(logged).not.toContain('chat not found');
    }finally{warn.mockRestore();}
  });
  it('keeps channel exceptions ambiguous after transport starts',async()=>{
    const channel=mockChannel('telegram','tg:');channel.sendDocument=vi.fn().mockRejectedValue(new Error('synthetic ACK lost'));
    expect(await createMessageRouter([channel]).sendDocumentResult!('tg:fixture',fixtureFile('unknown.pdf'))).toMatchObject({state:'unknown',code:'channel_outcome_unknown'});
  });
  it('bounds a missing transport ACK and preserves an unknown outcome',async()=>{
    vi.useFakeTimers();
    try{const channel=mockChannel('telegram','tg:');channel.sendDocument=vi.fn(()=>new Promise<void>(()=>{}));
      const pending=createMessageRouter([channel]).sendDocumentResult!('tg:fixture',fixtureFile('hung.pdf'));
      await vi.advanceTimersByTimeAsync(120_001);expect(await pending).toMatchObject({state:'unknown',code:'channel_outcome_unknown'});
    }finally{vi.useRealTimers();}
  });
  it('automatic voice retains the same reusable artifact before transport and temporary cleanup',async()=>{
    _initTestDatabase();const source=fs.mkdtempSync(path.join(fixtures,'auto-voice-'));
    const part={ogg:path.join(source,'voice.ogg'),mp3:path.join(source,'voice.mp3'),wav:path.join(source,'voice.wav')};
    fs.writeFileSync(part.ogg,'OggS fixture');fs.writeFileSync(part.mp3,'ID3 fixture');const wav=Buffer.alloc(48);wav.write('RIFF',0);wav.writeUInt32LE(40,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4,40);fs.writeFileSync(part.wav,wav);
    const channel=mockChannel('telegram','tg:');channel.sendVoice=vi.fn();channel.generateVoiceAudio=vi.fn(async()=>({parts:[part],configuredProvider:'fixture',configuredVoice:'fixture',cleanup:()=>fs.rmSync(source,{recursive:true,force:true})}));
    channel.sendVoiceFile=vi.fn(async(_jid,p)=>{expect(fs.readFileSync(p,'utf8')).toBe('OggS fixture');expect(fs.existsSync(source)).toBe(false);});
    const router=createMessageRouter([channel]),post=vi.fn();router.addPostHook(post);
    expect(await router.sendVoice('tg:fixture','Synthetic automatic voice',{sourceGroup:'router-fixture',chatJid:'tg:fixture',ownerAuthorized:true})).toBe(true);
    expect(channel.generateVoiceAudio).toHaveBeenCalledOnce();expect(channel.sendVoice).not.toHaveBeenCalled();expect(channel.sendVoiceFile).toHaveBeenCalledOnce();
    const row=getDb().prepare("SELECT metadata,state FROM voice_audio_assets").get() as {metadata:string;state:string};const metadata=JSON.parse(row.metadata);expect(row.state).toBe('ready');expect(metadata.sourceText).toBe('Synthetic automatic voice');expect(metadata.durationSeconds).toBeCloseTo(4/96000);expect(post).toHaveBeenCalledWith(expect.objectContaining({meta:expect.objectContaining({voiceAssetId:expect.any(String)})}));
  });
  // Adapted from the public router test: here the channel synthesizes a file
  // (generateVoiceAudio) and the router uploads it, so the two failures are
  // told apart by whether the upload was ever started.
  it('distinguishes synthesis failure from a voice upload with an unknown outcome', async () => {
    _initTestDatabase();
    const source = fs.mkdtempSync(path.join(fixtures, 'voice-outcome-'));
    const part = {ogg: path.join(source, 'voice.ogg'), mp3: path.join(source, 'voice.mp3'), wav: path.join(source, 'voice.wav')};
    fs.writeFileSync(part.ogg, 'OggS fixture');
    fs.writeFileSync(part.mp3, 'ID3 fixture');
    const wav = Buffer.alloc(48);
    wav.write('RIFF', 0); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
    fs.writeFileSync(part.wav, wav);
    const channel = mockChannel('telegram', 'tg:');
    channel.sendVoice = vi.fn();
    channel.generateVoiceAudio = vi.fn()
      .mockRejectedValueOnce(new Error('synthesis failed'))
      .mockImplementationOnce(async () => ({parts: [part], configuredProvider: 'fixture', configuredVoice: 'fixture',
        cleanup: () => fs.rmSync(source, {recursive: true, force: true})}));
    channel.sendVoiceFile = vi.fn().mockRejectedValue(new Error('upload acknowledgement lost'));
    const router = createMessageRouter([channel]);
    const scope = {sourceGroup: 'router-fixture', chatJid: 'tg:fixture', ownerAuthorized: true};
    const control = {canSend: () => true, transportAttempted: vi.fn()};
    expect(await router.sendVoice('tg:fixture', 'ready', scope, control)).toBe(false);
    expect(control.transportAttempted).not.toHaveBeenCalled();
    expect(channel.sendVoiceFile).not.toHaveBeenCalled();
    // A failed synthesis is remembered for the same text, so the upload case
    // uses another text.
    expect(await router.sendVoice('tg:fixture', 'ready again', scope, control)).toBe(false);
    expect(channel.sendVoiceFile).toHaveBeenCalledOnce();
    expect(control.transportAttempted).toHaveBeenCalled();
    expect(channel.sendVoice).not.toHaveBeenCalled();
  });
  it('does not silently skip a required check when the host verifier is unavailable', async () => {
    const channel = mockChannel('telegram', 'tg:');
    channel.sendDocument = vi.fn();
    const router = createMessageRouter([channel], { artifactAcceptance: async () => { throw new Error('Unavailable'); } });
    expect(await router.sendDocument('tg:123', '/synthetic/artifact.zip')).toBe(false);
    expect(channel.sendDocument).not.toHaveBeenCalled();
  });
  it('drains only the explicitly finished progress turn before sending its final', async () => {
    const channel = mockChannel('telegram', 'tg:');
    const calls: string[] = [];
    let release!: () => void;
    channel.finishProgress = vi.fn().mockImplementation(async (_jid, key) => {
      calls.push(`finish:${key}`);
      await new Promise<void>((resolve) => { release = resolve; });
    });
    channel.sendMessage = vi.fn().mockImplementation(async () => { calls.push('final'); });
    const router = createMessageRouter([channel]);
    const pending = router.route({ chatJid: 'tg:123', text: 'Done', triggerType: 'agent-response',
      meta: { progressKey: 'turn-1', progressFinal: true } });
    await vi.waitFor(() => expect(channel.finishProgress).toHaveBeenCalledOnce());
    expect(calls).toEqual(['finish:turn-1']);
    release();
    expect(await pending).toBe('Done');
    expect(calls).toEqual(['finish:turn-1', 'final']);
  });

  it('does not close live progress for an unrelated background result', async () => {
    const channel = mockChannel('telegram', 'tg:');
    channel.finishProgress = vi.fn();
    const router = createMessageRouter([channel]);
    await router.route({ chatJid: 'tg:123', text: 'Other task completed', triggerType: 'extension' });
    expect(channel.finishProgress).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledOnce();
  });

  it('does not count a closed turn status as delivered', async () => {
    const channel = mockChannel('telegram', 'tg:');
    channel.sendProgress = vi.fn().mockResolvedValue(false);
    const router = createMessageRouter([channel]);
    const observer = vi.fn(); router.addPostHook(observer);
    expect(await router.route({ chatJid: 'tg:123', text: 'Stale progress', triggerType: 'agent-response',
      meta: { kind: 'agent_progress', progressKey: 'closed' } })).toBeNull();
    expect(observer).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('updates progress in place but delivers a final answer as a separate message', async () => {
    const channel = mockChannel('telegram', 'tg:');
    channel.sendProgress = vi.fn().mockResolvedValue(true);
    const router = createMessageRouter([channel]);
    const observer = vi.fn();
    router.addPostHook(observer);
    await router.route({
      chatJid: 'tg:123',
      text: 'Starting',
      triggerType: 'agent-response',
      meta: { kind: 'agent_progress', progressKey: 'turn-1' },
    });
    await router.route({
      chatJid: 'tg:123',
      text: 'Checking',
      triggerType: 'extension',
      meta: { kind: 'host_progress', progressKey: 'turn-1' },
    });
    await router.route({
      chatJid: 'tg:123',
      text: 'Complete',
      triggerType: 'agent-response',
    });
    expect(channel.sendProgress).toHaveBeenNthCalledWith(
      1,
      'tg:123',
      'Starting',
      'turn-1',
    );
    expect(channel.sendProgress).toHaveBeenNthCalledWith(
      2,
      'tg:123',
      'Checking',
      'turn-1',
    );
    expect(channel.sendMessage).toHaveBeenCalledExactlyOnceWith(
      'tg:123',
      'Complete',
    );
    expect(observer).toHaveBeenCalledTimes(3);
  });

  it('keeps routine MacBook job stages in one status and closes it before the job result', async () => {
    const channel = mockChannel('telegram', 'tg:');
    const calls: string[] = [];
    channel.sendProgress = vi.fn().mockImplementation(async (_jid, text, key) => { calls.push(`progress:${key}:${text}`); return true; });
    channel.finishProgress = vi.fn().mockImplementation(async (_jid, key) => { calls.push(`finish:${key}`); });
    channel.sendMessage = vi.fn().mockImplementation(async (_jid, text) => { calls.push(`message:${text}`); });
    const router = createMessageRouter([channel]);
    for (const text of ['Готовлю среду', 'Работаю', 'Проверяю'])
      await router.route({ chatJid: 'tg:123', text, triggerType: 'extension',
        meta: { kind: 'peer_progress', eventId: text, progressKey: 'peer:job-1:1' } });
    await router.route({ chatJid: 'tg:123', text: 'Итог', triggerType: 'extension',
      meta: { kind: 'peer_result', eventId: 'result', progressKey: 'peer:job-1:1', progressFinal: true } });
    expect(calls).toEqual([
      'progress:peer:job-1:1:Готовлю среду',
      'progress:peer:job-1:1:Работаю',
      'progress:peer:job-1:1:Проверяю',
      'finish:peer:job-1:1',
      'message:Итог',
    ]);
  });

  it('does not edit a status for a peer result without the progress kind', async () => {
    const channel = mockChannel('telegram', 'tg:');
    channel.sendProgress = vi.fn().mockResolvedValue(true);
    const router = createMessageRouter([channel]);
    await router.route({ chatJid: 'tg:123', text: 'Задание принято', triggerType: 'extension',
      meta: { kind: 'peer_result', eventId: 'queued', progressKey: 'peer:job-1:1' } });
    expect(channel.sendProgress).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledExactlyOnceWith('tg:123', 'Задание принято');
  });

  it('does not report progress as delivered when its update fails', async () => {
    const channel = mockChannel('telegram', 'tg:');
    channel.sendProgress = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const router = createMessageRouter([channel]);
    const observer = vi.fn();
    router.addPostHook(observer);
    await expect(
      router.route({
        chatJid: 'tg:123',
        text: 'Starting',
        triggerType: 'agent-response',
        meta: { kind: 'agent_progress', progressKey: 'turn-1' },
      }),
    ).rejects.toThrow('ENOTFOUND');
    expect(observer).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps ordinary delivery for channels without editable progress', async () => {
    const channel = mockChannel('whatsapp', 'wa:');
    const router = createMessageRouter([channel]);
    await router.route({
      chatJid: 'wa:123',
      text: 'Working',
      triggerType: 'agent-response',
      meta: { kind: 'agent_progress', progressKey: 'turn-1' },
    });
    expect(channel.sendMessage).toHaveBeenCalledExactlyOnceWith(
      'wa:123',
      'Working',
    );
  });
  it('routes message to correct channel', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    const delivered = await router.route({
      chatJid: 'C123',
      text: 'hello',
      triggerType: 'agent-response',
    });

    expect(delivered).toBe('hello');
    expect(slack.sendMessage).toHaveBeenCalledWith('C123', 'hello');
  });

  it('strips internal tags from text', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    await router.route({
      chatJid: 'C123',
      text: 'visible <internal>hidden</internal> text',
      triggerType: 'agent-response',
    });

    expect(slack.sendMessage).toHaveBeenCalledWith('C123', 'visible  text');
  });

  it('does not deliver empty text after formatting', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    await router.route({
      chatJid: 'C123',
      text: '<internal>only internal</internal>',
      triggerType: 'agent-response',
    });

    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it('send() convenience method works', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    await router.send('C123', 'hello');

    expect(slack.sendMessage).toHaveBeenCalledWith('C123', 'hello');
  });

  it('pre-hook can drop message', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    router.addPreHook(async () => ({
      action: 'drop' as const,
      reason: 'blocked',
    }));

    await router.route({
      chatJid: 'C123',
      text: 'hello',
      triggerType: 'agent-response',
    });

    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it('pre-hook can modify envelope', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    router.addPreHook(async (envelope) => ({
      action: 'modify' as const,
      envelope: { ...envelope, text: envelope.text + ' [modified]' },
    }));

    await router.route({
      chatJid: 'C123',
      text: 'hello',
      triggerType: 'agent-response',
    });

    expect(slack.sendMessage).toHaveBeenCalledWith('C123', 'hello [modified]');
  });

  it('post-hook receives envelope after delivery', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    await router.route({
      chatJid: 'C123',
      text: 'hello',
      triggerType: 'agent-response',
    });

    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'C123', text: 'hello' }),
    );
  });

  // L28: route() must hand the post-hook the text actually DELIVERED (internal
  // tags stripped), not the raw envelope text with <internal>...</internal>.
  it('post-hook records the delivered (stripped) text, not the raw text', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    await router.route({
      chatJid: 'C123',
      text: 'visible <internal>secret</internal> text',
      triggerType: 'ipc',
    });

    // Channel got the stripped text...
    expect(slack.sendMessage).toHaveBeenCalledWith('C123', 'visible  text');
    // ...and so did the observer (no <internal> content leaks into the audit log).
    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'C123', text: 'visible  text' }),
    );
    const recordedText = postHook.mock.calls[0][0].text as string;
    expect(recordedText).not.toContain('secret');
    expect(recordedText).not.toContain('<internal>');
  });

  // L27: an effectively-empty IPC send (all-<internal> / whitespace) must STILL
  // fire the post-hook so the IPC cursor advances on the confirmed no-op
  // delivery; otherwise the runner's turn is re-processed. The text passed to
  // the observer is the delivered (empty) text, not the raw <internal> payload.
  it('fires post-hook for empty-after-format IPC sends (cursor advance) with empty text', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    const delivered = await router.route({
      chatJid: 'C123',
      text: '<internal>only internal</internal>',
      triggerType: 'ipc',
    });

    // No user-visible text was delivered.
    expect(delivered).toBeNull();
    expect(slack.sendMessage).not.toHaveBeenCalled();
    // But the cursor-advance post-hook still ran (records the empty delivered text).
    expect(postHook).toHaveBeenCalledTimes(1);
    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'C123',
        triggerType: 'ipc',
        text: '',
      }),
    );
  });

  // L27 guard: a non-IPC empty-after-format send must remain a pure no-op — no
  // observer fired (avoids recording phantom empty agent-response events).
  it('does not fire post-hook for empty-after-format non-IPC sends', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    const delivered = await router.route({
      chatJid: 'C123',
      text: '<internal>only internal</internal>',
      triggerType: 'agent-response',
    });

    expect(delivered).toBeNull();
    expect(slack.sendMessage).not.toHaveBeenCalled();
    expect(postHook).not.toHaveBeenCalled();
  });

  it('post-hook receives envelope after photo delivery', async () => {
    const slack = {
      ...mockChannel('slack', 'C'),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
    };
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    await router.sendPhoto('C123', '/tmp/photo.jpg', 'caption');

    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'C123',
        text: 'caption',
        triggerType: 'ipc',
        meta: { kind: 'photo', filePath: '/tmp/photo.jpg' },
      }),
    );
  });

  it('preserves host-owned photo metadata for cursor-independent recovery', async () => {
    const slack = {
      ...mockChannel('slack', 'C'),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
    };
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    await router.sendPhoto('C123', '/tmp/photo.jpg', 'caption', {
      suppressCursorAdvance: true,
      meta: { kind: 'image_job_photo', imageJobId: 'img-1' },
    });

    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'C123',
        triggerType: 'ipc',
        meta: {
          kind: 'image_job_photo',
          filePath: '/tmp/photo.jpg',
          imageJobId: 'img-1',
          suppressCursorAdvance: true,
        },
      }),
    );
  });

  it('post-hook receives envelope after voice delivery', async () => {
    const slack = {
      ...mockChannel('slack', 'C'),
      sendVoice: vi.fn().mockResolvedValue(undefined),
    };
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    await router.sendVoice('C123', 'spoken reply');

    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'C123',
        text: 'spoken reply',
        triggerType: 'ipc',
        meta: { kind: 'voice' },
      }),
    );
  });

  it('post-hook receives envelope after document delivery', async () => {
    const slack = {
      ...mockChannel('slack', 'C'),
      sendDocument: vi.fn().mockResolvedValue(undefined),
    };
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    const document=fixtureFile('report.docx');
    await router.sendDocument('C123', document, 'edited');

    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'C123',
        text: 'edited',
        triggerType: 'ipc',
        meta: { kind: 'document', filePath: document },
      }),
    );
  });

  it('host-owned document sends can suppress the IPC cursor advance', async () => {
    const slack = {
      ...mockChannel('slack', 'C'),
      sendDocument: vi.fn().mockResolvedValue(undefined),
    };
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    const document=fixtureFile('report.pdf');
    await router.sendDocument('C123', document, undefined, {
      suppressCursorAdvance: true,
      meta: { kind: 'local_file_document' },
    });

    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'C123',
        triggerType: 'ipc',
        meta: {
          kind: 'local_file_document',
          filePath: document,
          suppressCursorAdvance: true,
        },
      }),
    );
  });

  it('warns when no channel owns the JID', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    let deliveryError: unknown;
    try {
      await router.route({
        chatJid: 'unknown-jid',
        text: 'hello',
        triggerType: 'agent-response',
      });
    } catch (error) {
      deliveryError = error;
    }
    expect(deliveryError).toBeInstanceOf(Error);
    expect((deliveryError as Error).message).toContain(
      'No connected channel for JID',
    );
    expect((deliveryError as Error).message).not.toContain('unknown-jid');

    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it('throws when the owning channel fails delivery', async () => {
    const slack = mockChannel('slack', 'C');
    vi.mocked(slack.sendMessage).mockRejectedValueOnce(
      new Error('send failed'),
    );
    const router = createMessageRouter([slack]);

    await expect(
      router.route({
        chatJid: 'C123',
        text: 'hello',
        triggerType: 'agent-response',
      }),
    ).rejects.toThrow('send failed');
  });
});

describe('MessageRouter: кнопки под сообщением (W25)', () => {
  it('передаёт кнопки каналу; без кнопок вызов канала прежний', async () => {
    const channel = mockChannel('telegram', 'tg:');
    const router = createMessageRouter([channel]);
    const buttons = [[{ text: '⏹ Слежка', callbackData: 'tgtask:s:task-1' }]];
    await router.route({
      chatJid: 'tg:1',
      text: '⏳ Сейчас идёт плановая задача',
      triggerType: 'agent-response',
      buttons,
    });
    expect(channel.sendMessage).toHaveBeenLastCalledWith(
      'tg:1',
      '⏳ Сейчас идёт плановая задача',
      { buttons },
    );
    await router.route({ chatJid: 'tg:1', text: 'обычный ответ', triggerType: 'agent-response', buttons: [] });
    expect((channel.sendMessage as ReturnType<typeof vi.fn>).mock.lastCall).toEqual(['tg:1', 'обычный ответ']);
  });
});
