import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveExtensionEntry } from './extension-loader.js';

const ROOT = path.resolve('/srv/claudeclaw/extensions/claudeclaw-demo');

describe('resolveExtensionEntry containment', () => {
  it('accepts a plain JS entry inside the extension root', () => {
    expect(resolveExtensionEntry(ROOT, 'index.js')).toBe(
      path.join(ROOT, 'index.js'),
    );
  });

  it('accepts a nested JS/MJS entry inside the extension root', () => {
    expect(resolveExtensionEntry(ROOT, 'dist/main.js')).toBe(
      path.join(ROOT, 'dist', 'main.js'),
    );
    expect(resolveExtensionEntry(ROOT, 'build/entry.mjs')).toBe(
      path.join(ROOT, 'build', 'entry.mjs'),
    );
  });

  it('normalizes redundant ./ segments while staying contained', () => {
    expect(resolveExtensionEntry(ROOT, './sub/../index.js')).toBe(
      path.join(ROOT, 'index.js'),
    );
  });

  it('rejects parent-directory traversal entries (the core finding)', () => {
    expect(resolveExtensionEntry(ROOT, '../../evil')).toBeNull();
    expect(resolveExtensionEntry(ROOT, '../../evil.js')).toBeNull();
    expect(resolveExtensionEntry(ROOT, '../sibling/index.js')).toBeNull();
    expect(resolveExtensionEntry(ROOT, 'sub/../../../etc/passwd.js')).toBeNull();
  });

  it('rejects absolute entry paths', () => {
    expect(resolveExtensionEntry(ROOT, '/etc/passwd')).toBeNull();
    expect(resolveExtensionEntry(ROOT, '/tmp/evil.js')).toBeNull();
  });

  it('rejects non-module file extensions even when contained', () => {
    expect(resolveExtensionEntry(ROOT, 'index.ts')).toBeNull();
    expect(resolveExtensionEntry(ROOT, 'payload.json')).toBeNull();
    expect(resolveExtensionEntry(ROOT, 'script.sh')).toBeNull();
    expect(resolveExtensionEntry(ROOT, 'noext')).toBeNull();
  });

  it('rejects the bare extension root and empty / null-byte entries', () => {
    expect(resolveExtensionEntry(ROOT, '')).toBeNull();
    expect(resolveExtensionEntry(ROOT, '.')).toBeNull();
    expect(resolveExtensionEntry(ROOT, 'index\0.js')).toBeNull();
  });

  it('does not require the entry to exist (lexical validation for missing paths)', () => {
    // ROOT does not exist on disk, so the realpath/symlink check is skipped and
    // a lexically-contained entry is still accepted (Phase-A behavior preserved).
    expect(resolveExtensionEntry(ROOT, 'index.js')).toBe(path.join(ROOT, 'index.js'));
  });

  it('guarantees any accepted entry stays within the extension root', () => {
    const candidates = [
      'index.js',
      'dist/main.mjs',
      './a/b/c.js',
      '../../evil.js',
      '/abs/evil.js',
      'evil.json',
    ];
    for (const entry of candidates) {
      const resolved = resolveExtensionEntry(ROOT, entry);
      if (resolved === null) continue;
      const rel = path.relative(ROOT, resolved);
      expect(rel.startsWith('..')).toBe(false);
      expect(path.isAbsolute(rel)).toBe(false);
      expect(['.js', '.mjs']).toContain(path.extname(resolved).toLowerCase());
    }
  });
});

// Finding #50: symlink-escape protection. These exercise real on-disk symlinks,
// so the realpath canonicalization in resolveExtensionEntry actually runs.
describe('resolveExtensionEntry symlink escape (finding #50)', () => {
  let tmp: string;
  let realRoot: string; // canonical extension root
  let outsideTarget: string; // a malicious .js outside the root

  beforeAll(() => {
    // realpathSync the tmp base so macOS /var -> /private/var is canonicalized
    // and comparisons are against the real path, matching production behavior.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-loader-')));
    realRoot = path.join(tmp, 'extensions', 'claudeclaw-demo');
    fs.mkdirSync(realRoot, { recursive: true });

    // A legitimate entry that lives inside the root.
    fs.writeFileSync(path.join(realRoot, 'index.js'), '// ok\n');

    // The attacker's payload, planted outside the extension root.
    outsideTarget = path.join(tmp, 'evil.js');
    fs.writeFileSync(outsideTarget, '// pwned\n');
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts a real, non-symlinked entry inside the root', () => {
    expect(resolveExtensionEntry(realRoot, 'index.js')).toBe(
      path.join(realRoot, 'index.js'),
    );
  });

  it('rejects an entry file that is a symlink pointing outside the root', () => {
    // mod.js -> ../evil.js (lexical check passes; realpath escapes the root)
    const link = path.join(realRoot, 'mod.js');
    fs.symlinkSync(outsideTarget, link);
    expect(resolveExtensionEntry(realRoot, 'mod.js')).toBeNull();
    fs.rmSync(link);
  });

  it('rejects an entry reached through a symlinked subdirectory escaping the root', () => {
    // realRoot/linkdir -> tmp (outside); linkdir/evil.js is lexically contained
    // but its real target is outside the canonical root.
    const linkDir = path.join(realRoot, 'linkdir');
    fs.symlinkSync(tmp, linkDir);
    expect(resolveExtensionEntry(realRoot, 'linkdir/evil.js')).toBeNull();
    fs.rmSync(linkDir);
  });

  it('accepts an entry reached through a symlink that stays inside the root', () => {
    // realRoot/innerlink -> realRoot/real-sub (both inside the root). The
    // canonical target is still contained, so it must be accepted.
    const realSub = path.join(realRoot, 'real-sub');
    fs.mkdirSync(realSub, { recursive: true });
    fs.writeFileSync(path.join(realSub, 'entry.js'), '// ok\n');
    const innerLink = path.join(realRoot, 'innerlink');
    fs.symlinkSync(realSub, innerLink);
    // Accepted: resolves to the lexical (pre-realpath) path inside the root.
    expect(resolveExtensionEntry(realRoot, 'innerlink/entry.js')).toBe(
      path.join(realRoot, 'innerlink', 'entry.js'),
    );
    fs.rmSync(innerLink);
    fs.rmSync(realSub, { recursive: true, force: true });
  });
});
