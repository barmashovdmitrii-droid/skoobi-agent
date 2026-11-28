import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

// W43: на машине GitHub этот прогон шёл 45–78 с и однажды упёрся в прежний
// лимит 90 с (spawnSync python3 ETIMEDOUT). Внутренний лимит python ниже
// лимита vitest, чтобы при зависании пришла понятная ошибка, а не обрыв теста.
const PYTHON_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 200_000;

it(
  'checks isolated private update receipts, real process interruption and exact-ref publication recovery',
  () => {
    execFileSync(
      'python3',
      [
        fileURLToPath(
          new URL('./private-update-workflow.test.py', import.meta.url),
        ),
      ],
      {
        timeout: PYTHON_TIMEOUT_MS,
        maxBuffer: 128 * 1024,
        stdio: 'pipe',
        env: { PATH: process.env.PATH || '', PYTHONDONTWRITEBYTECODE: '1' },
      },
    );
  },
  TEST_TIMEOUT_MS,
);
