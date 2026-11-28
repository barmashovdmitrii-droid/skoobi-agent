import { EventEmitter } from 'events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resetInstanceProfileForTests,
  setInstanceProfileForTests,
} from '@skoobi/shared/instance-profile';

import {
  buildAzureSsml,
  espeakNgArgs,
  escapeSsmlText,
  localeFromAzureVoiceName,
  postHttpsBuffer,
  rhvoiceArgs,
  telegramVoiceOggFfmpegArgs,
  ttsFallbackProvider,
  validateAzureSpeechConfig,
} from './tts.js';
import {
  EDGE_VOICE_LANG,
  EDGE_VOICE_ATTEMPTS,
  EDGE_VOICE_MAX_TIMEOUT_MS,
  EDGE_VOICE_OUTPUT_FORMAT,
  EDGE_VOICE_PITCH,
  EDGE_VOICE_RATE,
  EDGE_VOICE_TIMEOUT_MS,
  edgeVoiceCliArgs,
  edgeVoiceName,
  edgeVoiceTimeoutMs,
  edgeVoiceTtsConfig,
  sanitizeEdgeVoiceText,
  telegramVoiceFfmpegArgs,
} from './edgeVoice.js';

// Synthetic values of the shape the instance profile accepts.
const NEUTRAL_VOICE = 'ru-RU-SvetlanaNeural';
const PROFILE_VOICE = 'en-US-FixtureNeural';

function fakeHttpsExchange() {
  type ResponseCallback = (response: any) => void;
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number;
    destroyed: boolean;
    destroy: () => void;
  };
  response.statusCode = 200;
  response.destroyed = false;
  response.destroy = () => {
    response.destroyed = true;
  };
  const request = new EventEmitter() as EventEmitter & {
    destroyed: boolean;
    callback?: ResponseCallback;
    setTimeout: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: (err?: Error) => void;
  };
  request.destroyed = false;
  request.callback = undefined;
  request.setTimeout = vi.fn();
  request.end = vi.fn();
  request.destroy = (err?: Error) => {
    request.destroyed = true;
    if (err) queueMicrotask(() => request.emit('error', err));
  };
  const requestImpl = vi.fn((_options: unknown, callback: ResponseCallback) => {
    request.callback = callback;
    return request;
  });
  return { response, request, requestImpl };
}

describe('bounded TTS HTTPS transport', () => {
  it('resolves a normal response and preserves its exact bytes', async () => {
    const fake = fakeHttpsExchange();
    const pending = postHttpsBuffer({
      label: 'test TTS',
      body: 'request',
      options: {},
      request: fake.requestImpl as any,
      timeoutMs: 1000,
      maxResponseBytes: 16,
    });
    fake.request.callback!(fake.response);
    fake.response.emit('data', Buffer.from('voice'));
    fake.response.emit('end');
    await expect(pending).resolves.toEqual(Buffer.from('voice'));
  });

  it('rejects and destroys the exchange on response error or byte overflow', async () => {
    const errored = fakeHttpsExchange();
    const errorPending = postHttpsBuffer({
      label: 'test TTS',
      body: 'request',
      options: {},
      request: errored.requestImpl as any,
      timeoutMs: 1000,
    });
    errored.request.callback!(errored.response);
    errored.response.emit('error', new Error('stream reset'));
    await expect(errorPending).rejects.toThrow('stream reset');
    expect(errored.request.destroyed).toBe(true);
    expect(errored.response.destroyed).toBe(true);

    const oversized = fakeHttpsExchange();
    const oversizedPending = postHttpsBuffer({
      label: 'test TTS',
      body: 'request',
      options: {},
      request: oversized.requestImpl as any,
      timeoutMs: 1000,
      maxResponseBytes: 4,
    });
    oversized.request.callback!(oversized.response);
    oversized.response.emit('data', Buffer.from('12345'));
    await expect(oversizedPending).rejects.toThrow('exceeds 4 bytes');
    expect(oversized.request.destroyed).toBe(true);
  });

  it('has an overall deadline even when the socket never emits an event', async () => {
    const fake = fakeHttpsExchange();
    await expect(
      postHttpsBuffer({
        label: 'test TTS',
        body: 'request',
        options: {},
        request: fake.requestImpl as any,
        timeoutMs: 5,
      }),
    ).rejects.toThrow('deadline exceeded');
    expect(fake.request.destroyed).toBe(true);
  });
});

describe('Azure TTS helpers', () => {
  it('escapes user text before placing it in SSML', () => {
    expect(escapeSsmlText(`5 < 7 & "да" 'ok'`)).toBe(
      '5 &lt; 7 &amp; &quot;да&quot; &apos;ok&apos;',
    );
  });

  it('builds SSML for a Russian Azure neural voice', () => {
    const ssml = buildAzureSsml('Привет <секрет>', NEUTRAL_VOICE);
    expect(ssml).toContain('xml:lang="ru-RU"');
    expect(ssml).toContain(`name="${NEUTRAL_VOICE}"`);
    expect(ssml).toContain('Привет &lt;секрет&gt;');
  });

  it('extracts locale from standard and HD Azure voice names', () => {
    expect(localeFromAzureVoiceName(NEUTRAL_VOICE)).toBe('ru-RU');
    expect(localeFromAzureVoiceName('en-US-Ava:DragonHDLatestNeural')).toBe(
      'en-US',
    );
  });

  it('requires key, region, and Telegram-compatible OGG Opus output', () => {
    expect(() =>
      validateAzureSpeechConfig({
        key: '',
        region: 'westeurope',
        outputFormat: 'ogg-24khz-16bit-mono-opus',
      }),
    ).toThrow('AZURE_SPEECH_KEY');
    expect(() =>
      validateAzureSpeechConfig({
        key: 'secret',
        region: '../bad',
        outputFormat: 'ogg-24khz-16bit-mono-opus',
      }),
    ).toThrow('AZURE_SPEECH_REGION');
    expect(() =>
      validateAzureSpeechConfig({
        key: 'secret',
        region: 'westeurope',
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      }),
    ).toThrow('OGG Opus');
  });
});

describe('Edge TTS helpers', () => {
  afterEach(() => resetInstanceProfileForTests());

  it('falls back to local synthesis when Edge TTS is unavailable', () => {
    expect(ttsFallbackProvider('edge')).toBe('local');
    expect(ttsFallbackProvider('azure')).toBeNull();
    expect(ttsFallbackProvider('openai')).toBeNull();
  });

  it('treats a provider name of the instance profile as the Edge voice', () => {
    // Without a profile only the built-in name means Edge.
    expect(ttsFallbackProvider('edge-fixture')).toBeNull();

    setInstanceProfileForTests({
      voice: { edgeProviderAliases: ['edge-fixture'] },
    });
    expect(ttsFallbackProvider('edge-fixture')).toBe('local');
    expect(ttsFallbackProvider('EDGE-FIXTURE')).toBe('local');
    expect(ttsFallbackProvider('edge')).toBe('local');
    expect(ttsFallbackProvider('edge-other')).toBeNull();
    expect(ttsFallbackProvider('azure')).toBeNull();
  });

  it('uses the Microsoft Edge voice config with the neutral default voice', () => {
    expect(EDGE_VOICE_ATTEMPTS).toBe(2);
    expect(edgeVoiceName()).toBe(NEUTRAL_VOICE);
    expect(edgeVoiceTtsConfig()).toEqual({
      voice: NEUTRAL_VOICE,
      lang: EDGE_VOICE_LANG,
      outputFormat: EDGE_VOICE_OUTPUT_FORMAT,
      rate: EDGE_VOICE_RATE,
      pitch: EDGE_VOICE_PITCH,
      timeout: EDGE_VOICE_TIMEOUT_MS,
    });
  });

  it('speaks with the Edge voice the instance profile names', () => {
    setInstanceProfileForTests({ voice: { edgeVoice: PROFILE_VOICE } });

    expect(edgeVoiceName()).toBe(PROFILE_VOICE);
    expect(edgeVoiceTtsConfig().voice).toBe(PROFILE_VOICE);
    const args = edgeVoiceCliArgs(
      '/tmp/reply.txt',
      '/tmp/reply.mp3',
      '/app/scripts/edge-tts-adapter.py',
    );
    expect(args.slice(1, 3)).toEqual(['--voice', PROFILE_VOICE]);
  });

  it('allows enough synthesis time for long voice replies', () => {
    expect(edgeVoiceTimeoutMs('Короткий ответ')).toBe(EDGE_VOICE_TIMEOUT_MS);
    expect(edgeVoiceTimeoutMs('а'.repeat(1300))).toBe(160_000);
    expect(edgeVoiceTimeoutMs('а'.repeat(5000))).toBe(
      EDGE_VOICE_MAX_TIMEOUT_MS,
    );
  });

  it('builds current edge-tts CLI args without exposing message text', () => {
    expect(
      edgeVoiceCliArgs(
        '/tmp/reply.txt',
        '/tmp/reply.mp3',
        '/app/scripts/edge-tts-adapter.py',
      ),
    ).toEqual([
      '/app/scripts/edge-tts-adapter.py',
      '--voice',
      NEUTRAL_VOICE,
      `--rate=${EDGE_VOICE_RATE}`,
      `--pitch=${EDGE_VOICE_PITCH}`,
      '--file',
      '/tmp/reply.txt',
      '--write-media',
      '/tmp/reply.mp3',
    ]);
  });

  it('normalizes and truncates long text before synthesis', () => {
    const long = `  Привет\n\n${'а'.repeat(5000)}  `;
    const clean = sanitizeEdgeVoiceText(long);
    expect(clean).toHaveLength(4000);
    expect(clean.startsWith('Привет ааа')).toBe(true);
    expect(clean.endsWith(' ')).toBe(false);
  });

  it('builds Telegram voice-note ffmpeg conversion args', () => {
    expect(telegramVoiceFfmpegArgs('input.mp3', 'output.ogg')).toEqual([
      '-y',
      '-i',
      'input.mp3',
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
      'output.ogg',
    ]);
  });
});

describe('Linux local TTS helpers', () => {
  it('builds RHVoice file-based synthesis args', () => {
    expect(rhvoiceArgs('input.txt', 'output.wav', 'Aleksandr')).toEqual([
      '-p',
      'Aleksandr',
      '-i',
      'input.txt',
      '-o',
      'output.wav',
    ]);
  });

  it('builds tuned RHVoice synthesis args', () => {
    expect(
      rhvoiceArgs('input.txt', 'output.wav', 'aleksandr-hq', {
        quality: 'max',
        volume: '120',
        rate: '95',
        pitch: '100',
        sampleRate: '48000',
      }),
    ).toEqual([
      '-p',
      'aleksandr-hq',
      '-q',
      'max',
      '-v',
      '120',
      '-r',
      '95',
      '-t',
      '100',
      '-R',
      '48000',
      '-i',
      'input.txt',
      '-o',
      'output.wav',
    ]);
  });

  it('builds espeak-ng synthesis args', () => {
    expect(espeakNgArgs('Привет', 'output.wav', 'ru')).toEqual([
      '-v',
      'ru',
      '-w',
      'output.wav',
      'Привет',
    ]);
  });

  it('builds Telegram-compatible OGG Opus conversion args', () => {
    expect(telegramVoiceOggFfmpegArgs('input.wav', 'output.ogg')).toEqual([
      '-y',
      '-i',
      'input.wav',
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
      'output.ogg',
    ]);
  });

  it('builds tuned Telegram-compatible OGG Opus conversion args', () => {
    expect(
      telegramVoiceOggFfmpegArgs('input.wav', 'output.ogg', {
        bitrate: '48k',
        loudnorm: true,
      }),
    ).toEqual([
      '-y',
      '-i',
      'input.wav',
      '-af',
      'loudnorm=I=-16:TP=-1.5:LRA=11',
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
      'output.ogg',
    ]);
  });
});
