import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  ClaimedMediaIntake,
  DownloadedMedia,
  MediaIntakeAdapter,
  MediaIntakeAttempt,
  MediaIntakeFailure,
  MediaIntakeJob,
  MediaIntakeLease,
} from '@skoobi/shared/media-intake';
import {
  startOperationTraceStage,
  type OperationTraceDetails,
  type OperationTraceObserver,
  type OperationTraceOutcome,
} from '@skoobi/shared/operation-trace';
import type { LocalTranscriptionResult } from '@skoobi/shared/transcription-result';

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_JOBS_PER_DRAIN = 32;
const MAX_CANDIDATES = 256;
const POLL_MS = 1000;

/** Finite host classifications, never the original network/process error text. */
export class MediaIntakeWorkError extends Error {
  constructor(readonly reason: MediaIntakeFailure) {
    super(reason);
    this.name = 'MediaIntakeWorkError';
  }
}

export interface MediaIntakeWorkerOptions {
  adapter: MediaIntakeAdapter;
  /** Resolves only the pinned host-admitted scope, never a model-supplied path. */
  groupDirectory(job: Readonly<MediaIntakeJob>): string;
  /** Exactly ONE transfer. Write only destinationPath; do not publish/rename it.
   * Abort must destroy the transport/writer and settle only after their close.
   */
  download(
    job: Readonly<MediaIntakeJob>,
    control: {
      destinationPath: string;
      signal: AbortSignal;
      deadlineAtMs: number;
      maxBytes: number;
      trace?: OperationTraceObserver;
    },
  ): Promise<void>;
  /** The existing serialized pipeline, with no second hidden quality retry.
   * Abort must await actual child close before this promise settles.
   */
  transcribe(
    sourcePath: string,
    control: {
      signal: AbortSignal;
      deadlineAtMs: number;
      trace?: OperationTraceObserver;
    },
  ): Promise<string | null>;
  /** Versioned result from the same serialized local pipeline. When provided,
   * the legacy callback is not invoked or used as a fallback.
   */
  transcribeDetailed?(
    sourcePath: string,
    control: Parameters<MediaIntakeWorkerOptions['transcribe']>[1],
  ): Promise<LocalTranscriptionResult>;
  operationTrace?(
    job: Readonly<MediaIntakeJob>,
  ): OperationTraceObserver | undefined;
  /** Optional diagnostics are bounded codes and cannot alter work. */
  onError?(code: 'storage_unavailable' | 'worker_unavailable'): void;
  now?: () => number;
}

function sameArtifact(a: DownloadedMedia, b: DownloadedMedia): boolean {
  return (
    a.relativePath === b.relativePath &&
    a.bytes === b.bytes &&
    a.sha256 === b.sha256
  );
}
function validRelativePath(relative: string): boolean {
  return (
    relative.startsWith('received/') &&
    relative.length <= 512 &&
    /^[A-Za-z0-9_./-]+$/.test(relative) &&
    relative
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new MediaIntakeWorkError('interrupted');
}

/** Final and intermediate path components must stay regular and inside scope. */
async function scopedPath(
  root: string,
  relative: string,
  createParent: boolean,
): Promise<string> {
  if (!validRelativePath(relative))
    throw new MediaIntakeWorkError('source_changed');
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new MediaIntakeWorkError('source_changed');
  const realRoot = await fs.realpath(root);
  const pieces = relative.split('/');
  let parent = realRoot;
  for (const piece of pieces.slice(0, -1)) {
    parent = path.join(parent, piece);
    if (createParent)
      await fs.mkdir(parent, { mode: 0o700 }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new MediaIntakeWorkError('source_changed');
  }
  return path.join(parent, pieces.at(-1)!);
}

async function readMedia(
  filename: string,
  signal: AbortSignal,
): Promise<Buffer> {
  checkAbort(signal);
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > MAX_MEDIA_BYTES ||
      stat.size === 0
    ) {
      throw new MediaIntakeWorkError(
        stat.size > MAX_MEDIA_BYTES ? 'source_too_large' : 'source_changed',
      );
    }
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      checkAbort(signal);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_MEDIA_BYTES)
        throw new MediaIntakeWorkError('source_too_large');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (
      size !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw new MediaIntakeWorkError('source_changed');
    }
    return Buffer.concat(chunks, size);
  } finally {
    await handle.close();
  }
}

function describeMedia(relativePath: string, bytes: Buffer): DownloadedMedia {
  return {
    relativePath,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
async function syncFile(filename: string): Promise<void> {
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncDirectory(dirname: string): Promise<void> {
  const handle = await fs.open(dirname, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function verifyMedia(
  filename: string,
  expected: DownloadedMedia,
  signal: AbortSignal,
): Promise<Buffer> {
  const bytes = await readMedia(filename, signal);
  if (!sameArtifact(describeMedia(expected.relativePath, bytes), expected))
    throw new MediaIntakeWorkError('source_changed');
  return bytes;
}

/**
 * Runs only local media preparation. It neither starts agents nor sends notices.
 * The host adapter owns admission, leases, cancellation, ordering and the outbox.
 */
export class MediaIntakeWorker {
  private draining?: Promise<void>;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private active?: AbortController;

  constructor(private readonly options: MediaIntakeWorkerOptions) {}

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => {
      void this.wake();
    }, POLL_MS);
    this.timer.unref();
    void this.wake();
  }

  wake(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.draining) {
      this.draining = this.drain()
        .catch(() => this.noteError('worker_unavailable'))
        .finally(() => {
          this.draining = undefined;
        });
    }
    return this.draining;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.active?.abort();
    await this.draining;
  }

  private noteError(code: 'storage_unavailable' | 'worker_unavailable'): void {
    try {
      this.options.onError?.(code);
    } catch {
      /* diagnostics fail open */
    }
  }

  private async drain(): Promise<void> {
    let processed = 0;
    while (!this.stopped && processed < MAX_JOBS_PER_DRAIN) {
      let candidates: readonly Readonly<MediaIntakeJob>[];
      try {
        candidates = this.options.adapter.listReady(MAX_CANDIDATES);
      } catch {
        this.noteError('storage_unavailable');
        return;
      }
      let claimed = false;
      for (const job of candidates) {
        if (this.stopped || processed >= MAX_JOBS_PER_DRAIN) return;
        let claim: ClaimedMediaIntake | undefined;
        try {
          claim = this.options.adapter.claim(job.id);
        } catch {
          this.noteError('storage_unavailable');
          return;
        }
        if (!claim) continue;
        claimed = true;
        processed++;
        await this.process(claim);
      }
      if (!claimed) return;
    }
  }

  private async process(initial: ClaimedMediaIntake): Promise<void> {
    let current = initial;
    let attempt: MediaIntakeAttempt | undefined;
    let storageFailed = false;
    const controller = new AbortController();
    this.active = controller;
    const signal = controller.signal;
    const now = this.options.now ?? Date.now;
    let trace: OperationTraceObserver | undefined;
    try {
      trace = this.options.operationTrace?.(current.job);
    } catch {
      /* observations fail open */
    }
    const recovering =
      current.job.stage !== 'accepted' || current.job.downloadAttempts > 0;
    const recovery = startOperationTraceStage(
      recovering ? trace : undefined,
      'recovery',
      { reason: 'recovered' },
    );
    const processing = startOperationTraceStage(trace, 'ingress');
    const finishProcessing = (
      outcome: OperationTraceOutcome,
      details?: OperationTraceDetails,
    ) => {
      processing.finish(outcome, details);
      recovery.finish(outcome, details);
    };
    const database = <T>(action: () => T): T => {
      try {
        return action();
      } catch (error) {
        storageFailed = true;
        throw error;
      }
    };
    const checkCurrent = (): boolean => {
      if (now() >= current.job.deadlineAtMs || this.stopped) {
        controller.abort();
        return false;
      }
      try {
        if (this.options.adapter.isCurrent(current.lease)) return true;
      } catch {
        storageFailed = true;
        this.noteError('storage_unavailable');
      }
      controller.abort();
      return false;
    };
    const deadlineTimer = setTimeout(
      () => controller.abort(),
      Math.max(0, current.job.deadlineAtMs - now()),
    );
    const leaseTimer = setInterval(checkCurrent, POLL_MS);
    leaseTimer.unref();
    let snapshotDirectory: string | undefined;
    try {
      if (!checkCurrent()) throw new MediaIntakeWorkError('interrupted');
      if (current.job.stage === 'accepted') {
        attempt = database(() =>
          this.options.adapter.beginAttempt(current.lease, 'download'),
        );
        if (!attempt) return;
        current = attempt;
        const relative = attempt.destinationRelativePath;
        if (!relative) throw new MediaIntakeWorkError('source_changed');
        const root = this.options.groupDirectory(current.job);
        const destination = await scopedPath(root, relative, true);
        const partial = `${destination}.part`;
        let prepared = current.job.preparedDownload;
        if (!prepared) {
          // A reservation is consumed once. Stale bytes from an unprepared
          // attempt are never promoted to expected input merely by rehashing.
          await this.options.download(current.job, {
            destinationPath: partial,
            signal,
            deadlineAtMs: current.job.deadlineAtMs,
            maxBytes: MAX_MEDIA_BYTES,
            trace,
          });
          checkAbort(signal);
          await syncFile(partial);
          const bytes = await readMedia(partial, signal);
          prepared = describeMedia(relative, bytes);
          const preparedAttempt = database(() =>
            this.options.adapter.prepareDownload(attempt!, prepared!),
          );
          if (!preparedAttempt) return;
          attempt = preparedAttempt;
          current = attempt;
        }
        if (prepared.relativePath !== relative)
          throw new MediaIntakeWorkError('source_changed');
        let published = false;
        try {
          await verifyMedia(destination, prepared, signal);
          published = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (!published) {
          await verifyMedia(partial, prepared, signal);
          if (!checkCurrent()) throw new MediaIntakeWorkError('interrupted');
          await fs.rename(partial, destination);
          await syncDirectory(path.dirname(destination));
        }
        const downloaded = database(() =>
          this.options.adapter.checkpointDownload(attempt!, prepared!),
        );
        if (!downloaded) return;
        current = downloaded;
        attempt = undefined;
      }
      if (current.job.stage === 'downloaded') {
        const downloaded = current.job.downloaded;
        if (!downloaded) throw new MediaIntakeWorkError('source_changed');
        attempt = database(() =>
          this.options.adapter.beginAttempt(current.lease, 'transcribe'),
        );
        if (!attempt) return;
        current = attempt;
        const source = await scopedPath(
          this.options.groupDirectory(current.job),
          downloaded.relativePath,
          false,
        );
        const bytes = await verifyMedia(source, downloaded, signal);
        // Decode a private snapshot of the verified bytes, not a mutable group
        // pathname across an asynchronous process launch.
        snapshotDirectory = await fs.mkdtemp(
          path.join(tmpdir(), 'skoobi-intake-source-'),
        );
        await fs.chmod(snapshotDirectory, 0o700);
        const snapshot = path.join(snapshotDirectory, 'source.audio');
        await fs.writeFile(snapshot, bytes, { flag: 'wx', mode: 0o600 });
        const control = {
          signal,
          deadlineAtMs: current.job.deadlineAtMs,
          trace,
        };
        const result = this.options.transcribeDetailed
          ? await this.options.transcribeDetailed(snapshot, control)
          : undefined;
        const text = result
          ? result.text
          : await this.options.transcribe(snapshot, control);
        checkAbort(signal);
        const transcribed = database(() =>
          this.options.adapter.checkpointTranscription(attempt!, {
            text,
            sourceSha256: downloaded.sha256,
            ...(result
              ? {
                  result,
                  ...(result.status === 'empty'
                    ? { unusableReason: result.emptyReason }
                    : {}),
                }
              : {}),
          }),
        );
        if (!transcribed) {
          finishProcessing('cancelled', { reason: 'superseded' });
          return;
        }
        current = transcribed;
        attempt = undefined;
        if (current.job.stage !== 'transcribed') {
          finishProcessing(
            result?.status === 'cancelled' ? 'cancelled' : 'failed',
            {
              reason:
                result?.status === 'cancelled'
                  ? 'cancelled'
                  : 'process_failure',
            },
          );
          return;
        }
      }
      if (current.job.stage === 'transcribed') {
        const downloaded = current.job.downloaded;
        if (!downloaded) throw new MediaIntakeWorkError('source_unavailable');
        const source = await scopedPath(
          this.options.groupDirectory(current.job),
          downloaded.relativePath,
          false,
        );
        await verifyMedia(source, downloaded, signal);
        if (!checkCurrent()) throw new MediaIntakeWorkError('interrupted');
        const materialize = startOperationTraceStage(trace, 'materialize');
        let result;
        try {
          result = database(() =>
            this.options.adapter.materialize(current.lease),
          );
          materialize.finish(
            result.kind === 'materialized' ||
              result.kind === 'already_materialized'
              ? 'succeeded'
              : result.kind === 'cancelled'
                ? 'cancelled'
                : result.kind === 'stale'
                  ? 'unknown'
                  : 'failed',
          );
        } catch (error) {
          materialize.finish('failed', { reason: 'storage_failure' });
          throw error;
        }
        finishProcessing(
          result.kind === 'materialized' ||
            result.kind === 'already_materialized'
            ? 'succeeded'
            : result.kind === 'cancelled'
              ? 'cancelled'
              : result.kind === 'stale'
                ? 'unknown'
                : 'failed',
        );
      }
    } catch (error) {
      if (storageFailed) {
        this.noteError('storage_unavailable');
        finishProcessing('unknown', { reason: 'storage_failure' });
      } else {
        const reason =
          now() >= current.job.deadlineAtMs
            ? 'deadline_expired'
            : this.stopped
              ? 'interrupted'
              : error instanceof MediaIntakeWorkError
                ? error.reason
                : ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(
                      (error as NodeJS.ErrnoException)?.code || '',
                    ) && current.job.stage !== 'accepted'
                  ? 'source_unavailable'
                  : attempt?.stage === 'transcribe'
                    ? 'transcription_technical_error'
                    : 'transport_failure';
        try {
          if (this.stopped) {
            /* release after cleanup below */
          } else if (attempt) this.options.adapter.failAttempt(attempt, reason);
          else if (
            reason === 'deadline_expired' ||
            reason === 'source_changed' ||
            reason === 'source_unavailable' ||
            reason === 'storage_failure'
          )
            this.options.adapter.terminate(current.lease, reason);
        } catch {
          this.noteError('storage_unavailable');
        }
        finishProcessing(
          reason === 'deadline_expired'
            ? 'failed'
            : this.stopped
              ? 'interrupted'
              : signal.aborted
                ? 'cancelled'
                : 'failed',
          {
            reason:
              reason === 'deadline_expired'
                ? 'timeout'
                : this.stopped
                  ? 'restart'
                  : signal.aborted
                    ? 'cancelled'
                    : 'process_failure',
          },
        );
      }
    } finally {
      clearTimeout(deadlineTimer);
      clearInterval(leaseTimer);
      if (this.active === controller) this.active = undefined;
      if (snapshotDirectory)
        await fs
          .rm(snapshotDirectory, { recursive: true, force: true })
          .catch(() => {});
      // Only relinquish this token, after every actual local operation settled.
      // The adapter tolerates same-token stale revision after an uncertain commit.
      try {
        this.options.adapter.release(
          current.lease,
          this.stopped ? 'shutdown' : 'interrupted',
        );
      } catch {
        this.noteError('storage_unavailable');
      }
      finishProcessing('unknown', { reason: 'outcome_unknown' });
    }
  }
}
