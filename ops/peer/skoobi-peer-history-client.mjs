import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {PeerHistoryError} from './skoobi-peer-history-contract.mjs';

const METHODS=new Set(['initialize','thread/list','thread/read','thread/turns/list','thread/items/list']);
const DISABLED=['apps','plugins','hooks','memories','multi_agent','code_mode','code_mode_host','computer_use','browser_use','image_generation','standalone_web_search','realtime_conversation','skill_mcp_dependency_install'];

export function historyAppServerArgs(home){
  const args=[];
  for(const feature of DISABLED)args.push('--disable',feature);
  // Disable each configured MCP server without copying or emitting config.
  const file=path.join(home,'config.toml');let fd;
  try{
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const s=fs.fstatSync(fd);
    if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||s.mode&0o022||s.size>1024*1024)throw new PeerHistoryError('history_config_unsafe');
    for(const line of fs.readFileSync(fd,'utf8').split(/\r?\n/)){
      if(/^\s*(?:mcp_servers\s*[.=]|\[mcp_servers\s*\])/.test(line))throw new PeerHistoryError('history_config_unsupported');
      if(!/^\s*\[mcp_servers\./.test(line))continue;
      const m=line.match(/^\s*\[mcp_servers\.([A-Za-z0-9_-]{1,200})(?:\.[^\]]+)?\]\s*(?:#.*)?$/);
      if(!m)throw new PeerHistoryError('history_config_unsupported');
      args.push('-c',`mcp_servers.${m[1]}.enabled=false`);
    }
  }catch(error){if(error.code!=='ENOENT')throw error;}
  finally{if(fd!==undefined)fs.closeSync(fd);}
  args.push('app-server','--listen','stdio://');return args;
}

/** No generic request endpoint is exposed to the model. No resume/start/write. */
export class HistoryReadClient {
  constructor({executable,codexHome,deadline,spawnProcess=spawn}){
    this.deadline=deadline;this.pending=new Map();this.sequence=0;this.closed=false;this.bytes=0;
    const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.dirname(codexHome),CODEX_HOME:codexHome,LANG:'en_US.UTF-8',NO_COLOR:'1'};
    this.child=spawnProcess(executable,historyAppServerArgs(codexHome),{cwd:codexHome,env,stdio:['pipe','pipe','pipe'],detached:true});
    let buffer='';const decoder=new StringDecoder('utf8');
    const fail=code=>{this.error=new PeerHistoryError(code);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(this.error);}this.pending.clear();try{process.kill(-this.child.pid,'SIGKILL');}catch{}};
    this.child.stdout.on('data',chunk=>{
      this.bytes+=chunk.length;buffer+=decoder.write(chunk);
      if(this.bytes>8*1024*1024||buffer.length>4*1024*1024){fail('history_response_limit');return;}
      for(;;){const at=buffer.indexOf('\n');if(at<0)break;const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let v;
        try{v=JSON.parse(line);}catch{fail('history_protocol_invalid');return;}
        if(v.method){if(v.id!==undefined)this.child.stdin.write(JSON.stringify({id:v.id,error:{code:-32601,message:'Read-only history client'}})+'\n');continue;}
        const p=this.pending.get(v.id);if(!p)continue;clearTimeout(p.timer);this.pending.delete(v.id);
        if(v.error){const code=v.error.code===-32601?'history_method_unsupported':v.error.code===-32602?'history_request_unsupported':'history_read_failed';p.reject(new PeerHistoryError(code));}else p.resolve(v.result);
      }
    });
    this.child.stderr.on('data',()=>{});this.child.stdin.on('error',()=>{});
    this.child.once('error',()=>fail('history_process_unavailable'));
    this.child.once('close',()=>{this.closed=true;fail('history_process_closed');});
  }
  async initialize(){await this.request('initialize',{clientInfo:{name:'skoobi-peer-history-read',version:'1.0.0'},capabilities:{experimentalApi:false,requestAttestation:false}});this.child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');}
  request(method,params){
    if(!METHODS.has(method))return Promise.reject(new PeerHistoryError('history_method_forbidden'));
    if(this.error)return Promise.reject(this.error);
    const remaining=Math.min(10000,this.deadline-Date.now());if(remaining<=0)return Promise.reject(new PeerHistoryError('history_timeout'));
    return new Promise((resolve,reject)=>{
      const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(new PeerHistoryError('history_timeout'));},remaining);
      this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');
    });
  }
  async close(){
    if(this.closed)return;
    try{process.kill(-this.child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw new PeerHistoryError('history_stop_unconfirmed');}
    await new Promise(resolve=>{const timer=setTimeout(resolve,1000);this.child.once('close',()=>{clearTimeout(timer);resolve();});});
    if(!this.closed)throw new PeerHistoryError('history_stop_unconfirmed');
  }
}
