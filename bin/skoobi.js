#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoAppDir = path.resolve(path.dirname(__filename), '..');

function packageVersion() {
  try {
    const raw = fs.readFileSync(path.join(repoAppDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function usage() {
  console.log(`Skoobi CLI

Usage:
  skoobi <command> [options]

Commands:
  status      Show service and path status
  doctor      Check local requirements
  logs        Print recent service logs
  start       Start the default instance service
  stop        Stop the default instance service
  restart     Restart the default instance service
  update      Run scripts/update.sh
  uninstall   Run scripts/uninstall.sh
  paths       Show app, instance, config, logs, and DB paths
  version     Show CLI version

Options:
  --prefix <path>      Install prefix (default: ~/.skoobi)
  --instance <name>    Instance name (default: default)
  --version            Show CLI version
  --help               Show help

No command prints secrets or reads auth files.`);
}

function parseArgs(argv) {
  const out = {
    command: '',
    prefix: process.env.SKOOBI_PREFIX || path.join(os.homedir(), '.skoobi'),
    instance: process.env.SKOOBI_INSTANCE || 'default',
    passthrough: [],
  };
  const args = [...argv];
  out.command = args.shift() || 'help';
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--prefix') out.prefix = args.shift() || '';
    else if (arg === '--instance') out.instance = args.shift() || '';
    else out.passthrough.push(arg);
  }
  if (!out.prefix) throw new Error('--prefix requires a path');
  if (!/^[A-Za-z0-9_-]+$/.test(out.instance)) {
    throw new Error('--instance must contain only letters, digits, _ or -');
  }
  return out;
}

function pathsFor(opts) {
  const prefix = opts.prefix.replace(/^~(?=$|\/)/, os.homedir());
  const installedAppDir = path.join(prefix, 'app', 'skoobi-agent');
  const appDir =
    process.env.SKOOBI_APP_DIR ||
    (fs.existsSync(path.join(installedAppDir, 'scripts')) ? installedAppDir : repoAppDir);
  const instanceDir = path.join(prefix, 'instances', opts.instance);
  return {
    prefix,
    appDir,
    instanceDir,
    envFile: path.join(instanceDir, '.env'),
    dbFile: path.join(instanceDir, 'store', 'messages.db'),
    logsDir: path.join(instanceDir, 'logs'),
    serviceLabel: `com.skoobi.${opts.instance}`,
    systemdUnit: `skoobi-${opts.instance}`,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: process.env,
  });
  if (options.capture) return result;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

function isMac() {
  return process.platform === 'darwin';
}

function printPaths(paths) {
  console.log(JSON.stringify(paths, null, 2));
}

function serviceAction(action, paths) {
  if (isMac()) {
    const target = `gui/${process.getuid()}/${paths.serviceLabel}`;
    if (action === 'start' || action === 'restart') {
      run('launchctl', ['kickstart', '-k', target]);
    } else if (action === 'stop') {
      run('launchctl', ['kill', 'TERM', target]);
    } else {
      const result = run('launchctl', ['print', target], { capture: true });
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      process.exit(result.status ?? 0);
    }
    return;
  }

  const unit = paths.systemdUnit;
  if (action === 'start') run('systemctl', ['--user', 'start', unit]);
  else if (action === 'stop') run('systemctl', ['--user', 'stop', unit]);
  else if (action === 'restart') run('systemctl', ['--user', 'restart', unit]);
  else run('systemctl', ['--user', 'status', unit, '--no-pager']);
}

function doctor(paths) {
  const checks = [
    ['node', ['--version']],
    ['npm', ['--version']],
    ['git', ['--version']],
    ['sqlite3', ['--version']],
    ['curl', ['--version']],
  ];
  for (const [cmd, args] of checks) {
    const result = run(cmd, args, { capture: true });
    const firstLine = (result.stdout || result.stderr || '').split(/\r?\n/)[0];
    console.log(`${cmd}: ${result.status === 0 ? 'ok' : 'missing'} ${firstLine}`);
  }
  const codex = run('codex', ['--version'], { capture: true });
  console.log(`codex: ${codex.status === 0 ? 'ok' : 'optional-missing'} ${(codex.stdout || '').trim()}`);
  const claude = run('claude', ['--version'], { capture: true });
  console.log(`claude: ${claude.status === 0 ? 'ok' : 'optional-missing'} ${(claude.stdout || claude.stderr || '').trim()}`);
  console.log(`appDir: ${paths.appDir}`);
  console.log(`instanceDir: ${paths.instanceDir}`);
}

function logs(paths) {
  const files = [
    path.join(paths.logsDir, 'service.out.log'),
    path.join(paths.logsDir, 'service.err.log'),
    path.join(paths.logsDir, 'service.out.log'),
    path.join(paths.logsDir, 'service.err.log'),
  ].filter((file) => fs.existsSync(file));
  if (files.length === 0) {
    console.log(`No log files found in ${paths.logsDir}`);
    return;
  }
  for (const file of files) {
    console.log(`\n==> ${file} <==`);
    const result = run('tail', ['-n', '80', file], { capture: true });
    process.stdout.write(result.stdout || '');
  }
}

function scriptCommand(name, opts, paths) {
  const script = path.join(paths.appDir, 'scripts', `${name}.sh`);
  if (!fs.existsSync(script)) throw new Error(`Script not found: ${script}`);
  run('bash', [
    script,
    '--prefix',
    paths.prefix,
    '--instance',
    opts.instance,
    ...opts.passthrough,
  ]);
}

try {
  if (process.argv.includes('--version') || process.argv.includes('-V')) {
    console.log(`skoobi ${packageVersion()}`);
    process.exit(0);
  }
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === 'help' || opts.command === '--help' || opts.command === '-h') {
    usage();
    process.exit(0);
  }
  const paths = pathsFor(opts);
  switch (opts.command) {
    case 'paths':
      printPaths(paths);
      break;
    case 'version':
      console.log(`skoobi ${packageVersion()}`);
      break;
    case 'status':
      serviceAction('status', paths);
      break;
    case 'doctor':
      doctor(paths);
      break;
    case 'logs':
      logs(paths);
      break;
    case 'start':
    case 'stop':
    case 'restart':
      serviceAction(opts.command, paths);
      break;
    case 'update':
      scriptCommand('update', opts, paths);
      break;
    case 'uninstall':
      scriptCommand('uninstall', opts, paths);
      break;
    default:
      throw new Error(`Unknown command: ${opts.command}`);
  }
} catch (err) {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  usage();
  process.exit(1);
}
