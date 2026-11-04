import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {JobStore,atomicWrite,privateDirectory,privateRead,privateJson,loadConfig,validateRequest,validateSnapshot,validateInputs,sha256,terminalStates,now,MAX_RPC_BYTES,acquireProcessLock,acquireFileLock} from './skoobi-peer-core.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function portableOwnerInstructions(text,networkId){
  if(!/^[a-f0-9]{24}$/.test(networkId))throw Error('Invalid coordinator context identity');
  const start='<!-- skoobi-peer-routing:'+networkId+' -->',end='<!-- /skoobi-peer-routing:'+networkId+' -->';
  const at=text.indexOf(start);if(at<0)return text;
  const finish=text.indexOf(end,at+start.length);if(finish<0||text.indexOf(start,at+start.length)>=0)throw Error('Ambiguous coordinator-only instruction block');
  let after=finish+end.length;if(text.slice(after,after+2)==='\n\n')after+=2;return text.slice(0,at)+text.slice(after);
}
function ownerRead(file,max=4*1024*1024){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||s.nlink!==1||s.size>max)throw Error('Unsafe owner context file');const data=fs.readFileSync(fd),after=fs.fstatSync(fd);if(s.size!==after.size||s.mtimeMs!==after.mtimeMs||s.ino!==after.ino)throw Error('Owner context changed during snapshot; retry');return data;}finally{fs.closeSync(fd);}
}
export function ownerSnapshot(c){
  const require=createRequire(path.join(c.projectRoot,'package.json')),Database=require('better-sqlite3');
  const db=new Database(path.join(c.projectRoot,'store/messages.db'),{readonly:true,fileMustExist:true});let row;
  try{row=db.prepare('SELECT jid,folder,is_main,agent_config FROM registered_groups WHERE folder=?').get(c.ownerGroupFolder);}finally{db.close();}
  if(!row||row.jid!==c.ownerJid||row.is_main!==1)throw Error('Coordinator owner profile changed');
  const root=path.join(c.projectRoot,'groups',c.ownerGroupFolder);if(fs.realpathSync(root)!==root)throw Error('Unsafe owner memory root');
  const files=[];const add=relative=>{let data=ownerRead(path.join(root,relative));if(relative==='CLAUDE.md')data=Buffer.from(portableOwnerInstructions(data.toString('utf8'),c.networkId));files.push({path:relative,sha256:sha256(data),data:data.toString('base64')});};
  for(const name of ['CLAUDE.md','AGENTS.md'])if(fs.existsSync(path.join(root,name)))add(name);
  function walk(relative,depth=0){if(depth>8)throw Error('Owner memory nesting exceeds limit');const full=path.join(root,relative);for(const f of fs.readdirSync(full,{withFileTypes:true})){if(f.isSymbolicLink())throw Error('Memory symlinks require review before copying');const rel=path.posix.join(relative,f.name);if(f.isDirectory())walk(rel,depth+1);else if(f.isFile()&&f.name.endsWith('.md'))add(rel);}}
  if(fs.existsSync(path.join(root,'memory')))walk('memory');
  // The private signing key stays on the coordinator; only its verifier travels.
  let provenancePublicKey='';
  const security=path.join(c.projectRoot,'data','.security');
  if(fs.existsSync(security))for(const name of fs.readdirSync(security)){
    if(!/memory.*(?:key|pem)/i.test(name))continue;
    try{const bytes=privateRead(path.join(security,name),16384),key=crypto.createPrivateKey(bytes);if(key.asymmetricKeyType==='ed25519'){provenancePublicKey=crypto.createPublicKey(key).export({type:'spki',format:'pem'}).toString();break;}}catch{}
  }
  return validateSnapshot({files,agentConfig:JSON.parse(row.agent_config||'{}'),provenancePublicKey});
}

export function remoteRpc(c,method,fields={},timeoutMs=20000){
  const p=c.peer;
  if(!p||!/^100\./.test(p.host||'')||!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(p.user||''))throw Error('Invalid private peer coordinates');
  privateRead(p.identityFile,16384);privateRead(p.knownHosts,65536);
  const request={schema:1,networkId:c.networkId,nodeId:p.nodeId,ownerJid:c.ownerJid,method,...fields},data=JSON.stringify(request)+'\n';if(Buffer.byteLength(data)>MAX_RPC_BYTES)throw Error('Task context exceeds transport limit');
  const args=['-T','-i',p.identityFile,'-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+p.knownHosts,'-o','ConnectTimeout=6','-o','ConnectionAttempts=1','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','-o','ControlMaster=auto','-o','ControlPersist=300','-o','ControlPath='+p.controlPath,p.user+'@'+p.host,'skoobi-peer-rpc'];
  return new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/ssh',args,{stdio:['pipe','pipe','pipe']}),parts=[];let size=0,done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('MacBook connection timed out; the same task identity will be reconciled.'));},timeoutMs);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>MAX_RPC_BYTES){child.kill('SIGKILL');finish(Error('Peer response exceeds limit'));}else parts.push(chunk);});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.on('error',()=>finish(Error('Peer transport unavailable')));
    child.on('close',code=>{if(code!==0)return finish(Error('MacBook is unavailable or rejected the request'));try{const r=JSON.parse(Buffer.concat(parts).toString());if(r.ok!==true)throw Error();finish(null,r.value);}catch{finish(Error('Invalid peer response'));}});
    child.stdin.end(data);
  });
}

export async function submit(c,{prompt,title,notify=true,inputs=[],contract},transport=remoteRpc,snapshotFactory=ownerSnapshot){
  if(c.protocol===2||contract){const {submitPeerV2}=await import('./skoobi-peer-v2.mjs');return submitPeerV2(c,{prompt,title,notify,inputs,contract},transport);}
  const id=crypto.randomUUID();validateRequest(c,{schema:1,networkId:c.networkId,nodeId:c.nodeId,ownerJid:c.ownerJid,method:'submit',id,prompt,title});
  const store=new JobStore(c.stateRoot),snapshot=snapshotFactory(c);
  const packet={id,prompt,title,notify,snapshot,inputs:validateInputs(inputs)};
  if(Buffer.byteLength(JSON.stringify(packet))+1024>MAX_RPC_BYTES)throw Error('Task inputs and context exceed transport limit');
  store.submit(packet);
  let release;
  try{release=acquireCoordinatorLock(store.dir(id));}
  catch(error){if(error.code==='PEER_BUSY')return pendingOperation(store,id);throw error;}
  try{
    if(store.wantsCancel(id))return{...await reconcileCancellation(c,store,id,transport),accepted:false};
    let result;
    try{result=await transport(c,'submit',packet,60000);validateRemoteState(id,result);}
    catch{store.update(id,{lastConnectionErrorAt:now()});return store.wantsCancel(id)?{...pendingCancellation(store,id),accepted:false}:{id,title,state:'waiting_for_macbook',accepted:false};}
    store.update(id,{remoteAcceptedAt:now(),remoteState:result.state});
    if(store.wantsCancel(id))return{...await (terminalStates.has(result.state)?recordRemote(c,store,id,result,transport):reconcileCancellation(c,store,id,transport)),accepted:true};
    return{id,title,state:result.state,accepted:true};
  }finally{release();}
}

export async function downloadArtifacts(c,id,state,transport=remoteRpc){
  const store=new JobStore(c.stateRoot),dir=privateDirectory(path.join(store.dir(id),'artifacts'),true),result=[];
  for(const a of state.artifacts||[]){
    if(!/^[a-f0-9]{64}(?:\.[A-Za-z0-9.]{1,15})?$/.test(a.name||'')||!Number.isSafeInteger(a.bytes)||a.bytes<0||a.bytes>64*1024*1024||!['photo','document'].includes(a.kind))throw Error('Invalid artifact manifest');
    const target=path.join(dir,a.name);
    if(fs.existsSync(target)){if(sha256(privateRead(target,64*1024*1024))!==a.sha256)throw Error('Existing task artifact differs');result.push({...a,localPath:target});continue;}
    const parts=[];let offset=0;
    do{const chunk=await transport(c,'artifact',{id,name:a.name,offset});if(chunk.offset!==offset||chunk.sha256!==a.sha256||chunk.bytes!==a.bytes)throw Error('Artifact changed during transfer');const data=Buffer.from(chunk.data,'base64');if(data.toString('base64')!==chunk.data||(!data.length&&offset<a.bytes)||offset+data.length>a.bytes)throw Error('Invalid artifact chunk');parts.push(data);offset+=data.length;}while(offset<a.bytes);
    const bytes=Buffer.concat(parts);if(sha256(bytes)!==a.sha256)throw Error('Artifact checksum mismatch');atomicWrite(target,bytes,true);result.push({...a,localPath:target});
  }
  return result;
}

export function enqueueResult(c,id,state,artifacts){
  const store=new JobStore(c.stateRoot),local=store.state(id);if(local.notificationState)return local.notificationState;
  const payload=store.payload(id);if(payload.notify===false){store.update(id,{notificationState:'disabled'});return 'disabled';}
  const outbox=path.join(c.projectRoot,'data/ipc',c.ownerGroupFolder,'messages');
  const s=fs.lstatSync(outbox);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o022||fs.realpathSync(outbox)!==outbox)throw Error('Unsafe coordinator delivery directory');
  const lines=[`Скуби на MacBook — ${state.title}`];
  for(const d of state.deliveries||[])if(d.text&&!lines.includes(d.text))lines.push(d.text);
  if(state.state!=='succeeded')lines.push(state.state==='needs_review'?'Выполнение прервалось. Автоматический повтор отключён, чтобы не повторить уже сделанные действия.':state.state==='cancelled'?'Задача остановлена.':'Задача завершилась с ошибкой. Основной Скуби может проверить подробности.');
  const published=artifacts.map(a=>{
    const groupRoot=path.join(c.projectRoot,'groups',c.ownerGroupFolder),s=fs.lstatSync(groupRoot);
    if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o022||fs.realpathSync(groupRoot)!==groupRoot)throw Error('Unsafe owner artifact workspace');
    const parent=privateDirectory(path.join(groupRoot,'.peer-results'),true),dir=privateDirectory(path.join(parent,id),true),file=path.join(dir,a.name);
    const bytes=privateRead(a.localPath,64*1024*1024);if(sha256(bytes)!==a.sha256)throw Error('Downloaded artifact changed');
    if(!fs.existsSync(file))atomicWrite(file,bytes,true);else if(sha256(privateRead(file,64*1024*1024))!==a.sha256)throw Error('Published task artifact changed');
    return {...a,localPath:file};
  });
  const messages=[{type:'message',chatJid:c.ownerJid,text:lines.join('\n\n').slice(0,60000)},...published.map(a=>({type:a.kind==='photo'?'photo':'document',chatJid:c.ownerJid,filePath:a.localPath,caption:a.caption?.slice(0,1024)||undefined}))];
  // Mark the handoff before writing IPC. A crash in this narrow window is
  // reported as uncertain; it is never resolved by blindly sending twice.
  store.update(id,{notificationState:'preparing',notificationPreparedAt:now()});
  for(let i=0;i<messages.length;i++){
    const p=path.join(outbox,`peer-${id}-${i}.json`);if(!fs.existsSync(p))atomicIpc(p,messages[i]);
  }
  store.update(id,{notificationState:'enqueued',notificationEnqueuedAt:now()});return 'enqueued';
}
function atomicIpc(file,value){
  // IPC belongs to the existing instance and may have its legacy 0755 mode.
  const temp=file+'.new-'+crypto.randomBytes(6).toString('hex');
  try{const fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}

// Keep the historical coordinator.guard inode and error codes, using the same
// inherited-fd lock as protocol 2 (macOS lockf / Linux flock). Process death
// releases ownership; unlink/recreate would split the lock domain.
export function acquireCoordinatorLock(root){
  try{return acquireFileLock(root,'coordinator');}
  catch(error){
    if(error.code==='PEER_LOCK_ERROR')error.message='Coordinator lock unavailable';
    else if(error.message==='Unsafe peer lock')error.message='Unsafe coordinator lock';
    throw error;
  }
}

function pendingOperation(store,id){
  const local=store.state(id);
  if(terminalStates.has(local.state))return{...terminalResult(local),accepted:Boolean(local.remoteAcceptedAt)};
  return{...(store.wantsCancel(id)?pendingCancellation(store,id):{id,title:local.title,state:'reconciliation_pending',remoteState:local.remoteState||'unknown'}),accepted:Boolean(local.remoteAcceptedAt)};
}

function pendingCancellation(store,id){
  const local=store.state(id);
  return{id,title:local.title,state:'cancellation_pending',cancelRequested:true,cancellationConfirmed:false,remoteState:local.remoteState||'unknown'};
}

function terminalResult(local){
  return local.remoteResult||{id:local.id,title:local.title,state:local.state,finishedAt:local.finishedAt};
}

function validateRemoteState(id,remote){
  if(remote?.id!==id||!['queued','running',...terminalStates].includes(remote.state))throw Error('Invalid peer job response');
}

async function recordRemote(c,store,id,remote,transport){
  validateRemoteState(id,remote);
  const result=store.wantsCancel(id)?{...remote,cancelRequested:true,cancellationConfirmed:remote.state==='cancelled'}:remote;
  if(!terminalStates.has(remote.state)){store.update(id,{remoteState:remote.state,progress:remote.progress||null});return result;}
  const artifacts=await downloadArtifacts(c,id,remote,transport);
  store.update(id,{remoteState:remote.state,remoteResult:result,localArtifacts:artifacts});
  enqueueResult(c,id,remote,artifacts);store.update(id,{state:remote.state,finishedAt:remote.finishedAt||now()});return result;
}

async function reconcileCancellation(c,store,id,transport){
  let remote;
  try{
    remote=await transport(c,'cancel',{id});
    validateRemoteState(id,remote);
  }catch{
    // A lost submit acknowledgement does not prove that the worker has no job.
    // Persist intent and stop resubmission; never invent a remote terminal state.
    store.update(id,{lastConnectionErrorAt:now()});return pendingCancellation(store,id);
  }
  return recordRemote(c,store,id,remote,transport);
}

export async function cancel(c,id,transport=remoteRpc){
  const store=new JobStore(c.stateRoot),local=store.cancel(id);
  if(terminalStates.has(local.state))return terminalResult(local);
  return reconcile(c,id,transport);
}

export async function reconcile(c,id,transport=remoteRpc){
  const store=new JobStore(c.stateRoot);
  if(store.state(id).schema===2){const {reconcilePeerV2}=await import('./skoobi-peer-v2.mjs');return reconcilePeerV2(c,id,transport);}
  // Keep cancellation intent outside the lock: the request must survive even
  // while a slow submit owns it. That RPC handles the marker before returning.
  let release;
  try{release=acquireCoordinatorLock(store.dir(id));}
  catch(error){if(error.code==='PEER_BUSY'&&store.wantsCancel(id))return pendingCancellation(store,id);throw error;}
  try{return await reconcileLocked(c,store,id,transport);}
  catch(error){store.update(id,{lastConnectionErrorAt:now()});throw error;}
  finally{release();}
}

async function reconcileLocked(c,store,id,transport){
  const local=store.state(id);
  if(local.notificationState==='preparing')store.update(id,{notificationState:'uncertain'});
  if(terminalStates.has(local.state))return terminalResult(local);
  // cancel.json is durable and independent of concurrent state.json updates.
  if(store.wantsCancel(id))return reconcileCancellation(c,store,id,transport);
  const payload=store.payload(id);let remote;
  if(!local.remoteAcceptedAt){
    const snapshot=privateJson(path.join(store.snapshots,payload.snapshotVersion+'.json'));
    remote=await transport(c,'submit',{id,...payload,snapshot},60000);validateRemoteState(id,remote);store.update(id,{remoteAcceptedAt:now()});
  }else remote=await transport(c,'status',{id});
  // Cancellation can arrive while an already-started RPC is awaiting its reply.
  if(store.wantsCancel(id)&&!terminalStates.has(remote.state))return reconcileCancellation(c,store,id,transport);
  return recordRemote(c,store,id,remote,transport);
}

export async function watchOnce(c,transport=remoteRpc,shouldStop=()=>false){
  const store=new JobStore(c.stateRoot);
  if(c.protocol===2){const {watchPeerV2}=await import('./skoobi-peer-v2.mjs');await watchPeerV2(c,transport,shouldStop);return;}
  for(const s of store.list()){
    if(shouldStop())break;
    if(terminalStates.has(s.state)&&s.notificationState!=='preparing')continue;
    // reconcile owns all bookkeeping. Busy jobs must not be updated here.
    try{await reconcile(c,s.id,transport);}catch{}
  }
}

export async function watch(c){
  let stopping=false;process.once('SIGTERM',()=>stopping=true);process.once('SIGINT',()=>stopping=true);
  const releaseLock=acquireProcessLock(c.stateRoot,'watch');
  const heartbeat=()=>atomicWrite(path.join(c.stateRoot,'coordinator-heartbeat.json'),{pid:process.pid,updatedAt:now(),protocol:c.protocol||1});
  heartbeat();const heartbeatTimer=setInterval(heartbeat,2000);
  try{while(!stopping){
    await watchOnce(c,remoteRpc,()=>stopping);
    atomicWrite(path.join(c.stateRoot,'coordinator-heartbeat.json'),{pid:process.pid,updatedAt:now()});
    for(let i=0;i<10&&!stopping;i++)await sleep(500);
  }}finally{clearInterval(heartbeatTimer);releaseLock();}
}

async function main(){
  const args=process.argv.slice(2),command=args.shift();const ci=args.indexOf('--config');if(ci<0||!args[ci+1])throw Error('Private coordinator --config is required');const file=args.splice(ci,2)[1],c=loadConfig(file);if(c.role!=='coordinator')throw Error('Coordinator role required');
  if(command==='watch'){if(args.length)throw Error('Unexpected argument');await watch(c);return;}
  let result;
  if(command==='hello')result=await remoteRpc(c,'hello');
  else if(command==='submit'){
    const ti=args.indexOf('--title');const title=ti>=0?args.splice(ti,2)[1]:'Задача';const ni=args.indexOf('--no-notify'),notify=ni<0;if(ni>=0)args.splice(ni,1);
    const ci=args.indexOf('--contract');const contract=ci>=0?JSON.parse(ownerRead(args.splice(ci,2)[1],96000).toString()):undefined;
    const inputs=[];while(args.length){if(args.shift()!=='--file')throw Error('Unknown submission argument');const file=args.shift();if(!file||!path.isAbsolute(file))throw Error('Absolute task input file required');const data=ownerRead(file,8*1024*1024);inputs.push({name:path.basename(file),sha256:sha256(data),data:data.toString('base64')});}
    const parts=[];let n=0;for await(const x of process.stdin){n+=x.length;if(n>128*1024)throw Error('Task prompt exceeds limit');parts.push(x);}result=await submit(c,{title,notify,inputs,contract,prompt:Buffer.concat(parts).toString('utf8')});
  }
  else if(command==='status'||command==='inspect'){
    const id=args.shift(),store=new JobStore(c.stateRoot),state=store.state(id);
    result=state.schema===2?(await import('./skoobi-peer-v2.mjs')).inspectPeerV2(c,id):state;
  }
  else if(command==='reconcile')result=await reconcile(c,args.shift());
  else if(command==='gui-slot'){
    const id=args.shift();if(args.shift()!=='--minutes')throw Error('gui-slot requires --minutes');
    const minutes=Number(args.shift());if(args.length||!Number.isInteger(minutes)||minutes<1||minutes>60)throw Error('GUI slot must be 1 to 60 minutes');
    const store=new JobStore(c.stateRoot),state=store.state(id),payload=store.payload(id);
    if(state.schema!==2||payload.contract.execution.mode!=='gui'||payload.contract.execution.guiAuthorized!==true)throw Error('Explicit GUI task required');
    result=await remoteRpc(c,'gui_slot',{schema:2,id,revision:state.revision,durationMs:minutes*60000});
  }
  else if(['revise','review','rework'].includes(command)){
    const id=args.shift();if(args.length)throw Error('Pass operation JSON on stdin');
    const chunks=[];let bytes=0;for await(const part of process.stdin){bytes+=part.length;if(bytes>256*1024)throw Error('Peer operation exceeds limit');chunks.push(part);}
    const options=JSON.parse(Buffer.concat(chunks).toString('utf8')),v2=await import('./skoobi-peer-v2.mjs');
    result=command==='revise'?await v2.revisePeerV2(c,id,options,remoteRpc):command==='review'?await v2.reviewPeerV2(c,id,options):await v2.reworkPeerV2(c,id,options,remoteRpc);
  }
  else if(command==='list'){
    const store=new JobStore(c.stateRoot);
    result=store.list().map(s=>({id:s.id,title:s.title,state:store.wantsCancel(s.id)&&!terminalStates.has(s.state)?'cancellation_pending':s.state,remoteState:s.remoteState,notificationState:s.notificationState}));
  }
  else if(command==='cancel')result=await cancel(c,args.shift());
  else throw Error('Commands: hello, submit, inspect, status, reconcile, revise, review, rework, gui-slot, list, cancel, watch');
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Peer operation failed. Check the private job status and MacBook availability.');process.exitCode=1;});
