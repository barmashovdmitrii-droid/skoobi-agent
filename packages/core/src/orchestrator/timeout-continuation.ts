import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { registerDeferredInputSource } from './deferred-continuation.js';
import {
  resolveExistingSafeIpcCategoryDirectory,
  writeFileAtomicNoFollowSync,
} from './ipc-paths.js';

export interface TimeoutContinuationStore {
  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
}
export interface TimeoutContinuation {
  requestKey: string;
  fileName: string;
  messageIds: string[];
  state: 'pending' | 'running' | 'delivery' | 'blocked' | 'completed';
  attempts: 0 | 1;
  noticeSent?: boolean;
  finalText?: string;
  finalizedInputFiles?: string[];
  handledThroughCursor?: string;
  handledMessageIds?: string[];
}

export function timeoutContinuationKey(
  chatJid: string,
  messageIds: readonly string[],
): string {
  return `timeout_continuation:${createHash('sha256')
    .update(JSON.stringify([chatJid, [...new Set(messageIds)].sort()]))
    .digest('hex')
    .slice(0, 32)}`;
}

export function readTimeoutContinuation(
  store: TimeoutContinuationStore,
  requestKey: string,
): TimeoutContinuation | undefined {
  try {
    const value = JSON.parse(store.get(requestKey) || 'null');
    if (
      value?.requestKey !== requestKey ||
      !['pending', 'running', 'delivery', 'blocked', 'completed'].includes(
        value.state,
      ) ||
      ![0, 1].includes(value.attempts)
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export const TIMEOUT_CONTINUATION_NOTE =
  '[Продолжение исходной задачи после лимита времени, не новое поручение и не расширение разрешений. Сначала восстанови по истории и доступному состоянию: что достоверно сделано, что осталось, исход каких действий неизвестен. Перед повторением любого действия с внешним эффектом сначала проверь его результат чтением. Уже выполненное не повторяй. Если результат проверить нельзя, не повторяй действие: сообщи отдельно известное и неизвестное и остановись на этом препятствии. Продолжай только оставшуюся ранее разрешённую работу. Более новые сообщения пользователя, отмена, смена задачи и ограничения имеют приоритет. Ничего не объявляй готовым без проверки результата. Это единственное автоматическое продолжение этой задачи после таймаута; при новом сбое не запускай ещё одно сам.]';

/** Stage one host checkpoint referencing the real authorized input IDs. */
export function stageTimeoutContinuation(input: {
  groupIpcDir: string;
  chatJid: string;
  messageIds: string[];
  ingestionCursors: string[];
  directTrustedOwner: boolean;
  cancelled: boolean;
  capTimeout: boolean;
  sideEffectTools: string[];
  store: TimeoutContinuationStore;
}): TimeoutContinuation | undefined {
  if (
    !input.directTrustedOwner ||
    input.cancelled ||
    !input.capTimeout ||
    !input.messageIds.length
  )
    return undefined;
  const dir = resolveExistingSafeIpcCategoryDirectory(
    input.groupIpcDir,
    'input',
  );
  if (!dir) return undefined;
  const requestKey = timeoutContinuationKey(input.chatJid, input.messageIds);
  if (readTimeoutContinuation(input.store, requestKey)) return undefined;
  const record: TimeoutContinuation = {
    requestKey,
    fileName: `timeout-${requestKey.split(':')[1]}.json`,
    messageIds: [...new Set(input.messageIds)],
    state: 'pending',
    attempts: 0,
  };
  // Claim identity before exposing work. A crash can lose an automatic attempt,
  // but cannot create an extra one for the same original request.
  input.store.set(requestKey, JSON.stringify(record));
  try {
    registerDeferredInputSource(
      input.chatJid,
      record.fileName,
      {
        messageIds: record.messageIds,
        ingestionCursors: input.ingestionCursors,
      },
      { groupIpcDir: input.groupIpcDir, store: input.store },
    );
    writeFileAtomicNoFollowSync(
      path.join(dir, record.fileName),
      JSON.stringify({
        type: 'message',
        text: TIMEOUT_CONTINUATION_NOTE,
        afterFailedHold: true,
        holdDoneTools: [...new Set(input.sideEffectTools)],
        hostSource: {
          chatJid: input.chatJid,
          messageIds: record.messageIds,
          ingestionCursors: input.ingestionCursors,
        },
        timeoutContinuation: { requestKey },
      }),
    );
  } catch (error) {
    input.store.set(
      requestKey,
      JSON.stringify({ ...record, state: 'blocked' }),
    );
    throw error;
  }
  return record;
}

/** Persist the sole execution claim BEFORE starting the model. */
export function claimTimeoutContinuation(
  store: TimeoutContinuationStore,
  requestKey: string,
): boolean {
  const record = readTimeoutContinuation(store, requestKey);
  if (!record || record.state !== 'pending' || record.attempts !== 0)
    return false;
  store.set(
    requestKey,
    JSON.stringify({ ...record, state: 'running', attempts: 1 }),
  );
  return true;
}

export function settleTimeoutContinuation(
  store: TimeoutContinuationStore,
  requestKey: string,
  delivered: boolean,
): void {
  const record = readTimeoutContinuation(store, requestKey);
  if (!record) return;
  store.set(
    requestKey,
    JSON.stringify({ ...record, state: delivered ? 'completed' : 'blocked' }),
  );
}

/** A successful model result can retry only transport, never execute again. */
export function cacheTimeoutContinuationDelivery(
  store: TimeoutContinuationStore,
  requestKey: string,
  text: string,
  finalizedInputFiles: string[],
  coverage?: { cursor: string; messageIds: string[] },
): void {
  const record = readTimeoutContinuation(store, requestKey);
  if (!record || record.state !== 'running' || !text.trim()) return;
  store.set(
    requestKey,
    JSON.stringify({
      ...record,
      state: 'delivery',
      finalText: text,
      finalizedInputFiles,
      ...(coverage
        ? {
            handledThroughCursor: coverage.cursor,
            handledMessageIds: [...new Set(coverage.messageIds)],
          }
        : {}),
    }),
  );
}

/** Mark a warning only after its transport succeeds; retrying it never runs work. */
export function noteTimeoutContinuationFailureDelivered(
  store: TimeoutContinuationStore,
  requestKey: string,
): void {
  const record = readTimeoutContinuation(store, requestKey);
  if (record)
    store.set(requestKey, JSON.stringify({ ...record, noticeSent: true }));
}

export function checkpointTimeoutKey(
  _groupIpcDir: string,
  name: string,
): string | undefined {
  const match = name.match(/^timeout-([a-f0-9]{32})\.json$/);
  return match ? `timeout_continuation:${match[1]}` : undefined;
}

/** Preserve failed task evidence outside the runner's *.json input scan. */
export function blockTimeoutContinuation(
  groupIpcDir: string,
  store: TimeoutContinuationStore,
  requestKey: string,
): void {
  const record = readTimeoutContinuation(store, requestKey);
  if (!record) return;
  settleTimeoutContinuation(store, requestKey, false);
  const dir = resolveExistingSafeIpcCategoryDirectory(groupIpcDir, 'input');
  if (!dir || !/^timeout-[a-f0-9]{32}\.json$/.test(record.fileName)) return;
  try {
    fs.renameSync(
      path.join(dir, record.fileName),
      path.join(dir, record.fileName + '.blocked'),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function timeoutContinuationNotices(
  groupIpcDir: string,
  store: TimeoutContinuationStore,
): TimeoutContinuation[] {
  const dir = resolveExistingSafeIpcCategoryDirectory(groupIpcDir, 'input');
  if (!dir) return [];
  return fs.readdirSync(dir).flatMap((name) => {
    const match = name.match(/^timeout-([a-f0-9]{32})\.json\.blocked$/);
    const record =
      match &&
      readTimeoutContinuation(store, `timeout_continuation:${match[1]}`);
    return record && record.state === 'blocked' && !record.noticeSent
      ? [record]
      : [];
  });
}

/** Newer input supersedes an undelivered final; preserve its inputs as evidence. */
export function retireTimeoutContinuationFinal(
  groupIpcDir: string,
  store: TimeoutContinuationStore,
  requestKey: string,
): void {
  const record = readTimeoutContinuation(store, requestKey);
  if (!record) return;
  blockTimeoutContinuation(groupIpcDir, store, requestKey);
  noteTimeoutContinuationFailureDelivered(store, requestKey);
  const dir = resolveExistingSafeIpcCategoryDirectory(groupIpcDir, 'input');
  if (!dir) return;
  for (const name of record.finalizedInputFiles ?? []) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(name) ||
      name === record.fileName
    )
      continue;
    try {
      fs.renameSync(path.join(dir, name), path.join(dir, name + '.superseded'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Finish a crash-interrupted retirement before the runner can scan IPC files. */
export function archiveSupersededContinuationInputs(
  groupIpcDir: string,
  names: string[],
): void {
  const dir = resolveExistingSafeIpcCategoryDirectory(groupIpcDir, 'input');
  if (!dir) return;
  for (const name of names) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(name)) continue;
    try {
      fs.renameSync(path.join(dir, name), path.join(dir, name + '.superseded'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
