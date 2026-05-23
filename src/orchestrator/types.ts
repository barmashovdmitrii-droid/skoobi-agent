export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/claudeclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // Dedicated-host escape hatch: when true, do not merge built-in blocked patterns.
  // Use only when the bot is intentionally allowed to read/write the whole account.
  disableDefaultBlockedPatterns?: boolean;
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface AgentConfig {
  model?: string; // 'sonnet' | 'opus' | 'haiku' | full model ID
  effort?: 'low' | 'medium' | 'high' | 'max'; // Model reasoning effort (v2.1.78+)
  systemPrompt?: string; // Appended to agent's system context
  allowedTools?: string[]; // Tool allowlist override (empty = use defaults)
  disallowedTools?: string[]; // Tool blacklist (v2.1.78+ — applied on top of allowlist)
  maxTurns?: number; // Max conversation turns
  costLimitUsd?: number; // Per-run budget cap
  allowedDomains?: string[]; // Extra network domains the sandbox agent can access (merged with base Anthropic + localhost)
  noSandbox?: boolean; // Bypass sandbox entirely — agent runs on bare node with full host access (dedicated-host mode)
  fullAccess?: boolean; // Dedicated-host mode: all tools, all MCP servers, all mounted folders, no sandbox restrictions
  mediaIngestion?: boolean; // When true, the channel layer downloads (and for audio, transcribes) inbound voice/image/document and surfaces a placeholder + path in the agent's content. When false/undefined, media without a text caption is dropped (legacy pre-3.5M behaviour).
  inboundOnly?: boolean; // When true, the orchestrator suppresses typing indicator AND auto-routing of the agent's STDOUT result back to the source channel. Used for inbound-only pilot groups that report status via /api/agent_reports rather than chat replies.
  suppressAgentStdoutRouting?: boolean; // When true, the orchestrator will NOT auto-route the agent's STDOUT result back to the source channel, even if inboundOnly is false. The agent can still send explicit replies through the send-message MCP tool. Use this for supplier-facing groups that need a controlled outbound channel without leaking internal narrative or IDs.
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  runtime?: 'container' | 'sandbox'; // Per-group runtime override (falls back to DEFAULT_RUNTIME)
  agentConfig?: AgentConfig;
}

export type SkoobiRuntimeMode = 'claude_sdk' | 'skoobi_shadow' | 'skoobi_live';

export interface SenderIdentity {
  channel: 'telegram' | 'whatsapp';
  chat_id: string;
  /** Telegram numeric user id. Set when channel === 'telegram'. */
  telegram_user_id: string;
  /** WhatsApp phone digits (E.164 without +). Set when channel === 'whatsapp'. */
  whatsapp_phone?: string;
  username_hint?: string;
  display_name_hint?: string;
  is_owner_sender: boolean;
}

/**
 * Returns the per-user identifier for a sender, regardless of channel.
 * Falls back through telegram_user_id → whatsapp_phone → chat_id so existing
 * single-user-per-chat semantics keep working.
 */
export function senderIdentityUserId(identity: SenderIdentity): string {
  return (
    identity.telegram_user_id ||
    identity.whatsapp_phone ||
    identity.chat_id ||
    ''
  );
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  tenant_id?: string;
  sender_identity?: SenderIdentity;
  telegram_update_id?: string;
}

export interface TelegramCallbackQueryEvent {
  id: string;
  chat_jid: string;
  chat_id: string;
  from_id: string;
  timestamp: string;
  kind: string;
  data?: string;
  message_id?: string;
  username_hint?: string;
  display_name_hint?: string;
}

export type OnTelegramCallbackQuery = (
  event: TelegramCallbackQueryEvent,
) => void;

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: send a photo/image by absolute file path. Channels that don't support media can omit.
  sendPhoto?(jid: string, filePath: string, caption?: string): Promise<void>;
  // Optional: send an arbitrary document/file by absolute file path.
  sendDocument?(jid: string, filePath: string, caption?: string): Promise<void>;
  // Optional: synthesize text → voice and send. Channels that don't support audio can omit.
  sendVoice?(jid: string, text: string): Promise<void>;
}

// --- Message routing ---

export interface IngestionEnvelope {
  groupFolder: string;
  chatJid: string;
  sender: string;
  senderName: string;
  triggerType: 'channel' | 'webhook' | 'cron' | 'ipc' | 'extension';
  prompt: string;
  bypassTrigger?: boolean; // webhooks, cron, main group skip trigger check
  meta?: Record<string, unknown>;
}

export interface OutboundEnvelope {
  chatJid: string;
  text: string;
  triggerType: 'agent-response' | 'ipc' | 'task-result' | 'extension';
  groupFolder?: string;
  meta?: Record<string, unknown>;
}

export type HookResult<T> =
  | { action: 'continue' }
  | { action: 'drop'; reason?: string }
  | { action: 'modify'; envelope: T };

export type IngestionPreHook = (
  envelope: IngestionEnvelope,
) => Promise<HookResult<IngestionEnvelope>>;

export type OutboundPreHook = (
  envelope: OutboundEnvelope,
) => Promise<HookResult<OutboundEnvelope>>;

export interface MessageIngestion {
  addPreHook(hook: IngestionPreHook): void;
  addPostHook(hook: (envelope: IngestionEnvelope) => void): void;
  ingest(envelope: IngestionEnvelope): Promise<boolean>;
}

export interface MessageRouter {
  addPreHook(hook: OutboundPreHook): void;
  addPostHook(hook: (envelope: OutboundEnvelope) => void): void;
  route(envelope: OutboundEnvelope): Promise<string | null>;
  /** Convenience: route with minimal envelope */
  send(jid: string, text: string): Promise<void>;
  /** Send a photo by absolute file path. Returns true if delivered, false if no channel supports it. */
  sendPhoto(jid: string, filePath: string, caption?: string): Promise<boolean>;
  /** Send a document by absolute file path. Returns true if delivered, false if no channel supports it. */
  sendDocument(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<boolean>;
  /** Synthesize text → voice and send. Returns true if delivered, false if no channel supports it. */
  sendVoice(jid: string, text: string): Promise<boolean>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
