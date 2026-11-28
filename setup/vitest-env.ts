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
// The instance profile (config/instance.json) holds the values of a real
// installation: tests must not depend on it. Every test file starts with an
// empty injected profile, which is the neutral defaults without touching the
// disk; a test that needs owner values injects synthetic ones
// (setInstanceProfileForTests in @skoobi/shared/instance-profile). The
// injected profile lives on globalThis under the first key, so setting it here
// also drops what another test file may have left behind. The second key is
// what resetInstanceProfileForTests() goes back to: the same empty profile,
// so a reset never makes the loader read a file.
const emptyInstanceProfile = Object.freeze({});
for (const key of [
  'skoobi.instance-profile.test-override',
  'skoobi.instance-profile.test-baseline',
]) {
  (globalThis as Record<symbol, unknown>)[Symbol.for(key)] =
    emptyInstanceProfile;
}
// A process a test starts inherits the environment, not the injected profile:
// point the loader at a file that does not exist, so it stays neutral too
// (and so does this process if a test removes the injected profile).
const missingInstanceProfileFile = path.join(
  testEnvDir,
  'missing-instance-profile.json',
);
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
  process.env.SKOOBI_INSTANCE_PROFILE_FILE = missingInstanceProfileFile;
  for (const key of ambientRuntimeKeys) delete process.env[key];
}

beforeEach(resetTestEnvFile);
afterEach(resetTestEnvFile);

resetTestEnvFile();
