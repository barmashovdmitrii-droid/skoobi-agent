import os from 'os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetInstanceProfileForTests,
  setInstanceProfileForTests,
  type InstanceLaunchdUnit,
} from './instance-profile.js';
import {
  collectLaunchdServices,
  launchdUnits,
  listedMainServiceLabel,
  parseDisabledLabels,
  type LaunchdProbeDeps,
} from './launchd-services.js';

const HOME = '/Users/example/fixture-home';
const NOW = Date.parse('2026-11-09T12:00:00.000Z');

// A synthetic installation: the job list of a real one lives in its instance
// profile, which tests never read.
const INSTANCE_DIR = `${HOME}/fixture/instance`;
const WATCHDOG_DIR = `${HOME}/fixture/watchdog`;
const FIXTURE_UNITS: InstanceLaunchdUnit[] = [
  {
    id: 'main',
    name: 'Основная служба',
    label: 'com.example.fixture-main',
    kind: 'daemon',
  },
  {
    id: 'second-bot',
    name: 'Второй бот',
    label: 'com.example.fixture-second-bot',
    kind: 'daemon',
  },
  {
    id: 'sidecar',
    name: 'Помощник',
    label: 'com.example.fixture-sidecar',
    kind: 'daemon',
  },
  {
    id: 'renderer',
    name: 'Картинки',
    label: 'com.example.fixture-renderer',
    kind: 'daemon',
  },
  {
    id: 'log-rotation',
    name: 'Ротация журналов',
    label: 'com.example.fixture-log-rotation',
    kind: 'periodic',
    periodSec: 1800,
  },
  {
    id: 'weekly-cleanup',
    name: 'Уборка раз в неделю',
    label: 'com.example.fixture-weekly-cleanup',
    kind: 'periodic',
    periodSec: 7 * 86_400,
    heartbeatLog: '{instance}/logs/weekly-cleanup.log',
  },
  {
    id: 'daily-report',
    name: 'Ежедневный отчёт',
    label: 'com.example.fixture-daily-report',
    kind: 'periodic',
    periodSec: 86_400,
    heartbeatLog: '{instance}/logs/daily-report.log',
  },
  {
    id: 'nightly-copy',
    name: 'Ночная копия',
    label: 'com.example.fixture-nightly-copy',
    kind: 'periodic',
    periodSec: 86_400,
    heartbeatLog: '{instance}/logs/nightly-copy.log',
  },
  {
    id: 'nightly-archive',
    name: 'Ночной архив',
    label: 'com.example.fixture-nightly-archive',
    kind: 'periodic',
    periodSec: 86_400,
    heartbeatLog: '{instance}/logs/nightly-archive.log',
  },
  {
    id: 'remote-backup',
    name: 'Копия с сервера',
    label: 'org.example.fixture.remote-backup',
    kind: 'periodic',
    periodSec: 86_400,
    heartbeatLog: '{home}/Library/Logs/Fixture/remote-backup.log',
  },
  {
    id: 'watchdog',
    name: 'Сторож',
    label: 'com.example.fixture-watchdog',
    kind: 'periodic',
    periodSec: 300,
    heartbeatLog: '{watchdog}/logs/watchdog.log',
  },
];

const originalHome = process.env.HOME;

beforeEach(() => {
  vi.stubEnv('SKOOBI_WATCHDOG_DIR', '');
  setInstanceProfileForTests({
    launchd: {
      instanceDir: '{home}/fixture/instance',
      watchdogDir: '{home}/fixture/watchdog',
      units: FIXTURE_UNITS,
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  resetInstanceProfileForTests();
});

function probe(opts: {
  list: string;
  disabled?: string;
  installed?: string[];
  print?: Record<string, string>;
  mtimes?: Record<string, number>;
}): LaunchdProbeDeps {
  const installed = new Set(
    (opts.installed ?? launchdUnits(HOME).map((u) => u.label)).map(
      (label) => `${HOME}/Library/LaunchAgents/${label}.plist`,
    ),
  );
  return {
    platform: 'darwin',
    home: HOME,
    uid: 501,
    now: () => NOW,
    exists: (file) => installed.has(file),
    mtimeMs: (file) => opts.mtimes?.[file] ?? NOW - 60_000,
    launchctl: async (args) => {
      if (args[0] === 'list') return opts.list;
      if (args[0] === 'print-disabled') return opts.disabled ?? '';
      const label = args[1].split('/').pop()!;
      if (opts.print?.[label] !== undefined) return opts.print[label];
      throw new Error('Could not find service');
    },
  };
}

function listOf(rows: Array<[string, string, string]>): string {
  return ['PID\tStatus\tLabel', ...rows.map((r) => r.join('\t'))].join('\n');
}

function allLoaded(): Array<[string, string, string]> {
  return launchdUnits(HOME).map((u) => [
    u.kind === 'daemon' ? '700' : '-',
    '0',
    u.label,
  ]);
}

describe('launchdUnits (M-C48)', () => {
  it('covers the nightly copy, archive, report and weekly cleanup jobs of the profile', () => {
    const labels = launchdUnits(HOME).map((u) => u.label);
    for (const label of [
      'com.example.fixture-nightly-copy',
      'com.example.fixture-nightly-archive',
      'com.example.fixture-weekly-cleanup',
      'com.example.fixture-daily-report',
    ]) {
      expect(labels).toContain(label);
    }
    const weekly = launchdUnits(HOME).find((u) => u.id === 'weekly-cleanup')!;
    expect(weekly.periodSec).toBe(7 * 86_400);
    expect(weekly.heartbeatLog).toBe(`${INSTANCE_DIR}/logs/weekly-cleanup.log`);
  });

  it('returns the jobs of the instance profile in order, paths filled in', () => {
    const units = launchdUnits(HOME);
    expect(units.map((u) => u.id)).toEqual(FIXTURE_UNITS.map((u) => u.id));
    expect(units[0]).toEqual({
      id: 'main',
      name: 'Основная служба',
      label: 'com.example.fixture-main',
      kind: 'daemon',
    });
    // A job without a heartbeat log keeps none.
    expect(units.find((u) => u.id === 'log-rotation')).toEqual({
      id: 'log-rotation',
      name: 'Ротация журналов',
      label: 'com.example.fixture-log-rotation',
      kind: 'periodic',
      periodSec: 1800,
    });
    expect(units.find((u) => u.id === 'remote-backup')?.heartbeatLog).toBe(
      `${HOME}/Library/Logs/Fixture/remote-backup.log`,
    );
    expect(units.find((u) => u.id === 'watchdog')?.heartbeatLog).toBe(
      `${WATCHDOG_DIR}/logs/watchdog.log`,
    );
    expect(Object.keys(units.find((u) => u.id === 'watchdog')!)).toEqual([
      'id',
      'name',
      'label',
      'kind',
      'periodSec',
      'heartbeatLog',
    ]);
  });

  it('without an instance profile lists the main service and the panel', () => {
    resetInstanceProfileForTests();
    expect(launchdUnits(HOME)).toEqual([
      {
        id: 'main',
        name: 'Скуби',
        label: 'com.skoobi.default',
        kind: 'daemon',
      },
      {
        id: 'dashboard',
        name: 'Локальная панель',
        label: 'com.skoobi.dashboard',
        kind: 'daemon',
      },
    ]);
  });

  it('gives the main service the label the caller resolved', () => {
    const units = launchdUnits(HOME, undefined, 'com.skoobi.team_1');
    expect(units.find((u) => u.id === 'main')?.label).toBe('com.skoobi.team_1');
    expect(units.filter((u) => u.id !== 'main').map((u) => u.label)).toEqual(
      FIXTURE_UNITS.filter((u) => u.id !== 'main').map((u) => u.label),
    );
    // No label resolved: the profile's own.
    expect(launchdUnits(HOME, undefined, '')[0].label).toBe(
      'com.example.fixture-main',
    );
  });

  it('takes the watchdog directory from the argument, then SKOOBI_WATCHDOG_DIR, then the profile', () => {
    const watchdogLog = (units: ReturnType<typeof launchdUnits>) =>
      units.find((u) => u.id === 'watchdog')?.heartbeatLog;
    expect(watchdogLog(launchdUnits(HOME))).toBe(
      `${WATCHDOG_DIR}/logs/watchdog.log`,
    );
    vi.stubEnv('SKOOBI_WATCHDOG_DIR', '/srv/fixture-watchdog');
    expect(watchdogLog(launchdUnits(HOME))).toBe(
      '/srv/fixture-watchdog/logs/watchdog.log',
    );
    expect(watchdogLog(launchdUnits(HOME, '/opt/fixture-watchdog'))).toBe(
      '/opt/fixture-watchdog/logs/watchdog.log',
    );
  });

  it('leaves out a heartbeat log under a directory the installation does not configure', () => {
    setInstanceProfileForTests({ launchd: { units: FIXTURE_UNITS } });
    const units = launchdUnits(HOME);
    expect(units.find((u) => u.id === 'weekly-cleanup')).toEqual({
      id: 'weekly-cleanup',
      name: 'Уборка раз в неделю',
      label: 'com.example.fixture-weekly-cleanup',
      kind: 'periodic',
      periodSec: 7 * 86_400,
    });
    expect(
      units.find((u) => u.id === 'watchdog')?.heartbeatLog,
    ).toBeUndefined();
    // `{home}` is always known.
    expect(units.find((u) => u.id === 'remote-backup')?.heartbeatLog).toBe(
      `${HOME}/Library/Logs/Fixture/remote-backup.log`,
    );
  });

  it('falls back to the profile home, then to the system one, when HOME is unset', () => {
    // Removed, not emptied: with an empty HOME the system has no answer.
    delete process.env.HOME;
    expect(os.homedir()).not.toBe('');
    expect(
      launchdUnits().find((u) => u.id === 'weekly-cleanup')?.heartbeatLog,
    ).toBe(`${os.homedir()}/fixture/instance/logs/weekly-cleanup.log`);

    setInstanceProfileForTests({
      launchd: {
        fallbackHome: '/Users/example/fallback-home',
        instanceDir: '{home}/fixture/instance',
        watchdogDir: '{home}/fixture/watchdog',
        units: FIXTURE_UNITS,
      },
    });
    expect(
      launchdUnits().find((u) => u.id === 'weekly-cleanup')?.heartbeatLog,
    ).toBe(
      '/Users/example/fallback-home/fixture/instance/logs/weekly-cleanup.log',
    );
    expect(launchdUnits().find((u) => u.id === 'watchdog')?.heartbeatLog).toBe(
      '/Users/example/fallback-home/fixture/watchdog/logs/watchdog.log',
    );

    process.env.HOME = HOME;
    expect(
      launchdUnits().find((u) => u.id === 'weekly-cleanup')?.heartbeatLog,
    ).toBe(`${INSTANCE_DIR}/logs/weekly-cleanup.log`);
  });
});

describe('listedMainServiceLabel', () => {
  it('leaves the main unit on the label its profile names, whatever the setting says', () => {
    // beforeEach: a profile whose main unit has a label of its own.
    for (const configured of [
      undefined,
      'com.skoobi.team_1',
      'com.example.fixture-main',
      'com.example.other; rm -rf',
      '',
    ]) {
      if (configured === undefined)
        vi.stubEnv('SKOOBI_SERVICE_LABEL', undefined);
      else vi.stubEnv('SKOOBI_SERVICE_LABEL', configured);
      expect(listedMainServiceLabel()).toBeUndefined();
      expect(
        launchdUnits(HOME, undefined, listedMainServiceLabel())[0].label,
      ).toBe('com.example.fixture-main');
    }
  });

  it('follows SKOOBI_SERVICE_LABEL when the profile gives the main unit no label of its own', () => {
    resetInstanceProfileForTests();
    vi.stubEnv('SKOOBI_SERVICE_LABEL', undefined);
    expect(listedMainServiceLabel()).toBe('com.skoobi.default');

    vi.stubEnv('SKOOBI_SERVICE_LABEL', 'com.skoobi.team_1');
    expect(listedMainServiceLabel()).toBe('com.skoobi.team_1');
    expect(
      launchdUnits(HOME, undefined, listedMainServiceLabel())[0].label,
    ).toBe('com.skoobi.team_1');

    // The default label of an installation that predates the setting, when
    // its profile names it without listing its own jobs.
    vi.stubEnv('SKOOBI_SERVICE_LABEL', undefined);
    setInstanceProfileForTests({
      launchd: { mainLabel: 'com.example.fixture-main' },
    });
    expect(listedMainServiceLabel()).toBe('com.example.fixture-main');

    // A label the installer could not have written is reported, not used.
    vi.stubEnv('SKOOBI_SERVICE_LABEL', 'com.example.other; rm -rf');
    expect(() => listedMainServiceLabel()).toThrow(
      /Invalid SKOOBI_SERVICE_LABEL/u,
    );
  });

  it('has nothing to resolve for a profile without a main unit', () => {
    setInstanceProfileForTests({
      launchd: { units: FIXTURE_UNITS.filter((unit) => unit.id !== 'main') },
    });
    vi.stubEnv('SKOOBI_SERVICE_LABEL', 'com.example.other; rm -rf');
    expect(listedMainServiceLabel()).toBeUndefined();
  });
});

describe('parseDisabledLabels', () => {
  it('reads the disabled jobs out of print-disabled', () => {
    const out = [
      'disabled services = {',
      '\t\t"com.example.fixture-main" => enabled',
      '\t\t"com.example.fixture-second-bot" => disabled',
      '\t\t"com.example.fixture-renderer" => disabled',
      '\t}',
    ].join('\n');
    expect([...parseDisabledLabels(out)]).toEqual([
      'com.example.fixture-second-bot',
      'com.example.fixture-renderer',
    ]);
  });
});

describe('collectLaunchdServices (M-C48)', () => {
  it('reports no problems when everything is loaded and fresh', async () => {
    const report = await collectLaunchdServices(
      probe({ list: listOf(allLoaded()) }),
    );
    expect(report.checked).toBe(true);
    expect(report.services.map((s) => s.id)).toEqual(
      FIXTURE_UNITS.map((u) => u.id),
    );
    expect(report.problems).toEqual([]);
  });

  it('a job the owner switched off is grey, not red', async () => {
    const rows = allLoaded().filter(
      ([, , label]) =>
        label !== 'com.example.fixture-second-bot' &&
        label !== 'org.example.fixture.remote-backup',
    );
    const report = await collectLaunchdServices(
      probe({
        list: listOf(rows),
        disabled: [
          '"com.example.fixture-second-bot" => disabled',
          '"org.example.fixture.remote-backup" => disabled',
        ].join('\n'),
      }),
    );
    const secondBot = report.services.find((s) => s.id === 'second-bot')!;
    expect(secondBot).toMatchObject({
      state: 'off',
      detail: 'выключена намеренно',
    });
    expect(report.problems).toEqual([]);
  });

  it('a job not installed on this Mac is grey; an installed unloaded one is red', async () => {
    const rows = allLoaded().filter(
      ([, , label]) =>
        label !== 'com.example.fixture-renderer' &&
        label !== 'com.example.fixture-sidecar',
    );
    const report = await collectLaunchdServices(
      probe({
        list: listOf(rows),
        installed: launchdUnits(HOME)
          .map((u) => u.label)
          .filter((label) => label !== 'com.example.fixture-renderer'),
      }),
    );
    expect(report.services.find((s) => s.id === 'renderer')).toMatchObject({
      state: 'off',
      detail: 'не установлена на этом компьютере',
    });
    expect(report.problems.map((s) => [s.id, s.state, s.detail])).toEqual([
      ['sidecar', 'down', 'служба не загружена'],
    ]);
  });

  it('flags a nightly backup whose log went quiet for two days and a failed run', async () => {
    const log = (name: string) => `${INSTANCE_DIR}/logs/${name}`;
    const report = await collectLaunchdServices(
      probe({
        list: listOf(allLoaded()),
        print: {
          'com.example.fixture-nightly-archive': 'last exit code = 1\nruns = 3',
        },
        mtimes: { [log('nightly-copy.log')]: NOW - 3 * 86_400_000 },
      }),
    );
    expect(report.problems.map((s) => [s.id, s.detail])).toEqual([
      ['nightly-copy', 'давно не отчитывалась'],
      [
        'nightly-archive',
        'последний запуск с ошибкой, код 1, отчёт 60 с назад',
      ],
    ]);
  });

  it('asks launchd about the main label the caller resolved', async () => {
    const mainLabel = 'com.skoobi.team_1';
    const rows = allLoaded().map(
      ([pid, status, label]): [string, string, string] => [
        pid,
        status,
        label === 'com.example.fixture-main' ? mainLabel : label,
      ],
    );
    const asked: string[] = [];
    const deps = probe({
      list: listOf(rows),
      installed: rows.map(([, , label]) => label),
      print: { [mainLabel]: 'last exit code = 2\nruns = 5' },
    });
    const report = await collectLaunchdServices({
      ...deps,
      mainLabel,
      launchctl: async (args) => {
        asked.push(args.join(' '));
        return deps.launchctl!(args);
      },
    });
    expect(asked).toContain(`print gui/501/${mainLabel}`);
    expect(asked).not.toContain('print gui/501/com.example.fixture-main');
    expect(report.services[0]).toMatchObject({
      id: 'main',
      name: 'Основная служба',
      state: 'warn',
      lastExitCode: 2,
      runs: 5,
      detail: 'работает, прошлый выход с кодом 2',
    });
    expect(report.problems.map((s) => s.id)).toEqual(['main']);

    // Without it the profile's label is asked, and the job that runs under
    // another label looks absent.
    const unresolved = await collectLaunchdServices(deps);
    expect(unresolved.services[0]).toMatchObject({ id: 'main', state: 'off' });
  });

  it('does not judge services off macOS or when launchctl fails', async () => {
    await expect(
      collectLaunchdServices({ platform: 'linux' }),
    ).resolves.toEqual({ checked: false, services: [], problems: [] });
    await expect(
      collectLaunchdServices({
        ...probe({ list: '' }),
        launchctl: async () => {
          throw new Error('launchctl gone');
        },
      }),
    ).resolves.toEqual({ checked: false, services: [], problems: [] });
  });
});
