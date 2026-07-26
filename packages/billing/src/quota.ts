import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import YAML from 'yaml';
import { readEnvFile } from '@skoobi/shared/env';
import { privateAdminDisablesCommercialRuntime } from '@skoobi/shared/private-admin';

// State lives in the current working directory — the directory IS the
// instance (same semantics as the orchestrator's config.ts STATE_ROOT).
const STATE_ROOT = process.cwd();

const DEFAULT_TIMEZONE = 'Asia/Aqtau';
const DEFAULT_WEEKLY_LIMIT_CREDITS = 700_000;
const DEFAULT_GLOBAL_CREDIT_COEFFICIENT = 100_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

type PricingEntry = {
  inputUsdPer1mTokens: number;
  outputUsdPer1mTokens: number;
  cacheReadUsdPer1mTokens?: number;
};

export type BillingConfig = {
  enabled: boolean;
  timezone: string;
  weekStartsOn: 'monday';
  globalCreditCoefficient: number;
  coefficientVersion: string;
  defaultWeeklyLimitCredits: number;
  quotaExhaustedMode: 'block' | 'degraded' | 'allow';
  quotaExtensionContact: string;
  hardBlockWhenExhausted: boolean;
  chargeShadowRequests: boolean;
  showRawTokensToUser: boolean;
  showProviderCostToUser: false;
  pricingVersion: string;
  modelPricing: Record<string, PricingEntry>;
  codexSubscriptionCreditsPerRequest: number;
};

export type QuotaAccount = {
  id: string;
  tenant_id: string;
  channel: string;
  channel_user_id: string;
  weekly_limit_credits: number;
  quota_enabled: number;
  created_at: number;
  updated_at: number;
};

export type WeekPeriod = {
  startMs: number;
  endMs: number;
  timezone: string;
};

export type QuotaStatus = {
  account: QuotaAccount;
  period: WeekPeriod;
  weeklyLimitCredits: number;
  spentCredits: number;
  adjustmentCredits: number;
  remainingCredits: number;
  inputTokens: number;
  outputTokens: number;
  config: BillingConfig;
};

export type QuotaPreflight = {
  allowed: boolean;
  reason?: 'billing_disabled' | 'quota_exhausted' | 'missing_identity';
  degraded?: boolean;
  status?: QuotaStatus;
};

export type ChargeQuotaInput = {
  tenantId: string;
  sessionId: string;
  channel: string;
  chatId: string;
  channelUserId: string;
  modelRole: string;
  providerModel?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  providerCostUsd?: number | null;
  idempotencyKey: string;
  createdAt?: number;
  runStatus?: 'success' | 'error';
  isShadow?: boolean;
  config?: BillingConfig;
};

export type ChargeQuotaResult = {
  charged: boolean;
  duplicate?: boolean;
  skippedReason?: 'failed_model' | 'shadow' | 'billing_disabled';
  account?: QuotaAccount;
  usageLedgerId?: string;
  creditsSpent?: number;
  estimatedCostUsd?: number;
  pricingVersion?: string;
  coefficientVersion?: string;
  /**
   * Post-charge weekly balance for enforced (quota_enabled=1) accounts. May be
   * negative when a single oversized turn overshot the limit. Undefined for
   * unlimited accounts and for skipped/duplicate charges.
   */
  remainingCredits?: number;
  /** True when this charge pushed an enforced account past its weekly limit. */
  exceededLimit?: boolean;
};

let quotaDb: Database.Database | null = null;

const defaultModelPricing: Record<string, PricingEntry> = {
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
  haiku: {
    inputUsdPer1mTokens: 0.25,
    outputUsdPer1mTokens: 1.25,
    cacheReadUsdPer1mTokens: 0.03,
  },
};

function appendOnlyTriggers(tableName: string): string {
  return `
    CREATE TRIGGER IF NOT EXISTS ${tableName}_no_update
    BEFORE UPDATE ON ${tableName}
    BEGIN
      SELECT RAISE(ABORT, '${tableName} is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS ${tableName}_no_delete
    BEFORE DELETE ON ${tableName}
    BEGIN
      SELECT RAISE(ABORT, '${tableName} is append-only');
    END;
  `;
}

export function createQuotaSchema(database: Database.Database): void {
  quotaDb = database;
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_quota_accounts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      channel_user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      weekly_limit_credits INTEGER NOT NULL,
      quota_enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, channel, channel_user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_quota_accounts_identity
      ON user_quota_accounts(tenant_id, channel, channel_user_id);

    CREATE TABLE IF NOT EXISTS usage_ledger (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      channel_user_id TEXT NOT NULL,
      model_role TEXT NOT NULL,
      provider_model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      provider_cost_usd REAL,
      credits_spent INTEGER NOT NULL,
      pricing_version TEXT NOT NULL,
      coefficient_version TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(account_id) REFERENCES user_quota_accounts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_usage_ledger_period
      ON usage_ledger(tenant_id, channel, channel_user_id, created_at);

    CREATE TABLE IF NOT EXISTS quota_adjustments (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      channel_user_id TEXT NOT NULL,
      delta_credits INTEGER NOT NULL,
      reason TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(account_id) REFERENCES user_quota_accounts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_quota_adjustments_period
      ON quota_adjustments(tenant_id, channel, channel_user_id, created_at);
  `);
  database.exec(appendOnlyTriggers('usage_ledger'));
  database.exec(appendOnlyTriggers('quota_adjustments'));
}

function db(): Database.Database {
  if (!quotaDb) throw new Error('Quota database is not initialized');
  return quotaDb;
}

function boolFrom(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function numberFrom(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringFrom(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function quotaExhaustedModeFrom(
  value: unknown,
  fallback: BillingConfig['quotaExhaustedMode'],
): BillingConfig['quotaExhaustedMode'] {
  const normalized = stringFrom(value, fallback).trim().toLowerCase();
  if (normalized === 'degraded' || normalized === 'allow') return normalized;
  return 'block';
}

function readOptionalYamlConfig(): any {
  const env = readEnvFile(['SKOOBI_CONFIG_FILE']);
  const configPath =
    env.SKOOBI_CONFIG_FILE || path.join(STATE_ROOT, 'skoobi.yaml');
  if (!fs.existsSync(configPath)) return {};
  try {
    return YAML.parse(fs.readFileSync(configPath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function normalizePricing(raw: unknown): Record<string, PricingEntry> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, PricingEntry> = {};
  for (const [key, value] of Object.entries(raw as Record<string, any>)) {
    if (!value || typeof value !== 'object') continue;
    const input = numberFrom(
      value.input_usd_per_1m_tokens ?? value.inputUsdPer1mTokens,
      NaN,
    );
    const output = numberFrom(
      value.output_usd_per_1m_tokens ?? value.outputUsdPer1mTokens,
      NaN,
    );
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    out[key.toLowerCase()] = {
      inputUsdPer1mTokens: input,
      outputUsdPer1mTokens: output,
      cacheReadUsdPer1mTokens: numberFrom(
        value.cache_read_usd_per_1m_tokens ?? value.cacheReadUsdPer1mTokens,
        0,
      ),
    };
  }
  return out;
}

export function loadBillingConfig(
  overrides: Partial<BillingConfig> = {},
): BillingConfig {
  const yamlConfig = readOptionalYamlConfig();
  const env = readEnvFile([
    'SKOOBI_BILLING_ENABLED',
    'SKOOBI_BILLING_TIMEZONE',
    'SKOOBI_GLOBAL_CREDIT_COEFFICIENT',
    'SKOOBI_COEFFICIENT_VERSION',
    'SKOOBI_DEFAULT_WEEKLY_LIMIT_CREDITS',
    'SKOOBI_QUOTA_EXHAUSTED_MODE',
    'SKOOBI_QUOTA_EXTENSION_CONTACT',
    'SKOOBI_HARD_BLOCK_WHEN_EXHAUSTED',
    'SKOOBI_CHARGE_SHADOW_REQUESTS',
    'SKOOBI_SHOW_RAW_TOKENS_TO_USER',
    'SKOOBI_PRICING_VERSION',
    'SKOOBI_CODEX_CREDITS_PER_REQUEST',
  ]);

  const billing = yamlConfig.billing || {};
  const currency =
    billing.internal_currency || yamlConfig.internal_currency || {};
  const quota = billing.quota || yamlConfig.quota || {};
  const pricing = billing.pricing || yamlConfig.pricing || {};
  const codexSubscription =
    billing.codex_subscription || yamlConfig.codex_subscription || {};
  const modelPricing = normalizePricing(
    billing.model_pricing || yamlConfig.model_pricing || pricing.model_pricing,
  );

  const base: BillingConfig = {
    enabled: boolFrom(
      env.SKOOBI_BILLING_ENABLED,
      boolFrom(billing.enabled, false),
    ),
    timezone: stringFrom(
      env.SKOOBI_BILLING_TIMEZONE,
      stringFrom(billing.timezone, DEFAULT_TIMEZONE),
    ),
    weekStartsOn: 'monday',
    globalCreditCoefficient: numberFrom(
      env.SKOOBI_GLOBAL_CREDIT_COEFFICIENT,
      numberFrom(
        currency.global_credit_coefficient,
        DEFAULT_GLOBAL_CREDIT_COEFFICIENT,
      ),
    ),
    coefficientVersion: stringFrom(
      env.SKOOBI_COEFFICIENT_VERSION,
      stringFrom(currency.coefficient_version, '1'),
    ),
    defaultWeeklyLimitCredits: Math.max(
      0,
      Math.floor(
        numberFrom(
          env.SKOOBI_DEFAULT_WEEKLY_LIMIT_CREDITS,
          numberFrom(
            quota.default_weekly_limit_credits,
            DEFAULT_WEEKLY_LIMIT_CREDITS,
          ),
        ),
      ),
    ),
    quotaExhaustedMode: quotaExhaustedModeFrom(
      env.SKOOBI_QUOTA_EXHAUSTED_MODE,
      quotaExhaustedModeFrom(
        quota.exhausted_mode ?? quota.exhaustedMode,
        'block',
      ),
    ),
    quotaExtensionContact: stringFrom(
      env.SKOOBI_QUOTA_EXTENSION_CONTACT,
      stringFrom(
        quota.extension_contact ?? quota.extensionContact,
        '',
      ),
    ),
    hardBlockWhenExhausted: boolFrom(
      env.SKOOBI_HARD_BLOCK_WHEN_EXHAUSTED,
      boolFrom(quota.hard_block_when_exhausted, true),
    ),
    chargeShadowRequests: boolFrom(
      env.SKOOBI_CHARGE_SHADOW_REQUESTS,
      boolFrom(quota.charge_shadow_requests, false),
    ),
    showRawTokensToUser: boolFrom(
      env.SKOOBI_SHOW_RAW_TOKENS_TO_USER,
      boolFrom(quota.show_raw_tokens_to_user, true),
    ),
    showProviderCostToUser: false,
    pricingVersion: stringFrom(
      env.SKOOBI_PRICING_VERSION,
      stringFrom(pricing.version, '1'),
    ),
    modelPricing: { ...defaultModelPricing, ...modelPricing },
    codexSubscriptionCreditsPerRequest: Math.max(
      0,
      Math.floor(
        numberFrom(
          env.SKOOBI_CODEX_CREDITS_PER_REQUEST,
          numberFrom(
            codexSubscription.credits_per_request ??
              codexSubscription.creditsPerRequest,
            1000,
          ),
        ),
      ),
    ),
  };

  const resolved: BillingConfig = {
    ...base,
    ...overrides,
    showProviderCostToUser: false,
    weekStartsOn: 'monday',
  };

  if (privateAdminDisablesCommercialRuntime()) {
    return {
      ...resolved,
      enabled: false,
      quotaExhaustedMode: 'allow',
      hardBlockWhenExhausted: false,
      chargeShadowRequests: false,
      showRawTokensToUser: false,
    };
  }

  return resolved;
}

function localParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = localParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

function zonedTimeToUtcMs(
  parts: {
    year: number;
    month: number;
    day: number;
    hour?: number;
    minute?: number;
    second?: number;
  },
  timeZone: string,
): number {
  const base = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  let utc = base - timeZoneOffsetMs(new Date(base), timeZone);
  utc = base - timeZoneOffsetMs(new Date(utc), timeZone);
  return utc;
}

function dateOnlyDayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay();
}

function dateOnlyFromUtcMs(ms: number): {
  year: number;
  month: number;
  day: number;
} {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function getWeekPeriod(
  now = new Date(),
  timeZone = DEFAULT_TIMEZONE,
): WeekPeriod {
  const local = localParts(now, timeZone);
  const dayOfWeek = dateOnlyDayOfWeek(local.year, local.month, local.day);
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const localDateUtc = Date.UTC(local.year, local.month - 1, local.day);
  const startDate = dateOnlyFromUtcMs(
    localDateUtc - daysSinceMonday * MS_PER_DAY,
  );
  const endDate = dateOnlyFromUtcMs(
    Date.UTC(startDate.year, startDate.month - 1, startDate.day) + MS_PER_WEEK,
  );
  const startMs = zonedTimeToUtcMs(startDate, timeZone);
  const endMs = zonedTimeToUtcMs(endDate, timeZone);
  return { startMs, endMs, timezone: timeZone };
}

function quotaAccountRow(row: any): QuotaAccount {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    channel: String(row.channel),
    channel_user_id: String(row.channel_user_id),
    weekly_limit_credits: Number(row.weekly_limit_credits),
    quota_enabled: Number(row.quota_enabled),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function getOrCreateQuotaAccount(
  tenantId: string,
  channel: string,
  channelUserId: string,
  now = Date.now(),
  config = loadBillingConfig(),
): QuotaAccount {
  const database = db();
  const existing = database
    .prepare(
      `SELECT * FROM user_quota_accounts
       WHERE tenant_id = ? AND channel = ? AND channel_user_id = ?`,
    )
    .get(tenantId, channel, channelUserId);
  if (existing) return quotaAccountRow(existing);

  const id = randomUUID();
  database
    .prepare(
      `INSERT OR IGNORE INTO user_quota_accounts
       (id, tenant_id, channel, channel_user_id, weekly_limit_credits, quota_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      id,
      tenantId,
      channel,
      channelUserId,
      config.defaultWeeklyLimitCredits,
      now,
      now,
    );

  const row = database
    .prepare(
      `SELECT * FROM user_quota_accounts
       WHERE tenant_id = ? AND channel = ? AND channel_user_id = ?`,
    )
    .get(tenantId, channel, channelUserId);
  return quotaAccountRow(row);
}

/**
 * Set a tenant's weekly credit limit (and enforcement flag) — used to apply a
 * paid subscription plan. quotaEnabled=false makes the account unlimited
 * (no quota blocking) when a deployment explicitly configures that entitlement.
 */
export function setQuotaPlanLimit(input: {
  tenantId: string;
  channel: string;
  channelUserId: string;
  weeklyLimitCredits: number;
  quotaEnabled?: boolean;
  now?: number;
  config?: BillingConfig;
}): QuotaAccount {
  const now = input.now ?? Date.now();
  const account = getOrCreateQuotaAccount(
    input.tenantId,
    input.channel,
    input.channelUserId,
    now,
    input.config ?? loadBillingConfig(),
  );
  const weeklyLimitCredits = Math.max(0, Math.trunc(input.weeklyLimitCredits));
  const quotaEnabled = input.quotaEnabled === false ? 0 : 1;
  db()
    .prepare(
      `UPDATE user_quota_accounts
       SET weekly_limit_credits = ?, quota_enabled = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(weeklyLimitCredits, quotaEnabled, now, account.id);
  return {
    ...account,
    weekly_limit_credits: weeklyLimitCredits,
    quota_enabled: quotaEnabled,
    updated_at: now,
  };
}

export function addQuotaAdjustment(input: {
  tenantId: string;
  channel: string;
  channelUserId: string;
  deltaCredits: number;
  reason?: string;
  createdBy?: string;
  createdAt?: number;
  config?: BillingConfig;
}): string {
  const createdAt = input.createdAt ?? Date.now();
  const account = getOrCreateQuotaAccount(
    input.tenantId,
    input.channel,
    input.channelUserId,
    createdAt,
    input.config ?? loadBillingConfig(),
  );
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO quota_adjustments
       (id, account_id, tenant_id, channel, channel_user_id, delta_credits, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      account.id,
      input.tenantId,
      input.channel,
      input.channelUserId,
      Math.trunc(input.deltaCredits),
      input.reason ?? null,
      input.createdBy ?? null,
      createdAt,
    );
  return id;
}

function pricingForModel(
  config: BillingConfig,
  providerModel?: string | null,
): PricingEntry {
  const normalized = (providerModel || '').toLowerCase();
  for (const [key, pricing] of Object.entries(config.modelPricing)) {
    if (normalized.includes(key.toLowerCase())) return pricing;
  }
  return config.modelPricing.sonnet || defaultModelPricing.sonnet;
}

export function calculateCredits(input: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  providerCostUsd?: number | null;
  providerModel?: string | null;
  config?: BillingConfig;
}): {
  creditsSpent: number;
  estimatedCostUsd: number;
  pricingVersion: string;
  coefficientVersion: string;
} {
  const config = input.config ?? loadBillingConfig();
  const inputTokens = Math.max(0, Math.trunc(input.inputTokens || 0));
  const outputTokens = Math.max(0, Math.trunc(input.outputTokens || 0));
  const cacheReadTokens = Math.max(0, Math.trunc(input.cacheReadTokens || 0));
  const cacheCreationTokens = Math.max(
    0,
    Math.trunc(input.cacheCreationTokens || 0),
  );
  if (
    String(input.providerModel || '').toLowerCase() === 'codex-subscription'
  ) {
    return {
      creditsSpent: config.codexSubscriptionCreditsPerRequest,
      estimatedCostUsd: 0,
      pricingVersion: config.pricingVersion,
      coefficientVersion: config.coefficientVersion,
    };
  }
  const pricing = pricingForModel(config, input.providerModel);
  // Cache reads use the dedicated cache-read rate when configured. Cache writes
  // are input-side tokens with no separate rate field here, so they are
  // estimated at the base input rate (a conservative proxy).
  const cacheReadRate = pricing.cacheReadUsdPer1mTokens ?? 0;
  const estimatedCostUsd =
    (inputTokens / 1_000_000) * pricing.inputUsdPer1mTokens +
    (outputTokens / 1_000_000) * pricing.outputUsdPer1mTokens +
    (cacheReadTokens / 1_000_000) * cacheReadRate +
    (cacheCreationTokens / 1_000_000) * pricing.inputUsdPer1mTokens;
  // Quota is measured in tokens (1 credit = 1 token): charge every token the
  // turn consumed — fresh input, output, and cache read/creation tokens. Cache
  // tokens were previously excluded, which systematically undercounted long
  // cached dialogs. USD cost is still tracked separately for reporting.
  return {
    creditsSpent: Math.max(
      0,
      inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    ),
    estimatedCostUsd,
    pricingVersion: config.pricingVersion,
    coefficientVersion: config.coefficientVersion,
  };
}

export function getQuotaStatus(input: {
  tenantId: string;
  channel: string;
  channelUserId: string;
  now?: Date;
  config?: BillingConfig;
}): QuotaStatus {
  const config = input.config ?? loadBillingConfig();
  const nowMs = input.now?.getTime() ?? Date.now();
  const account = getOrCreateQuotaAccount(
    input.tenantId,
    input.channel,
    input.channelUserId,
    nowMs,
    config,
  );
  const period = getWeekPeriod(new Date(nowMs), config.timezone);
  const usage = (db()
    .prepare(
      `SELECT
         COALESCE(SUM(credits_spent), 0) AS credits,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM usage_ledger
       WHERE tenant_id = ?
         AND channel = ?
         AND channel_user_id = ?
         AND created_at >= ?
         AND created_at < ?`,
    )
    .get(
      input.tenantId,
      input.channel,
      input.channelUserId,
      period.startMs,
      period.endMs,
    ) || {}) as any;
  const adjustments = (db()
    .prepare(
      `SELECT COALESCE(SUM(delta_credits), 0) AS credits
       FROM quota_adjustments
       WHERE tenant_id = ?
         AND channel = ?
         AND channel_user_id = ?
         AND created_at >= ?
         AND created_at < ?`,
    )
    .get(
      input.tenantId,
      input.channel,
      input.channelUserId,
      period.startMs,
      period.endMs,
    ) || {}) as any;

  const weeklyLimitCredits = Math.max(0, account.weekly_limit_credits);
  const spentCredits = Number(usage.credits || 0);
  const adjustmentCredits = Number(adjustments.credits || 0);
  return {
    account,
    period,
    weeklyLimitCredits,
    spentCredits,
    adjustmentCredits,
    remainingCredits: weeklyLimitCredits + adjustmentCredits - spentCredits,
    inputTokens: Number(usage.input_tokens || 0),
    outputTokens: Number(usage.output_tokens || 0),
    config,
  };
}

export function checkQuotaPreflight(input: {
  tenantId?: string;
  channel: string;
  channelUserId?: string;
  now?: Date;
  config?: BillingConfig;
}): QuotaPreflight {
  if (privateAdminDisablesCommercialRuntime()) {
    return { allowed: true, reason: 'billing_disabled' };
  }
  const config = input.config ?? loadBillingConfig();
  if (!config.enabled) return { allowed: true, reason: 'billing_disabled' };
  if (!input.tenantId || !input.channelUserId)
    return { allowed: true, reason: 'missing_identity' };
  const status = getQuotaStatus({
    tenantId: input.tenantId,
    channel: input.channel,
    channelUserId: input.channelUserId,
    now: input.now,
    config,
  });
  const exhausted =
    status.account.quota_enabled === 1 && status.remainingCredits <= 0;
  if (exhausted && config.quotaExhaustedMode === 'degraded') {
    return {
      allowed: true,
      reason: 'quota_exhausted',
      degraded: true,
      status,
    };
  }
  if (exhausted && config.quotaExhaustedMode === 'allow') {
    return { allowed: true, reason: 'quota_exhausted', status };
  }
  if (config.hardBlockWhenExhausted && exhausted) {
    return { allowed: false, reason: 'quota_exhausted', status };
  }
  return { allowed: true, status };
}

export function chargeQuotaUsage(input: ChargeQuotaInput): ChargeQuotaResult {
  if (privateAdminDisablesCommercialRuntime()) {
    return { charged: false, skippedReason: 'billing_disabled' };
  }
  const config = input.config ?? loadBillingConfig();
  if (!config.enabled)
    return { charged: false, skippedReason: 'billing_disabled' };
  if (input.runStatus === 'error')
    return { charged: false, skippedReason: 'failed_model' };
  if (input.isShadow && !config.chargeShadowRequests)
    return { charged: false, skippedReason: 'shadow' };

  const createdAt = input.createdAt ?? Date.now();
  const account = getOrCreateQuotaAccount(
    input.tenantId,
    input.channel,
    input.channelUserId,
    createdAt,
    config,
  );
  const calculated = calculateCredits({
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheCreationTokens: input.cacheCreationTokens,
    providerCostUsd: input.providerCostUsd,
    providerModel: input.providerModel,
    config,
  });
  const usageLedgerId = randomUUID();
  const result = db()
    .prepare(
      `INSERT OR IGNORE INTO usage_ledger
       (id, account_id, tenant_id, session_id, channel, chat_id, channel_user_id,
        model_role, provider_model, input_tokens, output_tokens, estimated_cost_usd,
        provider_cost_usd, credits_spent, pricing_version, coefficient_version,
        idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      usageLedgerId,
      account.id,
      input.tenantId,
      input.sessionId,
      input.channel,
      input.chatId,
      input.channelUserId,
      input.modelRole,
      input.providerModel ?? null,
      Math.max(0, Math.trunc(input.inputTokens || 0)),
      Math.max(0, Math.trunc(input.outputTokens || 0)),
      calculated.estimatedCostUsd,
      typeof input.providerCostUsd === 'number' &&
        Number.isFinite(input.providerCostUsd)
        ? Math.max(0, input.providerCostUsd)
        : null,
      calculated.creditsSpent,
      calculated.pricingVersion,
      calculated.coefficientVersion,
      input.idempotencyKey,
      createdAt,
    );

  if (result.changes === 0) {
    return {
      charged: false,
      duplicate: true,
      account,
      creditsSpent: calculated.creditsSpent,
      estimatedCostUsd: calculated.estimatedCostUsd,
      pricingVersion: calculated.pricingVersion,
      coefficientVersion: calculated.coefficientVersion,
    };
  }

  // Enforcement policy: "allow once-then-block". Quota is enforced *before* the
  // model runs (checkQuotaPreflight); chargeQuotaUsage records the tokens a
  // completed turn actually consumed and never clamps the ledger — clamping
  // would hide real usage and break the 1-credit-per-token accounting. A single
  // oversized turn can therefore overshoot the weekly limit, but the overshoot
  // is bounded to that one turn: once recorded usage crosses the limit, the next
  // preflight hard-blocks. We surface the post-charge balance so callers can
  // observe/act on an overshoot. Unlimited (quota_enabled=0) accounts are never
  // capped, mirroring checkQuotaPreflight.
  let remainingCredits: number | undefined;
  let exceededLimit = false;
  if (account.quota_enabled === 1) {
    const status = getQuotaStatus({
      tenantId: input.tenantId,
      channel: input.channel,
      channelUserId: input.channelUserId,
      now: new Date(createdAt),
      config,
    });
    remainingCredits = status.remainingCredits;
    exceededLimit = status.remainingCredits < 0;
  }

  return {
    charged: true,
    account,
    usageLedgerId,
    creditsSpent: calculated.creditsSpent,
    estimatedCostUsd: calculated.estimatedCostUsd,
    pricingVersion: calculated.pricingVersion,
    coefficientVersion: calculated.coefficientVersion,
    remainingCredits,
    exceededLimit,
  };
}

function formatCredits(value: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.max(0, Math.trunc(value)));
}

// Quota is measured in tokens (1 credit = 1 token). These format raw token
// counts for display.
function formatSignedCredits(value: number): string {
  const abs = formatCredits(Math.abs(value));
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return '0';
}

function formatWeekPeriod(period: WeekPeriod): string {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: period.timezone,
    day: 'numeric',
    month: 'long',
  });
  const start = formatter.format(new Date(period.startMs));
  const end = formatter.format(new Date(period.endMs - 1));
  return `${start} - ${end}`;
}

function formatNextReset(period: WeekPeriod): string {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: period.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return formatter.format(new Date(period.endMs));
}

export function formatQuotaStatusRu(status: QuotaStatus): string {
  if (!status.config.enabled) {
    return [
      'Скуби сейчас работает без платных тарифов и пользовательских лимитов.',
      '',
      'Ничего оплачивать или продлевать не нужно. Если что-то работает нестабильно, напиши администратору.',
    ].join('\n');
  }

  // Unlimited accounts (e.g. admins, quota disabled) have no numeric cap.
  if (status.account.quota_enabled !== 1) {
    return [
      '📊 Твой лимит на неделю',
      '',
      `Период: ${formatWeekPeriod(status.period)} (${status.period.timezone})`,
      'Лимит: без ограничений',
      `Использовано: ${formatCredits(status.spentCredits)} токенов`,
      '',
      `Сброс: ${formatNextReset(status.period)}`,
    ].join('\n');
  }

  const adjustmentLine =
    status.adjustmentCredits !== 0
      ? `Корректировки: ${formatSignedCredits(status.adjustmentCredits)} токенов\n`
      : '';
  return [
    '📊 Твой лимит на неделю',
    '',
    `Период: ${formatWeekPeriod(status.period)} (${status.period.timezone})`,
    `Недельный лимит: ${formatCredits(status.weeklyLimitCredits)} токенов`,
    `Потрачено: ${formatCredits(status.spentCredits)} токенов`,
    `${adjustmentLine}Осталось: ${formatCredits(status.remainingCredits)} токенов`,
    '',
    `Сброс: ${formatNextReset(status.period)}`,
  ].join('\n');
}

export function formatQuotaBlockedRu(status: QuotaStatus): string {
  if (!status.config.enabled) {
    return formatQuotaStatusRu(status);
  }

  return [
    'Скуби временно не может отправить запрос к модели.',
    '',
    'Пользовательские платные лимиты отключены, поэтому это не связано с оплатой или подпиской. Попробуй ещё раз позже или напиши администратору.',
  ].join('\n');
}

export function formatQuotaDegradedRu(status: QuotaStatus): string {
  if (!status.config.enabled) {
    return formatQuotaStatusRu(status);
  }

  return [
    'Основная модель временно недоступна.',
    '',
    'Я продолжу отвечать в обычном режиме через резервную модель. Ничего оплачивать или продлевать не нужно.',
  ].join('\n');
}

export function quotaIdempotencyKey(input: {
  tenantId: string;
  sessionId: string;
  channel: string;
  chatId: string;
  channelUserId: string;
  targetCursor: number | string;
}): string {
  return [
    'quota_charge',
    input.tenantId,
    input.sessionId,
    input.channel,
    input.chatId,
    input.channelUserId,
    String(input.targetCursor),
  ].join(':');
}
