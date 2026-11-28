import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createMediaDeliveryState,
  confirmedMediaReceipt,
} from './media-delivery-state.js';
const ack = (
  deliveryId = randomUUID(),
  extra: Record<string, unknown> = {},
) => ({
  deliveryId,
  state: 'delivered',
  acknowledgedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});
const ready = (assetId: string, count: number) => ({
  assetId,
  state: 'ready',
  files: Array.from({ length: count }, (_, i) => ({
    part: i + 1,
    format: 'ogg',
  })),
});
describe('exact media receipt reduction', () => {
  it('requires typed ACK and nonempty fully acknowledged aggregate', () => {
    expect(confirmedMediaReceipt({ state: 'delivered' })).toBe(false);
    expect(confirmedMediaReceipt({ state: 'delivered', receipts: [] })).toBe(
      false,
    );
    expect(
      confirmedMediaReceipt({ state: 'delivered', receipts: [ack()] }),
    ).toBe(true);
    expect(confirmedMediaReceipt({ ...ack(), acknowledgedAt: undefined })).toBe(
      false,
    );
  });
  it('clears a pending legacy generation only when all saved parts are confirmed', () => {
    const state = createMediaDeliveryState(),
      assetId = randomUUID();
    state.observe({ assetId, state: 'generating' }, { aggregateVoice: true });
    state.observe(ready(assetId, 2));
    state.observe(
      ack(undefined, { voiceAsset: { assetId, part: 1, totalParts: 2 } }),
    );
    expect(state.hasUnresolved()).toBe(true);
    state.observe(
      ack(undefined, { voiceAsset: { assetId, part: 2, totalParts: 2 } }),
    );
    expect(state.hasUnresolved()).toBe(false);
  });
  it('retains aggregate metadata across delivery_status updates without guessing part count', () => {
    const state = createMediaDeliveryState(),
      assetId = randomUUID(),
      d1 = randomUUID(),
      d2 = randomUUID();
    state.observe(
      {
        assetId,
        state: 'delivery_incomplete',
        expectedParts: [1, 2],
        receipts: [
          ack(d1, { voiceAsset: { assetId, part: 1, totalParts: 2 } }),
          {
            deliveryId: d2,
            state: 'sending',
            requestedVoice: { assetId, part: 2 },
          },
        ],
      },
      { aggregateVoice: true },
    );
    expect(state.hasUnresolved()).toBe(true);
    state.observe(ack(d2));
    expect(state.hasUnresolved()).toBe(false);
  });
  it('cannot settle unknown asset A from successful different asset B', () => {
    const state = createMediaDeliveryState(),
      a = randomUUID(),
      b = randomUUID();
    state.observe(
      { assetId: a, state: 'generating' },
      { aggregateVoice: true },
    );
    state.observe(ready(a, 1));
    state.observe(
      ack(undefined, { voiceAsset: { assetId: b, part: 1, totalParts: 1 } }),
    );
    expect(state.hasUnresolved()).toBe(true);
  });
  it('a missing part count stays unresolved after a request-associated ACK', () => {
    const state = createMediaDeliveryState(),
      assetId = randomUUID(),
      deliveryId = randomUUID();
    state.observe({ assetId, state: 'generating' }, { aggregateVoice: true });
    state.observe({
      deliveryId,
      state: 'sending',
      requestedVoice: { assetId, part: 1 },
    });
    state.observe(ack(deliveryId));
    expect(state.hasUnresolved()).toBe(true);
    state.observe(ready(assetId, 1));
    expect(state.hasUnresolved()).toBe(false);
  });
  it('standalone send of one selected part does not imply an all-parts obligation', () => {
    const state = createMediaDeliveryState(),
      assetId = randomUUID();
    state.observe(
      ack(undefined, { voiceAsset: { assetId, part: 2, totalParts: 3 } }),
    );
    expect(state.hasUnresolved()).toBe(false);
  });
  it('blocked replacement can settle exact bytes or same immutable part; unknown never clears by another ACK', () => {
    const state = createMediaDeliveryState(),
      hash = 'a'.repeat(64),
      a = randomUUID();
    state.observe({
      deliveryId: a,
      state: 'blocked',
      artifact: { sha256: hash },
    });
    state.observe(ack(undefined, { artifact: { sha256: hash } }));
    expect(state.hasUnresolved()).toBe(false);
    state.observe({
      deliveryId: randomUUID(),
      state: 'unknown',
      artifact: { sha256: hash },
    });
    expect(state.hasUnresolved()).toBe(true);
  });
  it('ready metadata or a late pending response cannot shrink an obligation or erase an ACK', () => {
    const state = createMediaDeliveryState(),
      assetId = randomUUID(),
      deliveryId = randomUUID();
    state.observe({ assetId, state: 'generating' }, { aggregateVoice: true });
    state.observe(ready(assetId, 2));
    state.observe(
      ack(deliveryId, { voiceAsset: { assetId, part: 1, totalParts: 2 } }),
    );
    state.observe(ready(assetId, 1));
    state.observe({ deliveryId, state: 'sending' });
    expect(state.hasUnresolved()).toBe(true);
    state.observe(
      ack(undefined, { voiceAsset: { assetId, part: 2, totalParts: 2 } }),
    );
    expect(state.hasUnresolved()).toBe(false);
  });
});
