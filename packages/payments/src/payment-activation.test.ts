import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildPlanActivation,
  buildPlanDeactivation,
  paidPlansCollapsingToFloor,
} from './payment-activation.js';
import type { PlanCatalog } from './payment-plans.js';
import {
  SubscriptionStore,
  type SubscriptionRecord,
} from './payment-service.js';

const NOW = Date.UTC(2040, 0, 15, 12);
const DAY_MS = 24 * 60 * 60 * 1000;

const CATALOG: PlanCatalog = Object.freeze({
  free: Object.freeze({
    code: 'free',
    amountMajor: '',
    currency: 'USD',
    prices: Object.freeze({}),
    free: true,
    weeklyLimitCredits: 30,
    quotaEnabled: true,
    periodDays: 14,
    titles: Object.freeze({ en: 'Free' }),
  }),
  basic: Object.freeze({
    code: 'basic',
    amountMajor: '10',
    currency: 'USD',
    prices: Object.freeze({ USD: '10' }),
    free: false,
    weeklyLimitCredits: 120,
    quotaEnabled: true,
    periodDays: 30,
    titles: Object.freeze({ en: 'Basic' }),
  }),
  team: Object.freeze({
    code: 'team',
    amountMajor: '25',
    currency: 'USD',
    prices: Object.freeze({ USD: '25' }),
    free: false,
    weeklyLimitCredits: 360,
    quotaEnabled: true,
    periodDays: 30,
    titles: Object.freeze({ en: 'Team' }),
  }),
  unlimited: Object.freeze({
    code: 'unlimited',
    amountMajor: '40',
    currency: 'USD',
    prices: Object.freeze({ USD: '40' }),
    free: false,
    weeklyLimitCredits: 0,
    quotaEnabled: false,
    periodDays: 30,
    titles: Object.freeze({ en: 'Unlimited' }),
  }),
});

function record(
  overrides: Partial<SubscriptionRecord> = {},
): SubscriptionRecord {
  return {
    orderId: 'order-main',
    merchantTransactionId: 'merchant-main',
    jid: 'room:alpha',
    channel: 'chat',
    tenantId: 'tenant-alpha',
    channelUserId: 'user-alpha',
    planCode: 'basic',
    amount: '10',
    currency: 'USD',
    status: 'active',
    createdAt: new Date(NOW - 3 * DAY_MS).toISOString(),
    ...overrides,
  };
}

const temporaryDirectories: string[] = [];

function createStore(): SubscriptionStore {
  const directory = mkdtempSync(join(tmpdir(), 'payment-activation-'));
  temporaryDirectories.push(directory);
  return new SubscriptionStore(join(directory, 'subscriptions.json'));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('buildPlanActivation', () => {
  it.each([
    ['free', 30, true],
    ['basic', 120, true],
    ['team', 360, true],
    ['unlimited', 0, false],
  ] as const)(
    'applies the configured %s entitlement',
    async (planCode, weeklyLimitCredits, quotaEnabled) => {
      const setLimit = vi.fn();

      await buildPlanActivation({ catalog: CATALOG, setLimit })(
        record({ planCode }),
      );

      expect(setLimit).toHaveBeenCalledOnce();
      expect(setLimit).toHaveBeenCalledWith({
        tenantId: 'tenant-alpha',
        channel: 'chat',
        channelUserId: 'user-alpha',
        weeklyLimitCredits,
        quotaEnabled,
      });
    },
  );

  it('uses the configured floor when it exceeds a finite plan entitlement', async () => {
    const setLimit = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await buildPlanActivation({
      catalog: CATALOG,
      setLimit,
      defaultWeeklyLimitCredits: 180,
    })(record({ planCode: 'basic' }));

    expect(setLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 180,
        quotaEnabled: true,
      }),
    );
  });

  it('never replaces a higher finite entitlement with a lower one', async () => {
    const setLimit = vi.fn();

    await buildPlanActivation({
      catalog: CATALOG,
      setLimit,
      getCurrentEntitlement: () => ({
        weeklyLimitCredits: 500,
        quotaEnabled: true,
      }),
    })(record({ planCode: 'team' }));

    expect(setLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 500,
        quotaEnabled: true,
      }),
    );
  });

  it('never replaces an unlimited entitlement with a finite one', async () => {
    const setLimit = vi.fn();
    const onApplied = vi.fn();

    await buildPlanActivation({
      catalog: CATALOG,
      setLimit,
      onApplied,
      getCurrentEntitlement: () => ({
        weeklyLimitCredits: 0,
        quotaEnabled: false,
      }),
    })(record({ planCode: 'team' }));

    expect(setLimit).not.toHaveBeenCalled();
    expect(onApplied).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 0,
        quotaEnabled: false,
      }),
    );
  });

  it('raises a lower finite entitlement to the selected plan target', async () => {
    const setLimit = vi.fn();
    const getCurrentEntitlement = vi.fn(() => ({
      weeklyLimitCredits: 80,
      quotaEnabled: true,
    }));

    await buildPlanActivation({
      catalog: CATALOG,
      setLimit,
      getCurrentEntitlement,
    })(record({ planCode: 'basic' }));

    expect(getCurrentEntitlement).toHaveBeenCalledWith({
      tenantId: 'tenant-alpha',
      channel: 'chat',
      channelUserId: 'user-alpha',
    });
    expect(setLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 120,
        quotaEnabled: true,
      }),
    );
  });

  it('rejects an incomplete identity or channel', async () => {
    const setLimit = vi.fn();
    const activate = buildPlanActivation({
      catalog: CATALOG,
      setLimit,
    });

    await expect(activate(record({ tenantId: undefined }))).rejects.toThrow(
      /identity is incomplete/i,
    );
    await expect(
      activate(record({ channelUserId: undefined })),
    ).rejects.toThrow(/identity is incomplete/i);
    await expect(activate(record({ channel: '' }))).rejects.toThrow(
      /identity is incomplete/i,
    );

    expect(setLimit).not.toHaveBeenCalled();
  });

  it('rejects an unknown entitlement without a snapshot', async () => {
    const setLimit = vi.fn();

    await expect(
      buildPlanActivation({ catalog: CATALOG, setLimit })(
        record({ planCode: 'missing' }),
      ),
    ).rejects.toThrow(/snapshot is unavailable/i);

    expect(setLimit).not.toHaveBeenCalled();
  });

  it('uses the captured snapshot after the catalog changes', async () => {
    const setLimit = vi.fn();

    await buildPlanActivation({ catalog: CATALOG, setLimit })(
      record({
        planCode: 'retired',
        weeklyLimitCredits: 275,
        quotaEnabled: true,
      }),
    );

    expect(setLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 275,
        quotaEnabled: true,
      }),
    );
  });

  it('reports the exact applied entitlement through onApplied', async () => {
    const setLimit = vi.fn();
    const onApplied = vi.fn();
    const activated = record({ planCode: 'team' });

    await buildPlanActivation({
      catalog: CATALOG,
      setLimit,
      onApplied,
    })(activated);

    expect(onApplied).toHaveBeenCalledOnce();
    expect(onApplied).toHaveBeenCalledWith({
      record: activated,
      weeklyLimitCredits: 360,
      quotaEnabled: true,
    });
  });
});

describe('buildPlanDeactivation', () => {
  it('restores the floor when no other active entitlement remains', async () => {
    const store = createStore();
    const stillListed = record({
      orderId: 'order-ending',
      status: 'active',
      expiresAt: new Date(NOW + DAY_MS).toISOString(),
    });
    store.upsert(stillListed);
    const setLimit = vi.fn();
    const onApplied = vi.fn();
    const ending = { ...stillListed, status: 'expired' as const };

    await buildPlanDeactivation({
      store,
      catalog: CATALOG,
      defaultWeeklyLimitCredits: 45,
      setLimit,
      onApplied,
      now: () => NOW,
    })(ending);

    expect(setLimit).toHaveBeenCalledWith({
      tenantId: 'tenant-alpha',
      channel: 'chat',
      channelUserId: 'user-alpha',
      weeklyLimitCredits: 45,
      quotaEnabled: true,
    });
    expect(onApplied).toHaveBeenCalledWith({
      record: ending,
      weeklyLimitCredits: 45,
      quotaEnabled: true,
    });
  });

  it('selects the strongest remaining entitlement, not the newest purchase', async () => {
    const store = createStore();
    store.upsert(
      record({
        orderId: 'order-team',
        merchantTransactionId: 'merchant-team',
        planCode: 'team',
        amount: '25',
        paidAt: new Date(NOW - 6 * DAY_MS).toISOString(),
        expiresAt: new Date(NOW + 10 * DAY_MS).toISOString(),
      }),
    );
    store.upsert(
      record({
        orderId: 'order-basic-newer',
        merchantTransactionId: 'merchant-basic-newer',
        planCode: 'basic',
        paidAt: new Date(NOW - DAY_MS).toISOString(),
        expiresAt: new Date(NOW + 20 * DAY_MS).toISOString(),
      }),
    );
    const setLimit = vi.fn();

    await buildPlanDeactivation({
      store,
      catalog: CATALOG,
      setLimit,
      now: () => NOW,
    })(record({ orderId: 'order-ended', status: 'expired' }));

    expect(setLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 360,
        quotaEnabled: true,
      }),
    );
  });

  it('matches remaining records by tenant, jid, channel, and channel user', async () => {
    const store = createStore();
    const common = {
      planCode: 'unlimited',
      amount: '40',
      expiresAt: new Date(NOW + 10 * DAY_MS).toISOString(),
    };
    store.upsert(
      record({
        ...common,
        orderId: 'order-wrong-tenant',
        merchantTransactionId: 'merchant-wrong-tenant',
        tenantId: 'tenant-other',
      }),
    );
    store.upsert(
      record({
        ...common,
        orderId: 'order-wrong-jid',
        merchantTransactionId: 'merchant-wrong-jid',
        jid: 'room:other',
      }),
    );
    store.upsert(
      record({
        ...common,
        orderId: 'order-wrong-channel',
        merchantTransactionId: 'merchant-wrong-channel',
        channel: 'mail',
      }),
    );
    store.upsert(
      record({
        ...common,
        orderId: 'order-wrong-user',
        merchantTransactionId: 'merchant-wrong-user',
        channelUserId: 'user-other',
      }),
    );
    store.upsert(
      record({
        orderId: 'order-matching-basic',
        merchantTransactionId: 'merchant-matching-basic',
        planCode: 'basic',
        expiresAt: new Date(NOW + 10 * DAY_MS).toISOString(),
      }),
    );
    const setLimit = vi.fn();

    await buildPlanDeactivation({
      store,
      catalog: CATALOG,
      setLimit,
      now: () => NOW,
    })(record({ orderId: 'order-ended', status: 'expired' }));

    expect(setLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 120,
        quotaEnabled: true,
      }),
    );
  });

  it('preserves a remaining unlimited entitlement over finite plans', async () => {
    const store = createStore();
    store.upsert(
      record({
        orderId: 'order-team',
        merchantTransactionId: 'merchant-team',
        planCode: 'team',
        amount: '25',
        expiresAt: new Date(NOW + 10 * DAY_MS).toISOString(),
      }),
    );
    store.upsert(
      record({
        orderId: 'order-unlimited',
        merchantTransactionId: 'merchant-unlimited',
        planCode: 'unlimited',
        amount: '40',
        expiresAt: new Date(NOW + 10 * DAY_MS).toISOString(),
      }),
    );
    const setLimit = vi.fn();

    await buildPlanDeactivation({
      store,
      catalog: CATALOG,
      setLimit,
      now: () => NOW,
    })(record({ orderId: 'order-ended', status: 'expired' }));

    expect(setLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 0,
        quotaEnabled: false,
      }),
    );
  });

  it('ignores expired records when selecting the remaining entitlement', async () => {
    const store = createStore();
    store.upsert(
      record({
        orderId: 'order-expired-team',
        merchantTransactionId: 'merchant-expired-team',
        planCode: 'team',
        amount: '25',
        expiresAt: new Date(NOW).toISOString(),
      }),
    );
    store.upsert(
      record({
        orderId: 'order-current-basic',
        merchantTransactionId: 'merchant-current-basic',
        planCode: 'basic',
        expiresAt: new Date(NOW + DAY_MS).toISOString(),
      }),
    );
    const setLimit = vi.fn();

    await buildPlanDeactivation({
      store,
      catalog: CATALOG,
      setLimit,
      now: () => NOW,
    })(record({ orderId: 'order-ended', status: 'expired' }));

    expect(setLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 120,
        quotaEnabled: true,
      }),
    );
  });

  it('preserves an independent higher finite entitlement', async () => {
    const store = createStore();
    const setLimit = vi.fn();
    const getCurrentEntitlement = vi.fn(() => ({
      weeklyLimitCredits: 500,
      quotaEnabled: true,
    }));

    await buildPlanDeactivation({
      store,
      catalog: CATALOG,
      defaultWeeklyLimitCredits: 45,
      setLimit,
      getCurrentEntitlement,
      now: () => NOW,
    })(
      record({
        status: 'expired',
        weeklyLimitCredits: 120,
        quotaEnabled: true,
      }),
    );

    expect(getCurrentEntitlement).toHaveBeenCalledWith({
      tenantId: 'tenant-alpha',
      channel: 'chat',
      channelUserId: 'user-alpha',
    });
    expect(setLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 500,
        quotaEnabled: true,
      }),
    );
  });

  it('preserves an independent unlimited entitlement', async () => {
    const store = createStore();
    const setLimit = vi.fn();
    const onApplied = vi.fn();

    await buildPlanDeactivation({
      store,
      catalog: CATALOG,
      defaultWeeklyLimitCredits: 45,
      setLimit,
      onApplied,
      getCurrentEntitlement: () => ({
        weeklyLimitCredits: 0,
        quotaEnabled: false,
      }),
      now: () => NOW,
    })(
      record({
        planCode: 'team',
        status: 'expired',
        weeklyLimitCredits: 360,
        quotaEnabled: true,
      }),
    );

    expect(setLimit).not.toHaveBeenCalled();
    expect(onApplied).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 0,
        quotaEnabled: false,
      }),
    );
  });

  it('does not mistake the ending plan itself for an independent entitlement', async () => {
    const store = createStore();
    const setLimit = vi.fn();

    await buildPlanDeactivation({
      store,
      catalog: CATALOG,
      defaultWeeklyLimitCredits: 45,
      setLimit,
      getCurrentEntitlement: () => ({
        weeklyLimitCredits: 120,
        quotaEnabled: true,
      }),
      now: () => NOW,
    })(
      record({
        status: 'expired',
        weeklyLimitCredits: 120,
        quotaEnabled: true,
      }),
    );

    expect(setLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 45,
        quotaEnabled: true,
      }),
    );
  });

  it('does not preserve unlimited when the ending plan granted it', async () => {
    const store = createStore();
    const setLimit = vi.fn();

    await buildPlanDeactivation({
      store,
      catalog: CATALOG,
      defaultWeeklyLimitCredits: 45,
      setLimit,
      getCurrentEntitlement: () => ({
        weeklyLimitCredits: 0,
        quotaEnabled: false,
      }),
      now: () => NOW,
    })(
      record({
        planCode: 'unlimited',
        status: 'expired',
        weeklyLimitCredits: 0,
        quotaEnabled: false,
      }),
    );

    expect(setLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 45,
        quotaEnabled: true,
      }),
    );
  });

  it('uses entitlement snapshots after the catalog changes', async () => {
    const store = createStore();
    store.upsert(
      record({
        orderId: 'order-retired',
        merchantTransactionId: 'merchant-retired',
        planCode: 'retired',
        weeklyLimitCredits: 275,
        quotaEnabled: true,
        expiresAt: new Date(NOW + DAY_MS).toISOString(),
      }),
    );
    const setLimit = vi.fn();

    await buildPlanDeactivation({
      store,
      catalog: CATALOG,
      setLimit,
      now: () => NOW,
    })(
      record({
        status: 'expired',
        weeklyLimitCredits: 120,
        quotaEnabled: true,
      }),
    );

    expect(setLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 275,
        quotaEnabled: true,
      }),
    );
  });

  it('uses the ending snapshot when classifying a current entitlement', async () => {
    const store = createStore();
    const setLimit = vi.fn();

    await buildPlanDeactivation({
      store,
      catalog: CATALOG,
      defaultWeeklyLimitCredits: 45,
      setLimit,
      getCurrentEntitlement: () => ({
        weeklyLimitCredits: 300,
        quotaEnabled: true,
      }),
      now: () => NOW,
    })(
      record({
        planCode: 'basic',
        status: 'expired',
        weeklyLimitCredits: 400,
        quotaEnabled: true,
      }),
    );

    expect(setLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyLimitCredits: 45,
        quotaEnabled: true,
      }),
    );
  });

  it('removes an unknown legacy entitlement to the safe floor', async () => {
    const store = createStore();
    const setLimit = vi.fn();

    await buildPlanDeactivation({
      store,
      catalog: CATALOG,
      defaultWeeklyLimitCredits: 25,
      setLimit,
    })(record({ planCode: 'missing', status: 'expired' }));

    expect(setLimit).toHaveBeenCalledWith({
      tenantId: 'tenant-alpha',
      channel: 'chat',
      channelUserId: 'user-alpha',
      weeklyLimitCredits: 25,
      quotaEnabled: true,
    });
  });

  it('rejects an incomplete identity or channel', async () => {
    const store = createStore();
    const setLimit = vi.fn();
    const deactivate = buildPlanDeactivation({
      store,
      catalog: CATALOG,
      setLimit,
    });

    await expect(deactivate(record({ tenantId: undefined }))).rejects.toThrow(
      /identity is incomplete/i,
    );
    await expect(
      deactivate(record({ channelUserId: undefined })),
    ).rejects.toThrow(/identity is incomplete/i);
    await expect(deactivate(record({ channel: '' }))).rejects.toThrow(
      /identity is incomplete/i,
    );

    expect(setLimit).not.toHaveBeenCalled();
  });
});

describe('paidPlansCollapsingToFloor', () => {
  it('reports only finite paid plans at or below the supplied floor', () => {
    expect(paidPlansCollapsingToFloor(CATALOG, 120)).toEqual([
      { code: 'basic', planTarget: 120 },
    ]);
  });

  it('reports no collapse when every finite paid plan clears the floor', () => {
    expect(paidPlansCollapsingToFloor(CATALOG, 0)).toEqual([]);
  });
});
