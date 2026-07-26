// Сборка WhatsApp-канала из кирпича @skoobi/channel-whatsapp (волна 7d,
// зеркало обвязки Telegram волны 7c). Ядро отдаёт каналу узкий host: имена
// чатов и метку последнего group-sync (текст SQL живёт здесь, рядом с
// владельцем БД). Пакет отдаёт ядру Channel.
//
// Main импортирует обвязку только при явном instance-флаге; без него канал не
// регистрируется. Auth: npm run auth:whatsapp из корня инстанса — credentials
// сохраняются в корневой ./store/auth.
import fs from 'fs';
import path from 'path';

import { ASSISTANT_HAS_OWN_NUMBER } from '@skoobi/core/config';
import { getDb, getRouterState, setRouterState } from '@skoobi/core/db';
import {
  pruneObservedWhatsAppMessages,
  storeObservedWhatsAppMessage,
  storeObservedWhatsAppMessagesBatch,
} from '@skoobi/core/whatsapp-observer';
import { logger } from '@skoobi/shared/logger';
import {
  registerChannel,
  type ChannelOpts,
} from '@skoobi/core/channel-registry';
import {
  WhatsAppChannel,
  STORE_DIR,
  WHATSAPP_PERSONAL_OBSERVER,
  type WhatsAppChannelHost,
  type WhatsAppObserverMediaBackfillProgress,
  type WhatsAppObservedMessage,
} from './index.js';

const OBSERVER_BATCH_CHUNK_SIZE = 1_000;
const OBSERVER_MEDIA_BACKFILL_PROGRESS_KEY =
  'whatsapp_observer_media_backfill.v1';

function observerStoreInput(message: WhatsAppObservedMessage) {
  return {
    messageId: message.id,
    chatJid: message.chatJid,
    chatLabel: message.chatName,
    senderLabel: message.senderName,
    content: message.content,
    timestamp: message.timestamp,
    fromMe: message.fromMe,
    messageKind: message.contentType,
    upsertType: message.eventType,
    mediaEnriched: message.mediaEnriched === true,
  };
}

function observerRetention() {
  return {
    retentionDays: WHATSAPP_PERSONAL_OBSERVER.retentionDays,
    maxRows: WHATSAPP_PERSONAL_OBSERVER.maxRows,
  };
}

const host: WhatsAppChannelHost = {
  // Метка последнего group-sync хранится сентинель-строкой '__group_sync__'
  // в chats — точная реплика исторических db.getLastGroupSync /
  // setLastGroupSync (66e02ec^).
  getLastGroupSync() {
    const row = getDb()
      .prepare(
        `SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`,
      )
      .get() as { last_message_time: string } | undefined;
    return row?.last_message_time || null;
  },
  setLastGroupSync() {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
      )
      .run(new Date().toISOString());
  },
  updateChatName(chatJid, name) {
    getDb()
      .prepare(
        `
        INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET name = excluded.name
      `,
      )
      .run(chatJid, name, new Date().toISOString());
  },
  isOwnerMediaSender({ fromMe }) {
    // Baileys derives fromMe from the authenticated account, so it is a
    // host/protocol fact rather than guest-controlled message text. In the
    // supported shared-number setup that account is the owner. If the
    // assistant has its own number, fromMe identifies the bot instead and must
    // never grant owner media reserve; without a separate reviewed WhatsApp
    // owner allowlist the safe fallback is guest.
    return fromMe === true && ASSISTANT_HAS_OWN_NUMBER !== true;
  },
  onObservedMessage(message) {
    storeObservedWhatsAppMessage(
      observerStoreInput(message),
      observerRetention(),
    );
  },
  onObservedMessages(messages) {
    for (
      let offset = 0;
      offset < messages.length;
      offset += OBSERVER_BATCH_CHUNK_SIZE
    ) {
      storeObservedWhatsAppMessagesBatch(
        messages
          .slice(offset, offset + OBSERVER_BATCH_CHUNK_SIZE)
          .map(observerStoreInput),
        observerRetention(),
      );
    }
  },
  getObservedMediaBackfillAnchors(limit, excludedChatJids = []) {
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(0, Math.min(50, Math.floor(limit)))
      : 0;
    if (boundedLimit === 0) return [];
    const excluded = [
      ...new Set(
        excludedChatJids.filter(
          (jid) =>
            typeof jid === 'string' &&
            jid.length <= 128 &&
            (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us')),
        ),
      ),
    ].slice(0, WHATSAPP_PERSONAL_OBSERVER.maxRows);
    return getDb()
      .prepare(
        `WITH all_gaps AS (
           SELECT
             message_id,
             chat_jid,
             timestamp AS gap_timestamp,
             from_me,
             COUNT(*) OVER (PARTITION BY chat_jid) AS missing_media_count
           FROM observed_whatsapp_messages
           WHERE message_kind IN ('image', 'video', 'voice', 'audio', 'document')
             AND media_enriched = 0
             AND (
               chat_jid GLOB '*@s.whatsapp.net'
               OR chat_jid GLOB '*@g.us'
             )
             AND chat_jid NOT IN (SELECT value FROM json_each(?))
         ), eligible_gaps AS (
           SELECT
             *,
             ROW_NUMBER() OVER (
               PARTITION BY chat_jid
               ORDER BY gap_timestamp DESC, message_id DESC
             ) AS gap_position
           FROM all_gaps AS gap
           WHERE EXISTS (
             SELECT 1
             FROM observed_whatsapp_messages AS newer
             WHERE newer.chat_jid = gap.chat_jid
               AND newer.timestamp > gap.gap_timestamp
           )
         ), anchor_candidates AS (
           SELECT
             gap.chat_jid,
             gap.gap_timestamp,
             gap.message_id AS gap_message_id,
             gap.missing_media_count,
             newer.message_id AS anchor_message_id,
             newer.timestamp AS anchor_timestamp,
             newer.from_me AS anchor_from_me,
             ROW_NUMBER() OVER (
               PARTITION BY gap.chat_jid
               ORDER BY newer.timestamp ASC, newer.message_id ASC
             ) AS anchor_position
           FROM eligible_gaps AS gap
           JOIN observed_whatsapp_messages AS newer
             ON newer.chat_jid = gap.chat_jid
            AND newer.timestamp > gap.gap_timestamp
           WHERE gap.gap_position = 1
         )
         SELECT
           anchor_message_id AS messageId,
           chat_jid AS chatJid,
           anchor_timestamp AS timestamp,
           anchor_from_me AS fromMe
         FROM anchor_candidates
         WHERE anchor_position = 1
         ORDER BY missing_media_count DESC, gap_timestamp DESC, gap_message_id DESC, chat_jid
         LIMIT ?`,
      )
      .all(JSON.stringify(excluded), boundedLimit)
      .map((row) => {
        const value = row as {
          messageId: string;
          chatJid: string;
          timestamp: string;
          fromMe: number;
        };
        return { ...value, fromMe: value.fromMe === 1 };
      });
  },
  getObservedMediaBackfillProgress() {
    const raw = getRouterState(OBSERVER_MEDIA_BACKFILL_PROGRESS_KEY);
    if (!raw) return undefined;
    try {
      // The channel validates the version, deadline, JID shape and bounded
      // list before using this local state. Wiring deliberately does not log
      // the value because it contains private WhatsApp chat identifiers.
      return JSON.parse(raw) as WhatsAppObserverMediaBackfillProgress;
    } catch (error) {
      logger.warn(
        { errorKind: error instanceof Error ? error.name : typeof error },
        'WhatsApp observer media backfill progress ignored',
      );
      return undefined;
    }
  },
  setObservedMediaBackfillProgress(progress) {
    setRouterState(
      OBSERVER_MEDIA_BACKFILL_PROGRESS_KEY,
      JSON.stringify(progress),
    );
  },
};

const OBSERVER_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let observerPruneTimer: NodeJS.Timeout | null = null;

function enforceObserverRetention(): void {
  try {
    const result = pruneObservedWhatsAppMessages({
      retentionDays: WHATSAPP_PERSONAL_OBSERVER.retentionDays,
      maxRows: WHATSAPP_PERSONAL_OBSERVER.maxRows,
    });
    if (result.pruned > 0) {
      logger.info(
        { pruned: result.pruned, remaining: result.remaining },
        'WhatsApp observer retention enforced',
      );
    }
  } catch (error) {
    const sqliteCode = (error as { code?: unknown } | null)?.code;
    const errorKind =
      sqliteCode === 'SQLITE_BUSY' || sqliteCode === 'SQLITE_LOCKED'
        ? sqliteCode
        : error instanceof Error
          ? error.name || 'Error'
          : typeof error;
    // Retention is maintenance, not a startup dependency. In particular, a
    // transient SQLite writer lock must not take down every channel. Never log
    // the exception/message here because it can include SQL or local paths.
    logger.warn(
      { errorKind },
      'WhatsApp observer retention deferred after local database error',
    );
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => {
  if (WHATSAPP_PERSONAL_OBSERVER.enabled) {
    enforceObserverRetention();
    if (!observerPruneTimer) {
      observerPruneTimer = setInterval(
        enforceObserverRetention,
        OBSERVER_PRUNE_INTERVAL_MS,
      );
      observerPruneTimer.unref();
    }
  }
  // WhatsApp auth is file-based (store/auth/creds.json from Baileys).
  // If no auth directory or creds file exists, the channel was never set up.
  const authDir = path.join(STORE_DIR, 'auth');
  const credsFile = path.join(authDir, 'creds.json');
  if (!fs.existsSync(credsFile)) {
    logger.warn(
      'WhatsApp: no auth credentials found (store/auth/creds.json) — skipping. Run: npm run auth:whatsapp',
    );
    return null;
  }
  return new WhatsAppChannel({ ...opts, host });
});
