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
export const EDGE_DMITRY_PITCH = '+0%';
export const EDGE_DMITRY_TIMEOUT_MS = 45_000;
export const EDGE_DMITRY_MAX_TEXT_CHARS = 4000;

export interface DmitryVoiceOptions {
  voiceNote?: boolean;
  outputDir?: string;
  basename?: string;
  ffmpegBin?: string;
  timeoutMs?: number;
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

async function assertFfmpeg(ffmpegBin: string): Promise<void> {
  try {
    await execFileAsync(ffmpegBin, ['-version']);
  } catch {
    throw new Error(`ffmpeg is not installed or not executable. Install it with: brew install ffmpeg`);
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
    options.outputDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-edge-tts-'));
  fs.mkdirSync(outputDir, { recursive: true });

  const basename = (options.basename ?? 'reply').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const mp3Path = path.join(outputDir, `${basename}.mp3`);
  const oggPath = path.join(outputDir, `${basename}.ogg`);

  try {
    const tts = new EdgeTTS(edgeDmitryTtsConfig(options.timeoutMs));
    await tts.ttsPromise(cleanText, mp3Path);
    assertNonEmptyFile(mp3Path, 'Edge TTS mp3 file');

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
  }
}

