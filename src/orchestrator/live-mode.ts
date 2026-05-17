import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { STATE_ROOT } from './config.js';
import { readEnvFile } from './env.js';
import {
  eventSessionIdForTenant,
  recordModelTrace,
  recordTenantEvent,
  recordUsageEvent,
} from './event-store.js';
import { resolveGroupFolderPath } from './group-folder.js';
import {
  createModelGateway,
  type ModelGateway,
  type ModelRequest,
  type ModelResponse,
  type ModelRole,
} from './model-gateway.js';
import {
  chargeQuotaUsage,
  quotaIdempotencyKey,
  type ChargeQuotaResult,
} from './quota.js';
import type { TenantRecord } from './tenant-registry.js';
import {
  executeToolCall,
  visibleToolsFor,
  type ToolExecutionResult,
} from './tool-registry.js';
import type { SenderIdentity } from './types.js';

export type LiveCanaryConfig = {
  enabled: boolean;
  tenantId?: string;
  chatId?: string;
  telegramGuestLiveEnabled?: boolean;
};

export type LiveModelRunInput = {
  tenant: TenantRecord;
  prompt: string;
  senderId?: string;
  senderIdentity?: SenderIdentity;
  modelRole?: ModelRole;
  taskType?: ModelRequest['metadata']['task_type'];
  imagePaths?: string[];
  gateway?: ModelGateway;
  now?: number;
};

export type LiveModelRunResult =
  | {
      status: 'success';
      request: ModelRequest;
      response: ModelResponse;
      answerText: string;
      sessionId: string;
      traceId: string;
      latencyMs: number;
      toolResults: ToolExecutionResult[];
      toolCallsRequested: number;
      toolCallsAllowed: number;
      toolCallsDenied: number;
    }
  | {
      status: 'error';
      request: ModelRequest;
      sessionId: string;
      traceId: string;
      latencyMs: number;
      error: Error;
    };

export type ChargeLiveUsageInput = {
  tenant: TenantRecord;
  run: LiveModelRunResult;
  senderId?: string;
  targetCursor: string;
  createdAt?: number;
};

const LIVE_CANARY_ENV_KEYS = [
  'SKOOBI_LIVE_CANARY_ENABLED',
  'SKOOBI_LIVE_TENANT_ID',
  'SKOOBI_LIVE_CHAT_ID',
  'SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED',
  'SKOOBI_CONFIG_FILE',
];

function readOptionalYamlConfig(): any {
  const env = readEnvFile(['SKOOBI_CONFIG_FILE']);
  const configPath =
    env.SKOOBI_CONFIG_FILE || path.join(STATE_ROOT, 'skoobi.yaml');
  if (!fs.existsSync(configPath)) return {};
  try {
    return YAML.parse(fs.readFileSync(configPath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function boolFrom(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const PROMPT_IMAGE_REF_RE =
  /\breceived\/([A-Za-z0-9][A-Za-z0-9_.-]*\.(?:jpe?g|png|webp|gif))\b/gi;

function isInsideDir(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    Boolean(relative) &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

export function resolvePromptImageAttachments(
  prompt: string,
  groupFolder: string,
  options: { groupsDir?: string; maxImages?: number } = {},
): string[] {
  const maxImages = Math.max(
    0,
    Math.min(3, Math.trunc(options.maxImages ?? 3)),
  );
  if (maxImages === 0) return [];

  const groupDir = options.groupsDir
    ? path.resolve(options.groupsDir, groupFolder)
    : resolveGroupFolderPath(groupFolder);
  const receivedDir = path.join(groupDir, 'received');
  let receivedReal = '';
  try {
    receivedReal = fs.realpathSync(receivedDir);
  } catch {
    return [];
  }

  const images: string[] = [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(PROMPT_IMAGE_REF_RE)) {
    const basename = path.basename(match[1]);
    if (seen.has(basename)) continue;
    seen.add(basename);
    try {
      const real = fs.realpathSync(path.join(receivedDir, basename));
      if (!isInsideDir(real, receivedReal)) continue;
      if (!fs.statSync(real).isFile()) continue;
      images.push(real);
      if (images.length >= maxImages) break;
    } catch {
      continue;
    }
  }
  return images;
}

function promptHasCurrentVisualMedia(prompt: string): boolean {
  return /\[(?:Photo|Video(?: note)?)(?:[^\]]*)\]/i.test(prompt);
}

export function resolveCurrentTurnImageAttachments(
  input: {
    currentPrompt: string;
    fullPrompt: string;
    groupFolder: string;
  },
  options: { groupsDir?: string; maxImages?: number } = {},
): string[] {
  const currentImages = resolvePromptImageAttachments(
    input.currentPrompt,
    input.groupFolder,
    options,
  );
  if (currentImages.length > 0) return currentImages;
  if (promptHasCurrentVisualMedia(input.currentPrompt)) return [];
  return resolvePromptImageAttachments(
    input.fullPrompt,
    input.groupFolder,
    options,
  );
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
    provider_model: usage?.provider_model,
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

export function loadLiveCanaryConfig(
  overrides: Partial<LiveCanaryConfig> = {},
): LiveCanaryConfig {
  const yamlConfig = readOptionalYamlConfig();
  const env = readEnvFile(LIVE_CANARY_ENV_KEYS);
  const liveCanary =
    yamlConfig.runtime?.live_canary ||
    yamlConfig.runtimes?.live_canary ||
    yamlConfig.skoobi_live_canary ||
    {};
  const guestLive =
    yamlConfig.runtime?.telegram_guest_live ||
    yamlConfig.runtimes?.telegram_guest_live ||
    yamlConfig.skoobi_telegram_guest_live ||
    {};
  const tenantId =
    overrides.tenantId ||
    optionalString(env.SKOOBI_LIVE_TENANT_ID) ||
    optionalString(process.env.SKOOBI_LIVE_TENANT_ID) ||
    optionalString(liveCanary.tenant_id);
  const chatId =
    overrides.chatId ||
    optionalString(env.SKOOBI_LIVE_CHAT_ID) ||
    optionalString(process.env.SKOOBI_LIVE_CHAT_ID) ||
    optionalString(liveCanary.chat_id);
  const enabled = boolFrom(
    overrides.enabled ??
      env.SKOOBI_LIVE_CANARY_ENABLED ??
      process.env.SKOOBI_LIVE_CANARY_ENABLED ??
      liveCanary.enabled,
    false,
  );
  const telegramGuestLiveEnabled = boolFrom(
    overrides.telegramGuestLiveEnabled ??
      env.SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED ??
      process.env.SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED ??
      guestLive.enabled,
    false,
  );

  return {
    enabled,
    tenantId,
    chatId,
    telegramGuestLiveEnabled,
  };
}

export function shouldStartLiveMode(
  tenant?: TenantRecord | null,
  config = loadLiveCanaryConfig(),
): boolean {
  if (!tenant) return false;
  if (tenant.group.isMain === true) return false;
  if (tenant.mode !== 'guest') return false;
  if (config.telegramGuestLiveEnabled && tenant.runtime !== 'skoobi_shadow') {
    return true;
  }
  if (tenant.runtime !== 'skoobi_live') return false;
  if (!config.enabled) return false;
  const tenantAllowed = Boolean(
    config.tenantId && tenant.tenant_id === config.tenantId,
  );
  const chatAllowed = Boolean(
    config.chatId && tenant.chat_id === config.chatId,
  );
  return tenantAllowed || chatAllowed;
}

export function liveModeSelectionReason(
  tenant?: TenantRecord | null,
  config = loadLiveCanaryConfig(),
): 'telegram_guest_global' | 'tenant_canary' | null {
  if (!tenant || !shouldStartLiveMode(tenant, config)) return null;
  if (config.telegramGuestLiveEnabled && tenant.runtime !== 'skoobi_shadow') {
    return 'telegram_guest_global';
  }
  return 'tenant_canary';
}

export function buildLiveModelRequest(input: {
  tenant: TenantRecord;
  prompt: string;
  senderId?: string;
  senderIdentity?: SenderIdentity;
  modelRole?: ModelRole;
  taskType?: ModelRequest['metadata']['task_type'];
  imagePaths?: string[];
}): ModelRequest {
  const sessionId = eventSessionIdForTenant(input.tenant);
  const session = {
    sessionId,
    senderId: input.senderId,
    senderIdentity: input.senderIdentity,
  };
  return {
    tenant_id: input.tenant.tenant_id,
    session_id: sessionId,
    model_role: input.modelRole || 'default',
    messages: [
      {
        role: 'system',
        content:
          'You are Skoobi Core running in live canary mode for one low-risk Telegram guest tenant. Answer with text only unless a listed safe tool is genuinely needed. You do not decide permissions: every tool call is authorized by Skoobi PolicyEngine. Never request shell, filesystem, MCP, owner, network, or hidden tools.',
      },
      {
        role: 'user',
        content: input.prompt,
      },
    ],
    tools: visibleToolsFor(input.tenant, session),
    metadata: {
      channel: input.tenant.channel,
      chat_id: input.tenant.chat_id,
      sender_id: input.senderId || '',
      tenant_mode: 'guest',
      task_type:
        input.taskType || (input.imagePaths?.length ? 'vision' : 'chat'),
      image_paths:
        input.imagePaths ??
        resolvePromptImageAttachments(input.prompt, input.tenant.folder),
    },
  };
}

function answerTextFromResponse(
  response: ModelResponse,
  toolResults: ToolExecutionResult[],
): string {
  const text = response.text.trim();
  if (text) return text;

  const executed = toolResults.find((result) => result.executed);
  if (executed?.executed) {
    const message =
      typeof executed.result.message === 'string'
        ? executed.result.message
        : JSON.stringify(executed.result);
    return `Диагностика: ${message}`;
  }

  const denied = toolResults.find((result) => !result.executed);
  if (denied && !denied.executed) {
    return denied.decision.public_message;
  }

  return 'Не получилось получить текстовый ответ. Попробуй ещё раз.';
}

export async function runLiveModelTurn(
  input: LiveModelRunInput,
): Promise<LiveModelRunResult> {
  const request = buildLiveModelRequest(input);
  const startedAt = input.now ?? Date.now();
  const gateway = input.gateway || createModelGateway();
  const session = {
    sessionId: request.session_id,
    senderId: input.senderId,
    senderIdentity: input.senderIdentity,
    actor: 'model',
  };

  try {
    const response = await gateway.complete(request);
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const toolResults: ToolExecutionResult[] = [];

    for (const call of response.tool_calls) {
      toolResults.push(
        await executeToolCall({
          tenant: input.tenant,
          call,
          session,
        }),
      );
    }

    const toolCallsRequested = response.tool_calls.length;
    const toolCallsAllowed = toolResults.filter(
      (result) => result.decision.allowed,
    ).length;
    const toolCallsDenied = toolResults.filter(
      (result) => !result.decision.allowed,
    ).length;
    const answerText = answerTextFromResponse(response, toolResults);

    const traceId = recordModelTrace({
      tenant: input.tenant,
      senderId: input.senderId,
      sessionId: request.session_id,
      runMode: 'live',
      modelRole: request.model_role,
      providerModel: response.usage?.provider_model,
      status: 'success',
      skoobiAnswerLength: answerText.length,
      latencyMs,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      costUsd: response.usage?.cost_usd,
      toolCallsRequested,
      toolCallsAllowed,
      toolCallsDenied,
      finalAnswerHash: hashText(answerText),
      payload: {
        provider_response_id: response.provider_response_id,
        ...modelUsagePayload(response.usage),
        image_attachments: request.metadata.image_paths?.length ?? 0,
        live_answer_sent_to_user: false,
        visible_tools: request.tools.map((tool) => tool.name),
        owner_tools_visible: request.tools.some((tool) =>
          tool.policy_tags.some((tag) => tag.startsWith('owner')),
        ),
      },
    });

    if (response.usage) {
      recordUsageEvent({
        tenant: input.tenant,
        channelUserId: input.senderId,
        modelRole: request.model_role,
        providerModel: response.usage.provider_model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        costUsd: response.usage.cost_usd,
        sessionId: request.session_id,
      });
    }

    recordTenantEvent({
      tenant: input.tenant,
      type: 'model_gateway_live_response',
      actor: 'system',
      senderId: input.senderId,
      sessionId: request.session_id,
      payload: {
        trace_id: traceId,
        status: 'success',
        model_role: request.model_role,
        ...modelUsagePayload(response.usage),
        image_attachments: request.metadata.image_paths?.length ?? 0,
        latency_ms: latencyMs,
        tool_calls_requested: toolCallsRequested,
        tool_calls_allowed: toolCallsAllowed,
        tool_calls_denied: toolCallsDenied,
        live_answer_sent_to_user: false,
      },
    });

    if (response.usage?.model_downgrade_used) {
      recordTenantEvent({
        tenant: input.tenant,
        type: 'codex_model_downgraded',
        actor: 'system',
        senderId: input.senderId,
        sessionId: request.session_id,
        payload: {
          trace_id: traceId,
          requested_model: response.usage.requested_model,
          effective_model: response.usage.effective_model,
          model_downgrade_reason: response.usage.model_downgrade_reason,
          provider_model: response.usage.provider_model,
          provider: response.usage.provider,
        },
      });
    }

    return {
      status: 'success',
      request,
      response,
      answerText,
      sessionId: request.session_id,
      traceId,
      latencyMs,
      toolResults,
      toolCallsRequested,
      toolCallsAllowed,
      toolCallsDenied,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const traceId = recordModelTrace({
      tenant: input.tenant,
      senderId: input.senderId,
      sessionId: request.session_id,
      runMode: 'live',
      modelRole: request.model_role,
      status: 'error',
      latencyMs,
      payload: {
        error: safeErrorPayload(error),
        requested_model:
          error && typeof error === 'object' && 'requestedModel' in error
            ? (error as { requestedModel?: unknown }).requestedModel
            : undefined,
        effective_model:
          error && typeof error === 'object' && 'effectiveModel' in error
            ? (error as { effectiveModel?: unknown }).effectiveModel
            : undefined,
        image_attachments: request.metadata.image_paths?.length ?? 0,
        live_answer_sent_to_user: false,
      },
    });

    recordTenantEvent({
      tenant: input.tenant,
      type: 'model_gateway_live_response',
      actor: 'system',
      senderId: input.senderId,
      sessionId: request.session_id,
      payload: {
        trace_id: traceId,
        status: 'error',
        model_role: request.model_role,
        image_attachments: request.metadata.image_paths?.length ?? 0,
        latency_ms: latencyMs,
        error: safeErrorPayload(error),
        live_answer_sent_to_user: false,
      },
    });

    const classification =
      error && typeof error === 'object' && 'classification' in error
        ? String((error as { classification?: unknown }).classification)
        : '';
    if (classification === 'model_unavailable') {
      recordTenantEvent({
        tenant: input.tenant,
        type: 'codex_model_unavailable',
        actor: 'system',
        senderId: input.senderId,
        sessionId: request.session_id,
        payload: {
          trace_id: traceId,
          requested_model:
            error && typeof error === 'object' && 'requestedModel' in error
              ? (error as { requestedModel?: unknown }).requestedModel
              : undefined,
          effective_model:
            error && typeof error === 'object' && 'effectiveModel' in error
              ? (error as { effectiveModel?: unknown }).effectiveModel
              : undefined,
          fallback_expected: true,
          downgrade_allowed: false,
        },
      });
      recordTenantEvent({
        tenant: input.tenant,
        type: 'codex_circuit_open',
        actor: 'system',
        senderId: input.senderId,
        sessionId: request.session_id,
        payload: {
          trace_id: traceId,
          requested_model:
            error && typeof error === 'object' && 'requestedModel' in error
              ? (error as { requestedModel?: unknown }).requestedModel
              : undefined,
          reason: 'codex_model_unavailable',
        },
      });
    }

    return {
      status: 'error',
      request,
      sessionId: request.session_id,
      traceId,
      latencyMs,
      error,
    };
  }
}

export function chargeLiveUsage(
  input: ChargeLiveUsageInput,
): ChargeQuotaResult | undefined {
  if (input.run.status !== 'success' || !input.run.response.usage) {
    return undefined;
  }
  if (!input.senderId) return undefined;

  const chargeIdempotencyKey = quotaIdempotencyKey({
    tenantId: input.tenant.tenant_id,
    sessionId: input.run.sessionId,
    channel: input.tenant.channel,
    chatId: input.tenant.chat_id,
    channelUserId: input.senderId,
    targetCursor: input.targetCursor,
  });
  const charge = chargeQuotaUsage({
    tenantId: input.tenant.tenant_id,
    sessionId: input.run.sessionId,
    channel: input.tenant.channel,
    chatId: input.tenant.chat_id,
    channelUserId: input.senderId,
    modelRole: input.run.request.model_role,
    providerModel: input.run.response.usage.provider_model,
    inputTokens: input.run.response.usage.input_tokens ?? 0,
    outputTokens: input.run.response.usage.output_tokens ?? 0,
    providerCostUsd: input.run.response.usage.cost_usd,
    idempotencyKey: chargeIdempotencyKey,
    runStatus: 'success',
    isShadow: false,
    createdAt: input.createdAt,
  });

  if (charge.charged) {
    recordTenantEvent({
      tenant: input.tenant,
      type: 'quota_charged',
      actor: `telegram_user:${input.senderId}`,
      senderId: input.senderId,
      sessionId: input.run.sessionId,
      createdAt: input.createdAt,
      payload: {
        channel_user_id: input.senderId,
        usage_ledger_id: charge.usageLedgerId,
        credits_spent: charge.creditsSpent,
        pricing_version: charge.pricingVersion,
        coefficient_version: charge.coefficientVersion,
        idempotency_key: chargeIdempotencyKey,
        runtime: 'skoobi_live',
      },
    });
  }

  return charge;
}
