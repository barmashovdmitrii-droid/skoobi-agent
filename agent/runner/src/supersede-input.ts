import type { CodexTurnResult } from './codex-exec.js';

const CONTINUATION_NOTE =
  '[Пока ты думал над предыдущим сообщением, пришли ещё сообщения — это продолжение того же обращения. Ответь на всё вместе одним сообщением.]';
const RESUME_NOTE = '[Продолжай отвечать на предыдущее сообщение.]';

/**
 * A started/resumed thread is not an acknowledgement of its user input.
 * Codex can emit turn.started several seconds before persisting that input.
 * Keep the entire unanswered batch until the attempt positively acknowledges
 * its exact prompt. Only early, non-acting attempts may use this restart path.
 */
export function inputAfterSupersede(input: {
  freshPrompt: string;
  newer: readonly string[];
  threadId: string | undefined;
  result: Pick<
    CodexTurnResult,
    'threadId' | 'inputPersisted' | 'contextCompacted'
  >;
}): { prompt: string; freshPrompt: string; threadHeld: boolean } {
  const freshPrompt = [input.freshPrompt, ...input.newer].join('\n');
  const threadHeld = Boolean(
    input.threadId &&
    input.result.threadId === input.threadId &&
    input.result.inputPersisted === true &&
    !input.result.contextCompacted,
  );
  return {
    freshPrompt,
    threadHeld,
    prompt: threadHeld
      ? input.newer.length > 0
        ? `${CONTINUATION_NOTE}\n\n${input.newer.join('\n')}`
        : RESUME_NOTE
      : freshPrompt,
  };
}
