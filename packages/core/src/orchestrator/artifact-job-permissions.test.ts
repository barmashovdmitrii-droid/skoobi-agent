import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  prepareArtifactJobCodex,
  artifactCodexPermissionConfiguration,
  ARTIFACT_CODEX_TOOL_POLICY,
} from './artifact-job-model.js';
import { preflightArtifactCodexPermissions } from './artifact-job.js';

const manifestPath = path.resolve('runtime/codex-toolchain.json');
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : null;
const binary = manifest
  ? path.resolve(manifest.destination, manifest.binary)
  : '';

describe('native Codex command credential boundary (no model/provider calls)', () => {
  it('rejects conflicting custom temp rules before creating a tool profile', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'tool-rule-conflict-')),
    );
    const home = path.join(root, 'home', '.codex');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, 'scratch'), { mode: 0o700 });
    try {
      for (const temporary of [root, path.join(root, 'scratch')]) {
        const spy = vi.spyOn(os, 'tmpdir').mockReturnValue(temporary);
        try {
          expect(() =>
            artifactCodexPermissionConfiguration(root, home),
          ).toThrow('model_tool_policy_conflict');
        } finally {
          spy.mockRestore();
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const userTemp =
    process.platform === 'darwin'
      ? execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], {
          encoding: 'utf8',
        }).trim()
      : os.tmpdir();
  for (const [location, parent] of [
    ['shared temporary directory', '/private/tmp'],
    ['per-user temporary directory', userTemp],
    ['ordinary host directory', process.cwd()],
  ])
    it.runIf(process.platform === 'darwin' && fs.existsSync(binary))(
      `proves the native profile from ${location} before seeding synthetic auth`,
      async () => {
        const root = fs.realpathSync(
          fs.mkdtempSync(path.join(parent, 'artifact-tool-policy-')),
        );
        const workspace = path.join(root, 'workspace');
        for (const dir of [
          workspace,
          ...['home', 'inputs', 'output', 'scratch'].map((x) =>
            path.join(workspace, x),
          ),
        ])
          fs.mkdirSync(dir, { mode: 0o700 });
        const auth = path.join(root, 'fixture-auth.json');
        const synthetic = JSON.stringify({
          auth_mode: 'fixture',
          tokens: { synthetic: 'fixture-not-a-credential' },
        });
        fs.writeFileSync(auth, synthetic, { mode: 0o600 });
        try {
          expect(
            crypto
              .createHash('sha256')
              .update(fs.readFileSync(binary))
              .digest('hex'),
          ).toBe(manifest.binarySha256);
          const launch = prepareArtifactJobCodex(
            workspace,
            {
              model: 'fixture-model',
              authJsonPath: auth,
              prompt: 'Synthetic permission test only.',
            },
            [fs.realpathSync(binary), fs.realpathSync(process.execPath)],
          );
          expect(
            fs.existsSync(path.join(launch.env.CODEX_HOME, 'auth.json')),
          ).toBe(false);
          const checked = await preflightArtifactCodexPermissions(
            fs.realpathSync(binary),
            workspace,
            launch,
            root,
          );
          expect(checked, JSON.stringify(checked)).toMatchObject({
            passed: true,
            failures: [],
            policy: ARTIFACT_CODEX_TOOL_POLICY,
            cliVersion: manifest.version,
            executableSha256: manifest.binarySha256,
            profileSha256: launch.toolProfileSha256,
          });
          expect(
            fs.existsSync(path.join(launch.env.CODEX_HOME, 'auth.json')),
          ).toBe(false);
          expect(fs.readFileSync(auth, 'utf8')).toBe(synthetic);
          if (location === 'ordinary host directory') {
            const configPath = path.join(launch.env.CODEX_HOME, 'config.toml');
            const protectedConfig = fs.readFileSync(configPath, 'utf8');
            const baseline = protectedConfig.replace(
              '"/private/tmp" = "deny"\n',
              '',
            );
            expect(baseline).not.toBe(protectedConfig);
            fs.writeFileSync(configPath, baseline);
            fs.rmSync(path.join(workspace, 'output'), {
              recursive: true,
              force: true,
            });
            fs.mkdirSync(path.join(workspace, 'output'), { mode: 0o700 });
            try {
              const rejected = await preflightArtifactCodexPermissions(
                fs.realpathSync(binary),
                workspace,
                {
                  ...launch,
                  toolProfileSha256: crypto
                    .createHash('sha256')
                    .update(baseline)
                    .digest('hex'),
                },
                root,
              );
              expect(rejected.passed).toBe(false);
              expect(rejected.failures).toContain('shared-temp-read');
              expect(
                fs.existsSync(path.join(launch.env.CODEX_HOME, 'auth.json')),
              ).toBe(false);
            } finally {
              fs.writeFileSync(configPath, protectedConfig);
            }
          }
          launch.seedAuth();
          expect(
            fs.readFileSync(
              path.join(launch.env.CODEX_HOME, 'auth.json'),
              'utf8',
            ),
          ).toBe(synthetic);
          expect(
            await preflightArtifactCodexPermissions(
              fs.realpathSync(binary),
              workspace,
              launch,
              root,
            ),
          ).toMatchObject({
            passed: false,
            failures: ['real_auth_must_not_precede_preflight'],
          });
          expect(
            fs.readFileSync(
              path.join(launch.env.CODEX_HOME, 'auth.json'),
              'utf8',
            ),
          ).toBe(synthetic);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
      30_000,
    );
});
