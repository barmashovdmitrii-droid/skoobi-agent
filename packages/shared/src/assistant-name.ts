export const DEFAULT_ASSISTANT_NAME = 'Skoobi';

const ASSISTANT_NAME_PATTERN = /^[\p{L}\p{N}_-]+$/u;
const ASSISTANT_NAME_MAX_CODE_POINTS = 64;
const ASSISTANT_ADDRESS_START_BOUNDARY = String.raw`(?<![\p{L}\p{M}\p{N}_@-])`;
const ASSISTANT_ADDRESS_END_BOUNDARY = String.raw`(?![\p{L}\p{M}\p{N}_-])`;

/**
 * Turn the trusted assistant display/trigger name into one portable value.
 *
 * Configuration is normalized before it reaches logs, prompts, or regular
 * expressions. Invalid values fail closed to the public default.
 */
export function normalizeAssistantName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_ASSISTANT_NAME;

  const normalized = value.normalize('NFC').trim();
  const length = Array.from(normalized).length;
  if (
    length < 1 ||
    length > ASSISTANT_NAME_MAX_CODE_POINTS ||
    !ASSISTANT_NAME_PATTERN.test(normalized)
  ) {
    return DEFAULT_ASSISTANT_NAME;
  }

  return normalized;
}

export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Match a configured assistant address only at the start of a message.
 *
 * The explicit Unicode-aware lookahead avoids the ASCII-only semantics of
 * `\b`, which otherwise accepts prefixes such as `@Бот` in `@Ботик`.
 */
export function createAssistantTriggerPattern(value: unknown): RegExp {
  const assistantName = escapeRegexLiteral(normalizeAssistantName(value));
  return new RegExp(
    `^@${assistantName}${ASSISTANT_ADDRESS_END_BOUNDARY}`,
    'iu',
  );
}

/** Match configured assistant addresses anywhere in trusted command text. */
export function createAssistantMentionPattern(value: unknown): RegExp {
  const assistantName = escapeRegexLiteral(normalizeAssistantName(value));
  return new RegExp(
    `${ASSISTANT_ADDRESS_START_BOUNDARY}@${assistantName}${ASSISTANT_ADDRESS_END_BOUNDARY}`,
    'giu',
  );
}
