import { randomUUID } from 'crypto';

import type Database from 'better-sqlite3';

import type {
  ProviderFailoverReason,
  ProviderRuntime,
} from './provider-failover.js';

export type ProviderCircuitState = 'closed' | 'open' | 'half_open';
export type ProviderCircuitAction = 'allow' | 'skip';

export type ProviderCircuitConfig = {
  failuresToOpen: number;
  cooldownMs: number;
  // How long a half-open probe may run before the watchdog re-opens the breaker.
  // Must exceed the max probe duration or a slow-but-successful recovery probe is
  // preempted and its success discarded (ultra-review 2026-07-11 #19).
  halfOpenProbeWindowMs: number;
  // Extra time for process teardown/result delivery after the provider's own
  // timeout. The granted lease is max(halfOpenProbeWindowMs,
  // probeTimeoutMs + probeTimeoutMarginMs).
  probeTimeoutMarginMs: number;
};

export type ProviderCircuitSnapshot = {
  provider: ProviderRuntime;
  state: ProviderCircuitState;
  failure_count: number;
  failures_to_open: number;
  cooldown_ms: number;
  opened_at: number | null;
  open_until: number | null;
  half_opened_at: number | null;
  half_open_expires_at: number | null;
  half_open_probe_token: string | null;
  last_failure_at: number | null;
  last_success_at: number | null;
  last_reason: string | null;
  updated_at: number;
};

export type ProviderCircuitDecision = {
  provider: ProviderRuntime;
  state: ProviderCircuitState;
  action: ProviderCircuitAction;
  reason?: ProviderFailoverReason;
  openUntil?: number | null;
  transition?: 'half_open' | 'open';
  previousState?: ProviderCircuitState;
  // Present only on the one decision that owns the half-open probe. Callers
  // must return it to recordProviderCircuitSuccess/Failure; stale in-flight
  // requests then cannot complete a newer probe.
  probeToken?: string;
  probeExpiresAt?: number;
};

export type ProviderCircuitFailureResult = {
  provider: ProviderRuntime;
  state: ProviderCircuitState;
  previousState: ProviderCircuitState;
  opened: boolean;
  failureCount: number;
  failuresToOpen: number;
  openUntil: number | null;
  reason: ProviderFailoverReason;
  ignored?: boolean;
};

export type ProviderCircuitSuccessResult = {
  provider: ProviderRuntime;
  state: ProviderCircuitState;
  previousState: ProviderCircuitState;
  closed: boolean;
  failureCount: number;
  ignored?: boolean;
  expired?: boolean;
  openUntil?: number | null;
};

export type ProviderCircuitLeaseRenewalResult = {
  provider: ProviderRuntime;
  state: ProviderCircuitState;
  renewed: boolean;
  previousExpiresAt: number | null;
  probeExpiresAt: number | null;
  ignored?: boolean;
  expired?: boolean;
  openUntil?: number | null;
};

export const DEFAULT_PROVIDER_CIRCUIT_CONFIG: ProviderCircuitConfig = {
  failuresToOpen: 3,
  cooldownMs: 120_000,
  // Fast floor for ordinary text probes. Longer paths (notably the 900s Codex
  // full agent) pass their effective timeout when acquiring the lease.
  halfOpenProbeWindowMs: 360_000,
  probeTimeoutMarginMs: 60_000,
};

let providerCircuitDb: Database.Database | undefined;
// The runtime is intentionally single-orchestrator. A random boot epoch lets a
// replacement process distinguish its own live probe from a durable half-open
// row whose child died with the previous process.
const providerCircuitProcessEpoch = randomUUID();

function processEpochKey(processEpoch?: string): string {
  return Buffer.from(processEpoch || providerCircuitProcessEpoch).toString(
    'base64url',
  );
}

function createProbeToken(processEpoch?: string): string {
  return `${processEpochKey(processEpoch)}:${randomUUID()}`;
}

function probeBelongsToProcess(
  probeToken: string | null,
  processEpoch?: string,
): boolean {
  return Boolean(
    probeToken && probeToken.startsWith(`${processEpochKey(processEpoch)}:`),
  );
}

function normalizeConfig(
  config: Partial<ProviderCircuitConfig> = {},
): ProviderCircuitConfig {
  const failuresToOpen = Math.max(
    1,
    Math.trunc(
      config.failuresToOpen ?? DEFAULT_PROVIDER_CIRCUIT_CONFIG.failuresToOpen,
    ),
  );
  const cooldownMs = Math.max(
    1,
    Math.trunc(config.cooldownMs ?? DEFAULT_PROVIDER_CIRCUIT_CONFIG.cooldownMs),
  );
  // The fast-path floor is never smaller than cooldownMs. The concrete
  // provider timeout can raise this further when a probe lease is acquired.
  const halfOpenProbeWindowMs = Math.max(
    cooldownMs,
    Math.trunc(
      config.halfOpenProbeWindowMs ??
        DEFAULT_PROVIDER_CIRCUIT_CONFIG.halfOpenProbeWindowMs,
    ),
  );
  const probeTimeoutMarginMs = Math.max(
    0,
    Math.trunc(
      config.probeTimeoutMarginMs ??
        DEFAULT_PROVIDER_CIRCUIT_CONFIG.probeTimeoutMarginMs,
    ),
  );
  return {
    failuresToOpen,
    cooldownMs,
    halfOpenProbeWindowMs,
    probeTimeoutMarginMs,
  };
}

function safeDeadline(now: number, durationMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, now + Math.max(1, durationMs));
}

function resolveProbeLeaseWindowMs(
  config: ProviderCircuitConfig,
  probeTimeoutMs?: number,
): number {
  const effectiveProbeTimeoutMs =
    Number.isFinite(probeTimeoutMs) && Number(probeTimeoutMs) > 0
      ? Math.trunc(Number(probeTimeoutMs))
      : 0;
  return Math.max(
    config.halfOpenProbeWindowMs,
    effectiveProbeTimeoutMs + config.probeTimeoutMarginMs,
  );
}

export function createProviderCircuitSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS provider_circuit_state (
      provider TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      failure_count INTEGER NOT NULL DEFAULT 0,
      failures_to_open INTEGER NOT NULL DEFAULT 3,
      cooldown_ms INTEGER NOT NULL DEFAULT 120000,
      opened_at INTEGER,
      open_until INTEGER,
      half_opened_at INTEGER,
      half_open_expires_at INTEGER,
      half_open_probe_token TEXT,
      last_failure_at INTEGER,
      last_success_at INTEGER,
      last_reason TEXT,
      updated_at INTEGER NOT NULL
    );
  `);

  // Existing installations already have this table. CREATE TABLE IF NOT
  // EXISTS does not add columns, so migrate the durable probe lease in place.
  const columns = new Set(
    (
      database.prepare(`PRAGMA table_info(provider_circuit_state)`).all() as {
        name: string;
      }[]
    ).map((column) => column.name),
  );
  if (!columns.has('half_open_expires_at')) {
    database.exec(
      `ALTER TABLE provider_circuit_state ADD COLUMN half_open_expires_at INTEGER`,
    );
  }
  if (!columns.has('half_open_probe_token')) {
    database.exec(
      `ALTER TABLE provider_circuit_state ADD COLUMN half_open_probe_token TEXT`,
    );
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_provider_circuit_state_state
      ON provider_circuit_state(state, open_until);
  `);
  providerCircuitDb = database;
}

function db(): Database.Database {
  if (!providerCircuitDb) {
    throw new Error('Provider circuit database is not initialized');
  }
  return providerCircuitDb;
}

function rowToSnapshot(row: any): ProviderCircuitSnapshot {
  return {
    provider: row.provider,
    state: row.state,
    failure_count: Number(row.failure_count ?? 0),
    failures_to_open: Number(row.failures_to_open ?? 3),
    cooldown_ms: Number(row.cooldown_ms ?? 120_000),
    opened_at: row.opened_at ?? null,
    open_until: row.open_until ?? null,
    half_opened_at: row.half_opened_at ?? null,
    half_open_expires_at: row.half_open_expires_at ?? null,
    half_open_probe_token: row.half_open_probe_token ?? null,
    last_failure_at: row.last_failure_at ?? null,
    last_success_at: row.last_success_at ?? null,
    last_reason: row.last_reason ?? null,
    updated_at: Number(row.updated_at ?? 0),
  };
}

function ensureCircuitState(
  provider: ProviderRuntime,
  now: number,
  config: Partial<ProviderCircuitConfig> = {},
): ProviderCircuitSnapshot {
  const normalized = normalizeConfig(config);
  const database = db();
  database
    .prepare(
      `
      INSERT OR IGNORE INTO provider_circuit_state
        (provider, state, failure_count, failures_to_open, cooldown_ms,
         opened_at, open_until, half_opened_at, half_open_expires_at,
         half_open_probe_token, last_failure_at, last_success_at, last_reason,
         updated_at)
      VALUES (?, 'closed', 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)
    `,
    )
    .run(provider, normalized.failuresToOpen, normalized.cooldownMs, now);
  const row = database
    .prepare(`SELECT * FROM provider_circuit_state WHERE provider = ?`)
    .get(provider);
  return rowToSnapshot(row);
}

function persistSnapshot(snapshot: ProviderCircuitSnapshot): void {
  db()
    .prepare(
      `
      UPDATE provider_circuit_state
      SET state = ?,
          failure_count = ?,
          failures_to_open = ?,
          cooldown_ms = ?,
          opened_at = ?,
          open_until = ?,
          half_opened_at = ?,
          half_open_expires_at = ?,
          half_open_probe_token = ?,
          last_failure_at = ?,
          last_success_at = ?,
          last_reason = ?,
          updated_at = ?
      WHERE provider = ?
    `,
    )
    .run(
      snapshot.state,
      snapshot.failure_count,
      snapshot.failures_to_open,
      snapshot.cooldown_ms,
      snapshot.opened_at,
      snapshot.open_until,
      snapshot.half_opened_at,
      snapshot.half_open_expires_at,
      snapshot.half_open_probe_token,
      snapshot.last_failure_at,
      snapshot.last_success_at,
      snapshot.last_reason,
      snapshot.updated_at,
      snapshot.provider,
    );
}

export function getProviderCircuitSnapshot(
  provider: ProviderRuntime,
  options: {
    now?: number;
    config?: Partial<ProviderCircuitConfig>;
  } = {},
): ProviderCircuitSnapshot {
  return ensureCircuitState(
    provider,
    options.now ?? Date.now(),
    options.config,
  );
}

export function getProviderCircuitDecision(input: {
  provider: ProviderRuntime;
  now?: number;
  config?: Partial<ProviderCircuitConfig>;
  /** Maximum runtime of the concrete provider attempt that will own a probe. */
  probeTimeoutMs?: number;
  /** Test hook; production uses a random module/process boot epoch. */
  processEpoch?: string;
}): ProviderCircuitDecision {
  const now = input.now ?? Date.now();
  const config = normalizeConfig(input.config);
  const snapshot = ensureCircuitState(input.provider, now, config);

  if (snapshot.state === 'open') {
    if (snapshot.open_until !== null && now >= snapshot.open_until) {
      const previousState = snapshot.state;
      const probeToken = createProbeToken(input.processEpoch);
      const probeExpiresAt = safeDeadline(
        now,
        resolveProbeLeaseWindowMs(config, input.probeTimeoutMs),
      );
      const halfOpen: ProviderCircuitSnapshot = {
        ...snapshot,
        state: 'half_open',
        failures_to_open: config.failuresToOpen,
        cooldown_ms: config.cooldownMs,
        half_opened_at: now,
        half_open_expires_at: probeExpiresAt,
        half_open_probe_token: probeToken,
        updated_at: now,
      };
      persistSnapshot(halfOpen);
      return {
        provider: input.provider,
        state: 'half_open',
        action: 'allow',
        transition: 'half_open',
        previousState,
        probeToken,
        probeExpiresAt,
      };
    }
    return {
      provider: input.provider,
      state: 'open',
      action: 'skip',
      reason: 'circuit_open',
      openUntil: snapshot.open_until,
    };
  }

  if (snapshot.state === 'half_open') {
    if (
      !probeBelongsToProcess(snapshot.half_open_probe_token, input.processEpoch)
    ) {
      // A half-open row from another boot cannot have a live child in this
      // single-orchestrator process. Atomically take ownership immediately
      // instead of skipping until the old (possibly 16-minute) lease expires.
      const probeToken = createProbeToken(input.processEpoch);
      const probeExpiresAt = safeDeadline(
        now,
        resolveProbeLeaseWindowMs(config, input.probeTimeoutMs),
      );
      persistSnapshot({
        ...snapshot,
        state: 'half_open',
        failures_to_open: config.failuresToOpen,
        cooldown_ms: config.cooldownMs,
        half_opened_at: now,
        half_open_expires_at: probeExpiresAt,
        half_open_probe_token: probeToken,
        updated_at: now,
      });
      return {
        provider: input.provider,
        state: 'half_open',
        action: 'allow',
        transition: 'half_open',
        previousState: 'half_open',
        probeToken,
        probeExpiresAt,
      };
    }

    // Defensive fallback for a malformed owned row missing its deadline.
    const probeExpiresAt =
      snapshot.half_open_expires_at ??
      (snapshot.half_opened_at === null
        ? now
        : safeDeadline(snapshot.half_opened_at, config.halfOpenProbeWindowMs));
    if (now >= probeExpiresAt) {
      const previousState = snapshot.state;
      const openUntil = now + config.cooldownMs;
      persistSnapshot({
        ...snapshot,
        state: 'open',
        failures_to_open: config.failuresToOpen,
        cooldown_ms: config.cooldownMs,
        opened_at: now,
        open_until: openUntil,
        half_opened_at: null,
        half_open_expires_at: null,
        half_open_probe_token: null,
        last_failure_at: now,
        last_reason: 'timeout',
        updated_at: now,
      });
      return {
        provider: input.provider,
        state: 'open',
        action: 'skip',
        reason: 'circuit_open',
        openUntil,
        transition: 'open',
        previousState,
      };
    }
    return {
      provider: input.provider,
      state: 'half_open',
      action: 'skip',
      reason: 'circuit_open',
      openUntil: null,
      probeExpiresAt,
    };
  }

  return {
    provider: input.provider,
    state: 'closed',
    action: 'allow',
  };
}

/**
 * Extend only the currently-owned half-open probe. The persisted deadline is
 * monotonic and a stale/missing token is a no-op, so a heartbeat from an old
 * request cannot keep a newer probe alive. Once the deadline has passed it is
 * never renewable: the breaker is re-opened for the normal cooldown instead.
 */
export function renewProviderCircuitProbeLease(input: {
  provider: ProviderRuntime;
  probeToken: string;
  now?: number;
  config?: Partial<ProviderCircuitConfig>;
  /** Runtime bound for one currently-active provider attempt. */
  probeTimeoutMs?: number;
}): ProviderCircuitLeaseRenewalResult {
  const now = input.now ?? Date.now();
  const config = normalizeConfig(input.config);
  const snapshot = ensureCircuitState(input.provider, now, config);
  const previousExpiresAt = snapshot.half_open_expires_at;
  if (
    snapshot.state !== 'half_open' ||
    !input.probeToken ||
    !snapshot.half_open_probe_token ||
    input.probeToken !== snapshot.half_open_probe_token
  ) {
    return {
      provider: input.provider,
      state: snapshot.state,
      renewed: false,
      previousExpiresAt,
      probeExpiresAt: previousExpiresAt,
      ignored: true,
      openUntil: snapshot.open_until,
    };
  }

  if (previousExpiresAt === null || now >= previousExpiresAt) {
    const openUntil = safeDeadline(now, config.cooldownMs);
    persistSnapshot({
      ...snapshot,
      state: 'open',
      failures_to_open: config.failuresToOpen,
      cooldown_ms: config.cooldownMs,
      opened_at: now,
      open_until: openUntil,
      half_opened_at: null,
      half_open_expires_at: null,
      half_open_probe_token: null,
      last_failure_at: now,
      last_reason: 'timeout',
      updated_at: now,
    });
    return {
      provider: input.provider,
      state: 'open',
      renewed: false,
      previousExpiresAt,
      probeExpiresAt: null,
      expired: true,
      openUntil,
    };
  }

  const probeExpiresAt = Math.max(
    previousExpiresAt,
    safeDeadline(now, resolveProbeLeaseWindowMs(config, input.probeTimeoutMs)),
  );
  persistSnapshot({
    ...snapshot,
    failures_to_open: config.failuresToOpen,
    cooldown_ms: config.cooldownMs,
    half_open_expires_at: probeExpiresAt,
    updated_at: now,
  });
  return {
    provider: input.provider,
    state: 'half_open',
    renewed: true,
    previousExpiresAt,
    probeExpiresAt,
  };
}

export function recordProviderCircuitFailure(input: {
  provider: ProviderRuntime;
  reason: ProviderFailoverReason;
  now?: number;
  config?: Partial<ProviderCircuitConfig>;
  probeToken?: string;
}): ProviderCircuitFailureResult {
  const now = input.now ?? Date.now();
  const config = normalizeConfig(input.config);
  const snapshot = ensureCircuitState(input.provider, now, config);
  const previousState = snapshot.state;

  if (input.probeToken && previousState !== 'half_open') {
    return {
      provider: input.provider,
      state: previousState,
      previousState,
      opened: false,
      failureCount: snapshot.failure_count,
      failuresToOpen: snapshot.failures_to_open,
      openUntil: snapshot.open_until,
      reason: input.reason,
      ignored: true,
    };
  }

  if (previousState === 'half_open') {
    const tokenMatches = Boolean(
      input.probeToken &&
      snapshot.half_open_probe_token &&
      input.probeToken === snapshot.half_open_probe_token,
    );
    if (!tokenMatches) {
      return {
        provider: input.provider,
        state: 'half_open',
        previousState,
        opened: false,
        failureCount: snapshot.failure_count,
        failuresToOpen: snapshot.failures_to_open,
        openUntil: null,
        reason: input.reason,
        ignored: true,
      };
    }
  }

  // The circuit is global per ProviderRuntime and shared across concurrent
  // groups, so an in-flight failure may land after another path has already
  // opened the breaker (e.g. a straggler request issued while the breaker was
  // still closed that fails after a sibling opened it). If the breaker is
  // already open, this failure is already accounted for by the original open
  // transition: do NOT rewrite opened_at/open_until, or each straggler would
  // slide the cooldown deadline forward and hold the breaker open past the
  // configured cooldownMs. Record only last_failure_at/last_reason and leave
  // the original deadline intact. Mirrors the open-gate on the success path.
  if (previousState === 'open') {
    persistSnapshot({
      ...snapshot,
      last_failure_at: now,
      last_reason: input.reason,
      updated_at: now,
    });
    return {
      provider: input.provider,
      state: 'open',
      previousState,
      opened: false,
      failureCount: snapshot.failure_count,
      failuresToOpen: snapshot.failures_to_open,
      openUntil: snapshot.open_until,
      reason: input.reason,
    };
  }

  const nextFailureCount =
    previousState === 'half_open'
      ? Math.max(snapshot.failure_count + 1, config.failuresToOpen)
      : snapshot.failure_count + 1;
  const shouldOpen =
    previousState === 'half_open' || nextFailureCount >= config.failuresToOpen;

  if (shouldOpen) {
    const openUntil = now + config.cooldownMs;
    persistSnapshot({
      ...snapshot,
      state: 'open',
      failure_count: nextFailureCount,
      failures_to_open: config.failuresToOpen,
      cooldown_ms: config.cooldownMs,
      opened_at: now,
      open_until: openUntil,
      half_opened_at: null,
      half_open_expires_at: null,
      half_open_probe_token: null,
      last_failure_at: now,
      last_reason: input.reason,
      updated_at: now,
    });
    return {
      provider: input.provider,
      state: 'open',
      previousState,
      opened: true,
      failureCount: nextFailureCount,
      failuresToOpen: config.failuresToOpen,
      openUntil,
      reason: input.reason,
    };
  }

  persistSnapshot({
    ...snapshot,
    state: 'closed',
    failure_count: nextFailureCount,
    failures_to_open: config.failuresToOpen,
    cooldown_ms: config.cooldownMs,
    last_failure_at: now,
    last_reason: input.reason,
    updated_at: now,
  });
  return {
    provider: input.provider,
    state: 'closed',
    previousState,
    opened: false,
    failureCount: nextFailureCount,
    failuresToOpen: config.failuresToOpen,
    openUntil: null,
    reason: input.reason,
  };
}

export function recordProviderCircuitSuccess(input: {
  provider: ProviderRuntime;
  now?: number;
  config?: Partial<ProviderCircuitConfig>;
  probeToken?: string;
}): ProviderCircuitSuccessResult {
  const now = input.now ?? Date.now();
  const config = normalizeConfig(input.config);
  const snapshot = ensureCircuitState(input.provider, now, config);
  const previousState = snapshot.state;

  if (input.probeToken && previousState !== 'half_open') {
    return {
      provider: input.provider,
      state: previousState,
      previousState,
      closed: false,
      failureCount: snapshot.failure_count,
      ignored: true,
      openUntil: snapshot.open_until,
    };
  }

  if (previousState === 'half_open') {
    const tokenMatches = Boolean(
      input.probeToken &&
      snapshot.half_open_probe_token &&
      input.probeToken === snapshot.half_open_probe_token,
    );
    if (!tokenMatches) {
      return {
        provider: input.provider,
        state: 'half_open',
        previousState,
        closed: false,
        failureCount: snapshot.failure_count,
        ignored: true,
        openUntil: null,
      };
    }

    const probeExpiresAt = snapshot.half_open_expires_at;
    if (probeExpiresAt === null || now >= probeExpiresAt) {
      const openUntil = safeDeadline(now, config.cooldownMs);
      persistSnapshot({
        ...snapshot,
        state: 'open',
        failures_to_open: config.failuresToOpen,
        cooldown_ms: config.cooldownMs,
        opened_at: now,
        open_until: openUntil,
        half_opened_at: null,
        half_open_expires_at: null,
        half_open_probe_token: null,
        last_failure_at: now,
        last_reason: 'timeout',
        updated_at: now,
      });
      return {
        provider: input.provider,
        state: 'open',
        previousState,
        closed: false,
        failureCount: snapshot.failure_count,
        expired: true,
        openUntil,
      };
    }
  }

  // The circuit is global per ProviderRuntime and shared across concurrent
  // groups, so an in-flight success may land after another path has opened the
  // breaker. If the breaker is currently open, this success is stale (it cannot
  // have been a half-open probe — those run in the half_open state) and must
  // NOT reopen-to-closed; leave the open breaker untouched.
  if (previousState === 'open') {
    return {
      provider: input.provider,
      state: 'open',
      previousState,
      closed: false,
      failureCount: snapshot.failure_count,
    };
  }

  // half_open + success closes the breaker fully; closed + success just resets
  // the accumulated failure counter (the breaker is already closed).
  persistSnapshot({
    ...snapshot,
    state: 'closed',
    failure_count: 0,
    failures_to_open: config.failuresToOpen,
    cooldown_ms: config.cooldownMs,
    opened_at: null,
    open_until: null,
    half_opened_at: null,
    half_open_expires_at: null,
    half_open_probe_token: null,
    last_success_at: now,
    last_reason: null,
    updated_at: now,
  });
  return {
    provider: input.provider,
    state: 'closed',
    previousState,
    closed: previousState === 'half_open',
    failureCount: 0,
  };
}

export function resetProviderCircuit(
  provider: ProviderRuntime,
  options: {
    now?: number;
    config?: Partial<ProviderCircuitConfig>;
  } = {},
): ProviderCircuitSnapshot {
  const now = options.now ?? Date.now();
  const config = normalizeConfig(options.config);
  ensureCircuitState(provider, now, config);
  const snapshot: ProviderCircuitSnapshot = {
    provider,
    state: 'closed',
    failure_count: 0,
    failures_to_open: config.failuresToOpen,
    cooldown_ms: config.cooldownMs,
    opened_at: null,
    open_until: null,
    half_opened_at: null,
    half_open_expires_at: null,
    half_open_probe_token: null,
    last_failure_at: null,
    last_success_at: null,
    last_reason: null,
    updated_at: now,
  };
  persistSnapshot(snapshot);
  return snapshot;
}
