/**
 * MessageRouter — single outbound delivery service.
 * All output (agent responses, IPC messages, task results, extension output)
 * routes through here. Supports pre/post hooks for extensions.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startOperationTraceStage } from '@skoobi/shared/operation-trace';
import { currentOperationTrace } from './runtime-operation-trace.js';
import type { ArtifactDeliveryDecision } from './artifact-acceptance-policy.js';

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

function jidLogRef(jid: string): string {
  return createHash('sha256').update(jid, 'utf8').digest('hex').slice(0, 12);
}

export function createMessageRouter(channels: Channel[], hostOptions: {
  /** Only a host-approved contract may require a signed artifact check. */
  artifactAcceptance?: (artifactPath: string) => Promise<ArtifactDeliveryDecision>;
} = {}): MessageRouter {
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
      const trace = currentOperationTrace();
      const response = startOperationTraceStage(trace, 'response');

      // Run pre-hooks sequentially
      for (const hook of preHooks) {
        try {
          const result = await hook(current);
          if (result.action === 'drop') {
            response.finish('skipped', { reason: 'dropped' });
            logger.debug(
              { jidHash: jidLogRef(current.chatJid), reason: result.reason },
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
      if (!formatted) {
        response.finish('skipped', { reason: 'no_output' });
        // Nothing user-visible to deliver. For IPC sends the post-hook carries
        // required cursor-advance semantics (advanceCursorAfterDeliveredIpc): an
        // effectively-empty (whitespace/all-<internal>) IPC envelope survives
        // the IPC dispatch guards, so skipping the post-hook here would leave
        // the channel cursor parked and the runner's turn re-processed (L27).
        // Treat it as a confirmed no-op delivery and still advance the cursor,
        // recording the delivered (empty) text rather than the raw <internal>
        // payload (L28). Non-IPC empty sends remain no-ops (no observer fired).
        if (current.triggerType === 'ipc') {
          runPostHooks({ ...current, text: formatted });
        }
        return null;
      }
      response.finish('succeeded');

      const delivery = startOperationTraceStage(trace, 'delivery', {
        deliveryKind: current.meta?.kind === 'agent_progress' || current.meta?.kind === 'host_progress' ? 'progress' : 'final',
      });

      // Find channel and deliver
      const channel = channels.find(
        (c) => c.ownsJid(current.chatJid) && c.isConnected(),
      );
      if (!channel) {
        delivery.finish('failed', { reason: 'unavailable' });
        logger.warn(
          { jidHash: jidLogRef(current.chatJid) },
          'No connected channel for JID — message not delivered',
        );
        throw new Error('No connected channel for JID');
      }

      const progressKey = current.meta?.progressKey;
      try {
      if (
        channel.sendProgress &&
        typeof progressKey === 'string' &&
        progressKey.length > 0 &&
        (current.meta?.kind === 'agent_progress' ||
          current.meta?.kind === 'host_progress')
      ) {
        const delivered = await channel.sendProgress(current.chatJid, formatted, progressKey);
        if (!delivered) {
          delivery.finish('skipped', { reason: 'dropped' });
          return null;
        }
      } else {
        if (
          current.meta?.progressFinal === true &&
          typeof progressKey === 'string' && progressKey.length > 0
        ) {
          await channel.finishProgress?.(current.chatJid, progressKey);
        }
        await channel.sendMessage(current.chatJid, formatted);
      }
      } catch (error) {
        // A timeout can follow a successful remote send; absence of an ACK
        // does not prove the send failed and must never authorize a replay.
        delivery.finish('unknown', { reason: 'outcome_unknown' });
        throw error;
      }
      delivery.finish('succeeded', { reason: 'api_acknowledged' });

      // Fire post-hooks (observe only, errors don't affect delivery). Record the
      // text actually delivered (internal tags stripped), not the raw envelope
      // text, so audit observers log exactly what the user received (L28).
      runPostHooks({ ...current, text: formatted });
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
      options?: {
        suppressCursorAdvance?: boolean;
        meta?: Record<string, unknown>;
      },
    ): Promise<boolean> {
      const delivery = startOperationTraceStage(currentOperationTrace(), 'delivery', { deliveryKind: 'image' });
      const channel = channels.find(
        (c) =>
          c.ownsJid(jid) &&
          c.isConnected() &&
          typeof c.sendPhoto === 'function',
      );
      if (!channel || !channel.sendPhoto) {
        delivery.finish('failed', { reason: 'unavailable' });
        logger.warn(
          { jid, ...fileLogFields(filePath) },
          'No channel supports sendPhoto for this JID',
        );
        return false;
      }
      try {
        await channel.sendPhoto(jid, filePath, caption);
        delivery.finish('succeeded', { reason: 'api_acknowledged' });
        logger.info(
          { jid, ...fileLogFields(filePath), caption: caption?.slice(0, 50) },
          'Photo sent',
        );
        runPostHooks({
          chatJid: jid,
          text: caption || '',
          triggerType: 'ipc',
          meta: {
            kind: 'photo',
            filePath,
            ...(options?.meta || {}),
            ...(options?.suppressCursorAdvance
              ? { suppressCursorAdvance: true }
              : {}),
          },
        });
        return true;
      } catch (err) {
        delivery.finish('unknown', { reason: 'outcome_unknown' });
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
      options?: {
        suppressCursorAdvance?: boolean;
        meta?: Record<string, unknown>;
      },
    ): Promise<boolean> {
      const delivery = startOperationTraceStage(currentOperationTrace(), 'delivery', { deliveryKind: 'document' });
      const channel = channels.find(
        (c) =>
          c.ownsJid(jid) &&
          c.isConnected() &&
          typeof c.sendDocument === 'function',
      );
      if (!channel || !channel.sendDocument) {
        delivery.finish('failed', { reason: 'unavailable' });
        logger.warn(
          { jid, ...fileLogFields(filePath) },
          'No channel supports sendDocument for this JID',
        );
        return false;
      }
      let checkedArtifact: ArtifactDeliveryDecision | undefined;
      try {
        if (hostOptions.artifactAcceptance) {
          const acceptance = startOperationTraceStage(currentOperationTrace(), 'artifact_acceptance');
          try {
            checkedArtifact = await hostOptions.artifactAcceptance(filePath);
            if (checkedArtifact.required && (checkedArtifact.status !== 'passed' || !checkedArtifact.snapshotPath)) {
              acceptance.finish('failed', { reason: checkedArtifact.status === 'failed' ? 'checks_failed' : 'inconclusive' });
              delivery.finish('skipped', { reason: 'checks_failed' });
              return false;
            }
            acceptance.finish(checkedArtifact.required ? 'succeeded' : 'skipped', {
              reason: checkedArtifact.required ? 'checks_passed' : 'not_applicable',
            });
          } catch {
            acceptance.finish('unknown', { reason: 'inconclusive' });
            delivery.finish('skipped', { reason: 'inconclusive' });
            return false;
          }
        }
        await channel.sendDocument(jid, checkedArtifact?.required ? checkedArtifact.snapshotPath! : filePath, caption);
        delivery.finish('succeeded', { reason: 'api_acknowledged' });
        logger.info(
          { jid, ...fileLogFields(filePath), caption: caption?.slice(0, 50) },
          'Document sent',
        );
        runPostHooks({
          chatJid: jid,
          text: caption || '',
          triggerType: 'ipc',
          meta: {
            kind: 'document',
            filePath,
            ...(options?.meta || {}),
            ...(options?.suppressCursorAdvance
              ? { suppressCursorAdvance: true }
              : {}),
          },
        });
        return true;
      } catch (err) {
        delivery.finish('unknown', { reason: 'outcome_unknown' });
        logger.error(
          { jid, ...fileLogFields(filePath), err },
          'Failed to send document',
        );
        return false;
      } finally {
        try { checkedArtifact?.cleanup?.(); } catch { /* Transport outcome is already known. */ }
      }
    },

    async sendVoice(jid: string, text: string): Promise<boolean> {
      const delivery = startOperationTraceStage(currentOperationTrace(), 'delivery', { deliveryKind: 'final' });
      const channel = channels.find(
        (c) =>
          c.ownsJid(jid) &&
          c.isConnected() &&
          typeof c.sendVoice === 'function',
      );
      if (!channel || !channel.sendVoice) {
        delivery.finish('failed', { reason: 'unavailable' });
        logger.warn({ jid }, 'No channel supports sendVoice for this JID');
        return false;
      }
      try {
        await channel.sendVoice(jid, text);
        delivery.finish('succeeded', { reason: 'api_acknowledged' });
        logger.info({ jid, length: text.length }, 'Voice sent');
        runPostHooks({
          chatJid: jid,
          text,
          triggerType: 'ipc',
          meta: { kind: 'voice' },
        });
        return true;
      } catch (err) {
        delivery.finish('unknown', { reason: 'outcome_unknown' });
        logger.error({ jid, err }, 'Failed to send voice');
        return false;
      }
    },
  };
}
