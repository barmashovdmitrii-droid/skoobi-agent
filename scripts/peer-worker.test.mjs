import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

it('peer worker preserves scoped contracts, containment and crash recovery',()=>{
  const output=execFileSync(process.execPath,['--test','ops/peer/skoobi-peer-worker.node-test.mjs'],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:60000,
  });
  expect(output).toMatch(/# fail 0\b/);
},65000);
