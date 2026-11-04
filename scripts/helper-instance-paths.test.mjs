import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach,expect,it} from 'vitest';
import {resolveHelperInstancePaths} from '../helper/instance-paths.js';

const roots=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'peer-helper-paths-')));roots.push(root);fs.chmodSync(root,0o700);
  const state=path.join(root,'instance'),release=path.join(root,'release');
  fs.mkdirSync(state,{mode:0o700});fs.mkdirSync(release,{mode:0o700});
  const env=path.join(state,'.env');fs.writeFileSync(env,'SYNTHETIC=fixture\n',{mode:0o600});
  return{root,state,release,env,module:pathToFileURL(path.join(release,'helper/skoobi-helper.js')).href};
}
it('keeps private environment and logs in the live instance when code is versioned',()=>{
  const f=fixture(),before=fs.readdirSync(f.release);
  expect(resolveHelperInstancePaths(f.module,f.env)).toEqual({projectRoot:f.state,envFile:f.env,logFile:path.join(f.state,'logs/skoobi-helper.log')});
  expect(fs.readdirSync(f.release)).toEqual(before);
});
it('preserves the original module-relative layout only when no explicit path is supplied',()=>{
  const f=fixture();
  expect(resolveHelperInstancePaths(f.module,undefined).envFile).toBe(path.join(f.release,'.env'));
});
it('never falls back to code or a global environment after an invalid explicit path',()=>{
  const f=fixture();
  for(const value of ['','.env','relative/.env',path.join(f.state,'missing.env'),f.env+'\n'])
    expect(()=>resolveHelperInstancePaths(f.module,value)).toThrow();
});
it('rejects symlinked or shared environment files',()=>{
  const f=fixture(),link=path.join(f.state,'linked.env');fs.symlinkSync(f.env,link);
  expect(()=>resolveHelperInstancePaths(f.module,link)).toThrow();
  fs.chmodSync(f.env,0o644);expect(()=>resolveHelperInstancePaths(f.module,f.env)).toThrow();
});
it('rejects a symlinked instance and hard-linked private environment',()=>{
  const f=fixture(),alias=path.join(f.root,'alias');fs.symlinkSync(f.state,alias);
  expect(()=>resolveHelperInstancePaths(f.module,path.join(alias,'.env'))).toThrow();
  fs.linkSync(f.env,path.join(f.state,'second.env'));expect(()=>resolveHelperInstancePaths(f.module,f.env)).toThrow();
});
