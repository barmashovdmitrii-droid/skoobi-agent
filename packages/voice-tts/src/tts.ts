/**
 * Text-to-speech synthesis for outbound voice messages.
 * Supports providers selected via TTS_PROVIDER env var:
 *   - "edge" (default): Microsoft Edge TTS neural voice → mp3 → OGG opus
 *   - "local": macOS `say` or Linux RHVoice + ffmpeg → OGG opus
 *   - "rhvoice": Linux RHVoice + ffmpeg → OGG opus
 *   - "espeak-ng": Linux espeak-ng + ffmpeg → OGG opus
 *   - "openai": OpenAI tts-1-hd → OGG opus (requires OPENAI_API_KEY)
 *   - "azure": Azure AI Speech REST API → OGG opus (requires AZURE_SPEECH_KEY/REGION)
 *
 * Long texts are chunked at sentence/word boundaries (max 3000 chars per chunk).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import https from 'https';

import {
  FFMPEG_FALLBACKS,
  logger,
  readEnvFile,
  resolveBinary,
} from '@skoobi/shared';
import { instanceProfile } from '@skoobi/shared/instance-profile';
import {
  DEFAULT_EDGE_TTS_BIN,
  DEFAULT_EDGE_TTS_SCRIPT,
  edgeVoiceName,
  synthesizeEdgeVoice,
} from './edgeVoice.js';

const execFileAsync = promisify(execFile);

const ttsEnv = readEnvFile([
  'TTS_PROVIDER',
  'EDGE_TTS_BIN',
  'EDGE_TTS_SCRIPT',
  'TTS_VOICE',
  'TTS_VOICE_OPENAI',
  'OPENAI_API_KEY',
  'AZURE_SPEECH_KEY',
  'AZURE_SPEECH_REGION',
  'AZURE_TTS_VOICE',
  'AZURE_TTS_OUTPUT_FORMAT',
  'SAY_BIN',
  'RHVOICE_BIN',
  'RHVOICE_VOICE',
  'RHVOICE_QUALITY',
  'RHVOICE_VOLUME',
  'RHVOICE_RATE',
  'RHVOICE_PITCH',
  'RHVOICE_SAMPLE_RATE',
  'ESPEAK_NG_BIN',
  'ESPEAK_NG_VOICE',
  'FFMPEG_BIN',
  'TTS_OPUS_BITRATE',
  'TTS_FFMPEG_LOUDNORM',
]);

const PROVIDER = (
  process.env.TTS_PROVIDER ||
  ttsEnv.TTS_PROVIDER ||
  'edge'
).toLowerCase();
const EDGE_TTS_BIN =
  process.env.EDGE_TTS_BIN || ttsEnv.EDGE_TTS_BIN || DEFAULT_EDGE_TTS_BIN;
const EDGE_TTS_SCRIPT =
  process.env.EDGE_TTS_SCRIPT ||
  ttsEnv.EDGE_TTS_SCRIPT ||
  DEFAULT_EDGE_TTS_SCRIPT;
const LOCAL_VOICE = process.env.TTS_VOICE || ttsEnv.TTS_VOICE || 'Milena';
const OPENAI_VOICE =
  process.env.TTS_VOICE_OPENAI || ttsEnv.TTS_VOICE_OPENAI || 'nova';
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || ttsEnv.OPENAI_API_KEY || '';
const AZURE_SPEECH_KEY =
  process.env.AZURE_SPEECH_KEY || ttsEnv.AZURE_SPEECH_KEY || '';
const AZURE_SPEECH_REGION =
  process.env.AZURE_SPEECH_REGION || ttsEnv.AZURE_SPEECH_REGION || '';
const CONFIGURED_AZURE_TTS_VOICE =
  process.env.AZURE_TTS_VOICE || ttsEnv.AZURE_TTS_VOICE || '';
const AZURE_TTS_OUTPUT_FORMAT =
  process.env.AZURE_TTS_OUTPUT_FORMAT ||
  ttsEnv.AZURE_TTS_OUTPUT_FORMAT ||
  'ogg-24khz-16bit-mono-opus';
const SAY_BIN = process.env.SAY_BIN || ttsEnv.SAY_BIN || '/usr/bin/say';
const RHVOICE_BIN =
  process.env.RHVOICE_BIN || ttsEnv.RHVOICE_BIN || '/usr/bin/RHVoice-test';
const RHVOICE_VOICE =
  process.env.RHVOICE_VOICE || ttsEnv.RHVOICE_VOICE || 'Aleksandr';
const RHVOICE_QUALITY =
  process.env.RHVOICE_QUALITY || ttsEnv.RHVOICE_QUALITY || '';
const RHVOICE_VOLUME =
  process.env.RHVOICE_VOLUME || ttsEnv.RHVOICE_VOLUME || '';
const RHVOICE_RATE = process.env.RHVOICE_RATE || ttsEnv.RHVOICE_RATE || '';
const RHVOICE_PITCH = process.env.RHVOICE_PITCH || ttsEnv.RHVOICE_PITCH || '';
const RHVOICE_SAMPLE_RATE =
  process.env.RHVOICE_SAMPLE_RATE || ttsEnv.RHVOICE_SAMPLE_RATE || '';
const ESPEAK_NG_BIN =
  process.env.ESPEAK_NG_BIN || ttsEnv.ESPEAK_NG_BIN || '/usr/bin/espeak-ng';
const ESPEAK_NG_VOICE =
  process.env.ESPEAK_NG_VOICE || ttsEnv.ESPEAK_NG_VOICE || 'ru';
const FFMPEG_BIN =
  process.env.FFMPEG_BIN ||
  ttsEnv.FFMPEG_BIN ||
  resolveBinary('ffmpeg', FFMPEG_FALLBACKS);
const TTS_OPUS_BITRATE =
  process.env.TTS_OPUS_BITRATE || ttsEnv.TTS_OPUS_BITRATE || '32k';
const TTS_FFMPEG_LOUDNORM =
  (process.env.TTS_FFMPEG_LOUDNORM || ttsEnv.TTS_FFMPEG_LOUDNORM || '')
    .toLowerCase()
    .trim() === 'true';

const MAX_CHUNK = 3000;
const TTS_HTTP_TIMEOUT_MS = 60_000;
const MAX_TTS_RESPONSE_BYTES = 16 * 1024 * 1024;
const AZURE_ALLOWED_REGION = /^[a-z0-9-]+$/i;
const AZURE_REQUIRED_OUTPUT = /^ogg-\d+khz-16bit-mono-opus$/;

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

export function telegramVoiceOggFfmpegArgs(
  inputAudio: string,
  outOgg: string,
  options: {
    bitrate?: string;
    loudnorm?: boolean;
  } = {},
): string[] {
  const args = [
    '-y',
    '-i',
    inputAudio,
  ];
  if (options.loudnorm) {
    args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
  }
  args.push(
    '-c:a',
    'libopus',
    '-b:a',
    options.bitrate || '32k',
    '-ar',
    '48000',
    '-ac',
    '1',
    '-loglevel',
    'error',
    outOgg,
  );
  return args;
}

export function rhvoiceArgs(
  inputText: string,
  outWav: string,
  voice: string,
  options: {
    quality?: string;
    volume?: string;
    rate?: string;
    pitch?: string;
    sampleRate?: string;
  } = {},
): string[] {
  const args = ['-p', voice];
  if (options.quality) args.push('-q', options.quality);
  if (options.volume) args.push('-v', options.volume);
  if (options.rate) args.push('-r', options.rate);
  if (options.pitch) args.push('-t', options.pitch);
  if (options.sampleRate) args.push('-R', options.sampleRate);
  args.push('-i', inputText, '-o', outWav);
  return args;
}

export function espeakNgArgs(
  text: string,
  outWav: string,
  voice: string,
): string[] {
  return ['-v', voice, '-w', outWav, text];
}

async function convertAudioToTelegramOgg(
  inputAudio: string,
  outOgg: string,
): Promise<void> {
  await execFileAsync(
    FFMPEG_BIN,
    telegramVoiceOggFfmpegArgs(inputAudio, outOgg, {
      bitrate: TTS_OPUS_BITRATE,
      loudnorm: TTS_FFMPEG_LOUDNORM,
    }),
  );
}

async function synthMacSay(text: string, outOgg: string): Promise<void> {
  const aiff = outOgg.replace(/\.ogg$/, '.aiff');
  await execFileAsync(SAY_BIN, ['-v', LOCAL_VOICE, '-o', aiff, text]);
  try {
    await convertAudioToTelegramOgg(aiff, outOgg);
  } finally {
    fs.unlink(aiff, () => undefined);
  }
}

async function synthRhvoice(text: string, outOgg: string): Promise<void> {
  const base = outOgg.replace(/\.ogg$/, '');
  const inputText = `${base}.txt`;
  const wav = `${base}.wav`;
  fs.writeFileSync(inputText, text, 'utf-8');
  try {
    await execFileAsync(
      RHVOICE_BIN,
      rhvoiceArgs(inputText, wav, RHVOICE_VOICE, {
        quality: RHVOICE_QUALITY,
        volume: RHVOICE_VOLUME,
        rate: RHVOICE_RATE,
        pitch: RHVOICE_PITCH,
        sampleRate: RHVOICE_SAMPLE_RATE,
      }),
    );
    await convertAudioToTelegramOgg(wav, outOgg);
  } finally {
    fs.unlink(inputText, () => undefined);
    fs.unlink(wav, () => undefined);
  }
}

async function synthEspeakNg(text: string, outOgg: string): Promise<void> {
  const wav = outOgg.replace(/\.ogg$/, '.wav');
  try {
    await execFileAsync(
      ESPEAK_NG_BIN,
      espeakNgArgs(text, wav, ESPEAK_NG_VOICE),
    );
    await convertAudioToTelegramOgg(wav, outOgg);
  } finally {
    fs.unlink(wav, () => undefined);
  }
}

async function synthLocal(text: string, outOgg: string): Promise<void> {
  if (process.platform === 'darwin') {
    await synthMacSay(text, outOgg);
    return;
  }
  try {
    await synthRhvoice(text, outOgg);
  } catch (err) {
    logger.warn(
      { err, fallback: 'espeak-ng' },
      'Local RHVoice TTS failed; trying espeak-ng fallback',
    );
    await synthEspeakNg(text, outOgg);
  }
}

export function postHttpsBuffer(input: {
  options: https.RequestOptions;
  body: string | Buffer;
  label: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  request?: typeof https.request;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(1, input.timeoutMs ?? TTS_HTTP_TIMEOUT_MS);
    const maxResponseBytes = Math.max(
      1,
      input.maxResponseBytes ?? MAX_TTS_RESPONSE_BYTES,
    );
    let settled = false;
    let response: import('http').IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requestImpl = input.request ?? https.request;
    const req = requestImpl(input.options, (res) => {
      response = res;
      const chunks: Buffer[] = [];
      let bytes = 0;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        res.destroy();
        req.destroy();
        reject(err);
      };
      res.on('error', fail);
      res.on('aborted', () =>
        fail(new Error(`${input.label} response aborted`)),
      );
      res.on('close', () => {
        if (!settled) fail(new Error(`${input.label} response closed early`));
      });
      res.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxResponseBytes) {
          fail(
            new Error(
              `${input.label} response exceeds ${maxResponseBytes} bytes`,
            ),
          );
          return;
        }
        chunks.push(buffer);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const buf = Buffer.concat(chunks, bytes);
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(buf);
        } else {
          reject(
            new Error(
              `${input.label} HTTP ${res.statusCode}: ${buf.toString('utf-8').slice(0, 300)}`,
            ),
          );
        }
      });
    });
    const failRequest = (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      response?.destroy();
      reject(err);
    };
    req.on('error', failRequest);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`${input.label} request timed out`));
    });
    timer = setTimeout(() => {
      req.destroy(new Error(`${input.label} request deadline exceeded`));
    }, timeoutMs);
    timer.unref?.();
    req.end(input.body);
  });
}

function postOpenAI(payload: object, apiKey: string): Promise<Buffer> {
  const body = JSON.stringify(payload);
  return postHttpsBuffer({
    label: 'OpenAI TTS',
    body,
    options: {
      method: 'POST',
      hostname: 'api.openai.com',
      path: '/v1/audio/speech',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
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

export function escapeSsmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function localeFromAzureVoiceName(voice: string): string {
  const match = voice.match(/^([a-z]{2}-[A-Z]{2})[-:]/);
  return match?.[1] || 'ru-RU';
}

export function buildAzureSsml(text: string, voice: string): string {
  const locale = localeFromAzureVoiceName(voice);
  return [
    `<speak version="1.0" xml:lang="${locale}">`,
    `<voice xml:lang="${locale}" name="${escapeSsmlText(voice)}">`,
    escapeSsmlText(text),
    '</voice>',
    '</speak>',
  ].join('');
}

export function validateAzureSpeechConfig(input: {
  key: string;
  region: string;
  outputFormat: string;
}): void {
  if (!input.key) {
    throw new Error(
      'AZURE_SPEECH_KEY is not set — cannot use TTS_PROVIDER=azure',
    );
  }
  if (!input.region) {
    throw new Error(
      'AZURE_SPEECH_REGION is not set — cannot use TTS_PROVIDER=azure',
    );
  }
  if (!AZURE_ALLOWED_REGION.test(input.region)) {
    throw new Error('AZURE_SPEECH_REGION contains invalid characters');
  }
  if (!AZURE_REQUIRED_OUTPUT.test(input.outputFormat)) {
    throw new Error(
      'AZURE_TTS_OUTPUT_FORMAT must be an OGG Opus format for Telegram voice notes',
    );
  }
}

function postAzureSpeech(input: {
  ssml: string;
  key: string;
  region: string;
  outputFormat: string;
}): Promise<Buffer> {
  const body = Buffer.from(input.ssml, 'utf-8');
  return postHttpsBuffer({
    label: 'Azure Speech TTS',
    body,
    options: {
      method: 'POST',
      hostname: `${input.region}.tts.speech.microsoft.com`,
      path: '/cognitiveservices/v1',
      headers: {
        'Ocp-Apim-Subscription-Key': input.key,
        'Content-Type': 'application/ssml+xml',
        'Content-Length': body.length,
        'X-Microsoft-OutputFormat': input.outputFormat,
        'User-Agent': 'Skoobi',
      },
    },
  });
}

async function synthAzure(text: string, outOgg: string): Promise<void> {
  validateAzureSpeechConfig({
    key: AZURE_SPEECH_KEY,
    region: AZURE_SPEECH_REGION,
    outputFormat: AZURE_TTS_OUTPUT_FORMAT,
  });
  const buf = await postAzureSpeech({
    ssml: buildAzureSsml(text, azureTtsVoice()),
    key: AZURE_SPEECH_KEY,
    region: AZURE_SPEECH_REGION,
    outputFormat: AZURE_TTS_OUTPUT_FORMAT,
  });
  fs.writeFileSync(outOgg, buf);
}

async function synthEdge(text: string, outOgg: string): Promise<void> {
  const basename = path.basename(outOgg, '.ogg');
  const result = await synthesizeEdgeVoice(text, {
    voiceNote: true,
    outputDir: path.dirname(outOgg),
    basename,
    ffmpegBin: FFMPEG_BIN,
    edgeTtsBin: EDGE_TTS_BIN,
    edgeTtsScript: EDGE_TTS_SCRIPT,
  });
  if (result.filePath !== outOgg) {
    fs.renameSync(result.filePath, outOgg);
  }
}

/** AZURE_TTS_VOICE, else the Azure voice of the instance profile. */
function azureTtsVoice(): string {
  return CONFIGURED_AZURE_TTS_VOICE || instanceProfile().voice.azureVoice;
}

/**
 * True for the Edge voice provider: «edge», or another name this installation
 * gives it in TTS_PROVIDER (voice.edgeProviderAliases of the instance
 * profile). `provider` is in lower case.
 */
function isEdgeProvider(provider: string): boolean {
  return (
    provider === 'edge' ||
    instanceProfile().voice.edgeProviderAliases.includes(provider)
  );
}

export function ttsFallbackProvider(provider: string): 'local' | null {
  const normalized = provider.toLowerCase();
  if (isEdgeProvider(normalized)) return 'local';
  return null;
}

async function synthConfiguredProvider(
  provider: string,
  text: string,
  outOgg: string,
): Promise<void> {
  if (provider === 'openai') {
    await synthOpenAI(text, outOgg);
  } else if (provider === 'azure') {
    await synthAzure(text, outOgg);
  } else if (isEdgeProvider(provider)) {
    await synthEdge(text, outOgg);
  } else if (provider === 'rhvoice') {
    await synthRhvoice(text, outOgg);
  } else if (provider === 'espeak' || provider === 'espeak-ng') {
    await synthEspeakNg(text, outOgg);
  } else {
    await synthLocal(text, outOgg);
  }
}

async function synthChunk(text: string, outOgg: string): Promise<void> {
  try {
    await synthConfiguredProvider(PROVIDER, text, outOgg);
  } catch (err) {
    const fallback = ttsFallbackProvider(PROVIDER);
    if (!fallback) throw err;
    logger.warn(
      { provider: PROVIDER, fallback, err },
      'Primary TTS failed; trying local fallback',
    );
    await synthLocal(text, outOgg);
  }
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

  try {
    for (let i = 0; i < chunks.length; i++) {
      const out = path.join(tmpDir, `chunk-${i}.ogg`);
      try {
        await synthChunk(chunks[i], out);
        files.push(out);
      } catch (err) {
        logger.error(
          { provider: PROVIDER, chunk: i, err },
          'TTS synthesis failed',
        );
        throw err;
      }
    }
  } catch (err) {
    // On any synthesis failure we throw before returning the SynthResult that
    // owns cleanup(), so the caller can never remove tmpDir. Clean it up here
    // (along with any partial chunk-N.ogg files) to avoid leaking a temp dir
    // under os.tmpdir() on every failed TTS attempt (finding #77).
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw err;
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
  if (PROVIDER === 'openai') return OPENAI_VOICE;
  if (PROVIDER === 'azure') return azureTtsVoice();
  if (isEdgeProvider(PROVIDER)) return edgeVoiceName();
  if (PROVIDER === 'rhvoice') return RHVOICE_VOICE;
  if (PROVIDER === 'espeak' || PROVIDER === 'espeak-ng') return ESPEAK_NG_VOICE;
  if (process.platform !== 'darwin') return RHVOICE_VOICE;
  return LOCAL_VOICE;
}

export interface ReusableVoiceResult {
  /** WAV/MP3 are editing derivatives of the generated OGG, not lossless masters. */
  parts: Array<{ogg:string;mp3:string;wav:string}>;
  configuredProvider: string;
  configuredVoice: string;
  cleanup:()=>void;
}

/** No delivery here. Caller persists the files before invoking cleanup. */
export async function synthesizeReusableVoice(text:string, dependencies: {
  synthesize?:(text:string)=>Promise<SynthResult>;
  convert?:(input:string,output:string,format:'mp3'|'wav')=>Promise<void>;
}={}):Promise<ReusableVoiceResult> {
  if(!text.trim()||text.length>12_000)throw new Error('invalid_voice_text');
  const source=await (dependencies.synthesize??synthesizeVoice)(text);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'skoobi-voice-export-'));
  const cleanup=()=>{source.cleanup();fs.rmSync(root,{recursive:true,force:true});};
  try {
    const parts:ReusableVoiceResult['parts']=[];
    for(const [index,ogg] of source.files.entries()){
      const part={ogg,mp3:path.join(root,`part-${index+1}.mp3`),wav:path.join(root,`part-${index+1}.wav`)};
      for(const format of ['mp3','wav'] as const){
        if(dependencies.convert) await dependencies.convert(ogg,part[format],format);
        else await execFileAsync(FFMPEG_BIN,['-nostdin','-y','-protocol_whitelist','file','-f','ogg','-i',ogg,'-vn',
          '-c:a',format==='mp3'?'libmp3lame':'pcm_s16le','-ar','48000','-ac','1','-loglevel','error',part[format]],{timeout:60_000,maxBuffer:256*1024});
      }
      parts.push(part);
    }
    if(!parts.length||parts.length>8)throw new Error('invalid_voice_parts');
    return {parts,configuredProvider:ttsProvider(),configuredVoice:ttsVoiceName(),cleanup};
  }catch(error){cleanup();throw error;}
}
