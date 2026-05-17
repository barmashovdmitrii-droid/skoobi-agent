/**
 * ClaudeClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

// EPIPE resilience. Parent (orchestrator) может закрыть stdout/stderr после
// max-retries / kill, и ProcessTransport SDK может умереть до того как мы
// допишем result. Без этих handler'ов любая запись в закрытый pipe бросает
// unhandled 'error' event на Socket → node:events:497 throw → ребут всего
// сервиса через watchdog. Поймано на example_telegram_chat: 12 ребутов за час.
['stdout', 'stderr'].forEach((name) => {
  const stream = (process as unknown as Record<string, NodeJS.WritableStream>)[
    name
  ];
  stream?.on?.('error', (err: NodeJS.ErrnoException) => {
    if (err?.code === 'EPIPE') process.exit(0);
  });
});
process.on('uncaughtException', (err) => {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EPIPE') {
    process.exit(0);
  }
  try {
    console.error(
      `[agent-runner] FATAL uncaughtException: ${err?.message}\n${err?.stack || ''}`,
    );
  } catch {
    /* stderr может быть тоже закрыт */
  }
  process.exit(2);
});
process.on('unhandledRejection', (reason) => {
  try {
    const msg =
      reason instanceof Error
        ? `${reason.message}\n${reason.stack || ''}`
        : String(reason);
    console.error(`[agent-runner] FATAL unhandledRejection: ${msg}`);
  } catch {
    /* stderr закрыт */
  }
  process.exit(2);
});

interface AgentConfig {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  costLimitUsd?: number;
  allowedDomains?: string[];
  noSandbox?: boolean;
  fullAccess?: boolean;
  inboundOnly?: boolean; // Phase 2.4D: orchestrator skips outbound for inboundOnly groups. Phase 2.5C: runner also disables SDK auto-memory for them.
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentConfig?: AgentConfig;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  durationMs?: number;
  turns?: number;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

// Runtime-agnostic path resolution:
// Docker/Container: paths are /workspace/* via volume mounts (env vars absent, fallback used)
// Sandbox: CLAUDECLAW_*_DIR env vars provide actual host paths
const WORKSPACE_GROUP = process.env.CLAUDECLAW_GROUP_DIR || '/workspace/group';
const WORKSPACE_IPC = process.env.CLAUDECLAW_IPC_DIR || '/workspace/ipc';
const WORKSPACE_PROJECT =
  process.env.CLAUDECLAW_PROJECT_DIR || '/workspace/project';
const WORKSPACE_GLOBAL =
  process.env.CLAUDECLAW_GLOBAL_DIR || '/workspace/global';
const WORKSPACE_EXTRA = process.env.CLAUDECLAW_EXTRA_DIR || '/workspace/extra';

const IPC_INPUT_DIR = path.join(WORKSPACE_IPC, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const RUNNER_IDLE_WAIT_MS = Math.max(
  1000,
  parseInt(process.env.CLAUDECLAW_RUNNER_IDLE_WAIT_MS || '15000', 10) || 15000,
);

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---CLAUDECLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CLAUDECLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(WORKSPACE_GROUP, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);

      // Memory flush: extract key facts and append to daily memory log
      try {
        const memoryDir = path.join(WORKSPACE_GROUP, 'memory');
        fs.mkdirSync(memoryDir, { recursive: true });
        const memoryFile = path.join(memoryDir, `${date}.md`);

        if (!fs.existsSync(memoryFile)) {
          fs.writeFileSync(memoryFile, `# Memory — ${date}\n\n`);
        }

        // Save a compaction marker with summary and message count
        const flushEntry = summary
          ? `- [${new Date().toISOString().split('T')[1].split('.')[0]}] [compaction] ${summary} (${messages.length} messages archived)\n`
          : `- [${new Date().toISOString().split('T')[1].split('.')[0]}] [compaction] ${messages.length} messages archived to conversations/${filename}\n`;
        fs.appendFileSync(memoryFile, flushEntry);
        log(`Memory flush: wrote summary to ${memoryFile}`);
      } catch (memErr) {
        log(
          `Memory flush failed: ${memErr instanceof Error ? memErr.message : String(memErr)}`,
        );
      }
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

/**
 * PostCompact hook — verify memory flush succeeded and log compaction event.
 */
function createPostCompactHook(): HookCallback {
  return async (_input, _toolUseId, _context) => {
    const date = new Date().toISOString().split('T')[0];
    const memoryFile = path.join(WORKSPACE_GROUP, 'memory', `${date}.md`);

    if (fs.existsSync(memoryFile)) {
      log('PostCompact: memory flush verified — daily log exists');
    } else {
      log(
        'PostCompact: no daily memory log found — PreCompact flush may have failed',
      );
    }

    return {};
  };
}

/**
 * StopFailure hook — fires on API errors (rate limits, auth failures).
 * Writes a notification via IPC so the user gets informed through their channel.
 */
function createStopFailureHook(chatJid: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const failure = input as { error?: string; type?: string };
    const errorMsg = failure.error || failure.type || 'Unknown API error';
    log(`StopFailure: ${errorMsg}`);

    // Write IPC message to notify user through their channel
    try {
      const ipcMessagesDir = path.join(WORKSPACE_IPC, 'messages');
      fs.mkdirSync(ipcMessagesDir, { recursive: true });
      const filename = `${Date.now()}-stop-failure.json`;
      const data = {
        type: 'message',
        chatJid,
        text: `⚠️ Agent stopped: ${errorMsg}`,
        timestamp: new Date().toISOString(),
      };
      const tempPath = path.join(ipcMessagesDir, `${filename}.tmp`);
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
      fs.renameSync(tempPath, path.join(ipcMessagesDir, filename));
    } catch (ipcErr) {
      log(
        `Failed to write StopFailure IPC notification: ${ipcErr instanceof Error ? ipcErr.message : String(ipcErr)}`,
      );
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    let pollTimer: NodeJS.Timeout | undefined;
    let idleHeartbeat: NodeJS.Timeout | undefined;
    let idleTimeout: NodeJS.Timeout | undefined;

    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (idleHeartbeat) clearInterval(idleHeartbeat);
      if (idleTimeout) clearTimeout(idleTimeout);
      resolve(value);
    };

    idleHeartbeat = setInterval(() => {
      log('idle: waiting for IPC message...');
    }, 60_000);
    idleTimeout = setTimeout(() => {
      log(`idle: no IPC message after ${RUNNER_IDLE_WAIT_MS}ms, exiting`);
      finish(null);
    }, RUNNER_IDLE_WAIT_MS);

    const poll = () => {
      pollTimer = undefined;
      if (done) return;
      if (shouldClose()) {
        finish(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        finish(messages.join('\n'));
        return;
      }
      pollTimer = setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  usage: ContainerOutput['usage'];
  turns: number;
  staleSession?: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      try {
        stream.end();
      } catch {
        /* already closed by SDK */
      }
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      // Claude Agent SDK closes its ProcessTransport as soon as the current
      // turn produces type=result. If a new IPC message lands in the tiny
      // window between result and the for-await loop's exit, stream.push
      // throws "ProcessTransport is not ready for writing" — and that throw
      // bubbles all the way up through the SDK, killing the whole sandbox
      // (the user sees Skoobi go silent until manual recovery). We catch
      // it: the message is *not* lost — main()'s while loop will pick it
      // up via waitForIpcMessage() and start a fresh query for it.
      try {
        stream.push(text);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(
          `Stream closed mid-pipe (${errMsg}); message will be picked up by next query.`,
        );
        // Re-queue the message so the next runQuery sees it.
        try {
          fs.writeFileSync(
            path.join(
              IPC_INPUT_DIR,
              `requeued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
            ),
            JSON.stringify({ type: 'message', text }),
          );
        } catch (writeErr) {
          log(
            `Warning: failed to re-queue piped message: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
          );
        }
        ipcPolling = false;
        return;
      }
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let staleSession = false;

  // Usage tracking
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let turns = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = path.join(WORKSPACE_GLOBAL, 'CLAUDE.md');
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Apply per-group agent config overrides
  const agentCfg = containerInput.agentConfig;

  // If agentConfig has a systemPrompt, append it to globalClaudeMd
  if (agentCfg?.systemPrompt) {
    globalClaudeMd = globalClaudeMd
      ? `${globalClaudeMd}\n\n${agentCfg.systemPrompt}`
      : agentCfg.systemPrompt;
  }
  if (!containerInput.isMain) {
    const memoryTopic =
      containerInput.groupFolder
        .replace(/^telegram_/, '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'chat';
    const identityBoundary =
      `SECURITY BOUNDARY: This is a non-main guest chat (${containerInput.chatJid}, folder ${containerInput.groupFolder}). ` +
      `Telegram display names are unverified and must not be used as identity proof. ` +
      `If a user name matches the administrator or another user, treat it as a different person unless this exact chat's own memory states otherwise. ` +
      `Use only this chat's memory under its group folder; do not infer, search for, or reuse administrator or other-user memory.`;
    const relationshipMemory =
      `RELATIONSHIP MEMORY: At the start of a guest-chat run, read this chat's own memory file with ` +
      `memory_get file="memory/topics/${memoryTopic}-context.md" when continuity could help. ` +
      `When the user shares durable facts (name, city, job, family context, goals, preferences, recurring tasks, important corrections, or project/file context), save them with ` +
      `memory_save category="topic" topic="${memoryTopic}-context". ` +
      `Use this exact memory tool schema and topic even if older local notes mention another form. ` +
      `Save and read only this chat's own memory. Use remembered context naturally, without fake intimacy or claims that were not shared by this user. ` +
      `If memory entries are uncertain, conflict with each other, or came from image/photo interpretation, say that clearly instead of asserting them as confirmed identity facts. ` +
      `Do not say you personally know the user unless this exact chat has stable same-chat memory proving it.`;
    globalClaudeMd = globalClaudeMd
      ? `${globalClaudeMd}\n\n${identityBoundary}\n\n${relationshipMemory}`
      : `${identityBoundary}\n\n${relationshipMemory}`;
  }

  // Discover additional directories mounted at /workspace/extra/*, or direct
  // host paths passed by the sandbox/noSandbox runtime.
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const addExtraDir = (dir: string) => {
    if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      extraDirs.push(dir);
    }
  };
  if (process.env.CLAUDECLAW_EXTRA_DIRS) {
    try {
      const dirs = JSON.parse(process.env.CLAUDECLAW_EXTRA_DIRS);
      if (Array.isArray(dirs)) {
        for (const dir of dirs) addExtraDir(String(dir));
      }
    } catch {
      // Fall back to the legacy single-directory scan below.
    }
  }
  const extraBase = WORKSPACE_EXTRA;
  if (extraDirs.length === 0 && fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      addExtraDir(fullPath);
    }
  }
  const uniqueExtraDirs = [...new Set(extraDirs)];
  if (uniqueExtraDirs.length > 0) {
    log(`Additional directories: ${uniqueExtraDirs.join(', ')}`);
  }

  // Determine allowed tools (per-group override or defaults)
  const fullAccess =
    agentCfg?.fullAccess === true || agentCfg?.noSandbox === true;
  const defaultAllowedTools = [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    'Task',
    'TaskOutput',
    'TaskStop',
    'TeamCreate',
    'TeamDelete',
    'SendMessage',
    'TodoWrite',
    'ToolSearch',
    'Skill',
    'NotebookEdit',
    'mcp__claudeclaw__*',
  ];
  const fullAccessAllowedTools = [
    '*',
    'Bash',
    'Bash(*)',
    'Read',
    'Read(*)',
    'Write',
    'Write(*)',
    'Edit',
    'Edit(*)',
    'MultiEdit',
    'MultiEdit(*)',
    'Glob',
    'Grep',
    'LS',
    'NotebookRead',
    'NotebookEdit',
    'WebSearch',
    'WebFetch',
    'WebFetch(*)',
    'Task',
    'TaskOutput',
    'TaskStop',
    'TeamCreate',
    'TeamDelete',
    'SendMessage',
    'TodoWrite',
    'ToolSearch',
    'Skill',
    'SlashCommand',
    'ExitPlanMode',
    'BashOutput',
    'KillShell',
    'mcp__claudeclaw__*',
  ];
  const allowedTools = fullAccess
    ? [
        ...new Set([
          ...fullAccessAllowedTools,
          ...(agentCfg?.allowedTools ?? []),
        ]),
      ]
    : agentCfg?.allowedTools && agentCfg.allowedTools.length > 0
      ? agentCfg.allowedTools
      : defaultAllowedTools;

  const fullAccessDirectories = [
    WORKSPACE_GROUP,
    WORKSPACE_PROJECT,
    WORKSPACE_GLOBAL,
    ...uniqueExtraDirs,
    '/',
    '/Users/example',
    '/tmp',
    '/private/tmp',
    '/var/folders',
    '/Volumes',
    '/Applications',
    '/opt/homebrew',
  ].filter(
    (dir, idx, arr) => dir && arr.indexOf(dir) === idx && fs.existsSync(dir),
  );
  const fullAccessSettings = fullAccess
    ? {
        permissions: {
          allow: allowedTools,
          deny: [],
          ask: [],
          defaultMode: 'bypassPermissions',
          additionalDirectories: fullAccessDirectories,
        },
        enableAllProjectMcpServers: true,
        sandbox: {
          enabled: false,
          allowUnsandboxedCommands: true,
          autoAllowBashIfSandboxed: true,
          network: {
            allowedDomains: ['*'],
            allowLocalBinding: true,
            allowAllUnixSockets: true,
          },
          filesystem: {
            allowWrite: ['/'],
            denyWrite: [],
            denyRead: [],
          },
        },
        skipWebFetchPreflight: true,
      }
    : undefined;

  // Ensure memory directory exists for auto-memory + our memory tools
  const memoryDir = path.join(WORKSPACE_GROUP, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  // Phase 2.5C: disable SDK auto-memory for inboundOnly groups so external
  // (supplier/customer) message bodies cannot accumulate in the per-group
  // memory directory even via the SDK auto-remember heuristic. The MCP
  // memory_* tools are already disallowed for these groups (Phase 2.5A);
  // this gate closes the second memory layer. Non-inboundOnly groups
  // (e.g. telegram_main personal assistant) keep auto-memory enabled.
  const autoMemoryEnabled = agentCfg?.inboundOnly !== true;
  if (!autoMemoryEnabled) {
    log(
      `Auto-memory disabled for inboundOnly group: ${containerInput.groupFolder}`,
    );
  }

  // Build query options
  const queryOptions: Record<string, any> = {
    cwd: WORKSPACE_GROUP,
    autoMemoryDirectory: autoMemoryEnabled ? memoryDir : undefined, // v2.1.80+ — unifies SDK auto-memory with our memory_save/memory_search; gated by Phase 2.5C
    additionalDirectories:
      uniqueExtraDirs.length > 0 ? uniqueExtraDirs : undefined,
    resume: sessionId,
    resumeSessionAt: resumeAt,
    systemPrompt: globalClaudeMd
      ? {
          type: 'preset' as const,
          preset: 'claude_code' as const,
          append: globalClaudeMd,
        }
      : undefined,
    allowedTools,
    tools: { type: 'preset' as const, preset: 'claude_code' as const },
    env: sdkEnv,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settings: fullAccessSettings,
    settingSources: ['project', 'user'],
    mcpServers: {
      claudeclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          CLAUDECLAW_CHAT_JID: containerInput.chatJid,
          CLAUDECLAW_GROUP_FOLDER: containerInput.groupFolder,
          CLAUDECLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          CLAUDECLAW_GROUP_DIR: WORKSPACE_GROUP,
          CLAUDECLAW_IPC_DIR: WORKSPACE_IPC,
        },
      },
    },
    hooks: {
      PreCompact: [
        { hooks: [createPreCompactHook(containerInput.assistantName)] },
      ],
      PostCompact: [{ hooks: [createPostCompactHook()] }],
      StopFailure: [{ hooks: [createStopFailureHook(containerInput.chatJid)] }],
    },
  };

  // Apply per-group model override
  if (agentCfg?.model) {
    queryOptions.model = agentCfg.model;
  }

  // Apply per-group maxTurns override
  if (agentCfg?.maxTurns) {
    queryOptions.maxTurns = agentCfg.maxTurns;
  }

  // Apply per-group effort override (v2.1.78+)
  if (agentCfg?.effort) {
    queryOptions.effort = agentCfg.effort;
  }

  // Apply per-group disallowed tools (v2.1.78+ — blacklist on top of allowlist)
  if (agentCfg?.disallowedTools && agentCfg.disallowedTools.length > 0) {
    queryOptions.disallowedTools = agentCfg.disallowedTools;
  }

  // Heartbeat в stderr пока активен query() — host'овый hang-timer (180s на
  // ANY stdout/stderr chunk) убивал sandbox даже когда агент честно работал
  // (тяжёлый context, Whisper, vision API), потому что SDK iterator может
  // молчать >3 мин между yield'ами. log() пишет в stderr — этот pattern
  // resets resetHangTimeout() на host. Cleared в finally чтобы idle wait
  // после query видел настоящие deadlock'и.
  const queryHeartbeat = setInterval(() => {
    log('still working...');
  }, 30_000);

  try {
    for await (const message of query({
      prompt: stream,
      options: queryOptions,
    })) {
      messageCount++;
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
        turns++;
      }

      // Capture usage data from messages
      if ('usage' in message) {
        const u = (message as any).usage;
        if (u) {
          totalInputTokens += u.input_tokens || 0;
          totalOutputTokens += u.output_tokens || 0;
          totalCacheCreation += u.cache_creation_input_tokens || 0;
          totalCacheRead += u.cache_read_input_tokens || 0;
        }
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      if (
        message.type === 'system' &&
        (message as { subtype?: string }).subtype === 'task_notification'
      ) {
        const tn = message as {
          task_id: string;
          status: string;
          summary: string;
        };
        log(
          `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
        );
      }

      if (message.type === 'result') {
        // SDK closes ProcessTransport immediately after type=result. Stop
        // IPC polling now to prevent stream.push() from racing against the
        // shutdown and throwing "ProcessTransport is not ready for writing".
        // Any IPC message that arrives after this will be picked up by
        // main()'s next waitForIpcMessage() call.
        ipcPolling = false;
        stream.end();
        resultCount++;
        const textResult =
          'result' in message ? (message as { result?: string }).result : null;
        log(
          `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
        );
        // На error_during_execution часто нет textResult — текст ошибки лежит в
        // других полях SDK-сообщения (error, message, is_error). Дамим весь объект
        // в stderr, чтобы оператор видел реальный reason, а не только subtype.
        if (message.subtype === 'error_during_execution') {
          try {
            log(
              `error_during_execution detail: ${JSON.stringify(message).slice(0, 800)}`,
            );
          } catch {
            log(`error_during_execution detail: <unserializable>`);
          }
        }

        // Detect a stale session_id: Claude Code's SDK reports
        //   subtype=error_during_execution
        //   result="Claude Code returned an error result: No conversation found with session ID: <uuid>"
        // when we passed `resume: sessionId` but the conversation file no longer
        // exists on disk (sandbox isolation discards transcripts between runs,
        // host crashes, manual cleanup, etc). The default behaviour was to
        // surface this as a hard failure → host retries 5x → max retries exceeded
        // → user-facing silence. Instead we signal the caller to drop the
        // session_id and start a fresh conversation, transparent to the user.
        if (
          message.subtype === 'error_during_execution' &&
          typeof textResult === 'string' &&
          /No conversation found with session ID/i.test(textResult)
        ) {
          log(
            `Stale session detected (sessionId=${sessionId}); will retry with fresh session.`,
          );
          staleSession = true;
          // Don't writeOutput: caller (main) will retry with sessionId=undefined,
          // and the retry will writeOutput a real result.
          break;
        }

        writeOutput({
          status: 'success',
          result: textResult || null,
          newSessionId,
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cacheCreationInputTokens: totalCacheCreation || undefined,
            cacheReadInputTokens: totalCacheRead || undefined,
          },
          turns,
        });
      }
    }
  } finally {
    clearInterval(queryHeartbeat);
    ipcPolling = false;
  }

  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, staleSession: ${staleSession}, tokens: ${totalInputTokens}in/${totalOutputTokens}out`,
  );
  return {
    newSessionId,
    lastAssistantUuid,
    closedDuringQuery,
    staleSession,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheCreationInputTokens: totalCacheCreation || undefined,
      cacheReadInputTokens: totalCacheRead || undefined,
    },
    turns,
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      // Wrap runQuery in a per-iteration try/catch so we can recover from
      // a stale session_id transparently. The Claude Code SDK *throws*
      // (not just emits a result message) when we pass `resume: <uuid>`
      // and the on-disk transcript is gone — so the in-stream check
      // inside runQuery never fires for that path. We must catch the
      // thrown Error here and retry once with sessionId=undefined.
      let queryResult;
      try {
        queryResult = await runQuery(
          prompt,
          sessionId,
          mcpServerPath,
          containerInput,
          sdkEnv,
          resumeAt,
        );
      } catch (queryErr) {
        const queryMsg =
          queryErr instanceof Error ? queryErr.message : String(queryErr);
        if (
          /No conversation found with session ID/i.test(queryMsg) &&
          sessionId !== undefined
        ) {
          log(
            `Stale session detected via thrown error (sessionId=${sessionId}); retrying with fresh session.`,
          );
          sessionId = undefined;
          resumeAt = undefined;
          continue;
        }
        throw queryErr; // unrelated error — let the outer catch handle it
      }

      // Same fallback for the in-stream code path (we keep both — Claude
      // Code SDK could in principle return the error as a result message
      // instead of throwing).
      if (queryResult.staleSession) {
        log(
          `Stale session detected via stream (sessionId=${sessionId}); retrying with fresh session.`,
        );
        sessionId = undefined;
        resumeAt = undefined;
        continue;
      }

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it (include usage from this query)
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId,
        usage: queryResult.usage,
        turns: queryResult.turns,
      });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
