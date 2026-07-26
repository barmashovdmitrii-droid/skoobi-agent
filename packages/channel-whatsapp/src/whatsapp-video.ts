/**
 * Local understanding for an already-downloaded WhatsApp video.
 *
 * The transport/decryption boundary stays in whatsapp-media.ts. This helper
 * accepts only a regular file directly inside a real `received/` directory,
 * probes its duration locally, transcribes its audio through the shared local
 * whisper.cpp package, and extracts at most three bounded JPEG key frames.
 * No network or cloud client exists in this module.
 */

import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { promisify } from 'util';

import { readEnvFile } from '@skoobi/shared/env';
import {
  FFMPEG_FALLBACKS,
  FFPROBE_FALLBACKS,
  resolveBinary,
} from '@skoobi/shared/binary-paths';
import { logger } from '@skoobi/shared/logger';
import { basenameOnly } from '@skoobi/shared/log-sanitize';
import { transcribeAudioFile } from '@skoobi/voice-stt';

const execFileAsync = promisify(execFile);

const FFPROBE_TIMEOUT_MS = 30_000;
const FFMPEG_FRAME_TIMEOUT_MS = 45_000;
const PROCESS_MAX_BUFFER_BYTES = 256 * 1024;
const MAX_VIDEO_FRAMES = 3;
const MAX_FRAME_BYTES = 15 * 1024 * 1024;
const MAX_REASONABLE_DURATION_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_CONCURRENT_ANALYSES = 1;
const DEFAULT_MAX_QUEUED_ANALYSES = 8;
const DEFAULT_QUEUE_TIMEOUT_MS = 60_000;

export type WhatsappVideoSkipReason =
  | 'invalid_input'
  | 'capacity_exhausted'
  | 'queue_timeout';

export interface WhatsappVideoAnalysisResult {
  durationSeconds: number | null;
  transcript: string | null;
  transcriptionAttempted: boolean;
  framePaths: string[];
  /** One timestamp for each same-index entry in framePaths. */
  frameTimestampsSeconds: number[];
  skippedReason?: WhatsappVideoSkipReason;
}

export interface WhatsappVideoExecOptions {
  timeout: number;
  maxBuffer: number;
  killSignal: NodeJS.Signals;
  windowsHide: boolean;
}

export type WhatsappVideoExec = (
  executable: string,
  args: readonly string[],
  options: WhatsappVideoExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface WhatsappVideoProcessorOptions {
  ffmpegBin?: string;
  ffprobeBin?: string;
  ffprobeTimeoutMs?: number;
  ffmpegFrameTimeoutMs?: number;
  maxFrameBytes?: number;
  maxConcurrentAnalyses?: number;
  maxQueuedAnalyses?: number;
  queueTimeoutMs?: number;
  execLocal?: WhatsappVideoExec;
  transcribe?: (videoPath: string) => Promise<string | null>;
}

type VideoProcessor = (
  videoPath: string,
) => Promise<WhatsappVideoAnalysisResult>;

interface SafeVideoContext {
  videoPath: string;
  videoBasename: string;
  frameStem: string;
  receivedPath: string;
  receivedRealPath: string;
  receivedDev: number;
  receivedIno: number;
}

type AnalysisGrant =
  | { release: () => void }
  | { skippedReason: 'capacity_exhausted' | 'queue_timeout' };

interface AnalysisWaiter {
  grant: (grant: AnalysisGrant) => void;
  timer: NodeJS.Timeout;
}

class VideoFrameError extends Error {
  constructor(readonly failureCode: string) {
    super(failureCode);
    this.name = 'VideoFrameError';
  }
}

const defaultExecLocal: WhatsappVideoExec = async (
  executable,
  args,
  options,
) => {
  const result = await execFileAsync(executable, [...args], {
    ...options,
    encoding: 'utf8',
  });
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
};

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || Number(value) <= 0) return fallback;
  return Math.max(1, Math.trunc(Number(value)));
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value) || Number(value) < 0) return fallback;
  return Math.max(0, Math.trunc(Number(value)));
}

function emptyResult(
  skippedReason?: WhatsappVideoSkipReason,
): WhatsappVideoAnalysisResult {
  return {
    durationSeconds: null,
    transcript: null,
    transcriptionAttempted: false,
    framePaths: [],
    frameTimestampsSeconds: [],
    ...(skippedReason ? { skippedReason } : {}),
  };
}

function safeFailureMetadata(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') {
    return { errorKind: typeof error };
  }
  const value = error as {
    name?: unknown;
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    failureCode?: unknown;
  };
  return {
    errorKind:
      typeof value.name === 'string' && value.name ? value.name : 'Error',
    ...(typeof value.code === 'string' || typeof value.code === 'number'
      ? { errorCode: value.code }
      : {}),
    ...(value.killed === true ? { killed: true } : {}),
    ...(typeof value.signal === 'string' ? { signal: value.signal } : {}),
    ...(typeof value.failureCode === 'string'
      ? { failureCode: value.failureCode }
      : {}),
  };
}

function roundMetric(value: number | null, digits = 3): number | null {
  return value === null ? null : Number(value.toFixed(digits));
}

function pathIsDirectChild(child: string, parent: string): boolean {
  return path.dirname(child) === parent && path.basename(child) !== child;
}

async function safeVideoContext(
  videoPath: string,
): Promise<SafeVideoContext | null> {
  if (!path.isAbsolute(videoPath) || videoPath.includes('\0')) return null;
  const receivedPath = path.dirname(videoPath);
  if (path.basename(receivedPath) !== 'received') return null;

  try {
    const [receivedStat, videoStat, receivedRealPath, videoRealPath] =
      await Promise.all([
        fs.lstat(receivedPath),
        fs.lstat(videoPath),
        fs.realpath(receivedPath),
        fs.realpath(videoPath),
      ]);
    if (
      !receivedStat.isDirectory() ||
      receivedStat.isSymbolicLink() ||
      !videoStat.isFile() ||
      videoStat.isSymbolicLink() ||
      !pathIsDirectChild(videoRealPath, receivedRealPath)
    ) {
      return null;
    }

    const videoBasename = path.basename(videoRealPath);
    const rawStem = path.basename(videoBasename, path.extname(videoBasename));
    const frameStem =
      rawStem.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'video';
    return {
      videoPath: videoRealPath,
      videoBasename,
      frameStem,
      receivedPath,
      receivedRealPath,
      receivedDev: receivedStat.dev,
      receivedIno: receivedStat.ino,
    };
  } catch {
    return null;
  }
}

async function receivedDirectoryStillMatches(
  context: SafeVideoContext,
): Promise<boolean> {
  try {
    const [stat, realPath] = await Promise.all([
      fs.lstat(context.receivedPath),
      fs.realpath(context.receivedPath),
    ]);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === context.receivedDev &&
      stat.ino === context.receivedIno &&
      realPath === context.receivedRealPath
    );
  } catch {
    return false;
  }
}

async function isJpegFile(filePath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const header = Buffer.alloc(3);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return (
      bytesRead === 3 &&
      header[0] === 0xff &&
      header[1] === 0xd8 &&
      header[2] === 0xff
    );
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Stable sampling points; they describe sampled frames, not the whole video. */
export function whatsappVideoFrameTimes(
  durationSeconds: number | null,
): number[] {
  let candidates: number[];
  if (
    durationSeconds === null ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    candidates = [0];
  } else if (durationSeconds < 2) {
    candidates = [Math.max(0, durationSeconds * 0.15)];
  } else if (durationSeconds < 5) {
    candidates = [0.25, Math.max(0.5, durationSeconds * 0.65)];
  } else {
    candidates = [
      0.5,
      durationSeconds * 0.5,
      Math.max(0.5, durationSeconds - 0.75),
    ];
  }

  const seen = new Set<number>();
  const result: number[] = [];
  for (const candidate of candidates) {
    const rounded = Math.max(0, Number(candidate.toFixed(3)));
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    result.push(rounded);
    if (result.length >= MAX_VIDEO_FRAMES) break;
  }
  return result;
}

function createAnalysisGate(input: {
  maxConcurrent: number;
  maxQueued: number;
  queueTimeoutMs: number;
}) {
  let active = 0;
  const waiters: AnalysisWaiter[] = [];

  const createRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      while (active < input.maxConcurrent && waiters.length > 0) {
        const next = waiters.shift()!;
        clearTimeout(next.timer);
        active += 1;
        next.grant({ release: createRelease() });
      }
    };
  };

  return async function acquire(): Promise<AnalysisGrant> {
    if (active < input.maxConcurrent) {
      active += 1;
      return { release: createRelease() };
    }
    if (waiters.length >= input.maxQueued) {
      return { skippedReason: 'capacity_exhausted' };
    }

    return new Promise<AnalysisGrant>((resolve) => {
      const waiter: AnalysisWaiter = {
        grant: resolve,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index === -1) return;
          waiters.splice(index, 1);
          resolve({ skippedReason: 'queue_timeout' });
        }, input.queueTimeoutMs),
      };
      waiter.timer.unref();
      waiters.push(waiter);
    });
  };
}

async function probeVideoDuration(
  context: SafeVideoContext,
  config: ResolvedProcessorOptions,
): Promise<number | null> {
  try {
    const result = await config.execLocal(
      config.ffprobeBin,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        context.videoPath,
      ],
      {
        timeout: config.ffprobeTimeoutMs,
        maxBuffer: PROCESS_MAX_BUFFER_BYTES,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
    );
    const duration = Number.parseFloat(result.stdout.trim());
    return Number.isFinite(duration) &&
      duration > 0 &&
      duration <= MAX_REASONABLE_DURATION_SECONDS
      ? duration
      : null;
  } catch (error) {
    logger.warn(
      {
        stage: 'ffprobe',
        videoBasename: context.videoBasename,
        ...safeFailureMetadata(error),
      },
      'Local WhatsApp video duration probe failed',
    );
    return null;
  }
}

interface ResolvedProcessorOptions {
  ffmpegBin: string;
  ffprobeBin: string;
  ffprobeTimeoutMs: number;
  ffmpegFrameTimeoutMs: number;
  maxFrameBytes: number;
  execLocal: WhatsappVideoExec;
  transcribe: (videoPath: string) => Promise<string | null>;
}

async function extractVideoFrame(
  context: SafeVideoContext,
  config: ResolvedProcessorOptions,
  seconds: number,
  frameIndex: number,
): Promise<string | null> {
  const unique = randomUUID().replace(/-/g, '').slice(0, 12);
  const frameBasename = `${context.frameStem}-frame-${String(
    frameIndex + 1,
  ).padStart(2, '0')}-${unique}.jpg`;
  const finalPath = path.join(context.receivedPath, frameBasename);
  const tempPath = path.join(
    context.receivedPath,
    `.${frameBasename}.${randomUUID()}.part.jpg`,
  );

  try {
    if (!(await receivedDirectoryStillMatches(context))) {
      throw new VideoFrameError('received_directory_changed');
    }
    await config.execLocal(
      config.ffmpegBin,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-i',
        context.videoPath,
        '-ss',
        seconds.toFixed(3),
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-an',
        '-vf',
        "scale=w='min(1600,iw)':h='min(1600,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        '-q:v',
        '3',
        '-f',
        'image2',
        '-n',
        tempPath,
      ],
      {
        timeout: config.ffmpegFrameTimeoutMs,
        maxBuffer: PROCESS_MAX_BUFFER_BYTES,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
    );

    const [stat, realTempPath] = await Promise.all([
      fs.lstat(tempPath),
      fs.realpath(tempPath),
    ]);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size <= 0 ||
      stat.size > config.maxFrameBytes ||
      !pathIsDirectChild(realTempPath, context.receivedRealPath)
    ) {
      throw new VideoFrameError('invalid_frame_file');
    }
    if (!(await isJpegFile(realTempPath))) {
      throw new VideoFrameError('invalid_jpeg_signature');
    }
    if (!(await receivedDirectoryStillMatches(context))) {
      throw new VideoFrameError('received_directory_changed');
    }

    await fs.chmod(tempPath, 0o600);
    await fs.link(tempPath, finalPath);
    if (await receivedDirectoryStillMatches(context)) {
      await fs.unlink(tempPath);
    }
    return finalPath;
  } catch (error) {
    logger.warn(
      {
        stage: 'frame',
        videoBasename: context.videoBasename,
        frameIndex: frameIndex + 1,
        frameTimestampSeconds: seconds,
        ...safeFailureMetadata(error),
      },
      'Local WhatsApp video frame extraction failed',
    );
    return null;
  } finally {
    if (await receivedDirectoryStillMatches(context)) {
      await fs.unlink(tempPath).catch(() => undefined);
    }
  }
}

async function transcribeVideo(
  context: SafeVideoContext,
  config: ResolvedProcessorOptions,
): Promise<string | null> {
  try {
    const transcript = await config.transcribe(context.videoPath);
    return transcript?.trim() || null;
  } catch (error) {
    logger.warn(
      {
        stage: 'transcription',
        videoBasename: context.videoBasename,
        ...safeFailureMetadata(error),
      },
      'Local WhatsApp video transcription failed',
    );
    return null;
  }
}

async function analyzeVideo(
  context: SafeVideoContext,
  config: ResolvedProcessorOptions,
): Promise<WhatsappVideoAnalysisResult> {
  const startedAt = performance.now();
  const durationSeconds = await probeVideoDuration(context, config);
  const requestedFrameTimes = whatsappVideoFrameTimes(durationSeconds);

  const framesPromise = (async () => {
    const frames: Array<{ path: string; seconds: number }> = [];
    for (const [index, seconds] of requestedFrameTimes.entries()) {
      const framePath = await extractVideoFrame(
        context,
        config,
        seconds,
        index,
      );
      if (framePath) frames.push({ path: framePath, seconds });
    }
    return frames;
  })();
  // The shared transcriber serializes whisper.cpp work and bounds its own
  // ffmpeg/whisper subprocesses. It receives the local file path only.
  const [transcript, frames] = await Promise.all([
    transcribeVideo(context, config),
    framesPromise,
  ]);

  logger.info(
    {
      via: 'local-whatsapp-video',
      videoBasename: context.videoBasename,
      durationSeconds: roundMetric(durationSeconds),
      transcriptChars: transcript?.length ?? 0,
      frameCount: frames.length,
      processingDurationMs: roundMetric(performance.now() - startedAt, 1),
    },
    'Processed WhatsApp video locally',
  );

  return {
    durationSeconds,
    transcript,
    transcriptionAttempted: true,
    framePaths: frames.map((frame) => frame.path),
    frameTimestampsSeconds: frames.map((frame) => frame.seconds),
  };
}

/**
 * Build an independently bounded processor. The default export below uses one
 * active analysis and a finite waiting queue so simultaneous Baileys upserts
 * cannot create an unbounded set of ffmpeg/Whisper jobs.
 */
export function createWhatsappVideoProcessor(
  options: WhatsappVideoProcessorOptions = {},
): VideoProcessor {
  const env = readEnvFile(['FFMPEG_BIN', 'FFPROBE_BIN']);
  const ffmpegBin =
    options.ffmpegBin ||
    process.env.FFMPEG_BIN ||
    env.FFMPEG_BIN ||
    resolveBinary('ffmpeg', FFMPEG_FALLBACKS);
  const config: ResolvedProcessorOptions = {
    ffmpegBin,
    ffprobeBin:
      options.ffprobeBin ||
      process.env.FFPROBE_BIN ||
      env.FFPROBE_BIN ||
      resolveBinary('ffprobe', [
        ffmpegBin.replace(/ffmpeg$/u, 'ffprobe'),
        ...FFPROBE_FALLBACKS,
      ]),
    ffprobeTimeoutMs: positiveInteger(
      options.ffprobeTimeoutMs,
      FFPROBE_TIMEOUT_MS,
    ),
    ffmpegFrameTimeoutMs: positiveInteger(
      options.ffmpegFrameTimeoutMs,
      FFMPEG_FRAME_TIMEOUT_MS,
    ),
    maxFrameBytes: positiveInteger(options.maxFrameBytes, MAX_FRAME_BYTES),
    execLocal: options.execLocal || defaultExecLocal,
    transcribe: options.transcribe || transcribeAudioFile,
  };
  const acquire = createAnalysisGate({
    maxConcurrent: positiveInteger(
      options.maxConcurrentAnalyses,
      DEFAULT_MAX_CONCURRENT_ANALYSES,
    ),
    maxQueued: nonNegativeInteger(
      options.maxQueuedAnalyses,
      DEFAULT_MAX_QUEUED_ANALYSES,
    ),
    queueTimeoutMs: positiveInteger(
      options.queueTimeoutMs,
      DEFAULT_QUEUE_TIMEOUT_MS,
    ),
  });

  return async (videoPath: string): Promise<WhatsappVideoAnalysisResult> => {
    const context = await safeVideoContext(videoPath);
    if (!context) {
      logger.warn(
        {
          videoBasename: basenameOnly(videoPath),
          failureCode: 'invalid_input',
        },
        'Rejected unsafe local WhatsApp video input',
      );
      return emptyResult('invalid_input');
    }

    const grant = await acquire();
    if ('skippedReason' in grant) {
      logger.warn(
        {
          videoBasename: context.videoBasename,
          failureCode: grant.skippedReason,
        },
        'Local WhatsApp video analysis capacity unavailable',
      );
      return emptyResult(grant.skippedReason);
    }

    try {
      return await analyzeVideo(context, config);
    } finally {
      grant.release();
    }
  };
}

const defaultWhatsappVideoProcessor = createWhatsappVideoProcessor();

export function processDownloadedWhatsappVideo(
  videoPath: string,
): Promise<WhatsappVideoAnalysisResult> {
  return defaultWhatsappVideoProcessor(videoPath);
}
