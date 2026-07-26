/**
 * Extension loader for ClaudeClaw.
 * Scans extensions/claudeclaw-* for manifest.json files,
 * validates them, and dynamically imports their entry points.
 * Extensions self-register via registerChannel() or registerExtension() on import.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { logger } from './logger.js';
import { validateManifest, type ExtensionManifest, type LoadResult } from './extension-manifest.js';

// Only these module extensions may be imported as an extension entry point.
const ALLOWED_ENTRY_EXTENSIONS = new Set(['.js', '.mjs']);

/**
 * Resolve a manifest's `entry` against its extension directory and assert it is
 * safe to import: it must stay within the extension root (no `..` traversal, no
 * absolute path, no null bytes) and must be a JS/MJS module.
 *
 * Returns the resolved absolute entry path, or `null` if the entry escapes the
 * extension root or is not an allowed module type. A manifest is attacker-
 * controlled in a multi-tenant install, so an entry like "../../evil.js" must
 * never be loaded.
 */
export function resolveExtensionEntry(extensionRoot: string, entry: string): string | null {
  if (typeof entry !== 'string' || entry.length === 0 || entry.includes('\0')) {
    return null;
  }
  const root = path.resolve(extensionRoot);
  const entryPath = path.resolve(root, entry);
  const rel = path.relative(root, entryPath);
  // Must stay strictly within the extension root (reject "" / ".." / absolute).
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  if (!ALLOWED_ENTRY_EXTENSIONS.has(path.extname(entryPath).toLowerCase())) {
    return null;
  }
  // Finding #50: the lexical containment check above is not enough — a symlink
  // anywhere along the resolved path (the entry file itself, or any directory
  // component) can point outside the extension root, so the file we'd actually
  // import is attacker-controlled even though the manifest `entry` string looks
  // contained. Canonicalize both the root and the entry path with realpath and
  // re-assert containment against the *real* targets, rejecting any symlink
  // escape before the import in loadExtensions().
  //
  // We only enforce this when the paths exist on disk: realpathSync throws
  // ENOENT for paths that aren't present yet, and `resolveExtensionEntry` is
  // also used as a pure lexical validator (e.g. in tests / over manifests whose
  // files may not exist). The real load path always existsSync()-checks and
  // imports the file, at which point this canonical check does run.
  if (!symlinkSafeWithinRoot(root, entryPath)) {
    return null;
  }
  return entryPath;
}

/**
 * Re-assert, after symlink resolution, that `entryPath` still resolves to a
 * location inside `root`. Returns true when neither path exists yet (nothing to
 * resolve — lexical check already passed) and false only when a real on-disk
 * symlink would carry the import target outside the canonical extension root.
 */
function symlinkSafeWithinRoot(root: string, entryPath: string): boolean {
  let canonicalEntry: string;
  try {
    canonicalEntry = fs.realpathSync(entryPath);
  } catch {
    // Entry file does not exist yet (or is otherwise unreadable). Nothing to
    // canonicalize; the loader's existsSync() guard will reject a missing file.
    return true;
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(root);
  } catch {
    // Root cannot be canonicalized but the entry could — treat as unsafe.
    return false;
  }
  const rel = path.relative(canonicalRoot, canonicalEntry);
  // Reject if the canonical entry escaped the canonical root via a symlink.
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return false;
  }
  return true;
}

// CODE_ROOT is the repository/plugin root used for finding extensions/.
// This module executes from packages/core/{src|dist}/orchestrator/, so the
// repository root is four levels above it.
export function resolveExtensionCodeRootFromModuleUrl(
  moduleUrl: string | URL,
): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return path.resolve(moduleDir, '..', '..', '..', '..');
}

export async function loadExtensions(): Promise<LoadResult[]> {
  const codeRoot = resolveExtensionCodeRootFromModuleUrl(import.meta.url);
  const extensionsDir = path.join(codeRoot, 'extensions');
  const results: LoadResult[] = [];

  if (!fs.existsSync(extensionsDir)) {
    logger.debug('No extensions directory found');
    return results;
  }

  const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  const extensionDirs = entries
    .filter(e => e.isDirectory() && e.name.startsWith('claudeclaw-'))
    .map(e => e.name)
    .sort();

  for (const dirName of extensionDirs) {
    const manifestPath = path.join(extensionsDir, dirName, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      results.push({ name: dirName, status: 'failed', error: 'No manifest.json found' });
      continue;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const { valid, error, manifest } = validateManifest(raw);

      if (!valid || !manifest) {
        results.push({ name: dirName, status: 'failed', error: `Invalid manifest: ${error}` });
        continue;
      }

      const extensionRoot = path.join(extensionsDir, dirName);
      const entryPath = resolveExtensionEntry(extensionRoot, manifest.entry);
      if (!entryPath) {
        results.push({ name: dirName, status: 'failed', error: `Unsafe or invalid entry path: ${manifest.entry}` });
        logger.error({ extension: dirName, entry: manifest.entry }, 'Rejected extension with unsafe entry path');
        continue;
      }
      if (!fs.existsSync(entryPath)) {
        results.push({ name: dirName, status: 'failed', error: `Entry file not found: ${manifest.entry}` });
        continue;
      }

      // Dynamic import — extension self-registers on load
      await import(pathToFileURL(entryPath).href);

      results.push({ name: manifest.name, status: 'loaded' });
      logger.info({ extension: manifest.name, type: manifest.type, version: manifest.version }, 'Extension loaded');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name: dirName, status: 'failed', error: message });
      logger.error({ extension: dirName, error: message }, 'Failed to load extension');
    }
  }

  const loaded = results.filter(r => r.status === 'loaded').length;
  const failed = results.filter(r => r.status === 'failed').length;
  if (loaded > 0 || failed > 0) {
    logger.info({ loaded, failed }, 'Extension loading complete');
  }

  return results;
}

/**
 * Collect allowedDomains from all installed extension manifests.
 * Returns deduplicated list of domains that extensions need for network access.
 */
export function getExtensionAllowedDomains(): string[] {
  const codeRoot = resolveExtensionCodeRootFromModuleUrl(import.meta.url);
  const extensionsDir = path.join(codeRoot, 'extensions');
  const domains: string[] = [];

  if (!fs.existsSync(extensionsDir)) return domains;

  const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('claudeclaw-')) continue;
    const manifestPath = path.join(extensionsDir, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const { valid, manifest } = validateManifest(raw);
      if (valid && manifest?.provides?.allowedDomains) {
        domains.push(...manifest.provides.allowedDomains);
      }
    } catch {
      // Skip invalid manifests
    }
  }

  return [...new Set(domains)];
}
