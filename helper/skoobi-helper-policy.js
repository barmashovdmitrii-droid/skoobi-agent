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

// Derived screenshots (downscaled JPEGs, region captures) use the same
// `<ms>-<uuid>` names so the retention sweep below also removes them.
const MANAGED_SCREENSHOT_NAME_RE =
  /^\d+(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.(?:png|jpe?g)$/i;
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
    pattern: /^Codex local tool preflight failed; no task turn was started\.$/,
    status: 503,
    error: 'codex_tools_unavailable',
    detail:
      'Local command/file tool preflight failed. No task turn was started. Repair the local runtime before retrying; do not relax workspace or network limits.',
  },
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

// ---------------------------------------------------------------------------
// Screenshot derivation (downscale / region capture). Pure planning helpers:
// the helper daemon runs the planned screencapture and /usr/bin/sips steps
// (injected), everything here can be tested without a display.
// ---------------------------------------------------------------------------

export const SCREENSHOT_DEFAULT_MAX_SIDE = 1280;
export const SCREENSHOT_MIN_MAX_SIDE = 320;
export const SCREENSHOT_MAX_MAX_SIDE = 2048;
export const SCREENSHOT_DEFAULT_JPEG_QUALITY = 70;
export const SCREENSHOT_MIN_JPEG_QUALITY = 30;
export const SCREENSHOT_MAX_JPEG_QUALITY = 95;
export const SCREENSHOT_MIN_REGION_POINTS = 4;

const IMAGE_HEADER_READ_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// Every JPEG start-of-frame marker (C4 = DHT, C8 = JPG and CC = DAC are not).
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function screenshotOptionsError(detail) {
  return new Error(`invalid screenshot options: ${detail}`);
}

function finiteOption(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw screenshotOptionsError(`${name} must be a finite number`);
  }
  return value;
}

function clampInteger(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function roundTo4(value) {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Parse the optional JSON body of POST /screenshot.
 *
 * Returns null for the legacy request (no body or `{}`): the caller keeps the
 * old full-size PNG contract, so an older runner sees no change. Otherwise
 * returns `{format, maxSide, quality, region}` with the region in screen
 * POINTS. Throws `invalid screenshot options: …` for malformed input, before
 * anything is captured.
 */
export function parseScreenshotRequest(body) {
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw screenshotOptionsError('body must be a JSON object');
  }
  if (Object.keys(body).length === 0) return null;

  let format = 'jpeg';
  if (body.format !== undefined) {
    const raw =
      typeof body.format === 'string' ? body.format.toLowerCase() : '';
    if (raw === 'jpeg' || raw === 'jpg') format = 'jpeg';
    else if (raw === 'png') format = 'png';
    else throw screenshotOptionsError('format must be "jpeg" or "png"');
  }

  // null = keep the full resolution (no resize step).
  let maxSide = SCREENSHOT_DEFAULT_MAX_SIDE;
  if (body.max_side === null) {
    maxSide = null;
  } else if (body.max_side !== undefined) {
    maxSide = clampInteger(
      finiteOption(body.max_side, 'max_side'),
      SCREENSHOT_MIN_MAX_SIDE,
      SCREENSHOT_MAX_MAX_SIDE,
    );
  }

  let quality = SCREENSHOT_DEFAULT_JPEG_QUALITY;
  if (body.quality !== undefined) {
    quality = clampInteger(
      finiteOption(body.quality, 'quality'),
      SCREENSHOT_MIN_JPEG_QUALITY,
      SCREENSHOT_MAX_JPEG_QUALITY,
    );
  }

  let region = null;
  if (body.region !== undefined && body.region !== null) {
    const raw = body.region;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw screenshotOptionsError('region must be an object');
    }
    region = {
      x: finiteOption(raw.x, 'region.x'),
      y: finiteOption(raw.y, 'region.y'),
      width: finiteOption(raw.width, 'region.width'),
      height: finiteOption(raw.height, 'region.height'),
    };
    if (
      region.width < SCREENSHOT_MIN_REGION_POINTS ||
      region.height < SCREENSHOT_MIN_REGION_POINTS
    ) {
      throw screenshotOptionsError(
        `region width and height must be at least ${SCREENSHOT_MIN_REGION_POINTS} points`,
      );
    }
  }

  return { format, maxSide, quality, region };
}

/**
 * Pixel size of a PNG (IHDR) or JPEG (first SOFn frame) held in `buffer`.
 * Returns `{format, width, height}` or null when the data is not a readable
 * PNG/JPEG header.
 */
export function readImageSize(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(PNG_SIGNATURE) &&
    buffer.toString('latin1', 12, 16) === 'IHDR'
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return width > 0 && height > 0 ? { format: 'png', width, height } : null;
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte before a marker
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2; // standalone marker without a length field
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before SOF
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 9 > buffer.length) return null;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { format: 'jpeg', width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/** readImageSize() on the head of a file; null when unreadable. */
export function readImageFileSize(filePath) {
  let fd;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const buffer = Buffer.alloc(IMAGE_HEADER_READ_BYTES);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return readImageSize(buffer.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Parse the JXA NSScreen probe output `{"w":…,"h":…,"scale":…,"n":…}` into
 * `{width, height, scale, screens}` (points). Returns null on anything odd.
 */
export function parseDisplayGeometryOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? '').trim());
  } catch {
    return null;
  }
  const width = Number(parsed?.w);
  const height = Number(parsed?.h);
  const scale = Number(parsed?.scale);
  const screens = Number(parsed?.n);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    width,
    height,
    scale: Number.isFinite(scale) && scale > 0 ? scale : null,
    screens: Number.isSafeInteger(screens) && screens > 0 ? screens : null,
  };
}

/**
 * True when a captured image of srcWidth x srcHeight pixels plausibly shows
 * `display` (points): both axes give the same pixels-per-point ratio and, when
 * the backing scale is known, that ratio equals it. A mismatch means the cached
 * geometry is stale (display mode changed) or describes another display.
 */
export function displayMatchesCapture(
  display,
  srcWidth,
  srcHeight,
  tolerance = 0.01,
) {
  if (!(display?.width > 0) || !(display?.height > 0)) return false;
  const scaleX = srcWidth / display.width;
  const scaleY = srcHeight / display.height;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return false;
  if (Math.abs(scaleX - scaleY) > tolerance) return false;
  if (display.scale) return Math.abs(scaleX - display.scale) <= tolerance;
  return true;
}

function screenshotRegionOutsideError() {
  const error = new Error('screenshot region is outside the screen');
  error.code = 'SCREENSHOT_REGION_OUTSIDE';
  return error;
}

function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Plan how a full-display capture becomes the requested image.
 *
 * - A region (points) is clamped to the display and rounded OUTWARD to whole
 *   points, then captured on its own with `screencapture -x -R x,y,w,h`
 *   (global points, the main display starts at 0,0), which writes it at
 *   native pixels (pixels per point = srcWidth / display.width).
 * - INVARIANT: sips never crops. /usr/bin/sips ignores `--cropOffset` when x
 *   is 0: it crops the centre instead (at the requested size, so the size
 *   alone does not give it away), or hands back the whole image when the
 *   crop reaches the bottom edge.
 * - The capture (region or whole display) is fitted inside maxSide by one
 *   sips call (`-Z`, never upscaled) that also converts the format.
 *
 * Returns `{capture, steps, outputPath, output: {width, height, format},
 * region, scale, resized}`. `capture` is null for the whole display, else
 * `{args, path, rect, expected: {width, height}}`: the screencapture
 * arguments and the pixel size the region capture must have. `steps` are
 * the sips calls. `region` is the screen area (points) that the output image
 * covers. `expected` and `output` are planned sizes; the caller must confirm
 * them from the written files. Throws an error with code
 * SCREENSHOT_REGION_OUTSIDE when the region does not overlap the display.
 */
export function planScreenshotDerivation({
  srcPath,
  regionPath,
  dstPath,
  srcWidth,
  srcHeight,
  display,
  request,
}) {
  if (!Number.isSafeInteger(srcWidth) || srcWidth <= 0) {
    throw new Error('invalid screenshot source size');
  }
  if (!Number.isSafeInteger(srcHeight) || srcHeight <= 0) {
    throw new Error('invalid screenshot source size');
  }
  if (!isPositiveFinite(display?.width) || !isPositiveFinite(display?.height)) {
    throw new Error('invalid display geometry');
  }
  if (!request || (request.format !== 'jpeg' && request.format !== 'png')) {
    throw new Error('invalid screenshot request');
  }
  for (const [name, value] of [
    ['srcPath', srcPath],
    ['dstPath', dstPath],
  ]) {
    if (typeof value !== 'string' || !value) {
      throw new Error(`${name} is required`);
    }
  }

  const scaleX = srcWidth / display.width;
  const scaleY = srcHeight / display.height;

  let capture = null;
  let input = { path: srcPath, width: srcWidth, height: srcHeight };
  let region = {
    x: 0,
    y: 0,
    width: roundTo4(display.width),
    height: roundTo4(display.height),
  };
  if (request.region) {
    const r = request.region;
    // Whole points: the rect handed to screencapture is exactly the area the
    // image covers, so the pixel -> point mapping needs no rounding guess.
    const maxX = Math.floor(display.width);
    const maxY = Math.floor(display.height);
    const clamp = (v, max) => Math.min(max, Math.max(0, v));
    const left = Math.floor(clamp(r.x, maxX));
    const right = Math.ceil(clamp(r.x + r.width, maxX));
    const top = Math.floor(clamp(r.y, maxY));
    const bottom = Math.ceil(clamp(r.y + r.height, maxY));
    if (right - left < 1 || bottom - top < 1) {
      throw screenshotRegionOutsideError();
    }
    const wholeDisplay =
      left === 0 &&
      top === 0 &&
      right === display.width &&
      bottom === display.height;
    if (!wholeDisplay) {
      if (typeof regionPath !== 'string' || !regionPath) {
        throw new Error('regionPath is required');
      }
      const rect = {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      };
      const expected = {
        width: Math.round(rect.width * scaleX),
        height: Math.round(rect.height * scaleY),
      };
      capture = {
        args: [
          '-x',
          '-R',
          `${rect.x},${rect.y},${rect.width},${rect.height}`,
          regionPath,
        ],
        path: regionPath,
        rect,
        expected,
      };
      input = { path: regionPath, ...expected };
      region = { ...rect };
    }
  }

  const longSide = Math.max(input.width, input.height);
  const resized = request.maxSide !== null && longSide > request.maxSide;
  let width = input.width;
  let height = input.height;
  if (resized) {
    const factor = request.maxSide / longSide;
    width =
      input.width >= input.height
        ? request.maxSide
        : Math.max(1, Math.round(input.width * factor));
    height =
      input.height > input.width
        ? request.maxSide
        : Math.max(1, Math.round(input.height * factor));
  }

  const formatArgs =
    request.format === 'jpeg'
      ? ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(request.quality)]
      : ['-s', 'format', 'png'];

  const steps = [];
  let outputPath = dstPath;
  if (request.format === 'png' && !resized) {
    // Both captures already are PNGs: hand the capture itself back.
    outputPath = input.path;
  } else {
    steps.push([
      ...(resized ? ['-Z', String(request.maxSide)] : []),
      ...formatArgs,
      input.path,
      '--out',
      dstPath,
    ]);
  }

  return {
    capture,
    steps,
    outputPath,
    output: { width, height, format: request.format },
    region,
    scale: { x: scaleX, y: scaleY },
    resized,
  };
}

function errorType(error) {
  return error instanceof Error ? error.name : typeof error;
}

function removeFiles(files) {
  for (const file of files) {
    if (file) fs.rmSync(file, { force: true });
  }
}

function publicDisplayGeometry(display) {
  return {
    width: display.width,
    height: display.height,
    scale: display.scale ?? null,
    ...(display.screens ? { screens: display.screens } : {}),
  };
}

/**
 * The full-size capture as a /screenshot answer. `src` is
 * `{path, bytes, size}` (size from readImageFileSize, may be null). With a
 * trusted `display` it also carries the geometry (the whole display), so
 * clicks by screenshot pixel still work — just on a bigger image. Without it
 * the answer is the legacy `{path, bytes, …}` and the runner falls back to
 * plain screen points.
 */
export function fullScreenshotResult(src, display) {
  const result = { path: src.path, bytes: src.bytes, format: 'png' };
  if (src.size) {
    result.width = src.size.width;
    result.height = src.size.height;
  }
  if (src.size && display) {
    result.region = {
      x: 0,
      y: 0,
      width: display.width,
      height: display.height,
    };
    result.display = publicDisplayGeometry(display);
    result.source_width = src.size.width;
    result.source_height = src.size.height;
    result.downscaled = false;
  }
  return result;
}

/**
 * Display geometry (points) that matches a capture of srcSize pixels.
 * `getGeometry({refresh})` returns the (cached) primary-display geometry; a
 * mismatch triggers one refresh (display mode changed). If it still does not
 * match but both axes agree on pixels-per-point, the capture is trusted for
 * the scale. Axes that disagree mean the geometry describes something else
 * (e.g. the Finder union of several displays): returns null — no mapping is
 * better than a wrong one.
 */
export async function resolveScreenshotDisplay(srcSize, getGeometry) {
  let display = await getGeometry({ refresh: false });
  if (displayMatchesCapture(display, srcSize.width, srcSize.height)) {
    return display;
  }
  display = await getGeometry({ refresh: true });
  if (displayMatchesCapture(display, srcSize.width, srcSize.height)) {
    return display;
  }
  if (!isPositiveFinite(display?.width) || !isPositiveFinite(display?.height)) {
    return null;
  }
  const scaleX = srcSize.width / display.width;
  const scaleY = srcSize.height / display.height;
  if (Math.abs(scaleX - scaleY) <= 0.01) {
    return { ...display, scale: Math.round(scaleX * 1000) / 1000 };
  }
  return null;
}

/**
 * True when `size` (from readImageFileSize) has the planned format and is
 * within `tolerance` px of the planned width and height.
 */
function sizeMatchesPlan(size, planned, format, tolerance = 1) {
  return (
    Boolean(size) &&
    size.format === format &&
    Math.abs(size.width - planned.width) <= tolerance &&
    Math.abs(size.height - planned.height) <= tolerance
  );
}

/**
 * Turn a fresh full-display capture into the requested image.
 *
 * - `src`: `{path, bytes, stamp, size}` of the capture inside `directory`.
 * - `resolveDisplay(size)`: display geometry in points, or null.
 * - `captureRegion(args, {timeout})`: runs /usr/sbin/screencapture with the
 *   planned `-x -R x,y,w,h <file>` arguments (injected for tests).
 * - `runSips(args, {timeout})`: runs /usr/bin/sips (injected for tests).
 *
 * Derived files get managed `<stamp>-<uuid>` names in the same private
 * directory, so the retention sweep covers crash leftovers. Every written
 * image is checked against its planned pixel size (±1 px): the region
 * capture against the region at native pixels, the output against the
 * planned output. So the returned region/size pair maps image pixels to the
 * screen points they really show. On success the capture and the region
 * capture are removed (unless one of them is the answer). Downscaling must
 * never make a screenshot fail: any failure returns the full-size capture
 * instead (`fallback: true` once the display is known). The one error that
 * is thrown is a region that misses the screen — the caller asked for
 * something that is not there.
 */
export async function deriveScreenshot({
  src,
  request,
  directory,
  resolveDisplay,
  captureRegion,
  runSips,
  log = () => {},
  budgetMs = 10_000,
}) {
  if (!src.size) {
    log('warn', 'screenshot_downscale_failed', { stage: 'source_size' });
    return fullScreenshotResult(src, null);
  }
  let display;
  try {
    display = await resolveDisplay(src.size);
  } catch (error) {
    log('warn', 'screenshot_downscale_failed', {
      stage: 'display_geometry',
      error_type: errorType(error),
    });
    return fullScreenshotResult(src, null);
  }
  if (!display) {
    log('warn', 'screenshot_downscale_failed', { stage: 'geometry_mismatch' });
    return fullScreenshotResult(src, null);
  }

  const regionPath = path.join(directory, `${src.stamp}-${randomUUID()}.png`);
  const dstPath = path.join(
    directory,
    `${src.stamp}-${randomUUID()}.${request.format === 'jpeg' ? 'jpg' : 'png'}`,
  );
  let plan;
  try {
    plan = planScreenshotDerivation({
      srcPath: src.path,
      regionPath,
      dstPath,
      srcWidth: src.size.width,
      srcHeight: src.size.height,
      display,
      request,
    });
  } catch (error) {
    if (error?.code === 'SCREENSHOT_REGION_OUTSIDE') throw error;
    log('warn', 'screenshot_downscale_failed', {
      stage: 'plan',
      error_type: errorType(error),
    });
    return { ...fullScreenshotResult(src, display), fallback: true };
  }

  const deadline = Date.now() + budgetMs;
  const timeLeft = () => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error('screenshot derivation timed out');
    return timeout;
  };
  let stage = plan.capture ? 'region_capture' : 'sips';
  try {
    if (plan.capture) {
      await captureRegion(plan.capture.args, { timeout: timeLeft() });
      secureScreenshotFile(plan.capture.path, directory);
      // A display mode change since the full capture, or a clipped rect,
      // gives another size — and a mapping that points somewhere else.
      if (
        !sizeMatchesPlan(
          readImageFileSize(plan.capture.path),
          plan.capture.expected,
          'png',
        )
      ) {
        throw new Error('region capture has an unexpected size');
      }
      stage = 'sips';
    }
    for (const step of plan.steps) {
      await runSips(step, { timeout: timeLeft() });
    }
    stage = 'verify';
    const bytes = secureScreenshotFile(plan.outputPath, directory);
    const size = readImageFileSize(plan.outputPath);
    if (!sizeMatchesPlan(size, plan.output, plan.output.format)) {
      throw new Error('derived screenshot has an unexpected size');
    }
    removeFiles([
      plan.outputPath === src.path ? null : src.path,
      plan.outputPath === regionPath ? null : regionPath,
    ]);
    return {
      path: plan.outputPath,
      bytes,
      format: plan.output.format,
      // The ACTUAL written size drives the pixel -> point mapping.
      width: size.width,
      height: size.height,
      region: plan.region,
      display: publicDisplayGeometry(display),
      source_width: src.size.width,
      source_height: src.size.height,
      downscaled: plan.resized,
    };
  } catch (error) {
    log('warn', 'screenshot_downscale_failed', {
      stage,
      error_type: errorType(error),
    });
    removeFiles([regionPath, dstPath]);
    return { ...fullScreenshotResult(src, display), fallback: true };
  }
}

// ---------------------------------------------------------------------------
// /key: key names, aliases and the press plan.
//
// cliclick `kp:` names press a lone named key; AppleScript key codes drive
// chords. The tables live here (pure, unit-tested) rather than in the server:
// on 01.10.2026 the model pressed "pageup" and the chord branch answered
// «unsupported key with modifiers», naming neither the right spelling nor the
// keys that do exist.
// ---------------------------------------------------------------------------

export const CLICLICK_KEYS = new Set([
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

export const KEY_ALIASES = {
  enter: 'return',
  escape: 'esc',
  up: 'arrow-up', down: 'arrow-down', left: 'arrow-left', right: 'arrow-right',
  backspace: 'delete',
  del: 'fwd-delete',
  // Every spelling the model has reached for; cliclick knows only page-up /
  // page-down (home and end are already cliclick names).
  pgup: 'page-up', pageup: 'page-up', page_up: 'page-up',
  pgdn: 'page-down', pgdown: 'page-down', pagedown: 'page-down', page_down: 'page-down',
};

export const MOD_TO_APPLESCRIPT = {
  cmd: 'command down', command: 'command down',
  ctrl: 'control down', control: 'control down',
  alt: 'option down', option: 'option down', opt: 'option down',
  shift: 'shift down',
};

// AppleScript key-code table for common non-character keys used in chords.
export const APPLESCRIPT_KEYCODES = {
  space: 49, return: 36, enter: 76, tab: 48, esc: 53, escape: 53,
  delete: 51, backspace: 51, 'fwd-delete': 117,
  'arrow-up': 126, up: 126, 'arrow-down': 125, down: 125,
  'arrow-left': 123, left: 123, 'arrow-right': 124, right: 124,
  home: 115, end: 119, 'page-up': 116, 'page-down': 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
};

export function splitKeys(s) {
  return String(s).toLowerCase().split('+').map((k) => k.trim()).filter(Boolean);
}

/** Names /key accepts as a lone key (cliclick names plus our aliases). */
export function supportedKeyNames() {
  return [...new Set([...CLICLICK_KEYS, ...Object.keys(KEY_ALIASES)])].sort();
}

/** Named keys a chord (with cmd/ctrl/alt/shift) can target. */
export function supportedChordKeyNames() {
  return [...new Set([...Object.keys(APPLESCRIPT_KEYCODES), ...Object.keys(KEY_ALIASES)])].sort();
}

/**
 * Decide how to press `keys` without touching the system:
 * `{ kind: 'cliclick', key }` for a lone named key, `{ kind: 'osascript',
 * script }` for a chord or a lone character. An unknown key throws an error
 * that names the supported keys, so the model can correct its spelling.
 */
export function planKeyPress(keys) {
  const parts = splitKeys(keys);
  const mods = [];
  const nonMods = [];
  for (const p of parts) {
    if (MOD_TO_APPLESCRIPT[p]) mods.push(MOD_TO_APPLESCRIPT[p]);
    else nonMods.push(KEY_ALIASES[p] || p);
  }

  // No modifiers — cliclick for a known named key, keystroke for a character.
  if (mods.length === 0 && nonMods.length === 1) {
    const k = nonMods[0];
    if (CLICLICK_KEYS.has(k)) return { kind: 'cliclick', key: k };
    if (k.length === 1) {
      return {
        kind: 'osascript',
        script: `tell application "System Events" to keystroke ${JSON.stringify(k)}`,
      };
    }
    throw new Error(
      `unsupported key ${JSON.stringify(k)}; supported: a single character or one of ${supportedKeyNames().join(', ')}`,
    );
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
    throw new Error(
      `unsupported key with modifiers: ${JSON.stringify(target)}; supported: a single character or one of ${supportedChordKeyNames().join(', ')}`,
    );
  }
  return { kind: 'osascript', script: `tell application "System Events" to ${body}` };
}

// ---------------------------------------------------------------------------
// /open_app: one retry while the app is still quitting.
//
// 28.09.2026 19:42:59: `cmd+q` to Telegram, then `open -a Telegram` 68 ms
// later — LaunchServices answered -600 (procNotFound: the process was still
// on its way out), the model got a bare «open -a Telegram failed» and only
// recovered 9 s later by trying again itself.
// ---------------------------------------------------------------------------

export const OPEN_APP_RETRY_DELAY_MS = 1500;

/** LaunchServices -600 (procNotFound): `open -a` raced the app's own quit. */
export function isAppStillClosingError(error) {
  const text = [error?.message, error?.stderr]
    .filter((value) => typeof value === 'string')
    .join('\n');
  return /\berror -600\b|\(-600\)|procNotFound/i.test(text);
}

/**
 * Run `open()` once; on a -600 wait OPEN_APP_RETRY_DELAY_MS (via the injected
 * `sleep`) and run it once more. Any other failure, and a second -600, is
 * thrown as-is — the second one with a detail that says what to do.
 */
export async function openApplicationWithRetry({ name, open, sleep, onRetry }) {
  try {
    await open();
    return { ok: true, name };
  } catch (error) {
    if (!isAppStillClosingError(error)) throw error;
    if (onRetry) onRetry(error);
    await sleep(OPEN_APP_RETRY_DELAY_MS);
    try {
      await open();
    } catch (again) {
      if (!isAppStillClosingError(again)) throw again;
      throw new Error(
        `open -a ${name} failed twice with LaunchServices -600: the app is still quitting (or cannot launch right now); wait a few seconds and call open_app again`,
      );
    }
    return { ok: true, name, retried: true };
  }
}
