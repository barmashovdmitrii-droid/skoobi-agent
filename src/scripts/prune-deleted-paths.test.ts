import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// r1111 (DC-R2): выкатка копирует файлы через rsync без --delete и делает
// `git reset --mixed`, так что удалённые в ветке исходники остаются в проде
// неотслеживаемыми и ломают следующую сборку там. scripts/prune-deleted-paths.sh
// убирает их, но только если файл в проде совпадает с базовой версией.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const script = path.join(repoRoot, 'scripts', 'prune-deleted-paths.sh');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-prune-test-'));
  const repo = path.join(root, 'repo');
  const target = path.join(root, 'target');
  fs.mkdirSync(repo);
  const env = { ...process.env, HOME: root };
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: repo, env, encoding: 'utf8' },
    ).trim();
  const files: Record<string, string> = {
    'keep.txt': 'keep\n',
    'gone.txt': 'gone\n',
    'patches/a.patch': 'a\n',
    'patches/b.sh': 'b\n',
    'pkg/src/old.ts': 'export {};\n',
    'pkg/src/live.ts': 'export const x = 1;\n',
  };
  git('init', '-q', '-b', 'main');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  for (const rel of ['gone.txt', 'patches/a.patch', 'patches/b.sh', 'pkg/src/old.ts']) {
    fs.rmSync(path.join(repo, rel));
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  // прод после rsync без --delete: новые файлы есть, удалённые — остались
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
    fs.writeFileSync(path.join(target, rel), body);
  }
  const run = (...extra: string[]) =>
    spawnSync(
      'bash',
      [script, '--repo', repo, '--target', target, '--from', base, '--to', head, ...extra],
      { cwd: root, env, encoding: 'utf8' },
    );
  return { root, target, run };
}

describe('prune-deleted-paths.sh', () => {
  it('без --apply только показывает план и ничего не удаляет', () => {
    const { target, run } = fixture();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('удалить: patches/a.patch');
    expect(result.stdout).toContain('удалить: pkg/src/old.ts');
    expect(result.stdout).not.toContain('keep.txt');
    expect(fs.existsSync(path.join(target, 'patches', 'a.patch'))).toBe(true);
  });

  it('с --apply удаляет совпадающие файлы, пустые каталоги и сохраняет копию', () => {
    const { root, target, run } = fixture();
    const backup = path.join(root, 'deleted.tar');
    const result = run('--apply', '--backup', backup);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(target, 'gone.txt'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'patches'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'pkg', 'src', 'old.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(target, 'pkg', 'src', 'live.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('keep\n');
    const listed = execFileSync('tar', ['-tf', backup], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(listed).toEqual(['gone.txt', 'patches/a.patch', 'patches/b.sh', 'pkg/src/old.ts']);

    // повторный прогон — удалять уже нечего
    const again = run('--apply');
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('уже нет: gone.txt');
  });

  it('файл, изменённый на месте, не трогает и останавливает выкатку', () => {
    const { target, run } = fixture();
    fs.writeFileSync(path.join(target, 'patches', 'b.sh'), 'local edit\n');
    const result = run('--apply');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('ИЗМЕНЁН, не трогаю: patches/b.sh');
    // ни один файл не удалён, даже совпадающие
    expect(fs.existsSync(path.join(target, 'patches', 'a.patch'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'gone.txt'))).toBe(true);
  });
});
