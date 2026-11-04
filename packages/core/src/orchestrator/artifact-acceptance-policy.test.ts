import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  checkRegisteredArtifactAcceptance,
  bindRegisteredArtifactAcceptanceReceipt,
  createArtifactAcceptanceDeliveryPolicy,
  registerArtifactAcceptanceContract,
} from './artifact-acceptance-policy.js';
import { runIsolatedArtifactJob } from './artifact-job.js';
import type {
  ArtifactAcceptanceHost,
  BrowserArtifactAcceptanceRequirements,
} from './artifact-acceptance.js';

describe('host-approved opt-in artifact delivery contracts', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-policy-'));
  const workspace = path.join(temporary, 'workspace');
  const fixture = path.resolve('evals/task-continuity/artifact-acceptance');
  const artifactPath = path.join(workspace, 'bundle.zip');
  const requirements: BrowserArtifactAcceptanceRequirements = JSON.parse(
    fs.readFileSync(path.join(fixture, 'requirements.json'), 'utf8'),
  );
  const host: ArtifactAcceptanceHost = {
    stateDir: path.join(temporary, 'host'),
    agentWritableRoots: [workspace],
    checkerPath: path.resolve('scripts/artifact-acceptance-checker.mjs'),
    boundary: 'workspace-isolated',
  };
  beforeAll(() => {
    fs.mkdirSync(workspace);
    execFileSync('/usr/bin/python3', [
      path.join(fixture, 'create-fixture.py'),
      'good',
      artifactPath,
    ]);
  });
  afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));

  it('leaves unregistered artifacts alone and does not trust a workspace pass file', async () => {
    fs.writeFileSync(
      path.join(workspace, 'receipt.json'),
      JSON.stringify({ status: 'passed', verified: true }),
    );
    expect(
      await createArtifactAcceptanceDeliveryPolicy(host)(artifactPath),
    ).toEqual({
      required: false,
      status: 'not_required',
      code: 'contract_missing',
    });
    // A prepared registry can exist before any contract or signing key.
    fs.mkdirSync(host.stateDir, { mode: 0o700 });
    expect(
      await createArtifactAcceptanceDeliveryPolicy(host)(artifactPath),
    ).toEqual({
      required: false,
      status: 'not_required',
      code: 'contract_missing',
    });
    registerArtifactAcceptanceContract({ artifactPath, requirements, host });
    expect(
      await createArtifactAcceptanceDeliveryPolicy(host)(artifactPath),
    ).toEqual({
      required: true,
      status: 'inconclusive',
      code: 'receipt_missing',
    });
  });

  it.runIf(process.platform === 'darwin')(
    'delivers only a protected exact-byte snapshot even if the workspace original changes afterwards',
    async () => {
      const result = await runIsolatedArtifactJob({
        host,
        requirements,
        inputs: [{ sourcePath: artifactPath, relativePath: 'source.zip' }],
        producer: {
          executable: process.execPath,
          args: [
            '-e',
            'require("fs").copyFileSync("inputs/source.zip","output/artifact.zip")',
          ],
        },
        artifactRelativePath: 'output/artifact.zip',
      });
      try {
        expect(
          bindRegisteredArtifactAcceptanceReceipt({
            artifactPath,
            receipt: result.receipt,
            host,
          }).status,
        ).toBe('passed');
      } finally {
        result.cleanup?.();
      }
      expect(result.status).toBe('passed');
      const original = fs.readFileSync(artifactPath);
      const decision =
        await createArtifactAcceptanceDeliveryPolicy(host)(artifactPath);
      expect(decision.status).toBe('passed');
      expect(decision.snapshotPath).not.toBe(artifactPath);
      expect(path.basename(decision.snapshotPath!)).toBe(
        path.basename(artifactPath),
      );
      fs.writeFileSync(artifactPath, 'changed while transport is awaiting');
      expect(fs.readFileSync(decision.snapshotPath!)).toEqual(original);
      decision.cleanup!();
      expect(fs.existsSync(decision.snapshotPath!)).toBe(false);
      expect(
        await createArtifactAcceptanceDeliveryPolicy(host)(artifactPath),
      ).toMatchObject({
        required: true,
        status: 'stale',
        code: 'artifact_changed',
      });
      fs.writeFileSync(artifactPath, original);
    },
    30_000,
  );

  it('keeps unisolated signing and missing files explicitly unverified', async () => {
    expect(
      await checkRegisteredArtifactAcceptance({
        artifactPath,
        host: { ...host, boundary: 'owner-full-access' },
      }),
    ).toMatchObject({ status: 'inconclusive', code: 'isolation_unavailable' });
    expect(
      bindRegisteredArtifactAcceptanceReceipt({
        artifactPath,
        receipt: { status: 'passed' },
        host,
      }).status,
    ).not.toBe('passed');
    if (process.platform === 'darwin') {
      const retained =
        await createArtifactAcceptanceDeliveryPolicy(host)(artifactPath);
      try {
        expect(retained.status).toBe('passed');
      } finally {
        retained.cleanup?.();
      }
    }
    fs.renameSync(artifactPath, `${artifactPath}.saved`);
    expect(
      await createArtifactAcceptanceDeliveryPolicy(host)(artifactPath),
    ).toMatchObject({ required: true, status: 'inconclusive' });
    fs.renameSync(`${artifactPath}.saved`, artifactPath);
  });

  it('requires a new check after trusted criteria are replaced', async () => {
    registerArtifactAcceptanceContract({
      artifactPath,
      requirements: { ...requirements, inputSha256: ['a'.repeat(64)] },
      host,
    });
    expect(
      await createArtifactAcceptanceDeliveryPolicy(host)(artifactPath),
    ).toMatchObject({
      required: true,
      status: 'inconclusive',
      code: 'receipt_missing',
    });
  });
});
