import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import { getEventsForTenant } from './event-store.js';
import {
  buildShadowModelRequest,
  finishShadowModelRun,
  shouldStartShadowMode,
  startShadowModelRun,
} from './shadow-mode.js';
import type { ModelGateway } from './model-gateway.js';
import type { TenantRecord } from './tenant-registry.js';

function tenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  const base: TenantRecord = {
    tenant_id: 'tg_chat_-1001',
    folder: 'telegram_guest',
    channel: 'telegram',
    chat_id: '-1001',
    mode: 'guest',
    runtime: 'skoobi_shadow',
    approved_senders: [],
    models: {},
    quota: { enabled: true },
    legacy_jid: 'tg:-1001',
    source: 'tenant_json',
    group: {
      name: 'Guest',
      folder: 'telegram_guest',
      trigger: '@Skoobi',
      added_at: '2026-05-15T00:00:00.000Z',
    },
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  _initTestDatabase();
});

describe('shadow mode request building', () => {
  it('starts only for skoobi_shadow tenants', () => {
    expect(shouldStartShadowMode(tenant({ runtime: 'skoobi_shadow' }))).toBe(
      true,
    );
    expect(shouldStartShadowMode(tenant({ runtime: 'claude_sdk' }))).toBe(
      false,
    );
    expect(shouldStartShadowMode(tenant({ runtime: 'skoobi_live' }))).toBe(
      false,
    );
  });

  it('uses canonical identity and sends no tools to the shadow model', () => {
    const request = buildShadowModelRequest({
      tenant: tenant(),
      prompt: 'Hello',
      senderId: '42',
    });

    expect(request).toMatchObject({
      tenant_id: 'tg_chat_-1001',
      model_role: 'default',
      metadata: {
        channel: 'telegram',
        chat_id: '-1001',
        sender_id: '42',
        tenant_mode: 'guest',
      },
    });
    expect(request.tools).toEqual([]);
    expect(request.messages[0].content).toContain('<skoobi_truthfulness>');
    expect(request.messages[0].content).toContain('Do not invent facts');
  });
});

describe('shadow trace recording', () => {
  it('stores Skoobi trace and usage without writing quota ledger rows', async () => {
    const t = tenant();
    const gateway: ModelGateway = {
      complete: async () => ({
        text: 'skoobi shadow answer',
        tool_calls: [
          {
            id: 'tool-1',
            name: 'dangerous_side_effect',
            arguments_json: '{}',
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cost_usd: 0.001,
          provider_model: 'provider-model',
        },
        provider_response_id: 'resp-1',
      }),
    };

    const run = startShadowModelRun({
      tenant: t,
      prompt: 'Prompt',
      senderId: '42',
      gateway,
      now: Date.now(),
    });
    const traceId = await finishShadowModelRun({
      tenant: t,
      run,
      senderId: '42',
      legacyAnswerText: 'legacy answer delivered to user',
      createdAt: 10,
    });

    const trace = getDb()
      .prepare(`SELECT * FROM model_traces WHERE id = ?`)
      .get(traceId) as {
      status: string;
      legacy_answer_length: number;
      skoobi_answer_length: number;
      input_tokens: number;
      output_tokens: number;
      tool_calls_requested: number;
      tool_calls_allowed: number;
      tool_calls_denied: number;
      payload_json: string;
    };
    const usage = getDb()
      .prepare(`SELECT * FROM usage_events WHERE tenant_id = ?`)
      .get(t.tenant_id) as { input_tokens: number; cost_usd: number };
    const ledgerCount = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM usage_ledger`)
      .get() as { c: number };
    const events = getEventsForTenant(t.tenant_id).map((event) => event.type);

    expect(trace).toMatchObject({
      status: 'success',
      legacy_answer_length: 'legacy answer delivered to user'.length,
      skoobi_answer_length: 'skoobi shadow answer'.length,
      input_tokens: 100,
      output_tokens: 25,
      tool_calls_requested: 1,
      tool_calls_allowed: 0,
      tool_calls_denied: 1,
    });
    expect(JSON.parse(trace.payload_json)).toMatchObject({
      dangerous_tools_executed: false,
      shadow_answer_sent_to_user: false,
      provider_response_id: 'resp-1',
    });
    expect(usage).toMatchObject({ input_tokens: 100, cost_usd: 0.001 });
    expect(ledgerCount.c).toBe(0);
    expect(events).toContain('quota_charge_skipped_shadow');
    expect(events).toContain('model_gateway_shadow_trace');
  });

  it('stores an error trace without throwing provider details at users', async () => {
    const t = tenant();
    const gateway: ModelGateway = {
      complete: async () => {
        throw new Error('HTTP 503 provider unavailable');
      },
    };

    const run = startShadowModelRun({
      tenant: t,
      prompt: 'Prompt',
      senderId: '42',
      gateway,
      now: Date.now(),
    });
    const traceId = await finishShadowModelRun({
      tenant: t,
      run,
      senderId: '42',
      legacyAnswerText: 'legacy',
      createdAt: 10,
    });

    const trace = getDb()
      .prepare(`SELECT status, payload_json FROM model_traces WHERE id = ?`)
      .get(traceId) as { status: string; payload_json: string };

    expect(trace.status).toBe('error');
    expect(JSON.parse(trace.payload_json)).toMatchObject({
      shadow_answer_sent_to_user: false,
      dangerous_tools_executed: false,
      error: {
        name: 'Error',
        message: 'HTTP 503 provider unavailable',
      },
    });
  });
});
