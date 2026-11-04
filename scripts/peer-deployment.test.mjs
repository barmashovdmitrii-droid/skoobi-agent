import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

it('peer deployment preserves state through switching, rollback and process failure',()=>{
  const cwd=fileURLToPath(new URL('..',import.meta.url));
  for(const file of ['peer-deployment.test.py','peer-release.test.py']){
    const result=spawnSync('/usr/bin/python3',[`ops/peer/${file}`],{cwd,encoding:'utf8',timeout:30000});
    expect(result.status,result.stderr).toBe(0);
    expect(result.stderr).toMatch(/\bOK\b/);
  }
},65000);
