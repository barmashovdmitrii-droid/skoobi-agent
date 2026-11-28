import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  captureFactoryManifest,
  captureFactoryManifestAsync,
  ensureFactoryPrivateDirectory,
  ensureFactoryPrivateDirectoryAsync,
  importFactorySource,
  importFactorySourceAsync,
  bundleFactorySource,
  archiveFactoryBuild,
  importFactoryFileAsync,
} from './game-factory-artifacts.js';

let root: string;
let source: string;
let privateParent: string;
let destination: string;

function put(relative: string, value: string | Buffer): void {
  const file = path.join(source, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function capture(
  limits?: Parameters<typeof captureFactoryManifest>[0]['limits'],
) {
  return captureFactoryManifest({
    sourceRoot: source,
    entrypoint: 'index.html',
    allowedRoots: [root],
    limits,
  });
}

function copy() {
  return importFactorySource({
    sourceRoot: source,
    entrypoint: 'index.html',
    allowedRoots: [root],
    destinationRoot: destination,
  });
}

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-artifacts-')),
  );
  source = path.join(root, 'source');
  privateParent = path.join(root, 'private');
  destination = path.join(privateParent, 'workspace');
  fs.mkdirSync(source);
  fs.mkdirSync(privateParent, { mode: 0o700 });
  put('index.html', '<script src="game.js"></script>');
  put('game.js', 'window.game = { level: 1 };');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('factory host artifact capture and import', () => {
  it('imports only the selected image without exposing sibling assets or following links', async () => {
    const selected = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/p8AAAAASUVORK5CYII=',
      'base64',
    );
    put('selected.png', selected);
    put('private.png', Buffer.from('other private image'));
    const input = {
      sourceFile: path.join(source, 'selected.png'),
      allowedRoot: root,
      destinationRoot: destination,
    };
    const result = await importFactoryFileAsync(input);
    expect(fs.readdirSync(destination)).toEqual(['selected.png']);
    expect(result.file).toMatchObject({
      path: 'selected.png',
      bytes: selected.length,
    });
    expect(await importFactoryFileAsync(input)).toEqual(result);
    fs.unlinkSync(input.sourceFile);
    fs.symlinkSync(path.join(source, 'private.png'), input.sourceFile);
    await expect(importFactoryFileAsync(input)).rejects.toThrow(/symlinks/);
    expect(fs.readFileSync(path.join(destination, 'selected.png'))).toEqual(
      selected,
    );
    await expect(
      importFactoryFileAsync({
        ...input,
        sourceFile: path.join(source, 'private.png'),
        destinationRoot: `${destination}-bad`,
      }),
    ).rejects.toThrow(/image header/);
  });

  it('writes the exact deterministic release ZIP, retries safely, and refuses replacement or links', async () => {
    const manifest = capture();
    const input = {
      sourceRoot: source,
      entrypoint: 'index.html',
      allowedRoots: [root],
      expectedManifestSha256: manifest.manifestSha256,
      destinationFile: path.join(privateParent, 'game.zip'),
    };
    const result = await archiveFactoryBuild(input);
    const bundle = await bundleFactorySource(input);
    expect(result.sha256).toBe(bundle.sha256);
    expect(fs.readFileSync(result.path)).toEqual(
      Buffer.from(bundle.data, 'base64'),
    );
    expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
    expect(await archiveFactoryBuild(input)).toEqual(result);
    fs.writeFileSync(result.path, 'different');
    await expect(archiveFactoryBuild(input)).rejects.toThrow(/differs/);
    expect(fs.readFileSync(result.path, 'utf8')).toBe('different');
    fs.unlinkSync(result.path);
    fs.symlinkSync(path.join(source, 'index.html'), result.path);
    await expect(archiveFactoryBuild(input)).rejects.toThrow(/unsafe/);
    fs.unlinkSync(result.path);
    fs.linkSync(path.join(source, 'index.html'), result.path);
    await expect(archiveFactoryBuild(input)).rejects.toThrow(
      /source file|unsafe/i,
    );
  });

  it('does not leave an archive after stale or oversize packaging and rejects a nonprivate parent', async () => {
    const input = {
      sourceRoot: source,
      entrypoint: 'index.html',
      allowedRoots: [root],
      expectedManifestSha256: capture().manifestSha256,
      destinationFile: path.join(privateParent, 'game.zip'),
    };
    await expect(
      archiveFactoryBuild({ ...input, maxBytes: 10 }),
    ).rejects.toThrow(/byte limit/);
    await expect(
      archiveFactoryBuild({ ...input, expectedManifestSha256: '0'.repeat(64) }),
    ).rejects.toThrow(/manifest changed/);
    expect(fs.readdirSync(privateParent)).toEqual([]);
    fs.chmodSync(privateParent, 0o755);
    await expect(archiveFactoryBuild(input)).rejects.toThrow(/private/);
    expect(fs.readdirSync(privateParent)).toEqual([]);
  });

  it('bundles deterministic portable exact bytes for peer delivery and rejects stale/oversize inputs', async () => {
    put('assets/pixel.png', Buffer.from([5, 4, 3, 2, 1]));
    put('.env', 'must not be copied');
    const input = {
      sourceRoot: source,
      entrypoint: 'index.html',
      allowedRoots: [root],
    };
    const captured = await captureFactoryManifestAsync(input);
    const bundleInput = {
      ...input,
      expectedManifestSha256: captured.manifestSha256,
    };
    const first = await bundleFactorySource(bundleInput);
    expect(await bundleFactorySource(bundleInput)).toEqual(first);
    const bytes = Buffer.from(first.data, 'base64');
    expect(first.name).toBe('source.zip');
    expect(first.bytes).toBe(bytes.length);
    expect(first.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const inspected = spawnSync(
      process.platform === 'darwin' ? '/usr/bin/python3' : 'python3',
      [
        '-I',
        '-c',
        [
          'import sys, io, zipfile, json, hashlib',
          'z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))',
          'print(json.dumps([{ "path":i.filename,"sha256":hashlib.sha256(z.read(i)).hexdigest(),"size":i.file_size,"date":i.date_time} for i in z.infolist()]))',
        ].join('\n'),
      ],
      { input: bytes },
    );
    expect(inspected.status).toBe(0);
    const members = JSON.parse(inspected.stdout.toString()) as Array<{
      path: string;
      sha256: string;
      size: number;
      date: number[];
    }>;
    expect(
      members
        .map(({ date: _date, ...file }) => file)
        .sort((a, b) => a.path.localeCompare(b.path)),
    ).toEqual([...captured.files].sort((a, b) => a.path.localeCompare(b.path)));
    expect(
      members.every((member) => member.date.join(',') === '1980,1,1,0,0,0'),
    ).toBe(true);
    await expect(
      bundleFactorySource({ ...bundleInput, maxBytes: 30 }),
    ).rejects.toThrow(/byte limit/);
    put('game.js', 'changed');
    await expect(bundleFactorySource(bundleInput)).rejects.toThrow(
      /manifest changed/,
    );
  });

  it('awaits production filesystem operations without blocking the Node event loop', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      const parent = await ensureFactoryPrivateDirectoryAsync({
        root: privateParent,
        relativePath: 'project',
      });
      const input = {
        sourceRoot: source,
        entrypoint: 'index.html',
        allowedRoots: [root],
      };
      const captured = await captureFactoryManifestAsync(input);
      const imported = await importFactorySourceAsync({
        ...input,
        destinationRoot: path.join(parent, 'copy'),
      });
      expect(imported.manifestSha256).toBe(captured.manifestSha256);
      expect(Object.isFrozen(imported.files)).toBe(true);
      expect(ticks).toBeGreaterThan(1);
      await expect(
        importFactorySourceAsync({
          ...input,
          destinationRoot: path.join(parent, 'copy'),
        }),
      ).resolves.toEqual(imported);
      await expect(
        captureFactoryManifestAsync({
          ...input,
          allowedRoots: [privateParent],
        }),
      ).rejects.toThrow(/outside/);
    } finally {
      clearInterval(timer);
    }
  });

  it('bounds asynchronous helper lifetime and leaves no partially published destination', async () => {
    await expect(
      importFactorySourceAsync(
        {
          sourceRoot: source,
          entrypoint: 'index.html',
          allowedRoots: [root],
          destinationRoot: destination,
        },
        { timeoutMs: 1 },
      ),
    ).rejects.toThrow(/deadline/);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(privateParent)).toEqual([]);
    await expect(
      captureFactoryManifestAsync(
        { sourceRoot: source, entrypoint: 'index.html', allowedRoots: [root] },
        { timeoutMs: 60_001 },
      ),
    ).rejects.toThrow(/deadline/);
  });

  it('creates private descendants idempotently without following directory symlinks', () => {
    const input = {
      root: privateParent,
      relativePath: 'projects/example/import',
    };
    const created = ensureFactoryPrivateDirectory(input);
    expect(created).toBe(path.join(privateParent, input.relativePath));
    expect(fs.statSync(created).mode & 0o777).toBe(0o700);
    expect(ensureFactoryPrivateDirectory(input)).toBe(created);
    fs.symlinkSync(source, path.join(privateParent, 'escape'));
    expect(() =>
      ensureFactoryPrivateDirectory({
        root: privateParent,
        relativePath: 'escape/new',
      }),
    ).toThrow();
    expect(fs.existsSync(path.join(source, 'new'))).toBe(false);
    for (const relativePath of [
      '../outside',
      '/outside',
      'projects/../outside',
      '.',
      'a\\b',
    ]) {
      expect(() =>
        ensureFactoryPrivateDirectory({ root: privateParent, relativePath }),
      ).toThrow();
    }
    fs.mkdirSync(path.join(privateParent, 'public'), { mode: 0o755 });
    fs.chmodSync(path.join(privateParent, 'public'), 0o755);
    expect(() =>
      ensureFactoryPrivateDirectory({
        root: privateParent,
        relativePath: 'public/child',
      }),
    ).toThrow(/not private/);
    expect(fs.existsSync(path.join(privateParent, 'public/child'))).toBe(false);
  });

  it('captures exact bytes, stable sorted paths and an entrypoint-sensitive fingerprint', () => {
    put('assets/дракон.png', Buffer.from([0, 1, 2, 255]));
    put('levels/one.json', '{"level":1}');
    const first = capture();
    expect(first.files.map((file) => file.path)).toEqual([
      'assets/дракон.png',
      'game.js',
      'index.html',
      'levels/one.json',
    ]);
    const bytes = fs.readFileSync(path.join(source, 'assets/дракон.png'));
    expect(first.files[0]).toEqual({
      path: 'assets/дракон.png',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(first.totalBytes).toBe(
      first.files.reduce((sum, item) => sum + item.size, 0),
    );
    expect(capture().manifestSha256).toBe(first.manifestSha256);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.files)).toBe(true);
    expect(Object.isFrozen(first.files[0])).toBe(true);
    expect(
      captureFactoryManifest({
        sourceRoot: source,
        entrypoint: 'game.js',
        allowedRoots: [root],
      }).manifestSha256,
    ).not.toBe(first.manifestSha256);
    put('game.js', 'window.game = { level: 2 };');
    expect(capture().manifestSha256).not.toBe(first.manifestSha256);
  });

  it('copies static assets and code without executing scripts or modifying original bytes', () => {
    put('package.json', '{"scripts":{"postinstall":"touch SHOULD_NOT_EXIST"}}');
    put('assets/audio/theme.ogg', Buffer.from([12, 20, 54]));
    put('assets/model.glb', Buffer.from([1, 5, 1]));
    put('LICENSE.txt', 'Asset attribution');
    put('fonts/OFL-pixel-font.txt', 'Font license must travel with the font');
    const before = capture();
    const imported = copy();
    expect(imported.sourceRoot).toBe(destination);
    expect(imported.manifestSha256).toBe(before.manifestSha256);
    expect(capture().manifestSha256).toBe(before.manifestSha256);
    for (const file of imported.files) {
      expect(fs.readFileSync(path.join(destination, file.path))).toEqual(
        fs.readFileSync(path.join(source, file.path)),
      );
      expect(fs.statSync(path.join(destination, file.path)).mode & 0o777).toBe(
        0o600,
      );
    }
    expect(fs.statSync(destination).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(source, 'SHOULD_NOT_EXIST'))).toBe(false);
  });

  it('omits private/runtime/history/dependency/archive files by an explicit source allowlist', () => {
    for (const name of [
      '.env',
      '.git/config',
      '.hidden/token.json',
      'logs/run.json',
      'state/status.json',
      'node_modules/library/index.js',
      'memory/private.json',
      'conversations/chat.json',
      'auth.json',
      'credentials.json',
      'tokens.json',
      'archive.zip',
      'saved.sqlite',
      'backup.tar.gz',
      'secret.private.json',
      'notes.txt',
    ])
      put(name, 'private fixture');
    expect(copy().files.map((file) => file.path)).toEqual([
      'game.js',
      'index.html',
    ]);
    expect(fs.readdirSync(destination).sort()).toEqual([
      'game.js',
      'index.html',
    ]);
  });

  it('requires an explicit existing regular entrypoint inside the selected source subtree', () => {
    for (const entrypoint of [
      '/index.html',
      '../index.html',
      'assets/../index.html',
      './index.html',
      'a\\b.html',
      '',
      'missing.html',
    ]) {
      expect(() =>
        captureFactoryManifest({
          sourceRoot: source,
          entrypoint,
          allowedRoots: [root],
        }),
      ).toThrow();
    }
    put('.private/index.html', 'not a public entry');
    expect(() =>
      captureFactoryManifest({
        sourceRoot: source,
        entrypoint: '.private/index.html',
        allowedRoots: [root],
      }),
    ).toThrow(/absent or excluded/);
  });

  it('rejects sources outside the allowed root, including prefix siblings and private subtrees', () => {
    expect(() =>
      captureFactoryManifest({
        sourceRoot: source,
        entrypoint: 'index.html',
        allowedRoots: [privateParent],
      }),
    ).toThrow(/outside/);
    expect(() =>
      captureFactoryManifest({
        sourceRoot: source,
        entrypoint: 'index.html',
        allowedRoots: [root + '-sibling'],
      }),
    ).toThrow(/outside/);
    expect(() =>
      captureFactoryManifest({
        sourceRoot: source,
        entrypoint: 'index.html',
        allowedRoots: ['/'],
      }),
    ).toThrow(/Filesystem root/);
    put('store/index.html', 'private source');
    expect(() =>
      captureFactoryManifest({
        sourceRoot: path.join(source, 'store'),
        entrypoint: 'index.html',
        allowedRoots: [root],
      }),
    ).toThrow(/Private or runtime/);
  });

  it('rejects file and directory symlinks even if their targets are inside the allowlist', () => {
    fs.symlinkSync(path.join(source, 'game.js'), path.join(source, 'alias.js'));
    expect(() => capture()).toThrow(/symlinks/);
    fs.unlinkSync(path.join(source, 'alias.js'));
    fs.mkdirSync(path.join(root, 'other'));
    fs.symlinkSync(path.join(root, 'other'), path.join(source, 'assets'));
    expect(() => capture()).toThrow(/symlinks/);
    fs.unlinkSync(path.join(source, 'assets'));
    fs.symlinkSync(source, path.join(root, 'alias'));
    expect(() =>
      captureFactoryManifest({
        sourceRoot: path.join(root, 'alias'),
        entrypoint: 'index.html',
        allowedRoots: [root],
      }),
    ).toThrow();
    expect(() =>
      captureFactoryManifest({
        sourceRoot: path.join(root, 'alias'),
        entrypoint: 'index.html',
        allowedRoots: [path.join(root, 'alias')],
      }),
    ).toThrow(/canonical/);
  });

  it('rejects hard links and special files without blocking', () => {
    fs.linkSync(path.join(source, 'game.js'), path.join(source, 'alias.js'));
    expect(() => capture()).toThrow(/Unsafe or changed source file/);
    fs.unlinkSync(path.join(source, 'alias.js'));
    const fifo = path.join(source, 'blocked.js');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    expect(() => capture()).toThrow(/Special source/);
  });

  it('enforces per-file, aggregate, file-count, traversal and hard resource caps', () => {
    expect(() => capture({ maxFileBytes: 1 })).toThrow(/File exceeds/);
    expect(() => capture({ maxTotalBytes: 1 })).toThrow(/total byte/);
    expect(() => capture({ maxFiles: 1 })).toThrow(/file limit/);
    expect(() => capture({ maxEntries: 1 })).toThrow(/entry limit/);
    put('a/b/c.js', 'x');
    expect(() => capture({ maxDepth: 1 })).toThrow(/depth limit/);
    expect(() => capture({ maxTotalBytes: Number.MAX_SAFE_INTEGER })).toThrow(
      /Invalid factory/,
    );
    expect(() => capture({ maxFiles: 0 })).toThrow(/Invalid factory/);
  });

  it('retries idempotently after a missing registry write and refuses all overwrites', () => {
    const first = copy();
    const inode = fs.statSync(destination).ino;
    expect(copy()).toEqual(first);
    expect(fs.statSync(destination).ino).toBe(inode);
    put('game.js', 'new version');
    expect(() => copy()).toThrow(/already exists with different content/);
    expect(fs.readFileSync(path.join(destination, 'game.js'), 'utf8')).toBe(
      'window.game = { level: 1 };',
    );
  });

  it('does not accept extra excluded files in an existing destination', () => {
    copy();
    fs.writeFileSync(path.join(destination, '.env'), 'fixture');
    expect(() => copy()).toThrow(/Destination contains excluded/);
  });

  it('requires a private parent and rejects overlap and destination symlinks', () => {
    fs.chmodSync(privateParent, 0o755);
    expect(() => copy()).toThrow(/Destination parent must be private/);
    fs.chmodSync(privateParent, 0o700);
    expect(() =>
      importFactorySource({
        sourceRoot: source,
        entrypoint: 'index.html',
        allowedRoots: [root],
        destinationRoot: path.join(source, 'copy'),
      }),
    ).toThrow(/overlap/);
    fs.symlinkSync(source, destination);
    expect(() => copy()).toThrow();
    expect(capture().files).toHaveLength(2);
    fs.symlinkSync(privateParent, path.join(root, 'parent-alias'));
    expect(() =>
      importFactorySource({
        sourceRoot: source,
        entrypoint: 'index.html',
        allowedRoots: [root],
        destinationRoot: path.join(root, 'parent-alias', 'child'),
      }),
    ).toThrow(/canonical/);
  });

  it('fails closed when a different process changes a file during capture', async () => {
    put('volatile.bin', Buffer.alloc(24 * 1024 * 1024));
    const child = spawn(
      process.platform === 'darwin' ? '/usr/bin/python3' : 'python3',
      [
        '-I',
        '-u',
        '-c',
        [
          'import os, sys, time',
          'f = os.open(sys.argv[1], os.O_WRONLY)',
          'print("ready", flush=True)',
          'for i in range(30000):',
          ' os.pwrite(f, bytes([i % 256]) * 4096, 1024 * 1024)',
          ' time.sleep(0.001)',
        ].join('\n'),
        path.join(source, 'volatile.bin'),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('error', reject);
        child.once('exit', (code) =>
          reject(new Error(`Fixture exited before capture: ${code}`)),
        );
      });
      expect(() => copy()).toThrow(/changed/);
      expect(fs.readdirSync(privateParent)).toEqual([]);
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
    }
  });

  it('cleans staging after a failed import and leaves no partial destination', () => {
    fs.symlinkSync('/dev/null', path.join(source, 'bad.js'));
    expect(() => copy()).toThrow();
    expect(fs.readdirSync(privateParent)).toEqual([]);
  });
});
