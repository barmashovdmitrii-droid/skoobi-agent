import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';
import { terminateProcessTree } from './process-tree.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/claudeclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

vi.mock('./process-tree.js', () => ({
  terminateProcessTree: vi.fn(),
}));

const { mockResolveIpcCategory, mockWriteAtomic } = vi.hoisted(() => ({
  mockResolveIpcCategory: vi.fn(
    (root: string, category: string) => `${root}/${category}`,
  ),
  mockWriteAtomic: vi.fn(),
}));
vi.mock('./ipc-paths.js', () => ({
  resolveExistingSafeIpcCategoryDirectory: mockResolveIpcCategory,
  writeFileAtomicNoFollowSync: mockWriteAtomic,
}));

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(terminateProcessTree).mockClear();
    mockResolveIpcCategory.mockClear();
    mockWriteAtomic.mockClear();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Task should have run before the second message check
    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('task'); // task runs first in drain
    // Messages would run after task completes
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Retry-scheduled notifier ---

  it('calls the retry-scheduled notifier with the retry count, resetting after success', async () => {
    let failuresLeft = 2;
    const processMessages = vi.fn(async () => {
      if (failuresLeft > 0) {
        failuresLeft--;
        return false;
      }
      return true;
    });
    const notified: number[] = [];

    queue.setProcessMessagesFn(processMessages);
    queue.setRetryScheduledNotifier((groupJid, retryCount) => {
      expect(groupJid).toBe('group1@g.us');
      notified.push(retryCount);
    });

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(5010); // retry 1
    await vi.advanceTimersByTimeAsync(10010); // retry 2 → success
    expect(notified).toEqual([1, 2]);

    // Success reset the retry counter: a fresh failure notifies with 1 again.
    failuresLeft = 1;
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(5010);
    expect(notified).toEqual([1, 2, 1]);
  });

  it('keeps retrying when the retry-scheduled notifier throws', async () => {
    let callCount = 0;
    const processMessages = vi.fn(async () => {
      callCount++;
      return callCount >= 2;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.setRetryScheduledNotifier(() => {
      throw new Error('notifier boom');
    });

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5010);
    expect(callCount).toBe(2);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown();

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Waiting groups are not starved by a self-feeding active group ---

  it('does not starve waiting groups when a finishing group has its own pending work', async () => {
    const processed: string[] = [];
    // Per-group resolvers so we can release exactly one group's run.
    const resolvers = new Map<string, () => void>();

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => {
        resolvers.set(groupJid, resolve);
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots (MAX_CONCURRENT_CONTAINERS = 2).
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // A third group arrives while slots are full -> it waits.
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // group1 receives a follow-up message WHILE it is still active. This only
    // sets pendingMessages on group1 (it does not enter waitingGroups). With the
    // starvation bug, group1's drainGroup takes the pendingMessages branch and
    // re-runs itself, re-consuming the freed slot and never reaching the waiting
    // group3.
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // group1 finishes its first run, freeing exactly one slot.
    resolvers.get('group1@g.us')!();
    await vi.advanceTimersByTimeAsync(10);

    // The freed slot must go to the long-waiting group3 first, not back to the
    // self-feeding group1. (Before the fix, group3 is starved here.)
    expect(processed).toContain('group3@g.us');

    // group1's pending follow-up is not dropped — it still runs once the next
    // slot frees up (fairness, not cancellation).
    resolvers.get('group2@g.us')!();
    await vi.advanceTimersByTimeAsync(10);
    expect(processed.filter((g) => g === 'group1@g.us')).toHaveLength(2);
  });

  // --- Running task dedup (Issue #138) ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task (runs immediately — slot available)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate was NOT queued
    expect(dupFn).not.toHaveBeenCalled();

    // Complete the original task
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    // Only one execution total
    expect(taskCallCount).toBe(1);
  });

  // --- Idle preemption ---

  it('does NOT preempt active container when not idle', async () => {
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process so closeStdin has a groupFolder
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // Enqueue a task while container is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close should NOT have been written (container is working, not idle)
    const closeWrites = mockWriteAtomic.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle container when task is enqueued', async () => {
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and mark idle
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );
    queue.notifyIdle('group1@g.us');

    // Clear previous writes, then enqueue a task
    mockWriteAtomic.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close SHOULD have been written (container is idle)
    const closeWrites = mockWriteAtomic.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // Container becomes idle
    queue.notifyIdle('group1@g.us');

    // A new user message arrives — resets idleWaiting
    expect(queue.sendMessage('group1@g.us', 'hello')).toBe(true);
    expect(mockWriteAtomic).toHaveBeenCalledWith(
      expect.stringMatching(/\/input\/\d+-[a-z0-9]+\.json$/),
      JSON.stringify({ type: 'message', text: 'hello' }),
    );

    // Task enqueued after message reset — should NOT preempt (agent is working)
    mockWriteAtomic.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const closeWrites = mockWriteAtomic.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage returns false for task containers so user messages queue up', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (sets isTaskContainer = true)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // sendMessage should return false — user messages must not go to task containers
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('does not pipe into a stale active run and terminates the process tree', async () => {
    let resolveProcess: () => void;
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const proc = { pid: 12345, kill: vi.fn() } as any;
    queue.registerProcess('group1@g.us', proc, 'container-1', 'test-group');

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);

    expect(queue.canPipeMessage('group1@g.us')).toBe(false);
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
    expect(terminateProcessTree).toHaveBeenCalledWith(
      proc,
      expect.objectContaining({ onEscalate: expect.any(Function) }),
    );

    const status = queue.getStatus('group1@g.us');
    expect(status.pendingMessages).toBe(true);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage refuses a stale active run and leaves work pending for retry', async () => {
    let resolveProcess: () => void;
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const proc = { pid: 12345, kill: vi.fn() } as any;
    queue.registerProcess('group1@g.us', proc, 'container-1', 'test-group');

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);

    expect(queue.sendMessage('group1@g.us', 'hello')).toBe(false);
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
    expect(queue.getStatus('group1@g.us').pendingMessages).toBe(true);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('forceUnstick signals the active process and marks messages pending', async () => {
    let resolveProcess: () => void;
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const proc = { pid: 12345, kill: vi.fn() } as any;
    queue.registerProcess('group1@g.us', proc, 'container-1', 'test-group');

    const result = queue.forceUnstick('group1@g.us', 'test');

    expect(result).toEqual(
      expect.objectContaining({
        active: true,
        signaled: true,
        groupFolder: 'test-group',
        containerName: 'container-1',
        pendingMessages: true,
      }),
    );
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
    expect(queue.getStatus('group1@g.us').pendingMessages).toBe(true);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('cancels an active chat run immediately and suppresses its retry', async () => {
    let rejectProcess: (error: Error) => void;
    const processMessages = vi.fn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectProcess = reject;
        }),
    );
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    const proc = { pid: 12345, kill: vi.fn() } as any;
    queue.registerProcess('group1@g.us', proc, 'container-1', 'test-group');

    const result = queue.cancelActiveChatRun('group1@g.us', 'owner-stop');
    expect(result).toMatchObject({
      active: true,
      signaled: true,
      taskContainerProtected: false,
    });
    expect(terminateProcessTree).toHaveBeenCalledWith(
      proc,
      expect.objectContaining({ graceMs: 1_000 }),
    );

    rejectProcess!(new Error('terminated'));
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(processMessages).toHaveBeenCalledTimes(1);
    expect(queue.getStatus('group1@g.us').retryCount).toBe(0);
  });

  it('kills a process that registers after the owner already requested stop', async () => {
    let resolveProcess: () => void;
    queue.setProcessMessagesFn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProcess = () => resolve(true);
        }),
    );
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.cancelActiveChatRun('group1@g.us').signaled).toBe(false);

    const proc = { pid: 12345, kill: vi.fn() } as any;
    queue.registerProcess('group1@g.us', proc, 'container-1', 'test-group');
    expect(terminateProcessTree).toHaveBeenCalledWith(
      proc,
      expect.objectContaining({ graceMs: 1_000 }),
    );
    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('does not kill a scheduled task container for a chat stop command', async () => {
    let resolveTask: () => void;
    queue.enqueueTask(
      'group1@g.us',
      'scheduled-1',
      () =>
        new Promise<void>((resolve) => {
          resolveTask = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(10);
    const proc = { pid: 12345, kill: vi.fn() } as any;
    queue.registerProcess('group1@g.us', proc, 'task-container', 'test-group');

    expect(queue.cancelActiveChatRun('group1@g.us')).toMatchObject({
      active: true,
      signaled: false,
      taskContainerProtected: true,
    });
    expect(terminateProcessTree).not.toHaveBeenCalled();
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts when idle arrives with pending tasks', async () => {
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and enqueue a task (no idle yet — no preemption)
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    mockWriteAtomic.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    let closeWrites = mockWriteAtomic.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Now container becomes idle — should preempt because task is pending
    mockWriteAtomic.mockClear();
    queue.notifyIdle('group1@g.us');

    closeWrites = mockWriteAtomic.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });
});
