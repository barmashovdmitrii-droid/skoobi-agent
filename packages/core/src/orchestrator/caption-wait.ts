/**
 * W31 (разбор недели): человек часто присылает фото, а через несколько
 * секунд — подпись или вопрос к нему («Что выбрать» через 9 с после фото).
 * Ход стартовал сразу на фото, и он получал два ответа на одну мысль. Теперь,
 * если последним в пачке пришло фото, видео или документ без текста, запуск
 * откладывается до 12 с от его отправки; новое сообщение за это время
 * запускает ход сразу, вместе с ним.
 *
 * Голосовое НЕ ждёт: это уже сама просьба (в базе — полный текст «[Voice: …]»).
 * По замерам следующее сообщение приходит за 12 с примерно после одного
 * голосового из шестнадцати (почти всегда ещё одно голосовое); остальные просто ждали бы.
 *
 * Пересланное НЕ ждёт: пачка с пересланным целиком идёт в режим «только
 * чтение» без интернета (isIndirectOwnerContentBatch). Вопрос «Это правда?»,
 * пришедший через 7 с после пересланной новости, в склейке с ней дал бы один
 * непроверенный ответ вместо проверенного. Менять это правило защиты —
 * решение владельца.
 */
import type { NewMessage } from './types.js';

export const CAPTION_WAIT_MS = 12_000;

const MEDIA_PLACEHOLDER_RE = /^\[(?:Photo|Video|Document|Animation)\b[^\]]*\]/iu;
// A voice note, audio or video note is the request itself: no wait.
const VOICE_RE = /^\[(?:Voice|Audio|Video note)\b/iu;

type CaptionKind = 'media' | 'media-with-text' | 'text';

function captionKind(message: NewMessage): CaptionKind {
  // Forwarded content never waits (see above): it would pull the person's
  // own question into a read-only turn.
  if (message.sender_identity?.telegram_message_origin === 'forwarded') {
    return 'text';
  }
  const content = String(message.content || '').trim();
  if (VOICE_RE.test(content)) return 'text';
  const media = content.match(MEDIA_PLACEHOLDER_RE);
  if (media) {
    return content.slice(media[0].length).trim() ? 'media-with-text' : 'media';
  }
  return 'text';
}

/**
 * How long the run should still wait for a caption; 0 — start now. Only when
 * the last message is the person's own photo/video/document without text,
 * and none of the media right before it already carries text (an album's
 * caption sits on its first photo).
 */
export function captionWaitRemainingMs(
  messages: readonly NewMessage[],
  now: number,
  waitMs = CAPTION_WAIT_MS,
): number {
  const incoming = messages.filter(
    (message) =>
      message.is_bot_message !== true && String(message.content || '').trim(),
  );
  const last = incoming.at(-1);
  if (!last) return 0;
  const kind = captionKind(last);
  if (kind === 'text' || kind === 'media-with-text') return 0;
  if (kind === 'media') {
    for (let index = incoming.length - 2; index >= 0; index -= 1) {
      const before = captionKind(incoming[index]);
      if (before === 'media-with-text') return 0;
      if (before !== 'media') break;
    }
  }
  const sentAt = Date.parse(last.timestamp);
  if (!Number.isFinite(sentAt)) return 0;
  const remaining = sentAt + waitMs - now;
  return remaining > 0 ? Math.min(remaining, waitMs) : 0;
}

/** One pending re-check per chat; a newer wait replaces the older one. */
export class CaptionWaitTimers {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly recheck: (chatJid: string) => void) {}

  schedule(chatJid: string, delayMs: number): void {
    const existing = this.timers.get(chatJid);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(chatJid);
      this.recheck(chatJid);
    }, Math.max(0, delayMs) + 250);
    timer.unref?.();
    this.timers.set(chatJid, timer);
  }

  pending(chatJid: string): boolean {
    return this.timers.has(chatJid);
  }
}
