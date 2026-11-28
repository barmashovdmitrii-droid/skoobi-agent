import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_THREAD_MAX_ROLLOUT_BYTES,
  CODEX_TIER_ROTATION_MIN_INTERVAL_MS,
  codexThreadCreationTier,
  codexThreadTierMeta,
  codexTierRotationDue,
  codexTurnTelemetry,
  readCodexTierRotationAt,
  recordCodexTierRotation,
  shouldRotateCodexThread,
  type CodexTierRotationInput,
} from './index.js';

/**
 * W02: codex 0.166 applied Fast only on a thread's first turn. The
 * thread meta records the tier a thread was born with, and every turn tells
 * the host which tier its thread was born with.
 */
describe('codex thread tier meta (W02)', () => {
  it('a fresh thread records what its first turn asked for and what codex applied', () => {
    expect(
      codexThreadTierMeta({ fresh: true, requested: 'priority', applied: 'priority' }),
    ).toEqual({ requestedServiceTier: 'priority', appliedServiceTier: 'priority' });
    // A thread born while the configuration said standard.
    expect(
      codexThreadTierMeta({ fresh: true, requested: undefined, applied: null }),
    ).toEqual({ requestedServiceTier: null, appliedServiceTier: null });
    // Saved early (before codex reported its settings): no applied tier yet.
    expect(codexThreadTierMeta({ fresh: true, requested: 'priority' })).toEqual({
      requestedServiceTier: 'priority',
    });
  });

  it('a resumed thread keeps the tier it was born with', () => {
    const meta = {
      preambleHash: 'h',
      createdAt: '2026-11-08T10:00:00.000Z',
      requestedServiceTier: 'priority' as const,
      appliedServiceTier: 'priority',
    };
    expect(codexThreadTierMeta({ fresh: false, meta })).toEqual({
      requestedServiceTier: 'priority',
      appliedServiceTier: 'priority',
    });
    // A thread older than the fields: nothing is invented.
    expect(
      codexThreadTierMeta({
        fresh: false,
        meta: { preambleHash: 'h', createdAt: '2026-11-03T08:14:22.484Z' },
      }),
    ).toEqual({});
    expect(codexThreadTierMeta({ fresh: false, meta: null })).toEqual({});
  });

  it('reads the birth tier only from a well-formed field', () => {
    expect(codexThreadCreationTier({ requestedServiceTier: 'priority' })).toBe('priority');
    expect(codexThreadCreationTier({ requestedServiceTier: null })).toBeNull();
    expect(codexThreadCreationTier({})).toBeUndefined();
    expect(codexThreadCreationTier(null)).toBeUndefined();
    expect(
      codexThreadCreationTier({
        requestedServiceTier: 'fast' as unknown as 'priority',
      }),
    ).toBeUndefined();
  });

  it('the turn telemetry carries the thread birth tier when it is known', () => {
    expect(
      codexTurnTelemetry({ appliedServiceTier: null }, undefined, {
        requestedServiceTier: 'priority',
        fastTierDroppedForQuota: false,
        threadServiceTier: null,
      }),
    ).toEqual({
      serviceTier: null,
      requestedServiceTier: 'priority',
      threadServiceTier: null,
    });
    expect(
      codexTurnTelemetry({ appliedServiceTier: null }, undefined, {
        requestedServiceTier: 'priority',
        fastTierDroppedForQuota: false,
      }),
    ).toEqual({ serviceTier: null, requestedServiceTier: 'priority' });
  });
});

describe('tier rotation (W02, only with SKOOBI_CODEX_TIER_ROTATE)', () => {
  const NOW = Date.parse('2026-11-10T09:00:00.000Z');
  const meta = (tier?: 'priority' | null) => ({
    preambleHash: 'hash-a',
    createdAt: '2026-11-10T08:00:00.000Z',
    ...(tier !== undefined ? { requestedServiceTier: tier } : {}),
  });
  const tier = (over: Partial<CodexTierRotationInput> = {}): CodexTierRotationInput => ({
    requested: 'priority',
    usedPercent: 40,
    ceiling: 70,
    pendingMessages: false,
    ...over,
  });

  it('moves a thread born without Fast to Fast only well below the ceiling', () => {
    expect(codexTierRotationDue(meta(null), tier({ usedPercent: 40 }), NOW)).toBe(true);
    expect(codexTierRotationDue(meta(null), tier({ usedPercent: 60 }), NOW)).toBe(true);
    // Between the ceiling and 10 points below it the tier would flip with
    // every reading of the limit.
    expect(codexTierRotationDue(meta(null), tier({ usedPercent: 61 }), NOW)).toBe(false);
    expect(codexTierRotationDue(meta(null), tier({ usedPercent: 69 }), NOW)).toBe(false);
    // An unknown limit is no reason to drop the conversation.
    expect(codexTierRotationDue(meta(null), tier({ usedPercent: null }), NOW)).toBe(false);
    // A configured ceiling of 100: back to Fast at 90 or less.
    expect(
      codexTierRotationDue(meta(null), tier({ ceiling: 100, usedPercent: 89 }), NOW),
    ).toBe(true);
  });

  it('moves a thread born with Fast off it at once when Fast is off now', () => {
    // At the ceiling the runner stops asking for Fast; a thread born with
    // it would keep spending the quota faster.
    expect(
      codexTierRotationDue(meta('priority'), tier({ requested: null, usedPercent: 70 }), NOW),
    ).toBe(true);
    // Fast switched off in .env: no limit reading at all.
    expect(
      codexTierRotationDue(meta('priority'), tier({ requested: null, usedPercent: null }), NOW),
    ).toBe(true);
  });

  it('never moves a thread when Fast is withheld only for want of a quota reading (r1109, item 5)', () => {
    // Born with Fast; the limit is unknown, so this turn asks for the
    // standard tier — no reason to drop the conversation.
    expect(
      codexTierRotationDue(
        meta('priority'),
        tier({ requested: null, usedPercent: null, quotaUnknown: true }),
        NOW,
      ),
    ).toBe(false);
    // Without the mark (Fast off in .env) it still moves, as before.
    expect(
      codexTierRotationDue(meta('priority'), tier({ requested: null, usedPercent: null }), NOW),
    ).toBe(true);
  });

  it('decides only by the birth tier, never by a resumed turn without the tier', () => {
    // Born with Fast and asking for Fast: nothing to change, even if codex
    // applies no tier on resume (a fresh thread would lose it again).
    expect(codexTierRotationDue(meta('priority'), tier(), NOW)).toBe(false);
    expect(
      codexTierRotationDue(meta(null), tier({ requested: null, usedPercent: 90 }), NOW),
    ).toBe(false);
    // Unknown birth tier: threads from before the field existed.
    expect(codexTierRotationDue(meta(), tier(), NOW)).toBe(false);
    expect(codexTierRotationDue(null, tier(), NOW)).toBe(false);
  });

  it('at most once a day per chat, and never with messages waiting', () => {
    const recent = NOW - CODEX_TIER_ROTATION_MIN_INTERVAL_MS + 60_000;
    expect(codexTierRotationDue(meta(null), tier({ lastRotationAt: recent }), NOW)).toBe(false);
    expect(
      codexTierRotationDue(
        meta(null),
        tier({ lastRotationAt: NOW - CODEX_TIER_ROTATION_MIN_INTERVAL_MS }),
        NOW,
      ),
    ).toBe(true);
    // A mark from the future (clock moved back) also holds it off.
    expect(
      codexTierRotationDue(meta(null), tier({ lastRotationAt: NOW + 60_000 }), NOW),
    ).toBe(false);
    expect(codexTierRotationDue(meta(null), tier({ pendingMessages: true }), NOW)).toBe(false);
  });

  it('shouldRotateCodexThread: off without the switch, after the other reasons', () => {
    expect(shouldRotateCodexThread(meta(null), 'hash-a', NOW)).toBeNull();
    expect(
      shouldRotateCodexThread(meta(null), 'hash-a', NOW, undefined, undefined, undefined, tier()),
    ).toBe('tier-changed');
    // A missing rollout no longer ends the check before the tier.
    expect(
      shouldRotateCodexThread(meta(null), 'hash-a', NOW, 0, undefined, undefined, tier()),
    ).toBe('tier-changed');
    expect(
      shouldRotateCodexThread(meta(null), 'hash-b', NOW, undefined, undefined, undefined, tier()),
    ).toBe('context-changed');
    expect(
      shouldRotateCodexThread(
        meta(null),
        'hash-a',
        NOW,
        CODEX_THREAD_MAX_ROLLOUT_BYTES + 1,
        NOW - 24 * 60 * 60 * 1000,
        undefined,
        tier(),
      ),
    ).toBe('oversized');
    expect(
      shouldRotateCodexThread(meta('priority'), 'hash-a', NOW, 1000, NOW, undefined, tier()),
    ).toBeNull();
  });

  it('keeps the once-a-day mark apart from the thread files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-mark-'));
    roots.push(dir);
    const file = path.join(dir, '.codex-tier-rotation.json');
    expect(readCodexTierRotationAt(file)).toBeUndefined();
    expect(
      recordCodexTierRotation(file, {
        at: '2026-11-10T09:00:00.000Z',
        threadId: 'aaaaaaa1-1111-2222-3333-444444444444',
        from: null,
        to: 'priority',
        usedPercent: 40,
      }),
    ).toBe(true);
    expect(readCodexTierRotationAt(file)).toBe(NOW);
    // A damaged mark still counts, by its write time.
    fs.writeFileSync(file, '{"at":');
    const written = fs.statSync(file).mtimeMs;
    expect(readCodexTierRotationAt(file)).toBe(written);
    expect(
      recordCodexTierRotation(path.join(dir, 'missing', 'mark.json'), {
        at: '2026-11-10T09:00:00.000Z',
        threadId: 'x',
        from: null,
        to: 'priority',
        usedPercent: null,
      }),
    ).toBe(false);
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * One chat with a local fake codex CLI (no model, MCP or network). As
 * measured on codex 0.166: a thread gets the tier asked for on its
 * first turn, and `-c service_tier` on `exec resume` is ignored. What a
 * thread born WITH Fast does on resume is NOT measured yet (checked on the
 * next natural rotation), so the fake plays both hypotheses:
 * - 'A' (default): the thread keeps the tier it was born with;
 * - 'B': no tier is ever applied on resume.
 * With `tokenCounts` the fake also keeps the thread's running token totals
 * (a token_count in the rollout, the total in turn.completed) like codex
 * does, so the runner can tell a resumed turn ('turn_delta') from a first one.
 */
function tierChat(
  variant: 'A' | 'B' = 'A',
  fixture: { tokenCounts?: boolean } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-tier-'));
  roots.push(root);
  const group = path.join(root, 'group');
  const ipc = path.join(root, 'ipc');
  const inputDir = path.join(ipc, 'input');
  const codexHome = path.join(root, 'codex-home');
  const calls = path.join(root, 'calls.jsonl');
  const births = path.join(root, 'births');
  fs.mkdirSync(group);
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(births);
  const fake = path.join(root, 'fake-codex.cjs');
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
    const fs = require('fs');
    const path = require('path');
    const args = process.argv.slice(2);
    const output = args[args.indexOf('--output-last-message') + 1];
    const resumeAt = args.indexOf('resume');
    const asked = args.includes('service_tier="priority"') ? 'priority' : null;
    const n = fs.existsSync(${JSON.stringify(calls)})
      ? fs.readFileSync(${JSON.stringify(calls)}, 'utf8').split('\\n').filter(Boolean).length + 1
      : 1;
    const threadId = resumeAt >= 0 ? args[resumeAt + 1] : 'aaaaaaa' + n + '-1111-2222-3333-444444444444';
    const birth = path.join(${JSON.stringify(births)}, threadId);
    if (resumeAt < 0) fs.writeFileSync(birth, JSON.stringify(asked));
    const applied = resumeAt >= 0 && ${JSON.stringify(variant)} === 'B'
      ? null
      : JSON.parse(fs.readFileSync(birth, 'utf8'));
    const turnsOnThread = (fs.existsSync(${JSON.stringify(calls)})
      ? fs.readFileSync(${JSON.stringify(calls)}, 'utf8').split('\\n').filter(Boolean)
          .filter((line) => JSON.parse(line).threadId === threadId).length
      : 0) + 1;
    const tokenCounts = ${JSON.stringify(fixture.tokenCounts === true)};
    const totals = { input_tokens: 10 * turnsOnThread, cached_input_tokens: 0, output_tokens: turnsOnThread };
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ threadId, resumed: resumeAt >= 0, asked, applied }) + '\\n');
    const rollout = path.join(${JSON.stringify(codexHome)}, 'sessions', '2026', '11', '08', 'rollout-2026-11-08T10-00-00-' + threadId + '.jsonl');
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    const record = (obj) => fs.appendFileSync(rollout, JSON.stringify(obj) + '\\n');
    const emit = (x) => console.log(JSON.stringify(x));
    process.stdin.resume();
    process.stdin.on('end', () => {
      emit({ type: 'thread.started', thread_id: threadId });
      emit({ type: 'turn.started' });
      if (resumeAt < 0) record({ type: 'session_meta', payload: { id: threadId, cli_version: '0.166.0' } });
      record({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: {
        model: 'fixture-model', reasoning_effort: 'xhigh', ...(applied ? { service_tier: applied } : {}) } } });
      if (tokenCounts) record({ type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: totals, last_token_usage: { input_tokens: 10, output_tokens: 1 } } } });
      setTimeout(() => {
        emit({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture answer ' + n } });
        emit({ type: 'turn.completed', usage: tokenCounts ? totals : { input_tokens: 10, output_tokens: 1 } });
        fs.writeFileSync(output, 'fixture answer ' + n);
        fs.writeFileSync(${JSON.stringify(path.join(inputDir, '_close'))}, '');
        process.exit(0);
      }, 300);
    });
  `,
    { mode: 0o755 },
  );

  const run = async (opts: {
    serviceTier?: 'priority';
    ceiling?: number;
    usedPercent?: number | null;
    /** SKOOBI_CODEX_SERVICE_TIER_UNKNOWN_QUOTA as the host passes it. */
    unknownQuota?: 'priority' | 'standard';
    tierRotate?: boolean;
    pending?: boolean;
    /** Forwarded or quoted text: the host runs the turn on a one-off thread. */
    indirect?: boolean;
  }) => {
    const codex = {
      command: fake,
      model: 'fixture-model',
      timeoutMs: 10_000,
      ...(opts.serviceTier
        ? {
            serviceTier: opts.serviceTier,
            serviceTierMaxUsedPercent: opts.ceiling ?? 70,
            accountUsedPercent: opts.usedPercent ?? null,
            ...(opts.unknownQuota ? { serviceTierUnknownQuota: opts.unknownQuota } : {}),
          }
        : {}),
      ...(opts.tierRotate ? { tierRotate: true } : {}),
    };
    const input = {
      prompt: 'Как дела?',
      groupFolder: 'fixture',
      chatJid: 'tg:fixture',
      isMain: true,
      provider: 'codex_cli',
      codex,
      ...(opts.indirect ? { indirectOwnerContent: true } : {}),
    };
    const pendingFiles = opts.pending
      ? [{ name: '1700000000001-next.json', type: 'message', text: 'И ещё вопрос' }]
      : [];
    for (const file of pendingFiles) {
      fs.writeFileSync(path.join(inputDir, file.name), JSON.stringify(file));
    }
    const prompt =
      input.prompt + pendingFiles.map((file) => `\n${file.text}`).join('');
    const moduleUrl = pathToFileURL(path.resolve('agent/runner/src/index.ts')).href;
    const harness = `import(${JSON.stringify(moduleUrl)}).then(m => m.runCodexProviderLoop(${JSON.stringify(input)}, ${JSON.stringify(path.join(root, 'unused-mcp.js'))}, ${JSON.stringify(prompt)}, ${JSON.stringify(pendingFiles)}));`;
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), '-e', harness],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              HOME: root,
              CODEX_HOME: codexHome,
              CLAUDECLAW_GROUP_DIR: group,
              CLAUDECLAW_IPC_DIR: ipc,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`fixture timeout: ${stderr}`));
        }, 20_000);
        child.stdout.on('data', (x) => (stdout += x));
        child.stderr.on('data', (x) => (stderr += x));
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timeout);
          resolve({ stdout, stderr, code });
        });
      },
    );
    // The fake's _close ends the loop; the next run starts without it.
    fs.rmSync(path.join(inputDir, '_close'), { force: true });
    for (const name of fs.readdirSync(inputDir)) {
      fs.rmSync(path.join(inputDir, name), { force: true });
    }
    const frames = [
      ...result.stdout.matchAll(
        /---CLAUDECLAW_OUTPUT_START---\n([\s\S]*?)\n---CLAUDECLAW_OUTPUT_END---/g,
      ),
    ].map((match) => JSON.parse(match[1]));
    const success = frames.find((f) => f.status === 'success' && f.result);
    return {
      ...result,
      frames,
      success,
      rotations: frames
        .filter((f) => f.threadRotated)
        .map((f) => f.threadRotated.reason as string),
    };
  };

  const meta = () =>
    JSON.parse(fs.readFileSync(path.join(group, '.codex-thread-meta.json'), 'utf8'));
  const threadId = () =>
    fs.readFileSync(path.join(group, '.codex-thread-id'), 'utf8').trim();
  const callLog = () =>
    fs
      .readFileSync(calls, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const tierRotationFile = path.join(group, '.codex-tier-rotation.json');
  return { run, meta, threadId, callLog, tierRotationFile, group };
}

describe('tier rotation in the real runner (fake codex 0.166)', () => {
  it('with the switch on, a thread born without Fast moves to a fresh one, once a day (variant A)', async () => {
    const chat = tierChat();
    await chat.run({});
    const born = chat.threadId();
    expect(chat.meta().requestedServiceTier).toBeNull();

    const second = await chat.run({
      serviceTier: 'priority',
      usedPercent: 40,
      tierRotate: true,
    });
    expect(second.code, second.stderr).toBe(0);
    expect(second.rotations).toEqual(['tier-changed']);
    expect(chat.threadId()).not.toBe(born);
    expect(chat.callLog()[1]).toMatchObject({ resumed: false, asked: 'priority', applied: 'priority' });
    expect(chat.meta()).toMatchObject({
      requestedServiceTier: 'priority',
      appliedServiceTier: 'priority',
    });
    expect(second.success.codexTurn).toMatchObject({
      requestedServiceTier: 'priority',
      serviceTier: 'priority',
      threadServiceTier: 'priority',
    });
    expect(JSON.parse(fs.readFileSync(chat.tierRotationFile, 'utf8'))).toMatchObject({
      threadId: born,
      from: null,
      to: 'priority',
      usedPercent: 40,
    });

    // The limit passes the ceiling within the day: Fast is not asked for,
    // but the thread stays — once a day per chat, in either direction (the
    // spec's limit; under variant A Fast runs on past the ceiling until the
    // day is over — DEPLOY.md, section 3).
    const third = await chat.run({
      serviceTier: 'priority',
      usedPercent: 75,
      tierRotate: true,
    });
    expect(third.code, third.stderr).toBe(0);
    expect(third.rotations).toEqual([]);
    expect(chat.callLog()[2]).toMatchObject({ resumed: true, asked: null });
    expect(third.success.codexTurn).toMatchObject({
      requestedServiceTier: null,
      fastTierDroppedForQuota: true,
      threadServiceTier: 'priority',
      // Variant A: codex kept Fast — the host marks it
      // fast_applied_unrequested and the panel «Fast применён, хотя не
      // запрошен».
      serviceTier: 'priority',
    });
  }, 60_000);

  it('variant B (no tier on resume ever): with the switch on, Fast asked for on every turn never rotates the thread', async () => {
    const chat = tierChat('B');
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      const run = await chat.run({
        serviceTier: 'priority',
        usedPercent: 40,
        tierRotate: true,
      });
      expect(run.code, run.stderr).toBe(0);
      runs.push(run);
    }
    const born = chat.callLog()[0].threadId;
    // No rotation loop: the thread is born with Fast and keeps that birth
    // tier, so nothing is decided by the resumed turns that ran without it.
    expect(runs.flatMap((r) => r.rotations)).toEqual([]);
    expect(chat.threadId()).toBe(born);
    expect(fs.existsSync(chat.tierRotationFile)).toBe(false);
    expect(chat.callLog().map((c) => [c.threadId, c.resumed, c.asked, c.applied])).toEqual([
      [born, false, 'priority', 'priority'],
      [born, true, 'priority', null],
      [born, true, 'priority', null],
    ]);
    expect(chat.meta()).toMatchObject({
      requestedServiceTier: 'priority',
      appliedServiceTier: 'priority',
    });
    expect(runs[0].success.codexTurn).toMatchObject({
      requestedServiceTier: 'priority',
      serviceTier: 'priority',
      threadServiceTier: 'priority',
    });
    // Turns 2 and 3: asked for, not applied, thread born with Fast — the
    // host writes tier_mismatch for exactly this (codexTierMismatch).
    for (const run of runs.slice(1)) {
      expect(run.success.codexTurn).toMatchObject({
        requestedServiceTier: 'priority',
        serviceTier: null,
        threadServiceTier: 'priority',
      });
      expect(run.success.codexTurn.fastTierDroppedForQuota).toBeUndefined();
    }
  }, 90_000);

  it('does not cut the thread under waiting messages or for an unknown birth tier', async () => {
    const chat = tierChat();
    await chat.run({});
    const born = chat.threadId();
    const pending = await chat.run({
      serviceTier: 'priority',
      usedPercent: 40,
      tierRotate: true,
      pending: true,
    });
    expect(pending.code, pending.stderr).toBe(0);
    expect(pending.rotations).toEqual([]);
    expect(chat.threadId()).toBe(born);
    expect(fs.existsSync(chat.tierRotationFile)).toBe(false);

    // A thread from before the field.
    const metaFile = path.join(chat.group, '.codex-thread-meta.json');
    const legacy = chat.meta();
    delete legacy.requestedServiceTier;
    delete legacy.appliedServiceTier;
    fs.writeFileSync(metaFile, JSON.stringify(legacy));
    const old = await chat.run({ serviceTier: 'priority', usedPercent: 40, tierRotate: true });
    expect(old.code, old.stderr).toBe(0);
    expect(old.rotations).toEqual([]);
    expect(chat.threadId()).toBe(born);
    expect(old.success.codexTurn.threadServiceTier).toBeUndefined();
    expect(old.success.codexTurn).toMatchObject({
      requestedServiceTier: 'priority',
      serviceTier: null,
    });
  }, 60_000);
});

describe('thread birth tier in the real runner (fake codex 0.166)', () => {
  it('records the tier in the meta and reports a resumed turn that ran without Fast', async () => {
    const chat = tierChat();
    // Born while the configuration said standard.
    const first = await chat.run({});
    expect(first.code, first.stderr).toBe(0);
    expect(chat.meta()).toMatchObject({
      requestedServiceTier: null,
      appliedServiceTier: null,
    });
    expect(first.success.codexTurn).toMatchObject({
      requestedServiceTier: null,
      serviceTier: null,
      threadServiceTier: null,
    });

    // Fast switched back on: asked for, not applied.
    const second = await chat.run({ serviceTier: 'priority', usedPercent: 40 });
    expect(second.code, second.stderr).toBe(0);
    expect(second.rotations).toEqual([]);
    expect(chat.callLog()[1]).toMatchObject({ resumed: true, asked: 'priority', applied: null });
    expect(second.success.codexTurn).toMatchObject({
      requestedServiceTier: 'priority',
      serviceTier: null,
      threadServiceTier: null,
    });
    // The resumed turn does not rewrite the birth tier.
    expect(chat.meta()).toMatchObject({
      requestedServiceTier: null,
      appliedServiceTier: null,
    });
  }, 45_000);

  it('a thread born with Fast says so on every turn', async () => {
    const chat = tierChat();
    const first = await chat.run({ serviceTier: 'priority', usedPercent: 10 });
    expect(first.code, first.stderr).toBe(0);
    expect(chat.meta()).toMatchObject({
      requestedServiceTier: 'priority',
      appliedServiceTier: 'priority',
    });
    const second = await chat.run({ serviceTier: 'priority', usedPercent: 10 });
    expect(second.success.codexTurn).toMatchObject({
      requestedServiceTier: 'priority',
      serviceTier: 'priority',
      threadServiceTier: 'priority',
    });
  }, 45_000);
});

describe('no fresh reading of the account limit (r1109, item 5; fake codex 0.166)', () => {
  // The fake writes no rate_limits and the host passes null: the turn has no
  // reading of the limit at all — the case of a morning after ≥ 6 h of quiet.
  it('asks for the standard tier, says why, and keeps the old way behind the switch', async () => {
    const chat = tierChat();
    const first = await chat.run({ serviceTier: 'priority', usedPercent: null });
    expect(first.code, first.stderr).toBe(0);
    expect(chat.callLog()[0]).toMatchObject({ resumed: false, asked: null, applied: null });
    expect(first.success.codexTurn).toMatchObject({
      requestedServiceTier: null,
      serviceTier: null,
      fastTierDroppedForQuota: true,
      fastTierDroppedReason: 'no_quota_reading',
    });
    expect(first.stderr).toContain('No fresh reading of the Codex account limit');
    expect(first.stderr).toMatch(
      /codex turn settings: tier=\w+ \(asked default, fast dropped: no quota reading\)/,
    );

    // 'standard' said explicitly — the same.
    const second = await chat.run({
      serviceTier: 'priority',
      usedPercent: null,
      unknownQuota: 'standard',
    });
    expect(second.code, second.stderr).toBe(0);
    expect(chat.callLog()[1]).toMatchObject({ asked: null });

    // The owner's switch back: Fast without a reading, as before r1109.
    const old = await chat.run({
      serviceTier: 'priority',
      usedPercent: null,
      unknownQuota: 'priority',
    });
    expect(old.code, old.stderr).toBe(0);
    expect(chat.callLog()[2]).toMatchObject({ asked: 'priority' });
    expect(old.success.codexTurn.requestedServiceTier).toBe('priority');
    expect(old.success.codexTurn.fastTierDroppedForQuota).toBeUndefined();
    expect(old.success.codexTurn.fastTierDroppedReason).toBeUndefined();

    // A known limit at the ceiling: dropped as before, with its own reason.
    const ceiling = await chat.run({ serviceTier: 'priority', usedPercent: 93 });
    expect(ceiling.code, ceiling.stderr).toBe(0);
    expect(chat.callLog()[3]).toMatchObject({ asked: null });
    expect(ceiling.success.codexTurn).toMatchObject({
      requestedServiceTier: null,
      fastTierDroppedForQuota: true,
      fastTierDroppedReason: 'quota_ceiling',
    });
    expect(ceiling.stderr).toMatch(/asked default, fast dropped for quota\)/);
  }, 90_000);

  it('with the rotation switch on, an unknown limit does not cut a thread born with Fast', async () => {
    const chat = tierChat();
    const first = await chat.run({ serviceTier: 'priority', usedPercent: 40 });
    expect(first.code, first.stderr).toBe(0);
    const born = chat.threadId();
    expect(chat.meta().requestedServiceTier).toBe('priority');
    const unknown = await chat.run({
      serviceTier: 'priority',
      usedPercent: null,
      tierRotate: true,
    });
    expect(unknown.code, unknown.stderr).toBe(0);
    expect(unknown.rotations).toEqual([]);
    expect(chat.threadId()).toBe(born);
    expect(fs.existsSync(chat.tierRotationFile)).toBe(false);
    expect(chat.callLog()[1]).toMatchObject({ resumed: true, asked: null });
  }, 60_000);
});

describe('a one-off thread for forwarded or quoted text (fake codex 0.166)', () => {
  // The check of variant A/B (runtime DEPLOY.md, section 4) and the bot's
  // rule tell a continuation of the chat's thread by usage_source
  // 'turn_delta'. A turn with forwarded or quoted text runs on a one-off
  // thread of its own (indirectOwnerContent), so codex applies Fast on it as
  // on any first turn. Three such turns once read priority/priority while
  // the chat's thread ran without Fast: read as continuations they would
  // «prove» variant A.
  it('reports a first turn, never a continuation, and leaves the chat thread alone (variant B)', async () => {
    const chat = tierChat('B', { tokenCounts: true });
    const first = await chat.run({ serviceTier: 'priority', usedPercent: 40 });
    expect(first.code, first.stderr).toBe(0);
    const born = chat.threadId();
    expect(first.success.codexTurn).toMatchObject({
      usageSource: 'cumulative_first_turn',
      requestedServiceTier: 'priority',
      serviceTier: 'priority',
      threadServiceTier: 'priority',
    });

    const second = await chat.run({ serviceTier: 'priority', usedPercent: 40 });
    expect(second.code, second.stderr).toBe(0);
    expect(second.success.codexTurn).toMatchObject({
      usageSource: 'turn_delta',
      requestedServiceTier: 'priority',
      serviceTier: null,
      threadServiceTier: 'priority',
    });
    const chatMeta = chat.meta();

    const forwarded = await chat.run({
      serviceTier: 'priority',
      usedPercent: 40,
      indirect: true,
    });
    expect(forwarded.code, forwarded.stderr).toBe(0);
    expect(forwarded.rotations).toEqual([]);
    const oneOff = chat.callLog()[2];
    expect(oneOff).toMatchObject({ resumed: false, asked: 'priority', applied: 'priority' });
    expect(oneOff.threadId).not.toBe(born);
    // Fast applied, born with Fast — and it says it is a first turn.
    expect(forwarded.success.codexTurn).toMatchObject({
      usageSource: 'cumulative_first_turn',
      requestedServiceTier: 'priority',
      serviceTier: 'priority',
      threadServiceTier: 'priority',
    });
    // The chat's thread and its meta are untouched.
    expect(chat.threadId()).toBe(born);
    expect(chat.meta()).toEqual(chatMeta);

    const third = await chat.run({ serviceTier: 'priority', usedPercent: 40 });
    expect(third.code, third.stderr).toBe(0);
    expect(chat.callLog()[3]).toMatchObject({ threadId: born, resumed: true, applied: null });
    expect(third.success.codexTurn).toMatchObject({
      usageSource: 'turn_delta',
      serviceTier: null,
      threadServiceTier: 'priority',
    });
  }, 90_000);
});
