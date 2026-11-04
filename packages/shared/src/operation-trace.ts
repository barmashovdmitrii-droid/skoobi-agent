/** Observations only. A trace ID, stage or outcome never grants permission. */
export const OPERATION_TRACE_STAGES = [
  'ingress',
  'received',
  'accepted',
  'inbox',
  'queue',
  'stt_queue',
  'get_file',
  'download',
  'ffmpeg',
  'stt_preprocess',
  'stt',
  'stt_recheck',
  'materialize',
  'agent',
  'model',
  'model_turn',
  'tool',
  'recovery',
  'response',
  'delivery',
  'artifact_acceptance',
  'peer_accepted',
  'peer_progress',
  'peer_result',
  'peer_assessment',
  'peer_delivery',
] as const;
export type OperationTraceStage = (typeof OPERATION_TRACE_STAGES)[number];
export const OPERATION_TRACE_OUTCOMES = [
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
  'interrupted',
  'skipped',
] as const;
export type OperationTraceOutcome = (typeof OPERATION_TRACE_OUTCOMES)[number];
export const OPERATION_TRACE_REASONS = [
  'no_speech',
  'empty',
  'repetition',
  'corruption',
  'caption_artifact',
  'missing_language_probability',
  'low_language_probability',
  'missing_mean_logprob',
  'low_mean_logprob',
  'invalid_json',
  'process_timeout',
  'process_failure',
  'recheck_uncertain',
  'invalid_response',
  'network_failure',
  'storage_failure',
  'unavailable',
  'cancelled',
  'superseded',
  'timeout',
  'restart',
  'retry',
  'recovered',
  'pending',
  'dropped',
  'no_output',
  'api_acknowledged',
  'outcome_unknown',
  'checks_passed',
  'checks_failed',
  'inconclusive',
  'not_applicable',
  'start_unobserved',
] as const;
export type OperationTraceReason = (typeof OPERATION_TRACE_REASONS)[number];

/** Deliberately excludes text, paths, URLs, arguments, tool names and errors. */
export interface OperationTraceDetails {
  reason?: OperationTraceReason;
  language?: 'auto' | 'ru' | 'kk' | 'en' | 'other';
  deliveryKind?: 'progress' | 'final' | 'document' | 'image';
  toolFamily?: 'shell' | 'file' | 'browser' | 'mcp' | 'other';
  bytes?: number;
  passIndex?: number;
  passCount?: number;
  toolCallCount?: number;
  queueWaitMs?: number;
  audioDurationMs?: number;
  durationMs?: number;
  languageProbability?: number;
  meanLogProbability?: number;
}
export interface OperationTraceSpan {
  /** First terminal observation wins. API acknowledgement is not human receipt. */
  finish(outcome: OperationTraceOutcome, details?: OperationTraceDetails): void;
}
export interface OperationTraceObserver {
  readonly operationIds: readonly string[];
  readonly attemptId?: string;
  startStage(
    stage: OperationTraceStage,
    details?: OperationTraceDetails,
  ): OperationTraceSpan;
}

export const NOOP_OPERATION_TRACE_SPAN: OperationTraceSpan = Object.freeze({
  finish: () => {},
});

export function isOperationTraceStage(
  value: unknown,
): value is OperationTraceStage {
  return (
    typeof value === 'string' &&
    (OPERATION_TRACE_STAGES as readonly string[]).includes(value)
  );
}
export function isOperationTraceOutcome(
  value: unknown,
): value is OperationTraceOutcome {
  return (
    typeof value === 'string' &&
    (OPERATION_TRACE_OUTCOMES as readonly string[]).includes(value)
  );
}

/** Rebuild, never spread the caller object: even extra runtime fields stay private. */
export function sanitizeOperationTraceDetails(
  input: unknown,
): OperationTraceDetails {
  const output: Record<string, string | number> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return output;
  try {
    const data = input as Record<string, unknown>;
    const enums = {
      reason: OPERATION_TRACE_REASONS,
      language: ['auto', 'ru', 'kk', 'en', 'other'],
      deliveryKind: ['progress', 'final', 'document', 'image'],
      toolFamily: ['shell', 'file', 'browser', 'mcp', 'other'],
    };
    for (const [key, values] of Object.entries(enums)) {
      const value = data[key];
      if (
        typeof value === 'string' &&
        (values as readonly string[]).includes(value)
      )
        output[key] = value;
    }
    const numbers: Record<string, [number, number, boolean]> = {
      bytes: [0, 1e12, true],
      passIndex: [0, 1000, true],
      passCount: [0, 1000, true],
      toolCallCount: [0, 1e6, true],
      queueWaitMs: [0, 31 * 86400_000, true],
      audioDurationMs: [0, 31 * 86400_000, true],
      durationMs: [0, 31 * 86400_000, true],
      languageProbability: [0, 1, false],
      meanLogProbability: [-100, 0, false],
    };
    for (const [key, [min, max, integer]] of Object.entries(numbers)) {
      const value = data[key];
      if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= min &&
        value <= max &&
        (!integer || Number.isSafeInteger(value))
      )
        output[key] = value;
    }
  } catch {
    /* A diagnostic object with throwing getters must not affect work. */
  }
  return output as OperationTraceDetails;
}

/** Protect callers even when an optional, third-party observer throws. */
export function startOperationTraceStage(
  observer: OperationTraceObserver | undefined,
  stage: OperationTraceStage,
  details?: OperationTraceDetails,
): OperationTraceSpan {
  try {
    if (!observer || !isOperationTraceStage(stage))
      return NOOP_OPERATION_TRACE_SPAN;
    const span = observer.startStage(
      stage,
      sanitizeOperationTraceDetails(details),
    );
    let finished = false;
    return {
      finish(outcome, finalDetails) {
        if (finished || !isOperationTraceOutcome(outcome)) return;
        finished = true;
        try {
          span.finish(outcome, sanitizeOperationTraceDetails(finalDetails));
        } catch {
          /* fail open */
        }
      },
    };
  } catch {
    return NOOP_OPERATION_TRACE_SPAN;
  }
}
