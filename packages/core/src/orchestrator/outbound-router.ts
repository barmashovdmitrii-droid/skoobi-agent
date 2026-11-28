/**
 * MessageRouter — single outbound delivery service.
 * All output (agent responses, IPC messages, task results, extension output)
 * routes through here. Supports pre/post hooks for extensions.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { startOperationTraceStage } from '@skoobi/shared/operation-trace';
import { noteBotTextForSecretRequests } from '@skoobi/shared/chat-secrets';
import { currentTelegramEditGuard } from './telegram-edit-turn.js';
import { currentOperationTrace } from './runtime-operation-trace.js';
import type { ArtifactDeliveryDecision } from './artifact-acceptance-policy.js';
import {deliverFileOnce,recordFileDeliveryRejection} from './file-delivery.js';
import {generateVoiceAudioAsset,resolveVoiceAudioFile} from './voice-audio-assets.js';
import {getDb} from './db.js';
import {DATA_DIR} from './config.js';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';

import {
  Channel,
  MessageRouter,
  OutboundEnvelope,
  OutboundPreHook,
} from './types.js';
import { formatOutbound } from './router.js';
import { logger } from './logger.js';

/** Envelopes a channel may show as one quiet, edited status under their progressKey.
 * peer_progress: routine MacBook job stages, one status per job revision (W24). */
const EDITABLE_PROGRESS_KINDS: ReadonlySet<string> = new Set([
  'agent_progress',
  'host_progress',
  'peer_progress',
]);

function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

function fileLogFields(filePath: string): { fileBasename: string } {
  return { fileBasename: path.basename(filePath) };
}

function jidLogRef(jid: string): string {
  return createHash('sha256').update(jid, 'utf8').digest('hex').slice(0, 12);
}

/**
 * What a failed document send may leave in the log: the error's class and
 * code, never the error itself. A Telegram refusal (GrammyError) carries the
 * call's payload — chat_id and caption — and the log sanitizer passes plain
 * fields through, so the whole object would undo the hashed jid above.
 */
function errorLogFields(err: unknown): { errName?: string; errCode?: string | number } {
  if (!err || typeof err !== 'object') return {};
  const record = err as { name?: unknown; code?: unknown; error_code?: unknown };
  const name = typeof record.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(record.name) ? record.name : undefined;
  const raw = record.error_code ?? record.code;
  const code = typeof raw === 'number' && Number.isSafeInteger(raw) ? raw
    : typeof raw === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : undefined;
  return { ...(name ? { errName: name } : {}), ...(code !== undefined ? { errCode: code } : {}) };
}

export function createMessageRouter(channels: Channel[], hostOptions: {
  /** Only a host-approved contract may require a signed artifact check. */
  artifactAcceptance?: (artifactPath: string) => Promise<ArtifactDeliveryDecision>;
} = {}): MessageRouter {
  const preHooks: OutboundPreHook[] = [];
  const postHooks: ((envelope: OutboundEnvelope) => void)[] = [];

  const runPostHooks = (envelope: OutboundEnvelope): void => {
    const guard = envelope.triggerType === 'ipc' ? currentTelegramEditGuard() : undefined;
    if (guard) {
      // The channel may have accepted a send before the edit but acknowledged
      // it after the next batch started. Preserve the transport receipt only.
      let current = false;
      try { current = guard(); } catch { /* Do not advance on uncertainty. */ }
      if (!current) envelope = {...envelope, meta: {...envelope.meta, suppressCursorAdvance: true}};
    }
    for (const hook of postHooks) {
      try {
        hook(envelope);
      } catch (err) {
        logger.error({ err }, 'Outbound post-hook error');
      }
    }
  };

  const attemptDocument: NonNullable<MessageRouter['sendDocumentResult']> = async (jid,filePath,caption,options) => {
    const delivery=startOperationTraceStage(currentOperationTrace(),'delivery',{deliveryKind:'document'});
    const channel=channels.find(c=>c.ownsJid(jid)&&c.isConnected()&&(options?.asVoice?typeof c.sendVoiceFile==='function':typeof c.sendDocument==='function'));
    if(!channel){delivery.finish('failed',{reason:'unavailable'});return {state:'blocked',code:'channel_unavailable'};}
    let checked:ArtifactDeliveryDecision|undefined; let scratch:string|undefined; let started=false;
    try {
      if(hostOptions.artifactAcceptance){
        const acceptance=startOperationTraceStage(currentOperationTrace(),'artifact_acceptance');
        try { checked=await hostOptions.artifactAcceptance(filePath); }
        catch { acceptance.finish('unknown',{reason:'inconclusive'});delivery.finish('skipped',{reason:'inconclusive'});return {state:'blocked',code:'acceptance_unavailable'}; }
        if(checked.required&&(checked.status!=='passed'||!checked.snapshotPath)){
          acceptance.finish('failed',{reason:checked.status==='failed'?'checks_failed':'inconclusive'});
          delivery.finish('skipped',{reason:'checks_failed'});
          return {state:'blocked',code:/^[a-z0-9_]{1,80}$/.test(checked.code)?checked.code:'acceptance_inconclusive'};
        }
        acceptance.finish(checked.required?'succeeded':'skipped',{reason:checked.required?'checks_passed':'not_applicable'});
      }
      // The transport opens a frozen private copy, including ordinary files.
      // Recheck the promised hash AFTER asynchronous acceptance.
      const {buffer}=readBoundedRegularFileNoFollowSync(checked?.required?checked.snapshotPath!:filePath,
        {maxBytes:50*1024*1024,oversize:'reject',requireSingleLink:true});
      const sha256=createHash('sha256').update(buffer).digest('hex');
      if(options?.expectedSha256&&sha256!==options.expectedSha256){delivery.finish('skipped',{reason:'checks_failed'});return {state:'blocked',code:'artifact_changed',sha256};}
      scratch=fs.mkdtempSync(path.join(os.tmpdir(),'skoobi-document-'));fs.chmodSync(scratch,0o700);
      const snapshot=path.join(scratch,path.basename(filePath));fs.writeFileSync(snapshot,buffer,{flag:'wx',mode:0o600});
      const canSend = options?.canSend ?? options?.linkedDocument?.canSend;
      if (currentTelegramEditGuard()?.() === false || (canSend && !canSend())) {
        delivery.finish('skipped', {reason:'dropped'});
        return {state:'blocked', code:'final_superseded'};
      }
      options?.beforeTransport?.(); started=true;
      let deadline:ReturnType<typeof setTimeout>|undefined;
      try {
        const transport=options?.asVoice?channel.sendVoiceFile!(jid,snapshot):channel.sendDocument!(jid,snapshot,caption);
        await Promise.race([transport,new Promise<never>((_resolve,reject)=>{
          deadline=setTimeout(()=>reject(new Error('channel_ack_timeout')),120_000);deadline.unref?.();
        })]);
      } finally {if(deadline)clearTimeout(deadline);}
      delivery.finish('succeeded',{reason:'api_acknowledged'});
      runPostHooks({chatJid:jid,text:caption||'',triggerType:'ipc',meta:{kind:options?.asVoice?'voice':'document',filePath,
        ...(options?.meta||{}),...(options?.suppressCursorAdvance?{suppressCursorAdvance:true}:{})}});
      return {state:'delivered',code:'api_acknowledged',sha256};
    } catch (err) {
      delivery.finish(started?'unknown':'failed',{reason:started?'outcome_unknown':'checks_failed'});
      logger.warn({jidHash:jidLogRef(jid),...fileLogFields(filePath),...errorLogFields(err),transportStarted:started},'Document send failed');
      return {state:started?'unknown':'blocked',code:started?'channel_outcome_unknown':'document_preflight_failed'};
    } finally {
      try{checked?.cleanup?.();}catch{/* Outcome is already recorded. */}
      try{if(scratch)fs.rmSync(scratch,{recursive:true,force:true});}catch{/* An ACK cannot be undone by temporary cleanup. */}
    }
  };
  // W08: every refusal leaves its real code in the log. Once a missing
  // archive checker blocked a 17 MB archive for 41 minutes and the log said
  // nothing at all — not even that a send had been tried.
  const sendDocumentResult: NonNullable<MessageRouter['sendDocumentResult']> = async (jid,filePath,caption,options) => {
    const linked = options?.linkedDocument;
    if (linked) {
      const db = getDb();
      const scope = {sourceGroup: linked.sourceGroup, chatJid: jid, ownerAuthorized: linked.ownerAuthorized};
      const originAttempt = currentOperationTrace()?.attemptId;
      const name = path.basename(filePath);
      let artifact: {name: string; sha256: string; bytes: number};
      try {
        const {buffer} = readBoundedRegularFileNoFollowSync(filePath, {
          maxBytes: 50 * 1024 * 1024, oversize: 'reject', requireSingleLink: true,
        });
        artifact = {name, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex')};
      } catch {
        recordFileDeliveryRejection({db, scope, originAttempt, deliveryId: linked.deliveryId, name, code: 'file_not_available'});
        return {state:'blocked', code:'file_not_available'};
      }
      let usedTransport = false;
      const receipt = await deliverFileOnce({
        db, scope, originAttempt, deliveryId: linked.deliveryId, artifact, caption,
        send: (beforeTransport) => attemptDocument(jid, filePath, caption, {
          ...options,
          expectedSha256: artifact.sha256,
          beforeTransport: () => { beforeTransport(); usedTransport = true; },
        }),
      });
      if (receipt.state === 'checking' || receipt.state === 'sending') {
        return {state:'unknown', code:'awaiting_channel_ack'};
      }
      return {
        state: receipt.state,
        code: receipt.state === 'delivered' && !usedTransport ? 'existing_api_acknowledgement' : receipt.code,
        sha256: receipt.artifact.sha256 ?? undefined,
      };
    }
    const result=await attemptDocument(jid,filePath,caption,options);
    if(result.state!=='delivered')logger.warn({jidHash:jidLogRef(jid),...fileLogFields(filePath),state:result.state,code:result.code},'Document not delivered');
    return result;
  };

  return {
    addPreHook(hook: OutboundPreHook): void {
      preHooks.push(hook);
    },

    addPostHook(hook: (envelope: OutboundEnvelope) => void): void {
      postHooks.push(hook);
    },

    async route(envelope: OutboundEnvelope, canSend?: () => boolean): Promise<string | null> {
      const editGuard = currentTelegramEditGuard();
      const expectedJid = envelope.chatJid;
      const expectedFolder = envelope.groupFolder;
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
        if (current.triggerType === 'ipc' && (!editGuard || (expectedJid === current.chatJid &&
            expectedFolder === current.groupFolder && editGuard()))) {
          runPostHooks({ ...current, text: formatted });
        }
        return null;
      }
      response.finish('succeeded');

      const delivery = startOperationTraceStage(trace, 'delivery', {
        deliveryKind: EDITABLE_PROGRESS_KINDS.has(String(current.meta?.kind)) ? 'progress' : 'final',
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

      // Revalidate the original destination and live request after asynchronous
      // hooks, immediately before handing a private saved final to the channel.
      const guarded = Boolean(canSend || editGuard);
      const allowed = () => !guarded || (expectedJid === current.chatJid &&
        expectedFolder === current.groupFolder && editGuard?.() !== false && canSend?.() !== false);
      const progressKey = current.meta?.progressKey;
      try {
      if (
        channel.sendProgress &&
        typeof progressKey === 'string' &&
        progressKey.length > 0 &&
        EDITABLE_PROGRESS_KINDS.has(String(current.meta?.kind))
      ) {
        if (!allowed()) {
          delivery.finish('skipped', { reason: 'dropped' });
          return null;
        }
        const delivered = guarded
          ? await channel.sendProgress(current.chatJid, formatted, progressKey, {canSend: allowed})
          : await channel.sendProgress(current.chatJid, formatted, progressKey);
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
        if (!allowed()) {
          delivery.finish('skipped', { reason: 'dropped' });
          return null;
        }
        if (guarded || current.buttons?.length) {
          await channel.sendMessage(current.chatJid, formatted, {
            ...(current.buttons?.length ? { buttons: current.buttons } : {}),
            ...(guarded ? { canSend: allowed } : {}),
          });
        } else {
          await channel.sendMessage(current.chatJid, formatted);
        }
      }
      } catch (error) {
        // A timeout can follow a successful remote send; absence of an ACK
        // does not prove the send failed and must never authorize a replay.
        delivery.finish('unknown', { reason: 'outcome_unknown' });
        throw error;
      }
      delivery.finish('succeeded', { reason: 'api_acknowledged' });
      // W19, ревью: бот попросил пароль или код любой отправленной репликой
      // — запомнить, чтобы ответ человека скрылся в журнале и в «⏳ Работаю
      // над…», даже если реплика не сохраняется в messages.
      try {
        noteBotTextForSecretRequests(current.chatJid, formatted);
      } catch {
        // Только маска ответа; доставка уже прошла.
      }

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
        if (currentTelegramEditGuard()?.() === false) { delivery.finish('skipped', { reason: 'dropped' }); return false; }
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

    async sendDocument(jid, filePath, caption, options): Promise<boolean> {
      return (await sendDocumentResult(jid, filePath, caption, options)).state === 'delivered';
    },
    sendDocumentResult,

    async generateVoiceAudio(jid,text) {
      const channel=channels.find(c=>c.ownsJid(jid)&&c.isConnected()&&typeof c.generateVoiceAudio==='function');
      if(!channel?.generateVoiceAudio)throw new Error('voice_generation_unavailable');
      return channel.generateVoiceAudio(jid,text);
    },
    async sendVoice(jid, text, scope, control): Promise<boolean> {
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
        if (currentTelegramEditGuard()?.() === false || (control && !control.canSend())) { delivery.finish('skipped', {reason:'dropped'}); return false; }
        let voiceAssetId:string|undefined;
        if(channel.generateVoiceAudio){
          if(!scope||scope.chatJid!==jid)throw new Error('voice_scope_required');
          const root=path.join(DATA_DIR,'media-artifacts','voice');
          const asset=await generateVoiceAudioAsset({db:getDb(),root,scope,assetId:randomUUID(),text,generate:()=>channel.generateVoiceAudio!(jid,text)});
          if(asset.state!=='ready')throw new Error('voice_audio_not_ready');
          voiceAssetId=asset.assetId;
          const parts=asset.files.filter(f=>f.format==='ogg');if(!parts.length)throw new Error('voice_parts_missing');
          for(const part of parts){
            const file=resolveVoiceAudioFile({db:getDb(),root,scope,assetId:asset.assetId,format:'ogg',part:part.part});
            const receipt=await deliverFileOnce({db:getDb(),scope,deliveryId:randomUUID(),originAttempt:currentOperationTrace()?.attemptId,
              artifact:{name:part.name,sha256:part.sha256,bytes:part.bytes},
              send:beforeTransport=>sendDocumentResult(jid,file.path,undefined,{asVoice:true,expectedSha256:part.sha256,canSend:control?.canSend,
                beforeTransport:()=>{beforeTransport();control?.transportAttempted();},suppressCursorAdvance:true,meta:{voiceAssetId:asset.assetId}})});
            // Also report a previous transport attempt when durable evidence
            // short-circuited this call. A second channel could duplicate speech.
            if (receipt.state !== 'blocked') control?.transportAttempted();
            if(receipt.state!=='delivered')throw new Error('voice_delivery_unconfirmed');
          }
        }else {
          control?.transportAttempted();
          const editGuard = currentTelegramEditGuard();
          if (editGuard || control) {
            await channel.sendVoice(jid, text, {canSend: () => editGuard?.() !== false && control?.canSend() !== false});
          } else {
            await channel.sendVoice(jid, text);
          }
        }
        delivery.finish('succeeded', { reason: 'api_acknowledged' });
        logger.info({ jid, length: text.length }, 'Voice sent');
        runPostHooks({
          chatJid: jid,
          text,
          triggerType: 'ipc',
          meta: { kind: 'voice',...(voiceAssetId?{voiceAssetId}:{}) },
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
