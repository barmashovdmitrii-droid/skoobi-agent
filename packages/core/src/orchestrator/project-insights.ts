import { z } from 'zod';
import type { MemoryStateRecord } from './memory-state-store.js';

/** Source-linked project observations, never a ledger or an execution queue. */
export const projectValueDetailSchema = z
  .object({
    kind: z.literal('project_value'),
    category: z.enum([
      'expected_benefit',
      'observed_result',
      'next_check',
      'cost',
      'revenue',
      'profit',
    ]),
    basis: z.enum([
      'expectation',
      'user_reported',
      'agent_reported',
      'unknown',
    ]),
    amount: z
      .object({
        decimal: z
          .string()
          .max(32)
          .regex(/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict()
      .optional(),
    successCriterion: z.string().min(1).max(1000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.amount &&
      (value.basis === 'unknown' ||
        !['cost', 'revenue', 'profit'].includes(value.category))
    )
      context.addIssue({
        code: 'custom',
        message:
          'Amount requires an explicit financial category and known basis',
      });
    if (
      value.category === 'next_check'
        ? !value.successCriterion
        : value.successCriterion !== undefined
    )
      context.addIssue({
        code: 'custom',
        message: 'A next check requires its own success criterion',
      });
    if (
      value.category === 'expected_benefit' &&
      !['expectation', 'unknown'].includes(value.basis)
    )
      context.addIssue({
        code: 'custom',
        message: 'Expected benefit is not a measured result',
      });
    if (value.category === 'observed_result' && value.basis === 'expectation')
      context.addIssue({
        code: 'custom',
        message: 'An expectation is not an observed result',
      });
  });
export type ProjectValueDetail = z.infer<typeof projectValueDetailSchema>;
export function parseProjectValueDetail(
  value: unknown,
  sourceKind: 'direct_user' | 'assistant_report',
): ProjectValueDetail | undefined {
  const parsed = projectValueDetailSchema.safeParse(value);
  if (!parsed.success) return;
  if (parsed.data.basis === 'user_reported' && sourceKind !== 'direct_user')
    return;
  if (
    parsed.data.basis === 'agent_reported' &&
    sourceKind !== 'assistant_report'
  )
    return;
  return parsed.data;
}
type Project = Extract<MemoryStateRecord, { kind: 'project' }>;
type Fact = Extract<MemoryStateRecord, { kind: 'fact' }>;
export function projectValueView(fact: Fact): object | null {
  const detail = fact.detail;
  if (detail?.kind !== 'project_value') return null;
  return {
    key: fact.key,
    revision: fact.revision,
    description: fact.value.slice(0, 600),
    readFullRecord: fact.value.length > 600,
    category: detail.category,
    basis: detail.basis,
    amount: detail.amount ?? null,
    successCriterion: detail.successCriterion ?? null,
    source: {
      kind: fact.source.kind,
      messageId: fact.source.messageId,
      at: fact.source.at,
      sourceReferenceTrust: fact.source.sourceReferenceTrust,
    },
    amountTrust: detail.amount
      ? 'source_linked_statement_not_independently_verified'
      : 'unknown_or_not_applicable',
  };
}
/** The caller supplies only currently accessible records from the exact scope. */
export function compareProjectInsights(
  input: Array<{
    projectKey: string;
    project: Project | null;
    facts: Fact[];
    complete: boolean;
  }>,
) {
  const result = {
    kind: 'project_comparison',
    readOnly: true,
    limitations: [
      'No financial ledger is available. Subscription token counts are not monetary spending.',
      'Costs, revenue and profit are separate statements. No cross-currency totals or inferred profit are calculated.',
      'A verified source quotation does not independently verify an amount or measured outcome.',
      'Suggestions do not activate, cancel, schedule or execute project work.',
    ],
    projects: input.map(({ projectKey, project, facts, complete }) => {
      const values = facts.filter(
        (fact) =>
          fact.projectKey === projectKey &&
          fact.detail?.kind === 'project_value',
      );
      const categories = new Set<string>(
        values.map((fact) =>
          fact.detail?.kind === 'project_value' ? fact.detail.category : '',
        ),
      );
      const next = values.filter(
        (fact) =>
          fact.detail?.kind === 'project_value' &&
          fact.detail.category === 'next_check',
      );
      const missing = [
        'expected_benefit',
        'observed_result',
        'next_check',
        'cost',
      ].filter((category) => !categories.has(category));
      const unknown = [
        ...new Set(
          values.flatMap((fact) =>
            fact.detail?.kind === 'project_value' &&
            fact.detail.basis === 'unknown'
              ? [fact.detail.category]
              : [],
          ),
        ),
      ];
      const hasReportedCost = values.some(
        (fact) =>
          fact.detail?.kind === 'project_value' &&
          fact.detail.category === 'cost' &&
          ['user_reported', 'agent_reported'].includes(fact.detail.basis),
      );
      return {
        projectKey,
        title: project?.card.title ?? null,
        status: project?.card.status ?? null,
        missingProject: !project,
        complete,
        observations: values.slice(0, 24).map(projectValueView),
        readFullRecords: values.length > 24,
        gaps: missing,
        explicitlyUnknown: unknown,
        proposedNextChecks: next.slice(0, 3).map((fact) => ({
          action: fact.value.slice(0, 600),
          successCriterion:
            fact.detail?.kind === 'project_value'
              ? fact.detail.successCriterion?.slice(0, 300)
              : null,
          key: fact.key,
          revision: fact.revision,
        })),
        nextEvidenceNeeded: !project
          ? 'Identify the requested project.'
          : !complete
            ? 'Read the remaining scoped records before comparing.'
            : missing.includes('observed_result') ||
                unknown.includes('observed_result')
              ? 'Record an observable result for the stated benefit.'
              : missing.includes('next_check') || unknown.includes('next_check')
                ? 'Define one next check and its success criterion.'
                : missing.includes('cost') ||
                    unknown.includes('cost') ||
                    !hasReportedCost
                  ? 'Record actual known costs or keep them explicitly unknown.'
                  : null,
      };
    }),
  };
  while (Buffer.byteLength(JSON.stringify(result)) > 96 * 1024) {
    const largest = result.projects.reduce((a, b) =>
      b.observations.length > a.observations.length ? b : a,
    );
    if (!largest.observations.length) break;
    largest.observations.pop();
    largest.readFullRecords = true;
  }
  return result;
}
