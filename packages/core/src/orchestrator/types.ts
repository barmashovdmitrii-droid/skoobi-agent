// Message-plane типы канал↔ядро (Channel, NewMessage, SenderIdentity,
// колбэки) переехали в @skoobi/shared/channel-types (волна 7a) — ре-экспорт
// сохраняет все существующие импорты из types.js.
export type {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  OnTelegramCallbackQuery,
  SenderIdentity,
  TelegramCallbackQueryEvent,
} from '@skoobi/shared/channel-types';

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
  personaId?: string; // Optional Skoobi persona id for future multi-bot/persona deployments.
  lazyMemory?: boolean; // When true, prompt memory uses a compact file index and relies on memory_get/memory_search for details.
  curatedMemory?: boolean; // When false, suppress bounded curated MEMORY.md/USER.md summary blocks in lazy memory mode.
  skillsEnabled?: boolean; // When false, suppress Hermes-style procedural skill selection for this group.
  codexFullAgentPrimary?: boolean; // Force owner live turns through the full Codex agent runner instead of the thin live adapter.
  whatsappObserverAccess?: boolean; // Owner self-chat only: allow bounded, explicit-request context from the passive WhatsApp observer store.
  instructionSourceFolder?: string; // Trusted host config: copy CLAUDE.md once from this exact group folder into a separate runtime workspace.
  memoryContextFolder?: string; // Trusted same-owner config: read bounded prompt memory from this exact group folder while keeping sessions separate.
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
  // 'cancelled' exists in the prod table (older cancel flows set it instead
  // of deleting) and is one of the two states bulk cleanup_tasks may delete.
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  created_at: string;
  /** Host-verified creator authority; missing/null legacy rows fail closed. */
  creator_authorization?: 'owner_sender' | null;
  /** Stable host-derived identity of the creator, never copied from guest IPC. */
  creator_identity_id?: string | null;
  /** Stable channel sender id of the creator, never copied from guest IPC. */
  creator_sender_id?: string | null;
}

export interface CalendarEventLink {
  task_id: string;
  provider: 'google_calendar';
  calendar_id: string;
  event_id: string;
  event_link: string | null;
  status: 'active' | 'deleted';
  created_at: string;
  updated_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
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
  /**
   * Send a photo by absolute file path. Returns true if delivered, false if no
   * channel supports it or the channel rejected the send.
   *
   * Host-owned background delivery (for example a persisted image job retry)
   * must set suppressCursorAdvance: it is not a reply produced by the currently
   * active chat run and therefore must not acknowledge that run's messages.
   */
  sendPhoto(
    jid: string,
    filePath: string,
    caption?: string,
    options?: {
      suppressCursorAdvance?: boolean;
      meta?: Record<string, unknown>;
    },
  ): Promise<boolean>;
  /** Send a document by absolute file path. Returns true if delivered, false if no channel supports it. */
  sendDocument(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<boolean>;
  /** Synthesize text → voice and send. Returns true if delivered, false if no channel supports it. */
  sendVoice(jid: string, text: string): Promise<boolean>;
}
