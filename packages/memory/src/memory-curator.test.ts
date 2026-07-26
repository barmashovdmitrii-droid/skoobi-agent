import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { curateMemoryRoot } from './memory-curator.js';
import { MAX_MEMORY_FILE_READ_BYTES } from './memory-context.js';

let root: string;

function writeMemory(rel: string, content: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe('memory curator', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-curator-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes bounded curated MEMORY.md and USER.md without modifying source memory', () => {
    const source = writeMemory(
      'topics/project.md',
      [
        '# Project',
        '',
        '- [2026-06-09 10:00:00] Важно: проект Skoobi использует lazy memory.',
        '- [2026-06-09 10:05:00] Пользователь предпочитает короткие статусы.',
        '- [2026-06-09 10:10:00] api_key should not be saved.',
      ].join('\n'),
    );
    const before = fs.readFileSync(source, 'utf8');

    const result = curateMemoryRoot(root, {
      now: new Date('2026-06-09T12:00:00Z'),
      memoryCharLimit: 800,
      userCharLimit: 600,
    });

    expect(result.written).toBe(true);
    expect(result.sourceFiles).toBe(1);
    expect(result.candidates).toBe(2);
    expect(fs.readFileSync(source, 'utf8')).toBe(before);

    const memory = fs.readFileSync(
      path.join(root, 'curated', 'MEMORY.md'),
      'utf8',
    );
    const user = fs.readFileSync(path.join(root, 'curated', 'USER.md'), 'utf8');
    expect(memory).toContain('Skoobi использует lazy memory');
    expect(memory).toContain('source: topics/project.md');
    expect(user).toContain('Пользователь предпочитает короткие статусы');
    expect(memory).not.toContain('api_key');
    expect(user.length).toBeLessThanOrEqual(600);
  });

  it('supports dry-run without creating curated files', () => {
    writeMemory('topics/project.md', '- Важно: dry-run не пишет файлы.');

    const result = curateMemoryRoot(root, { dryRun: true });

    expect(result.written).toBe(false);
    expect(fs.existsSync(path.join(root, 'curated'))).toBe(false);
  });

  it('backs up existing curated files before overwrite', () => {
    writeMemory('topics/project.md', '- Важно: новая память.');
    writeMemory('curated/MEMORY.md', '# old memory\n');
    writeMemory('curated/USER.md', '# old user\n');

    curateMemoryRoot(root, {
      now: new Date('2026-06-09T12:00:00Z'),
    });

    const backups = fs
      .readdirSync(path.join(root, 'curated'))
      .filter((name) => name.includes('.bak-'));
    expect(backups).toHaveLength(2);
  });

  it('rejects a guest-planted curated directory symlink without writing outside', () => {
    writeMemory('topics/project.md', '- Важно: новая безопасная память.');
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), 'memory-curator-outside-'),
    );
    const sentinel = path.join(outside, 'MEMORY.md');
    fs.writeFileSync(sentinel, 'HOST_SENTINEL');
    fs.symlinkSync(outside, path.join(root, 'curated'));

    expect(() =>
      curateMemoryRoot(root, {
        now: new Date('2026-06-09T12:00:00Z'),
      }),
    ).toThrow(/Unsafe direct-child write rejected/);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('HOST_SENTINEL');
    expect(fs.existsSync(path.join(outside, 'USER.md'))).toBe(false);

    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a symlink memory root instead of curating the symlink target', () => {
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), 'memory-curator-root-outside-'),
    );
    const linkedRoot = `${root}-link`;
    fs.writeFileSync(
      path.join(outside, 'source.md'),
      '- Важно: этот внешний каталог нельзя изменять.\n',
    );
    fs.symlinkSync(outside, linkedRoot);

    expect(() => curateMemoryRoot(linkedRoot)).toThrow(
      /Unsafe memory curator root/,
    );
    expect(fs.existsSync(path.join(outside, 'curated'))).toBe(false);

    fs.unlinkSync(linkedRoot);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('atomically replaces final symlink and hardlink entries without touching their targets', () => {
    writeMemory('topics/project.md', '- Важно: новая безопасная память.');
    const curated = path.join(root, 'curated');
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), 'memory-curator-targets-'),
    );
    fs.mkdirSync(curated);
    const symlinkTarget = path.join(outside, 'host-memory.md');
    const hardlinkTarget = path.join(outside, 'host-user.md');
    fs.writeFileSync(symlinkTarget, 'SYMLINK_TARGET_SENTINEL');
    fs.writeFileSync(hardlinkTarget, 'HARDLINK_TARGET_SENTINEL');
    fs.symlinkSync(symlinkTarget, path.join(curated, 'MEMORY.md'));
    fs.linkSync(hardlinkTarget, path.join(curated, 'USER.md'));

    curateMemoryRoot(root, {
      now: new Date('2026-06-09T12:00:00Z'),
    });

    expect(fs.readFileSync(symlinkTarget, 'utf8')).toBe(
      'SYMLINK_TARGET_SENTINEL',
    );
    expect(fs.readFileSync(hardlinkTarget, 'utf8')).toBe(
      'HARDLINK_TARGET_SENTINEL',
    );
    expect(fs.lstatSync(path.join(curated, 'MEMORY.md')).isSymbolicLink()).toBe(
      false,
    );
    expect(fs.statSync(path.join(curated, 'MEMORY.md')).nlink).toBe(1);
    expect(fs.statSync(path.join(curated, 'USER.md')).nlink).toBe(1);

    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('samples an oversized source with a fixed same-fd cap', () => {
    const source = writeMemory(
      'topics/large.md',
      `${'x'.repeat(MAX_MEMORY_FILE_READ_BYTES + 64)}\n- Важно: хвост большой памяти остаётся доступен.\n`,
    );

    const result = curateMemoryRoot(root, {
      dryRun: true,
      memoryCharLimit: 800,
    });

    expect(fs.statSync(source).size).toBeGreaterThan(
      MAX_MEMORY_FILE_READ_BYTES,
    );
    expect(result.sourceFiles).toBe(1);
    expect(result.candidates).toBeGreaterThanOrEqual(1);
  });

  it('does not curate a multiply-linked guest memory file', () => {
    const source = writeMemory(
      'topics/source.md',
      '- Важно: эта строка не должна пройти через hardlink.\n',
    );
    fs.linkSync(source, path.join(root, 'topics', 'alias.md'));

    const result = curateMemoryRoot(root, { dryRun: true });

    expect(result.sourceFiles).toBe(2);
    expect(result.candidates).toBe(0);
  });
});
