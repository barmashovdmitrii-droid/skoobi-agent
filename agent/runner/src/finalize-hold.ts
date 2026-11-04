/**
 * Reconcile pending user messages before publishing a final answer.
 *
 * The former three-minute full-tools rewrite could repeat actions, time out,
 * and publish an obsolete question. Meaningful new input now goes directly to
 * the ordinary follow-up turn. Its files remain pending, the unsent draft and
 * observed tool calls are checkpointed, and the old final is withheld. A ping
 * alone can be covered by a real final already ready to send.
 *
 * Legacy acceptance helpers remain for persisted/caller compatibility; the
 * production runFinalizeHold path never starts a separate model rewrite.
 */

import fs from 'fs';
import path from 'path';

import type { CodexTurnResult } from './codex-exec.js';

/** Длиннее — уже новая задача, а не уточнение: её ждать не стоит. */
export const FINALIZE_HOLD_MAX_MESSAGE_CHARS = 300;
/** Меньше этого остатка бюджета хода — доработки нет. */
export const FINALIZE_HOLD_MIN_REMAINING_MS = 120_000;
/** Потолок хода-доработки. */
export const FINALIZE_HOLD_TURN_MAX_MS = 180_000;
/** Запас до конца бюджета хода, который доработка не трогает. */
export const FINALIZE_HOLD_SAFETY_MS = 30_000;
/** Тред почти полон: доработка почти наверняка запустит сжатие контекста. */
export const FINALIZE_HOLD_MAX_CONTEXT_FILL = 0.85;
/**
 * Длинный ответ, ужатый доработкой до огрызка, — скорее дописка («учёл,
 * тогда автомат»), чем итог: пользователь потерял бы сам ответ. Огрызок —
 * короче FINALIZE_HOLD_SHRINK_MAX_CHARS И короче четверти исходного: уточнение
 * сужает вопрос, и полный ответ про один вариант из пяти (23.10: 2582 знака,
 * а следующий ответ по сути — 482) короче четверти, но не огрызок.
 */
export const FINALIZE_HOLD_SHRINK_MIN_ORIGINAL = 600;
export const FINALIZE_HOLD_SHRINK_RATIO = 0.25;
export const FINALIZE_HOLD_SHRINK_MAX_CHARS = 300;
/**
 * Голые «в силе», «ничего не меняет», «без изменений» — ссылка на ответ выше
 * только в коротком ответе; в полном итоге это обычные слова («гарантия
 * остаётся в силе 12 месяцев»).
 */
export const FINALIZE_HOLD_BARE_BACK_REFERENCE_MAX_CHARS = 300;

/** Имя инструмента в пометке файла ipc/input: только такое попадёт в промпт. */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** A bounded draft survives a restart without copying the whole transcript. */
export const FINALIZE_CONTINUATION_MAX_DRAFT_CHARS = 24_000;

function continuationDraft(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  return text.length <= FINALIZE_CONTINUATION_MAX_DRAFT_CHARS
    ? text
    : `${text.slice(0, FINALIZE_CONTINUATION_MAX_DRAFT_CHARS)}\n[Черновик сокращён; перед выводом проверь полный результат в истории и файлах.]`;
}

/**
 * Ответ доработки «ничего не меняется»: уходит исходный финал. Отдельная
 * метка, а не «верни ответ выше как есть» — вместо копии модель писала «ответ
 * выше в силе», и пользователь получал ссылку на ответ, которого не видел.
 */
export const FINALIZE_HOLD_UNCHANGED_MARKER = 'БЕЗ_ИЗМЕНЕНИЙ';

export const FINALIZE_HOLD_NOTE = `[Служебная пометка перед отправкой.] Твой ответ выше ещё НЕ отправлен. Пока ты его писал, пользователь прислал сообщения ниже. Если они что-то меняют — дай один итоговый ответ с их учётом: он уйдёт вместо ответа выше, поэтому напиши его целиком, а не как дополнение, и не ссылайся на ответ выше — пользователь его не увидит. Если они ничего не меняют — ответь одной строкой ${FINALIZE_HOLD_UNCHANGED_MARKER}, и уйдёт ответ выше. Не вызывай send_message и другие инструменты отправки и не упоминай эту пометку.`;

/** Весь ответ — метка (в кавычках, звёздочках, с точкой — тоже). */
const UNCHANGED_ONLY_RE =
  /^[\s*_`"'«»„“”[\]().,:;!—–-]*без[\s_]+изменений[\s*_`"'«»„“”[\]().,:;!—–-]*$/iu;
/** Метка внутри другого текста: модель запуталась, такой ответ не отправить. */
const UNCHANGED_MARKER_RE = /без_изменений/iu;

/**
 * Ответ доработки, который ссылается на неотправленный ответ («ответ выше в
 * силе», «остальное без изменений»): пользователь получил бы ссылку в
 * пустоту. Проверяется, только когда он короче исходного: полный итог сам по
 * себе.
 */
const BACK_REFERENCE_RE =
  /(?:ответ|написанное|сказанное|рекомендаци|совет|вариант|список)\p{L}*\s+выше|(?:писал|сказал|ответил|советовал|перечислил)\p{L}*\s+выше|(?:см\.?|смотри|как)\s+выше|выше\s+(?:[—–-]\s*)?(?:в силе|актуал|оста[её]т|верн)|(?:остальн|прочее)\p{L}*\s+(?:[—–-]\s*)?(?:в силе|без изменений|как было|актуал)/iu;
/** То же голыми словами — только для короткого ответа (см. выше). */
const BARE_BACK_REFERENCE_RE = /в силе|ничего не меня|без изменений/iu;

/**
 * Пометка догоняющему ходу, когда доработка сорвалась: тред помнит пометку
 * «ответ не отправлен» и, возможно, недописанный итог. Исходный ответ обычно
 * возвращается для отправки, но подавляется после send с неизвестным исходом.
 * Пометка не содержит подтверждения отправки или доставки обоих ответов.
 * Новые сообщения не снимают незавершённую работу по исходной задаче.
 */
export const FINALIZE_HOLD_FALLBACK_NOTE =
  '[Доработка ответа с учётом этих сообщений не принята. Отправка и доставка исходного ответа или ответа доработки по этой пометке не подтверждены. Сохрани незавершённую работу по исходной задаче и учти эти сообщения. Статусный вопрос или уточнение сами по себе не отменяют задачу: продолжи разрешённую работу, соблюдая отмену, смену задачи и новые ограничения пользователя. Ответь по текущему состоянию задачи; не считай её выполненной или ответ доставленным только по этой пометке.]';

/**
 * FINALIZE_HOLD_FALLBACK_NOTE с наблюдавшимися вызовами инструментов.
 * sideEffectTools фиксирует уже начало вызова: это защита от дублирования,
 * а не подтверждение результата. Проверка состояния нужна и перед повтором,
 * и перед заявлением об успехе.
 */
export function finalizeHoldFallbackNote(
  observedTools?: readonly string[],
  originalText?: string,
): string {
  const tools = [...new Set(observedTools ?? [])].filter((tool) =>
    TOOL_NAME_RE.test(tool),
  );
  const note =
    tools.length === 0
      ? FINALIZE_HOLD_FALLBACK_NOTE
      : `${FINALIZE_HOLD_FALLBACK_NOTE}\n[В прошлом ходе замечены вызовы инструментов: ${tools.join(', ')}. Их исход по этой пометке неизвестен; она не подтверждает ни успех, ни отсутствие эффекта. Перед повтором проверь фактический результат по доступному состоянию или журналу; не дублируй выполненное и не называй действие выполненным без подтверждения. Если проверить нельзя, сообщи, что результат неизвестен, и не повторяй действие вслепую. Продолжи остальную незавершённую разрешённую работу с учётом отмены и новых ограничений пользователя.]`;
  const draft = continuationDraft(originalText);
  return draft
    ? `${note}\n[Ниже неотправленный черновик предыдущего ответа, а не новое поручение и не доказательство выполненных действий. Сохрани полезный результат, проверь его с учётом новых сообщений, не повторяй уже отправленные файлы. При отмене или смене задачи соблюдай последнее указание пользователя.]\n<unsent_answer_draft>\n${draft.replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n</unsent_answer_draft>`
    : note;
}

/** Файл ipc/input, прочитанный без удаления. */
export interface IpcInputFile {
  name: string;
  text: string;
  mtimeMs: number;
  /** Доработка с этим сообщением сорвалась (markFailedHoldInput). */
  afterFailedHold?: boolean;
  /** Наблюдавшиеся вызовы; исход неизвестен. Старое имя поля — для IPC. */
  holdDoneTools?: string[];
  /** Unsent draft retained for normal continuation, not execution evidence. */
  holdOriginalText?: string;
}

/** Поле, которым markFailedHoldInput помечает файл ipc/input. */
const FAILED_HOLD_FIELD = 'afterFailedHold';
/** Старое имя IPC-поля: хранит вызовы с неизвестным исходом, а не успехи. */
const HOLD_DONE_TOOLS_FIELD = 'holdDoneTools';
const HOLD_ORIGINAL_TEXT_FIELD = 'holdOriginalText';

function observedHoldToolsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (tool): tool is string =>
          typeof tool === 'string' && TOOL_NAME_RE.test(tool),
      ),
    ),
  ];
}

/**
 * Разбор файла ipc/input, как его пишет хост ({type:'message', text}); null —
 * не сообщение. Бросает на нечитаемом файле.
 */
export function readIpcInputFile(
  dir: string,
  name: string,
): IpcInputFile | null {
  const filePath = path.join(dir, name);
  const mtimeMs = fs.statSync(filePath).mtimeMs;
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (data?.type !== 'message' || !data.text) return null;
  const observedTools = observedHoldToolsOf(data[HOLD_DONE_TOOLS_FIELD]);
  const originalText = continuationDraft(data[HOLD_ORIGINAL_TEXT_FIELD]);
  return {
    name,
    text: data.text,
    mtimeMs,
    ...(data[FAILED_HOLD_FIELD] === true ? { afterFailedHold: true } : {}),
    ...(observedTools.length > 0 ? { holdDoneTools: observedTools } : {}),
    ...(originalText ? { holdOriginalText: originalText } : {}),
  };
}

/** Имена файлов-сообщений ipc/input по порядку (имя хоста = время записи). */
export function listIpcInputNames(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

/**
 * Ждущие сообщения, прочитанные БЕЗ удаления: забираются, только когда их
 * взяла принятая доработка или пинг. Нечитаемые оставлены drain-у.
 */
export function peekIpcInputFiles(dir: string): IpcInputFile[] {
  try {
    const out: IpcInputFile[] = [];
    for (const name of listIpcInputNames(dir)) {
      try {
        const file = readIpcInputFile(dir, name);
        if (file) out.push(file);
      } catch {
        /* the drain logs and removes it */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Забрать ровно эти файлы (более новый остаётся следующему ходу). */
export function takeIpcInputFiles(
  dir: string,
  files: readonly IpcInputFile[],
): void {
  for (const file of files) {
    try {
      fs.unlinkSync(path.join(dir, file.name));
    } catch {
      /* already gone */
    }
  }
}

/**
 * Доработка сорвалась: файлы остаются в ipc/input, с пометкой, и тот, кто их
 * заберёт, — догоняющий ход этого запуска или, после _close, начальный drain
 * следующего — скажет модели, что доработка не принята (тред помнит пометку
 * «ответ не отправлен» и, может быть, недописанный итог), и какие вызовы
 * замечены без подтверждения их результата (`observedTools`). Перезапись
 * атомарная (tmp не *.json, rename), mtime прежний:
 * по нему ход отличает «пришло до ответа». Без пометки сообщение всё равно не
 * теряется — только пометки не будет.
 */
export function markFailedHoldInput(
  dir: string,
  files: readonly IpcInputFile[],
  log: (message: string) => void,
  observedTools: readonly string[] = [],
  originalText?: string,
): void {
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    const tmpPath = path.join(dir, `.${file.name}.hold-tmp`);
    try {
      fs.rmSync(tmpPath, { force: true });
      const stat = fs.statSync(filePath);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data?.type !== 'message') continue;
      const known = observedHoldToolsOf(data[HOLD_DONE_TOOLS_FIELD]);
      const tools = observedHoldToolsOf([...known, ...observedTools]);
      const draft =
        continuationDraft(originalText) ??
        continuationDraft(data[HOLD_ORIGINAL_TEXT_FIELD]);
      if (
        data[FAILED_HOLD_FIELD] === true &&
        tools.length === known.length &&
        draft === data[HOLD_ORIGINAL_TEXT_FIELD]
      ) {
        continue;
      }
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({
          ...data,
          [FAILED_HOLD_FIELD]: true,
          ...(tools.length > 0 ? { [HOLD_DONE_TOOLS_FIELD]: tools } : {}),
          ...(draft ? { [HOLD_ORIGINAL_TEXT_FIELD]: draft } : {}),
        }),
        { flag: 'wx' },
      );
      fs.utimesSync(tmpPath, stat.atime, stat.mtime);
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      log(
        `Finalize hold: could not mark ${file.name} (${err instanceof Error ? err.message : String(err)}); it stays for the next turn unmarked`,
      );
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* not created */
      }
    }
  }
}

/**
 * Текст хода из забранных файлов ipc/input. Перед первым сообщением, чья
 * доработка сорвалась, — FINALIZE_HOLD_FALLBACK_NOTE: так их получает
 * следующий запуск после _close (догоняющий ход того же запуска ставит её
 * через followUpContinuationNote).
 */
export function joinIpcInputWithHoldNote(
  files: ReadonlyArray<
    Pick<
      IpcInputFile,
      'text' | 'afterFailedHold' | 'holdDoneTools' | 'holdOriginalText'
    >
  >,
): string {
  const at = files.findIndex((file) => file.afterFailedHold === true);
  const note = finalizeHoldFallbackNote(
    files.flatMap((file) => file.holdDoneTools ?? []),
    files.find((file) => file.holdOriginalText)?.holdOriginalText,
  );
  return files
    .map((file, index) =>
      index === at ? `${note}\n\n${file.text}` : file.text,
    )
    .join('\n');
}

export type FinalizeHoldSkipReason =
  | 'no-text'
  | 'image'
  | 'sent-mid-turn'
  | 'thread'
  | 'long-message'
  | 'attachment'
  | 'budget'
  | 'context-fill';

export type FinalizeHoldPlan =
  | { action: 'skip'; reason: FinalizeHoldSkipReason }
  | { action: 'ping' }
  | { action: 'defer'; reason: 'pending-followup' }
  | { action: 'hold'; timeoutMs: number };

/** Кадр heartbeat для события хоста late_followup_merged. */
export interface FinalizeHoldReport {
  outcome: 'merged' | 'unchanged' | 'ping' | 'failed' | 'skipped';
  reason?: string;
  /** Файлов ipc/input, лежавших к моменту готового финала. */
  newerMessages: number;
  /** Возраст пользовательского хода к этому моменту. */
  turnAgeMs: number;
  /** Сколько шёл ход-доработка. */
  holdMs?: number;
}

const XML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&amp;': '&',
};

function unescapeXml(text: string): string {
  return text.replace(/&(?:lt|gt|quot|apos|#39|amp);/g, (m) => XML_ENTITIES[m]);
}

/**
 * Тексты сообщений пачки: хост заворачивает каждое в <message …>
 * (router.formatMessages) и экранирует. Без обёртки — весь текст одним.
 */
export function pipedMessageBodies(text: string): string[] {
  const bodies = [
    ...text.matchAll(/<message\b[^>]*>([\s\S]*?)<\/message>/g),
  ].map((match) => unescapeXml(match[1]).trim());
  return bodies.length > 0 ? bodies : [text.trim()];
}

/** Голосовое и аудио приходят расшифровкой — это текст, не вложение. */
function unwrapTranscript(body: string): string {
  const match = body.match(/^\[(?:Voice|Audio):\s*([\s\S]*?)\]$/i);
  return (match ? match[1] : body).trim();
}

/**
 * Вложение: фото, видео, документ, стикер, геометка, контакт, голосовое без
 * расшифровки (заглушки канала Telegram).
 */
const ATTACHMENT_RE =
  /\[(?:Photo|Video|Document|Sticker|Location|Contact|Voice|Audio)\b/i;

// Тот же список, что у хоста (message-loop ACTIVE_RUN_PING_PATTERN): раннер
// собирается отдельно и импортировать его не может.
const PING_RE =
  /^(?:ау+|ты тут|ты здесь|ты где|ты живой|живой|ты жив|алл?о|ну|ну как|ну как там|ну что|ну что там|ну ч[её]|и|и что|и как|что там|как там|как успехи|что по задаче|что молчишь|молчишь|что делаешь|работаешь|долго ещ[её]|ещ[её] долго|скоро)$/u;

export function isPingMessage(body: string): boolean {
  const unwrapped = unwrapTranscript(body);
  if (unwrapped.length > 400) return false;
  if (/^[?？]{1,3}$/u.test(unwrapped)) return true;
  const text = unwrapped
    .replace(/@[\p{L}\p{N}_]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[?!.,;:\s]+$/g, '')
    .replace(/^(?:эй|слушай|скуби|skoobi|scubio|бот)[,\s]+/i, '')
    .trim();
  if (!text || text.length > 40) return false;
  return PING_RE.test(text);
}

/**
 * Можно ли и нужно ли придержать готовый финал. `pending` — непустой список
 * файлов ipc/input на момент финала.
 */
export function planFinalizeHold(input: {
  text: string | null | undefined;
  image: boolean;
  sideEffectTools: readonly string[] | undefined;
  threadOk: boolean;
  contextFill: number | null;
  pending: ReadonlyArray<Pick<IpcInputFile, 'text'>>;
  remainingMs: number;
}): FinalizeHoldPlan {
  const bodies = input.pending.flatMap((file) => pipedMessageBodies(file.text));
  // A status ping is covered only by an actual answer ready to leave. Empty
  // output cannot acknowledge a ping; it must reach the normal follow-up.
  if (input.text?.trim() && bodies.length > 0 && bodies.every(isPingMessage)) {
    return { action: 'ping' };
  }
  // Do not guess whether a new message is a small correction or a new task.
  // A full-tools "rewrite" used to time out after 3 min and then release the
  // stale question. The normal turn can inspect attachments, act if authorized,
  // respect cancellation, and report a real blocker without a hidden extra run.
  return { action: 'defer', reason: 'pending-followup' };
}

export function buildFinalizeHoldPrompt(texts: readonly string[]): string {
  return [FINALIZE_HOLD_NOTE, '', ...texts].join('\n');
}

/**
 * Итог доработки принимается, если это успешный ход на том же треде с
 * непустым текстом, а не дописка вместо ответа и не ссылка на ответ, которого
 * пользователь не увидит. Метка FINALIZE_HOLD_UNCHANGED_MARKER — «ничего не
 * меняется»: уходит исходный ответ (`unchanged`).
 */
export function acceptFinalizeHoldAnswer(
  original: string,
  hold: CodexTurnResult | undefined,
  threadId: string | undefined,
):
  | { ok: true; text: string; unchanged?: true }
  | { ok: false; reason: string } {
  if (!hold) return { ok: false, reason: 'error' };
  if (hold.status !== 'success') {
    return {
      ok: false,
      reason: hold.interrupted === true ? 'interrupted' : 'error',
    };
  }
  if (!threadId || hold.threadId !== threadId) {
    return { ok: false, reason: 'thread' };
  }
  const text = (hold.text ?? '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  const before = original.trim();
  if (UNCHANGED_ONLY_RE.test(text)) {
    return before
      ? { ok: true, text: original, unchanged: true }
      : { ok: false, reason: 'empty' };
  }
  if (text.includes('[Служебная пометка') || UNCHANGED_MARKER_RE.test(text)) {
    return { ok: false, reason: 'meta' };
  }
  if (
    before.length >= FINALIZE_HOLD_SHRINK_MIN_ORIGINAL &&
    text.length < FINALIZE_HOLD_SHRINK_MAX_CHARS &&
    text.length < before.length * FINALIZE_HOLD_SHRINK_RATIO
  ) {
    return { ok: false, reason: 'too-short' };
  }
  if (
    text.length < before.length &&
    (BACK_REFERENCE_RE.test(text) ||
      (text.length < FINALIZE_HOLD_BARE_BACK_REFERENCE_MAX_CHARS &&
        BARE_BACK_REFERENCE_RE.test(text)))
  ) {
    return { ok: false, reason: 'back-reference' };
  }
  return { ok: true, text: hold.text ?? text };
}

/**
 * Сорвавшийся итог доработки, которая что-то сделала (поставила задачу,
 * отправила фото), всё же отправляется — дописью под исходным ответом: это
 * подтверждение сделанного («напоминание на завтра 10:00 поставил»), а
 * исходный ответ уходит вместе с ним, так что и «ответ выше в силе» больше не
 * ссылка в пустоту. Иначе сообщения повторились бы ходом и действие — вторым
 * разом. null — дописи нет (ход упал, чужой тред, пусто, служебный текст).
 */
export function finalizeHoldAddendum(
  hold: CodexTurnResult | undefined,
  threadId: string | undefined,
  reason: string,
): string | null {
  if (reason !== 'too-short' && reason !== 'back-reference') return null;
  if (!hold || hold.status !== 'success') return null;
  if (!threadId || hold.threadId !== threadId) return null;
  const text = (hold.text ?? '').trim();
  return text ? text : null;
}

export interface FinalizeHoldOutcome {
  /** The stale final is withheld; immediately process the preserved inputs. */
  deferred?: boolean;
  /** Что отправить. */
  text: string | null;
  /** Ход-доработка, если он был: его токены и побочные эффекты — в учёт. */
  holdResult?: CodexTurnResult;
  /** Файлов ipc/input, которые покрывает этот ответ (absorbedFollowUps). */
  absorbed: number;
  /**
   * Доработка сорвалась: эти сообщения НЕ забраны — они в ipc/input, с
   * пометкой, и ответит на них следующий ход (или следующий запуск).
   */
  failed: IpcInputFile[];
  /** Сообщения, которые видела доработка или пинг (их ссылки — из промпта, не из ответа). */
  seen: IpcInputFile[];
  report?: FinalizeHoldReport;
}

export function deferFinalizeHold(
  original: string | null | undefined,
  pending: IpcInputFile[],
  observedTools: readonly string[],
  markPending: (
    files: readonly IpcInputFile[],
    tools: readonly string[],
    originalText?: string,
  ) => void,
  turnAgeMs: number,
): FinalizeHoldOutcome {
  // The files stay on disk until the normal follow-up takes them. A _close,
  // restart or failed spawn therefore cannot acknowledge inputs never handled.
  markPending(pending, observedTools, original ?? undefined);
  return {
    text: null,
    deferred: true,
    absorbed: 0,
    failed: pending,
    seen: pending,
    report: {
      outcome: 'skipped',
      reason: 'pending-followup',
      newerMessages: pending.length,
      turnAgeMs,
    },
  };
}

export async function runFinalizeHold(
  input: {
    result: Pick<
      CodexTurnResult,
      'text' | 'imageArtifacts' | 'imageGenerationCompleted' | 'sideEffectTools'
    >;
    threadId: string | undefined;
    threadOk: boolean;
    contextFill: number | null;
    turnStartedAt: number;
    turnDeadlineAt: number;
  },
  deps: {
    peekPending: () => IpcInputFile[];
    /** Called only for pings already covered by a nonempty final answer. */
    takePending: (files: readonly IpcInputFile[]) => void;
    markFailed: (
      files: readonly IpcInputFile[],
      observedTools: readonly string[],
      originalText?: string,
    ) => void;
    /** Legacy injection retained for callers; no auxiliary model turn is run. */
    runHoldTurn?: (
      prompt: string,
      timeoutMs: number,
    ) => Promise<CodexTurnResult>;
    log: (message: string) => void;
    now?: () => number;
  },
): Promise<FinalizeHoldOutcome> {
  const original = input.result.text;
  const pending = deps.peekPending();
  if (pending.length === 0) {
    return { text: original, absorbed: 0, failed: [], seen: [] };
  }
  const turnAgeMs = Math.max(0, (deps.now ?? Date.now)() - input.turnStartedAt);
  const plan = planFinalizeHold({
    text: original,
    image:
      Boolean(input.result.imageArtifacts?.length) ||
      input.result.imageGenerationCompleted === true,
    sideEffectTools: input.result.sideEffectTools,
    threadOk: input.threadOk,
    contextFill: input.contextFill,
    pending,
    remainingMs: input.turnDeadlineAt - (deps.now ?? Date.now)(),
  });
  if (plan.action === 'ping') {
    deps.takePending(pending);
    return {
      text: original,
      absorbed: pending.length,
      failed: [],
      seen: pending,
      report: { outcome: 'ping', newerMessages: pending.length, turnAgeMs },
    };
  }
  deps.log(
    `Finalize hold: ${pending.length} newer message(s); withholding the stale final and continuing normally`,
  );
  return deferFinalizeHold(
    original,
    pending,
    input.result.sideEffectTools ?? [],
    deps.markFailed,
    turnAgeMs,
  );
}

/**
 * What goes on after the hold: the answer the link check gets (the merged
 * text, not the stale one — the check runs after the hold), the tools and
 * images of both turns, and whether a link correction must not run (a failed
 * hold left its note, maybe a half answer, last in the thread, so «your
 * answer» would be ambiguous — mark only).
 */
export function answerAfterFinalizeHold(
  result: Pick<
    CodexTurnResult,
    | 'text'
    | 'sideEffectTools'
    | 'imageArtifacts'
    | 'imageGenerationCompleted'
    | 'imageGenerationCallIds'
  >,
  hold: FinalizeHoldOutcome | undefined,
): {
  text: string | null;
  sideEffectTools: string[];
  imageArtifacts: NonNullable<CodexTurnResult['imageArtifacts']>;
  imageGenerationCompleted: boolean;
  imageGenerationCallIds: string[];
  linkFixBlockedReason?: 'finalize-hold';
} {
  const extra = hold?.holdResult;
  return {
    text: hold ? hold.text : result.text,
    sideEffectTools: [
      ...new Set([
        ...(result.sideEffectTools ?? []),
        ...(extra?.sideEffectTools ?? []),
      ]),
    ],
    imageArtifacts: [
      ...(result.imageArtifacts ?? []),
      ...(extra?.imageArtifacts ?? []),
    ],
    imageGenerationCompleted:
      result.imageGenerationCompleted === true ||
      extra?.imageGenerationCompleted === true,
    imageGenerationCallIds: [
      ...new Set([
        ...(result.imageGenerationCallIds ?? []),
        ...(extra?.imageGenerationCallIds ?? []),
      ]),
    ],
    ...((hold?.failed.length ?? 0) > 0
      ? { linkFixBlockedReason: 'finalize-hold' as const }
      : {}),
  };
}
