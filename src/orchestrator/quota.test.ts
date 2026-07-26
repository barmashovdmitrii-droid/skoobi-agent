import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  loadBillingConfig,
  setQuotaPlanLimit,
  type BillingConfig,
} from './quota.js';

const baseConfig: BillingConfig = {
  enabled: true,
  timezone: 'Asia/Aqtau',
  weekStartsOn: 'monday',
  globalCreditCoefficient: 100_000,
  coefficientVersion: 'test-coeff-1',
  defaultWeeklyLimitCredits: 2_000,
  quotaExhaustedMode: 'block',
  quotaExtensionContact: '@owner_fixture',
  hardBlockWhenExhausted: true,
  chargeShadowRequests: false,
  showRawTokensToUser: true,
  showProviderCostToUser: false,
  pricingVersion: 'test-pricing-1',
  codexSubscriptionCreditsPerRequest: 1_000,
  modelPricing: {
    sonnet: {
      inputUsdPer1mTokens: 3,
      outputUsdPer1mTokens: 15,
      cacheReadUsdPer1mTokens: 0.3,
    },
    opus: {
      inputUsdPer1mTokens: 15,
      outputUsdPer1mTokens: 75,
      cacheReadUsdPer1mTokens: 0.3,
    },
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
    expect(formatQuotaStatusRu(status)).toContain('токенов');
    expect(formatQuotaStatusRu(status)).not.toContain('кредит');
    expect(formatQuotaStatusRu(status)).not.toMatch(/usd|provider/i);
  });

  it('formats disabled billing as no paid tariffs and no user limits', () => {
    const status = getQuotaStatus({
      tenantId: 'tenant-a',
      channel: 'telegram',
      channelUserId: '42',
      now: new Date('2026-05-15T12:00:00.000Z'),
      config: { ...baseConfig, enabled: false },
    });

    const text = formatQuotaStatusRu(status);
    expect(text).toContain('без платных тарифов');
    expect(text).toContain('пользовательских лимитов');
    expect(text).not.toContain('Недельный лимит');
    expect(text).not.toContain('продлить лимит');
  });

  it('disables billing by default when no env/yaml override is provided', () => {
    const previousEnvFile = process.env.CLAUDECLAW_ENV_FILE;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-quota-test-'));
    const envFile = path.join(tmp, '.env');
    fs.writeFileSync(
      envFile,
      `SKOOBI_CONFIG_FILE=${path.join(tmp, 'missing.yaml')}\n`,
    );
    process.env.CLAUDECLAW_ENV_FILE = envFile;
    try {
      expect(loadBillingConfig({}).enabled).toBe(false);
    } finally {
      if (previousEnvFile === undefined) delete process.env.CLAUDECLAW_ENV_FILE;
      else process.env.CLAUDECLAW_ENV_FILE = previousEnvFile;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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

    expect(status.spentCredits).toBe(1_500);
    expect(status.remainingCredits).toBe(500);
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
    expect(status.remainingCredits).toBe(1_000);
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
    expect(result.creditsSpent).toBe(1_500);
    expect(result.pricingVersion).toBe('test-pricing-1');
    expect(result.coefficientVersion).toBe('test-coeff-1');
  });

  it('charges actual tokens regardless of provider cost, keeping versions', () => {
    const result = calculateCredits({
      inputTokens: 1,
      outputTokens: 1,
      providerCostUsd: 0.02,
      providerModel: 'claude-sonnet-4-5',
      config: baseConfig,
    });

    expect(result.creditsSpent).toBe(2);
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

  it('includes cache-read and cache-creation tokens in credits and cost', () => {
    const result = calculateCredits({
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 8_000,
      cacheCreationTokens: 200,
      providerModel: 'claude-sonnet-4-5',
      config: baseConfig,
    });

    // 1 credit = 1 token across fresh input, output, and cache tokens.
    expect(result.creditsSpent).toBe(9_700);
    // input 0.003 + output 0.0075 + cacheRead 0.0024 + cacheCreate 0.0006.
    expect(result.estimatedCostUsd).toBeCloseTo(0.0135);
  });

  it('charges cache tokens while keeping raw input/output ledger columns', () => {
    const cacheConfig = { ...baseConfig, defaultWeeklyLimitCredits: 1_000_000 };
    const result = charge({
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 2_000,
      cacheCreationTokens: 100,
      idempotencyKey: 'cache-charge',
      config: cacheConfig,
    });
    const row = getDb()
      .prepare(
        `SELECT input_tokens, output_tokens, credits_spent FROM usage_ledger WHERE id = ?`,
      )
      .get(result.usageLedgerId) as {
      input_tokens: number;
      output_tokens: number;
      credits_spent: number;
    };
    const status = getQuotaStatus({
      tenantId: 'tenant-a',
      channel: 'telegram',
      channelUserId: '42',
      now: new Date('2026-05-15T12:00:00.000Z'),
      config: cacheConfig,
    });

    expect(result.charged).toBe(true);
    expect(result.creditsSpent).toBe(3_600);
    // Cache tokens land in credits_spent; raw columns stay un-folded.
    expect(row.input_tokens).toBe(1_000);
    expect(row.output_tokens).toBe(500);
    expect(row.credits_spent).toBe(3_600);
    expect(status.spentCredits).toBe(3_600);
    expect(status.inputTokens).toBe(1_000);
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

  it('can switch to degraded mode instead of blocking exhausted users', () => {
    const degradedLimit = {
      ...baseConfig,
      defaultWeeklyLimitCredits: 1,
      quotaExhaustedMode: 'degraded' as const,
    };
    charge({ config: degradedLimit });

    const preflight = checkQuotaPreflight({
      tenantId: 'tenant-a',
      channel: 'telegram',
      channelUserId: '42',
      now: new Date('2026-05-15T12:00:00.000Z'),
      config: degradedLimit,
    });

    expect(preflight.allowed).toBe(true);
    expect(preflight.degraded).toBe(true);
    expect(preflight.reason).toBe('quota_exhausted');
    expect(preflight.status?.remainingCredits).toBeLessThanOrEqual(0);
  });
});

describe('quota charge-time enforcement (allow once-then-block)', () => {
  it('records a single oversized turn in full and surfaces the overshoot', () => {
    const tinyLimit = { ...baseConfig, defaultWeeklyLimitCredits: 1_000 };
    const result = charge({
      inputTokens: 4_000,
      outputTokens: 1_000,
      idempotencyKey: 'oversized-turn',
      config: tinyLimit,
    });

    expect(result.charged).toBe(true);
    expect(result.creditsSpent).toBe(5_000);
    expect(result.exceededLimit).toBe(true);
    expect(result.remainingCredits).toBe(-4_000);

    // The overshoot is bounded to one turn: the next preflight hard-blocks.
    const preflight = checkQuotaPreflight({
      tenantId: 'tenant-a',
      channel: 'telegram',
      channelUserId: '42',
      now: new Date('2026-05-15T12:00:00.000Z'),
      config: tinyLimit,
    });
    expect(preflight.allowed).toBe(false);
    expect(preflight.reason).toBe('quota_exhausted');
  });

  it('does not flag a charge that stays within the weekly limit', () => {
    const result = charge({
      inputTokens: 200,
      outputTokens: 100,
      idempotencyKey: 'within-limit',
    });

    expect(result.charged).toBe(true);
    expect(result.exceededLimit).toBe(false);
    expect(result.remainingCredits).toBe(1_700);
  });

  it('never caps unlimited (quota_enabled=0) accounts at charge time', () => {
    setQuotaPlanLimit({
      tenantId: 'tenant-a',
      channel: 'telegram',
      channelUserId: '42',
      weeklyLimitCredits: 1_000,
      quotaEnabled: false,
      config: baseConfig,
    });

    const result = charge({
      inputTokens: 5_000_000,
      outputTokens: 1_000_000,
      idempotencyKey: 'unlimited-admin',
    });

    expect(result.charged).toBe(true);
    expect(result.exceededLimit).toBe(false);
    expect(result.remainingCredits).toBeUndefined();

    // Unlimited accounts are never blocked, even after a huge charge.
    const preflight = checkQuotaPreflight({
      tenantId: 'tenant-a',
      channel: 'telegram',
      channelUserId: '42',
      now: new Date('2026-05-15T12:00:00.000Z'),
      config: baseConfig,
    });
    expect(preflight.allowed).toBe(true);
  });
});
