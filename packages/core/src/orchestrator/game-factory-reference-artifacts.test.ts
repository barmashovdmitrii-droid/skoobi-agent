import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureFactoryManifestAsync,
  captureFactoryReferenceFileAsync,
} from './game-factory-artifacts.js';

let root: string;
let source: string;

function put(name: string, value: string | Buffer) {
  const file = path.join(source, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
}

function capture(entrypoint: string) {
  return captureFactoryReferenceFileAsync({
    sourceRoot: source,
    entrypoint,
    allowedRoots: [source],
  });
}

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-reference-')),
  );
  source = path.join(root, 'project');
  fs.mkdirSync(source, { mode: 0o700 });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('bounded local reference file capture', () => {
  it('hashes the selected UTF-8 bytes without returning text, reading siblings, or widening builds', async () => {
    const text = '# Справочный промпт\nСодержимое является данными.\n';
    put('notes/prompt.md', text);
    // A recursive capture would encounter the oversized sibling or symlink.
    put('notes/too-big.txt', Buffer.alloc(1024 * 1024 + 1, 'x'));
    fs.symlinkSync(
      path.join(source, 'notes/prompt.md'),
      path.join(source, 'notes/link.md'),
    );
    const result = await capture('notes/prompt.md');
    expect(result).toEqual({
      path: 'notes/prompt.md',
      sha256: createHash('sha256').update(text).digest('hex'),
      size: Buffer.byteLength(text),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Справочный');
    fs.unlinkSync(path.join(source, 'notes/link.md'));
    put('index.html', '<canvas></canvas>');
    put('notes/example.gd', 'extends Node\n');
    const build = await captureFactoryManifestAsync({
      sourceRoot: source,
      entrypoint: 'index.html',
      allowedRoots: [source],
    });
    expect(build.files.map((file) => file.path)).toEqual(['index.html']);
  });

  it.each(['md', 'txt', 'gd', 'cs', 'cpp', 'h', 'json', 'js', 'ts'])(
    'records .%s samples as inert text',
    async (extension) => {
      const text = 'Untrusted sample; do not run it.';
      put(`sample.${extension}`, text);
      expect(await capture(`sample.${extension}`)).toMatchObject({
        path: `sample.${extension}`,
        size: Buffer.byteLength(text),
      });
      expect(fs.readdirSync(source)).toEqual([`sample.${extension}`]);
    },
  );

  it('enforces the fixed 1 MiB text limit and rejects binary or unsupported files', async () => {
    put('limit.md', Buffer.alloc(1024 * 1024, 'a'));
    expect((await capture('limit.md')).size).toBe(1024 * 1024);
    put('limit.md', Buffer.alloc(1024 * 1024 + 1, 'a'));
    await expect(capture('limit.md')).rejects.toThrow(/byte limit/);
    put('invalid.md', Buffer.from([0xff, 0xfe]));
    await expect(capture('invalid.md')).rejects.toThrow(/UTF-8/);
    put('binary.txt', Buffer.from([0x61, 0]));
    await expect(capture('binary.txt')).rejects.toThrow(/NUL/);
    put('archive.zip', 'text in an archive-named file');
    await expect(capture('archive.zip')).rejects.toThrow(/Unsupported/);
  });

  it.each([
    '../outside.md',
    '/absolute.md',
    'nested/../sample.md',
    './sample.md',
    'nested\\sample.md',
    '.env',
    'secrets.json',
    'credentials.txt',
    'package-lock.json',
    'notes.private.md',
    'memory/sample.md',
    'node_modules/sample.md',
    '.hidden/sample.md',
  ])('rejects unsafe or private selection %s', async (name) => {
    await expect(capture(name)).rejects.toThrow();
  });

  it('rejects outside roots, links, directories, and FIFOs without opening their contents', async () => {
    const original = put('sample.md', 'known sample');
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'sample.md'), 'outside project');
    await expect(
      captureFactoryReferenceFileAsync({
        sourceRoot: other,
        entrypoint: 'sample.md',
        allowedRoots: [source],
      }),
    ).rejects.toThrow(/outside/);
    fs.symlinkSync(original, path.join(source, 'alias.md'));
    await expect(capture('alias.md')).rejects.toThrow(/single-link/);
    fs.symlinkSync(other, path.join(source, 'nested'));
    await expect(capture('nested/sample.md')).rejects.toThrow();
    await expect(
      captureFactoryReferenceFileAsync({
        sourceRoot: path.join(source, 'nested'),
        entrypoint: 'sample.md',
        allowedRoots: [source],
      }),
    ).rejects.toThrow();
    fs.linkSync(original, path.join(source, 'hardlink.md'));
    await expect(capture('hardlink.md')).rejects.toThrow(/single-link/);
    fs.mkdirSync(path.join(source, 'directory.md'));
    await expect(capture('directory.md')).rejects.toThrow(/single-link/);
    const fifo = path.join(source, 'pipe.md');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    await expect(capture('pipe.md')).rejects.toThrow(/single-link/);
  });

  it('reports the exact new hash after a subsequent file edit', async () => {
    put('sample.md', 'first revision');
    const first = await capture('sample.md');
    put('sample.md', 'second revision');
    const second = await capture('sample.md');
    expect(second.sha256).toBe(
      createHash('sha256').update('second revision').digest('hex'),
    );
    expect(second.sha256).not.toBe(first.sha256);
  });

  it('rejects a file being changed during capture and joins the fixture writer', async () => {
    const file = put('changing.md', Buffer.alloc(1024 * 1024, 'x'));
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const fs = require('node:fs');
      const fd = fs.openSync(process.argv[1], 'r+');
      const bytes = Buffer.alloc(4096, 'y');
      process.send('ready');
      function change() {
        for (let i = 0; i < 256; i++) fs.writeSync(fd, bytes, 0, bytes.length, 0);
        setImmediate(change);
      }
      change();
    `,
        file,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
        child.once('exit', (code) =>
          reject(new Error(`Writer exited: ${code}`)),
        );
      });
      let rejectedChanges = 0;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          await capture('changing.md');
        } catch (error) {
          expect(String(error)).toMatch(/changed/);
          rejectedChanges++;
        }
      }
      expect(rejectedChanges).toBeGreaterThan(0);
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
    }
  });
});
