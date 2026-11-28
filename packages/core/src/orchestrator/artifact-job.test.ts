import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import {
  runIsolatedArtifactJob,
  consumeArtifactJobAttestation,
} from './artifact-job.js';
import {
  runArtifactAcceptance,
  verifyArtifactAcceptanceReceipt,
  type ArtifactAcceptanceHost,
  type BrowserArtifactAcceptanceRequirements,
} from './artifact-acceptance.js';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-job-test-'));
const source = path.join(temporary, 'good.zip');
const fixture = path.resolve('evals/task-continuity/artifact-acceptance');
execFileSync('/usr/bin/python3', [
  path.join(fixture, 'create-fixture.py'),
  'good',
  source,
]);
const requirements: BrowserArtifactAcceptanceRequirements = JSON.parse(
  fs.readFileSync(path.join(fixture, 'requirements.json'), 'utf8'),
);
const checkerPath = path.join(temporary, 'checker.mjs');
fs.copyFileSync(
  path.resolve('scripts/artifact-acceptance-checker.mjs'),
  checkerPath,
);
const host: ArtifactAcceptanceHost = {
  stateDir: path.join(temporary, 'host'),
  agentWritableRoots: [path.resolve('.')],
  checkerPath,
  boundary: 'owner-full-access',
};
// The isolated controller derives producer roots itself. The checker is a
// protected test installation, separate from that producer's actual capabilities.
afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));

describe('actual macOS artifact producer boundary', () => {
  it.runIf(process.platform === 'darwin')(
    'launches the whole producer in Seatbelt and signs only its checked bytes',
    async () => {
      const result = await runIsolatedArtifactJob({
        host,
        requirements,
        producer: {
          executable: process.execPath,
          args: [
            '-e',
            'require("node:fs").copyFileSync("inputs/source.zip","output/artifact.zip")',
          ],
        },
        inputs: [{ sourcePath: source, relativePath: 'source.zip' }],
        artifactRelativePath: 'output/artifact.zip',
      });
      try {
        expect(
          result,
          JSON.stringify({
            code: result.code,
            failures: result.containmentFailures,
          }),
        ).toMatchObject({ status: 'passed', code: 'checks_passed' });
        expect(result.receipt?.payload.browserRuntimeSha256).toMatch(
          /^[a-f0-9]{64}$/,
        );
        const changedBrowser = path.join(temporary, 'changed-browser');
        fs.writeFileSync(changedBrowser, 'different browser version');
        expect(
          verifyArtifactAcceptanceReceipt({
            artifactPath: result.artifactPath!,
            requirements,
            receipt: result.receipt,
            host: { ...host, browserExecutable: changedBrowser },
          }),
        ).toMatchObject({ status: 'stale', code: 'validator_changed' });
        expect(result.receipt?.payload.producerIsolation.policy).toBe(
          'macos-seatbelt-artifact-v1',
        );
        expect(
          verifyArtifactAcceptanceReceipt({
            artifactPath: result.artifactPath!,
            requirements,
            receipt: result.receipt,
            host: { ...host, agentWritableRoots: [temporary + '-unrelated'] },
          }).status,
        ).not.toBe('passed');
        // Verification does not require a live producer or a trust-label upgrade.
        expect(
          verifyArtifactAcceptanceReceipt({
            artifactPath: result.artifactPath!,
            requirements,
            receipt: result.receipt,
            host,
          }).status,
        ).toBe('passed');
      } finally {
        result.cleanup?.();
      }
    },
    30_000,
  );
  it('caller flags and forged attestation JSON cannot authorize signing', async () => {
    expect(
      consumeArtifactJobAttestation(
        { policy: 'macos-seatbelt-artifact-v1' },
        {
          artifactSha256: '0'.repeat(64),
          requirementsSha256: '0'.repeat(64),
          hostDirectory: temporary,
        },
      ),
    ).toBeUndefined();
    expect(
      await runArtifactAcceptance({
        artifactPath: source,
        requirements,
        host: { ...host, boundary: 'workspace-isolated' },
        jobAttestation: { verified: true },
      }),
    ).toMatchObject({ status: 'inconclusive', code: 'isolation_unavailable' });
  });
});
