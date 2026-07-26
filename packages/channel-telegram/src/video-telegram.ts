/**
 * Telegram video download + local understanding.
 *
 * Telegram videos/video notes are media files with optional audio. We save the
 * original clip, transcribe its audio via the existing local Whisper pipeline,
 * and extract a few still frames so Skoobi can attach visual context safely.
 */

import { execFile } from 'child_process';
import { createWriteStream, promises as fs } from 'fs';
import https from 'https';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from '@skoobi/shared/env';
import {
  FFMPEG_FALLBACKS,
  FFPROBE_FALLBACKS,
  resolveBinary,
} from '@skoobi/shared/binary-paths';
import { resolveGroupFolderPath } from '@skoobi/shared/group-folder';
import { logger } from '@skoobi/shared/logger';
import { basenameOnly } from '@skoobi/shared/log-sanitize';
import { folderAbsFromMediaPath, updateMediaEntry } from '@skoobi/shared/media-manifest';
import {
  transcribeAudioFile,
  unlinkPartialBeforeRetry,
} from '@skoobi/voice-stt';

const execFileAsync = promisify(execFile);

const envVars = readEnvFile(['FFMPEG_BIN', 'FFPROBE_BIN']);
const FFMPEG_BIN =
  process.env.FFMPEG_BIN ||
  envVars.FFMPEG_BIN ||
  resolveBinary('ffmpeg', FFMPEG_FALLBACKS);
const FFPROBE_BIN =
  process.env.FFPROBE_BIN ||
  envVars.FFPROBE_BIN ||
  resolveBinary('ffprobe', [
    FFMPEG_BIN.replace(/ffmpeg$/u, 'ffprobe'),
    ...FFPROBE_FALLBACKS,
  ]);

const TELEGRAM_VIDEO_NOTE_RETRIES = 3;
const TELEGRAM_VIDEO_NOTE_RETRY_BASE_MS = 500;

// A hung Telegram CDN socket (half-open, no FIN/RST) would otherwise stall the
// awaiting grammY handler forever, freezing the bot's whole sequential update
// loop for every tenant. withRetry can't rescue a promise that never settles,
// so cap each connect/read phase: a single flaky transfer can never become a
// full-bot outage. (findings #9, #31)
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 30_000;
const TELEGRAM_METADATA_TIMEOUT_MS = 15_000;

export interface TelegramVideoNoteResult {
  videoPath: string | null;
  transcript: string | null;
  framePaths: string[];
}

type TelegramVideoKind = 'video-note' | 'video';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  operation: () => Promise<T>,
  meta: { fileId: string; stage: string },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TELEGRAM_VIDEO_NOTE_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt === TELEGRAM_VIDEO_NOTE_RETRIES) break;
      logger.warn(
        { ...meta, attempt, err },
        'Telegram video download attempt failed, retrying',
      );
      await sleep(TELEGRAM_VIDEO_NOTE_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError;
}

function downloadUrl(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    let settled = false;

    // Unlink the (already-created) partial/0-byte dest before rejecting so
    // failed downloads don't litter the group's received/ dir. Reject exactly
    // once so a timeout-then-error (or error-then-finish) can't double-settle
    // or leave the partial behind. (findings #9, #31)
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      file.destroy();
      void unlinkPartialBeforeRetry(dest).then(() => reject(err));
    };

    const req = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume(); // drain so the socket can be freed
        fail(new Error(`HTTP ${response.statusCode} downloading ${url}`));
        return;
      }
      // pipe() does NOT forward source-stream errors to the destination, so a
      // mid-download TCP reset / premature close emits 'error' on `response`
      // with no listener -> uncaughtException -> the host's global handler
      // process.exit(1)s the whole orchestrator. Listen BEFORE pipe. (finding #31)
      response.on('error', fail);
      // Inactivity timeout on the body stream: if bytes stop flowing on a
      // half-open socket the request-level timer below may not fire. (finding #9)
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
      res.setTimeout(TELEGRAM_METADATA_TIMEOUT_MS, () => {
        req.destroy(new Error(`timeout fetching ${url}`));
      });
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

async function getVideoDurationSeconds(videoPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_BIN,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        videoPath,
      ],
      { timeout: 30_000 },
    );
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch (err) {
    logger.warn(
      { err, videoBasename: basenameOnly(videoPath) },
      'Failed to probe video duration',
    );
    return 0;
  }
}

function frameTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  if (duration < 2) return [Math.max(0, duration * 0.15)];
  if (duration < 5) return [0.25, Math.max(0.5, duration * 0.65)];
  return [0.5, duration * 0.5, Math.max(0.5, duration - 0.75)];
}

async function extractVideoFrames(
  videoPath: string,
  receivedDir: string,
  baseName: string,
): Promise<string[]> {
  const duration = await getVideoDurationSeconds(videoPath);
  const frames: string[] = [];

  for (const [idx, seconds] of frameTimes(duration).entries()) {
    const dest = path.join(
      receivedDir,
      `${baseName}-frame-${String(idx + 1).padStart(2, '0')}.jpg`,
    );
    try {
      await execFileAsync(
        FFMPEG_BIN,
        [
          '-y',
          '-ss',
          seconds.toFixed(3),
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-q:v',
          '3',
          '-loglevel',
          'error',
          dest,
        ],
        { timeout: 45_000 },
      );
      const stat = await fs.stat(dest).catch(() => null);
      if (stat && stat.size > 0) frames.push(dest);
    } catch (err) {
      await fs.unlink(dest).catch(() => {});
      logger.warn(
        {
          err,
          videoBasename: basenameOnly(videoPath),
          frame: idx + 1,
          seconds,
        },
        'Failed to extract Telegram video frame',
      );
    }
  }

  return frames;
}

async function processTelegramVideoMedia(
  botToken: string,
  fileId: string,
  groupFolder: string,
  kind: TelegramVideoKind,
): Promise<TelegramVideoNoteResult> {
  try {
    const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
    const fileInfo = await withRetry(() => getTelegramFileInfo(infoUrl), {
      fileId,
      stage: 'getFile',
    });

    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      logger.warn({ fileId, fileInfo }, 'Failed to get Telegram video info');
      return { videoPath: null, transcript: null, framePaths: [] };
    }

    const groupDir = resolveGroupFolderPath(groupFolder);
    const receivedDir = path.join(groupDir, 'received');
    await fs.mkdir(receivedDir, { recursive: true });

    const remotePath = String(fileInfo.result.file_path);
    const ext = path.extname(remotePath) || '.mp4';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = `${ts}-${kind}-${fileId.slice(-8)}`;
    const videoPath = path.join(receivedDir, `${baseName}${ext}`);

    const dlUrl = `https://api.telegram.org/file/bot${botToken}/${remotePath}`;
    await withRetry(() => downloadUrl(dlUrl, videoPath), {
      fileId,
      stage: 'download',
    });

    const stat = await fs.stat(videoPath);
    logger.info(
      {
        fileId,
        kind,
        videoBasename: basenameOnly(videoPath),
        bytes: stat.size,
      },
      'Saved Telegram video',
    );

    const [transcript, framePaths] = await Promise.all([
      transcribeAudioFile(videoPath),
      extractVideoFrames(videoPath, receivedDir, baseName),
    ]);

    logger.info(
      {
        fileId,
        kind,
        videoBasename: basenameOnly(videoPath),
        transcriptChars: transcript?.length ?? 0,
        frameCount: framePaths.length,
      },
      'Processed Telegram video',
    );

    // Best-effort: if a manifest entry already exists for this video media,
    // mark the transcript availability. The Telegram-channel handler also
    // writes this when it appends the entry, but this path makes the
    // helper independently reusable.
    if (transcript) {
      const folderAbs = folderAbsFromMediaPath(videoPath);
      if (folderAbs) {
        await updateMediaEntry(folderAbs, basenameOnly(videoPath), {
          has_transcript: true,
          transcript_chars: transcript.length,
        }).catch(() => {
          // manifest update is non-critical
        });
      }
    }

    return { videoPath, transcript, framePaths };
  } catch (err) {
    logger.error({ err, fileId, kind }, 'Telegram video processing failed');
    return { videoPath: null, transcript: null, framePaths: [] };
  }
}

/**
 * Downloads and processes a Telegram video note.
 */
export async function processTelegramVideoNote(
  botToken: string,
  fileId: string,
  groupFolder: string,
): Promise<TelegramVideoNoteResult> {
  return processTelegramVideoMedia(botToken, fileId, groupFolder, 'video-note');
}

/**
 * Downloads and processes a regular Telegram video message.
 */
export async function processTelegramVideoFile(
  botToken: string,
  fileId: string,
  groupFolder: string,
): Promise<TelegramVideoNoteResult> {
  return processTelegramVideoMedia(botToken, fileId, groupFolder, 'video');
}
