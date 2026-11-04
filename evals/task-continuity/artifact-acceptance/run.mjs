// Reproducible real-browser evaluation against the built, shipped host modules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  registerArtifactAcceptanceContract,
  bindRegisteredArtifactAcceptanceReceipt,
  createArtifactAcceptanceDeliveryPolicy,
} from '../../../packages/core/dist/orchestrator/artifact-acceptance-policy.js';

import { runIsolatedArtifactJob } from '../../../packages/core/dist/orchestrator/artifact-job.js';

if (process.platform !== 'darwin') {
  console.log(
    JSON.stringify({
      status: 'inconclusive',
      code: 'isolation_platform_unsupported',
    }),
  );
  process.exit(2);
}
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), 'artifact-browser-eval-'),
);
try {
  const workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(workspace);
  const host = {
    stateDir: path.join(temporary, 'host'),
    agentWritableRoots: [workspace],
    checkerPath: path.join(root, 'scripts/artifact-acceptance-checker.mjs'),
    boundary: 'owner-full-access',
  };
  const requirements = JSON.parse(
    fs.readFileSync(path.join(directory, 'requirements.json'), 'utf8'),
  );
  const outcomes = [];
  for (const variant of ['good', 'broken']) {
    const artifactPath = path.join(workspace, `${variant}.zip`);
    execFileSync('/usr/bin/python3', [
      path.join(directory, 'create-fixture.py'),
      variant,
      artifactPath,
    ]);
    registerArtifactAcceptanceContract({ artifactPath, requirements, host });
    const checked = await runIsolatedArtifactJob({
      host,
      requirements,
      producer: {
        executable: process.execPath,
        args: [
          '-e',
          'require("fs").copyFileSync("inputs/source.zip","output/artifact.zip")',
        ],
      },
      inputs: [{ sourcePath: artifactPath, relativePath: 'source.zip' }],
      artifactRelativePath: 'output/artifact.zip',
    });
    try {
      assert.equal(
        bindRegisteredArtifactAcceptanceReceipt({
          artifactPath,
          receipt: checked.receipt,
          host,
        }).status,
        checked.status,
      );
    } finally {
      checked.cleanup?.();
    }
    assert.equal(checked.status, variant === 'good' ? 'passed' : 'failed');
    const decision =
      await createArtifactAcceptanceDeliveryPolicy(host)(artifactPath);
    try {
      assert.equal(decision.required, true);
      assert.equal(decision.status, checked.status);
      if (variant === 'good') {
        const bytes = fs.readFileSync(artifactPath);
        fs.writeFileSync(artifactPath, 'changed after verification');
        assert.deepEqual(fs.readFileSync(decision.snapshotPath), bytes);
      }
      outcomes.push({
        case: variant,
        status: checked.status,
        actualBrowser: true,
        checks: checked.receipt.payload.result.checks.length,
        failureTrace: Boolean(checked.receipt.payload.trace),
        humanAcceptance: 'not_recorded',
      });
    } finally {
      decision.cleanup?.();
    }
  }
  process.stdout.write(
    `${JSON.stringify({ synthetic: true, outcomes }, null, 2)}\n`,
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
