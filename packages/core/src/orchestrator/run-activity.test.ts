import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from './logger.js';
import {
  onRunIpcActivity,
  notifyRunIpcActivity,
  RunIpcActivityKind,
} from './run-activity.js';

// Module state (the listener registry) persists across tests in this file, so
// every test uses its own folder name and unsubscribes what it registered.

describe('run-activity (IPC delivery → active run liveness bridge)', () => {
  it('returns 0 when no run is listening for the folder', () => {
    expect(notifyRunIpcActivity('ra-nobody', 'message')).toBe(0);
  });

  it('delivers the kind to a registered listener and counts it', () => {
    const kinds: RunIpcActivityKind[] = [];
    const unsubscribe = onRunIpcActivity('ra-single', (kind) =>
      kinds.push(kind),
    );

    expect(notifyRunIpcActivity('ra-single', 'photo')).toBe(1);
    expect(kinds).toEqual(['photo']);

    unsubscribe();
  });

  it('notifies every listener of the folder and only that folder', () => {
    const a: RunIpcActivityKind[] = [];
    const b: RunIpcActivityKind[] = [];
    const other: RunIpcActivityKind[] = [];
    const unsubA = onRunIpcActivity('ra-multi', (kind) => a.push(kind));
    const unsubB = onRunIpcActivity('ra-multi', (kind) => b.push(kind));
    const unsubOther = onRunIpcActivity('ra-elsewhere', (kind) =>
      other.push(kind),
    );

    expect(notifyRunIpcActivity('ra-multi', 'voice')).toBe(2);
    expect(a).toEqual(['voice']);
    expect(b).toEqual(['voice']);
    expect(other).toEqual([]);

    unsubA();
    unsubB();
    unsubOther();
  });

  it('unsubscribe stops delivery, is idempotent, and leaves siblings intact', () => {
    const kept: RunIpcActivityKind[] = [];
    const removed: RunIpcActivityKind[] = [];
    const unsubKept = onRunIpcActivity('ra-unsub', (kind) => kept.push(kind));
    const unsubRemoved = onRunIpcActivity('ra-unsub', (kind) =>
      removed.push(kind),
    );

    unsubRemoved();
    unsubRemoved(); // second call is a no-op, must not throw

    expect(notifyRunIpcActivity('ra-unsub', 'document')).toBe(1);
    expect(kept).toEqual(['document']);
    expect(removed).toEqual([]);

    unsubKept();
    expect(notifyRunIpcActivity('ra-unsub', 'document')).toBe(0);
  });

  it('contains a throwing listener: siblings still notified, nothing propagates', () => {
    const seen: RunIpcActivityKind[] = [];
    const unsubThrowing = onRunIpcActivity('ra-throws', () => {
      throw new Error('listener exploded');
    });
    const unsubGood = onRunIpcActivity('ra-throws', (kind) => seen.push(kind));

    let count = 0;
    expect(() => {
      count = notifyRunIpcActivity('ra-throws', 'message');
    }).not.toThrow();
    // Only successfully-notified listeners are counted.
    expect(count).toBe(1);
    expect(seen).toEqual(['message']);
    expect(logger.warn).toHaveBeenCalled();

    unsubThrowing();
    unsubGood();
  });

  it('tolerates a listener unsubscribing itself mid-notify', () => {
    let calls = 0;
    const unsubscribe = onRunIpcActivity('ra-self-unsub', () => {
      calls++;
      unsubscribe();
    });

    expect(notifyRunIpcActivity('ra-self-unsub', 'photo')).toBe(1);
    expect(notifyRunIpcActivity('ra-self-unsub', 'photo')).toBe(0);
    expect(calls).toBe(1);
  });
});
