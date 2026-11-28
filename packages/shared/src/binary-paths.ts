import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Resolve an executable without assuming Apple Silicon Homebrew paths.
 *
 * Environment overrides remain the caller's first choice. This helper checks
 * PATH, then reviewed platform fallbacks. If none exists, it returns the
 * executable name so the eventual spawn reports a normal ENOENT.
 */
export function resolveBinary(name: string, fallbacks: readonly string[]): string {
  try {
    const found = execFileSync('which', [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (found && existsSync(found)) return found;
  } catch {
    // Missing `which` or executable: continue with explicit fallbacks.
  }

  for (const candidate of fallbacks) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return name;
}

export const FFMPEG_FALLBACKS = [
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
] as const;

export const FFPROBE_FALLBACKS = [
  '/opt/homebrew/bin/ffprobe',
  '/usr/local/bin/ffprobe',
  '/usr/bin/ffprobe',
] as const;

export const WHISPER_FALLBACKS = [
  '/opt/homebrew/bin/whisper-cli',
  '/usr/local/bin/whisper-cli',
  '/usr/bin/whisper-cli',
] as const;

export const PDFTOTEXT_FALLBACKS = [
  '/opt/homebrew/bin/pdftotext',
  '/usr/local/bin/pdftotext',
  '/usr/bin/pdftotext',
] as const;
