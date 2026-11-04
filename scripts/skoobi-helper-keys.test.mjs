import { describe, expect, it, vi } from 'vitest';

import {
  CLICLICK_KEYS,
  OPEN_APP_RETRY_DELAY_MS,
  isAppStillClosingError,
  openApplicationWithRetry,
  planKeyPress,
  supportedKeyNames,
} from '../helper/skoobi-helper-policy.js';

describe('Skoobi helper /key planning', () => {
  it('maps every page-up/page-down spelling to the cliclick names', () => {
    for (const spelling of ['pageup', 'page_up', 'pgup', 'page-up', 'PageUp']) {
      expect(planKeyPress(spelling), spelling).toEqual({
        kind: 'cliclick',
        key: 'page-up',
      });
    }
    for (const spelling of [
      'pagedown',
      'page_down',
      'pgdown',
      'pgdn',
      'page-down',
    ]) {
      expect(planKeyPress(spelling), spelling).toEqual({
        kind: 'cliclick',
        key: 'page-down',
      });
    }
    expect(planKeyPress('home')).toEqual({ kind: 'cliclick', key: 'home' });
    expect(planKeyPress('end')).toEqual({ kind: 'cliclick', key: 'end' });
  });

  it('keeps the old aliases and the chord/character branches unchanged', () => {
    expect(planKeyPress('enter')).toEqual({ kind: 'cliclick', key: 'return' });
    expect(planKeyPress('up')).toEqual({ kind: 'cliclick', key: 'arrow-up' });
    expect(planKeyPress('a')).toEqual({
      kind: 'osascript',
      script: 'tell application "System Events" to keystroke "a"',
    });
    expect(planKeyPress('cmd+shift+4')).toEqual({
      kind: 'osascript',
      script:
        'tell application "System Events" to keystroke "4" using {command down, shift down}',
    });
    expect(planKeyPress('ctrl+page_down')).toEqual({
      kind: 'osascript',
      script:
        'tell application "System Events" to key code 121 using {control down}',
    });
    expect(() => planKeyPress('cmd')).toThrow(
      /press expects exactly one non-modifier key/,
    );
  });

  it('rejects an unknown lone key with the supported names, not a modifier message', () => {
// Unsupported key errors should list accepted key names.
    let error;
    try {
      planKeyPress('insert');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/^unsupported key "insert"; supported: /);
    expect(error.message).not.toMatch(/with modifiers/);
    for (const name of ['page-up', 'page-down', 'home', 'end', 'pageup']) {
      expect(error.message).toContain(name);
    }
    expect(supportedKeyNames()).toEqual(
      expect.arrayContaining([...CLICLICK_KEYS, 'pageup', 'page_down']),
    );
  });

  it('names the chord targets when a chord uses an unknown key', () => {
    expect(() => planKeyPress('cmd+insert')).toThrow(
      /^unsupported key with modifiers: "insert"; supported: .*page-down/,
    );
  });
});

describe('Skoobi helper /open_app retry', () => {
  const closing = () =>
    Object.assign(
      new Error(
        'Command failed: /usr/bin/open -a Telegram\n_LSOpenURLsWithCompletionHandler() failed for the application /Applications/Telegram.app with error -600.\n',
      ),
      { code: 1 },
    );

  it('recognises LaunchServices -600 and nothing else', () => {
    expect(isAppStillClosingError(closing())).toBe(true);
    expect(
      isAppStillClosingError(new Error('procNotFound: no eligible process')),
    ).toBe(true);
    expect(
      isAppStillClosingError(
        new Error('Unable to find application named "Nope"'),
      ),
    ).toBe(false);
    expect(isAppStillClosingError(new Error('exit code -6000'))).toBe(false);
    expect(isAppStillClosingError(undefined)).toBe(false);
  });

  it('retries once after 1.5 s when the app is still quitting', async () => {
// Relaunching immediately after quit can require a delayed retry.
    const open = vi
      .fn()
      .mockRejectedValueOnce(closing())
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn(async () => {});
    const onRetry = vi.fn();
    await expect(
      openApplicationWithRetry({ name: 'Telegram', open, sleep, onRetry }),
    ).resolves.toEqual({ ok: true, name: 'Telegram', retried: true });
    expect(open).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(OPEN_APP_RETRY_DELAY_MS);
    expect(OPEN_APP_RETRY_DELAY_MS).toBe(1500);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not retry other failures and explains a second -600', async () => {
    const missing = new Error('Unable to find application named "Nope"');
    const open = vi.fn().mockRejectedValue(missing);
    const sleep = vi.fn(async () => {});
    await expect(
      openApplicationWithRetry({ name: 'Nope', open, sleep }),
    ).rejects.toBe(missing);
    expect(open).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    const stillClosing = vi.fn().mockRejectedValue(closing());
    await expect(
      openApplicationWithRetry({ name: 'Telegram', open: stillClosing, sleep }),
    ).rejects.toThrow(
      /open -a Telegram failed twice with LaunchServices -600: .*call open_app again/,
    );
    expect(stillClosing).toHaveBeenCalledTimes(2);
  });
});
