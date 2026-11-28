import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {JobStore,privateDirectory,atomicWrite,rpc,sha256} from './skoobi-peer-core.mjs';
import {PEER_CAPABILITIES} from './skoobi-peer-contract.mjs';
import {submitPeerV2,reconcilePeerV2,revisePeerV2,peerHostAdapters} from './skoobi-peer-v2.mjs';
import {executePeerJob} from './skoobi-peer-worker.mjs';
import {ensureMemoryStateSchema,mutateMemoryState} from '../../packages/core/dist/orchestrator/memory-state-store.js';
import {createPeerInboxPump,peerInboxPromptContext} from '../../packages/core/dist/orchestrator/peer-inbox.js';
import {createMessageRouter} from '../../packages/core/dist/orchestrator/outbound-router.js';
import {prepareArtifactAcceptanceHost} from '../../packages/core/dist/orchestrator/artifact-acceptance.js';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const stamp=()=>new Date().toISOString();

async function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'peer-full-path-')));fs.chmodSync(root,0o700);
  let db;t.after(()=>{db?.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=privateDirectory(path.join(root,'project'),true),storeRoot=privateDirectory(path.join(project,'store'),true);
  privateDirectory(path.join(project,'packages'),true);privateDirectory(path.join(project,'packages/core'),true);
  const codeParent=privateDirectory(path.join(project,'packages/core/dist'),true);
  // This fixture links only reviewed build output from the isolated checkout.
  // It never loads a live instance or copies private configuration/history.
  fs.symlinkSync(path.join(repository,'packages/core/dist/orchestrator'),path.join(codeParent,'orchestrator'),'dir');
  const dbFile=path.join(storeRoot,'messages.db');db=new Database(dbFile);fs.chmodSync(dbFile,0o600);
  ensureMemoryStateSchema(db);db.exec('CREATE TABLE registered_groups(jid TEXT PRIMARY KEY,folder TEXT,is_main INTEGER)');
  const bridgeRoot=privateDirectory(path.join(root,'bridge'),true),keyPath=path.join(root,'bridge-key');atomicWrite(keyPath,Buffer.alloc(32,7),true);
  const bridge={schema:1,root:bridgeRoot,projectRoot:project,ownerGroupFolder:'fixture_main',ownerJid:'tg:fixture-owner',identityId:'fixture-owner',tenantId:'fixture-tenant',networkId:'0'.repeat(24),signingKeyPath:keyPath};
  db.prepare('INSERT INTO registered_groups VALUES(?,?,1)').run(bridge.ownerJid,bridge.ownerGroupFolder);
  const configPath=path.join(root,'bridge.json');atomicWrite(configPath,bridge,true);
  const coordinator={schema:1,protocol:2,role:'coordinator',nodeId:'mini',networkId:bridge.networkId,ownerJid:bridge.ownerJid,ownerGroupFolder:bridge.ownerGroupFolder,projectRoot:project,stateRoot:privateDirectory(path.join(root,'coordinator'),true),bridgeConfigPath:configPath};
  const worker={schema:1,protocol:2,role:'worker',nodeId:'worker',networkId:bridge.networkId,ownerJid:bridge.ownerJid,model:'fixture-model',reasoningEffort:'high',allowGui:false,stateRoot:privateDirectory(path.join(root,'worker'),true),projectRoot:project};
  const calls=[],transport=async(_c,method,fields={})=>{
    calls.push({method,id:fields.id});
    // Deliberately synthetic handshake: this test covers the durable protocol,
    // not a real native model launch (covered by a separate native smoke).
    if(method==='hello')return{protocol:2,capabilities:PEER_CAPABILITIES,model:worker.model,effort:worker.reasoningEffort,runtime:{cliVerified:true,cliVersion:'0.166.0'},heartbeat:{updatedAt:stamp()},maintenance:{active:false},executionModes:['isolated']};
    return rpc(worker,{...fields,schema:2,networkId:worker.networkId,nodeId:worker.nodeId,ownerJid:worker.ownerJid,method});
  };
  const host=await peerHostAdapters(coordinator),mainStore=new JobStore(coordinator.stateRoot),remoteStore=new JobStore(worker.stateRoot);
  const sent=[],router=createMessageRouter([{name:'fixture',ownsJid:jid=>jid===bridge.ownerJid,isConnected:()=>true,sendMessage:async(jid,text)=>sent.push({jid,text}),sendDocument:async(jid,file)=>sent.push({jid,file})}]);
  const makePump=()=>createPeerInboxPump(bridge,{db,router,ownerAvailable:()=>true,notifyActive:()=>false});
  return{root,db,bridge,coordinator,worker,transport,calls,host,mainStore,remoteStore,sent,makePump};
}
function contract(bytes){return{schema:1,revision:1,parentTaskId:'fixture-parent',projectKey:null,source:{},goal:'Return the exact fixture JSON with a real local file',
  expectedOutputs:[{name:'result.json',kind:'document'}],acceptance:[{id:'exact-bytes',kind:'file_sha256',description:'Host independently checks the transferred file',outputName:'result.json',expected:sha256(bytes)}],
  execution:{mode:'isolated',timeoutMs:10000,expiresAt:new Date(Date.now()+3600000).toISOString(),maxOutputBytes:1024*1024,maxWorkspaceBytes:8*1024*1024,allowBattery:true,guiAuthorized:false},
  runtime:{model:'fixture-model',reasoningEffort:'high'},dependsOnParent:false};}
async function completeFixture(f,id,bytes,outputName='result.json'){
  const job=f.remoteStore.claim(id);assert.equal(job.state,'running');
  let calls=0;
  await executePeerJob(f.worker,f.remoteStore,job,{isolated:async({onProgress})=>{
    calls++;const outputRoot=privateDirectory(path.join(f.remoteStore.dir(id),'fixture-output'),true);
    atomicWrite(path.join(outputRoot,outputName),bytes,true);
    atomicWrite(path.join(outputRoot,'.peer-result.json'),{summary:'Fixture work complete',checks:[{id:'worker-claim',status:'reported_pass',detail:'This claim is not host evidence'}],changedObjects:['output/'+outputName],limitations:['Synthetic producer; no model or network'],memoryProposals:[]},true);
    onProgress({stage:'verifying',lastActivityAt:stamp(),nextStep:'save_result'});
    return{success:true,outputRoot,runtime:{cliVersion:'fixture-injected',requestedModel:'fixture-model',requestedEffort:'high',reportedModel:null,reportedEffort:null},isolation:{boundary:'synthetic_fixture_only',containmentPassed:false}};
  }});
  assert.equal(calls,1);assert.equal(f.remoteStore.state(id).state,'succeeded');
}

test('actual coordinator → RPC/store → worker result → host check → signed main inbox → no-notify receipt → remote ACK',async t=>{
  const f=await fixture(t),bytes=Buffer.from('{"ok":true}\n');
  const submitted=await submitPeerV2(f.coordinator,{title:'Synthetic end-to-end task',prompt:'Create only the declared synthetic file',notify:false,inputs:[],contract:contract(bytes)},f.transport,f.host);
  assert.equal(submitted.accepted,true);assert.equal(f.mainStore.list().length,1);assert.equal(f.remoteStore.list().length,1);
  await completeFixture(f,submitted.id,bytes);
  await reconcilePeerV2(f.coordinator,submitted.id,f.transport,f.host);
  let state=f.mainStore.state(submitted.id);assert.equal(state.assessment.status,'passed');assert.equal(state.localArtifacts.length,1);
  assert.deepEqual(fs.readFileSync(state.localArtifacts[0].localPath),bytes);
  await f.makePump()();assert.equal(f.sent.length,0);
  await reconcilePeerV2(f.coordinator,submitted.id,f.transport,f.host);
  state=f.mainStore.state(submitted.id);assert.equal(state.deliveryReceipt.delivery,'disabled');assert.equal(state.deliveryReceipt.contextState,'current');
  assert.equal(state.remoteResultAcknowledged.disposition,'archived');
  assert.equal(f.remoteStore.state(submitted.id).resultAcknowledgement.disposition,'archived');
  assert.match(peerInboxPromptContext(f.db,f.bridge.ownerJid,f.bridge),/Fixture work complete/);
  const submits=f.calls.filter(call=>call.method==='submit').length,acks=f.calls.filter(call=>call.method==='ack_result').length;
  await f.makePump()();await reconcilePeerV2(f.coordinator,submitted.id,f.transport,f.host);
  assert.equal(f.calls.filter(call=>call.method==='submit').length,submits);assert.equal(f.calls.filter(call=>call.method==='ack_result').length,acks);
  assert.equal(f.mainStore.list().length,1);assert.equal(f.remoteStore.list().length,1);assert.equal(f.sent.length,0);
});

test('a canonical correction after host assessment prevents queued result disclosure and remote archival ACK',async t=>{
  const f=await fixture(t),bytes=Buffer.from('{"ok":true}\n');
  const submitted=await submitPeerV2(f.coordinator,{title:'Synthetic stale task',prompt:'Create only the declared synthetic file',notify:true,inputs:[],contract:contract(bytes)},f.transport,f.host);
  await completeFixture(f,submitted.id,bytes);await reconcilePeerV2(f.coordinator,submitted.id,f.transport,f.host);
  mutateMemoryState(f.db,{chatJid:f.bridge.ownerJid,identityId:f.bridge.identityId,tenantId:f.bridge.tenantId},{kind:'fact_upsert',key:'constraint',projectKey:null,value:'Use the newly corrected requirement',operationId:'fixture-correction',expectedRevision:0},
    {kind:'direct_user',at:stamp(),messageId:'fixture-source',quote:'Use the newly corrected requirement',explicitRemember:true,currentDirectInput:true});
  await f.makePump()();await reconcilePeerV2(f.coordinator,submitted.id,f.transport,f.host);
  assert.equal(f.sent.length,0);const state=f.mainStore.state(submitted.id);
  assert.equal(state.deliveryReceipt.contextState,'stale');assert.equal(state.remoteResultAcknowledged,undefined);
  assert.match(peerInboxPromptContext(f.db,f.bridge.ownerJid,f.bridge),/context_stale/);
  assert.doesNotMatch(peerInboxPromptContext(f.db,f.bridge.ownerJid,f.bridge),/Fixture work complete/);
});

test('a worker success claim with the wrong exact bytes fails host acceptance and never sends its artifact',async t=>{
  const f=await fixture(t),expected=Buffer.from('{"ok":true}\n');
  const submitted=await submitPeerV2(f.coordinator,{title:'Synthetic wrong result',prompt:'Create only the declared synthetic file',notify:true,inputs:[],contract:contract(expected)},f.transport,f.host);
  await completeFixture(f,submitted.id,Buffer.from('{"ok":false}\n'));await reconcilePeerV2(f.coordinator,submitted.id,f.transport,f.host);await f.makePump()();
  const state=f.mainStore.state(submitted.id);assert.equal(state.assessment.status,'failed');
  assert.equal(f.sent.filter(item=>item.file).length,0);assert.ok(f.sent.some(item=>item.text?.includes('Результат требует исправления')));
  assert.equal(state.remoteResultAcknowledged,undefined);
});

test('actual transferred browser archive passes an independent isolated browser check before inbox archival ACK',{skip:process.platform!=='darwin',timeout:60000},async t=>{
  const f=await fixture(t),fixtureRoot=path.join(repository,'evals/task-continuity/artifact-acceptance'),zip=path.join(f.root,'fixture.zip');
  execFileSync('/usr/bin/python3',[path.join(fixtureRoot,'create-fixture.py'),'good',zip]);
  const bytes=fs.readFileSync(zip),scenario=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'requirements.json'),'utf8'));
  // A fresh, uniquely addressed protected host installation; never reuse a live
  // instance's key/checker directory and remove only this fixture's directory.
  const checkerHost=prepareArtifactAcceptanceHost(f.coordinator.projectRoot,path.join(repository,'scripts/artifact-acceptance-checker.mjs'));
  t.after(()=>fs.rmSync(checkerHost.stateDir,{recursive:true,force:true}));
  const requirements={...contract(bytes),expectedOutputs:[{name:'result.zip',kind:'document'}],acceptance:[{id:'browser-route',kind:'artifact',description:'Open archive and execute the declared browser interactions',outputName:'result.zip',scenario}]};
  const submitted=await submitPeerV2(f.coordinator,{title:'Synthetic browser result',prompt:'Return only the supplied local fixture archive',notify:false,inputs:[],contract:requirements},f.transport,f.host);
  await completeFixture(f,submitted.id,bytes,'result.zip');
  await reconcilePeerV2(f.coordinator,submitted.id,f.transport,f.host);
  const state=f.mainStore.state(submitted.id),check=state.assessment.checks.find(item=>item.id==='browser-route');
  assert.equal(state.assessment.status,'passed',JSON.stringify(check));
  assert.equal(check.evidence.kind,'local_recheck');
  assert.equal(check.evidence.artifactSha256,sha256(bytes));
  assert.equal(check.evidence.originalProducerIsolation,'not_attested_by_this_check');
  await f.makePump()();await reconcilePeerV2(f.coordinator,submitted.id,f.transport,f.host);
  assert.equal(f.mainStore.state(submitted.id).remoteResultAcknowledged.disposition,'archived');assert.equal(f.sent.length,0);
});

test('a corrected queued revision replaces revoked context and completes under the new canonical scope',async t=>{
  const f=await fixture(t),bytes=Buffer.from('{"ok":true}\n');
  const submitted=await submitPeerV2(f.coordinator,{title:'Synthetic queued correction',prompt:'Produce the declared file',notify:false,inputs:[],contract:contract(bytes)},f.transport,f.host);
  mutateMemoryState(f.db,{chatJid:f.bridge.ownerJid,identityId:f.bridge.identityId,tenantId:f.bridge.tenantId},{kind:'fact_upsert',key:'constraint',projectKey:null,value:'Apply the corrected requirement',operationId:'fixture-revision',expectedRevision:0},
    {kind:'direct_user',at:stamp(),messageId:'fixture-corrected',quote:'Apply the corrected requirement',explicitRemember:true,currentDirectInput:true});
  const previous=f.mainStore.payload(submitted.id);
  const revised=await revisePeerV2(f.coordinator,submitted.id,{contract:{...previous.contract,revision:2},prompt:'Produce the file under the corrected requirement'},f.transport,f.host);
  assert.equal(revised.revision,2);assert.equal(f.mainStore.state(submitted.id).contextInvalidated,null);
  assert.equal(f.remoteStore.state(submitted.id).revision,2);assert.equal(f.remoteStore.contextRevoked(submitted.id),false);
  await completeFixture(f,submitted.id,bytes);await reconcilePeerV2(f.coordinator,submitted.id,f.transport,f.host);
  assert.equal(f.mainStore.state(submitted.id).assessment.status,'passed');
  await f.makePump()();await reconcilePeerV2(f.coordinator,submitted.id,f.transport,f.host);
  assert.equal(f.mainStore.state(submitted.id).remoteResultAcknowledged.revision,2);assert.equal(f.sent.length,0);
});
