import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SCREENSHOT_RETENTION_MS = 15 * 60 * 1000;
export const SCREENSHOT_MAX_FILES = 20;
export const CODEX_CONTROL_REVOCATION_RETENTION_MS = 24 * 60 * 60 * 1000;
export const CODEX_CONTROL_REVOCATION_MAX_ENTRIES = 256;

const CODEX_CONTROL_RUN_ID_RE =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const CODEX_CONTROL_RUN_REQUIRED_ENDPOINTS = new Set([
  '/codex_desktop/start',
  '/codex_desktop/continue',
  '/codex_desktop/steer',
]);
const CODEX_CONTROL_REVOCATION_FILE_MAX_BYTES = 128 * 1024;

const MANAGED_SCREENSHOT_NAME_RE =
  /^\d+(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.png$/i;
const CODEX_SENSITIVE_GUI_ENDPOINTS = new Set([
  '/screenshot',
  '/click',
  '/type',
  '/key',
  '/mouse_move',
]);
const HELPER_LOOPBACK_ORIGIN = 'http://127.0.0.1';

const CODEX_DESKTOP_PUBLIC_ERROR_RULES = [
  {
    pattern: /^threadId is required$/,
    status: 400,
    error: 'thread_id_required',
    detail:
      'thread_id is required for this action. Use list or read before open.',
  },
  {
    pattern: /^prompt is required$/,
    status: 400,
    error: 'prompt_required',
    detail: 'prompt is required for this action.',
  },
  {
    pattern: /^cwd must be an absolute project directory$/,
    status: 400,
    error: 'cwd_invalid',
    detail: 'cwd must be an existing absolute project directory.',
  },
  {
    pattern: /^cwd must be a directory$/,
    status: 400,
    error: 'cwd_invalid',
    detail: 'cwd must be an existing absolute project directory.',
  },
  {
    pattern: /^cwd must be an existing absolute project directory$/,
    status: 400,
    error: 'cwd_invalid',
    detail: 'cwd must be an existing absolute project directory.',
  },
  {
    pattern: /outside the locally authorized Codex Desktop roots/i,
    status: 403,
    error: 'cwd_not_authorized',
    detail:
      'cwd is outside the authorized Codex Desktop project roots. Inspect status before retrying.',
  },
  {
    pattern:
      /(?:Skoobi-managed Codex turn is still running|Codex Desktop turn is already active|thread already has an active turn)/i,
    status: 409,
    error: 'codex_turn_active',
    detail:
      'A Codex turn is already active. Inspect status, then wait, steer, or interrupt it.',
  },
  {
    pattern: /managed command processes are still running/i,
    status: 409,
    error: 'managed_processes_active',
    detail:
      'Managed command processes are still active. Inspect status and stop the current turn before retrying.',
  },
  {
    pattern: /requested Codex thread is not visible in the state database/i,
    status: 404,
    error: 'thread_not_found',
    detail:
      'The requested Codex thread is not available. Use list before retrying.',
  },
  {
    pattern: /controller state is unsafe or invalid/i,
    status: 503,
    error: 'codex_state_unavailable',
    detail:
      'Codex task state needs local inspection. No mutation was attempted.',
  },
];

export function codexDesktopErrorResponse(error) {
  const message = error instanceof Error ? error.message : '';
  const matched = CODEX_DESKTOP_PUBLIC_ERROR_RULES.find(({ pattern }) =>
    pattern.test(message),
  );
  if (matched) {
    return {
      status: matched.status,
      body: {
        error: matched.error,
        detail: matched.detail,
      },
    };
  }
  return {
    status: 500,
    body: {
      error: 'codex_desktop_internal_error',
      detail:
        'The Codex Desktop bridge could not complete the request. Inspect status and the helper log before retrying.',
    },
  };
}

export function parseHelperRequestUrl(requestTarget) {
  if (
    typeof requestTarget !== 'string' ||
    !requestTarget.startsWith('/') ||
    requestTarget.startsWith('//')
  ) {
    return null;
  }
  try {
    const url = new URL(requestTarget, HELPER_LOOPBACK_ORIGIN);
    return url.origin === HELPER_LOOPBACK_ORIGIN ? url : null;
  } catch {
    return null;
  }
}

export function codexGuiEndpointNeedsFrontmostCheck(endpoint) {
  return CODEX_SENSITIVE_GUI_ENDPOINTS.has(endpoint);
}

export function isValidCodexControlRunId(value) {
  return typeof value === 'string' && CODEX_CONTROL_RUN_ID_RE.test(value);
}

export function codexControlEndpointRequiresRunId(endpoint) {
  return CODEX_CONTROL_RUN_REQUIRED_ENDPOINTS.has(endpoint);
}

export function codexControlRequestError(endpoint, runId, revocations) {
  if (!codexControlEndpointRequiresRunId(endpoint)) return null;
  if (!isValidCodexControlRunId(runId)) {
    return 'codex_control_run_id_required';
  }
  return revocations.isRevoked(runId) ? 'codex_control_run_revoked' : null;
}

export class CodexControlRunRevocations {
  constructor(
    filePath,
    {
      now = () => Date.now(),
      retentionMs = CODEX_CONTROL_REVOCATION_RETENTION_MS,
      maxEntries = CODEX_CONTROL_REVOCATION_MAX_ENTRIES,
    } = {},
  ) {
    if (typeof now !== 'function') throw new Error('invalid revocation clock');
    if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) {
      throw new Error('invalid revocation retention');
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('invalid revocation entry limit');
    }
    this.filePath = path.resolve(filePath);
    this.now = now;
    this.retentionMs = retentionMs;
    this.maxEntries = maxEntries;
    this.entries = this.#load();
  }

  isRevoked(runId) {
    if (!isValidCodexControlRunId(runId)) return false;
    this.#prune();
    return this.entries.has(runId);
  }

  revoke(runId) {
    if (!isValidCodexControlRunId(runId)) {
      throw new Error('invalid Codex control run id');
    }
    const revokedAt = this.#currentTime();
    this.entries.set(runId, revokedAt);
    this.#prune();
    this.#save();
  }

  #assertPrivateDirectory() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    ) {
      throw new Error('Codex control revocation directory is unsafe');
    }
    return directory;
  }

  #load() {
    this.#assertPrivateDirectory();
    let fd;
    try {
      fd = fs.openSync(
        this.filePath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > CODEX_CONTROL_REVOCATION_FILE_MAX_BYTES ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      ) {
        throw new Error('unsafe revocation file');
      }
      const parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (
        parsed?.version !== 1 ||
        !Array.isArray(parsed.revoked) ||
        parsed.revoked.length > this.maxEntries * 2
      ) {
        throw new Error('invalid revocation file');
      }
      const entries = new Map();
      for (const entry of parsed.revoked) {
        if (
          !isValidCodexControlRunId(entry?.runId) ||
          !Number.isSafeInteger(entry?.revokedAt) ||
          entry.revokedAt <= 0
        ) {
          throw new Error('invalid revocation entry');
        }
        entries.set(entry.runId, entry.revokedAt);
      }
      return entries;
    } catch (error) {
      if (error?.code === 'ENOENT') return new Map();
      throw new Error('Codex control revocation file is unsafe or invalid', {
        cause: error,
      });
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  #prune() {
    const cutoff = this.#currentTime() - this.retentionMs;
    const retained = [...this.entries.entries()]
      .filter(([, revokedAt]) => revokedAt >= cutoff)
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.maxEntries);
    this.entries = new Map(retained);
  }

  #save() {
    const directory = this.#assertPrivateDirectory();
    const tempFile = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tempFile, 'wx', 0o600);
      fs.writeFileSync(
        fd,
        `${JSON.stringify({
          version: 1,
          revoked: [...this.entries.entries()].map(([runId, revokedAt]) => ({
            runId,
            revokedAt,
          })),
        })}\n`,
      );
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tempFile, this.filePath);
      let dirFd;
      try {
        dirFd = fs.openSync(directory, fs.constants.O_RDONLY);
        fs.fsyncSync(dirFd);
      } catch (error) {
        if (error?.code !== 'EINVAL' && error?.code !== 'ENOTSUP') throw error;
      } finally {
        if (dirFd !== undefined) fs.closeSync(dirFd);
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try {
        fs.unlinkSync(tempFile);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }

  #currentTime() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('invalid revocation clock value');
    }
    return value;
  }
}

export function isCodexApplicationName(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().replace(/[\\/]+$/g, '');
  const normalized = path
    .basename(trimmed)
    .replace(/\.app$/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return (
    normalized === 'codex' ||
    normalized.startsWith('codex ') ||
    normalized === 'com.openai.codex'
  );
}

export function codexGuiAuthorizationRequired({
  endpoint,
  body,
  frontmostApplication,
}) {
  if (endpoint === '/open_app') {
    return isCodexApplicationName(body?.name);
  }
  return (
    CODEX_SENSITIVE_GUI_ENDPOINTS.has(endpoint) &&
    isCodexApplicationName(frontmostApplication)
  );
}

export function safeHelperRequestLogFields(endpoint, body) {
  if (!body) return undefined;
  if (endpoint === '/type') {
    return {
      text_length: typeof body.text === 'string' ? body.text.length : 0,
    };
  }
  return body;
}

function assertPrivateScreenshotDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('screenshot path is not a directory');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('screenshot directory has an unexpected owner');
  }
  fs.chmodSync(directory, 0o700);
}

export function secureScreenshotFile(filePath, directory) {
  const resolvedDirectory = path.resolve(directory);
  const resolvedFile = path.resolve(filePath);
  if (path.dirname(resolvedFile) !== resolvedDirectory) {
    throw new Error('screenshot file is outside the private directory');
  }
  const stat = fs.lstatSync(resolvedFile);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    throw new Error('screenshot file is unsafe');
  }
  fs.chmodSync(resolvedFile, 0o600);
  return stat.size;
}

export function secureScreenshotDirectory(
  directory,
  {
    nowMs = Date.now(),
    retentionMs = SCREENSHOT_RETENTION_MS,
    maxFiles = SCREENSHOT_MAX_FILES,
  } = {},
) {
  if (!Number.isFinite(nowMs)) throw new Error('invalid screenshot clock');
  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new Error('invalid screenshot retention');
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) {
    throw new Error('invalid screenshot file limit');
  }

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateScreenshotDirectory(directory);

  const retained = [];
  let deleted = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!MANAGED_SCREENSHOT_NAME_RE.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(filePath);
      deleted += 1;
      continue;
    }
    if (!stat.isFile()) continue;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('managed screenshot has an unexpected owner');
    }
    fs.chmodSync(filePath, 0o600);
    if (nowMs - stat.mtimeMs > retentionMs) {
      fs.unlinkSync(filePath);
      deleted += 1;
      continue;
    }
    retained.push({ filePath, mtimeMs: stat.mtimeMs });
  }

  retained.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of retained.slice(maxFiles)) {
    fs.unlinkSync(stale.filePath);
    deleted += 1;
  }
  return {
    deleted,
    retained: Math.min(retained.length, maxFiles),
  };
}
