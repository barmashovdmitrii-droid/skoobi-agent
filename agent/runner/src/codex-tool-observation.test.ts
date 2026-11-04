import { describe, expect, it } from 'vitest';
import {
  createCodexToolObserver,
  type CodexToolObservation,
} from './codex-tool-observation.js';

describe('Codex CLI tool observations', () => {
  it('pairs starts/completions, deduplicates and exports opaque IDs only', () => {
    const events: CodexToolObservation[] = [];
    const observer = createCodexToolObserver((event) => events.push(event));
    const item = {
      id: 'synthetic-private-source-id',
      type: 'mcp_tool_call',
      tool: 'synthetic-secret-name',
      arguments: { token: 'synthetic-token' },
      status: 'in_progress',
    };
    observer.observe({ type: 'item.started', item });
    observer.observe({ type: 'item.started', item });
    observer.observe({
      type: 'item.completed',
      item: {
        ...item,
        status: 'completed',
        result: { private: 'synthetic-token' },
      },
    });
    observer.observe({ type: 'item.completed', item });
    observer.observe({ type: 'item.started', item });
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      phase: 'finished',
      callId: events[0].callId,
      family: 'mcp',
      outcome: 'succeeded',
      startedObserved: true,
      source: 'codex_cli',
    });
    expect(events[0].callId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(events)).not.toContain('synthetic');
  });

  it('does not turn model text or reasoning into tool events', () => {
    const events: CodexToolObservation[] = [];
    const observer = createCodexToolObserver((event) => events.push(event));
    for (const type of [
      'agent_message',
      'reasoning',
      'error',
      'tool_call',
      'constructor',
    ]) {
      observer.observe({
        type: 'item.completed',
        item: {
          type,
          text: 'Called tool and verified artifact',
          status: 'completed',
        },
      });
    }
    observer.observe({ type: 'tool_call', item: { type: 'mcp_tool_call' } });
    expect(events).toEqual([]);
  });

  it('does not invent starts or success when the CLI omits them', () => {
    const events: CodexToolObservation[] = [];
    const observer = createCodexToolObserver((event) => events.push(event));
    observer.observe({
      type: 'item.completed',
      item: {
        id: 'completion-only',
        type: 'command_execution',
        status: 'completed',
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: 'finished',
      family: 'shell',
      outcome: 'unknown',
      startedObserved: false,
    });
    observer.observe({ type: 'item.started', item: { type: 'mcp_tool_call' } });
    observer.observe({
      type: 'item.completed',
      item: { type: 'mcp_tool_call', status: 'completed' },
    });
    expect(events[2].startedObserved).toBe(false);
    expect(events[1].callId).not.toBe(events[2].callId);
  });

  it('reports observed failures without leaking errors or equating completion with external proof', () => {
    const events: CodexToolObservation[] = [];
    const observer = createCodexToolObserver((event) => events.push(event));
    for (const [index, item] of [
      { type: 'command_execution', exit_code: 1 },
      { type: 'mcp_tool_call', status: 'completed', result: { isError: true } },
      { type: 'mcp_tool_call', status: 'failed', error: 'synthetic-secret' },
      { type: 'command_execution', exit_code: 0 },
      { type: 'file_change', status: 'completed' },
      { type: 'web_search' },
    ].entries())
      observer.observe({
        type: 'item.completed',
        item: { id: String(index), ...item },
      });
    expect(events.map((event) => event.outcome)).toEqual([
      'failed',
      'failed',
      'failed',
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(events.every((event) => event.source === 'codex_cli')).toBe(true);
  });

  it('bounds events/maps, still finishes tracked calls after reaching the limit', () => {
    const events: CodexToolObservation[] = [];
    const observer = createCodexToolObserver((event) => events.push(event));
    for (let i = 0; i < 600; i++)
      observer.observe({
        type: 'item.started',
        item: { id: String(i), type: 'command_execution' },
      });
    for (let i = 0; i < 600; i++)
      observer.observe({
        type: 'item.completed',
        item: { id: String(i), type: 'command_execution', exit_code: 0 },
      });
    expect(events.filter((event) => event.phase === 'started')).toHaveLength(
      512,
    );
    expect(events.filter((event) => event.phase === 'finished')).toHaveLength(
      512,
    );
  });

  it('uses distinct IDs in distinct CLI attempts, while optional callbacks fail open', () => {
    const events: CodexToolObservation[] = [];
    for (let i = 0; i < 2; i++)
      createCodexToolObserver((event) => events.push(event)).observe({
        type: 'item.started',
        item: { id: 'same', type: 'web_search' },
      });
    expect(events[0].callId).not.toBe(events[1].callId);
    expect(() =>
      createCodexToolObserver(() => {
        throw new Error('unavailable');
      }).observe({ type: 'item.started', item: { type: 'web_search' } }),
    ).not.toThrow();
    expect(() =>
      createCodexToolObserver(() => {}).observe(
        new Proxy(
          {},
          {
            get() {
              throw new Error('malformed');
            },
          },
        ),
      ),
    ).not.toThrow();
  });
});
