import { randomUUID } from 'node:crypto';

/** A CLI observation, not proof of an external effect or artifact correctness. */
export interface CodexToolObservation {
  phase: 'started' | 'finished';
  callId: string;
  family: 'shell' | 'file' | 'browser' | 'mcp' | 'other';
  outcome?: 'succeeded' | 'failed' | 'unknown';
  startedObserved: boolean;
  source: 'codex_cli';
}

const FAMILIES: Record<string, CodexToolObservation['family']> = {
  command_execution: 'shell',
  file_change: 'file',
  web_search: 'browser',
  mcp_tool_call: 'mcp',
  image_generation_call: 'other',
};
const MAX_CALLS = 512;

/** One instance per CLI attempt. Raw IDs are bounded and stay in this map only. */
export function createCodexToolObserver(
  callback: ((event: CodexToolObservation) => void) | undefined,
): { observe(event: unknown): void } {
  const calls = new Map<
    string,
    { id: string; started: boolean; finished: boolean }
  >();
  let observedCalls = 0;
  const emit = (event: CodexToolObservation) => {
    try {
      callback?.(event);
    } catch {
      /* telemetry never changes execution */
    }
  };
  return {
    observe(raw) {
      if (!callback || !raw || typeof raw !== 'object') return;
      try {
        const event = raw as Record<string, unknown>;
        if (event.type !== 'item.started' && event.type !== 'item.completed')
          return;
        if (!event.item || typeof event.item !== 'object') return;
        const item = event.item as Record<string, unknown>;
        const family =
          typeof item.type === 'string' && Object.hasOwn(FAMILIES, item.type)
            ? FAMILIES[item.type]
            : undefined;
        if (!family) return; // agent messages, reasoning and tool-looking text are not events.
        const sourceId =
          typeof item.id === 'string' && item.id.length <= 256
            ? item.id
            : typeof item.call_id === 'string' && item.call_id.length <= 256
              ? item.call_id
              : undefined;
        const key = sourceId ? `${item.type}:${sourceId}` : undefined;
        let state = key ? calls.get(key) : undefined;
        if (!state) {
          if (observedCalls >= MAX_CALLS) return;
          state = { id: randomUUID(), started: false, finished: false };
          observedCalls++;
          if (key) calls.set(key, state);
        }
        if (state.finished) return;
        if (event.type === 'item.started') {
          if (state.started) return;
          state.started = true;
          emit({
            phase: 'started',
            callId: state.id,
            family,
            startedObserved: true,
            source: 'codex_cli',
          });
          return;
        }
        state.finished = true;
        const result =
          item.result && typeof item.result === 'object'
            ? (item.result as Record<string, unknown>)
            : undefined;
        let outcome: CodexToolObservation['outcome'] = 'unknown';
        if (
          item.status === 'failed' ||
          item.status === 'error' ||
          item.error ||
          result?.isError === true ||
          result?.is_error === true
        )
          outcome = 'failed';
        else if (family === 'shell') {
          if (
            typeof item.exit_code === 'number' &&
            Number.isSafeInteger(item.exit_code)
          )
            outcome = item.exit_code === 0 ? 'succeeded' : 'failed';
        } else if (
          item.status === 'completed' ||
          (family === 'browser' && item.status === undefined)
        )
          outcome = 'succeeded';
        emit({
          phase: 'finished',
          callId: state.id,
          family,
          outcome,
          startedObserved: state.started,
          source: 'codex_cli',
        });
      } catch {
        /* malformed optional observations remain irrelevant to execution */
      }
    },
  };
}
