import { describe, expect, it, vi } from 'vitest';

import {
  ObserverMediaQueue,
  type ObserverMediaQueueLifecycleEvent,
} from './observer-media-queue.js';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ObserverMediaQueue', () => {
  it('runs one job at a time and prioritises notify over waiting append jobs', async () => {
    const queue = new ObserverMediaQueue({ maxWaiting: 4 });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];

    expect(
      queue.enqueue({
        key: 'append-running',
        priority: 'append',
        run: async () => {
          order.push('append-running');
          firstStarted.resolve();
          await releaseFirst.promise;
        },
      }),
    ).toEqual({ accepted: true });
    await firstStarted.promise;

    queue.enqueue({
      key: 'append-waiting',
      priority: 'append',
      run: async () => {
        order.push('append-waiting');
      },
    });
    queue.enqueue({
      key: 'notify-one',
      priority: 'notify',
      run: async () => {
        order.push('notify-one');
      },
    });
    queue.enqueue({
      key: 'notify-two',
      priority: 'notify',
      run: async () => {
        order.push('notify-two');
      },
    });

    expect(queue.snapshot()).toMatchObject({
      active: 1,
      waiting: 3,
      waitingNotify: 2,
      waitingAppend: 1,
    });
    releaseFirst.resolve();
    await queue.waitForIdle();

    expect(order).toEqual([
      'append-running',
      'notify-one',
      'notify-two',
      'append-waiting',
    ]);
  });

  it('deduplicates active and waiting keys but releases keys after completion', async () => {
    const queue = new ObserverMediaQueue({ maxWaiting: 2 });
    const release = deferred();
    const run = vi.fn(async () => release.promise);

    expect(queue.enqueue({ key: 'same', priority: 'notify', run })).toEqual({
      accepted: true,
    });
    expect(queue.enqueue({ key: 'same', priority: 'append', run })).toEqual({
      accepted: false,
      reason: 'duplicate',
    });
    expect(
      queue.enqueue({
        key: 'waiting',
        priority: 'append',
        run: async () => {},
      }),
    ).toEqual({ accepted: true });
    expect(
      queue.enqueue({
        key: 'waiting',
        priority: 'notify',
        run: async () => {},
      }),
    ).toEqual({ accepted: false, reason: 'duplicate' });

    release.resolve();
    await queue.waitForIdle();
    expect(
      queue.enqueue({ key: 'same', priority: 'notify', run: async () => {} }),
    ).toEqual({ accepted: true });
    await queue.waitForIdle();
  });

  it('bounds only the waiting set in addition to the active job', async () => {
    const queue = new ObserverMediaQueue({ maxWaiting: 2 });
    const release = deferred();

    queue.enqueue({
      key: 'active',
      priority: 'notify',
      run: async () => release.promise,
    });
    expect(
      queue.enqueue({
        key: 'waiting-1',
        priority: 'append',
        run: async () => {},
      }),
    ).toEqual({ accepted: true });
    expect(
      queue.enqueue({
        key: 'waiting-2',
        priority: 'notify',
        run: async () => {},
      }),
    ).toEqual({ accepted: true });
    expect(
      queue.enqueue({
        key: 'overflow',
        priority: 'notify',
        run: async () => {},
      }),
    ).toEqual({ accepted: false, reason: 'full' });

    release.resolve();
    await queue.waitForIdle();
  });

  it('clears pending jobs without cancelling the active job and stays reusable', async () => {
    const events: ObserverMediaQueueLifecycleEvent[] = [];
    const queue = new ObserverMediaQueue({
      maxWaiting: 3,
      onLifecycle: (event) => {
        events.push(event);
      },
    });
    const release = deferred();
    const pendingRun = vi.fn(async () => {});

    queue.enqueue({
      key: 'active',
      priority: 'notify',
      run: async () => release.promise,
    });
    queue.enqueue({ key: 'pending-live', priority: 'notify', run: pendingRun });
    queue.enqueue({
      key: 'pending-history',
      priority: 'append',
      run: pendingRun,
    });

    expect(queue.clearPending()).toBe(2);
    expect(queue.snapshot()).toMatchObject({ active: 1, waiting: 0 });
    release.resolve();
    await queue.waitForIdle();
    expect(pendingRun).not.toHaveBeenCalled();
    expect(
      events.filter(
        (event) =>
          event.phase === 'cancelled' && event.cancellationReason === 'cleared',
      ),
    ).toHaveLength(2);

    expect(
      queue.enqueue({
        key: 'after-clear',
        priority: 'notify',
        run: async () => {},
      }),
    ).toEqual({ accepted: true });
    await queue.waitForIdle();
  });

  it('closes idempotently, clears pending work, and aborts the active signal', async () => {
    const events: ObserverMediaQueueLifecycleEvent[] = [];
    const queue = new ObserverMediaQueue({
      maxWaiting: 2,
      onLifecycle: (event) => {
        events.push(event);
      },
    });
    const activeStarted = deferred();
    const pendingRun = vi.fn(async () => {});

    queue.enqueue({
      key: 'active',
      priority: 'append',
      run: async (signal) => {
        activeStarted.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    await activeStarted.promise;
    queue.enqueue({ key: 'pending', priority: 'notify', run: pendingRun });

    expect(queue.close()).toEqual({
      cancelledPending: 1,
      activeAbortRequested: true,
    });
    expect(queue.close()).toEqual({
      cancelledPending: 0,
      activeAbortRequested: false,
    });
    expect(
      queue.enqueue({
        key: 'after-close',
        priority: 'notify',
        run: async () => {},
      }),
    ).toEqual({ accepted: false, reason: 'closed' });
    await queue.waitForIdle();

    expect(pendingRun).not.toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'cancelled',
          priority: 'append',
          cancellationReason: 'closed',
        }),
        expect.objectContaining({
          phase: 'cancelled',
          priority: 'notify',
          cancellationReason: 'closed',
        }),
      ]),
    );
    expect(queue.snapshot()).toEqual({
      active: 0,
      waiting: 0,
      waitingNotify: 0,
      waitingAppend: 0,
      closed: true,
    });
  });

  it('contains synchronous job errors and callback rejections without poisoning later work', async () => {
    const events: ObserverMediaQueueLifecycleEvent[] = [];
    const successfulRun = vi.fn(async () => {});
    const queue = new ObserverMediaQueue({
      maxWaiting: 2,
      onLifecycle: async (event) => {
        events.push(event);
        if (event.phase === 'failed') {
          throw new Error('metrics sink unavailable');
        }
      },
    });

    expect(() =>
      queue.enqueue({
        key: 'failing-private-key',
        priority: 'notify',
        run: () => {
          throw new Error('private transcript and path');
        },
      }),
    ).not.toThrow();
    expect(
      queue.enqueue({ key: 'next', priority: 'append', run: successfulRun }),
    ).toEqual({ accepted: true });

    await queue.waitForIdle();
    expect(successfulRun).toHaveBeenCalledOnce();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'failed',
          errorKind: 'Error',
        }),
        expect.objectContaining({ phase: 'succeeded', priority: 'append' }),
      ]),
    );
    const serialisedEvents = JSON.stringify(events);
    expect(serialisedEvents).not.toContain('failing-private-key');
    expect(serialisedEvents).not.toContain('private transcript');
    expect(serialisedEvents).not.toContain('metrics sink');
  });

  it('rejects malformed jobs without invoking them or throwing', async () => {
    const queue = new ObserverMediaQueue({ maxWaiting: 1 });
    const run = vi.fn(async () => {});

    expect(queue.enqueue({ key: '   ', priority: 'notify', run })).toEqual({
      accepted: false,
      reason: 'invalid',
    });
    expect(run).not.toHaveBeenCalled();
    await expect(queue.waitForIdle()).resolves.toBeUndefined();
  });
});
