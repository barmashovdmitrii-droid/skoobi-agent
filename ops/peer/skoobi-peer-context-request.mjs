/** One bounded wire schema shared by the worker and coordinator. */
export const CONTEXT_REQUEST_LIMITS = Object.freeze({query:1000,reason:1000,recordKeys:10,recordKey:80,requests:6,repairs:3});

export class PeerContextRequestError extends Error {
  constructor(field, rule, limit) {
    super('invalid_context_request');
    this.code = 'invalid_context_request';
    this.detail = {field,rule,...(limit === undefined ? {} : {limit})};
  }
}

export function validatePeerContextRequest(value) {
  const bad=(field,rule,limit)=>{throw new PeerContextRequestError(field,rule,limit);};
  if(!value||typeof value!=='object'||Array.isArray(value))bad('request','object_required');
  if(Object.keys(value).some(key=>!['query','recordKeys','reason'].includes(key)))bad('request','unknown_field');
  for(const key of ['query','reason']){
    if(typeof value[key]!=='string'||!value[key].trim())bad(key,'nonempty_string_required');
    if(value[key].length>CONTEXT_REQUEST_LIMITS[key])bad(key,'max_utf16_characters',CONTEXT_REQUEST_LIMITS[key]);
    if(/[\u0000]/.test(value[key]))bad(key,'nul_forbidden');
  }
  if(!Array.isArray(value.recordKeys)||value.recordKeys.length>10)bad('recordKeys','array_max_items',10);
  if(value.recordKeys.some(key=>typeof key!=='string'||!key.trim()||key.length>80||/[\u0000\r\n]/.test(key)))bad('recordKeys','nonempty_key_max_characters',80);
  if(new Set(value.recordKeys).size!==value.recordKeys.length)bad('recordKeys','duplicate_key');
  return {query:value.query,recordKeys:[...value.recordKeys],reason:value.reason};
}

export const CONTEXT_REQUEST_INSTRUCTIONS = 'For additional project context, atomically write output/.peer-context-request.json with exactly {query:string,recordKeys:string[],reason:string}. query and reason must be nonempty, each at most 1000 UTF-16 characters; recordKeys at most 10 distinct keys, each at most 80 characters. Wait for the file to be removed, then read inputs/context-response.json. A rejected response explains the exact field/limit: correct it in the SAME execution; never replay previous external actions. At most six accepted requests and three invalid-request repairs. The host may pause and resume this same process at the checkpoint.';
