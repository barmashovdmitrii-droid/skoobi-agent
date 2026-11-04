import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaimedMediaIntake,
  DownloadedMedia,
  MediaIntakeAdapter,
  MediaIntakeAttempt,
  MediaIntakeJob,
  MediaIntakeLease,
} from '@skoobi/shared/media-intake';
import type {
  OperationTraceObserver,
  OperationTraceOutcome,
  OperationTraceStage,
} from '@skoobi/shared/operation-trace';
import {
  MediaIntakeWorker,
  MediaIntakeWorkError,
} from './media-intake-worker.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'media-intake-worker-test-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const audio = Buffer.from('synthetic audio bytes');
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
function initialJob(): MediaIntakeJob {
  return {
    id: randomUUID(),
    revision: 1,
    scope: {
      botId: 'fixture',
      tenantId: 'fixture',
      chatJid: 'tg:fixture:101',
      groupFolder: 'fixture',
    },
    input: {
      message: {
        id: '1',
        chat_jid: 'tg:fixture:101',
        sender: '102',
        sender_name: 'Fixture',
        timestamp: '2026-01-01T00:00:00Z',
        sender_identity: {
          channel: 'telegram',
          chat_id: '101',
          telegram_user_id: '102',
          identity_id: 'fixture',
          is_owner_sender: false,
          telegram_message_origin: 'forwarded',
        },
      },
      media: { kind: 'voice', fileId: 'synthetic-private-file-id' },
      isGroup: false,
    },
    ingestionCursor: 'i:0000000000000001',
    acceptedAtMs: Date.now(),
    deadlineAtMs: Date.now() + 20 * 60_000,
    stage: 'accepted',
    downloadAttempts: 0,
    transcriptionAttempts: 0,
  };
}

/** Durable state is copied at every boundary, like an independent store connection.
 * Real SQLite fencing/materialization invariants are tested by the core store.
 */
function fakeStore(seed = initialJob()) {
  const job = structuredClone(seed);
  let token: string | undefined;
  let reservedPath: string | undefined = job.preparedDownload?.relativePath;
  const messages: Array<{
    text: string | null;
    cursor: string;
    origin?: string;
  }> = [];
  const notices: string[] = [];
  const own = (lease: MediaIntakeLease) =>
    lease.token === token &&
    !['cancelled', 'failed', 'materialized'].includes(job.stage);
  const snapshot = (): ClaimedMediaIntake => ({
    job: structuredClone(job),
    lease: { jobId: job.id, token: token!, revision: job.revision },
  });
  const adapter: MediaIntakeAdapter = {
    accept: () => ({ kind: 'duplicate', job: structuredClone(job) }),
    listReady: () =>
      token || ['cancelled', 'failed', 'materialized'].includes(job.stage)
        ? []
        : [structuredClone(job)],
    claim(id) {
      if (id !== job.id || token) return;
      token = randomUUID();
      job.revision++;
      return snapshot();
    },
    beginAttempt(lease, stage) {
      if (!own(lease)) return;
      if (stage === 'download' && !job.preparedDownload) {
        job.downloadAttempts++;
        reservedPath = `received/intake/${job.id}/download-${job.downloadAttempts}.oga`;
      } else if (stage === 'transcribe') job.transcriptionAttempts++;
      job.revision++;
      return {
        ...snapshot(),
        stage,
        attempt:
          stage === 'download'
            ? job.downloadAttempts
            : job.transcriptionAttempts,
        deadlineAtMs: job.deadlineAtMs,
        ...(stage === 'download'
          ? { destinationRelativePath: reservedPath }
          : {}),
      };
    },
    prepareDownload(attempt, result) {
      if (!own(attempt.lease)) return;
      job.preparedDownload = structuredClone(result);
      job.revision++;
      return { ...attempt, ...snapshot() };
    },
    checkpointDownload(attempt, result) {
      if (!own(attempt.lease)) return;
      expect(result).toEqual(job.preparedDownload);
      job.downloaded = structuredClone(result);
      job.stage = 'downloaded';
      job.revision++;
      return snapshot();
    },
    checkpointTranscription(attempt, result) {
      if (!own(attempt.lease)) return;
      job.transcribed = structuredClone(result);
      job.stage = 'transcribed';
      job.revision++;
      return snapshot();
    },
    materialize(lease) {
      if (!own(lease)) return { kind: 'stale' };
      if (job.transcribed!.text === null && !job.input.caption) {
        job.stage = 'failed';
        notices.push('transcription_unusable');
        token = undefined;
        return { kind: 'failed' };
      }
      messages.push({
        text: job.transcribed!.text,
        cursor: job.ingestionCursor,
        origin: job.input.message.sender_identity?.telegram_message_origin,
      });
      job.stage = 'materialized';
      token = undefined;
      return { kind: 'materialized', ingestionCursor: job.ingestionCursor };
    },
    failAttempt(attempt, reason) {
      if (!own(attempt.lease)) return;
      job.failure = reason;
      const retry =
        (reason === 'transport_failure' && job.downloadAttempts < 2) ||
        (reason === 'transcription_technical_error' &&
          job.transcriptionAttempts < 2);
      if (!retry) job.stage = 'failed';
      token = undefined;
      job.revision++;
    },
    release: vi.fn((lease) => {
      if (own(lease)) token = undefined;
    }),
    terminate(lease, reason) {
      if (own(lease)) {
        job.failure = reason;
        job.stage = 'failed';
        token = undefined;
      }
    },
    isCurrent: (lease) => own(lease),
  };
  return {
    adapter,
    job,
    messages,
    notices,
    cancel: () => {
      job.stage = 'cancelled';
      token = undefined;
    },
  };
}
function dependencies(store: ReturnType<typeof fakeStore>) {
  return {
    adapter: store.adapter,
    groupDirectory: () => root,
    download: vi.fn(
      async (
        _job: Readonly<MediaIntakeJob>,
        control: { destinationPath: string },
      ) => {
        await fs.writeFile(control.destinationPath, audio, { flag: 'wx' });
      },
    ),
    transcribe: vi.fn(async (file: string) => {
      expect(await fs.readFile(file)).toEqual(audio);
      return 'Synthetic transcript';
    }),
  };
}
async function seedFile(relative: string, bytes = audio): Promise<string> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return file;
}
function downloaded(
  relativePath = 'received/intake/fixture/source.oga',
): DownloadedMedia {
  return { relativePath, bytes: audio.length, sha256: digest(audio) };
}

function traceRecorder() {
  const events: Array<{
    stage: OperationTraceStage;
    outcome?: OperationTraceOutcome;
  }> = [];
  const trace: OperationTraceObserver = {
    operationIds: [],
    startStage(stage) {
      const event: (typeof events)[number] = { stage };
      events.push(event);
      return {
        finish(outcome) {
          event.outcome = outcome;
        },
      };
    },
  };
  return { trace, events };
}

describe('durable media intake worker', () => {
  it('records materialization only around the committed outer transaction', async () => {
    const store = fakeStore();
    const recording = traceRecorder();
    const original = store.adapter.materialize;
    vi.spyOn(store.adapter, 'materialize').mockImplementation((lease) => {
      expect(
        recording.events.filter((event) => event.stage === 'materialize'),
      ).toEqual([{ stage: 'materialize' }]);
      return original(lease);
    });
    await new MediaIntakeWorker({
      ...dependencies(store),
      operationTrace: () => recording.trace,
    }).wake();
    expect(
      recording.events.filter((event) => event.stage === 'materialize'),
    ).toEqual([{ stage: 'materialize', outcome: 'succeeded' }]);
    expect(store.messages).toHaveLength(1);
  });

  it('does not record successful materialization when the outer transaction throws', async () => {
    const store = fakeStore();
    const recording = traceRecorder();
    vi.spyOn(store.adapter, 'listReady')
      .mockReturnValueOnce([store.job])
      .mockReturnValue([]);
    vi.spyOn(store.adapter, 'materialize').mockImplementation(() => {
      throw new Error('Synthetic rollback');
    });
    await new MediaIntakeWorker({
      ...dependencies(store),
      operationTrace: () => recording.trace,
    }).wake();
    expect(
      recording.events.filter((event) => event.stage === 'materialize'),
    ).toEqual([{ stage: 'materialize', outcome: 'failed' }]);
    expect(
      recording.events.find((event) => event.stage === 'ingress')?.outcome,
    ).toBe('unknown');
    expect(store.messages).toHaveLength(0);
    expect(store.job.stage).toBe('transcribed');
  });

  it('observes cancellation of a fresh job without claiming it was recovery', async () => {
    const store = fakeStore();
    const deps = dependencies(store);
    const recording = traceRecorder();
    deps.transcribe.mockImplementationOnce(async () => {
      store.cancel();
      return 'Late text';
    });
    await new MediaIntakeWorker({
      ...deps,
      operationTrace: () => recording.trace,
    }).wake();
    expect(recording.events).toEqual([
      { stage: 'ingress', outcome: 'cancelled' },
    ]);
    expect(store.messages).toHaveLength(0);
  });

  it('publishes only after prepared hash, uses a private snapshot and materializes once in original order', async () => {
    const store = fakeStore();
    const deps = dependencies(store);
    const prepare = vi.spyOn(store.adapter, 'prepareDownload');
    const checkpoint = vi
      .spyOn(store.adapter, 'checkpointDownload')
      .mockImplementation((attempt, result) => {
        expect(prepare).toHaveBeenCalled();
        store.job.downloaded = structuredClone(result);
        store.job.stage = 'downloaded';
        store.job.revision++;
        return {
          job: structuredClone(store.job),
          lease: { ...attempt.lease, revision: store.job.revision },
        };
      });
    const worker = new MediaIntakeWorker(deps);
    await worker.wake();
    await worker.wake();
    expect(deps.download).toHaveBeenCalledTimes(1);
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.transcribe.mock.calls[0][0]).not.toBe(
      path.join(root, store.job.downloaded!.relativePath),
    );
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(store.messages).toEqual([
      {
        text: 'Synthetic transcript',
        cursor: 'i:0000000000000001',
        origin: 'forwarded',
      },
    ]);
    expect(
      await fs.readFile(path.join(root, store.job.downloaded!.relativePath)),
    ).toEqual(audio);
    await expect(
      fs.stat(deps.transcribe.mock.calls[0][0]),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['partial', 'published'] as const)(
    'recovers prepared %s bytes using the known hash without another download reservation',
    async (state) => {
      const job = initialJob();
      job.downloadAttempts = 1;
      job.preparedDownload = downloaded();
      await seedFile(
        job.preparedDownload.relativePath +
          (state === 'partial' ? '.part' : ''),
      );
      const store = fakeStore(job);
      const deps = dependencies(store);
      await new MediaIntakeWorker(deps).wake();
      expect(deps.download).not.toHaveBeenCalled();
      expect(store.job.downloadAttempts).toBe(1);
      expect(deps.transcribe).toHaveBeenCalledTimes(1);
      expect(store.messages).toHaveLength(1);
    },
  );

  it('rejects changed prepared bytes instead of inventing a new expected digest', async () => {
    const job = initialJob();
    job.downloadAttempts = 1;
    job.preparedDownload = downloaded();
    await seedFile(
      job.preparedDownload.relativePath + '.part',
      Buffer.from('changed'),
    );
    const store = fakeStore(job);
    const deps = dependencies(store);
    await new MediaIntakeWorker(deps).wake();
    expect(store.job.failure).toBe('source_changed');
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(store.messages).toHaveLength(0);
  });

  it.each(['downloaded', 'transcribed'] as const)(
    'reuses the persisted %s checkpoint after worker recreation',
    async (stage) => {
      const job = initialJob();
      job.stage = stage;
      job.downloadAttempts = 1;
      job.downloaded = downloaded();
      if (stage === 'transcribed')
        job.transcribed = {
          text: 'Saved exact transcript',
          sourceSha256: job.downloaded.sha256,
        };
      await seedFile(job.downloaded.relativePath);
      const store = fakeStore(JSON.parse(JSON.stringify(job)));
      const deps = dependencies(store);
      await new MediaIntakeWorker(deps).wake();
      expect(deps.download).not.toHaveBeenCalled();
      expect(deps.transcribe).toHaveBeenCalledTimes(
        stage === 'downloaded' ? 1 : 0,
      );
      expect(store.messages[0].text).toBe(
        stage === 'downloaded'
          ? 'Synthetic transcript'
          : 'Saved exact transcript',
      );
    },
  );

  it('does not turn a completed null result into another pipeline or an agent command', async () => {
    const store = fakeStore();
    const deps = dependencies(store);
    deps.transcribe.mockResolvedValueOnce(null as unknown as string);
    await new MediaIntakeWorker(deps).wake();
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(store.messages).toHaveLength(0);
    expect(store.notices).toEqual(['transcription_unusable']);
  });

  it('keeps real retries inside the durable two-attempt limit', async () => {
    const store = fakeStore();
    const deps = dependencies(store);
    deps.download.mockRejectedValue(
      new MediaIntakeWorkError('transport_failure'),
    );
    await new MediaIntakeWorker(deps).wake();
    expect(deps.download).toHaveBeenCalledTimes(2);
    expect(store.job.downloadAttempts).toBe(2);
    expect(store.job.stage).toBe('failed');
    expect(deps.transcribe).not.toHaveBeenCalled();
  });

  it('does not release a lease or return from stop before actual child shutdown', async () => {
    const store = fakeStore();
    const deps = dependencies(store);
    let started!: () => void;
    const beginning = new Promise<void>((resolve) => {
      started = resolve;
    });
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    let aborted!: () => void;
    const abortSeen = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const transcribe = vi.fn(
      async (_path: string, control: { signal: AbortSignal }) => {
        control.signal.addEventListener('abort', () => aborted(), {
          once: true,
        });
        started();
        await closed;
        return 'Late text';
      },
    );
    const worker = new MediaIntakeWorker({ ...deps, transcribe });
    const run = worker.wake();
    await beginning;
    let stopFinished = false;
    const stop = worker.stop().then(() => {
      stopFinished = true;
    });
    await abortSeen;
    expect(stopFinished).toBe(false);
    expect(store.adapter.release).not.toHaveBeenCalled();
    close();
    await stop;
    await run;
    expect(store.adapter.release).toHaveBeenCalledTimes(1);
    expect(store.messages).toHaveLength(0);
  });

  it('drops stale late output after host cancellation and keeps observers fail-open', async () => {
    const store = fakeStore();
    const deps = dependencies(store);
    deps.transcribe.mockImplementationOnce(async () => {
      store.cancel();
      return 'Late text';
    });
    const worker = new MediaIntakeWorker({
      ...deps,
      operationTrace() {
        throw new Error('private diagnostic payload');
      },
      onError() {
        throw new Error('private diagnostic payload');
      },
    });
    await worker.wake();
    expect(store.job.stage).toBe('cancelled');
    expect(store.messages).toHaveLength(0);
  });
});
