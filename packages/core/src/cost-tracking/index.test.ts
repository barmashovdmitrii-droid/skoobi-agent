import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from '../orchestrator/db.js';
import { getExtensionDbSchema } from '../orchestrator/extensions.js';
import { logAgentRun, type AgentRunRecord } from './index.js';

// Importing ./index.js registers the cost-tracking extension (which owns the
// agent_runs schema). _initTestDatabase() builds a fresh in-memory DB without
// plugin schemas, so re-apply the registered extension schema here to create
// the agent_runs table the way production does.
function applyExtensionSchema(): void {
  const db = getDb();
  for (const sql of getExtensionDbSchema()) {
    db.exec(sql);
  }
}

function readLoggedCost(): number {
  const row = getDb()
    .prepare('SELECT estimated_cost_usd FROM agent_runs ORDER BY id DESC LIMIT 1')
    .get() as { estimated_cost_usd: number } | undefined;
  return Number(row?.estimated_cost_usd ?? 0);
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

beforeEach(() => {
  _initTestDatabase();
  applyExtensionSchema();
});

describe('cost-tracking estimateCost via logAgentRun', () => {
  it('prices cache-creation tokens at the tier input rate (matches quota.ts)', () => {
    // sonnet: input $3 / 1M. 1,000,000 cache-creation tokens => $3.00.
    logAgentRun({
      ...baseRecord,
      model: 'claude-sonnet-4-5',
      cacheCreationTokens: 1_000_000,
    });
    expect(readLoggedCost()).toBeCloseTo(3, 6);
  });

  it('includes cache-creation cost on top of input/output/cache-read', () => {
    // opus: input $15, output $75, cacheRead $0.3 per 1M; cache-creation at
    // input rate ($15). 1M of each => 15 + 75 + 0.3 + 15 = 105.3.
    logAgentRun({
      ...baseRecord,
      model: 'claude-opus-4-1',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    expect(readLoggedCost()).toBeCloseTo(105.3, 6);
  });

  it('persists a cost strictly greater than the input-only cost when cache-creation tokens are present', () => {
    // Regression guard: the bug omitted cache-creation entirely, so a run with
    // ONLY cache-creation tokens (no input/output/cache-read) logged $0.
    logAgentRun({
      ...baseRecord,
      model: 'claude-sonnet-4-5',
      cacheCreationTokens: 500_000,
    });
    // sonnet input $3 / 1M => 500k cache-creation => $1.50, not $0.
    expect(readLoggedCost()).toBeGreaterThan(0);
    expect(readLoggedCost()).toBeCloseTo(1.5, 6);
  });
});
