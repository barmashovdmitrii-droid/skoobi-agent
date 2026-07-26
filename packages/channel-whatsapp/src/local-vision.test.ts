import { describe, expect, it } from 'vitest';

import {
  formatLocalVisualDescription,
  parseLocalVisualDescription,
} from './local-vision.js';

describe('local WhatsApp vision result handling', () => {
  it('parses bounded OCR and classification output', () => {
    expect(
      parseLocalVisualDescription(
        JSON.stringify({
          text: ['  Привет\nмир  ', 'Привет мир', 42],
          labels: ['document', 'text'],
        }),
      ),
    ).toEqual({
      text: ['Привет мир'],
      labels: ['document', 'text'],
    });
  });

  it('rejects malformed or empty output', () => {
    expect(parseLocalVisualDescription('not-json')).toBeNull();
    expect(parseLocalVisualDescription('{"text":[],"labels":[]}')).toBeNull();
  });

  it('formats neutral searchable local metadata', () => {
    expect(
      formatLocalVisualDescription({
        text: ['Счёт № 12'],
        labels: ['document'],
      }),
    ).toBe('Распознанный текст: Счёт № 12. Объекты/сцена: document');
  });
});
