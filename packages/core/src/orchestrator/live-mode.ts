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
import { personaSystemPrompt } from './persona-registry.js';
import {
  chargeQuotaUsage,
  quotaIdempotencyKey,
  type BillingConfig,
  type ChargeQuotaResult,
} from './quota.js';
import { escapeXml } from './router.js';
import type { TenantRecord } from './tenant-registry.js';
import { SKOOBI_TRUTHFULNESS_PROMPT } from './truthfulness.js';
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
  telegramOwnerLiveEnabled?: boolean;
  /**
   * Owner/admin live turns that need local side effects can use the full
   * Codex CLI agent path (same workspace + MCP surface as the Claude SDK
   * runner) instead of the text-only subscription gateway. Sourced from
   * SKOOBI_CODEX_OWNER_FULL_AGENT_ENABLED or YAML
   * runtime.codex_owner_full_agent.enabled.
   */
  codexOwnerFullAgentEnabled?: boolean;
  /**
   * Controls when the owner/admin live path uses the full Codex CLI agent.
   *  - 'auto' (default): only owner/admin prompts that appear to need local
   *    tools, side effects, memory_get/search, filesystem, service, git, etc.
   *  - 'always': every owner/admin live turn uses the full Codex CLI agent so
   *    Skoobi has the same tool/memory/workspace surface as the legacy Claude
   *    SDK full-access runtime.
   * Sourced from SKOOBI_CODEX_OWNER_FULL_AGENT_MODE or YAML
   * runtime.codex_owner_full_agent.mode.
   */
  codexOwnerFullAgentMode?: 'auto' | 'always';
  /**
   * When false, live Codex failures do NOT fall back to the legacy Claude SDK
   * runtime. Production Codex-only mode uses this to guarantee user-visible
   * answers are never produced by Claude.
   */
  claudeFallbackEnabled?: boolean;
  codexReserveFallbackEnabled?: boolean;
  /**
   * How the Codex reserve fallback runs when the Claude SDK run fails:
   *  - 'full' (default): a full sandboxed agent turn via the Codex CLI — same
   *    group workspace, claudeclaw MCP tools, memory and system context as the
   *    Claude path, so the provider switch is invisible to the user.
   *  - 'text': legacy stripped text-only gateway turn (no tools/workspace).
   * Sourced from SKOOBI_CODEX_RESERVE_MODE or YAML runtime.codex_reserve_mode.
   */
  codexReserveMode?: 'full' | 'text';
  /**
   * Group folders pinned to the Claude SDK runtime. An excluded folder NEVER
   * enters Codex live mode, regardless of the global guest/owner toggles or the
   * canary allowlist. This lets named guest groups (e.g. telegram_guest_canary)
   * stay on Claude while every other guest runs on Codex. Sourced from
   * SKOOBI_LIVE_EXCLUDE_FOLDERS (comma/space-separated) or YAML
   * runtime.live_exclude_folders.
   */
  excludeFolders?: string[];
};

export type LiveModelRunInput = {
  tenant: TenantRecord;
  prompt: string;
  senderId?: string;
  senderIdentity?: SenderIdentity;
  modelRole?: ModelRole;
  taskType?: ModelRequest['metadata']['task_type'];
  imagePaths?: string[];
  webSearchContext?: string;
  webSearchProvider?: string;
  webSearchResultCount?: number;
  voiceReplyRequested?: boolean;
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
  config?: BillingConfig;
};

const LIVE_CANARY_ENV_KEYS = [
  'SKOOBI_LIVE_CANARY_ENABLED',
  'SKOOBI_LIVE_TENANT_ID',
  'SKOOBI_LIVE_CHAT_ID',
  'SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED',
  'SKOOBI_TELEGRAM_OWNER_LIVE_ENABLED',
  'SKOOBI_CODEX_OWNER_FULL_AGENT_ENABLED',
  'SKOOBI_CODEX_OWNER_FULL_AGENT_MODE',
  'SKOOBI_CLAUDE_FALLBACK_ENABLED',
  'SKOOBI_CODEX_RESERVE_FALLBACK_ENABLED',
  'SKOOBI_CODEX_RESERVE_MODE',
  'SKOOBI_LIVE_EXCLUDE_FOLDERS',
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

/**
 * Normalize a folder list from an env string ("a, b c") or a YAML/override
 * array into a trimmed, de-duplicated string[]. Empty/whitespace entries drop.
 */
function parseFolderList(value: unknown): string[] {
  const parts: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') parts.push(item);
    }
  } else if (typeof value === 'string') {
    parts.push(...value.split(/[,\s]+/));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const folder = raw.trim();
    if (folder && !seen.has(folder)) {
      seen.add(folder);
      out.push(folder);
    }
  }
  return out;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const PROMPT_IMAGE_REF_RE =
  /\breceived\/([A-Za-z0-9][A-Za-z0-9_.-]*\.(?:jpe?g|png|webp|gif))\b/gi;
const MAX_PROMPT_IMAGE_BYTES = 15 * 1024 * 1024;

function hasSupportedRasterSignature(filePath: string): boolean {
  let handle: number | undefined;
  try {
    handle = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(12);
    const bytes = fs.readSync(handle, header, 0, header.length, 0);
    if (
      bytes >= 3 &&
      header[0] === 0xff &&
      header[1] === 0xd8 &&
      header[2] === 0xff
    ) {
      return true;
    }
    if (
      bytes >= 8 &&
      header
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return true;
    }
    const ascii = header.subarray(0, bytes).toString('ascii');
    return (
      ascii.startsWith('GIF87a') ||
      ascii.startsWith('GIF89a') ||
      (bytes >= 12 && ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP')
    );
  } catch {
    return false;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

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
      const stat = fs.statSync(real);
      if (
        !stat.isFile() ||
        stat.size <= 0 ||
        stat.size > MAX_PROMPT_IMAGE_BYTES ||
        !hasSupportedRasterSignature(real)
      ) {
        continue;
      }
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

function promptReferencesVisualMedia(prompt: string): boolean {
  return (
    /\b(?:photo|image|picture|screenshot|screen|video|frame|media)\b/i.test(
      prompt,
    ) ||
    /(?:фото|фотк|картин|изображ|скрин|видео|ролик|кружоч|кадр|медиа)/i.test(
      prompt,
    )
  );
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
  if (!promptReferencesVisualMedia(input.currentPrompt)) return [];
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
    web_search_enabled: usage?.web_search_enabled,
  };
}

const MAX_ADMIN_RUNTIME_SYSTEM_PROMPT_CHARS = 4_000;
const ANTHROPIC_SECRET_PREFIX_PATTERN = `${'sk'}-${'ant'}-`;

function redactPotentialSecrets(text: string): string {
  return text
    .replace(
      new RegExp(
        `\\b(?:sk-[A-Za-z0-9_-]{12,}|${ANTHROPIC_SECRET_PREFIX_PATTERN}[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\\b`,
        'g',
      ),
      '[redacted-secret]',
    )
    .replace(
      /\b(token|api[_-]?key|password|secret|authorization|bearer)\s*[:=]\s*["']?[^"'\s]+/gi,
      '$1=[redacted]',
    );
}

function boundedInstructionExcerpt(value: unknown): string {
  if (typeof value !== 'string') return '';
  let text = redactPotentialSecrets(value.trim());
  if (!text) return '';
  if (text.length > MAX_ADMIN_RUNTIME_SYSTEM_PROMPT_CHARS) {
    text = `${text
      .slice(0, MAX_ADMIN_RUNTIME_SYSTEM_PROMPT_CHARS)
      .trimEnd()}\n...`;
  }
  return text;
}

function adminRuntimeContinuityContext(tenant: TenantRecord): string {
  if (tenant.mode !== 'owner' && tenant.group.isMain !== true) return '';
  const cfg = tenant.group.agentConfig || {};
  const allowedTools = Array.isArray(cfg.allowedTools)
    ? cfg.allowedTools.join(', ')
    : '';
  const disallowedTools = Array.isArray(cfg.disallowedTools)
    ? cfg.disallowedTools.join(', ')
    : '';
  const systemPromptExcerpt = boundedInstructionExcerpt(cfg.systemPrompt);

  return [
    `<protected_admin_runtime_continuity tenant_folder="${escapeXml(tenant.folder)}" protected_side_effect_runtime="legacy_admin_runtime" codex_adapter_can_execute_side_effects="false">`,
    'This request is served by Codex while preserving the admin chat continuity and safety model.',
    'Preserve Skoobi admin behaviour: use supplied tenant CLAUDE/AGENT context, same-chat memory, shared user memory, recent conversation, media summaries, and this runtime summary. Do not answer as if you have no context when those blocks are present.',
    'The protected admin runtime may perform local operations only through the explicitly supplied runtime/tool surface. This Codex adapter must not claim direct shell, filesystem, MCP, browser, owner, or hidden-tool access unless those tools are actually available in this turn.',
    'For normal admin conversation, planning, code review from pasted context, explanations, drafting, and decisions: answer directly. For side effects such as reading local files/logs, editing code, git, service restart, database inspection, deployments, or browser actions: use only available tools; if none are available, give a concrete safe plan without presenting yourself as a different bot or blaming another provider.',
    `admin_runtime_config model="${escapeXml(cfg.model || '')}" effort="${escapeXml(cfg.effort || '')}" no_sandbox="${cfg.noSandbox === true}" full_access="${cfg.fullAccess === true}" allowed_tools="${escapeXml(allowedTools)}" disallowed_tools="${escapeXml(disallowedTools)}"`,
    systemPromptExcerpt
      ? `<admin_runtime_instruction_excerpt>${escapeXml(systemPromptExcerpt)}</admin_runtime_instruction_excerpt>`
      : '',
    '</protected_admin_runtime_continuity>',
  ]
    .filter(Boolean)
    .join('\n');
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
  const ownerLive =
    yamlConfig.runtime?.telegram_owner_live ||
    yamlConfig.runtimes?.telegram_owner_live ||
    yamlConfig.skoobi_telegram_owner_live ||
    {};
  const codexReserveFallback =
    yamlConfig.runtime?.codex_reserve_fallback ||
    yamlConfig.runtimes?.codex_reserve_fallback ||
    yamlConfig.skoobi_codex_reserve_fallback ||
    {};
  const claudeFallback =
    yamlConfig.runtime?.claude_fallback ||
    yamlConfig.runtimes?.claude_fallback ||
    yamlConfig.skoobi_claude_fallback ||
    {};
  const codexOwnerFullAgent =
    yamlConfig.runtime?.codex_owner_full_agent ||
    yamlConfig.runtimes?.codex_owner_full_agent ||
    yamlConfig.skoobi_codex_owner_full_agent ||
    {};
  const liveExcludeFolders =
    yamlConfig.runtime?.live_exclude_folders ||
    yamlConfig.runtimes?.live_exclude_folders ||
    yamlConfig.skoobi_live_exclude_folders ||
    undefined;
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
  const telegramOwnerLiveEnabled = boolFrom(
    overrides.telegramOwnerLiveEnabled ??
      env.SKOOBI_TELEGRAM_OWNER_LIVE_ENABLED ??
      process.env.SKOOBI_TELEGRAM_OWNER_LIVE_ENABLED ??
      ownerLive.enabled,
    false,
  );
  const codexReserveFallbackEnabled = boolFrom(
    overrides.codexReserveFallbackEnabled ??
      env.SKOOBI_CODEX_RESERVE_FALLBACK_ENABLED ??
      process.env.SKOOBI_CODEX_RESERVE_FALLBACK_ENABLED ??
      codexReserveFallback.enabled,
    false,
  );
  const claudeFallbackEnabled = boolFrom(
    overrides.claudeFallbackEnabled ??
      env.SKOOBI_CLAUDE_FALLBACK_ENABLED ??
      process.env.SKOOBI_CLAUDE_FALLBACK_ENABLED ??
      claudeFallback.enabled,
    false,
  );
  const codexOwnerFullAgentEnabled = boolFrom(
    overrides.codexOwnerFullAgentEnabled ??
      env.SKOOBI_CODEX_OWNER_FULL_AGENT_ENABLED ??
      process.env.SKOOBI_CODEX_OWNER_FULL_AGENT_ENABLED ??
      codexOwnerFullAgent.enabled,
    false,
  );
  const codexOwnerFullAgentModeRaw = String(
    overrides.codexOwnerFullAgentMode ??
      env.SKOOBI_CODEX_OWNER_FULL_AGENT_MODE ??
      process.env.SKOOBI_CODEX_OWNER_FULL_AGENT_MODE ??
      codexOwnerFullAgent.mode ??
      '',
  )
    .trim()
    .toLowerCase();
  const codexOwnerFullAgentMode: 'auto' | 'always' =
    codexOwnerFullAgentModeRaw === 'always' ? 'always' : 'auto';
  const codexReserveModeRaw = String(
    overrides.codexReserveMode ??
      env.SKOOBI_CODEX_RESERVE_MODE ??
      process.env.SKOOBI_CODEX_RESERVE_MODE ??
      codexReserveFallback.mode ??
      '',
  )
    .trim()
    .toLowerCase();
  const codexReserveMode: 'full' | 'text' =
    codexReserveModeRaw === 'text' ? 'text' : 'full';
  const excludeFolders = parseFolderList(
    overrides.excludeFolders ??
      env.SKOOBI_LIVE_EXCLUDE_FOLDERS ??
      process.env.SKOOBI_LIVE_EXCLUDE_FOLDERS ??
      liveExcludeFolders,
  );

  return {
    enabled,
    tenantId,
    chatId,
    telegramGuestLiveEnabled,
    telegramOwnerLiveEnabled,
    codexOwnerFullAgentEnabled,
    codexOwnerFullAgentMode,
    claudeFallbackEnabled,
    codexReserveFallbackEnabled,
    codexReserveMode,
    excludeFolders,
  };
}

export function shouldStartLiveMode(
  tenant?: TenantRecord | null,
  config = loadLiveCanaryConfig(),
): boolean {
  if (!tenant) return false;
  // Per-folder Claude SDK pin (finding #21): an excluded group never enters
  // Codex live mode, regardless of the global guest/owner toggles or the canary
  // allowlist. This honors the operator's SKOOBI_LIVE_EXCLUDE_FOLDERS routing
  // control. liveModeSelectionReason() delegates here, so it also returns null
  // for these folders.
  if (config.excludeFolders?.includes(tenant.folder)) return false;
  const isOwnerTenant = tenant.mode === 'owner' || tenant.group.isMain === true;
  if (isOwnerTenant) {
    return (
      config.telegramOwnerLiveEnabled === true &&
      tenant.runtime !== 'skoobi_shadow'
    );
  }
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
): 'telegram_guest_global' | 'telegram_owner_global' | 'tenant_canary' | null {
  if (!tenant || !shouldStartLiveMode(tenant, config)) return null;
  if (
    config.telegramOwnerLiveEnabled &&
    (tenant.mode === 'owner' || tenant.group.isMain === true)
  ) {
    return 'telegram_owner_global';
  }
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
  webSearchContext?: string;
  webSearchProvider?: string;
  webSearchResultCount?: number;
  voiceReplyRequested?: boolean;
}): ModelRequest {
  const sessionId = eventSessionIdForTenant(input.tenant);
  const tenantMode = input.tenant.mode === 'owner' ? 'owner' : 'guest';
  const session = {
    sessionId,
    senderId: input.senderId,
    senderIdentity: input.senderIdentity,
  };
  const runtimeSystemPrompt =
    tenantMode === 'owner'
      ? 'You are Skoobi Core running in reserve/live mode for an administrator Telegram tenant. Keep Skoobi continuity across provider changes. Never request or invent tool access, and never claim direct side-effect capabilities that this adapter does not have.'
      : 'You are Skoobi Core running in live canary mode for one low-risk Telegram guest tenant. Answer with text only unless a listed safe tool is genuinely needed. You do not decide permissions: every tool call is authorized by Skoobi PolicyEngine. Never request shell, filesystem, MCP, owner, network, or hidden tools.';
  const adminContinuityContext = adminRuntimeContinuityContext(input.tenant);
  const baseSystemPrompt = [
    SKOOBI_TRUTHFULNESS_PROMPT,
    runtimeSystemPrompt,
    adminContinuityContext,
  ]
    .filter(Boolean)
    .join('\n\n');
  const systemPrompt = input.tenant.persona_id
    ? `${baseSystemPrompt}\n\n${personaSystemPrompt(input.tenant.persona_id)}`
    : baseSystemPrompt;
  const userContent = input.webSearchContext
    ? `${input.webSearchContext}\n\n${input.prompt}`
    : input.prompt;
  return {
    tenant_id: input.tenant.tenant_id,
    session_id: sessionId,
    model_role: input.modelRole || 'default',
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: userContent,
      },
    ],
    tools: visibleToolsFor(input.tenant, session),
    metadata: {
      channel: input.tenant.channel,
      chat_id: input.tenant.chat_id,
      sender_id: input.senderId || '',
      bot_id: input.tenant.bot_id,
      persona_id: input.tenant.persona_id,
      tenant_mode: tenantMode,
      task_type:
        input.taskType ||
        (tenantMode === 'owner'
          ? 'admin'
          : input.imagePaths?.length
            ? 'vision'
            : 'chat'),
      image_paths:
        input.imagePaths ??
        resolvePromptImageAttachments(input.prompt, input.tenant.folder),
      web_search_context_provided: Boolean(input.webSearchContext),
      web_search_provider: input.webSearchProvider,
      web_search_result_count: input.webSearchResultCount,
      voice_reply_requested: Boolean(input.voiceReplyRequested),
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
        web_search_context_provided:
          request.metadata.web_search_context_provided,
        web_search_provider: request.metadata.web_search_provider,
        web_search_result_count: request.metadata.web_search_result_count,
        voice_reply_requested: request.metadata.voice_reply_requested,
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
        web_search_context_provided:
          request.metadata.web_search_context_provided,
        web_search_provider: request.metadata.web_search_provider,
        web_search_result_count: request.metadata.web_search_result_count,
        voice_reply_requested: request.metadata.voice_reply_requested,
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
        web_search_context_provided:
          request.metadata.web_search_context_provided,
        web_search_provider: request.metadata.web_search_provider,
        web_search_result_count: request.metadata.web_search_result_count,
        voice_reply_requested: request.metadata.voice_reply_requested,
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
        web_search_context_provided:
          request.metadata.web_search_context_provided,
        web_search_provider: request.metadata.web_search_provider,
        web_search_result_count: request.metadata.web_search_result_count,
        voice_reply_requested: request.metadata.voice_reply_requested,
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

  // Shadow-mode tenants must never be billed real credits. chargeLiveUsage is
  // also invoked from the Codex reserve-fallback path, which can run for shadow
  // tenants, so derive isShadow from the tenant runtime instead of assuming a
  // live tenant. chargeQuotaUsage skips shadow charges unless the operator has
  // explicitly opted in via chargeShadowRequests.
  const isShadow = input.tenant.runtime === 'skoobi_shadow';

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
    isShadow,
    createdAt: input.createdAt,
    config: input.config,
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
        runtime: input.tenant.runtime,
      },
    });
  }

  return charge;
}
