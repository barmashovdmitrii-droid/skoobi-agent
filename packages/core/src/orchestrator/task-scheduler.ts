import { ChildProcess, execFileSync } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { parseTelegramJid } from '@skoobi/shared/telegram-jid';

import {
  ASSISTANT_NAME,
  CONTAINER_TIMEOUT,
  DEFAULT_RUNTIME,
  IDLE_TIMEOUT,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
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
  getAllTasks,
  getDb,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { resolveResumeSessionId } from './transcript-rotation.js';
import { readEnvFile } from './env.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { agentConfigWithTenantInstructions } from './instructions.js';
import { logger } from './logger.js';
import {
  runtimePersistencePolicy,
  runtimeVisibleTasks,
  safeRuntimeSessionIdOrUndefined,
} from './runtime-namespace.js';
import { createModelGateway, loadModelGatewayConfig } from './model-gateway.js';
import { MessageRouter, RegisteredGroup, ScheduledTask } from './types.js';
import {
  registerTaskAuthorizationCapability,
  revokeTaskAuthorizationCapability,
} from './task-authorization.js';

export const TASK_ERROR_RETRY_DELAY_MS = 5 * 60 * 1000;
const CODEX_RESERVE_FALLBACK_TEXT =
  'Сейчас не получилось получить ответ через основной и резервный AI-путь. Попробуй ещё раз чуть позже.';

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
 * IDLE_TIMEOUT + 30s)` (see sandbox-runner.ts). A per-group containerConfig.timeout
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
 * run-time ceiling (`max(containerConfig.timeout ?? CONTAINER_TIMEOUT,
 * IDLE_TIMEOUT + 30s)` in sandbox-runner.ts) plus a fixed margin. Passing
 * `undefined`/no group falls back to the global TTL.
 */
export function computeLeaseTtlMs(group?: {
  containerConfig?: { timeout?: number };
}): number {
  const configTimeout = group?.containerConfig?.timeout || CONTAINER_TIMEOUT;
  const runtimeCeiling = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);
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
function buildCodexTaskInputConfig(): CodexRunnerInputConfig {
  const codex: Partial<
    NonNullable<ReturnType<typeof loadModelGatewayConfig>['codex']>
  > = loadModelGatewayConfig().codex ?? {};
  const timeoutRaw = Number.parseInt(
    process.env.SKOOBI_CODEX_RESERVE_TIMEOUT_MS || '',
    10,
  );
  return {
    command: resolveCodexCommandPath(codex.command || 'codex'),
    model: codex.model || 'gpt-5.6-sol',
    fallbackModel: codex.allowModelDowngrade ? codex.fallbackModel : undefined,
    reasoningEffort: codex.reasoningEffort || undefined,
    webSearchEnabled: codex.webSearchEnabled === true,
    timeoutMs:
      Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? timeoutRaw
        : DEFAULT_CODEX_TASK_TIMEOUT_MS,
  };
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

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    // Guard against a malformed schedule_value, mirroring the interval branch
    // below. IPC create/update validate cron, but a legacy row, a direct DB
    // edit, or the autonomous self-improver writing the DB can land an
    // unparseable expression here. computeNextRun runs in the post-run
    // bookkeeping path (computeNextRunAfterTaskAttempt at runTask), AFTER the
    // agent run + logTaskRun. An unguarded throw there would reject runTask
    // before updateTaskAfterRun advances next_run, so the still-due task is
    // re-selected and re-executed (with side effects) on every 60s poll — an
    // indefinite re-execution loop. On parse failure, return null so the task
    // completes once and stops recurring rather than spinning.
    try {
      const interval = CronExpressionParser.parse(task.schedule_value, {
        tz: TIMEZONE,
      });
      return interval.next().toISOString();
    } catch (err) {
      logger.warn(
        { taskId: task.id, value: task.schedule_value, err },
        'Invalid cron expression; completing task instead of recurring',
      );
      return null;
    }
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    //
    // Guard the null/invalid next_run case: getDueTasks() filters
    // next_run IS NOT NULL, but this function is exported and also
    // reachable via computeNextRunAfterTaskAttempt, so a legacy/manual/
    // programmatic interval row with a null or unparseable next_run can
    // reach here. Without this guard `new Date(null).getTime()` is 0 and
    // the while-loop below would step from the epoch to now in ms-sized
    // increments (~28M iterations for a 60s interval), stalling the
    // single-threaded scheduler for seconds.
    const base = task.next_run ? new Date(task.next_run).getTime() : now;
    if (Number.isNaN(base)) {
      logger.warn(
        { taskId: task.id, nextRun: task.next_run },
        'Interval task has missing/invalid next_run; anchoring to now',
      );
      return new Date(now + ms).toISOString();
    }
    // Compute the first grid-aligned slot strictly in the future in O(1)
    // rather than iterating, so a far-past anchor can never spin the loop.
    let next = base + ms;
    if (next <= now) {
      const missed = Math.ceil((now - base) / ms);
      next = base + missed * ms;
      if (next <= now) next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export function computeNextRunAfterTaskAttempt(
  task: ScheduledTask,
  hadError: boolean,
  now: number = Date.now(),
): string | null {
  if (hadError && task.schedule_type === 'once') {
    return new Date(now + TASK_ERROR_RETRY_DELAY_MS).toISOString();
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
  const ownerAuthorized =
    isMain &&
    task.creator_authorization === 'owner_sender' &&
    typeof task.creator_identity_id === 'string' &&
    task.creator_identity_id.length > 0 &&
    typeof task.creator_sender_id === 'string' &&
    task.creator_sender_id.length > 0;
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
  let codexReserveFallbackAttempted = false;
  let codexReserveFallbackDelivered = false;

  // Codex-primary scheduled tasks: same full sandbox agent, Codex CLI backend.
  // This route is restricted to host-proven owner-created tasks in main:
  // unproven/guest rows must not gain a more capable provider merely because
  // the process-wide switch is enabled. The container runtime has no codex
  // provider support (mirrors the guard in message-loop's runAgent).
  const runtime = group.runtime || DEFAULT_RUNTIME;
  const codexPrimary =
    isScheduledTasksCodexPrimary() && runtime === 'sandbox' && ownerAuthorized;

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

  const taskAuthorizationCapability = ownerSenderIdentity
    ? registerTaskAuthorizationCapability({
        groupFolder: task.group_folder,
        isMain,
        credentialProxyTier: 'owner',
        senderIdentity: ownerSenderIdentity,
        homogeneousOwnerBatch: true,
      }) || ''
    : '';

  try {
    const runAgent =
      runtime === 'sandbox' ? runSandboxAgent : runContainerAgent;
    if (codexPrimary) {
      logger.info(
        { taskId: task.id, group: task.group_folder },
        'Scheduled task running with Codex primary provider',
      );
    }
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
        assistantName: ASSISTANT_NAME,
        agentConfig: agentConfigWithTenantInstructions(group, {
          includeTenantInstructions:
            persistencePolicy.includeCanonicalInstructions,
        }),
        ...(codexPrimary
          ? {
              provider: 'codex_cli' as const,
              codex: buildCodexTaskInputConfig(),
            }
          : {}),
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          let textToSend = streamedOutput.result;
          if (isClaudeLimitText(streamedOutput.result)) {
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

          result = textToSend;
          await deps.router.route({
            chatJid: task.chat_jid,
            text: textToSend,
            triggerType: 'task-result',
            groupFolder: task.group_folder,
            meta: codexReserveFallbackDelivered
              ? { kind: 'codex_reserve_task_result' }
              : undefined,
          });
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
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  } finally {
    if (taskAuthorizationCapability) {
      revokeTaskAuthorizationCapability(taskAuthorizationCapability);
    }
  }

  const durationMs = Date.now() - startTime;

  // The agent may have self-cancelled this task during the run (e.g. a
  // self-polling task calling cancel_task on completion). That deletes the
  // scheduled_tasks row, so logTaskRun's INSERT into task_run_logs would hit a
  // foreign-key violation. Skip post-run bookkeeping if the task is gone.
  if (!getTaskById(task.id)) {
    logger.debug(
      { taskId: task.id },
      'Task self-deleted during run, skipping post-run bookkeeping',
    );
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

  // Belt-and-suspenders: schedule computation must NEVER throw out of the
  // post-run path. If it did (e.g. a malformed schedule value not caught
  // upstream), next_run would never advance, the task would stay due, and the
  // next poll would re-execute the full agent run on a loop. On any failure,
  // fall back to completing the task (next_run = null) so it stops recurring.
  let nextRun: string | null;
  try {
    nextRun = computeNextRunAfterTaskAttempt(task, Boolean(error));
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

  // A failed run that delivered no output is otherwise invisible outside the
  // logs (task_run_logs only) — the chat owner would never learn their
  // reminder died. Deliver a short failure notice; a notice-delivery failure
  // must not throw out of the post-run path.
  if (error && !result) {
    const promptPreview =
      task.prompt.length > 80 ? `${task.prompt.slice(0, 80)}…` : task.prompt;
    const noticeText = nextRun
      ? `⚠️ Запланированная задача не выполнилась: «${promptPreview}»\nОшибка: ${error.slice(0, 300)}\nПопробую снова по расписанию.`
      : `⚠️ Запланированная задача не выполнилась и остановлена: «${promptPreview}»\nОшибка: ${error.slice(0, 300)}`;
    try {
      await deps.router.route({
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

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
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
        const claimGroup = Object.values(deps.registeredGroups()).find(
          (g) => g.folder === currentTask.group_folder,
        );
        if (
          !claimTaskForRun(
            currentTask.id,
            Date.now(),
            computeLeaseTtlMs(claimGroup),
          )
        ) {
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
          () =>
            runTask(currentTask, deps).finally(() =>
              releaseTaskLease(currentTask.id),
            ),
        );
        // If the queue DROPPED the dispatch as a duplicate (same task already
        // running/pending), the run closure — and therefore its lease-releasing
        // .finally — will never execute. Release the just-claimed lease now so
        // the task is not stuck unable to re-dispatch until the lease TTL
        // expires (finding #68). The queue's own dedup still prevents a
        // double-run; this only frees the orphaned claim.
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
