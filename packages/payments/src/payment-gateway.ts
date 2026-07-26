import { readEnvFile } from '@skoobi/shared';

/**
 * Provider-neutral input for a hosted or otherwise externally fulfilled
 * payment. Individual providers own validation and translation into their
 * protocol.
 */
export type PaymentMethod = string;

export type PaymentClientInfo = {
  email?: string;
  phone?: string;
  name?: string;
  login?: string;
  country?: string;
  city?: string;
  address?: string;
  state?: string;
  zip?: string;
};

export type CreatePaymentInput = {
  /** Amount in major currency units, represented as a decimal string. */
  amount: string;
  /** Caller-generated idempotency and ownership key. */
  merchantTransactionId: string;
  description?: string;
  paymentMethods?: PaymentMethod[];
  returnUrl?: string;
  currency?: string;
  expiresInMinutes?: number;
  client?: PaymentClientInfo;
  customFields?: Record<string, string>;
};

export type CreatePaymentResult = {
  id: string;
  /** URL where the payer can complete the payment. */
  resultUrl: string;
  raw: unknown;
};

export type OrderInfo = {
  id: string;
  status: string;
  merchantTransactionId?: string;
  /**
   * A trusted provider adapter may set this only after it has independently
   * verified that the returned order belongs to the requested transaction.
   * Missing is deliberately equivalent to false.
   */
  bindingVerified?: boolean;
  amount?: string;
  amountCharged?: string;
  amountRefunded?: string;
  currency?: string;
  paid: boolean;
  final: boolean;
  raw: unknown;
};

export type PaymentErrorClass =
  | 'disabled'
  | 'config_error'
  | 'invalid_input'
  | 'auth_error'
  | 'timeout'
  | 'http_error'
  | 'invalid_response'
  | 'network_error'
  | 'provider_error';

export class PaymentGatewayError extends Error {
  readonly classification: PaymentErrorClass;
  readonly httpStatus?: number;

  constructor(
    message: string,
    classification: PaymentErrorClass,
    httpStatus?: number,
  ) {
    super(message);
    this.name = 'PaymentGatewayError';
    this.classification = classification;
    this.httpStatus = httpStatus;
  }
}

/**
 * The core package intentionally contains no payment transport. Deployments
 * opt into a provider adapter and register its factory at composition time.
 */
export type PaymentGatewayConfig = {
  enabled: boolean;
  provider: string;
  currency: string;
};

/** Non-secret status information safe for an adapter to expose. */
export type PaymentGatewaySummary = Readonly<PaymentGatewayConfig>;

export interface PaymentGateway {
  isEnabled(): boolean;
  describe(): PaymentGatewaySummary;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  getOrder(id: string): Promise<OrderInfo>;
}

export type PaymentProviderFactory = (
  config: Readonly<PaymentGatewayConfig>,
) => PaymentGateway;

const PROVIDER_ID_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_PROVIDER_ID_LENGTH = 64;
const providerFactories = new Map<string, PaymentProviderFactory>();

function boolFrom(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function stringFrom(value: unknown, fallback = ''): string {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function isValidProviderId(provider: unknown): provider is string {
  return (
    typeof provider === 'string' &&
    provider.length <= MAX_PROVIDER_ID_LENGTH &&
    PROVIDER_ID_RE.test(provider)
  );
}

function configError(message: string): PaymentGatewayError {
  return new PaymentGatewayError(message, 'config_error');
}

export function loadPaymentGatewayConfig(
  overrides: Partial<PaymentGatewayConfig> = {},
): PaymentGatewayConfig {
  const env = readEnvFile([
    'SKOOBI_PAYMENT_ENABLED',
    'SKOOBI_PAYMENT_PROVIDER',
    'SKOOBI_PAYMENT_CURRENCY',
  ]);

  return {
    enabled: boolFrom(
      overrides.enabled ??
        env.SKOOBI_PAYMENT_ENABLED ??
        process.env.SKOOBI_PAYMENT_ENABLED,
      false,
    ),
    provider: stringFrom(
      overrides.provider ??
        env.SKOOBI_PAYMENT_PROVIDER ??
        process.env.SKOOBI_PAYMENT_PROVIDER,
    ),
    currency: stringFrom(
      overrides.currency ??
        env.SKOOBI_PAYMENT_CURRENCY ??
        process.env.SKOOBI_PAYMENT_CURRENCY,
      'USD',
    )
      .trim()
      .toUpperCase(),
  };
}

/**
 * Register a deployment-owned provider adapter.
 *
 * Provider ids are deliberately narrow and case-sensitive so visually similar
 * or path-like values cannot address surprising registry entries. The returned
 * function is idempotent and unregisters only this exact factory.
 */
export function registerPaymentProvider(
  provider: string,
  factory: PaymentProviderFactory,
): () => void {
  if (!isValidProviderId(provider)) {
    throw configError('Payment provider id is invalid');
  }
  if (typeof factory !== 'function') {
    throw configError('Payment provider factory is invalid');
  }
  if (providerFactories.has(provider)) {
    throw configError('Payment provider is already registered');
  }

  providerFactories.set(provider, factory);
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    if (providerFactories.get(provider) === factory) {
      providerFactories.delete(provider);
    }
  };
}

/**
 * Resolve the configured adapter without performing any network operation.
 *
 * Disabled billing returns undefined before provider validation. Enabled
 * billing fails closed when an adapter is missing, unknown, malformed, throws,
 * or returns an invalid gateway object.
 */
export function createPaymentGateway(
  overrides: Partial<PaymentGatewayConfig> = {},
): PaymentGateway | undefined {
  const config = loadPaymentGatewayConfig(overrides);
  if (!config.enabled) return undefined;

  if (!config.provider) {
    throw configError('Payment provider is not configured');
  }
  if (!isValidProviderId(config.provider)) {
    throw configError('Payment provider id is invalid');
  }
  if (!CURRENCY_RE.test(config.currency)) {
    throw configError('Payment currency is invalid');
  }

  const factory = providerFactories.get(config.provider);
  if (!factory) {
    throw configError('Payment provider is not registered');
  }

  let gateway: PaymentGateway;
  let structurallyValid = false;
  try {
    gateway = factory(Object.freeze({ ...config }));
    structurallyValid = Boolean(
      gateway &&
        typeof gateway.isEnabled === 'function' &&
        typeof gateway.describe === 'function' &&
        typeof gateway.createPayment === 'function' &&
        typeof gateway.getOrder === 'function',
    );
  } catch {
    // Never copy an adapter exception message or cause: either can contain
    // credentials, request material, or deployment paths.
    throw configError('Payment provider could not be initialized');
  }

  if (!structurallyValid) {
    throw configError('Payment provider returned an invalid gateway');
  }

  return gateway;
}
