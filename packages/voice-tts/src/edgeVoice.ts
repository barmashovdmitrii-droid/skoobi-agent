import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { instanceProfile } from '@skoobi/shared/instance-profile';

const execFileAsync = promisify(execFile);

/**
 * The Microsoft Edge voice replies are spoken with: voice.edgeVoice of the
 * instance profile. Read at the point of use, so it follows the profile.
 */
export function edgeVoiceName(): string {
  return instanceProfile().voice.edgeVoice;
}

export const EDGE_VOICE_LANG = 'ru-RU';
export const EDGE_VOICE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
export const EDGE_VOICE_RATE = '+0%';
export const EDGE_VOICE_PITCH = '+0Hz';
export const EDGE_VOICE_TIMEOUT_MS = 45_000;
export const EDGE_VOICE_TIMEOUT_BUFFER_MS = 30_000;
export const EDGE_VOICE_TIMEOUT_PER_CHAR_MS = 100;
export const EDGE_VOICE_MAX_TIMEOUT_MS = 360_000;
export const EDGE_VOICE_MAX_TEXT_CHARS = 4000;
export const EDGE_VOICE_ATTEMPTS = 2;
export const EDGE_VOICE_RETRY_DELAY_MS = 1500;
export const DEFAULT_EDGE_TTS_BIN = path.resolve(
  process.cwd(),
  '.runtime/edge-tts/venv/bin/python',
);
export const DEFAULT_EDGE_TTS_SCRIPT = path.resolve(
  process.cwd(),
  'scripts/edge-tts-adapter.py',
);

export interface EdgeVoiceOptions {
  voiceNote?: boolean;
  outputDir?: string;
  basename?: string;
  ffmpegBin?: string;
  edgeTtsBin?: string;
  edgeTtsScript?: string;
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
}

export interface EdgeVoiceResult {
  filePath: string;
  mimeType: 'audio/mpeg' | 'audio/ogg';
  type: 'mp3' | 'ogg_voice_note';
  cleanup: () => void;
}

export function sanitizeEdgeVoiceText(
  text: string,
  maxChars = EDGE_VOICE_MAX_TEXT_CHARS,
): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxChars).trim();
}

export function edgeVoiceTtsConfig(timeoutMs = EDGE_VOICE_TIMEOUT_MS) {
  return {
    voice: edgeVoiceName(),
    lang: EDGE_VOICE_LANG,
    outputFormat: EDGE_VOICE_OUTPUT_FORMAT,
    rate: EDGE_VOICE_RATE,
    pitch: EDGE_VOICE_PITCH,
    timeout: timeoutMs,
  };
}

export function edgeVoiceTimeoutMs(text: string): number {
  const textLength = sanitizeEdgeVoiceText(text).length;
  return Math.min(
    EDGE_VOICE_MAX_TIMEOUT_MS,
    Math.max(
      EDGE_VOICE_TIMEOUT_MS,
      EDGE_VOICE_TIMEOUT_BUFFER_MS +
        textLength * EDGE_VOICE_TIMEOUT_PER_CHAR_MS,
    ),
  );
}

export function edgeVoiceCliArgs(
  inputTextFile: string,
  outputMp3: string,
  edgeTtsScript = DEFAULT_EDGE_TTS_SCRIPT,
): string[] {
  return [
    edgeTtsScript,
    '--voice',
    edgeVoiceName(),
    `--rate=${EDGE_VOICE_RATE}`,
    `--pitch=${EDGE_VOICE_PITCH}`,
    '--file',
    inputTextFile,
    '--write-media',
    outputMp3,
  ];
}

export function telegramVoiceFfmpegArgs(
  inputMp3: string,
  outputOgg: string,
): string[] {
  return [
    '-y',
    '-i',
    inputMp3,
    '-c:a',
    'libopus',
    '-b:a',
    '48k',
    '-ar',
    '48000',
    '-ac',
    '1',
    '-loglevel',
    'error',
    outputOgg,
  ];
}

function assertNonEmptyFile(filePath: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`${label} was not created`);
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`${label} is empty`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertFfmpeg(ffmpegBin: string): Promise<void> {
  try {
    await execFileAsync(ffmpegBin, ['-version']);
  } catch {
    throw new Error(`ffmpeg is not installed or not executable. Install it with: brew install ffmpeg`);
  }
}

export async function synthesizeEdgeVoice(
  text: string,
  options: EdgeVoiceOptions = {},
): Promise<EdgeVoiceResult> {
  const cleanText = sanitizeEdgeVoiceText(text);
  if (!cleanText) {
    throw new Error('Cannot synthesize an empty voice message');
  }

  const ownsTempDir = !options.outputDir;
  const outputDir =
    options.outputDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-edge-tts-'));
  fs.mkdirSync(outputDir, { recursive: true });

  const basename = (options.basename ?? 'reply').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const mp3Path = path.join(outputDir, `${basename}.mp3`);
  const oggPath = path.join(outputDir, `${basename}.ogg`);
  const textPath = path.join(outputDir, `${basename}.txt`);

  try {
    const timeoutMs = options.timeoutMs ?? edgeVoiceTimeoutMs(cleanText);
    const edgeTtsBin = options.edgeTtsBin ?? DEFAULT_EDGE_TTS_BIN;
    const edgeTtsScript = options.edgeTtsScript ?? DEFAULT_EDGE_TTS_SCRIPT;
    const attempts = Math.max(1, options.attempts ?? EDGE_VOICE_ATTEMPTS);
    const retryDelayMs = Math.max(
      0,
      options.retryDelayMs ?? EDGE_VOICE_RETRY_DELAY_MS,
    );
    const deadline = Date.now() + timeoutMs;
    fs.writeFileSync(textPath, cleanText, { encoding: 'utf8', mode: 0o600 });
    let lastSynthesisError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        fs.rmSync(mp3Path, { force: true });
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await execFileAsync(
          edgeTtsBin,
          edgeVoiceCliArgs(textPath, mp3Path, edgeTtsScript),
          {
            timeout: remainingMs,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        assertNonEmptyFile(mp3Path, 'Edge TTS mp3 file');
        lastSynthesisError = undefined;
        break;
      } catch (err) {
        lastSynthesisError = err;
        const remainingMs = deadline - Date.now();
        if (attempt < attempts && remainingMs > retryDelayMs + 1000) {
          await delay(retryDelayMs);
        } else {
          break;
        }
      }
    }
    if (lastSynthesisError) throw lastSynthesisError;

    if (options.voiceNote === true) {
      const ffmpegBin = options.ffmpegBin ?? 'ffmpeg';
      await assertFfmpeg(ffmpegBin);
      await execFileAsync(ffmpegBin, telegramVoiceFfmpegArgs(mp3Path, oggPath));
      assertNonEmptyFile(oggPath, 'Telegram OGG voice note');
      return {
        filePath: oggPath,
        mimeType: 'audio/ogg',
        type: 'ogg_voice_note',
        cleanup: () => {
          if (ownsTempDir) fs.rmSync(outputDir, { recursive: true, force: true });
        },
      };
    }

    return {
      filePath: mp3Path,
      mimeType: 'audio/mpeg',
      type: 'mp3',
      cleanup: () => {
        if (ownsTempDir) fs.rmSync(outputDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    if (ownsTempDir) fs.rmSync(outputDir, { recursive: true, force: true });
    throw err;
  } finally {
    fs.rmSync(textPath, { force: true });
  }
}
