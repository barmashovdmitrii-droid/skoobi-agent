import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_GOOGLE_CALENDAR_ID,
  DEFAULT_GOOGLE_CALENDAR_SCOPE,
  DEFAULT_GOOGLE_CALENDAR_TIMEZONE,
  GoogleCalendarAdapter,
  type GoogleCalendarConfig,
  loadGoogleCalendarConfig,
  normalizeReminderSummary,
  shouldCreateCalendarEventForTask,
  stripReminderLead,
} from './calendar-adapter.js';

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

const tempDirectories = new Set<string>();
const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'calendar-test',
  private_key_id: 'key-id',
  private_key: [
    '-----BEGIN ',
    'PRIVATE KEY-----\nTEST\n-----END ',
    'PRIVATE KEY-----\n',
  ].join(''),
  client_email: 'calendar-robot@example.iam.gserviceaccount.com',
  client_id: '1234567890',
});

function writeServiceAccountFile(
  contents = SERVICE_ACCOUNT_JSON,
  mode = 0o600,
): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'skoobi-calendar-key-'),
  );
  tempDirectories.add(directory);
  const keyFile = path.join(directory, 'service-account.json');
  fs.writeFileSync(keyFile, contents, { mode });
  // Preserve the requested security boundary under the service's umask 077,
  // especially for the deliberately permissive 0644 fixture.
  fs.chmodSync(keyFile, mode);
  return keyFile;
}

function calendarConfig(keyFile: string): GoogleCalendarConfig {
  return {
    enabled: true,
    calendarId: 'calendar@example.com',
    keyFile,
    scope: DEFAULT_GOOGLE_CALENDAR_SCOPE,
    timeZone: DEFAULT_GOOGLE_CALENDAR_TIMEZONE,
    eventDurationMinutes: 15,
    reminderMinutes: 0,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories.clear();
});

describe('Google Calendar adapter config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stays disabled when no local key file is configured', () => {
    const config = loadGoogleCalendarConfig({});

    expect(config.enabled).toBe(false);
    expect(config.calendarId).toBe(DEFAULT_GOOGLE_CALENDAR_ID);
    expect(config.scope).toBe(DEFAULT_GOOGLE_CALENDAR_SCOPE);
    expect(config.timeZone).toBe(DEFAULT_GOOGLE_CALENDAR_TIMEZONE);
  });

  it('does not auto-enable from a key path without an explicit calendar ID', () => {
    const config = loadGoogleCalendarConfig({
      SKOOBI_GOOGLE_CALENDAR_KEY_FILE:
        '/Users/example/.claudeclaw-secrets/calendar-robot.json',
    });

    expect(config.enabled).toBe(false);
    expect(config.calendarId).toBe('');
  });

  it('rejects an invalid explicit calendar ID instead of selecting a fallback', () => {
    const config = loadGoogleCalendarConfig({
      SKOOBI_GOOGLE_CALENDAR_ENABLED: 'true',
      SKOOBI_GOOGLE_CALENDAR_KEY_FILE:
        '/Users/example/.claudeclaw-secrets/calendar-robot.json',
      SKOOBI_GOOGLE_CALENDAR_ID: 'https://calendar.example/private target',
    });

    expect(config.enabled).toBe(false);
    expect(config.calendarId).toBe('');
  });

  it('enables itself with a valid explicit calendar ID', () => {
    const config = loadGoogleCalendarConfig({
      SKOOBI_GOOGLE_CALENDAR_KEY_FILE:
        '/Users/example/.claudeclaw-secrets/calendar-robot.json',
      SKOOBI_GOOGLE_CALENDAR_ID: 'calendar@example.com',
      SKOOBI_GOOGLE_CALENDAR_TIMEZONE: 'Asia/Almaty',
      SKOOBI_GOOGLE_CALENDAR_REMINDER_MINUTES: '5',
    });

    expect(config.enabled).toBe(true);
    expect(config.keyFile).toBe(
      '/Users/example/.claudeclaw-secrets/calendar-robot.json',
    );
    expect(config.calendarId).toBe('calendar@example.com');
    expect(config.reminderMinutes).toBe(5);
  });

  it('preserves explicit primary only when the owner configured it', () => {
    const config = loadGoogleCalendarConfig({
      SKOOBI_GOOGLE_CALENDAR_KEY_FILE:
        '/Users/example/.claudeclaw-secrets/calendar-robot.json',
      SKOOBI_GOOGLE_CALENDAR_ID: 'primary',
    });

    expect(config.enabled).toBe(true);
    expect(config.calendarId).toBe('primary');
  });

  it('keeps a legitimate calendar email with a plus alias', () => {
    const config = loadGoogleCalendarConfig({
      SKOOBI_GOOGLE_CALENDAR_KEY_FILE:
        '/Users/example/.claudeclaw-secrets/calendar-robot.json',
      SKOOBI_GOOGLE_CALENDAR_ID: 'owner+reminders@example.com',
    });

    expect(config.enabled).toBe(true);
    expect(config.calendarId).toBe('owner+reminders@example.com');
  });
});

describe('Google Calendar service-account file boundary', () => {
  it('loads one bounded 0600 snapshot into credentials, never keyFile', () => {
    const keyFile = writeServiceAccountFile();
    const adapter = new GoogleCalendarAdapter(calendarConfig(keyFile));
    const auth = (
      adapter as unknown as {
        calendar: {
          context: {
            _options: {
              auth: {
                keyFilename?: string;
                jsonContent?: Record<string, unknown>;
              };
            };
          };
        };
      }
    ).calendar.context._options.auth;

    expect(auth.keyFilename).toBeUndefined();
    expect(auth.jsonContent).toMatchObject({
      type: 'service_account',
      client_email: 'calendar-robot@example.iam.gserviceaccount.com',
      private_key_id: 'key-id',
      project_id: 'calendar-test',
      client_id: '1234567890',
    });
  });

  it('rejects an invalid calendar ID even when constructed directly', () => {
    const keyFile = writeServiceAccountFile();
    expect(
      () =>
        new GoogleCalendarAdapter({
          ...calendarConfig(keyFile),
          calendarId: 'calendar id with spaces',
        }),
    ).toThrow('Google Calendar ID is not configured or is invalid.');
  });

  it('rejects symlinked, hard-linked, permissive, oversized, and malformed keys', () => {
    const target = writeServiceAccountFile();
    const symlink = `${target}.symlink`;
    fs.symlinkSync(target, symlink);

    const hardlinkTarget = writeServiceAccountFile();
    const hardlink = `${hardlinkTarget}.hardlink`;
    fs.linkSync(hardlinkTarget, hardlink);

    const permissive = writeServiceAccountFile(SERVICE_ACCOUNT_JSON, 0o644);
    const oversized = writeServiceAccountFile(
      JSON.stringify({
        type: 'service_account',
        client_email: 'calendar-robot@example.iam.gserviceaccount.com',
        private_key: 'x'.repeat(64 * 1024),
      }),
    );
    const malformed = writeServiceAccountFile('{"private_key":"TOP_SECRET"}');

    for (const keyFile of [
      symlink,
      hardlink,
      permissive,
      oversized,
      malformed,
    ]) {
      expect(() => new GoogleCalendarAdapter(calendarConfig(keyFile))).toThrow(
        'Google Calendar service-account key file is unsafe or unreadable.',
      );
    }
  });

  it('fails closed when the opened key inode changes during the read', () => {
    const keyFile = writeServiceAccountFile();
    const moved = `${keyFile}.opened`;
    const originalReadSync = fs.readSync;
    let replaced = false;
    const readSpy = vi.spyOn(fs, 'readSync').mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      if (!replaced) {
        replaced = true;
        fs.renameSync(keyFile, moved);
        fs.writeFileSync(keyFile, SERVICE_ACCOUNT_JSON, { mode: 0o600 });
      }
      return originalReadSync(fd, buffer, offset, length, position);
    }) as typeof fs.readSync);

    expect(() => new GoogleCalendarAdapter(calendarConfig(keyFile))).toThrow(
      'Google Calendar service-account key file is unsafe or unreadable.',
    );
    expect(replaced).toBe(true);
    readSpy.mockRestore();
  });
});

describe('Google Calendar reminder task detection', () => {
  it('mirrors user-facing once reminders', () => {
    expect(
      shouldCreateCalendarEventForTask({
        schedule_type: 'once',
        prompt: 'Напомни владельцу: в четверг в 10:00 списаться с коллегой',
      }),
    ).toBe(true);
  });

  it('mirrors a recurring reminder whose schedule has an exact RRULE', () => {
    expect(
      shouldCreateCalendarEventForTask({
        schedule_type: 'cron',
        schedule_value: '0 9 21 * *',
        prompt: 'Напомни оплатить интернет',
      }),
    ).toBe(true);
    expect(
      shouldCreateCalendarEventForTask({
        schedule_type: 'interval',
        schedule_value: String(86_400_000),
        prompt: 'Напомни про зарядку',
      }),
    ).toBe(true);
  });

  it('recognises the noun form of reminder', () => {
    // Regression: the pattern used to be built from the verb stem «напомн-»
    // with noun endings pinned to it, so it tested for «напомнание» and never
    // matched «напоминание», which prevented calendar event creation.
    for (const prompt of [
      'Напоминание для администратора. 12 сентября тестовая проверка',
      'напоминания по оплате',
      'НАПОМНИ ПРО ОПЛАТУ',
      'Remind me tomorrow',
    ]) {
      expect(
        shouldCreateCalendarEventForTask({
          schedule_type: 'once',
          schedule_value: '2026-09-10T12:00:00',
          prompt,
        }),
      ).toBe(true);
    }
  });

  it('leaves non-reminder recurring work out of the calendar', () => {
    expect(
      shouldCreateCalendarEventForTask({
        schedule_type: 'cron',
        schedule_value: '0 10 * * *',
        prompt: 'Ежедневная утренняя сводка для пользователя по активности',
      }),
    ).toBe(false);
  });

  it('skips a recurring schedule with no exact RRULE, even when asked', () => {
    // A five-minute cron has no honest calendar shape; asking explicitly must
    // not produce an event that fires at the wrong times.
    expect(
      shouldCreateCalendarEventForTask(
        {
          schedule_type: 'cron',
          schedule_value: '*/5 * * * *',
          prompt: 'Напомни',
        },
        true,
      ),
    ).toBe(false);
    expect(
      shouldCreateCalendarEventForTask({
        schedule_type: 'cron',
        prompt: 'Напомни каждый день',
      }),
    ).toBe(false);
  });

  it('skips internal tasks unless explicitly requested', () => {
    expect(
      shouldCreateCalendarEventForTask({
        schedule_type: 'once',
        prompt: '<internal>Проверить сервис',
      }),
    ).toBe(false);
    expect(
      shouldCreateCalendarEventForTask(
        {
          schedule_type: 'once',
          prompt: 'Проверить сервис',
        },
        true,
      ),
    ).toBe(true);
  });

  it('lets IPC explicitly opt out', () => {
    expect(
      shouldCreateCalendarEventForTask(
        {
          schedule_type: 'once',
          prompt: 'Напомни про оплату',
        },
        false,
      ),
    ).toBe(false);
  });
});

describe('normalizeReminderSummary', () => {
  it('keeps calendar titles compact', () => {
    expect(normalizeReminderSummary('Напомни владельцу: купить молоко')).toBe(
      'купить молоко',
    );
  });

  it('titles the event with the reminder, not the instruction to the bot', () => {
    expect(
      normalizeReminderSummary(
        'Всегда отправляй владельцу одно короткое напоминание на русском: ' +
          '«Сегодня закончился тестовый доступ. ' +
          'Напомни продлить доступ». Не добавляй технических подробностей.',
      ),
    ).toBe(
      'Сегодня закончился тестовый доступ. Напомни продлить доступ',
    );
  });

  it('falls back to the prompt when nothing is quoted', () => {
    expect(normalizeReminderSummary('Напомни: оплатить интернет')).toBe(
      'оплатить интернет',
    );
    expect(normalizeReminderSummary('«ок»')).toBe('«ок»');
  });
});

describe('stripReminderLead', () => {
  it('drops the «напомни» lead and the internal note, keeps quotes, never bounds', () => {
    const long = `Напомни мне: ${'оплатить счёт «Связь» '.repeat(20).trim()}`;
    expect(stripReminderLead(long)).toBe('оплатить счёт «Связь» '.repeat(20).trim());
    expect(stripReminderLead('Напомни владельцу:  забрать\n ключи <internal>x</internal>')).toBe(
      'забрать ключи',
    );
    expect(stripReminderLead('Напомни: ')).toBe('');
    expect(normalizeReminderSummary('Напомни: ')).toBe('Skoobi reminder');
    expect(normalizeReminderSummary('Напомни: ' + 'оплатить счёт '.repeat(20))).toHaveLength(120);
  });
});

describe('createReminderEvent', () => {
  function adapterWithCapturedInsert(timeZone?: string) {
    const keyFile = writeServiceAccountFile();
    const config = calendarConfig(keyFile);
    const adapter = new GoogleCalendarAdapter(
      timeZone ? { ...config, timeZone } : config,
    );
    const insert = vi.fn(async () => ({
      data: { id: 'event-1', htmlLink: 'https://calendar.example/e/1' },
    }));
    (
      adapter as unknown as {
        calendar: { events: { insert: typeof insert } };
      }
    ).calendar.events.insert = insert;
    return { adapter, insert };
  }

  const requestBody = (insert: ReturnType<typeof vi.fn>) =>
    insert.mock.calls[0][0].requestBody;

  it('sends the recurrence rule and the first occurrence as the start', async () => {
    const { adapter, insert } = adapterWithCapturedInsert();

    await adapter.createReminderEvent({
      taskId: 'task-1784636911585-l76dhg',
      prompt: 'Напомни оплатить интернет',
      // What the scheduler stores in next_run: an absolute instant.
      scheduleValue: '2026-08-21T04:00:00.000Z',
      recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=21'],
    });

    const body = requestBody(insert);
    expect(body.recurrence).toEqual(['RRULE:FREQ=MONTHLY;BYMONTHDAY=21']);
    expect(body.start).toEqual({
      dateTime: '2026-08-21T09:00:00',
      timeZone: 'Asia/Almaty',
    });
    expect(body.end).toEqual({
      dateTime: '2026-08-21T09:15:00',
      timeZone: 'Asia/Almaty',
    });
  });

  it('resolves an absolute instant in the calendar zone, not the host zone', async () => {
    // The host running these tests sits in Asia/Almaty (UTC+5). A calendar
    // configured for Europe/Moscow (UTC+3) must yield 07:00, not 09:00 — which
    // is what reading the Date local getters would have produced.
    const { adapter, insert } = adapterWithCapturedInsert('Europe/Moscow');

    await adapter.createReminderEvent({
      taskId: 'task-tz',
      prompt: 'Напоминание',
      scheduleValue: '2026-08-21T04:00:00.000Z',
    });

    expect(requestBody(insert).start).toEqual({
      dateTime: '2026-08-21T07:00:00',
      timeZone: 'Europe/Moscow',
    });
  });

  it('keeps a bare wall-clock time verbatim and omits recurrence', async () => {
    const { adapter, insert } = adapterWithCapturedInsert();

    await adapter.createReminderEvent({
      taskId: 'task-calendar-wall-clock-fixture',
      prompt: 'Напоминание для администратора. 12 сентября тестовая проверка',
      scheduleValue: '2026-09-10T12:00:00',
    });

    const body = requestBody(insert);
    expect(body.start.dateTime).toBe('2026-09-10T12:00:00');
    expect(body.end.dateTime).toBe('2026-09-10T12:15:00');
    expect(body.recurrence).toBeUndefined();
  });

  it('rolls the end time over midnight', async () => {
    const { adapter, insert } = adapterWithCapturedInsert();

    await adapter.createReminderEvent({
      taskId: 'task-late',
      prompt: 'Напомни',
      scheduleValue: '2026-09-10T23:55:00',
    });

    expect(requestBody(insert).end.dateTime).toBe('2026-09-11T00:10:00');
  });

  it('rejects a start time it cannot read', async () => {
    const { adapter } = adapterWithCapturedInsert();

    await expect(
      adapter.createReminderEvent({
        taskId: 'task-bad',
        prompt: 'Напомни',
        scheduleValue: 'не дата',
      }),
    ).rejects.toThrow('Invalid calendar event start time');
  });
});
