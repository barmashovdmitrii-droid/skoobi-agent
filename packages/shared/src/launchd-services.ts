/**
 * Health of this Mac's Skoobi launchd jobs — one source for the local panel
 * (packages/dashboard) and the Telegram /status command (M-C48).
 *
 * Read-only: `launchctl list`, `launchctl print-disabled`, `launchctl print`
 * and log mtimes. Nothing is started, stopped or written.
 *
 * Three states count as a problem: a daemon that is down or stopped, a
 * periodic job whose last run failed or whose log went quiet for two periods,
 * and a job whose plist is installed but which launchd does not have loaded.
 * Two states are deliberately NOT problems and come back as `off`:
 *   - the owner switched the job off (`launchctl disable`, e.g. an optional
 *     bot);
 *   - the job is not installed on this machine at all (a clean copy on
 *     another Mac or on Linux has a different set of jobs).
 * Painting those red was the panel's false alarm.
 *
 * Which jobs exist is a property of the installation, so the list is not
 * written here: it comes from the instance profile (launchd.units in
 * config/instance.json, see instance-profile.ts). Without a profile the list
 * is the main service and the local panel. Monitors belong in the list too:
 * a watchdog that dies is worse than no watchdog, because it keeps the
 * reassuring green row it painted while alive and nothing else looks at it.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';

import { readEnvFile } from './env.js';
import {
  NEUTRAL_INSTANCE_PROFILE,
  instanceProfile,
} from './instance-profile.js';

// The label of the main service when SKOOBI_SERVICE_LABEL is not set comes
// from the instance profile (launchd.mainLabel): com.skoobi.default unless
// the installation says otherwise. An installation that predates the setting
// names its own label there and keeps working unchanged, so that label is
// accepted as it is; the installer writes the setting explicitly.
const DASHBOARD_SERVICE_LABEL = 'com.skoobi.dashboard';
const MAIN_SERVICE_LABEL_PATTERN = /^com\.skoobi\.[A-Za-z0-9_-]{1,63}$/u;

export function validateMainServiceLabel(
  configured: string | undefined,
): string {
  const defaultLabel = instanceProfile().launchd.mainLabel;
  const candidate = configured?.trim() || defaultLabel;
  if (candidate === defaultLabel) return candidate;
  if (
    !MAIN_SERVICE_LABEL_PATTERN.test(candidate) ||
    candidate.toLowerCase() === DASHBOARD_SERVICE_LABEL
  ) {
    throw new Error('Invalid SKOOBI_SERVICE_LABEL');
  }
  return candidate;
}

/**
 * The launchd label the main service of this installation runs under: the
 * process environment, then the instance .env, then the instance profile.
 * Throws when the configured label is not one the installer could have
 * written. The panel's restart button uses it as it is; the job lists (the
 * panel and the Telegram /status command) go through
 * listedMainServiceLabel().
 */
export function resolveMainServiceLabel(): string {
  const fileEnv = readEnvFile(['SKOOBI_SERVICE_LABEL']);
  return validateMainServiceLabel(
    process.env.SKOOBI_SERVICE_LABEL ?? fileEnv.SKOOBI_SERVICE_LABEL,
  );
}

/**
 * The label a job list asks launchd about for the main service, or undefined
 * when the list keeps the label its unit has in the instance profile.
 *
 * A profile that gives the unit `main` a label of its own belongs to an
 * installation that predates SKOOBI_SERVICE_LABEL: its lists always asked
 * about that label and never read the setting, and they still do not.
 * Without such a profile the unit carries the placeholder label and the list
 * follows the resolved one, like the restart button. Throws when the resolved
 * label is not one the installer could have written.
 */
export function listedMainServiceLabel(): string | undefined {
  const main = instanceProfile().launchd.units.find(
    (unit) => unit.id === 'main',
  );
  if (!main || main.label !== NEUTRAL_INSTANCE_PROFILE.launchd.mainLabel) {
    return undefined;
  }
  return resolveMainServiceLabel();
}

export type LaunchdServiceState = 'ok' | 'warn' | 'down' | 'off';

export type ServiceStatus = {
  id: string;
  name: string;
  state: LaunchdServiceState;
  detail: string;
  /** Last exit code from `launchctl print`; null when unknown/never exited. */
  lastExitCode?: number | null;
  /** How many times launchd has (re)started the job since it was loaded. */
  runs?: number | null;
  /** Age of the heartbeat log in seconds, when the unit declares one. */
  heartbeatAgeSec?: number | null;
  /** True when a periodic job has not written its log for 2+ periods. */
  stale?: boolean;
};

/**
 * `daemon`   — KeepAlive, expected to hold a pid forever. pid '-' is a problem.
 * `periodic` — StartInterval/StartCalendarInterval. pid '-' is the NORMAL idle
 *              state between runs; only a bad exit code or a stale heartbeat
 *              means anything. Treating these two kinds alike is why a naive
 *              list would show every cron-ish job as permanently "stopped".
 */
export type LaunchdKind = 'daemon' | 'periodic';

export type LaunchdUnit = {
  id: string;
  name: string;
  label: string;
  kind: LaunchdKind;
  /** Nominal period in seconds; drives the staleness threshold (2 periods). */
  periodSec?: number;
  /**
   * Log that this job appends to on EVERY run, used as a liveness heartbeat.
   *
   * Deliberately absent for jobs that are silent on a no-op run — a job that
   * rotates logs only prints when it actually rotates one, so its mtime sits
   * months in the past while the job is perfectly healthy. Checking freshness
   * there would manufacture a permanent false alarm, which is worse than no
   * check.
   */
  heartbeatLog?: string;
};

/** HOME, else the home the instance profile names, else what the system says. */
function defaultHome(): string {
  return (
    process.env.HOME || instanceProfile().launchd.fallbackHome || os.homedir()
  );
}

const HOME_PLACEHOLDER = /\{home\}/g;
const PATH_PLACEHOLDER = /\{(home|instance|watchdog)\}/g;

type PathDirectories = Record<'home' | 'instance' | 'watchdog', string>;

/**
 * A heartbeat log path with its placeholders filled in. A log under a
 * directory this installation does not configure (`{instance}` or
 * `{watchdog}` with an empty value) is no log at all: the job is then judged
 * like one that declares none.
 */
function expandLogPath(
  template: string,
  directories: PathDirectories,
): string | undefined {
  let unconfigured = false;
  const expanded = template.replace(
    PATH_PLACEHOLDER,
    (_placeholder, name: keyof PathDirectories) => {
      if (name !== 'home' && !directories[name]) unconfigured = true;
      return directories[name];
    },
  );
  return unconfigured ? undefined : expanded;
}

/**
 * The jobs of this installation in display order: launchd.units of the
 * instance profile. In a heartbeat log path `{home}` is the home directory,
 * `{instance}` is launchd.instanceDir and `{watchdog}` is the watchdog
 * directory (the argument, else SKOOBI_WATCHDOG_DIR, else
 * launchd.watchdogDir).
 *
 * `mainLabel` is the launchd label of the main service (the unit with id
 * `main`) when the caller has one for it (listedMainServiceLabel()); without
 * it the unit keeps the label the profile gives.
 */
export function launchdUnits(
  home: string = defaultHome(),
  watchdogDir: string = process.env.SKOOBI_WATCHDOG_DIR ||
    instanceProfile().launchd.watchdogDir.replace(HOME_PLACEHOLDER, () => home),
  mainLabel?: string,
): LaunchdUnit[] {
  const profile = instanceProfile().launchd;
  const directories: PathDirectories = {
    home,
    instance: profile.instanceDir.replace(HOME_PLACEHOLDER, () => home),
    watchdog: watchdogDir,
  };
  return profile.units.map((unit) => {
    const heartbeatLog =
      unit.heartbeatLog === undefined
        ? undefined
        : expandLogPath(unit.heartbeatLog, directories);
    return {
      id: unit.id,
      name: unit.name,
      label: unit.id === 'main' && mainLabel ? mainLabel : unit.label,
      kind: unit.kind,
      ...(unit.periodSec === undefined ? {} : { periodSec: unit.periodSec }),
      ...(heartbeatLog === undefined ? {} : { heartbeatLog }),
    };
  });
}

/** `launchctl list` rows: "<PID|->\t<last exit status>\t<label>". */
export function parseLaunchctlList(
  out: string,
): Map<string, { pid: string; status: string }> {
  const rows = new Map<string, { pid: string; status: string }>();
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)$/);
    if (m) rows.set(m[3], { pid: m[1], status: m[2] });
  }
  return rows;
}

/** Labels `launchctl print-disabled gui/<uid>` lists as `"label" => disabled`. */
export function parseDisabledLabels(out: string): Set<string> {
  const labels = new Set<string>();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*"([^"]+)"\s*=>\s*(disabled|true)\s*$/);
    if (m) labels.add(m[1]);
  }
  return labels;
}

/** `launchctl print gui/<uid>/<label>`: last exit code and restart count. */
export function parseLaunchdDetail(out: string): {
  lastExitCode: number | null;
  runs: number | null;
} {
  const exitMatch = out.match(/last exit code\s*=\s*(-?\d+)/i);
  const runsMatch = out.match(/^\s*runs\s*=\s*(\d+)/im);
  return {
    lastExitCode: exitMatch ? Number(exitMatch[1]) : null,
    runs: runsMatch ? Number(runsMatch[1]) : null,
  };
}

function formatAge(sec: number): string {
  if (sec < 90) return `${Math.round(sec)} с`;
  if (sec < 5400) return `${Math.round(sec / 60)} мин`;
  if (sec < 172800) return `${Math.round(sec / 3600)} ч`;
  return `${Math.round(sec / 86400)} дн`;
}

export interface ClassifyInput {
  row?: { pid: string; status: string };
  lastExitCode: number | null;
  runs: number | null;
  disabled: boolean;
  installed: boolean;
  heartbeatAgeSec: number | null;
}

/** Pure verdict for one unit. */
export function classifyLaunchdUnit(
  unit: LaunchdUnit,
  input: ClassifyInput,
): ServiceStatus {
  const { row, lastExitCode, runs } = input;
  if (!row) {
    const base = {
      id: unit.id,
      name: unit.name,
      lastExitCode,
      runs,
      heartbeatAgeSec: null,
      stale: false,
    };
    if (input.disabled) {
      return { ...base, state: 'off', detail: 'выключена намеренно' };
    }
    if (!input.installed) {
      return { ...base, state: 'off', detail: 'не установлена на этом компьютере' };
    }
    return { ...base, state: 'down', detail: 'служба не загружена' };
  }

  const ageSec = unit.heartbeatLog ? input.heartbeatAgeSec : null;
  const staleLimit = unit.periodSec ? unit.periodSec * 2 : null;
  const stale =
    ageSec !== null && staleLimit !== null ? ageSec > staleLimit : false;

  const notes: string[] = [];
  let state: ServiceStatus['state'];

  if (unit.kind === 'daemon') {
    if (row.pid !== '-') {
      state = 'ok';
      notes.push('работает');
    } else {
      // A KeepAlive job with no pid is genuinely down, whatever the code.
      state = row.status === '0' ? 'warn' : 'down';
      notes.push(
        row.status === '0'
          ? 'остановлена (без ошибки)'
          : `остановлена, код ${row.status}`,
      );
    }
  } else {
    // Periodic: idle between runs is the healthy steady state.
    if (row.pid !== '-') {
      state = 'ok';
      notes.push('выполняется сейчас');
    } else if (lastExitCode !== null && lastExitCode !== 0) {
      state = 'warn';
      notes.push(`последний запуск с ошибкой, код ${lastExitCode}`);
    } else if (stale) {
      state = 'warn';
      notes.push('давно не отчитывалась');
    } else {
      state = 'ok';
      notes.push('ждёт следующего запуска');
    }
  }

  // Surface a bad exit code even on a currently-running daemon: that is the
  // crash-loop signal the old two-unit collector could not show at all.
  if (unit.kind === 'daemon' && lastExitCode !== null && lastExitCode !== 0) {
    notes.push(`прошлый выход с кодом ${lastExitCode}`);
    if (state === 'ok') state = 'warn';
  }
  if (stale && ageSec !== null && !notes.some((n) => n.includes('давно'))) {
    notes.push(`лог молчит ${formatAge(ageSec)}`);
    if (state === 'ok') state = 'warn';
  } else if (ageSec !== null && !stale) {
    notes.push(`отчёт ${formatAge(ageSec)} назад`);
  }

  return {
    id: unit.id,
    name: unit.name,
    state,
    detail: notes.join(', '),
    lastExitCode,
    runs,
    heartbeatAgeSec: ageSec === null ? null : Math.round(ageSec),
    stale,
  };
}

export function isServiceProblem(service: ServiceStatus): boolean {
  return service.state === 'warn' || service.state === 'down';
}

export interface LaunchdServicesReport {
  /** False when launchd could not be asked (not macOS, launchctl failed). */
  checked: boolean;
  services: ServiceStatus[];
  problems: ServiceStatus[];
}

export interface LaunchdProbeDeps {
  platform?: string;
  home?: string;
  uid?: number;
  /**
   * launchd label of the main service (the unit with id `main`) when the
   * caller has resolved it from SKOOBI_SERVICE_LABEL. Absent: the label the
   * instance profile gives that unit.
   */
  mainLabel?: string;
  /** Runs `launchctl <args>` and resolves with stdout. */
  launchctl?: (args: string[]) => Promise<string>;
  /** Log mtime in ms, or null when missing. */
  mtimeMs?: (file: string) => number | null;
  exists?: (file: string) => boolean;
  now?: () => number;
}

function runLaunchctl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'launchctl',
      args,
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout ?? ''));
      },
    );
  });
}

function fileMtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export async function collectLaunchdServices(
  deps: LaunchdProbeDeps = {},
): Promise<LaunchdServicesReport> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') {
    return { checked: false, services: [], problems: [] };
  }
  const home = deps.home ?? defaultHome();
  const uid =
    deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const launchctl = deps.launchctl ?? runLaunchctl;
  const mtimeMs = deps.mtimeMs ?? fileMtimeMs;
  const exists = deps.exists ?? ((file: string) => fs.existsSync(file));
  const now = deps.now ?? Date.now;
  const units = launchdUnits(home, undefined, deps.mainLabel);

  let listOut: string;
  try {
    listOut = await launchctl(['list']);
  } catch {
    return { checked: false, services: [], problems: [] };
  }
  const rows = parseLaunchctlList(listOut);
  let disabled = new Set<string>();
  try {
    disabled = parseDisabledLabels(
      await launchctl(['print-disabled', `gui/${uid}`]),
    );
  } catch {
    // Unknown: an unloaded job then counts as a problem, the safe reading.
  }

  // One `launchctl print` per unit, concurrently, so the panel's
  // /api/overview does not serialise a process spawn per row.
  const details = new Map<string, { lastExitCode: number | null; runs: number | null }>();
  await Promise.all(
    units.map(async (unit) => {
      try {
        details.set(
          unit.label,
          parseLaunchdDetail(
            await launchctl(['print', `gui/${uid}/${unit.label}`]),
          ),
        );
      } catch {
        // Not loaded, or launchctl refused — `list` already says so.
        details.set(unit.label, { lastExitCode: null, runs: null });
      }
    }),
  );

  const services = units.map((unit) => {
    const detail = details.get(unit.label) ?? { lastExitCode: null, runs: null };
    const mtime = unit.heartbeatLog ? mtimeMs(unit.heartbeatLog) : null;
    return classifyLaunchdUnit(unit, {
      row: rows.get(unit.label),
      lastExitCode: detail.lastExitCode,
      runs: detail.runs,
      disabled: disabled.has(unit.label),
      installed: exists(`${home}/Library/LaunchAgents/${unit.label}.plist`),
      heartbeatAgeSec: mtime === null ? null : (now() - mtime) / 1000,
    });
  });
  return { checked: true, services, problems: services.filter(isServiceProblem) };
}
