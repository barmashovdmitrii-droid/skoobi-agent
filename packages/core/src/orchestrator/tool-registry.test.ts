import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import { getEventsForTenant } from './event-store.js';
import {
  PolicyEngine,
  ToolRegistry,
  executeToolCall,
  visibleToolsFor,
  type ToolDefinition,
} from './tool-registry.js';
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
  const merged = { ...base, ...overrides };
  // Mirror production invariant (tenant-registry.ts): mode==='owner' <=> the
  // group is the trusted main group (group.isMain). Keep the fixture consistent
  // unless a test deliberately overrides `group` to model a tampered record.
  if (!overrides.group) {
    merged.group = { ...merged.group, isMain: merged.mode === 'owner' };
  }
  return merged;
}

const ownerDiagnosticTool: ToolDefinition = {
  tool: {
    name: 'owner_diagnostic_placeholder',
    description: 'Owner-only diagnostic placeholder without an executor.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    policy_tags: ['owner_tool', 'safe_diagnostic'],
  },
  allowedTenantModes: ['owner'],
  executor: 'owner_host',
  hidden: true,
};

const contradictoryTool: ToolDefinition = {
  tool: {
    name: 'contradictory_guest_owner_tool',
    description: 'Fixture with both guest visibility and owner-only tags.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    policy_tags: ['safe_diagnostic', 'guest_visible', 'owner_tool'],
  },
  allowedTenantModes: ['guest'],
  executor: 'controlled_service',
};

const emptyObjectSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

// Untagged, no executor/network/filesystem, no tenant grant — the default-deny
// case (finding M8). A future tool that forgets its tags looks exactly like
// this and must NOT be granted to guests.
const untaggedTool: ToolDefinition = {
  tool: {
    name: 'untagged_tool',
    description: 'Tool with no policy tags and no explicit guest grant.',
    input_schema: emptyObjectSchema,
    policy_tags: [],
  },
  executor: 'controlled_service',
  execute: () => ({ ok: true }),
};

// Only a guest allow-tag, no allowedTenantModes — the explicit positive-grant
// path (finding M8).
const guestTaggedTool: ToolDefinition = {
  tool: {
    name: 'guest_tagged_tool',
    description: 'Safe controlled-service tool granted to guests by tag only.',
    input_schema: emptyObjectSchema,
    policy_tags: ['guest_visible'],
  },
  executor: 'controlled_service',
  execute: () => ({ ok: true }),
};

// Each carries a permissive guest tag, yet a powerful DECLARED capability must
// still lock it down — capability beats tag (finding M9).
const ownerHostCapabilityTool: ToolDefinition = {
  tool: {
    name: 'owner_host_capability_tool',
    description:
      'Guest-tagged tool whose owner_host executor must lock it down.',
    input_schema: emptyObjectSchema,
    policy_tags: ['guest_visible', 'safe_diagnostic'],
  },
  executor: 'owner_host',
  execute: () => ({ ok: true }),
};

const fullNetworkCapabilityTool: ToolDefinition = {
  tool: {
    name: 'full_network_capability_tool',
    description:
      'Guest-tagged tool whose full network access must lock it down.',
    input_schema: emptyObjectSchema,
    policy_tags: ['guest_visible', 'safe_diagnostic'],
  },
  executor: 'controlled_service',
  network: 'full',
  execute: () => ({ ok: true }),
};

const filesystemCapabilityTool: ToolDefinition = {
  tool: {
    name: 'filesystem_capability_tool',
    description: 'Guest-tagged tool whose filesystem roots must lock it down.',
    input_schema: emptyObjectSchema,
    policy_tags: ['guest_visible', 'safe_diagnostic'],
  },
  executor: 'controlled_service',
  filesystemRoots: ['/'],
  execute: () => ({ ok: true }),
};

const sandboxCapabilityTool: ToolDefinition = {
  tool: {
    name: 'sandbox_capability_tool',
    description:
      'Guest-tagged tool whose tenant_sandbox executor must lock it down.',
    input_schema: emptyObjectSchema,
    policy_tags: ['guest_visible', 'safe_diagnostic'],
  },
  executor: 'tenant_sandbox',
  execute: () => ({ ok: true }),
};

// Owner tool with an in-process executor body: authorization may allow it for a
// verified owner, but execution must refuse the unrouted owner_host executor
// instead of silently running in-process (finding M10).
const ownerHostExecTool: ToolDefinition = {
  tool: {
    name: 'owner_host_exec_tool',
    description:
      'Owner tool whose executor promises isolation that is not routed.',
    input_schema: emptyObjectSchema,
    policy_tags: ['owner_tool'],
  },
  allowedTenantModes: ['owner'],
  executor: 'owner_host',
  execute: () => ({ ok: true, ran: true }),
};

// Controlled-service tool that returns fields declared for redaction.
const redactingTool: ToolDefinition = {
  tool: {
    name: 'redacting_tool',
    description: 'Safe tool that returns fields declared for redaction.',
    input_schema: emptyObjectSchema,
    policy_tags: ['guest_visible'],
  },
  allowedTenantModes: ['guest'],
  executor: 'controlled_service',
  redactions: ['secret', 'nested.token'],
  execute: () => ({
    ok: true,
    secret: 'super-secret',
    nested: { token: 'abc123', keep: 'visible' },
  }),
};

// Controlled-service tool whose declared redactions traverse arrays: a dot-path
// through an array of records ('items.token') and a top-level array of scalars
// ('tokens'). Before finding L15's fix, redactPath stopped at the array node
// (isObjectRecord excludes arrays) and these fields leaked verbatim.
const arrayRedactingTool: ToolDefinition = {
  tool: {
    name: 'array_redacting_tool',
    description: 'Safe tool that returns sensitive fields nested under arrays.',
    input_schema: emptyObjectSchema,
    policy_tags: ['guest_visible'],
  },
  allowedTenantModes: ['guest'],
  executor: 'controlled_service',
  redactions: ['items.token', 'tokens'],
  execute: () => ({
    ok: true,
    items: [
      { token: 'secret-1', keep: 'visible-1' },
      { token: 'secret-2', keep: 'visible-2' },
    ],
    tokens: ['scalar-a', 'scalar-b'],
  }),
};

// Controlled-service tool whose policy decision sets requires_approval. It is
// authorizable for a guest (safe tag, no risky capability), so the ONLY thing
// that may block its execution is the approval gate.
const approvalGatedTool: ToolDefinition = {
  tool: {
    name: 'approval_gated_tool',
    description: 'Safe controlled-service tool that requires approval to run.',
    input_schema: {
      type: 'object',
      additionalProperties: true,
      properties: {},
    },
    policy_tags: ['guest_visible'],
  },
  allowedTenantModes: ['guest'],
  executor: 'controlled_service',
  requiresApproval: true,
  execute: () => ({ ok: true, ran: true }),
};

function call(name: string, argumentsJson = '{}') {
  return {
    id: `call-${name}`,
    name,
    arguments_json: argumentsJson,
  };
}

beforeEach(() => {
  _initTestDatabase();
});

describe('ToolRegistry visibility', () => {
  it('exposes the safe guest diagnostic tool but no owner tools to guests', () => {
    const guestTools = visibleToolsFor(tenant());
    const ownerTools = visibleToolsFor(tenant({ mode: 'owner' }));

    expect(guestTools.map((tool) => tool.name)).toEqual(['echo_diagnostic']);
    expect(ownerTools.map((tool) => tool.name)).toEqual([]);
    expect(guestTools).not.toEqual(ownerTools);
  });

  it('keeps hidden owner tools out of guest visible tools', () => {
    const registry = new ToolRegistry([ownerDiagnosticTool]);

    expect(visibleToolsFor(tenant(), undefined, registry)).toEqual([]);
  });

  it('treats a mode:"owner" record without trusted group.isMain as a guest (finding #69)', () => {
    const registry = new ToolRegistry([
      { ...ownerHostExecTool, hidden: false },
    ]);
    // Model a tampered tenant.json that self-declares owner mode but whose
    // group is NOT the trusted main group (group.isMain not true).
    const tampered = tenant({
      mode: 'owner',
      group: {
        name: 'Guest',
        folder: 'telegram_guest',
        trigger: '@Skoobi',
        added_at: '2026-05-15T00:00:00.000Z',
        // isMain intentionally absent/falsy
      },
    });
    const ownerSender = {
      senderId: '42',
      senderIdentity: {
        channel: 'telegram' as const,
        chat_id: '-1001',
        telegram_user_id: '42',
        identity_id: 'telegram_user_42',
        is_owner_sender: true,
      },
    };

    // Even with an owner-flagged sender, owner tools stay invisible because the
    // group is not the trusted main group.
    expect(
      visibleToolsFor(tampered, ownerSender, registry).map((t) => t.name),
    ).toEqual([]);

    // And a direct authorize call is denied (classified as guest, not owner).
    const decision = new PolicyEngine(registry).authorizeToolCall({
      tenant: tampered,
      call: call('owner_host_exec_tool'),
      session: ownerSender,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('tool_not_visible_for_tenant');
  });
});

describe('PolicyEngine authorization', () => {
  it('denies unknown tool requests and logs the policy decision', () => {
    const t = tenant();
    const decision = new PolicyEngine().authorizeToolCall({
      tenant: t,
      call: call('unknown_tool'),
      session: { senderId: '42' },
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: 'unknown_tool',
      executor: 'none',
    });
    expect(getEventsForTenant(t.tenant_id).map((event) => event.type)).toEqual([
      'session_started',
      'tool_call_requested',
      'tool_policy_denied',
    ]);
    const statuses = getDb()
      .prepare(`SELECT status FROM tool_calls ORDER BY created_at, rowid`)
      .all() as Array<{ status: string }>;
    expect(statuses.map((row) => row.status)).toEqual(['requested', 'denied']);
  });

  it('denies hidden owner tools for guests before execution', () => {
    const t = tenant();
    const registry = new ToolRegistry([ownerDiagnosticTool]);
    const decision = new PolicyEngine(registry).authorizeToolCall({
      tenant: t,
      call: call('owner_diagnostic_placeholder'),
      session: { senderId: '42' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('hidden_tool_denied');
  });

  it('denies guest calls to owner tools even when a model requests them directly', () => {
    const registry = new ToolRegistry([
      { ...ownerDiagnosticTool, hidden: false },
    ]);
    const decision = new PolicyEngine(registry).authorizeToolCall({
      tenant: tenant(),
      call: call('owner_diagnostic_placeholder'),
      session: { senderId: '42' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('tool_not_visible_for_tenant');
  });

  it('does not grant owner policy from display-name spoofing', () => {
    const registry = new ToolRegistry([
      { ...ownerDiagnosticTool, hidden: false },
    ]);
    const decision = new PolicyEngine(registry).authorizeToolCall({
      tenant: tenant({ mode: 'owner' }),
      call: call('owner_diagnostic_placeholder'),
      session: {
        senderId: '42',
        senderIdentity: {
          channel: 'telegram',
          chat_id: '-1001',
          telegram_user_id: '42',
          identity_id: 'telegram_user_42',
          display_name_hint: 'Owner',
          username_hint: 'owner',
          is_owner_sender: false,
        },
      },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('owner_tool_requires_owner_identity');
  });

  it('denies invalid JSON arguments', () => {
    const decision = new PolicyEngine().authorizeToolCall({
      tenant: tenant(),
      call: call('echo_diagnostic', '{not-json'),
      session: { senderId: '42' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('invalid_json');
  });

  it('enforces additionalProperties false before execution', () => {
    const decision = new PolicyEngine().authorizeToolCall({
      tenant: tenant(),
      call: call(
        'echo_diagnostic',
        JSON.stringify({ message: 'hello', extra: true }),
      ),
      session: { senderId: '42' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(
      'invalid_arguments:unexpected argument: extra',
    );
  });

  it('denies model-provided sandbox bypass flags', () => {
    const decision = new PolicyEngine().authorizeToolCall({
      tenant: tenant(),
      call: call(
        'echo_diagnostic',
        JSON.stringify({ message: 'hello', bypassSandbox: true }),
      ),
      session: { senderId: '42' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(
      'model_controlled_elevation_denied:bypassSandbox',
    );
  });

  it('makes deny win over allow tags', () => {
    const registry = new ToolRegistry([contradictoryTool]);
    const decision = new PolicyEngine(registry).authorizeToolCall({
      tenant: tenant(),
      call: call('contradictory_guest_owner_tool'),
      session: { senderId: '42' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('owner_tool_requires_owner_identity');
  });

  it('allows and executes the safe diagnostic tool with audit logs', async () => {
    const t = tenant();
    const result = await executeToolCall({
      tenant: t,
      call: call('echo_diagnostic', JSON.stringify({ message: 'pong' })),
      session: { senderId: '42' },
    });

    expect(result).toMatchObject({
      executed: true,
      result: {
        ok: true,
        tool: 'echo_diagnostic',
        message: 'pong',
      },
    });
    expect(getEventsForTenant(t.tenant_id).map((event) => event.type)).toEqual([
      'session_started',
      'tool_call_requested',
      'tool_policy_allowed',
      'tool_call_executed',
    ]);
    const statuses = getDb()
      .prepare(`SELECT status FROM tool_calls ORDER BY created_at, rowid`)
      .all() as Array<{ status: string }>;
    expect(statuses.map((row) => row.status)).toEqual([
      'requested',
      'allowed',
      'completed',
    ]);
  });
});

describe('default-deny guest authorization (M8)', () => {
  it('hides untagged tools from guests and denies a direct call', () => {
    const registry = new ToolRegistry([untaggedTool]);
    expect(visibleToolsFor(tenant(), undefined, registry)).toEqual([]);

    const decision = new PolicyEngine(registry).authorizeToolCall({
      tenant: tenant(),
      call: call('untagged_tool'),
      session: { senderId: '42' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('guest_tool_requires_explicit_grant');
  });

  it('grants a guest a safe tool that carries an explicit guest allow-tag', () => {
    const registry = new ToolRegistry([guestTaggedTool]);
    expect(
      visibleToolsFor(tenant(), undefined, registry).map((tool) => tool.name),
    ).toEqual(['guest_tagged_tool']);

    const decision = new PolicyEngine(registry).authorizeToolCall({
      tenant: tenant(),
      call: call('guest_tagged_tool'),
      session: { senderId: '42' },
    });

    expect(decision.allowed).toBe(true);
  });
});

describe('capability-derived gating (M9)', () => {
  it('locks down a guest-tagged tool that declares an owner_host executor', () => {
    const registry = new ToolRegistry([ownerHostCapabilityTool]);
    expect(visibleToolsFor(tenant(), undefined, registry)).toEqual([]);

    const decision = new PolicyEngine(registry).authorizeToolCall({
      tenant: tenant(),
      call: call('owner_host_capability_tool'),
      session: { senderId: '42' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('owner_tool_requires_owner_identity');
  });

  it('denies a guest-tagged tool that declares full network access', () => {
    const registry = new ToolRegistry([fullNetworkCapabilityTool]);
    expect(visibleToolsFor(tenant(), undefined, registry)).toEqual([]);

    const decision = new PolicyEngine(registry).authorizeToolCall({
      tenant: tenant(),
      call: call('full_network_capability_tool'),
      session: { senderId: '42' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('risky_tool_denied_for_guest');
  });

  it('denies a guest-tagged tool that declares filesystem roots', () => {
    const registry = new ToolRegistry([filesystemCapabilityTool]);
    const decision = new PolicyEngine(registry).authorizeToolCall({
      tenant: tenant(),
      call: call('filesystem_capability_tool'),
      session: { senderId: '42' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('risky_tool_denied_for_guest');
  });

  it('denies a guest-tagged tool that declares a tenant_sandbox executor', () => {
    const registry = new ToolRegistry([sandboxCapabilityTool]);
    const decision = new PolicyEngine(registry).authorizeToolCall({
      tenant: tenant(),
      call: call('sandbox_capability_tool'),
      session: { senderId: '42' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('risky_tool_denied_for_guest');
  });

  it('still exposes the owner_host tool to a verified owner', () => {
    const registry = new ToolRegistry([ownerHostExecTool]);
    const visible = visibleToolsFor(
      tenant({ mode: 'owner' }),
      {
        senderId: '42',
        senderIdentity: {
          channel: 'telegram',
          chat_id: '-1001',
          telegram_user_id: '42',
          identity_id: 'telegram_user_42',
          display_name_hint: 'Owner',
          username_hint: 'owner',
          is_owner_sender: true,
          telegram_message_origin: 'direct',
        },
      },
      registry,
    );

    expect(visible.map((tool) => tool.name)).toEqual(['owner_host_exec_tool']);
  });

  it.each(['forwarded', 'quoted', undefined] as const)(
    'hides owner-host tools for %s or legacy Telegram provenance',
    (origin) => {
      const registry = new ToolRegistry([ownerHostExecTool]);
      const visible = visibleToolsFor(
        tenant({ mode: 'owner' }),
        {
          senderId: '42',
          senderIdentity: {
            channel: 'telegram',
            chat_id: '-1001',
            telegram_user_id: '42',
            identity_id: 'telegram_user_42',
            is_owner_sender: true,
            telegram_message_origin: origin,
          },
        },
        registry,
      );

      expect(visible).toEqual([]);
    },
  );
});

describe('execution routing and redaction', () => {
  it('refuses to run an executor it cannot actually route to (M10)', async () => {
    const t = tenant({ mode: 'owner' });
    const registry = new ToolRegistry([ownerHostExecTool]);
    const result = await executeToolCall({
      tenant: t,
      registry,
      call: call('owner_host_exec_tool'),
      session: {
        senderId: '42',
        senderIdentity: {
          channel: 'telegram',
          chat_id: '-1001',
          telegram_user_id: '42',
          identity_id: 'telegram_user_42',
          display_name_hint: 'Owner',
          username_hint: 'owner',
          is_owner_sender: true,
          telegram_message_origin: 'direct',
        },
      },
    });

    expect(result.decision.allowed).toBe(true);
    expect(result.executed).toBe(false);
    if (!result.executed) {
      expect(result.error).toBe('executor_not_routable:owner_host');
    }
    expect(getEventsForTenant(t.tenant_id).map((event) => event.type)).toEqual([
      'session_started',
      'tool_call_requested',
      'tool_policy_allowed',
      'tool_call_failed',
    ]);
    const statuses = getDb()
      .prepare(`SELECT status FROM tool_calls ORDER BY created_at, rowid`)
      .all() as Array<{ status: string }>;
    expect(statuses.map((row) => row.status)).toEqual([
      'requested',
      'allowed',
      'error',
    ]);
  });

  it('applies declared redactions to the result before returning it', async () => {
    const registry = new ToolRegistry([redactingTool]);
    const result = await executeToolCall({
      tenant: tenant(),
      registry,
      call: call('redacting_tool'),
      session: { senderId: '42' },
    });

    expect(result.executed).toBe(true);
    if (result.executed) {
      expect(result.result).toEqual({
        ok: true,
        secret: '[REDACTED]',
        nested: { token: '[REDACTED]', keep: 'visible' },
      });
    }
  });

  it('applies declared redactions to fields nested under arrays (L15)', async () => {
    const registry = new ToolRegistry([arrayRedactingTool]);
    const result = await executeToolCall({
      tenant: tenant(),
      registry,
      call: call('array_redacting_tool'),
      session: { senderId: '42' },
    });

    // The returned result is the direct output of applyRedactions (it does NOT
    // pass through the event-store's separate key-based payload redaction), so
    // it isolates the L15 fix: before the fix redactPath stopped at the array
    // node and these fields leaked verbatim.
    expect(result.executed).toBe(true);
    if (result.executed) {
      // 'items.token' redacts the token in EVERY element; non-declared sibling
      // fields stay visible. 'tokens' redacts each element of a scalar array.
      expect(result.result).toEqual({
        ok: true,
        items: [
          { token: '[REDACTED]', keep: 'visible-1' },
          { token: '[REDACTED]', keep: 'visible-2' },
        ],
        tokens: ['[REDACTED]', '[REDACTED]'],
      });
    }
  });
});

describe('approval enforcement before execution', () => {
  it('holds an approval-gated tool when no approval verifier is supplied', async () => {
    const t = tenant();
    const registry = new ToolRegistry([approvalGatedTool]);
    let ran = false;
    registry.get('approval_gated_tool')!.execute = () => {
      ran = true;
      return { ok: true };
    };

    const result = await executeToolCall({
      tenant: t,
      registry,
      call: call('approval_gated_tool'),
      session: { senderId: '42' },
    });

    // Policy allows it, but execution is held because approval is unproven.
    expect(result.decision.allowed).toBe(true);
    expect(result.decision.requires_approval).toBe(true);
    expect(result.executed).toBe(false);
    if (!result.executed) {
      expect(result.error).toBe('approval_required');
    }
    expect(ran).toBe(false);
    expect(getEventsForTenant(t.tenant_id).map((event) => event.type)).toEqual([
      'session_started',
      'tool_call_requested',
      'tool_policy_allowed',
      'tool_call_failed',
    ]);
    const statuses = getDb()
      .prepare(`SELECT status FROM tool_calls ORDER BY created_at, rowid`)
      .all() as Array<{ status: string }>;
    expect(statuses.map((row) => row.status)).toEqual([
      'requested',
      'allowed',
      'error',
    ]);
  });

  it('still holds the tool when the verifier declines this tool_call_id', async () => {
    const registry = new ToolRegistry([approvalGatedTool]);
    const result = await executeToolCall({
      tenant: tenant(),
      registry,
      call: call('approval_gated_tool'),
      session: { senderId: '42' },
      approvals: () => false,
    });

    expect(result.executed).toBe(false);
    if (!result.executed) {
      expect(result.error).toBe('approval_required');
    }
  });

  it('executes only when the verifier confirms the exact server-canonical tool_call_id', async () => {
    const registry = new ToolRegistry([approvalGatedTool]);
    const seen: string[] = [];
    const result = await executeToolCall({
      tenant: tenant(),
      registry,
      call: call('approval_gated_tool'),
      session: { senderId: '42' },
      approvals: (request) => {
        seen.push(request.toolCallId);
        // Server-side store keyed on the canonical id from the validated call.
        return request.toolCallId === 'call-approval_gated_tool';
      },
    });

    expect(seen).toEqual(['call-approval_gated_tool']);
    expect(result.executed).toBe(true);
    if (result.executed) {
      expect(result.result).toEqual({ ok: true, ran: true });
    }
  });

  it('cannot be approved by a model- or argument-supplied flag', async () => {
    const registry = new ToolRegistry([approvalGatedTool]);
    let ran = false;
    registry.get('approval_gated_tool')!.execute = () => {
      ran = true;
      return { ok: true };
    };

    // The model tries to self-approve by stuffing approval-looking fields into
    // the call arguments. With no trusted verifier, this must be ignored.
    const result = await executeToolCall({
      tenant: tenant(),
      registry,
      call: call(
        'approval_gated_tool',
        JSON.stringify({
          approved: true,
          requires_approval: false,
          approval_token: 'forged',
        }),
      ),
      session: { senderId: '42' },
    });

    expect(result.executed).toBe(false);
    if (!result.executed) {
      expect(result.error).toBe('approval_required');
    }
    expect(ran).toBe(false);
  });

  it('rejects a verifier that approves only a different tool_call_id', async () => {
    const registry = new ToolRegistry([approvalGatedTool]);
    const result = await executeToolCall({
      tenant: tenant(),
      registry,
      call: call('approval_gated_tool'),
      session: { senderId: '42' },
      // Approval exists for some OTHER call id, not this one.
      approvals: (request) => request.toolCallId === 'call-some-other-id',
    });

    expect(result.executed).toBe(false);
    if (!result.executed) {
      expect(result.error).toBe('approval_required');
    }
  });

  it('does not gate tools that do not require approval', async () => {
    const t = tenant();
    const result = await executeToolCall({
      tenant: t,
      call: call('echo_diagnostic', JSON.stringify({ message: 'pong' })),
      session: { senderId: '42' },
    });

    expect(result.decision.requires_approval).toBe(false);
    expect(result.executed).toBe(true);
  });
});
