import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import {
  startOperationTraceStage,
  type OperationTraceObserver,
  type OperationTraceSpan,
} from '@skoobi/shared/operation-trace';
import {
  getOrCreateOperationTrace,
  linkOperationTraceInputs,
  settleOperationTraceQueue,
  startOperationTraceAttempt,
  createOperationTraceIpcBinding,
  releaseOperationTraceIpcBinding,
  findOperationTraceForIpc,
  type OperationTraceChannel,
  type OperationTraceScope,
} from './operation-trace-store.js';

interface TraceRun {
  chatJid: string;
  observer?: OperationTraceObserver;
  database?: Database.Database;
  scope?: OperationTraceScope;
  channel?: OperationTraceChannel;
  trackPipedInputs: boolean;
  closed: boolean;
}
const runs = new AsyncLocalStorage<TraceRun>();
// Only queue-owned active runs live here; every exit removes its exact entry.
const activeRuns = new Map<string, TraceRun>();

/** Correlation only, never permission to send. The watcher must authorize the
 * envelope separately before entering this exact host-issued source context.
 */
export function registerIpcOperationTrace(
  sourceGroup: string,
): { token: string; release(): void } | undefined {
  try {
    const run = runs.getStore();
    if (
      !run?.observer?.attemptId ||
      !run.database ||
      !run.scope ||
      run.closed ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sourceGroup)
    )
      return;
    const token = createOperationTraceIpcBinding(
      run.database,
      run.scope,
      sourceGroup,
      run.observer.attemptId,
    );
    if (!token) return;
    return {
      token,
      release: () => releaseOperationTraceIpcBinding(run.database!, token),
    };
  } catch {
    return;
  }
}

/** No active-chat/folder fallback: an old envelope cannot borrow a newer run.
 * Late confirmed sends retain their original input batch for a bounded grace.
 */
export async function withIpcOperationTrace<T>(
  database: Database.Database | undefined,
  sourceGroup: string,
  token: unknown,
  body: () => Promise<T>,
): Promise<T> {
  const context: TraceRun = {
    chatJid: '',
    closed: false,
    trackPipedInputs: false,
    observer: database
      ? findOperationTraceForIpc(database, sourceGroup, token)
      : undefined,
  };
  return runs.run(context, body);
}

/** Host context only. Never deserialize observers or accept IDs as authority. */
export async function withOperationTraceRun<T>(
  chatJid: string,
  body: () => Promise<T>,
  options: { trackPipedInputs?: boolean } = {},
): Promise<T> {
  const run: TraceRun = {
    chatJid,
    closed: false,
    trackPipedInputs: options.trackPipedInputs !== false,
  };
  return runs.run(run, async () => {
    try {
      return await body();
    } finally {
      run.closed = true;
      if (activeRuns.get(chatJid) === run) activeRuns.delete(chatJid);
    }
  });
}

/** Called after the host has selected the exact admitted message batch. */
export function bindOperationTraceInputs(
  database: Database.Database,
  scope: OperationTraceScope,
  messageIds: readonly string[],
  channel: OperationTraceChannel,
): OperationTraceObserver | undefined {
  try {
    const run = runs.getStore();
    if (!run || run.closed || run.observer) return run?.observer;
    const ids = messageIds.flatMap(
      (id) =>
        getOrCreateOperationTrace(database, scope, id, channel)?.operationIds ??
        [],
    );
    const observer = startOperationTraceAttempt(database, scope, ids);
    if (!observer) return undefined;
    for (const id of ids)
      settleOperationTraceQueue(database, scope, id, 'succeeded');
    Object.assign(run, { database, scope, channel, observer });
    if (run.trackPipedInputs) activeRuns.set(run.chatJid, run);
    return observer;
  } catch {
    return undefined;
  }
}

/** A pipe write is evidence of submission, not of model absorption or completion. */
export function linkPipedOperationTraceInputs(
  chatJid: string,
  messageIds: readonly string[],
): void {
  try {
    const run = activeRuns.get(chatJid);
    if (
      !run ||
      run.closed ||
      !run.database ||
      !run.scope ||
      !run.channel ||
      !run.observer?.attemptId
    )
      return;
    const ids = messageIds.flatMap(
      (id) =>
        getOrCreateOperationTrace(run.database!, run.scope!, id, run.channel!)
          ?.operationIds ?? [],
    );
    if (
      linkOperationTraceInputs(
        run.database,
        run.scope,
        run.observer.attemptId,
        ids,
      )
    ) {
      for (const id of ids)
        settleOperationTraceQueue(run.database, run.scope, id, 'succeeded');
    }
  } catch {
    /* tracing must not affect follow-up delivery */
  }
}

/** Async ownership prevents another chat/background send borrowing a live run. */
export function currentOperationTrace(): OperationTraceObserver | undefined {
  const run = runs.getStore();
  return run?.closed ? undefined : run?.observer;
}

export async function traceAgentExecution<T extends { status: string }>(
  body: () => Promise<T>,
): Promise<T> {
  const observer = currentOperationTrace();
  const agent = startOperationTraceStage(observer, 'agent');
  try {
    const result = await body();
    const outcome = result.status === 'success' ? 'succeeded' : 'unknown';
    // An interrupted child may have performed external effects. Do not call
    // those effects failed merely because the enclosing process failed.
    agent.finish(
      outcome,
      outcome === 'unknown' ? { reason: 'outcome_unknown' } : undefined,
    );
    return result;
  } catch (error) {
    agent.finish('unknown', { reason: 'outcome_unknown' });
    throw error;
  }
}

/** Consume structural CLI observations, never model prose or tool arguments. */
export function createToolTraceRecorder(
  observer: OperationTraceObserver | undefined,
) {
  const spans = new Map<string, OperationTraceSpan>();
  const finished = new Set<string>();
  let closed = false;
  return {
    observe(input: unknown): void {
      try {
        if (closed || !input || typeof input !== 'object') return;
        const frame = input as Record<string, unknown>;
        if (
          frame.source !== 'codex_cli' ||
          typeof frame.callId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            frame.callId,
          ) ||
          !['shell', 'file', 'browser', 'mcp', 'other'].includes(
            String(frame.family),
          ) ||
          !['started', 'finished'].includes(String(frame.phase)) ||
          typeof frame.startedObserved !== 'boolean'
        )
          return;
        if (finished.has(frame.callId)) return;
        let span = spans.get(frame.callId);
        if (!span) {
          if (spans.size + finished.size >= 256) return;
          span = startOperationTraceStage(observer, 'tool', {
            toolFamily: frame.family as
              | 'shell'
              | 'file'
              | 'browser'
              | 'mcp'
              | 'other',
            ...(frame.phase === 'finished'
              ? { reason: 'start_unobserved' as const }
              : {}),
          });
          spans.set(frame.callId, span);
        }
        if (frame.phase === 'finished') {
          const outcome =
            frame.outcome === 'succeeded' || frame.outcome === 'failed'
              ? frame.outcome
              : 'unknown';
          span.finish(outcome);
          spans.delete(frame.callId);
          finished.add(frame.callId);
        }
      } catch {
        /* diagnostic input cannot affect the runtime output stream */
      }
    },
    finish(): void {
      if (closed) return;
      closed = true;
      for (const span of spans.values())
        span.finish('unknown', { reason: 'outcome_unknown' });
      spans.clear();
      finished.clear();
    },
  };
}
