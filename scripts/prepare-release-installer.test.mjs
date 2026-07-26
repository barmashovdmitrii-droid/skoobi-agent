import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { prepareReleaseInstaller } from './prepare-release-installer.mjs';

const INSTALLER_FIXTURE = [
  '#!/usr/bin/env bash',
  'REF_DEFAULT="main"',
  'EXPECTED_COMMIT_DEFAULT=""',
  '# --ref <branch/tag> Git branch or tag (release assets are tag-pinned)',
  'exit 0',
  '',
].join('\n');
const COMMIT = 'a'.repeat(40);

describe('prepareReleaseInstaller', () => {
  it('pins a strict SemVer tag and exact commit as quoted shell literals', () => {
    const output = prepareReleaseInstaller({
      installerText: INSTALLER_FIXTURE,
      packageText: JSON.stringify({ version: '2.0.0-rc.1' }),
      tag: 'v2.0.0-rc.1',
      commit: COMMIT,
    });

    expect(output).toContain("REF_DEFAULT='refs/tags/v2.0.0-rc.1'");
    expect(output).toContain(`EXPECTED_COMMIT_DEFAULT='${COMMIT}'`);
    expect(output).toContain('release assets are tag-pinned');
    expect(output).not.toContain('default: main');
    expect(() =>
      execFileSync('bash', ['-n'], {
        input: output,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    ).not.toThrow();
  });

  it('runs the CLI when its entrypoint is reached through a symlink', () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-release-installer-cli-'),
    );
    try {
      const entrypoint = path.join(directory, 'prepare-release-installer.mjs');
      const installer = path.join(directory, 'install.sh');
      const packageFile = path.join(directory, 'package.json');
      symlinkSync(
        fileURLToPath(
          new URL('./prepare-release-installer.mjs', import.meta.url),
        ),
        entrypoint,
      );
      writeFileSync(installer, INSTALLER_FIXTURE);
      writeFileSync(packageFile, JSON.stringify({ version: '2.0.0-rc.1' }));

      execFileSync(process.execPath, [
        entrypoint,
        '--installer',
        installer,
        '--package',
        packageFile,
        '--tag',
        'v2.0.0-rc.1',
        '--commit',
        COMMIT,
      ]);

      const output = readFileSync(installer, 'utf8');
      expect(output).toContain("REF_DEFAULT='refs/tags/v2.0.0-rc.1'");
      expect(output).toContain(`EXPECTED_COMMIT_DEFAULT='${COMMIT}'`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects shell metacharacters before writing a release installer', () => {
    const injected = ['2.0.0-rc.1', '$(touch${IFS}/tmp/not-allowed)'].join('');
    expect(() =>
      prepareReleaseInstaller({
        installerText: INSTALLER_FIXTURE,
        packageText: JSON.stringify({ version: injected }),
        tag: `v${injected}`,
        commit: COMMIT,
      }),
    ).toThrow(/strict SemVer/u);
    expect(() =>
      prepareReleaseInstaller({
        installerText: INSTALLER_FIXTURE,
        packageText: JSON.stringify({ version: '2.0.0+build.1' }),
        tag: 'v2.0.0+build.1',
        commit: COMMIT,
      }),
    ).toThrow(/without build metadata/u);
  });

  it('rejects ambiguous SemVer forms with leading zeroes or empty identifiers', () => {
    for (const version of [
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1..2',
      '1.2.',
      '1.2.3-rc..1',
      '1.2.3-01',
    ]) {
      expect(() =>
        prepareReleaseInstaller({
          installerText: INSTALLER_FIXTURE,
          packageText: JSON.stringify({ version }),
          tag: `v${version}`,
          commit: COMMIT,
        }),
      ).toThrow(/strict SemVer/u);
    }
  });

  it('rejects mismatched tags, malformed commits, and ambiguous placeholders', () => {
    expect(() =>
      prepareReleaseInstaller({
        installerText: INSTALLER_FIXTURE,
        packageText: JSON.stringify({ version: '2.0.0' }),
        tag: 'v2.0.1',
        commit: COMMIT,
      }),
    ).toThrow(/does not match/u);
    expect(() =>
      prepareReleaseInstaller({
        installerText: INSTALLER_FIXTURE,
        packageText: JSON.stringify({ version: '2.0.0' }),
        tag: 'v2.0.0',
        commit: 'A'.repeat(40),
      }),
    ).toThrow(/40 lowercase/u);
    expect(() =>
      prepareReleaseInstaller({
        installerText: `${INSTALLER_FIXTURE}REF_DEFAULT="main"\n`,
        packageText: JSON.stringify({ version: '2.0.0' }),
        tag: 'v2.0.0',
        commit: COMMIT,
      }),
    ).toThrow(/exactly one/u);
  });
});
