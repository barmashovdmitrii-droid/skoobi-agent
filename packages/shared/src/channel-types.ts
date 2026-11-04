// Message-plane контракты канал↔ядро (Channel, NewMessage, SenderIdentity,
// колбэки доставки) — вынесены из orchestrator/types.ts в @skoobi/shared
// (волна 7a): это публичный API каналов-кирпичей (telegram сегодня, whatsapp
// следом); ядро ре-экспортирует их из types.ts, как раньше.

export interface SenderIdentity {
  channel: 'telegram';
  chat_id: string;
  telegram_user_id: string;
  identity_id: string;
  bot_id?: string;
  persona_id?: string;
  username_hint?: string;
  display_name_hint?: string;
  is_owner_sender: boolean;
  /** Host-derived authority provenance; absent legacy records fail closed. */
  telegram_message_origin?: 'direct' | 'forwarded' | 'quoted';
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  /** Host DB ingestion order. Never accepted from a channel as authority. */
  ingestion_cursor?: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  tenant_id?: string;
  sender_identity?: SenderIdentity;
  telegram_update_id?: string;
}

export interface TelegramCallbackQueryEvent {
  id: string;
  chat_jid: string;
  chat_id: string;
  from_id: string;
  timestamp: string;
  kind: string;
  data?: string;
  message_id?: string;
  username_hint?: string;
  display_name_hint?: string;
}

export type OnTelegramCallbackQuery = (
  event: TelegramCallbackQueryEvent,
) => void;

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  /** Optional quiet progress surface, updated in place within one host-owned turn. */
  sendProgress?(jid: string, text: string, turnKey: string): Promise<boolean>;
  /** Close this exact turn's progress and drain its transport before a final reply. */
  finishProgress?(jid: string, turnKey: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: send a photo/image by absolute file path. Channels that don't support media can omit.
  sendPhoto?(jid: string, filePath: string, caption?: string): Promise<void>;
  // Optional: send an arbitrary document/file by absolute file path.
  sendDocument?(jid: string, filePath: string, caption?: string): Promise<void>;
  // Optional: synthesize text → voice and send. Channels that don't support audio can omit.
  sendVoice?(jid: string, text: string): Promise<void>;
  // Optional: best-effort emoji reaction on an inbound message (e.g. 👀 while
  // the agent is busy). Resolves false instead of throwing; no retries.
  // WhatsApp deliberately omits it: its own reaction in the self-chat would
  // come back as a new inbound message.
  reactToMessage?(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<boolean>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
