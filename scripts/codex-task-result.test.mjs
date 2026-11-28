import { describe, expect, it } from 'vitest';
import { assessTurnResult, isTurnResult } from '../helper/codex-task-result.js';

const message = (text, extra = {}) => ({
  type: 'agentMessage',
  text,
  ...extra,
});
const completed = (...items) => ({ status: 'completed', items });
const runtimeFailure = () => ({
  type: 'dynamicToolCall',
  tool: 'functions.exec',
  status: 'failed',
  success: false,
  contentItems: [{ type: 'inputText', text: 'code-mode host is disabled' }],
});
const blockedReport =
  'Blocked by the local tool runtime: `functions.exec` returned **`code-mode host is disabled`**. I couldn’t read the brief, implement changes, or run checks. No files changed.';

describe('isTurnResult', () => {
  const valid = () => assessTurnResult(completed(runtimeFailure()));

  it('accepts generated safe outcomes and their JSON round trips', () => {
    for (const turn of [
      undefined,
      completed(),
      completed(runtimeFailure()),
      { status: 'failed' },
      { status: 'interrupted' },
      { status: 'inProgress' },
      completed(
        {
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'a.js' }],
        },
        { type: 'commandExecution', status: 'completed', exitCode: 0 },
      ),
      { ...completed(), error: { message: 'test failure' } },
    ]) {
      const result = assessTurnResult(turn);
      expect(isTurnResult(result)).toBe(true);
      expect(isTurnResult(JSON.parse(JSON.stringify(result)))).toBe(true);
    }
  });

  it('rejects claimed verification, unknown states/reasons and mismatched state/reason', () => {
    expect(isTurnResult({ ...valid(), verified: true })).toBe(false);
    expect(isTurnResult({ ...valid(), verified: 'false' })).toBe(false);
    expect(isTurnResult({ ...valid(), state: 'verified' })).toBe(false);
    expect(isTurnResult({ ...valid(), reason: 'unknown' })).toBe(false);
    expect(isTurnResult({ ...valid(), state: 'pending' })).toBe(false);
  });

  it('rejects unknown fields and raw text at every object level', () => {
    expect(isTurnResult({ ...valid(), rawOutput: 'SENSITIVE_SENTINEL' })).toBe(
      false,
    );
    expect(
      isTurnResult({
        ...valid(),
        counts: { ...valid().counts, command: 'SENSITIVE_SENTINEL' },
      }),
    ).toBe(false);
    expect(
      isTurnResult({
        ...valid(),
        evidence: [{ ...valid().evidence[0], text: 'SENSITIVE_SENTINEL' }],
      }),
    ).toBe(false);
    expect(
      isTurnResult({
        ...valid(),
        evidence: [
          { source: 'tool_error', code: 'SENSITIVE_SENTINEL', count: 1 },
        ],
      }),
    ).toBe(false);
    expect(
      isTurnResult({
        ...valid(),
        evidence: [
          { source: 'SENSITIVE_SENTINEL', code: 'tool_failed', count: 1 },
        ],
      }),
    ).toBe(false);
  });

  it.each([-1, 10_001, 1.5, NaN, Infinity, '1', null])(
    'rejects invalid bounded counts %j',
    (count) => {
      expect(
        isTurnResult({
          ...valid(),
          counts: { ...valid().counts, toolFailed: count },
        }),
      ).toBe(false);
      expect(
        isTurnResult({
          ...valid(),
          evidence: [{ ...valid().evidence[0], count }],
        }),
      ).toBe(false);
    },
  );

  it('rejects missing keys, unknown source/code combinations and repeated evidence', () => {
    const incomplete = valid();
    delete incomplete.counts.fileChanges;
    expect(isTurnResult(incomplete)).toBe(false);
    expect(
      isTurnResult({
        ...valid(),
        evidence: [
          { source: 'agent_report', code: 'command_succeeded', count: 1 },
        ],
      }),
    ).toBe(false);
    expect(
      isTurnResult({
        ...valid(),
        evidence: [valid().evidence[0], valid().evidence[0]],
      }),
    ).toBe(false);
    expect(
      isTurnResult({
        ...valid(),
        evidence: Array.from({ length: 12 }, () => valid().evidence[0]),
      }),
    ).toBe(false);
    expect(
      isTurnResult({
        ...valid(),
        evidence: [{ ...valid().evidence[0], count: 0 }],
      }),
    ).toBe(false);
  });

  it('rejects sparse evidence, array properties and malformed enum objects', () => {
    expect(isTurnResult({ ...valid(), evidence: Array(1) })).toBe(false);
    const evidence = [...valid().evidence];
    evidence.rawText = 'SENSITIVE_SENTINEL';
    expect(isTurnResult({ ...valid(), evidence })).toBe(false);
    expect(isTurnResult({ ...valid(), state: { toString: null } })).toBe(false);
    expect(
      isTurnResult({
        ...valid(),
        evidence: [
          { source: { toString: null }, code: 'tool_failed', count: 1 },
        ],
      }),
    ).toBe(false);
  });

  it.each([undefined, null, [], {}, true, 'verified'])(
    'rejects malformed values %j',
    (value) => {
      expect(isTurnResult(value)).toBe(false);
    },
  );
});
describe('assessTurnResult', () => {
  it('keeps lifecycle completion and Done unverified', () => {
    expect(assessTurnResult(completed(message('Done')))).toMatchObject({
      state: 'unverified',
      verified: false,
      reason: 'acceptance_required',
    });
  });

  it('counts successful commands and reported files without verifying acceptance', () => {
    const result = assessTurnResult(
      completed(
        { type: 'commandExecution', status: 'completed', exitCode: 0 },
        {
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'a.js' }, { path: 'b.js' }],
        },
        message('All checks pass; verified.'),
      ),
    );
    expect(result).toMatchObject({
      state: 'unverified',
      verified: false,
      counts: {
        commandSucceeded: 1,
        commandFailed: 0,
        toolFailed: 0,
        fileChanges: 2,
      },
    });
  });

  it('recognizes the actual known runtime failure from a structured tool error', () => {
    expect(assessTurnResult(completed(runtimeFailure()))).toMatchObject({
      state: 'blocked',
      verified: false,
      counts: { toolFailed: 1 },
      evidence: expect.arrayContaining([
        { source: 'tool_error', code: 'runtime_unavailable', count: 1 },
      ]),
    });
  });

  it('marks a current final assistant outage report as agent evidence', () => {
    const result = assessTurnResult(completed(message(blockedReport)));
    expect(result).toMatchObject({
      state: 'blocked',
      reason: 'runtime_unavailable',
      counts: { toolFailed: 0, fileChanges: 0 },
    });
    expect(result.evidence).toContainEqual({
      source: 'agent_report',
      code: 'runtime_unavailable',
      count: 1,
    });
  });

  it.each(['final_answer', 'final'])(
    'recognizes blocked agent messages with phase %s',
    (phase) => {
      const result = assessTurnResult({
        id: 'turn-example',
        status: 'completed',
        error: null,
        items: [
          {
            id: 'message-example',
            type: 'agentMessage',
            phase,
            text: blockedReport,
          },
        ],
      });
      expect(result).toMatchObject({
        state: 'blocked',
        verified: false,
        reason: 'runtime_unavailable',
      });
      expect(result.evidence).toContainEqual({
        source: 'agent_report',
        code: 'runtime_unavailable',
        count: 1,
      });
    },
  );

  it.each(['commentary', 'partial_answer'])(
    'does not classify a %s message as the final outcome',
    (phase) => {
      expect(
        assessTurnResult(
          completed(
            message('Done', { phase: 'final_answer' }),
            message(blockedReport, { phase }),
          ),
        ).state,
      ).toBe('unverified');
    },
  );

  it('ignores user quoted errors and arbitrary assistant verification claims', () => {
    expect(
      assessTurnResult(
        completed(
          {
            type: 'userMessage',
            content: [{ type: 'text', text: blockedReport }],
          },
          message('Verified. Everything succeeded.'),
        ),
      ),
    ).toMatchObject({
      state: 'unverified',
      verified: false,
      counts: { toolFailed: 0 },
    });
  });

  it.each([
    `Example:\n\n\`\`\`text\n${blockedReport}\n\`\`\``,
    `> ${blockedReport}`,
    `The user said "${blockedReport}"`,
    `Blocked by the local tool runtime: the user quoted 'code-mode host is disabled'.`,
    `~~~\n${blockedReport}`,
    `    ${blockedReport}`,
  ])('ignores quoted or code example text: %s', (text) => {
    expect(assessTurnResult(completed(message(text))).state).toBe('unverified');
  });

  it('does not mistake tool input or a successful command printing an error example for failure', () => {
    const result = assessTurnResult(
      completed({
        type: 'commandExecution',
        status: 'completed',
        exitCode: 0,
        command: 'code-mode host is disabled',
        aggregatedOutput: 'code-mode host is disabled',
      }),
    );
    expect(result).toMatchObject({
      state: 'unverified',
      counts: { commandSucceeded: 1, commandFailed: 0, toolFailed: 0 },
    });
  });

  it.each([
    ['failed', 'failed'],
    ['interrupted', 'interrupted'],
    ['inProgress', 'pending'],
  ])('uses structured %s status', (status, state) => {
    expect(
      assessTurnResult({ status, items: [message('Verified and complete.')] }),
    ).toMatchObject({ state, verified: false });
  });

  it('trusts structured turn errors over a completed lifecycle or positive final narrative', () => {
    expect(
      assessTurnResult({
        ...completed(message('Done; verified.')),
        error: { message: 'example failure' },
      }),
    ).toMatchObject({ state: 'failed', reason: 'turn_error' });
  });

  it('retains historical failure evidence without forcing failure after tool recovery', () => {
    const result = assessTurnResult(
      completed(
        runtimeFailure(),
        { type: 'commandExecution', status: 'completed', exitCode: 0 },
        message(
          'The earlier code-mode host is disabled error was resolved. Checks completed.',
        ),
      ),
    );
    expect(result).toMatchObject({
      state: 'unverified',
      verified: false,
      counts: { toolFailed: 1, commandSucceeded: 1 },
    });
    expect(result.evidence).toContainEqual({
      source: 'tool_error',
      code: 'runtime_unavailable',
      count: 1,
    });
  });

  it('does not let an agent recovery claim clear a structured runtime outage', () => {
    expect(
      assessTurnResult(
        completed(
          runtimeFailure(),
          message(
            'Recovered: the runtime was restored and the task completed.',
          ),
        ),
      ).state,
    ).toBe('blocked');
  });

  it('uses the last final message and ignores commentary outage reports', () => {
    expect(
      assessTurnResult(
        completed(
          message(blockedReport, { phase: 'commentary' }),
          message('Done', { phase: 'final' }),
        ),
      ).state,
    ).toBe('unverified');
    expect(
      assessTurnResult(
        completed(
          message(blockedReport),
          message('Recovered: tooling is working.'),
        ),
      ).state,
    ).toBe('unverified');
  });

  it('does not classify a historical blocked report as current failure', () => {
    expect(
      assessTurnResult(
        completed(
          message(
            'Blocked earlier by functions.exec: code-mode host is disabled. The runtime was restored and checks passed.',
          ),
        ),
      ).state,
    ).toBe('unverified');
  });

  it.each([
    undefined,
    null,
    [],
    'completed',
    {},
    { status: 'unknown' },
    { status: {} },
    { status: 'completed' },
    { status: 'completed', items: {} },
    completed(null),
  ])('fails closed on missing/malformed input %j', (turn) => {
    expect(assessTurnResult(turn)).toMatchObject({
      state: 'unverified',
      verified: false,
    });
  });

  it.each(['commandExecution', 'fileChange', 'dynamicToolCall'])(
    'tracks and blocks a rejected %s',
    (type) => {
      const result = assessTurnResult(
        completed({
          type,
          status: 'declined',
          changes: [{ path: 'untouched.js' }],
        }),
      );
      expect(result).toMatchObject({
        state: 'blocked',
        reason: 'tool_rejected',
        counts: { toolFailed: 1, fileChanges: 0 },
      });
      if (type === 'fileChange') expect(result.counts.fileChangeFailed).toBe(1);
      if (type === 'commandExecution')
        expect(result.counts.commandFailed).toBe(1);
    },
  );

  it('does not let an unrelated successful command clear a rejected file edit', () => {
    expect(
      assessTurnResult(
        completed(
          { type: 'fileChange', status: 'rejected' },
          { type: 'commandExecution', status: 'completed', exitCode: 0 },
        ),
      ).state,
    ).toBe('blocked');
  });

  it.each(['commandExecution', 'fileChange', 'dynamicToolCall'])(
    'does not let a recovery claim clear a rejected %s',
    (type) => {
      const result = assessTurnResult(
        completed(
          { type, status: 'rejected' },
          message('Recovered: all work is finished.', {
            phase: 'final_answer',
          }),
        ),
      );
      expect(result).toMatchObject({
        state: 'blocked',
        verified: false,
        reason: 'tool_rejected',
        counts: { toolFailed: 1 },
      });
      expect(
        result.evidence.some((entry) => entry.source === 'agent_report'),
      ).toBe(false);
    },
  );

  it('keeps a recovered rejected edit unverified', () => {
    expect(
      assessTurnResult(
        completed(
          { type: 'fileChange', status: 'declined' },
          {
            type: 'fileChange',
            status: 'completed',
            changes: [{ path: 'a.js' }],
          },
          message('Done'),
        ),
      ),
    ).toMatchObject({
      state: 'unverified',
      counts: { toolFailed: 1, fileChangeFailed: 1, fileChanges: 1 },
    });
  });

  it('captures nonzero command exit and MCP errors without assuming whole-task failure', () => {
    expect(
      assessTurnResult(
        completed(
          { type: 'commandExecution', status: 'completed', exitCode: 2 },
          {
            type: 'mcpToolCall',
            status: 'failed',
            error: { message: 'temporary error' },
          },
          { type: 'commandExecution', status: 'completed' },
        ),
      ),
    ).toMatchObject({
      state: 'unverified',
      counts: { commandSucceeded: 0, commandFailed: 1, toolFailed: 2 },
    });
  });

  it('recognizes runtime errors in an error message, but not quoted failed-command output', () => {
    expect(
      assessTurnResult(
        completed({
          type: 'mcpToolCall',
          status: 'failed',
          error: { message: 'Error: code-mode host is disabled.' },
        }),
      ).state,
    ).toBe('blocked');
    expect(
      assessTurnResult(
        completed({
          type: 'commandExecution',
          status: 'failed',
          exitCode: 1,
          aggregatedOutput:
            'Tests failed. Expected example:\n```text\ncode-mode host is disabled\n```',
        }),
      ).state,
    ).toBe('unverified');
  });

  it('never copies outputs, errors, commands, paths, IDs or final prose into its result', () => {
    const sensitive = 'SENSITIVE_SENTINEL';
    const turn = {
      id: sensitive,
      ...completed(
        {
          type: 'commandExecution',
          status: 'failed',
          exitCode: 1,
          command: sensitive,
          aggregatedOutput: sensitive,
        },
        {
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: sensitive, diff: sensitive }],
        },
        message(sensitive),
      ),
      error: { message: sensitive },
    };
    const before = JSON.stringify(turn);
    const result = assessTurnResult(turn);
    expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(JSON.stringify(turn)).toBe(before);
    expect(result.verified).toBe(false);
  });

  it('bounds counts and evidence for oversized input', () => {
    const result = assessTurnResult(
      completed(
        ...Array.from({ length: 10_001 }, () => ({
          type: 'commandExecution',
          status: 'failed',
          exitCode: 1,
        })),
      ),
    );
    expect(result).toMatchObject({
      state: 'unverified',
      reason: 'incomplete_evidence',
      counts: { toolFailed: 10_000, commandFailed: 10_000 },
    });
    expect(result.evidence.length).toBeLessThan(10);
  });
});
