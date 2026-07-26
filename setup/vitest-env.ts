import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach } from 'vitest';

const testEnvDir = path.join(os.tmpdir(), 'skoobi-vitest-env');
const testEnvFile = path.join(testEnvDir, '.env');
const missingConfigFile = path.join(testEnvDir, 'missing-skoobi.yaml');
const ambientRuntimeKeys = [
  'SKOOBI_RUNTIME_MODE',
  'SKOOBI_PRIVATE_ADMIN_MODE',
  'SKOOBI_PRIVATE_ADMIN_TELEGRAM_USER_IDS',
  'SKOOBI_CONFIG_FILE',
];

function resetTestEnvFile(): void {
  fs.mkdirSync(testEnvDir, { recursive: true });
  fs.writeFileSync(
    testEnvFile,
    `SKOOBI_CONFIG_FILE=${missingConfigFile}\n`,
    'utf8',
  );
  process.env.CLAUDECLAW_ENV_FILE = testEnvFile;
  for (const key of ambientRuntimeKeys) delete process.env[key];
}

beforeEach(resetTestEnvFile);
afterEach(resetTestEnvFile);

resetTestEnvFile();
