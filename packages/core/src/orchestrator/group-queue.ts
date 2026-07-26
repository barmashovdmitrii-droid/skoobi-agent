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
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        activeStartedAt: null,
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
   * IPC delivery). Pushes the stale-active deadline forward so an incoming
   * message doesn't SIGTERM a run that is slow but demonstrably working.
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
   * to re-dispatch until the lease TTL expires (finding #68).
   */
  enqueueTask(
    groupJid: string,
    taskId: string,
    fn: () => Promise<void>,
  ): boolean {
    if (this.shuttingDown) return false;
    const state = this.getGroup(groupJid);

    if (state.runningTaskId === taskId) return false;
    if (state.pendingTasks.some((t) => t.id === taskId)) return false;

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
    };
  }

  sendMessage(groupJid: string, text: string): boolean {
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
      writeFileAtomicNoFollowSync(
        filepath,
        JSON.stringify({ type: 'message', text }),
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
    state.staleSignaledAt = null;
    state.cancelRequested = false;
    state.lastRunActivityAt = null;
    this.activeCount++;

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
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.activeStartedAt = Date.now();
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    state.staleSignaledAt = null;
    state.cancelRequested = false;
    state.lastRunActivityAt = null;
    this.activeCount++;

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
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
