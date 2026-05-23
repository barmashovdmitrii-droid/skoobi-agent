/**
 * Standalone smoke driver for the WhatsApp channel — boots the adapter without
 * the full orchestrator pipeline so we can verify Baileys connects, QR/auth
 * works, and onMessage fires for inbound messages.
 *
 * Usage:
 *   WHATSAPP_AUTH_DIR=/path/to/auth npx tsx scripts/whatsapp-smoke.ts
 *
 * The script does NOT auto-reply — it logs each inbound message and exits on
 * Ctrl+C. Safe to point at an existing scanned session.
 */
import path from 'node:path';
import { WhatsAppChannel } from '../src/channels/whatsapp.js';
import { logger } from '../src/orchestrator/logger.js';
import type { RegisteredGroup } from '../src/orchestrator/types.js';

const authDir =
  process.env.WHATSAPP_AUTH_DIR ||
  path.resolve(process.cwd(), 'whatsapp-smoke-auth');

const registered = new Map<string, RegisteredGroup>();

const channel = new WhatsAppChannel({
  authDir,
  defaultFolder: 'main',
  onMessage: (chatJid, msg) => {
    logger.info(
      {
        chatJid,
        sender: msg.sender,
        senderName: msg.sender_name,
        content: msg.content,
        identity: msg.sender_identity,
      },
      'SMOKE: inbound message',
    );
  },
  onChatMetadata: (chatJid, timestamp, name, channelName, isGroup) => {
    logger.debug(
      { chatJid, timestamp, name, channel: channelName, isGroup },
      'SMOKE: chat metadata',
    );
  },
  registeredGroups: () => Object.fromEntries(registered),
  registerGroup: (jid, group) => {
    registered.set(jid, group);
    logger.info({ jid, folder: group.folder }, 'SMOKE: auto-registered chat');
  },
  ownerAllowlist: () => ({
    telegram_user_ids: new Set(),
    telegram_chat_ids: new Set(),
    whatsapp_phones: new Set(
      (process.env.OWNER_WHATSAPP_PHONES ?? '')
        .split(',')
        .map((s) => s.trim().replace(/[^0-9]/g, ''))
        .filter(Boolean),
    ),
  }),
});

async function main() {
  logger.info({ authDir }, 'SMOKE: starting WhatsApp channel');
  await channel.connect();
  logger.info('SMOKE: connect() resolved — waiting for messages (Ctrl+C to exit)');
}

process.on('SIGINT', async () => {
  logger.info('SMOKE: SIGINT — disconnecting');
  await channel.disconnect();
  process.exit(0);
});

main().catch((err) => {
  logger.fatal({ err }, 'SMOKE: fatal');
  process.exit(1);
});
