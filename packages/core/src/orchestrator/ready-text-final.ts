import { createHash } from 'node:crypto';

import { findLocalFileLinks } from './local-file-links.js';
import type { NewMessage } from './types.js';

interface StateStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

interface ReadyTextFinal {
  principal: string;
  sourceCursor: string;
  sourceIds: string[];
  sourceDigest: string;
  attemptedThrough: string;
  text: string;
  confirmed: boolean;
  savedAt: number;
  checkpointFiles?: string[];
  unattempted?: true;
}

export const READY_TEXT_RECOVERY_WINDOW = 7 * 24 * 60 * 60 * 1000;
const CURSOR = /^i:\d{16}$/;
const READ_LIMIT = 201;

function inputDigest(rows: NewMessage[]): string {
  return createHash('sha256').update(JSON.stringify(rows.map(m => [
    m.id, m.ingestion_cursor, m.sender, m.content, m.sender_identity?.identity_id,
    m.sender_identity?.bot_id, m.sender_identity?.telegram_message_origin,
  ]))).digest('hex');
}

// If the host exits inside attachment preparation, never infer that the file
// went out. Recovery is text-only and never invokes the attachment tool.
function textBeforeAttachments(text: string): string {
  for (const link of findLocalFileLinks(text).reverse()) {
    text = text.slice(0, link.start) + 'Вложение (доставка файла не подтверждена)' + text.slice(link.end);
  }
  return text;
}

type DeliveryObservation = 'final_ready' | 'saved_final_ack' | 'saved_final_retry';

export function readyTextFinalJournal(store: StateStore, chatJid: string, folder: string,
  observe?: (firstSourceId: string, stage: DeliveryObservation) => void,
) {
  function note(record: ReadyTextFinal, stage: DeliveryObservation) {
    try { observe?.(record.sourceIds[0], stage); } catch { /* Diagnostics never control delivery. */ }
  }
  const stateKey = 'ready_text_final:' + JSON.stringify([chatJid, folder]);
  function read(): ReadyTextFinal | undefined {
    const raw = store.get(stateKey);
    if (!raw) return;
    // A malformed local checkpoint must fail closed, never execute the job.
    const r: ReadyTextFinal = JSON.parse(raw);
    if (!r || typeof r.principal !== 'string' || !Array.isArray(r.sourceIds) ||
        !r.sourceIds.length || r.sourceIds.length > 1000 ||
        !r.sourceIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256) ||
        !/^[0-9a-f]{64}$/.test(r.sourceDigest) || typeof r.confirmed !== 'boolean' ||
        typeof r.text !== 'string' || !Number.isFinite(r.savedAt) ||
        !CURSOR.test(r.sourceCursor) || !CURSOR.test(r.attemptedThrough) || r.attemptedThrough < r.sourceCursor) {
      throw new Error('Malformed ready text final checkpoint');
    }
    return r;
  }
  function save(record: ReadyTextFinal): void {
    store.set(stateKey, JSON.stringify(record));
    if (record.confirmed) note(record, 'saved_final_ack');
  }
  function current(record: ReadyTextFinal): boolean {
    const active = read();
    return active?.sourceDigest === record.sourceDigest && active?.attemptedThrough === record.attemptedThrough;
  }
  function stage(principal: string, sources: NewMessage[], text: string, checkpointFiles?: string[], unattempted?: true): ReadyTextFinal {
    const cursor = sources.at(-1)?.ingestion_cursor;
    if (!cursor) throw new Error('Ready final requires exact source cursor');
    const record = { principal, sourceCursor: cursor, sourceIds: sources.map(m => m.id),
      sourceDigest: inputDigest(sources), attemptedThrough: cursor,
      text: textBeforeAttachments(text), confirmed: false, savedAt: Date.now(),
      ...(checkpointFiles?.length ? { checkpointFiles } : {}), unattempted };
    save(record);
    note(record, 'final_ready');
    return record;
  }
  return { read, save, stage, current, noteRetry: (record: ReadyTextFinal) => note(record, 'saved_final_retry'), clear: () => store.set(stateKey, '') };
}

export type ReadyFinalJournal = ReturnType<typeof readyTextFinalJournal>;

export function isExplicitReadyTextRequest(rawText: string): boolean {
  if (!rawText || rawText.length > 400) return false;
  const text = rawText.trim().replace(/^\[(?:Voice|Audio|Video note)[^\]:]*:\s*([^\]]*)\]$/iu, '$1').trim();
  return /^(?:(?:пришли|пришлите|отправь|покажи|повтори|верни)\s+(?:(?:готовый|последний|предыдущий|сохран[её]нный)\s+)?(?:итог|результат|ответ)(?:\s+(?:ещ[её] раз|повторно))?|где\s+(?:ответ|результат)|ответ\s+не\s+приш[её]л)[.!?…\s]*$/iu.test(text);
}

interface ReadAccess {
  readSources(ids: string[]): NewMessage[];
  readAfter(cursor: string): NewMessage[];
  principal(rows: NewMessage[]): string | undefined;
  acceptsPing(text: string): boolean;
  held(): boolean;
  pendingMedia(): boolean;
}

function verifiedSources(input: ReadAccess, record: ReadyTextFinal): NewMessage[] | undefined {
  if (Date.now() - record.savedAt > READY_TEXT_RECOVERY_WINDOW) return;
  const rows = input.readSources(record.sourceIds);
  if (input.principal(rows) === record.principal && inputDigest(rows) === record.sourceDigest) return rows;
}

function repeatedUnconfirmedInput(record: ReadyTextFinal, sources: NewMessage[], msg: NewMessage): boolean {
  return !record.confirmed && sources.length === 1 && sources[0].content === msg.content;
}

export function readyTextCanSend(input: ReadAccess, journal: ReadyFinalJournal, record: ReadyTextFinal,
  requestCursor?: string): boolean {
  if (input.held() || input.pendingMedia() || !journal.current(record)) return false;
  const sources = verifiedSources(input, record);
  if (!sources) return false;
  const pending = input.readAfter(record.sourceCursor);
  if (!pending.length) return !requestCursor;
  if (pending.length >= READ_LIMIT || input.principal(pending) !== record.principal) return false;
  if (requestCursor && pending.at(-1)?.ingestion_cursor !== requestCursor) return false;
  return pending.every(m => isExplicitReadyTextRequest(m.content) || input.acceptsPing(m.content) ||
    repeatedUnconfirmedInput(record, sources, m) || (sources.length === 1 &&
      sources[0].content === m.content && (m.ingestion_cursor ?? '') <= record.attemptedThrough));
}

export interface PriorFinishedWork {
  principal: string;
  messageId: string;
  text: string;
}

export async function recoverReadyTextFinal(input: ReadAccess & {
  journal: ReadyFinalJournal;
  consumedThrough: string;
  isStop(text: string): boolean;
  prior(work: PriorFinishedWork): void;
  advance(cursor: string): void;
  send(text: string, canSend: () => boolean): Promise<string | null>;
  acknowledged(text: string): void;
}): Promise<'continue' | 'handled'> {
  const { journal } = input;
  const record = journal.read();
  if (!record) return 'continue';

  // A crash after staging, transport or confirmation must never re-execute its input.
  input.advance(record.attemptedThrough);
  const sources = verifiedSources(input, record);
  if (!sources) {
    journal.clear();
    return 'continue';
  }
  const newer = input.readAfter(record.sourceCursor);
  if (input.pendingMedia() && !newer.some(m => input.isStop(m.content))) return 'handled';

  async function sendOnce(target: ReadyTextFinal, requestCursor?: string): Promise<'handled'> {
    let claimed = false;
    // Run the claim inside the outbound router, after asynchronous middleware
    // and immediately before channel hand-off. An unresolved voice correction
    // must leave even the requesting status ping pending.
    const canSend = () => {
      if (!readyTextCanSend(input, journal, target, requestCursor)) return false;
      if (!claimed) {
        delete target.unattempted;
        if (requestCursor) target.attemptedThrough = requestCursor;
        target.confirmed = false;
        journal.save(target);
        if (requestCursor) {
          input.advance(requestCursor);
          journal.noteRetry(target);
        }
        claimed = true;
      }
      return true;
    };
    const delivered = await input.send(target.text, canSend);
    if (delivered && journal.current(target)) {
      target.confirmed = true;
      journal.save(target);
      input.acknowledged(delivered);
    }
    return 'handled';
  }
  if (!newer.length && record.unattempted && !input.held()) return sendOnce(record);
  if (!newer.length) return 'continue';
  if (newer.length >= READ_LIMIT || input.principal(newer) !== record.principal ||
      newer.some(m => input.isStop(m.content))) {
    journal.clear();
    return 'continue';
  }
  const changed = newer.find(m => !isExplicitReadyTextRequest(m.content) && !input.acceptsPing(m.content) &&
    // An exact re-submission that was already answered is a consumed request.
    !(sources.length === 1 && sources[0].content === m.content &&
      ((m.ingestion_cursor ?? '') <= record.attemptedThrough || !record.confirmed)));
  if (changed) {
    if (!record.confirmed && (changed.ingestion_cursor ?? '') > input.consumedThrough) {
      // Keep evidence available across crashes until this correction completes.
      // The stored later message blocks replay for the lifetime of this record.
      input.prior({ principal: record.principal, messageId: changed.id, text: record.text.slice(0, 8000) });
    } else {
      journal.clear();
    }
    return 'continue';
  }
  const fresh = newer.filter(m => (m.ingestion_cursor ?? '') > record.attemptedThrough);
  const last = fresh.at(-1)?.ingestion_cursor;
  if (!last) return 'continue';
  if (record.confirmed && !fresh.some(m => isExplicitReadyTextRequest(m.content))) return 'continue';

  return sendOnce(record, last);
}
