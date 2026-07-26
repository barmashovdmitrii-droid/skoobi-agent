import { describe, expect, it } from 'vitest';

import { detectDialogAttention } from './dialog-attention.js';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');

describe('detectDialogAttention', () => {
  it.each([
    ['Когда сможешь ответить', 'Есть вопрос'],
    ['Встречаемся завтра', 'Есть дата или срок'],
    ['Пришли, пожалуйста, договор', 'Нужно действие или ответ'],
    ['Привет, я на месте', 'Ждёт ответа'],
  ])('marks a recent incoming message: %s', (text, attentionReason) => {
    expect(
      detectDialogAttention({
        lastMessageAt: '2026-07-15T11:00:00.000Z',
        outgoing: false,
        text,
        now: NOW,
      }),
    ).toEqual({ needsReply: true, attentionReason });
  });

  it('does not mark outgoing, stale, invalid, or future messages', () => {
    for (const input of [
      {
        lastMessageAt: '2026-07-15T11:00:00.000Z',
        outgoing: true,
      },
      {
        lastMessageAt: '2026-07-01T11:00:00.000Z',
        outgoing: false,
      },
      { lastMessageAt: 'not-a-date', outgoing: false },
      {
        lastMessageAt: '2026-07-15T12:02:00.000Z',
        outgoing: false,
      },
    ]) {
      expect(
        detectDialogAttention({ ...input, text: 'Когда ответишь?', now: NOW }),
      ).toEqual({ needsReply: false, attentionReason: '' });
    }
  });
});
