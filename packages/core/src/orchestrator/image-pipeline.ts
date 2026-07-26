import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';

import { DATA_DIR } from './config.js';
import {
  claimImageJobFailureNotice,
  claimImageJobGeneration,
  createImageJobArtifact,
  createImageJob,
  getImageJobArtifactByCallId,
  getImageJobArtifacts,
  getImageJobById,
  getImageJobsPendingFailureNotice,
  getRecoverableImageJobs,
  markAllImageJobArtifactsDelivered,
  markImageJobArtifactDelivered,
  markImageJobArtifactDelivering,
  markImageJobArtifactDeliveryPending,
  markImageJobArtifactFailed,
  markImageJobDelivered,
  markImageJobFailed,
  markImageJobFailureNotified,
  markImageJobGenerationCompleted,
  markImageJobGenerationRetryable,
  recordImageJobGenerationCalls,
  releaseImageJobFailureNotice,
  type ImageJobArtifactRecord,
  type ImageJobRecord,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import type { MessageRouter } from './types.js';

const GENERATED_IMAGES_DIR = 'generated_images';
const MAX_GENERATED_FILES = 2_000;
const MAX_SCAN_DEPTH = 4;
const MAX_ROLLOUT_FILES = 6;
const MAX_ROLLOUT_BYTES_PER_FILE = 64 * 1024 * 1024;
const MAX_ROLLOUT_INDEX_FILES = 2_000;
// Some Linux/container filesystems expose coarser mtimes than JavaScript's
// millisecond clock. Exact rollout ownership still requires the per-job marker
// and an in-window event timestamp; this narrow skew only prevents a freshly
// written artifact from being discarded after sub-second mtime truncation.
const ROLLOUT_ARTIFACT_MTIME_SKEW_MS = 2_000;
const MAX_TELEGRAM_PHOTO_BYTES = 49 * 1024 * 1024;
const MIN_IMAGE_BYTES = 128;
const STALE_GENERATION_MS = 20 * 60 * 1000;
const STALE_DELIVERY_MS = 20 * 60 * 1000;
const MAX_GENERATION_ATTEMPTS = 2;
// Telegram outages and reconnect windows commonly outlast a few minutes. Keep
// retrying the same staged bytes for up to an hour of periodic sweeps before a
// terminal notice; generation is never repeated during this window.
const MAX_DELIVERY_ATTEMPTS = 60;

type GeneratedImageSnapshot = Map<string, string>;

export interface ImageJobRunContext {
  job: ImageJobRecord;
  codexHome: string;
  workspaceRoot?: string;
  generatedBefore: GeneratedImageSnapshot;
  startedAtMs: number;
  generationRequired: boolean;
  generationAttempt: number;
}

export interface CodexGeneratedImageArtifact {
  callId: string;
  savedPath: string;
}

export interface ImageJobFinalizeResult {
  delivered: boolean;
  artifactPath?: string;
  artifactPaths?: string[];
  deliveredCount?: number;
  error?: string;
  deliveryAlreadyHandled?: boolean;
  deliveryDeferred?: boolean;
  deliveryPending?: boolean;
  terminalFailure?: boolean;
  automaticRetrySuppressed?: boolean;
  generationRetryable?: boolean;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (Boolean(relative) &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative))
  );
}

function generatedRoot(codexHome: string): string {
  return path.join(path.resolve(codexHome), GENERATED_IMAGES_DIR);
}

interface GeneratedCandidate {
  filePath: string;
  mtimeMs: number;
  fingerprint: string;
}

interface RolloutImageArtifact extends CodexGeneratedImageArtifact {
  timestampMs: number;
}

interface RolloutImageEvidence {
  callIds: string[];
  artifacts: RolloutImageArtifact[];
}

function decodeJsonStringFragment(value: string): string | null {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return null;
  }
}

function collectRecentRolloutFiles(
  codexHome: string,
  notBeforeMs: number,
): string[] {
  const sessionsRoot = path.join(codexHome, 'sessions');
  const files: Array<{ filePath: string; mtimeMs: number }> = [];
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: sessionsRoot, depth: 0 },
  ];
  let indexed = 0;
  while (stack.length > 0 && indexed < MAX_ROLLOUT_INDEX_FILES) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      indexed++;
      if (indexed > MAX_ROLLOUT_INDEX_FILES) break;
      const candidate = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < MAX_SCAN_DEPTH) {
        stack.push({ dir: candidate, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const stat = fs.statSync(candidate);
        if (stat.mtimeMs >= notBeforeMs - 60_000) {
          files.push({ filePath: candidate, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // A concurrently rotated rollout can disappear between readdir/stat.
      }
    }
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_ROLLOUT_FILES)
    .map((item) => item.filePath);
}

function readBoundedRolloutTail(filePath: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const length = Math.min(stat.size, MAX_ROLLOUT_BYTES_PER_FILE);
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, stat.size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort only.
      }
    }
  }
}

function exactImageEvidenceFromRollouts(input: {
  codexHome: string;
  jobId: string;
  generationAttempt: number;
  notBeforeMs: number;
  notAfterMs: number;
}): RolloutImageEvidence {
  const byCallId = new Map<string, RolloutImageArtifact>();
  const completedCallIds = new Set<string>();
  for (const rollout of collectRecentRolloutFiles(
    input.codexHome,
    input.notBeforeMs,
  )) {
    const tail = readBoundedRolloutTail(rollout);
    // Time alone is not an ownership proof: another image turn in the same
    // Codex home can overlap this job's crash window. Every host-owned image
    // prompt carries its durable job marker, so only that rollout may repair
    // the runner->DB crash gap.
    const marker = officialImagegenJobMarker(
      input.jobId,
      input.generationAttempt,
    );
    const markerOffset = tail.lastIndexOf(marker);
    if (markerOffset < 0) continue;
    const nextMarkerOffset = tail.indexOf(
      '<skoobi_image_job_id_attempt_',
      markerOffset + marker.length,
    );
    const ownedTurn = tail.slice(
      markerOffset,
      nextMarkerOffset < 0 ? undefined : nextMarkerOffset,
    );
    for (const line of ownedTurn.split('\n')) {
      if (
        !line.includes('image_generation_end') ||
        !line.includes('"status":"completed"')
      ) {
        continue;
      }
      const timestampRaw = /"timestamp":"((?:\\.|[^"\\])*)"/.exec(line)?.[1];
      const callIdRaw = /"call_id":"((?:\\.|[^"\\])*)"/.exec(line)?.[1];
      const savedPathRaw = /"saved_path":"((?:\\.|[^"\\])*)"/.exec(line)?.[1];
      const decodedCallId = callIdRaw
        ? decodeJsonStringFragment(callIdRaw)
        : null;
      const timestamp = timestampRaw
        ? decodeJsonStringFragment(timestampRaw)
        : null;
      let timestampMs = timestamp ? new Date(timestamp).getTime() : NaN;
      if (
        Number.isFinite(timestampMs) &&
        (timestampMs < input.notBeforeMs || timestampMs > input.notAfterMs)
      ) {
        continue;
      }
      if (decodedCallId) completedCallIds.add(decodedCallId);
      if (!savedPathRaw) continue;
      const savedPath = decodeJsonStringFragment(savedPathRaw);
      if (!savedPath) continue;
      try {
        const imageStat = fs.statSync(savedPath);
        if (!Number.isFinite(timestampMs)) timestampMs = imageStat.mtimeMs;
        if (timestampMs < input.notBeforeMs || timestampMs > input.notAfterMs) {
          continue;
        }
        if (
          imageStat.mtimeMs <
          input.notBeforeMs - ROLLOUT_ARTIFACT_MTIME_SKEW_MS
        ) {
          continue;
        }
      } catch {
        continue;
      }
      const callId =
        decodedCallId ||
        `rollout-${createHash('sha256')
          .update(`${rollout}:${savedPath}:${timestampMs}`)
          .digest('hex')
          .slice(0, 24)}`;
      completedCallIds.add(callId);
      byCallId.set(callId, { callId, savedPath, timestampMs });
    }
  }
  return {
    callIds: [...completedCallIds],
    artifacts: [...byCallId.values()].sort(
      (a, b) =>
        a.timestampMs - b.timestampMs || a.callId.localeCompare(b.callId),
    ),
  };
}

function collectGeneratedCandidates(codexHome: string): GeneratedCandidate[] {
  let homeReal: string;
  try {
    homeReal = fs.realpathSync(codexHome);
  } catch {
    return [];
  }
  const root = generatedRoot(homeReal);
  let rootReal: string;
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
    rootReal = fs.realpathSync(root);
  } catch {
    return [];
  }
  if (!isWithin(homeReal, rootReal)) return [];

  const results: GeneratedCandidate[] = [];
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: rootReal, depth: 0 },
  ];
  while (stack.length > 0 && results.length < MAX_GENERATED_FILES) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAX_SCAN_DEPTH) {
          stack.push({ dir: candidate, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      let real: string;
      let stat: fs.Stats;
      try {
        real = fs.realpathSync(candidate);
        if (!isWithin(rootReal, real)) continue;
        stat = fs.statSync(real);
      } catch {
        continue;
      }
      if (
        !stat.isFile() ||
        stat.size < MIN_IMAGE_BYTES ||
        stat.size > MAX_TELEGRAM_PHOTO_BYTES
      ) {
        continue;
      }
      if (!detectImageExtension(real)) continue;
      results.push({
        filePath: real,
        mtimeMs: stat.mtimeMs,
        fingerprint: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
      });
      if (results.length >= MAX_GENERATED_FILES) break;
    }
  }
  return results;
}

export function snapshotCodexGeneratedImages(
  codexHome: string,
): GeneratedImageSnapshot {
  return new Map(
    collectGeneratedCandidates(codexHome).map((item) => [
      item.filePath,
      item.fingerprint,
    ]),
  );
}

function newestGeneratedImage(input: {
  codexHome: string;
  generatedBefore?: GeneratedImageSnapshot;
  notBeforeMs: number;
}): string | null {
  const toleranceMs = 5_000;
  const candidates = collectGeneratedCandidates(input.codexHome)
    .filter(
      (item) =>
        input.generatedBefore?.get(item.filePath) !== item.fingerprint &&
        item.mtimeMs >= input.notBeforeMs - toleranceMs,
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.filePath || null;
}

function detectImageExtension(
  filePath: string,
): '.png' | '.jpg' | '.webp' | null {
  let header: Buffer;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    header = Buffer.alloc(12);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    header = header.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort only.
      }
    }
  }
  if (
    header.length >= 8 &&
    header
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return '.png';
  }
  if (
    header.length >= 3 &&
    header[0] === 0xff &&
    header[1] === 0xd8 &&
    header[2] === 0xff
  ) {
    return '.jpg';
  }
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString('ascii') === 'RIFF' &&
    header.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return '.webp';
  }
  return null;
}

function stageGeneratedImage(input: {
  job: ImageJobRecord;
  sourcePath: string;
  workspaceRoot?: string;
  artifactKey?: string;
}): string {
  const extension = detectImageExtension(input.sourcePath);
  if (!extension)
    throw new Error('Generated artifact is not a supported image');

  const groupRoot = fs.realpathSync(
    input.workspaceRoot || resolveGroupFolderPath(input.job.group_folder),
  );
  const outputDir = path.join(groupRoot, 'output', 'imagegen');
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const outputReal = fs.realpathSync(outputDir);
  if (!isWithin(groupRoot, outputReal)) {
    throw new Error('Image output directory escaped the chat workspace');
  }

  const suffix = input.artifactKey
    ? `-${createHash('sha256').update(input.artifactKey).digest('hex').slice(0, 16)}`
    : '';
  const destination = path.join(
    outputReal,
    `${input.job.id}${suffix}${extension}`,
  );
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !detectImageExtension(destination)
    ) {
      throw new Error('Existing staged image is unsafe or invalid');
    }
    return destination;
  }
  fs.copyFileSync(input.sourcePath, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  if (!detectImageExtension(destination)) {
    fs.rmSync(destination, { force: true });
    throw new Error('Staged image failed validation');
  }
  return destination;
}

function artifactPaths(job: ImageJobRecord): string[] {
  if (!job.artifact_paths_json) return [];
  try {
    const parsed = JSON.parse(job.artifact_paths_json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function generationCallIds(job: ImageJobRecord): string[] {
  if (!job.generation_call_ids_json) return [];
  try {
    const parsed = JSON.parse(job.generation_call_ids_json) as unknown;
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed.filter(
              (callId): callId is string => typeof callId === 'string',
            ),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

function materializeLegacyArtifacts(
  job: ImageJobRecord,
): ImageJobArtifactRecord[] {
  let artifacts = getImageJobArtifacts(job.id);
  if (artifacts.length > 0) return artifacts;
  for (const [index, stagedPath] of artifactPaths(job).entries()) {
    if (!fs.existsSync(stagedPath) || !detectImageExtension(stagedPath))
      continue;
    const callId = `legacy-${index}-${createHash('sha256')
      .update(stagedPath)
      .digest('hex')
      .slice(0, 16)}`;
    createImageJobArtifact({
      id: `imgart-${randomUUID()}`,
      jobId: job.id,
      callId,
      sourcePath: stagedPath,
      stagedPath,
      now: job.generated_at || job.updated_at,
    });
  }
  artifacts = getImageJobArtifacts(job.id);
  return artifacts;
}

function ensureStagedArtifact(input: {
  job: ImageJobRecord;
  artifact: ImageJobArtifactRecord;
  workspaceRoot?: string;
}): boolean {
  if (
    fs.existsSync(input.artifact.staged_path) &&
    Boolean(detectImageExtension(input.artifact.staged_path))
  ) {
    return true;
  }
  try {
    const repaired = stageGeneratedImage({
      job: input.job,
      sourcePath: input.artifact.source_path,
      workspaceRoot: input.workspaceRoot,
      artifactKey: input.artifact.call_id,
    });
    return (
      repaired === input.artifact.staged_path &&
      Boolean(detectImageExtension(repaired))
    );
  } catch {
    return false;
  }
}

/**
 * Persist the exact image_gen result as soon as its end event arrives. The
 * staged copy, call id, order, and delivery state survive a runner crash, so a
 * later finalize/recovery pass never needs to guess which generated file
 * belongs to the request.
 */
export function recordCodexImageArtifacts(input: {
  context: ImageJobRunContext;
  artifacts: CodexGeneratedImageArtifact[];
}): ImageJobArtifactRecord[] {
  const currentJob = getImageJobById(input.context.job.id);
  if (
    !currentJob ||
    currentJob.generation_attempts !== input.context.generationAttempt
  ) {
    // A reclaimed generation lease owns the job now. Late frames from the
    // previous runner must not mix artifacts into, or complete, that attempt.
    return currentJob ? getImageJobArtifacts(currentJob.id) : [];
  }
  const failures: string[] = [];
  for (const artifact of input.artifacts) {
    try {
      const callId = artifact.callId.trim();
      if (!callId) throw new Error('image_gen result is missing call_id');
      const existing = getImageJobArtifactByCallId(
        input.context.job.id,
        callId,
      );
      if (existing) continue;
      const sourcePath = path.resolve(artifact.savedPath);
      const stagedPath = stageGeneratedImage({
        job: input.context.job,
        sourcePath,
        workspaceRoot: input.context.workspaceRoot,
        artifactKey: callId,
      });
      createImageJobArtifact({
        id: `imgart-${randomUUID()}`,
        jobId: input.context.job.id,
        callId,
        sourcePath,
        stagedPath,
        expectedGenerationAttempt: input.context.generationAttempt,
      });
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} image artifact(s) could not be checkpointed: ${failures.join('; ')}`,
    );
  }
  return getImageJobArtifacts(input.context.job.id);
}

export function recoverCodexImageArtifactsFromRollouts(input: {
  context: ImageJobRunContext;
  nowMs?: number;
}): ImageJobArtifactRecord[] {
  const createdAtMs = new Date(input.context.job.created_at).getTime();
  const nowMs = input.nowMs ?? Date.now();
  const evidence = exactImageEvidenceFromRollouts({
    codexHome: input.context.codexHome,
    jobId: input.context.job.id,
    generationAttempt: input.context.generationAttempt,
    notBeforeMs: createdAtMs,
    notAfterMs: Math.min(
      nowMs + 5_000,
      createdAtMs + STALE_GENERATION_MS + 5_000,
    ),
  });
  if (evidence.callIds.length > 0) {
    recordImageJobGenerationCalls({
      id: input.context.job.id,
      expectedGenerationAttempt: input.context.generationAttempt,
      callIds: evidence.callIds,
    });
  }
  if (evidence.artifacts.length > 0) {
    recordCodexImageArtifacts({
      context: input.context,
      artifacts: evidence.artifacts.map(({ callId, savedPath }) => ({
        callId,
        savedPath,
      })),
    });
  }
  return getImageJobArtifacts(input.context.job.id);
}

async function deliverStagedImage(input: {
  job: ImageJobRecord;
  artifact: ImageJobArtifactRecord;
  router: MessageRouter;
}): Promise<ImageJobFinalizeResult> {
  const claimed = markImageJobArtifactDelivering(
    input.artifact.id,
    MAX_DELIVERY_ATTEMPTS,
  );
  if (!claimed) {
    const current = getImageJobArtifacts(input.job.id).find(
      (artifact) => artifact.id === input.artifact.id,
    );
    if (current?.status === 'delivered') {
      return {
        delivered: true,
        artifactPath: current.staged_path,
        deliveryAlreadyHandled: true,
      };
    }
    if (current?.status === 'delivering') {
      return {
        delivered: false,
        artifactPath: current.staged_path,
        error: 'Image delivery is already in progress',
        deliveryDeferred: true,
      };
    }
    const error = `Telegram delivery was not confirmed after ${MAX_DELIVERY_ATTEMPTS} attempts`;
    if (current?.status === 'generated') {
      if (current.delivery_attempts >= MAX_DELIVERY_ATTEMPTS) {
        markImageJobArtifactFailed(current.id, error);
      } else {
        return {
          delivered: false,
          artifactPath: current.staged_path,
          error: 'An earlier image in this job is still pending delivery',
          deliveryDeferred: true,
        };
      }
    }
    return {
      delivered: false,
      artifactPath: current?.staged_path || input.artifact.staged_path,
      error,
      terminalFailure: true,
      automaticRetrySuppressed: true,
    };
  }

  let delivered: boolean;
  try {
    delivered = await input.router.sendPhoto(
      input.job.reply_jid,
      input.artifact.staged_path,
      'Готово.',
      {
        suppressCursorAdvance: true,
        meta: {
          kind: 'image_job_photo',
          imageJobId: input.job.id,
          imageArtifactId: input.artifact.id,
        },
      },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const error = `Telegram delivery confirmation was interrupted; the staged image remains pending: ${detail}`;
    const terminal =
      input.artifact.delivery_attempts + 1 >= MAX_DELIVERY_ATTEMPTS;
    if (terminal) markImageJobArtifactFailed(input.artifact.id, error);
    else markImageJobArtifactDeliveryPending(input.artifact.id, error);
    return {
      delivered: false,
      artifactPath: input.artifact.staged_path,
      error,
      deliveryPending: !terminal,
      terminalFailure: terminal,
      automaticRetrySuppressed: terminal,
    };
  }
  if (!delivered) {
    const error = 'Telegram did not confirm photo delivery';
    const terminal =
      input.artifact.delivery_attempts + 1 >= MAX_DELIVERY_ATTEMPTS;
    if (terminal) markImageJobArtifactFailed(input.artifact.id, error);
    else markImageJobArtifactDeliveryPending(input.artifact.id, error);
    return {
      delivered: false,
      artifactPath: input.artifact.staged_path,
      error,
      deliveryPending: !terminal,
      terminalFailure: terminal,
      automaticRetrySuppressed: terminal,
    };
  }
  markImageJobArtifactDelivered(input.artifact.id);
  return { delivered: true, artifactPath: input.artifact.staged_path };
}

export function officialImagegenRuntimeContext(): string {
  return [
    '<skoobi_image_job>',
    'This turn is a Telegram image-generation job.',
    'Use the official system $imagegen skill and its built-in image_gen tool. Do not use CLI, scripts/image_gen.py, OPENAI_API_KEY, ComfyUI, Pollinations, or another provider.',
    'If the request contains a numbered list of separate pictures, call image_gen once for every numbered item and preserve that order.',
    'Generate the requested image now. Do not call send_message, send_photo, send_document, or send_voice_message; those tools are disabled for this job. Do not copy the output manually and do not claim that Telegram delivery happened. The host pipeline records each exact saved_path reported by image_gen and owns delivery.',
    'If built-in image_gen fails, report the failure honestly and do not switch paths without explicit user approval.',
    '</skoobi_image_job>',
  ].join('\n');
}

export function officialImagegenJobMarker(
  jobId: string,
  generationAttempt: number,
): string {
  return `<skoobi_image_job_id_attempt_${generationAttempt}>${jobId}</skoobi_image_job_id_attempt_${generationAttempt}>`;
}

export function beginCodexImageJob(input: {
  chatJid: string;
  replyJid: string;
  groupFolder: string;
  requestCursor: string;
  prompt: string;
  codexHome: string;
  workspaceRoot?: string;
  now?: string;
}): ImageJobRunContext {
  const now = input.now || new Date().toISOString();
  const jobId = `img-${randomUUID()}`;
  const job = createImageJob({
    id: jobId,
    requestKey: `${input.chatJid}:${input.requestCursor}`,
    chatJid: input.chatJid,
    replyJid: input.replyJid,
    groupFolder: input.groupFolder,
    promptHash: createHash('sha256').update(input.prompt).digest('hex'),
    now,
  });
  let generationRequired = job.id === jobId;
  if (!generationRequired) {
    // A first attempt can finish image_gen just before its heartbeat/terminal
    // checkpoint fails. The job may already be back in `queued`; repair from
    // its exact rollout segment before claiming a paid second generation.
    if (
      (job.status === 'queued' || job.status === 'generating') &&
      getImageJobArtifacts(job.id).length === 0
    ) {
      try {
        recoverCodexImageArtifactsFromRollouts({
          context: {
            job,
            codexHome: input.codexHome,
            workspaceRoot: input.workspaceRoot,
            generatedBefore: new Map(),
            startedAtMs: new Date(job.created_at).getTime(),
            generationRequired: false,
            generationAttempt: job.generation_attempts,
          },
          nowMs: new Date(now).getTime(),
        });
      } catch (err) {
        logger.warn(
          { err, image_job_id: job.id },
          'Queued image job rollout repair failed before generation reclaim',
        );
      }
    }
    const nowMs = new Date(now).getTime();
    generationRequired = claimImageJobGeneration({
      id: job.id,
      maxAttempts: MAX_GENERATION_ATTEMPTS,
      staleBefore: new Date(nowMs - STALE_GENERATION_MS).toISOString(),
      now,
    });
  }
  const currentJob = getImageJobById(job.id) || job;
  return {
    job: currentJob,
    codexHome: input.codexHome,
    workspaceRoot: input.workspaceRoot,
    generatedBefore: generationRequired
      ? snapshotCodexGeneratedImages(input.codexHome)
      : new Map(),
    startedAtMs: generationRequired
      ? new Date(now).getTime()
      : new Date(currentJob.created_at).getTime(),
    generationRequired,
    generationAttempt: currentJob.generation_attempts,
  };
}

export async function finalizeCodexImageJob(input: {
  context: ImageJobRunContext;
  router: MessageRouter;
  photoAlreadyDelivered?: boolean;
  generatedArtifacts?: CodexGeneratedImageArtifact[];
  generationObserved?: boolean;
  generationCallIds?: string[];
}): Promise<ImageJobFinalizeResult> {
  const jobAtFinalize = getImageJobById(input.context.job.id);
  if (
    input.context.generationRequired &&
    jobAtFinalize &&
    jobAtFinalize.generation_attempts !== input.context.generationAttempt
  ) {
    return {
      delivered: false,
      error: 'A newer image generation attempt owns this job',
      deliveryDeferred: true,
    };
  }
  let recordingError: string | undefined;
  if (input.context.generationRequired && input.generationCallIds?.length) {
    const recorded = recordImageJobGenerationCalls({
      id: input.context.job.id,
      expectedGenerationAttempt: input.context.generationAttempt,
      callIds: input.generationCallIds,
    });
    if (!recorded) {
      return {
        delivered: false,
        error: 'A newer image generation attempt owns this job',
        deliveryDeferred: true,
      };
    }
  }
  if (input.generatedArtifacts?.length) {
    try {
      recordCodexImageArtifacts({
        context: input.context,
        artifacts: input.generatedArtifacts,
      });
    } catch (err) {
      recordingError = err instanceof Error ? err.message : String(err);
    }
  }

  let latest = getImageJobById(input.context.job.id) || input.context.job;
  let artifacts = materializeLegacyArtifacts(latest);
  if (input.context.generationRequired) {
    try {
      artifacts = recoverCodexImageArtifactsFromRollouts({
        context: input.context,
      });
      latest = getImageJobById(input.context.job.id) || latest;
      const expectedCalls = new Set(
        (input.generatedArtifacts || []).map((artifact) => artifact.callId),
      ).size;
      if (expectedCalls > 0 && artifacts.length >= expectedCalls) {
        recordingError = undefined;
      }
    } catch (err) {
      recordingError = err instanceof Error ? err.message : String(err);
    }
  }
  if (input.context.generationRequired) {
    const completed = markImageJobGenerationCompleted(
      input.context.job.id,
      input.context.generationAttempt,
    );
    if (!completed) {
      return {
        delivered: false,
        error: 'A newer image generation attempt owns this job',
        deliveryDeferred: true,
      };
    }
    latest = getImageJobById(input.context.job.id) || latest;
  }
  const observedCallIds = generationCallIds(latest);
  const artifactCallIds = new Set(
    artifacts.map((artifact) => artifact.call_id),
  );
  let missingObservedCallIds = observedCallIds.filter(
    (callId) => !artifactCallIds.has(callId),
  );
  if (latest.status === 'delivered') {
    return {
      delivered: true,
      artifactPath: artifacts[0]?.staged_path,
      artifactPaths: artifacts.map((artifact) => artifact.staged_path),
      deliveredCount: artifacts.length,
      deliveryAlreadyHandled: true,
    };
  }
  if (latest.status === 'failed' && artifacts.length === 0) {
    return {
      delivered: false,
      artifactPath: artifactPaths(latest)[0],
      error: latest.last_error || 'Image job already failed',
      terminalFailure: true,
      automaticRetrySuppressed: true,
    };
  }

  // Compatibility bridge for callers that have not yet been upgraded to pass
  // exact image_generation_end events. New callers pass generatedArtifacts
  // (including an empty array) and therefore never enter this guessing path.
  if (artifacts.length === 0 && input.generatedArtifacts === undefined) {
    const generated = newestGeneratedImage({
      codexHome: input.context.codexHome,
      generatedBefore: input.context.generatedBefore,
      notBeforeMs: input.context.startedAtMs,
    });
    if (generated) {
      try {
        artifacts = recordCodexImageArtifacts({
          context: input.context,
          artifacts: [
            {
              callId: `legacy-scan-${createHash('sha256')
                .update(generated)
                .digest('hex')
                .slice(0, 16)}`,
              savedPath: generated,
            },
          ],
        });
      } catch (err) {
        recordingError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  if (input.photoAlreadyDelivered) {
    if (artifacts.length > 0) {
      markAllImageJobArtifactsDelivered(latest.id);
    } else {
      markImageJobDelivered(latest.id);
    }
    return {
      delivered: true,
      artifactPath: artifacts[0]?.staged_path,
      artifactPaths: artifacts.map((artifact) => artifact.staged_path),
      deliveredCount: artifacts.length,
      deliveryAlreadyHandled: true,
    };
  }

  missingObservedCallIds = observedCallIds.filter(
    (callId) => !artifacts.some((artifact) => artifact.call_id === callId),
  );

  if (artifacts.length === 0) {
    if (missingObservedCallIds.length > 0) {
      return {
        delivered: false,
        error: `${missingObservedCallIds.length} completed image artifact(s) are still awaiting saved_path recovery`,
        deliveryPending: true,
        automaticRetrySuppressed: true,
      };
    }
    if (!input.context.generationRequired) {
      return {
        delivered: false,
        error: 'Image generation is already owned by another active run',
        deliveryDeferred: true,
      };
    }
    if (input.generationObserved) {
      const error = recordingError
        ? `Built-in image_gen completed, but its artifact could not be persisted: ${recordingError}`
        : 'Built-in image_gen completed without exposing a usable saved_path';
      markImageJobFailed(latest.id, error);
      return {
        delivered: false,
        error,
        terminalFailure: true,
        automaticRetrySuppressed: true,
      };
    }
    const error = recordingError
      ? `Built-in image_gen artifact could not be persisted: ${recordingError}`
      : 'Built-in image_gen produced no new image artifact that was recorded';
    const outcome = markImageJobGenerationRetryable(
      latest.id,
      input.context.generationAttempt,
      error,
      MAX_GENERATION_ATTEMPTS,
    );
    return {
      delivered: false,
      error,
      generationRetryable: outcome === 'retryable',
      deliveryDeferred: outcome === 'superseded',
      terminalFailure: outcome === 'failed',
      automaticRetrySuppressed: outcome === 'failed',
    };
  }

  latest = getImageJobById(latest.id) || latest;
  const paths = artifacts.map((artifact) => artifact.staged_path);
  let deliveredCount = artifacts.filter(
    (artifact) => artifact.status === 'delivered',
  ).length;
  let sentThisPass = 0;
  for (const artifact of artifacts) {
    if (artifact.status === 'delivered') continue;
    if (
      !ensureStagedArtifact({
        job: latest,
        artifact,
        workspaceRoot: input.context.workspaceRoot,
      })
    ) {
      const error = 'The staged image artifact is missing or invalid';
      markImageJobArtifactFailed(artifact.id, error);
      return {
        delivered: false,
        artifactPath: artifact.staged_path,
        artifactPaths: paths,
        deliveredCount,
        error,
        terminalFailure: true,
        automaticRetrySuppressed: true,
      };
    }
    const result = await deliverStagedImage({
      job: latest,
      artifact,
      router: input.router,
    });
    if (!result.delivered) {
      return {
        ...result,
        artifactPaths: paths,
        deliveredCount,
      };
    }
    deliveredCount++;
    if (!result.deliveryAlreadyHandled) sentThisPass++;
  }
  if (missingObservedCallIds.length > 0) {
    return {
      delivered: false,
      artifactPath: paths[0],
      artifactPaths: paths,
      deliveredCount,
      error: `${missingObservedCallIds.length} completed image artifact(s) are still awaiting saved_path recovery`,
      deliveryPending: true,
      automaticRetrySuppressed: true,
    };
  }
  if (recordingError) {
    const error = `Not every completed image artifact could be persisted: ${recordingError}`;
    markImageJobFailed(latest.id, error);
    return {
      delivered: false,
      artifactPath: paths[0],
      artifactPaths: paths,
      deliveredCount,
      error,
      terminalFailure: true,
      automaticRetrySuppressed: true,
    };
  }
  const completed = getImageJobById(latest.id);
  return {
    delivered: completed?.status === 'delivered',
    artifactPath: paths[0],
    artifactPaths: paths,
    deliveredCount,
    deliveryAlreadyHandled: sentThisPass === 0,
    error: recordingError,
  };
}

export function formatRecentImageJobStatus(job: ImageJobRecord): string {
  const elapsedSeconds = Math.max(
    1,
    Math.round((Date.now() - new Date(job.created_at).getTime()) / 1000),
  );
  switch (job.status) {
    case 'queued':
      return 'Запрос на картинку поставлен в очередь.';
    case 'generating':
      return `Картинка действительно генерируется, прошло около ${elapsedSeconds} сек.`;
    case 'generated':
      return 'Картинка уже создана, но Telegram ещё не подтвердил доставку. Повторяется только отправка готового файла.';
    case 'delivering':
      return 'Картинка создана и сейчас отправляется в Telegram; подтверждения доставки ещё нет.';
    case 'delivered':
      return 'Последняя картинка создана и подтверждённо доставлена в Telegram.';
    case 'failed':
      return 'Последняя генерация или доставка завершилась ошибкой; подтверждённого результата в Telegram нет. Техническая причина записана в журнале.';
  }
}

export async function recoverPendingImageJobs(input: {
  router: MessageRouter;
  includeFreshGenerating?: boolean;
  codexHomeForJob?: (job: ImageJobRecord) => string;
  workspaceRootForJob?: (job: ImageJobRecord) => string | undefined;
  onDelivered?: (job: ImageJobRecord, artifactPaths: string[]) => Promise<void>;
  onTerminalFailure?: (job: ImageJobRecord, error: string) => Promise<void>;
}): Promise<{
  delivered: number;
  failed: number;
  skipped: number;
  notified: number;
}> {
  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  let notified = 0;
  const now = Date.now();
  for (const job of getRecoverableImageJobs()) {
    let artifacts = getImageJobArtifacts(job.id);
    if (artifacts.length === 0 && artifactPaths(job).length > 0) {
      const ageMs = now - new Date(job.updated_at).getTime();
      if (
        job.status === 'delivering' &&
        !input.includeFreshGenerating &&
        ageMs < STALE_DELIVERY_MS
      ) {
        skipped++;
        continue;
      }
      artifacts = materializeLegacyArtifacts(job);
    }

    if (job.status === 'generating' || job.status === 'generated') {
      try {
        const codexHome = input.codexHomeForJob
          ? input.codexHomeForJob(job)
          : path.join(DATA_DIR, 'codex-homes', job.group_folder);
        artifacts = recoverCodexImageArtifactsFromRollouts({
          context: {
            job,
            codexHome,
            workspaceRoot: input.workspaceRootForJob?.(job),
            generatedBefore: new Map(),
            startedAtMs: new Date(job.created_at).getTime(),
            generationRequired: false,
            generationAttempt: job.generation_attempts,
          },
          nowMs: now,
        });
      } catch (err) {
        logger.warn(
          { err, image_job_id: job.id },
          'Exact image artifact could not be recovered from Codex rollout',
        );
      }
    }

    let afterReconcile = getImageJobById(job.id) || job;
    let observedCallIds = generationCallIds(afterReconcile);
    if (
      (artifacts.length > 0 || observedCallIds.length > 0) &&
      !afterReconcile.generation_completed_at
    ) {
      const ageMs = now - new Date(afterReconcile.updated_at).getTime();
      if (!input.includeFreshGenerating && ageMs < STALE_GENERATION_MS) {
        // Artifact callbacks arrive before the terminal Codex frame. A normal
        // periodic sweep must not deliver the first image while the same turn
        // may still be producing the rest of a requested set.
        skipped++;
        continue;
      }
      // Startup recovery owns no live runner from the previous process; after
      // reconciling its exact rollout segment, the interrupted generation is
      // now closed and its staged outputs are safe to deliver.
      markImageJobGenerationCompleted(job.id, job.generation_attempts);
      afterReconcile = getImageJobById(job.id) || afterReconcile;
      observedCallIds = generationCallIds(afterReconcile);
    }

    const persistedCallIds = new Set(
      artifacts.map((artifact) => artifact.call_id),
    );
    const missingObservedCallIds = observedCallIds.filter(
      (callId) => !persistedCallIds.has(callId),
    );
    const completedAtMs = new Date(
      afterReconcile.generation_completed_at || afterReconcile.updated_at,
    ).getTime();
    const missingArtifactGraceExpired =
      missingObservedCallIds.length > 0 &&
      now - completedAtMs >= STALE_GENERATION_MS;

    if (artifacts.length === 0) {
      if (missingObservedCallIds.length > 0) {
        if (missingArtifactGraceExpired) {
          markImageJobFailed(
            job.id,
            `${missingObservedCallIds.length} completed image artifact(s) never exposed a usable saved_path`,
          );
          failed++;
        } else {
          skipped++;
        }
        continue;
      }
      if (job.status === 'generating' || job.status === 'queued') {
        const ageMs = now - new Date(job.updated_at).getTime();
        if (
          job.status === 'generating' &&
          !input.includeFreshGenerating &&
          ageMs < STALE_GENERATION_MS
        ) {
          skipped++;
          continue;
        }
        const outcome = markImageJobGenerationRetryable(
          job.id,
          job.generation_attempts,
          'Generation lease expired before an exact image artifact was recorded',
          MAX_GENERATION_ATTEMPTS,
        );
        if (outcome === 'failed') failed++;
        else skipped++;
      } else {
        markImageJobFailed(
          job.id,
          'The staged image artifact is missing or invalid; delivery cannot be retried',
        );
        failed++;
      }
      continue;
    }

    let recoveryDeferred = false;
    for (const artifact of artifacts) {
      if (artifact.status === 'delivered') continue;
      if (artifact.status === 'failed') {
        recoveryDeferred = true;
        continue;
      }
      if (artifact.status === 'delivering') {
        const ageMs = now - new Date(artifact.updated_at).getTime();
        if (!input.includeFreshGenerating && ageMs < STALE_DELIVERY_MS) {
          recoveryDeferred = true;
          break;
        }
        markImageJobArtifactDeliveryPending(
          artifact.id,
          'Previous delivery confirmation was interrupted; retrying the same staged image',
        );
      }
      if (
        !ensureStagedArtifact({
          job,
          artifact,
          workspaceRoot: input.workspaceRootForJob?.(job),
        })
      ) {
        markImageJobArtifactFailed(
          artifact.id,
          'The staged image artifact is missing or invalid; delivery cannot be retried',
        );
        recoveryDeferred = true;
        break;
      }
      const current = getImageJobArtifacts(job.id).find(
        (candidate) => candidate.id === artifact.id,
      );
      if (!current) {
        recoveryDeferred = true;
        break;
      }
      const result = await deliverStagedImage({
        job,
        artifact: current,
        router: input.router,
      });
      if (!result.delivered) {
        recoveryDeferred = true;
        break;
      }
    }
    const recovered = getImageJobById(job.id);
    if (missingObservedCallIds.length > 0) {
      if (missingArtifactGraceExpired) {
        markImageJobFailed(
          job.id,
          `${missingObservedCallIds.length} completed image artifact(s) never exposed a usable saved_path`,
        );
        failed++;
      } else {
        skipped++;
      }
      continue;
    }
    if (recovered?.status === 'delivered') {
      delivered++;
      if (input.onDelivered) {
        try {
          await input.onDelivered(
            recovered,
            getImageJobArtifacts(recovered.id).map(
              (artifact) => artifact.staged_path,
            ),
          );
        } catch (err) {
          logger.warn(
            { err, image_job_id: recovered.id },
            'Image job delivery observer failed',
          );
        }
      }
    } else if (recovered?.status === 'failed') failed++;
    else if (recoveryDeferred) skipped++;
  }
  if (input.onTerminalFailure) {
    const staleBefore = new Date(now - STALE_DELIVERY_MS).toISOString();
    for (const pending of getImageJobsPendingFailureNotice()) {
      if (!claimImageJobFailureNotice(pending.id, staleBefore)) continue;
      const claimed = getImageJobById(pending.id) || pending;
      try {
        await input.onTerminalFailure(
          claimed,
          claimed.last_error || 'Image generation or delivery failed',
        );
        markImageJobFailureNotified(claimed.id);
        notified++;
      } catch (err) {
        releaseImageJobFailureNotice(claimed.id);
        logger.warn(
          { err, image_job_id: claimed.id },
          'Image job terminal failure notice could not be delivered',
        );
      }
    }
  }
  if (delivered || failed || notified) {
    logger.info(
      { delivered, failed, skipped, notified },
      'Image job recovery completed',
    );
  }
  return { delivered, failed, skipped, notified };
}
