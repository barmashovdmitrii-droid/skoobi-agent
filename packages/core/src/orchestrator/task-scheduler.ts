import { ChildProcess, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { parseTelegramJid } from '@skoobi/shared/telegram-jid';
import {
  createTelegramSenderIdentity,
  loadOwnerAllowlistFromEnv,
} from './tenant-registry.js';

import {
  ASSISTANT_NAME,
  CONTAINER_TIMEOUT,
  DEFAULT_RUNTIME,
  IDLE_TIMEOUT,
  SCHEDULER_POLL_INTERVAL,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
  type CodexRunnerInputConfig,
} from '../runtimes/container-runner.js';
import { runSandboxAgent } from '../runtimes/sandbox-runner.js';
import {
  clearSession,
  consecutiveTaskFailures,
  getAllTasks,
  getDb,
  getDueTasks,
  getTaskById,
  logTaskRun,
  storeBotReply,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import {
  buildGoogleOperationPolicy,
  buildStandingGoogleOperationPolicy,
  googlePolicyDiagnostics,
} from './google-workspace-policy.js';
import { GOOGLE_WORKSPACE_TOOL_NAMES } from './google-workspace-operation.js';
import {
  promptReadsAsReminder,
  stripReminderLead,
} from './calendar-adapter.js';
import { UNTRUSTED_CONTENT_QUARANTINED_TOOLS } from './run-trust.js';
import { resolveResumeSessionId } from './transcript-rotation.js';
import { readEnvFile } from './env.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { computeNextRun } from './task-next-run.js';
import { agentConfigWithTenantInstructions } from './instructions.js';
import { logger } from './logger.js';
import { formatOutbound } from './router.js';
import {
  localFileLinkEventPayload,
  rewriteLocalFileLinks,
} from './local-file-links.js';
import { ipcDocumentHistoryPlaceholder } from './chat-file-sends.js';
import {
  runtimePersistencePolicy,
  runtimeVisibleTasks,
  safeRuntimeSessionIdOrUndefined,
} from './runtime-namespace.js';
import { createModelGateway, loadModelGatewayConfig } from './model-gateway.js';
import { logAgentRun } from '../run-telemetry/index.js';
import {
  codexTurnTracePayload,
  createRunCostAccumulator,
  describeCodexTurnSettings,
} from './codex-accounting.js';
import {
  MessageRouter,
  OutboundEnvelope,
  RegisteredGroup,
  ScheduledTask,
} from './types.js';
import {
  registerTaskAuthorizationCapability,
  revokeTaskAuthorizationCapability,
} from './task-authorization.js';

export const TASK_ERROR_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_TASK_FAILURES = 5;
const CODEX_RESERVE_FALLBACK_TEXT =
  'Сейчас не получилось получить ответ через основной и резервный AI-путь. Попробуй ещё раз чуть позже.';
const MAX_NOTICE_REMINDER_CHARS = 1000;
/**
 * Bound the unquoted reminder after removing its lead phrase.
 * Longer text is treated as instructions for the assistant rather than
 * as the reminder message itself.
 */
const MAX_NOTICE_PLAIN_REMINDER_CHARS = 600;
/** The reminder wording has to sit in the opening of the prompt. */
const NOTICE_REMINDER_HEAD_CHARS = 150;
/** A shorter quoted fragment may name a project rather than the reminder. */
const MIN_NOTICE_QUOTED_REMINDER_CHARS = 20;
/** The message a prompt introduces with a colon: «…сообщением: «текст»». */
const NOTICE_QUOTED_REMINDER = /:\s*«([^»]+)»/g;
/** «…рабочий проход, а не напоминание владельцу» (matched lowercased). */
const NOT_A_REMINDER = /(?<![а-яё])не\s+напоминани/;

export type TaskFailureNoticeOutcome =
  | 'uncertain'
  | 'paused'
  | 'retry'
  | 'stopped';



export function failureNoticeReminder(
  prompt: string,
): { text: string; quoted: boolean } | null {
  const lower = String(prompt || '').toLowerCase();
  if (!promptReadsAsReminder(lower.slice(0, NOTICE_REMINDER_HEAD_CHARS))) {
    return null;
  }
  if (NOT_A_REMINDER.test(lower)) return null;
  const withoutInternal = String(prompt || '').replace(/<internal>.*$/is, '');
  for (const match of withoutInternal.matchAll(NOTICE_QUOTED_REMINDER)) {
    const text = match[1].replace(/\s+/g, ' ').trim();
    // An inner «…» ends the match early: then it is not the whole message.
    if (text.length < MIN_NOTICE_QUOTED_REMINDER_CHARS || text.includes('«')) {
      continue;
    }
    return {
      text:
        text.length > MAX_NOTICE_REMINDER_CHARS
          ? `${text.slice(0, MAX_NOTICE_REMINDER_CHARS - 1).trimEnd()}…`
          : text,
      quoted: true,
    };
  }
  const plain = stripReminderLead(withoutInternal);
  if (!plain || plain.length > MAX_NOTICE_PLAIN_REMINDER_CHARS) return null;
  return { text: plain, quoted: false };
}



export function taskFailureNoticeText(input: {
  prompt: string;
  error: string;
  outcome: TaskFailureNoticeOutcome;
  failureCount: number;
}): string {
  const { prompt, outcome, failureCount } = input;
  const error = input.error.slice(0, 300);
  const promptPreview =
    prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
  const reminder = failureNoticeReminder(prompt);
  if (reminder) {
    const taskLine = reminder.quoted ? `\nЗадача: «${promptPreview}»` : '';
    const lead = `⚠️ Не смог отправить напоминание как обычно, вот оно: «${reminder.text}»${taskLine}`;
    switch (outcome) {
      case 'uncertain':
        return `⚠️ Задача остановлена после ошибки: внешнее действие могло уже выполниться. Автоматически повторять его не буду. Проверь результат перед возобновлением. Само напоминание: «${reminder.text}»${taskLine}`;
      case 'paused':
        return `${lead}\nЗадача не выполнилась ${failureCount} раз подряд и поставлена на паузу.\nОшибка: ${error}\nСкажи «возобнови задачу», когда починим причину.`;
      case 'retry':
        return `${lead}\nОшибка: ${error}\nПопробую снова по расписанию.`;
      case 'stopped':
        return `${lead}\nОшибка: ${error}\nЗадача остановлена.`;
    }
  }
  switch (outcome) {
    case 'uncertain':
      return `⚠️ Задача остановлена после ошибки: внешнее действие могло уже выполниться. Автоматически повторять его не буду. Проверь результат перед возобновлением: «${promptPreview}»`;
    case 'paused':
      return `⚠️ Запланированная задача не выполнилась ${failureCount} раз подряд и поставлена на паузу: «${promptPreview}»\nОшибка: ${error}\nСкажи «возобнови задачу», когда починим причину.`;
    case 'retry':
      return `⚠️ Запланированная задача не выполнилась: «${promptPreview}»\nОшибка: ${error}\nПопробую снова по расписанию.`;
    case 'stopped':
      return `⚠️ Запланированная задача не выполнилась и остановлена: «${promptPreview}»\nОшибка: ${error}`;
  }
}

/**
 * How long a task lease is considered live before it is treated as orphaned.
 *
 * getDueTasks() advances next_run only AFTER updateTaskAfterRun commits at the
 * end of a (potentially multi-minute) agent run, so the in-memory GroupQueue
 * dedup is the only thing stopping the next 60s poll from re-selecting a task
 * that is still mid-run. That dedup is volatile: an orchestrator restart
 * (crash/deploy) during a run — or after the run but before next_run is
 * advanced — would re-dispatch the task and execute it a SECOND time,
 * including schedule_type='once' tasks. For a bot that performs real-money /
 * side-effecting actions from scheduled prompts this is a duplicate-execution
 * hazard.
 *
 * A persisted lease closes that window: claimTaskForRun() stamps a row before
 * dispatch and releaseTaskLease() clears it on completion. A lease older than
 * this TTL is presumed orphaned (the owning process died mid-run) and is
 * deliberately reclaimable so a genuinely stuck task is not blocked forever.
 * The bound must be the maximum agent run time plus a margin so a healthy long
 * run is never reclaimed out from under itself.
 *
 * The ACTUAL maximum run time is NOT the global CONTAINER_TIMEOUT: the runtime
 * caps each run at `max(group.containerConfig?.timeout ?? CONTAINER_TIMEOUT,
 * IDLE_TIMEOUT + 30s)` (see sandbox-runner.ts), while a Codex-primary task may
 * additionally use `agentConfig.codexTurnTimeoutMs`. Either per-group timeout
 * (or IDLE_TIMEOUT itself) can exceed CONTAINER_TIMEOUT, so a fixed global TTL
 * would expire mid-run for such a group — letting a still-running task be
 * re-claimed/re-executed (the very duplicate-execution hazard the lease prevents).
 * computeLeaseTtlMs() therefore derives the TTL from the SAME ceiling the runtime
 * uses, resolved per task's group at claim time; TASK_LEASE_TTL_MS is the global
 * floor used when the group is unknown.
 */
const LEASE_TTL_MARGIN_MS = 5 * 60 * 1000;
const TASK_LEASE_TTL_MS = CONTAINER_TIMEOUT + LEASE_TTL_MARGIN_MS;
export const SCHEDULER_RESTART_GATE_TASK_ID = '__skoobi_restart_gate__';

/**
 * Resolve the lease TTL for a specific group, mirroring the runtime's own
 * run-time ceilings (container/sandbox and a possible Codex-primary turn) plus
 * a fixed margin. Passing `undefined`/no group falls back to the global TTL.
 */
export function computeLeaseTtlMs(
  group?: Pick<RegisteredGroup, 'containerConfig' | 'agentConfig'>,
): number {
  const configTimeout = group?.containerConfig?.timeout || CONTAINER_TIMEOUT;
  const rawCodexTimeout = group?.agentConfig?.codexTurnTimeoutMs;
  const codexTimeout =
    Number.isSafeInteger(rawCodexTimeout) && Number(rawCodexTimeout) > 0
      ? Number(rawCodexTimeout)
      : 0;
  const runtimeCeiling = Math.max(
    configTimeout,
    IDLE_TIMEOUT + 30_000,
    codexTimeout,
  );
  return runtimeCeiling + LEASE_TTL_MARGIN_MS;
}

let leaseTableReady = false;

function boolFrom(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function isCodexReserveFallbackEnabled(): boolean {
  const env = readEnvFile(['SKOOBI_CODEX_RESERVE_FALLBACK_ENABLED']);
  return boolFrom(
    env.SKOOBI_CODEX_RESERVE_FALLBACK_ENABLED ??
      process.env.SKOOBI_CODEX_RESERVE_FALLBACK_ENABLED,
    false,
  );
}

function isClaudeLimitText(value: string | null | undefined): boolean {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes("you've hit your limit") ||
    text.includes('you have hit your limit') ||
    text.includes('hit your limit') ||
    text.includes('usage limit') ||
    text.includes('rate_limit_event') ||
    text.includes('rate limit') ||
    text.includes('429')
  );
}

/**
 * Codex-primary switch for scheduled tasks. When enabled, tasks run the SAME
 * full sandboxed agent (workspace, claudeclaw MCP tools, group CLAUDE.md
 * preamble) as chat turns — just via the Codex CLI instead of the Claude SDK.
 * Added when Claude was retired as a provider (2026-07-07): the Claude CLI
 * login had lapsed and every scheduled task died with "Not logged in".
 * Sandbox runtime only; container groups keep the Claude path.
 */
function isScheduledTasksCodexPrimary(): boolean {
  const env = readEnvFile(['SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY']);
  return boolFrom(
    env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY ??
      process.env.SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY,
    false,
  );
}

/**
 * Resolve the codex binary to an absolute path once per process (mirrors
 * message-loop's resolver): launchd/seatbelt children have PATH quirks, so an
 * absolute path keeps the run independent of them.
 */
let cachedCodexCommandPath: string | undefined;
function resolveCodexCommandPath(command: string): string {
  if (path.isAbsolute(command)) return command;
  if (cachedCodexCommandPath) return cachedCodexCommandPath;
  try {
    const resolved = execFileSync('/usr/bin/which', [command], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    cachedCodexCommandPath = resolved || command;
  } catch {
    cachedCodexCommandPath = command;
  }
  return cachedCodexCommandPath;
}

const DEFAULT_CODEX_TASK_TIMEOUT_MS = 15 * 60 * 1000;

export function scheduledTaskChatId(chatJid: string): string {
  return parseTelegramJid(chatJid)?.chatId || chatJid.replace(/^tg:/, '');
}

/**
 * Codex runtime config for a codex-primary scheduled-task run. Same
 * SKOOBI_CODEX_* env keys as the live gateway / full-agent reserve, so tasks
 * need no extra model configuration (mirrors buildCodexReserveInputConfig).
 */
function buildCodexTaskInputConfig(
  group: RegisteredGroup,
): CodexRunnerInputConfig {
  const codex: Partial<
    NonNullable<ReturnType<typeof loadModelGatewayConfig>['codex']>
  > = loadModelGatewayConfig().codex ?? {};
  return {
    command: resolveCodexCommandPath(codex.command || 'codex'),
    model: codex.model || 'gpt-5.6-sol',
    fallbackModel: codex.allowModelDowngrade ? codex.fallbackModel : undefined,
    reasoningEffort: codex.reasoningEffort || undefined,
    webSearchEnabled: codex.webSearchEnabled === true,
    timeoutMs: codexTaskTimeoutMs(group),
  };
}

/** The codex turn budget of a scheduled-task run of this group. */
function codexTaskTimeoutMs(
  group: Pick<RegisteredGroup, 'agentConfig'>,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const timeoutRaw = Number.parseInt(
    env.SKOOBI_CODEX_RESERVE_TIMEOUT_MS || '',
    10,
  );
  const groupTimeoutMs = group.agentConfig?.codexTurnTimeoutMs;
  return Number.isSafeInteger(groupTimeoutMs) && Number(groupTimeoutMs) > 0
    ? Number(groupTimeoutMs)
    : Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? timeoutRaw
      : DEFAULT_CODEX_TASK_TIMEOUT_MS;
}

/**
 * The longest a scheduled-task run of this group can take: the sandbox's own
 * hard cap around the codex turn, max(config timeout, IDLE_TIMEOUT + 30 s,
 * codex task budget + 2 min) — the formula of resolveSandboxGlobalTimeoutMs
 * in sandbox-runner.ts, kept here so this module needs nothing more from the
 * runtime. The host tells a person who writes during a task when it will be
 * over at the latest («закончится не позже HH:MM»).
 */
export function scheduledTaskRunCeilingMs(
  group: Pick<RegisteredGroup, 'containerConfig' | 'agentConfig'>,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return Math.max(
    group.containerConfig?.timeout || CONTAINER_TIMEOUT,
    IDLE_TIMEOUT + 30_000,
    codexTaskTimeoutMs(group, env) + 120_000,
  );
}

/**
 * claudeclaw tools a read_only task never gets. The MCP server does not
 * register them at all (ipc-mcp-stdio registerTool), so no text the run reads
 * can talk the model into calling them.
 *
 * - the untrusted-content quarantine: sending, task changes, memory_save,
 *   skill_propose, register_group, the Mac and Codex Desktop drivers;
 * - codex_desktop_status, to take the whole codex_desktop_* family out;
 * - every Google tool, readers too: the profile has no Google at all, and a
 *   reader without a host policy would only fail.
 *
 * What stays: list_tasks, memory_get, memory_search, skill_list, skill_view.
 */
export const READ_ONLY_TASK_DISALLOWED_TOOLS: readonly string[] = [
  ...new Set([
    ...UNTRUSTED_CONTENT_QUARANTINED_TOOLS,
    'codex_desktop_status',
    ...GOOGLE_WORKSPACE_TOOL_NAMES,
  ]),
];

/**
 * Does this task run with the read_only profile? NULL/absent is the normal
 * run. A value this build does not know is treated as read_only: whoever set
 * it meant to restrict the task, and a typo must not hand back full access.
 */
export function taskRunsReadOnly(
  task: Pick<ScheduledTask, 'id' | 'run_profile'>,
): boolean {
  const profile: unknown = task.run_profile;
  if (profile === undefined || profile === null || profile === '') {
    return false;
  }
  if (profile !== 'read_only') {
    logger.warn(
      { taskId: task.id, runProfile: String(profile).slice(0, 40) },
      'Unknown scheduled-task run profile; applying read_only',
    );
  }
  return true;
}

async function runCodexReserveForTask(input: {
  task: ScheduledTask;
  group: RegisteredGroup;
  ownerAuthorized: boolean;
}): Promise<string> {
  const gateway = createModelGateway();
  const response = await gateway.complete({
    tenant_id: `scheduled_task_${input.task.group_folder}`,
    session_id: `scheduled_task_${input.task.id}`,
    model_role: input.ownerAuthorized ? 'owner' : 'default',
    messages: [
      {
        role: 'system',
        content:
          'Ты Skoobi и выполняешь запланированную задачу. Верни только полезный результат для пользователя, без внутренних технических подробностей.',
      },
      {
        role: 'user',
        content: input.task.prompt,
      },
    ],
    tools: [],
    metadata: {
      channel: 'telegram',
      chat_id: scheduledTaskChatId(input.task.chat_jid),
      // A scheduled/background run has no human sender. Reusing the raw JID
      // here was both semantically wrong and leaked bot/thread prefixes into a
      // field that downstream telemetry treats as a user identity.
      sender_id: 'scheduled_task',
      tenant_mode: input.ownerAuthorized ? 'owner' : 'guest',
      task_type: 'chat',
    },
  });
  const text = response.text.trim();
  if (!text) throw new Error('Codex reserve returned empty task result');
  return text;
}

/**
 * Lazily create the lease table on the active DB connection. Kept here rather
 * than in db.ts's createSchema so this concern stays local to the scheduler;
 * `CREATE TABLE IF NOT EXISTS` is idempotent and safe to call every claim.
 * Works for both the production DB (initDatabase) and the in-memory test DB
 * (_initTestDatabase). The `leaseTableReady` flag is reset by
 * _resetSchedulerLoopForTests so each test's fresh DB re-creates the table.
 */
function ensureLeaseTable(): void {
  if (leaseTableReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS task_leases (
      task_id TEXT PRIMARY KEY,
      locked_until INTEGER NOT NULL
    );
  `);
  leaseTableReady = true;
}

/**
 * Atomically claim a task for execution. Returns true if this caller now owns
 * the lease, false if a live (non-expired) lease is already held — in which
 * case the task is already in flight and must not be dispatched again.
 *
 * The restart-gate check and lease write run in one BEGIN IMMEDIATE
 * transaction. This serializes claims with the restart worker: either a task
 * claims first and the restart waits, or the gate claims first and no new task
 * starts until the service has restarted.
 */
export function claimTaskForRun(
  taskId: string,
  now: number = Date.now(),
  leaseTtlMs: number = TASK_LEASE_TTL_MS,
): boolean {
  ensureLeaseTable();
  if (taskId === SCHEDULER_RESTART_GATE_TASK_ID) return false;
  // Bound the lease by the runtime's actual run-time ceiling for THIS task's
  // group (passed by the caller), never below the global floor, so a group
  // with a larger containerConfig.timeout / IDLE_TIMEOUT can't have a healthy
  // long run reclaimed and re-executed out from under itself.
  const lockedUntil = now + Math.max(leaseTtlMs, TASK_LEASE_TTL_MS);
  const db = getDb();
  const restartGate = db.prepare(
    `
      SELECT 1
      FROM task_leases
      WHERE task_id = ?
        AND locked_until > ?
      LIMIT 1
    `,
  );
  const claim = db.prepare(
    `
      INSERT INTO task_leases (task_id, locked_until)
      VALUES (@taskId, @lockedUntil)
      ON CONFLICT(task_id) DO UPDATE SET locked_until = @lockedUntil
      WHERE task_leases.locked_until <= @now
    `,
  );
  const claimTransaction = db.transaction(() => {
    if (restartGate.get(SCHEDULER_RESTART_GATE_TASK_ID, now)) {
      return false;
    }
    const info = claim.run({ taskId, lockedUntil, now });
    return info.changes > 0;
  });
  // BEGIN IMMEDIATE serializes this check+claim with the restart worker's own
  // BEGIN IMMEDIATE transaction. Either the task lease wins and the worker
  // waits for it, or the restart gate wins and this claim is refused; there is
  // no check-to-kickstart window where a new task can slip through.
  return claimTransaction.immediate();
}



export function renewTaskLease(
  taskId: string,
  now: number = Date.now(),
  leaseTtlMs: number = TASK_LEASE_TTL_MS,
): boolean {
  ensureLeaseTable();
  if (taskId === SCHEDULER_RESTART_GATE_TASK_ID) return false;
  const lockedUntil = now + Math.max(leaseTtlMs, TASK_LEASE_TTL_MS);
  const info = getDb()
    .prepare(
      `
        UPDATE task_leases
           SET locked_until = MAX(locked_until, ?)
         WHERE task_id = ?
      `,
    )
    .run(lockedUntil, taskId);
  return info.changes > 0;
}

/**
 * Release a task lease once its run has finished (success or failure), so the
 * task can be picked up again on its next scheduled occurrence. Safe to call
 * even if no lease is held (e.g. the run was never claimed).
 */
export function releaseTaskLease(taskId: string): void {
  ensureLeaseTable();
  if (taskId === SCHEDULER_RESTART_GATE_TASK_ID) return;
  getDb().prepare('DELETE FROM task_leases WHERE task_id = ?').run(taskId);
}

// computeNextRun lives in task-next-run.ts so the dashboard can re-arm a
// resumed task by the same rule; re-exported for existing importers.
export { computeNextRun };

export function computeNextRunAfterTaskAttempt(
  task: ScheduledTask,
  hadError: boolean,
  now: number = Date.now(),
  failureCount: number = 1,
): string | null {
  if (hadError && failureCount >= MAX_CONSECUTIVE_TASK_FAILURES) return null;
  if (hadError && task.schedule_type === 'once') {
    const attempt = Number.isSafeInteger(failureCount) ? Math.max(1, failureCount) : 1;
    return new Date(now + TASK_ERROR_RETRY_DELAY_MS * 2 ** Math.min(attempt - 1, 3)).toISOString();
  }
  return computeNextRun(task);
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  router: MessageRouter;
}

/**
 * Does this task text ask for Google at all?
 *
 * Only used to decide whether an ABSENT policy is worth telling the owner
 * about: a reminder to drink water needs no Google authority, a task that says
 * "внеси в таблицу" and silently gets none is a broken task pretending to work.
 */


export async function routeAndRecordTaskOutput(
  router: MessageRouter,
  envelope: OutboundEnvelope,
): Promise<string | null> {
  const delivered = await router.route(envelope);
  if (delivered) {
    try {
      storeBotReply(envelope.chatJid, delivered, undefined, 'scheduled-task');
    } catch (err) {
      logger.warn(
        { chatJid: envelope.chatJid, err },
        'Delivered task output not stored as bot history',
      );
    }
  }
  return delivered;
}

/**
 * Links to local files in a task result, resolved exactly as for
 * a chat answer (local-file-links.ts): the file goes out before the text, its
 * path never does. Only an owner-authorized task of a main chat attaches
 * anything. Never fails the run: on an error the text goes out as it was.
 */
export async function attachTaskLocalFileLinks(input: {
  router: MessageRouter;
  task: Pick<ScheduledTask, 'id' | 'chat_jid' | 'group_folder'>;
  ownerAuthorized: boolean;
  text: string;
}): Promise<string> {
  if (!input.text.includes('](')) return input.text;
  try {
    const rewrite = await rewriteLocalFileLinks({
      text: input.text,
      groupFolder: input.task.group_folder,
      chatJid: input.task.chat_jid,
      router: input.router,
      isMain: input.ownerAuthorized,
      // Tasks reach their chat through the router alone; of the channels
      // only Telegram sends documents.
      canSendDocuments: parseTelegramJid(input.task.chat_jid) !== null,
    });
    for (const filePath of rewrite.sentFiles) {
      try {
        storeBotReply(
          input.task.chat_jid,
          ipcDocumentHistoryPlaceholder(filePath),
          undefined,
          'scheduled-task',
        );
      } catch (err) {
        logger.warn(
          { taskId: input.task.id, err },
          'Attached document placeholder not stored as bot history',
        );
      }
    }
    const payload = localFileLinkEventPayload(rewrite.links);
    if (payload) {
      logger.info(
        { taskId: input.task.id, group: input.task.group_folder, ...payload },
        'Local file links in the task result rewritten',
      );
    }
    return rewrite.text;
  } catch (err) {
    logger.warn(
      { taskId: input.task.id, err },
      'Local file link rewrite failed; sending the task result unchanged',
    );
    return input.text;
  }
}

export function taskPromptRequestsGoogle(prompt: string): boolean {
  // Без \b и без \w: в JS они ASCII-only, поэтому перед кириллицей граница
  // слова не срабатывает вовсе — ровно та ловушка, на которой уже обожглась

  return /(google|гугл|таблиц|spreadsheet|sheets|диск|drive|календар|calendar|почт|gmail|документ|docs|скрипт)/iu.test(
    prompt,
  );
}

export async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    // Stop retry churn: getDueTasks() re-selects any active task whose
    // next_run is in the past, and next_run is only advanced by
    // updateTaskAfterRun (skipped on this early return). Without pausing,
    // a task whose group is unregistered would be re-selected every poll
    // forever. Mirror the invalid-folder branch above and pause it; an
    // admin/IPC can reactivate it once the group is registered again.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;

  // task, NOT who is an owner TODAY. Trusting them alone meant that removing a
  // person from OWNER_TELEGRAM_USER_IDS did not revoke anything: their existing
  // cron rows kept running with credentialProxyTier 'owner', a fabricated
  // is_owner_sender:true identity, a live task-authorization capability and a
  // task snapshot covering EVERY group. Re-derive the identity from the live
  // allowlist on every run, exactly as db.ts:172-181 already does for chats.
  const storedCreatorIsOwner =
    task.creator_authorization === 'owner_sender' &&
    typeof task.creator_identity_id === 'string' &&
    task.creator_identity_id.length > 0 &&
    typeof task.creator_sender_id === 'string' &&
    task.creator_sender_id.length > 0;
  // Only re-check when an owner allowlist is actually CONFIGURED. With an empty
  // OWNER_TELEGRAM_USER_IDS nobody satisfies is_owner_sender (see
  // telegram-identity.ts:148), so an unconditional re-check would silently
  // downgrade every scheduled task on any deployment that does not use the
  // allowlist — a much bigger regression than the hole being closed.
  let creatorStillOwner = true;
  if (storedCreatorIsOwner) {
    try {
      const allowlist = loadOwnerAllowlistFromEnv();
      if (allowlist.telegram_user_ids.size > 0) {
        const liveCreatorIdentity = createTelegramSenderIdentity({
          chatId: scheduledTaskChatId(task.chat_jid),
          fromId: task.creator_sender_id!,
          ownerAllowlist: allowlist,
        });
        creatorStillOwner =
          liveCreatorIdentity.is_owner_sender === true &&
          liveCreatorIdentity.identity_id === task.creator_identity_id;
      }
    } catch {
      // A malformed allowlist must not silently grant authority.
      creatorStillOwner = false;
    }
  }
  const ownerAuthorized = isMain && storedCreatorIsOwner && creatorStillOwner;
  if (isMain && storedCreatorIsOwner && !creatorStillOwner) {
    logger.warn(
      {
        taskId: task.id,
        groupFolder: task.group_folder,
      },
      'Scheduled task created by a no-longer-authorized owner — downgrading this run to guest tier',
    );
  }
  const ownerSenderIdentity = ownerAuthorized
    ? {
        channel: 'telegram' as const,
        chat_id: scheduledTaskChatId(task.chat_jid),
        telegram_user_id: task.creator_sender_id!,
        identity_id: task.creator_identity_id!,
        is_owner_sender: true,
        telegram_message_origin: 'direct' as const,
      }
    : undefined;
  const persistencePolicy = runtimePersistencePolicy({
    groupIsMain: isMain,
    credentialProxyTier: ownerAuthorized ? 'owner' : 'guest',
    chatJid: task.chat_jid,
  });
  const tasks = runtimeVisibleTasks(persistencePolicy, getAllTasks());
  writeTasksSnapshot(
    task.group_folder,
    ownerAuthorized,
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

  let result: string | null = null;
  let error: string | null = null;
  let observedSideEffect = false;
  let deliveredAnyOutput = false;
  let codexReserveFallbackAttempted = false;
  let codexReserveFallbackDelivered = false;
  // What the run cost and ran with, for agent_runs: the runner reports it on
  // its success/error frames (streamed, summed over the run's turns — see
  // createRunCostAccumulator) or as the final output.
  const runCost = createRunCostAccumulator();
  let finalOutput: ContainerOutput | undefined;
  let agentRunModel: string | undefined;
  let agentStarted = false;

  // Codex-primary scheduled tasks: same full sandbox agent, Codex CLI backend.
  // This route is restricted to host-proven owner-created tasks in main:
  // unproven/guest rows must not gain a more capable provider merely because
  // the process-wide switch is enabled. The container runtime has no codex
  // provider support (mirrors the guard in message-loop's runAgent).
  const runtime = group.runtime || DEFAULT_RUNTIME;
  const codexPrimary =
    isScheduledTasksCodexPrimary() && runtime === 'sandbox' && ownerAuthorized;
  // read_only profile (the nightly review reads other people's chats with the
  // owner's authority): no Google policy, the outbound/persistent tools are
  // not registered, and the Codex shell runs in its read-only sandbox without
  // web search. Everything else — tier, provider, delivery — stays as is.
  const readOnlyProfile = taskRunsReadOnly(task);

  // For group context mode, use the group's current session — but first run the
  // same transcript-size guard as the message loop: a group whose only traffic
  // is scheduled tasks would otherwise bloat its on-disk transcript unbounded
  // and wedge on "Prompt is too long". On rotation the session is archived and
  // cleared so the task starts on a fresh session.
  // Codex runs never resume (or rotate) the Claude SDK session — the Claude
  // transcript stays untouched so a later Claude run continues where it left off.
  const sessions = deps.getSessions();
  const sessionId =
    codexPrimary || !persistencePolicy.resumeCanonicalSession
      ? undefined
      : resolveResumeSessionId(
          task.group_folder,
          task.context_mode === 'group'
            ? safeRuntimeSessionIdOrUndefined(sessions[task.group_folder])
            : undefined,
          {
            clearSession: (folder) => {
              delete sessions[folder];
              clearSession(folder);
            },
            onRotated: (info, folder) => {
              logger.warn(
                {
                  taskId: task.id,
                  groupFolder: folder,
                  bytes: info.bytes,
                  archivedTo: info.archivedPath,
                  archiveError: info.archiveError,
                },
                `Rotated bloated transcript (${info.bytes} bytes) for ${folder}`,
              );
            },
            onError: (err, folder) => {
              logger.warn(
                { err, groupFolder: folder },
                'Transcript size guard failed; resuming existing session',
              );
            },
          },
        );

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  // Derive the scheduled run's Google policy from the authorized task prompt.
  // Creator authorization has already been checked above; the same intent
  // parser used for interactive requests limits access to the task's scope.
  //
  // The message id is part of the policy's intentId, and the Google mutation
  // journal dedupes writes per intent. With a bare task id every occurrence of
  // a recurring task shared one intent: the second day's append to the same
  // table was refused as a repeat (text-derived slot) or answered from the
  // first day's journal row without writing. Keyed on the occurrence, each
  // occurrence writes once, and a re-dispatch of the same occurrence (after a
  // crash, or a once-task's retry after an error, whose next_run moves but
  // whose schedule_value does not) runs under the same intent. For the
  // text-derived policy the append slot is the target, so a repeated append
  // is refused. The standing policy journals the occurrence's appends without
  // the read digest (scheduledOccurrence below): the re-dispatch re-reads the
  // table, gets a new digest because of the row it already added, and its
  // append of the same row is answered from the journal.
  const taskOccurrence =
    task.schedule_type === 'once'
      ? `once:${task.schedule_value}`
      : task.next_run || new Date(startTime).toISOString();
  const taskOwnerMessages = ownerSenderIdentity
    ? [
        {
          id: `task-${task.id}@${taskOccurrence}`,
          chat_jid: task.chat_jid,
          sender: task.creator_sender_id || '',
          sender_name: 'owner',
          content: task.prompt,
          timestamp: new Date().toISOString(),
          is_bot_message: false,
          sender_identity: ownerSenderIdentity,
        },
      ]
    : null;

  // owner's own task the same toolset as his messages there. A read_only
  // task gets no policy at all, so the host refuses every google_* call.
  //
  // Standing access is the decision of the person whose chat it is, so a task
  // gets it only when that person created it. OWNER_TELEGRAM_USER_IDS is a
  // shared admin list, and any owner may point target_group_jid at another
  // registered chat: without this check an owner whose own chat has no
  // standing access got the whole toolset there (cell updates without
  // confirmation, root create, USER_ENTERED values) just by scheduling into a
  // chat that has it. In a Telegram private chat the chat id is the user's
  // id, so the creator owns the chat when the creator's sender id (checked
  // above against the live owner allowlist) equals the task's chat id.
  // Every other owner task — another owner's chat, a group chat — gets the
  // grant derived from its own text, as in a chat without standing access.
  const standingAccessConfigured =
    group.agentConfig?.googleStandingAccess === true;
  const creatorOwnsChat = Boolean(
    ownerSenderIdentity &&
    ownerSenderIdentity.telegram_user_id.length > 0 &&
    ownerSenderIdentity.telegram_user_id === ownerSenderIdentity.chat_id,
  );
  if (
    standingAccessConfigured &&
    ownerSenderIdentity &&
    !readOnlyProfile &&
    !creatorOwnsChat
  ) {
    logger.info(
      { taskId: task.id, group: task.group_folder },
      "Standing Google access not applied: the task's creator is not this chat's owner; using the grant from the task text",
    );
  }
  const googleOperationPolicy =
    taskOwnerMessages && !readOnlyProfile
      ? standingAccessConfigured && creatorOwnsChat
        ? buildStandingGoogleOperationPolicy({
            chatJid: task.chat_jid,
            messages: taskOwnerMessages,
            scheduledOccurrence: true,
          })
        : buildGoogleOperationPolicy({
            chatJid: task.chat_jid,
            messages: taskOwnerMessages,
          })
      : null;

  if (ownerSenderIdentity) {
    logger.info(
      {
        taskId: task.id,
        group: task.group_folder,
        path: 'scheduled_task',
        asksForGoogle: taskPromptRequestsGoogle(task.prompt),
        ...googlePolicyDiagnostics(googleOperationPolicy),
      },
      'Google policy outcome',
    );
  }

  const taskAuthorizationCapability = ownerSenderIdentity
    ? registerTaskAuthorizationCapability({
        groupFolder: task.group_folder,
        isMain,
        credentialProxyTier: 'owner',
        senderIdentity: ownerSenderIdentity,
        homogeneousOwnerBatch: true,
        googleOperationPolicy: googleOperationPolicy ?? undefined,
      }) || ''
    : '';
  // The public half of the same policy: which google_* wrappers the runner's
  // MCP server registers, and the host-made append coordinates it shows the
  // model. Without it the capability above authorized Google for the task,
  // but CLAUDECLAW_GOOGLE_ALLOWED_TOOLS stayed empty and the task saw no
  // google_* tool at all. Chat turns pass the same two fields
  // (message-loop.ts). Only a run holding the capability gets them: it is the
  // only thing that can authorize a call, so guest/unproven rows, read_only
  // runs (no policy) and an owner the Google allowlist excludes get none.
  const googleRunnerInput =
    googleOperationPolicy && taskAuthorizationCapability
      ? {
          googleAllowedTools: googleOperationPolicy.allowedTools,
          googleSheetTargetHints:
            googleOperationPolicy.allowedSheetAppendTargets,
        }
      : {};
  // Log missing Google policy at startup. Add a user-facing policy hint only
  // if the run fails, since successful completion may not need Google access.
  // A read_only task has no Google by design, so the «no policy» hint would
  // only mislead a failure notice.
  const googleIntentWithoutPolicy =
    Boolean(ownerSenderIdentity) &&
    !readOnlyProfile &&
    !googleOperationPolicy &&
    taskPromptRequestsGoogle(task.prompt);
  if (ownerSenderIdentity && !googleOperationPolicy && !readOnlyProfile) {
    logger.info(
      { taskId: task.id, group: task.group_folder },
      'Scheduled task carries no Google intent; google_* stays unavailable for this run',
    );
    if (googleIntentWithoutPolicy) {
      logger.warn(
        { taskId: task.id, group: task.group_folder },
        'Scheduled task asks for Google but no policy could be derived from its text',
      );
    }
  }

  try {
    const runAgent =
      runtime === 'sandbox' ? runSandboxAgent : runContainerAgent;
    if (codexPrimary) {
      logger.info(
        { taskId: task.id, group: task.group_folder },
        'Scheduled task running with Codex primary provider',
      );
    }
    const baseAgentConfig = agentConfigWithTenantInstructions(group, {
      includeTenantInstructions: persistencePolicy.includeCanonicalInstructions,
    });
    const agentConfig = readOnlyProfile
      ? {
          ...baseAgentConfig,
          disallowedTools: [
            ...new Set([
              ...(baseAgentConfig?.disallowedTools || []),
              ...READ_ONLY_TASK_DISALLOWED_TOOLS,
            ]),
          ],
        }
      : baseAgentConfig;
    const codexConfig = codexPrimary
      ? readOnlyProfile
        ? {
            ...buildCodexTaskInputConfig(group),
            // codex-exec turns this into `--sandbox read-only` and
            // web_search="disabled": the shell may read files and the
            // database, but cannot write, reach the network or browse.
            sandboxMode: 'read-only' as const,
            webSearchEnabled: false,
          }
        : buildCodexTaskInputConfig(group)
      : undefined;
    if (readOnlyProfile) {
      logger.info(
        {
          taskId: task.id,
          group: task.group_folder,
          codexSandbox: codexConfig?.sandboxMode ?? null,
          disallowedTools: agentConfig?.disallowedTools?.length ?? 0,
        },
        'Scheduled task running with read-only profile',
      );
      if (!codexConfig) {
        // Only the Codex path has a shell sandbox. Without it the tool
        // lockout and the missing Google policy still hold.
        logger.warn(
          { taskId: task.id, group: task.group_folder },
          'Read-only scheduled task runs without Codex; its shell is not sandboxed read-only',
        );
      }
    }
    // Only the Claude SDK puts its limit banner where the answer should be.
    // A Codex run's result is the model's own text: a morning review that
    // quotes yesterday's «rate limit» or «429» is a review, not a hit limit,
    // and must not be swapped for the fallback text and logged as an error.
    const claudeSdkRun = !codexConfig;
    // Same label a chat turn writes to agent_runs.model (message-loop
    // providerModelForAgentRunUsage): the subscription for Codex, else the
    // group's configured model.
    agentRunModel = codexConfig ? 'codex-subscription' : agentConfig?.model;
    agentStarted = true;
    const output = await runAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        // Only a host-verified owner-created row may regain main runtime
        // privileges. Legacy/missing provenance and co-member-created tasks
        // stay guest even when their destination folder is the main group.
        credentialProxyTier: ownerAuthorized ? 'owner' : 'guest',
        senderIdentity: ownerSenderIdentity,
        ...(taskAuthorizationCapability ? { taskAuthorizationCapability } : {}),
        ...googleRunnerInput,
        assistantName: ASSISTANT_NAME,
        agentConfig,
        ...(codexConfig
          ? {
              provider: 'codex_cli' as const,
              codex: codexConfig,
            }
          : {}),
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        // Every frame, including heartbeats, refreshes queue activity so a
        // healthy scheduled run is not interrupted as stale.
        deps.queue.noteRunActivity(task.chat_jid);
        if (streamedOutput.sideEffected === true) observedSideEffect = true;
        runCost.add(streamedOutput);
        if (streamedOutput.result) {
          let textToSend = streamedOutput.result;
          if (claudeSdkRun && isClaudeLimitText(streamedOutput.result)) {
            if (
              isCodexReserveFallbackEnabled() &&
              !codexReserveFallbackAttempted
            ) {
              codexReserveFallbackAttempted = true;
              try {
                textToSend = await runCodexReserveForTask({
                  task,
                  group,
                  ownerAuthorized,
                });
                codexReserveFallbackDelivered = true;
                logger.info(
                  { taskId: task.id, groupFolder: task.group_folder },
                  'Scheduled task answered through Codex reserve fallback',
                );
              } catch (err) {
                textToSend = CODEX_RESERVE_FALLBACK_TEXT;
                error =
                  err instanceof Error
                    ? `Codex reserve fallback failed: ${err.message}`
                    : 'Codex reserve fallback failed';
                logger.warn(
                  { taskId: task.id, groupFolder: task.group_folder, err },
                  'Scheduled task Codex reserve fallback failed',
                );
              }
            } else {
              textToSend = CODEX_RESERVE_FALLBACK_TEXT;
              error =
                'Primary scheduled-task runtime limit reached and reserve provider disabled';
            }
          }

          textToSend = await attachTaskLocalFileLinks({
            router: deps.router,
            task,
            ownerAuthorized,
            text: textToSend,
          });
          result = textToSend;
          const delivered = await routeAndRecordTaskOutput(deps.router, {
            chatJid: task.chat_jid,
            text: textToSend,
            triggerType: 'task-result',
            groupFolder: task.group_folder,
            meta: codexReserveFallbackDelivered
              ? { kind: 'codex_reserve_task_result' }
              : undefined,
          });
          if (delivered) deliveredAnyOutput = true;
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          if (!codexReserveFallbackDelivered) {
            error = streamedOutput.error || 'Unknown error';
          }
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    finalOutput = output;
    if (output.sideEffected === true) observedSideEffect = true;
    if (output.status === 'error' && !codexReserveFallbackDelivered) {
      error = output.error || 'Unknown error';
    } else if (output.result && !codexReserveFallbackDelivered) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      {
        taskId: task.id,
        durationMs: Date.now() - startTime,
        status: error ? 'error' : 'success',
      },
      'Task completed',
    );
    // A result wrapped entirely in <internal> is stripped by the router and

    // silently this way, T1). Say so once, with the task id, so the log and
    // the morning review can tell "delivered nothing" from "said nothing".
    if (!error && result && !deliveredAnyOutput && !formatOutbound(result)) {
      logger.info(
        { taskId: task.id, group: task.group_folder },
        'Task result fully internal, nothing delivered',
      );
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  } finally {
    if (taskAuthorizationCapability) {
      revokeTaskAuthorizationCapability(taskAuthorizationCapability);
    }
  }

  // The lockout should make this impossible; if it ever shows up, a mutating
  // tool slipped past the profile and the rollout needs a look.
  if (readOnlyProfile && observedSideEffect) {
    logger.error(
      { taskId: task.id, group: task.group_folder },
      'Read-only scheduled task reported a side-effecting tool call',
    );
  }

  const durationMs = Date.now() - startTime;

  const logScheduledAgentRun = (): void => {
    if (!agentStarted) return;
    // Also after a throw: the frames before it were paid for all the same.
    const {
      usage: runUsage,
      turns: runTurns,
      codexTurn: runCodexTurn,
    } = runCost.total(finalOutput);
    if (runCodexTurn) {
      logger.info(
        {
          taskId: task.id,
          group: task.group_folder,
          status: error ? 'error' : 'success',
          durationMs,
          requests: runCodexTurn.modelRequests ?? null,
          usageSource: runCodexTurn.usageSource ?? null,
          inputTokens: runUsage?.inputTokens ?? null,
          outputTokens: runUsage?.outputTokens ?? null,
          ...codexTurnTracePayload(runCodexTurn),
        },
        `codex turn settings: ${describeCodexTurnSettings(runCodexTurn)}`,
      );
    }
    logAgentRun({
      groupFolder: task.group_folder,
      chatJid: task.chat_jid,
      triggerType: 'scheduled',
      inputTokens: runUsage?.inputTokens || 0,
      outputTokens: runUsage?.outputTokens || 0,
      cacheCreationTokens: runUsage?.cacheCreationInputTokens || 0,
      cacheReadTokens: runUsage?.cacheReadInputTokens || 0,
      durationMs,
      turns: runTurns || 0,
      model: agentRunModel,
      status: error ? 'error' : 'success',
    });
  };

  // The task may have been deleted during the run (bulk cleanup_tasks, the
  // panel's delete button). Without the scheduled_tasks row, logTaskRun's
  // INSERT into task_run_logs would hit a foreign-key violation. Skip post-run
  // bookkeeping if the task is gone.
  const persistedTask = getTaskById(task.id);
  if (!persistedTask) {
    logger.debug(
      { taskId: task.id },
      'Task self-deleted during run, skipping post-run bookkeeping',
    );
    logScheduledAgentRun();
    return;
  }

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });
  logScheduledAgentRun();

  // cancel_task during the run (a self-polling task cancelling itself, or the
  // owner cancelling a minute after it fired) keeps the row with status
  // 'cancelled'. The run above is history; the status must not be rewritten
  // to completed/active, no next_run armed, no pause or failure notice.
  if (persistedTask.status === 'cancelled') {
    logger.info(
      { taskId: task.id },
      'Task cancelled during run; run logged, status kept',
    );
    return;
  }

  // Belt-and-suspenders: schedule computation must NEVER throw out of the
  // post-run path. If it did (e.g. a malformed schedule value not caught
  // upstream), next_run would never advance, the task would stay due, and the
  // next poll would re-execute the full agent run on a loop. On any failure,
  // fall back to completing the task (next_run = null) so it stops recurring.
  let nextRun: string | null;
  const failureCount = error ? consecutiveTaskFailures(task.id) : 0;
  const uncertainAction = Boolean(error) && observedSideEffect;
  const giveUp = uncertainAction || failureCount >= MAX_CONSECUTIVE_TASK_FAILURES;
  try {
    nextRun = giveUp ? null : computeNextRunAfterTaskAttempt(task, Boolean(error), Date.now(), failureCount);
  } catch (scheduleErr) {
    logger.error(
      { taskId: task.id, err: scheduleErr },
      'Failed to compute next run; completing task to avoid a re-execution loop',
    );
    nextRun = null;
  }
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
  if (giveUp) updateTask(task.id, { status: 'paused' });

  // A failed run that delivered no output is otherwise invisible outside the
  // logs (task_run_logs only) — the chat owner would never learn their
  // reminder died. Always announce a terminal pause, even if the failed run
  // produced text. A notice-delivery failure must not escape this path.
  if (error && (giveUp || !result)) {
    let noticeText = taskFailureNoticeText({
      prompt: task.prompt,
      error,
      outcome: uncertainAction
        ? 'uncertain'
        : giveUp
          ? 'paused'
          : nextRun
            ? 'retry'
            : 'stopped',
      failureCount,
    });
    if (googleIntentWithoutPolicy) {
      noticeText +=
        '\nВозможная причина: в плановом прогоне не было инструментов Google — разбор текста задачи не выдал разрешений.';
    }
    try {
      await routeAndRecordTaskOutput(deps.router, {
        chatJid: task.chat_jid,
        text: noticeText,
        triggerType: 'task-result',
        groupFolder: task.group_folder,
        meta: { kind: 'task_failure_notice' },
      });
    } catch (notifyErr) {
      logger.warn(
        { taskId: task.id, err: notifyErr },
        'Failed to deliver task-failure notice',
      );
    }
  }
}



export async function finalizeUnhandledTaskFailure(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  err: unknown,
  startTime: number,
): Promise<void> {
  const error = err instanceof Error ? err.message : String(err);
  logger.error(
    { taskId: task.id, group: task.group_folder, error },
    'Scheduled task threw outside the guarded run; recording it as a failure',
  );
  if (!getTaskById(task.id)) return;
  try {
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });

    const failures = consecutiveTaskFailures(task.id);
    const giveUp = failures >= MAX_CONSECUTIVE_TASK_FAILURES;

    let nextRun: string | null = null;
    if (!giveUp) {
      try {
        nextRun = computeNextRunAfterTaskAttempt(task, true, Date.now(), failures);
      } catch {
        nextRun = null;
      }
    }
    updateTaskAfterRun(task.id, nextRun, `Error: ${error}`);
    if (giveUp) updateTask(task.id, { status: 'paused' });

    const noticeText = taskFailureNoticeText({
      prompt: task.prompt,
      error,
      outcome: giveUp ? 'paused' : 'retry',
      failureCount: failures,
    });
    try {
      await routeAndRecordTaskOutput(deps.router, {
        chatJid: task.chat_jid,
        text: noticeText,
        triggerType: 'task-result',
        groupFolder: task.group_folder,
        meta: { kind: 'task_failure_notice' },
      });
    } catch (notifyErr) {
      logger.warn(
        { taskId: task.id, err: notifyErr },
        'Failed to deliver task-failure notice',
      );
    }
  } catch (bookkeepingErr) {
    logger.error(
      { taskId: task.id, err: bookkeepingErr },
      'Failed to record an unhandled task failure',
    );
  }
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const groupForFolder = (folder: string): RegisteredGroup | undefined =>
    Object.values(deps.registeredGroups()).find((g) => g.folder === folder);

  const loop = async () => {
    try {
      // A due task the queue already holds — waiting for the chat's slot or
      // running — stays due until its run ends. It is neither claimed nor
      // enqueued again: its lease is only pushed forward, every poll, so the
      // lease covers the whole wait and the whole run, and still expires one
      // TTL after the last renewal if this process dies.
      const dueTasks = getDueTasks().filter((task) => {
        if (!deps.queue.hasTask(task.chat_jid, task.id)) return true;
        renewTaskLease(
          task.id,
          Date.now(),
          computeLeaseTtlMs(groupForFolder(task.group_folder)),
        );
        return false;
      });
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Atomically claim the task at the DB layer before dispatch. This is
        // the persisted in-flight marker that the in-memory GroupQueue dedup
        // cannot provide across a restart: if the orchestrator crashed/redeployed
        // mid-run (or after the run but before next_run advanced), getDueTasks
        // re-selects this still-due task, but a live lease blocks a second
        // execution until it expires. It also guards against a second poll cycle
        // dispatching the same task within one process.
        //
        // Size the lease from the SAME run-time ceiling the runtime enforces for
        // this task's group (containerConfig.timeout / IDLE_TIMEOUT), not the
        // global CONTAINER_TIMEOUT, so a group with a larger per-group timeout
        // never has a still-running task re-claimed mid-run.
        const leaseTtlMs = computeLeaseTtlMs(
          groupForFolder(currentTask.group_folder),
        );
        if (!claimTaskForRun(currentTask.id, Date.now(), leaseTtlMs)) {
          logger.debug(
            { taskId: currentTask.id },
            'Task already claimed/in-flight or restart-gated; skipping dispatch',
          );
          continue;
        }

        // Release the lease once the run settles (success OR failure), so the
        // task is eligible again on its next scheduled occurrence. The .finally
        // covers every exit path inside runTask (early returns and throws).
        const accepted = deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          () => {
            const dispatchedAt = Date.now();
            // The real start, possibly long after the claim: a full TTL from
            // here even if no poll renews the lease during the run.
            renewTaskLease(currentTask.id, dispatchedAt, leaseTtlMs);
            return runTask(currentTask, deps)
              .catch((err) =>
                finalizeUnhandledTaskFailure(
                  currentTask,
                  deps,
                  err,
                  dispatchedAt,
                ),
              )
              .finally(() => releaseTaskLease(currentTask.id));
          },
        );
        // If the queue REFUSED the dispatch, the run closure — and therefore
        // its lease-releasing .finally — will never execute. Release the
        // just-claimed lease now so the task is not stuck unable to
        // re-dispatch until the lease TTL expires (finding #68). A task the
        // queue already holds never gets here (hasTask above): releasing
        // after such a duplicate drop is what left a running task without a

        if (!accepted) {
          releaseTaskLease(currentTask.id);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
  // Each test gets a fresh in-memory DB (_initTestDatabase), so the cached
  // "table already created" flag must reset or ensureLeaseTable() would skip
  // re-creating task_leases on the new connection.
  leaseTableReady = false;
}
