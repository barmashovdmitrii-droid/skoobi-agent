import type Database from 'better-sqlite3';

import {
  cleanDialogText,
  cleanObservedText,
  type DialogMessage,
} from './collectors.js';
import { readDb } from './db.js';

const DEFAULT_PAGE_LIMIT = 80;
const MAX_PAGE_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 40;
const MAX_SEARCH_LIMIT = 80;
const MAX_SEARCH_QUERY_CHARS = 200;
const MAX_SEARCH_ALLOWED_JIDS = 1_000;

type DialogSource = 'telegram' | 'whatsapp' | 'messages';

type HistoryToken = {
  v: 1;
  source: DialogSource;
  jid: string;
  timestamp: string;
  id: string;
};

type RawHistoryMessage = {
  id: string;
  timestamp: string;
  is_bot_message: number | null;
  is_from_me: number | null;
  sender_name: string | null;
  sender: string | null;
  content: string | null;
  message_kind: string | null;
  media_enriched: number | null;
};

export type DialogHistoryMessage = DialogMessage & {
  /** Opaque identifier used to focus this exact message after a search. */
  anchor: string;
};

export type DialogMessagePage = {
  messages: DialogHistoryMessage[];
  hasMore: boolean;
  nextCursor: string | null;
  anchored: boolean;
};

export type DialogSearchResult = {
  channel: 'telegram' | 'whatsapp';
  jid: string;
  chatName: string;
  kind: string;
  isoTime: string;
  sender: string;
  snippet: string;
  anchor: string;
};

export type DialogSearchOptions = {
  channel?: 'telegram' | 'whatsapp';
  mediaOnly?: boolean;
  /** Restricts the query before ORDER BY/LIMIT. An explicitly empty list matches nothing. */
  allowedJids?: readonly string[];
};

export class DialogHistoryInputError extends Error {
  constructor(message = 'некорректный параметр истории') {
    super(message);
    this.name = 'DialogHistoryInputError';
  }
}

function clampLimit(value: number | undefined, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new DialogHistoryInputError('некорректный лимит');
  }
  return Math.min(value, max);
}

function encodeToken(
  source: DialogSource,
  jid: string,
  row: Pick<RawHistoryMessage, 'timestamp' | 'id'>,
): string {
  const payload: HistoryToken = {
    v: 1,
    source,
    jid,
    timestamp: row.timestamp,
    id: row.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeToken(value: string, expectedJid: string): HistoryToken {
  if (!value || value.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new DialogHistoryInputError('некорректный курсор');
  }
  let parsed: unknown;
  try {
    const buffer = Buffer.from(value, 'base64url');
    if (buffer.toString('base64url') !== value) {
      throw new Error('non-canonical base64url');
    }
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new DialogHistoryInputError('некорректный курсор');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DialogHistoryInputError('некорректный курсор');
  }
  const token = parsed as Partial<HistoryToken>;
  if (
    token.v !== 1 ||
    !['telegram', 'whatsapp', 'messages'].includes(String(token.source)) ||
    token.jid !== expectedJid ||
    typeof token.timestamp !== 'string' ||
    token.timestamp.length < 10 ||
    token.timestamp.length > 64 ||
    !Number.isFinite(Date.parse(token.timestamp)) ||
    typeof token.id !== 'string' ||
    token.id.length < 1 ||
    token.id.length > 512
  ) {
    throw new DialogHistoryInputError('некорректный курсор');
  }
  return token as HistoryToken;
}

/**
 * Resolves an opaque UI anchor for server-side media lookup. The raw message
 * id never needs to be exposed as a separate API field.
 */
export function decodeDialogMessageAnchor(
  jid: string,
  anchor: string,
): { id: string } {
  const token = decodeToken(anchor, jid);
  if (
    jid.startsWith('tg:')
      ? token.source !== 'telegram'
      : token.source === 'telegram'
  ) {
    throw new DialogHistoryInputError(
      'точка поиска относится к другому каналу',
    );
  }
  return { id: token.id };
}

function isWhatsappJid(jid: string): boolean {
  return (
    jid.endsWith('@s.whatsapp.net') ||
    jid.endsWith('@g.us') ||
    jid.endsWith('@lid')
  );
}

function isSupportedSearchJid(jid: string): boolean {
  return (
    /^tg:\d{1,20}$/u.test(jid) ||
    /^\d{5,20}(?::\d{1,5})?@s\.whatsapp\.net$/u.test(jid) ||
    /^\d{5,20}(?:-\d{1,20})?@g\.us$/u.test(jid) ||
    /^\d{5,20}@lid$/u.test(jid)
  );
}

function hasObservedTable(db: Database.Database): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM sqlite_master
         WHERE type = 'table' AND name = 'observed_whatsapp_messages'`,
      )
      .get(),
  );
}

function resolveSource(db: Database.Database, jid: string): DialogSource {
  if (jid.startsWith('tg:')) return 'telegram';
  if (
    isWhatsappJid(jid) &&
    hasObservedTable(db) &&
    db
      .prepare(
        'SELECT 1 FROM observed_whatsapp_messages WHERE chat_jid = ? LIMIT 1',
      )
      .get(jid)
  ) {
    return 'whatsapp';
  }
  return 'messages';
}

function validateTokenSource(
  db: Database.Database,
  jid: string,
  source: DialogSource,
): void {
  if (jid.startsWith('tg:') ? source !== 'telegram' : source === 'telegram') {
    throw new DialogHistoryInputError('курсор относится к другому каналу');
  }
  if (source === 'whatsapp' && !hasObservedTable(db)) {
    throw new DialogHistoryInputError('история WhatsApp недоступна');
  }
}

const MESSAGE_SELECT = `SELECT CAST(id AS TEXT) AS id, timestamp,
  is_bot_message, is_from_me, sender_name, sender, content,
  CASE
    WHEN content LIKE '[Photo%' THEN 'image'
    WHEN content LIKE '[Video note%' THEN 'video-note'
    WHEN content LIKE '[Video%' THEN 'video'
    WHEN content LIKE '[Voice%' THEN 'voice'
    WHEN content LIKE '[Audio%' THEN 'audio'
    WHEN content LIKE '[Document%' THEN 'document'
    ELSE 'text'
  END AS message_kind, NULL AS media_enriched
FROM messages`;

const OBSERVED_SELECT = `SELECT CAST(message_id AS TEXT) AS id, timestamp,
  0 AS is_bot_message, from_me AS is_from_me,
  local_sender_label AS sender_name, local_sender_label AS sender, content,
  message_kind, media_enriched
FROM observed_whatsapp_messages`;

function selectFor(source: DialogSource): string {
  return source === 'whatsapp' ? OBSERVED_SELECT : MESSAGE_SELECT;
}

function fetchLatestOrOlder(
  db: Database.Database,
  source: DialogSource,
  jid: string,
  before: Pick<HistoryToken, 'timestamp' | 'id'> | null,
  limit: number,
): RawHistoryMessage[] {
  const sql = before
    ? `${selectFor(source)}
       WHERE chat_jid = ? AND
         (timestamp < ? OR (timestamp = ? AND id < ?))
       ORDER BY timestamp DESC, id DESC LIMIT ?`
    : `${selectFor(source)}
       WHERE chat_jid = ?
       ORDER BY timestamp DESC, id DESC LIMIT ?`;
  return (
    before
      ? db
          .prepare(sql)
          .all(jid, before.timestamp, before.timestamp, before.id, limit)
      : db.prepare(sql).all(jid, limit)
  ) as RawHistoryMessage[];
}

function fetchNewer(
  db: Database.Database,
  source: DialogSource,
  jid: string,
  after: Pick<HistoryToken, 'timestamp' | 'id'>,
  limit: number,
): RawHistoryMessage[] {
  return db
    .prepare(
      `${selectFor(source)}
       WHERE chat_jid = ? AND
         (timestamp > ? OR (timestamp = ? AND id > ?))
       ORDER BY timestamp ASC, id ASC LIMIT ?`,
    )
    .all(
      jid,
      after.timestamp,
      after.timestamp,
      after.id,
      limit,
    ) as RawHistoryMessage[];
}

function fetchExact(
  db: Database.Database,
  source: DialogSource,
  jid: string,
  at: Pick<HistoryToken, 'timestamp' | 'id'>,
): RawHistoryMessage | null {
  return (
    (db
      .prepare(
        `${selectFor(source)}
         WHERE chat_jid = ? AND timestamp = ? AND id = ? LIMIT 1`,
      )
      .get(jid, at.timestamp, at.id) as RawHistoryMessage | undefined) || null
  );
}

function toMessage(
  source: DialogSource,
  jid: string,
  row: RawHistoryMessage,
  maxChars = 12_000,
): DialogHistoryMessage {
  const whatsapp = source === 'whatsapp' || isWhatsappJid(jid);
  const outgoing = row.is_bot_message === 1 || row.is_from_me === 1;
  const fromBot = !whatsapp && outgoing;
  const kind = String(row.message_kind || 'other');
  const text =
    source === 'whatsapp'
      ? cleanObservedText(row.content, kind)
      : cleanDialogText(row.content);
  return {
    isoTime: row.timestamp,
    time: new Date(row.timestamp).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    }),
    fromBot,
    outgoing,
    sender: whatsapp
      ? row.is_from_me === 1
        ? 'Вы'
        : row.sender_name || row.sender || 'Собеседник'
      : outgoing
        ? 'Скуби'
        : row.sender_name || row.sender || 'Собеседник',
    text: text.slice(0, maxChars),
    kind,
    mediaEnriched: source === 'whatsapp' ? row.media_enriched === 1 : null,
    anchor: encodeToken(source, jid, row),
  };
}

export function collectDialogMessagePageFromDb(
  db: Database.Database,
  jid: string,
  options: { limit?: number; cursor?: string; anchor?: string } = {},
): DialogMessagePage {
  const limit = clampLimit(options.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
  if (options.cursor !== undefined && options.anchor !== undefined) {
    throw new DialogHistoryInputError(
      'курсор и точку поиска нельзя использовать одновременно',
    );
  }
  const tokenValue = options.cursor ?? options.anchor;
  const token = tokenValue ? decodeToken(tokenValue, jid) : null;
  const source = token?.source || resolveSource(db, jid);
  validateTokenSource(db, jid, source);

  if (options.anchor !== undefined) {
    if (!token) throw new DialogHistoryInputError('некорректная точка поиска');
    const exact = fetchExact(db, source, jid, token);
    if (!exact) {
      throw new DialogHistoryInputError('найденного сообщения больше нет');
    }
    // Берём соседей с обеих сторон. Запас +1 на старой стороне нужен, чтобы
    // честно сказать UI, осталась ли ещё история для nextCursor.
    const older = fetchLatestOrOlder(db, source, jid, token, limit + 1);
    const newer = fetchNewer(db, source, jid, token, limit);
    let olderCount = Math.min(Math.floor((limit - 1) / 2), older.length);
    const newerCount = Math.min(limit - 1 - olderCount, newer.length);
    olderCount = Math.min(limit - 1 - newerCount, older.length);
    const selectedRows = [
      ...older.slice(0, olderCount).reverse(),
      exact,
      ...newer.slice(0, newerCount),
    ];
    const hasMore = older.length > olderCount;
    return {
      messages: selectedRows.map((row) => toMessage(source, jid, row)),
      hasMore,
      nextCursor: hasMore ? encodeToken(source, jid, selectedRows[0]) : null,
      anchored: true,
    };
  }

  if (options.cursor !== undefined) {
    if (!token) throw new DialogHistoryInputError('некорректный курсор');
    // Проверка существования не даёт подставить произвольную позицию между
    // сообщениями. Новые сообщения при этом курсор не сдвигают.
    if (!fetchExact(db, source, jid, token)) {
      throw new DialogHistoryInputError('курсор устарел');
    }
  }
  const descending = fetchLatestOrOlder(db, source, jid, token, limit + 1);
  const hasMore = descending.length > limit;
  const selected = descending.slice(0, limit);
  const oldest = selected[selected.length - 1];
  return {
    messages: selected.reverse().map((row) => toMessage(source, jid, row)),
    hasMore,
    nextCursor: hasMore && oldest ? encodeToken(source, jid, oldest) : null,
    anchored: false,
  };
}

export function collectDialogMessagePage(
  jid: string,
  options: { limit?: number; cursor?: string; anchor?: string } = {},
): DialogMessagePage {
  return collectDialogMessagePageFromDb(readDb(), jid, options);
}

function caseFoldGlob(query: string): string {
  let pattern = '*';
  for (const character of query) {
    if (character === '*') {
      pattern += '[*]';
      continue;
    }
    if (character === '?') {
      pattern += '[?]';
      continue;
    }
    if (character === '[') {
      pattern += '[[]';
      continue;
    }
    if (character === ']') {
      pattern += '[]]';
      continue;
    }
    const lower = character.toLocaleLowerCase('ru-RU');
    const upper = character.toLocaleUpperCase('ru-RU');
    if (
      lower !== upper &&
      Array.from(lower).length === 1 &&
      Array.from(upper).length === 1
    ) {
      pattern += `[${lower}${upper}]`;
    } else {
      pattern += character;
    }
  }
  return `${pattern}*`;
}

function normalizeSearchText(value: unknown): string {
  return String(value || '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function snippetFor(text: string, query: string): string {
  const normalized = normalizeSearchText(text);
  if (!normalized) return 'Без текста';
  const haystack = normalized.toLocaleLowerCase('ru-RU');
  const needle = query.toLocaleLowerCase('ru-RU');
  const matchAt = haystack.indexOf(needle);
  const start = matchAt > 70 ? matchAt - 70 : 0;
  const end = Math.min(normalized.length, start + 190);
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${
    end < normalized.length ? '…' : ''
  }`;
}

type SearchRow = RawHistoryMessage & {
  chat_jid: string;
  chat_name: string | null;
};

function validateSearchOptions(options: DialogSearchOptions): string[] | null {
  if (
    options.channel !== undefined &&
    options.channel !== 'telegram' &&
    options.channel !== 'whatsapp'
  ) {
    throw new DialogHistoryInputError('некорректный фильтр канала');
  }
  if (
    options.mediaOnly !== undefined &&
    typeof options.mediaOnly !== 'boolean'
  ) {
    throw new DialogHistoryInputError('некорректный фильтр медиа');
  }
  if (options.allowedJids === undefined) return null;
  if (
    !Array.isArray(options.allowedJids) ||
    options.allowedJids.length > MAX_SEARCH_ALLOWED_JIDS
  ) {
    throw new DialogHistoryInputError('некорректный список диалогов');
  }
  const unique = new Set<string>();
  for (const jid of options.allowedJids) {
    if (typeof jid !== 'string' || !isSupportedSearchJid(jid)) {
      throw new DialogHistoryInputError('некорректный список диалогов');
    }
    unique.add(jid);
  }
  return [...unique];
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

export function searchDialogsFromDb(
  db: Database.Database,
  rawQuery: string,
  requestedLimit?: number,
  options: DialogSearchOptions = {},
): DialogSearchResult[] {
  const query = rawQuery.trim();
  const queryLength = Array.from(query).length;
  if (queryLength < 2 || queryLength > MAX_SEARCH_QUERY_CHARS) {
    throw new DialogHistoryInputError(
      'поисковый запрос должен быть от 2 до 200 символов',
    );
  }
  const limit = clampLimit(
    requestedLimit,
    DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
  );
  const allowedJids = validateSearchOptions(options);
  if (allowedJids?.length === 0) return [];
  const pattern = caseFoldGlob(query);
  const sourceLimit = limit;

  const telegramAllowed = allowedJids?.filter((jid) => jid.startsWith('tg:'));
  const whatsappAllowed = allowedJids?.filter((jid) => !jid.startsWith('tg:'));
  const shouldSearchTelegram =
    options.channel !== 'whatsapp' &&
    (telegramAllowed === undefined || telegramAllowed.length > 0);
  const shouldSearchWhatsapp =
    options.channel !== 'telegram' &&
    (whatsappAllowed === undefined || whatsappAllowed.length > 0);

  const telegramWhere = [
    "m.chat_jid LIKE 'tg:%'",
    'm.id IS NOT NULL',
    `(COALESCE(m.content, '') GLOB ? OR
      COALESCE(m.sender_name, '') GLOB ? OR
      COALESCE(m.sender, '') GLOB ? OR
      COALESCE(g.name, '') GLOB ?)`,
  ];
  const telegramParams: Array<string | number> = [
    pattern,
    pattern,
    pattern,
    pattern,
  ];
  if (options.mediaOnly) {
    telegramWhere.push(`(m.content LIKE '[Photo%' OR
      m.content LIKE '[Video note%' OR m.content LIKE '[Video%' OR
      m.content LIKE '[Voice%' OR m.content LIKE '[Audio%' OR
      m.content LIKE '[Document%')`);
  }
  if (telegramAllowed) {
    telegramWhere.push(
      `m.chat_jid IN (${placeholders(telegramAllowed.length)})`,
    );
    telegramParams.push(...telegramAllowed);
  }
  telegramParams.push(sourceLimit);

  const telegram = shouldSearchTelegram
    ? (db
        .prepare(
          `SELECT CAST(m.id AS TEXT) AS id, m.chat_jid, m.timestamp, m.is_bot_message,
              m.is_from_me, m.sender_name, m.sender, m.content,
              CASE
                WHEN m.content LIKE '[Photo%' THEN 'image'
                WHEN m.content LIKE '[Video note%' THEN 'video-note'
                WHEN m.content LIKE '[Video%' THEN 'video'
                WHEN m.content LIKE '[Voice%' THEN 'voice'
                WHEN m.content LIKE '[Audio%' THEN 'audio'
                WHEN m.content LIKE '[Document%' THEN 'document'
                ELSE 'text'
              END AS message_kind, NULL AS media_enriched,
              g.name AS chat_name
         FROM messages m
         INNER JOIN registered_groups g ON g.jid = m.chat_jid
        WHERE ${telegramWhere.join(' AND ')}
        ORDER BY m.timestamp DESC, m.id DESC LIMIT ?`,
        )
        .all(...telegramParams) as SearchRow[])
    : [];

  const whatsappWhere = [
    `(COALESCE(content, '') GLOB ? OR
      COALESCE(local_chat_label, '') GLOB ? OR
      COALESCE(local_sender_label, '') GLOB ? OR
      COALESCE(message_kind, '') GLOB ?)`,
  ];
  const whatsappParams: Array<string | number> = [
    pattern,
    pattern,
    pattern,
    pattern,
  ];
  if (options.mediaOnly) {
    whatsappWhere.push("COALESCE(message_kind, 'text') <> 'text'");
  }
  if (whatsappAllowed) {
    whatsappWhere.push(`chat_jid IN (${placeholders(whatsappAllowed.length)})`);
    whatsappParams.push(...whatsappAllowed);
  }
  whatsappParams.push(sourceLimit);

  const whatsapp =
    shouldSearchWhatsapp && hasObservedTable(db)
      ? (db
          .prepare(
            `SELECT CAST(message_id AS TEXT) AS id, chat_jid, timestamp,
                  0 AS is_bot_message, from_me AS is_from_me,
                  local_sender_label AS sender_name,
                  local_sender_label AS sender, content, message_kind,
                  media_enriched, local_chat_label AS chat_name
             FROM observed_whatsapp_messages
            WHERE ${whatsappWhere.join(' AND ')}
            ORDER BY timestamp DESC, message_id DESC LIMIT ?`,
          )
          .all(...whatsappParams) as SearchRow[])
      : [];

  const results: Array<DialogSearchResult & { sortId: string }> = [];
  for (const row of telegram) {
    const outgoing = row.is_bot_message === 1 || row.is_from_me === 1;
    results.push({
      channel: 'telegram',
      jid: row.chat_jid,
      chatName: row.chat_name || 'Telegram',
      kind: String(row.message_kind || 'text'),
      isoTime: row.timestamp,
      sender: outgoing
        ? 'Скуби'
        : row.sender_name || row.sender || 'Собеседник',
      snippet: snippetFor(cleanDialogText(row.content), query),
      anchor: encodeToken('telegram', row.chat_jid, row),
      sortId: row.id,
    });
  }

  for (const row of whatsapp) {
    const jid = row.chat_jid;
    const kind = String(row.message_kind || 'other');
    results.push({
      channel: 'whatsapp',
      jid,
      chatName:
        normalizeSearchText(row.chat_name) ||
        (jid.endsWith('@g.us') ? 'Группа WhatsApp' : 'Контакт WhatsApp'),
      kind,
      isoTime: row.timestamp,
      sender:
        row.is_from_me === 1
          ? 'Вы'
          : row.sender_name || row.sender || 'Собеседник',
      snippet: snippetFor(cleanObservedText(row.content, kind), query),
      anchor: encodeToken('whatsapp', jid, row),
      sortId: row.id,
    });
  }

  return results
    .filter((result) => result.jid && result.anchor)
    .sort(
      (a, b) =>
        b.isoTime.localeCompare(a.isoTime) || b.sortId.localeCompare(a.sortId),
    )
    .slice(0, limit)
    .map(({ sortId: _sortId, ...result }) => result);
}

export function searchDialogs(
  query: string,
  limit?: number,
  options: DialogSearchOptions = {},
): DialogSearchResult[] {
  return searchDialogsFromDb(readDb(), query, limit, options);
}
