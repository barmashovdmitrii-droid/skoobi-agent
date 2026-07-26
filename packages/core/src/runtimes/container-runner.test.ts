import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---CLAUDECLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CLAUDECLAW_OUTPUT_END---';
const CONTAINER_GUEST_HOME = ['/home', 'node'].join('/');
const CONTAINER_GUEST_CLAUDE_HOME = `${CONTAINER_GUEST_HOME}/.claude`;

// Mock config
vi.mock('../orchestrator/config.js', () => ({
  CONTAINER_IMAGE: 'claudeclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 1024,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/claudeclaw-test-data',
  GROUPS_DIR: '/tmp/claudeclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('../orchestrator/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      lstatSync: vi.fn(() => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
      })),
      realpathSync: vi.fn((candidate: string) => candidate),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
      rmSync: vi.fn(),
      openSync: vi.fn(() => 41),
      fstatSync: vi.fn(() => ({ isFile: () => true })),
      writeSync: vi.fn(
        (_fd: number, _buffer: Buffer, _offset: number, length: number) =>
          length,
      ),
      closeSync: vi.fn(),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('../orchestrator/mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

vi.mock('../orchestrator/credential-proxy.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../orchestrator/credential-proxy.js')
    >();
  return {
    ...actual,
    revokeCredentialProxyIdentityToken: vi.fn(
      actual.revokeCredentialProxyIdentityToken,
    ),
  };
});

import { exec, spawn } from 'child_process';
import { revokeCredentialProxyIdentityToken } from '../orchestrator/credential-proxy.js';
import { logger } from '../orchestrator/logger.js';
import {
  runContainerAgent,
  buildVolumeMounts,
  containerCredentialEnvironmentValues,
  createRedactedDiagnosticLineBuffer,
  redactContainerRuntimeDiagnostics,
  restrictRuntimeInputToAuthorizedTier,
  ContainerOutput,
} from './container-runner.js';
import type { RegisteredGroup } from '../orchestrator/types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@skoobi_bot',
  added_at: new Date().toISOString(),
};

describe('container runtime diagnostic redaction', () => {
  it('removes exact short secrets, capabilities, bearer tokens, and proxy identity headers', () => {
    const raw = [
      'abc',
      'ANTHROPIC_API_KEY=proxy-secret',
      'Authorization: Bearer live-token',
      '"taskAuthorizationCapability":"capability-value"',
      '"codexControlRunId":"00000000-0000-4000-8000-000000000004"',
      'x-skoobi-credential-proxy-identity: signed-identity',
    ].join('\n');
    const redacted = redactContainerRuntimeDiagnostics(raw, [
      'abc',
      'proxy-secret',
      'capability-value',
    ]);
    for (const secret of [
      'abc',
      'proxy-secret',
      'live-token',
      'capability-value',
      'signed-identity',
      '00000000-0000-4000-8000-000000000004',
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('[REDACTED]');
  });

  it('does not classify benign runtime env values as credentials', () => {
    expect(
      containerCredentialEnvironmentValues([
        'run',
        '-e',
        'TZ=Asia/Almaty',
        '-e',
        'RUN_UID=501',
        '-e',
        `HOME=${CONTAINER_GUEST_HOME}`,
        '-e',
        'ANTHROPIC_API_KEY=proxy-secret',
        '-e',
        'PLUGIN_TOKEN=plugin-secret',
      ]),
    ).toEqual(['proxy-secret', 'plugin-secret']);
    const benignDiagnostic = `Asia/Almaty uid 501 ${CONTAINER_GUEST_HOME}`;
    expect(
      redactContainerRuntimeDiagnostics(benignDiagnostic, ['proxy-secret']),
    ).toBe(benignDiagnostic);
  });

  it('buffers split exact secrets until a whole redacted diagnostic line exists', () => {
    const lines: string[] = [];
    const buffer = createRedactedDiagnosticLineBuffer(
      ['split-run-capability'],
      (line) => lines.push(line),
      128,
    );
    buffer.push('before split-run-');
    expect(lines).toEqual([]);
    buffer.push('capability after\n');
    expect(lines).toEqual(['before [REDACTED] after']);
  });

  it('drops an overlong unterminated diagnostic instead of logging a partial secret', () => {
    const lines: string[] = [];
    const buffer = createRedactedDiagnosticLineBuffer(
      ['long-secret'],
      (line) => lines.push(line),
      8,
    );
    buffer.push('long-');
    buffer.push('secret-and-more');
    buffer.flush();
    expect(lines).toEqual([]);
  });
});

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

function latestCredentialProxyIdentityToken(): string {
  const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
  const customHeaderEnv = args.find((arg) =>
    arg.startsWith('ANTHROPIC_CUSTOM_HEADERS='),
  );
  expect(customHeaderEnv).toBeDefined();
  return customHeaderEnv!.split(': ', 2)[1];
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(exec).mockClear();
    vi.mocked(revokeCredentialProxyIdentityToken).mockClear();
    // Restore the default exec behavior (one test overrides it to simulate a
    // failed graceful stop) so test ordering can't leak the override.
    vi.mocked(exec).mockImplementation(((
      _cmd: string,
      _opts: unknown,
      cb?: (err: Error | null) => void,
    ) => {
      if (cb) cb(null);
      return new EventEmitter();
    }) as unknown as typeof exec);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('fails closed on an oversized unterminated streamed frame', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      vi.fn(async () => {}),
    );
    fakeProc.stdout.push(`${OUTPUT_START_MARKER}${'x'.repeat(1025)}`);
    fakeProc.emit('close', 0);
    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/frame exceeded 1024/i);
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('escalates by name (kill + rm -f) and verifies removal when graceful stop fails', async () => {
    // Record every exec'd command, and make the graceful `container stop` fail
    // so the timeout fallback must escalate. `container ls` returns the
    // container as still-present so the orphan-warning path is also exercised.
    const execCommands: string[] = [];
    const stopError = new Error('stop timed out');
    vi.mocked(exec).mockImplementation(((
      cmd: string,
      _opts: unknown,
      cb?: (err: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      execCommands.push(cmd);
      if (cb) {
        if (cmd.includes(' stop ')) {
          cb(stopError);
        } else if (cmd.includes(' ls')) {
          // Report the container as still present after the force kill so the
          // orphan-warning path is exercised.
          cb(
            null,
            JSON.stringify([
              { status: 'running', configuration: { id: 'KILL_TARGET' } },
            ]),
          );
        } else {
          cb(null);
        }
      }
      return new EventEmitter();
    }) as unknown as typeof exec);

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout to trigger killOnTimeout.
    await vi.advanceTimersByTimeAsync(1830000);
    // Let the chained exec callbacks (stop -> kill -> rm -f -> ls) settle.
    await vi.advanceTimersByTimeAsync(10);

    // Graceful stop was attempted first.
    expect(execCommands.some((c) => /\bstop\b/.test(c))).toBe(true);
    // After stop failed, the workload is killed and removed BY NAME against the
    // runtime (not just the local client PID), then removal is verified.
    const killByName = execCommands.find((c) => /\bkill\b/.test(c));
    const rmByName = execCommands.find((c) => /\brm -f\b/.test(c));
    const verifyLs = execCommands.find((c) => /\bls\b/.test(c));
    expect(killByName).toBeDefined();
    expect(rmByName).toBeDefined();
    expect(verifyLs).toBeDefined();
    // Escalation targets the container name, not the foreground client process.
    expect(killByName).toMatch(/claudeclaw-test-group-\d+/);
    expect(rmByName).toMatch(/claudeclaw-test-group-\d+/);
    // The foreground client is still SIGKILLed so its stdio pipes close.
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');

    // Drain the promise so the test doesn't leak an unresolved run.
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('revokes the run on close before slow output persistence settles', async () => {
    let releaseOutput!: () => void;
    const onOutput = vi.fn(
      () => new Promise<void>((resolve) => (releaseOutput = resolve)),
    );
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );
    const token = latestCredentialProxyIdentityToken();

    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    expect(onOutput).toHaveBeenCalledTimes(1);

    fakeProc.emit('close', 0);
    expect(revokeCredentialProxyIdentityToken).toHaveBeenCalledWith(token);

    releaseOutput();
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('revokes the run immediately on a spawn error', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    const token = latestCredentialProxyIdentityToken();

    fakeProc.emit('error', new Error('spawn failed'));
    expect(revokeCredentialProxyIdentityToken).toHaveBeenCalledWith(token);
    expect((await resultPromise).status).toBe('error');
  });

  it('revokes and removes the spawned container when onProcess throws', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {
      throw new Error('onProcess fixture failure');
    });
    const token = latestCredentialProxyIdentityToken();
    const result = await resultPromise;

    expect(result.status).toBe('error');
    expect(result.error).toContain('onProcess fixture failure');
    expect(revokeCredentialProxyIdentityToken).toHaveBeenCalledWith(token);
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.mocked(exec).mock.calls.map(([command]) => command)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\bkill\b/),
        expect.stringMatching(/\brm -f\b/),
      ]),
    );
  });

  it('revokes and removes the spawned container when stdin.write throws', async () => {
    fakeProc.stdin.write = vi.fn(() => {
      throw new Error('stdin write fixture failure');
    }) as unknown as typeof fakeProc.stdin.write;
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    const token = latestCredentialProxyIdentityToken();
    const result = await resultPromise;

    expect(result.status).toBe('error');
    expect(result.error).toContain('stdin write fixture failure');
    expect(revokeCredentialProxyIdentityToken).toHaveBeenCalledWith(token);
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('handles asynchronous stdin EPIPE without leaking authority or a container', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    const token = latestCredentialProxyIdentityToken();
    const error = Object.assign(new Error('stdin fixture EPIPE'), {
      code: 'EPIPE',
    });
    fakeProc.stdin.emit('error', error);
    const result = await resultPromise;

    expect(result.status).toBe('error');
    expect(result.error).toContain('EPIPE');
    expect(revokeCredentialProxyIdentityToken).toHaveBeenCalledWith(token);
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('redacts a run token split across stderr chunks and omits malformed-frame snippets', async () => {
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.warn).mockClear();
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      vi.fn(async () => {}),
    );
    const token = latestCredentialProxyIdentityToken();
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.warn).mockClear();
    const splitAt = Math.floor(token.length / 2);
    fakeProc.stderr.push(token.slice(0, splitAt));
    expect(logger.debug).not.toHaveBeenCalled();
    fakeProc.stderr.push(`${token.slice(splitAt)}\n`);
    fakeProc.stdout.push(`${OUTPUT_START_MARKER}${token}${OUTPUT_END_MARKER}`);
    fakeProc.emit('close', 0);
    await resultPromise;

    const diagnostics = JSON.stringify([
      vi.mocked(logger.debug).mock.calls,
      vi.mocked(logger.warn).mock.calls,
    ]);
    expect(diagnostics).toContain('[REDACTED]');
    expect(diagnostics).toContain('Invalid JSON output frame');
    expect(diagnostics).not.toContain(token);
    expect(diagnostics).not.toContain(token.slice(0, 16));
  });

  it('returns a generic legacy parse error without echoing malformed secret input', async () => {
    vi.mocked(logger.error).mockClear();
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    const token = latestCredentialProxyIdentityToken();
    fakeProc.stdout.push(`${OUTPUT_START_MARKER}${token}${OUTPUT_END_MARKER}`);
    fakeProc.emit('close', 0);
    const result = await resultPromise;

    expect(result.status).toBe('error');
    expect(result.error).toBe(
      'Failed to parse container output: Invalid JSON output frame',
    );
    expect(result.error).not.toContain(token.slice(0, 16));
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      token.slice(0, 16),
    );
  });

  it.each([
    [false, undefined, undefined, 'guest', 'test-group'],
    [true, undefined, undefined, 'guest', 'test-group'],
    [true, 'owner', 'tg_chat_100000001', 'owner', 'tg_chat_100000001'],
  ] as const)(
    'plants only the explicit host-derived proxy tier in every container request',
    async (
      isMain,
      credentialProxyTier,
      tenantId,
      expectedTier,
      expectedTenant,
    ) => {
      const resultPromise = runContainerAgent(
        testGroup,
        { ...testInput, isMain, credentialProxyTier, tenantId },
        () => {},
      );
      const token = latestCredentialProxyIdentityToken();
      const encodedPayload = token.split('.', 1)[0];
      const payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      );
      expect(payload).toEqual(
        expect.objectContaining({
          v: 2,
          tier: expectedTier,
          tenantId: expectedTenant,
          runNonce: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
          expiresAt: expect.any(Number),
        }),
      );

      fakeProc.emit('close', 1);
      expect(revokeCredentialProxyIdentityToken).toHaveBeenCalledWith(token);
      await vi.advanceTimersByTimeAsync(10);
      await resultPromise;
    },
  );
});

describe('buildVolumeMounts skills isolation (ultra-review #3)', () => {
  const skillsMount = (isMain: boolean, tier: 'owner' | 'guest' = 'guest') =>
    buildVolumeMounts(testGroup, isMain, undefined, tier).find(
      (m) => m.containerPath === '/workspace/skills',
    );

  it('mounts the shared data/skills dir READ-ONLY for a non-main (guest) group', () => {
    // A guest must not be able to write an active SKILL.md that would be injected
    // into the trusted main agent's prompt (bypassing propose→approve).
    expect(skillsMount(false)?.readonly).toBe(true);
  });

  it('keeps data/skills writable for MAIN so the operator can curate skills', () => {
    expect(skillsMount(true, 'owner')?.readonly).toBe(false);
  });
});

describe('buildVolumeMounts IPC category isolation', () => {
  function ipcMounts(isMain: boolean, tier: 'owner' | 'guest' = 'guest') {
    return buildVolumeMounts(testGroup, isMain, undefined, tier).filter(
      (mount) => mount.containerPath.startsWith('/workspace/ipc'),
    );
  }

  it('gives a guest writable public categories but masks owner Google IPC', () => {
    const mounts = ipcMounts(false);
    expect(
      mounts.map((mount) => [mount.containerPath, mount.readonly]),
    ).toEqual([
      ['/workspace/ipc', true],
      ['/workspace/ipc/messages', false],
      ['/workspace/ipc/tasks', false],
      ['/workspace/ipc/swe', false],
      ['/workspace/ipc/memory', false],
      ['/workspace/ipc/input', false],
      ['/workspace/ipc/google', true],
    ]);
    expect(mounts.at(-1)?.hostPath).toContain('runtime-denied-google-ipc');
  });

  it('keeps the trusted main IPC root writable without narrowing owner extensions', () => {
    expect(
      ipcMounts(true, 'owner').map((mount) => [
        mount.containerPath,
        mount.readonly,
      ]),
    ).toEqual([['/workspace/ipc', false]]);
  });
});

describe('received-media runtime isolation', () => {
  it('mounts received read-only after the writable group for every guest tier', () => {
    const mounts = buildVolumeMounts(testGroup, true, undefined, 'guest');
    const groupIndex = mounts.findIndex(
      (mount) => mount.containerPath === '/workspace/group',
    );
    const receivedIndex = mounts.findIndex(
      (mount) => mount.containerPath === '/workspace/group/received',
    );
    expect(groupIndex).toBeGreaterThanOrEqual(0);
    expect(receivedIndex).toBeGreaterThan(groupIndex);
    expect(mounts[receivedIndex].readonly).toBe(true);
    expect(
      mounts.find((mount) => mount.containerPath === '/workspace/project'),
    ).toBeUndefined();
  });

  it('fails closed when received is a symlink', () => {
    vi.mocked(fs.lstatSync)
      .mockImplementationOnce(
        () =>
          ({
            isDirectory: () => true,
            isSymbolicLink: () => false,
          }) as any,
      )
      .mockImplementationOnce(
        () =>
          ({
            isDirectory: () => true,
            isSymbolicLink: () => true,
          }) as any,
      );
    expect(() =>
      buildVolumeMounts(testGroup, false, undefined, 'guest'),
    ).toThrow('Unsafe runtime received directory');
  });

  it('downgrades a co-member main run and clears runner full-access flags', () => {
    const input = {
      ...testInput,
      isMain: true,
      credentialProxyTier: 'guest' as const,
      sessionId: 'owner-session-must-not-resume',
      codexGuiControlAuthorized: true,
      googleSheetTargetHints: [
        {
          label: 'ledger',
          spreadsheetId: 'public-fixture-spreadsheet-id-0001',
          range: "'Лист1'!A47:G1000",
          columnCount: 7,
          maxRowsPerCall: 1,
        },
      ],
      agentConfig: { fullAccess: true, noSandbox: true, model: 'test-model' },
    };
    const restricted = restrictRuntimeInputToAuthorizedTier(input);
    expect(restricted).toMatchObject({
      isMain: false,
      credentialProxyTier: 'guest',
      codexGuiControlAuthorized: false,
      agentConfig: {
        fullAccess: false,
        noSandbox: false,
        model: 'test-model',
      },
    });
    expect(input.agentConfig.fullAccess).toBe(true);
    expect(restricted.sessionId).toBeUndefined();
    expect(restricted.googleSheetTargetHints).toBeUndefined();
  });

  it('does not clear a normal non-main guest session', () => {
    const restricted = restrictRuntimeInputToAuthorizedTier({
      ...testInput,
      sessionId: 'tenant-session',
      credentialProxyTier: 'guest',
    });
    expect(restricted.sessionId).toBe('tenant-session');
  });

  it('downgrades indirect Telegram identity and never mounts its user memory', () => {
    const forwardedIdentity = {
      channel: 'telegram' as const,
      chat_id: '42',
      telegram_user_id: '42',
      identity_id: 'owner-42',
      is_owner_sender: true,
      telegram_message_origin: 'forwarded' as const,
    };
    const restricted = restrictRuntimeInputToAuthorizedTier({
      ...testInput,
      chatJid: 'tg:42',
      isMain: true,
      credentialProxyTier: 'owner',
      senderIdentity: forwardedIdentity,
    });
    expect(restricted).toMatchObject({
      isMain: false,
      credentialProxyTier: 'guest',
      senderIdentity: undefined,
    });
    expect(
      buildVolumeMounts(
        testGroup,
        true,
        forwardedIdentity,
        'guest',
        'tg:42',
      ).some((mount) => mount.containerPath === '/workspace/user-memory'),
    ).toBe(false);

    const directIdentity = {
      ...forwardedIdentity,
      telegram_message_origin: 'direct' as const,
    };
    expect(
      buildVolumeMounts(
        testGroup,
        false,
        directIdentity,
        'guest',
        'tg:42',
      ).find((mount) => mount.containerPath === '/workspace/user-memory'),
    ).toMatchObject({ readonly: false });
  });
});

describe('downgraded multi-sender main namespace', () => {
  const isolatedRoot = '/tmp/claudeclaw-test-data/untrusted-main/test-group';

  function downgradedMounts() {
    return buildVolumeMounts(
      { ...testGroup, isMain: true },
      true,
      undefined,
      'guest',
      'tg:-1001234567890',
    );
  }

  it('mounts only isolated writable workspace/HOME and canonical received RO', () => {
    const mounts = downgradedMounts();
    expect(
      mounts.find((mount) => mount.containerPath === '/workspace/group'),
    ).toMatchObject({
      hostPath: `${isolatedRoot}/workspace`,
      readonly: false,
    });
    expect(
      mounts.find((mount) => mount.containerPath === CONTAINER_GUEST_HOME),
    ).toMatchObject({ hostPath: `${isolatedRoot}/home`, readonly: false });
    expect(
      mounts.find(
        (mount) => mount.containerPath === '/workspace/group/received',
      ),
    ).toMatchObject({ readonly: true });
    expect(
      mounts.find(
        (mount) => mount.containerPath === '/workspace/canonical-group',
      ),
    ).toBeUndefined();
    expect(
      mounts.some(
        (mount) =>
          mount.hostPath ===
          '/tmp/claudeclaw-test-data/sessions/test-group/.claude',
      ),
    ).toBe(false);
  });

  it('refreshes isolated runner source on every run, so guest poisoning cannot persist', () => {
    vi.mocked(fs.rmSync).mockClear();
    downgradedMounts();
    downgradedMounts();
    const runnerRefreshes = vi
      .mocked(fs.rmSync)
      .mock.calls.filter(
        ([candidate]) => candidate === `${isolatedRoot}/agent-runner-src`,
      );
    expect(runnerRefreshes).toEqual([
      [`${isolatedRoot}/agent-runner-src`, { recursive: true, force: true }],
      [`${isolatedRoot}/agent-runner-src`, { recursive: true, force: true }],
    ]);
    expect(
      downgradedMounts().find((mount) => mount.containerPath === '/app/src'),
    ).toMatchObject({
      hostPath: `${isolatedRoot}/agent-runner-src`,
      readonly: false,
    });
  });

  it('reclaims a poisoned isolated received mount target as a real directory', () => {
    const receivedTarget = `${isolatedRoot}/workspace/received`;
    const lstat = vi.mocked(fs.lstatSync);
    const previous = lstat.getMockImplementation();
    let sawPoison = false;
    lstat.mockImplementation(((candidate: fs.PathLike) => {
      if (String(candidate) === receivedTarget && !sawPoison) {
        sawPoison = true;
        return {
          isDirectory: () => false,
          isSymbolicLink: () => true,
        } as fs.Stats;
      }
      return {
        isDirectory: () => true,
        isSymbolicLink: () => false,
      } as fs.Stats;
    }) as typeof fs.lstatSync);
    try {
      vi.mocked(fs.rmSync).mockClear();
      downgradedMounts();
      expect(fs.rmSync).toHaveBeenCalledWith(receivedTarget, {
        recursive: true,
        force: true,
      });
    } finally {
      if (previous) lstat.mockImplementation(previous);
    }
  });

  it('keeps an owner-authorized main run on the canonical paths', () => {
    const mounts = buildVolumeMounts(
      { ...testGroup, isMain: true },
      true,
      undefined,
      'owner',
      'tg:-1001234567890',
    );
    expect(
      mounts.find((mount) => mount.containerPath === '/workspace/group'),
    ).not.toMatchObject({ hostPath: `${isolatedRoot}/workspace` });
    expect(
      mounts.find(
        (mount) => mount.containerPath === CONTAINER_GUEST_CLAUDE_HOME,
      ),
    ).toMatchObject({
      hostPath: '/tmp/claudeclaw-test-data/sessions/test-group/.claude',
      readonly: false,
    });
  });
});
