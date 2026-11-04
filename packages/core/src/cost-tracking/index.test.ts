import { beforeEach, describe, expect, it } from 'vitest';
import { _initTestDatabase, createSchema, getDb } from '../orchestrator/db.js';
import { getExtensionDbSchema } from '../orchestrator/extensions.js';
import { logAgentRun, type AgentRunRecord } from './index.js';
import { logAgentRun as telemetryLogAgentRun } from '../run-telemetry/index.js';

const run: AgentRunRecord = {
  groupFolder: 'main',
  chatJid: 'tg:-1001',
  triggerType: 'message',
  inputTokens: 1000,
  outputTokens: 200,
  cacheCreationTokens: 300,
  cacheReadTokens: 400,
  durationMs: 100,
  turns: 1,
  model: 'codex-subscription',
  status: 'success',
};
beforeEach(() => {
  _initTestDatabase();
  for (const sql of getExtensionDbSchema()) getDb().exec(sql);
});
describe('compatible agent-run diagnostics', () => {
  it('shares one writer with the legacy import and stores tokens without inventing cost', () => {
    expect(logAgentRun).toBe(telemetryLogAgentRun);
    logAgentRun(run);
    expect(getDb().prepare('SELECT * FROM agent_runs').all()).toHaveLength(1);
    expect(getDb().prepare('SELECT * FROM agent_runs').get()).toMatchObject({
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_tokens: 300,
      cache_read_tokens: 400,
      status: 'success',
    });
  });
  it('preserves legacy monetary values and records unknown cost as NULL on new runs', () => {
    getDb().exec(
      'ALTER TABLE agent_runs ADD COLUMN estimated_cost_usd REAL DEFAULT 0',
    );
    logAgentRun(run);
    getDb().exec('UPDATE agent_runs SET estimated_cost_usd=12.5 WHERE id=1');
    createSchema(getDb());
    logAgentRun({ ...run, status: 'cancelled' });
    expect(
      getDb()
        .prepare(
          'SELECT estimated_cost_usd, status FROM agent_runs ORDER BY id',
        )
        .all(),
    ).toEqual([
      { estimated_cost_usd: 12.5, status: 'success' },
      { estimated_cost_usd: null, status: 'cancelled' },
    ]);
  });
  it('preserves existing public quota and custom campaign state across additive upgrades', () => {
    getDb()
      .exec(`CREATE TABLE whatsapp_campaign_leads(id TEXT PRIMARY KEY, value TEXT);
      INSERT INTO whatsapp_campaign_leads VALUES('synthetic','keep');
      INSERT INTO user_quota_accounts(id,tenant_id,channel,channel_user_id,weekly_limit_credits,quota_enabled,created_at,updated_at)
        VALUES('synthetic-account','synthetic-tenant','telegram','100000001',1234,1,1,1);`);
    const tables = [
      'whatsapp_campaign_leads',
      'user_quota_accounts',
      'usage_ledger',
      'quota_adjustments',
      'usage_events',
    ];
    const snapshot = () =>
      Object.fromEntries(
        tables.map((table) => [
          table,
          getDb().prepare(`SELECT * FROM ${table}`).all(),
        ]),
      );
    const before = snapshot();
    createSchema(getDb());
    createSchema(getDb());
    expect(snapshot()).toEqual(before);
    expect(
      getDb()
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='memory_state_records'",
        )
        .get(),
    ).toBeTruthy();
  });
});
