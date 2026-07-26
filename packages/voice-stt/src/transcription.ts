/**
 * Channel-agnostic audio transcription via local whisper-cli.
 *
 * The source file is owned by the caller and is never removed here. Every
 * derived WAV/JSON artifact lives in a private per-call temporary directory
 * and is removed on every exit path. There is deliberately no network or
 * cloud fallback in this module.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';

import {
  basenameOnly,
  FFMPEG_FALLBACKS,
  folderAbsFromMediaPath,
  logger,
  readEnvFile,
  resolveBinary,
  updateMediaEntry,
  WHISPER_FALLBACKS,
} from '@skoobi/shared';

const execFileAsync = promisify(execFile);

const envVars = readEnvFile([
  'WHISPER_BIN',
  'WHISPER_MODEL',
  'WHISPER_LANG',
  'WHISPER_NO_GPU',
  'WHISPER_THREADS',
  'WHISPER_TIMEOUT_MS',
  'WHISPER_ACCURACY_MODE',
  'WHISPER_RETRY_LANGUAGE_PROB',
  'WHISPER_RETRY_MEAN_LOGPROB',
  'WHISPER_INITIAL_PROMPT',
  'WHISPER_PROMPT_FILE',
  'FFMPEG_BIN',
]);

const DEFAULT_WHISPER_TIMEOUT_MS = 180_000;
const DEFAULT_RETRY_LANGUAGE_PROBABILITY = 0.9;
const DEFAULT_RETRY_MEAN_TOKEN_LOG_PROBABILITY = -0.15;
const FFMPEG_TIMEOUT_MS = 60_000;
const CHILD_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 16 * 1024;
const AUTO_TIE_EPSILON = 0.02;

export type AccuracyMode = 'max' | 'single';

export interface LocalTranscriptionConfig {
  whisperBin: string;
  whisperModel: string;
  whisperLang: string;
  whisperNoGpu: boolean;
  whisperThreads: string;
  whisperTimeoutMs: number;
  accuracyMode: AccuracyMode;
  retryLanguageProbability: number;
  retryMeanTokenLogProbability: number;
  initialPrompt: string;
  promptFile: string;
  ffmpegBin: string;
}

export interface WhisperCandidate {
  requestedLanguage: string;
  detectedLanguage: string | null;
  languageProbability: number | null;
  /** Arithmetic mean of ln(p) for lexical tokens reported by whisper.cpp. */
  meanTokenLogProbability: number | null;
  transcript: string | null;
  valid: boolean;
  invalidReason: 'empty' | 'repetition' | 'corruption' | 'invalid_json' | null;
}

interface ExecOptions {
  timeout: number;
  maxBuffer?: number;
}

export type LocalExecFile = (
  executable: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

interface ParsedWhisperJson {
  transcript: string | null;
  detectedLanguage: string | null;
  meanTokenLogProbability: number | null;
}

function envValue(name: keyof typeof envVars): string {
  return process.env[name] || envVars[name] || '';
}

function finiteNumber(value: string, fallback: number): number {
  if (!value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(value: string, fallback: number): number {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/u.test(normalized)) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function normalizeThreads(value: string | undefined): string {
  const normalized = String(value || '').trim();
  return /^[1-9]\d*$/u.test(normalized) &&
    Number.isSafeInteger(Number(normalized))
    ? normalized
    : '';
}

function normalizeLanguage(value: string | undefined): string {
  const normalized = String(value || 'auto')
    .trim()
    .toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]+)?$/.test(normalized) || normalized === 'auto'
    ? normalized
    : 'auto';
}

export function resolveLocalTranscriptionConfig(): LocalTranscriptionConfig {
  const accuracyMode = envValue('WHISPER_ACCURACY_MODE').toLowerCase();
  return {
    whisperBin:
      envValue('WHISPER_BIN') ||
      resolveBinary('whisper-cli', WHISPER_FALLBACKS),
    whisperModel: envValue('WHISPER_MODEL'),
    whisperLang: normalizeLanguage(envValue('WHISPER_LANG') || 'auto'),
    whisperNoGpu: envValue('WHISPER_NO_GPU').toLowerCase() === 'true',
    whisperThreads: normalizeThreads(envValue('WHISPER_THREADS')),
    whisperTimeoutMs: positiveInteger(
      envValue('WHISPER_TIMEOUT_MS'),
      DEFAULT_WHISPER_TIMEOUT_MS,
    ),
    accuracyMode: accuracyMode === 'single' ? 'single' : 'max',
    retryLanguageProbability: Math.min(
      1,
      Math.max(
        0,
        finiteNumber(
          envValue('WHISPER_RETRY_LANGUAGE_PROB'),
          DEFAULT_RETRY_LANGUAGE_PROBABILITY,
        ),
      ),
    ),
    retryMeanTokenLogProbability: Math.min(
      0,
      finiteNumber(
        envValue('WHISPER_RETRY_MEAN_LOGPROB'),
        DEFAULT_RETRY_MEAN_TOKEN_LOG_PROBABILITY,
      ),
    ),
    initialPrompt: envValue('WHISPER_INITIAL_PROMPT'),
    promptFile: envValue('WHISPER_PROMPT_FILE'),
    ffmpegBin:
      envValue('FFMPEG_BIN') || resolveBinary('ffmpeg', FFMPEG_FALLBACKS),
  };
}

export interface WhisperArgsOptions {
  model: string;
  audioPath: string;
  outputPrefix: string;
  language: string;
  threads?: string;
  noGpu?: boolean;
  initialPrompt?: string;
}

/** Build arguments without a shell; prompt/path values stay single argv items. */
export function buildWhisperArgs(options: WhisperArgsOptions): string[] {
  const args = [
    '-m',
    options.model,
    '-f',
    options.audioPath,
    '-l',
    normalizeLanguage(options.language),
    '-nt',
    '-ojf',
    '-of',
    options.outputPrefix,
  ];
  const threads = normalizeThreads(options.threads);
  if (threads) args.push('-t', threads);
  if (options.noGpu) args.push('--no-gpu');
  if (options.initialPrompt?.trim()) {
    args.push('--prompt', options.initialPrompt.trim());
  }
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nullableLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeLanguage(value);
  return normalized === 'auto' ? null : normalized;
}

function normalizeTranscript(value: string): string | null {
  const text = value.replace(/\s+/gu, ' ').trim();
  return text || null;
}

/** Parse the full JSON output emitted by whisper.cpp's -ojf flag. */
export function parseWhisperJson(jsonText: string): ParsedWhisperJson | null {
  let document: unknown;
  try {
    document = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!isRecord(document)) return null;

  const result = isRecord(document.result) ? document.result : null;
  const detectedLanguage = nullableLanguage(result?.language);
  const segments = Array.isArray(document.transcription)
    ? document.transcription
    : [];
  const textParts: string[] = [];
  const tokenLogProbabilities: number[] = [];

  for (const segment of segments) {
    if (!isRecord(segment)) continue;
    if (typeof segment.text === 'string') textParts.push(segment.text);
    if (!Array.isArray(segment.tokens)) continue;
    for (const token of segment.tokens) {
      if (!isRecord(token) || typeof token.p !== 'number') continue;
      const tokenText = typeof token.text === 'string' ? token.text : '';
      // Control tokens are not transcript quality evidence. Lexical p=0 is
      // retained with a small floor rather than silently inflating confidence.
      if (
        /^<\|[^|]+\|>$/u.test(tokenText) ||
        /^\[_[^\]]+_\]$/u.test(tokenText) ||
        !Number.isFinite(token.p)
      )
        continue;
      if (token.p < 0 || token.p > 1) continue;
      tokenLogProbabilities.push(Math.log(Math.max(token.p, 1e-12)));
    }
  }

  const topLevelText =
    typeof document.text === 'string' ? document.text : textParts.join(' ');
  const transcript = normalizeTranscript(topLevelText);
  const meanTokenLogProbability = tokenLogProbabilities.length
    ? tokenLogProbabilities.reduce((sum, value) => sum + value, 0) /
      tokenLogProbabilities.length
    : null;

  return { transcript, detectedLanguage, meanTokenLogProbability };
}

/** Parse whisper.cpp's real auto-language probability from diagnostics. */
export function parseAutoLanguageProbability(stderr: string): {
  language: string | null;
  probability: number | null;
} {
  const match = stderr.match(
    /auto[- ]detected language:\s*([a-z]{2,3}(?:-[a-z0-9]+)?)\s*\(\s*p\s*=\s*([0-9.eE+-]+)\s*\)/iu,
  );
  if (!match) return { language: null, probability: null };
  const probability = Number(match[2]);
  return {
    language: nullableLanguage(match[1]),
    probability:
      Number.isFinite(probability) && probability >= 0 && probability <= 1
        ? probability
        : null,
  };
}

function hasRepetition(text: string): boolean {
  const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (words.length < 8) return false;

  const frequencies = new Map<string, number>();
  for (const word of words) {
    frequencies.set(word, (frequencies.get(word) || 0) + 1);
  }
  const maxFrequency = Math.max(...frequencies.values());
  if (
    frequencies.size / words.length <= 0.25 &&
    maxFrequency / words.length >= 0.5
  ) {
    return true;
  }

  // Detect an exact phrase repeated at least three times (common Whisper
  // hallucination) without rejecting short, legitimate "да, да" utterances.
  for (
    let width = 1;
    width <= Math.min(6, Math.floor(words.length / 3));
    width += 1
  ) {
    const phrase = words.slice(0, width).join('\u0000');
    let repeats = 1;
    for (let offset = width; offset + width <= words.length; offset += width) {
      if (words.slice(offset, offset + width).join('\u0000') !== phrase) break;
      repeats += 1;
    }
    if (repeats >= 3 && repeats * width >= words.length * 0.75) return true;
  }
  return false;
}

export function validateTranscript(
  transcript: string | null,
): Pick<WhisperCandidate, 'valid' | 'invalidReason'> {
  if (!transcript?.trim()) return { valid: false, invalidReason: 'empty' };
  if (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(transcript) ||
    /^\s*[[(](?:blank_audio|silence|no speech|speaking in foreign language)[\])].*$/iu.test(
      transcript,
    )
  ) {
    return { valid: false, invalidReason: 'corruption' };
  }
  if (hasRepetition(transcript)) {
    return { valid: false, invalidReason: 'repetition' };
  }
  return { valid: true, invalidReason: null };
}

export function candidateFromWhisperOutput(
  requestedLanguage: string,
  jsonText: string,
  stderr: string,
): WhisperCandidate {
  const parsed = parseWhisperJson(jsonText);
  if (!parsed) {
    return {
      requestedLanguage,
      detectedLanguage: requestedLanguage === 'auto' ? null : requestedLanguage,
      languageProbability: null,
      meanTokenLogProbability: null,
      transcript: null,
      valid: false,
      invalidReason: 'invalid_json',
    };
  }
  const autoLanguage =
    requestedLanguage === 'auto'
      ? parseAutoLanguageProbability(stderr)
      : { language: null, probability: null };
  const transcriptState = validateTranscript(parsed.transcript);
  return {
    requestedLanguage,
    detectedLanguage:
      autoLanguage.language ||
      parsed.detectedLanguage ||
      (requestedLanguage === 'auto' ? null : requestedLanguage),
    languageProbability: autoLanguage.probability,
    meanTokenLogProbability: parsed.meanTokenLogProbability,
    transcript: parsed.transcript,
    ...transcriptState,
  };
}

export type RetryReason =
  | 'invalid_transcript'
  | 'missing_language_probability'
  | 'low_language_probability'
  | 'missing_mean_token_log_probability'
  | 'low_mean_token_log_probability';

export function retryReasonForAutoCandidate(
  candidate: WhisperCandidate,
  config: Pick<
    LocalTranscriptionConfig,
    'retryLanguageProbability' | 'retryMeanTokenLogProbability'
  >,
): RetryReason | null {
  if (!candidate.valid) return 'invalid_transcript';
  if (candidate.languageProbability === null) {
    // Some compatible builds omit the language p diagnostic. Do not damage a
    // healthy, clearly decoded third language merely because that optional
    // diagnostic is absent; ru/kk still enter the accuracy comparison.
    if (
      candidate.detectedLanguage &&
      candidate.detectedLanguage !== 'ru' &&
      candidate.detectedLanguage !== 'kk' &&
      candidate.meanTokenLogProbability !== null &&
      candidate.meanTokenLogProbability >= config.retryMeanTokenLogProbability
    ) {
      return null;
    }
    return 'missing_language_probability';
  }
  if (candidate.languageProbability < config.retryLanguageProbability) {
    return 'low_language_probability';
  }
  if (candidate.meanTokenLogProbability === null) {
    return 'missing_mean_token_log_probability';
  }
  if (candidate.meanTokenLogProbability < config.retryMeanTokenLogProbability) {
    return 'low_mean_token_log_probability';
  }
  return null;
}

/** Pick by measured token quality; prefer auto only inside a small real tie. */
export function selectBestCandidate(
  candidates: readonly WhisperCandidate[],
): WhisperCandidate | null {
  const valid = candidates.filter(
    (candidate) => candidate.valid && candidate.transcript,
  );
  if (!valid.length) return null;

  return valid.reduce((best, candidate) => {
    const bestScore = best.meanTokenLogProbability;
    const candidateScore = candidate.meanTokenLogProbability;
    if (bestScore === null && candidateScore !== null) return candidate;
    if (bestScore !== null && candidateScore === null) return best;
    if (bestScore !== null && candidateScore !== null) {
      const difference = candidateScore - bestScore;
      const comparisonIncludesAuto =
        best.requestedLanguage === 'auto' ||
        candidate.requestedLanguage === 'auto';
      if (
        difference !== 0 &&
        (!comparisonIncludesAuto || Math.abs(difference) > AUTO_TIE_EPSILON)
      ) {
        return difference > 0 ? candidate : best;
      }
    }

    // Language probability is comparable only when both passes report it.
    if (
      best.languageProbability !== null &&
      candidate.languageProbability !== null &&
      best.languageProbability !== candidate.languageProbability
    ) {
      return candidate.languageProbability > best.languageProbability
        ? candidate
        : best;
    }
    if (best.requestedLanguage === 'auto') return best;
    if (candidate.requestedLanguage === 'auto') return candidate;
    return best;
  });
}

async function defaultExecFile(
  executable: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(executable, [...args], {
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    encoding: 'utf8',
  });
  return {
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

async function readInitialPrompt(
  config: LocalTranscriptionConfig,
): Promise<string> {
  const promptParts: string[] = [];
  if (config.initialPrompt.trim())
    promptParts.push(config.initialPrompt.trim());

  if (config.promptFile.trim()) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(config.promptFile, 'r');
      const buffer = Buffer.alloc(MAX_PROMPT_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_PROMPT_BYTES) {
        logger.warn(
          { reason: 'prompt_file_too_large' },
          'Local Whisper prompt file ignored',
        );
      } else {
        const filePrompt = buffer
          .subarray(0, bytesRead)
          .toString('utf8')
          .trim();
        if (filePrompt) promptParts.push(filePrompt);
      }
    } catch {
      logger.warn(
        { reason: 'prompt_file_unavailable' },
        'Local Whisper prompt file ignored',
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  return promptParts.join('\n').slice(0, MAX_PROMPT_BYTES).trim();
}

function parseWavDuration(header: Buffer): number | null {
  if (
    header.length < 12 ||
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  for (let offset = 12; offset + 8 <= header.length;) {
    const id = header.toString('ascii', offset, offset + 4);
    const size = header.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (id === 'fmt ' && size >= 16 && payloadOffset + 12 <= header.length) {
      byteRate = header.readUInt32LE(payloadOffset + 8);
    }
    if (id === 'data') {
      dataBytes = size;
      break;
    }
    offset = payloadOffset + size + (size % 2);
  }
  if (!byteRate || dataBytes === null) return null;
  const duration = dataBytes / byteRate;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

async function wavDurationSeconds(wavPath: string): Promise<number | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(wavPath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseWavDuration(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function safeProcessFailure(err: unknown): {
  failureCode: string;
  timedOut: boolean;
} {
  const record = isRecord(err) ? err : {};
  const rawCode = record.code;
  const failureCode =
    typeof rawCode === 'string' && /^[A-Z0-9_-]{1,32}$/i.test(rawCode)
      ? rawCode
      : 'process_error';
  return {
    failureCode,
    timedOut:
      failureCode === 'ETIMEDOUT' ||
      record.killed === true ||
      typeof record.signal === 'string',
  };
}

async function runWhisperPass(
  config: LocalTranscriptionConfig,
  execLocal: LocalExecFile,
  wavPath: string,
  privateTmpDir: string,
  language: string,
  passIndex: number,
  initialPrompt: string,
): Promise<WhisperCandidate> {
  const outputPrefix = join(privateTmpDir, `pass-${passIndex}-${language}`);
  const args = buildWhisperArgs({
    model: config.whisperModel,
    audioPath: wavPath,
    outputPrefix,
    language,
    threads: config.whisperThreads,
    noGpu: config.whisperNoGpu,
    initialPrompt,
  });
  const { stderr } = await execLocal(config.whisperBin, args, {
    timeout: config.whisperTimeoutMs,
    maxBuffer: CHILD_MAX_BUFFER_BYTES,
  });
  const json = await fs.readFile(`${outputPrefix}.json`, 'utf8');
  return candidateFromWhisperOutput(language, json, stderr);
}

function roundMetric(value: number | null, digits: number): number | null {
  return value === null ? null : Number(value.toFixed(digits));
}

async function transcribeUnserialized(
  audioPath: string,
  langOverride: string | undefined,
  config: LocalTranscriptionConfig,
  execLocal: LocalExecFile,
): Promise<string | null> {
  if (!config.whisperModel) {
    logger.error(
      { failureCode: 'missing_local_model' },
      'Local voice transcription disabled',
    );
    return null;
  }

  const startedAt = performance.now();
  let privateTmpDir: string | null = null;
  let audioDuration: number | null = null;
  let stage: 'temporary_directory' | 'ffmpeg' | 'whisper' =
    'temporary_directory';
  let passCount = 0;
  let retryReason: RetryReason | null = null;

  try {
    privateTmpDir = await fs.mkdtemp(join(tmpdir(), 'skoobi-voice-stt-'));
    await fs.chmod(privateTmpDir, 0o700);
    const wavPath = join(privateTmpDir, 'audio.wav');

    stage = 'ffmpeg';
    await execLocal(
      config.ffmpegBin,
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
        wavPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER_BYTES },
    );
    audioDuration = await wavDurationSeconds(wavPath);
    const initialPrompt = await readInitialPrompt(config);
    const requestedLanguage = normalizeLanguage(
      langOverride || config.whisperLang || 'auto',
    );
    const candidates: WhisperCandidate[] = [];

    stage = 'whisper';
    candidates.push(
      await runWhisperPass(
        config,
        execLocal,
        wavPath,
        privateTmpDir,
        requestedLanguage,
        ++passCount,
        initialPrompt,
      ),
    );

    if (requestedLanguage === 'auto' && config.accuracyMode === 'max') {
      retryReason = retryReasonForAutoCandidate(candidates[0], config);
      if (retryReason) {
        for (const retryLanguage of ['ru', 'kk'] as const) {
          passCount += 1;
          try {
            candidates.push(
              await runWhisperPass(
                config,
                execLocal,
                wavPath,
                privateTmpDir,
                retryLanguage,
                passCount,
                initialPrompt,
              ),
            );
          } catch (err) {
            // A failed optional retry must not discard an already usable auto
            // result or prevent the other local retry from being attempted.
            logger.warn(
              {
                via: 'local-whisper',
                stage: 'whisper_retry',
                retryLanguage,
                ...safeProcessFailure(err),
                model: basename(config.whisperModel),
              },
              'Local Whisper accuracy retry failed',
            );
          }
        }
      }
    }

    const selected = selectBestCandidate(candidates);
    const processingDurationMs = performance.now() - startedAt;
    const realtimeFactor =
      audioDuration && audioDuration > 0
        ? processingDurationMs / 1000 / audioDuration
        : null;
    logger.info(
      {
        via: 'local-whisper',
        selectedLanguage:
          selected?.detectedLanguage || selected?.requestedLanguage || null,
        passCount,
        retryReason,
        model: basename(config.whisperModel),
        audioDurationSeconds: roundMetric(audioDuration, 3),
        processingDurationMs: roundMetric(processingDurationMs, 1),
        realtimeFactor: roundMetric(realtimeFactor, 3),
        meanTokenLogProbability: roundMetric(
          selected?.meanTokenLogProbability ?? null,
          4,
        ),
      },
      selected
        ? 'Transcribed audio file locally'
        : 'Local transcription was unusable',
    );

    const transcript = selected?.transcript || null;
    if (transcript) {
      const folderAbs = folderAbsFromMediaPath(audioPath);
      if (folderAbs) {
        await updateMediaEntry(folderAbs, basenameOnly(audioPath), {
          has_transcript: true,
          transcript_chars: transcript.length,
        }).catch(() => undefined);
      }
    }
    return transcript;
  } catch (err) {
    const processingDurationMs = performance.now() - startedAt;
    logger.error(
      {
        via: 'local-whisper',
        stage,
        ...safeProcessFailure(err),
        passCount,
        model: basename(config.whisperModel),
        audioDurationSeconds: roundMetric(audioDuration, 3),
        processingDurationMs: roundMetric(processingDurationMs, 1),
      },
      'Local audio transcription failed',
    );
    return null;
  } finally {
    if (privateTmpDir) {
      await fs
        .rm(privateTmpDir, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }
}

/**
 * Make a transcriber whose entire ffmpeg + one-to-three Whisper sequence is
 * serialized. A rejection cannot poison the tail; the next queued call runs.
 * Exported for deterministic local-only unit testing.
 */
export function createSerializedLocalTranscriber(
  configProvider: () => LocalTranscriptionConfig,
  execLocal: LocalExecFile = defaultExecFile,
): (audioPath: string, langOverride?: string) => Promise<string | null> {
  let tail: Promise<void> = Promise.resolve();
  return (audioPath: string, langOverride?: string) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous
      .then(() =>
        transcribeUnserialized(
          audioPath,
          langOverride,
          configProvider(),
          execLocal,
        ),
      )
      .finally(release);
  };
}

const defaultLocalTranscriber = createSerializedLocalTranscriber(
  resolveLocalTranscriptionConfig,
);

/**
 * Transcribe a local audio file to text.
 *
 * @param audioPath Absolute path to an audio file ffmpeg can read.
 * @param langOverride ISO language code or "auto". Overrides WHISPER_LANG.
 */
export function transcribeAudioFile(
  audioPath: string,
  langOverride?: string,
): Promise<string | null> {
  return defaultLocalTranscriber(audioPath, langOverride);
}
