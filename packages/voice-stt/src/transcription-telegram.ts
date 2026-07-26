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

import { logger } from '@skoobi/shared';
import { transcribeAudioFile } from './transcription.js';

const TELEGRAM_VOICE_RETRIES = 3;
const TELEGRAM_VOICE_RETRY_BASE_MS = 500;

// A hung Telegram CDN socket (half-open, no FIN/RST) would otherwise stall the
// awaiting grammY handler forever, freezing the bot's whole sequential update
// loop for every tenant. Cap each connect/read phase so a single flaky transfer
// can never become a full-bot outage. (finding #9)
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 30_000;
const TELEGRAM_METADATA_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Derive a filesystem-safe suffix from a Telegram fileId.
 *
 * Telegram normally issues URL-safe base64url identifiers, but we never place
 * the raw, externally-sourced value into a path component: strip everything
 * outside [A-Za-z0-9_-] (so `..` / `/` cannot escape tmpdir via path.join) and
 * keep only the trailing portion, mirroring the sibling media handlers.
 */
export function safeTelegramFileTag(fileId: string): string {
  const sanitized = String(fileId)
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(-16);
  return sanitized || 'voice';
}

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

async function withRetry<T>(
  operation: () => Promise<T>,
  meta: { stage: string },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TELEGRAM_VOICE_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt === TELEGRAM_VOICE_RETRIES) break;
      logger.warn(
        safeTelegramTransportLogFields(meta.stage, attempt, err),
        'Telegram voice transcription download attempt failed, retrying',
      );
      await sleep(TELEGRAM_VOICE_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError;
}

/** Keep Telegram transport secrets, URLs and response bodies out of logs. */
export function safeTelegramTransportLogFields(
  stage: string,
  attempt: number,
  err: unknown,
): { stage: string; attempt: number; failureCode: string } {
  const record =
    err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const code = record.code;
  return {
    stage,
    attempt,
    failureCode:
      typeof code === 'string' && /^[A-Z0-9_-]{1,32}$/iu.test(code)
        ? code
        : 'transport_error',
  };
}

function downloadUrl(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    let settled = false;

    // Unlink the (already-created) partial/0-byte dest before rejecting so
    // failed downloads don't litter tmpdir, mirroring the sibling photo helper.
    // Note the outer transcribe call also unlinks tmpOgg in finally, but on the
    // retry path that runs only after the last attempt, so clean up eagerly here
    // too. (findings #31, #9)
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      file.destroy();
      void unlinkPartialBeforeRetry(dest).then(() => reject(err));
    };

    const req = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume(); // drain so the socket can be freed
        fail(
          Object.assign(new Error('Telegram media download failed'), {
            code: `HTTP_${response.statusCode || 'UNKNOWN'}`,
          }),
        );
        return;
      }
      // pipe() does NOT forward source-stream errors to the destination, so a
      // mid-download TCP reset / premature close emits 'error' on `response`
      // with no listener -> uncaughtException -> the host's global handler
      // process.exit(1)s the whole orchestrator. Listen here BEFORE pipe.
      // (finding #31)
      response.on('error', fail);
      // Inactivity timeout on the body stream: if bytes stop flowing on a
      // half-open socket the request-level timer above may not fire. (finding #9)
      response.setTimeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS, () => {
        req.destroy(new Error(`timeout downloading ${url}`));
      });
      response.pipe(file);
      file.on('finish', () => {
        if (settled) return;
        settled = true;
        file.close(() => resolve());
      });
      file.on('error', fail);
    });

    // Connect/idle-socket timeout: destroy() makes req emit 'error'. (finding #9)
    req.setTimeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error(`timeout downloading ${url}`));
    });
    req.on('error', fail);
  });
}

function getTelegramFileInfo(url: string): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };
    const req = https.get(url, (res) => {
      // Listen for body-stream errors and bound the read so a hung getFile
      // can't stall the bot's update loop. (findings #9, #31)
      res.on('error', fail);
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e as Error);
        }
      });
    });
    req.setTimeout(TELEGRAM_METADATA_TIMEOUT_MS, () => {
      req.destroy(new Error(`timeout fetching ${url}`));
    });
    req.on('error', fail);
  });
}

export async function transcribeTelegramVoice(
  botToken: string,
  fileId: string,
  langOverride?: string,
): Promise<string | null> {
  const tmpOgg = join(
    tmpdir(),
    `tg-voice-${Date.now()}-${safeTelegramFileTag(fileId)}.ogg`,
  );

  try {
    // Step 1: get file path from Telegram API
    const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
    const fileInfo = await withRetry(() => getTelegramFileInfo(infoUrl), {
      stage: 'getFile',
    });

    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      logger.warn(
        { stage: 'getFile', failureCode: 'invalid_response' },
        'Failed to get Telegram file info',
      );
      return null;
    }

    // Step 2: download OGG voice file
    const downloadUrl_ = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
    await withRetry(() => downloadUrl(downloadUrl_, tmpOgg), {
      stage: 'download',
    });

    // Step 3: delegate to channel-agnostic transcription
    return await transcribeAudioFile(tmpOgg, langOverride);
  } catch (err) {
    logger.error(
      safeTelegramTransportLogFields('telegram_voice_wrapper', 1, err),
      'Telegram voice transcription failed',
    );
    return null;
  } finally {
    await fs.unlink(tmpOgg).catch(() => {});
  }
}
