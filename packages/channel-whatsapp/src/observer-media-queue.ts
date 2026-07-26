/**
 * A small, process-local scheduler for passive WhatsApp media enrichment.
 *
 * The queue deliberately knows nothing about messages, transcripts, paths, or
 * JIDs. Callers keep that data inside the job closure. Lifecycle events expose
 * only bounded operational metrics, so they are safe to pass to structured
 * logging without accidentally serialising observer content.
 */

export type ObserverMediaQueuePriority = 'notify' | 'append';

export interface ObserverMediaQueueJob {
  /**
   * Process-local deduplication key. It is retained only while the job is
   * active or waiting and is never included in lifecycle events.
   */
  key: string;
  /** Live notifications outrank passive history (`append`) work. */
  priority: ObserverMediaQueuePriority;
  /**
   * The closure owns all private job data. `close()` aborts the signal
   * cooperatively; a closure that ignores it may finish, but no next job starts.
   */
  run: (signal: AbortSignal) => Promise<void>;
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
  | 'rejected';

export interface ObserverMediaQueueSnapshot {
  /** Concurrency is intentionally fixed at one. */
  active: 0 | 1;
  waiting: number;
  waitingNotify: number;
  waitingAppend: number;
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
}

export interface ObserverMediaQueueOptions {
  /** Maximum number waiting behind the one active job. May be zero. */
  maxWaiting: number;
  onLifecycle?: (
    event: Readonly<ObserverMediaQueueLifecycleEvent>,
  ) => void | Promise<void>;
  /** Deterministic monotonic clock injection for tests. */
  now?: () => number;
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
}

interface ActiveJob {
  job: WaitingJob;
  controller: AbortController;
  startedAt: number;
}

const MAX_DEDUPE_KEY_CHARS = 1_024;
const MAX_CONFIGURED_WAITING = 10_000;

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
  private readonly maxWaiting: number;
  private readonly onLifecycle?: ObserverMediaQueueOptions['onLifecycle'];
  private readonly nowProvider: () => number;
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
  }

  snapshot(): ObserverMediaQueueSnapshot {
    return {
      active: this.activeJob ? 1 : 0,
      waiting: this.waitingCount(),
      waitingNotify: this.notifyWaiting.length,
      waitingAppend: this.appendWaiting.length,
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

  /** Resolves after both the active closure and all pending jobs are gone. */
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
    const cancelled = [
      ...this.notifyWaiting.splice(0),
      ...this.appendWaiting.splice(0),
    ];
    for (const job of cancelled) {
      this.knownKeys.delete(job.key);
      this.emitLifecycle({
        phase: 'cancelled',
        priority: job.priority,
        queueWaitMs: this.elapsedSince(job.enqueuedAt),
        cancellationReason: reason,
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
    try {
      if (active.controller.signal.aborted) {
        phase = 'cancelled';
      } else {
        await active.job.run(active.controller.signal);
        if (active.controller.signal.aborted) phase = 'cancelled';
      }
    } catch (error) {
      if (active.controller.signal.aborted) {
        phase = 'cancelled';
      } else {
        phase = 'failed';
        errorKind = safeErrorKind(error);
      }
    }

    this.knownKeys.delete(active.job.key);
    if (this.activeJob === active) this.activeJob = null;
    this.emitLifecycle({
      phase,
      priority: active.job.priority,
      durationMs: this.elapsedSince(active.startedAt),
      ...(phase === 'failed' ? { errorKind } : {}),
      ...(phase === 'cancelled'
        ? { cancellationReason: 'closed' as const }
        : {}),
    });

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
