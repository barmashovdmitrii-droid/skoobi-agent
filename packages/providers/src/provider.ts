// @skoobi/providers — контракт подключения AI-провайдера («кирпич» Лего).
//
// Провайдер = любая реализация ModelGateway: единственный обязательный метод
// complete(ModelRequest) → ModelResponse (см. model-gateway.ts). Всё остальное
// (модели по ролям, таймауты, circuit breaker, failover) живёт вокруг этого
// контракта и от конкретного провайдера не зависит.
//
// Как подключить нового провайдера:
//  1. OpenAI-совместимый HTTP (Ollama, LM Studio, vLLM, OpenRouter, …) —
//     кода НЕ нужно: SKOOBI_MODEL_GATEWAY_TYPE=openai_compatible (или пресет
//     'ollama') + SKOOBI_MODEL_GATEWAY_BASE_URL / SKOOBI_OLLAMA_* в .env.
//  2. Свой транспорт (CLI, другой протокол) — реализуй ModelGateway (пример:
//     codex-subscription-gateway.ts) и добавь ветку в createModelGateway,
//     либо зарегистрируй фабрику здесь через registerProviderFactory и укажи
//     её имя в SKOOBI_MODEL_GATEWAY_TYPE.
import type { ModelGateway, ModelGatewayConfig } from './model-gateway.js';

/** Фабрика провайдера: получает загруженный конфиг, отдаёт ModelGateway. */
export type ProviderFactory = (config: ModelGatewayConfig) => ModelGateway;

const customProviders = new Map<string, ProviderFactory>();

/**
 * Регистрация стороннего провайдера под своим именем (значение
 * SKOOBI_MODEL_GATEWAY_TYPE). Встроенные типы ('codex_subscription_cli',
 * 'openai_compatible', 'ollama') зарезервированы — их перекрыть нельзя,
 * чтобы конфиг всегда значил одно и то же.
 */
export function registerProviderFactory(
  name: string,
  factory: ProviderFactory,
): void {
  const normalized = name.trim().toLowerCase();
  if (
    ['codex_subscription_cli', 'openai_compatible', 'ollama'].includes(
      normalized,
    )
  ) {
    throw new Error(`Provider name "${normalized}" is built in`);
  }
  customProviders.set(normalized, factory);
}

export function resolveCustomProviderFactory(
  name: string,
): ProviderFactory | undefined {
  return customProviders.get(name.trim().toLowerCase());
}

/** Дефолтный локальный эндпоинт Ollama (OpenAI-совместимый /v1). */
export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
