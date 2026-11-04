import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {JobStore,privateDirectory,privateRead,atomicWrite,privateJson,contentHash,validatePeerContract,validatePeerContext,acquireProcessLock,readMaintenanceGate,readGuiSlot,allocateGuiSlot,peerStorageBytes,rpc,sha256} from './skoobi-peer-core.mjs';
import {executePeerJob,collectPeerResult,createWorkerOutputState,choosePeerJob} from './skoobi-peer-worker.mjs';
import {createNativeOutputState,boundedWorkspaceUsage,launchContainedPeer,reapInterruptedExecutions,peerBundledSearchTool,peerExecutableSha256} from './skoobi-peer-runtime.mjs';
import {verifyPeerResult} from './skoobi-peer-acceptance.mjs';

function fixture(t){const p=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'skoobi-peer-v2-worker-')));fs.chmodSync(p,0o700);t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function packet(id=crypto.randomUUID(),revision=1){
  const contract={schema:1,revision,parentTaskId:'synthetic-parent',projectKey:'synthetic-project',source:{messageId:'synthetic-message'},goal:'Produce a synthetic result',expectedOutputs:[{name:'answer.txt',kind:'document'}],acceptance:[{id:'content',description:'Exact expected content',kind:'file_contains',outputName:'answer.txt',expected:'expected'}],execution:{mode:'isolated',timeoutMs:10000,expiresAt:new Date(Date.now()+3600000).toISOString(),maxOutputBytes:1024*1024,maxWorkspaceBytes:8*1024*1024,allowBattery:true,guiAuthorized:false},runtime:{model:'fixture-model',reasoningEffort:'high'},dependsOnParent:false};
  const context={schema:1,taskId:id,revision,scopeHash:'a'.repeat(64),scopeRevisionHash:'b'.repeat(64),retrieval:{mode:'lexical',reason:'not_configured'},projectKey:contract.projectKey,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1800000).toISOString(),records:[]};context.sha256=contentHash(context);
  return{schema:2,id,prompt:'Produce expected content',title:'Synthetic',notify:false,inputs:[],contract,context};
}
function changeRevision(p){const next=structuredClone(p);next.contract.revision++;next.context.revision++;delete next.context.sha256;next.context.sha256=contentHash(next.context);return next;}
function config(root){return{schema:1,protocol:2,role:'worker',stateRoot:root,projectRoot:root,networkId:'0'.repeat(24),nodeId:'worker',ownerJid:'tg:1234567',ownerGroupFolder:'telegram_main',model:'fixture-model',reasoningEffort:'high'};}
function envelope(c,p,method='submit'){return{...p,schema:2,networkId:c.networkId,nodeId:c.nodeId,ownerJid:c.ownerJid,method};}
function successfulExecution(store,job){const dir=privateDirectory(path.join(store.dir(job.id),'output'),true);atomicWrite(path.join(dir,'answer.txt'),'expected',true);atomicWrite(path.join(dir,'.peer-result.json'),{summary:'Synthetic completed',checks:[{id:'content',status:'reported_pass',detail:'Model claim only'}],changedObjects:[],limitations:[],memoryProposals:[]},true);return{success:true,summary:'Synthetic completed',outputRoot:dir,runtime:{reportedEffort:null,requestedEffort:'high'},isolation:{boundary:'synthetic_fixture',containmentPassed:false}};}

test('v2 contract requires explicit checks, limits, GUI authorization and bounded rework',()=>{
  const p=packet();assert.equal(validatePeerContract(p.contract).revision,1);
  for(const mutate of [c=>c.acceptance=[],c=>c.execution.mode='gui',c=>c.rework=3,c=>c.expectedOutputs[0].name='../other',c=>c.execution.timeoutMs=0,c=>c.execution.shell='bad']){const c=structuredClone(p.contract);mutate(c);assert.throws(()=>validatePeerContract(c));}
});
test('context is task/project/revision/hash/expiry bound and cannot carry host authority',()=>{
  const p=packet();assert.equal(validatePeerContext(p.context,{id:p.id,contract:p.contract,fresh:true}).sha256,p.context.sha256);
  for(const change of [c=>c.taskId=crypto.randomUUID(),c=>c.revision=2,c=>c.projectKey='another',c=>c.sha256='0'.repeat(64),c=>c.credentials={},c=>c.scopeRevisionHash='bad']){const c=structuredClone(p.context);change(c);assert.throws(()=>validatePeerContext(c,{id:p.id,contract:p.contract,fresh:true}));}
});
test('v2 persisted submission is idempotent and binds exact task revision and files',t=>{
  const store=new JobStore(fixture(t)),p=packet();store.submit(p);assert.equal(store.submit(p).revision,1);assert.throws(()=>store.submit({...p,prompt:'different'}));assert.throws(()=>store.submit(changeRevision(p)));assert.equal(store.list().length,1);
});
test('queued revision switches payload and state atomically, repeated revision is idempotent',t=>{
  const store=new JobStore(fixture(t)),p=packet();store.submit(p);const next=changeRevision(p);next.prompt='Corrected';const s=store.revise(next);assert.equal(s.revision,2);assert.equal(store.payload(p.id).prompt,'Corrected');assert.equal(store.revise(next).revision,2);assert.equal(fs.existsSync(path.join(store.dir(p.id),'payload-r1.json')),true);
});
test('running revision is pending, never falsely accepted by the active process',t=>{
  const store=new JobStore(fixture(t)),p=packet();store.submit(p);store.claim(p.id);const s=store.revise(changeRevision(p));assert.equal(s.revision,1);assert.equal(s.pendingRevision,2);assert.equal(s.revisionStatus,'interruption_required');assert.equal(store.payload(p.id).contract.revision,1);
});
test('cancellation before claim prevents execution and forbids revision',t=>{
  const store=new JobStore(fixture(t)),p=packet();store.submit(p);store.cancel(p.id);assert.throws(()=>store.revise(changeRevision(p)));assert.equal(store.claim(p.id).state,'cancelled');assert.equal(store.claim(p.id),null);
});
test('expired context is not executed and completed revisions cannot be replayed',t=>{
  const store=new JobStore(fixture(t)),p=packet();store.submit(p);assert.equal(store.claim(p.id,{nowMs:Date.now()+7200000}).state,'needs_review');assert.throws(()=>store.update(p.id,{state:'queued'}));assert.equal(store.submit(p).state,'needs_review');
});
test('restart preserves interrupted work as needs_review and excludes legacy queue',t=>{
  const store=new JobStore(fixture(t)),p=packet();store.submit(p);store.claim(p.id);store.recover({v2Only:true});assert.equal(store.state(p.id).state,'needs_review');assert.equal(store.claim(p.id),null);
});
test('one corrupt job cannot prevent healthy queue inspection or dispatch',t=>{
  const root=fixture(t),store=new JobStore(root),p=packet();store.submit(p);const bad=crypto.randomUUID();privateDirectory(path.join(root,'jobs',bad),true);atomicWrite(path.join(root,'jobs',bad,'state.json'),'invalid',true);assert.equal(store.list().length,1);assert.equal(store.corruptJobs.length,1);assert.equal(store.claim(p.id).state,'running');
});
test('ownerless and stale legacy singleton locks recover under permanent kernel guard',t=>{
  const root=fixture(t);privateDirectory(path.join(root,'worker.lock'),true);const release=acquireProcessLock(root,'worker');assert.throws(()=>acquireProcessLock(root,'worker'));release();assert.equal(fs.existsSync(path.join(root,'worker.lock')),false);assert.equal(fs.existsSync(path.join(root,'worker-singleton.guard')),true);
});
test('worker singleton survives helper exit and is available after real holder SIGKILL',async t=>{
  const root=fixture(t),module=new URL('./skoobi-peer-core.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {acquireProcessLock} from ${JSON.stringify(module)};acquireProcessLock(process.argv[1],'worker');process.stdout.write('locked');process.stdin.resume();`,root],{stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});await once(child.stdout,'data');assert.throws(()=>acquireProcessLock(root,'worker'));const closed=once(child,'close');child.kill('SIGKILL');await closed;const release=acquireProcessLock(root,'worker');release();
});
test('maintenance blocks new work even after expiry without mutating existing jobs',t=>{
  const root=fixture(t),c=config(root),p=packet();new JobStore(root).submit(p);atomicWrite(path.join(root,'maintenance.json'),{schema:1,tokenSha256:'f'.repeat(64),createdAt:new Date(Date.now()-2000).toISOString(),expiresAt:new Date(Date.now()-1000).toISOString()},true);assert.equal(readMaintenanceGate(root).expired,true);assert.throws(()=>rpc(c,envelope(c,packet())));assert.equal(rpc(c,envelope(c,{id:p.id},'inspect')).state,'queued');
});
test('protocol 2 worker refuses new v1 jobs and unsupported model or GUI profiles',t=>{
  const root=fixture(t),c=config(root),p=packet();assert.throws(()=>rpc(c,{...envelope(c,p),schema:1}));p.contract.runtime.model='other-model';assert.throws(()=>rpc(c,envelope(c,p)));p.contract.runtime.model=c.model;p.contract.execution.mode='gui';p.contract.execution.guiAuthorized=true;assert.throws(()=>rpc(c,envelope(c,p)));
});
test('context checkpoint accepts only matching pending request and immutable response',t=>{
  const store=new JobStore(fixture(t)),p=packet();store.submit(p);store.claim(p.id);const r=store.requestContext(p.id,{query:'Need project fact',recordKeys:[],reason:'Missing input'});assert.equal(r.state,'pending');assert.equal(store.requestContext(p.id,{query:'Need project fact',recordKeys:[],reason:'Missing input'}).requestId,r.requestId);
  assert.throws(()=>store.respondContext(p.id,{requestId:crypto.randomUUID(),context:p.context}));const bad={...p.context,scopeRevisionHash:'c'.repeat(64)};delete bad.sha256;bad.sha256=contentHash(bad);assert.throws(()=>store.respondContext(p.id,{requestId:r.requestId,context:bad}));
  assert.equal(store.respondContext(p.id,{requestId:r.requestId,context:p.context}).accepted,true);assert.equal(store.state(p.id).contextRequests[0].state,'answered');assert.equal(store.respondContext(p.id,{requestId:r.requestId,context:p.context}).accepted,true);
});
test('context revocation remains durable and blocks later supplemental replies',t=>{
  const store=new JobStore(fixture(t)),p=packet();store.submit(p);store.claim(p.id);const r=store.requestContext(p.id,{query:'q',recordKeys:[],reason:'r'});store.revokeContext(p.id,{sha256:p.context.sha256,reason:'context_forgotten'});assert.equal(new JobStore(store.root).contextRevoked(p.id),true);assert.throws(()=>store.respondContext(p.id,{requestId:r.requestId,context:p.context}));
});
test('context revocation is hash scoped across accepted queued and pending running revisions',t=>{
  const store=new JobStore(fixture(t)),p=packet();store.submit(p);store.revokeContext(p.id,{sha256:p.context.sha256,reason:'context_changed'});
  assert.equal(store.contextRevoked(p.id),true);const next=changeRevision(p);store.revise(next);
  assert.equal(store.contextRevoked(p.id),false);store.claim(p.id);store.revokeContext(p.id,{sha256:next.context.sha256});
  store.revise(changeRevision(next));assert.equal(store.contextRevoked(p.id),true);assert.equal(store.state(p.id).revision,2);
});
test('native structured output does not turn intermediate text plus error into success',()=>{
  const state=createNativeOutputState();state.observe({type:'item.completed',item:{type:'agent_message',text:'Partial'}});state.observe({type:'error'});state.observe({type:'turn.completed'});assert.equal(state.finish(0).success,false);
  const noCompletion=createNativeOutputState();noCompletion.observe({type:'item.completed',item:{type:'agent_message',text:'Still thinking'}});assert.equal(noCompletion.finish(0).success,false);
});
test('native reports actual tool events but not guessed model metadata',()=>{
  const progress=[],state=createNativeOutputState(x=>progress.push(x));state.observe({type:'item.started',item:{type:'command_execution'}});state.observe({type:'item.completed',item:{type:'command_execution',status:'completed'}});state.observe({type:'turn.completed'});assert.equal(state.finish(0).reportedEffort,null);assert.equal(state.finish(0).toolEvents,2);assert.equal(progress[0].stage,'tool_started');
});
test('deployed GUI output error fix remains effective',()=>{
  const state=createWorkerOutputState();state.observe({status:'error',error:'Failed'});assert.equal(state.finish({status:'success'},{deliveries:[{text:'Partial'}],artifacts:[]}).state,'failed');
});
test('successful execution packages exact output bytes, preserves unknown actual effort, awaits coordinator checks',async t=>{
  const root=fixture(t),store=new JobStore(root),p=packet();store.submit(p);const job=store.claim(p.id);const s=await executePeerJob(config(root),store,job,{isolated:async()=>successfulExecution(store,job)});assert.equal(s.state,'succeeded');assert.equal(s.artifacts[0].sha256,sha256('expected'));assert.equal(s.artifacts[0].displayName,'answer.txt');assert.equal(s.result.workerClaimsOnly,true);assert.equal(s.result.runtime.reportedEffort,null);assert.match(s.resultSha256,/^[a-f0-9]{64}$/);
});
test('completion racing later cancellation keeps actual completed result',async t=>{
  const root=fixture(t),store=new JobStore(root),p=packet();store.submit(p);const job=store.claim(p.id);const s=await executePeerJob(config(root),store,job,{isolated:async()=>{const e=successfulExecution(store,job);store.cancel(p.id);return e;}});assert.equal(s.state,'succeeded');assert.equal(s.cancelRequested,true);assert.equal(s.cancellationConfirmed,false);assert.equal(s.artifacts.length,1);
});
test('an unconfirmed stopped process is needs_review, never confirmed cancelled',async t=>{
  const root=fixture(t),store=new JobStore(root),p=packet();store.submit(p);const job=store.claim(p.id);const s=await executePeerJob(config(root),store,job,{isolated:async()=>({interrupted:true,error:'cancel_requested',terminationConfirmed:false})});assert.equal(s.state,'needs_review');assert.equal(s.cancellationConfirmed,false);
});
test('late revision invalidates old output instead of accepting it as current',async t=>{
  const root=fixture(t),store=new JobStore(root),p=packet();store.submit(p);const job=store.claim(p.id);const s=await executePeerJob(config(root),store,job,{isolated:async()=>{const e=successfulExecution(store,job);store.revise(changeRevision(p));return e;}});assert.equal(s.state,'needs_review');assert.equal(s.error,'context_or_revision_changed');
});
test('GUI context request stops for review and preserves effects report without automatic continuation',async t=>{
  const root=fixture(t),store=new JobStore(root),p=packet(),c={...config(root),allowGui:true};
  p.contract.execution.mode='gui';p.contract.execution.guiAuthorized=true;store.submit(p);const job=store.claim(p.id);
  allocateGuiSlot(c,{id:p.id,revision:1,durationMs:60000});
  const s=await executePeerJob(c,store,job,{gui:async()=>{
    const e=successfulExecution(store,job);e.summary='Synthetic completed actions retained for review';
    atomicWrite(path.join(e.outputRoot,'.peer-context-request.json'),{query:'Missing synthetic fact',recordKeys:[],reason:'Do not guess'},true);return e;
  }});
  assert.equal(s.state,'needs_review');assert.equal(s.error,'waiting_context');assert.equal(s.contextRequest.query,'Missing synthetic fact');
  assert.equal(s.result.partial,true);assert.match(s.result.summary,/retained for review/);assert.equal(s.artifacts.length,1);assert.equal(store.claim(p.id),null);
});
test('retention needs exact acknowledged digest and never deletes unacknowledged work',async t=>{
  const root=fixture(t),store=new JobStore(root),p=packet();store.submit(p);const job=store.claim(p.id);const s=await executePeerJob(config(root),store,job,{isolated:async()=>successfulExecution(store,job)});assert.deepEqual(store.pruneAcknowledged({retentionDays:1,nowMs:Date.now()+3*86400000}),[]);assert.throws(()=>store.acknowledgeResult(p.id,{revision:1,resultSha256:'0'.repeat(64),disposition:'delivered'}));store.acknowledgeResult(p.id,{revision:1,resultSha256:s.resultSha256,disposition:'archived'});assert.deepEqual(store.pruneAcknowledged({retentionDays:1,nowMs:Date.now()+3*86400000}),[p.id]);assert.equal(store.state(p.id).result,null);assert.equal(store.state(p.id).resultSha256,s.resultSha256);assert.equal(fs.existsSync(path.join(store.dir(p.id),'payload-r1.json')),false);
});
test('workspace accounting never follows a link into personal files',t=>{
  const root=fixture(t),other=fixture(t);atomicWrite(path.join(other,'private'),'private',true);fs.symlinkSync(other,path.join(root,'link'));assert.equal(boundedWorkspaceUsage(root).files,1);assert.throws(()=>boundedWorkspaceUsage(root,10000,{strict:true}));assert.equal(fs.readFileSync(path.join(other,'private'),'utf8'),'private');
});
test('unsafe retained job is isolated and does not prevent other acknowledged cleanup',async t=>{
  const root=fixture(t),outside=fixture(t),store=new JobStore(root),ids=[];
  atomicWrite(path.join(outside,'private'),'untouched',true);
  for(let i=0;i<2;i++){
    const p=packet();store.submit(p);const job=store.claim(p.id),s=await executePeerJob(config(root),store,job,{isolated:async()=>successfulExecution(store,job)});
    store.acknowledgeResult(p.id,{revision:1,resultSha256:s.resultSha256,disposition:'archived'});ids.push(p.id);
  }
  fs.symlinkSync(outside,path.join(store.dir(ids[0]),'workspace'));
  assert.deepEqual(store.pruneAcknowledged({retentionDays:1,nowMs:Date.now()+3*86400000}),[ids[1]]);
  assert.deepEqual(store.retentionWarnings,[ids[0]]);assert.equal(fs.readFileSync(path.join(outside,'private'),'utf8'),'untouched');
});

test('global and project memory may use the same key without namespace collision',()=>{
  const p=packet(),record={kind:'fact',key:'tone',projectKey:null,revision:1,updatedAt:p.context.createdAt,validUntil:null,value:'Brief',source:{kind:'direct_user',at:p.context.createdAt,trust:'agent_interpreted'}};
  p.context.records=[record,{...record,projectKey:p.contract.projectKey,value:'Detailed'}];delete p.context.sha256;p.context.sha256=contentHash(p.context);assert.equal(validatePeerContext(p.context,{id:p.id,contract:p.contract}).records.length,2);
});
test('GUI allocation is bounded, task/revision scoped and exclusive without granting perpetual use',t=>{
  const root=fixture(t),store=new JobStore(root),c={...config(root),allowGui:true},p=packet();p.contract.execution.mode='gui';p.contract.execution.guiAuthorized=true;store.submit(p);
  assert.equal(readGuiSlot(c,p.id,1).available,false);assert.throws(()=>allocateGuiSlot(c,{id:p.id,revision:2,durationMs:60000}));assert.throws(()=>allocateGuiSlot(c,{id:p.id,revision:1,durationMs:7200000}));
  assert.equal(allocateGuiSlot(c,{id:p.id,revision:1,durationMs:60000}).allocated,true);assert.equal(readGuiSlot(c,p.id,1).available,true);
  const second=packet();second.contract.execution.mode='gui';second.contract.execution.guiAuthorized=true;store.submit(second);assert.throws(()=>allocateGuiSlot(c,{id:second.id,revision:1,durationMs:60000}));assert.equal(readGuiSlot(c,second.id,1).available,false);
});
test('waiting GUI does not block background tasks and cancel is handled without AC power',t=>{
  const root=fixture(t),store=new JobStore(root),first=packet(),second=packet();first.contract.execution.mode='gui';first.contract.execution.guiAuthorized=true;store.submit(first);store.submit(second);
  const selected=choosePeerJob(config(root),store,{gui:()=>({available:false,reason:'gui_slot_required'})});assert.equal(selected.queued.id,second.id);
  store.cancel(first.id);assert.equal(choosePeerJob(config(root),store,{power:()=> 'battery',gui:()=>({available:false,reason:'gui_slot_required'})}).queued.id,first.id);assert.equal(store.claim(first.id).state,'cancelled');
});
test('storage budget counts runtime symlinks without following them or rejecting pinned CLI links',t=>{
  const root=fixture(t),other=fixture(t);atomicWrite(path.join(root,'a'),'fixture',true);atomicWrite(path.join(other,'b'),'private',true);fs.symlinkSync(other,path.join(root,'runtime-link'));assert.ok(peerStorageBytes(root)<1024);assert.throws(()=>peerStorageBytes(root,1),/capacity/);
});

test('daemon SIGKILL leaves a detached child which startup reaps by exact PID birth, without replay',{timeout:10000},async t=>{
  const root=fixture(t),store=new JobStore(root),p=packet();store.submit(p);
  const core=new URL('./skoobi-peer-core.mjs',import.meta.url).href,runtime=new URL('./skoobi-peer-runtime.mjs',import.meta.url).href;
  const producer=`const fs=require('node:fs');process.stdin.once('data',()=>{fs.writeFileSync(process.argv[1],'acted-once',{mode:0o600});process.stdout.write('acting');});setInterval(()=>{},1000);`;
  const code=`import {spawn} from 'node:child_process';import {JobStore} from ${JSON.stringify(core)};import {recordExecutionProcess} from ${JSON.stringify(runtime)};const store=new JobStore(process.argv[1]);store.claim(process.argv[2]);const child=spawn(process.execPath,['-e',${JSON.stringify(producer)},process.argv[1]+'/effect.txt'],{detached:true,stdio:['pipe','pipe','pipe']});recordExecutionProcess(store,process.argv[2],child);child.stdout.on('data',()=>process.stdout.write('acting'));child.stdin.end('go');process.stdin.resume();`;
  const daemon=spawn(process.execPath,['--input-type=module','-e',code,root,p.id],{stdio:['pipe','pipe','pipe']});
  t.after(()=>{try{daemon.kill('SIGKILL');}catch{}try{const r=store.state(p.id).executionProcess;process.kill(-r.pid,'SIGKILL');}catch{}});
  await once(daemon.stdout,'data');const receipt=store.state(p.id).executionProcess;assert.ok(receipt.pid>1);process.kill(receipt.pid,0);
  const closed=once(daemon,'close');daemon.kill('SIGKILL');await closed;process.kill(receipt.pid,0);
  await reapInterruptedExecutions(store);store.recover({v2Only:true});assert.equal(store.state(p.id).executionProcess.groupGone,true);assert.equal(store.state(p.id).state,'needs_review');assert.equal(store.claim(p.id),null);assert.equal(fs.readFileSync(path.join(root,'effect.txt'),'utf8'),'acted-once');
});
test('acceptance binds context and requested runtime while leaving absent provider metadata unknown',async()=>{
  const p=packet();p.contract.expectedOutputs=[];p.contract.acceptance=[{id:'text',kind:'text_contains',description:'Expected response',expected:'fixture complete'}];
  const remote={id:p.id,revision:1,state:'succeeded',result:{revision:1,contextSha256:p.context.sha256,runtime:{requestedModel:p.contract.runtime.model,requestedEffort:p.contract.runtime.reasoningEffort,reportedModel:null,reportedEffort:null}},deliveries:[{kind:'text',text:'fixture complete'}],artifacts:[]};
  assert.equal((await verifyPeerResult({},p,remote,[])).status,'passed');
  const wrongContext=structuredClone(remote);wrongContext.result.contextSha256='f'.repeat(64);assert.equal((await verifyPeerResult({},p,wrongContext,[])).status,'failed');
  const wrongModel=structuredClone(remote);wrongModel.result.runtime.reportedModel='different-model';assert.equal((await verifyPeerResult({},p,wrongModel,[])).status,'failed');
});

test('actual Seatbelt worker confines producer and resumes the same process after a context checkpoint',{skip:process.platform!=='darwin',timeout:30000},async t=>{
  const root=fixture(t),workspace=privateDirectory(path.join(root,'workspace'),true);
  for(const name of ['inputs','output','scratch','home'])privateDirectory(path.join(workspace,name),true);
  const {artifactJobSeatbeltProfile,preflightArtifactJobContainment}=await import('../../packages/core/dist/orchestrator/artifact-job.js');
  const profile=path.join(root,'execution.sb');atomicWrite(profile,artifactJobSeatbeltProfile(workspace,[process.execPath]),true);
  const containment=await preflightArtifactJobContainment(profile,workspace,root);assert.equal(containment.passed,true,JSON.stringify(containment));assert.deepEqual(containment.failures,[]);
  fs.rmSync(path.join(workspace,'output'),{recursive:true});privateDirectory(path.join(workspace,'output'),true);
  const requestId=crypto.randomUUID();let requests=0;
  const code=`const fs=require('node:fs');fs.writeFileSync('output/.peer-context-request.json',JSON.stringify({query:'synthetic',recordKeys:[],reason:'fixture'}),{mode:0o600});let count=0;const timer=setInterval(()=>{if(fs.existsSync('inputs/context-response.json')){clearInterval(timer);const value=JSON.parse(fs.readFileSync('inputs/context-response.json'));fs.writeFileSync('output/answer.txt',value.fact,{mode:0o600});console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));console.log(JSON.stringify({type:'turn.completed'}));process.exit(0);}if(++count>200)process.exit(7);},50);`;
  const result=await launchContainedPeer({profile,executable:process.execPath,args:['-e',code],workspace,input:'',timeoutMs:20000,signal:new AbortController().signal,maxWorkspaceBytes:1024*1024,contextCheckpoint:{request:r=>{assert.equal(r.query,'synthetic');requests++;return{requestId};},response:id=>{assert.equal(id,requestId);return{fact:'expected'};}}});
  assert.equal(result.success,true,JSON.stringify(result));assert.equal(requests,1);assert.equal(fs.readFileSync(path.join(workspace,'output/answer.txt'),'utf8'),'expected');assert.equal(fs.existsSync(path.join(workspace,'output/.peer-context-request.json')),false);
});
test('trusted CLI controller uses direct launch only with exact successful tool-profile evidence',{skip:process.platform!=='darwin'},async t=>{
  const root=fixture(t),workspace=privateDirectory(path.join(root,'workspace'),true);
  for(const name of ['inputs','output','scratch','home'])privateDirectory(path.join(workspace,name),true);
  const home=privateDirectory(path.join(workspace,'home','.codex'),true),configFile=path.join(home,'config.toml');
  atomicWrite(configFile,'synthetic tool profile',true);
  const canary=path.join(root,'controller-only.txt'),executable=path.join(root,'synthetic-cli');
  atomicWrite(canary,'synthetic host value',true);
  atomicWrite(executable,'#!/bin/sh\n/bin/cat "$HOST_CANARY" > output/controller-observed\nprintf \'%s\\n\' \'{"type":"turn.completed"}\'\n',true);
  // Vendor binaries normally allow group/other read+execute; they are not secrets.
  fs.chmodSync(executable,0o755);
  const codexToolPermissions={policy:'macos-codex-tool-permissions-v1',passed:true,failures:[],executableSha256:sha256(fs.readFileSync(executable)),profileSha256:sha256(fs.readFileSync(configFile))};
  const options={executable,args:['--disable','apps','--disable','plugins','exec','--strict-config','--ignore-rules','-c','approval_policy="never"','--cd',workspace,'--skip-git-repo-check','--ephemeral','--json','-'],workspace,input:'',env:{CODEX_HOME:home,HOST_CANARY:canary},timeoutMs:3000,signal:new AbortController().signal,maxWorkspaceBytes:1024*1024,codexToolPermissions};
  await assert.rejects(launchContainedPeer({...options,codexToolPermissions:{...codexToolPermissions,passed:false}}),/attestation_invalid/);
  await assert.rejects(launchContainedPeer({...options,codexToolPermissions:{...codexToolPermissions,executableSha256:'0'.repeat(64)}}),/attestation_invalid/);
  await assert.rejects(launchContainedPeer({...options,args:[...options.args,'--dangerously-bypass-approvals-and-sandbox']}),/attestation_invalid/);
  await assert.rejects(launchContainedPeer({...options,args:[...options.args,'-c','default_permissions=unrestricted']}),/attestation_invalid/);
  assert.equal(fs.existsSync(path.join(workspace,'output/controller-observed')),false);
  const result=await launchContainedPeer(options);
  assert.equal(result.success,true,JSON.stringify(result));
  // This controller is explicitly trusted. The native permission canaries test
  // child tools separately; claiming whole-process containment would be false.
  assert.equal(fs.readFileSync(path.join(workspace,'output/controller-observed'),'utf8'),'synthetic host value');
  fs.writeFileSync(configFile,'changed');
  await assert.rejects(launchContainedPeer(options),/attestation_invalid/);
});
test('versioned symlink layout permits only the resolved executable directory in real Seatbelt',{skip:process.platform!=='darwin'},async t=>{
  const root=fixture(t),workspace=privateDirectory(path.join(root,'workspace'),true),release=privateDirectory(path.join(root,'release'),true);
  for(const name of ['inputs','output','scratch','home'])privateDirectory(path.join(workspace,name),true);
  const bin=privateDirectory(path.join(release,'bin'),true),live=privateDirectory(path.join(root,'live'),true);
  atomicWrite(path.join(bin,'fixture-cat'),'#!/bin/sh\nexec /bin/cat "$1"\n',true);fs.chmodSync(path.join(bin,'fixture-cat'),0o700);
  atomicWrite(path.join(bin,'allowed'),'synthetic allowed',true);atomicWrite(path.join(release,'private'),'must stay unavailable',true);
  fs.symlinkSync('../release/bin',path.join(live,'node_modules'));
  const executable=fs.realpathSync(path.join(live,'node_modules/fixture-cat'));
  const {artifactJobSeatbeltProfile}=await import('../../packages/core/dist/orchestrator/artifact-job.js');
  const profile=path.join(root,'execution.sb');atomicWrite(profile,artifactJobSeatbeltProfile(workspace,[executable,path.dirname(executable)]),true);
  const allowed=spawnSync('/usr/bin/sandbox-exec',['-f',profile,executable,path.join(path.dirname(executable),'allowed')],{encoding:'utf8'});
  assert.equal(allowed.status,0);assert.equal(allowed.stdout,'synthetic allowed');
  const denied=spawnSync('/usr/bin/sandbox-exec',['-f',profile,executable,path.join(release,'private')],{encoding:'utf8'});
  assert.notEqual(denied.status,0);assert.equal(denied.stdout,'');
});
test('pinned bundled rg works through versioned symlinks inside Seatbelt without a global rg',{skip:process.platform!=='darwin'},async t=>{
  const code=fileURLToPath(new URL('../..',import.meta.url)),manifest=JSON.parse(fs.readFileSync(path.join(code,'runtime/codex-toolchain.json')));
  const native=path.join(code,manifest.destination,manifest.binary);
  if(!fs.existsSync(native)){t.skip('Pinned native CLI bundle unavailable');return;}
  const root=fixture(t),workspace=privateDirectory(path.join(root,'workspace'),true),live=privateDirectory(path.join(root,'live'),true);
  for(const name of ['inputs','output','scratch','home'])privateDirectory(path.join(workspace,name),true);
  fs.symlinkSync(path.dirname(fs.realpathSync(native)),path.join(live,'bin'));
  const tool=peerBundledSearchTool(path.join(live,'bin/codex'));
  assert.equal(tool.directory,fs.realpathSync(tool.directory));assert.match(tool.sha256,/^[a-f0-9]{64}$/);
  atomicWrite(path.join(workspace,'inputs/sample.txt'),'needle synthetic line\n',true);atomicWrite(path.join(root,'private.txt'),'needle must stay unavailable\n',true);
  const {artifactJobSeatbeltProfile}=await import('../../packages/core/dist/orchestrator/artifact-job.js');
  const profile=path.join(root,'execution.sb');atomicWrite(profile,artifactJobSeatbeltProfile(workspace,[tool.executable,tool.directory]),true);
  const env={PATH:tool.directory+':/usr/bin:/bin',HOME:path.join(workspace,'home'),TMPDIR:path.join(workspace,'scratch')};
  const allowed=spawnSync('/usr/bin/sandbox-exec',['-f',profile,'/bin/sh','-c','rg --fixed-strings --no-config --no-heading --line-number needle inputs/sample.txt'],{cwd:workspace,env,encoding:'utf8'});
  assert.equal(allowed.status,0,allowed.stderr);assert.equal(allowed.stdout,'1:needle synthetic line\n');
  const denied=spawnSync('/usr/bin/sandbox-exec',['-f',profile,tool.executable,'--fixed-strings','--no-config','needle',path.join(root,'private.txt')],{cwd:workspace,env,encoding:'utf8'});
  assert.notEqual(denied.status,0);assert.equal(denied.stdout,'');
});

test('trusted executable hash accepts owned0755 without weakening secret-file permissions',t=>{
  const root=fixture(t),file=path.join(root,'vendor-cli');
  fs.writeFileSync(file,'synthetic public executable');
  for(const mode of [0o700,0o755]){fs.chmodSync(file,mode);assert.equal(peerExecutableSha256(file),sha256(fs.readFileSync(file)));}
  assert.throws(()=>privateRead(file),/Unsafe peer file/);
  const secret=path.join(root,'config.toml');atomicWrite(secret,'synthetic private config',true);
  assert.equal(privateRead(secret).toString(),'synthetic private config');
  assert.throws(()=>peerExecutableSha256(secret),/trusted_executable_invalid/);
});
test('trusted executable hash rejects writable, nonexecutable, special and unbounded files',t=>{
  const root=fixture(t),file=path.join(root,'vendor-cli');fs.writeFileSync(file,'synthetic');
  for(const mode of [0o775,0o757,0o644,0o4755]){fs.chmodSync(file,mode);assert.throws(()=>peerExecutableSha256(file),/trusted_executable_invalid/,mode.toString(8));}
  fs.chmodSync(file,0o755);fs.truncateSync(file,384*1024*1024+1);assert.throws(()=>peerExecutableSha256(file),/trusted_executable_invalid/);
  fs.truncateSync(file,0);assert.throws(()=>peerExecutableSha256(file),/trusted_executable_invalid/);
  assert.throws(()=>peerExecutableSha256(root),/trusted_executable_invalid/);
});
test('trusted executable hash rejects links and noncanonical parent paths',t=>{
  const root=fixture(t),dir=path.join(root,'bin');fs.mkdirSync(dir,{mode:0o700});const file=path.join(dir,'vendor-cli');fs.writeFileSync(file,'synthetic',{mode:0o755});
  const link=path.join(root,'linked-cli');fs.symlinkSync(file,link);assert.throws(()=>peerExecutableSha256(link),/trusted_executable_invalid/);
  const alias=path.join(root,'alias');fs.symlinkSync(dir,alias);assert.throws(()=>peerExecutableSha256(path.join(alias,'vendor-cli')),/trusted_executable_invalid/);
  assert.throws(()=>peerExecutableSha256(dir+'/../bin/vendor-cli'),/trusted_executable_invalid/);
  fs.linkSync(file,path.join(root,'hardlink'));assert.throws(()=>peerExecutableSha256(file),/trusted_executable_invalid/);
});
test('trusted executable hash rejects a different owner before reading bytes',t=>{
  const root=fixture(t),file=path.join(root,'vendor-cli');fs.writeFileSync(file,'synthetic',{mode:0o755});const original=fs.fstatSync;
  t.mock.method(fs,'fstatSync',function(...args){const stat=original.apply(this,args);return new Proxy(stat,{get(target,key){return key==='uid'?target.uid+1n:Reflect.get(target,key);}});});
  assert.throws(()=>peerExecutableSha256(file),/trusted_executable_invalid/);
});
test('trusted executable hash rejects growth, replacement and mode changes during a bounded read',async t=>{
  for(const change of ['growth','replacement','mode'])await t.test(change,t=>{
    const root=fixture(t),file=path.join(root,'vendor-cli');fs.writeFileSync(file,'synthetic',{mode:0o755});const original=fs.readSync;let changed=false;
    t.mock.method(fs,'readSync',function(...args){const n=original.apply(this,args);if(!changed){changed=true;if(change==='growth')fs.appendFileSync(file,'extra');else if(change==='mode')fs.chmodSync(file,0o777);else{fs.renameSync(file,file+'.old');fs.writeFileSync(file,'synthetic',{mode:0o755});}}return n;});
    assert.throws(()=>peerExecutableSha256(file),/trusted_executable_invalid/);assert.equal(changed,true);
  });
});
