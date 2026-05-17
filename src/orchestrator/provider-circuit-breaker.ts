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
};

export type ProviderCircuitSuccessResult = {
  provider: ProviderRuntime;
  state: ProviderCircuitState;
  previousState: ProviderCircuitState;
  closed: boolean;
  failureCount: number;
};

export const DEFAULT_PROVIDER_CIRCUIT_CONFIG: ProviderCircuitConfig = {
  failuresToOpen: 3,
  cooldownMs: 120_000,
};

let providerCircuitDb: Database.Database | undefined;

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
  return { failuresToOpen, cooldownMs };
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
      last_failure_at INTEGER,
      last_success_at INTEGER,
      last_reason TEXT,
      updated_at INTEGER NOT NULL
    );
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
         opened_at, open_until, half_opened_at, last_failure_at,
         last_success_at, last_reason, updated_at)
      VALUES (?, 'closed', 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)
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
}): ProviderCircuitDecision {
  const now = input.now ?? Date.now();
  const config = normalizeConfig(input.config);
  const snapshot = ensureCircuitState(input.provider, now, config);

  if (snapshot.state === 'open') {
    if (snapshot.open_until !== null && now >= snapshot.open_until) {
      const previousState = snapshot.state;
      const halfOpen: ProviderCircuitSnapshot = {
        ...snapshot,
        state: 'half_open',
        failures_to_open: config.failuresToOpen,
        cooldown_ms: config.cooldownMs,
        half_opened_at: now,
        updated_at: now,
      };
      persistSnapshot(halfOpen);
      return {
        provider: input.provider,
        state: 'half_open',
        action: 'allow',
        transition: 'half_open',
        previousState,
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
      snapshot.half_opened_at !== null &&
      now - snapshot.half_opened_at >= config.cooldownMs
    ) {
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
      openUntil: snapshot.open_until,
    };
  }

  return {
    provider: input.provider,
    state: 'closed',
    action: 'allow',
  };
}

export function recordProviderCircuitFailure(input: {
  provider: ProviderRuntime;
  reason: ProviderFailoverReason;
  now?: number;
  config?: Partial<ProviderCircuitConfig>;
}): ProviderCircuitFailureResult {
  const now = input.now ?? Date.now();
  const config = normalizeConfig(input.config);
  const snapshot = ensureCircuitState(input.provider, now, config);
  const previousState = snapshot.state;
  const nextFailureCount =
    previousState === 'half_open'
      ? Math.max(snapshot.failure_count + 1, config.failuresToOpen)
      : snapshot.failure_count + 1;
  const shouldOpen =
    previousState === 'half_open' ||
    previousState === 'open' ||
    nextFailureCount >= config.failuresToOpen;

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
      last_failure_at: now,
      last_reason: input.reason,
      updated_at: now,
    });
    return {
      provider: input.provider,
      state: 'open',
      previousState,
      opened: previousState !== 'open',
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
}): ProviderCircuitSuccessResult {
  const now = input.now ?? Date.now();
  const config = normalizeConfig(input.config);
  const snapshot = ensureCircuitState(input.provider, now, config);
  const previousState = snapshot.state;
  persistSnapshot({
    ...snapshot,
    state: 'closed',
    failure_count: 0,
    failures_to_open: config.failuresToOpen,
    cooldown_ms: config.cooldownMs,
    opened_at: null,
    open_until: null,
    half_opened_at: null,
    last_success_at: now,
    last_reason: null,
    updated_at: now,
  });
  return {
    provider: input.provider,
    state: 'closed',
    previousState,
    closed: previousState === 'open' || previousState === 'half_open',
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
    last_failure_at: null,
    last_success_at: null,
    last_reason: null,
    updated_at: now,
  };
  persistSnapshot(snapshot);
  return snapshot;
}
