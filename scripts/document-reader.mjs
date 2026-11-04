// Host diagnostic reader. No formula, macro, link, or document instruction is executed.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';
import readXlsxFile from 'read-excel-file/node';

const MAX = 16 * 1024 * 1024;
const chunks = [];
let length = 0;
for await (const chunk of process.stdin) {
  length += chunk.length;
  if (length > MAX) throw new Error('document_too_large');
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
const format = process.argv[2];
let result;
if (format === 'pdf') {
  const reader = new PDFParse({ data: bytes });
  try {
    const info = await reader.getInfo();
    if (info.total < 1 || info.total > 100) throw new Error('page_limit');
    const text = await reader.getText();
    if (text.pages.length !== info.total || text.text.length > 1_000_000)
      throw new Error('coverage_limit');
    result = {
      format,
      pages: text.pages.map((p) => ({
        number: p.num,
        lines: p.text.split(/\r?\n/),
      })),
    };
  } finally {
    await reader.destroy();
  }
} else if (format === 'xlsx') {
  const python = process.argv[3] || 'python3';
  const metadata = JSON.parse(
    execFileSync(
      python,
      [fileURLToPath(new URL('./document-ooxml.py', import.meta.url))],
      {
        input: bytes,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { PATH: process.env.PATH || '' },
      },
    ).toString(),
  );
  // Existing workbook reader independently opens every sheet. Raw OOXML cells
  // retain decimal lexemes, formula text, and A1 positions lost by text previews.
  const parsed = await readXlsxFile(bytes, { parseNumber: (raw) => ({ raw }) });
  if (
    parsed.length !== metadata.sheets.length ||
    parsed.some((s, i) => s.sheet !== metadata.sheets[i].name)
  )
    throw new Error('sheet_coverage');
  result = { format, sheets: metadata.sheets };
} else throw new Error('unsupported_format');
const output = JSON.stringify(result);
if (output.length > 4 * 1024 * 1024) throw new Error('output_limit');
process.stdout.write(output);
