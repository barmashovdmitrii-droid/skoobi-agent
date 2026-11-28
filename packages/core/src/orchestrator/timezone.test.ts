import { describe, it, expect } from 'vitest';

import { formatLocalTime } from './timezone.js';

// --- formatLocalTime ---

describe('formatLocalTime', () => {
  it('converts UTC to local time display', () => {
    // 2026-02-04T18:30:00Z in America/New_York (EST, UTC-5) = 1:30 PM
    const result = formatLocalTime(
      '2026-02-04T18:30:00.000Z',
      'America/New_York',
    );
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('Feb');
    expect(result).toContain('2026');
  });

  it('handles different timezones', () => {
    // Same UTC time should produce different local times
    const utc = '2026-06-15T12:00:00.000Z';
    const ny = formatLocalTime(utc, 'America/New_York');
    const tokyo = formatLocalTime(utc, 'Asia/Tokyo');
    // NY is UTC-4 in summer (EDT), Tokyo is UTC+9
    expect(ny).toContain('8:00');
    expect(tokyo).toContain('9:00');
  });

  it('does not throw on an invalid timezone and falls back to UTC', () => {
    // A mistyped TZ (e.g. process.env.TZ='Europe/Moscaw') used to make
    // toLocaleString throw RangeError on the inbound-message hot path.
    const utc = '2026-06-15T12:00:00.000Z';
    let result = '';
    expect(() => {
      result = formatLocalTime(utc, 'Europe/Moscaw');
    }).not.toThrow();
    // Falls back to UTC, so 12:00 PM is rendered as-is.
    expect(result).toContain('12:00');
    expect(result).toContain('PM');
    expect(result).toContain('Jun');
    expect(result).toContain('2026');
    // Should match what UTC formatting produces.
    expect(result).toBe(formatLocalTime(utc, 'UTC'));
  });
});
