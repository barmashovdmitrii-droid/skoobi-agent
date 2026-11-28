/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  };
  try {
    return date.toLocaleString('en-US', options);
  } catch {
    // An invalid IANA timezone (e.g. a mistyped TZ env var like
    // 'Europe/Moscaw') makes toLocaleString throw RangeError. This runs on
    // the inbound-message hot path, so degrade gracefully to UTC instead of
    // throwing and silently halting message processing for all tenants.
    return date.toLocaleString('en-US', { ...options, timeZone: 'UTC' });
  }
}
