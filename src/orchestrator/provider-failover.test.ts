import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROVIDER_FAILOVER_POLICY,
  classifyProviderFailure,
  failedProviderAttempt,
  shouldFallbackToProvider,
} from './provider-failover.js';

describe('provider failover policy', () => {
  it('distinguishes the local guest isolation refusal from an unavailable provider', () => {
    const reason = classifyProviderFailure(new Error(
      'GUEST_CODEX_PROVIDER_BLOCKED: codex_cli is disabled for guest sandbox runs because Codex requires a readable auth.json',
    ));
    expect(reason).toBe('policy_blocked');
    expect(shouldFallbackToProvider(reason)).toBe(false);
  });

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
    expect(
      classifyProviderFailure(
        new Error('Claude usage limit exceeded; credit balance is too low'),
      ),
    ).toBe('rate_limit');
    expect(
      classifyProviderFailure(
        new Error("You've hit your limit · resets Jun 9 at 1am (Asia/Almaty)"),
      ),
    ).toBe('rate_limit');
    expect(classifyProviderFailure(new Error('API Error: 429'))).toBe(
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

  it('separates our own turn budget from link and runner timeouts', () => {
    expect(
      classifyProviderFailure(new Error('codex turn timed out after 900000ms')),
    ).toBe('timeout');
    // The runner's idle stop keeps the same prefix, so it is a turn timeout
    // too (ignored by a closed breaker), not a link failure.
    expect(
      classifyProviderFailure(
        new Error('codex turn timed out: no activity for 600000ms'),
      ),
    ).toBe('timeout');
    expect(
      classifyProviderFailure(
        new Error('stream error: connection timed out while reading'),
      ),
    ).toBe('unavailable');
    expect(
      classifyProviderFailure(new Error('Sandbox timed out after 1830000ms')),
    ).toBe('runtime_error');
    expect(
      classifyProviderFailure(new Error('codex produced no final message')),
    ).toBe('empty_output');
    // A stream error still carries its real cause.
    expect(
      classifyProviderFailure(new Error('stream error: unexpected status 401')),
    ).toBe('auth_error');
    expect(
      classifyProviderFailure(
        new Error('stream disconnected before completion: usage limit reached'),
      ),
    ).toBe('rate_limit');
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

  it('can record Claude SDK as the failed primary when Codex is reserve', () => {
    expect(
      failedProviderAttempt({
        provider: 'claude_sdk',
        reason: 'runtime_error',
      }),
    ).toEqual({
      provider: 'claude_sdk',
      status: 'failed',
      reason: 'runtime_error',
      latency_ms: undefined,
      trace_id: undefined,
    });
  });

  it('calls an overloaded provider by its name and still allows the fallback', () => {
    // Capacity errors are provider overload, not a generic runtime failure.
    // The runner retries first; the host then reports the actual category.
    const reason = classifyProviderFailure(
      new Error('Selected model is at capacity. Please try a different model.'),
    );
    expect(reason).toBe('model_overloaded');
    expect(shouldFallbackToProvider(reason)).toBe(true);
    expect(
      classifyProviderFailure(
        new Error('stream disconnected before completion: server overloaded'),
      ),
    ).toBe('model_overloaded');
    // The new wording steals neither the model-unavailable nor the auth case.
    expect(classifyProviderFailure(new Error('Codex model unavailable'))).toBe(
      'model_unavailable',
    );
    expect(
      classifyProviderFailure(new Error('stream error: unexpected status 401')),
    ).toBe('auth_error');
  });
});
