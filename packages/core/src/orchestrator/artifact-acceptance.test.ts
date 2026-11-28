import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ARTIFACT_CHECKER_SHA256,
  defaultArtifactAcceptanceHost,
  prepareArtifactAcceptanceHost,
  loadArtifactAcceptanceReceipt,
  runArtifactAcceptance,
  verifyArtifactAcceptanceReceipt,
  type ArtifactAcceptanceHost,
  type ArtifactAcceptanceReceipt,
  type BrowserArtifactAcceptanceRequirements,
} from './artifact-acceptance.js';
import { runIsolatedArtifactJob } from './artifact-job.js';

describe.runIf(process.platform === 'darwin')('host artifact acceptance with a real browser', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'artifact-acceptance-'),
  );
  const workspace = path.join(temporary, 'workspace');
  const fixture = path.resolve('evals/task-continuity/artifact-acceptance');
  const requirements: BrowserArtifactAcceptanceRequirements = JSON.parse(
    fs.readFileSync(path.join(fixture, 'requirements.json'), 'utf8'),
  );
  const checkerPath = path.resolve('scripts/artifact-acceptance-checker.mjs');
  const host: ArtifactAcceptanceHost = {
    stateDir: path.join(temporary, 'host'),
    agentWritableRoots: [workspace],
    checkerPath,
    boundary: 'owner-full-access',
  };
  async function checkFixture(variant: string, checkedHost: ArtifactAcceptanceHost = host) {
    const result = await runIsolatedArtifactJob({ host: checkedHost, requirements,
      producer: { executable: process.execPath, args: ['-e', 'require("node:fs").copyFileSync("inputs/source.zip","output/artifact.zip")'] },
      inputs: [{ sourcePath: path.join(workspace, `${variant}.zip`), relativePath: 'source.zip' }],
      artifactRelativePath: 'output/artifact.zip' });
    result.cleanup?.();
    return result;
  }
  let receipt: ArtifactAcceptanceReceipt;
  const artifactPath = path.join(workspace, 'good.zip');
  beforeAll(async () => {
    fs.mkdirSync(workspace);
    for (const variant of [
      'good',
      'delayed',
      'broken',
      'traversal',
      'symlink',
      'large',
      'duplicate',
    ]) {
      execFileSync('/usr/bin/python3', [
        path.join(fixture, 'create-fixture.py'),
        variant,
        path.join(workspace, `${variant}.zip`),
      ]);
    }
    const result = await checkFixture('good');
    expect(
      result,
      'Install the declared Playwright Chromium build to run this real-browser acceptance suite.',
    ).toMatchObject({ status: 'passed', code: 'checks_passed' });
    receipt = result.receipt!;
  }, 30_000);
  afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));

  it('opens the extracted entry, follows a click route and completes a keyboard action', () => {
    expect(receipt.payload.result.checks.map((check) => check.id)).toEqual([
      'archive_safety',
      'entry_opened',
      'step_1',
      'step_2',
    ]);
    expect(
      verifyArtifactAcceptanceReceipt({
        artifactPath,
        requirements,
        receipt,
        host,
      }),
    ).toMatchObject({ status: 'passed' });
    expect(receipt.payload.artifact.sha256).toBe(
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(artifactPath))
        .digest('hex'),
    );
    expect(loadArtifactAcceptanceReceipt(receipt.payload.id, host)).toEqual(
      receipt,
    );
    expect(fs.statSync(path.join(host.stateDir, 'key.bin')).mode & 0o777).toBe(
      0o600,
    );
    expect(
      fs.readdirSync(host.stateDir).some((name) => name.startsWith('work-')),
    ).toBe(false);
  });

  it('fails a broken package although every expected source file exists and retains local trace evidence', async () => {
    const result = await checkFixture('broken');
    expect(result).toMatchObject({ status: 'failed', code: 'scenario_failed' });
    expect(result.receipt?.payload.result.checks).toEqual([
      { id: 'archive_safety', outcome: 'passed' },
      { id: 'entry_opened', outcome: 'passed' },
    ]);
    expect(result.receipt?.payload.trace?.size).toBeGreaterThan(0);
    expect(
      fs.statSync(
        path.join(host.stateDir, `${result.receipt!.payload.id}.trace.zip`),
      ).mode & 0o777,
    ).toBe(0o600);
  }, 25_000);

  it('waits for delayed actionability, real local navigation and exact keyboard response without bypassing checks', async () => {
    const result = await checkFixture('delayed');
    expect(result).toMatchObject({ status: 'passed', code: 'checks_passed' });
    expect(result.receipt?.payload.result.checks).toEqual([
      { id: 'archive_safety', outcome: 'passed' },
      { id: 'entry_opened', outcome: 'passed' },
      { id: 'step_1', outcome: 'passed' },
      { id: 'step_2', outcome: 'passed' },
    ]);
  }, 30_000);

  it.each(['traversal', 'symlink', 'large', 'duplicate'])(
    'rejects unsafe archive variant %s before browser acceptance',
    async (variant) => {
      const result = await checkFixture(variant);
      expect(result.status).toBe('failed');
      expect(result.code).toMatch(/^archive_(unsafe|limit)$/);
      expect(fs.existsSync(path.join(temporary, 'escaped.txt'))).toBe(false);
    },
  );

  it('invalidates a receipt after the artifact or criteria change', () => {
    const changed = path.join(workspace, 'changed.zip');
    fs.copyFileSync(artifactPath, changed);
    fs.appendFileSync(changed, 'changed');
    expect(
      verifyArtifactAcceptanceReceipt({
        artifactPath: changed,
        requirements,
        receipt,
        host,
      }),
    ).toMatchObject({ status: 'stale', code: 'artifact_changed' });
    expect(
      verifyArtifactAcceptanceReceipt({
        artifactPath,
        requirements: {
          ...requirements,
          initial: { selector: '#status', text: 'Different' },
        },
        receipt,
        host,
      }),
    ).toMatchObject({ status: 'stale', code: 'requirements_changed' });
  });

  it('rejects a model-created receipt, modified signed result and modified checker', async () => {
    expect(
      verifyArtifactAcceptanceReceipt({
        artifactPath,
        requirements,
        receipt: { payload: receipt.payload, signature: '0'.repeat(64) },
        host,
      }).status,
    ).toBe('untrusted');
    const forged = structuredClone(receipt);
    forged.payload.humanAcceptance = 'approved' as 'not_recorded';
    expect(
      verifyArtifactAcceptanceReceipt({
        artifactPath,
        requirements,
        receipt: forged,
        host,
      }).status,
    ).toBe('untrusted');
    const fakeChecker = path.join(temporary, 'fake-checker.mjs');
    fs.writeFileSync(
      fakeChecker,
      'console.log(JSON.stringify({status:"passed",code:"checks_passed",checks:[]}))',
    );
    expect(
      await checkFixture('good', { ...host, checkerPath: fakeChecker }),
    ).toMatchObject({ status: 'inconclusive' });
    expect(
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(checkerPath))
        .digest('hex'),
    ).toBe(ARTIFACT_CHECKER_SHA256);
  });

  it('abstains without a usable checker environment or actual launch authority', async () => {
    expect(await checkFixture('good', { ...host, playwrightModule: path.join(temporary, 'missing.mjs') }))
      .toMatchObject({ status: 'inconclusive', code: 'environment_unavailable' });
    expect(await checkFixture('good', { ...host, pythonCommand: path.join(temporary, 'missing-python') }))
      .toMatchObject({ status: 'inconclusive' });
    for (const boundary of ['owner-full-access', 'workspace-isolated'] as const) {
      expect(await runArtifactAcceptance({ artifactPath, requirements, host: { ...host, boundary } }))
        .toMatchObject({ status: 'inconclusive', code: 'isolation_unavailable' });
    }
    for (const badHost of [
      { ...host, stateDir: path.join(workspace, 'host') },
      { ...host, agentWritableRoots: [path.parse(workspace).root] },
    ]) {
      expect(verifyArtifactAcceptanceReceipt({ artifactPath, requirements, receipt, host: badHost }).status)
        .not.toBe('passed');
    }
    const executable = path.join(workspace, 'fake-browser');
    fs.writeFileSync(executable, '#!/bin/sh\nprintf called > "$0.executed"\nexit 0\n', { mode: 0o700 });
    // This host-selected executable is outside the actual producer's roots.
    // Its exit 0 still cannot stand in for a working browser/user scenario.
    expect(await checkFixture('good', { ...host, browserExecutable: executable }))
      .toMatchObject({ status: 'inconclusive' });
    expect(fs.existsSync(`${executable}.executed`)).toBe(true);
  }, 30_000);

  it('never conflates the checks with transport or human acceptance', () => {
    expect(receipt.payload.delivery).toBe('not_recorded');
    expect(receipt.payload.humanAcceptance).toBe('not_recorded');
    expect(
      verifyArtifactAcceptanceReceipt({
        artifactPath,
        requirements,
        receipt,
        host,
      }).humanAcceptance,
    ).toBe('not_recorded');
    expect(loadArtifactAcceptanceReceipt('../key.bin', host)).toBeUndefined();
  });

  it('defaults to an honest full-owner boundary without creating startup state', () => {
    const home = path.join(temporary, 'synthetic-home');
    fs.mkdirSync(home);
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const defaults = defaultArtifactAcceptanceHost(workspace);
      expect(defaults.boundary).toBe('owner-full-access');
      expect(defaults.agentWritableRoots).toEqual([fs.realpathSync(workspace)]);
      expect(fs.existsSync(defaults.stateDir)).toBe(false);
      const prepared = prepareArtifactAcceptanceHost(workspace, checkerPath);
      expect(prepared).toEqual(defaults);
      expect(fs.readFileSync(prepared.checkerPath)).toEqual(
        fs.readFileSync(checkerPath),
      );
      expect(fs.statSync(prepared.stateDir).mode & 0o777).toBe(0o700);
      expect(prepared.stateDir.startsWith(workspace + path.sep)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
