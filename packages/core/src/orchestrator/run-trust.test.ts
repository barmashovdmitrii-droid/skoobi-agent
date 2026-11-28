import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { STATE_ROOT } from './config.js';
import {
  activeRunAckEnabledForGroup,
  progressMessagesEnabledForGroup,
} from './live-mode.js';

import {
  UNTRUSTED_CONTENT_QUARANTINED_TOOLS,
  isIsolatedObserverSurface,
  isolatedObserverForRun,
  quarantinedToolsForRun,
  resolveRunTrust,
} from './run-trust.js';
import { buildSandboxMounts } from '../runtimes/sandbox-runner.js';
import type { RegisteredGroup } from './types.js';

const OWNER_TG = 'tg:100000001';
const OWNER_WA = '77001234567@s.whatsapp.net';

function group(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'main',
    folder: 'telegram_main',
    trigger: '@Skoobi',
    added_at: '2026-01-01T00:00:00.000Z',
    isMain: true,
    agentConfig: { whatsappObserverAccess: true },
    ...overrides,
  } as RegisteredGroup;
}

describe('resolveRunTrust — одно решение на ход (S1/ARCH-2)', () => {
  it('поверхность личного наблюдателя WhatsApp всегда гостевая', () => {
    const trust = resolveRunTrust({
      groupIsMain: true,
      chatJid: OWNER_WA,
      whatsappObserverAccess: true,
      credentialProxyTier: 'owner',
    });
    expect(trust.tier).toBe('guest');
    expect(trust.isolatedObserverSurface).toBe(true);
    expect(trust.reason).toContain('наблюдателя');
  });

  it('обычный ход владельца в Телеграме остаётся owner', () => {
    const trust = resolveRunTrust({
      groupIsMain: true,
      chatJid: OWNER_TG,
      whatsappObserverAccess: true,
      credentialProxyTier: 'owner',
    });
    expect(trust.tier).toBe('owner');
    expect(trust.isolatedObserverSurface).toBe(false);
  });


  // Treat third-party text as untrusted while preserving host-approved permissions.

  it('чужой текст в ходе владельца помечается, но НЕ понижает тир', () => {
    const trust = resolveRunTrust({
      groupIsMain: true,
      chatJid: OWNER_TG,
      whatsappObserverAccess: true,
      credentialProxyTier: 'owner',
      untrustedContentAttached: true,
    });
    expect(trust.tier).toBe('owner');
    expect(trust.untrustedContentAttached).toBe(true);
    expect(trust.reason).toContain('чужой текст');
  });

  it('без подтверждённого владельческого авторства тир гостевой', () => {
    expect(
      resolveRunTrust({ groupIsMain: true, chatJid: OWNER_TG }).tier,
    ).toBe('guest');
    expect(
      resolveRunTrust({
        groupIsMain: false,
        chatJid: 'tg:-100123',
        credentialProxyTier: 'owner',
      }).isolatedObserverSurface,
    ).toBe(false);
  });

  it('наблюдательская поверхность требует всех трёх условий', () => {
    expect(
      isIsolatedObserverSurface({
        groupIsMain: false,
        chatJid: OWNER_WA,
        whatsappObserverAccess: true,
      }),
    ).toBe(false);
    expect(
      isIsolatedObserverSurface({
        groupIsMain: true,
        chatJid: OWNER_WA,
        whatsappObserverAccess: false,
      }),
    ).toBe(false);
    expect(
      isIsolatedObserverSurface({
        groupIsMain: true,
        chatJid: OWNER_TG,
        whatsappObserverAccess: true,
      }),
    ).toBe(false);
  });
});

describe('решение хода доезжает до потребителей, а не пересчитывается', () => {
  it('готовое решение перебивает то, что подсказал бы chatJid', () => {
    // Поверхность выглядит как обычный Телеграм, но хост уже решил, что ход
    // изолированный. Потребитель обязан подчиниться решению.
    expect(
      isolatedObserverForRun(
        {
          tier: 'guest',
          isolatedObserverSurface: true,
          untrustedContentAttached: true,
          reason: 'решение хоста',
        },
        { groupIsMain: true, chatJid: OWNER_TG, whatsappObserverAccess: true },
      ),
    ).toBe(true);

    // И обратно: chatJid говорит «WhatsApp», но решение хоста — обычный ход.
    expect(
      isolatedObserverForRun(
        {
          tier: 'owner',
          isolatedObserverSurface: false,
          untrustedContentAttached: false,
          reason: 'решение хоста',
        },
        { groupIsMain: true, chatJid: OWNER_WA, whatsappObserverAccess: true },
      ),
    ).toBe(false);
  });

  it('без решения остаётся прежнее поведение по chatJid', () => {
    expect(
      isolatedObserverForRun(undefined, {
        groupIsMain: true,
        chatJid: OWNER_WA,
        whatsappObserverAccess: true,
      }),
    ).toBe(true);
    expect(
      isolatedObserverForRun(undefined, {
        groupIsMain: true,
        chatJid: OWNER_TG,
        whatsappObserverAccess: true,
      }),
    ).toBe(false);
  });

  // Exercise the trust decision at the runtime consumer.


  it('buildSandboxMounts слушается решения хода, а не chatJid', () => {
    const asObserver = buildSandboxMounts(
      group(),
      true,
      undefined,
      'owner',
      OWNER_TG,
      {
        tier: 'guest',
        isolatedObserverSurface: true,
        untrustedContentAttached: true,
        reason: 'решение хоста',
      },
    );
    const asOwner = buildSandboxMounts(
      group(),
      true,
      undefined,
      'owner',
      OWNER_TG,
    );

    const projectMount = (mounts: typeof asOwner) =>
      mounts.find((m) => m.containerPath === '/workspace/project' && !m.deny);

    // Изолированный ход не получает корень проекта; обычный владельческий —
    // получает. Разница целиком определяется решением, переданным сверху.
    expect(projectMount(asObserver)).toBeUndefined();
    expect(projectMount(asOwner)).toBeDefined();
  });
});

describe('карантин хода с чужим текстом (S1/S5/S6)', () => {
  const trust = (untrustedContentAttached: boolean) =>
    resolveRunTrust({
      groupIsMain: true,
      chatJid: OWNER_TG,
      whatsappObserverAccess: true,
      credentialProxyTier: 'owner',
      untrustedContentAttached,
    });

  it('обычный ход владельца ничего не теряет', () => {
    expect(quarantinedToolsForRun(trust(false))).toEqual([]);
    expect(quarantinedToolsForRun(undefined)).toEqual([]);
  });

  it('ход с чужим текстом теряет рассылку, планирование и управление маком', () => {
    const blocked = quarantinedToolsForRun(trust(true));
    for (const tool of [
      'send_message',
      'schedule_task',
      'register_group',
      'memory_save',
      'skill_propose',
      'game_factory_control',
      'computer_type',
    ]) {
      expect(blocked).toContain(tool);
    }
  });

  // Reading permitted conversation history remains available in an isolated turn.

  it('чтение остаётся доступным, ход не превращается в отписку', () => {
    const blocked = quarantinedToolsForRun(trust(true));
    for (const tool of [
      'memory_get',
      'game_factory_status',
      'memory_search',
      'list_tasks',
      'skill_list',
      'skill_view',
    ]) {
      expect(blocked).not.toContain(tool);
    }
  });

  it('тир при этом НЕ понижается — карантин не заменяет собой права', () => {
    expect(trust(true).tier).toBe('owner');
    expect(UNTRUSTED_CONTENT_QUARANTINED_TOOLS.length).toBeGreaterThan(10);
  });
});

describe('гейт промежуточных реплик (SKOOBI_PROGRESS_MESSAGES_GROUPS)', () => {
  const prev = process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS;
  afterEach(() => {
    if (prev === undefined) delete process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS;
    else process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS = prev;
    try {
      fs.rmSync(path.join(STATE_ROOT, 'store', 'progress-messages.disabled'));
    } catch {
      // файла могло и не быть
    }
  });

  it('по умолчанию выключено везде', () => {
    delete process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS;
    expect(progressMessagesEnabledForGroup('telegram_main')).toBe(false);
  });

  it('включается поимённо, чужие группы не задевает', () => {
    process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS = 'telegram_main';
    expect(progressMessagesEnabledForGroup('telegram_main')).toBe(true);
    expect(progressMessagesEnabledForGroup('telegram_fixture_secondary')).toBe(false);
    expect(progressMessagesEnabledForGroup('')).toBe(false);
  });

  // Аварийное выключение без рестарта и без пересборки — файл проверяется на
  // каждом ходе, поэтому touch останавливает функцию со следующего же хода.
  it('файл-киллсвитч перебивает включённый список', () => {
    process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS = 'telegram_main';
    fs.mkdirSync(path.join(STATE_ROOT, 'store'), { recursive: true });
    fs.writeFileSync(
      path.join(STATE_ROOT, 'store', 'progress-messages.disabled'),
      '',
    );
    expect(progressMessagesEnabledForGroup('telegram_main')).toBe(false);
  });
});

describe('гейт ответа хоста на «ау» и 👀 (SKOOBI_ACTIVE_RUN_ACK_GROUPS)', () => {
  const prev = process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS;
  const prevProgress = process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS;
  afterEach(() => {
    if (prev === undefined) delete process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS;
    else process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS = prev;
    if (prevProgress === undefined) {
      delete process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS;
    } else {
      process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS = prevProgress;
    }
    for (const file of [
      'active-run-ack.disabled',
      'progress-messages.disabled',
    ]) {
      try {
        fs.rmSync(path.join(STATE_ROOT, 'store', file));
      } catch {
        // файла могло и не быть
      }
    }
  });

  it('по умолчанию выключено везде', () => {
    delete process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS;
    expect(activeRunAckEnabledForGroup('telegram_main')).toBe(false);
  });

  it('включается поимённо, чужие группы не задевает', () => {
    process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS = ' telegram_main , ';
    expect(activeRunAckEnabledForGroup('telegram_main')).toBe(true);
    expect(activeRunAckEnabledForGroup('telegram_fixture_secondary')).toBe(false);
    expect(activeRunAckEnabledForGroup('')).toBe(false);
  });

  it('свой киллсвитч перебивает список, чужой — нет', () => {
    process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS = 'telegram_main';
    process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS = 'telegram_main';
    fs.mkdirSync(path.join(STATE_ROOT, 'store'), { recursive: true });
    fs.writeFileSync(
      path.join(STATE_ROOT, 'store', 'progress-messages.disabled'),
      '',
    );
    expect(activeRunAckEnabledForGroup('telegram_main')).toBe(true);
    expect(progressMessagesEnabledForGroup('telegram_main')).toBe(false);
    fs.rmSync(path.join(STATE_ROOT, 'store', 'progress-messages.disabled'));
    fs.writeFileSync(
      path.join(STATE_ROOT, 'store', 'active-run-ack.disabled'),
      '',
    );
    expect(activeRunAckEnabledForGroup('telegram_main')).toBe(false);
    expect(progressMessagesEnabledForGroup('telegram_main')).toBe(true);
  });
});

// Изменение флага в .env не требует перезапуска. Оба гейта
// читают файл на каждом вызове; проверяем это без перезагрузки модуля.
describe('гейты групп читают .env на каждом вызове', () => {
  const prevProgress = process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS;
  const prevAck = process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS;
  let dir = '';
  afterEach(() => {
    if (prevProgress === undefined) {
      delete process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS;
    } else {
      process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS = prevProgress;
    }
    if (prevAck === undefined) delete process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS;
    else process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS = prevAck;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('новая группа в строке .env действует со следующего вызова', () => {
    delete process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS;
    delete process.env.SKOOBI_ACTIVE_RUN_ACK_GROUPS;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-gate-env-'));
    const envFile = path.join(dir, '.env');
    process.env.CLAUDECLAW_ENV_FILE = envFile;

    fs.writeFileSync(
      envFile,
      'SKOOBI_PROGRESS_MESSAGES_GROUPS=telegram_main\n' +
        'SKOOBI_ACTIVE_RUN_ACK_GROUPS=telegram_main\n',
    );
    expect(progressMessagesEnabledForGroup('telegram_main')).toBe(true);
    expect(progressMessagesEnabledForGroup('telegram_fixture_secondary')).toBe(false);
    expect(activeRunAckEnabledForGroup('telegram_fixture_secondary')).toBe(false);

    fs.writeFileSync(
      envFile,
      'SKOOBI_PROGRESS_MESSAGES_GROUPS=telegram_main,telegram_fixture_secondary\n' +
        'SKOOBI_ACTIVE_RUN_ACK_GROUPS=telegram_main,telegram_fixture_secondary\n',
    );
    expect(progressMessagesEnabledForGroup('telegram_fixture_secondary')).toBe(true);
    expect(activeRunAckEnabledForGroup('telegram_fixture_secondary')).toBe(true);
    expect(activeRunAckEnabledForGroup('telegram_main')).toBe(true);
  });
});
