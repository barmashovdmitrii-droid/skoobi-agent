/**
 * Telegram document download + safe text preview.
 *
 * The channel layer stores the original file in the group's `received/`
 * directory and exposes a short preview in message history. Full content stays
 * on disk; the agent can use the relative `received/<file>` path when it needs
 * to inspect the original.
 */

import { execFile } from 'child_process';
import { createWriteStream, promises as fs } from 'fs';
import https from 'https';
import path from 'path';
import { promisify } from 'util';

import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import readXlsxFile from 'read-excel-file/node';

import { basenameOnly } from './lib/log-sanitize.js';
import { resolveGroupFolderPath } from './orchestrator/group-folder.js';
import { logger } from './orchestrator/logger.js';

const execFileAsync = promisify(execFile);

const MAX_PREVIEW_CHARS = 5000;
const MAX_DIRECT_READ_BYTES = 512 * 1024;
const MAX_EXTRACT_BYTES = 25 * 1024 * 1024;

export interface TelegramDocumentResult {
  filePath: string | null;
  originalName: string;
  preview: string | null;
  extractedChars: number;
  extractionStatus: 'ok' | 'unsupported' | 'empty' | 'too-large' | 'failed';
}

function downloadUrl(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          file.close();
          void fs.unlink(dest).catch(() => {});
          reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

function getTelegramFileInfo(url: string): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

function cleanText(text: string): string {
  return text
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function capPreview(text: string): { preview: string | null; chars: number } {
  const cleaned = cleanText(text);
  if (!cleaned) return { preview: null, chars: 0 };
  const suffix = cleaned.length > MAX_PREVIEW_CHARS ? '\n...truncated' : '';
  return {
    preview: cleaned.slice(0, MAX_PREVIEW_CHARS) + suffix,
    chars: cleaned.length,
  };
}

export function safeTelegramDocumentName(name?: string | null): string {
  const fallback = 'document';
  const raw = (name || fallback).normalize('NFKC').trim();
  const base = /^(\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(raw)
    ? path.basename(raw)
    : raw;
  const safe =
    base
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/[/:\\]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || fallback;
  return safe;
}

function extensionFor(remotePath: string, originalName: string): string {
  const fromName = path.extname(originalName);
  if (fromName) return fromName;
  const fromRemote = path.extname(remotePath);
  return fromRemote || '.bin';
}

async function extractPlainText(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, MAX_DIRECT_READ_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function extractPdfText(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText({ partial: [1, 2, 3] });
    return result.text || '';
  } finally {
    await parser.destroy();
  }
}

async function extractDocxText(filePath: string): Promise<string> {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || '';
}

async function extractSpreadsheetText(filePath: string): Promise<string> {
  const sheets = await readXlsxFile(filePath);
  const sheetNames = sheets.map((sheet) => sheet.sheet);
  const lines: string[] = [`Sheets: ${sheetNames.join(', ')}`];
  for (const sheet of sheets.slice(0, 5)) {
    const rows = sheet.data;
    const sheetName = sheet.sheet;
    lines.push(`\nSheet: ${sheetName}`);
    for (const row of rows.slice(0, 20)) {
      const values = row
        .slice(0, 12)
        .map((cell) => String(cell).trim())
        .filter(Boolean);
      if (values.length > 0) lines.push(values.join(' | '));
    }
  }
  return lines.join('\n');
}

async function extractWithTextutil(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    '/usr/bin/textutil',
    ['-convert', 'txt', '-stdout', filePath],
    { timeout: 30_000, maxBuffer: MAX_PREVIEW_CHARS * 8 },
  );
  return stdout;
}

export async function extractDocumentPreview(
  filePath: string,
): Promise<Pick<TelegramDocumentResult, 'preview' | 'extractedChars' | 'extractionStatus'>> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_EXTRACT_BYTES) {
      return {
        preview: null,
        extractedChars: 0,
        extractionStatus: 'too-large',
      };
    }

    const ext = path.extname(filePath).toLowerCase();
    let text: string | null = null;
    if (['.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html'].includes(ext)) {
      text = await extractPlainText(filePath);
    } else if (ext === '.pdf') {
      text = await extractPdfText(filePath);
    } else if (ext === '.docx') {
      text = await extractDocxText(filePath);
    } else if (['.xlsx', '.xlsm'].includes(ext)) {
      text = await extractSpreadsheetText(filePath);
    } else if (['.doc', '.rtf', '.odt'].includes(ext)) {
      text = await extractWithTextutil(filePath);
    } else {
      return {
        preview: null,
        extractedChars: 0,
        extractionStatus: 'unsupported',
      };
    }

    const capped = capPreview(text || '');
    return {
      preview: capped.preview,
      extractedChars: capped.chars,
      extractionStatus: capped.preview ? 'ok' : 'empty',
    };
  } catch (err) {
    logger.warn(
      { err, documentBasename: basenameOnly(filePath) },
      'Document preview extraction failed',
    );
    return { preview: null, extractedChars: 0, extractionStatus: 'failed' };
  }
}

export function documentPlaceholder(result: TelegramDocumentResult): string {
  const relative = result.filePath
    ? `received/${path.basename(result.filePath)}`
    : null;
  const parts = [`Document: ${result.originalName}`];
  if (relative) parts.push(`File: ${relative}`);
  if (result.preview) {
    parts.push(`Preview: ${result.preview}`);
  } else {
    parts.push(`Preview unavailable (${result.extractionStatus})`);
  }
  return `[${parts.join('. ')}]`;
}

export async function processTelegramDocument(
  botToken: string,
  fileId: string,
  groupFolder: string,
  originalFileName?: string | null,
): Promise<TelegramDocumentResult> {
  const originalName = safeTelegramDocumentName(originalFileName);
  try {
    const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
    const fileInfo = await getTelegramFileInfo(infoUrl);
    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      logger.warn({ fileId, fileInfo }, 'Failed to get Telegram document info');
      return {
        filePath: null,
        originalName,
        preview: null,
        extractedChars: 0,
        extractionStatus: 'failed',
      };
    }

    const groupDir = resolveGroupFolderPath(groupFolder);
    const receivedDir = path.join(groupDir, 'received');
    await fs.mkdir(receivedDir, { recursive: true });

    const remotePath = String(fileInfo.result.file_path);
    const ext = extensionFor(remotePath, originalName);
    const stem = originalName.replace(/\.[^.]+$/, '').slice(0, 80) || 'document';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(
      receivedDir,
      `${ts}-document-${fileId.slice(-8)}-${stem}${ext}`,
    );

    const dlUrl = `https://api.telegram.org/file/bot${botToken}/${remotePath}`;
    await downloadUrl(dlUrl, dest);
    const stat = await fs.stat(dest);
    const preview = await extractDocumentPreview(dest);
    logger.info(
      {
        fileId,
        documentBasename: basenameOnly(dest),
        bytes: stat.size,
        extractionStatus: preview.extractionStatus,
        extractedChars: preview.extractedChars,
      },
      'Processed Telegram document',
    );
    return {
      filePath: dest,
      originalName,
      ...preview,
    };
  } catch (err) {
    logger.error({ err, fileId }, 'Telegram document processing failed');
    return {
      filePath: null,
      originalName,
      preview: null,
      extractedChars: 0,
      extractionStatus: 'failed',
    };
  }
}
