import { createHash } from 'crypto';

import {
  eventSessionIdForTenant,
  recordModelTrace,
  recordTenantEvent,
  recordUsageEvent,
} from './event-store.js';
import {
  createModelGateway,
  type ModelGateway,
  type ModelRequest,
  type ModelResponse,
  type ModelRole,
} from './model-gateway.js';
import type { TenantRecord } from './tenant-registry.js';

type ShadowModelRun = {
  request: ModelRequest;
  startedAt: number;
  result: Promise<
    | { status: 'success'; response: ModelResponse; latencyMs: number }
    | { status: 'error'; error: Error; latencyMs: number }
  >;
};

export type StartShadowRunInput = {
  tenant: TenantRecord;
  prompt: string;
  senderId?: string;
  modelRole?: ModelRole;
  taskType?: ModelRequest['metadata']['task_type'];
  gateway?: ModelGateway;
  now?: number;
};

export type FinishShadowRunInput = {
  tenant: TenantRecord;
  run: ShadowModelRun;
  senderId?: string;
  legacyAnswerText: string;
  createdAt?: number;
};

export function shouldStartShadowMode(
  tenant?: TenantRecord | null,
): tenant is TenantRecord {
  return tenant?.runtime === 'skoobi_shadow';
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function safeErrorPayload(err: Error): Record<string, unknown> {
  return {
    name: err.name,
    message: err.message,
    classification:
      err && typeof err === 'object' && 'classification' in err
        ? String((err as { classification?: unknown }).classification)
        : undefined,
    requested_model:
      err && typeof err === 'object' && 'requestedModel' in err
        ? (err as { requestedModel?: unknown }).requestedModel
        : undefined,
    effective_model:
      err && typeof err === 'object' && 'effectiveModel' in err
        ? (err as { effectiveModel?: unknown }).effectiveModel
        : undefined,
  };
}

function modelUsagePayload(
  usage: ModelResponse['usage'] | undefined,
): Record<string, unknown> {
  return {
    provider: usage?.provider,
    usage_source: usage?.usage_source,
    requested_model: usage?.requested_model,
    effective_model: usage?.effective_model,
    fallback_used: usage?.fallback_used,
    fallback_reason: usage?.fallback_reason,
    model_downgrade_used: usage?.model_downgrade_used,
    model_downgrade_reason: usage?.model_downgrade_reason,
  };
}

export function buildShadowModelRequest(input: {
  tenant: TenantRecord;
  prompt: string;
  senderId?: string;
  modelRole?: ModelRole;
  taskType?: ModelRequest['metadata']['task_type'];
}): ModelRequest {
  const sessionId = eventSessionIdForTenant(input.tenant);
  return {
    tenant_id: input.tenant.tenant_id,
    session_id: sessionId,
    model_role: input.modelRole || 'default',
    messages: [
      {
        role: 'system',
        content:
          'You are Skoobi Core running in shadow mode. Produce a concise assistant answer. Do not request or execute tools.',
      },
      {
        role: 'user',
        content: input.prompt,
      },
    ],
    tools: [],
    metadata: {
      channel: input.tenant.channel,
      chat_id: input.tenant.chat_id,
      sender_id: input.senderId || '',
      tenant_mode: input.tenant.mode === 'owner' ? 'owner' : 'guest',
      task_type: input.taskType || 'chat',
    },
  };
}

export function startShadowModelRun(
  input: StartShadowRunInput,
): ShadowModelRun {
  const request = buildShadowModelRequest(input);
  const startedAt = input.now ?? Date.now();
  const gateway = input.gateway || createModelGateway();
  const result = gateway
    .complete(request)
    .then((response) => ({
      status: 'success' as const,
      response,
      latencyMs: Math.max(0, Date.now() - startedAt),
    }))
    .catch((err) => ({
      status: 'error' as const,
      error: err instanceof Error ? err : new Error(String(err)),
      latencyMs: Math.max(0, Date.now() - startedAt),
    }));

  return { request, startedAt, result };
}

export async function finishShadowModelRun(
  input: FinishShadowRunInput,
): Promise<string> {
  const result = await input.run.result;
  const createdAt = input.createdAt ?? Date.now();
  const legacyHash = hashText(input.legacyAnswerText);
  const sessionId = input.run.request.session_id;

  if (result.status === 'success') {
    const toolCallsRequested = result.response.tool_calls.length;
    const traceId = recordModelTrace({
      tenant: input.tenant,
      senderId: input.senderId,
      sessionId,
      runMode: 'shadow',
      modelRole: input.run.request.model_role,
      providerModel: result.response.usage?.provider_model,
      status: 'success',
      legacyAnswerLength: input.legacyAnswerText.length,
      skoobiAnswerLength: result.response.text.length,
      latencyMs: result.latencyMs,
      inputTokens: result.response.usage?.input_tokens,
      outputTokens: result.response.usage?.output_tokens,
      costUsd: result.response.usage?.cost_usd,
      toolCallsRequested,
      toolCallsAllowed: 0,
      toolCallsDenied: toolCallsRequested,
      finalAnswerHash: hashText(result.response.text),
      payload: {
        provider_response_id: result.response.provider_response_id,
        ...modelUsagePayload(result.response.usage),
        legacy_answer_hash: legacyHash,
        dangerous_tools_executed: false,
        shadow_answer_sent_to_user: false,
      },
      createdAt,
    });

    if (result.response.usage) {
      recordUsageEvent({
        tenant: input.tenant,
        channelUserId: input.senderId,
        modelRole: input.run.request.model_role,
        providerModel: result.response.usage.provider_model,
        inputTokens: result.response.usage.input_tokens,
        outputTokens: result.response.usage.output_tokens,
        costUsd: result.response.usage.cost_usd,
        sessionId,
        createdAt,
      });
      recordTenantEvent({
        tenant: input.tenant,
        type: 'quota_charge_skipped_shadow',
        actor: input.senderId
          ? `telegram_user:${input.senderId}`
          : 'telegram_user:unknown',
        senderId: input.senderId,
        sessionId,
        payload: {
          reason: 'shadow',
          model_role: input.run.request.model_role,
          provider_model: result.response.usage.provider_model,
          ...modelUsagePayload(result.response.usage),
          trace_id: traceId,
        },
        createdAt,
      });
    }

    recordTenantEvent({
      tenant: input.tenant,
      type: 'model_gateway_shadow_trace',
      actor: 'system',
      senderId: input.senderId,
      sessionId,
      payload: {
        trace_id: traceId,
        status: 'success',
        model_role: input.run.request.model_role,
        provider_model: result.response.usage?.provider_model,
        ...modelUsagePayload(result.response.usage),
        latency_ms: result.latencyMs,
        tool_calls_requested: toolCallsRequested,
        tool_calls_denied: toolCallsRequested,
        shadow_answer_sent_to_user: false,
      },
      createdAt,
    });

    if (result.response.usage?.model_downgrade_used) {
      recordTenantEvent({
        tenant: input.tenant,
        type: 'codex_model_downgraded',
        actor: 'system',
        senderId: input.senderId,
        sessionId,
        payload: {
          trace_id: traceId,
          requested_model: result.response.usage.requested_model,
          effective_model: result.response.usage.effective_model,
          model_downgrade_reason: result.response.usage.model_downgrade_reason,
          provider_model: result.response.usage.provider_model,
          provider: result.response.usage.provider,
          run_mode: 'shadow',
        },
        createdAt,
      });
    }

    return traceId;
  }

  const traceId = recordModelTrace({
    tenant: input.tenant,
    senderId: input.senderId,
    sessionId,
    runMode: 'shadow',
    modelRole: input.run.request.model_role,
    status: 'error',
    legacyAnswerLength: input.legacyAnswerText.length,
    latencyMs: result.latencyMs,
    finalAnswerHash: null,
    payload: {
      legacy_answer_hash: legacyHash,
      error: safeErrorPayload(result.error),
      dangerous_tools_executed: false,
      shadow_answer_sent_to_user: false,
    },
    createdAt,
  });

  recordTenantEvent({
    tenant: input.tenant,
    type: 'model_gateway_shadow_trace',
    actor: 'system',
    senderId: input.senderId,
    sessionId,
    payload: {
      trace_id: traceId,
      status: 'error',
      model_role: input.run.request.model_role,
      latency_ms: result.latencyMs,
      error: safeErrorPayload(result.error),
      shadow_answer_sent_to_user: false,
    },
    createdAt,
  });

  return traceId;
}
