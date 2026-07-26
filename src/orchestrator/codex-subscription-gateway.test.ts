import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import {
  buildCodexPrompt,
  checkCodexCliStatus,
  CodexSubscriptionModelGateway,
  CodexSubscriptionRuntimeError,
  codexExecArgs,
  defaultCodexProcessRunner,
  type CodexExecInput,
  type CodexProcessRunner,
} from './codex-subscription-gateway.js';
import { finishShadowModelRun, startShadowModelRun } from './shadow-mode.js';
import { chargeLiveUsage, runLiveModelTurn } from './live-mode.js';
import { loadBillingConfig } from './quota.js';
import type { ModelRequest } from './model-gateway.js';
import type { TenantRecord } from './tenant-registry.js';

function tenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  const base: TenantRecord = {
    tenant_id: 'tg_chat_7000000101',
    folder: 'telegram_tg_7000000101',
    channel: 'telegram',
    chat_id: '7000000101',
    mode: 'guest',
    runtime: 'skoobi_shadow',
    approved_senders: [],
    models: {},
    quota: { enabled: true },
    legacy_jid: 'tg:7000000101',
    source: 'tenant_json',
    group: {
      name: 'Fixture Tenant',
      folder: 'telegram_tg_7000000101',
      trigger: '@Skoobi',
      added_at: '2026-05-15T00:00:00.000Z',
    },
  };
  return { ...base, ...overrides };
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    tenant_id: 'tg_chat_7000000101',
    session_id: 'session-a',
    model_role: 'default',
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Ответь одним словом: ok' },
    ],
    tools: [],
    metadata: {
      channel: 'telegram',
      chat_id: '7000000101',
      sender_id: '7000000101',
      tenant_mode: 'guest',
      task_type: 'chat',
    },
    ...overrides,
  };
}

function fakeRunner(
  options: {
    finalText?: string;
    exitCode?: number | null;
    stderr?: string;
    timedOut?: boolean;
    loginStatus?: string;
    onRun?: (input: CodexExecInput) => void | {
      finalText?: string;
      exitCode?: number | null;
      stderr?: string;
      stdout?: string;
      timedOut?: boolean;
    };
  } = {},
): CodexProcessRunner & {
  execCalls: Array<{ command: string; args: string[] }>;
  runCalls: CodexExecInput[];
} {
  const runner = {
    execCalls: [] as Array<{ command: string; args: string[] }>,
    runCalls: [] as CodexExecInput[],
    async execFile(command: string, args: string[]) {
      runner.execCalls.push({ command, args });
      if (args.join(' ') === '--version') {
        return { stdout: 'codex-cli 0.128.0\n', stderr: '' };
      }
      if (args.join(' ') === 'login status') {
        return {
          stdout: `${options.loginStatus ?? 'Logged in using ChatGPT'}\n`,
          stderr: '',
        };
      }
      throw new Error('unexpected command');
    },
    async run(input: CodexExecInput) {
      runner.runCalls.push(input);
      const override = options.onRun?.(input);
      const finalIndex = input.args.indexOf('--output-last-message') + 1;
      const finalText = override?.finalText ?? options.finalText;
      if (finalIndex > 0 && finalText !== undefined) {
        fs.writeFileSync(input.args[finalIndex], finalText);
      }
      return {
        exitCode: override?.exitCode ?? options.exitCode ?? 0,
        stdout: override?.stdout ?? '',
        stderr: override?.stderr ?? options.stderr ?? '',
        timedOut: override?.timedOut ?? options.timedOut,
      };
    },
  };
  return runner;
}

function modelFromArgs(input: CodexExecInput): string | undefined {
  const index = input.args.indexOf('--model');
  return index >= 0 ? input.args[index + 1] : undefined;
}

function modelAwareRunner(options: {
  responses: Record<
    string,
    { finalText?: string; exitCode?: number | null; stderr?: string }
  >;
}): ReturnType<typeof fakeRunner> {
  return fakeRunner({
    onRun(input) {
      const model = modelFromArgs(input) || '';
      return (
        options.responses[model] || {
          exitCode: 1,
          stderr: 'model not available',
        }
      );
    },
    finalText: undefined,
  });
}

const scratchRoots: string[] = [];

function scratchRoot(): string {
  const root = fs.mkdtempSync(
    path.join(process.env.TMPDIR || '/tmp', 'codex-subscription-test-'),
  );
  scratchRoots.push(root);
  return root;
}

function tempFile(input: { ext: string; content?: string }): string {
  const root = scratchRoot();
  const filePath = path.join(root, `source${input.ext}`);
  fs.writeFileSync(filePath, input.content ?? 'image-bytes');
  return filePath;
}

beforeEach(() => {
  _initTestDatabase();
});

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Codex subscription CLI status', () => {
  it('detects codex CLI availability without reading auth.json', async () => {
    const runner = fakeRunner();

    const status = await checkCodexCliStatus({ command: 'codex' }, runner);

    expect(status).toMatchObject({
      present: true,
      version: 'codex-cli 0.128.0',
      loginActive: true,
      loginStatus: 'Logged in using ChatGPT',
    });
    expect(runner.execCalls.map((call) => call.args)).toEqual([
      ['--version'],
      ['login', 'status'],
    ]);
    expect(JSON.stringify(runner.execCalls)).not.toContain('auth.json');
    expect(JSON.stringify(runner.execCalls)).not.toContain('.codex');
  });

  it('uses codex login status and does not print secrets', async () => {
    const runner = fakeRunner();

    const status = await checkCodexCliStatus({ command: 'codex' }, runner);

    expect(status.loginActive).toBe(true);
    expect(status.loginStatus).toBe('Logged in using ChatGPT');
    expect(JSON.stringify(status)).not.toContain('sk-');
    expect(JSON.stringify(status)).not.toContain('Authorization');
  });
});

describe('Codex subscription gateway', () => {
  it('runs codex exec in scratch dir, not repo root', async () => {
    const root = scratchRoot();
    const runner = fakeRunner({ finalText: 'ok' });
    const gateway = new CodexSubscriptionModelGateway(
      { enabled: true, scratchRoot: root },
      runner,
    );

    const response = await gateway.complete(request());

    expect(response.text).toBe('ok');
    expect(runner.runCalls).toHaveLength(1);
    expect(runner.runCalls[0].cwd).toContain(root);
    expect(runner.runCalls[0].cwd).not.toBe(process.cwd());
    expect(runner.runCalls[0].args).toContain('--cd');
    expect(runner.runCalls[0].args).toContain(runner.runCalls[0].cwd);
  });

  it('passes gpt-5.6-sol explicitly to codex exec by default', async () => {
    const runner = fakeRunner({ finalText: 'ok' });
    const gateway = new CodexSubscriptionModelGateway(
      { enabled: true, scratchRoot: scratchRoot() },
      runner,
    );

    await gateway.complete(request());

    expect(modelFromArgs(runner.runCalls[0])).toBe('gpt-5.6-sol');
  });

  it('CLI flag model overrides local Codex config default', async () => {
    const runner = fakeRunner({ finalText: 'ok' });
    const gateway = new CodexSubscriptionModelGateway(
      { enabled: true, model: 'gpt-5.6-sol', scratchRoot: scratchRoot() },
      runner,
    );

    await gateway.complete(request());

    expect(runner.runCalls[0].args).toContain('--ignore-user-config');
    expect(modelFromArgs(runner.runCalls[0])).toBe('gpt-5.6-sol');
  });

  it('uses the configured cheap model route for degraded guest requests', async () => {
    const runner = fakeRunner({ finalText: 'ok' });
    const gateway = new CodexSubscriptionModelGateway(
      {
        enabled: true,
        model: 'gpt-5.6-sol',
        roles: { cheap: 'gpt-5.6-terra' },
        scratchRoot: scratchRoot(),
      },
      runner,
    );

    const response = await gateway.complete(request({ model_role: 'cheap' }));

    expect(modelFromArgs(runner.runCalls[0])).toBe('gpt-5.6-terra');
    expect(response.usage?.requested_model).toBe('gpt-5.6-terra');
    expect(response.usage?.effective_model).toBe('gpt-5.6-terra');
  });

  it('uses read-only sandbox and never danger-full-access', async () => {
    const args = codexExecArgs({
      scratchDir: '/tmp/scratch',
      finalPath: '/tmp/scratch/final.txt',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
    });

    expect(args).toEqual(
      expect.arrayContaining([
        '--disable',
        'plugins',
        '--ask-for-approval',
        'never',
        '-c',
        'model_reasoning_effort="xhigh"',
        '--sandbox',
        'read-only',
        '--json',
        '--output-last-message',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
      ]),
    );
    expect(args.indexOf('--ask-for-approval')).toBeLessThan(
      args.indexOf('exec'),
    );
    expect(args.indexOf('model_reasoning_effort="xhigh"')).toBeLessThan(
      args.indexOf('exec'),
    );
    expect(args).not.toContain('danger-full-access');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--add-dir');
    expect(
      modelFromArgs({
        command: 'codex',
        args,
        stdin: '',
        cwd: '/tmp/scratch',
        timeoutMs: 1,
        maxStdoutBytes: 1,
        maxStderrBytes: 1,
      }),
    ).toBe('gpt-5.6-sol');
  });

  it('omits reasoning effort when it is not configured', () => {
    const args = codexExecArgs({
      scratchDir: '/tmp/scratch',
      finalPath: '/tmp/scratch/final.txt',
      model: 'gpt-5.6-sol',
    });

    expect(args.join(' ')).not.toContain('model_reasoning_effort');
  });

  it('passes configured reasoning effort to codex exec and usage metadata', async () => {
    const runner = fakeRunner({ finalText: 'ok' });
    const gateway = new CodexSubscriptionModelGateway(
      {
        enabled: true,
        scratchRoot: scratchRoot(),
        reasoningEffort: 'xhigh',
      },
      runner,
    );

    const response = await gateway.complete(request());

    expect(runner.runCalls[0].args).toContain(
      'model_reasoning_effort="xhigh"',
    );
    expect(response.usage?.reasoning_effort).toBe('xhigh');
  });

  it('enables native Codex web_search with --search before exec when configured', async () => {
    const args = codexExecArgs({
      scratchDir: '/tmp/scratch',
      finalPath: '/tmp/scratch/final.txt',
      model: 'gpt-5.6-sol',
      enableWebSearch: true,
    });

    expect(args).toContain('--search');
    expect(args.indexOf('--search')).toBeLessThan(args.indexOf('exec'));
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('--disable');
    expect(args).toContain('plugins');
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('danger-full-access');
  });

  it('keeps native Codex web_search disabled unless explicitly configured', () => {
    const args = codexExecArgs({
      scratchDir: '/tmp/scratch',
      finalPath: '/tmp/scratch/final.txt',
      model: 'gpt-5.6-sol',
    });

    expect(args).not.toContain('--search');
  });

  it('allows only native web_search in the prompt when web search is enabled', () => {
    const prompt = buildCodexPrompt(
      request({
        messages: [
          {
            role: 'user',
            content: 'Посмотри в интернете свежие новости OpenAI',
          },
        ],
      }),
      0,
      { webSearchEnabled: true },
    );

    expect(prompt).toContain('Native web_search is enabled');
    expect(prompt).toContain(
      'The current provider for this response is Codex',
    );
    expect(prompt).toContain(
      'Do not claim a current Claude/Anthropic outage',
    );
    expect(prompt).toContain('business contacts');
    expect(prompt).toContain('never invent contacts');
    expect(prompt).toContain('<skoobi_truthfulness>');
    expect(prompt).toContain('Do not invent facts');
    expect(prompt).toContain('no shell/files/plugins/MCP');
    expect(prompt).toContain('plugins');
    expect(prompt).not.toContain('Do not use tools, shell commands');
  });

  it('does not duplicate truthfulness instructions already present in messages', () => {
    const prompt = buildCodexPrompt(
      request({
        messages: [
          {
            role: 'system',
            content:
              '<skoobi_truthfulness>\nAlready present.\n</skoobi_truthfulness>',
          },
          { role: 'user', content: 'Привет' },
        ],
      }),
    );

    expect(prompt.match(/<skoobi_truthfulness>/g)).toHaveLength(1);
  });

  it('passes --search to codex exec and records usage metadata when web search is enabled', async () => {
    const runner = fakeRunner({ finalText: 'searched answer' });
    const gateway = new CodexSubscriptionModelGateway(
      {
        enabled: true,
        webSearchEnabled: true,
        scratchRoot: scratchRoot(),
      },
      runner,
    );

    const response = await gateway.complete(request());

    expect(runner.runCalls[0].args).toContain('--search');
    expect(runner.runCalls[0].stdin).toContain('Native web_search is enabled');
    expect(response.usage?.web_search_enabled).toBe(true);
  });

  it('does not use native web_search when Skoobi already provided SearchGateway context', async () => {
    const runner = fakeRunner({ finalText: 'answer from provided context' });
    const gateway = new CodexSubscriptionModelGateway(
      {
        enabled: true,
        webSearchEnabled: true,
        scratchRoot: scratchRoot(),
      },
      runner,
    );

    const response = await gateway.complete(
      request({
        metadata: {
          ...request().metadata,
          web_search_context_provided: true,
          web_search_provider: 'codex_cli',
          web_search_result_count: 2,
        },
      }),
    );

    expect(runner.runCalls[0].args).not.toContain('--search');
    expect(runner.runCalls[0].stdin).not.toContain(
      'Native web_search is enabled',
    );
    expect(response.usage?.web_search_enabled).toBe(false);
  });

  it('does not pass groups/store/.env paths to codex', () => {
    const prompt = buildCodexPrompt(
      request({
        messages: [
          {
            role: 'user',
            content:
              'Read groups/telegram_main, store/messages.db, .env, ~/.ssh/id_rsa, ~/.codex/auth.json',
          },
        ],
      }),
    );

    expect(prompt).not.toContain('groups/telegram_main');
    expect(prompt).not.toContain('store/messages.db');
    expect(prompt).not.toContain('.env');
    expect(prompt).not.toContain('~/.ssh');
    expect(prompt).not.toContain('~/.codex');
    expect(prompt).toContain('[REDACTED_GROUP_PATH]');
    expect(prompt).toContain('[REDACTED_STORE_DB]');
  });

  it('passes copied image attachments to codex exec via --image without exposing tenant paths', async () => {
    const tenantRoot = scratchRoot();
    const sourceDir = path.join(
      tenantRoot,
      'groups',
      'telegram_guest',
      'received',
    );
    fs.mkdirSync(sourceDir, { recursive: true });
    const sourceImage = path.join(sourceDir, 'frame-01.jpg');
    fs.writeFileSync(sourceImage, 'fake-jpeg-frame');

    const runner = fakeRunner({
      finalText: 'вижу кадр',
      onRun(input) {
        const imageIndex = input.args.indexOf('--image');
        expect(imageIndex).toBeGreaterThan(-1);
        const copiedImage = input.args[imageIndex + 1];
        expect(copiedImage).toBeTruthy();
        expect(
          path
            .relative(fs.realpathSync(input.cwd), copiedImage)
            .startsWith('images'),
        ).toBe(true);
        expect(fs.readFileSync(copiedImage, 'utf8')).toBe('fake-jpeg-frame');
        expect(JSON.stringify(input.args)).not.toContain(sourceImage);
        expect(input.args).not.toContain('--add-dir');
      },
    });
    const gateway = new CodexSubscriptionModelGateway(
      { enabled: true, scratchRoot: scratchRoot() },
      runner,
    );

    const response = await gateway.complete(
      request({
        messages: [
          {
            role: 'user',
            content:
              '[Video note Key-frame files: received/frame-01.jpg — use Read tool to inspect visual context]',
          },
        ],
        metadata: {
          ...request().metadata,
          task_type: 'vision',
          image_paths: [sourceImage],
        },
      }),
    );

    expect(response.text).toBe('вижу кадр');
    expect(runner.runCalls).toHaveLength(1);
    expect(runner.runCalls[0].stdin).toContain('Image attachments: 1');
    expect(runner.runCalls[0].stdin).toContain(
      'attached as image context when available',
    );
    expect(runner.runCalls[0].stdin).not.toContain('use Read tool');
  });

  it('limits codex image attachments to three and ignores unsafe or non-image paths', async () => {
    const sourceImages = [1, 2, 3, 4].map((index) =>
      tempFile({ ext: `.jpg`, content: `image-${index}` }),
    );
    const textFile = tempFile({ ext: '.txt', content: 'not-an-image' });

    const runner = fakeRunner({
      finalText: 'ok',
      onRun(input) {
        const imageArgs = input.args.flatMap((arg, index, args) =>
          arg === '--image' ? [args[index + 1]] : [],
        );
        expect(imageArgs).toHaveLength(3);
        expect(
          imageArgs.every((imagePath) =>
            path
              .relative(fs.realpathSync(input.cwd), imagePath)
              .startsWith('images'),
          ),
        ).toBe(true);
        expect(JSON.stringify(imageArgs)).not.toContain(textFile);
        expect(JSON.stringify(input.args)).not.toContain(sourceImages[0]);
        expect(input.args).not.toContain('--add-dir');
      },
    });
    const gateway = new CodexSubscriptionModelGateway(
      { enabled: true, scratchRoot: scratchRoot() },
      runner,
    );

    await gateway.complete(
      request({
        metadata: {
          ...request().metadata,
          task_type: 'vision',
          image_paths: [textFile, ...sourceImages],
        },
      }),
    );
  });

  it('fails safely before codex exec when requested image attachments cannot be copied', async () => {
    const textFile = tempFile({ ext: '.txt', content: 'not an image' });
    const runner = fakeRunner({ finalText: 'should not run' });
    const gateway = new CodexSubscriptionModelGateway(
      { enabled: true, scratchRoot: scratchRoot() },
      runner,
    );

    await expect(
      gateway.complete(
        request({
          metadata: {
            ...request().metadata,
            task_type: 'vision',
            image_paths: [textFile],
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: 'CodexSubscriptionRuntimeError',
      classification: 'transient',
      message: 'Codex image attachments unavailable',
    });
    expect(runner.runCalls).toHaveLength(0);
  });

  it('returns canonical response from output-last-message', async () => {
    const runner = fakeRunner({ finalText: 'Короткий ответ' });
    const gateway = new CodexSubscriptionModelGateway(
      { enabled: true, scratchRoot: scratchRoot() },
      runner,
    );

    const response = await gateway.complete(request());

    expect(response).toMatchObject({
      text: 'Короткий ответ',
      tool_calls: [],
      usage: {
        input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        provider_model: 'codex-subscription',
        provider: 'codex_cli',
        usage_source: 'unavailable_or_estimated',
        requested_model: 'gpt-5.6-sol',
        effective_model: 'gpt-5.6-sol',
        model_downgrade_used: false,
      },
    });
  });

  it('does not call gpt-5.6-terra when gpt-5.6-sol succeeds', async () => {
    const runner = modelAwareRunner({
      responses: {
        'gpt-5.6-sol': { finalText: 'new model answer' },
        'gpt-5.6-terra': { finalText: 'old model answer' },
      },
    });
    const gateway = new CodexSubscriptionModelGateway(
      {
        enabled: true,
        model: 'gpt-5.6-sol',
        fallbackModel: 'gpt-5.6-terra',
        allowModelDowngrade: true,
        scratchRoot: scratchRoot(),
      },
      runner,
    );

    const response = await gateway.complete(request());

    expect(response.text).toBe('new model answer');
    expect(runner.runCalls.map(modelFromArgs)).toEqual(['gpt-5.6-sol']);
  });

  it('falls back to Claude path when gpt-5.6-sol is unavailable and downgrade is disabled', async () => {
    const runner = modelAwareRunner({
      responses: {
        'gpt-5.6-sol': { exitCode: 1, stderr: 'model not available: gpt-5.6-sol' },
        'gpt-5.6-terra': { finalText: 'should not run' },
      },
    });
    const gateway = new CodexSubscriptionModelGateway(
      {
        enabled: true,
        model: 'gpt-5.6-sol',
        fallbackModel: 'gpt-5.6-terra',
        allowModelDowngrade: false,
        scratchRoot: scratchRoot(),
      },
      runner,
    );

    await expect(gateway.complete(request())).rejects.toMatchObject({
      name: 'CodexSubscriptionRuntimeError',
      classification: 'model_unavailable',
      requestedModel: 'gpt-5.6-sol',
    });
    expect(runner.runCalls.map(modelFromArgs)).toEqual(['gpt-5.6-sol']);
    expect(
      (
        getDb().prepare(`SELECT COUNT(*) AS c FROM usage_ledger`).get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it('downgrades to gpt-5.6-terra only when explicitly allowed', async () => {
    const runner = modelAwareRunner({
      responses: {
        'gpt-5.6-sol': { exitCode: 1, stderr: 'model not available: gpt-5.6-sol' },
        'gpt-5.6-terra': { finalText: 'downgraded answer' },
      },
    });
    const gateway = new CodexSubscriptionModelGateway(
      {
        enabled: true,
        model: 'gpt-5.6-sol',
        fallbackModel: 'gpt-5.6-terra',
        allowModelDowngrade: true,
        scratchRoot: scratchRoot(),
      },
      runner,
    );

    const response = await gateway.complete(request());

    expect(response.text).toBe('downgraded answer');
    expect(runner.runCalls.map(modelFromArgs)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
    expect(response.usage).toMatchObject({
      requested_model: 'gpt-5.6-sol',
      effective_model: 'gpt-5.6-terra',
      model_downgrade_used: true,
      model_downgrade_reason: 'codex_model_unavailable',
    });
  });

  it('timeout returns safe error and no charge', async () => {
    const runner = fakeRunner({
      exitCode: null,
      timedOut: true,
      stderr: 'Bearer sk-secret-like-token should not leak',
    });
    const gateway = new CodexSubscriptionModelGateway(
      { enabled: true, scratchRoot: scratchRoot() },
      runner,
    );

    await expect(gateway.complete(request())).rejects.toMatchObject({
      name: 'CodexSubscriptionRuntimeError',
      classification: 'transient',
      message: 'Codex CLI timed out',
    });
    expect(
      (
        getDb().prepare(`SELECT COUNT(*) AS c FROM usage_ledger`).get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it('does not expose stderr/secrets to user-visible output', async () => {
    const runner = fakeRunner({
      exitCode: 1,
      stderr: 'Authorization: Bearer sk-secret-value',
    });
    const gateway = new CodexSubscriptionModelGateway(
      { enabled: true, scratchRoot: scratchRoot() },
      runner,
    );

    await expect(gateway.complete(request())).rejects.toThrow(
      'Codex CLI failed',
    );
    try {
      await gateway.complete(request());
    } catch (err) {
      expect(err).toBeInstanceOf(CodexSubscriptionRuntimeError);
      expect(String((err as Error).message)).not.toContain('sk-secret-value');
      expect(String((err as Error).message)).not.toContain('Authorization');
    }
  });

  // Finding #46: guest-controlled model answer (stdout) must NOT steer the
  // failure reason. Auth/rate-limit phrases the model emits to stdout should
  // be classified 'unknown' (message 'Codex CLI failed'), not 'auth'/'rate_limit'.
  it('does not classify on guest-influenced stdout answer text', async () => {
    const runner = fakeRunner({
      onRun() {
        return {
          exitCode: 1,
          stdout:
            'unauthorized rate limit permission denied model not available 502',
          stderr: '',
        };
      },
    });
    const gateway = new CodexSubscriptionModelGateway(
      { enabled: true, scratchRoot: scratchRoot() },
      runner,
    );

    await expect(gateway.complete(request())).rejects.toMatchObject({
      name: 'CodexSubscriptionRuntimeError',
      classification: 'unknown',
      message: 'Codex CLI failed',
    });
  });

  // Finding #46: tighten the 5xx heuristic. An explicit 5xx status on stderr is
  // transient; innocuous text containing the digit 5 must NOT be transient.
  it('classifies explicit 5xx status as transient but ignores innocuous "5" text', async () => {
    const fiveXx = fakeRunner({
      onRun() {
        return { exitCode: 1, stderr: 'request failed: 502 Bad Gateway' };
      },
    });
    const gatewayFiveXx = new CodexSubscriptionModelGateway(
      { enabled: true, scratchRoot: scratchRoot() },
      fiveXx,
    );
    await expect(gatewayFiveXx.complete(request())).rejects.toMatchObject({
      classification: 'transient',
      message: 'Codex CLI transient failure',
    });

    const innocuous = fakeRunner({
      onRun() {
        return { exitCode: 1, stderr: 'completed in 5 seconds, 5 items, $5' };
      },
    });
    const gatewayInnocuous = new CodexSubscriptionModelGateway(
      { enabled: true, scratchRoot: scratchRoot() },
      innocuous,
    );
    await expect(gatewayInnocuous.complete(request())).rejects.toMatchObject({
      classification: 'unknown',
      message: 'Codex CLI failed',
    });
  });

  // Finding #5: writing a large prompt to a child that exits immediately must
  // not crash the process. Without the child.stdin 'error' guard the async
  // EPIPE becomes an uncaughtException → process.exit(1). The run should
  // resolve (via close) instead of rejecting/hanging.
  it('survives stdin EPIPE when the codex child exits before draining stdin', async () => {
    const result = await defaultCodexProcessRunner.run({
      command: process.execPath, // node — exits immediately, closes stdin read end
      args: ['-e', 'process.exit(0)'],
      stdin: 'x'.repeat(4 * 1024 * 1024), // > pipe buffer → write can't drain
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxStdoutBytes: 65_536,
      maxStderrBytes: 65_536,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeFalsy();
  });
});

describe('Codex subscription integration behavior', () => {
  const billingEnabledConfig = loadBillingConfig({ enabled: true });

  it('shadow mode records trace and does not charge live usage', async () => {
    const t = tenant({ runtime: 'skoobi_shadow' });
    const gateway = new CodexSubscriptionModelGateway(
      { enabled: true, scratchRoot: scratchRoot() },
      fakeRunner({ finalText: 'shadow answer' }),
    );

    const run = startShadowModelRun({
      tenant: t,
      prompt: 'Prompt',
      senderId: '7000000101',
      gateway,
    });
    const traceId = await finishShadowModelRun({
      tenant: t,
      run,
      senderId: '7000000101',
      legacyAnswerText: 'legacy answer',
    });

    const trace = getDb()
      .prepare(
        `SELECT provider_model, payload_json FROM model_traces WHERE id = ?`,
      )
      .get(traceId) as { provider_model: string; payload_json: string };
    const ledgerCount = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM usage_ledger`)
      .get() as { c: number };

    expect(trace.provider_model).toBe('codex-subscription');
    expect(JSON.parse(trace.payload_json)).toMatchObject({
      provider: 'codex_cli',
      usage_source: 'unavailable_or_estimated',
      shadow_answer_sent_to_user: false,
    });
    expect(ledgerCount.c).toBe(0);
  });

  it('live mode remains limited to single canary tenant', async () => {
    const { shouldStartLiveMode } = await import('./live-mode.js');
    const config = {
      enabled: true,
      tenantId: 'tg_chat_7000000101',
    };

    expect(
      shouldStartLiveMode(tenant({ runtime: 'skoobi_live' }), config),
    ).toBe(true);
    expect(
      shouldStartLiveMode(
        tenant({
          tenant_id: 'tg_chat_other',
          chat_id: '999',
          runtime: 'skoobi_live',
        }),
        config,
      ),
    ).toBe(false);
  });

  it('codex provider has estimated credits, not provider_cost_usd', async () => {
    const t = tenant({ runtime: 'skoobi_live' });
    const gateway = new CodexSubscriptionModelGateway(
      { enabled: true, scratchRoot: scratchRoot() },
      fakeRunner({ finalText: 'live answer' }),
    );
    const run = await runLiveModelTurn({
      tenant: t,
      prompt: 'Prompt',
      senderId: '7000000101',
      gateway,
    });

    const charge = chargeLiveUsage({
      tenant: t,
      run,
      senderId: '7000000101',
      targetCursor: 'cursor-a',
      config: billingEnabledConfig,
    });
    const row = getDb()
      .prepare(
        `SELECT provider_model, provider_cost_usd, credits_spent FROM usage_ledger`,
      )
      .get() as {
      provider_model: string;
      provider_cost_usd: number | null;
      credits_spent: number;
    };

    expect(charge?.charged).toBe(true);
    expect(row.provider_model).toBe('codex-subscription');
    expect(row.provider_cost_usd).toBeNull();
    // Codex charges a flat per-request credit value from config (env/YAML),
    // so assert against that rather than a hardcoded number — keeps the test
    // deterministic whether or not a local .env overrides the default.
    expect(row.credits_spent).toBe(
      billingEnabledConfig.codexSubscriptionCreditsPerRequest,
    );
  });

  it('model_traces include requested_model and effective_model', async () => {
    const t = tenant({ runtime: 'skoobi_live' });
    const gateway = new CodexSubscriptionModelGateway(
      { enabled: true, model: 'gpt-5.6-sol', scratchRoot: scratchRoot() },
      fakeRunner({ finalText: 'live answer' }),
    );

    const run = await runLiveModelTurn({
      tenant: t,
      prompt: 'Prompt',
      senderId: '7000000101',
      gateway,
    });

    expect(run.status).toBe('success');
    const trace = getDb()
      .prepare(`SELECT payload_json FROM model_traces WHERE id = ?`)
      .get(run.traceId) as { payload_json: string };
    expect(JSON.parse(trace.payload_json)).toMatchObject({
      requested_model: 'gpt-5.6-sol',
      effective_model: 'gpt-5.6-sol',
      model_downgrade_used: false,
    });
  });

  it('records codex_model_downgraded event when downgrade is explicitly enabled', async () => {
    const t = tenant({ runtime: 'skoobi_live' });
    const gateway = new CodexSubscriptionModelGateway(
      {
        enabled: true,
        model: 'gpt-5.6-sol',
        fallbackModel: 'gpt-5.6-terra',
        allowModelDowngrade: true,
        scratchRoot: scratchRoot(),
      },
      modelAwareRunner({
        responses: {
          'gpt-5.6-sol': { exitCode: 1, stderr: 'model not available: gpt-5.6-sol' },
          'gpt-5.6-terra': { finalText: 'fallback model answer' },
        },
      }),
    );

    const run = await runLiveModelTurn({
      tenant: t,
      prompt: 'Prompt',
      senderId: '7000000101',
      gateway,
    });

    expect(run.status).toBe('success');
    const event = getDb()
      .prepare(`SELECT type, payload_json FROM events WHERE type = ?`)
      .get('codex_model_downgraded') as
      | { type: string; payload_json: string }
      | undefined;
    expect(event?.type).toBe('codex_model_downgraded');
    expect(JSON.parse(event?.payload_json || '{}')).toMatchObject({
      requested_model: 'gpt-5.6-sol',
      effective_model: 'gpt-5.6-terra',
      model_downgrade_reason: 'codex_model_unavailable',
    });
  });

  it('does not double-charge on retry/fallback', async () => {
    const t = tenant({ runtime: 'skoobi_live' });
    const gateway = new CodexSubscriptionModelGateway(
      { enabled: true, scratchRoot: scratchRoot() },
      fakeRunner({ finalText: 'live answer' }),
    );
    const run = await runLiveModelTurn({
      tenant: t,
      prompt: 'Prompt',
      senderId: '7000000101',
      gateway,
    });

    const first = chargeLiveUsage({
      tenant: t,
      run,
      senderId: '7000000101',
      targetCursor: 'same-logical-request',
      config: billingEnabledConfig,
    });
    const retry = chargeLiveUsage({
      tenant: t,
      run,
      senderId: '7000000101',
      targetCursor: 'same-logical-request',
      config: billingEnabledConfig,
    });

    expect(first?.charged).toBe(true);
    expect(retry?.duplicate).toBe(true);
    expect(
      (
        getDb().prepare(`SELECT COUNT(*) AS c FROM usage_ledger`).get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
  });
});
