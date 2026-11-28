/**
 * W03 (разбор недели): готовый ответ не держится дольше 90 секунд и не
 * теряется.
 *
 * Готовый ответ, к которому во время хода пришли новые
 * сообщения, придерживается, а модель продолжает работу уже с ними (C12, один
 * ответ вместо двух). Обычно продолжение укладывается в минуту, но однажды
 * готовый итог трижды уходил в продолжение и человек ждал ~20 минут, а
 * в другой раз продолжение сразу прервалось, и черновик не дошёл вовсе.
 *
 * Здесь хост, получив от раннера кадр «готовый ответ удержан» вместе с
 * черновиком:
 * - через 90 с (если продолжение ещё не ответило) отправляет черновик с
 *   пометкой, что новые сообщения учтутся следующим ответом; 90 с считаются
 *   от первого удержания: вторая доработка срок не продлевает;
 * - если продолжение сорвалось (ошибка, прерывание, лимит, пустой итог) —
 *   отправляет черновик сразу, один раз;
 * - после «стоп» не отправляет ничего;
 * - если продолжение ответило инструментом send_message и закончилось
 *   пустым итогом, старый черновик не отправляет;
 * - когда финал проходит проверку ссылок (#10), черновик уходит по таймеру
 *   без строк со ссылками на сайты и с пометкой, что ссылки придут с
 *   проверенным итогом (L1; раньше он ждал итог целиком); если итога так и
 *   не будет (сбой или пустой итог продолжения), придержанные ссылки уходят
 *   один раз с пометкой, что они не проверены, — обещание не повисает;
 * - итог, пришедший после выпуска по таймеру, не повторяет черновик (L2);
 * - короткое «Готовый ответ пока удержан» шлёт, только когда черновик
 *   отправить нельзя (только вопрос, картинка, ссылки на файлы) и удержание
 *   длится больше минуты.
 *
 * Вопрос в конце черновика при этом убирается: на него, скорее всего, уже
 * ответили новыми сообщениями (человек уже выбрал вариант, а через
 * пять минут черновик спросил, какой из двух выбрать). Черновик из одного
 * вопроса не отправляется вовсе.
 */

import { stripInternalTags } from './router.js';

/** Default: release the held draft after this long without a final answer. */
export const HELD_DRAFT_RELEASE_AFTER_MS = 90_000;
/** The «пока удержан» notice only for a hold longer than this. */
export const HELD_DRAFT_NOTICE_AFTER_MS = 60_000;
/** Same bound as the runner's continuation draft. */
export const HELD_DRAFT_MAX_CHARS = 24_000;
/** What is left of a draft after its stale question must still say something. */
const RELEASABLE_MIN_CHARS = 80;

export type HeldDraftReleaseReason =
  | 'hold-timeout'
  | 'continuation-failed'
  | 'continuation-empty';

export const HELD_DRAFT_TIMEOUT_PREFIX =
  'Ответ готов, но собран до твоих последних сообщений — их учту следующим сообщением.';
export const HELD_DRAFT_FAILURE_PREFIX =
  'Продолжение с учётом твоих последних сообщений прервалось. Вот ответ, собранный до них (их ещё не учёл):';
/** A timed draft goes without its unchecked web links; they come later (L1). */
export const HELD_DRAFT_LINKS_LATER_NOTE =
  'Ссылки пришлю в итоговом ответе — после проверки.';
/**
 * The links held back from a timed draft, when the checked final never comes
 * (the continuation failed or ended empty): sent once, marked as unchecked.
 */
export const HELD_DRAFT_LINKS_FAILURE_PREFIX =
  'Продолжение с учётом твоих последних сообщений прервалось, проверенного итога не будет. Ссылки из ответа выше — я не успел их проверить:';
export const HELD_DRAFT_NOTICE_TEXT =
  'Готовый ответ пока удержан: во время работы пришли новые сообщения. Сделанное сохранено; проверяю новые условия перед отправкой результата.';

const WEB_LINK = /\bhttps?:\/\//iu;

/**
 * The lines of a draft a timed release leaves out (releasableHeldDraft with
 * allowWebLinks false): its web links. Undefined when there are none.
 */
export function heldBackWebLinkLines(text: string | null | undefined): string | undefined {
  if (typeof text !== 'string') return undefined;
  const lines = text
    .trim()
    .split('\n')
    .filter((line) => WEB_LINK.test(line))
    .map((line) => line.trim());
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** A line that is a question to the person: «…?» with trailing markup. */
function isQuestionLine(line: string): boolean {
  return /[?？]\s*[*_)»"'`\]]*\s*$/u.test(line);
}

/**
 * The part of a held draft that may go out before the new messages are
 * considered; null — nothing safe to send. Trailing questions (and the line
 * that introduces them, «Уточни:») are cut: the new messages may already
 * answer them. A draft with service markers or links to files on this Mac is
 * left to the final answer, which handles both.
 */
export function releasableHeldDraft(
  text: string | null | undefined,
  options: {
    /**
     * false — the draft's web links are not checked (the final's are, #10):
     * the lines with them stay for the final, the rest goes with a note that
     * the links follow (L1: until then the whole draft waited for the final,
     * however long that took). A draft with little else waits as before.
     */
    allowWebLinks?: boolean;
  } = {},
): { text: string; questionRemoved: boolean } | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > HELD_DRAFT_MAX_CHARS) return null;
  if (/\[Служебная пометка|без_изменений|<unsent_answer_draft>/iu.test(trimmed)) {
    return null;
  }
  // Local file links are rewritten (and the files sent) only for a final.
  if (/\]\(\s*(?:\/|~\/|file:)/u.test(trimmed)) return null;
  const linksHeldBack = options.allowWebLinks === false && WEB_LINK.test(trimmed);
  const lines = (linksHeldBack
    ? trimmed.split('\n').filter((line) => !WEB_LINK.test(line))
    : trimmed.split('\n'));
  let removed = false;
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (!last) {
      lines.pop();
      continue;
    }
    if (isQuestionLine(last)) {
      lines.pop();
      removed = true;
      continue;
    }
    // «Уточни пару моментов:» / «Варианты:» left without the questions.
    if (removed && /[:：]\s*[*_]*\s*$/u.test(last)) {
      lines.pop();
      continue;
    }
    // «Подробности:» left without the links that followed it.
    if (linksHeldBack && /[:：]\s*[*_]*\s*$/u.test(last)) {
      lines.pop();
      continue;
    }
    // A list item of the trailing question block («1. Бюджет — 5 или 10?»).
    break;
  }
  const rest = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!rest) return null;
  if ((removed || linksHeldBack) && rest.length < RELEASABLE_MIN_CHARS) return null;
  return {
    text: linksHeldBack ? `${rest}\n\n${HELD_DRAFT_LINKS_LATER_NOTE}` : rest,
    questionRemoved: removed,
  };
}

export function heldDraftReleaseText(
  draft: string,
  reason: HeldDraftReleaseReason,
): string {
  const prefix =
    reason === 'hold-timeout'
      ? HELD_DRAFT_TIMEOUT_PREFIX
      : HELD_DRAFT_FAILURE_PREFIX;
  return `${prefix}\n\n${draft}`;
}

/**
 * L2: the final that follows a draft released on the timer. The continuation
 * did not know the draft had gone out (the runner keeps it as unsent), so its
 * final often repeated it almost word for word (ПЕРЕДАЧА, W03).
 */
export const HELD_DRAFT_FINAL_SAME_TEXT =
  'Учёл твои последние сообщения — ответ выше остаётся в силе.';
export const HELD_DRAFT_FINAL_ADDENDUM_PREFIX =
  'Учёл твои последние сообщения. К ответу выше — изменения и дополнения:';
/**
 * Review r1111 (turn-1): the final dropped lines of the draft above — the
 * correction narrowed it («без варианта 3»). It goes whole: «в силе» or an
 * addendum would leave the dropped lines standing.
 */
export const HELD_DRAFT_FINAL_REVISED_PREFIX =
  'Учёл твои последние сообщения — исправленный ответ:';
/** Share of the final's text found in the draft above which it is trimmed. */
const FINAL_REPEAT_SHARE = 0.6;
/** A line this short says nothing on its own («Итог:», «—»). */
const FINAL_NEUTRAL_LINE_CHARS = 4;
/** A longer line counts as repeated when the draft contains it anywhere. */
const FINAL_CONTAINED_LINE_MIN_CHARS = 40;

function normalizedLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/[*_`>#~]/g, '')
    .replace(/^\s*(?:[-•–]|\d+[.)])\s+/u, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s.,;:!?…—-]+$/u, '')
    .trim();
}

/**
 * The final without what the timed draft already said. Line by line: lines
 * of the draft (punctuation, list marks and markup aside) are dropped when
 * they make most of the final; a final that only repeats becomes one line,
 * one with something new keeps only the new lines. A final that is mostly new
 * goes as it is.
 *
 * Compared by what the person will see: <internal> notes never reach the
 * chat (formatOutbound strips them), so «<internal>учёл поправку</internal>»
 * is not something new — kept, it left an empty «изменения и дополнения:».
 */
export function trimRepeatOfReleasedDraft(
  finalText: string,
  releasedDraft: string,
): { text: string; trimmed: boolean } {
  const draftLines = new Set(
    releasedDraft.split('\n').map(normalizedLine).filter(Boolean),
  );
  const draftWhole = normalizedLine(releasedDraft.replace(/\n+/g, ' '));
  if (draftLines.size === 0) return { text: finalText, trimmed: false };
  const visible = stripInternalTags(finalText);
  let total = 0;
  let repeated = 0;
  const kept: string[] = [];
  for (const line of visible.split('\n')) {
    const norm = normalizedLine(line);
    if (norm.length < FINAL_NEUTRAL_LINE_CHARS) {
      kept.push(line);
      continue;
    }
    total += norm.length;
    const seen =
      draftLines.has(norm) ||
      (norm.length >= FINAL_CONTAINED_LINE_MIN_CHARS && draftWhole.includes(norm));
    if (seen) {
      repeated += norm.length;
      // A blank line after a dropped one would pile up.
      continue;
    }
    kept.push(line);
  }
  if (total === 0 || repeated / total < FINAL_REPEAT_SHARE) {
    return { text: finalText, trimmed: false };
  }
  // Every line of the shown draft must still be in the final: a missing line
  // is what the correction removed (one item of eleven is enough).
  const finalLines = new Set(visible.split('\n').map(normalizedLine).filter(Boolean));
  const finalWhole = normalizedLine(visible.replace(/\n+/g, ' '));
  const linksNote = normalizedLine(HELD_DRAFT_LINKS_LATER_NOTE);
  const dropped = [...draftLines].some((line) =>
    line.length >= FINAL_NEUTRAL_LINE_CHARS &&
    line !== linksNote &&
    !finalLines.has(line) &&
    !(line.length >= FINAL_CONTAINED_LINE_MIN_CHARS && finalWhole.includes(line)));
  if (dropped) {
    return { text: `${HELD_DRAFT_FINAL_REVISED_PREFIX}\n\n${finalText}`, trimmed: true };
  }
  const rest = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (normalizedLine(rest).length < FINAL_NEUTRAL_LINE_CHARS) {
    return { text: HELD_DRAFT_FINAL_SAME_TEXT, trimmed: true };
  }
  return { text: `${HELD_DRAFT_FINAL_ADDENDUM_PREFIX}\n\n${rest}`, trimmed: true };
}

/** Review r1111 (turn-4): what the final says when the links promised above
 * did not come in it. Dead links: said plainly; otherwise — just that. */
export const HELD_DRAFT_LINKS_DEAD_NOTE =
  'Ссылки, которые обещал выше, не присылаю: они не открылись, а рабочей замены не нашлось.';
export const HELD_DRAFT_LINKS_DROPPED_NOTE =
  'Ссылки, которые обещал выше, в итоговый ответ не вошли.';
/** A heading line left without what it introduced («Ссылки:»). */
const BARE_HEADING_MAX_CHARS = 40;

/**
 * Review r1111 (turn-4): a timed draft promised «Ссылки пришлю в итоговом
 * ответе», and the final has none (the link check removed the dead ones).
 * The promise is withdrawn in plain words instead of hanging; a final that
 * brought links is left alone.
 */
export function withdrawOwedLinksPromise(
  finalText: string,
  options: { linksWereDead: boolean },
): string {
  if (WEB_LINK.test(finalText)) return finalText;
  const lines = finalText.trimEnd().split('\n');
  while (lines.length > 1) {
    const last = lines[lines.length - 1].trim();
    if (!last || (last.length <= BARE_HEADING_MAX_CHARS && /[:：]\s*[*_]*\s*$/u.test(last))) {
      lines.pop();
      continue;
    }
    break;
  }
  let text = lines.join('\n').trimEnd();
  if (text === HELD_DRAFT_FINAL_ADDENDUM_PREFIX || !text) text = HELD_DRAFT_FINAL_SAME_TEXT;
  const note = options.linksWereDead ? HELD_DRAFT_LINKS_DEAD_NOTE : HELD_DRAFT_LINKS_DROPPED_NOTE;
  return `${text}\n\n${note}`;
}

/** The runner's checkpoint frame, validated: only what the host may use. */
export interface HeldDraftCheckpoint {
  reason:
    | 'correction_pending'
    | 'continuation_budget_exhausted'
    | 'continuation_interrupted';
  draftText?: string;
}

export function parseHeldDraftCheckpoint(
  value: unknown,
): HeldDraftCheckpoint | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.readyDraftHeld !== true) return null;
  if (
    record.reason !== 'correction_pending' &&
    record.reason !== 'continuation_budget_exhausted' &&
    record.reason !== 'continuation_interrupted'
  ) {
    return null;
  }
  const draft =
    typeof record.draftText === 'string' &&
    record.draftText.trim() &&
    record.draftText.length <= HELD_DRAFT_MAX_CHARS
      ? record.draftText
      : undefined;
  return { reason: record.reason, ...(draft ? { draftText: draft } : {}) };
}

export interface HeldDraftDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** «стоп» for this chat: nothing goes out then. */
  cancelled: () => boolean;
  /**
   * Send a released draft; true once it is delivered. `heldDraft` is the
   * draft exactly as the runner handed it over (before the stale question
   * was cut), for bookkeeping that must recognise it later — only once the
   * person has got all of it; null while its web links are still to come
   * (L1: a later stop notice may then still show the draft whole).
   */
  deliverDraft: (
    text: string,
    reason: HeldDraftReleaseReason,
    heldDraft: string | null,
  ) => Promise<boolean>;
  /** Send the short «пока удержан» notice; true once delivered. */
  deliverNotice: (text: string) => Promise<boolean>;
  releaseAfterMs?: number;
  noticeAfterMs?: number;
  /**
   * Confirmed send_message deliveries of this run so far. An empty final
   * after one that came since the hold means the continuation answered by
   * itself: the older draft is not sent.
   */
  ipcDeliveries?: () => number;
  /**
   * The run's final goes through the link check (#10): a draft with web
   * links is not sent on the timer — the checked final follows. On a failure
   * it still goes (there is no final then).
   */
  linkCheckedFinal?: boolean;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * One controller per agent run. Frames arrive serialized (outputChain); the
 * timer fires outside it, so the next frame first waits for a release in
 * flight — a draft never lands after the final that replaced it.
 */
export class HeldDraftRelease {
  private draft: string | undefined;
  /**
   * When the first draft of the current hold was held. A second continuation
   * holding a newer draft does not restart the 90 s: the person has waited
   * since then (unless the earlier draft already went out).
   */
  private heldAt: number | undefined;
  private generation = 0;
  private released = false;
  private noticeSent = false;
  private ipcMark = 0;
  private timer: unknown;
  private inFlight: Promise<void> | null = null;
  private failureRelease = false;
  private disposed = false;
  /** Text of the draft released on the timer in the current hold (L2). */
  private shownOnTimer: string | undefined;
  /** Handed to the final that ended that hold, once (L2). */
  private shownForFinal: string | undefined;
  /**
   * The web-link lines the timed release left for the checked final (L1).
   * Owed to the person if that final never comes: sent once on a failure or
   * an empty final.
   */
  private linksOwed: string | undefined;
  /** The final that ended a hold whose timed draft owed links (turn-4). */
  private linksPromisedForFinal = false;

  constructor(private readonly deps: HeldDraftDeps) {}

  /** A draft was delivered because the continuation failed (or was empty). */
  get releasedOnFailure(): boolean {
    return this.failureRelease;
  }

  /**
   * The draft text the person already got on the timer, for the final that
   * just arrived (trimRepeatOfReleasedDraft). Once; undefined when the hold
   * ended without a timed release.
   */
  takeShownDraftForFinal(): string | undefined {
    const shown = this.shownForFinal;
    this.shownForFinal = undefined;
    return shown;
  }

  /**
   * True once for the final that just arrived when the draft released on the
   * timer promised its links «в итоговом ответе» (withdrawOwedLinksPromise).
   */
  takeLinksPromisedForFinal(): boolean {
    const promised = this.linksPromisedForFinal;
    this.linksPromisedForFinal = false;
    return promised;
  }

  onCheckpoint(value: unknown): void {
    if (this.disposed) return;
    const checkpoint = parseHeldDraftCheckpoint(value);
    if (!checkpoint) return;
    if (checkpoint.reason !== 'correction_pending') {
      // The continuation is stopping: keep (or learn) the draft for the
      // failure frame that follows; no timer any more.
      if (checkpoint.draftText && !this.released) {
        this.draft = checkpoint.draftText;
        if (this.heldAt === undefined) this.heldAt = this.deps.now();
      }
      this.cancelTimer();
      return;
    }
    // A new draft is held (a second continuation holds a newer one).
    this.cancelTimer();
    this.generation += 1;
    const now = this.deps.now();
    if (this.heldAt === undefined || this.released) {
      this.heldAt = now;
      this.noticeSent = false;
    }
    this.draft = checkpoint.draftText;
    this.released = false;
    this.ipcMark = this.deps.ipcDeliveries?.() ?? 0;
    const generation = this.generation;
    const waited = Math.max(0, now - this.heldAt);
    if (this.draft && releasableHeldDraft(this.draft, this.timedReleaseOptions())) {
      this.timer = this.deps.setTimer(() => {
        this.timer = undefined;
        if (generation !== this.generation) return;
        this.inFlight = this.release('hold-timeout').finally(() => {
          this.inFlight = null;
        });
      }, Math.max(0, (this.deps.releaseAfterMs ?? HELD_DRAFT_RELEASE_AFTER_MS) - waited));
    } else if (!this.noticeSent) {
      this.timer = this.deps.setTimer(() => {
        this.timer = undefined;
        if (generation !== this.generation || this.released) return;
        if (this.deps.cancelled()) return;
        this.noticeSent = true;
        this.inFlight = this.deps
          .deliverNotice(HELD_DRAFT_NOTICE_TEXT)
          .then(
            () => undefined,
            () => undefined,
          )
          .finally(() => {
            this.inFlight = null;
          });
      }, Math.max(0, (this.deps.noticeAfterMs ?? HELD_DRAFT_NOTICE_AFTER_MS) - waited));
    }
  }

  private timedReleaseOptions(): { allowWebLinks: boolean } {
    return { allowWebLinks: this.deps.linkCheckedFinal !== true };
  }

  /**
   * Before the next terminal frame of the run is handled. A success with text
   * is the continuation's answer: the held draft is done. A failure or an
   * empty success releases the draft now (once), unless «стоп» came.
   */
  async beforeOutput(frame: {
    status: 'success' | 'error';
    hasText: boolean;
    /** The frame retires the held batch (runner finalizedInputFiles). */
    closesHeldBatch: boolean;
  }): Promise<void> {
    if (this.inFlight) await this.inFlight;
    if (this.disposed) return;
    if (frame.status === 'success' && frame.hasText) {
      // The answer is here: the held draft and the «пока удержан» timer are
      // done (a hold without a sendable draft has the timer too).
      this.cancelTimer();
      this.shownForFinal = this.shownOnTimer;
      // Read before forget() clears linksOwed (turn-4).
      this.linksPromisedForFinal = this.shownOnTimer !== undefined && this.linksOwed !== undefined;
      this.forget();
      return;
    }
    // A text-less success that does not close the held batch is not the
    // continuation's end: keep holding.
    if (frame.status === 'success' && !frame.closesHeldBatch) return;
    this.cancelTimer();
    if (this.draft === undefined) {
      this.forget();
      return;
    }
    if (
      frame.status === 'success' &&
      (this.deps.ipcDeliveries?.() ?? 0) > this.ipcMark
    ) {
      // An empty final after a send_message of the continuation: it has
      // answered by itself, the older draft would only contradict it.
      this.deps.log?.('Held draft dropped: the continuation answered by send_message', {
        heldMs: Math.max(0, this.deps.now() - (this.heldAt ?? this.deps.now())),
      });
      this.forget();
      return;
    }
    const reason: HeldDraftReleaseReason =
      frame.status === 'success' ? 'continuation-empty' : 'continuation-failed';
    await this.release(reason);
    this.forget();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private forget(): void {
    this.shownOnTimer = undefined;
    this.linksOwed = undefined;
    this.draft = undefined;
    this.heldAt = undefined;
    this.released = false;
    this.noticeSent = false;
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      this.deps.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private async release(reason: HeldDraftReleaseReason): Promise<void> {
    if (this.disposed || this.deps.cancelled()) return;
    const fullySent = !this.released && (await this.releaseDraft(reason));
    // L1: the timed release promised the links «в итоговом ответе»; with no
    // final coming they go now, once, marked as unchecked (a draft released
    // whole just now carries its own links).
    if (reason !== 'hold-timeout' && !fullySent) await this.releaseOwedLinks(reason);
  }

  /** true when the person now has the whole draft (links included). */
  private async releaseDraft(reason: HeldDraftReleaseReason): Promise<boolean> {
    const options: { allowWebLinks?: boolean } =
      reason === 'hold-timeout' ? this.timedReleaseOptions() : {};
    const releasable = releasableHeldDraft(this.draft, options);
    if (!releasable) return false;
    const heldBackLinks =
      options.allowWebLinks === false ? heldBackWebLinkLines(this.draft) : undefined;
    // Marked before the send: a timer and a failure frame never both send it.
    this.released = true;
    const heldMs = Math.max(0, this.deps.now() - (this.heldAt ?? this.deps.now()));
    let delivered = false;
    try {
      delivered = await this.deps.deliverDraft(
        heldDraftReleaseText(releasable.text, reason),
        reason,
        heldBackLinks ? null : (this.draft ?? releasable.text),
      );
    } catch {
      delivered = false;
    }
    // Not delivered: a failure frame later may still try once more.
    if (!delivered) this.released = false;
    if (delivered && reason !== 'hold-timeout') this.failureRelease = true;
    if (delivered && reason === 'hold-timeout') this.shownOnTimer = releasable.text;
    // A newer draft released supersedes the links an older one left owed.
    if (delivered) this.linksOwed = heldBackLinks;
    this.deps.log?.(
      delivered ? 'Held draft released' : 'Held draft release not delivered',
      {
        reason,
        heldMs,
        chars: releasable.text.length,
        questionRemoved: releasable.questionRemoved,
        ...(heldBackLinks ? { linksHeldBack: true } : {}),
      },
    );
    return delivered && !heldBackLinks;
  }

  private async releaseOwedLinks(reason: HeldDraftReleaseReason): Promise<void> {
    const links = this.linksOwed;
    if (!links) return;
    // Once, delivered or not: an undelivered one leaves the stop notice to
    // show the draft whole (its bookkeeping mark was never set).
    this.linksOwed = undefined;
    let delivered = false;
    try {
      delivered = await this.deps.deliverDraft(
        `${HELD_DRAFT_LINKS_FAILURE_PREFIX}\n\n${links}`,
        reason,
        this.draft ?? null,
      );
    } catch {
      delivered = false;
    }
    if (delivered) this.failureRelease = true;
    this.deps.log?.(
      delivered ? 'Held-back links released' : 'Held-back links not delivered',
      { reason, chars: links.length },
    );
  }
}
