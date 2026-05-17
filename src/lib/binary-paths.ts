import { execFileSync } from 'child_process';
import fs from 'fs';

/**
 * Resolve a binary by name with platform-appropriate fallbacks.
 *
 * Lookup order:
 *   1. `which <name>` on $PATH
 *   2. each entry of `fallbacks` in order, first existing path wins
 *   3. the last entry of `fallbacks` (or `name`) as a last-resort literal —
 *      callers will then get a spawn ENOENT and a clear error path
 *
 * Pure synchronous so it can sit at module load time alongside env-derived
 * constants. Failures in `which` are swallowed; missing binary surfaces at
 * call site, not here.
 */
export function resolveBinary(name: string, fallbacks: string[]): string {
  try {
    const found = execFileSync('which', [name], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (found && fs.existsSync(found)) return found;
  } catch {
    // `which` not found, or binary not on PATH — fall through to fallbacks.
  }
  for (const candidate of fallbacks) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return fallbacks[fallbacks.length - 1] || name;
}

/**
 * Platform-appropriate ffmpeg fallback paths. Apple Silicon Homebrew first,
 * then Intel Mac Homebrew, then Linux package manager defaults.
 */
export const FFMPEG_FALLBACKS = [
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
];

/**
 * Platform-appropriate ffprobe fallback paths (mirrors ffmpeg).
 */
export const FFPROBE_FALLBACKS = [
  '/opt/homebrew/bin/ffprobe',
  '/usr/local/bin/ffprobe',
  '/usr/bin/ffprobe',
];

/**
 * Platform-appropriate whisper-cli fallback paths.
 */
export const WHISPER_FALLBACKS = [
  '/opt/homebrew/bin/whisper-cli',
  '/usr/local/bin/whisper-cli',
  '/usr/bin/whisper-cli',
];
