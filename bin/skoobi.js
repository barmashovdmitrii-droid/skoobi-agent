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
  if (out.instance.length > 63) {
    throw new Error('--instance must be at most 63 characters');
  }
  if (out.instance.toLowerCase() === 'dashboard') {
    throw new Error("--instance name 'dashboard' is reserved");
  }
  return out;
}

function pathsFor(opts) {
  const prefix = opts.prefix.replace(/^~(?=$|\/)/, os.homedir());
  const installedAppDir = path.join(prefix, 'app', 'skoobi-agent');
  const markerFile = path.join(prefix, '.skoobi-managed-install');
  const canonicalRepo =
    'https://github.com/barmashovdmitrii-droid/skoobi-agent.git';
  const markerFor = (appName) =>
    `format=1\nrepository=${canonicalRepo}\napp=${appName}\n`;
  const isRealDirectory = (dir) => {
    const stat = fs.lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  };
  const isSafeManagedCandidate = (appDir, marker, expectedMarkers) => {
    if (!expectedMarkers.includes(marker)) return false;
    if (!isRealDirectory(appDir)) return false;
    if (!isRealDirectory(path.join(appDir, '.git'))) return false;
    if (!isRealDirectory(path.join(appDir, 'scripts'))) return false;
    for (const name of ['update.sh', 'uninstall.sh']) {
      const stat = fs.lstatSync(path.join(appDir, 'scripts', name));
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
    }
    return true;
  };
  let managedAppDir = repoAppDir;
  try {
    const markerStat = fs.lstatSync(markerFile);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw new Error('managed-install marker is not a regular file');
    }
    const marker = fs.readFileSync(markerFile, 'utf8');
    if (
      isSafeManagedCandidate(installedAppDir, marker, [
        markerFor('skoobi-agent'),
      ])
    ) {
      managedAppDir = installedAppDir;
    }
  } catch {
    // A CLI executed directly from a source checkout may still operate on that
    // checkout. Update/uninstall independently require canonical origin and a
    // verified marker before changing managed files.
  }
  const appDir = managedAppDir;
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
    launchdPlist: path.join(
      os.homedir(),
      'Library',
      'LaunchAgents',
      `com.skoobi.${opts.instance}.plist`,
    ),
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
      const enabled = run('launchctl', ['enable', target], { capture: true });
      if (enabled.status !== 0) {
        throw new Error('launchd service could not be enabled');
      }
      const loaded = run('launchctl', ['print', target], { capture: true });
      if (loaded.status !== 0) {
        const bootstrapped = run(
          'launchctl',
          ['bootstrap', `gui/${process.getuid()}`, paths.launchdPlist],
          { capture: true },
        );
        if (bootstrapped.status !== 0) {
          throw new Error('launchd service could not be loaded');
        }
      }
      run('launchctl', ['kickstart', '-k', target]);
    } else if (action === 'stop') {
      const disabled = run('launchctl', ['disable', target], { capture: true });
      if (disabled.status !== 0) {
        throw new Error('launchd KeepAlive could not be disabled');
      }
      run('launchctl', ['bootout', target], { capture: true });
      const stillLoaded = run('launchctl', ['print', target], {
        capture: true,
      });
      if (stillLoaded.status === 0) {
        throw new Error('launchd service is still loaded after stop');
      }
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
  else if (action === 'stop') {
    run('systemctl', ['--user', 'stop', unit]);
    const active = run('systemctl', ['--user', 'is-active', '--quiet', unit], {
      capture: true,
    });
    if (active.status === 0) {
      throw new Error('systemd service is still active after stop');
    }
    if (active.status !== 3 && active.status !== 4) {
      throw new Error('systemd could not prove the service stopped');
    }
  } else if (action === 'restart')
    run('systemctl', ['--user', 'restart', unit]);
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
    console.log(
      `${cmd}: ${result.status === 0 ? 'ok' : 'missing'} ${firstLine}`,
    );
  }
  const codex = run('codex', ['--version'], { capture: true });
  console.log(
    `codex: ${codex.status === 0 ? 'ok' : 'optional-missing'} ${(codex.stdout || '').trim()}`,
  );
  const claude = run('claude', ['--version'], { capture: true });
  console.log(
    `claude: ${claude.status === 0 ? 'ok' : 'optional-missing'} ${(claude.stdout || claude.stderr || '').trim()}`,
  );
  console.log(`appDir: ${paths.appDir}`);
  console.log(`instanceDir: ${paths.instanceDir}`);
}

function logs(paths) {
  const pathChain = [
    paths.prefix,
    path.join(paths.prefix, 'instances'),
    paths.instanceDir,
    paths.logsDir,
  ];
  try {
    for (const dir of pathChain) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('unsafe log directory');
      }
    }
  } catch {
    console.log('No safe log files found.');
    return;
  }
  const candidates = [
    path.join(paths.logsDir, 'service.out.log'),
    path.join(paths.logsDir, 'service.err.log'),
    path.join(paths.logsDir, 'claudeclaw.log'),
    path.join(paths.logsDir, 'claudeclaw.error.log'),
  ];
  const files = [];
  for (const file of candidates) {
    let fd;
    try {
      fd = fs.openSync(
        file,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
      const before = fs.fstatSync(fd);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        (typeof process.getuid === 'function' &&
          before.uid !== process.getuid())
      ) {
        continue;
      }
      const maxTailBytes = 256 * 1024;
      const length = Math.min(before.size, maxTailBytes);
      const buffer = Buffer.alloc(length);
      const offset = before.size - length;
      const bytesRead =
        length === 0 ? 0 : fs.readSync(fd, buffer, 0, length, offset);
      const after = fs.fstatSync(fd);
      if (
        bytesRead !== length ||
        !after.isFile() ||
        after.nlink !== 1 ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.uid !== before.uid ||
        after.gid !== before.gid ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      ) {
        continue;
      }
      files.push({ file, text: buffer.toString('utf8') });
    } catch {
      // Missing, symlinked, special, or concurrently replaced logs are skipped.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  if (files.length === 0) {
    console.log('No safe log files found.');
    return;
  }
  for (const { file, text } of files) {
    console.log(`\n==> ${file} <==`);
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    process.stdout.write(`${lines.slice(-80).join('\n')}\n`);
  }
}

function scriptCommand(name, opts, paths) {
  const appStat = fs.lstatSync(repoAppDir);
  const scriptsDir = path.join(repoAppDir, 'scripts');
  const script = path.join(scriptsDir, `${name}.sh`);
  const scriptsStat = fs.lstatSync(scriptsDir);
  const scriptStat = fs.lstatSync(script);
  if (
    !appStat.isDirectory() ||
    appStat.isSymbolicLink() ||
    !scriptsStat.isDirectory() ||
    scriptsStat.isSymbolicLink() ||
    !scriptStat.isFile() ||
    scriptStat.isSymbolicLink()
  ) {
    throw new Error('Managed lifecycle script is not a safe regular file');
  }
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
  if (
    opts.command === 'help' ||
    opts.command === '--help' ||
    opts.command === '-h'
  ) {
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
