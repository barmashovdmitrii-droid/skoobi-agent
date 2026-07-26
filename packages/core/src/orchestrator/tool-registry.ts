import { createHash } from 'crypto';

import { z } from 'zod';

import {
  eventSessionIdForTenant,
  recordTenantEvent,
  recordToolCall,
} from './event-store.js';
import type { CanonicalTool, CanonicalToolCall } from './model-gateway.js';
import type { TenantRecord } from './tenant-registry.js';
import type { SenderIdentity } from './types.js';

export const CanonicalToolSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/),
    description: z.string().min(1).max(1000),
    input_schema: z.record(z.string(), z.unknown()),
    policy_tags: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const CanonicalToolCallSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    arguments_json: z.string().max(64_000),
  })
  .strict();

export type PolicyDecision = {
  allowed: boolean;
  reason: string;
  public_message: string;
  executor: 'none' | 'tenant_sandbox' | 'owner_host' | 'controlled_service';
  filesystem_roots: string[];
  network: 'none' | 'allowlisted' | 'full';
  requires_approval: boolean;
  redactions: string[];
  max_runtime_ms: number;
};

export type ToolSessionContext = {
  sessionId?: string;
  senderId?: string | null;
  senderIdentity?: SenderIdentity;
  actor?: string;
};

export type ToolExecutionResult =
  | {
      executed: true;
      decision: PolicyDecision;
      result: Record<string, unknown>;
    }
  | {
      executed: false;
      decision: PolicyDecision;
      result?: undefined;
      error?: string;
    };

type TenantMode = 'guest' | 'owner';
type JsonObject = Record<string, unknown>;

type ToolExecutor = PolicyDecision['executor'];
type ToolNetwork = PolicyDecision['network'];

export type ToolDefinition = {
  tool: CanonicalTool;
  enabled?: boolean;
  hidden?: boolean;
  allowedTenantModes?: TenantMode[];
  executor?: ToolExecutor;
  filesystemRoots?: string[];
  network?: ToolNetwork;
  requiresApproval?: boolean;
  redactions?: string[];
  maxRuntimeMs?: number;
  execute?: (
    args: JsonObject,
    context: {
      tenant: TenantRecord;
      session?: ToolSessionContext;
      call: CanonicalToolCall;
    },
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

export type AuthorizeToolCallInput = {
  tenant: TenantRecord;
  call: unknown;
  session?: ToolSessionContext;
};

// Server-side approval check for tools whose policy decision sets
// requires_approval. The verifier receives the SERVER-CANONICAL tool_call_id
// (post schema validation), never a model- or argument-supplied value, and must
// confirm a human/operator approval was recorded out-of-band for that exact id.
// It is a distinct input field (not part of `call`/`arguments_json`) precisely
// so a prompt-injected model cannot forge its own approval.
export type ToolApprovalRequest = {
  tenant: TenantRecord;
  toolCallId: string;
  toolName: string;
  argsHash: string;
  session?: ToolSessionContext;
};

export type ApprovalVerifier = (
  request: ToolApprovalRequest,
) => boolean | Promise<boolean>;

export type ExecuteToolCallInput = AuthorizeToolCallInput & {
  policyEngine?: PolicyEngine;
  registry?: ToolRegistry;
  // Trusted, out-of-band approval verifier. Omitting it means no approval can be
  // proven, so any tool requiring approval is held/denied (default-deny).
  approvals?: ApprovalVerifier;
};

const OWNER_TOOL_TAGS = new Set([
  'owner',
  'owner_only',
  'owner_tool',
  'owner_host',
]);
const RISKY_TOOL_TAGS = new Set([
  'shell',
  'owner_shell',
  'filesystem',
  'host_filesystem',
  'write_file',
  'mcp',
  'network_full',
  'bypass_sandbox',
]);
// Explicit positive grants that make a tool guest-reachable. A guest tool must
// opt in via one of these tags (or `allowedTenantModes: ['guest']`); anything
// else is denied by default (finding M8).
const GUEST_ALLOW_TAGS = new Set(['guest_visible', 'safe_diagnostic']);
const MODEL_CONTROLLED_ELEVATION_KEYS = new Set([
  'bypassSandbox',
  'bypass_sandbox',
  'noSandbox',
  'fullAccess',
  'executor',
  'filesystem_roots',
  'filesystemRoots',
  'network',
  'owner_host',
]);

function echoDiagnostic(args: JsonObject): Record<string, unknown> {
  return {
    ok: true,
    tool: 'echo_diagnostic',
    message: String(args.message || ''),
  };
}

const DEFAULT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    tool: {
      name: 'echo_diagnostic',
      description:
        'Echoes a short diagnostic message without filesystem, network, or host side effects.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['message'],
        properties: {
          message: {
            type: 'string',
            maxLength: 512,
          },
        },
      },
      policy_tags: [
        'safe_diagnostic',
        'guest_visible',
        'controlled_service',
        'no_filesystem',
        'no_network',
      ],
    },
    allowedTenantModes: ['guest'],
    executor: 'controlled_service',
    network: 'none',
    filesystemRoots: [],
    requiresApproval: false,
    redactions: [],
    maxRuntimeMs: 1_000,
    execute: echoDiagnostic,
  },
];

// Owner authority in the registry must rest on an authoritative, host-controlled
// signal, not the free-form tenant.mode string alone (finding #69). tenant.mode
// is derived in tenant-registry.ts from group.isMain, but tenant.json lives in a
// RW-mounted group dir, so we treat the mode string as advisory and additionally
// require the trusted group.isMain flag (sourced from the DB/directory layout,
// never from tenant.json) before classifying a tenant as 'owner'. A tenant that
// merely self-declares mode:"owner" without group.isMain is treated as a guest.
function isTrustedOwnerTenant(tenant: TenantRecord): boolean {
  return tenant.mode === 'owner' && tenant.group?.isMain === true;
}

function tenantMode(tenant: TenantRecord): TenantMode {
  return isTrustedOwnerTenant(tenant) ? 'owner' : 'guest';
}

function isOwnerAuthorized(
  tenant: TenantRecord,
  session?: ToolSessionContext,
): boolean {
  return (
    isTrustedOwnerTenant(tenant) &&
    session?.senderIdentity?.is_owner_sender === true &&
    session.senderIdentity.telegram_message_origin === 'direct'
  );
}

function hasAnyTag(tags: string[], needles: Set<string>): boolean {
  return tags.some((tag) => needles.has(tag));
}

// A tool's real authority comes from its declared capabilities
// (executor/network/filesystemRoots), not only its string policy_tags. The
// guest/owner gates derive risk from BOTH sources so a tool cannot slip the
// gate by declaring a powerful capability while leaving its tags empty
// (finding M9).

function requiresOwnerIdentity(definition: ToolDefinition): boolean {
  return (
    hasAnyTag(definition.tool.policy_tags, OWNER_TOOL_TAGS) ||
    definition.executor === 'owner_host'
  );
}

function isRiskyForGuest(definition: ToolDefinition): boolean {
  if (hasAnyTag(definition.tool.policy_tags, RISKY_TOOL_TAGS)) return true;
  // tenant_sandbox promises OS-level isolation that executeToolCall does not
  // yet provide (finding M10), so a guest must never reach it in-process.
  if (definition.executor === 'tenant_sandbox') return true;
  if (definition.network && definition.network !== 'none') return true;
  if (definition.filesystemRoots && definition.filesystemRoots.length > 0) {
    return true;
  }
  return false;
}

function hasGuestGrant(definition: ToolDefinition): boolean {
  if (definition.allowedTenantModes?.includes('guest')) return true;
  return hasAnyTag(definition.tool.policy_tags, GUEST_ALLOW_TAGS);
}

function isObjectRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rawCallIdentity(call: unknown): CanonicalToolCall {
  const raw = isObjectRecord(call) ? call : {};
  const name = typeof raw.name === 'string' && raw.name ? raw.name : 'unknown';
  const id =
    typeof raw.id === 'string' && raw.id
      ? raw.id
      : `invalid_${stableHash(JSON.stringify(raw)).slice(0, 16)}`;
  const argumentsJson =
    typeof raw.arguments_json === 'string' ? raw.arguments_json : '';
  return { id, name, arguments_json: argumentsJson };
}

function redactedDecision(decision: PolicyDecision): Record<string, unknown> {
  return {
    allowed: decision.allowed,
    reason: decision.reason,
    executor: decision.executor,
    filesystem_roots: decision.filesystem_roots,
    network: decision.network,
    requires_approval: decision.requires_approval,
    redactions: decision.redactions,
    max_runtime_ms: decision.max_runtime_ms,
  };
}

// Redact a declared dot-path segment-by-segment. Arrays are traversed
// element-by-element so a path like 'items.token' redacts the token field in
// EVERY element of an array result (finding L15: declared redactions silently
// no-op'd on array paths, leaking sensitive fields nested under arrays). When
// the final segment lands on an array of scalars (e.g. 'tokens' over
// { tokens: ['a','b'] }), every element is redacted in place.
function redactNode(node: unknown, segments: string[]): void {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      const element = node[index];
      if (segments.length === 0) {
        node[index] = '[REDACTED]';
      } else {
        redactNode(element, segments);
      }
    }
    return;
  }
  if (!isObjectRecord(node)) return;
  redactPath(node, segments);
}

function redactPath(target: JsonObject, segments: string[]): void {
  const [head, ...rest] = segments;
  if (!head) return;
  if (rest.length === 0) {
    if (Object.prototype.hasOwnProperty.call(target, head)) {
      const value = target[head];
      if (Array.isArray(value)) {
        // Final segment is an array of scalars: redact each element rather
        // than only stamping the array reference.
        redactNode(value, []);
      } else {
        target[head] = '[REDACTED]';
      }
    }
    return;
  }
  if (Object.prototype.hasOwnProperty.call(target, head)) {
    redactNode(target[head], rest);
  }
}

// Apply the tool's declared `redactions` (top-level keys or dot-paths) to a
// result before it is returned to the caller or written to the audit log, so
// fields marked sensitive never surface in cleartext (finding: redactions
// declared but never applied).
function applyRedactions(
  result: Record<string, unknown>,
  redactions: string[],
): Record<string, unknown> {
  if (!redactions.length) return result;
  let cloned: Record<string, unknown>;
  try {
    cloned = structuredClone(result);
  } catch {
    cloned = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  }
  for (const path of redactions) {
    if (typeof path === 'string' && path.length > 0) {
      redactPath(cloned, path.split('.'));
    }
  }
  return cloned;
}

function deniedDecision(
  reason: string,
  publicMessage?: string,
): PolicyDecision {
  return {
    allowed: false,
    reason,
    public_message:
      publicMessage || 'This tool is not available in this tenant.',
    executor: 'none',
    filesystem_roots: [],
    network: 'none',
    requires_approval: false,
    redactions: [],
    max_runtime_ms: 0,
  };
}

function allowedDecision(definition: ToolDefinition): PolicyDecision {
  return {
    allowed: true,
    reason: 'allowed',
    public_message: '',
    executor: definition.executor || 'controlled_service',
    filesystem_roots: [...(definition.filesystemRoots || [])],
    network: definition.network || 'none',
    requires_approval: definition.requiresApproval === true,
    redactions: [...(definition.redactions || [])],
    max_runtime_ms: Math.max(1, Math.trunc(definition.maxRuntimeMs || 1_000)),
  };
}

function schemaProperties(schema: JsonObject): Record<string, JsonObject> {
  if (!isObjectRecord(schema.properties)) return {};
  const result: Record<string, JsonObject> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (isObjectRecord(value)) result[key] = value;
  }
  return result;
}

function schemaRequired(schema: JsonObject): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : [];
}

function schemaTypes(schema: JsonObject): string[] {
  if (typeof schema.type === 'string') return [schema.type];
  if (Array.isArray(schema.type)) {
    return schema.type.filter(
      (item): item is string => typeof item === 'string',
    );
  }
  return [];
}

function validateSchemaValue(
  value: unknown,
  schema: JsonObject,
  path: string,
): string | null {
  const types = schemaTypes(schema);
  if (types.length > 0) {
    const matches = types.some((type) => {
      if (type === 'string') return typeof value === 'string';
      if (type === 'number')
        return typeof value === 'number' && Number.isFinite(value);
      if (type === 'integer') return Number.isInteger(value);
      if (type === 'boolean') return typeof value === 'boolean';
      if (type === 'object') return isObjectRecord(value);
      if (type === 'array') return Array.isArray(value);
      if (type === 'null') return value === null;
      return false;
    });
    if (!matches) {
      return `${path} has invalid type`;
    }
  }

  if (
    typeof value === 'string' &&
    typeof schema.maxLength === 'number' &&
    value.length > schema.maxLength
  ) {
    return `${path} exceeds maxLength`;
  }

  if (
    isObjectRecord(value) &&
    (schemaTypes(schema).includes('object') || schema.properties)
  ) {
    return validateArgumentsAgainstSchema(value, schema);
  }

  if (Array.isArray(value) && isObjectRecord(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      const reason = validateSchemaValue(
        value[index],
        schema.items,
        `${path}[${index}]`,
      );
      if (reason) return reason;
    }
  }

  return null;
}

function validateArgumentsAgainstSchema(
  args: JsonObject,
  schema: JsonObject,
): string | null {
  const rootTypes = schemaTypes(schema);
  if (rootTypes.length > 0 && !rootTypes.includes('object')) {
    return 'tool schema root must be object';
  }

  const properties = schemaProperties(schema);
  for (const required of schemaRequired(schema)) {
    if (!Object.prototype.hasOwnProperty.call(args, required)) {
      return `missing required argument: ${required}`;
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        return `unexpected argument: ${key}`;
      }
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    const reason = validateSchemaValue(args[key], propertySchema, key);
    if (reason) return reason;
  }

  return null;
}

function parseArguments(argumentsJson: string): {
  args?: JsonObject;
  error?: string;
} {
  let parsed: unknown;
  try {
    parsed = argumentsJson ? JSON.parse(argumentsJson) : {};
  } catch {
    return { error: 'invalid_json' };
  }
  if (!isObjectRecord(parsed)) return { error: 'arguments_must_be_object' };
  return { args: parsed };
}

function modelRequestedElevation(args: JsonObject): string | null {
  for (const key of Object.keys(args)) {
    if (MODEL_CONTROLLED_ELEVATION_KEYS.has(key)) {
      return `model_controlled_elevation_denied:${key}`;
    }
  }
  return null;
}

function canonicalTool(definition: ToolDefinition): CanonicalTool {
  return {
    name: definition.tool.name,
    description: definition.tool.description,
    input_schema: definition.tool.input_schema,
    policy_tags: [...definition.tool.policy_tags],
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(definitions: ToolDefinition[] = DEFAULT_TOOL_DEFINITIONS) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: ToolDefinition): void {
    const parsedTool = CanonicalToolSchema.parse(definition.tool);
    if (this.tools.has(parsedTool.name)) {
      throw new Error(`Duplicate tool registration: ${parsedTool.name}`);
    }
    this.tools.set(parsedTool.name, {
      ...definition,
      tool: parsedTool,
      enabled: definition.enabled !== false,
    });
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }
}

export const defaultToolRegistry = new ToolRegistry();

export function isToolVisibleToTenant(
  definition: ToolDefinition,
  tenant: TenantRecord,
  session?: ToolSessionContext,
): boolean {
  if (definition.enabled === false || definition.hidden === true) return false;
  const mode = tenantMode(tenant);
  if (
    definition.allowedTenantModes &&
    !definition.allowedTenantModes.includes(mode)
  ) {
    return false;
  }
  if (requiresOwnerIdentity(definition)) {
    return isOwnerAuthorized(tenant, session);
  }
  if (mode === 'guest') {
    // Default-deny for guests (finding M8): visible only when the tool is free
    // of risky capabilities/tags AND carries an explicit guest grant.
    if (isRiskyForGuest(definition)) return false;
    return hasGuestGrant(definition);
  }
  return true;
}

export function visibleToolsFor(
  tenant: TenantRecord,
  session?: ToolSessionContext,
  registry = defaultToolRegistry,
): CanonicalTool[] {
  return registry
    .all()
    .filter((definition) => isToolVisibleToTenant(definition, tenant, session))
    .map(canonicalTool);
}

export class PolicyEngine {
  constructor(private readonly registry = defaultToolRegistry) {}

  authorizeToolCall(input: AuthorizeToolCallInput): PolicyDecision {
    const rawCall = rawCallIdentity(input.call);
    const sessionId =
      input.session?.sessionId || eventSessionIdForTenant(input.tenant);
    const senderId = input.session?.senderId || null;
    const actor = input.session?.actor || 'model';
    const argsHash = stableHash(rawCall.arguments_json || '');

    const requestedEvent = recordTenantEvent({
      tenant: input.tenant,
      type: 'tool_call_requested',
      actor,
      senderId,
      sessionId,
      payload: {
        tool_call_id: rawCall.id,
        tool_name: rawCall.name,
        args_hash: argsHash,
      },
    });
    recordToolCall({
      tenant: input.tenant,
      eventId: requestedEvent.event_id,
      toolCallId: rawCall.id,
      toolName: rawCall.name,
      status: 'requested',
      argsHash,
      senderId,
      sessionId,
      payload: {
        tool_name: rawCall.name,
        args_hash: argsHash,
      },
    });

    const parsedCall = CanonicalToolCallSchema.safeParse(input.call);
    if (!parsedCall.success) {
      return this.logDecision(
        input,
        rawCall,
        deniedDecision('invalid_tool_call_shape'),
        argsHash,
        sessionId,
        senderId,
      );
    }

    const call = parsedCall.data;
    const definition = this.registry.get(call.name);
    if (!definition) {
      return this.logDecision(
        input,
        call,
        deniedDecision('unknown_tool'),
        argsHash,
        sessionId,
        senderId,
      );
    }

    if (definition.enabled === false) {
      return this.logDecision(
        input,
        call,
        deniedDecision('tool_disabled'),
        argsHash,
        sessionId,
        senderId,
      );
    }

    if (definition.hidden === true) {
      return this.logDecision(
        input,
        call,
        deniedDecision('hidden_tool_denied'),
        argsHash,
        sessionId,
        senderId,
      );
    }

    const parsedArgs = parseArguments(call.arguments_json);
    if (parsedArgs.error || !parsedArgs.args) {
      return this.logDecision(
        input,
        call,
        deniedDecision(parsedArgs.error || 'invalid_arguments'),
        argsHash,
        sessionId,
        senderId,
      );
    }

    const elevationReason = modelRequestedElevation(parsedArgs.args);
    if (elevationReason) {
      return this.logDecision(
        input,
        call,
        deniedDecision(elevationReason),
        argsHash,
        sessionId,
        senderId,
      );
    }

    const schemaReason = validateArgumentsAgainstSchema(
      parsedArgs.args,
      definition.tool.input_schema,
    );
    if (schemaReason) {
      return this.logDecision(
        input,
        call,
        deniedDecision(`invalid_arguments:${schemaReason}`),
        argsHash,
        sessionId,
        senderId,
      );
    }

    const policyReason = this.policyDenialReason(
      input.tenant,
      definition,
      input.session,
    );
    if (policyReason) {
      return this.logDecision(
        input,
        call,
        deniedDecision(policyReason),
        argsHash,
        sessionId,
        senderId,
      );
    }

    return this.logDecision(
      input,
      call,
      allowedDecision(definition),
      argsHash,
      sessionId,
      senderId,
    );
  }

  private policyDenialReason(
    tenant: TenantRecord,
    definition: ToolDefinition,
    session?: ToolSessionContext,
  ): string | null {
    const mode = tenantMode(tenant);
    const tags = definition.tool.policy_tags;

    if (tags.includes('deny')) return 'explicit_deny_tag';
    if (
      definition.allowedTenantModes &&
      !definition.allowedTenantModes.includes(mode)
    ) {
      return 'tool_not_visible_for_tenant';
    }
    if (
      requiresOwnerIdentity(definition) &&
      !isOwnerAuthorized(tenant, session)
    ) {
      return 'owner_tool_requires_owner_identity';
    }
    if (isRiskyForGuest(definition)) {
      return mode === 'guest'
        ? 'risky_tool_denied_for_guest'
        : 'risky_tool_disabled_in_phase_5';
    }
    if (mode === 'guest' && !hasGuestGrant(definition)) {
      // Default-deny for guests (finding M8): refuse an untagged tool with no
      // explicit guest grant instead of falling through to allow.
      return 'guest_tool_requires_explicit_grant';
    }
    return null;
  }

  private logDecision(
    input: AuthorizeToolCallInput,
    call: CanonicalToolCall,
    decision: PolicyDecision,
    argsHash: string,
    sessionId: string,
    senderId: string | null,
  ): PolicyDecision {
    const event = recordTenantEvent({
      tenant: input.tenant,
      type: decision.allowed ? 'tool_policy_allowed' : 'tool_policy_denied',
      actor: 'policy_engine',
      senderId,
      sessionId,
      payload: {
        tool_call_id: call.id,
        tool_name: call.name,
        args_hash: argsHash,
        decision: redactedDecision(decision),
      },
    });
    recordToolCall({
      tenant: input.tenant,
      eventId: event.event_id,
      toolCallId: call.id,
      toolName: call.name,
      status: decision.allowed ? 'allowed' : 'denied',
      argsHash,
      senderId,
      sessionId,
      payload: {
        decision: redactedDecision(decision),
      },
    });
    return decision;
  }
}

export async function executeToolCall(
  input: ExecuteToolCallInput,
): Promise<ToolExecutionResult> {
  const registry = input.registry || defaultToolRegistry;
  const engine = input.policyEngine || new PolicyEngine(registry);
  const decision = engine.authorizeToolCall(input);
  const call = CanonicalToolCallSchema.safeParse(input.call);
  if (!decision.allowed || !call.success) {
    return { executed: false, decision };
  }

  const definition = registry.get(call.data.name);
  const sessionId =
    input.session?.sessionId || eventSessionIdForTenant(input.tenant);
  const senderId = input.session?.senderId || null;
  const argsHash = stableHash(call.data.arguments_json || '');
  const parsedArgs = parseArguments(call.data.arguments_json);

  try {
    if (decision.requires_approval) {
      // The policy decision flagged this tool as approval-gated. allowed=true
      // alone is NOT sufficient to run it: a human/operator approval must have
      // been recorded out-of-band for THIS exact server-canonical tool_call_id.
      // The approval is proven only through input.approvals — a trusted,
      // separate input channel — never via the model- or argument-supplied
      // call body, so a prompt-injected model cannot forge its own approval.
      // No verifier (or a verifier that does not confirm) => hold/deny
      // (default-deny). This runs before the executor routability check so an
      // approval-gated tool is held regardless of its executor.
      const approved =
        typeof input.approvals === 'function'
          ? (await input.approvals({
              tenant: input.tenant,
              toolCallId: call.data.id,
              toolName: call.data.name,
              argsHash,
              session: input.session,
            })) === true
          : false;
      if (!approved) {
        throw new Error('approval_required');
      }
    }
    if (decision.executor !== 'controlled_service') {
      // The executor classification promises an isolation boundary
      // (tenant_sandbox / owner_host) that executeToolCall does NOT route to;
      // running it here would execute in-process with full orchestrator
      // privileges under a false containment contract. Refuse rather than
      // silently run unisolated (finding M10). Only controlled_service —
      // genuinely in-process handlers — may run here.
      throw new Error(`executor_not_routable:${decision.executor}`);
    }
    if (!definition?.execute || !parsedArgs.args) {
      throw new Error('No executor is registered for this tool');
    }
    const rawResult = await definition.execute(parsedArgs.args, {
      tenant: input.tenant,
      session: input.session,
      call: call.data,
    });
    // Scrub declared-sensitive fields before the result leaves the executor or
    // hits the audit log (finding: redactions declared but never applied).
    const result = applyRedactions(rawResult, decision.redactions);
    const event = recordTenantEvent({
      tenant: input.tenant,
      type: 'tool_call_executed',
      actor: `tool_executor:${decision.executor}`,
      senderId,
      sessionId,
      payload: {
        tool_call_id: call.data.id,
        tool_name: call.data.name,
        result,
      },
    });
    recordToolCall({
      tenant: input.tenant,
      eventId: event.event_id,
      toolCallId: call.data.id,
      toolName: call.data.name,
      status: 'completed',
      argsHash,
      senderId,
      sessionId,
      payload: {
        result,
      },
    });
    return { executed: true, decision, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const event = recordTenantEvent({
      tenant: input.tenant,
      type: 'tool_call_failed',
      actor: `tool_executor:${decision.executor}`,
      senderId,
      sessionId,
      payload: {
        tool_call_id: call.data.id,
        tool_name: call.data.name,
        error: message,
      },
    });
    recordToolCall({
      tenant: input.tenant,
      eventId: event.event_id,
      toolCallId: call.data.id,
      toolName: call.data.name,
      status: 'error',
      argsHash,
      senderId,
      sessionId,
      payload: {
        error: message,
      },
    });
    return { executed: false, decision, error: message };
  }
}
