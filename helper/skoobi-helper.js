#!/usr/bin/env node
/**
 * Skoobi Helper Daemon
 * Runs OUTSIDE the sandbox with full user permissions.
 * Lets the sandboxed bot drive the Mac via localhost HTTP.
 *
 * Bound to 127.0.0.1 only. Every request MUST include a matching
 * X-Helper-Secret header whose value equals $HELPER_SECRET.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CodexAppServerClient,
  CodexDesktopBridge,
  codexRequestLogFields,
  defaultCodexDesktopStateFile,
} from './codex-desktop-bridge.js';
import {
  CodexControlRunRevocations,
  codexControlRequestError,
  codexDesktopErrorResponse,
  codexGuiAuthorizationRequired,
  codexGuiEndpointNeedsFrontmostCheck,
  isValidCodexControlRunId,
  parseHelperRequestUrl,
  safeHelperRequestLogFields,
  secureScreenshotDirectory,
  secureScreenshotFile,
} from './skoobi-helper-policy.js';

const execFileAsync = promisify(execFile);

// Finding #36: constant-time comparison of the caller-supplied X-Helper-Secret
// against the expected per-process shared secret. Mirrors
// src/orchestrator/credential-proxy.ts secretMatches. Returns false (never
// throws) when the value is missing, is not a single string (e.g. a duplicated
// header arriving as an array), or lengths differ — length is compared first so
// timingSafeEqual only ever runs on equal-length Buffers, avoiding the per-byte
// early-exit timing leak of a plain `!==` comparison.
function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  if (typeof expected !== 'string' || expected.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
const LOG_FILE = path.join(PROJECT_ROOT, 'logs', 'skoobi-helper.log');
const SCREENSHOT_DIR = '/tmp/skoobi-screenshots';

const CLICLICK = '/opt/homebrew/bin/cliclick';
const SCREENCAPTURE = '/usr/sbin/screencapture';
const OPEN_BIN = '/usr/bin/open';
const OSASCRIPT = '/usr/bin/osascript';

function loadEnv() {
  const env = {};
  try {
    const raw = fs.readFileSync(ENV_FILE, 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      env[m[1]] = v;
    }
  } catch (err) {
    console.error('Failed to read .env:', err.message);
  }
  return env;
}

const env = loadEnv();
const PORT = Number(env.HELPER_PORT || process.env.HELPER_PORT || '3200');
const SECRET = env.HELPER_SECRET || process.env.HELPER_SECRET;
const CODEX_BIN =
  env.CODEX_DESKTOP_BIN || process.env.CODEX_DESKTOP_BIN || 'codex';
const CODEX_HOME =
  env.CODEX_DESKTOP_HOME ||
  process.env.CODEX_DESKTOP_HOME ||
  path.join(os.homedir(), '.codex');
const CODEX_OWNER_CHAT_JID =
  env.CODEX_DESKTOP_OWNER_CHAT_JID ||
  process.env.CODEX_DESKTOP_OWNER_CHAT_JID ||
  '';
const CODEX_TASK_STATE_FILE =
  env.CODEX_DESKTOP_STATE_FILE ||
  process.env.CODEX_DESKTOP_STATE_FILE ||
  defaultCodexDesktopStateFile();
const CODEX_CONTROL_RUN_ID_HEADER = 'x-skoobi-codex-control-run-id';
const CODEX_REVOKE_CONTROL_RUN_ID_HEADER =
  'x-skoobi-revoke-codex-control-run-id';

function configuredCodexRoots() {
  const configured =
    env.CODEX_DESKTOP_ALLOWED_ROOTS ||
    process.env.CODEX_DESKTOP_ALLOWED_ROOTS ||
    '';
  if (!configured) return [];
  const roots = configured
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const existing = roots
    .map((root) => path.resolve(root))
    .filter((root) => {
      try {
        return fs.statSync(root).isDirectory();
      } catch {
        return false;
      }
    });
  if (existing.length === 0) {
    throw new Error('CODEX_DESKTOP_ALLOWED_ROOTS has no existing directories');
  }
  return existing;
}

if (!SECRET) {
  console.error('HELPER_SECRET missing — refusing to start.');
  process.exit(2);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  console.error('HELPER_PORT must be an integer between 1 and 65535.');
  process.exit(2);
}

secureScreenshotDirectory(SCREENSHOT_DIR);
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
if (fs.existsSync(LOG_FILE)) {
  const logStat = fs.lstatSync(LOG_FILE);
  if (
    logStat.isSymbolicLink() ||
    !logStat.isFile() ||
    logStat.nlink !== 1 ||
    (typeof process.getuid === 'function' && logStat.uid !== process.getuid())
  ) {
    throw new Error('helper log file is unsafe');
  }
  fs.chmodSync(LOG_FILE, 0o600);
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a', mode: 0o600 });
function log(level, msg, extra) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(extra || {}),
  });
  logStream.write(line + '\n');
  if (level === 'error' || level === 'warn') console.error(line);
}

const screenshotCleanupTimer = setInterval(() => {
  try {
    const result = secureScreenshotDirectory(SCREENSHOT_DIR);
    if (result.deleted > 0) {
      log('info', 'screenshots_cleaned', { deleted: result.deleted });
    }
  } catch (error) {
    log('warn', 'screenshot_cleanup_failed', {
      error_type: error instanceof Error ? error.name : typeof error,
    });
  }
}, 5 * 60 * 1000);
screenshotCleanupTimer.unref();

const codexAppServer = new CodexAppServerClient({
  codexBin: CODEX_BIN,
  codexHome: CODEX_HOME,
  log,
});
const codexDesktop = new CodexDesktopBridge({
  client: codexAppServer,
  stateFile: CODEX_TASK_STATE_FILE,
  allowedRoots: configuredCodexRoots(),
  openThread: async (threadId) => {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(threadId)) {
      throw new Error('invalid Codex thread id');
    }
    await execFileAsync(OPEN_BIN, [`codex://threads/${threadId}`]);
  },
});
const codexControlRunRevocations = new CodexControlRunRevocations(
  `${CODEX_TASK_STATE_FILE}.revoked-runs.json`,
);

const CODEX_RECOVERY_RETRY_MS = [1_000, 5_000, 15_000, 60_000];
const CODEX_RECOVERY_MONITOR_MS = 15_000;
let codexRecoveryTimer = null;
let codexRecoveryInFlight = false;
let codexRecoveryStopped = false;

function scheduleCodexRecovery(attempt, delayMs) {
  if (codexRecoveryStopped || codexRecoveryTimer) return;
  codexRecoveryTimer = setTimeout(() => {
    codexRecoveryTimer = null;
    recoverCodexTask(attempt);
  }, delayMs);
  codexRecoveryTimer.unref();
}

function recoverCodexTask(attempt = 0) {
  if (codexRecoveryStopped || codexRecoveryInFlight) return;
  codexRecoveryInFlight = true;
  void codexDesktop
    .recoverActiveTask()
    .then((result) => {
      if (result.action !== 'none') {
        log('info', 'codex_task_recovery', { action: result.action });
      }
      if (
        result.action === 'already_running' ||
        result.action === 'resumed' ||
        result.action === 'stopping'
      ) {
        scheduleCodexRecovery(0, CODEX_RECOVERY_MONITOR_MS);
      }
    })
    .catch((error) => {
      if (attempt === 0 || attempt % 10 === 0) {
        log('warn', 'codex_task_recovery_retry', {
          error_type: error instanceof Error ? error.name : typeof error,
          attempt: attempt + 1,
        });
      }
      const delay =
        CODEX_RECOVERY_RETRY_MS[
          Math.min(attempt, CODEX_RECOVERY_RETRY_MS.length - 1)
        ];
      scheduleCodexRecovery(attempt + 1, delay);
    })
    .finally(() => {
      codexRecoveryInFlight = false;
    });
}

// ---------------------------------------------------------------------------
// Rate limiter — sliding 1s window, 30 req/s per endpoint
// ---------------------------------------------------------------------------

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 1000;
const buckets = new Map(); // endpoint -> array of timestamps
function rateLimit(endpoint) {
  const now = Date.now();
  const arr = buckets.get(endpoint) || [];
  const fresh = arr.filter((t) => now - t < RATE_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT) {
    buckets.set(endpoint, fresh);
    return false;
  }
  fresh.push(now);
  buckets.set(endpoint, fresh);
  return true;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf-8');
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Key mapping for cliclick kp:
// ---------------------------------------------------------------------------

const CLICLICK_KEYS = new Set([
  'arrow-down', 'arrow-left', 'arrow-right', 'arrow-up',
  'brightness-down', 'brightness-up',
  'delete', 'end', 'enter', 'esc', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6',
  'f7', 'f8', 'f9', 'f10', 'f11', 'f12', 'f13', 'f14', 'f15', 'f16',
  'fwd-delete', 'home', 'keys-light-down', 'keys-light-toggle', 'keys-light-up',
  'mute', 'num-0', 'num-1', 'num-2', 'num-3', 'num-4', 'num-5', 'num-6',
  'num-7', 'num-8', 'num-9', 'num-clear', 'num-divide', 'num-enter',
  'num-equals', 'num-minus', 'num-multiply', 'num-plus',
  'page-down', 'page-up', 'play-next', 'play-pause', 'play-previous',
  'return', 'space', 'tab', 'volume-down', 'volume-up',
]);

const KEY_ALIASES = {
  enter: 'return',
  escape: 'esc',
  up: 'arrow-up', down: 'arrow-down', left: 'arrow-left', right: 'arrow-right',
  backspace: 'delete',
  del: 'fwd-delete',
  pgup: 'page-up', pgdn: 'page-down',
};

const MOD_TO_APPLESCRIPT = {
  cmd: 'command down', command: 'command down',
  ctrl: 'control down', control: 'control down',
  alt: 'option down', option: 'option down', opt: 'option down',
  shift: 'shift down',
};

// AppleScript key-code table for common non-character keys used in chords.
const APPLESCRIPT_KEYCODES = {
  space: 49, return: 36, enter: 76, tab: 48, esc: 53, escape: 53,
  delete: 51, backspace: 51, 'fwd-delete': 117,
  'arrow-up': 126, up: 126, 'arrow-down': 125, down: 125,
  'arrow-left': 123, left: 123, 'arrow-right': 124, right: 124,
  home: 115, end: 119, 'page-up': 116, 'page-down': 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
};

function splitKeys(s) {
  return String(s).toLowerCase().split('+').map((k) => k.trim()).filter(Boolean);
}

async function pressKey(keys) {
  const parts = splitKeys(keys);
  const mods = [];
  const nonMods = [];
  for (const p of parts) {
    if (MOD_TO_APPLESCRIPT[p]) mods.push(MOD_TO_APPLESCRIPT[p]);
    else nonMods.push(KEY_ALIASES[p] || p);
  }

  // No modifiers — use cliclick if we know the key, else fall back to osascript keystroke
  if (mods.length === 0 && nonMods.length === 1) {
    const k = nonMods[0];
    if (CLICLICK_KEYS.has(k)) {
      await execFileAsync(CLICLICK, [`kp:${k}`]);
      return;
    }
    if (k.length === 1) {
      const script = `tell application "System Events" to keystroke ${JSON.stringify(k)}`;
      await execFileAsync(OSASCRIPT, ['-e', script]);
      return;
    }
  }

  // Modifiers — build an AppleScript. Prefer key code for named keys, keystroke for single chars.
  if (nonMods.length !== 1) {
    throw new Error(`press expects exactly one non-modifier key (got ${JSON.stringify(nonMods)})`);
  }
  const target = nonMods[0];
  const modClause = mods.length ? ` using {${mods.join(', ')}}` : '';
  let body;
  if (APPLESCRIPT_KEYCODES[target] !== undefined) {
    body = `key code ${APPLESCRIPT_KEYCODES[target]}${modClause}`;
  } else if (target.length === 1) {
    body = `keystroke ${JSON.stringify(target)}${modClause}`;
  } else {
    throw new Error(`unsupported key with modifiers: "${target}"`);
  }
  const script = `tell application "System Events" to ${body}`;
  await execFileAsync(OSASCRIPT, ['-e', script]);
}

// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------

async function handleScreenshot() {
  secureScreenshotDirectory(SCREENSHOT_DIR);
  const file = path.join(SCREENSHOT_DIR, `${Date.now()}-${randomUUID()}.png`);
  try {
    await execFileAsync(SCREENCAPTURE, ['-x', file]);
    const bytes = secureScreenshotFile(file, SCREENSHOT_DIR);
    secureScreenshotDirectory(SCREENSHOT_DIR);
    return { path: file, bytes };
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  }
}

function requireCoords(body) {
  const x = Number(body?.x);
  const y = Number(body?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('x and y must be numbers');
  }
  return { x: Math.round(x), y: Math.round(y) };
}

async function handleClick(body) {
  const { x, y } = requireCoords(body);
  const button = body?.button || 'left';
  const double = Boolean(body?.double);
  if (button === 'right') {
    const script = `tell application "System Events" to tell (first process whose frontmost is true) to perform action "AXShowMenu" of (first UI element whose position is {${x}, ${y}})`;
    try {
      await execFileAsync(OSASCRIPT, ['-e', script]);
    } catch {
      // Fallback: move then click — right-click via cliclick rc
      await execFileAsync(CLICLICK, [`m:${x},${y}`, `rc:${x},${y}`]);
    }
    return { ok: true, button, x, y };
  }
  const cmd = double ? `dc:${x},${y}` : `c:${x},${y}`;
  await execFileAsync(CLICLICK, [cmd]);
  return { ok: true, button, double, x, y };
}

async function handleType(body) {
  const text = String(body?.text ?? '');
  if (!text) throw new Error('text is required');
  // Layout-agnostic unicode typing via clipboard paste.
  // Previous attempts:
  //   - cliclick t: → fails on non-Latin layouts (maps ASCII to wrong keycodes)
  //   - pbcopy stdin → mangles UTF-8 under LaunchAgent (no LANG set)
  //   - keystroke "v" using command down → on Russian layout 'v' → 'м', fails
  // Winning combo: osascript sets clipboard (unicode-safe), then key code 9
  // (= physical V key, layout-independent) + command down.
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await execFileAsync('/usr/bin/osascript', ['-e', `set the clipboard to "${escaped}"`]);
  await new Promise((r) => setTimeout(r, 80));
  await execFileAsync('/usr/bin/osascript', [
    '-e',
    'tell application "System Events" to key code 9 using {command down}',
  ]);
  return { ok: true, length: text.length };
}

async function handleKey(body) {
  const keys = String(body?.keys ?? '');
  if (!keys) throw new Error('keys is required');
  await pressKey(keys);
  return { ok: true, keys };
}

async function handleOpenApp(body) {
  const name = String(body?.name ?? '').trim();
  if (!name) throw new Error('name is required');
  await execFileAsync(OPEN_BIN, ['-a', name]);
  return { ok: true, name };
}

async function handleMouseMove(body) {
  const { x, y } = requireCoords(body);
  await execFileAsync(CLICLICK, [`m:${x},${y}`]);
  return { ok: true, x, y };
}

async function handleScreenSize() {
  // Use AppleScript "desktop" bounds — authoritative even with multiple displays.
  const script = 'tell application "Finder" to get bounds of window of desktop';
  const { stdout } = await execFileAsync(OSASCRIPT, ['-e', script]);
  // stdout like "0, 0, 2560, 1440"
  const parts = stdout.trim().split(',').map((s) => parseInt(s.trim(), 10));
  if (parts.length >= 4 && parts.every(Number.isFinite)) {
    return { width: parts[2] - parts[0], height: parts[3] - parts[1] };
  }
  throw new Error('could not determine screen size');
}

async function handleCodexDesktopStatus() {
  return codexDesktop.status();
}

async function handleCodexDesktopList(body) {
  return codexDesktop.list({
    cursor: body?.cursor,
    limit: body?.limit,
    searchTerm: body?.search_term,
    cwd: body?.cwd,
  });
}

async function handleCodexDesktopRead(body) {
  return codexDesktop.read(String(body?.thread_id || ''));
}

async function handleCodexDesktopStart(body, context) {
  return codexDesktop.start({
    prompt: body?.prompt,
    cwd: body?.cwd,
    taskTitle: body?.task_title,
    requestKey: context?.startRequestKey,
  });
}

async function handleCodexDesktopContinue(body) {
  return codexDesktop.continueThread({
    threadId: String(body?.thread_id || ''),
    prompt: body?.prompt,
    taskTitle: body?.task_title,
  });
}

async function handleCodexDesktopSteer(body) {
  return codexDesktop.steer({
    threadId: String(body?.thread_id || ''),
    turnId: String(body?.turn_id || ''),
    prompt: body?.prompt,
  });
}

async function handleCodexDesktopWait(body) {
  return codexDesktop.wait({
    threadId: body?.thread_id ? String(body.thread_id) : undefined,
    turnId: body?.turn_id ? String(body.turn_id) : undefined,
    timeoutMs: Number(body?.timeout_seconds || 10) * 1_000,
  });
}

async function handleCodexDesktopInterrupt(body) {
  return codexDesktop.interrupt({
    threadId: body?.thread_id ? String(body.thread_id) : undefined,
    turnId: body?.turn_id ? String(body.turn_id) : undefined,
  });
}

async function handleCodexDesktopOpen(body) {
  return codexDesktop.open(String(body?.thread_id || ''));
}

// ---------------------------------------------------------------------------
// Redact text for logs (passwords might be in the buffer)
// ---------------------------------------------------------------------------

function redactBody(endpoint, body) {
  if (!body) return undefined;
  if (endpoint.startsWith('/codex_desktop/')) {
    return codexRequestLogFields(body);
  }
  return safeHelperRequestLogFields(endpoint, body);
}

function errorForLog(endpoint, error) {
  if (endpoint.startsWith('/codex_desktop/') || endpoint === '/type') {
    return { error_type: error instanceof Error ? error.name : typeof error };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

function codexDesktopStartRequestKey(endpoint, runId, body) {
  if (
    endpoint !== '/codex_desktop/start' ||
    !isValidCodexControlRunId(runId)
  ) {
    return undefined;
  }
  const payload = JSON.stringify({
    version: 1,
    action: 'start',
    runId,
    prompt: typeof body?.prompt === 'string' ? body.prompt : null,
    cwd: typeof body?.cwd === 'string' ? body.cwd : null,
    taskTitle:
      typeof body?.task_title === 'string' ? body.task_title : null,
  });
  return createHmac('sha256', SECRET)
    .update('skoobi.codex-desktop.start.v1')
    .update('\0')
    .update(payload)
    .digest('hex');
}

async function frontmostApplicationName() {
  const script =
    'tell application "System Events" to get name of first application process whose frontmost is true';
  const { stdout } = await execFileAsync(OSASCRIPT, ['-e', script]);
  return stdout.trim();
}

async function rejectUnauthorizedCodexGui(req, res, endpoint, body) {
  if (req.headers['x-skoobi-codex-gui-authorized'] === '1') return false;

  let frontmostApplication = '';
  if (codexGuiEndpointNeedsFrontmostCheck(endpoint)) {
    try {
      frontmostApplication = await frontmostApplicationName();
    } catch (error) {
      log('warn', 'codex_gui_state_check_failed', {
        endpoint,
        error_type: error instanceof Error ? error.name : typeof error,
      });
      sendJSON(res, 503, { error: 'codex_gui_state_unavailable' });
      return true;
    }
  }

  if (
    !codexGuiAuthorizationRequired({
      endpoint,
      body,
      frontmostApplication,
    })
  ) {
    return false;
  }
  log('warn', 'codex_gui_control_rejected', { endpoint });
  sendJSON(res, 403, { error: 'codex_gui_authorization_required' });
  return true;
}

function revokeCodexControlRunForInterrupt(req, res, endpoint) {
  if (endpoint !== '/codex_desktop/interrupt') return false;
  const runId = req.headers[CODEX_REVOKE_CONTROL_RUN_ID_HEADER];
  if (runId === undefined) return false;
  if (!isValidCodexControlRunId(runId)) {
    log('warn', 'codex_control_run_revocation_rejected', { endpoint });
    sendJSON(res, 400, { error: 'invalid_codex_control_run_id' });
    return true;
  }
  try {
    codexControlRunRevocations.revoke(runId);
  } catch (error) {
    log('error', 'codex_control_run_revocation_failed', {
      endpoint,
      error_type: error instanceof Error ? error.name : typeof error,
    });
    sendJSON(res, 503, { error: 'codex_control_run_revocation_failed' });
    return true;
  }
  log('info', 'codex_control_run_revoked', { endpoint });
  return false;
}

function rejectUnauthorizedCodexControlRun(req, res, endpoint) {
  const error = codexControlRequestError(
    endpoint,
    req.headers[CODEX_CONTROL_RUN_ID_HEADER],
    codexControlRunRevocations,
  );
  if (!error) return false;
  log('warn', 'codex_control_run_rejected', { endpoint, reason: error });
  sendJSON(res, error === 'codex_control_run_revoked' ? 409 : 403, {
    error,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const ROUTES = {
  'GET /health': { auth: true, handler: async () => ({ ok: true }) },
  'GET /screen_size': { auth: true, handler: handleScreenSize },
  'POST /screenshot': { auth: true, handler: handleScreenshot },
  'POST /click': { auth: true, handler: handleClick, body: true },
  'POST /type': { auth: true, handler: handleType, body: true },
  'POST /key': { auth: true, handler: handleKey, body: true },
  'POST /open_app': { auth: true, handler: handleOpenApp, body: true },
  'POST /mouse_move': { auth: true, handler: handleMouseMove, body: true },
  'GET /codex_desktop/status': {
    auth: true,
    handler: handleCodexDesktopStatus,
  },
  'POST /codex_desktop/list': {
    auth: true,
    handler: handleCodexDesktopList,
    body: true,
  },
  'POST /codex_desktop/read': {
    auth: true,
    handler: handleCodexDesktopRead,
    body: true,
  },
  'POST /codex_desktop/start': {
    auth: true,
    handler: handleCodexDesktopStart,
    body: true,
  },
  'POST /codex_desktop/continue': {
    auth: true,
    handler: handleCodexDesktopContinue,
    body: true,
  },
  'POST /codex_desktop/steer': {
    auth: true,
    handler: handleCodexDesktopSteer,
    body: true,
  },
  'POST /codex_desktop/wait': {
    auth: true,
    handler: handleCodexDesktopWait,
    body: true,
  },
  'POST /codex_desktop/interrupt': {
    auth: true,
    handler: handleCodexDesktopInterrupt,
    body: true,
  },
  'POST /codex_desktop/open': {
    auth: true,
    handler: handleCodexDesktopOpen,
    body: true,
  },
};

const server = http.createServer(async (req, res) => {
  // Never use the caller-controlled Host header as a URL base. A malformed Host
  // must produce a bounded client error rather than an exception before auth.
  const url = parseHelperRequestUrl(req.url);
  if (!url) {
    sendJSON(res, 400, { error: 'invalid_request_target' });
    return;
  }
  const key = `${req.method} ${url.pathname}`;
  const route = ROUTES[key];

  if (!route) {
    sendJSON(res, 404, { error: 'not_found' });
    return;
  }

  // Auth — constant-time secret check (finding #36)
  const given = req.headers['x-helper-secret'];
  if (route.auth && !secretMatches(given, SECRET)) {
    log('warn', 'auth_failed', { endpoint: key, ip: req.socket.remoteAddress });
    sendJSON(res, 401, { error: 'unauthorized' });
    return;
  }
  if (url.pathname.startsWith('/codex_desktop/')) {
    const callerChatJid = req.headers['x-skoobi-chat-jid'];
    if (
      !CODEX_OWNER_CHAT_JID ||
      typeof callerChatJid !== 'string' ||
      callerChatJid !== CODEX_OWNER_CHAT_JID
    ) {
      log('warn', 'codex_desktop_caller_rejected', { endpoint: key });
      sendJSON(res, 403, { error: 'codex_desktop_caller_rejected' });
      return;
    }
    if (revokeCodexControlRunForInterrupt(req, res, url.pathname)) {
      return;
    }
  }

  // Rate limit (per-endpoint)
  if (!rateLimit(url.pathname)) {
    sendJSON(res, 429, { error: 'rate_limited', limit: `${RATE_LIMIT}/s` });
    return;
  }

  let body;
  if (route.body) {
    try {
      body = await readJSONBody(req);
    } catch (err) {
      sendJSON(res, 400, { error: 'invalid_json', detail: err.message });
      return;
    }
  }

  if (await rejectUnauthorizedCodexGui(req, res, url.pathname, body)) {
    return;
  }

  // This check intentionally happens after the request body is complete and
  // immediately before dispatch. A concurrent stop can therefore revoke a run
  // while a delayed start request is still arriving, without a check/use gap.
  if (rejectUnauthorizedCodexControlRun(req, res, url.pathname)) {
    return;
  }

  try {
    const result = await route.handler(body, {
      startRequestKey: codexDesktopStartRequestKey(
        url.pathname,
        req.headers[CODEX_CONTROL_RUN_ID_HEADER],
        body,
      ),
    });
    log('info', 'ok', { endpoint: key, body: redactBody(url.pathname, body) });
    sendJSON(res, 200, result);
  } catch (err) {
    if (url.pathname.startsWith('/codex_desktop/')) {
      const failure = codexDesktopErrorResponse(err);
      log('error', 'codex_desktop_request_failed', {
        endpoint: key,
        body: redactBody(url.pathname, body),
        error_code: failure.body.error,
        http_status: failure.status,
      });
      sendJSON(res, failure.status, failure.body);
      return;
    }
    log('error', 'handler_failed', {
      endpoint: key,
      body: redactBody(url.pathname, body),
      ...errorForLog(url.pathname, err),
    });
    sendJSON(
      res,
      500,
      url.pathname === '/type'
        ? { error: 'handler_failed' }
        : { error: 'handler_failed', detail: err.message },
    );
  }
});

server.on('error', (err) => {
  log('error', 'server_error', { error: err.message });
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  log('info', 'listening', { port: PORT, host: '127.0.0.1' });
  console.error(`skoobi-helper listening on 127.0.0.1:${PORT}`);
  recoverCodexTask();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('info', 'shutdown', { signal: sig });
    codexRecoveryStopped = true;
    clearInterval(screenshotCleanupTimer);
    if (codexRecoveryTimer) clearTimeout(codexRecoveryTimer);
    codexRecoveryTimer = null;
    codexDesktop.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  });
}
