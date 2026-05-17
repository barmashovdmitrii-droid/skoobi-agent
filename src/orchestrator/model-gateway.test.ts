import { describe, expect, it, vi } from 'vitest';

import {
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

describe('ModelGateway role resolution', () => {
  it('maps canonical model roles to configured provider routes', () => {
    expect(resolveModelRoute('cheap', config)).toBe('skoobi-cheap');
    expect(resolveModelRoute('default', config)).toBe('skoobi-balanced');
    expect(resolveModelRoute('smart', config)).toBe('skoobi-smart');
    expect(resolveModelRoute('vision', config)).toBe('skoobi-vision');
    expect(resolveModelRoute('owner', config)).toBe('skoobi-owner');
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
