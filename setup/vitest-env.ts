import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach } from 'vitest';

// Isolate test state from user data and other test workers.
//
// Здесь для КАЖДОГО воркера vitest создаётся свежий каталог состояния во
// временной папке, и на него переключаются config-модули ядра и панели.
// Setup-файлы выполняются до импорта тестовых модулей, поэтому module-level
// `export const STATE_ROOT` уже видит переменную. cwd не меняется — тесты
// продолжают доставать из репозитория node_modules/.bin/srt, agent/skills и
// прочие ассеты по относительным путям.
// realpath обязателен: на macOS os.tmpdir() = /var/folders/..., а код под
// тестом сравнивает уже разрешённые пути (/private/var/folders/...).
const stateRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-test-state-')),
);
for (const dir of ['store', 'groups', 'logs', 'data']) {
  fs.mkdirSync(path.join(stateRoot, dir), { recursive: true });
}
process.env.SKOOBI_TEST_STATE_ROOT = stateRoot;

// Страховка: если каталог состояния почему-то оказался вне временной папки —
// падаем сразу, а не пишем в чей-то боевой инстанс.
if (!path.resolve(stateRoot).startsWith(fs.realpathSync(os.tmpdir()))) {
  throw new Error(
    `SKOOBI_TEST_STATE_ROOT вне временной папки: ${stateRoot}. ` +
      'Прогон остановлен, чтобы не писать в боевой инстанс.',
  );
}

process.on('exit', () => {
  try {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  } catch {
    // уборка — не повод ронять прогон
  }
});

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
