import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from '@skoobi/shared/logger';
import { basenameOnly } from '@skoobi/shared/log-sanitize';

const BUILD_TIMEOUT_MS = 60_000;
const ANALYSIS_TIMEOUT_MS = 45_000;
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_OUTPUT_CHARS = 4_000;

export interface LocalVisualDescription {
  text: string[];
  labels: string[];
}

function execFileText(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_STDOUT_BYTES },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout || ''));
      },
    );
  });
}

function localVisionSourcePath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '..', 'native', 'skoobi-local-vision.swift');
}

function binaryPathFor(sourcePath: string): string {
  const digest = createHash('sha256')
    .update(sourcePath)
    .digest('hex')
    .slice(0, 12);
  return path.join(process.cwd(), 'tmp', `skoobi-local-vision-${digest}`);
}

let binaryPromise: Promise<string | null> | null = null;

async function ensureLocalVisionBinary(): Promise<string | null> {
  const sourcePath = localVisionSourcePath();
  const binaryPath = binaryPathFor(sourcePath);
  try {
    const [sourceStat, binaryStat] = await Promise.all([
      fs.stat(sourcePath),
      fs.stat(binaryPath).catch(() => null),
    ]);
    if (
      binaryStat?.isFile() &&
      binaryStat.mtimeMs >= sourceStat.mtimeMs &&
      (binaryStat.mode & 0o111) !== 0
    ) {
      return binaryPath;
    }
    await fs.mkdir(path.dirname(binaryPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${binaryPath}.${process.pid}.tmp`;
    await execFileText(
      '/usr/bin/xcrun',
      ['swiftc', '-O', sourcePath, '-o', temporaryPath],
      BUILD_TIMEOUT_MS,
    );
    await fs.chmod(temporaryPath, 0o700);
    await fs.rename(temporaryPath, binaryPath);
    return binaryPath;
  } catch (error) {
    logger.warn(
      {
        errorKind: error instanceof Error ? error.name : typeof error,
      },
      'Local WhatsApp image analyzer unavailable',
    );
    return null;
  }
}

function boundedStrings(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  let chars = 0;
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized || output.includes(normalized)) continue;
    if (chars + normalized.length > MAX_OUTPUT_CHARS) break;
    output.push(normalized);
    chars += normalized.length;
    if (output.length >= maxItems) break;
  }
  return output;
}

export function parseLocalVisualDescription(
  raw: string,
): LocalVisualDescription | null {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; labels?: unknown };
    const result = {
      text: boundedStrings(parsed.text, 80),
      labels: boundedStrings(parsed.labels, 8),
    };
    return result.text.length > 0 || result.labels.length > 0 ? result : null;
  } catch {
    return null;
  }
}

/** Analyze one raster image entirely on this Mac through Apple Vision. */
export async function analyzeImageLocally(
  imagePath: string,
): Promise<LocalVisualDescription | null> {
  if (!binaryPromise) binaryPromise = ensureLocalVisionBinary();
  const binaryPath = await binaryPromise;
  if (!binaryPath) return null;
  try {
    const output = await execFileText(
      binaryPath,
      [imagePath],
      ANALYSIS_TIMEOUT_MS,
    );
    return parseLocalVisualDescription(output);
  } catch (error) {
    logger.warn(
      {
        imageBasename: basenameOnly(imagePath),
        errorKind: error instanceof Error ? error.name : typeof error,
      },
      'Local WhatsApp image analysis failed',
    );
    return null;
  }
}

export function formatLocalVisualDescription(
  description: LocalVisualDescription | null,
): string {
  if (!description) return '';
  const parts: string[] = [];
  if (description.text.length > 0) {
    parts.push(`Распознанный текст: ${description.text.join(' / ')}`);
  }
  if (description.labels.length > 0) {
    parts.push(`Объекты/сцена: ${description.labels.join(', ')}`);
  }
  return parts.join('. ');
}
