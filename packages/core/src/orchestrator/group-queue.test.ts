import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue, longRunNoticeDueMs } from './group-queue.js';
import { terminateProcessTree } from './process-tree.js';
import { registerDeferredInputSource } from './deferred-continuation.js';

vi.mock('./deferred-continuation.js', () => ({registerDeferredInputSource:vi.fn()}));

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
    vi.mocked(registerDeferredInputSource).mockReset();
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

  it('pipes exact host input identities separately from formatted model text', async () => {
    let finish!: () => void;
    queue.setProcessMessagesFn(async () => { await new Promise<void>(resolve => { finish=resolve; }); return true; });
    queue.enqueueMessageCheck('tg:owner');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess('tg:owner', {} as any, 'run', 'test-group');
    expect(queue.sendMessage('tg:owner', '<message>Company A</message>', {
      messageIds:['26256','26257'], ingestionCursors:['i:0000000000000002','i:0000000000000003'],
    })).toBe(true);
    const payload=JSON.parse(mockWriteAtomic.mock.calls.at(-1)![1]);
    expect(payload).toEqual({type:'message',text:'<message>Company A</message>',hostSource:{
      chatJid:'tg:owner',messageIds:['26256','26257'],ingestionCursors:['i:0000000000000002','i:0000000000000003'],
    }});
    expect(registerDeferredInputSource).toHaveBeenCalledWith('tg:owner',expect.stringMatching(/\.json$/),{
      messageIds:['26256','26257'],ingestionCursors:['i:0000000000000002','i:0000000000000003'],
    },expect.objectContaining({groupIpcDir:expect.any(String)}));
    expect(vi.mocked(registerDeferredInputSource).mock.invocationCallOrder[0]).toBeLessThan(mockWriteAtomic.mock.invocationCallOrder.at(-1)!);
    mockWriteAtomic.mockClear();
    vi.mocked(registerDeferredInputSource).mockImplementationOnce(()=>{throw new Error('registry unavailable');});
    expect(queue.sendMessage('tg:owner','new correction',{messageIds:['next'],ingestionCursors:['i:0000000000000004']})).toBe(false);
    expect(mockWriteAtomic).not.toHaveBeenCalled();
    finish(); await vi.advanceTimersByTimeAsync(10);
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

  it('reports a requested stop until the stopped run ends', async () => {
    let rejectProcess!: (error: Error) => void;
    queue.setProcessMessagesFn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectProcess = reject;
        }),
    );
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.isCancelRequested('group1@g.us')).toBe(false);
    queue.cancelActiveChatRun('group1@g.us', 'owner-stop');
    // The message loop reads this while the killed run is still returning.
    expect(queue.isCancelRequested('group1@g.us')).toBe(true);
    rejectProcess(new Error('terminated'));
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.isCancelRequested('group1@g.us')).toBe(false);
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

  it('getStatus показывает зависание и «стоп», сам ничего не сигналя', async () => {
    let resolveProcess: () => void;
    queue.setProcessMessagesFn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProcess = () => resolve(true);
        }),
    );
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    const proc = { pid: 12345, kill: vi.fn() } as any;
    queue.registerProcess('group1@g.us', proc, 'container-1', 'test-group');

    expect(queue.getStatus('group1@g.us')).toMatchObject({
      active: true,
      stale: false,
      cancelRequested: false,
    });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    expect(queue.getStatus('group1@g.us').stale).toBe(true);
    // Чтение статуса — только чтение: прибивает зависший ход попытка пайпа.
    expect(terminateProcessTree).not.toHaveBeenCalled();

    queue.cancelActiveChatRun('group1@g.us');
    expect(queue.getStatus('group1@g.us').cancelRequested).toBe(true);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.getStatus('group1@g.us')).toMatchObject({
      active: false,
      stale: false,
      cancelRequested: false,
    });
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

  it('a scheduled task with heartbeats is not wedged at minute 11: a message waits for it instead of killing it', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);
    let resolveTask!: () => void;
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

    // The scheduler notes every frame of the run, heartbeats included.
    for (let minute = 0; minute < 11; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      queue.noteRunActivity('group1@g.us');
    }
    expect(queue.getStatus('group1@g.us')).toMatchObject({
      active: true,
      isTaskContainer: true,
      stale: false,
    });

    // A person writes at minute 11: the message waits for the task.
    queue.enqueueMessageCheck('group1@g.us');
    expect(terminateProcessTree).not.toHaveBeenCalled();
    expect(queue.getStatus('group1@g.us').pendingMessages).toBe(true);
    expect(processMessages).not.toHaveBeenCalled();

    resolveTask();
    await vi.advanceTimersByTimeAsync(10);
    expect(processMessages).toHaveBeenCalledWith('group1@g.us');
  });

  it('a scheduled task silent for ten minutes still looks wedged, and a message signals it', async () => {
    let resolveTask!: () => void;
    queue.setProcessMessagesFn(vi.fn(async () => true));
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

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    queue.noteRunActivity('group1@g.us');
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect(queue.getStatus('group1@g.us').stale).toBe(true);

    queue.enqueueMessageCheck('group1@g.us');
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
    resolveTask();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('summarizes active runs by folder for the heartbeat, without JIDs', async () => {
    vi.setSystemTime(new Date('2026-09-28T10:00:00.000Z'));
    expect(queue.getActiveRunsSummary()).toEqual([]);

    let releaseChat!: () => void;
    queue.setProcessMessagesFn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseChat = () => resolve(true);
        }),
    );
    let releaseTask!: () => void;
    queue.enqueueMessageCheck('chat@g.us');
    queue.enqueueTask(
      'tasks@g.us',
      'scheduled-1',
      () =>
        new Promise<void>((resolve) => {
          releaseTask = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(10);
    // Live-model turns never register a process: the folder comes from the
    // resolver. The task registered its own folder.
    queue.registerProcess('tasks@g.us', {} as any, 'task-1', 'tasks_folder');

    const resolver = vi.fn((jid: string) =>
      jid === 'chat@g.us' ? 'chat_folder' : undefined,
    );
    const summary = queue.getActiveRunsSummary(resolver);
    expect(summary).toEqual(
      expect.arrayContaining([
        {
          groupFolder: 'chat_folder',
          startedAt: Date.parse('2026-09-28T10:00:00.000Z'),
          isTaskContainer: false,
        },
        {
          groupFolder: 'tasks_folder',
          startedAt: Date.parse('2026-09-28T10:00:00.000Z'),
          isTaskContainer: true,
        },
      ]),
    );
    expect(summary).toHaveLength(2);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(summary)).not.toContain('@g.us');
    // A throwing resolver degrades to an unnamed run, never an exception.
    expect(
      queue
        .getActiveRunsSummary(() => {
          throw new Error('registry gone');
        })
        .find((run) => !run.isTaskContainer)?.groupFolder,
    ).toBeNull();

    releaseChat();
    releaseTask();
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.getActiveRunsSummary()).toEqual([]);
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

  // --- Промежуточные реплики и заглушка «Принял, работаю» ---

  describe('живая реплика гасит заглушку', () => {
    const startRun = () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      queue.setProcessMessagesFn(async () => {
        await held;
        return true;
      });
      queue.enqueueMessageCheck('group1@g.us');
      return release;
    };

    it('после живой реплики первое «Принял, работаю» не отправляется', async () => {
      const notices: Array<[string, number]> = [];
      queue.setLongRunNotifier((jid, elapsed, index) =>
        notices.push([jid, index]),
      );
      const release = startRun();
      await vi.advanceTimersByTimeAsync(10);

      // Модель заговорила на 30-й секунде — раньше, чем сработала бы заглушка.
      await vi.advanceTimersByTimeAsync(30_000);
      queue.noteUserVisibleOutput('group1@g.us');

      // Минута прошла: без правки здесь ушло бы «Принял, работаю».
      await vi.advanceTimersByTimeAsync(45_000);
      expect(notices).toEqual([]);

      // А вот когда после реплики пройдёт полный интервал (минута + пять),
      // напоминание уместно — и отсчитывается оно от РЕПЛИКИ, а не от старта.
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(notices.length).toBeGreaterThan(0);
      release();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('ход, который ответил и ждёт, не получает «ещё работаю» поверх ответа', async () => {
      const notices: number[] = [];
      queue.setLongRunNotifier((_jid, _elapsed, index) => notices.push(index));
      const release = startRun();
      await vi.advanceTimersByTimeAsync(10);

      queue.noteUserVisibleOutput('group1@g.us');
      queue.notifyIdle('group1@g.us');
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(notices).toEqual([]);
      release();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('ответ хоста на «ау» посреди хода: без «Принял», следующее — через 6 мин после ответа', async () => {
      const notices: number[] = [];
      queue.setLongRunNotifier((_jid, _elapsed, index) => notices.push(index));
      const release = startRun();
      await vi.advanceTimersByTimeAsync(10);

      // На 40-й секунде владелец спросил «ау», хост ответил статусом.
      await vi.advanceTimersByTimeAsync(40_000);
      queue.noteUserVisibleOutput('group1@g.us');

      // «Принял, работаю» после ответа хоста лишнее — его нет.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(notices).toEqual([]);

      // Следующее «Всё ещё работаю» — не раньше минуты + пяти от ответа.
      await vi.advanceTimersByTimeAsync(4 * 60_000 + 50_000);
      expect(notices).toEqual([]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(notices).toEqual([2]);
      release();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('метка не залипает: следующий ход снова получает заглушку', async () => {
      // Первый ход: модель заговорила, заглушка подавлена.
      const first: number[] = [];
      queue.setLongRunNotifier((_jid, _elapsed, index) => first.push(index));
      const release1 = startRun();
      await vi.advanceTimersByTimeAsync(10);
      queue.noteUserVisibleOutput('group1@g.us');
      await vi.advanceTimersByTimeAsync(70_000);
      expect(first).toEqual([]);
      release1();
      await vi.advanceTimersByTimeAsync(100);

      // Второй ход в той же группе, БЕЗ реплики, — заглушка снова приходит.
      const second: number[] = [];
      queue.setLongRunNotifier((_jid, _elapsed, index) => second.push(index));
      const release2 = startRun();
      await vi.advanceTimersByTimeAsync(70_000);
      expect(second).toContain(1);
      release2();
      await vi.advanceTimersByTimeAsync(10);
    });
  });

  describe('признаки жизни на длинном ходе', () => {
    it('1, 6, 11, 16, 21 минута, дальше каждые 10 минут, всего не больше 12', async () => {
      const minutes: number[] = [];
      queue.setLongRunNotifier((_jid, elapsed) =>
        minutes.push(Math.floor(elapsed / 60_000)),
      );
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      queue.setProcessMessagesFn(async () => {
        await held;
        return true;
      });
      queue.enqueueMessageCheck('group1@g.us');
      // Ход до 90-минутного потолка и ещё немного сверху.
      await vi.advanceTimersByTimeAsync(110 * 60_000);
      expect(minutes).toEqual([1, 6, 11, 16, 21, 31, 41, 51, 61, 71, 81, 91]);
      release();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('расписание считается от числа уже отправленных', () => {
      expect(
        Array.from(
          { length: 12 },
          (_, sent) => longRunNoticeDueMs(sent) / 60_000,
        ),
      ).toEqual([1, 6, 11, 16, 21, 31, 41, 51, 61, 71, 81, 91]);
    });
  });

  describe('признаки жизни считаются на ход, а не на run', () => {
    const startRun = () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      queue.setProcessMessagesFn(async () => {
        await held;
        return true;
      });
      queue.enqueueMessageCheck('group1@g.us');
      return release;
    };

    it('доставленный ответ обнуляет счётчик: следующее «ещё работаю» — через 6 мин после ответа, а не через 31', async () => {
      const notices: Array<[number, number]> = [];
      queue.setLongRunNotifier((_jid, elapsed, index) =>
        notices.push([index, Math.round(elapsed / 60_000)]),
      );
      const release = startRun();

      await vi.advanceTimersByTimeAsync(22 * 60_000);
      expect(notices.map(([index]) => index)).toEqual([1, 2, 3, 4, 5]);
      // ...ответ хода доставлен, раннер сразу берёт следующий ход.
      queue.noteTurnAnswered('group1@g.us');
      // Без правки следующее полагалось бы через 31 мин от ответа.
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
      expect(notices.length).toBe(5);
      await vi.advanceTimersByTimeAsync(45_000);
      // Отсчёт идёт от ответа и без повторного «Принял» (индекс 1).
      expect(notices.at(-1)).toEqual([2, 6]);
      release();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('догоняющий ход — новый ход: через минуту снова «Принял, работаю»', async () => {
      const notices: Array<[number, number]> = [];
      queue.setLongRunNotifier((_jid, elapsed, index) =>
        notices.push([index, Math.round(elapsed / 60_000)]),
      );
      const release = startRun();
      await vi.advanceTimersByTimeAsync(22 * 60_000);
      expect(notices.length).toBe(5);
      // Раннер отчитался consumedFollowUps: отдельный ход для сообщений,
      // пришедших во время предыдущего.
      queue.noteFollowUpTurnStarted('group1@g.us');
      await vi.advanceTimersByTimeAsync(50_000);
      expect(notices.length).toBe(5);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(notices.at(-1)).toEqual([1, 1]);
      // Дальше — по обычному расписанию от старта этого хода.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(notices.at(-1)).toEqual([2, 6]);
      release();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('живая реплика в догоняющем ходе гасит «Принял» и двигает отсчёт', async () => {
      const notices: number[] = [];
      queue.setLongRunNotifier((_jid, _elapsed, index) => notices.push(index));
      const release = startRun();
      await vi.advanceTimersByTimeAsync(70_000);
      expect(notices).toEqual([1]);
      queue.noteFollowUpTurnStarted('group1@g.us');
      // Модель заговорила через 10 с после старта хода.
      await vi.advanceTimersByTimeAsync(10_000);
      queue.noteUserVisibleOutput('group1@g.us');
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(notices).toEqual([1]);
      await vi.advanceTimersByTimeAsync(70_000);
      expect(notices).toEqual([1, 2]);
      release();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('вне активного хода пометка нового хода ничего не трогает', () => {
      queue.noteFollowUpTurnStarted('nobody@g.us');
      queue.noteTurnAnswered('nobody@g.us');
      queue.noteTurnRestarted('nobody@g.us');
      expect(queue.getStatus('nobody@g.us').active).toBe(false);
    });

    it('догоняющий ход после ответа снова работает: ждёт не он, «Принял» через минуту', async () => {
      const notices: Array<[number, number]> = [];
      queue.setLongRunNotifier((_jid, elapsed, index) =>
        notices.push([index, Math.round(elapsed / 60_000)]),
      );
      const release = startRun();
      // The first turn is still running when another message arrives.
      await vi.advanceTimersByTimeAsync(13 * 60_000);
      const beforeAnswer = notices.length;
      // Ответ хода 1 доставлен, ход ждёт (notifyIdle), и раннер тут же берёт
      // подклеенное сообщение отдельным ходом (consumedFollowUps).
      queue.noteTurnAnswered('group1@g.us');
      queue.notifyIdle('group1@g.us');
      queue.noteFollowUpTurnStarted('group1@g.us');
      // Без правки флаг idleWaiting висел до конца хода: ни ответа хоста на
      // «Ну как», ни 👀, ни «ещё работаю».
      expect(queue.getStatus('group1@g.us').idleWaiting).toBe(false);
      await vi.advanceTimersByTimeAsync(75_000);
      expect(notices.slice(beforeAnswer)).toEqual([[1, 1]]);
      release();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('задача, поставленная во время догоняющего хода, ждёт его конца, а не обрывает его', async () => {
      const release = startRun();
      await vi.advanceTimersByTimeAsync(10);
      queue.registerProcess(
        'group1@g.us',
        {} as never,
        'container-1',
        'test-group',
      );
      queue.notifyIdle('group1@g.us');
      queue.noteFollowUpTurnStarted('group1@g.us');
      mockWriteAtomic.mockClear();
      queue.enqueueTask('group1@g.us', 'task-during-follow-up', async () => {});
      const closeWrites = mockWriteAtomic.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
      );
      expect(closeWrites).toHaveLength(0);
      // Конец догоняющего хода: теперь stdin закрывается ради задачи.
      queue.notifyIdle('group1@g.us');
      const closeAfter = mockWriteAtomic.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
      );
      expect(closeAfter).toHaveLength(1);
      release();
      await vi.advanceTimersByTimeAsync(10);
    });
  });

  describe('подпись «уже N мин» — от начала хода (C03)', () => {
    const startRun = () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      queue.setProcessMessagesFn(async () => {
        await held;
        return true;
      });
      queue.enqueueMessageCheck('group1@g.us');
      return release;
    };

    it('расписание — от последней реплики, а число минут — от начала хода', async () => {
      const notices: Array<[number, number]> = [];
      queue.setLongRunNotifier((_jid, elapsed, index) =>
        notices.push([index, Math.round(elapsed / 60_000)]),
      );
      const release = startRun();
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(notices).toEqual([[1, 1]]);
      // «⏳» модели на 4-й минуте хода.
      queue.noteUserVisibleOutput('group1@g.us');
      // Следующее уведомление по-прежнему через 6 минут после реплики...
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 50_000);
      expect(notices).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30_000);
      // ...но в подписи — сколько идёт ход, а не сколько прошло с реплики.
      expect(notices.at(-1)).toEqual([2, 10]);
      release();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('уведомитель получает начало хода и метку последнего видимого', async () => {
      const turns: Array<{
        turnStartedAt: number;
        lastUserVisibleOutputAt: number | null;
      }> = [];
      queue.setLongRunNotifier((_jid, _elapsed, _index, turn) =>
        turns.push(turn),
      );
      const startedAt = Date.now();
      const release = startRun();
      await vi.advanceTimersByTimeAsync(75_000);
      expect(turns).toEqual([
        { turnStartedAt: startedAt, lastUserVisibleOutputAt: null },
      ]);
      await vi.advanceTimersByTimeAsync(60_000);
      queue.noteUserVisibleOutput('group1@g.us');
      const shownAt = Date.now();
      await vi.advanceTimersByTimeAsync(6 * 60_000 + 15_000);
      expect(turns.at(-1)).toEqual({
        turnStartedAt: startedAt,
        lastUserVisibleOutputAt: shownAt,
      });
      release();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('перезапуск склейкой серии: «Принял» — через минуту от перезапуска, ответ раньше — заглушки нет', async () => {
      const notices: number[] = [];
      queue.setLongRunNotifier((_jid, _elapsed, index) => notices.push(index));
      const release = startRun();

      await vi.advanceTimersByTimeAsync(16_000);
      queue.noteTurnRestarted('group1@g.us');
      // One minute after the first message: a premature notice must be suppressed.
      await vi.advanceTimersByTimeAsync(46_000);
      expect(notices).toEqual([]);
      // The reply arrives after the restarted turn.
      await vi.advanceTimersByTimeAsync(3_000);
      queue.noteTurnAnswered('group1@g.us');
      queue.notifyIdle('group1@g.us');
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(notices).toEqual([]);
      release();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('перезапуск без быстрого ответа: «Принял» всё же приходит, минутой позже перезапуска', async () => {
      const notices: Array<[number, number]> = [];
      queue.setLongRunNotifier((_jid, elapsed, index) =>
        notices.push([index, Math.round(elapsed / 60_000)]),
      );
      const release = startRun();
      await vi.advanceTimersByTimeAsync(20_000);
      queue.noteTurnRestarted('group1@g.us');
      await vi.advanceTimersByTimeAsync(55_000);
      expect(notices).toEqual([]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(notices.map(([index]) => index)).toEqual([1]);
      release();
      await vi.advanceTimersByTimeAsync(10);
    });
  });

  describe('очередь знает свои задачи (C31)', () => {
    it('hasTask: ждёт за ходом чата и идёт; после конца — нет', async () => {
      let releaseChat!: () => void;
      const chatHeld = new Promise<void>((resolve) => {
        releaseChat = resolve;
      });
      queue.setProcessMessagesFn(async () => {
        await chatHeld;
        return true;
      });
      queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      let releaseTask!: () => void;
      const taskHeld = new Promise<void>((resolve) => {
        releaseTask = resolve;
      });
      expect(queue.hasTask('group1@g.us', 'task-1')).toBe(false);
      expect(queue.enqueueTask('group1@g.us', 'task-1', () => taskHeld)).toBe(
        true,
      );
      // Ждёт за ходом чата.
      expect(queue.hasTask('group1@g.us', 'task-1')).toBe(true);
      expect(queue.getActiveTaskRun('group1@g.us')).toBeNull();
      expect(queue.hasTask('group1@g.us', 'task-2')).toBe(false);
      expect(queue.hasTask('other@g.us', 'task-1')).toBe(false);

      releaseChat();
      await vi.advanceTimersByTimeAsync(10);
      // Идёт.
      expect(queue.hasTask('group1@g.us', 'task-1')).toBe(true);
      const run = queue.getActiveTaskRun('group1@g.us');
      expect(run?.taskId).toBe('task-1');
      expect(run?.startedAt).toBe(Date.now() - 10);

      releaseTask();
      await vi.advanceTimersByTimeAsync(10);
      expect(queue.hasTask('group1@g.us', 'task-1')).toBe(false);
      expect(queue.getActiveTaskRun('group1@g.us')).toBeNull();
    });

    it('две задачи подряд, сообщение за первой: видно, что ждёт ещё задача, и вторая задача сообщает о себе', async () => {
      const processMessages = vi.fn(async () => true);
      queue.setProcessMessagesFn(processMessages);
      const starts: Array<{
        taskId: string;
        pendingTasks: number;
        previous: string | null;
      }> = [];
      queue.setTaskRunStartNotifier((_jid, run, previous) => {
        starts.push({
          taskId: run.taskId,
          pendingTasks: run.pendingTasks,
          previous: previous?.taskId ?? null,
        });
      });
      const release: Record<string, () => void> = {};
      const task = (id: string) => () =>
        new Promise<void>((resolve) => {
          release[id] = resolve;
        });
      queue.enqueueTask('group1@g.us', 'task-a', task('task-a'));
      queue.enqueueTask('group1@g.us', 'task-b', task('task-b'));
      await vi.advanceTimersByTimeAsync(10);
      expect(queue.getActiveTaskRun('group1@g.us')).toMatchObject({
        taskId: 'task-a',
        pendingTasks: 1,
      });
      // Никто не ждал: первая задача о себе не сообщает.
      expect(starts).toEqual([]);

      // Человек написал во время первой задачи.
      queue.enqueueMessageCheck('group1@g.us');
      release['task-a']();
      await vi.advanceTimersByTimeAsync(10);
      // Очередь берёт задачу раньше сообщений: вторая задача, сообщение ждёт.
      expect(queue.getActiveTaskRun('group1@g.us')).toMatchObject({
        taskId: 'task-b',
        pendingTasks: 0,
      });
      expect(processMessages).not.toHaveBeenCalled();
      expect(starts).toEqual([
        { taskId: 'task-b', pendingTasks: 0, previous: 'task-a' },
      ]);

      release['task-b']();
      await vi.advanceTimersByTimeAsync(10);
      expect(processMessages).toHaveBeenCalledTimes(1);
    });

    it('после хода чата задача не считается «следующей за задачей»', async () => {
      queue.setProcessMessagesFn(async () => true);
      const previous: Array<string | null> = [];
      queue.setTaskRunStartNotifier((_jid, _run, prev) => {
        previous.push(prev?.taskId ?? null);
      });
      let releaseA!: () => void;
      queue.enqueueTask(
        'group1@g.us',
        'task-a',
        () => new Promise<void>((resolve) => (releaseA = resolve)),
      );
      await vi.advanceTimersByTimeAsync(10);
      queue.enqueueMessageCheck('group1@g.us');
      releaseA();
      await vi.advanceTimersByTimeAsync(10);
      // Ход чата прошёл; новое сообщение и задача приходят во время хода.
      let releaseChat!: () => void;
      queue.setProcessMessagesFn(
        () => new Promise<boolean>((resolve) => (releaseChat = () => resolve(true))),
      );
      queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);
      queue.enqueueMessageCheck('group1@g.us');
      queue.enqueueTask('group1@g.us', 'task-b', async () => {});
      releaseChat();
      await vi.advanceTimersByTimeAsync(10);
      expect(previous).toEqual([null]);
    });

    it('исключение в уведомителе не мешает задаче', async () => {
      queue.setProcessMessagesFn(async () => true);
      queue.setTaskRunStartNotifier(() => {
        throw new Error('boom');
      });
      let releaseA!: () => void;
      queue.enqueueTask(
        'group1@g.us',
        'task-a',
        () => new Promise<void>((resolve) => (releaseA = resolve)),
      );
      await vi.advanceTimersByTimeAsync(10);
      const ran = vi.fn(async () => {});
      queue.enqueueTask('group1@g.us', 'task-b', ran);
      queue.enqueueMessageCheck('group1@g.us');
      releaseA();
      await vi.advanceTimersByTimeAsync(10);
      expect(ran).toHaveBeenCalledTimes(1);
    });
  });
});
