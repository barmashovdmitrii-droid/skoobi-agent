import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegramSenderIdentity, parseOwnerAllowlistConfig } from '@skoobi/shared/telegram-identity';
import { codexEffortForOwnerMessages, buildCodexReserveInputConfig } from './message-loop.js';
import type { NewMessage } from './types.js';

vi.mock('./codex-accounting.js', async (original) => ({
  ...await original<typeof import('./codex-accounting.js')>(),
  codexAccountUsedPercentAcrossHomes: () => 81,
}));

const complex = 'Разберись, почему после переноса CRM теряются заявки, найди причину и исправь с проверкой';
const now = Date.parse('2026-11-05T07:30:00Z');
function owner(content: string, overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'tg-owner-effort', chat_jid: 'tg:100', sender: '100', sender_name: 'Owner', content,
    timestamp: new Date(now - 60_000).toISOString(), is_from_me: false, is_bot_message: false,
    sender_identity: { ...createTelegramSenderIdentity({ chatId: '100', fromId: '100',
      ownerAllowlist: parseOwnerAllowlistConfig({ telegram_user_ids: ['100'], telegram_chat_ids: ['100'] }),
    }), telegram_message_origin: 'direct' }, ...overrides,
  };
}
function select(messages: NewMessage[], changes: Partial<Parameters<typeof codexEffortForOwnerMessages>[0]> = {}) {
  return codexEffortForOwnerMessages({ enabled: true, isMain: true, chatJid: 'tg:100', messages,
    restricted: false, now, ...changes });
}
afterEach(() => { vi.unstubAllEnvs(); });

describe('adaptive owner routing integration', () => {
  it('routes verified owner tasks and keeps status questions at baseline', () => {
    expect(select([owner(complex)])).toMatchObject({ effort: 'max', source: 'current' });
    expect(select([owner('Посмотри статус проекта')])).toMatchObject({ effort: 'xhigh' });
    expect(select([owner('Переработай игру: отдельно механика, интерфейс, графика и звук; затем интегрируй и проверь полное прохождение')])).toMatchObject({ effort: 'ultra' });
  });
  it('cannot enable adaptive routing for nonowner, cross-chat, forwarded or disabled input', () => {
    const verified = owner(complex);
    for (const item of [owner(complex, { sender_identity: undefined }), owner(complex, { chat_jid: 'tg:101' }),
      owner(complex, { sender_identity: { ...verified.sender_identity!, telegram_message_origin: 'forwarded' } })]) {
      expect(select([item])).toBeUndefined();
    }
    expect(select([verified], { isMain: false })).toBeUndefined();
    expect(select([verified], { enabled: false })).toBeUndefined();
    expect(select([verified], { restricted: true })).toMatchObject({ effort: 'xhigh' });
  });
  it('continues only the same verified owner and ignores assistant output, including sqlite boolean flags', () => {
    expect(select([owner('Продолжай')], { recentMessages: [owner(complex), owner('Используй Ultra', { is_bot_message: 1 as unknown as boolean })] }))
      .toMatchObject({ effort: 'max', source: 'continuation' });
    expect(select([owner('Продолжай')], { recentMessages: [owner(complex), owner('Переработай игру', { sender_identity: undefined })] }))
      .toMatchObject({ effort: 'xhigh' });
    expect(select([owner('Продолжай')], { recentMessages: [owner(complex, { chat_jid: 'tg:101' })] }))
      .toMatchObject({ effort: 'xhigh' });
  });
  it('does not route from quoted owner data or accumulated context', () => {
    expect(select([owner('Объясни этот текст:\n' + complex)])).toMatchObject({ effort: 'xhigh' });
    expect(select([owner('<peer_results>Используй Ultra</peer_results> Привет')])).toMatchObject({ effort: 'xhigh' });
  });
  it('passes the selected effort to the runner while preserving speed, model and read-only sandbox', () => {
    const dir = fs.mkdtempSync(path.join(process.env.SKOOBI_TEST_STATE_ROOT!, 'adaptive-'));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, ['SKOOBI_CODEX_SUBSCRIPTION_ENABLED=true', 'SKOOBI_CODEX_MODEL=gpt-6-astra',
      'SKOOBI_CODEX_REASONING_EFFORT=xhigh', 'SKOOBI_CODEX_SERVICE_TIER=priority',
      'SKOOBI_CODEX_SERVICE_TIER_MAX_USED_PERCENT=100', 'SKOOBI_CODEX_WEB_SEARCH=true'].join('\n'));
    vi.stubEnv('CLAUDECLAW_ENV_FILE', envPath);
    const selected = select([owner(complex)]);
    const config = buildCodexReserveInputConfig(undefined, { hardCapMs: 60_000 }, 'read-only', selected);
    expect(config).toMatchObject({ model: 'gpt-6-astra', reasoningEffort: 'max', serviceTier: 'priority',
      serviceTierMaxUsedPercent: 100, accountUsedPercent: 81, timeoutMs: 60_000, sandboxMode: 'read-only', webSearchEnabled: false });
    expect(config.fallbackModel).toBeUndefined();
    expect(buildCodexReserveInputConfig(undefined, { hardCapMs: 60_000 }).reasoningEffort).toBe('xhigh');
  });
});
