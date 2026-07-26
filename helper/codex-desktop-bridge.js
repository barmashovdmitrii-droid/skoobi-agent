import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TERMINAL_TURN_STATUSES = new Set(['completed', 'interrupted', 'failed']);

const SAFE_DEVELOPER_INSTRUCTIONS = `You are working under Skoobi's delegated local-development policy.
Work only inside the supplied working directory. Do not read secret files, use external network services, send messages, push, merge, deploy, restart services, or change production. Local code edits, tests, and builds are allowed. Run commands in the foreground and do not leave background processes behind. If the task requires anything outside those limits, stop and clearly describe what permission is needed. Keep progress and final reports short, concrete, and easy to understand.`;

const RECOVERY_PROMPT = `Continue the already authorized task from this thread after the local controller restarted. Inspect the existing thread and current working tree, complete any remaining work, run the relevant local checks, and report the verified result. Keep the same local-only safety limits; do not push, merge, deploy, restart services, use external services, access secrets, or change production.`;

const LOCAL_ONLY_THREAD_CONFIG = {
  web_search: 'disabled',
  apps: {
    _default: {
      enabled: false,
      approvals_reviewer: 'user',
      destructive_enabled: false,
      open_world_enabled: false,
      default_tools_approval_mode: 'prompt',
    },
  },
};

const APP_SERVER_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
];

const STATE_DB_PAGE_SIZE = 100;
const STATE_DB_MAX_PAGES = 1_000;
const STATE_FILE_MAX_BYTES = 64 * 1024;
const CODEX_CONFIG_MAX_BYTES = 1024 * 1024;
const UNOWNED_TURN_POLL_MS = 250;
const STATE_LOCK_POLL_MS = 25;
const STATE_LOCK_TIMEOUT_MS = 60_000;
const INTERRUPT_CONFIRM_TIMEOUT_MS = 10_000;
const WAIT_MAX_TIMEOUT_MS = 10_000;
const CONTROL_REQUEST_TIMEOUT_MS = 10_000;
const BACKGROUND_TERMINAL_PAGE_SIZE = 100;
const BACKGROUND_TERMINAL_MAX_PAGES = 100;
const PROCESS_STOP_CONFIRM_TIMEOUT_MS = 5_000;
const PROCESS_STOP_POLL_MS = 100;
const HOST_PROCESS_STOP_GRACE_MS = 1_000;
const HOST_PROCESS_CAPTURE_TIMEOUT_MS = 500;
const HOST_PROCESS_CAPTURE_POLL_MS = 50;
const MCP_CONFIG_NAME_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

const APP_SERVER_DISABLED_FEATURES = [
  'plugins',
  'plugin_sharing',
  'apps',
  'enable_mcp_apps',
  'auth_elicitation',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'computer_use',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'in_app_browser',
  'standalone_web_search',
  'network_proxy',
  'code_mode_host',
  'code_mode',
  'image_generation',
  'hooks',
  'multi_agent',
  'enable_fanout',
  'remote_plugin',
  'realtime_conversation',
  'guardian_approval',
  'request_permissions_tool',
  'goals',
  'memories',
  'workspace_dependencies',
  'skill_mcp_dependency_install',
];

function appServerEnvironment(source, codexHome) {
  const environment = {};
  for (const key of APP_SERVER_ENV_KEYS) {
    if (typeof source[key] === 'string') environment[key] = source[key];
  }
  environment.CODEX_HOME = codexHome;
  return environment;
}

export function defaultCodexDesktopStateFile(homeDir = os.homedir()) {
  if (process.platform === 'darwin') {
    return path.join(
      homeDir,
      'Library',
      'Application Support',
      'Skoobi',
      'codex-desktop',
      'task-state.json',
    );
  }
  return path.join(
    homeDir,
    '.local',
    'state',
    'skoobi',
    'codex-desktop',
    'task-state.json',
  );
}

export function configuredMcpServerNames(configFile) {
  let fd;
  try {
    fd = fs.openSync(
      configFile,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > CODEX_CONFIG_MAX_BYTES ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    ) {
      throw new Error('unsafe Codex config file');
    }
    const raw = fs.readFileSync(fd, 'utf8');
    const names = new Set();
    for (const line of raw.split(/\r?\n/)) {
      if (!/^\s*\[mcp_servers\./.test(line)) continue;
      const match = line.match(
        /^\s*\[mcp_servers\.([A-Za-z0-9_-]+)(?:\.[^\]]+)?\]\s*(?:#.*)?$/,
      );
      if (!match || !MCP_CONFIG_NAME_PATTERN.test(match[1])) {
        throw new Error(
          'Codex MCP configuration contains an unsupported server name; refusing to start the isolated bridge.',
        );
      }
      names.add(match[1]);
    }
    return [...names].sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (
      error instanceof Error &&
      /unsupported server name/.test(error.message)
    ) {
      throw error;
    }
    throw new Error('Could not inspect Codex MCP configuration safely.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function isolatedAppServerArgs(mcpServerNames = []) {
  const args = [];
  for (const feature of APP_SERVER_DISABLED_FEATURES) {
    args.push('--disable', feature);
  }
  for (const name of mcpServerNames) {
    if (!MCP_CONFIG_NAME_PATTERN.test(name)) {
      throw new Error('Invalid Codex MCP server name.');
    }
    args.push('-c', `mcp_servers.${name}.enabled=false`);
  }
  args.push('-c', 'sandbox_permissions=[]');
  args.push('app-server', '--listen', 'stdio://');
  return args;
}

function errorKind(value) {
  return value instanceof Error ? value.name : typeof value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function decodeSingleShellWord(value) {
  let output = '';
  let state = 'plain';
  let started = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (state === 'single') {
      if (char === "'") state = 'plain';
      else output += char;
      continue;
    }
    if (state === 'double') {
      if (char === '"') {
        state = 'plain';
      } else if (char === '\\') {
        const next = value[index + 1];
        if (next === undefined) return null;
        if ('"\\`$\n'.includes(next)) {
          if (next !== '\n') output += next;
          index += 1;
        } else {
          output += `\\${next}`;
          index += 1;
        }
      } else {
        output += char;
      }
      continue;
    }
    if (/\s/.test(char)) {
      if (!started) continue;
      if (value.slice(index).trim()) return null;
      break;
    }
    started = true;
    if (char === "'") {
      state = 'single';
    } else if (char === '"') {
      state = 'double';
    } else if (char === '\\') {
      if (value[index + 1] === undefined) return null;
      output += value[index + 1];
      index += 1;
    } else {
      output += char;
    }
  }
  return started && state === 'plain' ? output : null;
}

function commandMatchNeedles(command) {
  const needles = new Set([command]);
  const shell = command.match(
    /^\/(?:usr\/)?bin\/(?:ba|z|da|k)?sh\s+-[A-Za-z]*c[A-Za-z]*\s+([\s\S]+)$/,
  );
  if (!shell) return [...needles];
  const payload = decodeSingleShellWord(shell[1]);
  if (payload) needles.add(payload);
  return [...needles];
}

export function parseMacProcessTable(raw) {
  const rows = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/,
    );
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      uid: Number(match[4]),
      startedAt: match[5],
      command: match[6],
    });
  }
  return rows;
}

export function commandProcessIdentities(
  rows,
  appServerPid,
  command,
  expectedUid,
) {
  if (
    !Number.isSafeInteger(appServerPid) ||
    appServerPid <= 1 ||
    typeof command !== 'string' ||
    !command
  ) {
    return [];
  }
  const descendants = new Set([appServerPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
  const commandNeedles = commandMatchNeedles(command);
  const identities = new Map();
  for (const row of rows) {
    if (
      row.uid !== expectedUid ||
      !descendants.has(row.pid) ||
      !commandNeedles.some((needle) => row.command.includes(needle))
    ) {
      continue;
    }
    const leader = rowsByPid.get(row.pgid);
    if (
      !leader ||
      leader.pid !== leader.pgid ||
      leader.uid !== expectedUid ||
      !descendants.has(leader.pid)
    ) {
      continue;
    }
    identities.set(leader.pgid, {
      pid: leader.pid,
      pgid: leader.pgid,
      uid: leader.uid,
      startedAt: leader.startedAt,
      commandHash: sha256(leader.command),
    });
  }
  if (identities.size === 0) {
    // This app-server process is private to the bridge and the bridge permits
    // only one active managed turn. macOS `ps` rewrites some argv content
    // (notably newlines as octal escapes), so exact text matching is not always
    // possible. In that case bind every distinct process-group leader that is
    // still a same-UID descendant of this exact app-server. Those groups can
    // only be side effects of the managed turn, and recovery still requires an
    // exact PID, UID, start-time, and command-hash match before sending a signal.
    for (const leader of rows) {
      if (
        leader.pid !== appServerPid &&
        leader.pid === leader.pgid &&
        leader.uid === expectedUid &&
        descendants.has(leader.pid)
      ) {
        identities.set(leader.pgid, {
          pid: leader.pid,
          pgid: leader.pgid,
          uid: leader.uid,
          startedAt: leader.startedAt,
          commandHash: sha256(leader.command),
        });
      }
    }
  }
  return [...identities.values()];
}

export function codexRequestLogFields(body = {}) {
  return {
    thread_id: body.thread_id,
    turn_id: body.turn_id,
    cwd: body.cwd,
    task_title_length:
      typeof body.task_title === 'string' ? body.task_title.length : undefined,
    prompt_length:
      typeof body.prompt === 'string' ? body.prompt.length : undefined,
  };
}

function truncate(value, max = 4_000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function userInputText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

export function summarizeTurn(turn) {
  if (!turn || typeof turn !== 'object') return null;
  const summary = {
    id: turn.id,
    status: turn.status,
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
    durationMs: turn.durationMs ?? null,
    error: turn.error ? truncate(JSON.stringify(turn.error), 2_000) : null,
    messages: [],
    commands: [],
    fileChanges: [],
  };

  for (const item of Array.isArray(turn.items) ? turn.items : []) {
    if (item?.type === 'userMessage') {
      summary.messages.push({
        role: 'user',
        text: truncate(userInputText(item.content)),
      });
    } else if (item?.type === 'agentMessage') {
      summary.messages.push({ role: 'assistant', text: truncate(item.text) });
    } else if (item?.type === 'commandExecution') {
      summary.commands.push({
        command: truncate(item.command, 1_000),
        status: item.status,
        exitCode: item.exitCode ?? null,
      });
    } else if (item?.type === 'fileChange') {
      summary.fileChanges.push({
        status: item.status,
        paths: (Array.isArray(item.changes) ? item.changes : [])
          .map((change) => change?.path)
          .filter((filePath) => typeof filePath === 'string')
          .slice(0, 100),
      });
    }
  }

  return summary;
}

export function summarizeThread(thread, maxTurns = 8) {
  if (!thread || typeof thread !== 'object') return null;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  return {
    id: thread.id,
    name: thread.name ?? null,
    preview: truncate(thread.preview, 500),
    cwd: thread.cwd,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    turns:
      maxTurns > 0
        ? turns.slice(-maxTurns).map(summarizeTurn).filter(Boolean)
        : [],
  };
}

export function isPathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * Minimal JSON-lines client for `codex app-server --listen stdio://`.
 * The process is started lazily and never receives the helper secret.
 */
export class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexBin = options.codexBin || 'codex';
    this.codexHome = options.codexHome || path.join(os.homedir(), '.codex');
    this.codexConfigFile =
      options.codexConfigFile || path.join(this.codexHome, 'config.toml');
    this.mcpServerNames = options.mcpServerNames;
    this.verifyToolIsolation = options.verifyToolIsolation !== false;
    this.spawnProcess = options.spawnProcess || spawn;
    this.processEnv = options.processEnv || process.env;
    this.log = options.log || (() => {});
    this.child = null;
    this.lineReader = null;
    this.startPromise = null;
    this.pending = new Map();
    this.nextId = 1;
    this.lastError = null;
    this.startedAt = null;
    this.instanceId = null;
  }

  status() {
    return {
      running: Boolean(this.child && this.child.exitCode === null),
      startedAt: this.startedAt,
      lastError: this.lastError,
    };
  }

  processPid() {
    return Number.isSafeInteger(this.child?.pid) ? this.child.pid : null;
  }

  serverInstanceId() {
    return this.instanceId;
  }

  async ensureStarted() {
    if (this.startPromise) return this.startPromise;
    if (this.child && this.child.exitCode === null) return;
    this.startPromise = this.#start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #start() {
    this.instanceId = randomUUID();
    const mcpServerNames = Array.isArray(this.mcpServerNames)
      ? this.mcpServerNames
      : configuredMcpServerNames(this.codexConfigFile);
    const child = this.spawnProcess(
      this.codexBin,
      isolatedAppServerArgs(mcpServerNames),
      {
        env: appServerEnvironment(this.processEnv, this.codexHome),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    this.startedAt = new Date().toISOString();
    this.lastError = null;

    child.on('error', (error) => this.#handleExit(child, error));
    child.on('exit', (code, signal) => {
      this.#handleExit(
        child,
        new Error(`Codex app server stopped (code=${code}, signal=${signal})`),
      );
    });
    child.stderr.on('data', (chunk) => {
      if (chunk.length > 0) {
        // App-server diagnostics are deliberately not copied into helper logs:
        // they can contain prompt or result fragments.
        this.log('warn', 'codex_app_server_stderr', { bytes: chunk.length });
      }
    });

    this.lineReader = readline.createInterface({ input: child.stdout });
    this.lineReader.on('line', (line) => this.#handleLine(line));

    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    try {
      await this.#requestRaw('initialize', {
        clientInfo: {
          name: 'skoobi-codex-desktop-bridge',
          version: '1.0.0',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      this.#notify('initialized');
      if (this.verifyToolIsolation) {
        await this.#verifyNoActiveMcpTools();
      }
    } catch (error) {
      this.#handleExit(child, error);
      if (child.exitCode === null) child.kill('SIGTERM');
      throw error;
    }
  }

  async #verifyNoActiveMcpTools() {
    let cursor = null;
    const seenCursors = new Set();
    for (let page = 0; page < 100; page++) {
      const result = await this.#requestRaw('mcpServerStatus/list', {
        cursor,
        limit: 100,
      });
      if (!Array.isArray(result?.data)) {
        throw new Error(
          'Codex MCP isolation verification returned invalid data.',
        );
      }
      for (const server of result.data) {
        const active =
          Boolean(server?.serverInfo) ||
          Object.keys(server?.tools || {}).length > 0 ||
          (Array.isArray(server?.resources) && server.resources.length > 0) ||
          (Array.isArray(server?.resourceTemplates) &&
            server.resourceTemplates.length > 0);
        if (active) {
          throw new Error(
            'Codex app-server exposed an MCP tool despite bridge isolation; refusing to continue.',
          );
        }
      }
      const nextCursor = result.nextCursor ?? null;
      if (nextCursor === null) return;
      if (
        typeof nextCursor !== 'string' ||
        !nextCursor ||
        seenCursors.has(nextCursor)
      ) {
        throw new Error('Codex MCP isolation returned an invalid cursor.');
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error('Codex MCP isolation pagination limit was exceeded.');
  }

  #handleExit(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.startedAt = null;
    this.instanceId = null;
    this.lineReader?.close();
    this.lineReader = null;
    this.lastError = errorKind(error);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.emit('exit', error);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.log('warn', 'codex_app_server_invalid_json');
      return;
    }

    if (message?.method && message.id !== undefined) {
      this.#handleServerRequest(message);
      return;
    }
    if (message?.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            typeof message.error?.message === 'string'
              ? message.error.message
              : JSON.stringify(message.error),
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message?.method) {
      this.emit('notification', message);
      this.emit(message.method, message.params);
    }
  }

  #handleServerRequest(message) {
    const declineMethods = new Set([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
    ]);
    if (declineMethods.has(message.method)) {
      this.#write({ id: message.id, result: { decision: 'decline' } });
      this.emit('approvalDeclined', { method: message.method });
      return;
    }
    if (
      message.method === 'applyPatchApproval' ||
      message.method === 'execCommandApproval'
    ) {
      this.#write({ id: message.id, result: { decision: 'denied' } });
      this.emit('approvalDeclined', { method: message.method });
      return;
    }
    if (message.method === 'item/tool/requestUserInput') {
      this.#write({ id: message.id, result: { answers: {} } });
      return;
    }
    if (message.method === 'mcpServer/elicitation/request') {
      this.#write({
        id: message.id,
        result: { action: 'decline', content: null, _meta: null },
      });
      return;
    }
    this.#write({
      id: message.id,
      error: {
        code: -32001,
        message: 'Skoobi bridge does not grant interactive or elevated access.',
      },
    });
  }

  #write(message) {
    if (!this.child?.stdin?.writable) {
      throw new Error('Codex app server is not writable');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #notify(method, params) {
    this.#write({ method, params });
  }

  #requestRaw(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params = {}, timeoutMs = 30_000) {
    await this.ensureStarted();
    return this.#requestRaw(method, params, timeoutMs);
  }

  async waitForTurn(threadId, turnId, timeoutMs = 45_000) {
    await this.ensureStarted();
    return new Promise((resolve, reject) => {
      let settled = false;
      let pollTimer = null;
      let loggedReadFailure = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (pollTimer) clearTimeout(pollTimer);
        this.off('turn/completed', onCompleted);
        if (error) reject(error);
        else resolve(value);
      };
      const onCompleted = (params) => {
        if (params?.threadId === threadId && params?.turn?.id === turnId) {
          finish(params.turn);
        }
      };
      this.on('turn/completed', onCompleted);
      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();

      const poll = async () => {
        if (settled) return;
        try {
          const result = await this.request(
            'thread/read',
            { threadId, includeTurns: true },
            Math.min(Math.max(timeoutMs, 250), 5_000),
          );
          const turn = result?.thread?.turns?.find(
            (item) => item.id === turnId,
          );
          if (turn && TERMINAL_TURN_STATUSES.has(turn.status)) {
            finish(turn);
            return;
          }
        } catch (error) {
          // A freshly-created persistent thread can be visible to app-server
          // before its rollout metadata has reached disk. The completion
          // notification is still authoritative, so keep waiting instead of
          // aborting the live turn on this transient read race.
          if (!loggedReadFailure) {
            loggedReadFailure = true;
            this.log('warn', 'codex_thread_initial_read_failed', {
              errorKind: errorKind(error),
            });
          }
        }
        if (settled) return;
        pollTimer = setTimeout(poll, UNOWNED_TURN_POLL_MS);
        pollTimer.unref?.();
      };
      void poll();
    });
  }

  stop() {
    this.lineReader?.close();
    this.lineReader = null;
    const child = this.child;
    if (child && child.exitCode === null) child.kill('SIGTERM');
    this.child = null;
    this.startedAt = null;
    this.instanceId = null;
    const error = new Error('Codex app server stopped by Skoobi bridge');
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
}

export class CodexDesktopBridge {
  constructor(options) {
    this.client = options.client;
    this.allowedRoots = (options.allowedRoots || []).map((root) =>
      fs.realpathSync(root),
    );
    const requestedStateFile = path.resolve(options.stateFile);
    const requestedStateDir = path.dirname(requestedStateFile);
    fs.mkdirSync(requestedStateDir, { recursive: true, mode: 0o700 });
    const stateDirStat = fs.statSync(requestedStateDir);
    if (
      !stateDirStat.isDirectory() ||
      (stateDirStat.mode & 0o022) !== 0 ||
      (typeof process.getuid === 'function' &&
        stateDirStat.uid !== process.getuid())
    ) {
      throw new Error('Codex controller state directory is unsafe.');
    }
    this.stateFile = path.join(
      fs.realpathSync(requestedStateDir),
      path.basename(requestedStateFile),
    );
    this.stateLockFile = `${this.stateFile}.lock`;
    if (this.allowedRoots.some((root) => isPathWithin(this.stateFile, root))) {
      throw new Error(
        'Codex controller state must be outside every authorized writable root.',
      );
    }
    this.openThread = options.openThread;
    this.stateLoadError = null;
    this.state = null;
    this.#reloadState();
    this.mutationTail = Promise.resolve();
    this.ownedTurns = new Set();

    this.client.on('turn/completed', (params) => {
      void this.#withMutation(() =>
        this.#finalizeTurn(params?.turn, params?.threadId),
      ).catch((error) => {
        this.client.log?.('warn', 'codex_turn_state_update_failed', {
          errorKind: errorKind(error),
        });
      });
    });
    this.client.on('item/started', (params) => {
      void this.#withMutation(() => this.#recordCommandItem(params)).catch(
        (error) => {
          this.client.log?.('warn', 'codex_command_state_update_failed', {
            errorKind: errorKind(error),
          });
        },
      );
    });
    this.client.on('item/completed', (params) => {
      void this.#withMutation(() => this.#recordCommandCompleted(params)).catch(
        (error) => {
          this.client.log?.('warn', 'codex_command_state_update_failed', {
            errorKind: errorKind(error),
          });
        },
      );
    });
  }

  async #withMutation(operation, options = {}) {
    const previous = this.mutationTail;
    let release;
    this.mutationTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    let releaseStateLock;
    try {
      releaseStateLock = await this.#acquireStateLock();
      this.#reloadState();
      if (options.allowInvalidState !== true) this.#assertStateHealthy();
      return await operation();
    } finally {
      releaseStateLock?.();
      release();
    }
  }

  #request(method, params) {
    return this.client.request(method, params, CONTROL_REQUEST_TIMEOUT_MS);
  }

  async #acquireStateLock(timeoutMs = STATE_LOCK_TIMEOUT_MS) {
    const token = randomUUID();
    const deadline = Date.now() + timeoutMs;
    while (true) {
      let fd;
      try {
        fd = fs.openSync(
          this.stateLockFile,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            (fs.constants.O_NOFOLLOW || 0),
          0o600,
        );
        fs.writeFileSync(
          fd,
          `${JSON.stringify({ pid: process.pid, token })}\n`,
        );
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        return () => {
          let lockFd;
          try {
            lockFd = fs.openSync(
              this.stateLockFile,
              fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
            );
            const openedStat = fs.fstatSync(lockFd);
            const lock = JSON.parse(fs.readFileSync(lockFd, 'utf8'));
            if (lock?.token === token && lock?.pid === process.pid) {
              this.#unlinkLockIfSameFile(openedStat);
            }
          } catch (error) {
            if (error?.code !== 'ENOENT') {
              this.client.log?.('warn', 'codex_state_lock_release_failed', {
                errorKind: errorKind(error),
              });
            }
          } finally {
            if (lockFd !== undefined) fs.closeSync(lockFd);
          }
        };
      } catch (error) {
        if (fd !== undefined) fs.closeSync(fd);
        if (error?.code !== 'EEXIST') throw error;
        if (this.#removeStaleStateLock()) continue;
        if (Date.now() >= deadline) {
          throw new Error(
            'Another Codex controller is changing task state; refusing concurrent control.',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, STATE_LOCK_POLL_MS));
      }
    }
  }

  #removeStaleStateLock() {
    let fd;
    try {
      fd = fs.openSync(
        this.stateLockFile,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 4_096 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      ) {
        throw new Error('unsafe Codex controller lock file');
      }
      const lock = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (
        !Number.isSafeInteger(lock?.pid) ||
        lock.pid <= 1 ||
        typeof lock?.token !== 'string' ||
        !lock.token
      ) {
        throw new Error('invalid Codex controller lock file');
      }
      try {
        process.kill(lock.pid, 0);
        return false;
      } catch (error) {
        if (error?.code === 'EPERM') return false;
      }
      return this.#unlinkLockIfSameFile(stat);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  #unlinkLockIfSameFile(openedStat) {
    try {
      const currentStat = fs.lstatSync(this.stateLockFile);
      if (
        currentStat.dev !== openedStat.dev ||
        currentStat.ino !== openedStat.ino
      ) {
        return true;
      }
      fs.unlinkSync(this.stateLockFile);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      throw error;
    }
  }

  #turnKey(threadId, turnId) {
    return `${threadId}:${turnId}`;
  }

  #ownsTurn(threadId, turnId) {
    return this.ownedTurns.has(this.#turnKey(threadId, turnId));
  }

  #assertStateHealthy() {
    if (this.stateLoadError) {
      throw new Error(
        'Codex controller state is unsafe or invalid; refusing to change task state.',
      );
    }
  }

  #validState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state))
      return false;
    const requiredStrings = [
      'taskId',
      'taskTitle',
      'threadId',
      'turnId',
      'cwd',
      'status',
      'startedAt',
      'updatedAt',
    ];
    if (
      state.version !== 1 ||
      requiredStrings.some(
        (key) => typeof state[key] !== 'string' || !state[key].trim(),
      ) ||
      !path.isAbsolute(state.cwd) ||
      !new Set([
        'inProgress',
        'stopping',
        'completed',
        'interrupted',
        'failed',
      ]).has(state.status) ||
      (state.completedAt !== undefined &&
        state.completedAt !== null &&
        typeof state.completedAt !== 'string') ||
      (state.stopRequestedAt !== undefined &&
        state.stopRequestedAt !== null &&
        typeof state.stopRequestedAt !== 'string') ||
      (state.startRequestKey !== undefined &&
        (typeof state.startRequestKey !== 'string' ||
          !/^[0-9a-f]{64}$/.test(state.startRequestKey))) ||
      (state.recoveryCount !== undefined &&
        (!Number.isSafeInteger(state.recoveryCount) ||
          state.recoveryCount < 0)) ||
      !this.#validIdList(state.commandItemIds) ||
      !this.#validIdList(state.completedCommandItemIds) ||
      !this.#validIdList(state.terminalBaselineItemIds) ||
      !this.#validProcessList(state.commandProcesses) ||
      ((state.status === 'inProgress' || state.status === 'stopping') &&
        (!Array.isArray(state.commandItemIds) ||
          !Array.isArray(state.completedCommandItemIds) ||
          !Array.isArray(state.terminalBaselineItemIds) ||
          !Array.isArray(state.commandProcesses) ||
          typeof state.appServerInstanceId !== 'string' ||
          !state.appServerInstanceId ||
          state.appServerInstanceId.length > 200))
    ) {
      return false;
    }
    try {
      this.#authorizedCwd(state.cwd);
      return true;
    } catch {
      return false;
    }
  }

  #validIdList(value) {
    return (
      value === undefined ||
      (Array.isArray(value) &&
        value.length <= 1_000 &&
        value.every(
          (item) =>
            typeof item === 'string' && item.length > 0 && item.length <= 200,
        ))
    );
  }

  #validProcessList(value) {
    return (
      value === undefined ||
      (Array.isArray(value) &&
        value.length <= 1_000 &&
        value.every(
          (item) =>
            item &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            typeof item.itemId === 'string' &&
            item.itemId.length > 0 &&
            item.itemId.length <= 200 &&
            Number.isSafeInteger(item.pid) &&
            item.pid > 1 &&
            item.pid === item.pgid &&
            Number.isSafeInteger(item.uid) &&
            item.uid >= 0 &&
            typeof item.startedAt === 'string' &&
            item.startedAt.length > 0 &&
            item.startedAt.length <= 64 &&
            typeof item.commandHash === 'string' &&
            /^[0-9a-f]{64}$/.test(item.commandHash),
        ))
    );
  }

  #readStateFromDisk() {
    let fd;
    try {
      fd = fs.openSync(
        this.stateFile,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      const stateStat = fs.fstatSync(fd);
      if (
        !stateStat.isFile() ||
        stateStat.nlink !== 1 ||
        (stateStat.mode & 0o077) !== 0 ||
        stateStat.size > STATE_FILE_MAX_BYTES ||
        (typeof process.getuid === 'function' &&
          stateStat.uid !== process.getuid())
      ) {
        throw new Error('unsafe state file');
      }
      const state = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (!this.#validState(state)) throw new Error('invalid state file');
      return { state, error: null };
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: null, error: null };
      return { state: null, error: 'state_file_invalid' };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  #reloadState() {
    const loaded = this.#readStateFromDisk();
    this.state = loaded.state;
    this.stateLoadError = loaded.error;
  }

  #saveState(state) {
    this.#assertStateHealthy();
    const tempFile = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tempFile, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tempFile, this.stateFile);
      let dirFd;
      try {
        dirFd = fs.openSync(
          path.dirname(this.stateFile),
          fs.constants.O_RDONLY,
        );
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
    this.state = state;
    this.stateLoadError = null;
  }

  #updateStateFromTurn(turn, threadId) {
    if (
      !this.state ||
      this.state.threadId !== threadId ||
      this.state.turnId !== turn?.id
    ) {
      return false;
    }
    this.#saveState({
      ...this.state,
      status: turn.status,
      updatedAt: new Date().toISOString(),
      completedAt: TERMINAL_TURN_STATUSES.has(turn.status)
        ? new Date().toISOString()
        : null,
    });
    if (TERMINAL_TURN_STATUSES.has(turn.status)) {
      this.ownedTurns.delete(this.#turnKey(threadId, turn.id));
    }
    return true;
  }

  async #finalizeTurn(turn, threadId) {
    if (
      !turn ||
      !TERMINAL_TURN_STATUSES.has(turn.status) ||
      !this.state ||
      this.state.threadId !== threadId ||
      this.state.turnId !== turn.id
    ) {
      return false;
    }
    const processes = await this.#terminateManagedBackgroundTerminals(
      threadId,
      turn.id,
    );
    if (!processes.confirmed) {
      throw new Error(
        'Codex turn ended but its managed command processes are still running.',
      );
    }
    return this.#updateStateFromTurn(turn, threadId);
  }

  async #hostProcessRows() {
    const { stdout } = await execFileAsync(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,pgid=,uid=,lstart=,command='],
      {
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        timeout: 2_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return parseMacProcessTable(stdout);
  }

  async #recordCommandItem(params) {
    const item = params?.item;
    if (
      !this.state ||
      (this.state.status !== 'inProgress' &&
        this.state.status !== 'stopping') ||
      params?.threadId !== this.state.threadId ||
      params?.turnId !== this.state.turnId ||
      item?.type !== 'commandExecution' ||
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 200
    ) {
      return false;
    }
    if (item.cwd !== undefined && item.cwd !== null) {
      try {
        const commandCwd = this.#authorizedCwd(item.cwd);
        if (!isPathWithin(commandCwd, this.state.cwd)) return false;
      } catch {
        return false;
      }
    }
    const ids = new Set(this.state.commandItemIds || []);
    const alreadyCaptured = (this.state.commandProcesses || []).some(
      (identity) => identity.itemId === item.id,
    );
    if (ids.has(item.id) && alreadyCaptured) return false;
    ids.add(item.id);
    let capturedProcesses = [];
    const appServerPid = this.client.processPid?.();
    const expectedUid =
      typeof process.getuid === 'function' ? process.getuid() : null;
    if (
      Number.isSafeInteger(appServerPid) &&
      Number.isSafeInteger(expectedUid) &&
      typeof item.command === 'string' &&
      item.command
    ) {
      try {
        const deadline = Date.now() + HOST_PROCESS_CAPTURE_TIMEOUT_MS;
        do {
          capturedProcesses = commandProcessIdentities(
            await this.#hostProcessRows(),
            appServerPid,
            item.command,
            expectedUid,
          ).map((identity) => ({ ...identity, itemId: item.id }));
          if (capturedProcesses.length > 0 || Date.now() >= deadline) break;
          await new Promise((resolve) =>
            setTimeout(resolve, HOST_PROCESS_CAPTURE_POLL_MS),
          );
        } while (true);
      } catch (error) {
        this.client.log?.('warn', 'codex_command_process_capture_failed', {
          errorKind: errorKind(error),
        });
      }
    }
    const processMap = new Map(
      (this.state.commandProcesses || []).map((identity) => [
        `${identity.pid}:${identity.startedAt}:${identity.commandHash}`,
        identity,
      ]),
    );
    for (const identity of capturedProcesses) {
      processMap.set(
        `${identity.pid}:${identity.startedAt}:${identity.commandHash}`,
        identity,
      );
    }
    this.#saveState({
      ...this.state,
      commandItemIds: [...ids].slice(-1_000),
      commandProcesses: [...processMap.values()].slice(-1_000),
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  #recordCommandCompleted(params) {
    const item = params?.item;
    if (
      !this.state ||
      params?.threadId !== this.state.threadId ||
      params?.turnId !== this.state.turnId ||
      item?.type !== 'commandExecution' ||
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 200
    ) {
      return false;
    }
    if (item.cwd !== undefined && item.cwd !== null) {
      try {
        const commandCwd = this.#authorizedCwd(item.cwd);
        if (!isPathWithin(commandCwd, this.state.cwd)) return false;
      } catch {
        return false;
      }
    }
    const commandIds = new Set(this.state.commandItemIds || []);
    const completedIds = new Set(this.state.completedCommandItemIds || []);
    if (commandIds.has(item.id) && completedIds.has(item.id)) return false;
    commandIds.add(item.id);
    completedIds.add(item.id);
    this.#saveState({
      ...this.state,
      commandItemIds: [...commandIds].slice(-1_000),
      completedCommandItemIds: [...completedIds].slice(-1_000),
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  #authorizedCwd(cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new Error('cwd must be an absolute project directory');
    }
    let resolved;
    let stat;
    try {
      resolved = fs.realpathSync(cwd);
      stat = fs.statSync(resolved);
    } catch {
      throw new Error('cwd must be an existing absolute project directory');
    }
    if (!stat.isDirectory()) throw new Error('cwd must be a directory');
    if (!this.allowedRoots.some((root) => isPathWithin(resolved, root))) {
      throw new Error(
        'This project is outside the locally authorized Codex Desktop roots.',
      );
    }
    return resolved;
  }

  async #stateDbThreads() {
    const threads = [];
    const seenCursors = new Set();
    let cursor = null;
    for (let page = 0; page < STATE_DB_MAX_PAGES; page++) {
      const result = await this.#request('thread/list', {
        cursor,
        limit: STATE_DB_PAGE_SIZE,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: false,
        useStateDbOnly: true,
      });
      if (!Array.isArray(result?.data)) {
        throw new Error(
          'Codex state database returned an invalid thread list.',
        );
      }
      threads.push(...result.data);
      const nextCursor = result.nextCursor ?? null;
      if (nextCursor === null) return threads;
      if (
        typeof nextCursor !== 'string' ||
        !nextCursor ||
        seenCursors.has(nextCursor)
      ) {
        throw new Error('Codex state database returned an invalid cursor.');
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error('Codex state database pagination limit was exceeded.');
  }

  async #backgroundTerminals(threadId) {
    const terminals = [];
    const seenCursors = new Set();
    let cursor = null;
    for (let page = 0; page < BACKGROUND_TERMINAL_MAX_PAGES; page++) {
      const result = await this.#request('thread/backgroundTerminals/list', {
        threadId,
        cursor,
        limit: BACKGROUND_TERMINAL_PAGE_SIZE,
      });
      if (!Array.isArray(result?.data)) {
        throw new Error('Codex returned an invalid background terminal list.');
      }
      terminals.push(...result.data);
      const nextCursor = result.nextCursor ?? null;
      if (nextCursor === null) return terminals;
      if (
        typeof nextCursor !== 'string' ||
        !nextCursor ||
        seenCursors.has(nextCursor)
      ) {
        throw new Error('Codex returned an invalid terminal cursor.');
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error('Codex terminal pagination limit was exceeded.');
  }

  async #captureTerminalBaseline(threadId) {
    const terminals = await this.#backgroundTerminals(threadId);
    const ids = terminals
      .map((terminal) => terminal?.itemId)
      .filter(
        (itemId) =>
          typeof itemId === 'string' &&
          itemId.length > 0 &&
          itemId.length <= 200,
      );
    return [...new Set(ids)].slice(-1_000);
  }

  #managedTerminalPredicate(state, includeNewSinceBaseline) {
    const tracked = new Set(state?.commandItemIds || []);
    const hasBaseline = Array.isArray(state?.terminalBaselineItemIds);
    const baseline = new Set(state?.terminalBaselineItemIds || []);
    return (terminal) => {
      const itemId = terminal?.itemId;
      return (
        typeof itemId === 'string' &&
        (tracked.has(itemId) ||
          (includeNewSinceBaseline && hasBaseline && !baseline.has(itemId)))
      );
    };
  }

  async #terminateManagedBackgroundTerminals(
    threadId,
    turnId,
    { includeNewSinceBaseline = false } = {},
  ) {
    if (
      !this.state ||
      this.state.threadId !== threadId ||
      this.state.turnId !== turnId
    ) {
      throw new Error(
        'Cannot clean processes for a turn that is not the managed task.',
      );
    }
    const isManaged = this.#managedTerminalPredicate(
      this.state,
      includeNewSinceBaseline,
    );
    const resolvedItemIds = new Set();
    const terminate = async (terminals) => {
      const managed = terminals.filter(isManaged);
      for (const terminal of managed) {
        if (
          typeof terminal?.itemId === 'string' &&
          terminal.itemId.length > 0 &&
          terminal.itemId.length <= 200
        ) {
          resolvedItemIds.add(terminal.itemId);
        }
      }
      const processIds = [
        ...new Set(
          managed
            .map((terminal) => terminal?.processId)
            .filter(
              (processId) =>
                typeof processId === 'string' &&
                processId.length > 0 &&
                processId.length <= 200,
            ),
        ),
      ];
      for (const processId of processIds) {
        await this.#request('thread/backgroundTerminals/terminate', {
          threadId,
          processId,
        });
      }
      return processIds.length;
    };

    let terminals = await this.#backgroundTerminals(threadId);
    let terminated = await terminate(terminals);
    const deadline = Date.now() + PROCESS_STOP_CONFIRM_TIMEOUT_MS;
    while (true) {
      terminals = await this.#backgroundTerminals(threadId);
      const remaining = terminals.filter(isManaged);
      if (remaining.length === 0) {
        const hostProcesses =
          await this.#terminateRecordedHostProcesses(resolvedItemIds);
        return {
          confirmed: hostProcesses.confirmed,
          terminated,
          hostTerminated: hostProcesses.terminated,
          unresolved: hostProcesses.unresolved,
        };
      }
      if (Date.now() >= deadline) {
        return { confirmed: false, terminated, remaining: remaining.length };
      }
      terminated += await terminate(remaining);
      await new Promise((resolve) => setTimeout(resolve, PROCESS_STOP_POLL_MS));
    }
  }

  #matchingRecordedHostProcesses(rows) {
    const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
    const trackedItems = new Set(this.state?.commandItemIds || []);
    const expectedUid =
      typeof process.getuid === 'function' ? process.getuid() : null;
    if (!Number.isSafeInteger(expectedUid)) return [];
    return (this.state?.commandProcesses || []).filter((identity) => {
      if (!trackedItems.has(identity.itemId)) return false;
      const row = rowsByPid.get(identity.pid);
      return Boolean(
        row &&
        row.pid === row.pgid &&
        row.pid === identity.pid &&
        row.pgid === identity.pgid &&
        row.uid === expectedUid &&
        row.uid === identity.uid &&
        row.startedAt === identity.startedAt &&
        sha256(row.command) === identity.commandHash,
      );
    });
  }

  async #terminateRecordedHostProcesses(resolvedItemIds = new Set()) {
    if (!Array.isArray(this.state?.commandProcesses)) {
      throw new Error(
        'Managed command process state is unavailable; refusing unsafe recovery.',
      );
    }
    const trackedItems = new Set(this.state.commandItemIds || []);
    const completedItems = new Set(this.state.completedCommandItemIds || []);
    const outstandingItems = new Set(
      [...trackedItems].filter(
        (itemId) => !completedItems.has(itemId) && !resolvedItemIds.has(itemId),
      ),
    );
    const currentInstanceId = this.client.serverInstanceId?.();
    const serverChanged =
      typeof currentInstanceId !== 'string' ||
      !currentInstanceId ||
      currentInstanceId !== this.state.appServerInstanceId;
    if (process.platform !== 'darwin') {
      return {
        confirmed: !serverChanged || outstandingItems.size === 0,
        terminated: 0,
        unresolved: serverChanged ? outstandingItems.size : 0,
      };
    }

    const beforeRows = await this.#hostProcessRows();
    const matching = this.#matchingRecordedHostProcesses(beforeRows).filter(
      (identity) => outstandingItems.has(identity.itemId),
    );
    const processGroups = [...new Set(matching.map((item) => item.pgid))];
    for (const pgid of processGroups) {
      try {
        process.kill(-pgid, 'SIGTERM');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    if (processGroups.length > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, HOST_PROCESS_STOP_GRACE_MS),
      );
    }
    for (const pgid of processGroups) {
      try {
        process.kill(-pgid, 0);
        process.kill(-pgid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESS_STOP_POLL_MS));
    const afterRows = await this.#hostProcessRows();
    const remainingGroups = new Set(
      afterRows
        .filter((row) => processGroups.includes(row.pgid))
        .map((row) => row.pgid),
    );
    let unresolved = 0;
    if (serverChanged) {
      const identitiesByItem = new Map();
      for (const identity of this.state.commandProcesses) {
        if (!trackedItems.has(identity.itemId)) continue;
        const identities = identitiesByItem.get(identity.itemId) || [];
        identities.push(identity);
        identitiesByItem.set(identity.itemId, identities);
      }
      for (const itemId of outstandingItems) {
        const identities = identitiesByItem.get(itemId) || [];
        if (
          identities.length === 0 ||
          identities.some((identity) =>
            afterRows.some((row) => row.pgid === identity.pgid),
          )
        ) {
          unresolved += 1;
        }
      }
    } else if (remainingGroups.size > 0) {
      unresolved = remainingGroups.size;
    }
    return {
      confirmed: unresolved === 0,
      terminated: processGroups.length - remainingGroups.size,
      unresolved,
    };
  }

  #threadFromSnapshot(threads, threadId) {
    return threads.find((thread) => thread?.id === threadId) || null;
  }

  #assertThreadCanResume(thread) {
    if (!thread) {
      throw new Error(
        'The requested Codex thread is not visible in the state database; refusing to load it.',
      );
    }
    if (thread.status?.type === 'active') {
      throw new Error(
        'That Codex Desktop thread already has an active turn; refusing to load or take it over.',
      );
    }
    if (thread.status?.type !== 'idle' && thread.status?.type !== 'notLoaded') {
      throw new Error(
        'That Codex Desktop thread is not known to be idle; refusing to resume it.',
      );
    }
    return thread;
  }

  async #assertNoDesktopTurnActive() {
    const threads = await this.#stateDbThreads();
    const active = threads.find((thread) => {
      if (thread?.status?.type !== 'active') return false;
      try {
        this.#authorizedCwd(thread.cwd);
        return true;
      } catch {
        return false;
      }
    });
    if (active) {
      throw new Error(
        'A Codex Desktop turn is already active; refusing to start, continue, or open another thread.',
      );
    }
    return threads;
  }

  async #refreshState() {
    if (this.stateLoadError) return this.state;
    if (
      !this.state ||
      (this.state.status !== 'inProgress' && this.state.status !== 'stopping')
    ) {
      return this.state;
    }
    if (!this.#ownsTurn(this.state.threadId, this.state.turnId)) {
      try {
        const threads = await this.#stateDbThreads();
        const thread = this.#threadFromSnapshot(threads, this.state.threadId);
        if (!thread || thread.status?.type === 'active') return this.state;
      } catch {
        return this.state;
      }
    }
    try {
      const result = await this.#request('thread/read', {
        threadId: this.state.threadId,
        includeTurns: true,
      });
      const turn = result?.thread?.turns?.find(
        (item) => item.id === this.state.turnId,
      );
      if (turn && TERMINAL_TURN_STATUSES.has(turn.status)) {
        await this.#finalizeTurn(turn, this.state.threadId);
      }
    } catch {
      // Keep the resumable state intact when Codex is temporarily unavailable.
    }
    return this.state;
  }

  async #assertNoActiveTurn() {
    await this.#refreshState();
    if (
      this.state?.status === 'inProgress' ||
      this.state?.status === 'stopping'
    ) {
      throw new Error(
        'A Skoobi-managed Codex turn is still running. Wait for it, steer it, or interrupt it first.',
      );
    }
  }

  #safeTurnParams(threadId, prompt, cwd) {
    return {
      threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      // Omit `environments`: app-server then uses its isolated local execution
      // environment. An explicit empty array disables shell/file tools entirely.
      // This bridge never registers an external exec-server environment.
      cwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      runtimeWorkspaceRoots: [cwd],
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        networkAccess: false,
        excludeSlashTmp: false,
        excludeTmpdirEnvVar: false,
      },
    };
  }

  #recordTurn({
    threadId,
    turnId,
    cwd,
    taskTitle,
    taskId,
    terminalBaselineItemIds,
    startRequestKey,
  }) {
    const now = new Date().toISOString();
    const continuingTask = Boolean(taskId && this.state?.taskId === taskId);
    const appServerInstanceId = this.client.serverInstanceId?.();
    if (
      typeof appServerInstanceId !== 'string' ||
      !appServerInstanceId ||
      appServerInstanceId.length > 200
    ) {
      throw new Error(
        'Codex app-server identity is unavailable; refusing to save an unrecoverable active task.',
      );
    }
    this.#saveState({
      ...(continuingTask ? this.state : {}),
      version: 1,
      taskId: taskId || randomUUID(),
      taskTitle: truncate(taskTitle || 'Codex task', 200),
      threadId,
      turnId,
      cwd,
      status: 'inProgress',
      startedAt: continuingTask ? this.state.startedAt : now,
      updatedAt: now,
      completedAt: null,
      stopRequestedAt: null,
      commandItemIds: [],
      completedCommandItemIds: [],
      commandProcesses: [],
      terminalBaselineItemIds: [...new Set(terminalBaselineItemIds || [])],
      appServerInstanceId,
      ...(startRequestKey ? { startRequestKey } : {}),
    });
    this.ownedTurns.add(this.#turnKey(threadId, turnId));
  }

  async status() {
    return this.#withMutation(
      async () => {
        await this.#refreshState();
        return {
          appServer: this.client.status(),
          task: this.state,
          stateError: this.stateLoadError,
          authorizedRoots: [...this.allowedRoots],
        };
      },
      { allowInvalidState: true },
    );
  }

  async recoverActiveTask() {
    return this.#withMutation(() => this.#recoverActiveTask());
  }

  async #recoverActiveTask() {
    if (!this.state) {
      return { action: 'none', task: this.state };
    }
    if (this.state.status === 'stopping') {
      const stopped = await this.#interrupt({});
      return {
        action: stopped.confirmed ? 'interrupted' : 'stopping',
        task: this.state,
      };
    }
    if (this.state.status !== 'inProgress') {
      return { action: 'none', task: this.state };
    }

    const stateThreads = await this.#stateDbThreads();
    const stateThread = this.#threadFromSnapshot(
      stateThreads,
      this.state.threadId,
    );
    if (!stateThread) {
      throw new Error(
        'The saved Codex thread is not visible in the state database.',
      );
    }
    const existing = await this.#request('thread/read', {
      threadId: this.state.threadId,
      includeTurns: true,
    });
    const savedTurn = existing?.thread?.turns?.find(
      (item) => item.id === this.state.turnId,
    );
    if (stateThread.status?.type === 'active') {
      if (savedTurn?.status !== 'inProgress') {
        throw new Error(
          'The active Codex turn is not the saved Skoobi-managed turn.',
        );
      }
      return { action: 'already_running', task: this.state };
    }
    this.#assertThreadCanResume(stateThread);
    this.#assertThreadCanResume(existing?.thread);

    const previousState = this.state;
    const safeCwd = this.#authorizedCwd(previousState.cwd);
    await this.#request('thread/resume', {
      threadId: previousState.threadId,
      cwd: safeCwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      runtimeWorkspaceRoots: [safeCwd],
      config: LOCAL_ONLY_THREAD_CONFIG,
      developerInstructions: SAFE_DEVELOPER_INSTRUCTIONS,
      excludeTurns: true,
    });
    const cleanedPreviousTurn = await this.#terminateManagedBackgroundTerminals(
      previousState.threadId,
      previousState.turnId,
      { includeNewSinceBaseline: true },
    );
    if (!cleanedPreviousTurn.confirmed) {
      throw new Error(
        'The previous managed command processes are still running; refusing recovery.',
      );
    }
    if (savedTurn?.status === 'completed') {
      this.#updateStateFromTurn(savedTurn, previousState.threadId);
      return { action: 'completed', task: this.state };
    }
    const terminalBaselineItemIds = await this.#captureTerminalBaseline(
      previousState.threadId,
    );
    const turn = await this.#request(
      'turn/start',
      this.#safeTurnParams(previousState.threadId, RECOVERY_PROMPT, safeCwd),
    );
    const turnId = turn?.turn?.id;
    if (!turnId) throw new Error('Codex did not return a recovery turn id');
    this.#recordTurn({
      threadId: previousState.threadId,
      turnId,
      cwd: safeCwd,
      taskTitle: previousState.taskTitle,
      taskId: previousState.taskId,
      terminalBaselineItemIds,
    });
    this.#saveState({
      ...this.state,
      recoveryCount: (previousState.recoveryCount || 0) + 1,
      lastRecoveryAt: new Date().toISOString(),
    });
    return { action: 'resumed', task: this.state };
  }

  async list(options = {}) {
    const safeCwd = options.cwd ? this.#authorizedCwd(options.cwd) : null;
    const result = await this.#request('thread/list', {
      cursor: options.cursor || null,
      limit: Math.min(Math.max(Number(options.limit) || 20, 1), 100),
      searchTerm: options.searchTerm || null,
      cwd: safeCwd,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
    return {
      threads: (Array.isArray(result?.data) ? result.data : [])
        .filter((thread) => {
          try {
            this.#authorizedCwd(thread?.cwd);
            return true;
          } catch {
            return false;
          }
        })
        .map((thread) => summarizeThread(thread, 0)),
      nextCursor: result?.nextCursor ?? null,
    };
  }

  async read(threadId) {
    if (!threadId) throw new Error('threadId is required');
    const stateDbSnapshot = this.#threadFromSnapshot(
      await this.#stateDbThreads(),
      threadId,
    );
    // Codex can return thread/start before its state-database projection is
    // visible. The exact Skoobi-managed thread is still safe to read during
    // that short window: its id and authorized cwd came from the just-saved,
    // private controller state, and thread/read below rechecks the cwd.
    const snapshot =
      stateDbSnapshot ||
      (this.state?.threadId === threadId
        ? { id: threadId, cwd: this.state.cwd }
        : null);
    if (!snapshot) {
      throw new Error(
        'The requested Codex thread is not visible in the state database.',
      );
    }
    const expectedCwd = this.#authorizedCwd(snapshot.cwd);
    const result = await this.#request('thread/read', {
      threadId,
      includeTurns: true,
    });
    if (this.#authorizedCwd(result?.thread?.cwd) !== expectedCwd) {
      throw new Error(
        'The Codex thread working directory changed while it was being checked.',
      );
    }
    return { thread: summarizeThread(result?.thread) };
  }

  async start({ prompt, cwd, taskTitle, requestKey }) {
    return this.#withMutation(() =>
      this.#start({ prompt, cwd, taskTitle, requestKey }),
    );
  }

  async #start({ prompt, cwd, taskTitle, requestKey }) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('prompt is required');
    }
    if (
      requestKey !== undefined &&
      (typeof requestKey !== 'string' || !/^[0-9a-f]{64}$/.test(requestKey))
    ) {
      throw new Error('invalid start request key');
    }
    const safeCwd = this.#authorizedCwd(cwd);
    if (requestKey && this.state?.startRequestKey === requestKey) {
      return { task: this.state, replayed: true };
    }
    await this.#assertNoActiveTurn();
    await this.#assertNoDesktopTurnActive();
    const started = await this.#request('thread/start', {
      cwd: safeCwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      runtimeWorkspaceRoots: [safeCwd],
      config: LOCAL_ONLY_THREAD_CONFIG,
      developerInstructions: SAFE_DEVELOPER_INSTRUCTIONS,
      dynamicTools: [],
      ephemeral: false,
    });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error('Codex did not return a thread id');
    this.#assertThreadCanResume(started.thread);
    await this.#assertNoDesktopTurnActive();
    const terminalBaselineItemIds =
      await this.#captureTerminalBaseline(threadId);
    const turn = await this.#request(
      'turn/start',
      this.#safeTurnParams(threadId, prompt, safeCwd),
    );
    const turnId = turn?.turn?.id;
    if (!turnId) throw new Error('Codex did not return a turn id');
    this.#recordTurn({
      threadId,
      turnId,
      cwd: safeCwd,
      taskTitle,
      terminalBaselineItemIds,
      startRequestKey: requestKey,
    });
    return { task: this.state, thread: summarizeThread(started.thread, 0) };
  }

  async continueThread({ threadId, prompt, taskTitle }) {
    return this.#withMutation(() =>
      this.#continueThread({ threadId, prompt, taskTitle }),
    );
  }

  async #continueThread({ threadId, prompt, taskTitle }) {
    if (!threadId) throw new Error('threadId is required');
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('prompt is required');
    }
    await this.#assertNoActiveTurn();
    let stateThreads = await this.#assertNoDesktopTurnActive();
    let existing = this.#assertThreadCanResume(
      this.#threadFromSnapshot(stateThreads, threadId),
    );
    const safeCwd = this.#authorizedCwd(existing.cwd);
    stateThreads = await this.#assertNoDesktopTurnActive();
    existing = this.#assertThreadCanResume(
      this.#threadFromSnapshot(stateThreads, threadId),
    );
    if (this.#authorizedCwd(existing.cwd) !== safeCwd) {
      throw new Error(
        'The Codex thread working directory changed while it was being checked.',
      );
    }
    const resumed = await this.#request('thread/resume', {
      threadId,
      cwd: safeCwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      runtimeWorkspaceRoots: [safeCwd],
      config: LOCAL_ONLY_THREAD_CONFIG,
      developerInstructions: SAFE_DEVELOPER_INSTRUCTIONS,
      excludeTurns: true,
    });
    this.#assertThreadCanResume(resumed?.thread);
    await this.#assertNoDesktopTurnActive();
    const sameTask = this.state?.threadId === threadId;
    if (sameTask && TERMINAL_TURN_STATUSES.has(this.state.status)) {
      const cleanedPreviousTurn =
        await this.#terminateManagedBackgroundTerminals(
          this.state.threadId,
          this.state.turnId,
          { includeNewSinceBaseline: true },
        );
      if (!cleanedPreviousTurn.confirmed) {
        throw new Error(
          'The previous managed command processes are still running; refusing a new turn.',
        );
      }
    }
    const terminalBaselineItemIds =
      await this.#captureTerminalBaseline(threadId);
    const turn = await this.#request(
      'turn/start',
      this.#safeTurnParams(threadId, prompt, safeCwd),
    );
    const turnId = turn?.turn?.id;
    if (!turnId) throw new Error('Codex did not return a turn id');
    this.#recordTurn({
      threadId,
      turnId,
      cwd: safeCwd,
      taskTitle: taskTitle || this.state?.taskTitle,
      taskId: sameTask ? this.state.taskId : undefined,
      terminalBaselineItemIds,
    });
    return { task: this.state };
  }

  async steer({ threadId, turnId, prompt }) {
    return this.#withMutation(() => this.#steer({ threadId, turnId, prompt }));
  }

  async #steer({ threadId, turnId, prompt }) {
    if (!threadId || !turnId)
      throw new Error('threadId and turnId are required');
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('prompt is required');
    }
    await this.#refreshState();
    if (
      this.state?.status !== 'inProgress' ||
      this.state.threadId !== threadId ||
      this.state.turnId !== turnId
    ) {
      throw new Error('That turn is not the active Skoobi-managed task.');
    }
    if (!this.#ownsTurn(threadId, turnId)) {
      throw new Error(
        'This app-server does not own the active turn; wait for it to finish instead of taking it over.',
      );
    }
    await this.#request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    });
    return { ok: true, task: this.state };
  }

  async #waitForUnownedTurn(threadId, turnId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const threads = await this.#stateDbThreads();
        const thread = this.#threadFromSnapshot(threads, threadId);
        if (thread && thread.status?.type !== 'active') {
          const result = await this.#request('thread/read', {
            threadId,
            includeTurns: true,
          });
          const turn = result?.thread?.turns?.find(
            (item) =>
              item.id === turnId && TERMINAL_TURN_STATUSES.has(item.status),
          );
          if (turn) return turn;
        }
      } catch {
        // A separate app-server may still be committing rollout metadata.
        // Keep polling the state DB without attaching to its active turn.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(UNOWNED_TURN_POLL_MS, remaining)),
      );
    }
    return null;
  }

  async wait({ threadId, turnId, timeoutMs }) {
    const snapshot = await this.#withMutation(async () => {
      await this.#refreshState();
      const activeThread = threadId || this.state?.threadId;
      const activeTurn = turnId || this.state?.turnId;
      if (!activeThread || !activeTurn) {
        throw new Error('No active turn to wait for');
      }
      if (
        this.state?.threadId !== activeThread ||
        this.state?.turnId !== activeTurn
      ) {
        throw new Error('That turn is not the active Skoobi-managed task.');
      }
      if (TERMINAL_TURN_STATUSES.has(this.state.status)) {
        return {
          threadId: activeThread,
          turnId: activeTurn,
          terminal: true,
          task: this.state,
        };
      }
      if (
        this.state.status !== 'inProgress' &&
        this.state.status !== 'stopping'
      ) {
        throw new Error('That turn is not the active Skoobi-managed task.');
      }
      return {
        threadId: activeThread,
        turnId: activeTurn,
        owned: this.#ownsTurn(activeThread, activeTurn),
        terminal: false,
      };
    });
    const activeThread = snapshot.threadId;
    const activeTurn = snapshot.turnId;
    if (snapshot.terminal) {
      let terminalTurn = null;
      try {
        const refreshed = await this.#request('thread/read', {
          threadId: activeThread,
          includeTurns: true,
        });
        terminalTurn = refreshed?.thread?.turns?.find(
          (item) =>
            item.id === activeTurn && TERMINAL_TURN_STATUSES.has(item.status),
        );
      } catch {
        // Durable task state is enough to make a late/repeated wait
        // idempotent while app-server history is temporarily unavailable.
      }
      terminalTurn ||= {
        id: activeTurn,
        status: snapshot.task.status,
        items: [],
      };
      return {
        timedOut: false,
        task: snapshot.task,
        turn: summarizeTurn(terminalTurn),
      };
    }
    const boundedTimeout = Math.min(
      Math.max(Number(timeoutMs) || WAIT_MAX_TIMEOUT_MS, 250),
      WAIT_MAX_TIMEOUT_MS,
    );
    let turn = snapshot.owned
      ? await this.client.waitForTurn(activeThread, activeTurn, boundedTimeout)
      : await this.#waitForUnownedTurn(
          activeThread,
          activeTurn,
          boundedTimeout,
        );
    if (turn) {
      try {
        const refreshed = await this.#request('thread/read', {
          threadId: activeThread,
          includeTurns: true,
        });
        const completeTurn = refreshed?.thread?.turns?.find(
          (item) =>
            item.id === activeTurn && TERMINAL_TURN_STATUSES.has(item.status),
        );
        if (completeTurn) turn = completeTurn;
      } catch {
        // The completion notification remains authoritative if history refresh
        // is temporarily unavailable.
      }
    }
    const task = await this.#withMutation(async () => {
      if (turn) await this.#finalizeTurn(turn, activeThread);
      return this.state;
    });
    return {
      timedOut: !turn,
      task,
      turn: turn ? summarizeTurn(turn) : null,
    };
  }

  async interrupt({ threadId, turnId }) {
    return this.#withMutation(() => this.#interrupt({ threadId, turnId }));
  }

  async #interrupt({ threadId, turnId }) {
    await this.#refreshState();
    const managedTaskActive =
      this.state?.status === 'inProgress' || this.state?.status === 'stopping';
    if (!managedTaskActive) {
      if (
        (threadId && threadId !== this.state?.threadId) ||
        (turnId && turnId !== this.state?.turnId)
      ) {
        throw new Error('That turn is not the active Skoobi-managed task.');
      }
      let activeThreads;
      try {
        activeThreads = (await this.#stateDbThreads()).filter(
          (thread) => thread?.status?.type === 'active',
        );
      } catch {
        return {
          ok: true,
          confirmed: false,
          inspectionFailed: true,
          task: this.state,
        };
      }
      if (activeThreads.length > 0) {
        let authorizedActiveThreadCount = 0;
        for (const thread of activeThreads) {
          try {
            this.#authorizedCwd(thread?.cwd);
            authorizedActiveThreadCount += 1;
          } catch {
            // Do not expose foreign thread paths or metadata to the caller.
          }
        }
        return {
          ok: true,
          confirmed: false,
          unmanagedActive: true,
          authorizedActiveThreadCount,
          task: this.state,
        };
      }
      if (this.state && TERMINAL_TURN_STATUSES.has(this.state.status)) {
        return {
          ok: true,
          alreadyStopped: true,
          confirmed: true,
          task: this.state,
        };
      }
      return {
        ok: true,
        confirmed: false,
        noManagedTask: true,
        task: this.state,
      };
    }

    const activeThread = threadId || this.state?.threadId;
    const activeTurn = turnId || this.state?.turnId;
    if (!activeThread || !activeTurn)
      throw new Error('No active turn to interrupt');
    if (
      (this.state?.status !== 'inProgress' &&
        this.state?.status !== 'stopping') ||
      this.state.threadId !== activeThread ||
      this.state.turnId !== activeTurn
    ) {
      throw new Error('That turn is not the active Skoobi-managed task.');
    }
    if (this.state.status !== 'stopping') {
      const now = new Date().toISOString();
      this.#saveState({
        ...this.state,
        status: 'stopping',
        stopRequestedAt: now,
        updatedAt: now,
        completedAt: null,
      });
    }
    if (!this.#ownsTurn(activeThread, activeTurn)) {
      const attached = await this.#attachManagedTurnForInterrupt(
        activeThread,
        activeTurn,
      );
      if (!attached) {
        return {
          ok: true,
          confirmed: TERMINAL_TURN_STATUSES.has(this.state?.status),
          task: this.state,
        };
      }
    }
    await this.#request('turn/interrupt', {
      threadId: activeThread,
      turnId: activeTurn,
    });
    const processes = await this.#terminateManagedBackgroundTerminals(
      activeThread,
      activeTurn,
      { includeNewSinceBaseline: true },
    );
    if (!processes.confirmed) {
      return {
        ok: true,
        confirmed: false,
        task: this.state,
        processes,
      };
    }
    let terminalTurn = await this.client.waitForTurn(
      activeThread,
      activeTurn,
      INTERRUPT_CONFIRM_TIMEOUT_MS,
    );
    if (!terminalTurn || !TERMINAL_TURN_STATUSES.has(terminalTurn.status)) {
      try {
        const refreshed = await this.#request('thread/read', {
          threadId: activeThread,
          includeTurns: true,
        });
        terminalTurn = refreshed?.thread?.turns?.find(
          (item) =>
            item.id === activeTurn && TERMINAL_TURN_STATUSES.has(item.status),
        );
      } catch {
        terminalTurn = null;
      }
    }
    if (terminalTurn) this.#updateStateFromTurn(terminalTurn, activeThread);
    return {
      ok: true,
      confirmed: Boolean(terminalTurn) && processes.confirmed,
      task: this.state,
      turn: terminalTurn ? summarizeTurn(terminalTurn) : null,
      processes,
    };
  }

  async #attachManagedTurnForInterrupt(threadId, turnId) {
    const threads = await this.#stateDbThreads();
    const snapshot = this.#threadFromSnapshot(threads, threadId);
    if (!snapshot) {
      throw new Error(
        'The saved Codex thread is not visible; stop remains requested and automatic recovery is disabled.',
      );
    }
    let existing;
    try {
      existing = await this.#request('thread/read', {
        threadId,
        includeTurns: true,
      });
    } catch {
      // Keep the durable stopping state. It must never be auto-resumed.
      return false;
    }
    const savedTurn = existing?.thread?.turns?.find(
      (item) => item.id === turnId,
    );
    if (TERMINAL_TURN_STATUSES.has(savedTurn?.status)) {
      if (snapshot.status?.type === 'active') {
        // A newer manual turn is active in the same thread. Do not join it or
        // touch any terminal until that unrelated turn becomes idle.
        return false;
      }
      this.#assertThreadCanResume(snapshot);
      const safeCwd = this.#authorizedCwd(this.state.cwd);
      const resumed = await this.#request('thread/resume', {
        threadId,
        cwd: safeCwd,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        runtimeWorkspaceRoots: [safeCwd],
        config: LOCAL_ONLY_THREAD_CONFIG,
        developerInstructions: SAFE_DEVELOPER_INSTRUCTIONS,
        excludeTurns: true,
      });
      if (
        resumed?.thread?.id !== threadId ||
        this.#authorizedCwd(resumed?.thread?.cwd) !== safeCwd
      ) {
        throw new Error(
          'Codex loaded a different thread; stop remains requested.',
        );
      }
      const processes = await this.#terminateManagedBackgroundTerminals(
        threadId,
        turnId,
        { includeNewSinceBaseline: true },
      );
      if (!processes.confirmed) return false;
      this.#updateStateFromTurn(savedTurn, threadId);
      return false;
    }
    if (snapshot.status?.type !== 'active') {
      return false;
    }
    if (savedTurn?.status !== 'inProgress') {
      throw new Error(
        'The active Codex turn is not the saved Skoobi-managed turn; stop remains requested.',
      );
    }

    const safeCwd = this.#authorizedCwd(this.state.cwd);
    const resumed = await this.#request('thread/resume', {
      threadId,
      cwd: safeCwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      runtimeWorkspaceRoots: [safeCwd],
      config: LOCAL_ONLY_THREAD_CONFIG,
      developerInstructions: SAFE_DEVELOPER_INSTRUCTIONS,
      excludeTurns: false,
    });
    const resumedTurn = resumed?.thread?.turns?.find(
      (item) => item.id === turnId,
    );
    if (
      resumed?.thread?.id !== threadId ||
      this.#authorizedCwd(resumed?.thread?.cwd) !== safeCwd ||
      resumedTurn?.status !== 'inProgress'
    ) {
      throw new Error(
        'Codex did not rejoin the saved active turn; refusing to interrupt.',
      );
    }
    this.ownedTurns.add(this.#turnKey(threadId, turnId));
    return true;
  }

  async open(threadId) {
    return this.#withMutation(() => this.#open(threadId));
  }

  async #open(threadId) {
    if (!threadId) throw new Error('threadId is required');
    const stateDbSnapshot = this.#threadFromSnapshot(
      await this.#stateDbThreads(),
      threadId,
    );
    // See read(): the freshly managed thread can briefly lag in the Codex
    // state database. Never extend this fallback to an arbitrary thread id.
    const snapshot =
      stateDbSnapshot ||
      (this.state?.threadId === threadId
        ? { id: threadId, cwd: this.state.cwd }
        : null);
    if (!snapshot) {
      throw new Error(
        'The requested Codex thread is not visible in the state database.',
      );
    }
    const expectedCwd = this.#authorizedCwd(snapshot.cwd);
    const result = await this.#request('thread/read', {
      threadId,
      includeTurns: false,
    });
    if (this.#authorizedCwd(result?.thread?.cwd) !== expectedCwd) {
      throw new Error(
        'The Codex thread working directory changed while it was being checked.',
      );
    }
    await this.openThread(threadId);
    return { ok: true, threadId };
  }

  stop() {
    this.client.stop();
  }
}
