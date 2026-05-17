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

import { readEnvFile } from './orchestrator/env.js';
import { resolveGroupFolderPath } from './orchestrator/group-folder.js';
import { logger } from './orchestrator/logger.js';
import { basenameOnly } from './lib/log-sanitize.js';
import { folderAbsFromMediaPath, updateMediaEntry } from './media-manifest.js';
import { transcribeAudioFile } from './transcription.js';
import {
  FFMPEG_FALLBACKS,
  FFPROBE_FALLBACKS,
  resolveBinary,
} from './lib/binary-paths.js';

const execFileAsync = promisify(execFile);

const envVars = readEnvFile(['FFMPEG_BIN', 'FFPROBE_BIN']);
const FFMPEG_BIN =
  process.env.FFMPEG_BIN ||
  envVars.FFMPEG_BIN ||
  resolveBinary('ffmpeg', FFMPEG_FALLBACKS);
const FFPROBE_BIN =
  process.env.FFPROBE_BIN ||
  envVars.FFPROBE_BIN ||
  resolveBinary('ffprobe', FFPROBE_FALLBACKS);

const TELEGRAM_VIDEO_NOTE_RETRIES = 3;
const TELEGRAM_VIDEO_NOTE_RETRY_BASE_MS = 500;

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
