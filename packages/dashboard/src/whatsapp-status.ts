import { readEnvFile } from '@skoobi/shared/env';

import { readDb } from './db.js';
import { formatAgo } from './humanize.js';

const ENV_KEYS = [
  'SKOOBI_WHATSAPP_CHANNEL_ENABLED',
  'SKOOBI_WHATSAPP_PERSONAL_OBSERVER_ENABLED',
] as const;

const RECENT_DATA_WINDOW_MS = 24 * 60 * 60 * 1000;

export type WhatsAppStatusState = 'ok' | 'warn' | 'down';

export type WhatsAppStatus = {
  state: WhatsAppStatusState;
  detail: string;
  channelEnabled: boolean;
  observerEnabled: boolean;
  tableAvailable: boolean;
  lastObservedAt: string | null;
  lastObservedAgo: string | null;
  messages24h: number;
  media24h: number;
  unprocessedMedia: number;
  lastEnrichedAt: string | null;
  lastEnrichedAgo: string | null;
};

type WhatsAppStatusRow = {
  last_observed_at: string | null;
  messages_24h: number | null;
  media_24h: number | null;
  unprocessed_media: number | null;
  last_enriched_at: string | null;
};

type WhatsAppStatusSnapshot = {
  channelEnabled: boolean;
  observerEnabled: boolean;
  tableAvailable: boolean;
  lastObservedAt: string | null;
  messages24h: number;
  media24h: number;
  unprocessedMedia: number;
  lastEnrichedAt: string | null;
};

function isEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(value || '')
      .trim()
      .toLowerCase(),
  );
}

function envValue(
  fileValues: Record<string, string>,
  key: (typeof ENV_KEYS)[number],
): string | undefined {
  return process.env[key] || fileValues[key];
}

function safeCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function safeIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function countLabel(
  count: number,
  singular: string,
  few: string,
  many: string,
) {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} ${many}`;
  if (mod10 === 1) return `${count} ${singular}`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}

function statusFromSnapshot(
  snapshot: WhatsAppStatusSnapshot,
  now: number,
): Pick<WhatsAppStatus, 'state' | 'detail'> {
  if (!snapshot.channelEnabled) {
    return {
      state: 'down',
      detail: 'Канал WhatsApp выключен в локальной конфигурации.',
    };
  }
  if (!snapshot.observerEnabled) {
    return {
      state: 'warn',
      detail:
        'Канал включён, но синхронизация личных диалогов WhatsApp выключена.',
    };
  }
  if (!snapshot.tableAvailable) {
    return {
      state: 'down',
      detail: 'Локальное хранилище синхронизации WhatsApp недоступно.',
    };
  }
  if (!snapshot.lastObservedAt) {
    return {
      state: 'warn',
      detail:
        'Синхронизация включена, но в локальном хранилище ещё нет сообщений WhatsApp.',
    };
  }

  const lastObservedMs = Date.parse(snapshot.lastObservedAt);
  const lastObservedAgo = formatAgo(lastObservedMs, now);
  if (now - lastObservedMs > RECENT_DATA_WINDOW_MS) {
    return {
      state: 'warn',
      detail: `Данные WhatsApp последний раз поступали ${lastObservedAgo}. Текущее подключение по локальной истории подтвердить нельзя.`,
    };
  }
  if (snapshot.unprocessedMedia > 0) {
    const pending = countLabel(
      snapshot.unprocessedMedia,
      'медиафайл за сутки пока без',
      'медиафайла за сутки пока без',
      'медиафайлов за сутки пока без',
    );
    return {
      state: 'warn',
      detail: `Данные WhatsApp поступали ${lastObservedAgo}; ${pending} локального разбора.`,
    };
  }
  return {
    state: 'ok',
    detail: `Данные WhatsApp поступали ${lastObservedAgo}; за последние сутки не осталось медиа без локального разбора.`,
  };
}

/**
 * Локальный диагностический снимок WhatsApp.
 *
 * Он намеренно не называет канал «подключённым»: флаги .env говорят лишь о
 * конфигурации, а SQLite подтверждает только то, что данные действительно
 * поступали в некоторый момент времени. Содержимое сообщений не читается.
 */
export function collectWhatsAppStatus(now = Date.now()): WhatsAppStatus {
  const fileValues = readEnvFile([...ENV_KEYS]);
  const channelEnabled = isEnabled(
    envValue(fileValues, 'SKOOBI_WHATSAPP_CHANNEL_ENABLED'),
  );
  const observerEnabled = isEnabled(
    envValue(fileValues, 'SKOOBI_WHATSAPP_PERSONAL_OBSERVER_ENABLED'),
  );

  let snapshot: WhatsAppStatusSnapshot = {
    channelEnabled,
    observerEnabled,
    tableAvailable: false,
    lastObservedAt: null,
    messages24h: 0,
    media24h: 0,
    unprocessedMedia: 0,
    lastEnrichedAt: null,
  };

  try {
    const db = readDb();
    const tableAvailable = Boolean(
      db
        .prepare(
          `SELECT 1
             FROM sqlite_master
            WHERE type = 'table' AND name = 'observed_whatsapp_messages'`,
        )
        .get(),
    );
    snapshot = { ...snapshot, tableAvailable };
    if (tableAvailable) {
      const cutoff = new Date(now - RECENT_DATA_WINDOW_MS).toISOString();
      const row = db
        .prepare(
          `SELECT
             MAX(observed_at) AS last_observed_at,
             SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) AS messages_24h,
             SUM(CASE
                   WHEN timestamp >= ? AND message_kind != 'text' THEN 1
                   ELSE 0
                 END) AS media_24h,
             SUM(CASE
                   WHEN timestamp >= ? AND message_kind != 'text'
                        AND media_enriched = 0 THEN 1
                   ELSE 0
                 END) AS unprocessed_media,
             MAX(CASE
                   WHEN message_kind != 'text' AND media_enriched = 1
                   THEN observed_at
                   ELSE NULL
                 END) AS last_enriched_at
           FROM observed_whatsapp_messages`,
        )
        .get(cutoff, cutoff, cutoff) as WhatsAppStatusRow;
      snapshot = {
        ...snapshot,
        lastObservedAt: safeIso(row?.last_observed_at),
        messages24h: safeCount(row?.messages_24h),
        media24h: safeCount(row?.media_24h),
        unprocessedMedia: safeCount(row?.unprocessed_media),
        lastEnrichedAt: safeIso(row?.last_enriched_at),
      };
    }
  } catch {
    // Панель остаётся доступной даже до создания БД/таблицы. Детали исключения
    // не возвращаем: локальные пути и SQL не должны попадать в браузер.
  }

  const presentation = statusFromSnapshot(snapshot, now);
  return {
    ...snapshot,
    ...presentation,
    lastObservedAgo: snapshot.lastObservedAt
      ? formatAgo(Date.parse(snapshot.lastObservedAt), now)
      : null,
    lastEnrichedAgo: snapshot.lastEnrichedAt
      ? formatAgo(Date.parse(snapshot.lastEnrichedAt), now)
      : null,
  };
}
