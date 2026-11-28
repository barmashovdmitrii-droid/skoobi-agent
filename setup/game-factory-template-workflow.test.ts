import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { expect, it, vi } from 'vitest';
import {
  _initTestDatabase,
  storeChatMetadata,
  storeMessage,
} from '../packages/core/src/orchestrator/db.js';
import { executeGameFactoryRequest } from '../packages/core/src/orchestrator/game-factory-service.js';
import type {
  FactoryActor,
  FactoryConfiguration,
  FactoryProject,
  FactoryBuild,
} from '../packages/core/src/orchestrator/game-factory-contracts.js';

const codeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const cli = path.join(
  codeRoot,
  'agent/skills/game-factory/scripts/create-html5.mjs',
);
const sha = (bytes: Buffer) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
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
const sdkFixture = `window.__syntheticSdk={ready:0,start:0,stop:0};window.YaGames={init:async()=>({environment:{i18n:{lang:'en'}},features:{LoadingAPI:{ready(){window.__syntheticSdk.ready++}},GameplayAPI:{start(){window.__syntheticSdk.start++},stop(){window.__syntheticSdk.stop++}}},on(){},off(){}})};`;

interface FixtureBrowserGlobal {
  document: { documentElement: { scrollWidth: number; scrollHeight: number } };
  innerWidth: number;
  innerHeight: number;
  __syntheticSdk: { ready: number };
}

/** Ordinary input on the exact captured files. The Yandex shim is transport-only,
 * clearly synthetic, and is never written into the source/build/ZIP. */
async function playCaptured(
  build: FactoryBuild,
  profile: string,
  evidence?: string,
) {
  const bytes = new Map(
    build.files.map((file) => {
      const value = fs.readFileSync(path.join(build.root, file.path));
      expect(sha(value)).toBe(file.sha256);
      return ['/' + file.path, value] as const;
    }),
  );
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://fixture').pathname;
    const name = pathname === '/' ? '/index.html' : pathname;
    const value = bytes.get(name);
    if (request.method !== 'GET' || !value) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': name.endsWith('.js')
        ? 'text/javascript'
        : name.endsWith('.html')
          ? 'text/html'
          : name.endsWith('.css')
            ? 'text/css'
            : 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(value);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 900, height: 950 },
    serviceWorkers: 'block',
  });
  const requests: string[] = [],
    errors: string[] = [];
  try {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      requests.push(url);
      if (profile === 'yandex' && url === origin + '/sdk.js')
        return route.fulfill({
          status: 200,
          contentType: 'text/javascript',
          body: sdkFixture,
        });
      return url.startsWith(origin + '/') ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + '/');
    await page.locator('#play').click();
    await page.keyboard.press(winningPath[0]);
    await page.locator('#pause').click();
    const paused = await page.locator('#steps').textContent();
    await page.keyboard.press('ArrowUp');
    expect(await page.locator('#steps').textContent()).toBe(paused);
    await page.locator('#play').click();
    for (const key of winningPath.slice(1)) await page.keyboard.press(key);
    expect(await page.locator('#heading').textContent()).toBe(
      'The garden is glowing!',
    );
    expect(await page.locator('#score').textContent()).toBe('Lights: 5 / 5');
    expect(await page.locator('#record').textContent()).toContain('Best: 12');
    if (evidence)
      await page.screenshot({
        path: path.join(evidence, `${profile}-finished.png`),
      });
    await page.locator('#play').click();
    expect(await page.locator('#score').textContent()).toBe('Lights: 0 / 5');
    await page.reload();
    await page.locator('#play').waitFor({ state: 'visible' });
    expect(await page.locator('#record').textContent()).toContain(
      'Gardens restored: 1',
    );
    for (const viewport of [
      { width: 844, height: 390 },
      { width: 360, height: 740 },
    ]) {
      await page.setViewportSize(viewport);
      expect(
        await page.evaluate(() => {
          const frame = globalThis as unknown as FixtureBrowserGlobal;
          return {
            width:
              frame.document.documentElement.scrollWidth <= frame.innerWidth,
            height:
              frame.document.documentElement.scrollHeight <= frame.innerHeight,
          };
        }),
      ).toEqual({ width: true, height: true });
      for (const selector of [
        '#language',
        '#mute',
        '#pause',
        '[data-move="up"]',
        '[data-move="right"]',
      ]) {
        const bounds = await page.locator(selector).boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      }
      if (viewport.width === 844) {
        await page.locator('#play').click();
        await page.locator('[data-move="right"]').click();
        expect(await page.locator('#score').textContent()).toBe(
          'Lights: 1 / 5',
        );
      }
      await page.locator('#language').selectOption('ru');
      expect(
        await page.evaluate(() => {
          const frame = globalThis as unknown as FixtureBrowserGlobal;
          return {
            width:
              frame.document.documentElement.scrollWidth <= frame.innerWidth,
            height:
              frame.document.documentElement.scrollHeight <= frame.innerHeight,
          };
        }),
      ).toEqual({ width: true, height: true });
      const pauseBounds = await page.locator('#pause').boundingBox();
      expect(pauseBounds!.x + pauseBounds!.width).toBeLessThanOrEqual(
        viewport.width,
      );
      if (evidence)
        await page.screenshot({
          path: path.join(
            evidence,
            `${profile}-${viewport.width}x${viewport.height}.png`,
          ),
        });
    }
    expect(errors).toEqual([]);
    expect(requests.every((url) => url.startsWith(origin + '/'))).toBe(true);
    if (profile === 'yandex')
      expect(
        await page.evaluate(
          () =>
            (globalThis as unknown as FixtureBrowserGlobal).__syntheticSdk
              .ready,
        ),
      ).toBe(1);
    else expect(requests.some((url) => url.endsWith('/sdk.js'))).toBe(false);
    return {
      profile,
      manifestSha256: build.manifestSha256,
      ordinaryInputLoop: true,
      pause: true,
      restart: true,
      savedProgressAfterReload: true,
      mobileEmulationFits: true,
      pageErrors: errors,
      externalRequests: 0,
      sdk:
        profile === 'yandex'
          ? 'synthetic_loopback_fixture_only'
          : 'not_used_basic',
      audibleListeningVerified: false,
      portalVerified: false,
    };
  } finally {
    await context.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it('runs a fresh starter through canonical project QA and independently repeatable two-platform ZIP preparation', async () => {
  _initTestDatabase();
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-template-cycle-')),
  );
  fs.chmodSync(root, 0o700);
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { mode: 0o700 });
  const identity = {
    channel: 'telegram' as const,
    chat_id: 'synthetic-template-chat',
    telegram_user_id: 'synthetic-template-owner',
    identity_id: 'synthetic-template-identity',
    telegram_message_origin: 'direct' as const,
    is_owner_sender: true,
  };
  let actor: FactoryActor = {
    identityId: identity.identity_id,
    tenantId: 'synthetic-template-tenant',
    chatJid: 'tg:synthetic-template-chat',
    channelChatId: identity.chat_id,
    senderId: identity.telegram_user_id,
    sourceGroup: 'synthetic-template-group',
    currentMessageIds: ['synthetic-request'],
    runId: 'synthetic-template-run',
    isPrimaryOwner: true,
  };
  const config: FactoryConfiguration = {
    version: 1,
    enabled: true,
    primaryOwnerIdentityId: actor.identityId,
    databasePath: path.join(root, 'factory.db'),
    workspaceRoot: work,
    actors: [
      {
        identityId: actor.identityId,
        tenantId: actor.tenantId,
        alias: 'synthetic-owner',
        canCreate: true,
        backends: ['agent'],
        sourceRoots: [],
      },
    ],
    accounts: [
      {
        alias: 'synthetic-crazygames',
        platform: 'crazygames',
        actorAliases: ['synthetic-owner'],
      },
      {
        alias: 'synthetic-yandex',
        platform: 'yandex',
        actorAliases: ['synthetic-owner'],
      },
    ],
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config), {
    mode: 0o600,
  });
  vi.stubEnv('SKOOBI_GAME_FACTORY_CONFIG', path.join(root, 'config.json'));
  const message = (id: string, content: string) => {
    storeChatMetadata(actor.chatJid, new Date().toISOString());
    storeMessage({
      id,
      chat_jid: actor.chatJid,
      sender: actor.senderId,
      sender_name: 'SYNTHETIC FIXTURE ONLY',
      content,
      timestamp: new Date().toISOString(),
      sender_identity: identity,
      is_bot_message: false,
    });
  };
  let project: FactoryProject | undefined,
    counter = 0;
  const call = async (action: string, args: Record<string, unknown> = {}) => {
    const result = (await executeGameFactoryRequest(actor, {
      operationId: `synthetic-template-${++counter}`,
      action,
      args,
      projectId: 'synthetic-garden',
      expectedRevision: project?.revision ?? 0,
    })) as Record<string, any>;
    if (result.project) project = result.project;
    return result;
  };
  // Optional retained evidence is explicitly test-only; no live messages, accounts,
  // settings, provider calls or existing project files are used by this scenario.
  const evidence = process.env.SKOOBI_TEST_FACTORY_CYCLE_EVIDENCE;
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
    expect(fs.realpathSync(evidence)).toBe(evidence);
  }
  try {
    message(
      'synthetic-request',
      'SYNTHETIC TEST ONLY: create a fresh starter and prepare two local packages. No publishing or spending.',
    );
    await call('create', {
      title: 'Synthetic template cycle',
      engine: 'canvas',
      brief: {
        goal: 'Test a complete fresh factory cycle',
        audience: 'Synthetic QA only',
        firstSession: 'Collect one lantern',
        coreLoop: 'Move, collect five lights, finish and restart',
        artDirection: 'Original starter canvas',
        acceptance: ['Finish through ordinary controls'],
        devices: ['desktop', 'mobile'],
        platforms: ['crazygames', 'yandex'],
      },
    });
    await call('plan', {
      tasks: [
        {
          id: 'fresh-loop',
          stage: 'playable',
          title: 'Synthetic fresh-loop acceptance',
          acceptance: ['Complete the first loop and save earned record'],
          dependencies: [],
          humanReviewRequired: true,
        },
      ],
    });
    const claimed = await call('claim', {
      taskId: 'fresh-loop',
      backend: 'agent',
    });
    execFileSync(
      process.execPath,
      [
        cli,
        '--destination',
        claimed.workDirectory,
        '--project-id',
        'synthetic-garden',
      ],
      { timeout: 5000, stdio: 'pipe' },
    );
    const repeatedRoot = path.join(claimed.workDirectory, 'reproduced');
    fs.mkdirSync(repeatedRoot, { mode: 0o700 });
    execFileSync(
      process.execPath,
      [cli, '--destination', repeatedRoot, '--project-id', 'synthetic-garden'],
      { timeout: 5000, stdio: 'pipe' },
    );
    const builds: Record<string, FactoryBuild> = {},
      repeatBuilds: Record<string, FactoryBuild> = {},
      plays: unknown[] = [];
    for (const profile of ['crazygames-basic', 'yandex']) {
      builds[profile] = (
        await call('build_capture', {
          token: claimed.claim.token,
          sourceRoot: path.join(claimed.workDirectory, profile),
          entrypoint: 'index.html',
          version: 'synthetic-1.0.0',
        })
      ).build;
      repeatBuilds[profile] = (
        await call('build_capture', {
          token: claimed.claim.token,
          sourceRoot: path.join(repeatedRoot, profile),
          entrypoint: 'index.html',
          version: 'synthetic-1.0.0',
        })
      ).build;
      expect(repeatBuilds[profile].manifestSha256).toBe(
        builds[profile].manifestSha256,
      );
      plays.push(await playCaptured(builds[profile], profile, evidence));
      await call('evidence_record', {
        buildId: builds[profile].id,
        kind: 'browser',
        criterion: `Synthetic integration fixture: ordinary input loop, pause/restart/save; ${profile === 'yandex' ? 'SDK transport is synthetic, not portal proof' : 'Basic profile uses no SDK'}`,
        result: 'pass',
      });
    }
    const cg = builds['crazygames-basic'];
    const smoke = await call('verify_build', { buildId: cg.id });
    const cgReceipt = await call('inspect', {
      section: 'check',
      receiptId: smoke.evidence.receiptId,
    });
    if (evidence)
      fs.writeFileSync(
        path.join(evidence, 'crazygames-smoke.private.json'),
        JSON.stringify(cgReceipt.receipt, null, 2) + '\n',
        { mode: 0o600 },
      );
    expect(smoke.checkStatus, JSON.stringify(cgReceipt.receipt)).toBe('passed');
    expect(smoke.fullGameplayVerified).toBe(false);
    const yandexSmoke = await call('verify_build', {
      buildId: builds.yandex.id,
    });
    expect(yandexSmoke.checkStatus).toBe('failed');
    const yandexReceipt = await call('inspect', {
      section: 'check',
      receiptId: yandexSmoke.evidence.receiptId,
    });
    expect(JSON.stringify(yandexReceipt.receipt.runs)).toContain('/sdk.js');
    for (const run of yandexReceipt.receipt.runs) {
      expect(run.render.viewportFits).toBe(true);
      expect(run.pageErrors).toEqual([]);
      expect(run.blockedRequests).toEqual([]);
      expect(run.failedLocalRequests.length).toBeGreaterThan(0);
      expect(
        run.failedLocalRequests.every((request: string) =>
          request.includes('/sdk.js'),
        ),
      ).toBe(true);
      expect(
        run.consoleErrors.every((error: string) => error.includes('404')),
      ).toBe(true);
    }
    await call('checkpoint', {
      token: claimed.claim.token,
      summary:
        'Synthetic first loop passed; Yandex portal SDK still requires real preview.',
      state: 'submitted',
      buildId: cg.id,
    });
    await call('release_claim', { token: claimed.claim.token });
    message(
      'synthetic-feedback',
      'SYNTHETIC FIXTURE ONLY: accept this first-loop fixture. This is not feedback from a real user or permission to publish.',
    );
    actor = { ...actor, currentMessageIds: ['synthetic-feedback'] };
    const feedback = await call('human_feedback', {
      buildId: cg.id,
      messageId: 'synthetic-feedback',
      quote: 'accept this first-loop fixture',
      result: 'pass',
    });
    await call('task_review', {
      taskId: 'fresh-loop',
      decision: 'accepted',
      note: 'Synthetic acceptance path only; no real human approval claimed.',
      evidenceIds: [smoke.evidence.id, feedback.evidence.id],
    });
    const packages = [];
    for (const profile of ['crazygames-basic', 'yandex']) {
      const platform = profile === 'yandex' ? 'yandex' : 'crazygames';
      const bundles = [];
      for (const build of [builds[profile], repeatBuilds[profile]]) {
        const release = await call('release_prepare', {
          buildId: build.id,
          platform,
          mode: platform === 'yandex' ? 'preview' : 'basic',
          accountAlias: `synthetic-${platform}`,
          sourceOfFirstPlayers:
            'Synthetic fixture only; no real audience contacted',
          reviewAt: new Date(Date.now() + 86400_000).toISOString(),
        });
        const packaged = await call('release_package', {
          releaseId: release.release.id,
        });
        expect(packaged.publicationAuthorized).toBe(false);
        expect(packaged.releaseReady).toBe(false);
        const bundle = packaged.release.bundle;
        expect(bundle.manifestSha256).toBe(build.manifestSha256);
        expect(sha(fs.readFileSync(bundle.path))).toBe(bundle.sha256);
        const entries = JSON.parse(
          execFileSync(
            '/usr/bin/python3',
            [
              '-c',
              'import json,sys,zipfile,hashlib\nwith zipfile.ZipFile(sys.argv[1]) as z: print(json.dumps({n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}))',
              bundle.path,
            ],
            { encoding: 'utf8', timeout: 5000 },
          ),
        );
        expect(Object.keys(entries).sort()).toEqual(
          build.files.map((f) => f.path).sort(),
        );
        for (const f of build.files) expect(entries[f.path]).toBe(f.sha256);
        expect(entries['sdk.js']).toBeUndefined();
        bundles.push(bundle);
      }
      expect(bundles[1].path).not.toBe(bundles[0].path);
      expect(bundles[1].sha256).toBe(bundles[0].sha256);
      if (evidence)
        fs.copyFileSync(bundles[0].path, path.join(evidence, `${profile}.zip`));
      packages.push({
        profile,
        manifestSha256: builds[profile].manifestSha256,
        zipSha256: bundles[0].sha256,
        bytes: bundles[0].bytes,
        independentRegenerationIdentical: true,
        sdkStubBundled: false,
        publicationAuthorized: false,
      });
    }
    expect(packages[0].zipSha256).not.toBe(packages[1].zipSha256);
    if (evidence)
      fs.writeFileSync(
        path.join(evidence, 'workflow-proof.private.json'),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            kind: 'synthetic_canonical_template_integration',
            realUserFeedback: false,
            realAccountsUsed: false,
            realProviderCalls: 0,
            productionConfigurationChanged: false,
            projectTaskState: project!.tasks[0].state,
            plays,
            packages,
            hostStartup: {
              crazygames: smoke.checkStatus,
              yandex: yandexSmoke.checkStatus,
              yandexReason:
                'Exact bundle requires portal-provided /sdk.js; separate loopback SDK fixture does not override this host failure.',
            },
            limitations: [
              'No portal/publication/real-device/audible-music/human-fun claim.',
              'Two packages are test artifacts of a reusable starter, not a proposed new commercial game.',
            ],
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
