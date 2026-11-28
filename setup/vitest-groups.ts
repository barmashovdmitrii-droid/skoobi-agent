// W43 (разбор недели): проверка на GitHub (CI) была нестабильной —
// один и тот же коммит то зелёный, то красный. Причина не в коде, а в нагрузке
// на машину GitHub (3 ядра): тесты с настоящим браузером и настоящими
// процессами шли одновременно со всеми остальными и не укладывались в лимиты.
//
// Здесь в одном месте описано, как набор тестов делится на два обязательных
// шага CI:
//   SKOOBI_VITEST_GROUP=main       — всё, кроме тестов ниже (параллельно);
//   SKOOBI_VITEST_GROUP=processes  — тесты с настоящими процессами и браузером
//                                    (CI гоняет их по одному файлу за раз,
//                                    флаг --no-file-parallelism).
// Без переменной (локальный `npm test`) идут все тесты одной кучей. Местные
// полные прогоны — pre-push, проверка обновления на Mac mini
// (scripts/private-update-workflow.py) и сборка релиза для MacBook
// (ops/peer/peer-release.py) — с CQ-02 (r1111) делят набор так же, как CI:
// сначала main параллельно, потом processes по одному файлу. Одной кучей под
// нагрузкой на Mac mini падали по лимиту тесты песочницы, приёмки и проверки
// обновления.
// Деление строится из одного списка, поэтому тест не может выпасть из обоих
// шагов сразу: что не попало в processes, остаётся в main.
//
// Слепых повторов (retry) здесь нет намеренно: красный должен значить поломку.

import { configDefaults } from 'vitest/config';

export const VITEST_GROUP_ENV = 'SKOOBI_VITEST_GROUP';

export const TEST_INCLUDE: readonly string[] = [
  'src/**/*.test.ts',
  'packages/**/src/**/*.test.ts',
  'agent/runner/src/**/*.test.ts',
  'setup/**/*.test.ts',
  'scripts/**/*.test.mjs',
];

// Тесты, которые запускают настоящие процессы: скрипты из scripts/ и всё, что
// открывает настоящий браузер (Playwright) — напрямую или через
// scripts/artifact-acceptance-checker.mjs. setup/vitest-groups.test.ts следит,
// чтобы новый браузерный тест не остался в общем параллельном шаге.
//
// В общем шаге пока остаются тесты, которые сами запускают node/tsx. Самые
// тяжёлые из них на GitHub (по 12–15 с, свои лимиты 25–45 с, за неделю ни
// разу не падали): setup/game-factory-peer-prepare.test.ts и
// agent/runner/src/index-continuation.test.ts. Если шаг main начнёт плавать,
// сначала перенести сюда их.
export const PROCESS_TEST_FILES: readonly string[] = [
  'scripts/**/*.test.mjs',
  'packages/core/src/orchestrator/skill-verification.test.ts',
  'packages/core/src/orchestrator/artifact-acceptance.test.ts',
  'packages/core/src/orchestrator/artifact-acceptance-policy.test.ts',
  'packages/core/src/orchestrator/elevator-artifact-acceptance.test.ts',
  'packages/core/src/orchestrator/document-acceptance.test.ts',
  'packages/core/src/orchestrator/artifact-job.test.ts',
  'packages/core/src/orchestrator/game-factory-html5-check.test.ts',
  'setup/game-factory-html5-template.test.ts',
  'setup/game-factory-template-workflow.test.ts',
  // CQ-02 (r1111): запускает настоящий node через /bin/sh, и лимит запроса
  // включает запуск процесса — под нагрузкой тест не укладывался.
  'packages/memory/src/semantic-retrieval.test.ts',
  // CQ-02 (r1111): тесты с настоящим srt/Seatbelt (sandbox-exec).
  'packages/core/src/runtimes/sandbox-runner.test.ts',
  // Installer and service-lifecycle tests spawn real git, bash and node
  // processes for minutes; hosted runners need them one file at a time.
  'src/scripts/installer.test.ts',
  'src/orchestrator/service-lifecycle.test.ts',
];

// Свой `exclude` в конфиге заменяет стандартные исключения vitest
// (node_modules, .git), поэтому добавляем их явно.
export const DEFAULT_TEST_EXCLUDE: readonly string[] = configDefaults.exclude;

export type VitestGroup = 'all' | 'main' | 'processes';

type Env = Record<string, string | undefined>;

export function vitestGroup(env: Env): VitestGroup {
  const raw = (env[VITEST_GROUP_ENV] ?? '').trim();
  if (raw === '' || raw === 'all') return 'all';
  if (raw === 'main' || raw === 'processes') return raw;
  // Опечатка в CI не должна молча запускать «ничего» или «всё дважды».
  throw new Error(
    `${VITEST_GROUP_ENV}=${raw}: неизвестная группа тестов (допустимо: main, processes или пусто)`,
  );
}

export function vitestFileSelection(env: Env): {
  include: string[];
  exclude: string[];
} {
  switch (vitestGroup(env)) {
    case 'main':
      return {
        include: [...TEST_INCLUDE],
        exclude: [...DEFAULT_TEST_EXCLUDE, ...PROCESS_TEST_FILES],
      };
    case 'processes':
      return {
        include: [...PROCESS_TEST_FILES],
        exclude: [...DEFAULT_TEST_EXCLUDE],
      };
    default:
      return {
        include: [...TEST_INCLUDE],
        exclude: [...DEFAULT_TEST_EXCLUDE],
      };
  }
}

// На машине GitHub лимит одного теста и хука 20 с вместо 5/10 с: тест удаления
// памяти в telegram.test.ts запускает /usr/bin/python3 и на перегруженной
// машине GitHub шёл 4,8–9,1 с (на Mac mini — 0,04–0,1 с). Везде, кроме GitHub,
// лимиты прежние, чтобы реальное замедление было видно.
//
// Смотрим именно GITHUB_ACTIONS, а не CI: CI=1/true сами ставят местные
// проверки перед `npm test` — проверка обновления на Mac mini
// (scripts/private-update-workflow.py) и сборка релиза для MacBook
// (ops/peer/peer-release.py). Обе собирают окружение с нуля и GITHUB_ACTIONS
// не передают, поэтому у них остаются строгие 5/10 с, как до W43.
export const LOCAL_TEST_TIMEOUT_MS = 5_000;
export const LOCAL_HOOK_TIMEOUT_MS = 10_000;
export const CI_TEST_TIMEOUT_MS = 20_000;

export function isGithubActionsEnv(env: Env): boolean {
  // GitHub Actions всегда ставит ровно GITHUB_ACTIONS=true.
  return (env.GITHUB_ACTIONS ?? '').trim().toLowerCase() === 'true';
}

export function vitestTimeouts(env: Env): {
  testTimeout: number;
  hookTimeout: number;
} {
  return isGithubActionsEnv(env)
    ? { testTimeout: CI_TEST_TIMEOUT_MS, hookTimeout: CI_TEST_TIMEOUT_MS }
    : {
        testTimeout: LOCAL_TEST_TIMEOUT_MS,
        hookTimeout: LOCAL_HOOK_TIMEOUT_MS,
      };
}
