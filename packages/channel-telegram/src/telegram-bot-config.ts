import {
  defaultTelegramBotId,
  safeTelegramBotId,
} from '@skoobi/shared/telegram-identity';

export interface TelegramBotRuntimeConfig {
  botId: string;
  personaId?: string;
  token: string;
  tokenEnv?: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseTelegramBotRuntimeConfigs(input: {
  json?: string;
  defaultToken?: string;
  defaultBotId?: string;
  tokenLookup?: (envName: string) => string | undefined;
}): TelegramBotRuntimeConfig[] {
  const tokenLookup = input.tokenLookup || (() => undefined);
  const defaultToken = input.defaultToken?.trim();
  const defaultBotId = safeTelegramBotId(
    input.defaultBotId || defaultTelegramBotId(),
  );
  const defaultConfigs = defaultToken
    ? [
        {
          botId: defaultBotId,
          token: defaultToken,
        },
      ]
    : [];
  const rawJson = input.json?.trim();
  if (!rawJson) {
    return defaultConfigs;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return defaultConfigs;
  }
  if (!Array.isArray(parsed)) return defaultConfigs;

  const configs: TelegramBotRuntimeConfig[] = [...defaultConfigs];
  const seenBotIds = new Set(configs.map((config) => config.botId));
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const botId = safeTelegramBotId(
      stringValue(record.bot_id) || stringValue(record.botId),
    );
    const personaId =
      stringValue(record.persona_id) || stringValue(record.personaId);
    const tokenEnv =
      stringValue(record.token_env) || stringValue(record.tokenEnv);
    const token = tokenEnv ? tokenLookup(tokenEnv) : '';
    if (!token || seenBotIds.has(botId)) continue;
    configs.push({
      botId,
      personaId,
      token,
      tokenEnv,
    });
    seenBotIds.add(botId);
  }

  return configs;
}
