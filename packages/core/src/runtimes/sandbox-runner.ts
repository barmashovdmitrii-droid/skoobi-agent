/**
 * Sandbox runtime for ClaudeClaw.
 *
 * Uses OS-level sandboxing (Seatbelt on macOS, bubblewrap on Linux) via
 * @anthropic-ai/sandbox-runtime for near-zero-overhead agent execution.
 *
 * Key differences from container-runner.ts:
 * - No container daemon dependency — spawns a sandboxed node process directly
 * - Near-zero overhead (<10ms cold start vs seconds for containers)
 * - Host credential proxy + network restricted to allowedDomains
 * - Orphan cleanup via PID files in data/sandbox-pids/
 * - Agent runner pre-compiled on host at agent/runner/dist/index.js
 */
import { ChildProcess, execFileSync, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../orchestrator/env.js';
import {
  CODE_ROOT,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  RUNNER_IDLE_WAIT_MS,
  TIMEZONE,
} from '../orchestrator/config.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../orchestrator/group-folder.js';
import {
  ensureIpcDirectoryLayout,
  IPC_CATEGORY_DIRECTORY_NAMES,
  writeFileAtomicNoFollowSync,
} from '../orchestrator/ipc-paths.js';
import { logger } from '../orchestrator/logger.js';
import { validateAdditionalMounts } from '../orchestrator/mount-security.js';
import { killProcessTree } from '../orchestrator/process-tree.js';
import { onRunIpcActivity } from '../orchestrator/run-activity.js';
import { RegisteredGroup, type SenderIdentity } from '../orchestrator/types.js';
import { getExtensionAllowedDomains } from '../orchestrator/extension-loader.js';
import {
  ensureSafeGuestRuntimeDirectory,
  ensureSafeRuntimeReceivedDirectory,
  prepareRuntimeClaudeHome,
  createRedactedDiagnosticLineBuffer,
  redactContainerRuntimeDiagnostics,
  restrictRuntimeInputToAuthorizedTier,
  type ContainerInput,
  type ContainerOutput,
} from './container-runner.js';
import { safeSharedMemoryKey } from '../orchestrator/memory-context.js';
import {
  shouldUseUntrustedMainRuntimeNamespace,
  untrustedMainRuntimePaths,
} from '../orchestrator/runtime-namespace.js';
import { BoundedOutputFrameParser } from './bounded-output-parser.js';
import {
  CREDENTIAL_PROXY_IDENTITY_HEADER,
  createCredentialProxyIdentityToken,
  detectAuthMode,
  revokeCredentialProxyIdentityToken,
  startCredentialProxy,
  type AuthMode,
} from '../orchestrator/credential-proxy.js';

export { killProcessTree } from '../orchestrator/process-tree.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---CLAUDECLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CLAUDECLAW_OUTPUT_END---';

const SANDBOX_PID_DIR = path.join(DATA_DIR, 'sandbox-pids');
const SANDBOX_GUEST_HOME = ['/home', 'node'].join('/');
const SANDBOX_GUEST_CLAUDE_HOME = `${SANDBOX_GUEST_HOME}/.claude`;

const OWNER_ONLY_RUNNER_ENV_KEYS = [
  'HELPER_SECRET',
  'HELPER_PORT',
  'SKOOBI_GOOGLE_WORKSPACE_ENABLED',
  'SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID',
  'SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET',
  'SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN',
  'SKOOBI_GOOGLE_WORKSPACE_SCOPES',
  'SKOOBI_GOOGLE_WORKSPACE_DEFAULT_SCRIPT_ID',
  'SKOOBI_GOOGLE_WORKSPACE_ALLOWED_RESOURCE_IDS',
  'CLAUDECLAW_MEMORY_WRITE_CAPABILITY',
  'CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY',
] as const;

const HOST_PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'OPENAI_API_KEY',
  'CODEX_HOME',
] as const;

const GUEST_RUNNER_ENV_ALLOWLIST = new Set([
  'PATH',
  'PWD',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TZ',
  'SHELL',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_TIME',
  'LC_NUMERIC',
  'LC_COLLATE',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'CI',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
]);

const GUEST_TLS_PATH_ENV_KEYS = new Set([
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);

function safeGuestInheritedValue(
  key: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  if (GUEST_TLS_PATH_ENV_KEYS.has(key)) {
    return path.isAbsolute(value) ? path.normalize(value) : undefined;
  }
  if (!/_proxy$/i.test(key)) return value;
  if (/^no_proxy$/i.test(key)) return value;
  // A proxy URL with userinfo is itself a credential. The srt wrapper may
  // still install its own local proxy after spawn; only benign operator proxy
  // wiring is inherited from the host environment.
  try {
    const parsed = new URL(value);
    if (
      parsed.username ||
      parsed.password ||
      !['http:', 'https:', 'socks:', 'socks5:', 'socks5h:'].includes(
        parsed.protocol,
      )
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return value;
}

export const GUEST_CODEX_PROVIDER_BLOCKED =
  'GUEST_CODEX_PROVIDER_BLOCKED: codex_cli is disabled for guest sandbox runs because Codex requires a readable auth.json; retry with the proxied Claude provider or use an authorized owner/main run.';

/**
 * Codex cannot authenticate without exposing $CODEX_HOME/auth.json to its own
 * Bash/tool descendants. Normal guests therefore remain blocked. A dedicated
 * personal-observer workspace may opt into an isolated, ephemeral auth copy;
 * that exception still runs at guest tier and never receives owner mounts,
 * helper secrets, or IPC capabilities.
 */
export function sandboxProviderIsolationError(
  provider: ContainerInput['provider'],
  trustedOwner: boolean,
  isolatedObserverAuth = false,
): string | undefined {
  return provider === 'codex_cli' && !trustedOwner && !isolatedObserverAuth
    ? GUEST_CODEX_PROVIDER_BLOCKED
    : undefined;
}

/** Publicly testable construction of the credential-proxy-only child env. */
export function buildSandboxCredentialProxyEnv(input: {
  authMode: AuthMode;
  baseUrl: string;
  clientSecret: string;
  identityToken: string;
}): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: input.baseUrl,
    ...(input.authMode === 'api-key'
      ? { ANTHROPIC_API_KEY: input.clientSecret }
      : { CLAUDE_CODE_OAUTH_TOKEN: input.clientSecret }),
    ANTHROPIC_CUSTOM_HEADERS: `${CREDENTIAL_PROXY_IDENTITY_HEADER}: ${input.identityToken}`,
  };
}

/**
 * Start every runner with a secret-clean inherited environment. Owner-only
 * values are re-injected explicitly below for an authorized owner run; absence
 * of an overlay must never mean "inherit whatever launchd exported".
 */
export function sandboxChildBaseEnv(
  source: NodeJS.ProcessEnv,
  trustedOwner = false,
): NodeJS.ProcessEnv {
  if (!trustedOwner) {
    const guest: NodeJS.ProcessEnv = {};
    for (const key of GUEST_RUNNER_ENV_ALLOWLIST) {
      const value = safeGuestInheritedValue(key, source[key]);
      if (value !== undefined) guest[key] = value;
    }
    return guest;
  }

  const out = { ...source };
  for (const key of OWNER_ONLY_RUNNER_ENV_KEYS) delete out[key];
  // Provider auth is never inherited, including for owner/main. Claude gets a
  // one-run proxy placeholder below; trusted Codex gets an explicitly prepared
  // per-run CODEX_HOME. This prevents a hostile launch environment from
  // silently bypassing either boundary.
  for (const key of HOST_PROVIDER_ENV_KEYS) delete out[key];
  for (const key of Object.keys(out)) {
    if (
      key.startsWith('SKOOBI_GOOGLE_') ||
      key === 'GOOGLE_APPLICATION_CREDENTIALS' ||
      key === 'GOOGLE_API_KEY'
    ) {
      delete out[key];
    }
  }
  return out;
}

export function redactSandboxOutput(
  output: ContainerOutput,
  exactSecrets: readonly string[],
): ContainerOutput {
  return {
    ...output,
    result:
      typeof output.result === 'string'
        ? redactContainerRuntimeDiagnostics(output.result, exactSecrets)
        : output.result,
    ...(typeof output.error === 'string'
      ? {
          error: redactContainerRuntimeDiagnostics(output.error, exactSecrets),
        }
      : {}),
  };
}

/** Close the listener and destroy already-established keep-alive sockets. */
export function closeSandboxCredentialProxyServer(
  server: Awaited<ReturnType<typeof startCredentialProxy>> | undefined,
): void {
  if (!server) return;
  // close() stops new accepts; the two connection methods ensure an existing
  // guest socket cannot keep replaying the otherwise-ephemeral placeholder.
  server.close();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
}

// ---------------------------------------------------------------------------
// Settings types
// ---------------------------------------------------------------------------

export interface SandboxSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
  };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
}

interface SandboxMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
  deny?: boolean;
  denyWriteOnly?: boolean;
  /** Emit an explicit read carve-out in addition to this mount's write mode. */
  allowRead?: boolean;
}

/**
 * True if `ancestor` equals `descendant` or contains it (descendant lies within
 * ancestor's subtree). Used to detect an allowRead entry that would re-allow a
 * nested denyRead target.
 */
function pathContainsPath(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const rel = path.relative(ancestor, descendant);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isolatedObserverCodexHomePaths(
  codexHome: string,
  dataDir: string,
): { parent: string; child: string } {
  if (
    !path.isAbsolute(dataDir) ||
    !path.isAbsolute(codexHome) ||
    path.resolve(dataDir) !== dataDir ||
    path.resolve(codexHome) !== codexHome
  ) {
    throw new Error(
      'Isolated observer CODEX_HOME paths must be normalized and absolute',
    );
  }
  const parent = path.resolve(dataDir, 'codex-homes');
  const child = path.resolve(codexHome);
  const relative = path.relative(parent, child);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    throw new Error(
      'Isolated observer CODEX_HOME must be one exact codex-homes child',
    );
  }
  const dataStat = fs.lstatSync(dataDir);
  const parentStat = fs.lstatSync(parent);
  const childStat = fs.lstatSync(child);
  const realData = fs.realpathSync(dataDir);
  const realParent = fs.realpathSync(parent);
  const realChild = fs.realpathSync(child);
  if (
    !dataStat.isDirectory() ||
    dataStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    !childStat.isDirectory() ||
    childStat.isSymbolicLink() ||
    realParent !== path.join(realData, 'codex-homes') ||
    path.dirname(realChild) !== realParent ||
    path.basename(realChild) !== path.basename(child)
  ) {
    throw new Error(
      'Isolated observer CODEX_HOME must be a real owner-prepared directory',
    );
  }
  return { parent, child };
}

/**
 * Drop the normal guest deny of all codex homes and add one exact child
 * read/write allow. The mandatory final macOS Seatbelt policy supplies the
 * non-enumerative parent-minus-child read/unlink boundary; keeping a parent
 * denyRead in SRT would also shadow atomic rename/unlink inside the child.
 */
export function applyIsolatedObserverCodexHomeCarveOut(
  mounts: SandboxMount[],
  codexHome: string,
  dataDir = DATA_DIR,
  platform: NodeJS.Platform = os.platform(),
): void {
  if (platform !== 'darwin') {
    throw new Error(
      'Isolated observer Codex sandbox is supported only on macOS',
    );
  }
  const { parent, child } = isolatedObserverCodexHomePaths(codexHome, dataDir);
  const retained = mounts.filter(
    (mount) => mount.hostPath !== parent && mount.hostPath !== child,
  );
  mounts.splice(0, mounts.length, ...retained, {
    hostPath: child,
    containerPath: '/workspace/codex-home',
    readonly: false,
    allowRead: true,
  });
}

/** Fail closed if the exact isolated-Codex carve-out changes shape. */
export function assertIsolatedObserverCodexHomeCarveOut(
  settings: SandboxSettings,
  codexHome: string,
  dataDir = DATA_DIR,
  platform: NodeJS.Platform = os.platform(),
): void {
  if (platform !== 'darwin') {
    throw new Error(
      'Isolated observer Codex sandbox is supported only on macOS',
    );
  }
  const { parent, child } = isolatedObserverCodexHomePaths(codexHome, dataDir);
  const { denyRead, allowRead, allowWrite, denyWrite } = settings.filesystem;
  if (denyRead.some((denied) => pathContainsPath(denied, child))) {
    throw new Error(
      'Isolated observer CODEX_HOME is shadowed by an SRT read deny',
    );
  }
  if (
    allowRead.filter((allowed) => allowed === child).length !== 1 ||
    allowWrite.filter((allowed) => allowed === child).length !== 1
  ) {
    throw new Error(
      'Isolated observer CODEX_HOME exact read/write allow is missing',
    );
  }
  if (denyWrite.some((denied) => pathContainsPath(denied, child))) {
    throw new Error('Isolated observer CODEX_HOME is shadowed by a write deny');
  }
  for (const allowed of [...allowRead, ...allowWrite]) {
    if (
      allowed !== child &&
      (pathContainsPath(parent, allowed) || pathContainsPath(allowed, parent))
    ) {
      throw new Error(
        'Isolated observer CODEX_HOME policy exposes a parent or sibling',
      );
    }
  }
}

/**
 * `srt` 0.0.42 emits read rules as allow-all + enumerated denies. Enumerating
 * siblings is not a stable boundary: another host process can create a new
 * sibling after settings assembly and the running guest can read it. On macOS
 * we therefore append non-enumerative Seatbelt rules at the final
 * `/usr/bin/sandbox-exec` boundary (see scripts/guest-sandbox-bin/sandbox-exec).
 */
export const GUEST_MAC_SHARED_READ_ROOTS = [
  '/Volumes',
  '/Network',
  '/tmp',
  '/var/tmp',
  '/var/folders',
] as const;

export const GUEST_SEATBELT_POLICY_ENV = 'CLAUDECLAW_GUEST_SEATBELT_POLICY_B64';
export const GUEST_SANDBOX_EXEC_WRAPPER_DIR = path.join(
  CODE_ROOT,
  'scripts',
  'guest-sandbox-bin',
);

export interface GuestSeatbeltBoundary {
  parent: string;
  allowedSubtrees: string[];
}

export interface GuestSeatbeltPolicy {
  version: 1;
  boundaries: GuestSeatbeltBoundary[];
  envRoots: string[];
}

export interface GuestSeatbeltPolicyInput {
  projectRoot: string;
  mountRoot: string | null;
  hostControlledReadRoots: readonly string[];
  restrictedParents: readonly {
    parent: string;
    allowedSubtrees: readonly string[];
  }[];
  sharedReadRoots?: readonly string[];
  resolveHostPath?: (value: string) => string;
}

const MAX_GUEST_SEATBELT_PATH_LENGTH = 4096;

function assertNormalizedAbsoluteSeatbeltPath(
  value: string,
  label: string,
  allowFilesystemRoot = false,
): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_GUEST_SEATBELT_PATH_LENGTH ||
    /[\x00-\x1f\x7f]/.test(value) ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    (!allowFilesystemRoot && path.dirname(value) === value)
  ) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
}

function canonicalSeatbeltPath(
  value: string,
  resolveHostPath: (value: string) => string,
): string {
  const absolute = path.resolve(value);
  let canonical = absolute;
  try {
    canonical = path.resolve(resolveHostPath(absolute));
  } catch {
    // Fixed roots such as an unmounted /Volumes still need a textual boundary.
    canonical = absolute;
  }
  assertNormalizedAbsoluteSeatbeltPath(canonical, 'Seatbelt path');
  return canonical;
}

/**
 * Construct only host-selected, exact carve-outs. No directory enumeration is
 * used, so siblings created after this object is built remain covered. The
 * caller deliberately excludes `/workspace/extra*` mounts before passing
 * `hostControlledReadRoots`; an operator/guest external mount can never turn
 * into a hole in /Volumes or a shared temp tree.
 */
export function buildGuestMacSeatbeltPolicy(
  input: GuestSeatbeltPolicyInput,
): GuestSeatbeltPolicy {
  const resolveHostPath =
    input.resolveHostPath ??
    ((value: string) => {
      try {
        return fs.realpathSync(value);
      } catch {
        return path.resolve(value);
      }
    });
  const canonical = (value: string) =>
    canonicalSeatbeltPath(value, resolveHostPath);
  const projectRoot = canonical(input.projectRoot);
  const hostControlledReadRoots = [
    ...new Set(input.hostControlledReadRoots.map(canonical)),
  ];
  const boundaries: GuestSeatbeltBoundary[] = [];
  const addBoundary = (
    rawParent: string,
    rawAllowed: readonly string[],
  ): void => {
    const parent = canonical(rawParent);
    const allowedSubtrees = [
      ...new Set(
        rawAllowed
          .map(canonical)
          .filter(
            (allowed) =>
              allowed !== parent && pathContainsPath(parent, allowed),
          ),
      ),
    ].sort();
    boundaries.push({ parent, allowedSubtrees });
  };

  // Close every level of the project-chain sibling walk without relying on
  // which sibling names happened to exist at settings-build time.
  if (input.mountRoot) {
    const mountRoot = canonical(input.mountRoot);
    if (!pathContainsPath(mountRoot, projectRoot)) {
      throw new Error('Guest Seatbelt mount root does not contain project');
    }
    let child = projectRoot;
    let parent = path.dirname(child);
    let guard = 0;
    while (pathContainsPath(mountRoot, parent) && guard++ < 64) {
      addBoundary(parent, [child]);
      child = parent;
      parent = path.dirname(parent);
    }
    if (guard >= 64) {
      throw new Error('Guest Seatbelt project chain exceeded depth limit');
    }
  }

  for (const restricted of input.restrictedParents) {
    addBoundary(restricted.parent, restricted.allowedSubtrees);
  }

  // Canonicalize aliases (/tmp -> /private/tmp, /var -> /private/var) and
  // install one compound rule per resulting shared root. If an explicitly
  // host-controlled runtime root owns the entire candidate, restricting it
  // here would break that runtime, so the narrower project/data rules remain
  // authoritative instead.
  const sharedRoots = [
    ...new Set(
      (input.sharedReadRoots ?? GUEST_MAC_SHARED_READ_ROOTS).map(canonical),
    ),
  ];
  for (const sharedRoot of sharedRoots) {
    if (
      hostControlledReadRoots.some((authorized) =>
        pathContainsPath(authorized, sharedRoot),
      )
    ) {
      continue;
    }
    addBoundary(
      sharedRoot,
      hostControlledReadRoots.filter(
        (authorized) =>
          authorized !== sharedRoot && pathContainsPath(sharedRoot, authorized),
      ),
    );
  }

  const uniqueBoundaries = [
    ...new Map(
      boundaries.map((boundary) => [JSON.stringify(boundary), boundary]),
    ).values(),
  ].sort((a, b) =>
    a.parent === b.parent
      ? a.allowedSubtrees.join('\0').localeCompare(b.allowedSubtrees.join('\0'))
      : a.parent.localeCompare(b.parent),
  );
  return {
    version: 1,
    boundaries: uniqueBoundaries,
    // The wrapper derives the fixed `.env` / `.env.*` regex itself. It never
    // accepts caller-provided regular expressions.
    envRoots: [projectRoot],
  };
}

/** Require the final macOS policy to expose exactly one Codex-home child. */
export function assertIsolatedObserverCodexHomeSeatbeltPolicy(
  policy: GuestSeatbeltPolicy,
  codexHome: string,
  dataDir = DATA_DIR,
  platform: NodeJS.Platform = os.platform(),
): void {
  if (platform !== 'darwin') {
    throw new Error(
      'Isolated observer Codex sandbox is supported only on macOS',
    );
  }
  const { parent, child } = isolatedObserverCodexHomePaths(codexHome, dataDir);
  const realParent = fs.realpathSync(parent);
  const realChild = fs.realpathSync(child);
  const exact = policy.boundaries.filter(
    (boundary) =>
      boundary.parent === realParent &&
      boundary.allowedSubtrees.length === 1 &&
      boundary.allowedSubtrees[0] === realChild,
  );
  if (exact.length !== 1) {
    throw new Error(
      'Isolated observer CODEX_HOME final Seatbelt boundary is missing',
    );
  }
  for (const boundary of policy.boundaries) {
    for (const allowed of boundary.allowedSubtrees) {
      if (pathContainsPath(realParent, allowed) && allowed !== realChild) {
        throw new Error(
          'Isolated observer CODEX_HOME final Seatbelt policy exposes a sibling',
        );
      }
    }
  }
}

export function encodeGuestSeatbeltPolicy(policy: GuestSeatbeltPolicy): string {
  // Re-run the same lexical checks immediately before crossing the env
  // boundary. The wrapper independently repeats them before running with host
  // privileges.
  if (policy.version !== 1 || !Array.isArray(policy.boundaries)) {
    throw new Error('Invalid guest Seatbelt policy version/shape');
  }
  for (const boundary of policy.boundaries) {
    assertNormalizedAbsoluteSeatbeltPath(
      boundary.parent,
      'Seatbelt boundary parent',
    );
    for (const allowed of boundary.allowedSubtrees) {
      assertNormalizedAbsoluteSeatbeltPath(
        allowed,
        'Seatbelt authorized subtree',
      );
      if (
        allowed === boundary.parent ||
        !pathContainsPath(boundary.parent, allowed)
      ) {
        throw new Error('Seatbelt carve-out escapes its parent boundary');
      }
    }
  }
  for (const envRoot of policy.envRoots) {
    assertNormalizedAbsoluteSeatbeltPath(envRoot, 'Seatbelt env root');
  }
  return Buffer.from(JSON.stringify(policy), 'utf8').toString('base64url');
}

export function collectGuestSeatbeltHostReadRoots(
  projectRoot: string,
  mounts: readonly SandboxMount[],
): string[] {
  return [
    projectRoot,
    CODE_ROOT,
    ...mounts
      .filter(
        (mount) =>
          !mount.deny &&
          !mount.denyWriteOnly &&
          !mount.containerPath.startsWith('/workspace/extra'),
      )
      .map((mount) => mount.hostPath),
  ];
}

export function collectGuestSeatbeltAllowedSubtrees(
  parent: string,
  hostControlledReadRoots: readonly string[],
): string[] {
  return hostControlledReadRoots.filter(
    (candidate) => candidate !== parent && pathContainsPath(parent, candidate),
  );
}

export function assertGuestSandboxExecWrapperSafe(
  wrapperDir = GUEST_SANDBOX_EXEC_WRAPPER_DIR,
): string {
  const wrapperPath = path.join(wrapperDir, 'sandbox-exec');
  const stat = fs.lstatSync(wrapperPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o111) === 0 ||
    (stat.mode & 0o022) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    throw new Error(
      'Guest sandbox-exec wrapper must be an owner-controlled executable file',
    );
  }
  return wrapperPath;
}

/**
 * Derive the top-level boundary ("mount root") under which the project lives.
 * Used to confine guest READS to the project's subtree without keying on the
 * literal '/Users': the previous sibling-walk only ran while the parent started
 * with '/Users', so on non-/Users deployments (Linux /home, /opt, /srv, …) the
 * confinement silently no-op'd and srt's allow-by-default reads exposed the
 * whole host.
 *
 * Generic rule: the boundary is the FIRST path segment under the filesystem
 * root — `/Users` for `/Users/example/project`, `/home` for
 * `/home/example/project`, `/opt` for `/opt/cc`. The sibling-walk therefore
 * denies siblings up to and including the
 * children of this boundary, then stops BEFORE the true top-level system dirs
 * (`/usr`, `/bin`, `/System`, `/private`, …), which must stay readable for the
 * node/srt runtime — so the legitimate path is never broken.
 *
 * An operator may pin a deeper, explicit boundary via the optional
 * CLAUDECLAW_SANDBOX_MOUNT_ROOT env var (e.g. `/data/tenants` when projects live
 * at `/data/tenants/<tenant>/cc`). It is honored ONLY when it is a real
 * ancestor-or-equal of projectRoot and is not the filesystem root itself;
 * otherwise it is ignored so a misconfiguration can never silently disable
 * confinement (fail toward MORE confinement, not less).
 *
 * Returns null only for a project located AT the filesystem root (degenerate;
 * there is nothing between it and `/` to confine).
 */
export function deriveSandboxMountRoot(
  projectRoot: string,
  configuredRoot?: string | null,
): string | null {
  if (configuredRoot) {
    const normalized = path.resolve(configuredRoot);
    // Reject the filesystem root (would make the walk's stop condition always
    // true → never terminate) and any value that does not actually contain the
    // project (an unrelated path must not weaken confinement).
    if (
      path.dirname(normalized) !== normalized &&
      pathContainsPath(normalized, projectRoot)
    ) {
      return normalized;
    }
  }
  const rootDir = path.parse(projectRoot).root || path.sep;
  const rel = path.relative(rootDir, projectRoot);
  const firstSegment = rel.split(path.sep).filter(Boolean)[0];
  if (!firstSegment) return null; // project IS the filesystem root
  return path.join(rootDir, firstSegment);
}

/**
 * Compute the sibling paths that must be denied so guest reads are confined to
 * the project subtree. Walks from projectRoot up to (and including) the mount
 * root, collecting every sibling of the project chain at each level. Everything
 * off the project chain becomes a deny target, while the project chain itself
 * stays readable.
 *
 * Pure / injectable for testing: `listDir` returns a directory's entry names
 * and may throw for a non-existent dir (treated as empty). A hard depth cap
 * guarantees termination even for pathological inputs.
 */
export function computeProjectChainSiblingDenyPaths(
  projectRoot: string,
  mountRoot: string | null,
  listDir: (dir: string) => string[],
): string[] {
  const denies: string[] = [];
  if (!mountRoot) return denies;
  let child = projectRoot;
  let parent = path.dirname(child);
  let guard = 0;
  // `parent` strictly shrinks in depth each step until it reaches `/`, where
  // `pathContainsPath(mountRoot, '/')` is false for any non-root mountRoot, so
  // the loop terminates. The guard is belt-and-suspenders against any unforeseen
  // input (no real deployment is anywhere near 64 levels deep).
  while (pathContainsPath(mountRoot, parent) && guard++ < 64) {
    let entries: string[] = [];
    try {
      entries = listDir(parent);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const full = path.join(parent, entry);
      if (full !== child) denies.push(full);
    }
    child = parent;
    parent = path.dirname(parent);
  }
  return denies;
}

// ---------------------------------------------------------------------------
// Health check & cleanup
// ---------------------------------------------------------------------------

/**
 * Confirm a PID actually belongs to a claudeclaw sandbox before we group-signal
 * it. The recorded PID comes from a *.pid file written by a PREVIOUS (now-dead)
 * process; between runs the OS can reuse that PID for an unrelated process. A
 * bare `process.kill(pid, 0)` existence check only proves *some* process holds
 * the PID now — not that it is our sandbox — and `process.kill(-pid, …)` would
 * then SIGTERM that unrelated process's WHOLE group. So we read the process
 * command line (`ps -o command= -p <pid>`) and require it to look like our
 * sandbox tree (npx → @anthropic-ai/sandbox-runtime → node agent-runner). Fail
 * CLOSED: if we cannot read/identify the command line, treat it as NOT ours so
 * a group kill is never sent to a recycled PID. Injectable for testing.
 */
export function isClaudeclawSandboxProcess(
  pid: number,
  readCmdline: (pid: number) => string = (p) =>
    execFileSync('ps', ['-o', 'command=', '-p', String(p)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).toString(),
): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  let cmd: string;
  try {
    cmd = readCmdline(pid);
  } catch {
    // No such process, ps failed, or not permitted — cannot confirm identity.
    return false;
  }
  if (!cmd || !cmd.trim()) return false;
  // SECURITY (PID-reuse, finding #32): require evidence of an actual sandbox
  // run, NOT a bare path substring. The install path is …/my-assistant/
  // claudeclaw, so `cmd.includes('claudeclaw')` matched essentially ANY
  // unrelated process touching that tree (editor, `tail -f …/logs`, rg/grep,
  // rsync/backup, sibling helper node procs). If the OS recycled a dead
  // sandbox's PID onto such a process, that over-broad clause let cleanup
  // group-SIGTERM its WHOLE process group — exactly the PID-reuse harm this
  // guard exists to prevent. The remaining clauses each prove a real sandbox:
  //   - '@anthropic-ai/sandbox-runtime' / 'sandbox-runtime' → the srt wrapper
  //   - 'agent/runner/dist/index.js'                        → bypass-mode runner
  //   - 'claudeclaw-sandbox-'  → the per-run processName token that appears in
  //     the wrapper's `--settings …/sandbox-settings/claudeclaw-sandbox-*.json`
  //     argument; far more specific than the bare 'claudeclaw' substring.
  return (
    cmd.includes('@anthropic-ai/sandbox-runtime') ||
    cmd.includes('sandbox-runtime') ||
    cmd.includes(path.join('agent', 'runner', 'dist', 'index.js')) ||
    cmd.includes('claudeclaw-sandbox-')
  );
}

/**
 * Verify that sandbox-runtime is available.
 */
export function ensureSandboxRuntimeAvailable(): void {
  try {
    execFileSync('npx', ['@anthropic-ai/sandbox-runtime', '--version'], {
      stdio: 'pipe',
      timeout: 30000,
    });
    logger.debug('sandbox-runtime is available');
  } catch (err) {
    logger.error({ err }, 'sandbox-runtime not found');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: sandbox-runtime not found                              ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Install: npm install @anthropic-ai/sandbox-runtime            ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('sandbox-runtime is required but not installed');
  }
}

// A per-run policy/settings file (data/sandbox-settings/<processName>.json) or
// PID file older than this is considered orphaned from a crashed/SIGKILLed run.
// The longest possible run is bounded by timeoutMs (max(configTimeout,
// IDLE_TIMEOUT+30s) ≈ 30.5 min) plus the 5s SIGKILL escalation, so a 2h floor
// can never delete a file belonging to a live in-process run.
const SANDBOX_FILE_STALE_MS = 2 * 60 * 60 * 1000; // 2h

/**
 * Sweep orphaned per-run sandbox settings files. Each run writes
 * data/sandbox-settings/<processName>.json and unlinks it in its own
 * 'close'/'error' handler — but if the orchestrator is SIGKILLed/crashes
 * mid-run (or dies during the SIGTERM→SIGKILL window) those handlers never fire
 * and the file leaks, growing unbounded across restarts. Unlike PID files there
 * was no startup sweep. Delete settings files older than SANDBOX_FILE_STALE_MS;
 * the staleness floor is well beyond the max run duration so a live run's file
 * is never removed. Each file holds only filesystem allow/deny path lists (no
 * credentials), so age-based reaping is safe. Best-effort: never throws.
 */
export function cleanupStaleSandboxSettings(now: number = Date.now()): void {
  const settingsDir = path.join(DATA_DIR, 'sandbox-settings');
  if (!fs.existsSync(settingsDir)) return;
  let removed = 0;
  let files: string[] = [];
  try {
    files = fs.readdirSync(settingsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  for (const file of files) {
    const filePath = path.join(settingsDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs >= SANDBOX_FILE_STALE_MS) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch {
      /* ignore — file may have been removed by its own run concurrently */
    }
  }
  if (removed > 0) {
    logger.info({ count: removed }, 'Swept stale sandbox settings files');
  }
}

/**
 * Kill orphaned sandbox processes from a previous run using PID files, and
 * sweep stale per-run settings files. Runs once at startup.
 */
export function cleanupSandboxOrphans(): void {
  if (fs.existsSync(SANDBOX_PID_DIR)) {
    const pidFiles = fs
      .readdirSync(SANDBOX_PID_DIR)
      .filter((f) => f.endsWith('.pid'));
    const killed: string[] = [];

    for (const file of pidFiles) {
      const pidPath = path.join(SANDBOX_PID_DIR, file);
      try {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        if (isNaN(pid)) {
          fs.unlinkSync(pidPath);
          continue;
        }
        try {
          process.kill(pid, 0); // existence check
          // The PID came from a file written by a PREVIOUS, now-dead process;
          // the OS may have recycled it for an UNRELATED process. The signal-0
          // check only proves *some* process holds the PID — not that it is our
          // sandbox — so before sending a group-wide SIGTERM (negative PID) we
          // verify identity via the command line. Sandbox children are spawned
          // detached, so the recorded PID is a process-group leader and a
          // negative-PID signal reaps the whole tree (inner `claude` SDK
          // included). If identity can't be confirmed we DON'T group-kill (it
          // could be a recycled PID's group); we just unlink the stale file.
          if (pid > 1 && isClaudeclawSandboxProcess(pid)) {
            try {
              process.kill(-pid, 'SIGTERM');
            } catch {
              process.kill(pid, 'SIGTERM');
            }
            killed.push(file.replace('.pid', ''));
          }
        } catch {
          // Process already dead
        }
        fs.unlinkSync(pidPath);
      } catch {
        try {
          fs.unlinkSync(pidPath);
        } catch {
          /* ignore */
        }
      }
    }

    if (killed.length > 0) {
      logger.info(
        { count: killed.length, names: killed },
        'Stopped orphaned sandbox processes',
      );
    }
  }

  // Sweep orphaned settings files regardless of whether any PID files remained
  // (a crash mid-run can leak a settings file even after its PID file is gone).
  cleanupStaleSandboxSettings();
}

// ---------------------------------------------------------------------------
// Mount building (mirrors container-runner.ts buildVolumeMounts)
// ---------------------------------------------------------------------------

export function buildSandboxMounts(
  group: RegisteredGroup,
  isMain: boolean,
  senderIdentity?: SenderIdentity,
  credentialProxyTier: 'owner' | 'guest' = 'guest',
  chatJid?: string,
): SandboxMount[] {
  const mounts: SandboxMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  const restrictedWhatsAppObserver =
    isMain &&
    group.agentConfig?.whatsappObserverAccess === true &&
    Boolean(chatJid?.endsWith('@s.whatsapp.net'));
  const trustedOwner =
    isMain && credentialProxyTier === 'owner' && !restrictedWhatsAppObserver;
  const identityId =
    senderIdentity?.telegram_message_origin === 'direct'
      ? senderIdentity.identity_id
      : undefined;
  const untrustedMain = shouldUseUntrustedMainRuntimeNamespace({
    groupIsMain: isMain,
    credentialProxyTier,
    chatJid,
  });
  const untrustedPaths = untrustedMain
    ? untrustedMainRuntimePaths(DATA_DIR, group.folder)
    : null;
  let isolatedReceivedLink: string | null = null;
  const fullAccess =
    trustedOwner &&
    (group.agentConfig?.fullAccess === true ||
      group.agentConfig?.noSandbox === true);
  const receivedDir = ensureSafeRuntimeReceivedDirectory(groupDir);
  const identityKey = identityId ? safeSharedMemoryKey(identityId) : null;
  const sharedUserMemoryDir =
    !trustedOwner && identityKey && identityKey !== 'unknown'
      ? path.join(DATA_DIR, 'user-memory', identityKey)
      : null;
  const skillsDir = path.join(DATA_DIR, 'skills');
  const denyPath = (hostPath: string) => {
    if (!fs.existsSync(hostPath)) return;
    mounts.push({
      hostPath,
      containerPath: hostPath,
      readonly: true,
      deny: true,
    });
  };
  // Like denyPath but emits the deny even when the path is absent at build
  // time. srt subpath denies are safe on non-existent paths, and this closes
  // the create-after-build exposure window for known-sensitive fixed dirs:
  // the deny set is recomputed per run, so a path that doesn't exist when the
  // sandbox is built but is created mid-session would otherwise stay readable
  // until the next build.
  const alwaysDenyPath = (hostPath: string) => {
    mounts.push({
      hostPath,
      containerPath: hostPath,
      readonly: true,
      deny: true,
    });
  };

  if (trustedOwner) {
    // Main normally gets project root read-only. Dedicated-host full access
    // intentionally makes it writable and keeps .env visible.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: !fullAccess,
    });

    // Shadow .env — deny read/write access to secrets unless fullAccess is set.
    const envFile = path.join(projectRoot, '.env');
    if (!fullAccess && fs.existsSync(envFile)) {
      mounts.push({
        hostPath: envFile,
        containerPath: '/workspace/project/.env',
        readonly: true,
        deny: true,
      });
    }

    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    if (untrustedPaths) {
      const isolatedWorkspace = ensureSafeGuestRuntimeDirectory(
        untrustedPaths.workspace,
      );
      ensureSafeGuestRuntimeDirectory(untrustedPaths.home);
      ensureSafeGuestRuntimeDirectory(untrustedPaths.tmp);
      // srt does not create virtual bind mounts: relative `received/foo`
      // accesses the host workspace directly.  Recreate this reserved entry as
      // a host-chosen symlink to canonical received on every run, then protect
      // both the link and target with readonly policy entries below.
      isolatedReceivedLink = path.join(isolatedWorkspace, 'received');
      fs.rmSync(isolatedReceivedLink, { recursive: true, force: true });
      fs.symlinkSync(receivedDir, isolatedReceivedLink, 'dir');
      // srt reads are allow-by-default.  An omitted mount alone would still
      // expose the canonical main directory by its host path, so deny the
      // whole owner workspace explicitly.  The nested received RO entry below
      // is the only intentional read carve-out.
      mounts.push({
        hostPath: groupDir,
        containerPath: '/workspace/canonical-group',
        readonly: true,
        deny: true,
      });
    }
    mounts.push({
      hostPath: untrustedPaths?.workspace ?? groupDir,
      containerPath: '/workspace/group',
      // Codex persists its thread id at the workspace root and the runner
      // creates memory/ before the first turn, so the workspace itself must
      // remain writable. Observer-specific instruction files are protected by
      // exact deny-write rules immediately below.
      readonly: false,
    });
    if (restrictedWhatsAppObserver) {
      for (const instructionFile of ['CLAUDE.md', 'AGENTS.md']) {
        mounts.push({
          hostPath: path.join(groupDir, instructionFile),
          containerPath: `/workspace/group/${instructionFile}`,
          readonly: true,
          denyWriteOnly: true,
        });
      }
    }

    // Host channel code is the sole writer for inbound media. srt's
    // denyWrite takes precedence over the broader group allowWrite and also
    // emits file-write-unlink rules for this path/its mount point, preventing
    // rename→symlink→restore races against the host WhatsApp publisher while
    // preserving guest writes everywhere else in the group workspace.
    mounts.push({
      hostPath: receivedDir,
      containerPath: '/workspace/group/received',
      readonly: true,
      // For isolated main guests, this is also the nested read carve-out from
      // the canonical-group deny. Normal guests already read their whole group.
      denyWriteOnly: untrustedPaths ? undefined : true,
    });
    if (isolatedReceivedLink) {
      mounts.push({
        hostPath: isolatedReceivedLink,
        containerPath: '/workspace/group/received-link',
        readonly: true,
      });
    }

    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }

    for (const entry of fs.readdirSync(projectRoot)) {
      if (entry === '.env' || entry.startsWith('.env.')) {
        denyPath(path.join(projectRoot, entry));
      }
    }
    // Deny these unconditionally (even if absent at build time): they are
    // fixed, high-value targets and must never be readable by a guest, so we
    // don't want the create-after-build window that fs.existsSync gating opens.
    alwaysDenyPath(path.join(projectRoot, 'store'));
    alwaysDenyPath(path.join(projectRoot, 'logs'));
    // Payment certificates and private keys may live here — never
    // expose them to a guest sandbox, same as .env above.
    alwaysDenyPath(path.join(projectRoot, 'secrets'));
    for (const entry of fs.existsSync(GROUPS_DIR)
      ? fs.readdirSync(GROUPS_DIR)
      : []) {
      if (entry !== group.folder && entry !== 'global') {
        denyPath(path.join(GROUPS_DIR, entry));
      }
    }
    const denyDataChildren = (parent: string, allowedEntry?: string) => {
      if (!fs.existsSync(parent)) return;
      for (const entry of fs.readdirSync(parent)) {
        if (entry !== allowedEntry) denyPath(path.join(parent, entry));
      }
    };
    denyDataChildren(path.join(DATA_DIR, 'ipc'), group.folder);
    denyDataChildren(
      path.join(DATA_DIR, 'sessions'),
      untrustedPaths ? undefined : group.folder,
    );
    if (untrustedPaths) {
      // Deny the canonical main HOME/session even before it exists, and allow
      // only this group's fixed untrusted namespace under data/untrusted-main.
      alwaysDenyPath(path.join(DATA_DIR, 'sessions', group.folder));
      denyDataChildren(path.join(DATA_DIR, 'untrusted-main'), group.folder);
    }
    if (sharedUserMemoryDir) {
      fs.mkdirSync(path.join(sharedUserMemoryDir, 'shared'), {
        recursive: true,
      });
    }
    for (const entry of fs.existsSync(DATA_DIR)
      ? fs.readdirSync(DATA_DIR)
      : []) {
      if (entry === 'user-memory' && sharedUserMemoryDir && identityKey) {
        const userMemoryRoot = path.join(DATA_DIR, 'user-memory');
        for (const userMemoryEntry of fs.existsSync(userMemoryRoot)
          ? fs.readdirSync(userMemoryRoot)
          : []) {
          if (userMemoryEntry !== identityKey) {
            denyPath(path.join(userMemoryRoot, userMemoryEntry));
          }
        }
        continue;
      }
      if (entry === 'skills') continue;
      if (entry === 'untrusted-main' && untrustedPaths) continue;
      if (entry !== 'ipc' && entry !== 'sessions') {
        denyPath(path.join(DATA_DIR, entry));
      }
    }
    if (sharedUserMemoryDir) {
      mounts.push({
        hostPath: sharedUserMemoryDir,
        containerPath: '/workspace/user-memory',
        readonly: false,
      });
    }
    for (const sensitive of [
      '.ssh',
      '.gnupg',
      '.aws',
      '.claude',
      '.codex',
      '.config/openai',
      '.config/claudeclaw',
      '.zsh_history',
      '.bash_history',
      'Library/Application Support',
      'Library/Keychains',
      'Library/Cookies',
      'Library/Safari',
    ]) {
      // Fixed credential/config locations stay denied even when absent while
      // the policy is assembled; creating one mid-run must not open a window.
      alwaysDenyPath(path.join(os.homedir(), sensitive));
    }

    // Confine guest READS to the project subtree. srt reads are
    // allow-by-default across the whole host, so the explicit denies above
    // (store, .env, secrets, other groups, sensitive home dirs) were just a
    // blacklist — a guest with Bash could still read ANY un-listed host path:
    // the owner's private files, other users' homes (/Users/example/Documents,
    // /Users/you/...), Desktop, etc.
    //
    // We do NOT blanket-deny the top-level dir: srt pairs every read-deny with
    // a file-write-unlink deny over the SAME subtree (a move-bypass guard) and
    // offers no allow-override for it — so a blanket deny would also stop the
    // guest from deleting/renaming files inside its OWN group folder. Instead
    // we walk from the project root up to its top-level mount boundary and deny
    // every SIBLING at each level. Everything off the project chain becomes
    // unreadable, while the project chain and the guest's workspace stay fully
    // readable AND writable (incl. unlink/rename).
    //
    // The boundary is derived GENERICALLY (deriveSandboxMountRoot), not keyed on
    // the literal '/Users': the old `while (parent.startsWith('/Users'))` gate
    // silently no-op'd on Linux deployments (/home, /opt, /srv), leaving srt's
    // allow-by-default reads exposing the whole host. The walk stops before the
    // true top-level system dirs (/usr, homebrew node, /System, /private), so
    // they remain readable for the runtime. Re-computed each run.
    const mountRoot = deriveSandboxMountRoot(
      projectRoot,
      process.env.CLAUDECLAW_SANDBOX_MOUNT_ROOT,
    );
    for (const sibling of computeProjectChainSiblingDenyPaths(
      projectRoot,
      mountRoot,
      (dir) => fs.readdirSync(dir),
    )) {
      denyPath(sibling);
    }

    // Per-group writable HOME. The bundled Claude CLI reads/writes ~/.claude
    // and ~/.claude.json at startup; once the read confinement above denies
    // the owner's home; leaving HOME pointed at that host account makes those
    // config writes fail and the CLI hangs. Give guests their own HOME under
    // data/sessions/ (mirroring container mode's isolated guest HOME) so it lives
    // in a per-group, isolated location — and the guest never touches the admin's
    // global Claude config. runSandboxAgent sets env HOME to this same dir.
    const guestHome = ensureSafeGuestRuntimeDirectory(
      untrustedPaths?.home ?? path.join(DATA_DIR, 'sessions', group.folder),
    );
    mounts.push({
      hostPath: guestHome,
      containerPath: SANDBOX_GUEST_HOME,
      readonly: false,
    });
  }

  fs.mkdirSync(path.join(skillsDir, '.proposals'), { recursive: true });
  // SECURITY: data/skills is a SHARED host directory whose ACTIVE skills the
  // host injects into EVERY group's model prompt (selectSkills → buildSkill
  // PromptContext). Mounting it read-write into an untrusted guest let that
  // guest (which has Bash) write `data/skills/<n>/SKILL.md` with `status:
  // active` and have it injected into the TRUSTED admin/main agent's prompt —
  // cross-tenant prompt injection into the host-controlling agent — and bypass
  // the proposal/approval workflow entirely. Guests now get the shared skills
  // READ-ONLY (they can still read & use operator-curated skills); only MAIN
  // (trusted operator) keeps write access to curate them. Guest skill
  // proposals are routed to the host over IPC (`propose_skill`), which writes
  // them to `.proposals` for operator approval — see ipc.ts and the runner's
  // skill_propose tool.
  mounts.push({
    hostPath: skillsDir,
    containerPath: '/workspace/skills',
    readonly: !trustedOwner,
  });

  // Per-group IPC namespace
  const ipcLayout = ensureIpcDirectoryLayout(resolveGroupIpcPath(group.folder));
  if (trustedOwner) {
    // Main is trusted and keeps the legacy whole-root RW view (owner/X and
    // extension compatibility).
    mounts.push({
      hostPath: ipcLayout.root,
      containerPath: '/workspace/ipc',
      readonly: false,
    });
  } else if (restrictedWhatsAppObserver) {
    // The host owns every action category. Codex still needs the `input`
    // directory for same-run follow-up delivery, but its shell must not be
    // able to forge send/task/memory/SWE/Google envelopes behind the MCP tool
    // policy. Denying the real host paths matters on macOS where srt receives
    // host paths directly rather than a virtual mount namespace.
    for (const category of IPC_CATEGORY_DIRECTORY_NAMES) {
      const inputOnly = category === 'input';
      mounts.push({
        hostPath: ipcLayout.categories[category],
        containerPath: `/workspace/ipc/${category}`,
        readonly: !inputOnly,
        deny: inputOnly ? undefined : true,
      });
    }
    for (const snapshot of ['current_tasks.json', 'available_groups.json']) {
      mounts.push({
        hostPath: path.join(ipcLayout.root, snapshot),
        containerPath: `/workspace/ipc/${snapshot}`,
        readonly: true,
        deny: true,
      });
    }
    mounts.push({
      hostPath: path.join(ipcLayout.root, '*'),
      containerPath: '/workspace/ipc/*',
      readonly: true,
      denyWriteOnly: true,
    });
  } else {
    // sandbox-runtime write rules are default-deny. Allow the fixed
    // category trees, but deny writes to the IPC root's direct entries. The
    // glob matches category roots/snapshots, not files below categories:
    // guests can temp→rename envelopes, but cannot rmdir a category and replace
    // it with a symlink. On Linux srt drops the glob and bwrap makes each
    // allowed category a stable RW bind mount under its RO root filesystem.
    for (const category of IPC_CATEGORY_DIRECTORY_NAMES) {
      if (category === 'google') continue;
      mounts.push({
        hostPath: ipcLayout.categories[category],
        containerPath: `/workspace/ipc/${category}`,
        readonly: false,
      });
    }
    // Unlike a real container, the macOS sandbox receives host paths through
    // CLAUDECLAW_IPC_DIR. Masking the logical /workspace path alone is not a
    // read boundary, so explicitly deny the real shared owner Google tree.
    mounts.push({
      hostPath: ipcLayout.categories.google,
      containerPath: '/workspace/.claudeclaw-deny/google-ipc',
      readonly: true,
      deny: true,
    });
    mounts.push({
      hostPath: ensureSafeGuestRuntimeDirectory(
        path.join(DATA_DIR, 'runtime-denied-google-ipc'),
      ),
      containerPath: '/workspace/ipc/google',
      readonly: true,
    });
    mounts.push({
      hostPath: path.join(ipcLayout.root, '*'),
      containerPath: '/workspace/ipc/*',
      readonly: true,
      denyWriteOnly: true,
    });
  }

  // Per-group scratch / TMPDIR. srt forces the sandboxed child's TMPDIR to
  // `CLAUDE_TMPDIR || /tmp/claude`; left at the default, every tenant's
  // Bash-tool scratch lands in the SAME /tmp/claude/claude-<uid> tree (the host
  // uid is identical for all groups), so concurrent tenants could read each
  // other's transient artifacts. Give each group its own scratch under its
  // isolated session dir and point CLAUDE_TMPDIR at it (runSandboxAgent). The
  // dir must be in allowWrite — srt's default write paths only cover
  // /tmp/claude, not this one.
  const groupTmpDir = trustedOwner
    ? path.join(DATA_DIR, 'sessions', group.folder, 'tmp')
    : ensureSafeGuestRuntimeDirectory(
        untrustedPaths?.tmp ??
          path.join(DATA_DIR, 'sessions', group.folder, 'tmp'),
      );
  if (trustedOwner) fs.mkdirSync(groupTmpDir, { recursive: true });
  mounts.push({
    hostPath: groupTmpDir,
    containerPath: '/workspace/tmp',
    readonly: false,
  });

  // Computer-control screenshots — helper daemon writes here, agent reads.
  // SECURITY: this is a SINGLE shared host directory holding full-desktop
  // screenshots (other tenants' chats, .env on screen, banking, etc.).
  // Computer-control is MAIN-only (HELPER_SECRET is forwarded only to main —
  // see runSandboxAgent), so an untrusted guest has no legitimate use for it;
  // mounting it into every guest sandbox just leaked the admin's screen to all
  // tenants. Mount it ONLY for main.
  if (trustedOwner) {
    const screenshotDir = '/tmp/skoobi-screenshots';
    fs.mkdirSync(screenshotDir, { recursive: true });
    mounts.push({
      hostPath: screenshotDir,
      containerPath: screenshotDir,
      readonly: true,
    });
  }

  // Per-group Claude sessions directory
  const preparedHome = prepareRuntimeClaudeHome(
    untrustedPaths?.home ?? path.join(DATA_DIR, 'sessions', group.folder),
    trustedOwner,
  );
  const groupSessionsDir = preparedHome.claudeHome;

  // Sandbox needs Claude home dir to be accessible
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: SANDBOX_GUEST_CLAUDE_HOME,
    readonly: false,
  });

  // Additional mounts validated against external allowlist
  if (
    !untrustedPaths &&
    !restrictedWhatsAppObserver &&
    group.containerConfig?.additionalMounts
  ) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      trustedOwner,
    );
    for (const vm of validatedMounts) {
      mounts.push({
        hostPath: vm.hostPath,
        containerPath: vm.containerPath,
        readonly: vm.readonly,
      });
    }
  }

  return mounts;
}

// ---------------------------------------------------------------------------
// Settings & args builders
// ---------------------------------------------------------------------------

/**
 * Whether a domain pattern is accepted by @anthropic-ai/sandbox-runtime.
 * Valid: a hostname with at least two labels ("example.com") or a wildcard with
 * at least two labels after "*." ("*.example.com"). Rejected: overly broad
 * patterns ("*", "*.com") which the runtime refuses — and which, if forwarded,
 * invalidate the WHOLE network policy and silently block api.anthropic.com.
 */
export function isSandboxSafeDomain(domain: string): boolean {
  const s = String(domain ?? '')
    .trim()
    .toLowerCase();
  if (!s || s === '*') return false;
  const body = s.startsWith('*.') ? s.slice(2) : s;
  // Require at least two non-empty labels (a dot), valid hostname characters.
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
    body,
  );
}

/**
 * Build sandbox settings from mounts and optional extra allowed domains.
 *
 * Network domains are layered:
 *   1. Base (always): api.anthropic.com, *.anthropic.com, localhost, 127.0.0.1
 *   2. Extra: from agentConfig.allowedDomains (per-group) and extension manifests
 *
 * Duplicates are removed automatically.
 */
export function buildSandboxSettings(
  mounts: SandboxMount[],
  extraAllowedDomains: string[] = [],
): SandboxSettings {
  const denyRead: string[] = [];
  const allowRead: string[] = [];
  const allowWrite: string[] = [];
  const denyWrite: string[] = [];
  // Host paths of additional (`/workspace/extra*`) mounts. These are
  // guest-configurable (only validated by mount-security) and, unlike the
  // host-controlled deny/allow set, must never re-open a cross-tenant subtree
  // the runner itself denied — see finding #72 below.
  const extraReadHostPaths = new Set<string>();

  for (const mount of mounts) {
    if (
      mount.allowRead &&
      (mount.deny || mount.denyWriteOnly || mount.readonly)
    ) {
      throw new Error('Invalid explicit allowRead sandbox mount combination');
    }
    if (mount.denyWriteOnly) {
      denyWrite.push(mount.hostPath);
    } else if (mount.deny) {
      denyRead.push(mount.hostPath);
      denyWrite.push(mount.hostPath);
    } else if (mount.readonly) {
      allowRead.push(mount.hostPath);
      denyWrite.push(mount.hostPath);
      if (mount.containerPath?.startsWith('/workspace/extra')) {
        extraReadHostPaths.add(mount.hostPath);
      }
    } else {
      // read-write
      allowWrite.push(mount.hostPath);
    }
    if (mount.allowRead) allowRead.push(mount.hostPath);
  }

  // Base domains are ALWAYS allowed so the agent can reach its own API.
  const baseDomains = [
    'api.anthropic.com',
    '*.anthropic.com',
    'localhost',
    '127.0.0.1',
  ];
  // Sanitize per-group / extension domains before handing them to the sandbox
  // runtime. The runtime rejects overly broad patterns ("*", "*.com"), and a
  // SINGLE invalid entry invalidates the ENTIRE network policy — silently
  // blocking api.anthropic.com and breaking every run with 403
  // "Connection blocked by network allowlist" / authentication_failed.
  // (Previously a "*" collapsed the list to ["*"], dropping the base domains —
  // that was the lockout bug.) Unsafe patterns are dropped, not forwarded;
  // true unrestricted network is only via the noSandbox/fullAccess host bypass.
  const safeExtra = extraAllowedDomains.filter(isSandboxSafeDomain);
  const allDomains = [...new Set([...baseDomains, ...safeExtra])];

  // SECURITY (allow-wins-for-reads): srt emits read rules as
  //   (allow file-read*)            ← base: reads are allow-by-default
  //   (deny  file-read* <denyRead>) ← carve out denied subtrees
  //   (allow file-read* <allowRead>)← re-allow within deny — emitted LAST
  // and Seatbelt is last-match-wins, so an allowRead entry that CONTAINS a
  // denyRead target re-allows that denied path (e.g. the main project-root
  // readonly mount re-allowing the shadowed .env). Drop such redundant
  // re-allows: because reads are allow-by-default, the subtree stays readable
  // via the base rule while the nested deny actually takes effect. Genuine
  // "deny a parent, poke a hole for a child" re-allows (allowRead nested
  // INSIDE a denyRead) are preserved — only ancestors-of-a-deny are removed.
  //
  // SECURITY (finding #72): the "poke a hole" preservation is safe ONLY for the
  // host-controlled mount set, where any nested re-allow is a deliberate
  // operator carve-out. An ADDITIONAL (`/workspace/extra*`) mount is
  // guest-configurable and only path-validated by mount-security, which does
  // not (today) reject non-main mounts under DATA_DIR. If such a mount's
  // realpath lands at/inside a cross-tenant subtree the runner denies
  // (denyDataChildren over data/ipc, data/sessions, other groups, …), the
  // last-match-wins re-allow would RE-OPEN that denied path and defeat tenant
  // isolation for reads. So for extra mounts we additionally drop any allowRead
  // that is EQUAL TO or NESTED INSIDE a denyRead (pathContainsPath(d, a)) — no
  // legitimate hole-poke ever originates from a guest-supplied extra mount.
  const effectiveAllowRead = allowRead.filter((a) => {
    if (denyRead.some((d) => pathContainsPath(a, d))) return false;
    if (
      extraReadHostPaths.has(a) &&
      denyRead.some((d) => pathContainsPath(d, a))
    ) {
      return false;
    }
    return true;
  });

  return {
    network: {
      allowedDomains: allDomains,
      deniedDomains: [],
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead,
      allowRead: effectiveAllowRead,
      allowWrite,
      denyWrite,
    },
  };
}

/**
 * Fail-closed validation of generated sandbox settings.
 *
 * srt silently falls back to an UNRESTRICTED read policy (whole-host reads) if
 * the settings file it's handed is invalid — empty/missing, unparseable, or
 * schema-rejected (its `filesystemPathSchema` requires non-empty strings, and a
 * single bad entry invalidates the whole policy). claudeclaw does no post-spawn
 * verification, so a malformed policy would run wide open. Validate the object
 * here before writing and refuse to spawn on failure, converting that silent
 * fail-open into a fail-closed abort. Throws on the first problem found.
 */
export function assertValidSandboxSettings(settings: SandboxSettings): void {
  const fs_ = settings?.filesystem;
  if (!fs_ || typeof fs_ !== 'object') {
    throw new Error('sandbox settings: missing filesystem section');
  }
  for (const key of [
    'denyRead',
    'allowRead',
    'allowWrite',
    'denyWrite',
  ] as const) {
    const arr = fs_[key];
    if (!Array.isArray(arr)) {
      throw new Error(`sandbox settings: filesystem.${key} must be an array`);
    }
    for (const p of arr) {
      // srt's filesystemPathSchema is z.string().min(1); an empty or non-string
      // path is exactly what trips its Zod validation and triggers fail-open.
      if (typeof p !== 'string' || p.length === 0) {
        throw new Error(
          `sandbox settings: empty/invalid path in filesystem.${key}`,
        );
      }
    }
  }
  const net = settings?.network;
  const domains = net?.allowedDomains;
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error(
      'sandbox settings: network.allowedDomains must be a non-empty array',
    );
  }
  for (const d of domains) {
    if (typeof d !== 'string' || d.length === 0) {
      throw new Error(
        'sandbox settings: empty domain in network.allowedDomains',
      );
    }
  }
  // The agent cannot function without its own API, and its presence is a cheap
  // signal that the base policy survived assembly rather than being clobbered.
  if (!domains.includes('api.anthropic.com')) {
    throw new Error(
      'sandbox settings: network.allowedDomains missing api.anthropic.com',
    );
  }
}

export function buildSandboxArgs(settingsPath: string): string[] {
  // Invoke the already-installed SRT CLI directly. `npx`/`npm exec` prepends
  // node_modules/.bin to PATH before launching a package. That displaces the
  // owner-controlled guest sandbox-exec shim from PATH[0], so the shim
  // correctly fails closed. Direct Node execution preserves the exact PATH
  // assembled by runSandboxAgent and cannot resolve/download another package.
  const sandboxRuntimeCliPath = path.join(
    CODE_ROOT,
    'node_modules',
    '@anthropic-ai',
    'sandbox-runtime',
    'dist',
    'cli.js',
  );
  // Sandbox runs the pre-compiled agent-runner directly on the host. The agent
  // runner lives in the CODE root, not the data/state root.
  const agentRunnerPath = path.join(
    CODE_ROOT,
    'agent',
    'runner',
    'dist',
    'index.js',
  );

  return [
    process.execPath,
    sandboxRuntimeCliPath,
    '--settings',
    settingsPath,
    '--',
    'node',
    agentRunnerPath,
  ];
}

// Default first-output deadline for chat turns. See resolveNoOutputTimeoutMs.
export const DEFAULT_NO_OUTPUT_TIMEOUT_MS = 240_000;
// After the first real output marker, the runner should either finish its idle
// wait or produce the next turn promptly. Stderr/debug chatter is intentionally
// ignored by this timer; it catches "alive but not making useful progress"
// hangs such as a Bash tool blocked inside the Claude SDK.
export const DEFAULT_PROGRESS_TIMEOUT_MS = 240_000;

/**
 * Resolve the FIRST-OUTPUT ("no-output") deadline.
 *
 * The no-output timer kills a run that is alive-but-silent before it produces
 * its first real output marker, so a wedged session can't burn the entire
 * global budget. But the previous hard-coded
 * value silently capped a single LEGITIMATE long first turn (heavy multi-tool /
 * vision / large-context) far below the operator-configured task budget
 * (default 30 min), forcing a kill+retry from scratch. This keeps the deadline
 * budget-aware and operator-configurable:
 *
 *  - Default: DEFAULT_NO_OUTPUT_TIMEOUT_MS (4 min for chat responsiveness).
 *  - Clamped to never exceed `timeoutMs` (the global cap) — so on a SHORT
 *    configured budget the no-output deadline never overshoots the budget, and
 *    it can never outlive the global timer on a long one.
 *  - Overridable via CLAUDECLAW_NO_OUTPUT_TIMEOUT_MS (milliseconds): operators
 *    expecting long first turns can raise it (still clamped to timeoutMs), and
 *    a value <= 0 DISABLES it entirely (returns null) so the run is governed
 *    only by the hang + global timers.
 *
 * Returns the effective deadline in ms, or null to disable the timer.
 */
export function resolveNoOutputTimeoutMs(
  timeoutMs: number,
  rawEnv: string | undefined = process.env.CLAUDECLAW_NO_OUTPUT_TIMEOUT_MS,
): number | null {
  let desired = DEFAULT_NO_OUTPUT_TIMEOUT_MS;
  if (rawEnv !== undefined && rawEnv.trim() !== '') {
    const parsed = Number(rawEnv);
    if (Number.isFinite(parsed)) {
      if (parsed <= 0) return null; // explicitly disabled
      desired = parsed;
    }
  }
  // Never let the no-output deadline exceed the global cap (it would never fire
  // before the global timer anyway), and never be shorter than that cap when
  // the cap is itself below the desired floor.
  return Math.min(desired, timeoutMs);
}

export function resolveProgressTimeoutMs(
  timeoutMs: number,
  rawEnv: string | undefined = process.env.CLAUDECLAW_PROGRESS_TIMEOUT_MS,
): number | null {
  let desired = DEFAULT_PROGRESS_TIMEOUT_MS;
  if (rawEnv !== undefined && rawEnv.trim() !== '') {
    const parsed = Number(rawEnv);
    if (Number.isFinite(parsed)) {
      if (parsed <= 0) return null;
      desired = parsed;
    }
  }
  return Math.min(desired, timeoutMs);
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Codex provider support (reserve fallback runs)
// ---------------------------------------------------------------------------

/**
 * Domains the Codex CLI needs for ChatGPT-subscription runs. Added to the
 * sandbox network allowlist ONLY for provider==='codex_cli' runs, so regular
 * Claude runs keep the tighter Anthropic-only policy.
 */
export const CODEX_SANDBOX_DOMAINS = [
  'chatgpt.com',
  '*.chatgpt.com',
  'api.openai.com',
  'auth.openai.com',
  '*.openai.com',
];

/** Path roots for codex auth handling — injectable for tests. */
export interface CodexAuthRoots {
  dataDir?: string;
  homeDir?: string;
}

function mtimeOrZero(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function copyAuthFile(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  // dst may be inside a guest-writable CODEX_HOME.  A reserve crash can leave
  // auth.json as a symlink/hardlink; copyFileSync would follow it and write the
  // real operator token into the attacker-chosen inode.  Atomic same-directory
  // replacement swaps the directory entry itself and never follows dst.
  writeFileAtomicNoFollowSync(dst, fs.readFileSync(src));
  try {
    fs.chmodSync(dst, 0o600);
  } catch {
    /* permissions are best-effort on copies */
  }
}

/**
 * Per-group CODEX_HOME directory. Deliberately under data/codex-homes/<group>,
 * NOT under the guest HOME (data/sessions/<group>, mounted RW every run): the
 * DATA_DIR deny-loop denies data/codex-homes for guests, so the
 * operator's auth.json never appears in a path a guest can read on a normal
 * Claude run. For a codex run this dir is explicitly (re)mounted RW.
 */
export function codexHomeDirFor(
  groupFolder: string,
  dataDir = DATA_DIR,
): string {
  return path.join(dataDir, 'codex-homes', groupFolder);
}

/**
 * Prepare a per-group CODEX_HOME for a sandboxed codex run.
 *
 * Codex reads auth strictly from $CODEX_HOME/auth.json, and the guest sandbox
 * (rightly) cannot read the operator's ~/.codex. So each group gets its own
 * codex home under data/codex-homes/<group>, seeded from TRUSTED sources only:
 * the newest of the operator's ~/.codex (kept fresh by the desktop app) and
 * the bot's central copy (data/codex-auth, host-only, seeded from ~/.codex).
 *
 * SECURITY: the group's own copy is agent-writable during a codex run, so it
 * is NEVER read back as a seed source and NEVER propagated to the central
 * copy or other groups — a guest that tampers with its auth.json (even with a
 * forged future mtime) only breaks its own next reserve run, which re-seeds
 * from the trusted sources anyway. The copy is DELETED after the run
 * (cleanupCodexAuth) so the operator token does not linger on disk; codex
 * session/rollout files in the same dir are kept for `exec resume`.
 */
export function prepareCodexHomeForRun(
  groupFolder: string,
  roots: CodexAuthRoots = {},
): { codexHome: string } | { error: string } {
  const dataDir = roots.dataDir ?? DATA_DIR;
  const homeDir = roots.homeDir ?? os.homedir();
  const codexHome = codexHomeDirFor(groupFolder, dataDir);
  const groupAuth = path.join(codexHome, 'auth.json');
  const centralAuth = path.join(dataDir, 'codex-auth', 'auth.json');
  const hostAuth = path.join(homeDir, '.codex', 'auth.json');

  try {
    ensureSafeGuestRuntimeDirectory(codexHome);
    const hostMtime = mtimeOrZero(hostAuth);
    const centralMtime = mtimeOrZero(centralAuth);
    if (hostMtime === 0 && centralMtime === 0) {
      return {
        error:
          'No Codex auth.json found (checked ~/.codex and data/codex-auth). ' +
          'Run `codex login` on the host first.',
      };
    }
    const newest = hostMtime >= centralMtime ? hostAuth : centralAuth;
    // Keep the central copy fresh from the operator's ~/.codex (trusted only).
    if (hostMtime > centralMtime) {
      copyAuthFile(hostAuth, centralAuth);
    }
    // Always overwrite the group copy — clobbers any in-sandbox tampering.
    copyAuthFile(newest, groupAuth);
    return { codexHome };
  } catch (err) {
    return {
      error: `Failed to prepare Codex auth for ${groupFolder}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Delete the per-group auth.json after a codex run so the operator's ChatGPT
 * token does not persist on disk between runs. Best-effort; codex
 * session/rollout files (for `exec resume`) are left intact.
 */
export function cleanupCodexAuth(
  groupFolder: string,
  dataDir = DATA_DIR,
): void {
  try {
    fs.rmSync(path.join(codexHomeDirFor(groupFolder, dataDir), 'auth.json'), {
      force: true,
    });
  } catch {
    /* best-effort — re-seeded fresh on the next run anyway */
  }
}

/**
 * Persist a codex-refreshed auth.json from a TRUSTED group's codex-home back to
 * the central store, so codex's in-place OpenAI token rotation (it rewrites
 * auth.json with a fresh access_token — and, when OpenAI rotates it, a fresh
 * refresh_token — during a run) survives cleanupCodexAuth. Without this, if the
 * operator's own ~/.codex is never refreshed and the ChatGPT refresh_token
 * rotates on a reserve run, the central copy keeps the now-dead token and the
 * reserve silently fails every run. Only ever called for is_main groups (the
 * caller gates on it): those run unsandboxed with full host access anyway, so
 * their codex-home is at the operator's own trust level — a GUEST copy, which
 * a sandboxed agent could tamper with, must NEVER propagate to central.
 * Best-effort and validated: a newer-than-central copy is propagated only if it
 * parses as JSON, so a truncated/crashed write is never pushed to the store.
 */
export function persistTrustedCodexAuthRefresh(
  groupFolder: string,
  dataDir = DATA_DIR,
): void {
  const groupAuth = path.join(
    codexHomeDirFor(groupFolder, dataDir),
    'auth.json',
  );
  const centralAuth = path.join(dataDir, 'codex-auth', 'auth.json');
  try {
    if (mtimeOrZero(groupAuth) <= mtimeOrZero(centralAuth)) return;
    JSON.parse(fs.readFileSync(groupAuth, 'utf-8')); // reject truncated/corrupt
    copyAuthFile(groupAuth, centralAuth);
  } catch {
    /* best-effort — a bad/absent refresh simply isn't propagated */
  }
}

/** Observer auth copies are ephemeral and must never update the trusted store. */
export function shouldPersistCodexAuthRefresh(
  trustedOwner: boolean,
  isolatedObserverAuth: boolean,
): boolean {
  return trustedOwner && !isolatedObserverAuth;
}

export async function runSandboxAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const rawIsMain = input.isMain === true;
  const isolatedObserverCandidate =
    rawIsMain &&
    group.agentConfig?.whatsappObserverAccess === true &&
    input.chatJid.endsWith('@s.whatsapp.net');
  if (
    isolatedObserverCandidate &&
    (group.isMain !== true || input.groupFolder !== group.folder)
  ) {
    logger.error(
      {
        group: group.name,
        registeredMain: group.isMain === true,
        folderMatches: input.groupFolder === group.folder,
      },
      'Refusing isolated observer: registered group scope mismatch',
    );
    return {
      status: 'error',
      result: null,
      error: 'Isolated observer registered group scope mismatch (fail-closed)',
    };
  }
  const isolatedObserverAuth = isolatedObserverCandidate;
  if (isolatedObserverAuth) {
    // The group registry is authoritative for observer mode. Mirror that bit
    // into the serialized input before tier restriction so a stale/missing
    // per-message agentConfig can never preserve owner capabilities.
    input = {
      ...input,
      agentConfig: {
        ...(input.agentConfig ?? {}),
        whatsappObserverAccess: true,
      },
    };
  }
  input = restrictRuntimeInputToAuthorizedTier(input);
  if (
    isolatedObserverAuth &&
    (input.isMain !== false || input.credentialProxyTier !== 'guest')
  ) {
    logger.error(
      { group: group.name },
      'Refusing isolated observer: runtime tier downgrade failed closed',
    );
    return {
      status: 'error',
      result: null,
      error: 'Isolated observer runtime tier downgrade failed (fail-closed)',
    };
  }
  const untrustedMain = shouldUseUntrustedMainRuntimeNamespace({
    groupIsMain: rawIsMain,
    credentialProxyTier: input.credentialProxyTier,
    chatJid: input.chatJid,
  });
  const untrustedPaths = untrustedMain
    ? untrustedMainRuntimePaths(DATA_DIR, group.folder)
    : null;
  const runtimePersistenceKey = untrustedPaths?.runtimeKey ?? group.folder;
  if (isolatedObserverAuth && input.codex) {
    input = {
      ...input,
      codex: {
        ...input.codex,
        // Observer excerpts may contain arbitrary third-party instructions.
        // Keep native browsing off even when the owner template enables it.
        webSearchEnabled: false,
      },
    };
  }
  const trustedOwner =
    !isolatedObserverAuth &&
    input.isMain === true &&
    input.credentialProxyTier === 'owner';
  const isCodexProvider = input.provider === 'codex_cli';
  const providerIsolationError = sandboxProviderIsolationError(
    input.provider,
    trustedOwner,
    isolatedObserverAuth,
  );
  if (providerIsolationError) {
    logger.warn(
      { group: group.name, provider: input.provider },
      'Refusing guest Codex provider run before preparing auth',
    );
    return {
      status: 'error',
      result: null,
      error: providerIsolationError,
    };
  }
  const groupDir = resolveGroupFolderPath(input.groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `claudeclaw-sandbox-${safeName}-${Date.now()}`;

  // Build mounts and srt settings
  const mounts = buildSandboxMounts(
    group,
    rawIsMain,
    input.senderIdentity,
    input.credentialProxyTier,
    input.chatJid,
  );
  const settingsDir = path.join(DATA_DIR, 'sandbox-settings');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, `${processName}.json`);

  // Per-group bypass: noSandbox=true runs agent directly on node without seatbelt.
  // Intended for dedicated bot hosts where there's nothing to protect.
  const bypassSandbox =
    trustedOwner &&
    (group.agentConfig?.noSandbox === true ||
      group.agentConfig?.fullAccess === true);

  // Codex provider (reserve fallback): every codex run gets a per-group
  // CODEX_HOME (auth + sessions + our generated config.toml), never the real
  // ~/.codex — so the desktop app's config can't affect the bot and the
  // operator token stays out of the guest-readable HOME tree. The OpenAI /
  // ChatGPT endpoints are added to the network allowlist. Sandboxed runs also
  // mount the dir; bypass (main) runs reach it on the real filesystem.
  let codexHomeDir: string | undefined;
  if (isCodexProvider) {
    if (isolatedObserverAuth && !bypassSandbox && os.platform() !== 'darwin') {
      logger.error(
        { group: group.name, processName, platform: os.platform() },
        'Refusing isolated observer Codex outside the verified macOS sandbox',
      );
      return {
        status: 'error',
        result: null,
        error:
          'Sandbox settings invalid (fail-closed): Isolated observer Codex sandbox is supported only on macOS',
      };
    }
    const prep = prepareCodexHomeForRun(runtimePersistenceKey);
    if ('error' in prep) {
      logger.error(
        { group: group.name, error: prep.error },
        'Refusing codex provider run: auth preparation failed',
      );
      return { status: 'error', result: null, error: prep.error };
    }
    codexHomeDir = prep.codexHome;
    if (!bypassSandbox) {
      if (isolatedObserverAuth) {
        try {
          applyIsolatedObserverCodexHomeCarveOut(mounts, codexHomeDir);
        } catch (err) {
          cleanupCodexAuth(runtimePersistenceKey);
          const message = err instanceof Error ? err.message : String(err);
          logger.error(
            { group: group.name, processName, err },
            'Refusing isolated observer Codex: invalid home carve-out',
          );
          return {
            status: 'error',
            result: null,
            error: `Sandbox settings invalid (fail-closed): ${message}`,
          };
        }
      } else {
        mounts.push({
          hostPath: codexHomeDir,
          containerPath: '/workspace/codex-home',
          readonly: false,
        });
      }
    }
  }

  // Merge domains and build settings only after the observer's exact home
  // carve-out is installed. Any failure here happens after auth.json was
  // seeded, so clean that ephemeral copy before returning.
  let settings: SandboxSettings;
  try {
    const extensionDomains = isolatedObserverAuth
      ? []
      : getExtensionAllowedDomains();
    const groupDomains = isolatedObserverAuth
      ? []
      : (group.agentConfig?.allowedDomains ?? []);
    const extraDomains = [
      ...extensionDomains,
      ...groupDomains,
      ...(isCodexProvider ? CODEX_SANDBOX_DOMAINS : []),
    ];
    settings = buildSandboxSettings(mounts, extraDomains);
  } catch (err) {
    if (codexHomeDir) cleanupCodexAuth(runtimePersistenceKey);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { group: group.name, processName, err },
      'Refusing sandbox: settings construction failed closed',
    );
    return {
      status: 'error',
      result: null,
      error: `Sandbox settings invalid (fail-closed): ${message}`,
    };
  }

  // srt's JSON policy can only deny paths known while it is assembled. On
  // macOS a guest additionally reaches srt's final sandbox-exec through our
  // owner-controlled PATH shim, which appends parent-minus-exact-child rules.
  // Those rules cover siblings created later in /tmp, /Volumes, the project
  // chain, groups, data, IPC, sessions and user-memory. External mounts are
  // intentionally absent from hostControlledReadRoots and cannot become
  // carve-outs in a shared host tree.
  let guestSeatbeltPolicyEncoded: string | undefined;
  if (!trustedOwner && os.platform() === 'darwin') {
    try {
      assertGuestSandboxExecWrapperSafe();
      const groupIpcRoot = fs.realpathSync(resolveGroupIpcPath(group.folder));
      const currentTasksPath = path.join(groupIpcRoot, 'current_tasks.json');
      const hostControlledReadRoots = [
        ...collectGuestSeatbeltHostReadRoots(process.cwd(), mounts),
        ...(isolatedObserverAuth
          ? [path.join(groupIpcRoot, 'input')]
          : [groupIpcRoot, currentTasksPath]),
      ];
      const groupAllowed = collectGuestSeatbeltAllowedSubtrees(
        GROUPS_DIR,
        hostControlledReadRoots,
      );
      const dataAllowed = collectGuestSeatbeltAllowedSubtrees(
        DATA_DIR,
        hostControlledReadRoots,
      );
      const ipcAllowed = [
        ...mounts
          .filter(
            (mount) =>
              mount.readonly === false &&
              mount.containerPath.startsWith('/workspace/ipc/'),
          )
          .map((mount) => mount.hostPath),
        currentTasksPath,
      ];
      const policy = buildGuestMacSeatbeltPolicy({
        projectRoot: process.cwd(),
        mountRoot: deriveSandboxMountRoot(
          process.cwd(),
          process.env.CLAUDECLAW_SANDBOX_MOUNT_ROOT,
        ),
        hostControlledReadRoots,
        restrictedParents: [
          { parent: GROUPS_DIR, allowedSubtrees: groupAllowed },
          { parent: DATA_DIR, allowedSubtrees: dataAllowed },
          { parent: groupIpcRoot, allowedSubtrees: ipcAllowed },
          ...(isolatedObserverAuth && codexHomeDir
            ? [
                {
                  parent: path.dirname(codexHomeDir),
                  allowedSubtrees: [codexHomeDir],
                },
              ]
            : []),
        ],
      });
      if (isolatedObserverAuth && codexHomeDir) {
        assertIsolatedObserverCodexHomeSeatbeltPolicy(policy, codexHomeDir);
      }
      guestSeatbeltPolicyEncoded = encodeGuestSeatbeltPolicy(policy);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { group: group.name, processName, err },
        'Refusing guest macOS sandbox: final Seatbelt boundary is invalid',
      );
      if (isCodexProvider) cleanupCodexAuth(runtimePersistenceKey);
      return {
        status: 'error',
        result: null,
        error: `Guest macOS sandbox policy invalid (fail-closed): ${message}`,
      };
    }
  }

  // Persist the policy FAIL-CLOSED. When the sandbox is actually enforcing
  // (i.e. not a bypass host), an invalid or unwritable settings file makes srt
  // silently fall back to an unrestricted read policy (whole-host reads). So
  // validate the object, write it, and read it back to confirm it round-trips;
  // abort the run on any failure rather than spawning a sandbox that can read
  // the entire host filesystem.
  try {
    if (!bypassSandbox) {
      assertValidSandboxSettings(settings);
      if (isolatedObserverAuth && codexHomeDir) {
        assertIsolatedObserverCodexHomeCarveOut(settings, codexHomeDir);
      }
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    if (!bypassSandbox) {
      const roundTrip = JSON.parse(
        fs.readFileSync(settingsPath, 'utf-8'),
      ) as SandboxSettings;
      assertValidSandboxSettings(roundTrip);
      if (isolatedObserverAuth && codexHomeDir) {
        assertIsolatedObserverCodexHomeCarveOut(roundTrip, codexHomeDir);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { group: group.name, processName, settingsPath, err },
      'Refusing to spawn sandbox: settings failed fail-closed validation ' +
        '(srt would otherwise run with unrestricted host reads)',
    );
    // This early return happens AFTER prepareCodexHomeForRun already seeded the
    // operator's ChatGPT auth.json into the group's codex-home. cleanupCodexAuth
    // otherwise runs only in the child close/error handlers below (never reached
    // here), so without this the token would linger on disk. Mirror it.
    if (isCodexProvider) cleanupCodexAuth(runtimePersistenceKey);
    return {
      status: 'error',
      result: null,
      error: `Sandbox settings invalid (fail-closed): ${message}`,
    };
  }
  let sandboxArgs: string[];
  let pathEnv: Record<string, string>;
  let secrets: Record<string, string>;
  try {
    const agentRunnerPath = path.join(
      CODE_ROOT,
      'agent',
      'runner',
      'dist',
      'index.js',
    );
    sandboxArgs = bypassSandbox
      ? [process.execPath, agentRunnerPath]
      : buildSandboxArgs(settingsPath);

    // Finish every fallible host-path/log preparation before opening a
    // credential-bearing listener. A failure here can return normally without
    // any proxy or child process to reclaim.
    pathEnv = {
      CLAUDECLAW_IPC_DIR: fs.realpathSync(resolveGroupIpcPath(group.folder)),
    };
    const extraHostPaths: string[] = [];
    for (const mount of mounts) {
      if (mount.containerPath === '/workspace/group')
        pathEnv.CLAUDECLAW_GROUP_DIR = mount.hostPath;
      else if (mount.containerPath === '/workspace/ipc')
        pathEnv.CLAUDECLAW_IPC_DIR = mount.hostPath;
      else if (mount.containerPath === '/workspace/project' && !mount.deny)
        pathEnv.CLAUDECLAW_PROJECT_DIR = mount.hostPath;
      else if (mount.containerPath === '/workspace/global')
        pathEnv.CLAUDECLAW_GLOBAL_DIR = mount.hostPath;
      else if (mount.containerPath === '/workspace/user-memory')
        pathEnv.CLAUDECLAW_SHARED_USER_MEMORY_DIR = mount.hostPath;
      else if (mount.containerPath === '/workspace/skills')
        pathEnv.CLAUDECLAW_SKILLS_DIR = mount.hostPath;
      else if (mount.containerPath === SANDBOX_GUEST_HOME)
        pathEnv.HOME = mount.hostPath;
      else if (mount.containerPath === '/workspace/tmp')
        pathEnv.CLAUDE_TMPDIR = mount.hostPath;
      else if (mount.containerPath?.startsWith('/workspace/extra'))
        extraHostPaths.push(mount.hostPath);
    }
    if (extraHostPaths.length > 0) {
      pathEnv.CLAUDECLAW_EXTRA_DIR = extraHostPaths[0];
      pathEnv.CLAUDECLAW_EXTRA_DIRS = JSON.stringify(extraHostPaths);
    }
    const scratchRoot = pathEnv.CLAUDE_TMPDIR ?? '/tmp/claude';
    if (!trustedOwner) {
      // Do not inherit the host user's shared macOS temp roots into a guest. All
      // generic runtime/tool temp APIs and Claude's own scratch now converge on
      // the same per-group directory that the sandbox explicitly allows.
      pathEnv.TMPDIR = scratchRoot;
      pathEnv.TMP = scratchRoot;
      pathEnv.TEMP = scratchRoot;
    }
    try {
      fs.mkdirSync(
        path.join(scratchRoot, `claude-${process.getuid?.() ?? 0}`),
        { recursive: true },
      );
    } catch {
      // Fine if it already exists or the runtime will report a denied write.
    }
    secrets = readEnvFile(['HELPER_SECRET', 'HELPER_PORT']);
    if (trustedOwner) {
      fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    } else {
      ensureSafeGuestRuntimeDirectory(
        path.join(DATA_DIR, 'runtime-logs', group.folder),
      );
    }
  } catch (err) {
    try {
      fs.unlinkSync(settingsPath);
    } catch {
      /* best-effort */
    }
    if (codexHomeDir) cleanupCodexAuth(runtimePersistenceKey);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { group: group.name, processName, err },
      'Refusing sandbox: pre-spawn path preparation failed closed',
    );
    return {
      status: 'error',
      result: null,
      error: `Sandbox setup failed (fail-closed): ${message}`,
    };
  }

  // The sandboxed runner/Claude CLI receives only a one-run placeholder and a
  // tenant-bound proxy identity. Real API/OAuth credentials are loaded inside
  // the host proxy closure and never enter the child process, its Bash env, or
  // its filesystem. A per-run ephemeral listener also makes a leaked
  // placeholder useless as soon as this sandbox exits.
  let sandboxCredentialProxy:
    | Awaited<ReturnType<typeof startCredentialProxy>>
    | undefined;
  let credentialProxyEnv: Record<string, string> = {};
  let credentialProxyClientSecret = '';
  let credentialProxyIdentityToken = '';
  if (!isCodexProvider) {
    try {
      credentialProxyClientSecret = randomBytes(32).toString('hex');
      const identitySigningSecret = randomBytes(32).toString('hex');
      credentialProxyIdentityToken = createCredentialProxyIdentityToken(
        identitySigningSecret,
        {
          tier: trustedOwner ? 'owner' : 'guest',
          tenantId: input.tenantId || group.folder,
        },
      );
      const authMode = detectAuthMode();
      sandboxCredentialProxy = await startCredentialProxy(
        0,
        '127.0.0.1',
        credentialProxyClientSecret,
        {},
        identitySigningSecret,
      );
      const address = sandboxCredentialProxy.address();
      if (!address || typeof address === 'string') {
        throw new Error('credential proxy did not publish a TCP address');
      }
      credentialProxyEnv = buildSandboxCredentialProxyEnv({
        authMode,
        baseUrl: `http://127.0.0.1:${address.port}`,
        clientSecret: credentialProxyClientSecret,
        identityToken: credentialProxyIdentityToken,
      });
    } catch (err) {
      closeSandboxCredentialProxyServer(sandboxCredentialProxy);
      if (credentialProxyIdentityToken) {
        // createIdentityToken precedes detectAuthMode/startCredentialProxy. If
        // either throws before a Server exists, there is no server 'close'
        // hook to revoke this otherwise-live capability.
        revokeCredentialProxyIdentityToken(credentialProxyIdentityToken);
      }
      try {
        fs.unlinkSync(settingsPath);
      } catch {
        /* best-effort */
      }
      const message = redactContainerRuntimeDiagnostics(
        err instanceof Error ? err.message : String(err),
        [credentialProxyClientSecret, credentialProxyIdentityToken],
      );
      logger.error(
        { group: group.name, error: message },
        'Refusing sandbox run: host credential proxy failed to start',
      );
      return {
        status: 'error',
        result: null,
        error: `Sandbox credential proxy unavailable (fail-closed): ${message}`,
      };
    }
  }

  let credentialProxyClosed = false;
  const closeSandboxCredentialProxy = (): void => {
    if (credentialProxyClosed) return;
    credentialProxyClosed = true;
    closeSandboxCredentialProxyServer(sandboxCredentialProxy);
    if (credentialProxyIdentityToken) {
      // Server.close revokes its issuer too; the explicit token revoke keeps
      // this lifecycle fail-closed even if a partial/future server lacks that
      // hook. The registry operation is intentionally idempotent.
      revokeCredentialProxyIdentityToken(credentialProxyIdentityToken);
    }
  };

  const diagnosticSecrets = [
    credentialProxyClientSecret,
    credentialProxyIdentityToken,
    input.taskAuthorizationCapability || '',
    input.memoryWriteCapability || '',
    input.codexControlRunId || '',
    trustedOwner ? secrets.HELPER_SECRET || '' : '',
  ];

  let sandboxSpawnBaseEnv: NodeJS.ProcessEnv;
  let guestSeatbeltBootstrapEnv: NodeJS.ProcessEnv;
  try {
    logger.info(
      {
        group: group.name,
        processName,
        mountCount: mounts.length,
        isMain: input.isMain,
        bypassSandbox,
      },
      bypassSandbox
        ? 'Spawning agent WITHOUT sandbox'
        : 'Spawning sandbox agent',
    );

    sandboxSpawnBaseEnv = sandboxChildBaseEnv(process.env, trustedOwner);
    guestSeatbeltBootstrapEnv =
      guestSeatbeltPolicyEncoded !== undefined
        ? {
            PATH: `${GUEST_SANDBOX_EXEC_WRAPPER_DIR}${path.delimiter}${
              sandboxSpawnBaseEnv.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'
            }`,
            [GUEST_SEATBELT_POLICY_ENV]: guestSeatbeltPolicyEncoded,
          }
        : {};
  } catch (err) {
    closeSandboxCredentialProxy();
    try {
      fs.unlinkSync(settingsPath);
    } catch {
      /* best-effort */
    }
    if (codexHomeDir) cleanupCodexAuth(runtimePersistenceKey);
    const message = redactContainerRuntimeDiagnostics(
      err instanceof Error ? err.message : String(err),
      diagnosticSecrets,
    );
    return {
      status: 'error',
      result: null,
      error: `Sandbox setup failed (fail-closed): ${message}`,
    };
  }

  return new Promise((resolve) => {
    const failPostSpawnSetup = (
      err: unknown,
      spawnedChild?: ChildProcess,
      createdPidFile?: string,
    ): void => {
      closeSandboxCredentialProxy();
      if (spawnedChild) {
        spawnedChild.removeAllListeners();
        spawnedChild.stdout?.removeAllListeners();
        spawnedChild.stderr?.removeAllListeners();
        spawnedChild.stdin?.removeAllListeners();
        spawnedChild.on('error', () => undefined);
        spawnedChild.stdin?.on('error', () => undefined);
        killProcessTree(spawnedChild, 'SIGKILL');
      }
      for (const cleanupPath of [createdPidFile, settingsPath]) {
        if (!cleanupPath) continue;
        try {
          fs.unlinkSync(cleanupPath);
        } catch {
          /* best-effort */
        }
      }
      if (codexHomeDir) cleanupCodexAuth(runtimePersistenceKey);
      const message = redactContainerRuntimeDiagnostics(
        err instanceof Error ? err.message : String(err),
        diagnosticSecrets,
      );
      logger.error(
        { group: group.name, processName, error: message },
        'Sandbox post-spawn setup failed closed',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Sandbox setup failed (fail-closed): ${message}`,
      });
    };

    let child: ChildProcess;
    try {
      child = spawn(sandboxArgs[0], sandboxArgs.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group (setsid) so a timeout kill can reap the WHOLE tree
        // (npx → sandbox-runtime → node agent-runner → claude SDK) via a
        // negative-PID signal. Without this, force-killing only the wrapper
        // orphans a wedged `claude` grandchild to launchd and leaks memory.
        detached: true,
        env: {
          ...sandboxSpawnBaseEnv,
          ...guestSeatbeltBootstrapEnv,
          TZ: TIMEZONE,
          // Authorized owner/main Codex receives only its explicitly prepared
          // per-run home. Claude receives only the loopback proxy placeholder.
          ...(isCodexProvider
            ? codexHomeDir
              ? { CODEX_HOME: codexHomeDir }
              : {}
            : credentialProxyEnv),
          // HELPER_SECRET is the credential for the host GUI-control daemon
          // (osascript/cliclick — effectively arbitrary host control). Only MAIN
          // (the trusted operator group) may use computer-control; untrusted guest
          // sandboxes must NOT have the helper credential pre-positioned in their
          // env. Gating on the concrete run's owner tier means a future shell/exec
          // guest tool or a
          // tool-allowlist regression can no longer be parlayed into host takeover
          // via the always-localhost-reachable helper. HELPER_PORT is gated with
          // it (useless without the secret, and no reason to leak the port map).
          ...(trustedOwner && secrets.HELPER_SECRET
            ? { HELPER_SECRET: secrets.HELPER_SECRET }
            : {}),
          ...(trustedOwner && secrets.HELPER_PORT
            ? { HELPER_PORT: secrets.HELPER_PORT }
            : {}),
          CLAUDECLAW_RUNNER_IDLE_WAIT_MS: String(RUNNER_IDLE_WAIT_MS),
          ...pathEnv,
        },
      });
    } catch (err) {
      failPostSpawnSetup(err);
      return;
    }

    const pidFile = path.join(SANDBOX_PID_DIR, `${processName}.pid`);
    try {
      // Write PID file for orphan cleanup.
      fs.mkdirSync(SANDBOX_PID_DIR, { recursive: true });
      if (child.pid) {
        fs.writeFileSync(pidFile, String(child.pid));
      }

      onProcess(child, processName);

      // Guard the child's stdin Writable: if the child exits before/while we
      // write, the pipe emits an independent EPIPE error.
      child.stdin!.on('error', (err) => {
        logger.warn(
          { group: group.name, processName, err },
          'Sandbox stdin write error (child likely exited early)',
        );
      });
      child.stdin!.write(JSON.stringify(input));
      child.stdin!.end();
    } catch (err) {
      failPostSpawnSetup(err, child, pidFile);
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let hadStreamingOutput = false;
    let newSessionId: string | undefined;

    // Timeout handling — declared before event handlers so closures can reference them
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    // HANG timeout — separate, much shorter cap that fires when the sandbox
    // goes silent on BOTH streams for a sustained window. Distinct from the
    // global timeoutMs (which has to be long enough to span IDLE_TIMEOUT
    // because the sandbox legitimately stays open between piped messages).
    // Resets on any stdout OR stderr chunk — agent-runner logs roughly every
    // few seconds during normal operation (msg #N, IPC poll, etc), so true
    // silence for HANG_TIMEOUT_MS means the agent is really stuck (SDK
    // deadlock, blocked Anthropic call, etc), and we'd rather kill+retry
    // than have the user staring at a frozen typing indicator.
    const HANG_TIMEOUT_MS = 180_000; // 3 min; matches typing-indicator safeguard

    let timeoutReason: 'global' | 'hang' | 'no-output' | 'progress' | null =
      null;
    // Tracked so the 'close'/'error' handlers can cancel it. If left dangling
    // it always re-fires 5s after a timeout kill (see below) and could signal a
    // recycled PID group on a busy host.
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    const killOnTimeout = (
      reason: 'global' | 'hang' | 'no-output' | 'progress',
    ) => {
      timedOut = true;
      timeoutReason = reason;
      logger.error(
        { group: group.name, processName, reason },
        reason === 'global'
          ? 'Sandbox timeout, killing'
          : reason === 'no-output'
            ? 'Sandbox produced no output before deadline, killing (will retry)'
            : reason === 'progress'
              ? 'Sandbox made no useful progress after output, killing (will retry)'
              : 'Sandbox went silent for 3+ min, killing (likely SDK/network deadlock)',
      );
      // Reap the whole process group, not just the wrapper, so the inner
      // `claude` SDK process can't survive as an orphan holding memory.
      killProcessTree(child, 'SIGTERM');
      // Escalate to SIGKILL if SIGTERM didn't take within 5s. In the normal
      // case SIGTERM works and 'close' fires first, clearing this timer. We
      // probe real liveness with signal 0 rather than child.killed: the
      // group-kill path (process.kill(-pid)) never sets Node's child.killed
      // flag, so a clean exit would otherwise still look "not killed" and we'd
      // fire a redundant SIGKILL — possibly at a recycled PID group. unref()
      // so a stray timer can't hold the event loop open.
      if (sigkillTimer) clearTimeout(sigkillTimer);
      sigkillTimer = setTimeout(() => {
        const pid = child.pid;
        if (!pid || pid <= 1) return;
        try {
          process.kill(pid, 0); // throws if the process is gone
        } catch {
          return; // already exited/reaped — nothing to escalate
        }
        killProcessTree(child, 'SIGKILL');
      }, 5000);
      sigkillTimer.unref?.();
    };
    const clearSigkillTimer = () => {
      if (sigkillTimer) {
        clearTimeout(sigkillTimer);
        sigkillTimer = null;
      }
    };

    let timeout = setTimeout(() => killOnTimeout('global'), timeoutMs);
    let hangTimeout = setTimeout(() => killOnTimeout('hang'), HANG_TIMEOUT_MS);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => killOnTimeout('global'), timeoutMs);
    };
    const resetHangTimeout = () => {
      clearTimeout(hangTimeout);
      hangTimeout = setTimeout(() => killOnTimeout('hang'), HANG_TIMEOUT_MS);
    };

    // FIRST-OUTPUT deadline. The hang timer above resets on ANY stdout/stderr
    // chunk, so a run that is "alive but making no progress" (stderr chatter,
    // zero real output) evades it and burns the full global timeout.
    // This deadline is NOT reset by stream noise; it clears only once the first
    // real output marker is parsed. Classified 'no-output' so the orchestrator
    // rolls back and retries (same as a hang), rather than silently dropping.
    //
    // The deadline is budget-aware and operator-configurable (see
    // resolveNoOutputTimeoutMs): clamped to never exceed the global timeoutMs,
    // raisable via CLAUDECLAW_NO_OUTPUT_TIMEOUT_MS for legitimately long first
    // turns, and disable-able (value <= 0 → null) so a long single turn isn't
    // killed below the configured task budget.
    const noOutputDeadlineMs = resolveNoOutputTimeoutMs(timeoutMs);
    let noOutputTimeout: ReturnType<typeof setTimeout> | null =
      noOutputDeadlineMs === null
        ? null
        : setTimeout(() => killOnTimeout('no-output'), noOutputDeadlineMs);
    const clearNoOutputTimeout = () => {
      if (noOutputTimeout) {
        clearTimeout(noOutputTimeout);
        noOutputTimeout = null;
      }
    };
    // Heartbeat frames prove the agent is alive mid-turn but are NOT real
    // output: they push the first-output deadline forward instead of clearing
    // it, so a run whose heartbeats stop still gets killed by 'no-output'.
    const rearmNoOutputTimeout = () => {
      if (noOutputTimeout && noOutputDeadlineMs !== null) {
        clearTimeout(noOutputTimeout);
        noOutputTimeout = setTimeout(
          () => killOnTimeout('no-output'),
          noOutputDeadlineMs,
        );
      }
    };

    const progressDeadlineMs = resolveProgressTimeoutMs(timeoutMs);
    let progressTimeout: ReturnType<typeof setTimeout> | null = null;
    const resetProgressTimeout = () => {
      if (progressTimeout) clearTimeout(progressTimeout);
      progressTimeout =
        progressDeadlineMs === null
          ? null
          : setTimeout(() => killOnTimeout('progress'), progressDeadlineMs);
    };
    const clearProgressTimeout = () => {
      if (progressTimeout) {
        clearTimeout(progressTimeout);
        progressTimeout = null;
      }
    };

    // Confirmed IPC deliveries are useful progress that never crosses the
    // child's stdout: a run can report exclusively via the send-message MCP
    // tool (data/ipc/<group>/messages → host IPC watcher → router), e.g. an
    // admin visual site walkthrough posting photo updates. The no-output and
    // progress deadlines above reset only on parsed stdout markers, so such a
    // run looked dead to them and was killed mid-work at the no-output
    // deadline with turns=0. Treat a
    // delivery CONFIRMED by the host watcher for THIS group's sandbox like an
    // output marker for the liveness deadlines: clear the first-output
    // deadline and re-arm the useful-progress one. The hang timer is left
    // alone (agent-runner stderr chatter already feeds it) and the global
    // timer is untouched so the total budget stays operator-bounded.
    // Unsubscribed in the 'close'/'error' handlers — a delivery confirmed
    // after the run ended must not touch a finished run's timers.
    const unsubscribeIpcActivity = onRunIpcActivity(group.folder, (kind) => {
      logger.debug(
        { group: group.name, processName, kind },
        'Sandbox liveness deadlines reset by confirmed IPC delivery',
      );
      clearNoOutputTimeout();
      resetProgressTimeout();
    });

    // Streaming output parsing
    const frameParser = new BoundedOutputFrameParser(
      OUTPUT_START_MARKER,
      OUTPUT_END_MARKER,
      CONTAINER_MAX_OUTPUT_SIZE,
    );
    let streamFrameError: string | undefined;
    let outputChain = Promise.resolve();
    const stderrDiagnostics = createRedactedDiagnosticLineBuffer(
      diagnosticSecrets,
      (line) => logger.debug({ sandbox: group.folder }, line),
    );

    child.stdout!.on('data', (data) => {
      const chunk = data.toString();
      // Any stdout chunk = sandbox is alive and producing — reset hang detector.
      resetHangTimeout();

      // Accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Sandbox stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        const parsedFrames = frameParser.push(chunk);
        if (parsedFrames.oversized && !streamFrameError) {
          streamFrameError = `Streamed output frame exceeded ${CONTAINER_MAX_OUTPUT_SIZE} characters`;
          logger.warn(
            { group: group.name, maxFrameChars: CONTAINER_MAX_OUTPUT_SIZE },
            'Rejected oversized sandbox output frame',
          );
        }
        for (const jsonStr of parsedFrames.frames) {
          try {
            const parsed = redactSandboxOutput(
              JSON.parse(jsonStr) as ContainerOutput,
              diagnosticSecrets,
            );
            if (parsed.status === 'heartbeat') {
              // Liveness-only frame from the agent runner (emitted while a
              // tool is still executing or the SDK yielded recently). Re-arm
              // the mid-turn watchdogs but do NOT mark real output and do NOT
              // extend the global budget — a truly wedged tool still dies at
              // the global timeout. Forwarded to onOutput so the orchestrator
              // can refresh its stale-active tracking.
              rearmNoOutputTimeout();
              resetProgressTimeout();
              outputChain = outputChain
                .then(() => onOutput(parsed))
                .catch((err) => {
                  logger.warn(
                    { group: group.name, error: err },
                    'onOutput handler rejected on heartbeat; continuing',
                  );
                });
              continue;
            }
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            clearNoOutputTimeout();
            resetProgressTimeout();
            resetTimeout();
            // Swallow onOutput rejections so the chain can never become a
            // rejected promise. Every terminal `resolve(...)` below is gated on
            // `outputChain.then(...)`; a single rejected onOutput (e.g. a
            // SQLITE_BUSY/disk-full session write) would otherwise skip all of
            // them, leaving runSandboxAgent's Promise unresolved forever and the
            // group stuck active until the 10-min stale net (without reaping the
            // leaked child).
            outputChain = outputChain
              .then(() => onOutput(parsed))
              .catch((err) => {
                logger.warn(
                  { group: group.name, error: err },
                  'onOutput handler rejected; continuing so the run still resolves',
                );
              });
          } catch {
            logger.warn(
              { group: group.name, error: 'Invalid JSON output frame' },
              'Failed to parse sandbox output chunk',
            );
          }
        }
      }
    });

    child.stderr!.on('data', (data) => {
      const chunk = data.toString();
      // Any stderr chunk = sandbox is alive — agent-runner logs status
      // messages (msg #N, IPC polls) here every few seconds during work,
      // so silence on this stream is a strong signal the agent is hung.
      resetHangTimeout();
      stderrDiagnostics.push(chunk);
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Sandbox stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    child.on('close', (code) => {
      closeSandboxCredentialProxy();
      try {
        stderrDiagnostics.flush();
      } catch {
        // Diagnostics must never delay proxy revocation or run cleanup.
      }
      clearTimeout(timeout);
      clearTimeout(hangTimeout);
      clearNoOutputTimeout();
      clearProgressTimeout();
      clearSigkillTimer();
      unsubscribeIpcActivity();
      // Clean up PID and settings files
      try {
        fs.unlinkSync(pidFile);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(settingsPath);
      } catch {
        /* ignore */
      }
      // Delete the operator's per-group Codex token copy so it does not
      // linger on disk between runs (defense-in-depth: the dir is already
      // outside the guest-readable HOME tree). For TRUSTED (is_main) groups,
      // first propagate codex's in-run token refresh back to the central store
      // so the reserve doesn't die when the ChatGPT refresh_token rotates.
      if (codexHomeDir) {
        if (shouldPersistCodexAuthRefresh(trustedOwner, isolatedObserverAuth)) {
          persistTrustedCodexAuthRefresh(runtimePersistenceKey);
        }
        cleanupCodexAuth(runtimePersistenceKey);
      }

      const duration = Date.now() - startTime;
      const safeStderr = redactContainerRuntimeDiagnostics(
        stderr,
        diagnosticSecrets,
      );

      if (streamFrameError) {
        outputChain.then(() => {
          resolve({
            status: 'error',
            result: null,
            error: streamFrameError,
          });
        });
        return;
      }

      if (timedOut) {
        // hang-timeout is NOT idle cleanup. It fires because the agent went
        // silent on both streams while presumably *processing* a message —
        // the user is waiting for a reply that will never come. Treat as
        // error so the orchestrator rolls back the cursor and a fresh
        // sandbox can re-handle the unprocessed messages.
        if (
          timeoutReason === 'hang' ||
          timeoutReason === 'no-output' ||
          timeoutReason === 'progress'
        ) {
          logger.error(
            {
              group: group.name,
              processName,
              duration,
              code,
              reason: timeoutReason,
            },
            'Sandbox killed by hang/no-output/progress timeout (will retry via orchestrator rollback)',
          );
          outputChain.then(() => {
            resolve({ status: 'error', result: null, newSessionId });
          });
          return;
        }
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Sandbox timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }
        logger.error(
          { group: group.name, processName, duration, code },
          'Sandbox timed out with no output',
        );
        // Await any in-flight onOutput before resolving (see code!=0 below).
        outputChain.then(() => {
          resolve({
            status: 'error',
            result: null,
            error: `Sandbox timed out after ${configTimeout}ms`,
          });
        });
        return;
      }

      if (code !== 0) {
        // Per-attempt non-zero exit. Benign (post-result EPIPE / exit 1 after a
        // delivered reply) and transient-but-retryable cases both land here, so
        // this fires far more often than a real failure. The disposition is
        // decided downstream in runAgent's error handler; a genuinely terminal
        // run still surfaces as ERROR via 'Max retries exceeded'. WARN here
        // avoids ~650 ERROR lines that mask the ~44 real terminal ones.
        logger.warn(
          { group: group.name, code, duration, stderr: safeStderr },
          'Sandbox exited with error',
        );
        // Gate on outputChain like the streaming-success branch. The
        // agent-runner emits an OUTPUT error marker and THEN process.exit(1);
        // on the host that marker is parsed in the stdout handler and enqueued
        // onto outputChain (async, in-flight) while 'close' fires with a
        // non-zero code. Resolving immediately would let the run be reported
        // finished while the last onOutput is still running detached — racing
        // delivery/ordering. Wait for it to settle first. outputChain is
        // .catch-guarded so this can never hang on a rejected handler.
        outputChain.then(() => {
          resolve({
            status: 'error',
            result: null,
            error: `Sandbox exited with code ${code}: ${safeStderr.slice(-200)}`,
          });
        });
        return;
      }

      // Streaming mode: wait for output chain to settle
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Sandbox completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse last output marker pair. Gate on outputChain too,
      // for symmetry with the streaming branch and so any in-flight onOutput
      // settles before the run is considered finished.
      outputChain.then(() => {
        try {
          const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
          const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

          let jsonLine: string;
          if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            jsonLine = stdout
              .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
              .trim();
          } else {
            const lines = stdout.trim().split('\n');
            jsonLine = lines[lines.length - 1];
          }
          resolve(
            redactSandboxOutput(
              JSON.parse(jsonLine) as ContainerOutput,
              diagnosticSecrets,
            ),
          );
        } catch {
          resolve({
            status: 'error',
            result: null,
            error: 'Failed to parse sandbox output: Invalid JSON output frame',
          });
        }
      });
    });

    child.on('error', (err) => {
      closeSandboxCredentialProxy();
      try {
        stderrDiagnostics.flush();
      } catch {
        // Diagnostics must never delay proxy revocation or run cleanup.
      }
      clearTimeout(timeout);
      clearTimeout(hangTimeout);
      clearNoOutputTimeout();
      clearProgressTimeout();
      clearSigkillTimer();
      unsubscribeIpcActivity();
      try {
        fs.unlinkSync(pidFile);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(settingsPath);
      } catch {
        /* ignore */
      }
      if (codexHomeDir) {
        cleanupCodexAuth(runtimePersistenceKey);
      }
      resolve({
        status: 'error',
        result: null,
        error: `Sandbox spawn error: ${redactContainerRuntimeDiagnostics(
          err.message,
          diagnosticSecrets,
        )}`,
      });
    });
  });
}
