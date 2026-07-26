import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '@skoobi/shared/env';
import Database from 'better-sqlite3';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const canonicalRepo =
  'https://github.com/barmashovdmitrii-droid/skoobi-agent.git';
const realGit = execFileSync('which', ['git'], {
  encoding: 'utf8',
}).trim();
if (process.platform === 'linux') {
  const serviceFallbackBin = fs.mkdtempSync(
    path.join(os.tmpdir(), 'skoobi-test-service-bin-'),
  );
  fs.writeFileSync(
    path.join(serviceFallbackBin, 'systemctl'),
    `#!/usr/bin/env bash
case "\${2:-}" in
  is-active) exit 4 ;;
  is-enabled) printf 'disabled\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${serviceFallbackBin}:${process.env.PATH || ''}`;
}

function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): string {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `/opt/homebrew/opt/node@22/bin:${process.env.PATH || ''}`,
      ...options.env,
    },
  });
}

function runResult(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string } = {},
) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    input: options.input,
    env: {
      ...process.env,
      PATH: `/opt/homebrew/opt/node@22/bin:${process.env.PATH || ''}`,
      ...options.env,
    },
  });
}

function tempDir(label = 'skoobi-installer-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  }).trim();
}

function initRepo(dir: string): void {
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Skoobi Installer Test']);
  git(dir, ['config', 'user.email', 'installer@example.invalid']);
}

function buildCommand(content = 'export {}\\n'): string {
  const encoded = Buffer.from(content).toString('base64');
  return `node -e "const f=require('node:fs');f.mkdirSync('dist',{recursive:true});f.writeFileSync('dist/service.js',Buffer.from('${encoded}','base64'))"`;
}

function writeFixturePackage(
  dir: string,
  build = buildCommand(),
  extraIgnore = '',
): void {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'skoobi-installer-fixture',
        version: '1.0.0',
        private: true,
        scripts: { build },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'skoobi-installer-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: 'skoobi-installer-fixture',
            version: '1.0.0',
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(dir, '.gitignore'),
    `node_modules/\ndist/\n${extraIgnore}`,
  );
}

function createRemote(
  options: { build?: string; extraIgnore?: string; tracked?: string } = {},
): string {
  const remote = tempDir();
  initRepo(remote);
  writeFixturePackage(
    remote,
    options.build,
    options.extraIgnore ?? '*.owner-secret\n',
  );
  fs.writeFileSync(
    path.join(remote, 'tracked.txt'),
    options.tracked ?? 'old\n',
  );
  git(remote, ['add', '.']);
  git(remote, ['commit', '-m', 'fixture']);
  return remote;
}

function transportEnv(
  remote: string,
  home: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const transportBin = tempDir('skoobi-git-transport-');
  const gitWrapper = path.join(transportBin, 'git');
  fs.writeFileSync(
    gitWrapper,
    `#!/usr/bin/env bash
set -eu
for forbidden in GIT_CONFIG_PARAMETERS GIT_TEMPLATE_DIR SKOOBI_TELEGRAM_BOT_TOKEN SKOOBI_MODEL_GATEWAY_KEY SKOOBI_MODEL_GATEWAY_BASE_URL; do
  value="\${!forbidden-}"
  if [[ -n "$value" ]]; then
    printf 'forbidden inherited git environment: %s\\n' "$forbidden" >&2
    exit 97
  fi
done
args=("$@")
rewrite=0
for arg in "\${args[@]}"; do
  [[ "$arg" == "ls-remote" || "$arg" == "fetch" ]] && rewrite=1
done
if [[ "$rewrite" == "1" ]]; then
  for index in "\${!args[@]}"; do
    [[ "\${args[$index]}" != "origin" ]] ||
      args[$index]=${JSON.stringify(remote)}
  done
fi
exec ${JSON.stringify(realGit)} "\${args[@]}"
`,
    { mode: 0o755 },
  );
  const requestedPath = extra.PATH ?? process.env.PATH ?? '';
  return {
    HOME: home,
    SKOOBI_INSTALLER_SKIP_REQUIREMENTS: '1',
    SKOOBI_UPDATE_REF: 'refs/heads/main',
    SKOOBI_UPDATE_EXPECTED_COMMIT: git(remote, ['rev-parse', 'HEAD']),
    ...extra,
    PATH: `${transportBin}:${requestedPath}`,
  };
}

const huskyGeneratedHooks = [
  'applypatch-msg',
  'commit-msg',
  'post-applypatch',
  'post-checkout',
  'post-commit',
  'post-merge',
  'post-rewrite',
  'pre-applypatch',
  'pre-auto-gc',
  'pre-commit',
  'pre-merge-commit',
  'pre-push',
  'pre-rebase',
  'prepare-commit-msg',
];

function createLegacyHuskyScaffold(appDir: string): void {
  const huskyPackageDir = path.join(appDir, 'node_modules', 'husky');
  const generatedDir = path.join(appDir, '.husky', '_');
  fs.mkdirSync(huskyPackageDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'node_modules', 'husky', 'husky'),
    path.join(huskyPackageDir, 'husky'),
  );
  fs.copyFileSync(
    path.join(huskyPackageDir, 'husky'),
    path.join(generatedDir, 'h'),
  );
  fs.writeFileSync(path.join(generatedDir, '.gitignore'), '*');
  for (const hook of huskyGeneratedHooks) {
    fs.writeFileSync(
      path.join(generatedDir, hook),
      '#!/usr/bin/env sh\n. "$(dirname "$0")/h"',
      { mode: 0o755 },
    );
  }
  const deprecatedShim = `echo "husky - DEPRECATED

Please remove the following two lines from $0:

#!/usr/bin/env sh
. \\"\\$(dirname -- \\"\\$0\\")/_/husky.sh\\"

They WILL FAIL in v10.0.0
"
`;
  fs.writeFileSync(
    path.join(generatedDir, 'husky.sh'),
    deprecatedShim.trimEnd(),
  );
  const binDir = path.join(appDir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync('../husky/bin.js', path.join(binDir, 'husky'));
}

function installFixture(
  remote: string,
  prefix: string,
  instance: string,
  home: string,
  extraArgs: string[] = [],
  extraEnv: NodeJS.ProcessEnv = {},
): string {
  return run(
    'bash',
    [
      'scripts/install.sh',
      '--repo',
      canonicalRepo,
      '--ref',
      'main',
      '--prefix',
      prefix,
      '--instance',
      instance,
      '--no-service',
      '--no-start',
      '--yes',
      ...extraArgs,
    ],
    { env: transportEnv(remote, home, extraEnv) },
  );
}

function writeMarker(prefix: string, app = 'skoobi-agent'): void {
  fs.writeFileSync(
    path.join(prefix, '.skoobi-managed-install'),
    `format=1\nrepository=${canonicalRepo}\napp=${app}\n`,
    { mode: 0o600 },
  );
}

function setupManagedClone(
  remote: string,
  prefix: string,
  instance: string,
): string {
  const appDir = path.join(prefix, 'app', 'skoobi-agent');
  fs.mkdirSync(path.dirname(appDir), { recursive: true });
  git(path.dirname(appDir), ['clone', remote, appDir]);
  git(appDir, ['remote', 'set-url', 'origin', canonicalRepo]);
  fs.mkdirSync(path.join(prefix, 'instances', instance), { recursive: true });
  fs.mkdirSync(path.join(prefix, 'backups'), { recursive: true });
  writeMarker(prefix);
  return appDir;
}

function makeFakeCommands(commands: Record<string, string>): {
  bin: string;
  log: string;
} {
  const root = tempDir('skoobi-fake-bin-');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls.log');
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(commands)) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/bash\nset -eu\n${body}\n`, {
      mode: 0o755,
    });
  }
  return { bin, log };
}

function createOwnerCliState(
  options: {
    token?: string;
    ownerIds?: string;
    chatIds?: string;
    mainJid?: string;
  } = {},
) {
  const prefix = tempDir('skoobi-owner-cli-');
  const instance = 'default';
  const instanceDir = path.join(prefix, 'instances', instance);
  const storeDir = path.join(instanceDir, 'store');
  const groupsDir = path.join(instanceDir, 'groups');
  for (const dir of [
    prefix,
    path.join(prefix, 'instances'),
    instanceDir,
    storeDir,
    groupsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  const envFile = path.join(instanceDir, '.env');
  fs.writeFileSync(
    envFile,
    [
      `TELEGRAM_BOT_TOKEN="${options.token ?? 'test-only-token'}"`,
      'SKOOBI_TELEGRAM_BOT_ID="telegram_default"',
      `OWNER_TELEGRAM_USER_IDS="${options.ownerIds ?? ''}"`,
      ...(options.chatIds === undefined
        ? []
        : [`OWNER_TELEGRAM_CHAT_IDS="${options.chatIds}"`]),
      'SKOOBI_MODEL_GATEWAY_TYPE="codex_subscription_cli"',
      'SKOOBI_CODEX_SUBSCRIPTION_ENABLED="true"',
      'SKOOBI_TELEGRAM_OWNER_LIVE_ENABLED="true"',
      'SKOOBI_CODEX_OWNER_FULL_AGENT_ENABLED="true"',
      'SKOOBI_CODEX_OWNER_FULL_AGENT_MODE="always"',
      'SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY="true"',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  fs.chmodSync(envFile, 0o600);
  const dbFile = path.join(storeDir, 'messages.db');
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0,
      agent_config TEXT,
      runtime TEXT
    )
  `);
  if (options.mainJid) {
    db.prepare(
      `INSERT INTO registered_groups
         (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main, runtime)
       VALUES (?, 'Existing', 'telegram_main', '@Skoobi', ?, 0, 1, 'sandbox')`,
    ).run(options.mainJid, '2026-01-01T00:00:00.000Z');
  }
  db.close();
  fs.chmodSync(dbFile, 0o600);
  return { prefix, instance, instanceDir, envFile, dbFile, groupsDir };
}

function runOwnerCli(
  state: ReturnType<typeof createOwnerCliState>,
  ownerArgument: string,
  extraArgs: string[] = [],
) {
  return runResult(
    process.execPath,
    [
      'bin/skoobi.js',
      'owner',
      'init',
      ownerArgument,
      '--prefix',
      state.prefix,
      '--instance',
      state.instance,
      ...extraArgs,
    ],
    { env: { ...process.env, HOME: tempDir('skoobi-owner-home-') } },
  );
}

function ownerRows(dbFile: string): Array<{
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  requires_trigger: number;
  is_main: number;
  runtime: string;
}> {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT jid, name, folder, trigger_pattern, added_at,
                requires_trigger, is_main, runtime
         FROM registered_groups
         ORDER BY jid`,
      )
      .all() as ReturnType<typeof ownerRows>;
  } finally {
    db.close();
  }
}

describe('Skoobi installer scripts', () => {
  it('prints help and matching installer/CLI versions', () => {
    const packageVersion = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ).version as string;
    expect(run('bash', ['scripts/install.sh', '--help'])).toContain(
      'Skoobi installer',
    );
    expect(run('bash', ['scripts/update.sh', '--help'])).toContain(
      'fresh staged',
    );
    expect(run('bash', ['scripts/uninstall.sh', '--help'])).toContain(
      'preserves instance',
    );
    expect(run('node', ['bin/skoobi.js', '--help'])).toContain('Skoobi CLI');
    expect(run('bash', ['scripts/install.sh', '--version']).trim()).toBe(
      `skoobi-installer ${packageVersion}`,
    );
    expect(run('node', ['bin/skoobi.js', '--version']).trim()).toBe(
      `skoobi ${packageVersion}`,
    );
    expect(run('node', ['bin/skoobi.js', '--help'])).toContain(
      'skoobi update --ref refs/tags/<version> --expected-commit <40-hex>',
    );
  });

  it('refuses every unpinned update form before filesystem or network access', () => {
    const home = tempDir();
    const prefix = path.join(tempDir(), 'must-not-exist');
    const fake = makeFakeCommands({
      git: 'touch "$UNEXPECTED_NETWORK"; exit 97',
    });
    const networkMarker = path.join(tempDir(), 'git-called');
    const cases = [
      [],
      ['--ref', 'refs/heads/main'],
      [
        '--expected-commit',
        '1111111111111111111111111111111111111111',
      ],
    ];

    for (const args of cases) {
      const result = runResult(
        'bash',
        ['scripts/update.sh', '--prefix', prefix, ...args],
        {
          env: {
            HOME: home,
            PATH: `${fake.bin}:${process.env.PATH || ''}`,
            SKOOBI_UPDATE_REF: '',
            SKOOBI_UPDATE_EXPECTED_COMMIT: '',
            UNEXPECTED_NETWORK: networkMarker,
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'requires both --ref and --expected-commit',
      );
      expect(fs.existsSync(prefix)).toBe(false);
      expect(fs.existsSync(networkMarker)).toBe(false);
    }
  });

  it('keeps the active release when a pinned update commit does not match', () => {
    const remote = createRemote({ tracked: 'installed\n' });
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'pin-mismatch', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const installedHead = git(appDir, ['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(remote, 'tracked.txt'), 'new remote\n');
    git(remote, ['add', 'tracked.txt']);
    git(remote, ['commit', '-m', 'move fixture branch']);
    const result = runResult(
      'bash',
      [
        'scripts/update.sh',
        '--prefix',
        prefix,
        '--instance',
        'pin-mismatch',
        '--ref',
        'refs/heads/main',
        '--expected-commit',
        installedHead,
        '--no-start',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match the expected commit');
    expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(installedHead);
    expect(fs.readFileSync(path.join(appDir, 'tracked.txt'), 'utf8')).toBe(
      'installed\n',
    );
  });

  it('keeps every active public environment key unique', () => {
    const overlayTemplate = path.join(
      repoRoot,
      'public-release',
      'overlay',
      '.env.example',
    );
    const template = fs.readFileSync(
      fs.existsSync(overlayTemplate)
        ? overlayTemplate
        : path.join(repoRoot, '.env.example'),
      'utf8',
    );
    const counts = new Map<string, number>();
    for (const line of template.split(/\r?\n/)) {
      const match = line.match(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/);
      if (!match) continue;
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }
    expect([...counts.entries()].filter(([, count]) => count !== 1)).toEqual(
      [],
    );
  });

  it('initializes one fail-closed Telegram owner and retries idempotently', () => {
    const state = createOwnerCliState();
    const first = runOwnerCli(state, 'tg:123456789');
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('Telegram owner initialized.');
    expect(first.stdout).toContain('Run: skoobi restart');
    expect(`${first.stdout}${first.stderr}`).not.toContain('test-only-token');

    const rowsAfterFirst = ownerRows(state.dbFile);
    expect(rowsAfterFirst).toHaveLength(1);
    expect(rowsAfterFirst[0]).toMatchObject({
      jid: 'tg:123456789',
      name: 'Owner',
      folder: 'telegram_main',
      trigger_pattern: '@Skoobi',
      requires_trigger: 0,
      is_main: 1,
      runtime: 'sandbox',
    });
    const envAfterFirst = fs.readFileSync(state.envFile, 'utf8');
    expect(envAfterFirst).toContain('OWNER_TELEGRAM_USER_IDS="123456789"');
    expect(fs.statSync(state.envFile).mode & 0o777).toBe(0o600);
    for (const dir of [
      path.join(state.groupsDir, 'telegram_main'),
      path.join(state.groupsDir, 'telegram_main', 'logs'),
    ]) {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }

    const second = runOwnerCli(state, '123456789');
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('was already initialized');
    expect(ownerRows(state.dbFile)).toEqual(rowsAfterFirst);
    expect(fs.readFileSync(state.envFile, 'utf8')).toBe(envAfterFirst);
  });

  it('refuses conflicting owner, JID, folder, and allowlist state without replacement', () => {
    const differentMain = createOwnerCliState({
      mainJid: 'tg:987654321',
    });
    const mainEnv = fs.readFileSync(differentMain.envFile, 'utf8');
    const mainRows = ownerRows(differentMain.dbFile);
    const mainResult = runOwnerCli(differentMain, '123456789');
    expect(mainResult.status).not.toBe(0);
    expect(mainResult.stderr).toContain('refusing to replace');
    expect(ownerRows(differentMain.dbFile)).toEqual(mainRows);
    expect(fs.readFileSync(differentMain.envFile, 'utf8')).toBe(mainEnv);
    expect(
      fs.existsSync(path.join(differentMain.groupsDir, 'telegram_main')),
    ).toBe(false);

    const existingGuest = createOwnerCliState();
    const guestDb = new Database(existingGuest.dbFile);
    guestDb
      .prepare(
        `INSERT INTO registered_groups
           (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main, runtime)
         VALUES ('tg:123456789', 'Guest', 'guest_one', '@Skoobi', ?, 0, 0, 'sandbox')`,
      )
      .run('2026-01-01T00:00:00.000Z');
    guestDb.close();
    const guestResult = runOwnerCli(existingGuest, '123456789');
    expect(guestResult.status).not.toBe(0);
    expect(guestResult.stderr).toContain('different registration');
    expect(ownerRows(existingGuest.dbFile)).toHaveLength(1);

    const otherAllowlist = createOwnerCliState({ ownerIds: '987654321' });
    const allowlistEnv = fs.readFileSync(otherAllowlist.envFile, 'utf8');
    const allowlistResult = runOwnerCli(otherAllowlist, '123456789');
    expect(allowlistResult.status).not.toBe(0);
    expect(allowlistResult.stderr).toContain(
      'different owner allowlist already exists',
    );
    expect(ownerRows(otherAllowlist.dbFile)).toEqual([]);
    expect(fs.readFileSync(otherAllowlist.envFile, 'utf8')).toBe(allowlistEnv);

    const restrictedChat = createOwnerCliState({
      chatIds: '-1001234567890',
    });
    const restrictedResult = runOwnerCli(restrictedChat, '123456789');
    expect(restrictedResult.status).not.toBe(0);
    expect(restrictedResult.stderr).toContain('chat allowlist excludes');
    expect(restrictedResult.stderr).not.toContain('invalid');
  });

  it('rejects legacy main rows that do not preserve owner-only runtime invariants', () => {
    const incompatibleRows = [
      { requiresTrigger: 1, runtime: 'sandbox' },
      { requiresTrigger: 0, runtime: 'container' },
      { requiresTrigger: null, runtime: 'sandbox' },
      { requiresTrigger: 0, runtime: null },
    ];

    for (const incompatible of incompatibleRows) {
      const state = createOwnerCliState({
        ownerIds: '123456789',
        mainJid: 'tg:123456789',
      });
      const database = new Database(state.dbFile);
      database
        .prepare(
          `UPDATE registered_groups
           SET requires_trigger = ?, runtime = ?
           WHERE jid = 'tg:123456789'`,
        )
        .run(incompatible.requiresTrigger, incompatible.runtime);
      database.close();
      const beforeEnv = fs.readFileSync(state.envFile, 'utf8');
      const beforeRows = ownerRows(state.dbFile);

      const result = runOwnerCli(state, '123456789');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'existing main registration is not owner-ready',
      );
      expect(ownerRows(state.dbFile)).toEqual(beforeRows);
      expect(fs.readFileSync(state.envFile, 'utf8')).toBe(beforeEnv);
      expect(fs.existsSync(path.join(state.groupsDir, 'telegram_main'))).toBe(
        false,
      );
    }
  });

  it('doctor rejects an incompatible legacy owner registration', () => {
    const state = createOwnerCliState({
      ownerIds: '123456789',
      mainJid: 'tg:123456789',
    });
    const database = new Database(state.dbFile);
    database
      .prepare(
        `UPDATE registered_groups
         SET requires_trigger = 1, runtime = 'container'
         WHERE jid = 'tg:123456789'`,
      )
      .run();
    database.close();
    const fake = makeFakeCommands({
      node: 'printf "v22.14.0\\n"',
      npm: 'printf "10.0.0\\n"',
      git: 'printf "git version 2.0.0\\n"',
      sqlite3: 'printf "3.0.0\\n"',
      curl: 'printf "curl 8.0.0\\n"',
      rg: 'printf "ripgrep 14.0.0\\n"',
      bwrap: 'printf "bubblewrap 0.10.0\\n"',
      socat: 'printf "socat version 1.8.0\\n"',
      codex:
        '[[ "$*" == "login status" ]] && exit 0; printf "codex-cli test\\n"',
    });
    const doctor = runResult(
      process.execPath,
      [
        'bin/skoobi.js',
        'doctor',
        '--prefix',
        state.prefix,
        '--instance',
        state.instance,
      ],
      {
        env: {
          ...process.env,
          HOME: tempDir('skoobi-doctor-home-'),
          PATH: fake.bin,
        },
      },
    );
    expect(doctor.status).not.toBe(0);
    expect(doctor.stdout).toContain('telegram owner: problem');
    expect(doctor.stdout).toContain('overall: needs attention');
  });

  it('refuses unsafe owner paths and a concurrent Skoobi operation', () => {
    const locked = createOwnerCliState();
    fs.mkdirSync(path.join(locked.prefix, '.skoobi-operation.lock'), {
      mode: 0o700,
    });
    const lockedEnv = fs.readFileSync(locked.envFile, 'utf8');
    const lockedResult = runOwnerCli(locked, '123456789');
    expect(lockedResult.status).not.toBe(0);
    expect(lockedResult.stderr).toContain('is in progress');
    expect(ownerRows(locked.dbFile)).toEqual([]);
    expect(fs.readFileSync(locked.envFile, 'utf8')).toBe(lockedEnv);

    const symlinked = createOwnerCliState();
    const outside = path.join(tempDir('skoobi-owner-outside-'), 'outside.env');
    fs.writeFileSync(outside, 'KEEP=unchanged\n', { mode: 0o600 });
    fs.unlinkSync(symlinked.envFile);
    fs.symlinkSync(outside, symlinked.envFile);
    const symlinkResult = runOwnerCli(symlinked, '123456789');
    expect(symlinkResult.status).not.toBe(0);
    expect(symlinkResult.stderr).toContain('single-link regular file');
    expect(fs.readFileSync(outside, 'utf8')).toBe('KEEP=unchanged\n');
    expect(ownerRows(symlinked.dbFile)).toEqual([]);
    expect(
      fs.existsSync(path.join(symlinked.prefix, '.skoobi-operation.lock')),
    ).toBe(false);
  });

  it('rolls owner env changes back when the database insert aborts', () => {
    const state = createOwnerCliState();
    const before = fs.readFileSync(state.envFile, 'utf8');
    const db = new Database(state.dbFile);
    db.exec(`
      CREATE TRIGGER reject_owner_insert
      BEFORE INSERT ON registered_groups
      BEGIN
        SELECT RAISE(ABORT, 'test insert rejected');
      END
    `);
    db.close();

    const result = runOwnerCli(state, '123456789');
    expect(result.status).not.toBe(0);
    expect(ownerRows(state.dbFile)).toEqual([]);
    expect(fs.readFileSync(state.envFile, 'utf8')).toBe(before);
    expect(
      fs.existsSync(path.join(state.prefix, '.skoobi-operation.lock')),
    ).toBe(false);
    expect(fs.existsSync(path.join(state.groupsDir, 'telegram_main'))).toBe(
      false,
    );

    const existing = createOwnerCliState();
    const ownerDir = path.join(existing.groupsDir, 'telegram_main');
    const logsDir = path.join(ownerDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(ownerDir, 0o750);
    fs.chmodSync(logsDir, 0o710);
    const existingDb = new Database(existing.dbFile);
    existingDb.exec(`
      CREATE TRIGGER reject_existing_owner_insert
      BEFORE INSERT ON registered_groups
      BEGIN
        SELECT RAISE(ABORT, 'test existing insert rejected');
      END
    `);
    existingDb.close();

    const existingResult = runOwnerCli(existing, '123456789');
    expect(existingResult.status).not.toBe(0);
    expect(ownerRows(existing.dbFile)).toEqual([]);
    expect(fs.statSync(ownerDir).mode & 0o777).toBe(0o750);
    expect(fs.statSync(logsDir).mode & 0o777).toBe(0o710);
  });

  it('handles actual SQLite commit and rollback exceptions atomically', async () => {
    const actual = (await vi.importActual('better-sqlite3')) as {
      default: typeof Database;
    };
    const ActualDatabase = actual.default;
    let fault: 'before-commit' | 'after-commit' = 'before-commit';
    class FaultyDatabase extends ActualDatabase {
      exec(source: string): this {
        const statement = source.trim().toUpperCase();
        if (fault === 'before-commit' && statement === 'COMMIT') {
          throw new Error('simulated commit exception');
        }
        if (fault === 'before-commit' && statement === 'ROLLBACK') {
          throw new Error('simulated rollback exception');
        }
        const result = super.exec(source);
        if (fault === 'after-commit' && statement === 'COMMIT') {
          throw new Error('simulated ambiguous post-commit exception');
        }
        return result;
      }
    }
    vi.doMock('better-sqlite3', () => ({
      ...actual,
      default: FaultyDatabase,
    }));
    try {
      const { initializeTelegramOwner } =
        // @ts-expect-error JavaScript CLI modules intentionally have no TS declarations.
        await import('../../bin/owner-bootstrap.js');

      const failed = createOwnerCliState();
      fs.chmodSync(failed.envFile, 0o400);
      const before = fs.readFileSync(failed.envFile, 'utf8');
      const beforeMode = fs.statSync(failed.envFile).mode & 0o777;
      expect(() =>
        initializeTelegramOwner(
          {
            prefix: failed.prefix,
            instanceDir: failed.instanceDir,
            envFile: failed.envFile,
            dbFile: failed.dbFile,
          },
          '123456789',
        ),
      ).toThrow('simulated commit exception');
      expect(ownerRows(failed.dbFile)).toEqual([]);
      expect(fs.readFileSync(failed.envFile, 'utf8')).toBe(before);
      expect(fs.statSync(failed.envFile).mode & 0o777).toBe(beforeMode);
      expect(
        fs.existsSync(path.join(failed.prefix, '.skoobi-operation.lock')),
      ).toBe(false);
      expect(fs.existsSync(path.join(failed.groupsDir, 'telegram_main'))).toBe(
        false,
      );

      fault = 'after-commit';
      const committed = createOwnerCliState();
      const result = initializeTelegramOwner(
        {
          prefix: committed.prefix,
          instanceDir: committed.instanceDir,
          envFile: committed.envFile,
          dbFile: committed.dbFile,
        },
        '123456789',
      );
      expect(result).toEqual({ created: true, jid: 'tg:123456789' });
      expect(ownerRows(committed.dbFile)).toHaveLength(1);
      expect(fs.readFileSync(committed.envFile, 'utf8')).toContain(
        'OWNER_TELEGRAM_USER_IDS="123456789"',
      );
      expect(
        fs.existsSync(path.join(committed.prefix, '.skoobi-operation.lock')),
      ).toBe(false);
    } finally {
      vi.doUnmock('better-sqlite3');
      vi.resetModules();
    }
  });

  it('preserves an exact existing owner workspace while repairing its missing allowlist', () => {
    const state = createOwnerCliState({ mainJid: 'tg:123456789' });
    const ownerDir = path.join(state.groupsDir, 'telegram_main');
    fs.mkdirSync(ownerDir, { mode: 0o700 });
    const note = path.join(ownerDir, 'owner-note.txt');
    fs.writeFileSync(note, 'preserve\n', { mode: 0o600 });
    const rowsBefore = ownerRows(state.dbFile);

    const result = runOwnerCli(state, 'tg:123456789');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('was already initialized');
    expect(ownerRows(state.dbFile)).toEqual(rowsBefore);
    expect(fs.readFileSync(note, 'utf8')).toBe('preserve\n');
    expect(fs.readFileSync(state.envFile, 'utf8')).toContain(
      'OWNER_TELEGRAM_USER_IDS="123456789"',
    );
  });

  it('doctor returns success only when runtime, owner, and Codex are ready', () => {
    const state = createOwnerCliState({
      ownerIds: '123456789',
      mainJid: 'tg:123456789',
    });
    const fake = makeFakeCommands({
      node: 'printf "v22.14.0\\n"',
      npm: 'printf "10.0.0\\n"',
      git: 'printf "git version 2.0.0\\n"',
      sqlite3: 'printf "3.0.0\\n"',
      curl: 'printf "curl 8.0.0\\n"',
      rg: 'printf "ripgrep 14.0.0\\n"',
      bwrap: 'printf "bubblewrap 0.10.0\\n"',
      socat: 'printf "socat version 1.8.0\\n"',
      codex:
        '[[ "$*" == "login status" ]] && exit 0; printf "codex-cli test\\n"',
    });
    const result = runResult(
      process.execPath,
      [
        'bin/skoobi.js',
        'doctor',
        '--prefix',
        state.prefix,
        '--instance',
        state.instance,
      ],
      {
        env: {
          ...process.env,
          HOME: tempDir('skoobi-doctor-home-'),
          PATH: fake.bin,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('telegram token: ok');
    expect(result.stdout).toContain('telegram owner: ok');
    expect(result.stdout).toContain('codex login: ok');
    expect(result.stdout).toContain('owner Codex route: ok');
    expect(result.stdout).toContain('overall: ready');
    expect(`${result.stdout}${result.stderr}`).not.toContain('test-only-token');
  });

  it('doctor fails on old Node, missing Telegram setup, or failed Codex login', () => {
    const notReady = createOwnerCliState({ token: '' });
    const fake = makeFakeCommands({
      node: 'printf "v20.19.0\\n"',
      npm: 'printf "10.0.0\\n"',
      git: 'printf "git version 2.0.0\\n"',
      sqlite3: 'printf "3.0.0\\n"',
      curl: 'printf "curl 8.0.0\\n"',
      rg: 'printf "ripgrep 14.0.0\\n"',
      bwrap: 'printf "bubblewrap 0.10.0\\n"',
      socat: 'printf "socat version 1.8.0\\n"',
      codex:
        '[[ "$*" == "login status" ]] && { printf "PRIVATE_ACCOUNT_DETAIL\\n" >&2; exit 1; }; printf "codex-cli test\\n"',
    });
    const result = runResult(
      process.execPath,
      [
        'bin/skoobi.js',
        'doctor',
        '--prefix',
        notReady.prefix,
        '--instance',
        notReady.instance,
      ],
      {
        env: {
          ...process.env,
          HOME: tempDir('skoobi-doctor-home-'),
          PATH: fake.bin,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('node: problem');
    expect(result.stdout).toContain('telegram token: problem');
    expect(result.stdout).toContain('telegram owner: problem');
    expect(result.stdout).toContain('codex login: problem');
    expect(result.stdout).toContain('overall: needs attention');
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'PRIVATE_ACCOUNT_DETAIL',
    );
  });

  it('doctor fails closed for incomplete non-Codex providers', () => {
    const baseCommands = {
      node: 'printf "v22.14.0\\n"',
      npm: 'printf "10.0.0\\n"',
      git: 'printf "git version 2.0.0\\n"',
      sqlite3: 'printf "3.0.0\\n"',
      curl: 'printf "curl 8.0.0\\n"',
      rg: 'printf "ripgrep 14.0.0\\n"',
      bwrap: 'printf "bubblewrap 0.10.0\\n"',
      socat: 'printf "socat version 1.8.0\\n"',
    };
    const openai = createOwnerCliState({
      ownerIds: '123456789',
      mainJid: 'tg:123456789',
    });
    fs.writeFileSync(
      openai.envFile,
      fs
        .readFileSync(openai.envFile, 'utf8')
        .replace(
          'SKOOBI_MODEL_GATEWAY_TYPE="codex_subscription_cli"',
          'SKOOBI_MODEL_GATEWAY_TYPE="openai_compatible"',
        ),
      { mode: 0o600 },
    );
    const openaiFake = makeFakeCommands(baseCommands);
    const openaiResult = runResult(
      process.execPath,
      [
        'bin/skoobi.js',
        'doctor',
        '--prefix',
        openai.prefix,
        '--instance',
        openai.instance,
      ],
      {
        env: {
          ...process.env,
          HOME: tempDir('skoobi-doctor-home-'),
          PATH: openaiFake.bin,
        },
      },
    );
    expect(openaiResult.status).not.toBe(0);
    expect(openaiResult.stdout).toContain(
      'openai-compatible provider key: problem',
    );
    expect(openaiResult.stdout).toContain('overall: needs attention');
    fs.appendFileSync(
      openai.envFile,
      'SKOOBI_MODEL_GATEWAY_KEY="test-only-openai-key"\n',
    );
    const openaiReady = runResult(
      process.execPath,
      [
        'bin/skoobi.js',
        'doctor',
        '--prefix',
        openai.prefix,
        '--instance',
        openai.instance,
      ],
      {
        env: {
          ...process.env,
          HOME: tempDir('skoobi-doctor-home-'),
          PATH: openaiFake.bin,
        },
      },
    );
    expect(openaiReady.status).toBe(0);
    expect(openaiReady.stdout).toContain('openai-compatible provider key: ok');
    expect(`${openaiReady.stdout}${openaiReady.stderr}`).not.toContain(
      'test-only-openai-key',
    );

    const claude = createOwnerCliState({
      ownerIds: '123456789',
      mainJid: 'tg:123456789',
    });
    fs.writeFileSync(
      claude.envFile,
      fs
        .readFileSync(claude.envFile, 'utf8')
        .replace(
          'SKOOBI_MODEL_GATEWAY_TYPE="codex_subscription_cli"',
          'SKOOBI_MODEL_GATEWAY_TYPE="disabled"',
        ),
      { mode: 0o600 },
    );
    const claudeFake = makeFakeCommands({
      ...baseCommands,
      claude:
        '[[ "$*" == "--version" ]] && { printf "claude test\\n"; exit 0; }; [[ "$*" == "auth status" ]] && { printf "PRIVATE_CLAUDE_AUTH\\n" >&2; exit 1; }; exit 2',
    });
    const claudeResult = runResult(
      process.execPath,
      [
        'bin/skoobi.js',
        'doctor',
        '--prefix',
        claude.prefix,
        '--instance',
        claude.instance,
      ],
      {
        env: {
          ...process.env,
          HOME: tempDir('skoobi-doctor-home-'),
          PATH: claudeFake.bin,
        },
      },
    );
    expect(claudeResult.status).not.toBe(0);
    expect(claudeResult.stdout).toContain('claude auth: problem');
    expect(`${claudeResult.stdout}${claudeResult.stderr}`).not.toContain(
      'PRIVATE_CLAUDE_AUTH',
    );
  });

  it('rejects the dashboard service name and overlong instance names everywhere', () => {
    const invalidInstances = [
      {
        value: 'dashboard',
        message: "Instance name 'dashboard' is reserved",
        cliMessage: "--instance name 'dashboard' is reserved",
      },
      {
        value: 'Dashboard',
        message: "Instance name 'dashboard' is reserved",
        cliMessage: "--instance name 'dashboard' is reserved",
      },
      {
        value: 'a'.repeat(64),
        message: 'Instance name must be at most 63 characters',
        cliMessage: '--instance must be at most 63 characters',
      },
    ];
    const scriptArgs = [
      ['scripts/install.sh', '--dry-run'],
      ['scripts/update.sh', '--dry-run'],
      ['scripts/uninstall.sh', '--dry-run'],
    ];

    for (const invalid of invalidInstances) {
      for (const [script, ...args] of scriptArgs) {
        const result = runResult('bash', [
          script,
          ...args,
          '--instance',
          invalid.value,
        ]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(invalid.message);
      }

      const cli = runResult('node', [
        'bin/skoobi.js',
        'paths',
        '--instance',
        invalid.value,
      ]);
      expect(cli.status).not.toBe(0);
      expect(cli.stderr).toContain(invalid.cliMessage);
    }
  });

  it('rejects credential-bearing or noncanonical repository URLs without echoing them', () => {
    const secret = 'GATEWAY_SECRET_SHOULD_NOT_APPEAR';
    const credentialedRepo = [
      'https://owner:',
      secret,
      '@github.com/barmashovdmitrii-droid/skoobi-agent.git?token=',
      secret,
    ].join('');
    const result = runResult('bash', [
      'scripts/install.sh',
      '--repo',
      credentialedRepo,
      '--dry-run',
    ]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'canonical public HTTPS',
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it('performs a no-write dry-run and redacts bot/provider secrets', () => {
    const prefix = tempDir();
    const home = tempDir();
    const token = '1234567890:SUPER_SECRET_TOKEN';
    const gateway = 'SUPER_SECRET_GATEWAY';
    const gatewayUrlSecret = 'SUPER_SECRET_GATEWAY_URL';
    const gatewayBaseUrl = [
      'https://owner:',
      gatewayUrlSecret,
      '@example.invalid/v1?token=',
      gatewayUrlSecret,
    ].join('');
    const out = run(
      'bash',
      [
        'scripts/install.sh',
        '--dry-run',
        '--yes',
        '--prefix',
        prefix,
        '--instance',
        'dry',
        '--no-service',
        '--no-start',
      ],
      {
        env: {
          HOME: home,
          SKOOBI_INSTALLER_SKIP_REQUIREMENTS: '1',
          SKOOBI_TELEGRAM_BOT_TOKEN: token,
          SKOOBI_INSTALL_PROVIDER: 'openai',
          SKOOBI_MODEL_GATEWAY_KEY: gateway,
          SKOOBI_MODEL_GATEWAY_BASE_URL: gatewayBaseUrl,
        },
      },
    );
    expect(out).toContain('mode: dry-run');
    expect(out).toContain('TELEGRAM_BOT_TOKEN=<redacted>');
    expect(out).toContain('SKOOBI_MODEL_GATEWAY_KEY=<redacted>');
    expect(out).not.toContain(token);
    expect(out).not.toContain(gateway);
    expect(out).not.toContain(gatewayUrlSecret);
    expect(fs.existsSync(path.join(prefix, 'app'))).toBe(false);
  });

  it('prompts for a token when copied configuration contains an empty key', () => {
    const prefix = tempDir();
    const home = tempDir();
    const instanceDir = path.join(prefix, 'instances', 'prompt-token');
    fs.mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(instanceDir, '.env'),
      'TELEGRAM_BOT_TOKEN=\nOWNER_TELEGRAM_USER_IDS=\n',
      { mode: 0o600 },
    );
    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--dry-run',
        '--reconfigure',
        '--prefix',
        prefix,
        '--instance',
        'prompt-token',
        '--no-service',
        '--no-start',
      ],
      {
        env: {
          HOME: home,
          SKOOBI_INSTALLER_SKIP_REQUIREMENTS: '1',
          SKOOBI_ASSISTANT_NAME: 'Skoobi',
        },
        input: 'test-only-prompt-token\n',
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('TELEGRAM_BOT_TOKEN=<redacted>');
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'test-only-prompt-token',
    );
    expect(fs.readFileSync(path.join(instanceDir, '.env'), 'utf8')).toBe(
      'TELEGRAM_BOT_TOKEN=\nOWNER_TELEGRAM_USER_IDS=\n',
    );
  });

  // This integration case performs three complete staged install transitions.
  // Hosted macOS runners can legitimately exceed Vitest's 5-second default.
  it('configures Codex for owner-only full-agent turns and clears it for other providers', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'provider-route', home, [], {
      SKOOBI_TELEGRAM_BOT_TOKEN: 'test-only-provider-token',
    });
    const envFile = path.join(prefix, 'instances', 'provider-route', '.env');
    let content = fs.readFileSync(envFile, 'utf8');
    expect(content).toContain('SKOOBI_TELEGRAM_OWNER_LIVE_ENABLED="true"');
    expect(content).toContain('SKOOBI_CODEX_OWNER_FULL_AGENT_ENABLED="true"');
    expect(content).toContain('SKOOBI_CODEX_OWNER_FULL_AGENT_MODE="always"');
    expect(content).toContain('SKOOBI_SANDBOX_CODEX_PRIMARY="false"');
    expect(content).toContain('SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY="true"');
    expect(content).toContain('SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED="false"');

    installFixture(remote, prefix, 'provider-route', home, ['--reconfigure'], {
      SKOOBI_INSTALL_PROVIDER: 'openai',
      SKOOBI_MODEL_GATEWAY_KEY: 'test-only-gateway-key',
    });
    content = fs.readFileSync(envFile, 'utf8');
    expect(content).toContain('SKOOBI_TELEGRAM_OWNER_LIVE_ENABLED="true"');
    expect(content).toContain('SKOOBI_CODEX_OWNER_FULL_AGENT_ENABLED="false"');
    expect(content).toContain('SKOOBI_CODEX_OWNER_FULL_AGENT_MODE="auto"');
    expect(content).toContain('SKOOBI_SANDBOX_CODEX_PRIMARY="false"');
    expect(content).toContain('SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY="false"');

    installFixture(remote, prefix, 'provider-route', home, ['--reconfigure'], {
      SKOOBI_INSTALL_PROVIDER: 'claude',
    });
    content = fs.readFileSync(envFile, 'utf8');
    expect(content).toContain('SKOOBI_TELEGRAM_OWNER_LIVE_ENABLED="false"');
    expect(content).toContain('SKOOBI_CODEX_OWNER_FULL_AGENT_ENABLED="false"');
    expect(content).toContain('SKOOBI_CODEX_OWNER_FULL_AGENT_MODE="auto"');
    expect(content).toContain('SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY="false"');
  }, 15_000);

  it('does not require Codex when a normal rerun preserves another provider', () => {
    const prefix = tempDir();
    const home = tempDir();
    const instanceDir = path.join(prefix, 'instances', 'preserved-openai');
    fs.mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(instanceDir, '.env'),
      'SKOOBI_MODEL_GATEWAY_TYPE="openai_compatible"\n',
      { mode: 0o600 },
    );
    const fake = makeFakeCommands({
      uname: 'printf "Darwin\\n"',
      curl: 'exit 0',
      git: 'exit 0',
      npm: 'exit 0',
      node: 'printf "22\\n"',
      sqlite3: 'exit 0',
      rg: 'exit 0',
    });
    const result = runResult(
      '/bin/bash',
      [
        'scripts/install.sh',
        '--dry-run',
        '--yes',
        '--prefix',
        prefix,
        '--instance',
        'preserved-openai',
        '--no-service',
        '--no-start',
      ],
      {
        env: {
          HOME: home,
          PATH: `${fake.bin}:/usr/bin:/bin`,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Existing non-Codex provider configuration will be preserved.',
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'codex is required',
    );
  });

  it('uses a preserved pinned Codex executable when the shell PATH omits codex', () => {
    const prefix = tempDir();
    const home = tempDir();
    const calls = path.join(home, 'pinned-codex-calls.log');
    const fake = makeFakeCommands({
      uname: 'printf "Darwin\\n"',
      curl: 'exit 0',
      git: 'exit 0',
      npm: 'exit 0',
      node: 'printf "22\\n"',
      sqlite3: 'exit 0',
      rg: 'exit 0',
      'pinned-codex': `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
    });
    const instanceDir = path.join(prefix, 'instances', 'preserved-codex');
    fs.mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(instanceDir, '.env'),
      [
        'SKOOBI_MODEL_GATEWAY_TYPE=codex_subscription_cli # preserved',
        `SKOOBI_CODEX_COMMAND="${path.join(fake.bin, 'pinned-codex')}"`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    const result = runResult(
      '/bin/bash',
      [
        'scripts/install.sh',
        '--dry-run',
        '--yes',
        '--prefix',
        prefix,
        '--instance',
        'preserved-codex',
        '--no-service',
        '--no-start',
      ],
      {
        env: {
          HOME: home,
          PATH: `${fake.bin}:/usr/bin:/bin`,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(fs.readFileSync(calls, 'utf8')).toBe('login status\n');
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'codex is required',
    );
  });

  it('fails requirement checks when sandbox dependencies are absent', () => {
    const mac = makeFakeCommands({
      uname: 'printf "Darwin\\n"',
      curl: 'exit 0',
      git: 'exit 0',
      npm: 'exit 0',
      node: 'printf "22\\n"',
      sqlite3: 'exit 0',
      codex: 'exit 0',
    });
    const missingRg = runResult(
      '/bin/bash',
      [
        'scripts/install.sh',
        '--dry-run',
        '--yes',
        '--no-service',
        '--no-start',
      ],
      { env: { HOME: tempDir(), PATH: mac.bin } },
    );
    expect(missingRg.status).not.toBe(0);
    expect(missingRg.stderr).toContain('rg is required');

    const linux = makeFakeCommands({
      uname: 'printf "Linux\\n"',
      curl: 'exit 0',
      git: 'exit 0',
      npm: 'exit 0',
      node: 'printf "22\\n"',
      sqlite3: 'exit 0',
      rg: 'exit 0',
      codex: 'exit 0',
    });
    const missingBwrap = runResult(
      '/bin/bash',
      [
        'scripts/install.sh',
        '--dry-run',
        '--yes',
        '--no-service',
        '--no-start',
      ],
      { env: { HOME: tempDir(), PATH: linux.bin } },
    );
    expect(missingBwrap.status).not.toBe(0);
    expect(missingBwrap.stderr).toContain('bwrap is required');
  });

  it('does not pass bot or gateway secrets into install build subprocesses', () => {
    const token = 'BUILD_SUBPROCESS_BOT_SECRET';
    const gateway = 'BUILD_SUBPROCESS_GATEWAY_SECRET';
    const build = `node -e "const f=require('node:fs');console.log(process.env.SKOOBI_TELEGRAM_BOT_TOKEN||process.env.SKOOBI_MODEL_GATEWAY_KEY||'build-env-clean');f.mkdirSync('dist',{recursive:true});f.writeFileSync('dist/service.js','ok');f.writeFileSync('dist/build-home.txt',process.env.HOME||'')"`;
    const remote = createRemote({ build });
    const prefix = tempDir();
    const home = tempDir();
    const out = installFixture(remote, prefix, 'clean-env', home, [], {
      SKOOBI_TELEGRAM_BOT_TOKEN: token,
      SKOOBI_INSTALL_PROVIDER: 'openai',
      SKOOBI_MODEL_GATEWAY_KEY: gateway,
    });
    expect(out).toContain('build-env-clean');
    expect(out).not.toContain(token);
    expect(out).not.toContain(gateway);
    expect(
      fs.readFileSync(
        path.join(prefix, 'app', 'skoobi-agent', 'dist', 'build-home.txt'),
        'utf8',
      ),
    ).not.toBe(home);
  });

  it('scrubs inherited Git config/template injection and provider secrets from every Git child', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    const template = tempDir();
    fs.mkdirSync(path.join(template, 'hooks'));
    fs.writeFileSync(
      path.join(template, 'hooks', 'post-checkout'),
      '#!/bin/sh\nexit 91\n',
      { mode: 0o755 },
    );
    const out = installFixture(remote, prefix, 'git-env', home, [], {
      GIT_CONFIG_PARAMETERS:
        "'url.file:///attacker.invalid/.insteadOf'='https://github.com/'",
      GIT_TEMPLATE_DIR: template,
      SKOOBI_TELEGRAM_BOT_TOKEN: 'GIT_CHILD_BOT_SECRET',
      SKOOBI_INSTALL_PROVIDER: 'openai',
      SKOOBI_MODEL_GATEWAY_KEY: 'GIT_CHILD_GATEWAY_SECRET',
      SKOOBI_MODEL_GATEWAY_BASE_URL: [
        'https://owner:',
        'GIT_CHILD_URL_SECRET',
        '@example.invalid/v1',
      ].join(''),
    });
    expect(out).toContain('Skoobi install complete.');
    expect(
      fs.existsSync(path.join(prefix, 'app', 'skoobi-agent', 'dist')),
    ).toBe(true);
  });

  it('reconfigures through the runtime-compatible env format without putting secrets in awk argv', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'env-format', home);
    const fake = makeFakeCommands({
      awk: 'printf "%s\\n" "$*" >"$AWK_CALLED"; exit 99',
    });
    const awkCalled = path.join(tempDir(), 'awk-called.txt');
    const assistant = 'Owner "North" \\ desk';
    const token = 'token-"quoted"-\\-value';
    installFixture(remote, prefix, 'env-format', home, ['--reconfigure'], {
      PATH: `${fake.bin}:${process.env.PATH || ''}`,
      AWK_CALLED: awkCalled,
      SKOOBI_ASSISTANT_NAME: assistant,
      SKOOBI_TELEGRAM_BOT_TOKEN: token,
    });
    expect(fs.existsSync(awkCalled)).toBe(false);
    const envFile = path.join(prefix, 'instances', 'env-format', '.env');
    const previous = process.env.CLAUDECLAW_ENV_FILE;
    process.env.CLAUDECLAW_ENV_FILE = envFile;
    try {
      expect(
        readEnvFile([
          'ASSISTANT_NAME',
          'TELEGRAM_BOT_TOKEN',
          'SKOOBI_SERVICE_LABEL',
        ]),
      ).toEqual({
        ASSISTANT_NAME: assistant,
        TELEGRAM_BOT_TOKEN: token,
        SKOOBI_SERVICE_LABEL: 'com.skoobi.env-format',
      });
    } finally {
      if (previous === undefined) delete process.env.CLAUDECLAW_ENV_FILE;
      else process.env.CLAUDECLAW_ENV_FILE = previous;
    }
  });

  it('restores owner .env when a later service activation fails', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'env-rollback', home);
    const envFile = path.join(prefix, 'instances', 'env-rollback', '.env');
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const originalHead = git(appDir, ['rev-parse', 'HEAD']);
    const ownerEnv = 'ASSISTANT_NAME=OwnerOriginal\nRUNTIME=owner-runtime\n';
    fs.writeFileSync(envFile, ownerEnv, { mode: 0o600 });
    const fake = makeFakeCommands({
      uname: 'printf "Linux\\n"',
      systemctl:
        'printf "%s\\n" "$*" >>"$FAKE_CALL_LOG"; [[ "${2:-}" == "is-active" ]] && exit 4; [[ "${2:-}" == "enable" && "${3:-}" == "--now" ]] && exit 9; exit 0',
    });
    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--prefix',
        prefix,
        '--instance',
        'env-rollback',
        '--reconfigure',
        '--yes',
      ],
      {
        env: transportEnv(remote, home, {
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
          FAKE_CALL_LOG: fake.log,
          SKOOBI_ASSISTANT_NAME: 'Replacement',
        }),
      },
    );
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(ownerEnv);
    expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(originalHead);
    const calls = fs.readFileSync(fake.log, 'utf8');
    expect(calls.indexOf('enable --now')).toBeGreaterThanOrEqual(0);
    expect(calls.lastIndexOf('disable --now')).toBeGreaterThan(
      calls.indexOf('enable --now'),
    );
    expect(
      fs.existsSync(
        path.join(
          home,
          '.config',
          'systemd',
          'user',
          'skoobi-env-rollback.service',
        ),
      ),
    ).toBe(false);
    expect(fs.existsSync(path.join(prefix, '.skoobi-operation.lock'))).toBe(
      false,
    );
  });

  it('stops a live service before reinstall and restores it after a later failure', () => {
    const remote = createRemote({ tracked: 'old\n' });
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'install-live', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const oldHead = git(appDir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(remote, 'tracked.txt'), 'new\n');
    git(remote, ['add', 'tracked.txt']);
    git(remote, ['commit', '-m', 'new installer release']);

    const unit = path.join(
      home,
      '.config',
      'systemd',
      'user',
      'skoobi-install-live.service',
    );
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, 'old service\n', { mode: 0o600 });
    const serviceState = path.join(tempDir(), 'service-state');
    fs.writeFileSync(serviceState, 'active\n');
    fs.rmSync(path.join(home, '.local'), { recursive: true, force: true });
    fs.symlinkSync(tempDir(), path.join(home, '.local'));

    const fake = makeFakeCommands({
      uname: 'printf "Linux\\n"',
      systemctl: `printf 'cmd:%s\\n' "$*" >>"$FAKE_CALL_LOG"
case "\${2:-}" in
  is-enabled) printf 'enabled\\n'; exit 0 ;;
  is-active)
    [[ "$(cat "$SERVICE_STATE")" == "active" ]] && exit 0
    exit 3
    ;;
  disable)
    printf 'stop:%s\\n' "$(tr -d '\\n' <"$APP_SENTINEL")" >>"$FAKE_CALL_LOG"
    printf 'stopped\\n' >"$SERVICE_STATE"
    exit 0
    ;;
  start)
    printf 'start:%s\\n' "$(tr -d '\\n' <"$APP_SENTINEL")" >>"$FAKE_CALL_LOG"
    printf 'active\\n' >"$SERVICE_STATE"
    exit 0
    ;;
  *) exit 0 ;;
esac`,
    });
    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--prefix',
        prefix,
        '--instance',
        'install-live',
        '--yes',
      ],
      {
        env: transportEnv(remote, home, {
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
          APP_SENTINEL: path.join(appDir, 'tracked.txt'),
          FAKE_CALL_LOG: fake.log,
          SERVICE_STATE: serviceState,
        }),
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('symlinked directory ancestor');
    expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(oldHead);
    expect(fs.readFileSync(serviceState, 'utf8').trim()).toBe('active');
    const calls = fs.readFileSync(fake.log, 'utf8');
    expect(calls.indexOf('stop:old')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('start:old')).toBeGreaterThan(
      calls.indexOf('stop:old'),
    );

    fs.unlinkSync(unit);
    const noService = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--prefix',
        prefix,
        '--instance',
        'install-live',
        '--no-service',
        '--no-start',
        '--yes',
      ],
      {
        env: transportEnv(remote, home, {
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
          APP_SENTINEL: path.join(appDir, 'tracked.txt'),
          FAKE_CALL_LOG: fake.log,
          SERVICE_STATE: serviceState,
        }),
      },
    );
    expect(noService.status).not.toBe(0);
    expect(noService.stderr).toContain('managed systemd service is running');
    expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(oldHead);
  }, 20_000);

  it('refuses symlinked store and .env paths without touching their targets', () => {
    const remote = createRemote();
    for (const attack of ['store', '.env']) {
      const prefix = tempDir();
      const home = tempDir();
      const instanceDir = path.join(prefix, 'instances', attack);
      const outside = tempDir();
      fs.mkdirSync(instanceDir, { recursive: true });
      if (attack === 'store') {
        fs.chmodSync(outside, 0o755);
        fs.symlinkSync(outside, path.join(instanceDir, 'store'));
      } else {
        const outsideEnv = path.join(outside, 'outside.env');
        fs.writeFileSync(outsideEnv, 'KEEP=unchanged\n', { mode: 0o644 });
        fs.symlinkSync(outsideEnv, path.join(instanceDir, '.env'));
      }
      const result = runResult(
        'bash',
        [
          'scripts/install.sh',
          '--prefix',
          prefix,
          '--instance',
          attack,
          '--no-service',
          '--no-start',
          '--yes',
        ],
        { env: transportEnv(remote, home) },
      );
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(path.join(prefix, 'app', 'skoobi-agent'))).toBe(
        false,
      );
      if (attack === 'store') {
        expect(fs.statSync(outside).mode & 0o777).toBe(0o755);
      } else {
        expect(fs.readFileSync(path.join(outside, 'outside.env'), 'utf8')).toBe(
          'KEEP=unchanged\n',
        );
        expect(
          fs.statSync(path.join(outside, 'outside.env')).mode & 0o777,
        ).toBe(0o644);
      }
    }
  });

  it('refuses a symlink anywhere in the systemd service directory chain', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    const outside = tempDir();
    fs.mkdirSync(path.join(home, '.config'));
    fs.symlinkSync(outside, path.join(home, '.config', 'systemd'));
    const fake = makeFakeCommands({ uname: 'printf "Linux\\n"' });
    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--prefix',
        prefix,
        '--instance',
        'ancestor',
        '--no-start',
        '--yes',
      ],
      {
        env: transportEnv(remote, home, {
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
        }),
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('symlinked directory ancestor');
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(prefix, 'app', 'skoobi-agent'))).toBe(false);
  });

  it('installs an annotated tag as its exact commit through canonical origin', () => {
    const remote = createRemote();
    git(remote, ['tag', '-a', 'v1.0.0', '-m', 'release']);
    const expected = git(remote, ['rev-parse', 'v1.0.0^{}']);
    const prefix = tempDir();
    const home = tempDir();

    run(
      'bash',
      [
        'scripts/install.sh',
        '--repo',
        canonicalRepo,
        '--ref',
        'v1.0.0',
        '--prefix',
        prefix,
        '--instance',
        'tagged',
        '--no-service',
        '--no-start',
        '--yes',
      ],
      { env: transportEnv(remote, home) },
    );

    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(expected);
    expect(git(appDir, ['remote', 'get-url', 'origin'])).toBe(canonicalRepo);
    expect(
      fs.readFileSync(path.join(prefix, '.skoobi-managed-install'), 'utf8'),
    ).toContain(`repository=${canonicalRepo}`);
    expect(fs.existsSync(path.join(appDir, 'dist', 'service.js'))).toBe(true);
  });

  it('rejects a same-name branch and tag unless the namespace is explicit', () => {
    const remote = createRemote();
    git(remote, ['tag', 'main']);
    const prefix = tempDir();
    const home = tempDir();
    const ambiguous = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--ref',
        'main',
        '--prefix',
        prefix,
        '--instance',
        'ambiguous',
        '--no-service',
        '--no-start',
        '--yes',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(ambiguous.status).not.toBe(0);
    expect(ambiguous.stderr).toContain('both a branch and a tag');
    expect(fs.existsSync(path.join(prefix, 'app', 'skoobi-agent'))).toBe(false);

    installFixture(remote, prefix, 'ambiguous', home, [
      '--ref',
      'refs/heads/main',
    ]);
    expect(
      git(path.join(prefix, 'app', 'skoobi-agent'), ['rev-parse', 'HEAD']),
    ).toBe(git(remote, ['rev-parse', 'main']));
  });

  it('binds release installers to the exact expected commit and release workflow GITHUB_SHA', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    const mismatch = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--ref',
        'refs/heads/main',
        '--expected-commit',
        '0000000000000000000000000000000000000000',
        '--prefix',
        prefix,
        '--instance',
        'pinned',
        '--no-service',
        '--no-start',
        '--yes',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain('expected commit');
    expect(fs.existsSync(path.join(prefix, 'app', 'skoobi-agent'))).toBe(false);

    const privateOverlayWorkflow = path.join(
      repoRoot,
      'public-release',
      'overlay',
      '.github',
      'workflows',
      'release.yml',
    );
    const workflow = fs.readFileSync(
      fs.existsSync(privateOverlayWorkflow)
        ? privateOverlayWorkflow
        : path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    expect(workflow).toContain('git rev-parse --verify "$GITHUB_SHA^{commit}"');
    expect(workflow).toContain("'+refs/heads/main:refs/remotes/origin/main'");
    expect(workflow).toContain('git merge-base --is-ancestor');
    expect(workflow).toContain('"$SOURCE_COMMIT" refs/remotes/origin/main');
    expect(workflow).toContain('Package version must be strict SemVer');
    expect(workflow).toContain(
      'node release-input/prepare-release-installer.mjs',
    );
    expect(workflow).toContain('--tag "$GITHUB_REF_NAME"');
    expect(workflow).toContain('--commit "$SOURCE_COMMIT"');
    expect(workflow).not.toContain('REF_DEFAULT="refs/tags/{tag}"');
    expect(workflow).toContain('publish:\n    needs: verify');
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
    expect(workflow).toContain(
      'git status --porcelain=v1 --untracked-files=all',
    );
    expect(workflow).toContain('git show "$SOURCE_COMMIT:scripts/install.sh"');
    expect(workflow).toContain(
      'git show "$SOURCE_COMMIT:scripts/prepare-release-installer.mjs"',
    );
    expect(workflow).not.toContain('cp scripts/install.sh');
    const publishJob = workflow.slice(workflow.indexOf('\n  publish:'));
    expect(publishJob).not.toContain('npm ci');
    expect(publishJob).toContain('if [[ "$GITHUB_REF_NAME" == *-* ]]; then');
    expect(publishJob).toContain('release_flags+=(--prerelease)');
  });

  it('does not adopt an unrelated clean repository with a forged canonical origin', () => {
    const published = createRemote();
    const unrelated = createRemote({ tracked: 'unrelated\n' });
    const prefix = tempDir();
    const home = tempDir();
    const appDir = setupManagedClone(unrelated, prefix, 'adoption');
    fs.rmSync(path.join(prefix, '.skoobi-managed-install'));
    const originalHead = git(appDir, ['rev-parse', 'HEAD']);
    const result = runResult(
      'bash',
      [
        'scripts/update.sh',
        '--prefix',
        prefix,
        '--instance',
        'adoption',
        '--adopt-managed',
        '--no-start',
      ],
      { env: transportEnv(published, home) },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not published');
    expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(originalHead);
  });

  it('disables Git replacement objects in every lifecycle script', () => {
    for (const file of [
      'scripts/install.sh',
      'scripts/update.sh',
      'scripts/uninstall.sh',
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      expect(source).toContain('GIT_NO_REPLACE_OBJECTS=1');
      expect(source).toContain('--no-replace-objects');
      expect(source).toContain('GIT_CONFIG_NOSYSTEM=1');
      expect(source).toContain('GIT_CONFIG_GLOBAL=/dev/null');
      expect(source).toContain('GIT_CONFIG_COUNT=0');
      expect(source).toContain('GIT_TERMINAL_PROMPT=0');
    }
  });

  it('requires a value for explicit generic legacy migration', () => {
    const result = runResult('bash', [
      'scripts/install.sh',
      '--migrate-legacy',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('requires a directory basename');
  });

  it('rejects traversal and managed-name aliases as legacy directory names', () => {
    for (const name of ['../outside', 'skoobi-agent']) {
      const result = runResult('bash', [
        'scripts/install.sh',
        '--migrate-legacy',
        name,
        '--dry-run',
      ]);
      expect(result.status).not.toBe(0);
    }
  });

  it('rejects a symlinked explicit legacy directory', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    const outside = tempDir();
    fs.mkdirSync(path.join(prefix, 'app'), { recursive: true });
    fs.symlinkSync(outside, path.join(prefix, 'app', 'legacy-v1'));
    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--prefix',
        prefix,
        '--instance',
        'legacy-link',
        '--migrate-legacy',
        'legacy-v1',
        '--no-service',
        '--no-start',
        '--yes',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('symlinked legacy');
    expect(fs.existsSync(path.join(prefix, 'app', 'skoobi-agent'))).toBe(false);
  });

  it('rejects a noncanonical origin for an explicit legacy directory', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    const legacy = path.join(prefix, 'app', 'legacy-v1');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    git(path.dirname(legacy), ['clone', remote, legacy]);
    git(legacy, [
      'remote',
      'set-url',
      'origin',
      'https://example.invalid/not-public.git',
    ]);
    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--prefix',
        prefix,
        '--instance',
        'legacy-origin',
        '--migrate-legacy',
        'legacy-v1',
        '--no-service',
        '--no-start',
        '--yes',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('canonical HTTPS');
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(path.join(prefix, 'app', 'skoobi-agent'))).toBe(false);
  });

  it('rejects any ignored files in an explicit legacy directory', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    const legacy = path.join(prefix, 'app', 'legacy-v1');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    git(path.dirname(legacy), ['clone', remote, legacy]);
    git(legacy, ['remote', 'set-url', 'origin', canonicalRepo]);
    fs.mkdirSync(path.join(legacy, 'node_modules'));
    fs.writeFileSync(
      path.join(legacy, 'node_modules', 'cache.txt'),
      'ignored\n',
    );
    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--prefix',
        prefix,
        '--instance',
        'legacy-ignored',
        '--migrate-legacy',
        'legacy-v1',
        '--no-service',
        '--no-start',
        '--yes',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ignored files');
    expect(fs.existsSync(path.join(prefix, 'app', 'skoobi-agent'))).toBe(false);
  });

  it('rejects Git links in an explicit legacy directory', () => {
    const remote = createRemote();
    const legacyRemote = createRemote();
    git(legacyRemote, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${'1'.repeat(40)},vendor-module`,
    ]);
    git(legacyRemote, ['commit', '-m', 'add gitlink']);
    const prefix = tempDir();
    const home = tempDir();
    const legacy = path.join(prefix, 'app', 'legacy-v1');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    git(path.dirname(legacy), ['clone', legacyRemote, legacy]);
    git(legacy, ['remote', 'set-url', 'origin', canonicalRepo]);
    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--prefix',
        prefix,
        '--instance',
        'legacy-gitlink',
        '--migrate-legacy',
        'legacy-v1',
        '--no-service',
        '--no-start',
        '--yes',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unsupported Git submodules');
    expect(fs.existsSync(path.join(prefix, 'app', 'skoobi-agent'))).toBe(false);
  });

  it('preserves a verified generic legacy directory during explicit migration', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    const legacy = path.join(prefix, 'app', 'legacy-v1');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    git(path.dirname(legacy), ['clone', remote, legacy]);
    git(legacy, ['remote', 'set-url', 'origin', canonicalRepo]);
    installFixture(remote, prefix, 'legacy', home, [
      '--migrate-legacy',
      'legacy-v1',
    ]);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(path.join(prefix, 'app', 'skoobi-agent'))).toBe(true);
  });

  it('preserves existing owner/runtime/provider/guest config on rerun', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'preserve', home);
    const envFile = path.join(prefix, 'instances', 'preserve', '.env');
    const ownerConfig =
      'ASSISTANT_NAME=OwnerChoice\nRUNTIME=custom\nSKOOBI_MODEL_GATEWAY_TYPE=owner_provider\nSKOOBI_TELEGRAM_GUEST_LIVE_ENABLED=true\n';
    fs.writeFileSync(envFile, ownerConfig, { mode: 0o600 });

    installFixture(remote, prefix, 'preserve', home);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(ownerConfig);
  });

  it('creates private state directories and service umask 0077', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'private', home);
    for (const dir of [
      prefix,
      path.join(prefix, 'instances'),
      path.join(prefix, 'instances', 'private'),
      path.join(prefix, 'instances', 'private', 'store'),
      path.join(prefix, 'instances', 'private', 'groups'),
      path.join(prefix, 'instances', 'private', 'logs'),
      path.join(prefix, 'instances', 'private', 'data'),
      path.join(prefix, 'backups'),
      path.join(prefix, 'backups', 'instances'),
      path.join(prefix, 'backups', 'instances', 'private'),
    ]) {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(
      fs.lstatSync(path.join(home, '.local', 'bin', 'skoobi')).isSymbolicLink(),
    ).toBe(true);
    const linux = run('bash', [
      'scripts/install.sh',
      '--print-service',
      'linux',
      '--prefix',
      `${prefix}/quoted"%$cash`,
      '--instance',
      'svc',
    ], {
      env: { HOME: `${home}/literal$home` },
    });
    expect(linux).toContain('UMask=0077');
    expect(linux).toContain('quoted\\"%%$cash');
    expect(linux).toContain('ExecStart=":');
    const workingDirectory = linux
      .split(/\r?\n/u)
      .find((line) => line.startsWith('WorkingDirectory='));
    expect(workingDirectory).toBe(
      `WorkingDirectory=${prefix}/quoted"%%$cash/instances/svc`,
    );
    expect(workingDirectory).not.toContain('WorkingDirectory="');
    expect(linux).toContain(`Environment="HOME=${home}/literal$home"`);
    expect(linux).not.toContain(`Environment="HOME=${home}/literal$$home"`);
    expect(linux).toContain(
      'Environment="SKOOBI_SERVICE_LABEL=com.skoobi.svc"',
    );
    expect(linux).toContain(
      `Environment="PATH=${path.dirname(process.execPath)}:`,
    );
    expect(linux).toContain('/usr/local/opt/node@22/bin');
    const mac = run('bash', [
      'scripts/install.sh',
      '--print-service',
      'macos',
      '--prefix',
      prefix,
      '--instance',
      'svc',
    ]);
    expect(mac).toContain('<key>Umask</key>');
    expect(mac).toContain('<integer>63</integer>');
    expect(mac).toContain('<key>SKOOBI_SERVICE_LABEL</key>');
    expect(mac).toContain('<string>com.skoobi.svc</string>');
    expect(mac).toContain(
      `<string>${path.dirname(process.execPath)}:/opt/homebrew/opt/node@22/bin`,
    );
    expect(mac).toContain('/usr/local/opt/node@22/bin');
  });

  it('warns about missing Linux lingering without changing host policy', () => {
    const prefix = tempDir();
    const home = tempDir();
    const fake = makeFakeCommands({
      uname: 'printf "Linux\\n"',
      loginctl:
        'printf "%s\\n" "$*" >>"$FAKE_CALL_LOG"; [[ "${1:-}" == "show-user" ]] && { printf "no\\n"; exit 0; }; exit 91',
    });
    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--dry-run',
        '--yes',
        '--prefix',
        prefix,
        '--instance',
        'linger-warning',
      ],
      {
        env: {
          HOME: home,
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
          FAKE_CALL_LOG: fake.log,
          SKOOBI_INSTALLER_SKIP_REQUIREMENTS: '1',
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'WARNING: systemd user lingering is not confirmed.',
    );
    const calls = fs.readFileSync(fake.log, 'utf8');
    expect(calls).toContain('show-user');
    expect(calls).not.toContain('enable-linger');
  });

  it('disables Husky installation in managed production builds', () => {
    const remote = createRemote();
    const packageFile = path.join(remote, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as {
      scripts: Record<string, string>;
    };
    packageJson.scripts.prepare =
      'node -e "if(process.env.HUSKY!==\'0\')process.exit(87)"';
    fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
    git(remote, ['add', 'package.json']);
    git(remote, ['commit', '-m', 'require production Husky disable']);

    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'husky-disabled', home);
    expect(
      fs.existsSync(
        path.join(prefix, 'app', 'skoobi-agent', 'dist', 'service.js'),
      ),
    ).toBe(true);
  });

  it('accepts only an unmodified legacy Husky scaffold across the normal lifecycle', () => {
    const remote = createRemote();
    const prefix = path.join(tempDir(), 'managed\\release');
    const home = tempDir();
    installFixture(remote, prefix, 'husky-lifecycle', home);
    let appDir = path.join(prefix, 'app', 'skoobi-agent');

    createLegacyHuskyScaffold(appDir);
    installFixture(remote, prefix, 'husky-lifecycle', home);

    fs.writeFileSync(path.join(remote, 'tracked.txt'), 'next release\n');
    git(remote, ['add', 'tracked.txt']);
    git(remote, ['commit', '-m', 'next fixture release']);
    appDir = path.join(prefix, 'app', 'skoobi-agent');
    createLegacyHuskyScaffold(appDir);
    run(
      'bash',
      [
        'scripts/update.sh',
        '--prefix',
        prefix,
        '--instance',
        'husky-lifecycle',
        '--no-start',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(fs.readFileSync(path.join(appDir, 'tracked.txt'), 'utf8')).toBe(
      'next release\n',
    );

    createLegacyHuskyScaffold(appDir);
    run(
      'bash',
      [
        'scripts/uninstall.sh',
        '--prefix',
        prefix,
        '--instance',
        'husky-lifecycle',
        '--yes',
      ],
      { env: { HOME: home } },
    );
    expect(fs.existsSync(appDir)).toBe(false);
    expect(
      fs.existsSync(path.join(prefix, 'instances', 'husky-lifecycle')),
    ).toBe(true);
  }, 20_000);

  it('preserves a modified legacy Husky scaffold as owner data', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'husky-owner-data', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    createLegacyHuskyScaffold(appDir);
    fs.writeFileSync(
      path.join(appDir, '.husky', '_', 'pre-commit'),
      'owner data\n',
    );

    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--repo',
        canonicalRepo,
        '--ref',
        'main',
        '--prefix',
        prefix,
        '--instance',
        'husky-owner-data',
        '--no-service',
        '--no-start',
        '--yes',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ignored owner files');
    expect(
      fs.readFileSync(
        path.join(appDir, '.husky', '_', 'pre-commit'),
        'utf8',
      ),
    ).toBe('owner data\n');
  });

  it('rolls a reinstall back when the staged build fails', () => {
    const remote = createRemote({ build: buildCommand('old-live\\n') });
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'reinstall', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const oldHead = git(appDir, ['rev-parse', 'HEAD']);
    const oldBuild = fs.readFileSync(
      path.join(appDir, 'dist', 'service.js'),
      'utf8',
    );

    writeFixturePackage(remote, 'node -e "process.exit(9)"');
    git(remote, ['add', '.']);
    git(remote, ['commit', '-m', 'broken']);
    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--prefix',
        prefix,
        '--instance',
        'reinstall',
        '--no-service',
        '--no-start',
        '--yes',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(result.status).not.toBe(0);
    expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(oldHead);
    expect(
      fs.readFileSync(path.join(appDir, 'dist', 'service.js'), 'utf8'),
    ).toBe(oldBuild);
  });

  it('rejects service-file symlinks before modifying an installation', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    const unit = path.join(
      home,
      '.config',
      'systemd',
      'user',
      'skoobi-linked.service',
    );
    const outside = path.join(tempDir(), 'outside.service');
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(outside, 'keep\n');
    fs.symlinkSync(outside, unit);
    const fake = makeFakeCommands({
      uname: 'printf "Linux\\n"',
    });

    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--prefix',
        prefix,
        '--instance',
        'linked',
        '--no-start',
        '--yes',
      ],
      {
        env: transportEnv(remote, home, {
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
        }),
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('symlinked service file');
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep\n');
    expect(fs.existsSync(path.join(prefix, 'app', 'skoobi-agent'))).toBe(false);
  });

  it('writes a regular service file atomically with no temporary residue', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    const fake = makeFakeCommands({
      uname: 'printf "Linux\\n"',
      systemctl:
        'printf "%s\\n" "$*" >>"$FAKE_CALL_LOG"; [[ "$*" == *"is-active"* ]] && exit 4; exit 0',
    });
    const env = transportEnv(remote, home, {
      PATH: `${fake.bin}:${process.env.PATH || ''}`,
      FAKE_CALL_LOG: fake.log,
    });
    run(
      'bash',
      [
        'scripts/install.sh',
        '--prefix',
        prefix,
        '--instance',
        'atomic',
        '--no-start',
        '--yes',
      ],
      { env },
    );
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    const unit = path.join(unitDir, 'skoobi-atomic.service');
    expect(fs.lstatSync(unit).isFile()).toBe(true);
    expect(fs.lstatSync(unit).isSymbolicLink()).toBe(false);
    expect(fs.statSync(unit).mode & 0o777).toBe(0o600);
    expect(
      fs
        .readdirSync(unitDir)
        .some((name) => name.startsWith('.skoobi-service.')),
    ).toBe(false);
  });

  it('backs up tracked, untracked, ignored, and symlink owner changes before forced update', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'forced', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    fs.writeFileSync(path.join(appDir, 'tracked.txt'), 'local edit\n');
    fs.writeFileSync(path.join(appDir, 'local.txt'), 'untracked\n');
    fs.writeFileSync(path.join(appDir, 'private.owner-secret'), 'ignored\n');
    const outside = path.join(tempDir(), 'outside.txt');
    fs.writeFileSync(outside, 'outside\n');
    fs.symlinkSync(outside, path.join(appDir, 'owner-link'));

    fs.writeFileSync(path.join(remote, 'tracked.txt'), 'new release\n');
    git(remote, ['add', '.']);
    git(remote, ['commit', '-m', 'new release']);
    run(
      'bash',
      [
        'scripts/update.sh',
        '--prefix',
        prefix,
        '--instance',
        'forced',
        '--no-start',
        '--force',
        '--yes',
      ],
      { env: transportEnv(remote, home) },
    );

    const backupName = fs
      .readdirSync(path.join(prefix, 'backups'))
      .find((name) => name.startsWith('app-owner-changes-'));
    expect(backupName).toBeTruthy();
    const backup = path.join(prefix, 'backups', backupName!);
    expect(
      fs.readFileSync(path.join(backup, 'tracked.patch'), 'utf8'),
    ).toContain('local edit');
    expect(
      fs.readFileSync(path.join(backup, 'files', 'local.txt'), 'utf8'),
    ).toBe('untracked\n');
    expect(
      fs.readFileSync(
        path.join(backup, 'files', 'private.owner-secret'),
        'utf8',
      ),
    ).toBe('ignored\n');
    expect(
      fs.lstatSync(path.join(backup, 'files', 'owner-link')).isSymbolicLink(),
    ).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside\n');
    expect(fs.readFileSync(path.join(appDir, 'tracked.txt'), 'utf8')).toBe(
      'new release\n',
    );
  });

  it('leaves active release and its build outputs untouched after failed update', () => {
    const remote = createRemote({ build: buildCommand('stable-build\\n') });
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'rollback', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const oldHead = git(appDir, ['rev-parse', 'HEAD']);
    const oldBuild = fs.readFileSync(
      path.join(appDir, 'dist', 'service.js'),
      'utf8',
    );

    writeFixturePackage(remote, 'node -e "process.exit(12)"');
    git(remote, ['add', '.']);
    git(remote, ['commit', '-m', 'broken update']);
    const result = runResult(
      'bash',
      [
        'scripts/update.sh',
        '--prefix',
        prefix,
        '--instance',
        'rollback',
        '--no-start',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(result.status).not.toBe(0);
    expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(oldHead);
    expect(
      fs.readFileSync(path.join(appDir, 'dist', 'service.js'), 'utf8'),
    ).toBe(oldBuild);
  });

  it('quiesces a live service before update, restores it on failure, and honors --no-start', () => {
    const remote = createRemote({ tracked: 'old\n' });
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'update-live', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const oldHead = git(appDir, ['rev-parse', 'HEAD']);
    const unit = path.join(
      home,
      '.config',
      'systemd',
      'user',
      'skoobi-update-live.service',
    );
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, 'managed\n', { mode: 0o600 });
    const serviceState = path.join(tempDir(), 'service-state');
    const startCount = path.join(tempDir(), 'start-count');
    fs.writeFileSync(serviceState, 'active\n');
    fs.writeFileSync(startCount, '0\n');

    fs.writeFileSync(path.join(remote, 'tracked.txt'), 'new\n');
    git(remote, ['add', 'tracked.txt']);
    git(remote, ['commit', '-m', 'new live release']);

    const fake = makeFakeCommands({
      uname: 'printf "Linux\\n"',
      systemctl: `printf 'cmd:%s\\n' "$*" >>"$FAKE_CALL_LOG"
case "\${2:-}" in
  is-enabled) printf 'enabled\\n'; exit 0 ;;
  is-active)
    [[ "$(cat "$SERVICE_STATE")" == "active" ]] && exit 0
    exit 3
    ;;
  stop)
    printf 'stop:%s\\n' "$(tr -d '\\n' <"$APP_SENTINEL")" >>"$FAKE_CALL_LOG"
    printf 'stopped\\n' >"$SERVICE_STATE"
    exit 0
    ;;
  start)
    printf 'start:%s\\n' "$(tr -d '\\n' <"$APP_SENTINEL")" >>"$FAKE_CALL_LOG"
    count="$(cat "$START_COUNT")"
    count=$((count + 1))
    printf '%s\\n' "$count" >"$START_COUNT"
    printf 'active\\n' >"$SERVICE_STATE"
    [[ "$count" != "1" ]] || exit 9
    exit 0
    ;;
  *) exit 0 ;;
esac`,
    });
    const extraEnv = {
      PATH: `${fake.bin}:${process.env.PATH || ''}`,
      APP_SENTINEL: path.join(appDir, 'tracked.txt'),
      FAKE_CALL_LOG: fake.log,
      SERVICE_STATE: serviceState,
      START_COUNT: startCount,
    };
    const failed = runResult(
      'bash',
      [
        'scripts/update.sh',
        '--prefix',
        prefix,
        '--instance',
        'update-live',
      ],
      { env: transportEnv(remote, home, extraEnv) },
    );
    expect(failed.status).not.toBe(0);
    expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(oldHead);
    expect(fs.readFileSync(serviceState, 'utf8').trim()).toBe('active');
    const failedCalls = fs.readFileSync(fake.log, 'utf8');
    const firstStop = failedCalls.indexOf('stop:old');
    const failedStart = failedCalls.indexOf('start:new');
    const rollbackStop = failedCalls.indexOf('stop:new', firstStop + 1);
    const rollbackStart = failedCalls.indexOf('start:old', failedStart + 1);
    expect(firstStop).toBeGreaterThanOrEqual(0);
    expect(failedStart).toBeGreaterThan(firstStop);
    expect(rollbackStop).toBeGreaterThan(failedStart);
    expect(rollbackStart).toBeGreaterThan(rollbackStop);

    const noStart = runResult(
      'bash',
      [
        'scripts/update.sh',
        '--prefix',
        prefix,
        '--instance',
        'update-live',
        '--no-start',
      ],
      { env: transportEnv(remote, home, extraEnv) },
    );
    expect(noStart.status).toBe(0);
    expect(fs.readFileSync(path.join(appDir, 'tracked.txt'), 'utf8')).toBe(
      'new\n',
    );
    expect(fs.readFileSync(serviceState, 'utf8').trim()).toBe('stopped');
    expect(fs.readFileSync(startCount, 'utf8').trim()).toBe('2');

    fs.unlinkSync(unit);
    fs.writeFileSync(serviceState, 'active\n');
    fs.writeFileSync(path.join(remote, 'tracked.txt'), 'newer\n');
    git(remote, ['add', 'tracked.txt']);
    git(remote, ['commit', '-m', 'orphan service target']);
    const orphan = runResult(
      'bash',
      [
        'scripts/update.sh',
        '--prefix',
        prefix,
        '--instance',
        'update-live',
        '--no-start',
      ],
      { env: transportEnv(remote, home, extraEnv) },
    );
    expect(orphan.status).not.toBe(0);
    expect(orphan.stderr).toContain('loaded without its definition');
    expect(fs.readFileSync(path.join(appDir, 'tracked.txt'), 'utf8')).toBe(
      'new\n',
    );
  }, 20_000);

  it('handles interruption immediately before or after the first release rename', () => {
    const realMv = execFileSync('which', ['mv'], {
      encoding: 'utf8',
    }).trim();
    for (const mode of ['before', 'after'] as const) {
      const remote = createRemote({ tracked: 'old\n' });
      const prefix = tempDir();
      const home = tempDir();
      installFixture(remote, prefix, `first-rename-${mode}`, home);
      const appDir = path.join(prefix, 'app', 'skoobi-agent');
      const oldHead = git(appDir, ['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(remote, 'tracked.txt'), 'new\n');
      git(remote, ['add', 'tracked.txt']);
      git(remote, ['commit', '-m', `first rename ${mode}`]);

      const failure =
        mode === 'before'
          ? 'kill -TERM "$PPID"; sleep 0.2; exit 143'
          : `${JSON.stringify(realMv)} "$@"; exit 19`;
      const fake = makeFakeCommands({
        mv: `target="\${!#}"
if [[ "\${1:-}" == */app/skoobi-agent && "$target" == *".skoobi-agent.previous."*/release ]]; then
  ${failure}
fi
exec ${JSON.stringify(realMv)} "$@"`,
      });
      const result = runResult(
        'bash',
        [
          'scripts/update.sh',
          '--prefix',
          prefix,
          '--instance',
          `first-rename-${mode}`,
          '--no-start',
        ],
        {
          env: transportEnv(remote, home, {
            PATH: `${fake.bin}:${process.env.PATH || ''}`,
          }),
        },
      );
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(appDir)).toBe(true);
      expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(oldHead);
      expect(fs.existsSync(path.join(prefix, '.skoobi-operation.lock'))).toBe(
        false,
      );
    }
  }, 20_000);

  it('restores the previous release when SIGTERM arrives between release renames', () => {
    const remote = createRemote({ tracked: 'before\n' });
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'signal', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const oldHead = git(appDir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(remote, 'tracked.txt'), 'after\n');
    git(remote, ['add', 'tracked.txt']);
    git(remote, ['commit', '-m', 'next']);

    const realMv = execFileSync('which', ['mv'], {
      encoding: 'utf8',
    }).trim();
    const fake = makeFakeCommands({
      mv: `target="\${!#}"
if [[ "\${1:-}" == *".skoobi-agent.stage."* && "$target" == */app/skoobi-agent ]]; then
  kill -TERM "$PPID"
  sleep 0.2
  exit 143
fi
exec ${JSON.stringify(realMv)} "$@"`,
    });
    const result = runResult(
      'bash',
      [
        'scripts/update.sh',
        '--prefix',
        prefix,
        '--instance',
        'signal',
        '--no-start',
      ],
      {
        env: transportEnv(remote, home, {
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
        }),
      },
    );
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(appDir)).toBe(true);
    expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(oldHead);
    expect(fs.existsSync(path.join(prefix, '.skoobi-operation.lock'))).toBe(
      false,
    );
  });

  it('rejects a symlinked .git directory before update Git commands run', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'git-link', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const outsideGit = path.join(tempDir(), 'outside.git');
    fs.renameSync(path.join(appDir, '.git'), outsideGit);
    fs.symlinkSync(outsideGit, path.join(appDir, '.git'));
    const result = runResult(
      'bash',
      [
        'scripts/update.sh',
        '--prefix',
        prefix,
        '--instance',
        'git-link',
        '--no-start',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('.git must be a real directory');
    expect(fs.existsSync(path.join(outsideGit, 'config'))).toBe(true);
    expect(fs.lstatSync(path.join(appDir, '.git')).isSymbolicLink()).toBe(true);
  });

  it('refuses forced update when a Git submodule may contain owner data', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'submodule', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const submodule = createRemote({ tracked: 'submodule\n' });
    git(appDir, ['config', 'user.name', 'Skoobi Installer Test']);
    git(appDir, ['config', 'user.email', 'installer@example.invalid']);
    git(appDir, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      submodule,
      'vendor/local',
    ]);
    git(appDir, ['add', '.gitmodules', 'vendor/local']);
    git(appDir, ['commit', '-m', 'owner submodule']);
    fs.writeFileSync(
      path.join(appDir, 'vendor', 'local', 'owner.txt'),
      'owner data\n',
    );

    const result = runResult(
      'bash',
      [
        'scripts/update.sh',
        '--prefix',
        prefix,
        '--instance',
        'submodule',
        '--no-start',
        '--force',
        '--yes',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Git submodules');
    expect(
      fs.readFileSync(
        path.join(appDir, 'vendor', 'local', 'owner.txt'),
        'utf8',
      ),
    ).toBe('owner data\n');
  });

  it('rejects a build that modifies tracked staged source after checkout verification', () => {
    const build =
      "node -e \"const f=require('node:fs');f.writeFileSync('tracked.txt','tampered\\\\n');f.mkdirSync('dist',{recursive:true});f.writeFileSync('dist/service.js','ok')\"";
    const remote = createRemote({ build });
    const prefix = tempDir();
    const home = tempDir();
    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--prefix',
        prefix,
        '--instance',
        'tamper-build',
        '--no-service',
        '--no-start',
        '--yes',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Build modified tracked');
    expect(fs.existsSync(path.join(prefix, 'app', 'skoobi-agent'))).toBe(false);
  });

  it('rejects update from a noncanonical or credential-bearing origin safely', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const appDir = setupManagedClone(remote, prefix, 'origin');
    const secret = 'ORIGIN_SECRET_TOKEN';
    const credentialedOrigin = [
      'https://owner:',
      secret,
      '@example.invalid/repo.git?token=',
      secret,
    ].join('');
    git(appDir, ['remote', 'set-url', 'origin', credentialedOrigin]);
    const result = runResult('bash', [
      'scripts/update.sh',
      '--prefix',
      prefix,
      '--instance',
      'origin',
      '--ref',
      'refs/heads/main',
      '--expected-commit',
      '1111111111111111111111111111111111111111',
      '--no-start',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('canonical public HTTPS');
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it('refuses default uninstall when ignored owner data exists, then backs it up with explicit force', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'owner-data', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const instanceDir = path.join(prefix, 'instances', 'owner-data');
    fs.writeFileSync(
      path.join(appDir, 'private.owner-secret'),
      'preserve me\n',
    );

    const refused = runResult(
      'bash',
      ['scripts/uninstall.sh', '--prefix', prefix, '--instance', 'owner-data'],
      { env: { HOME: home } },
    );
    expect(refused.status).not.toBe(0);
    expect(fs.existsSync(appDir)).toBe(true);

    run(
      'bash',
      [
        'scripts/uninstall.sh',
        '--prefix',
        prefix,
        '--instance',
        'owner-data',
        '--force',
        '--yes',
      ],
      { env: { HOME: home } },
    );
    expect(fs.existsSync(appDir)).toBe(false);
    expect(fs.existsSync(instanceDir)).toBe(true);
    const backupName = fs
      .readdirSync(path.join(prefix, 'backups'))
      .find((name) => name.startsWith('uninstall-owner-changes-'));
    expect(
      fs.readFileSync(
        path.join(
          prefix,
          'backups',
          backupName!,
          'files',
          'private.owner-secret',
        ),
        'utf8',
      ),
    ).toBe('preserve me\n');
  });

  it('leaves FIFO and socket owner nodes in place instead of deleting an incomplete backup', async () => {
    const remote = createRemote();

    const fifoPrefix = tempDir();
    const fifoHome = tempDir();
    installFixture(remote, fifoPrefix, 'fifo', fifoHome);
    const fifoApp = path.join(fifoPrefix, 'app', 'skoobi-agent');
    const fifo = path.join(fifoApp, 'tracked.txt');
    fs.rmSync(fifo);
    execFileSync('mkfifo', [fifo]);
    const fifoResult = runResult(
      'bash',
      [
        'scripts/uninstall.sh',
        '--prefix',
        fifoPrefix,
        '--instance',
        'fifo',
        '--force',
        '--yes',
      ],
      { env: { HOME: fifoHome } },
    );
    expect(fifoResult.status).not.toBe(0);
    expect(fifoResult.stderr).toContain('FIFO, socket, or device');
    expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
    expect(fs.existsSync(fifoApp)).toBe(true);

    const socketPrefix = fs.mkdtempSync('/tmp/skoobi-socket-');
    const socketHome = tempDir();
    installFixture(remote, socketPrefix, 'socket', socketHome);
    const socketApp = path.join(socketPrefix, 'app', 'skoobi-agent');
    const socketPath = path.join(socketApp, 'owner.sock');
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      const socketResult = runResult(
        'bash',
        [
          'scripts/uninstall.sh',
          '--prefix',
          socketPrefix,
          '--instance',
          'socket',
          '--force',
          '--yes',
        ],
        { env: { HOME: socketHome } },
      );
      expect(socketResult.status).not.toBe(0);
      expect(socketResult.stderr).toContain('FIFO, socket, or device');
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      expect(fs.existsSync(socketApp)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('quarantines an unverified app intact on explicit forced uninstall', () => {
    const prefix = tempDir();
    const home = tempDir();
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'owner-file.txt'), 'keep\n');
    fs.mkdirSync(path.join(prefix, 'instances', 'quarantine'), {
      recursive: true,
    });

    run(
      'bash',
      [
        'scripts/uninstall.sh',
        '--prefix',
        prefix,
        '--instance',
        'quarantine',
        '--force',
        '--yes',
      ],
      { env: { HOME: home } },
    );
    expect(fs.existsSync(appDir)).toBe(false);
    const quarantine = fs
      .readdirSync(path.join(prefix, 'backups'))
      .find((name) => name.startsWith('unverified-app-'));
    expect(
      fs.readFileSync(
        path.join(
          prefix,
          'backups',
          quarantine!,
          'skoobi-agent',
          'owner-file.txt',
        ),
        'utf8',
      ),
    ).toBe('keep\n');
  });

  it('uses an unpredictable private quarantine container instead of a precreated target', () => {
    const prefix = tempDir();
    const home = tempDir();
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const backups = path.join(prefix, 'backups');
    const outside = tempDir();
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(backups);
    fs.mkdirSync(path.join(prefix, 'instances', 'quarantine-race'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(appDir, 'owner.txt'), 'preserve\n');
    fs.symlinkSync(outside, path.join(backups, 'unverified-app-predictable'));

    run(
      'bash',
      [
        'scripts/uninstall.sh',
        '--prefix',
        prefix,
        '--instance',
        'quarantine-race',
        '--force',
        '--yes',
      ],
      { env: { HOME: home } },
    );
    expect(fs.readdirSync(outside)).toEqual([]);
    const roots = fs
      .readdirSync(backups)
      .filter(
        (name) =>
          name.startsWith('unverified-app-') &&
          name !== 'unverified-app-predictable',
      );
    expect(roots).toHaveLength(1);
    expect(
      fs.readFileSync(
        path.join(backups, roots[0]!, 'skoobi-agent', 'owner.txt'),
        'utf8',
      ),
    ).toBe('preserve\n');
  });

  it('does not remove app files when the service cannot be proven stopped', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'live', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const unit = path.join(
      home,
      '.config',
      'systemd',
      'user',
      'skoobi-live.service',
    );
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, 'managed\n');
    const fake = makeFakeCommands({
      uname: 'printf "Linux\\n"',
      systemctl:
        'printf "%s\\n" "$*" >>"$FAKE_CALL_LOG"; [[ "$*" == *"is-active"* ]] && exit 0; exit 0',
    });
    const result = runResult(
      'bash',
      ['scripts/uninstall.sh', '--prefix', prefix, '--instance', 'live'],
      {
        env: {
          HOME: home,
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
          FAKE_CALL_LOG: fake.log,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('still active');
    expect(fs.existsSync(appDir)).toBe(true);
    expect(fs.existsSync(unit)).toBe(true);
  });

  it('stops a loaded systemd job even when its unit file is already missing', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'orphan-job', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const serviceState = path.join(tempDir(), 'service-state');
    fs.writeFileSync(serviceState, 'active\n');
    const fake = makeFakeCommands({
      uname: 'printf "Linux\\n"',
      systemctl: `printf '%s\\n' "$*" >>"$FAKE_CALL_LOG"
case "\${2:-}" in
  is-active)
    [[ "$(cat "$SERVICE_STATE")" == "active" ]] && exit 0
    exit 3
    ;;
  stop)
    printf 'stopped\\n' >"$SERVICE_STATE"
    exit 0
    ;;
  *) exit 0 ;;
esac`,
    });

    const result = runResult(
      'bash',
      [
        'scripts/uninstall.sh',
        '--prefix',
        prefix,
        '--instance',
        'orphan-job',
        '--yes',
      ],
      {
        env: {
          HOME: home,
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
          FAKE_CALL_LOG: fake.log,
          SERVICE_STATE: serviceState,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(appDir)).toBe(false);
    expect(fs.readFileSync(serviceState, 'utf8').trim()).toBe('stopped');
    expect(fs.readFileSync(fake.log, 'utf8')).toContain(
      '--user stop skoobi-orphan-job',
    );
  });

  it('treats a systemctl transport failure as unknown, not as stopped', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'transport', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const unit = path.join(
      home,
      '.config',
      'systemd',
      'user',
      'skoobi-transport.service',
    );
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, 'managed\n');
    const fake = makeFakeCommands({
      uname: 'printf "Linux\\n"',
      systemctl:
        '[[ "$*" == *"is-active"* ]] && { printf "Failed to connect to bus\\n" >&2; exit 1; }; exit 0',
    });
    const result = runResult(
      'bash',
      ['scripts/uninstall.sh', '--prefix', prefix, '--instance', 'transport'],
      {
        env: {
          HOME: home,
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('could not prove');
    expect(fs.existsSync(appDir)).toBe(true);
    expect(fs.existsSync(unit)).toBe(true);
  });

  it('disables launchd KeepAlive before bootout during uninstall', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'macstop', home);
    const plist = path.join(
      home,
      'Library',
      'LaunchAgents',
      'com.skoobi.macstop.plist',
    );
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, 'managed\n');
    const fake = makeFakeCommands({
      uname: 'printf "Darwin\\n"',
      launchctl:
        'printf "%s\\n" "$*" >>"$FAKE_CALL_LOG"; [[ "${1:-}" == "print" && "${2:-}" == */*/* ]] && exit 113; exit 0',
    });
    run(
      'bash',
      ['scripts/uninstall.sh', '--prefix', prefix, '--instance', 'macstop'],
      {
        env: {
          HOME: home,
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
          FAKE_CALL_LOG: fake.log,
        },
      },
    );
    const calls = fs.readFileSync(fake.log, 'utf8');
    expect(calls.indexOf('disable gui/')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('bootout gui/')).toBeGreaterThan(
      calls.indexOf('disable gui/'),
    );
    expect(fs.existsSync(plist)).toBe(false);
  });

  it('preserves files when launchd cannot prove uninstall stopped the service', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'mac-unknown', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const plist = path.join(
      home,
      'Library',
      'LaunchAgents',
      'com.skoobi.mac-unknown.plist',
    );
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, 'managed\n');
    const fake = makeFakeCommands({
      uname: 'printf "Darwin\\n"',
      launchctl: '[[ "${1:-}" == "print" ]] && exit 1; exit 0',
    });
    const result = runResult(
      'bash',
      [
        'scripts/uninstall.sh',
        '--prefix',
        prefix,
        '--instance',
        'mac-unknown',
      ],
      {
        env: {
          HOME: home,
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('could not prove');
    expect(fs.existsSync(appDir)).toBe(true);
    expect(fs.existsSync(plist)).toBe(true);
  });

  it('CLI stop disables launchd KeepAlive and proves bootout completed', () => {
    const home = tempDir();
    const prefix = tempDir();
    const preload = path.join(tempDir(), 'darwin-platform.cjs');
    fs.writeFileSync(
      preload,
      "Object.defineProperty(process, 'platform', { value: 'darwin' });\n",
    );
    const fake = makeFakeCommands({
      launchctl:
        'printf "%s\\n" "$*" >>"$FAKE_CALL_LOG"; [[ "${1:-}" == "print" && "${2:-}" == */*/* ]] && exit 113; exit 0',
    });
    const result = runResult(
      'node',
      [
        '--require',
        preload,
        'bin/skoobi.js',
        'stop',
        '--prefix',
        prefix,
        '--instance',
        'clistop',
      ],
      {
        env: {
          HOME: home,
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
          FAKE_CALL_LOG: fake.log,
        },
      },
    );
    expect(result.status).toBe(0);
    const calls = fs.readFileSync(fake.log, 'utf8');
    expect(calls.indexOf('disable gui/')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('bootout gui/')).toBeGreaterThan(
      calls.indexOf('disable gui/'),
    );
    expect(calls.indexOf('print gui/')).toBeGreaterThan(
      calls.indexOf('bootout gui/'),
    );
  });

  it('CLI stop rejects a launchd transport failure instead of calling it stopped', () => {
    const home = tempDir();
    const prefix = tempDir();
    const preload = path.join(tempDir(), 'darwin-platform.cjs');
    fs.writeFileSync(
      preload,
      "Object.defineProperty(process, 'platform', { value: 'darwin' });\n",
    );
    const fake = makeFakeCommands({
      launchctl: '[[ "${1:-}" == "print" ]] && exit 1; exit 0',
    });
    const result = runResult(
      'node',
      [
        '--require',
        preload,
        'bin/skoobi.js',
        'stop',
        '--prefix',
        prefix,
        '--instance',
        'cli-mac-transport',
      ],
      {
        env: {
          HOME: home,
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('could not prove');
  });

  it('CLI stop rejects a systemd transport failure instead of calling it stopped', () => {
    const home = tempDir();
    const prefix = tempDir();
    const preload = path.join(tempDir(), 'linux-platform.cjs');
    fs.writeFileSync(
      preload,
      "Object.defineProperty(process, 'platform', { value: 'linux' });\n",
    );
    const fake = makeFakeCommands({
      systemctl:
        '[[ "$*" == *"is-active"* ]] && { printf "Failed to connect to bus\\n" >&2; exit 1; }; exit 0',
    });
    const result = runResult(
      'node',
      [
        '--require',
        preload,
        'bin/skoobi.js',
        'stop',
        '--prefix',
        prefix,
        '--instance',
        'cli-transport',
      ],
      {
        env: {
          HOME: home,
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('could not prove');
  });

  it('rejects HOME newlines before rendering a systemd unit', () => {
    const injected = 'INJECTED_SYSTEMD_DIRECTIVE';
    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--print-service',
        'linux',
        '--prefix',
        tempDir(),
        '--instance',
        'newline',
      ],
      {
        env: {
          HOME: `${tempDir()}\n[Service]\nExecStart=${injected}`,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('HOME must not contain newlines');
    expect(result.stdout).not.toContain(injected);
  });

  it('does not execute a lifecycle script through a forged marker and scripts symlink', () => {
    const prefix = tempDir();
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const externalScripts = tempDir();
    const sentinel = path.join(tempDir(), 'external-script-ran');
    fs.mkdirSync(path.join(appDir, '.git'), { recursive: true });
    fs.symlinkSync(externalScripts, path.join(appDir, 'scripts'));
    fs.writeFileSync(
      path.join(externalScripts, 'update.sh'),
      `#!/bin/sh\n: >${JSON.stringify(sentinel)}\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(externalScripts, 'uninstall.sh'),
      '#!/bin/sh\nexit 0\n',
      { mode: 0o755 },
    );
    writeMarker(prefix);
    const result = runResult('node', [
      'bin/skoobi.js',
      'update',
      '--prefix',
      prefix,
      '--instance',
      'forged',
      '--ref',
      'refs/heads/main',
      '--expected-commit',
      '1111111111111111111111111111111111111111',
      '--dry-run',
      '--no-start',
    ]);
    expect(result.status).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('never follows symlinked log files or log directories', () => {
    const prefix = tempDir();
    const instanceDir = path.join(prefix, 'instances', 'logs');
    const logsDir = path.join(instanceDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const secret = 'AUTH_FILE_SECRET_MUST_NOT_PRINT';
    const outside = path.join(tempDir(), 'auth.json');
    fs.writeFileSync(outside, secret);
    fs.symlinkSync(outside, path.join(logsDir, 'service.out.log'));
    const fileResult = run('node', [
      'bin/skoobi.js',
      'logs',
      '--prefix',
      prefix,
      '--instance',
      'logs',
    ]);
    expect(fileResult).toContain('No safe log files');
    expect(fileResult).not.toContain(secret);

    fs.rmSync(logsDir, { recursive: true });
    const outsideDir = tempDir();
    fs.writeFileSync(path.join(outsideDir, 'service.out.log'), secret);
    fs.symlinkSync(outsideDir, logsDir);
    const dirResult = run('node', [
      'bin/skoobi.js',
      'logs',
      '--prefix',
      prefix,
      '--instance',
      'logs',
    ]);
    expect(dirResult).toContain('No safe log files');
    expect(dirResult).not.toContain(secret);
  });

  it('reads recent Linux service logs from the user journal', () => {
    const prefix = tempDir();
    const home = tempDir();
    const preload = path.join(tempDir(), 'linux-platform.cjs');
    fs.writeFileSync(
      preload,
      "Object.defineProperty(process, 'platform', { value: 'linux' });\n",
    );
    const fake = makeFakeCommands({
      journalctl:
        'printf "%s\\n" "$*" >>"$FAKE_CALL_LOG"; printf "journal smoke line\\n"',
    });
    const result = runResult(
      'node',
      [
        '--require',
        preload,
        'bin/skoobi.js',
        'logs',
        '--prefix',
        prefix,
        '--instance',
        'journal',
      ],
      {
        env: {
          HOME: home,
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
          FAKE_CALL_LOG: fake.log,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('journal smoke line');
    expect(fs.readFileSync(fake.log, 'utf8')).toContain(
      '--user --unit skoobi-journal --lines 80 --no-pager',
    );
  });

  it('never restores an instance .env from an incomplete backup copy', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'env-copy', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const envFile = path.join(prefix, 'instances', 'env-copy', '.env');
    const originalEnv = fs.readFileSync(envFile);
    const originalHead = git(appDir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(remote, 'tracked.txt'), 'new release\n');
    git(remote, ['add', 'tracked.txt']);
    git(remote, ['commit', '-m', 'new release']);

    const realCp = execFileSync('which', ['cp'], { encoding: 'utf8' }).trim();
    const fake = makeFakeCommands({
      cp: `if [[ "\${1:-}" == "$TARGET_ENV" && "\${2:-}" == *"/.env-backup-pending."* ]]; then
  printf 'partial backup\\n' >"\${2}"
  exit 19
fi
exec ${JSON.stringify(realCp)} "$@"`,
    });
    const result = runResult(
      'bash',
      [
        'scripts/install.sh',
        '--repo',
        canonicalRepo,
        '--ref',
        'main',
        '--prefix',
        prefix,
        '--instance',
        'env-copy',
        '--no-service',
        '--no-start',
        '--yes',
        '--reconfigure',
      ],
      {
        env: transportEnv(remote, home, {
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
          TARGET_ENV: envFile,
          SKOOBI_TELEGRAM_BOT_TOKEN: 'replacement-secret-must-not-print',
        }),
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('replacement-secret-must-not-print');
    expect(fs.readFileSync(envFile)).toEqual(originalEnv);
    expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(originalHead);
    const backupDir = path.join(
      prefix,
      'backups',
      'instances',
      'env-copy',
    );
    expect(
      fs
        .readdirSync(backupDir)
        .some((entry) => entry.startsWith('.env-backup-pending.')),
    ).toBe(false);
  });

  it('restores an owner CLI path when mv or ln fails before or after effect', () => {
    const realMv = execFileSync('which', ['mv'], { encoding: 'utf8' }).trim();
    const realLn = execFileSync('which', ['ln'], { encoding: 'utf8' }).trim();
    for (const operation of ['mv', 'ln'] as const) {
      for (const mode of ['before', 'after'] as const) {
        const remote = createRemote();
        const prefix = tempDir();
        const home = tempDir();
        const ownerCli = path.join(home, '.local', 'bin', 'skoobi');
        fs.mkdirSync(path.dirname(ownerCli), { recursive: true });
        fs.writeFileSync(ownerCli, `owner cli ${operation}-${mode}\n`);

        const commands: Record<string, string> =
          operation === 'mv'
            ? {
                mv: `if [[ "\${1:-}" == "$OWNER_CLI" ]]; then
  [[ "$FAIL_MODE" != "before" ]] || exit 19
  ${JSON.stringify(realMv)} "$@"
  exit 19
fi
exec ${JSON.stringify(realMv)} "$@"`,
              }
            : {
                ln: `target="\${!#}"
if [[ "\${1:-}" == "-s" && "$target" == "$OWNER_CLI" ]]; then
  [[ "$FAIL_MODE" != "before" ]] || exit 19
  ${JSON.stringify(realLn)} "$@"
  exit 19
fi
exec ${JSON.stringify(realLn)} "$@"`,
              };
        const fake = makeFakeCommands(commands);
        const result = runResult(
          'bash',
          [
            'scripts/install.sh',
            '--repo',
            canonicalRepo,
            '--ref',
            'main',
            '--prefix',
            prefix,
            '--instance',
            `cli-${operation}-${mode}`,
            '--no-service',
            '--no-start',
            '--yes',
          ],
          {
            env: transportEnv(remote, home, {
              PATH: `${fake.bin}:${process.env.PATH || ''}`,
              OWNER_CLI: ownerCli,
              FAIL_MODE: mode,
            }),
          },
        );
        expect(result.status).not.toBe(0);
        expect(fs.lstatSync(ownerCli).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(ownerCli, 'utf8')).toBe(
          `owner cli ${operation}-${mode}\n`,
        );
        expect(fs.existsSync(path.join(prefix, 'app', 'skoobi-agent'))).toBe(
          false,
        );
        expect(fs.existsSync(path.join(prefix, '.skoobi-operation.lock'))).toBe(
          false,
        );
      }
    }
  }, 20_000);

  it('keeps a committed release and clears its lock after a cleanup signal', () => {
    const realRm = execFileSync('which', ['rm'], { encoding: 'utf8' }).trim();
    for (const operation of ['install', 'update'] as const) {
      const remote = createRemote();
      const prefix = tempDir();
      const home = tempDir();
      installFixture(remote, prefix, `committed-${operation}`, home);
      const appDir = path.join(prefix, 'app', 'skoobi-agent');
      fs.writeFileSync(path.join(remote, 'tracked.txt'), `${operation} new\n`);
      git(remote, ['add', 'tracked.txt']);
      git(remote, ['commit', '-m', `${operation} new release`]);
      const newHead = git(remote, ['rev-parse', 'HEAD']);
      const fake = makeFakeCommands({
        rm: `if [[ "\${1:-}" == "-rf" && "\${2:-}" == *".skoobi-agent.previous."*/release ]]; then
  ${JSON.stringify(realRm)} "$@"
  kill -TERM "$PPID"
  sleep 0.2
  exit 143
fi
exec ${JSON.stringify(realRm)} "$@"`,
      });
      const args =
        operation === 'install'
          ? [
              'scripts/install.sh',
              '--repo',
              canonicalRepo,
              '--ref',
              'main',
              '--prefix',
              prefix,
              '--instance',
              `committed-${operation}`,
              '--no-service',
              '--no-start',
              '--yes',
            ]
          : [
              'scripts/update.sh',
              '--prefix',
              prefix,
              '--instance',
              `committed-${operation}`,
              '--no-start',
            ];
      const result = runResult('bash', args, {
        env: transportEnv(remote, home, {
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
        }),
      });
      expect(result.status).not.toBe(0);
      expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(newHead);
      expect(fs.readFileSync(path.join(appDir, 'tracked.txt'), 'utf8')).toBe(
        `${operation} new\n`,
      );
      expect(fs.existsSync(path.join(prefix, '.skoobi-operation.lock'))).toBe(
        false,
      );
    }
  }, 20_000);

  it('fails closed on unknown launchd state before install or update activation', () => {
    for (const operation of ['install', 'update'] as const) {
      const remote = createRemote();
      const prefix = tempDir();
      const home = tempDir();
      const instance = `launchd-unknown-${operation}`;
      let previousHead = '';
      if (operation === 'update') {
        installFixture(remote, prefix, instance, home);
        previousHead = git(
          path.join(prefix, 'app', 'skoobi-agent'),
          ['rev-parse', 'HEAD'],
        );
        fs.writeFileSync(path.join(remote, 'tracked.txt'), 'new release\n');
        git(remote, ['add', 'tracked.txt']);
        git(remote, ['commit', '-m', 'new release']);
      }
      const fake = makeFakeCommands({
        uname: 'printf "Darwin\\n"',
        launchctl: '[[ "${1:-}" == "print" ]] && exit 1; exit 0',
      });
      const args =
        operation === 'install'
          ? [
              'scripts/install.sh',
              '--repo',
              canonicalRepo,
              '--ref',
              'main',
              '--prefix',
              prefix,
              '--instance',
              instance,
              '--no-service',
              '--no-start',
              '--yes',
            ]
          : [
              'scripts/update.sh',
              '--prefix',
              prefix,
              '--instance',
              instance,
              '--no-start',
            ];
      const result = runResult('bash', args, {
        env: transportEnv(remote, home, {
          PATH: `${fake.bin}:${process.env.PATH || ''}`,
        }),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr.toLowerCase()).toContain('could not prove');
      const appDir = path.join(prefix, 'app', 'skoobi-agent');
      if (operation === 'install') {
        expect(fs.existsSync(appDir)).toBe(false);
      } else {
        expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(previousHead);
      }
      expect(fs.existsSync(path.join(prefix, '.skoobi-operation.lock'))).toBe(
        false,
      );
    }
  }, 20_000);

  it('refuses concurrent lifecycle operations while the prefix lock exists', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'locked', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const head = git(appDir, ['rev-parse', 'HEAD']);
    fs.mkdirSync(path.join(prefix, '.skoobi-operation.lock'));
    const result = runResult(
      'bash',
      [
        'scripts/update.sh',
        '--prefix',
        prefix,
        '--instance',
        'locked',
        '--no-start',
      ],
      { env: transportEnv(remote, home) },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('operation is in progress');
    expect(git(appDir, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('purge mismatch removes nothing', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'purge', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const instanceDir = path.join(prefix, 'instances', 'purge');
    const result = runResult(
      'bash',
      [
        'scripts/uninstall.sh',
        '--prefix',
        prefix,
        '--instance',
        'purge',
        '--purge',
      ],
      {
        env: {
          HOME: home,
          SKOOBI_PURGE_CONFIRMATION: 'wrong',
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(appDir)).toBe(true);
    expect(fs.existsSync(instanceDir)).toBe(true);
  });

  it('purges only validated backups for the selected instance', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'purge-safe', home);
    const instanceDir = path.join(prefix, 'instances', 'purge-safe');
    const backups = path.join(prefix, 'backups');
    const instanceBackups = path.join(backups, 'instances', 'purge-safe');
    const otherBackups = path.join(backups, 'instances', 'other');
    fs.mkdirSync(instanceBackups, { recursive: true, mode: 0o700 });
    fs.mkdirSync(otherBackups, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(instanceBackups, 'env.bak.A1b2C3d4'),
      'selected token backup\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(backups, 'purge-safe.env.bak.Z9y8X7w6'),
      'legacy selected token backup\n',
      { mode: 0o600 },
    );
    const otherSentinel = path.join(otherBackups, 'env.bak.Q1w2E3r4');
    fs.writeFileSync(otherSentinel, 'other instance\n', { mode: 0o600 });
    const globalSentinel = path.join(backups, 'app-owner-changes-keep');
    fs.mkdirSync(globalSentinel, { mode: 0o700 });

    run(
      'bash',
      [
        'scripts/uninstall.sh',
        '--prefix',
        prefix,
        '--instance',
        'purge-safe',
        '--purge',
        '--yes',
      ],
      {
        env: {
          HOME: home,
          SKOOBI_PURGE_CONFIRMATION: 'DELETE Skoobi data',
        },
      },
    );
    expect(fs.existsSync(instanceDir)).toBe(false);
    expect(fs.existsSync(instanceBackups)).toBe(false);
    expect(
      fs.existsSync(path.join(backups, 'purge-safe.env.bak.Z9y8X7w6')),
    ).toBe(false);
    expect(fs.readFileSync(otherSentinel, 'utf8')).toBe('other instance\n');
    expect(fs.existsSync(globalSentinel)).toBe(true);
  });

  it('purges successfully with no instance env backups on macOS Bash 3.2', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'purge-empty', home);

    const result = runResult(
      '/bin/bash',
      [
        'scripts/uninstall.sh',
        '--prefix',
        prefix,
        '--instance',
        'purge-empty',
        '--purge',
        '--yes',
      ],
      {
        env: {
          HOME: home,
          SKOOBI_PURGE_CONFIRMATION: 'DELETE Skoobi data',
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(
      fs.existsSync(path.join(prefix, 'instances', 'purge-empty')),
    ).toBe(false);
  });

  it('stops purge before removal when an instance backup path is unexpected', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const home = tempDir();
    installFixture(remote, prefix, 'purge-owner', home);
    const appDir = path.join(prefix, 'app', 'skoobi-agent');
    const instanceDir = path.join(prefix, 'instances', 'purge-owner');
    const ownerBackup = path.join(
      prefix,
      'backups',
      'purge-owner.env.bak.owner-data',
    );
    fs.writeFileSync(ownerBackup, 'preserve\n', { mode: 0o600 });

    const result = runResult(
      'bash',
      [
        'scripts/uninstall.sh',
        '--prefix',
        prefix,
        '--instance',
        'purge-owner',
        '--purge',
        '--yes',
      ],
      {
        env: {
          HOME: home,
          SKOOBI_PURGE_CONFIRMATION: 'DELETE Skoobi data',
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'purge stopped before removal',
    );
    expect(fs.existsSync(appDir)).toBe(true);
    expect(fs.existsSync(instanceDir)).toBe(true);
    expect(fs.readFileSync(ownerBackup, 'utf8')).toBe('preserve\n');
  });

  it('CLI ignores an arbitrary app-dir override and selects only a marked install', () => {
    const remote = createRemote();
    const prefix = tempDir();
    const appDir = setupManagedClone(remote, prefix, 'cli');
    fs.mkdirSync(path.join(appDir, 'scripts'));
    fs.writeFileSync(path.join(appDir, 'scripts', 'update.sh'), '#!/bin/sh\n');
    fs.writeFileSync(
      path.join(appDir, 'scripts', 'uninstall.sh'),
      '#!/bin/sh\n',
    );
    const out = run(
      'node',
      ['bin/skoobi.js', 'paths', '--prefix', prefix, '--instance', 'cli'],
      { env: { SKOOBI_APP_DIR: '/tmp/attacker-controlled-app' } },
    );
    const parsed = JSON.parse(out) as Record<string, string>;
    expect(parsed.appDir).toBe(appDir);
    expect(parsed.appDir).not.toContain('attacker-controlled');
  });
});
