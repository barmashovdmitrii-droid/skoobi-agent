import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TELEGRAM_POLL_STALL_SEC,
  pollHealthTransformer,
  TelegramPollHealth,
} from './poll-health.js';

function setup(stallSec: number = DEFAULT_TELEGRAM_POLL_STALL_SEC) {
  let now = 1_000_000;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const health = new TelegramPollHealth({
    log,
    stallSec: () => stallSec,
    now: () => now,
  });
  return {
    log,
    health,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('TelegramPollHealth (W41)', () => {
  it('is healthy while getUpdates keeps succeeding', () => {
    const { health, log } = setup();
    health.onRequestStart();
    health.onSuccess();
    expect(health.status()).toEqual({
      healthy: true,
      problemSec: null,
      consecutiveFailures: 0,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs the first failure once, stays healthy below the threshold', () => {
    const { health, log, advance } = setup(300);
    health.onFailure(new Error('fetch failed'));
    advance(3_000);
    health.onFailure(new Error('fetch failed'));
    advance(3_000);
    health.onFailure(new Error('fetch failed'));

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      { err: 'fetch failed' },
      'Telegram polling failed (getUpdates); grammY keeps retrying',
    );
    expect(health.status()).toMatchObject({
      healthy: true,
      problemSec: 6,
      consecutiveFailures: 3,
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('turns unhealthy past the threshold, logs it once, and logs the recovery', () => {
    const { health, log, advance } = setup(300);
    health.onFailure(new Error('fetch failed'));
    advance(301_000);
    health.onFailure(new Error('fetch failed'));
    advance(3_000);
    health.onFailure(new Error('fetch failed'));

    expect(health.status().healthy).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);

    advance(1_000);
    health.onRequestStart();
    health.onSuccess();
    expect(health.status().healthy).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      { downSec: 305, failures: 3 },
      'Telegram polling recovered',
    );
  });

  it('notices a getUpdates call that hangs without returning or failing', () => {
    const { health, log, advance } = setup(300);
    health.onRequestStart();
    advance(30_000 + 299_000);
    expect(health.status().healthy).toBe(true);
    advance(2_000);
    const status = health.status();
    expect(status.healthy).toBe(false);
    expect(status.problemSec).toBe(301);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('threshold 0 disables the unhealthy verdict but keeps the log lines', () => {
    const { health, log, advance } = setup(0);
    health.onFailure(new Error('fetch failed'));
    advance(3_600_000);
    health.onFailure(new Error('fetch failed'));
    expect(health.status().healthy).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('counts a hung call that finally fails from the end of the long poll, not from the failure', () => {
    // Half-open TCP: getUpdates hangs until the 180 s client timeout, fails,
    // and the next call hangs again.
    const { health, log, advance } = setup(300);
    health.onRequestStart();
    advance(180_000);
    health.onFailure(new Error('timeout'));
    expect(health.status()).toMatchObject({ healthy: true, problemSec: 150 });
    advance(3_000);
    health.onRequestStart();
    advance(146_000); // 329 s since the outage began
    expect(health.status().healthy).toBe(true);
    advance(1_000); // 330 s = long poll + threshold, as for a hung call
    const status = health.status();
    expect(status.healthy).toBe(false);
    expect(status.problemSec).toBe(300);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ problemSec: 300, hung: false }),
      expect.any(String),
    );

    advance(31_000); // second hung call fails at 180 s too
    health.onFailure(new Error('timeout'));
    advance(3_000);
    health.onRequestStart();
    health.onSuccess();
    expect(log.info).toHaveBeenCalledWith(
      { downSec: 334, failures: 2 },
      'Telegram polling recovered',
    );
  });

  it('a quick failure right after a call starts begins the problem at the failure', () => {
    const { health, advance } = setup(300);
    health.onRequestStart();
    advance(500);
    health.onFailure(new Error('fetch failed'));
    advance(1_000);
    expect(health.status().problemSec).toBe(1);
  });

  it('startup that never reaches onStart turns unhealthy after the threshold (boot without network)', () => {
    const { health, log, advance } = setup(300);
    health.onStartupBegin();
    advance(1_000);
    health.onFailure(new Error('fetch failed'), 'getMe');
    expect(log.warn).toHaveBeenCalledWith(
      { method: 'getMe', err: 'fetch failed' },
      'Telegram polling failed (getMe); grammY keeps retrying',
    );
    advance(298_000);
    expect(health.status().healthy).toBe(true);
    advance(1_000);
    expect(health.status()).toMatchObject({ healthy: false, problemSec: 300 });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ starting: true, hung: false }),
      expect.any(String),
    );

    advance(60_000);
    health.onStartupComplete();
    expect(health.status()).toEqual({
      healthy: true,
      problemSec: null,
      consecutiveFailures: 0,
    });
    expect(log.info).toHaveBeenCalledWith(
      { downSec: 360, failures: 1 },
      'Telegram polling recovered',
    );
  });

  it('startup that hangs without any failure also turns unhealthy', () => {
    const { health, log, advance } = setup(300);
    health.onStartupBegin();
    advance(300_000);
    expect(health.status().healthy).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('a normal startup logs nothing and stays healthy', () => {
    const { health, log, advance } = setup(300);
    health.onStartupBegin();
    advance(1_500);
    expect(health.status().healthy).toBe(true);
    health.onStartupComplete();
    expect(health.status()).toEqual({
      healthy: true,
      problemSec: null,
      consecutiveFailures: 0,
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a cancelled request (bot.stop) is not a failure', () => {
    const { health, log } = setup();
    health.onRequestStart();
    health.onRequestCancelled();
    expect(health.status()).toMatchObject({ healthy: true, problemSec: null });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('pollHealthTransformer (W41)', () => {
  it('passes other methods through untouched', async () => {
    const health = { onRequestStart: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() };
    const transformer = pollHealthTransformer(health as any);
    const prev = vi.fn(async () => ({ ok: true, result: 1 }));
    await expect(transformer(prev, 'sendMessage', {})).resolves.toEqual({
      ok: true,
      result: 1,
    });
    expect(health.onRequestStart).not.toHaveBeenCalled();
  });

  it('records getMe/deleteWebhook failures only while the bot is starting', async () => {
    const { health, log, advance } = setup(300);
    const transformer = pollHealthTransformer(health);
    health.onStartupBegin();

    await expect(
      transformer(
        async () => {
          throw new Error("Network request for 'getMe' failed!");
        },
        'getMe',
        undefined,
      ),
    ).rejects.toThrow('getMe');
    await transformer(
      async () => ({ ok: false, error_code: 502, description: 'Bad Gateway' }),
      'deleteWebhook',
      {},
    );
    expect(health.status().consecutiveFailures).toBe(2);
    expect(log.warn).toHaveBeenCalledTimes(1);

    // A successful getMe does not end startup: only onStart does.
    await transformer(async () => ({ ok: true, result: {} }), 'getMe', undefined);
    advance(300_000);
    expect(health.status().healthy).toBe(false);

    health.onStartupComplete();
    expect(health.status().healthy).toBe(true);
    // After startup a getMe failure is not about polling.
    await expect(
      transformer(
        async () => {
          throw new Error('boom');
        },
        'getMe',
        undefined,
      ),
    ).rejects.toThrow('boom');
    expect(health.status().consecutiveFailures).toBe(0);
  });

  it('feeds getUpdates outcomes: ok, error reply, thrown network error, abort', async () => {
    const { health, log } = setup();
    const transformer = pollHealthTransformer(health);

    await transformer(async () => ({ ok: true, result: [] }), 'getUpdates', {});
    expect(health.status().consecutiveFailures).toBe(0);

    await transformer(
      async () => ({ ok: false, error_code: 502, description: 'Bad Gateway' }),
      'getUpdates',
      {},
    );
    expect(health.status().consecutiveFailures).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      { err: 'Bot API 502: Bad Gateway' },
      expect.any(String),
    );

    await expect(
      transformer(
        async () => {
          throw new Error('Network request for getUpdates failed');
        },
        'getUpdates',
        {},
      ),
    ).rejects.toThrow('Network request');
    expect(health.status().consecutiveFailures).toBe(2);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      transformer(
        async () => {
          throw new Error('aborted');
        },
        'getUpdates',
        {},
        aborted.signal,
      ),
    ).rejects.toThrow('aborted');
    expect(health.status().consecutiveFailures).toBe(2);
  });
});
