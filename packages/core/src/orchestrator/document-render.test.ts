import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { snapshotDocument } from './document-evidence.js';
import { renderCalculationDocument } from './document-render.js';
import {
  checkCalculationDocuments,
  type CalculationCriteria,
} from './document-reconciliation.js';

const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), 'document-render-test-'),
);
afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));
const fixture = path.resolve('evals/document-reconciliation/fixtures');
const rendererPath = path.resolve('scripts/document-renderer.mjs');
const criteria: CalculationCriteria = {
  template: 'calculation-v1',
  currency: 'USD',
  rounding: 'half_up',
  scale: 2,
};

describe('actual final file reopen and rasterization', () => {
  it('renders every actual PDF page and binds images to exact final bytes', async () => {
    const result = await checkCalculationDocuments({
      sources: [path.join(fixture, 'good.xlsx')],
      final: path.join(fixture, 'good.pdf'),
      criteria,
      reader: { readerPath: path.resolve('scripts/document-reader.mjs') },
      render: { rendererPath, outputDirectory: path.join(temporary, 'pdf') },
    });
    expect(result.status).toBe('pass');
    expect(result.render?.status).toBe('rendered');
    expect(result.render?.pages.map((p) => p.page)).toEqual([1, 2, 3, 4]);
    expect(result.render?.inputSha256).toBe(result.final?.sha256);
    expect(
      fs
        .readFileSync(path.join(temporary, 'pdf/page-4.png'))
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
    expect(result.humanAcceptance).toBe('not_recorded');
  });
  it('does not render different bytes under an old expected hash', async () => {
    const result = await renderCalculationDocument({
      filename: path.join(fixture, 'good.pdf'),
      expectedSha256: '0'.repeat(64),
      outputDirectory: path.join(temporary, 'stale'),
      rendererPath,
    });
    expect(result.status).toBe('incomplete');
    expect(fs.existsSync(path.join(temporary, 'stale'))).toBe(false);
  });
  it('abstains and removes partial output when the optional XLSX viewer is absent', async () => {
    const filename = path.join(fixture, 'good.xlsx');
    const result = await renderCalculationDocument({
      filename,
      expectedSha256: snapshotDocument(filename).snapshot.sha256,
      outputDirectory: path.join(temporary, 'no-viewer'),
      rendererPath,
      sofficeCommand: path.join(temporary, 'missing-soffice'),
    });
    expect(result.status).toBe('incomplete');
    expect(fs.existsSync(path.join(temporary, 'no-viewer'))).toBe(false);
  });
  it('never overwrites an existing output directory', async () => {
    const directory = path.join(temporary, 'existing');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'keep'), 'keep');
    const filename = path.join(fixture, 'good.pdf');
    expect(
      (
        await renderCalculationDocument({
          filename,
          expectedSha256: snapshotDocument(filename).snapshot.sha256,
          outputDirectory: directory,
          rendererPath,
        })
      ).status,
    ).toBe('incomplete');
    expect(fs.readFileSync(path.join(directory, 'keep'), 'utf8')).toBe('keep');
  });
  it('rejects external data features before any viewer process starts', async () => {
    const filename = path.join(temporary, 'external-data.xlsx');
    fs.copyFileSync(path.join(fixture, 'good.xlsx'), filename);
    execFileSync('python3', [
      '-c',
      'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"a") as z: z.writestr("xl/connections.xml", "<connections><connection><webPr url=\\\"https://example.invalid/data\\\"/></connection></connections>")',
      filename,
    ]);
    const marker = path.join(temporary, 'viewer-was-started');
    const viewer = path.join(temporary, 'viewer');
    fs.writeFileSync(viewer, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    const result = await renderCalculationDocument({
      filename,
      expectedSha256: snapshotDocument(filename).snapshot.sha256,
      outputDirectory: path.join(temporary, 'external-render'),
      rendererPath,
      sofficeCommand: viewer,
    });
    expect(result.status).toBe('incomplete');
    expect(fs.existsSync(marker)).toBe(false);
  });
});
