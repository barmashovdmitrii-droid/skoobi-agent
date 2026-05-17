export type ProviderRuntime = 'codex_subscription_cli' | 'claude_sdk';

export type ProviderFailoverReason =
  | 'unavailable'
  | 'auth_error'
  | 'timeout'
  | 'empty_output'
  | 'runtime_error'
  | 'rate_limit'
  | 'model_unavailable'
  | 'circuit_open';

export type ProviderAttempt = {
  provider: ProviderRuntime;
  status: 'success' | 'failed' | 'skipped';
  reason?: ProviderFailoverReason;
  latency_ms?: number;
  trace_id?: string;
};

export type ProviderFailoverPolicy = {
  primary: 'codex_subscription_cli';
  fallback: 'claude_sdk';
  fallback_on: ProviderFailoverReason[];
};

export const DEFAULT_PROVIDER_FAILOVER_POLICY: ProviderFailoverPolicy = {
  primary: 'codex_subscription_cli',
  fallback: 'claude_sdk',
  fallback_on: [
    'unavailable',
    'auth_error',
    'timeout',
    'empty_output',
    'runtime_error',
    'rate_limit',
    'model_unavailable',
    'circuit_open',
  ],
};

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function classifyProviderFailure(err: unknown): ProviderFailoverReason {
  const name = errorName(err);
  const message = errorMessage(err).toLowerCase();
  const classification =
    err && typeof err === 'object' && 'classification' in err
      ? String((err as { classification?: unknown }).classification)
      : '';

  if (name === 'AbortError' || message.includes('timed out')) {
    return 'timeout';
  }
  if (classification === 'model_unavailable') {
    return 'model_unavailable';
  }
  if (classification === 'auth') return 'auth_error';
  if (classification === 'rate_limit') return 'rate_limit';
  if (classification === 'empty_output') return 'empty_output';
  if (classification === 'transient') return 'runtime_error';
  if (message.includes('circuit open')) {
    return 'circuit_open';
  }
  if (
    message.includes('model unavailable') ||
    message.includes('model is unavailable') ||
    message.includes('model not available') ||
    message.includes('not supported') ||
    message.includes('unknown model') ||
    message.includes('model not found')
  ) {
    return 'model_unavailable';
  }
  if (
    name === 'ModelGatewayNotConfiguredError' ||
    name === 'CodexSubscriptionUnavailableError' ||
    message.includes('not configured') ||
    message.includes('disabled') ||
    message.includes('not installed') ||
    message.includes('unavailable')
  ) {
    return 'unavailable';
  }
  if (
    message.includes('not logged in') ||
    message.includes('auth') ||
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('401') ||
    message.includes('403')
  ) {
    return 'auth_error';
  }
  if (message.includes('rate limit') || message.includes('rate_limit')) {
    return 'rate_limit';
  }
  if (
    message.includes('empty final answer') ||
    message.includes('empty output')
  ) {
    return 'empty_output';
  }
  return 'runtime_error';
}

export function shouldFallbackToProvider(
  reason: ProviderFailoverReason,
  policy: ProviderFailoverPolicy = DEFAULT_PROVIDER_FAILOVER_POLICY,
): boolean {
  return policy.fallback_on.includes(reason);
}

export function failedProviderAttempt(input: {
  reason: ProviderFailoverReason;
  latencyMs?: number;
  traceId?: string;
  provider?: ProviderRuntime;
}): ProviderAttempt {
  return {
    provider: input.provider || DEFAULT_PROVIDER_FAILOVER_POLICY.primary,
    status: 'failed',
    reason: input.reason,
    latency_ms: input.latencyMs,
    trace_id: input.traceId,
  };
}
