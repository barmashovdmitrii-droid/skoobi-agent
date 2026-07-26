import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockedEnv = vi.hoisted(() => ({
  values: {} as Record<string, string | undefined>,
}));

vi.mock('@skoobi/shared', () => ({
  readEnvFile: vi.fn(() => ({ ...mockedEnv.values })),
}));

import {
  PaymentGatewayError,
  createPaymentGateway,
  loadPaymentGatewayConfig,
  registerPaymentProvider,
  type CreatePaymentInput,
  type OrderInfo,
  type PaymentGateway,
  type PaymentGatewayConfig,
} from './payment-gateway.js';

const PAYMENT_ENV_KEYS = [
  'SKOOBI_PAYMENT_ENABLED',
  'SKOOBI_PAYMENT_PROVIDER',
  'SKOOBI_PAYMENT_CURRENCY',
] as const;

const originalProcessEnv = Object.fromEntries(
  PAYMENT_ENV_KEYS.map((key) => [key, process.env[key]]),
);
const unregisterAfterTest: Array<() => void> = [];

function fakeGateway(
  config: Readonly<PaymentGatewayConfig>,
  overrides: Partial<PaymentGateway> = {},
): PaymentGateway {
  return {
    isEnabled: () => config.enabled,
    describe: () => config,
    createPayment: async (input: CreatePaymentInput) => ({
      id: `order-${input.merchantTransactionId}`,
      resultUrl: 'about:blank',
      raw: null,
    }),
    getOrder: async (id: string): Promise<OrderInfo> => ({
      id,
      status: 'provider-defined',
      paid: false,
      final: false,
      raw: null,
    }),
    ...overrides,
  };
}

function register(
  provider: string,
  factory: (config: Readonly<PaymentGatewayConfig>) => PaymentGateway,
): () => void {
  const unregister = registerPaymentProvider(provider, factory);
  unregisterAfterTest.push(unregister);
  return unregister;
}

beforeEach(() => {
  mockedEnv.values = {};
  for (const key of PAYMENT_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  while (unregisterAfterTest.length) unregisterAfterTest.pop()?.();
  for (const key of PAYMENT_ENV_KEYS) {
    const original = originalProcessEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  vi.restoreAllMocks();
});

describe('loadPaymentGatewayConfig', () => {
  it('is disabled by default and has no implicit provider', () => {
    expect(loadPaymentGatewayConfig()).toEqual({
      enabled: false,
      provider: '',
      currency: 'USD',
    });
  });

  it('reads the three public settings from the env file', () => {
    mockedEnv.values = {
      SKOOBI_PAYMENT_ENABLED: 'yes',
      SKOOBI_PAYMENT_PROVIDER: 'hosted-checkout',
      SKOOBI_PAYMENT_CURRENCY: 'eur',
    };

    expect(loadPaymentGatewayConfig()).toEqual({
      enabled: true,
      provider: 'hosted-checkout',
      currency: 'EUR',
    });
  });

  it('falls back to process.env and lets explicit overrides win', () => {
    process.env.SKOOBI_PAYMENT_ENABLED = 'true';
    process.env.SKOOBI_PAYMENT_PROVIDER = 'process-provider';
    process.env.SKOOBI_PAYMENT_CURRENCY = 'gbp';

    expect(
      loadPaymentGatewayConfig({
        provider: 'override-provider',
        currency: 'cad',
      }),
    ).toEqual({
      enabled: true,
      provider: 'override-provider',
      currency: 'CAD',
    });
  });

  it('fails closed when the enabled flag is unrecognised', () => {
    process.env.SKOOBI_PAYMENT_ENABLED = 'perhaps';
    expect(loadPaymentGatewayConfig().enabled).toBe(false);
  });
});

describe('payment provider registry', () => {
  it('registers a provider and returns an idempotent unregister function', () => {
    const unregister = register('test-provider', fakeGateway);

    expect(
      createPaymentGateway({
        enabled: true,
        provider: 'test-provider',
        currency: 'USD',
      }),
    ).toBeDefined();

    unregister();
    unregister();

    expect(() =>
      createPaymentGateway({
        enabled: true,
        provider: 'test-provider',
        currency: 'USD',
      }),
    ).toThrowError(
      expect.objectContaining({
        classification: 'config_error',
        message: 'Payment provider is not registered',
      }),
    );
  });

  it('rejects duplicate provider ids', () => {
    register('duplicate-provider', fakeGateway);

    expect(() =>
      registerPaymentProvider('duplicate-provider', fakeGateway),
    ).toThrowError(
      expect.objectContaining({
        classification: 'config_error',
        message: 'Payment provider is already registered',
      }),
    );
  });

  it.each([
    '',
    'Uppercase',
    ' leading-space',
    'trailing-space ',
    'path/provider',
    'dot.provider',
    '_private',
    'double--separator',
    'a'.repeat(65),
  ])('rejects invalid provider id without echoing it: %j', (provider) => {
    let thrown: unknown;
    try {
      registerPaymentProvider(provider, fakeGateway);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PaymentGatewayError);
    expect(thrown).toMatchObject({ classification: 'config_error' });
    if (provider) {
      expect((thrown as Error).message).not.toContain(provider);
    }
  });

  it('rejects a non-function factory', () => {
    expect(() =>
      registerPaymentProvider(
        'invalid-factory',
        null as unknown as Parameters<typeof registerPaymentProvider>[1],
      ),
    ).toThrowError(
      expect.objectContaining({
        classification: 'config_error',
        message: 'Payment provider factory is invalid',
      }),
    );
  });
});

describe('createPaymentGateway', () => {
  it('returns undefined when disabled, even if the provider is invalid', () => {
    const factory = vi.fn(fakeGateway);
    register('unused-provider', factory);

    expect(
      createPaymentGateway({
        enabled: false,
        provider: '../invalid',
        currency: 'USD',
      }),
    ).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it('fails closed when enabled without a provider', () => {
    expect(() =>
      createPaymentGateway({ enabled: true, provider: '', currency: 'USD' }),
    ).toThrowError(
      expect.objectContaining({
        classification: 'config_error',
        message: 'Payment provider is not configured',
      }),
    );
  });

  it('fails closed for invalid and unknown providers', () => {
    expect(() =>
      createPaymentGateway({
        enabled: true,
        provider: '../invalid',
        currency: 'USD',
      }),
    ).toThrowError(
      expect.objectContaining({
        classification: 'config_error',
        message: 'Payment provider id is invalid',
      }),
    );

    expect(() =>
      createPaymentGateway({
        enabled: true,
        provider: 'not-registered',
        currency: 'USD',
      }),
    ).toThrowError(
      expect.objectContaining({
        classification: 'config_error',
        message: 'Payment provider is not registered',
      }),
    );
  });

  it('fails closed for an invalid currency before calling the adapter', () => {
    const factory = vi.fn(fakeGateway);
    register('currency-provider', factory);

    expect(() =>
      createPaymentGateway({
        enabled: true,
        provider: 'currency-provider',
        currency: 'not-a-currency',
      }),
    ).toThrowError(
      expect.objectContaining({
        classification: 'config_error',
        message: 'Payment currency is invalid',
      }),
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('passes an immutable, provider-neutral config to the factory', () => {
    const factory = vi.fn((config: Readonly<PaymentGatewayConfig>) => {
      expect(Object.isFrozen(config)).toBe(true);
      return fakeGateway(config);
    });
    register('example-provider', factory);

    const gateway = createPaymentGateway({
      enabled: true,
      provider: 'example-provider',
      currency: 'nzd',
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith({
      enabled: true,
      provider: 'example-provider',
      currency: 'NZD',
    });
    expect(gateway?.describe()).toEqual({
      enabled: true,
      provider: 'example-provider',
      currency: 'NZD',
    });
  });

  it('masks every factory exception, including secret-bearing messages', () => {
    const secret = 'credential-that-must-not-leak';
    register('throwing-provider', () => {
      throw new Error(`failed with ${secret}`);
    });

    let thrown: unknown;
    try {
      createPaymentGateway({
        enabled: true,
        provider: 'throwing-provider',
        currency: 'USD',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PaymentGatewayError);
    expect(thrown).toMatchObject({
      classification: 'config_error',
      message: 'Payment provider could not be initialized',
    });
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(String(thrown)).not.toContain(secret);
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('rejects a factory that returns a malformed gateway', () => {
    register('malformed-provider', () => ({}) as PaymentGateway);

    expect(() =>
      createPaymentGateway({
        enabled: true,
        provider: 'malformed-provider',
        currency: 'USD',
      }),
    ).toThrowError(
      expect.objectContaining({
        classification: 'config_error',
        message: 'Payment provider returned an invalid gateway',
      }),
    );
  });

  it('uses only the registered adapter and performs no built-in network call', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network must not be called'));
    const createPayment = vi.fn(async (input: CreatePaymentInput) => ({
      id: input.merchantTransactionId,
      resultUrl: 'about:blank',
      raw: null,
    }));
    const getOrder = vi.fn(
      async (id: string): Promise<OrderInfo> => ({
        id,
        status: 'adapter-owned',
        merchantTransactionId: 'merchant-1',
        bindingVerified: true,
        paid: true,
        final: true,
        raw: null,
      }),
    );
    register('local-adapter', (config) =>
      fakeGateway(config, { createPayment, getOrder }),
    );

    const gateway = createPaymentGateway({
      enabled: true,
      provider: 'local-adapter',
      currency: 'USD',
    });
    const created = await gateway?.createPayment({
      amount: '10.00',
      merchantTransactionId: 'merchant-1',
    });
    const order = await gateway?.getOrder(created?.id ?? '');

    expect(created?.id).toBe('merchant-1');
    expect(order).toMatchObject({
      merchantTransactionId: 'merchant-1',
      bindingVerified: true,
      paid: true,
    });
    expect(createPayment).toHaveBeenCalledOnce();
    expect(getOrder).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
