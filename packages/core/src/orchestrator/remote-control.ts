import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

interface RemoteControlSession {
  pid: number;
  url: string;
  startedBy: string;
  startedInChat: string;
  startedAt: string;
}

let activeSession: RemoteControlSession | null = null;

const URL_REGEX = /https:\/\/claude\.ai\/code\S+/;
const URL_TIMEOUT_MS = 30_000;
const URL_POLL_MS = 200;
const STATE_FILE = path.join(DATA_DIR, 'remote-control.json');
const STDOUT_FILE = path.join(DATA_DIR, 'remote-control.stdout');
const STDERR_FILE = path.join(DATA_DIR, 'remote-control.stderr');

function saveState(session: RemoteControlSession): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(session));
}

function clearState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // ignore
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the full command line (argv) of a running process, or null if it
 * cannot be determined. Used to verify a PID's identity before adopting it,
 * since PIDs are recycled by the OS and a liveness probe alone proves nothing
 * about *which* process now holds the PID.
 */
function getProcessCommand(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 2000,
    });
    const cmd = out.trim();
    return cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}

/**
 * Verify that the process currently holding `pid` is actually the
 * `claude remote-control` process we spawned, guarding against PID reuse.
 *
 * After a crash/reboot the OS may have recycled the recorded PID to an
 * unrelated process; adopting/signalling it would be wrong (we could SIGTERM
 * an arbitrary process and report a stale bridge URL). We confirm identity by
 * inspecting the live process's argv — a recycled PID belonging to some other
 * program will not be running `claude ... remote-control`.
 */
function isOurRemoteControlProcess(pid: number): boolean {
  const cmd = getProcessCommand(pid);
  if (!cmd) {
    return false;
  }
  // The process is spawned as: claude remote-control --name 'ClaudeClaw Remote'
  // Require both the executable and the subcommand to be present so a recycled
  // PID running an unrelated binary is never adopted.
  return /(^|\/|\s)claude(\s|$)/.test(cmd) && /\bremote-control\b/.test(cmd);
}

/**
 * Restore session from disk on startup.
 * If the process is still alive AND verified to be our remote-control process,
 * adopt it. Otherwise, clean up. The identity check defends against PID reuse:
 * a liveness probe alone (process.kill(pid, 0)) cannot tell whether the PID was
 * recycled to an unrelated process after a crash/reboot.
 */
export function restoreRemoteControl(): void {
  let data: string;
  try {
    data = fs.readFileSync(STATE_FILE, 'utf-8');
  } catch {
    return;
  }

  try {
    const session: RemoteControlSession = JSON.parse(data);
    if (
      session.pid &&
      isProcessAlive(session.pid) &&
      isOurRemoteControlProcess(session.pid)
    ) {
      activeSession = session;
      logger.info(
        { pid: session.pid, url: session.url },
        'Restored Remote Control session from previous run',
      );
    } else {
      if (session.pid && isProcessAlive(session.pid)) {
        logger.warn(
          { pid: session.pid },
          'Persisted Remote Control PID is alive but is not a claude remote-control process (likely PID reuse); discarding session',
        );
      }
      clearState();
    }
  } catch {
    clearState();
  }
}

export function getActiveSession(): RemoteControlSession | null {
  return activeSession;
}

/** @internal — exported for testing only */
export function _resetForTesting(): void {
  activeSession = null;
}

/** @internal — exported for testing only */
export function _getStateFilePath(): string {
  return STATE_FILE;
}

export async function startRemoteControl(
  sender: string,
  chatJid: string,
  cwd: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (activeSession) {
    // Verify the process is still alive AND is actually our claude
    // remote-control process before handing back the cached URL. A liveness
    // probe alone is insufficient: if our process exited and the OS recycled
    // its PID to an unrelated process during this run, isProcessAlive would
    // return true and we would return a stale bridge URL (and a later
    // stopRemoteControl would SIGTERM that unrelated process). Mirror the
    // identity check used by restoreRemoteControl.
    if (
      isProcessAlive(activeSession.pid) &&
      isOurRemoteControlProcess(activeSession.pid)
    ) {
      return { ok: true, url: activeSession.url };
    }
    // Process died or the PID was recycled — clean up and start a new one.
    activeSession = null;
    clearState();
  }

  // Redirect stdout/stderr to files so the process has no pipes to the parent.
  // This prevents SIGPIPE when ClaudeClaw restarts.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const stdoutFd = fs.openSync(STDOUT_FILE, 'w');
  const stderrFd = fs.openSync(STDERR_FILE, 'w');

  let proc;
  try {
    proc = spawn('claude', ['remote-control', '--name', 'ClaudeClaw Remote'], {
      cwd,
      stdio: ['ignore', stdoutFd, stderrFd],
      detached: true,
    });
  } catch (err: any) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    return { ok: false, error: `Failed to start: ${err.message}` };
  }

  // Close FDs in the parent — the child inherited copies
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  // Fully detach from parent
  proc.unref();

  const pid = proc.pid;
  if (!pid) {
    return { ok: false, error: 'Failed to get process PID' };
  }

  // Poll the stdout file for the URL
  return new Promise((resolve) => {
    const startTime = Date.now();

    const poll = () => {
      // Check if process died
      if (!isProcessAlive(pid)) {
        resolve({ ok: false, error: 'Process exited before producing URL' });
        return;
      }

      // Check for URL in stdout file
      let content = '';
      try {
        content = fs.readFileSync(STDOUT_FILE, 'utf-8');
      } catch {
        // File might not have content yet
      }

      const match = content.match(URL_REGEX);
      if (match) {
        const session: RemoteControlSession = {
          pid,
          url: match[0],
          startedBy: sender,
          startedInChat: chatJid,
          startedAt: new Date().toISOString(),
        };
        activeSession = session;
        saveState(session);

        logger.info(
          { url: match[0], pid, sender, chatJid },
          'Remote Control session started',
        );
        resolve({ ok: true, url: match[0] });
        return;
      }

      // Timeout check
      if (Date.now() - startTime >= URL_TIMEOUT_MS) {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // already dead
          }
        }
        resolve({
          ok: false,
          error: 'Timed out waiting for Remote Control URL',
        });
        return;
      }

      setTimeout(poll, URL_POLL_MS);
    };

    poll();
  });
}

export function stopRemoteControl():
  | {
      ok: true;
    }
  | { ok: false; error: string } {
  if (!activeSession) {
    return { ok: false, error: 'No active Remote Control session' };
  }

  const { pid } = activeSession;
  // The child was spawned detached:true, so it is a process-group leader.
  // Signal the whole group (negative PID) first so helper subprocesses the
  // `claude remote-control` bridge forked are not orphaned (they would keep
  // holding the host cwd). Mirror the timeout path's group-kill, falling back
  // to the positive PID if the group signal fails (e.g. ESRCH).
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already dead
    }
  }
  activeSession = null;
  clearState();
  logger.info({ pid }, 'Remote Control session stopped');
  return { ok: true };
}
