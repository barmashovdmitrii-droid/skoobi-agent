/**
 * Text-to-speech synthesis for outbound voice messages.
 * Supports two providers selected via TTS_PROVIDER env var:
 *   - "local" (default): macOS `say` + ffmpeg → OGG opus
 *   - "openai": OpenAI tts-1-hd → OGG opus (requires OPENAI_API_KEY)
 *
 * Long texts are chunked at sentence/word boundaries (max 3000 chars per chunk).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import https from 'https';

import { readEnvFile } from './orchestrator/env.js';
import { logger } from './orchestrator/logger.js';

const execFileAsync = promisify(execFile);

const ttsEnv = readEnvFile([
  'TTS_PROVIDER',
  'TTS_VOICE',
  'TTS_VOICE_OPENAI',
  'OPENAI_API_KEY',
  'SAY_BIN',
  'FFMPEG_BIN',
]);

const PROVIDER = (
  process.env.TTS_PROVIDER ||
  ttsEnv.TTS_PROVIDER ||
  'local'
).toLowerCase();
const LOCAL_VOICE = process.env.TTS_VOICE || ttsEnv.TTS_VOICE || 'Milena';
const OPENAI_VOICE =
  process.env.TTS_VOICE_OPENAI || ttsEnv.TTS_VOICE_OPENAI || 'nova';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ttsEnv.OPENAI_API_KEY || '';
const SAY_BIN = process.env.SAY_BIN || ttsEnv.SAY_BIN || '/usr/bin/say';
const FFMPEG_BIN =
  process.env.FFMPEG_BIN || ttsEnv.FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg';

const MAX_CHUNK = 3000;

export function chunkText(text: string, max = MAX_CHUNK): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf('. ', max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf('! ', max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf('? ', max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf(' ', max);
    if (cut < max * 0.3) cut = max;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter((c) => c.length > 0);
}

async function synthLocal(text: string, outOgg: string): Promise<void> {
  const aiff = outOgg.replace(/\.ogg$/, '.aiff');
  await execFileAsync(SAY_BIN, ['-v', LOCAL_VOICE, '-o', aiff, text]);
  try {
    await execFileAsync(FFMPEG_BIN, [
      '-y',
      '-i',
      aiff,
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-loglevel',
      'error',
      outOgg,
    ]);
  } finally {
    fs.unlink(aiff, () => undefined);
  }
}

function postOpenAI(payload: object, apiKey: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.openai.com',
        path: '/v1/audio/speech',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(buf);
          } else {
            reject(
              new Error(
                `OpenAI TTS HTTP ${res.statusCode}: ${buf.toString('utf-8').slice(0, 300)}`,
              ),
            );
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function synthOpenAI(text: string, outOgg: string): Promise<void> {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set — cannot use TTS_PROVIDER=openai');
  }
  const buf = await postOpenAI(
    {
      model: 'tts-1-hd',
      voice: OPENAI_VOICE,
      input: text,
      response_format: 'opus',
    },
    OPENAI_API_KEY,
  );
  fs.writeFileSync(outOgg, buf);
}

export interface SynthResult {
  /** Absolute paths to OGG/OPUS files in temp dir, in playback order. */
  files: string[];
  /** Caller MUST invoke this when delivery is done to remove temp files. */
  cleanup: () => void;
}

export async function synthesizeVoice(text: string): Promise<SynthResult> {
  const chunks = chunkText(text);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-voice-'));
  const files: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const out = path.join(tmpDir, `chunk-${i}.ogg`);
    try {
      if (PROVIDER === 'openai') {
        await synthOpenAI(chunks[i], out);
      } else {
        await synthLocal(chunks[i], out);
      }
      files.push(out);
    } catch (err) {
      logger.error(
        { provider: PROVIDER, chunk: i, err },
        'TTS synthesis failed',
      );
      throw err;
    }
  }

  return {
    files,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

export function ttsProvider(): string {
  return PROVIDER;
}

export function ttsVoiceName(): string {
  return PROVIDER === 'openai' ? OPENAI_VOICE : LOCAL_VOICE;
}
