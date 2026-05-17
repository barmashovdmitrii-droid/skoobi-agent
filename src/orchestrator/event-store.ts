import { createHash, randomUUID } from 'crypto';

import type Database from 'better-sqlite3';

import type { TenantRecord } from './tenant-registry.js';

export type EventType =
  | 'telegram_inbound_message'
  | 'telegram_inbound_callback_query'
  | 'telegram_outbound_message'
  | 'session_started'
  | 'session_finished'
  | 'runtime_selected'
  | 'model_gateway_shadow_trace'
  | 'model_gateway_live_response'
  | 'codex_model_unavailable'
  | 'codex_model_downgraded'
  | 'codex_circuit_open'
  | 'provider_failover_attempt'
  | 'provider_failover_used'
  | 'provider_failover_exhausted'
  | 'provider_circuit_opened'
  | 'provider_circuit_half_open'
  | 'provider_circuit_closed'
  | 'tool_call_requested'
  | 'tool_policy_allowed'
  | 'tool_policy_denied'
  | 'tool_call_executed'
  | 'tool_call_failed'
  | 'quota_account_created'
  | 'quota_checked'
  | 'quota_blocked'
  | 'quota_charged'
  | 'quota_charge_skipped_shadow'
  | 'quota_charge_skipped_failed_model'
  | 'quota_balance_viewed'
  | 'quota_adjusted'
  | 'memory_delete_requested'
  | 'memory_deleted'
  | 'memory_delete_unavailable'
  | 'error';

export interface EventRecord {
  event_id: string;
  tenant_id: string;
  session_id: string;
  seq: number;
  type: string;
  actor: string;
  channel: string;
  chat_id: string;
  sender_id: string | null;
  payload_json: string;
  created_at: number;
}

export interface RecordTenantEventInput {
  tenant: TenantRecord;
  type: EventType;
  actor: string;
  payload: Record<string, unknown>;
  senderId?: string | null;
  sessionId?: string;
  createdAt?: number;
}

export interface RecordUsageEventInput {
  tenant: TenantRecord;
  channelUserId?: string | null;
  modelRole?: string | null;
  providerModel?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  sessionId?: string;
  createdAt?: number;
}

export interface RecordToolCallInput {
  tenant: TenantRecord;
  eventId?: string | null;
  toolCallId: string;
  toolName: string;
  status: 'requested' | 'allowed' | 'denied' | 'completed' | 'error';
  argsHash?: string | null;
  payload: Record<string, unknown>;
  senderId?: string | null;
  sessionId?: string;
  createdAt?: number;
}

export interface RecordModelTraceInput {
  tenant: TenantRecord;
  senderId?: string | null;
  sessionId?: string;
  runMode: 'shadow' | 'live' | 'test';
  modelRole: string;
  providerModel?: string | null;
  status: 'success' | 'error';
  legacyAnswerLength?: number | null;
  skoobiAnswerLength?: number | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  toolCallsRequested?: number | null;
  toolCallsAllowed?: number | null;
  toolCallsDenied?: number | null;
  finalAnswerHash?: string | null;
  payload: Record<string, unknown>;
  createdAt?: number;
}

let eventStoreDb: Database.Database | undefined;

const APPEND_ONLY_TABLES = [
  'tenants',
  'event_sessions',
  'events',
  'usage_events',
  'tool_calls',
  'model_traces',
];

const SECRET_KEY_RE =
  /(token|secret|password|api[_-]?key|authorization|cookie|credential)/i;
const MAX_EVENT_STRING_LENGTH = 8000;

function appendOnlyTriggers(table: string): string {
  return `
    CREATE TRIGGER IF NOT EXISTS ${table}_append_only_no_update
    BEFORE UPDATE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${table} is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS ${table}_append_only_no_delete
    BEFORE DELETE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${table} is append-only');
    END;
  `;
}

export function createEventStoreSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      tenant_id TEXT PRIMARY KEY,
      folder TEXT NOT NULL,
      mode TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tenants_channel_chat
      ON tenants(channel, chat_id);

    CREATE TABLE IF NOT EXISTS event_sessions (
      session_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
    );
    CREATE INDEX IF NOT EXISTS idx_event_sessions_tenant
      ON event_sessions(tenant_id, started_at);

    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(tenant_id, session_id, seq),
      FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
      FOREIGN KEY (session_id) REFERENCES event_sessions(session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_tenant_created
      ON events(tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_type_created
      ON events(type, created_at);

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      channel_user_id TEXT,
      model_role TEXT,
      provider_model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
      FOREIGN KEY (session_id) REFERENCES event_sessions(session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_created
      ON usage_events(tenant_id, created_at);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      event_id TEXT,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      args_hash TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
      FOREIGN KEY (session_id) REFERENCES event_sessions(session_id),
      FOREIGN KEY (event_id) REFERENCES events(event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_calls_tenant_created
      ON tool_calls(tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_call_id
      ON tool_calls(tool_call_id);

    CREATE TABLE IF NOT EXISTS model_traces (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT,
      run_mode TEXT NOT NULL,
      model_role TEXT NOT NULL,
      provider_model TEXT,
      status TEXT NOT NULL,
      legacy_answer_length INTEGER,
      skoobi_answer_length INTEGER,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      tool_calls_requested INTEGER,
      tool_calls_allowed INTEGER,
      tool_calls_denied INTEGER,
      final_answer_hash TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
      FOREIGN KEY (session_id) REFERENCES event_sessions(session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_model_traces_tenant_created
      ON model_traces(tenant_id, created_at);
  `);

  for (const table of APPEND_ONLY_TABLES) {
    database.exec(appendOnlyTriggers(table));
  }

  eventStoreDb = database;
}

function db(): Database.Database {
  if (!eventStoreDb) {
    throw new Error('Event store database is not initialized');
  }
  return eventStoreDb;
}

export function eventSessionIdForTenant(tenant: TenantRecord): string {
  const digest = createHash('sha256')
    .update(`${tenant.tenant_id}|${tenant.channel}|${tenant.chat_id}`)
    .digest('hex')
    .slice(0, 24);
  return `evt_${digest}`;
}

function redactString(value: string): string {
  let redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, 'xox-[REDACTED]')
    .replace(
      /\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)\s*=\s*[^\s]+/gi,
      '$1=[REDACTED]',
    );

  if (redacted.length > MAX_EVENT_STRING_LENGTH) {
    redacted = `${redacted.slice(0, MAX_EVENT_STRING_LENGTH)}...[truncated]`;
  }
  return redacted;
}

export function redactEventPayload(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.map((item) => redactEventPayload(item));

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SECRET_KEY_RE.test(key)
      ? '[REDACTED]'
      : redactEventPayload(item);
  }
  return result;
}

function ensureTenant(
  database: Database.Database,
  tenant: TenantRecord,
  createdAt: number,
): void {
  database
    .prepare(
      `
      INSERT OR IGNORE INTO tenants
        (tenant_id, folder, mode, channel, chat_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      tenant.tenant_id,
      tenant.folder,
      tenant.mode,
      tenant.channel,
      tenant.chat_id,
      createdAt,
    );
}

function ensureSession(
  database: Database.Database,
  tenant: TenantRecord,
  sessionId: string,
  createdAt: number,
): boolean {
  const result = database
    .prepare(
      `
      INSERT OR IGNORE INTO event_sessions
        (session_id, tenant_id, channel, chat_id, status, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `,
    )
    .run(
      sessionId,
      tenant.tenant_id,
      tenant.channel,
      tenant.chat_id,
      'active',
      createdAt,
    );
  return result.changes > 0;
}

function nextSeq(
  database: Database.Database,
  tenantId: string,
  sessionId: string,
): number {
  const row = database
    .prepare(
      `
      SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
      FROM events
      WHERE tenant_id = ? AND session_id = ?
    `,
    )
    .get(tenantId, sessionId) as { next_seq: number };
  return row.next_seq;
}

function insertEvent(
  database: Database.Database,
  input: RecordTenantEventInput,
  sessionId: string,
  createdAt: number,
): EventRecord {
  const event: EventRecord = {
    event_id: randomUUID(),
    tenant_id: input.tenant.tenant_id,
    session_id: sessionId,
    seq: nextSeq(database, input.tenant.tenant_id, sessionId),
    type: input.type,
    actor: input.actor,
    channel: input.tenant.channel,
    chat_id: input.tenant.chat_id,
    sender_id: input.senderId || null,
    payload_json: JSON.stringify(redactEventPayload(input.payload)),
    created_at: createdAt,
  };

  database
    .prepare(
      `
      INSERT INTO events
        (event_id, tenant_id, session_id, seq, type, actor, channel, chat_id,
         sender_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      event.event_id,
      event.tenant_id,
      event.session_id,
      event.seq,
      event.type,
      event.actor,
      event.channel,
      event.chat_id,
      event.sender_id,
      event.payload_json,
      event.created_at,
    );

  return event;
}

export function recordTenantEvent(input: RecordTenantEventInput): EventRecord {
  const database = db();
  return database.transaction((eventInput: RecordTenantEventInput) => {
    const createdAt = eventInput.createdAt ?? Date.now();
    const sessionId =
      eventInput.sessionId || eventSessionIdForTenant(eventInput.tenant);
    ensureTenant(database, eventInput.tenant, createdAt);
    const sessionCreated = ensureSession(
      database,
      eventInput.tenant,
      sessionId,
      createdAt,
    );
    if (sessionCreated && eventInput.type !== 'session_started') {
      insertEvent(
        database,
        {
          tenant: eventInput.tenant,
          type: 'session_started',
          actor: 'system',
          senderId: null,
          sessionId,
          createdAt,
          payload: {
            tenant_id: eventInput.tenant.tenant_id,
            channel: eventInput.tenant.channel,
            chat_id: eventInput.tenant.chat_id,
          },
        },
        sessionId,
        createdAt,
      );
    }
    return insertEvent(database, eventInput, sessionId, createdAt);
  })(input);
}

export function recordUsageEvent(input: RecordUsageEventInput): string {
  const database = db();
  return database.transaction((usageInput: RecordUsageEventInput) => {
    const createdAt = usageInput.createdAt ?? Date.now();
    const sessionId =
      usageInput.sessionId || eventSessionIdForTenant(usageInput.tenant);
    ensureTenant(database, usageInput.tenant, createdAt);
    const sessionCreated = ensureSession(
      database,
      usageInput.tenant,
      sessionId,
      createdAt,
    );
    if (sessionCreated) {
      insertEvent(
        database,
        {
          tenant: usageInput.tenant,
          type: 'session_started',
          actor: 'system',
          senderId: null,
          sessionId,
          createdAt,
          payload: {
            tenant_id: usageInput.tenant.tenant_id,
            channel: usageInput.tenant.channel,
            chat_id: usageInput.tenant.chat_id,
          },
        },
        sessionId,
        createdAt,
      );
    }

    const id = randomUUID();
    database
      .prepare(
        `
        INSERT INTO usage_events
          (id, tenant_id, session_id, channel, chat_id, channel_user_id,
           model_role, provider_model, input_tokens, output_tokens, cost_usd,
           created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        usageInput.tenant.tenant_id,
        sessionId,
        usageInput.tenant.channel,
        usageInput.tenant.chat_id,
        usageInput.channelUserId || null,
        usageInput.modelRole || null,
        usageInput.providerModel || null,
        usageInput.inputTokens ?? null,
        usageInput.outputTokens ?? null,
        usageInput.costUsd ?? null,
        createdAt,
      );
    return id;
  })(input);
}

export function recordToolCall(input: RecordToolCallInput): string {
  const database = db();
  return database.transaction((toolInput: RecordToolCallInput) => {
    const createdAt = toolInput.createdAt ?? Date.now();
    const sessionId =
      toolInput.sessionId || eventSessionIdForTenant(toolInput.tenant);
    ensureTenant(database, toolInput.tenant, createdAt);
    const sessionCreated = ensureSession(
      database,
      toolInput.tenant,
      sessionId,
      createdAt,
    );
    if (sessionCreated) {
      insertEvent(
        database,
        {
          tenant: toolInput.tenant,
          type: 'session_started',
          actor: 'system',
          senderId: null,
          sessionId,
          createdAt,
          payload: {
            tenant_id: toolInput.tenant.tenant_id,
            channel: toolInput.tenant.channel,
            chat_id: toolInput.tenant.chat_id,
          },
        },
        sessionId,
        createdAt,
      );
    }

    const id = randomUUID();
    database
      .prepare(
        `
        INSERT INTO tool_calls
          (id, tenant_id, session_id, event_id, channel, chat_id, sender_id,
           tool_call_id, tool_name, status, args_hash, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        toolInput.tenant.tenant_id,
        sessionId,
        toolInput.eventId || null,
        toolInput.tenant.channel,
        toolInput.tenant.chat_id,
        toolInput.senderId || null,
        toolInput.toolCallId,
        toolInput.toolName,
        toolInput.status,
        toolInput.argsHash || null,
        JSON.stringify(redactEventPayload(toolInput.payload)),
        createdAt,
      );
    return id;
  })(input);
}

export function recordModelTrace(input: RecordModelTraceInput): string {
  const database = db();
  return database.transaction((traceInput: RecordModelTraceInput) => {
    const createdAt = traceInput.createdAt ?? Date.now();
    const sessionId =
      traceInput.sessionId || eventSessionIdForTenant(traceInput.tenant);
    ensureTenant(database, traceInput.tenant, createdAt);
    const sessionCreated = ensureSession(
      database,
      traceInput.tenant,
      sessionId,
      createdAt,
    );
    if (sessionCreated) {
      insertEvent(
        database,
        {
          tenant: traceInput.tenant,
          type: 'session_started',
          actor: 'system',
          senderId: null,
          sessionId,
          createdAt,
          payload: {
            tenant_id: traceInput.tenant.tenant_id,
            channel: traceInput.tenant.channel,
            chat_id: traceInput.tenant.chat_id,
          },
        },
        sessionId,
        createdAt,
      );
    }

    const id = randomUUID();
    database
      .prepare(
        `
        INSERT INTO model_traces
          (id, tenant_id, session_id, channel, chat_id, sender_id, run_mode,
           model_role, provider_model, status, legacy_answer_length,
           skoobi_answer_length, latency_ms, input_tokens, output_tokens,
           cost_usd, tool_calls_requested, tool_calls_allowed,
           tool_calls_denied, final_answer_hash, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        traceInput.tenant.tenant_id,
        sessionId,
        traceInput.tenant.channel,
        traceInput.tenant.chat_id,
        traceInput.senderId || null,
        traceInput.runMode,
        traceInput.modelRole,
        traceInput.providerModel || null,
        traceInput.status,
        traceInput.legacyAnswerLength ?? null,
        traceInput.skoobiAnswerLength ?? null,
        traceInput.latencyMs ?? null,
        traceInput.inputTokens ?? null,
        traceInput.outputTokens ?? null,
        traceInput.costUsd ?? null,
        traceInput.toolCallsRequested ?? null,
        traceInput.toolCallsAllowed ?? null,
        traceInput.toolCallsDenied ?? null,
        traceInput.finalAnswerHash || null,
        JSON.stringify(redactEventPayload(traceInput.payload)),
        createdAt,
      );

    return id;
  })(input);
}

export function getEventsForTenant(tenantId: string): EventRecord[] {
  return db()
    .prepare(
      `
      SELECT event_id, tenant_id, session_id, seq, type, actor, channel, chat_id,
             sender_id, payload_json, created_at
      FROM events
      WHERE tenant_id = ?
      ORDER BY session_id, seq
    `,
    )
    .all(tenantId) as EventRecord[];
}
