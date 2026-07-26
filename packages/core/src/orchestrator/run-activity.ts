/**
 * Liveness bridge between the host-side IPC watcher and the active sandbox
 * run of the same group folder.
 *
 * An agent run can report progress exclusively through the IPC channel
 * (send-message MCP tool → data/ipc/<group>/messages → host router) and
 * produce NOTHING on the sandbox child's stdout. runSandboxAgent's
 * first-output ("no-output") and useful-progress deadlines reset only on
 * parsed stdout markers, so such a run looks dead to them and gets killed
 * mid-work while a tool-driven run is still delivering reports.
 *
 * The runner registers a listener under its group folder for the lifetime of
 * the run; the IPC watcher calls notifyRunIpcActivity(sourceGroup, kind)
 * after every CONFIRMED delivery (router actually delivered the envelope /
 * send returned ok). Same-process only by design: the IPC watcher and
 * runSandboxAgent both live in the orchestrator process.
 */
import { logger } from './logger.js';

export type RunIpcActivityKind =
  'message' | 'photo' | 'document' | 'voice' | 'memory' | 'google';
export type RunIpcActivityListener = (kind: RunIpcActivityKind) => void;

const listenersByFolder = new Map<string, Set<RunIpcActivityListener>>();

/**
 * Register a listener for confirmed IPC deliveries originating from
 * `groupFolder`'s sandbox. Returns an idempotent unsubscribe function — the
 * runner must call it when the run ends, so a delivery confirmed after the
 * run closed (the IPC watcher is asynchronous) can't touch a finished run's
 * timers, and a leaked listener can't accumulate across runs.
 */
export function onRunIpcActivity(
  groupFolder: string,
  listener: RunIpcActivityListener,
): () => void {
  let set = listenersByFolder.get(groupFolder);
  if (!set) {
    set = new Set();
    listenersByFolder.set(groupFolder, set);
  }
  set.add(listener);
  return () => {
    const current = listenersByFolder.get(groupFolder);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersByFolder.delete(groupFolder);
  };
}

/**
 * Notify the active run(s) for `groupFolder` of a confirmed IPC delivery.
 * Returns the number of listeners notified — 0 when no run is active (e.g. a
 * late delivery confirmed after the run already closed; harmless no-op).
 * Listener errors are contained: a throwing listener must never break the
 * IPC watcher's delivery loop.
 */
export function notifyRunIpcActivity(
  groupFolder: string,
  kind: RunIpcActivityKind,
): number {
  const set = listenersByFolder.get(groupFolder);
  if (!set || set.size === 0) return 0;
  let notified = 0;
  // Copy before iterating: a listener may unsubscribe (itself or a sibling)
  // mid-notify without invalidating the iteration.
  for (const listener of [...set]) {
    try {
      listener(kind);
      notified++;
    } catch (err) {
      logger.warn(
        { groupFolder, kind, err },
        'Run IPC-activity listener threw; continuing',
      );
    }
  }
  return notified;
}
