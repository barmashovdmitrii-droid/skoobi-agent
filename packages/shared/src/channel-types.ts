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
  /** Adapter-observed eligibility of a private human text, independent of edit order. */
  telegram_editable?: boolean;
  /** A direct author changed their own plain text into local quote formatting. */
  telegram_edit_local_quote?: true;
  /** Telegram account receiving the update, independent of its configured bot name. */
  telegram_receiver_id?: string;
  telegram_edit_group_folder?: string;
  /** Host-persisted edition of the original input. Set only when reading storage. */
  telegram_edit_revision?: number;
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

// --- Inline buttons under host messages ---

/**
 * One button under a host message. Channels without buttons (WhatsApp) just
 * send the text; the text must make sense without the button.
 */
export interface OutboundButton {
  text: string;
  /** Opaque to the channel; Telegram limits it to 64 bytes. */
  callbackData: string;
}

export interface SendMessageOptions {
  /** Host-only authority recheck before each part or retry of a saved reply. */
  canSend?: () => boolean;
  /** Rows of buttons under the LAST part of the message. */
  buttons?: OutboundButton[][];
}

// --- Stopping scheduled tasks from a button (W25) ---

export type TaskControlAction =
  | { kind: 'stop'; taskId: string }
  | { kind: 'stop_all_background' };

export interface TaskControlRequest {
  chatJid: string;
  /** Channel user id of whoever pressed the button (already owner-checked). */
  senderId: string;
  action: TaskControlAction;
}

export interface TaskControlResult {
  /** Short pop-up answer to the button press. */
  toast: string;
  /** New text of the message that carried the button; absent — keep it. */
  text?: string;
  buttons?: OutboundButton[][];
}

export type OnTaskControl = (
  request: TaskControlRequest,
) => Promise<TaskControlResult>;

const TASK_CONTROL_PREFIX = 'tgtask:';
const TASK_CONTROL_STOP_ALL = `${TASK_CONTROL_PREFIX}all`;
const TASK_CONTROL_STOP = `${TASK_CONTROL_PREFIX}s:`;
const TASK_CONTROL_TASK_ID = /^[A-Za-z0-9_.:-]{1,48}$/;

/** Telegram callback_data for a task button, or null when it would not fit. */
export function taskControlCallbackData(
  action: TaskControlAction,
): string | null {
  if (action.kind === 'stop_all_background') return TASK_CONTROL_STOP_ALL;
  if (!TASK_CONTROL_TASK_ID.test(action.taskId)) return null;
  return `${TASK_CONTROL_STOP}${action.taskId}`;
}

export function parseTaskControlCallbackData(
  data: string,
): TaskControlAction | null {
  if (data === TASK_CONTROL_STOP_ALL) return { kind: 'stop_all_background' };
  if (!data.startsWith(TASK_CONTROL_STOP)) return null;
  const taskId = data.slice(TASK_CONTROL_STOP.length);
  return TASK_CONTROL_TASK_ID.test(taskId) ? { kind: 'stop', taskId } : null;
}

export const TASK_CONTROL_CALLBACK_RE = /^tgtask:(?:all|s:[A-Za-z0-9_.:-]{1,48})$/;

// --- Channel abstraction ---

export interface GeneratedVoiceAudio {
  parts: Array<{ogg:string;mp3:string;wav:string}>;
  configuredProvider:string;
  configuredVoice:string;
  cleanup:()=>void;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  /** `options.buttons` is optional: a channel without buttons ignores it. */
  sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void>;
  /** Optional quiet progress surface, updated in place within one host-owned turn. */
  sendProgress?(jid: string, text: string, turnKey: string, options?: Pick<SendMessageOptions, 'canSend'>): Promise<boolean>;
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
  // Generation is separate from delivery; the host persists before cleanup.
  generateVoiceAudio?(jid:string,text:string):Promise<GeneratedVoiceAudio>;
  sendVoiceFile?(jid:string,filePath:string):Promise<void>;
  // Optional: synthesize text → voice and send. Channels that don't support audio can omit.
  sendVoice?(jid: string, text: string, options?: Pick<SendMessageOptions, 'canSend'>): Promise<void>;
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
export type OnTelegramMessageEdit = (
  chatJid: string,
  message: NewMessage,
  editedAt: number,
) => void;

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
