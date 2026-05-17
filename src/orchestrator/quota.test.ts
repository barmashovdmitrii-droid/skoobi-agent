import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import {
  addQuotaAdjustment,
  calculateCredits,
  chargeQuotaUsage,
  checkQuotaPreflight,
  formatQuotaStatusRu,
  getOrCreateQuotaAccount,
  getQuotaStatus,
  getWeekPeriod,
  type BillingConfig,
} from './quota.js';

const baseConfig: BillingConfig = {
  enabled: true,
  timezone: 'Asia/Aqtau',
  weekStartsOn: 'monday',
  globalCreditCoefficient: 100_000,
  coefficientVersion: 'test-coeff-1',
  defaultWeeklyLimitCredits: 2_000,
  hardBlockWhenExhausted: true,
  chargeShadowRequests: false,
  showRawTokensToUser: true,
  showProviderCostToUser: false,
  pricingVersion: 'test-pricing-1',
  codexSubscriptionCreditsPerRequest: 1_000,
  modelPricing: {
    sonnet: { inputUsdPer1mTokens: 3, outputUsdPer1mTokens: 15 },
    opus: { inputUsdPer1mTokens: 15, outputUsdPer1mTokens: 75 },
  },
};

function charge(
  overrides: Partial<Parameters<typeof chargeQuotaUsage>[0]> = {},
) {
  return chargeQuotaUsage({
    tenantId: 'tenant-a',
    sessionId: 'session-a',
    channel: 'telegram',
    chatId: '-1001',
    channelUserId: '42',
    modelRole: 'default',
    providerModel: 'claude-sonnet-4-5',
    inputTokens: 1_000,
    outputTokens: 500,
    idempotencyKey: 'charge-1',
    createdAt: new Date('2026-05-15T12:00:00.000Z').getTime(),
    runStatus: 'success',
    config: baseConfig,
    ...overrides,
  });
}

beforeEach(() => {
  _initTestDatabase();
});

describe('quota schema', () => {
  it('creates quota account, ledger, and adjustment tables', () => {
    const names = (
      getDb()
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

    expect(names).toContain('user_quota_accounts');
    expect(names).toContain('usage_ledger');
    expect(names).toContain('quota_adjustments');
  });

  it('keeps usage ledger and quota adjustments append-only', () => {
    const result = charge();
    const adjustmentId = addQuotaAdjustment({
      tenantId: 'tenant-a',
      channel: 'telegram',
      channelUserId: '42',
      deltaCredits: 100,
      createdAt: new Date('2026-05-15T12:00:00.000Z').getTime(),
      config: baseConfig,
    });

    expect(result.charged).toBe(true);
    expect(() =>
      getDb()
        .prepare(`UPDATE usage_ledger SET credits_spent = 1 WHERE id = ?`)
        .run(result.usageLedgerId),
    ).toThrow(/append-only/);
    expect(() =>
      getDb()
        .prepare(`DELETE FROM quota_adjustments WHERE id = ?`)
        .run(adjustmentId),
    ).toThrow(/append-only/);
  });
});

describe('quota periods', () => {
  it('starts the week on Monday 00:00 in Asia/Aqtau', () => {
    const period = getWeekPeriod(
      new Date('2026-05-15T12:00:00.000Z'),
      'Asia/Aqtau',
    );

    expect(new Date(period.startMs).toISOString()).toBe(
      '2026-05-10T19:00:00.000Z',
    );
    expect(new Date(period.endMs).toISOString()).toBe(
      '2026-05-17T19:00:00.000Z',
    );
  });
});

describe('quota accounts and status', () => {
  it('keys accounts by tenant, channel, and Telegram from.id', () => {
    const first = getOrCreateQuotaAccount(
      'tenant-a',
      'telegram',
      '42',
      Date.now(),
      baseConfig,
    );
    const same = getOrCreateQuotaAccount(
      'tenant-a',
      'telegram',
      '42',
      Date.now(),
      baseConfig,
    );
    const otherUser = getOrCreateQuotaAccount(
      'tenant-a',
      'telegram',
      '43',
      Date.now(),
      baseConfig,
    );

    expect(same.id).toBe(first.id);
    expect(otherUser.id).not.toBe(first.id);
  });

  it('does not create a new quota account when Telegram username/display hints change', () => {
    const beforeUsernameChange = getOrCreateQuotaAccount(
      'tenant-a',
      'telegram',
      '42',
      Date.now(),
      baseConfig,
    );
    // Quota account lookup intentionally has no username/display-name input.
    const afterUsernameChange = getOrCreateQuotaAccount(
      'tenant-a',
      'telegram',
      '42',
      Date.now(),
      baseConfig,
    );
    const count = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM user_quota_accounts`)
      .get() as { c: number };

    expect(afterUsernameChange.id).toBe(beforeUsernameChange.id);
    expect(count.c).toBe(1);
  });

  it('reports a fresh weekly balance with no usage', () => {
    const status = getQuotaStatus({
      tenantId: 'tenant-a',
      channel: 'telegram',
      channelUserId: '42',
      now: new Date('2026-05-15T12:00:00.000Z'),
      config: baseConfig,
    });

    expect(status.spentCredits).toBe(0);
    expect(status.remainingCredits).toBe(2_000);
    expect(formatQuotaStatusRu(status)).toContain('Осталось: 2 000 кредитов');
    expect(formatQuotaStatusRu(status)).not.toMatch(/usd|provider/i);
  });

  it('sums weekly usage and raw tokens for one user only', () => {
    charge();
    charge({
      channelUserId: '43',
      idempotencyKey: 'charge-other-user',
    });

    const status = getQuotaStatus({
      tenantId: 'tenant-a',
      channel: 'telegram',
      channelUserId: '42',
      now: new Date('2026-05-15T12:00:00.000Z'),
      config: baseConfig,
    });

    expect(status.spentCredits).toBe(1_050);
    expect(status.remainingCredits).toBe(950);
    expect(status.inputTokens).toBe(1_000);
    expect(status.outputTokens).toBe(500);
  });

  it('adds weekly quota adjustments without mutating ledger rows', () => {
    charge();
    addQuotaAdjustment({
      tenantId: 'tenant-a',
      channel: 'telegram',
      channelUserId: '42',
      deltaCredits: 500,
      createdAt: new Date('2026-05-15T12:00:00.000Z').getTime(),
      config: baseConfig,
    });

    const status = getQuotaStatus({
      tenantId: 'tenant-a',
      channel: 'telegram',
      channelUserId: '42',
      now: new Date('2026-05-15T12:00:00.000Z'),
      config: baseConfig,
    });

    expect(status.adjustmentCredits).toBe(500);
    expect(status.remainingCredits).toBe(1_450);
  });
});

describe('quota charging', () => {
  it('calculates internal credits from fallback model pricing', () => {
    const result = calculateCredits({
      inputTokens: 1_000,
      outputTokens: 500,
      providerModel: 'claude-sonnet-4-5',
      config: baseConfig,
    });

    expect(result.estimatedCostUsd).toBeCloseTo(0.0105);
    expect(result.creditsSpent).toBe(1_050);
    expect(result.pricingVersion).toBe('test-pricing-1');
    expect(result.coefficientVersion).toBe('test-coeff-1');
  });

  it('uses provider cost for credits when supplied while keeping versions', () => {
    const result = calculateCredits({
      inputTokens: 1,
      outputTokens: 1,
      providerCostUsd: 0.02,
      providerModel: 'claude-sonnet-4-5',
      config: baseConfig,
    });

    expect(result.creditsSpent).toBe(2_000);
    expect(result.pricingVersion).toBe('test-pricing-1');
    expect(result.coefficientVersion).toBe('test-coeff-1');
  });

  it('uses estimated codex subscription credits without provider USD cost', () => {
    const result = calculateCredits({
      inputTokens: 0,
      outputTokens: 0,
      providerCostUsd: null,
      providerModel: 'codex-subscription',
      config: baseConfig,
    });

    expect(result.creditsSpent).toBe(1_000);
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.pricingVersion).toBe('test-pricing-1');
  });

  it('is idempotent for duplicate charge keys', () => {
    const first = charge();
    const second = charge();
    const count = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM usage_ledger`)
      .get() as { c: number };

    expect(first.charged).toBe(true);
    expect(second.charged).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(count.c).toBe(1);
  });

  it('does not double-charge usage_ledger across provider retry/fallback attempts', () => {
    const logicalRequestKey =
      'tenant-a/session-a/telegram/-1001/42/cursor-2026-05-15T12:00:00.000Z';
    const firstProviderAttempt = charge({
      providerModel: 'primary-provider-model',
      inputTokens: 1_000,
      outputTokens: 500,
      idempotencyKey: logicalRequestKey,
    });
    const fallbackProviderAttempt = charge({
      providerModel: 'fallback-provider-model',
      inputTokens: 2_000,
      outputTokens: 700,
      idempotencyKey: logicalRequestKey,
    });
    const rows = getDb()
      .prepare(
        `SELECT provider_model, input_tokens, output_tokens FROM usage_ledger`,
      )
      .all() as Array<{
      provider_model: string;
      input_tokens: number;
      output_tokens: number;
    }>;

    expect(firstProviderAttempt.charged).toBe(true);
    expect(fallbackProviderAttempt.charged).toBe(false);
    expect(fallbackProviderAttempt.duplicate).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider_model: 'primary-provider-model',
      input_tokens: 1_000,
      output_tokens: 500,
    });
  });

  it('does not write ledger rows for failed model calls or shadow mode by default', () => {
    const failed = charge({ runStatus: 'error', idempotencyKey: 'failed' });
    const shadow = charge({ isShadow: true, idempotencyKey: 'shadow' });
    const count = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM usage_ledger`)
      .get() as { c: number };

    expect(failed.skippedReason).toBe('failed_model');
    expect(shadow.skippedReason).toBe('shadow');
    expect(count.c).toBe(0);
  });
});

describe('quota preflight', () => {
  it('hard-blocks before model calls when remaining credits are exhausted', () => {
    const tinyLimit = { ...baseConfig, defaultWeeklyLimitCredits: 1 };
    charge({ config: tinyLimit });

    const preflight = checkQuotaPreflight({
      tenantId: 'tenant-a',
      channel: 'telegram',
      channelUserId: '42',
      now: new Date('2026-05-15T12:00:00.000Z'),
      config: tinyLimit,
    });

    expect(preflight.allowed).toBe(false);
    expect(preflight.reason).toBe('quota_exhausted');
    expect(preflight.status?.remainingCredits).toBeLessThanOrEqual(0);
  });
});
