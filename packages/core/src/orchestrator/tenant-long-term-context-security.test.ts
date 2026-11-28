import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import { prependTenantLongTermPromptContext } from './message-loop.js';

describe('tenant long-term context safe file read', () => {
  it('uses the bounded descriptor loader and preserves normal owner context', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-safe-context-'));
    const groupDir = path.join(root, 'telegram_main');
    fs.mkdirSync(groupDir);
    fs.writeFileSync(
      path.join(groupDir, 'CLAUDE.md'),
      `OWNER_CONTEXT\n${'A'.repeat(400 * 1024)}\nTAIL_MUST_NOT_APPEAR`,
    );

    const readFileSpy = vi.spyOn(fs, 'readFileSync');
    try {
      const prompt = prependTenantLongTermPromptContext(
        '<messages>hello</messages>',
        'telegram_main',
        root,
      );

      expect(prompt).toContain('OWNER_CONTEXT');
      expect(prompt).toContain('<messages>hello</messages>');
      expect(prompt).not.toContain('TAIL_MUST_NOT_APPEAR');
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
