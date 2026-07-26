import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';

// Same semantics as the old orchestrator DATA_DIR (= <service cwd>/data);
// avoids dragging core config into the payments brick.
const DATA_DIR = path.resolve(process.cwd(), 'data');
import {
  PaymentGatewayError,
  type CreatePaymentResult,
  type OrderInfo,
} from './payment-gateway.js';
import {
  type PaymentPlan,
  type PlanCatalog,
  type PlanCode,
  buildPlanPaymentInput,
  getPlan,
  planMerchantTransactionId,
} from './payment-plans.js';

// Provider-neutral subscription lifecycle. A concrete network adapter and the
// reviewed plan catalog are injected by the host.
//
// startPlanPurchase()  -> create an order, persist a pending subscription,
//                         return the payform URL for the payer.
// confirmPlanPurchase()-> re-read the order (poll or webhook), and on a charged
//                         order mark the subscription active and run activate().
//
// Quota activation itself is injected (activate callback) so this module stays
// decoupled from quota internals and fully unit-testable.

export type SubscriptionStatus =
  | 'pending'
  | 'review'
  | 'active'
  | 'failed'
  | 'expired';

export type SubscriptionRecord = {
  orderId: string;
  merchantTransactionId: string;
  jid: string;
  channel: string;
  tenantId?: string;
  channelUserId?: string;
  planCode: PlanCode;
  amount: string;
  currency: string;
  /** Entitlement snapshot captured before the external charge is created. */
  periodDays?: number;
  weeklyLimitCredits?: number;
  quotaEnabled?: boolean;
  status: SubscriptionStatus;
  resultUrl?: string;
  createdAt: string;
  paidAt?: string;
  expiresAt?: string;
  lastCheckedAt?: string;
  lastOrderStatus?: string;
};

type SubscriptionMap = Record<string, SubscriptionRecord>;

const ORDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const PLAN_CODE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const AMOUNT_RE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const SUBSCRIPTION_STATUSES = new Set<SubscriptionStatus>([
  'pending',
  'review',
  'active',
  'failed',
  'expired',
]);
export const DEFAULT_PAYMENT_OPERATION_TIMEOUT_MS = 20_000;

async function withPaymentTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new PaymentGatewayError(
            'Payment provider operation timed out',
            'timeout',
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validOrderId(value: unknown): value is string {
  return typeof value === 'string' && ORDER_ID_RE.test(value);
}

function requiredIdentity(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value : '';
  if (
    text.length === 0 ||
    text.length > 256 ||
    text !== text.trim() ||
    CONTROL_CHARACTER_RE.test(text)
  ) {
    throw new Error(`${field} is required and must be a safe identifier`);
  }
  return text;
}

function validatedCheckoutUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    CONTROL_CHARACTER_RE.test(value)
  ) {
    throw new Error('Payment provider returned an invalid checkout URL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Payment provider returned an invalid checkout URL');
  }
  const localHttp =
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !localHttp) ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('Payment provider returned an invalid checkout URL');
  }
  return value;
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    !CONTROL_CHARACTER_RE.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validateSubscriptionRecord(
  value: unknown,
  expectedOrderId?: string,
): SubscriptionRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('subscription store contains an invalid record');
  }
  const record = value as SubscriptionRecord;
  if (!validOrderId(record.orderId)) {
    throw new Error('Subscription order id is invalid');
  }
  if (expectedOrderId !== undefined && record.orderId !== expectedOrderId) {
    throw new Error('subscription store order id does not match its key');
  }
  if (!record.channel && String(record.jid ?? '').startsWith('tg:')) {
    record.channel = 'telegram';
  }
  requiredIdentity(record.merchantTransactionId, 'merchantTransactionId');
  requiredIdentity(record.jid, 'jid');
  requiredIdentity(record.channel, 'channel');
  if (record.tenantId !== undefined) {
    requiredIdentity(record.tenantId, 'tenantId');
  }
  if (record.channelUserId !== undefined) {
    requiredIdentity(record.channelUserId, 'channelUserId');
  }
  if (
    typeof record.planCode !== 'string' ||
    !PLAN_CODE_RE.test(record.planCode) ||
    typeof record.amount !== 'string' ||
    !AMOUNT_RE.test(record.amount) ||
    Number(record.amount) <= 0 ||
    typeof record.currency !== 'string' ||
    !CURRENCY_RE.test(record.currency) ||
    !SUBSCRIPTION_STATUSES.has(record.status) ||
    !validTimestamp(record.createdAt)
  ) {
    throw new Error('subscription store contains an invalid record');
  }
  if (
    record.periodDays !== undefined &&
    (!Number.isSafeInteger(record.periodDays) ||
      record.periodDays < 1 ||
      record.periodDays > 3_660)
  ) {
    throw new Error('subscription store contains an invalid entitlement');
  }
  if (
    record.weeklyLimitCredits !== undefined &&
    (!Number.isSafeInteger(record.weeklyLimitCredits) ||
      record.weeklyLimitCredits < 0 ||
      record.weeklyLimitCredits > 1_000_000_000_000)
  ) {
    throw new Error('subscription store contains an invalid entitlement');
  }
  if (
    record.quotaEnabled !== undefined &&
    typeof record.quotaEnabled !== 'boolean'
  ) {
    throw new Error('subscription store contains an invalid entitlement');
  }
  if (
    record.weeklyLimitCredits !== undefined &&
    record.quotaEnabled !== undefined &&
    ((record.quotaEnabled && record.weeklyLimitCredits === 0) ||
      (!record.quotaEnabled && record.weeklyLimitCredits !== 0))
  ) {
    throw new Error('subscription store contains an invalid entitlement');
  }
  if (record.resultUrl !== undefined) {
    validatedCheckoutUrl(record.resultUrl);
  }
  for (const timestamp of [record.paidAt, record.lastCheckedAt]) {
    if (timestamp !== undefined && !validTimestamp(timestamp)) {
      throw new Error('subscription store contains an invalid timestamp');
    }
  }
  // expiresAt is deliberately allowed to be malformed: reconciliation treats
  // an absent or invalid expiry as already expired and removes entitlement.
  if (
    record.expiresAt !== undefined &&
    (typeof record.expiresAt !== 'string' ||
      record.expiresAt.length > 64 ||
      CONTROL_CHARACTER_RE.test(record.expiresAt))
  ) {
    throw new Error('subscription store contains an invalid timestamp');
  }
  if (
    record.lastOrderStatus !== undefined &&
    (typeof record.lastOrderStatus !== 'string' ||
      record.lastOrderStatus.length > 128 ||
      CONTROL_CHARACTER_RE.test(record.lastOrderStatus))
  ) {
    throw new Error('subscription store contains an invalid order status');
  }
  return record;
}

export class SubscriptionStore {
  constructor(private readonly filePath: string) {}

  private readAll(): SubscriptionMap {
    // Finding #28: ONLY a missing file is a legitimately-empty store. Any other
    // read error (EACCES/EMFILE/ENOSPC/EIO) or a JSON parse failure (a truncated/
    // corrupted file from an interrupted write or manual edit) must NOT be
    // swallowed into {} — doing so makes the whole subscription set look empty,
    // so the pending sweep never activates a charged-but-pending order, getByOrder
    // returns undefined (confirmPlanPurchase throws "No subscription found"), and
    // reconcile finds nothing to revoke. The failure is asymmetric (entitlements
    // get stranded/forgotten) and silent. Log loudly and throw so the sweep does
    // NOT act on phantom-empty state and an operator is alerted; the periodic
    // sweep retries on the next interval once the transient error clears.
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return {}; // never created yet — truly empty
      }
      console.error(
        `[payment-service] failed to read subscription store ${this.filePath}:`,
        err,
      );
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        throw new Error('subscription store root must be an object');
      }
      const records = Object.create(null) as SubscriptionMap;
      for (const [key, value] of Object.entries(parsed)) {
        if (!validOrderId(key)) {
          throw new Error('subscription store contains an invalid record');
        }
        // Public releases before the provider-neutral catalog stored Telegram
        // records without an explicit channel. The validator migrates only
        // that one unambiguous legacy shape; everything else fails closed.
        const record = validateSubscriptionRecord(value, key);
        records[key] = record;
      }
      return records;
    } catch (err) {
      console.error(
        `[payment-service] subscription store ${this.filePath} is corrupted (JSON parse failed); refusing to treat it as empty:`,
        err,
      );
      throw err instanceof Error
        ? err
        : new Error(`Corrupted subscription store at ${this.filePath}`);
    }
  }

  private writeAll(map: SubscriptionMap): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  getByOrder(orderId: string): SubscriptionRecord | undefined {
    if (!validOrderId(orderId)) return undefined;
    const records = this.readAll();
    return Object.prototype.hasOwnProperty.call(records, orderId)
      ? records[orderId]
      : undefined;
  }

  upsert(record: SubscriptionRecord): void {
    validateSubscriptionRecord(record, record.orderId);
    const map = this.readAll();
    map[record.orderId] = record;
    this.writeAll(map);
  }

  findByMerchantTransactionId(
    merchantTransactionId: string,
  ): SubscriptionRecord | undefined {
    return Object.values(this.readAll()).find(
      (record) => record.merchantTransactionId === merchantTransactionId,
    );
  }

  /** Latest active, non-expired subscription for a chat jid. */
  findActiveByJid(
    jid: string,
    now = Date.now(),
  ): SubscriptionRecord | undefined {
    const records = Object.values(this.readAll())
      .filter((r) => r.jid === jid && r.status === 'active')
      .filter((r) => !r.expiresAt || new Date(r.expiresAt).getTime() > now)
      .sort((a, b) =>
        (a.paidAt || a.createdAt).localeCompare(b.paidAt || b.createdAt),
      );
    return records.at(-1);
  }

  listPending(): SubscriptionRecord[] {
    return Object.values(this.readAll()).filter((r) => r.status === 'pending');
  }

  /** All currently-active subscriptions (regardless of expiry) — the input to
   * the active-reconciliation pass that enforces expiry and post-pay reversals. */
  listActive(): SubscriptionRecord[] {
    return Object.values(this.readAll()).filter((r) => r.status === 'active');
  }
}

export function defaultSubscriptionStore(): SubscriptionStore {
  return new SubscriptionStore(
    path.join(DATA_DIR, 'skoobi-subscriptions.json'),
  );
}

export type StartPurchaseDeps = {
  gateway: {
    createPayment: (
      input: ReturnType<typeof buildPlanPaymentInput>,
    ) => Promise<CreatePaymentResult>;
  };
  store: SubscriptionStore;
  now?: () => number;
  timeoutMs?: number;
};

export type StartPurchaseParams = {
  plan: PaymentPlan;
  jid: string;
  channel: string;
  customerId: string | number;
  /** Stable caller-owned idempotency key, reused for every retry. */
  purchaseId: string;
  tenantId: string;
  channelUserId: string;
  applicationId?: string;
  productName?: string;
  merchantPrefix?: string;
  returnUrl?: string;
};

export type StartPurchaseResult = {
  resultUrl: string;
  orderId: string;
  record: SubscriptionRecord;
};

export async function startPlanPurchase(
  deps: StartPurchaseDeps,
  params: StartPurchaseParams,
): Promise<StartPurchaseResult> {
  if (params.plan.free) {
    throw new Error(`Plan "${params.plan.code}" is free; no purchase needed`);
  }
  const jid = requiredIdentity(params.jid, 'jid');
  const channel = requiredIdentity(params.channel, 'channel');
  const tenantId = requiredIdentity(params.tenantId, 'tenantId');
  const channelUserId = requiredIdentity(params.channelUserId, 'channelUserId');
  const customerId = requiredIdentity(String(params.customerId), 'customerId');
  const identityScope = createHash('sha256')
    .update(
      JSON.stringify([
        tenantId,
        channel,
        channelUserId,
        jid,
        customerId,
        params.applicationId ?? '',
      ]),
    )
    .digest('hex');
  const now = deps.now ? deps.now() : Date.now();
  const merchantTransactionId = planMerchantTransactionId(
    params.plan,
    identityScope,
    params.purchaseId,
    params.merchantPrefix,
  );
  const existing = deps.store.findByMerchantTransactionId(
    merchantTransactionId,
  );
  if (existing) {
    if (
      existing.planCode !== params.plan.code ||
      existing.jid !== jid ||
      existing.channel !== channel ||
      existing.tenantId !== tenantId ||
      existing.channelUserId !== channelUserId
    ) {
      throw new Error(
        'Payment idempotency key conflicts with another purchase',
      );
    }
    if (!existing.resultUrl) {
      throw new Error('Existing payment attempt has no reusable checkout URL');
    }
    return {
      resultUrl: existing.resultUrl,
      orderId: existing.orderId,
      record: existing,
    };
  }
  const input = buildPlanPaymentInput(params.plan, {
    merchantTransactionId,
    // Do not disclose the channel's raw user identifier to an external
    // adapter. The scoped digest is stable for reconciliation but cannot be
    // read back as a Telegram/user id.
    customerId: identityScope,
    applicationId: params.applicationId,
    productName: params.productName,
    returnUrl: params.returnUrl,
  });
  const created = await withPaymentTimeout(
    deps.gateway.createPayment(input),
    deps.timeoutMs ?? DEFAULT_PAYMENT_OPERATION_TIMEOUT_MS,
  );
  if (!validOrderId(created.id)) {
    throw new Error('Payment provider returned an invalid order id');
  }
  const resultUrl = validatedCheckoutUrl(created.resultUrl);
  const conflicting = deps.store.getByOrder(created.id);
  if (conflicting) {
    throw new Error('Payment provider returned a duplicate order id');
  }
  const record: SubscriptionRecord = {
    orderId: created.id,
    merchantTransactionId,
    jid,
    channel,
    tenantId,
    channelUserId,
    planCode: params.plan.code,
    // Record exactly what the gateway was charged, so amount and currency stay
    // mutually consistent even when a non-default charge currency is selected
    // (input.amount = plan.prices[currency]; input.currency = the sent currency).
    amount: input.amount,
    currency: input.currency || params.plan.currency,
    periodDays: params.plan.periodDays,
    weeklyLimitCredits: params.plan.weeklyLimitCredits,
    quotaEnabled: params.plan.quotaEnabled,
    status: 'pending',
    resultUrl,
    createdAt: new Date(now).toISOString(),
  };
  deps.store.upsert(record);
  return { resultUrl, orderId: created.id, record };
}

export type ActivateFn = (record: SubscriptionRecord) => void | Promise<void>;

/** Called when an active subscription must lose its entitlement (expired or
 * reversed). The implementation re-applies the user's correct remaining quota
 * (best remaining active plan, or the default floor). */
export type DeactivateFn = (record: SubscriptionRecord) => void | Promise<void>;

/** Parse a major-unit money string into a number, or null when unusable. */
function parseMajorAmount(value: string | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function orderOwnershipMismatchReason(
  record: SubscriptionRecord,
  order: OrderInfo,
): string | null {
  if (order.id !== record.orderId) {
    return `order id mismatch: order=${order.id} record=${record.orderId}`;
  }
  if (order.merchantTransactionId) {
    return order.merchantTransactionId === record.merchantTransactionId
      ? null
      : `merchantTransactionId mismatch: order=${order.merchantTransactionId} record=${record.merchantTransactionId}`;
  }
  return order.bindingVerified === true
    ? null
    : 'merchantTransactionId missing and adapter did not verify binding';
}

/**
 * Defense-in-depth binding check: confirm a charged order actually belongs to
 * this subscription before granting entitlement. Returns a human-readable
 * reason when the order does NOT bind (so the caller refuses + logs), or null
 * when the binding is sound. A generic adapter must either return the exact
 * merchant transaction id or explicitly attest that it verified the binding.
 */
export function planOrderMismatchReason(
  record: SubscriptionRecord,
  order: OrderInfo,
): string | null {
  const ownershipMismatch = orderOwnershipMismatchReason(record, order);
  if (ownershipMismatch) return ownershipMismatch;

  if (!order.currency) {
    return 'paid order currency missing';
  }
  if (order.currency !== record.currency) {
    return `currency mismatch: order=${order.currency} record=${record.currency}`;
  }

  const captured = parseMajorAmount(order.amountCharged ?? order.amount);
  const expected = parseMajorAmount(record.amount);
  if (expected === null) {
    return `stored expected amount is invalid: ${record.amount}`;
  }
  if (captured === null) {
    return 'paid order captured amount missing or invalid';
  }
  if (captured + 1e-9 < expected) {
    return `captured amount ${captured} < expected ${expected}`;
  }
  return null;
}

/**
 * Detect that a previously-paid order no longer grants entitlement. Any refund
 * is treated conservatively as a reversal; deployments needing a different
 * policy can implement it outside this provider-neutral lifecycle.
 */
export function isReversedOrRefunded(order: OrderInfo): boolean {
  if (order.final && !order.paid) return true;
  const refunded = parseMajorAmount(order.amountRefunded);
  return refunded !== null && refunded > 0;
}

export type ConfirmPurchaseDeps = {
  gateway: { getOrder: (orderId: string) => Promise<OrderInfo> };
  store: SubscriptionStore;
  catalog: PlanCatalog;
  activate: ActivateFn;
  now?: () => number;
  timeoutMs?: number;
  /**
   * Called when a charged order fails to bind to its subscription
   * (merchantTransactionId / amount / currency mismatch). The subscription is
   * NOT activated; surface this for manual review.
   */
  onSuspicious?: (
    record: SubscriptionRecord,
    order: OrderInfo,
    reason: string,
  ) => void;
};

/**
 * Re-read an order (poll or webhook trigger) and reconcile the subscription.
 * Idempotent: an already-active subscription is returned without re-activating.
 */
export async function confirmPlanPurchase(
  deps: ConfirmPurchaseDeps,
  orderId: string,
): Promise<SubscriptionRecord> {
  const record = deps.store.getByOrder(orderId);
  if (!record) {
    throw new Error(`No subscription found for order ${orderId}`);
  }
  if (record.status !== 'pending') {
    // Terminal and operator-review states are never re-opened by a late
    // webhook or manual retry. In particular, an abandoned/expired checkout
    // must not grant entitlement after local expiry.
    return record;
  }
  const order = await withPaymentTimeout(
    deps.gateway.getOrder(orderId),
    deps.timeoutMs ?? DEFAULT_PAYMENT_OPERATION_TIMEOUT_MS,
  );
  const now = deps.now ? deps.now() : Date.now();
  record.lastCheckedAt = new Date(now).toISOString();
  record.lastOrderStatus = order.status;

  if (order.paid && order.final) {
    const mismatch = planOrderMismatchReason(record, order);
    if (mismatch) {
      // Charged, but the order does not bind to this subscription. Never grant
      // entitlement on a mismatched/under-captured order — keep it pending and
      // surface for manual review (re-checked idempotently on the next sweep).
      deps.onSuspicious?.(record, order, mismatch);
      record.status = 'review';
      deps.store.upsert(record);
      return record;
    }
    const legacyPlan = getPlan(record.planCode, deps.catalog);
    const periodDays = Number.isSafeInteger(record.periodDays)
      ? record.periodDays
      : legacyPlan?.periodDays;
    const weeklyLimitCredits = Number.isSafeInteger(record.weeklyLimitCredits)
      ? record.weeklyLimitCredits
      : legacyPlan?.weeklyLimitCredits;
    const quotaEnabled =
      typeof record.quotaEnabled === 'boolean'
        ? record.quotaEnabled
        : legacyPlan?.quotaEnabled;
    if (
      periodDays === undefined ||
      periodDays <= 0 ||
      weeklyLimitCredits === undefined ||
      weeklyLimitCredits < 0 ||
      quotaEnabled === undefined
    ) {
      // Never activate without the immutable entitlement captured before the
      // charge. A catalog lookup is accepted only for a legacy record.
      deps.onSuspicious?.(
        record,
        order,
        `unresolvable entitlement snapshot: ${record.planCode}`,
      );
      record.status = 'review';
      deps.store.upsert(record);
      return record;
    }
    record.periodDays = periodDays;
    record.weeklyLimitCredits = weeklyLimitCredits;
    record.quotaEnabled = quotaEnabled;
    const paidAt = new Date(now).toISOString();
    const expiresAt = new Date(
      now + periodDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    // Activate FIRST, then persist 'active'. activate() is idempotent, so a
    // transient quota-DB error leaves the record 'pending' (not active) and the
    // next pending sweep retries it — otherwise a thrown activate() would strand
    // the order active-but-unquotaed (charged, no quota, never re-checked).
    await deps.activate({ ...record, status: 'active', paidAt, expiresAt });
    record.status = 'active';
    record.paidAt = paidAt;
    record.expiresAt = expiresAt;
    deps.store.upsert(record);
  } else if (order.final) {
    record.status = 'failed';
    deps.store.upsert(record);
  } else {
    deps.store.upsert(record); // still pending
  }
  return record;
}

export type PollingSweepDeps = ConfirmPurchaseDeps & {
  /** Called when a subscription transitions to active (e.g. to notify the payer). */
  onActivated?: (record: SubscriptionRecord) => void | Promise<void>;
  onError?: (orderId: string, err: unknown) => void;
  /**
   * Optional deployment-owned checkout lifetime. There is deliberately no
   * generic default because provider links have different validity periods.
   */
  maxPendingAgeMs?: number;
};

/**
 * A gateway-wide outage (502/503/504, timeout, network failure) means every
 * remaining order in this sweep will fail the same way. Detect it so the caller
 * can stop hammering a down gateway and log ONE line instead of one WARN per
 * pending order — a provider blip used to flood hundreds of identical WARNs.
 */
export function isGatewayDown(err: unknown): boolean {
  const e = err as { classification?: string; httpStatus?: number } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.classification === 'timeout' || e.classification === 'network_error') {
    return true;
  }
  return (
    e.classification === 'http_error' &&
    (e.httpStatus === 502 || e.httpStatus === 503 || e.httpStatus === 504)
  );
}

/**
 * One pass over all pending subscriptions: re-check each order and reconcile.
 * Designed to be called on an interval. Errors on a single order never abort
 * the sweep. Abandoned checkouts (pending past maxPendingAgeMs) are expired
 * locally without a gateway call. Returns counters for logging.
 */
export async function runPaymentPollingSweep(deps: PollingSweepDeps): Promise<{
  checked: number;
  activated: number;
  failed: number;
  abandoned: number;
  /** Set when the gateway looked down and the sweep aborted early to back off. */
  gatewayDownError?: unknown;
}> {
  const pending = deps.store.listPending();
  const now = deps.now ? deps.now() : Date.now();
  const maxAge = deps.maxPendingAgeMs;
  let activated = 0;
  let failed = 0;
  let abandoned = 0;
  for (const rec of pending) {
    const createdMs = Date.parse(rec.createdAt);
    if (
      maxAge !== undefined &&
      Number.isFinite(maxAge) &&
      maxAge > 0 &&
      Number.isFinite(createdMs) &&
      now - createdMs > maxAge
    ) {
      // Abandoned checkout: expire locally, never call the gateway again.
      rec.status = 'expired';
      rec.lastCheckedAt = new Date(now).toISOString();
      deps.store.upsert(rec);
      abandoned += 1;
      continue;
    }
    try {
      const updated = await confirmPlanPurchase(deps, rec.orderId);
      if (updated.status === 'active') {
        activated += 1;
        await deps.onActivated?.(updated);
      } else if (updated.status === 'failed') {
        failed += 1;
      }
    } catch (err) {
      // Gateway-wide outage: stop the sweep so we don't fire one WARN per
      // remaining order; the caller logs a single backoff line and we retry
      // next interval. Per-order (non-gateway) errors keep the old behaviour.
      if (isGatewayDown(err)) {
        return {
          checked: pending.length,
          activated,
          failed,
          abandoned,
          gatewayDownError: err,
        };
      }
      deps.onError?.(rec.orderId, err);
    }
  }
  return { checked: pending.length, activated, failed, abandoned };
}

export type ReconcileActiveDeps = {
  gateway?: { getOrder: (orderId: string) => Promise<OrderInfo> };
  store: SubscriptionStore;
  /**
   * Re-apply the user's correct entitlement after a subscription leaves
   * 'active'. The current order remains in the store until this succeeds; a
   * deactivator must exclude record.orderId when choosing remaining plans.
   */
  deactivate: DeactivateFn;
  now?: () => number;
  timeoutMs?: number;
  /** Notified after a subscription is deactivated (e.g. to message the payer). */
  onDeactivated?: (
    record: SubscriptionRecord,
    reason: 'expired' | 'reversed',
  ) => void | Promise<void>;
  onError?: (orderId: string, err: unknown) => void;
};

/**
 * One pass over all ACTIVE subscriptions to enforce two post-activation
 * transitions the pending sweep never sees:
 *   - expiry  (H4): expiresAt <= now  -> mark 'expired'  + deactivate
 *   - reversal(H3): order refunded/reversed/chargeback -> mark 'failed' + deactivate
 * Local expiry runs before any provider call and also runs when no provider is
 * configured. Status is persisted only after deactivation succeeds, so a
 * transient quota-store failure is retried on the next pass.
 */
export async function reconcileActiveSubscriptions(
  deps: ReconcileActiveDeps,
): Promise<{
  checked: number;
  expired: number;
  reversed: number;
  /** Set when the gateway looked down and the pass aborted early to back off. */
  gatewayDownError?: unknown;
}> {
  const active = deps.store.listActive();
  const now = deps.now ? deps.now() : Date.now();
  let expired = 0;
  let reversed = 0;
  const stillActive: SubscriptionRecord[] = [];

  // First pass is local-only. A hung or disabled provider can never prevent an
  // expired entitlement from being retried.
  for (const rec of active) {
    const expiresAt = rec.expiresAt ? Date.parse(rec.expiresAt) : Number.NaN;
    if (Number.isFinite(expiresAt) && expiresAt > now) {
      stillActive.push(rec);
      continue;
    }
    try {
      const transitioned: SubscriptionRecord = {
        ...rec,
        status: 'expired',
        lastCheckedAt: new Date(now).toISOString(),
      };
      await deps.deactivate(transitioned);
      deps.store.upsert(transitioned);
      expired += 1;
      await deps.onDeactivated?.(transitioned, 'expired');
    } catch (err) {
      deps.onError?.(rec.orderId, err);
    }
  }

  if (!deps.gateway) {
    return { checked: active.length, expired, reversed };
  }

  for (const rec of stillActive) {
    try {
      const order = await withPaymentTimeout(
        deps.gateway.getOrder(rec.orderId),
        deps.timeoutMs ?? DEFAULT_PAYMENT_OPERATION_TIMEOUT_MS,
      );
      rec.lastCheckedAt = new Date(now).toISOString();
      rec.lastOrderStatus = order.status;
      const ownershipMismatch = orderOwnershipMismatchReason(rec, order);
      if (ownershipMismatch) {
        deps.onError?.(
          rec.orderId,
          new Error(
            `Active order binding could not be verified: ${ownershipMismatch}`,
          ),
        );
        deps.store.upsert(rec);
        continue;
      }
      if (isReversedOrRefunded(order)) {
        const transitioned: SubscriptionRecord = {
          ...rec,
          status: 'failed',
        };
        await deps.deactivate(transitioned);
        deps.store.upsert(transitioned);
        reversed += 1;
        await deps.onDeactivated?.(transitioned, 'reversed');
      } else {
        deps.store.upsert(rec); // refresh lastCheckedAt / lastOrderStatus
      }
    } catch (err) {
      // Gateway-wide outage: abort the pass and back off (see polling sweep).
      if (isGatewayDown(err)) {
        return {
          checked: active.length,
          expired,
          reversed,
          gatewayDownError: err,
        };
      }
      deps.onError?.(rec.orderId, err);
    }
  }
  return { checked: active.length, expired, reversed };
}
