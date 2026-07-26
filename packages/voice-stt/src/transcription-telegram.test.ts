import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  safeTelegramFileTag,
  safeTelegramTransportLogFields,
  unlinkPartialBeforeRetry,
} from './transcription-telegram.js';

describe('safeTelegramFileTag', () => {
  it('strips path-traversal sequences from a Telegram fileId', () => {
    // A slash/`..`-bearing identifier would let path.join escape tmpdir().
    const malicious = 'x/../../../../tmp/evil';
    const tag = safeTelegramFileTag(malicious);

    expect(tag).not.toContain('/');
    expect(tag).not.toContain('..');
    expect(tag).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('keeps the resulting temp path inside tmpdir() (no traversal)', () => {
    const malicious = 'x/../../../../tmp/evil';
    const tmpOgg = path.join(
      os.tmpdir(),
      `tg-voice-${Date.now()}-${safeTelegramFileTag(malicious)}.ogg`,
    );

    // Before the fix, the raw fileId resolved to /tmp/evil.ogg, outside tmpdir().
    const resolvedDir = path.dirname(path.resolve(tmpOgg));
    expect(resolvedDir).toBe(path.resolve(os.tmpdir()));
  });

  it('preserves URL-safe base64url identifiers (trailing 16 chars)', () => {
    // Real Telegram file_ids are URL-safe base64url; they survive untouched.
    const fileId = 'AwACAgIAAxkBAAEBcdEf-gh_ij';
    const tag = safeTelegramFileTag(fileId);

    expect(tag).toBe(fileId.slice(-16));
    expect(tag).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never produces an empty suffix', () => {
    expect(safeTelegramFileTag('../../')).toBe('voice');
    expect(safeTelegramFileTag('')).toBe('voice');
  });

  it('does not let the next retry start before partial cleanup finishes', async () => {
    let releaseCleanup!: () => void;
    const unlink = () =>
      new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
    let cleanupFinished = false;
    const pending = unlinkPartialBeforeRetry('/tmp/partial.ogg', unlink).then(
      () => {
        cleanupFinished = true;
      },
    );

    await Promise.resolve();
    expect(cleanupFinished).toBe(false);
    releaseCleanup();
    await pending;
    expect(cleanupFinished).toBe(true);
  });

  it('does not expose Telegram URLs, tokens, file ids, or error payloads in log fields', () => {
    const secret = '123456:BOT_TOKEN/private-file-id';
    const fields = safeTelegramTransportLogFields(
      'download',
      2,
      Object.assign(new Error(`https://api.telegram.org/bot${secret}`), {
        stderr: secret,
      }),
    );

    expect(fields).toEqual({
      stage: 'download',
      attempt: 2,
      failureCode: 'transport_error',
    });
    expect(JSON.stringify(fields)).not.toContain(secret);
  });
});
