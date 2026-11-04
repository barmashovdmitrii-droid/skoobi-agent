import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _initTestDatabase, storeChatMetadata, storeMessage } from './db.js';
import { executeGameFactoryRequest } from './game-factory-service.js';
import type {
  FactoryActor,
  FactoryConfiguration,
  FactoryProject,
  FactoryRequest,
} from './game-factory-contracts.js';

let root: string,
  config: FactoryConfiguration,
  actor: FactoryActor,
  counter: number,
  project: FactoryProject;
const identity = {
  channel: 'telegram' as const,
  chat_id: 'fixture-chat',
  telegram_user_id: 'fixture-sender',
  identity_id: 'fixture-owner',
  telegram_message_origin: 'direct' as const,
  is_owner_sender: true,
};
const brief = {
  goal: 'Собрать проверяемую игру',
  audience: 'Игроки',
  firstSession: 'Первое действие понятно',
  coreLoop: 'Выбрать и получить результат',
  artDirection: 'Единый стиль',
  acceptance: ['Проверить сборку'],
  devices: ['desktop'],
  platforms: ['crazygames'],
};
const html =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><h1>Fixture game</h1><canvas width="320" height="240"></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="#46b";c.fillRect(0,0,320,240);</script></body></html>';
function message(id: string, text: string) {
  storeChatMetadata(actor.chatJid, new Date().toISOString());
  storeMessage({
    id,
    chat_jid: actor.chatJid,
    sender: actor.senderId,
    sender_name: 'Fixture',
    content: text,
    timestamp: new Date().toISOString(),
    sender_identity: identity,
    is_bot_message: false,
  });
}
const request = (
  action: string,
  args: Record<string, unknown> = {},
): FactoryRequest => ({
  operationId: `workflow-operation-${++counter}`,
  action,
  args,
  projectId: 'fixture-game',
  expectedRevision: project?.revision ?? 0,
});
async function call(action: string, args: Record<string, unknown> = {}) {
  const result = (await executeGameFactoryRequest(
    actor,
    request(action, args),
  )) as { project: FactoryProject } & Record<string, any>;
  if (result.project) project = result.project;
  return result;
}
beforeEach(() => {
  _initTestDatabase();
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-workflow-')),
  );
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(path.join(root, 'work'), { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'source'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'source/index.html'), html);
  actor = {
    identityId: identity.identity_id,
    tenantId: 'fixture-tenant',
    chatJid: 'tg:fixture-chat',
    channelChatId: identity.chat_id,
    sourceGroup: 'fixture-group',
    senderId: identity.telegram_user_id,
    currentMessageIds: ['request-1'],
    runId: 'fixture-run',
    isPrimaryOwner: true,
  };
  config = {
    version: 1,
    enabled: true,
    primaryOwnerIdentityId: actor.identityId,
    databasePath: path.join(root, 'factory.db'),
    workspaceRoot: path.join(root, 'work'),
    actors: [
      {
        identityId: actor.identityId,
        tenantId: actor.tenantId,
        alias: 'owner',
        canCreate: true,
        backends: ['agent'],
        sourceRoots: [path.join(root, 'source')],
      },
    ],
    accounts: [
      {
        alias: 'fixture-account',
        platform: 'crazygames',
        actorAliases: ['owner'],
      },
    ],
  };
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  vi.stubEnv('SKOOBI_GAME_FACTORY_CONFIG', configFile);
  counter = 0;
  project = undefined as unknown as FactoryProject;
  message('request-1', 'Создай тестовый проект в разрешённом объёме.');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('production factory path in a synthetic private instance', () => {
  it.skipIf(!process.env.SKOOBI_TEST_LEGACY_FACTORY_ROOT)(
    'dispatches and cancels the real legacy queue through production service without starting a worker',
    async () => {
      const code = path.join(root, 'provider-code'),
        state = path.join(root, 'provider-state');
      fs.mkdirSync(code, { mode: 0o700 });
      fs.mkdirSync(state, { mode: 0o700 });
      for (const name of ['factory.py', 'managed_runtime.py'])
        fs.copyFileSync(
          path.join(process.env.SKOOBI_TEST_LEGACY_FACTORY_ROOT!, name),
          path.join(code, name),
        );
      const python = ['/opt/homebrew/bin/python3', '/usr/bin/python3'].find(
        (p) => fs.existsSync(p),
      )!;
      const legacyConfig = path.join(root, 'legacy.json');
      fs.writeFileSync(
        legacyConfig,
        JSON.stringify({
          version: 1,
          pythonExecutable: fs.realpathSync(python),
          factoryScript: path.join(code, 'factory.py'),
          stateDirectory: state,
        }),
        { mode: 0o600 },
      );
      config.legacy = { configurationPath: legacyConfig };
      config.actors[0].backends.push('legacy');
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
      await call('create', {
        title: 'Fixture prototype',
        engine: 'canvas',
        brief,
      });
      await call('plan', {
        tasks: [
          {
            id: 'prototype-task',
            stage: 'playable',
            title: 'Prototype candidate',
            acceptance: ['Playable loop'],
            dependencies: [],
          },
        ],
      });
      const claimed = await call('claim', {
        taskId: 'prototype-task',
        backend: 'legacy',
      });
      const dispatch = request('legacy_dispatch', {
        token: claimed.claim.token,
      });
      const result = (await executeGameFactoryRequest(actor, dispatch)) as any;
      project = result.project;
      expect(result.observation).toMatchObject({
        state: 'queued',
        requiresHumanReview: true,
      });
      expect(
        ((await executeGameFactoryRequest(actor, dispatch)) as any).legacyJobId,
      ).toBe(result.legacyJobId);
      await call('legacy_refresh', { jobId: result.legacyJobId });
      await expect(
        call('release_claim', { token: claimed.claim.token }),
      ).rejects.toThrow('external_execution_unresolved');
      await call('brief', {
        ...brief,
        goal: 'Changed task: stop the old prototype',
      });
      const cancelled = await call('legacy_cancel', {
        jobId: result.legacyJobId,
      });
      expect(cancelled.observation).toMatchObject({
        state: 'cancelled',
        requirementsCurrent: false,
      });
      await call('legacy_refresh', { jobId: result.legacyJobId });
      await call('release_claim', { token: claimed.claim.token });
      expect(project.lease).toBeNull();
      const queue = new Database(path.join(state, 'queue.sqlite3'), {
        readonly: true,
      });
      try {
        expect(queue.prepare('SELECT COUNT(*) n FROM jobs').get()).toEqual({
          n: 1,
        });
        expect(queue.prepare('SELECT status,music FROM jobs').get()).toEqual({
          status: 'cancelled',
          music: 0,
        });
      } finally {
        queue.close();
      }
    },
    30000,
  );

  it('imports, seeds an isolated writer, freezes a build, verifies and reviews the exact artifact', async () => {
    await call('create', { title: 'Fixture', engine: 'canvas', brief });
    const imported = await call('source_import', {
      sourceRoot: path.join(root, 'source'),
      entrypoint: 'index.html',
      version: '0.1.0',
      note: 'Fixture original',
    });
    await call('plan', {
      tasks: [
        {
          id: 'first-episode',
          stage: 'playable',
          title: 'Первый эпизод',
          acceptance: ['Оценить первый эпизод'],
          dependencies: [],
          humanReviewRequired: true,
        },
        {
          id: 'next-step',
          stage: 'learn',
          title: 'Следующий шаг',
          acceptance: ['Записать вывод'],
          dependencies: ['first-episode'],
        },
      ],
    });
    const claim = await call('claim', {
      taskId: 'first-episode',
      backend: 'agent',
      baseBuildId: imported.imported.id,
    });
    expect(claim.sourceDirectory).not.toBe(path.join(root, 'source'));
    fs.appendFileSync(
      path.join(claim.sourceDirectory, 'index.html'),
      '\n<!-- candidate -->',
    );
    const captured = await call('build_capture', {
      token: claim.claim.token,
      sourceRoot: claim.sourceDirectory,
      entrypoint: 'index.html',
      version: '0.2.0',
    });
    const buildId = captured.build.id,
      buildRoot = captured.build.root;
    fs.appendFileSync(
      path.join(claim.sourceDirectory, 'index.html'),
      '\n<!-- later edit -->',
    );
    expect(
      fs.readFileSync(path.join(buildRoot, 'index.html'), 'utf8'),
    ).not.toContain('later edit');
    expect(fs.readFileSync(path.join(root, 'source/index.html'), 'utf8')).toBe(
      html,
    );
    const qaRequest = request('verify_build', { buildId });
    const [qa, sameQa] = (await Promise.all([
      executeGameFactoryRequest(actor, qaRequest),
      executeGameFactoryRequest(actor, qaRequest),
    ])) as any[];
    expect(sameQa).toEqual(qa);
    project = qa.project;
    const check = await call('inspect', {
      section: 'check',
      receiptId: qa.evidence.receiptId,
    });
    expect(check.receipt.kind).toBe('html5_startup_smoke');
    expect(qa.fullGameplayVerified).toBe(false);
    expect(qa.humanAcceptanceRecorded).toBe(false);
    const inspectDb = new Database(config.databasePath, { readonly: true });
    try {
      expect(
        inspectDb
          .prepare('SELECT COUNT(*) AS n FROM factory_check_receipts')
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      inspectDb.close();
    }
    await call('checkpoint', {
      token: claim.claim.token,
      summary: 'Кандидат готов к оценке',
      state: 'submitted',
      buildId,
    });
    await call('release_claim', { token: claim.claim.token });
    if (qa.checkStatus === 'unavailable') {
      await expect(
        call('task_review', {
          taskId: 'first-episode',
          decision: 'accepted',
          note: 'Недоступный браузер не является проверкой',
          evidenceIds: [qa.evidence.id],
        }),
      ).rejects.toThrow('technical_evidence_required');
      return;
    }
    expect(qa.checkStatus).toBe('passed');
    await expect(
      call('task_review', {
        taskId: 'first-episode',
        decision: 'accepted',
        note: 'Только техническая проверка',
        evidenceIds: [qa.evidence.id],
      }),
    ).rejects.toThrow('human_review_required');
    await expect(
      call('human_feedback', {
        buildId,
        messageId: 'request-1',
        quote: 'Несуществующая похвала',
        result: 'pass',
      }),
    ).rejects.toThrow('human_feedback_source_not_verified');
    message(
      'feedback-2',
      'В тестовом сценарии я проверил версию 0.2.0, первый эпизод принят.',
    );
    actor = { ...actor, currentMessageIds: ['feedback-2'] };
    const feedback = await call('human_feedback', {
      buildId,
      messageId: 'feedback-2',
      quote: 'проверил версию 0.2.0, первый эпизод принят',
      result: 'pass',
    });
    expect(feedback.publicationAuthorized).toBe(false);
    await call('task_review', {
      taskId: 'first-episode',
      decision: 'accepted',
      note: 'Технический receipt и реальная цитата из fixture сообщения',
      evidenceIds: [qa.evidence.id, feedback.evidence.id],
    });
    expect(project.tasks.find((t) => t.id === 'first-episode')?.state).toBe(
      'accepted',
    );
    const release = await call('release_prepare', {
      buildId,
      platform: 'crazygames',
      mode: 'basic',
      accountAlias: 'fixture-account',
      sourceOfFirstPlayers: 'Fixture preview',
      reviewAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(release.publicationAuthorized).toBe(false);
    expect(release.release.state).toBe('prepared');
    const packaged = await call('release_package', {
      releaseId: release.release.id,
    });
    expect(packaged.releaseReady).toBe(false);
    expect(packaged.publicationAuthorized).toBe(false);
    expect(packaged.release.bundle.manifestSha256).toBe(
      project.builds.find((b) => b.id === buildId)?.manifestSha256,
    );
    expect(fs.statSync(packaged.release.bundle.path).size).toBe(
      packaged.release.bundle.bytes,
    );
    const repeated = await call('release_package', {
      releaseId: release.release.id,
    });
    expect(repeated.release.bundle.sha256).toBe(packaged.release.bundle.sha256);
    await call('claim', { taskId: 'next-step', backend: 'agent' });
    expect(project.lease?.taskId).toBe('next-step');
  }, 30000);

  it('rechecks a new ingested correction after async filesystem work before committing', async () => {
    await call('create', { title: 'Fixture', engine: 'canvas', brief });
    const importRequest = request('source_import', {
      sourceRoot: path.join(root, 'source'),
      entrypoint: 'index.html',
      note: 'Source',
    });
    const pending = executeGameFactoryRequest(actor, importRequest);
    message('correction-2', 'Стоп, сначала прочти поправку.');
    await expect(pending).rejects.toThrow('newer_user_input_pending');
    const state = await call('inspect');
    expect(state.project.builds).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'source/index.html'), 'utf8')).toBe(
      html,
    );
    actor = { ...actor, currentMessageIds: ['correction-2'] };
    const retried = (await executeGameFactoryRequest(
      actor,
      importRequest,
    )) as any;
    expect(retried.imported.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a hard-linked registry and creates nothing for a missing read-only registry', async () => {
    const empty = await call('list');
    expect(empty.projects).toEqual([]);
    expect(fs.existsSync(config.databasePath)).toBe(false);
    await call('create', { title: 'Fixture', engine: 'canvas', brief });
    fs.linkSync(config.databasePath, path.join(root, 'registry-link.db'));
    await expect(call('list')).rejects.toThrow('database_not_private');
  });
});
