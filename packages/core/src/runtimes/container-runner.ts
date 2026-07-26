/**
 * Container Runner for ClaudeClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../orchestrator/env.js';
import { getExtensionContainerEnvKeys } from '../orchestrator/extensions.js';
import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
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
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  CREDENTIAL_PROXY_CLIENT_SECRET,
  CREDENTIAL_PROXY_IDENTITY_SIGNING_SECRET,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import {
  CREDENTIAL_PROXY_IDENTITY_HEADER,
  createCredentialProxyIdentityToken,
  detectAuthMode,
  revokeCredentialProxyIdentityToken,
} from '../orchestrator/credential-proxy.js';
import { validateAdditionalMounts } from '../orchestrator/mount-security.js';
import { safeSharedMemoryKey } from '../orchestrator/memory-context.js';
import {
  safeRuntimeSessionIdOrUndefined,
  shouldUseUntrustedMainRuntimeNamespace,
  untrustedMainRuntimePaths,
} from '../orchestrator/runtime-namespace.js';
import type { RegisteredGroup, SenderIdentity } from '../orchestrator/types.js';
import { BoundedOutputFrameParser } from './bounded-output-parser.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---CLAUDECLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CLAUDECLAW_OUTPUT_END---';
const CONTAINER_GUEST_HOME = ['/home', 'node'].join('/');
const CONTAINER_GUEST_CLAUDE_HOME = `${CONTAINER_GUEST_HOME}/.claude`;

/**
 * Forcibly remove a container by NAME after a graceful `container stop` fails.
 *
 * The spawned `container run` process is the foreground CLI client and is NOT
 * detached, so SIGKILLing it does not reliably tear down the workload: with
 * Apple Container the actual process runs in a daemon-managed VM keyed by name.
 * Escalate against the runtime itself — `container kill <name>` then
 * `container rm -f <name>` — and verify removal via `container ls`. If the
 * container is still present afterwards, log an explicit orphan warning so the
 * startup `cleanupOrphans` sweep (container-runtime.ts) can reap it on next run.
 */
function forceRemoveContainer(groupName: string, containerName: string): void {
  const bin = CONTAINER_RUNTIME_BIN as string;
  // SIGKILL the workload by name (daemon-managed), then force-remove it.
  exec(`${bin} kill ${containerName}`, { timeout: 15000 }, () => {
    exec(`${bin} rm -f ${containerName}`, { timeout: 15000 }, () => {
      // Verify the container is actually gone before giving up.
      exec(
        `${bin} ls --all --format json`,
        { timeout: 15000 },
        (lsErr, stdout) => {
          if (lsErr) {
            logger.warn(
              { group: groupName, containerName, lsErr },
              'Could not verify container removal after force kill',
            );
            return;
          }
          let stillPresent = false;
          try {
            const containers: Array<{ configuration?: { id?: string } }> =
              JSON.parse(stdout || '[]');
            stillPresent = containers.some(
              (c) => c?.configuration?.id === containerName,
            );
          } catch {
            // Unparseable output — fall back to a substring check.
            stillPresent = (stdout || '').includes(containerName);
          }
          if (stillPresent) {
            logger.error(
              { group: groupName, containerName },
              'ORPHAN: container survived force kill/rm; will be reaped by cleanupOrphans on next start',
            );
          } else {
            logger.info(
              { group: groupName, containerName },
              'Container force-removed by name after graceful stop failed',
            );
          }
        },
      );
    });
  });
}

/** Codex CLI runtime config passed to the agent runner for provider-reserve runs. */
export interface CodexRunnerInputConfig {
  /** Absolute path to the codex binary (resolved host-side). */
  command: string;
  model: string;
  fallbackModel?: string;
  reasoningEffort?: string;
  webSearchEnabled?: boolean;
  /** Per-turn hard timeout inside the runner. */
  timeoutMs?: number;
  /** Images attached to the current turn (host paths readable in-sandbox). */
  imagePaths?: string[];
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentConfig?: import('../orchestrator/types.js').AgentConfig;
  tenantId?: string;
  /** Host-derived authorization tier for credential-proxy availability. */
  credentialProxyTier?: 'owner' | 'guest';
  senderIdentity?: SenderIdentity;
  /** Host-issued bearer scoped to this exact run identity (not a signing key). */
  memoryWriteCapability?: string;
  /** Ed25519 public verifier; safe to expose to the sandbox. */
  memoryProvenancePublicKey?: string;
  /** Host-issued bearer that can request exact, one-use task-operation grants. */
  taskAuthorizationCapability?: string;
  /** Exact current direct-owner message explicitly authorized Codex GUI control. */
  codexGuiControlAuthorized?: boolean;
  /** Opaque identifier used only to revoke delayed Codex mutations after stop. */
  codexControlRunId?: string;
  /** Public per-turn Google RPC wrappers; host policy remains authoritative. */
  googleAllowedTools?: string[];
  /**
   * Public, host-generated coordinates for the exact append target authorized
   * in this direct owner turn. Never populated from model/user arguments.
   */
  googleSheetTargetHints?: Array<{
    label: string;
    spreadsheetId: string;
    range: string;
    columnCount: number;
    maxRowsPerCall: number;
  }>;
  /**
   * LLM backend for this run. Default 'claude_sdk'. 'codex_cli' runs the same
   * workspace/tools/memory through the Codex CLI (reserve fallback when the
   * Claude run failed). Sandbox runtime only.
   */
  provider?: 'claude_sdk' | 'codex_cli';
  /** Required when provider === 'codex_cli'. */
  codex?: CodexRunnerInputConfig;
}

export interface ContainerOutput {
  // 'heartbeat' = liveness-only frame from the agent runner mid-turn; runtimes
  // refresh watchdogs on it but must not treat it as delivered output.
  status: 'success' | 'error' | 'heartbeat';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  durationMs?: number;
  turns?: number;
  /**
   * Exact artifacts reported by completed built-in Codex image-generation
   * calls. Heartbeat frames may carry these before the turn itself completes
   * so the host can checkpoint them crash-safely.
   */
  imageArtifacts?: Array<{
    callId: string;
    savedPath: string;
  }>;
  /** Image generation completed even when no usable saved_path was reported. */
  imageGenerationCompleted?: boolean;
  /** All completed image-generation call ids, including pathless results. */
  imageGenerationCallIds?: string[];
  /** A non-repeatable host action may already have happened. */
  sideEffected?: boolean;
  /** Exact side-effecting tool names observed by a supporting runner. */
  sideEffectTools?: string[];
}

/** Redact credential material before it reaches persistent/runtime logs. */
export function redactContainerRuntimeDiagnostics(
  value: unknown,
  exactSecrets: readonly string[] = [],
): string {
  let text = String(value ?? '');
  for (const secret of [...new Set(exactSecrets.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  )) {
    text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/\bBearer\s+[^\s,"'}]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|client[_-]?secret|authorization|capability|password)\s*[=:]\s*)[^\s,"'}]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /("(?:taskAuthorizationCapability|memoryWriteCapability|codexControlRunId|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_CUSTOM_HEADERS)"\s*:\s*")[^"]*(")/gi,
      '$1[REDACTED]$2',
    )
    .replace(
      new RegExp(
        `(${CREDENTIAL_PROXY_IDENTITY_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*)[^\\s,;]+`,
        'gi',
      ),
      '$1[REDACTED]',
    );
}

export interface RedactedDiagnosticLineBuffer {
  push(value: unknown): void;
  flush(): void;
}

/**
 * Buffer child diagnostics until a complete line is available, then redact it
 * as a whole. Exact run capabilities can be split across arbitrary stream
 * chunks, so redacting each chunk independently would leak both halves. An
 * overlong unterminated line is discarded rather than partially logged.
 */
export function createRedactedDiagnosticLineBuffer(
  exactSecrets: readonly string[],
  onLine: (redactedLine: string) => void,
  maxLineChars = CONTAINER_MAX_OUTPUT_SIZE,
): RedactedDiagnosticLineBuffer {
  const limit = Math.max(1, Math.floor(maxLineChars));
  let carry = '';
  let discardUntilNewline = false;

  const emit = (): void => {
    const line = carry.endsWith('\r') ? carry.slice(0, -1) : carry;
    if (line) onLine(redactContainerRuntimeDiagnostics(line, exactSecrets));
  };

  return {
    push(value: unknown): void {
      const chunk = String(value ?? '');
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf('\n', cursor);
        const end = newline === -1 ? chunk.length : newline;
        const segment = chunk.slice(cursor, end);
        if (!discardUntilNewline) {
          if (carry.length + segment.length > limit) {
            carry = '';
            discardUntilNewline = true;
          } else {
            carry += segment;
          }
        }
        if (newline === -1) return;
        if (!discardUntilNewline) emit();
        carry = '';
        discardUntilNewline = false;
        cursor = newline + 1;
      }
    },
    flush(): void {
      if (!discardUntilNewline) emit();
      carry = '';
      discardUntilNewline = false;
    },
  };
}

export function containerCredentialEnvironmentValues(
  args: readonly string[],
): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== '-e') continue;
    const assignment = args[index + 1];
    const separator = assignment.indexOf('=');
    if (separator < 1 || separator >= assignment.length - 1) continue;
    const key = assignment.slice(0, separator);
    const value = assignment.slice(separator + 1);
    if (
      key === 'ANTHROPIC_API_KEY' ||
      key === 'CLAUDE_CODE_OAUTH_TOKEN' ||
      /(?:secret|token|password|credential|authorization|api[_-]?key|private[_-]?key|capability)/i.test(
        key,
      )
    ) {
      values.push(value);
    }
    if (key === 'ANTHROPIC_CUSTOM_HEADERS') {
      for (const header of value.split(/\r?\n/)) {
        const headerSeparator = header.indexOf(':');
        if (headerSeparator >= 0 && headerSeparator < header.length - 1) {
          const headerName = header.slice(0, headerSeparator).trim();
          if (
            headerName.toLowerCase() ===
              CREDENTIAL_PROXY_IDENTITY_HEADER.toLowerCase() ||
            /(?:authorization|secret|token|password|credential|api[_-]?key|private[_-]?key|capability)/i.test(
              headerName,
            )
          ) {
            values.push(header.slice(headerSeparator + 1).trim());
          }
        }
      }
    }
  }
  return values;
}

function redactContainerOutput(
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

/**
 * Only an explicitly owner-authorized run in the main group may inherit the
 * main/full-access runtime surface. `isMain` describes the destination group;
 * it is not, by itself, proof that the current message was owner-authored (a
 * co-member can speak in the main multi-sender chat). The credential proxy
 * tier is host-derived for the concrete batch and therefore supplies the
 * missing per-run authorization bit.
 *
 * Scheduled tasks currently carry no durable owner provenance and deliberately
 * arrive as guest-tier. They stay sandboxed until that provenance exists.
 */
export function restrictRuntimeInputToAuthorizedTier(
  input: ContainerInput,
): ContainerInput {
  const telegramRun = String(input.chatJid).startsWith('tg:');
  const restrictedWhatsAppObserverRuntime =
    input.isMain === true &&
    input.agentConfig?.whatsappObserverAccess === true &&
    String(input.chatJid).endsWith('@s.whatsapp.net');
  const directSenderIdentity =
    !telegramRun || input.senderIdentity?.telegram_message_origin === 'direct'
      ? input.senderIdentity
      : undefined;
  const trustedOwner =
    input.isMain === true &&
    input.credentialProxyTier === 'owner' &&
    !restrictedWhatsAppObserverRuntime &&
    (!telegramRun || directSenderIdentity !== undefined);
  if (trustedOwner) {
    return {
      ...input,
      senderIdentity: directSenderIdentity,
      sessionId: safeRuntimeSessionIdOrUndefined(input.sessionId),
    };
  }

  const untrustedMain = shouldUseUntrustedMainRuntimeNamespace({
    groupIsMain: input.isMain === true,
    credentialProxyTier: input.credentialProxyTier,
    chatJid: input.chatJid,
  });

  return {
    ...input,
    // A co-member of a multi-sender main chat must never resume the owner's
    // transcript.  Clear this in the serialized runner input as a second
    // boundary even though the orchestrator also suppresses it host-side.
    sessionId: untrustedMain
      ? undefined
      : safeRuntimeSessionIdOrUndefined(input.sessionId),
    isMain: false,
    credentialProxyTier: 'guest',
    senderIdentity: directSenderIdentity,
    taskAuthorizationCapability: undefined,
    codexGuiControlAuthorized: false,
    codexControlRunId: undefined,
    googleAllowedTools: undefined,
    googleSheetTargetHints: undefined,
    ...(restrictedWhatsAppObserverRuntime
      ? {
          memoryWriteCapability: undefined,
          memoryProvenancePublicKey: undefined,
        }
      : {}),
    ...(input.agentConfig
      ? {
          agentConfig: {
            ...input.agentConfig,
            // The runner independently expands these flags into unrestricted
            // tools/settings. Clear both in the serialized input as well as
            // enforcing the host sandbox below.
            fullAccess: false,
            noSandbox: false,
          },
        }
      : {}),
  };
}

/**
 * Prepare a received-media mount source without following an attacker-created
 * symlink. This is intentionally synchronous: it runs immediately before the
 * per-run mount/policy is built, while no process from this run exists yet.
 *
 * Node does not expose portable openat(2)/dirfd bind-mount APIs, so the durable
 * boundary is the nested read-only mount/deny-write policy installed for every
 * guest run below. Once installed, the guest cannot rename the mount point,
 * replace it with a symlink, or create/link files beneath it while the host
 * WhatsApp downloader publishes media.
 */
export function ensureSafeRuntimeReceivedDirectory(groupDir: string): string {
  fs.mkdirSync(groupDir, { recursive: true, mode: 0o700 });
  const groupStat = fs.lstatSync(groupDir);
  if (!groupStat.isDirectory() || groupStat.isSymbolicLink()) {
    throw new Error('Unsafe runtime group directory');
  }
  const groupReal = fs.realpathSync(groupDir);

  const receivedDir = path.join(groupDir, 'received');
  try {
    fs.mkdirSync(receivedDir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const receivedStat = fs.lstatSync(receivedDir);
  const receivedReal = fs.realpathSync(receivedDir);
  if (
    !receivedStat.isDirectory() ||
    receivedStat.isSymbolicLink() ||
    path.dirname(receivedReal) !== groupReal ||
    path.basename(receivedReal) !== 'received'
  ) {
    throw new Error('Unsafe runtime received directory');
  }
  return receivedDir;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Reclaim a fixed guest-runtime directory without ever following a planted
 * symlink.  The parent is host-selected; a hostile final entry is unlinked and
 * recreated as a real direct-child directory.  GroupQueue serializes runs for
 * one group, so no live guest can race this synchronous preparation.
 */
export function ensureSafeGuestRuntimeDirectory(directory: string): string {
  const candidate = path.resolve(directory);
  const parent = path.dirname(candidate);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Unsafe guest runtime parent: ${parent}`);
  }
  const parentReal = fs.realpathSync(parent);

  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(candidate);
  const real = fs.realpathSync(candidate);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    path.dirname(real) !== parentReal
  ) {
    throw new Error(`Unsafe guest runtime directory: ${candidate}`);
  }
  return real;
}

const RUNTIME_CLAUDE_SETTINGS = `${JSON.stringify(
  {
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    },
  },
  null,
  2,
)}\n`;

export function prepareRuntimeClaudeHome(
  homeDir: string,
  trustedOwner: boolean,
): { homeDir: string; claudeHome: string } {
  // Check owner runs too: a stale symlink planted by a co-member before
  // per-run authorization existed must not become trusted on the next owner
  // turn.
  const safeHome = ensureSafeGuestRuntimeDirectory(homeDir);
  const requestedClaudeHome = path.join(safeHome, '.claude');
  const claudeHome = ensureSafeGuestRuntimeDirectory(requestedClaudeHome);
  const settingsFile = path.join(claudeHome, 'settings.json');
  let safeExistingOwnerSettings = false;
  if (trustedOwner) {
    try {
      const stat = fs.lstatSync(settingsFile);
      safeExistingOwnerSettings =
        stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
    } catch {
      safeExistingOwnerSettings = false;
    }
  }
  if (!safeExistingOwnerSettings) {
    // Always replace guest-controlled settings atomically.  This both rejects
    // final symlink/hardlink tricks and prevents a guest from persisting hooks
    // or environment changes into the next run. Legitimate regular owner
    // settings remain untouched.
    writeFileAtomicNoFollowSync(settingsFile, RUNTIME_CLAUDE_SETTINGS);
  }

  const skillsDst = path.join(claudeHome, 'skills');
  // rmSync unlinks a symlink itself; it does not traverse its target. Guests
  // get a clean built-in skill tree every run. For owners, reclaim only an
  // unsafe root and preserve unrelated custom per-group skill directories.
  if (!trustedOwner) {
    fs.rmSync(skillsDst, { recursive: true, force: true });
  }
  ensureSafeGuestRuntimeDirectory(skillsDst);
  const skillsSrc = path.join(process.cwd(), 'agent', 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      // Refresh each trusted built-in child independently. A stale child
      // symlink is unlinked, while owner-only sibling skills survive.
      fs.rmSync(dstDir, { recursive: true, force: true });
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  return { homeDir: safeHome, claudeHome };
}

export function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  senderIdentity?: SenderIdentity,
  credentialProxyTier: 'owner' | 'guest' = 'guest',
  chatJid?: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  const trustedOwner = isMain && credentialProxyTier === 'owner';
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
  const fullAccess =
    trustedOwner &&
    (group.agentConfig?.fullAccess === true ||
      group.agentConfig?.noSandbox === true);
  const receivedDir = ensureSafeRuntimeReceivedDirectory(groupDir);

  if (trustedOwner) {
    // Main normally gets the project root read-only. Dedicated-host full access
    // intentionally makes it writable and keeps .env visible.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: !fullAccess,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root
    // unless fullAccess is explicitly enabled.
    // Credentials are injected by the credential proxy, never exposed to containers.
    // Apple Container only supports directory mounts, so the .env shadow is handled
    // inside the container entrypoint via mount --bind. Skip the host-side mount.
    if (!fullAccess && (CONTAINER_RUNTIME_BIN as string) === 'docker') {
      const envFile = path.join(projectRoot, '.env');
      if (fs.existsSync(envFile)) {
        mounts.push({
          hostPath: '/dev/null',
          containerPath: '/workspace/project/.env',
          readonly: true,
        });
      }
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else if (untrustedPaths) {
    // A guest message addressed to the main group gets a separate writable
    // namespace.  Do not mount the canonical owner workspace at all: even a
    // read-only view would disclose owner-only working files/instructions.
    // Only host-published inbound media is shared, through the exact nested
    // read-only mount below.
    const isolatedWorkspace = ensureSafeGuestRuntimeDirectory(
      untrustedPaths.workspace,
    );
    ensureSafeGuestRuntimeDirectory(untrustedPaths.home);
    ensureSafeGuestRuntimeDirectory(untrustedPaths.tmp);
    // A previous guest can leave `workspace/received` as a symlink.  Apple
    // Container/Docker would otherwise follow or reject that nested bind
    // target.  Reclaim a real target before installing the canonical RO bind.
    ensureSafeGuestRuntimeDirectory(path.join(isolatedWorkspace, 'received'));
    mounts.push({
      hostPath: isolatedWorkspace,
      containerPath: '/workspace/group',
      readonly: false,
    });
    mounts.push({
      hostPath: receivedDir,
      containerPath: '/workspace/group/received',
      readonly: true,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // The channel host, not the model runtime, owns inbound media publication.
    // Mount the stable direct-child directory after its writable parent so the
    // nested read-only bind wins. Besides blocking file writes, a bind mount is
    // a kernel-held mount point: rename/rmdir/symlink replacement from the
    // guest fails instead of racing the host's path-based final link().
    mounts.push({
      hostPath: receivedDir,
      containerPath: '/workspace/group/received',
      readonly: true,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  if (!trustedOwner && identityId) {
    const identityKey = safeSharedMemoryKey(identityId);
    if (identityKey !== 'unknown') {
      const sharedUserMemoryDir = path.join(
        DATA_DIR,
        'user-memory',
        identityKey,
      );
      fs.mkdirSync(path.join(sharedUserMemoryDir, 'shared'), {
        recursive: true,
      });
      mounts.push({
        hostPath: sharedUserMemoryDir,
        containerPath: '/workspace/user-memory',
        readonly: false,
      });
    }
  }

  // SECURITY: data/skills is a SHARED host directory whose ACTIVE skills are
  // injected into EVERY group's model prompt — including the fully-trusted
  // main/admin agent (GUI access, HELPER_SECRET, payment certs). If a guest
  // (which has Bash) could write `data/skills/<n>/SKILL.md` with `status:
  // active` it would inject attacker text into the trusted agent's prompt,
  // bypassing the propose/approval workflow entirely. Guests therefore get the
  // shared skills READ-ONLY (they can still read & use operator-curated skills);
  // only MAIN keeps write access to curate them. Guest skill proposals are
  // routed to the host over IPC (`propose_skill`) → `.proposals` for operator
  // approval. Mirrors sandbox-runner.ts; authorization is per-run, so a
  // co-member message in the main group remains read-only here too.
  const skillsDir = path.join(DATA_DIR, 'skills');
  fs.mkdirSync(path.join(skillsDir, '.proposals'), { recursive: true });
  mounts.push({
    hostPath: skillsDir,
    containerPath: '/workspace/skills',
    readonly: !trustedOwner,
  });

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const requestedHomeDir =
    untrustedPaths?.home ?? path.join(DATA_DIR, 'sessions', group.folder);
  const preparedHome = prepareRuntimeClaudeHome(requestedHomeDir, trustedOwner);
  const groupSessionsDir = preparedHome.claudeHome;
  mounts.push(
    untrustedPaths
      ? {
          hostPath: preparedHome.homeDir,
          containerPath: CONTAINER_GUEST_HOME,
          readonly: false,
        }
      : {
          hostPath: groupSessionsDir,
          containerPath: CONTAINER_GUEST_CLAUDE_HOME,
          readonly: false,
        },
  );

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const ipcLayout = ensureIpcDirectoryLayout(resolveGroupIpcPath(group.folder));
  if (trustedOwner) {
    // Trusted main keeps the legacy whole-root RW view for owner extensions.
    mounts.push({
      hostPath: ipcLayout.root,
      containerPath: '/workspace/ipc',
      readonly: false,
    });
  } else {
    // Guest can create envelopes inside fixed categories, but cannot replace
    // the categories themselves (which would redirect host reads/unlinks).
    // Parent must be mounted first; nested RW binds override its RO view.
    mounts.push({
      hostPath: ipcLayout.root,
      containerPath: '/workspace/ipc',
      readonly: true,
    });
    for (const category of IPC_CATEGORY_DIRECTORY_NAMES) {
      if (category === 'google') continue;
      mounts.push({
        hostPath: ipcLayout.categories[category],
        containerPath: `/workspace/ipc/${category}`,
        readonly: false,
      });
    }
    // Google requests can contain owner document content and their responses
    // are per-run encrypted. Hide the real shared category as well: the RO
    // parent mount would otherwise still let a concurrent guest read request
    // plaintext. A nested empty RO bind masks it completely.
    const deniedGoogleIpc = ensureSafeGuestRuntimeDirectory(
      path.join(DATA_DIR, 'runtime-denied-google-ipc'),
    );
    mounts.push({
      hostPath: deniedGoogleIpc,
      containerPath: '/workspace/ipc/google',
      readonly: true,
    });
  }

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(projectRoot, 'agent', 'runner', 'src');
  const groupAgentRunnerDir =
    untrustedPaths?.runnerSrc ??
    path.join(DATA_DIR, 'sessions', group.folder, 'agent-runner-src');
  if (untrustedPaths) {
    // This tree is compiled and executed at container startup.  Never trust a
    // copy left writable by an earlier guest: rebuild it from trusted source on
    // every downgraded-main run, eliminating persistent runner poisoning.
    fs.rmSync(groupAgentRunnerDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(groupAgentRunnerDir), { recursive: true });
    if (fs.existsSync(agentRunnerSrc)) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    } else {
      fs.mkdirSync(groupAgentRunnerDir, { recursive: true });
    }
  } else if (
    !fs.existsSync(groupAgentRunnerDir) &&
    fs.existsSync(agentRunnerSrc)
  ) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (!untrustedPaths && group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      trustedOwner,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  isMain: boolean,
  proxyIdentityToken: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a per-process shared-secret placeholder.
  // The proxy only injects the real credential when the incoming caller
  // credential matches this secret (timing-safe), so an unauthenticated caller
  // that reaches the proxy never gets the real key/token.
  // API key mode: SDK sends x-api-key=<secret>, proxy verifies then replaces
  //               with the real key.
  // OAuth mode:   SDK exchanges placeholder Bearer <secret> for a temp API key;
  //               proxy verifies the Bearer token then injects the real OAuth
  //               token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', `ANTHROPIC_API_KEY=${CREDENTIAL_PROXY_CLIENT_SECRET}`);
  } else {
    args.push(
      '-e',
      `CLAUDE_CODE_OAUTH_TOKEN=${CREDENTIAL_PROXY_CLIENT_SECRET}`,
    );
  }

  // Bind every request (including OAuth traffic after the token exchange) to
  // owner/main or this exact guest tenant. The signing key remains on the host;
  // the container receives only its own unforgeable capability. Claude's SDK
  // applies ANTHROPIC_CUSTOM_HEADERS to every request.
  const internalProxyHeader = `${CREDENTIAL_PROXY_IDENTITY_HEADER}: ${proxyIdentityToken}`;

  // Pass plugin-registered env vars to container. Preserve legitimate custom
  // Anthropic headers, but append the internal identity header last so a plugin
  // cannot replace the quota identity with a forged owner value.
  const pluginEnvKeys = getExtensionContainerEnvKeys();
  const pluginEnv =
    pluginEnvKeys.length > 0
      ? readEnvFile(pluginEnvKeys)
      : ({} as Record<string, string>);
  const pluginCustomHeaders = pluginEnv.ANTHROPIC_CUSTOM_HEADERS?.split(/\r?\n/)
    .filter(
      (line) =>
        line.split(':', 1)[0].trim().toLowerCase() !==
        CREDENTIAL_PROXY_IDENTITY_HEADER,
    )
    .join('\n')
    .trim();
  args.push(
    '-e',
    `ANTHROPIC_CUSTOM_HEADERS=${pluginCustomHeaders ? `${pluginCustomHeaders}\n` : ''}${internalProxyHeader}`,
  );
  if (pluginEnvKeys.length > 0) {
    for (const key of pluginEnvKeys) {
      if (key === 'ANTHROPIC_CUSTOM_HEADERS') continue;
      if (pluginEnv[key]) {
        args.push('-e', `${key}=${pluginEnv[key]}`);
      }
    }
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    if (isMain) {
      // Main containers start as root so the entrypoint can mount --bind
      // to shadow .env. Privileges are dropped via setpriv in entrypoint.sh.
      args.push('-e', `RUN_UID=${hostUid}`);
      args.push('-e', `RUN_GID=${hostGid}`);
    } else {
      args.push('--user', `${hostUid}:${hostGid}`);
    }
    args.push('-e', `HOME=${CONTAINER_GUEST_HOME}`);
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const rawIsMain = input.isMain === true;
  const trustedOwner = rawIsMain && input.credentialProxyTier === 'owner';
  const untrustedMain = shouldUseUntrustedMainRuntimeNamespace({
    groupIsMain: rawIsMain,
    credentialProxyTier: input.credentialProxyTier,
    chatJid: input.chatJid,
  });
  input = restrictRuntimeInputToAuthorizedTier(input);

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(
    group,
    rawIsMain,
    input.senderIdentity,
    input.credentialProxyTier,
    input.chatJid,
  );
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `claudeclaw-${safeName}-${Date.now()}`;
  // Runtime diagnostics always live in a host-reclaimed 0700 tree. The shared
  // group workspace is guest writable, even when the next run is owner/main,
  // so it can never be a trusted log destination.
  const logsDir = ensureSafeGuestRuntimeDirectory(
    path.join(DATA_DIR, 'runtime-logs', group.folder),
  );

  const proxyIdentityToken = createCredentialProxyIdentityToken(
    CREDENTIAL_PROXY_IDENTITY_SIGNING_SECRET,
    {
      tier: input.credentialProxyTier === 'owner' ? 'owner' : 'guest',
      tenantId: input.tenantId || group.folder,
    },
  );
  let containerArgs: string[];
  try {
    containerArgs = buildContainerArgs(
      mounts,
      containerName,
      input.isMain,
      proxyIdentityToken,
    );
  } catch (err) {
    revokeCredentialProxyIdentityToken(proxyIdentityToken);
    throw err;
  }
  const diagnosticSecrets = [
    CREDENTIAL_PROXY_CLIENT_SECRET,
    proxyIdentityToken,
    input.taskAuthorizationCapability || '',
    input.memoryWriteCapability || '',
    input.codexControlRunId || '',
    ...containerCredentialEnvironmentValues(containerArgs),
  ];

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgumentCount: containerArgs.length,
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  let proxyIdentityRevoked = false;
  const revokeProxyIdentity = (): void => {
    if (proxyIdentityRevoked) return;
    proxyIdentityRevoked = true;
    revokeCredentialProxyIdentityToken(proxyIdentityToken);
  };

  return new Promise<ContainerOutput>((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    const frameParser = new BoundedOutputFrameParser(
      OUTPUT_START_MARKER,
      OUTPUT_END_MARKER,
      CONTAINER_MAX_OUTPUT_SIZE,
    );
    let streamFrameError: string | undefined;
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    const stderrDiagnostics = createRedactedDiagnosticLineBuffer(
      diagnosticSecrets,
      (line) => logger.debug({ container: group.folder }, line),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let inputFailure = false;
    let terminalEventHandled = false;

    const failContainerInput = (phase: string, err: unknown): void => {
      if (inputFailure || terminalEventHandled) return;
      inputFailure = true;
      revokeProxyIdentity();
      if (timeout) clearTimeout(timeout);
      const safeError = redactContainerRuntimeDiagnostics(
        err instanceof Error ? err.message : String(err),
        diagnosticSecrets,
      );
      logger.error(
        { group: group.name, containerName, phase, error: safeError },
        'Container startup/input failure; removing spawned container',
      );
      try {
        container.kill('SIGKILL');
      } catch {
        // The local runtime client may already have exited. Removal by the
        // daemon-managed container name remains authoritative below.
      }
      forceRemoveContainer(group.name, containerName);
      resolve({
        status: 'error',
        result: null,
        error: `Container ${phase} failure: ${safeError}`,
      });
    };

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
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
            'Rejected oversized container output frame',
          );
        }
        for (const jsonStr of parsedFrames.frames) {
          try {
            const parsed = redactContainerOutput(
              JSON.parse(jsonStr) as ContainerOutput,
              diagnosticSecrets,
            );
            if (parsed.status === 'heartbeat') {
              // Liveness-only frame: reset the inactivity timeout but do NOT
              // mark real output. Forwarded to onOutput so the orchestrator
              // can refresh its stale-active tracking.
              resetTimeout();
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
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            // Swallow rejections: every terminal resolve() below is gated on
            // `outputChain.then(...)`, so a single rejected onOutput (e.g. a
            // SQLITE_BUSY/disk-full session write) would otherwise poison the
            // chain and leave the run Promise unresolved, wedging the group.
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
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrDiagnostics.push(chunk);
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (!err) return;
        // `container stop` failed/timed out. SIGKILLing the spawned `container
        // run` client (which is NOT detached) does not reliably tear down the
        // workload: with Apple Container the actual process runs in a
        // daemon-managed VM keyed by NAME, so the attached client dying leaves
        // the VM running. Escalate by NAME against the runtime (kill, then
        // rm -f), and verify the container is gone before giving up — mirroring
        // the process-group escalation the sandbox runner was hardened with.
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, escalating to kill/rm by name',
        );
        // Also kill the local client so its stdio pipes close (lets 'close' fire).
        container.kill('SIGKILL');
        forceRemoveContainer(group.name, containerName);
      });
    };

    timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      if (inputFailure || terminalEventHandled) return;
      terminalEventHandled = true;
      // Revoke on the process lifecycle event itself. Output persistence may
      // remain pending afterward and must not extend the dead run's authority.
      revokeProxyIdentity();
      if (timeout) clearTimeout(timeout);
      try {
        stderrDiagnostics.flush();
      } catch {
        // Diagnostics must never delay lifecycle cleanup or completion.
      }
      const duration = Date.now() - startTime;

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
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
      const safeStdout = redactContainerRuntimeDiagnostics(
        stdout,
        diagnosticSecrets,
      );
      const safeStderr = redactContainerRuntimeDiagnostics(
        stderr,
        diagnosticSecrets,
      );

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          `Task capability present: ${Boolean(input.taskAuthorizationCapability)}`,
          `Memory capability present: ${Boolean(input.memoryWriteCapability)}`,
          ``,
          `=== Container Args Summary ===`,
          `Argument count: ${containerArgs.length}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          safeStderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          safeStdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'), { mode: 0o600 });
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr: safeStderr,
            stdout: safeStdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${safeStderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output = redactContainerOutput(
          JSON.parse(jsonLine) as ContainerOutput,
          diagnosticSecrets,
        );

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch {
        const safeParseError = 'Invalid JSON output frame';
        logger.error(
          {
            group: group.name,
            stdout: safeStdout,
            stderr: safeStderr,
            error: safeParseError,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${safeParseError}`,
        });
      }
    });

    container.on('error', (err) => {
      if (inputFailure || terminalEventHandled) return;
      terminalEventHandled = true;
      revokeProxyIdentity();
      if (timeout) clearTimeout(timeout);
      try {
        stderrDiagnostics.flush();
      } catch {
        // Diagnostics must never delay lifecycle cleanup or completion.
      }
      const safeError = redactContainerRuntimeDiagnostics(
        err.message,
        diagnosticSecrets,
      );
      logger.error(
        { group: group.name, containerName, error: safeError },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${safeError}`,
      });
    });

    container.stdin.on('error', (err) => {
      failContainerInput('stdin', err);
    });
    try {
      onProcess(container, containerName);
    } catch (err) {
      failContainerInput('onProcess callback', err);
      return;
    }
    try {
      container.stdin.write(JSON.stringify(input));
      container.stdin.end();
    } catch (err) {
      failContainerInput('stdin', err);
    }
  }).finally(() => {
    // A process-wide proxy has a long-lived signing key and placeholder. End
    // this exact run's authority on every completion, timeout, spawn failure,
    // callback throw, or other Promise rejection.
    revokeProxyIdentity();
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const ipcLayout = ensureIpcDirectoryLayout(resolveGroupIpcPath(groupFolder));

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(ipcLayout.root, 'current_tasks.json');
  writeFileAtomicNoFollowSync(
    tasksFile,
    JSON.stringify(filteredTasks, null, 2),
  );
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const ipcLayout = ensureIpcDirectoryLayout(resolveGroupIpcPath(groupFolder));

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(ipcLayout.root, 'available_groups.json');
  writeFileAtomicNoFollowSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
