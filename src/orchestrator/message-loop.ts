import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  DEFAULT_RUNTIME,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  GROUPS_DIR,
  TIMEZONE,
  TRIGGER_PATTERN,
  WEBHOOK_PORT,
  WEBHOOK_SECRET,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  cleanupSandboxOrphans,
  ensureSandboxRuntimeAvailable,
  runSandboxAgent,
} from '../runtimes/sandbox-runner.js';
// Channels loaded from src/index.ts;
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channel-registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from '../runtimes/container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from '../runtimes/container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRecentConversationMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeBotReply,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  prependRecentConversationContext,
} from './router.js';
import { loadGroupMemoryContext } from './memory-context.js';
import { createMessageRouter } from './outbound-router.js';
import { createMessageIngestion } from './ingestion.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  eventSessionIdForTenant,
  recordTenantEvent,
  recordUsageEvent,
  type EventType,
} from './event-store.js';
import { agentConfigWithTenantInstructions } from './instructions.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  createTelegramSenderIdentity,
  loadOwnerAllowlistFromEnv,
  TenantRegistry,
} from './tenant-registry.js';
import {
  callExtensionStartup,
  getExtensionDbSchema,
  wireExtensionHooks,
} from './extensions.js';
import {
  chargeQuotaUsage,
  checkQuotaPreflight,
  formatQuotaBlockedRu,
  quotaIdempotencyKey,
} from './quota.js';
import {
  chargeLiveUsage,
  liveModeSelectionReason,
  resolveCurrentTurnImageAttachments,
  runLiveModelTurn,
  shouldStartLiveMode,
} from './live-mode.js';
import {
  DEFAULT_PROVIDER_FAILOVER_POLICY,
  classifyProviderFailure,
  failedProviderAttempt,
  shouldFallbackToProvider,
  type ProviderAttempt,
} from './provider-failover.js';
import {
  getProviderCircuitDecision,
  recordProviderCircuitFailure,
  recordProviderCircuitSuccess,
  type ProviderCircuitDecision,
  type ProviderCircuitFailureResult,
  type ProviderCircuitSuccessResult,
} from './provider-circuit-breaker.js';
import {
  finishShadowModelRun,
  shouldStartShadowMode,
  startShadowModelRun,
} from './shadow-mode.js';
// Load plugins (self-registering on import)
// Extensions loaded from src/index.ts;
import {
  AgentConfig,
  Channel,
  MessageRouter,
  NewMessage,
  OutboundEnvelope,
  RegisteredGroup,
  TelegramCallbackQueryEvent,
} from './types.js';
import { logger } from './logger.js';
import { logAgentRun } from '../cost-tracking/index.js';
import { startWebhookServer } from '../webhook/server.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

/**
 * Detect Anthropic-API error envelopes that the agent runtime sometimes
 * surfaces as a "result" string (e.g. when Claude's API returns 500/529
 * instead of a real completion). The agent runtime forwards these as if
 * they were normal output, which means the raw JSON ends up in the user's
 * chat — bad UX, exposes request_ids, and confuses non-technical users.
 *
 * If `raw` matches `API Error: <status> <json>` and the status is 5xx,
 * return a friendly Russian message. Otherwise return null (caller routes
 * the original text).
 *
 * The agent's native error metadata (result.status === 'error') is set
 * separately and is left untouched — it still goes through the normal
 * hadError tracking path. We only rewrite the *user-facing text*.
 */
export function rewriteTransientApiError(raw: string): string | null {
  const m = raw.match(/^API Error:\s*(\d+)\s*(\{.*\})\s*$/s);
  if (!m) return null;
  const status = parseInt(m[1], 10);
  if (!(status >= 500 && status < 600)) return null;
  let errType = '';
  try {
    errType =
      (JSON.parse(m[2]) as { error?: { type?: string } })?.error?.type ?? '';
  } catch {
    /* fall through — friendly message still applies for 5xx */
  }
  if (errType === 'overloaded_error' || status === 529) {
    return '🐾 Claude сейчас перегружен — попробуй ещё раз через минуту.';
  }
  return '🐾 Временный сбой Claude API — попробуй ещё раз.';
}

/**
 * Decide whether the orchestrator should auto-route the agent's STDOUT result
 * back to the source channel.
 *
 * Two independent flags can suppress routing:
 *   - inboundOnly === true             — legacy gate (also drops typing indicator)
 *   - suppressAgentStdoutRouting === true — defense-in-depth gate (independent of inboundOnly)
 *
 * Either flag is sufficient. Use suppressAgentStdoutRouting on supplier-facing
 * groups that still want a controlled outbound channel via the explicit
 * send-message MCP tool but must NEVER leak the agent's narrative / internal
 * IDs to the channel — a regression of inboundOnly to false alone will not
 * re-open the leak as long as suppressAgentStdoutRouting stays true.
 *
 * Returns true (allow routing) when agentConfig is undefined, preserving the
 * default behaviour for groups without explicit config.
 */
export function shouldAutoRouteAgentOutput(
  agentConfig: AgentConfig | undefined,
): boolean {
  if (!agentConfig) return true;
  if (agentConfig.inboundOnly === true) return false;
  if (agentConfig.suppressAgentStdoutRouting === true) return false;
  return true;
}

export function promptRequiresLegacyMediaVision(
  prompt: string,
  hasImageAttachments = false,
): boolean {
  if (hasImageAttachments) return false;
  const normalized = prompt.replace(/\s+/g, ' ');
  if (
    /\[Photo\.\s+File:[^\]]*use Read tool to inspect visual context/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /\[Video note[^\]]*Key frames:[^\]]*use Read tool to inspect visual context/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /\[Video note[^\]]*Key-frame files:/i.test(normalized) &&
    !/\[Video note[^\]]*Visual summary:/i.test(normalized)
  ) {
    return true;
  }
  return false;
}

export function cursorAfterConfirmedSend(
  currentCursor: string | undefined,
  targetCursor: string,
  pipedCursor?: string,
): string {
  let nextCursor = currentCursor || '';
  for (const cursor of [targetCursor, pipedCursor || '']) {
    if (cursor > nextCursor) nextCursor = cursor;
  }
  return nextCursor;
}

export function hasUnconfirmedPipedMessages(
  pipedCursor: string | undefined,
  confirmedCursor: string | undefined,
): boolean {
  return Boolean(pipedCursor && pipedCursor > (confirmedCursor || ''));
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// Tracks messages piped into an active runner via IPC (pipe-path в startMessageLoop).
// Не персистится — это in-memory window между fresh-dispatch и confirmed send.
// На confirmed send в onOutput — сливается в lastAgentTimestamp.
// На agent error/exit — clear, чтобы fresh dispatch перепрочитал piped messages.
const lastPipedTimestamp: Record<string, string> = {};
// Initial batch cursor for the currently active runner per chat. Explicit IPC
// sends can be confirmed before the runner emits its final stdout summary, so
// they need a safe cursor target that only covers messages the runner has seen.
const activeRunTargetTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function currentTenantRegistry(): TenantRegistry {
  return TenantRegistry.fromRegisteredGroups(registeredGroups);
}

function errorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { message: String(err) };
}

function recordEventSafely(input: {
  chatJid: string;
  type: EventType;
  actor: string;
  senderId?: string | null;
  payload: Record<string, unknown>;
}): void {
  if (!input.chatJid.startsWith('tg:')) return;
  const tenant = currentTenantRegistry().resolveJid(input.chatJid);
  if (!tenant) return;
  try {
    recordTenantEvent({
      tenant,
      type: input.type,
      actor: input.actor,
      senderId: input.senderId,
      payload: input.payload,
    });
  } catch (err) {
    logger.warn(
      { err, chatJid: input.chatJid, type: input.type },
      'Event store append failed',
    );
  }
}

function getProviderCircuitDecisionSafely(input: {
  provider: typeof DEFAULT_PROVIDER_FAILOVER_POLICY.primary;
}): ProviderCircuitDecision {
  try {
    return getProviderCircuitDecision(input);
  } catch (err) {
    logger.warn(
      { err, provider: input.provider },
      'Provider circuit decision failed; allowing primary provider attempt',
    );
    return {
      provider: input.provider,
      state: 'closed',
      action: 'allow',
    };
  }
}

function recordProviderCircuitFailureSafely(input: {
  provider: typeof DEFAULT_PROVIDER_FAILOVER_POLICY.primary;
  reason: ReturnType<typeof classifyProviderFailure>;
}): ProviderCircuitFailureResult | undefined {
  try {
    return recordProviderCircuitFailure(input);
  } catch (err) {
    logger.warn(
      { err, provider: input.provider, reason: input.reason },
      'Provider circuit failure update failed; continuing failover',
    );
    return undefined;
  }
}

function recordProviderCircuitSuccessSafely(input: {
  provider: typeof DEFAULT_PROVIDER_FAILOVER_POLICY.primary;
}): ProviderCircuitSuccessResult | undefined {
  try {
    return recordProviderCircuitSuccess(input);
  } catch (err) {
    logger.warn(
      { err, provider: input.provider },
      'Provider circuit success update failed; continuing delivery',
    );
    return undefined;
  }
}

export function telegramInboundEventPayload(
  chatJid: string,
  msg: NewMessage,
): Record<string, unknown> {
  const senderId = msg.sender_identity?.telegram_user_id || msg.sender || null;
  return {
    message_id: msg.id,
    update_id: msg.telegram_update_id,
    chat_jid: chatJid,
    sender_id: senderId,
    sender_name_hint:
      msg.sender_identity?.display_name_hint || msg.sender_name || undefined,
    username_hint: msg.sender_identity?.username_hint,
    content: msg.content,
    timestamp: msg.timestamp,
    is_from_me: msg.is_from_me === true,
    is_bot_message: msg.is_bot_message === true,
  };
}

function recordTelegramInboundEvent(chatJid: string, msg: NewMessage): void {
  const senderId = msg.sender_identity?.telegram_user_id || msg.sender || null;
  recordEventSafely({
    chatJid,
    type: 'telegram_inbound_message',
    actor: senderId ? `telegram_user:${senderId}` : 'telegram_user:unknown',
    senderId,
    payload: telegramInboundEventPayload(chatJid, msg),
  });
}

function recordTelegramCallbackEvent(event: TelegramCallbackQueryEvent): void {
  const senderId = event.from_id || null;
  recordEventSafely({
    chatJid: event.chat_jid,
    type: 'telegram_inbound_callback_query',
    actor: senderId ? `telegram_user:${senderId}` : 'telegram_user:unknown',
    senderId,
    payload: {
      callback_query_id: event.id,
      kind: event.kind,
      data: event.data,
      message_id: event.message_id,
      sender_id: senderId,
      username_hint: event.username_hint,
      display_name_hint: event.display_name_hint,
      timestamp: event.timestamp,
    },
  });
}

function recordTelegramOutboundEvent(envelope: OutboundEnvelope): void {
  recordEventSafely({
    chatJid: envelope.chatJid,
    type: 'telegram_outbound_message',
    actor: 'assistant',
    senderId: 'bot',
    payload: {
      chat_jid: envelope.chatJid,
      trigger_type: envelope.triggerType,
      group_folder: envelope.groupFolder,
      text: envelope.text,
      meta_kind:
        envelope.meta && typeof envelope.meta.kind === 'string'
          ? envelope.meta.kind
          : undefined,
      timestamp: new Date().toISOString(),
    },
  });
}

function preferredUserMessage(messages: NewMessage[]): NewMessage | undefined {
  const triggerMsg = messages.find((m) =>
    TRIGGER_PATTERN.test(m.content.trim()),
  );
  return triggerMsg || messages[messages.length - 1];
}

function quotaUserIdForMessages(messages: NewMessage[]): string | undefined {
  const msg = preferredUserMessage(messages);
  return msg?.sender_identity?.telegram_user_id || msg?.sender || undefined;
}

function senderIdentityForMessages(messages: NewMessage[]) {
  return preferredUserMessage(messages)?.sender_identity;
}

async function maybeBlockTelegramQuota(input: {
  chatJid: string;
  replyJid: string;
  group: RegisteredGroup;
  messages: NewMessage[];
  targetCursor: string;
  router: MessageRouter;
}): Promise<{ blocked: boolean; delivered: boolean; channelUserId?: string }> {
  if (!input.chatJid.startsWith('tg:')) {
    return { blocked: false, delivered: false };
  }
  const tenant = currentTenantRegistry().resolveJid(input.chatJid);
  const channelUserId = quotaUserIdForMessages(input.messages);
  if (!tenant || !channelUserId) {
    return { blocked: false, delivered: false, channelUserId };
  }

  const preflight = checkQuotaPreflight({
    tenantId: tenant.tenant_id,
    channel: tenant.channel,
    channelUserId,
  });
  if (preflight.status) {
    recordEventSafely({
      chatJid: input.chatJid,
      type: 'quota_checked',
      actor: `telegram_user:${channelUserId}`,
      senderId: channelUserId,
      payload: {
        channel_user_id: channelUserId,
        weekly_limit_credits: preflight.status.weeklyLimitCredits,
        spent_credits: preflight.status.spentCredits,
        adjustment_credits: preflight.status.adjustmentCredits,
        remaining_credits: preflight.status.remainingCredits,
        period_start: preflight.status.period.startMs,
        period_end: preflight.status.period.endMs,
      },
    });
  }
  if (preflight.allowed || !preflight.status) {
    return { blocked: false, delivered: false, channelUserId };
  }

  recordEventSafely({
    chatJid: input.chatJid,
    type: 'quota_blocked',
    actor: `telegram_user:${channelUserId}`,
    senderId: channelUserId,
    payload: {
      channel_user_id: channelUserId,
      reason: preflight.reason,
      weekly_limit_credits: preflight.status.weeklyLimitCredits,
      spent_credits: preflight.status.spentCredits,
      remaining_credits: preflight.status.remainingCredits,
      period_start: preflight.status.period.startMs,
      period_end: preflight.status.period.endMs,
    },
  });

  try {
    const deliveredText = await input.router.route({
      chatJid: input.replyJid,
      text: formatQuotaBlockedRu(preflight.status),
      triggerType: 'agent-response',
      groupFolder: input.group.folder,
      meta: { kind: 'quota_blocked' },
    });
    if (deliveredText) {
      storeBotReply(input.replyJid, deliveredText);
      const currentCursor = lastAgentTimestamp[input.chatJid] || '';
      const pipedCursor = lastPipedTimestamp[input.chatJid] || '';
      const newCursor = cursorAfterConfirmedSend(
        currentCursor,
        input.targetCursor,
        pipedCursor,
      );
      if (lastAgentTimestamp[input.chatJid] !== newCursor) {
        lastAgentTimestamp[input.chatJid] = newCursor;
        saveState();
      }
      delete lastPipedTimestamp[input.chatJid];
    }
    return { blocked: true, delivered: Boolean(deliveredText), channelUserId };
  } catch (err) {
    recordEventSafely({
      chatJid: input.chatJid,
      type: 'error',
      actor: 'system',
      payload: {
        kind: 'quota_block_delivery_failed',
        reply_jid: input.replyJid,
        group_folder: input.group.folder,
        ...errorPayload(err),
      },
    });
    logger.warn(
      { err, chatJid: input.chatJid, replyJid: input.replyJid },
      'Quota block delivery failed; cursor not advanced',
    );
    return { blocked: true, delivered: false, channelUserId };
  }
}

const TELEGRAM_ACCESS_CONTROL_FILE = path.join(
  DATA_DIR,
  'telegram-access-control.json',
);

interface TelegramAgentHoldEntry {
  status?: 'paused' | 'banned';
  reason?: string;
  deferAgentUntil?: string;
  deferredReason?: string;
}

function readTelegramAccessControlState(): Record<
  string,
  TelegramAgentHoldEntry
> {
  try {
    return JSON.parse(
      fs.readFileSync(TELEGRAM_ACCESS_CONTROL_FILE, 'utf-8'),
    ) as Record<string, TelegramAgentHoldEntry>;
  } catch {
    return {};
  }
}

function telegramAgentHold(chatJid: string): {
  kind: 'paused' | 'banned' | 'deferred';
  until?: string;
  reason?: string;
} | null {
  if (!chatJid.startsWith('tg:')) return null;
  const entry = readTelegramAccessControlState()[chatJid];
  if (!entry) return null;
  if (entry.status === 'paused' || entry.status === 'banned') {
    return { kind: entry.status, reason: entry.reason };
  }
  if (!entry.deferAgentUntil) return null;
  const untilMs = new Date(entry.deferAgentUntil).getTime();
  if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return null;
  return {
    kind: 'deferred',
    until: entry.deferAgentUntil,
    reason: entry.deferredReason,
  };
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // For thread/ticket groups, copy CLAUDE.md from the parent group
  const parentFolder = group.folder
    .replace(/_thread_.*$/, '')
    .replace(/_trigger$/, '');
  if (parentFolder !== group.folder) {
    const parentClaudeMd = path.join(GROUPS_DIR, parentFolder, 'CLAUDE.md');
    const targetClaudeMd = path.join(groupDir, 'CLAUDE.md');
    if (fs.existsSync(parentClaudeMd) && !fs.existsSync(targetClaudeMd)) {
      fs.copyFileSync(parentClaudeMd, targetClaudeMd);
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function advanceCursorAfterDeliveredIpc(chatJid: string): void {
  const target = activeRunTargetTimestamp[chatJid] || '';
  const piped = lastPipedTimestamp[chatJid] || '';
  if (!target && !piped) return;

  const currentCursor = lastAgentTimestamp[chatJid] || '';
  const newCursor = cursorAfterConfirmedSend(currentCursor, target, piped);
  if (newCursor === currentCursor) return;

  lastAgentTimestamp[chatJid] = newCursor;
  saveState();
  delete lastPipedTimestamp[chatJid];
  logger.info(
    { chatJid, cursor: newCursor },
    'Cursor advanced after confirmed IPC delivery',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('../runtimes/container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(
  chatJid: string,
  router: MessageRouter,
): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const hold = telegramAgentHold(chatJid);
  if (hold) {
    logger.info(
      { group: group.name, chatJid, hold },
      'Telegram agent processing held',
    );
    return true;
  }

  let prompt = formatMessages(missedMessages, TIMEZONE, {
    anonymizeSenderNames: !isMainGroup,
  });
  const currentTurnPrompt = prompt;
  const recentMessages = getRecentConversationMessages(
    chatJid,
    missedMessages[0].timestamp,
    50,
  );
  prompt = prependRecentConversationContext(prompt, recentMessages, TIMEZONE, {
    anonymizeSenderNames: !isMainGroup,
  });
  const promptSenderId = quotaUserIdForMessages(missedMessages);
  const promptTenant = currentTenantRegistry().resolveJid(chatJid);
  const memoryContext = !isMainGroup
    ? loadGroupMemoryContext(GROUPS_DIR, group.folder, {
        senderId: promptSenderId,
        tenantId: promptTenant?.tenant_id,
      })
    : '';
  if (memoryContext) {
    prompt = `${memoryContext}\n\n${prompt}`;
  }

  // Cursor advance deferred to confirmed send (см. ниже в onOutput callback).
  // Раньше advance происходил ДО агентского run'a — если агент висел в idle
  // wait после первого ответа и не подбирал follow-up через IPC pipe, cursor
  // оказывался впереди реально доставленных сообщений и rollback пропускался
  // (`outputSentToUser` остаётся true с первого ответа, не сбрасывается per
  // batch). Теперь advance строго после confirmed `Telegram message sent`.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  const targetCursor = missedMessages[missedMessages.length - 1].timestamp;

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(replyJid);
    }, IDLE_TIMEOUT);
  };

  // For trigger-required channels, reply in a thread (using the trigger message ts).
  // This creates a conversation thread that we register with requiresTrigger: false
  // so follow-up replies don't need the trigger word.
  const triggerMsg = missedMessages.find((m) =>
    TRIGGER_PATTERN.test(m.content.trim()),
  );
  const isChannelJid = !chatJid.includes(':', chatJid.indexOf(':') + 1);
  let replyJid = chatJid;
  let agentGroup = group;
  if (isChannelJid && triggerMsg && group.requiresTrigger !== false) {
    const threadJid = `${chatJid}:${triggerMsg.id}`;
    const threadFolder = `${group.folder}_thread_${triggerMsg.id.replace('.', '_')}`;
    // Register the thread so follow-up replies route here without trigger
    if (!registeredGroups[threadJid]) {
      registerGroup(threadJid, {
        name: `${group.name} (thread)`,
        folder: threadFolder,
        trigger: group.trigger,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        containerConfig: group.containerConfig,
      });
    }
    replyJid = threadJid;
    // Use the thread group for the agent so it gets its own container
    agentGroup = registeredGroups[threadJid] || group;
  }

  const inboundOnly = agentGroup.agentConfig?.inboundOnly === true;
  const autoRoute = shouldAutoRouteAgentOutput(agentGroup.agentConfig);
  const quotaPreflight = await maybeBlockTelegramQuota({
    chatJid,
    replyJid,
    group: agentGroup,
    messages: missedMessages,
    targetCursor,
    router,
  });
  if (quotaPreflight.blocked) return quotaPreflight.delivered;
  const quotaChannelUserId =
    quotaPreflight.channelUserId || quotaUserIdForMessages(missedMessages);
  const tenantForRun = promptTenant;
  const senderIdentity = senderIdentityForMessages(missedMessages);
  const liveSelectionReason = liveModeSelectionReason(tenantForRun);
  let providerFallbackAttempt: ProviderAttempt | undefined;
  const codexImagePaths =
    tenantForRun && liveSelectionReason && shouldStartLiveMode(tenantForRun)
      ? resolveCurrentTurnImageAttachments({
          currentPrompt: currentTurnPrompt,
          fullPrompt: prompt,
          groupFolder: group.folder,
        })
      : [];
  const mediaVisionNeedsLegacy = promptRequiresLegacyMediaVision(
    prompt,
    codexImagePaths.length > 0,
  );
  const liveModeSelected = Boolean(
    tenantForRun && liveSelectionReason && shouldStartLiveMode(tenantForRun),
  );

  if (tenantForRun && liveModeSelected) {
    const circuitDecision = getProviderCircuitDecisionSafely({
      provider: DEFAULT_PROVIDER_FAILOVER_POLICY.primary,
    });
    if (circuitDecision.transition === 'half_open') {
      recordEventSafely({
        chatJid,
        type: 'provider_circuit_half_open',
        actor: 'system',
        senderId: quotaChannelUserId,
        payload: {
          provider: circuitDecision.provider,
          previous_state: circuitDecision.previousState,
          state: circuitDecision.state,
          action: circuitDecision.action,
        },
      });
    }
    if (circuitDecision.transition === 'open') {
      recordEventSafely({
        chatJid,
        type: 'provider_circuit_opened',
        actor: 'system',
        senderId: quotaChannelUserId,
        payload: {
          provider: circuitDecision.provider,
          previous_state: circuitDecision.previousState,
          state: circuitDecision.state,
          reason: 'half_open_probe_timeout',
          open_until: circuitDecision.openUntil,
        },
      });
    }
    if (circuitDecision.action === 'skip') {
      providerFallbackAttempt = {
        provider: DEFAULT_PROVIDER_FAILOVER_POLICY.primary,
        status: 'skipped',
        reason: 'circuit_open',
      };
      recordEventSafely({
        chatJid,
        type: 'provider_failover_attempt',
        actor: 'system',
        senderId: quotaChannelUserId,
        payload: {
          ...providerFallbackAttempt,
          fallback_provider: DEFAULT_PROVIDER_FAILOVER_POLICY.fallback,
          fallback_allowed: true,
          fallback_will_start: true,
          circuit_state: circuitDecision.state,
          open_until: circuitDecision.openUntil,
          detail:
            'Codex provider circuit is open; using Claude SDK fallback without attempting Codex.',
        },
      });
    }
  }

  if (
    tenantForRun &&
    liveModeSelected &&
    mediaVisionNeedsLegacy &&
    !providerFallbackAttempt
  ) {
    providerFallbackAttempt = {
      provider: DEFAULT_PROVIDER_FAILOVER_POLICY.primary,
      status: 'skipped',
      reason: 'unavailable',
    };
    recordEventSafely({
      chatJid,
      type: 'provider_failover_attempt',
      actor: 'system',
      senderId: quotaChannelUserId,
      payload: {
        ...providerFallbackAttempt,
        fallback_provider: DEFAULT_PROVIDER_FAILOVER_POLICY.fallback,
        fallback_allowed: true,
        fallback_will_start: true,
        media_requires_file_vision: true,
        codex_image_attachments: codexImagePaths.length,
        detail:
          'Codex subscription live runtime did not receive safe image attachments for relative received media; using Claude SDK fallback for this media turn.',
      },
    });
  }

  if (tenantForRun && liveModeSelected && !providerFallbackAttempt) {
    if (!inboundOnly) {
      await channel.setTyping?.(replyJid, true);
    }
    activeRunTargetTimestamp[chatJid] = targetCursor;
    recordEventSafely({
      chatJid,
      type: 'runtime_selected',
      actor: 'system',
      senderId: quotaChannelUserId,
      payload: {
        group_folder: agentGroup.folder,
        reply_jid: replyJid,
        runtime: 'skoobi_live',
        live_selection_reason: liveSelectionReason,
        legacy_runtime_available: true,
        rollback_runtime: 'claude_sdk',
        provider_failover_policy: DEFAULT_PROVIDER_FAILOVER_POLICY,
        timestamp: new Date().toISOString(),
      },
    });
    logger.info(
      {
        chatJid,
        tenantId: tenantForRun.tenant_id,
        groupFolder: agentGroup.folder,
        replyJid,
        runtime: 'skoobi_live',
        liveSelectionReason,
      },
      'runtime_selected',
    );

    let liveRun: Awaited<ReturnType<typeof runLiveModelTurn>> | undefined;
    let liveThrownError: unknown;
    try {
      liveRun = await runLiveModelTurn({
        tenant: tenantForRun,
        prompt,
        senderId: quotaChannelUserId,
        senderIdentity,
        modelRole: 'default',
        imagePaths: codexImagePaths,
      });
    } catch (err) {
      recordEventSafely({
        chatJid,
        type: 'error',
        actor: 'system',
        senderId: quotaChannelUserId,
        payload: {
          kind: 'skoobi_live_run_failed',
          group_folder: agentGroup.folder,
          reply_jid: replyJid,
          ...errorPayload(err),
        },
      });
      logger.warn({ err, chatJid }, 'Skoobi live run failed');
      liveThrownError = err;
    } finally {
      delete activeRunTargetTimestamp[chatJid];
      if (!inboundOnly) {
        channel.setTyping?.(replyJid, false).catch(() => {
          /* swallowed: cleanup must not mask the live run result */
        });
      }
    }

    if (liveThrownError) {
      const reason = classifyProviderFailure(liveThrownError);
      const circuitFailure = recordProviderCircuitFailureSafely({
        provider: DEFAULT_PROVIDER_FAILOVER_POLICY.primary,
        reason,
      });
      if (circuitFailure?.opened) {
        recordEventSafely({
          chatJid,
          type: 'provider_circuit_opened',
          actor: 'system',
          senderId: quotaChannelUserId,
          payload: {
            provider: circuitFailure.provider,
            previous_state: circuitFailure.previousState,
            state: circuitFailure.state,
            reason: circuitFailure.reason,
            failure_count: circuitFailure.failureCount,
            failures_to_open: circuitFailure.failuresToOpen,
            open_until: circuitFailure.openUntil,
          },
        });
      }
      providerFallbackAttempt = failedProviderAttempt({ reason });
      recordEventSafely({
        chatJid,
        type: 'provider_failover_attempt',
        actor: 'system',
        senderId: quotaChannelUserId,
        payload: {
          ...providerFallbackAttempt,
          fallback_provider: DEFAULT_PROVIDER_FAILOVER_POLICY.fallback,
          fallback_allowed: shouldFallbackToProvider(reason),
          fallback_will_start: shouldFallbackToProvider(reason),
          error: errorPayload(liveThrownError),
        },
      });
      if (shouldFallbackToProvider(reason)) {
        recordEventSafely({
          chatJid,
          type: 'session_finished',
          actor: 'system',
          senderId: quotaChannelUserId,
          payload: {
            group_folder: agentGroup.folder,
            reply_jid: replyJid,
            runtime: 'skoobi_live',
            status: 'error',
            fallback_to: DEFAULT_PROVIDER_FAILOVER_POLICY.fallback,
            timestamp: new Date().toISOString(),
          },
        });
      } else {
        return false;
      }
    }

    if (!liveRun && !providerFallbackAttempt) return false;

    if (liveRun?.status === 'error') {
      const reason = classifyProviderFailure(liveRun.error);
      const circuitFailure = recordProviderCircuitFailureSafely({
        provider: DEFAULT_PROVIDER_FAILOVER_POLICY.primary,
        reason,
      });
      if (circuitFailure?.opened) {
        recordEventSafely({
          chatJid,
          type: 'provider_circuit_opened',
          actor: 'system',
          senderId: quotaChannelUserId,
          payload: {
            provider: circuitFailure.provider,
            previous_state: circuitFailure.previousState,
            state: circuitFailure.state,
            reason: circuitFailure.reason,
            failure_count: circuitFailure.failureCount,
            failures_to_open: circuitFailure.failuresToOpen,
            open_until: circuitFailure.openUntil,
            trace_id: liveRun.traceId,
          },
        });
      }
      providerFallbackAttempt = failedProviderAttempt({
        reason,
        latencyMs: liveRun.latencyMs,
        traceId: liveRun.traceId,
      });
      recordEventSafely({
        chatJid,
        type: 'session_finished',
        actor: 'system',
        senderId: quotaChannelUserId,
        payload: {
          group_folder: agentGroup.folder,
          reply_jid: replyJid,
          runtime: 'skoobi_live',
          status: 'error',
          duration_ms: liveRun.latencyMs,
          fallback_to: shouldFallbackToProvider(reason)
            ? DEFAULT_PROVIDER_FAILOVER_POLICY.fallback
            : undefined,
          timestamp: new Date().toISOString(),
        },
      });
      recordEventSafely({
        chatJid,
        type: 'error',
        actor: 'system',
        senderId: quotaChannelUserId,
        payload: {
          kind: 'skoobi_live_model_failed',
          group_folder: agentGroup.folder,
          reply_jid: replyJid,
          failover_reason: reason,
          ...errorPayload(liveRun.error),
        },
      });
      recordEventSafely({
        chatJid,
        type: 'provider_failover_attempt',
        actor: 'system',
        senderId: quotaChannelUserId,
        payload: {
          ...providerFallbackAttempt,
          fallback_provider: DEFAULT_PROVIDER_FAILOVER_POLICY.fallback,
          fallback_allowed: shouldFallbackToProvider(reason),
          fallback_will_start: shouldFallbackToProvider(reason),
        },
      });
      if (shouldFallbackToProvider(reason)) {
        // Continue into the legacy Claude SDK path below. No live answer has
        // been sent and no live usage charge has been written.
      } else {
        delete lastPipedTimestamp[chatJid];
        if (lastAgentTimestamp[chatJid] !== previousCursor) {
          lastAgentTimestamp[chatJid] = previousCursor;
          saveState();
        }
        return false;
      }
    }

    if (!autoRoute) {
      recordEventSafely({
        chatJid,
        type: 'error',
        actor: 'system',
        senderId: quotaChannelUserId,
        payload: {
          kind: 'skoobi_live_autoroute_disabled',
          group_folder: agentGroup.folder,
          reply_jid: replyJid,
        },
      });
      return false;
    }

    if (liveRun?.status === 'success') {
      const circuitSuccess = recordProviderCircuitSuccessSafely({
        provider: DEFAULT_PROVIDER_FAILOVER_POLICY.primary,
      });
      if (circuitSuccess?.closed) {
        recordEventSafely({
          chatJid,
          type: 'provider_circuit_closed',
          actor: 'system',
          senderId: quotaChannelUserId,
          payload: {
            provider: circuitSuccess.provider,
            previous_state: circuitSuccess.previousState,
            state: circuitSuccess.state,
            trace_id: liveRun.traceId,
          },
        });
      }
      try {
        const deliveredText = await router.route({
          chatJid: replyJid,
          text: liveRun.answerText,
          triggerType: 'agent-response',
          groupFolder: group.folder,
          meta: {
            kind: 'skoobi_live',
            trace_id: liveRun.traceId,
          },
        });
        if (!deliveredText) {
          throw new Error('Skoobi live answer was not delivered');
        }
        storeBotReply(replyJid, deliveredText);

        const currentCursor = lastAgentTimestamp[chatJid] || '';
        const piped = lastPipedTimestamp[chatJid] || '';
        const newCursor = cursorAfterConfirmedSend(
          currentCursor,
          targetCursor,
          piped,
        );
        if (lastAgentTimestamp[chatJid] !== newCursor) {
          lastAgentTimestamp[chatJid] = newCursor;
          saveState();
        }
        delete lastPipedTimestamp[chatJid];

        try {
          const charge = chargeLiveUsage({
            tenant: tenantForRun,
            run: liveRun,
            senderId: quotaChannelUserId,
            targetCursor,
          });
          if (charge?.duplicate) {
            logger.info(
              {
                chatJid,
                tenantId: tenantForRun.tenant_id,
                channelUserId: quotaChannelUserId,
              },
              'Skoobi live quota charge was already recorded',
            );
          }
        } catch (err) {
          recordEventSafely({
            chatJid,
            type: 'error',
            actor: 'system',
            senderId: quotaChannelUserId,
            payload: {
              kind: 'skoobi_live_quota_charge_failed',
              group_folder: agentGroup.folder,
              ...errorPayload(err),
            },
          });
          logger.warn({ err, chatJid }, 'Skoobi live quota charge failed');
        }

        try {
          recordTenantEvent({
            tenant: tenantForRun,
            type: 'model_gateway_live_response',
            actor: 'system',
            senderId: quotaChannelUserId,
            sessionId: liveRun.sessionId,
            payload: {
              trace_id: liveRun.traceId,
              status: 'delivered',
              live_answer_sent_to_user: true,
              delivered_text_length: deliveredText.length,
            },
          });
        } catch (err) {
          logger.warn(
            { err, chatJid },
            'Skoobi live delivery event append failed',
          );
        }

        recordEventSafely({
          chatJid,
          type: 'session_finished',
          actor: 'system',
          senderId: quotaChannelUserId,
          payload: {
            group_folder: agentGroup.folder,
            reply_jid: replyJid,
            runtime: 'skoobi_live',
            status: 'success',
            duration_ms: liveRun.latencyMs,
            turns: 1,
            timestamp: new Date().toISOString(),
          },
        });

        return true;
      } catch (err) {
        recordEventSafely({
          chatJid,
          type: 'error',
          actor: 'system',
          senderId: quotaChannelUserId,
          payload: {
            kind: 'skoobi_live_delivery_failed',
            reply_jid: replyJid,
            group_folder: group.folder,
            ...errorPayload(err),
          },
        });
        logger.warn(
          { err, jid: replyJid, groupFolder: group.folder },
          'Skoobi live delivery failed; cursor not advanced',
        );
        return false;
      }
    }
  }

  const shadowRun = shouldStartShadowMode(tenantForRun)
    ? startShadowModelRun({
        tenant: tenantForRun,
        prompt,
        senderId: quotaChannelUserId,
        modelRole: 'default',
      })
    : undefined;

  if (!inboundOnly) {
    await channel.setTyping?.(replyJid, true);
  }
  let hadError = false;
  let outputSentToUser = false;
  const legacyAnswerParts: string[] = [];
  const selectedRuntime = agentGroup.runtime || DEFAULT_RUNTIME;
  recordEventSafely({
    chatJid,
    type: 'runtime_selected',
    actor: 'system',
    payload: {
      group_folder: agentGroup.folder,
      reply_jid: replyJid,
      runtime: selectedRuntime,
      default_runtime: DEFAULT_RUNTIME,
      skoobi_runtime: providerFallbackAttempt
        ? 'claude_sdk'
        : tenantForRun?.runtime,
      provider_failover_from: providerFallbackAttempt?.provider,
      provider_failover_reason: providerFallbackAttempt?.reason,
      timestamp: new Date().toISOString(),
    },
  });

  let agentResult!: Awaited<ReturnType<typeof runAgent>>;
  activeRunTargetTimestamp[chatJid] = targetCursor;
  try {
    agentResult = await runAgent(
      agentGroup,
      prompt,
      replyJid,
      async (result) => {
        // Streaming output callback — called for each agent result
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);

          // Replace raw Anthropic-API 5xx envelopes with a friendly message
          // before they hit the user's chat. The native error stream still
          // sets result.status='error' below, so hadError tracking is intact.
          const friendly = rewriteTransientApiError(raw);
          const userText = friendly ?? raw;
          if (userText) legacyAnswerParts.push(userText);

          logger.info(
            {
              group: group.name,
              inboundOnly,
              autoRoute,
              apiErrorRewritten: friendly !== null,
              outputChars: userText.length,
            },
            'Agent output',
          );
          // Route through MessageRouter (handles formatOutbound + hooks + channel delivery).
          // For inbound-only groups (DEV pilots) we deliberately drop the agent's
          // user-visible reply: the agent has already POSTed to /api/agent_reports,
          // and the orchestrator must not send anything back over the source channel.
          // suppressAgentStdoutRouting blocks the same path independently — used
          // for supplier-facing groups (live whatsapp_business_pilot) that still
          // allow explicit outbound via the send-message MCP tool but must never
          // leak the agent's narrative.
          if (userText.trim() && autoRoute) {
            // Honest delivery: router.route() / channel.sendMessage() throw
            // on Telegram API failure (ECONNRESET, 429 retry exhausted, etc).
            // Без локального catch'а такие throw'и превращаются в
            // unhandled rejection и зависают group-queue до рестарта сервиса.
            // Здесь ловим, логируем, оставляем cursor НЕ продвинутым — следующий
            // recovery/loop попробует доставить заново.
            try {
              const deliveredText = await router.route({
                chatJid: replyJid,
                text: userText,
                triggerType: 'agent-response',
                groupFolder: group.folder,
              });
              if (deliveredText) {
                storeBotReply(replyJid, deliveredText);
              }
              outputSentToUser = true;
              // Advance cursor only after confirmed send. Учитываем piped
              // window: если pipe path тем временем накачал follow-up
              // messages в active runner, send для них тоже подтверждён
              // этим event'ом, поэтому продвигаем до max(current, target, piped).
              // current тоже обязателен: один и тот же long-lived runner может
              // выдать несколько results после того как piped window уже слит в
              // cursor; следующий result не должен откатить cursor назад к
              // initial targetCursor этого run'а.
              const piped = lastPipedTimestamp[chatJid] || '';
              const currentCursor = lastAgentTimestamp[chatJid] || '';
              const newCursor = cursorAfterConfirmedSend(
                currentCursor,
                targetCursor,
                piped,
              );
              if (lastAgentTimestamp[chatJid] !== newCursor) {
                lastAgentTimestamp[chatJid] = newCursor;
                saveState();
              }
              // piped window полностью вошёл в lastAgentTimestamp — clear
              // чтобы getMessagesSince снова использовал чистый cursor.
              delete lastPipedTimestamp[chatJid];
            } catch (err) {
              recordEventSafely({
                chatJid,
                type: 'error',
                actor: 'system',
                payload: {
                  kind: 'outbound_delivery_failed',
                  reply_jid: replyJid,
                  group_folder: group.folder,
                  ...errorPayload(err),
                },
              });
              logger.warn(
                { err, jid: replyJid, groupFolder: group.folder },
                'Outbound delivery failed; cursor not advanced, will retry on next run',
              );
            }
          }
          // Only reset idle timer on actual results, not session-update markers (result: null)
          resetIdleTimer();

          // Clear typing indicator now that THIS turn produced a reply. The
          // container may keep running to handle more piped messages; each new
          // piped message re-triggers setTyping(true) at the pipe site, and we
          // get back here when the agent emits its next result. Without this,
          // typing started for piped messages would never get cleared until the
          // whole container exited.
          if (!inboundOnly) {
            await channel.setTyping?.(replyJid, false);
          }
        }

        if (result.status === 'success') {
          // Notify the ORIGINAL chatJid (channel), not replyJid (thread).
          // The queue tracks active state by chatJid. Using replyJid here
          // would leave the channel group stuck as active forever when
          // a thread JID was created for the reply.
          queue.notifyIdle(chatJid);
        }

        if (result.status === 'error') {
          hadError = true;
        }
      },
    );
  } finally {
    delete activeRunTargetTimestamp[chatJid];
    // Defensive cleanup: always clear typing and idle timer, regardless of
    // whether runAgent finished normally, threw, or terminated through some
    // other path. Without this, an exception inside runAgent (e.g. a 5xx
    // Anthropic API error that propagates as a throw) would leave the
    // setTyping(true) at the top of this function dangling — typing would
    // tick until the in-channel 3-min safeguard auto-clears it.
    if (!inboundOnly) {
      // Best-effort, swallow errors so finally can't break the throw path.
      channel.setTyping?.(replyJid, false).catch(() => {
        /* swallowed: cleanup must not mask the real error */
      });
    }
    if (idleTimer) clearTimeout(idleTimer);
  }

  // Log cost tracking data
  logAgentRun({
    groupFolder: agentGroup.folder,
    chatJid: replyJid,
    triggerType: 'message',
    inputTokens: agentResult.usage?.inputTokens || 0,
    outputTokens: agentResult.usage?.outputTokens || 0,
    cacheCreationTokens: agentResult.usage?.cacheCreationInputTokens || 0,
    cacheReadTokens: agentResult.usage?.cacheReadInputTokens || 0,
    durationMs: agentResult.durationMs,
    turns: agentResult.turns || 0,
    model: agentGroup.agentConfig?.model,
    status: agentResult.status === 'error' || hadError ? 'error' : 'success',
  });
  const runStatus =
    agentResult.status === 'error' || hadError ? 'error' : 'success';
  recordEventSafely({
    chatJid,
    type: 'session_finished',
    actor: 'system',
    payload: {
      group_folder: agentGroup.folder,
      reply_jid: replyJid,
      status: runStatus,
      duration_ms: agentResult.durationMs,
      turns: agentResult.turns || 0,
      timestamp: new Date().toISOString(),
    },
  });
  if (
    providerFallbackAttempt &&
    runStatus === 'error' &&
    !outputSentToUser &&
    autoRoute
  ) {
    try {
      const deliveredText = await router.route({
        chatJid: replyJid,
        text: 'Сейчас не получилось получить ответ ни через основной Codex-провайдер, ни через резервный Claude. Попробуй ещё раз чуть позже.',
        triggerType: 'agent-response',
        groupFolder: group.folder,
        meta: {
          kind: 'provider_failover_exhausted',
          primary: DEFAULT_PROVIDER_FAILOVER_POLICY.primary,
          fallback: DEFAULT_PROVIDER_FAILOVER_POLICY.fallback,
        },
      });
      if (deliveredText) {
        storeBotReply(replyJid, deliveredText);
        outputSentToUser = true;
        const piped = lastPipedTimestamp[chatJid] || '';
        const currentCursor = lastAgentTimestamp[chatJid] || '';
        const newCursor = cursorAfterConfirmedSend(
          currentCursor,
          targetCursor,
          piped,
        );
        if (lastAgentTimestamp[chatJid] !== newCursor) {
          lastAgentTimestamp[chatJid] = newCursor;
          saveState();
        }
        delete lastPipedTimestamp[chatJid];
      }
    } catch (err) {
      recordEventSafely({
        chatJid,
        type: 'error',
        actor: 'system',
        senderId: quotaChannelUserId,
        payload: {
          kind: 'provider_failover_safe_error_delivery_failed',
          reply_jid: replyJid,
          group_folder: group.folder,
          ...errorPayload(err),
        },
      });
      logger.warn(
        { err, jid: replyJid, groupFolder: group.folder },
        'Provider failover exhausted safe error delivery failed',
      );
    }
  }
  if (providerFallbackAttempt) {
    recordEventSafely({
      chatJid,
      type:
        runStatus === 'success'
          ? 'provider_failover_used'
          : 'provider_failover_exhausted',
      actor: 'system',
      senderId: quotaChannelUserId,
      payload: {
        primary: DEFAULT_PROVIDER_FAILOVER_POLICY.primary,
        fallback: DEFAULT_PROVIDER_FAILOVER_POLICY.fallback,
        reason: providerFallbackAttempt.reason,
        attempts: [
          providerFallbackAttempt,
          {
            provider: DEFAULT_PROVIDER_FAILOVER_POLICY.fallback,
            status: runStatus === 'success' ? 'success' : 'failed',
            latency_ms: agentResult.durationMs,
          },
        ],
        fallback_answer_sent_to_user: outputSentToUser,
      },
    });
  }
  if (agentResult.usage) {
    if (tenantForRun) {
      try {
        recordUsageEvent({
          tenant: tenantForRun,
          channelUserId: quotaChannelUserId,
          modelRole: 'default',
          providerModel: agentGroup.agentConfig?.model,
          inputTokens: agentResult.usage.inputTokens || 0,
          outputTokens: agentResult.usage.outputTokens || 0,
        });
      } catch (err) {
        logger.warn({ err, chatJid }, 'Usage event append failed');
      }
      if (quotaChannelUserId) {
        try {
          const sessionId = eventSessionIdForTenant(tenantForRun);
          const chargeIdempotencyKey = quotaIdempotencyKey({
            tenantId: tenantForRun.tenant_id,
            sessionId,
            channel: tenantForRun.channel,
            chatId: tenantForRun.chat_id,
            channelUserId: quotaChannelUserId,
            targetCursor,
          });
          const charge = chargeQuotaUsage({
            tenantId: tenantForRun.tenant_id,
            sessionId,
            channel: tenantForRun.channel,
            chatId: tenantForRun.chat_id,
            channelUserId: quotaChannelUserId,
            modelRole: 'default',
            providerModel: agentGroup.agentConfig?.model,
            inputTokens: agentResult.usage.inputTokens || 0,
            outputTokens: agentResult.usage.outputTokens || 0,
            providerCostUsd: null,
            idempotencyKey: chargeIdempotencyKey,
            runStatus,
            isShadow: tenantForRun.runtime === 'skoobi_shadow',
          });
          if (charge.charged) {
            recordEventSafely({
              chatJid,
              type: 'quota_charged',
              actor: `telegram_user:${quotaChannelUserId}`,
              senderId: quotaChannelUserId,
              payload: {
                channel_user_id: quotaChannelUserId,
                usage_ledger_id: charge.usageLedgerId,
                credits_spent: charge.creditsSpent,
                pricing_version: charge.pricingVersion,
                coefficient_version: charge.coefficientVersion,
                idempotency_key: chargeIdempotencyKey,
              },
            });
          } else if (charge.skippedReason === 'failed_model') {
            recordEventSafely({
              chatJid,
              type: 'quota_charge_skipped_failed_model',
              actor: `telegram_user:${quotaChannelUserId}`,
              senderId: quotaChannelUserId,
              payload: {
                channel_user_id: quotaChannelUserId,
                reason: charge.skippedReason,
                status: runStatus,
              },
            });
          } else if (charge.skippedReason === 'shadow') {
            recordEventSafely({
              chatJid,
              type: 'quota_charge_skipped_shadow',
              actor: `telegram_user:${quotaChannelUserId}`,
              senderId: quotaChannelUserId,
              payload: {
                channel_user_id: quotaChannelUserId,
                reason: charge.skippedReason,
                runtime: tenantForRun.runtime,
              },
            });
          }
        } catch (err) {
          recordEventSafely({
            chatJid,
            type: 'error',
            actor: 'system',
            payload: {
              kind: 'quota_charge_failed',
              group_folder: agentGroup.folder,
              ...errorPayload(err),
            },
          });
          logger.warn({ err, chatJid }, 'Quota charge append failed');
        }
      }
    }
  }
  if (shadowRun && tenantForRun) {
    try {
      await finishShadowModelRun({
        tenant: tenantForRun,
        run: shadowRun,
        senderId: quotaChannelUserId,
        legacyAnswerText: legacyAnswerParts.join('\n\n'),
      });
    } catch (err) {
      recordEventSafely({
        chatJid,
        type: 'error',
        actor: 'system',
        payload: {
          kind: 'shadow_trace_failed',
          group_folder: agentGroup.folder,
          ...errorPayload(err),
        },
      });
      logger.warn({ err, chatJid }, 'Skoobi shadow trace failed');
    }
  }
  if (runStatus === 'error') {
    recordEventSafely({
      chatJid,
      type: 'error',
      actor: 'system',
      payload: {
        kind: 'agent_run_error',
        group_folder: agentGroup.folder,
        reply_jid: replyJid,
        status: runStatus,
        timestamp: new Date().toISOString(),
      },
    });
  }

  if (agentResult.status === 'error' || hadError) {
    if (outputSentToUser) {
      // Cursor уже advance'нут на send (см. onOutput callback). Дубликатов
      // не будет — следующая dispatch итерация увидит cursor и не
      // пере-обработает just-replied batch. Piped window уже clear'нут.
      logger.warn(
        { group: group.name },
        'Agent error after output was sent (cursor already advanced)',
      );
      return true;
    }
    // No send confirmed. Clear piped window так чтобы fresh dispatch
    // перепрочитал messages которые были piped но не дошли до send.
    delete lastPipedTimestamp[chatJid];
    if (lastAgentTimestamp[chatJid] !== previousCursor) {
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
    }
    logger.warn(
      { group: group.name },
      'Agent error before any send; cursor rolled back, piped window cleared',
    );
    return false;
  }

  const pipedCursor = lastPipedTimestamp[chatJid] || '';
  if (hasUnconfirmedPipedMessages(pipedCursor, lastAgentTimestamp[chatJid])) {
    delete lastPipedTimestamp[chatJid];
    logger.warn(
      { group: group.name },
      'Agent exited with unconfirmed piped messages; retrying fresh runner',
    );
    return false;
  }
  delete lastPipedTimestamp[chatJid];

  return true;
}

interface RunAgentResult {
  status: 'success' | 'error';
  usage?: ContainerOutput['usage'];
  durationMs: number;
  turns?: number;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<RunAgentResult> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];
  const startTime = Date.now();

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Track last usage data from streamed results
  let lastUsage: ContainerOutput['usage'] | undefined;
  let lastTurns: number | undefined;
  const loggedSessionUpdates = new Set<string>();

  const persistSession = (newSessionId: string) => {
    sessions[group.folder] = newSessionId;
    setSession(group.folder, newSessionId);
    if (!loggedSessionUpdates.has(newSessionId)) {
      loggedSessionUpdates.add(newSessionId);
      logger.info(
        {
          group: group.name,
          groupFolder: group.folder,
          resumeSessionId: sessionId,
          newSessionId,
          sessionChanged: Boolean(sessionId && sessionId !== newSessionId),
        },
        'Agent session updated',
      );
    }
  };

  // Wrap onOutput to track session ID and usage from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          persistSession(output.newSessionId);
        }
        if (output.usage) lastUsage = output.usage;
        if (output.turns !== undefined) lastTurns = output.turns;
        await onOutput(output);
      }
    : undefined;

  try {
    const runtime = group.runtime || DEFAULT_RUNTIME;
    const agentInput = {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain,
      assistantName: ASSISTANT_NAME,
      agentConfig: agentConfigWithTenantInstructions(group),
    };
    const onProcessCb = (proc: any, name: string) =>
      queue.registerProcess(chatJid, proc, name, group.folder);

    const output =
      runtime === 'sandbox'
        ? await runSandboxAgent(group, agentInput, onProcessCb, wrappedOnOutput)
        : await runContainerAgent(
            group,
            agentInput,
            onProcessCb,
            wrappedOnOutput,
          );

    const durationMs = Date.now() - startTime;

    if (output.newSessionId) {
      persistSession(output.newSessionId);
    }

    // Use usage from the output directly, or from the last streamed output
    const usage = output.usage || lastUsage;
    const turns = output.turns ?? lastTurns;

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        `${runtime === 'sandbox' ? 'Sandbox' : 'Container'} agent error`,
      );
      return { status: 'error', usage, durationMs, turns };
    }

    return { status: 'success', usage, durationMs, turns };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logger.error({ group: group.name, err }, 'Agent error');
    return { status: 'error', durationMs };
  }
}

async function startMessageLoop(router: MessageRouter): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`ClaudeClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      recoverReadyTelegramDeferredMessages();
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          const hold = telegramAgentHold(chatJid);
          if (hold) {
            logger.info(
              { chatJid, group: group.name, hold },
              'Telegram agent processing held',
            );
            continue;
          }

          // Pull all messages since лучшего из lastAgent / lastPiped — те что
          // уже скормлены runner'у через IPC pipe ждут send confirmation, не
          // нужно пере-pip'ать. После confirmed send в onOutput callback
          // lastAgentTimestamp сольёт piped в себя.
          const lastAgent = lastAgentTimestamp[chatJid] || '';
          const lastPiped = lastPipedTimestamp[chatJid] || '';
          const sinceCursor = lastPiped > lastAgent ? lastPiped : lastAgent;
          const allPending = getMessagesSince(
            chatJid,
            sinceCursor,
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE, {
            anonymizeSenderNames: !isMainGroup,
          });

          if (queue.canPipeMessage(chatJid)) {
            const quotaBlock = await maybeBlockTelegramQuota({
              chatJid,
              replyJid: chatJid,
              group,
              messages: messagesToSend,
              targetCursor: messagesToSend[messagesToSend.length - 1].timestamp,
              router,
            });
            if (quotaBlock.blocked) continue;
          }

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // НЕ advance lastAgentTimestamp — это сделает onOutput callback
            // на confirmed send. Pipe-window живёт в lastPipedTimestamp до
            // того момента; getMessagesSince выше использует max обоих чтобы
            // не пере-pip'ать те же messages. Если agent крашит до send —
            // error path в processGroupMessages clear'ит lastPipedTimestamp,
            // следующий dispatch перепрочитает piped batch.
            lastPipedTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function recoverReadyTelegramDeferredMessages(): void {
  const accessState = readTelegramAccessControlState();
  const now = Date.now();
  for (const [chatJid, entry] of Object.entries(accessState)) {
    if (
      !entry.deferAgentUntil ||
      entry.status === 'paused' ||
      entry.status === 'banned'
    ) {
      continue;
    }
    const untilMs = new Date(entry.deferAgentUntil).getTime();
    if (!Number.isFinite(untilMs) || untilMs > now) continue;
    const group = registeredGroups[chatJid];
    if (!group) continue;
    const pending = getMessagesSince(
      chatJid,
      lastAgentTimestamp[chatJid] || '',
      ASSISTANT_NAME,
    );
    if (pending.length === 0) continue;
    if (group.requiresTrigger !== false) {
      const allowlistCfg = loadSenderAllowlist();
      const hasTrigger = pending.some(
        (m) =>
          TRIGGER_PATTERN.test(m.content.trim()) &&
          (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
      );
      if (!hasTrigger) continue;
    }
    logger.info(
      {
        group: group.name,
        chatJid,
        pendingCount: pending.length,
        reason: entry.deferredReason,
      },
      'Recovery: deferred Telegram messages are ready',
    );
    queue.enqueueMessageCheck(chatJid);
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

export async function main(): Promise<void> {
  // Database must be initialized BEFORE querying registered groups
  initDatabase(getExtensionDbSchema());
  logger.info('Database initialized');

  // Runtime-dependent initialization
  const allGroups = Object.values(getAllRegisteredGroups());
  const needsContainers =
    DEFAULT_RUNTIME === 'container' ||
    allGroups.some((g) => (g.runtime || DEFAULT_RUNTIME) === 'container');
  const needsSandbox =
    DEFAULT_RUNTIME === 'sandbox' ||
    allGroups.some((g) => (g.runtime || DEFAULT_RUNTIME) === 'sandbox');

  if (needsContainers) {
    ensureContainerSystemRunning();
  }
  if (needsSandbox) {
    ensureSandboxRuntimeAvailable();
    cleanupSandboxOrphans();
  }

  loadState();
  restoreRemoteControl();

  // Start credential proxy only if container runtime is active
  // (sandbox mode passes credentials directly — no proxy needed)
  let proxyServer: Awaited<ReturnType<typeof startCredentialProxy>> | undefined;
  if (needsContainers) {
    proxyServer = await startCredentialProxy(
      CREDENTIAL_PROXY_PORT,
      PROXY_BIND_HOST,
    );
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer?.close();
    await queue.shutdown();
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await router.send(chatJid, result.url);
      } else {
        await router.send(chatJid, `Remote Control failed: ${result.error}`);
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await router.send(chatJid, 'Remote Control session ended.');
      } else {
        await router.send(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      const tenant = currentTenantRegistry().resolveJid(chatJid);
      const enrichedMsg: NewMessage = {
        ...msg,
        tenant_id: msg.tenant_id || tenant?.tenant_id,
        sender_identity:
          msg.sender_identity ||
          (tenant
            ? createTelegramSenderIdentity({
                chatId: tenant.chat_id,
                fromId: msg.sender,
                displayNameHint: msg.sender_name,
                ownerAllowlist: loadOwnerAllowlistFromEnv(),
              })
            : undefined),
      };
      recordTelegramInboundEvent(chatJid, enrichedMsg);
      // Remote control commands — intercept before storage
      const trimmed = enrichedMsg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, enrichedMsg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (
        !enrichedMsg.is_from_me &&
        !enrichedMsg.is_bot_message &&
        registeredGroups[chatJid]
      ) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, enrichedMsg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: enrichedMsg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(enrichedMsg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    registerGroup,
    tenantRegistry: currentTenantRegistry,
    ownerAllowlist: loadOwnerAllowlistFromEnv,
    onTelegramCallbackQuery: recordTelegramCallbackEvent,
  };

  // Create all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
  }
  if (channels.length === 0) {
    logger.fatal('No channels registered');
    process.exit(1);
  }

  // Connect all channels in parallel with a per-channel timeout.
  // Sequential connect would let any single slow channel (e.g. WhatsApp stuck
  // in AwaitingInitialSync, or any channel whose connect() Promise never
  // resolves) block every subsequent channel from starting. A channel that
  // times out here is left in `channels` so its own background reconnect
  // logic can recover; the orchestrator just stops blocking startup on it.
  const CHANNEL_CONNECT_TIMEOUT_MS = 30_000;
  const connectResults = await Promise.allSettled(
    channels.map(async (ch) => {
      const start = Date.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          ch.connect(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `Channel ${ch.name} did not connect within ${CHANNEL_CONNECT_TIMEOUT_MS}ms`,
                  ),
                ),
              CHANNEL_CONNECT_TIMEOUT_MS,
            );
          }),
        ]);
        logger.info(
          { channel: ch.name, ms: Date.now() - start },
          'Channel connected',
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
  // A channel that timed out here is still alive — its connect() Promise is
  // outstanding and will resolve later when the upstream is reachable, and
  // any internal reconnect loop continues to run. Don't fatal-exit just
  // because the initial connect window expired; the orchestrator can keep
  // running and the channel will start working when it comes online.
  // Fatal exit only happens earlier (channels.length === 0).
  connectResults.forEach((result, i) => {
    if (result.status === 'rejected') {
      logger.warn(
        { channel: channels[i].name, err: result.reason },
        'Channel did not connect on startup — relying on background reconnect',
      );
    }
  });

  // Create routing services (must be before subsystem startup)
  const router = createMessageRouter(channels);
  router.addPostHook((envelope) => {
    if (envelope.triggerType === 'ipc') {
      advanceCursorAfterDeliveredIpc(envelope.chatJid);
    }
    if (envelope.chatJid.startsWith('tg:')) {
      recordTelegramOutboundEvent(envelope);
    }
  });

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    router,
  });
  const ingestion = createMessageIngestion({
    checkTrigger: (chatJid, sender) => {
      const group = registeredGroups[chatJid];
      if (!group) return { needsTrigger: true, hasTrigger: false };
      const isMainGroup = group.isMain === true;
      const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
      if (!needsTrigger) return { needsTrigger: false, hasTrigger: true };
      // For ingestion callers (webhook, extension), trigger check uses sender allowlist.
      // Channel messages bypass ingestion entirely (handled by the polling loop with
      // full trigger pattern matching on message content).
      const allowlistCfg = loadSenderAllowlist();
      const hasTrigger = isTriggerAllowed(chatJid, sender, allowlistCfg);
      return { needsTrigger, hasTrigger };
    },
    enqueueMessageCheck: (chatJid) => queue.enqueueMessageCheck(chatJid),
  });

  // Wire extension hooks into services
  wireExtensionHooks(ingestion, router);

  // Start all plugins (triage, etc.)
  callExtensionStartup({
    ingestion,
    router,
    logger,
    // Backward compat (deprecated):
    sendMessage: async (jid, text) => router.send(jid, text),
    findChannel: (jid) => findChannel(channels, jid),
  });

  startIpcWatcher({
    router,
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  // Start webhook server if configured
  if (WEBHOOK_SECRET) {
    startWebhookServer(WEBHOOK_PORT, WEBHOOK_SECRET, {
      ingestion,
      findGroupByFolder: (folder) => {
        for (const [jid, group] of Object.entries(registeredGroups)) {
          if (group.folder === folder) return { jid, name: group.name };
        }
        return undefined;
      },
      // Send a message to a registered group's chat without spawning an
      // agent (owner-approved canned reply path via webhook).
      sendDirect: async (folder, text) => {
        for (const [jid, group] of Object.entries(registeredGroups)) {
          if (group.folder === folder) {
            await router.send(jid, text);
            return;
          }
        }
        throw new Error(`Group not found: ${folder}`);
      },
    });
  }

  queue.setProcessMessagesFn((chatJid) =>
    processGroupMessages(chatJid, router),
  );
  recoverPendingMessages();
  startMessageLoop(router).catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}
