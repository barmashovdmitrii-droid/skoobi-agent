import { describe, expect, it } from 'vitest';

import { isoDateTime } from './iso-date-time.js';

describe('isoDateTime (zod ≥ 4.5 keeps the pre-upgrade format)', () => {
  it('accepts UTC time with or without seconds', () => {
    for (const value of [
      '2026-11-30T18:00Z',
      '2026-11-30T18:00:00Z',
      '2026-11-30T18:00:00.5Z',
      '2026-11-30T18:00:00.000Z',
    ]) {
      expect(isoDateTime().safeParse(value).success, value).toBe(true);
    }
  });

  it('still rejects what was rejected before', () => {
    for (const value of [
      '2026-11-30T18Z',
      '2026-11-30',
      '2026-11-30T18:00',
      '2026-11-30T18:00:00+05:00',
      '2026-02-30T18:00Z',
      'x',
    ]) {
      expect(isoDateTime().safeParse(value).success, value).toBe(false);
    }
  });
});
