import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import type { Browser, BrowserContext, Page } from 'playwright';

import {
  captureFactoryManifestAsync,
  importFactorySourceAsync,
} from './game-factory-artifacts.js';
import type { CaptureFactoryManifestInput } from './game-factory-artifacts.js';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';

export interface FactoryHtml5Viewport {
  device: 'desktop_browser' | 'mobile_emulation';
  width: number;
  height: number;
}

export interface FactoryHtml5CheckInput extends CaptureFactoryManifestInput {
  expectedManifestSha256: string;
  /** Trusted host setting only; never a model-selected executable. */
  browserExecutablePath?: string;
  viewports?: FactoryHtml5Viewport[];
  navigationTimeoutMs?: number;
  settleMs?: number;
}

export interface FactoryHtml5RenderObservation {
  readyState: string;
  visibleTextLength: number;
  visibleCanvasCount: number;
  sampledNonBlankCanvases: number;
  unreadableCanvases: number;
  viewportFits: boolean;
}

export interface FactoryHtml5AudioObservation {
  phase: 'before_user_gesture';
  contextStates: string[];
  mediaElements: Array<{
    paused: boolean;
    muted: boolean;
    autoplay: boolean;
    error: number | null;
  }>;
  status: 'not_observed' | 'suspended' | 'running' | 'mixed' | 'error';
  audibleSoundVerified: false;
}

export interface FactoryHtml5Run {
  device: FactoryHtml5Viewport['device'];
  viewport: { width: number; height: number };
  status: 'passed' | 'failed';
  consoleErrors: string[];
  pageErrors: string[];
  blockedRequests: string[];
  failedLocalRequests: string[];
  render?: FactoryHtml5RenderObservation;
  audio?: FactoryHtml5AudioObservation;
  screenshotSha256?: string;
  error?: string;
}

export interface FactoryHtml5CheckReceipt {
  kind: 'html5_startup_smoke';
  trust: 'host_verified';
  status: 'passed' | 'failed' | 'unavailable' | 'stale';
  manifestSha256: string;
  observedAt: string;
  browser?: { name: 'chromium'; version: string; headless: true };
  checks: Array<{
    id: string;
    result: 'pass' | 'fail' | 'unknown';
    detail: string;
  }>;
  runs: FactoryHtml5Run[];
  limitations: string[];
}

const DEFAULT_VIEWPORTS: FactoryHtml5Viewport[] = [
  { device: 'desktop_browser', width: 1280, height: 720 },
  { device: 'mobile_emulation', width: 844, height: 390 },
];
const LIMITATIONS = [
  'Startup/render smoke only: no complete playthrough, normal-control scenario, save migration or human fun acceptance.',
  'Mobile viewport and touch settings are Chromium emulation, not a physical phone, Safari/iOS or a low-end device.',
  'Only pinned manifest bytes are served on loopback. Other network, WebSockets and service workers are blocked; live SDK, advertisements, payments and portal publication are not tested.',
  'Audio is observed before a user gesture under a user-gesture-required autoplay policy; audible sound and focus/ad pause behavior are not verified.',
  'Screenshot digests identify in-memory captures; this receipt does not claim a persisted screenshot artifact.',
];

const OBSERVATION_INIT = `(() => {
  const contexts = [];
  const blocked = [];
  window.addEventListener('securitypolicyviolation', event => { if (blocked.length < 32) blocked.push(String(event.blockedURI)); });
  Object.defineProperty(window, '__factoryBlockedUrls', { value: () => blocked, configurable: false });
  Object.defineProperty(window, '__factoryAudioStates', { value: () => contexts.map(c => String(c.state)).slice(0, 32), configurable: false });
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Original = window[name];
    if (typeof Original !== 'function') continue;
    window[name] = new Proxy(Original, { construct(target, args, receiver) {
      const context = Reflect.construct(target, args, receiver);
      if (contexts.length < 32) contexts.push(context);
      return context;
    }});
  }
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    if (name in window) Object.defineProperty(window, name, { configurable: false, value: function() { throw new DOMException('Realtime network is disabled in local factory smoke', 'SecurityError'); }});
  }
})()`;

const OBSERVE_RENDER_AND_AUDIO = `new Promise(resolve => requestAnimationFrame(() => resolve((() => {
  let visibleCanvasCount = 0, sampledNonBlankCanvases = 0, unreadableCanvases = 0;
  for (const canvas of [...document.querySelectorAll('canvas')].slice(0, 32)) {
    const rect = canvas.getBoundingClientRect(), style = getComputedStyle(canvas);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
    visibleCanvasCount++;
    try {
      if (!canvas.width || !canvas.height || canvas.width * canvas.height > 4194304) throw new Error('unsampled');
      const context = canvas.getContext('2d');
      let pixels;
      if (context) pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      else {
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl || gl.isContextLost()) throw new Error('unreadable-canvas');
        pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('unreadable-webgl');
      }
      let nonblank = false;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) { nonblank = true; break; }
      if (nonblank) sampledNonBlankCanvases++;
    } catch { unreadableCanvases++; }
  }
  const contextStates = window.__factoryAudioStates ? window.__factoryAudioStates() : [];
  const mediaElements = [...document.querySelectorAll('audio,video')].slice(0, 32).map(m => ({paused: m.paused, muted: m.muted, autoplay: m.autoplay, error: m.error ? m.error.code : null}));
  const states = new Set(contextStates);
  let audioStatus = 'not_observed';
  if (mediaElements.some(m => m.error)) audioStatus = 'error';
  else if (states.size > 1) audioStatus = 'mixed';
  else if (states.has('running') || mediaElements.some(m => !m.paused)) audioStatus = 'running';
  else if (states.has('suspended') || states.has('interrupted')) audioStatus = 'suspended';
  return {
    render: {readyState: document.readyState, visibleTextLength: (document.body?.innerText || '').trim().length, visibleCanvasCount, sampledNonBlankCanvases, unreadableCanvases,
      viewportFits: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0) <= innerWidth + 2 && Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0) <= innerHeight + 2},
    audio: {phase:'before_user_gesture',contextStates,mediaElements,status:audioStatus,audibleSoundVerified:false},
    blockedByCsp: window.__factoryBlockedUrls ? window.__factoryBlockedUrls() : []
  };
})())))`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 600);
}

function safeRequestLabel(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 500);
  } catch {
    return 'invalid-url';
  }
}

function recordBounded(list: string[], text: string): void {
  if (list.length < 32) list.push(text.slice(0, 600));
}

async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Factory browser observation timed out')),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateOptions(input: FactoryHtml5CheckInput) {
  if (!/^[a-f0-9]{64}$/.test(input.expectedManifestSha256))
    throw new Error('An exact expected manifest hash is required');
  const viewports = input.viewports ?? DEFAULT_VIEWPORTS;
  if (
    !viewports.length ||
    viewports.length > 4 ||
    viewports.some(
      (viewport) =>
        !['desktop_browser', 'mobile_emulation'].includes(viewport.device) ||
        !Number.isInteger(viewport.width) ||
        !Number.isInteger(viewport.height) ||
        viewport.width < 240 ||
        viewport.width > 2560 ||
        viewport.height < 240 ||
        viewport.height > 1600,
    )
  ) {
    throw new Error('Invalid bounded factory viewport configuration');
  }
  const navigationTimeoutMs = input.navigationTimeoutMs ?? 10_000;
  const settleMs = input.settleMs ?? 600;
  if (
    !Number.isInteger(navigationTimeoutMs) ||
    navigationTimeoutMs < 500 ||
    navigationTimeoutMs > 15_000 ||
    !Number.isInteger(settleMs) ||
    settleMs < 0 ||
    settleMs > 3000
  )
    throw new Error('Invalid bounded factory browser timing');
  return { viewports, navigationTimeoutMs, settleMs };
}

async function observeViewport(
  browser: Browser,
  origin: string,
  input: FactoryHtml5CheckInput,
  viewport: FactoryHtml5Viewport,
  timing: { navigationTimeoutMs: number; settleMs: number },
): Promise<FactoryHtml5Run> {
  const run: FactoryHtml5Run = {
    device: viewport.device,
    viewport: { width: viewport.width, height: viewport.height },
    status: 'failed',
    consoleErrors: [],
    pageErrors: [],
    blockedRequests: [],
    failedLocalRequests: [],
  };
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      viewport: run.viewport,
      isMobile: viewport.device === 'mobile_emulation',
      hasTouch: viewport.device === 'mobile_emulation',
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    context.setDefaultTimeout(timing.navigationTimeoutMs);
    context.setDefaultNavigationTimeout(timing.navigationTimeoutMs);
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin && ['GET', 'HEAD'].includes(request.method()))
        return route.continue();
      recordBounded(run.blockedRequests, safeRequestLabel(request.url()));
      await route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', (socket) => {
      recordBounded(run.blockedRequests, safeRequestLabel(socket.url()));
      socket.close({ code: 1008, reason: 'Factory offline smoke' });
    });
    await context.addInitScript({ content: OBSERVATION_INIT });
    const page: Page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error')
        recordBounded(run.consoleErrors, message.text());
    });
    page.on('pageerror', (error) =>
      recordBounded(run.pageErrors, shortError(error)),
    );
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => {});
    });
    page.on('popup', (popup) => {
      recordBounded(run.blockedRequests, 'popup');
      void popup.close().catch(() => {});
    });
    page.on('response', (response) => {
      if (response.status() >= 400 && new URL(response.url()).origin === origin)
        recordBounded(
          run.failedLocalRequests,
          `${response.status()} ${safeRequestLabel(response.url())}`,
        );
    });
    const url = `${origin}/${input.entrypoint.split('/').map(encodeURIComponent).join('/')}`;
    const response = await page.goto(url, {
      waitUntil: 'load',
      timeout: timing.navigationTimeoutMs,
    });
    if (!response?.ok())
      throw new Error('Entrypoint did not load successfully');
    await page.waitForTimeout(timing.settleMs);
    const observation = (await deadline(
      page.evaluate(OBSERVE_RENDER_AND_AUDIO),
      4000,
    )) as {
      render: FactoryHtml5RenderObservation;
      audio: FactoryHtml5AudioObservation;
      blockedByCsp: string[];
    };
    run.render = observation.render;
    run.audio = observation.audio;
    for (const blocked of observation.blockedByCsp)
      recordBounded(run.blockedRequests, safeRequestLabel(blocked));
    const screenshot = await page.screenshot({ type: 'png', timeout: 5000 });
    run.screenshotSha256 = createHash('sha256')
      .update(screenshot)
      .digest('hex');
    const rendered =
      run.render.visibleTextLength > 0 ||
      run.render.sampledNonBlankCanvases > 0;
    if (!rendered)
      run.error =
        run.render.unreadableCanvases > 0
          ? 'Canvas surface exists, but non-blank WebGL/tainted pixels were not verified'
          : 'No visible text or non-blank canvas observed';
    run.status =
      rendered &&
      run.render.viewportFits &&
      !run.consoleErrors.length &&
      !run.pageErrors.length &&
      !run.blockedRequests.length &&
      !run.failedLocalRequests.length
        ? 'passed'
        : 'failed';
  } catch (error) {
    run.error = shortError(error);
  } finally {
    if (context) await deadline(context.close(), 5000).catch(() => {});
  }
  return run;
}

/** Host-owned local smoke, never a platform submission or a complete QA claim. */
export async function verifyFactoryHtml5Build(
  input: FactoryHtml5CheckInput,
): Promise<FactoryHtml5CheckReceipt> {
  const timing = validateOptions(input);
  const receipt: FactoryHtml5CheckReceipt = {
    kind: 'html5_startup_smoke',
    trust: 'host_verified',
    status: 'failed',
    manifestSha256: input.expectedManifestSha256,
    observedAt: new Date().toISOString(),
    checks: [],
    runs: [],
    limitations: [...LIMITATIONS],
  };
  let tempRoot: string | undefined;
  let browser: Browser | undefined;
  let server: http.Server | undefined;
  let sourceVerified = false;
  const check = (
    id: string,
    result: 'pass' | 'fail' | 'unknown',
    detail: string,
  ) => receipt.checks.push({ id, result, detail });
  try {
    const captured = await captureFactoryManifestAsync(input);
    if (captured.manifestSha256 !== input.expectedManifestSha256) {
      receipt.status = 'stale';
      check(
        'manifest_before',
        'fail',
        'Current source differs from the registered build.',
      );
      return receipt;
    }
    sourceVerified = true;
    check(
      'manifest_before',
      'pass',
      'Source bytes match the expected host manifest.',
    );
    if (!/\.html?$/i.test(input.entrypoint))
      throw new Error('The HTML5 verifier requires an HTML entrypoint');
    let chromium: (typeof import('playwright'))['chromium'];
    let executable: string | undefined;
    try {
      ({ chromium } = await import('playwright'));
      const candidates = input.browserExecutablePath
        ? [input.browserExecutablePath]
        : [
            chromium.executablePath(),
            ...(process.platform === 'darwin'
              ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
              : []),
          ];
      executable = candidates.find(
        (candidate) =>
          path.isAbsolute(candidate) &&
          fs.existsSync(candidate) &&
          fs.statSync(candidate).isFile(),
      );
      if (!executable)
        throw new Error(
          'No configured or installed Chromium executable is available',
        );
    } catch (error) {
      receipt.status = 'unavailable';
      check('browser_runtime', 'unknown', shortError(error));
      return receipt;
    }
    tempRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'factory-html5-smoke-')),
    );
    fs.chmodSync(tempRoot, 0o700);
    const snapshot = await importFactorySourceAsync({
      ...input,
      destinationRoot: path.join(tempRoot, 'snapshot'),
    });
    if (snapshot.manifestSha256 !== input.expectedManifestSha256) {
      receipt.status = 'stale';
      check(
        'snapshot_manifest',
        'fail',
        'Source changed before the immutable smoke snapshot.',
      );
      return receipt;
    }
    const bytes = new Map<string, Buffer>();
    for (const file of snapshot.files) {
      const read = readBoundedRegularFileNoFollowSync(
        path.join(snapshot.sourceRoot, file.path),
        {
          maxBytes: file.size,
          oversize: 'reject',
          requireSingleLink: true,
        },
      );
      if (
        read.size !== file.size ||
        createHash('sha256').update(read.buffer).digest('hex') !== file.sha256
      )
        throw new Error('Snapshot bytes no longer match the expected manifest');
      bytes.set(file.path, read.buffer);
    }
    check(
      'pinned_bytes',
      'pass',
      `${bytes.size} files were read once with no-follow and verified against exact hashes before serving.`,
    );
    let origin = '';
    let requests = 0;
    let servedBytes = 0;
    server = http.createServer((request, response) => {
      try {
        if (
          !['GET', 'HEAD'].includes(request.method ?? '') ||
          ++requests > 8192 ||
          `http://${request.headers.host}` !== origin
        )
          throw new Error('Request rejected');
        const url = new URL(request.url ?? '/', origin);
        if (url.origin !== origin) throw new Error('Origin rejected');
        const relative = decodeURIComponent(url.pathname).slice(1);
        const data = bytes.get(relative);
        if (!data && relative === 'favicon.ico') {
          response.writeHead(204);
          response.end();
          return;
        }
        if (!data) {
          response.writeHead(404);
          response.end('Not in captured manifest');
          return;
        }
        servedBytes += data.length;
        if (servedBytes > snapshot.totalBytes * 8 + 1024 * 1024)
          throw new Error('Request byte budget exceeded');
        response.setHeader(
          'Content-Type',
          MIME[path.extname(relative).toLowerCase()] ??
            'application/octet-stream',
        );
        response.setHeader('Content-Length', data.length);
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader(
          'Content-Security-Policy',
          "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'",
        );
        response.end(request.method === 'HEAD' ? undefined : data);
      } catch {
        response.writeHead(403);
        response.end('Request rejected');
      }
    });
    server.on('connect', (_request, socket) => {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No loopback server address');
    origin = `http://127.0.0.1:${address.port}`;
    try {
      browser = await chromium.launch({
        executablePath: executable,
        headless: true,
        chromiumSandbox: true,
        timeout: 10_000,
        proxy: { server: origin, bypass: '127.0.0.1' },
        args: [
          '--disable-background-networking',
          '--disable-extensions',
          '--disable-component-update',
          '--dns-prefetch-disable',
          '--disable-sync',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--autoplay-policy=user-gesture-required',
          '--js-flags=--max-old-space-size=256',
        ],
      });
    } catch (error) {
      receipt.status = 'unavailable';
      check('browser_runtime', 'unknown', shortError(error));
      return receipt;
    }
    receipt.browser = {
      name: 'chromium',
      version: browser.version(),
      headless: true,
    };
    check(
      'browser_runtime',
      'pass',
      'Isolated headless Chromium context; no user profile or browser session reused.',
    );
    for (const viewport of timing.viewports) {
      const run = await observeViewport(
        browser,
        origin,
        input,
        viewport,
        timing,
      );
      receipt.runs.push(run);
      check(
        `${viewport.device}_${viewport.width}x${viewport.height}`,
        run.status === 'passed' ? 'pass' : 'fail',
        run.error ??
          `Startup, bounded render, viewport fit, console/page/local-request errors checked; ${run.blockedRequests.length} blocked network requests.`,
      );
    }
    receipt.status = receipt.runs.every((run) => run.status === 'passed')
      ? 'passed'
      : 'failed';
    check(
      'platform_and_human_acceptance',
      'unknown',
      'Offline startup smoke cannot prove live platform SDK behavior, full gameplay or human acceptance.',
    );
  } catch (error) {
    check('smoke_execution', 'fail', shortError(error));
  } finally {
    if (browser) await deadline(browser.close(), 5000).catch(() => {});
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (sourceVerified) {
      try {
        const after = await captureFactoryManifestAsync(input);
        const matches = after.manifestSha256 === input.expectedManifestSha256;
        check(
          'manifest_after',
          matches ? 'pass' : 'fail',
          matches
            ? 'Source still matches the verified build after smoke.'
            : 'Source changed during smoke; receipt is stale.',
        );
        if (!matches) receipt.status = 'stale';
      } catch (error) {
        check('manifest_after', 'fail', shortError(error));
        receipt.status = 'stale';
      }
    }
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  return receipt;
}
