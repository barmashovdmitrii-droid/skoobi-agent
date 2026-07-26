import fs from 'fs';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CreatePaymentInput,
  CreatePaymentResult,
  OrderInfo,
} from './payment-gateway.js';
import {
  planMerchantTransactionId,
  type PaymentPlan,
  type PlanCatalog,
} from './payment-plans.js';
import {
  SubscriptionStore,
  confirmPlanPurchase,
  isGatewayDown,
  isReversedOrRefunded,
  planOrderMismatchReason,
  reconcileActiveSubscriptions,
  runPaymentPollingSweep,
  startPlanPurchase,
  type SubscriptionRecord,
} from './payment-service.js';

const DIR = '/tmp/skoobi-payment-service-test';
const FILE = `${DIR}/subscriptions.json`;
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const PURCHASE_ID = 'purchase-1';

function credentialBearingUrl(host: string, pathname: string): string {
  const url = new URL(`https://${host}${pathname}`);
  url.username = 'fixture-user';
  url.password = 'fixture-password';
  return url.href;
}

const BASIC_PLAN: PaymentPlan = Object.freeze({
  code: 'basic',
  amountMajor: '10.00',
  currency: 'USD',
  prices: Object.freeze({ USD: '10.00', EUR: '9.00' }),
  free: false,
  weeklyLimitCredits: 100,
  quotaEnabled: true,
  periodDays: 30,
  titles: Object.freeze({ en: 'Basic example' }),
});

const FREE_PLAN: PaymentPlan = Object.freeze({
  code: 'community',
  amountMajor: '',
  currency: 'USD',
  prices: Object.freeze({}),
  free: true,
  weeklyLimitCredits: 25,
  quotaEnabled: true,
  periodDays: 30,
  titles: Object.freeze({ en: 'Community example' }),
});

const IDENTITY_SCOPE = createHash('sha256')
  .update(
    JSON.stringify([
      'tenant-example',
      'example',
      'customer',
      'chat:customer',
      'customer',
      'test-app',
    ]),
  )
  .digest('hex');
const TX_ID = planMerchantTransactionId(
  BASIC_PLAN,
  IDENTITY_SCOPE,
  PURCHASE_ID,
);

const CATALOG: PlanCatalog = Object.freeze({
  basic: BASIC_PLAN,
  community: FREE_PLAN,
});

beforeEach(() => fs.rmSync(DIR, { recursive: true, force: true }));
afterEach(() => fs.rmSync(DIR, { recursive: true, force: true }));

function order(partial: Partial<OrderInfo> = {}): OrderInfo {
  return {
    id: 'ORDER1',
    status: 'pending',
    paid: false,
    final: false,
    raw: {},
    ...partial,
  };
}

function record(partial: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    orderId: 'ORDER1',
    merchantTransactionId: TX_ID,
    jid: 'chat:customer',
    channel: 'example',
    tenantId: 'tenant-example',
    channelUserId: 'customer',
    planCode: 'basic',
    amount: '10.00',
    currency: 'USD',
    periodDays: 30,
    weeklyLimitCredits: 100,
    quotaEnabled: true,
    status: 'pending',
    createdAt: new Date(NOW).toISOString(),
    ...partial,
  };
}

function paidOrder(partial: Partial<OrderInfo> = {}): OrderInfo {
  return order({
    status: 'paid',
    paid: true,
    final: true,
    merchantTransactionId: TX_ID,
    amount: '10.00',
    amountCharged: '10.00',
    currency: 'USD',
    ...partial,
  });
}

function fakeGateway(
  options: {
    create?: Partial<CreatePaymentResult>;
    getOrder?: (orderId: string) => Promise<OrderInfo>;
  } = {},
) {
  const createPayment = vi.fn(async (_input: CreatePaymentInput) => ({
    id: 'ORDER1',
    resultUrl: 'https://checkout.example.invalid/order/ORDER1',
    raw: {},
    ...options.create,
  }));
  const getOrder = vi.fn(options.getOrder ?? (async () => order()));
  return { createPayment, getOrder };
}

async function seedPending(
  store = new SubscriptionStore(FILE),
): Promise<SubscriptionStore> {
  await startPlanPurchase(
    { gateway: fakeGateway(), store, now: () => NOW },
    {
      plan: BASIC_PLAN,
      jid: 'chat:customer',
      channel: 'example',
      customerId: 'customer',
      purchaseId: PURCHASE_ID,
      tenantId: 'tenant-example',
      channelUserId: 'customer',
      applicationId: 'test-app',
    },
  );
  return store;
}

describe('startPlanPurchase', () => {
  it('creates one order and stores the exact charged amount', async () => {
    const store = new SubscriptionStore(FILE);
    const gateway = fakeGateway();
    const result = await startPlanPurchase(
      { gateway, store, now: () => NOW },
      {
        plan: BASIC_PLAN,
        jid: 'chat:customer',
        channel: 'example',
        customerId: 'customer',
        purchaseId: PURCHASE_ID,
        tenantId: 'tenant-example',
        channelUserId: 'customer',
        applicationId: 'test-app',
      },
    );

    expect(result.resultUrl).toBe(
      'https://checkout.example.invalid/order/ORDER1',
    );
    expect(gateway.createPayment).toHaveBeenCalledTimes(1);
    expect(
      gateway.createPayment.mock.calls[0]?.[0].customFields?.customerId,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(
      gateway.createPayment.mock.calls[0]?.[0].customFields?.customerId,
    ).not.toContain('customer');
    expect(store.getByOrder('ORDER1')).toMatchObject({
      orderId: 'ORDER1',
      merchantTransactionId: TX_ID,
      jid: 'chat:customer',
      channel: 'example',
      planCode: 'basic',
      amount: '10.00',
      currency: 'USD',
      status: 'pending',
    });
  });

  it('records the selected-currency price sent to the gateway', async () => {
    const store = new SubscriptionStore(FILE);
    const plan: PaymentPlan = {
      ...BASIC_PLAN,
      currency: 'EUR',
      amountMajor: '9.00',
    };
    await startPlanPurchase(
      { gateway: fakeGateway(), store, now: () => NOW },
      {
        plan,
        jid: 'chat:customer',
        channel: 'example',
        customerId: 'customer',
        purchaseId: 'purchase-eur',
        tenantId: 'tenant-example',
        channelUserId: 'customer',
        applicationId: 'test-app',
      },
    );
    expect(store.getByOrder('ORDER1')).toMatchObject({
      amount: '9.00',
      currency: 'EUR',
    });
  });

  it('never sends a charge for a free plan', async () => {
    const gateway = fakeGateway();
    await expect(
      startPlanPurchase(
        {
          gateway,
          store: new SubscriptionStore(FILE),
          now: () => NOW,
        },
        {
          plan: FREE_PLAN,
          jid: 'chat:customer',
          channel: 'example',
          customerId: 'customer',
          purchaseId: PURCHASE_ID,
          tenantId: 'tenant-example',
          channelUserId: 'customer',
        },
      ),
    ).rejects.toThrow(/free/i);
    expect(gateway.createPayment).not.toHaveBeenCalled();
  });

  it('reuses one stored checkout for a retry with the same purchase id', async () => {
    const store = new SubscriptionStore(FILE);
    const gateway = fakeGateway();
    const params = {
      plan: BASIC_PLAN,
      jid: 'chat:customer',
      channel: 'example',
      customerId: 'customer',
      purchaseId: PURCHASE_ID,
      tenantId: 'tenant-example',
      channelUserId: 'customer',
      applicationId: 'test-app',
    };

    const first = await startPlanPurchase(
      { gateway, store, now: () => NOW },
      params,
    );
    const retry = await startPlanPurchase(
      { gateway, store, now: () => NOW + 1_000 },
      params,
    );

    expect(retry).toEqual(first);
    expect(gateway.createPayment).toHaveBeenCalledTimes(1);
    expect(store.listPending()).toHaveLength(1);
  });

  it('scopes the same purchase id to the full tenant identity', async () => {
    const store = new SubscriptionStore(FILE);
    let sequence = 0;
    const createPayment = vi.fn(async (_input: CreatePaymentInput) => {
      sequence += 1;
      return {
        id: `ORDER${sequence}`,
        resultUrl: `https://checkout.example.invalid/order/ORDER${sequence}`,
        raw: {},
      };
    });
    const base = {
      plan: BASIC_PLAN,
      jid: 'chat:customer',
      channel: 'example',
      customerId: 'customer',
      purchaseId: PURCHASE_ID,
      tenantId: 'tenant-example',
      channelUserId: 'customer',
      applicationId: 'test-app',
    };

    await startPlanPurchase({ gateway: { createPayment }, store }, base);
    await startPlanPurchase(
      { gateway: { createPayment }, store },
      {
        ...base,
        jid: 'chat:other',
        tenantId: 'tenant-other',
      },
    );

    expect(createPayment).toHaveBeenCalledTimes(2);
    const firstInput = createPayment.mock.calls[0]?.[0];
    const secondInput = createPayment.mock.calls[1]?.[0];
    expect(firstInput?.merchantTransactionId).not.toBe(
      secondInput?.merchantTransactionId,
    );
  });

  it('rejects invalid identities before asking the provider to charge', async () => {
    const gateway = fakeGateway();
    await expect(
      startPlanPurchase(
        { gateway, store: new SubscriptionStore(FILE) },
        {
          plan: BASIC_PLAN,
          jid: 'chat:customer',
          channel: 'example',
          customerId: 'customer',
          purchaseId: PURCHASE_ID,
          tenantId: '',
          channelUserId: 'customer',
        },
      ),
    ).rejects.toThrow(/tenantId/i);
    expect(gateway.createPayment).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid order id', { id: '__proto__' }, /invalid order id/i],
    [
      'unsafe checkout protocol',
      { resultUrl: 'javascript:alert(1)' },
      /invalid checkout URL/i,
    ],
    [
      'credential-bearing checkout URL',
      {
        resultUrl: credentialBearingUrl(
          'checkout.example.invalid',
          '/order/ORDER1',
        ),
      },
      /invalid checkout URL/i,
    ],
  ])(
    'rejects an %s response without persisting it',
    async (_label, create, error) => {
      const store = new SubscriptionStore(FILE);
      await expect(
        startPlanPurchase(
          { gateway: fakeGateway({ create }), store },
          {
            plan: BASIC_PLAN,
            jid: 'chat:customer',
            channel: 'example',
            customerId: 'customer',
            purchaseId: PURCHASE_ID,
            tenantId: 'tenant-example',
            channelUserId: 'customer',
            applicationId: 'test-app',
          },
        ),
      ).rejects.toThrow(error);
      expect(store.listPending()).toEqual([]);
    },
  );

  it('rejects a provider order id that is already bound locally', async () => {
    const store = new SubscriptionStore(FILE);
    const original = record({
      merchantTransactionId: 'order_existing_transaction',
      resultUrl: 'https://checkout.example.invalid/order/ORDER1',
    });
    store.upsert(original);

    await expect(
      startPlanPurchase(
        { gateway: fakeGateway(), store },
        {
          plan: BASIC_PLAN,
          jid: 'chat:other',
          channel: 'example',
          customerId: 'other',
          purchaseId: 'other-purchase',
          tenantId: 'tenant-other',
          channelUserId: 'other',
          applicationId: 'test-app',
        },
      ),
    ).rejects.toThrow(/duplicate order id/i);
    expect(store.getByOrder('ORDER1')).toEqual(original);
  });

  it('times out a provider create call and stores no phantom order', async () => {
    const store = new SubscriptionStore(FILE);
    const createPayment = vi.fn(
      () => new Promise<CreatePaymentResult>(() => undefined),
    );

    await expect(
      startPlanPurchase(
        { gateway: { createPayment }, store, timeoutMs: 5 },
        {
          plan: BASIC_PLAN,
          jid: 'chat:customer',
          channel: 'example',
          customerId: 'customer',
          purchaseId: PURCHASE_ID,
          tenantId: 'tenant-example',
          channelUserId: 'customer',
          applicationId: 'test-app',
        },
      ),
    ).rejects.toMatchObject({ classification: 'timeout' });
    expect(store.listPending()).toEqual([]);
  });
});

describe('planOrderMismatchReason', () => {
  it('accepts an exactly bound, fully captured order', () => {
    expect(planOrderMismatchReason(record(), paidOrder())).toBeNull();
  });

  it('rejects a different provider order id', () => {
    expect(
      planOrderMismatchReason(record(), paidOrder({ id: 'OTHER' })),
    ).toMatch(/order id mismatch/i);
  });

  it('rejects a conflicting merchant transaction id', () => {
    expect(
      planOrderMismatchReason(
        record(),
        paidOrder({ merchantTransactionId: 'order_other_customer_1' }),
      ),
    ).toMatch(/merchantTransactionId mismatch/i);
  });

  it('requires a merchant id or an explicit adapter binding attestation', () => {
    expect(
      planOrderMismatchReason(
        record(),
        paidOrder({ merchantTransactionId: undefined }),
      ),
    ).toMatch(/did not verify binding/i);
    expect(
      planOrderMismatchReason(
        record(),
        paidOrder({
          merchantTransactionId: undefined,
          bindingVerified: true,
        }),
      ),
    ).toBeNull();
  });

  it('rejects missing currency, missing amount, and under-capture', () => {
    expect(
      planOrderMismatchReason(record(), paidOrder({ currency: undefined })),
    ).toMatch(/currency missing/i);
    expect(
      planOrderMismatchReason(
        record(),
        paidOrder({ amount: undefined, amountCharged: undefined }),
      ),
    ).toMatch(/captured amount missing/i);
    expect(
      planOrderMismatchReason(record(), paidOrder({ amountCharged: '1.00' })),
    ).toMatch(/captured amount/i);
  });

  it('rejects a different settlement currency even after binding succeeds', () => {
    expect(
      planOrderMismatchReason(
        record(),
        paidOrder({
          currency: 'EUR',
          amount: '9.00',
          amountCharged: '9.00',
        }),
      ),
    ).toMatch(/currency mismatch/i);
    expect(
      planOrderMismatchReason(
        record(),
        paidOrder({
          merchantTransactionId: undefined,
          currency: 'EUR',
          amount: '9.00',
          amountCharged: '9.00',
        }),
      ),
    ).toMatch(/did not verify binding/i);
  });
});

describe('confirmPlanPurchase', () => {
  it('activates a bound paid order exactly once and sets finite expiry', async () => {
    const store = await seedPending();
    const activate = vi.fn();
    const gateway = fakeGateway({ getOrder: async () => paidOrder() });

    const first = await confirmPlanPurchase(
      { gateway, store, catalog: CATALOG, activate, now: () => NOW },
      'ORDER1',
    );
    expect(first).toMatchObject({
      status: 'active',
      paidAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 30 * DAY).toISOString(),
    });
    expect(activate).toHaveBeenCalledTimes(1);

    const second = await confirmPlanPurchase(
      { gateway, store, catalog: CATALOG, activate, now: () => NOW },
      'ORDER1',
    );
    expect(second.status).toBe('active');
    expect(gateway.getOrder).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('moves a suspicious charged order to review and reports the reason', async () => {
    const store = await seedPending();
    const activate = vi.fn();
    const onSuspicious = vi.fn();
    const gateway = fakeGateway({
      getOrder: async () =>
        paidOrder({ merchantTransactionId: 'order_other_customer_1' }),
    });

    const result = await confirmPlanPurchase(
      {
        gateway,
        store,
        catalog: CATALOG,
        activate,
        onSuspicious,
        now: () => NOW,
      },
      'ORDER1',
    );
    expect(result.status).toBe('review');
    expect(activate).not.toHaveBeenCalled();
    expect(onSuspicious).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'ORDER1' }),
      expect.objectContaining({ paid: true }),
      expect.stringMatching(/merchantTransactionId/i),
    );
  });

  it('uses the purchase-time entitlement snapshot after catalog drift', async () => {
    const store = await seedPending();
    const changedPlan: PaymentPlan = Object.freeze({
      ...BASIC_PLAN,
      periodDays: 7,
      weeklyLimitCredits: 5,
    });
    const activate = vi.fn();
    const result = await confirmPlanPurchase(
      {
        gateway: fakeGateway({ getOrder: async () => paidOrder() }),
        store,
        catalog: Object.freeze({ basic: changedPlan }),
        activate,
        now: () => NOW,
      },
      'ORDER1',
    );
    expect(result).toMatchObject({
      status: 'active',
      periodDays: 30,
      weeklyLimitCredits: 100,
      quotaEnabled: true,
      expiresAt: new Date(NOW + 30 * DAY).toISOString(),
    });
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        periodDays: 30,
        weeklyLimitCredits: 100,
        quotaEnabled: true,
      }),
    );
  });

  it('uses the catalog only for a legacy record with no entitlement snapshot', async () => {
    const store = new SubscriptionStore(FILE);
    store.upsert(
      record({
        periodDays: undefined,
        weeklyLimitCredits: undefined,
        quotaEnabled: undefined,
      }),
    );
    const activate = vi.fn();

    const result = await confirmPlanPurchase(
      {
        gateway: fakeGateway({ getOrder: async () => paidOrder() }),
        store,
        catalog: CATALOG,
        activate,
        now: () => NOW,
      },
      'ORDER1',
    );

    expect(result).toMatchObject({
      status: 'active',
      periodDays: BASIC_PLAN.periodDays,
      weeklyLimitCredits: BASIC_PLAN.weeklyLimitCredits,
      quotaEnabled: BASIC_PLAN.quotaEnabled,
    });
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('moves an unresolvable legacy entitlement to review without activating', async () => {
    const store = new SubscriptionStore(FILE);
    store.upsert(
      record({
        planCode: 'retired',
        periodDays: undefined,
        weeklyLimitCredits: undefined,
        quotaEnabled: undefined,
      }),
    );
    const activate = vi.fn();
    const onSuspicious = vi.fn();

    const result = await confirmPlanPurchase(
      {
        gateway: fakeGateway({ getOrder: async () => paidOrder() }),
        store,
        catalog: Object.freeze({}),
        activate,
        onSuspicious,
        now: () => NOW,
      },
      'ORDER1',
    );

    expect(result.status).toBe('review');
    expect(activate).not.toHaveBeenCalled();
    expect(onSuspicious).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringMatching(/entitlement snapshot/i),
    );
  });

  it('marks a final unpaid order failed and leaves non-final orders pending', async () => {
    const store = await seedPending();
    const failed = await confirmPlanPurchase(
      {
        gateway: fakeGateway({
          getOrder: async () => order({ status: 'declined', final: true }),
        }),
        store,
        catalog: CATALOG,
        activate: vi.fn(),
        now: () => NOW,
      },
      'ORDER1',
    );
    expect(failed.status).toBe('failed');

    fs.rmSync(DIR, { recursive: true, force: true });
    const nextStore = await seedPending();
    const pending = await confirmPlanPurchase(
      {
        gateway: fakeGateway({
          getOrder: async () => order({ status: 'processing', final: false }),
        }),
        store: nextStore,
        catalog: CATALOG,
        activate: vi.fn(),
        now: () => NOW,
      },
      'ORDER1',
    );
    expect(pending.status).toBe('pending');

    fs.rmSync(DIR, { recursive: true, force: true });
    const authorizedStore = await seedPending();
    const authorizedButNonFinal = await confirmPlanPurchase(
      {
        gateway: fakeGateway({
          getOrder: async () =>
            paidOrder({ status: 'authorized', paid: true, final: false }),
        }),
        store: authorizedStore,
        catalog: CATALOG,
        activate: vi.fn(),
        now: () => NOW,
      },
      'ORDER1',
    );
    expect(authorizedButNonFinal.status).toBe('pending');
  });

  it('keeps the record pending when activation throws so it can retry', async () => {
    const store = await seedPending();
    await expect(
      confirmPlanPurchase(
        {
          gateway: fakeGateway({ getOrder: async () => paidOrder() }),
          store,
          catalog: CATALOG,
          activate: vi.fn(async () => {
            throw new Error('quota unavailable');
          }),
          now: () => NOW,
        },
        'ORDER1',
      ),
    ).rejects.toThrow(/quota unavailable/);
    expect(store.getByOrder('ORDER1')?.status).toBe('pending');
  });

  it('throws for an unknown local order without calling the gateway', async () => {
    const gateway = fakeGateway();
    await expect(
      confirmPlanPurchase(
        {
          gateway,
          store: new SubscriptionStore(FILE),
          catalog: CATALOG,
          activate: vi.fn(),
        },
        'MISSING',
      ),
    ).rejects.toThrow(/No subscription/i);
    expect(gateway.getOrder).not.toHaveBeenCalled();
  });

  it.each(['active', 'review', 'failed', 'expired'] as const)(
    'does not reopen a %s record after a late provider response',
    async (status) => {
      const store = new SubscriptionStore(FILE);
      store.upsert(record({ status }));
      const gateway = fakeGateway({ getOrder: async () => paidOrder() });
      const activate = vi.fn();

      const result = await confirmPlanPurchase(
        { gateway, store, catalog: CATALOG, activate, now: () => NOW },
        'ORDER1',
      );

      expect(result.status).toBe(status);
      expect(gateway.getOrder).not.toHaveBeenCalled();
      expect(activate).not.toHaveBeenCalled();
    },
  );

  it('times out an order lookup without changing the pending record', async () => {
    const store = await seedPending();
    const getOrder = vi.fn(() => new Promise<OrderInfo>(() => undefined));

    await expect(
      confirmPlanPurchase(
        {
          gateway: { getOrder },
          store,
          catalog: CATALOG,
          activate: vi.fn(),
          timeoutMs: 5,
        },
        'ORDER1',
      ),
    ).rejects.toMatchObject({ classification: 'timeout' });
    expect(store.getByOrder('ORDER1')?.status).toBe('pending');
  });
});

describe('SubscriptionStore', () => {
  it('returns only a live active record for an identity key', () => {
    const store = new SubscriptionStore(FILE);
    store.upsert(
      record({
        orderId: 'OLD',
        status: 'active',
        expiresAt: new Date(NOW - DAY).toISOString(),
      }),
    );
    store.upsert(
      record({
        orderId: 'LIVE',
        status: 'active',
        expiresAt: new Date(NOW + DAY).toISOString(),
      }),
    );
    expect(store.findActiveByJid('chat:customer', NOW)?.orderId).toBe('LIVE');
  });

  it('treats a missing file as empty but rejects corrupted JSON', () => {
    const store = new SubscriptionStore(FILE);
    expect(store.listPending()).toEqual([]);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, '{"broken":');
    expect(() => store.listPending()).toThrow();
  });

  it('migrates only the unambiguous legacy Telegram channel shape', () => {
    fs.mkdirSync(DIR, { recursive: true });
    const legacy = record({
      jid: 'tg:123456',
      channel: '',
    });
    const { channel: _channel, ...withoutChannel } = legacy;
    fs.writeFileSync(FILE, JSON.stringify({ ORDER1: withoutChannel }));

    expect(new SubscriptionStore(FILE).getByOrder('ORDER1')).toMatchObject({
      jid: 'tg:123456',
      channel: 'telegram',
    });
  });

  it('fails closed on prototype-shaped and mismatched store records', () => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(
      FILE,
      JSON.stringify({
        ['__proto__']: record({ orderId: '__proto__' }),
      }),
    );
    expect(() => new SubscriptionStore(FILE).listPending()).toThrow();

    fs.writeFileSync(
      FILE,
      JSON.stringify({
        ORDER1: record({ orderId: 'OTHER' }),
      }),
    );
    expect(() => new SubscriptionStore(FILE).listPending()).toThrow(
      /does not match/i,
    );
    expect(() =>
      new SubscriptionStore(FILE).upsert(record({ orderId: '__proto__' })),
    ).toThrow(/order id is invalid/i);
  });

  it.each([
    ['status', 'unknown'],
    ['amount', '-1.00'],
    ['currency', 'usd'],
    ['createdAt', 'not-a-date'],
    ['jid', ''],
    ['quotaEnabled', 'yes'],
  ])('fails closed on an invalid stored %s', (field, value) => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(
      FILE,
      JSON.stringify({
        ORDER1: { ...record(), [field]: value },
      }),
    );

    expect(() => new SubscriptionStore(FILE).listPending()).toThrow(
      /invalid|required/i,
    );
  });
});

describe('runPaymentPollingSweep', () => {
  it('activates paid orders while leaving pending orders alone', async () => {
    const store = new SubscriptionStore(FILE);
    store.upsert(record({ orderId: 'PAID' }));
    store.upsert(
      record({
        orderId: 'WAIT',
        merchantTransactionId: 'order_basic_other_1',
      }),
    );
    const activate = vi.fn();
    const onActivated = vi.fn((rec: SubscriptionRecord) => {
      expect(rec.status).toBe('active');
      expect(store.getByOrder(rec.orderId)?.status).toBe('active');
    });
    const gateway = fakeGateway({
      getOrder: async (id) =>
        id === 'PAID'
          ? paidOrder({ id: 'PAID' })
          : order({ id: 'WAIT', status: 'processing' }),
    });
    const result = await runPaymentPollingSweep({
      gateway,
      store,
      catalog: CATALOG,
      activate,
      onActivated,
      now: () => NOW,
    });
    expect(result).toMatchObject({
      checked: 2,
      activated: 1,
      failed: 0,
      abandoned: 0,
    });
    expect(store.getByOrder('PAID')?.status).toBe('active');
    expect(store.getByOrder('WAIT')?.status).toBe('pending');
    expect(onActivated).toHaveBeenCalledTimes(1);
    expect(onActivated).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'PAID', status: 'active' }),
    );
  });

  it('expires an abandoned checkout without a gateway request', async () => {
    const store = new SubscriptionStore(FILE);
    const maxPendingAgeMs = 5 * 60 * 60 * 1000;
    store.upsert(
      record({
        createdAt: new Date(NOW - maxPendingAgeMs - 1).toISOString(),
      }),
    );
    const gateway = fakeGateway();
    const result = await runPaymentPollingSweep({
      gateway,
      store,
      catalog: CATALOG,
      activate: vi.fn(),
      now: () => NOW,
      maxPendingAgeMs,
    });
    expect(result.abandoned).toBe(1);
    expect(store.getByOrder('ORDER1')?.status).toBe('expired');
    expect(gateway.getOrder).not.toHaveBeenCalled();
  });

  it('continues after an isolated error and aborts on a gateway outage', async () => {
    const store = new SubscriptionStore(FILE);
    store.upsert(record({ orderId: 'ONE' }));
    store.upsert(record({ orderId: 'TWO' }));
    const onError = vi.fn();
    const isolated = fakeGateway({
      getOrder: async (id) => {
        if (id === 'ONE') throw new Error('one bad order');
        return order({ id });
      },
    });
    await runPaymentPollingSweep({
      gateway: isolated,
      store,
      catalog: CATALOG,
      activate: vi.fn(),
      onError,
      now: () => NOW,
    });
    expect(isolated.getOrder).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);

    const outage = Object.assign(new Error('unavailable'), {
      classification: 'http_error',
      httpStatus: 503,
    });
    const down = fakeGateway({
      getOrder: async () => {
        throw outage;
      },
    });
    const result = await runPaymentPollingSweep({
      gateway: down,
      store,
      catalog: CATALOG,
      activate: vi.fn(),
      now: () => NOW,
    });
    expect(result.gatewayDownError).toBe(outage);
    expect(down.getOrder).toHaveBeenCalledTimes(1);
  });
});

describe('gateway and reversal classification', () => {
  it('classifies only outage-shaped failures as gateway down', () => {
    expect(isGatewayDown({ classification: 'timeout' })).toBe(true);
    expect(isGatewayDown({ classification: 'network_error' })).toBe(true);
    expect(
      isGatewayDown({ classification: 'http_error', httpStatus: 504 }),
    ).toBe(true);
    expect(
      isGatewayDown({ classification: 'http_error', httpStatus: 400 }),
    ).toBe(false);
    expect(isGatewayDown(new Error('ordinary'))).toBe(false);
  });

  it('treats terminal unpaid states and any positive refund as reversal', () => {
    expect(
      isReversedOrRefunded(
        order({ status: 'reversed', final: true, paid: false }),
      ),
    ).toBe(true);
    expect(isReversedOrRefunded(paidOrder({ amountRefunded: '0.01' }))).toBe(
      true,
    );
    expect(isReversedOrRefunded(paidOrder({ amountRefunded: '0' }))).toBe(
      false,
    );
    expect(isReversedOrRefunded(order())).toBe(false);
  });
});

describe('reconcileActiveSubscriptions', () => {
  function activeRecord(
    partial: Partial<SubscriptionRecord> = {},
  ): SubscriptionRecord {
    return record({
      status: 'active',
      paidAt: new Date(NOW - DAY).toISOString(),
      expiresAt: new Date(NOW + DAY).toISOString(),
      ...partial,
    });
  }

  it('expires locally without a gateway call and persists after deactivation', async () => {
    const store = new SubscriptionStore(FILE);
    store.upsert(activeRecord({ expiresAt: new Date(NOW - 1).toISOString() }));
    const gateway = fakeGateway();
    const deactivate = vi.fn((rec: SubscriptionRecord) => {
      expect(rec.status).toBe('expired');
      expect(store.getByOrder(rec.orderId)?.status).toBe('active');
    });
    const result = await reconcileActiveSubscriptions({
      gateway,
      store,
      deactivate,
      now: () => NOW,
    });
    expect(result.expired).toBe(1);
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(gateway.getOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'not-a-date'],
  ])('expires an active record with %s expiry', async (_label, expiresAt) => {
    const store = new SubscriptionStore(FILE);
    store.upsert(activeRecord({ expiresAt }));
    const gateway = fakeGateway();
    const result = await reconcileActiveSubscriptions({
      gateway,
      store,
      deactivate: vi.fn(),
      now: () => NOW,
    });
    expect(result.expired).toBe(1);
    expect(store.getByOrder('ORDER1')?.status).toBe('expired');
    expect(gateway.getOrder).not.toHaveBeenCalled();
  });

  it('leaves the record active after deactivation failure and retries safely', async () => {
    const store = new SubscriptionStore(FILE);
    store.upsert(activeRecord({ expiresAt: new Date(NOW - 1).toISOString() }));
    const onError = vi.fn();
    const deactivate = vi
      .fn<(record: SubscriptionRecord) => Promise<void>>()
      .mockRejectedValueOnce(new Error('quota store unavailable'))
      .mockResolvedValueOnce();

    const first = await reconcileActiveSubscriptions({
      store,
      deactivate,
      onError,
      now: () => NOW,
    });
    expect(first.expired).toBe(0);
    expect(store.getByOrder('ORDER1')?.status).toBe('active');
    expect(onError).toHaveBeenCalledWith(
      'ORDER1',
      expect.objectContaining({ message: 'quota store unavailable' }),
    );

    const retry = await reconcileActiveSubscriptions({
      store,
      deactivate,
      onError,
      now: () => NOW,
    });
    expect(retry.expired).toBe(1);
    expect(store.getByOrder('ORDER1')?.status).toBe('expired');
    expect(deactivate).toHaveBeenCalledTimes(2);
  });

  it('fires the deactivation callback only after the transition is durable', async () => {
    const store = new SubscriptionStore(FILE);
    store.upsert(activeRecord({ expiresAt: new Date(NOW - 1).toISOString() }));
    const onDeactivated = vi.fn((rec: SubscriptionRecord, reason: string) => {
      expect(reason).toBe('expired');
      expect(store.getByOrder(rec.orderId)?.status).toBe('expired');
    });

    await reconcileActiveSubscriptions({
      store,
      deactivate: vi.fn(),
      onDeactivated,
      now: () => NOW,
    });

    expect(onDeactivated).toHaveBeenCalledTimes(1);
  });

  it('deactivates on any refund and leaves a healthy order active', async () => {
    const store = new SubscriptionStore(FILE);
    store.upsert(activeRecord({ orderId: 'REFUND' }));
    store.upsert(activeRecord({ orderId: 'HEALTHY' }));
    const deactivate = vi.fn();
    const result = await reconcileActiveSubscriptions({
      gateway: fakeGateway({
        getOrder: async (id) =>
          id === 'REFUND'
            ? paidOrder({ id, amountRefunded: '0.01' })
            : paidOrder({ id }),
      }),
      store,
      deactivate,
      now: () => NOW,
    });
    expect(result.reversed).toBe(1);
    expect(store.getByOrder('REFUND')?.status).toBe('failed');
    expect(store.getByOrder('HEALTHY')?.status).toBe('active');
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('keeps an active subscription during a non-final unpaid provider state', async () => {
    const store = new SubscriptionStore(FILE);
    store.upsert(activeRecord());
    const deactivate = vi.fn();

    const result = await reconcileActiveSubscriptions({
      gateway: fakeGateway({
        getOrder: async () =>
          order({
            merchantTransactionId: TX_ID,
            status: 'processing',
            paid: false,
            final: false,
          }),
      }),
      store,
      deactivate,
      now: () => NOW,
    });

    expect(result.reversed).toBe(0);
    expect(store.getByOrder('ORDER1')?.status).toBe('active');
    expect(deactivate).not.toHaveBeenCalled();
  });

  it('never deactivates from a refund response bound to another order', async () => {
    const store = new SubscriptionStore(FILE);
    store.upsert(activeRecord());
    const deactivate = vi.fn();
    const onError = vi.fn();
    const result = await reconcileActiveSubscriptions({
      gateway: fakeGateway({
        getOrder: async () =>
          paidOrder({
            id: 'OTHER',
            amountRefunded: '10.00',
          }),
      }),
      store,
      deactivate,
      onError,
      now: () => NOW,
    });

    expect(result.reversed).toBe(0);
    expect(store.getByOrder('ORDER1')?.status).toBe('active');
    expect(deactivate).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      'ORDER1',
      expect.objectContaining({
        message: expect.stringMatching(/binding could not be verified/i),
      }),
    );
  });

  it('continues after an isolated error and backs off on an outage', async () => {
    const store = new SubscriptionStore(FILE);
    store.upsert(activeRecord({ orderId: 'ONE' }));
    store.upsert(activeRecord({ orderId: 'TWO' }));
    const onError = vi.fn();
    const isolated = fakeGateway({
      getOrder: async (id) => {
        if (id === 'ONE') throw new Error('isolated');
        return paidOrder({ id });
      },
    });
    await reconcileActiveSubscriptions({
      gateway: isolated,
      store,
      deactivate: vi.fn(),
      onError,
      now: () => NOW,
    });
    expect(isolated.getOrder).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);

    const outage = Object.assign(new Error('timeout'), {
      classification: 'timeout',
    });
    const down = fakeGateway({
      getOrder: async () => {
        throw outage;
      },
    });
    const result = await reconcileActiveSubscriptions({
      gateway: down,
      store,
      deactivate: vi.fn(),
      now: () => NOW,
    });
    expect(result.gatewayDownError).toBe(outage);
    expect(down.getOrder).toHaveBeenCalledTimes(1);
  });
});
