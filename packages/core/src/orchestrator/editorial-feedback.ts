import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';

const fragment = z.string().min(1).max(2000);
export const editorialFeedbackDetailSchema = z
  .object({
    kind: z.literal('editorial_feedback'),
    artifact: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('assistant_message'),
          messageId: z.string().min(1).max(256),
          contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
          fragment: fragment.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('reported_reference'),
          reference: z.string().min(1).max(1000),
          version: z.string().min(1).max(200),
          fragment: fragment.optional(),
        })
        .strict(),
    ]),
    criterionQuote: z.string().min(1).max(1000).optional(),
    interpretation: z.string().min(1).max(1000).optional(),
  })
  .strict();
export type EditorialFeedbackDetailInput = z.infer<
  typeof editorialFeedbackDetailSchema
>;
export interface EditorialArtifactEvidence {
  messageId: string;
  contentSha256: string;
  fragment?: string;
}
export type EditorialFeedbackDetail = EditorialFeedbackDetailInput & {
  artifactVerification: 'host_checked_message' | 'reported_not_verified';
  associationTrust: 'agent_interpreted';
};
/** This checks source bytes within the authenticated chat, not taste or whether
 * the feedback semantically refers to this artifact. The latter remains interpreted.
 */
export function verifyEditorialMessageArtifact(
  db: Database.Database,
  chatJid: string,
  artifact: Extract<
    EditorialFeedbackDetailInput['artifact'],
    { kind: 'assistant_message' }
  >,
): EditorialArtifactEvidence | undefined {
  const row = db
    .prepare(
      'SELECT content,is_bot_message FROM messages WHERE chat_jid=? AND id=?',
    )
    .get(chatJid, artifact.messageId) as
    | { content: string; is_bot_message: number }
    | undefined;
  if (
    !row ||
    row.is_bot_message !== 1 ||
    typeof row.content !== 'string' ||
    Buffer.byteLength(row.content) > 1024 * 1024
  )
    return;
  const digest = createHash('sha256').update(row.content).digest('hex');
  if (
    digest !== artifact.contentSha256 ||
    (artifact.fragment !== undefined &&
      !row.content.includes(artifact.fragment))
  )
    return;
  return {
    messageId: artifact.messageId,
    contentSha256: digest,
    ...(artifact.fragment !== undefined ? { fragment: artifact.fragment } : {}),
  };
}
function genericPraise(text: string): boolean {
  return /^(?:спасибо|хорошо|отлично|прекрасно|супер|класс|нравится|мне нравится|good|great|nice|thanks|love it|looks good)[.!\s]*$/iu.test(
    text.trim(),
  );
}
export function parseEditorialFeedbackDetail(
  input: unknown,
  source: {
    kind: 'direct_user' | 'assistant_report';
    quote?: string;
    editorialArtifactEvidence?: EditorialArtifactEvidence;
  },
): EditorialFeedbackDetail | undefined {
  const parsed = editorialFeedbackDetailSchema.safeParse(input);
  if (!parsed.success || source.kind !== 'direct_user' || !source.quote) return;
  const value = parsed.data;
  if (
    value.criterionQuote &&
    (!source.quote.includes(value.criterionQuote) ||
      genericPraise(source.quote) ||
      genericPraise(value.criterionQuote))
  )
    return;
  if (value.artifact.kind === 'assistant_message') {
    const proof = source.editorialArtifactEvidence;
    if (
      !proof ||
      proof.messageId !== value.artifact.messageId ||
      proof.contentSha256 !== value.artifact.contentSha256 ||
      proof.fragment !== value.artifact.fragment
    )
      return;
  }
  return {
    ...value,
    artifactVerification:
      value.artifact.kind === 'assistant_message'
        ? 'host_checked_message'
        : 'reported_not_verified',
    associationTrust: 'agent_interpreted',
  };
}
/** Only literal feedback is automatically recalled. A tentative interpretation
 * remains available in the full record and never becomes a standing preference.
 */
export function editorialFeedbackContext(
  detail: EditorialFeedbackDetail,
  feedbackQuote: string | undefined,
): object {
  const clip = (value: string | undefined, max: number) =>
    value === undefined
      ? null
      : value.length <= max
        ? value
        : { excerpt: value.slice(0, max), readFullRecord: true };
  const artifact =
    detail.artifact.kind === 'assistant_message'
      ? { ...detail.artifact, fragment: clip(detail.artifact.fragment, 300) }
      : {
          ...detail.artifact,
          reference: clip(detail.artifact.reference, 300),
          version: clip(detail.artifact.version, 100),
          fragment: clip(detail.artifact.fragment, 300),
        };
  return {
    artifact,
    artifactVerification: detail.artifactVerification,
    associationTrust: detail.associationTrust,
    feedbackQuote: clip(feedbackQuote, 500),
    criterionQuote: clip(detail.criterionQuote, 300),
    rule: 'This is exact project feedback on the cited version, not a global preference. A quotation is not automatically a prescriptive rule. Do not infer tastes from praise. Apply a criterion only when relevant to the current authorized task; current corrections override it.',
  };
}
