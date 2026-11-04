import { describe, expect, it } from 'vitest';

import {
  calendarRecurrenceForTask,
  cronToRRule,
  intervalToRRule,
} from './calendar-recurrence.js';

describe('cronToRRule', () => {
  it('translates synthetic monthly reminders', () => {
    expect(cronToRRule('0 9 15 * *')).toBe('RRULE:FREQ=MONTHLY;BYMONTHDAY=15');
    expect(cronToRRule('0 9 2 * *')).toBe('RRULE:FREQ=MONTHLY;BYMONTHDAY=2');
  });

  it('maps an unrestricted day to a daily rule', () => {
    expect(cronToRRule('0 9 * * *')).toBe('RRULE:FREQ=DAILY');
    expect(cronToRRule('30 10 * * *')).toBe('RRULE:FREQ=DAILY');
  });

  it('maps weekday restrictions to BYDAY', () => {
    expect(cronToRRule('30 8 * * 1-5')).toBe(
      'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    );
    expect(cronToRRule('0 9 * * MON,FRI')).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO,FR');
  });

  it('treats both cron spellings of Sunday alike', () => {
    expect(cronToRRule('0 9 * * 0')).toBe('RRULE:FREQ=WEEKLY;BYDAY=SU');
    expect(cronToRRule('0 9 * * 7')).toBe('RRULE:FREQ=WEEKLY;BYDAY=SU');
  });

  it('collapses a full range back to "every day"', () => {
    expect(cronToRRule('0 9 * * 0-6')).toBe('RRULE:FREQ=DAILY');
    expect(cronToRRule('0 9 * * 1-7')).toBe('RRULE:FREQ=DAILY');
  });

  it('keeps a month restriction as a BYMONTH limit', () => {
    expect(cronToRRule('0 12 1 1 *')).toBe(
      'RRULE:FREQ=MONTHLY;BYMONTH=1;BYMONTHDAY=1',
    );
    expect(cronToRRule('0 9 * 3 *')).toBe('RRULE:FREQ=DAILY;BYMONTH=3');
  });

  it('expands a day-of-month step the way cron does — per month', () => {
    expect(cronToRRule('0 9 */10 * *')).toBe(
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=1,11,21,31',
    );
  });

  it('accepts a leading zero-seconds field', () => {
    expect(cronToRRule('0 0 9 * * *')).toBe('RRULE:FREQ=DAILY');
  });

  it('declines schedules with no single start time', () => {
    expect(cronToRRule('*/5 * * * *')).toBeNull();
    expect(cronToRRule('0 */2 * * *')).toBeNull();
    expect(cronToRRule('0,30 9 * * *')).toBeNull();
    expect(cronToRRule('30 0 9 * * *')).toBeNull();
  });

  it('declines day-of-month combined with day-of-week', () => {
    // Vixie cron fires on EITHER match; RRULE would require BOTH. There is no
    // faithful translation, so no event is better than a wrong one.
    expect(cronToRRule('0 9 1 * 1')).toBeNull();
  });

  it('declines malformed expressions', () => {
    expect(cronToRRule('0 9 * *')).toBeNull();
    expect(cronToRRule('')).toBeNull();
    expect(cronToRRule('not a cron')).toBeNull();
    expect(cronToRRule('0 9 32 * *')).toBeNull();
    expect(cronToRRule('0 25 * * *')).toBeNull();
    expect(cronToRRule('0 9 * * FRI-MON')).toBeNull();
  });
});

describe('intervalToRRule', () => {
  it('maps whole-day and whole-hour periods', () => {
    expect(intervalToRRule(86_400_000)).toBe('RRULE:FREQ=DAILY;INTERVAL=1');
    expect(intervalToRRule(7 * 86_400_000)).toBe('RRULE:FREQ=DAILY;INTERVAL=7');
    expect(intervalToRRule(3_600_000)).toBe('RRULE:FREQ=HOURLY;INTERVAL=1');
    expect(intervalToRRule(6 * 3_600_000)).toBe('RRULE:FREQ=HOURLY;INTERVAL=6');
  });

  it('declines periods too short to belong in a calendar', () => {
    expect(intervalToRRule(60_000)).toBeNull();
    expect(intervalToRRule(15 * 60_000)).toBeNull();
  });

  it('declines periods that are not a whole number of hours', () => {
    expect(intervalToRRule(90 * 60_000)).toBeNull();
    expect(intervalToRRule(Number.NaN)).toBeNull();
  });
});

describe('calendarRecurrenceForTask', () => {
  it('treats a one-off task as a single event', () => {
    expect(
      calendarRecurrenceForTask({
        schedule_type: 'once',
        schedule_value: '2026-09-10T12:00:00',
      }),
    ).toEqual({ kind: 'single' });
  });

  it('turns a translatable cron task into a repeating event', () => {
    expect(
      calendarRecurrenceForTask({
        schedule_type: 'cron',
        schedule_value: '0 9 21 * *',
      }),
    ).toEqual({
      kind: 'recurring',
      rrule: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=21'],
    });
  });

  it('turns an interval task into a repeating event', () => {
    expect(
      calendarRecurrenceForTask({
        schedule_type: 'interval',
        schedule_value: String(86_400_000),
      }),
    ).toEqual({ kind: 'recurring', rrule: ['RRULE:FREQ=DAILY;INTERVAL=1'] });
  });

  it('reports an untranslatable or missing schedule as unsupported', () => {
    expect(
      calendarRecurrenceForTask({
        schedule_type: 'cron',
        schedule_value: '*/5 * * * *',
      }),
    ).toEqual({ kind: 'unsupported' });
    expect(calendarRecurrenceForTask({ schedule_type: 'cron' })).toEqual({
      kind: 'unsupported',
    });
    expect(
      calendarRecurrenceForTask({
        schedule_type: 'interval',
        schedule_value: '60000',
      }),
    ).toEqual({ kind: 'unsupported' });
  });
});
