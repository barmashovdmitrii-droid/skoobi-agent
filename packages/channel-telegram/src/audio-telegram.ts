/**
 * Telegram audio/voice download → saves to group folder so agent can Read it.
 * Mirrors photo-telegram.ts. Used for both `message:voice` and `message:audio`.
 */

import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import https from 'https';

import { logger } from '@skoobi/shared/logger';
import { resolveGroupFolderPath } from '@skoobi/shared/group-folder';

// A hung Telegram CDN socket (half-open, no FIN/RST) would otherwise stall the
// awaiting grammY handler forever, freezing the bot's whole sequential update
// loop for every tenant. Cap each connect/read phase so a single flaky transfer
// can never become a full-bot outage. (finding #9)
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 30_000;
const TELEGRAM_METADATA_TIMEOUT_MS = 15_000;

// Telegram's CDN routinely drops one of two concurrent fetches of the same file
// (transcription + save) with a bare TCP reset. A single retry recovers it, so a
// transient blip needn't surface as ERROR (which wakes the watchdog).
const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
]);

function isTransientNetErr(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code != null && TRANSIENT_NET_CODES.has(code);
}

export function safeTelegramAudioFileTag(fileId: string): string {
  return (
    String(fileId)
      .replace(/[^A-Za-z0-9_-]/gu, '')
      .slice(-8) || 'audio'
  );
}

/** Return loggable transport metadata without URLs, tokens or response data. */
export function safeTelegramAudioLogFields(
  stage: string,
  attempt: number,
  err: unknown,
): { stage: string; attempt: number; failureCode: string } {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return {
    stage,
    attempt,
    failureCode:
      typeof code === 'string' && /^[A-Z0-9_-]{1,32}$/iu.test(code)
        ? code
        : 'transport_error',
  };
}

function telegramTransportError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function downloadUrl(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    let settled = false;

    // Unlink the (already-created) partial/0-byte dest before rejecting so
    // failed downloads don't litter the group's received/ dir, mirroring the
    // photo helper. (findings #31, #70)
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      file.destroy();
      // Reject only AFTER the unlink settles: the caller retries to the SAME
      // dest with no delay, so a fire-and-forget unlink could land after the
      // retry reopened the file and delete its freshly-downloaded content,
      // dropping a successful voice message (ultra-review 2026-07-11 #13).
      fs.unlink(dest)
        .catch(() => {})
        .finally(() => reject(err));
    };

    const req = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume(); // drain so the socket can be freed
        fail(
          telegramTransportError(
            'Telegram media download failed',
            `HTTP_${response.statusCode || 'UNKNOWN'}`,
          ),
        );
        return;
      }
      // pipe() does NOT forward source-stream errors to the destination, so a
      // mid-download TCP reset / premature close emits 'error' on `response`
      // with no listener -> uncaughtException -> the host's global handler
      // process.exit(1)s the whole orchestrator. Listen here. (finding #31)
      response.on('error', fail);
      // Inactivity timeout on the body stream: if bytes stop flowing on a
      // half-open socket the request-level timer above may not fire. (finding #9)
      response.setTimeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS, () => {
        req.destroy(
          telegramTransportError(
            'Telegram media download timed out',
            'ETIMEDOUT',
          ),
        );
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
      req.destroy(
        telegramTransportError(
          'Telegram media download timed out',
          'ETIMEDOUT',
        ),
      );
    });
    req.on('error', fail);
  });
}

/**
 * Downloads a Telegram voice/audio file to <group>/received/<timestamp>-<kind>-<fileId>.<ext>.
 * Returns the absolute host path the agent can Read, or null on error.
 *
 * @param kind "voice" for OGG opus voice notes, "audio" for music/audio messages
 */
export async function downloadTelegramAudio(
  botToken: string,
  fileId: string,
  groupFolder: string,
  kind: 'voice' | 'audio' = 'voice',
): Promise<string | null> {
  try {
    const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
    const fileInfo = await new Promise<any>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(err);
      };
      const req = https.get(infoUrl, (res) => {
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
          } catch {
            reject(
              telegramTransportError(
                'Invalid Telegram getFile response',
                'INVALID_JSON',
              ),
            );
          }
        });
      });
      req.setTimeout(TELEGRAM_METADATA_TIMEOUT_MS, () => {
        req.destroy(
          telegramTransportError(
            'Telegram getFile request timed out',
            'ETIMEDOUT',
          ),
        );
      });
      req.on('error', fail);
    });

    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      logger.warn(
        { stage: 'getFile', failureCode: 'invalid_response', kind },
        'Failed to get Telegram audio info',
      );
      return null;
    }

    const groupDir = resolveGroupFolderPath(groupFolder);
    const receivedDir = path.join(groupDir, 'received');
    await fs.mkdir(receivedDir, { recursive: true });

    const remotePath = String(fileInfo.result.file_path);
    let ext = path.extname(remotePath);
    if (!ext) ext = kind === 'voice' ? '.oga' : '.mp3';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(
      receivedDir,
      `${ts}-${kind}-${safeTelegramAudioFileTag(fileId)}${ext}`,
    );

    const dlUrl = `https://api.telegram.org/file/bot${botToken}/${remotePath}`;
    try {
      await downloadUrl(dlUrl, dest);
    } catch (err) {
      if (!isTransientNetErr(err)) throw err;
      logger.warn(
        { ...safeTelegramAudioLogFields('download', 1, err), kind },
        'Telegram audio download transient error, retrying once',
      );
      await downloadUrl(dlUrl, dest);
    }

    const stat = await fs.stat(dest);
    logger.info({ kind, bytes: stat.size }, 'Saved Telegram audio');
    return dest;
  } catch (err) {
    logger.error(
      { ...safeTelegramAudioLogFields('download_audio', 1, err), kind },
      'Telegram audio download failed',
    );
    return null;
  }
}
