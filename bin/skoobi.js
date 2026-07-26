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
  doctor      Check runtime, Telegram, owner, and provider readiness
  owner       Initialize the first Telegram owner
  logs        Print recent service logs
  start       Start the default instance service
  stop        Stop the default instance service
  restart     Restart the default instance service
  update      Run scripts/update.sh
  uninstall   Run scripts/uninstall.sh
  paths       Show app, instance, config, logs, and DB paths
  version     Show CLI version

Owner setup:
  skoobi owner init <numeric-id-or-tg:chat-id>
  Send /chatid to the bot, copy the private chat ID, then run this command.

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
  const expandedPrefix = opts.prefix.replace(/^~(?=$|\/)/, os.homedir());
  const prefix = path.resolve(expandedPrefix);
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
    timeout: options.timeout,
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

async function doctor(paths) {
  let failures = 0;
  const checks = [
    ['node', ['--version']],
    ['npm', ['--version']],
    ['git', ['--version']],
    ['sqlite3', ['--version']],
    ['curl', ['--version']],
    ['rg', ['--version']],
  ];
  if (process.platform === 'linux') {
    checks.push(['bwrap', ['--version']], ['socat', ['-V']]);
  }
  for (const [cmd, args] of checks) {
    const result = run(cmd, args, { capture: true, timeout: 5000 });
    const firstLine = (result.stdout || result.stderr || '').split(/\r?\n/)[0];
    let ok = result.status === 0;
    if (cmd === 'node' && ok) {
      const major = Number(/^v?(\d+)/.exec(firstLine)?.[1] || 0);
      ok = major >= 22;
    }
    if (!ok) failures += 1;
    console.log(`${cmd}: ${ok ? 'ok' : 'problem'} ${firstLine}`.trimEnd());
  }

  let inspection;
  try {
    const { inspectTelegramOwner } = await import('./owner-bootstrap.js');
    inspection = inspectTelegramOwner(paths);
    console.log(
      `telegram token: ${inspection.tokenConfigured ? 'ok' : 'problem'}`,
    );
    console.log(
      `telegram owner: ${inspection.ownerConfigured ? 'ok' : 'problem'}`,
    );
    if (!inspection.tokenConfigured || !inspection.ownerConfigured) {
      failures += 1;
    }
  } catch (err) {
    failures += 1;
    console.log(
      `telegram owner: problem (${err instanceof Error ? err.message : 'state unavailable'})`,
    );
  }

  const codexRequired =
    inspection?.gatewayType === 'codex_subscription_cli' ||
    inspection?.ownerCodexConfigured === true;
  if (codexRequired) {
    const codexCommand = inspection?.codexCommand || 'codex';
    const codex = run(codexCommand, ['--version'], {
      capture: true,
      timeout: 5000,
    });
    const codexVersion = (codex.stdout || codex.stderr || '')
      .split(/\r?\n/)[0]
      .trim();
    if (codex.status !== 0) {
      failures += 1;
      console.log('codex: problem');
    } else {
      console.log(`codex: ok ${codexVersion}`.trimEnd());
      const login = run(codexCommand, ['login', 'status'], {
        capture: true,
        timeout: 10000,
      });
      const authenticated = login.status === 0;
      if (!authenticated) failures += 1;
      console.log(`codex login: ${authenticated ? 'ok' : 'problem'}`);
    }
    const routeReady = inspection?.ownerCodexConfigured === true;
    if (!routeReady) failures += 1;
    console.log(`owner Codex route: ${routeReady ? 'ok' : 'problem'}`);
  } else if (inspection?.gatewayType === 'openai_compatible') {
    const configured = inspection.gatewayKeyConfigured === true;
    if (!configured) failures += 1;
    console.log(
      `openai-compatible provider key: ${configured ? 'ok' : 'problem'}`,
    );
  } else if (inspection?.gatewayType === 'disabled') {
    if (inspection.anthropicAuthConfigured === true) {
      console.log('claude credentials: ok');
    } else {
      const claude = run('claude', ['--version'], {
        capture: true,
        timeout: 5000,
      });
      const claudeVersion = (claude.stdout || claude.stderr || '')
        .split(/\r?\n/)[0]
        .trim();
      if (claude.status !== 0) {
        failures += 1;
        console.log('claude: problem');
      } else {
        console.log(`claude: ok ${claudeVersion}`.trimEnd());
        const auth = run('claude', ['auth', 'status'], {
          capture: true,
          timeout: 10000,
        });
        const authenticated = auth.status === 0;
        if (!authenticated) failures += 1;
        console.log(`claude auth: ${authenticated ? 'ok' : 'problem'}`);
      }
    }
  } else if (inspection) {
    failures += 1;
    console.log('provider: problem (unsupported gateway type)');
  }
  console.log(`appDir: ${paths.appDir}`);
  console.log(`instanceDir: ${paths.instanceDir}`);
  console.log(`overall: ${failures === 0 ? 'ready' : 'needs attention'}`);
  if (failures > 0) process.exitCode = 1;
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
      await doctor(paths);
      break;
    case 'owner': {
      if (opts.passthrough.length !== 2 || opts.passthrough[0] !== 'init') {
        throw new Error('Usage: skoobi owner init <numeric-id-or-tg:chat-id>');
      }
      const { initializeTelegramOwner } = await import('./owner-bootstrap.js');
      const result = initializeTelegramOwner(paths, opts.passthrough[1]);
      console.log(
        result.created
          ? 'Telegram owner initialized.'
          : 'Telegram owner was already initialized.',
      );
      console.log(`Registration: ${result.jid}`);
      console.log('Run: skoobi restart');
      break;
    }
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
