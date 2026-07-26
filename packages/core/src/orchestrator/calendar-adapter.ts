import fs from 'fs';

import { calendar_v3, google } from 'googleapis';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import type { ScheduledTask } from './types.js';

// Deliberately empty: a service-account key must never silently grant writes
// to whichever calendar Google happens to treat as "primary".
export const DEFAULT_GOOGLE_CALENDAR_ID = '';
export const DEFAULT_GOOGLE_CALENDAR_SCOPE =
  'https://www.googleapis.com/auth/calendar.events';
export const DEFAULT_GOOGLE_CALENDAR_TIMEZONE = 'Asia/Almaty';

const DEFAULT_EVENT_DURATION_MINUTES = 15;
const DEFAULT_REMINDER_MINUTES = 0;
const MAX_SUMMARY_LENGTH = 120;
const MAX_GOOGLE_CALENDAR_KEY_FILE_BYTES = 64 * 1024;
const GOOGLE_CALENDAR_ID_RE = /^[A-Za-z0-9.!#$%&'*+=?^_`{|}~@-]{1,256}$/;

interface GoogleServiceAccountCredentials {
  type: 'service_account';
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
  client_id?: string;
}

/**
 * Load one bounded service-account JSON snapshot from the already-open inode.
 * The Google auth library must never reopen the configured pathname itself:
 * its keyFile path follows symlinks and has no size or permission boundary.
 */
function readGoogleServiceAccountCredentials(
  keyFile: string,
): GoogleServiceAccountCredentials {
  let fd: number | null = null;
  let buffer: Buffer | null = null;
  try {
    fd = fs.openSync(
      keyFile,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > MAX_GOOGLE_CALENDAR_KEY_FILE_BYTES ||
      (before.mode & 0o777) !== 0o600
    ) {
      throw new Error('unsafe service-account key metadata');
    }

    buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (count <= 0) break;
      offset += count;
    }
    const probe = Buffer.allocUnsafe(1);
    const extra = fs.readSync(fd, probe, 0, 1, null);
    const after = fs.fstatSync(fd);
    if (
      offset !== before.size ||
      extra !== 0 ||
      !after.isFile() ||
      after.nlink !== 1 ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      (after.mode & 0o777) !== 0o600
    ) {
      throw new Error('service-account key changed while reading');
    }

    const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('invalid service-account key JSON');
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.type !== 'service_account' ||
      typeof record.client_email !== 'string' ||
      !record.client_email ||
      record.client_email.length > 512 ||
      typeof record.private_key !== 'string' ||
      !record.private_key ||
      Buffer.byteLength(record.private_key, 'utf8') >
        MAX_GOOGLE_CALENDAR_KEY_FILE_BYTES
    ) {
      throw new Error('invalid service-account key fields');
    }

    const credentials: GoogleServiceAccountCredentials = {
      type: 'service_account',
      client_email: record.client_email,
      private_key: record.private_key,
    };
    for (const key of ['private_key_id', 'project_id', 'client_id'] as const) {
      const value = record[key];
      if (typeof value === 'string' && value.length <= 512) {
        credentials[key] = value;
      }
    }
    return credentials;
  } catch {
    // Do not include the configured path, JSON contents, or parser/OS detail in
    // an error that may be logged by optional-integration startup code.
    throw new Error(
      'Google Calendar service-account key file is unsafe or unreadable.',
    );
  } finally {
    buffer?.fill(0);
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort descriptor cleanup after a primary validation failure.
      }
    }
  }
}

export interface GoogleCalendarConfig {
  enabled: boolean;
  calendarId: string;
  keyFile?: string;
  scope: string;
  timeZone: string;
  eventDurationMinutes: number;
  reminderMinutes: number;
}

export interface CalendarEventRecord {
  id: string;
  summary: string | null;
  description: string | null;
  start: string | null;
  end: string | null;
  htmlLink: string | null;
  status: string | null;
}

export interface CreateReminderEventInput {
  taskId: string;
  prompt: string;
  scheduleValue: string;
  calendarId?: string;
  timeZone?: string;
  reminderMinutes?: number;
}

export interface ListCalendarEventsInput {
  timeMin?: string;
  timeMax?: string;
  query?: string;
  maxResults?: number;
  calendarId?: string;
}

export interface CalendarAdapter {
  readonly config: GoogleCalendarConfig;
  createReminderEvent(
    input: CreateReminderEventInput,
  ): Promise<CalendarEventRecord>;
  listEvents(input?: ListCalendarEventsInput): Promise<CalendarEventRecord[]>;
  deleteEvent(eventId: string, calendarId?: string): Promise<void>;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function configuredGoogleCalendarId(value: string | undefined): string {
  const calendarId = String(value || '').trim();
  return GOOGLE_CALENDAR_ID_RE.test(calendarId) ? calendarId : '';
}

export function loadGoogleCalendarConfig(
  env: Record<string, string | undefined> = process.env,
): GoogleCalendarConfig {
  const fileEnv = readEnvFile([
    'SKOOBI_GOOGLE_CALENDAR_ENABLED',
    'SKOOBI_GOOGLE_CALENDAR_ID',
    'SKOOBI_GOOGLE_CALENDAR_KEY_FILE',
    'SKOOBI_GOOGLE_CALENDAR_SCOPE',
    'SKOOBI_GOOGLE_CALENDAR_TIMEZONE',
    'SKOOBI_GOOGLE_CALENDAR_EVENT_DURATION_MINUTES',
    'SKOOBI_GOOGLE_CALENDAR_REMINDER_MINUTES',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ]);

  const get = (key: string): string | undefined => env[key] || fileEnv[key];
  const keyFile =
    get('SKOOBI_GOOGLE_CALENDAR_KEY_FILE') ||
    get('GOOGLE_APPLICATION_CREDENTIALS');
  const calendarId = configuredGoogleCalendarId(
    get('SKOOBI_GOOGLE_CALENDAR_ID'),
  );
  const explicitEnabled = get('SKOOBI_GOOGLE_CALENDAR_ENABLED');
  const requestedEnabled =
    explicitEnabled === undefined || explicitEnabled === ''
      ? Boolean(keyFile)
      : /^(1|true|yes|on)$/i.test(explicitEnabled);
  // A key file alone is not authority to select a Calendar write target.
  const enabled = requestedEnabled && Boolean(calendarId);

  return {
    enabled,
    calendarId,
    keyFile,
    scope: get('SKOOBI_GOOGLE_CALENDAR_SCOPE') || DEFAULT_GOOGLE_CALENDAR_SCOPE,
    timeZone:
      get('SKOOBI_GOOGLE_CALENDAR_TIMEZONE') ||
      DEFAULT_GOOGLE_CALENDAR_TIMEZONE,
    eventDurationMinutes: parsePositiveInt(
      get('SKOOBI_GOOGLE_CALENDAR_EVENT_DURATION_MINUTES'),
      DEFAULT_EVENT_DURATION_MINUTES,
    ),
    reminderMinutes: parseNonNegativeInt(
      get('SKOOBI_GOOGLE_CALENDAR_REMINDER_MINUTES'),
      DEFAULT_REMINDER_MINUTES,
    ),
  };
}

function addMinutesToLocalDateTime(value: string, minutes: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid calendar event start time: ${value}`);
  }
  const next = new Date(date.getTime() + minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    next.getFullYear(),
    '-',
    pad(next.getMonth() + 1),
    '-',
    pad(next.getDate()),
    'T',
    pad(next.getHours()),
    ':',
    pad(next.getMinutes()),
    ':',
    pad(next.getSeconds()),
  ].join('');
}

export function normalizeReminderSummary(prompt: string): string {
  const cleaned = prompt
    .replace(/<internal>.*$/is, '')
    .replace(/^\s*(?:напомни(?:ть)?|напоминание(?:\s+для\s+\S+)?)[\s:.-]+/i, '')
    .replace(
      /^\s*(?:владельцу|владельца|мне|меня|пользователю|для\s+\S+)[\s:.-]+/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  const summary = cleaned || 'Skoobi reminder';
  return summary.length > MAX_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`
    : summary;
}

export function shouldCreateCalendarEventForTask(
  task: Pick<ScheduledTask, 'schedule_type' | 'prompt'>,
  requested?: boolean,
): boolean {
  if (requested === false) return false;
  if (task.schedule_type !== 'once') return false;
  const prompt = String(task.prompt || '').trim();
  if (!prompt || /^<internal>/i.test(prompt)) return false;
  if (requested === true) return true;
  return /(?:напомн(?:и|ить|ание|ания|анию|анием)?|remind(?:er)?)/i.test(
    prompt,
  );
}

function eventTime(
  value: string,
  timeZone: string,
): calendar_v3.Schema$EventDateTime {
  return {
    dateTime: value,
    timeZone,
  };
}

function toEventRecord(event: calendar_v3.Schema$Event): CalendarEventRecord {
  return {
    id: event.id || '',
    summary: event.summary || null,
    description: event.description || null,
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    htmlLink: event.htmlLink || null,
    status: event.status || null,
  };
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  readonly config: GoogleCalendarConfig;

  private readonly calendar: calendar_v3.Calendar;

  constructor(config: GoogleCalendarConfig) {
    if (!config.enabled) {
      throw new Error('Google Calendar adapter is disabled');
    }
    if (!configuredGoogleCalendarId(config.calendarId)) {
      throw new Error(
        'Google Calendar ID is not configured or is invalid. Set SKOOBI_GOOGLE_CALENDAR_ID explicitly.',
      );
    }
    if (!config.keyFile) {
      throw new Error(
        'Google Calendar key file is not configured. Set SKOOBI_GOOGLE_CALENDAR_KEY_FILE or GOOGLE_APPLICATION_CREDENTIALS.',
      );
    }

    this.config = config;
    const credentials = readGoogleServiceAccountCredentials(config.keyFile);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [config.scope],
    });
    this.calendar = google.calendar({ version: 'v3', auth });
  }

  async createReminderEvent(
    input: CreateReminderEventInput,
  ): Promise<CalendarEventRecord> {
    const calendarId = input.calendarId || this.config.calendarId;
    const timeZone = input.timeZone || this.config.timeZone;
    const reminderMinutes =
      input.reminderMinutes ?? this.config.reminderMinutes;
    const endValue = addMinutesToLocalDateTime(
      input.scheduleValue,
      this.config.eventDurationMinutes,
    );

    const response = await this.calendar.events.insert({
      calendarId,
      requestBody: {
        summary: normalizeReminderSummary(input.prompt),
        description: [
          'Created by Skoobi.',
          `Task ID: ${input.taskId}`,
          '',
          input.prompt,
        ].join('\n'),
        start: eventTime(input.scheduleValue, timeZone),
        end: eventTime(endValue, timeZone),
        reminders: {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: reminderMinutes }],
        },
        extendedProperties: {
          private: {
            skoobiTaskId: input.taskId,
          },
        },
      },
    });

    return toEventRecord(response.data);
  }

  async listEvents(
    input: ListCalendarEventsInput = {},
  ): Promise<CalendarEventRecord[]> {
    const response = await this.calendar.events.list({
      calendarId: input.calendarId || this.config.calendarId,
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      q: input.query,
      maxResults: input.maxResults || 20,
      singleEvents: true,
      orderBy: 'startTime',
    });
    return (response.data.items || []).map(toEventRecord);
  }

  async deleteEvent(eventId: string, calendarId?: string): Promise<void> {
    await this.calendar.events.delete({
      calendarId: calendarId || this.config.calendarId,
      eventId,
    });
  }
}

export function createGoogleCalendarAdapterFromEnv(): CalendarAdapter | null {
  const config = loadGoogleCalendarConfig();
  if (!config.enabled) return null;
  try {
    return new GoogleCalendarAdapter(config);
  } catch (err) {
    logger.warn({ err }, 'Google Calendar adapter unavailable');
    return null;
  }
}
