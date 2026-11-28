import { z } from 'zod';

/**
 * Время ISO в UTC (`…Z`) с секундами или без.
 *
 * zod ≥ 4.5 (обновление SEC-02 в r1111) по RFC 3339 требует секунды в
 * `z.string().datetime()`, если время с `Z`. До обновления «2026-11-30T18:00Z»
 * проходило, и модель могла так писать сроки в памяти и на заводе игр. Прежнее
 * поведение оставлено явно: обе формы, но не «2026-11-30T18Z».
 */
export function isoDateTime() {
  return z.union([
    z.string().datetime(),
    z.string().datetime({ precision: -1 }),
  ]);
}
