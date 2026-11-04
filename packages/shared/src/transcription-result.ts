/** Private speech evidence. Text and candidates must never enter diagnostic traces.
 * These observations neither verify the user's intent nor grant action authority.
 */
export const TRANSCRIPTION_TEXT_MAX_BYTES = 64 * 1024;
export const TRANSCRIPTION_RESULT_MAX_BYTES = 384 * 1024;

export type TranscriptionStatus =
  | 'success'
  | 'doubtful'
  | 'empty'
  | 'unusable'
  | 'technical_error'
  | 'cancelled';
export type TranscriptionInvalidReason =
  | 'empty'
  | 'no_speech'
  | 'repetition'
  | 'corruption'
  | 'artifact'
  | 'invalid_json';
export type TranscriptionRecheckReason =
  | 'invalid_transcript'
  | 'missing_language_probability'
  | 'low_language_probability'
  | 'missing_mean_token_log_probability'
  | 'low_mean_token_log_probability'
  | 'suspect_caption_tail';
export type TranscriptionUncertainty =
  | 'missing_mean_logprob'
  | 'low_mean_logprob'
  | 'missing_language_probability'
  | 'low_language_probability'
  | 'candidate_disagreement'
  | 'number_disagreement'
  | 'negation_disagreement'
  | 'possible_name_disagreement'
  | 'comparison_limited'
  | 'recheck_unavailable'
  | 'suspect_caption_tail';
export type TranscriptionErrorCode =
  | 'missing_model'
  | 'missing_executable'
  | 'access_denied'
  | 'process_timeout'
  | 'process_exit'
  | 'transient_resource'
  | 'output_unavailable'
  | 'output_too_large'
  | 'invalid_output'
  | 'storage_failure'
  | 'aborted';
export interface TranscriptionTechnicalError {
  stage:
    | 'queue'
    | 'configuration'
    | 'temporary_directory'
    | 'ffmpeg'
    | 'whisper';
  code: TranscriptionErrorCode;
  /** Only timeout/resource/output-availability failures may retry the whole pipeline. */
  retryable: boolean;
}
export interface TranscriptionPassEvidence {
  index: number;
  requestedLanguage: string;
  detectedLanguage: string | null;
  languageProbability: number | null;
  meanTokenLogProbability: number | null;
  /** Original extracted text, including a rejected candidate. No dictionary edits. */
  text: string | null;
  valid: boolean;
  invalidReason: TranscriptionInvalidReason | null;
  outcome: 'completed' | 'technical_error';
  errorCode?: TranscriptionErrorCode;
}
export interface TranscriptionAmbiguity {
  kind: 'number' | 'negation' | 'possible_name';
  passIndices: [number, number];
  /** Bounded differing terms for a targeted clarification, not a corrected command. */
  variants: [string, string];
}
export interface LocalTranscriptionResult {
  schema: 1;
  status: TranscriptionStatus;
  /** Same selected text as the legacy API; null for non-command outcomes. */
  text: string | null;
  /** Exact first extracted candidate, even when rejected by validation. */
  originalText: string | null;
  selectedPassIndex: number | null;
  passes: TranscriptionPassEvidence[];
  recheck: {
    reason: TranscriptionRecheckReason | null;
    comparison: 'not_run' | 'consistent' | 'different' | 'unavailable';
    comparedPassIndices: number[];
  };
  uncertainty: TranscriptionUncertainty[];
  ambiguities: TranscriptionAmbiguity[];
  emptyReason?: 'empty' | 'no_speech';
  error?: TranscriptionTechnicalError;
  metrics: {
    queueWaitMs: number;
    processingMs: number;
    audioDurationMs: number | null;
  };
}

const STATUSES = [
  'success',
  'doubtful',
  'empty',
  'unusable',
  'technical_error',
  'cancelled',
];
const INVALID = [
  'empty',
  'no_speech',
  'repetition',
  'corruption',
  'artifact',
  'invalid_json',
];
const RECHECK = [
  'invalid_transcript',
  'missing_language_probability',
  'low_language_probability',
  'missing_mean_token_log_probability',
  'low_mean_token_log_probability',
  'suspect_caption_tail',
];
const UNCERTAINTY = [
  'missing_mean_logprob',
  'low_mean_logprob',
  'missing_language_probability',
  'low_language_probability',
  'candidate_disagreement',
  'number_disagreement',
  'negation_disagreement',
  'possible_name_disagreement',
  'comparison_limited',
  'recheck_unavailable',
  'suspect_caption_tail',
];
const ERROR = [
  'missing_model',
  'missing_executable',
  'access_denied',
  'process_timeout',
  'process_exit',
  'transient_resource',
  'output_unavailable',
  'output_too_large',
  'invalid_output',
  'storage_failure',
  'aborted',
];
const RETRYABLE = [
  'process_timeout',
  'transient_resource',
  'output_unavailable',
];
function oneOf(value: unknown, values: readonly string[]): value is string {
  return typeof value === 'string' && values.includes(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function nullableText(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      Buffer.byteLength(value) <= TRANSCRIPTION_TEXT_MAX_BYTES)
  );
}
function finite(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}
function language(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{1,8})?)$/.test(value)
  );
}
function passIndex(value: unknown): value is number {
  return Number.isInteger(value) && finite(value, 1, 3);
}

/** Copies only the versioned bounded data contract. Scope and retry counters are
 * still validated by the host store; this function grants neither authority.
 */
export function parseLocalTranscriptionResult(
  input: unknown,
): LocalTranscriptionResult | undefined {
  try {
    if (
      !record(input) ||
      !exactKeys(input, [
        'schema',
        'status',
        'text',
        'originalText',
        'selectedPassIndex',
        'passes',
        'recheck',
        'uncertainty',
        'ambiguities',
        'emptyReason',
        'error',
        'metrics',
      ]) ||
      input.schema !== 1 ||
      !oneOf(input.status, STATUSES) ||
      !nullableText(input.text) ||
      !nullableText(input.originalText)
    )
      return;
    if (!Array.isArray(input.passes) || input.passes.length > 3) return;
    const passes = input.passes;
    const indices = new Set<number>();
    for (const pass of input.passes) {
      if (
        !record(pass) ||
        !exactKeys(pass, [
          'index',
          'requestedLanguage',
          'detectedLanguage',
          'languageProbability',
          'meanTokenLogProbability',
          'text',
          'valid',
          'invalidReason',
          'outcome',
          'errorCode',
        ]) ||
        !passIndex(pass.index) ||
        indices.has(pass.index) ||
        !language(pass.requestedLanguage) ||
        (pass.detectedLanguage !== null && !language(pass.detectedLanguage)) ||
        !nullableText(pass.text) ||
        typeof pass.valid !== 'boolean'
      )
        return;
      if (
        pass.index !== indices.size + 1 ||
        (pass.languageProbability !== null &&
          !finite(pass.languageProbability, 0, 1)) ||
        (pass.meanTokenLogProbability !== null &&
          !finite(pass.meanTokenLogProbability, -100, 0)) ||
        (pass.invalidReason !== null && !oneOf(pass.invalidReason, INVALID))
      )
        return;
      if (pass.outcome === 'technical_error') {
        if (
          pass.valid ||
          pass.text !== null ||
          pass.invalidReason !== null ||
          !oneOf(pass.errorCode, ERROR)
        )
          return;
      } else if (
        pass.outcome !== 'completed' ||
        pass.errorCode !== undefined ||
        (pass.valid
          ? pass.invalidReason !== null || !pass.text?.trim()
          : pass.invalidReason === null)
      )
        return;
      indices.add(pass.index);
    }
    if (input.originalText !== (input.passes[0]?.text ?? null)) return;
    const selected = input.passes.find(
      (pass) => pass.index === input.selectedPassIndex,
    );
    const usable = input.status === 'success' || input.status === 'doubtful';
    if (
      usable
        ? !selected?.valid ||
          typeof input.text !== 'string' ||
          !input.text.trim() ||
          input.text !== selected.text?.replace(/\s+/gu, ' ').trim()
        : input.text !== null || input.selectedPassIndex !== null
    )
      return;
    const recheck = input.recheck;
    if (
      !record(recheck) ||
      !exactKeys(recheck, ['reason', 'comparison', 'comparedPassIndices']) ||
      (recheck.reason !== null && !oneOf(recheck.reason, RECHECK)) ||
      !oneOf(recheck.comparison, [
        'not_run',
        'consistent',
        'different',
        'unavailable',
      ]) ||
      !Array.isArray(recheck.comparedPassIndices) ||
      recheck.comparedPassIndices.length > 3 ||
      !recheck.comparedPassIndices.every(
        (index) => passIndex(index) && indices.has(index),
      )
    )
      return;
    if (
      !Array.isArray(input.uncertainty) ||
      input.uncertainty.length > UNCERTAINTY.length ||
      input.uncertainty.some((reason) => !oneOf(reason, UNCERTAINTY)) ||
      new Set(input.uncertainty).size !== input.uncertainty.length
    )
      return;
    if (
      new Set(recheck.comparedPassIndices).size !==
        recheck.comparedPassIndices.length ||
      recheck.comparedPassIndices.some(
        (index) =>
          !passes.some(
            (pass) =>
              pass.index === index &&
              pass.valid &&
              pass.outcome === 'completed',
          ),
      )
    )
      return;
    if (
      (recheck.comparison === 'consistent' ||
        recheck.comparison === 'different') &&
      recheck.comparedPassIndices.length < 2
    )
      return;
    if (recheck.comparison === 'not_run' && passes.length > 1) return;
    if (
      recheck.comparison === 'different' &&
      !input.uncertainty.includes('candidate_disagreement')
    )
      return;
    const comparedTexts = new Set(
      recheck.comparedPassIndices.map((index) => {
        const text = passes.find((pass) => pass.index === index)!
          .text as string;
        return (
          text.match(/[+-]?\d+(?:[.,]\d+)*%?|[\p{L}]+(?:['’][\p{L}]+)?/gu) || []
        )
          .map((word) => word.toLowerCase().replace(/,/g, '.'))
          .join('\u0000');
      }),
    );
    if (recheck.comparison === 'consistent' && comparedTexts.size !== 1) return;
    if (recheck.comparison === 'different' && comparedTexts.size < 2) return;
    if (!Array.isArray(input.ambiguities) || input.ambiguities.length > 8)
      return;
    for (const ambiguity of input.ambiguities) {
      if (
        !record(ambiguity) ||
        !exactKeys(ambiguity, ['kind', 'passIndices', 'variants']) ||
        !oneOf(ambiguity.kind, ['number', 'negation', 'possible_name']) ||
        !Array.isArray(ambiguity.passIndices) ||
        ambiguity.passIndices.length !== 2 ||
        ambiguity.passIndices[0] === ambiguity.passIndices[1] ||
        !ambiguity.passIndices.every(
          (index) => passIndex(index) && indices.has(index),
        ) ||
        !Array.isArray(ambiguity.variants) ||
        ambiguity.variants.length !== 2 ||
        ambiguity.variants[0] === ambiguity.variants[1] ||
        !ambiguity.variants.every(
          (value) =>
            typeof value === 'string' && Buffer.byteLength(value) <= 256,
        )
      )
        return;
      for (let i = 0; i < 2; i++) {
        const index = ambiguity.passIndices[i];
        const pass = passes.find((pass) => pass.index === index);
        if (
          !pass?.valid ||
          pass.outcome !== 'completed' ||
          !pass.text?.includes(ambiguity.variants[i])
        )
          return;
      }
    }
    if (
      input.status === 'success' &&
      (input.uncertainty.length || input.ambiguities.length)
    )
      return;
    if (
      input.status === 'doubtful' &&
      !input.uncertainty.length &&
      !input.ambiguities.length
    )
      return;
    if (
      input.status === 'empty'
        ? !oneOf(input.emptyReason, ['empty', 'no_speech'])
        : input.emptyReason !== undefined
    )
      return;
    if (input.status === 'technical_error' || input.status === 'cancelled') {
      const error = input.error;
      if (
        !record(error) ||
        !exactKeys(error, ['stage', 'code', 'retryable']) ||
        !oneOf(error.stage, [
          'queue',
          'configuration',
          'temporary_directory',
          'ffmpeg',
          'whisper',
        ]) ||
        !oneOf(error.code, ERROR) ||
        typeof error.retryable !== 'boolean' ||
        (error.retryable && !oneOf(error.code, RETRYABLE)) ||
        (input.status === 'cancelled'
          ? error.code !== 'aborted' || error.retryable
          : error.code === 'aborted')
      )
        return;
    } else if (input.error !== undefined) return;
    const metrics = input.metrics;
    if (
      !record(metrics) ||
      !exactKeys(metrics, ['queueWaitMs', 'processingMs', 'audioDurationMs']) ||
      !finite(metrics.queueWaitMs, 0, 31 * 86400_000) ||
      !finite(metrics.processingMs, 0, 31 * 86400_000) ||
      (metrics.audioDurationMs !== null &&
        !finite(metrics.audioDurationMs, 0, 31 * 86400_000))
    )
      return;
    const json = JSON.stringify(input);
    if (Buffer.byteLength(json) > TRANSCRIPTION_RESULT_MAX_BYTES) return;
    return JSON.parse(json) as LocalTranscriptionResult;
  } catch {
    return;
  }
}
