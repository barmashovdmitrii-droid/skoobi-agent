import { describe, expect, it, vi } from 'vitest';

import {
  persistRuntimeSessionIfAllowed,
  runtimePersistencePolicy,
  runtimeVisibleTasks,
  safeRuntimeSessionIdOrUndefined,
  shouldUseUntrustedMainRuntimeNamespace,
} from './runtime-namespace.js';

describe('downgraded-main runtime persistence policy', () => {
  it('denies every canonical persistence surface to a main group co-member', () => {
    const policy = runtimePersistencePolicy({
      groupIsMain: true,
      credentialProxyTier: 'guest',
      chatJid: 'tg:-1001234567890',
    });
    expect(policy).toEqual({
      untrustedMain: true,
      resumeCanonicalSession: false,
      persistCanonicalSession: false,
      exposeCanonicalTasks: false,
      includeCanonicalInstructions: false,
    });
    expect(runtimeVisibleTasks(policy, ['owner prompt'])).toEqual([]);
    const persist = vi.fn();
    expect(
      persistRuntimeSessionIfAllowed(policy, 'attacker-session', persist),
    ).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it('preserves owner multi-sender behavior', () => {
    const policy = runtimePersistencePolicy({
      groupIsMain: true,
      credentialProxyTier: 'owner',
      chatJid: 'tg:-1001234567890',
    });
    expect(policy.untrustedMain).toBe(false);
    expect(policy.resumeCanonicalSession).toBe(true);
    expect(policy.persistCanonicalSession).toBe(true);
    expect(policy.exposeCanonicalTasks).toBe(true);
    expect(policy.includeCanonicalInstructions).toBe(true);
    expect(runtimeVisibleTasks(policy, ['owner prompt'])).toEqual([
      'owner prompt',
    ]);
    const persist = vi.fn();
    expect(
      persistRuntimeSessionIfAllowed(policy, 'owner-session', persist),
    ).toBe(true);
    expect(persist).toHaveBeenCalledWith('owner-session');
  });

  it('does not change a private main DM or an ordinary non-main guest', () => {
    for (const input of [
      {
        groupIsMain: true,
        credentialProxyTier: 'guest' as const,
        chatJid: 'tg:100000001',
      },
      {
        groupIsMain: false,
        credentialProxyTier: 'guest' as const,
        chatJid: 'tg:-100999',
      },
    ]) {
      const policy = runtimePersistencePolicy(input);
      expect(policy).toMatchObject({
        untrustedMain: false,
        resumeCanonicalSession: true,
        persistCanonicalSession: true,
        exposeCanonicalTasks: true,
        includeCanonicalInstructions: true,
      });
    }
  });

  it('rejects traversal session ids but preserves UUID-compatible ids', () => {
    const policy = runtimePersistencePolicy({
      groupIsMain: false,
      credentialProxyTier: 'guest',
      chatJid: 'tg:123',
    });
    const persist = vi.fn();
    expect(
      persistRuntimeSessionIfAllowed(policy, '../../host-path', persist),
    ).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(safeRuntimeSessionIdOrUndefined('../../host-path')).toBeUndefined();
    expect(safeRuntimeSessionIdOrUndefined('session-123_UUID')).toBe(
      'session-123_UUID',
    );
    expect(
      persistRuntimeSessionIfAllowed(policy, 'session-123_UUID', persist),
    ).toBe(true);
    expect(persist).toHaveBeenCalledWith('session-123_UUID');
  });

  it('classifies bot-prefixed Telegram groups, WhatsApp groups, and Discord only', () => {
    for (const chatJid of [
      'tg:bot=9000000001:-100123',
      'group@g.us',
      'dc:channel',
    ]) {
      expect(
        shouldUseUntrustedMainRuntimeNamespace({
          groupIsMain: true,
          credentialProxyTier: 'guest',
          chatJid,
        }),
      ).toBe(true);
    }
    expect(
      shouldUseUntrustedMainRuntimeNamespace({
        groupIsMain: true,
        credentialProxyTier: 'guest',
        chatJid: '77001234567@s.whatsapp.net',
      }),
    ).toBe(false);
  });
});
