/**
 * Стоп-кран для мгновенных отказов: модель ни разу не запустилась.
 *
 * Однажды после прерванного продолжения ход 33 раза подряд падал за 7–28 мс,
 * и каждый круг очереди запускал его снова (разбор недели, W05). Общий
 * предел очереди (5 повторов) петлю не останавливал. Здесь считаются
 * мгновенные отказы подряд с одной причиной; после третьего чат «паркуется»:
 * повторов нет, сообщения, чекпоинт и курсор остаются на месте, в чат уходит
 * одно честное сообщение, сторожу — событие chat_fast_fail_parked.
 *
 * Стоп снимается одной попыткой, когда в чате появляется новое сообщение,
 * или по таймеру: через 30 минут, потом через 1 ч, 2 ч и дальше раз в 4 ч.
 * Снова мгновенный отказ — снова стоп. Сообщение о стопе уходит один раз за
 * серию: попытка по таймеру его не повторяет никогда (никто ничего не писал),
 * новое сообщение человека — не раньше чем через FAST_FAIL_NOTICE_REPEAT_MS
 * после прошлого. Окна host-notice-limiter (15 мин) для этого мало: без
 * отметки в серии каждая попытка по таймеру снова слала бы сообщение, около
 * 32 за ночь (ревью r1108). Любой ход, в котором модель всё-таки работала,
 * или успешный ход снимает стоп совсем.
 *
 * Сюда не попадают отказы, которые уже держит pre-start hold
 * (isCodexPreStartFailure) и задержка по доступу (guestCodexPolicyBatch…):
 * у них своё удержание.
 */
export const INSTANT_FAILURE_MAX_MS = 2_000;
export const FAST_FAIL_PARK_AFTER = 3;
export const FAST_FAIL_PARK_MS = 30 * 60 * 1000;
/** Попытки по таймеру редеют: 30 мин, 1 ч, 2 ч, потом раз в 4 ч. */
export const FAST_FAIL_PARK_MAX_MS = 4 * 60 * 60 * 1000;
/** Новое сообщение человека может вернуть сообщение о стопе, но не раньше. */
export const FAST_FAIL_NOTICE_REPEAT_MS = 3 * 60 * 60 * 1000;

const STORE_KEY = 'chat_fast_fail:v1';

export interface FastFailStore {
  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
}

export interface FastFailEntry {
  /** Начало текста ошибки без чисел (fastFailSignature). */
  signature: string;
  /** Мгновенных отказов подряд с этой причиной. */
  count: number;
  /** С какого момента чат стоит (ISO); нет — ещё не стоит. */
  parkedAt?: string;
  /** Самое новое сообщение, которое уже видела неудачная попытка. */
  parkedCursor?: string;
  /** Таймер истёк: следующий запуск — одна попытка. */
  tryAllowed?: boolean;
  /** Когда в этой серии ушло сообщение о стопе (ISO). */
  noticeAt?: string;
  /** Сколько попыток по таймеру уже было в этой серии. */
  timerRounds?: number;
}

/**
 * Решение перед запуском хода: 'run' — чат не стоит; 'skip' — стоит, ход не
 * запускать; 'retry_message' — одна попытка из стопа ради нового сообщения;
 * 'retry_timer' — одна попытка из стопа по таймеру.
 */
export type FastFailRunDecision = 'run' | 'skip' | 'retry_message' | 'retry_timer';

/** Сколько ждать попытки по таймеру после стольких прошлых попыток. */
export function fastFailParkDelayMs(timerRounds = 0): number {
  const rounds = Number.isFinite(timerRounds)
    ? Math.min(Math.max(0, Math.floor(timerRounds)), 8)
    : 0;
  return Math.min(FAST_FAIL_PARK_MS * 2 ** rounds, FAST_FAIL_PARK_MAX_MS);
}

/** Модель не запускалась: ни запросов, ни токенов, ни ответа, меньше 2 с. */
export function isInstantModelFailure(input: {
  status: 'success' | 'error';
  durationMs?: number;
  turns?: number;
  modelRequests?: number;
  inputTokens?: number;
  outputTokens?: number;
  outputSentToUser: boolean;
  sideEffected?: boolean;
  providerResponded?: boolean;
}): boolean {
  return (
    input.status === 'error' &&
    !input.outputSentToUser &&
    input.sideEffected !== true &&
    input.providerResponded !== true &&
    (input.turns ?? 0) === 0 &&
    (input.modelRequests ?? 0) === 0 &&
    (input.inputTokens ?? 0) === 0 &&
    (input.outputTokens ?? 0) === 0 &&
    typeof input.durationMs === 'number' &&
    Number.isFinite(input.durationMs) &&
    input.durationMs >= 0 &&
    input.durationMs < INSTANT_FAILURE_MAX_MS
  );
}

/** «Та же причина»: начало текста ошибки, числа и id не различаются. */
export function fastFailSignature(error?: string): string {
  return String(error ?? 'unknown')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function readAll(store: FastFailStore): Record<string, FastFailEntry> {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(store.get(STORE_KEY) || '{}');
  } catch {
    parsed = {};
  }
  const out: Record<string, FastFailEntry> = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [chatJid, raw] of Object.entries(parsed)) {
    const entry = raw as Partial<FastFailEntry> | null;
    if (
      !entry ||
      typeof entry.signature !== 'string' ||
      typeof entry.count !== 'number' ||
      !Number.isFinite(entry.count) ||
      entry.count < 1
    ) {
      continue;
    }
    out[chatJid] = {
      signature: entry.signature,
      count: Math.floor(entry.count),
      ...(typeof entry.parkedAt === 'string' ? { parkedAt: entry.parkedAt } : {}),
      ...(typeof entry.parkedCursor === 'string'
        ? { parkedCursor: entry.parkedCursor }
        : {}),
      ...(entry.tryAllowed === true ? { tryAllowed: true } : {}),
      ...(typeof entry.noticeAt === 'string' ? { noticeAt: entry.noticeAt } : {}),
      ...(typeof entry.timerRounds === 'number' &&
      Number.isFinite(entry.timerRounds) &&
      entry.timerRounds > 0
        ? { timerRounds: Math.floor(entry.timerRounds) }
        : {}),
    };
  }
  return out;
}

function writeAll(store: FastFailStore, entries: Record<string, FastFailEntry>): void {
  store.set(STORE_KEY, JSON.stringify(entries));
}

export function getFastFailEntry(
  store: FastFailStore,
  chatJid: string,
): FastFailEntry | undefined {
  return readAll(store)[chatJid];
}

/** Модель работала или ход удался: счёт и стоп снимаются. */
export function clearFastFail(store: FastFailStore, chatJid: string): boolean {
  const entries = readAll(store);
  if (!entries[chatJid]) return false;
  delete entries[chatJid];
  writeAll(store, entries);
  return true;
}

/**
 * Ещё один мгновенный отказ. parkNow — чат только что встал (или встал
 * снова после попытки); firstPark — впервые в этой серии.
 */
export function noteInstantFailure(
  store: FastFailStore,
  chatJid: string,
  input: { signature: string; nowMs: number; cursor: string },
): { entry: FastFailEntry; parkNow: boolean; firstPark: boolean } {
  const entries = readAll(store);
  const previous = entries[chatJid];
  const sameCause = previous?.signature === input.signature;
  const wasParked = Boolean(previous?.parkedAt);
  const sameSeries = sameCause || wasParked;
  const count = sameSeries ? (previous?.count ?? 0) + 1 : 1;
  const parkNow = wasParked || count >= FAST_FAIL_PARK_AFTER;
  const entry: FastFailEntry = {
    signature: input.signature,
    count,
    // The series goes on: its notice mark and timer rounds stay with it.
    ...(sameSeries && previous?.noticeAt ? { noticeAt: previous.noticeAt } : {}),
    ...(sameSeries && previous?.timerRounds ? { timerRounds: previous.timerRounds } : {}),
    ...(parkNow
      ? {
          parkedAt: new Date(input.nowMs).toISOString(),
          parkedCursor:
            previous?.parkedCursor && previous.parkedCursor > input.cursor
              ? previous.parkedCursor
              : input.cursor,
        }
      : {}),
  };
  entries[chatJid] = entry;
  writeAll(store, entries);
  return { entry, parkNow, firstPark: parkNow && !wasParked };
}

/**
 * Перед запуском хода. 'run' — стопа нет; 'retry_message' / 'retry_timer' —
 * одна попытка из стопа (пришло новое сообщение / истёк таймер); 'skip' —
 * чат стоит, ход не запускать, ничего не трогать.
 */
export function fastFailRunDecision(
  store: FastFailStore,
  chatJid: string,
  input: { nowMs: number; cursor: string },
): FastFailRunDecision {
  const entries = readAll(store);
  const entry = entries[chatJid];
  if (!entry?.parkedAt) return 'run';
  const parkedAt = Date.parse(entry.parkedAt);
  const timerDue =
    !Number.isFinite(parkedAt) ||
    input.nowMs - parkedAt >= fastFailParkDelayMs(entry.timerRounds);
  const newMessage = !entry.parkedCursor || input.cursor > entry.parkedCursor;
  if (!entry.tryAllowed && !timerDue && !newMessage) return 'skip';
  const attempt: FastFailRunDecision = newMessage ? 'retry_message' : 'retry_timer';
  // Одна попытка: повтор той же пачки без нового сообщения снова встанет.
  entries[chatJid] = {
    ...entry,
    parkedAt: new Date(input.nowMs).toISOString(),
    parkedCursor:
      entry.parkedCursor && entry.parkedCursor > input.cursor
        ? entry.parkedCursor
        : input.cursor,
    // Каждая попытка по таймеру отодвигает следующую вдвое.
    ...(attempt === 'retry_timer' ? { timerRounds: (entry.timerRounds ?? 0) + 1 } : {}),
  };
  delete entries[chatJid].tryAllowed;
  writeAll(store, entries);
  return attempt;
}

/**
 * Можно ли слать сообщение о стопе. Один раз за серию; попытка по таймеру его
 * не повторяет (никто не писал), новое сообщение человека — не раньше чем
 * через FAST_FAIL_NOTICE_REPEAT_MS после прошлого.
 */
export function fastFailNoticeDue(
  entry: FastFailEntry,
  input: { nowMs: number; attempt: FastFailRunDecision },
): boolean {
  if (!entry.noticeAt) return true;
  if (input.attempt !== 'retry_message') return false;
  const last = Date.parse(entry.noticeAt);
  return !Number.isFinite(last) || input.nowMs - last >= FAST_FAIL_NOTICE_REPEAT_MS;
}

/** Сообщение о стопе дошло до чата: отметка на всю серию. */
export function markFastFailNoticeSent(
  store: FastFailStore,
  chatJid: string,
  nowMs: number,
): void {
  const entries = readAll(store);
  const entry = entries[chatJid];
  if (!entry) return;
  entries[chatJid] = { ...entry, noticeAt: new Date(nowMs).toISOString() };
  writeAll(store, entries);
}

/**
 * Чаты, у которых истёк таймер стопа: им положена одна попытка. Отметка
 * tryAllowed и новый отсчёт пишутся сразу, чтобы цикл не будил чат на
 * каждом проходе.
 */
export function dueFastFailParks(
  store: FastFailStore,
  input: { nowMs: number; isActive: (chatJid: string) => boolean },
): string[] {
  const entries = readAll(store);
  const due: string[] = [];
  for (const [chatJid, entry] of Object.entries(entries)) {
    if (!entry.parkedAt || entry.tryAllowed) continue;
    if (input.isActive(chatJid)) continue;
    const parkedAt = Date.parse(entry.parkedAt);
    if (
      Number.isFinite(parkedAt) &&
      input.nowMs - parkedAt < fastFailParkDelayMs(entry.timerRounds)
    ) {
      continue;
    }
    entries[chatJid] = {
      ...entry,
      parkedAt: new Date(input.nowMs).toISOString(),
      tryAllowed: true,
    };
    due.push(chatJid);
  }
  if (due.length > 0) writeAll(store, entries);
  return due;
}

/** Есть ли вообще записи (дешёвая проверка для цикла). */
export function hasFastFailEntries(store: FastFailStore): boolean {
  const raw = store.get(STORE_KEY);
  return Boolean(raw && raw !== '{}');
}

/**
 * Честное сообщение при остановке. Если есть неотправленный черновик итога
 * (только чат владельца), он идёт ниже с пометкой, что не проверен с учётом
 * последних сообщений.
 */
export function fastFailParkedNoticeText(
  draft?: string | null,
  nextTimerDelayMs: number = FAST_FAIL_PARK_MS,
): string {
  return (
    `Не могу запустить модель: несколько попыток подряд сорвались сразу, ещё до начала работы. Повторы остановил, твои сообщения сохранены. Попробую снова, когда напишешь, или сам ${parkDelayWords(nextTimerDelayMs)}.` +
    unsentDraftNoticeTail(draft)
  );
}

/**
 * Когда будет следующая попытка по таймеру — словами, по настоящей паузе:
 * повторное сведение серии приходит, когда таймер уже ушёл на часы, и
 * «через 30 минут» там было бы неправдой (перепроверка r1108).
 */
function parkDelayWords(delayMs: number): string {
  const minutes = Number.isFinite(delayMs) ? delayMs / 60_000 : 30;
  if (minutes <= 30) return 'через 30 минут';
  if (minutes <= 60) return 'через час';
  if (minutes <= 120) return 'через пару часов';
  return 'через несколько часов';
}

/**
 * Хвост служебного сообщения об окончательной остановке: неотправленный
 * черновик итога с пометкой, что он не проверен (W05). Пусто без черновика.
 */
export function unsentDraftNoticeTail(draft?: string | null): string {
  const text = draft ? collapseDraft(draft) : '';
  return text
    ? `\n\nНиже неотправленный черновик ответа. Он не проверен с учётом твоих последних сообщений:\n\n${text}`
    : '';
}

const DRAFT_MAX_CHARS = 3_000;

function collapseDraft(draft: string): string {
  const trimmed = draft.replace(/\r\n?/g, '\n').trim();
  if (trimmed.length <= DRAFT_MAX_CHARS) return trimmed;
  const cut = trimmed.slice(0, DRAFT_MAX_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > DRAFT_MAX_CHARS * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
