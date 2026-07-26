import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getImageJobArtifacts,
  getImageJobById,
  markImageJobArtifactDelivering,
  markImageJobDelivering,
  markImageJobGenerated,
} from './db.js';
import {
  beginCodexImageJob,
  finalizeCodexImageJob,
  formatRecentImageJobStatus,
  officialImagegenJobMarker,
  recordCodexImageArtifacts,
  recoverPendingImageJobs,
} from './image-pipeline.js';
import type { MessageRouter } from './types.js';

function writeTestPng(filePath: string, marker: number): void {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nS8AAAAASUVORK5CYII=',
    'base64',
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([png, Buffer.alloc(128, marker)]));
}

function fakeRouter(sentPhotos: string[]): MessageRouter {
  return {
    addPreHook: () => undefined,
    addPostHook: () => undefined,
    route: async (envelope) => envelope.text,
    send: async () => undefined,
    sendPhoto: async (_jid, filePath) => {
      sentPhotos.push(filePath);
      return true;
    },
    sendDocument: async () => false,
    sendVoice: async () => false,
  };
}

describe('official Codex image pipeline', () => {
  let root: string;
  let codexHome: string;
  let workspaceRoot: string;

  beforeEach(() => {
    _initTestDatabase();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-image-pipeline-'));
    codexHome = path.join(root, 'codex-home');
    workspaceRoot = path.join(root, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('captures only the image created by this run and delivers the staged file', async () => {
    writeTestPng(path.join(codexHome, 'generated_images', 'old', 'old.png'), 1);
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:48.000Z',
      prompt: 'синтетический зелёный парк',
      codexHome,
      workspaceRoot,
    });
    const generated = path.join(
      codexHome,
      'generated_images',
      'new',
      'result.png',
    );
    writeTestPng(generated, 2);

    const sentPhotos: string[] = [];
    const result = await finalizeCodexImageJob({
      context,
      router: fakeRouter(sentPhotos),
    });

    expect(result.delivered).toBe(true);
    expect(sentPhotos).toHaveLength(1);
    expect(sentPhotos[0]).toContain(path.join('output', 'imagegen'));
    expect(sentPhotos[0]).not.toBe(generated);
    expect(fs.existsSync(sentPhotos[0])).toBe(true);
    expect(getImageJobById(context.job.id)?.status).toBe('delivered');
  });

  it('treats the same chat cursor as one idempotent generation request', () => {
    const first = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:48.500Z',
      prompt: 'синтетический зелёный парк',
      codexHome,
      workspaceRoot,
      now: '2026-07-12T18:18:48.500Z',
    });
    const duplicate = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:48.500Z',
      prompt: 'синтетический зелёный парк',
      codexHome,
      workspaceRoot,
      now: '2026-07-12T18:18:49.000Z',
    });

    expect(first.generationRequired).toBe(true);
    expect(duplicate.generationRequired).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    expect(duplicate.job.generation_attempts).toBe(1);
  });

  it('persists and delivers every exact image_gen artifact in call order', async () => {
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:48.600Z',
      prompt: 'две разные открытки',
      codexHome,
      workspaceRoot,
    });
    const first = path.join(codexHome, 'generated_images', 'turn', 'first.png');
    const second = path.join(
      codexHome,
      'generated_images',
      'turn',
      'second.png',
    );
    writeTestPng(first, 21);
    writeTestPng(second, 22);
    const sentPhotos: string[] = [];

    const result = await finalizeCodexImageJob({
      context,
      router: fakeRouter(sentPhotos),
      generatedArtifacts: [
        { callId: 'call-first', savedPath: first },
        { callId: 'call-second', savedPath: second },
      ],
    });

    const artifacts = getImageJobArtifacts(context.job.id);
    expect(artifacts.map((artifact) => artifact.call_id)).toEqual([
      'call-first',
      'call-second',
    ]);
    expect(sentPhotos).toEqual(
      artifacts.map((artifact) => artifact.staged_path),
    );
    expect(result.artifactPaths).toEqual(sentPhotos);
    expect(result.deliveredCount).toBe(2);
    expect(getImageJobById(context.job.id)?.status).toBe('delivered');
  });

  it('delivers valid images while retaining a pathless completed call for recovery', async () => {
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:48.625Z',
      prompt: 'две картинки',
      codexHome,
      workspaceRoot,
    });
    const generated = path.join(
      codexHome,
      'generated_images',
      'turn',
      'partial.png',
    );
    writeTestPng(generated, 29);
    const sentPhotos: string[] = [];

    const result = await finalizeCodexImageJob({
      context,
      router: fakeRouter(sentPhotos),
      generatedArtifacts: [{ callId: 'call-ready', savedPath: generated }],
      generationObserved: true,
      generationCallIds: ['call-ready', 'call-awaiting-path'],
    });

    expect(sentPhotos).toHaveLength(1);
    expect(result.deliveryPending).toBe(true);
    expect(result.deliveredCount).toBe(1);
    expect(getImageJobById(context.job.id)?.status).toBe('generated');
    expect(
      JSON.parse(
        getImageJobById(context.job.id)?.generation_call_ids_json || '[]',
      ),
    ).toEqual(['call-ready', 'call-awaiting-path']);
  });

  it('never starts a paid retry after a completed pathless image call', async () => {
    const requestCursor = '2026-07-12T18:18:48.637Z';
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor,
      prompt: 'картинка',
      codexHome,
      workspaceRoot,
    });

    const result = await finalizeCodexImageJob({
      context,
      router: fakeRouter([]),
      generatedArtifacts: [],
      generationObserved: true,
      generationCallIds: ['call-without-path'],
    });
    const duplicate = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor,
      prompt: 'картинка',
      codexHome,
      workspaceRoot,
    });

    expect(result.deliveryPending).toBe(true);
    expect(result.automaticRetrySuppressed).toBe(true);
    expect(duplicate.generationRequired).toBe(false);
    expect(duplicate.job.generation_attempts).toBe(1);
  });

  it('deduplicates repeated exact artifact checkpoints by call id', () => {
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:48.650Z',
      prompt: 'открытка',
      codexHome,
      workspaceRoot,
    });
    const generated = path.join(
      codexHome,
      'generated_images',
      'turn',
      'same.png',
    );
    writeTestPng(generated, 23);
    const checkpoint = [{ callId: 'call-same', savedPath: generated }];

    const first = recordCodexImageArtifacts({
      context,
      artifacts: checkpoint,
    });
    fs.rmSync(generated);
    const duplicate = recordCodexImageArtifacts({
      context,
      artifacts: checkpoint,
    });

    expect(first).toHaveLength(1);
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0].id).toBe(first[0].id);
    expect(fs.existsSync(first[0].staged_path)).toBe(true);
  });

  it('retries only the same staged file after Telegram rejects delivery', async () => {
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:48.675Z',
      prompt: 'открытка',
      codexHome,
      workspaceRoot,
    });
    const generated = path.join(
      codexHome,
      'generated_images',
      'turn',
      'retry.png',
    );
    writeTestPng(generated, 24);
    const sentPhotos: string[] = [];
    const router = fakeRouter(sentPhotos);
    let accepted = false;
    router.sendPhoto = async (_jid, filePath) => {
      sentPhotos.push(filePath);
      return accepted;
    };

    const pending = await finalizeCodexImageJob({
      context,
      router,
      generatedArtifacts: [{ callId: 'call-retry', savedPath: generated }],
    });
    accepted = true;
    const delivered = await finalizeCodexImageJob({ context, router });

    expect(pending.deliveryPending).toBe(true);
    expect(delivered.delivered).toBe(true);
    expect(sentPhotos).toHaveLength(2);
    expect(sentPhotos[0]).toBe(sentPhotos[1]);
    expect(getImageJobById(context.job.id)?.generation_attempts).toBe(1);
  });

  it('does not let a duplicate finalize steal a fresh generation lease', async () => {
    const first = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:48.680Z',
      prompt: 'открытка',
      codexHome,
      workspaceRoot,
      now: '2026-07-12T18:18:48.680Z',
    });
    const duplicate = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:48.680Z',
      prompt: 'открытка',
      codexHome,
      workspaceRoot,
      now: '2026-07-12T18:18:49.000Z',
    });

    const result = await finalizeCodexImageJob({
      context: duplicate,
      router: fakeRouter([]),
      generatedArtifacts: [],
    });

    expect(first.generationRequired).toBe(true);
    expect(duplicate.generationRequired).toBe(false);
    expect(result.deliveryDeferred).toBe(true);
    expect(getImageJobById(first.job.id)?.status).toBe('generating');
    expect(getImageJobById(first.job.id)?.generation_attempts).toBe(1);
  });

  it('reclaims one failed generation once, then stops at the cap', async () => {
    const first = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:48.690Z',
      prompt: 'открытка',
      codexHome,
      workspaceRoot,
      now: '2026-07-12T18:18:48.690Z',
    });
    const firstFailure = await finalizeCodexImageJob({
      context: first,
      router: fakeRouter([]),
      generatedArtifacts: [],
    });
    const retry = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:48.690Z',
      prompt: 'открытка',
      codexHome,
      workspaceRoot,
      now: '2026-07-12T18:18:50.000Z',
    });
    const staleGenerated = path.join(
      codexHome,
      'generated_images',
      'stale-attempt',
      'result.png',
    );
    writeTestPng(staleGenerated, 32);
    const staleArtifacts = recordCodexImageArtifacts({
      context: first,
      artifacts: [{ callId: 'late-attempt-one', savedPath: staleGenerated }],
    });
    const secondFailure = await finalizeCodexImageJob({
      context: retry,
      router: fakeRouter([]),
      generatedArtifacts: [],
    });

    expect(firstFailure.generationRetryable).toBe(true);
    expect(retry.generationRequired).toBe(true);
    expect(retry.generationAttempt).toBe(2);
    expect(staleArtifacts).toEqual([]);
    expect(getImageJobArtifacts(first.job.id)).toEqual([]);
    expect(secondFailure.terminalFailure).toBe(true);
    expect(getImageJobById(first.job.id)?.status).toBe('failed');
  });

  it('captures an existing generated image when image_gen updates it in place', async () => {
    const generated = path.join(
      codexHome,
      'generated_images',
      'edit',
      'result.png',
    );
    writeTestPng(generated, 4);
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:48.700Z',
      prompt: 'измени эту картинку',
      codexHome,
      workspaceRoot,
    });
    writeTestPng(generated, 5);
    const future = new Date(Date.now() + 1_000);
    fs.utimesSync(generated, future, future);

    const sentPhotos: string[] = [];
    const result = await finalizeCodexImageJob({
      context,
      router: fakeRouter(sentPhotos),
    });

    expect(result.delivered).toBe(true);
    expect(sentPhotos).toHaveLength(1);
  });

  it('does not follow a generated_images symlink outside CODEX_HOME', async () => {
    const outside = path.join(root, 'outside');
    writeTestPng(path.join(outside, 'foreign.png'), 6);
    fs.mkdirSync(codexHome, { recursive: true });
    fs.symlinkSync(outside, path.join(codexHome, 'generated_images'));
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:48.800Z',
      prompt: 'кот',
      codexHome,
      workspaceRoot,
    });
    const sentPhotos: string[] = [];

    const result = await finalizeCodexImageJob({
      context,
      router: fakeRouter(sentPhotos),
    });

    expect(result.delivered).toBe(false);
    expect(sentPhotos).toEqual([]);
  });

  it('does not claim delivery when image_gen produced no artifact', async () => {
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:49.000Z',
      prompt: 'рыжий кот',
      codexHome,
      workspaceRoot,
    });
    const sentPhotos: string[] = [];

    const result = await finalizeCodexImageJob({
      context,
      router: fakeRouter(sentPhotos),
    });

    expect(result.delivered).toBe(false);
    expect(result.generationRetryable).toBe(true);
    expect(result.error).toContain('no new image artifact');
    expect(sentPhotos).toEqual([]);
    expect(getImageJobById(context.job.id)?.status).toBe('queued');
  });

  it('does not duplicate a photo already confirmed through agent IPC', async () => {
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:50.000Z',
      prompt: 'море',
      codexHome,
      workspaceRoot,
    });
    writeTestPng(
      path.join(codexHome, 'generated_images', 'new', 'result.png'),
      3,
    );
    const sentPhotos: string[] = [];

    const result = await finalizeCodexImageJob({
      context,
      router: fakeRouter(sentPhotos),
      photoAlreadyDelivered: true,
    });

    expect(result.delivered).toBe(true);
    expect(result.deliveryAlreadyHandled).toBe(true);
    expect(sentPhotos).toEqual([]);
    expect(getImageJobById(context.job.id)?.status).toBe('delivered');
  });

  it('keeps retrying the same staged file for an hour before terminal failure', async () => {
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:50.500Z',
      prompt: 'море',
      codexHome,
      workspaceRoot,
    });
    writeTestPng(
      path.join(codexHome, 'generated_images', 'new', 'result.png'),
      7,
    );
    const sentPhotos: string[] = [];
    const router = fakeRouter(sentPhotos);
    router.sendPhoto = async (_jid, filePath) => {
      sentPhotos.push(filePath);
      return false;
    };

    let capped: Awaited<ReturnType<typeof finalizeCodexImageJob>> | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      capped = await finalizeCodexImageJob({ context, router });
    }

    expect(sentPhotos).toHaveLength(60);
    expect(capped?.automaticRetrySuppressed).toBe(true);
    expect(capped?.terminalFailure).toBe(true);
    expect(getImageJobById(context.job.id)?.status).toBe('failed');
    expect(getImageJobById(context.job.id)?.delivery_attempts).toBe(60);

    const notices: string[] = [];
    await recoverPendingImageJobs({
      router: fakeRouter([]),
      onTerminalFailure: async (job) => {
        notices.push(job.id);
      },
    });
    await recoverPendingImageJobs({
      router: fakeRouter([]),
      onTerminalFailure: async (job) => {
        notices.push(job.id);
      },
    });
    expect(notices).toEqual([context.job.id]);
  });

  it('allows only one concurrent delivery claim for the same job', async () => {
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:50.700Z',
      prompt: 'море',
      codexHome,
      workspaceRoot,
    });
    writeTestPng(
      path.join(codexHome, 'generated_images', 'new', 'result.png'),
      8,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sentPhotos: string[] = [];
    const router = fakeRouter(sentPhotos);
    router.sendPhoto = async (_jid, filePath) => {
      sentPhotos.push(filePath);
      await gate;
      return true;
    };

    const first = finalizeCodexImageJob({ context, router });
    await vi.waitFor(() => expect(sentPhotos).toHaveLength(1));
    const concurrent = await finalizeCodexImageJob({ context, router });
    release();
    const delivered = await first;

    expect(concurrent.deliveryDeferred).toBe(true);
    expect(delivered.delivered).toBe(true);
    expect(sentPhotos).toHaveLength(1);
  });

  it('does not classify a fresh in-process delivery as a crashed job', async () => {
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:50.900Z',
      prompt: 'море',
      codexHome,
      workspaceRoot,
    });
    const staged = path.join(workspaceRoot, 'staged.png');
    writeTestPng(staged, 9);
    markImageJobGenerated(context.job.id, [staged]);
    expect(markImageJobDelivering(context.job.id, 3)).toBe(true);

    const recovery = await recoverPendingImageJobs({
      router: fakeRouter([]),
    });

    expect(recovery.skipped).toBe(1);
    expect(getImageJobById(context.job.id)?.status).toBe('delivering');
  });

  it('retries a persisted in-flight artifact after a process restart', async () => {
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:51.100Z',
      prompt: 'море',
      codexHome,
      workspaceRoot,
    });
    const generated = path.join(
      codexHome,
      'generated_images',
      'restart',
      'result.png',
    );
    writeTestPng(generated, 25);
    const [artifact] = recordCodexImageArtifacts({
      context,
      artifacts: [{ callId: 'call-restart', savedPath: generated }],
    });
    expect(markImageJobArtifactDelivering(artifact.id, 6)).toBe(true);
    const sentPhotos: string[] = [];

    const recovery = await recoverPendingImageJobs({
      router: fakeRouter(sentPhotos),
      includeFreshGenerating: true,
    });

    expect(recovery.delivered).toBe(1);
    expect(sentPhotos).toEqual([artifact.staged_path]);
    expect(getImageJobById(context.job.id)?.status).toBe('delivered');
    expect(getImageJobById(context.job.id)?.generation_attempts).toBe(1);
  });

  it('recovers an exact completed rollout event across the checkpoint crash gap', async () => {
    const now = new Date();
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: now.toISOString(),
      prompt: 'море',
      codexHome,
      workspaceRoot,
      now: now.toISOString(),
    });
    const generated = path.join(
      codexHome,
      'generated_images',
      'crash-gap',
      'result.png',
    );
    writeTestPng(generated, 26);
    const rollout = path.join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '12',
      'rollout-test.jsonl',
    );
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    const jobMarker = officialImagegenJobMarker(
      context.job.id,
      context.generationAttempt,
    );
    fs.writeFileSync(
      rollout,
      `${JSON.stringify({
        timestamp: now.toISOString(),
        type: 'response_item',
        payload: { type: 'message', content: jobMarker },
      })}\n${JSON.stringify({
        timestamp: now.toISOString(),
        type: 'event_msg',
        payload: { type: 'user_message', message: jobMarker },
      })}\n${JSON.stringify({
        timestamp: new Date(now.getTime() + 1_000).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'image_generation_end',
          call_id: 'call-from-rollout',
          status: 'completed',
          saved_path: generated,
        },
      })}\n`,
    );
    const sentPhotos: string[] = [];

    const recovery = await recoverPendingImageJobs({
      router: fakeRouter(sentPhotos),
      includeFreshGenerating: true,
      codexHomeForJob: () => codexHome,
      workspaceRootForJob: () => workspaceRoot,
    });

    expect(recovery.delivered).toBe(1);
    expect(sentPhotos).toHaveLength(1);
    expect(getImageJobArtifacts(context.job.id)[0]?.call_id).toBe(
      'call-from-rollout',
    );
    expect(getImageJobById(context.job.id)?.generation_attempts).toBe(1);
  });

  it('recovers a completed pathless call id without starting a new generation', async () => {
    const now = new Date();
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: new Date(now.getTime() + 2_000).toISOString(),
      prompt: 'картинка без пути',
      codexHome,
      workspaceRoot,
      now: now.toISOString(),
    });
    const marker = officialImagegenJobMarker(
      context.job.id,
      context.generationAttempt,
    );
    const rollout = path.join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '12',
      'rollout-pathless.jsonl',
    );
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(
      rollout,
      `${JSON.stringify({
        timestamp: now.toISOString(),
        type: 'event_msg',
        payload: { type: 'user_message', message: marker },
      })}\n${JSON.stringify({
        timestamp: new Date(now.getTime() + 1_000).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'image_generation_end',
          call_id: 'call-pathless-rollout',
          status: 'completed',
        },
      })}\n`,
    );

    const recovery = await recoverPendingImageJobs({
      router: fakeRouter([]),
      includeFreshGenerating: true,
      codexHomeForJob: () => codexHome,
      workspaceRootForJob: () => workspaceRoot,
    });
    const job = getImageJobById(context.job.id)!;

    expect(recovery.delivered).toBe(0);
    expect(recovery.skipped).toBe(1);
    expect(job.generation_attempts).toBe(1);
    expect(JSON.parse(job.generation_call_ids_json || '[]')).toEqual([
      'call-pathless-rollout',
    ]);
    expect(job.generation_completed_at).toBeTruthy();
  });

  it('checks the exact rollout before scheduling a second generation', async () => {
    const now = new Date();
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: new Date(now.getTime() + 2_000).toISOString(),
      prompt: 'маяк',
      codexHome,
      workspaceRoot,
      now: now.toISOString(),
    });
    const generated = path.join(
      codexHome,
      'generated_images',
      'finalize-gap',
      'result.png',
    );
    writeTestPng(generated, 28);
    // Model a coarse filesystem clock that rounds a just-written artifact
    // slightly before the millisecond-precise job timestamp.
    const coarseMtime = new Date(now.getTime() - 1_000);
    fs.utimesSync(generated, coarseMtime, coarseMtime);
    const rollout = path.join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '12',
      'rollout-finalize-test.jsonl',
    );
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(
      rollout,
      `${officialImagegenJobMarker(context.job.id, context.generationAttempt)}\n${JSON.stringify(
        {
          timestamp: new Date(now.getTime() + 1_000).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'image_generation_end',
            call_id: 'call-finalize-rollout',
            status: 'completed',
            saved_path: generated,
          },
        },
      )}\n`,
    );
    const sentPhotos: string[] = [];

    const result = await finalizeCodexImageJob({
      context,
      router: fakeRouter(sentPhotos),
      generatedArtifacts: [],
    });

    expect(result.delivered).toBe(true);
    expect(result.generationRetryable).toBeUndefined();
    expect(sentPhotos).toHaveLength(1);
    expect(getImageJobArtifacts(context.job.id)[0]?.call_id).toBe(
      'call-finalize-rollout',
    );
    expect(getImageJobById(context.job.id)?.generation_attempts).toBe(1);
  });

  it('rejects an exact-rollout artifact older than the filesystem clock skew', async () => {
    const now = new Date();
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: new Date(now.getTime() + 2_000).toISOString(),
      prompt: 'старый маяк',
      codexHome,
      workspaceRoot,
      now: now.toISOString(),
    });
    const generated = path.join(
      codexHome,
      'generated_images',
      'stale-finalize-gap',
      'result.png',
    );
    writeTestPng(generated, 29);
    // One millisecond beyond the production tolerance must still fail closed.
    const staleMtime = new Date(now.getTime() - 2_001);
    fs.utimesSync(generated, staleMtime, staleMtime);
    const rollout = path.join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '12',
      'rollout-stale-finalize-test.jsonl',
    );
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(
      rollout,
      `${officialImagegenJobMarker(context.job.id, context.generationAttempt)}\n${JSON.stringify(
        {
          timestamp: new Date(now.getTime() + 1_000).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'image_generation_end',
            call_id: 'call-stale-finalize-rollout',
            status: 'completed',
            saved_path: generated,
          },
        },
      )}\n`,
    );
    const sentPhotos: string[] = [];

    const result = await finalizeCodexImageJob({
      context,
      router: fakeRouter(sentPhotos),
      generatedArtifacts: [],
    });

    expect(result.delivered).toBe(false);
    expect(result.deliveryPending).toBe(true);
    expect(result.automaticRetrySuppressed).toBe(true);
    expect(sentPhotos).toEqual([]);
    expect(getImageJobArtifacts(context.job.id)).toEqual([]);
  });

  it('repairs a queued first attempt from rollout before claiming a paid retry', async () => {
    const now = new Date();
    const requestCursor = new Date(now.getTime() + 3_000).toISOString();
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor,
      prompt: 'маяк после сбоя',
      codexHome,
      workspaceRoot,
      now: now.toISOString(),
    });
    const firstResult = await finalizeCodexImageJob({
      context,
      router: fakeRouter([]),
      generatedArtifacts: [],
    });
    expect(firstResult.generationRetryable).toBe(true);

    const generated = path.join(
      codexHome,
      'generated_images',
      'queued-gap',
      'result.png',
    );
    writeTestPng(generated, 31);
    const rollout = path.join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '12',
      'rollout-queued-gap.jsonl',
    );
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    const marker = officialImagegenJobMarker(
      context.job.id,
      context.generationAttempt,
    );
    fs.writeFileSync(
      rollout,
      `${JSON.stringify({
        timestamp: now.toISOString(),
        type: 'event_msg',
        payload: { type: 'user_message', message: marker },
      })}\n${JSON.stringify({
        timestamp: new Date(now.getTime() + 1_000).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'image_generation_end',
          call_id: 'call-queued-rollout',
          status: 'completed',
          saved_path: generated,
        },
      })}\n`,
    );

    const duplicate = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor,
      prompt: 'маяк после сбоя',
      codexHome,
      workspaceRoot,
      now: new Date(now.getTime() + 2_000).toISOString(),
    });

    expect(duplicate.generationRequired).toBe(false);
    expect(duplicate.job.generation_attempts).toBe(1);
    expect(getImageJobArtifacts(context.job.id)[0]?.call_id).toBe(
      'call-queued-rollout',
    );
  });

  it('never guesses an unrelated generated_images file during recovery', async () => {
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: new Date().toISOString(),
      prompt: 'море',
      codexHome,
      workspaceRoot,
    });
    const unrelated = path.join(
      codexHome,
      'generated_images',
      'other',
      'unrelated.png',
    );
    writeTestPng(unrelated, 27);
    const unrelatedRollout = path.join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '12',
      'rollout-unrelated.jsonl',
    );
    fs.mkdirSync(path.dirname(unrelatedRollout), { recursive: true });
    fs.writeFileSync(
      unrelatedRollout,
      `${JSON.stringify({
        timestamp: new Date(
          new Date(context.job.created_at).getTime() + 1_000,
        ).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'image_generation_end',
          call_id: 'another-job-call',
          status: 'completed',
          saved_path: unrelated,
        },
      })}\n`,
    );
    const sentPhotos: string[] = [];

    const recovery = await recoverPendingImageJobs({
      router: fakeRouter(sentPhotos),
      includeFreshGenerating: true,
      codexHomeForJob: () => codexHome,
      workspaceRootForJob: () => workspaceRoot,
    });

    expect(recovery.delivered).toBe(0);
    expect(sentPhotos).toEqual([]);
    expect(getImageJobArtifacts(context.job.id)).toEqual([]);
    expect(getImageJobById(context.job.id)?.status).toBe('queued');
  });

  it('fails a generated job whose staged artifact disappeared', async () => {
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:51.500Z',
      prompt: 'море',
      codexHome,
      workspaceRoot,
    });
    markImageJobGenerated(context.job.id, [
      path.join(workspaceRoot, 'missing.png'),
    ]);

    const recovery = await recoverPendingImageJobs({
      router: fakeRouter([]),
    });

    expect(recovery.failed).toBe(1);
    expect(getImageJobById(context.job.id)?.status).toBe('failed');
  });

  it('formats status from the persisted job state', () => {
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:51.000Z',
      prompt: 'лошадь',
      codexHome,
      workspaceRoot,
    });
    expect(formatRecentImageJobStatus(context.job)).toContain(
      'действительно генерируется',
    );
  });

  it('does not expose an internal failure string in chat status', async () => {
    const context = beginCodexImageJob({
      chatJid: 'tg:1',
      replyJid: 'tg:1',
      groupFolder: 'telegram_test',
      requestCursor: '2026-07-12T18:18:52.000Z',
      prompt: 'лошадь',
      codexHome,
      workspaceRoot,
    });
    const result = await finalizeCodexImageJob({
      context,
      router: fakeRouter([]),
    });
    expect(result.delivered).toBe(false);
    const retryable = getImageJobById(context.job.id)!;

    expect(retryable.last_error).toContain('no new image artifact');
    expect(formatRecentImageJobStatus(retryable)).not.toContain(
      'no new image artifact',
    );
  });
});
