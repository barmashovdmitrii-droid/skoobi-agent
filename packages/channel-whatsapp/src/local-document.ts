import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

import { logger } from '@skoobi/shared/logger';
import { basenameOnly } from '@skoobi/shared/log-sanitize';
import {
  PDFTOTEXT_FALLBACKS,
  resolveBinary,
} from '@skoobi/shared/binary-paths';

const MAX_DOCUMENT_TEXT_CHARS = 16_000;
const MAX_DIRECT_READ_BYTES = 256 * 1024;
const DOCUMENT_EXTRACT_TIMEOUT_MS = 45_000;
const DOCUMENT_EXTRACT_MAX_BUFFER = 512 * 1024;

function normalizeExtractedText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_DOCUMENT_TEXT_CHARS);
}

function execText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: DOCUMENT_EXTRACT_TIMEOUT_MS,
        maxBuffer: DOCUMENT_EXTRACT_MAX_BUFFER,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout || ''));
      },
    );
  });
}

/** Best-effort local text extraction; never sends the document off this Mac. */
export async function extractDocumentTextLocally(
  documentPath: string,
): Promise<string | null> {
  const ext = path.extname(documentPath).toLowerCase();
  try {
    let text = '';
    if (
      [
        '.txt',
        '.md',
        '.csv',
        '.json',
        '.xml',
        '.html',
        '.htm',
        '.log',
      ].includes(ext)
    ) {
      const handle = await fs.open(documentPath, 'r');
      try {
        const buffer = Buffer.alloc(MAX_DIRECT_READ_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    } else if (ext === '.pdf') {
      text = await execText(resolveBinary('pdftotext', PDFTOTEXT_FALLBACKS), [
        '-f',
        '1',
        '-l',
        '20',
        documentPath,
        '-',
      ]);
    } else if (['.doc', '.docx', '.rtf', '.odt'].includes(ext)) {
      text = await execText('/usr/bin/textutil', [
        '-convert',
        'txt',
        '-stdout',
        documentPath,
      ]);
    } else {
      return null;
    }
    const normalized = normalizeExtractedText(text);
    return normalized || null;
  } catch (error) {
    logger.warn(
      {
        documentBasename: basenameOnly(documentPath),
        errorKind: error instanceof Error ? error.name : typeof error,
      },
      'Local WhatsApp document extraction failed',
    );
    return null;
  }
}

export const _normalizeExtractedDocumentTextForTest = normalizeExtractedText;
