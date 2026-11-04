import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

it('peer coordinator preserves cancellation and receipts through disconnects and process races',()=>{
  const output=execFileSync(process.execPath,['--test','ops/peer/skoobi-peer.node-test.mjs'],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:30000,
  });
  expect(output).toMatch(/# fail 0\b/);
},35000);
