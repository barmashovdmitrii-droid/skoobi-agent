


export interface RunTrust {
  /** Тир учётных данных хода. */
  tier: 'owner' | 'guest';
  /**
   * Ход идёт на изолированной поверхности личного наблюдателя WhatsApp: сам
   * чат является источником недоверенных данных, поэтому ход не получает ни
   * owner-монтирований, ни секретов хоста, ни IPC-возможностей.
   */
  isolatedObserverSurface: boolean;
  /** В промпт этого хода подмешан текст или изображения третьих лиц. */
  untrustedContentAttached: boolean;
  /** Человекочитаемая причина — идёт в журнал и в событие. */
  reason: string;
}

export interface ResolveRunTrustInput {
  groupIsMain: boolean;
  chatJid: string;
  /** `agentConfig.whatsappObserverAccess` группы. */
  whatsappObserverAccess?: boolean;
  /** Тир, вычисленный хостом по авторству сообщений пачки. */
  credentialProxyTier?: 'owner' | 'guest';
  /** Хост подмешал в промпт наблюдённую чужую переписку или её изображения. */
  untrustedContentAttached?: boolean;
}

/**
 * Личный наблюдатель WhatsApp: у персонального аккаунта нет подписанной
 * идентичности отправителя, а входящее сообщение контакта неотличимо по
 * авторитету от сообщения владельца. Поэтому ход на этой поверхности всегда
 * идёт гостевым тиром.
 */
export function isIsolatedObserverSurface(input: {
  groupIsMain: boolean;
  chatJid: string;
  whatsappObserverAccess?: boolean;
}): boolean {
  return (
    input.groupIsMain === true &&
    input.whatsappObserverAccess === true &&
    String(input.chatJid).endsWith('@s.whatsapp.net')
  );
}

export function resolveRunTrust(input: ResolveRunTrustInput): RunTrust {
  const isolatedObserverSurface = isIsolatedObserverSurface(input);
  const untrustedContentAttached = input.untrustedContentAttached === true;

  if (isolatedObserverSurface) {
    return {
      tier: 'guest',
      isolatedObserverSurface: true,
      untrustedContentAttached,
      reason:
        'изолированная поверхность личного наблюдателя WhatsApp: авторство входящего не подтверждено',
    };
  }

  const tier = input.credentialProxyTier === 'owner' ? 'owner' : 'guest';
  return {
    tier,
    isolatedObserverSurface: false,
    untrustedContentAttached,
    reason:
      tier === 'owner'
        ? untrustedContentAttached
          ? 'ход владельца, но в промпте есть чужой текст'
          : 'ход владельца'
        : 'ход не подтверждён как авторски владельческий',
  };
}

/**
 * Признак изолированного наблюдателя для потребителя.
 *
 * Смысл в порядке: если решение по ходу УЖЕ принято — берём его и ничего не
 * пересчитываем. Пересчёт остаётся только запасным путём для вызовов, которые
 * решение не передали (тесты, прямые вызовы `buildSandboxMounts`), чтобы
 * добавление поля никому ничего не сломало.
 */
export function isolatedObserverForRun(
  runTrust: RunTrust | undefined,
  fallback: {
    groupIsMain: boolean;
    chatJid?: string;
    whatsappObserverAccess?: boolean;
  },
): boolean {
  if (runTrust) return runTrust.isolatedObserverSurface;
  return isIsolatedObserverSurface({
    groupIsMain: fallback.groupIsMain,
    chatJid: fallback.chatJid || '',
    whatsappObserverAccess: fallback.whatsappObserverAccess,
  });
}



export const UNTRUSTED_CONTENT_QUARANTINED_TOOLS: readonly string[] = [
  // рассылка вовне
  'send_message',
  'send_document',
  'send_photo',
  'send_voice_message',
  // постоянные последствия
  'schedule_task',
  'update_task',
  'cancel_task',
  'pause_task',
  'resume_task',
  'cleanup_tasks',
  'register_group',
  'memory_save',
  'memory_state',
  'skill_propose',
  // запуск задач в Codex Desktop — тоже действие вовне
  'codex_desktop_control',
  // управление маком
  'computer_click',
  'computer_key',
  'computer_type',
  'computer_mouse_move',
  'computer_open_app',
  'computer_screenshot',
  'computer_screen_size',
];

/** Что дозаписать в disallowedTools для конкретного хода. */
export function quarantinedToolsForRun(runTrust: RunTrust | undefined): string[] {
  if (!runTrust?.untrustedContentAttached) return [];
  return [...UNTRUSTED_CONTENT_QUARANTINED_TOOLS];
}
