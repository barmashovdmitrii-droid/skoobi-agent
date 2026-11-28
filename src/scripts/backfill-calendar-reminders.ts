/**
 * One-off backfill for finding P6: reminders that existed before recurring
 * tasks were mirrored, and so never got a Google Calendar event.
 *
 * Reports by default and writes nothing. Pass --apply to create the events and
 * record the links. Safe to re-run: a task that already holds an active link is
 * skipped, so a partial run can simply be repeated.
 *
 * Opens the database directly rather than through the orchestrator module so
 * that running it against a live production store cannot trigger schema
 * migrations behind the running service.
 *
 *   npx tsx src/scripts/backfill-calendar-reminders.ts
 *   npx tsx src/scripts/backfill-calendar-reminders.ts --apply
 */
import path from 'path';

import Database from 'better-sqlite3';

import {
  createGoogleCalendarAdapterFromEnv,
  shouldCreateCalendarEventForTask,
  toCalendarLocalDateTime,
} from '../orchestrator/calendar-adapter.js';
import { calendarRecurrenceForTask } from '../orchestrator/calendar-recurrence.js';
import type { ScheduledTask } from '../orchestrator/types.js';

interface PlannedEvent {
  task: ScheduledTask;
  startValue: string;
  recurrence?: string[];
}

function resolveDbPath(argv: string[]): string {
  const flag = argv.indexOf('--db');
  if (flag !== -1 && argv[flag + 1]) return path.resolve(argv[flag + 1]);
  return path.resolve(process.cwd(), 'store/messages.db');
}

function describe(task: ScheduledTask): string {
  const prompt = task.prompt.replace(/\s+/g, ' ').trim();
  const short = prompt.length > 70 ? `${prompt.slice(0, 69)}…` : prompt;
  return `${task.id} [${task.group_folder}] ${task.schedule_type}=${task.schedule_value}\n    ${short}`;
}

/**
 * Reuse the runtime's own decision so the backfill can never mirror a set of
 * tasks that differs from what a freshly created task would produce.
 */
function planEvents(
  db: Database.Database,
  timeZone: string,
): {
  planned: PlannedEvent[];
  linked: ScheduledTask[];
  skipped: ScheduledTask[];
} {
  const tasks = db
    .prepare("SELECT * FROM scheduled_tasks WHERE status = 'active'")
    .all() as ScheduledTask[];
  const activeLinks = new Set(
    (
      db
        .prepare(
          "SELECT task_id FROM calendar_event_links WHERE status = 'active'",
        )
        .all() as Array<{ task_id: string }>
    ).map((row) => row.task_id),
  );

  const planned: PlannedEvent[] = [];
  const linked: ScheduledTask[] = [];
  const skipped: ScheduledTask[] = [];

  for (const task of tasks) {
    if (!shouldCreateCalendarEventForTask(task)) {
      skipped.push(task);
      continue;
    }
    if (activeLinks.has(task.id)) {
      linked.push(task);
      continue;
    }

    const recurrence = calendarRecurrenceForTask(task);
    if (recurrence.kind === 'unsupported') {
      skipped.push(task);
      continue;
    }

    // Same rule as the live path: a one-off task carries its wall-clock time in
    // schedule_value, a recurring one takes its first occurrence from next_run.
    const rawStart =
      recurrence.kind === 'single' ? task.schedule_value : task.next_run;
    if (!rawStart) {
      skipped.push(task);
      continue;
    }

    let startValue: string;
    try {
      startValue = toCalendarLocalDateTime(rawStart, timeZone);
    } catch {
      skipped.push(task);
      continue;
    }

    planned.push({
      task,
      startValue,
      recurrence: recurrence.kind === 'recurring' ? recurrence.rrule : undefined,
    });
  }

  return { planned, linked, skipped };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const dbPath = resolveDbPath(process.argv);

  const adapter = createGoogleCalendarAdapterFromEnv();
  if (!adapter) {
    throw new Error(
      'Google Calendar is not configured. Set SKOOBI_GOOGLE_CALENDAR_KEY_FILE or GOOGLE_APPLICATION_CREDENTIALS.',
    );
  }

  const timeZone = adapter.config.timeZone;
  const db = new Database(dbPath, { readonly: !apply });
  try {
    const { planned, linked, skipped } = planEvents(db, timeZone);

    console.log(
      `База: ${dbPath}\n` +
        `Календарь: ${adapter.config.calendarId} (${timeZone})\n` +
        `Активных задач: с событием ${linked.length}, без события ${planned.length}, вне правила ${skipped.length}\n`,
    );

    if (!planned.length) {
      console.log('Заводить нечего.');
      return;
    }

    for (const item of planned) {
      console.log(describe(item.task));
      console.log(`    начало: ${item.startValue} (${timeZone})`);
      console.log(`    повтор: ${item.recurrence?.join(' ') || 'разовое'}`);
    }

    if (!apply) {
      console.log('\nЭто отчёт, ничего не создано. Для записи повторить с --apply.');
      return;
    }

    const upsert = db.prepare(`
      INSERT INTO calendar_event_links (
        task_id, provider, calendar_id, event_id, event_link, status, created_at, updated_at
      )
      VALUES (?, 'google_calendar', ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        provider = excluded.provider,
        calendar_id = excluded.calendar_id,
        event_id = excluded.event_id,
        event_link = excluded.event_link,
        status = excluded.status,
        updated_at = excluded.updated_at
    `);

    console.log('');
    let created = 0;
    for (const item of planned) {
      try {
        const event = await adapter.createReminderEvent({
          taskId: item.task.id,
          prompt: item.task.prompt,
          scheduleValue: item.startValue,
          recurrence: item.recurrence,
        });
        if (!event.id) {
          console.error(
            `${item.task.id}: событие создано без id, ссылка не записана`,
          );
          continue;
        }
        const now = new Date().toISOString();
        upsert.run(
          item.task.id,
          adapter.config.calendarId,
          event.id,
          event.htmlLink,
          now,
          now,
        );
        created += 1;
        console.log(`${item.task.id}: создано ${event.id}`);
      } catch (err) {
        // Keep going: one rejected task must not strand the others.
        console.error(
          `${item.task.id}: не удалось — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    console.log(`\nСоздано событий: ${created} из ${planned.length}.`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
