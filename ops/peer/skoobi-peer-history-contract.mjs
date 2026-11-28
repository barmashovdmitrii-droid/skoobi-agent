import {createHash} from 'node:crypto';

export const HISTORY_READ_CAPABILITY='codex-history-read-v1';
export const HISTORY_READ_LIMITS=Object.freeze({maxBytes:65536,maxRangeDays:31,maxGrantMs:300000,maxPages:40,maxMessages:500,timeoutMs:45000});
export class PeerHistoryError extends Error {constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new PeerHistoryError(code);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export const historyScopeHash=scope=>createHash('sha256').update(JSON.stringify(scope)).digest('hex');

/** Authority is supplied by the verified coordinator IPC run, never by a model. */
export function validatePeerHistoryScope(s,now=Date.now()){
  if(!exact(s,['schema','jobId','revision','sourceMessageId','selector','from','to','expiresAt','maxBytes'])||s.schema!==1||s.revision!==1||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s.jobId||'')||typeof s.sourceMessageId!=='string'||!s.sourceMessageId.trim()||s.sourceMessageId.length>200||/[\u0000\r\n]/.test(s.sourceMessageId))fail('history_scope_invalid');
  const selector=s.selector;
  if(!exact(selector,['threadId','exactTitle'])||Object.keys(selector).length!==1)fail('history_selector_invalid');
  if(selector.threadId!==undefined){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(selector.threadId))fail('history_selector_invalid');}
  else if(typeof selector.exactTitle!=='string'||!selector.exactTitle.trim()||selector.exactTitle.length>200||/[\u0000\r\n]/.test(selector.exactTitle))fail('history_selector_invalid');
  if(!iso(s.from)||!iso(s.to)||Date.parse(s.from)>=Date.parse(s.to)||Date.parse(s.to)-Date.parse(s.from)>31*86400000)fail('history_date_range_invalid');
  if(!iso(s.expiresAt)||Date.parse(s.expiresAt)<=now||Date.parse(s.expiresAt)>now+300000)fail('history_scope_expired');
  if(!Number.isInteger(s.maxBytes)||s.maxBytes<1024||s.maxBytes>65536)fail('history_output_limit_invalid');
  return {schema:1,jobId:s.jobId,revision:1,sourceMessageId:s.sourceMessageId,selector:{...selector},from:s.from,to:s.to,expiresAt:s.expiresAt,maxBytes:s.maxBytes};
}

export function redactHistoryText(text){
  return text.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,'[REDACTED_CREDENTIAL]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]{12,}/gi,'$1 [REDACTED_CREDENTIAL]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[=:]\s*["']?)[^\s"',;}]{8,}/gi,'$1[REDACTED_CREDENTIAL]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[REDACTED_PRIVATE_KEY]');
}

/** Only human/assistant dialogue, never shell output, system prompts or files. */
export function historyMessage(item){
  if(!item||typeof item.id!=='string'||item.id.length>200)return null;
  if(item.type==='agentMessage'&&typeof item.text==='string')return{id:item.id,role:'assistant',text:redactHistoryText(item.text),phase:['commentary','partial_answer','final_answer'].includes(item.phase)?item.phase:null};
  if(item.type==='userMessage'&&Array.isArray(item.content))return{id:item.id,role:'user',text:redactHistoryText(item.content.filter(c=>c?.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n'))};
  return null;
}
