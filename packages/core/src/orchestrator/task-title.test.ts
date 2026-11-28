import { describe, expect, it } from 'vitest';

import {
  autoTaskTitle,
  classifyTaskKind,
  isBackgroundTask,
  normalizeTaskTitle,
  taskDisplayTitle,
  taskTelemetryTitle,
} from './task-title.js';

const TZ = 'Asia/Almaty';

describe('название плановой задачи (W25)', () => {
  it('название от модели: без тегов, в одну строку, не длиннее 60 символов', () => {
    expect(
      normalizeTaskTitle('  Слежка\n за  обновлением <b>Атлас2</b> '),
    ).toBe('Слежка за обновлением Атлас2');
    expect(normalizeTaskTitle('<internal>')).toBeNull();
    expect(normalizeTaskTitle(42)).toBeNull();
    const long = normalizeTaskTitle('Очень '.repeat(30))!;
    expect(Array.from(long).length).toBeLessThanOrEqual(60);
    expect(long.endsWith('…')).toBe(true);
  });

  it('задание с <internal> без названия — «Фоновая задача от ДД.ММ ЧЧ:ММ», без служебного текста', () => {
    const title = autoTaskTitle(
      {
        prompt:
          '<internal>ВАЖНАЯ ПОПРАВКА ВЛАДЕЛЬЦА12345: контроль только на одни сутки.',
        created_at: '2026-11-06T09:44:00.000Z',
      },
      TZ,
    );
    expect(title).toBe('Фоновая задача от 06.11 14:44');
    expect(title).not.toMatch(/internal|ПОПРАВКА|12345/);
  });

  it('обычное задание: первые слова без «ВАЖНАЯ ПОПРАВКА…» и номеров сообщений', () => {
    expect(
      autoTaskTitle(
        {
          prompt:
            'ВАЖНАЯ ПОПРАВКА ВЛАДЕЛЬЦА12345: контроль только на одни сутки, потом отключись',
          created_at: '2026-11-06T09:44:00.000Z',
        },
        TZ,
      ),
    ).toBe('Контроль только на одни сутки, потом отключись');
    expect(
      autoTaskTitle(
        {
          prompt: 'Проверь ответ на сообщение 54321 и напиши итог',
          created_at: '2026-11-06T09:44:00.000Z',
        },
        TZ,
      ),
    ).toBe('Проверь ответ на сообщение и напиши итог');
    expect(
      autoTaskTitle(
        {
          prompt: 'Контроль и завершение обновления Атлас2 на маке',
          created_at: '2026-11-05T09:12:00.000Z',
        },
        TZ,
      ),
    ).toBe('Контроль и завершение обновления Атлас2 на маке');
  });

  it('пустое задание — запасное название с датой', () => {
    expect(
      autoTaskTitle({ prompt: '   ', created_at: '2026-11-05T09:12:26Z' }, TZ),
    ).toBe('Задача от 05.11 14:12');
  });

  it('сохранённое название важнее придуманного хостом', () => {
    expect(
      taskDisplayTitle(
        {
          prompt: '<internal>Продолжи прямо разрешённую владельцем правку',
          created_at: '2026-11-03T14:57:42Z',
          title: 'Правка лендинга',
        },
        TZ,
      ),
    ).toBe('Правка лендинга');
    expect(
      taskDisplayTitle(
        {
          prompt: '<internal>Продолжи прямо разрешённую владельцем правку',
          created_at: '2026-11-03T14:57:42Z',
          title: null,
        },
        TZ,
      ),
    ).toBe('Фоновая задача от 03.11 19:57');
  });
});

describe('название задачи для журнала событий и сторожа (r1109, п. 6)', () => {
  it('сохранённое название — как есть; длинные цифры (телефон) скрыты до последних 4', () => {
    expect(
      taskTelemetryTitle(
        { prompt: 'секретный текст задания', created_at: '2026-11-05T09:12:26Z', title: 'Сводка продаж' },
        TZ,
      ),
    ).toBe('Сводка продаж');
    expect(
      taskTelemetryTitle(
        { prompt: 'x', created_at: '2026-11-05T09:12:26Z', title: 'Позвонить +7 000 111 22 33 утром' },
        TZ,
      ),
    ).toBe('Позвонить …2233 утром');
  });

  it('даты и диапазоны дней не принимаются за телефон; телефоны по-прежнему скрыты (ревью r1109)', () => {
    const title = (text: string) =>
      taskTelemetryTitle({ prompt: 'x', created_at: '2026-11-05T09:12:26Z', title: text }, TZ);
    // Раньше: «Сводка за …1109», «Бэкап …0923:36», «Обзор …1113 ноября».
    expect(title('Сводка за 2026-11-09')).toBe('Сводка за 2026-11-09');
    expect(title('Бэкап 2026-11-09 23:36')).toBe('Бэкап 2026-11-09 23:36');
    expect(title('Отчёт 10-11-2026')).toBe('Отчёт 10-11-2026');
    expect(title('Обзор 01-07 11-13 ноября')).toBe('Обзор 01-07 11-13 ноября');
    expect(title('С 2026-11-09 по 2026-11-15')).toBe('С 2026-11-09 по 2026-11-15');
    // Номера в любой записи — до последних 4 цифр, и рядом с датой тоже.
    expect(title('Позвонить 8-000-111-22-33')).toBe('Позвонить …2233');
    expect(title('Позвонить 000-111-22-33')).toBe('Позвонить …2233');
    expect(title('Позвонить 8 (0000) 11-22-33')).toBe('Позвонить …2233');
    expect(title('Позвонить 80001112233')).toBe('Позвонить …2233');
    expect(title('Тел 0000-11-22-33')).toBe('Тел …2233');
    expect(title('Позвонить 8 000 111 22 33 в 2026-11-09')).toBe('Позвонить …2233 в 2026-11-09');
    expect(title('Номер +7-2019-12-12')).toBe('Номер …1212');
  });

  it('без названия — ни слова из текста задания, только вид и дата', () => {
    const reminder = taskTelemetryTitle(
      { prompt: 'Напомни бухгалтеру про отчёт по складу', created_at: '2026-11-05T09:12:26Z' },
      TZ,
    );
    expect(reminder).toBe('Задача от 05.11 14:12');
    expect(reminder).not.toMatch(/бухгалтер|отчёт|склад/);
    expect(
      taskTelemetryTitle(
        { prompt: '<internal>Проверь почту бухгалтера', created_at: '2026-11-05T09:12:26Z', title: null },
        TZ,
      ),
    ).toBe('Фоновая задача от 05.11 14:12');
    expect(
      taskTelemetryTitle(
        { prompt: 'обычный текст', created_at: '2026-11-05T09:12:26Z', task_kind: 'background' },
        TZ,
      ),
    ).toBe('Фоновая задача от 05.11 14:12');
    expect(
      taskTelemetryTitle({ prompt: 'обычный текст', created_at: 'не дата' }, TZ),
    ).toBe('Задача');
  });
});

describe('фон или напоминание (W25)', () => {
  it('при создании: <internal> или calendar_event=false — фон, иначе напоминание', () => {
    expect(classifyTaskKind({ prompt: '<internal>Проверь сборку' })).toBe(
      'background',
    );
    expect(
      classifyTaskKind({ prompt: 'Проверь сборку', calendarEvent: false }),
    ).toBe('background');
    expect(classifyTaskKind({ prompt: 'Напомни оплатить интернет' })).toBe(
      'reminder',
    );
    expect(
      classifyTaskKind({ prompt: 'Напомни оплатить', calendarEvent: true }),
    ).toBe('reminder');
  });

  it('старые строки без признака — фон только по <internal>; при сомнении это напоминание', () => {
    expect(isBackgroundTask({ prompt: '<internal>x', task_kind: null })).toBe(
      true,
    );
    expect(isBackgroundTask({ prompt: 'Напомни про оплату' })).toBe(false);
    expect(
      isBackgroundTask({ prompt: '<internal>x', task_kind: 'reminder' }),
    ).toBe(false);
    expect(
      isBackgroundTask({ prompt: 'Слежка', task_kind: 'background' }),
    ).toBe(true);
  });
});
