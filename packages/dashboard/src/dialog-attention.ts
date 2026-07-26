const ATTENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type DialogAttention = {
  needsReply: boolean;
  attentionReason: string;
};

const QUESTION_RE =
  /(?:\?|(?:^|[^\p{L}\p{N}_])(?:когда|где|как|что|кто|почему|зачем|сколько|можешь|сможешь|подскаж(?:и|ите)|ответь|ответьте|нужно\s+ли)(?=$|[^\p{L}\p{N}_]))/iu;
const DATE_RE =
  /(?:(?:^|[^\p{L}\p{N}_])\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?(?=$|[^\p{L}\p{N}_])|(?:^|[^\p{L}\p{N}_])(?:сегодня|завтра|послезавтра|понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресень[ея]|до\s+\d{1,2}(?::\d{2})?)(?=$|[^\p{L}\p{N}_]))/iu;
const ACTION_RE =
  /(?:^|[^\p{L}\p{N}_])(?:договорились|согласовано|подтверждаю|жду|нужно|надо|отправь|пришли|сделай|проверь|позвони|оплати|подпиши|напомни)(?=$|[^\p{L}\p{N}_])/iu;

/**
 * A deliberately small local heuristic for the «Важное» filter. It does not
 * infer sentiment or call any model: only a recent incoming final message can
 * be marked, and the reason is derived from visible punctuation/words.
 */
export function detectDialogAttention(input: {
  lastMessageAt: string | null;
  outgoing: boolean;
  text: unknown;
  now?: number;
}): DialogAttention {
  if (input.outgoing || !input.lastMessageAt) {
    return { needsReply: false, attentionReason: '' };
  }
  const timestamp = Date.parse(input.lastMessageAt);
  const now = input.now ?? Date.now();
  if (
    !Number.isFinite(timestamp) ||
    timestamp > now + 60_000 ||
    now - timestamp > ATTENTION_WINDOW_MS
  ) {
    return { needsReply: false, attentionReason: '' };
  }

  const text = String(input.text || '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (QUESTION_RE.test(text)) {
    return { needsReply: true, attentionReason: 'Есть вопрос' };
  }
  if (DATE_RE.test(text)) {
    return { needsReply: true, attentionReason: 'Есть дата или срок' };
  }
  if (ACTION_RE.test(text)) {
    return { needsReply: true, attentionReason: 'Нужно действие или ответ' };
  }
  return { needsReply: true, attentionReason: 'Ждёт ответа' };
}
