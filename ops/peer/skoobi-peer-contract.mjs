import crypto from 'node:crypto';

export const PEER_PROTOCOL = 2;
export const PEER_CAPABILITIES = Object.freeze(['contracts-v1','revision-ack-v1','scoped-context-v1','bounded-execution-v1','result-manifest-v1','read-only-inspect-v1','cancellation-receipt-v1','result-retention-ack-v1','context-checkpoint-v1']);
export function canonicalJson(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalJson(value[k])).join(',')+'}';
}
export const contentHash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
function object(v){return v&&typeof v==='object'&&!Array.isArray(v);}
function text(v,max=1000){return typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=max&&!v.includes('\0');}
function integer(v,min,max){return Number.isSafeInteger(v)&&v>=min&&v<=max;}
export function validPeerDate(v){return typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;}
export function validOutputName(v){return text(v,128)&&!v.startsWith('.')&&!/[\\/\r\n]/.test(v);}
function exactKeys(value,keys){if(Object.keys(value).some(k=>!keys.includes(k)))throw Error('Unknown contract field');}

/** Task data never carries shell commands, credentials, or an execution capability. */
export function validatePeerContract(value){
  if(!object(value))throw Error('Invalid task contract');
  exactKeys(value,['schema','revision','parentTaskId','projectKey','source','goal','expectedOutputs','acceptance','execution','runtime','dependsOnParent','rework','supersedesJobId']);
  const project=value.projectKey;
  if(value.schema!==1||!integer(value.revision,1,1000)||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value.parentTaskId||'')||!(project===null||(typeof project==='string'&&/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,79}$/u.test(project)&&project===project.normalize('NFKC').toLowerCase()))||!text(value.goal,16000)||typeof value.dependsOnParent!=='boolean')throw Error('Invalid task contract identity');
  if(!object(value.source))throw Error('Missing task source');
  exactKeys(value.source,['operationId','messageId']);
  if(Object.values(value.source).some(v=>!text(v,200)))throw Error('Invalid task source');
  if(value.rework!==undefined&&!integer(value.rework,0,2))throw Error('Rework limit exceeded');
  if(value.supersedesJobId!==undefined&&!/^[a-f0-9-]{36}$/.test(value.supersedesJobId))throw Error('Invalid superseded job');
  if(!Array.isArray(value.expectedOutputs)||value.expectedOutputs.length>20)throw Error('Invalid expected outputs');
  const names=new Set();
  for(const o of value.expectedOutputs){
    if(!object(o))throw Error('Invalid expected output');exactKeys(o,['name','kind']);
    if(!validOutputName(o.name)||names.has(o.name)||!['text','document','photo','code'].includes(o.kind))throw Error('Invalid expected output');names.add(o.name);
  }
  if(!Array.isArray(value.acceptance)||!value.acceptance.length||value.acceptance.length>30)throw Error('Explicit acceptance criteria required');
  const checkIds=new Set();
  for(const a of value.acceptance){
    if(!object(a))throw Error('Invalid acceptance criterion');exactKeys(a,['id','description','kind','outputName','expected','scenario']);
    if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(a.id)||checkIds.has(a.id)||!text(a.description,2000)||!['manual','text_contains','file_present','file_contains','file_sha256','json_parse','artifact'].includes(a.kind))throw Error('Invalid acceptance criterion');
    checkIds.add(a.id);
    if(a.outputName!==undefined&&!names.has(a.outputName))throw Error('Acceptance output is not declared');
    if(['file_present','file_contains','file_sha256','json_parse','artifact'].includes(a.kind)&&!a.outputName)throw Error('Acceptance output required');
    if(['text_contains','file_contains'].includes(a.kind)&&!text(a.expected,4000))throw Error('Acceptance expected text required');
    if(a.kind==='file_sha256'&&!/^[a-f0-9]{64}$/.test(a.expected||''))throw Error('Acceptance expected hash required');
    if(a.expected!==undefined&&!text(a.expected,4000))throw Error('Invalid expected value');
    if(a.scenario!==undefined&&(!object(a.scenario)||Buffer.byteLength(JSON.stringify(a.scenario))>32000))throw Error('Invalid artifact scenario');
  }
  const e=value.execution;
  if(!object(e))throw Error('Execution limits required');
  exactKeys(e,['mode','timeoutMs','expiresAt','maxOutputBytes','maxWorkspaceBytes','allowBattery','guiAuthorized']);
  if(!['isolated','gui'].includes(e.mode)||!integer(e.timeoutMs,1000,7200000)||!validPeerDate(e.expiresAt)||!integer(e.maxOutputBytes,1024,64*1024*1024)||!integer(e.maxWorkspaceBytes,e.maxOutputBytes,2*1024*1024*1024)||typeof e.allowBattery!=='boolean'||typeof e.guiAuthorized!=='boolean'||(e.mode==='gui'&&!e.guiAuthorized)||(e.mode==='isolated'&&e.guiAuthorized))throw Error('Invalid execution limits');
  const r=value.runtime;
  if(!object(r))throw Error('Runtime profile required');exactKeys(r,['model','reasoningEffort']);
  if(!/^[a-zA-Z0-9._-]{1,100}$/.test(r.model||'')||!['low','medium','high','xhigh','max','ultra'].includes(r.reasoningEffort))throw Error('Invalid runtime profile');
  if(Buffer.byteLength(canonicalJson(value))>96000)throw Error('Task contract exceeds limit');
  return structuredClone(value);
}

export function validatePeerContext(value,{id,contract,fresh=false,nowMs=Date.now()}={}){
  if(!object(value)||value.schema!==1||value.taskId!==id||value.revision!==contract?.revision||value.projectKey!==contract?.projectKey||!/^[a-f0-9]{64}$/.test(value.scopeHash||'')||!validPeerDate(value.createdAt)||!validPeerDate(value.expiresAt))throw Error('Invalid task memory context');
  exactKeys(value,['schema','taskId','revision','scopeHash','scopeRevisionHash','retrieval','projectKey','createdAt','expiresAt','records','sha256']);
  if(!/^[a-f0-9]{64}$/.test(value.scopeRevisionHash||'')||!object(value.retrieval)||!['lexical','hybrid_partial'].includes(value.retrieval.mode))throw Error('Invalid memory scope revision');
  exactKeys(value.retrieval,['mode','reason']);
  if(value.retrieval.reason!==undefined&&!['not_configured','embedding_unavailable'].includes(value.retrieval.reason))throw Error('Invalid memory retrieval evidence');
  if(Date.parse(value.expiresAt)>Date.parse(value.createdAt)+86400000||Date.parse(value.expiresAt)<=Date.parse(value.createdAt)||Date.parse(value.expiresAt)>Date.parse(contract.execution.expiresAt))throw Error('Invalid task memory expiry');
  if(fresh&&(Date.parse(value.expiresAt)<=nowMs||Date.parse(value.createdAt)>nowMs+30000))throw Error('Task memory context expired');
  if(!Array.isArray(value.records)||value.records.length>20)throw Error('Task memory context exceeds record limit');
  const keys=new Set();
  for(const r of value.records){
    if(!object(r))throw Error('Invalid memory record');exactKeys(r,['kind','key','projectKey','revision','updatedAt','validUntil','value','source']);
    const key=canonicalJson([r.kind,r.projectKey,r.key]);
    if(!['fact','project'].includes(r.kind)||!text(r.key,200)||keys.has(key)||!(r.projectKey===null||r.projectKey===contract.projectKey)||!integer(r.revision,1,Number.MAX_SAFE_INTEGER)||!validPeerDate(r.updatedAt)||!(r.validUntil===null||validPeerDate(r.validUntil))||!text(r.value,4000))throw Error('Invalid memory record');
    keys.add(key);
    if(!object(r.source))throw Error('Invalid memory source');exactKeys(r.source,['kind','at','messageRef','trust']);
    if(!['direct_user','assistant_report'].includes(r.source.kind)||!validPeerDate(r.source.at)||r.source.trust!=='agent_interpreted'||(r.source.messageRef!==undefined&&!text(r.source.messageRef,200)))throw Error('Invalid memory source');
    if(fresh&&r.validUntil!==null&&Date.parse(r.validUntil)<=nowMs)throw Error('Memory record expired');
  }
  const {sha256,...body}=value;
  if(Buffer.byteLength(canonicalJson(value))>65536||sha256!==contentHash(body))throw Error('Task memory checksum or size mismatch');
  return structuredClone(value);
}
