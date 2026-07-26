import { describe, expect, it } from 'vitest';

import { _normalizeExtractedDocumentTextForTest } from './local-document.js';

describe('local WhatsApp document extraction', () => {
  it('normalizes controls and bounds extracted text', () => {
    const result = _normalizeExtractedDocumentTextForTest(
      `  Первая\u0000   строка\n\n\n\nВторая строка ${'я'.repeat(20_000)}  `,
    );
    expect(result).toContain('Первая строка\n\nВторая строка');
    expect(result.length).toBe(16_000);
    expect(result).not.toContain('\u0000');
  });
});
