import { registerExtension } from '../orchestrator/extensions.js';
import { getDb } from '../orchestrator/db.js';
import { logger } from '../orchestrator/logger.js';

// Diagnostic record of every agent run: which group, what triggered it, how
// long it took, how many turns, which model, and whether it succeeded. This is
// observability, not accounting — it answers "did that run work and how slow
// was it", never "what did it cost".
//
// Legacy cost columns and historical values are retained. New runs do not
// estimate monetary cost from a different provider's token price list.
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
    const database = getDb();
    const hasLegacyCostColumn = (
      database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{
        name: string;
      }>
    ).some((column) => column.name === 'estimated_cost_usd');
    database
      .prepare(
        `INSERT INTO agent_runs (group_folder, chat_jid, trigger_type, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, duration_ms, turns, model, status, run_at${hasLegacyCostColumn ? ', estimated_cost_usd' : ''})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${hasLegacyCostColumn ? ', NULL' : ''})`,
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
