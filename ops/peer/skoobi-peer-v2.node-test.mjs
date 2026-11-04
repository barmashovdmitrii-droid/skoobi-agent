import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {JobStore,atomicWrite,privateDirectory,sha256,validateInputs} from './skoobi-peer-core.mjs';
import {contentHash,PEER_CAPABILITIES} from './skoobi-peer-contract.mjs';
import {submitPeerV2,reconcilePeerV2,inspectPeerV2,revisePeerV2,reviewPeerV2,reworkPeerV2,watchPeerV2} from './skoobi-peer-v2.mjs';
import {verifyPeerResult,peerResultDigest,validatePeerReview} from './skoobi-peer-acceptance.mjs';

const stamp=()=>new Date().toISOString();
const packets=new Map();
function contract(extra={}) {return {schema:1,revision:1,parentTaskId:'synthetic-parent',projectKey:null,source:{},goal:'Return a checked local fixture',
  expectedOutputs:[],acceptance:[{id:'answer',kind:'text_contains',description:'The response contains the expected marker',expected:'fixture complete'}],
  execution:{mode:'isolated',timeoutMs:10000,expiresAt:new Date(Date.now()+3600000).toISOString(),maxOutputBytes:1024*1024,maxWorkspaceBytes:8*1024*1024,allowBattery:true,guiAuthorized:false},
  runtime:{model:'model-fixture',reasoningEffort:'high'},dependsOnParent:false,...extra};}
function context(id,payload) {
  const body={schema:1,taskId:id,revision:payload.contract.revision,projectKey:payload.contract.projectKey,
    scopeHash:'a'.repeat(64),scopeRevisionHash:'b'.repeat(64),retrieval:{mode:'lexical'},createdAt:stamp(),expiresAt:payload.contract.execution.expiresAt,records:[]};
  const result={...body,sha256:contentHash(body)};packets.set(id+':'+payload.contract.revision,{...payload,context:result});return result;
}
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'peer-v2-test-')));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const state=privateDirectory(path.join(root,'state'),true),bridge=privateDirectory(path.join(root,'bridge'),true);
  const c={schema:1,protocol:2,role:'coordinator',networkId:'0'.repeat(24),nodeId:'mini',ownerJid:'tg:1234567',ownerGroupFolder:'telegram_main',stateRoot:state,projectRoot:root};
  const events=[],host={config:{root:bridge},context:async(id,p)=>context(id,p),contextCurrent:async()=>({valid:true}),publish:async event=>events.push(event)};
  return{root,c,host,events,store:new JobStore(state)};
}
function hello(){return{protocol:2,capabilities:PEER_CAPABILITIES,model:'model-fixture',effort:'high',runtime:{cliVerified:true,cliVersion:'0.166.0'},heartbeat:{updatedAt:stamp()},maintenance:{active:false},executionModes:['isolated']};}
function receipt(id,revision=1,state='queued'){const p=packets.get(id+':'+revision);const inputs=validateInputs(p.inputs);const payload={schema:2,prompt:p.prompt,title:p.title,contract:p.contract,context:p.context,notify:p.notify!==false,inputs:inputs.map(({name,sha256})=>({name,sha256}))};return{schema:2,id,revision,state,inputHash:contentHash(payload),contextSha256:p.context.sha256};}
function completion(id,revision=1,extra={}){const p=packets.get(id+':'+revision);return{...receipt(id,revision,'succeeded'),finishedAt:stamp(),result:{revision,contextSha256:p.context.sha256,runtime:{requestedModel:p.contract.runtime.model,requestedEffort:p.contract.runtime.reasoningEffort,reportedModel:null,reportedEffort:null},summary:'fixture complete'},deliveries:[{kind:'text',text:'fixture complete'}],artifacts:[],...extra};}
const options=extra=>({title:'Synthetic task',prompt:'Only a disposable fixture',notify:false,contract:contract(),...extra});
async function queued(f){return submitPeerV2(f.c,options(),async(_c,method,r)=>method==='hello'?hello():receipt(r.id),f.host);}

test('offline handoff preserves identity and resubmits only that identity',async t=>{
  const f=fixture(t),r=await submitPeerV2(f.c,options(),async()=>{throw Error('offline');},f.host);
  assert.equal(r.accepted,false);assert.equal(f.store.list().length,1);let seen;
  await reconcilePeerV2(f.c,r.id,async(_c,method,p)=>{if(method==='hello')return hello();seen=p.id;return completion(p.id);},f.host);
  assert.equal(seen,r.id);assert.equal(f.store.state(r.id).assessment.status,'passed');assert.equal(f.events.filter(e=>e.eventKind==='result').length,1);assert.equal(f.events.at(-1).notify,false);
});
test('incompatible peer never receives a new task',async t=>{
  const f=fixture(t),calls=[];
  const r=await submitPeerV2(f.c,options(),async(_c,m)=>{calls.push(m);return{protocol:1};},f.host);
  assert.deepEqual(calls,['hello']);assert.equal(r.connection,'incompatible');assert.equal(f.store.state(r.id).remoteSubmitAttemptedAt,undefined);
});
test('pure inspection never invokes transport or creates a result event',async t=>{
  const f=fixture(t),r=await queued(f),before=fs.readFileSync(path.join(f.store.dir(r.id),'state.json')),events=f.events.length;
  inspectPeerV2(f.c,r.id);assert.deepEqual(fs.readFileSync(path.join(f.store.dir(r.id),'state.json')),before);assert.equal(f.events.length,events);
});
test('duplicate terminal reconciliation publishes one semantic event',async t=>{
  const f=fixture(t),r=await queued(f);let calls=0;
  const transport=async()=>{calls++;return completion(r.id);};
  await reconcilePeerV2(f.c,r.id,transport,f.host);await reconcilePeerV2(f.c,r.id,transport,f.host);
  assert.equal(calls,1);assert.equal(f.events.filter(e=>e.eventKind==='result').length,1);assert.equal(f.store.state(r.id).deliveryState,'suppressed');
});
test('lost publish acknowledgement retries same event identity, never task execution',async t=>{
  const f=fixture(t),r=await queued(f),seen=[];let fail=true;
  const bodies=[];
  f.host.publish=async e=>{if(e.eventKind!=='result')return;seen.push(e.eventId);bodies.push(JSON.stringify(e));if(fail){fail=false;throw Error('lost host reply');}};
  await assert.rejects(reconcilePeerV2(f.c,r.id,async()=>completion(r.id),f.host));
  await reconcilePeerV2(f.c,r.id,async()=>{throw Error('must not replay');},f.host);
  assert.equal(seen.length,2);assert.equal(seen[0],seen[1]);assert.equal(bodies[0],bodies[1]);
});
test('stale memory revokes ongoing context and prevents a successful acceptance',async t=>{
  const f=fixture(t),r=await queued(f);f.host.contextCurrent=async()=>({valid:false,reason:'changed'});const calls=[];
  await reconcilePeerV2(f.c,r.id,async(_c,m)=>{calls.push(m);return completion(r.id);},f.host);
  assert.ok(calls.includes('revoke_context'));assert.equal(f.store.state(r.id).assessment.status,'inconclusive');
});
test('late cancellation wins over no cancellation only after an actual terminal receipt',async t=>{
  const f=fixture(t),r=await queued(f);f.store.cancel(r.id);
  await reconcilePeerV2(f.c,r.id,async()=>(receipt(r.id,1,'running')),f.host);
  assert.equal(inspectPeerV2(f.c,r.id).state,'cancellation_pending');
  await reconcilePeerV2(f.c,r.id,async()=>completion(r.id,1,{state:'cancelled',cancellationConfirmed:true}),f.host);
  assert.equal(f.store.state(r.id).cancellationConfirmed,true);
});
test('declared requirements fail when runner returns a refusal despite success status',async t=>{
  const f=fixture(t),r=await queued(f);
  await reconcilePeerV2(f.c,r.id,async()=>completion(r.id,1,{deliveries:[{kind:'text',text:'Cannot read the requested file.'}]}),f.host);
  assert.equal(f.store.state(r.id).state,'succeeded');assert.equal(f.store.state(r.id).assessment.status,'failed');
});
test('old revision output cannot pass a new contract',async t=>{
  const f=fixture(t),r=await queued(f),p=f.store.payload(r.id);p.contract.revision=2;p.context=context(r.id,p);
  const assessment=await verifyPeerResult(f.c,p,completion(r.id),[],{});assert.equal(assessment.status,'failed');
});
test('a changed received artifact is rejected even with a claimed successful worker check',async t=>{
  const f=fixture(t),id=crypto.randomUUID(),p=options({contract:contract({expectedOutputs:[{name:'result.json',kind:'document'}],acceptance:[{id:'json',kind:'json_parse',description:'Parse JSON',outputName:'result.json'}]})});p.context=context(id,p);
  const filename=path.join(f.root,'result.json');atomicWrite(filename,'{"ok":true}',true);
  const a={name:'a'.repeat(64)+'.json',displayName:'result.json',sha256:'a'.repeat(64),bytes:11,kind:'document',localPath:filename};
  const assessment=await verifyPeerResult(f.c,p,completion(id),[a],{});assert.equal(assessment.status,'failed');
});
test('artifact checks invoke bounded host checker and never trust worker claims',async t=>{
  const f=fixture(t),id=crypto.randomUUID(),p=options({contract:contract({expectedOutputs:[{name:'result.zip',kind:'document'}],acceptance:[{id:'browser',kind:'artifact',description:'Actual browser route',outputName:'result.zip',scenario:{schema:1,kind:'browser-archive'}}]})});p.context=context(id,p);
  const bytes=Buffer.from('synthetic'),filename=path.join(f.root,'result.zip');atomicWrite(filename,bytes,true);
  const a={name:sha256(bytes)+'.zip',displayName:'result.zip',sha256:sha256(bytes),bytes:bytes.length,kind:'document',localPath:filename};let calls=0;
  const assessment=await verifyPeerResult(f.c,p,completion(id),[a],{recheck:async()=>{calls++;return{status:'failed',code:'scenario_failed'};}});
  assert.equal(calls,1);assert.equal(assessment.status,'failed');
});
test('human-review criteria stay inconclusive until a bound coordinator judgment',async t=>{
  const f=fixture(t),r=await submitPeerV2(f.c,options({contract:contract({acceptance:[{id:'quality',kind:'manual',description:'Review the clarity of the answer'}]})}),async(_c,m,p)=>m==='hello'?hello():completion(p.id),f.host);
  const s=f.store.state(r.id);assert.equal(s.assessment.status,'inconclusive');
  await reviewPeerV2(f.c,r.id,{decision:'accept',resultHash:s.assessment.resultHash,revision:1,note:'Reviewed the exact answer against the stated requirements.'},f.host);
  assert.equal(f.store.state(r.id).review.assurance,'coordinator_judgment');assert.equal(f.store.state(r.id).assessment.status,'inconclusive');
  assert.equal(f.events.at(-1).eventKind,'review');
});
test('manual acceptance cannot override failed mechanical checks',async t=>{
  const f=fixture(t),r=await queued(f);await reconcilePeerV2(f.c,r.id,async()=>completion(r.id,1,{deliveries:[]}),f.host);const s=f.store.state(r.id);
  await assert.rejects(reviewPeerV2(f.c,r.id,{decision:'accept',resultHash:s.assessment.resultHash,revision:1,note:'Try to override a required failed check.'},f.host));
});
test('backoff suppresses repeated offline attempts but not a cancellation',async t=>{
  const f=fixture(t),r=await submitPeerV2(f.c,options(),async()=>{throw Error('offline');},f.host);let calls=0;
  await watchPeerV2(f.c,async()=>{calls++;throw Error('offline');},()=>false,f.host);assert.equal(calls,0);
  f.store.cancel(r.id);await watchPeerV2(f.c,async()=>{calls++;throw Error('offline');},()=>false,f.host);assert.equal(calls,0);assert.equal(f.store.state(r.id).state,'cancelled');
});
test('new jobs are refused during a prepared maintenance window',async t=>{
  const f=fixture(t);atomicWrite(path.join(f.c.stateRoot,'maintenance.json'),{at:stamp()},true);
  await assert.rejects(submitPeerV2(f.c,options(),async()=>{throw Error('must not call network');},f.host));assert.equal(f.store.list().length,0);
});

test('terminal inspection becomes stale after a new correction without accepting old evidence',async t=>{
  const f=fixture(t),r=await queued(f);await reconcilePeerV2(f.c,r.id,async()=>completion(r.id),f.host);
  f.host.contextCurrent=async()=>({valid:false,reason:'changed'});
  await reconcilePeerV2(f.c,r.id,async()=>{throw Error('must not start another job');},f.host);
  assert.equal(inspectPeerV2(f.c,r.id).verification,'stale');assert.equal(f.store.state(r.id).assessment.status,'passed');
});

test('revision retry reuses the retained context and payload after a lost reply',async t=>{
  const f=fixture(t),r=await queued(f),p=f.store.payload(r.id),next={contract:{...p.contract,revision:2},prompt:'Revised fixture'};
  await revisePeerV2(f.c,r.id,next,async()=>{throw Error('offline');},f.host);
  const before=fs.readFileSync(path.join(f.store.dir(r.id),'outbound-revision.json'),'utf8');
  await revisePeerV2(f.c,r.id,next,async()=>{throw Error('offline');},f.host);
  assert.equal(fs.readFileSync(path.join(f.store.dir(r.id),'outbound-revision.json'),'utf8'),before);
  const reply=await revisePeerV2(f.c,r.id,next,async(_c,m)=>m==='inspect'?receipt(r.id):receipt(r.id,2),f.host);
  assert.equal(reply.revision,2);assert.equal(f.store.payload(r.id).prompt,'Revised fixture');
  const again=await revisePeerV2(f.c,r.id,next,async()=>{throw Error('should not contact remote');},f.host);assert.equal(again.revision,2);
});

test('completion before a pending amendment does not pass the new requirements',async t=>{
  const f=fixture(t),r=await queued(f),p=f.store.payload(r.id);
  await revisePeerV2(f.c,r.id,{contract:{...p.contract,revision:2},prompt:'Changed requirement'},async()=>completion(r.id),f.host);
  assert.equal(f.store.state(r.id).assessment.status,'inconclusive');assert.equal(f.store.state(r.id).revisionStatus,'not_applied_completion_won');
});

test('two logical output names with identical bytes are checked separately and sent once',async t=>{
  const f=fixture(t),bytes=Buffer.from('same bytes'),hash=sha256(bytes),outputs=['first.txt','second.txt'];
  const r=await submitPeerV2(f.c,options({contract:contract({expectedOutputs:outputs.map(name=>({name,kind:'document'})),acceptance:outputs.map((name,i)=>({id:'file'+i,kind:'file_contains',description:'Expected content',outputName:name,expected:'same bytes'}))})}),async(_c,m,p)=>m==='hello'?hello():receipt(p.id),f.host);
  const artifacts=outputs.map(displayName=>({name:hash+'.txt',displayName,sha256:hash,bytes:bytes.length,kind:'document'}));
  await reconcilePeerV2(f.c,r.id,async(_c,m,p)=>m==='artifact'?{...artifacts[0],offset:p.offset,data:bytes.toString('base64')}:completion(r.id,1,{artifacts}),f.host);
  assert.equal(f.store.state(r.id).assessment.status,'passed');assert.equal(f.events.find(e=>e.eventKind==='result').artifacts.length,1);
});

test('unexpected checker status cannot become a pass',async t=>{
  const f=fixture(t),id=crypto.randomUUID(),p=options({contract:contract({expectedOutputs:[{name:'file.zip',kind:'document'}],acceptance:[{id:'browser',description:'Verify browser',kind:'artifact',outputName:'file.zip',scenario:{}}]})});p.context=context(id,p);
  const bytes=Buffer.from('fixture'),filename=path.join(f.root,'file.zip');atomicWrite(filename,bytes,true);
  const a={name:sha256(bytes)+'.zip',displayName:'file.zip',sha256:sha256(bytes),bytes:bytes.length,kind:'document',localPath:filename};
  const result=await verifyPeerResult(f.c,p,completion(id),[a],{recheck:async()=>({status:'unknown',code:'unrecognized'})});assert.equal(result.status,'inconclusive');
});

test('a failed review publication is retried even after the original result was acknowledged',async t=>{
  const f=fixture(t),r=await queued(f);await reconcilePeerV2(f.c,r.id,async()=>completion(r.id),f.host);
  f.store.update(r.id,{remoteResultAcknowledged:{disposition:'archived'}});const s=f.store.state(r.id),reviews=[];let fail=true;
  f.host.publish=async e=>{if(e.eventKind==='review'){reviews.push(JSON.stringify(e));if(fail){fail=false;throw Error('lost reply');}}};
  const request={decision:'request_changes',resultHash:s.assessment.resultHash,revision:1,note:'Please improve the explanation in this exact result.'};
  await assert.rejects(reviewPeerV2(f.c,r.id,request,f.host));assert.equal(f.store.state(r.id).pendingResultPublication,true);
  await watchPeerV2(f.c,async()=>{throw Error('must not execute again');},()=>false,f.host);
  assert.equal(f.store.state(r.id).pendingResultPublication,false);assert.equal(reviews.length,2);assert.equal(reviews[0],reviews[1]);
});

test('rework has one durable successor under concurrent and repeated requests',async t=>{
  const f=fixture(t),r=await queued(f);await reconcilePeerV2(f.c,r.id,async()=>completion(r.id),f.host);const previous=f.store.payload(r.id);
  const next=options({contract:{...previous.contract,rework:1,supersedesJobId:r.id}});
  let release,entered;const gate=new Promise(resolve=>release=resolve),inside=new Promise(resolve=>entered=resolve);
  const transport=async(_c,m,p)=>{if(m==='hello'){entered();await gate;return hello();}returnreceipt(p.id);};
  const first=reworkPeerV2(f.c,r.id,next,transport,f.host);await inside;
  await assert.rejects(reworkPeerV2(f.c,r.id,next,transport,f.host));release();const child=await first;
  const repeated=await reworkPeerV2(f.c,r.id,next,async()=>(receipt(child.id)),f.host);
  assert.equal(repeated.id,child.id);assert.equal(f.store.list().length,2);
});

test('a receipt for different task bytes is never accepted',async t=>{
  const f=fixture(t),r=await submitPeerV2(f.c,options(),async(_c,m,p)=>m==='hello'?hello():{...receipt(p.id),inputHash:'f'.repeat(64)},f.host);
  assert.equal(r.accepted,false);assert.equal(f.store.state(r.id).coordinatorError,'local_handoff_or_check_failed');
});

test('changed context before dispatch has a durable terminal notice without a remote call',async t=>{
  const f=fixture(t),r=await submitPeerV2(f.c,options(),async()=>{throw Error('offline');},f.host);
  f.host.contextCurrent=async()=>({valid:false,reason:'changed'});let calls=0;
  await reconcilePeerV2(f.c,r.id,async()=>{calls++;throw Error('must not dispatch');},f.host);
  assert.equal(calls,0);assert.equal(f.store.state(r.id).state,'needs_review');
  const notice=f.events.find(e=>e.eventKind==='result');assert.ok(notice);assert.equal(notice.verification.status,'inconclusive');
  await reconcilePeerV2(f.c,r.id,async()=>{calls++;},f.host);assert.equal(calls,0);assert.equal(f.events.filter(e=>e.eventKind==='result').length,1);
});

test('reserved identity refuses changed notification intent or input bytes',async t=>{
  const f=fixture(t),request=options(),r=await submitPeerV2(f.c,request,async()=>{throw Error('offline');},f.host);
  await assert.rejects(submitPeerV2(f.c,{...request,notify:true},async()=>{},f.host,r.id));
  const bytes=Buffer.from('different input');
  await assert.rejects(submitPeerV2(f.c,{...request,inputs:[{name:'extra.txt',data:bytes.toString('base64'),sha256:sha256(bytes)}]},async()=>{},f.host,r.id));
});
