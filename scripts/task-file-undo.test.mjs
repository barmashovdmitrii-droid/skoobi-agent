import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

it('passes the real file undo, manual conflict and interrupted-process regressions', () => {
  execFileSync('python3', [fileURLToPath(new URL('./task-file-undo.test.py', import.meta.url))], {
    timeout: 20_000,
    maxBuffer: 64 * 1024,
    stdio: 'pipe',
    env: { PATH: process.env.PATH || '', PYTHONDONTWRITEBYTECODE: '1' },
  });
}, 25_000);
