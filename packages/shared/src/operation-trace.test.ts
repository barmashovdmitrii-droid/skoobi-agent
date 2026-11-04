import { describe, expect, it, vi } from 'vitest';
import {
  sanitizeOperationTraceDetails,
  startOperationTraceStage,
  type OperationTraceDetails,
  type OperationTraceObserver,
} from './operation-trace.js';

describe('optional operation trace observers', () => {
  it('exports only fixed enums and bounded measured numbers, never arbitrary payloads', () => {
    const secret = 'synthetic-private-message-and-token';
    const input = {
      reason: secret,
      language: 'ru',
      deliveryKind: 'final',
      toolFamily: secret,
      bytes: 32,
      passCount: 3,
      languageProbability: 0.2,
      meanLogProbability: -0.7,
      text: secret,
      path: `/private/${secret}`,
      url: `https://example.invalid/${secret}`,
      error: new Error(secret),
      args: { token: secret },
    };
    const safe = sanitizeOperationTraceDetails(input);
    expect(safe).toEqual({
      language: 'ru',
      deliveryKind: 'final',
      bytes: 32,
      passCount: 3,
      languageProbability: 0.2,
      meanLogProbability: -0.7,
    });
    expect(JSON.stringify(safe)).not.toContain(secret);
  });

  it('drops counters that overflow, invalid probabilities and unknown enum values', () => {
    expect(
      sanitizeOperationTraceDetails({
        bytes: Number.MAX_SAFE_INTEGER + 1,
        passIndex: -1,
        passCount: 1001,
        toolCallCount: Infinity,
        queueWaitMs: NaN,
        audioDurationMs: -1,
        durationMs: 0.1,
        languageProbability: 1.1,
        meanLogProbability: 0.1,
        language: 'private-language',
        reason: 'invented_confidence',
      }),
    ).toEqual({});
    expect(
      sanitizeOperationTraceDetails({
        passCount: 0,
        languageProbability: 0,
        meanLogProbability: -100,
      }),
    ).toEqual({
      passCount: 0,
      languageProbability: 0,
      meanLogProbability: -100,
    });
  });

  it('does not let throwing getters or observer callbacks affect the caller', () => {
    expect(() =>
      sanitizeOperationTraceDetails(
        new Proxy(
          {},
          {
            get() {
              throw new Error('fixture');
            },
          },
        ),
      ),
    ).not.toThrow();
    const observer = {
      operationIds: [],
      startStage() {
        throw new Error('fixture');
      },
    } as OperationTraceObserver;
    expect(() =>
      startOperationTraceStage(observer, 'stt').finish('failed'),
    ).not.toThrow();
    expect(() =>
      startOperationTraceStage(undefined, 'stt').finish('failed'),
    ).not.toThrow();
  });

  it('sanitizes both callbacks and applies only the first terminal observation', () => {
    const finish = vi.fn(() => {
      throw new Error('fixture');
    });
    const startStage = vi.fn(() => ({ finish }));
    const observer = { operationIds: [], startStage };
    const details = {
      bytes: 1,
      text: 'synthetic-secret',
    } as OperationTraceDetails;
    const span = startOperationTraceStage(observer, 'download', details);
    expect(() => span.finish('unknown', details)).not.toThrow();
    span.finish('succeeded');
    expect(startStage).toHaveBeenCalledWith('download', { bytes: 1 });
    expect(finish).toHaveBeenCalledExactlyOnceWith('unknown', { bytes: 1 });
  });
});
