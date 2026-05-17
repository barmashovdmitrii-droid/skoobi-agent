/**
 * Step: groups - Telegram-only deployments do not need upfront group sync.
 *
 * Telegram chat metadata is discovered at runtime when messages arrive.
 * This step remains as a compatibility no-op for setup flows that still call it.
 */
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  emitStatus('SYNC_GROUPS', {
    BUILD: 'skipped',
    SYNC: 'skipped',
    GROUPS_IN_DB: 0,
    REASON: 'telegram_only_runtime',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
