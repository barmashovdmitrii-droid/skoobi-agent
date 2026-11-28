import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
  createGracefulShutdown,
  resolveShutdownDeadlineMs,
  SHUTDOWN_DEADLINE_DEFAULT_MS,
} from './graceful-shutdown.js';

function harness() {
  const exit = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn() };
  return { exit, log };
}

describe('остановка бота с пределом времени (J06)', () => {
  it('обычная остановка: все шаги по порядку, затем выход с кодом 0', async () => {
    const { exit, log } = harness();
    const order: string[] = [];
    const shutdown = createGracefulShutdown({
      deadlineMs: 1_000,
      stepTimeoutMs: 500,
      exit,
      log,
      steps: () => [
        { name: 'queue', run: async () => void order.push('queue') },
        { name: 'telegram', run: async () => void order.push('telegram') },
      ],
    });
    await shutdown('SIGTERM');
    expect(order).toEqual(['queue', 'telegram']);
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('зависший шаг не держит остальные: он пропускается по своему пределу', async () => {
    vi.useFakeTimers();
    try {
      const { exit, log } = harness();
      const done: string[] = [];
      const shutdown = createGracefulShutdown({
        deadlineMs: 10_000,
        stepTimeoutMs: 2_000,
        exit,
        log,
        steps: () => [
          { name: 'whatsapp', run: () => new Promise<void>(() => {}) },
          { name: 'telegram', run: async () => void done.push('telegram') },
        ],
      });
      const finished = shutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(2_000);
      await finished;
      expect(done).toEqual(['telegram']);
      expect(exit).toHaveBeenCalledWith(0);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ step: 'whatsapp' }),
        expect.stringContaining('did not finish'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('общий предел: процесс выходит сам, не дожидаясь kill -9', async () => {
    vi.useFakeTimers();
    try {
      const { exit, log } = harness();
      const shutdown = createGracefulShutdown({
        deadlineMs: 3_000,
        stepTimeoutMs: 2_500,
        exit,
        log,
        steps: () => [
          { name: 'a', run: () => new Promise<void>(() => {}) },
          { name: 'b', run: () => new Promise<void>(() => {}) },
        ],
      });
      void shutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ step: 'b' }),
        expect.stringContaining('deadline'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('ошибка шага не мешает остальным и выходу', async () => {
    const { exit, log } = harness();
    const done: string[] = [];
    const shutdown = createGracefulShutdown({
      deadlineMs: 1_000,
      stepTimeoutMs: 500,
      exit,
      log,
      steps: () => [
        { name: 'queue', run: () => { throw new Error('boom'); } },
        { name: 'telegram', run: async () => void done.push('telegram') },
      ],
    });
    await shutdown('SIGINT');
    expect(done).toEqual(['telegram']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('второй сигнал во время остановки не запускает её заново', async () => {
    const { exit, log } = harness();
    let runs = 0;
    let release!: () => void;
    const shutdown = createGracefulShutdown({
      deadlineMs: 1_000,
      stepTimeoutMs: 1_000,
      exit,
      log,
      steps: () => [
        {
          name: 'queue',
          run: () => {
            runs += 1;
            return new Promise<void>((resolve) => (release = resolve));
          },
        },
      ],
    });
    const first = shutdown('SIGTERM');
    await shutdown('SIGTERM');
    release();
    await first;
    expect(runs).toBe(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('предел берётся из SKOOBI_SHUTDOWN_DEADLINE_MS, неверное значение — по умолчанию', () => {
    expect(resolveShutdownDeadlineMs({})).toBe(SHUTDOWN_DEADLINE_DEFAULT_MS);
    expect(resolveShutdownDeadlineMs({ SKOOBI_SHUTDOWN_DEADLINE_MS: '5000' })).toBe(5_000);
    expect(resolveShutdownDeadlineMs({ SKOOBI_SHUTDOWN_DEADLINE_MS: 'abc' })).toBe(
      SHUTDOWN_DEADLINE_DEFAULT_MS,
    );
    // Не меньше секунды и не больше 18 с (launchd добивает через 20 с).
    expect(resolveShutdownDeadlineMs({ SKOOBI_SHUTDOWN_DEADLINE_MS: '10' })).toBe(1_000);
    expect(resolveShutdownDeadlineMs({ SKOOBI_SHUTDOWN_DEADLINE_MS: '60000' })).toBe(18_000);
  });

  it('значение из .env работает: .env не грузится в process.env (ревью r1111)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-env-'));
    const envFile = path.join(dir, '.env');
    try {
      fs.writeFileSync(envFile, 'OTHER=1\nSKOOBI_SHUTDOWN_DEADLINE_MS=5000\n');
      vi.stubEnv('CLAUDECLAW_ENV_FILE', envFile);
      vi.stubEnv('SKOOBI_SHUTDOWN_DEADLINE_MS', '');
      expect(resolveShutdownDeadlineMs()).toBe(5_000);
      // Значение из окружения процесса (plist) — главнее.
      vi.stubEnv('SKOOBI_SHUTDOWN_DEADLINE_MS', '7000');
      expect(resolveShutdownDeadlineMs()).toBe(7_000);
      // Нет ни там, ни там — по умолчанию.
      vi.stubEnv('SKOOBI_SHUTDOWN_DEADLINE_MS', '');
      fs.writeFileSync(envFile, 'OTHER=1\n');
      expect(resolveShutdownDeadlineMs()).toBe(SHUTDOWN_DEADLINE_DEFAULT_MS);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
