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

  it('skips recurring and internal tasks unless explicitly requested', () => {
    expect(
      shouldCreateCalendarEventForTask({
        schedule_type: 'cron',
        prompt: 'Напомни каждый день',
      }),
    ).toBe(false);
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
});
