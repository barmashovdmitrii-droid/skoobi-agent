import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, it, expect } from 'vitest';
import { waitForDeliveryReceipt } from './delivery-ipc.js';
const roots: string[] = [];
const fixture = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-wait-'));
  roots.push(directory);
  const deliveryId = randomUUID();
  return { directory, deliveryId, requestId: deliveryId, timeoutMs: 0 };
};
afterEach(() =>
  roots
    .splice(0)
    .forEach((p) => fs.rmSync(p, { recursive: true, force: true })),
);
it('timeout remains pending, never claims successful delivery', async () => {
  expect(
    JSON.parse((await waitForDeliveryReceipt(fixture())).content[0].text),
  ).toMatchObject({ state: 'checking', code: 'pending_query_delivery_status' });
});
it('allows only safe receipt fields and marks failed or ambiguous outcome as error', async () => {
  for (const state of ['delivered', 'blocked', 'unknown']) {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.directory, `${f.requestId}.delivery.json`),
      JSON.stringify({
        deliveryId: f.deliveryId,
        state,
        code: 'fixture_result',
        secretPath: '/private/never',
        rawError: 'sensitive',
      }),
    );
    const r = await waitForDeliveryReceipt(f);
    expect(r.content[0].text).not.toContain('private');
    expect(r.content[0].text).not.toContain('sensitive');
    expect(!!r.isError).toBe(state !== 'delivered');
  }
});
it('refuses symlink and oversized response without reading its contents', async () => {
  const f = fixture();
  const target = path.join(f.directory, 'target');
  fs.writeFileSync(target, 'x'.repeat(17_000));
  fs.symlinkSync(
    target,
    path.join(f.directory, `${f.requestId}.delivery.json`),
  );
  expect((await waitForDeliveryReceipt(f)).isError).toBe(true);
});

it('a stale durable-id response cannot answer a new wire request', async () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.directory, `${f.deliveryId}.delivery.json`),
    JSON.stringify({
      deliveryId: f.deliveryId,
      state: 'delivered',
      code: 'api_acknowledged',
    }),
  );
  const requestId = randomUUID();
  expect(
    JSON.parse(
      (await waitForDeliveryReceipt({ ...f, requestId })).content[0].text,
    ).state,
  ).toBe('checking');
  fs.writeFileSync(
    path.join(f.directory, `${requestId}.delivery.json`),
    JSON.stringify({
      deliveryId: f.deliveryId,
      state: 'blocked',
      code: 'checks_failed',
    }),
  );
  expect(
    JSON.parse(
      (await waitForDeliveryReceipt({ ...f, requestId })).content[0].text,
    ).state,
  ).toBe('blocked');
});
