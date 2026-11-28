import { registerExtension } from '../orchestrator/extensions.js';
import { getDb } from '../orchestrator/db.js';
import { logger } from '../orchestrator/logger.js';

// Diagnostic record of every agent run: which group, what triggered it, how
// long it took, how many turns, which model, and whether it succeeded. This is
// observability, not accounting — it answers "did that run work and how slow
// was it", never "what did it cost".
//
// The former `cost-tracking` extension also multiplied these token counts by a
// hardcoded Anthropic price list and stored the product in
// agent_runs.estimated_cost_usd. That number was fiction: most runs go through
// Codex on a flat-rate subscription with zero marginal cost, so API rates
// priced them at something they never cost, and Codex reports its tokens
// cumulatively per thread rather than per run, inflating the inputs on top.
// The pricing table, the estimate, and the column were removed together;
// the token counters stay because they are useful telemetry on
// their own.
registerExtension({
  name: 'run-telemetry',
  dbSchema: [
    `CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      trigger_type TEXT NOT NULL DEFAULT 'message',
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      turns INTEGER DEFAULT 0,
      model TEXT,
      status TEXT NOT NULL,
      run_at TEXT NOT NULL
    )`,
  ],
});

export interface AgentRunRecord {
  groupFolder: string;
  chatJid: string;
  triggerType: 'message' | 'scheduled' | 'webhook';
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  turns: number;
  model?: string;
  status: 'success' | 'error' | 'cancelled';
}

export function logAgentRun(record: AgentRunRecord): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO agent_runs (group_folder, chat_jid, trigger_type, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, duration_ms, turns, model, status, run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.groupFolder,
        record.chatJid,
        record.triggerType,
        record.inputTokens,
        record.outputTokens,
        record.cacheCreationTokens,
        record.cacheReadTokens,
        record.durationMs,
        record.turns,
        record.model || null,
        record.status,
        new Date().toISOString(),
      );
    logger.debug(
      {
        group: record.groupFolder,
        durationMs: record.durationMs,
        status: record.status,
        tokens: record.inputTokens + record.outputTokens,
      },
      'Agent run logged',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to log agent run');
  }
}
