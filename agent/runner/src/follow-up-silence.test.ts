/**
 * W31: a catch-up turn whose messages were all sent before the previous answer
 * may stay silent (only where the host allows it), and a word-for-word repeat
 * of that answer within a minute is flagged so the host does not send it twice
 * (the same advice once went out twice, 11 seconds apart).
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FOLLOW_UP_SILENCE_NOTE,
  FOLLOW_UP_SILENCE_WITHDRAWN_NOTE,
  REPEATED_ANSWER_WINDOW_MS,
  followUpAnswerFlags,
  followUpStateAfterSupersede,
  userVisibleAnswerText,
} from './index.js';

const ANSWER = 'Выбирай «Динамический IP»: роутер сам получит адрес.';

describe('catch-up answer flags', () => {
  const base = {
    silenceOffered: true,
    sentBeforePreviousAnswer: true,
    previousAnswer: { text: userVisibleAnswerText(ANSWER), at: 1_000 },
    now: 12_000,
  };

  it('an <internal>-only answer is silence only where it was offered', () => {
    expect(followUpAnswerFlags({ ...base, finalText: '<internal>уже ответил</internal>' })).toEqual({
      silentFollowUp: true,
    });
    expect(
      followUpAnswerFlags({ ...base, silenceOffered: false, finalText: '<internal>уже ответил</internal>' }),
    ).toEqual({});
  });

  it('a verbatim repeat within a minute is flagged; whitespace does not matter', () => {
    expect(followUpAnswerFlags({ ...base, finalText: `${ANSWER}\n` })).toEqual({
      repeatsPreviousAnswer: true,
    });
    expect(
      followUpAnswerFlags({ ...base, finalText: ANSWER.replace(' ', '  ') }),
    ).toEqual({ repeatsPreviousAnswer: true });
  });

  it('no flag: a different answer, too late, or a message sent after the answer («повтори»)', () => {
    expect(followUpAnswerFlags({ ...base, finalText: 'Лучше статический IP.' })).toEqual({});
    expect(
      followUpAnswerFlags({ ...base, finalText: ANSWER, now: 1_000 + REPEATED_ANSWER_WINDOW_MS + 1 }),
    ).toEqual({});
    expect(
      followUpAnswerFlags({ ...base, sentBeforePreviousAnswer: false, finalText: ANSWER }),
    ).toEqual({});
    expect(
      followUpAnswerFlags({ ...base, sentBeforePreviousAnswer: false, finalText: '<internal>x</internal>' }),
    ).toEqual({});
    expect(followUpAnswerFlags({ ...base, previousAnswer: undefined, finalText: ANSWER })).toEqual({});
  });

  it('a supersede restart that took in later messages withdraws silence and the repeat flag', () => {
    const freshPrompt = `[Пока ты отвечал…]\n${FOLLOW_UP_SILENCE_NOTE}\n\nТак что выбрать?`;
    const after = followUpStateAfterSupersede({
      newerCount: 1,
      sentBeforePreviousAnswer: true,
      silenceOffered: true,
      freshPrompt,
    });
    expect(after).toEqual({
      sentBeforePreviousAnswer: false,
      silenceOffered: false,
      freshPrompt: '[Пока ты отвечал…]\n\nТак что выбрать?',
      silenceWithdrawn: true,
    });
    // With these flags the same answer is neither silence nor a repeat.
    expect(followUpAnswerFlags({ ...base, ...after, finalText: ANSWER })).toEqual({});
    expect(
      followUpAnswerFlags({ ...base, ...after, finalText: '<internal>уже ответил</internal>' }),
    ).toEqual({});
    // A restart with nothing new changes nothing.
    expect(
      followUpStateAfterSupersede({
        newerCount: 0,
        sentBeforePreviousAnswer: true,
        silenceOffered: true,
        freshPrompt,
      }),
    ).toEqual({ sentBeforePreviousAnswer: true, silenceOffered: true, freshPrompt, silenceWithdrawn: false });
    expect(FOLLOW_UP_SILENCE_WITHDRAWN_NOTE).toContain('молчать нельзя');
  });

  it('the note tells the model when silence is allowed and how', () => {
    expect(FOLLOW_UP_SILENCE_NOTE).toContain('<internal>уже ответил</internal>');
    expect(FOLLOW_UP_SILENCE_NOTE).toContain('Если сомневаешься — ответь как обычно');
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** The real provider loop with a fake CLI: turn 1 answers, a message that came
 * in during it becomes turn 2, which the fake answers with `secondAnswer`. */
async function catchUpFixture(
  allowFollowUpSilence: boolean,
  secondAnswer: string,
  options: { lateMessageDuringCatchUp?: boolean } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-catch-up-'));
  roots.push(root);
  const group = path.join(root, 'group');
  const inputDir = path.join(root, 'ipc', 'input');
  fs.mkdirSync(group);
  fs.mkdirSync(inputDir, { recursive: true });
  const fake = path.join(root, 'fake-codex.cjs');
  const calls = path.join(root, 'calls');
  const seen = path.join(root, 'second-input');
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
      emit({ type:'thread.started', thread_id:'bbbbbbbb-1111-2222-3333-444444444444' });
      emit({ type:'turn.started' });
      let final = ${JSON.stringify(ANSWER)};
      if (attempt === 1) {
        fs.writeFileSync(${JSON.stringify(path.join(inputDir, '1700000000001-followup.json'))}, JSON.stringify({type:'message',text:'Так что выбрать?'}));
      } else if (attempt === 2 && ${JSON.stringify(options.lateMessageDuringCatchUp === true)}) {
        // «повтори», sent after the first answer, while the catch-up turn
        // is still only thinking: the runner restarts it with this message.
        fs.writeFileSync(${JSON.stringify(path.join(inputDir, '1700000000002-late.json'))}, JSON.stringify({type:'message',text:'повтори'}));
        setTimeout(() => process.exit(0), 15000);
        return;
      } else {
        fs.writeFileSync(${JSON.stringify(seen)}, input);
        final = ${JSON.stringify(secondAnswer)};
        fs.writeFileSync(${JSON.stringify(path.join(inputDir, '_close'))}, '');
      }
      emit({type:'item.completed',item:{type:'agent_message',text:final}});
      emit({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}});
      fs.writeFileSync(output, final);
      process.exit(0);
    });
  `,
    { mode: 0o755 },
  );
  const input = {
    prompt: 'Какой тип подключения выбрать?',
    groupFolder: 'fixture',
    chatJid: 'tg:fixture',
    isMain: true,
    provider: 'codex_cli',
    allowFollowUpSupersede: true,
    ...(allowFollowUpSilence ? { allowFollowUpSilence: true } : {}),
    codex: { command: fake, model: 'fixture-model', timeoutMs: 10_000 },
  };
  const moduleUrl = pathToFileURL(path.resolve('agent/runner/src/index.ts')).href;
  const harness = `import(${JSON.stringify(moduleUrl)}).then(m => m.runCodexProviderLoop(${JSON.stringify(input)}, ${JSON.stringify(path.join(root, 'unused-mcp.js'))}, ${JSON.stringify(input.prompt)}, []));`;
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), '-e', harness], {
      cwd: root,
      env: {
        PATH: process.env.PATH, HOME: root, CODEX_HOME: path.join(root, 'codex-home'),
        CLAUDECLAW_GROUP_DIR: group, CLAUDECLAW_IPC_DIR: path.join(root, 'ipc'),
        CLAUDECLAW_RUNNER_IDLE_WAIT_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`fixture timeout: ${stderr}`)); }, 20_000);
    child.stdout.on('data', (x) => (stdout += x));
    child.stderr.on('data', (x) => (stderr += x));
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timeout); resolve({ stdout, stderr, code }); });
  });
  const frames = [
    ...result.stdout.matchAll(/---CLAUDECLAW_OUTPUT_START---\n([\s\S]*?)\n---CLAUDECLAW_OUTPUT_END---/g),
  ].map((match) => JSON.parse(match[1]));
  return { ...result, frames, seenText: fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8') : '' };
}

describe('catch-up turn in the real runner (fake CLI)', () => {
  it('a member\'s chat: silence is offered and an <internal>-only answer is flagged silent', async () => {
    const r = await catchUpFixture(true, '<internal>уже ответил</internal>');
    expect(r.code, r.stderr).toBe(0);
    expect(r.seenText).toContain('<internal>уже ответил</internal>');
    const finals = r.frames.filter((f) => f.status === 'success');
    expect(finals).toHaveLength(2);
    expect(finals[0].silentFollowUp).toBeUndefined();
    expect(finals[1].silentFollowUp).toBe(true);
  }, 25_000);

  it('«повтори» sent after the answer joins the catch-up turn: no silence, no repeat flag', async () => {
    const silent = await catchUpFixture(true, '<internal>уже ответил</internal>', {
      lateMessageDuringCatchUp: true,
    });
    expect(silent.code, silent.stderr).toBe(0);
    expect(silent.frames.some((f) => f.supersedeRestart?.newerMessages === 1)).toBe(true);
    // The restarted turn sees «повтори» and no longer the offer of silence.
    expect(silent.seenText).toContain('повтори');
    expect(silent.seenText).not.toContain('<internal>уже ответил</internal>');
    const silentFinals = silent.frames.filter((f) => f.status === 'success');
    expect(silentFinals.at(-1)?.silentFollowUp).toBeUndefined();

    const repeat = await catchUpFixture(true, ANSWER, { lateMessageDuringCatchUp: true });
    expect(repeat.code, repeat.stderr).toBe(0);
    const repeatFinals = repeat.frames.filter((f) => f.status === 'success');
    expect(repeatFinals.map((f) => f.repeatsPreviousAnswer)).toEqual([undefined, undefined]);
  }, 45_000);

  it('without the grant there is no silence note; a verbatim repeat is still flagged', async () => {
    const r = await catchUpFixture(false, ANSWER);
    expect(r.code, r.stderr).toBe(0);
    expect(r.seenText).not.toContain('уже ответил');
    const finals = r.frames.filter((f) => f.status === 'success');
    expect(finals.map((f) => f.repeatsPreviousAnswer)).toEqual([undefined, true]);
  }, 25_000);
});
