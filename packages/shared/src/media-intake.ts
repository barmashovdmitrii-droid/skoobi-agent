import type { NewMessage } from './channel-types.js';
import type { LocalTranscriptionResult } from './transcription-result.js';

export type MediaIntakeKind = 'voice' | 'audio';
export type MediaIntakeStage =
  | 'accepted'
  | 'downloaded'
  | 'transcribed'
  | 'materialized'
  | 'cancelled'
  | 'failed';
export type MediaIntakeWorkStage = 'download' | 'transcribe';
export type MediaIntakeFailure =
  | 'transport_timeout'
  | 'transport_failure'
  | 'invalid_response'
  | 'source_unavailable'
  | 'source_changed'
  | 'source_too_large'
  | 'transcription_timeout'
  | 'transcription_technical_error'
  | 'storage_failure'
  | 'deadline_expired'
  | 'attempts_exhausted'
  | 'access_revoked'
  | 'scope_changed'
  | 'interrupted'
  | 'transcription_unusable'
  | 'no_speech'
  | 'empty'
  | 'capacity';

/** Captured once from an actual Telegram update, never from model arguments.
 * The host validates IDs/provenance consistency and derives scope itself.
 * Undefined origin remains unknown; it must never be promoted to direct.
 */
export interface MediaIntakeInput {
  message: Omit<
    NewMessage,
    | 'content'
    | 'ingestion_cursor'
    | 'is_from_me'
    | 'is_bot_message'
    | 'tenant_id'
  >;
  media: {
    kind: MediaIntakeKind;
    fileId: string;
    fileUniqueId?: string;
    fileName?: string;
    mimeType?: string;
    declaredBytes?: number;
    durationSeconds?: number;
  };
  caption?: string;
  isGroup: boolean;
}

/** Host-derived immutable scope, not supplied by callers as authority. */
export interface MediaIntakeScope {
  botId: string;
  tenantId: string;
  chatJid: string;
  groupFolder: string;
}
export interface DownloadedMedia {
  /** Exact per-claim reserved destination, relative to the admitted group.
   * Each claim/attempt has a unique path. No arbitrary caller path accepted.
   */
  relativePath: string;
  bytes: number;
  sha256: string;
}
export interface TranscribedMedia {
  /** null is a completed unusable result, never permission for a quality retry. */
  text: string | null;
  sourceSha256: string;
  unusableReason?:
    | 'empty'
    | 'no_speech'
    | 'invalid_transcript'
    | 'transcription_unavailable';
  /** Private candidate evidence; never part of the metadata-only trace. */
  result?: LocalTranscriptionResult;
}
export interface MediaIntakeJob {
  id: string;
  revision: number;
  scope: Readonly<MediaIntakeScope>;
  input: Readonly<MediaIntakeInput>;
  /** Reserved by accept alongside the empty message+original metadata. */
  ingestionCursor: string;
  acceptedAtMs: number;
  deadlineAtMs: number;
  stage: MediaIntakeStage;
  downloadAttempts: number;
  transcriptionAttempts: number;
  /** Prepared exact hash/size AFTER close/fsync, BEFORE final atomic rename. */
  preparedDownload?: Readonly<DownloadedMedia>;
  downloaded?: Readonly<DownloadedMedia>;
  transcribed?: Readonly<TranscribedMedia>;
  /** At most two charged whole-pipeline outcomes, in attempt order. */
  transcriptionAttemptsEvidence?: LocalTranscriptionResult[];
  failure?: MediaIntakeFailure;
}
/** Opaque host-issued fencing. Never put this token in logs or diagnostics. */
export interface MediaIntakeLease {
  jobId: string;
  token: string;
  revision: number;
}
export interface ClaimedMediaIntake {
  job: Readonly<MediaIntakeJob>;
  lease: MediaIntakeLease;
}
export interface MediaIntakeAttempt extends ClaimedMediaIntake {
  stage: MediaIntakeWorkStage;
  attempt: number;
  /** Host-derived deadline, unchanged since original accept. */
  deadlineAtMs: number;
  /** Unique destination returned only for download, never reused by another lease. */
  destinationRelativePath?: string;
}
export type MediaIntakeAcceptResult =
  | { kind: 'accepted' | 'duplicate'; job: Readonly<MediaIntakeJob> }
  | { kind: 'already_materialized'; ingestionCursor: string }
  | { kind: 'rejected'; reason: 'not_admitted' | 'source_conflict' }
  | { kind: 'rejected'; reason: 'capacity'; job: Readonly<MediaIntakeJob> };
export type MediaIntakeCommitResult =
  | { kind: 'materialized' | 'already_materialized'; ingestionCursor: string }
  | { kind: 'dropped' | 'cancelled' | 'stale' | 'failed' };

/** Synchronous durable host operations; each successful return is a DB commit.
 * Factory is bound to the real bot config and current process instance.
 * Rejected persistence throws a typed error; it must NOT fall back to legacy work.
 */
export interface MediaIntakeAdapter {
  accept(input: MediaIntakeInput): MediaIntakeAcceptResult;
  /** Bounded potential candidates in original ingestion order, scoped to this bot.
   * claim remains authoritative for alive/dead owner and current access checks.
   */
  listReady(limit: number): readonly Readonly<MediaIntakeJob>[];
  /** Never steals another live/unknown process's lease merely because it aged. */
  claim(jobId: string): ClaimedMediaIntake | undefined;
  /** Reserves one attempt and its unique path durably BEFORE network/child work.
   * Every operation ignores caller snapshots as authority: it reads job/scope/
   * counters/path from DB after validating lease jobId+token+revision.
   */
  beginAttempt(
    lease: MediaIntakeLease,
    stage: MediaIntakeWorkStage,
  ): MediaIntakeAttempt | undefined;
  /** Persist exact expected hash/size after fsync and before atomic rename. */
  prepareDownload(
    attempt: MediaIntakeAttempt,
    result: DownloadedMedia,
  ): MediaIntakeAttempt | undefined;
  /** Requires matching prepared data. Recovery verifies that known hash, never
   * promotes an uncheckpointed file by inventing a new expected digest.
   */
  checkpointDownload(
    attempt: MediaIntakeAttempt,
    result: DownloadedMedia,
  ): ClaimedMediaIntake | undefined;
  /** Only a returned transcribed stage permits materialization. Other returned
   * stages are terminal/retry receipts whose old lease is already revoked. */
  checkpointTranscription(
    attempt: MediaIntakeAttempt,
    result: TranscribedMedia,
  ): ClaimedMediaIntake | undefined;
  /** Uses only pinned source + stored checkpoint. Atomic job/message/metadata commit. */
  materialize(lease: MediaIntakeLease): MediaIntakeCommitResult;
  /** Store decides retryability from finite reason + persisted counters/deadline. */
  failAttempt(attempt: MediaIntakeAttempt, reason: MediaIntakeFailure): void;
  /** Called only after work has stopped; shutdown/interruption is a recorded outcome. */
  release(lease: MediaIntakeLease, reason: 'shutdown' | 'interrupted'): void;
  /** Terminal boundary failure, without inventing a new processing attempt. */
  terminate(
    lease: MediaIntakeLease,
    reason:
      | 'source_changed'
      | 'source_unavailable'
      | 'deadline_expired'
      | 'storage_failure',
  ): void;
  /** Current token/scope/access/deadline check; false requires abort/no further commit. */
  isCurrent(lease: MediaIntakeLease): boolean;
}

/** No update was durably accepted. Polling must stop before acknowledging it. */
export class MediaIntakePersistenceError extends Error {
  constructor() {
    super('Media intake persistence unavailable');
    this.name = 'MediaIntakePersistenceError';
  }
}
