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
