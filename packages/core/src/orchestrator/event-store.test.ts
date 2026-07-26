import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import {
  eventSessionIdForTenant,
  getEventsForTenant,
  recordModelTrace,
  recordTenantEvent,
  recordToolCall,
  recordUsageEvent,
} from './event-store.js';
import type { TenantRecord } from './tenant-registry.js';

function tenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  const base: TenantRecord = {
    tenant_id: 'tg_chat_-1001',
    folder: 'telegram_guest',
    channel: 'telegram',
    chat_id: '-1001',
    mode: 'guest',
    runtime: 'claude_sdk',
    approved_senders: [],
    models: {},
    quota: { enabled: false },
    legacy_jid: 'tg:-1001',
    source: 'legacy_registered_group',
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

describe('event store schema', () => {
  it('creates append-only event store tables alongside legacy sessions', () => {
    const rows = getDb()
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const names = rows.map((row) => row.name);

    expect(names).toContain('tenants');
    expect(names).toContain('event_sessions');
    expect(names).toContain('events');
    expect(names).toContain('usage_events');
    expect(names).toContain('tool_calls');
    expect(names).toContain('model_traces');
    expect(names).toContain('sessions');
  });
});

describe('recordTenantEvent', () => {
  it('creates a tenant session and appends inbound and outbound events', () => {
    const t = tenant();

    const inbound = recordTenantEvent({
      tenant: t,
      type: 'telegram_inbound_message',
      actor: 'telegram_user:42',
      senderId: '42',
      createdAt: 1,
      payload: {
        message_id: 'm1',
        sender_id: '42',
        content: 'hello',
      },
    });
    const outbound = recordTenantEvent({
      tenant: t,
      type: 'telegram_outbound_message',
      actor: 'assistant',
      senderId: 'bot',
      createdAt: 2,
      payload: {
        text: 'hi',
      },
    });

    expect(inbound.seq).toBe(2);
    expect(outbound.seq).toBe(3);
    expect(inbound.session_id).toBe(eventSessionIdForTenant(t));

    const events = getEventsForTenant(t.tenant_id);
    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'telegram_inbound_message',
      'telegram_outbound_message',
    ]);
    expect(events.map((event) => event.tenant_id)).toEqual([
      t.tenant_id,
      t.tenant_id,
      t.tenant_id,
    ]);
  });

  it('keeps separate tenant streams from sharing sequence numbers', () => {
    const first = tenant({ tenant_id: 'tg_chat_-1001', chat_id: '-1001' });
    const second = tenant({
      tenant_id: 'tg_chat_-1002',
      chat_id: '-1002',
      legacy_jid: 'tg:-1002',
      folder: 'telegram_other',
      group: {
        name: 'Other',
        folder: 'telegram_other',
        trigger: '@Skoobi',
        added_at: '2026-05-15T00:00:00.000Z',
      },
    });

    recordTenantEvent({
      tenant: first,
      type: 'telegram_inbound_message',
      actor: 'telegram_user:1',
      senderId: '1',
      payload: { message_id: 'a' },
    });
    recordTenantEvent({
      tenant: second,
      type: 'telegram_inbound_message',
      actor: 'telegram_user:2',
      senderId: '2',
      payload: { message_id: 'b' },
    });

    expect(
      getEventsForTenant(first.tenant_id).map((event) => event.seq),
    ).toEqual([1, 2]);
    expect(
      getEventsForTenant(second.tenant_id).map((event) => event.seq),
    ).toEqual([1, 2]);
  });

  it('prevents updates, deletes, and duplicate sequence numbers', () => {
    const t = tenant();
    const event = recordTenantEvent({
      tenant: t,
      type: 'telegram_inbound_message',
      actor: 'telegram_user:42',
      senderId: '42',
      payload: { message_id: 'm1' },
    });

    expect(() =>
      getDb()
        .prepare(`UPDATE events SET actor = 'changed' WHERE event_id = ?`)
        .run(event.event_id),
    ).toThrow(/append-only/);
    expect(() =>
      getDb()
        .prepare(`DELETE FROM events WHERE event_id = ?`)
        .run(event.event_id),
    ).toThrow(/append-only/);
    expect(() =>
      getDb()
        .prepare(
          `
          INSERT INTO events
            (event_id, tenant_id, session_id, seq, type, actor, channel, chat_id,
             sender_id, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          'duplicate-seq',
          event.tenant_id,
          event.session_id,
          event.seq,
          'telegram_inbound_message',
          'telegram_user:42',
          event.channel,
          event.chat_id,
          '42',
          '{}',
          Date.now(),
        ),
    ).toThrow();
  });

  it('refuses to attribute events to a session_id owned by another tenant', () => {
    const first = tenant({ tenant_id: 'tg_chat_-1001', chat_id: '-1001' });
    const second = tenant({
      tenant_id: 'tg_chat_-1002',
      chat_id: '-1002',
      legacy_jid: 'tg:-1002',
      folder: 'telegram_other',
      group: {
        name: 'Other',
        folder: 'telegram_other',
        trigger: '@Skoobi',
        added_at: '2026-05-15T00:00:00.000Z',
      },
    });

    const sharedSessionId = 'collision-session-id';

    // Tenant A claims the shared session_id first.
    recordTenantEvent({
      tenant: first,
      type: 'telegram_inbound_message',
      actor: 'telegram_user:1',
      senderId: '1',
      sessionId: sharedSessionId,
      payload: { message_id: 'a' },
    });

    // Tenant B presenting the same explicit session_id must be rejected
    // instead of silently writing a cross-tenant audit row (finding #49).
    expect(() =>
      recordTenantEvent({
        tenant: second,
        type: 'telegram_inbound_message',
        actor: 'telegram_user:2',
        senderId: '2',
        sessionId: sharedSessionId,
        payload: { message_id: 'b' },
      }),
    ).toThrow(/different tenant/);

    // No events were attributed to tenant B referencing tenant A's session.
    expect(getEventsForTenant(second.tenant_id)).toEqual([]);
    expect(
      getEventsForTenant(first.tenant_id).every(
        (event) => event.session_id === sharedSessionId,
      ),
    ).toBe(true);
  });

  it('redacts obvious secrets from event payloads', () => {
    const t = tenant();
    const event = recordTenantEvent({
      tenant: t,
      type: 'telegram_inbound_message',
      actor: 'telegram_user:42',
      senderId: '42',
      payload: {
        token: '123456',
        content: 'Bearer abcdefghijklmnop and sk-testsecret123456',
        nested: { api_key: 'secret-value' },
      },
    });

    const payload = JSON.parse(event.payload_json) as {
      token: string;
      content: string;
      nested: { api_key: string };
    };
    expect(payload.token).toBe('[REDACTED]');
    expect(payload.nested.api_key).toBe('[REDACTED]');
    expect(payload.content).toContain('Bearer [REDACTED]');
    expect(payload.content).toContain('sk-[REDACTED]');
  });
});

describe('usage and tool-call event tables', () => {
  it('appends usage and tool call records without exposing them to runtime tools', () => {
    const t = tenant();
    const usageId = recordUsageEvent({
      tenant: t,
      channelUserId: '42',
      modelRole: 'default',
      providerModel: 'claude-opus-4-7',
      inputTokens: 10,
      outputTokens: 20,
    });
    const toolCallId = recordToolCall({
      tenant: t,
      toolCallId: 'tool-1',
      toolName: 'memory_save',
      status: 'requested',
      senderId: '42',
      argsHash: 'abc',
      payload: { args: { secret: 'hide-me' } },
    });

    const usage = getDb()
      .prepare(`SELECT * FROM usage_events WHERE id = ?`)
      .get(usageId) as { tenant_id: string; input_tokens: number };
    const toolCall = getDb()
      .prepare(`SELECT * FROM tool_calls WHERE id = ?`)
      .get(toolCallId) as { tenant_id: string; payload_json: string };

    expect(usage).toMatchObject({
      tenant_id: t.tenant_id,
      input_tokens: 10,
    });
    expect(toolCall.tenant_id).toBe(t.tenant_id);
    expect(JSON.parse(toolCall.payload_json)).toEqual({
      args: { secret: '[REDACTED]' },
    });
  });

  it('appends model traces and keeps them append-only', () => {
    const t = tenant({ runtime: 'skoobi_shadow' });
    const traceId = recordModelTrace({
      tenant: t,
      senderId: '42',
      runMode: 'shadow',
      modelRole: 'default',
      providerModel: 'provider-model',
      status: 'success',
      legacyAnswerLength: 10,
      skoobiAnswerLength: 12,
      latencyMs: 123,
      inputTokens: 7,
      outputTokens: 8,
      costUsd: 0.001,
      toolCallsRequested: 1,
      toolCallsAllowed: 0,
      toolCallsDenied: 1,
      finalAnswerHash: 'abc',
      payload: {
        provider_response_id: 'resp-1',
        api_key: 'hide-me',
      },
    });

    const trace = getDb()
      .prepare(`SELECT * FROM model_traces WHERE id = ?`)
      .get(traceId) as {
      tenant_id: string;
      run_mode: string;
      status: string;
      payload_json: string;
    };

    expect(trace).toMatchObject({
      tenant_id: t.tenant_id,
      run_mode: 'shadow',
      status: 'success',
    });
    expect(JSON.parse(trace.payload_json)).toMatchObject({
      provider_response_id: 'resp-1',
      api_key: '[REDACTED]',
    });
    expect(() =>
      getDb()
        .prepare(`UPDATE model_traces SET status = 'changed' WHERE id = ?`)
        .run(traceId),
    ).toThrow(/append-only/);
  });
});
