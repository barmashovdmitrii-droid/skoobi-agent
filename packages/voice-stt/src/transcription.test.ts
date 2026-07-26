import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const sharedMocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  resolveBinary: vi.fn(
    (_binary: string, fallbacks: readonly string[]) => fallbacks[0] || '',
  ),
  updateMediaEntry: vi.fn(),
}));

vi.mock('@skoobi/shared', () => ({
  basenameOnly: (value: string) => value.split('/').at(-1) || '',
  FFMPEG_FALLBACKS: ['/opt/example/bin/ffmpeg'],
  folderAbsFromMediaPath: () => null,
  logger: sharedMocks.logger,
  readEnvFile: () => ({}),
  resolveBinary: sharedMocks.resolveBinary,
  updateMediaEntry: sharedMocks.updateMediaEntry,
  WHISPER_FALLBACKS: ['/opt/example/bin/whisper-cli'],
}));

import {
  buildWhisperArgs,
  candidateFromWhisperOutput,
  createSerializedLocalTranscriber,
  parseAutoLanguageProbability,
  parseWhisperJson,
  retryReasonForAutoCandidate,
  resolveLocalTranscriptionConfig,
  selectBestCandidate,
  validateTranscript,
  type LocalExecFile,
  type LocalTranscriptionConfig,
  type WhisperCandidate,
} from './transcription.js';

const rootsToRemove = new Set<string>();

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    [...rootsToRemove].map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
  rootsToRemove.clear();
});

function config(
  overrides: Partial<LocalTranscriptionConfig> = {},
): LocalTranscriptionConfig {
  return {
    whisperBin: '/local/bin/whisper-cli',
    whisperModel: '/local/models/ggml-large-v3.bin',
    whisperLang: 'auto',
    whisperNoGpu: false,
    whisperThreads: '6',
    whisperTimeoutMs: 12_345,
    accuracyMode: 'max',
    retryLanguageProbability: 0.9,
    retryMeanTokenLogProbability: -0.15,
    initialPrompt: '',
    promptFile: '',
    ffmpegBin: '/local/bin/ffmpeg',
    ...overrides,
  };
}

function whisperJson(
  text: string,
  language: string,
  probabilities: number[] = [0.98, 0.96],
): string {
  return JSON.stringify({
    result: { language },
    transcription: [
      {
        text,
        tokens: probabilities.map((p, index) => ({
          text: ` token${index}`,
          p,
        })),
      },
    ],
  });
}

async function writeWav(file: string, seconds = 1): Promise<void> {
  const dataBytes = Math.round(32_000 * seconds);
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  await fs.writeFile(file, wav);
}

async function sourceFile(name = 'voice.ogg'): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'voice-stt-test-source-'));
  rootsToRemove.add(root);
  const source = join(root, name);
  await fs.writeFile(source, 'local test audio');
  return source;
}

interface PassOutput {
  text: string;
  language?: string;
  languageProbability?: number;
  tokenProbabilities?: number[];
  invalidJson?: boolean;
}

function localExecForPasses(
  passes: Record<string, PassOutput>,
  capturedPrivateDirs: string[] = [],
): ReturnType<typeof vi.fn<LocalExecFile>> {
  return vi.fn<LocalExecFile>(async (executable, args) => {
    if (executable === '/local/bin/ffmpeg') {
      await writeWav(args.at(-1) as string);
      return { stdout: '', stderr: '' };
    }
    expect(executable).toBe('/local/bin/whisper-cli');
    const language = args[args.indexOf('-l') + 1];
    const outputPrefix = args[args.indexOf('-of') + 1];
    capturedPrivateDirs.push(dirname(outputPrefix));
    const output = passes[language];
    if (!output)
      throw Object.assign(new Error('unexpected local pass'), {
        code: 'ENOENT',
      });
    await fs.writeFile(
      `${outputPrefix}.json`,
      output.invalidJson
        ? '{invalid'
        : whisperJson(
            output.text,
            output.language || language,
            output.tokenProbabilities,
          ),
      'utf8',
    );
    const stderr =
      language === 'auto' && output.languageProbability !== undefined
        ? `whisper_full_with_state: auto-detected language: ${output.language || 'ru'} (p = ${output.languageProbability})`
        : '';
    return { stdout: 'must not be parsed as transcript', stderr };
  });
}

function candidate(
  requestedLanguage: string,
  meanTokenLogProbability: number | null,
  overrides: Partial<WhisperCandidate> = {},
): WhisperCandidate {
  return {
    requestedLanguage,
    detectedLanguage: requestedLanguage === 'auto' ? 'ru' : requestedLanguage,
    languageProbability: requestedLanguage === 'auto' ? 0.95 : null,
    meanTokenLogProbability,
    transcript: `${requestedLanguage} text`,
    valid: true,
    invalidReason: null,
    ...overrides,
  };
}

describe('whisper-cli arguments and structured output', () => {
  it('defaults to explicit auto/max and the documented real-signal thresholds', () => {
    for (const name of [
      'WHISPER_LANG',
      'WHISPER_ACCURACY_MODE',
      'WHISPER_RETRY_LANGUAGE_PROB',
      'WHISPER_RETRY_MEAN_LOGPROB',
    ]) {
      vi.stubEnv(name, '');
    }

    expect(resolveLocalTranscriptionConfig()).toEqual(
      expect.objectContaining({
        whisperLang: 'auto',
        accuracyMode: 'max',
        retryLanguageProbability: 0.9,
        retryMeanTokenLogProbability: -0.15,
      }),
    );
  });

  it.each(['auto', 'ru', 'kk'])(
    'builds full local JSON output arguments for %s',
    (language) => {
      const args = buildWhisperArgs({
        model: '/models/model.bin',
        audioPath: '/private/audio.wav',
        outputPrefix: '/private/pass',
        language,
        threads: '8',
        noGpu: true,
        initialPrompt: 'Скуби; Актау',
      });

      expect(args).toEqual([
        '-m',
        '/models/model.bin',
        '-f',
        '/private/audio.wav',
        '-l',
        language,
        '-nt',
        '-ojf',
        '-of',
        '/private/pass',
        '-t',
        '8',
        '--no-gpu',
        '--prompt',
        'Скуби; Актау',
      ]);
      expect(args.join(' ')).not.toMatch(/https?:|curl|fetch|openai/i);
    },
  );

  it('parses detected-language p and computes mean token log probability', () => {
    const parsed = parseWhisperJson(
      whisperJson(' Привет, Скуби. ', 'ru', [0.5, 0.25]),
    );
    const detected = parseAutoLanguageProbability(
      'whisper_full_with_state: auto-detected language: ru (p = 0.9375)',
    );

    expect(parsed?.transcript).toBe('Привет, Скуби.');
    expect(parsed?.detectedLanguage).toBe('ru');
    expect(parsed?.meanTokenLogProbability).toBeCloseTo(
      (Math.log(0.5) + Math.log(0.25)) / 2,
    );
    expect(detected).toEqual({ language: 'ru', probability: 0.9375 });
  });

  it('ignores control tokens but retains a lexical zero probability', () => {
    const json = JSON.stringify({
      result: { language: 'kk' },
      transcription: [
        {
          text: 'Сәлем',
          tokens: [
            { text: '<|startoftranscript|>', p: 0 },
            { text: '[_EOT_]', p: 0 },
            { text: ' Сәлем', p: 0 },
          ],
        },
      ],
    });

    expect(parseWhisperJson(json)?.meanTokenLogProbability).toBeCloseTo(
      Math.log(1e-12),
    );
  });

  it('omits malformed thread values instead of passing them to whisper-cli', () => {
    const args = buildWhisperArgs({
      model: '/models/model.bin',
      audioPath: '/private/audio.wav',
      outputPrefix: '/private/pass',
      language: 'auto',
      threads: '8oops',
    });

    expect(args).not.toContain('-t');
    expect(args).not.toContain('8oops');
  });
});

describe('max-accuracy retry and candidate selection', () => {
  it('does not retry a healthy, confident auto result in Russian', async () => {
    const execLocal = localExecForPasses({
      auto: {
        text: 'Привет, Скуби.',
        language: 'ru',
        languageProbability: 0.97,
        tokenProbabilities: [0.99, 0.98],
      },
    });
    const transcribe = createSerializedLocalTranscriber(
      () => config(),
      execLocal,
    );

    await expect(transcribe(await sourceFile())).resolves.toBe(
      'Привет, Скуби.',
    );
    expect(
      execLocal.mock.calls.filter(([executable]) =>
        executable.includes('whisper'),
      ),
    ).toHaveLength(1);
  });

  it('does not force ru/kk over a healthy confidently detected other language', async () => {
    const execLocal = localExecForPasses({
      auto: {
        text: 'A healthy English sentence.',
        language: 'en',
        languageProbability: 0.99,
        tokenProbabilities: [0.99, 0.97],
      },
    });
    const transcribe = createSerializedLocalTranscriber(
      () => config(),
      execLocal,
    );

    await expect(transcribe(await sourceFile())).resolves.toBe(
      'A healthy English sentence.',
    );
    const whisperLanguages = execLocal.mock.calls
      .filter(([executable]) => executable.includes('whisper'))
      .map(([, args]) => args[args.indexOf('-l') + 1]);
    expect(whisperLanguages).toEqual(['auto']);
  });

  it('keeps a healthy detected other language when a compatible CLI omits p', async () => {
    const execLocal = localExecForPasses({
      auto: {
        text: 'Eine gesunde deutsche Aufnahme.',
        language: 'de',
        tokenProbabilities: [0.99, 0.97],
      },
    });
    const transcribe = createSerializedLocalTranscriber(
      () => config(),
      execLocal,
    );

    await expect(transcribe(await sourceFile())).resolves.toBe(
      'Eine gesunde deutsche Aufnahme.',
    );
    expect(
      execLocal.mock.calls.filter(([executable]) =>
        executable.includes('whisper'),
      ),
    ).toHaveLength(1);
  });

  it('runs uncertain auto, ru and kk sequentially and selects measured quality', async () => {
    const execLocal = localExecForPasses({
      auto: {
        text: 'uncertain auto',
        language: 'ru',
        languageProbability: 0.6,
        tokenProbabilities: [0.75],
      },
      ru: { text: 'русский вариант', tokenProbabilities: [0.8] },
      kk: { text: 'қазақша дұрыс нұсқа', tokenProbabilities: [0.98] },
    });
    const transcribe = createSerializedLocalTranscriber(
      () => config(),
      execLocal,
    );

    await expect(transcribe(await sourceFile())).resolves.toBe(
      'қазақша дұрыс нұсқа',
    );
    const whisperLanguages = execLocal.mock.calls
      .filter(([executable]) => executable.includes('whisper'))
      .map(([, args]) => args[args.indexOf('-l') + 1]);
    expect(whisperLanguages).toEqual(['auto', 'ru', 'kk']);
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        passCount: 3,
        retryReason: 'low_language_probability',
        selectedLanguage: 'kk',
      }),
      expect.any(String),
    );
  });

  it('keeps a usable candidate and continues when one optional retry fails', async () => {
    const passes = localExecForPasses({
      auto: {
        text: 'автоматический вариант',
        language: 'ru',
        languageProbability: 0.6,
        tokenProbabilities: [0.8],
      },
      kk: { text: 'қазақша жақсы нұсқа', tokenProbabilities: [0.98] },
    });
    const transcribe = createSerializedLocalTranscriber(() => config(), passes);

    await expect(transcribe(await sourceFile())).resolves.toBe(
      'қазақша жақсы нұсқа',
    );
    const whisperLanguages = passes.mock.calls
      .filter(([executable]) => executable.includes('whisper'))
      .map(([, args]) => args[args.indexOf('-l') + 1]);
    expect(whisperLanguages).toEqual(['auto', 'ru', 'kk']);
    expect(sharedMocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'whisper_retry',
        retryLanguage: 'ru',
        failureCode: 'ENOENT',
      }),
      expect.any(String),
    );
  });

  it('honours explicit overrides and single mode with exactly one pass', async () => {
    const execLocal = localExecForPasses({
      kk: { text: 'Тек қазақша.', tokenProbabilities: [0.99] },
    });
    const transcribe = createSerializedLocalTranscriber(
      () => config({ accuracyMode: 'single' }),
      execLocal,
    );

    await expect(transcribe(await sourceFile(), 'kk')).resolves.toBe(
      'Тек қазақша.',
    );
    const whisperCall = execLocal.mock.calls.find(([name]) =>
      name.includes('whisper'),
    );
    expect(whisperCall?.[1]).toContain('kk');
    expect(
      execLocal.mock.calls.filter(([name]) => name.includes('whisper')),
    ).toHaveLength(1);
  });

  it('prefers auto inside a real score tie, but not over a materially better pass', () => {
    expect(
      selectBestCandidate([candidate('ru', -0.1), candidate('auto', -0.11)])
        ?.requestedLanguage,
    ).toBe('auto');
    expect(
      selectBestCandidate([candidate('auto', -0.2), candidate('kk', -0.05)])
        ?.requestedLanguage,
    ).toBe('kk');
  });

  it('has no Russian order bias when Kazakh has a slightly better measured score', () => {
    expect(
      selectBestCandidate([candidate('ru', -0.1), candidate('kk', -0.09)])
        ?.requestedLanguage,
    ).toBe('kk');
  });

  it('uses only real retry signals and rejects empty/repetitive/corrupt text', () => {
    expect(validateTranscript(null)).toEqual({
      valid: false,
      invalidReason: 'empty',
    });
    expect(validateTranscript('да да да да да да да да')).toEqual({
      valid: false,
      invalidReason: 'repetition',
    });
    expect(validateTranscript('текст\u0000битый')).toEqual({
      valid: false,
      invalidReason: 'corruption',
    });

    const lowLanguage = candidateFromWhisperOutput(
      'auto',
      whisperJson('Текст', 'ru', [0.99]),
      'auto-detected language: ru (p = 0.7)',
    );
    expect(retryReasonForAutoCandidate(lowLanguage, config())).toBe(
      'low_language_probability',
    );
    expect(
      retryReasonForAutoCandidate(
        {
          ...lowLanguage,
          languageProbability: 0.99,
          meanTokenLogProbability: -0.3,
        },
        config(),
      ),
    ).toBe('low_mean_token_log_probability');
  });
});

describe('local prompt, failures, cleanup and serialization', () => {
  it('combines env and local-file prompts without logging either value', async () => {
    const source = await sourceFile();
    const promptRoot = await fs.mkdtemp(join(tmpdir(), 'voice-stt-prompt-'));
    rootsToRemove.add(promptRoot);
    const promptFile = join(promptRoot, 'prompt.txt');
    await fs.writeFile(promptFile, 'Алматы; бейтарап термин', 'utf8');
    const execLocal = localExecForPasses({
      auto: {
        text: 'Скуби в Алматы.',
        language: 'ru',
        languageProbability: 0.99,
        tokenProbabilities: [0.99],
      },
    });
    const transcribe = createSerializedLocalTranscriber(
      () =>
        config({
          initialPrompt: 'Скуби; Ақтау',
          promptFile,
        }),
      execLocal,
    );

    await expect(transcribe(source)).resolves.toBe('Скуби в Алматы.');
    const whisperArgs = execLocal.mock.calls.find(([name]) =>
      name.includes('whisper'),
    )?.[1];
    const promptIndex = whisperArgs?.indexOf('--prompt') ?? -1;
    expect(whisperArgs?.[promptIndex + 1]).toBe(
      'Скуби; Ақтау\nАлматы; бейтарап термин',
    );
    const everyLogCall = JSON.stringify([
      sharedMocks.logger.info.mock.calls,
      sharedMocks.logger.warn.mock.calls,
      sharedMocks.logger.error.mock.calls,
    ]);
    expect(everyLogCall).not.toContain('Алматы');
    expect(everyLogCall).not.toContain('Скуби');
  });

  it('returns null on timeout, logs no process payload and has no cloud fallback', async () => {
    const calls: string[] = [];
    const secret = 'PRIVATE TRANSCRIPT MUST NOT LEAK';
    const execLocal = vi.fn<LocalExecFile>(async (executable, args) => {
      calls.push(executable);
      if (executable.includes('ffmpeg')) {
        await writeWav(args.at(-1) as string);
        return { stdout: '', stderr: '' };
      }
      throw Object.assign(new Error(secret), {
        code: 'ETIMEDOUT',
        killed: true,
        stdout: secret,
        stderr: secret,
      });
    });
    const transcribe = createSerializedLocalTranscriber(
      () => config(),
      execLocal,
    );

    await expect(transcribe(await sourceFile())).resolves.toBeNull();
    expect(calls).toEqual(['/local/bin/ffmpeg', '/local/bin/whisper-cli']);
    expect(calls.join(' ')).not.toMatch(/https?:|curl|fetch|openai|anthropic/i);
    expect(JSON.stringify(sharedMocks.logger.error.mock.calls)).not.toContain(
      secret,
    );
    expect(sharedMocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ timedOut: true, failureCode: 'ETIMEDOUT' }),
      expect.any(String),
    );
  });

  it('removes private WAV and every JSON artifact after success and failure', async () => {
    const successDirs: string[] = [];
    const successExec = localExecForPasses(
      {
        auto: {
          text: 'Успех.',
          language: 'ru',
          languageProbability: 0.99,
          tokenProbabilities: [0.99],
        },
      },
      successDirs,
    );
    const successTranscribe = createSerializedLocalTranscriber(
      () => config(),
      successExec,
    );
    await successTranscribe(await sourceFile('success.ogg'));
    await expect(fs.stat(successDirs[0])).rejects.toMatchObject({
      code: 'ENOENT',
    });

    let failureDir = '';
    const failureExec = vi.fn<LocalExecFile>(async (executable, args) => {
      if (executable.includes('ffmpeg')) {
        failureDir = dirname(args.at(-1) as string);
        await writeWav(args.at(-1) as string);
        await fs.writeFile(join(failureDir, 'sensitive-extra.json'), 'secret');
        return { stdout: '', stderr: '' };
      }
      throw Object.assign(new Error('local failure'), { code: 'EIO' });
    });
    const failureTranscribe = createSerializedLocalTranscriber(
      () => config(),
      failureExec,
    );
    await failureTranscribe(await sourceFile('failure.ogg'));
    await expect(fs.stat(failureDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes the whole sequence and continues the queue after a failure', async () => {
    let releaseFirst!: () => void;
    const firstMayFail = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const events: string[] = [];
    const execLocal = vi.fn<LocalExecFile>(async (executable, args) => {
      const sourceArg = args[args.indexOf('-i') + 1] || '';
      if (executable.includes('ffmpeg') && sourceArg.endsWith('first.ogg')) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push('first-start');
        firstStarted();
        await firstMayFail;
        active -= 1;
        events.push('first-fail');
        throw Object.assign(new Error('expected local failure'), {
          code: 'EIO',
        });
      }
      if (executable.includes('ffmpeg')) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push('second-start');
        await writeWav(args.at(-1) as string);
        active -= 1;
        return { stdout: '', stderr: '' };
      }
      const outputPrefix = args[args.indexOf('-of') + 1];
      await fs.writeFile(
        `${outputPrefix}.json`,
        whisperJson('Второй выполнен.', 'ru', [0.99]),
      );
      return {
        stdout: '',
        stderr: 'auto-detected language: ru (p = 0.99)',
      };
    });
    const transcribe = createSerializedLocalTranscriber(
      () => config(),
      execLocal,
    );
    const first = transcribe(await sourceFile('first.ogg'));
    await started;
    const second = transcribe(await sourceFile('second.ogg'));
    await Promise.resolve();
    expect(events).toEqual(['first-start']);
    releaseFirst();

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBe('Второй выполнен.');
    expect(events).toEqual(['first-start', 'first-fail', 'second-start']);
    expect(maxActive).toBe(1);
  });
});
