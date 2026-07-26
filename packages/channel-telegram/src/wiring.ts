// Сборка Telegram-канала из кирпича @skoobi/channel-telegram (волна 7c;
// с волны 9a обвязка живёт в самом пакете субэкспортом './wiring' — одна на
// все сборки вместо копии в каждом инстансе). Ядро отдаёт каналу узкий host:
// read-only SQL-чтения по chats/messages (текст запросов живёт здесь, рядом
// с владельцем БД), события тенанта, квоту, приватный админ-режим и подпись
// фото. Пакет отдаёт ядру Channel. Саморегистрация как раньше — side-effect
// импорта этого модуля из channels/index.ts сборки. Зависимость
// wiring → @skoobi/core ациклична: core каналы не импортирует.
import { getDb } from '@skoobi/core/db';
import { recordTenantEvent } from '@skoobi/core/event-store';
import { logger } from '@skoobi/shared/logger';
import { formatQuotaStatusRu, getQuotaStatus } from '@skoobi/billing/quota';
import {
  isPrivateAdminTelegramUser,
  privateAdminClosedBotText,
  privateAdminModeEnabled,
} from '@skoobi/shared/private-admin';
import {
  registerChannel,
  type ChannelOpts,
} from '@skoobi/core/channel-registry';
import type { TenantRecord } from '@skoobi/core/tenant-registry';
import { captionPhoto } from './photo-caption.js';
import {
  TelegramChannel,
  TelegramMultiBotChannel,
  telegramRuntimeConfigsFromEnv,
  type TelegramChannelHost,
  type TelegramStatsTotalsRow,
  type TelegramStatsUserRow,
} from './index.js';

const host: TelegramChannelHost = {
  knownChatNames(jids) {
    const placeholders = jids.map(() => '?').join(',');
    return getDb()
      .prepare(
        `SELECT jid, name FROM (
          SELECT jid, name, last_message_time AS ts, 1 AS priority
          FROM chats
          WHERE jid IN (${placeholders})
          UNION ALL
          SELECT chat_jid AS jid, sender_name AS name, timestamp AS ts, 0 AS priority
          FROM messages
          WHERE chat_jid IN (${placeholders})
        )
        ORDER BY priority ASC, ts DESC`,
      )
      .all(...jids, ...jids) as Array<{ jid: string; name: string | null }>;
  },
  statsUsersToday(sinceIso) {
    return getDb()
      .prepare(
        `SELECT
           m.sender AS sender,
           COALESCE(
             (
               SELECT NULLIF(TRIM(m2.sender_name), '')
               FROM messages m2
               WHERE m2.sender = m.sender
                 AND m2.timestamp >= ?
                 AND m2.is_bot_message = 0
                 AND m2.is_from_me = 0
                 AND NULLIF(TRIM(m2.sender_name), '') IS NOT NULL
               ORDER BY m2.timestamp DESC, m2.id DESC
               LIMIT 1
             ),
             m.sender
           ) AS display_name,
           COUNT(*) AS message_count
         FROM messages m
         WHERE m.timestamp >= ?
           AND m.is_bot_message = 0
           AND m.is_from_me = 0
         GROUP BY m.sender
         ORDER BY message_count DESC, display_name COLLATE NOCASE ASC, m.sender ASC`,
      )
      .all(sinceIso, sinceIso) as TelegramStatsUserRow[];
  },
  statsTotalsToday(sinceIso) {
    return getDb()
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN is_bot_message = 0 AND is_from_me = 0 THEN 1 ELSE 0 END), 0) AS user_messages,
           COALESCE(SUM(CASE WHEN is_bot_message = 1 THEN 1 ELSE 0 END), 0) AS bot_messages
         FROM messages
         WHERE timestamp >= ?`,
      )
      .get(sinceIso) as TelegramStatsTotalsRow | undefined;
  },
  chatsLastSeen(jids) {
    const placeholders = jids.map(() => '?').join(',');
    return getDb()
      .prepare(
        `SELECT jid, last_message_time FROM chats WHERE jid IN (${placeholders})`,
      )
      .all(...jids) as Array<{ jid: string; last_message_time: string | null }>;
  },
  messagesToday() {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM messages WHERE date(timestamp) = date('now', 'localtime')`,
      )
      .get() as { c: number } | undefined;
    return row?.c ?? 0;
  },
  recordTenantEvent(event) {
    // Инвариант: TelegramTenantView-объекты приходят только из
    // opts.tenantRegistry() этой же обвязки — на рантайме это полный
    // ядровый TenantRecord.
    recordTenantEvent({ ...event, tenant: event.tenant as TenantRecord });
  },
  quotaStatusTextRu(input) {
    return formatQuotaStatusRu(getQuotaStatus(input));
  },
  privateAdminModeEnabled,
  isPrivateAdminTelegramUser,
  privateAdminClosedBotText,
  captionPhoto,
};

registerChannel('telegram', (opts: ChannelOpts) => {
  const configs = telegramRuntimeConfigsFromEnv();
  if (configs.length === 0) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  const channels = configs.map(
    (config) =>
      new TelegramChannel(config.token, {
        ...opts,
        host,
        botId: config.botId,
        personaId: config.personaId,
      }),
  );
  const ownerNotificationChannel =
    channels.find((channel) => channel.isDefaultBotChannel()) || channels[0];
  for (const channel of channels) {
    channel.setPeerChannels(channels);
    channel.setOwnerNotificationChannel(ownerNotificationChannel);
  }
  return channels.length === 1
    ? channels[0]
    : new TelegramMultiBotChannel(channels);
});
