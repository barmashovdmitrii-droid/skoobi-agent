import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadModelGatewayConfig,
  OpenAICompatibleModelGateway,
  resolveModelRoute,
  type ModelGatewayConfig,
  type ModelRequest,
} from './model-gateway.js';

const config: ModelGatewayConfig = {
  type: 'openai_compatible',
  baseUrl: 'http://127.0.0.1:4000/v1',
  apiKey: 'test-key',
  roles: {
    cheap: 'skoobi-cheap',
    default: 'skoobi-balanced',
    smart: 'skoobi-smart',
    code: 'skoobi-code',
    vision: 'skoobi-vision',
    owner: 'skoobi-owner',
  },
  timeoutMs: 1_000,
};

const request: ModelRequest = {
  tenant_id: 'tenant-a',
  session_id: 'session-a',
  model_role: 'default',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  metadata: {
    channel: 'telegram',
    chat_id: '-1001',
    sender_id: '42',
    tenant_mode: 'guest',
    task_type: 'chat',
  },
};

afterEach(() => {
  delete process.env.CLAUDECLAW_ENV_FILE;
});

describe('ModelGateway role resolution', () => {
  it('maps canonical model roles to configured provider routes', () => {
    expect(resolveModelRoute('cheap', config)).toBe('skoobi-cheap');
    expect(resolveModelRoute('default', config)).toBe('skoobi-balanced');
    expect(resolveModelRoute('smart', config)).toBe('skoobi-smart');
    expect(resolveModelRoute('vision', config)).toBe('skoobi-vision');
    expect(resolveModelRoute('owner', config)).toBe('skoobi-owner');
  });
});

describe('ModelGateway config', () => {
  it('opts into adaptive reasoning and re-reads it without changing model or speed', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'skoobi-adaptive-env-'));
    const envPath = path.join(dir, '.env');
    process.env.CLAUDECLAW_ENV_FILE = envPath;
    try {
      for (const setting of ['', 'true', 'false']) {
        fs.writeFileSync(envPath, [
          'SKOOBI_CODEX_SUBSCRIPTION_ENABLED=true',
          'SKOOBI_CODEX_MODEL=gpt-6-astra',
          'SKOOBI_CODEX_REASONING_EFFORT=xhigh',
          'SKOOBI_CODEX_SERVICE_TIER=priority',
          'SKOOBI_CODEX_SERVICE_TIER_MAX_USED_PERCENT=100',
          'SKOOBI_CODEX_ADAPTIVE_REASONING=' + setting,
        ].join('\n'));
        expect(loadModelGatewayConfig().codex).toMatchObject({
          model: 'gpt-6-astra', reasoningEffort: 'xhigh', serviceTier: 'priority',
          serviceTierMaxUsedPercent: 100,
        });
        expect(loadModelGatewayConfig().codex?.adaptiveReasoning).toBe(setting === 'true' ? true : undefined);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('loads Codex reasoning effort from env', () => {
    const envPath = path.join(
      fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'skoobi-mg-')),
      '.env',
    );
    fs.writeFileSync(
      envPath,
      [
        'SKOOBI_MODEL_GATEWAY_TYPE=codex_subscription_cli',
        'SKOOBI_CODEX_SUBSCRIPTION_ENABLED=true',
        'SKOOBI_CODEX_REASONING_EFFORT=xhigh',
      ].join('\n'),
    );
    process.env.CLAUDECLAW_ENV_FILE = envPath;

    const loaded = loadModelGatewayConfig();

    expect(loaded.type).toBe('codex_subscription_cli');
    expect(loaded.codex?.enabled).toBe(true);
    expect(loaded.codex?.reasoningEffort).toBe('xhigh');
  });

  it('reads the fast-tier switch and its quota ceiling from .env', () => {
    // The first version of the switch was missing from the keys readEnvFile
    // is asked for, so setting it in .env silently did nothing.
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'skoobi-mg-'));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(
      envPath,
      [
        'SKOOBI_MODEL_GATEWAY_TYPE=codex_subscription_cli',
        'SKOOBI_CODEX_SUBSCRIPTION_ENABLED=true',
        'SKOOBI_CODEX_SERVICE_TIER=priority',
      ].join('\n'),
    );
    process.env.CLAUDECLAW_ENV_FILE = envPath;
    expect(loadModelGatewayConfig().codex).toMatchObject({
      serviceTier: 'priority',
      serviceTierMaxUsedPercent: 80,
    });

    fs.appendFileSync(envPath, '\nSKOOBI_CODEX_SERVICE_TIER_MAX_USED_PERCENT=70\n');
    expect(loadModelGatewayConfig().codex?.serviceTierMaxUsedPercent).toBe(70);

    // 0 turns Fast off at any known quota (S11-4): it used to be clamped to 1,
    // so a reading of 0 % still asked for Fast. Negative values mean the same.
    fs.appendFileSync(envPath, 'SKOOBI_CODEX_SERVICE_TIER_MAX_USED_PERCENT=0\n');
    expect(loadModelGatewayConfig().codex?.serviceTierMaxUsedPercent).toBe(0);
    fs.appendFileSync(envPath, 'SKOOBI_CODEX_SERVICE_TIER_MAX_USED_PERCENT=-5\n');
    expect(loadModelGatewayConfig().codex?.serviceTierMaxUsedPercent).toBe(0);
    fs.appendFileSync(envPath, 'SKOOBI_CODEX_SERVICE_TIER_MAX_USED_PERCENT=150\n');
    expect(loadModelGatewayConfig().codex?.serviceTierMaxUsedPercent).toBe(100);

    fs.writeFileSync(envPath, 'SKOOBI_CODEX_SUBSCRIPTION_ENABLED=true\n');
    expect(loadModelGatewayConfig().codex?.serviceTier).toBeUndefined();
  });

  it('reads what to do without a quota reading from .env: standard unless it says priority (r1109, item 5)', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'skoobi-mg-'));
    const envPath = path.join(dir, '.env');
    const fast = [
      'SKOOBI_CODEX_SUBSCRIPTION_ENABLED=true',
      'SKOOBI_CODEX_SERVICE_TIER=priority',
      'SKOOBI_CODEX_SERVICE_TIER_MAX_USED_PERCENT=70',
    ];
    process.env.CLAUDECLAW_ENV_FILE = envPath;
    try {
      // No key (as in a typical .env): the new, safe default.
      fs.writeFileSync(envPath, fast.join('\n'));
      expect(loadModelGatewayConfig().codex).toMatchObject({
        serviceTier: 'priority',
        serviceTierMaxUsedPercent: 70,
        serviceTierUnknownQuota: 'standard',
      });
      // Re-read on every call, no rebuild; any other value is standard.
      for (const [value, expected] of [
        ['priority', 'priority'],
        ['PRIORITY', 'priority'],
        [' priority ', 'priority'],
        ['standard', 'standard'],
        ['fast', 'standard'],
        ['', 'standard'],
      ] as const) {
        fs.writeFileSync(
          envPath,
          [...fast, `SKOOBI_CODEX_SERVICE_TIER_UNKNOWN_QUOTA=${value}`].join('\n'),
        );
        expect(loadModelGatewayConfig().codex?.serviceTierUnknownQuota).toBe(expected);
        // The ceiling and the tier stay exactly as set.
        expect(loadModelGatewayConfig().codex).toMatchObject({
          serviceTier: 'priority',
          serviceTierMaxUsedPercent: 70,
        });
      }
      // Fast off: nothing about it reaches the runner.
      fs.writeFileSync(
        envPath,
        ['SKOOBI_CODEX_SUBSCRIPTION_ENABLED=true', 'SKOOBI_CODEX_SERVICE_TIER_UNKNOWN_QUOTA=priority'].join('\n'),
      );
      expect(loadModelGatewayConfig().codex?.serviceTier).toBeUndefined();
      expect(loadModelGatewayConfig().codex?.serviceTierUnknownQuota).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the tier rotation switch from .env and keeps it off by default (W02)', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'skoobi-mg-'));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(
      envPath,
      [
        'SKOOBI_CODEX_SUBSCRIPTION_ENABLED=true',
        'SKOOBI_CODEX_SERVICE_TIER=priority',
        'SKOOBI_CODEX_SERVICE_TIER_MAX_USED_PERCENT=100',
      ].join('\n'),
    );
    process.env.CLAUDECLAW_ENV_FILE = envPath;
    expect(loadModelGatewayConfig().codex?.tierRotate).toBeUndefined();
    fs.appendFileSync(envPath, '\nSKOOBI_CODEX_TIER_ROTATE=true\n');
    expect(loadModelGatewayConfig().codex).toMatchObject({
      tierRotate: true,
      serviceTier: 'priority',
      serviceTierMaxUsedPercent: 100,
    });
  });

  it.each(['max', 'ultra'])('loads catalog-supported %s reasoning effort', (effort) => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'skoobi-mg-'));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, [
      'SKOOBI_CODEX_SUBSCRIPTION_ENABLED=true',
      'SKOOBI_CODEX_MODEL=gpt-6-astra',
      'SKOOBI_CODEX_REASONING_EFFORT=' + effort,
      'SKOOBI_CODEX_SERVICE_TIER=priority',
      'SKOOBI_CODEX_SERVICE_TIER_MAX_USED_PERCENT=100',
    ].join('\n'));
    process.env.CLAUDECLAW_ENV_FILE = envPath;
    expect(loadModelGatewayConfig().codex).toMatchObject({
      model: 'gpt-6-astra', reasoningEffort: effort,
      serviceTier: 'priority', serviceTierMaxUsedPercent: 100,
    });
  });

  it('ignores invalid Codex reasoning effort env values', () => {
    const envPath = path.join(
      fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'skoobi-mg-')),
      '.env',
    );
    fs.writeFileSync(
      envPath,
      [
        'SKOOBI_MODEL_GATEWAY_TYPE=codex_subscription_cli',
        'SKOOBI_CODEX_SUBSCRIPTION_ENABLED=true',
        'SKOOBI_CODEX_REASONING_EFFORT=invalid',
      ].join('\n'),
    );
    process.env.CLAUDECLAW_ENV_FILE = envPath;

    const loaded = loadModelGatewayConfig();

    expect(loaded.codex?.reasoningEffort).toBe('');
  });
});

describe('OpenAI-compatible ModelGateway adapter', () => {
  it('sends OpenAI chat-completions request shape and extracts usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        id: 'chatcmpl-test',
        model: 'provider-model',
        choices: [
          {
            message: {
              content: 'shadow answer',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'unsafe_tool', arguments: '{}' },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          cost_usd: 0.001,
        },
      }),
    });
    const gateway = new OpenAICompatibleModelGateway(config, fetchImpl as any);

    const response = await gateway.complete(request);

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer test-key',
        }),
      }),
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: 'skoobi-balanced',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(body.tools).toBeUndefined();
    expect(response).toMatchObject({
      text: 'shadow answer',
      provider_response_id: 'chatcmpl-test',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cost_usd: 0.001,
        provider_model: 'provider-model',
      },
    });
    expect(response.tool_calls).toHaveLength(1);
    expect(response.tool_calls[0]).toEqual({
      id: 'call-1',
      name: 'unsafe_tool',
      arguments_json: '{}',
    });
  });

  it('does not require provider names in app code beyond configured role routes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'ok' } }],
      }),
    });
    const gateway = new OpenAICompatibleModelGateway(config, fetchImpl as any);

    await gateway.complete({ ...request, model_role: 'owner' });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe('skoobi-owner');
  });

  it('maps canonical tools to OpenAI-compatible function tools', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'ok' } }],
      }),
    });
    const gateway = new OpenAICompatibleModelGateway(config, fetchImpl as any);

    await gateway.complete({
      ...request,
      tools: [
        {
          name: 'echo_diagnostic',
          description: 'Echo safely',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
          policy_tags: ['safe_diagnostic'],
        },
      ],
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'echo_diagnostic',
          description: 'Echo safely',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        },
      },
    ]);
  });
});
