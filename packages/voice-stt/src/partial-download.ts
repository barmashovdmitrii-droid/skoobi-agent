/**
 * Уборка недокачанного файла перед повторной попыткой загрузки.
 *
 * Живёт здесь со времён Telegram-обёртки распознавания голоса
 * (transcribeTelegramVoice, удалена в r1111 как мёртвая); сейчас ею
 * пользуется загрузка видео в channel-telegram.
 */
import { promises as fs } from 'fs';

/**
 * A retry must not start until cleanup of the previous destination has
 * finished. Otherwise a delayed fire-and-forget unlink can delete the file
 * successfully written by the next attempt.
 */
export async function unlinkPartialBeforeRetry(
  dest: string,
  unlink: (file: string) => Promise<unknown> = fs.unlink,
): Promise<void> {
  await unlink(dest).catch(() => undefined);
}
