import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger before any imports that use it
vi.mock('../orchestrator/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process
const mockExecFileSync = vi.fn();
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
    spawn: vi.fn(),
  };
});

// Mock group-folder
vi.mock('../orchestrator/group-folder.js', () => ({
  assertValidGroupFolder: (folder: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(folder)) {
      throw new Error(`Invalid group folder "${folder}"`);
    }
  },
  resolveGroupFolderPath: (folder: string) => `/tmp/test-groups/${folder}`,
  resolveGroupIpcPath: (folder: string) => `/tmp/test-ipc/${folder}`,
}));

// Mock mount-security
vi.mock('../orchestrator/mount-security.js', () => ({
  validateAdditionalMounts: vi.fn().mockReturnValue([]),
}));

// Mock the .env secret reader so runSandboxAgent's secret injection is
// deterministic (and so HELPER_SECRET gating can be asserted without a real
// .env file). Use an obvious placeholder — never a real-shaped token.
// Default to an empty object (not undefined): config.ts calls readEnvFile() at
// module load and dereferences the result (envConfig.ASSISTANT_NAME), so a
// bare vi.fn() returning undefined would crash the whole module on import.
const { mockReadEnvFile } = vi.hoisted(() => ({
  mockReadEnvFile: vi.fn(
    (..._args: unknown[]) => ({}) as Record<string, string>,
  ),
}));
vi.mock('../orchestrator/env.js', () => ({
  readEnvFile: (...args: unknown[]) => mockReadEnvFile(...args),
}));

// Mock extension-loader so runSandboxAgent doesn't load real extensions.
vi.mock('../orchestrator/extension-loader.js', () => ({
  getExtensionAllowedDomains: vi.fn().mockReturnValue([]),
}));

import { spawn, spawnSync } from 'child_process';
import { EventEmitter } from 'events';

import {
  assertValidSandboxSettings,
  applyIsolatedObserverCodexHomeCarveOut,
  assertIsolatedObserverCodexHomeCarveOut,
  assertIsolatedObserverCodexHomeSeatbeltPolicy,
  buildSandboxArgs,
  buildSandboxSettings,
  isSandboxSafeDomain,
  ensureSandboxRuntimeAvailable,
  cleanupSandboxOrphans,
  cleanupStaleSandboxSettings,
  isClaudeclawSandboxProcess,
  resolveNoOutputTimeoutMs,
  resolveProgressTimeoutMs,
  DEFAULT_NO_OUTPUT_TIMEOUT_MS,
  DEFAULT_PROGRESS_TIMEOUT_MS,
  killProcessTree,
  deriveSandboxMountRoot,
  computeProjectChainSiblingDenyPaths,
  assertGuestSandboxExecWrapperSafe,
  buildGuestMacSeatbeltPolicy,
  collectGuestSeatbeltHostReadRoots,
  collectGuestSeatbeltAllowedSubtrees,
  encodeGuestSeatbeltPolicy,
  GUEST_MAC_SHARED_READ_ROOTS,
  GUEST_SANDBOX_EXEC_WRAPPER_DIR,
  GUEST_SEATBELT_POLICY_ENV,
  runSandboxAgent,
  buildSandboxMounts,
  prepareCodexHomeForRun,
  cleanupCodexAuth,
  persistTrustedCodexAuthRefresh,
  shouldPersistCodexAuthRefresh,
  buildSandboxCredentialProxyEnv,
  closeSandboxCredentialProxyServer,
  GUEST_CODEX_PROVIDER_BLOCKED,
  redactSandboxOutput,
  sandboxChildBaseEnv,
  sandboxProviderIsolationError,
  CODEX_SANDBOX_DOMAINS,
} from './sandbox-runner.js';
import { CONTAINER_MAX_OUTPUT_SIZE, DATA_DIR } from '../orchestrator/config.js';
import { restrictRuntimeInputToAuthorizedTier } from './container-runner.js';
import { logger } from '../orchestrator/logger.js';
import { notifyRunIpcActivity } from '../orchestrator/run-activity.js';
import type { RegisteredGroup } from '../orchestrator/types.js';
import {
  ensureSafeGuestRuntimeDirectory,
  prepareRuntimeClaudeHome,
  type ContainerInput,
  type ContainerOutput,
} from './container-runner.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const MAC_EXAMPLE_HOME = ['/Users', 'example'].join('/');
const MAC_OTHER_HOME = ['/Users', 'you'].join('/');
const MAC_USERNAME_HOME = ['/Users', 'username'].join('/');
const LINUX_SKOOBI_HOME = ['/home', 'skoobi'].join('/');
const LINUX_EXAMPLE_HOME = ['/home', 'example'].join('/');
const LINUX_USER_HOME = ['/home', 'user'].join('/');
const SANDBOX_GUEST_HOME = ['/home', 'node'].join('/');

beforeEach(() => {
  vi.clearAllMocks();
  // Default: secrets present (incl. HELPER_SECRET) so gating-by-isMain is the
  // only thing deciding whether they reach the child env.
  mockReadEnvFile.mockReturnValue({
    ANTHROPIC_API_KEY: 'FAKE-KEY',
    HELPER_SECRET: 'FAKE-HELPER-SECRET',
    HELPER_PORT: '3200',
  });
});

// ---------------------------------------------------------------------------
// A minimal fake ChildProcess for driving runSandboxAgent without spawning a
// real sandbox. stdout/stderr/the child itself are EventEmitters; stdin is a
// write/end stub that also emits 'error'.
// ---------------------------------------------------------------------------
class FakeChild extends EventEmitter {
  pid = 4242;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

const OUTPUT_START = '---CLAUDECLAW_OUTPUT_START---';
const OUTPUT_END = '---CLAUDECLAW_OUTPUT_END---';

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: 'bot',
    added_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeInput(overrides: Partial<ContainerInput> = {}): ContainerInput {
  return {
    prompt: 'hi',
    groupFolder: 'test-group',
    chatJid: 'chat-1',
    isMain: false,
    ...overrides,
  };
}

describe('ensureSandboxRuntimeAvailable', () => {
  it('verifies sandbox-runtime is installed', () => {
    mockExecFileSync.mockReturnValueOnce('1.0.0');
    ensureSandboxRuntimeAvailable();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringMatching(
          /node_modules[/\\]@anthropic-ai[/\\]sandbox-runtime[/\\]dist[/\\]cli\.js$/,
        ),
        '--version',
      ],
      expect.any(Object),
    );
  });

  it('throws if sandbox-runtime not found', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('not found');
    });
    expect(() => ensureSandboxRuntimeAvailable()).toThrow(
      'sandbox-runtime is required but not installed',
    );
  });
});

describe('buildSandboxSettings', () => {
  it('puts readonly mounts in allowRead and denyWrite', () => {
    const settings = buildSandboxSettings([
      {
        hostPath: '/host/project',
        containerPath: '/workspace/project',
        readonly: true,
      },
    ]);
    expect(settings.filesystem.allowRead).toContain('/host/project');
    expect(settings.filesystem.allowWrite).not.toContain('/host/project');
    expect(settings.filesystem.denyWrite).toContain('/host/project');
  });

  it('puts writable mounts in allowWrite', () => {
    const settings = buildSandboxSettings([
      {
        hostPath: '/host/group',
        containerPath: '/workspace/group',
        readonly: false,
      },
    ]);
    expect(settings.filesystem.allowWrite).toContain('/host/group');
  });

  it('puts deny mounts in both denyRead and denyWrite', () => {
    const settings = buildSandboxSettings([
      {
        hostPath: '/host/project/.env',
        containerPath: '/workspace/project/.env',
        readonly: true,
        deny: true,
      },
    ]);
    expect(settings.filesystem.denyRead).toContain('/host/project/.env');
    expect(settings.filesystem.denyWrite).toContain('/host/project/.env');
  });

  it('allows Anthropic API and localhost for IPC', () => {
    const settings = buildSandboxSettings([]);
    expect(settings.network.allowedDomains).toContain('api.anthropic.com');
    expect(settings.network.allowedDomains).toContain('*.anthropic.com');
    expect(settings.network.allowedDomains).toContain('localhost');
    expect(settings.network.allowedDomains).toContain('127.0.0.1');
    expect(settings.network.allowLocalBinding).toBe(true);
  });

  it('has required deniedDomains field (even if empty)', () => {
    const settings = buildSandboxSettings([]);
    expect(settings.network.deniedDomains).toEqual([]);
  });

  it('merges extra allowed domains with base domains', () => {
    const settings = buildSandboxSettings(
      [],
      ['api.github.com', '*.github.com'],
    );
    expect(settings.network.allowedDomains).toContain('api.anthropic.com');
    expect(settings.network.allowedDomains).toContain('api.github.com');
    expect(settings.network.allowedDomains).toContain('*.github.com');
  });

  it('deduplicates domains', () => {
    const settings = buildSandboxSettings(
      [],
      ['api.anthropic.com', 'api.github.com'],
    );
    const count = settings.network.allowedDomains.filter(
      (d) => d === 'api.anthropic.com',
    ).length;
    expect(count).toBe(1);
  });

  it('drops overly-broad domains but keeps the API reachable (lockout regression)', () => {
    // A "*" / "*.com" smuggled into allowedDomains must NOT lock the agent out
    // of api.anthropic.com. Regression: ["*"] used to collapse the list so every
    // run failed with 403 "Connection blocked by network allowlist".
    const settings = buildSandboxSettings(
      [],
      ['*', '*.com', '*.google.com', 'drugs.com'],
    );
    expect(settings.network.allowedDomains).toContain('api.anthropic.com');
    expect(settings.network.allowedDomains).not.toContain('*');
    expect(settings.network.allowedDomains).not.toContain('*.com');
    expect(settings.network.allowedDomains).toContain('*.google.com');
    expect(settings.network.allowedDomains).toContain('drugs.com');
  });

  it('isSandboxSafeDomain accepts valid domains and 2+ label wildcards', () => {
    for (const d of [
      'example.com',
      'api.github.com',
      '*.google.com',
      '*.api.2gis.com',
      'sub.example.co.uk',
    ])
      expect(isSandboxSafeDomain(d)).toBe(true);
  });

  it('isSandboxSafeDomain rejects overly-broad / invalid patterns', () => {
    for (const d of ['*', '*.com', '', '*.', 'foo', 'a b'])
      expect(isSandboxSafeDomain(d)).toBe(false);
  });

  it('includes allowRead in filesystem (required by srt schema, even if empty)', () => {
    const settings = buildSandboxSettings([]);
    expect(settings.filesystem).toHaveProperty('allowRead');
    expect(settings.filesystem.allowRead).toEqual([]);
  });

  it('includes all required filesystem fields', () => {
    const settings = buildSandboxSettings([]);
    expect(settings.filesystem).toHaveProperty('denyRead');
    expect(settings.filesystem).toHaveProperty('allowRead');
    expect(settings.filesystem).toHaveProperty('allowWrite');
    expect(settings.filesystem).toHaveProperty('denyWrite');
  });

  it('handles multiple mounts of different types', () => {
    const settings = buildSandboxSettings([
      {
        hostPath: '/host/project',
        containerPath: '/workspace/project',
        readonly: true,
      },
      {
        hostPath: '/host/project/.env',
        containerPath: '/workspace/project/.env',
        readonly: true,
        deny: true,
      },
      {
        hostPath: '/host/group',
        containerPath: '/workspace/group',
        readonly: false,
      },
    ]);
    // H1: /host/project is NOT re-allowed (it contains the .env deny). It stays
    // readable via srt's allow-by-default base rule and non-writable via
    // denyWrite, while the nested .env deny actually takes effect.
    expect(settings.filesystem.allowRead).not.toContain('/host/project');
    expect(settings.filesystem.denyWrite).toContain('/host/project');
    expect(settings.filesystem.denyRead).toContain('/host/project/.env');
    expect(settings.filesystem.denyWrite).toContain('/host/project/.env');
    expect(settings.filesystem.allowWrite).toContain('/host/group');
  });

  // H1 regression: a readonly parent mount must NOT re-allow a nested deny.
  // srt emits allowRead AFTER denyRead and Seatbelt is last-match-wins, so a
  // project-root entry in allowRead would override the .env deny and leak it.
  it('does NOT re-allow a denied .env nested under a readonly project root (H1)', () => {
    const settings = buildSandboxSettings([
      {
        hostPath: '/host/project',
        containerPath: '/workspace/project',
        readonly: true,
      },
      {
        hostPath: '/host/project/.env',
        containerPath: '/workspace/project/.env',
        readonly: true,
        deny: true,
      },
    ]);
    // .env stays denied for reads and writes...
    expect(settings.filesystem.denyRead).toContain('/host/project/.env');
    expect(settings.filesystem.denyWrite).toContain('/host/project/.env');
    // ...and the project root is NOT in allowRead (which would override the
    // deny). Reads are allow-by-default in srt, so the project stays readable
    // via the base rule without the re-allow.
    expect(settings.filesystem.allowRead).not.toContain('/host/project');
    // The project root remains non-writable regardless.
    expect(settings.filesystem.denyWrite).toContain('/host/project');
  });

  it('preserves a legitimate re-allow nested INSIDE a denied parent', () => {
    // deny a broad parent, poke a hole for a child: the child re-allow must
    // survive (only allowRead entries that CONTAIN a deny are dropped).
    const settings = buildSandboxSettings([
      {
        hostPath: '/data/parent',
        containerPath: '/x',
        readonly: true,
        deny: true,
      },
      {
        hostPath: '/data/parent/child',
        containerPath: '/y',
        readonly: true,
      },
    ]);
    expect(settings.filesystem.denyRead).toContain('/data/parent');
    expect(settings.filesystem.allowRead).toContain('/data/parent/child');
  });

  // finding #72: an additional (/workspace/extra*) mount is guest-configurable
  // and only path-validated by mount-security. If its realpath lands inside a
  // cross-tenant subtree the runner denied (e.g. another group's data/ipc),
  // the last-match-wins allowRead would re-open that denied path. Extra-mount
  // re-allows nested inside a deny must be dropped, NOT preserved as a
  // hole-poke.
  it('drops an extra mount allowRead nested inside a cross-tenant deny (finding #72)', () => {
    const settings = buildSandboxSettings([
      {
        // cross-tenant deny the runner emits (denyDataChildren over data/ipc)
        hostPath: '/data/ipc/other-group',
        containerPath: '/data/ipc/other-group',
        readonly: true,
        deny: true,
      },
      {
        // guest extra mount whose realpath sits UNDER the denied subtree
        hostPath: '/data/ipc/other-group/secrets',
        containerPath: '/workspace/extra/leak',
        readonly: true,
      },
    ]);
    expect(settings.filesystem.denyRead).toContain('/data/ipc/other-group');
    expect(settings.filesystem.allowRead).not.toContain(
      '/data/ipc/other-group/secrets',
    );
  });

  // finding #72: an extra mount that does NOT overlap any deny is still a
  // normal readonly allowRead.
  it('keeps a non-overlapping extra mount in allowRead', () => {
    const settings = buildSandboxSettings([
      {
        hostPath: '/srv/shared/docs',
        containerPath: '/workspace/extra/docs',
        readonly: true,
      },
    ]);
    expect(settings.filesystem.allowRead).toContain('/srv/shared/docs');
  });

  it('drops an allowRead entry exactly equal to a denyRead entry', () => {
    const settings = buildSandboxSettings([
      { hostPath: '/p/secret', containerPath: '/a', readonly: true },
      {
        hostPath: '/p/secret',
        containerPath: '/b',
        readonly: true,
        deny: true,
      },
    ]);
    expect(settings.filesystem.allowRead).not.toContain('/p/secret');
    expect(settings.filesystem.denyRead).toContain('/p/secret');
  });

  it('keeps unrelated allowRead entries that do not contain a deny target', () => {
    const settings = buildSandboxSettings([
      {
        hostPath: '/host/global',
        containerPath: '/workspace/global',
        readonly: true,
      },
      {
        hostPath: '/host/project/.env',
        containerPath: '/e',
        readonly: true,
        deny: true,
      },
    ]);
    expect(settings.filesystem.allowRead).toContain('/host/global');
    expect(settings.filesystem.denyRead).toContain('/host/project/.env');
  });

  it('puts a writable per-group tmp mount in allowWrite (L13)', () => {
    const settings = buildSandboxSettings([
      {
        hostPath: '/data/sessions/g/tmp',
        containerPath: '/workspace/tmp',
        readonly: false,
      },
    ]);
    expect(settings.filesystem.allowWrite).toContain('/data/sessions/g/tmp');
  });
});

describe('isolated observer CODEX_HOME carve-out', () => {
  let root: string;
  let dataDir: string;
  let parent: string;
  let child: string;
  let sibling: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-codex-home-'));
    dataDir = path.join(root, 'data');
    parent = path.join(dataDir, 'codex-homes');
    child = path.join(parent, 'whatsapp_main');
    sibling = path.join(parent, 'telegram_main');
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const parentDenyMount = () => [
    {
      hostPath: parent,
      containerPath: parent,
      readonly: true,
      deny: true,
    },
  ];

  it('allows exactly one child read/write without an SRT parent deny', () => {
    const mounts = [
      ...parentDenyMount(),
      {
        hostPath: child,
        containerPath: '/stale-readonly-child',
        readonly: true,
      },
    ];
    applyIsolatedObserverCodexHomeCarveOut(mounts, child, dataDir, 'darwin');

    expect(mounts.filter((mount) => mount.hostPath === child)).toHaveLength(1);
    expect(mounts.find((mount) => mount.hostPath === child)).toMatchObject({
      containerPath: '/workspace/codex-home',
      readonly: false,
      allowRead: true,
    });

    const settings = buildSandboxSettings(mounts);
    expect(settings.filesystem.denyRead).not.toContain(parent);
    expect(settings.filesystem.allowRead).toContain(child);
    expect(settings.filesystem.allowWrite).toContain(child);
    expect(settings.filesystem.denyWrite).not.toContain(parent);
    expect(settings.filesystem.denyWrite).not.toContain(child);
    expect(settings.filesystem.allowRead).not.toContain(sibling);
    expect(settings.filesystem.allowWrite).not.toContain(sibling);
    expect(() =>
      assertIsolatedObserverCodexHomeCarveOut(
        settings,
        child,
        dataDir,
        'darwin',
      ),
    ).not.toThrow();

    const roots = collectGuestSeatbeltHostReadRoots('/srv/project', mounts);
    expect(roots).toContain(child);
    expect(roots).not.toContain(parent);
    expect(roots).not.toContain(sibling);
  });

  it('keeps the original parent read/write deny for normal guests', () => {
    const settings = buildSandboxSettings(parentDenyMount());
    expect(settings.filesystem.denyRead).toContain(parent);
    expect(settings.filesystem.denyWrite).toContain(parent);
    expect(settings.filesystem.allowRead).not.toContain(child);
    expect(settings.filesystem.allowWrite).not.toContain(child);
  });

  it('fails closed off macOS before applying any mount changes', () => {
    const mounts = parentDenyMount();
    const original = JSON.parse(JSON.stringify(mounts));
    expect(() =>
      applyIsolatedObserverCodexHomeCarveOut(mounts, child, dataDir, 'linux'),
    ).toThrow(/supported only on macOS/);
    expect(mounts).toEqual(original);
  });

  it('rejects traversal and symlink escapes before creating a carve-out', () => {
    const traversingChild = `${child}${path.sep}..${path.sep}${path.basename(
      sibling,
    )}`;
    expect(() =>
      applyIsolatedObserverCodexHomeCarveOut(
        parentDenyMount(),
        traversingChild,
        dataDir,
        'darwin',
      ),
    ).toThrow(/normalized and absolute/);

    const outside = path.join(root, 'outside-home');
    const linkedChild = path.join(parent, 'linked-home');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, linkedChild, 'dir');
    expect(() =>
      applyIsolatedObserverCodexHomeCarveOut(
        parentDenyMount(),
        linkedChild,
        dataDir,
        'darwin',
      ),
    ).toThrow(/real owner-prepared directory/);
  });

  it('rejects write-deny shadowing and any parent/sibling allow', () => {
    const mounts = parentDenyMount();
    applyIsolatedObserverCodexHomeCarveOut(mounts, child, dataDir, 'darwin');
    const settings = buildSandboxSettings(mounts);

    const readShadowed = structuredClone(settings);
    readShadowed.filesystem.denyRead.push(parent);
    expect(() =>
      assertIsolatedObserverCodexHomeCarveOut(
        readShadowed,
        child,
        dataDir,
        'darwin',
      ),
    ).toThrow(/shadowed by an SRT read deny/);

    const exactReadShadowed = structuredClone(settings);
    exactReadShadowed.filesystem.denyRead.push(child);
    expect(() =>
      assertIsolatedObserverCodexHomeCarveOut(
        exactReadShadowed,
        child,
        dataDir,
        'darwin',
      ),
    ).toThrow(/shadowed by an SRT read deny/);

    const shadowed = structuredClone(settings);
    shadowed.filesystem.denyWrite.push(parent);
    expect(() =>
      assertIsolatedObserverCodexHomeCarveOut(
        shadowed,
        child,
        dataDir,
        'darwin',
      ),
    ).toThrow(/shadowed by a write deny/);

    const exactWriteShadowed = structuredClone(settings);
    exactWriteShadowed.filesystem.denyWrite.push(child);
    expect(() =>
      assertIsolatedObserverCodexHomeCarveOut(
        exactWriteShadowed,
        child,
        dataDir,
        'darwin',
      ),
    ).toThrow(/shadowed by a write deny/);

    const siblingExposed = structuredClone(settings);
    siblingExposed.filesystem.allowRead.push(sibling);
    expect(() =>
      assertIsolatedObserverCodexHomeCarveOut(
        siblingExposed,
        child,
        dataDir,
        'darwin',
      ),
    ).toThrow(/exposes a parent or sibling/);

    const parentExposed = structuredClone(settings);
    parentExposed.filesystem.allowWrite.push(parent);
    expect(() =>
      assertIsolatedObserverCodexHomeCarveOut(
        parentExposed,
        child,
        dataDir,
        'darwin',
      ),
    ).toThrow(/exposes a parent or sibling/);
  });
});

describe('assertValidSandboxSettings (L11 fail-closed)', () => {
  // A schema-valid baseline mirroring what buildSandboxSettings produces.
  const valid = () => buildSandboxSettings([]);

  it('accepts a well-formed settings object', () => {
    expect(() => assertValidSandboxSettings(valid())).not.toThrow();
  });

  it('rejects an empty-string path (srt would fail OPEN to whole-host reads)', () => {
    const s = valid();
    s.filesystem.denyRead.push('');
    expect(() => assertValidSandboxSettings(s)).toThrow(/empty\/invalid path/);
  });

  it('rejects a non-array filesystem list', () => {
    const s = valid();
    // @ts-expect-error intentionally corrupting shape
    s.filesystem.allowWrite = 'oops';
    expect(() => assertValidSandboxSettings(s)).toThrow(/must be an array/);
  });

  it('rejects empty allowedDomains (no API reachability / clobbered policy)', () => {
    const s = valid();
    s.network.allowedDomains = [];
    expect(() => assertValidSandboxSettings(s)).toThrow(
      /allowedDomains must be a non-empty array/,
    );
  });

  it('rejects settings missing api.anthropic.com', () => {
    const s = valid();
    s.network.allowedDomains = ['localhost'];
    expect(() => assertValidSandboxSettings(s)).toThrow(/api\.anthropic\.com/);
  });

  it('rejects a missing filesystem section', () => {
    // Cast (not @ts-expect-error) so the deliberately-malformed shape survives
    // prettier reformatting without the directive drifting off its target line.
    const missingFs = {
      network: { allowedDomains: ['api.anthropic.com'] },
    } as unknown as Parameters<typeof assertValidSandboxSettings>[0];
    expect(() => assertValidSandboxSettings(missingFs)).toThrow(
      /missing filesystem/,
    );
  });
});

describe('buildSandboxArgs', () => {
  it('uses the installed CLI directly so npx cannot displace the guest PATH shim', () => {
    const args = buildSandboxArgs('/tmp/settings.json');
    expect(args[0]).toBe(process.execPath);
    expect(args[1]).toMatch(
      /node_modules\/@anthropic-ai\/sandbox-runtime\/dist\/cli\.js$/,
    );
    expect(args).not.toContain('npx');
    expect(args).toContain('--settings');
    expect(args).toContain('/tmp/settings.json');
    expect(args).toContain('--');
    expect(args).toContain('node');
    expect(args[args.length - 1]).toMatch(/agent\/runner\/dist\/index\.js$/);
  });
});

describe('killProcessTree', () => {
  it('kills the whole process group via negative PID', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = { pid: 4321, kill: vi.fn() };
    killProcessTree(child, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('falls back to a direct child kill if the group send throws', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const child = { pid: 4321, kill: vi.fn() };
    killProcessTree(child, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGKILL');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    killSpy.mockRestore();
  });

  it('kills the child directly when there is no pid', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = { pid: undefined, kill: vi.fn() };
    killProcessTree(child);
    expect(killSpy).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    killSpy.mockRestore();
  });

  it('never sends a group signal to pid <= 1 (would hit every process)', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = { pid: 1, kill: vi.fn() };
    killProcessTree(child, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    killSpy.mockRestore();
  });
});

// Read-confinement boundary for untrusted (non-main) groups. srt reads are
// allow-by-default across the whole host, so the only thing keeping a guest's
// Bash from reading arbitrary host paths is the sibling-walk that denies
// everything off the project chain. Regression target: that walk used to be
// gated on `while (parent.startsWith('/Users'))`, so on any non-/Users
// deployment (Linux /home, /opt, /srv) it produced ZERO denies and the guest
// could read the entire host.
describe('deriveSandboxMountRoot (read-confinement boundary)', () => {
  it('derives /Users as the boundary on macOS layouts', () => {
    expect(deriveSandboxMountRoot('/Users/example/my-assistant/cc')).toBe(
      '/Users',
    );
  });

  it('derives a generic top-level boundary on Linux layouts (NOT keyed on /Users)', () => {
    // These are exactly the deployments where the old `.startsWith('/Users')`
    // gate silently disabled confinement.
    expect(deriveSandboxMountRoot('/home/skoobi/claudeclaw')).toBe('/home');
    expect(deriveSandboxMountRoot('/opt/claudeclaw')).toBe('/opt');
    expect(deriveSandboxMountRoot('/srv/apps/claudeclaw')).toBe('/srv');
  });

  it('returns null only for a project at the filesystem root', () => {
    expect(deriveSandboxMountRoot('/')).toBeNull();
  });

  it('honors a configured boundary that actually contains the project', () => {
    expect(
      deriveSandboxMountRoot('/data/tenants/acme/cc', '/data/tenants'),
    ).toBe('/data/tenants');
  });

  it('ignores a configured boundary that does NOT contain the project (no weakening)', () => {
    // A misconfigured override must fall back to the safe derived default
    // rather than silently disabling confinement.
    expect(deriveSandboxMountRoot('/home/skoobi/cc', '/some/other/place')).toBe(
      '/home',
    );
  });

  it('ignores a configured boundary of the filesystem root (would never terminate)', () => {
    expect(deriveSandboxMountRoot('/home/skoobi/cc', '/')).toBe('/home');
  });
});

describe('computeProjectChainSiblingDenyPaths (off-chain reads denied)', () => {
  // A fake filesystem: directory -> entry names.
  const makeListDir =
    (tree: Record<string, string[]>) =>
    (dir: string): string[] => {
      if (!(dir in tree)) throw new Error(`ENOENT: ${dir}`);
      return tree[dir];
    };

  it('denies every sibling up the project chain on a macOS layout (regression)', () => {
    const projectRoot = '/Users/example/my-assistant/claudeclaw';
    const tree = {
      '/Users': ['example', 'you', 'username'],
      [MAC_EXAMPLE_HOME]: ['my-assistant', 'Desktop', 'Бухгалтерия'],
      '/Users/example/my-assistant': ['claudeclaw', 'other-project'],
    };
    const denies = computeProjectChainSiblingDenyPaths(
      projectRoot,
      deriveSandboxMountRoot(projectRoot),
      makeListDir(tree),
    );
    // Other users + owner's private dirs + sibling projects are denied...
    expect(denies).toContain(MAC_OTHER_HOME);
    expect(denies).toContain(MAC_USERNAME_HOME);
    expect(denies).toContain('/Users/example/Desktop');
    expect(denies).toContain('/Users/example/Бухгалтерия');
    expect(denies).toContain('/Users/example/my-assistant/other-project');
    // ...while the project chain itself is NEVER denied.
    expect(denies).not.toContain(MAC_EXAMPLE_HOME);
    expect(denies).not.toContain('/Users/example/my-assistant');
    expect(denies).not.toContain(projectRoot);
  });

  it('CONFINES reads on a Linux /home deployment where the old gate no-oped (the fix)', () => {
    const projectRoot = '/home/skoobi/claudeclaw';
    const tree = {
      '/home': ['skoobi', 'example', 'user'],
      [LINUX_SKOOBI_HOME]: ['claudeclaw', '.ssh', 'private-notes'],
    };
    const denies = computeProjectChainSiblingDenyPaths(
      projectRoot,
      deriveSandboxMountRoot(projectRoot),
      makeListDir(tree),
    );
    // The whole point: on /home this is now NON-EMPTY (was [] before the fix).
    expect(denies.length).toBeGreaterThan(0);
    expect(denies).toContain(LINUX_EXAMPLE_HOME); // another user's home
    expect(denies).toContain(LINUX_USER_HOME);
    expect(denies).toContain('/home/skoobi/.ssh'); // admin's own off-chain secrets
    expect(denies).toContain('/home/skoobi/private-notes');
    expect(denies).not.toContain(LINUX_SKOOBI_HOME); // project chain stays readable
    expect(denies).not.toContain(projectRoot);
  });

  it('confines reads on an /opt deployment too', () => {
    const projectRoot = '/opt/claudeclaw';
    const tree = { '/opt': ['claudeclaw', 'homebrew', 'secret-app'] };
    const denies = computeProjectChainSiblingDenyPaths(
      projectRoot,
      deriveSandboxMountRoot(projectRoot),
      makeListDir(tree),
    );
    expect(denies).toContain('/opt/homebrew');
    expect(denies).toContain('/opt/secret-app');
    expect(denies).not.toContain('/opt/claudeclaw');
  });

  it('never denies true top-level system dirs (would break the node/srt runtime)', () => {
    // The walk must stop at the boundary's children and NOT step up to deny
    // siblings of the boundary itself (/usr, /bin, /System, /private).
    const projectRoot = '/Users/example/claudeclaw';
    const listDir = (dir: string): string[] => {
      if (dir === '/')
        return ['Users', 'usr', 'bin', 'System', 'private', 'opt'];
      if (dir === '/Users') return ['example', 'you'];
      if (dir === MAC_EXAMPLE_HOME) return ['claudeclaw'];
      throw new Error(`ENOENT: ${dir}`);
    };
    const denies = computeProjectChainSiblingDenyPaths(
      projectRoot,
      deriveSandboxMountRoot(projectRoot),
      listDir,
    );
    for (const sys of ['/usr', '/bin', '/System', '/private', '/opt']) {
      expect(denies).not.toContain(sys);
    }
    expect(denies).toContain(MAC_OTHER_HOME);
  });

  it('returns [] for a null boundary (project at filesystem root)', () => {
    expect(
      computeProjectChainSiblingDenyPaths('/', null, () => {
        throw new Error('should not be called');
      }),
    ).toEqual([]);
  });

  it('tolerates a non-existent directory in the chain (treated as empty)', () => {
    const projectRoot = '/home/skoobi/cc';
    // The project-home readdir throws; the walk must not crash and should deny
    // siblings at the levels that DO exist.
    const listDir = (dir: string): string[] => {
      if (dir === '/home') return ['skoobi', 'user'];
      throw new Error(`ENOENT: ${dir}`);
    };
    const denies = computeProjectChainSiblingDenyPaths(
      projectRoot,
      deriveSandboxMountRoot(projectRoot),
      listDir,
    );
    expect(denies).toContain(LINUX_USER_HOME);
  });
});

describe('guest macOS non-enumerative Seatbelt boundary', () => {
  const wrapperPath = path.join(GUEST_SANDBOX_EXEC_WRAPPER_DIR, 'sandbox-exec');
  const resolveMacAlias = (value: string): string => {
    if (value === '/tmp') return '/private/tmp';
    if (value === '/var/tmp') return '/private/var/tmp';
    if (value === '/var/folders') return '/private/var/folders';
    return value;
  };

  it('expresses project/groups/data/ipc and shared roots as parent-minus-exact-child rules', () => {
    const policy = buildGuestMacSeatbeltPolicy({
      projectRoot: '/Users/example/assistant/claudeclaw',
      mountRoot: '/Users',
      hostControlledReadRoots: [
        '/Users/example/assistant/claudeclaw',
        '/private/tmp/guest-runtime',
        '/Volumes/Approved/runtime-data',
      ],
      restrictedParents: [
        {
          parent: '/Users/example/assistant/claudeclaw/groups',
          allowedSubtrees: [
            '/Users/example/assistant/claudeclaw/groups/tenant-a',
            '/Users/example/assistant/claudeclaw/groups/global',
          ],
        },
        {
          parent: '/Users/example/assistant/claudeclaw/data',
          allowedSubtrees: [
            '/Users/example/assistant/claudeclaw/data/ipc/tenant-a',
            '/Users/example/assistant/claudeclaw/data/sessions/tenant-a',
            '/Users/example/assistant/claudeclaw/data/user-memory/user-a',
          ],
        },
        {
          parent: '/Users/example/assistant/claudeclaw/data/ipc/tenant-a',
          allowedSubtrees: [
            '/Users/example/assistant/claudeclaw/data/ipc/tenant-a/messages',
            '/Users/example/assistant/claudeclaw/data/ipc/tenant-a/current_tasks.json',
          ],
        },
      ],
      sharedReadRoots: GUEST_MAC_SHARED_READ_ROOTS,
      resolveHostPath: resolveMacAlias,
    });

    expect(policy.boundaries).toEqual(
      expect.arrayContaining([
        { parent: '/Users', allowedSubtrees: [MAC_EXAMPLE_HOME] },
        {
          parent: '/Users/example/assistant/claudeclaw/groups',
          allowedSubtrees: [
            '/Users/example/assistant/claudeclaw/groups/global',
            '/Users/example/assistant/claudeclaw/groups/tenant-a',
          ],
        },
        {
          parent: '/private/tmp',
          allowedSubtrees: ['/private/tmp/guest-runtime'],
        },
        {
          parent: '/Volumes',
          allowedSubtrees: ['/Volumes/Approved/runtime-data'],
        },
        { parent: '/Network', allowedSubtrees: [] },
      ]),
    );
    expect(policy.envRoots).toEqual(['/Users/example/assistant/claudeclaw']);
  });

  it('never turns an external /workspace/extra mount into a shared-root carve-out', () => {
    const roots = collectGuestSeatbeltHostReadRoots('/srv/skoobi', [
      {
        hostPath: '/private/tmp/tenant-runtime',
        containerPath: '/workspace/group',
        readonly: false,
      },
      {
        hostPath: '/Volumes/External/customer-files',
        containerPath: '/workspace/extra0',
        readonly: true,
      },
    ]);
    expect(roots).toContain('/private/tmp/tenant-runtime');
    expect(roots).not.toContain('/Volumes/External/customer-files');
  });

  it('keeps only host-controlled GROUPS descendants, including canonical received', () => {
    const groupsRoot = '/srv/claudeclaw/groups';
    const canonicalGroup = path.join(groupsRoot, 'tenant-a');
    const received = path.join(canonicalGroup, 'received');
    const global = path.join(groupsRoot, 'global');
    const external = path.join(canonicalGroup, 'operator-extra');
    const roots = collectGuestSeatbeltHostReadRoots('/srv/claudeclaw', [
      {
        hostPath: canonicalGroup,
        containerPath: '/workspace/canonical-group',
        readonly: true,
        deny: true,
      },
      {
        hostPath: '/srv/claudeclaw/data/untrusted-main/tenant-a/workspace',
        containerPath: '/workspace/group',
        readonly: false,
      },
      {
        hostPath: received,
        containerPath: '/workspace/group/received',
        readonly: true,
      },
      {
        hostPath: global,
        containerPath: '/workspace/global',
        readonly: true,
      },
      {
        hostPath: external,
        containerPath: '/workspace/extra0',
        readonly: true,
      },
    ]);

    expect(collectGuestSeatbeltAllowedSubtrees(groupsRoot, roots)).toEqual([
      received,
      global,
    ]);
    expect(roots).not.toContain(canonicalGroup);
    expect(roots).not.toContain(external);
  });

  it('rejects an escaping/malformed carve-out before it reaches PATH', () => {
    expect(() =>
      encodeGuestSeatbeltPolicy({
        version: 1,
        boundaries: [
          { parent: '/private/tmp/safe', allowedSubtrees: ['/etc'] },
        ],
        envRoots: ['/srv/project'],
      }),
    ).toThrow(/escapes its parent/);
  });

  it('preserves the upstream profile and strips bootstrap env/PATH before delegation', async () => {
    const wrapper = (await import(pathToFileURL(wrapperPath).href)) as {
      appendGuestPolicyToProfile: (
        profile: string,
        policy: {
          version: 1;
          boundaries: Array<{
            parent: string;
            allowedSubtrees: string[];
          }>;
          envRoots: string[];
        },
      ) => string;
      sanitizedDelegateEnv: (
        env: Record<string, string>,
        wrapperDir: string,
      ) => Record<string, string>;
    };
    const upstream = `(version 1)\n(deny default)\n(allow network-outbound (remote ip "localhost:43210"))\n(allow file-read*)`;
    const augmented = wrapper.appendGuestPolicyToProfile(upstream, {
      version: 1,
      boundaries: [
        {
          parent: '/private/tmp',
          allowedSubtrees: ['/private/tmp/tenant-runtime'],
        },
      ],
      envRoots: ['/srv/project'],
    });
    expect(augmented.startsWith(upstream)).toBe(true);
    expect(augmented).toContain(
      '(allow network-outbound (remote ip "localhost:43210"))',
    );
    expect(augmented).toContain('(deny file-read*');
    expect(augmented).toContain('(deny file-write-unlink');
    expect(augmented).toContain('(require-not');
    expect(augmented).toContain('\\.env');

    const clean = wrapper.sanitizedDelegateEnv(
      {
        PATH: `${GUEST_SANDBOX_EXEC_WRAPPER_DIR}:/usr/bin:/bin`,
        [GUEST_SEATBELT_POLICY_ENV]: 'private-policy',
        KEEP: 'yes',
      },
      GUEST_SANDBOX_EXEC_WRAPPER_DIR,
    );
    expect(clean).toEqual({ PATH: '/usr/bin:/bin', KEEP: 'yes' });
  });

  it('fails closed when the wrapper receives a malformed boundary', () => {
    assertGuestSandboxExecWrapperSafe();
    const malformed = Buffer.from(
      JSON.stringify({
        version: 1,
        boundaries: [{ parent: '/tmp', allowedSubtrees: ['/etc'] }],
        envRoots: ['/srv/project'],
      }),
      'utf8',
    ).toString('base64url');
    const result = spawnSync(
      wrapperPath,
      ['-p', '(version 1)\n(deny default)\n(allow process*)', '/usr/bin/true'],
      {
        env: {
          PATH: `${GUEST_SANDBOX_EXEC_WRAPPER_DIR}${path.delimiter}${path.dirname(process.execPath)}:/usr/bin:/bin`,
          [GUEST_SEATBELT_POLICY_ENV]: malformed,
        },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/escapes or equals/);
  });

  it('real macOS srt blocks post-policy siblings/.env while authorized read/create/mv/rm still work', () => {
    if (process.platform !== 'darwin') return;
    const srt = path.join(process.cwd(), 'node_modules', '.bin', 'srt');
    if (!fs.existsSync(srt)) return;
    assertGuestSandboxExecWrapperSafe();

    const root = fs.mkdtempSync(
      path.join('/private/tmp', `skoobi-seatbelt-wrapper-${process.pid}-`),
    );
    const allowedDir = path.join(root, 'allowed');
    const settingsPath = path.join(root, 'settings.json');
    fs.mkdirSync(allowedDir);
    const policy = buildGuestMacSeatbeltPolicy({
      projectRoot: allowedDir,
      mountRoot: null,
      hostControlledReadRoots: [allowedDir],
      restrictedParents: [{ parent: root, allowedSubtrees: [allowedDir] }],
      sharedReadRoots: [],
    });
    const encodedPolicy = encodeGuestSeatbeltPolicy(policy);
    const settings = buildSandboxSettings([
      {
        hostPath: root,
        containerPath: '/workspace/test-root',
        readonly: false,
      },
    ]);
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    // These names did not exist when either policy was assembled. This is the
    // create-after-build window that sibling enumeration cannot close.
    const allowedFile = path.join(allowedDir, 'visible.txt');
    const lateSibling = path.join(root, 'late-host-secret.txt');
    const lateEnv = path.join(allowedDir, '.env.late');
    fs.writeFileSync(allowedFile, 'VISIBLE');
    fs.writeFileSync(lateSibling, 'LATE_SIBLING_SECRET');
    fs.writeFileSync(lateEnv, 'LATE_ENV_SECRET');
    const env = {
      ...process.env,
      PATH: `${GUEST_SANDBOX_EXEC_WRAPPER_DIR}${path.delimiter}${process.env.PATH}`,
      [GUEST_SEATBELT_POLICY_ENV]: encodedPolicy,
      ALLOWED_DIR: allowedDir,
      ALLOWED_FILE: allowedFile,
      LATE_SIBLING: lateSibling,
      LATE_ENV: lateEnv,
      EXPECTED_WRAPPER_DIR: GUEST_SANDBOX_EXEC_WRAPPER_DIR,
    };
    try {
      const allowed = spawnSync(
        srt,
        [
          '-s',
          settingsPath,
          '-c',
          'cat "$ALLOWED_FILE" && printf created > "$ALLOWED_DIR/new.tmp" && mv "$ALLOWED_DIR/new.tmp" "$ALLOWED_DIR/new.txt" && rm "$ALLOWED_DIR/new.txt" && test -z "${CLAUDECLAW_GUEST_SEATBELT_POLICY_B64:-}" && case "$PATH" in "$EXPECTED_WRAPPER_DIR":*) exit 91;; esac',
        ],
        { env, encoding: 'utf8' },
      );
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(allowed.stdout).toBe('VISIBLE');
      expect(fs.existsSync(path.join(allowedDir, 'new.txt'))).toBe(false);

      const siblingRead = spawnSync(
        srt,
        ['-s', settingsPath, '-c', 'cat "$LATE_SIBLING"'],
        { env, encoding: 'utf8' },
      );
      expect(siblingRead.status).not.toBe(0);
      expect(siblingRead.stdout).not.toContain('LATE_SIBLING_SECRET');

      const envRead = spawnSync(
        srt,
        ['-s', settingsPath, '-c', 'cat "$LATE_ENV"'],
        { env, encoding: 'utf8' },
      );
      expect(envRead.status).not.toBe(0);
      expect(envRead.stdout).not.toContain('LATE_ENV_SECRET');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('real macOS full wrapper keeps downgraded canonical received readable without opening its group', () => {
    if (process.platform !== 'darwin') return;
    const srt = path.join(process.cwd(), 'node_modules', '.bin', 'srt');
    if (!fs.existsSync(srt)) return;
    assertGuestSandboxExecWrapperSafe();

    const root = fs.mkdtempSync(
      path.join('/private/tmp', `skoobi-seatbelt-received-${process.pid}-`),
    );
    const projectRoot = path.join(root, 'project');
    const groupsRoot = path.join(root, 'groups');
    const dataRoot = path.join(root, 'data');
    const canonicalGroup = path.join(groupsRoot, 'tenant-a');
    const received = path.join(canonicalGroup, 'received');
    const receivedFile = path.join(received, 'visible.txt');
    const ownerFile = path.join(canonicalGroup, 'owner-secret.txt');
    const isolatedWorkspace = path.join(
      root,
      'data',
      'untrusted-main',
      'tenant-a',
      'workspace',
    );
    const receivedLink = path.join(isolatedWorkspace, 'received');
    const settingsPath = path.join(root, 'settings.json');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(received, { recursive: true });
    fs.mkdirSync(isolatedWorkspace, { recursive: true });
    fs.symlinkSync(received, receivedLink, 'dir');
    fs.writeFileSync(receivedFile, 'VISIBLE_MEDIA');
    fs.writeFileSync(ownerFile, 'OWNER_SECRET');

    const mounts = [
      {
        hostPath: canonicalGroup,
        containerPath: '/workspace/canonical-group',
        readonly: true,
        deny: true,
      },
      {
        hostPath: isolatedWorkspace,
        containerPath: '/workspace/group',
        readonly: false,
      },
      {
        hostPath: received,
        containerPath: '/workspace/group/received',
        readonly: true,
      },
      {
        hostPath: receivedLink,
        containerPath: '/workspace/group/received-link',
        readonly: true,
      },
    ];
    const hostControlledReadRoots = collectGuestSeatbeltHostReadRoots(
      projectRoot,
      mounts,
    );
    const groupAllowed = collectGuestSeatbeltAllowedSubtrees(
      groupsRoot,
      hostControlledReadRoots,
    );
    const dataAllowed = collectGuestSeatbeltAllowedSubtrees(
      dataRoot,
      hostControlledReadRoots,
    );
    expect(groupAllowed).toEqual([received]);
    expect(dataAllowed).toEqual([isolatedWorkspace, receivedLink]);

    const policy = buildGuestMacSeatbeltPolicy({
      projectRoot,
      mountRoot: null,
      hostControlledReadRoots,
      restrictedParents: [
        { parent: groupsRoot, allowedSubtrees: groupAllowed },
        { parent: dataRoot, allowedSubtrees: dataAllowed },
      ],
      sharedReadRoots: [],
    });
    const settings = buildSandboxSettings(mounts);
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    const env = {
      ...process.env,
      PATH: `${GUEST_SANDBOX_EXEC_WRAPPER_DIR}${path.delimiter}${process.env.PATH}`,
      [GUEST_SEATBELT_POLICY_ENV]: encodeGuestSeatbeltPolicy(policy),
      CANONICAL_RECEIVED_FILE: receivedFile,
      RECEIVED_FILE: path.join(receivedLink, 'visible.txt'),
      RECEIVED_DIR: received,
      OWNER_FILE: ownerFile,
      WORKSPACE: isolatedWorkspace,
    };

    try {
      const allowed = spawnSync(
        srt,
        [
          '-s',
          settingsPath,
          '-c',
          'cat "$CANONICAL_RECEIVED_FILE" && cat "$RECEIVED_FILE" && printf created > "$WORKSPACE/new.tmp" && mv "$WORKSPACE/new.tmp" "$WORKSPACE/new.txt" && rm "$WORKSPACE/new.txt"',
        ],
        { env, encoding: 'utf8' },
      );
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(allowed.stdout).toBe('VISIBLE_MEDIAVISIBLE_MEDIA');

      const ownerRead = spawnSync(
        srt,
        ['-s', settingsPath, '-c', 'cat "$OWNER_FILE"'],
        { env, encoding: 'utf8' },
      );
      expect(ownerRead.status).not.toBe(0);
      expect(ownerRead.stdout).not.toContain('OWNER_SECRET');

      const receivedWrite = spawnSync(
        srt,
        ['-s', settingsPath, '-c', 'printf changed > "$RECEIVED_DIR/new"'],
        { env, encoding: 'utf8' },
      );
      expect(receivedWrite.status).not.toBe(0);
      expect(fs.existsSync(path.join(received, 'new'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('real macOS gives only the prepared observer Codex home read/write access', () => {
    if (process.platform !== 'darwin') return;
    const srt = path.join(process.cwd(), 'node_modules', '.bin', 'srt');
    if (!fs.existsSync(srt)) return;
    assertGuestSandboxExecWrapperSafe();

    const root = fs.mkdtempSync(
      path.join('/private/tmp', `skoobi-observer-codex-${process.pid}-`),
    );
    const projectRoot = path.join(root, 'project');
    const dataDir = path.join(root, 'data');
    const parent = path.join(dataDir, 'codex-homes');
    const child = path.join(parent, 'whatsapp_main');
    const sibling = path.join(parent, 'telegram_main');
    const settingsPath = path.join(root, 'settings.json');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });

    const mounts = [
      {
        hostPath: parent,
        containerPath: parent,
        readonly: true,
        deny: true,
      },
    ];
    applyIsolatedObserverCodexHomeCarveOut(mounts, child, dataDir, 'darwin');
    const settings = buildSandboxSettings(mounts);
    assertIsolatedObserverCodexHomeCarveOut(settings, child, dataDir, 'darwin');
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    const hostControlledReadRoots = collectGuestSeatbeltHostReadRoots(
      projectRoot,
      mounts,
    );
    const policy = buildGuestMacSeatbeltPolicy({
      projectRoot,
      mountRoot: null,
      hostControlledReadRoots,
      restrictedParents: [
        {
          parent: dataDir,
          allowedSubtrees: collectGuestSeatbeltAllowedSubtrees(
            dataDir,
            hostControlledReadRoots,
          ),
        },
        { parent, allowedSubtrees: [child] },
      ],
      sharedReadRoots: [],
    });
    assertIsolatedObserverCodexHomeSeatbeltPolicy(
      policy,
      child,
      dataDir,
      'darwin',
    );

    const auth = path.join(child, 'auth.json');
    const config = path.join(child, 'config.toml');
    const childTmp = path.join(child, 'tmp');
    const siblingSecret = path.join(sibling, 'secret.txt');
    fs.writeFileSync(auth, 'AUTH_OK');
    fs.writeFileSync(siblingSecret, 'SIBLING_SECRET');

    // Created after both policies: the parent-minus-exact-child boundary must
    // still deny this future sibling without directory enumeration.
    const futureSibling = path.join(parent, 'future_group');
    fs.mkdirSync(futureSibling);
    const futureSecret = path.join(futureSibling, 'secret.txt');
    fs.writeFileSync(futureSecret, 'FUTURE_SECRET');

    const env = {
      ...process.env,
      PATH: `${GUEST_SANDBOX_EXEC_WRAPPER_DIR}${path.delimiter}${process.env.PATH}`,
      [GUEST_SEATBELT_POLICY_ENV]: encodeGuestSeatbeltPolicy(policy),
      AUTH: auth,
      CONFIG: config,
      CHILD_TMP: childTmp,
      PARENT: parent,
      SIBLING_SECRET: siblingSecret,
      SIBLING_NEW: path.join(sibling, 'new.txt'),
      FUTURE_SECRET: futureSecret,
      FUTURE_NEW: path.join(futureSibling, 'new.txt'),
    };

    try {
      const childReadWrite = spawnSync(
        srt,
        [
          '-s',
          settingsPath,
          '-c',
          'test "$(cat "$AUTH")" = AUTH_OK && printf "model = test\\n" > "$CONFIG" && mkdir "$CHILD_TMP" && printf x > "$CHILD_TMP/a" && mv "$CHILD_TMP/a" "$CHILD_TMP/b" && rm "$CHILD_TMP/b"',
        ],
        { env, encoding: 'utf8' },
      );
      expect(childReadWrite.status, childReadWrite.stderr).toBe(0);
      expect(fs.readFileSync(config, 'utf8')).toBe('model = test\n');

      for (const [readPath, secret] of [
        [siblingSecret, 'SIBLING_SECRET'],
        [futureSecret, 'FUTURE_SECRET'],
      ] as const) {
        const denied = spawnSync(
          srt,
          ['-s', settingsPath, '-c', 'cat "$READ_PATH"'],
          { env: { ...env, READ_PATH: readPath }, encoding: 'utf8' },
        );
        expect(denied.status).not.toBe(0);
        expect(denied.stdout).not.toContain(secret);
      }

      const parentRead = spawnSync(
        srt,
        ['-s', settingsPath, '-c', 'ls "$PARENT"'],
        { env, encoding: 'utf8' },
      );
      expect(parentRead.status).not.toBe(0);

      for (const writePath of [env.SIBLING_NEW, env.FUTURE_NEW]) {
        const denied = spawnSync(
          srt,
          ['-s', settingsPath, '-c', 'printf denied > "$WRITE_PATH"'],
          { env: { ...env, WRITE_PATH: writePath }, encoding: 'utf8' },
        );
        expect(denied.status).not.toBe(0);
        expect(fs.existsSync(writePath)).toBe(false);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// L13/L10: NO_OUTPUT_TIMEOUT_MS must not cap a long turn below the budget and
// must be configurable.
// ---------------------------------------------------------------------------
describe('resolveNoOutputTimeoutMs (L13 first-output deadline)', () => {
  it('defaults to the chat first-output deadline when the budget is large', () => {
    // 30-min global budget: the no-output deadline stays at the default.
    expect(resolveNoOutputTimeoutMs(1_800_000, undefined)).toBe(
      DEFAULT_NO_OUTPUT_TIMEOUT_MS,
    );
  });

  it('never exceeds the global timeout (clamped) for a short budget', () => {
    // If an operator configures a SHORT budget, the no-output deadline must not
    // overshoot it (and can never outlive the global timer).
    expect(resolveNoOutputTimeoutMs(120_000, undefined)).toBe(120_000);
  });

  it('is raisable via CLAUDECLAW_NO_OUTPUT_TIMEOUT_MS (still clamped to budget)', () => {
    // Operator expecting a long first turn raises the deadline toward the
    // budget so a slow-but-healthy turn is not killed below the 30-min budget.
    expect(resolveNoOutputTimeoutMs(1_800_000, '1500000')).toBe(1_500_000);
    // ...but it is still clamped to the global cap.
    expect(resolveNoOutputTimeoutMs(1_800_000, '99999999')).toBe(1_800_000);
  });

  it('disables the deadline entirely when set to 0 or negative (returns null)', () => {
    expect(resolveNoOutputTimeoutMs(1_800_000, '0')).toBeNull();
    expect(resolveNoOutputTimeoutMs(1_800_000, '-5')).toBeNull();
  });

  it('ignores blank / non-numeric overrides and falls back to the default', () => {
    expect(resolveNoOutputTimeoutMs(1_800_000, '')).toBe(
      DEFAULT_NO_OUTPUT_TIMEOUT_MS,
    );
    expect(resolveNoOutputTimeoutMs(1_800_000, '   ')).toBe(
      DEFAULT_NO_OUTPUT_TIMEOUT_MS,
    );
    expect(resolveNoOutputTimeoutMs(1_800_000, 'abc')).toBe(
      DEFAULT_NO_OUTPUT_TIMEOUT_MS,
    );
  });
});

describe('resolveProgressTimeoutMs (useful-progress deadline)', () => {
  it('defaults to the useful-progress deadline when the budget is large', () => {
    expect(resolveProgressTimeoutMs(1_800_000, undefined)).toBe(
      DEFAULT_PROGRESS_TIMEOUT_MS,
    );
  });

  it('never exceeds the global timeout and can be disabled', () => {
    expect(resolveProgressTimeoutMs(120_000, undefined)).toBe(120_000);
    expect(resolveProgressTimeoutMs(1_800_000, '0')).toBeNull();
  });

  it('is configurable via CLAUDECLAW_PROGRESS_TIMEOUT_MS', () => {
    expect(resolveProgressTimeoutMs(1_800_000, '90000')).toBe(90_000);
    expect(resolveProgressTimeoutMs(1_800_000, '99999999')).toBe(1_800_000);
  });
});

describe('runSandboxAgent useful-progress timeout', () => {
  const savedProgressTimeout = process.env.CLAUDECLAW_PROGRESS_TIMEOUT_MS;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.CLAUDECLAW_PROGRESS_TIMEOUT_MS = '50';
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedProgressTimeout === undefined) {
      delete process.env.CLAUDECLAW_PROGRESS_TIMEOUT_MS;
    } else {
      process.env.CLAUDECLAW_PROGRESS_TIMEOUT_MS = savedProgressTimeout;
    }
  });

  it('kills a runner that stays alive without useful output after a turn', async () => {
    let child!: FakeChild;
    vi.mocked(spawn).mockImplementation(() => {
      child = new FakeChild();
      return child as any;
    });

    const outputs: ContainerOutput[] = [];
    const runPromise = runSandboxAgent(
      makeGroup(),
      makeInput({ isMain: false }),
      () => {},
      async (output) => {
        outputs.push(output);
      },
    );

    await vi.advanceTimersByTimeAsync(1);
    const marker = `${OUTPUT_START}${JSON.stringify({
      status: 'success',
      result: 'first reply',
    })}${OUTPUT_END}`;
    child.stdout.emit('data', Buffer.from(marker));
    await vi.advanceTimersByTimeAsync(51);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emit('close', null);
    const result = await runPromise;

    expect(outputs).toHaveLength(1);
    expect(result.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Confirmed IPC deliveries must feed the liveness deadlines. A run that
// reports exclusively via the IPC channel (send-message MCP → host watcher)
// produces no stdout markers and would otherwise be killed at the no-output
// deadline while its reports are still being delivered.
// ---------------------------------------------------------------------------
describe('runSandboxAgent IPC-activity liveness reset', () => {
  const savedNoOutputTimeout = process.env.CLAUDECLAW_NO_OUTPUT_TIMEOUT_MS;
  const savedProgressTimeout = process.env.CLAUDECLAW_PROGRESS_TIMEOUT_MS;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.CLAUDECLAW_NO_OUTPUT_TIMEOUT_MS = '100';
    process.env.CLAUDECLAW_PROGRESS_TIMEOUT_MS = '200';
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedNoOutputTimeout === undefined) {
      delete process.env.CLAUDECLAW_NO_OUTPUT_TIMEOUT_MS;
    } else {
      process.env.CLAUDECLAW_NO_OUTPUT_TIMEOUT_MS = savedNoOutputTimeout;
    }
    if (savedProgressTimeout === undefined) {
      delete process.env.CLAUDECLAW_PROGRESS_TIMEOUT_MS;
    } else {
      process.env.CLAUDECLAW_PROGRESS_TIMEOUT_MS = savedProgressTimeout;
    }
  });

  it('keeps an output-silent run alive past the no-output deadline on confirmed IPC deliveries', async () => {
    let child!: FakeChild;
    vi.mocked(spawn).mockImplementation(() => {
      child = new FakeChild();
      return child as any;
    });

    const runPromise = runSandboxAgent(
      makeGroup(),
      makeInput({ isMain: false }),
      () => {},
      async () => {},
    );

    // t=80, before the 100ms no-output deadline: the host IPC watcher
    // confirms a photo delivery for this group → the run's listener clears
    // the first-output deadline and arms the progress deadline (t=280).
    await vi.advanceTimersByTimeAsync(80);
    expect(notifyRunIpcActivity('test-group', 'photo')).toBe(1);

    // t=170 — the original no-output deadline has long passed; still alive.
    await vi.advanceTimersByTimeAsync(90);
    expect(child.kill).not.toHaveBeenCalled();

    // Each further confirmed delivery re-arms the progress deadline:
    // re-armed at t=170 → next deadline t=370.
    expect(notifyRunIpcActivity('test-group', 'message')).toBe(1);
    await vi.advanceTimersByTimeAsync(150); // t=320 < 370 — still alive
    expect(child.kill).not.toHaveBeenCalled();

    // Deliveries stop: the progress deadline fires (t=380 > 370) — a run
    // that stops reporting still gets killed and retried.
    await vi.advanceTimersByTimeAsync(60);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emit('close', null);
    const result = await runPromise;
    expect(result.status).toBe('error');
  });

  it('stops listening for IPC activity once the run closes', async () => {
    let child!: FakeChild;
    vi.mocked(spawn).mockImplementation(() => {
      child = new FakeChild();
      return child as any;
    });

    const runPromise = runSandboxAgent(
      makeGroup(),
      makeInput({ isMain: false }),
      () => {},
      async () => {},
    );

    await vi.advanceTimersByTimeAsync(1);
    // Listener is registered for the run's group folder while it is live.
    expect(notifyRunIpcActivity('test-group', 'photo')).toBe(1);

    const marker = `${OUTPUT_START}${JSON.stringify({
      status: 'success',
      result: 'done',
    })}${OUTPUT_END}`;
    child.stdout.emit('data', Buffer.from(marker));
    child.emit('close', 0);
    const result = await runPromise;
    expect(result.status).toBe('success');

    // Unregistered in the close handler: a delivery confirmed after the run
    // ended (the IPC watcher is asynchronous) is a no-op for a finished run.
    expect(notifyRunIpcActivity('test-group', 'photo')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L9: cleanupSandboxOrphans must verify PID identity before a group-wide kill.
// ---------------------------------------------------------------------------
describe('isClaudeclawSandboxProcess (L9 PID-reuse guard)', () => {
  it('accepts a sandbox-runtime command line', () => {
    expect(
      isClaudeclawSandboxProcess(
        1234,
        () => 'npx @anthropic-ai/sandbox-runtime --settings /x -- node /a/b.js',
      ),
    ).toBe(true);
  });

  it('accepts an agent-runner command line (bypass mode)', () => {
    expect(
      isClaudeclawSandboxProcess(
        1234,
        () => '/usr/local/bin/node /code/agent/runner/dist/index.js',
      ),
    ).toBe(true);
  });

  it('rejects an unrelated process (recycled PID) — fail closed', () => {
    expect(isClaudeclawSandboxProcess(1234, () => '/usr/sbin/cupsd -l')).toBe(
      false,
    );
  });

  it('fails closed when the command line cannot be read', () => {
    expect(
      isClaudeclawSandboxProcess(1234, () => {
        throw new Error('ESRCH: no such process');
      }),
    ).toBe(false);
  });

  it('fails closed on empty ps output and on pid <= 1', () => {
    expect(isClaudeclawSandboxProcess(1234, () => '')).toBe(false);
    expect(isClaudeclawSandboxProcess(1, () => 'sandbox-runtime')).toBe(false);
  });

  // finding #32: the install path is …/my-assistant/claudeclaw, so a bare
  // 'claudeclaw' substring matched innocent processes touching that tree
  // (editors, `tail -f …/logs`, rg/grep, rsync). Such a recycled PID must NOT
  // be treated as a sandbox, or cleanup would group-SIGTERM it.
  it('rejects unrelated processes whose command line merely contains the install path', () => {
    expect(
      isClaudeclawSandboxProcess(
        1234,
        () => 'tail -f /Users/example/my-assistant/claudeclaw/logs/app.log',
      ),
    ).toBe(false);
    expect(
      isClaudeclawSandboxProcess(
        1234,
        () => 'rg pattern /Users/example/my-assistant/claudeclaw',
      ),
    ).toBe(false);
  });

  // finding #32: the wrapper's --settings argument carries the per-run
  // processName token (claudeclaw-sandbox-<folder>-<ts>.json), a far more
  // specific signal than the bare 'claudeclaw' substring.
  it('accepts the specific claudeclaw-sandbox- processName token in the settings path', () => {
    expect(
      isClaudeclawSandboxProcess(
        1234,
        () =>
          'npx @anthropic-ai/sandbox-runtime --settings /d/sandbox-settings/claudeclaw-sandbox-test-group-1700000000000.json -- node /a/b.js',
      ),
    ).toBe(true);
  });
});

describe('cleanupSandboxOrphans (L9 identity-gated group kill)', () => {
  const PID_DIR = path.join(DATA_DIR, 'sandbox-pids');

  function writePid(name: string, pid: number) {
    // Start from a clean PID dir so pre-existing real orphan files (from a
    // local dev run) can't interfere with the mocked process.kill assertions.
    fs.rmSync(PID_DIR, { recursive: true, force: true });
    fs.mkdirSync(PID_DIR, { recursive: true });
    fs.writeFileSync(path.join(PID_DIR, `${name}.pid`), String(pid));
  }

  it('does NOT group-kill a recycled PID whose identity is not a sandbox', () => {
    const recycledPid = 50001;
    writePid('claudeclaw-sandbox-stale', recycledPid);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((p, sig) => {
      // signal-0 existence check: pretend the recycled PID is alive
      if (sig === 0) return true;
      return true;
    });
    // ps reports an UNRELATED process for that PID → identity check fails.
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'ps') return '/sbin/launchd';
      return '';
    });

    cleanupSandboxOrphans();

    // The negative-PID group SIGTERM must NEVER be sent for an unidentified PID.
    expect(killSpy).not.toHaveBeenCalledWith(-recycledPid, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(recycledPid, 'SIGTERM');
    // The stale PID file is still removed.
    expect(
      fs.existsSync(path.join(PID_DIR, 'claudeclaw-sandbox-stale.pid')),
    ).toBe(false);
    killSpy.mockRestore();
  });

  it('group-kills a PID confirmed to be a claudeclaw sandbox', () => {
    const livePid = 50002;
    writePid('claudeclaw-sandbox-live', livePid);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'ps')
        return 'npx @anthropic-ai/sandbox-runtime --settings /x -- node /r.js';
      return '';
    });

    cleanupSandboxOrphans();

    expect(killSpy).toHaveBeenCalledWith(-livePid, 'SIGTERM');
    expect(
      fs.existsSync(path.join(PID_DIR, 'claudeclaw-sandbox-live.pid')),
    ).toBe(false);
    killSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// L8: orphaned data/sandbox-settings files must be swept on startup.
// ---------------------------------------------------------------------------
describe('cleanupStaleSandboxSettings (L8 unbounded-disk sweep)', () => {
  const SETTINGS_DIR = path.join(DATA_DIR, 'sandbox-settings');

  it('deletes settings files older than the staleness threshold but keeps fresh ones', () => {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    const stale = path.join(SETTINGS_DIR, 'claudeclaw-sandbox-stale-1.json');
    const fresh = path.join(SETTINGS_DIR, 'claudeclaw-sandbox-fresh-1.json');
    fs.writeFileSync(stale, '{}');
    fs.writeFileSync(fresh, '{}');
    // Backdate the stale file's mtime well past the 2h threshold.
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    cleanupStaleSandboxSettings();

    expect(fs.existsSync(stale)).toBe(false); // swept
    expect(fs.existsSync(fresh)).toBe(true); // kept (live run could own it)

    // cleanup
    try {
      fs.unlinkSync(fresh);
    } catch {
      /* ignore */
    }
  });

  it('is a no-op when the settings dir does not exist', () => {
    const dir = path.join(DATA_DIR, 'sandbox-settings');
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    expect(() => cleanupStaleSandboxSettings()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// L7: HELPER_SECRET / HELPER_PORT must only be injected into MAIN sandboxes,
// never into untrusted guest sandboxes.
// ---------------------------------------------------------------------------
describe('runSandboxAgent HELPER_SECRET gating (L7)', () => {
  const savedHelperSecret = process.env.HELPER_SECRET;
  const savedHelperPort = process.env.HELPER_PORT;
  const savedGoogleSecret =
    process.env.SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET;
  const savedGoogleToken = process.env.SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN;
  beforeEach(() => {
    // Model the hostile/accidental launch environment that exposed the old
    // fail-open spread: absence of a guest overlay must still delete secrets.
    process.env.HELPER_SECRET = 'INHERITED-HELPER-MUST-NOT-LEAK';
    process.env.HELPER_PORT = '9999';
    process.env.SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET =
      'INHERITED-GOOGLE-SECRET-MUST-NOT-LEAK';
    process.env.SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN =
      'INHERITED-GOOGLE-TOKEN-MUST-NOT-LEAK';
  });
  afterEach(() => {
    if (savedHelperSecret === undefined) delete process.env.HELPER_SECRET;
    else process.env.HELPER_SECRET = savedHelperSecret;
    if (savedHelperPort === undefined) delete process.env.HELPER_PORT;
    else process.env.HELPER_PORT = savedHelperPort;
    if (savedGoogleSecret === undefined) {
      delete process.env.SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET;
    } else {
      process.env.SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET =
        savedGoogleSecret;
    }
    if (savedGoogleToken === undefined) {
      delete process.env.SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN;
    } else {
      process.env.SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN = savedGoogleToken;
    }
  });

  function captureSpawnEnv(): { env?: Record<string, string> } {
    const captured: { env?: Record<string, string> } = {};
    vi.mocked(spawn).mockImplementation((_cmd: any, _args: any, opts: any) => {
      captured.env = opts?.env;
      const child = new FakeChild();
      // Resolve the run promptly so the test doesn't hang on timers.
      setImmediate(() => child.emit('close', 0));
      return child as any;
    });
    return captured;
  }

  it('keeps the sandbox wrapper first for a downgraded WhatsApp observer guest', async () => {
    const captured: {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    } = {};
    vi.mocked(spawn).mockImplementation(
      (command: any, args: any, opts: any) => {
        captured.command = command;
        captured.args = args;
        captured.env = opts?.env;
        const child = new FakeChild();
        setImmediate(() => child.emit('close', 0));
        return child as any;
      },
    );
    const agentConfig = { whatsappObserverAccess: true };

    await runSandboxAgent(
      makeGroup({ isMain: true, agentConfig }),
      makeInput({
        chatJid: '77000000000@s.whatsapp.net',
        isMain: true,
        credentialProxyTier: 'owner',
        agentConfig,
      }),
      () => {},
    );

    expect(captured.command).toBe(process.execPath);
    expect(captured.args?.[0]).toMatch(
      /node_modules\/@anthropic-ai\/sandbox-runtime\/dist\/cli\.js$/,
    );
    expect(captured.args).not.toContain('npx');
    if (process.platform === 'darwin') {
      expect(captured.env?.PATH?.split(path.delimiter)[0]).toBe(
        GUEST_SANDBOX_EXEC_WRAPPER_DIR,
      );
    }
  });

  it('forces group-scoped WhatsApp observer runs to guest tier despite stale input config', async () => {
    let child!: FakeChild;
    const captured: {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    } = {};
    vi.mocked(spawn).mockImplementation(
      (command: any, args: any, opts: any) => {
        captured.command = command;
        captured.args = args;
        captured.env = opts?.env;
        child = new FakeChild();
        setImmediate(() => child.emit('close', 0));
        return child as any;
      },
    );

    await runSandboxAgent(
      makeGroup({
        isMain: true,
        agentConfig: {
          whatsappObserverAccess: true,
          fullAccess: true,
          noSandbox: true,
        },
      }),
      makeInput({
        chatJid: '77000000000@s.whatsapp.net',
        isMain: true,
        credentialProxyTier: 'owner',
        // Deliberately stale/mismatched: the group registry enables observer
        // mode, while this per-message copy does not.
        agentConfig: { fullAccess: true, noSandbox: true },
        taskAuthorizationCapability: 'must-not-leak-task',
        codexControlRunId: '00000000-0000-4000-8000-000000000005',
        memoryWriteCapability: 'must-not-leak-memory',
        memoryProvenancePublicKey: 'must-not-leak-verifier',
        googleAllowedTools: ['google_drive_search'],
        googleSheetTargetHints: [
          {
            label: 'ledger',
            spreadsheetId: 'public-fixture-spreadsheet-id-0001',
            range: "'Лист1'!A47:G1000",
            columnCount: 7,
            maxRowsPerCall: 1,
          },
        ],
      }),
      () => {},
    );

    expect(captured.command).toBe(process.execPath);
    expect(captured.args?.[0]).toMatch(
      /node_modules\/@anthropic-ai\/sandbox-runtime\/dist\/cli\.js$/,
    );
    expect(captured.env?.HELPER_SECRET).toBeUndefined();
    expect(captured.env?.HELPER_PORT).toBeUndefined();
    if (process.platform === 'darwin') {
      expect(captured.env?.PATH?.split(path.delimiter)[0]).toBe(
        GUEST_SANDBOX_EXEC_WRAPPER_DIR,
      );
    }
    const serialized = JSON.parse(
      String(child.stdin.write.mock.calls[0]?.[0]),
    ) as ContainerInput;
    expect(serialized.isMain).toBe(false);
    expect(serialized.credentialProxyTier).toBe('guest');
    expect(serialized.taskAuthorizationCapability).toBeUndefined();
    expect(serialized.codexControlRunId).toBeUndefined();
    expect(serialized.memoryWriteCapability).toBeUndefined();
    expect(serialized.memoryProvenancePublicKey).toBeUndefined();
    expect(serialized.googleAllowedTools).toBeUndefined();
    expect(serialized.googleSheetTargetHints).toBeUndefined();
    expect(serialized.agentConfig).toMatchObject({
      whatsappObserverAccess: true,
      fullAccess: false,
      noSandbox: false,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ bypassSandbox: false, isMain: false }),
      'Spawning sandbox agent',
    );
  });

  it('does NOT inject HELPER_SECRET/HELPER_PORT for a guest (non-main) sandbox', async () => {
    const captured = captureSpawnEnv();
    await runSandboxAgent(makeGroup(), makeInput({ isMain: false }), () => {});
    expect(captured.env).toBeDefined();
    expect(captured.env!.HELPER_SECRET).toBeUndefined();
    expect(captured.env!.HELPER_PORT).toBeUndefined();
    expect(
      captured.env!.SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
    ).toBeUndefined();
    expect(captured.env!.SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN).toBeUndefined();
    // The real provider key returned by the host secret reader stays inside
    // the loopback credential proxy. The runner gets only a random one-run
    // placeholder and a host-signed tenant identity.
    expect(captured.env!.ANTHROPIC_API_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(captured.env!.ANTHROPIC_API_KEY).not.toBe('FAKE-KEY');
    expect(captured.env!.ANTHROPIC_BASE_URL).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/,
    );
    expect(captured.env!.ANTHROPIC_CUSTOM_HEADERS).toMatch(
      /^x-skoobi-credential-proxy-identity: /,
    );
    expect(captured.env!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(captured.env!.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(captured.env!.OPENAI_API_KEY).toBeUndefined();
    expect(captured.env!.CODEX_HOME).toBeUndefined();
    expect(Object.values(captured.env!)).not.toContain('FAKE-KEY');
    expect(captured.env!.TMPDIR).toBe(captured.env!.CLAUDE_TMPDIR);
    expect(captured.env!.TMP).toBe(captured.env!.CLAUDE_TMPDIR);
    expect(captured.env!.TEMP).toBe(captured.env!.CLAUDE_TMPDIR);
    expect(captured.env!.TMPDIR).toContain(
      path.join('sessions', 'test-group', 'tmp'),
    );
    if (process.platform === 'darwin') {
      expect(captured.env![GUEST_SEATBELT_POLICY_ENV]).toMatch(
        /^[A-Za-z0-9_-]+$/,
      );
      expect(captured.env!.PATH).toMatch(
        new RegExp(
          `^${GUEST_SANDBOX_EXEC_WRAPPER_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`,
        ),
      );
    }
  });

  it('DOES inject HELPER_SECRET/HELPER_PORT for the main sandbox', async () => {
    const captured = captureSpawnEnv();
    await runSandboxAgent(
      makeGroup({ isMain: true }),
      makeInput({ isMain: true, credentialProxyTier: 'owner' }),
      () => {},
    );
    expect(captured.env).toBeDefined();
    expect(captured.env!.HELPER_SECRET).toBe('FAKE-HELPER-SECRET');
    expect(captured.env!.HELPER_PORT).toBe('3200');
    // Google OAuth is never a runner secret, even for owner runs; the host
    // broker performs those API calls.
    expect(
      captured.env!.SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
    ).toBeUndefined();
    expect(captured.env!.SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN).toBeUndefined();
    // Owner/main keeps full provider functionality through the same proxy; it
    // does not need the real provider key in its general runner/Bash env.
    expect(captured.env!.ANTHROPIC_API_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(captured.env!.ANTHROPIC_API_KEY).not.toBe('FAKE-KEY');
    expect(captured.env!.ANTHROPIC_BASE_URL).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/,
    );
    expect(captured.env!.TMPDIR).toBe(process.env.TMPDIR);
    expect(captured.env!.TMP).toBe(process.env.TMP);
    expect(captured.env!.TEMP).toBe(process.env.TEMP);
    expect(captured.env![GUEST_SEATBELT_POLICY_ENV]).toBeUndefined();
    expect(captured.env!.PATH).toBe(process.env.PATH);
  });

  it('removes owner-only inherited keys before any trusted overlay', () => {
    const env = sandboxChildBaseEnv({
      PATH: '/usr/bin',
      HELPER_SECRET: 'leak',
      CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY: 'leak-cap',
      SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN: 'leak-token',
      SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN_FILE: '/secret/token',
      SKOOBI_GOOGLE_WORKSPACE_DEFAULT_SPREADSHEET_ID: 'leak-id',
      GOOGLE_APPLICATION_CREDENTIALS: '/secret/service-account.json',
      ANTHROPIC_API_KEY: 'real-anthropic-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'real-anthropic-oauth',
      ANTHROPIC_AUTH_TOKEN: 'real-anthropic-auth',
      ANTHROPIC_BASE_URL: 'https://real-upstream.example',
      ANTHROPIC_CUSTOM_HEADERS: 'authorization: Bearer real',
      OPENAI_API_KEY: 'real-openai-key',
      CODEX_HOME: '/host/.codex',
      TELEGRAM_BOT_TOKEN: 'real-bot-token',
      AWS_SECRET_ACCESS_KEY: 'real-aws-secret',
    });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('uses an explicit guest allowlist, preserving benign runtime/proxy wiring only', () => {
    const env = sandboxChildBaseEnv({
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      HTTPS_PROXY: 'http://127.0.0.1:8123',
      HTTP_PROXY: ['http://user:', 'password', '@', 'proxy.example:8080'].join(
        '',
      ),
      NO_PROXY: '127.0.0.1,localhost',
      NODE_OPTIONS: '--require=/host/preload.js',
      NODE_PATH: '/host/injected-modules',
      SKOOBI_PAYMENT_PASS: 'payment-password',
      SKOOBI_PAYMENT_LOGIN: 'payment-login',
      PARTNER_AUTH: 'partner-auth',
      SESSION: 'session-cookie',
      COOKIE: 'raw-cookie',
      RANDOM_EXTENSION_VALUE: 'must-not-cross-boundary',
      CLAUDECLAW_FAKE_SAFE_PREFIX: 'prefixes-are-not-allowlisted',
    });
    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      HTTPS_PROXY: 'http://127.0.0.1:8123',
      NO_PROXY: '127.0.0.1,localhost',
    });
  });

  it('keeps unrelated owner extension env while still removing direct provider auth', () => {
    const env = sandboxChildBaseEnv(
      {
        PATH: '/usr/bin',
        OWNER_EXTENSION_SECRET: 'owner-extension-value',
        ANTHROPIC_API_KEY: 'real-provider-key',
        CODEX_HOME: '/host/.codex',
      },
      true,
    );
    expect(env.OWNER_EXTENSION_SECRET).toBe('owner-extension-value');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it('serializes no owner session for a downgraded multi-sender main run', async () => {
    let child!: FakeChild;
    vi.mocked(spawn).mockImplementation(() => {
      child = new FakeChild();
      setImmediate(() => child.emit('close', 0));
      return child as any;
    });
    await runSandboxAgent(
      makeGroup({ isMain: true }),
      makeInput({
        isMain: true,
        chatJid: 'tg:-1001234567890',
        credentialProxyTier: 'guest',
        sessionId: 'owner-session-must-not-resume',
      }),
      () => {},
    );
    const serialized = JSON.parse(
      String(child.stdin.write.mock.calls[0]?.[0] ?? '{}'),
    );
    expect(serialized.sessionId).toBeUndefined();
    expect(serialized.isMain).toBe(false);
    expect(serialized.credentialProxyTier).toBe('guest');
  });
});

describe('runSandboxAgent bounded streaming parser', () => {
  it('fails closed on an oversized unterminated streamed frame', async () => {
    let child!: FakeChild;
    vi.mocked(spawn).mockImplementation(() => {
      child = new FakeChild();
      return child as any;
    });
    const runPromise = runSandboxAgent(
      makeGroup(),
      makeInput(),
      () => {},
      vi.fn(async () => {}),
    );
    await vi.waitFor(() => expect(child).toBeDefined());
    child.stdout.emit(
      'data',
      Buffer.from(
        `${OUTPUT_START}${'x'.repeat(CONTAINER_MAX_OUTPUT_SIZE + 1)}`,
      ),
    );
    child.emit('close', 0);
    const result = await runPromise;
    expect(result.status).toBe('error');
    expect(result.error).toMatch(
      new RegExp(`frame exceeded ${CONTAINER_MAX_OUTPUT_SIZE}`, 'i'),
    );
  });
});

// ---------------------------------------------------------------------------
// L14/L11: non-streaming terminal resolves (code!=0) must await outputChain so
// an in-flight onOutput completes before the run is reported finished.
// ---------------------------------------------------------------------------
describe('runSandboxAgent awaits outputChain on code!=0 (L14)', () => {
  it('waits for an in-flight onOutput before resolving a non-zero exit', async () => {
    const events: string[] = [];
    let releaseOnOutput!: () => void;
    const onOutputGate = new Promise<void>((res) => {
      releaseOnOutput = res;
    });

    let child!: FakeChild;
    vi.mocked(spawn).mockImplementation(() => {
      child = new FakeChild();
      return child as any;
    });

    const onOutput = async (_o: ContainerOutput) => {
      events.push('onOutput:start');
      await onOutputGate; // stays in-flight until the test releases it
      events.push('onOutput:end');
    };

    const runPromise = runSandboxAgent(
      makeGroup(),
      makeInput({ isMain: false }),
      () => {},
      onOutput,
    ).then((r) => {
      events.push('resolved');
      return r;
    });

    // Wait a tick so handlers are wired, then stream an error output marker and
    // immediately close with a non-zero code (the agent-runner error path).
    await new Promise((r) => setImmediate(r));
    const marker = `${OUTPUT_START}${JSON.stringify({
      status: 'error',
      result: null,
      error: 'boom',
    })}${OUTPUT_END}`;
    child.stdout.emit('data', Buffer.from(marker));
    child.emit('close', 1);

    // Give the close handler a chance to run; the run must NOT have resolved
    // yet because the onOutput is still in-flight (gate not released).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(events).toContain('onOutput:start');
    expect(events).not.toContain('resolved');

    // Release the in-flight onOutput; only now may the run resolve.
    releaseOnOutput();
    const result = await runPromise;

    // onOutput finished BEFORE the run resolved (ordering guarantee).
    expect(events).toEqual(['onOutput:start', 'onOutput:end', 'resolved']);
    expect(result.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Tenant-isolation mounts: the shared skills dir must be READ-ONLY for guests
// (so a guest cannot write an active skill into the trusted admin agent's
// prompt) and READ-WRITE only for main; the shared desktop-screenshot dir must
// be mounted ONLY into main (computer-control is main-only).
// ---------------------------------------------------------------------------
describe('buildSandboxMounts tenant isolation (skills + screenshots)', () => {
  const SCREENSHOT_DIR = '/tmp/skoobi-screenshots';

  function skillsMount(mounts: ReturnType<typeof buildSandboxMounts>) {
    return mounts.find((m) => m.containerPath === '/workspace/skills');
  }
  function screenshotMount(mounts: ReturnType<typeof buildSandboxMounts>) {
    return mounts.find((m) => m.containerPath === SCREENSHOT_DIR);
  }

  it('mounts the shared skills dir READ-ONLY for a guest group', () => {
    const mounts = buildSandboxMounts(makeGroup({ isMain: false }), false);
    const skills = skillsMount(mounts);
    expect(skills).toBeDefined();
    expect(skills!.readonly).toBe(true);
  });

  it('mounts the shared skills dir READ-WRITE for the main group', () => {
    const mounts = buildSandboxMounts(
      makeGroup({ isMain: true }),
      true,
      undefined,
      'owner',
    );
    const skills = skillsMount(mounts);
    expect(skills).toBeDefined();
    expect(skills!.readonly).toBe(false);
  });

  it('does NOT expose the desktop screenshot dir to a guest sandbox', () => {
    const mounts = buildSandboxMounts(makeGroup({ isMain: false }), false);
    expect(screenshotMount(mounts)).toBeUndefined();
  });

  it('mounts the desktop screenshot dir (read-only) for the main group', () => {
    const mounts = buildSandboxMounts(
      makeGroup({ isMain: true }),
      true,
      undefined,
      'owner',
    );
    const shot = screenshotMount(mounts);
    expect(shot).toBeDefined();
    expect(shot!.readonly).toBe(true);
  });

  it('does not add parent-wide shared-root mounts that would break guest mv/rm or owner behavior', () => {
    if (process.platform !== 'darwin') return;
    const guest = buildSandboxMounts(makeGroup({ isMain: false }), false);
    const owner = buildSandboxMounts(
      makeGroup({ isMain: true }),
      true,
      undefined,
      'owner',
    );
    for (const mounts of [guest, owner]) {
      expect(
        mounts.some(
          (mount) =>
            mount.deny === true &&
            (GUEST_MAC_SHARED_READ_ROOTS as readonly string[]).includes(
              mount.hostPath,
            ),
        ),
      ).toBe(false);
    }
  });
});

describe('runtime host-writer symlink poisoning defenses', () => {
  let root: string;
  let outside: string;
  let home: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join('/tmp', 'runtime-home-security-'));
    outside = path.join(root, 'outside');
    home = path.join(root, 'sessions', 'tenant');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(outside, 'marker'), 'UNCHANGED');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reclaims poisoned .claude/skills and settings for both runtime builders', () => {
    fs.symlinkSync(outside, path.join(home, '.claude'), 'dir');
    let prepared = prepareRuntimeClaudeHome(home, false);
    expect(fs.lstatSync(prepared.claudeHome).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'marker'), 'utf8')).toBe(
      'UNCHANGED',
    );

    const skills = path.join(prepared.claudeHome, 'skills');
    fs.rmSync(skills, { recursive: true, force: true });
    fs.symlinkSync(outside, skills, 'dir');
    const outsideSettings = path.join(outside, 'settings-target');
    fs.writeFileSync(outsideSettings, 'DO_NOT_OVERWRITE');
    fs.rmSync(path.join(prepared.claudeHome, 'settings.json'));
    fs.linkSync(
      outsideSettings,
      path.join(prepared.claudeHome, 'settings.json'),
    );

    prepared = prepareRuntimeClaudeHome(home, false);
    expect(
      fs.lstatSync(path.join(prepared.claudeHome, 'skills')).isDirectory(),
    ).toBe(true);
    expect(
      fs.lstatSync(path.join(prepared.claudeHome, 'skills')).isSymbolicLink(),
    ).toBe(false);
    expect(fs.readFileSync(outsideSettings, 'utf8')).toBe('DO_NOT_OVERWRITE');
    expect(
      fs.statSync(path.join(prepared.claudeHome, 'settings.json')).ino,
    ).not.toBe(fs.statSync(outsideSettings).ino);
  });

  it('preserves safe owner settings but refreshes stale poisoned owner skills', () => {
    let prepared = prepareRuntimeClaudeHome(home, true);
    const settings = path.join(prepared.claudeHome, 'settings.json');
    fs.writeFileSync(settings, '{"owner":"custom"}');
    const skills = path.join(prepared.claudeHome, 'skills');
    fs.rmSync(skills, { recursive: true, force: true });
    fs.symlinkSync(outside, skills, 'dir');

    prepared = prepareRuntimeClaudeHome(home, true);
    expect(fs.readFileSync(settings, 'utf8')).toBe('{"owner":"custom"}');
    expect(
      fs.lstatSync(path.join(prepared.claudeHome, 'skills')).isDirectory(),
    ).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'marker'), 'utf8')).toBe(
      'UNCHANGED',
    );

    const customSkill = path.join(
      prepared.claudeHome,
      'skills',
      'owner-custom',
    );
    fs.mkdirSync(customSkill, { recursive: true });
    fs.writeFileSync(path.join(customSkill, 'SKILL.md'), 'OWNER_CUSTOM');
    const builtInName = fs
      .readdirSync(path.join(process.cwd(), 'agent', 'skills'))
      .find((entry) =>
        fs
          .statSync(path.join(process.cwd(), 'agent', 'skills', entry))
          .isDirectory(),
      );
    expect(builtInName).toBeTruthy();
    const builtInDst = path.join(prepared.claudeHome, 'skills', builtInName!);
    fs.rmSync(builtInDst, { recursive: true, force: true });
    fs.symlinkSync(outside, builtInDst, 'dir');

    prepared = prepareRuntimeClaudeHome(home, true);
    expect(fs.readFileSync(path.join(customSkill, 'SKILL.md'), 'utf8')).toBe(
      'OWNER_CUSTOM',
    );
    expect(fs.lstatSync(builtInDst).isDirectory()).toBe(true);
    expect(fs.lstatSync(builtInDst).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'marker'), 'utf8')).toBe(
      'UNCHANGED',
    );
  });

  it('reclaims a poisoned host-only runtime logs directory without following it', () => {
    const logs = path.join(root, 'runtime-logs', 'tenant');
    fs.mkdirSync(path.dirname(logs), { recursive: true });
    fs.symlinkSync(outside, logs, 'dir');
    const safeLogs = ensureSafeGuestRuntimeDirectory(logs);
    expect(fs.lstatSync(safeLogs).isDirectory()).toBe(true);
    expect(fs.lstatSync(safeLogs).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'marker'), 'utf8')).toBe(
      'UNCHANGED',
    );
  });
});

describe('received-media sandbox isolation', () => {
  it('suppresses indirect Telegram identity before any user-memory mount', () => {
    const forwardedIdentity = {
      channel: 'telegram' as const,
      chat_id: '42',
      telegram_user_id: '42',
      identity_id: 'owner-42',
      is_owner_sender: true,
      telegram_message_origin: 'quoted' as const,
    };
    const restricted = restrictRuntimeInputToAuthorizedTier({
      prompt: 'test',
      groupFolder: 'test-group',
      chatJid: 'tg:42',
      isMain: true,
      credentialProxyTier: 'owner',
      senderIdentity: forwardedIdentity,
    });
    expect(restricted.senderIdentity).toBeUndefined();
    expect(
      buildSandboxMounts(
        makeGroup({ isMain: true }),
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
      buildSandboxMounts(
        makeGroup({ isMain: false }),
        false,
        directIdentity,
        'guest',
        'tg:42',
      ).find((mount) => mount.containerPath === '/workspace/user-memory'),
    ).toMatchObject({ readonly: false });
  });

  it('keeps normal guest workspace writes but denies received writes and replacement', () => {
    const mounts = buildSandboxMounts(
      makeGroup({
        isMain: true,
        agentConfig: { fullAccess: true, noSandbox: true },
      }),
      true,
      undefined,
      'guest',
    );
    const settings = buildSandboxSettings(mounts);
    const groupDir = '/tmp/test-groups/test-group';
    const receivedDir = path.join(groupDir, 'received');

    expect(settings.filesystem.allowWrite).toContain(groupDir);
    expect(settings.filesystem.denyWrite).toContain(receivedDir);
    expect(
      mounts.find((mount) => mount.containerPath === '/workspace/project'),
    ).toBeUndefined();
    expect(
      mounts.find(
        (mount) => mount.containerPath === '/workspace/group/received',
      ),
    ).toMatchObject({ readonly: true, denyWriteOnly: true });
  });

  it('does not narrow an explicitly owner-authorized main runtime', () => {
    const mounts = buildSandboxMounts(
      makeGroup({ isMain: true }),
      true,
      undefined,
      'owner',
    );
    expect(
      mounts.find(
        (mount) => mount.containerPath === '/workspace/group/received',
      ),
    ).toBeUndefined();
  });

  it('blocks received replacement in real macOS srt while preserving sibling writes', () => {
    if (process.platform !== 'darwin') return;
    const root = path.join(
      process.cwd(),
      'data',
      `srt-received-policy-${process.pid}-${Date.now()}`,
    );
    const received = path.join(root, 'received');
    const outside = path.join(root, 'outside');
    const sibling = path.join(root, 'notes.txt');
    const settingsPath = path.join(root, 'settings.json');
    fs.mkdirSync(received, { recursive: true });
    fs.mkdirSync(outside);

    const settings = buildSandboxSettings([
      {
        hostPath: root,
        containerPath: '/workspace/group',
        readonly: false,
      },
      {
        hostPath: received,
        containerPath: '/workspace/group/received',
        readonly: true,
        denyWriteOnly: true,
      },
    ]);
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    const env = {
      ...process.env,
      RECEIVED_DIR: received,
      OUTSIDE_DIR: outside,
      SIBLING_FILE: sibling,
    };
    const srt = path.join(process.cwd(), 'node_modules', '.bin', 'srt');

    try {
      const normal = spawnSync(
        srt,
        ['-s', settingsPath, '-c', 'printf ok > "$SIBLING_FILE"'],
        { env, encoding: 'utf8' },
      );
      expect(normal.status, normal.stderr).toBe(0);
      expect(fs.readFileSync(sibling, 'utf8')).toBe('ok');

      const replace = spawnSync(
        srt,
        [
          '-s',
          settingsPath,
          '-c',
          'rmdir "$RECEIVED_DIR" && ln -s "$OUTSIDE_DIR" "$RECEIVED_DIR"',
        ],
        { env, encoding: 'utf8' },
      );
      expect(replace.status).not.toBe(0);
      expect(fs.lstatSync(received).isDirectory()).toBe(true);
      expect(fs.lstatSync(received).isSymbolicLink()).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('downgraded multi-sender main sandbox namespace', () => {
  const isolatedRoot = path.join(DATA_DIR, 'untrusted-main', 'test-group');
  const canonicalGroup = '/tmp/test-groups/test-group';

  function downgradedMounts() {
    return buildSandboxMounts(
      makeGroup({ isMain: true }),
      true,
      undefined,
      'guest',
      'tg:-1001234567890',
    );
  }

  it('allows only isolated workspace/HOME/tmp and canonical received reads', () => {
    const mounts = downgradedMounts();
    const settings = buildSandboxSettings(mounts);

    expect(settings.filesystem.allowWrite).toContain(
      path.join(isolatedRoot, 'workspace'),
    );
    expect(settings.filesystem.allowWrite).toContain(
      path.join(isolatedRoot, 'home'),
    );
    expect(settings.filesystem.allowWrite).toContain(
      path.join(isolatedRoot, 'tmp'),
    );
    expect(settings.filesystem.denyRead).toContain(canonicalGroup);
    expect(settings.filesystem.denyWrite).toContain(canonicalGroup);
    expect(settings.filesystem.allowRead).toContain(
      path.join(canonicalGroup, 'received'),
    );
    expect(settings.filesystem.denyRead).toContain(
      path.join(DATA_DIR, 'sessions', 'test-group'),
    );
    expect(
      mounts.find((mount) => mount.containerPath === SANDBOX_GUEST_HOME),
    ).toMatchObject({ hostPath: path.join(isolatedRoot, 'home') });
  });

  it('reclaims a poisoned received entry as the fixed canonical link', () => {
    const workspace = path.join(isolatedRoot, 'workspace');
    const receivedLink = path.join(workspace, 'received');
    fs.rmSync(receivedLink, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.symlinkSync('/tmp', receivedLink, 'dir');

    const settings = buildSandboxSettings(downgradedMounts());
    expect(fs.lstatSync(receivedLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(receivedLink)).toBe(
      fs.realpathSync(path.join(canonicalGroup, 'received')),
    );
    expect(settings.filesystem.denyWrite).toContain(receivedLink);
  });

  it('allows received but denies the rest of canonical main in real macOS srt', () => {
    if (process.platform !== 'darwin') return;
    const received = path.join(canonicalGroup, 'received');
    const receivedFile = path.join(received, 'visible.txt');
    const ownerFile = path.join(canonicalGroup, 'owner-secret.txt');
    const settingsPath = path.join(
      isolatedRoot,
      `sandbox-settings-${process.pid}.json`,
    );
    fs.mkdirSync(received, { recursive: true });
    fs.writeFileSync(receivedFile, 'VISIBLE');
    fs.writeFileSync(ownerFile, 'OWNER_SECRET');
    const settings = buildSandboxSettings(downgradedMounts());
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    const srt = path.join(process.cwd(), 'node_modules', '.bin', 'srt');
    const receivedViaWorkspace = path.join(
      isolatedRoot,
      'workspace',
      'received',
      'visible.txt',
    );
    try {
      const allowed = spawnSync(
        srt,
        ['-s', settingsPath, '-c', 'cat "$RECEIVED_FILE"'],
        {
          env: { ...process.env, RECEIVED_FILE: receivedViaWorkspace },
          encoding: 'utf8',
        },
      );
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(allowed.stdout).toBe('VISIBLE');

      const denied = spawnSync(
        srt,
        ['-s', settingsPath, '-c', 'cat "$OWNER_FILE"'],
        {
          env: { ...process.env, OWNER_FILE: ownerFile },
          encoding: 'utf8',
        },
      );
      expect(denied.status).not.toBe(0);
      expect(denied.stdout).not.toContain('OWNER_SECRET');
    } finally {
      fs.rmSync(settingsPath, { force: true });
      fs.rmSync(receivedFile, { force: true });
      fs.rmSync(ownerFile, { force: true });
    }
  });

  it('keeps owner-authorized main mounts canonical', () => {
    const mounts = buildSandboxMounts(
      makeGroup({ isMain: true }),
      true,
      undefined,
      'owner',
      'tg:-1001234567890',
    );
    expect(
      mounts.find((mount) => mount.containerPath === '/workspace/group'),
    ).toMatchObject({ hostPath: canonicalGroup, readonly: false });
    expect(
      mounts.some((mount) => mount.hostPath.startsWith(isolatedRoot)),
    ).toBe(false);
  });
});

describe('sandbox IPC category isolation', () => {
  function ipcMounts(isMain: boolean) {
    return buildSandboxMounts(
      makeGroup({ isMain }),
      isMain,
      undefined,
      isMain ? 'owner' : 'guest',
    ).filter((mount) => mount.containerPath.startsWith('/workspace/ipc'));
  }

  it('allows guest category writes but denies mutations of IPC root entries', () => {
    const mounts = ipcMounts(false);
    expect(mounts.map((mount) => mount.containerPath)).toEqual([
      '/workspace/ipc/messages',
      '/workspace/ipc/tasks',
      '/workspace/ipc/swe',
      '/workspace/ipc/memory',
      '/workspace/ipc/input',
      '/workspace/ipc/google',
      '/workspace/ipc/*',
    ]);
    const googleMount = mounts.find(
      (mount) => mount.containerPath === '/workspace/ipc/google',
    );
    expect(googleMount).toMatchObject({ readonly: true });
    expect(googleMount?.hostPath).toContain('runtime-denied-google-ipc');

    const settings = buildSandboxSettings(mounts);
    const categoryHostPaths = mounts
      .filter((mount) => mount.readonly === false)
      .map((mount) => mount.hostPath);
    expect(settings.filesystem.allowWrite).toEqual(
      expect.arrayContaining(categoryHostPaths),
    );
    const ipcRoot = path.dirname(categoryHostPaths[0]);
    expect(settings.filesystem.allowWrite).not.toContain(ipcRoot);
    expect(settings.filesystem.denyWrite).toContain(path.join(ipcRoot, '*'));
  });

  it('denies the real Google IPC host path to every guest sandbox', () => {
    const mounts = buildSandboxMounts(
      makeGroup({ isMain: true }),
      true,
      undefined,
      'guest',
    );
    const realGoogle = mounts.find(
      (mount) =>
        mount.deny === true &&
        mount.containerPath === '/workspace/.claudeclaw-deny/google-ipc',
    );
    expect(realGoogle?.hostPath).toMatch(/[/\\]google$/);
    const settings = buildSandboxSettings(mounts);
    expect(settings.filesystem.denyRead).toContain(realGoogle?.hostPath);
    expect(settings.filesystem.allowRead).not.toContain(realGoogle?.hostPath);
  });

  it('keeps the trusted main whole IPC root writable', () => {
    const mounts = ipcMounts(true);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({
      containerPath: '/workspace/ipc',
      readonly: false,
    });
  });

  it('enforces normal writes but blocks category replacement in real macOS srt', () => {
    if (process.platform !== 'darwin') return;
    const root = path.join(
      process.cwd(),
      'data',
      `srt-ipc-policy-${process.pid}-${Date.now()}`,
    );
    const category = path.join(root, 'messages');
    const outside = path.join(root, 'outside');
    const snapshot = path.join(root, 'current_tasks.json');
    const settingsPath = path.join(root, 'settings.json');
    fs.mkdirSync(category, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(snapshot, 'SAFE');

    const settings = buildSandboxSettings([
      {
        hostPath: category,
        containerPath: '/workspace/ipc/messages',
        readonly: false,
      },
      {
        hostPath: path.join(root, '*'),
        containerPath: '/workspace/ipc/*',
        readonly: true,
        denyWriteOnly: true,
      },
    ]);
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    const env = {
      ...process.env,
      IPC_CATEGORY: category,
      IPC_OUTSIDE: outside,
      IPC_ROOT: root,
    };
    const srt = path.join(process.cwd(), 'node_modules', '.bin', 'srt');

    try {
      const normal = spawnSync(
        srt,
        [
          '-s',
          settingsPath,
          '-c',
          `node -e 'require("fs").mkdirSync(process.env.IPC_CATEGORY,{recursive:true})' && printf ok > "$IPC_CATEGORY/a.tmp" && mv "$IPC_CATEGORY/a.tmp" "$IPC_CATEGORY/a.json" && rm "$IPC_CATEGORY/a.json"`,
        ],
        { env, encoding: 'utf8' },
      );
      expect(normal.status, normal.stderr).toBe(0);

      const overwriteSnapshot = spawnSync(
        srt,
        [
          '-s',
          settingsPath,
          '-c',
          'printf PWNED > "$IPC_ROOT/current_tasks.json"',
        ],
        { env, encoding: 'utf8' },
      );
      expect(overwriteSnapshot.status).not.toBe(0);
      expect(fs.readFileSync(snapshot, 'utf8')).toBe('SAFE');

      const replaceCategory = spawnSync(
        srt,
        [
          '-s',
          settingsPath,
          '-c',
          'rmdir "$IPC_CATEGORY" && ln -s "$IPC_OUTSIDE" "$IPC_CATEGORY"',
        ],
        { env, encoding: 'utf8' },
      );
      expect(replaceCategory.status).not.toBe(0);
      expect(fs.lstatSync(category).isDirectory()).toBe(true);
      expect(fs.lstatSync(category).isSymbolicLink()).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sandbox provider credential isolation', () => {
  it('constructs only proxy placeholders for both API-key and OAuth modes', () => {
    const apiKey = buildSandboxCredentialProxyEnv({
      authMode: 'api-key',
      baseUrl: 'http://127.0.0.1:43210',
      clientSecret: 'ephemeral-placeholder',
      identityToken: 'signed-guest-identity',
    });
    expect(apiKey).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:43210',
      ANTHROPIC_API_KEY: 'ephemeral-placeholder',
      ANTHROPIC_CUSTOM_HEADERS:
        'x-skoobi-credential-proxy-identity: signed-guest-identity',
    });
    expect(apiKey.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    const oauth = buildSandboxCredentialProxyEnv({
      authMode: 'oauth',
      baseUrl: 'http://127.0.0.1:43211',
      clientSecret: 'ephemeral-placeholder',
      identityToken: 'signed-owner-identity',
    });
    expect(oauth.ANTHROPIC_API_KEY).toBeUndefined();
    expect(oauth.CLAUDE_CODE_OAUTH_TOKEN).toBe('ephemeral-placeholder');
    expect(oauth.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('fails guest Codex closed while keeping Claude and owner/main Codex allowed', () => {
    expect(sandboxProviderIsolationError('codex_cli', false)).toBe(
      GUEST_CODEX_PROVIDER_BLOCKED,
    );
    expect(sandboxProviderIsolationError('codex_cli', true)).toBeUndefined();
    expect(
      sandboxProviderIsolationError('codex_cli', false, true),
    ).toBeUndefined();
    expect(sandboxProviderIsolationError('claude_sdk', false)).toBeUndefined();
  });

  it('keeps personal WhatsApp Codex in an isolated guest filesystem and capability tier', () => {
    const group = makeGroup({
      isMain: true,
      agentConfig: {
        whatsappObserverAccess: true,
        fullAccess: true,
        noSandbox: true,
      },
    });
    const restricted = restrictRuntimeInputToAuthorizedTier(
      makeInput({
        chatJid: '77000000000@s.whatsapp.net',
        isMain: true,
        credentialProxyTier: 'owner',
        taskAuthorizationCapability: 'must-not-leak',
        codexControlRunId: '00000000-0000-4000-8000-000000000006',
        memoryWriteCapability: 'must-not-leak-memory',
        memoryProvenancePublicKey: 'must-not-leak-verifier',
        googleAllowedTools: ['google_drive_search'],
        googleSheetTargetHints: [
          {
            label: 'ledger',
            spreadsheetId: 'public-fixture-spreadsheet-id-0001',
            range: "'Лист1'!A47:G1000",
            columnCount: 7,
            maxRowsPerCall: 1,
          },
        ],
        agentConfig: group.agentConfig,
      }),
    );

    expect(restricted).toMatchObject({
      isMain: false,
      credentialProxyTier: 'guest',
      agentConfig: {
        whatsappObserverAccess: true,
        fullAccess: false,
        noSandbox: false,
      },
    });
    expect(restricted.taskAuthorizationCapability).toBeUndefined();
    expect(restricted.codexControlRunId).toBeUndefined();
    expect(restricted.memoryWriteCapability).toBeUndefined();
    expect(restricted.memoryProvenancePublicKey).toBeUndefined();
    expect(restricted.googleAllowedTools).toBeUndefined();
    expect(restricted.googleSheetTargetHints).toBeUndefined();

    const mounts = buildSandboxMounts(
      group,
      true,
      undefined,
      restricted.credentialProxyTier,
      restricted.chatJid,
    );
    expect(
      mounts.find(
        (mount) => mount.containerPath === '/workspace/project' && !mount.deny,
      ),
    ).toBeUndefined();
    expect(
      mounts.find((mount) => mount.containerPath === '/workspace/group'),
    ).toMatchObject({
      hostPath: '/tmp/test-groups/test-group',
      readonly: false,
    });
    expect(
      mounts.find(
        (mount) =>
          mount.hostPath === path.join(process.cwd(), 'store') && mount.deny,
      ),
    ).toBeDefined();
    expect(
      mounts.find((mount) => mount.containerPath === '/workspace/ipc/input'),
    ).toMatchObject({ readonly: false });
    for (const category of ['messages', 'tasks', 'swe', 'memory', 'google']) {
      expect(
        mounts.find(
          (mount) => mount.containerPath === `/workspace/ipc/${category}`,
        ),
      ).toMatchObject({ readonly: true, deny: true });
    }
    expect(
      mounts.find(
        (mount) => mount.containerPath === '/workspace/ipc/current_tasks.json',
      ),
    ).toMatchObject({ readonly: true, deny: true });

    const settings = buildSandboxSettings(mounts);
    expect(settings.filesystem.allowWrite).toContain(
      '/tmp/test-groups/test-group',
    );
    for (const instructionFile of ['CLAUDE.md', 'AGENTS.md']) {
      expect(settings.filesystem.denyWrite).toContain(
        path.join('/tmp/test-groups/test-group', instructionFile),
      );
    }

    const ownerShapedMounts = buildSandboxMounts(
      group,
      true,
      undefined,
      'owner',
      '77000000000@s.whatsapp.net',
    );
    expect(
      ownerShapedMounts.find(
        (mount) => mount.containerPath === '/workspace/project' && !mount.deny,
      ),
    ).toBeUndefined();
    expect(
      ownerShapedMounts.find(
        (mount) => mount.containerPath === '/workspace/ipc/messages',
      ),
    ).toMatchObject({ readonly: true, deny: true });
  });

  it('rejects a guest Codex run before spawn or auth.json preparation', async () => {
    const output = await runSandboxAgent(
      makeGroup(),
      makeInput({
        provider: 'codex_cli',
        codex: { command: '/usr/bin/false', model: 'test' },
        credentialProxyTier: 'guest',
      }),
      () => {},
    );
    expect(output).toEqual({
      status: 'error',
      result: null,
      error: GUEST_CODEX_PROVIDER_BLOCKED,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'Telegram chat',
      groupObserverAccess: true,
      isMain: true,
      chatJid: '123456789@telegram',
    },
    {
      label: 'WhatsApp without observer opt-in',
      groupObserverAccess: false,
      isMain: true,
      chatJid: '77000000000@s.whatsapp.net',
    },
    {
      label: 'non-main WhatsApp group',
      groupObserverAccess: true,
      isMain: false,
      chatJid: '77000000000@s.whatsapp.net',
    },
  ])(
    'does not extend isolated observer Codex auth to $label',
    async ({ groupObserverAccess, isMain, chatJid }) => {
      const output = await runSandboxAgent(
        makeGroup({
          isMain,
          agentConfig: { whatsappObserverAccess: groupObserverAccess },
        }),
        makeInput({
          provider: 'codex_cli',
          codex: { command: '/usr/bin/false', model: 'test' },
          isMain,
          chatJid,
          credentialProxyTier: 'guest',
        }),
        () => {},
      );
      expect(output.error).toBe(GUEST_CODEX_PROVIDER_BLOCKED);
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it('never propagates an isolated observer auth refresh to the trusted store', () => {
    expect(shouldPersistCodexAuthRefresh(false, true)).toBe(false);
    // Defense in depth: even a future trust-tier regression must not make an
    // explicitly observer-scoped copy eligible for central propagation.
    expect(shouldPersistCodexAuthRefresh(true, true)).toBe(false);
    expect(shouldPersistCodexAuthRefresh(true, false)).toBe(true);
  });

  it.each([
    {
      label: 'registered group is not main',
      groupIsMain: false,
      inputFolder: 'test-group',
    },
    {
      label: 'serialized group folder does not match',
      groupIsMain: true,
      inputFolder: 'different-group',
    },
  ])('fails isolated observer scope closed when $label', async (fixture) => {
    const output = await runSandboxAgent(
      makeGroup({
        isMain: fixture.groupIsMain,
        agentConfig: { whatsappObserverAccess: true },
      }),
      makeInput({
        provider: 'codex_cli',
        codex: { command: '/usr/bin/false', model: 'test' },
        groupFolder: fixture.inputFolder,
        isMain: true,
        chatJid: '77000000000@s.whatsapp.net',
        credentialProxyTier: 'owner',
      }),
      () => {},
    );
    expect(output.error).toMatch(/registered group scope mismatch/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects isolated observer Codex off macOS before preparing or spawning it', async () => {
    const platformSpy = vi.spyOn(os, 'platform').mockReturnValue('linux');
    try {
      const output = await runSandboxAgent(
        makeGroup({
          isMain: true,
          agentConfig: {
            whatsappObserverAccess: true,
            fullAccess: true,
            noSandbox: true,
          },
        }),
        makeInput({
          provider: 'codex_cli',
          codex: { command: '/usr/bin/false', model: 'test' },
          isMain: true,
          chatJid: '77000000000@s.whatsapp.net',
          credentialProxyTier: 'owner',
          // Deliberately omit the observer bit from input.agentConfig. The
          // group registry must still force a guest-tier sandbox and must not
          // honor the fullAccess/noSandbox mismatch above.
        }),
        () => {},
      );
      expect(output.error).toMatch(/supported only on macOS/);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('redacts proxy capabilities and credential-shaped output before delivery', () => {
    const output = redactSandboxOutput(
      {
        status: 'success',
        result:
          'placeholder=one-run-placeholder authorization=Bearer leaked-value',
        error: 'x-skoobi=tenant-identity-token',
      },
      ['one-run-placeholder', 'tenant-identity-token'],
    );
    expect(output.result).not.toContain('one-run-placeholder');
    expect(output.result).not.toContain('leaked-value');
    expect(output.error).not.toContain('tenant-identity-token');
    expect(output.result).toContain('[REDACTED]');
  });

  it('redacts a leaked one-run placeholder from streamed reply output', async () => {
    let child: FakeChild | undefined;
    let childEnv: Record<string, string> | undefined;
    vi.mocked(spawn).mockImplementation((_cmd: any, _args: any, opts: any) => {
      childEnv = opts.env;
      child = new FakeChild();
      return child as any;
    });
    const onOutput = vi.fn(async (_output: ContainerOutput) => {});
    const run = runSandboxAgent(
      makeGroup(),
      makeInput({ credentialProxyTier: 'guest' }),
      () => {},
      onOutput,
    );
    await vi.waitFor(() => expect(child).toBeDefined());
    const placeholder = childEnv?.ANTHROPIC_API_KEY;
    expect(placeholder).toMatch(/^[0-9a-f]{64}$/);
    child!.stdout.emit(
      'data',
      `${OUTPUT_START}${JSON.stringify({
        status: 'success',
        result: `env said ANTHROPIC_API_KEY=${placeholder}`,
      })}${OUTPUT_END}`,
    );
    child!.emit('close', 0);
    await run;
    await vi.waitFor(() => expect(onOutput).toHaveBeenCalledTimes(1));
    const delivered = onOutput.mock.calls[0][0] as ContainerOutput;
    expect(delivered.result).toContain('ANTHROPIC_API_KEY=[REDACTED]');
    expect(delivered.result).not.toContain(placeholder);
  });

  it('redacts a placeholder split across stderr chunks and omits malformed-frame snippets', async () => {
    let child: FakeChild | undefined;
    let childEnv: Record<string, string> | undefined;
    vi.mocked(spawn).mockImplementation((_cmd: any, _args: any, opts: any) => {
      childEnv = opts.env;
      child = new FakeChild();
      return child as any;
    });
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.warn).mockClear();
    const run = runSandboxAgent(
      makeGroup(),
      makeInput({ credentialProxyTier: 'guest' }),
      () => {},
      vi.fn(async () => {}),
    );
    await vi.waitFor(() => expect(child).toBeDefined());
    const placeholder = childEnv?.ANTHROPIC_API_KEY;
    expect(placeholder).toMatch(/^[0-9a-f]{64}$/);
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.warn).mockClear();
    const splitAt = Math.floor(placeholder!.length / 2);
    child!.stderr.emit('data', placeholder!.slice(0, splitAt));
    expect(logger.debug).not.toHaveBeenCalled();
    child!.stderr.emit('data', `${placeholder!.slice(splitAt)}\n`);
    child!.stdout.emit('data', `${OUTPUT_START}${placeholder}${OUTPUT_END}`);
    child!.emit('close', 0);
    await run;

    const diagnostics = JSON.stringify([
      vi.mocked(logger.debug).mock.calls,
      vi.mocked(logger.warn).mock.calls,
    ]);
    expect(diagnostics).toContain('[REDACTED]');
    expect(diagnostics).toContain('Invalid JSON output frame');
    expect(diagnostics).not.toContain(placeholder);
    expect(diagnostics).not.toContain(placeholder!.slice(0, 16));
  });

  it('returns a generic legacy parse error without echoing malformed placeholder input', async () => {
    let child: FakeChild | undefined;
    let childEnv: Record<string, string> | undefined;
    vi.mocked(spawn).mockImplementation((_cmd: any, _args: any, opts: any) => {
      childEnv = opts.env;
      child = new FakeChild();
      return child as any;
    });
    const run = runSandboxAgent(
      makeGroup(),
      makeInput({ credentialProxyTier: 'guest' }),
      () => {},
    );
    await vi.waitFor(() => expect(child).toBeDefined());
    const placeholder = childEnv?.ANTHROPIC_API_KEY;
    expect(placeholder).toMatch(/^[0-9a-f]{64}$/);
    child!.stdout.emit('data', `${OUTPUT_START}${placeholder}${OUTPUT_END}`);
    child!.emit('close', 0);
    const result = await run;

    expect(result.status).toBe('error');
    expect(result.error).toBe(
      'Failed to parse sandbox output: Invalid JSON output frame',
    );
    expect(result.error).not.toContain(placeholder!.slice(0, 16));
  });

  it('always denies host Codex/OpenAI credential directories to guests', () => {
    const mounts = buildSandboxMounts(makeGroup(), false);
    for (const sensitive of ['.codex', '.config/openai']) {
      expect(mounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            hostPath: path.join(os.homedir(), sensitive),
            deny: true,
          }),
        ]),
      );
    }
  });
});

describe('sandbox credential-proxy lifecycle failures', () => {
  async function expectProxyClosed(baseUrl: string | undefined): Promise<void> {
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await vi.waitFor(
      async () => {
        const reachable = await fetch(baseUrl!, {
          signal: AbortSignal.timeout(250),
        }).then(
          () => true,
          () => false,
        );
        expect(reachable).toBe(false);
      },
      { timeout: 1500, interval: 25 },
    );
  }

  it('closes the listener and all established/idle connections', () => {
    const calls: string[] = [];
    closeSandboxCredentialProxyServer({
      close: vi.fn(() => {
        calls.push('close');
      }),
      closeIdleConnections: vi.fn(() => {
        calls.push('idle');
      }),
      closeAllConnections: vi.fn(() => {
        calls.push('all');
      }),
    } as any);
    expect(calls).toEqual(['close', 'idle', 'all']);
  });

  it('kills the detached child, closes proxy, and removes listeners when onProcess throws', async () => {
    let child!: FakeChild;
    let baseUrl: string | undefined;
    vi.mocked(spawn).mockImplementation((_cmd: any, _args: any, opts: any) => {
      baseUrl = opts.env.ANTHROPIC_BASE_URL;
      child = new FakeChild();
      return child as any;
    });

    const output = await runSandboxAgent(
      makeGroup(),
      makeInput({ credentialProxyTier: 'guest' }),
      () => {
        throw new Error('onProcess fixture failure');
      },
    );

    expect(output.status).toBe('error');
    expect(output.error).toContain('onProcess fixture failure');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.listenerCount('close')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
    await expectProxyClosed(baseUrl);
  });

  it('kills the detached child and closes proxy when the initial stdin write throws', async () => {
    let child!: FakeChild;
    let baseUrl: string | undefined;
    vi.mocked(spawn).mockImplementation((_cmd: any, _args: any, opts: any) => {
      baseUrl = opts.env.ANTHROPIC_BASE_URL;
      child = new FakeChild();
      child.stdin.write.mockImplementation(() => {
        throw new Error('stdin write fixture failure');
      });
      return child as any;
    });
    const onProcess = vi.fn();

    const output = await runSandboxAgent(
      makeGroup(),
      makeInput({ credentialProxyTier: 'guest' }),
      onProcess,
    );

    expect(onProcess).toHaveBeenCalledTimes(1);
    expect(output.status).toBe('error');
    expect(output.error).toContain('stdin write fixture failure');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.listenerCount('close')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
    await expectProxyClosed(baseUrl);
  });

  it('kills the detached child and closes proxy when PID persistence throws', async () => {
    let child!: FakeChild;
    let baseUrl: string | undefined;
    vi.mocked(spawn).mockImplementation((_cmd: any, _args: any, opts: any) => {
      baseUrl = opts.env.ANTHROPIC_BASE_URL;
      child = new FakeChild();
      return child as any;
    });
    const originalWriteFileSync = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...args: any[]
    ) => {
      if (String(file).endsWith('.pid')) {
        throw new Error('pid write fixture failure');
      }
      return (originalWriteFileSync as any)(file, ...args);
    }) as typeof fs.writeFileSync);

    try {
      const output = await runSandboxAgent(
        makeGroup(),
        makeInput({ credentialProxyTier: 'guest' }),
        () => {},
      );
      expect(output.status).toBe('error');
      expect(output.error).toContain('pid write fixture failure');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(child.listenerCount('close')).toBe(0);
      await expectProxyClosed(baseUrl);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Codex provider support: auth preparation is now owner/main-only. Authorized
// owner runs retain their per-group CODEX_HOME and trusted refresh propagation;
// guest runs are rejected before this code can create or mount auth.json.
// ---------------------------------------------------------------------------
describe('codex provider auth preparation', () => {
  let root: string;
  let dataDir: string;
  let homeDir: string;

  const centralAuth = () => path.join(dataDir, 'codex-auth', 'auth.json');
  const hostAuth = () => path.join(homeDir, '.codex', 'auth.json');
  // CODEX_HOME lives under data/codex-homes/<group> — deliberately NOT under
  // the guest HOME (data/sessions/<group>, RW-mounted every run).
  const groupAuth = (folder: string) =>
    path.join(dataDir, 'codex-homes', folder, 'auth.json');

  const writeWithMtime = (file: string, body: string, mtimeMs: number) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join('/tmp', 'codex-auth-test-'));
    dataDir = path.join(root, 'data');
    homeDir = path.join(root, 'home');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails closed when no auth.json exists anywhere', () => {
    const result = prepareCodexHomeForRun('telegram_test', {
      dataDir,
      homeDir,
    });
    expect('error' in result && result.error).toMatch(/codex login/i);
  });

  it('places CODEX_HOME OUTSIDE the guest HOME tree (data/sessions/<group>)', () => {
    writeWithMtime(hostAuth(), '{"tokens":"host"}', Date.now());
    const result = prepareCodexHomeForRun('telegram_test', {
      dataDir,
      homeDir,
    });
    expect('codexHome' in result).toBe(true);
    const home = (result as { codexHome: string }).codexHome;
    // Must NOT be under data/sessions/<group> (the guest HOME mount).
    expect(home.startsWith(path.join(dataDir, 'sessions'))).toBe(false);
    expect(home).toBe(path.join(dataDir, 'codex-homes', 'telegram_test'));
  });

  it('cleanupCodexAuth removes the token copy but keeps codex session files', () => {
    writeWithMtime(hostAuth(), '{"tokens":"host"}', Date.now());
    prepareCodexHomeForRun('telegram_test', { dataDir, homeDir });
    const home = path.join(dataDir, 'codex-homes', 'telegram_test');
    // Simulate a codex rollout/session file written during the run.
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'sessions', 'rollout.jsonl'), 'x');
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(true);
    cleanupCodexAuth('telegram_test', dataDir);
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(false);
    // Session/rollout files survive for `codex exec resume`.
    expect(fs.existsSync(path.join(home, 'sessions', 'rollout.jsonl'))).toBe(
      true,
    );
  });

  it('persistTrustedCodexAuthRefresh propagates a newer valid group token back to central', () => {
    writeWithMtime(centralAuth(), '{"tokens":"old"}', 1000);
    writeWithMtime(groupAuth('telegram_main'), '{"tokens":"refreshed"}', 5000);
    persistTrustedCodexAuthRefresh('telegram_main', dataDir);
    expect(fs.readFileSync(centralAuth(), 'utf-8')).toBe(
      '{"tokens":"refreshed"}',
    );
  });

  it('persistTrustedCodexAuthRefresh NEVER propagates a corrupt/truncated token', () => {
    writeWithMtime(centralAuth(), '{"tokens":"good"}', 1000);
    writeWithMtime(groupAuth('telegram_main'), '{"tokens":"trunca', 5000); // invalid JSON
    persistTrustedCodexAuthRefresh('telegram_main', dataDir);
    expect(fs.readFileSync(centralAuth(), 'utf-8')).toBe('{"tokens":"good"}');
  });

  it('persistTrustedCodexAuthRefresh does nothing when the group copy is older than central', () => {
    writeWithMtime(centralAuth(), '{"tokens":"newer-central"}', 9000);
    writeWithMtime(groupAuth('telegram_main'), '{"tokens":"stale"}', 1000);
    persistTrustedCodexAuthRefresh('telegram_main', dataDir);
    expect(fs.readFileSync(centralAuth(), 'utf-8')).toBe(
      '{"tokens":"newer-central"}',
    );
  });

  it('seeds the group and central copies from ~/.codex', () => {
    writeWithMtime(hostAuth(), '{"tokens":"host"}', Date.now() - 1000);
    const result = prepareCodexHomeForRun('telegram_test', {
      dataDir,
      homeDir,
    });
    expect('codexHome' in result).toBe(true);
    expect(fs.readFileSync(groupAuth('telegram_test'), 'utf-8')).toBe(
      '{"tokens":"host"}',
    );
    expect(fs.readFileSync(centralAuth(), 'utf-8')).toBe('{"tokens":"host"}');
    const mode = fs.statSync(groupAuth('telegram_test')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('NEVER trusts the group copy: a tampered auth.json with a forged future mtime is clobbered', () => {
    const now = Date.now();
    writeWithMtime(hostAuth(), '{"tokens":"host"}', now - 60_000);
    writeWithMtime(centralAuth(), '{"tokens":"central"}', now - 120_000);
    // Malicious guest wrote its own auth.json and forged a FUTURE mtime.
    writeWithMtime(
      groupAuth('telegram_test'),
      '{"tokens":"EVIL"}',
      now + 3_600_000,
    );
    const result = prepareCodexHomeForRun('telegram_test', {
      dataDir,
      homeDir,
    });
    expect('codexHome' in result).toBe(true);
    // Group copy is overwritten from the trusted source…
    expect(fs.readFileSync(groupAuth('telegram_test'), 'utf-8')).toBe(
      '{"tokens":"host"}',
    );
    // …and the tampered token never reaches the central copy or ~/.codex.
    expect(fs.readFileSync(centralAuth(), 'utf-8')).toBe('{"tokens":"host"}');
    expect(fs.readFileSync(hostAuth(), 'utf-8')).toBe('{"tokens":"host"}');
  });

  it('atomically replaces a crash-left auth symlink without writing its target', () => {
    writeWithMtime(hostAuth(), '{"tokens":"host"}', Date.now());
    const outside = path.join(root, 'outside-secret');
    fs.writeFileSync(outside, 'DO_NOT_OVERWRITE');
    fs.mkdirSync(path.dirname(groupAuth('telegram_test')), {
      recursive: true,
    });
    fs.symlinkSync(outside, groupAuth('telegram_test'));

    const result = prepareCodexHomeForRun('telegram_test', {
      dataDir,
      homeDir,
    });
    expect('codexHome' in result).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('DO_NOT_OVERWRITE');
    expect(fs.lstatSync(groupAuth('telegram_test')).isSymbolicLink()).toBe(
      false,
    );
    expect(fs.readFileSync(groupAuth('telegram_test'), 'utf8')).toBe(
      '{"tokens":"host"}',
    );
  });

  it('atomically replaces a crash-left auth hardlink without modifying the other link', () => {
    writeWithMtime(hostAuth(), '{"tokens":"host"}', Date.now());
    const outside = path.join(root, 'outside-hardlink');
    fs.writeFileSync(outside, 'DO_NOT_OVERWRITE');
    fs.mkdirSync(path.dirname(groupAuth('telegram_test')), {
      recursive: true,
    });
    fs.linkSync(outside, groupAuth('telegram_test'));

    const result = prepareCodexHomeForRun('telegram_test', {
      dataDir,
      homeDir,
    });
    expect('codexHome' in result).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('DO_NOT_OVERWRITE');
    expect(fs.readFileSync(groupAuth('telegram_test'), 'utf8')).toBe(
      '{"tokens":"host"}',
    );
    expect(fs.statSync(groupAuth('telegram_test')).ino).not.toBe(
      fs.statSync(outside).ino,
    );
  });

  it('seeds a new group from the central copy when host auth is older', () => {
    const now = Date.now();
    writeWithMtime(hostAuth(), '{"tokens":"stale-host"}', now - 60_000);
    writeWithMtime(centralAuth(), '{"tokens":"central"}', now);
    const result = prepareCodexHomeForRun('telegram_new', {
      dataDir,
      homeDir,
    });
    expect('codexHome' in result).toBe(true);
    expect(fs.readFileSync(groupAuth('telegram_new'), 'utf-8')).toBe(
      '{"tokens":"central"}',
    );
    // A stale host copy must not clobber the newer central one.
    expect(fs.readFileSync(centralAuth(), 'utf-8')).toBe(
      '{"tokens":"central"}',
    );
  });

  it('works with only the central copy present (no ~/.codex on host)', () => {
    writeWithMtime(centralAuth(), '{"tokens":"central-only"}', Date.now());
    const result = prepareCodexHomeForRun('telegram_test', {
      dataDir,
      homeDir,
    });
    expect('codexHome' in result).toBe(true);
    expect(fs.readFileSync(groupAuth('telegram_test'), 'utf-8')).toBe(
      '{"tokens":"central-only"}',
    );
  });

  it('exposes ChatGPT/OpenAI endpoints for the codex sandbox allowlist', () => {
    for (const domain of CODEX_SANDBOX_DOMAINS) {
      expect(isSandboxSafeDomain(domain)).toBe(true);
    }
    const settings = buildSandboxSettings([], CODEX_SANDBOX_DOMAINS);
    expect(settings.network.allowedDomains).toEqual(
      expect.arrayContaining(['chatgpt.com', '*.openai.com']),
    );
    // Claude-run settings must NOT get the OpenAI endpoints implicitly.
    const claudeSettings = buildSandboxSettings([], []);
    expect(claudeSettings.network.allowedDomains).not.toContain('chatgpt.com');
  });
});
