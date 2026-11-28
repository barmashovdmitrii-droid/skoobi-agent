/**
 * W03: «Спасибо», «понял», «👍» do not hold a ready answer (a plain thank-you
 * once held it and started an extra turn); the message itself stays
 * for the next turn. «Ок», «да», «давай» may answer a question — they still
 * defer the stale answer.
 */
import { describe, expect, it } from 'vitest';

import { isAcknowledgementMessage, planFinalizeHold } from './finalize-hold.js';

function plan(...bodies: string[]) {
  return planFinalizeHold({
    text: 'Готово: отчёт собран и лежит в папке проекта.',
    image: false,
    sideEffectTools: [],
    threadOk: true,
    contextFill: 0.2,
    pending: bodies.map((text) => ({ text })),
    remainingMs: 600_000,
  });
}

describe('acknowledgements release the ready answer', () => {
  it.each(['Спасибо большое тебе', 'спасибо!', 'Спс', 'Понял', 'ясно.', 'Жду', 'жду ответа', '👍', '👍🏻', '[Voice: Спасибо]'])(
    'status-preserved: %s',
    (text) => {
      expect(isAcknowledgementMessage(text)).toBe(true);
      expect(plan(text)).toEqual({ action: 'status-preserved' });
    },
  );

  it.each(['Ок', 'да', 'Давай', 'Спасибо, а теперь поменяй цвет', 'понял, но сделай по-другому', '[Photo]'])(
    'still defers: %s',
    (text) => {
      expect(isAcknowledgementMessage(text)).toBe(false);
      expect(plan(text)).toEqual({ action: 'defer', reason: 'pending-followup' });
    },
  );

  it('a ping plus thanks: the answer goes, nothing is swallowed', () => {
    expect(plan('ау', 'спасибо')).toEqual({ action: 'status-preserved' });
    expect(plan('ау', 'ну как ты')).toEqual({ action: 'ping' });
  });

  it('without a ready text nothing is released', () => {
    expect(
      planFinalizeHold({
        text: '',
        image: false,
        sideEffectTools: [],
        threadOk: true,
        contextFill: 0.2,
        pending: [{ text: 'спасибо' }],
        remainingMs: 600_000,
      }),
    ).toEqual({ action: 'defer', reason: 'pending-followup' });
  });
});
