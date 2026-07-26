import {
  createGoogleCalendarAdapterFromEnv,
  DEFAULT_GOOGLE_CALENDAR_TIMEZONE,
} from '../orchestrator/calendar-adapter.js';

function localDateTimeInMinutes(minutes: number): string {
  const date = new Date(Date.now() + minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds()),
  ].join('');
}

async function main(): Promise<void> {
  const adapter = createGoogleCalendarAdapterFromEnv();
  if (!adapter) {
    throw new Error(
      'Google Calendar is not configured. Set SKOOBI_GOOGLE_CALENDAR_KEY_FILE or GOOGLE_APPLICATION_CREDENTIALS.',
    );
  }

  const taskId = `calendar-smoke-${Date.now()}`;
  const scheduleValue = localDateTimeInMinutes(5);
  const event = await adapter.createReminderEvent({
    taskId,
    prompt: 'Skoobi Google Calendar smoke test',
    scheduleValue,
    timeZone: adapter.config.timeZone || DEFAULT_GOOGLE_CALENDAR_TIMEZONE,
  });

  if (!event.id) throw new Error('Smoke event was created without an id');

  try {
    const timeMin = new Date(Date.now() - 60_000).toISOString();
    const timeMax = new Date(Date.now() + 15 * 60_000).toISOString();
    const events = await adapter.listEvents({
      timeMin,
      timeMax,
      query: 'Skoobi Google Calendar smoke test',
      maxResults: 10,
    });
    const found = events.some((candidate) => candidate.id === event.id);
    if (!found) {
      throw new Error('Smoke event was not found after creation');
    }
    console.log(`created_and_found event_id=${event.id}`);
  } finally {
    await adapter.deleteEvent(event.id);
    console.log(`deleted event_id=${event.id}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
