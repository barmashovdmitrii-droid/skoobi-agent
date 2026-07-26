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
        chatName: 'Артём',
      }).text;
      expect(text).toBe('Не удалось доставить ответ: Артём');
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
        chatName: 'Артём',
      }).text,
    ).toBe('Не удалось доставить голосовой ответ: Артём');
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
      chatName: 'Илья',
    });
    expect(e.text).toContain('полный агент');
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
  it('парсит pino-pretty строку и срезает ANSI-коды', () => {
    const raw =
      '[18:15:49.641] \x1b[32mINFO\x1b[39m (19699): \x1b[36mTelegram message sent\x1b[39m';
    expect(parseLogLine(raw)).toEqual({
      time: '18:15:49',
      level: 'INFO',
      pid: 19699,
      text: 'Telegram message sent',
    });
  });

  it('возвращает null для продолжений и мусора', () => {
    expect(parseLogLine('    jid: "tg:1"')).toBeNull();
    expect(parseLogLine('')).toBeNull();
  });
});
