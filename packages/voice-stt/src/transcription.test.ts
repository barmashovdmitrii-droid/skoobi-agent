import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  OperationTraceObserver,
  OperationTraceDetails,
  OperationTraceStage,
  OperationTraceOutcome,
} from '@skoobi/shared/operation-trace';
import { parseLocalTranscriptionResult } from '@skoobi/shared/transcription-result';

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
  runControlledLocalProcess,
  candidateFromWhisperOutput,
  createSerializedLocalTranscriber,
  createSerializedLocalTranscribers,
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

function recordingTrace() {
  const events: Array<{
    stage: OperationTraceStage;
    initial: OperationTraceDetails;
    outcome?: OperationTraceOutcome;
    details?: OperationTraceDetails;
  }> = [];
  const trace: OperationTraceObserver = {
    operationIds: ['00000000-0000-4000-8000-000000000001'],
    startStage(stage, initial = {}) {
      const event: (typeof events)[number] = { stage, initial };
      events.push(event);
      return {
        finish(outcome, details) {
          Object.assign(event, { outcome, details });
        },
      };
    },
  };
  return { trace, events };
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

    // Silence detected by the automatic pass should not trigger language retries.
  describe('silence and empty output skip the ru/kk retries', () => {
    it.each([
      ['[BLANK_AUDIO]', 'no_speech'],
      ['  (silence)  ', 'no_speech'],
      ['[no speech]', 'no_speech'],
      ['', 'empty'],
    ])(
      'auto pass %j → one Whisper pass, unusable with invalidReason %s',
      async (text, invalidReason) => {
        // Only the auto pass is scripted: a ru/kk retry would hit ENOENT.
        const execLocal = localExecForPasses({
          auto: { text, language: 'en', languageProbability: 0.31 },
        });
        const transcribe = createSerializedLocalTranscriber(
          () => config(),
          execLocal,
        );

        await expect(transcribe(await sourceFile())).resolves.toBeNull();

        const whisperLanguages = execLocal.mock.calls
          .filter(([executable]) => executable.includes('whisper'))
          .map(([, args]) => args[args.indexOf('-l') + 1]);
        expect(whisperLanguages).toEqual(['auto']);
        expect(sharedMocks.logger.warn).not.toHaveBeenCalled();
        expect(sharedMocks.logger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            passCount: 1,
            retryReason: null,
            invalidReason,
            selectedLanguage: null,
          }),
          'Local transcription was unusable',
        );
      },
    );

    it('still retries ru/kk for language-dependent damage such as repetition', async () => {
      const execLocal = localExecForPasses({
        auto: {
          text: 'да да да да да да да да',
          language: 'ru',
          languageProbability: 0.99,
          tokenProbabilities: [0.9],
        },
        ru: { text: 'да да да да да да да да', tokenProbabilities: [0.9] },
        kk: { text: 'иә иә иә иә иә иә иә иә', tokenProbabilities: [0.9] },
      });
      const transcribe = createSerializedLocalTranscriber(
        () => config(),
        execLocal,
      );

      await expect(transcribe(await sourceFile())).resolves.toBeNull();
      expect(sharedMocks.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          passCount: 3,
          retryReason: 'invalid_transcript',
          invalidReason: 'repetition',
        }),
        'Local transcription was unusable',
      );
    });

    it('classifies silence markers separately from corrupt output', () => {
      expect(validateTranscript('[BLANK_AUDIO]')).toEqual({
        valid: false,
        invalidReason: 'no_speech',
      });
      expect(validateTranscript('(speaking in foreign language)')).toEqual({
        valid: false,
        invalidReason: 'corruption',
      });
      expect(
        retryReasonForAutoCandidate(
          candidate('auto', null, { valid: false, invalidReason: 'no_speech' }),
          config(),
        ),
      ).toBeNull();
      expect(
        retryReasonForAutoCandidate(
          candidate('auto', null, {
            valid: false,
            invalidReason: 'corruption',
          }),
          config(),
        ),
      ).toBe('invalid_transcript');
    });

    it('logs a short path-free ffmpeg stderr excerpt when audio extraction fails', async () => {
      const source = await sourceFile();
      const execLocal = vi.fn<LocalExecFile>(async (executable) => {
        expect(executable).toBe('/local/bin/ffmpeg');
        throw Object.assign(new Error('Command failed'), {
          code: 1,
          stderr: `${source}: Invalid data found\nOutput file #0 does not contain any stream\n`,
        });
      });
      const transcribe = createSerializedLocalTranscriber(
        () => config(),
        execLocal,
      );

      await expect(transcribe(source)).resolves.toBeNull();

      expect(sharedMocks.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'ffmpeg',
          stderrSnippet: expect.stringContaining(
            'Output file #0 does not contain any stream',
          ),
        }),
        'Local audio transcription failed',
      );
      const snippet = (
        sharedMocks.logger.error.mock.calls[0][0] as { stderrSnippet: string }
      ).stderrSnippet;
      expect(snippet).not.toContain(dirname(source));
      expect(snippet).toContain('…/voice.ogg');
      expect(snippet.length).toBeLessThanOrEqual(160);
    });
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
    // Whisper can hallucinate subtitle credits over music or silence.
    for (const artifact of [
      'Субтитры сделал FixtureAuthor',
      'Субтитры создавал FixtureAuthor.',
      'Продолжение следует...',
      'Редактор субтитров А.Тестовый Корректор Б.Примерный',
      '[Музыка]',
      '[Музыка] [Аплодисменты]',
      '♪♪',
      '♪ Спасибо за просмотр! ♪',
    ]) {
      expect(validateTranscript(artifact)).toEqual({
        valid: false,
        invalidReason: 'artifact',
      });
    }
    // Real speech that merely contains such words is kept.
    for (const speech of [
      'Скуби, субтитры сделал сам, посмотри ролик',
      'Продолжение следует завтра, напомни мне',
      'Музыка громкая, переведи слова песни',
      'Музыка',
      'Корректор, проверь текст договора',
    ]) {
      expect(validateTranscript(speech)).toEqual({
        valid: true,
        invalidReason: null,
      });
    }

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

describe('local transcription operation trace', () => {
  it('links the existing bounded rechecks and records only measured metadata', async () => {
    const source = await sourceFile('private-source.ogg');
    const secret = 'private words and prompt';
    const execLocal = localExecForPasses({
      auto: {
        text: secret,
        language: 'ru',
        languageProbability: 0.6,
        tokenProbabilities: [0.6],
      },
      ru: { text: secret, tokenProbabilities: [0.99] },
      kk: { text: secret, tokenProbabilities: [0.95] },
    });
    const { trace, events } = recordingTrace();
    const transcribe = createSerializedLocalTranscriber(
      () => config({ initialPrompt: secret }),
      execLocal,
    );
    await expect(transcribe(source, undefined, trace)).resolves.toBe(secret);
    expect(
      execLocal.mock.calls.filter(([name]) => name.includes('whisper')),
    ).toHaveLength(3);
    expect(events.map((event) => event.stage)).toEqual([
      'stt_queue',
      'stt_preprocess',
      'ffmpeg',
      'stt',
      'stt_recheck',
      'stt_recheck',
    ]);
    expect(events.every((event) => event.outcome === 'succeeded')).toBe(true);
    expect(
      events
        .filter((event) => event.stage === 'stt_recheck')
        .map((event) => event.initial),
    ).toEqual([
      { passIndex: 2, language: 'ru', reason: 'low_language_probability' },
      { passIndex: 3, language: 'kk', reason: 'low_language_probability' },
    ]);
    expect(
      events.find((event) => event.stage === 'stt')?.details,
    ).toMatchObject({ language: 'ru', languageProbability: 0.6 });
    expect(
      events.find((event) => event.stage === 'stt_preprocess')?.details,
    ).toEqual({ audioDurationMs: 1000 });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(source);
    expect(JSON.stringify(events)).not.toContain(config().whisperModel);
  });

  it('records a process timeout without leaking errors or adding a retry', async () => {
    const { trace, events } = recordingTrace();
    const execLocal = vi.fn<LocalExecFile>(async (executable, args) => {
      if (executable.includes('ffmpeg')) {
        await writeWav(args.at(-1) as string);
        return { stdout: '', stderr: '' };
      }
      throw Object.assign(new Error('private process output'), {
        code: 'ETIMEDOUT',
        stderr: 'private process output',
      });
    });
    const transcribe = createSerializedLocalTranscriber(
      () => config(),
      execLocal,
    );
    await expect(
      transcribe(await sourceFile(), undefined, trace),
    ).resolves.toBeNull();
    expect(events.find((event) => event.stage === 'stt')).toMatchObject({
      outcome: 'failed',
      details: { reason: 'process_timeout' },
    });
    expect(
      events.filter((event) => event.stage === 'stt_recheck'),
    ).toHaveLength(0);
    expect(execLocal).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(events)).not.toContain('private process output');
  });

  it('does not let throwing observers break transcription or poison the queue', async () => {
    const execLocal = localExecForPasses({
      auto: {
        text: 'Synthetic text.',
        language: 'en',
        languageProbability: 0.99,
        tokenProbabilities: [0.99],
      },
    });
    const transcribe = createSerializedLocalTranscriber(
      () => config(),
      execLocal,
    );
    const source = await sourceFile();
    const throwingStart: OperationTraceObserver = {
      operationIds: [],
      startStage() {
        throw new Error('diagnostics unavailable');
      },
    };
    const throwingFinish: OperationTraceObserver = {
      operationIds: [],
      startStage() {
        return {
          finish() {
            throw new Error('diagnostics unavailable');
          },
        };
      },
    };
    await expect(
      Promise.all([
        transcribe(source, undefined, throwingStart),
        transcribe(source, undefined, throwingFinish),
        transcribe(source),
      ]),
    ).resolves.toEqual([
      'Synthetic text.',
      'Synthetic text.',
      'Synthetic text.',
    ]);
    expect(execLocal).toHaveBeenCalledTimes(6);
  });

  it('keeps queue waiting separate from STT and releases it after processing failure', async () => {
    let release!: () => void;
    let started!: () => void;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const successfulExec = localExecForPasses({
      auto: {
        text: 'Next.',
        language: 'en',
        languageProbability: 0.99,
        tokenProbabilities: [0.99],
      },
    });
    let first = true;
    const execLocal: LocalExecFile = async (...args) => {
      if (first) {
        first = false;
        started();
        await block;
        throw new Error('first ffmpeg failed');
      }
      return successfulExec(...args);
    };
    const transcribe = createSerializedLocalTranscriber(
      () => config(),
      execLocal,
    );
    const source = await sourceFile();
    const firstTrace = recordingTrace();
    const secondTrace = recordingTrace();
    const a = transcribe(source, undefined, firstTrace.trace);
    await firstStarted;
    const b = transcribe(source, undefined, secondTrace.trace);
    await Promise.resolve();
    expect(secondTrace.events).toEqual([{ stage: 'stt_queue', initial: {} }]);
    release();
    await expect(a).resolves.toBeNull();
    await expect(b).resolves.toBe('Next.');
    expect(
      firstTrace.events.find((event) => event.stage === 'ffmpeg'),
    ).toMatchObject({
      outcome: 'failed',
      details: { reason: 'process_failure' },
    });
    expect(secondTrace.events[0]).toMatchObject({
      outcome: 'succeeded',
      details: { queueWaitMs: expect.any(Number) },
    });
    expect(secondTrace.events[0].details?.queueWaitMs).toBeGreaterThanOrEqual(
      0,
    );
  });
});

describe('bounded local transcription cancellation', () => {
  it('preserves stdout/stderr and nonzero exit evidence for controlled calls', async () => {
    const control = {
      timeout: 3000,
      signal: new AbortController().signal,
      maxBuffer: 1024,
    };
    await expect(
      runControlledLocalProcess(
        process.execPath,
        [
          '-e',
          'process.stdout.write("result");process.stderr.write("diagnostic")',
        ],
        control,
      ),
    ).resolves.toEqual({ stdout: 'result', stderr: 'diagnostic' });
    await expect(
      runControlledLocalProcess(
        process.execPath,
        ['-e', 'process.stderr.write("failed");process.exitCode=7'],
        control,
      ),
    ).rejects.toMatchObject({ code: 7, stderr: 'failed' });
  });

  it('bounds output and terminates a controlled call at its wall timeout', async () => {
    const signal = new AbortController().signal;
    await expect(
      runControlledLocalProcess(
        process.execPath,
        [
          '-e',
          'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)',
        ],
        { timeout: 3000, signal, maxBuffer: 64 },
      ),
    ).rejects.toMatchObject({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stdout: 'x'.repeat(64),
    });
    await expect(
      runControlledLocalProcess(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000)'],
        { timeout: 50, signal, maxBuffer: 64 },
      ),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });

  it.skipIf(process.platform === 'win32')(
    'stops a wrapper descendant before the serialized queue advances, even if the wrapper exits first',
    async () => {
      const source = await sourceFile();
      const wrapperReady = join(dirname(source), 'wrapper-ready');
      const childReady = join(dirname(source), 'child-ready');
      const heartbeat = join(dirname(source), 'heartbeat');
      const controller = new AbortController();
      const childProgram =
        'const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(process.argv[1],String(process.pid));fs.writeFileSync(process.argv[2],"tick");setInterval(()=>fs.appendFileSync(process.argv[2],"tick"),10)';
      const wrapperProgram = `const fs=require("node:fs");process.on("SIGTERM",()=>process.exit(0));fs.writeFileSync(process.argv[1],String(process.pid));require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(childProgram)},process.argv[2],process.argv[3]],{stdio:"ignore"});setInterval(()=>{},1000)`;
      const normalExec = localExecForPasses({
        auto: {
          text: 'Next result',
          language: 'en',
          languageProbability: 0.99,
          tokenProbabilities: [0.99],
        },
      });
      let first = true;
      let successorStarted = false;
      const transcribe = createSerializedLocalTranscriber(
        () => config(),
        async (...args) => {
          if (first) {
            first = false;
            return runControlledLocalProcess(
              process.execPath,
              ['-e', wrapperProgram, wrapperReady, childReady, heartbeat],
              { timeout: 10_000, signal: controller.signal, maxBuffer: 1024 },
            );
          }
          successorStarted = true;
          const before = await fs.readFile(heartbeat, 'utf8');
          await new Promise((resolve) => setTimeout(resolve, 75));
          expect(await fs.readFile(heartbeat, 'utf8')).toBe(before);
          return normalExec(...args);
        },
      );
      let firstSettled = false;
      const a = transcribe(source, undefined, undefined, {
        signal: controller.signal,
        deadlineAtMs: Date.now() + 20_000,
      }).then((result) => {
        firstSettled = true;
        return result;
      });
      let wrapperPid: number | undefined;
      try {
        const deadline = Date.now() + 3000;
        while (!(await fs.stat(childReady).catch(() => undefined))) {
          if (Date.now() > deadline)
            throw new Error('Synthetic wrapper did not start');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        wrapperPid = Number(await fs.readFile(wrapperReady, 'utf8'));
        const b = transcribe(source);
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(() => process.kill(wrapperPid!, 0)).toThrow();
        expect(firstSettled).toBe(false);
        expect(successorStarted).toBe(false);
        await expect(a).resolves.toBeNull();
        await expect(b).resolves.toBe('Next result');
        expect(successorStarted).toBe(true);
      } finally {
        controller.abort();
        if (wrapperPid) {
          try {
            process.kill(-wrapperPid, 'SIGKILL');
          } catch {
            /* group already stopped */
          }
        }
      }
    },
    10_000,
  );

  it('aborts a queued entry without letting its successor overtake active work', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const exec = localExecForPasses({
      auto: {
        text: 'Result',
        language: 'en',
        languageProbability: 0.99,
        tokenProbabilities: [0.99],
      },
    });
    let first = true;
    const transcribe = createSerializedLocalTranscriber(
      () => config(),
      async (...args) => {
        if (first) {
          first = false;
          began();
          await blocked;
        }
        return exec(...args);
      },
    );
    const source = await sourceFile();
    const a = transcribe(source);
    await started;
    const controller = new AbortController();
    const b = transcribe(source, undefined, undefined, {
      signal: controller.signal,
      deadlineAtMs: Date.now() + 60_000,
    });
    const c = transcribe(source);
    controller.abort();
    await expect(b).resolves.toBeNull();
    expect(exec).not.toHaveBeenCalled();
    release();
    await expect(a).resolves.toBe('Result');
    await expect(c).resolves.toBe('Result');
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('waits for close and escalates when a local child ignores TERM', async () => {
    const source = await sourceFile('child-ready');
    await fs.unlink(source);
    const controller = new AbortController();
    let completed = false;
    const result = runControlledLocalProcess(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)',
        source,
      ],
      { timeout: 10_000, signal: controller.signal, maxBuffer: 1024 },
    ).then(
      (value) => {
        completed = true;
        return value;
      },
      (error) => {
        completed = true;
        return error as NodeJS.ErrnoException;
      },
    );
    const deadline = Date.now() + 3000;
    while (!(await fs.stat(source).catch(() => undefined))) {
      if (Date.now() > deadline)
        throw new Error('Synthetic child did not start');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pid = Number(await fs.readFile(source, 'utf8'));
    try {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(completed).toBe(false);
      expect(await result).toMatchObject({ code: 'ABORT_ERR' });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* child already closed */
      }
    }
  }, 10_000);
});

describe('typed local transcription evidence', () => {
  it('distinguishes malformed recognizer output from a genuine empty segment list', async () => {
    expect(parseWhisperJson('{}')).toBeNull();
    expect(parseWhisperJson('{"transcription":[]}')?.transcript).toBeNull();
    const exec = localExecForPasses({
      auto: { text: '', invalidJson: true },
      ru: { text: '', invalidJson: true },
      kk: { text: '', invalidJson: true },
    });
    const result = await createSerializedLocalTranscribers(
      () => config(),
      exec,
    ).detailed(await sourceFile());
    expect(result).toMatchObject({
      status: 'technical_error',
      error: { stage: 'whisper', code: 'invalid_output', retryable: false },
    });
    expect(result.passes).toHaveLength(3);
    expect(parseLocalTranscriptionResult(result)).toEqual(result);
  });
  it('keeps a confident recording on one pass and preserves exact original whitespace', async () => {
    const original = '  Отправь  файл.\n';
    const exec = localExecForPasses({
      auto: {
        text: original,
        language: 'ru',
        languageProbability: 0.99,
        tokenProbabilities: [0.99],
      },
    });
    const result = await createSerializedLocalTranscribers(
      () => config(),
      exec,
    ).detailed(await sourceFile());
    expect(result).toMatchObject({
      status: 'success',
      text: 'Отправь файл.',
      originalText: original,
      selectedPassIndex: 1,
      recheck: { reason: null, comparison: 'not_run' },
      uncertainty: [],
      ambiguities: [],
    });
    expect(result.passes).toHaveLength(1);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(parseLocalTranscriptionResult(result)).toEqual(result);
  });

  it('retains number, negation and possible-name disagreement instead of declaring the highest score correct', async () => {
    const exec = localExecForPasses({
      auto: {
        text: 'Отправь ПолучателюА 10 рублей.',
        language: 'ru',
        languageProbability: 0.4,
        tokenProbabilities: [0.8],
      },
      ru: {
        text: 'Не отправляй ПолучателюБ 20 рублей.',
        language: 'ru',
        tokenProbabilities: [0.99],
      },
      kk: {
        text: 'Синтетикалық сөйлем.',
        language: 'kk',
        tokenProbabilities: [0.7],
      },
    });
    const trace = recordingTrace();
    const result = await createSerializedLocalTranscribers(
      () => config(),
      exec,
    ).detailed(await sourceFile(), undefined, trace.trace);
    expect(result).toMatchObject({
      status: 'doubtful',
      text: 'Не отправляй ПолучателюБ 20 рублей.',
      originalText: 'Отправь ПолучателюА 10 рублей.',
      selectedPassIndex: 2,
      recheck: { reason: 'low_language_probability', comparison: 'different' },
    });
    expect(result.uncertainty).toEqual(
      expect.arrayContaining([
        'number_disagreement',
        'negation_disagreement',
        'possible_name_disagreement',
      ]),
    );
    expect(result.ambiguities.map((item) => item.kind)).toEqual([
      'number',
      'negation',
      'possible_name',
    ]);
    expect(result.passes).toHaveLength(3);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(parseLocalTranscriptionResult(result)).toEqual(result);
    expect(JSON.stringify(trace.events)).not.toContain('Получателю');
    expect(JSON.stringify(trace.events)).not.toContain('рублей');
  });

  it.each([
    ['', 'empty'],
    ['[BLANK_AUDIO]', 'no_speech'],
  ] as const)(
    'keeps %s as completed empty input without a quality retry',
    async (text, emptyReason) => {
      const exec = localExecForPasses({
        auto: { text, language: 'ru', languageProbability: 0.99 },
      });
      const result = await createSerializedLocalTranscribers(
        () => config(),
        exec,
      ).detailed(await sourceFile());
      expect(result).toMatchObject({
        status: 'empty',
        text: null,
        originalText: text,
        emptyReason,
        passes: [{ index: 1, valid: false }],
      });
      expect(exec).toHaveBeenCalledTimes(2);
      expect(parseLocalTranscriptionResult(result)).toEqual(result);
    },
  );

  it('preserves rejected original captions and does not fabricate a transcript after bounded invalid rechecks', async () => {
    const text = 'Спасибо за просмотр.';
    const exec = localExecForPasses({
      auto: { text, language: 'ru', languageProbability: 0.99 },
      ru: { text, language: 'ru' },
      kk: { text, language: 'kk' },
    });
    const result = await createSerializedLocalTranscribers(
      () => config(),
      exec,
    ).detailed(await sourceFile());
    expect(result).toMatchObject({
      status: 'unusable',
      text: null,
      originalText: text,
      recheck: { reason: 'invalid_transcript' },
    });
    expect(result.passes).toHaveLength(3);
    expect(parseLocalTranscriptionResult(result)).toEqual(result);
  });

  it('uses the existing bounded rechecks for an isolated suspect tail but never cuts the phrase out', async () => {
    const text = 'Отправь файл. Продолжение следует...';
    const exec = localExecForPasses({
      auto: {
        text,
        language: 'ru',
        languageProbability: 0.99,
        tokenProbabilities: [0.99],
      },
      ru: { text, language: 'ru', tokenProbabilities: [0.98] },
      kk: { text, language: 'kk', tokenProbabilities: [0.97] },
    });
    const result = await createSerializedLocalTranscribers(
      () => config(),
      exec,
    ).detailed(await sourceFile());
    expect(result).toMatchObject({
      status: 'doubtful',
      text,
      originalText: text,
      recheck: { reason: 'suspect_caption_tail' },
    });
    expect(exec).toHaveBeenCalledTimes(4);
    expect(parseLocalTranscriptionResult(result)).toEqual(result);
    const ordinary = localExecForPasses({
      auto: {
        text: 'Продолжение следует в следующем выпуске.',
        language: 'ru',
        languageProbability: 0.99,
        tokenProbabilities: [0.99],
      },
    });
    expect(
      (
        await createSerializedLocalTranscribers(
          () => config(),
          ordinary,
        ).detailed(await sourceFile())
      ).status,
    ).toBe('success');
    expect(ordinary).toHaveBeenCalledTimes(2);
  });

  it('rechecks a trailing caption cue after substantial speech without sentence punctuation and preserves every candidate', async () => {
    const text =
      'Проверь пожалуйста этот черновик и сравни его с исходным документом перед окончательной отправкой Продолжение следует...';
    const exec = localExecForPasses({
      auto: {
        text,
        language: 'ru',
        languageProbability: 0.99,
        tokenProbabilities: [0.99],
      },
      ru: { text, language: 'ru', tokenProbabilities: [0.98] },
      kk: { text, language: 'kk', tokenProbabilities: [0.97] },
    });
    const result = await createSerializedLocalTranscribers(
      () => config(),
      exec,
    ).detailed(await sourceFile());
    expect(result).toMatchObject({
      status: 'doubtful',
      text,
      originalText: text,
      recheck: { reason: 'suspect_caption_tail' },
      uncertainty: expect.arrayContaining(['suspect_caption_tail']),
    });
    expect(result.passes).toHaveLength(3);
    expect(result.passes.every((pass) => pass.text === text)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(parseLocalTranscriptionResult(result)).toEqual(result);
  });

  it.each([
    'Для нового выпуска нашего небольшого проекта мы вместе заранее придумали понятное короткое название: Продолжение следует...',
    'Для нового выпуска нашего небольшого проекта мы вместе заранее придумали понятное короткое название Продолжение следует...',
    'Для нового выпуска нашего небольшого проекта мы вместе заранее придумали название «Продолжение следует...».',
    'После просмотра нового выпуска нашего небольшого проекта все зрители задали один вопрос: Продолжение следует?',
    'Мы внимательно прочитали новый выпуск нашего небольшого проекта и уже знаем что продолжение следует...',
    'Продолжение следует в следующем выпуске, поэтому пока не публикуй окончательный вариант.',
  ])(
    'does not add a caption recheck for a title, quotation, question or ordinary use: %s',
    async (text) => {
      const exec = localExecForPasses({
        auto: {
          text,
          language: 'ru',
          languageProbability: 0.99,
          tokenProbabilities: [0.99],
        },
      });
      const result = await createSerializedLocalTranscribers(
        () => config(),
        exec,
      ).detailed(await sourceFile());
      expect(result).toMatchObject({
        status: 'success',
        text,
        originalText: text,
        recheck: { reason: null },
        uncertainty: [],
      });
      expect(result.passes).toHaveLength(1);
      expect(exec).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['ETIMEDOUT', 'process_timeout', true],
    ['ENOENT', 'missing_executable', false],
    ['EACCES', 'access_denied', false],
  ] as const)(
    'distinguishes %s from genuine empty speech',
    async (code, expected, retryable) => {
      const exec = vi
        .fn<LocalExecFile>()
        .mockRejectedValue(
          Object.assign(new Error('private synthetic error payload'), { code }),
        );
      const result = await createSerializedLocalTranscribers(
        () => config(),
        exec,
      ).detailed(await sourceFile());
      expect(result).toMatchObject({
        status: 'technical_error',
        text: null,
        passes: [],
        error: { stage: 'ffmpeg', code: expected, retryable },
      });
      expect(JSON.stringify(result)).not.toContain(
        'private synthetic error payload',
      );
      expect(parseLocalTranscriptionResult(result)).toEqual(result);
    },
  );

  it('shares one queue between detailed and legacy callers and starts no work for queued cancellation', async () => {
    const exec = localExecForPasses({
      auto: {
        text: 'Result',
        language: 'en',
        languageProbability: 0.99,
        tokenProbabilities: [0.99],
      },
    });
    let first = true,
      started!: () => void,
      release!: () => void;
    const ready = new Promise<void>((resolve) => {
        started = resolve;
      }),
      blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
    const bundle = createSerializedLocalTranscribers(
      () => config(),
      async (...args) => {
        if (first) {
          first = false;
          started();
          await blocked;
        }
        return exec(...args);
      },
    );
    const source = await sourceFile();
    const a = bundle.legacy(source);
    await ready;
    const controller = new AbortController();
    const b = bundle.detailed(source, undefined, undefined, {
      signal: controller.signal,
      deadlineAtMs: Date.now() + 60_000,
    });
    const c = bundle.detailed(source);
    controller.abort();
    expect(await b).toMatchObject({
      status: 'cancelled',
      error: { code: 'aborted', retryable: false },
    });
    expect(exec).not.toHaveBeenCalled();
    release();
    await expect(a).resolves.toBe('Result');
    expect(await c).toMatchObject({ status: 'success', text: 'Result' });
    expect(exec).toHaveBeenCalledTimes(4);
  });
});
