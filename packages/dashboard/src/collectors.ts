import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from '@skoobi/shared/env';
import { logger } from '@skoobi/shared/logger';

import { readDb } from './db.js';

import { ACCESS_CONTROL_FILE, LOG_FILE } from './config.js';
import { detectDialogAttention } from './dialog-attention.js';
import { readDialogState, type DashboardDialogState } from './dialog-state.js';
import { resolveMainServiceLabel } from './service-label.js';
import {
  formatAgo,
  humanizeEvent,
  humanizeSchedule,
  humanizeTaskStatus,
  parseLogLine,
  type HumanEvent,
  type LogLine,
} from './humanize.js';

const execFileAsync = promisify(execFile);
type LaunchctlListExecutor = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string }>;
const defaultLaunchctlListExecutor =
  execFileAsync as unknown as LaunchctlListExecutor;

// ── Сервисы ────────────────────────────────────────────────────────────────

export type ServiceStatus = {
  id: string;
  name: string;
  state: 'ok' | 'warn' | 'down';
  detail: string;
};

export async function collectServices(
  deps: { launchctlExecutor?: LaunchctlListExecutor } = {},
): Promise<ServiceStatus[]> {
  let mainLabel: string | null = null;
  try {
    mainLabel = resolveMainServiceLabel();
  } catch (err) {
    logger.warn({ err }, 'dashboard: invalid main service label');
  }
  const units: Array<{
    id: string;
    name: string;
    label: string | null;
  }> = [
    { id: 'main', name: 'Скуби', label: mainLabel },
    {
      id: 'dashboard',
      name: 'Локальная панель',
      label: 'com.skoobi.dashboard',
    },
  ];
  let listOut = '';
  try {
    const { stdout } = await (
      deps.launchctlExecutor ?? defaultLaunchctlListExecutor
    )('launchctl', ['list'], { timeout: 5000 });
    listOut = stdout;
  } catch (err) {
    logger.warn({ err }, 'dashboard: launchctl list failed');
  }
  const rows = new Map<string, { pid: string; status: string }>();
  for (const line of listOut.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)$/);
    if (m) rows.set(m[3], { pid: m[1], status: m[2] });
  }
  const services: ServiceStatus[] = [];
  for (const unit of units) {
    if (!unit.label) {
      services.push({
        id: unit.id,
        name: unit.name,
        state: 'down',
        detail: 'некорректная настройка службы',
      });
      continue;
    }
    const row = rows.get(unit.label);
    if (!row) {
      services.push({
        id: unit.id,
        name: unit.name,
        state: 'down',
        detail: 'служба не загружена',
      });
    } else if (row.pid !== '-') {
      services.push({
        id: unit.id,
        name: unit.name,
        state: 'ok',
        detail: 'работает',
      });
    } else {
      services.push({
        id: unit.id,
        name: unit.name,
        state: row.status === '0' ? 'warn' : 'down',
        detail:
          row.status === '0'
            ? 'остановлена (без ошибки)'
            : `остановлена, код ${row.status}`,
      });
    }
  }
  return services;
}

// ── Пульт: сводка и события ────────────────────────────────────────────────

function chatNameMap(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const rows = readDb()
      .prepare('SELECT jid, name FROM registered_groups')
      .all() as Array<{ jid: string; name: string }>;
    for (const r of rows) map.set(r.jid, r.name);
  } catch (err) {
    logger.warn({ err }, 'dashboard: chat name map failed');
  }
  return map;
}

export function collectOverviewNumbers(): {
  events5m: number;
  errors24h: number;
  tasksToday: number;
} {
  const db = readDb();
  const now = Date.now();
  const events5m = (
    db
      .prepare('SELECT COUNT(*) AS c FROM events WHERE created_at >= ?')
      .get(now - 5 * 60_000) as { c: number }
  ).c;
  // Только type='error': failover_exhausted/circuit_opened — сопутствующие
  // события того же сбоя, их подсчёт утраивал цифру (находка ревью).
  const errors24h = (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM events WHERE type = 'error' AND created_at >= ?",
      )
      .get(now - 24 * 3600_000) as { c: number }
  ).c;
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  const tasksToday = (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM scheduled_tasks WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?",
      )
      .get(endOfDay.toISOString()) as { c: number }
  ).c;
  return { events5m, errors24h, tasksToday };
}

// Ошибки за сутки — ровно та же выборка, по которой collectOverviewNumbers
// считает бейдж errors24h (type='error' в events): цифра и список всегда
// сходятся, даже когда лог-файл уже ротировался и хвост «чист».
export function collectRecentErrors(limit = 5): HumanEvent[] {
  const names = chatNameMap();
  const rows = readDb()
    .prepare(
      `SELECT type, created_at, chat_id, payload_json FROM events
       WHERE type = 'error' AND created_at >= ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(Date.now() - 24 * 3600_000, limit) as Array<{
    type: string;
    created_at: number;
    chat_id: string;
    payload_json: string;
  }>;
  return rows.map((r) =>
    humanizeEvent({
      ...r,
      chatName: names.get(r.chat_id) || names.get(`tg:${r.chat_id}`) || null,
    }),
  );
}

export function collectRecentEvents(limit = 12): HumanEvent[] {
  const names = chatNameMap();
  const rows = readDb()
    .prepare(
      `SELECT type, created_at, chat_id, payload_json FROM events
       WHERE type NOT IN ('quota_checked', 'model_gateway_live_response', 'skill_selected')
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    type: string;
    created_at: number;
    chat_id: string;
    payload_json: string;
  }>;
  return rows.map((r) =>
    humanizeEvent({
      ...r,
      chatName: names.get(r.chat_id) || names.get(`tg:${r.chat_id}`) || null,
    }),
  );
}

// ── Диалоги ────────────────────────────────────────────────────────────────

export type ChatRow = {
  jid: string;
  name: string;
  sourceName: string;
  folder: string;
  channel: 'telegram' | 'whatsapp';
  channelLabel: 'Telegram' | 'WhatsApp';
  isGroup: boolean;
  isMain: boolean;
  canSend: boolean;
  canPause: boolean;
  readOnly: boolean;
  paused: boolean;
  pauseReason: string;
  lastMessageAt: string | null;
  lastMessageAgo: string;
  messages24h: number;
  messagesTotal: number;
  media24h: number;
  preview: string;
  lastSender: string;
  lastKind: string;
  pinned: boolean;
  needsReply: boolean;
  attentionReason: string;
  localAlias: string;
  linkedChats: Array<{
    jid: string;
    name: string;
    channel: 'telegram' | 'whatsapp';
  }>;
};

export type DialogMessage = {
  isoTime: string;
  time: string;
  fromBot: boolean;
  outgoing: boolean;
  sender: string;
  text: string;
  kind: string;
  mediaEnriched: boolean | null;
};

export function readAccessControl(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(ACCESS_CONTROL_FILE, 'utf-8')) || {};
  } catch {
    return {};
  }
}

// Главный чат владельца (is_main) — в него пишет вкладка «Чат» панели.
export function collectMainChat(): {
  jid: string;
  name: string;
  folder: string;
} | null {
  const row = readDb()
    .prepare(
      `SELECT jid, name, folder FROM registered_groups
       WHERE jid LIKE 'tg:%' AND COALESCE(is_main, 0) = 1
       ORDER BY jid LIMIT 1`,
    )
    .get() as { jid: string; name: string; folder: string } | undefined;
  return row || null;
}

type RegisteredChatSummary = {
  jid: string;
  name: string;
  folder: string;
  is_main: number;
  last_ts: string | null;
  msg24: number;
  msg_total: number;
  media24: number;
  last_content: string | null;
  last_sender_name: string | null;
  last_sender: string | null;
  last_is_bot: number | null;
  last_is_from_me: number | null;
};

export function cleanDialogText(value: unknown): string {
  return String(value || '')
    .replace(
      /(?:файл:\s*)?received\/[\p{L}\p{N}._()@+\- ]{1,255}?\.[\p{L}\p{N}]{1,8}(?=$|[\s.;,\]\)])/giu,
      'файл сохранён локально',
    )
    .trim();
}

export function cleanObservedText(value: unknown, kind: string): string {
  let clean = cleanDialogText(value);
  if (kind === 'text') return clean;
  if (clean.startsWith('[') && clean.endsWith(']')) {
    clean = clean.slice(1, -1).trim();
  }
  const prefixes: Record<string, RegExp> = {
    voice: /^(?:Голосовое|Voice)(?:\s+WhatsApp)?[\s.:;—-]*/iu,
    audio: /^(?:Аудио|Audio)(?:\s+WhatsApp)?[\s.:;—-]*/iu,
    image: /^(?:Фото|Image)(?:\s+WhatsApp)?[\s.:;—-]*/iu,
    video: /^(?:Видео|Video)(?:\s+WhatsApp)?[\s.:;—-]*/iu,
    document: /^(?:Документ|Document)(?:\s+WhatsApp)?[\s.:;—-]*/iu,
  };
  clean = clean.replace(prefixes[kind] || /^$/u, '').trim();
  return clean
    .replace(
      /ожидает локального (?:анализа|разбора|расшифровки)/giu,
      'локальный разбор пока отсутствует',
    )
    .replace(/^[.:;—-]+\s*/u, '')
    .trim();
}

function previewText(value: unknown, kind: string): string {
  const clean = cleanDialogText(value).replace(/\s+/gu, ' ');
  if (!clean) {
    return kind === 'text' ? 'Без текста' : 'Медиа без подписи';
  }
  return clean.length > 150 ? `${clean.slice(0, 150)}…` : clean;
}

function inferStoredMessageKind(value: unknown): string {
  const content = String(value || '').trim();
  if (/^\[Photo\b/iu.test(content)) return 'image';
  if (/^\[Video note\b/iu.test(content)) return 'video-note';
  if (/^\[Video\b/iu.test(content)) return 'video';
  if (/^\[Voice\b/iu.test(content)) return 'voice';
  if (/^\[Audio\b/iu.test(content)) return 'audio';
  if (/^\[Document\b/iu.test(content)) return 'document';
  return 'text';
}

function fallbackWhatsappName(jid: string, isGroup: boolean): string {
  if (isGroup) return 'Группа WhatsApp';
  const digits = jid.split('@')[0].replace(/\D/g, '');
  const suffix = digits.slice(-4);
  return suffix ? `Контакт •••• ${suffix}` : 'Контакт WhatsApp';
}

function whatsappDisplayName(
  value: unknown,
  jid: string,
  isGroup: boolean,
): string {
  const name = String(value || '')
    .replace(/\s+/gu, ' ')
    .trim();
  const jidDigits = jid.split('@')[0].replace(/\D/gu, '');
  const nameDigits = name.replace(/\D/gu, '');
  const generic = /^(?:контакт|contact)(?:\s+whatsapp)?$/iu.test(name);
  const looksLikeNumber =
    nameDigits.length >= 5 &&
    (nameDigits === jidDigits || /^\+?[\d\s().-]+$/u.test(name));
  return !name || generic || looksLikeNumber
    ? fallbackWhatsappName(jid, isGroup)
    : name;
}

type CollectChatsOptions = {
  dialogState?: DashboardDialogState;
  now?: number;
};

export function collectChats(options: CollectChatsOptions = {}): ChatRow[] {
  const db = readDb();
  const acl = readAccessControl();
  const now = options.now ?? Date.now();
  const dialogState = options.dialogState ?? readDialogState();
  const since = new Date(now - 24 * 3600_000).toISOString();
  const registeredRows = db
    .prepare(
      `SELECT g.jid, g.name, g.folder, g.is_main,
              (SELECT MAX(timestamp) FROM messages m WHERE m.chat_jid = g.jid) AS last_ts,
              (SELECT COUNT(*) FROM messages m WHERE m.chat_jid = g.jid AND m.timestamp >= ?) AS msg24,
              (SELECT COUNT(*) FROM messages m WHERE m.chat_jid = g.jid) AS msg_total,
              (SELECT COUNT(*) FROM messages m
                WHERE m.chat_jid = g.jid AND m.timestamp >= ? AND
                  (m.content LIKE '[Photo%' OR m.content LIKE '[Video%' OR
                   m.content LIKE '[Voice%' OR m.content LIKE '[Audio%' OR
                   m.content LIKE '[Document%')) AS media24,
              (SELECT content FROM messages m WHERE m.chat_jid = g.jid ORDER BY timestamp DESC, id DESC LIMIT 1) AS last_content,
              (SELECT sender_name FROM messages m WHERE m.chat_jid = g.jid ORDER BY timestamp DESC, id DESC LIMIT 1) AS last_sender_name,
              (SELECT sender FROM messages m WHERE m.chat_jid = g.jid ORDER BY timestamp DESC, id DESC LIMIT 1) AS last_sender,
              (SELECT is_bot_message FROM messages m WHERE m.chat_jid = g.jid ORDER BY timestamp DESC, id DESC LIMIT 1) AS last_is_bot,
              (SELECT is_from_me FROM messages m WHERE m.chat_jid = g.jid ORDER BY timestamp DESC, id DESC LIMIT 1) AS last_is_from_me
       FROM registered_groups g`,
    )
    .all(since, since) as RegisteredChatSummary[];
  const registeredByJid = new Map(registeredRows.map((row) => [row.jid, row]));
  const mainTelegramJid = registeredRows
    .filter((row) => row.jid.startsWith('tg:') && row.is_main === 1)
    .sort((a, b) => a.jid.localeCompare(b.jid))[0]?.jid;

  const rows: ChatRow[] = registeredRows
    .filter((row) => row.jid.startsWith('tg:'))
    .map((r) => {
      const entry = acl[r.jid] || {};
      const lastMs = r.last_ts ? new Date(r.last_ts).getTime() : NaN;
      const isBot = r.last_is_bot === 1;
      const isFromMe = r.last_is_from_me === 1;
      const lastKind = inferStoredMessageKind(r.last_content);
      const attention = detectDialogAttention({
        lastMessageAt: r.last_ts,
        outgoing: isBot || isFromMe,
        text: r.last_content,
        now,
      });
      return {
        jid: r.jid,
        name: r.name,
        sourceName: r.name,
        folder: r.folder,
        channel: 'telegram',
        channelLabel: 'Telegram',
        isGroup: false,
        isMain: r.is_main === 1,
        canSend: r.jid === mainTelegramJid,
        canPause: true,
        readOnly: r.jid !== mainTelegramJid,
        paused: entry.status === 'paused',
        pauseReason:
          entry.status === 'paused' ? String(entry.reason || '') : '',
        lastMessageAt: r.last_ts,
        lastMessageAgo: Number.isFinite(lastMs)
          ? formatAgo(lastMs)
          : 'нет сообщений',
        messages24h: r.msg24,
        messagesTotal: r.msg_total,
        media24h: r.media24,
        preview: previewText(r.last_content, lastKind),
        lastSender: isBot
          ? 'Скуби'
          : isFromMe
            ? 'Вы'
            : r.last_sender_name || r.last_sender || 'Собеседник',
        lastKind,
        pinned: false,
        ...attention,
        localAlias: '',
        linkedChats: [],
      };
    });

  const hasObserverTable = Boolean(
    db
      .prepare(
        `SELECT 1 FROM sqlite_master
         WHERE type = 'table' AND name = 'observed_whatsapp_messages'`,
      )
      .get(),
  );
  const observedJids = new Set<string>();
  if (hasObserverTable) {
    const observed = db
      .prepare(
        `SELECT o.chat_jid,
                MAX(o.timestamp) AS last_ts,
                SUM(CASE WHEN o.timestamp >= ? THEN 1 ELSE 0 END) AS msg24,
                COUNT(*) AS msg_total,
                SUM(CASE WHEN o.timestamp >= ? AND o.message_kind <> 'text' THEN 1 ELSE 0 END) AS media24,
                (SELECT NULLIF(TRIM(n.local_chat_label), '')
                   FROM observed_whatsapp_messages n
                  WHERE n.chat_jid = o.chat_jid
                    AND TRIM(n.local_chat_label) <> ''
                  ORDER BY n.timestamp DESC, n.message_id DESC LIMIT 1) AS chat_label,
                (SELECT n.content FROM observed_whatsapp_messages n
                  WHERE n.chat_jid = o.chat_jid
                  ORDER BY n.timestamp DESC, n.message_id DESC LIMIT 1) AS last_content,
                (SELECT n.local_sender_label FROM observed_whatsapp_messages n
                  WHERE n.chat_jid = o.chat_jid
                  ORDER BY n.timestamp DESC, n.message_id DESC LIMIT 1) AS last_sender,
                (SELECT n.from_me FROM observed_whatsapp_messages n
                  WHERE n.chat_jid = o.chat_jid
                  ORDER BY n.timestamp DESC, n.message_id DESC LIMIT 1) AS last_from_me,
                (SELECT n.message_kind FROM observed_whatsapp_messages n
                  WHERE n.chat_jid = o.chat_jid
                  ORDER BY n.timestamp DESC, n.message_id DESC LIMIT 1) AS last_kind
           FROM observed_whatsapp_messages o
          WHERE o.chat_jid LIKE '%@s.whatsapp.net'
             OR o.chat_jid LIKE '%@g.us'
             OR o.chat_jid LIKE '%@lid'
          GROUP BY o.chat_jid`,
      )
      .all(since, since) as Array<{
      chat_jid: string;
      last_ts: string;
      msg24: number;
      msg_total: number;
      media24: number;
      chat_label: string | null;
      last_content: string | null;
      last_sender: string | null;
      last_from_me: number;
      last_kind: string | null;
    }>;
    for (const item of observed) {
      observedJids.add(item.chat_jid);
      const registered = registeredByJid.get(item.chat_jid);
      const isGroup = item.chat_jid.endsWith('@g.us');
      const lastKind = String(item.last_kind || 'other');
      const lastMs = new Date(item.last_ts).getTime();
      const cleanLastContent = cleanObservedText(item.last_content, lastKind);
      const attention = detectDialogAttention({
        lastMessageAt: item.last_ts,
        outgoing: item.last_from_me === 1,
        text: cleanLastContent,
        now,
      });
      rows.push({
        jid: item.chat_jid,
        name: whatsappDisplayName(
          item.chat_label || registered?.name,
          item.chat_jid,
          isGroup,
        ),
        sourceName: whatsappDisplayName(
          item.chat_label || registered?.name,
          item.chat_jid,
          isGroup,
        ),
        folder: registered?.folder || '',
        channel: 'whatsapp',
        channelLabel: 'WhatsApp',
        isGroup,
        isMain: registered?.is_main === 1,
        canSend: false,
        canPause: false,
        readOnly: true,
        paused: false,
        pauseReason: '',
        lastMessageAt: item.last_ts,
        lastMessageAgo: Number.isFinite(lastMs)
          ? formatAgo(lastMs)
          : 'нет сообщений',
        messages24h: item.msg24,
        messagesTotal: item.msg_total,
        media24h: item.media24,
        preview: previewText(cleanLastContent, lastKind),
        lastSender:
          item.last_from_me === 1 ? 'Вы' : item.last_sender || 'Собеседник',
        lastKind,
        pinned: false,
        ...attention,
        localAlias: '',
        linkedChats: [],
      });
    }
  }

  // Зарегистрированный WhatsApp-чат может ещё не попасть в observer. В таком
  // случае показываем его из общей таблицы, но не дублируем после наблюдения.
  for (const r of registeredRows) {
    if (
      observedJids.has(r.jid) ||
      (!r.jid.endsWith('@s.whatsapp.net') &&
        !r.jid.endsWith('@g.us') &&
        !r.jid.endsWith('@lid'))
    ) {
      continue;
    }
    const isGroup = r.jid.endsWith('@g.us');
    const lastMs = r.last_ts ? new Date(r.last_ts).getTime() : NaN;
    const attention = detectDialogAttention({
      lastMessageAt: r.last_ts,
      outgoing: r.last_is_bot === 1 || r.last_is_from_me === 1,
      text: r.last_content,
      now,
    });
    rows.push({
      jid: r.jid,
      name: whatsappDisplayName(r.name, r.jid, isGroup),
      sourceName: whatsappDisplayName(r.name, r.jid, isGroup),
      folder: r.folder,
      channel: 'whatsapp',
      channelLabel: 'WhatsApp',
      isGroup,
      isMain: r.is_main === 1,
      canSend: false,
      canPause: false,
      readOnly: true,
      paused: false,
      pauseReason: '',
      lastMessageAt: r.last_ts,
      lastMessageAgo: Number.isFinite(lastMs)
        ? formatAgo(lastMs)
        : 'нет сообщений',
      messages24h: r.msg24,
      messagesTotal: r.msg_total,
      media24h: r.media24,
      preview: previewText(
        r.last_content,
        inferStoredMessageKind(r.last_content),
      ),
      lastSender:
        r.last_is_from_me === 1
          ? 'Вы'
          : r.last_sender_name || r.last_sender || 'Собеседник',
      lastKind: inferStoredMessageKind(r.last_content),
      pinned: false,
      ...attention,
      localAlias: '',
      linkedChats: [],
    });
  }

  const pinned = new Set(dialogState.pinned);
  for (const row of rows) {
    const alias = dialogState.aliases[row.jid] || '';
    row.localAlias = alias;
    if (alias) row.name = alias;
    row.pinned = pinned.has(row.jid);
  }
  const rowsByJid = new Map(rows.map((row) => [row.jid, row]));
  for (const row of rows) {
    row.linkedChats = (dialogState.links[row.jid] || [])
      .map((jid) => rowsByJid.get(jid))
      .filter((linked): linked is ChatRow => Boolean(linked))
      .map((linked) => ({
        jid: linked.jid,
        name: linked.name,
        channel: linked.channel,
      }));
  }

  return rows.sort((a, b) => {
    if (a.canSend !== b.canSend) return a.canSend ? -1 : 1;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return String(b.lastMessageAt || '').localeCompare(
      String(a.lastMessageAt || ''),
    );
  });
}

export function collectChatMessages(
  jid: string,
  limit = 80,
  maxChars = 12_000,
): DialogMessage[] {
  const db = readDb();
  const isWhatsapp =
    jid.endsWith('@s.whatsapp.net') ||
    jid.endsWith('@g.us') ||
    jid.endsWith('@lid');
  const hasObserverRows =
    isWhatsapp &&
    Boolean(
      db
        .prepare(
          `SELECT 1 FROM sqlite_master
           WHERE type = 'table' AND name = 'observed_whatsapp_messages'`,
        )
        .get(),
    ) &&
    Boolean(
      db
        .prepare(
          'SELECT 1 FROM observed_whatsapp_messages WHERE chat_jid = ? LIMIT 1',
        )
        .get(jid),
    );

  if (hasObserverRows) {
    const observed = db
      .prepare(
        `SELECT timestamp, from_me, local_sender_label, content,
                message_kind, media_enriched
           FROM observed_whatsapp_messages
          WHERE chat_jid = ?
          ORDER BY timestamp DESC, message_id DESC LIMIT ?`,
      )
      .all(jid, limit) as Array<{
      timestamp: string;
      from_me: number;
      local_sender_label: string | null;
      content: string;
      message_kind: string;
      media_enriched: number;
    }>;
    return observed.reverse().map((r) => ({
      isoTime: r.timestamp,
      time: new Date(r.timestamp).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      }),
      fromBot: false,
      outgoing: r.from_me === 1,
      sender: r.from_me === 1 ? 'Вы' : r.local_sender_label || 'Собеседник',
      text: cleanObservedText(r.content, r.message_kind).slice(0, maxChars),
      kind: String(r.message_kind || 'other'),
      mediaEnriched: r.media_enriched === 1,
    }));
  }

  const rows = db
    .prepare(
      `SELECT timestamp, is_bot_message, is_from_me, sender_name, sender, content
       FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(jid, limit) as Array<{
    timestamp: string;
    is_bot_message: number;
    is_from_me: number;
    sender_name: string | null;
    sender: string;
    content: string;
  }>;
  return rows.reverse().map((r) => {
    const fromBot =
      !isWhatsapp && (r.is_bot_message === 1 || r.is_from_me === 1);
    const outgoing = r.is_bot_message === 1 || r.is_from_me === 1;
    return {
      isoTime: r.timestamp,
      // В БД время в UTC (ISO-Z) — показываем локальное (находка ревью:
      // «на 5 часов раньше» в Алматы/Актау).
      time: new Date(r.timestamp).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      }),
      fromBot,
      outgoing,
      sender: isWhatsapp
        ? r.is_from_me === 1
          ? 'Вы'
          : r.sender_name || r.sender || 'Собеседник'
        : outgoing
          ? 'Скуби'
          : r.sender_name || r.sender,
      text: cleanDialogText(r.content).slice(0, maxChars),
      kind: inferStoredMessageKind(r.content),
      mediaEnriched: null,
    };
  });
}

// ── Задачи планировщика ────────────────────────────────────────────────────

export type TaskRow = {
  id: string;
  prompt: string;
  chatName: string;
  schedule: string;
  status: string;
  statusRaw: string;
  nextRun: string;
  lastResult: string;
  hasCalendar: boolean;
};

export function collectTasks(): TaskRow[] {
  const names = chatNameMap();
  const db = readDb();
  const calendarIds = new Set(
    (
      db.prepare('SELECT task_id FROM calendar_event_links').all() as Array<{
        task_id: string;
      }>
    ).map((r) => r.task_id),
  );
  const rows = db
    .prepare(
      `SELECT id, chat_jid, prompt, schedule_type, schedule_value, next_run, last_result, status
       FROM scheduled_tasks ORDER BY (next_run IS NULL), next_run LIMIT 100`,
    )
    .all() as Array<{
    id: string;
    chat_jid: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    next_run: string | null;
    last_result: string | null;
    status: string | null;
  }>;
  return rows.map((r) => {
    const nextMs = r.next_run ? new Date(r.next_run).getTime() : NaN;
    return {
      id: r.id,
      prompt: r.prompt.length > 120 ? `${r.prompt.slice(0, 120)}…` : r.prompt,
      chatName: names.get(r.chat_jid) || r.chat_jid,
      schedule: humanizeSchedule(r.schedule_type, r.schedule_value),
      status: humanizeTaskStatus(r.status),
      statusRaw: r.status || '',
      nextRun: Number.isFinite(nextMs)
        ? new Date(nextMs).toLocaleString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '—',
      lastResult: String(r.last_result || '').slice(0, 160),
      hasCalendar: calendarIds.has(r.id),
    };
  });
}

// ── Журнал ─────────────────────────────────────────────────────────────────

export function collectLogTail(opts: {
  onlyErrors?: boolean;
  query?: string;
  limit?: number;
}): LogLine[] {
  const limit = Math.min(opts.limit ?? 200, 500);
  let raw = '';
  try {
    const stat = fs.statSync(LOG_FILE);
    const size = 256 * 1024;
    const fd = fs.openSync(LOG_FILE, 'r');
    try {
      const start = Math.max(0, stat.size - size);
      const buf = Buffer.alloc(Math.min(size, stat.size));
      // Файл мог усохнуть между statSync и readSync (лог-ротация) — читаем
      // ровно bytesRead, иначе хвост из NUL-байтов (находка ревью).
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf-8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: LogLine[] = [];
  const lines = raw.split('\n');
  const q = (opts.query || '').toLowerCase();
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const parsed = parseLogLine(lines[i]);
    if (!parsed) continue;
    if (opts.onlyErrors && parsed.level !== 'ERROR' && parsed.level !== 'WARN')
      continue;
    if (q && !parsed.text.toLowerCase().includes(q)) continue;
    out.push(parsed);
  }
  return out.reverse();
}

// ── Модули ─────────────────────────────────────────────────────────────────

export type ModuleRow = {
  id: string;
  title: string;
  desc: string;
  on: boolean;
  kind: 'env' | 'info';
  restartNeeded: boolean;
};

export function collectModules(): ModuleRow[] {
  const env = readEnvFile([
    'SKOOBI_WHATSAPP_CHANNEL_ENABLED',
    'SKOOBI_WHATSAPP_PERSONAL_OBSERVER_ENABLED',
    'WHISPER_MODEL',
    'WHISPER_LANG',
    'WHISPER_ACCURACY_MODE',
    'WHISPER_NO_GPU',
    'SKOOBI_GOOGLE_CALENDAR_ENABLED',
    'SKOOBI_GOOGLE_WORKSPACE_ENABLED',
    'WEBHOOK_SECRET',
  ]);
  const on = (v: string | undefined) =>
    ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
  return [
    {
      id: 'messengers',
      title: 'Telegram + WhatsApp',
      desc:
        on(env.SKOOBI_WHATSAPP_CHANNEL_ENABLED) &&
        on(env.SKOOBI_WHATSAPP_PERSONAL_OBSERVER_ENABLED)
          ? 'Единая память диалогов включена; WhatsApp-медиа разбираются локально'
          : 'Telegram работает; интеграция WhatsApp включена не полностью',
      on:
        on(env.SKOOBI_WHATSAPP_CHANNEL_ENABLED) &&
        on(env.SKOOBI_WHATSAPP_PERSONAL_OBSERVER_ENABLED),
      kind: 'info',
      restartNeeded: false,
    },
    {
      id: 'voice_stt',
      title: 'Голосовые сообщения',
      desc: env.WHISPER_MODEL
        ? `Локальный whisper.cpp · язык ${env.WHISPER_LANG || 'auto'} · режим ${env.WHISPER_ACCURACY_MODE || 'обычный'} · ${on(env.WHISPER_NO_GPU) ? 'CPU' : 'Metal'}`
        : 'Локальная модель распознавания не указана',
      on: Boolean(env.WHISPER_MODEL),
      kind: 'info',
      restartNeeded: false,
    },
    {
      id: 'images',
      title: 'Изображения',
      desc: 'Создание и отправка изображений через встроенный инструмент Codex',
      on: true,
      kind: 'info',
      restartNeeded: false,
    },
    {
      // Не тумблер: у календаря многосоставная настройка (ключ-файл, id
      // календаря) — включается в .env, панель только показывает статус.
      id: 'calendar',
      title: 'Google-Календарь',
      desc: on(env.SKOOBI_GOOGLE_CALENDAR_ENABLED)
        ? 'Напоминания зеркалятся в календарь · детали на вкладке «Google»'
        : 'Выключен (настраивается в .env: SKOOBI_GOOGLE_CALENDAR_*)',
      on: on(env.SKOOBI_GOOGLE_CALENDAR_ENABLED),
      kind: 'info',
      restartNeeded: true,
    },
    {
      // Тоже не тумблер: OAuth-креды заводятся руками (.env), панель
      // показывает статус; живая проверка — на вкладке «Google».
      id: 'google_workspace',
      title: 'Google Workspace (Drive/Sheets/Apps Script)',
      desc: on(env.SKOOBI_GOOGLE_WORKSPACE_ENABLED)
        ? 'Скуби работает с Диском, Таблицами и скриптами через API · вкладка «Google»'
        : 'Выключен (настраивается в .env: SKOOBI_GOOGLE_WORKSPACE_*)',
      on: on(env.SKOOBI_GOOGLE_WORKSPACE_ENABLED),
      kind: 'info',
      restartNeeded: true,
    },
    {
      id: 'webhook',
      title: 'Веб-хук',
      desc: env.WEBHOOK_SECRET
        ? 'Приём внешних событий настроен'
        : 'Не настроен (нет WEBHOOK_SECRET)',
      on: Boolean(env.WEBHOOK_SECRET),
      kind: 'info',
      restartNeeded: false,
    },
  ];
}
