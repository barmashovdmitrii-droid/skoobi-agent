import {
  CODEX_ACCOUNT_READING_MAX_AGE_MS,
  CODEX_ACCOUNT_READING_MAX_FUTURE_MS,
  type CodexAccountReading,
  type CodexLimitWindow,
} from './codex-exec.js';

/**
 * CLAUDECLAW_CODEX_HOST_WINDOWS as the tool may use it (review r1111,
 * turn-2): a small JSON list of windows with finite numbers; anything else —
 * too long, malformed, odd fields — is no windows (the older rules apply).
 */
export function parseCodexHostWindows(raw: string): CodexLimitWindow[] {
  if (!raw || raw.length > 2048) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value) || value.length > 4) return [];
  const out: CodexLimitWindow[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return [];
    const { usedPercent, windowMinutes, resetsAtMs } = item as Record<string, unknown>;
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return [];
    if (windowMinutes !== undefined && !(typeof windowMinutes === 'number' && Number.isFinite(windowMinutes) && windowMinutes > 0)) return [];
    if (resetsAtMs !== undefined && !(typeof resetsAtMs === 'number' && Number.isFinite(resetsAtMs))) return [];
    out.push({
      usedPercent,
      ...(windowMinutes !== undefined ? { windowMinutes: windowMinutes as number } : {}),
      ...(resetsAtMs !== undefined ? { resetsAtMs: resetsAtMs as number } : {}),
    });
  }
  return out;
}

/**
 * W27-ост (r1111): the summary behind the codex_quota_status tool — how much
 * of the shared Codex limit is used and left, and when each window resets.
 *
 * The bot used to state the reset time of a window as a fact.
 * codex's resets_at is the latest moment the window resets: the limit is
 * often reset earlier. So the reset time is offered only as «не позже», and
 * `howToSay` tells the model how to put it; CLAUDE.md stays as it is.
 *
 * Sources, the same as the Fast ceiling's (resolveCodexTurnServiceTier):
 * this chat's own newest snapshot (read live, with windows) and the host's
 * reading across every CODEX_HOME at run start (percent only). Credit
 * balances and other account details stay out.
 *
 * W27-1 (r1111): unlike the Fast ceiling, which takes the larger percent to
 * stay on the safe side, a report takes the NEWER reading: after a reset
 * the larger one is the old one. The host reading carries no time of its
 * own; it was taken no later than the run start (hostReadByMs), and it is
 * the newest snapshot across all homes then, this chat's included. So this
 * chat's snapshot wins only when it was taken after the run start. A window
 * whose reset time has passed no longer counts at its old percent, and the
 * host percent, taken at an unknown moment around that reset, does not
 * either: without a live window the tool says the limit has reset by its
 * term and the exact percent comes after the next turn.
 *
 * Сведение с r1110: a reading is fresh by its snapshot's own time, no older
 * than CODEX_ACCOUNT_READING_MAX_AGE_MS (6 h) and not ahead of the clock —
 * at the moment the tool is asked, not only at run start. The local reading
 * is judged so by codexAccountReading. A host that passes its snapshot's
 * time (hostReadingAtMs) gets the same rule: older than 6 h it is no
 * reading, and the newer of the two snapshots by their own times wins; a
 * passed reset drops it only when it was taken before that reset. Without
 * that time (an older host) the run-start rule above stays.
 */
export interface CodexQuotaWindowStatus {
  window: string;
  /** Absent once the window's reset time has passed: the old percent is gone. */
  usedPercent?: number;
  leftPercent?: number;
  resetsNotLaterThanUtc?: string;
  resetsNotLaterThanLocal?: string;
  resetPassed?: true;
}

export interface CodexQuotaStatus {
  kind: 'codex_quota_status';
  known: boolean;
  usedPercent?: number;
  leftPercent?: number;
  readingAgeMinutes?: number;
  /** Some window's reset time passed after the snapshot was taken. */
  resetPassedSinceReading?: true;
  windows?: CodexQuotaWindowStatus[];
  paidCreditsAfterLimit?: boolean;
  howToSay: string;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const left = (used: number): number => round1(Math.max(0, 100 - used));

function windowLabel(minutes: number | undefined): string {
  if (minutes === 10080) return 'неделя';
  if (minutes === 300) return '5 часов';
  if (typeof minutes === 'number' && minutes > 0) {
    return minutes % 1440 === 0
      ? `${minutes / 1440} дн.`
      : minutes % 60 === 0
        ? `${minutes / 60} ч`
        : `${minutes} мин`;
  }
  return 'окно лимита';
}

function localTime(ms: number, timeZone: string | undefined): string {
  const format = (zone: string | undefined) =>
    new Intl.DateTimeFormat('ru-RU', {
      timeZone: zone,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(ms));
  try {
    return format(timeZone || undefined);
  } catch {
    return format('UTC'); // an unknown zone name: say it in UTC
  }
}

const finiteOrNull = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function codexQuotaStatus(input: {
  local: CodexAccountReading | null;
  hostUsedPercent: number | null | undefined;
  /**
   * The latest moment the host reading can have been taken: the run start
   * (CLAUDECLAW_CODEX_HOST_READ_BY_MS). Unknown: the larger percent counts,
   * as before W27-1.
   */
  hostReadByMs?: number | null;
  /**
   * The own time of the host's snapshot (CLAUDECLAW_CODEX_HOST_READING_AT_MS).
   * When known, the host reading is fresh by it, as the local one is.
   */
  hostReadingAtMs?: number | null;
  /**
   * The windows of the host's snapshot (CLAUDECLAW_CODEX_HOST_WINDOWS,
   * review r1111 turn-2). A host window whose reset has passed is no reading,
   * as a local one is; without windows (an older host) the rules above stay.
   */
  hostWindows?: CodexLimitWindow[] | null;
  now: number;
  timeZone?: string;
}): CodexQuotaStatus {
  const local = input.local;
  const localWindows = local?.windows ?? [];
  const isPast = (window: { resetsAtMs?: number }): boolean =>
    window.resetsAtMs !== undefined && window.resetsAtMs <= input.now;
  const resetPassed = localWindows.some(isPast);
  const liveWindows = localWindows.filter((window) => !isPast(window));
  const lastPassedResetMs = Math.max(
    -Infinity,
    ...localWindows
      .filter(isPast)
      .map((window) => window.resetsAtMs as number),
  );
  // This chat's percent over the windows that have not reset since.
  const localUsed = !local
    ? null
    : localWindows.length === 0
      ? local.usedPercent
      : liveWindows.length > 0
        ? Math.max(...liveWindows.map((window) => window.usedPercent))
        : null;
  const hostAt = finiteOrNull(input.hostReadingAtMs);
  // r1110: by its own time the host snapshot is a reading only while it is
  // no older than 6 h and not ahead of the clock — when the tool is asked.
  const hostFresh =
    hostAt === null ||
    (input.now - hostAt <= CODEX_ACCOUNT_READING_MAX_AGE_MS &&
      hostAt <= input.now + CODEX_ACCOUNT_READING_MAX_FUTURE_MS);
  // The host percent has no windows: after a reset this chat's snapshot
  // shows, it may be the old one — unless its own time says it came after.
  const hostAfterReset = hostAt !== null && hostAt > lastPassedResetMs;
  // turn-2: with its windows the host reading is judged like this chat's own:
  // the larger percent over the windows that have not reset since. All of
  // them past — no reading (a week's reset hid behind a 97 % host snapshot
  // for a member whose chat had no snapshot of its own).
  const hostWindows = (input.hostWindows ?? []).filter(
    (window) => Number.isFinite(window.usedPercent),
  );
  const hostLiveWindows = hostWindows.filter((window) => !isPast(window));
  const hostResetPassed = hostAt !== null && hostWindows.some(isPast);
  const hostPercent =
    hostWindows.length === 0 || hostAt === null
      ? finiteOrNull(input.hostUsedPercent)
      : hostLiveWindows.length > 0
        ? Math.max(...hostLiveWindows.map((window) => window.usedPercent))
        : null;
  const host =
    !hostFresh || (resetPassed && !hostAfterReset) || finiteOrNull(input.hostUsedPercent) === null
      ? null
      : hostPercent;
  const hostReadBy = finiteOrNull(input.hostReadByMs);
  let used: number | null;
  let fromLocal: boolean;
  if (localUsed !== null && host !== null) {
    fromLocal =
      hostAt !== null
        ? local!.atMs >= hostAt
        : hostReadBy === null
          ? localUsed >= host
          : local!.atMs > hostReadBy;
    used = fromLocal ? localUsed : host;
  } else {
    fromLocal = localUsed !== null;
    used = localUsed ?? host;
  }
  const windowStatus = (window: CodexLimitWindow): CodexQuotaWindowStatus => {
    const status: CodexQuotaWindowStatus = { window: windowLabel(window.windowMinutes) };
    if (isPast(window)) {
      status.resetPassed = true;
    } else {
      status.usedPercent = round1(window.usedPercent);
      status.leftPercent = left(window.usedPercent);
      if (window.resetsAtMs !== undefined) {
        status.resetsNotLaterThanUtc = new Date(window.resetsAtMs).toISOString();
        status.resetsNotLaterThanLocal = localTime(window.resetsAtMs, input.timeZone);
      }
    }
    return status;
  };
  const windows: CodexQuotaWindowStatus[] = localWindows.map(windowStatus);
  // Without its own snapshot the chat shows the host's windows (turn-2).
  if (!local && hostAt !== null && hostFresh && finiteOrNull(input.hostUsedPercent) !== null) {
    for (const window of hostWindows) windows.push(windowStatus(window));
  }
  const anyResetPassed = resetPassed || (!local && hostResetPassed && hostFresh);
  if (used === null) {
    return {
      kind: 'codex_quota_status',
      known: false,
      ...(anyResetPassed ? { resetPassedSinceReading: true as const, windows } : {}),
      howToSay: anyResetPassed
        ? 'По сроку лимит уже сбросился после последнего показания. Скажи так: ' +
          '«по сроку лимит уже обновился, точный процент будет после следующего хода». ' +
          'Старый процент и дату сброса не называй.'
        : 'Свежего показания лимита нет (за последние 6 ч ни одного хода с ним). ' +
          'Процент и дату сброса не называй наугад: скажи, что показание появится после следующего хода.',
    };
  }
  used = round1(used);
  const hasReset = windows.some((window) => window.resetsNotLaterThanUtc);
  const credits = local?.hasCredits;
  const howToSay = [
    `Говори коротко: «использовано ${used} %, осталось ${left(used)} %».`,
    hasReset
      ? 'Дату сброса называй только так: «не позже <дата и время>, часто раньше» — Codex нередко сбрасывает лимит раньше срока; без этой оговорки дату не называй.'
      : 'Срок сброса неизвестен — дату сброса не называй.',
    resetPassed || (!local && hostResetPassed)
      ? 'Окно с пометкой resetPassed по сроку уже сбросилось — его старый процент не называй.'
      : '',
    'Это снимок с последнего хода, а не живой счётчик.',
    credits === true
      ? 'После 100 % ходы идут за платные кредиты аккаунта.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    kind: 'codex_quota_status',
    known: true,
    usedPercent: used,
    leftPercent: left(used),
    ...(local && fromLocal
      ? {
          readingAgeMinutes: Math.max(
            0,
            Math.round((input.now - local.atMs) / 60_000),
          ),
        }
      : !fromLocal && hostAt !== null
        ? {
            readingAgeMinutes: Math.max(
              0,
              Math.round((input.now - hostAt) / 60_000),
            ),
          }
        : {}),
    ...(anyResetPassed ? { resetPassedSinceReading: true as const } : {}),
    windows,
    ...(typeof credits === 'boolean' ? { paidCreditsAfterLimit: credits } : {}),
    howToSay,
  };
}
