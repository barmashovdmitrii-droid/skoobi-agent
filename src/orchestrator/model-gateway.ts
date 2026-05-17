import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { createCodexSubscriptionModelGateway } from './codex-subscription-gateway.js';
import { STATE_ROOT } from './config.js';
import { readEnvFile } from './env.js';

export type ModelRole =
  | 'cheap'
  | 'default'
  | 'smart'
  | 'code'
  | 'vision'
  | 'owner';

export type CanonicalMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
};

export type CanonicalTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  policy_tags: string[];
};

export type CanonicalToolCall = {
  id: string;
  name: string;
  arguments_json: string;
};

export type ModelRequest = {
  tenant_id: string;
  session_id: string;
  model_role: ModelRole;
  messages: CanonicalMessage[];
  tools: CanonicalTool[];
  metadata: {
    channel: 'telegram' | 'whatsapp' | 'webhook' | 'cli';
    chat_id: string;
    sender_id: string;
    tenant_mode: 'guest' | 'owner';
    task_type?: 'chat' | 'vision' | 'docs' | 'code' | 'admin';
    image_paths?: string[];
  };
};

export type ModelResponse = {
  text: string;
  tool_calls: CanonicalToolCall[];
  usage?: {
    input_tokens: number | null;
    output_tokens: number | null;
    cost_usd?: number | null;
    provider_model?: string;
    provider?: string;
    usage_source?: 'provider_reported' | 'unavailable_or_estimated';
    requested_model?: string;
    effective_model?: string;
    fallback_used?: boolean;
    fallback_reason?: string;
    model_downgrade_used?: boolean;
    model_downgrade_reason?: string;
  };
  provider_response_id?: string;
};

export interface ModelGateway {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export type ModelGatewayConfig = {
  type: 'openai_compatible' | 'codex_subscription_cli';
  baseUrl: string;
  apiKey?: string;
  roles: Record<ModelRole, string>;
  timeoutMs: number;
  codex?: {
    enabled: boolean;
    command: string;
    model: string;
    fallbackModel: string;
    allowModelDowngrade: boolean;
    timeoutMs: number;
    maxStdoutBytes: number;
    maxStderrBytes: number;
    maxFinalAnswerChars: number;
    scratchRoot: string;
  };
};

type FetchLike = typeof fetch;

const DEFAULT_ROLES: Record<ModelRole, string> = {
  cheap: 'skoobi-cheap',
  default: 'skoobi-balanced',
  smart: 'skoobi-smart',
  code: 'skoobi-smart',
  vision: 'skoobi-vision',
  owner: 'skoobi-smart',
};

export class ModelGatewayNotConfiguredError extends Error {
  constructor(message = 'ModelGateway is not configured') {
    super(message);
    this.name = 'ModelGatewayNotConfiguredError';
  }
}

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

function stringFrom(value: unknown, fallback = ''): string {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function numberFrom(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolFrom(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function normalizeRoles(raw: unknown): Partial<Record<ModelRole, string>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Partial<Record<ModelRole, string>> = {};
  for (const role of Object.keys(DEFAULT_ROLES) as ModelRole[]) {
    const value = (raw as Record<string, unknown>)[role];
    if (typeof value === 'string' && value.trim()) result[role] = value.trim();
  }
  return result;
}

export function loadModelGatewayConfig(
  overrides: Partial<ModelGatewayConfig> = {},
): ModelGatewayConfig {
  const yamlConfig = readOptionalYamlConfig();
  const env = readEnvFile([
    'SKOOBI_MODEL_GATEWAY_TYPE',
    'SKOOBI_MODEL_GATEWAY_BASE_URL',
    'SKOOBI_MODEL_GATEWAY_API_KEY',
    'SKOOBI_MODEL_GATEWAY_KEY',
    'SKOOBI_MODEL_GATEWAY_API_KEY_ENV',
    'SKOOBI_MODEL_GATEWAY_TIMEOUT_MS',
    'SKOOBI_CODEX_SUBSCRIPTION_ENABLED',
    'SKOOBI_CODEX_COMMAND',
    'SKOOBI_CODEX_MODEL',
    'SKOOBI_CODEX_FALLBACK_MODEL',
    'SKOOBI_CODEX_ALLOW_MODEL_DOWNGRADE',
    'SKOOBI_CODEX_TIMEOUT_MS',
    'SKOOBI_CODEX_MAX_STDOUT_BYTES',
    'SKOOBI_CODEX_MAX_STDERR_BYTES',
    'SKOOBI_CODEX_MAX_FINAL_ANSWER_CHARS',
    'SKOOBI_CODEX_SCRATCH_ROOT',
  ]);
  const models = yamlConfig.models || {};
  const gateway = models.gateway || {};
  const roles = models.roles || {};
  const codex =
    models.codex_subscription ||
    yamlConfig.codex_subscription ||
    yamlConfig.runtime?.codex_subscription ||
    {};
  const apiKeyEnv = stringFrom(
    env.SKOOBI_MODEL_GATEWAY_API_KEY_ENV,
    stringFrom(gateway.api_key_env, 'SKOOBI_MODEL_GATEWAY_KEY'),
  );
  const dynamicEnv = apiKeyEnv ? readEnvFile([apiKeyEnv]) : {};
  const apiKey =
    overrides.apiKey ||
    env.SKOOBI_MODEL_GATEWAY_API_KEY ||
    env.SKOOBI_MODEL_GATEWAY_KEY ||
    dynamicEnv[apiKeyEnv] ||
    process.env.SKOOBI_MODEL_GATEWAY_API_KEY ||
    process.env.SKOOBI_MODEL_GATEWAY_KEY ||
    (apiKeyEnv ? process.env[apiKeyEnv] : undefined);

  return {
    type:
      overrides.type ||
      (stringFrom(
        env.SKOOBI_MODEL_GATEWAY_TYPE,
        stringFrom(gateway.type, 'openai_compatible'),
      ) as ModelGatewayConfig['type']),
    baseUrl: normalizeBaseUrl(
      overrides.baseUrl ||
        env.SKOOBI_MODEL_GATEWAY_BASE_URL ||
        stringFrom(gateway.base_url),
    ),
    apiKey,
    roles: {
      ...DEFAULT_ROLES,
      ...normalizeRoles(roles),
      ...(overrides.roles || {}),
    },
    timeoutMs: Math.max(
      1,
      Math.trunc(
        overrides.timeoutMs ||
          numberFrom(env.SKOOBI_MODEL_GATEWAY_TIMEOUT_MS, 60_000),
      ),
    ),
    codex: {
      enabled:
        stringFrom(
          env.SKOOBI_CODEX_SUBSCRIPTION_ENABLED,
          stringFrom(codex.enabled, 'false'),
        ).toLowerCase() === 'true',
      command: stringFrom(
        env.SKOOBI_CODEX_COMMAND,
        stringFrom(codex.command, 'codex'),
      ),
      model: stringFrom(
        env.SKOOBI_CODEX_MODEL,
        stringFrom(codex.model, 'gpt-5.5'),
      ),
      fallbackModel: stringFrom(
        env.SKOOBI_CODEX_FALLBACK_MODEL,
        stringFrom(codex.fallback_model ?? codex.fallbackModel, 'gpt-5.4'),
      ),
      allowModelDowngrade: boolFrom(
        env.SKOOBI_CODEX_ALLOW_MODEL_DOWNGRADE ??
          codex.allow_model_downgrade ??
          codex.allowModelDowngrade,
        false,
      ),
      timeoutMs: Math.max(
        1,
        Math.trunc(
          numberFrom(
            env.SKOOBI_CODEX_TIMEOUT_MS,
            numberFrom(codex.timeout_ms ?? codex.timeoutMs, 90_000),
          ),
        ),
      ),
      maxStdoutBytes: Math.max(
        1024,
        Math.trunc(
          numberFrom(
            env.SKOOBI_CODEX_MAX_STDOUT_BYTES,
            numberFrom(codex.max_stdout_bytes ?? codex.maxStdoutBytes, 262_144),
          ),
        ),
      ),
      maxStderrBytes: Math.max(
        1024,
        Math.trunc(
          numberFrom(
            env.SKOOBI_CODEX_MAX_STDERR_BYTES,
            numberFrom(codex.max_stderr_bytes ?? codex.maxStderrBytes, 65_536),
          ),
        ),
      ),
      maxFinalAnswerChars: Math.max(
        1,
        Math.trunc(
          numberFrom(
            env.SKOOBI_CODEX_MAX_FINAL_ANSWER_CHARS,
            numberFrom(
              codex.max_final_answer_chars ?? codex.maxFinalAnswerChars,
              8_000,
            ),
          ),
        ),
      ),
      scratchRoot: path.resolve(
        stringFrom(
          env.SKOOBI_CODEX_SCRATCH_ROOT,
          stringFrom(
            codex.scratch_root ?? codex.scratchRoot,
            path.join(process.cwd(), 'tmp', 'skoobi-codex-runs'),
          ),
        ),
      ),
    },
  };
}

export function resolveModelRoute(
  role: ModelRole,
  config: Pick<ModelGatewayConfig, 'roles'>,
): string {
  const route = config.roles[role] || config.roles.default;
  if (!route)
    throw new ModelGatewayNotConfiguredError(
      'Model role route is not configured',
    );
  return route;
}

function normalizeOpenAIMessage(
  message: CanonicalMessage,
): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
  };
}

function normalizeCanonicalTool(tool: CanonicalTool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

function normalizeToolCall(raw: any, index: number): CanonicalToolCall {
  return {
    id:
      typeof raw?.id === 'string' && raw.id.trim()
        ? raw.id
        : `tool_call_${index + 1}`,
    name: String(raw?.function?.name || raw?.name || 'unknown'),
    arguments_json:
      typeof raw?.function?.arguments === 'string'
        ? raw.function.arguments
        : typeof raw?.arguments === 'string'
          ? raw.arguments
          : '{}',
  };
}

function extractText(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractUsage(
  raw: any,
  providerModel: string,
): ModelResponse['usage'] | undefined {
  const usage = raw?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const inputTokens =
    numberOrUndefined(usage.input_tokens) ??
    numberOrUndefined(usage.prompt_tokens) ??
    0;
  const outputTokens =
    numberOrUndefined(usage.output_tokens) ??
    numberOrUndefined(usage.completion_tokens) ??
    0;
  return {
    input_tokens: Math.max(0, Math.trunc(inputTokens)),
    output_tokens: Math.max(0, Math.trunc(outputTokens)),
    cost_usd:
      numberOrUndefined(usage.cost_usd) ??
      numberOrUndefined(usage.total_cost) ??
      numberOrUndefined(raw?._hidden_params?.response_cost),
    provider_model:
      typeof raw?.model === 'string' && raw.model.trim()
        ? raw.model
        : providerModel,
  };
}

export class OpenAICompatibleModelGateway implements ModelGateway {
  private readonly config: ModelGatewayConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config = loadModelGatewayConfig(), fetchImpl: FetchLike = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!this.config.baseUrl) throw new ModelGatewayNotConfiguredError();
    const providerModel = resolveModelRoute(request.model_role, this.config);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.config.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.config.apiKey
              ? { authorization: `Bearer ${this.config.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: providerModel,
            messages: request.messages.map(normalizeOpenAIMessage),
            stream: false,
            ...(request.tools.length > 0
              ? { tools: request.tools.map(normalizeCanonicalTool) }
              : {}),
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`ModelGateway provider error: HTTP ${response.status}`);
      }
      const raw = (await response.json()) as any;
      const message = raw?.choices?.[0]?.message || {};
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls.map(normalizeToolCall)
        : [];
      return {
        text: extractText(message),
        tool_calls: toolCalls,
        usage: extractUsage(raw, providerModel),
        provider_response_id:
          typeof raw?.id === 'string' && raw.id.trim() ? raw.id : undefined,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createModelGateway(
  config = loadModelGatewayConfig(),
  fetchImpl?: FetchLike,
): ModelGateway {
  if (config.type === 'codex_subscription_cli') {
    return createCodexSubscriptionModelGateway(config.codex);
  }
  return new OpenAICompatibleModelGateway(config, fetchImpl || fetch);
}
