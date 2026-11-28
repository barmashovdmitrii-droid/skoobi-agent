import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  deliverFileOnce,
  readFileDelivery,
  reconcileFileDeliveryFinal,
  recordFileDeliveryRejection,
} from './file-delivery.js';
const databases: Database.Database[] = [];
const fixture = () => {
  const db = new Database(':memory:');
  databases.push(db);
  return {
    db,
    scope: { sourceGroup: 'fixture', chatJid: 'test:recipient' },
    deliveryId: randomUUID(),
    artifact: {
      name: 'report.zip',
      bytes: 3,
      sha256: createHash('sha256').update('zip').digest('hex'),
    },
  };
};
afterEach(() => databases.splice(0).forEach((db) => db.close()));
describe('durable file delivery receipts', () => {
  it('readonly empty status and exact attempts do not create state', () => {
    const f = fixture();
    expect(readFileDelivery(f.db, f.scope, f.deliveryId)).toBeNull();
    expect(reconcileFileDeliveryFinal(f.db, f.scope, randomUUID())).toEqual([]);
    expect(
      f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
    ).toEqual([]);
  });
  it('requires real transport start before ACK, records digest, and scopes reads', async () => {
    const f = fixture();
    const attempt = randomUUID();
    const send = vi.fn(async (before: () => void) => {
      before();
      return { state: 'delivered' as const, code: 'api_acknowledged' };
    });
    const receipt = await deliverFileOnce({
      ...f,
      originAttempt: attempt,
      send,
    });
    expect(receipt).toMatchObject({ state: 'delivered', artifact: f.artifact });
    expect(receipt.acknowledgedAt).toBeTruthy();
    expect(
      readFileDelivery(
        f.db,
        { ...f.scope, sourceGroup: 'other' },
        f.deliveryId,
      ),
    ).toBeNull();
    expect(reconcileFileDeliveryFinal(f.db, f.scope, randomUUID())).toEqual([]);
    expect(reconcileFileDeliveryFinal(f.db, f.scope, attempt)).toEqual([
      receipt,
    ]);
    await deliverFileOnce({ ...f, send });
    expect(send).toHaveBeenCalledOnce();
  });
  it('deduplicates concurrent copied files and binds the second exact attempt to the first receipt', async () => {
    const f = fixture();
    let release!: (v: { state: 'delivered'; code: string }) => void;
    const first = deliverFileOnce({
      ...f,
      send: async (before) => {
        before();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const attempt = randomUUID(),
      send = vi.fn();
    const duplicate = await deliverFileOnce({
      ...f,
      originAttempt: attempt,
      deliveryId: randomUUID(),
      artifact: { ...f.artifact, name: 'copy.zip' },
      send,
    });
    expect(duplicate).toMatchObject({
      deliveryId: f.deliveryId,
      state: 'sending',
    });
    expect(send).not.toHaveBeenCalled();
    expect(reconcileFileDeliveryFinal(f.db, f.scope, attempt)[0].state).toBe(
      'sending',
    );
    release({ state: 'delivered', code: 'api_acknowledged' });
    await first;
    expect(reconcileFileDeliveryFinal(f.db, f.scope, attempt)[0].state).toBe(
      'delivered',
    );
  });
  it('never reposts a lost ACK, including new id and explicit resend', async () => {
    const f = fixture();
    const send = vi.fn(async (before: () => void) => {
      before();
      throw new Error('synthetic timeout');
    });
    expect((await deliverFileOnce({ ...f, send })).state).toBe('unknown');
    expect(
      (
        await deliverFileOnce({
          ...f,
          deliveryId: randomUUID(),
          authorizedResend: true,
          send,
        })
      ).state,
    ).toBe('unknown');
    expect(send).toHaveBeenCalledOnce();
  });
  it('blocked preflight is retryable, still linked to the later attempt', async () => {
    const f = fixture();
    expect(
      (
        await deliverFileOnce({
          ...f,
          send: async () => ({ state: 'blocked', code: 'checks_failed' }),
        })
      ).state,
    ).toBe('blocked');
    const attempt = randomUUID();
    expect(
      (
        await deliverFileOnce({
          ...f,
          originAttempt: attempt,
          send: async (before) => {
            before();
            return { state: 'delivered', code: 'api_acknowledged' };
          },
        })
      ).state,
    ).toBe('delivered');
    expect(reconcileFileDeliveryFinal(f.db, f.scope, attempt)[0].state).toBe(
      'delivered',
    );
  });
  it('success dedups by content but an authorized fresh resend delivers again', async () => {
    const f = fixture();
    const send = vi.fn(async (before: () => void) => {
      before();
      return { state: 'delivered' as const, code: 'api_acknowledged' };
    });
    await deliverFileOnce({ ...f, send });
    await deliverFileOnce({ ...f, deliveryId: randomUUID(), send });
    expect(send).toHaveBeenCalledOnce();
    await deliverFileOnce({
      ...f,
      deliveryId: randomUUID(),
      authorizedResend: true,
      send,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('same-id changed content and foreign scope cannot replay', async () => {
    const f = fixture();
    const send = vi.fn(async (before: () => void) => {
      before();
      return { state: 'delivered' as const, code: 'api_acknowledged' };
    });
    await deliverFileOnce({ ...f, send });
    await expect(
      deliverFileOnce({ ...f, caption: 'changed', send }),
    ).rejects.toThrow('delivery_id_conflict');
    await expect(
      deliverFileOnce({
        ...f,
        scope: { ...f.scope, chatJid: 'test:other' },
        send,
      }),
    ).rejects.toThrow('delivery_id_conflict');
    expect(send).toHaveBeenCalledOnce();
  });
  it('restart in-flight receipt is unknown on readonly query and cannot replay', async () => {
    const f = fixture();
    await deliverFileOnce({
      ...f,
      send: async () => ({ state: 'blocked', code: 'checks_failed' }),
    });
    f.db
      .prepare(
        "UPDATE file_delivery_receipts SET state='sending',owner='previous-process'",
      )
      .run();
    expect(readFileDelivery(f.db, f.scope, f.deliveryId)).toMatchObject({
      state: 'unknown',
      code: 'interrupted_inspect_before_retry',
    });
    const send = vi.fn();
    expect((await deliverFileOnce({ ...f, send })).state).toBe('unknown');
    expect(send).not.toHaveBeenCalled();
  });
});

it('a missing file creates a durable attempt-bound refusal without inventing its hash', async () => {
  const f = fixture(),
    originAttempt = randomUUID();
  const receipt = recordFileDeliveryRejection({
    ...f,
    originAttempt,
    name: 'missing.zip',
    code: 'file_not_available',
  });
  expect(receipt).toMatchObject({
    state: 'blocked',
    artifact: { name: 'missing.zip', sha256: null, bytes: null },
  });
  expect(reconcileFileDeliveryFinal(f.db, f.scope, originAttempt)).toEqual([
    receipt,
  ]);
  const send = vi.fn(async (before: () => void) => {
    before();
    return { state: 'delivered' as const, code: 'api_acknowledged' };
  });
  expect((await deliverFileOnce({ ...f, send })).state).toBe('delivered');
  expect(send).toHaveBeenCalledOnce();
  expect(
    recordFileDeliveryRejection({
      ...f,
      name: 'missing.zip',
      code: 'file_not_available',
    }).state,
  ).toBe('delivered');
});
