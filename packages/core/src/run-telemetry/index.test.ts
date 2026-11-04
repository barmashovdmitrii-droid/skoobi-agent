import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from '../orchestrator/db.js';
import { getExtensionDbSchema } from '../orchestrator/extensions.js';
import { logAgentRun, type AgentRunRecord } from './index.js';

// Importing ./index.js registers the run-telemetry extension (which owns the
// agent_runs schema). _initTestDatabase() builds a fresh in-memory DB without
// plugin schemas, so re-apply the registered extension schema here to create
// the agent_runs table the way production does.
function applyExtensionSchema(): void {
  const db = getDb();
  for (const sql of getExtensionDbSchema()) {
    db.exec(sql);
  }
}

const baseRecord: AgentRunRecord = {
  groupFolder: 'main',
  chatJid: 'tg:-1001',
  triggerType: 'message',
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  durationMs: 100,
  turns: 1,
  status: 'success',
};

function lastRun(): Record<string, unknown> | undefined {
  return getDb()
    .prepare('SELECT * FROM agent_runs ORDER BY id DESC LIMIT 1')
    .get() as Record<string, unknown> | undefined;
}

beforeEach(() => {
  _initTestDatabase();
  applyExtensionSchema();
});

describe('run-telemetry', () => {
  it('records the diagnostic shape of a run', () => {
    logAgentRun({
      ...baseRecord,
      model: 'gpt-5.4-codex',
      triggerType: 'scheduled',
      inputTokens: 1200,
      outputTokens: 340,
      durationMs: 8_500,
      turns: 3,
    });

    expect(lastRun()).toMatchObject({
      group_folder: 'main',
      chat_jid: 'tg:-1001',
      trigger_type: 'scheduled',
      model: 'gpt-5.4-codex',
      status: 'success',
      duration_ms: 8_500,
      turns: 3,
      input_tokens: 1200,
      output_tokens: 340,
    });
  });

  it('carries no cost column — pricing was removed, not just zeroed', () => {
    // Guard against a regression that re-adds money to this table: a zeroed
    // estimated_cost_usd would still invite a dashboard to sum it and present
    // the total as "what Skoobi costs".
    logAgentRun(baseRecord);
    expect(Object.keys(lastRun() ?? {})).not.toContain('estimated_cost_usd');
  });

  it('records failed runs too, so errors stay visible in diagnostics', () => {
    logAgentRun({ ...baseRecord, status: 'error' });
    expect(lastRun()).toMatchObject({ status: 'error' });
  });

  it('never throws out of the logging path', () => {
    // The writer is best-effort: a telemetry failure must not take down the
    // agent run it is describing.
    getDb().exec('DROP TABLE agent_runs');
    expect(() => logAgentRun(baseRecord)).not.toThrow();
  });
});
