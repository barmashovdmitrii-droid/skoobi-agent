import fs from 'fs';

import { calendar_v3, google } from 'googleapis';

import { calendarRecurrenceForTask } from './calendar-recurrence.js';
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
  /**
   * Start of the FIRST occurrence: a bare wall-clock string for a one-off task,
   * or the task's absolute `next_run` for a recurring one.
   */
  scheduleValue: string;
  calendarId?: string;
  timeZone?: string;
  reminderMinutes?: number;
  /** RFC 5545 lines (`RRULE:FREQ=...`) turning this into a repeating event. */
  recurrence?: string[];
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

/** `YYYY-MM-DDTHH:MM[:SS]` with no zone — a wall-clock time in the calendar's zone. */
const NAIVE_LOCAL_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

const pad = (n: number) => String(n).padStart(2, '0');

function formatNaiveLocalDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): string {
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/**
 * Render an absolute instant as a wall-clock time in `timeZone`.
 *
 * Recurring tasks carry `next_run` as an absolute UTC timestamp, so the first
 * occurrence has to be expressed in the calendar's own zone. Doing this through
 * Intl rather than the Date local getters keeps the result correct on a host
 * whose system zone differs from the calendar's.
 */
function formatInstantInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    const value = Number.parseInt(found?.value || '', 10);
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid calendar event start time: ${date.toISOString()}`);
    }
    return value;
  };

  return formatNaiveLocalDateTime(
    field('year'),
    field('month'),
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
}

/**
 * Normalize a schedule value into a wall-clock start time for the calendar.
 *
 * A bare `2026-09-10T12:00:00` is already wall-clock and is kept verbatim; a
 * zoned or UTC timestamp (what `next_run` holds) is converted into `timeZone`.
 */
export function toCalendarLocalDateTime(
  value: string,
  timeZone: string,
): string {
  const naive = NAIVE_LOCAL_DATE_TIME.exec(String(value).trim());
  if (naive) {
    return formatNaiveLocalDateTime(
      Number(naive[1]),
      Number(naive[2]),
      Number(naive[3]),
      Number(naive[4]),
      Number(naive[5]),
      naive[6] ? Number(naive[6]) : 0,
    );
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid calendar event start time: ${value}`);
  }
  return formatInstantInTimeZone(date, timeZone);
}

/**
 * Advance a wall-clock time by whole minutes.
 *
 * The arithmetic runs on a UTC-constructed date purely so that the calendar
 * math never picks up the host's own zone; the value in and the value out are
 * both wall-clock in the calendar's zone.
 */
function addMinutesToLocalDateTime(value: string, minutes: number): string {
  const naive = NAIVE_LOCAL_DATE_TIME.exec(String(value).trim());
  if (!naive) {
    throw new Error(`Invalid calendar event start time: ${value}`);
  }
  const base = Date.UTC(
    Number(naive[1]),
    Number(naive[2]) - 1,
    Number(naive[3]),
    Number(naive[4]),
    Number(naive[5]),
    naive[6] ? Number(naive[6]) : 0,
  );
  const next = new Date(base + minutes * 60_000);
  return formatNaiveLocalDateTime(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    next.getUTCHours(),
    next.getUTCMinutes(),
    next.getUTCSeconds(),
  );
}


const QUOTED_MESSAGE = /«([^»]{3,})»/;


export function stripReminderLead(text: string): string {
  return String(text || '')
    .replace(/<internal>.*$/is, '')
    .replace(/^\s*(?:напомни(?:ть)?|напоминание(?:\s+для\s+\S+)?)[\s:.-]+/i, '')
    .replace(
      /^\s*(?:владельцу|владельца|мне|меня|пользователю|для\s+\S+)[\s:.-]+/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeReminderSummary(prompt: string): string {
  const withoutInternal = String(prompt || '').replace(/<internal>.*$/is, '');
  const quoted = QUOTED_MESSAGE.exec(withoutInternal);
  const summary =
    stripReminderLead(quoted ? quoted[1] : withoutInternal) || 'Skoobi reminder';
  return summary.length > MAX_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`
    : summary;
}

/**
 * Reminder wording, matched against an already-lowercased prompt.
 *
 * Two Russian stems, not one: `напомин-` carries the noun forms («напоминание»,
 * «напоминания»), `напомн-` the verb forms («напомни», «напомнить»). An earlier
 * single-stem pattern glued the noun endings onto the verb stem and so tested
 * for «напомнание», a word that does not exist and cannot match the noun.
 *
 * The trailing class is spelled out because `\w` and `\b` are ASCII-only in
 * JavaScript and never fire against Cyrillic; `ё` sits outside `а-я` and needs
 * its own mention. Lowercasing the prompt beforehand avoids relying on the `i`
 * flag's case folding for non-ASCII letters.
 */
const REMINDER_PROMPT_PATTERN = /напомин[а-яё]*|напомн[а-яё]*|remind/;

export function promptReadsAsReminder(prompt: string): boolean {
  return REMINDER_PROMPT_PATTERN.test(String(prompt || '').toLowerCase());
}

/**
 * Decide whether a scheduled task should be mirrored into the owner's calendar.
 *
 * Recurring tasks are mirrored as repeating events, but only when their cron or
 * interval schedule has an exact RRULE translation (see calendar-recurrence).
 * An untranslatable schedule is left out entirely rather than pinned to a
 * single arbitrary occurrence.
 */
export function shouldCreateCalendarEventForTask(
  task: Pick<ScheduledTask, 'schedule_type' | 'prompt'> & {
    schedule_value?: string;
  },
  requested?: boolean,
): boolean {
  if (requested === false) return false;
  if (calendarRecurrenceForTask(task).kind === 'unsupported') return false;
  const prompt = String(task.prompt || '').trim();
  if (!prompt || /^<internal>/i.test(prompt)) return false;
  if (requested === true) return true;
  return promptReadsAsReminder(prompt);
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
    const startValue = toCalendarLocalDateTime(input.scheduleValue, timeZone);
    const endValue = addMinutesToLocalDateTime(
      startValue,
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
        start: eventTime(startValue, timeZone),
        end: eventTime(endValue, timeZone),
        ...(input.recurrence?.length
          ? { recurrence: [...input.recurrence] }
          : {}),
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
