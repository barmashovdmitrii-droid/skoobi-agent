import { afterEach, describe, expect, it } from 'vitest';

import {
  EMPTY_PAYMENT_PLAN_CATALOG,
  buildPlanPaymentInput,
  getPlan,
  loadPaymentPlanCatalog,
  planFromStartPayload,
  planMerchantTransactionId,
  planQuotaTarget,
  type PaymentPlan,
} from './payment-plans.js';

const priorCatalogEnv = process.env.SKOOBI_PAYMENT_CATALOG_JSON;

function credentialBearingUrl(host: string, pathname: string): string {
  const url = new URL(`https://${host}${pathname}`);
  url.username = 'fixture-user';
  url.password = 'fixture-password';
  return url.href;
}

afterEach(() => {
  if (priorCatalogEnv === undefined) {
    delete process.env.SKOOBI_PAYMENT_CATALOG_JSON;
  } else {
    process.env.SKOOBI_PAYMENT_CATALOG_JSON = priorCatalogEnv;
  }
});

const SYNTHETIC_EXAMPLE_CATALOG = [
  {
    code: 'basic',
    amountMajor: '10.00',
    currency: 'USD',
    prices: { USD: '10.00' },
    free: false,
    weeklyLimitCredits: 100,
    quotaEnabled: true,
    periodDays: 30,
    titles: { en: 'Synthetic Basic' },
  },
  {
    code: 'team',
    amountMajor: '25.00',
    currency: 'USD',
    prices: { USD: '25.00' },
    free: false,
    weeklyLimitCredits: 250,
    quotaEnabled: true,
    periodDays: 30,
    methods: ['card'],
    titles: { en: 'Synthetic Team' },
  },
] as const;

function catalogJson(value: unknown = SYNTHETIC_EXAMPLE_CATALOG): string {
  return JSON.stringify(value);
}

function loadSyntheticCatalog() {
  return loadPaymentPlanCatalog(catalogJson());
}

function syntheticPlan(code: 'basic' | 'team' = 'basic'): PaymentPlan {
  const plan = getPlan(code, loadSyntheticCatalog());
  if (!plan) throw new Error('Synthetic fixture is missing');
  return plan;
}

describe('loadPaymentPlanCatalog', () => {
  it('fails closed to the same frozen empty catalog without configuration', () => {
    process.env.SKOOBI_PAYMENT_CATALOG_JSON = '';
    expect(loadPaymentPlanCatalog()).toBe(EMPTY_PAYMENT_PLAN_CATALOG);
    expect(Object.keys(EMPTY_PAYMENT_PLAN_CATALOG)).toEqual([]);
    expect(Object.isFrozen(EMPTY_PAYMENT_PLAN_CATALOG)).toBe(true);
  });

  it('loads an explicit, immutable synthetic catalog', () => {
    const catalog = loadSyntheticCatalog();
    expect(Object.keys(catalog)).toEqual(['basic', 'team']);
    expect(getPlan('basic', catalog)).toMatchObject({
      code: 'basic',
      amountMajor: '10.00',
      currency: 'USD',
      prices: { USD: '10.00' },
    });
    expect(getPlan('team', catalog)?.amountMajor).toBe('25.00');
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.basic)).toBe(true);
    expect(Object.isFrozen(catalog.basic.prices)).toBe(true);
    expect(Object.isFrozen(catalog.basic.titles)).toBe(true);
  });

  it('loads from the process environment when no override is supplied', () => {
    process.env.SKOOBI_PAYMENT_CATALOG_JSON = catalogJson();
    const catalog = loadPaymentPlanCatalog();
    expect(getPlan('team', catalog)?.code).toBe('team');
  });

  it('lets an explicit blank override disable an environment catalog', () => {
    process.env.SKOOBI_PAYMENT_CATALOG_JSON = catalogJson();
    expect(loadPaymentPlanCatalog('')).toBe(EMPTY_PAYMENT_PLAN_CATALOG);
  });

  it.each([
    ['an object root', {}],
    ['a primitive plan', [true]],
    [
      'an unknown field',
      [{ ...SYNTHETIC_EXAMPLE_CATALOG[0], internalNote: 'not allowed' }],
    ],
    [
      'a missing field',
      [
        Object.fromEntries(
          Object.entries(SYNTHETIC_EXAMPLE_CATALOG[0]).filter(
            ([key]) => key !== 'periodDays',
          ),
        ),
      ],
    ],
    ['an unsafe code', [{ ...SYNTHETIC_EXAMPLE_CATALOG[0], code: '../basic' }]],
    [
      'a non-ISO-like currency',
      [{ ...SYNTHETIC_EXAMPLE_CATALOG[0], currency: 'US' }],
    ],
    [
      'an invalid amount',
      [{ ...SYNTHETIC_EXAMPLE_CATALOG[0], amountMajor: '10.000' }],
    ],
    [
      'a missing active-currency price',
      [{ ...SYNTHETIC_EXAMPLE_CATALOG[0], prices: { ZZZ: '10.00' } }],
    ],
    [
      'a mismatched active-currency price',
      [
        {
          ...SYNTHETIC_EXAMPLE_CATALOG[0],
          prices: { USD: '11.00' },
        },
      ],
    ],
    [
      'a free plan with a charge',
      [{ ...SYNTHETIC_EXAMPLE_CATALOG[0], free: true }],
    ],
    [
      'a negative weekly entitlement',
      [{ ...SYNTHETIC_EXAMPLE_CATALOG[0], weeklyLimitCredits: -1 }],
    ],
    [
      'an inconsistent disabled quota',
      [{ ...SYNTHETIC_EXAMPLE_CATALOG[0], quotaEnabled: false }],
    ],
    ['an invalid period', [{ ...SYNTHETIC_EXAMPLE_CATALOG[0], periodDays: 0 }]],
    ['empty titles', [{ ...SYNTHETIC_EXAMPLE_CATALOG[0], titles: {} }]],
    [
      'an unsafe method id',
      [{ ...SYNTHETIC_EXAMPLE_CATALOG[0], methods: ['../method'] }],
    ],
  ])('rejects %s', (_label, value) => {
    expect(() => loadPaymentPlanCatalog(catalogJson(value))).toThrow();
  });

  it('rejects duplicate plan codes', () => {
    expect(() =>
      loadPaymentPlanCatalog(
        catalogJson([
          SYNTHETIC_EXAMPLE_CATALOG[0],
          { ...SYNTHETIC_EXAMPLE_CATALOG[1], code: 'basic' },
        ]),
      ),
    ).toThrow(/duplicate/i);
  });

  it('rejects more than 50 plans and oversized JSON', () => {
    const tooMany = Array.from({ length: 51 }, (_, index) => ({
      ...SYNTHETIC_EXAMPLE_CATALOG[0],
      code: `basic-${index}`,
    }));
    expect(() => loadPaymentPlanCatalog(catalogJson(tooMany))).toThrow(
      /exceeds 50/i,
    );
    expect(() => loadPaymentPlanCatalog(` ${'x'.repeat(64 * 1024)}`)).toThrow(
      /too large/i,
    );
  });

  it('accepts a truly free plan only when it has no charge', () => {
    const freeBasic = {
      ...SYNTHETIC_EXAMPLE_CATALOG[0],
      amountMajor: '',
      prices: {},
      free: true,
    };
    const plan = getPlan(
      'basic',
      loadPaymentPlanCatalog(catalogJson([freeBasic])),
    );
    expect(plan).toMatchObject({ free: true, amountMajor: '', prices: {} });
  });
});

describe('catalog lookup', () => {
  it('requires a catalog and rejects unknown values', () => {
    const catalog = loadSyntheticCatalog();
    expect(getPlan('basic', catalog)?.code).toBe('basic');
    expect(getPlan('unknown', catalog)).toBeUndefined();
  });

  it('resolves only bare configured codes from generic start values', () => {
    const catalog = loadSyntheticCatalog();
    expect(planFromStartPayload('basic', catalog)?.code).toBe('basic');
    expect(planFromStartPayload('BASIC', catalog)?.code).toBe('basic');
    expect(planFromStartPayload('not-configured', catalog)).toBeUndefined();
    expect(planFromStartPayload(undefined, catalog)).toBeUndefined();
  });
});

describe('buildPlanPaymentInput', () => {
  it('builds a provider-neutral charge input', () => {
    const input = buildPlanPaymentInput(syntheticPlan('basic'), {
      merchantTransactionId: 'order_basic_customer_1',
      customerId: 'customer-1',
      applicationId: 'example-app',
      productName: 'Example Product',
      returnUrl: 'https://example.invalid/complete',
      customFields: {
        campaign: 'synthetic',
        planCode: 'caller-cannot-override',
      },
    });

    expect(input).toMatchObject({
      amount: '10.00',
      currency: 'USD',
      merchantTransactionId: 'order_basic_customer_1',
      description: 'Example Product basic',
      returnUrl: 'https://example.invalid/complete',
      customFields: {
        campaign: 'synthetic',
        planCode: 'basic',
        purpose: 'plan:basic',
        customerId: 'customer-1',
        applicationId: 'example-app',
      },
    });
    expect(input.paymentMethods).toBeUndefined();
  });

  it('passes explicitly configured methods without sharing the frozen array', () => {
    const plan = syntheticPlan('team');
    const input = buildPlanPaymentInput(plan, {
      merchantTransactionId: 'order_team_customer_1',
    });
    expect(input.paymentMethods).toEqual(['card']);
    expect(input.paymentMethods).not.toBe(plan.methods);
  });

  it('fails closed for an unavailable currency', () => {
    expect(() =>
      buildPlanPaymentInput(syntheticPlan(), {
        merchantTransactionId: 'order_basic_customer_1',
        currency: 'ZZZ',
      }),
    ).toThrow(/no valid price/i);
  });

  it('allows HTTPS and local HTTP return URLs but rejects unsafe URLs', () => {
    expect(
      buildPlanPaymentInput(syntheticPlan(), {
        merchantTransactionId: 'order_basic_customer_1',
        returnUrl: 'http://localhost:3000/complete',
      }).returnUrl,
    ).toBe('http://localhost:3000/complete');
    for (const returnUrl of [
      'http://example.invalid/complete',
      'javascript:alert(1)',
      credentialBearingUrl('example.invalid', '/complete'),
      `https://example.invalid/${'x'.repeat(2_048)}`,
    ]) {
      expect(() =>
        buildPlanPaymentInput(syntheticPlan(), {
          merchantTransactionId: 'order_basic_customer_1',
          returnUrl,
        }),
      ).toThrow(/returnUrl/i);
    }
  });

  it('refuses a free plan and an unsafe merchant id', () => {
    const freeBasic = loadPaymentPlanCatalog(
      catalogJson([
        {
          ...SYNTHETIC_EXAMPLE_CATALOG[0],
          amountMajor: '',
          prices: {},
          free: true,
        },
      ]),
    ).basic;
    expect(() =>
      buildPlanPaymentInput(freeBasic, {
        merchantTransactionId: 'order_basic_customer_1',
      }),
    ).toThrow(/free/i);
    expect(() =>
      buildPlanPaymentInput(syntheticPlan(), {
        merchantTransactionId: '../unsafe',
      }),
    ).toThrow(/merchantTransactionId/i);
  });
});

describe('planMerchantTransactionId', () => {
  it('builds a stable generic id without exposing the customer identifier', () => {
    const first = planMerchantTransactionId(
      syntheticPlan(),
      'customer:42',
      'n-1',
    );
    const second = planMerchantTransactionId(
      syntheticPlan(),
      'customer:42',
      'n-1',
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^order_basic_[a-f0-9]{40}$/);
    expect(first).not.toContain('customer');
  });

  it('bounds the output, separates raw inputs, and rejects invalid material', () => {
    const id = planMerchantTransactionId(
      syntheticPlan('team'),
      'c'.repeat(100),
      'n'.repeat(100),
      'p'.repeat(100),
    );
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(planMerchantTransactionId(syntheticPlan(), 'a/b', 'nonce')).not.toBe(
      planMerchantTransactionId(syntheticPlan(), 'ab', 'nonce'),
    );
    expect(() =>
      planMerchantTransactionId(syntheticPlan(), '', 'nonce'),
    ).toThrow(/customer id/i);
    expect(() =>
      planMerchantTransactionId(syntheticPlan(), 'customer', '\n'),
    ).toThrow(/nonce/i);
  });
});

describe('planQuotaTarget', () => {
  it('returns the configured weekly entitlement without a hidden formula', () => {
    expect(planQuotaTarget(syntheticPlan('team'))).toEqual({
      weeklyLimitCredits: 250,
      quotaEnabled: true,
    });
  });
});
