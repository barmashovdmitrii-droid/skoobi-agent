// Real isolated producer, shipped Chromium verifier, signed receipt and delivery
// gate. This fixture is entirely synthetic and sends no external messages.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runIsolatedArtifactJob } from '../../../../packages/core/dist/orchestrator/artifact-job.js';
import {
  registerArtifactAcceptanceContract,
  bindRegisteredArtifactAcceptanceReceipt,
  createArtifactAcceptanceDeliveryPolicy,
} from '../../../../packages/core/dist/orchestrator/artifact-acceptance-policy.js';

if (process.platform !== 'darwin') {
  console.log(
    JSON.stringify({
      status: 'inconclusive',
      code: 'isolation_platform_unsupported',
    }),
  );
  process.exit(2);
}
const fixture = path.dirname(fileURLToPath(import.meta.url));
const codeRoot = path.resolve(fixture, '../../../..');
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), 'elevator-journey-eval-'),
);
try {
  const workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(workspace);
  const requirements = JSON.parse(
    fs.readFileSync(path.join(fixture, 'requirements.json'), 'utf8'),
  );
  const host = {
    stateDir: path.join(temporary, 'host'),
    agentWritableRoots: [workspace],
    checkerPath: path.join(codeRoot, 'scripts/artifact-acceptance-checker.mjs'),
    boundary: 'owner-full-access',
  };
  const outcomes = [];
  for (const variant of ['good', 'missing-call', 'stuck-cabin']) {
    const artifactPath = path.join(workspace, `${variant}.zip`);
    execFileSync('/usr/bin/python3', [
      path.join(fixture, 'create-fixture.py'),
      variant,
      artifactPath,
    ]);
    const sha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(artifactPath))
      .digest('hex');
    registerArtifactAcceptanceContract({ artifactPath, requirements, host });
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
      inputs: [{ sourcePath: artifactPath, relativePath: 'source.zip' }],
      artifactRelativePath: 'output/artifact.zip',
    });
    let delivery;
    try {
      assert.equal(
        checked.status,
        variant === 'good' ? 'passed' : 'failed',
        checked.code,
      );
      assert.equal(checked.receipt.payload.artifact.sha256, sha256);
      assert.equal(
        checked.receipt.payload.producerIsolation.policy,
        'macos-seatbelt-artifact-v1',
      );
      assert.deepEqual(
        checked.receipt.payload.result.checks.map((check) => check.id),
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
      assert.equal(
        bindRegisteredArtifactAcceptanceReceipt({
          artifactPath,
          receipt: checked.receipt,
          host,
        }).status,
        checked.status,
      );
      delivery =
        await createArtifactAcceptanceDeliveryPolicy(host)(artifactPath);
      assert.equal(delivery.required, true);
      assert.equal(delivery.status, checked.status);
      if (variant === 'good')
        assert.deepEqual(
          fs.readFileSync(delivery.snapshotPath),
          fs.readFileSync(artifactPath),
        );
      else {
        assert.equal(delivery.snapshotPath, undefined);
        assert.ok(checked.receipt.payload.trace.size > 0);
      }
      outcomes.push({
        case: variant,
        status: checked.status,
        artifactSha256: sha256,
        checks: checked.receipt.payload.result.checks.map((check) => check.id),
        actualBrowser: true,
        actualIsolatedJob: true,
        delivery: delivery.status,
        humanAcceptance: 'not_recorded',
      });
    } finally {
      delivery?.cleanup?.();
      checked.cleanup?.();
    }
  }
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        journey: [
          'cross_shaft',
          'call_and_wait_for_cabin',
          'deliver_resource',
          'continue',
        ],
        outcomes,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
