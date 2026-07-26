import { describe, expect, it } from 'vitest';

import {
  safeTelegramAudioFileTag,
  safeTelegramAudioLogFields,
} from './audio-telegram.js';

describe('Telegram audio transport privacy', () => {
  it('does not expose URLs, bot tokens, file ids, or response payloads', () => {
    const secret = '123456:BOT_TOKEN/private-file-id';
    const fields = safeTelegramAudioLogFields(
      'download',
      1,
      Object.assign(new Error(`https://api.telegram.org/bot${secret}`), {
        responseBody: secret,
      }),
    );

    expect(fields).toEqual({
      stage: 'download',
      attempt: 1,
      failureCode: 'transport_error',
    });
    expect(JSON.stringify(fields)).not.toContain(secret);
  });

  it('uses only a short filesystem-safe file tag', () => {
    const tag = safeTelegramAudioFileTag('../private/file-id');

    expect(tag).toBe('efile-id');
    expect(tag).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(tag).not.toContain('..');
    expect(tag).not.toContain('/');
  });
});
