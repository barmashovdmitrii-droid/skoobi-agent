/**
 * A small, process-local scheduler for passive WhatsApp media enrichment.
 *
 * The queue deliberately knows nothing about messages, transcripts, paths, or
 * JIDs. Callers keep that data inside the job closure. Lifecycle events expose
 * only bounded operational metrics, so they are safe to pass to structured
 * logging without accidentally serialising observer content.
 */

export type ObserverMediaQueuePriority = 'notify' | 'append';

/**
 * A closure resolves `'retry'` to ask for one deferred re-run (a transient
 * network failure while the live media URL is still fresh). The queue grants
 * it once per job; a second `'retry'` ends the job as failed.
 */
export type ObserverMediaQueueRunOutcome = 'retry' | void;

export interface ObserverMediaQueueJob {
  /**
   * Process-local deduplication key. It is retained only while the job is
   * active, waiting or waiting for its one retry, and is never included in
   * lifecycle events.
   */
  key: string;
  /** Live notifications outrank passive history (`append`) work. */
  priority: ObserverMediaQueuePriority;
  /**
   * The closure owns all private job data. `close()` aborts the signal
   * cooperatively; a closure that ignores it may finish, but no next job starts.
   */
  run: (signal: AbortSignal) => Promise<ObserverMediaQueueRunOutcome>;
}

export type ObserverMediaQueueRejectionReason =
  | 'closed'
  | 'duplicate'
  | 'full'
  | 'invalid';

export type ObserverMediaQueueCancellationReason = 'cleared' | 'closed';

export type ObserverMediaQueuePhase =
  | 'enqueued'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'retry_scheduled';

/** Surfaced as `errorKind` when a job asks for a retry a second time. */
export const OBSERVER_MEDIA_RETRY_EXHAUSTED = 'RetryExhausted';

export interface ObserverMediaQueueSnapshot {
  /** Concurrency is intentionally fixed at one. */
  active: 0 | 1;
  waiting: number;
  waitingNotify: number;
  waitingAppend: number;
  /** Jobs parked on their one retry timer; not part of `waiting`. */
  retrying: number;
  closed: boolean;
}

/**
 * Content-free lifecycle record suitable for operational metrics. In
 * particular, it intentionally omits the job key and every caller payload.
 */
export interface ObserverMediaQueueLifecycleEvent extends ObserverMediaQueueSnapshot {
  phase: ObserverMediaQueuePhase;
  priority: ObserverMediaQueuePriority;
  queueWaitMs?: number;
  durationMs?: number;
  rejectionReason?: ObserverMediaQueueRejectionReason;
  cancellationReason?: ObserverMediaQueueCancellationReason;
  /** Sanitised Error.name/typeof only; never the exception message or stack. */
  errorKind?: string;
  /** 0 for a first run, 1 for the one granted retry. */
  attempt?: number;
  /** Only with phase `retry_scheduled`. */
  retryDelayMs?: number;
}

export interface ObserverMediaQueueOptions {
  /** Maximum number waiting behind the one active job. May be zero. */
  maxWaiting: number;
  onLifecycle?: (
    event: Readonly<ObserverMediaQueueLifecycleEvent>,
  ) => void | Promise<void>;
  /** Deterministic monotonic clock injection for tests. */
  now?: () => number;
  /**
   * Delay before one retry: allow a flapping uplink to settle while the
   * WhatsApp media URL is still fresh.
   */
  retryDelayMs?: () => number;
}

export type ObserverMediaQueueEnqueueResult =
  | { accepted: true }
  | { accepted: false; reason: ObserverMediaQueueRejectionReason };

export interface ObserverMediaQueueCloseResult {
  cancelledPending: number;
  activeAbortRequested: boolean;
}

interface WaitingJob extends ObserverMediaQueueJob {
  enqueuedAt: number;
  attempt: number;
}

interface RetryTimer {
  job: WaitingJob;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveJob {
  job: WaitingJob;
  controller: AbortController;
  startedAt: number;
}

const MAX_DEDUPE_KEY_CHARS = 1_024;
const MAX_CONFIGURED_WAITING = 10_000;
const RETRY_MIN_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 60_000;
const MAX_RETRY_ATTEMPTS = 1;

function defaultRetryDelayMs(): number {
  return (
    RETRY_MIN_DELAY_MS +
    Math.floor(Math.random() * (RETRY_MAX_DELAY_MS - RETRY_MIN_DELAY_MS))
  );
}

function safeErrorKind(error: unknown): string {
  const raw = error instanceof Error ? error.name || 'Error' : typeof error;
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(raw) ? raw : 'Error';
}

function isValidJob(job: ObserverMediaQueueJob): boolean {
  return (
    (job.priority === 'notify' || job.priority === 'append') &&
    typeof job.key === 'string' &&
    job.key.trim().length > 0 &&
    job.key.length <= MAX_DEDUPE_KEY_CHARS &&
    typeof job.run === 'function'
  );
}

/**
 * Serial, bounded, priority-aware queue for observer media work.
 *
 * `enqueue()` is intentionally synchronous and never returns a job promise:
 * media failures therefore cannot reject the Baileys socket event handler.
 * Call `waitForIdle()` only from tests or explicit shutdown coordination.
 */
export class ObserverMediaQueue {
  private readonly notifyWaiting: WaitingJob[] = [];
  private readonly appendWaiting: WaitingJob[] = [];
  private readonly knownKeys = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly retryTimers = new Map<string, RetryTimer>();
  private readonly maxWaiting: number;
  private readonly onLifecycle?: ObserverMediaQueueOptions['onLifecycle'];
  private readonly nowProvider: () => number;
  private readonly retryDelayProvider: () => number;
  private activeJob: ActiveJob | null = null;
  private closed = false;

  constructor(options: ObserverMediaQueueOptions) {
    if (
      !Number.isSafeInteger(options.maxWaiting) ||
      options.maxWaiting < 0 ||
      options.maxWaiting > MAX_CONFIGURED_WAITING
    ) {
      throw new RangeError(
        `maxWaiting must be an integer between 0 and ${MAX_CONFIGURED_WAITING}`,
      );
    }
    this.maxWaiting = options.maxWaiting;
    this.onLifecycle = options.onLifecycle;
    this.nowProvider = options.now ?? Date.now;
    this.retryDelayProvider = options.retryDelayMs ?? defaultRetryDelayMs;
  }

  snapshot(): ObserverMediaQueueSnapshot {
    return {
      active: this.activeJob ? 1 : 0,
      waiting: this.waitingCount(),
      waitingNotify: this.notifyWaiting.length,
      waitingAppend: this.appendWaiting.length,
      retrying: this.retryTimers.size,
      closed: this.closed,
    };
  }

  enqueue(job: ObserverMediaQueueJob): ObserverMediaQueueEnqueueResult {
    if (!isValidJob(job)) {
      return { accepted: false, reason: 'invalid' };
    }
    if (this.closed) {
      this.emitLifecycle({
        phase: 'rejected',
        priority: job.priority,
        rejectionReason: 'closed',
      });
      return { accepted: false, reason: 'closed' };
    }
    if (this.knownKeys.has(job.key)) {
      this.emitLifecycle({
        phase: 'rejected',
        priority: job.priority,
        rejectionReason: 'duplicate',
      });
      return { accepted: false, reason: 'duplicate' };
    }

    // With an idle worker and no pre-existing waiter, this job starts
    // immediately and does not consume the waiting budget. Re-entrant calls
    // from lifecycle callbacks still see an existing waiter and are bounded.
    const willWait = this.activeJob !== null || this.waitingCount() > 0;
    if (willWait && this.waitingCount() >= this.maxWaiting) {
      this.emitLifecycle({
        phase: 'rejected',
        priority: job.priority,
        rejectionReason: 'full',
      });
      return { accepted: false, reason: 'full' };
    }

    const waiting: WaitingJob = {
      ...job,
      enqueuedAt: this.now(),
      attempt: 0,
    };
    this.knownKeys.add(waiting.key);
    this.waitingQueue(waiting.priority).push(waiting);
    this.emitLifecycle({ phase: 'enqueued', priority: waiting.priority });
    this.startNext();
    return { accepted: true };
  }

  /** Cancel queued work while leaving the queue reusable. */
  clearPending(): number {
    return this.cancelWaiting('cleared');
  }

  /**
   * Permanently close the queue, clear pending work, and cooperatively abort
   * the active closure. Repeated calls are harmless.
   */
  close(): ObserverMediaQueueCloseResult {
    if (this.closed) {
      return { cancelledPending: 0, activeAbortRequested: false };
    }
    this.closed = true;
    const cancelledPending = this.cancelWaiting('closed');
    const activeAbortRequested = Boolean(
      this.activeJob && !this.activeJob.controller.signal.aborted,
    );
    if (activeAbortRequested) this.activeJob?.controller.abort();
    this.resolveIdleWaitersIfIdle();
    return { cancelledPending, activeAbortRequested };
  }

  /**
   * Resolves after both the active closure and all pending jobs are gone. A
   * job parked on its retry timer does not count: it holds no worker and no
   * waiting slot, and `close()` cancels it.
   */
  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  private waitingQueue(priority: ObserverMediaQueuePriority): WaitingJob[] {
    return priority === 'notify' ? this.notifyWaiting : this.appendWaiting;
  }

  private waitingCount(): number {
    return this.notifyWaiting.length + this.appendWaiting.length;
  }

  private isIdle(): boolean {
    return this.activeJob === null && this.waitingCount() === 0;
  }

  private now(): number {
    try {
      const value = this.nowProvider();
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  private elapsedSince(startedAt: number): number {
    return Math.max(0, this.now() - startedAt);
  }

  private retryDelayMs(): number {
    try {
      const value = Math.floor(Number(this.retryDelayProvider()));
      return Number.isFinite(value) && value >= 0
        ? Math.min(value, RETRY_MAX_DELAY_MS)
        : defaultRetryDelayMs();
    } catch {
      return defaultRetryDelayMs();
    }
  }

  /** Park the finished job on its one retry timer; its key stays reserved. */
  private scheduleRetry(active: ActiveJob): void {
    const delayMs = this.retryDelayMs();
    const retryJob: WaitingJob = {
      ...active.job,
      attempt: active.job.attempt + 1,
      enqueuedAt: this.now(),
    };
    const timer = setTimeout(() => {
      this.retryTimers.delete(retryJob.key);
      if (this.closed) {
        this.knownKeys.delete(retryJob.key);
        return;
      }
      // The retry re-enters the ordinary waiting set and keeps its priority;
      // it bypasses `maxWaiting` because it never left the queue's budget.
      retryJob.enqueuedAt = this.now();
      this.waitingQueue(retryJob.priority).push(retryJob);
      this.emitLifecycle({
        phase: 'enqueued',
        priority: retryJob.priority,
        attempt: retryJob.attempt,
      });
      this.startNext();
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(retryJob.key, { job: retryJob, timer });
    this.emitLifecycle({
      phase: 'retry_scheduled',
      priority: retryJob.priority,
      attempt: retryJob.attempt,
      retryDelayMs: delayMs,
      durationMs: this.elapsedSince(active.startedAt),
    });
  }

  private emitLifecycle(
    event: Pick<
      ObserverMediaQueueLifecycleEvent,
      | 'phase'
      | 'priority'
      | 'queueWaitMs'
      | 'durationMs'
      | 'rejectionReason'
      | 'cancellationReason'
      | 'errorKind'
      | 'attempt'
      | 'retryDelayMs'
    >,
  ): void {
    if (!this.onLifecycle) return;
    const record = Object.freeze({ ...this.snapshot(), ...event });
    try {
      const callbackResult = this.onLifecycle(record);
      // An async metrics sink must not create an unhandled rejection either.
      void Promise.resolve(callbackResult).catch(() => undefined);
    } catch {
      // Metrics are deliberately best-effort and never affect socket intake.
    }
  }

  private cancelWaiting(reason: ObserverMediaQueueCancellationReason): number {
    const parkedRetries = [...this.retryTimers.values()];
    for (const parked of parkedRetries) clearTimeout(parked.timer);
    this.retryTimers.clear();
    const cancelled = [
      ...this.notifyWaiting.splice(0),
      ...this.appendWaiting.splice(0),
      ...parkedRetries.map((parked) => parked.job),
    ];
    for (const job of cancelled) {
      this.knownKeys.delete(job.key);
      this.emitLifecycle({
        phase: 'cancelled',
        priority: job.priority,
        queueWaitMs: this.elapsedSince(job.enqueuedAt),
        cancellationReason: reason,
        attempt: job.attempt,
      });
    }
    this.resolveIdleWaitersIfIdle();
    return cancelled.length;
  }

  private startNext(): void {
    if (this.closed || this.activeJob) {
      this.resolveIdleWaitersIfIdle();
      return;
    }
    const job = this.notifyWaiting.shift() ?? this.appendWaiting.shift();
    if (!job) {
      this.resolveIdleWaitersIfIdle();
      return;
    }

    const active: ActiveJob = {
      job,
      controller: new AbortController(),
      startedAt: this.now(),
    };
    this.activeJob = active;
    this.emitLifecycle({
      phase: 'started',
      priority: job.priority,
      queueWaitMs: Math.max(0, active.startedAt - job.enqueuedAt),
      attempt: job.attempt,
    });
    // executeActive catches every closure error and deliberately never rejects.
    void this.executeActive(active);
  }

  private async executeActive(active: ActiveJob): Promise<void> {
    let phase: Extract<
      ObserverMediaQueuePhase,
      'succeeded' | 'failed' | 'cancelled'
    > = 'succeeded';
    let errorKind: string | undefined;
    let retryRequested = false;
    try {
      if (active.controller.signal.aborted) {
        phase = 'cancelled';
      } else {
        const outcome = await active.job.run(active.controller.signal);
        if (active.controller.signal.aborted) {
          phase = 'cancelled';
        } else if (outcome === 'retry') {
          if (active.job.attempt < MAX_RETRY_ATTEMPTS && !this.closed) {
            retryRequested = true;
          } else {
            phase = 'failed';
            errorKind = OBSERVER_MEDIA_RETRY_EXHAUSTED;
          }
        }
      }
    } catch (error) {
      if (active.controller.signal.aborted) {
        phase = 'cancelled';
      } else {
        phase = 'failed';
        errorKind = safeErrorKind(error);
      }
    }

    if (this.activeJob === active) this.activeJob = null;
    if (retryRequested) {
      this.scheduleRetry(active);
    } else {
      this.knownKeys.delete(active.job.key);
      this.emitLifecycle({
        phase,
        priority: active.job.priority,
        durationMs: this.elapsedSince(active.startedAt),
        attempt: active.job.attempt,
        ...(phase === 'failed' ? { errorKind } : {}),
        ...(phase === 'cancelled'
          ? { cancellationReason: 'closed' as const }
          : {}),
      });
    }

    if (!this.closed) this.startNext();
    this.resolveIdleWaitersIfIdle();
  }

  private resolveIdleWaitersIfIdle(): void {
    if (!this.isIdle()) return;
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}
