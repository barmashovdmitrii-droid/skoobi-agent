import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

it('peer context repair and selected Codex history preserve scope and read-only boundaries',()=>{
  const output=execFileSync(process.execPath,['--test','ops/peer/skoobi-peer-checkpoint.node-test.mjs','ops/peer/skoobi-peer-history.node-test.mjs'],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:25000,
  });
  expect(output).toMatch(/# fail 0\b/);
},30000);
