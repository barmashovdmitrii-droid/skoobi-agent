// When a scheduled task runs next. Its own module, apart from the scheduler, so
// the dashboard (a separate process) can re-arm a task by the very same rule
// without loading the scheduler and its runtimes. Depends only on the
// schedule columns, cron-parser and TIMEZONE.
import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './config.js';
import { logger } from './logger.js';
import type { ScheduledTask } from './types.js';

export type TaskScheduleFields = Pick<
  ScheduledTask,
  'id' | 'schedule_type' | 'schedule_value' | 'next_run'
>;

/** Schedule fields plus the status, which decides whether a once-task is re-armed. */
export type ResumableTaskFields = TaskScheduleFields &
  Partial<Pick<ScheduledTask, 'status'>>;

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: TaskScheduleFields): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    // Guard against a malformed schedule_value, mirroring the interval branch
    // below. IPC create/update validate cron, but a legacy row, a direct DB
    // edit, or the autonomous self-improver writing the DB can land an
    // unparseable expression here. computeNextRun runs in the post-run
    // bookkeeping path (computeNextRunAfterTaskAttempt at runTask), AFTER the
    // agent run + logTaskRun. An unguarded throw there would reject runTask
    // before updateTaskAfterRun advances next_run, so the still-due task is
    // re-selected and re-executed (with side effects) on every 60s poll — an
    // indefinite re-execution loop. On parse failure, return null so the task
    // completes once and stops recurring rather than spinning.
    try {
      const interval = CronExpressionParser.parse(task.schedule_value, {
        tz: TIMEZONE,
      });
      return interval.next().toISOString();
    } catch (err) {
      logger.warn(
        { taskId: task.id, value: task.schedule_value, err },
        'Invalid cron expression; completing task instead of recurring',
      );
      return null;
    }
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    //
    // Guard the null/invalid next_run case: getDueTasks() filters
    // next_run IS NOT NULL, but this function is exported and also
    // reachable via computeNextRunAfterTaskAttempt, so a legacy/manual/
    // programmatic interval row with a null or unparseable next_run can
    // reach here. Without this guard `new Date(null).getTime()` is 0 and
    // the while-loop below would step from the epoch to now in ms-sized
    // increments (~28M iterations for a 60s interval), stalling the
    // single-threaded scheduler for seconds.
    const base = task.next_run ? new Date(task.next_run).getTime() : now;
    if (Number.isNaN(base)) {
      logger.warn(
        { taskId: task.id, nextRun: task.next_run },
        'Interval task has missing/invalid next_run; anchoring to now',
      );
      return new Date(now + ms).toISOString();
    }
    // Compute the first grid-aligned slot strictly in the future in O(1)
    // rather than iterating, so a far-past anchor can never spin the loop.
    let next = base + ms;
    if (next <= now) {
      const missed = Math.ceil((now - base) / ms);
      next = base + missed * ms;
      if (next <= now) next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

/**
 * The next_run to store when a paused task is resumed, or null to leave the
 * stored one as it is.
 *
 * The scheduler pauses a recurring task with next_run NULL when it gives up on
 * it: a failed run whose external action may already have happened, or too
 * many failures in a row (updateTaskAfterRun writes the NULL). getDueTasks
 * skips NULL, so putting the status back to 'active' alone left the task
 * silently dead, although the pause notice itself tells the owner to say
 * «возобнови задачу». A recurring task is re-armed at its next scheduled
 * slot. A once-task the scheduler gave up on (status 'paused', next_run NULL)
 * never ran successfully, so it is re-armed at its own time if that is still
 * ahead, otherwise right away. A task that still has a next_run keeps it, and a
 * once-task that is not paused (e.g. completed after its run) is left as is.
 */
export function nextRunForResumedTask(
  task: ResumableTaskFields,
  now: number = Date.now(),
): string | null {
  if (task.next_run) return null;
  if (task.schedule_type === 'cron' || task.schedule_type === 'interval') {
    return computeNextRun(task);
  }
  if (task.schedule_type === 'once' && task.status === 'paused') {
    // Same parsing as schedule_task (ipc.ts): local time without a zone.
    const at = new Date(task.schedule_value).getTime();
    if (Number.isNaN(at)) return null;
    return new Date(Math.max(now, at)).toISOString();
  }
  return null;
}
