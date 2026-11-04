// App-server completion is lifecycle information, never host acceptance.
// Keep this assessment safe to persist: only fixed codes and bounded counts.
const LIMIT = 10_000;
const TOOL_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
]);
const REJECTED = new Set(['declined', 'rejected']);
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const hasError = (value) =>
  typeof value === 'string'
    ? value.trim().length > 0
    : record(value) && Object.keys(value).length > 0;
const bounded = (value) => Math.min(LIMIT, value);
const REASONS = {
  pending: ['turn_in_progress'],
  unverified: [
    'missing_turn',
    'unknown_turn_status',
    'items_missing',
    'incomplete_evidence',
    'tool_failures_present',
    'acceptance_required',
  ],
  blocked: ['runtime_unavailable', 'tool_rejected'],
  failed: ['turn_error', 'turn_failed'],
  interrupted: ['turn_interrupted'],
};
const EVIDENCE_CODES = {
  turn_status: ['failed', 'interrupted', 'in_progress', 'completed'],
  turn_error: ['turn_error'],
  tool_error: ['tool_failed', 'tool_rejected', 'runtime_unavailable'],
  agent_report: ['runtime_unavailable'],
  structured_item: ['command_succeeded', 'file_changes_reported'],
};
const COUNT_KEYS = [
  'commandSucceeded',
  'commandFailed',
  'toolFailed',
  'fileChanges',
  'fileChangeFailed',
];
const exactKeys = (value, keys) =>
  record(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const isCount = (value) =>
  Number.isInteger(value) && value >= 0 && value <= LIMIT;

/** Validate only this module's safe persisted shape; never trust saved claims. */
export function isTurnResult(value) {
  if (
    !exactKeys(value, ['state', 'verified', 'reason', 'counts', 'evidence']) ||
    value.verified !== false ||
    typeof value.state !== 'string' ||
    !Object.hasOwn(REASONS, value.state) ||
    !REASONS[value.state].includes(value.reason) ||
    !exactKeys(value.counts, COUNT_KEYS) ||
    !COUNT_KEYS.every((key) => isCount(value.counts[key])) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 11 ||
    Reflect.ownKeys(value.evidence).length !== value.evidence.length + 1
  )
    return false;
  const seen = new Set();
  for (const entry of value.evidence) {
    if (
      !exactKeys(entry, ['source', 'code', 'count']) ||
      typeof entry.source !== 'string' ||
      !Object.hasOwn(EVIDENCE_CODES, entry.source) ||
      !EVIDENCE_CODES[entry.source].includes(entry.code) ||
      !isCount(entry.count) ||
      entry.count === 0
    )
      return false;
    const key = `${entry.source}:${entry.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

// Ignore examples, quotations and fenced code. Inline Markdown code is used by
// real failure reports, so retain its text. Never inspect user messages.
function prose(value) {
  if (typeof value !== 'string') return '';
  let fence = null;
  return value
    .slice(0, 16_000)
    .split('\n')
    .filter((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1][0];
        else if (fence === marker[1][0]) fence = null;
        return false;
      }
      return !fence && !/^\s*>|^(?: {4}|\t)/.test(line);
    })
    .join('\n')
    .replace(
      /"[^"\n]*"|“[^”\n]*”|(?:^|\s)'[^'\n]*'(?=\s|[.,;:]|$)|‘[^’\n]*’/g,
      '',
    )
    .replace(/[`*]/g, '')
    .trim();
}

function runtimeError(value) {
  return /^(?:error(?: running tool)?:\s*)?(?:functions\.exec(?: failed| returned)?[:\s-]*)?code-mode host is disabled(?:[.!]|$)/i.test(
    prose(value),
  );
}

function toolTexts(item) {
  const content = [item.content, item.contentItems, item.result?.content];
  return [
    item.error,
    item.error?.message,
    item.aggregatedOutput,
    item.output,
    ...content.flatMap((parts) =>
      Array.isArray(parts)
        ? parts
            .slice(0, 20)
            .filter((part) =>
              ['text', 'inputText', 'outputText'].includes(part?.type),
            )
            .map((part) => part.text)
        : [],
    ),
  ];
}

/**
 * Pure, conservative assessment of a raw app-server Turn (not its summary).
 * `verified` is always false: only independent host checks can accept a task.
 * `toolFailed` includes failed commands and file edits. `fileChanges` counts
 * reported entries in completed file edits, not independently observed files.
 * Evidence never includes output, commands, paths, identifiers or error text.
 */
export function assessTurnResult(turn) {
  const counts = {
    commandSucceeded: 0,
    commandFailed: 0,
    toolFailed: 0,
    fileChanges: 0,
    fileChangeFailed: 0,
  };
  const evidence = [];
  const add = (source, code, count = 1) => {
    const existing = evidence.find(
      (entry) => entry.source === source && entry.code === code,
    );
    if (existing) existing.count = bounded(existing.count + count);
    else evidence.push({ source, code, count: bounded(count) });
  };
  const result = (state, reason) => ({
    state,
    verified: false,
    reason,
    counts,
    evidence,
  });
  if (!record(turn)) return result('unverified', 'missing_turn');

  const items = Array.isArray(turn.items) ? turn.items : [];
  let finalText = '';
  let runtimeBlocked = false;
  const rejectedTypes = new Set();
  let malformed = false;
  for (const item of items.slice(0, LIMIT)) {
    if (!record(item) || typeof item.type !== 'string') {
      malformed = true;
      continue;
    }
    if (
      item.type === 'agentMessage' &&
      (!item.phase ||
        item.phase === 'final_answer' ||
        item.phase === 'final') &&
      (!item.channel || item.channel === 'final')
    ) {
      finalText = prose(item.text);
    }
    if (!TOOL_TYPES.has(item.type)) continue;
    const rejected = REJECTED.has(item.status);
    const failed =
      rejected ||
      item.status === 'failed' ||
      item.success === false ||
      item.isError === true ||
      item.result?.isError === true ||
      hasError(item.error) ||
      (item.type === 'commandExecution' &&
        Number.isInteger(item.exitCode) &&
        item.exitCode !== 0);
    const succeeded =
      item.status === 'completed' &&
      !failed &&
      (item.type !== 'commandExecution' || item.exitCode === 0) &&
      (item.type !== 'dynamicToolCall' || item.success === true);
    if (failed) {
      counts.toolFailed = bounded(counts.toolFailed + 1);
      add('tool_error', 'tool_failed');
    }
    if (item.type === 'commandExecution') {
      if (failed) counts.commandFailed = bounded(counts.commandFailed + 1);
      if (succeeded) {
        counts.commandSucceeded = bounded(counts.commandSucceeded + 1);
        add('structured_item', 'command_succeeded');
      }
    }
    if (item.type === 'fileChange') {
      if (failed)
        counts.fileChangeFailed = bounded(counts.fileChangeFailed + 1);
      if (succeeded && Array.isArray(item.changes)) {
        const changes = item.changes
          .slice(0, LIMIT)
          .filter(
            (change) => record(change) && typeof change.path === 'string',
          ).length;
        counts.fileChanges = bounded(counts.fileChanges + changes);
        if (changes) add('structured_item', 'file_changes_reported', changes);
      }
    }
    // A later successful tool can demonstrate recovery from a runtime outage.
    // A rejected edit requires a later successful edit, not an unrelated read.
    if (succeeded) {
      runtimeBlocked = false;
      rejectedTypes.delete(item.type);
    }
    if (rejected) {
      rejectedTypes.add(item.type);
      add('tool_error', 'tool_rejected');
    }
    if (failed && toolTexts(item).some(runtimeError)) {
      runtimeBlocked = true;
      add('tool_error', 'runtime_unavailable');
    }
  }

  if (hasError(turn.error)) {
    add('turn_error', 'turn_error');
    return result('failed', 'turn_error');
  }
  if (turn.status === 'failed' || turn.status === 'interrupted') {
    add('turn_status', turn.status);
    return result(turn.status, `turn_${turn.status}`);
  }
  if (turn.status === 'inProgress') {
    add('turn_status', 'in_progress');
    return result('pending', 'turn_in_progress');
  }
  if (turn.status !== 'completed')
    return result('unverified', 'unknown_turn_status');
  add('turn_status', 'completed');
  if (!Array.isArray(turn.items)) return result('unverified', 'items_missing');
  if (items.length > LIMIT || malformed)
    return result('unverified', 'incomplete_evidence');

  // Recognize a current report of the known outage, not arbitrary failure NLP.
  // Historical/quoted mentions and an agent's "verified" claim prove nothing.
  const reportsBlocked =
    /^(?:(?:i am|i'm|task) )?blocked(?:[:.!]| by (?:the )?(?:local )?(?:tool )?runtime\b)/i.test(
      finalText,
    ) && /\bcode-mode host is disabled\b/i.test(finalText);
  if (reportsBlocked) {
    add('agent_report', 'runtime_unavailable');
    return result('blocked', 'runtime_unavailable');
  }
  // Narrative recovery claims cannot clear a structured tool failure.
  if (runtimeBlocked) return result('blocked', 'runtime_unavailable');
  if (rejectedTypes.size) return result('blocked', 'tool_rejected');
  return result(
    'unverified',
    counts.toolFailed ? 'tool_failures_present' : 'acceptance_required',
  );
}
