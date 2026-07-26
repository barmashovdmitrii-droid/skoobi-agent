import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  tombstoneMarkdownTreeNoFollowSync,
  writeDirectChildFileNoFollowSync,
} from './safe-child-write.js';

const HELPER = fileURLToPath(
  new URL('../../../scripts/safe-write-direct-child.py', import.meta.url),
);
const PYTHON = process.platform === 'darwin' ? '/usr/bin/python3' : 'python3';
const roots: string[] = [];

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('safe direct-child writer', () => {
  it('writes a normal single-link file for legitimate callers', () => {
    const parent = temp('safe-child-positive-');
    const written = writeDirectChildFileNoFollowSync({
      parentDirectory: parent,
      childDirectoryName: 'curated',
      fileName: 'MEMORY.md',
      data: 'safe data',
      maxBytes: 1024,
    });

    expect(fs.readFileSync(written, 'utf8')).toBe('safe data');
    expect(fs.lstatSync(written).isFile()).toBe(true);
    expect(fs.statSync(written).nlink).toBe(1);
  });

  it('cannot be redirected by an exact child-directory swap after open', () => {
    const parent = temp('safe-child-race-parent-');
    const outside = temp('safe-child-race-outside-');
    fs.mkdirSync(path.join(parent, 'curated'));

    const harness = [
      'import importlib.util, json, os, sys',
      'helper, parent, outside = sys.argv[1:4]',
      'spec = importlib.util.spec_from_file_location("safe_child_write", helper)',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'def swap():',
      '    os.rename(os.path.join(parent, "curated"), os.path.join(parent, "curated-before-swap"))',
      '    os.symlink(outside, os.path.join(parent, "curated"))',
      'result = module.safe_write_direct_child(parent, "curated", "MEMORY.md", b"SAFE", 1024, swap)',
      'print(json.dumps(result))',
    ].join('\n');
    const result = JSON.parse(
      execFileSync(
        PYTHON,
        [
          '-c',
          harness,
          HELPER,
          fs.realpathSync(parent),
          fs.realpathSync(outside),
        ],
        { encoding: 'utf8' },
      ),
    ) as { status: string; reason?: string };

    expect(result).toEqual({ status: 'unsafe', reason: 'child-changed' });
    expect(fs.existsSync(path.join(outside, 'MEMORY.md'))).toBe(false);
    expect(
      fs.existsSync(path.join(parent, 'curated-before-swap', 'MEMORY.md')),
    ).toBe(false);
  });

  it('never follows a nested memory-directory swap while renaming Markdown', () => {
    const memory = temp('safe-tombstone-race-memory-');
    const outside = temp('safe-tombstone-race-outside-');
    fs.mkdirSync(path.join(memory, 'topics'));
    fs.writeFileSync(path.join(memory, 'topics', 'note.md'), 'tenant memory');
    fs.writeFileSync(path.join(outside, 'note.md'), 'HOST_SENTINEL');

    const harness = [
      'import importlib.util, json, os, sys',
      'helper, memory, outside = sys.argv[1:4]',
      'spec = importlib.util.spec_from_file_location("safe_child_write", helper)',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'def swap():',
      '    os.rename(os.path.join(memory, "topics"), os.path.join(memory, "topics-before-swap"))',
      '    os.symlink(outside, os.path.join(memory, "topics"))',
      'result = module.safe_tombstone_markdown(memory, "memory-delete-now.json", "now", b"{}", 65536, 100, swap)',
      'print(json.dumps(result))',
    ].join('\n');
    const result = JSON.parse(
      execFileSync(
        PYTHON,
        [
          '-c',
          harness,
          HELPER,
          fs.realpathSync(memory),
          fs.realpathSync(outside),
        ],
        { encoding: 'utf8' },
      ),
    ) as { status: string; reason?: string };

    expect(result.status).toBe('unsafe');
    expect(result.reason).toBe('unsafe-memory-directory');
    expect(fs.readFileSync(path.join(outside, 'note.md'), 'utf8')).toBe(
      'HOST_SENTINEL',
    );
    expect(
      fs.readFileSync(
        path.join(memory, 'topics-before-swap', 'note.md'),
        'utf8',
      ),
    ).toBe('tenant memory');
  });

  it('fails the whole Markdown deletion before renaming a hardlinked source', () => {
    const memory = temp('safe-tombstone-hardlink-');
    fs.mkdirSync(path.join(memory, 'topics'));
    const first = path.join(memory, 'topics', 'first.md');
    const alias = path.join(memory, 'topics', 'alias.md');
    fs.writeFileSync(first, 'tenant memory');
    fs.linkSync(first, alias);

    const run = spawnSync(
      PYTHON,
      [
        HELPER,
        '--operation',
        'tombstone-markdown',
        '--parent',
        fs.realpathSync(memory),
        '--file',
        'memory-delete-now.json',
        '--rename-stamp',
        'now',
        '--max-bytes',
        '65536',
        '--max-entries',
        '100',
      ],
      { input: '{}', encoding: 'utf8' },
    );
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout)).toEqual({
      status: 'unsafe',
      reason: 'memory-hardlink',
    });
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(alias)).toBe(true);
    expect(
      fs.existsSync(path.join(memory, 'tombstones', 'memory-delete-now.json')),
    ).toBe(false);
  });

  it('returns a bounded deleted-file result larger than the old 256 KiB buffer', () => {
    const memory = temp('safe-tombstone-large-result-');
    const topics = path.join(memory, 'topics');
    fs.mkdirSync(topics);
    const count = 2_600;
    for (let index = 0; index < count; index += 1) {
      const name = `note-${String(index).padStart(4, '0')}-${'x'.repeat(80)}.md`;
      fs.writeFileSync(path.join(topics, name), 'memory');
    }

    const result = tombstoneMarkdownTreeNoFollowSync({
      memoryDirectory: memory,
      tombstoneFileName: 'memory-delete-now.json',
      renameStamp: 'now',
      metadata: { tenant_id: 'tenant-test' },
      maxBytes: 4 * 1024 * 1024,
      maxEntries: 5_000,
    });

    expect(result.deletedFiles).toHaveLength(count);
    expect(
      Buffer.byteLength(JSON.stringify(result.deletedFiles)),
    ).toBeGreaterThan(256 * 1024);
    expect(fs.existsSync(result.tombstonePath)).toBe(true);
  });
});
