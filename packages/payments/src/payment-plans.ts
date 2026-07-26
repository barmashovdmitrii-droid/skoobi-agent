import { createHash } from 'node:crypto';

import { readEnvFile } from '@skoobi/shared';

import type { CreatePaymentInput, PaymentMethod } from './payment-gateway.js';

const PAYMENT_CATALOG_ENV_KEY = 'SKOOBI_PAYMENT_CATALOG_JSON';
const MAX_CATALOG_JSON_BYTES = 64 * 1024;
const MAX_PLANS = 50;
const MAX_PRICES = 20;
const MAX_TITLES = 16;
const MAX_WEEKLY_LIMIT_CREDITS = 1_000_000_000_000;
const MAX_PERIOD_DAYS = 3_660;
const PLAN_CODE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const AMOUNT_RE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const PAYMENT_METHOD_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const TITLE_KEY_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CUSTOM_FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;

export type PlanCode = string;

export type PlanTitles = Readonly<Record<string, string>>;

export type PaymentPlan = {
  code: PlanCode;
  /** Active-currency amount charged now (major units). Empty for a free plan. */
  amountMajor: string;
  /** Active three-letter currency code. */
  currency: string;
  /** Display/charge amounts keyed by three-letter currency code. */
  prices: Readonly<Record<string, string>>;
  free: boolean;
  /** Weekly entitlement expressed directly in host-defined credits. */
  weeklyLimitCredits: number;
  quotaEnabled: boolean;
  /** Entitlement validity in days. */
  periodDays: number;
  /** Optional explicit methods; when omitted the gateway default applies. */
  methods?: readonly PaymentMethod[];
  /** Localized display titles keyed by a locale-like code. */
  titles: PlanTitles;
};

export type PlanCatalog = Readonly<Record<string, PaymentPlan>>;

export const EMPTY_PAYMENT_PLAN_CATALOG: PlanCatalog = Object.freeze(
  Object.create(null) as Record<string, PaymentPlan>,
);

const REQUIRED_PLAN_KEYS = new Set([
  'code',
  'amountMajor',
  'currency',
  'prices',
  'free',
  'weeklyLimitCredits',
  'quotaEnabled',
  'periodDays',
  'titles',
]);
const OPTIONAL_PLAN_KEYS = new Set(['methods']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactPlanKeys(
  value: Record<string, unknown>,
  index: number,
): void {
  for (const key of Object.keys(value)) {
    if (!REQUIRED_PLAN_KEYS.has(key) && !OPTIONAL_PLAN_KEYS.has(key)) {
      throw new Error(
        `Payment plan at index ${index} has an unsupported field`,
      );
    }
  }
  for (const key of REQUIRED_PLAN_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(
        `Payment plan at index ${index} is missing field "${key}"`,
      );
    }
  }
}

function requiredString(
  value: unknown,
  field: string,
  index: number,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    CONTROL_CHARACTER_RE.test(value)
  ) {
    throw new Error(`Payment plan at index ${index} has invalid ${field}`);
  }
  return value;
}

function integerInRange(
  value: unknown,
  field: string,
  index: number,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw new Error(`Payment plan at index ${index} has invalid ${field}`);
  }
  return value as number;
}

function parsePrices(
  value: unknown,
  index: number,
): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw new Error(`Payment plan at index ${index} has invalid prices`);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_PRICES) {
    throw new Error(`Payment plan at index ${index} has too many prices`);
  }
  const prices = Object.create(null) as Record<string, string>;
  for (const [currency, amount] of entries) {
    if (
      !CURRENCY_RE.test(currency) ||
      typeof amount !== 'string' ||
      !AMOUNT_RE.test(amount) ||
      Number(amount) <= 0
    ) {
      throw new Error(`Payment plan at index ${index} has an invalid price`);
    }
    prices[currency] = amount;
  }
  return Object.freeze(prices);
}

function parseTitles(value: unknown, index: number): PlanTitles {
  if (!isRecord(value)) {
    throw new Error(`Payment plan at index ${index} has invalid titles`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_TITLES) {
    throw new Error(`Payment plan at index ${index} has invalid titles`);
  }
  const titles = Object.create(null) as Record<string, string>;
  for (const [locale, title] of entries) {
    if (!TITLE_KEY_RE.test(locale)) {
      throw new Error(
        `Payment plan at index ${index} has an invalid title key`,
      );
    }
    titles[locale] = requiredString(title, 'title', index, 80);
  }
  return Object.freeze(titles);
}

function parseMethods(
  value: unknown,
  index: number,
): readonly PaymentMethod[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Payment plan at index ${index} has invalid methods`);
  }
  const methods: PaymentMethod[] = [];
  for (const method of value) {
    if (
      typeof method !== 'string' ||
      !PAYMENT_METHOD_RE.test(method) ||
      methods.includes(method)
    ) {
      throw new Error(`Payment plan at index ${index} has invalid methods`);
    }
    methods.push(method);
  }
  return Object.freeze(methods);
}

function parsePaymentPlan(value: unknown, index: number): PaymentPlan {
  if (!isRecord(value)) {
    throw new Error(`Payment plan at index ${index} must be an object`);
  }
  assertExactPlanKeys(value, index);

  const code = requiredString(value.code, 'code', index, 32);
  if (!PLAN_CODE_RE.test(code)) {
    throw new Error(`Payment plan at index ${index} has invalid code`);
  }

  const currency = requiredString(value.currency, 'currency', index, 3);
  if (!CURRENCY_RE.test(currency)) {
    throw new Error(`Payment plan at index ${index} has invalid currency`);
  }

  if (typeof value.free !== 'boolean') {
    throw new Error(`Payment plan at index ${index} has invalid free`);
  }
  if (typeof value.quotaEnabled !== 'boolean') {
    throw new Error(`Payment plan at index ${index} has invalid quotaEnabled`);
  }

  const amountMajor =
    typeof value.amountMajor === 'string' ? value.amountMajor : '';
  if (typeof value.amountMajor !== 'string') {
    throw new Error(`Payment plan at index ${index} has invalid amountMajor`);
  }
  const prices = parsePrices(value.prices, index);
  const weeklyLimitCredits = integerInRange(
    value.weeklyLimitCredits,
    'weeklyLimitCredits',
    index,
    0,
    MAX_WEEKLY_LIMIT_CREDITS,
  );
  const periodDays = integerInRange(
    value.periodDays,
    'periodDays',
    index,
    1,
    MAX_PERIOD_DAYS,
  );
  const titles = parseTitles(value.titles, index);
  const methods = parseMethods(value.methods, index);

  if (value.free) {
    if (amountMajor !== '' || Object.keys(prices).length !== 0) {
      throw new Error(
        `Free payment plan at index ${index} must not define a charge`,
      );
    }
  } else {
    if (
      !AMOUNT_RE.test(amountMajor) ||
      Number(amountMajor) <= 0 ||
      prices[currency] !== amountMajor
    ) {
      throw new Error(
        `Paid payment plan at index ${index} must define its active-currency price`,
      );
    }
  }

  if (
    (value.quotaEnabled && weeklyLimitCredits === 0) ||
    (!value.quotaEnabled && weeklyLimitCredits !== 0)
  ) {
    throw new Error(
      `Payment plan at index ${index} has inconsistent quota settings`,
    );
  }

  return Object.freeze({
    code,
    amountMajor,
    currency,
    prices,
    free: value.free,
    weeklyLimitCredits,
    quotaEnabled: value.quotaEnabled,
    periodDays,
    ...(methods ? { methods } : {}),
    titles,
  });
}

/**
 * Load a deployment-owned payment catalog.
 *
 * An explicit JSON string takes precedence. Otherwise the value is read from
 * the local env file and then the process environment. Missing or blank input
 * fails closed to an empty, immutable catalog.
 */
export function loadPaymentPlanCatalog(jsonOverride?: string): PlanCatalog {
  const fileEnv =
    jsonOverride === undefined ? readEnvFile([PAYMENT_CATALOG_ENV_KEY]) : {};
  const raw =
    jsonOverride ??
    fileEnv[PAYMENT_CATALOG_ENV_KEY] ??
    process.env[PAYMENT_CATALOG_ENV_KEY];

  if (raw === undefined || raw.trim() === '') {
    return EMPTY_PAYMENT_PLAN_CATALOG;
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_CATALOG_JSON_BYTES) {
    throw new Error('Payment plan catalog JSON is too large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Payment plan catalog is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Payment plan catalog must be a JSON array');
  }
  if (parsed.length > MAX_PLANS) {
    throw new Error(`Payment plan catalog exceeds ${MAX_PLANS} plans`);
  }

  const catalog = Object.create(null) as Record<string, PaymentPlan>;
  parsed.forEach((value, index) => {
    const plan = parsePaymentPlan(value, index);
    if (Object.prototype.hasOwnProperty.call(catalog, plan.code)) {
      throw new Error(`Payment plan catalog has duplicate code "${plan.code}"`);
    }
    catalog[plan.code] = plan;
  });
  return Object.freeze(catalog);
}

export function getPlan(
  code: string,
  catalog: PlanCatalog,
): PaymentPlan | undefined {
  return Object.prototype.hasOwnProperty.call(catalog, code)
    ? catalog[code]
    : undefined;
}

/**
 * Resolve a generic start value only when it is exactly a configured plan code.
 */
export function planFromStartPayload(
  payload: string | undefined,
  catalog: PlanCatalog,
): PaymentPlan | undefined {
  const code = String(payload ?? '')
    .trim()
    .toLowerCase();
  return code ? getPlan(code, catalog) : undefined;
}

export type PlanPaymentContext = {
  /** Caller-generated idempotency and traceability key for this purchase. */
  merchantTransactionId: string;
  customerId?: string | number;
  applicationId?: string;
  productName?: string;
  returnUrl?: string;
  /** Override currency (defaults to the plan currency). */
  currency?: string;
  /** Extra non-secret custom fields merged into the request. */
  customFields?: Record<string, string>;
};

function optionalContextText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  const text = String(value);
  if (
    text.length === 0 ||
    text.length > maxLength ||
    text !== text.trim() ||
    CONTROL_CHARACTER_RE.test(text)
  ) {
    throw new Error(`Invalid payment ${field}`);
  }
  return text;
}

function validatedCustomFields(
  fields: Record<string, string> | undefined,
): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (
      !CUSTOM_FIELD_KEY_RE.test(key) ||
      typeof value !== 'string' ||
      value.length > 256 ||
      CONTROL_CHARACTER_RE.test(value)
    ) {
      throw new Error('Invalid payment custom field');
    }
    result[key] = value;
  }
  return result;
}

function validatedReturnUrl(value: string | undefined): string | undefined {
  const text = optionalContextText(value, 'returnUrl', 2_048);
  if (text === undefined) return undefined;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Invalid payment returnUrl');
  }
  const localHttp =
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !localHttp) ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('Invalid payment returnUrl');
  }
  return text;
}

/**
 * Build a gateway input for a configured paid plan.
 * Free plans and missing prices fail closed without creating a charge.
 */
export function buildPlanPaymentInput(
  plan: PaymentPlan,
  ctx: PlanPaymentContext,
): CreatePaymentInput {
  if (plan.free) {
    throw new Error(`Plan "${plan.code}" is free and cannot be charged`);
  }
  if (!SAFE_ID_RE.test(ctx.merchantTransactionId)) {
    throw new Error('A valid merchantTransactionId is required');
  }

  const currency = ctx.currency ?? plan.currency;
  if (!CURRENCY_RE.test(currency)) {
    throw new Error('A valid payment currency is required');
  }
  const amount =
    plan.prices[currency] ??
    (currency === plan.currency ? plan.amountMajor : '');
  if (!amount || !AMOUNT_RE.test(amount) || Number(amount) <= 0) {
    throw new Error(`Plan "${plan.code}" has no valid price in ${currency}`);
  }

  const customerId = optionalContextText(ctx.customerId, 'customerId', 128);
  const applicationId = optionalContextText(
    ctx.applicationId,
    'applicationId',
    128,
  );
  const productName = optionalContextText(ctx.productName, 'productName', 80);
  const returnUrl = validatedReturnUrl(ctx.returnUrl);
  const customFields = validatedCustomFields(ctx.customFields);
  customFields.planCode = plan.code;
  customFields.purpose = `plan:${plan.code}`;
  if (customerId !== undefined) customFields.customerId = customerId;
  if (applicationId !== undefined) customFields.applicationId = applicationId;

  return {
    amount,
    currency,
    merchantTransactionId: ctx.merchantTransactionId,
    ...(productName ? { description: `${productName} ${plan.code}` } : {}),
    ...(plan.methods ? { paymentMethods: [...plan.methods] } : {}),
    ...(returnUrl ? { returnUrl } : {}),
    customFields,
  };
}

function safeIdPart(
  value: string | number,
  field: string,
  maxLength: number,
): string {
  const sanitized = String(value)
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, maxLength);
  if (!sanitized) {
    throw new Error(`Payment ${field} must contain a safe identifier`);
  }
  return sanitized;
}

function boundedIdMaterial(value: string | number, field: string): string {
  const text = String(value);
  if (
    text.length === 0 ||
    text.length > 256 ||
    CONTROL_CHARACTER_RE.test(text)
  ) {
    throw new Error(`Payment ${field} is invalid`);
  }
  return text;
}

/**
 * Generate a bounded, deterministic merchant transaction id without exposing
 * the raw customer identifier. Length-prefixed hashing avoids collisions from
 * punctuation stripping or truncation.
 */
export function planMerchantTransactionId(
  plan: PaymentPlan,
  customerId: string | number,
  nonce: string | number,
  prefix: string = 'order',
): string {
  const safePrefix = safeIdPart(prefix, 'prefix', 16);
  const safePlan = safeIdPart(plan.code, 'plan code', 32);
  const material = [
    boundedIdMaterial(prefix, 'prefix'),
    boundedIdMaterial(plan.code, 'plan code'),
    boundedIdMaterial(customerId, 'customer id'),
    boundedIdMaterial(nonce, 'nonce'),
  ];
  const digest = createHash('sha256')
    .update(
      material
        .map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`)
        .join('|'),
    )
    .digest('hex')
    .slice(0, 40);
  return `${safePrefix}_${safePlan}_${digest}`;
}

export type PlanQuotaTarget = {
  weeklyLimitCredits: number;
  quotaEnabled: boolean;
};

/**
 * Return the deployment-configured weekly entitlement without hidden formulas.
 */
export function planQuotaTarget(plan: PaymentPlan): PlanQuotaTarget {
  return {
    weeklyLimitCredits: plan.weeklyLimitCredits,
    quotaEnabled: plan.quotaEnabled,
  };
}
