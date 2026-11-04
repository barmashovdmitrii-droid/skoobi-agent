import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOperationTraceStage } from '@skoobi/shared/operation-trace';
import { createMessageRouter } from './outbound-router.js';
import {
  ensureOperationTraceSchema,
  getOrCreateOperationTrace,
  queryOperationTimeline,
  queueOperationTrace,
} from './operation-trace-store.js';
import {
  bindOperationTraceInputs,
  currentOperationTrace,
  linkPipedOperationTraceInputs,
  traceAgentExecution,
  withOperationTraceRun,
  createToolTraceRecorder,
  registerIpcOperationTrace,
  withIpcOperationTrace,
} from './runtime-operation-trace.js';

describe('message to actual transport trace', () => {
  let database: Database.Database;
  const scope = { tenantId: 'synthetic-tenant', chatId: 'tg:synthetic' };
  const channel = {
    name: 'telegram',
    connect: vi.fn(),
    disconnect: vi.fn(),
    ownsJid: () => true,
    isConnected: () => true,
    sendMessage: vi.fn(async () => {}),
  };
  beforeEach(() => {
    database = new Database(':memory:');
    ensureOperationTraceSchema(database);
    channel.sendMessage = vi.fn(async () => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    database.close();
  });
  const timeline = (id: string) => {
    const observer = getOrCreateOperationTrace(
      database,
      scope,
      id,
      'telegram',
    )!;
    return queryOperationTimeline(database, scope, observer.operationIds[0])!;
  };

  it('attributes delayed IPC to the original batch and never borrows a newer run', async () => {
    let binding!: NonNullable<ReturnType<typeof registerIpcOperationTrace>>;
    await withOperationTraceRun(scope.chatId, async () => {
      bindOperationTraceInputs(database, scope, ['original-ipc'], 'telegram');
      binding = registerIpcOperationTrace('synthetic-folder')!;
      linkPipedOperationTraceInputs(scope.chatId, ['ipc-correction']);
      binding.release();
    });
    const router = createMessageRouter([channel]);
    await withOperationTraceRun(scope.chatId, async () => {
      bindOperationTraceInputs(database, scope, ['newer-run'], 'telegram');
      await withIpcOperationTrace(
        database,
        'synthetic-folder',
        binding.token,
        () =>
          router.route({
            chatJid: scope.chatId,
            text: 'Late delivery',
            triggerType: 'ipc',
          }),
      );
      for (const [source, token] of [
        ['wrong-folder', binding.token],
        ['synthetic-folder', 'a'.repeat(43)],
        ['synthetic-folder', undefined],
      ]) {
        await withIpcOperationTrace(database, source!, token, async () => {
          expect(currentOperationTrace()).toBeUndefined();
          await router.route({
            chatJid: scope.chatId,
            text: 'Unbound',
            triggerType: 'ipc',
          });
        });
      }
    });
    expect(
      timeline('original-ipc').spans.some((s) => s.stage === 'delivery'),
    ).toBe(true);
    expect(
      timeline('ipc-correction').spans.some((s) => s.stage === 'delivery'),
    ).toBe(true);
    expect(timeline('newer-run').spans).toHaveLength(0);
    expect(channel.sendMessage).toHaveBeenCalledTimes(4);
    expect(
      JSON.stringify(
        database.prepare('SELECT * FROM operation_trace_ipc_bindings').all(),
      ),
    ).not.toContain(binding.token);
    expect(JSON.stringify(timeline('original-ipc'))).not.toContain(
      binding.token,
    );
  });

  it('expires released IPC correlation and propagates delivery failure exactly once without storage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let binding!: NonNullable<ReturnType<typeof registerIpcOperationTrace>>;
    await withOperationTraceRun(scope.chatId, async () => {
      bindOperationTraceInputs(database, scope, ['expiring'], 'telegram');
      binding = registerIpcOperationTrace('synthetic-folder')!;
      binding.release();
    });
    vi.setSystemTime(new Date('2026-01-01T00:05:01Z'));
    await withIpcOperationTrace(
      database,
      'synthetic-folder',
      binding.token,
      async () => expect(currentOperationTrace()).toBeUndefined(),
    );
    const send = vi.fn(async () => {
      throw new Error('transport failed');
    });
    await expect(
      withIpcOperationTrace(undefined, 'synthetic-folder', binding.token, send),
    ).rejects.toThrow('transport failed');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('records starts before agent/transport complete and keeps two input links', async () => {
    const input = getOrCreateOperationTrace(
      database,
      scope,
      'one',
      'telegram',
    )!;
    queueOperationTrace(database, scope, input.operationIds[0]);
    const router = createMessageRouter([channel]);
    await withOperationTraceRun(scope.chatId, async () => {
      bindOperationTraceInputs(database, scope, ['one', 'two'], 'telegram');
      expect(
        timeline('one').spans.find((s) => s.stage === 'queue')?.status,
      ).toBe('succeeded');
      await traceAgentExecution(async () => {
        expect(
          timeline('one').spans.find((s) => s.stage === 'agent')?.status,
        ).toBe('running');
        channel.sendMessage = vi.fn(async () => {
          expect(
            timeline('two').spans.find((s) => s.stage === 'delivery')?.status,
          ).toBe('running');
        });
        await router.route({
          chatJid: scope.chatId,
          text: 'Synthetic result',
          triggerType: 'agent-response',
        });
        return { status: 'success' };
      });
    });
    const first = timeline('one');
    expect(first.attempts).toEqual(timeline('two').attempts);
    expect(first.attempts[0].inputCount).toBe(2);
    expect(first.spans.find((s) => s.stage === 'delivery')).toMatchObject({
      status: 'succeeded',
      details: { reason: 'api_acknowledged', deliveryKind: 'final' },
    });
    expect(JSON.stringify(first)).not.toContain('Synthetic result');
    expect(currentOperationTrace()).toBeUndefined();
  });

  it('links a late correction only to its active run and records uncertain external send', async () => {
    const router = createMessageRouter([channel]);
    await withOperationTraceRun(scope.chatId, async () => {
      bindOperationTraceInputs(database, scope, ['original'], 'telegram');
      startOperationTraceStage(currentOperationTrace(), 'tool').finish(
        'succeeded',
      );
      linkPipedOperationTraceInputs(scope.chatId, ['correction']);
      channel.sendMessage = vi.fn(async () => {
        throw new Error('secret network error');
      });
      await expect(
        router.route({
          chatJid: scope.chatId,
          text: 'Private answer',
          triggerType: 'agent-response',
        }),
      ).rejects.toThrow('secret network error');
    });
    expect(timeline('correction').attempts).toHaveLength(1);
    expect(
      timeline('correction').spans.find((s) => s.stage === 'delivery'),
    ).toMatchObject({
      status: 'unknown',
      details: { reason: 'outcome_unknown' },
    });
    linkPipedOperationTraceInputs(scope.chatId, ['after-close']);
    expect(timeline('after-close').attempts).toHaveLength(0);
    expect(JSON.stringify(timeline('correction'))).not.toMatch(
      /secret|Private answer/,
    );
  });

  it('isolates concurrent chats and does not borrow context for background sends', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const other = { tenantId: 'other-tenant', chatId: 'tg:other' };
    const first = withOperationTraceRun(scope.chatId, async () => {
      bindOperationTraceInputs(database, scope, ['one'], 'telegram');
      await barrier;
      startOperationTraceStage(currentOperationTrace(), 'agent').finish(
        'succeeded',
      );
    });
    expect(currentOperationTrace()).toBeUndefined();
    await createMessageRouter([channel]).route({
      chatJid: scope.chatId,
      text: 'Background',
      triggerType: 'extension',
    });
    await withOperationTraceRun(other.chatId, async () => {
      bindOperationTraceInputs(database, other, ['one'], 'telegram');
      startOperationTraceStage(currentOperationTrace(), 'response').finish(
        'succeeded',
      );
      release();
    });
    await first;
    expect(timeline('one').spans.map((s) => s.stage)).toEqual(['agent']);
    const otherObserver = getOrCreateOperationTrace(
      database,
      other,
      'one',
      'telegram',
    )!;
    expect(
      queryOperationTimeline(
        database,
        other,
        otherObserver.operationIds[0],
      )?.spans.map((s) => s.stage),
    ).toEqual(['response']);
  });

  it('continues real delivery if diagnostic storage fails and cleans context after a throw', async () => {
    const router = createMessageRouter([channel]);
    await expect(
      withOperationTraceRun(scope.chatId, async () => {
        bindOperationTraceInputs(database, scope, ['one'], 'telegram');
        database.exec('DROP TABLE operation_trace_spans');
        await router.route({
          chatJid: scope.chatId,
          text: 'Still delivered',
          triggerType: 'agent-response',
        });
        throw new Error('real task failure');
      }),
    ).rejects.toThrow('real task failure');
    expect(channel.sendMessage).toHaveBeenCalledExactlyOnceWith(
      scope.chatId,
      'Still delivered',
    );
    expect(currentOperationTrace()).toBeUndefined();
  });

  it('does not call empty or dropped content a successful delivery', async () => {
    await withOperationTraceRun(scope.chatId, async () => {
      bindOperationTraceInputs(database, scope, ['one'], 'telegram');
      const router = createMessageRouter([channel]);
      expect(
        await router.route({
          chatJid: scope.chatId,
          text: ' ',
          triggerType: 'agent-response',
        }),
      ).toBeNull();
      router.addPreHook(async () => ({ action: 'drop' }));
      expect(
        await router.route({
          chatJid: scope.chatId,
          text: 'Dropped',
          triggerType: 'agent-response',
        }),
      ).toBeNull();
    });
    expect(timeline('one').spans.map((s) => [s.stage, s.status])).toEqual([
      ['response', 'skipped'],
      ['response', 'skipped'],
    ]);
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('tracks structural tool events, marks missing starts, and closes interrupted calls as unknown', async () => {
    await withOperationTraceRun(scope.chatId, async () => {
      bindOperationTraceInputs(database, scope, ['one'], 'telegram');
      const recorder = createToolTraceRecorder(currentOperationTrace());
      const event = {
        source: 'codex_cli',
        family: 'shell',
        startedObserved: true,
        callId: '00000000-0000-4000-8000-000000000001',
      };
      recorder.observe({
        ...event,
        phase: 'started',
        command: 'do not log this',
      });
      recorder.observe({ ...event, phase: 'started' });
      recorder.observe({ ...event, phase: 'finished', outcome: 'succeeded' });
      recorder.observe({ ...event, phase: 'finished', outcome: 'failed' });
      recorder.observe({
        ...event,
        callId: '00000000-0000-4000-8000-000000000002',
        phase: 'finished',
        startedObserved: false,
        outcome: 'succeeded',
      });
      recorder.observe({
        ...event,
        callId: '00000000-0000-4000-8000-000000000003',
        phase: 'started',
      });
      recorder.observe({
        source: 'model',
        text: 'I successfully ran a command',
      });
      recorder.finish();
      recorder.observe({
        ...event,
        callId: '00000000-0000-4000-8000-000000000004',
        phase: 'started',
      });
    });
    expect(
      timeline('one').spans.map((s) => [s.status, s.details.reason]),
    ).toEqual([
      ['succeeded', undefined],
      ['succeeded', 'start_unobserved'],
      ['unknown', 'outcome_unknown'],
    ]);
    expect(JSON.stringify(timeline('one'))).not.toContain('do not log this');
  });

  it('a background notice has its own input and cannot steal a running chats correction', async () => {
    await withOperationTraceRun(scope.chatId, async () => {
      bindOperationTraceInputs(database, scope, ['one'], 'telegram');
      const active = currentOperationTrace()!.attemptId;
      await withOperationTraceRun(
        scope.chatId,
        async () => {
          bindOperationTraceInputs(
            database,
            scope,
            ['failed-voice'],
            'telegram',
          );
          startOperationTraceStage(currentOperationTrace(), 'delivery').finish(
            'succeeded',
            { reason: 'api_acknowledged' },
          );
        },
        { trackPipedInputs: false },
      );
      linkPipedOperationTraceInputs(scope.chatId, ['correction']);
      expect(timeline('correction').attempts.map((a) => a.attemptId)).toEqual([
        active,
      ]);
      expect(
        timeline('failed-voice').attempts.map((a) => a.attemptId),
      ).not.toContain(active);
    });
  });
});
