/**
 * Group Queue — concurrency control for agent execution.
 *
 * Manages concurrent agent containers per group. Handles:
 * - Max concurrent containers limit
 * - Per-group message and task queuing
 * - Idle waiting and stdin piping
 * - Retry with exponential backoff
 * - Graceful shutdown
 */
import path from 'path';
import type { ChildProcess } from 'child_process';

import { MAX_CONCURRENT_CONTAINERS } from './config.js';
import { resolveGroupIpcPath } from './group-folder.js';
import {
  resolveExistingSafeIpcCategoryDirectory,
  writeFileAtomicNoFollowSync,
} from './ipc-paths.js';
import { logger } from './logger.js';
import { terminateProcessTree } from './process-tree.js';
import { registerDeferredInputSource } from './deferred-continuation.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
export const GROUP_QUEUE_FIRST_RETRY_DELAY_MS = 5_000;

interface GroupState {
  active: boolean;
  activeStartedAt: number | null;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
  staleSignaledAt: number | null;
  cancelRequested: boolean;
  // Last proof-of-life from the running agent (heartbeat frame, output frame,
  // IPC delivery). Staleness is measured from this, not from activeStartedAt,
  // so long-but-alive runs aren't killed when a new message arrives.
  lastRunActivityAt: number | null;
  // How many "still working" notices this run has already sent to the chat.
  longRunNoticesSent: number;
  // Когда пользователь ПОСЛЕДНИЙ раз что-то увидел от этого хода (промежуточная
  // реплика модели). Метка, а не флаг: пропущенная очистка не может залипнуть.
  lastUserVisibleOutputAt: number | null;
  // Старт текущего ХОДА раннера внутри run-а: раннер отвечает на сообщения,
  // пришедшие во время предыдущего хода, отдельным ходом (consumedFollowUps).
  // null — ход единственный, отсчёт от старта run-а.
  turnStartedAt: number | null;
  // An early turn restart resets the notice schedule.



  // Elapsed-time labels still use turnStartedAt, the first message time.
  turnRestartedAt: number | null;
  // The task run that last ended in this slot; cleared when a chat run takes
  // the slot. Tells the task-start notifier that the slot went from task to
  // task.
  lastTaskRun: GroupQueueTaskRun | null;
}

export interface GroupQueueStatus {
  active: boolean;
  activeForMs: number | null;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  groupFolder: string | null;
  containerName: string | null;
  retryCount: number;
  /**
   * The active run shows no sign of life for STALE_ACTIVE_MS. Read-only: the
   * next pipe/enqueue attempt is what signals it (see canPipeMessage).
   */
  stale?: boolean;
  /** «стоп» already asked this run to end; it is tearing down. */
  cancelRequested?: boolean;
}

/** What the «still working» notifier knows about the turn it talks about. */
export interface LongRunNoticeTurn {
  /** Start of the current turn: the label «уже N мин» counts from here. */
  turnStartedAt: number;
  /** When the user last saw anything from this turn; null — nothing yet. */
  lastUserVisibleOutputAt: number | null;
}

/** A scheduled task holding a chat's slot right now. */
export interface GroupQueueTaskRun {
  taskId: string;
  startedAt: number;
  /** Other scheduled tasks of this chat waiting for the slot behind it. */
  pendingTasks: number;
}

/** One run in flight, as the process heartbeat reports it (no JIDs). */
export interface GroupQueueActiveRun {
  groupFolder: string | null;
  startedAt: number;
  isTaskContainer: boolean;
}

export interface GroupQueueUnstickResult {
  active: boolean;
  signaled: boolean;
  activeForMs: number | null;
  groupFolder: string | null;
  containerName: string | null;
  pendingMessages: boolean;
}

export interface GroupQueueCancelResult {
  active: boolean;
  signaled: boolean;
  taskContainerProtected: boolean;
  activeForMs: number | null;
  groupFolder: string | null;
  containerName: string | null;
}

// If a group has been active for longer than this, treat it as wedged. The
// active flag is still released only by the original run's finally block, but
// we signal the whole process tree and keep pendingMessages set so the queue
// drains into a fresh runner after teardown.
const STALE_ACTIVE_MS = 10 * 60 * 1000; // 10 minutes
const STALE_SIGNAL_COOLDOWN_MS = 30 * 1000;

// Long turns send bounded progress notices: first after a minute, then every
// five minutes through minute 21, followed by ten-minute intervals.
const LONG_RUN_FIRST_NOTICE_MS = 60 * 1000;
const LONG_RUN_REPEAT_NOTICE_MS = 5 * 60 * 1000;
const LONG_RUN_FAST_NOTICES = 5;
const LONG_RUN_SLOW_REPEAT_NOTICE_MS = 10 * 60 * 1000;
const LONG_RUN_MAX_NOTICES = 12;
const LONG_RUN_TICK_MS = 15 * 1000;

/**
 * When the next «still working» notice is due, counted from the start of the
 * turn (or its supersede restart, or the model's last own message), given how
 * many were sent: 1, 6, 11, 16, 21 minutes, then 31, 41, … 91. Only the
 * schedule counts from that base; the «уже N мин» label always counts from
 * the start of the turn.
 */
export function longRunNoticeDueMs(noticesSent: number): number {
  if (noticesSent <= 0) return LONG_RUN_FIRST_NOTICE_MS;
  if (noticesSent < LONG_RUN_FAST_NOTICES) {
    return LONG_RUN_FIRST_NOTICE_MS + LONG_RUN_REPEAT_NOTICE_MS * noticesSent;
  }
  return (
    LONG_RUN_FIRST_NOTICE_MS +
    LONG_RUN_REPEAT_NOTICE_MS * (LONG_RUN_FAST_NOTICES - 1) +
    LONG_RUN_SLOW_REPEAT_NOTICE_MS * (noticesSent - LONG_RUN_FAST_NOTICES + 1)
  );
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  // Called once when a group's retry budget is exhausted, so the orchestrator
  // can tell the chat instead of giving up silently (the "Ау" bug: max
  // retries exceeded left the user with no reply and no explanation).
  private retriesExhaustedNotifier: ((groupJid: string) => void) | null = null;
  // Called on every scheduled retry (retryCount starts at 1), so the
  // orchestrator can signal life to the chat during the otherwise-silent
  // retry window: a slow provider run means minutes of no reply at all.
  private retryScheduledNotifier:
    | ((groupJid: string, retryCount: number) => void)
    | null = null;
  // Called while a run is still going, so the chat gets a sign of life instead
  // of minutes of silence. noticeIndex starts at 1.
  private longRunNotifier:
    | ((
        groupJid: string,
        elapsedMs: number,
        noticeIndex: number,
        turn: LongRunNoticeTurn,
      ) => void)
    | null = null;
  private longRunTimer: NodeJS.Timeout | null = null;
  // Called when a scheduled task takes the chat's slot while its messages
  // wait (pendingMessages). `previous` is the task run that held the slot
  // right before this one, when the slot went from task to task with no chat
  // run in between: whoever was told to wait for that task now waits longer.
  private taskRunStartNotifier:
    | ((
        groupJid: string,
        run: GroupQueueTaskRun,
        previous: GroupQueueTaskRun | null,
      ) => void)
    | null = null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        activeStartedAt: null,
        longRunNoticesSent: 0,
        lastUserVisibleOutputAt: null,
        turnStartedAt: null,
        turnRestartedAt: null,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
        staleSignaledAt: null,
        cancelRequested: false,
        lastRunActivityAt: null,
        lastTaskRun: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  private activeForMs(state: GroupState): number | null {
    return state.active && state.activeStartedAt
      ? Date.now() - state.activeStartedAt
      : null;
  }

  private isActiveStale(state: GroupState): boolean {
    if (!state.active || !state.activeStartedAt) return false;
    const lastLifeAt = Math.max(
      state.activeStartedAt,
      state.lastRunActivityAt ?? 0,
    );
    return Date.now() - lastLifeAt > STALE_ACTIVE_MS;
  }

  /**
   * Record proof-of-life from the running agent (heartbeat/output frame or
   * IPC delivery), of a chat turn or a scheduled task alike. Pushes the
   * stale-active deadline forward so an incoming message doesn't SIGTERM a
   * run that is slow but demonstrably working.
   */
  noteRunActivity(groupJid: string): void {
    const state = this.groups.get(groupJid);
    if (state?.active) {
      state.lastRunActivityAt = Date.now();
    }
  }

  private signalActiveRun(
    groupJid: string,
    state: GroupState,
    reason: string,
    force = false,
    graceMs?: number,
  ): boolean {
    if (!state.active) return false;

    const now = Date.now();
    if (
      !force &&
      state.staleSignaledAt &&
      now - state.staleSignaledAt < STALE_SIGNAL_COOLDOWN_MS
    ) {
      return false;
    }
    state.staleSignaledAt = now;

    logger.warn(
      {
        groupJid,
        reason,
        activeForMs: this.activeForMs(state),
        groupFolder: state.groupFolder,
        containerName: state.containerName,
        pid: state.process?.pid,
      },
      'Terminating active group process tree',
    );

    if (state.process) {
      terminateProcessTree(state.process, {
        graceMs,
        onEscalate: (pid) =>
          logger.error(
            { groupJid, pid, reason },
            'Active process ignored SIGTERM; escalating to SIGKILL',
          ),
      });
      return true;
    }

    // If the run has not registered a process yet, closing stdin may still
    // nudge a runner that is between setup and IPC polling.
    if (state.groupFolder) this.closeStdin(groupJid);
    return false;
  }

  forceUnstick(groupJid: string, reason = 'manual'): GroupQueueUnstickResult {
    const state = this.getGroup(groupJid);
    const activeForMs = this.activeForMs(state);
    if (!state.active) {
      return {
        active: false,
        signaled: false,
        activeForMs,
        groupFolder: state.groupFolder,
        containerName: state.containerName,
        pendingMessages: state.pendingMessages,
      };
    }

    state.pendingMessages = true;
    const signaled = this.signalActiveRun(groupJid, state, reason, true);
    return {
      active: true,
      signaled,
      activeForMs,
      groupFolder: state.groupFolder,
      containerName: state.containerName,
      pendingMessages: state.pendingMessages,
    };
  }

  cancelActiveChatRun(
    groupJid: string,
    reason = 'owner-stop',
  ): GroupQueueCancelResult {
    const state = this.getGroup(groupJid);
    const activeForMs = this.activeForMs(state);
    if (!state.active) {
      return {
        active: false,
        signaled: false,
        taskContainerProtected: false,
        activeForMs,
        groupFolder: state.groupFolder,
        containerName: state.containerName,
      };
    }
    if (state.isTaskContainer) {
      return {
        active: true,
        signaled: false,
        taskContainerProtected: true,
        activeForMs,
        groupFolder: state.groupFolder,
        containerName: state.containerName,
      };
    }

    state.cancelRequested = true;
    state.pendingMessages = false;
    const signaled = this.signalActiveRun(groupJid, state, reason, true, 1_000);
    return {
      active: true,
      signaled,
      taskContainerProtected: false,
      activeForMs,
      groupFolder: state.groupFolder,
      containerName: state.containerName,
    };
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  setRetriesExhaustedNotifier(fn: (groupJid: string) => void): void {
    this.retriesExhaustedNotifier = fn;
  }

  setRetryScheduledNotifier(
    fn: (groupJid: string, retryCount: number) => void,
  ): void {
    this.retryScheduledNotifier = fn;
  }

  setTaskRunStartNotifier(
    fn: (
      groupJid: string,
      run: GroupQueueTaskRun,
      previous: GroupQueueTaskRun | null,
    ) => void,
  ): void {
    this.taskRunStartNotifier = fn;
  }

  /**
   * The user stopped the run now in progress («стоп»). Stays true until the
   * run ends, so the message loop can tell a stop from a real failure.
   */
  isCancelRequested(groupJid: string): boolean {
    return this.groups.get(groupJid)?.cancelRequested === true;
  }

  /**
   * Ход показал пользователю живую реплику. Заглушка «Принял, работаю» после
   * этого избыточна, а отсчёт повторов идёт от реплики, а не от старта хода.
   */
  noteUserVisibleOutput(groupJid: string): void {
    const state = this.groups.get(groupJid);
    if (state) state.lastUserVisibleOutputAt = Date.now();
  }



  noteTurnAnswered(groupJid: string): void {
    const state = this.groups.get(groupJid);
    if (!state) return;
    const now = Date.now();
    state.lastUserVisibleOutputAt = now;
    state.longRunNoticesSent = 0;
    // Ход закончился ответом: всё, что раннер делает дальше, — уже другой ход,
    // и «уже N мин» считается от ответа, а не от начала прошлого хода.
    if (state.active) {
      state.turnStartedAt = now;
      state.turnRestartedAt = null;
    }
  }



  noteFollowUpTurnStarted(groupJid: string): void {
    const state = this.groups.get(groupJid);
    if (!state?.active) return;
    state.turnStartedAt = Date.now();
    state.turnRestartedAt = null;
    state.longRunNoticesSent = 0;
    state.lastUserVisibleOutputAt = null;
    state.idleWaiting = false;
  }



  noteTurnRestarted(groupJid: string): void {
    const state = this.groups.get(groupJid);
    if (!state?.active) return;
    state.turnRestartedAt = Date.now();
  }

  setLongRunNotifier(
    fn: (
      groupJid: string,
      elapsedMs: number,
      noticeIndex: number,
      turn: LongRunNoticeTurn,
    ) => void,
  ): void {
    this.longRunNotifier = fn;
  }

  /**
   * One shared ticker for every active group. Started when a run begins and
   * stopped when the last one ends, so an idle process keeps no timers; unref'd
   * so it never by itself holds the event loop open.
   */
  private startLongRunTicker(): void {
    if (this.longRunTimer || !this.longRunNotifier) return;
    this.longRunTimer = setInterval(() => {
      let anyActive = false;
      for (const [groupJid, state] of this.groups) {
        if (!state.active || !state.activeStartedAt) continue;
        anyActive = true;
        // Scheduled-task containers answer into their own task thread; a
        // "still working" ping there would be noise, not reassurance.
        if (state.isTaskContainer) continue;
        // Ход уже ответил и ждёт следующего сообщения: «ещё работаю» поверх

        if (state.idleWaiting) continue;
        if (state.longRunNoticesSent >= LONG_RUN_MAX_NOTICES) continue;
        // Если модель уже что-то сказала пользователю, первое «Принял,
        // работаю» лишнее, а отсчёт следующих идёт от её реплики.
        if (state.lastUserVisibleOutputAt && state.longRunNoticesSent === 0) {
          state.longRunNoticesSent = 1;
        }
        const turnStartedAt = state.turnStartedAt ?? state.activeStartedAt;
        // Расписание — от последнего, что человек видел (или от перезапуска
        // хода), а подпись «уже N мин» — от начала хода.


        const base = Math.max(
          turnStartedAt,
          state.turnRestartedAt ?? 0,
          state.lastUserVisibleOutputAt ?? 0,
        );
        const now = Date.now();
        if (now - base < longRunNoticeDueMs(state.longRunNoticesSent)) continue;
        state.longRunNoticesSent += 1;
        try {
          this.longRunNotifier?.(
            groupJid,
            now - turnStartedAt,
            state.longRunNoticesSent,
            {
              turnStartedAt,
              lastUserVisibleOutputAt: state.lastUserVisibleOutputAt,
            },
          );
        } catch (err) {
          logger.warn({ groupJid, err }, 'Long-run notifier threw');
        }
      }
      if (!anyActive) this.stopLongRunTicker();
    }, LONG_RUN_TICK_MS);
    this.longRunTimer.unref?.();
  }

  private stopLongRunTicker(): void {
    if (!this.longRunTimer) return;
    clearInterval(this.longRunTimer);
    this.longRunTimer = null;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;
    const state = this.getGroup(groupJid);

    if (state.active) {
      // A run past STALE_ACTIVE_MS looks wedged. Do NOT force-clear the shared
      // slot and fall through to a new run: that (1) starts a SECOND concurrent
      // container for the same group (breaks the one-container-per-group /
      // per-tenant isolation invariant) and (2) double-decrements activeCount —
      // the original run's `finally` is the single authoritative owner of
      // `activeCount--`, so clearing here makes the counter drift below the real
      // container count until MAX_CONCURRENT_CONTAINERS stops holding. Instead,
      // best-effort signal the stuck process so its own `finally` fires (releasing
      // the slot + draining the queued messages), and just mark pending.
      if (this.isActiveStale(state)) {
        this.signalActiveRun(groupJid, state, 'enqueue-message-check');
      }
      state.pendingMessages = true;
      // Раннер после ответа ещё 15 секунд ждёт, не подклеят ли ему следующее
      // сообщение (RUNNER_IDLE_WAIT_MS). Если сообщение пришло, но подклеить
      // его не удалось, досиживать этот хвост незачем — новое сообщение всё
      // равно поедет отдельным ходом, а слот группы занят. Ровно так уже
      // сделано для задач (enqueueTask ниже); порядок важен: сначала пайп,
      // потом закрытие, иначе сообщение потеряется.
      if (state.idleWaiting) this.closeStdin(groupJid);
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Error in runForGroup'),
    );
  }

  /**
   * Enqueue (or immediately dispatch) a task closure for a group.
   *
   * Returns `true` if the closure was accepted (dispatched now or queued to run
   * later), and `false` if it was DROPPED as a duplicate (same task already
   * running or already pending) or refused because the queue is shutting down.
   * The scheduler claims a per-task lease BEFORE calling this; the boolean lets
   * it release that lease on a dropped dispatch so the task isn't stuck unable
   * to re-dispatch until the lease TTL expires. The scheduler
   * asks hasTask() first and never enqueues a task the queue already holds, so
   * for it a false here means the queue is shutting down.
   */
  enqueueTask(
    groupJid: string,
    taskId: string,
    fn: () => Promise<void>,
  ): boolean {
    if (this.shuttingDown) return false;
    const state = this.getGroup(groupJid);

    if (this.hasTask(groupJid, taskId)) return false;

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) this.closeStdin(groupJid);
      return true;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      return true;
    }

    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Error in runTask'),
    );
    return true;
  }



  hasTask(groupJid: string, taskId: string): boolean {
    const state = this.groups.get(groupJid);
    if (!state) return false;
    return (
      state.runningTaskId === taskId ||
      state.pendingTasks.some((task) => task.id === taskId)
    );
  }

  /** The scheduled task holding this chat's slot right now, or null. */
  getActiveTaskRun(groupJid: string): GroupQueueTaskRun | null {
    const state = this.groups.get(groupJid);
    if (
      !state?.active ||
      !state.isTaskContainer ||
      !state.runningTaskId ||
      !state.activeStartedAt
    ) {
      return null;
    }
    return {
      taskId: state.runningTaskId,
      startedAt: state.activeStartedAt,
      pendingTasks: state.pendingTasks.length,
    };
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
    if (state.cancelRequested && !state.isTaskContainer) {
      this.signalActiveRun(
        groupJid,
        state,
        'owner-stop-after-process-registration',
        true,
        1_000,
      );
    }
  }

  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  canPipeMessage(groupJid: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer) {
      return false;
    }
    if (this.isActiveStale(state)) {
      state.pendingMessages = true;
      this.signalActiveRun(groupJid, state, 'pipe-check');
      return false;
    }
    return true;
  }

  getStatus(groupJid: string): GroupQueueStatus {
    const state = this.getGroup(groupJid);
    return {
      active: state.active,
      activeForMs: this.activeForMs(state),
      idleWaiting: state.idleWaiting,
      isTaskContainer: state.isTaskContainer,
      runningTaskId: state.runningTaskId,
      pendingMessages: state.pendingMessages,
      groupFolder: state.groupFolder,
      containerName: state.containerName,
      retryCount: state.retryCount,
      stale: this.isActiveStale(state),
      cancelRequested: state.cancelRequested,
    };
  }

  /**
   * Every run holding a slot right now, for the process heartbeat: the
   * deadman reads it to tell "still working on the answer" from "never
   * answered". A run learns its folder only when a process registers, and
   * live-model turns never register one, so the caller may pass a resolver
   * for the rest. The JID itself never leaves this method.
   */
  getActiveRunsSummary(
    resolveFolder?: (groupJid: string) => string | null | undefined,
  ): GroupQueueActiveRun[] {
    const runs: GroupQueueActiveRun[] = [];
    for (const [groupJid, state] of this.groups) {
      if (!state.active || !state.activeStartedAt) continue;
      let groupFolder = state.groupFolder;
      if (!groupFolder && resolveFolder) {
        try {
          groupFolder = resolveFolder(groupJid) || null;
        } catch {
          groupFolder = null;
        }
      }
      runs.push({
        groupFolder,
        startedAt: state.activeStartedAt,
        isTaskContainer: state.isTaskContainer,
      });
    }
    return runs;
  }

  sendMessage(
    groupJid: string,
    text: string,
    source?: { messageIds: string[]; ingestionCursors: string[] },
  ): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    if (this.isActiveStale(state)) {
      state.pendingMessages = true;
      this.signalActiveRun(groupJid, state, 'send-message');
      return false;
    }
    state.idleWaiting = false;

    try {
      const inputDir = resolveExistingSafeIpcCategoryDirectory(
        resolveGroupIpcPath(state.groupFolder),
        'input',
      );
      if (!inputDir) return false;
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      if (source) registerDeferredInputSource(groupJid, filename, source, {
        groupIpcDir: resolveGroupIpcPath(state.groupFolder),
      });
      writeFileAtomicNoFollowSync(
        filepath,
        JSON.stringify({ type: 'message', text,
          ...(source ? { hostSource: { chatJid: groupJid, ...source } } : {}),
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;
    try {
      const inputDir = resolveExistingSafeIpcCategoryDirectory(
        resolveGroupIpcPath(state.groupFolder),
        'input',
      );
      if (!inputDir) return;
      writeFileAtomicNoFollowSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.activeStartedAt = Date.now();
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    state.lastTaskRun = null;
    state.staleSignaledAt = null;
    state.cancelRequested = false;
    state.lastRunActivityAt = null;
    state.longRunNoticesSent = 0;
    state.lastUserVisibleOutputAt = null;
    state.turnStartedAt = null;
    state.turnRestartedAt = null;
    this.activeCount++;
    this.startLongRunTicker();

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (state.cancelRequested) {
          state.retryCount = 0;
        } else if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      if (state.cancelRequested) {
        state.retryCount = 0;
        logger.info({ groupJid }, 'Cancelled active chat run without retry');
      } else {
        logger.error({ groupJid, err }, 'Error processing messages');
        this.scheduleRetry(groupJid, state);
      }
    } finally {
      state.active = false;
      state.activeStartedAt = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.staleSignaledAt = null;
      state.cancelRequested = false;
      state.lastRunActivityAt = null;
      state.longRunNoticesSent = 0;
      state.lastUserVisibleOutputAt = null;
      state.turnStartedAt = null;
      state.turnRestartedAt = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    const startedAt = Date.now();
    state.active = true;
    state.activeStartedAt = startedAt;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    state.staleSignaledAt = null;
    state.cancelRequested = false;
    state.lastRunActivityAt = null;
    this.activeCount++;
    const previousTaskRun = state.lastTaskRun;
    state.lastTaskRun = null;
    if (state.pendingMessages && this.taskRunStartNotifier) {
      try {
        this.taskRunStartNotifier(
          groupJid,
          {
            taskId: task.id,
            startedAt,
            pendingTasks: state.pendingTasks.length,
          },
          previousTaskRun,
        );
      } catch (err) {
        logger.warn(
          { groupJid, taskId: task.id, err },
          'Task-start notifier threw; the task runs anyway',
        );
      }
    }

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.lastTaskRun = {
        taskId: task.id,
        startedAt,
        pendingTasks: state.pendingTasks.length,
      };
      state.active = false;
      state.activeStartedAt = null;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.staleSignaledAt = null;
      state.cancelRequested = false;
      state.lastRunActivityAt = null;
      state.longRunNoticesSent = 0;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error({ groupJid }, 'Max retries exceeded');
      state.retryCount = 0;
      if (this.retriesExhaustedNotifier) {
        try {
          this.retriesExhaustedNotifier(groupJid);
        } catch (err) {
          logger.warn(
            { groupJid, err },
            'Retries-exhausted notifier threw; giving up quietly',
          );
        }
      }
      return;
    }
    const delayMs =
      GROUP_QUEUE_FIRST_RETRY_DELAY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Retry scheduled',
    );
    if (this.retryScheduledNotifier) {
      try {
        this.retryScheduledNotifier(groupJid, state.retryCount);
      } catch (err) {
        logger.warn(
          { groupJid, err },
          'Retry-scheduled notifier threw; retry continues',
        );
      }
    }
    setTimeout(() => {
      if (!this.shuttingDown) this.enqueueMessageCheck(groupJid);
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;
    const state = this.getGroup(groupJid);

    const hasOwnWork = state.pendingTasks.length > 0 || state.pendingMessages;

    // Fairness: if other groups are waiting for a slot, do NOT let the just-
    // finished group greedily re-take the freed slot for its own pending work.
    // That path (the old `pendingTasks`/`pendingMessages` early-returns) never
    // reached drainWaiting, so a group that keeps feeding itself work starved
    // every waiting group indefinitely. Instead, requeue this group behind the
    // waiting ones and let drainWaiting() round-robin through all contenders.
    // drainWaiting handles both pendingTasks and pendingMessages, so the
    // requeued group's own work still runs — just in turn. activeCount stays
    // owned solely by runForGroup/runTask's finally, so the invariant holds.
    if (hasOwnWork && this.waitingGroups.length > 0) {
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      this.drainWaiting();
      return;
    }

    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error({ groupJid, taskId: task.id, err }, 'Error in drain task'),
      );
      return;
    }

    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error({ groupJid, err }, 'Error in drain messages'),
      );
      return;
    }

    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error({ groupJid: nextJid, err }, 'Error in waiting task'),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error({ groupJid: nextJid, err }, 'Error in waiting drain'),
        );
      }
    }
  }

  async shutdown(_gracePeriodMs: number = 10000): Promise<void> {
    this.shuttingDown = true;
    logger.info({ activeCount: this.activeCount }, 'GroupQueue shutting down');
  }
}
