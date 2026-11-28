import { describe, expect, it } from 'vitest';

import { parseTelegramBotRuntimeConfigs } from './telegram-bot-config.js';

describe('Telegram bot runtime config', () => {
  it('keeps the legacy single-token setup as the default', () => {
    expect(
      parseTelegramBotRuntimeConfigs({
        defaultToken: 'token-main',
        defaultBotId: 'telegram_default',
      }),
    ).toEqual([{ botId: 'telegram_default', token: 'token-main' }]);
  });

  it('loads multiple persona bot configs from JSON without exposing token env names as identity', () => {
    const configs = parseTelegramBotRuntimeConfigs({
      json: JSON.stringify([
        {
          bot_id: 'skoobi_friend',
          persona_id: 'friend',
          token_env: 'TELEGRAM_BOT_TOKEN_FRIEND',
        },
        {
          bot_id: 'skoobi_lawyer',
          persona_id: 'lawyer',
          token_env: 'TELEGRAM_BOT_TOKEN_LAWYER',
        },
      ]),
      tokenLookup: (name) =>
        name === 'TELEGRAM_BOT_TOKEN_FRIEND'
          ? 'friend-token'
          : name === 'TELEGRAM_BOT_TOKEN_LAWYER'
            ? 'lawyer-token'
            : undefined,
    });

    expect(configs).toEqual([
      {
        botId: 'skoobi_friend',
        personaId: 'friend',
        token: 'friend-token',
        tokenEnv: 'TELEGRAM_BOT_TOKEN_FRIEND',
      },
      {
        botId: 'skoobi_lawyer',
        personaId: 'lawyer',
        token: 'lawyer-token',
        tokenEnv: 'TELEGRAM_BOT_TOKEN_LAWYER',
      },
    ]);
  });

  it('adds configured persona bots without disabling the legacy default bot', () => {
    const configs = parseTelegramBotRuntimeConfigs({
      defaultToken: 'main-token',
      defaultBotId: 'telegram_default',
      json: JSON.stringify([
        {
          bot_id: 'skoobi_friend',
          persona_id: 'friend',
          token_env: 'TELEGRAM_BOT_TOKEN_FRIEND',
        },
      ]),
      tokenLookup: (name) =>
        name === 'TELEGRAM_BOT_TOKEN_FRIEND' ? 'friend-token' : undefined,
    });

    expect(configs.map((config) => config.botId)).toEqual([
      'telegram_default',
      'skoobi_friend',
    ]);
  });

  it('skips disabled bot configs with missing tokens', () => {
    expect(
      parseTelegramBotRuntimeConfigs({
        json: JSON.stringify([
          {
            bot_id: 'skoobi_friend',
            persona_id: 'friend',
            token_env: 'MISSING_TOKEN',
          },
        ]),
        tokenLookup: () => undefined,
      }),
    ).toEqual([]);
  });
});
