import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from 'vitest';

const codeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const cli = path.join(
  codeRoot,
  'agent/skills/game-factory/scripts/create-html5.mjs',
);
const projectId = 'fixture-garden',
  saveKey = `${projectId}:local:save`;
let root: string,
  server: http.Server,
  url: string,
  browser: Browser,
  context: BrowserContext,
  page: Page,
  errors: string[],
  requests: string[];
beforeAll(async () => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-html5-template-')),
  );
  fs.chmodSync(root, 0o700);
  execFileSync(
    process.execPath,
    [cli, '--destination', root, '--project-id', projectId],
    { encoding: 'utf8', timeout: 5000 },
  );
  server = http.createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(
          new URL(request.url || '/', 'http://fixture').pathname,
        ),
        file = path.resolve(
          root,
          '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''),
        );
      if (
        !file.startsWith(root + path.sep) ||
        request.method !== 'GET' ||
        !fs.statSync(file).isFile()
      ) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': file.endsWith('.html')
          ? 'text/html'
          : file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'text/plain',
        'Cache-Control': 'no-store',
      });
      response.end(fs.readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true });
}, 20000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(async () => {
  errors = [];
  requests = [];
  context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 820, height: 950 },
  });
  await context.route('**/*', (route) => {
    const target = route.request().url();
    requests.push(target);
    return target.startsWith(url + '/') ? route.continue() : route.abort();
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
});
afterEach(async () => {
  await context.close();
  expect(errors).toEqual([]);
});
const open = async (profile = 'local') => {
  await page.goto(`${url}/${profile}/`);
  await page.locator('#play').waitFor({ state: 'visible' });
};
const walk = async (keys: string[]) => {
  for (const key of keys) await page.keyboard.press(key);
};
const winningPath = [
  'ArrowRight',
  'ArrowUp',
  'ArrowRight',
  'ArrowRight',
  'ArrowRight',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowLeft',
  'ArrowLeft',
  'ArrowLeft',
  'ArrowUp',
];

it('creates distinct packages and refuses to overwrite existing work', () => {
  expect(fs.readdirSync(root).sort()).toEqual([
    'crazygames-basic',
    'local',
    'yandex',
  ]);
  for (const profile of ['local', 'yandex', 'crazygames-basic']) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, profile, 'template.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({
      platform: profile,
      entrypoint: 'index.html',
      ads: false,
      payments: false,
      publication: 'prepare_only',
      portalVerified: false,
    });
  }
  const before = fs.readFileSync(path.join(root, 'local', 'game.js'), 'utf8');
  expect(() =>
    execFileSync(process.execPath, [cli, '--destination', root], {
      stdio: 'pipe',
    }),
  ).toThrow();
  expect(fs.readFileSync(path.join(root, 'local', 'game.js'), 'utf8')).toBe(
    before,
  );
});

it('finishes and restarts a real game through keyboard input, saving the record', async () => {
  await open();
  await page.locator('#play').click();
  await walk(winningPath);
  expect(await page.locator('#heading').textContent()).toBe(
    'The garden is glowing!',
  );
  expect(await page.locator('#score').textContent()).toBe('Lights: 5 / 5');
  expect(await page.locator('#record').textContent()).toContain('Best: 12');
  await page.locator('#play').click();
  expect(await page.locator('#panel').isVisible()).toBe(false);
  expect(await page.locator('#score').textContent()).toBe('Lights: 0 / 5');
  await page.reload();
  await page.locator('#play').waitFor({ state: 'visible' });
  expect(await page.locator('#record').textContent()).toContain(
    'Gardens restored: 1',
  );
  expect(requests.every((request) => request.startsWith(url + '/'))).toBe(true);
  expect(requests.some((request) => request.endsWith('/sdk.js'))).toBe(false);
}, 15000);

it('preserves manual pause and saved progress across reload, and localizes controls', async () => {
  await open();
  await page.locator('#play').click();
  await page.keyboard.press('ArrowRight');
  await page.locator('#pause').click();
  await page.keyboard.press('ArrowUp');
  expect(await page.locator('#steps').textContent()).toBe('Steps left: 23');
  await page.locator('#mute').click();
  await page.locator('#language').selectOption('ru');
  expect(await page.locator('#heading').textContent()).toBe(
    'Можно передохнуть',
  );
  await page.reload();
  await page.locator('#play').waitFor({ state: 'visible' });
  expect(await page.locator('#play').textContent()).toBe('Продолжить');
  expect(await page.locator('#mute').getAttribute('aria-pressed')).toBe('true');
  await page.locator('#play').click();
  expect(await page.locator('#score').textContent()).toBe('Огоньки: 1 / 5');
  expect(await page.locator('#steps').textContent()).toBe('Осталось шагов: 23');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  expect(await page.locator('#steps').textContent()).toBe('Осталось шагов: 23');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowUp');
  expect(await page.locator('#steps').textContent()).toBe('Осталось шагов: 22');
}, 15000);

it('supports resize, adjacent tile pointer input and a real loss/retry loop', async () => {
  await page.setViewportSize({ width: 360, height: 740 });
  await open();
  await page.locator('#play').click();
  const bounds = await page.locator('#game').boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.click(
    bounds!.x + (bounds!.width * 2.5) / 7,
    bounds!.y + (bounds!.height * 2.5) / 5,
  );
  expect(await page.locator('#score').textContent()).toBe('Lights: 1 / 5');
  await page.setViewportSize({ width: 1024, height: 850 });
  expect(
    await page.evaluate(
      () =>
        (globalThis as any).document.documentElement.scrollWidth <=
        (globalThis as any).innerWidth,
    ),
  ).toBe(true);
  for (let i = 0; i < 23; i++)
    await page
      .locator(`[data-move="${i % 2 === 0 ? 'left' : 'right'}"]`)
      .click();
  expect(await page.locator('#heading').textContent()).toBe(
    'The lantern needs a rest',
  );
  await page.locator('#play').click();
  expect(await page.locator('#steps').textContent()).toBe('Steps left: 24');
}, 15000);

it('migrates an explicit old save fixture and tolerates unavailable storage', async () => {
  await context.addInitScript(
    ({ key }) =>
      localStorage.setItem(
        key,
        JSON.stringify({ version: 1, best: 14, sound: false, lang: 'ru' }),
      ),
    { key: saveKey },
  );
  await open();
  expect(await page.locator('#record').textContent()).toContain('Рекорд: 14');
  expect(await page.locator('#mute').getAttribute('aria-pressed')).toBe('true');
  await page.locator('#play').click();
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    saveKey,
  );
  expect(saved.version).toBe(2);
  const blocked = await browser.newContext();
  await blocked.addInitScript(() =>
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new Error('storage blocked fixture');
      },
    }),
  );
  const other = await blocked.newPage();
  try {
    await other.goto(`${url}/local/`);
    await other.locator('#play').click();
    await other.keyboard.press('ArrowRight');
    expect(await other.locator('#score').textContent()).toBe('Lights: 1 / 5');
    expect(await other.locator('#record').textContent()).toBe(
      'Progress cannot be saved in this browser.',
    );
  } finally {
    await blocked.close();
  }
}, 15000);

it('Yandex SDK fixture: waits for init, emits ready once and composes platform/manual pause without portal claims', async () => {
  await page.route('**/sdk.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.fixtureSdk={calls:[],handlers:{}};window.YaGames={init:async()=>{window.fixtureSdk.calls.push('init');await new Promise(r=>setTimeout(r,60));return {environment:{i18n:{lang:'en'}},features:{LoadingAPI:{ready(){window.fixtureSdk.calls.push('ready')}},GameplayAPI:{start(){window.fixtureSdk.calls.push('start')},stop(){window.fixtureSdk.calls.push('stop')}}},on(name,cb){window.fixtureSdk.handlers[name]=cb},off(name){delete window.fixtureSdk.handlers[name]}}}};`,
    }),
  );
  await open('yandex');
  expect(
    await page.evaluate(() => (globalThis as any).fixtureSdk.calls),
  ).toEqual(['init', 'ready']);
  await page.locator('#play').click();
  await page.keyboard.press('ArrowRight');
  await page.locator('#pause').click();
  await page.evaluate(() => {
    (globalThis as any).fixtureSdk.handlers.game_api_pause();
    (globalThis as any).fixtureSdk.handlers.game_api_resume();
  });
  expect(await page.locator('#heading').textContent()).toBe('Take a breath');
  await page.keyboard.press('ArrowUp');
  expect(await page.locator('#steps').textContent()).toBe('Steps left: 23');
  await page.locator('#play').click();
  await page.evaluate(() =>
    (globalThis as any).fixtureSdk.handlers.game_api_pause(),
  );
  expect(await page.locator('#play').isVisible()).toBe(false);
  await page.evaluate(() =>
    (globalThis as any).fixtureSdk.handlers.game_api_resume(),
  );
  expect(await page.locator('#panel').isVisible()).toBe(false);
  const calls = await page.evaluate(() => (globalThis as any).fixtureSdk.calls);
  expect(calls).toEqual([
    'init',
    'ready',
    'start',
    'stop',
    'start',
    'stop',
    'start',
  ]);
}, 15000);

it('CrazyGames Basic runs the complete loop with no SDK requests', async () => {
  await open('crazygames-basic');
  await page.locator('#play').click();
  await walk(winningPath);
  expect(await page.locator('#heading').textContent()).toBe(
    'The garden is glowing!',
  );
  expect(requests.some((request) => /sdk|crazygames\.com/.test(request))).toBe(
    false,
  );
}, 15000);
