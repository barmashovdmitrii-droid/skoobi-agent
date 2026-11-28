// /tasks и кнопки «Остановить» без запуска модели (W25).
//
// Фоновые задачи можно было увидеть только через модель (list_tasks — платный
// ход) или в панели на localhost, а отмена одной слежки стоила
// отдельного хода модели (~0,9 млн входных токенов). Здесь — список задач
// чата и остановка кнопкой: задача переводится в cancelled тем же способом,
// что и cancel_task, а идущий запуск этой задачи прерывается.
//
// Напоминания людям (task_kind 'reminder') кнопки не трогают: у них нет кнопки
// в списке, и «Остановить все фоновые» их пропускает.
import {
  taskControlCallbackData,
  type OutboundButton,
  type TaskControlAction,
} from '@skoobi/shared/channel-types';

import type { TaskRunTotals } from './db.js';
import { isBackgroundTask, taskDisplayTitle } from './task-title.js';
import type { ScheduledTask } from './types.js';

export const TASK_STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LISTED_TASKS = 10;
const MAX_TASK_BUTTONS = 8;
const BUTTON_TITLE_CHARS = 30;

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function minutesText(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  return minutes < 1 ? 'меньше минуты' : `${minutes} мин`;
}

function runsText(runs: number): string {
  return `${runs} ${plural(runs, 'запуск', 'запуска', 'запусков')}`;
}

function shortTitle(title: string, maxChars: number): string {
  const chars = Array.from(title);
  return chars.length <= maxChars
    ? title
    : `${chars
        .slice(0, maxChars - 1)
        .join('')
        .trimEnd()}…`;
}

function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** «сегодня в 15:30», «завтра в 09:00», «19.11 в 09:00». */
export function formatTaskWhen(
  iso: string,
  now: number,
  timeZone: string,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  const key = dayKey(date, timeZone);
  if (key === dayKey(new Date(now), timeZone)) return `сегодня в ${time}`;
  if (key === dayKey(new Date(now + 24 * 60 * 60 * 1000), timeZone)) {
    return `завтра в ${time}`;
  }
  const dayMonth = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
  }).format(date);
  return `${dayMonth} в ${time}`;
}

/** «09.11 18:00» — the end of a watch (W26). */
export function formatTaskDeadline(iso: string, timeZone: string): string {
  const date = new Date(iso);
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

/** «разово», «каждые 30 мин», «каждый час», «по расписанию». */
export function describeTaskSchedule(
  task: Pick<ScheduledTask, 'schedule_type' | 'schedule_value'>,
): string {
  if (task.schedule_type === 'once') return 'разово';
  if (task.schedule_type === 'cron') return 'по расписанию';
  const ms = parseInt(task.schedule_value, 10);
  if (!Number.isFinite(ms) || ms <= 0) return 'повторяется';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'чаще раза в минуту';
  if (minutes === 60) return 'каждый час';
  if (minutes % 60 === 0) return `каждые ${minutes / 60} ч`;
  return `каждые ${minutes} мин`;
}

export interface ChatTasksOverviewInput {
  /** All tasks of the chat, any status. */
  tasks: ScheduledTask[];
  /** Runs per task over the last TASK_STATS_WINDOW_MS. */
  runTotals: Map<string, TaskRunTotals>;
  /** The scheduled task holding the chat's slot right now. */
  activeRun: { taskId: string; startedAt: number } | null;
  now: number;
  timeZone: string;
}

export interface ChatTasksOverview {
  text: string;
  buttons: OutboundButton[][];
}

function isLive(task: ScheduledTask): boolean {
  return task.status === 'active' || task.status === 'paused';
}

/** Stop button for one background task; none for reminders. */
export function taskStopButton(
  task: ScheduledTask,
  timeZone: string,
  label?: string,
): OutboundButton | null {
  if (!isBackgroundTask(task) || !isLive(task)) return null;
  const callbackData = taskControlCallbackData({
    kind: 'stop',
    taskId: task.id,
  });
  if (!callbackData) return null;
  return {
    text:
      label ??
      `⏹ ${shortTitle(taskDisplayTitle(task, timeZone), BUTTON_TITLE_CHARS)}`,
    callbackData,
  };
}

function taskLine(task: ScheduledTask, input: ChatTasksOverviewInput): string {
  const title = taskDisplayTitle(task, input.timeZone);
  const running = input.activeRun?.taskId === task.id;
  const parts = [describeTaskSchedule(task)];
  // W26: a watch that ends by itself and wakes only on a change.
  if (task.expires_at && task.schedule_type !== 'once') {
    const until = formatTaskDeadline(task.expires_at, input.timeZone);
    if (until) parts[0] += ` до ${until}`;
  }
  if (task.wake_if && task.schedule_type !== 'once') {
    parts.push('будит модель только при изменениях');
  }
  if (running) {
    parts.push(
      `идёт сейчас, ${minutesText(input.now - input.activeRun!.startedAt)}`,
    );
  } else if (task.status === 'paused') {
    parts.push('на паузе');
  } else if (task.next_run) {
    const when = formatTaskWhen(task.next_run, input.now, input.timeZone);
    if (when) parts.push(`следующий запуск ${when}`);
  }
  return `«${title}» — ${parts.join(', ')}`;
}

/** The /tasks answer: background tasks with stop buttons, reminders apart. */
export function buildChatTasksOverview(
  input: ChatTasksOverviewInput,
): ChatTasksOverview {
  const live = input.tasks.filter(isLive);
  const background = live.filter((task) => isBackgroundTask(task));
  const reminders = live.filter((task) => !isBackgroundTask(task));
  const lines: string[] = [];

  const running = input.activeRun
    ? input.tasks.find((task) => task.id === input.activeRun!.taskId)
    : undefined;
  if (input.activeRun) {
    const title = running
      ? `«${taskDisplayTitle(running, input.timeZone)}»`
      : 'плановая задача';
    lines.push(
      `Сейчас идёт ${title} — ${minutesText(input.now - input.activeRun.startedAt)}.`,
    );
  } else {
    lines.push('Сейчас в фоне ничего не выполняется.');
  }

  if (background.length === 0 && reminders.length === 0) {
    lines.push('', 'Плановых задач в этом чате нет.');
  }

  if (background.length > 0) {
    lines.push('', `Фоновые задачи (${background.length}):`);
    background.slice(0, MAX_LISTED_TASKS).forEach((task, index) => {
      lines.push(`${index + 1}. ${taskLine(task, input)}`);
      const totals = input.runTotals.get(task.id);
      const stats: string[] = [];
      if (totals && totals.runs > 0) {
        stats.push(
          `${runsText(totals.runs)}, ${minutesText(totals.durationMs)}`,
        );
      }
      if (totals?.skipped) {
        stats.push(`без изменений пропущено ${totals.skipped}`);
      }
      if (stats.length > 0) lines.push(`   за 7 дней: ${stats.join('; ')}`);
    });
    if (background.length > MAX_LISTED_TASKS) {
      lines.push(`…и ещё ${background.length - MAX_LISTED_TASKS}`);
    }
  }

  if (reminders.length > 0) {
    lines.push('', `Напоминания (${reminders.length}):`);
    for (const task of reminders.slice(0, MAX_LISTED_TASKS)) {
      lines.push(`• ${taskLine(task, input)}`);
    }
    if (reminders.length > MAX_LISTED_TASKS) {
      lines.push(`…и ещё ${reminders.length - MAX_LISTED_TASKS}`);
    }
    lines.push(
      'Напоминания кнопками не останавливаются — попроси меня, если нужно.',
    );
  }

  let totalRuns = 0;
  let totalMs = 0;
  for (const [taskId, totals] of input.runTotals) {
    const task = input.tasks.find((item) => item.id === taskId);
    if (task && !isBackgroundTask(task)) continue;
    totalRuns += totals.runs;
    totalMs += totals.durationMs;
  }
  if (totalRuns > 0) {
    lines.push(
      '',
      `За 7 дней фоновые задачи этого чата: ${runsText(totalRuns)}, ${minutesText(totalMs)} работы.`,
    );
  }

  const buttons: OutboundButton[][] = [];
  for (const task of background.slice(0, MAX_TASK_BUTTONS)) {
    const button = taskStopButton(task, input.timeZone);
    if (button) buttons.push([button]);
  }
  if (background.length >= 2) {
    const callbackData = taskControlCallbackData({
      kind: 'stop_all_background',
    });
    if (callbackData) {
      buttons.push([{ text: '⏹ Остановить все фоновые', callbackData }]);
    }
  }
  return { text: lines.join('\n'), buttons };
}

export interface TaskControlDeps {
  listChatTasks(chatJid: string): ScheduledTask[];
  /** Cancels the task the way cancel_task does (calendar, status). */
  cancelTask(taskId: string): Promise<void>;
  /** Interrupts the run of this task if it holds the chat's slot now. */
  interruptRun(chatJid: string, taskId: string): boolean;
}

export interface TaskControlOutcome {
  stopped: ScheduledTask[];
  interrupted: boolean;
  /** stop: the task is not this chat's or not found. */
  notFound?: boolean;
  /** stop: the task had already finished or was cancelled. */
  alreadyStopped?: ScheduledTask;
  /** stop: a reminder; buttons do not stop those. */
  reminder?: ScheduledTask;
}

/**
 * Status first, then the interrupt: the run ends, sees status 'cancelled' and
 * arms no next run (task-scheduler.ts). Only this chat's tasks are touched.
 */
export async function applyTaskControl(
  chatJid: string,
  action: TaskControlAction,
  deps: TaskControlDeps,
): Promise<TaskControlOutcome> {
  const tasks = deps.listChatTasks(chatJid);
  const targets: ScheduledTask[] = [];
  if (action.kind === 'stop') {
    const task = tasks.find((item) => item.id === action.taskId);
    if (!task) return { stopped: [], interrupted: false, notFound: true };
    if (!isLive(task)) {
      return { stopped: [], interrupted: false, alreadyStopped: task };
    }
    if (!isBackgroundTask(task)) {
      return { stopped: [], interrupted: false, reminder: task };
    }
    targets.push(task);
  } else {
    targets.push(
      ...tasks.filter((task) => isLive(task) && isBackgroundTask(task)),
    );
  }
  const stopped: ScheduledTask[] = [];
  let interrupted = false;
  for (const task of targets) {
    await deps.cancelTask(task.id);
    stopped.push(task);
    if (deps.interruptRun(chatJid, task.id)) interrupted = true;
  }
  return { stopped, interrupted };
}

/** First line of the edited message after a button press, and the pop-up. */
export function taskControlOutcomeText(
  outcome: TaskControlOutcome,
  timeZone: string,
): { toast: string; line: string } {
  if (outcome.notFound) {
    return {
      toast: 'Задача не найдена',
      line: 'Эту задачу не нашёл — возможно, её уже удалили.',
    };
  }
  if (outcome.alreadyStopped) {
    const title = taskDisplayTitle(outcome.alreadyStopped, timeZone);
    return {
      toast: 'Уже остановлена',
      line: `Задача «${title}» уже не выполняется.`,
    };
  }
  if (outcome.reminder) {
    const title = taskDisplayTitle(outcome.reminder, timeZone);
    return {
      toast: 'Это напоминание',
      line: `«${title}» — напоминание, кнопка его не останавливает.`,
    };
  }
  const interrupted = outcome.interrupted ? ' Текущий запуск прерван.' : '';
  if (outcome.stopped.length === 0) {
    return { toast: 'Нечего останавливать', line: 'Фоновых задач нет.' };
  }
  if (outcome.stopped.length === 1) {
    const title = taskDisplayTitle(outcome.stopped[0], timeZone);
    return {
      toast: 'Остановлено',
      line: `⏹ Остановил «${title}».${interrupted}`,
    };
  }
  return {
    toast: 'Остановлено',
    line: `⏹ Остановил фоновые задачи: ${outcome.stopped.length}.${interrupted} Напоминания не трогал.`,
  };
}
