import fs from 'node:fs';
import path from 'node:path';
import {HISTORY_READ_CAPABILITY,HISTORY_READ_LIMITS} from './skoobi-peer-history-contract.mjs';

/** Configuration and pinned schema evidence, not a claim that a chat exists. */
export function peerHistoryCapability(c,runtime){
  const base={capability:HISTORY_READ_CAPABILITY,available:false,readOnly:true,modelStarted:false,uiRequired:false,limits:HISTORY_READ_LIMITS};
  if(c.codexHistory?.enabled!==true)return{...base,reason:'history_not_enabled'};
  if(runtime?.cliVerified!==true||runtime.cliVersion!=='0.166.0'||runtime.cliSha256!=='39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1')return{...base,reason:'history_version_unverified'};
  try{
    const home=c.codexHistory.codexHome;
    if(typeof home!=='string'||!path.isAbsolute(home)||fs.realpathSync(home)!==home)throw Error();
    const s=fs.lstatSync(home);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o022)throw Error();
  }catch{return{...base,reason:'history_home_unavailable'};}
  return{...base,available:true,reason:'configured_version_verified',cliVersion:runtime.cliVersion,cliSha256:runtime.cliSha256};
}
