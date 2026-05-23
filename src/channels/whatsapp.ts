/**
 * WhatsApp channel — Baileys-based adapter.
 *
 * Connects via the WhatsApp Web reverse-engineered protocol (Baileys). At first
 * run prints a QR code to stdout that must be scanned on the shop's WhatsApp
 * (Settings → Linked Devices → Link a device). The pairing state then persists
 * under WHATSAPP_AUTH_DIR (default <instance>/whatsapp-auth).
 *
 * Skoobi JID format: `wa:<digits>` where digits are the WhatsApp number in
 * E.164 form without `+`. The class internally maps to Baileys'
 * `<digits>@s.whatsapp.net` JIDs.
 *
 * ⚠️ Baileys uses the WhatsApp Web protocol, which technically violates the
 * WhatsApp Terms of Service. The connected number may be banned. Prefer using
 * a dedicated WhatsApp Business number, do not blast outbound to cold leads,
 * and plan to migrate to Meta Cloud API once a WABA is provisioned.
 */
import fs from 'fs';
import path from 'path';

import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
  type WAMessage,
} from 'baileys';
import qrTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';

import { DATA_DIR } from '../orchestrator/config.js';
import { readEnvFile } from '../orchestrator/env.js';
import { logger } from '../orchestrator/logger.js';
import {
  registerChannel,
  ChannelOpts,
} from '../orchestrator/channel-registry.js';
import {
  createWhatsAppSenderIdentity,
  loadOwnerAllowlistFromEnv,
} from '../orchestrator/tenant-registry.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../orchestrator/types.js';

type WASocket = ReturnType<typeof makeWASocket>;
type BoomLike = { output?: { statusCode?: number } };

const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const TYPING_REFRESH_INTERVAL_MS = 8_000;
const TYPING_MAX_DURATION_MS = 5 * 60 * 1000;

export interface WhatsAppChannelOpts {
  authDir: string;
  defaultFolder: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  ownerAllowlist?: ChannelOpts['ownerAllowlist'];
}

export function normalizeWhatsappPhone(raw: string): string {
  if (!raw) return '';
  let digits = String(raw).replace(/[^0-9]/g, '');
  // Common CIS legacy: 8XXXXXXXXXX → 7XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith('8')) {
    digits = '7' + digits.slice(1);
  }
  return digits;
}

export function skoobiJidFromBaileysJid(jid: string): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  const head = jid.split('@')[0] ?? '';
  const digits = head.split(':')[0]?.replace(/[^0-9]/g, '') ?? '';
  if (!digits) return null;
  return `wa:${digits}`;
}

export function baileysJidFromSkoobiJid(jid: string): string | null {
  if (!jid.startsWith('wa:')) return null;
  const digits = jid.slice(3).replace(/[^0-9]/g, '');
  return digits ? `${digits}@s.whatsapp.net` : null;
}

function unwrapMessage(m: any): any {
  if (!m) return m;
  if (m.ephemeralMessage?.message) {
    return unwrapMessage(m.ephemeralMessage.message);
  }
  if (m.viewOnceMessage?.message) {
    return unwrapMessage(m.viewOnceMessage.message);
  }
  if (m.viewOnceMessageV2?.message) {
    return unwrapMessage(m.viewOnceMessageV2.message);
  }
  if (m.viewOnceMessageV2Extension?.message) {
    return unwrapMessage(m.viewOnceMessageV2Extension.message);
  }
  if (m.documentWithCaptionMessage?.message) {
    return unwrapMessage(m.documentWithCaptionMessage.message);
  }
  if (m.editedMessage?.message) {
    return unwrapMessage(m.editedMessage.message);
  }
  if (m.protocolMessage?.editedMessage) {
    return unwrapMessage(m.protocolMessage.editedMessage);
  }
  return m;
}

export function extractMessageText(msg: WAMessage): string {
  const m = unwrapMessage(msg.message);
  if (!m) return '';
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    ''
  );
}

export function detectMediaKind(msg: WAMessage): string | null {
  const m = unwrapMessage(msg.message);
  if (!m) return null;
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return 'audio';
  if (m.documentMessage) return 'document';
  if (m.stickerMessage) return 'sticker';
  if (m.locationMessage) return 'location';
  if (m.contactMessage) return 'contact';
  return null;
}

export class WhatsAppChannel implements Channel {
  public readonly name = 'whatsapp';

  private socket: WASocket | null = null;
  private connected = false;
  private intentionallyClosed = false;
  private reconnectDelay = RECONNECT_DELAY_MS;
  private connectPromise: Promise<void> | null = null;
  private readonly typingTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly opts: WhatsAppChannelOpts) {}

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.startSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async startSocket(): Promise<void> {
    await fs.promises.mkdir(this.opts.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);

    const versionInfo = await fetchLatestBaileysVersion().catch(() => ({
      version: undefined,
      isLatest: false,
    }));
    logger.info(
      {
        channel: 'whatsapp',
        version: versionInfo.version,
        isLatest: versionInfo.isLatest,
      },
      'WhatsApp: starting socket',
    );

    // Baileys' internal logger is noisy. Use a self-referential no-op shim so
    // `logger.child()` returns the same shim (otherwise Baileys calls
    // `logger.child({...}).debug(...)` and explodes with "Cannot read x of undefined").
    const noopLogger: any = {
      level: 'warn',
      fatal: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    };
    noopLogger.child = () => noopLogger;

    const sock = makeWASocket({
      auth: state,
      logger: noopLogger,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });
    this.socket = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) await this.showQr(qr);
      if (connection === 'close') {
        this.connected = false;
        const statusCode = (lastDisconnect?.error as BoomLike | undefined)
          ?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        logger.warn(
          {
            channel: 'whatsapp',
            statusCode,
            loggedOut,
            err: lastDisconnect?.error?.message,
          },
          'WhatsApp: connection closed',
        );
        if (loggedOut) {
          logger.error(
            { authDir: this.opts.authDir },
            'WhatsApp: logged out — delete auth dir and re-scan QR',
          );
          return;
        }
        if (!this.intentionallyClosed) this.scheduleReconnect();
      } else if (connection === 'open') {
        this.connected = true;
        this.reconnectDelay = RECONNECT_DELAY_MS;
        logger.info(
          {
            channel: 'whatsapp',
            user: sock.user?.id,
            name: sock.user?.name,
          },
          'WhatsApp: connection open',
        );
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          this.handleInbound(msg);
        } catch (err) {
          logger.error({ err }, 'WhatsApp: inbound handler error');
        }
      }
    });
  }

  private scheduleReconnect() {
    const delay = Math.min(this.reconnectDelay, MAX_RECONNECT_DELAY_MS);
    this.reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
    logger.info(
      { channel: 'whatsapp', delayMs: delay },
      'WhatsApp: scheduling reconnect',
    );
    setTimeout(() => {
      if (this.intentionallyClosed) return;
      this.startSocket().catch((err) =>
        logger.error({ err }, 'WhatsApp: reconnect failed'),
      );
    }, delay);
  }

  private async showQr(qr: string): Promise<void> {
    const pngPath = path.join(this.opts.authDir, '..', 'whatsapp-qr.png');
    QRCode.toFile(pngPath, qr, { width: 480, margin: 2 }).then(
      () =>
        logger.warn(
          { pngPath },
          'WhatsApp: QR saved — open the PNG and scan with the shop phone (Settings → Linked Devices → Link a device)',
        ),
      (err) => logger.error({ err }, 'WhatsApp: failed to save QR PNG'),
    );
    logger.warn(
      '╔══════════════════════════════════════════════════════════════╗',
    );
    logger.warn(
      '║ WhatsApp: scan QR with shop phone                            ║',
    );
    logger.warn(
      '║ WhatsApp app → Settings → Linked Devices → Link a device     ║',
    );
    logger.warn(
      '╚══════════════════════════════════════════════════════════════╝',
    );
    qrTerminal.generate(qr, { small: true });
  }

  private handleInbound(msg: WAMessage): void {
    if (msg.key.fromMe) return;
    if (!msg.message) return;
    const chatJid = this.extractChatJid(msg);
    if (!chatJid) {
      // Skip groups (@g.us), broadcasts, status updates, etc.
      return;
    }
    const phone = chatJid.slice(3);
    const text = extractMessageText(msg).trim();
    const mediaKind = detectMediaKind(msg);
    const pushName = (msg.pushName ?? '').trim();
    const timestamp = new Date(
      typeof msg.messageTimestamp === 'number'
        ? msg.messageTimestamp * 1000
        : Date.now(),
    ).toISOString();

    this.ensureGroupRegistered(chatJid, pushName);
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      pushName || phone,
      'whatsapp',
      false,
    );

    const ownerAllowlist =
      this.opts.ownerAllowlist?.() ?? loadOwnerAllowlistFromEnv();
    const senderIdentity = createWhatsAppSenderIdentity({
      phone,
      displayNameHint: pushName || undefined,
      ownerAllowlist,
    });

    const inboundMessage: NewMessage = {
      id: msg.key.id ?? `wa-${Date.now()}`,
      chat_jid: chatJid,
      sender: phone,
      sender_name: pushName || phone,
      content: text || (mediaKind ? `[${mediaKind}]` : ''),
      timestamp,
      is_from_me: false,
      sender_identity: senderIdentity,
    };
    this.opts.onMessage(chatJid, inboundMessage);
  }

  /**
   * Prefer phone-number JIDs over Linked Identity (LID) JIDs. Baileys can put
   * the PN JID in remoteJidAlt for modern 1:1 chats whose primary remoteJid is
   * `@lid`.
   */
  private extractChatJid(msg: WAMessage): string | null {
    const primary = msg.key.remoteJid ?? '';
    const alt = (msg.key as any).remoteJidAlt as string | undefined;
    if (alt && alt.endsWith('@s.whatsapp.net')) {
      return skoobiJidFromBaileysJid(alt);
    }
    return skoobiJidFromBaileysJid(primary);
  }

  /**
   * Auto-register this chat against a per-customer folder so the orchestrator
   * has an isolated tenant namespace. Users can later override the routing via
   * `groups/<folder>/tenant.json`.
   */
  private ensureGroupRegistered(chatJid: string, displayName: string): void {
    if (!this.opts.registerGroup) return;
    const existing = this.opts.registeredGroups()[chatJid];
    if (existing) return;
    const phone = chatJid.slice(3);
    const folder = `${this.opts.defaultFolder}__wa_${phone}`;
    const group: RegisteredGroup = {
      name: displayName || chatJid,
      folder,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };
    this.opts.registerGroup(chatJid, group);
    logger.info(
      { chatJid, folder },
      'WhatsApp: auto-registered chat → per-customer folder',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const target = baileysJidFromSkoobiJid(jid);
    if (!target) throw new Error(`WhatsApp: invalid JID ${jid}`);
    if (!this.socket || !this.connected) {
      throw new Error('WhatsApp: socket not connected');
    }
    logger.info(
      { jid, target, length: text.length },
      'WhatsApp: sendMessage attempt',
    );
    await this.socket.sendMessage(target, { text });
    logger.info({ jid, target, length: text.length }, 'WhatsApp: message sent');
  }

  isConnected(): boolean {
    return this.connected && this.socket !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('wa:');
  }

  async disconnect(): Promise<void> {
    this.intentionallyClosed = true;
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
    if (this.socket) {
      try {
        // Baileys exposes `end()` for graceful socket shutdown.
        await Promise.resolve(this.socket.end?.(undefined));
      } catch (err) {
        logger.warn({ err }, 'WhatsApp: disconnect error');
      }
      this.socket = null;
      this.connected = false;
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.socket || !this.connected) return;
    const target = baileysJidFromSkoobiJid(jid);
    if (!target) return;
    const existing = this.typingTimers.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingTimers.delete(jid);
    }
    if (!isTyping) {
      await this.socket.sendPresenceUpdate('paused', target).catch(() => {});
      return;
    }
    await this.socket.sendPresenceUpdate('composing', target).catch(() => {});
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!this.socket) {
        clearInterval(timer);
        this.typingTimers.delete(jid);
        return;
      }
      if (Date.now() - startedAt >= TYPING_MAX_DURATION_MS) {
        clearInterval(timer);
        this.typingTimers.delete(jid);
        return;
      }
      this.socket.sendPresenceUpdate('composing', target).catch(() => {});
    }, TYPING_REFRESH_INTERVAL_MS);
    this.typingTimers.set(jid, timer);
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'WHATSAPP_CHANNEL_ENABLED',
    'WHATSAPP_AUTH_DIR',
    'WHATSAPP_DEFAULT_FOLDER',
  ]);
  const enabled =
    (process.env.WHATSAPP_CHANNEL_ENABLED ||
      envVars.WHATSAPP_CHANNEL_ENABLED ||
      '') === 'true';
  if (!enabled) {
    // Channel module imported but not activated for this instance.
    return null;
  }
  const authDir =
    process.env.WHATSAPP_AUTH_DIR ||
    envVars.WHATSAPP_AUTH_DIR ||
    path.join(DATA_DIR, 'whatsapp-auth');
  const defaultFolder =
    process.env.WHATSAPP_DEFAULT_FOLDER ||
    envVars.WHATSAPP_DEFAULT_FOLDER ||
    'main';
  return new WhatsAppChannel({
    authDir,
    defaultFolder,
    onMessage: opts.onMessage,
    onChatMetadata: opts.onChatMetadata,
    registeredGroups: opts.registeredGroups,
    registerGroup: opts.registerGroup,
    ownerAllowlist: opts.ownerAllowlist,
  });
});
