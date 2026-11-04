import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { runIsolatedArtifactJob } from './artifact-job.js';
import {
  verifyArtifactAcceptanceReceipt,
  type ArtifactAcceptanceHost,
  type BrowserArtifactAcceptanceRequirements,
} from './artifact-acceptance.js';

describe.runIf(process.platform === 'darwin')(
  'synthetic elevator journey in the shipped browser verifier',
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elevator-artifact-'));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const fixture = path.resolve(
      'evals/task-continuity/artifact-acceptance/elevator',
    );
    const requirements: BrowserArtifactAcceptanceRequirements = JSON.parse(
      fs.readFileSync(path.join(fixture, 'requirements.json'), 'utf8'),
    );
    const host: ArtifactAcceptanceHost = {
      stateDir: path.join(root, 'host'),
      agentWritableRoots: [workspace],
      checkerPath: path.resolve('scripts/artifact-acceptance-checker.mjs'),
      boundary: 'owner-full-access',
    };
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
    it.each(['good', 'missing-call', 'stuck-cabin'])(
      'executes the complete journey with %s state',
      async (variant) => {
        const artifact = path.join(workspace, `${variant}.zip`);
        execFileSync('/usr/bin/python3', [
          path.join(fixture, 'create-fixture.py'),
          variant,
          artifact,
        ]);
        const checked = await runIsolatedArtifactJob({
          host,
          requirements,
          producer: {
            executable: process.execPath,
            args: [
              '-e',
              'require("node:fs").copyFileSync("inputs/source.zip","output/artifact.zip")',
            ],
          },
          inputs: [{ sourcePath: artifact, relativePath: 'source.zip' }],
          artifactRelativePath: 'output/artifact.zip',
        });
        try {
          expect(checked.status, checked.code).toBe(
            variant === 'good' ? 'passed' : 'failed',
          );
          expect(checked.receipt?.payload.producerIsolation.policy).toBe(
            'macos-seatbelt-artifact-v1',
          );
          expect(
            verifyArtifactAcceptanceReceipt({
              artifactPath: checked.artifactPath!,
              requirements,
              receipt: checked.receipt,
              host,
            }).status,
          ).toBe(checked.status);
          expect(
            checked.receipt!.payload.result.checks.map((check) => check.id),
          ).toEqual(
            variant === 'good'
              ? [
                  'archive_safety',
                  'entry_opened',
                  'step_1',
                  'step_2',
                  'step_3',
                  'step_4',
                ]
              : ['archive_safety', 'entry_opened', 'step_1'],
          );
          if (variant !== 'good')
            expect(checked.receipt!.payload.trace?.size).toBeGreaterThan(0);
        } finally {
          checked.cleanup?.();
        }
      },
      30000,
    );
  },
);
