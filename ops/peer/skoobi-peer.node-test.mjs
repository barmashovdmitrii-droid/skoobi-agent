import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {JobStore,atomicWrite,privateRead,privateDirectory,sha256,validateSnapshot,validateRequest,validateInputs,rpc,captureArtifact,readRpc,acquireProcessLock,acquireFileLock} from './skoobi-peer-core.mjs';
import {submit,cancel,reconcile,watchOnce,acquireCoordinatorLock,downloadArtifacts,enqueueResult,portableOwnerInstructions} from './skoobi-peer.mjs';

function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'skoobi-peer-test-')));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function snapshot(){const data=Buffer.from('Owner test preferences: concise answers.');return validateSnapshot({files:[{path:'CLAUDE.md',data:data.toString('base64'),sha256:sha256(data)}],agentConfig:{fullAccess:true,noSandbox:true,systemPrompt:'Test owner profile'}});}
function request(id=crypto.randomUUID()){return{id,prompt:'Test local task',title:'Synthetic task',snapshot:snapshot(),notify:false};}
function config(root,role='worker'){return{schema:1,role,networkId:'0'.repeat(24),nodeId:role==='worker'?'fixture-worker':'fixture-main',ownerJid:'tg:1234567',ownerGroupFolder:'telegram_main',stateRoot:root,projectRoot:root,model:'model-fixture',reasoningEffort:'high'};}
function envelope(c,method,fields={}){return{schema:1,networkId:c.networkId,nodeId:c.nodeId,ownerJid:c.ownerJid,method,...fields};}

test('owner snapshots are deterministic and reject altered content',()=>{
  const s=snapshot();assert.equal(validateSnapshot(s).version,s.version);
  const changed=structuredClone(s);changed.files[0].data=Buffer.from('different').toString('base64');assert.throws(()=>validateSnapshot(changed));
  const wrong=structuredClone(s);wrong.version='f'.repeat(64);assert.throws(()=>validateSnapshot(wrong));
});
test('memory snapshot paths cannot traverse or import credentials',()=>{
  for(const name of ['../.ssh/id_ed25519','/tmp/secret','memory/../../secret.md','memory\\secret.md','.env','conversations/history.md','memory//note.md']){const s=snapshot();s.files[0].path=name;delete s.version;assert.throws(()=>validateSnapshot(s),name);}
});
test('snapshots reject duplicates and private signing material',()=>{
  const s=snapshot();s.files.push(s.files[0]);assert.throws(()=>validateSnapshot(s));
  const bad=snapshot();bad.provenancePublicKey='-----BEGIN PRIVATE KEY-----';assert.throws(()=>validateSnapshot(bad));
});
test('peer requests are pinned to one network, node and owner',()=>{
  const c=config('/synthetic');const ok=envelope(c,'hello');assert.equal(validateRequest(c,ok),ok);
  for(const key of ['networkId','nodeId','ownerJid'])assert.throws(()=>validateRequest(c,{...ok,[key]:'different'}));
  assert.throws(()=>validateRequest(c,{...ok,method:'exec'}));
});
test('job identity is idempotent, but cannot be reused for a new task',t=>{
  const store=new JobStore(fixture(t)),r=request();assert.equal(store.submit(r).state,'queued');assert.deepEqual(store.submit(r),store.state(r.id));
  assert.throws(()=>store.submit({...r,prompt:'different task'}));assert.equal(store.list().length,1);
});
test('queued cancellation is persistent without altering task identity',t=>{
  const store=new JobStore(fixture(t)),r=request();store.submit(r);assert.equal(store.cancel(r.id).cancelRequested,true);assert.equal(new JobStore(store.root).wantsCancel(r.id),true);assert.equal(store.state(r.id).state,'queued');
});
test('interrupted running jobs require review and are never replayed',t=>{
  const store=new JobStore(fixture(t)),r=request();store.submit(r);store.update(r.id,{state:'running'});new JobStore(store.root).recover();assert.equal(store.state(r.id).state,'needs_review');assert.throws(()=>store.update(r.id,{state:'queued'}));assert.equal(store.submit(r).state,'needs_review');
});
test('private state rejects symlink and hardlink reads',t=>{
  const root=fixture(t),p=path.join(root,'data');atomicWrite(p,'private',true);fs.symlinkSync(p,path.join(root,'link'));assert.throws(()=>privateRead(path.join(root,'link')));fs.linkSync(p,path.join(root,'hard'));assert.throws(()=>privateRead(p));
});
test('atomic writes preserve the previous file when a foreign symlink appears',t=>{
  const root=fixture(t),outside=path.join(root,'outside'),p=path.join(root,'state');atomicWrite(outside,'preserved',true);fs.symlinkSync(outside,p);assert.throws(()=>atomicWrite(p,'changed'));assert.equal(fs.readFileSync(outside,'utf8'),'preserved');
});
test('RPC submit, status and artifact reads stay inside the assigned job',t=>{
  const root=fixture(t),c=config(root),r=request();rpc(c,envelope(c,'submit',r));assert.equal(rpc(c,envelope(c,'status',{id:r.id})).id,r.id);
  const source=path.join(root,'report.txt');atomicWrite(source,'synthetic artifact',true);const store=new JobStore(root),artifact=captureArtifact(store,r.id,source);store.update(r.id,{artifacts:[artifact]});
  const part=rpc(c,envelope(c,'artifact',{id:r.id,name:artifact.name,offset:0}));assert.equal(Buffer.from(part.data,'base64').toString(),'synthetic artifact');
  assert.throws(()=>rpc(c,envelope(c,'artifact',{id:r.id,name:'../payload.json',offset:0})));assert.throws(()=>rpc(c,envelope(c,'artifact',{id:r.id,name:artifact.name,offset:-1})));
});
test('artifact downloads validate every chunk and the final checksum',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),r=request(),store=new JobStore(root);store.submit(r);const bytes=Buffer.from('test artifact'),hash=sha256(bytes),a={name:hash+'.txt',sha256:hash,bytes:bytes.length,kind:'document'};
  const result=await downloadArtifacts(c,r.id,{artifacts:[a]},async(_c,_m,p)=>({...a,offset:p.offset,data:bytes.toString('base64')}));assert.equal(fs.readFileSync(result[0].localPath,'utf8'),'test artifact');
  const other={...a,name:hash+'.pdf'};await assert.rejects(downloadArtifacts(c,r.id,{artifacts:[other]},async()=>({...other,offset:0,data:Buffer.from('wrong').toString('base64')})));
});
test('a disconnected submission remains durably queued for the same identity',async t=>{
  const root=fixture(t),c=config(root,'coordinator');const result=await submit(c,{prompt:'A synthetic task',title:'Offline task',notify:false},async()=>{throw Error('offline');},snapshot);
  assert.equal(result.accepted,false);const store=new JobStore(root);assert.equal(store.state(result.id).state,'queued');assert.equal(store.payload(result.id).prompt,'A synthetic task');
});
test('reconnection resubmits an ambiguous handoff with the original identity',async t=>{
  const root=fixture(t),c=config(root,'coordinator');const result=await submit(c,{prompt:'A synthetic task',title:'Offline task',notify:false},async()=>{throw Error('offline');},snapshot);
  let seen;await reconcile(c,result.id,async(_c,method,r)=>{assert.equal(method,'submit');seen=r.id;return{id:r.id,state:'running'};});assert.equal(seen,result.id);assert.equal(new JobStore(root).state(result.id).remoteState,'running');
});
test('completed results with notifications disabled never touch the main outbox',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),store=new JobStore(root),r=request();store.submit(r);store.update(r.id,{remoteAcceptedAt:new Date().toISOString()});
  await reconcile(c,r.id,async()=>({id:r.id,title:r.title,state:'succeeded',deliveries:[{kind:'text',text:'Synthetic result'}],artifacts:[]}));assert.equal(store.state(r.id).state,'succeeded');assert.equal(store.state(r.id).notificationState,'disabled');assert.equal(fs.existsSync(path.join(root,'data')),false);
});
test('a completed worker reply is queued only in the existing owner chat',t=>{
  const root=fixture(t),c=config(root,'coordinator'),store=new JobStore(root),r={...request(),notify:true};store.submit(r);
  const outbox=path.join(root,'data/ipc/telegram_main/messages');fs.mkdirSync(outbox,{recursive:true,mode:0o700});
  const remote={title:'Task result',state:'succeeded',deliveries:[{kind:'text',text:'Synthetic answer'}],artifacts:[]};
  assert.equal(enqueueResult(c,r.id,remote,[]),'enqueued');assert.equal(enqueueResult(c,r.id,remote,[]),'enqueued');const names=fs.readdirSync(outbox);assert.equal(names.length,1);const sent=JSON.parse(fs.readFileSync(path.join(outbox,names[0])));assert.equal(sent.chatJid,c.ownerJid);assert.match(sent.text,/Synthetic answer/);
});
test('RPC rejects malformed JSON instead of invoking any executor',async()=>{await assert.rejects(readRpc(Readable.from([Buffer.from('{malformed')])));});

test('only one worker can hold the execution lock and PID reuse is detected',t=>{
  const root=fixture(t),release=acquireProcessLock(root,'worker');assert.throws(()=>acquireProcessLock(root,'worker'));release();
  const dir=path.join(root,'worker.lock');fs.mkdirSync(dir,{mode:0o700});atomicWrite(path.join(dir,'owner.json'),{pid:process.pid,startToken:'obsolete process start'},true);
  const recovered=acquireProcessLock(root,'worker');recovered();assert.equal(fs.existsSync(dir),false);
});

test('delegated task files reject traversal, duplicate names and corrupt bytes',()=>{
  const data=Buffer.from('Synthetic input'),f={name:'report.txt',data:data.toString('base64'),sha256:sha256(data)};assert.equal(validateInputs([f])[0].bytes,data.length);
  for(const name of ['../secret','/tmp/secret','.env','folder\\file','bad\nfile'])assert.throws(()=>validateInputs([{...f,name}]));
  assert.throws(()=>validateInputs([f,f]));assert.throws(()=>validateInputs([{...f,sha256:'f'.repeat(64)}]));
});
test('idempotency also binds a task to the exact transferred input files',t=>{
  const store=new JobStore(fixture(t)),r=request(),first=Buffer.from('first'),second=Buffer.from('second');
  r.inputs=[{name:'input.txt',data:first.toString('base64'),sha256:sha256(first)}];store.submit(r);assert.equal(store.payload(r.id).inputs[0].name,'input.txt');
  assert.throws(()=>store.submit({...r,inputs:[{name:'input.txt',data:second.toString('base64'),sha256:sha256(second)}]}));
});
test('invalid local tasks are rejected before becoming permanent offline jobs',async t=>{
  const root=fixture(t),c=config(root,'coordinator');await assert.rejects(submit(c,{prompt:'',title:'Empty task'},async()=>{throw Error('offline');},snapshot));assert.equal(fs.existsSync(path.join(root,'jobs')),false);
});
test('the owner persona is replicated without recursive coordinator instructions',()=>{
  const id='0'.repeat(24),original='Owner personality and durable preferences.\n',block='<!-- skoobi-peer-routing:'+id+' -->\nCoordinator commands only.\n<!-- /skoobi-peer-routing:'+id+' -->\n\n';assert.equal(portableOwnerInstructions(block+original,id),original);assert.equal(portableOwnerInstructions(original,id),original);assert.throws(()=>portableOwnerInstructions(block.split('<!-- /')[0],id));
});

test('returned documents pass the actual existing IPC workspace validator',t=>{
  const root=fixture(t),c=config(root,'coordinator'),store=new JobStore(root),r={...request(),notify:true};store.submit(r);
  fs.mkdirSync(path.join(root,'data/ipc/telegram_main/messages'),{recursive:true,mode:0o700});fs.mkdirSync(path.join(root,'groups/telegram_main'),{recursive:true,mode:0o700});
  const file=path.join(store.dir(r.id),'report.txt'),bytes=Buffer.from('Synthetic returned document');atomicWrite(file,bytes,true);const a={name:sha256(bytes)+'.txt',sha256:sha256(bytes),kind:'document',bytes:bytes.length,localPath:file};
  enqueueResult(c,r.id,{title:r.title,state:'succeeded',deliveries:[]},[a]);
  const outbox=path.join(root,'data/ipc/telegram_main/messages');const sent=fs.readdirSync(outbox).map(n=>JSON.parse(fs.readFileSync(path.join(outbox,n)))).find(x=>x.type==='document');
  const qa=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const code='import {validateIpcSendFilePath} from '+JSON.stringify(path.join(qa,'dist/orchestrator/ipc.js'))+'; const r=validateIpcSendFilePath('+JSON.stringify({sourceGroup:'telegram_main',isMain:false,filePath:sent.filePath,kind:'document'})+');if(!r.allowed)throw Error(r.reason);console.log("PASS");';
  const checked=spawnSync(process.execPath,['--input-type=module'],{input:code,encoding:'utf8',cwd:qa,env:{...process.env,SKOOBI_TEST_STATE_ROOT:root,CLAUDECLAW_ENV_FILE:path.join(root,'.env')}});
  assert.equal(checked.status,0,checked.stderr);assert.match(checked.stdout,/PASS/);
});

function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}

test('offline cancellation persists intent and reconnect never resubmits that job',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),store=new JobStore(root),r=request();store.submit(r);
  const local=path.join(store.dir(r.id),'result.txt');atomicWrite(local,'keep result',true);const before=privateRead(path.join(store.dir(r.id),'payload.json'));
  const methods=[];const offline=async(_c,method)=>{methods.push(method);throw Error('offline');};
  const first=await cancel(c,r.id,offline);assert.equal(first.state,'cancellation_pending');assert.equal(first.cancellationConfirmed,false);
  assert.equal(new JobStore(root).wantsCancel(r.id),true);
  await reconcile(c,r.id,offline);assert.deepEqual(methods,['cancel','cancel']);
  const final=await reconcile(c,r.id,async(_c,method)=>{methods.push(method);return{id:r.id,title:r.title,state:'cancelled',artifacts:[]};});
  assert.equal(final.state,'cancelled');assert.equal(final.cancellationConfirmed,true);assert.deepEqual(methods,['cancel','cancel','cancel']);
  assert.equal(fs.readFileSync(local,'utf8'),'keep result');assert.deepEqual(privateRead(path.join(store.dir(r.id),'payload.json')),before);
});

test('cancel acknowledgement for a running job is not terminal confirmation',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),store=new JobStore(root),r=request();store.submit(r);
  const result=await cancel(c,r.id,async()=>({id:r.id,state:'running',cancelRequested:true}));
  assert.equal(result.state,'running');assert.equal(result.cancelRequested,true);assert.equal(result.cancellationConfirmed,false);assert.equal(store.state(r.id).state,'queued');
});

test('completion preceding cancellation is reported as succeeded, with files and other jobs preserved',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),store=new JobStore(root),r=request(),other=request();store.submit(r);store.submit(other);
  const file=path.join(store.dir(r.id),'result.txt');atomicWrite(file,'completed result',true);
  const result=await cancel(c,r.id,async(_c,method,p)=>{assert.equal(method,'cancel');assert.equal(p.id,r.id);return{id:r.id,title:r.title,state:'succeeded',artifacts:[]};});
  assert.equal(result.state,'succeeded');assert.equal(result.cancellationConfirmed,false);assert.equal(store.state(other.id).state,'queued');assert.equal(store.wantsCancel(other.id),false);
  assert.equal(fs.readFileSync(file,'utf8'),'completed result');
  const repeated=await cancel(c,r.id,async()=>assert.fail('terminal job must not be cancelled or submitted again'));
  assert.equal(repeated.state,'succeeded');
});

test('unknown remote job or invalid cancellation receipt remains pending without a submit',async t=>{
  for(const kind of ['missing','wrong-id','invalid-state']){
    const root=fixture(t),c=config(root,'coordinator'),store=new JobStore(root),r=request();store.submit(r);const calls=[];
    const transport=async(_c,method)=>{calls.push(method);if(kind==='missing')throw Error('unknown job');return{id:kind==='wrong-id'?crypto.randomUUID():r.id,state:kind==='invalid-state'?'complete':'cancelled'};};
    const result=await cancel(c,r.id,transport);assert.equal(result.state,'cancellation_pending');assert.equal(result.cancellationConfirmed,false);
    await reconcile(c,r.id,transport);assert.deepEqual(calls,['cancel','cancel']);assert.equal(store.state(r.id).state,'queued');
  }
});

test('cancellation during an in-flight recovery submit persists immediately and follows its acknowledgement',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),store=new JobStore(root),r=request();store.submit(r);const entered=deferred(),resume=deferred(),calls=[];
  const transport=async(_c,method)=>{calls.push(method);if(method==='submit'){entered.resolve();await resume.promise;return{id:r.id,state:'running'};}return{id:r.id,title:r.title,state:'cancelled',artifacts:[]};};
  const recovering=reconcile(c,r.id,transport);await entered.promise;
  const pending=await cancel(c,r.id,async()=>assert.fail('same job RPC must be serialized'));assert.equal(pending.state,'cancellation_pending');assert.equal(store.wantsCancel(r.id),true);
  resume.resolve();const result=await recovering;assert.equal(result.state,'cancelled');assert.equal(result.cancellationConfirmed,true);assert.deepEqual(calls,['submit','cancel']);
});

test('cancellation during the original submit is retained and does not lose accepted receipt',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),entered=deferred(),resume=deferred(),calls=[];let id;
  const transport=async(_c,method,r)=>{calls.push(method);id=r.id;if(method==='submit'){entered.resolve();await resume.promise;return{id,state:'queued'};}throw Error('cancel connection lost');};
  const sending=submit(c,{prompt:'Synthetic initial submit',title:'Cancel during send',notify:false},transport,snapshot);await entered.promise;
  const pending=await cancel(c,id,async()=>assert.fail('must not issue concurrent RPC'));assert.equal(pending.state,'cancellation_pending');
  resume.resolve();const result=await sending;assert.equal(result.accepted,true);assert.equal(result.state,'cancellation_pending');assert.deepEqual(calls,['submit','cancel']);
  assert.ok(new JobStore(root).state(id).remoteAcceptedAt);assert.equal(new JobStore(root).wantsCancel(id),true);
});

test('lost original submit response after cancellation never enables another submit',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),entered=deferred(),resume=deferred(),calls=[];let id;
  const sending=submit(c,{prompt:'Synthetic',title:'Unknown send',notify:false},async(_c,method,r)=>{calls.push(method);id=r.id;entered.resolve();await resume.promise;throw Error('lost response');},snapshot);
  await entered.promise;await cancel(c,id,async()=>assert.fail('must not issue concurrent RPC'));resume.resolve();
  const result=await sending;assert.equal(result.accepted,false);assert.equal(result.state,'cancellation_pending');
  await reconcile(c,id,async(_c,method)=>{calls.push(method);return{id,title:'Unknown send',state:'cancelled',artifacts:[]};});assert.deepEqual(calls,['submit','cancel']);
});

test('terminal response from an in-flight status wins over a later cancellation request',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),store=new JobStore(root),r=request();store.submit(r);store.update(r.id,{remoteAcceptedAt:'known'});
  const entered=deferred(),resume=deferred(),calls=[];
  const reconciling=reconcile(c,r.id,async(_c,method)=>{calls.push(method);entered.resolve();await resume.promise;return{id:r.id,title:r.title,state:'succeeded',artifacts:[]};});
  await entered.promise;await cancel(c,r.id,async()=>assert.fail('no concurrent cancel'));resume.resolve();
  const result=await reconciling;assert.equal(result.state,'succeeded');assert.equal(result.cancellationConfirmed,false);assert.deepEqual(calls,['status']);
});

test('parallel reconcilers cannot duplicate a submit; the lock is released after failure',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),store=new JobStore(root),r=request();store.submit(r);const entered=deferred(),resume=deferred();let count=0;
  const first=reconcile(c,r.id,async()=>{count++;entered.resolve();await resume.promise;throw Error('offline');});await entered.promise;
  await assert.rejects(reconcile(c,r.id,async()=>assert.fail('duplicate submit')),/already running/);
  resume.resolve();await assert.rejects(first,/offline/);assert.equal(count,1);
  await reconcile(c,r.id,async()=>({id:r.id,state:'running'}));assert.equal(fs.existsSync(path.join(store.dir(r.id),'coordinator.lock')),false);
});

test('unknown local cancellation cannot affect an unrelated job',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),store=new JobStore(root),r=request();store.submit(r);
  await assert.rejects(cancel(c,crypto.randomUUID(),async()=>assert.fail('must validate local job first')));
  assert.equal(store.wantsCancel(r.id),false);assert.equal(store.list().length,1);
});


test('initial submit returns its durable identity when watch wins the publication race',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),original=JobStore.prototype.submit;let release,id;
  JobStore.prototype.submit=function(packet){const result=original.call(this,packet);id=packet.id;release=acquireCoordinatorLock(this.dir(id));return result;};
  try{
    const result=await submit(c,{prompt:'Synthetic',title:'Publish race',notify:false},async()=>assert.fail('watch owns RPC'),snapshot);
    assert.equal(result.id,id);assert.equal(result.accepted,false);assert.equal(result.state,'reconciliation_pending');assert.equal(new JobStore(root).list().length,1);
  }finally{JobStore.prototype.submit=original;release?.();}
  await reconcile(c,id,async()=>({id,state:'running'}));
});

test('watch does not update a locked job or mark an active notification uncertain',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),store=new JobStore(root),r=request();store.submit(r);store.update(r.id,{notificationState:'preparing',remoteAcceptedAt:'known'});
  const release=acquireCoordinatorLock(store.dir(r.id)),before=privateRead(path.join(store.dir(r.id),'state.json'));
  try{await watchOnce(c,async()=>assert.fail('active CLI owns reconciliation'));assert.deepEqual(privateRead(path.join(store.dir(r.id),'state.json')),before);}finally{release();}
  await watchOnce(c,async()=>({id:r.id,state:'succeeded',artifacts:[]}));
  assert.equal(store.state(r.id).notificationState,'uncertain');assert.equal(store.state(r.id).state,'succeeded');assert.equal(store.state(r.id).remoteAcceptedAt,'known');
});

test('watch records connection failure under its lock, then allows recovery',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),store=new JobStore(root),r=request();store.submit(r);
  await watchOnce(c,async()=>{throw Error('offline');});assert.ok(store.state(r.id).lastConnectionErrorAt);
  await watchOnce(c,async()=>({id:r.id,state:'running'}));assert.equal(store.state(r.id).remoteState,'running');assert.ok(store.state(r.id).remoteAcceptedAt);
});

test('kernel lock survives helper exit, rejects another process and recovers after owner death',async t=>{
  const root=fixture(t),moduleUrl=new URL('./skoobi-peer.mjs',import.meta.url).href;
  const source=`import {acquireCoordinatorLock} from ${JSON.stringify(moduleUrl)}; acquireCoordinatorLock(process.argv[1]); process.stdout.write('locked'); process.stdin.resume();`;
  const child=spawn(process.execPath,['--input-type=module','-e',source,root],{stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  const [bytes]=await once(child.stdout,'data');assert.equal(bytes.toString(),'locked');
  assert.throws(()=>acquireCoordinatorLock(root),{code:'PEER_BUSY'});
  const closed=once(child,'close');child.kill('SIGKILL');await closed;
  const release=acquireCoordinatorLock(root);assert.throws(()=>acquireCoordinatorLock(root),{code:'PEER_BUSY'});release();
  assert.equal(fs.existsSync(path.join(root,'coordinator.guard')),true);
  const again=acquireCoordinatorLock(root);again();
});

test('coordinator lock rejects a symlink without altering its target',t=>{
  const root=fixture(t),outside=path.join(root,'preserved');atomicWrite(outside,'preserved',true);fs.symlinkSync(outside,path.join(root,'coordinator.guard'));
  assert.throws(()=>acquireCoordinatorLock(root));assert.equal(fs.readFileSync(outside,'utf8'),'preserved');
});

test('legacy and protocol-2 coordinators contend on the same persistent OS lock',t=>{
  const root=fixture(t),guard=path.join(root,'coordinator.guard');
  const legacy=acquireCoordinatorLock(root),inode=fs.statSync(guard).ino;
  try{assert.throws(()=>acquireFileLock(root,'coordinator'),{code:'PEER_BUSY'});}finally{legacy();}
  const current=acquireFileLock(root,'coordinator');
  try{assert.throws(()=>acquireCoordinatorLock(root),{code:'PEER_BUSY'});}finally{current();}
  assert.equal(fs.statSync(guard).ino,inode);
  const again=acquireCoordinatorLock(root);again();
});


test('watch stops dispatching further jobs after a shutdown request',async t=>{
  const root=fixture(t),c=config(root,'coordinator'),store=new JobStore(root),first=request(),second=request();store.submit(first);store.submit(second);
  let stopping=false;const calls=[];
  await watchOnce(c,async(_c,method,packet)=>{calls.push(packet.id);stopping=true;return{id:packet.id,state:'running'};},()=>stopping);
  assert.equal(calls.length,1);assert.equal(store.list().filter(s=>s.remoteAcceptedAt).length,1);
});
