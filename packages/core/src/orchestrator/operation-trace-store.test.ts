import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationTraceDetails } from '@skoobi/shared/operation-trace';
import {
  ensureOperationTraceSchema,
  findOperationTraceForMessage,
  getOrCreateOperationTrace,
  linkOperationTraceInputs,
  pruneOperationTraces,
  queryOperationTimeline,
  queueOperationTrace,
  settleOperationTraceQueue,
  recoverDeadOwnerOperationTraces,
  startOperationTraceAttempt,
  createOperationTraceIpcBinding,
  findOperationTraceForIpc,
  releaseOperationTraceIpcBinding,
  type OperationTraceScope,
} from './operation-trace-store.js';

const scope: OperationTraceScope = {
  tenantId: 'fixture-tenant',
  chatId: 'fixture-chat',
};
const foreign = { ...scope, chatId: 'other-fixture-chat' };
describe('host-owned operation trace storage', () => {
  let dir: string, filename: string, db: Database.Database, time: number;
  const options = { now: () => time };
  const operation = (id = 'message-1', owner = scope) =>
    getOrCreateOperationTrace(db, owner, id, 'telegram', options)!;
  const timeline = (id: string, owner = scope) =>
    queryOperationTimeline(db, owner, id)!;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operation-trace-'));
    filename = path.join(dir, 'state.sqlite');
    db = new Database(filename);
    time = 1_000_000;
    expect(ensureOperationTraceSchema(db)).toBe(true);
  });
  afterEach(() => {
    if (db.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('retains exact IPC binding across database reopen, hashes metadata and bounds lifetime/capacity', () => {
    const input = operation();
    const attempt = startOperationTraceAttempt(
      db,
      scope,
      input.operationIds,
      options,
    )!;
    const token = createOperationTraceIpcBinding(
      db,
      scope,
      'private-folder',
      attempt.attemptId!,
      options,
    )!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      createOperationTraceIpcBinding(
        db,
        foreign,
        'private-folder',
        attempt.attemptId!,
        options,
      ),
    ).toBeUndefined();
    expect(
      JSON.stringify(
        db.prepare('SELECT * FROM operation_trace_ipc_bindings').all(),
      ),
    ).not.toMatch(/private-folder/);
    db.close();
    db = new Database(filename, { readonly: true });
    expect(
      findOperationTraceForIpc(db, 'private-folder', token, options)?.attemptId,
    ).toBe(attempt.attemptId);
    expect(
      findOperationTraceForIpc(db, 'another-folder', token, options),
    ).toBeUndefined();
    db.close();
    db = new Database(filename);
    for (let i = 1; i < 256; i++)
      expect(
        createOperationTraceIpcBinding(
          db,
          scope,
          'private-folder',
          attempt.attemptId!,
          options,
        ),
      ).toBeTruthy();
    expect(
      createOperationTraceIpcBinding(
        db,
        scope,
        'private-folder',
        attempt.attemptId!,
        options,
      ),
    ).toBeUndefined();
    releaseOperationTraceIpcBinding(db, token, options);
    time += 300_001;
    expect(
      findOperationTraceForIpc(db, 'private-folder', token, options),
    ).toBeUndefined();
    expect(
      createOperationTraceIpcBinding(
        db,
        scope,
        'private-folder',
        attempt.attemptId!,
        options,
      ),
    ).toBeTruthy();
    time += 2 * 60 * 60_000;
    pruneOperationTraces(db, options);
    expect(
      db
        .prepare('SELECT count(*) AS n FROM operation_trace_ipc_bindings')
        .get(),
    ).toEqual({ n: 0 });
  });

  it('keeps a stable inbound ID across retries/restart, isolated by tenant, chat and channel', () => {
    const first = operation();
    first.startStage('ingress').finish('succeeded');
    const id = first.operationIds[0];
    expect(operation().operationIds).toEqual([id]);
    expect(operation('message-1', foreign).operationIds[0]).not.toBe(id);
    expect(
      operation('message-1', { ...scope, tenantId: 'another-fixture-tenant' })
        .operationIds[0],
    ).not.toBe(id);
    expect(
      getOrCreateOperationTrace(db, scope, 'message-1', 'whatsapp', options)!
        .operationIds[0],
    ).not.toBe(id);
    db.close();
    db = new Database(filename);
    ensureOperationTraceSchema(db);
    expect(operation().operationIds).toEqual([id]);
    expect(timeline(id).spans[0].status).toBe('succeeded');
  });

  it('finds existing correlations in a read-only database without creating missing inputs', () => {
    const id = operation().operationIds[0];
    db.close();
    db = new Database(filename, { readonly: true });
    expect(
      findOperationTraceForMessage(db, scope, 'message-1', 'telegram')
        ?.operationIds,
    ).toEqual([id]);
    expect(
      findOperationTraceForMessage(db, scope, 'missing', 'telegram'),
    ).toBeUndefined();
    expect(
      findOperationTraceForMessage(db, foreign, 'message-1', 'telegram'),
    ).toBeUndefined();
    expect(
      db.prepare('SELECT count(*) AS n FROM operation_trace_operations').get(),
    ).toEqual({ n: 1 });
  });

  it('links concurrent inbound messages to one attempt and retries to separate attempts', async () => {
    const inputs = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => operation(`batch-${i}`)),
    );
    const ids = inputs.flatMap((input) => [...input.operationIds]);
    expect(new Set(ids).size).toBe(12);
    const first = startOperationTraceAttempt(db, scope, ids, options)!;
    first.startStage('agent').finish('failed', { reason: 'process_timeout' });
    time += 1;
    const retry = startOperationTraceAttempt(db, scope, ids, options)!;
    retry.startStage('agent').finish('succeeded');
    expect(first.attemptId).not.toBe(retry.attemptId);
    for (const id of ids) {
      const view = timeline(id);
      expect(view.spans.map((row) => row.status)).toEqual([
        'failed',
        'succeeded',
      ]);
      expect(view.attempts.map((row) => row.inputCount)).toEqual([12, 12]);
    }
  });

  it('links late corrections with their actual join time, without replacing prior inputs', () => {
    const first = operation();
    const run = startOperationTraceAttempt(
      db,
      scope,
      first.operationIds,
      options,
    )!;
    run.startStage('tool').finish('succeeded');
    time += 100;
    const correction = operation('correction');
    expect(
      linkOperationTraceInputs(
        db,
        scope,
        run.attemptId!,
        correction.operationIds,
        options,
      ),
    ).toBe(true);
    expect(
      linkOperationTraceInputs(
        db,
        scope,
        run.attemptId!,
        correction.operationIds,
        options,
      ),
    ).toBe(true);
    expect(new Set(run.operationIds)).toEqual(
      new Set([...first.operationIds, ...correction.operationIds]),
    );
    const view = timeline(correction.operationIds[0]);
    expect(view.attempts).toEqual([
      {
        attemptId: run.attemptId,
        createdAt: time - 100,
        linkedAt: time,
        inputCount: 2,
      },
    ]);
    expect(view.spans[0].startedAt).toBeLessThan(view.attempts[0].linkedAt);
  });

  it('retains every input in the host default 200-message batch', () => {
    const ids = Array.from(
      { length: 200 },
      (_, i) => operation(`large-batch-${i}`).operationIds[0],
    );
    const run = startOperationTraceAttempt(db, scope, ids, options)!;
    expect(new Set(run.operationIds)).toEqual(new Set(ids));
    run.startStage('agent').finish('succeeded');
    for (const id of ids) {
      const view = timeline(id);
      expect(view.attempts[0].inputCount).toBe(200);
      expect(view.spans[0].attemptId).toBe(run.attemptId);
    }
  });

  it('atomically rejects foreign input links and foreign timeline queries', () => {
    const input = operation(),
      outsider = operation('outsider', foreign);
    const ids = [...input.operationIds, ...outsider.operationIds];
    expect(startOperationTraceAttempt(db, scope, ids)).toBeUndefined();
    expect(
      db.prepare('SELECT count(*) AS n FROM operation_trace_attempts').get(),
    ).toEqual({ n: 0 });
    const run = startOperationTraceAttempt(db, scope, input.operationIds)!;
    expect(linkOperationTraceInputs(db, scope, run.attemptId!, ids)).toBe(
      false,
    );
    expect(
      linkOperationTraceInputs(
        db,
        foreign,
        run.attemptId!,
        outsider.operationIds,
      ),
    ).toBe(false);
    expect(run.operationIds).toEqual(input.operationIds);
    expect(
      queryOperationTimeline(db, foreign, input.operationIds[0]),
    ).toBeUndefined();
    expect(
      queryOperationTimeline(
        db,
        { ...scope, tenantId: 'foreign' },
        input.operationIds[0],
      ),
    ).toBeUndefined();
  });

  it('retains the first terminal outcome and does not call API acknowledgement a human receipt', () => {
    const input = operation();
    const span = input.startStage('delivery', { deliveryKind: 'final' });
    expect(timeline(input.operationIds[0]).spans[0].status).toBe('running');
    time += 15;
    span.finish('unknown', { reason: 'outcome_unknown' });
    span.finish('succeeded', { reason: 'api_acknowledged' });
    expect(timeline(input.operationIds[0]).spans[0]).toMatchObject({
      status: 'unknown',
      startedAt: time - 15,
      finishedAt: time,
      details: { deliveryKind: 'final', reason: 'outcome_unknown' },
    });
  });

  it('marks crash-pending execution/delivery unknown and interrupted preprocessing without replay', () => {
    const input = operation(),
      id = input.operationIds[0];
    input.startStage('download');
    input.startStage('stt');
    input.startStage('agent');
    input.startStage('model_turn');
    input.startStage('tool');
    input.startStage('delivery');
    input.startStage('queue').finish('cancelled');
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const priorOwner = randomUUID();
    db.prepare('UPDATE operation_trace_owners SET owner_id = ?, pid = ?').run(
      priorOwner,
      deadPid,
    );
    db.prepare('UPDATE operation_trace_spans SET owner_id = ?').run(priorOwner);
    db.close();
    db = new Database(filename);
    ensureOperationTraceSchema(db);
    expect(
      timeline(id).spans.filter((row) => row.status === 'running'),
    ).toHaveLength(6);
    time += 100;
    expect(recoverDeadOwnerOperationTraces(db, options)).toBe(6);
    expect(timeline(id).spans.map((row) => row.status)).toEqual([
      'interrupted',
      'interrupted',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'cancelled',
    ]);
    expect(recoverDeadOwnerOperationTraces(db, options)).toBe(0);
    expect(timeline(id).spans).toHaveLength(7);
  });

  it('does not recover live, reused, inaccessible or foreign-host owners', () => {
    const input = operation();
    input.startStage('tool');
    expect(recoverDeadOwnerOperationTraces(db, options)).toBe(0);
    const priorOwner = randomUUID();
    db.prepare('UPDATE operation_trace_owners SET owner_id = ?').run(
      priorOwner,
    );
    db.prepare('UPDATE operation_trace_spans SET owner_id = ?').run(priorOwner);
    // A different owner with our still-live PID is indistinguishable from PID reuse.
    expect(recoverDeadOwnerOperationTraces(db, options)).toBe(0);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('fixture'), { code: 'EPERM' });
    });
    try {
      expect(recoverDeadOwnerOperationTraces(db, options)).toBe(0);
    } finally {
      kill.mockRestore();
    }
    db.prepare(
      "UPDATE operation_trace_owners SET host_key = 'another-host'",
    ).run();
    const dead = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('fixture'), { code: 'ESRCH' });
    });
    try {
      expect(recoverDeadOwnerOperationTraces(db, options)).toBe(0);
      expect(dead).not.toHaveBeenCalled();
    } finally {
      dead.mockRestore();
    }
    expect(timeline(input.operationIds[0]).spans[0].status).toBe('running');
  });

  it('persists one waiting queue across polls/restart, settles only its current wait', () => {
    const input = operation(),
      id = input.operationIds[0];
    expect(queueOperationTrace(db, scope, id, options)).toBe(true);
    expect(queueOperationTrace(db, scope, id, options)).toBe(true);
    expect(timeline(id).spans.map((row) => row.status)).toEqual(['waiting']);
    db.close();
    db = new Database(filename);
    ensureOperationTraceSchema(db);
    expect(queueOperationTrace(db, scope, id, options)).toBe(true);
    expect(
      settleOperationTraceQueue(db, foreign, id, 'succeeded', options),
    ).toBe(false);
    expect(settleOperationTraceQueue(db, scope, id, 'succeeded', options)).toBe(
      true,
    );
    expect(settleOperationTraceQueue(db, scope, id, 'failed', options)).toBe(
      false,
    );
    time += 100;
    expect(queueOperationTrace(db, scope, id, options)).toBe(true);
    expect(settleOperationTraceQueue(db, scope, id, 'cancelled', options)).toBe(
      true,
    );
    expect(timeline(id).spans.map((row) => row.status)).toEqual([
      'succeeded',
      'cancelled',
    ]);
  });

  it('never persists free text or exports source IDs, even from extra runtime fields', () => {
    const privateValue = 'synthetic-sensitive-content-not-for-export';
    const input = operation(privateValue);
    const details = {
      reason: privateValue,
      language: 'ru',
      bytes: 7,
      text: privateValue,
      file: `/fixture/${privateValue}`,
      toolName: privateValue,
      arguments: { secret: privateValue },
    } as unknown as OperationTraceDetails;
    input.startStage('download', details).finish('failed', details);
    const view = timeline(input.operationIds[0]);
    expect(view.spans[0].details).toEqual({ language: 'ru', bytes: 7 });
    const stored =
      JSON.stringify(
        db.prepare('SELECT * FROM operation_trace_operations').all(),
      ) +
      JSON.stringify(db.prepare('SELECT * FROM operation_trace_spans').all());
    for (const forbidden of [privateValue, scope.tenantId, scope.chatId]) {
      expect(stored).not.toContain(forbidden);
      expect(JSON.stringify(view)).not.toContain(forbidden);
    }
    // Even a legacy-shaped or manually added payload cannot enter the export.
    db.exec(
      'ALTER TABLE operation_trace_spans ADD COLUMN private_payload TEXT',
    );
    db.prepare('UPDATE operation_trace_spans SET private_payload = ?').run(
      privateValue,
    );
    db.prepare('UPDATE operation_trace_spans SET details_json = ?').run(
      JSON.stringify({ text: privateValue, bytes: 7 }),
    );
    expect(JSON.stringify(timeline(input.operationIds[0]))).not.toContain(
      privateValue,
    );
  });

  it('paginates ordered observations without duplicate or skipped rows', () => {
    const input = operation();
    for (let i = 0; i < 7; i++)
      input.startStage('stt_recheck', { passIndex: i }).finish('succeeded');
    const seen: number[] = [];
    let afterSequence = 0;
    do {
      const page = queryOperationTimeline(db, scope, input.operationIds[0], {
        afterSequence,
        limit: 2,
      })!;
      seen.push(...page.spans.map((row) => row.details.passIndex!));
      afterSequence = page.nextSequence ?? 0;
    } while (afterSequence);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(
      queryOperationTimeline(db, scope, input.operationIds[0], { limit: 1e9 }),
    ).toBeUndefined();
    expect(
      queryOperationTimeline(db, scope, input.operationIds[0], {
        afterSequence: NaN,
      }),
    ).toBeUndefined();
  });

  it('bounds input sets, per-context spans and attempt fanout without stopping work', () => {
    const inputs = Array.from(
      { length: 513 },
      (_, i) => operation(String(i)).operationIds[0],
    );
    expect(startOperationTraceAttempt(db, scope, inputs)).toBeUndefined();
    const input = operation();
    for (let i = 0; i < 514; i++) input.startStage('tool').finish('succeeded');
    expect(
      db.prepare('SELECT count(*) AS n FROM operation_trace_spans').get(),
    ).toEqual({ n: 512 });
    for (let i = 0; i < 128; i++)
      expect(
        startOperationTraceAttempt(db, scope, input.operationIds),
      ).toBeDefined();
    expect(
      startOperationTraceAttempt(db, scope, input.operationIds),
    ).toBeUndefined();
  });

  it('bounds total operations while preserving existing correlations at capacity', () => {
    const input = operation();
    db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<9999)
      INSERT INTO operation_trace_operations SELECT printf('00000000-0000-4000-8000-%012d',i),'fixture-capacity',CAST(i AS TEXT),'other',0 FROM n`);
    expect(operation().operationIds).toEqual(input.operationIds);
    expect(
      getOrCreateOperationTrace(
        db,
        scope,
        'new-message-at-capacity',
        'telegram',
      ),
    ).toBeUndefined();
    expect(
      db.prepare('SELECT count(*) AS n FROM operation_trace_operations').get(),
    ).toEqual({ n: 10000 });
  });

  it('prunes old trace relationships and spans, without resurrecting old observer handles', () => {
    const old = operation();
    old.startStage('download');
    startOperationTraceAttempt(
      db,
      scope,
      old.operationIds,
      options,
    )!.startStage('agent');
    time += 100;
    const recent = operation('recent');
    recent.startStage('queue');
    const before = timeline(recent.operationIds[0]);
    expect(pruneOperationTraces(db, { ...options, retentionMs: 50 })).toEqual({
      operations: 1,
      attempts: 1,
      spans: 2,
    });
    expect(
      queryOperationTimeline(db, scope, old.operationIds[0]),
    ).toBeUndefined();
    old.startStage('delivery').finish('succeeded');
    expect(
      db.prepare('SELECT count(*) AS n FROM operation_trace_spans').get(),
    ).toEqual({ n: 1 });
    expect(timeline(recent.operationIds[0])).toEqual(before);
    expect(pruneOperationTraces(db, { retentionMs: Infinity })).toBeUndefined();
  });

  it('uses only additive new tables on an old schema and leaves legacy append-only data alone', () => {
    db.exec(
      "CREATE TABLE events(id INTEGER PRIMARY KEY,payload TEXT); INSERT INTO events VALUES(1,'legacy'); CREATE TRIGGER no_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;",
    );
    ensureOperationTraceSchema(db);
    ensureOperationTraceSchema(db);
    operation().startStage('ingress').finish('succeeded');
    recoverDeadOwnerOperationTraces(db);
    pruneOperationTraces(db);
    expect(db.prepare('SELECT * FROM events').all()).toEqual([
      { id: 1, payload: 'legacy' },
    ]);
  });

  it('fails open when storage or the failure notification is unavailable', () => {
    const input = operation(),
      span = input.startStage('stt');
    const failed = vi.fn(() => {
      throw new Error('secondary failure');
    });
    db.close();
    expect(() => span.finish('succeeded')).not.toThrow();
    expect(() => input.startStage('delivery').finish('failed')).not.toThrow();
    expect(
      getOrCreateOperationTrace(db, scope, 'new', 'telegram', {
        onFailure: failed,
      }),
    ).toBeUndefined();
    expect(failed).toHaveBeenCalledOnce();
    expect(ensureOperationTraceSchema(db)).toBe(false);
    expect(
      startOperationTraceAttempt(db, scope, input.operationIds),
    ).toBeUndefined();
    expect(
      linkOperationTraceInputs(db, scope, 'invalid', input.operationIds),
    ).toBe(false);
    expect(
      queryOperationTimeline(db, scope, input.operationIds[0]),
    ).toBeUndefined();
    expect(recoverDeadOwnerOperationTraces(db)).toBeUndefined();
    expect(pruneOperationTraces(db)).toBeUndefined();
  });
});
