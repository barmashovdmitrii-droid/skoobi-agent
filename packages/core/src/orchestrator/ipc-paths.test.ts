import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureIpcDirectoryLayout,
  IPC_CATEGORY_DIRECTORY_NAMES,
  resolveExistingSafeIpcCategoryDirectory,
  writeFileAtomicNoFollowSync,
} from './ipc-paths.js';

const cleanup: string[] = [];

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('IPC directory layout', () => {
  it('provisions all fixed real category directories, including swe', () => {
    const parent = tempDir('ipc-layout-');
    const root = path.join(parent, 'guest');
    const layout = ensureIpcDirectoryLayout(root);

    expect(fs.lstatSync(layout.root).isDirectory()).toBe(true);
    expect(Object.keys(layout.categories)).toEqual(
      IPC_CATEGORY_DIRECTORY_NAMES,
    );
    for (const category of IPC_CATEGORY_DIRECTORY_NAMES) {
      expect(fs.lstatSync(layout.categories[category]).isDirectory()).toBe(
        true,
      );
      expect(fs.lstatSync(layout.categories[category]).isSymbolicLink()).toBe(
        false,
      );
    }
  });

  it('fails closed on a pre-existing symlinked category', () => {
    const parent = tempDir('ipc-layout-link-');
    const root = path.join(parent, 'guest');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'messages'));

    expect(() => ensureIpcDirectoryLayout(root)).toThrow(
      /unsafe ipc messages/i,
    );
    expect(
      resolveExistingSafeIpcCategoryDirectory(root, 'messages'),
    ).toBeNull();
    expect(fs.lstatSync(path.join(root, 'messages')).isSymbolicLink()).toBe(
      true,
    );
  });

  it('rejects a symlinked group IPC root', () => {
    const parent = tempDir('ipc-layout-root-link-');
    const outside = path.join(parent, 'outside');
    const rootLink = path.join(parent, 'guest');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, rootLink);

    expect(() => ensureIpcDirectoryLayout(rootLink)).toThrow(
      /unsafe ipc root/i,
    );
    expect(
      resolveExistingSafeIpcCategoryDirectory(rootLink, 'messages'),
    ).toBeNull();
  });
});

describe('writeFileAtomicNoFollowSync', () => {
  it('atomically replaces a hostile final symlink without touching its target', () => {
    const root = tempDir('ipc-atomic-link-');
    const outside = path.join(root, 'outside-secret.txt');
    const destination = path.join(root, '_close');
    fs.writeFileSync(outside, 'DO_NOT_TRUNCATE');
    fs.symlinkSync(outside, destination);

    writeFileAtomicNoFollowSync(destination, 'sentinel');

    expect(fs.readFileSync(outside, 'utf8')).toBe('DO_NOT_TRUNCATE');
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(destination, 'utf8')).toBe('sentinel');
    expect(
      fs.readdirSync(root).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('replaces a hostile final hardlink without changing the other link', () => {
    const root = tempDir('ipc-atomic-hardlink-');
    const outside = path.join(root, 'outside.txt');
    const destination = path.join(root, 'current_tasks.json');
    fs.writeFileSync(outside, 'ORIGINAL');
    fs.linkSync(outside, destination);

    writeFileAtomicNoFollowSync(destination, 'NEW SNAPSHOT');

    expect(fs.readFileSync(outside, 'utf8')).toBe('ORIGINAL');
    expect(fs.readFileSync(destination, 'utf8')).toBe('NEW SNAPSHOT');
    expect(fs.statSync(outside).nlink).toBe(1);
    expect(fs.statSync(destination).nlink).toBe(1);
  });
});
