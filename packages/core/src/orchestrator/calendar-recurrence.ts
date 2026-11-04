import type { ScheduledTask } from './types.js';

/**
 * Cron and interval schedules translated into RFC 5545 recurrence rules so a
 * repeating reminder shows up in the owner's calendar as one repeating event
 * consistently across future occurrences.
 *
 * The translation is deliberately conservative. Every schedule that cannot be
 * expressed EXACTLY returns `unsupported`, and the caller then skips calendar
 * mirroring. A reminder missing from the calendar is a cosmetic gap that the
 * chat message still covers; a reminder present at the wrong times sends the
 * owner somewhere on the wrong day, and nothing in the system contradicts it.
 */

/** Day-of-week index (cron and RFC 5545 both start the week on Sunday). */
const RRULE_WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

const CRON_WEEKDAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const CRON_MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Interval tasks below this period are not mirrored. A calendar entry every few
 * minutes buries every real appointment the owner has, and the chat message
 * already carries the reminder.
 */
const MIN_MIRRORED_INTERVAL_MS = MS_PER_HOUR;

/** Guards against an absurd INTERVAL= that Google would reject anyway. */
const MAX_RRULE_INTERVAL = 999;

/** `'*'` means "every value", otherwise a sorted, de-duplicated value list. */
type CronField = '*' | number[];

function parseCronFieldValue(
  token: string,
  names: Record<string, number> | undefined,
): number | null {
  if (names) {
    const named = names[token.toLowerCase()];
    if (named !== undefined) return named;
  }
  if (!/^\d{1,2}$/.test(token)) return null;
  return Number.parseInt(token, 10);
}

/**
 * Expand one cron field into the concrete values it fires on. Supports the
 * syntax cron-parser accepts on the write path: `*`, `a`, `a-b`, `a,b`, `*\/s`
 * and `a-b/s`, plus three-letter month and weekday names.
 */
function parseCronField(
  raw: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): CronField | null {
  const field = raw.trim();
  if (!field) return null;

  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart, ...extra] = part.split('/');
    if (extra.length) return null;

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d{1,3}$/.test(stepPart)) return null;
      step = Number.parseInt(stepPart, 10);
      if (step < 1) return null;
    }

    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = min;
      to = max;
    } else if (rangePart.includes('-')) {
      const [startToken, endToken, ...rest] = rangePart.split('-');
      if (rest.length) return null;
      const start = parseCronFieldValue(startToken, names);
      const end = parseCronFieldValue(endToken, names);
      if (start === null || end === null) return null;
      from = start;
      to = end;
    } else {
      const single = parseCronFieldValue(rangePart, names);
      if (single === null) return null;
      from = single;
      to = single;
    }

    // A wrapping range (`fri-mon`) is accepted by some cron implementations and
    // rejected by others. Refuse rather than guess which way this one meant.
    if (from > to || from < min || to > max) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }

  if (!values.size) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // `0-59`, `*/1` and `*` all mean the same thing; normalize so the rule shape
  // is chosen by meaning rather than by how the expression was written.
  return sorted.length === max - min + 1 ? '*' : sorted;
}

function normalizeWeekdays(field: CronField): CronField {
  if (field === '*') return '*';
  // Cron accepts both 0 and 7 for Sunday.
  const normalized = [...new Set(field.map((day) => (day === 7 ? 0 : day)))].sort(
    (a, b) => a - b,
  );
  return normalized.length === 7 ? '*' : normalized;
}

/**
 * Translate a cron expression into a single RRULE line, or null when no exact
 * translation exists.
 */
export function cronToRRule(expression: string): string | null {
  let fields = String(expression || '')
    .trim()
    .split(/\s+/);

  if (fields.length === 6) {
    // cron-parser accepts an optional leading seconds field. Only a schedule
    // pinned to second zero lands on a whole calendar minute.
    if (fields[0] !== '0') return null;
    fields = fields.slice(1);
  }
  if (fields.length !== 5) return null;

  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const monthDay = parseCronField(fields[2], 1, 31);
  const month = parseCronField(fields[3], 1, 12, CRON_MONTH_NAMES);
  const weekDay = parseCronField(fields[4], 0, 7, CRON_WEEKDAY_NAMES);
  if (!minute || !hour || !monthDay || !month || !weekDay) return null;

  // A calendar event begins at exactly one wall-clock time. A schedule firing
  // at several minutes or several hours of the day has no single start, so it
  // is not mirrored.
  if (minute === '*' || minute.length !== 1) return null;
  if (hour === '*' || hour.length !== 1) return null;

  const days = normalizeWeekdays(weekDay);
  const monthDayRestricted = monthDay !== '*';
  const weekDayRestricted = days !== '*';

  // Vixie cron ORs day-of-month with day-of-week when both are restricted;
  // RRULE ANDs BYMONTHDAY with BYDAY. The two disagree, so there is no faithful
  // translation and we decline instead of producing a subtly different event.
  if (monthDayRestricted && weekDayRestricted) return null;

  const parts: string[] = [];
  if (monthDayRestricted) parts.push('FREQ=MONTHLY');
  else if (weekDayRestricted) parts.push('FREQ=WEEKLY');
  else parts.push('FREQ=DAILY');


  // month-restricted expression keeps the same FREQ and gains a limit.
  if (month !== '*') parts.push(`BYMONTH=${month.join(',')}`);
  if (monthDayRestricted) parts.push(`BYMONTHDAY=${monthDay.join(',')}`);
  if (weekDayRestricted) {
    parts.push(`BYDAY=${(days as number[]).map((d) => RRULE_WEEKDAYS[d]).join(',')}`);
  }

  return `RRULE:${parts.join(';')}`;
}

/**
 * Translate a fixed millisecond interval into an RRULE, or null when the period
 * is not a whole number of hours or days, or is too short to mirror.
 */
export function intervalToRRule(intervalMs: number): string | null {
  if (!Number.isFinite(intervalMs) || !Number.isInteger(intervalMs)) return null;
  if (intervalMs < MIN_MIRRORED_INTERVAL_MS) return null;

  if (intervalMs % MS_PER_DAY === 0) {
    const days = intervalMs / MS_PER_DAY;
    return days <= MAX_RRULE_INTERVAL ? `RRULE:FREQ=DAILY;INTERVAL=${days}` : null;
  }
  if (intervalMs % MS_PER_HOUR === 0) {
    const hours = intervalMs / MS_PER_HOUR;
    return hours <= MAX_RRULE_INTERVAL
      ? `RRULE:FREQ=HOURLY;INTERVAL=${hours}`
      : null;
  }
  return null;
}

export type CalendarRecurrence =
  | { kind: 'single' }
  | { kind: 'recurring'; rrule: string[] }
  | { kind: 'unsupported' };

/**
 * Decide how a scheduled task should appear in the calendar: as one event, as a
 * repeating event, or not at all.
 */
export function calendarRecurrenceForTask(
  task: Pick<ScheduledTask, 'schedule_type'> & { schedule_value?: string },
): CalendarRecurrence {
  if (task.schedule_type === 'once') return { kind: 'single' };

  const scheduleValue = String(task.schedule_value || '').trim();
  if (!scheduleValue) return { kind: 'unsupported' };

  if (task.schedule_type === 'cron') {
    const rrule = cronToRRule(scheduleValue);
    return rrule ? { kind: 'recurring', rrule: [rrule] } : { kind: 'unsupported' };
  }

  if (task.schedule_type === 'interval') {
    const intervalMs = Number.parseInt(scheduleValue, 10);
    const rrule = Number.isNaN(intervalMs) ? null : intervalToRRule(intervalMs);
    return rrule ? { kind: 'recurring', rrule: [rrule] } : { kind: 'unsupported' };
  }

  return { kind: 'unsupported' };
}
