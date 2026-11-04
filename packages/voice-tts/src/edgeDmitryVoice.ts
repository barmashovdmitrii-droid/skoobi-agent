import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { EdgeTTS } from 'node-edge-tts';

const execFileAsync = promisify(execFile);

export const EDGE_DMITRY_VOICE = 'ru-RU-DmitryNeural';
export const EDGE_DMITRY_LANG = 'ru-RU';
export const EDGE_DMITRY_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
export const EDGE_DMITRY_RATE = '+0%';
export const EDGE_DMITRY_PITCH = '+0Hz';
export const EDGE_DMITRY_TIMEOUT_MS = 45_000;
export const EDGE_DMITRY_TIMEOUT_BUFFER_MS = 30_000;
export const EDGE_DMITRY_TIMEOUT_PER_CHAR_MS = 100;
export const EDGE_DMITRY_MAX_TIMEOUT_MS = 360_000;
export const EDGE_DMITRY_MAX_TEXT_CHARS = 4000;
export const EDGE_DMITRY_ATTEMPTS = 2;
export const EDGE_DMITRY_RETRY_DELAY_MS = 1500;

export interface DmitryVoiceOptions {
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

export interface DmitryVoiceResult {
  filePath: string;
  mimeType: 'audio/mpeg' | 'audio/ogg';
  type: 'mp3' | 'ogg_voice_note';
  cleanup: () => void;
}

export function sanitizeDmitryVoiceText(
  text: string,
  maxChars = EDGE_DMITRY_MAX_TEXT_CHARS,
): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxChars).trim();
}

export function edgeDmitryTtsConfig(timeoutMs = EDGE_DMITRY_TIMEOUT_MS) {
  return {
    voice: EDGE_DMITRY_VOICE,
    lang: EDGE_DMITRY_LANG,
    outputFormat: EDGE_DMITRY_OUTPUT_FORMAT,
    rate: EDGE_DMITRY_RATE,
    pitch: EDGE_DMITRY_PITCH,
    timeout: timeoutMs,
  };
}

export function edgeDmitryTimeoutMs(text: string): number {
  const textLength = sanitizeDmitryVoiceText(text).length;
  return Math.min(
    EDGE_DMITRY_MAX_TIMEOUT_MS,
    Math.max(
      EDGE_DMITRY_TIMEOUT_MS,
      EDGE_DMITRY_TIMEOUT_BUFFER_MS +
        textLength * EDGE_DMITRY_TIMEOUT_PER_CHAR_MS,
    ),
  );
}

export function edgeDmitryCliArgs(
  inputTextFile: string,
  outputMp3: string,
  edgeTtsScript: string,
): string[] {
  return [
    edgeTtsScript,
    '--voice',
    EDGE_DMITRY_VOICE,
    `--rate=${EDGE_DMITRY_RATE}`,
    `--pitch=${EDGE_DMITRY_PITCH}`,
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
    throw new Error(
      `ffmpeg is not installed or not executable. Install it with: brew install ffmpeg`,
    );
  }
}

export async function synthesizeDmitryVoice(
  text: string,
  options: DmitryVoiceOptions = {},
): Promise<DmitryVoiceResult> {
  const cleanText = sanitizeDmitryVoiceText(text);
  if (!cleanText) {
    throw new Error('Cannot synthesize an empty voice message');
  }

  const ownsTempDir = !options.outputDir;
  const outputDir =
    options.outputDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-edge-tts-'));
  fs.mkdirSync(outputDir, { recursive: true });

  const basename = (options.basename ?? 'reply').replace(
    /[^a-zA-Z0-9_.-]/g,
    '_',
  );
  const mp3Path = path.join(outputDir, `${basename}.mp3`);
  const oggPath = path.join(outputDir, `${basename}.ogg`);
  const textPath = path.join(outputDir, `${basename}.txt`);

  try {
    const timeoutMs = options.timeoutMs ?? edgeDmitryTimeoutMs(cleanText);
    const edgeTtsBin = options.edgeTtsBin ?? 'python3';
    const edgeTtsScript = options.edgeTtsScript;
    const useHelper = Boolean(edgeTtsScript && fs.existsSync(edgeTtsScript));
    const attempts = Math.max(1, options.attempts ?? EDGE_DMITRY_ATTEMPTS);
    const retryDelayMs = Math.max(
      0,
      options.retryDelayMs ?? EDGE_DMITRY_RETRY_DELAY_MS,
    );
    const deadline = Date.now() + timeoutMs;
    fs.writeFileSync(textPath, cleanText, { encoding: 'utf8', mode: 0o600 });
    let lastSynthesisError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        fs.rmSync(mp3Path, { force: true });
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        if (useHelper && edgeTtsScript) {
          await execFileAsync(
            edgeTtsBin,
            edgeDmitryCliArgs(textPath, mp3Path, edgeTtsScript),
            { timeout: remainingMs, maxBuffer: 4 * 1024 * 1024 },
          );
        } else {
          // Public installs work without an instance-specific Python helper.
          const tts = new EdgeTTS(edgeDmitryTtsConfig(remainingMs));
          await tts.ttsPromise(cleanText, mp3Path);
        }
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
          if (ownsTempDir)
            fs.rmSync(outputDir, { recursive: true, force: true });
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
