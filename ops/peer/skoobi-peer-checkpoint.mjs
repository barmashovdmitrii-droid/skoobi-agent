import fs from 'node:fs';
import path from 'node:path';
import {atomicWrite,privateRead,sha256} from './skoobi-peer-core.mjs';
import {CONTEXT_REQUEST_LIMITS,PeerContextRequestError,validatePeerContextRequest} from './skoobi-peer-context-request.mjs';

/** Pauses/resumes one existing process; never starts or retries a task. */
export function createPeerContextCheckpoint({workspace,checkpoint,suspend,resume,onProgress=()=>{},nowMs=Date.now}){
  const file=path.join(workspace,'output/.peer-context-request.json');
  let waiting=null,repairs=0;
  const consume=hash=>{
    if(sha256(privateRead(file,12000))!==hash)throw Error('context_request_changed');
    fs.unlinkSync(file);
  };
  return {poll(){
    if(!waiting&&fs.existsSync(file)){
      suspend();
      // Unsafe files and I/O failures remain fatal; only content schema errors
      // receive a bounded correction response, without echoing private content.
      const raw=privateRead(file,12000),hash=sha256(raw);
      let request;
      try{
        let value;
        try{value=JSON.parse(raw.toString('utf8'));}catch{throw new PeerContextRequestError('request','valid_json_required');}
        request=validatePeerContextRequest(value);
      }catch(error){
        if(!(error instanceof PeerContextRequestError))throw error;
        if(++repairs>CONTEXT_REQUEST_LIMITS.repairs)throw Error('context_request_repair_limit');
        atomicWrite(path.join(workspace,'inputs/context-response.json'),{schema:1,status:'rejected',error:{code:error.code,...error.detail},limits:CONTEXT_REQUEST_LIMITS,repair:repairs,nextStep:'correct_request_same_execution'});
        consume(hash);resume();
        onProgress({stage:'context_request_rejected',lastActivityAt:new Date(nowMs()).toISOString(),nextStep:'correct_request_same_execution',error:{code:error.code,...error.detail}});
        return;
      }
      waiting={request:checkpoint.request(request),at:nowMs(),hash};
      onProgress({stage:'waiting_context',lastActivityAt:new Date(nowMs()).toISOString(),nextStep:'coordinator_context_response'});
    }
    if(waiting){
      const response=checkpoint.response(waiting.request.requestId);
      if(response){
        atomicWrite(path.join(workspace,'inputs/context-response-'+waiting.request.requestId+'.json'),response,true);
        atomicWrite(path.join(workspace,'inputs/context-response.json'),response);
        consume(waiting.hash);waiting=null;resume();
        onProgress({stage:'context_received',lastActivityAt:new Date(nowMs()).toISOString(),nextStep:'resume_same_execution'});
      }else if(nowMs()-waiting.at>180000)throw Error('context_response_timeout');
    }
  }};
}

export function peerCheckpointFailure(error){
  const reason=error?.message;
  return ['context_request_not_current','context_request_limit','context_request_repair_limit','context_request_changed','context_response_timeout'].includes(reason)?reason:'workspace_policy_violation';
}
