import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// r1111 (SEC-07): озвучка голосом Edge идёт через Python edge-tts в
// .runtime/edge-tts/venv и scripts/edge-tts-adapter.py. Раньше venv не
// создавал ни один скрипт и версии не были закреплены. Проверка venv в
// selftest (скрипт есть не в каждой поставке) идёт отдельным тестом рядом
// с ним.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-edge-tts-test-'));
}

function fakePython(dir: string, body: string): string {
  const file = path.join(dir, 'python');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe('голос edge-tts: проверка и установка', () => {
  it('voice-tts не объявляет npm-пакеты, которые не импортирует', () => {
    const pkgDir = path.join(repoRoot, 'packages', 'voice-tts');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const sources = fs
      .readdirSync(path.join(pkgDir, 'src'))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => fs.readFileSync(path.join(pkgDir, 'src', file), 'utf8'))
      .join('\n');
    const unused = Object.keys(manifest.dependencies ?? {}).filter(
      (name) => !sources.includes(`'${name}`) && !sources.includes(`"${name}`),
    );
    expect(unused).toEqual([]);
  });

  it('версии Python-пакетов голоса закреплены', () => {
    const lines = fs
      .readFileSync(path.join(repoRoot, 'scripts', 'edge-tts-requirements.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.filter((line) => !/^[A-Za-z0-9_.-]+==[0-9][\w.]*$/.test(line))).toEqual([]);
    expect(lines).toContain('edge-tts==7.2.8');
    expect(lines).toContain('aiohttp==3.13.5');
  });

  it('установщик venv не берёт Python старше 3.10', () => {
    const dir = tempDir();
    const run = (python: string) =>
      spawnSync(
        'bash',
        [
          '-c',
          `set -u\neval "$(sed -n '/^python_is_supported() {/,/^}/p' scripts/setup-edge-tts.sh)"\npython_is_supported "$1"`,
          'check',
          python,
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      );
    expect(run(fakePython(dir, 'case "$*" in *version_info*) exit 1;; esac; exit 0')).status).not.toBe(0);
    expect(run(fakePython(dir, 'exit 0')).status).toBe(0);
  });

  it('установщик venv не трогает существующий venv без --replace', () => {
    const dir = tempDir();
    const venv = path.join(dir, 'venv');
    fs.mkdirSync(path.join(venv, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(venv, 'marker'), 'old');
    const result = spawnSync(
      'bash',
      ['scripts/setup-edge-tts.sh', '--venv', venv, '--python', '/usr/bin/false'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--replace');
    expect(fs.readFileSync(path.join(venv, 'marker'), 'utf8')).toBe('old');
  });

  // r1111 (DC-R3): venv создаётся в каталоге приложения, а служба из
  // install.sh работает из каталога инстанса — установщик venv подсказывает
  // точные строки EDGE_TTS_BIN/EDGE_TTS_SCRIPT для .env инстанса.
  it('установщик venv подсказывает пути для .env инстанса', () => {
    const dir = tempDir();
    // поддельный Python: `-m venv X` кладёт себя в X/bin/python, остальное — успех
    const python = fakePython(
      dir,
      [
        'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then mkdir -p "$3/bin" && cp "$0" "$3/bin/python" && exit 0; fi',
        'case "$*" in *sys.version.split*) echo 3.12.0;; esac',
        'exit 0',
      ].join('\n'),
    );
    const venv = path.join(dir, 'venv');
    const result = spawnSync(
      'bash',
      ['scripts/setup-edge-tts.sh', '--venv', venv, '--python', python],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `EDGE_TTS_BIN="${fs.realpathSync(venv)}/bin/python"`,
    );
    expect(result.stdout).toContain(
      `EDGE_TTS_SCRIPT="${fs.realpathSync(repoRoot)}/scripts/edge-tts-adapter.py"`,
    );
  });

  it('адаптер говорит понятно, если edge-tts не той версии', () => {
    const dir = tempDir();
    const pkg = path.join(dir, 'edge_tts');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, '__init__.py'), 'class Communicate: pass\n');
    fs.writeFileSync(path.join(pkg, 'communicate.py'), 'WSS_URL = ""\nWSS_HEADERS = {}\n');
    fs.writeFileSync(path.join(pkg, 'constants.py'), '# без TRUSTED_CLIENT_TOKEN\n');
    const result = spawnSync(
      'python3',
      [path.join(repoRoot, 'scripts', 'edge-tts-adapter.py'), '--voice', 'x', '--file', 'x', '--write-media', 'x'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, PYTHONPATH: dir } },
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('setup-edge-tts.sh');
    expect(result.stderr).not.toContain('Traceback');
  });
});
