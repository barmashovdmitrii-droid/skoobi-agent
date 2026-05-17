import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROVIDER_FAILOVER_POLICY,
  classifyProviderFailure,
  failedProviderAttempt,
  shouldFallbackToProvider,
} from './provider-failover.js';

describe('provider failover policy', () => {
  it('falls back from Codex subscription failures to Claude SDK for supported reasons', () => {
    for (const reason of DEFAULT_PROVIDER_FAILOVER_POLICY.fallback_on) {
      expect(shouldFallbackToProvider(reason)).toBe(true);
    }
  });

  it('classifies common Codex/OpenAI subscription failures without exposing secrets', () => {
    expect(
      classifyProviderFailure(new Error('Codex CLI is not installed')),
    ).toBe('unavailable');
    expect(
      classifyProviderFailure(new Error('Codex CLI is not logged in')),
    ).toBe('auth_error');
    expect(classifyProviderFailure(new Error('Codex CLI rate limited'))).toBe(
      'rate_limit',
    );
    expect(classifyProviderFailure(new Error('Codex model unavailable'))).toBe(
      'model_unavailable',
    );
    expect(
      classifyProviderFailure(
        new Error('model is not supported when using Codex with ChatGPT'),
      ),
    ).toBe('model_unavailable');
    expect(classifyProviderFailure(new Error('Codex CLI timed out'))).toBe(
      'timeout',
    );
    expect(
      classifyProviderFailure(
        new Error('Codex CLI returned an empty final answer'),
      ),
    ).toBe('empty_output');
  });

  it('creates a failed primary provider attempt record', () => {
    expect(
      failedProviderAttempt({
        reason: 'rate_limit',
        latencyMs: 1234,
        traceId: 'trace-1',
      }),
    ).toEqual({
      provider: 'codex_subscription_cli',
      status: 'failed',
      reason: 'rate_limit',
      latency_ms: 1234,
      trace_id: 'trace-1',
    });
  });
});
