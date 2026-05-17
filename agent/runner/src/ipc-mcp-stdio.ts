/**
 * Stdio MCP Server for ClaudeClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

// Runtime-agnostic: sandbox sets CLAUDECLAW_IPC_DIR, container uses /workspace/ipc
const IPC_DIR = process.env.CLAUDECLAW_IPC_DIR || '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.CLAUDECLAW_CHAT_JID!;
const groupFolder = process.env.CLAUDECLAW_GROUP_FOLDER!;
const isMain = process.env.CLAUDECLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'claudeclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'send_photo',
  'Send an image file created in this chat workspace to the user via the chat channel (currently Telegram). Guest chats must provide a relative workspace path to a .jpg/.png/.webp image. Optional caption (max 1024 chars).',
  {
    filePath: z
      .string()
      .describe(
        'Relative path to an image file in this chat workspace, e.g. "received/photo.jpg" or "output/chart.png"',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional caption shown below the image (max 1024 chars)'),
  },
  async (args) => {
    const allowed = validateSendableFilePath(args.filePath, 'photo');
    if (!allowed.ok) {
      return {
        content: [{ type: 'text' as const, text: allowed.error }],
        isError: true,
      };
    }
    const data: Record<string, string | undefined> = {
      type: 'photo',
      chatJid,
      filePath: allowed.realPath,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Photo queued for delivery: ${allowed.realPath}`,
        },
      ],
    };
  },
);

server.tool(
  'send_document',
  'Send a document/file to the user via the chat channel (currently Telegram). Provide an absolute file path to a file created or edited for this user. Optional caption (max 1024 chars).',
  {
    filePath: z.string().describe('Absolute path to the document/file on disk'),
    caption: z
      .string()
      .optional()
      .describe('Optional caption shown with the file (max 1024 chars)'),
  },
  async (args) => {
    const allowed = validateSendableFilePath(args.filePath, 'document');
    if (!allowed.ok) {
      return {
        content: [{ type: 'text' as const, text: allowed.error }],
        isError: true,
      };
    }
    const data: Record<string, string | undefined> = {
      type: 'document',
      chatJid,
      filePath: allowed.realPath,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Document queued for delivery: ${allowed.realPath}`,
        },
      ],
    };
  },
);

server.tool(
  'send_voice_message',
  'Send a synthesized voice message (Telegram voice note) to the user. The host TTS pipeline (macOS `say` Milena → ffmpeg OGG opus, or OpenAI tts-1-hd if TTS_PROVIDER=openai) renders the audio and delivers it via the chat channel. Long texts are auto-chunked at 3000 chars. Use this when the user explicitly asks for voice ("озвучь", "голосом", "voice", "say it") or originally replied with a voice message and the answer is short (< 1500 chars) plain prose without code blocks or tables.',
  {
    text: z
      .string()
      .describe(
        'The text to synthesize and send as a voice note. Plain text, no Markdown — the TTS engine reads it verbatim.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'voice',
      chatJid,
      text: args.text,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Voice queued for delivery (${args.text.length} chars).`,
        },
      ],
    };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Memory tools — lightweight, file-based, QMD-upgradeable
// ---------------------------------------------------------------------------

const WORKSPACE_GROUP = process.env.CLAUDECLAW_GROUP_DIR || '/workspace/group';

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function workspaceRootReal(): string | null {
  return realpathOrNull(WORKSPACE_GROUP);
}

function validateSendableFilePath(
  filePath: string,
  kind: 'photo' | 'document',
): { ok: true; realPath: string } | { ok: false; error: string } {
  const toolName = kind === 'photo' ? 'send_photo' : 'send_document';
  if (filePath.includes('\0')) {
    return { ok: false, error: `${toolName} received an invalid file path.` };
  }

  if (kind === 'photo' && !isMain && path.isAbsolute(filePath)) {
    return {
      ok: false,
      error:
        'send_photo for guest chats requires a relative path inside this chat workspace.',
    };
  }

  let candidatePath = filePath;
  if (!path.isAbsolute(filePath)) {
    if (kind === 'document') {
      return {
        ok: false,
        error: 'send_document requires an absolute file path.',
      };
    }
    const normalized = path.normalize(filePath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      return {
        ok: false,
        error: 'send_photo path must stay inside this chat workspace.',
      };
    }
    candidatePath = path.join(WORKSPACE_GROUP, normalized);
  }

  if (!path.isAbsolute(candidatePath)) {
    return {
      ok: false,
      error: 'send_document requires an absolute file path.',
    };
  }

  const realPath = realpathOrNull(candidatePath);
  if (!realPath) {
    return {
      ok: false,
      error: `${kind === 'photo' ? 'Photo' : 'Document'} file not found: ${filePath}`,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch {
    return {
      ok: false,
      error: `${kind === 'photo' ? 'Photo' : 'Document'} file not readable: ${filePath}`,
    };
  }

  if (!stat.isFile()) {
    return {
      ok: false,
      error: `${kind === 'photo' ? 'Photo' : 'Document'} path is not a file: ${filePath}`,
    };
  }

  const maxTelegramDocumentBytes = 49 * 1024 * 1024;
  if (stat.size > maxTelegramDocumentBytes) {
    return {
      ok: false,
      error: `${kind === 'photo' ? 'Photo' : 'Document'} is too large to send via Telegram from this tool.`,
    };
  }

  if (!isMain) {
    const rootReal = workspaceRootReal();
    if (!rootReal || !isWithinPath(rootReal, realPath)) {
      return {
        ok: false,
        error: `${toolName} for guest chats can only send files from this chat workspace.`,
      };
    }
  }

  return { ok: true, realPath };
}

function normalizeWorkspaceRelativePath(file: string): string | null {
  const normalized = path.normalize(file);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  return normalized;
}

function resolveExistingWorkspacePath(file: string): string | null {
  const normalized = normalizeWorkspaceRelativePath(file);
  if (!normalized) return null;
  const rootReal = workspaceRootReal();
  if (!rootReal) return null;
  const real = realpathOrNull(path.join(WORKSPACE_GROUP, normalized));
  return real && isWithinPath(rootReal, real) ? real : null;
}

function resolveWritableWorkspacePath(file: string): string | null {
  const normalized = normalizeWorkspaceRelativePath(file);
  if (!normalized) return null;
  const rootReal = workspaceRootReal();
  if (!rootReal) return null;
  const candidate = path.join(WORKSPACE_GROUP, normalized);
  const parent = path.dirname(candidate);
  fs.mkdirSync(parent, { recursive: true });
  const parentReal = realpathOrNull(parent);
  if (!parentReal || !isWithinPath(rootReal, parentReal)) return null;
  const existingReal = realpathOrNull(candidate);
  if (existingReal && !isWithinPath(rootReal, existingReal)) return null;
  return candidate;
}

/** Recursively find .md files under a directory */
function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  const rootReal = realpathOrNull(dir);
  if (!rootReal) return results;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const real = realpathOrNull(full);
        if (real && isWithinPath(rootReal, real)) results.push(real);
      }
    }
  };
  walk(dir);
  return results;
}

server.tool(
  'memory_search',
  `Search across all memory files (CLAUDE.md, daily logs, topics, archived conversations) for matching content. Returns matching lines with file paths and context. Use this to recall past decisions, facts, or conversation details.`,
  {
    query: z
      .string()
      .describe('Search query — keywords or phrase to find in memory files'),
    max_results: z
      .number()
      .default(20)
      .describe('Maximum number of matching lines to return'),
  },
  async (args) => {
    const searchDirs = [WORKSPACE_GROUP];
    const allFiles = searchDirs.flatMap(findMarkdownFiles);

    if (allFiles.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No memory files found.' }],
      };
    }

    const queryLower = args.query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);
    const results: {
      file: string;
      line: number;
      text: string;
      score: number;
    }[] = [];

    for (const filePath of allFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const rootReal = workspaceRootReal() || WORKSPACE_GROUP;
        const relPath = path.relative(rootReal, filePath);

        for (let i = 0; i < lines.length; i++) {
          const lineLower = lines[i].toLowerCase();
          // Score: count how many query terms match
          const score = queryTerms.filter((t) => lineLower.includes(t)).length;
          if (score > 0) {
            results.push({
              file: relPath,
              line: i + 1,
              text: lines[i].trim(),
              score,
            });
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Sort by score descending, take top N
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, args.max_results);

    if (top.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No matches found for "${args.query}".`,
          },
        ],
      };
    }

    const formatted = top
      .map((r) => `${r.file}:${r.line}: ${r.text}`)
      .join('\n');

    return {
      content: [
        {
          type: 'text' as const,
          text: `Found ${top.length} matches (of ${results.length} total):\n\n${formatted}`,
        },
      ],
    };
  },
);

server.tool(
  'memory_save',
  `Save a fact, decision, preference, or note to persistent memory. Choose the right category:
• "daily" — append to today's daily log (memory/YYYY-MM-DD.md). Use for transient context, meeting notes, daily events.
• "topic" — append to a topic-specific file (memory/topics/{topic}.md). Use for project notes, per-person context, domain knowledge.
• "longterm" — append to CLAUDE.md (loaded every session). Use for durable facts, preferences, decisions that matter always.
Every saved entry includes provenance metadata. If a fact came from a photo/image interpretation or is uncertain, set source_type and confidence accordingly.`,
  {
    content: z.string().describe('The fact, note, or decision to save'),
    category: z
      .enum(['daily', 'topic', 'longterm'])
      .describe('Where to save: daily log, topic file, or long-term CLAUDE.md'),
    topic: z
      .string()
      .optional()
      .describe(
        'Topic name (required when category="topic", e.g., "project-alpha", "user-preferences")',
      ),
    source_type: z
      .enum([
        'user_message',
        'assistant_message',
        'photo_caption',
        'document',
        'manual',
        'summary',
      ])
      .default('manual')
      .describe('Where this memory came from'),
    message_id: z.string().optional().describe('Source Telegram/message ID'),
    event_id: z.string().optional().describe('Source event ID'),
    sender_id: z.string().optional().describe('Source Telegram sender ID'),
    tenant_id: z.string().optional().describe('Tenant ID if known'),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .default(0.7)
      .describe('Confidence in the saved fact, 0.0 to 1.0'),
  },
  async (args) => {
    if (
      /(api[_-]?key|token|password|secret|authorization|cookie|\.env|private key|ssh key)/i.test(
        args.content,
      )
    ) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Memory save rejected: content looks like a secret or credential.',
          },
        ],
      };
    }

    const normalizedSourceType =
      args.source_type === 'assistant_message' && args.confidence > 0.6
        ? 'summary'
        : args.source_type;
    const normalizedConfidence =
      args.source_type === 'photo_caption'
        ? Math.min(args.confidence, 0.5)
        : args.source_type === 'assistant_message'
          ? Math.min(args.confidence, 0.5)
          : args.confidence;

    const timestamp = new Date().toISOString();
    const date = timestamp.split('T')[0];
    let filePath: string;
    let label: string;

    if (args.category === 'daily') {
      filePath =
        resolveWritableWorkspacePath(path.join('memory', `${date}.md`)) || '';
      label = `memory/${date}.md`;
    } else if (args.category === 'topic' && args.topic) {
      const safeTopic = args.topic.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      filePath =
        resolveWritableWorkspacePath(
          path.join('memory', 'topics', `${safeTopic}.md`),
        ) || '';
      label = `memory/topics/${safeTopic}.md`;
    } else {
      filePath = resolveWritableWorkspacePath('CLAUDE.md') || '';
      label = 'CLAUDE.md';
    }

    if (!filePath) {
      return {
        content: [{ type: 'text' as const, text: 'Memory path rejected.' }],
      };
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Add header if file is new
    if (!fs.existsSync(filePath)) {
      if (args.category === 'daily') {
        fs.writeFileSync(filePath, `# Memory — ${date}\n\n`);
      } else if (args.category === 'topic' && args.topic) {
        fs.writeFileSync(filePath, `# ${args.topic}\n\n`);
      }
    }

    // Date prefix: daily files already have date in filename, so use HH:MM:SS only.
    // Topic/longterm files mix dates over time — use full YYYY-MM-DD HH:MM:SS so
    // entries can be filtered by "yesterday" / "this week" / etc.
    const time = timestamp.split('T')[1].split('.')[0];
    const stamp = args.category === 'daily' ? time : `${date} ${time}`;
    const provenance = {
      source_type: normalizedSourceType,
      confidence: normalizedConfidence,
      created_at: timestamp,
      group_folder: groupFolder,
      chat_jid: chatJid,
      tenant_id: args.tenant_id,
      sender_id: args.sender_id,
      message_id: args.message_id,
      event_id: args.event_id,
      provenance: args.message_id || args.event_id ? 'present' : 'missing',
    };
    fs.appendFileSync(
      filePath,
      `- [${stamp}] ${args.content} <!-- skoobi_memory_meta=${JSON.stringify(provenance)} -->\n`,
    );

    return {
      content: [{ type: 'text' as const, text: `Saved to ${label}` }],
    };
  },
);

server.tool(
  'memory_get',
  `Read a specific memory file. Returns empty text if the file doesn't exist (no error). Use for reading daily logs, topic files, or the main CLAUDE.md.`,
  {
    file: z
      .string()
      .describe(
        'Relative path from group root, e.g., "memory/2026-03-21.md", "memory/topics/project-alpha.md", "CLAUDE.md"',
      ),
  },
  async (args) => {
    const filePath = resolveExistingWorkspacePath(args.file);
    if (!filePath) {
      return {
        content: [{ type: 'text' as const, text: '' }],
      };
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return {
        content: [{ type: 'text' as const, text: content }],
      };
    } catch {
      return {
        content: [{ type: 'text' as const, text: '' }],
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Computer-control tools — proxy to the out-of-sandbox helper daemon
// ---------------------------------------------------------------------------

const HELPER_PORT = process.env.HELPER_PORT || '3200';
const HELPER_BASE = `http://127.0.0.1:${HELPER_PORT}`;
const HELPER_SECRET = process.env.HELPER_SECRET;

type HelperResult = Record<string, unknown>;

async function callHelper(
  method: 'GET' | 'POST',
  endpoint: string,
  body?: object,
): Promise<HelperResult> {
  if (!HELPER_SECRET) {
    throw new Error(
      'HELPER_SECRET not set — host did not forward it into the sandbox.',
    );
  }
  const res = await fetch(`${HELPER_BASE}${endpoint}`, {
    method,
    headers: {
      'X-Helper-Secret': HELPER_SECRET,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: HelperResult = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const detail =
      typeof parsed.detail === 'string'
        ? parsed.detail
        : typeof parsed.error === 'string'
          ? parsed.error
          : text;
    throw new Error(`helper ${endpoint} → HTTP ${res.status}: ${detail}`);
  }
  return parsed;
}

function helperErrorContent(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const hint = /fetch failed|ECONNREFUSED/i.test(msg)
    ? ' — check that com.claudeclaw.helper is loaded (launchctl list | grep claudeclaw.helper) and that 127.0.0.1:3200 is reachable.'
    : /401|unauthorized/i.test(msg)
      ? ' — HELPER_SECRET mismatch; verify .env and sandbox env forwarding.'
      : /screencapture|Accessibility|operation not permitted/i.test(msg)
        ? ' — macOS permission missing. Grant Screen Recording and Accessibility to /opt/homebrew/opt/node@22/bin/node in System Settings → Privacy & Security.'
        : '';
  return {
    content: [
      { type: 'text' as const, text: `Computer-control error: ${msg}${hint}` },
    ],
    isError: true,
  };
}

server.tool(
  'computer_screenshot',
  'Capture the full desktop via the helper daemon. Returns the PNG path — use the Read tool on it to view the image. Optionally also sends the screenshot to the user in the current chat.',
  {
    send_to_user: z
      .boolean()
      .optional()
      .describe(
        'If true, also send the screenshot as a photo to the current chat.',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional caption when send_to_user=true (max 1024 chars).'),
  },
  async (args) => {
    try {
      const result = await callHelper('POST', '/screenshot');
      const filePath = String(result.path);
      const bytes = typeof result.bytes === 'number' ? result.bytes : 0;
      if (args.send_to_user) {
        writeIpcFile(MESSAGES_DIR, {
          type: 'photo',
          chatJid,
          filePath,
          caption: args.caption || undefined,
          groupFolder,
          timestamp: new Date().toISOString(),
        });
      }
      const suffix = args.send_to_user ? ' (queued for delivery to user)' : '';
      return {
        content: [
          {
            type: 'text' as const,
            text: `Screenshot saved: ${filePath} (${bytes} bytes).${suffix} Use Read on the path to view it.`,
          },
        ],
      };
    } catch (err) {
      return helperErrorContent(err);
    }
  },
);

server.tool(
  'computer_click',
  'Click at screen coordinates (in points, top-left origin). Supports left/right button and double-click.',
  {
    x: z.number().describe('X coordinate in points'),
    y: z.number().describe('Y coordinate in points'),
    button: z
      .enum(['left', 'right'])
      .optional()
      .describe('Mouse button (default: left)'),
    double: z.boolean().optional().describe('Double-click (left button only)'),
  },
  async (args) => {
    try {
      const result = await callHelper('POST', '/click', args);
      return {
        content: [
          { type: 'text' as const, text: `Clicked: ${JSON.stringify(result)}` },
        ],
      };
    } catch (err) {
      return helperErrorContent(err);
    }
  },
);

server.tool(
  'computer_type',
  'Type text at the current focus. Use computer_click first to focus the target field.',
  { text: z.string().describe('The text to type') },
  async (args) => {
    try {
      const result = await callHelper('POST', '/type', { text: args.text });
      return {
        content: [
          { type: 'text' as const, text: `Typed ${result.length} chars.` },
        ],
      };
    } catch (err) {
      return helperErrorContent(err);
    }
  },
);

server.tool(
  'computer_key',
  'Press a key or chord. Examples: "return", "cmd+space", "cmd+shift+4", "arrow-up", "f5", "ctrl+c". Use "+" to combine modifiers (cmd/ctrl/alt/shift) with one key.',
  {
    keys: z
      .string()
      .describe('Key or chord (e.g. "return", "cmd+space", "ctrl+shift+t")'),
  },
  async (args) => {
    try {
      await callHelper('POST', '/key', { keys: args.keys });
      return {
        content: [{ type: 'text' as const, text: `Pressed: ${args.keys}` }],
      };
    } catch (err) {
      return helperErrorContent(err);
    }
  },
);

server.tool(
  'computer_open_app',
  'Launch or bring a macOS application to the front by name (e.g. "Safari", "Terminal", "Notes").',
  { name: z.string().describe('Application name') },
  async (args) => {
    try {
      await callHelper('POST', '/open_app', { name: args.name });
      return {
        content: [{ type: 'text' as const, text: `Opened: ${args.name}` }],
      };
    } catch (err) {
      return helperErrorContent(err);
    }
  },
);

server.tool(
  'computer_mouse_move',
  'Move the mouse cursor to the given screen coordinates (no click).',
  {
    x: z.number().describe('X coordinate in points'),
    y: z.number().describe('Y coordinate in points'),
  },
  async (args) => {
    try {
      await callHelper('POST', '/mouse_move', { x: args.x, y: args.y });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Mouse moved to (${args.x}, ${args.y}).`,
          },
        ],
      };
    } catch (err) {
      return helperErrorContent(err);
    }
  },
);

server.tool(
  'computer_screen_size',
  'Return the main display size in points.',
  {},
  async () => {
    try {
      const result = await callHelper('GET', '/screen_size');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Screen size: ${result.width}x${result.height}`,
          },
        ],
      };
    } catch (err) {
      return helperErrorContent(err);
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
