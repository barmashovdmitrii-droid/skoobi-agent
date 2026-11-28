import { describe, expect, it } from 'vitest';

import {
  formatAgo,
  formatCredits,
  formatDuration,
  humanizeCron,
  humanizeEvent,
  humanizeSchedule,
  humanizeTaskStatus,
  parseLogLine,
  scheduledTaskTierText,
} from './humanize.js';

describe('humanizeEvent', () => {
  it('переводит основные типы событий на русский с именем чата', () => {
    expect(
      humanizeEvent({
        type: 'telegram_outbound_message',
        created_at: Date.now(),
        chat_id: '123',
        chatName: 'User B',
      }).text,
    ).toBe('Ответ доставлен: User B');
    expect(
      humanizeEvent({
        type: 'error',
        created_at: Date.now(),
        chat_id: '123',
        payload_json: JSON.stringify({ kind: 'delivery_failed' }),
        chatName: 'User B',
      }).text,
    ).toBe('Не удалось доставить ответ: User B');
  });

  it('понятно описывает варианты сбоев доставки без raw snake_case', () => {
    for (const kind of [
      'outbound_delivery_failed',
      'codex_reserve_delivery_failed',
      'provider_failover_safe_error_delivery_failed',
    ]) {
      const text = humanizeEvent({
        type: 'error',
        created_at: Date.now(),
        payload_json: JSON.stringify({ kind, message: 'secret local path' }),
        chatName: 'Контакт A',
      }).text;
      expect(text).toBe('Не удалось доставить ответ: Контакт A');
      expect(text).not.toContain(kind);
      expect(text).not.toContain('secret');
    }
    expect(
      humanizeEvent({
        type: 'error',
        created_at: Date.now(),
        payload_json: JSON.stringify({
          kind: 'skoobi_live_voice_delivery_failed',
        }),
        chatName: 'Контакт A',
      }).text,
    ).toBe('Не удалось доставить голосовой ответ: Контакт A');
  });

  it('безопасно описывает сбои observer и локальной обработки медиа', () => {
    const observer = humanizeEvent({
      type: 'error',
      created_at: Date.now(),
      payload_json: JSON.stringify({
        kind: 'whatsapp_observer_history_sync_failed',
        token: 'do-not-render',
      }),
      chatName: 'Семья',
    }).text;
    expect(observer).toBe(
      'Синхронизация WhatsApp временно не сработала: Семья',
    );
    expect(observer).not.toContain('do-not-render');

    expect(
      humanizeEvent({
        type: 'error',
        created_at: Date.now(),
        payload_json: JSON.stringify({
          kind: 'whatsapp_video_processing_error',
          file: '/private/media.mov',
        }),
        chatName: 'Семья',
      }).text,
    ).toBe('Не удалось локально обработать медиа WhatsApp: Семья');
  });

  it('не показывает неизвестный error payload, chat id и управляющие символы', () => {
    const text = humanizeEvent({
      type: 'error',
      created_at: Date.now(),
      chat_id: '77001234567@s.whatsapp.net',
      chatName: '  Рабочий\nчат  ',
      payload_json: JSON.stringify({
        kind: 'brand_new_internal_failure',
        message: 'token=secret',
      }),
    }).text;
    expect(text).toBe('Ошибка в работе: Рабочий чат');
    expect(text).not.toContain('77001234567');
    expect(text).not.toContain('brand_new_internal_failure');
    expect(text).not.toContain('secret');
  });

  it('не падает на битом payload_json; неизвестный тип не светит сырым английским', () => {
    const e = humanizeEvent({
      type: 'some_new_event_type',
      created_at: Date.now(),
      chat_id: 'tg:1',
      payload_json: '{broken',
    });
    expect(e.text).toContain('Служебное событие');
    expect(e.text).not.toContain('some_new_event_type');
    expect(e.icon).toBe('dot');
  });

  it('движки переведены: полный агент Codex вместо codex_full_agent', () => {
    const e = humanizeEvent({
      type: 'runtime_selected',
      created_at: Date.now(),
      chat_id: '1',
      payload_json: JSON.stringify({ runtime: 'codex_full_agent' }),
      chatName: 'Owner',
    });
    expect(e.text).toBe('Отвечает полный агент Codex: Owner');
    expect(e.text).not.toContain('codex_full_agent');
  });

  it('гостевая memory-эскалация подписана по-человечески', () => {
    const e = humanizeEvent({
      type: 'provider_failover_attempt',
      created_at: Date.now(),
      chat_id: '5',
      payload_json: JSON.stringify({ guest_memory_runtime_required: true }),
      chatName: 'Гость',
    });
    expect(e.text).toContain('полный агент');
  });

  it('сбой хода без переключения движка не выдаётся за переключение (J10, ревью r1111)', () => {
    const ev = (payload: Record<string, unknown>) =>
      humanizeEvent({
        type: 'provider_failover_attempt',
        created_at: Date.now(),
        chat_id: '5',
        payload_json: JSON.stringify(payload),
        chatName: 'User B',
      });
    const skipped = ev({
      provider: 'codex',
      status: 'failed',
      reason: 'timeout',
      fallback_will_start: false,
      failover_skipped: 'deferred_inputs',
    });
    expect(skipped.text).toBe(
      'Сбой хода без переключения движка: User B (новые сообщения сохранены для продолжения)',
    );
    expect(skipped.text).not.toContain('Переключение движка');
    expect(skipped.icon).toBe('alert');
    // Неизвестный путь — общая причина, без сырого идентификатора.
    const unknown = ev({ failover_skipped: 'some_new_path' });
    expect(unknown.text).toBe('Сбой хода без переключения движка: User B (ход не удался)');
    // Настоящее переключение подписано как раньше.
    const real = ev({ provider: 'codex', status: 'failed', fallback_will_start: true });
    expect(real.text).toBe('Переключение движка: User B');
    expect(real.icon).toBe('refresh');
  });

  it('плановая задача: название и тариф, без текста задания (r1109, п. 6)', () => {
    const ev = (payload: Record<string, unknown>) =>
      humanizeEvent({
        type: 'scheduled_task_finished',
        created_at: Date.now(),
        chat_id: '5',
        payload_json: JSON.stringify(payload),
        chatName: 'Главный чат',
      });
    const fast = ev({
      task_title: 'Сводка продаж',
      status: 'success',
      requested_service_tier: 'priority',
      service_tier: 'priority',
    });
    expect(fast.text).toBe('Плановая задача «Сводка продаж» (Главный чат): быстрый тариф');
    expect(fast.icon).toBe('flag');
    expect(
      ev({
        task_title: 'Ночной\nразбор',
        status: 'error',
        requested_service_tier: null,
        service_tier: 'priority',
        fast_applied_unrequested: true,
      }).text,
    ).toBe('Плановая задача «Ночной разбор» (Главный чат) — не выполнилась: Fast применён, хотя не запрошен');
    expect(ev({ status: 'cancelled' }).text).toBe(
      'Плановая задача «без названия» (Главный чат) — остановлена: тариф не записан',
    );
  });

  it('тариф запуска задачи — теми же словами, что в блоке скорости', () => {
    expect(scheduledTaskTierText({ service_tier: 'priority', requested_service_tier: 'priority' })).toBe('Быстрый тариф');
    expect(
      scheduledTaskTierText({
        service_tier: 'priority',
        requested_service_tier: 'priority',
        used_percent_at_start: 87,
        service_tier_ceiling_percent: 70,
      }),
    ).toBe('Быстрый тариф выше потолка квоты');
    expect(
      scheduledTaskTierText({
        service_tier: 'priority',
        requested_service_tier: 'priority',
        used_percent_at_start: null,
        service_tier_ceiling_percent: 70,
      }),
    ).toBe('Быстрый тариф');
    expect(scheduledTaskTierText({ service_tier: null, requested_service_tier: null, fast_tier_dropped_for_quota: true })).toBe(
      'Быстрый снят из-за квоты',
    );
    expect(scheduledTaskTierText({ service_tier: null, requested_service_tier: 'priority' })).toBe('Fast запрошен, но не применён');
    expect(scheduledTaskTierText({ service_tier: null, requested_service_tier: null })).toBe('Обычный тариф');
    expect(scheduledTaskTierText({})).toBe('Тариф не записан');
  });

  it('запуск задачи без свежего показания квоты — не «из-за квоты» (r1109, пп. 5–6)', () => {
    const dropped = { service_tier: null, requested_service_tier: null, fast_tier_dropped_for_quota: true };
    expect(scheduledTaskTierText({ ...dropped, fast_tier_dropped_reason: 'no_quota_reading' })).toBe(
      'Быстрый снят: квота неизвестна',
    );
    expect(scheduledTaskTierText({ ...dropped, fast_tier_dropped_reason: 'quota_ceiling' })).toBe('Быстрый снят из-за квоты');
    // Codex оставил Fast, хотя бот его не просил: это видно, причина не важна.
    expect(
      scheduledTaskTierText({ ...dropped, service_tier: 'priority', fast_tier_dropped_reason: 'no_quota_reading' }),
    ).toBe('Fast применён, хотя не запрошен');
    expect(
      humanizeEvent({
        type: 'scheduled_task_finished',
        created_at: Date.now(),
        payload_json: JSON.stringify({ ...dropped, fast_tier_dropped_reason: 'no_quota_reading', task_title: 'Утренний разбор', status: 'success' }),
      }).text,
    ).toMatch(/: быстрый снят: квота неизвестна$/);
  });
});

describe('время и числа', () => {
  it('formatAgo — по-русски и без отрицательных значений', () => {
    const now = Date.now();
    expect(formatAgo(now - 30_000, now)).toBe('только что');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5 мин назад');
    expect(formatAgo(now + 60_000, now)).toBe('только что');
    expect(formatAgo(now - 26 * 3600_000, now)).toBe('1 дн назад');
  });

  it('formatDuration и formatCredits округляют по-человечески', () => {
    expect(formatDuration(45_000)).toBe('45 сек');
    expect(formatDuration(3 * 60_000 + 5000)).toBe('3 мин 5 с');
    expect(formatCredits(184_300)).toBe('184,3 тыс.');
    expect(formatCredits(950)).toBe('950');
    expect(formatCredits(Number.NaN)).toBe('0');
  });
});

describe('статусы и расписания', () => {
  it('статусы задач переведены', () => {
    expect(humanizeTaskStatus('active')).toBe('активна');
    expect(humanizeTaskStatus('paused')).toBe('на паузе');
    expect(humanizeTaskStatus('cancelled')).toBe('отменена');
  });

  it('расписания описаны словами', () => {
    expect(humanizeSchedule('interval', String(30 * 60_000))).toBe(
      'каждые 30 мин 0 с',
    );
    expect(humanizeSchedule('once', 'not-a-date')).toBe('один раз');
    expect(humanizeSchedule('cron', '0 9 * * 1')).toBe('по пн в 09:00');
  });

  it('частые cron-шаблоны русифицируются, остальное — сырым фолбэком', () => {
    expect(humanizeCron('0 9 * * *')).toBe('ежедневно в 09:00');
    expect(humanizeCron('30 18 * * *')).toBe('ежедневно в 18:30');
    expect(humanizeCron('0 9 * * 1-5')).toBe('по будням в 09:00');
    expect(humanizeCron('0 10 * * 0,6')).toBe('по вс, сб в 10:00');
    expect(humanizeCron('0 10 * * 7')).toBe('по вс в 10:00');
    expect(humanizeCron('*/5 * * * *')).toBe('каждые 5 мин');
    expect(humanizeCron('0 * * * *')).toBe('каждый час');
    expect(humanizeCron('15 * * * *')).toBe('каждый час в :15');
    // нестандартное — не выдумываем, показываем как есть
    expect(humanizeCron('0 9 1 * *')).toBe('по расписанию (0 9 1 * *)');
    expect(humanizeCron('0 9 * 2 *')).toBe('по расписанию (0 9 * 2 *)');
    expect(humanizeCron('мусор')).toBe('по расписанию (мусор)');
  });
});

describe('parseLogLine', () => {
  it('парсит старую строку без даты и срезает ANSI-коды', () => {
    // Keep supporting archived log lines without a date.
    const raw =
      '[18:15:49.641] \x1b[32mINFO\x1b[39m (19699): \x1b[36mTelegram message sent\x1b[39m';
    expect(parseLogLine(raw)).toEqual({
      date: null,
      time: '18:15:49',
      level: 'INFO',
      pid: 19699,
      text: 'Telegram message sent',
    });
  });

  it('парсит новую строку с датой', () => {
    const raw = '[2026-07-27 10:19:56.746] INFO (63280): Telegram message sent';
    expect(parseLogLine(raw)).toEqual({
      date: '2026-07-27',
      time: '10:19:56',
      level: 'INFO',
      pid: 63280,
      text: 'Telegram message sent',
    });
  });

  it('парсит новую строку с датой и ANSI (запуск в терминале)', () => {
    const raw =
      '[2026-07-27 10:19:56.746] \x1b[31mERROR\x1b[39m (63280): \x1b[36mSandbox failed\x1b[39m';
    expect(parseLogLine(raw)).toMatchObject({
      date: '2026-07-27',
      level: 'ERROR',
      pid: 63280,
      text: 'Sandbox failed',
    });
  });

  it('возвращает null для продолжений и мусора', () => {
    expect(parseLogLine('    jid: "tg:1"')).toBeNull();
    expect(parseLogLine('')).toBeNull();
    // Не должен принимать дату без времени.
    expect(parseLogLine('[2026-07-27] INFO (1): x')).toBeNull();
  });
});
