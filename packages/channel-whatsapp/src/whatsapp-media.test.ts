import { createCipheriv, createHmac } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import type { ReadableStream as NodeWebReadableStream } from 'stream/web';

import {
  getMediaKeys,
  type MediaType,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({ groupDir: '' }));

vi.mock('@skoobi/shared/group-folder', () => ({
  resolveGroupFolderPath: vi.fn(() => testState.groupDir),
}));

vi.mock('@skoobi/shared/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  downloadWhatsappMedia,
  type WhatsappMediaKind,
} from './whatsapp-media.js';

const MEDIA_KEY = Buffer.alloc(32, 0x37);
const ONE_MIB = 1024 * 1024;
const MAX_MEDIA_BYTES = 25 * ONE_MIB;

type StreamTracker = {
  produced: number;
  closed: number;
};

function mediaType(kind: WhatsappMediaKind): MediaType {
  return kind === 'voice' ? 'audio' : kind;
}

function messageFor(
  kind: WhatsappMediaKind,
  fileLength: number | undefined,
  messageId = `msg-${kind}`,
): WAMessage {
  const common = {
    url: 'https://mmg.whatsapp.net/media.enc',
    directPath: '/media.enc',
    mediaKey: MEDIA_KEY,
    ...(fileLength === undefined ? {} : { fileLength }),
  };
  const message =
    kind === 'image'
      ? { imageMessage: { ...common, mimetype: 'image/png' } }
      : kind === 'video'
        ? { videoMessage: { ...common, mimetype: 'video/mp4' } }
        : kind === 'document'
          ? {
              documentMessage: {
                ...common,
                mimetype: 'application/pdf',
                fileName: 'ordinary-report.pdf',
              },
            }
          : {
              audioMessage: {
                ...common,
                mimetype: kind === 'voice' ? 'audio/ogg' : 'audio/mpeg',
                ptt: kind === 'voice',
              },
            };
  return {
    key: { id: messageId, remoteJid: 'owner@s.whatsapp.net' },
    message,
  } as unknown as WAMessage;
}

async function encryptedWebBody(
  kind: WhatsappMediaKind,
  chunks: Iterable<Buffer>,
  tracker: StreamTracker = { produced: 0, closed: 0 },
): Promise<NodeWebReadableStream<Uint8Array>> {
  const keys = await getMediaKeys(MEDIA_KEY, mediaType(kind));
  if (!keys.macKey) throw new Error('test fixture has no MAC key');
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const hmac = createHmac('sha256', keys.macKey).update(keys.iv);

  async function* encryptedChunks(): AsyncGenerator<Buffer> {
    try {
      for (const chunk of chunks) {
        tracker.produced += 1;
        const encrypted = cipher.update(chunk);
        if (encrypted.length) {
          hmac.update(encrypted);
          yield encrypted;
        }
      }
      const final = cipher.final();
      hmac.update(final);
      yield final;
      yield hmac.digest().subarray(0, 10);
    } finally {
      tracker.closed += 1;
    }
  }

  return Readable.toWeb(
    Readable.from(encryptedChunks()),
  ) as NodeWebReadableStream<Uint8Array>;
}

function installFetch(body: NodeWebReadableStream<Uint8Array>) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function receivedEntries(): Promise<string[]> {
  return fs.readdir(path.join(testState.groupDir, 'received')).catch(() => []);
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for test state');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('downloadWhatsappMedia streaming limits', () => {
  beforeEach(async () => {
    testState.groupDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skoobi-wa-media-test-'),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await fs.rm(testState.groupDir, { recursive: true, force: true });
  });

  it.each([
    ['image', Buffer.from('ordinary image bytes')],
    ['video', Buffer.from('ordinary video bytes')],
    ['audio', Buffer.from('ordinary audio bytes')],
    ['document', Buffer.from('ordinary document bytes')],
  ] as const)(
    'streams an ordinary %s to its expected final file',
    async (kind, plain) => {
      const body = await encryptedWebBody(kind, [
        plain.subarray(0, 7),
        plain.subarray(7),
      ]);
      const fetchMock = installFetch(body);

      const result = await downloadWhatsappMedia(
        messageFor(kind, plain.length),
        'owner-group',
        kind,
      );

      expect(result).not.toBeNull();
      expect(await fs.readFile(result!.path)).toEqual(plain);
      expect(fetchMock).toHaveBeenCalledOnce();
      const request = fetchMock.mock.calls[0];
      expect(request[0]).toBe('https://mmg.whatsapp.net/media.enc');
      expect(request[1]?.signal.aborted).toBe(false);
      if (kind === 'image') expect(result!.filename).toMatch(/\.png$/);
      if (kind === 'video') expect(result!.filename).toMatch(/\.mp4$/);
      if (kind === 'audio') expect(result!.filename).toMatch(/\.mp3$/);
      if (kind === 'document') {
        expect(result!.filename).toContain('ordinary-report.pdf');
        expect(result!.originalName).toBe('ordinary-report.pdf');
      }
    },
  );

  it.each([
    ['missing', undefined],
    ['lying', 1],
    ['negative', -1],
  ] as const)(
    'rejects an over-cap decrypted stream when fileLength is %s',
    async (_label, declaredLength) => {
      const chunk = Buffer.alloc(ONE_MIB, 0x61);
      const tracker: StreamTracker = { produced: 0, closed: 0 };
      // More data remains after the cap so cancellation is observable rather
      // than merely coinciding with a normally completed response.
      const body = await encryptedWebBody(
        'document',
        Array.from({ length: 40 }, () => chunk),
        tracker,
      );
      const fetchMock = installFetch(body);

      const result = await downloadWhatsappMedia(
        messageFor('document', declaredLength),
        'owner-group',
        'document',
      );
      await flushMicrotasks();

      expect(result).toBeNull();
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
      expect(tracker.closed).toBe(1);
      expect(tracker.produced).toBeLessThan(40);
      expect(await receivedEntries()).toEqual([]);
    },
  );

  it('allows exactly 25 MiB of actual plaintext (no off-by-one over-restriction)', async () => {
    const chunk = Buffer.alloc(ONE_MIB, 0x42);
    const body = await encryptedWebBody(
      'document',
      Array.from({ length: 25 }, () => chunk),
    );
    installFetch(body);

    const result = await downloadWhatsappMedia(
      messageFor('document', MAX_MEDIA_BYTES),
      'owner-group',
      'document',
    );

    expect(result).not.toBeNull();
    expect((await fs.stat(result!.path)).size).toBe(MAX_MEDIA_BYTES);
  });

  it('fast-rejects an over-cap declared length without starting a download', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await downloadWhatsappMedia(
      messageFor('document', MAX_MEDIA_BYTES + 1),
      'owner-group',
      'document',
    );

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a guest-controlled received-directory symlink without writing outside the group', async () => {
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skoobi-wa-outside-'),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await fs.symlink(outside, path.join(testState.groupDir, 'received'));
    try {
      const result = await downloadWhatsappMedia(
        messageFor('document', 10),
        'guest-group',
        'document',
        { tier: 'guest', tenantId: 'guest-1' },
      );
      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('bounds retained WhatsApp bytes per guest tenant without restricting owner media', async () => {
    const received = path.join(testState.groupDir, 'received');
    await fs.mkdir(received);
    const existing = await fs.open(path.join(received, 'guest-fill.bin'), 'wx');
    await existing.truncate(500 * ONE_MIB);
    await existing.close();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await downloadWhatsappMedia(
      messageFor('document', 10),
      'guest-group',
      'document',
      { tier: 'guest', tenantId: 'guest-1' },
    );
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds aggregate downloads and its queue while draining an ordinary owner burst', async () => {
    const encrypted = await encryptedWebBody('document', [
      Buffer.from('small authenticated document'),
    ]);
    const encryptedParts: Buffer[] = [];
    for await (const chunk of Readable.fromWeb(encrypted)) {
      encryptedParts.push(Buffer.from(chunk));
    }
    const encryptedPayload = Buffer.concat(encryptedParts);

    const gates: Array<() => void> = [];
    const fetchMock = vi.fn().mockImplementation(async () => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return {
        ok: true,
        status: 200,
        body: Readable.toWeb(
          Readable.from([encryptedPayload]),
        ) as NodeWebReadableStream<Uint8Array>,
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    // Four active + sixteen queued are accepted. The twenty-first request is
    // rejected immediately instead of allocating another HTTP/decrypt/FD
    // pipeline or extending an attacker-controlled unbounded promise queue.
    const pending = Array.from({ length: 21 }, (_, index) =>
      downloadWhatsappMedia(
        messageFor('document', encryptedPayload.length, `burst-${index}`),
        'owner-group',
        'document',
        { tier: 'owner', tenantId: 'owner-group' },
      ),
    );
    await flushMicrotasks(16);
    await waitUntil(() => fetchMock.mock.calls.length === 4);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(await pending[20]).toBeNull();

    // Let every admitted owner download finish. Releasing a slot must hand it
    // to a queued item, and the gate must not over-restrict legitimate bursts.
    let released = 0;
    while (released < 20) {
      while (released < gates.length) {
        gates[released]();
        released += 1;
      }
      if (released < 20) {
        await waitUntil(() => gates.length > released);
      }
    }
    expect(released).toBe(20);
    const admitted = await Promise.all(pending.slice(0, 20));
    expect(admitted.every((result) => result !== null)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it('reserves download capacity for owner and caps each guest tenant', async () => {
    const encrypted = await encryptedWebBody('document', [Buffer.from('ok')]);
    const parts: Buffer[] = [];
    for await (const chunk of Readable.fromWeb(encrypted)) {
      parts.push(Buffer.from(chunk));
    }
    const payload = Buffer.concat(parts);
    const gates: Array<() => void> = [];
    const fetchMock = vi.fn().mockImplementation(async () => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return {
        ok: true,
        status: 200,
        body: Readable.toWeb(
          Readable.from([payload]),
        ) as NodeWebReadableStream<Uint8Array>,
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const active = [
      ['guest-a', 'a1'],
      ['guest-a', 'a2'],
      ['guest-b', 'b1'],
    ].map(([tenantId, id]) =>
      downloadWhatsappMedia(
        messageFor('document', 2, id),
        'guest-group',
        'document',
        { tier: 'guest', tenantId },
      ),
    );
    await waitUntil(() => fetchMock.mock.calls.length === 3);

    const queued = ['guest-c', 'guest-d', 'guest-e'].flatMap((tenantId) =>
      Array.from({ length: 4 }, (_, index) =>
        downloadWhatsappMedia(
          messageFor('document', 2, `${tenantId}-${index}`),
          'guest-group',
          'document',
          { tier: 'guest', tenantId },
        ),
      ),
    );
    await flushMicrotasks(16);
    const rejectedGuest = downloadWhatsappMedia(
      messageFor('document', 2, 'guest-overflow'),
      'guest-group',
      'document',
      { tier: 'guest', tenantId: 'guest-f' },
    );

    const owner = downloadWhatsappMedia(
      messageFor('document', 2, 'owner-reserved'),
      'owner-group',
      'document',
      { tier: 'owner', tenantId: 'owner' },
    );
    await waitUntil(() => fetchMock.mock.calls.length === 4);
    expect(await rejectedGuest).toBeNull();

    for (let index = 0; index < 4; index += 1) gates[index]();
    expect(await owner).not.toBeNull();
    let released = 4;
    while (released < 16) {
      try {
        await waitUntil(() => gates.length > released);
      } catch {
        throw new Error(
          `Guest drain stalled: released=${released}, gates=${gates.length}, fetches=${fetchMock.mock.calls.length}`,
        );
      }
      gates[released]();
      released += 1;
    }
    const guestResults = await Promise.all([...active, ...queued]);
    expect(guestResults.every((result) => result !== null)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(16);
  }, 15_000);

  it('does not publish or retain plaintext when the media MAC is invalid', async () => {
    const validBody = await encryptedWebBody('document', [
      Buffer.from('authenticated document'),
    ]);
    const parts: Buffer[] = [];
    for await (const chunk of Readable.fromWeb(validBody)) {
      parts.push(Buffer.from(chunk));
    }
    const tampered = Buffer.concat(parts);
    tampered[tampered.length - 1] ^= 0xff;
    installFetch(
      Readable.toWeb(
        Readable.from([tampered]),
      ) as NodeWebReadableStream<Uint8Array>,
    );

    const result = await downloadWhatsappMedia(
      messageFor('document', 22),
      'owner-group',
      'document',
    );

    expect(result).toBeNull();
    expect(await receivedEntries()).toEqual([]);
  });

  it('aborts and destroys a stalled response at timeout with no background continuation', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    let produced = 0;
    let cancelled = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        interval = setInterval(() => {
          produced += 1;
          // Full cipher blocks keep decrypt active without ever completing the
          // response or reaching the much larger byte cap.
          controller.enqueue(Buffer.alloc(16, produced));
        }, 1_000);
      },
      cancel() {
        cancelled += 1;
        if (interval) clearInterval(interval);
      },
    }) as unknown as NodeWebReadableStream<Uint8Array>;
    const fetchMock = installFetch(body);

    const pending = downloadWhatsappMedia(
      messageFor('document', 1),
      'owner-group',
      'document',
    );
    // The download validates/opens the destination directory before fetch.
    // Under the full parallel suite libuv's filesystem workers can be busy, so
    // a fixed number of microtask/immediate turns is not a reliable readiness
    // condition. Wait for the observable boundary with a real-time deadline;
    // setImmediate is intentionally not faked by this test.
    await waitUntil(() => fetchMock.mock.calls.length === 1);
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(60_001);
    expect(await pending).toBeNull();
    const producedAtCancel = produced;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(cancelled).toBe(1);
    expect(produced).toBe(producedAtCancel);
    expect(await receivedEntries()).toEqual([]);
  });
});
