/**
 * MessageRouter — single outbound delivery service.
 * All output (agent responses, IPC messages, task results, extension output)
 * routes through here. Supports pre/post hooks for extensions.
 */
import path from 'node:path';

import {
  Channel,
  MessageRouter,
  OutboundEnvelope,
  OutboundPreHook,
} from './types.js';
import { formatOutbound } from './router.js';
import { logger } from './logger.js';

function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

function fileLogFields(filePath: string): { fileBasename: string } {
  return { fileBasename: path.basename(filePath) };
}

export function createMessageRouter(channels: Channel[]): MessageRouter {
  const preHooks: OutboundPreHook[] = [];
  const postHooks: ((envelope: OutboundEnvelope) => void)[] = [];

  const runPostHooks = (envelope: OutboundEnvelope): void => {
    for (const hook of postHooks) {
      try {
        hook(envelope);
      } catch (err) {
        logger.error({ err }, 'Outbound post-hook error');
      }
    }
  };

  return {
    addPreHook(hook: OutboundPreHook): void {
      preHooks.push(hook);
    },

    addPostHook(hook: (envelope: OutboundEnvelope) => void): void {
      postHooks.push(hook);
    },

    async route(envelope: OutboundEnvelope): Promise<string | null> {
      let current = envelope;

      // Run pre-hooks sequentially
      for (const hook of preHooks) {
        try {
          const result = await hook(current);
          if (result.action === 'drop') {
            logger.debug(
              { jid: current.chatJid, reason: result.reason },
              'Outbound message dropped by pre-hook',
            );
            return null;
          }
          if (result.action === 'modify') {
            current = result.envelope;
          }
        } catch (err) {
          logger.error({ err }, 'Outbound pre-hook error (continuing)');
        }
      }

      // Format (strip internal tags)
      const formatted = formatOutbound(current.text);
      if (!formatted) return null;

      // Find channel and deliver
      const channel = channels.find(
        (c) => c.ownsJid(current.chatJid) && c.isConnected(),
      );
      if (!channel) {
        logger.warn(
          { jid: current.chatJid },
          'No connected channel for JID — message not delivered',
        );
        throw new Error(`No connected channel for JID: ${current.chatJid}`);
      }

      await channel.sendMessage(current.chatJid, formatted);

      // Fire post-hooks (observe only, errors don't affect delivery)
      runPostHooks(current);
      return formatted;
    },

    async send(jid: string, text: string): Promise<void> {
      await this.route({
        chatJid: jid,
        text,
        triggerType: 'extension',
      });
    },

    async sendPhoto(
      jid: string,
      filePath: string,
      caption?: string,
    ): Promise<boolean> {
      const channel = channels.find(
        (c) =>
          c.ownsJid(jid) &&
          c.isConnected() &&
          typeof c.sendPhoto === 'function',
      );
      if (!channel || !channel.sendPhoto) {
        logger.warn(
          { jid, ...fileLogFields(filePath) },
          'No channel supports sendPhoto for this JID',
        );
        return false;
      }
      try {
        await channel.sendPhoto(jid, filePath, caption);
        logger.info(
          { jid, ...fileLogFields(filePath), caption: caption?.slice(0, 50) },
          'Photo sent',
        );
        runPostHooks({
          chatJid: jid,
          text: caption || '',
          triggerType: 'ipc',
          meta: { kind: 'photo', filePath },
        });
        return true;
      } catch (err) {
        logger.error(
          { jid, ...fileLogFields(filePath), err },
          'Failed to send photo',
        );
        return false;
      }
    },

    async sendDocument(
      jid: string,
      filePath: string,
      caption?: string,
    ): Promise<boolean> {
      const channel = channels.find(
        (c) =>
          c.ownsJid(jid) &&
          c.isConnected() &&
          typeof c.sendDocument === 'function',
      );
      if (!channel || !channel.sendDocument) {
        logger.warn(
          { jid, ...fileLogFields(filePath) },
          'No channel supports sendDocument for this JID',
        );
        return false;
      }
      try {
        await channel.sendDocument(jid, filePath, caption);
        logger.info(
          { jid, ...fileLogFields(filePath), caption: caption?.slice(0, 50) },
          'Document sent',
        );
        runPostHooks({
          chatJid: jid,
          text: caption || '',
          triggerType: 'ipc',
          meta: { kind: 'document', filePath },
        });
        return true;
      } catch (err) {
        logger.error(
          { jid, ...fileLogFields(filePath), err },
          'Failed to send document',
        );
        return false;
      }
    },

    async sendVoice(jid: string, text: string): Promise<boolean> {
      const channel = channels.find(
        (c) =>
          c.ownsJid(jid) &&
          c.isConnected() &&
          typeof c.sendVoice === 'function',
      );
      if (!channel || !channel.sendVoice) {
        logger.warn({ jid }, 'No channel supports sendVoice for this JID');
        return false;
      }
      try {
        await channel.sendVoice(jid, text);
        logger.info({ jid, length: text.length }, 'Voice sent');
        runPostHooks({
          chatJid: jid,
          text,
          triggerType: 'ipc',
          meta: { kind: 'voice' },
        });
        return true;
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send voice');
        return false;
      }
    },
  };
}
