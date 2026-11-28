import fs from 'node:fs';
import path from 'node:path';
import {atomicWrite,privateDirectory,privateJson,inspectPeerRuntime,acquireFileLock,validateRequest,readMaintenanceGate} from './skoobi-peer-core.mjs';
import {peerExecutableSha256} from './skoobi-peer-runtime.mjs';
import {HistoryReadClient} from './skoobi-peer-history-client.mjs';
import {peerHistoryCapability} from './skoobi-peer-history-policy.mjs';
import {HISTORY_READ_CAPABILITY,PeerHistoryError,validatePeerHistoryScope,historyScopeHash,historyMessage} from './skoobi-peer-history-contract.mjs';

const fail=code=>{throw new PeerHistoryError(code);};
const identifier=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(v);
const second=v=>Number.isSafeInteger(v)&&v>0?v*1000:null;
const milliseconds=v=>Number.isSafeInteger(v)&&v>0?v:null;

/** Works with the pinned local App Server API; no raw rollout/SQLite fallback. */
export async function collectPeerCodexHistory(client,input,{nowMs=Date.now}={}){
  const scope=validatePeerHistoryScope(input,nowMs()),hash=historyScopeHash(scope),methods=new Set(),from=Date.parse(scope.from),to=Date.parse(scope.to);
  let calls=0;
  const request=async(method,params)=>{
    validatePeerHistoryScope(scope,nowMs());
    if(++calls>40)fail('history_page_limit');methods.add(method);
    return client.request(method,params);
  };
  let threadId=scope.selector.threadId;
  if(!threadId){
    const found=new Map();
    // Both archive namespaces are checked so duplicate titles never silently
    // select a different conversation. Only exact matching IDs/names escape.
    for(const archived of [false,true]){
      let cursor=null;const cursors=new Set();
      do{
        const page=await request('thread/list',{searchTerm:scope.selector.exactTitle,limit:50,cursor,archived,useStateDbOnly:true,modelProviders:[],sourceKinds:['cli','vscode','appServer','unknown'],sortKey:'updated_at'});
        if(!Array.isArray(page?.data)||page.data.length>50)fail('history_protocol_invalid');
        for(const t of page.data)if(t?.name===scope.selector.exactTitle&&identifier(t.id))found.set(t.id,{id:t.id,name:t.name});
        cursor=page.nextCursor??null;if(cursor!==null&&(typeof cursor!=='string'||cursor.length>4096||cursors.has(cursor)))fail('history_cursor_invalid');if(cursor)cursors.add(cursor);
      }while(cursor);
    }
    if(found.size===0)fail('history_thread_not_found');
    if(found.size!==1)fail('history_title_ambiguous');
    threadId=[...found.keys()][0];
  }
  const meta=await request('thread/read',{threadId,includeTurns:false});
  if(meta?.thread?.id!==threadId)fail('history_thread_mismatch');
  if(scope.selector.exactTitle&&meta.thread.name!==scope.selector.exactTitle)fail('history_thread_changed');
  const result={schema:1,status:'ok',jobId:scope.jobId,revision:scope.revision,scopeHash:hash,thread:{id:threadId,name:typeof meta.thread.name==='string'?meta.thread.name.slice(0,200):null},from:scope.from,to:scope.to,readAt:new Date(nowMs()).toISOString(),readOnly:true,modelStarted:false,uiUsed:false,untrustedHistory:true,messages:[],complete:true,omittedUnknownTime:0,omittedNonDialogue:0,limitations:[],methods:[]};
  let cursor=null,done=false;const turnCursors=new Set(),seenTurns=new Set(),seenItems=new Set();
  do{
    const page=await request('thread/turns/list',{threadId,limit:50,cursor,sortDirection:'desc',itemsView:'notLoaded'});
    if(!Array.isArray(page?.data)||page.data.length>50)fail('history_protocol_invalid');
    for(const turn of page.data){
      if(!identifier(turn?.id)||seenTurns.has(turn.id))fail('history_turn_identity_invalid');seenTurns.add(turn.id);
      const start=second(turn.startedAt),end=second(turn.completedAt);
      if(start===null){result.omittedUnknownTime++;result.complete=false;continue;}
      if(start>=to||(end!==null&&end<from))continue;
      // An old still-running turn can contain a current item, so do not stop
      // pagination just because one turn started before the requested window.
      let itemCursor=null;const itemCursors=new Set();
      do{
        const items=await request('thread/items/list',{threadId,turnId:turn.id,limit:50,cursor:itemCursor,sortDirection:'asc'});
        if(!Array.isArray(items?.data)||items.data.length>50)fail('history_protocol_invalid');
        for(const entry of items.data){
          if(entry?.turnId!==turn.id)fail('history_item_scope_mismatch');
          const item=historyMessage(entry.item);if(!item){result.omittedNonDialogue++;continue;}
          const key=turn.id+':'+item.id;if(seenItems.has(key))fail('history_item_identity_invalid');seenItems.add(key);
          let at=milliseconds(entry.startedAtMs)??milliseconds(entry.completedAtMs),basis='item';
          if(at===null){if(start>=from&&end!==null&&end<to){at=start;basis='turn_interval';}else{result.omittedUnknownTime++;result.complete=false;continue;}}
          if(at<from||at>=to)continue;
          const message={...item,turnId:turn.id,at:new Date(at).toISOString(),timestampBasis:basis};
          result.messages.push(message);
          if(result.messages.length>500||Buffer.byteLength(JSON.stringify(result))>scope.maxBytes-800){result.messages.pop();result.complete=false;result.limitations.push('output_limit_reached_narrow_the_date_range');done=true;break;}
        }
        if(done)break;
        itemCursor=items.nextCursor??null;if(itemCursor!==null&&(typeof itemCursor!=='string'||itemCursor.length>4096||itemCursors.has(itemCursor)))fail('history_cursor_invalid');if(itemCursor)itemCursors.add(itemCursor);
      }while(itemCursor);
      if(done)break;
    }
    if(done)break;
    cursor=page.nextCursor??null;if(cursor!==null&&(typeof cursor!=='string'||cursor.length>4096||turnCursors.has(cursor)))fail('history_cursor_invalid');if(cursor)turnCursors.add(cursor);
  }while(cursor);
  result.messages.sort((a,b)=>a.at.localeCompare(b.at));result.methods=[...methods];
  if(result.omittedUnknownTime)result.limitations.push('items_without_provable_time_omitted');
  result.limitations.push('dialogue_text_only_attachments_and_tool_outputs_excluded','credential_patterns_redacted');
  validatePeerHistoryScope(scope,nowMs());
  if(Buffer.byteLength(JSON.stringify(result))>scope.maxBytes)fail('history_output_limit');
  return result;
}

/** Called only after the restricted SSH request envelope has been verified. */
export async function executePeerHistoryRead(c,envelope,{runtimeProbe=inspectPeerRuntime,executableHash=peerExecutableSha256,configCurrent=()=>c,clientFactory=options=>new HistoryReadClient(options),nowMs=Date.now}={}){
  validateRequest(c,envelope);
  if(c.role!=='worker'||envelope.method!=='history_read'||envelope.schema!==2)fail('history_authority_invalid');
  const scope=validatePeerHistoryScope(envelope.scope,nowMs());
  if(envelope.id!==scope.jobId)fail('history_job_mismatch');
  const observedRuntime=runtimeProbe(c),capability=peerHistoryCapability(c,observedRuntime);if(!capability.available)fail(capability.reason);
  if(readMaintenanceGate(c.stateRoot).active)fail('history_maintenance');
  const parent=privateDirectory(path.join(c.stateRoot,'history-reads'),true);
  if(!fs.existsSync(path.join(parent,scope.jobId))&&fs.readdirSync(parent).length>=256)fail('history_receipt_capacity');
  const dir=privateDirectory(path.join(parent,scope.jobId),true),release=acquireFileLock(dir,'read',{waitSeconds:0});
  let client;
  try{
    const hash=historyScopeHash(scope),requestFile=path.join(dir,'request.json'),resultFile=path.join(dir,'result.json');
    if(fs.existsSync(requestFile)){if(historyScopeHash(privateJson(requestFile))!==hash)fail('history_job_conflict');}else atomicWrite(requestFile,scope,true);
    if(fs.existsSync(resultFile)){const existing=privateJson(resultFile);if(existing.scopeHash!==hash)fail('history_receipt_invalid');return existing;}
    const manifest=JSON.parse(fs.readFileSync(path.join(c.projectRoot,'runtime/codex-toolchain.json'),'utf8'));
    const executable=fs.realpathSync(path.join(c.projectRoot,manifest.destination,manifest.binary));
    if(executableHash(executable)!==observedRuntime.cliSha256)fail('history_executable_changed');
    client=clientFactory({executable,codexHome:c.codexHistory.codexHome,deadline:Math.min(nowMs()+32000,Date.parse(scope.expiresAt))});
    await client.initialize();
    const result=await collectPeerCodexHistory(client,scope,{nowMs});
    await client.close();client=null;
    validatePeerHistoryScope(scope,nowMs());
    const current=configCurrent();
    if(current.role!==c.role||current.networkId!==c.networkId||current.nodeId!==c.nodeId||current.ownerJid!==c.ownerJid||current.codexHistory?.codexHome!==c.codexHistory.codexHome||!peerHistoryCapability(current,runtimeProbe(current)).available)fail('history_capability_changed');
    atomicWrite(resultFile,result,true);return result;
  }finally{try{await client?.close();}finally{release();}}
}

/** Host-only entrypoint; caller must hold a current verified direct-owner run. */
export async function readPeerCodexHistory(c,input,{transport,nowMs=Date.now}={}){
  const scope=validatePeerHistoryScope(input,nowMs());
  if(c.role!=='coordinator')fail('history_coordinator_required');
  transport??=(await import('./skoobi-peer.mjs')).remoteRpc;
  const start=nowMs();let hello;
  try{hello=await transport(c,'hello',{schema:2},10000);}catch{fail('history_peer_unavailable');}
  if(hello?.protocol!==2||hello.historyRead?.capability!==HISTORY_READ_CAPABILITY||hello.historyRead.available!==true)fail('history_peer_capability_unavailable');
  if(hello.maintenance?.active||!Number.isFinite(Date.parse(hello.heartbeat?.updatedAt))||nowMs()-Date.parse(hello.heartbeat.updatedAt)>30000||Date.parse(hello.heartbeat.updatedAt)>nowMs()+5000)fail('history_peer_not_ready');
  validatePeerHistoryScope(scope,nowMs());
  const remaining=45000-(nowMs()-start);if(remaining<1000)fail('history_timeout');
  let result;try{result=await transport(c,'history_read',{schema:2,id:scope.jobId,scope},remaining);}catch{fail('history_transport_failed');}
  validatePeerHistoryScope(scope,nowMs());
  if(result?.status==='unavailable'&&/^history_[a-z_]+$/.test(result.code||''))fail(result.code);
  if(!result||result.schema!==1||result.status!=='ok'||result.jobId!==scope.jobId||result.revision!==1||result.scopeHash!==historyScopeHash(scope)||result.from!==scope.from||result.to!==scope.to||result.readOnly!==true||result.modelStarted!==false||result.uiUsed!==false||!Array.isArray(result.messages)||Buffer.byteLength(JSON.stringify(result))>scope.maxBytes)fail('history_receipt_invalid');
  if(scope.selector.threadId&&result.thread?.id!==scope.selector.threadId||scope.selector.exactTitle&&result.thread?.name!==scope.selector.exactTitle)fail('history_thread_mismatch');
  for(const message of result.messages){
    const at=Date.parse(message?.at);
    if(!['user','assistant'].includes(message?.role)||typeof message.text!=='string'||!Number.isFinite(at)||at<Date.parse(scope.from)||at>=Date.parse(scope.to)||!['item','turn_interval'].includes(message.timestampBasis))fail('history_receipt_invalid');
  }
  return result;
}
