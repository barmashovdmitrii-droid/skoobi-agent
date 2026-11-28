import { describe, expect, it, vi } from 'vitest';

import {
  AuthReconnectGate,
  CredentialSaveBarrier,
} from './whatsapp-auth-flow.js';

describe('WhatsApp auth credential/reconnect coordination', () => {
  it('waits for accumulated credential saves and starts only one reconnect', async () => {
    const barrier = new CredentialSaveBarrier();
    let releaseSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    barrier.enqueue(() => pendingSave).catch(() => undefined);

    const gate = new AuthReconnectGate();
    const generation = gate.beginSocket();
    const reconnect = vi.fn(async () => undefined);
    const first = gate.reconnectAfterCredentialSave(
      generation,
      () => barrier.drain(),
      reconnect,
    );
    const duplicate = gate.reconnectAfterCredentialSave(
      generation,
      () => barrier.drain(),
      reconnect,
    );

    await expect(duplicate).resolves.toBe(false);
    expect(reconnect).not.toHaveBeenCalled();
    releaseSave();
    await expect(first).resolves.toBe(true);
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it('fails closed and does not reconnect after a credential write error', async () => {
    const barrier = new CredentialSaveBarrier();
    barrier
      .enqueue(async () => {
        throw new Error('disk failure');
      })
      .catch(() => undefined);

    const gate = new AuthReconnectGate();
    const generation = gate.beginSocket();
    const reconnect = vi.fn(async () => undefined);

    await expect(
      gate.reconnectAfterCredentialSave(
        generation,
        () => barrier.drain(),
        reconnect,
      ),
    ).rejects.toThrow('WhatsApp credential save failed');
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('ignores reconnect callbacks from superseded sockets', async () => {
    const gate = new AuthReconnectGate();
    const staleGeneration = gate.beginSocket();
    gate.beginSocket();
    const drain = vi.fn(async () => undefined);
    const reconnect = vi.fn(async () => undefined);

    await expect(
      gate.reconnectAfterCredentialSave(staleGeneration, drain, reconnect),
    ).resolves.toBe(false);
    expect(drain).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
  });
});
