import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PEER_PROTOCOL,PEER_CAPABILITIES,canonicalJson,contentHash,validatePeerContract,validatePeerContext} from './skoobi-peer-contract.mjs';
export {PEER_PROTOCOL,PEER_CAPABILITIES,canonicalJson,contentHash,validatePeerContract,validatePeerContext};

export const MAX_RPC_BYTES = 24 * 1024 * 1024;
export const MAX_CONTEXT_BYTES = 16 * 1024 * 1024;
export const terminalStates = new Set(['succeeded', 'failed', 'cancelled', 'needs_review']);
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function assertJobId(id) { if (typeof id !== 'string' || !uuid.test(id)) throw Error('Invalid job identity'); return id; }

export function privateDirectory(dir, create = false) {
  if (create && !fs.existsSync(dir)) fs.mkdirSync(dir, {mode: 0o700});
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o077 || fs.realpathSync(dir) !== dir) throw Error('Unsafe peer directory');
  return dir;
}

export function privateRead(file, max = MAX_RPC_BYTES) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || s.mode & 0o077 || s.size > max) throw Error('Unsafe peer file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
export function privateJson(file) { return JSON.parse(privateRead(file)); }

export function atomicWrite(file, value, exclusive = false) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  privateDirectory(path.dirname(file));
  if (exclusive) {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } else {
    if (fs.existsSync(file)) privateRead(file);
    const tmp = file + '.new-' + crypto.randomBytes(8).toString('hex');
    try { atomicWrite(tmp, data, true); fs.renameSync(tmp, file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  const fd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function loadConfig(file) {
  if (!path.isAbsolute(file)) throw Error('Absolute peer configuration path required');
  const c = privateJson(file);
  if (c.schema !== 1 || !['coordinator', 'worker'].includes(c.role) || !/^[a-f0-9]{24}$/.test(c.networkId || '') || !/^[a-z][a-z0-9-]{0,31}$/.test(c.nodeId || '') || !/^tg:[1-9]\d{4,15}$/.test(c.ownerJid || '') || c.ownerGroupFolder !== 'telegram_main') throw Error('Unexpected peer configuration identity');
  for (const name of ['projectRoot', 'stateRoot']) if (!path.isAbsolute(c[name] || '') || /[\0\r\n]/.test(c[name])) throw Error('Invalid peer root');
  if (fs.realpathSync(c.projectRoot) !== c.projectRoot) throw Error('Peer code root is not canonical');
  privateDirectory(c.stateRoot);
  return c;
}

export function processStartToken(pid){
  if(!Number.isSafeInteger(pid)||pid<2)throw Error('Invalid process identity');
  const r=spawnSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:3000});
  return r.status===0?r.stdout.trim():null;
}
export function acquireProcessLock(root,name){
  privateDirectory(root);if(!/^[a-z-]+$/.test(name))throw Error('Invalid process lock');
  const release=acquireFileLock(root,name+'-singleton');
  // Refuse coexistence with a pre-v2 daemon. A stale/ownerless legacy directory
  // is removed only under the new kernel lock; it is never the lock authority.
  const dir=path.join(root,name+'.lock'),owner={pid:process.pid,startToken:processStartToken(process.pid)};
  try{
    if(!owner.startToken)throw Error('Process identity unavailable');
    if(fs.existsSync(dir)){
      privateDirectory(dir);let old=null;
      try{old=privateJson(path.join(dir,'owner.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
      if(old?.startToken&&processStartToken(old.pid)===old.startToken)throw Error('Peer process is already running');
      fs.rmSync(dir,{recursive:true});
    }
    // Keep a legacy-visible owner record while v1 and v2 installers coexist.
    privateDirectory(dir,true);atomicWrite(path.join(dir,'owner.json'),owner,true);
    return()=>{try{const current=privateJson(path.join(dir,'owner.json'));if(current.pid===owner.pid&&current.startToken===owner.startToken)fs.rmSync(dir,{recursive:true});}finally{release();}};
  }catch(e){release();throw e;}
}

/** Persistent inode + OS lock; never unlink the guard after normal exit/crash. */
export function acquireFileLock(root,name,{waitSeconds=0}={}){
  privateDirectory(root);if(!/^[a-z-]+$/.test(name))throw Error('Invalid lock name');
  if(!Number.isInteger(waitSeconds)||waitSeconds<0||waitSeconds>3)throw Error('Invalid lock wait');
  const fd=fs.openSync(path.join(root,name+'.guard'),fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);
  try{
    const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||s.nlink!==1||s.mode&0o077)throw Error('Unsafe peer lock');
    const darwin=process.platform==='darwin';
    const r=spawnSync(darwin?'/usr/bin/lockf':'/usr/bin/flock',darwin?['-s','-t',String(waitSeconds),'3']:waitSeconds?['-w',String(waitSeconds),'3']:['-n','3'],{stdio:['ignore','ignore','pipe',fd],timeout:(waitSeconds+3)*1000});
    if(r.status!==0){const e=Error('Peer process is already running');e.code=(r.status===75||r.status===1)?'PEER_BUSY':'PEER_LOCK_ERROR';throw e;}
    return()=>fs.closeSync(fd);
  }catch(e){fs.closeSync(fd);throw e;}
}

export function contextPath(name) {
  if (typeof name !== 'string' || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name) || name.split('/').some(x => !x || x === '.' || x === '..')) throw Error('Invalid memory replica path');
  if (!['CLAUDE.md', 'AGENTS.md'].includes(name) && !/^memory\/(?:[^/]+\/)*[^/]+\.md$/.test(name)) throw Error('Only owner instructions and memory notes may be refreshed');
  return name;
}

export function validateSnapshot(input) {
  if (!input || !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 1000) throw Error('Invalid owner context snapshot');
  let bytes = 0; const names = new Set();
  const files = input.files.map(f => {
    contextPath(f.path);
    if (names.has(f.path) || typeof f.data !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256 || '')) throw Error('Ambiguous context file');
    names.add(f.path);
    const data = Buffer.from(f.data, 'base64'); bytes += data.length;
    if (data.toString('base64') !== f.data || data.length > 4 * 1024 * 1024 || bytes > MAX_CONTEXT_BYTES || sha256(data) !== f.sha256) throw Error('Context snapshot checksum or size mismatch');
    return {path: f.path, sha256: f.sha256, data: f.data};
  }).sort((a,b) => a.path.localeCompare(b.path));
  if (!names.has('CLAUDE.md') || !input.agentConfig || typeof input.agentConfig !== 'object' || Array.isArray(input.agentConfig) || input.agentConfig.fullAccess !== true || input.agentConfig.noSandbox !== true) throw Error('Owner execution profile is missing');
  if (JSON.stringify(input.agentConfig).length > 256 * 1024) throw Error('Owner profile is too large');
  const provenancePublicKey = input.provenancePublicKey || '';
  if (provenancePublicKey && (!provenancePublicKey.startsWith('-----BEGIN PUBLIC KEY-----') || provenancePublicKey.includes('PRIVATE') || provenancePublicKey.length > 4096)) throw Error('Only the public memory verifier can be replicated');
  const version = sha256(JSON.stringify({files:files.map(({path,sha256})=>({path,sha256})),agentConfig:input.agentConfig,provenancePublicKey}));
  if (input.version && input.version !== version) throw Error('Context version mismatch');
  return {schema:1, version, files, agentConfig:input.agentConfig, provenancePublicKey, bytes};
}

export function validateRequest(c, r) {
  if (!r || ![1,2].includes(r.schema) || r.networkId !== c.networkId || r.nodeId !== c.nodeId || r.ownerJid !== c.ownerJid || typeof r.method !== 'string') throw Error('Peer authority mismatch');
  if (!['hello','submit','status','inspect','list','cancel','artifact','revise','context_response','revoke_context','ack_result','gui_slot'].includes(r.method)) throw Error('Unsupported peer operation');
  if(r.schema===1&&!['hello','status','list','cancel','artifact','submit'].includes(r.method))throw Error('Protocol upgrade required');
  if (['submit','revise'].includes(r.method)) {
    assertJobId(r.id);
    if (typeof r.prompt !== 'string' || !r.prompt.trim() || Buffer.byteLength(r.prompt) > 128 * 1024 || typeof r.title !== 'string' || !r.title.trim() || r.title.length > 200 || /[\0\r\n]/.test(r.title)) throw Error('Invalid delegated task');
    if(r.schema===2){validatePeerContract(r.contract);validatePeerContext(r.context,{id:r.id,contract:r.contract});}
  } else if (['status','inspect','cancel','artifact','context_response','revoke_context','ack_result','gui_slot'].includes(r.method)) assertJobId(r.id);
  return r;
}

export function validateInputs(inputs=[]){
  if(!Array.isArray(inputs)||inputs.length>20)throw Error('Invalid task input files');
  const names=new Set();let total=0;
  return inputs.map(f=>{
    if(typeof f.name!=='string'||!f.name||f.name.length>128||f.name.startsWith('.')||/[\\/\0\r\n]/.test(f.name)||names.has(f.name)||typeof f.data!=='string')throw Error('Invalid delegated file name');
    names.add(f.name);const bytes=Buffer.from(f.data,'base64');total+=bytes.length;
    if(total>8*1024*1024||bytes.toString('base64')!==f.data||sha256(bytes)!==f.sha256)throw Error('Task input checksum or size mismatch');
    return {name:f.name,sha256:f.sha256,data:f.data,bytes:bytes.length};
  });
}

export class JobStore {
  constructor(root) {
    this.root = privateDirectory(root);
    this.jobs = privateDirectory(path.join(root, 'jobs'), true);
    this.snapshots = privateDirectory(path.join(root, 'snapshots'), true);
    this.corruptJobs=[];
  }
  dir(id) { return path.join(this.jobs, assertJobId(id)); }
  state(id) { privateDirectory(this.dir(id));const s=privateJson(path.join(this.dir(id), 'state.json'));if(s.id!==id||![1,2].includes(s.schema)||!['queued','running',...terminalStates].includes(s.state))throw Error('Corrupt peer state');return s; }
  payload(id) { const s=this.state(id);return privateJson(path.join(this.dir(id),s.schema===2?'payload-r'+s.revision+'.json':'payload.json')); }
  locked(id,fn){const release=acquireFileLock(this.dir(id),'state',{waitSeconds:2});try{return fn();}finally{release();}}
  writeState(id,old,patch){
    if(terminalStates.has(old.state)&&patch.state&&patch.state!==old.state)throw Error('Terminal jobs cannot be replayed');
    const next={...old,...patch,id,updatedAt:now()};
    if(next.schema===2&&terminalStates.has(next.state)&&!next.resultSha256)next.resultSha256=contentHash({id,revision:next.revision,state:next.state,result:next.result||null,artifacts:next.artifacts||[]});
    atomicWrite(path.join(this.dir(id),'state.json'),next);return next;
  }
  update(id, patch) { return this.locked(id,()=>this.writeState(id,this.state(id),patch)); }
  list() {
    const result=[];this.corruptJobs=[];
    for(const id of fs.readdirSync(this.jobs).filter(n=>uuid.test(n))){try{result.push(this.state(id));}catch{this.corruptJobs.push(id);}}
    return result.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  }
  packet(r){
    const inputs=validateInputs(r.inputs);
    if(r.schema===2||r.contract){
      const contract=validatePeerContract(r.contract),context=validatePeerContext(r.context,{id:r.id,contract});
      if(inputs.some(f=>['task.json','context.json','context-response.json'].includes(f.name)||f.name.startsWith('context-response-')))throw Error('Reserved task input name');
      const payload={schema:2,prompt:r.prompt,title:r.title,contract,context,notify:r.notify!==false,inputs};
      return {payload,inputHash:contentHash({...payload,inputs:inputs.map(({name,sha256})=>({name,sha256}))})};
    }
    const snapshot=validateSnapshot(r.snapshot),payload={prompt:r.prompt,title:r.title,snapshotVersion:snapshot.version,notify:r.notify!==false,inputs};
    return{payload,snapshot,inputHash:sha256(JSON.stringify({...payload,inputs:inputs.map(({name,sha256})=>({name,sha256}))}))};
  }
  submit(r) { const release=acquireFileLock(this.root,'submission');try{return this.submitLocked(r);}finally{release();} }
  submitLocked(r) {
    assertJobId(r.id);const {payload,snapshot,inputHash}=this.packet(r),v2=payload.schema===2;
    if(fs.existsSync(this.dir(r.id))){const s=this.state(r.id);if(s.inputHash!==inputHash)throw Error('Job identity reused for different input');return s;}
    if(v2){validatePeerContext(payload.context,{id:r.id,contract:payload.contract,fresh:true});if(this.list().filter(s=>s.schema===2&&!terminalStates.has(s.state)).length>=32)throw Error('Peer queue capacity exceeded');}
    if(snapshot){
      const file=path.join(this.snapshots,snapshot.version+'.json');
      try{atomicWrite(file,snapshot,true);}catch(e){if(e.code!=='EEXIST')throw e;if(validateSnapshot(privateJson(file)).version!==snapshot.version)throw Error('Existing context was altered');}
    }
    const temp=path.join(this.jobs,'.new-'+crypto.randomUUID());privateDirectory(temp,true);
    const state={schema:v2?2:1,id:r.id,title:r.title,state:'queued',inputHash,...(v2?{revision:payload.contract.revision,parentTaskId:payload.contract.parentTaskId,contextSha256:payload.context.sha256,contextExpiresAt:payload.context.expiresAt,acceptedAt:now(),progress:{stage:'queued',lastActivityAt:now(),nextStep:'await_worker'}}:{snapshotVersion:snapshot.version}),createdAt:now(),updatedAt:now(),deliveries:[],artifacts:[]};
    try{
      atomicWrite(path.join(temp,v2?'payload-r'+state.revision+'.json':'payload.json'),payload,true);atomicWrite(path.join(temp,'state.json'),state,true);
      try{fs.renameSync(temp,this.dir(r.id));}catch(e){if(!fs.existsSync(this.dir(r.id)))throw e;const existing=this.state(r.id);if(existing.inputHash!==inputHash)throw Error('Concurrent job identity conflict');return existing;}
      const fd=fs.openSync(this.jobs,fs.constants.O_RDONLY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }finally{if(fs.existsSync(temp))fs.rmSync(temp,{recursive:true});}
    return state;
  }
  cancel(id){
    const s=this.state(id);if(terminalStates.has(s.state))return s;
    try{atomicWrite(path.join(this.dir(id),'cancel.json'),{requestedAt:now()},true);}catch(e){if(e.code!=='EEXIST')throw e;}
    return{...this.state(id),cancelRequested:true};
  }
  wantsCancel(id){return fs.existsSync(path.join(this.dir(id),'cancel.json'));}
  cancellation(id){try{return privateJson(path.join(this.dir(id),'cancel.json'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  revise(r){
    const packet=this.packet({...r,schema:2});
    return this.locked(r.id,()=>{
      const s=this.state(r.id);if(s.schema!==2||terminalStates.has(s.state))throw Error('Task cannot be revised in this state');
      if(this.wantsCancel(r.id))throw Error('Cancelled task cannot be revised');
      if(packet.payload.contract.parentTaskId!==s.parentTaskId)throw Error('Task parent changed');
      const revision=packet.payload.contract.revision;
      if(revision===s.revision&&packet.inputHash===s.inputHash)return s;
      if(revision!==s.revision+1)throw Error('Revision must follow the accepted revision');
      validatePeerContext(packet.payload.context,{id:r.id,contract:packet.payload.contract,fresh:true});
      const file=path.join(this.dir(r.id),'payload-r'+revision+'.json');
      if(fs.existsSync(file)){if(contentHash(privateJson(file))!==contentHash(packet.payload))throw Error('Revision input conflict');}else atomicWrite(file,packet.payload,true);
      if(s.state==='running')return this.writeState(r.id,s,{pendingRevision:revision,pendingRevisionHash:packet.inputHash,revisionStatus:'interruption_required',revisionRequestedAt:now()});
      return this.writeState(r.id,s,{revision,inputHash:packet.inputHash,title:packet.payload.title,contextSha256:packet.payload.context.sha256,contextExpiresAt:packet.payload.context.expiresAt,revisionStatus:'accepted',revisionAcceptedAt:now()});
    });
  }
  claim(id,{nowMs=Date.now()}={}){
    return this.locked(id,()=>{
      if(readMaintenanceGate(this.root).active)return null;
      const s=this.state(id);if(s.state!=='queued')return null;
      if(s.schema!==2)return this.writeState(id,s,{state:'needs_review',error:'legacy_task_requires_review'});
      const p=this.payload(id);
      if(this.wantsCancel(id))return this.writeState(id,s,{state:'cancelled',cancellationConfirmed:true,finishedAt:now()});
      if(Date.parse(p.contract.execution.expiresAt)<=nowMs||Date.parse(p.context.expiresAt)<=nowMs)return this.writeState(id,s,{state:'needs_review',error:'task_or_context_expired',finishedAt:now()});
      return this.writeState(id,s,{state:'running',startedAt:now(),executionId:crypto.randomUUID(),acceptedRevision:s.revision,progress:{stage:'starting',lastActivityAt:now(),nextStep:'check_runtime'}});
    });
  }
  revokeContext(id,{sha256:hash,reason='context_changed'}={}){
    return this.locked(id,()=>{
      const s=this.state(id);if(s.schema!==2||hash!==s.contextSha256||!/^[a-f0-9]{64}$/.test(hash))throw Error('Context revocation mismatch');
      if(!['context_changed','context_forgotten','context_expired'].includes(reason))throw Error('Invalid revocation reason');
      const file=path.join(this.dir(id),'context-revoked-'+hash+'.json');if(!fs.existsSync(file))atomicWrite(file,{revision:s.revision,sha256:hash,reason,at:now()},true);
      return{...s,contextRevoked:true};
    });
  }
  contextRevoked(id){
    const current=this.state(id),hash=current.contextSha256;if(!/^[a-f0-9]{64}$/.test(hash||''))return false;
    for(const name of ['context-revoked-'+hash+'.json','context-revoked.json']){
      try{const revoked=privateJson(path.join(this.dir(id),name));if(revoked.sha256===hash&&(revoked.revision===undefined||revoked.revision===current.revision))return true;}catch(e){if(e.code!=='ENOENT')throw e;}
    }return false;
  }
  requestContext(id,request){
    if(!request||typeof request.query!=='string'||!request.query.trim()||request.query.length>1000||typeof request.reason!=='string'||request.reason.length>1000||!Array.isArray(request.recordKeys)||request.recordKeys.length>10||request.recordKeys.some(k=>typeof k!=='string'||k.length>200))throw Error('invalid_context_request');
    return this.locked(id,()=>{
      const s=this.state(id);if(s.schema!==2||s.state!=='running'||s.pendingRevision||this.contextRevoked(id)||this.wantsCancel(id))throw Error('context_request_not_current');
      const requests=s.contextRequests||[],requestHash=contentHash(request);
      const existing=requests.find(x=>x.requestHash===requestHash);if(existing)return existing;
      if(requests.length>=6)throw Error('context_request_limit');
      const entry={requestId:crypto.randomUUID(),revision:s.revision,query:request.query,recordKeys:request.recordKeys,reason:request.reason,requestHash,state:'pending',createdAt:now()};
      this.writeState(id,s,{contextRequests:[...requests,entry],progress:{stage:'waiting_context',lastActivityAt:now(),nextStep:'coordinator_context_response'}});return entry;
    });
  }
  respondContext(id,{requestId,context}){
    assertJobId(requestId);
    return this.locked(id,()=>{
      const s=this.state(id),p=this.payload(id),requests=s.contextRequests||[],entry=requests.find(x=>x.requestId===requestId);
      if(s.schema!==2||s.state!=='running'||!entry||entry.revision!==s.revision||s.pendingRevision||this.contextRevoked(id)||this.wantsCancel(id))throw Error('context_response_not_current');
      validatePeerContext(context,{id,contract:p.contract,fresh:true});
      if(context.scopeHash!==p.context.scopeHash||context.scopeRevisionHash!==p.context.scopeRevisionHash)throw Error('context_scope_changed');
      const file=path.join(this.dir(id),'extra-context-'+requestId+'.json');
      if(fs.existsSync(file)){if(privateJson(file).sha256!==context.sha256)throw Error('context_response_conflict');}else atomicWrite(file,context,true);
      this.writeState(id,s,{contextRequests:requests.map(x=>x.requestId===requestId?{...x,state:'answered',answeredAt:now(),contextSha256:context.sha256}:x),contextResponses:[...(s.contextResponses||[]).filter(x=>x.requestId!==requestId),{requestId,sha256:context.sha256,scopeRevisionHash:context.scopeRevisionHash,expiresAt:context.expiresAt}]});
      return{requestId,revision:s.revision,accepted:true,contextSha256:context.sha256};
    });
  }
  acknowledgeResult(id,{revision,resultSha256,disposition}){
    return this.locked(id,()=>{
      const s=this.state(id);
      if(s.schema!==2||!terminalStates.has(s.state)||s.revision!==revision||s.resultSha256!==resultSha256||!['delivered','archived'].includes(disposition))throw Error('Result acknowledgement mismatch');
      if(s.resultAcknowledgement){if(s.resultAcknowledgement.resultSha256!==resultSha256)throw Error('Result acknowledgement conflict');return s.resultAcknowledgement;}
      const receipt={revision,resultSha256,disposition,acknowledgedAt:now()};this.writeState(id,s,{resultAcknowledgement:receipt});return receipt;
    });
  }
  pruneAcknowledged({retentionDays=30,nowMs=Date.now(),limit=5}={}){
    if(!Number.isInteger(retentionDays)||retentionDays<1||retentionDays>365)throw Error('Invalid retention policy');
    const pruned=[];this.retentionWarnings=[];
    for(const original of this.list()){
      if(pruned.length>=limit)break;
      if(original.schema!==2||original.contentPrunedAt||!original.resultAcknowledgement||Date.parse(original.resultAcknowledgement.acknowledgedAt)+retentionDays*86400000>nowMs)continue;
      try{this.locked(original.id,()=>{
        const s=this.state(original.id);if(!terminalStates.has(s.state)||s.resultAcknowledgement?.resultSha256!==s.resultSha256)throw Error('Retention receipt changed');
        // Only protocol-owned task files; never user paths or legacy snapshots.
        for(const name of fs.readdirSync(this.dir(s.id))){
          if(!['workspace','artifacts'].includes(name)&&!/^payload-r\d+\.json$/.test(name)&&!/^extra-context-[a-f0-9-]+\.json$/.test(name))continue;
          const target=path.join(this.dir(s.id),name),st=fs.lstatSync(target);
          if(st.isSymbolicLink()||st.uid!==process.getuid())throw Error('Unsafe retention entry');
          fs.rmSync(target,{recursive:st.isDirectory()});
        }
        this.writeState(s.id,s,{title:'Archived delegated task',result:null,deliveries:[],contextRequests:[],contextResponses:[],contentPrunedAt:now(),retentionPolicy:{days:retentionDays,acknowledgementRequired:true}});pruned.push(s.id);
      });}catch{this.retentionWarnings.push(original.id);}
    }return pruned;
  }
  recover({v2Only=false}={}){
    for(const s of this.list())if(s.state==='running'||(v2Only&&s.schema===1&&s.state==='queued'))this.update(s.id,{state:'needs_review',error:'worker_restarted_execution_not_replayed',finishedAt:now(),recoveryRequired:true});
  }
}

export function captureArtifact(store,id,source,kind='document',caption='') {
  const fd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let data;
  try{const st=fs.fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid()||st.size>64*1024*1024)throw Error('Invalid task artifact');data=fs.readFileSync(fd);const after=fs.fstatSync(fd);if(data.length!==st.size||st.size!==after.size||st.mtimeMs!==after.mtimeMs)throw Error('Task artifact changed');}finally{fs.closeSync(fd);}
  const dir=privateDirectory(path.join(store.dir(id),'artifacts'),true),hash=sha256(data);
  const suffix=path.extname(source).replace(/[^.a-zA-Z0-9]/g,'').slice(0,16),name=hash+suffix;
  const target=path.join(dir,name);if(!fs.existsSync(target))atomicWrite(target,data,true);
  return {name,displayName:path.basename(source),sha256:hash,bytes:data.length,kind,caption:String(caption||'').slice(0,4000)};
}

export function readMaintenanceGate(root){
  const file=path.join(root,'maintenance.json');
  try{
    const gate=privateJson(file);
    if(gate.schema!==1||!/^[a-f0-9]{64}$/.test(gate.tokenSha256||'')||!Number.isFinite(Date.parse(gate.expiresAt))||!Number.isFinite(Date.parse(gate.createdAt)))return{active:true,invalid:true};
    return{active:true,expired:Date.parse(gate.expiresAt)<=Date.now(),tokenSha256:gate.tokenSha256};
  }catch(e){if(e.code==='ENOENT')return{active:false};return{active:true,invalid:true};}
}

export function peerStorageBytes(root,maxBytes=4*1024*1024*1024){
  const pending=[privateDirectory(root)];let bytes=0,count=0;
  while(pending.length){const dir=pending.pop();for(const name of fs.readdirSync(dir)){
    const filename=path.join(dir,name),s=fs.lstatSync(filename);
    // Runtime homes contain the pinned CLI's apply_patch symlinks and sockets.
    // Count entries without following links; content reads still use NOFOLLOW.
    if(s.isSymbolicLink())bytes+=s.size;
    else if(s.isDirectory())pending.push(filename);else if(s.isFile())bytes+=s.size;
    if(++count>100000||bytes>maxBytes)throw Error('Peer storage capacity exceeded');
  }}return bytes;
}

export function readGuiSlot(c,id,revision){
  try{
    const s=privateJson(path.join(c.stateRoot,'gui-slot.json'));
    if(s.schema!==1||s.jobId!==id||s.revision!==revision||!Number.isFinite(Date.parse(s.expiresAt))||Date.parse(s.expiresAt)<=Date.now())return{available:false,reason:'gui_slot_required'};
    return{available:true,expiresAt:s.expiresAt};
  }catch{return{available:false,reason:'gui_slot_required'};}
}

export function allocateGuiSlot(c,{id,revision,durationMs}){
  if(c.allowGui!==true||!Number.isSafeInteger(durationMs)||durationMs<1000||durationMs>3600000)throw Error('Invalid GUI allocation');
  const store=new JobStore(c.stateRoot),s=store.state(id),p=store.payload(id);
  if(s.schema!==2||terminalStates.has(s.state)||s.revision!==revision||p.contract.execution.mode!=='gui'||p.contract.execution.guiAuthorized!==true||store.wantsCancel(id))throw Error('GUI allocation task mismatch');
  const release=acquireFileLock(c.stateRoot,'gui-allocation');
  try{
    const file=path.join(c.stateRoot,'gui-slot.json');let old=null;try{old=privateJson(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(old&&Date.parse(old.expiresAt)>Date.now()&&(old.jobId!==id||old.revision!==revision))throw Error('Another task owns the GUI slot');
    const slot={schema:1,jobId:id,revision,createdAt:now(),expiresAt:new Date(Math.min(Date.now()+durationMs,Date.parse(p.contract.execution.expiresAt))).toISOString(),authority:'coordinator_explicit_task_allocation'};
    atomicWrite(file,slot);return{allocated:true,...slot};
  }finally{release();}
}

/** Read-only observation. Missing evidence is returned as unknown, never inferred. */
export function inspectPeerRuntime(c){
  const result={applicationVersion:null,sourceCommit:null,sourceEvidence:null,bridgeSha256:null,nodeVersion:process.versions.node,platform:process.platform,arch:process.arch,cliVersion:null,cliSha256:null,cliVerified:false,configuredModel:c.model||null,configuredEffort:c.reasoningEffort||null,reportedModel:null,reportedEffort:null};
  try{result.applicationVersion=JSON.parse(fs.readFileSync(path.join(c.projectRoot,'package.json'),'utf8')).version||null;}catch{}
  try{const r=spawnSync('/usr/bin/git',['-C',c.projectRoot,'rev-parse','HEAD'],{encoding:'utf8',timeout:3000,env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1'}});if(r.status===0&&/^[a-f0-9]{40}\n?$/.test(r.stdout)){result.sourceCommit=r.stdout.trim();result.sourceEvidence='git_head_label';}}catch{}
  try{
    const files=['skoobi-peer-core.mjs','skoobi-peer-contract.mjs','skoobi-peer-worker.mjs','skoobi-peer-runtime.mjs'];
    const base=path.dirname(fileURLToPath(import.meta.url));
    result.bridgeSha256=contentHash(files.map(name=>({name,sha256:sha256(fs.readFileSync(path.join(base,name)))})));
  }catch{}
  try{
    const manifest=JSON.parse(fs.readFileSync(path.join(c.projectRoot,'runtime/codex-toolchain.json'),'utf8'));
    if(manifest.schemaVersion!==1||!/^\d+\.\d+\.\d+$/.test(manifest.version)||manifest.destination!==`node_modules/.skoobi-codex-${manifest.version}`||manifest.binary!=='node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'||manifest.launcher!=='node_modules/.bin/codex'||manifest.platform!==process.platform||manifest.arch!==process.arch||!/^[a-f0-9]{64}$/.test(manifest.binarySha256))throw Error('runtime_manifest_invalid');
    const prefix=path.join(c.projectRoot,manifest.destination),native=path.join(prefix,manifest.binary);
    if(!path.isAbsolute(c.codexCommand||'')||fs.realpathSync(c.codexCommand)!==fs.realpathSync(path.join(prefix,manifest.launcher)))throw Error('runtime_command_mismatch');
    const st=fs.lstatSync(native);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>384*1024*1024)throw Error('runtime_binary_invalid');
    const digest=sha256(fs.readFileSync(native));if(digest!==manifest.binarySha256)throw Error('runtime_binary_mismatch');
    const version=spawnSync(native,['--version'],{encoding:'utf8',timeout:5000,env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin'}});
    if(version.status!==0||!version.stdout.includes(manifest.version))throw Error('runtime_version_unavailable');
    Object.assign(result,{cliVersion:manifest.version,cliSha256:digest,cliVerified:true});
  }catch{}
  try{
    const manifest=JSON.parse(fs.readFileSync(path.join(c.projectRoot,'runtime/peer-release.json'),'utf8'));
    const base=path.dirname(fileURLToPath(import.meta.url)),names=['skoobi-peer-core.mjs','skoobi-peer-contract.mjs','skoobi-peer-worker.mjs','skoobi-peer-runtime.mjs'];
    const files=names.map(name=>({name,sha256:sha256(fs.readFileSync(path.join(base,name)))}));
    if(manifest.schema!==1||!/^[a-f0-9]{40}$/.test(manifest.sourceCommit||'')||!/^[a-f0-9]{64}$/.test(manifest.sourceArchiveSha256||'')||!result.cliVerified||manifest.cliVersion!==result.cliVersion||manifest.cliBinarySha256!==result.cliSha256||contentHash(manifest.bridgeFiles)!==contentHash(files)||manifest.bridgeSha256!==contentHash(files))throw Error('release_manifest_mismatch');
    result.sourceCommit=manifest.sourceCommit;result.sourceEvidence='verified_release_manifest';
  }catch{}
  return result;
}

export async function readRpc(stream) {
  const parts=[];let size=0;
  for await(const chunk of stream){size+=chunk.length;if(size>MAX_RPC_BYTES)throw Error('Peer request exceeds limit');parts.push(chunk);}
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export function rpc(c,r) {
  validateRequest(c,r);const store=new JobStore(c.stateRoot);
  if(r.method==='hello'){
    let heartbeat=null;try{heartbeat=privateJson(path.join(c.stateRoot,'heartbeat.json'));}catch{}
    return {protocol:PEER_PROTOCOL,supportedReadProtocols:[1,2],capabilities:PEER_CAPABILITIES,nodeId:c.nodeId,model:c.model,effort:c.reasoningEffort,heartbeat,runtime:inspectPeerRuntime(c),maintenance:readMaintenanceGate(c.stateRoot),executionModes:['isolated',...(c.allowGui===true?['gui']:[])],guiPolicy:{explicitSlotRequired:true,maxSlotMs:3600000}};
  }
  if(['submit','revise'].includes(r.method)){
    if(readMaintenanceGate(c.stateRoot).active)throw Error('Peer maintenance in progress');
    if(c.protocol===2&&r.schema!==2)throw Error('New jobs require protocol 2');
    if(r.schema===2&&(r.contract.runtime.model!==c.model||r.contract.runtime.reasoningEffort!==c.reasoningEffort))throw Error('Runtime profile not supported');
    if(r.schema===2&&r.contract.execution.mode==='gui'&&c.allowGui!==true)throw Error('GUI mode not enabled by operator');
    if(r.method==='submit'&&!fs.existsSync(store.dir(r.id)))peerStorageBytes(c.stateRoot,c.maxStateBytes||4*1024*1024*1024);
    return r.method==='submit'?store.submit(r):store.revise(r);
  }
  if(['status','inspect'].includes(r.method))return store.state(r.id);
  if(r.method==='list')return store.list();
  if(r.method==='cancel')return store.cancel(r.id);
  if(r.method==='revoke_context')return store.revokeContext(r.id,r);
  if(r.method==='context_response')return store.respondContext(r.id,r);
  if(r.method==='ack_result')return store.acknowledgeResult(r.id,r);
  if(r.method==='gui_slot'){if(readMaintenanceGate(c.stateRoot).active)throw Error('Peer maintenance in progress');return allocateGuiSlot(c,r);}
  const state=store.state(r.id),artifact=state.artifacts.find(x=>x.name===r.name);
  if(!artifact||!Number.isSafeInteger(r.offset)||r.offset<0||r.offset>artifact.bytes)throw Error('Unknown artifact or offset');
  const file=path.join(store.dir(r.id),'artifacts',artifact.name),data=privateRead(file,64*1024*1024);
  if(sha256(data)!==artifact.sha256)throw Error('Artifact checksum changed');
  return {...artifact,offset:r.offset,data:data.subarray(r.offset,Math.min(r.offset+512*1024,data.length)).toString('base64')};
}
