import { escapeXml } from '@skoobi/shared';
import type { NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

/** Host-written provenance in the existing bot id, without a data migration. */
export function scheduledBotReplyId(
  timestamp: string,
  sequence: number,
): string {
  return `bot-scheduled-${timestamp}-${sequence}`;
}

export function isScheduledHistoryMessage(message: NewMessage): boolean {
  return (
    Boolean(message.is_bot_message) &&
    Boolean(message.is_from_me) &&
    /^bot-scheduled-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-\d+$/.test(
      message.id,
    )
  );
}

function body(message: NewMessage): string {
  return message.content
    .replace(/^\[(?:Voice|Audio):\s*([\s\S]*?)\]$/i, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function isShortContinuation(message: NewMessage): boolean {
  const text = body(message)
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, '')
    .trim();
  return (
    text.length <= 140 &&
    /^(?:(?:да|ну)[, ]+)?(?:делай(?: сам)?(?: или скажи(?: мне)?,? что мне (?:сделать|делать))?|сделай(?: сам)?|продолжай|продолжим|давай|да|поехали|ок(?:ей)?|хорошо|go ahead|continue|yes)(?:,? пожалуйста)?$/u.test(
      text,
    )
  );
}

function sameDirectSender(message: NewMessage, current: NewMessage): boolean {
  const identity = message.sender_identity;
  const owner = current.sender_identity;
  return (
    !message.is_bot_message &&
    !message.is_from_me &&
    message.chat_jid === current.chat_jid &&
    message.sender === current.sender &&
    identity?.telegram_message_origin === 'direct' &&
    owner?.telegram_message_origin === 'direct' &&
    identity.chat_id === owner.chat_id &&
    identity.telegram_user_id === owner.telegram_user_id &&
    identity.identity_id === owner.identity_id
  );
}

/**
 * Supply the direct exchange a terse continuation can refer to. This is
 * evidence, not an inferred unfinished goal or an authorization. Scheduled
 * results remain in the ordinary history, explicitly labelled by the router.
 * Legacy unlabelled bot output stays unknown; it is never called scheduled.
 */
export function prependInteractiveContinuationContext(
  prompt: string,
  recent: readonly NewMessage[],
  current: readonly NewMessage[],
  timezone: string,
  opts: { anonymizeSenderNames?: boolean } = {},
): string {
  const latest = current.at(-1);
  if (
    !latest ||
    !current.every((m) => sameDirectSender(m, latest) && isShortContinuation(m))
  )
    return prompt;
  const before = Date.parse(current[0].timestamp);
  if (!Number.isFinite(before)) return prompt;
  const exchange: NewMessage[] = [];
  let directCount = 0;
  let sawScheduled = false;
  // Only focus when proven background output is present. Without provenance,
  // leave ordinary history to the model rather than guess which task is live.
  for (const message of [...recent].reverse()) {
    const time = Date.parse(message.timestamp);
    if (
      message.chat_jid !== latest.chat_jid ||
      !Number.isFinite(time) ||
      time >= before ||
      before - time > 6 * 60 * 60 * 1000
    )
      break;
    if (isScheduledHistoryMessage(message)) {
      sawScheduled = true;
      continue;
    }
    if (message.is_bot_message && message.is_from_me) {
      exchange.unshift(message);
      continue;
    }
    // A different participant, forwarded/quoted material or missing identity
    // is a boundary; never reach through it to borrow another person's task.
    if (!sameDirectSender(message, latest)) break;
    if (
      directCount === 0 &&
      /(?:^|\s)(?:стоп|отмена|отмени|отменяю|не надо|не нужно|закончили|закрыли|завершено|задача закрыта|вс[её] готово|cancel|stop|completed|finished)(?:\s|[.!?,]|$)/iu.test(
        body(message),
      )
    )
      return prompt;
    exchange.unshift(message);
    directCount++;
    if (directCount >= 3 || !isShortContinuation(message)) break;
  }
  if (!sawScheduled || directCount === 0) return prompt;
  // Preserve the latest proposal/status as well as the user's own wording.
  // Do not call unknown historical bot output an interactive execution result.
  const lines = exchange.slice(-8).map((message) => {
    const role = message.is_bot_message
      ? 'assistant-output-origin-unknown'
      : 'direct-user';
    const name = opts.anonymizeSenderNames
      ? message.is_bot_message
        ? 'Assistant'
        : 'User'
      : message.sender_name;
    return `<message role="${role}" sender="${escapeXml(name)}" time="${escapeXml(formatLocalTime(message.timestamp, timezone))}">${escapeXml(body(message).slice(0, 1800))}</message>`;
  });
  return [
    '<direct_exchange_for_continuation>',
    'The current message is a short continuation. These are the recent direct user words and intervening assistant proposals/status in this same chat. Scheduled output is separately labelled in the full history below and does not by itself change the user’s task. Use the latest applicable proposal, correction or status; this excerpt does not assert that any task is unfinished, reopen a completed/cancelled task, or grant permission. The current explicit instruction always takes priority. If its referent is still ambiguous, resolve that before acting.',
    ...lines,
    '</direct_exchange_for_continuation>',
    '',
    prompt,
  ].join('\n');
}
