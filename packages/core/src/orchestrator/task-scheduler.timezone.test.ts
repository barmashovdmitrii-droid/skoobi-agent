import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Own file: task-scheduler.test.ts pins TIMEZONE to 'UTC' for the whole
// module. The bot runs with the host zone, Asia/Almaty (UTC+5, no DST), and
// the nightly review is a local-time cron — this is the zone it must follow.
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Skoobi',
  CONTAINER_TIMEOUT: 1800000,
  DEFAULT_RUNTIME: 'container',
  GROUPS_DIR: '/tmp/claudeclaw-task-scheduler-groups',
  IDLE_TIMEOUT: 1800000,
  SCHEDULER_POLL_INTERVAL: 60000,
  TIMEZONE: 'Asia/Almaty',
}));

vi.mock('../runtimes/container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('../runtimes/sandbox-runner.js', () => ({
  runSandboxAgent: vi.fn(),
}));

vi.mock('./model-gateway.js', () => ({
  createModelGateway: vi.fn(),
  loadModelGatewayConfig: vi.fn(),
}));

import { computeNextRun } from './task-scheduler.js';
import type { ScheduledTask } from './types.js';

const reviewTask = (scheduleValue: string): ScheduledTask => ({
  id: 'task-nightly-review',
  group_folder: 'telegram_main',
  chat_jid: 'tg:100000001',
  prompt: 'разбор',
  schedule_type: 'cron',
  schedule_value: scheduleValue,
  context_mode: 'isolated',
  next_run: null,
  last_run: null,
  last_result: null,
  status: 'active',
  created_at: '2026-09-28T00:00:00.000Z',
  run_profile: 'read_only',
});

describe('cron по времени Алматы', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('07:00 по Алматы — это 02:00 UTC следующего утра', () => {

    vi.setSystemTime(new Date('2026-09-28T07:00:00.000Z'));
    expect(computeNextRun(reviewTask('0 7 * * *'))).toBe(
      '2026-09-29T02:00:00.000Z',
    );
  });

  it('до 07:00 по Алматы запуск ещё сегодня', () => {

    vi.setSystemTime(new Date('2026-09-28T01:59:00.000Z'));
    expect(computeNextRun(reviewTask('0 7 * * *'))).toBe(
      '2026-09-28T02:00:00.000Z',
    );
  });

  it('после прогона в 07:00 следующий — ровно через сутки', () => {
    // Post-run bookkeeping happens a few minutes after the start.
    vi.setSystemTime(new Date('2026-09-29T02:03:00.000Z'));
    expect(computeNextRun(reviewTask('0 7 * * *'))).toBe(
      '2026-09-30T02:00:00.000Z',
    );
  });

  it('07:30 по Алматы — 02:30 UTC (вариант из плана)', () => {
    vi.setSystemTime(new Date('2026-09-28T07:00:00.000Z'));
    expect(computeNextRun(reviewTask('30 7 * * *'))).toBe(
      '2026-09-29T02:30:00.000Z',
    );
  });
});
