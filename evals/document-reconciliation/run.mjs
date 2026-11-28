import { runIsolatedArtifactJob } from '../../packages/core/dist/orchestrator/artifact-job.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkCalculationDocuments } from '../../packages/core/dist/orchestrator/document-reconciliation.js';
import { verifyArtifactAcceptanceReceipt } from '../../packages/core/dist/orchestrator/artifact-acceptance.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = path.join(root, 'evals/document-reconciliation/fixtures');
const output = process.argv[2]
  ? path.resolve(process.argv[2])
  : fs.mkdtempSync(path.join(os.tmpdir(), 'document-pilot-'));
if (!fs.existsSync(output)) fs.mkdirSync(output, { mode: 0o700 });
const criteria = JSON.parse(
  fs.readFileSync(
    path.join(root, 'evals/document-reconciliation/criteria.json'),
    'utf8',
  ),
);
const summary = [];
for (const [id, source, final, expected] of [
  ['pdf-final', 'good.xlsx', 'good.pdf', 'pass'],
  ['xlsx-final', 'good.pdf', 'good.xlsx', 'pass'],
  ['russian-xlsx-final', 'good.pdf', 'good-russian.xlsx', 'pass'],
  ['page-four-conflict', 'page4-conflict.pdf', 'good.xlsx', 'incomplete'],
  ['row-21-wrong', 'good.pdf', 'wrong-line.xlsx', 'fail'],
  ['wrong-total', 'good.pdf', 'wrong-total.xlsx', 'fail'],
]) {
  const report = await checkCalculationDocuments({
    sources: [path.join(fixtures, source)],
    final: path.join(fixtures, final),
    criteria,
    reader: { readerPath: path.join(root, 'scripts/document-reader.mjs') },
    render: {
      rendererPath: path.join(root, 'scripts/document-renderer.mjs'),
      outputDirectory: path.join(output, id),
      sofficeCommand: process.env.SKOOBI_TEST_SOFFICE || 'soffice',
    },
  });
  fs.writeFileSync(
    path.join(output, `${id}.json`),
    JSON.stringify(report, null, 2),
    { flag: 'wx', mode: 0o600 },
  );
  summary.push({
    id,
    status: report.status,
    expected,
    render: report.render?.status,
    issues: report.issues.map((i) => i.code),
  });
}
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
if (
  summary.some(
    (item) => item.status !== item.expected || item.render !== 'rendered',
  )
)
  process.exitCode = 1;
if (process.env.SKOOBI_TEST_SOFFICE_NATIVE) {
  const isolated = fs.mkdtempSync(
    path.join(os.tmpdir(), 'document-receipt-eval-'),
  );
  try {
    const producer = path.join(isolated, 'producer');
    fs.mkdirSync(producer);
    const source = path.join(producer, 'source.pdf'),
      final = path.join(producer, 'final.xlsx');
    fs.copyFileSync(path.join(fixtures, 'good.pdf'), source);
    fs.copyFileSync(path.join(fixtures, 'good-russian.xlsx'), final);
    const requirements = {
      schema: 1,
      kind: 'calculation-v1',
      criteria,
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
    const host = {
      stateDir: path.join(isolated, 'host'),
      agentWritableRoots: [producer],
      checkerPath: path.join(root, 'scripts/artifact-acceptance-checker.mjs'),
      documentScriptsDirectory: path.join(root, 'scripts'),
      boundary: 'workspace-isolated',
      sofficeCommand: process.env.SKOOBI_TEST_SOFFICE_NATIVE,
    };
    const result = await runIsolatedArtifactJob({
      host,
      requirements,
      producer: {
        executable: process.execPath,
        args: [
          '-e',
          'require("fs").copyFileSync("inputs/final.xlsx","output/final.xlsx")',
        ],
      },
      inputs: [{ sourcePath: final, relativePath: 'final.xlsx' }],
      artifactRelativePath: 'output/final.xlsx',
    });
    result.cleanup?.();
    const verified =
      result.receipt &&
      verifyArtifactAcceptanceReceipt({
        artifactPath: final,
        requirements,
        receipt: result.receipt,
        host,
      });
    fs.appendFileSync(source, '\nchanged');
    const changed =
      result.receipt &&
      verifyArtifactAcceptanceReceipt({
        artifactPath: final,
        requirements,
        receipt: result.receipt,
        host,
      });
    const receiptSummary = {
      checker: result.status,
      verified: verified?.status,
      afterSourceChange: changed?.status,
      visualReview: result.receipt?.payload.visualReview,
    };
    fs.writeFileSync(
      path.join(output, 'receipt-evaluation.json'),
      JSON.stringify(receiptSummary, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    process.stdout.write(JSON.stringify(receiptSummary) + '\n');
    if (
      result.status !== 'passed' ||
      verified?.status !== 'passed' ||
      changed?.status !== 'stale'
    )
      process.exitCode = 1;
  } finally {
    fs.rmSync(isolated, { recursive: true, force: true });
  }
}
