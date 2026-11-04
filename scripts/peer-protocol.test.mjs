import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

it('peer task revisions and complete main delivery preserve their durable identities',()=>{
  const output=execFileSync(process.execPath,['--test','--test-reporter=tap',
    'ops/peer/skoobi-peer-v2.node-test.mjs','ops/peer/skoobi-peer.integration.node-test.mjs'],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:60000,
  });
  expect(output).toMatch(/# fail 0\b/);
},65000);
