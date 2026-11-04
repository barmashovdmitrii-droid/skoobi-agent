export type ProviderRuntime = 'codex_subscription_cli' | 'claude_sdk';

export type ProviderFailoverReason =
  | 'policy_blocked'
  | 'unavailable'
  | 'auth_error'
  | 'timeout'
  | 'empty_output'
  | 'runtime_error'
  | 'rate_limit'
  | 'model_unavailable'
  // The provider is overloaded: waiting can help; changing auth cannot.
  | 'model_overloaded'
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
    'model_overloaded',
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
  // A local isolation refusal says nothing about provider availability.
  if (message.includes('guest_codex_provider_blocked')) {
    return 'policy_blocked';
  }
  const classification =
    err && typeof err === 'object' && 'classification' in err
      ? String((err as { classification?: unknown }).classification)
      : '';

  // Only our own turn budget running out is a benign «task too long»: the
  // model was working. A link that timed out is an outage, and a sandbox that
  // timed out is a wedged runner — both must count toward the breaker and
  // must not get the «всё сохранено, напиши продолжай» reply. The network
  // cases are decided below, after auth and limits, so a «stream error: 401»
  // or «stream disconnected … usage limit» keeps its own meaning.
  if (message.includes('codex turn timed out')) return 'timeout';
  if (message.includes('sandbox timed out')) return 'runtime_error';
  const linkTimedOut =
    /connection timed out|operation timed out|etimedout|stream (?:error|disconnected)/.test(
      message,
    );
  if (
    !linkTimedOut &&
    (name === 'AbortError' || message.includes('timed out'))
  ) {
    return 'timeout';
  }
  if (classification === 'model_unavailable') {
    return 'model_unavailable';
  }
  if (classification === 'unavailable') return 'unavailable';
  if (classification === 'auth') return 'auth_error';
  if (classification === 'auth_error') return 'auth_error';
  if (classification === 'timeout') return 'timeout';
  if (classification === 'rate_limit') return 'rate_limit';
  if (classification === 'empty_output') return 'empty_output';
  if (classification === 'transient') return 'runtime_error';
  if (classification === 'runtime_error') return 'runtime_error';
  if (message.includes('circuit open')) {
    return 'circuit_open';
  }
  // «Selected model is at capacity» and the gateway's «overloaded»: the provider is
  // busy, not misconfigured. Decided before the model/availability wordings
  // so the user hears «перегружена», not «причина не установлена»; the runner
  // has already retried it 2/15/45 s before the error reaches us.
  if (message.includes('at capacity') || message.includes('overloaded')) {
    return 'model_overloaded';
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
  if (
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('hit your limit') ||
    message.includes('too many requests') ||
    message.includes('usage limit') ||
    message.includes('quota') ||
    message.includes('credit balance') ||
    message.includes('credits exhausted') ||
    message.includes('limit exceeded') ||
    /\b429\b/.test(message)
  ) {
    return 'rate_limit';
  }
  if (
    message.includes('empty final answer') ||
    message.includes('empty output') ||
    message.includes('produced no final message')
  ) {
    return 'empty_output';
  }
  if (linkTimedOut) return 'unavailable';
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
