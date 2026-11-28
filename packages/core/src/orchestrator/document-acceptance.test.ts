import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  runArtifactAcceptance,
  verifyArtifactAcceptanceReceipt,
  type ArtifactAcceptanceHost,
  type ArtifactAcceptanceReceipt,
  type CalculationArtifactAcceptanceRequirements,
} from './artifact-acceptance.js';
import {
  createArtifactAcceptanceDeliveryPolicy,
  registerArtifactAcceptanceContract,
  bindRegisteredArtifactAcceptanceReceipt,
} from './artifact-acceptance-policy.js';
import { runIsolatedArtifactJob } from './artifact-job.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-receipt-'));
const workspace = path.join(root, 'producer');
fs.mkdirSync(workspace);
const source = path.join(workspace, 'source.xlsx'),
  final = path.join(workspace, 'final.pdf');
fs.copyFileSync(
  path.resolve('evals/document-reconciliation/fixtures/good.xlsx'),
  source,
);
fs.copyFileSync(
  path.resolve('evals/document-reconciliation/fixtures/good.pdf'),
  final,
);
const host: ArtifactAcceptanceHost = {
  stateDir: path.join(root, 'host'),
  agentWritableRoots: [workspace],
  checkerPath: path.resolve('scripts/artifact-acceptance-checker.mjs'),
  documentScriptsDirectory: path.resolve('scripts'),
  boundary: 'owner-full-access',
};
const requirements: CalculationArtifactAcceptanceRequirements = {
  schema: 1,
  kind: 'calculation-v1',
  criteria: {
    template: 'calculation-v1',
    currency: 'USD',
    scale: 2,
    rounding: 'half_up',
  },
  sources: [
    {
      path: fs.realpathSync(source),
      sha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(source))
        .digest('hex'),
    },
  ],
};
let receipt: ArtifactAcceptanceReceipt;
beforeAll(async () => {
  if (process.platform !== 'darwin') return;
  registerArtifactAcceptanceContract({
    artifactPath: final,
    requirements,
    host,
  });
  const result = await runIsolatedArtifactJob({ host, requirements,
    producer: { executable: process.execPath, args: ['-e', 'require("node:fs").copyFileSync("inputs/final.pdf","output/final.pdf")'] },
    inputs: [{ sourcePath: final, relativePath: 'final.pdf' }], artifactRelativePath: 'output/final.pdf' });
  expect(result).toMatchObject({ status: 'passed', code: 'checks_passed' });
  receipt = result.receipt!;
  expect(bindRegisteredArtifactAcceptanceReceipt({ artifactPath: final, receipt, host }).status).toBe('passed');
  result.cleanup?.();
}, 30_000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe.runIf(process.platform === 'darwin')('document receipt uses the host checker and exact source/final versions', () => {
  it('binds all sources, criteria, actual render and validator without human approval', () => {
    expect(receipt.payload.sources?.[0]).toMatchObject(requirements.sources[0]);
    expect(receipt.payload.validator.id).toBe('calculation-document');
    expect(receipt.payload.result.checks.map((c) => c.id)).toContain(
      'final_reopened_and_rendered',
    );
    expect(receipt.payload.humanAcceptance).toBe('not_recorded');
    expect(receipt.payload.visualReview).toBe('not_recorded');
    expect(receipt.payload.renderAssessment).toBe(
      'openability_and_text_smoke_only',
    );
    expect(
      verifyArtifactAcceptanceReceipt({
        artifactPath: final,
        requirements,
        receipt,
        host,
      }).status,
    ).toBe('passed');
  });
  it('delivers a protected copy with original filename; a later workspace edit cannot alter sent bytes', async () => {
    const decision = await createArtifactAcceptanceDeliveryPolicy(host)(final);
    expect(decision.status).toBe('passed');
    expect(path.basename(decision.snapshotPath!)).toBe('final.pdf');
    const original = fs.readFileSync(final);
    try {
      fs.appendFileSync(final, '\nchanged');
      expect(fs.readFileSync(decision.snapshotPath!)).toEqual(original);
      expect(
        verifyArtifactAcceptanceReceipt({
          artifactPath: final,
          requirements,
          receipt,
          host,
        }).status,
      ).toBe('stale');
    } finally {
      fs.writeFileSync(final, original);
      decision.cleanup!();
    }
  });
  it('blocks delivery after any source changes, even when final bytes still match', async () => {
    const original = fs.readFileSync(source);
    try {
      fs.appendFileSync(source, '\nchanged');
      expect(
        verifyArtifactAcceptanceReceipt({
          artifactPath: final,
          requirements,
          receipt,
          host,
        }),
      ).toMatchObject({ status: 'stale', code: 'source_changed' });
      expect(
        await createArtifactAcceptanceDeliveryPolicy(host)(final),
      ).toMatchObject({ required: true, status: 'stale' });
    } finally {
      fs.writeFileSync(source, original);
    }
  });
  it('rejects changed criteria and forged model-provided pass JSON', () => {
    expect(
      verifyArtifactAcceptanceReceipt({
        artifactPath: final,
        requirements: {
          ...requirements,
          criteria: { ...requirements.criteria, currency: 'EUR' },
        },
        receipt,
        host,
      }).status,
    ).toBe('stale');
    const forged = structuredClone(receipt);
    forged.payload.sources![0].sha256 = '0'.repeat(64);
    expect(
      verifyArtifactAcceptanceReceipt({
        artifactPath: final,
        requirements,
        receipt: forged,
        host,
      }).status,
    ).toBe('untrusted');
    expect(
      verifyArtifactAcceptanceReceipt({
        artifactPath: final,
        requirements,
        receipt: { status: 'pass', verified: true },
        host,
      }).status,
    ).toBe('untrusted');
  });
  it('cannot promote a same-user full-access diagnostic to trusted acceptance', async () => {
    expect(
      await runArtifactAcceptance({
        artifactPath: final,
        requirements,
        host: { ...host, boundary: 'owner-full-access' },
      }),
    ).toMatchObject({ status: 'inconclusive', code: 'isolation_unavailable' });
  });
  it('cannot bypass the producer controller with declared writable roots and rejects altered checker code', async () => {
    for (const roots of [[workspace, path.resolve('scripts')], [workspace, path.resolve('node_modules/pdf-parse')]]) {
      expect(await runArtifactAcceptance({ artifactPath: final, requirements,
        host: { ...host, boundary: 'workspace-isolated', agentWritableRoots: roots },
        jobAttestation: { verified: true } }))
        .toMatchObject({ status: 'inconclusive', code: 'isolation_unavailable' });
    }
    const altered = path.join(root, 'altered');
    fs.mkdirSync(altered);
    for (const name of ['document-reader.mjs', 'document-renderer.mjs', 'document-ooxml.py'])
      fs.copyFileSync(path.resolve('scripts', name), path.join(altered, name));
    fs.appendFileSync(path.join(altered, 'document-reader.mjs'), '\n// altered');
    const result = await runIsolatedArtifactJob({ host: { ...host, documentScriptsDirectory: altered }, requirements,
      producer: { executable: process.execPath, args: ['-e', 'require("node:fs").copyFileSync("inputs/final.pdf","output/final.pdf")'] },
      inputs: [{ sourcePath: final, relativePath: 'final.pdf' }], artifactRelativePath: 'output/final.pdf' });
    try { expect(result).toMatchObject({ status: 'inconclusive', code: 'checker_untrusted' }); }
    finally { result.cleanup?.(); }
  }, 30_000);
});
