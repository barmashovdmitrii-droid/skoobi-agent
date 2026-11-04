import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { captureFactoryManifestAsync } from './game-factory-artifacts.js';
import { verifyFactoryHtml5Build } from './game-factory-html5-check.js';
import type { FactoryHtml5CheckInput } from './game-factory-html5-check.js';

let root: string;
let source: string;

const BASE_HTML =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style><canvas width="320" height="180"></canvas><script src="game.js"></script>';
const DRAW =
  'const c=document.querySelector("canvas");const g=c.getContext("2d");g.fillStyle="#148aaf";g.fillRect(0,0,320,180);';

async function request(extra: Partial<FactoryHtml5CheckInput> = {}) {
  const input = {
    sourceRoot: source,
    entrypoint: 'index.html',
    allowedRoots: [root],
  };
  const captured = await captureFactoryManifestAsync(input);
  return {
    ...input,
    expectedManifestSha256: captured.manifestSha256,
    settleMs: 120,
    ...extra,
  };
}

async function browserAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    return (
      fs.existsSync(chromium.executablePath()) ||
      fs.existsSync(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      )
    );
  } catch {
    return false;
  }
}
const hasBrowser = await browserAvailable();

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-browser-test-')),
  );
  source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'index.html'), BASE_HTML);
  fs.writeFileSync(path.join(source, 'game.js'), DRAW);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('factory exact-build offline HTML5 smoke', () => {
  it('reports a stale registered hash before launching any browser', async () => {
    const input = await request();
    fs.appendFileSync(path.join(source, 'game.js'), '\n// new revision');
    const result = await verifyFactoryHtml5Build(input);
    expect(result.status).toBe('stale');
    expect(result.runs).toEqual([]);
    expect(
      result.checks.find((check) => check.id === 'manifest_before')?.result,
    ).toBe('fail');
  });

  it('reports an unavailable browser explicitly without an invented pass', async () => {
    const result = await verifyFactoryHtml5Build(
      await request({
        browserExecutablePath: path.join(root, 'missing-browser'),
      }),
    );
    expect(result.status).toBe('unavailable');
    expect(result.runs).toEqual([]);
    expect(
      result.checks.find((check) => check.id === 'manifest_after')?.result,
    ).toBe('pass');
  });

  it.runIf(hasBrowser)(
    'observes actual canvas bytes in desktop and mobile emulation with honest audio scope',
    async () => {
      fs.appendFileSync(
        path.join(source, 'game.js'),
        '\nconst audio = new AudioContext();',
      );
      const result = await verifyFactoryHtml5Build(await request());
      expect(result.status, JSON.stringify(result)).toBe('passed');
      expect(result.runs.map((run) => run.device)).toEqual([
        'desktop_browser',
        'mobile_emulation',
      ]);
      for (const run of result.runs) {
        expect(run.render?.sampledNonBlankCanvases).toBe(1);
        expect(run.screenshotSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(run.audio?.audibleSoundVerified).toBe(false);
        expect(run.audio?.contextStates.length).toBeGreaterThan(0);
      }
      expect(
        result.checks.find((check) => check.id === 'manifest_after')?.result,
      ).toBe('pass');
      expect(result.limitations.join(' ')).toContain('not a physical phone');
    },
    30_000,
  );

  it.runIf(hasBrowser)(
    'detects real page errors, console errors and missing local assets',
    async () => {
      fs.appendFileSync(
        path.join(source, 'game.js'),
        '\nconsole.error("fixture console failure");fetch("missing.json");throw new Error("fixture page failure");',
      );
      const result = await verifyFactoryHtml5Build(
        await request({
          viewports: [{ device: 'desktop_browser', width: 800, height: 600 }],
        }),
      );
      expect(result.status).toBe('failed');
      expect(result.runs[0].consoleErrors.join(' ')).toContain(
        'fixture console failure',
      );
      expect(result.runs[0].pageErrors.join(' ')).toContain(
        'fixture page failure',
      );
      expect(result.runs[0].failedLocalRequests.join(' ')).toContain(
        'missing.json',
      );
    },
    30_000,
  );

  it.runIf(hasBrowser)(
    'blocks HTTP and WebSocket connections to a different local origin without reaching it',
    async () => {
      let reached = 0;
      const other = http.createServer((_req, res) => {
        reached += 1;
        res.end('must not be read');
      });
      other.on('upgrade', (_req, socket) => {
        reached += 1;
        socket.destroy();
      });
      await new Promise<void>((resolve) =>
        other.listen(0, '127.0.0.1', resolve),
      );
      const address = other.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture port');
      try {
        fs.appendFileSync(
          path.join(source, 'game.js'),
          `\nfetch("http://127.0.0.1:${address.port}/outside?secret=not-in-receipt").catch(()=>{});new WebSocket("ws://127.0.0.1:${address.port}/socket");`,
        );
        const result = await verifyFactoryHtml5Build(
          await request({
            viewports: [{ device: 'desktop_browser', width: 800, height: 600 }],
          }),
        );
        expect(result.status).toBe('failed');
        expect(reached).toBe(0);
        expect(result.runs[0].blockedRequests.length).toBeGreaterThan(0);
        expect(result.runs[0].blockedRequests.join(' ')).not.toContain(
          'secret=',
        );
      } finally {
        other.closeAllConnections();
        await new Promise<void>((resolve) => other.close(() => resolve()));
      }
    },
    30_000,
  );

  it.runIf(hasBrowser)(
    'does not pass an empty canvas just because a canvas element exists',
    async () => {
      fs.writeFileSync(path.join(source, 'game.js'), '// no drawing');
      const result = await verifyFactoryHtml5Build(
        await request({
          viewports: [{ device: 'desktop_browser', width: 800, height: 600 }],
        }),
      );
      expect(result.status).toBe('failed');
      expect(result.runs[0].render?.visibleCanvasCount).toBe(1);
      expect(result.runs[0].render?.sampledNonBlankCanvases).toBe(0);
    },
    30_000,
  );

  it.runIf(hasBrowser)(
    'samples a real WebGL render during an animation frame',
    async () => {
      fs.writeFileSync(
        path.join(source, 'game.js'),
        'const c=document.querySelector("canvas");const gl=c.getContext("webgl");if(!gl)throw Error("WebGL unavailable");function draw(){gl.clearColor(.2,.5,.8,1);gl.clear(gl.COLOR_BUFFER_BIT);requestAnimationFrame(draw)}draw();',
      );
      const result = await verifyFactoryHtml5Build(
        await request({
          viewports: [{ device: 'desktop_browser', width: 800, height: 600 }],
        }),
      );
      expect(result.status, JSON.stringify(result)).toBe('passed');
      expect(result.runs[0].render?.sampledNonBlankCanvases).toBe(1);
    },
    30_000,
  );

  it.runIf(hasBrowser)(
    'invalidates a receipt when source changes while the pinned copy is being checked',
    async () => {
      const input = await request({
        settleMs: 1200,
        viewports: [{ device: 'desktop_browser', width: 800, height: 600 }],
      });
      const checking = verifyFactoryHtml5Build(input);
      const timer = setTimeout(
        () =>
          fs.appendFileSync(
            path.join(source, 'game.js'),
            '\n// concurrent source change',
          ),
        500,
      );
      try {
        const result = await checking;
        expect(result.status, JSON.stringify(result)).toBe('stale');
        expect(
          result.checks.some(
            (check) => check.id === 'manifest_after' && check.result === 'fail',
          ),
        ).toBe(true);
      } finally {
        clearTimeout(timer);
      }
    },
    30_000,
  );
});
