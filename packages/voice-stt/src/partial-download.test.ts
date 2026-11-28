import { describe, expect, it } from 'vitest';

import { unlinkPartialBeforeRetry } from './partial-download.js';

describe('unlinkPartialBeforeRetry', () => {
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

  it('swallows a missing-file error', async () => {
    await expect(
      unlinkPartialBeforeRetry('/tmp/none.ogg', () =>
        Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })),
      ),
    ).resolves.toBeUndefined();
  });
});
