import { describe, expect, it } from 'vitest';

import {
  HOST_NOTICE_WINDOW_MS,
  ROW_NOTICES_PER_WINDOW,
  claimHostNotice,
  claimHostNoticeForRows,
  resetHostNotices,
} from './host-notice-limiter.js';

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      get: (key: string) => values.get(key),
      set: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  };
}

describe('host notice limiter (W05)', () => {
  it('lets the same notice reach a chat once per 15 minutes', () => {
    const { store } = memoryStore();
    const t0 = Date.parse('2026-03-10T16:17:28Z');
    expect(claimHostNotice(store, 'tg:owner', 'deferred_interrupted', t0)).toBe(true);
    // 34 identical notices within ten minutes.
    for (let i = 1; i <= 33; i++) {
      expect(
        claimHostNotice(store, 'tg:owner', 'deferred_interrupted', t0 + i * 18_000),
      ).toBe(false);
    }
    expect(
      claimHostNotice(store, 'tg:owner', 'deferred_interrupted', t0 + HOST_NOTICE_WINDOW_MS),
    ).toBe(true);
  });

  it('keeps kinds and chats apart', () => {
    const { store } = memoryStore();
    const t0 = 1_000_000;
    expect(claimHostNotice(store, 'tg:owner', 'retry_scheduled', t0)).toBe(true);
    expect(claimHostNotice(store, 'tg:owner', 'retries_exhausted', t0)).toBe(true);
    expect(claimHostNotice(store, 'tg:admin', 'retry_scheduled', t0)).toBe(true);
    expect(claimHostNotice(store, 'tg:owner', 'retry_scheduled', t0 + 1)).toBe(false);
  });

  it('survives a restart: the mark lives in the shared store', () => {
    const { values, store } = memoryStore();
    expect(claimHostNotice(store, 'tg:owner', 'retries_exhausted', 5_000)).toBe(true);
    const restarted = {
      get: (key: string) => values.get(key),
      set: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(claimHostNotice(restarted, 'tg:owner', 'retries_exhausted', 65_000)).toBe(false);
  });

  it('a real answer of the model clears the marks of that chat only', () => {
    const { store } = memoryStore();
    claimHostNotice(store, 'tg:owner', 'retry_scheduled', 0);
    claimHostNotice(store, 'tg:admin', 'retry_scheduled', 0);
    resetHostNotices(store, 'tg:owner');
    expect(claimHostNotice(store, 'tg:owner', 'retry_scheduled', 1_000)).toBe(true);
    expect(claimHostNotice(store, 'tg:admin', 'retry_scheduled', 1_000)).toBe(false);
  });

  it('never silences an honest notice because the store is broken', () => {
    const broken = {
      get: () => {
        throw new Error('db locked');
      },
      set: () => {
        throw new Error('db locked');
      },
    };
    expect(claimHostNotice(broken, 'tg:owner', 'policy_hold', 0)).toBe(true);
    expect(claimHostNotice({ get: () => 'not json', set: () => undefined }, 'tg:owner', 'policy_hold', 0)).toBe(true);
    expect(() => resetHostNotices(broken, 'tg:owner')).not.toThrow();
  });

  it('drops stale marks so the record does not grow', () => {
    const { values, store } = memoryStore();
    claimHostNotice(store, 'tg:owner', 'retry_scheduled', 0);
    claimHostNotice(store, 'tg:owner', 'provider_exhausted', HOST_NOTICE_WINDOW_MS * 2);
    expect(JSON.parse(values.get('host_notice_limiter:v1:tg:owner')!)).toEqual({
      provider_exhausted: HOST_NOTICE_WINDOW_MS * 2,
    });
  });
});

// W06×W05 (review r1108): a refusal of a row from the dashboard «Чат». A
// second panel row within 15 minutes was refused silently: the mark of the
// first refusal (chat, policy_hold) swallowed it.
describe('host notice limiter for refused rows (W06)', () => {
  it('a new row gets its own refusal; the same rows never twice in the window', () => {
    const { store } = memoryStore();
    const t0 = Date.parse('2026-03-10T10:00:00Z');
    expect(claimHostNoticeForRows(store, 'tg:owner', 'policy_hold', ['panel-a'], t0)).toBe(true);
    expect(claimHostNoticeForRows(store, 'tg:owner', 'policy_hold', ['panel-b'], t0 + 5 * 60_000)).toBe(true);
    // The same set, in any order: once only.
    expect(claimHostNoticeForRows(store, 'tg:owner', 'policy_hold', ['panel-a'], t0 + 6 * 60_000)).toBe(false);
    expect(claimHostNoticeForRows(store, 'tg:owner', 'policy_hold', ['panel-c', 'panel-d'], t0 + 7 * 60_000)).toBe(true);
    expect(claimHostNoticeForRows(store, 'tg:owner', 'policy_hold', ['panel-d', 'panel-c'], t0 + 7 * 60_000 + 1)).toBe(false);
    // Another chat is apart; the generic policy notice is apart too.
    expect(claimHostNoticeForRows(store, 'tg:admin', 'policy_hold', ['panel-a'], t0 + 8 * 60_000)).toBe(true);
    expect(claimHostNotice(store, 'tg:owner', 'policy_hold', t0 + 8 * 60_000)).toBe(true);
  });

  it('no more than three different refusals in the window: something answering refusals through the panel cannot loop', () => {
    const { store } = memoryStore();
    const t0 = 2_000_000;
    for (let i = 0; i < ROW_NOTICES_PER_WINDOW; i++) {
      expect(claimHostNoticeForRows(store, 'tg:owner', 'policy_hold', [`panel-${i}`], t0 + i * 60_000)).toBe(true);
    }
    expect(claimHostNoticeForRows(store, 'tg:owner', 'policy_hold', ['panel-x'], t0 + 4 * 60_000)).toBe(false);
    // Once the first mark leaves the window, one more may go.
    expect(claimHostNoticeForRows(store, 'tg:owner', 'policy_hold', ['panel-y'], t0 + HOST_NOTICE_WINDOW_MS)).toBe(true);
  });

  it('a broken store never silences the refusal', () => {
    const broken = {
      get: () => {
        throw new Error('db locked');
      },
      set: () => {
        throw new Error('db locked');
      },
    };
    expect(claimHostNoticeForRows(broken, 'tg:owner', 'policy_hold', ['panel-a'], 0)).toBe(true);
  });
});
