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

export type ExecuteToolCallInput = AuthorizeToolCallInput & {
  policyEngine?: PolicyEngine;
  registry?: ToolRegistry;
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

function tenantMode(tenant: TenantRecord): TenantMode {
  return tenant.mode === 'owner' ? 'owner' : 'guest';
}

function isOwnerAuthorized(
  tenant: TenantRecord,
  session?: ToolSessionContext,
): boolean {
  return (
    tenant.mode === 'owner' && session?.senderIdentity?.is_owner_sender === true
  );
}

function hasAnyTag(tags: string[], needles: Set<string>): boolean {
  return tags.some((tag) => needles.has(tag));
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
  if (hasAnyTag(definition.tool.policy_tags, OWNER_TOOL_TAGS)) {
    return isOwnerAuthorized(tenant, session);
  }
  if (
    mode === 'guest' &&
    hasAnyTag(definition.tool.policy_tags, RISKY_TOOL_TAGS)
  ) {
    return false;
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

    if (
      definition.allowedTenantModes &&
      !definition.allowedTenantModes.includes(mode)
    ) {
      return 'tool_not_visible_for_tenant';
    }
    if (
      hasAnyTag(tags, OWNER_TOOL_TAGS) &&
      !isOwnerAuthorized(tenant, session)
    ) {
      return 'owner_tool_requires_owner_identity';
    }
    if (hasAnyTag(tags, RISKY_TOOL_TAGS)) {
      return mode === 'guest'
        ? 'risky_tool_denied_for_guest'
        : 'risky_tool_disabled_in_phase_5';
    }
    if (tags.includes('deny')) return 'explicit_deny_tag';
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
    if (!definition?.execute || !parsedArgs.args) {
      throw new Error('No executor is registered for this tool');
    }
    const result = await definition.execute(parsedArgs.args, {
      tenant: input.tenant,
      session: input.session,
      call: call.data,
    });
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
