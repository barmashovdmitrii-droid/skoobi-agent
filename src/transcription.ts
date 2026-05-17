/**
 * Channel-agnostic audio transcription via local whisper-cli.
 * Caller passes a path to an already-downloaded audio file (any format
 * ffmpeg can read). We convert to 16 kHz mono WAV and run whisper-cli.
 *
 * The source file is NOT deleted — the caller owns its lifecycle.
 * We only clean up the intermediate WAV.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

import { logger } from './orchestrator/logger.js';
import { readEnvFile } from './orchestrator/env.js';
import { basenameOnly } from './lib/log-sanitize.js';
import {
  FFMPEG_FALLBACKS,
  WHISPER_FALLBACKS,
  resolveBinary,
} from './lib/binary-paths.js';
import {
  folderAbsFromMediaPath,
  updateMediaEntry,
} from './media-manifest.js';

const execFileAsync = promisify(execFile);

const envVars = readEnvFile([
  'WHISPER_BIN',
  'WHISPER_MODEL',
  'WHISPER_LANG',
  'WHISPER_NO_GPU',
  'WHISPER_THREADS',
  'WHISPER_TIMEOUT_MS',
  'FFMPEG_BIN',
]);
const WHISPER_BIN =
  process.env.WHISPER_BIN ||
  envVars.WHISPER_BIN ||
  resolveBinary('whisper-cli', WHISPER_FALLBACKS);
const WHISPER_MODEL = process.env.WHISPER_MODEL || envVars.WHISPER_MODEL || '';
const WHISPER_NO_GPU =
  (process.env.WHISPER_NO_GPU || envVars.WHISPER_NO_GPU || '').toLowerCase() ===
  'true';
const WHISPER_THREADS =
  process.env.WHISPER_THREADS || envVars.WHISPER_THREADS || '';
const WHISPER_TIMEOUT_MS = parseInt(
  process.env.WHISPER_TIMEOUT_MS || envVars.WHISPER_TIMEOUT_MS || '180000',
  10,
);
const FFMPEG_BIN =
  process.env.FFMPEG_BIN ||
  envVars.FFMPEG_BIN ||
  resolveBinary('ffmpeg', FFMPEG_FALLBACKS);

// Serialise local whisper-cli runs: large-v3 на CPU без GPU съедает 4 потока на
// процесс, 3 параллельных voice'а = 12 потоков на 10-core M4 + ffmpeg + Node →
// CPU saturation, sandbox начинает зависать. Семафор ставит локальные транскрипты
// в очередь по 1, без потерь точности.
let localTail: Promise<void> = Promise.resolve();
function withLocalTranscriptionSlot<T>(run: () => Promise<T>): Promise<T> {
  const previous = localTail;
  let release!: () => void;
  localTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous.then(run).finally(release);
}

/**
 * Transcribe a local audio file to text.
 *
 * @param audioPath  Absolute path to an audio file (OGG/Opus, MP3, WAV, M4A, …).
 * @param langOverride  ISO 639-1 code or "auto". Falls back to WHISPER_LANG env, then "ru".
 * @returns transcript text or null on failure.
 */
export async function transcribeAudioFile(
  audioPath: string,
  langOverride?: string,
): Promise<string | null> {
  if (!WHISPER_MODEL) {
    logger.error('WHISPER_MODEL required. Voice transcription disabled.');
    return null;
  }

  const tmpWav = join(
    tmpdir(),
    `transcribe-${Date.now()}-${process.pid}-${randomUUID()}.wav`,
  );

  try {
    // Step 1: convert to 16 kHz mono WAV (whisper.cpp doesn't read OGG/MP3 natively)
    await execFileAsync(
      FFMPEG_BIN,
      [
        '-y',
        '-i',
        audioPath,
        '-ar',
        '16000',
        '-ac',
        '1',
        '-loglevel',
        'error',
        tmpWav,
      ],
      { timeout: 60_000 },
    );

    // Step 2: transcribe.
    // -l ru by default: auto-detect tends to return "(speaking in foreign language)".
    // WHISPER_LANG env var or argument can override (e.g. "auto", "en").
    const lang =
      langOverride || process.env.WHISPER_LANG || envVars.WHISPER_LANG || 'ru';
    const whisperArgs = [
      '-m',
      WHISPER_MODEL,
      '-f',
      tmpWav,
      '-l',
      lang,
      '--no-timestamps',
      '-nt',
    ];
    if (WHISPER_THREADS) {
      whisperArgs.push('-t', WHISPER_THREADS);
    }
    if (WHISPER_NO_GPU) {
      whisperArgs.push('--no-gpu');
    }
    const { stdout, stderr } = await withLocalTranscriptionSlot(() =>
      execFileAsync(WHISPER_BIN, whisperArgs, {
        timeout: WHISPER_TIMEOUT_MS,
      }),
    );

    // whisper-cli logs to stderr; strip noise lines so only the actual transcript remains.
    const raw = (stdout + '\n' + stderr)
      .split('\n')
      .filter(
        (line) =>
          line.trim() &&
          !line.startsWith('[') &&
          !line.includes('whisper_') &&
          !line.includes('main:') &&
          !line.includes('system_info') &&
          !line.includes('metal') &&
          !line.includes('ggml') &&
          !line.toLowerCase().startsWith('error:') &&
          !line.toLowerCase().includes('failed to read') &&
          !line.toLowerCase().includes('load_backend'),
      )
      .join(' ')
      .trim();

    const transcript = raw || null;
    logger.info(
      {
        audioBasename: basenameOnly(audioPath),
        chars: transcript?.length ?? 0,
        via: 'local-whisper',
      },
      'Transcribed audio file',
    );
    // Best-effort manifest update: mark the entry as transcribed. Skip
    // when the file is a tmp path (not under a `groups/<folder>/received/`
    // layout) — those have no manifest.
    if (transcript) {
      const folderAbs = folderAbsFromMediaPath(audioPath);
      if (folderAbs) {
        await updateMediaEntry(folderAbs, basenameOnly(audioPath), {
          has_transcript: true,
          transcript_chars: transcript.length,
        }).catch(() => {
          // manifest update is non-critical
        });
      }
    }
    return transcript;
  } catch (err) {
    logger.error(
      { err, audioBasename: basenameOnly(audioPath) },
      'Audio transcription failed',
    );
    return null;
  } finally {
    await fs.unlink(tmpWav).catch(() => {});
  }
}
