import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock config before importing the module under test
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/claudeclaw-rc-test',
}));

// Mock child_process
const spawnMock = vi.fn();
const execFileSyncMock = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
  execFileSync: (...args: any[]) => execFileSyncMock(...args),
}));

// Default `ps -p <pid> -o command=` output: a genuine claude remote-control
// process. Individual tests override this to simulate PID reuse.
const DEFAULT_PS_COMMAND =
  "claude remote-control --name 'ClaudeClaw Remote'\n";

import {
  startRemoteControl,
  stopRemoteControl,
  restoreRemoteControl,
  getActiveSession,
  _resetForTesting,
  _getStateFilePath,
} from './remote-control.js';

// --- Helpers ---

function createMockProcess(pid = 12345) {
  return { pid, unref: vi.fn(), kill: vi.fn() };
}

describe('remote-control', () => {
  const STATE_FILE = _getStateFilePath();
  let readFileSyncSpy: ReturnType<typeof vi.spyOn>;
  let writeFileSyncSpy: ReturnType<typeof vi.spyOn>;
  let unlinkSyncSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSyncSpy: ReturnType<typeof vi.spyOn>;
  let openSyncSpy: ReturnType<typeof vi.spyOn>;
  let closeSyncSpy: ReturnType<typeof vi.spyOn>;

  // Track what readFileSync should return for the stdout file
  let stdoutFileContent: string;

  beforeEach(() => {
    _resetForTesting();
    spawnMock.mockReset();
    execFileSyncMock.mockReset();
    // By default, the live PID looks like a real claude remote-control process.
    execFileSyncMock.mockReturnValue(DEFAULT_PS_COMMAND);
    stdoutFileContent = '';

    // Default fs mocks
    mkdirSyncSpy = vi
      .spyOn(fs, 'mkdirSync')
      .mockImplementation(() => undefined as any);
    writeFileSyncSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => {});
    unlinkSyncSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    openSyncSpy = vi.spyOn(fs, 'openSync').mockReturnValue(42 as any);
    closeSyncSpy = vi.spyOn(fs, 'closeSync').mockImplementation(() => {});

    // readFileSync: return stdoutFileContent for the stdout file, state file, etc.
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
      p: string,
    ) => {
      if (p.endsWith('remote-control.stdout')) return stdoutFileContent;
      if (p.endsWith('remote-control.json')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return '';
    }) as any);
  });

  afterEach(() => {
    _resetForTesting();
    vi.restoreAllMocks();
  });

  // --- startRemoteControl ---

  describe('startRemoteControl', () => {
    it('spawns claude remote-control and returns the URL', async () => {
      const proc = createMockProcess();
      spawnMock.mockReturnValue(proc);

      // Simulate URL appearing in stdout file on first poll
      stdoutFileContent =
        'Session URL: https://claude.ai/code?bridge=env_abc123\n';
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      const result = await startRemoteControl('user1', 'tg:123', '/project');

      expect(result).toEqual({
        ok: true,
        url: 'https://claude.ai/code?bridge=env_abc123',
      });
      expect(spawnMock).toHaveBeenCalledWith(
        'claude',
        ['remote-control', '--name', 'ClaudeClaw Remote'],
        expect.objectContaining({ cwd: '/project', detached: true }),
      );
      expect(proc.unref).toHaveBeenCalled();
    });

    it('uses file descriptors for stdout/stderr (not pipes)', async () => {
      const proc = createMockProcess();
      spawnMock.mockReturnValue(proc);
      stdoutFileContent = 'https://claude.ai/code?bridge=env_test\n';
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      await startRemoteControl('user1', 'tg:123', '/project');

      const spawnCall = spawnMock.mock.calls[0];
      const options = spawnCall[2];
      // stdio should use file descriptors (numbers), not 'pipe'
      expect(options.stdio[0]).toBe('ignore');
      expect(typeof options.stdio[1]).toBe('number');
      expect(typeof options.stdio[2]).toBe('number');
    });

    it('closes file descriptors in parent after spawn', async () => {
      const proc = createMockProcess();
      spawnMock.mockReturnValue(proc);
      stdoutFileContent = 'https://claude.ai/code?bridge=env_test\n';
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      await startRemoteControl('user1', 'tg:123', '/project');

      // Two openSync calls (stdout + stderr), two closeSync calls
      expect(openSyncSpy).toHaveBeenCalledTimes(2);
      expect(closeSyncSpy).toHaveBeenCalledTimes(2);
    });

    it('saves state to disk after capturing URL', async () => {
      const proc = createMockProcess(99999);
      spawnMock.mockReturnValue(proc);
      stdoutFileContent = 'https://claude.ai/code?bridge=env_save\n';
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      await startRemoteControl('user1', 'tg:123', '/project');

      expect(writeFileSyncSpy).toHaveBeenCalledWith(
        STATE_FILE,
        expect.stringContaining('"pid":99999'),
      );
    });

    it('returns existing URL if session is already active', async () => {
      const proc = createMockProcess();
      spawnMock.mockReturnValue(proc);
      stdoutFileContent = 'https://claude.ai/code?bridge=env_existing\n';
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      await startRemoteControl('user1', 'tg:123', '/project');

      // Second call should return existing URL without spawning
      const result = await startRemoteControl('user2', 'tg:456', '/project');
      expect(result).toEqual({
        ok: true,
        url: 'https://claude.ai/code?bridge=env_existing',
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it('starts new session if existing process is dead', async () => {
      const proc1 = createMockProcess(11111);
      const proc2 = createMockProcess(22222);
      spawnMock.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

      // First start: process alive, URL found
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((() => true) as any);
      stdoutFileContent = 'https://claude.ai/code?bridge=env_first\n';
      await startRemoteControl('user1', 'tg:123', '/project');

      // Old process (11111) is dead, new process (22222) is alive
      killSpy.mockImplementation(((pid: number, sig: any) => {
        if (pid === 11111 && (sig === 0 || sig === undefined)) {
          throw new Error('ESRCH');
        }
        return true;
      }) as any);

      stdoutFileContent = 'https://claude.ai/code?bridge=env_second\n';
      const result = await startRemoteControl('user1', 'tg:123', '/project');

      expect(result).toEqual({
        ok: true,
        url: 'https://claude.ai/code?bridge=env_second',
      });
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    // ** Finding #65: the activeSession short-circuit must verify process
    //    identity (not just liveness) before returning the cached URL, so a
    //    recycled PID belonging to an unrelated process is never handed back
    //    (and never later SIGTERM'd). **
    it('does not return cached URL when the active PID was recycled (PID reuse)', async () => {
      const proc1 = createMockProcess(11111);
      const proc2 = createMockProcess(22222);
      spawnMock.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      // First start: genuine claude remote-control process, URL captured.
      stdoutFileContent = 'https://claude.ai/code?bridge=env_first\n';
      const first = await startRemoteControl('user1', 'tg:123', '/project');
      expect(first).toEqual({
        ok: true,
        url: 'https://claude.ai/code?bridge=env_first',
      });

      // The cached PID is still alive, but it has been recycled to an unrelated
      // process. The cached URL must NOT be returned; a fresh session spawns.
      execFileSyncMock.mockReturnValue('/usr/sbin/sshd -D\n');
      stdoutFileContent = 'https://claude.ai/code?bridge=env_second\n';
      const second = await startRemoteControl('user2', 'tg:456', '/project');

      expect(second).toEqual({
        ok: true,
        url: 'https://claude.ai/code?bridge=env_second',
      });
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it('returns cached URL when the active PID is still our process', async () => {
      const proc = createMockProcess(11111);
      spawnMock.mockReturnValue(proc);
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      stdoutFileContent = 'https://claude.ai/code?bridge=env_same\n';
      await startRemoteControl('user1', 'tg:123', '/project');

      // Default ps command stays a genuine claude remote-control process, so the
      // identity check passes and the cached URL is returned without respawning.
      const result = await startRemoteControl('user2', 'tg:456', '/project');
      expect(result).toEqual({
        ok: true,
        url: 'https://claude.ai/code?bridge=env_same',
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it('returns error if process exits before URL', async () => {
      const proc = createMockProcess(33333);
      spawnMock.mockReturnValue(proc);
      stdoutFileContent = '';

      // Process is dead (poll will detect this)
      vi.spyOn(process, 'kill').mockImplementation((() => {
        throw new Error('ESRCH');
      }) as any);

      const result = await startRemoteControl('user1', 'tg:123', '/project');
      expect(result).toEqual({
        ok: false,
        error: 'Process exited before producing URL',
      });
    });

    it('times out if URL never appears', async () => {
      vi.useFakeTimers();
      const proc = createMockProcess(44444);
      spawnMock.mockReturnValue(proc);
      stdoutFileContent = 'no url here';
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      const promise = startRemoteControl('user1', 'tg:123', '/project');

      // Advance past URL_TIMEOUT_MS (30s), with enough steps for polls
      for (let i = 0; i < 160; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }

      const result = await promise;
      expect(result).toEqual({
        ok: false,
        error: 'Timed out waiting for Remote Control URL',
      });

      vi.useRealTimers();
    });

    it('returns error if spawn throws', async () => {
      spawnMock.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = await startRemoteControl('user1', 'tg:123', '/project');
      expect(result).toEqual({
        ok: false,
        error: 'Failed to start: ENOENT',
      });
    });
  });

  // --- stopRemoteControl ---

  describe('stopRemoteControl', () => {
    it('kills the process and clears state', async () => {
      const proc = createMockProcess(55555);
      spawnMock.mockReturnValue(proc);
      stdoutFileContent = 'https://claude.ai/code?bridge=env_stop\n';
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((() => true) as any);

      await startRemoteControl('user1', 'tg:123', '/project');

      const result = stopRemoteControl();
      expect(result).toEqual({ ok: true });
      // Child is spawned detached (process-group leader), so stop signals the
      // whole group via the negative PID to reap any helper subprocesses.
      expect(killSpy).toHaveBeenCalledWith(-55555, 'SIGTERM');
      expect(unlinkSyncSpy).toHaveBeenCalledWith(STATE_FILE);
      expect(getActiveSession()).toBeNull();
    });

    it('returns error when no session is active', () => {
      const result = stopRemoteControl();
      expect(result).toEqual({
        ok: false,
        error: 'No active Remote Control session',
      });
    });

    // ** Finding #64: stop must signal the whole detached process group so
    //    helper subprocesses forked by the bridge are not orphaned (they would
    //    keep holding the host cwd). Mirror the timeout path's group-kill. **
    it('signals the whole process group (negative PID), not just the leader', async () => {
      const proc = createMockProcess(55555);
      spawnMock.mockReturnValue(proc);
      stdoutFileContent = 'https://claude.ai/code?bridge=env_group\n';
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((() => true) as any);

      await startRemoteControl('user1', 'tg:123', '/project');
      killSpy.mockClear();

      const result = stopRemoteControl();
      expect(result).toEqual({ ok: true });
      // Group-kill the negative PID so child processes are not orphaned.
      expect(killSpy).toHaveBeenCalledWith(-55555, 'SIGTERM');
      expect(getActiveSession()).toBeNull();
    });

    it('falls back to the positive PID if the group signal fails', async () => {
      const proc = createMockProcess(55555);
      spawnMock.mockReturnValue(proc);
      stdoutFileContent = 'https://claude.ai/code?bridge=env_fallback\n';
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((() => true) as any);

      await startRemoteControl('user1', 'tg:123', '/project');
      killSpy.mockClear();

      // Group signal (negative PID) fails (e.g. ESRCH); must fall back to the
      // positive PID rather than leaving the leader running.
      killSpy.mockImplementation(((p: number) => {
        if (p === -55555) throw new Error('ESRCH');
        return true;
      }) as any);

      const result = stopRemoteControl();
      expect(result).toEqual({ ok: true });
      expect(killSpy).toHaveBeenCalledWith(-55555, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(55555, 'SIGTERM');
      expect(getActiveSession()).toBeNull();
    });
  });

  // --- restoreRemoteControl ---

  describe('restoreRemoteControl', () => {
    it('restores session if state file exists and process is alive', () => {
      const session = {
        pid: 77777,
        url: 'https://claude.ai/code?bridge=env_restored',
        startedBy: 'user1',
        startedInChat: 'tg:123',
        startedAt: '2026-01-01T00:00:00.000Z',
      };
      readFileSyncSpy.mockImplementation(((p: string) => {
        if (p.endsWith('remote-control.json')) return JSON.stringify(session);
        return '';
      }) as any);
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      restoreRemoteControl();

      const active = getActiveSession();
      expect(active).not.toBeNull();
      expect(active!.pid).toBe(77777);
      expect(active!.url).toBe('https://claude.ai/code?bridge=env_restored');
    });

    it('clears state if process is dead', () => {
      const session = {
        pid: 88888,
        url: 'https://claude.ai/code?bridge=env_dead',
        startedBy: 'user1',
        startedInChat: 'tg:123',
        startedAt: '2026-01-01T00:00:00.000Z',
      };
      readFileSyncSpy.mockImplementation(((p: string) => {
        if (p.endsWith('remote-control.json')) return JSON.stringify(session);
        return '';
      }) as any);
      vi.spyOn(process, 'kill').mockImplementation((() => {
        throw new Error('ESRCH');
      }) as any);

      restoreRemoteControl();

      expect(getActiveSession()).toBeNull();
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });

    it('does nothing if no state file exists', () => {
      // readFileSyncSpy default throws ENOENT for .json
      restoreRemoteControl();
      expect(getActiveSession()).toBeNull();
    });

    // ** PID-reuse guard: a live PID that is NOT our claude remote-control
    //    process must NOT be adopted or signalled (it could be any recycled
    //    PID belonging to an unrelated program after a crash/reboot). **
    it('does not adopt a live PID whose process is not claude remote-control (PID reuse)', () => {
      const session = {
        pid: 77777,
        url: 'https://claude.ai/code?bridge=env_reused',
        startedBy: 'user1',
        startedInChat: 'tg:123',
        startedAt: '2026-01-01T00:00:00.000Z',
      };
      readFileSyncSpy.mockImplementation(((p: string) => {
        if (p.endsWith('remote-control.json')) return JSON.stringify(session);
        return '';
      }) as any);
      // PID is alive...
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);
      // ...but it's now an unrelated process (PID was recycled by the OS).
      execFileSyncMock.mockReturnValue('/usr/sbin/sshd -D\n');

      restoreRemoteControl();

      // Must refuse to adopt and must clear the stale state so the recycled
      // PID is never controlled or SIGTERM'd.
      expect(getActiveSession()).toBeNull();
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });

    it('does not adopt when the process identity cannot be determined (ps fails)', () => {
      const session = {
        pid: 77777,
        url: 'https://claude.ai/code?bridge=env_unknown',
        startedBy: 'user1',
        startedInChat: 'tg:123',
        startedAt: '2026-01-01T00:00:00.000Z',
      };
      readFileSyncSpy.mockImplementation(((p: string) => {
        if (p.endsWith('remote-control.json')) return JSON.stringify(session);
        return '';
      }) as any);
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);
      // ps throws (or yields nothing) — identity unconfirmed → do not adopt.
      execFileSyncMock.mockImplementation(() => {
        throw new Error('ps failed');
      });

      restoreRemoteControl();

      expect(getActiveSession()).toBeNull();
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });

    it('verifies process identity via ps before adopting', () => {
      const session = {
        pid: 77777,
        url: 'https://claude.ai/code?bridge=env_verify',
        startedBy: 'user1',
        startedInChat: 'tg:123',
        startedAt: '2026-01-01T00:00:00.000Z',
      };
      readFileSyncSpy.mockImplementation(((p: string) => {
        if (p.endsWith('remote-control.json')) return JSON.stringify(session);
        return '';
      }) as any);
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      restoreRemoteControl();

      // Adopted (default ps command is a genuine claude remote-control proc)...
      expect(getActiveSession()).not.toBeNull();
      // ...and identity was actually checked against the recorded PID via ps.
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'ps',
        ['-p', '77777', '-o', 'command='],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('clears state on corrupted JSON', () => {
      readFileSyncSpy.mockImplementation(((p: string) => {
        if (p.endsWith('remote-control.json')) return 'not json{{{';
        return '';
      }) as any);

      restoreRemoteControl();

      expect(getActiveSession()).toBeNull();
      expect(unlinkSyncSpy).toHaveBeenCalled();
    });

    // ** This is the key integration test: restore → stop must work **
    it('stopRemoteControl works after restoreRemoteControl', () => {
      const session = {
        pid: 77777,
        url: 'https://claude.ai/code?bridge=env_restored',
        startedBy: 'user1',
        startedInChat: 'tg:123',
        startedAt: '2026-01-01T00:00:00.000Z',
      };
      readFileSyncSpy.mockImplementation(((p: string) => {
        if (p.endsWith('remote-control.json')) return JSON.stringify(session);
        return '';
      }) as any);
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((() => true) as any);

      restoreRemoteControl();
      expect(getActiveSession()).not.toBeNull();

      const result = stopRemoteControl();
      expect(result).toEqual({ ok: true });
      // Detached child → group-kill via negative PID (see stopRemoteControl).
      expect(killSpy).toHaveBeenCalledWith(-77777, 'SIGTERM');
      expect(unlinkSyncSpy).toHaveBeenCalled();
      expect(getActiveSession()).toBeNull();
    });

    it('startRemoteControl returns restored URL without spawning', () => {
      const session = {
        pid: 77777,
        url: 'https://claude.ai/code?bridge=env_restored',
        startedBy: 'user1',
        startedInChat: 'tg:123',
        startedAt: '2026-01-01T00:00:00.000Z',
      };
      readFileSyncSpy.mockImplementation(((p: string) => {
        if (p.endsWith('remote-control.json')) return JSON.stringify(session);
        return '';
      }) as any);
      vi.spyOn(process, 'kill').mockImplementation((() => true) as any);

      restoreRemoteControl();

      return startRemoteControl('user2', 'tg:456', '/project').then(
        (result) => {
          expect(result).toEqual({
            ok: true,
            url: 'https://claude.ai/code?bridge=env_restored',
          });
          expect(spawnMock).not.toHaveBeenCalled();
        },
      );
    });
  });
});
