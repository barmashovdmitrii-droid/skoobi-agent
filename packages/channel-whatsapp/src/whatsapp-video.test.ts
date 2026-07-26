import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@skoobi/shared/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: loggerMock.info,
    warn: loggerMock.warn,
    error: vi.fn(),
  },
}));

import {
  createWhatsappVideoProcessor,
  whatsappVideoFrameTimes,
  type WhatsappVideoExec,
} from './whatsapp-video.js';

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

async function flushAsync(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('local WhatsApp video processing', () => {
  let root: string;
  let receivedDir: string;
  let videoPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'skoobi-wa-video-test-'));
    receivedDir = path.join(root, 'received');
    await fs.mkdir(receivedDir, { mode: 0o700 });
    videoPath = path.join(receivedDir, '2026-07-14-video-12345678.mp4');
    await fs.writeFile(videoPath, Buffer.from('local video fixture'));
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('chooses at most three stable sample timestamps', () => {
    expect(whatsappVideoFrameTimes(null)).toEqual([0]);
    expect(whatsappVideoFrameTimes(1)).toEqual([0.15]);
    expect(whatsappVideoFrameTimes(4)).toEqual([0.25, 2.6]);
    expect(whatsappVideoFrameTimes(20)).toEqual([0.5, 10, 19.25]);
  });

  it('probes duration, transcribes locally, and atomically publishes three bounded JPEG frames', async () => {
    const calls: Array<{
      executable: string;
      args: readonly string[];
      options: { timeout: number; killSignal: NodeJS.Signals };
    }> = [];
    const execLocal: WhatsappVideoExec = vi.fn(
      async (executable, args, options) => {
        calls.push({ executable, args, options });
        if (executable === '/local/ffprobe') {
          return { stdout: '20.000\n', stderr: '' };
        }
        await fs.writeFile(args.at(-1)!, JPEG_BYTES);
        return { stdout: '', stderr: '' };
      },
    );
    const transcribe = vi.fn().mockResolvedValue('Локальная расшифровка');
    const processor = createWhatsappVideoProcessor({
      ffmpegBin: '/local/ffmpeg',
      ffprobeBin: '/local/ffprobe',
      ffprobeTimeoutMs: 1_234,
      ffmpegFrameTimeoutMs: 2_345,
      execLocal,
      transcribe,
    });

    const result = await processor(videoPath);

    expect(result.durationSeconds).toBe(20);
    expect(result.transcript).toBe('Локальная расшифровка');
    expect(result.transcriptionAttempted).toBe(true);
    expect(result.frameTimestampsSeconds).toEqual([0.5, 10, 19.25]);
    expect(result.framePaths).toHaveLength(3);
    expect(transcribe).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledWith(await fs.realpath(videoPath));
    for (const framePath of result.framePaths) {
      expect(path.dirname(framePath)).toBe(receivedDir);
      expect(path.basename(framePath)).toMatch(
        /-frame-0[1-3]-[a-f0-9]{12}\.jpg$/,
      );
      expect(await fs.readFile(framePath)).toEqual(JPEG_BYTES);
      expect((await fs.stat(framePath)).mode & 0o777).toBe(0o600);
    }
    expect(
      (await fs.readdir(receivedDir)).some((name) => name.includes('.part.')),
    ).toBe(false);

    expect(calls[0]).toEqual(
      expect.objectContaining({
        executable: '/local/ffprobe',
        options: expect.objectContaining({
          timeout: 1_234,
          killSignal: 'SIGKILL',
        }),
      }),
    );
    const frameCalls = calls.filter(
      (call) => call.executable === '/local/ffmpeg',
    );
    expect(frameCalls).toHaveLength(3);
    for (const call of frameCalls) {
      expect(call.options).toEqual(
        expect.objectContaining({ timeout: 2_345, killSignal: 'SIGKILL' }),
      );
      expect(call.args).toContain('-frames:v');
      expect(call.args).toContain('1');
      expect(call.args.join(' ')).toContain('min(1600,iw)');
    }

    const serializedLogs = JSON.stringify([
      ...loggerMock.info.mock.calls,
      ...loggerMock.warn.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(root);
    expect(serializedLogs).not.toContain('Локальная расшифровка');
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        via: 'local-whatsapp-video',
        durationSeconds: 20,
        transcriptChars: 'Локальная расшифровка'.length,
        frameCount: 3,
      }),
      'Processed WhatsApp video locally',
    );
  });

  it('keeps usable frames when probing or transcription fails and logs no error text', async () => {
    const execLocal: WhatsappVideoExec = vi.fn(async (executable, args) => {
      if (executable.endsWith('ffprobe')) {
        throw new Error(`private diagnostic ${videoPath}`);
      }
      await fs.writeFile(args.at(-1)!, JPEG_BYTES);
      return { stdout: '', stderr: '' };
    });
    const processor = createWhatsappVideoProcessor({
      ffmpegBin: '/local/ffmpeg',
      ffprobeBin: '/local/ffprobe',
      execLocal,
      transcribe: async () => {
        throw new Error(`private transcript failure ${videoPath}`);
      },
    });

    const result = await processor(videoPath);

    expect(result.durationSeconds).toBeNull();
    expect(result.transcript).toBeNull();
    expect(result.transcriptionAttempted).toBe(true);
    expect(result.frameTimestampsSeconds).toEqual([0]);
    expect(result.framePaths).toHaveLength(1);
    const serializedLogs = JSON.stringify(loggerMock.warn.mock.calls);
    expect(serializedLogs).not.toContain(root);
    expect(serializedLogs).not.toContain('private diagnostic');
    expect(serializedLogs).not.toContain('private transcript failure');
    expect(serializedLogs).toContain('ffprobe');
    expect(serializedLogs).toContain('transcription');
  });

  it('rejects symlink input without running ffmpeg, ffprobe, or Whisper', async () => {
    const symlinkPath = path.join(receivedDir, 'linked-video.mp4');
    await fs.symlink(videoPath, symlinkPath);
    const execLocal = vi.fn<WhatsappVideoExec>();
    const transcribe = vi.fn();
    const processor = createWhatsappVideoProcessor({ execLocal, transcribe });

    const result = await processor(symlinkPath);

    expect(result.skippedReason).toBe('invalid_input');
    expect(result.transcriptionAttempted).toBe(false);
    expect(result.framePaths).toEqual([]);
    expect(execLocal).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('removes invalid and oversized temporary frame outputs', async () => {
    let frameIndex = 0;
    const execLocal: WhatsappVideoExec = vi.fn(async (executable, args) => {
      if (executable.endsWith('ffprobe')) {
        return { stdout: '20', stderr: '' };
      }
      frameIndex += 1;
      if (frameIndex === 1) {
        await fs.writeFile(args.at(-1)!, Buffer.from('not a jpeg'));
      } else {
        await fs.writeFile(args.at(-1)!, Buffer.alloc(128, 0xff));
      }
      return { stdout: '', stderr: '' };
    });
    const processor = createWhatsappVideoProcessor({
      execLocal,
      transcribe: async () => null,
      maxFrameBytes: 64,
    });

    const result = await processor(videoPath);

    expect(result.framePaths).toEqual([]);
    expect(await fs.readdir(receivedDir)).toEqual([path.basename(videoPath)]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'frame' }),
      'Local WhatsApp video frame extraction failed',
    );
  });

  it('bounds active work and drains only the finite waiting queue', async () => {
    let releaseProbe!: () => void;
    let probeStarted!: () => void;
    const probeStartedPromise = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let firstProbe = true;
    const execLocal: WhatsappVideoExec = vi.fn(async (executable, args) => {
      if (executable.endsWith('ffprobe')) {
        if (firstProbe) {
          firstProbe = false;
          probeStarted();
          await probeGate;
        }
        return { stdout: '1', stderr: '' };
      }
      await fs.writeFile(args.at(-1)!, JPEG_BYTES);
      return { stdout: '', stderr: '' };
    });
    const processor = createWhatsappVideoProcessor({
      execLocal,
      transcribe: async () => null,
      maxConcurrentAnalyses: 1,
      maxQueuedAnalyses: 1,
      queueTimeoutMs: 1_000,
    });
    const secondVideo = path.join(receivedDir, 'second.mp4');
    const thirdVideo = path.join(receivedDir, 'third.mp4');
    await fs.writeFile(secondVideo, 'second');
    await fs.writeFile(thirdVideo, 'third');

    const first = processor(videoPath);
    await probeStartedPromise;
    const second = processor(secondVideo);
    await flushAsync();
    const third = await processor(thirdVideo);

    expect(third.skippedReason).toBe('capacity_exhausted');
    releaseProbe();
    expect((await first).skippedReason).toBeUndefined();
    expect((await second).skippedReason).toBeUndefined();
  });

  it('expires a queued analysis instead of starting it later in the background', async () => {
    let releaseProbe!: () => void;
    let probeStarted!: () => void;
    const probeStartedPromise = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let firstProbe = true;
    const execLocal: WhatsappVideoExec = vi.fn(async (executable, args) => {
      if (executable.endsWith('ffprobe')) {
        if (firstProbe) {
          firstProbe = false;
          probeStarted();
          await probeGate;
        }
        return { stdout: '1', stderr: '' };
      }
      await fs.writeFile(args.at(-1)!, JPEG_BYTES);
      return { stdout: '', stderr: '' };
    });
    const processor = createWhatsappVideoProcessor({
      execLocal,
      transcribe: async () => null,
      maxConcurrentAnalyses: 1,
      maxQueuedAnalyses: 1,
      queueTimeoutMs: 10,
    });
    const secondVideo = path.join(receivedDir, 'second.mp4');
    await fs.writeFile(secondVideo, 'second');

    const first = processor(videoPath);
    await probeStartedPromise;
    const second = await processor(secondVideo);

    expect(second.skippedReason).toBe('queue_timeout');
    releaseProbe();
    expect((await first).skippedReason).toBeUndefined();
    // Only the first job reached ffprobe; the expired waiter never starts.
    expect(
      vi
        .mocked(execLocal)
        .mock.calls.filter(([binary]) => binary.endsWith('ffprobe')),
    ).toHaveLength(1);
  });
});
