import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import { elideUnchangedStandingBlocks } from './index.js';
import { withTaskContinuityPolicy } from './task-continuity.js';

// Linux limits a single command-line argument to 128 KiB (MAX_ARG_STRLEN) and
// some prompts here are larger, so the harness goes to a file instead of
// `node -e`: on Linux the spawn failed with E2BIG.
const writeHarness = (root: string, code: string): string => {
  const file = path.join(root, `harness-${process.hrtime.bigint()}.cjs`);
  fs.writeFileSync(file, code);
  return file;
};

/**
 * W29: after a compaction the runner keeps re-sending only the standing
 * blocks the compacted thread no longer holds. The real provider loop runs
 * three times against a fake codex CLI that writes a fake rollout (no model,
 * MCP or network); each run is a separate runner process, like separate
 * messages in the chat.
 */
const THREAD_ID = 'bbbbbbbb-1111-2222-3333-444444444444';
const STANDING = [
  'chat_memory_index',
  'cross_channel_owner_context',
  'task_continuity',
  'tenant_long_term_context',
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

const hostPrompt = (message: string): string =>
  [
    '<tenant_long_term_context source="CLAUDE.md">\nПравила чата: отвечать коротко.\n</tenant_long_term_context>',
    '<chat_memory_index>\nLazy memory is enabled.\n<memory_file file="memory/topics/a.md" size_bytes="10" size="10 B" modified="2026-11-08T08:00:00.000Z" />\n</chat_memory_index>',
    '<cross_channel_owner_context>история WhatsApp</cross_channel_owner_context>',
    `<messages><message sender="Владелец">${message}</message></messages>`,
  ].join('\n\n');

function compactionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-compaction-'));
  roots.push(root);
  const group = path.join(root, 'group');
  const ipc = path.join(root, 'ipc');
  fs.mkdirSync(group);
  fs.mkdirSync(path.join(ipc, 'input'), { recursive: true });
  const fake = path.join(root, 'fake-codex.cjs');
  const runFile = path.join(root, 'run');
  const metaFile = path.join(group, '.codex-thread-meta.json');
  // What each run's compaction keeps of the user messages, and which standing
  // blocks the runner must then record as held — mid-turn already.
  //  1: a fresh thread; codex cut its first message inside the memory index.
  //  2: the cut first message plus the second one, which re-sent the index
  //     and the WhatsApp block in full.
  //  3: a summary-only compaction: nothing kept verbatim.
  const expectedMid: Record<number, string[]> = {
    1: ['task_continuity', 'tenant_long_term_context'],
    2: STANDING,
    3: [],
  };
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
    const fs = require('fs');
    const path = require('path');
    const args = process.argv.slice(2);
    const output = args[args.indexOf('--output-last-message') + 1];
    const root = ${JSON.stringify(root)};
    const run = Number(fs.readFileSync(${JSON.stringify(runFile)}, 'utf8'));
    const expected = ${JSON.stringify(expectedMid)}[run];
    const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '08');
    fs.mkdirSync(dir, { recursive: true });
    const rollout = path.join(dir, 'rollout-2026-11-08T09-00-00-${THREAD_ID}.jsonl');
    const record = (o) => fs.appendFileSync(rollout, JSON.stringify(o) + '\\n');
    const emit = (o) => console.log(JSON.stringify(o));
    const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (x) => (input += x));
    process.stdin.on('end', () => {
      fs.writeFileSync(path.join(root, 'seen-' + run), input);
      emit({ type: 'thread.started', thread_id: '${THREAD_ID}' });
      emit({ type: 'turn.started' });
      if (run === 1) record({ type: 'session_meta', payload: { id: '${THREAD_ID}' } });
      record({ type: 'response_item', payload: user(input) });
      let kept = [];
      if (run === 1) kept = [input.replace(/<\\/chat_memory_index>[\\s\\S]*$/, '…900 tokens truncated…')];
      if (run === 2) kept = [JSON.parse(fs.readFileSync(path.join(root, 'kept-1'), 'utf8'))[0], input];
      fs.writeFileSync(path.join(root, 'kept-' + run), JSON.stringify(kept));
      record({ type: 'compacted', payload: { message: '', replacement_history: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer rules' }] },
        ...kept.map(user),
        { type: 'compaction', encrypted_content: 'opaque' },
      ] } });
      // Like a turn killed right after the compaction: what is on disk now?
      const started = Date.now();
      const tick = setInterval(() => {
        let keys = null;
        try {
          keys = Object.keys(JSON.parse(fs.readFileSync(${JSON.stringify(metaFile)}, 'utf8')).standingBlocks || {}).sort();
        } catch {}
        const done = keys && JSON.stringify(keys) === JSON.stringify(expected);
        if (!done && Date.now() - started < 5000) return;
        clearInterval(tick);
        fs.writeFileSync(path.join(root, 'mid-' + run), JSON.stringify(keys));
        const final = 'Готово ' + run;
        emit({ type: 'item.completed', item: { type: 'agent_message', text: final } });
        emit({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } });
        fs.writeFileSync(output, final);
        process.exit(0);
      }, 50);
    });
  `,
    { mode: 0o755 },
  );

  const runOnce = async (run: number, message: string) => {
    fs.writeFileSync(runFile, String(run));
    const prompt = hostPrompt(message);
    const input = {
      prompt,
      groupFolder: 'fixture',
      chatJid: 'tg:fixture',
      isMain: true,
      provider: 'codex_cli',
      codex: { command: fake, model: 'fixture-model', timeoutMs: 15_000 },
    };
    const moduleUrl = pathToFileURL(
      path.resolve('agent/runner/src/index.ts'),
    ).href;
    const harness = `import(${JSON.stringify(moduleUrl)}).then(m => m.runCodexProviderLoop(${JSON.stringify(input)}, ${JSON.stringify(path.join(root, 'unused-mcp.js'))}, ${JSON.stringify(prompt)}, []));`;
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
          writeHarness(root, harness),
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            CODEX_HOME: path.join(root, 'codex-home'),
            CLAUDECLAW_GROUP_DIR: group,
            CLAUDECLAW_IPC_DIR: ipc,
            CLAUDECLAW_RUNNER_IDLE_WAIT_MS: '500',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`fixture timeout: ${stderr}`));
      }, 25_000);
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
    const read = (name: string) =>
      fs.readFileSync(path.join(root, name), 'utf8');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return {
      ...result,
      frames,
      prompt,
      seen: read(`seen-${run}`),
      midKeys: JSON.parse(read(`mid-${run}`)) as string[] | null,
      meta,
      threadId: fs.readFileSync(path.join(group, '.codex-thread-id'), 'utf8'),
    };
  };
  return { runOnce };
}

describe('standing context after a codex compaction (real runner + fake rollout)', () => {
  it('re-sends only the blocks the compacted thread no longer holds', async () => {
    const { runOnce } = compactionFixture();
    const stub = (tag: string) => `<${tag} unchanged="true"/>`;

    // Run 1: a fresh thread compacts mid-turn; codex kept the first message
    // only up to the middle of the memory index.
    const first = await runOnce(1, 'Первое сообщение');
    expect(first.code, first.stderr).toBe(0);
    expect(first.frames.some((f) => f.status === 'success' && f.result)).toBe(
      true,
    );
    const sentFirst = elideUnchangedStandingBlocks(
      withTaskContinuityPolicy(first.prompt),
      undefined,
    ).blocks;
    expect(Object.keys(sentFirst).sort()).toEqual(STANDING);
    expect(first.midKeys).toEqual([
      'task_continuity',
      'tenant_long_term_context',
    ]);
    // Before W29 this was {}: the next turn re-sent all four blocks.
    expect(first.meta.standingBlocks).toEqual({
      task_continuity: sentFirst.task_continuity,
      tenant_long_term_context: sentFirst.tenant_long_term_context,
    });
    expect(first.threadId).toBe(THREAD_ID);

    // Run 2: the thread resumes. CLAUDE.md and the policy are still in the
    // kept first message — stubs; the index and WhatsApp block go in full.
    const second = await runOnce(2, 'Второе сообщение');
    expect(second.code, second.stderr).toBe(0);
    expect(second.frames.some((f) => f.threadRotated)).toBe(false);
    expect(second.seen).toContain(stub('tenant_long_term_context'));
    expect(second.seen).toContain(stub('task_continuity'));
    expect(second.seen).not.toContain('Правила чата');
    expect(second.seen).toContain(
      '<chat_memory_index>\nLazy memory is enabled.',
    );
    expect(second.seen).toContain(
      '<cross_channel_owner_context>история WhatsApp</cross_channel_owner_context>',
    );
    expect(second.seen).toContain('Второе сообщение');
    // Its compaction kept both messages: all four blocks are held now.
    expect(second.midKeys).toEqual(STANDING);
    expect(second.meta.standingBlocks).toEqual(sentFirst);
    expect(second.threadId).toBe(THREAD_ID);

    // Run 3: everything is a stub. Its compaction keeps no message verbatim,
    // so — as before W29 — the next turn sends every block in full.
    const third = await runOnce(3, 'Третье сообщение');
    expect(third.code, third.stderr).toBe(0);
    expect(third.frames.some((f) => f.threadRotated)).toBe(false);
    for (const tag of STANDING) expect(third.seen).toContain(stub(tag));
    expect(third.seen).not.toContain('история WhatsApp');
    expect(third.seen).toContain('Третье сообщение');
    expect(third.midKeys).toEqual([]);
    expect(third.meta.standingBlocks).toEqual({});
    expect(third.meta.preambleHash).toBe(first.meta.preambleHash);
    expect(third.meta.createdAt).toBe(first.meta.createdAt);
    expect(third.threadId).toBe(THREAD_ID);
  }, 90_000);
});

/**
 * A fake codex that holds the thread's user messages the way codex 0.166
 * does: at a compaction it keeps the newest ones within 256 000 bytes and
 * cuts the oldest kept one in the middle. Each run follows a plan (when to
 * compact, what the answer is, what a link-correction turn does) and records
 * every stub of the turn's own message whose full copy the compaction did
 * not keep — a turn that went on without that block (W29 review).
 */
function plannedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-planned-'));
  roots.push(root);
  const group = path.join(root, 'group');
  const ipc = path.join(root, 'ipc');
  fs.mkdirSync(group);
  fs.mkdirSync(path.join(ipc, 'input'), { recursive: true });
  const fake = path.join(root, 'fake-codex.cjs');
  const planFile = path.join(root, 'plan.json');
  const metaFile = path.join(group, '.codex-thread-meta.json');
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
    const fs = require('fs');
    const path = require('path');
    const args = process.argv.slice(2);
    const output = args[args.indexOf('--output-last-message') + 1];
    const root = ${JSON.stringify(root)};
    const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}, 'utf8'));
    const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '08');
    fs.mkdirSync(dir, { recursive: true });
    const rollout = path.join(dir, 'rollout-2026-11-08T09-00-00-${THREAD_ID}.jsonl');
    const historyFile = path.join(root, 'history.json');
    const record = (o) => fs.appendFileSync(rollout, JSON.stringify(o) + '\\n');
    const emit = (o) => console.log(JSON.stringify(o));
    const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
    const KEEP = 256000;
    const keepByRule = (history) => {
      const out = [];
      let left = KEEP;
      for (let i = history.length - 1; i >= 0 && left > 0; i -= 1) {
        const buf = Buffer.from(history[i], 'utf8');
        if (buf.length <= left) { out.unshift(history[i]); left -= buf.length; continue; }
        const half = Math.floor(left / 2);
        out.unshift(buf.subarray(0, half).toString('utf8') + '…' + Math.ceil((buf.length - left) / 4) + ' tokens truncated…' + buf.subarray(buf.length - half).toString('utf8'));
        break;
      }
      return out;
    };
    const keepCut = (history, marker) => history.map((text, i) =>
      i === history.length - 1 || !text.includes(marker) ? text : text.slice(0, text.indexOf(marker)) + '…900 tokens truncated…');
    const holds = (text, tag) => {
      const plain = text.split('<' + tag + ' unchanged="true"/>').join('');
      return new RegExp('<' + tag + '(?:\\\\s[^>]*)?>[\\\\s\\\\S]*?</' + tag + '>').test(plain);
    };
    const dangling = (message, kept) =>
      [...message.matchAll(/<([a-z_]+) unchanged="true"\\/>/g)]
        .map((m) => m[1])
        .filter((tag) => !kept.some((text) => holds(text, tag)));
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (x) => (input += x));
    process.stdin.on('end', () => {
      const isFix = input.includes('<link_check source="system">');
      const step = isFix ? plan.fix || {} : plan;
      const name = plan.run + (isFix ? '-fix' : '');
      fs.writeFileSync(path.join(root, 'seen-' + name), input);
      emit({ type: 'thread.started', thread_id: '${THREAD_ID}' });
      emit({ type: 'turn.started' });
      if (!fs.existsSync(rollout)) record({ type: 'session_meta', payload: { id: '${THREAD_ID}' } });
      record({ type: 'event_msg', payload: { type: 'task_started' } });
      let history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : [];
      let lost = [];
      const compact = () => {
        const kept = step.keep === 'rule' ? keepByRule(history) : keepCut(history, step.keep);
        record({ type: 'compacted', payload: { message: '', replacement_history: [
          { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer rules' }] },
          ...kept.map(user),
          { type: 'compaction', encrypted_content: 'opaque' },
        ] } });
        fs.writeFileSync(path.join(root, 'kept-' + name), JSON.stringify(kept));
        history = kept.slice();
      };
      if (step.compact === 'before-input') compact();
      record({ type: 'response_item', payload: user(input) });
      if (step.compact === 'before-input') lost = dangling(input, history);
      history.push(input);
      if (step.compact === 'after-input') {
        compact();
        lost = dangling(input, history.slice(0, -1));
      }
      fs.writeFileSync(historyFile, JSON.stringify(history));
      fs.writeFileSync(path.join(root, 'dangling-' + name), JSON.stringify(lost));
      const final = step.answer || 'Готово ' + plan.run;
      emit({ type: 'item.completed', item: { type: 'agent_message', text: final } });
      emit({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } });
      fs.writeFileSync(output, final);
      process.exit(0);
    });
  `,
    { mode: 0o755 },
  );

  type Step = {
    compact?: 'before-input' | 'after-input';
    keep?: string;
    answer?: string;
  };
  const runOnce = async (
    plan: Step & { run: string; fix?: Step },
    prompt: string,
    options: { linkCheck?: boolean } = {},
  ) => {
    fs.writeFileSync(planFile, JSON.stringify(plan));
    const input = {
      prompt,
      groupFolder: 'fixture',
      chatJid: 'tg:fixture',
      isMain: true,
      provider: 'codex_cli',
      codex: { command: fake, model: 'fixture-model', timeoutMs: 200_000 },
      ...(options.linkCheck ? { linkCheck: { mode: 'fix' } } : {}),
    };
    const moduleUrl = pathToFileURL(
      path.resolve('agent/runner/src/index.ts'),
    ).href;
    // No network: the dead link's host does not resolve, the canary does.
    const offline = `const dns = require('node:dns');
      const missing = () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
      dns.promises.lookup = (host) => host === 'chatgpt.com' ? Promise.resolve([{ address: '93.184.216.34', family: 4 }]) : missing();
      dns.promises.resolve = () => missing();
      globalThis.fetch = () => Promise.reject(new Error('no network in this test'));`;
    const harness = `${offline}
      import(${JSON.stringify(moduleUrl)}).then(m => m.runCodexProviderLoop(${JSON.stringify(input)}, ${JSON.stringify(path.join(root, 'unused-mcp.js'))}, ${JSON.stringify(prompt)}, []));`;
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
          writeHarness(root, harness),
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            CODEX_HOME: path.join(root, 'codex-home'),
            CLAUDECLAW_GROUP_DIR: group,
            CLAUDECLAW_IPC_DIR: ipc,
            CLAUDECLAW_RUNNER_IDLE_WAIT_MS: '500',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`fixture timeout: ${stderr}`));
      }, 40_000);
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
    const read = (name: string): string | null => {
      try {
        return fs.readFileSync(path.join(root, name), 'utf8');
      } catch {
        return null;
      }
    };
    return {
      ...result,
      frames,
      seen: read(`seen-${plan.run}`) ?? '',
      seenFix: read(`seen-${plan.run}-fix`),
      kept: JSON.parse(read(`kept-${plan.run}`) ?? 'null') as string[] | null,
      keptFix: JSON.parse(read(`kept-${plan.run}-fix`) ?? 'null') as
        | string[]
        | null,
      dangling: JSON.parse(read(`dangling-${plan.run}`) ?? '[]') as string[],
      danglingFix: JSON.parse(
        read(`dangling-${plan.run}-fix`) ?? '[]',
      ) as string[],
      meta: JSON.parse(fs.readFileSync(metaFile, 'utf8')) as {
        preambleHash: string;
        createdAt: string;
        standingBlocks?: Record<string, string>;
        standingBytes?: Record<string, number>;
      },
      threadId: fs.readFileSync(path.join(group, '.codex-thread-id'), 'utf8'),
    };
  };
  return { runOnce };
}

const bytesOf = (...texts: string[]): number =>
  texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
const eachTag = (n: number) =>
  Object.fromEntries(STANDING.map((tag) => [tag, n]));
const rulesPrompt = (rules: string, message: string): string =>
  [
    `<tenant_long_term_context source="CLAUDE.md">\n${rules}\n</tenant_long_term_context>`,
    '<chat_memory_index>\nLazy memory is enabled.\n<memory_file file="memory/topics/a.md" size_bytes="10" size="10 B" modified="2026-11-08T08:00:00.000Z" />\n</chat_memory_index>',
    '<cross_channel_owner_context>история WhatsApp</cross_channel_owner_context>',
    `<messages><message sender="Владелец">${message}</message></messages>`,
  ].join('\n\n');
const stubOf = (tag: string) => `<${tag} unchanged="true"/>`;

describe('W29 review: stubs, compactions and the order of events (real runner + codex-like fake)', () => {
  it('re-sends a block before its only copy grows too old to survive a compaction', async () => {
    const { runOnce } = plannedFixture();
    // Run 1: a fresh thread, every block in full; no compaction.
    const first = await runOnce(
      { run: '1' },
      rulesPrompt('Правила чата', 'Первое'),
    );
    expect(first.code, first.stderr).toBe(0);
    const b1 = bytesOf(first.seen);
    expect(first.meta.standingBytes).toEqual(eachTag(b1));

    // Run 2: a long message; the copies are still fresh enough — stubs. Its
    // compaction keeps both messages (they fit into 256 000 bytes).
    const filler2 = 'x'.repeat(190_000 - b1 - 2_000);
    const second = await runOnce(
      { run: '2', compact: 'after-input', keep: 'rule' },
      rulesPrompt('Правила чата', `Второе ${filler2}`),
    );
    expect(second.code, second.stderr).toBe(0);
    for (const tag of STANDING) expect(second.seen).toContain(stubOf(tag));
    expect(b1 + bytesOf(second.seen)).toBeLessThanOrEqual(200_000);
    expect(second.dangling).toEqual([]);
    expect(second.kept).toEqual([first.seen, second.seen]);
    expect(second.meta.standingBytes).toEqual(
      eachTag(b1 + bytesOf(second.seen)),
    );

    // Run 3: another long message. With stubs, run 3 and run 2 alone would
    // fill the 256 000 bytes and codex would cut run 1 — the only full copy
    // (as first implemented, all four blocks were lost for the rest of the
    // turn). The copies are too old now: everything goes in full.
    const b2 = bytesOf(second.seen);
    const filler3 = 'y'.repeat(256_000 - b2 + 500);
    const third = await runOnce(
      { run: '3', compact: 'after-input', keep: 'rule' },
      rulesPrompt('Правила чата', `Третье ${filler3}`),
    );
    expect(third.code, third.stderr).toBe(0);
    for (const tag of STANDING) expect(third.seen).not.toContain(stubOf(tag));
    expect(third.seen).toContain('Правила чата');
    expect(third.seen).toContain('история WhatsApp');
    expect(third.dangling).toEqual([]);
    // Codex kept run 3 whole and only a cut of run 2: the copies of run 3.
    expect(third.kept?.at(-1)).toBe(third.seen);
    expect(third.kept?.[0]).toContain('tokens truncated');
    expect(third.meta.standingBytes).toEqual(eachTag(bytesOf(third.seen)));

    // Run 4: a short message — stubs again, pointing to run 3's copies.
    const fourth = await runOnce(
      { run: '4', compact: 'after-input', keep: 'rule' },
      rulesPrompt('Правила чата', 'Четвёртое'),
    );
    expect(fourth.code, fourth.stderr).toBe(0);
    for (const tag of STANDING) expect(fourth.seen).toContain(stubOf(tag));
    expect(fourth.dangling).toEqual([]);
    expect(fourth.meta.preambleHash).toBe(first.meta.preambleHash);
    expect(fourth.meta.createdAt).toBe(first.meta.createdAt);
    expect(fourth.threadId).toBe(THREAD_ID);
    expect(fourth.frames.some((f) => f.threadRotated)).toBe(false);
  }, 120_000);

  it('a compaction before the turn input: the blocks that input sent in full count as the latest', async () => {
    const { runOnce } = plannedFixture();
    const first = await runOnce(
      { run: '1' },
      rulesPrompt('Правила v1', 'Первое'),
    );
    expect(first.code, first.stderr).toBe(0);

    // Run 2 changes CLAUDE.md; codex compacts at the very start of the turn
    // (kept: run 1 with v1) and records the message with v2 after that.
    const prompt2 = rulesPrompt('Правила v2', 'Правила поменялись');
    const second = await runOnce(
      { run: '2', compact: 'before-input', keep: 'rule' },
      prompt2,
    );
    expect(second.code, second.stderr).toBe(0);
    expect(second.seen).toContain('Правила v2');
    expect(second.kept).toEqual([first.seen]);
    expect(second.dangling).toEqual([]);
    const v2 = elideUnchangedStandingBlocks(
      withTaskContinuityPolicy(prompt2),
      undefined,
    ).blocks;
    expect(second.meta.standingBlocks?.tenant_long_term_context).toBe(
      v2.tenant_long_term_context,
    );
    const b1 = bytesOf(first.seen);
    const b2 = bytesOf(second.seen);
    expect(second.meta.standingBytes).toEqual({
      ...eachTag(b1 + b2),
      tenant_long_term_context: b2,
    });

    // Run 3: CLAUDE.md is back at v1. The model's latest copy is v2, so v1
    // goes in full; a stub here would be read as v2.
    const third = await runOnce(
      { run: '3' },
      rulesPrompt('Правила v1', 'Вернул'),
    );
    expect(third.code, third.stderr).toBe(0);
    expect(third.seen).toContain('Правила v1');
    expect(third.seen).not.toContain(stubOf('tenant_long_term_context'));
    expect(third.seen).toContain(stubOf('chat_memory_index'));
  }, 120_000);

  it('a link correction that compacts the thread leaves what its compaction kept; one that does not makes the copies older', async () => {
    const { runOnce } = plannedFixture();
    const dead = 'https://dead-fixture-host.com/page';
    const first = await runOnce(
      { run: '1' },
      rulesPrompt('Правила чата', 'Привет'),
    );
    expect(first.code, first.stderr).toBe(0);
    expect(first.meta.standingBytes).toEqual(eachTag(bytesOf(first.seen)));

    // Run 2 (a resumed thread): the answer has a dead link; the correction
    // turn compacts the thread, keeping the older messages only up to their
    // memory index.
    const second = await runOnce(
      {
        run: '2',
        answer: `Смотри ${dead}`,
        fix: {
          compact: 'after-input',
          keep: '</chat_memory_index>',
          answer: 'Смотри',
        },
      },
      rulesPrompt('Правила чата', 'Дай ссылку'),
      { linkCheck: true },
    );
    expect(second.code, second.stderr).toBe(0);
    for (const tag of STANDING) expect(second.seen).toContain(stubOf(tag));
    expect(second.seenFix).toContain('<link_check source="system">');
    expect(second.keptFix?.[0]).toContain('tokens truncated');
    const kept = bytesOf(...(second.keptFix ?? []));
    // Neither {} (before W29) nor what the main turn left (all four blocks).
    expect(second.meta.standingBlocks).toEqual({
      task_continuity: first.meta.standingBlocks?.task_continuity,
      tenant_long_term_context:
        first.meta.standingBlocks?.tenant_long_term_context,
    });
    expect(second.meta.standingBytes).toEqual({
      task_continuity: kept,
      tenant_long_term_context: kept,
    });
    expect(second.danglingFix).toEqual([]);

    // Run 3: the index and the WhatsApp block go in full again. The answer
    // has a dead link again, and this correction does not compact: its
    // message is one more on the thread, every copy is older by its bytes.
    const third = await runOnce(
      { run: '3', answer: `Вот ${dead}`, fix: { answer: 'Вот' } },
      rulesPrompt('Правила чата', 'Ещё ссылку'),
      { linkCheck: true },
    );
    expect(third.code, third.stderr).toBe(0);
    expect(third.seen).toContain(stubOf('tenant_long_term_context'));
    expect(third.seen).toContain(stubOf('task_continuity'));
    expect(third.seen).toContain('история WhatsApp');
    expect(third.seenFix).toContain('<link_check source="system">');
    const turn = bytesOf(third.seen, third.seenFix ?? '');
    expect(third.meta.standingBytes).toEqual({
      task_continuity: kept + turn,
      tenant_long_term_context: kept + turn,
      chat_memory_index: turn,
      cross_channel_owner_context: turn,
    });
    expect(third.threadId).toBe(THREAD_ID);
  }, 120_000);
});
