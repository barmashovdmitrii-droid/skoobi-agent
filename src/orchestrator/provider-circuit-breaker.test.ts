import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import {
  eventSessionIdForTenant,
  getEventsForTenant,
  recordTenantEvent,
} from './event-store.js';
import {
  createProviderCircuitSchema,
  getProviderCircuitDecision,
  getProviderCircuitSnapshot,
  recordProviderCircuitFailure,
  recordProviderCircuitSuccess,
  renewProviderCircuitProbeLease,
  resetProviderCircuit,
  type ProviderCircuitConfig,
} from './provider-circuit-breaker.js';
import {
  chargeQuotaUsage,
  loadBillingConfig,
  quotaIdempotencyKey,
} from './quota.js';
import type { TenantRecord } from './tenant-registry.js';

const provider = 'codex_subscription_cli';
const config: ProviderCircuitConfig = {
  failuresToOpen: 3,
  cooldownMs: 1_000,
  // Small probe window so the half-open watchdog test exercises the mechanism at
  // the same 1s scale as cooldownMs.
  halfOpenProbeWindowMs: 1_000,
  probeTimeoutMarginMs: 0,
};
const billingEnabledConfig = loadBillingConfig({ enabled: true });

function tenant(): TenantRecord {
  return {
    tenant_id: 'tg_chat_circuit',
    folder: 'telegram_circuit',
    channel: 'telegram',
    chat_id: '12345',
    mode: 'guest',
    runtime: 'skoobi_live',
    approved_senders: [],
    models: {},
    quota: { enabled: true },
    legacy_jid: 'tg:12345',
    source: 'tenant_json',
    group: {
      name: 'Circuit guest',
      folder: 'telegram_circuit',
      trigger: '@Skoobi',
      added_at: '2026-05-17T00:00:00.000Z',
    },
  };
}

beforeEach(() => {
  _initTestDatabase();
  resetProviderCircuit(provider, { now: 0, config });
});

describe('provider circuit breaker', () => {
  it('migrates and immediately reclaims a legacy unowned half-open probe', () => {
    const database = getDb();
    database.exec(`
      DROP TABLE provider_circuit_state;
      CREATE TABLE provider_circuit_state (
        provider TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 0,
        failures_to_open INTEGER NOT NULL DEFAULT 3,
        cooldown_ms INTEGER NOT NULL DEFAULT 120000,
        opened_at INTEGER,
        open_until INTEGER,
        half_opened_at INTEGER,
        last_failure_at INTEGER,
        last_success_at INTEGER,
        last_reason TEXT,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO provider_circuit_state
        (provider, state, failure_count, failures_to_open, cooldown_ms,
         opened_at, open_until, half_opened_at, last_failure_at,
         last_success_at, last_reason, updated_at)
      VALUES
        ('codex_subscription_cli', 'half_open', 3, 3, 1000,
         0, 1000, 100, 0, NULL, 'timeout', 100);
    `);

    createProviderCircuitSchema(database);
    const columns = (
      database.prepare(`PRAGMA table_info(provider_circuit_state)`).all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    expect(columns).toContain('half_open_expires_at');
    expect(columns).toContain('half_open_probe_token');

    // A pre-upgrade process cannot still own work after restart. Its token is
    // null, so this boot takes a fresh half-open lease immediately.
    const reclaimed = getProviderCircuitDecision({
      provider,
      now: 101,
      config,
      processEpoch: 'migration-test-epoch',
    });
    expect(reclaimed).toMatchObject({
      state: 'half_open',
      action: 'allow',
      transition: 'half_open',
      previousState: 'half_open',
      probeExpiresAt: 1_101,
    });
    expect(reclaimed.probeToken).toEqual(expect.any(String));
    expect(
      getProviderCircuitDecision({
        provider,
        now: 102,
        config,
        processEpoch: 'migration-test-epoch',
      }),
    ).toMatchObject({
      state: 'half_open',
      action: 'skip',
      probeExpiresAt: 1_101,
    });
  });

  it('opens the Codex circuit after three failures', () => {
    expect(
      recordProviderCircuitFailure({
        provider,
        reason: 'timeout',
        now: 100,
        config,
      }),
    ).toMatchObject({
      state: 'closed',
      opened: false,
      failureCount: 1,
    });
    expect(
      recordProviderCircuitFailure({
        provider,
        reason: 'rate_limit',
        now: 200,
        config,
      }),
    ).toMatchObject({
      state: 'closed',
      opened: false,
      failureCount: 2,
    });
    const opened = recordProviderCircuitFailure({
      provider,
      reason: 'runtime_error',
      now: 300,
      config,
    });

    expect(opened).toMatchObject({
      state: 'open',
      previousState: 'closed',
      opened: true,
      failureCount: 3,
      failuresToOpen: 3,
      openUntil: 1_300,
    });
    expect(
      getProviderCircuitSnapshot(provider, { now: 301, config }),
    ).toMatchObject({
      state: 'open',
      failure_count: 3,
      open_until: 1_300,
      last_reason: 'runtime_error',
    });
  });

  it('skips Codex and calls Claude immediately when the circuit is open', () => {
    for (const now of [100, 200, 300]) {
      recordProviderCircuitFailure({
        provider,
        reason: 'timeout',
        now,
        config,
      });
    }

    const decision = getProviderCircuitDecision({
      provider,
      now: 400,
      config,
    });
    let codexCalls = 0;
    let claudeCalls = 0;
    let telegramAnswers = 0;

    if (decision.action === 'allow') {
      codexCalls += 1;
    } else {
      claudeCalls += 1;
      telegramAnswers += 1;
    }

    expect(decision).toMatchObject({
      action: 'skip',
      reason: 'circuit_open',
      openUntil: 1_300,
    });
    expect(codexCalls).toBe(0);
    expect(claudeCalls).toBe(1);
    expect(telegramAnswers).toBe(1);
  });

  it('enters half-open after cooldown and closes on a successful probe', () => {
    const t = tenant();
    for (const now of [100, 200, 300]) {
      recordProviderCircuitFailure({
        provider,
        reason: 'timeout',
        now,
        config,
      });
    }

    const decision = getProviderCircuitDecision({
      provider,
      now: 1_301,
      config,
    });
    expect(decision).toMatchObject({
      action: 'allow',
      transition: 'half_open',
      previousState: 'open',
      state: 'half_open',
    });
    recordTenantEvent({
      tenant: t,
      type: 'provider_circuit_half_open',
      actor: 'system',
      payload: { provider, previous_state: 'open' },
      createdAt: 1_301,
    });

    const closed = recordProviderCircuitSuccess({
      provider,
      now: 1_350,
      config,
      probeToken: decision.probeToken,
    });
    expect(closed).toMatchObject({
      state: 'closed',
      previousState: 'half_open',
      closed: true,
      failureCount: 0,
    });
    recordTenantEvent({
      tenant: t,
      type: 'provider_circuit_closed',
      actor: 'system',
      payload: { provider, previous_state: 'half_open' },
      createdAt: 1_350,
    });

    expect(
      getProviderCircuitSnapshot(provider, { now: 1_351, config }),
    ).toMatchObject({
      state: 'closed',
      failure_count: 0,
      open_until: null,
    });
    expect(getEventsForTenant(t.tenant_id).map((event) => event.type)).toEqual([
      'session_started',
      'provider_circuit_half_open',
      'provider_circuit_closed',
    ]);
  });

  it('reopens when the half-open probe fails', () => {
    for (const now of [100, 200, 300]) {
      recordProviderCircuitFailure({
        provider,
        reason: 'timeout',
        now,
        config,
      });
    }
    const decision = getProviderCircuitDecision({
      provider,
      now: 1_301,
      config,
    });
    expect(decision).toMatchObject({ action: 'allow', state: 'half_open' });

    const reopened = recordProviderCircuitFailure({
      provider,
      reason: 'rate_limit',
      now: 1_320,
      config,
      probeToken: decision.probeToken,
    });

    expect(reopened).toMatchObject({
      state: 'open',
      previousState: 'half_open',
      opened: true,
      reason: 'rate_limit',
      openUntil: 2_320,
    });
    expect(
      getProviderCircuitSnapshot(provider, { now: 1_321, config }),
    ).toMatchObject({
      state: 'open',
      half_opened_at: null,
      last_reason: 'rate_limit',
    });
  });

  it('reopens stale half-open probes instead of skipping Codex forever', () => {
    for (const now of [100, 200, 300]) {
      recordProviderCircuitFailure({
        provider,
        reason: 'timeout',
        now,
        config,
      });
    }
    expect(
      getProviderCircuitDecision({ provider, now: 1_301, config }),
    ).toMatchObject({ action: 'allow', state: 'half_open' });

    const stale = getProviderCircuitDecision({
      provider,
      now: 2_302,
      config,
    });

    expect(stale).toMatchObject({
      action: 'skip',
      state: 'open',
      reason: 'circuit_open',
      transition: 'open',
      previousState: 'half_open',
      openUntil: 3_302,
    });
    expect(
      getProviderCircuitSnapshot(provider, { now: 2_303, config }),
    ).toMatchObject({
      state: 'open',
      half_opened_at: null,
      last_reason: 'timeout',
      open_until: 3_302,
    });
  });

  it('immediately replaces a persisted probe owned by an older process epoch', () => {
    const leaseConfig: ProviderCircuitConfig = {
      failuresToOpen: 1,
      cooldownMs: 1_000,
      halfOpenProbeWindowMs: 1_000,
      probeTimeoutMarginMs: 100,
    };
    recordProviderCircuitFailure({
      provider,
      reason: 'timeout',
      now: 100,
      config: leaseConfig,
    });
    const epochA = getProviderCircuitDecision({
      provider,
      now: 1_100,
      config: leaseConfig,
      probeTimeoutMs: 2_000,
      processEpoch: 'boot-epoch-a',
    });
    expect(epochA).toMatchObject({
      action: 'allow',
      state: 'half_open',
      probeExpiresAt: 3_200,
    });

    // Simulate an orchestrator restart while A's durable lease is still young.
    const epochB = getProviderCircuitDecision({
      provider,
      now: 1_200,
      config: leaseConfig,
      probeTimeoutMs: 2_000,
      processEpoch: 'boot-epoch-b',
    });
    expect(epochB).toMatchObject({
      action: 'allow',
      state: 'half_open',
      transition: 'half_open',
      previousState: 'half_open',
      probeExpiresAt: 3_300,
    });
    expect(epochB.probeToken).not.toBe(epochA.probeToken);

    expect(
      recordProviderCircuitSuccess({
        provider,
        now: 1_300,
        config: leaseConfig,
        probeToken: epochA.probeToken,
      }),
    ).toMatchObject({
      state: 'half_open',
      closed: false,
      ignored: true,
    });
    expect(
      renewProviderCircuitProbeLease({
        provider,
        now: 1_301,
        config: leaseConfig,
        probeTimeoutMs: 9_000,
        probeToken: epochA.probeToken!,
      }),
    ).toMatchObject({
      state: 'half_open',
      renewed: false,
      ignored: true,
      probeExpiresAt: 3_300,
    });
    expect(
      recordProviderCircuitSuccess({
        provider,
        now: 1_302,
        config: leaseConfig,
        probeToken: epochB.probeToken,
      }),
    ).toMatchObject({ state: 'closed', closed: true });
  });

  it('keeps a legitimate 900s full-agent probe alive through its effective timeout', () => {
    const longProbeConfig: ProviderCircuitConfig = {
      failuresToOpen: 1,
      cooldownMs: 1_000,
      halfOpenProbeWindowMs: 360_000,
      probeTimeoutMarginMs: 60_000,
    };
    recordProviderCircuitFailure({
      provider,
      reason: 'timeout',
      now: 100,
      config: longProbeConfig,
    });

    const decision = getProviderCircuitDecision({
      provider,
      now: 1_101,
      config: longProbeConfig,
      probeTimeoutMs: 900_000,
    });
    expect(decision).toMatchObject({
      action: 'allow',
      state: 'half_open',
      transition: 'half_open',
      probeExpiresAt: 961_101,
    });
    expect(decision.probeToken).toEqual(expect.any(String));

    // The old 360s watchdog would already have re-opened here. The concrete
    // 900s run still owns the lease and all sibling attempts remain skipped.
    expect(
      getProviderCircuitDecision({
        provider,
        now: 901_101,
        config: longProbeConfig,
        probeTimeoutMs: 90_000,
      }),
    ).toMatchObject({
      action: 'skip',
      state: 'half_open',
      probeExpiresAt: 961_101,
    });

    expect(
      recordProviderCircuitSuccess({
        provider,
        now: 901_102,
        config: longProbeConfig,
        probeToken: decision.probeToken,
      }),
    ).toMatchObject({
      state: 'closed',
      previousState: 'half_open',
      closed: true,
    });
  });

  it('renews only the matching live probe token and keeps its deadline monotonic', () => {
    const leaseConfig: ProviderCircuitConfig = {
      failuresToOpen: 1,
      cooldownMs: 1_000,
      halfOpenProbeWindowMs: 1_000,
      probeTimeoutMarginMs: 100,
    };
    recordProviderCircuitFailure({
      provider,
      reason: 'timeout',
      now: 100,
      config: leaseConfig,
    });
    const decision = getProviderCircuitDecision({
      provider,
      now: 1_100,
      config: leaseConfig,
      probeTimeoutMs: 2_000,
    });
    expect(decision.probeExpiresAt).toBe(3_200);

    expect(
      renewProviderCircuitProbeLease({
        provider,
        probeToken: decision.probeToken!,
        now: 2_000,
        config: leaseConfig,
        probeTimeoutMs: 2_000,
      }),
    ).toMatchObject({
      state: 'half_open',
      renewed: true,
      previousExpiresAt: 3_200,
      probeExpiresAt: 4_100,
    });

    expect(
      renewProviderCircuitProbeLease({
        provider,
        probeToken: 'stale-probe-token',
        now: 2_100,
        config: leaseConfig,
        probeTimeoutMs: 9_000,
      }),
    ).toMatchObject({
      state: 'half_open',
      renewed: false,
      ignored: true,
      probeExpiresAt: 4_100,
    });

    // A shorter subsequent heartbeat can never pull the durable deadline back.
    expect(
      renewProviderCircuitProbeLease({
        provider,
        probeToken: decision.probeToken!,
        now: 2_101,
        config: leaseConfig,
        probeTimeoutMs: 100,
      }),
    ).toMatchObject({
      renewed: true,
      previousExpiresAt: 4_100,
      probeExpiresAt: 4_100,
    });

    // Expired leases are never resurrected, even by their formerly-correct
    // token. The normal cooldown starts and the token is consumed.
    expect(
      renewProviderCircuitProbeLease({
        provider,
        probeToken: decision.probeToken!,
        now: 4_100,
        config: leaseConfig,
        probeTimeoutMs: 2_000,
      }),
    ).toMatchObject({
      state: 'open',
      renewed: false,
      expired: true,
      probeExpiresAt: null,
      openUntil: 5_100,
    });
    expect(
      getProviderCircuitSnapshot(provider, { now: 4_101, config: leaseConfig }),
    ).toMatchObject({
      state: 'open',
      half_open_expires_at: null,
      half_open_probe_token: null,
    });
  });

  it('accepts a matching success after the original deadline when heartbeats renewed it', () => {
    const leaseConfig: ProviderCircuitConfig = {
      failuresToOpen: 1,
      cooldownMs: 1_000,
      halfOpenProbeWindowMs: 1_000,
      probeTimeoutMarginMs: 100,
    };
    recordProviderCircuitFailure({
      provider,
      reason: 'timeout',
      now: 100,
      config: leaseConfig,
    });
    const decision = getProviderCircuitDecision({
      provider,
      now: 1_100,
      config: leaseConfig,
      probeTimeoutMs: 2_000,
    });
    renewProviderCircuitProbeLease({
      provider,
      probeToken: decision.probeToken!,
      now: 2_000,
      config: leaseConfig,
      probeTimeoutMs: 2_000,
    });

    // Original expiry was 3_200; renewal moved it to 4_100.
    expect(
      recordProviderCircuitSuccess({
        provider,
        probeToken: decision.probeToken,
        now: 3_500,
        config: leaseConfig,
      }),
    ).toMatchObject({
      state: 'closed',
      previousState: 'half_open',
      closed: true,
    });
  });

  it('expires a hung long probe and rejects its stale result after a new lease starts', () => {
    const leaseConfig: ProviderCircuitConfig = {
      failuresToOpen: 1,
      cooldownMs: 1_000,
      halfOpenProbeWindowMs: 1_000,
      probeTimeoutMarginMs: 100,
    };
    recordProviderCircuitFailure({
      provider,
      reason: 'timeout',
      now: 100,
      config: leaseConfig,
    });
    const first = getProviderCircuitDecision({
      provider,
      now: 1_101,
      config: leaseConfig,
      probeTimeoutMs: 2_000,
    });
    expect(first.probeExpiresAt).toBe(3_201);

    expect(
      getProviderCircuitDecision({
        provider,
        now: 3_201,
        config: leaseConfig,
      }),
    ).toMatchObject({
      action: 'skip',
      state: 'open',
      transition: 'open',
      openUntil: 4_201,
    });
    const second = getProviderCircuitDecision({
      provider,
      now: 4_201,
      config: leaseConfig,
      probeTimeoutMs: 2_000,
    });
    expect(second).toMatchObject({
      action: 'allow',
      state: 'half_open',
      transition: 'half_open',
    });
    expect(second.probeToken).not.toBe(first.probeToken);

    const stale = recordProviderCircuitSuccess({
      provider,
      now: 4_300,
      config: leaseConfig,
      probeToken: first.probeToken,
    });
    expect(stale).toMatchObject({
      state: 'half_open',
      closed: false,
      ignored: true,
    });
    expect(
      getProviderCircuitSnapshot(provider, {
        now: 4_301,
        config: leaseConfig,
      }),
    ).toMatchObject({
      state: 'half_open',
      half_open_probe_token: second.probeToken,
    });

    const staleFailure = recordProviderCircuitFailure({
      provider,
      reason: 'runtime_error',
      now: 4_301,
      config: leaseConfig,
      probeToken: first.probeToken,
    });
    expect(staleFailure).toMatchObject({
      state: 'half_open',
      opened: false,
      ignored: true,
    });

    expect(
      recordProviderCircuitSuccess({
        provider,
        now: 4_302,
        config: leaseConfig,
        probeToken: second.probeToken,
      }),
    ).toMatchObject({ state: 'closed', closed: true });
  });

  it('does not accept a matching probe success that arrives after its lease', () => {
    const leaseConfig: ProviderCircuitConfig = {
      failuresToOpen: 1,
      cooldownMs: 1_000,
      halfOpenProbeWindowMs: 1_000,
      probeTimeoutMarginMs: 100,
    };
    recordProviderCircuitFailure({
      provider,
      reason: 'timeout',
      now: 100,
      config: leaseConfig,
    });
    const decision = getProviderCircuitDecision({
      provider,
      now: 1_100,
      config: leaseConfig,
      probeTimeoutMs: 2_000,
    });

    expect(
      recordProviderCircuitSuccess({
        provider,
        now: 3_200,
        config: leaseConfig,
        probeToken: decision.probeToken,
      }),
    ).toMatchObject({
      state: 'open',
      previousState: 'half_open',
      closed: false,
      expired: true,
      openUntil: 4_200,
    });
  });

  it('does not let a stale success clobber a just-opened breaker', () => {
    for (const now of [100, 200, 300]) {
      recordProviderCircuitFailure({
        provider,
        reason: 'timeout',
        now,
        config,
      });
    }
    // Breaker is now open until 1_300 with three accumulated failures.
    expect(
      getProviderCircuitSnapshot(provider, { now: 301, config }),
    ).toMatchObject({
      state: 'open',
      failure_count: 3,
      open_until: 1_300,
    });

    // A success from a concurrent group's in-flight request lands while the
    // breaker is open. It must NOT reopen-to-closed.
    const stale = recordProviderCircuitSuccess({
      provider,
      now: 400,
      config,
    });
    expect(stale).toMatchObject({
      state: 'open',
      previousState: 'open',
      closed: false,
      failureCount: 3,
    });

    // The breaker stays open with its cooldown intact, so the next decision
    // still skips Codex instead of being stuck closed.
    expect(
      getProviderCircuitSnapshot(provider, { now: 401, config }),
    ).toMatchObject({
      state: 'open',
      failure_count: 3,
      open_until: 1_300,
    });
    expect(
      getProviderCircuitDecision({ provider, now: 500, config }),
    ).toMatchObject({
      action: 'skip',
      reason: 'circuit_open',
      openUntil: 1_300,
    });
  });

  it('does not slide the cooldown forward when a straggler failure lands on an already-open breaker', () => {
    for (const now of [100, 200, 300]) {
      recordProviderCircuitFailure({
        provider,
        reason: 'timeout',
        now,
        config,
      });
    }
    // Breaker is now open until 1_300 with three accumulated failures.
    expect(
      getProviderCircuitSnapshot(provider, { now: 301, config }),
    ).toMatchObject({
      state: 'open',
      failure_count: 3,
      open_until: 1_300,
    });

    // A straggler request that was issued while the breaker was still closed
    // now fails after a sibling already opened it. It must NOT push open_until
    // further into the future (which would extend the cooldown past
    // cooldownMs), must not be counted as a new opening, and must leave the
    // accumulated failure count untouched.
    const straggler = recordProviderCircuitFailure({
      provider,
      reason: 'rate_limit',
      now: 900,
      config,
    });
    expect(straggler).toMatchObject({
      state: 'open',
      previousState: 'open',
      opened: false,
      failureCount: 3,
      failuresToOpen: 3,
      // Original deadline preserved, NOT 900 + 1_000 = 1_900.
      openUntil: 1_300,
      reason: 'rate_limit',
    });

    // The persisted snapshot keeps the original opened_at/open_until; only the
    // last failure metadata is refreshed.
    expect(
      getProviderCircuitSnapshot(provider, { now: 901, config }),
    ).toMatchObject({
      state: 'open',
      failure_count: 3,
      opened_at: 300,
      open_until: 1_300,
      last_failure_at: 900,
      last_reason: 'rate_limit',
    });

    // A second straggler must likewise not slide the window forward.
    recordProviderCircuitFailure({
      provider,
      reason: 'runtime_error',
      now: 1_200,
      config,
    });
    expect(
      getProviderCircuitSnapshot(provider, { now: 1_201, config }),
    ).toMatchObject({
      state: 'open',
      open_until: 1_300,
    });

    // Because the deadline was never extended, the breaker transitions to
    // half_open right at the original cooldown boundary instead of staying
    // stuck open.
    expect(
      getProviderCircuitDecision({ provider, now: 1_301, config }),
    ).toMatchObject({
      action: 'allow',
      transition: 'half_open',
      previousState: 'open',
      state: 'half_open',
    });
  });

  it('closes a half-open breaker on a successful probe but reports closed only from half_open', () => {
    for (const now of [100, 200, 300]) {
      recordProviderCircuitFailure({
        provider,
        reason: 'timeout',
        now,
        config,
      });
    }
    // Cross the cooldown to transition open -> half_open.
    const decision = getProviderCircuitDecision({
      provider,
      now: 1_301,
      config,
    });
    expect(decision).toMatchObject({ action: 'allow', state: 'half_open' });

    const closed = recordProviderCircuitSuccess({
      provider,
      now: 1_350,
      config,
      probeToken: decision.probeToken,
    });
    expect(closed).toMatchObject({
      state: 'closed',
      previousState: 'half_open',
      closed: true,
      failureCount: 0,
    });

    // A subsequent success on an already-closed breaker just resets the
    // counter and reports closed: false (no transition happened).
    const steady = recordProviderCircuitSuccess({
      provider,
      now: 1_400,
      config,
    });
    expect(steady).toMatchObject({
      state: 'closed',
      previousState: 'closed',
      closed: false,
      failureCount: 0,
    });
    expect(
      getProviderCircuitSnapshot(provider, { now: 1_401, config }),
    ).toMatchObject({
      state: 'closed',
      failure_count: 0,
      open_until: null,
    });
  });

  it('records circuit-open event and avoids duplicate answers or double charges during fallback', () => {
    const t = tenant();
    const opened = recordProviderCircuitFailure({
      provider,
      reason: 'timeout',
      now: 100,
      config: { failuresToOpen: 1, cooldownMs: 1_000 },
    });
    expect(opened.opened).toBe(true);
    recordTenantEvent({
      tenant: t,
      type: 'provider_circuit_opened',
      actor: 'system',
      senderId: '42',
      payload: {
        provider,
        reason: opened.reason,
        open_until: opened.openUntil,
      },
      createdAt: 100,
    });

    const decision = getProviderCircuitDecision({
      provider,
      now: 200,
      config,
    });
    let codexCalls = 0;
    let claudeCalls = 0;
    let telegramAnswers = 0;
    if (decision.action === 'allow') {
      codexCalls += 1;
      telegramAnswers += 1;
    } else {
      claudeCalls += 1;
      telegramAnswers += 1;
    }

    const sessionId = eventSessionIdForTenant(t);
    const idempotencyKey = quotaIdempotencyKey({
      tenantId: t.tenant_id,
      sessionId,
      channel: t.channel,
      chatId: t.chat_id,
      channelUserId: '42',
      targetCursor: 'same-open-circuit-request',
    });
    const firstCharge = chargeQuotaUsage({
      tenantId: t.tenant_id,
      sessionId,
      channel: t.channel,
      chatId: t.chat_id,
      channelUserId: '42',
      modelRole: 'default',
      providerModel: 'claude-opus-4-7',
      inputTokens: 10,
      outputTokens: 5,
      providerCostUsd: null,
      idempotencyKey,
      runStatus: 'success',
      isShadow: false,
      config: billingEnabledConfig,
    });
    const duplicateCharge = chargeQuotaUsage({
      tenantId: t.tenant_id,
      sessionId,
      channel: t.channel,
      chatId: t.chat_id,
      channelUserId: '42',
      modelRole: 'default',
      providerModel: 'claude-opus-4-7',
      inputTokens: 10,
      outputTokens: 5,
      providerCostUsd: null,
      idempotencyKey,
      runStatus: 'success',
      isShadow: false,
      config: billingEnabledConfig,
    });

    expect(decision.action).toBe('skip');
    expect(codexCalls).toBe(0);
    expect(claudeCalls).toBe(1);
    expect(telegramAnswers).toBe(1);
    expect(firstCharge.charged).toBe(true);
    expect(duplicateCharge.duplicate).toBe(true);
    expect(
      (
        getDb().prepare(`SELECT COUNT(*) AS c FROM usage_ledger`).get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
    expect(
      getEventsForTenant(t.tenant_id).map((event) => event.type),
    ).toContain('provider_circuit_opened');
  });
});
