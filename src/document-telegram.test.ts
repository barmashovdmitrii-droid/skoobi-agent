import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  documentPlaceholder,
  extractDocumentPreview,
  safeTelegramDocumentName,
  type TelegramDocumentResult,
} from './document-telegram.js';

const execFileAsync = promisify(execFile);

async function writeFixtureWorkbook(
  filePath: string,
  dir: string,
): Promise<void> {
  const root = path.join(dir, 'xlsx-src');
  await fs.mkdir(path.join(root, '_rels'), { recursive: true });
  await fs.mkdir(path.join(root, 'xl', '_rels'), { recursive: true });
  await fs.mkdir(path.join(root, 'xl', 'worksheets'), { recursive: true });
  await fs.writeFile(
    path.join(root, '[Content_Types].xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    'utf8',
  );
  await fs.writeFile(
    path.join(root, '_rels', '.rels'),
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'xl', 'workbook.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'xl', '_rels', 'workbook.xml.rels'),
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'xl', 'worksheets', 'sheet1.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Month</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>May</t></is></c><c r="B2"><v>120000</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>June</t></is></c><c r="B3"><v>130000</v></c></row>
  </sheetData>
</worksheet>`,
    'utf8',
  );
  await execFileAsync('/usr/bin/zip', ['-qr', filePath, '.'], { cwd: root });
}

describe('document-telegram', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'document-telegram-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('sanitizes Telegram file names without dropping readable names', () => {
    expect(safeTelegramDocumentName('Договор / май.docx')).toBe(
      'Договор _ май.docx',
    );
    expect(safeTelegramDocumentName('../май.docx')).toBe('май.docx');
    expect(safeTelegramDocumentName('')).toBe('document');
  });

  it('extracts a capped preview from plain text files', async () => {
    const file = path.join(dir, 'note.txt');
    await fs.writeFile(file, 'Первая строка\n\n\n\nВторая строка', 'utf8');

    const result = await extractDocumentPreview(file);

    expect(result).toMatchObject({
      preview: 'Первая строка\n\n\nВторая строка',
      extractedChars: 29,
      extractionStatus: 'ok',
    });
  });

  it('summarizes workbook sheets and rows', async () => {
    const file = path.join(dir, 'budget.xlsx');
    await writeFixtureWorkbook(file, dir);

    const result = await extractDocumentPreview(file);

    expect(result.extractionStatus).toBe('ok');
    expect(result.preview).toContain('Sheets: Budget');
    expect(result.preview).toContain('Month | Amount');
    expect(result.preview).toContain('May | 120000');
  });

  it('builds placeholders with only relative received paths', () => {
    const result: TelegramDocumentResult = {
      filePath: path.join(dir, 'received', 'report.pdf'),
      originalName: 'report.pdf',
      preview: 'Short summary',
      extractedChars: 13,
      extractionStatus: 'ok',
    };

    expect(documentPlaceholder(result)).toBe(
      '[Document: report.pdf. File: received/report.pdf. Preview: Short summary]',
    );
  });
});
