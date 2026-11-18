import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

it('checks isolated private update receipts, real process interruption and exact-ref publication recovery', () => {
  execFileSync(
    'python3',
    [
      fileURLToPath(
        new URL('./private-update-workflow.test.py', import.meta.url),
      ),
    ],
    {
      // This subprocess runs the whole sequential Python integration suite.
      timeout: 180_000,
      maxBuffer: 128 * 1024,
      stdio: 'pipe',
      env: { PATH: process.env.PATH || '', PYTHONDONTWRITEBYTECODE: '1' },
    },
  );
}, 200_000);
