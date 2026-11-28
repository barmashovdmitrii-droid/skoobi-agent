import type { ChildProcess } from 'child_process';

type KillableProcess = Pick<ChildProcess, 'pid' | 'kill'>;

/**
 * Kill a spawned child and, when possible, its whole process group.
 *
 * Agent runners are spawned detached, so the direct child is the process-group
 * leader. A negative PID reaches descendants such as the Claude SDK process and
 * any Bash command it started. Falling back to child.kill keeps this safe for
 * tests and for any non-detached future caller.
 */
export function killProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  const pid = child.pid;
  if (pid && pid > 1) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }

  try {
    child.kill(signal);
  } catch {
    /* already dead */
  }
}

export function processIsAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function terminateProcessTree(
  child: KillableProcess,
  options: {
    graceMs?: number;
    onEscalate?: (pid: number) => void;
  } = {},
): void {
  const graceMs = options.graceMs ?? 5000;
  killProcessTree(child, 'SIGTERM');

  const pid = child.pid;
  if (!pid || pid <= 1 || graceMs <= 0) return;

  const timer = setTimeout(() => {
    if (!processIsAlive(pid)) return;
    options.onEscalate?.(pid);
    killProcessTree(child, 'SIGKILL');
  }, graceMs);
  timer.unref?.();
}
