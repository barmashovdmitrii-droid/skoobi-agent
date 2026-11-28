import fs from 'node:fs';
import path from 'node:path';
import {
  checkCalculationDocuments,
  validateCalculationCriteria,
} from '@skoobi/core/document-reconciliation';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    process.stdout.write(
      'Host calculation diagnostic\nUsage: node dist/scripts/document-check.js --source <source.pdf|xlsx> [--source <another>] --final <final.pdf|xlsx> --criteria <criteria.json> --report <new-report.json> --renders <new-private-directory> [--instance-root <root>] [--python <executable>] [--soffice <executable>]\nOnly calculation-v1 labels/line IDs are supported. No OCR, macros or links execute. Optional LibreOffice renders XLSX with only the approved ROUND/SUM formulas; arithmetic is independently recomputed. Missing renderer returns incomplete. A diagnostic pass is not a trusted acceptance receipt or human approval. Visual review of the reopened final remains separate.\n',
    );
    return;
  }
  const options = new Map<string, string>(),
    sources: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      ![
        '--source',
        '--final',
        '--criteria',
        '--report',
        '--renders',
        '--instance-root',
        '--python',
        '--soffice',
      ].includes(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new Error('invalid_arguments');
    if (key === '--source') sources.push(path.resolve(value));
    else if (options.has(key)) throw new Error('duplicate_argument');
    else options.set(key, value);
  }
  for (const required of ['--final', '--criteria', '--report', '--renders'])
    if (!options.has(required)) throw new Error('missing_argument');
  const criteriaPath = path.resolve(options.get('--criteria')!);
  if (fs.statSync(criteriaPath).size > 4096)
    throw new Error('criteria_too_large');
  const criteria: unknown = JSON.parse(fs.readFileSync(criteriaPath, 'utf8'));
  validateCalculationCriteria(criteria);
  const root = path.resolve(options.get('--instance-root') || process.cwd());
  const report = await checkCalculationDocuments({
    sources,
    final: path.resolve(options.get('--final')!),
    criteria,
    reader: {
      readerPath: path.join(root, 'scripts/document-reader.mjs'),
      pythonCommand: options.get('--python'),
    },
    render: {
      rendererPath: path.join(root, 'scripts/document-renderer.mjs'),
      outputDirectory: path.resolve(options.get('--renders')!),
      sofficeCommand: options.get('--soffice'),
    },
  });
  // Reports contain quoted source evidence: create exclusively, private by default.
  fs.writeFileSync(
    path.resolve(options.get('--report')!),
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      assurance: report.assurance,
      visualReview: report.visualReview,
      issueCount: report.issues.length,
    }) + '\n',
  );
  process.exitCode =
    report.status === 'pass' ? 0 : report.status === 'fail' ? 1 : 2;
}
main().catch(() => {
  process.stderr.write('document_check_failed\n');
  process.exitCode = 2;
});
