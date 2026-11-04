import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
import {STATE_ROOT,GROUPS_DIR,DATA_DIR} from '@skoobi/core/config';
import {validateIpcSendFilePath} from '@skoobi/core/ipc';
import {JobStore,atomicWrite,sha256,validateSnapshot} from '../ops/peer/skoobi-peer-core.mjs';
import {enqueueResult} from '../ops/peer/skoobi-peer.mjs';

it('peer coordinator preserves cancellation and receipts through disconnects and process races',()=>{
  const output=execFileSync(process.execPath,['--test','ops/peer/skoobi-peer.node-test.mjs'],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:30000,
  });
  expect(output).toMatch(/# fail 0\b/);
},35000);

it('returned documents pass the current core IPC workspace validator without a root dist build',()=>{
  // The configured test root is set before module imports by vitest-env.ts.
  // Keep the native producer and real core validator in the same isolated root.
  expect(STATE_ROOT.startsWith(fs.realpathSync(os.tmpdir())+path.sep)).toBe(true);
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'skoobi-peer-ipc-test-')));
  fs.chmodSync(root,0o700);
  const group='peer-ipc-fixture-'+randomUUID();
  const groupRoot=path.join(GROUPS_DIR,group),ipcRoot=path.join(DATA_DIR,'ipc',group);
  try{
    fs.mkdirSync(groupRoot,{recursive:true,mode:0o700});
    fs.mkdirSync(path.join(ipcRoot,'messages'),{recursive:true,mode:0o700});
    const id=randomUUID(),store=new JobStore(root),data=Buffer.from('Synthetic fixture preferences');
    const snapshot=validateSnapshot({files:[{path:'CLAUDE.md',data:data.toString('base64'),sha256:sha256(data)}],agentConfig:{fullAccess:true,noSandbox:true,systemPrompt:'Synthetic fixture profile'}});
    store.submit({id,prompt:'Return a synthetic document',title:'Synthetic task',snapshot,notify:true});
    const c={schema:1,role:'coordinator',networkId:'0'.repeat(24),nodeId:'mini',ownerJid:'tg:1234567',ownerGroupFolder:group,stateRoot:root,projectRoot:STATE_ROOT};
    const file=path.join(store.dir(id),'report.txt'),bytes=Buffer.from('Synthetic returned document');
    atomicWrite(file,bytes,true);
    const artifact={name:sha256(bytes)+'.txt',sha256:sha256(bytes),kind:'document',bytes:bytes.length,localPath:file};
    enqueueResult(c,id,{title:'Synthetic task',state:'succeeded',deliveries:[]},[artifact]);
    const outbox=path.join(ipcRoot,'messages');
    const sent=fs.readdirSync(outbox).map(name=>JSON.parse(fs.readFileSync(path.join(outbox,name),'utf8'))).find(message=>message.type==='document');
    expect(sent).toBeDefined();
    const result=validateIpcSendFilePath({sourceGroup:group,isMain:false,filePath:sent.filePath,kind:'document'});
    expect(result.allowed).toBe(true);
    expect(fs.readFileSync(result.realPath)).toEqual(bytes);
    // The original coordinator state is not an authorized group workspace.
    expect(validateIpcSendFilePath({sourceGroup:group,isMain:false,filePath:file,kind:'document'}).allowed).toBe(false);
  }finally{
    for(const directory of [groupRoot,ipcRoot,root])fs.rmSync(directory,{recursive:true,force:true});
  }
});
