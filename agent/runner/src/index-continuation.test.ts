import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

/** Run the actual provider loop with a local fake CLI: no model, MCP or network. */
async function continuationFixture(
  mode: 'success' | 'failure' | 'close' | 'image' | 'startup' | 'status' | 'correction-stream' | 'budget',
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-continuation-'));
  roots.push(root);
  const group = path.join(root, 'group');
  const ipc = path.join(root, 'ipc');
  const inputDir = path.join(ipc, 'input');
  fs.mkdirSync(group);
  fs.mkdirSync(inputDir, { recursive: true });
  const fake = path.join(root, 'fake-codex.cjs');
  const calls = path.join(root, 'calls');
  const action = path.join(root, 'original-action');
  const seen = path.join(root, 'continuation-input');
  const pending = path.join(inputDir, '1700000000000-correction.json');
  const startupFile = {
    name: path.basename(pending),
    type: 'message',
    text: 'Use fixture-company for every document.',
    hostSource: {
      chatJid: 'tg:fixture',
      messageIds: ['fixture-correction'],
      ingestionCursors: ['i:0000000000000002'],
    },
  };
  if (mode === 'startup')
    fs.writeFileSync(pending, JSON.stringify(startupFile));
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
    const fs = require('fs');
    const args = process.argv.slice(2);
    const output = args[args.indexOf('--output-last-message') + 1];
    fs.appendFileSync(${JSON.stringify(calls)}, 'x');
    const attempt = fs.readFileSync(${JSON.stringify(calls)}, 'utf8').length;
    const emit = x => console.log(JSON.stringify(x));
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', x => input += x);
    process.stdin.on('end', () => {
      emit({ type:'thread.started', thread_id:'aaaaaaaa-1111-2222-3333-444444444444' });
      emit({ type:'turn.started' });
      if (attempt === 1 && ${JSON.stringify(mode)} !== 'startup') {
        if (${JSON.stringify(mode)} === 'budget') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,900);
        emit({ type:'item.started', item:{type:'mcp_tool_call',server:'claudeclaw',tool:'send_document',id:'original-doc'} });
        fs.appendFileSync(${JSON.stringify(action)}, 'x');
        if (${JSON.stringify(mode)} === 'image') emit({type:'event_msg',payload:{
          type:'image_generation_end',call_id:'fixture-generated-image',status:'completed',saved_path:'/tmp/fixture-generated-image.png',
        }});
        emit({ type:'item.completed', item:{type:'mcp_tool_call',server:'claudeclaw',tool:'send_document',id:'original-doc',status:'completed',result:{content:[{type:'text',text:'Document queued for delivery: /tmp/fixture.pdf'}]}} });
        fs.writeFileSync(${JSON.stringify(pending)}, JSON.stringify({type:'message',text:${JSON.stringify(mode)} === 'status' ? 'А почему так долго я ждал ответа?' : 'Use fixture-company for every document.'}));
        if (${JSON.stringify(mode)} === 'status') {
          for (let n=1;n<=8;n++) fs.writeFileSync(${JSON.stringify(inputDir)} + '/170000000000' + n + '-status.json',JSON.stringify({type:'message',text:'Какой сейчас статус задачи?'}));
          fs.writeFileSync(${JSON.stringify(path.join(inputDir, '_close'))}, '');
        }
        if (${JSON.stringify(mode)} === 'close') fs.writeFileSync(${JSON.stringify(path.join(inputDir, '_close'))}, '');
        const final = 'Original document prepared. Which company should I use?';
        emit({type:'item.completed',item:{type:'agent_message',text:final}});
        emit({type:'turn.completed',usage:{input_tokens:100,output_tokens:10}});
        fs.writeFileSync(output,final);
        process.exit(0);
      }
      fs.writeFileSync(${JSON.stringify(seen)}, input);
      if (!fs.existsSync(${JSON.stringify(pending)})) throw new Error('pending input prematurely deleted');
      emit({type:'item.started',item:{type:'command_execution',id:'check-fixture',command:'read local state'}});
      if (${JSON.stringify(mode)} === 'budget') { setInterval(()=>{},10000); return; }
      if (${JSON.stringify(mode)} === 'failure') {
        emit({type:'item.started',item:{type:'mcp_tool_call',server:'claudeclaw',tool:'memory_save',id:'remember-correction'}});
        emit({type:'turn.failed',error:{message:'fixture continuation failed'}});
        process.exit(1);
      }
      emit({type:'item.completed',item:{type:'command_execution',id:'check-fixture'}});
      if (${JSON.stringify(mode)} === 'correction-stream') fs.writeFileSync(${JSON.stringify(inputDir)} + '/170000000000' + attempt + '-correction.json',JSON.stringify({type:'message',text:'Use another fixture company revision '+attempt}));
      const final = 'Updated documents use fixture-company.';
      emit({type:'item.completed',item:{type:'agent_message',text:final}});
      emit({type:'turn.completed',usage:{input_tokens:200,output_tokens:20}});
      fs.writeFileSync(output,final);
      if (${JSON.stringify(mode)} !== 'correction-stream') fs.writeFileSync(${JSON.stringify(path.join(inputDir, '_close'))}, '');
      process.exit(0);
    });
  `,
    { mode: 0o755 },
  );
  const input = {
    prompt: 'Prepare the local document.',
    groupFolder: 'fixture',
    chatJid: 'tg:fixture',
    isMain: true,
    provider: 'codex_cli',
    emitProgressMessages: true,
    finalizeHold: true,
    allowFollowUpSupersede: true,
    codex: { command: fake, model: 'fixture-model', timeoutMs: 10_000 },
  };
  const moduleUrl = pathToFileURL(
    path.resolve('agent/runner/src/index.ts'),
  ).href;
  const harness = `import(${JSON.stringify(moduleUrl)}).then(m => m.runCodexProviderLoop(${JSON.stringify(input)}, ${JSON.stringify(path.join(root, 'unused-mcp.js'))}, ${JSON.stringify(input.prompt + (mode === 'startup' ? '\n' + startupFile.text : ''))}, ${JSON.stringify(mode === 'startup' ? [startupFile] : [])}));`;
  const result = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        path.resolve('node_modules/tsx/dist/loader.mjs'),
        '-e',
        harness,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CODEX_HOME: path.join(root, 'codex-home'),
          CLAUDECLAW_GROUP_DIR: group,
          CLAUDECLAW_IPC_DIR: ipc,
          CLAUDECLAW_RUNNER_IDLE_WAIT_MS: '1000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`fixture timeout: ${stderr}`));
    }, mode === 'budget' ? 30_000 : 20_000);
    child.stdout.on('data', (x) => (stdout += x));
    child.stderr.on('data', (x) => (stderr += x));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
  const frames = [
    ...result.stdout.matchAll(
      /---CLAUDECLAW_OUTPUT_START---\n([\s\S]*?)\n---CLAUDECLAW_OUTPUT_END---/g,
    ),
  ].map((match) => JSON.parse(match[1]));
  return { ...result, frames, calls, action, seen, pending };
}

describe('normal continuation after a pending correction (real runner + fake CLI)', () => {
  it('marks ordinary startup inputs as durable, preserving host IDs until confirmed delivery', async () => {
    const r = await continuationFixture('startup');
    expect(r.code, r.stderr).toBe(0);
    expect(fs.readFileSync(r.calls, 'utf8')).toBe('x');
    const final = r.frames.find((f) => f.status === 'success' && f.result);
    expect(final.finalizedInputFiles).toEqual([path.basename(r.pending)]);
    const retained = JSON.parse(fs.readFileSync(r.pending, 'utf8'));
    expect(retained.afterFailedHold).toBe(true);
    expect(retained.hostSource.messageIds).toEqual(['fixture-correction']);
    expect(fs.readFileSync(r.seen, 'utf8')).toContain('fixture-company');
  }, 25_000);

  it('withholds the stale question, applies the correction, and keeps its checkpoint until host delivery', async () => {
    const r = await continuationFixture('success');
    expect(r.code, r.stderr).toBe(0);
    expect(fs.readFileSync(r.calls, 'utf8')).toBe('xx');
    expect(fs.readFileSync(r.action, 'utf8')).toBe('x');
    const input = fs.readFileSync(r.seen, 'utf8');
    expect(input).toContain('Use fixture-company');
    expect(input).toContain('Original document prepared.');
    expect(input).toContain('send_document');
    const finals = r.frames.filter((f) => f.status === 'success' && f.result);
    expect(finals.map((f) => f.result)).toEqual([
      'Updated documents use fixture-company.',
    ]);
    expect(finals[0].finalizedInputFiles).toEqual([path.basename(r.pending)]);
    expect(finals[0].usage.inputTokens).toBe(300);
    expect(
      r.frames.some((f) => f.status === 'heartbeat' && f.finalizeHoldCheckpoint?.reason === 'correction_pending'),
    ).toBe(true);
    expect(
      r.frames
        .filter((f) => f.absorbedFollowUps)
        .map((f) => f.absorbedFollowUps),
    ).toEqual([1]);
    // The runner's frame is not delivery. Host acknowledgement owns deletion.
    expect(
      JSON.parse(fs.readFileSync(r.pending, 'utf8')).holdOriginalText,
    ).toContain('Original document prepared.');
  }, 25_000);

  it('retains the correction, original draft and both observed effects when continuation fails', async () => {
    const r = await continuationFixture('failure');
    expect(r.code, r.stderr).toBe(0);
    expect(fs.readFileSync(r.action, 'utf8')).toBe('x');
    expect(r.frames.some((f) => f.status === 'success')).toBe(false);
    expect(r.frames.some((f) => f.absorbedFollowUps)).toBe(false);
    expect(r.frames.some((f) => f.status === 'error')).toBe(true);
    const checkpoint = JSON.parse(fs.readFileSync(r.pending, 'utf8'));
    expect(checkpoint.holdOriginalText).toContain(
      'Original document prepared.',
    );
    expect(checkpoint.holdDoneTools).toEqual(
      expect.arrayContaining(['send_document', 'memory_save']),
    );
  }, 25_000);

  it('does not launch another model or consume the correction after a close sentinel', async () => {
    const r = await continuationFixture('close');
    expect(r.code, r.stderr).toBe(0);
    expect(fs.readFileSync(r.calls, 'utf8')).toBe('x');
    expect(r.frames.some((f) => f.status === 'success')).toBe(false);
    expect(r.frames.some((f) => f.absorbedFollowUps)).toBe(false);
    expect(JSON.parse(fs.readFileSync(r.pending, 'utf8')).afterFailedHold).toBe(
      true,
    );
  }, 25_000);

  it('carries generated image evidence into the continuation without auto-sending an obsolete artifact', async () => {
    const r = await continuationFixture('image');
    expect(r.code, r.stderr).toBe(0);
    const input = fs.readFileSync(r.seen, 'utf8');
    expect(input).toContain('/tmp/fixture-generated-image.png');
    expect(input).toContain('не отправляй старый вариант автоматически');
    const final = r.frames.find((f) => f.status === 'success' && f.result);
    expect(final.imageArtifacts).toBeUndefined();
    expect(
      JSON.parse(fs.readFileSync(r.pending, 'utf8')).holdOriginalText,
    ).toContain('/tmp/fixture-generated-image.png');
  }, 25_000);
  it('repeated status questions release the ready answer without another model or input acknowledgement', async () => {
    const r = await continuationFixture('status');
    expect(r.code,r.stderr).toBe(0);
    expect(fs.readFileSync(r.calls,'utf8')).toBe('x');
    expect(fs.readFileSync(r.action,'utf8')).toBe('x');
    const finals=r.frames.filter(f=>f.status==='success'&&f.result);
    expect(finals.map(f=>f.result)).toEqual(['Original document prepared. Which company should I use?']);
    expect(finals[0].finalizedInputFiles).toBeUndefined();
    expect(r.frames.some(f=>f.absorbedFollowUps||f.consumedFollowUps)).toBe(false);
    expect(JSON.parse(fs.readFileSync(r.pending,'utf8')).text).toContain('почему так долго');
    expect(fs.readdirSync(path.dirname(r.pending)).filter(f=>f.endsWith('.json'))).toHaveLength(9);
  }, 25_000);

  it('bounds an endless correction stream, checkpoints all input, and never repeats original side effects', async () => {
    const r = await continuationFixture('correction-stream');
    expect(r.code,r.stderr).toBe(0);
    expect(fs.readFileSync(r.calls,'utf8')).toBe('xxx');
    expect(fs.readFileSync(r.action,'utf8')).toBe('x');
    expect(r.frames.some(f=>f.status==='success'||f.absorbedFollowUps||f.finalizedInputFiles)).toBe(false);
    const blocked=r.frames.find(f=>f.finalizeHoldCheckpoint?.reason==='continuation_budget_exhausted');
    expect(blocked.finalizeHoldCheckpoint).toMatchObject({continuations:2,pendingMessages:3,readyDraftHeld:true});
    expect(r.frames.find(f=>f.status==='error').error).toBe('finalize_continuation_budget_exhausted');
    expect(r.frames.find(f=>f.status==='error').imageArtifacts).toBeUndefined();
    for(const name of fs.readdirSync(path.dirname(r.pending)).filter(f=>f.endsWith('.json'))){
      const retained=JSON.parse(fs.readFileSync(path.join(path.dirname(r.pending),name),'utf8'));
      expect(retained.afterFailedHold).toBe(true);
      expect(retained.holdDoneTools).toContain('send_document');
      expect(retained.holdOriginalText).toBeTruthy();
    }
  },25_000);

  it('the real continuation process gets only the original remaining deadline', async()=>{
    const r=await continuationFixture('budget');
    expect(r.code,r.stderr).toBe(0);
    const launches=fs.readFileSync(r.calls,'utf8');
    const budgets=[...r.stderr.matchAll(/codex turn starting[^\n]*timeout=(\d+)ms/g)].map(m=>Number(m[1]));
    expect(budgets[0]).toBe(10_000);
    // A loaded full-suite host can consume the deadline before launch. That
    // must stop safely, never reset the budget to make the fixture pass.
    if(launches==='x'){
      expect(budgets).toHaveLength(1);
    }else{
      expect(launches).toBe('xx');expect(budgets).toHaveLength(2);
      expect(budgets[1]).toBeGreaterThanOrEqual(1000);
      expect(budgets[1]).toBeLessThan(10_000);
    }
    expect(r.frames.find(f=>f.status==='error').error).toBe('finalize_continuation_budget_exhausted');
    expect(fs.readFileSync(r.action,'utf8')).toBe('x');
    expect(JSON.parse(fs.readFileSync(r.pending,'utf8')).afterFailedHold).toBe(true);
  },35000);

});

describe('W03: the held ready answer reaches the host', () => {
  it('a correction hands the plain-text draft over with the checkpoint', async () => {
    const r = await continuationFixture('success');
    expect(r.code, r.stderr).toBe(0);
    const held = r.frames.find((f) => f.finalizeHoldCheckpoint?.reason === 'correction_pending');
    expect(held.finalizeHoldCheckpoint.draftText).toBe(
      'Original document prepared. Which company should I use?',
    );
  }, 25_000);

  it('a continuation stopped before it began still hands the draft over before the error', async () => {
    const r = await continuationFixture('close');
    expect(r.code, r.stderr).toBe(0);
    const index = r.frames.findIndex((f) => f.finalizeHoldCheckpoint?.reason === 'continuation_interrupted');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(r.frames[index].finalizeHoldCheckpoint).toMatchObject({
      readyDraftHeld: true,
      draftText: 'Original document prepared. Which company should I use?',
    });
    const errorAt = r.frames.findIndex((f) => f.status === 'error');
    expect(errorAt).toBeGreaterThan(index);
  }, 25_000);

  it('the budget stop carries the latest draft; an image draft is never handed over', async () => {
    const stream = await continuationFixture('correction-stream');
    const blocked = stream.frames.find((f) => f.finalizeHoldCheckpoint?.reason === 'continuation_budget_exhausted');
    expect(blocked.finalizeHoldCheckpoint.draftText).toBe('Updated documents use fixture-company.');
    const image = await continuationFixture('image');
    const held = image.frames.find((f) => f.finalizeHoldCheckpoint?.reason === 'correction_pending');
    expect(held.finalizeHoldCheckpoint.draftText).toBeUndefined();
  }, 45_000);
});
