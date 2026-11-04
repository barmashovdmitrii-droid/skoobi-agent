import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readDocumentEvidence,
  type DocumentEvidence,
} from './document-evidence.js';
import {
  checkCalculationDocuments,
  documentReportCurrent,
  exactLineAmount,
  reconcileDocumentEvidence,
  type CalculationCriteria,
} from './document-reconciliation.js';

const fixtures = path.resolve('evals/document-reconciliation/fixtures');
const reader = {
  readerPath: path.resolve('scripts/document-reader.mjs'),
  pythonCommand: 'python3',
};
const criteria: CalculationCriteria = {
  template: 'calculation-v1',
  currency: 'USD',
  scale: 2,
  rounding: 'half_up',
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'document-check-'));
afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));

describe('full document reconciliation using real PDF/XLSX files', () => {
  let pdf: DocumentEvidence, xlsx: DocumentEvidence;
  beforeAll(async () => {
    pdf = await readDocumentEvidence(path.join(fixtures, 'good.pdf'), reader);
    xlsx = await readDocumentEvidence(path.join(fixtures, 'good.xlsx'), reader);
  });
  it('reads all four pages and actual row 21 without collapsing blank B cells', () => {
    expect(pdf.content.format).toBe('pdf');
    if (pdf.content.format === 'pdf')
      expect(pdf.content.pages.map((p) => p.number)).toEqual([1, 2, 3, 4]);
    expect(xlsx.content.format).toBe('xlsx');
    if (xlsx.content.format === 'xlsx') {
      const cells = xlsx.content.sheets[0].cells;
      expect(cells.find((c) => c.address === 'C21')?.value).toBe('3');
      expect(cells.find((c) => c.address === 'B21')?.value ?? '').toBe('');
      expect(cells.find((c) => c.address === 'E21')?.formula).toBe(
        'ROUND(C21*D21,2)',
      );
    }
    const result = reconcileDocumentEvidence([pdf], xlsx, criteria);
    expect(result).toMatchObject({
      status: 'pass',
      computedTotal: '3.02',
      assurance: 'diagnostic_only',
      humanAcceptance: 'not_recorded',
      visualReview: 'required_separately',
    });
    expect(result.rows[0].amount.evidence[0].anchor).toBe('Calculation!E21');
    expect(result.sourceFields.Total.evidence[0].anchor).toMatch(/^page:4\//);
    expect(result.finalFields.Total.evidence[0].value).toBe(
      '3.0199999999999996',
    );
  });
  it('finds a contradictory organization on page four, not only the preview', async () => {
    const bad = await readDocumentEvidence(
      path.join(fixtures, 'page4-conflict.pdf'),
      reader,
    );
    const result = reconcileDocumentEvidence([bad], xlsx, criteria);
    expect(result.status).toBe('incomplete');
    expect(result.sourceFields.Organization.state).toBe('conflicting');
    expect(
      result.sourceFields.Organization.evidence.some((e) =>
        e.anchor.startsWith('page:4/'),
      ),
    ).toBe(true);
  });
  it.each(['wrong-line', 'wrong-total'])(
    'rejects actual saved %s arithmetic despite a readable file',
    async (variant) => {
      const result = await checkCalculationDocuments({
        sources: [path.join(fixtures, 'good.pdf')],
        final: path.join(fixtures, `${variant}.xlsx`),
        criteria,
        reader,
      });
      expect(result.status).toBe('fail');
      expect(
        result.issues.some(
          (i) =>
            i.code ===
            (variant === 'wrong-line' ? 'line_arithmetic' : 'total_arithmetic'),
        ),
      ).toBe(true);
    },
  );
  it.each(['missing-date', 'missing-quantity', 'unknown-formula'])(
    'abstains for %s without guessing or trusting formula caches',
    async (variant) => {
      const bad = await readDocumentEvidence(
        path.join(fixtures, `${variant}.xlsx`),
        reader,
      );
      const result = reconcileDocumentEvidence([pdf], bad, criteria);
      expect(result.status).not.toBe('pass');
      expect(result.issues.some((i) => i.severity === 'incomplete')).toBe(true);
    },
  );
  it('reports incompatible sources and currency explicitly', async () => {
    const other = await readDocumentEvidence(
      path.join(fixtures, 'conflicting.xlsx'),
      reader,
    );
    expect(
      reconcileDocumentEvidence([pdf, other], xlsx, criteria).sourceFields
        .Organization.state,
    ).toBe('conflicting');
    expect(
      reconcileDocumentEvidence([pdf], xlsx, {
        ...criteria,
        currency: 'EUR',
      }).issues.some((i) => i.code === 'currency_mismatch'),
    ).toBe(true);
  });
  it('uses strict Russian label aliases without guessing customer/contractor roles', async () => {
    const russian = await readDocumentEvidence(
      path.join(fixtures, 'good-russian.xlsx'),
      reader,
    );
    expect(reconcileDocumentEvidence([pdf], russian, criteria).status).toBe(
      'pass',
    );
    const changed = structuredClone(russian);
    if (changed.content.format === 'xlsx')
      changed.content.sheets[0].cells.find((c) => c.address === 'A4')!.value =
        'Заказчик';
    expect(
      reconcileDocumentEvidence([pdf], changed, criteria).finalFields
        .Organization.state,
    ).toBe('missing');
  });
  it('does not bless the same wrong calculation copied from source to final', async () => {
    const wrong = await readDocumentEvidence(
      path.join(fixtures, 'wrong-line.xlsx'),
      reader,
    );
    expect(
      reconcileDocumentEvidence([wrong], wrong, criteria).issues.some(
        (i) => i.code === 'source_line_arithmetic',
      ),
    ).toBe(true);
  });
  it('invalidates reports after source bytes, final bytes, or criteria change', async () => {
    const source = path.join(temporary, 'source.pdf'),
      final = path.join(temporary, 'final.xlsx');
    fs.copyFileSync(path.join(fixtures, 'good.pdf'), source);
    fs.copyFileSync(path.join(fixtures, 'good.xlsx'), final);
    const report = await checkCalculationDocuments({
      sources: [source],
      final,
      criteria,
      reader,
    });
    expect(report.status).toBe('incomplete');
    expect(report.issues.some((i) => i.code === 'render_not_configured')).toBe(
      true,
    );
    expect(documentReportCurrent(report, criteria)).toBe(true);
    expect(
      documentReportCurrent(report, { ...criteria, rounding: 'half_even' }),
    ).toBe(false);
    fs.appendFileSync(source, '\n');
    expect(documentReportCurrent(report, criteria)).toBe(false);
    fs.copyFileSync(path.join(fixtures, 'good.pdf'), source);
    fs.appendFileSync(final, '\n');
    expect(documentReportCurrent(report, criteria)).toBe(false);
  });
  it('returns incomplete for missing readers or malformed input', async () => {
    const result = await checkCalculationDocuments({
      sources: [path.join(fixtures, 'good.pdf')],
      final: path.join(fixtures, 'good.xlsx'),
      criteria,
      reader: { readerPath: path.join(temporary, 'absent.mjs') },
    });
    expect(result.status).toBe('incomplete');
    const invalid = path.join(temporary, 'invalid.pdf');
    fs.writeFileSync(invalid, 'not a PDF');
    await expect(readDocumentEvidence(invalid, reader)).rejects.toThrow();
  });
});

describe('exact decimal and explicit rounding', () => {
  it('avoids IEEE arithmetic for tie cases and large coefficients', () => {
    expect(exactLineAmount('3', '0.335', criteria)).toBe('1.01');
    expect(exactLineAmount('1', '1.005', criteria)).toBe('1.01');
    expect(
      exactLineAmount('1', '1.005', { ...criteria, rounding: 'half_even' }),
    ).toBe('1.00');
    expect(exactLineAmount('-1', '1.005', criteria)).toBe('-1.01');
    expect(exactLineAmount('9007199254740993', '0.01', criteria)).toBe(
      '90071992547409.93',
    );
    expect(() => exactLineAmount('1,000', '2', criteria)).toThrow();
    expect(() => exactLineAmount('NaN', '2', criteria)).toThrow();
  });
});

describe('OOXML rejection before the workbook library opens hostile input', () => {
  it.each([
    'traversal',
    'duplicate',
    'entity',
    'external',
    'macro',
    'dimensions',
    'symlink',
    'external-data',
    'external-lower',
  ])('rejects %s', async (variant) => {
    const file = path.join(temporary, `${variant}.xlsx`);
    execFileSync(
      'python3',
      [
        '-c',
        `import sys,zipfile,io,warnings
warnings.simplefilter('ignore',UserWarning)
src,dst,variant=sys.argv[1:]
with zipfile.ZipFile(src) as original,zipfile.ZipFile(dst,'w') as output:
 for item in original.infolist():
  data=original.read(item.filename)
  if variant=='entity' and item.filename=='xl/styles.xml': data=b'<!DOCTYPE x [<!ENTITY boom "expanded">]>'+data
  if variant=='external' and item.filename=='xl/_rels/workbook.xml.rels': data=data.replace(b'</Relationships>',b'<Relationship Id="evil" Target="https://example.invalid/" TargetMode="External" Type="external"/></Relationships>')
  if variant=='external-lower' and item.filename=='xl/_rels/workbook.xml.rels': data=data.replace(b'</Relationships>',b'<Relationship Id="evil" Target="https://example.invalid/" TargetMode="external" Type="external"/></Relationships>')
  if variant=='dimensions' and item.filename=='xl/worksheets/sheet1.xml': data=data.replace(b'<x:sheetViews>',b'<x:dimension ref="A1:XFD1048576"/><x:sheetViews>')
  output.writestr(item,data)
 if variant=='traversal': output.writestr('../escape','bad')
 if variant=='duplicate': output.writestr('xl/workbook.xml','duplicate')
 if variant=='macro': output.writestr('xl/vbaProject.bin','bad')
 if variant=='external-data': output.writestr('xl/connections.xml','<connections><connection><webPr url="https://example.invalid/data"/></connection></connections>')
 if variant=='symlink':
  entry=zipfile.ZipInfo('link');entry.create_system=3;entry.external_attr=0o120777<<16;output.writestr(entry,'target')
`,
        path.join(fixtures, 'good.xlsx'),
        file,
        variant,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    await expect(readDocumentEvidence(file, reader)).rejects.toThrow();
  });
});
