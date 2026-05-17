/**
 * Telegram voice message transcription.
 *
 * Thin wrapper: download the OGG/Opus voice file from Telegram, then hand off
 * to the channel-agnostic `transcribeAudioFile` for ffmpeg + whisper-cli.
 */

import { createWriteStream, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import https from 'https';

import { logger } from './orchestrator/logger.js';
import { transcribeAudioFile } from './transcription.js';

const TELEGRAM_VOICE_RETRIES = 3;
const TELEGRAM_VOICE_RETRY_BASE_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  operation: () => Promise<T>,
  meta: { fileId: string; stage: string },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TELEGRAM_VOICE_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt === TELEGRAM_VOICE_RETRIES) break;
      logger.warn(
        { ...meta, attempt, err },
        'Telegram voice transcription download attempt failed, retrying',
      );
      await sleep(TELEGRAM_VOICE_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError;
}

function downloadUrl(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          file.close();
          void fs.unlink(dest).catch(() => {});
          reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

function getTelegramFileInfo(url: string): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

export async function transcribeTelegramVoice(
  botToken: string,
  fileId: string,
  langOverride?: string,
): Promise<string | null> {
  const tmpOgg = join(tmpdir(), `tg-voice-${Date.now()}-${fileId}.ogg`);

  try {
    // Step 1: get file path from Telegram API
    const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
    const fileInfo = await withRetry(() => getTelegramFileInfo(infoUrl), {
      fileId,
      stage: 'getFile',
    });

    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      logger.warn({ fileId, fileInfo }, 'Failed to get Telegram file info');
      return null;
    }

    // Step 2: download OGG voice file
    const downloadUrl_ = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
    await withRetry(() => downloadUrl(downloadUrl_, tmpOgg), {
      fileId,
      stage: 'download',
    });

    // Step 3: delegate to channel-agnostic transcription
    return await transcribeAudioFile(tmpOgg, langOverride);
  } catch (err) {
    logger.error({ err, fileId }, 'Telegram voice transcription failed');
    return null;
  } finally {
    await fs.unlink(tmpOgg).catch(() => {});
  }
}
