import type {
  LocalTranscriptionResult,
  TranscriptionAmbiguity,
  TranscriptionPassEvidence,
  TranscriptionRecheckReason,
  TranscriptionTechnicalError,
  TranscriptionUncertainty,
} from '@skoobi/shared/transcription-result';

const MAX_COMPARISON_TOKENS = 4096;
const NEGATIONS = new Set([
  'не',
  'нет',
  'ни',
  'никогда',
  'без',
  'not',
  'no',
  'never',
  'without',
  'cannot',
  "don't",
  'жоқ',
  'емес',
]);
const NUMBER_WORDS = new Set([
  'ноль',
  'один',
  'одна',
  'два',
  'две',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
  'десять',
  'двадцать',
  'тридцать',
  'сто',
  'тысяча',
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'twenty',
  'thirty',
  'hundred',
  'thousand',
  'бір',
  'екі',
  'үш',
  'төрт',
  'бес',
  'алты',
  'жеті',
  'сегіз',
  'тоғыз',
  'он',
  'жүз',
  'мың',
]);
interface Token {
  raw: string;
  value: string;
  start: number;
  end: number;
}
function tokens(text: string): Token[] {
  return [
    ...text.matchAll(/[+-]?\d+(?:[.,]\d+)*%?|[\p{L}]+(?:['’][\p{L}]+)?/gu),
  ]
    .slice(0, MAX_COMPARISON_TOKENS + 1)
    .map((match) => ({
      raw: match[0],
      value: match[0].toLowerCase().replace(/,/g, '.'),
      start: match.index!,
      end: match.index! + match[0].length,
    }));
}
function sameWords(a: Token[], b: Token[]): boolean {
  return (
    a.length === b.length &&
    a.every((token, index) => token.value === b[index].value)
  );
}
function compatible(
  a: TranscriptionPassEvidence,
  b: TranscriptionPassEvidence,
): boolean {
  const left =
    a.detectedLanguage ||
    (a.requestedLanguage !== 'auto' ? a.requestedLanguage : null);
  const right =
    b.detectedLanguage ||
    (b.requestedLanguage !== 'auto' ? b.requestedLanguage : null);
  return left !== null && left === right;
}
/** A separate caption-like ending is a recheck cue, never a deletion rule.
 * Without sentence punctuation, require substantial preceding speech, a
 * capitalized ending and an ellipsis. Quoted or introduced titles stay literal.
 */
export function hasSuspectCaptionTail(text: string | null): boolean {
  if (!text) return false;
  if (
    /[.!?…]\s+(?:Продолжение следует|Спасибо за просмотр|Thanks for watching|Thank you for watching)[.!…]*\s*$/iu.test(
      text,
    )
  )
    return true;
  const tail =
    /(?:^|\s)(?:Продолжение следует|Спасибо за просмотр|Thanks for watching|Thank you for watching)(?:\.{3}|…)\s*$/u.exec(
      text,
    );
  if (!tail) return false;
  const prefix = text.slice(0, tail.index).trim();
  if (/[:"'«“„—-]$/u.test(prefix)) return false;
  if (
    /(?:название|заголовок|фразу|фраза|слова|титр|надпись|title|phrase|caption)$/iu.test(
      prefix,
    )
  )
    return false;
  return (prefix.match(/\p{L}[\p{L}\p{M}'’-]*/gu) ?? []).length >= 12;
}
function difference(a: Token[], b: Token[]): [string, string] | undefined {
  if (sameWords(a, b)) return;
  const left = a.find((token, index) => token.value !== b[index]?.value);
  const right = b.find((token, index) => token.value !== a[index]?.value);
  return [left?.raw || '', right?.raw || ''];
}
function negationContext(
  text: string,
  all: Token[],
): Array<{ value: string; raw: string }> {
  return all.flatMap((token, index) =>
    NEGATIONS.has(token.value)
      ? [
          {
            value: `${index}:${token.value}`,
            raw: text.slice(
              all[Math.max(0, index - 1)].start,
              all[Math.min(all.length - 1, index + 2)].end,
            ),
          },
        ]
      : [],
  );
}
function possibleNames(all: Token[]): Token[] {
  // A limited spelling cue, not named-entity recognition or identity evidence.
  return all.filter(
    (token, index) =>
      index > 0 &&
      (/^\p{Lu}\p{Ll}[\p{L}]*$/u.test(token.raw) ||
        /^\p{Lu}{2,}$/u.test(token.raw)),
  );
}
function boundedVariant(value: string): boolean {
  return Buffer.byteLength(value) <= 256;
}

export function assessTranscription(input: {
  passes: TranscriptionPassEvidence[];
  selectedPassIndex: number | null;
  recheckReason: TranscriptionRecheckReason | null;
  retryLanguageProbability: number;
  retryMeanTokenLogProbability: number;
  metrics: LocalTranscriptionResult['metrics'];
}): LocalTranscriptionResult {
  const { passes } = input;
  if (
    passes.length &&
    passes.every(
      (pass) =>
        pass.outcome === 'technical_error' ||
        pass.invalidReason === 'invalid_json',
    )
  )
    return failedTranscription(
      { stage: 'whisper', code: 'invalid_output', retryable: false },
      passes,
      input.metrics,
      input.recheckReason,
    );
  const selected = passes.find(
    (pass) => pass.index === input.selectedPassIndex,
  );
  const valid = passes.filter(
    (pass) => pass.valid && pass.text && pass.outcome === 'completed',
  );
  const uncertainty = new Set<TranscriptionUncertainty>();
  const ambiguities: TranscriptionAmbiguity[] = [];
  const compared = new Set<number>();
  let different = false;
  const addAmbiguity = (
    kind: TranscriptionAmbiguity['kind'],
    a: TranscriptionPassEvidence,
    b: TranscriptionPassEvidence,
    variants: [string, string] | undefined,
  ) => {
    if (
      !variants ||
      variants[0] === variants[1] ||
      !variants.every(boundedVariant)
    )
      return;
    uncertainty.add(
      kind === 'number'
        ? 'number_disagreement'
        : kind === 'negation'
          ? 'negation_disagreement'
          : 'possible_name_disagreement',
    );
    if (ambiguities.length < 8)
      ambiguities.push({ kind, passIndices: [a.index, b.index], variants });
  };
  for (let i = 0; i < valid.length; i++)
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i],
        b = valid[j];
      if (!compatible(a, b)) continue;
      const left = tokens(a.text!),
        right = tokens(b.text!);
      if (
        left.length > MAX_COMPARISON_TOKENS ||
        right.length > MAX_COMPARISON_TOKENS
      ) {
        uncertainty.add('comparison_limited');
        continue;
      }
      compared.add(a.index);
      compared.add(b.index);
      if (sameWords(left, right)) continue;
      different = true;
      uncertainty.add('candidate_disagreement');
      const numbers = (all: Token[]) =>
        all.filter(
          (token) => /\d/u.test(token.raw) || NUMBER_WORDS.has(token.value),
        );
      addAmbiguity('number', a, b, difference(numbers(left), numbers(right)));
      const leftNegation = negationContext(a.text!, left),
        rightNegation = negationContext(b.text!, right);
      if (
        leftNegation.map((item) => item.value).join('|') !==
        rightNegation.map((item) => item.value).join('|')
      )
        addAmbiguity('negation', a, b, [
          leftNegation[0]?.raw || '',
          rightNegation[0]?.raw || '',
        ]);
      addAmbiguity(
        'possible_name',
        a,
        b,
        difference(possibleNames(left), possibleNames(right)),
      );
    }
  if (selected) {
    if (selected.meanTokenLogProbability === null)
      uncertainty.add('missing_mean_logprob');
    else if (
      selected.meanTokenLogProbability < input.retryMeanTokenLogProbability
    )
      uncertainty.add('low_mean_logprob');
    if (selected.requestedLanguage === 'auto') {
      if (selected.languageProbability === null) {
        if (
          !selected.detectedLanguage ||
          ['ru', 'kk'].includes(selected.detectedLanguage) ||
          selected.meanTokenLogProbability === null ||
          selected.meanTokenLogProbability < input.retryMeanTokenLogProbability
        )
          uncertainty.add('missing_language_probability');
      } else if (selected.languageProbability < input.retryLanguageProbability)
        uncertainty.add('low_language_probability');
    }
    if (hasSuspectCaptionTail(selected.text))
      uncertainty.add('suspect_caption_tail');
  }
  const comparison =
    passes.length <= 1
      ? 'not_run'
      : compared.size < 2
        ? 'unavailable'
        : different
          ? 'different'
          : 'consistent';
  if (input.recheckReason && passes.length > 1 && comparison === 'unavailable')
    uncertainty.add('recheck_unavailable');
  const originalText = passes[0]?.text ?? null;
  const emptyReason = passes[0]?.invalidReason;
  const status = selected?.valid
    ? 'success'
    : emptyReason === 'empty' || emptyReason === 'no_speech'
      ? 'empty'
      : 'unusable';
  return {
    schema: 1,
    status: status === 'success' && uncertainty.size ? 'doubtful' : status,
    text: selected?.valid ? selected.text!.replace(/\s+/gu, ' ').trim() : null,
    originalText,
    selectedPassIndex: selected?.valid ? selected.index : null,
    passes,
    recheck: {
      reason: input.recheckReason,
      comparison,
      comparedPassIndices: [...compared],
    },
    uncertainty: [...uncertainty],
    ambiguities,
    ...(status === 'empty'
      ? { emptyReason: emptyReason as 'empty' | 'no_speech' }
      : {}),
    metrics: input.metrics,
  };
}

export function failedTranscription(
  error: TranscriptionTechnicalError,
  passes: TranscriptionPassEvidence[] = [],
  metrics: LocalTranscriptionResult['metrics'] = {
    queueWaitMs: 0,
    processingMs: 0,
    audioDurationMs: null,
  },
  recheckReason: TranscriptionRecheckReason | null = null,
): LocalTranscriptionResult {
  return {
    schema: 1,
    status: error.code === 'aborted' ? 'cancelled' : 'technical_error',
    text: null,
    originalText: passes[0]?.text ?? null,
    selectedPassIndex: null,
    passes,
    recheck: {
      reason: recheckReason,
      comparison: passes.length <= 1 ? 'not_run' : 'unavailable',
      comparedPassIndices: [],
    },
    uncertainty: [],
    ambiguities: [],
    error,
    metrics,
  };
}

export function classifyTranscriptionError(
  error: unknown,
  stage: TranscriptionTechnicalError['stage'],
  cancelled = false,
): TranscriptionTechnicalError {
  const code = (error as NodeJS.ErrnoException)?.code;
  const timeout =
    code === 'ETIMEDOUT' ||
    code === 'ESRCH_TIMEOUT' ||
    ((error as { killed?: boolean; signal?: string })?.killed === true &&
      (error as { signal?: string }).signal === 'SIGTERM');
  const result =
    cancelled || code === 'ABORT_ERR'
      ? 'aborted'
      : code === 'STT_OUTPUT_TOO_LARGE' ||
          code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? 'output_too_large'
        : code === 'EACCES' || code === 'EPERM'
          ? 'access_denied'
          : code === 'EAGAIN' || code === 'EMFILE' || code === 'ENFILE'
            ? 'transient_resource'
            : timeout
              ? 'process_timeout'
              : code === 'STT_OUTPUT_UNAVAILABLE'
                ? 'output_unavailable'
                : code === 'ENOENT'
                  ? 'missing_executable'
                  : stage === 'temporary_directory'
                    ? 'storage_failure'
                    : 'process_exit';
  return {
    stage,
    code: result,
    retryable: [
      'process_timeout',
      'transient_resource',
      'output_unavailable',
    ].includes(result),
  };
}
