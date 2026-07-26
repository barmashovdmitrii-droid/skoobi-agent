import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from '../runtimes/container-runner.js';
import {
  createTask,
  deleteTask,
  getCalendarEventLink,
  getFinishedTasks,
  getTaskById,
  markCalendarEventLinkDeleted,
  storeBotReply,
  updateTask,
  upsertCalendarEventLink,
} from './db.js';
import {
  CalendarAdapter,
  createGoogleCalendarAdapterFromEnv,
  shouldCreateCalendarEventForTask,
} from './calendar-adapter.js';
import { isValidGroupFolder } from './group-folder.js';
import {
  resolveExistingSafeIpcCategoryDirectory,
  type IpcCategoryDirectoryName,
  writeFileAtomicNoFollowSync,
} from './ipc-paths.js';
import { logger } from './logger.js';
import { signMemoryWriteRequest } from './memory-provenance.js';
import { notifyRunIpcActivity } from './run-activity.js';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';
import {
  isMultiSenderRuntimeChat,
  untrustedMainRuntimePaths,
} from './runtime-namespace.js';
import { isSafeSkillName, proposeSkill } from './skill-registry.js';
import {
  authorizeTaskOperationRequest,
  consumeTaskOperationGrant,
} from './task-authorization.js';
import { MessageRouter, RegisteredGroup, ScheduledTask } from './types.js';

export interface IpcDeps {
  router: MessageRouter;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  calendarAdapter?: CalendarAdapter | null;
}

let ipcWatcherRunning = false;

// Cross-tenant starvation guard: processIpcFiles() is a SINGLE shared loop that
// scans every group's IPC dirs sequentially and awaits a network send per send
// envelope. A guest's IPC dirs are mounted RW and it has Bash, so it can write
// tens of thousands of envelopes and force the watcher to service them all
// (blocking every other tenant's IPC, incl. main/admin control messages, and
// flooding its own chat) before the next poll is even scheduled. Cap how many
// files per category we drain from any one group per tick so the loop always
// makes timely progress across ALL groups; the remainder is picked up on the
// next poll (oldest-first), bounding per-tenant influence on the global cadence.
const MAX_IPC_FILES_PER_GROUP_PER_TICK = 50;
let defaultCalendarAdapter: CalendarAdapter | null | undefined;

function ownDataProperty(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || !value) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Google/Gaxios errors carry the complete request config, including the live
 * Authorization header. Only retain a numeric HTTP status; never give the raw
 * error object, message, response, config, or headers to the logger.
 */
function safeGoogleCalendarErrorSummary(error: unknown): {
  provider: 'google_calendar';
  errorType: 'provider_request_failed';
  httpStatus?: number;
} {
  const directStatus = ownDataProperty(error, 'status');
  const response = ownDataProperty(error, 'response');
  const responseStatus = ownDataProperty(response, 'status');
  const candidate =
    typeof directStatus === 'number' ? directStatus : responseStatus;
  const httpStatus =
    typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 100 &&
    candidate <= 599
      ? candidate
      : undefined;
  return {
    provider: 'google_calendar',
    errorType: 'provider_request_failed',
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function realpathOrNull(candidate: string): string | null {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

// IPC envelopes are small control-plane JSON (a message/task/swe descriptor). A
// guest's IPC dirs (messages/tasks/swe) are mounted RW and it has Bash, so it can
// drop an arbitrarily large *.json; reading it whole (readFileSync + JSON.parse)
// inside the single shared processIpcFiles loop would spike host memory and can
// OOM-kill the orchestrator for ALL tenants (incl. main/admin). Cap the envelope
// size BEFORE reading — mirroring MAX_GUEST_SEND_BYTES on the referenced-send path
// — and throw so each caller's existing catch quarantines the over-cap file into
// ipc/errors (same handling as a malformed envelope), so it is not re-read next tick.
export const MAX_IPC_ENVELOPE_BYTES = 8 * 1024 * 1024;

// Returns the parsed envelope (typed `any`, exactly like the raw JSON.parse it
// replaces). Throws on an over-cap or unreadable file so the caller quarantines it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readIpcEnvelopeJson(filePath: string): any {
  const { buffer } = readBoundedRegularFileNoFollowSync(filePath, {
    maxBytes: MAX_IPC_ENVELOPE_BYTES,
    oversize: 'reject',
    requireSingleLink: true,
  });
  return JSON.parse(buffer.toString('utf8'));
}

const warnedUnsafeIpcCategoryDirectories = new Set<string>();

function resolveWatcherIpcCategoryDirectory(
  groupIpcDir: string,
  category: IpcCategoryDirectoryName,
): string | null {
  const candidate = path.join(groupIpcDir, category);
  const safe = resolveExistingSafeIpcCategoryDirectory(groupIpcDir, category);
  if (safe) {
    warnedUnsafeIpcCategoryDirectories.delete(candidate);
    return safe;
  }
  try {
    fs.lstatSync(candidate);
    if (!warnedUnsafeIpcCategoryDirectories.has(candidate)) {
      warnedUnsafeIpcCategoryDirectories.add(candidate);
      logger.warn(
        { groupIpcDir, category },
        'Unsafe IPC category skipped (expected a real in-root directory)',
      );
    }
  } catch {
    // Missing categories are normal before first provisioning.
  }
  return null;
}

function calendarAdapterFromDeps(deps: IpcDeps): CalendarAdapter | null {
  if (deps.calendarAdapter !== undefined) return deps.calendarAdapter;
  if (defaultCalendarAdapter === undefined) {
    defaultCalendarAdapter = createGoogleCalendarAdapterFromEnv();
  }
  return defaultCalendarAdapter;
}

async function createCalendarEventForTask(input: {
  task: ScheduledTask;
  requested?: boolean;
  reminderMinutes?: number;
  deps: IpcDeps;
}): Promise<void> {
  if (!shouldCreateCalendarEventForTask(input.task, input.requested)) return;

  const adapter = calendarAdapterFromDeps(input.deps);
  if (!adapter) return;

  try {
    const event = await adapter.createReminderEvent({
      taskId: input.task.id,
      prompt: input.task.prompt,
      scheduleValue: input.task.schedule_value,
      reminderMinutes: input.reminderMinutes,
    });
    if (!event.id) {
      logger.warn(
        { taskId: input.task.id },
        'Google Calendar event was created without an event id',
      );
      return;
    }
    upsertCalendarEventLink({
      task_id: input.task.id,
      provider: 'google_calendar',
      calendar_id: adapter.config.calendarId,
      event_id: event.id,
      event_link: event.htmlLink,
      status: 'active',
    });
    logger.info(
      { taskId: input.task.id, eventId: event.id },
      'Google Calendar event linked to scheduled task',
    );
  } catch (err) {
    logger.warn(
      { taskId: input.task.id, ...safeGoogleCalendarErrorSummary(err) },
      'Failed to create Google Calendar event for scheduled task',
    );
  }
}

async function deleteCalendarEventForTask(
  taskId: string,
  deps: IpcDeps,
): Promise<void> {
  const link = getCalendarEventLink(taskId);
  if (!link || link.status !== 'active') return;

  const adapter = calendarAdapterFromDeps(deps);
  if (!adapter) {
    logger.warn(
      { taskId, eventId: link.event_id },
      'Google Calendar link exists, but adapter is not configured',
    );
    return;
  }

  try {
    await adapter.deleteEvent(link.event_id, link.calendar_id);
    markCalendarEventLinkDeleted(taskId);
    logger.info(
      { taskId, eventId: link.event_id },
      'Google Calendar event deleted for scheduled task',
    );
  } catch (err) {
    logger.warn(
      {
        taskId,
        eventId: link.event_id,
        ...safeGoogleCalendarErrorSummary(err),
      },
      'Failed to delete Google Calendar event for scheduled task',
    );
  }
}

const IPC_STAGING_DIR = path.join(DATA_DIR, 'ipc-staging');

// Hard cap on the size of a guest-staged send. The orchestrator is a single
// shared process, so without a cap a guest (RW workspace + Bash) could point an IPC
// send at a multi-GB file in its own workspace and OOM-crash the host for ALL
// tenants (or hit Node's ~2GB Buffer limit and throw inside the watcher tick).
// 50MB matches Telegram's document ceiling and comfortably covers legit
// photos/PDFs; larger guest sends are rejected before any bytes are read.
const MAX_GUEST_SEND_BYTES = 50 * 1024 * 1024;

/**
 * Cross-tenant TOCTOU defense for guest file sends. Re-open the validated path
 * with O_NOFOLLOW and verify the inode/device are unchanged (a swap to a symlink
 * fails the open; a swap to a different real file — incl. via a swapped parent
 * dir — fails the inode check), then copy the bytes into a host-only staging
 * file the guest cannot touch. Returns the staging path, or null if the file
 * changed / can't be read safely.
 */
function stageGuestFileForSend(
  realPath: string,
  expected: fs.Stats,
): string | null {
  // Opportunistically sweep stale staged files (bounds the host-only dir).
  try {
    if (fs.existsSync(IPC_STAGING_DIR)) {
      const now = Date.now();
      for (const f of fs.readdirSync(IPC_STAGING_DIR)) {
        const p = path.join(IPC_STAGING_DIR, f);
        try {
          if (now - fs.statSync(p).mtimeMs > 60_000) fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const fstat = fs.fstatSync(fd);
    if (
      !fstat.isFile() ||
      fstat.ino !== expected.ino ||
      fstat.dev !== expected.dev ||
      fstat.nlink !== 1 ||
      expected.nlink !== 1 ||
      // Re-check the size AFTER the O_NOFOLLOW open (defends a TOCTOU grow
      // between the pre-stat cap check and here): never buffer an oversized
      // file into a single Node Buffer and OOM the shared host.
      fstat.size > MAX_GUEST_SEND_BYTES
    ) {
      return null;
    }

    // Read exactly the size observed on this same descriptor. readFileSync(fd)
    // reads until EOF, so a guest appending concurrently after fstat could make
    // the host allocate/read far beyond the cap. A fixed buffer plus a one-byte
    // EOF probe makes growth bounded and fail-closed.
    const observedSize = fstat.size;
    const buf = Buffer.alloc(observedSize);
    let bytesRead = 0;
    while (bytesRead < observedSize) {
      const count = fs.readSync(
        fd,
        buf,
        bytesRead,
        observedSize - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    const probe = Buffer.allocUnsafe(1);
    const extra = fs.readSync(fd, probe, 0, 1, null);
    const finalStat = fs.fstatSync(fd);
    if (
      bytesRead !== observedSize ||
      extra !== 0 ||
      !finalStat.isFile() ||
      finalStat.ino !== fstat.ino ||
      finalStat.dev !== fstat.dev ||
      finalStat.size !== observedSize ||
      finalStat.nlink !== 1 ||
      finalStat.mtimeMs !== fstat.mtimeMs ||
      finalStat.ctimeMs !== fstat.ctimeMs
    ) {
      return null;
    }

    fs.mkdirSync(IPC_STAGING_DIR, { recursive: true, mode: 0o700 });
    const stagedPath = path.join(
      IPC_STAGING_DIR,
      `${Date.now()}-${randomUUID()}-${path.basename(realPath).slice(-120)}`,
    );
    writeFileAtomicNoFollowSync(stagedPath, buf);
    fs.chmodSync(stagedPath, 0o600);
    return stagedPath;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function isIpcSendAuthorized(
  sourceGroup: string,
  effectiveOwner: boolean,
  targetChatJid: string,
  registeredGroups: Record<string, RegisteredGroup>,
): boolean {
  const targetGroup = registeredGroups[targetChatJid];
  return (
    effectiveOwner || (!!targetGroup && targetGroup.folder === sourceGroup)
  );
}

/**
 * Consume owner authority for exactly this send envelope. Directory placement
 * (`isMain`) is deliberately absent: a co-member sandbox can write into the
 * same main IPC directory, so only a host-issued exact one-shot grant may
 * unlock cross-chat delivery or owner file paths.
 */
export function authorizeIpcSendEnvelope(
  data: Record<string, unknown>,
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
): { authorized: boolean; effectiveOwner: boolean } {
  const effectiveOwner = consumeTaskOperationGrant(data, sourceGroup) !== null;
  return {
    effectiveOwner,
    authorized: isIpcSendAuthorized(
      sourceGroup,
      effectiveOwner,
      typeof data.chatJid === 'string' ? data.chatJid : '',
      registeredGroups,
    ),
  };
}

export function validateIpcSendFilePath(input: {
  sourceGroup: string;
  isMain: boolean;
  /** Raw registration shape, distinct from the per-envelope owner grant. */
  sourceIsMultiSenderMain?: boolean;
  filePath: string;
  kind: 'photo' | 'document';
}):
  | { allowed: true; realPath: string; staged: boolean }
  | { allowed: false; reason: string } {
  if (typeof input.filePath !== 'string' || !input.filePath.trim()) {
    return { allowed: false, reason: 'missing_file_path' };
  }
  if (input.filePath.includes('\0')) {
    return { allowed: false, reason: 'invalid_file_path' };
  }

  let canonicalGroupRoot: string;
  let isolatedWorkspaceRoot: string | null = null;
  try {
    canonicalGroupRoot = path.resolve(GROUPS_DIR, input.sourceGroup);
    if (input.sourceIsMultiSenderMain && !input.isMain) {
      isolatedWorkspaceRoot = untrustedMainRuntimePaths(
        DATA_DIR,
        input.sourceGroup,
      ).workspace;
    }
  } catch {
    return { allowed: false, reason: 'invalid_source_group' };
  }

  // Container envelopes refer to their virtual /workspace/group path, while
  // the host validator must open the corresponding fixed host tree.  Map it
  // before realpath; never trust a guest-supplied host-root mapping.  received
  // is a nested bind from the canonical host-published media directory.
  const virtualWorkspaceRoot = path.resolve('/workspace/group');
  const normalizedInputPath = path.resolve(input.filePath);
  let candidatePath = input.filePath;
  if (isWithinPath(virtualWorkspaceRoot, normalizedInputPath)) {
    const relative = path.relative(virtualWorkspaceRoot, normalizedInputPath);
    const receivedRelative = path.relative('received', relative);
    if (
      relative === 'received' ||
      (receivedRelative &&
        !receivedRelative.startsWith('..') &&
        !path.isAbsolute(receivedRelative))
    ) {
      candidatePath = path.resolve(
        canonicalGroupRoot,
        'received',
        relative === 'received' ? '' : receivedRelative,
      );
    } else {
      candidatePath = path.resolve(
        isolatedWorkspaceRoot ?? canonicalGroupRoot,
        relative,
      );
    }
  }

  const realPath = realpathOrNull(candidatePath);
  if (!realPath) return { allowed: false, reason: 'file_not_found' };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch {
    return { allowed: false, reason: 'file_not_readable' };
  }
  if (!stat.isFile()) return { allowed: false, reason: 'not_a_file' };

  if (!input.isMain) {
    const allowedRoots = isolatedWorkspaceRoot
      ? [
          realpathOrNull(isolatedWorkspaceRoot),
          realpathOrNull(path.join(canonicalGroupRoot, 'received')),
        ]
      : [realpathOrNull(canonicalGroupRoot)];
    if (
      !allowedRoots.some((root): root is string =>
        Boolean(root && isWithinPath(root, realPath)),
      )
    ) {
      return { allowed: false, reason: 'guest_file_outside_workspace' };
    }

    // DoS guard: a guest's workspace is RW and it has Bash, so it can create an
    // arbitrarily large (or sparse) file and point an IPC send at it. The
    // guest-only staging copy below buffers the WHOLE file into one Node Buffer
    // (readFileSync), which would exhaust host memory / throw RangeError inside
    // the shared watcher tick. Reject oversized guest sends up front; the
    // staging open re-checks fstat.size to close the grow-after-stat TOCTOU.
    if (stat.size > MAX_GUEST_SEND_BYTES) {
      return { allowed: false, reason: 'guest_file_too_large' };
    }

    // Defense-in-depth (intra-tenant): the cross-tenant boundary is already
    // enforced above via isWithinPath(realpath(...)). Even within its OWN
    // workspace, a guest must not be able to exfiltrate secret-bearing files
    // (credentials, private keys, certs, databases) by sending them as a
    // photo/document to its own chat. Legitimate sends are images/PDFs/generated
    // docs, which never use these names or extensions.
    const parts = realPath.split(path.sep);
    const base = path.basename(realPath);
    // Credential-bearing config dirs. Kept consistent with mount-security.ts's
    // DEFAULT_BLOCKED_PATTERNS (.aws/.azure/.gcloud/.kube/.docker/.gnupg, .config
    // for XDG creds like .config/gh/hosts.yml or .config/gcloud) so the IPC send
    // surface and the mount surface treat the same paths as sensitive.
    const inSensitiveDir =
      parts.includes('.ssh') ||
      parts.includes('store') ||
      parts.includes('secrets') ||
      parts.includes('.aws') ||
      parts.includes('.azure') ||
      parts.includes('.gcloud') ||
      parts.includes('.kube') ||
      parts.includes('.docker') ||
      parts.includes('.gnupg') ||
      parts.includes('.config');
    const isSensitiveName =
      // dotenv and all variants: .env, .env.local, .env.production, .env.bak ...
      /^\.env(\..+)?$/i.test(base) ||
      // SQLite databases + WAL/SHM/journal sidecars: messages.db, mem0-*.db, *.sqlite
      /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i.test(base) ||
      // SSH/host private key files
      /^id_(rsa|dsa|ecdsa|ed25519)$/i.test(base) ||
      // package/registry auth tokens, FTP/HTTP creds, and PyPI upload creds
      /^\.(npmrc|netrc|pypirc)$/i.test(base) ||
      // GCP/service-account & generic credential dumps; kubeconfig clusters/tokens
      /^credentials(\.json|\.ya?ml)?$/i.test(base) ||
      /(^|\.)kubeconfig$/i.test(base) ||
      // private key files named by convention
      /^private_key/i.test(base) ||
      // key material, certificate bundles, and keystores
      /\.(pem|key|p12|pfx|keystore|jks|crt|cer|der|asc|gpg)$/i.test(base);
    if (inSensitiveDir || isSensitiveName) {
      return { allowed: false, reason: 'guest_sensitive_file_denied' };
    }

    // Cross-tenant TOCTOU: a guest's workspace is RW and it has Bash, so it can
    // swap realPath for a symlink AFTER this validation but BEFORE the deferred
    // createReadStream() in sendPhoto/sendDocument re-opens it (PoC: streamed
    // another tenant's secret.env). Capture the validated bytes NOW into a
    // host-only staging file and hand THAT path to the channel.
    const staged = stageGuestFileForSend(realPath, stat);
    if (!staged) {
      return { allowed: false, reason: 'file_changed_or_unreadable' };
    }
    return { allowed: true, realPath: staged, staged: true };
  }

  return { allowed: true, realPath, staged: false };
}

/**
 * Validate the shape of an IPC "send" envelope before it is authorized or
 * routed. A sandboxed guest has its IPC directory mounted read-write and full
 * Bash access, so it can write arbitrary JSON directly into the messages dir,
 * bypassing the agent-side MCP server. Every field must therefore be treated as
 * hostile: assert types up front rather than relying on a downstream
 * .replace()/.trim()/.startsWith() to throw on a malformed value.
 *
 * Only the routed "send" envelope types are validated here; task/control
 * envelopes are validated by processTaskIpc.
 */
export function validateIpcSendEnvelope(data: {
  type?: unknown;
  chatJid?: unknown;
  text?: unknown;
  filePath?: unknown;
  caption?: unknown;
}): { ok: true } | { ok: false; reason: string } {
  const MAX_MESSAGE_TEXT_CHARS = 64 * 1024;
  const MAX_VOICE_TEXT_CHARS = 12_000;
  const MAX_CAPTION_CHARS = 1024;
  const MAX_CHAT_JID_CHARS = 256;
  const MAX_FILE_PATH_CHARS = 4096;

  if (
    typeof data.chatJid !== 'string' ||
    data.chatJid.trim() === '' ||
    data.chatJid.length > MAX_CHAT_JID_CHARS
  ) {
    return { ok: false, reason: 'invalid_chat_jid' };
  }
  switch (data.type) {
    case 'message':
      if (typeof data.text !== 'string') {
        return { ok: false, reason: 'invalid_text' };
      }
      if (data.text.length > MAX_MESSAGE_TEXT_CHARS) {
        return { ok: false, reason: 'message_text_too_long' };
      }
      return { ok: true };
    case 'voice':
      if (typeof data.text !== 'string') {
        return { ok: false, reason: 'invalid_text' };
      }
      if (data.text.length > MAX_VOICE_TEXT_CHARS) {
        return { ok: false, reason: 'voice_text_too_long' };
      }
      return { ok: true };
    case 'photo':
    case 'document':
      if (
        typeof data.filePath !== 'string' ||
        data.filePath.length === 0 ||
        data.filePath.length > MAX_FILE_PATH_CHARS
      ) {
        return { ok: false, reason: 'invalid_file_path' };
      }
      if (data.caption !== undefined && typeof data.caption !== 'string') {
        return { ok: false, reason: 'invalid_caption' };
      }
      if (
        typeof data.caption === 'string' &&
        data.caption.length > MAX_CAPTION_CHARS
      ) {
        return { ok: false, reason: 'caption_too_long' };
      }
      return { ok: true };
    default:
      return { ok: true };
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs
        .readdirSync(ipcBaseDir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.name !== 'errors' &&
            isValidGroupFolder(entry.name) &&
            entry.isDirectory(),
        )
        .map((entry) => entry.name);
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    const folderIsMultiSenderMain = new Map<string, boolean>();
    for (const [jid, group] of Object.entries(registeredGroups)) {
      if (group.isMain) {
        folderIsMain.set(group.folder, true);
        if (isMultiSenderRuntimeChat(jid)) {
          folderIsMultiSenderMain.set(group.folder, true);
        }
      }
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const groupIpcDir = path.join(ipcBaseDir, sourceGroup);
      const messagesDir = resolveWatcherIpcCategoryDirectory(
        groupIpcDir,
        'messages',
      );
      const tasksDir = resolveWatcherIpcCategoryDirectory(groupIpcDir, 'tasks');
      const sweDir = resolveWatcherIpcCategoryDirectory(groupIpcDir, 'swe');
      const memoryDir = resolveWatcherIpcCategoryDirectory(
        groupIpcDir,
        'memory',
      );

      // Guest memory_save never writes trusted provenance itself. It asks the
      // host to sign an entry through a run-scoped capability that is already
      // bound to the authoritative sender/tenant. The signed result is returned
      // to the MCP process, which appends it inside its own writable workspace.
      // Direct guest JSON/markdown writes cannot change that host binding.
      try {
        if (memoryDir) {
          const memoryFiles = fs
            .readdirSync(memoryDir)
            .filter((f) => f.endsWith('.request.json'))
            .sort()
            .slice(0, MAX_IPC_FILES_PER_GROUP_PER_TICK);
          for (const file of memoryFiles) {
            const filePath = path.join(memoryDir, file);
            try {
              const data = readIpcEnvelopeJson(filePath);
              const response =
                data?.type === 'task_authorize'
                  ? authorizeTaskOperationRequest(data, sourceGroup)
                  : signMemoryWriteRequest(data, sourceGroup);
              const resultName = `${response.request_id}.result.json`;
              writeFileAtomicNoFollowSync(
                path.join(memoryDir, resultName),
                JSON.stringify(response),
              );
              fs.unlinkSync(filePath);
              if (response.ok) {
                notifyRunIpcActivity(sourceGroup, 'memory');
              } else {
                logger.warn(
                  { sourceGroup, reason: response.error },
                  'Memory provenance signing request rejected',
                );
              }
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC memory provenance request',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC memory directory',
        );
      }

      // Process messages from this group's IPC directory
      try {
        if (messagesDir) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'))
            // Oldest-first (envelope names are timestamp-prefixed), then bound
            // the per-group drain so one flooding tenant cannot starve others.
            .sort()
            .slice(0, MAX_IPC_FILES_PER_GROUP_PER_TICK);
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = readIpcEnvelopeJson(filePath);
              // Reject malformed "send" envelopes (wrong field types from a
              // hostile guest) before authorization/routing, so a non-string
              // value can't reach a downstream .replace()/.trim() and throw.
              const isSendEnvelope =
                data.type === 'message' ||
                data.type === 'voice' ||
                data.type === 'photo' ||
                data.type === 'document';
              let sendAuthorization = {
                authorized: false,
                effectiveOwner: false,
              };
              if (isSendEnvelope) {
                const envelope = validateIpcSendEnvelope(data);
                if (!envelope.ok) {
                  logger.warn(
                    { sourceGroup, type: data.type, reason: envelope.reason },
                    'Malformed IPC send envelope rejected',
                  );
                  fs.unlinkSync(filePath);
                  continue;
                }
                sendAuthorization = authorizeIpcSendEnvelope(
                  data as Record<string, unknown>,
                  sourceGroup,
                  registeredGroups,
                );
              }
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                if (sendAuthorization.authorized) {
                  const delivered = await deps.router.route({
                    chatJid: data.chatJid,
                    text: data.text,
                    triggerType: 'ipc',
                    groupFolder: sourceGroup,
                  });
                  // Confirmed delivery = useful progress of this group's
                  // active sandbox run that never crosses the child's stdout.
                  // Feed the run's liveness deadlines (no-output / progress in
                  // runSandboxAgent) so an IPC-only run isn't killed mid-work.
                  // route() returns null when the envelope was dropped by a
                  // pre-hook or had no user-visible text — not a delivery.
                  if (delivered !== null) {
                    notifyRunIpcActivity(sourceGroup, 'message');
                    // Record the delivered text in the chat transcript. IPC
                    // senders (an agent's explicit send_message and
                    // scheduled-task deliveries) bypass the message-loop's
                    // storeBotReply, so without this write the messages reach
                    // Telegram but remain invisible to the dashboard panel chat
                    // and to the bot's own conversation context.
                    storeBotReply(data.chatJid, delivered);
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'photo' &&
                data.chatJid &&
                data.filePath
              ) {
                if (sendAuthorization.authorized) {
                  const fileValidation = validateIpcSendFilePath({
                    sourceGroup,
                    isMain: sendAuthorization.effectiveOwner,
                    sourceIsMultiSenderMain:
                      folderIsMultiSenderMain.get(sourceGroup) === true,
                    filePath: String(data.filePath),
                    kind: 'photo',
                  });
                  if (!fileValidation.allowed) {
                    logger.warn(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        reason: fileValidation.reason,
                      },
                      'Unauthorized IPC photo file path blocked',
                    );
                    fs.unlinkSync(filePath);
                    continue;
                  }
                  let ok = false;
                  try {
                    ok = await deps.router.sendPhoto(
                      data.chatJid,
                      fileValidation.realPath,
                      data.caption,
                    );
                  } finally {
                    if (fileValidation.staged) {
                      try {
                        fs.unlinkSync(fileValidation.realPath);
                      } catch {
                        // Best effort: the opportunistic staging sweep is the
                        // fallback if an antivirus/channel raced the unlink.
                      }
                    }
                  }
                  // Confirmed photo delivery feeds the active run's liveness
                  // deadlines (see the 'message' branch above).
                  if (ok) notifyRunIpcActivity(sourceGroup, 'photo');
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      fileBasename: path.basename(fileValidation.realPath),
                      ok,
                    },
                    'IPC photo sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC photo attempt blocked',
                  );
                }
              } else if (
                data.type === 'document' &&
                data.chatJid &&
                data.filePath
              ) {
                if (sendAuthorization.authorized) {
                  const fileValidation = validateIpcSendFilePath({
                    sourceGroup,
                    isMain: sendAuthorization.effectiveOwner,
                    sourceIsMultiSenderMain:
                      folderIsMultiSenderMain.get(sourceGroup) === true,
                    filePath: String(data.filePath),
                    kind: 'document',
                  });
                  if (!fileValidation.allowed) {
                    logger.warn(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        reason: fileValidation.reason,
                      },
                      'Unauthorized IPC document file path blocked',
                    );
                    fs.unlinkSync(filePath);
                    continue;
                  }
                  let ok = false;
                  try {
                    ok = await deps.router.sendDocument(
                      data.chatJid,
                      fileValidation.realPath,
                      data.caption,
                    );
                  } finally {
                    if (fileValidation.staged) {
                      try {
                        fs.unlinkSync(fileValidation.realPath);
                      } catch {
                        // Best effort; stale host-only stages are swept on the
                        // next validated guest send.
                      }
                    }
                  }
                  if (ok) notifyRunIpcActivity(sourceGroup, 'document');
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      fileBasename: path.basename(fileValidation.realPath),
                      ok,
                    },
                    'IPC document sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC document attempt blocked',
                  );
                }
              } else if (data.type === 'voice' && data.chatJid && data.text) {
                if (sendAuthorization.authorized) {
                  const ok = await deps.router.sendVoice(
                    data.chatJid,
                    data.text,
                  );
                  if (ok) notifyRunIpcActivity(sourceGroup, 'voice');
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      length: String(data.text).length,
                      ok,
                    },
                    'IPC voice sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC voice attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (tasksDir) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'))
            // Oldest-first, bounded per-group drain (see messages loop above).
            .sort()
            .slice(0, MAX_IPC_FILES_PER_GROUP_PER_TICK);
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = readIpcEnvelopeJson(filePath);
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process SWE tasks from this group's IPC directory
      try {
        if (sweDir) {
          const sweFiles = fs
            .readdirSync(sweDir)
            .filter((f) => f.endsWith('.json'))
            // Oldest-first, bounded per-group drain (see messages loop above).
            .sort()
            .slice(0, MAX_IPC_FILES_PER_GROUP_PER_TICK);
          for (const file of sweFiles) {
            const filePath = path.join(sweDir, file);
            try {
              const data = readIpcEnvelopeJson(filePath);
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC SWE task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC SWE directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    calendar_event?: boolean;
    calendar_reminder_minutes?: number;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For propose_skill (guest skill proposal routed over IPC)
    description?: string;
    body?: string;
    tags?: unknown;
    triggers?: unknown;
    // For cleanup_tasks (bulk deletion of finished tasks)
    statuses?: unknown;
    targetGroupFolder?: string;
    /** Opaque, host-issued, exact-envelope owner operation grant. */
    ownerAuthorizationGrant?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  // `isMain` is only a property of the IPC DIRECTORY. A co-member sandbox in a
  // multi-sender main chat writes to that same directory, so it is never proof
  // of who authored this operation. Owner authority comes only from a one-use
  // host grant bound to this exact envelope and source group.
  const ownerAuthorization = consumeTaskOperationGrant(
    data as Record<string, unknown>,
    sourceGroup,
  );
  const effectiveOwner = ownerAuthorization !== null;
  const isOwnerTask = (task: ScheduledTask): boolean =>
    task.creator_authorization === 'owner_sender';
  const safeTaskId = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
  const canManageTask = (task: ScheduledTask): boolean =>
    effectiveOwner ||
    (!isMain && task.group_folder === sourceGroup && !isOwnerTask(task));

  switch (data.type) {
    case 'schedule_task': {
      if (
        typeof data.prompt !== 'string' ||
        !data.prompt.trim() ||
        data.prompt.length > 1024 * 1024 ||
        !['cron', 'interval', 'once'].includes(String(data.schedule_type)) ||
        typeof data.schedule_value !== 'string' ||
        !data.schedule_value ||
        data.schedule_value.length > 4096 ||
        typeof data.targetJid !== 'string' ||
        !data.targetJid ||
        data.targetJid.length > 256 ||
        (data.taskId !== undefined &&
          (typeof data.taskId !== 'string' ||
            !data.taskId.trim() ||
            data.taskId.length > 256)) ||
        (data.calendar_event !== undefined &&
          typeof data.calendar_event !== 'boolean') ||
        (data.calendar_reminder_minutes !== undefined &&
          (!Number.isInteger(data.calendar_reminder_minutes) ||
            data.calendar_reminder_minutes < 0 ||
            data.calendar_reminder_minutes > 40320))
      ) {
        logger.warn(
          { sourceGroup },
          'Invalid or oversized schedule_task envelope blocked',
        );
        break;
      }
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!effectiveOwner && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        const task: Omit<ScheduledTask, 'last_run' | 'last_result'> = {
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
          creator_authorization:
            ownerAuthorization?.creatorAuthorization ?? null,
          creator_identity_id: ownerAuthorization?.creatorIdentityId ?? null,
          creator_sender_id: ownerAuthorization?.creatorSenderId ?? null,
        };
        createTask(task);
        // Calendar mirroring targets the OWNER's single personal calendar with
        // host service-account creds. Only mirror the owner's own tasks — an
        // untrusted guest scheduling for its own folder must not inject
        // attacker-controlled events (title/body from its prompt) into the
        // owner's calendar (ultra-review 2026-07-11 #6).
        if (effectiveOwner) {
          await createCalendarEventForTask({
            task: { ...task, last_run: null, last_result: null },
            requested: data.calendar_event,
            reminderMinutes: data.calendar_reminder_minutes,
            deps,
          });
        }
        logger.info(
          {
            taskId,
            sourceGroup,
            targetFolder,
            contextMode,
            ownerAuthorized: effectiveOwner,
          },
          'Task created via IPC',
        );
      }
      break;
    }

    case 'pause_task':
      if (safeTaskId(data.taskId)) {
        const task = getTaskById(data.taskId);
        if (task && canManageTask(task)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (safeTaskId(data.taskId)) {
        const task = getTaskById(data.taskId);
        if (task && canManageTask(task)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (safeTaskId(data.taskId)) {
        const task = getTaskById(data.taskId);
        if (task && canManageTask(task)) {
          const calendarLink = getCalendarEventLink(data.taskId);
          if (!effectiveOwner && calendarLink?.status === 'active') {
            // Calendar links are created only by main with the owner's
            // credentials. A guest may own the target task folder, but that
            // must not grant authority to delete the owner's external event.
            logger.warn(
              { taskId: data.taskId, sourceGroup },
              'Guest task cancellation blocked for owner-linked calendar event',
            );
            break;
          }
          await deleteCalendarEventForTask(data.taskId, deps);
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'cleanup_tasks': {
      // Bulk deletion of FINISHED tasks («удали все завершённые задачи»).
      // Hard-limited to completed/cancelled at both layers (status filter here
      // AND the SQL in getFinishedTasks), so a malformed/hostile envelope can
      // never bulk-delete active or paused tasks. Scope: a non-main group only
      // cleans its own tasks; main cleans everything unless it names a target.
      if (isMain && !effectiveOwner) {
        logger.warn(
          { sourceGroup },
          'Unauthenticated main-directory cleanup_tasks attempt blocked',
        );
        break;
      }
      const requestedStatuses = Array.isArray(data.statuses)
        ? data.statuses.filter(
            (status): status is 'completed' | 'cancelled' =>
              status === 'completed' || status === 'cancelled',
          )
        : (['completed', 'cancelled'] as const).slice();
      const targetFolder = !effectiveOwner
        ? sourceGroup
        : typeof data.targetGroupFolder === 'string' && data.targetGroupFolder
          ? data.targetGroupFolder
          : undefined;
      if (
        !effectiveOwner &&
        data.targetGroupFolder &&
        data.targetGroupFolder !== sourceGroup
      ) {
        logger.warn(
          { sourceGroup, targetGroupFolder: data.targetGroupFolder },
          'Unauthorized cleanup_tasks attempt blocked',
        );
        break;
      }
      const finished = getFinishedTasks(requestedStatuses, targetFolder);
      let protectedTasks = 0;
      for (const task of finished) {
        if (
          !effectiveOwner &&
          (isOwnerTask(task) ||
            getCalendarEventLink(task.id)?.status === 'active')
        ) {
          protectedTasks += 1;
          continue;
        }
        await deleteCalendarEventForTask(task.id, deps);
        deleteTask(task.id);
      }
      logger.info(
        {
          sourceGroup,
          targetFolder: targetFolder || '(all)',
          statuses: requestedStatuses,
          deleted: finished.length - protectedTasks,
          protectedTasks,
        },
        'Finished tasks cleaned up via IPC',
      );
      break;
    }

    case 'update_task':
      if (safeTaskId(data.taskId)) {
        if (
          (data.prompt !== undefined &&
            (typeof data.prompt !== 'string' ||
              !data.prompt.trim() ||
              data.prompt.length > 1024 * 1024)) ||
          (data.schedule_type !== undefined &&
            !['cron', 'interval', 'once'].includes(data.schedule_type)) ||
          (data.schedule_value !== undefined &&
            (typeof data.schedule_value !== 'string' ||
              !data.schedule_value ||
              data.schedule_value.length > 4096))
        ) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Invalid or oversized update_task envelope blocked',
          );
          break;
        }
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!canManageTask(task)) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            'cron' | 'interval' | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (effectiveOwner) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!effectiveOwner) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (
        data.requiresTrigger !== undefined &&
        typeof data.requiresTrigger !== 'boolean'
      ) {
        logger.warn(
          { sourceGroup },
          'Invalid register_group requiresTrigger value blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Validate the JID shape: only the main agent reaches this branch, but
        // it processes untrusted guest content, so a malformed/injected jid must
        // not become a registration key. Require a plausible chat JID token.
        if (
          typeof data.jid !== 'string' ||
          !/^[A-Za-z0-9._@:+-]{1,256}$/.test(data.jid)
        ) {
          logger.warn(
            { sourceGroup, jid: data.jid },
            'Invalid register_group request - malformed jid',
          );
          break;
        }
        // Defense-in-depth: do NOT let register_group silently REPOINT an
        // already-registered jid to a different folder/identity (the upsert is
        // ON CONFLICT(jid) DO UPDATE, so reusing an existing jid would cross-wire
        // that tenant's future runs to a new — possibly guest-chosen — workspace).
        // Re-registration must be an explicit, deliberate operator action; reject
        // a collision here and log loudly rather than overwriting in place.
        const existing = registeredGroups[data.jid];
        if (existing && existing.folder !== data.folder) {
          logger.warn(
            {
              sourceGroup,
              jid: data.jid,
              existingFolder: existing.folder,
              requestedFolder: data.folder,
            },
            'register_group rejected - jid already mapped to a different folder',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'propose_skill': {
      // Guest skill proposal routed over IPC because the shared skills dir is
      // mounted READ-ONLY for guests (sandbox-runner.ts). The host writes the
      // DRAFT into `.proposals` (never active) for operator approval — same end
      // state as the old direct write, but the host re-validates the name,
      // size, and secret content so a hostile IPC envelope cannot escape the
      // proposal area or smuggle credentials into a stored skill. Any group may
      // propose; activation stays operator-gated (skills-manage approve).
      const name = typeof data.name === 'string' ? data.name : '';
      const description =
        typeof data.description === 'string' ? data.description : '';
      const body = typeof data.body === 'string' ? data.body : '';
      const toStringArray = (v: unknown): string[] =>
        Array.isArray(v)
          ? v.filter((x): x is string => typeof x === 'string').slice(0, 32)
          : [];
      if (!isSafeSkillName(name)) {
        logger.warn(
          { sourceGroup, name },
          'IPC skill proposal rejected: unsafe skill name',
        );
        break;
      }
      if (!body.trim() || body.length > 5000) {
        logger.warn(
          { sourceGroup, name, bodyLen: body.length },
          'IPC skill proposal rejected: empty or oversized body',
        );
        break;
      }
      try {
        // proposeSkill writes status:draft into the shared `.proposals` area and
        // throws on a secret-looking body (SECRET_CONTENT_RE) — fail closed.
        proposeSkill({
          frontmatter: {
            name,
            description: description.slice(0, 1024),
            tags: toStringArray(data.tags),
            triggers: toStringArray(data.triggers),
          },
          body,
        });
        logger.info(
          { sourceGroup, name },
          'Skill proposal saved to .proposals via IPC (pending operator approval)',
        );
      } catch (err) {
        logger.warn(
          { sourceGroup, name, err },
          'IPC skill proposal rejected by proposeSkill',
        );
      }
      break;
    }

    default: {
      // Check plugin IPC handlers
      const { getExtensionIpcHandlers } = await import('./extensions.js');
      const pluginHandlers = getExtensionIpcHandlers();
      const handler = pluginHandlers[data.type];
      if (handler) {
        // Extension IPC handlers expect { sendMessage } — proxy through router
        await handler(data, sourceGroup, effectiveOwner, {
          sendMessage: (jid: string, text: string) =>
            deps.router.send(jid, text),
        });
      } else {
        logger.warn({ type: data.type }, 'Unknown IPC task type');
      }
      break;
    }
  }
}
