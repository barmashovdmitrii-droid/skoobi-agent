import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {JobStore,atomicWrite,privateDirectory,privateRead,privateJson,loadConfig,readRpc,rpc,captureArtifact,now,acquireProcessLock,acquireFileLock,readMaintenanceGate,readGuiSlot,inspectPeerRuntime,terminalStates,validatePeerContext} from './skoobi-peer-core.mjs';
import {executeIsolatedPeerTask,powerState,guiAvailability,screenAvailability,boundedWorkspaceUsage,recordExecutionProcess,recordExecutionStopped,reapInterruptedExecutions} from './skoobi-peer-runtime.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/** Keeps the deployed runner-error fix: a later success frame cannot erase an error. */
export function createWorkerOutputState(){
  let failure=null,stats=null;
  return{
    observe(output){if(output.codexTurn)stats=output.codexTurn;if(output.status==='error')failure=String(output.error||'runner_reported_error').slice(0,4000);},
    finish(result,latest,cancelled=false){const success=result.status==='success'&&!failure&&(latest.deliveries.length>0||latest.artifacts.length>0);return{state:cancelled?'cancelled':success?'succeeded':'failed',error:success||cancelled?null:failure||String(result.error||'no_deliverable').slice(0,4000),stats:result.codexTurn||stats};},
  };
}

function boundedResult(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.summary!=='string'||input.summary.length>60000)throw Error('invalid_result_envelope');
  for(const key of ['changedObjects','limitations'])if(input[key]!==undefined&&(!Array.isArray(input[key])||input[key].length>50||input[key].some(v=>typeof v!=='string'||v.length>2000)))throw Error('invalid_result_envelope');
  if(input.checks!==undefined&&(!Array.isArray(input.checks)||input.checks.length>30||input.checks.some(v=>!v||typeof v.id!=='string'||v.id.length>64||!['reported_pass','reported_fail','not_checked'].includes(v.status)||typeof v.detail!=='string'||v.detail.length>4000)))throw Error('invalid_result_checks');
  if(input.memoryProposals!==undefined&&(!Array.isArray(input.memoryProposals)||Buffer.byteLength(JSON.stringify(input.memoryProposals))>16000))throw Error('invalid_memory_proposals');
  return{summary:input.summary,checks:input.checks||[],changedObjects:input.changedObjects||[],limitations:input.limitations||[],memoryProposals:input.memoryProposals||[]};
}

export function collectPeerResult(store,job,payload,execution){
  const root=execution.outputRoot;privateDirectory(root);
  if(boundedWorkspaceUsage(root,10000,{strict:true}).bytes>payload.contract.execution.maxOutputBytes)throw Error('output_size_limit');
  const requestFile=path.join(root,'.peer-context-request.json');
  if(fs.existsSync(requestFile)){
    const r=JSON.parse(privateRead(requestFile,12000));
    if(!r||typeof r.query!=='string'||r.query.length>1000||typeof r.reason!=='string'||r.reason.length>1000||!Array.isArray(r.recordKeys)||r.recordKeys.length>10||r.recordKeys.some(k=>typeof k!=='string'||k.length>200))throw Error('invalid_context_request');
    return{contextRequest:{query:r.query,reason:r.reason,recordKeys:r.recordKeys},artifacts:[],result:null};
  }
  const resultFile=path.join(root,'.peer-result.json');
  const result=fs.existsSync(resultFile)?boundedResult(JSON.parse(privateRead(resultFile,256*1024))):boundedResult({summary:execution.summary||'',limitations:['Worker did not provide a structured verification report.']});
  const artifacts=[];
  for(const expected of payload.contract.expectedOutputs){
    const filename=path.join(root,expected.name);if(!fs.existsSync(filename))continue;
    const s=fs.lstatSync(filename);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>payload.contract.execution.maxOutputBytes)throw Error('invalid_output_file');
    artifacts.push(captureArtifact(store,job.id,filename,expected.kind==='photo'?'photo':'document',''));
  }
  return{artifacts,result:{...result,revision:job.revision,contextSha256:payload.context.sha256,runtime:execution.runtime,isolation:execution.isolation||{boundary:'owner_authorized_gui',containmentPassed:false},resourcePolicy:execution.resourcePolicy||null,workerClaimsOnly:true}};
}

function collectPartialResult(store,job,payload,execution){
  const artifacts=[];let bytes=0;
  if(execution.outputRoot)for(const expected of payload.contract.expectedOutputs){
    try{
      privateDirectory(execution.outputRoot);const filename=path.join(execution.outputRoot,expected.name),s=fs.lstatSync(filename);
      if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||bytes+s.size>payload.contract.execution.maxOutputBytes)continue;
      const artifact=captureArtifact(store,job.id,filename,expected.kind==='photo'?'photo':'document','');bytes+=artifact.bytes;artifacts.push(artifact);
    }catch{/* Preserve readable declared files, never guess an unsafe path. */}
  }
  return{artifacts,result:{revision:job.revision,contextSha256:payload.context.sha256,summary:String(execution.summary||'').slice(0,60000),checks:[],changedObjects:[],limitations:['Execution did not finish successfully. Retained files may be partial; external effects were not rolled back.'],memoryProposals:[],runtime:execution.runtime||null,isolation:execution.isolation||null,partial:true,workerClaimsOnly:true}};
}

async function createGuiExecutor(c,store){
  const from=rel=>import(pathToFileURL(path.join(c.projectRoot,rel)));
  const {initDatabase,setRegisteredGroup}=await from('dist/orchestrator/db.js');
  const {runSandboxAgent}=await from('dist/runtimes/sandbox-runner.js');
  const {writeTasksSnapshot,writeGroupsSnapshot}=await from('dist/runtimes/container-runner.js');
  const {startIpcWatcher}=await from('dist/orchestrator/ipc.js');
  const {killProcessTree}=await from('dist/orchestrator/process-tree.js');
  initDatabase();let current=null;
  const scoped=jid=>{if(!current||jid!==current.jid)throw Error('delegated_delivery_scope_mismatch');return current;};
  const text=(jid,value)=>{const j=scoped(jid);if(typeof value!=='string'||value.length>60000)throw Error('reply_size_limit');if(!j.deliveries.some(d=>d.text===value))j.deliveries.push({kind:'text',text:value,at:now()});};
  const file=(jid,source,caption,kind)=>{
    const j=scoped(jid),resolved=fs.realpathSync(source);
    if(!resolved.startsWith(j.groupRoot+path.sep))throw Error('gui_artifact_outside_task_workspace');
    const a=captureArtifact(store,j.id,resolved,kind,caption);if(!j.artifacts.some(x=>x.name===a.name))j.artifacts.push(a);
  };
  startIpcWatcher({router:{async send(jid,t){text(jid,t);},async route(e){text(e.chatJid,e.text);return e.text;},async sendPhoto(jid,f,cap){file(jid,f,cap,'photo');return true;},async sendDocument(jid,f,cap){file(jid,f,cap,'document');return true;},async sendVoice(jid,t){text(jid,t);return true;},addPreHook(){},addPostHook(){}},registeredGroups:()=>current?{[current.jid]:current.group}:{},registerGroup(){throw Error('delegation_cannot_register_chat');},async syncGroups(){},getAvailableGroups:()=>[],writeGroupsSnapshot(){},calendarAdapter:null});
  return async({job,payload,signal,onProgress})=>{
    if(current)throw Error('gui_executor_busy');
    const ready=guiAvailability(c,job);if(!ready.available)throw Error(ready.reason);
    const runtime=inspectPeerRuntime(c);if(!runtime.cliVerified)throw Error('runtime_not_verified');
    const folder='peer_'+job.id.replaceAll('-',''),groupRoot=path.join(c.projectRoot,'groups',folder),jid='peer:'+job.id;
    privateDirectory(groupRoot,true);const inputs=privateDirectory(path.join(groupRoot,'received'),true),output=privateDirectory(path.join(groupRoot,'output'),true);
    atomicWrite(path.join(inputs,'context.json'),payload.context,true);atomicWrite(path.join(inputs,'task.json'),{prompt:payload.prompt,contract:payload.contract},true);
    for(const f of payload.inputs)atomicWrite(path.join(inputs,f.name),Buffer.from(f.data,'base64'),true);
    const disallowedTools=['memory_save','memory_forget','memory_state','schedule_task','update_task','pause_task','resume_task','cancel_task','cleanup_tasks','register_group','request_task_operation'];
    const agentConfig={fullAccess:true,noSandbox:true,disallowedTools,systemPrompt:'You are a delegated executor, not a direct conversation with the owner. Complete only received/task.json with received/context.json. Do not change credentials, launch services, schedules or canonical memory; do not send externally. The owner has explicitly authorized GUI use for this task only. Work in this task workspace, put declared files and .peer-result.json in output/. Report changed external objects and all uncertainty. If context is missing, write output/.peer-context-request.json {query:string,recordKeys:string[],reason:string}, report completed external actions, and stop. Do not guess or automatically repeat actions; the host requires review before a separate continuation task. A stop interrupts execution, not already completed external actions.'};
    const group={name:'Delegated GUI executor',folder,trigger:'@Skoobi',added_at:now(),isMain:true,requiresTrigger:false,runtime:'sandbox',agentConfig};
    setRegisteredGroup(jid,group);writeTasksSnapshot(folder,true,[]);writeGroupsSnapshot(folder,true,[],new Set([jid]));
    current={id:job.id,jid,group,groupRoot,deliveries:[],artifacts:[],proc:null};
    let interrupted=false,stopReason=null,completionObserved=false,releaseScreen=()=>{};
    const stop=reason=>{if(interrupted)return;interrupted=true;stopReason=completionObserved?'completion_stop_race':reason;if(current?.proc)killProcessTree(current.proc,'SIGKILL');};
    const abort=()=>stop(String(signal.reason||'cancel_requested'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    const monitor=setInterval(()=>{try{if(!screenAvailability())stop('screen_locked_or_unavailable');else if(boundedWorkspaceUsage(groupRoot).bytes>payload.contract.execution.maxWorkspaceBytes)stop('workspace_size_limit');}catch{stop('gui_workspace_policy_violation');}},2000);
    const observed=createWorkerOutputState();
    try{
      releaseScreen=acquireFileLock(c.stateRoot,'gui-screen');
      if(signal.aborted)throw Error(String(signal.reason||'cancel_requested'));
      const result=await runSandboxAgent(group,{prompt:'Read received/task.json and received/context.json. Execute only this delegated task; return declared files under output/ and output/.peer-result.json with summary,checks,changedObjects,limitations,memoryProposals. When context is missing, write output/.peer-context-request.json {query,recordKeys,reason}, report actions already completed, and stop for host review. No direct user messaging.',groupFolder:folder,chatJid:jid,isMain:true,assistantName:'Skoobi',agentConfig,credentialProxyTier:'owner',provider:'codex_cli',emitProgressMessages:true,codex:{command:c.codexCommand,model:payload.contract.runtime.model,fallbackModel:payload.contract.runtime.model,reasoningEffort:payload.contract.runtime.reasoningEffort,webSearchEnabled:true,timeoutMs:payload.contract.execution.timeoutMs,inactivityTimeoutMs:300000,inactivityInFlightTimeoutMs:900000}},proc=>{current.proc=proc;recordExecutionProcess(store,job.id,proc);if(signal.aborted)abort();},async event=>{
        observed.observe(event);
        if(event.toolObservation)onProgress({stage:event.toolObservation.phase==='started'?'tool_started':'tool_finished',lastActivityAt:now(),toolFamily:event.toolObservation.family,outcome:event.toolObservation.outcome||'unknown',nextStep:'execute_task'});
        if(event.progressText)onProgress({stage:'working',message:String(event.progressText).slice(0,1000),lastActivityAt:now(),nextStep:'execute_task'});
        if(event.status==='success'&&event.result){completionObserved=true;text(jid,event.result);}
        if(event.status==='success'){const close=path.join(c.projectRoot,'data/ipc',folder,'input/_close');try{fs.writeFileSync(close,'',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}}
      });
      if(result.result)text(jid,result.result);
      if(current.proc)killProcessTree(current.proc,'SIGKILL');recordExecutionStopped(store,job.id);
      await reapInterruptedExecutions(store);
      const outcome=observed.finish(result,current,false);
      let terminationConfirmed=false;if(interrupted&&current.proc?.pid){try{process.kill(-current.proc.pid,0);}catch(e){terminationConfirmed=e.code==='ESRCH';}}
      return{success:outcome.state==='succeeded'&&!interrupted,summary:current.deliveries.map(d=>d.text).join('\n\n'),error:interrupted?stopReason:outcome.error,interrupted,terminationConfirmed,processFinishedAt:now(),outputRoot:output,runtime:{...runtime,requestedModel:payload.contract.runtime.model,requestedEffort:payload.contract.runtime.reasoningEffort,reportedModel:outcome.stats?.model||null,reportedEffort:outcome.stats?.reasoningEffort||null},isolation:{boundary:'owner_authorized_gui',containmentPassed:false},capturedArtifacts:current.artifacts};
    }finally{clearInterval(monitor);signal.removeEventListener('abort',abort);current=null;releaseScreen();}
  };
}

export async function executePeerJob(c,store,job,{isolated=executeIsolatedPeerTask,gui,onHeartbeat=()=>{},nowMs=()=>Date.now(),shouldStop=()=>false}={}){
  const payload=store.payload(job.id),abort=new AbortController();let finished=false;
  const progress=value=>{if(finished)return;try{store.update(job.id,{progress:value,lastProgressAt:now()});}catch{abort.abort('state_write_failed');}};
  const stopReason=()=>{
    if(shouldStop())return'worker_shutdown';
    const state=store.state(job.id);
    if(store.wantsCancel(job.id))return'cancel_requested';
    if(state.pendingRevision)return'revision_pending';
    if(store.contextRevoked(job.id))return'context_revoked';
    if(Date.parse(payload.context.expiresAt)<=nowMs())return'context_expired';
    if(Date.parse(payload.contract.execution.expiresAt)<=nowMs())return'task_expired';
    if(payload.contract.execution.mode==='gui'&&fs.existsSync(path.join(c.stateRoot,'gui-paused')))return'gui_paused_by_owner';
    if(payload.contract.execution.mode==='gui'&&!readGuiSlot(c,job.id,job.revision).available)return'gui_slot_expired';
    return null;
  };
  const timer=setInterval(()=>{try{const reason=stopReason();if(reason)abort.abort(reason);onHeartbeat();}catch{abort.abort('state_unavailable');}},500);
  try{
    validatePeerContext(payload.context,{id:job.id,contract:payload.contract,fresh:true});
    const initial=stopReason();if(initial)abort.abort(initial);
    if(!payload.contract.execution.allowBattery&&powerState()!=='ac')throw Error('ac_power_required');
    const execute=payload.contract.execution.mode==='gui'?gui:isolated;if(!execute)throw Error('gui_adapter_unavailable');
    const execution=await execute({c,store,job,payload,signal:abort.signal,onProgress:progress});
    finished=true;
    if(execution.interrupted){
      const cancelled=execution.error==='cancel_requested'&&execution.terminationConfirmed===true;
      return store.update(job.id,{...collectPartialResult(store,job,payload,execution),state:cancelled?'cancelled':'needs_review',cancellationConfirmed:cancelled,error:execution.error||'interrupted',finishedAt:now(),execution:execution.runtime,revisionStatus:execution.error==='revision_pending'?'interrupted_requires_review':undefined});
    }
    if(store.contextRevoked(job.id)||store.state(job.id).pendingRevision||Date.parse(payload.context.expiresAt)<=nowMs())return store.update(job.id,{...collectPartialResult(store,job,payload,execution),state:'needs_review',error:'context_or_revision_changed',finishedAt:now()});
    if(!execution.success)return store.update(job.id,{...collectPartialResult(store,job,payload,execution),state:'failed',error:execution.error||'execution_failed',finishedAt:now(),execution:execution.runtime});
    const collected=collectPeerResult(store,job,payload,execution);
    if(collected.contextRequest)return store.update(job.id,{...collectPartialResult(store,job,payload,execution),state:'needs_review',error:'waiting_context',contextRequest:collected.contextRequest,finishedAt:now()});
    return store.update(job.id,{state:'succeeded',result:collected.result,artifacts:collected.artifacts,deliveries:collected.result.summary?[{kind:'text',text:collected.result.summary,at:now()}]:[],execution:execution.runtime,finishedAt:now(),completedRevision:job.revision,cancelRequested:store.wantsCancel(job.id),cancellationConfirmed:false,progress:{stage:'result_prepared',lastActivityAt:now(),nextStep:'coordinator_verification'}});
  }catch(error){
    const reason=typeof error?.message==='string'&&/^[a-z_]+$/.test(error.message)?error.message:'worker_execution_failed';
    return store.update(job.id,{state:'needs_review',error:reason,finishedAt:now(),progress:{stage:'blocked',lastActivityAt:now(),blockedReason:reason,nextStep:'coordinator_review'}});
  }finally{finished=true;clearInterval(timer);}
}

export function choosePeerJob(c,store,{power=powerState,gui=guiAvailability,nowMs=Date.now()}={}){
  let observedPower;
  for(const queued of store.list().filter(s=>s.schema===2&&s.state==='queued')){
    let payload;
    try{payload=store.payload(queued.id);}catch{store.update(queued.id,{state:'needs_review',error:'corrupt_task_payload',finishedAt:now()});continue;}
    // Cancellation and expiry must not wait for a plugged-in/unlocked laptop.
    if(store.wantsCancel(queued.id)||Date.parse(payload.contract.execution.expiresAt)<=nowMs||Date.parse(payload.context.expiresAt)<=nowMs)return{queued,payload};
    let blocked=null;
    if(!payload.contract.execution.allowBattery){observedPower??=power();if(observedPower!=='ac')blocked='ac_power_required';}
    if(!blocked&&payload.contract.execution.mode==='gui'){const available=gui(c,queued);if(!available.available)blocked=available.reason;}
    if(!blocked)return{queued,payload};
    if(queued.progress?.blockedReason!==blocked)store.update(queued.id,{progress:{stage:'waiting',lastActivityAt:now(),blockedReason:blocked,nextStep:'await_local_availability'}});
  }return null;
}

function pruneWorkerGroups(c,store){
  for(const s of store.list()){
    if(s.schema!==2||!s.contentPrunedAt||s.workerWorkspacePrunedAt)continue;
    try{const folder='peer_'+s.id.replaceAll('-','');
    for(const parent of [path.join(c.projectRoot,'groups'),path.join(c.projectRoot,'data/ipc'),path.join(c.projectRoot,'data/sessions'),path.join(c.projectRoot,'data/runtime-logs')]){
      const dir=path.join(parent,folder);if(!fs.existsSync(dir))continue;
      privateDirectory(dir);fs.rmSync(dir,{recursive:true});
    }
    store.update(s.id,{workerWorkspacePrunedAt:now()});
    }catch{store.retentionWarnings=[...(store.retentionWarnings||[]),s.id];}
  }
}

export async function runWorker(c){
  if(c.role!=='worker'||process.versions.node.split('.')[0]!=='22')throw Error('Native Node 22 worker required');
  c={...c,protocol:2};process.chdir(c.projectRoot);process.umask(0o077);process.env.CLAUDECLAW_ENV_FILE=path.join(c.projectRoot,'.env');
  const store=new JobStore(c.stateRoot),release=acquireProcessLock(c.stateRoot,'worker');
  let stopping=false,current=null,gui=null,activePromise=null,lastRetention=0;
  await reapInterruptedExecutions(store);
  // Remove credential copies left by a hard-killed isolated model launch.
  for(const old of store.list()){
    const home=path.join(store.dir(old.id),'workspace/home/.codex');
    if(fs.existsSync(home)){privateDirectory(home);const auth=path.join(home,'auth.json');if(fs.existsSync(auth)){privateRead(auth,128*1024);fs.unlinkSync(auth);}}
  }
  store.recover({v2Only:true});
  const heartbeat=()=>atomicWrite(path.join(c.stateRoot,'heartbeat.json'),{schema:2,protocol:2,nodeId:c.nodeId,pid:process.pid,updatedAt:now(),currentJobId:current?.id||null,currentRevision:current?.revision||null,model:c.model,effort:c.reasoningEffort,telegramPolling:false,maintenance:readMaintenanceGate(c.stateRoot),corruptJobs:store.corruptJobs.length,retentionWarnings:store.retentionWarnings?.length||0});
  const stop=()=>{stopping=true;if(current){try{store.update(current.id,{shutdownRequestedAt:now()});}catch{}}};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);const ticker=setInterval(heartbeat,2000);heartbeat();
  try{
    while(!stopping){
      if(readMaintenanceGate(c.stateRoot).active){await sleep(500);continue;}
      if(Date.now()-lastRetention>1800000){store.pruneAcknowledged({retentionDays:c.retentionDays||30});pruneWorkerGroups(c,store);lastRetention=Date.now();}
      const selected=choosePeerJob(c,store);if(!selected){await sleep(1000);continue;}
      const {queued,payload}=selected;
      const claimed=store.claim(queued.id);if(!claimed||claimed.state!=='running')continue;
      current=claimed;heartbeat();
      if(payload.contract.execution.mode==='gui'&&!gui)gui=await createGuiExecutor(c,store);
      activePromise=executePeerJob(c,store,claimed,{gui,onHeartbeat:heartbeat,shouldStop:()=>stopping});await activePromise;activePromise=null;current=null;heartbeat();
    }
  }finally{await activePromise;clearInterval(ticker);heartbeat();release();process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}

export async function main(argv=process.argv.slice(2)){
  const [command,flag,file,...extra]=argv;
  if(!['rpc','worker'].includes(command)||flag!=='--config'||!file||extra.length)throw Error('Usage: skoobi-peer-worker.mjs rpc|worker --config <private-file>');
  const c={...loadConfig(file),protocol:2};if(c.role!=='worker')throw Error('Worker role required');
  if(command==='rpc'){
    if(process.env.SSH_ORIGINAL_COMMAND&&process.env.SSH_ORIGINAL_COMMAND!=='skoobi-peer-rpc')throw Error('Unexpected SSH operation');
    const request=await readRpc(process.stdin);process.stdout.write(JSON.stringify({ok:true,value:rpc(c,request)})+'\n');
  }else await runWorker(c);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Peer operation failed; inspect private job state and runtime configuration.');process.exitCode=1;});
