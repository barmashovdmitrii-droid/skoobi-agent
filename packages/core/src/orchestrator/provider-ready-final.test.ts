import {afterEach, expect, it, vi} from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(['live','reserve-text','reserve-full','live-voice','reverse-full'] as const)(
  'recovers a completed %s answer after loss of transport acknowledgement', async mode => {
    const id = String(731200 + ['live','reserve-text','reserve-full','live-voice','reverse-full'].indexOf(mode));
    const chat = 'tg:' + id;
    const answer = 'В списке три важных пункта.';
    const live = mode.startsWith('live');
    const reverse = mode === 'reverse-full';
    vi.stubEnv('OWNER_TELEGRAM_USER_IDS', id);
    vi.stubEnv('OWNER_TELEGRAM_CHAT_IDS', id);
    vi.stubEnv('SKOOBI_SANDBOX_CODEX_PRIMARY', 'false');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {status:403})));
    vi.resetModules();
    const db = await import('./db.js');
    const loop = await import('./message-loop.js');
    const runtime = await import('../runtimes/sandbox-runner.js');
    const gateway = await import('./live-mode.js');
    const {createMessageRouter} = await import('./outbound-router.js');
    const {createTelegramSenderIdentity,loadOwnerAllowlistFromEnv} = await import('@skoobi/shared/telegram-identity');
    db.initDatabase();
    db.setRegisteredGroup(chat, {name:'Ready provider',folder:'provider-fixture-'+id,
      isMain:true, trigger:'',requiresTrigger:false,runtime:'sandbox',added_at:new Date().toISOString(),agentConfig:{fullAccess:true}});
    loop._loadStateForTest();
    vi.spyOn(gateway, 'loadLiveCanaryConfig').mockReturnValue({enabled:live || reverse,chatId:id,
      telegramOwnerLiveEnabled:live || reverse,claudeFallbackEnabled:true,codexOwnerFullAgentEnabled:reverse,
      codexOwnerFullAgentMode:reverse?'always':'auto',
      codexReserveFallbackEnabled:!live,codexReserveMode:mode==='reserve-full'?'full':'text'});
    const gatewayRun = vi.spyOn(gateway, 'runLiveModelTurn').mockResolvedValue({
      status:'success',answerText:answer,latencyMs:12,traceId:'fixture',sessionId:'fixture'
    } as never);
    let primary = 0, fullReserve = 0;
    vi.spyOn(runtime, 'runSandboxAgent').mockImplementation(async (_group,input,_proc,output) => {
      if (input.provider === 'codex_cli') {
        fullReserve++;
        if (reverse) return {status:'error',result:null,error:'provider unavailable'};
        const result={status:'success' as const,result:answer};
        await output!(result);
        return result;
      }
      primary++;
      if (reverse) {
        const result={status:'success' as const,result:answer};
        await output!(result);
        return result;
      }
      return {status:'error' as const,result:null,error:'provider unavailable'};
    });
    let lost = true;
    const sentText:string[]=[];
    const voice = vi.fn(async () => { throw new Error('lost after audio upload'); });
    const channel = {name:'telegram',ownsJid:(jid:string)=>jid===chat,isConnected:()=>true,
      setTyping:vi.fn(async()=>{}),sendVoice:voice,sendMessage:vi.fn(async (_jid:string,text:string)=>{
        sentText.push(text);
        if (lost && text===answer) throw new Error('lost after send');
      })};
    loop._setChannelsForTest([channel as never]);
    const router = createMessageRouter([channel as never]);
    const identity=createTelegramSenderIdentity({chatId:id,fromId:id,ownerAllowlist:loadOwnerAllowlistFromEnv()});
    const add=(messageId:string,content:string)=>db.storeMessage({id:messageId,content,chat_jid:chat,sender:id,
      sender_name:'Fixture',timestamp:new Date().toISOString(),sender_identity:{...identity,telegram_message_origin:'direct'}});
    add('work',mode==='live-voice'?'Ответь голосом, какие пункты есть в списке?':'Какие пункты есть в списке?');
    await loop.processGroupMessages(chat,router);
    expect(db.getRouterState('ready_text_final:'+JSON.stringify([chat,'provider-fixture-'+id]))).toContain(answer);
    expect(sentText.filter(t=>t===answer)).toHaveLength(mode==='live-voice'?0:1);
    expect(voice).toHaveBeenCalledTimes(mode==='live-voice'?1:0);
    lost=false;
    loop._loadStateForTest();
    await loop.processGroupMessages(chat,router);
    add('request','Пришли готовый ответ');
    await loop.processGroupMessages(chat,router);
    expect(sentText.filter(t=>t===answer)).toHaveLength(mode==='live-voice'?1:2);
    expect(gatewayRun).toHaveBeenCalledTimes(mode==='reserve-full' || reverse?0:1);
    expect(primary).toBe(live?0:1);
    expect(fullReserve).toBe(mode==='reserve-full' || reverse?1:0);
  });
