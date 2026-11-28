// Человеческое название плановой задачи и признак «фон / напоминание» (W25).
//
// Раньше в уведомлении «⏳ Сейчас идёт плановая задача …» стояли первые слова
// задания: «<internal>Продолжи разрешённую владельцем…», «ВАЖНАЯ ПОПРАВКА
// ВЛАДЕЛЬЦА12345: …» (5 уведомлений из 6 за неделю). Теперь модель
// может дать задаче название сама (необязательное поле title в schedule_task),
// а если не дала — хост придумывает его здесь, без служебного текста.
import type { ScheduledTask } from './types.js';

export const TASK_TITLE_MAX_CHARS = 60;

const INTERNAL_PREFIX = /^\s*(?:<internal\b[^>]*>|\[internal\b[^\]]*\])/iu;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Cut at a word boundary; the result, «…» included, fits in maxChars. */
function truncateAtWord(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const cut = chars.slice(0, Math.max(1, maxChars - 1)).join('');
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace >= cut.length / 2 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s,.;:!?—-]+$/u, '')}…`;
}

function withoutMarkup(text: string): string {
  return text
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\[(?:internal|system|host)\b[^\]]*\]/giu, ' ');
}

function capitalize(text: string): string {
  const [first = '', ...rest] = Array.from(text);
  return first.toLocaleUpperCase('ru-RU') + rest.join('');
}

/**
 * A title as given by the model or a person: no tags, one line, at most 60
 * characters. null when nothing is left.
 */
export function normalizeTaskTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = collapseWhitespace(withoutMarkup(raw));
  return text ? truncateAtWord(text, TASK_TITLE_MAX_CHARS) : null;
}

/** The prompt is marked as the model's own service work. */
export function isInternalTaskPrompt(
  prompt: string | null | undefined,
): boolean {
  return typeof prompt === 'string' && INTERNAL_PREFIX.test(prompt);
}

/**
 * What the task is, decided once at creation from what the model said:
 * <internal> at the start of the prompt or calendar_event=false (the
 * schedule_task description asks for both on background work) — background;
 * anything else is meant for people and is treated as a reminder.
 */
export function classifyTaskKind(input: {
  prompt: string;
  calendarEvent?: boolean;
}): 'background' | 'reminder' {
  return isInternalTaskPrompt(input.prompt) || input.calendarEvent === false
    ? 'background'
    : 'reminder';
}

/**
 * Background work, which the «Остановить» buttons may stop. A legacy row
 * without the stored kind counts as background only by its <internal> prefix:
 * when unsure, it is left alone like a reminder.
 */
export function isBackgroundTask(
  task: Pick<ScheduledTask, 'prompt'> &
    Partial<Pick<ScheduledTask, 'task_kind'>>,
): boolean {
  if (task.task_kind === 'background') return true;
  if (task.task_kind === 'reminder') return false;
  return isInternalTaskPrompt(task.prompt);
}

function formatCreatedAt(createdAt: string, timeZone: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || '';
  return `${part('day')}.${part('month')} ${part('hour')}:${part('minute')}`;
}

// «ВАЖНАЯ ПОПРАВКА ВЛАДЕЛЬЦА12345:», «СРОЧНО:», «IMPORTANT:» at the very start.
const SHOUTED_SERVICE_PREFIX =
  /^[\s«"']*[A-ZА-ЯЁ0-9 ]*(?:ВАЖН|ПОПРАВК|СРОЧН|ВНИМАН|IMPORTANT|NOTE|UPDATE)[A-ZА-ЯЁ0-9 ]*[»"']*\s*[:.!—-]+\s*/u;

/** First words of a prompt meant for people, without service noise. */
function promptHeadline(prompt: string): string {
  let text = collapseWhitespace(withoutMarkup(prompt));
  text = text.replace(SHOUTED_SERVICE_PREFIX, '');
  text = text
    // «ВЛАДЕЛЬЦА12345» — a message number glued to a word.
    .replace(/([A-Za-zА-Яа-яЁё])\d{4,}\b/gu, '$1')
    // «сообщение 12345» → «сообщение»; «msg #12345», «№12345», «#12345».
    .replace(/(сообщени\p{L}*|message|msg)\s*(?:№|#|id)?\s*\d{3,}/giu, '$1')
    .replace(/(?:№|#)\s*\d{3,}/gu, ' ');
  text = collapseWhitespace(text).replace(/^[\s,.;:!?—-]+/u, '');
  return text ? capitalize(truncateAtWord(text, TASK_TITLE_MAX_CHARS)) : '';
}

/** Host-made title for a task without one. */
export function autoTaskTitle(
  task: Pick<ScheduledTask, 'prompt' | 'created_at'>,
  timeZone: string,
): string {
  const when = formatCreatedAt(task.created_at, timeZone);
  const suffix = when ? ` от ${when}` : '';
  if (isInternalTaskPrompt(task.prompt)) return `Фоновая задача${suffix}`;
  return promptHeadline(task.prompt) || `Задача${suffix}`;
}

/** A run of digits that reads as a phone number (or an id) — kept to its last 4. */
const PHONE_LIKE = /\+?\d[\d ()-]{8,}\d/gu;
/** YYYY-MM-DD and DD-MM-YYYY are dates, not phone numbers. */
const DATE_LIKE =
  /(?<![\d+-])(?:(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])|(?:0[1-9]|[12]\d|3[01])-(?:0[1-9]|1[0-2])-(?:19|20)\d{2})(?![\d-])/gu;
const DAY = '(?:0?[1-9]|[12]\\d|3[01])';
/** «01-07 11-13» — day ranges, not a phone number. */
const DAY_RANGES = new RegExp(`^${DAY}-${DAY}(?: ${DAY}-${DAY})*$`, 'u');

function maskPhoneLikePart(part: string): string {
  return part.replace(PHONE_LIKE, (match) => {
    if (DAY_RANGES.test(match)) return match;
    const digits = match.replace(/\D/gu, '');
    return digits.length >= 7 ? `…${digits.slice(-4)}` : match;
  });
}

/**
 * Phone-like digit runs kept to their last 4 digits; dates (2026-11-09,
 * 10-11-2026) and day ranges (01-07 11-13) are left as they are — «Сводка
 * за 2026-11-09» used to become «Сводка за …1109» (r1109 review,
 * task-events-4). The deadman's maskPhoneLike follows the same rule.
 */
export function maskPhoneLike(text: string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(DATE_LIKE)) {
    const at = match.index ?? 0;
    out += maskPhoneLikePart(text.slice(last, at)) + match[0];
    last = at + match[0].length;
  }
  return out + maskPhoneLikePart(text.slice(last));
}

/**
 * The task's name for telemetry (events, the watchdog's notices) — never a
 * word of the prompt: the stored title (the model's or a person's), else the
 * host-made «Фоновая задача от 05.11 14:00» / «Задача от …». The automatic
 * title of a reminder is the prompt's opening, so it is not used here. Long
 * digit runs (phone numbers) are masked; dates are not.
 */
export function taskTelemetryTitle(
  task: Pick<ScheduledTask, 'prompt' | 'created_at'> &
    Partial<Pick<ScheduledTask, 'title' | 'task_kind'>>,
  timeZone: string,
): string {
  const stored = normalizeTaskTitle(task.title);
  if (stored) return maskPhoneLike(stored);
  const when = formatCreatedAt(task.created_at, timeZone);
  return `${isBackgroundTask(task) ? 'Фоновая задача' : 'Задача'}${when ? ` от ${when}` : ''}`;
}

/** The name people see: the stored title, else the host-made one. */
export function taskDisplayTitle(
  task: Pick<ScheduledTask, 'prompt' | 'created_at'> &
    Partial<Pick<ScheduledTask, 'title'>>,
  timeZone: string,
): string {
  return normalizeTaskTitle(task.title) ?? autoTaskTitle(task, timeZone);
}
