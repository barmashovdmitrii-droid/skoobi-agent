import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '@skoobi/shared/env';

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
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
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
    ...extra,
    PATH: `${transportBin}:${requestedPath}`,
  };
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
    fs.writeFileSync(file, `#!/usr/bin/env bash\nset -eu\n${body}\n`, {
      mode: 0o755,
    });
  }
  return { bin, log };
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
    const ownerEnv = 'ASSISTANT_NAME=OwnerOriginal\nRUNTIME=owner-runtime\n';
    fs.writeFileSync(envFile, ownerEnv, { mode: 0o600 });
    const fake = makeFakeCommands({
      uname: 'printf "Linux\\n"',
      systemctl:
        '[[ "$*" == *"is-active"* ]] && exit 4; [[ "$*" == *"enable --now"* ]] && exit 9; exit 0',
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
          SKOOBI_ASSISTANT_NAME: 'Replacement',
        }),
      },
    );
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(ownerEnv);
    expect(fs.existsSync(path.join(prefix, '.skoobi-operation.lock'))).toBe(
      false,
    );
  });

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
    ]) {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
    const linux = run('bash', [
      'scripts/install.sh',
      '--print-service',
      'linux',
      '--prefix',
      `${prefix}/quoted"%dir`,
      '--instance',
      'svc',
    ]);
    expect(linux).toContain('UMask=0077');
    expect(linux).toContain('quoted\\"%%dir');
    expect(linux).toContain(
      'Environment="SKOOBI_SERVICE_LABEL=com.skoobi.svc"',
    );
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
        'printf "%s\\n" "$*" >>"$FAKE_CALL_LOG"; [[ "$*" == *"is-active"* ]] && exit 1; exit 0',
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
        'printf "%s\\n" "$*" >>"$FAKE_CALL_LOG"; [[ "${1:-}" == "print" ]] && exit 1; exit 0',
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
        'printf "%s\\n" "$*" >>"$FAKE_CALL_LOG"; [[ "${1:-}" == "print" ]] && exit 1; exit 0',
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
