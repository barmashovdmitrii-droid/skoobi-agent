// Optional host renderer: reopens the exact final bytes in a fresh profile.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFParse } from 'pdf-parse';

const [format, directory, soffice = 'soffice', python = 'python3'] =
  process.argv.slice(2);
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 16 * 1024 * 1024) throw new Error('size_limit');
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'document-render-'));
fs.chmodSync(scratch, 0o700);
let pdf = bytes,
  sheets;
try {
  if (format === 'xlsx') {
    const metadata = JSON.parse(
      execFileSync(
        python,
        [fileURLToPath(new URL('./document-ooxml.py', import.meta.url))],
        { input: bytes, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      ).toString(),
    );
    sheets = metadata.sheets.length;
    for (const sheet of metadata.sheets)
      for (const cell of sheet.cells) {
        if (
          cell.formula !== undefined &&
          !/^(?:ROUND\(C([1-9]\d{0,3})\*D\1,[0-6]\)|SUM\(E[1-9]\d{0,3}:E[1-9]\d{0,3}\))$/.test(
            cell.formula.replace(/\s/g, '').toUpperCase(),
          )
        )
          throw new Error('unsupported_formula');
      }
    const profile = path.join(scratch, 'profile');
    fs.mkdirSync(profile);
    fs.mkdirSync(path.join(profile, 'user'));
    fs.writeFileSync(
      path.join(profile, 'user/registrymodifications.xcu'),
      `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item></oor:items>`,
    );
    const filename = path.join(scratch, 'final.xlsx');
    fs.writeFileSync(filename, bytes, { mode: 0o600 });
    execFileSync(
      soffice,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless',
        '--nologo',
        '--nodefault',
        '--norestore',
        '--nolockcheck',
        '--convert-to',
        'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}',
        '--outdir',
        scratch,
        filename,
      ],
      {
        timeout: 25_000,
        maxBuffer: 64 * 1024,
        env: { PATH: process.env.PATH || '', HOME: scratch, TMPDIR: scratch },
      },
    );
    const output = path.join(scratch, 'final.pdf');
    if (fs.statSync(output).size > 16 * 1024 * 1024)
      throw new Error('pdf_size');
    pdf = fs.readFileSync(output);
  } else if (format !== 'pdf') throw new Error('format');
  const parser = new PDFParse({ data: pdf });
  try {
    const info = await parser.getInfo({ parsePageInfo: true });
    if (
      info.total < 1 ||
      info.total > 100 ||
      info.pages.length !== info.total ||
      (sheets && info.total !== sheets)
    )
      throw new Error('page_coverage');
    const pages = [];
    let renderedBytes = 0;
    for (const page of info.pages) {
      if (
        page.width < 72 ||
        page.height < 72 ||
        page.width > 2400 ||
        page.height > 3400 ||
        page.height / page.width > 5
      )
        throw new Error('layout_bounds');
      const rendered = await parser.getScreenshot({
        partial: [page.pageNumber],
        desiredWidth: 1200,
        imageDataUrl: false,
        imageBuffer: true,
      });
      if (
        rendered.pages.length !== 1 ||
        rendered.pages[0].data.length > 8 * 1024 * 1024
      )
        throw new Error('render_limit');
      const image = rendered.pages[0];
      renderedBytes += image.data.length;
      if (renderedBytes > 64 * 1024 * 1024) throw new Error('render_limit');
      const filename = `page-${page.pageNumber}.png`;
      fs.writeFileSync(path.join(directory, filename), image.data, {
        flag: 'wx',
        mode: 0o600,
      });
      pages.push({
        page: page.pageNumber,
        width: image.width,
        height: image.height,
        sha256: sha(image.data),
        file: filename,
      });
    }
    const text = await parser.getText();
    if (text.text.length > 1_000_000) throw new Error('text_limit');
    fs.writeFileSync(path.join(directory, 'rendered.pdf'), pdf, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(
      JSON.stringify({
        status: 'rendered',
        inputSha256: sha(bytes),
        pdfSha256: sha(pdf),
        renderer: format === 'pdf' ? 'pdf-parse' : 'libreoffice+pdf-parse',
        pages,
        text: text.text,
      }),
    );
  } finally {
    await parser.destroy();
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
