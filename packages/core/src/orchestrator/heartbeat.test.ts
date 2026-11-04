import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildHeartbeat,
  channelConnectivity,
  startHeartbeat,
  writeHeartbeatFile,
  type HeartbeatSnapshot,
} from './heartbeat.js';
import { logger } from './logger.js';

const MB = 1024 * 1024;
const NOW = Date.parse('2026-09-28T10:00:00.000Z');

function mem(rssMb = 179.4, heapUsedMb = 95.6) {
  return {
    rss: rssMb * MB,
    heapUsed: heapUsedMb * MB,
    heapTotal: 120 * MB,
    external: 7.5 * MB,
  };
}

let dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-test-')),
  );
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.info).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('buildHeartbeat', () => {
  it('emits only whitelisted keys, rounded to whole MB, with no chat ids', () => {
    const input = {
      pid: 4242,
      processStartedAtMs: NOW - 125_000,
      channels: { telegram: true, whatsapp: false },
      loopTickAt: NOW - 1_400,
      eventLoopDelayMaxMs: 21.7,
      activeRuns: [
        {
          groupFolder: 'telegram_main',
          startedAt: NOW - 90_000,
          isTaskContainer: false,
        },
      ],
      // Anything extra a caller might pass must not leak into the file.
      chatJid: 'tg:100123',
      token: 'secret-token',
    };
    const snap = buildHeartbeat(input, mem(), NOW);

    expect(Object.keys(snap).sort()).toEqual(
      [
        'v',
        'ts',
        'pid',
        'startedAt',
        'uptimeSec',
        'phase',
        'rssMb',
        'heapUsedMb',
        'heapTotalMb',
        'externalMb',
        'loopTickAgeSec',
        'eventLoopDelayMaxMs',
        'channels',
        'activeRunCount',
        'activeRuns',
      ].sort(),
    );
    expect(snap).toMatchObject({
      v: 1,
      ts: '2026-09-28T10:00:00.000Z',
      pid: 4242,
      uptimeSec: 125,
      phase: 'running',
      rssMb: 179,
      heapUsedMb: 96,
      heapTotalMb: 120,
      externalMb: 8,
      loopTickAgeSec: 1,
      eventLoopDelayMaxMs: 22,
      channels: { telegram: true, whatsapp: false },
      activeRunCount: 1,
      activeRuns: {
        telegram_main: { startedAt: '2026-09-28T09:58:30.000Z', task: false },
      },
    });
    const text = JSON.stringify(snap);
    expect(text).not.toContain('tg:');
    expect(text).not.toContain('100123');
    expect(text).not.toContain('secret-token');
  });

  it("is in phase 'starting' until the message loop has ticked", () => {
    const base = {
      pid: 1,
      processStartedAtMs: NOW - 5_000,
      channels: {},
      eventLoopDelayMaxMs: null,
    };
    const starting = buildHeartbeat(
      { ...base, loopTickAt: undefined },
      mem(),
      NOW,
    );
    expect(starting.phase).toBe('starting');
    expect(starting.loopTickAgeSec).toBeNull();

    const running = buildHeartbeat(
      { ...base, loopTickAt: NOW - 400_000 },
      mem(),
      NOW,
    );
    expect(running.phase).toBe('running');
    expect(running.loopTickAgeSec).toBe(400);
  });

  it('lists active runs by folder only and counts runs it cannot name', () => {
    const snap = buildHeartbeat(
      {
        pid: 1,
        processStartedAtMs: NOW,
        channels: {},
        loopTickAt: NOW,
        eventLoopDelayMaxMs: null,
        activeRuns: [
          { groupFolder: 'telegram_main', startedAt: NOW - 60_000, isTaskContainer: true },
          { groupFolder: null, startedAt: NOW - 1_000, isTaskContainer: false },
          { groupFolder: 'tg:123456', startedAt: NOW - 1_000, isTaskContainer: false },
          { groupFolder: '../etc', startedAt: NOW - 1_000, isTaskContainer: false },
        ],
      },
      mem(),
      NOW,
    );
    expect(snap.activeRunCount).toBe(4);
    expect(snap.activeRuns).toEqual({
      telegram_main: { startedAt: '2026-09-28T09:59:00.000Z', task: true },
    });
  });

  it('prefers a chat run over a task run under the same folder', () => {
    const snap = buildHeartbeat(
      {
        pid: 1,
        processStartedAtMs: NOW,
        channels: {},
        loopTickAt: NOW,
        eventLoopDelayMaxMs: null,
        activeRuns: [
          { groupFolder: 'telegram_main', startedAt: NOW - 1_000, isTaskContainer: true },
          { groupFolder: 'telegram_main', startedAt: NOW - 2_000, isTaskContainer: false },
        ],
      },
      mem(),
      NOW,
    );
    expect(snap.activeRuns.telegram_main).toEqual({
      startedAt: '2026-09-28T09:59:58.000Z',
      task: false,
    });
  });
});

describe('channelConnectivity', () => {
  it('reports a channel whose isConnected throws as disconnected', () => {
    expect(
      channelConnectivity([
        { name: 'telegram', isConnected: () => true },
        {
          name: 'whatsapp',
          isConnected: () => {
            throw new Error('socket gone');
          },
        },
      ]),
    ).toEqual({ telegram: true, whatsapp: false });
  });

  it('treats two channels under one name as connected when either is', () => {
    expect(
      channelConnectivity([
        { name: 'telegram', isConnected: () => false },
        { name: 'telegram', isConnected: () => true },
      ]),
    ).toEqual({ telegram: true });
  });
});

describe('writeHeartbeatFile', () => {
  const snap = buildHeartbeat(
    {
      pid: 7,
      processStartedAtMs: NOW,
      channels: { telegram: true },
      loopTickAt: NOW,
      eventLoopDelayMaxMs: 3,
    },
    mem(),
    NOW,
  );

  it('writes atomically: JSON parses, mode 0600, no temp file left behind', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'store', 'heartbeat.json');
    expect(writeHeartbeatFile(file, snap, new Set())).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as HeartbeatSnapshot;
    expect(parsed).toEqual(snap);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['heartbeat.json']);

    // Overwrite in place keeps the same guarantees.
    expect(writeHeartbeatFile(file, { ...snap, pid: 8 }, new Set())).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(8);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['heartbeat.json']);
  });

  it('replaces a temp file left over by an earlier failed write', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'heartbeat.json');
    fs.writeFileSync(`${file}.tmp-${process.pid}`, 'stale', { mode: 0o644 });
    expect(writeHeartbeatFile(file, snap, new Set())).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['heartbeat.json']);
  });

  it('never throws on a broken target and warns once per error code', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'heartbeat.json');
    // The target is a non-empty directory: rename must fail.
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'keep'), 'x');
    const warned = new Set<string>();

    expect(() => writeHeartbeatFile(file, snap, warned)).not.toThrow();
    expect(writeHeartbeatFile(file, snap, warned)).toBe(false);
    expect(writeHeartbeatFile(file, snap, warned)).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // The failed attempt cleans up its temp file.
    expect(fs.readdirSync(dir)).toEqual(['heartbeat.json']);

    // Once writes work again the warning budget resets.
    fs.rmSync(file, { recursive: true });
    expect(writeHeartbeatFile(file, snap, warned)).toBe(true);
    expect(warned.size).toBe(0);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});

describe('startHeartbeat', () => {
  it('writes at start and then every 60 s until stopped', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const dir = tmpDir();
    const file = path.join(dir, 'heartbeat.json');
    let tick: number | undefined;
    const readTs = () => JSON.parse(fs.readFileSync(file, 'utf8')).ts;

    const hb = startHeartbeat({
      file,
      getChannels: () => ({ telegram: true }),
      getLoopTickAt: () => tick,
      getActiveRuns: () => [
        { groupFolder: 'telegram_main', startedAt: NOW, isTaskContainer: false },
      ],
    });
    try {
      const first = JSON.parse(fs.readFileSync(file, 'utf8')) as HeartbeatSnapshot;
      expect(first.ts).toBe('2026-09-28T10:00:00.000Z');
      expect(first.pid).toBe(process.pid);
      expect(first.phase).toBe('starting');
      expect(first.activeRuns).toHaveProperty('telegram_main');

      tick = NOW + 30_000;
      vi.advanceTimersByTime(59_999);
      expect(readTs()).toBe('2026-09-28T10:00:00.000Z');
      vi.advanceTimersByTime(1);
      const second = JSON.parse(fs.readFileSync(file, 'utf8')) as HeartbeatSnapshot;
      expect(second.ts).toBe('2026-09-28T10:01:00.000Z');
      expect(second.phase).toBe('running');
      expect(second.loopTickAgeSec).toBe(30);

      vi.advanceTimersByTime(60_000);
      expect(readTs()).toBe('2026-09-28T10:02:00.000Z');
    } finally {
      hb.stop();
    }
    vi.advanceTimersByTime(5 * 60_000);
    expect(readTs()).toBe('2026-09-28T10:02:00.000Z');
  });

  it('keeps beating when a getter throws', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const dir = tmpDir();
    const file = path.join(dir, 'heartbeat.json');
    const hb = startHeartbeat({
      file,
      getChannels: () => {
        throw new Error('channel registry exploded');
      },
      getLoopTickAt: () => NOW,
      getActiveRuns: () => {
        throw new Error('queue exploded');
      },
    });
    try {
      const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as HeartbeatSnapshot;
      expect(snap.channels).toEqual({});
      expect(snap.activeRunCount).toBe(0);
      expect(snap.phase).toBe('running');
    } finally {
      hb.stop();
    }
  });

  it("uses an unref'd timer so the heartbeat never holds the process open", () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const dir = tmpDir();
    const hb = startHeartbeat({
      file: path.join(dir, 'heartbeat.json'),
      getChannels: () => ({}),
      getLoopTickAt: () => undefined,
    });
    try {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBe(60_000);
      const timer = spy.mock.results[0].value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
    } finally {
      hb.stop();
    }
  });
});
