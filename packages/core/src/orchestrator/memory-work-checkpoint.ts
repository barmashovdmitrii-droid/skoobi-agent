/** Reported task state, never an authorization or an independently verified fact. */
export interface MemoryWorkCheckpoint {
  target: string;
  executor: string;
  lastObservedAt?: string;
  requirementsRevision: number;
  nextStep: string | null;
  waitingOn?: string;
  criteria: Array<{
    key: string;
    description: string;
    state: 'pending' | 'passed' | 'failed' | 'blocked';
    checkedRevision?: number;
    evidence?: string;
  }>;
}
const fail = (): never => {
  throw new Error('invalid_work_checkpoint');
};
const text = (v: unknown, max: number): string =>
  typeof v === 'string' && v.trim() && v.length <= max ? v : fail();
const revision = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : fail();
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    return fail();
  return value as Record<string, unknown>;
}
export function parseMemoryWorkCheckpoint(raw: unknown): MemoryWorkCheckpoint {
  const v = object(raw, [
    'target',
    'executor',
    'lastObservedAt',
    'requirementsRevision',
    'nextStep',
    'waitingOn',
    'criteria',
  ]);
  const rev = revision(v.requirementsRevision);
  if (
    !Array.isArray(v.criteria) ||
    !v.criteria.length ||
    v.criteria.length > 30
  )
    return fail();
  const keys = new Set<string>();
  const criteria = v.criteria.map((item) => {
    const c = object(item, [
      'key',
      'description',
      'state',
      'checkedRevision',
      'evidence',
    ]);
    const key = text(c.key, 80);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(key) || keys.has(key))
      return fail();
    keys.add(key);
    if (!['pending', 'passed', 'failed', 'blocked'].includes(String(c.state)))
      return fail();
    const checkedRevision =
      c.checkedRevision === undefined ? undefined : revision(c.checkedRevision);
    if (checkedRevision !== undefined && checkedRevision > rev) return fail();
    const evidence =
      c.evidence === undefined ? undefined : text(c.evidence, 2000);
    // Earlier checks remain historical evidence but do not pass new requirements.
    const state =
      c.state === 'passed' && checkedRevision !== rev
        ? 'pending'
        : (c.state as MemoryWorkCheckpoint['criteria'][number]['state']);
    if (state === 'passed' && !evidence) return fail();
    return {
      key,
      description: text(c.description, 1000),
      state,
      ...(checkedRevision ? { checkedRevision } : {}),
      ...(evidence ? { evidence } : {}),
    };
  });
  let lastObservedAt: string | undefined;
  if (v.lastObservedAt !== undefined) {
    const at = text(v.lastObservedAt, 40);
    if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at)
      return fail();
    lastObservedAt = at;
  }
  return {
    target: text(v.target, 500),
    executor: text(v.executor, 200),
    requirementsRevision: rev,
    ...(v.waitingOn === undefined ? {} : { waitingOn: text(v.waitingOn, 200) }),
    nextStep: v.nextStep === null ? null : text(v.nextStep, 2000),
    criteria,
    ...(lastObservedAt ? { lastObservedAt } : {}),
  };
}

/** Changing a requirement must invalidate prior acceptance. Never drop an
 * unfinished criterion silently; explicit user corrections belong in history. */
export function validateMemoryWorkTransition(
  previous: MemoryWorkCheckpoint | undefined,
  next: MemoryWorkCheckpoint | undefined,
): void {
  if (!previous) return;
  if (!next || next.requirementsRevision < previous.requirementsRevision)
    throw new Error('work_checkpoint_revision_required');
  const requirements = (w: MemoryWorkCheckpoint) =>
    JSON.stringify([w.target, w.criteria.map((c) => [c.key, c.description])]);
  if (
    requirements(previous) !== requirements(next) &&
    next.requirementsRevision <= previous.requirementsRevision
  )
    throw new Error('work_requirements_revision_required');
}
