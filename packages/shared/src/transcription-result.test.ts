import { describe, expect, it } from 'vitest';
import {
  parseLocalTranscriptionResult,
  type LocalTranscriptionResult,
} from './transcription-result.js';
function fixture(): LocalTranscriptionResult {
  return {
    schema: 1,
    status: 'success',
    text: 'Synthetic text',
    originalText: 'Synthetic text',
    selectedPassIndex: 1,
    passes: [
      {
        index: 1,
        requestedLanguage: 'auto',
        detectedLanguage: 'en',
        languageProbability: 0.99,
        meanTokenLogProbability: -0.01,
        text: 'Synthetic text',
        valid: true,
        invalidReason: null,
        outcome: 'completed',
      },
    ],
    recheck: { reason: null, comparison: 'not_run', comparedPassIndices: [] },
    uncertainty: [],
    ambiguities: [],
    metrics: { queueWaitMs: 1, processingMs: 2, audioDurationMs: null },
  };
}
describe('private transcription evidence schema', () => {
  it('copies bounded actual evidence without manufacturing absent metrics', () => {
    const result = fixture();
    result.passes[0].languageProbability = null;
    expect(parseLocalTranscriptionResult(result)).toEqual(result);
    expect(parseLocalTranscriptionResult(result)).not.toBe(result);
  });
  it.each([
    'uncertain-success',
    'empty-doubtful',
    'changed-original',
    'invented-selected',
    'forged-variant',
    'foreign-field',
    'oversized',
    'duplicate-index',
    'false-retry',
    'object-status',
  ])('rejects inconsistent %s evidence', (kind) => {
    const result: any = fixture();
    if (kind === 'uncertain-success')
      result.uncertainty = ['number_disagreement'];
    if (kind === 'empty-doubtful') result.status = 'doubtful';
    if (kind === 'changed-original') result.originalText = 'Invented original';
    if (kind === 'invented-selected') result.text = 'Invented output';
    if (kind === 'foreign-field')
      result.passes[0].stderr = 'Private process payload';
    if (kind === 'oversized') result.passes[0].text = 'x'.repeat(65537);
    if (kind === 'duplicate-index') {
      result.passes.push({ ...result.passes[0] });
    }
    if (kind === 'object-status') result.status = { toString: () => 'success' };
    if (kind === 'false-retry') {
      result.status = 'technical_error';
      result.text = null;
      result.selectedPassIndex = null;
      result.error = {
        stage: 'configuration',
        code: 'missing_model',
        retryable: true,
      };
    }
    if (kind === 'forged-variant') {
      result.status = 'doubtful';
      result.uncertainty = ['possible_name_disagreement'];
      result.passes.push({ ...result.passes[0], index: 2 });
      result.recheck = {
        reason: 'low_language_probability',
        comparison: 'consistent',
        comparedPassIndices: [1, 2],
      };
      result.ambiguities = [
        {
          kind: 'possible_name',
          passIndices: [1, 2],
          variants: ['Invented name', 'Other invented name'],
        },
      ];
    }
    expect(parseLocalTranscriptionResult(result)).toBeUndefined();
  });
  it('requires comparison to cite distinct completed valid passes', () => {
    const result = fixture();
    result.recheck = {
      reason: 'low_language_probability',
      comparison: 'consistent',
      comparedPassIndices: [1, 1],
    };
    expect(parseLocalTranscriptionResult(result)).toBeUndefined();
    result.recheck.comparedPassIndices = [1, 2];
    expect(parseLocalTranscriptionResult(result)).toBeUndefined();
  });
});
