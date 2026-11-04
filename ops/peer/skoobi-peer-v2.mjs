import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {JobStore,atomicWrite,privateRead,privateJson,privateDirectory,validateInputs,terminalStates,now,sha256,acquireFileLock} from './skoobi-peer-core.mjs';
import {validatePeerContract,contentHash,PEER_CAPABILITIES} from './skoobi-peer-contract.mjs';
import {verifyPeerResult,peerResultDigest,validatePeerReview} from './skoobi-peer-acceptance.mjs';

const MAX_PENDING = 32;
function packet(store,id){return{id,...store.payload(id)};}
function backoff(attempt){return Math.min(300000,5000*2**Math.min(6,attempt));}
function pending(store,id){
  const s=store.state(id);
  return{id,title:s.title,state:terminalStates.has(s.state)?s.state:store.wantsCancel(id)?'cancellation_pending':s.remoteState||'waiting_for_macbook',
    accepted:Boolean(s.remoteAcceptedAt),revision:s.revision,progress:s.progress||null,
    connection:s.connection||'unknown',verification:s.contextInvalidated?'stale':s.assessment?.status||'pending',delivery:s.deliveryState||'pending'};
}

async function allContextCurrent(host,id,payload,store){
  const current=await host.contextCurrent(id,payload);if(!current.valid)return current;
  const directory=path.join(store.dir(id),'context-responses');
  if(!fs.existsSync(directory))return current;
  const files=fs.readdirSync(privateDirectory(directory));if(files.length>6)return{valid:false,reason:'invalid'};
  for(const file of files){
    if(!/^[a-f0-9-]{36}\.json$/.test(file))return{valid:false,reason:'invalid'};
    const extra=privateJson(path.join(directory,file));
    const result=await host.contextCurrent(id,{...payload,context:extra.context});if(!result.valid)return result;
  }
  return{valid:true};
}

async function answerContextRequests(c,id,remote,host,store,transport){
  if(!remote.contextRequests?.length)return;
  if(!Array.isArray(remote.contextRequests)||remote.contextRequests.length>6)throw Error('Peer context request limit');
  const payload=store.payload(id),directory=privateDirectory(path.join(store.dir(id),'context-responses'),true);
  for(const request of remote.contextRequests){
    if(request.state!=='pending')continue;
    if(!/^[a-f0-9-]{36}$/.test(request.requestId||'')||request.revision!==payload.contract.revision||
      typeof request.query!=='string'||!request.query.trim()||request.query.length>1000||typeof request.reason!=='string'||!request.reason.trim()||request.reason.length>1000||
      !Array.isArray(request.recordKeys)||request.recordKeys.length>10||request.recordKeys.some(x=>typeof x!=='string'||x.length>80))throw Error('Invalid peer context request');
    if(!(await allContextCurrent(host,id,payload,store)).valid)throw Error('Task memory changed');
    const file=path.join(directory,request.requestId+'.json');
    if(!fs.existsSync(file)){
      const context=await host.supplementary(id,payload,{query:request.query,recordKeys:request.recordKeys,reason:request.reason});
      if(context.scopeHash!==payload.context.scopeHash||context.scopeRevisionHash!==payload.context.scopeRevisionHash)throw Error('Task memory changed');
      atomicWrite(file,{requestHash:request.requestHash,context},true);
    }
    const saved=privateJson(file);
    if(saved.requestHash!==request.requestHash)throw Error('Context request identity conflict');
    const ack=await transport(c,'context_response',{schema:2,id,requestId:request.requestId,context:saved.context});
    if(ack.requestId!==request.requestId||ack.revision!==payload.contract.revision||ack.accepted!==true||ack.contextSha256!==saved.context.sha256)throw Error('Context reply acknowledgement mismatch');
  }
}

/** Host-only adapter. The peer cannot choose a tenant, chat, DB, or signing key. */
export async function peerHostAdapters(c,id,payload){
  if(!path.isAbsolute(c.bridgeConfigPath||''))throw Error('Peer bridge host configuration is required');
  const base=path.join(c.projectRoot,'packages/core/dist/orchestrator');
  const inbox=await import(pathToFileURL(path.join(base,'peer-inbox.js')));
  const memory=await import(pathToFileURL(path.join(base,'peer-bridge-context.js')));
  const config=inbox.loadPeerBridgeConfig(c.bridgeConfigPath);
  if(config.ownerJid!==c.ownerJid||config.ownerGroupFolder!==c.ownerGroupFolder||config.networkId!==c.networkId||config.projectRoot!==c.projectRoot)throw Error('Peer bridge authority mismatch');
  if(id){
    payload=payload||new JobStore(c.stateRoot).payload(id);
    const factoryModule=path.join(base,'game-factory-peer-adapter.js');
    if(fs.existsSync(factoryModule)){
      const factory=await import(pathToFileURL(factoryModule));
      const host=factory.createGameFactoryPeerHostAdapter(config,id,payload);
      if(host)return host;
    }else if(String(payload.contract?.parentTaskId||'').startsWith('factory:'))throw Error('Factory peer adapter unavailable');
  }
  const request=(id,payload,extra={})=>({taskId:id,revision:payload.contract.revision,projectKey:payload.contract.projectKey,
    query:(payload.contract.goal+'\n'+payload.prompt).slice(0,16000),expiresAt:payload.contract.execution.expiresAt,...extra});
  return{
    config,
    context:(id,payload)=>memory.buildPeerContextForCoordinator(c.bridgeConfigPath,request(id,payload)),
    contextCurrent:async(id,payload)=>memory.revalidatePeerContextForCoordinator(c.bridgeConfigPath,payload.context),
    supplementary:(id,payload,extra)=>memory.buildPeerContextForCoordinator(c.bridgeConfigPath,request(id,payload,extra)),
    publish:event=>inbox.writePeerInboxEvent(config,event),
  };
}

function validRemote(id,remote){
  if(!remote||remote.id!==id||!['queued','running',...terminalStates].includes(remote.state))throw Error('Invalid peer state');
  if(remote.schema!==2||!Number.isSafeInteger(remote.revision)||remote.revision<1)throw Error('Peer contract receipt missing');
  return remote;
}

function bindRemoteReceipt(store,id,remote,payload){
  const expected=store.packet({id,...payload});
  if(remote.revision!==payload.contract.revision||remote.inputHash!==expected.inputHash||remote.contextSha256!==payload.context.sha256)
    throw Error('Peer receipt does not match the retained task');
}

async function compatible(c,transport,contract){
  const h=await transport(c,'hello');
  if(h.protocol!==2||!Array.isArray(h.capabilities)||PEER_CAPABILITIES.some(x=>!h.capabilities.includes(x))){
    const e=Error('Peer upgrade or compatible runtime required');e.code='PEER_INCOMPATIBLE';throw e;
  }
  if(h.model!==contract.runtime.model||h.effort!==contract.runtime.reasoningEffort){
    const e=Error('Peer model profile differs from the task');e.code='PEER_INCOMPATIBLE';throw e;
  }
  const runtime=c.expectedPeerRuntime||{cliVersion:'0.166.0'};
  if(h.runtime?.cliVerified!==true||h.runtime.cliVersion!==runtime.cliVersion||
    (runtime.cliSha256&&h.runtime.cliSha256!==runtime.cliSha256)||(runtime.bridgeSha256&&h.runtime.bridgeSha256!==runtime.bridgeSha256)||
    !h.executionModes?.includes(contract.execution.mode)){
    const e=Error('Actual peer runtime or execution mode is unverified');e.code='PEER_INCOMPATIBLE';throw e;
  }
  const age=Date.now()-Date.parse(h.heartbeat?.updatedAt||'');
  if(!Number.isFinite(age)||age< -30000||age>30000||h.maintenance?.active||h.heartbeat?.maintenance?.active){
    const e=Error('Peer worker is stale or undergoing maintenance');e.code='PEER_NOT_READY';throw e;
  }
  return h;
}

export async function preparePeerV2(c,options,adapters,reservedId){
  const contract=validatePeerContract(options.contract);
  if(contract.revision!==1)throw Error('A new task starts at revision one');
  if(typeof options.prompt!=='string'||!options.prompt.trim()||Buffer.byteLength(options.prompt)>128*1024||typeof options.title!=='string'||!options.title.trim()||options.title.length>200)throw Error('Invalid task description');
  const store=new JobStore(c.stateRoot);
  if(reservedId&&fs.existsSync(store.dir(reservedId))){
    const existing=store.payload(reservedId);
    if(contentHash(existing.contract)!==contentHash(contract)||existing.prompt!==options.prompt||existing.title!==options.title||
      existing.notify!==(options.notify!==false)||contentHash(existing.inputs)!==contentHash(validateInputs(options.inputs)))throw Error('Reserved task identity conflict');
    return pending(store,reservedId);
  }
  if(store.list().filter(s=>!terminalStates.has(s.state)).length>=MAX_PENDING)throw Error('Peer queue capacity exceeded');
  if(fs.existsSync(path.join(c.stateRoot,'maintenance.json')))throw Error('Peer maintenance: new tasks are paused');
  const id=reservedId||crypto.randomUUID();
  const payload={schema:2,prompt:options.prompt,title:options.title,notify:options.notify!==false,inputs:validateInputs(options.inputs),contract};
  const host=adapters||await peerHostAdapters(c,id,payload);
  payload.context=await host.context(id,payload);
  store.submit({id,...payload});
  // Durable preparation only: the existing coordinator watcher owns transport.
  return pending(store,id);
}


export async function submitPeerV2(c,options,transport,adapters,reservedId){
  const prepared=await preparePeerV2(c,options,adapters,reservedId);
  try{await reconcilePeerV2(c,prepared.id,transport,adapters);}catch{}
  return pending(new JobStore(c.stateRoot),prepared.id);
}

async function transferArtifacts(c,id,remote,transport,store){
  const result=[],directory=privateDirectory(path.join(store.dir(id),'artifacts'),true);
  if(!Array.isArray(remote.artifacts)||remote.artifacts.length>20)throw Error('Artifact manifest limit');
  let total=0;
  for(const a of remote.artifacts){
    if(!/^[a-f0-9]{64}(?:\.[A-Za-z0-9.]{1,15})?$/.test(a.name||'')||!/^[a-f0-9]{64}$/.test(a.sha256||'')||
        !Number.isSafeInteger(a.bytes)||a.bytes<0||a.bytes>64*1024*1024||!['photo','document'].includes(a.kind))throw Error('Artifact manifest invalid');
    total+=a.bytes;if(total>store.payload(id).contract.execution.maxOutputBytes)throw Error('Artifact total limit');
    const target=path.join(directory,a.name);
    if(!fs.existsSync(target)){
      const chunks=[];let offset=0;
      do{
        const response=await transport(c,'artifact',{schema:2,id,name:a.name,offset});
        if(response.offset!==offset||response.sha256!==a.sha256||response.bytes!==a.bytes||typeof response.data!=='string'||response.data.length>750000)throw Error('Artifact chunk changed');
        const bytes=Buffer.from(response.data,'base64');
        if(bytes.toString('base64')!==response.data||(!bytes.length&&offset<a.bytes)||offset+bytes.length>a.bytes)throw Error('Artifact chunk invalid');
        chunks.push(bytes);offset+=bytes.length;
      }while(offset<a.bytes);
      const bytes=Buffer.concat(chunks);if(sha256(bytes)!==a.sha256)throw Error('Artifact checksum mismatch');
      atomicWrite(target,bytes,true);
    }
    const bytes=privateRead(target,64*1024*1024);
    if(bytes.length!==a.bytes||sha256(bytes)!==a.sha256)throw Error('Artifact changed locally');
    result.push({...a,localPath:target});
  }
  return result;
}

function eventArtifacts(host,id,artifacts){
  const parent=privateDirectory(path.join(host.config.root,'artifacts'),true),directory=privateDirectory(path.join(parent,id),true);
  const seen=new Map();
  for(const a of artifacts){
    if(seen.has(a.name)){
      if(seen.get(a.name).sha256!==a.sha256||seen.get(a.name).bytes!==a.bytes)throw Error('Ambiguous artifact identity');
    }else seen.set(a.name,a);
  }
  return [...seen.values()].map(a=>{
    const filename=path.join(directory,a.name),bytes=privateRead(a.localPath,64*1024*1024);
    if(sha256(bytes)!==a.sha256||bytes.length!==a.bytes)throw Error('Artifact changed before inbox');
    if(!fs.existsSync(filename))atomicWrite(filename,bytes,true);
    if(sha256(privateRead(filename,64*1024*1024))!==a.sha256)throw Error('Inbox artifact changed');
    return{name:a.name,path:filename,sha256:a.sha256,bytes:a.bytes,kind:a.kind};
  });
}

async function publishDurableEvent(id,host,store,event){
  const directory=privateDirectory(path.join(store.dir(id),'events'),true),file=path.join(directory,event.eventId+'.json');
  if(!fs.existsSync(file))atomicWrite(file,event,true);
  const retained=privateJson(file);
  if(retained.jobId!==id||retained.eventId!==event.eventId||retained.resultHash!==event.resultHash||retained.revision!==event.revision)
    throw Error('Result event identity conflict');
  // Retry precisely the same bytes, including timestamps, after an ambiguous ACK.
  await host.publish(retained);
}

async function publishProgress(id,host,store,stage,connection='online'){
  stage=['tool_started','tool_finished','working','model_event'].includes(stage)?'running':stage;
  const s=store.state(id),payload=store.payload(id);
  const key=contentHash([payload.contract.revision,stage,connection]);
  if(s.lastProgressEventKey===key)return;
  const sequence=s.progressIntent?.key===key?s.progressIntent.sequence:(s.progressSequence||0)+1;
  if(sequence>200)return;
  const identity=contentHash([key,sequence]);
  if(s.progressIntent?.key!==key)store.update(id,{progressSequence:sequence,progressIntent:{key,sequence}});
  const names={queued:'Задание принято и ожидает выполнения.',starting:'Исполнитель готовит рабочую среду.',running:'Исполнитель работает над заданием.',
    executing:'Исполнитель работает над заданием.',transferring:'Работа завершилась, передаю файлы на Mac mini.',verifying:'Проверяю полученный результат.',
    waiting_context:'Исполнитель запросил дополнительные сведения для задания.',unavailable:'Связь с MacBook недоступна. Состояние задания сохранено; повторное выполнение не запускаю.',
    incompatible:'Версия или профиль исполнителя несовместимы с заданием.',blocked:'Задание ожидает доступности нужного ресурса.'};
  const summary=names[connection==='online'?stage:connection]||'Состояние задания обновлено.';
  const event={schema:1,eventId:'peer-'+id+'-progress-'+identity.slice(0,24),eventKind:'progress',jobId:id,revision:payload.contract.revision,
    parentTaskId:payload.contract.parentTaskId,projectKey:payload.contract.projectKey,receivedAt:now(),resultReceivedAt:now(),
    resultState:stage,resultHash:identity,contextHash:payload.context.sha256,contextValidity:{scopeRevisionHash:payload.context.scopeRevisionHash,expiresAt:payload.context.expiresAt},
    source:payload.contract.source,notify:payload.notify,title:payload.title,
    verification:{status:'inconclusive',summary:'Результат ещё не принят.'},summary,artifacts:[]};
  await publishDurableEvent(id,host,store,event);store.update(id,{lastProgressEventKey:key,lastProgressEventAt:now(),progressIntent:null});
}

async function publishResult(c,id,host,store){
  const s=store.state(id),payload=store.payload(id),assessment=s.assessment,remote=s.remoteResult;
  if(!assessment||!remote)return;
  const review=s.review;
  const eventKind=review?'review':'result';
  const status=review?.decision==='accept'?'passed':review?.decision==='request_changes'?'failed':assessment.status;
  const eventId='peer-'+id+'-r'+payload.contract.revision+'-'+contentHash([assessment,review||null]).slice(0,24);
  if(s.resultEventId===eventId)return;
  const artifacts=eventArtifacts(host,id,s.localArtifacts||[]);
  const text=(remote.deliveries||[]).map(x=>x.text||'').join('\n\n');
  const summary=(text||remote.result?.summary||'Исполнитель не вернул итоговый текст.').slice(0,7500);
  const workerReport={authority:'worker_claims_only',checks:[],changedObjects:[],limitations:[],memoryProposals:[]};
  for(const field of ['checks','changedObjects','limitations','memoryProposals']){
    for(const item of (Array.isArray(remote.result?.[field])?remote.result[field]:[]).slice(0,30)){
      const next={...workerReport,[field]:[...workerReport[field],item]};
      if(Buffer.byteLength(JSON.stringify(next))>20000)break;
      if(field==='memoryProposals'&&Buffer.byteLength(JSON.stringify(next.memoryProposals))>16000)break;
      workerReport[field].push(item);
    }
  }
  const event={schema:1,eventId,eventKind,jobId:id,revision:payload.contract.revision,
    parentTaskId:payload.contract.parentTaskId,projectKey:payload.contract.projectKey,receivedAt:now(),
    resultReceivedAt:s.resultReceivedAt||now(),resultState:remote.state,resultHash:assessment.resultHash,
    verification:{status,summary:review?review.note.slice(0,1800):assessment.summary,
      assurance:review?'coordinator_judgment':'declared_criteria_only',mechanicalStatus:assessment.status},summary,
    artifacts,contextHash:payload.context.sha256,contextValidity:{scopeRevisionHash:payload.context.scopeRevisionHash,expiresAt:payload.context.expiresAt},
    source:payload.contract.source,workerReport,notify:payload.notify,title:payload.title};
  await publishDurableEvent(id,host,store,event);
  store.update(id,{resultEventId:eventId,resultPublishedAt:now(),pendingResultPublication:false,deliveryState:payload.notify?'pending':'suppressed'});
}

async function publishLocalConclusion(id,host,store){
  const s=store.state(id),payload=store.payload(id),conclusion=s.localConclusion;
  if(!conclusion)return;
  const eventId='peer-'+id+'-local-'+s.assessment.resultHash.slice(0,24);
  if(s.resultEventId===eventId)return;
  await publishDurableEvent(id,host,store,{schema:1,eventId,eventKind:'result',jobId:id,revision:payload.contract.revision,
    parentTaskId:payload.contract.parentTaskId,projectKey:payload.contract.projectKey,receivedAt:conclusion.at,resultReceivedAt:conclusion.at,
    resultState:s.state,resultHash:s.assessment.resultHash,contextHash:payload.context.sha256,coordinatorNotice:conclusion.reason,
    contextValidity:{scopeRevisionHash:payload.context.scopeRevisionHash,expiresAt:payload.context.expiresAt},
    source:payload.contract.source,notify:payload.notify,title:payload.title,summary:conclusion.summary,
    verification:{status:'inconclusive',summary:'Задание не передавалось исполнителю; результата выполнения нет.'},artifacts:[]});
  store.update(id,{resultEventId:eventId,resultPublishedAt:now(),deliveryState:payload.notify?'pending':'suppressed'});
}

async function finishUndispatched(id,host,store,reason){
  const s=store.state(id),cancelled=reason==='cancelled_before_submit';
  const summary=cancelled?'Задание отменено до передачи на MacBook.':
    'Задание не передано на MacBook: срок действия или сведения для выполнения изменились. Нужна актуальная постановка.';
  store.update(id,{state:cancelled?'cancelled':'needs_review',finishedAt:now(),error:reason,cancellationConfirmed:cancelled,
    localConclusion:{reason,summary,at:now()},assessment:{status:'inconclusive',summary,resultHash:contentHash([id,s.revision,reason]),checks:[{id:'dispatch',status:'inconclusive',code:reason}]}});
  await publishLocalConclusion(id,host,store);
  return inspectPeerV2({stateRoot:store.root},id);
}

export function inspectPeerV2(c,id){
  const store=new JobStore(c.stateRoot),s=store.state(id);
  return{...pending(store,id),executionState:s.state,remoteState:s.remoteState||null,
    parentTaskId:s.parentTaskId,createdAt:s.createdAt,finishedAt:s.finishedAt||null,
    revisionStatus:s.revisionStatus||null,pendingRevision:s.pendingRevision||null,
    assessment:s.assessment||null,review:s.review||null,contextInvalidated:s.contextInvalidated||null,
    lastConnectionErrorAt:s.lastConnectionErrorAt||null,nextAttemptAt:s.nextAttemptAt||null};
}

export function syncPeerDeliveryReceipt(c,id,host){
  const store=new JobStore(c.stateRoot),s=store.state(id);if(!s.resultEventId)return;
  const file=path.join(host.config.root,'receipts',s.resultEventId+'.json');
  if(!fs.existsSync(file))return;
  const receipt=privateJson(file);
  if(receipt.eventId!==s.resultEventId)throw Error('Delivery receipt mismatch');
  // The main service owns this receipt. No channel acknowledgement is inferred here.
  if(receipt.jobId!==id||receipt.revision!==s.revision||receipt.resultHash!==s.assessment?.resultHash)throw Error('Delivery receipt binding mismatch');
  store.update(id,{deliveryReceipt:receipt,deliveryState:receipt.delivery||'unknown'});
}

async function acknowledgeResult(c,id,host,store,transport){
  const s=store.state(id),payload=store.payload(id),receipt=s.deliveryReceipt,hash=s.remoteResult?.resultSha256;
  if(s.remoteResultAcknowledged||!receipt?.received||receipt.contextState!=='current'||s.contextInvalidated||!/^[a-f0-9]{64}$/.test(hash||'')||
    !(s.review?s.review.decision==='accept':s.assessment?.status==='passed'))return;
  if(!(await allContextCurrent(host,id,payload,store)).valid)return;
  const disposition=receipt.delivery==='complete'?'delivered':!payload.notify&&receipt.delivery==='disabled'?'archived':null;
  if(!disposition)return;
  // Main inbox acknowledgement and retained checked files precede remote retention eligibility.
  for(const artifact of s.localArtifacts||[]){if(sha256(privateRead(artifact.localPath,64*1024*1024))!==artifact.sha256)throw Error('Retained result changed');}
  const ack=await transport(c,'ack_result',{schema:2,id,revision:s.remoteResult.revision,resultSha256:hash,disposition});
  if(ack.revision!==s.remoteResult.revision||ack.resultSha256!==hash||!['delivered','archived'].includes(ack.disposition))throw Error('Result acknowledgement mismatch');
  store.update(id,{remoteResultAcknowledged:ack});
}

export async function reconcilePeerV2(c,id,transport,adapters){
  const store=new JobStore(c.stateRoot),release=acquireFileLock(store.dir(id),'coordinator');
  const rawTransport=transport;
  transport=async(...args)=>{try{return await rawTransport(...args);}catch(error){error.code||='PEER_TRANSPORT_UNAVAILABLE';throw error;}};
  let host;
  try{
    host=adapters||await peerHostAdapters(c,id);let local=store.state(id),payload=store.payload(id);
    if(local.schema!==2)throw Error('Use the legacy inspection path');
    if(terminalStates.has(local.state)){
      const current=await allContextCurrent(host,id,payload,store);
      if(!current.valid)store.update(id,{contextInvalidated:current.reason||'changed'});
      if(local.localConclusion)await publishLocalConclusion(id,host,store);
      else if(local.assessment)await publishResult(c,id,host,store);
      syncPeerDeliveryReceipt(c,id,host);await acknowledgeResult(c,id,host,store,transport);return inspectPeerV2(c,id);
    }
    let current=await allContextCurrent(host,id,payload,store);
    const expired=Date.parse(payload.contract.execution.expiresAt)<=Date.now();
    if(store.wantsCancel(id)&&!local.remoteSubmitAttemptedAt)return await finishUndispatched(id,host,store,'cancelled_before_submit');
    if(!current.valid||expired){
      store.update(id,{contextInvalidated:current.reason||'expired'});
      if(!local.remoteSubmitAttemptedAt){
        return await finishUndispatched(id,host,store,'context_or_task_expired_before_submit');
      }
      try{await transport(c,'revoke_context',{schema:2,id,sha256:payload.context.sha256,reason:current.reason==='expired'?'context_expired':'context_changed'});}catch{}
    }
    let remote;
    if(store.wantsCancel(id)){
      remote=validRemote(id,await transport(c,'cancel',{schema:2,id}));
    }else if(!local.remoteAcceptedAt&&!fs.existsSync(path.join(store.dir(id),'outbound-revision.json'))){
      if(local.contextInvalidated||!current.valid||expired){
        remote=validRemote(id,await transport(c,'inspect',{schema:2,id}));
      }else{
        const hello=await compatible(c,transport,payload.contract);
        store.update(id,{remoteSubmitAttemptedAt:local.remoteSubmitAttemptedAt||now(),peerRuntime:hello.runtime||null});
        remote=validRemote(id,await transport(c,'submit',{schema:2,...packet(store,id)},60000));
        bindRemoteReceipt(store,id,remote,payload);
        store.update(id,{remoteAcceptedAt:now()});
      }
    }else{
      const revisionFile=path.join(store.dir(id),'outbound-revision.json');
      if(fs.existsSync(revisionFile)){
        const next=privateJson(revisionFile);
        remote=validRemote(id,await transport(c,'inspect',{schema:2,id}));
        if(terminalStates.has(remote.state)){
          store.update(id,{revisionStatus:'not_applied_completion_won',requestedRevision:next.contract.revision});
        }else remote=validRemote(id,await transport(c,'revise',{schema:2,id,...next}));
        if(remote.revision===next.contract.revision){
          bindRemoteReceipt(store,id,remote,next);
          store.revise({id,...next});payload=store.payload(id);
          fs.unlinkSync(revisionFile);
          current=await allContextCurrent(host,id,payload,store);
          store.update(id,{revisionStatus:'accepted',revisionAcceptedAt:now(),pendingRevision:null,
            contextInvalidated:current.valid?null:current.reason||'changed'});
          if(!current.valid)try{await transport(c,'revoke_context',{schema:2,id,sha256:payload.context.sha256,reason:'context_changed'});}catch{}
        }else if(remote.pendingRevision===next.contract.revision){
          if(remote.pendingRevisionHash!==store.packet({id,...next}).inputHash)throw Error('Pending revision identity mismatch');
          store.update(id,{pendingRevision:remote.pendingRevision,revisionStatus:'interruption_required'});
        }else if(!terminalStates.has(remote.state))throw Error('Revision acknowledgement mismatch');
      }else remote=validRemote(id,await transport(c,'inspect',{schema:2,id}));
    }
    // A cancellation may be recorded while the network operation was pending.
    if(store.wantsCancel(id)&&!terminalStates.has(remote.state))remote=validRemote(id,await transport(c,'cancel',{schema:2,id}));
    bindRemoteReceipt(store,id,remote,payload);
    store.update(id,{connection:'online',connectionFailures:0,nextAttemptAt:null,remoteState:remote.state,
      remoteAcceptedAt:store.state(id).remoteAcceptedAt||now(),lastRemoteAt:now(),progress:remote.progress||null,
      lastProgressAt:remote.progress?.lastActivityAt||remote.lastProgressAt||null});
    if(!terminalStates.has(remote.state)){
      if(current.valid&&!store.wantsCancel(id))await answerContextRequests(c,id,remote,host,store,transport);
      await publishProgress(id,host,store,remote.progress?.stage||remote.state);
      return pending(store,id);
    }
    store.update(id,{remoteResult:remote,resultReceivedAt:local.resultReceivedAt||now(),progress:{stage:'transferring',lastActivityAt:now(),nextStep:'verify_result'}});
    await publishProgress(id,host,store,'transferring');
    const artifacts=await transferArtifacts(c,id,remote,transport,store);
    store.update(id,{localArtifacts:artifacts,progress:{stage:'verifying',lastActivityAt:now(),nextStep:'publish_result'}});
    await publishProgress(id,host,store,'verifying');
    const context=await allContextCurrent(host,id,payload,store);
    const assessment=await verifyPeerResult(c,payload,remote,artifacts,{contextCurrent:context.valid&&!store.state(id).contextInvalidated,
      cancelled:store.wantsCancel(id),jobDirectory:store.dir(id),...(host.recheck?{recheck:host.recheck}:{})});
    if((store.state(id).requestedRevision||payload.contract.revision)>payload.contract.revision){
      assessment.status='inconclusive';assessment.checks.push({id:'current_requirements',status:'inconclusive',code:'new_revision_not_applied'});
    }
    if(!(await allContextCurrent(host,id,payload,store)).valid){assessment.status='inconclusive';assessment.checks.push({id:'context_after_checks',status:'inconclusive',code:'context_stale'});}
    if(assessment.status==='inconclusive')assessment.summary='Для части требований нужна дополнительная проверка.';
    store.update(id,{assessment,remoteResult:remote,localArtifacts:artifacts,state:remote.state,finishedAt:remote.finishedAt||now(),
      cancellationConfirmed:remote.state==='cancelled'&&remote.cancellationConfirmed===true,
      progress:{stage:'review',lastActivityAt:now(),nextStep:assessment.status==='passed'?'delivery':'coordinator_review'}});
    await publishResult(c,id,host,store);syncPeerDeliveryReceipt(c,id,host);await acknowledgeResult(c,id,host,store,transport);
    return inspectPeerV2(c,id);
  }catch(error){
    const s=store.state(id),failures=(s.connectionFailures||0)+1;
    const remoteFailure=['PEER_INCOMPATIBLE','PEER_TRANSPORT_UNAVAILABLE','PEER_NOT_READY'].includes(error.code);
    store.update(id,{connection:error.code==='PEER_INCOMPATIBLE'?'incompatible':remoteFailure?'unavailable':s.connection||'unknown',connectionFailures:failures,
      coordinatorError:remoteFailure?null:'local_handoff_or_check_failed',
      lastConnectionErrorAt:now(),nextAttemptAt:new Date(Date.now()+backoff(failures)).toISOString()});
    if(host&&remoteFailure&&!terminalStates.has(s.state))try{await publishProgress(id,host,store,s.progress?.stage||'queued',error.code==='PEER_INCOMPATIBLE'?'incompatible':'unavailable');}catch{}
    throw error;
  }finally{release();}
}

export async function revisePeerV2(c,id,options,transport,adapters){
  const store=new JobStore(c.stateRoot),release=acquireFileLock(store.dir(id),'coordinator');
  try{
    const s=store.state(id),old=store.payload(id),contract=validatePeerContract(options.contract);
    if(s.schema!==2||terminalStates.has(s.state)||store.wantsCancel(id))throw Error('Task cannot accept a revision');
    if(contract.revision===s.revision&&contentHash(contract)===contentHash(old.contract)&&
      (!options.prompt||options.prompt===old.prompt)&&(!options.title||options.title===old.title)&&
      (!options.inputs||contentHash(validateInputs(options.inputs))===contentHash(old.inputs)))return inspectPeerV2(c,id);
    if(contract.revision!==s.revision+1||contract.parentTaskId!==old.contract.parentTaskId||contract.projectKey!==old.contract.projectKey)throw Error('Invalid revision lineage');
    const host=adapters||await peerHostAdapters(c,id,{...old,contract});
    const next={schema:2,prompt:options.prompt||old.prompt,title:options.title||old.title,notify:old.notify,
      inputs:options.inputs?validateInputs(options.inputs):old.inputs,contract};
    const file=path.join(store.dir(id),'outbound-revision.json');
    if(fs.existsSync(file)){
      const retained=privateJson(file),{context:retainedContext,...intent}=retained;
      if(contentHash(intent)!==contentHash(next))throw Error('A different revision is awaiting acknowledgement');
      next.context=retainedContext;
    }else{
      next.context=await host.context(id,next);atomicWrite(file,next,true);
    }
    if(!s.remoteSubmitAttemptedAt){store.revise({id,...next});fs.unlinkSync(file);}
    else store.update(id,{revisionStatus:'pending',requestedRevision:contract.revision});
  }finally{release();}
  try{return await reconcilePeerV2(c,id,transport,adapters);}catch{return inspectPeerV2(c,id);}
}

export async function reviewPeerV2(c,id,options,adapters){
  const store=new JobStore(c.stateRoot),release=acquireFileLock(store.dir(id),'coordinator');
  try{
    const s=store.state(id),payload=store.payload(id),host=adapters||await peerHostAdapters(c,id,payload);
    if(!s.assessment||!s.remoteResult||store.wantsCancel(id))throw Error('No current reviewable result');
    const review=validatePeerReview({assessment:s.assessment,payload,remote:s.remoteResult,artifacts:s.localArtifacts||[],
      ...options,contextCurrent:(await allContextCurrent(host,id,payload,store)).valid&&!s.contextInvalidated});
    if(s.review){
      if(s.review.decision===review.decision&&s.review.resultHash===review.resultHash&&s.review.note===review.note){await publishResult(c,id,host,store);return inspectPeerV2(c,id);}
      throw Error('This result already has a recorded review; use a new revision for changes');
    }
    store.update(id,{review,pendingResultPublication:true});await publishResult(c,id,host,store);return inspectPeerV2(c,id);
  }finally{release();}
}

export async function reworkPeerV2(c,id,options,transport,adapters){
  const store=new JobStore(c.stateRoot),release=acquireFileLock(store.dir(id),'coordinator');
  try{
  const old=store.state(id),previous=store.payload(id);
  if(old.schema!==2||!terminalStates.has(old.state)||old.state==='cancelled'||!old.assessment)throw Error('A completed assessed task is required');
  if(old.contextInvalidated||store.wantsCancel(id))throw Error('Cancelled or stale tasks cannot be restarted by rework');
  const contract=validatePeerContract(options.contract),count=(previous.contract.rework||0)+1;
  if(count>2||contract.rework!==count||contract.supersedesJobId!==id||contract.parentTaskId!==previous.contract.parentTaskId||contract.projectKey!==previous.contract.projectKey||
    Date.parse(contract.execution.expiresAt)>Date.parse(previous.contract.execution.expiresAt))throw Error('Rework lineage or deadline invalid');
  if(previous.contract.execution.mode==='gui')throw Error('GUI side effects require a new explicitly scoped task, not automatic rework');
  const intentFile=path.join(store.dir(id),'successor.json'),requestHash=contentHash(options);
  if(!fs.existsSync(intentFile)){
    if(store.list().some(s=>s.schema===2&&store.payload(s.id).contract.supersedesJobId===id))throw Error('Rework already exists; inspect it instead');
    atomicWrite(intentFile,{id:crypto.randomUUID(),requestHash,createdAt:now()},true);
  }
  const intent=privateJson(intentFile);
  if(intent.requestHash!==requestHash)throw Error('A different rework is already recorded');
  const result=await submitPeerV2(c,options,transport,adapters,intent.id);
  store.update(id,{successorJobId:intent.id});return result;
  }finally{release();}
}

export async function watchPeerV2(c,transport,shouldStop=()=>false,adapters){
  const store=new JobStore(c.stateRoot);
  for(const s of store.list()){
    if(shouldStop())break;
    if(s.schema!==2)continue;
    let host;try{host=adapters||await peerHostAdapters(c,s.id);}catch{continue;}
    if(terminalStates.has(s.state)){
      try{if(s.assessment&&(!s.resultEventId||!s.remoteResultAcknowledged||s.pendingResultPublication))await reconcilePeerV2(c,s.id,transport,host);else syncPeerDeliveryReceipt(c,s.id,host);}catch{}
      continue;
    }
    if(!store.wantsCancel(s.id)&&s.nextAttemptAt&&Date.parse(s.nextAttemptAt)>Date.now())continue;
    try{await reconcilePeerV2(c,s.id,transport,host);}catch{}
  }
}
