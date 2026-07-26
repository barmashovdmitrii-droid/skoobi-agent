import { createHash } from 'crypto';

import { escapeXml } from '@skoobi/shared';

import { getDb } from './db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_READ_LIMIT = 50;
const MAX_READ_LIMIT = 500;
const DEFAULT_MAX_CHATS = 5;
const DEFAULT_MAX_MESSAGES_PER_CHAT = 20;
const DEFAULT_MAX_CONTEXT_CHARS = 12_000;
const MAX_CONTEXT_CHARS = 50_000;
const DEFAULT_OBSERVER_TIME_ZONE = 'Asia/Almaty';
const MAX_RELATIVE_RANGE_MS = 10 * 366 * DAY_MS;
const MAX_STORE_BATCH_SIZE = 5_000;

export interface ObservedWhatsAppMessageInput {
  messageId: string;
  chatJid: string;
  chatLabel?: string | null;
  senderLabel?: string | null;
  content: string;
  timestamp: string;
  fromMe: boolean;
  messageKind: string;
  upsertType: string;
  /** True only after local media processing produced the stored content. */
  mediaEnriched?: boolean;
}

export interface ObservedWhatsAppMessageRecord {
  messageId: string;
  chatJid: string;
  chatLabel: string;
  senderLabel: string;
  content: string;
  timestamp: string;
  fromMe: boolean;
  messageKind: string;
  upsertType: string;
  mediaEnriched?: boolean;
  observedAt: string;
}

export interface WhatsAppObserverRetention {
  retentionDays: number;
  maxRows: number;
  /** Deterministic clock injection for tests. */
  now?: Date | string;
}

export interface StoreObservedWhatsAppMessageResult {
  inserted: boolean;
  updated: boolean;
  retained: boolean;
  pruned: number;
}

export interface StoreObservedWhatsAppMessageBatchItemResult {
  inserted: boolean;
  updated: boolean;
  retained: boolean;
}

export interface StoreObservedWhatsAppMessagesBatchResult {
  processed: number;
  inserted: number;
  updated: number;
  retained: number;
  pruned: number;
  results: StoreObservedWhatsAppMessageBatchItemResult[];
}

export interface PruneObservedWhatsAppMessagesResult {
  pruned: number;
  remaining: number;
}

export interface ListObservedWhatsAppMessagesOptions {
  chatJid?: string;
  chatJids?: readonly string[];
  since?: string;
  before?: string;
  fromMe?: boolean;
  messageKinds?: readonly string[];
  limit?: number;
}

export interface SearchObservedWhatsAppMessagesOptions extends Omit<
  ListObservedWhatsAppMessagesOptions,
  'messageKinds'
> {
  includeContent?: boolean;
}

export interface GetObservedWhatsAppMessagesForRequestOptions {
  now?: Date | string;
  timeZone?: string;
  /** Newest-first fallback size for requests without a concrete target. */
  recentLimit?: number;
  /** Maximum matching chats whose bounded transcripts may be loaded. */
  maxCandidateChats?: number;
  /** Maximum newest messages fetched independently for each selected chat. */
  maxMessagesPerChat?: number;
}

interface ObservedWhatsAppMessageRow {
  message_id: string;
  chat_jid: string;
  local_chat_label: string;
  local_sender_label: string;
  content: string;
  timestamp: string;
  from_me: number;
  message_kind: string;
  upsert_type: string;
  media_enriched: number;
  observed_at: string;
}

interface ObservedWhatsAppLabelCandidateRow {
  chat_jid: string;
  local_chat_label: string;
  local_sender_label: string;
  latest_timestamp: string;
}

interface NormalizedObservedWhatsAppMessageInput {
  messageId: string;
  chatJid: string;
  chatLabel: string;
  senderLabel: string;
  content: string;
  timestamp: string;
  fromMe: boolean;
  messageKind: string;
  upsertType: string;
  mediaEnriched: boolean;
}

function requireBoundedText(
  value: string,
  field: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string')
    throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new Error(`${field} must not be empty`);
  if (normalized.length > maxLength) {
    throw new Error(`${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function optionalLabel(value: string | null | undefined): string {
  if (value == null) return '';
  return requireBoundedText(value, 'label', 512, true);
}

function normalizeTimestamp(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new Error(`${field} is invalid`);
  return parsed.toISOString();
}

function validateRetention(options: WhatsAppObserverRetention): {
  retentionDays: number;
  maxRows: number;
  now: string;
  cutoff: string;
} {
  if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) {
    throw new Error('retentionDays must be a positive finite number');
  }
  if (!Number.isSafeInteger(options.maxRows) || options.maxRows <= 0) {
    throw new Error('maxRows must be a positive safe integer');
  }
  const now = normalizeTimestamp(options.now ?? new Date(), 'now');
  const cutoff = new Date(
    new Date(now).getTime() - options.retentionDays * DAY_MS,
  ).toISOString();
  return {
    retentionDays: options.retentionDays,
    maxRows: options.maxRows,
    now,
    cutoff,
  };
}

function hydrateRow(
  row: ObservedWhatsAppMessageRow,
): ObservedWhatsAppMessageRecord {
  return {
    messageId: row.message_id,
    chatJid: row.chat_jid,
    chatLabel: row.local_chat_label,
    senderLabel: row.local_sender_label,
    content: row.content,
    timestamp: row.timestamp,
    fromMe: row.from_me === 1,
    messageKind: row.message_kind,
    upsertType: row.upsert_type,
    mediaEnriched: row.media_enriched === 1,
    observedAt: row.observed_at,
  };
}

function pruneObservedRows(
  database: ReturnType<typeof getDb>,
  bounds: ReturnType<typeof validateRetention>,
): PruneObservedWhatsAppMessagesResult {
  let pruned = database
    .prepare(`DELETE FROM observed_whatsapp_messages WHERE timestamp < ?`)
    .run(bounds.cutoff).changes;
  const rowCount = (
    database
      .prepare(`SELECT COUNT(*) AS count FROM observed_whatsapp_messages`)
      .get() as { count: number }
  ).count;
  const overflow = Math.max(0, rowCount - bounds.maxRows);
  if (overflow > 0) {
    pruned += database
      .prepare(
        `DELETE FROM observed_whatsapp_messages
         WHERE rowid IN (
           SELECT rowid FROM observed_whatsapp_messages
           ORDER BY timestamp ASC, message_id ASC, chat_jid ASC
           LIMIT ?
         )`,
      )
      .run(overflow).changes;
  }
  const remaining = (
    database
      .prepare(`SELECT COUNT(*) AS count FROM observed_whatsapp_messages`)
      .get() as { count: number }
  ).count;
  return { pruned, remaining };
}

/** Enforce retention even when no new WhatsApp traffic is arriving. */
export function pruneObservedWhatsAppMessages(
  retention: WhatsAppObserverRetention,
): PruneObservedWhatsAppMessagesResult {
  const bounds = validateRetention(retention);
  const database = getDb();
  return database.transaction(() => pruneObservedRows(database, bounds))();
}

function normalizeObservedWhatsAppMessageInput(
  input: ObservedWhatsAppMessageInput,
  index?: number,
): NormalizedObservedWhatsAppMessageInput {
  const field = (name: string) =>
    index === undefined ? name : `inputs[${index}].${name}`;
  const messageId = requireBoundedText(
    input.messageId,
    field('messageId'),
    512,
  );
  const chatJid = requireBoundedText(input.chatJid, field('chatJid'), 512);
  const messageKind = requireBoundedText(
    input.messageKind,
    field('messageKind'),
    64,
  );
  const upsertType = requireBoundedText(
    input.upsertType,
    field('upsertType'),
    64,
  );
  if (typeof input.content !== 'string') {
    throw new TypeError(`${field('content')} must be a string`);
  }
  if (typeof input.fromMe !== 'boolean') {
    throw new TypeError(`${field('fromMe')} must be a boolean`);
  }
  return {
    messageId,
    chatJid,
    chatLabel: optionalLabel(input.chatLabel),
    senderLabel: optionalLabel(input.senderLabel),
    content: input.content,
    timestamp: normalizeTimestamp(input.timestamp, field('timestamp')),
    fromMe: input.fromMe,
    messageKind,
    upsertType,
    mediaEnriched: input.mediaEnriched === true,
  };
}

/**
 * Upsert a bounded history batch atomically. Every item is validated before
 * SQLite is touched, prepared statements are reused inside one transaction,
 * and retention runs exactly once after all writes. Item results are aligned
 * with input order; duplicate keys therefore report insert then update while
 * still producing one final database row (last value wins).
 */
export function storeObservedWhatsAppMessagesBatch(
  inputs: readonly ObservedWhatsAppMessageInput[],
  retention: WhatsAppObserverRetention,
): StoreObservedWhatsAppMessagesBatchResult {
  if (!Array.isArray(inputs)) {
    throw new TypeError('inputs must be an array');
  }
  if (inputs.length > MAX_STORE_BATCH_SIZE) {
    throw new Error(
      `WhatsApp observer batch exceeds ${MAX_STORE_BATCH_SIZE} items; split history into chunks of at most ${MAX_STORE_BATCH_SIZE}`,
    );
  }
  const bounds = validateRetention(retention);
  // Keep this map outside the transaction: a bad late item cannot leave an
  // earlier upsert behind.
  const normalizedInputs = inputs.map((input, index) =>
    normalizeObservedWhatsAppMessageInput(input, index),
  );
  const database = getDb();

  return database.transaction(() => {
    const existedStatement = database.prepare(
      `SELECT 1 FROM observed_whatsapp_messages
       WHERE message_id = ? AND chat_jid = ?`,
    );
    const upsertStatement = database.prepare(
      `INSERT INTO observed_whatsapp_messages (
         message_id, chat_jid, local_chat_label, local_sender_label,
         content, timestamp, from_me, message_kind, upsert_type,
         media_enriched, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id, chat_jid) DO UPDATE SET
         local_chat_label = excluded.local_chat_label,
         local_sender_label = excluded.local_sender_label,
         content = CASE
           WHEN observed_whatsapp_messages.media_enriched = 1
                AND excluded.media_enriched = 0
             THEN observed_whatsapp_messages.content
           ELSE excluded.content
         END,
         timestamp = excluded.timestamp,
         from_me = excluded.from_me,
         message_kind = excluded.message_kind,
         upsert_type = excluded.upsert_type,
         media_enriched = MAX(
           observed_whatsapp_messages.media_enriched,
           excluded.media_enriched
         ),
         observed_at = excluded.observed_at`,
    );
    const operations = normalizedInputs.map((input) => {
      const existed = Boolean(
        existedStatement.get(input.messageId, input.chatJid),
      );
      upsertStatement.run(
        input.messageId,
        input.chatJid,
        input.chatLabel,
        input.senderLabel,
        input.content,
        input.timestamp,
        input.fromMe ? 1 : 0,
        input.messageKind,
        input.upsertType,
        input.mediaEnriched ? 1 : 0,
        bounds.now,
      );
      return { input, existed };
    });

    const { pruned } = pruneObservedRows(database, bounds);
    const retainedStatement = database.prepare(
      `SELECT 1 FROM observed_whatsapp_messages
       WHERE message_id = ? AND chat_jid = ?`,
    );
    const results = operations.map(({ input, existed }) => {
      const retained = Boolean(
        retainedStatement.get(input.messageId, input.chatJid),
      );
      return {
        inserted: !existed && retained,
        updated: existed && retained,
        retained,
      };
    });
    return {
      processed: results.length,
      inserted: results.filter((result) => result.inserted).length,
      updated: results.filter((result) => result.updated).length,
      retained: results.filter((result) => result.retained).length,
      pruned,
      results,
    };
  })();
}

/**
 * Insert or update one locally observed WhatsApp message, then enforce both
 * age and row-count retention in the same SQLite transaction. This function
 * deliberately has no logging path: message content and local labels stay in
 * the local database only.
 */
export function storeObservedWhatsAppMessage(
  input: ObservedWhatsAppMessageInput,
  retention: WhatsAppObserverRetention,
): StoreObservedWhatsAppMessageResult {
  const batch = storeObservedWhatsAppMessagesBatch([input], retention);
  const result = batch.results[0];
  if (!result) throw new Error('single-message batch returned no result');
  return { ...result, pruned: batch.pruned };
}

function normalizeReadLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_READ_LIMIT;
  if (!Number.isFinite(limit)) throw new Error('limit must be finite');
  if (limit <= 0) return 0;
  return Math.min(MAX_READ_LIMIT, Math.floor(limit));
}

function buildListQuery(options: ListObservedWhatsAppMessagesOptions): {
  sql: string;
  params: Array<string | number>;
  limit: number;
} {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  let chatJids: string[] | undefined;
  if (options.chatJids !== undefined) {
    chatJids = [
      ...new Set(options.chatJids.map((jid) => jid.trim()).filter(Boolean)),
    ];
  } else if (options.chatJid !== undefined) {
    const normalizedChatJid = options.chatJid.trim();
    chatJids = normalizedChatJid ? [normalizedChatJid] : [];
  }
  if (
    (options.chatJids !== undefined || options.chatJid !== undefined) &&
    chatJids?.length === 0
  ) {
    return { sql: '', params: [], limit: 0 };
  }
  if (chatJids?.length) {
    clauses.push(`chat_jid IN (${chatJids.map(() => '?').join(',')})`);
    params.push(...chatJids);
  }
  if (options.since) {
    clauses.push('timestamp >= ?');
    params.push(normalizeTimestamp(options.since, 'since'));
  }
  if (options.before) {
    clauses.push('timestamp < ?');
    params.push(normalizeTimestamp(options.before, 'before'));
  }
  if (options.fromMe !== undefined) {
    clauses.push('from_me = ?');
    params.push(options.fromMe ? 1 : 0);
  }
  if (options.messageKinds) {
    const kinds = [
      ...new Set(
        options.messageKinds.map((kind) => kind.trim()).filter(Boolean),
      ),
    ];
    if (kinds.length === 0) return { sql: '', params: [], limit: 0 };
    clauses.push(`message_kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return {
    sql: `SELECT * FROM observed_whatsapp_messages ${where}
          ORDER BY timestamp DESC, message_id DESC, chat_jid DESC`,
    params,
    limit: normalizeReadLimit(options.limit),
  };
}

/** List matching records newest-first. */
export function listObservedWhatsAppMessages(
  options: ListObservedWhatsAppMessagesOptions = {},
): ObservedWhatsAppMessageRecord[] {
  const query = buildListQuery(options);
  if (!query.sql || query.limit === 0) return [];
  const rows = getDb()
    .prepare(`${query.sql} LIMIT ?`)
    .all(...query.params, query.limit) as ObservedWhatsAppMessageRow[];
  return rows.map(hydrateRow);
}

/** Convenience alias whose name makes newest-first intent explicit. */
export function getRecentObservedWhatsAppMessages(
  options: ListObservedWhatsAppMessagesOptions = {},
): ObservedWhatsAppMessageRecord[] {
  return listObservedWhatsAppMessages(options);
}

/**
 * Unicode-aware local substring search over chat labels, sender labels, and
 * (unless disabled) content. Iteration is streaming and stops at the bounded
 * result limit; unlike SQLite NOCASE this also handles Cyrillic casing.
 */
export function searchObservedWhatsAppMessages(
  search: string,
  options: SearchObservedWhatsAppMessagesOptions = {},
): ObservedWhatsAppMessageRecord[] {
  const needle = search.trim().toLocaleLowerCase('und');
  if (!needle) return [];
  const query = buildListQuery(options);
  if (!query.sql || query.limit === 0) return [];
  const results: ObservedWhatsAppMessageRecord[] = [];
  const statement = getDb().prepare(query.sql);
  for (const raw of statement.iterate(...query.params)) {
    const row = raw as ObservedWhatsAppMessageRow;
    const candidates = [row.local_chat_label, row.local_sender_label];
    if (options.includeContent !== false) candidates.push(row.content);
    if (
      candidates.some((value) =>
        value.toLocaleLowerCase('und').includes(needle),
      )
    ) {
      results.push(hydrateRow(row));
      if (results.length >= query.limit) break;
    }
  }
  return results;
}

export type WhatsAppObserverContextMode =
  | 'empty'
  | 'index'
  | 'ambiguous'
  | 'transcript';

export interface BuildWhatsAppObserverContextOptions {
  request: string;
  messages: readonly ObservedWhatsAppMessageRecord[];
  maxChats?: number;
  maxMessagesPerChat?: number;
  maxChars?: number;
  /** Deterministic clock injection for relative-range filtering. */
  now?: Date | string;
  /** IANA time zone used for calendar ranges such as today/yesterday. */
  timeZone?: string;
}

export interface WhatsAppObserverContextResult {
  mode: WhatsAppObserverContextMode;
  reason:
    | 'no_messages'
    | 'no_explicit_correspondence_request'
    | 'no_matching_chat'
    | 'ambiguous_contact_match'
    | 'no_message_content'
    | 'explicit_correspondence_request';
  xml: string;
  selectedChatRefs: string[];
  chatCount: number;
  messageCount: number;
  truncated: boolean;
}

interface RankedChat {
  chatJid: string;
  chatRef: string;
  chatLabel: string;
  senderLabels: string[];
  latestTimestamp: string;
  messages: ObservedWhatsAppMessageRecord[];
  score: number;
}

const REQUEST_STOPWORDS = new Set([
  'а',
  'без',
  'бы',
  'в',
  'вам',
  'вас',
  'весь',
  'во',
  'вот',
  'вы',
  'где',
  'давай',
  'два',
  'две',
  'дня',
  'дней',
  'день',
  'для',
  'его',
  'ее',
  'её',
  'и',
  'из',
  'или',
  'их',
  'за',
  'к',
  'как',
  'кто',
  'мне',
  'мои',
  'мою',
  'мой',
  'моя',
  'мы',
  'на',
  'найди',
  'наш',
  'несколько',
  'новое',
  'нового',
  'новости',
  'новый',
  'один',
  'одна',
  'одну',
  'неделя',
  'недели',
  'неделю',
  'недель',
  'не',
  'о',
  'об',
  'он',
  'она',
  'от',
  'пару',
  'по',
  'покажи',
  'последние',
  'последний',
  'посмотри',
  'прочитай',
  'проверь',
  'про',
  'с',
  'со',
  'сообщение',
  'сообщения',
  'сообщений',
  'сегодня',
  'там',
  'час',
  'часа',
  'часов',
  'минута',
  'минуту',
  'минуты',
  'минут',
  'месяц',
  'месяца',
  'месяцев',
  'год',
  'года',
  'лет',
  'три',
  'вчера',
  'переписка',
  'переписку',
  'переписки',
  'чат',
  'чате',
  'чата',
  'чаты',
  'что',
  'эта',
  'это',
  'я',
  'about',
  'all',
  'and',
  'at',
  'chat',
  'check',
  'couple',
  'conversation',
  'correspondence',
  'did',
  'find',
  'few',
  'for',
  'from',
  'history',
  'hour',
  'hours',
  'in',
  'last',
  'latest',
  'me',
  'message',
  'messages',
  'minute',
  'minutes',
  'my',
  'of',
  'on',
  'one',
  'please',
  'read',
  'recent',
  'review',
  'say',
  'said',
  'show',
  'some',
  'three',
  'the',
  'today',
  'to',
  'two',
  'what',
  'day',
  'days',
  'week',
  'weeks',
  'month',
  'months',
  'with',
  'four',
  'write',
  'wrote',
  'yesterday',
]);

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function stemToken(token: string): string {
  if (/^[а-яё]+$/u.test(token) && token.length >= 4) {
    const stemmed = token.replace(
      /(?:иями|ями|ами|ого|ему|ому|ими|ыми|ией|ией|ой|ей|ою|ею|ую|юю|ах|ях|ом|ем|а|я|у|ю|е|и|ы)$/u,
      '',
    );
    if (stemmed.length >= 3) return stemmed;
  }
  if (/^[a-z]+$/u.test(token) && token.length >= 5) {
    return token.replace(/(?:ing|ed|es|s)$/u, '') || token;
  }
  return token;
}

function matchTokens(value: string): Set<string> {
  return new Set(
    normalizeForMatch(value)
      .split(' ')
      .filter((token) => token.length >= 2)
      .map(stemToken),
  );
}

function requestedOpaqueChatRefs(request: string): string[] {
  const matches = request
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .match(/(?:^|[^\p{L}\p{N}_])(wa_[0-9a-f]{10})(?=$|[^\p{L}\p{N}_])/gu);
  if (!matches) return [];
  return [
    ...new Set(
      matches
        .map((value) => value.match(/wa_[0-9a-f]{10}/u)?.[0])
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

export function isExplicitWhatsAppCorrespondenceRequest(
  request: string,
): boolean {
  if (requestedOpaqueChatRefs(request).length > 0) return true;
  const normalized = normalizeForMatch(request);
  if (!normalized) return false;
  const hasCorrespondenceNoun =
    /(?:переписк|сообщени|истори[яи] чата|диалог|chat history|messages?|conversation|correspondence)/u.test(
      normalized,
    );
  const hasRequestAction =
    /(?:покаж|посмотр|прочит|найд|проверь|расскаж|последн|недавн|что нов|что пис|что написал|что говор|show|read|find|check|review|summari|latest|recent|what did|what has)/u.test(
      normalized,
    );
  const namesCorrespondent =
    /(?:переписк|сообщени|chat|messages?|conversation|correspondence)\s+(?:с|со|от|with|from)\s+/u.test(
      normalized,
    );
  const directWhatDidTheySay =
    /(?:что(?:\s+(?:мне|там))?(?:\s+[\p{L}\p{N}-]+){0,4}\s+(?:писал[аи]?|написал[аи]?|пиш(?:ет|ут)|говорил[аи]?)|кто(?:\s+мне)?\s+писал|what\s+did\s+.+\s+(?:say|write))/u.test(
      normalized,
    );
  const latestFromContact =
    /(?:покаж|посмотр|прочит|проверь)[\p{L}\p{M}]*\s+последн[\p{L}\p{M}]*\s+(?:сообщени[\p{L}\p{M}]*\s+)?от\s+[\p{L}\p{M}]/u.test(
      normalized,
    );
  const draftOrReplyRequest =
    /(?:(?:что|как)\s+ответить|(?:подготов|состав|напиш|сделай)[\p{L}\p{M}]*\s+(?:мне\s+)?(?:черновик|ответ)|(?:черновик|вариант)\s+ответ)/u.test(
      normalized,
    );
  return (
    (hasCorrespondenceNoun && (hasRequestAction || namesCorrespondent)) ||
    directWhatDidTheySay ||
    latestFromContact ||
    draftOrReplyRequest
  );
}

export interface WhatsAppObserverRequestRange {
  since: string;
  before?: string;
}

function safeIsoDate(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  try {
    return date.toISOString();
  } catch {
    return undefined;
  }
}

function zonedDateParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number } | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const value = (type: 'year' | 'month' | 'day') =>
      Number(parts.find((part) => part.type === type)?.value);
    const year = value('year');
    const month = value('month');
    const day = value('day');
    if (![year, month, day].every(Number.isSafeInteger)) return undefined;
    return { year, month, day };
  } catch {
    return undefined;
  }
}

function zonedLocalMidnight(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number | undefined {
  const targetAsUtc = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(targetAsUtc)) return undefined;
  let candidate = targetAsUtc;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    // Re-evaluate the offset to cover zones whose offset changes near midnight.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = formatter.formatToParts(new Date(candidate));
      const value = (
        type: 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second',
      ) => Number(parts.find((part) => part.type === type)?.value);
      const representedAsUtc = Date.UTC(
        value('year'),
        value('month') - 1,
        value('day'),
        value('hour'),
        value('minute'),
        value('second'),
      );
      if (!Number.isFinite(representedAsUtc)) return undefined;
      const next = targetAsUtc - (representedAsUtc - candidate);
      if (!Number.isFinite(next)) return undefined;
      if (next === candidate) break;
      candidate = next;
    }
    return candidate;
  } catch {
    return undefined;
  }
}

function calendarRequestRange(
  normalized: string,
  now: Date,
  timeZone: string,
): WhatsAppObserverRequestRange | undefined {
  const todayRequested = /(?:^|\s)(?:сегодня|today)(?:$|\s)/u.test(normalized);
  const yesterdayRequested = /(?:^|\s)(?:вчера|yesterday)(?:$|\s)/u.test(
    normalized,
  );
  if (!todayRequested && !yesterdayRequested) return undefined;
  const local = zonedDateParts(now, timeZone);
  if (!local) return undefined;
  const todayStart = zonedLocalMidnight(
    local.year,
    local.month,
    local.day,
    timeZone,
  );
  if (todayStart === undefined) return undefined;
  if (todayRequested) {
    const since = safeIsoDate(todayStart);
    return since ? { since } : undefined;
  }
  const previousCalendarDay = new Date(
    Date.UTC(local.year, local.month - 1, local.day - 1),
  );
  const yesterdayStart = zonedLocalMidnight(
    previousCalendarDay.getUTCFullYear(),
    previousCalendarDay.getUTCMonth() + 1,
    previousCalendarDay.getUTCDate(),
    timeZone,
  );
  const since =
    yesterdayStart === undefined ? undefined : safeIsoDate(yesterdayStart);
  const before = safeIsoDate(todayStart);
  return since && before ? { since, before } : undefined;
}

export function whatsappObserverRangeForRequest(
  request: string,
  now: Date | string = new Date(),
  timeZone = DEFAULT_OBSERVER_TIME_ZONE,
): WhatsAppObserverRequestRange | undefined {
  const normalized = normalizeForMatch(request);
  const parsedNow = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(parsedNow.getTime())) return undefined;
  const calendarRange = calendarRequestRange(normalized, parsedNow, timeZone);
  if (calendarRange) return calendarRange;
  const numberWords: Record<string, number> = {
    один: 1,
    одна: 1,
    одну: 1,
    два: 2,
    две: 2,
    три: 3,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
  };
  const match = normalized.match(
    /(?:за\s+(?:последн[\p{L}\p{M}]*\s+)?|последн[\p{L}\p{M}]*\s+|last\s+)(?:(\d+|один|одна|одну|два|две|три|one|two|three|four)\s+)?(минут[\p{L}\p{M}]*|час[\p{L}\p{M}]*|д(?:ень|ня|ней)|недел[\p{L}\p{M}]*|месяц[\p{L}\p{M}]*|minute[\p{L}\p{M}]*|hour[\p{L}\p{M}]*|day[\p{L}\p{M}]*|week[\p{L}\p{M}]*|month[\p{L}\p{M}]*)/u,
  );
  if (!match) return undefined;
  const unit = match[2];
  const unitMs = /^(?:минут|minute)/u.test(unit)
    ? 60_000
    : /^(?:час|hour)/u.test(unit)
      ? 60 * 60_000
      : /^(?:д|day)/u.test(unit)
        ? DAY_MS
        : /^(?:недел|week)/u.test(unit)
          ? 7 * DAY_MS
          : 30 * DAY_MS;
  const rawCount = match[1]
    ? /^\d+$/u.test(match[1])
      ? match[1].length > 9
        ? Number.POSITIVE_INFINITY
        : Number(match[1])
      : numberWords[match[1]]
    : 1;
  const maxCount = Math.max(1, Math.floor(MAX_RELATIVE_RANGE_MS / unitMs));
  const count = Math.min(
    maxCount,
    Math.max(1, Number.isFinite(rawCount) ? rawCount : maxCount),
  );
  const since = safeIsoDate(parsedNow.getTime() - count * unitMs);
  return since ? { since } : undefined;
}

/** Parse common ranges so a bounded request need not load unrelated rows. */
export function whatsappObserverSinceForRequest(
  request: string,
  now: Date | string = new Date(),
  timeZone = DEFAULT_OBSERVER_TIME_ZONE,
): string | undefined {
  return whatsappObserverRangeForRequest(request, now, timeZone)?.since;
}

function targetTokens(request: string): Set<string> {
  const tokens = normalizeForMatch(request).split(' ').filter(Boolean);
  return new Set(
    tokens
      .filter(
        (token) =>
          !REQUEST_STOPWORDS.has(token) &&
          !/^(?:переписк|сообщ|последн|недавн|нов|покаж|посмотр|прочит|проверь|расскаж|найд|напис|пис|говорил|ответ|черновик|подготов|состав|сделай|час|минут|дн|день|недел|месяц|год|лет|сегодн|вчер|диалог|истори|chat|message|conversation|correspondence|show|read|find|check|review|summari|recent|latest|today|yesterday|hour|minute|day|week|month)/u.test(
            stemToken(token),
          ),
      )
      .map(stemToken)
      .filter((token) => token.length >= 2),
  );
}

function opaqueChatRef(chatJid: string): string {
  return `wa_${createHash('sha256').update(chatJid).digest('hex').slice(0, 10)}`;
}

interface ObservedWhatsAppChatCandidate {
  chatJid: string;
  chatRef: string;
  chatLabels: Set<string>;
  senderLabels: Set<string>;
  latestTimestamp: string;
  score: number;
}

function observedRequestReadOptions(
  range: WhatsAppObserverRequestRange | undefined,
  limit: number,
  chatJid?: string,
): ListObservedWhatsAppMessagesOptions {
  return {
    chatJid,
    since: range?.since,
    before: range?.before,
    limit,
  };
}

/**
 * Fetch observer rows for one explicit owner request without letting the
 * global newest-row window hide an older named chat. Candidate discovery reads
 * local labels and opaque chat ids only; message content is fetched only after
 * a bounded set of chats has been selected.
 */
export function getObservedWhatsAppMessagesForRequest(
  request: string,
  options: GetObservedWhatsAppMessagesForRequestOptions = {},
): ObservedWhatsAppMessageRecord[] {
  const range = whatsappObserverRangeForRequest(
    request,
    options.now,
    options.timeZone,
  );
  const recentLimit = normalizeReadLimit(options.recentLimit ?? MAX_READ_LIMIT);
  const fallbackRecent = () =>
    getRecentObservedWhatsAppMessages(
      observedRequestReadOptions(range, recentLimit),
    );
  if (!isExplicitWhatsAppCorrespondenceRequest(request)) {
    return fallbackRecent();
  }

  const requestedTokens = targetTokens(request);
  const requestedRefs = requestedOpaqueChatRefs(request);
  if (requestedTokens.size === 0 && requestedRefs.length === 0) {
    return fallbackRecent();
  }

  const clauses: string[] = [];
  const params: string[] = [];
  if (range?.since) {
    clauses.push('timestamp >= ?');
    params.push(normalizeTimestamp(range.since, 'since'));
  }
  if (range?.before) {
    clauses.push('timestamp < ?');
    params.push(normalizeTimestamp(range.before, 'before'));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  // Deliberately omit `content`: target selection is label/ref-only.
  const rows = getDb()
    .prepare(
      `SELECT chat_jid, local_chat_label, local_sender_label,
              MAX(timestamp) AS latest_timestamp
       FROM observed_whatsapp_messages
       ${where}
       GROUP BY chat_jid, local_chat_label, local_sender_label
       ORDER BY latest_timestamp DESC, chat_jid ASC`,
    )
    .all(...params) as ObservedWhatsAppLabelCandidateRow[];

  const byChat = new Map<string, ObservedWhatsAppChatCandidate>();
  for (const row of rows) {
    let candidate = byChat.get(row.chat_jid);
    if (!candidate) {
      candidate = {
        chatJid: row.chat_jid,
        chatRef: opaqueChatRef(row.chat_jid),
        chatLabels: new Set(),
        senderLabels: new Set(),
        latestTimestamp: row.latest_timestamp,
        score: 0,
      };
      byChat.set(row.chat_jid, candidate);
    }
    if (row.local_chat_label) candidate.chatLabels.add(row.local_chat_label);
    if (row.local_sender_label) {
      candidate.senderLabels.add(row.local_sender_label);
    }
    if (row.latest_timestamp > candidate.latestTimestamp) {
      candidate.latestTimestamp = row.latest_timestamp;
    }
  }

  const candidates = [...byChat.values()];
  for (const candidate of candidates) {
    const chatTokenSets = [...candidate.chatLabels].map(matchTokens);
    const senderTokenSets = [...candidate.senderLabels].map(matchTokens);
    for (const token of requestedTokens) {
      if (chatTokenSets.some((tokens) => tokens.has(token))) {
        candidate.score += 30;
      }
      if (senderTokenSets.some((tokens) => tokens.has(token))) {
        candidate.score += 20;
      }
    }
  }
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      b.latestTimestamp.localeCompare(a.latestTimestamp) ||
      a.chatRef.localeCompare(b.chatRef),
  );

  const matching = requestedRefs.length
    ? candidates.filter((candidate) =>
        requestedRefs.includes(candidate.chatRef),
      )
    : candidates.filter((candidate) => candidate.score > 0);
  if (matching.length === 0) return fallbackRecent();

  const maxCandidateChats = normalizeContextBound(
    options.maxCandidateChats,
    20,
    20,
  );
  const maxMessagesPerChat = normalizeContextBound(
    options.maxMessagesPerChat,
    DEFAULT_MAX_MESSAGES_PER_CHAT,
    100,
  );
  if (maxCandidateChats === 0 || maxMessagesPerChat === 0) return [];

  return matching
    .slice(0, maxCandidateChats)
    .flatMap((candidate) =>
      getRecentObservedWhatsAppMessages(
        observedRequestReadOptions(
          range,
          maxMessagesPerChat,
          candidate.chatJid,
        ),
      ),
    );
}

function safeDisplayLabel(value: string, fallback: string): string {
  const label = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\S+@(?:s\.whatsapp\.net|g\.us|lid)\b/gi, ' ')
    .replace(/\+?\d(?:[\d\s().-]{4,}\d)/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!label) return fallback;
  return [...label].slice(0, 120).join('');
}

function xmlText(value: string): string {
  return escapeXml(
    value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''),
  );
}

function normalizeContextBound(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(maximum, Math.floor(value));
}

function rankChats(
  records: readonly ObservedWhatsAppMessageRecord[],
  requestedTokens: Set<string>,
): RankedChat[] {
  const grouped = new Map<string, ObservedWhatsAppMessageRecord[]>();
  for (const record of records) {
    const existing = grouped.get(record.chatJid);
    if (existing) existing.push(record);
    else grouped.set(record.chatJid, [record]);
  }

  const ranked: RankedChat[] = [];
  for (const [chatJid, messages] of grouped) {
    const ordered = [...messages].sort(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp) ||
        a.messageId.localeCompare(b.messageId),
    );
    const newest = ordered[ordered.length - 1];
    const rawChatLabel =
      [...ordered].reverse().find((message) => message.chatLabel)?.chatLabel ||
      '';
    const rawSenderLabels = [
      ...new Set(ordered.map((message) => message.senderLabel).filter(Boolean)),
    ];
    const chatTokens = matchTokens(rawChatLabel);
    const senderTokenSets = rawSenderLabels.map(matchTokens);
    let score = 0;
    for (const token of requestedTokens) {
      if (chatTokens.has(token)) score += 30;
      if (senderTokenSets.some((tokens) => tokens.has(token))) score += 20;
    }
    ranked.push({
      chatJid,
      chatRef: opaqueChatRef(chatJid),
      chatLabel: safeDisplayLabel(rawChatLabel, 'Чат без названия'),
      senderLabels: rawSenderLabels.map((label) =>
        safeDisplayLabel(label, 'Контакт'),
      ),
      latestTimestamp: newest.timestamp,
      messages: ordered,
      score,
    });
  }
  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.latestTimestamp.localeCompare(a.latestTimestamp) ||
      a.chatRef.localeCompare(b.chatRef),
  );
}

function renderIndex(
  mode: 'index' | 'ambiguous',
  reason: WhatsAppObserverContextResult['reason'],
  chats: readonly RankedChat[],
  maxChars: number,
  wasBounded: boolean,
): Pick<WhatsAppObserverContextResult, 'xml' | 'truncated'> {
  const open = `<whatsapp_observer_context mode="${mode}" reason="${reason}">`;
  const close = '</whatsapp_observer_context>';
  if (open.length + close.length > maxChars) {
    return { xml: '', truncated: true };
  }
  const lines: string[] = [];
  let truncated = wasBounded;
  for (const chat of chats) {
    const senderLabels = [...new Set(chat.senderLabels)].slice(0, 5).join(', ');
    const line = `<chat ref="${chat.chatRef}" label="${xmlText(chat.chatLabel)}" last_message_time="${xmlText(chat.latestTimestamp)}" message_count="${chat.messages.length}" senders="${xmlText(senderLabels)}" />`;
    const candidate = `${open}\n${[...lines, line].join('\n')}\n${close}`;
    if (candidate.length > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
  }
  return {
    xml: `${open}${lines.length ? `\n${lines.join('\n')}\n` : ''}${close}`,
    truncated,
  };
}

function renderMessageWithin(
  message: ObservedWhatsAppMessageRecord,
  senderLabel: string,
  maxLength: number,
): { value: string; truncated: boolean } | null {
  const prefix = `<message time="${xmlText(message.timestamp)}" from_me="${message.fromMe}" sender="${xmlText(senderLabel)}" kind="${xmlText(message.messageKind)}">`;
  const suffix = '</message>';
  if (prefix.length + suffix.length > maxLength) return null;
  const cleanContent = message.content.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    '',
  );
  const full = `${prefix}${escapeXml(cleanContent)}${suffix}`;
  if (full.length <= maxLength) return { value: full, truncated: false };

  const codePoints = [...cleanContent];
  let low = 0;
  let high = codePoints.length;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${prefix}${escapeXml(codePoints.slice(0, middle).join(''))}…${suffix}`;
    if (candidate.length <= maxLength) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best ? { value: best, truncated: true } : null;
}

function renderTranscript(
  chats: readonly RankedChat[],
  maxMessagesPerChat: number,
  maxChars: number,
  wasBounded: boolean,
): Pick<WhatsAppObserverContextResult, 'xml' | 'messageCount' | 'truncated'> {
  const open =
    '<whatsapp_observer_context mode="transcript" reason="explicit_correspondence_request">';
  const close = '</whatsapp_observer_context>';
  if (open.length + close.length > maxChars) {
    return { xml: '', messageCount: 0, truncated: true };
  }

  const chatFragments: string[] = [];
  let messageCount = 0;
  let truncated = wasBounded;
  for (const chat of chats) {
    const chatOpen = `<chat ref="${chat.chatRef}" label="${xmlText(chat.chatLabel)}">`;
    const chatClose = '</chat>';
    const contentMessages = chat.messages.filter(
      (message) => message.content.trim().length > 0,
    );
    const selectedMessages = contentMessages.slice(-maxMessagesPerChat);
    if (selectedMessages.length < contentMessages.length) truncated = true;
    const messageLines: string[] = [];

    for (const message of selectedMessages) {
      const fixed = `${open}\n${[
        ...chatFragments,
        `${chatOpen}\n${messageLines.join('\n')}${messageLines.length ? '\n' : ''}${chatClose}`,
      ].join('\n')}\n${close}`;
      const available = maxChars - fixed.length;
      const senderLabel = safeDisplayLabel(
        message.senderLabel,
        message.fromMe ? 'Я' : 'Контакт',
      );
      const rendered = renderMessageWithin(message, senderLabel, available);
      if (!rendered) {
        truncated = true;
        break;
      }
      messageLines.push(rendered.value);
      messageCount += 1;
      if (rendered.truncated) truncated = true;
    }

    if (messageLines.length === 0) continue;
    const fragment = `${chatOpen}\n${messageLines.join('\n')}\n${chatClose}`;
    const candidate = `${open}\n${[...chatFragments, fragment].join('\n')}\n${close}`;
    if (candidate.length > maxChars) {
      truncated = true;
      messageCount -= messageLines.length;
      break;
    }
    chatFragments.push(fragment);
  }
  return {
    xml: `${open}${chatFragments.length ? `\n${chatFragments.join('\n')}\n` : ''}${close}`,
    messageCount,
    truncated,
  };
}

/**
 * Build bounded, XML-safe model context from already fetched records.
 *
 * This is deliberately pure. It only exposes message bodies when `request`
 * explicitly asks to inspect correspondence. Generic requests receive a
 * metadata-only recent-chat index, and ambiguous contact matches fail closed
 * to that same no-transcript representation.
 */
export function buildWhatsAppObserverContext(
  options: BuildWhatsAppObserverContextOptions,
): WhatsAppObserverContextResult {
  const maxChats = normalizeContextBound(
    options.maxChats,
    DEFAULT_MAX_CHATS,
    20,
  );
  const maxMessagesPerChat = normalizeContextBound(
    options.maxMessagesPerChat,
    DEFAULT_MAX_MESSAGES_PER_CHAT,
    100,
  );
  const maxChars = normalizeContextBound(
    options.maxChars,
    DEFAULT_MAX_CONTEXT_CHARS,
    MAX_CONTEXT_CHARS,
  );
  const explicitRequest = isExplicitWhatsAppCorrespondenceRequest(
    options.request,
  );
  const requestRange = whatsappObserverRangeForRequest(
    options.request,
    options.now,
    options.timeZone,
  );
  const sinceTimestamp = requestRange
    ? Date.parse(requestRange.since)
    : undefined;
  const beforeTimestamp = requestRange?.before
    ? Date.parse(requestRange.before)
    : undefined;
  const messages = requestRange
    ? options.messages.filter((message) => {
        const timestamp = Date.parse(message.timestamp);
        return (
          Number.isFinite(timestamp) &&
          timestamp >= (sinceTimestamp ?? Number.POSITIVE_INFINITY) &&
          (beforeTimestamp === undefined || timestamp < beforeTimestamp)
        );
      })
    : options.messages;
  if (
    messages.length === 0 ||
    maxChats === 0 ||
    maxMessagesPerChat === 0 ||
    maxChars === 0
  ) {
    const emptyRequestMarker =
      '<whatsapp_observer_context mode="empty" reason="no_messages" />';
    const reportCheckedEmptyRequest =
      messages.length === 0 &&
      explicitRequest &&
      maxChats > 0 &&
      maxMessagesPerChat > 0 &&
      maxChars > 0;
    return {
      mode: 'empty',
      reason: 'no_messages',
      xml:
        reportCheckedEmptyRequest && emptyRequestMarker.length <= maxChars
          ? emptyRequestMarker
          : '',
      selectedChatRefs: [],
      chatCount: 0,
      messageCount: 0,
      truncated:
        (reportCheckedEmptyRequest && emptyRequestMarker.length > maxChars) ||
        messages.length > 0,
    };
  }

  const requestedTokens = targetTokens(options.request);
  const requestedRefs = requestedOpaqueChatRefs(options.request);
  const ranked = rankChats(messages, requestedTokens);
  const recent = [...ranked]
    .sort(
      (a, b) =>
        b.latestTimestamp.localeCompare(a.latestTimestamp) ||
        a.chatRef.localeCompare(b.chatRef),
    )
    .slice(0, maxChats);
  const indexWasBounded = ranked.length > recent.length;

  if (!explicitRequest) {
    const rendered = renderIndex(
      'index',
      'no_explicit_correspondence_request',
      recent,
      maxChars,
      indexWasBounded,
    );
    return {
      mode: 'index',
      reason: 'no_explicit_correspondence_request',
      xml: rendered.xml,
      selectedChatRefs: recent.map((chat) => chat.chatRef),
      chatCount: recent.length,
      messageCount: 0,
      truncated: rendered.truncated,
    };
  }

  const hasTarget = requestedTokens.size > 0;
  const hasSpecificSelection = requestedRefs.length > 0 || hasTarget;
  let selected: RankedChat[];
  if (requestedRefs.length > 0) {
    const matches = ranked.filter((chat) =>
      requestedRefs.includes(chat.chatRef),
    );
    if (matches.length === 0) {
      const rendered = renderIndex(
        'index',
        'no_matching_chat',
        recent,
        maxChars,
        indexWasBounded,
      );
      return {
        mode: 'index',
        reason: 'no_matching_chat',
        xml: rendered.xml,
        selectedChatRefs: recent.map((chat) => chat.chatRef),
        chatCount: recent.length,
        messageCount: 0,
        truncated: rendered.truncated,
      };
    }
    if (requestedRefs.length !== 1 || matches.length !== 1) {
      const candidates = matches.slice(0, maxChats);
      const rendered = renderIndex(
        'ambiguous',
        'ambiguous_contact_match',
        candidates,
        maxChars,
        matches.length > candidates.length,
      );
      return {
        mode: 'ambiguous',
        reason: 'ambiguous_contact_match',
        xml: rendered.xml,
        selectedChatRefs: candidates.map((chat) => chat.chatRef),
        chatCount: candidates.length,
        messageCount: 0,
        truncated: rendered.truncated,
      };
    }
    selected = [matches[0]];
  } else if (hasTarget) {
    const matches = ranked.filter((chat) => chat.score > 0);
    if (matches.length === 0) {
      const rendered = renderIndex(
        'index',
        'no_matching_chat',
        recent,
        maxChars,
        indexWasBounded,
      );
      return {
        mode: 'index',
        reason: 'no_matching_chat',
        xml: rendered.xml,
        selectedChatRefs: recent.map((chat) => chat.chatRef),
        chatCount: recent.length,
        messageCount: 0,
        truncated: rendered.truncated,
      };
    }
    if (matches.length > 1 && matches[0].score === matches[1].score) {
      const candidates = matches.slice(0, maxChats);
      const rendered = renderIndex(
        'ambiguous',
        'ambiguous_contact_match',
        candidates,
        maxChars,
        matches.length > candidates.length,
      );
      return {
        mode: 'ambiguous',
        reason: 'ambiguous_contact_match',
        xml: rendered.xml,
        selectedChatRefs: candidates.map((chat) => chat.chatRef),
        chatCount: candidates.length,
        messageCount: 0,
        truncated: rendered.truncated,
      };
    }
    selected = [matches[0]];
  } else {
    selected = recent;
  }

  if (
    selected.every((chat) =>
      chat.messages.every((message) => !message.content.trim()),
    )
  ) {
    const rendered = renderIndex(
      'index',
      'no_message_content',
      selected,
      maxChars,
      false,
    );
    return {
      mode: 'index',
      reason: 'no_message_content',
      xml: rendered.xml,
      selectedChatRefs: selected.map((chat) => chat.chatRef),
      chatCount: selected.length,
      messageCount: 0,
      truncated: rendered.truncated,
    };
  }

  const rendered = renderTranscript(
    selected,
    maxMessagesPerChat,
    maxChars,
    selected.length < (hasSpecificSelection ? 1 : ranked.length),
  );
  return {
    mode: 'transcript',
    reason: 'explicit_correspondence_request',
    xml: rendered.xml,
    selectedChatRefs: selected.map((chat) => chat.chatRef),
    chatCount: selected.length,
    messageCount: rendered.messageCount,
    truncated: rendered.truncated,
  };
}
