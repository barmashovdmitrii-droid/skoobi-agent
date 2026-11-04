// Host-owned checker. The core verifier pins these exact bytes before execution.
// Input arrives on stdin; no key, credentials or agent instructions are accepted.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const EXTRACT = String.raw`
import json, os, pathlib, stat, sys, unicodedata, zipfile
request=json.load(sys.stdin)
target=pathlib.Path(request['directory'])
try:
    with zipfile.ZipFile(request['archive']) as archive:
        entries=archive.infolist()
        if not entries or len(entries)>256: raise ValueError('archive_limit')
        names=set(); total=0
        for entry in entries:
            name=entry.filename
            parts=name.rstrip('/').split('/')
            mode=entry.external_attr >> 16
            if (name!=entry.orig_filename or not name or len(name)>240 or
                name.startswith('/') or '\\' in name or ':' in name or
                any(ord(c)<32 for c in name) or
                any(p in ('','.','..') for p in parts) or
                (stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR)) or
                entry.flag_bits & 1 or entry.compress_type not in (0,8)):
                raise ValueError('archive_unsafe')
            key=unicodedata.normalize('NFC',name.rstrip('/')).casefold()
            if key in names: raise ValueError('archive_unsafe')
            names.add(key)
            total+=entry.file_size
            if (entry.file_size>8*1024*1024 or total>32*1024*1024 or
                entry.file_size>max(1024,entry.compress_size)*200):
                raise ValueError('archive_limit')
        # The destination is a fresh host-owned directory; never extractall().
        for entry in entries:
            output=target.joinpath(*entry.filename.rstrip('/').split('/'))
            if entry.is_dir(): output.mkdir(parents=True,exist_ok=True); continue
            output.parent.mkdir(parents=True,exist_ok=True)
            count=0
            with archive.open(entry) as source, open(output,'xb') as dest:
                os.chmod(output,0o600)
                while True:
                    chunk=source.read(65536)
                    if not chunk: break
                    count+=len(chunk)
                    if count>entry.file_size or count>8*1024*1024: raise ValueError('archive_limit')
                    dest.write(chunk)
                if count!=entry.file_size: raise ValueError('archive_invalid')
    print(json.dumps({'ok':True}))
except ValueError as error:
    print(json.dumps({'ok':False,'code':str(error)}))
except Exception:
    print(json.dumps({'ok':False,'code':'archive_invalid'}))
`;

let browser;
let context;
let server;
let request;
let result = { status: 'inconclusive', code: 'checker_error', checks: [] };
const checks = [];
const record = (id) => checks.push({ id, outcome: 'passed' });
process.once('SIGTERM', () => {
  const hardExit = setTimeout(() => process.exit(2), 1500);
  Promise.resolve().then(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    clearTimeout(hardExit);
    process.exit(2);
  });
});
try {
  const input = fs.readFileSync(0, 'utf8');
  if (input.length > 16_384) throw new Error('request_limit');
  request = JSON.parse(input);
  const extracted = spawnSync(request.pythonCommand, ['-I', '-c', EXTRACT], {
    input: JSON.stringify({
      archive: request.archive,
      directory: request.directory,
    }),
    encoding: 'utf8',
    timeout: 4000,
    maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  if (extracted.error || extracted.status !== 0) {
    result.code = 'environment_unavailable';
  } else {
    const unpacked = JSON.parse(extracted.stdout);
    if (!unpacked.ok) {
      result = { status: 'failed', code: unpacked.code, checks };
    } else {
      record('archive_safety');
      const entry = path.join(
        request.directory,
        request.requirements.entrypoint,
      );
      if (!fs.existsSync(entry) || !fs.lstatSync(entry).isFile()) {
        result = { status: 'failed', code: 'entry_missing', checks };
      } else {
        let chromium;
        try {
          const playwright = await import(
            pathToFileURL(request.playwrightModule).href
          );
          chromium = playwright.chromium ?? playwright.default?.chromium;
          browser = await chromium.launch({
            executablePath: request.browserExecutable,
            headless: true,
            chromiumSandbox: true,
            timeout: 7000,
            args: [
              '--disable-background-networking',
              '--disable-extensions',
              '--disable-component-update',
              '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
              '--js-flags=--max-old-space-size=64',
            ],
          });
        } catch {
          result.code = 'environment_unavailable';
        }
        if (browser) {
          let forbidden = false;
          let requests = 0;
          const mime = {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
          };
          server = http.createServer((req, res) => {
            try {
              if (req.method !== 'GET' || ++requests > 128)
                throw new Error('request_limit');
              const relative = decodeURIComponent(
                new URL(req.url, 'http://localhost').pathname,
              ).slice(1);
              const filename = path.resolve(request.directory, relative);
              if (!filename.startsWith(`${request.directory}${path.sep}`))
                throw new Error('path');
              const stat = fs.lstatSync(filename);
              if (!stat.isFile() || stat.isSymbolicLink())
                throw new Error('file');
              res.setHeader(
                'Content-Type',
                mime[path.extname(filename)] || 'application/octet-stream',
              );
              res.setHeader(
                'Content-Security-Policy',
                "default-src 'self'; script-src 'self'; connect-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
              );
              res.setHeader('X-Content-Type-Options', 'nosniff');
              res.end(fs.readFileSync(filename));
            } catch {
              res.statusCode = 404;
              res.end('Not found');
            }
          });
          await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
          });
          const origin = `http://127.0.0.1:${server.address().port}`;
          context = await browser.newContext({
            serviceWorkers: 'block',
            acceptDownloads: false,
          });
          context.setDefaultTimeout(1500);
          context.setDefaultNavigationTimeout(2000);
          await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.origin === origin && route.request().method() === 'GET')
              return route.continue();
            forbidden = true;
            return route.abort('blockedbyclient');
          });
          await context.routeWebSocket('**/*', (socket) => {
            forbidden = true;
            socket.close();
          });
          await context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: false,
          });
          const page = await context.newPage();
          const failures = [];
          page.on('pageerror', () => failures.push('page_error'));
          page.on('popup', (popup) => {
            forbidden = true;
            void popup.close();
          });
          page.on('download', () => {
            forbidden = true;
          });
          const assertVisibleText = async (expectation) => {
            const locator = page.locator(expectation.selector);
            await locator.waitFor({ state: 'visible' });
            const deadline = Date.now() + 1500;
            while (true) {
              const text = (await locator.innerText())
                .replace(/\s+/g, ' ')
                .trim();
              if (text === expectation.text) return;
              if (Date.now() >= deadline) throw new Error('expectation_failed');
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          };
          try {
            const response = await page.goto(
              `${origin}/${request.requirements.entrypoint}`,
            );
            if (!response?.ok()) throw new Error('entry_response');
            await assertVisibleText(request.requirements.initial);
            record('entry_opened');
            for (const [index, step] of request.requirements.steps.entries()) {
              if (step.action === 'click')
                await page.locator(step.selector).click();
              else await page.locator(step.selector).press(step.key);
              await assertVisibleText(step.expect);
              if (step.path && new URL(page.url()).pathname !== `/${step.path}`)
                throw new Error('route_failed');
              record(`step_${index + 1}`);
            }
            if (forbidden || requests > 128 || failures.length)
              throw new Error('browser_policy');
            result = { status: 'passed', code: 'checks_passed', checks };
          } catch {
            result = {
              status: 'failed',
              code: forbidden ? 'network_blocked' : 'scenario_failed',
              checks,
            };
          }
          // Failure evidence is local-only. The host enforces its retention cap.
          if (result.status === 'failed') {
            await context.tracing.stop({ path: request.tracePath });
            if (fs.statSync(request.tracePath).size > 8 * 1024 * 1024)
              fs.unlinkSync(request.tracePath);
          } else await context.tracing.stop();
        }
      }
    }
  }
} catch {
  result = { status: 'inconclusive', code: 'checker_error', checks };
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
process.stdout.write(`${JSON.stringify(result)}\n`);
