import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OperationTraceObserver,
  OperationTraceDetails,
  OperationTraceOutcome,
  OperationTraceStage,
} from '@skoobi/shared/operation-trace';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('@skoobi/shared/group-folder', () => ({
  resolveGroupFolderPath: () => state.root,
}));
vi.mock('@skoobi/shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { downloadTelegramAudio } from './audio-telegram.js';

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(tmpdir(), 'telegram-audio-trace-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(state.root, { recursive: true, force: true });
});

function recordingTrace() {
  const events: Array<{
    stage: OperationTraceStage;
    initial: OperationTraceDetails;
    outcome?: OperationTraceOutcome;
    details?: OperationTraceDetails;
  }> = [];
  const trace: OperationTraceObserver = {
    operationIds: ['00000000-0000-4000-8000-000000000001'],
    startStage(stage, initial = {}) {
      const event: (typeof events)[number] = { stage, initial };
      events.push(event);
      return {
        finish(outcome, details) {
          Object.assign(event, { outcome, details });
        },
      };
    },
  };
  return { trace, events };
}

/** All requests terminate in a local stream; this fixture cannot contact Telegram. */
function fakeTransport(downloadFailures: number, metadataValid = true) {
  let downloads = 0;
  const get = vi.spyOn(https, 'get').mockImplementation(((
    url: string,
    callback: (res: PassThrough) => void,
  ) => {
    const request = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      destroy(error?: Error) {
        if (error) queueMicrotask(() => request.emit('error', error));
      },
    });
    setImmediate(() => {
      if (url.includes('/getFile?')) {
        const response = new PassThrough();
        callback(response);
        response.end(
          JSON.stringify(
            metadataValid
              ? {
                  ok: true,
                  result: { file_path: 'private-folder/private-file.oga' },
                }
              : { ok: false },
          ),
        );
        return;
      }
      downloads += 1;
      if (downloads <= downloadFailures) {
        request.emit(
          'error',
          Object.assign(new Error('private transport payload'), {
            code: 'ECONNRESET',
          }),
        );
        return;
      }
      const response = Object.assign(new PassThrough(), {
        statusCode: 200,
        setTimeout: vi.fn(),
      });
      callback(response);
      response.end('synthetic audio');
    });
    return request;
  }) as unknown as typeof https.get);
  return { get, downloads: () => downloads };
}

describe('Telegram audio operation tracing', () => {
  it('links metadata and exactly two bounded transfer attempts without private payloads', async () => {
    const transport = fakeTransport(1);
    const { trace, events } = recordingTrace();
    const result = await downloadTelegramAudio(
      'private-token',
      'private-file-id',
      'private-group',
      'voice',
      trace,
    );
    expect(result).toEqual(expect.any(String));
    expect(await fs.readFile(result!, 'utf8')).toBe('synthetic audio');
    expect(transport.get).toHaveBeenCalledTimes(3);
    expect(transport.downloads()).toBe(2);
    expect(events).toEqual([
      { stage: 'get_file', initial: {}, outcome: 'succeeded', details: {} },
      {
        stage: 'download',
        initial: { passIndex: 1 },
        outcome: 'failed',
        details: { reason: 'network_failure' },
      },
      {
        stage: 'download',
        initial: { passIndex: 2, reason: 'retry' },
        outcome: 'succeeded',
        details: { bytes: Buffer.byteLength('synthetic audio') },
      },
    ]);
    const diagnostic = JSON.stringify(events);
    for (const value of [
      'private-token',
      'private-file-id',
      'private-group',
      'private-folder',
      'private transport payload',
      state.root,
    ])
      expect(diagnostic).not.toContain(value);
  });

  it('ends both failed attempts without adding retries or a successful outcome', async () => {
    const transport = fakeTransport(10);
    const { trace, events } = recordingTrace();
    await expect(
      downloadTelegramAudio(
        'fixture-token',
        'fixture-file',
        'fixture-group',
        'voice',
        trace,
      ),
    ).resolves.toBeNull();
    expect(transport.get).toHaveBeenCalledTimes(3);
    expect(
      events
        .filter((event) => event.stage === 'download')
        .map((event) => event.outcome),
    ).toEqual(['failed', 'failed']);
  });

  it('marks invalid metadata and never attempts a transfer', async () => {
    const transport = fakeTransport(0, false);
    const { trace, events } = recordingTrace();
    await expect(
      downloadTelegramAudio(
        'fixture-token',
        'fixture-file',
        'fixture-group',
        'voice',
        trace,
      ),
    ).resolves.toBeNull();
    expect(transport.get).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {
        stage: 'get_file',
        initial: {},
        outcome: 'failed',
        details: { reason: 'invalid_response' },
      },
    ]);
  });

  it.each(['start', 'finish'] as const)(
    'returns the downloaded file when trace %s throws',
    async (failure) => {
      const transport = fakeTransport(0);
      const trace: OperationTraceObserver = {
        operationIds: [],
        startStage() {
          if (failure === 'start') throw new Error('diagnostic unavailable');
          return {
            finish() {
              throw new Error('diagnostic unavailable');
            },
          };
        },
      };
      const result = await downloadTelegramAudio(
        'fixture-token',
        'fixture-file',
        'fixture-group',
        'voice',
        trace,
      );
      expect(result).toEqual(expect.any(String));
      expect(await fs.readFile(result!, 'utf8')).toBe('synthetic audio');
      expect(transport.get).toHaveBeenCalledTimes(2);
    },
  );
});

describe('durable worker audio transport controls', () => {
  it('destroys a hanging transfer and closes its partial file before cancellation settles', async () => {
    const controller = new AbortController();
    const requests: Array<
      EventEmitter & { destroyed: boolean; destroy: () => void }
    > = [];
    let body: PassThrough | undefined;
    vi.spyOn(https, 'get').mockImplementation(((
      url: string,
      callback: (response: PassThrough) => void,
    ) => {
      const request = Object.assign(new EventEmitter(), {
        destroyed: false,
        setTimeout: vi.fn(),
        destroy() {
          this.destroyed = true;
        },
      });
      requests.push(request);
      setImmediate(() => {
        const response = Object.assign(new PassThrough(), {
          statusCode: 200,
          setTimeout: vi.fn(),
        });
        callback(response);
        if (url.includes('/getFile?')) {
          response.end(
            JSON.stringify({ ok: true, result: { file_path: 'fixture.oga' } }),
          );
          return;
        }
        body = response;
        response.write('partial audio');
        setImmediate(() => controller.abort());
        // No end event: the control must stop the stream rather than wait for it.
      });
      return request;
    }) as unknown as typeof https.get);
    const destinationPath = path.join(state.root, 'received', 'reserved.part');
    await expect(
      downloadTelegramAudio(
        'fixture-token',
        'fixture-file',
        'fixture-group',
        'voice',
        undefined,
        {
          destinationPath,
          signal: controller.signal,
          deadlineAtMs: Date.now() + 60_000,
          maxBytes: 1024,
          maxAttempts: 1,
        },
      ),
    ).resolves.toBeNull();
    expect(requests).toHaveLength(2);
    expect(requests[1].destroyed).toBe(true);
    expect(body?.destroyed).toBe(true);
    await expect(fs.stat(destinationPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(body?.write('late bytes')).toBe(false);
    await expect(fs.stat(destinationPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('performs one reserved transfer without the legacy implicit retry', async () => {
    const transport = fakeTransport(10);
    const destinationPath = path.join(state.root, 'received', 'reserved.part');
    const controller = new AbortController();
    await expect(
      downloadTelegramAudio(
        'fixture-token',
        'fixture-file',
        'fixture-group',
        'voice',
        undefined,
        {
          destinationPath,
          signal: controller.signal,
          deadlineAtMs: Date.now() + 60_000,
          maxBytes: 1024,
          maxAttempts: 1,
        },
      ),
    ).resolves.toBeNull();
    expect(transport.get).toHaveBeenCalledTimes(2);
    expect(transport.downloads()).toBe(1);
    await expect(fs.stat(destinationPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('bounds actual bytes and preserves an existing file on exclusive-create failure', async () => {
    const transport = fakeTransport(0);
    const destinationPath = path.join(state.root, 'received', 'reserved.part');
    await fs.mkdir(path.dirname(destinationPath));
    const control = {
      destinationPath,
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 60_000,
      maxBytes: 2,
      maxAttempts: 1 as const,
    };
    await expect(
      downloadTelegramAudio(
        'fixture-token',
        'fixture-file',
        'fixture-group',
        'voice',
        undefined,
        control,
      ),
    ).resolves.toBeNull();
    await expect(fs.stat(destinationPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await fs.writeFile(destinationPath, 'existing bytes');
    await expect(
      downloadTelegramAudio(
        'fixture-token',
        'fixture-file',
        'fixture-group',
        'voice',
        undefined,
        { ...control, maxBytes: 1024 },
      ),
    ).resolves.toBeNull();
    expect(await fs.readFile(destinationPath, 'utf8')).toBe('existing bytes');
    expect(transport.downloads()).toBe(2);
  });

  it('makes no request for an already cancelled job', async () => {
    const transport = fakeTransport(0);
    const controller = new AbortController();
    controller.abort();
    await expect(
      downloadTelegramAudio(
        'fixture-token',
        'fixture-file',
        'fixture-group',
        'voice',
        undefined,
        {
          destinationPath: path.join(state.root, 'received', 'reserved.part'),
          signal: controller.signal,
          deadlineAtMs: Date.now() + 60_000,
          maxBytes: 1024,
          maxAttempts: 1,
        },
      ),
    ).resolves.toBeNull();
    expect(transport.get).not.toHaveBeenCalled();
  });
});
