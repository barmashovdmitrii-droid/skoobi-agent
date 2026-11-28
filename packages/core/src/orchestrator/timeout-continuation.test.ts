import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureIpcDirectoryLayout } from './ipc-paths.js';
import {
  archiveSupersededContinuationInputs,
  blockTimeoutContinuation,
  cacheTimeoutContinuationDelivery,
  checkpointTimeoutKey,
  claimTimeoutContinuation,
  noteTimeoutContinuationFailureDelivered,
  readTimeoutContinuation,
  retireTimeoutContinuationFinal,
  settleTimeoutContinuation,
  stageTimeoutContinuation,
  timeoutContinuationNotices,
  TIMEOUT_CONTINUATION_NOTE,
} from './timeout-continuation.js';

describe('one bounded autonomous continuation after a task timeout', () => {
  let dir: string;
  let state: Map<string, string>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeout-continuation-'));
    ensureIpcDirectoryLayout(dir);
    state = new Map();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = () => ({
    get: (key: string) => state.get(key),
    set: (key: string, value: string) => {
      state.set(key, value);
    },
  });
  const input = () => ({
    groupIpcDir: dir,
    chatJid: 'tg:owner',
    messageIds: ['1'],
    ingestionCursors: ['i:0000000000000001'],
    directTrustedOwner: true,
    cancelled: false,
    capTimeout: true,
    sideEffectTools: ['schedule_task'],
    store: store(),
  });
  it('one claim survives a fresh process and cannot repeat an ambiguous action automatically', () => {
    const staged = stageTimeoutContinuation(input())!;
    expect(checkpointTimeoutKey(dir, staged.fileName)).toBe(staged.requestKey);
    expect(claimTimeoutContinuation(store(), staged.requestKey)).toBe(true);
    // New store adapter simulates restart after the persisted execution claim.
    expect(claimTimeoutContinuation(store(), staged.requestKey)).toBe(false);
    expect(stageTimeoutContinuation(input())).toBeUndefined();
    blockTimeoutContinuation(dir, store(), staged.requestKey);
    expect(
      fs.existsSync(path.join(dir, 'input', staged.fileName + '.blocked')),
    ).toBe(true);
    expect(fs.existsSync(path.join(dir, 'input', staged.fileName))).toBe(false);
    expect(readTimeoutContinuation(store(), staged.requestKey)).toMatchObject({
      state: 'blocked',
      attempts: 1,
    });
  });
  it.each([
    { directTrustedOwner: false },
    { cancelled: true },
    { capTimeout: false },
  ])(
    'never fabricates authorization or continues after cancellation: %o',
    (over) => {
      expect(stageTimeoutContinuation({ ...input(), ...over })).toBeUndefined();
      expect(state.size).toBe(0);
      expect(fs.readdirSync(path.join(dir, 'input'))).toEqual([]);
    },
  );
  it('uses real host source IDs and explicitly requires verifying unknown effects before acting', () => {
    const staged = stageTimeoutContinuation(input())!;
    const payload = JSON.parse(
      fs.readFileSync(path.join(dir, 'input', staged.fileName), 'utf8'),
    );
    expect(payload.hostSource).toEqual({
      chatJid: 'tg:owner',
      messageIds: ['1'],
      ingestionCursors: ['i:0000000000000001'],
    });
    expect(payload.holdDoneTools).toEqual(['schedule_task']);
    expect(payload.text).toBe(TIMEOUT_CONTINUATION_NOTE);
    expect(payload.text).toContain('не расширение разрешений');
    expect(payload.text).toContain('сначала проверь его результат чтением');
    expect(payload.text).toContain(
      'Если результат проверить нельзя, не повторяй действие',
    );
    expect(payload.text).toContain(
      'отмена, смена задачи и ограничения имеют приоритет',
    );
  });
  it('a failed notice can retry transport without another model execution', () => {
    const staged = stageTimeoutContinuation(input())!;
    claimTimeoutContinuation(store(), staged.requestKey);
    blockTimeoutContinuation(dir, store(), staged.requestKey);
    expect(timeoutContinuationNotices(dir, store())).toHaveLength(1);
    // Failed send: do not mark delivered. Only the notice remains pending.
    expect(timeoutContinuationNotices(dir, store())).toHaveLength(1);
    expect(claimTimeoutContinuation(store(), staged.requestKey)).toBe(false);
    noteTimeoutContinuationFailureDelivered(store(), staged.requestKey);
    expect(timeoutContinuationNotices(dir, store())).toEqual([]);
    expect(
      fs.existsSync(path.join(dir, 'input', staged.fileName + '.blocked')),
    ).toBe(true);
  });
  it('a successful result survives restart as transport-only work and never claims a second execution', () => {
    const staged = stageTimeoutContinuation(input())!;
    claimTimeoutContinuation(store(), staged.requestKey);
    cacheTimeoutContinuationDelivery(
      store(),
      staged.requestKey,
      'Проверено: изменение сохранено.',
      [staged.fileName],
    );
    expect(readTimeoutContinuation(store(), staged.requestKey)).toMatchObject({
      state: 'delivery',
      attempts: 1,
      finalText: 'Проверено: изменение сохранено.',
      finalizedInputFiles: [staged.fileName],
    });
    expect(claimTimeoutContinuation(store(), staged.requestKey)).toBe(false);
    expect(stageTimeoutContinuation(input())).toBeUndefined();
    // A new correction supersedes this cached answer. Evidence stays available,
    // but the old final is no longer pending transport or executable input.
    blockTimeoutContinuation(dir, store(), staged.requestKey);
    noteTimeoutContinuationFailureDelivered(store(), staged.requestKey);
    expect(readTimeoutContinuation(store(), staged.requestKey)).toMatchObject({
      state: 'blocked',
      finalText: 'Проверено: изменение сохранено.',
      noticeSent: true,
    });
    expect(timeoutContinuationNotices(dir, store())).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'input', staged.fileName))).toBe(false);
    expect(claimTimeoutContinuation(store(), staged.requestKey)).toBe(false);
  });
  it('keeps correction coverage distinct from original request identity when a cached final is superseded', () => {
    const staged = stageTimeoutContinuation(input())!;
    const correction = 'correction.json';
    fs.writeFileSync(
      path.join(dir, 'input', correction),
      JSON.stringify({ type: 'message', text: 'updated constraint' }),
    );
    claimTimeoutContinuation(store(), staged.requestKey);
    cacheTimeoutContinuationDelivery(
      store(),
      staged.requestKey,
      'Completed under the updated constraint.',
      [staged.fileName, correction],
      { cursor: 'i:0000000000000002', messageIds: ['1', '2'] },
    );
    expect(readTimeoutContinuation(store(), staged.requestKey)).toMatchObject({
      messageIds: ['1'],
      handledMessageIds: ['1', '2'],
      handledThroughCursor: 'i:0000000000000002',
    });
    retireTimeoutContinuationFinal(dir, store(), staged.requestKey);
    expect(fs.existsSync(path.join(dir, 'input', correction))).toBe(false);
    expect(
      fs.existsSync(path.join(dir, 'input', correction + '.superseded')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(dir, 'input', staged.fileName + '.blocked')),
    ).toBe(true);
    expect(claimTimeoutContinuation(store(), staged.requestKey)).toBe(false);
    expect(timeoutContinuationNotices(dir, store())).toEqual([]);
  });
  it('finishes interrupted retirement before remaining correction files can be scanned by a fresh runner', () => {
    const staged = stageTimeoutContinuation(input())!;
    const correction = 'surviving-correction.json';
    fs.writeFileSync(
      path.join(dir, 'input', correction),
      JSON.stringify({ type: 'message', text: 'already handled' }),
    );
    claimTimeoutContinuation(store(), staged.requestKey);
    cacheTimeoutContinuationDelivery(
      store(),
      staged.requestKey,
      'Result',
      [staged.fileName, correction],
      { cursor: 'i:0000000000000002', messageIds: ['1', '2'] },
    );
    // Crash after only the original input was archived. The host has already
    // persisted exact superseded IDs, so startup selects this surviving file.
    blockTimeoutContinuation(dir, store(), staged.requestKey);
    archiveSupersededContinuationInputs(dir, [correction]);
    expect(
      fs
        .readdirSync(path.join(dir, 'input'))
        .filter((name) => name.endsWith('.json')),
    ).toEqual([]);
    expect(
      fs.existsSync(path.join(dir, 'input', correction + '.superseded')),
    ).toBe(true);
    archiveSupersededContinuationInputs(dir, [correction]); // idempotent restart
  });
  it('checkpoint identity cannot be removed by editing model-visible JSON', () => {
    const staged = stageTimeoutContinuation(input())!;
    fs.writeFileSync(
      path.join(dir, 'input', staged.fileName),
      JSON.stringify({ type: 'message', text: 'changed' }),
    );
    expect(checkpointTimeoutKey(dir, staged.fileName)).toBe(staged.requestKey);
    expect(claimTimeoutContinuation(store(), staged.requestKey)).toBe(true);
  });
  it('a delivered result settles the attempt permanently', () => {
    const staged = stageTimeoutContinuation(input())!;
    claimTimeoutContinuation(store(), staged.requestKey);
    settleTimeoutContinuation(store(), staged.requestKey, true);
    expect(claimTimeoutContinuation(store(), staged.requestKey)).toBe(false);
    expect(stageTimeoutContinuation(input())).toBeUndefined();
  });
});
