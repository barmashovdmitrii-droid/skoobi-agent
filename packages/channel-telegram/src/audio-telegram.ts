/**
 * Telegram audio/voice download → saves to group folder so agent can Read it.
 * Mirrors photo-telegram.ts. Used for both `message:voice` and `message:audio`.
 */

import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import https from 'https';

import { logger } from '@skoobi/shared/logger';
import { resolveGroupFolderPath } from '@skoobi/shared/group-folder';
import {
  startOperationTraceStage,
  type OperationTraceObserver,
  type OperationTraceSpan,
} from '@skoobi/shared/operation-trace';

// A hung Telegram CDN socket (half-open, no FIN/RST) would otherwise stall the
// awaiting grammY handler forever, freezing the bot's whole sequential update
// loop for every tenant. Cap each connect/read phase so a single flaky transfer
// can never become a full-bot outage. (finding #9)
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 30_000;
const TELEGRAM_METADATA_TIMEOUT_MS = 15_000;
const TELEGRAM_DOWNLOAD_WALL_MS = 60_000;

export interface TelegramAudioDownloadControl {
  destinationPath: string;
  signal: AbortSignal;
  deadlineAtMs: number;
  maxBytes: number;
  /** Durable worker reserves each attempt itself. */
  maxAttempts: 1;
}

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

/** Controlled worker transfer: unique .part file, bounded bytes and real abort. */
function downloadControlledUrl(
  url: string,
  dest: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(telegramTransportError('Download aborted', 'ABORT_ERR'));
      return;
    }
    const file = createWriteStream(dest, { flags: 'wx', mode: 0o600 });
    let response: import('http').IncomingMessage | undefined;
    let failure: Error | undefined;
    let finished = false;
    let owned = false;
    let bytes = 0;
    const fail = (error: Error) => {
      if (failure || finished) return;
      failure = error;
      req.destroy();
      response?.destroy();
      file.destroy();
    };
    const abort = () =>
      fail(telegramTransportError('Download aborted', 'ABORT_ERR'));
    const req = https.get(url, (res) => {
      response = res;
      if (res.statusCode !== 200) {
        fail(
          telegramTransportError(
            'Download rejected',
            `HTTP_${res.statusCode || 'UNKNOWN'}`,
          ),
        );
        return;
      }
      res.on('error', fail);
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes)
          fail(telegramTransportError('Download too large', 'ETOOBIG'));
      });
      res.setTimeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS, () =>
        fail(telegramTransportError('Download timed out', 'ETIMEDOUT')),
      );
      res.pipe(file);
    });
    req.on('error', fail);
    req.setTimeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS, () =>
      fail(telegramTransportError('Download timed out', 'ETIMEDOUT')),
    );
    file.on('error', fail);
    file.on('open', () => {
      owned = true;
    });
    file.on('finish', () => {
      finished = true;
    });
    file.on('close', () => {
      signal.removeEventListener('abort', abort);
      // close is the local write boundary; never unlink a still-open writer.
      if (failure && owned)
        void fs
          .unlink(dest)
          .catch(() => {})
          .then(() => reject(failure));
      else if (failure) reject(failure);
      else if (finished) resolve();
      else reject(telegramTransportError('Download incomplete', 'ECONNRESET'));
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
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
  trace?: OperationTraceObserver,
  control?: TelegramAudioDownloadControl,
): Promise<string | null> {
  const metadataSpan = startOperationTraceStage(trace, 'get_file');
  let downloadSpan: OperationTraceSpan | undefined;
  let failureStage: 'network' | 'storage' = 'network';
  const controller = control ? new AbortController() : undefined;
  const abort = () => controller?.abort();
  control?.signal.addEventListener('abort', abort, { once: true });
  if (control?.signal.aborted) abort();
  const wallTimer = control
    ? setTimeout(
        abort,
        Math.max(
          0,
          Math.min(
            TELEGRAM_DOWNLOAD_WALL_MS,
            control.deadlineAtMs - Date.now(),
          ),
        ),
      )
    : undefined;
  try {
    if (controller?.signal.aborted)
      throw telegramTransportError('Download aborted', 'ABORT_ERR');
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
        res.on('data', (chunk) => {
          data += chunk;
          if (control && Buffer.byteLength(data) > 64 * 1024)
            fail(telegramTransportError('Metadata too large', 'ETOOBIG'));
        });
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
      if (controller) {
        const abortMetadata = () =>
          req.destroy(telegramTransportError('Metadata aborted', 'ABORT_ERR'));
        controller.signal.addEventListener('abort', abortMetadata, {
          once: true,
        });
        req.once('close', () =>
          controller.signal.removeEventListener('abort', abortMetadata),
        );
        if (controller.signal.aborted) abortMetadata();
      }
    });

    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      metadataSpan.finish('failed', { reason: 'invalid_response' });
      logger.warn(
        { stage: 'getFile', failureCode: 'invalid_response', kind },
        'Failed to get Telegram audio info',
      );
      return null;
    }
    metadataSpan.finish('succeeded');

    failureStage = 'storage';
    downloadSpan = startOperationTraceStage(trace, 'download', {
      passIndex: 1,
    });
    const groupDir = resolveGroupFolderPath(groupFolder);
    const receivedDir = path.join(groupDir, 'received');
    await fs.mkdir(receivedDir, { recursive: true });

    const remotePath = String(fileInfo.result.file_path);
    let ext = path.extname(remotePath);
    if (!ext) ext = kind === 'voice' ? '.oga' : '.mp3';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest =
      control?.destinationPath ??
      path.join(
        receivedDir,
        `${ts}-${kind}-${safeTelegramAudioFileTag(fileId)}${ext}`,
      );

    const dlUrl = `https://api.telegram.org/file/bot${botToken}/${remotePath}`;
    failureStage = 'network';
    try {
      if (control && controller)
        await downloadControlledUrl(
          dlUrl,
          dest,
          controller.signal,
          control.maxBytes,
        );
      else await downloadUrl(dlUrl, dest);
    } catch (err) {
      downloadSpan.finish('failed', { reason: 'network_failure' });
      if (control?.maxAttempts === 1 || !isTransientNetErr(err)) throw err;
      logger.warn(
        { ...safeTelegramAudioLogFields('download', 1, err), kind },
        'Telegram audio download transient error, retrying once',
      );
      downloadSpan = startOperationTraceStage(trace, 'download', {
        passIndex: 2,
        reason: 'retry',
      });
      await downloadUrl(dlUrl, dest);
    }

    failureStage = 'storage';
    const stat = await fs.stat(dest);
    downloadSpan.finish('succeeded', { bytes: stat.size });
    logger.info({ kind, bytes: stat.size }, 'Saved Telegram audio');
    return dest;
  } catch (err) {
    const reason =
      failureStage === 'storage' ? 'storage_failure' : 'network_failure';
    metadataSpan.finish('failed', { reason });
    downloadSpan?.finish('failed', { reason });
    logger.error(
      { ...safeTelegramAudioLogFields('download_audio', 1, err), kind },
      'Telegram audio download failed',
    );
    return null;
  } finally {
    clearTimeout(wallTimer);
    control?.signal.removeEventListener('abort', abort);
  }
}
