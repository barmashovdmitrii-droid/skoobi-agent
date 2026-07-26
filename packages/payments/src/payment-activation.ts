import { getPlan, planQuotaTarget, type PlanCatalog } from './payment-plans.js';
import type {
  ActivateFn,
  DeactivateFn,
  SubscriptionRecord,
  SubscriptionStore,
} from './payment-service.js';

// Billing port: the payments package never reads or writes quota storage. The
// host injects a narrow setter and, optionally, a current-entitlement reader.
export type SetPlanLimitInput = {
  tenantId: string;
  channel: string;
  channelUserId: string;
  weeklyLimitCredits: number;
  quotaEnabled?: boolean;
  now?: number;
};

export type CurrentEntitlement = {
  weeklyLimitCredits: number;
  quotaEnabled: boolean;
};

export type QuotaTarget = {
  tenantId: string;
  channel: string;
  channelUserId: string;
};

export type PlanActivationOptions = {
  catalog: PlanCatalog;
  /** Floor: never set a paid user below this default weekly limit. */
  defaultWeeklyLimitCredits?: number;
  setLimit: (input: SetPlanLimitInput) => unknown | Promise<unknown>;
  /**
   * Reads the account's current effective entitlement so activation cannot
   * downgrade a higher plan or an independent operator adjustment.
   */
  getCurrentEntitlement?: (
    target: QuotaTarget,
  ) => CurrentEntitlement | undefined;
  onApplied?: (info: {
    record: SubscriptionRecord;
    weeklyLimitCredits: number;
    quotaEnabled: boolean;
  }) => void;
};

function quotaTargetForRecord(
  record: SubscriptionRecord,
  catalog: PlanCatalog,
): { weeklyLimitCredits: number; quotaEnabled: boolean } | undefined {
  if (
    Number.isSafeInteger(record.weeklyLimitCredits) &&
    (record.weeklyLimitCredits ?? -1) >= 0 &&
    typeof record.quotaEnabled === 'boolean'
  ) {
    return {
      weeklyLimitCredits: record.weeklyLimitCredits as number,
      quotaEnabled: record.quotaEnabled,
    };
  }
  const legacyPlan = getPlan(record.planCode, catalog);
  return legacyPlan ? planQuotaTarget(legacyPlan) : undefined;
}

/**
 * List paid, finite plans that grant no more than the configured default floor.
 * This is diagnostic only; activation remains raise-only.
 */
export function paidPlansCollapsingToFloor(
  catalog: PlanCatalog,
  floor: number,
): Array<{ code: string; planTarget: number }> {
  const collapsing: Array<{ code: string; planTarget: number }> = [];
  for (const plan of Object.values(catalog)) {
    if (plan.free) continue;
    const target = planQuotaTarget(plan);
    if (!target.quotaEnabled) continue;
    if (target.weeklyLimitCredits <= floor) {
      collapsing.push({
        code: plan.code,
        planTarget: target.weeklyLimitCredits,
      });
    }
  }
  return collapsing;
}

export function buildPlanActivation(
  options: PlanActivationOptions,
): ActivateFn {
  const floor = Math.max(0, options.defaultWeeklyLimitCredits ?? 0);
  const collapsing = paidPlansCollapsingToFloor(options.catalog, floor);
  if (collapsing.length > 0) {
    console.warn(
      `[payment-activation] paid plan(s) do not exceed the default floor (${floor} credits): ${collapsing
        .map((item) => `${item.code}=${item.planTarget}`)
        .join(', ')}`,
    );
  }

  return async (record: SubscriptionRecord) => {
    if (!record.tenantId || !record.channelUserId || !record.channel) {
      throw new Error('Subscription identity is incomplete');
    }
    const target: QuotaTarget = {
      tenantId: record.tenantId,
      channel: record.channel,
      channelUserId: record.channelUserId,
    };
    const planTarget = quotaTargetForRecord(record, options.catalog);
    if (!planTarget) {
      throw new Error('Subscription entitlement snapshot is unavailable');
    }
    const current = options.getCurrentEntitlement?.(target);

    // Unlimited is the highest entitlement. A finite activation must never
    // replace an already-unlimited account.
    if (current?.quotaEnabled === false && planTarget.quotaEnabled) {
      options.onApplied?.({
        record,
        weeklyLimitCredits: current.weeklyLimitCredits,
        quotaEnabled: false,
      });
      return;
    }

    let weeklyLimitCredits: number;
    let quotaEnabled: boolean;
    if (!planTarget.quotaEnabled) {
      weeklyLimitCredits = 0;
      quotaEnabled = false;
    } else {
      weeklyLimitCredits = Math.max(
        planTarget.weeklyLimitCredits,
        floor,
        current?.quotaEnabled ? current.weeklyLimitCredits : 0,
      );
      quotaEnabled = true;
    }

    await options.setLimit({
      ...target,
      weeklyLimitCredits,
      quotaEnabled,
    });
    options.onApplied?.({ record, weeklyLimitCredits, quotaEnabled });
  };
}

export type PlanDeactivationOptions = {
  store: SubscriptionStore;
  catalog: PlanCatalog;
  defaultWeeklyLimitCredits?: number;
  setLimit: (input: SetPlanLimitInput) => unknown | Promise<unknown>;
  /**
   * Reads the current effective entitlement. A value strictly stronger than
   * the entitlement being removed is independent of this subscription and
   * must survive its expiry or reversal.
   */
  getCurrentEntitlement?: (
    target: QuotaTarget,
  ) => CurrentEntitlement | undefined;
  now?: () => number;
  onApplied?: (info: {
    record: SubscriptionRecord;
    weeklyLimitCredits: number;
    quotaEnabled: boolean;
  }) => void;
};

/**
 * Select the strongest remaining entitlement for the same tenant identity.
 * A more recently purchased lower tier must not hide an older higher tier.
 */
function bestRemainingEntitlement(
  store: Pick<SubscriptionStore, 'listActive'>,
  catalog: PlanCatalog,
  jid: string,
  tenantId: string,
  channel: string,
  channelUserId: string,
  excludeOrderId: string | undefined,
  now: number,
): { weeklyLimitCredits: number; quotaEnabled: boolean } | undefined {
  let best: { weeklyLimitCredits: number; quotaEnabled: boolean } | undefined;
  for (const record of store.listActive()) {
    if (record.jid !== jid) continue;
    if (record.tenantId !== tenantId) continue;
    if (record.channel !== channel) continue;
    if (record.channelUserId !== channelUserId) continue;
    if (excludeOrderId !== undefined && record.orderId === excludeOrderId) {
      continue;
    }
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= now) {
      continue;
    }
    const target = quotaTargetForRecord(record, catalog);
    if (!target) continue;
    if (!best) {
      best = target;
      continue;
    }
    if (!best.quotaEnabled) continue;
    if (!target.quotaEnabled) {
      best = target;
      continue;
    }
    if (target.weeklyLimitCredits > best.weeklyLimitCredits) {
      best = target;
    }
  }
  return best;
}

function isStrictlyStrongerEntitlement(
  candidate: CurrentEntitlement,
  baseline: CurrentEntitlement,
): boolean {
  if (!candidate.quotaEnabled) return baseline.quotaEnabled;
  if (!baseline.quotaEnabled) return false;
  return candidate.weeklyLimitCredits > baseline.weeklyLimitCredits;
}

/**
 * Re-apply the strongest remaining plan after expiry or reversal. The ending
 * record may still be active in the store while this runs, so it is excluded by
 * order id. A provably independent stronger current entitlement is preserved.
 */
export function buildPlanDeactivation(
  options: PlanDeactivationOptions,
): DeactivateFn {
  const floor = Math.max(0, options.defaultWeeklyLimitCredits ?? 0);

  return async (record: SubscriptionRecord) => {
    if (!record.tenantId || !record.channelUserId || !record.channel) {
      throw new Error('Subscription identity is incomplete');
    }
    const removed = quotaTargetForRecord(record, options.catalog);
    const target: QuotaTarget = {
      tenantId: record.tenantId,
      channel: record.channel,
      channelUserId: record.channelUserId,
    };
    const now = options.now ? options.now() : Date.now();
    const remaining = bestRemainingEntitlement(
      options.store,
      options.catalog,
      record.jid,
      record.tenantId,
      record.channel,
      record.channelUserId,
      record.orderId,
      now,
    );
    const current = options.getCurrentEntitlement?.(target);
    const preserveCurrent =
      removed !== undefined &&
      current !== undefined &&
      isStrictlyStrongerEntitlement(current, removed);

    let quotaEnabled = remaining?.quotaEnabled ?? true;
    let weeklyLimitCredits = remaining
      ? remaining.quotaEnabled
        ? Math.max(remaining.weeklyLimitCredits, floor)
        : 0
      : floor;

    if (preserveCurrent && current.quotaEnabled === false) {
      options.onApplied?.({
        record,
        weeklyLimitCredits: current.weeklyLimitCredits,
        quotaEnabled: false,
      });
      return;
    }
    if (preserveCurrent && quotaEnabled) {
      weeklyLimitCredits = Math.max(
        weeklyLimitCredits,
        current.weeklyLimitCredits,
      );
      quotaEnabled = true;
    }

    await options.setLimit({
      ...target,
      weeklyLimitCredits,
      quotaEnabled,
    });
    options.onApplied?.({ record, weeklyLimitCredits, quotaEnabled });
  };
}
