import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {installToolchain, validateToolchainManifest, verifyInstalledToolchain, verifyPackageIntegrity} from './codex-toolchain.mjs';
const scratch = [];
const temp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-toolchain-test-')); scratch.push(p); return p; };
const write = (root, name, bytes) => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), {recursive:true,mode:0o700}); fs.writeFileSync(p, bytes, {mode:0o600}); return p; };
afterEach(() => { for (const p of scratch.splice(0)) fs.rmSync(p,{recursive:true,force:true}); });

describe('versioned Codex toolchain integrity', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../runtime/codex-toolchain.json', import.meta.url), 'utf8'));
  it('pins exact CLI release, package checksums, and destination', () => {
    // The manifest is the release pin; upgrades must not require a second pin here.
    expect(() => validateToolchainManifest(manifest)).not.toThrow();
    expect(() => validateToolchainManifest({ ...manifest, version: 'latest', destination: 'node_modules/.skoobi-codex-latest' })).toThrow();
    expect(() => validateToolchainManifest({ ...manifest, version: '999.999.999' })).toThrow();
    expect(() => validateToolchainManifest({ ...manifest, destination: '../../unsafe' })).toThrow();
    expect(() => verifyPackageIntegrity(Buffer.from('tampered'), manifest.packages[0].integrity)).toThrow(/integrity/);
    const bytes = Buffer.from('fixture archive');
    expect(() => verifyPackageIntegrity(bytes, `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`)).not.toThrow();
  });
  it('checks actual installed bytes without executing a binary or fetching anything', () => {
    const root = temp(), bytes = Buffer.from('fixture binary'), wrapper = Buffer.from('fixture wrapper');
    const fixture = { ...manifest, binarySha256: crypto.createHash('sha256').update(bytes).digest('hex'), wrapperSha256: crypto.createHash('sha256').update(wrapper).digest('hex') };
    const bin = write(root, `${fixture.destination}/${fixture.binary}`, bytes);
    write(root, `${fixture.destination}/node_modules/@openai/codex/bin/codex.js`, wrapper);
    write(root, `${fixture.destination}/node_modules/@openai/codex/package.json`, JSON.stringify({ name: '@openai/codex', version: fixture.version }));
    write(root, `${fixture.destination}/node_modules/@openai/codex-darwin-arm64/package.json`, JSON.stringify({ name: '@openai/codex', version: `${fixture.version}-darwin-arm64` }));
    fs.mkdirSync(path.join(root, fixture.destination, 'node_modules/.bin'));
    fs.symlinkSync('../@openai/codex/bin/codex.js', path.join(root, fixture.destination, fixture.launcher));
    expect(verifyInstalledToolchain(root, fixture).verified).toBe(true);
    const packagePath = path.join(root, fixture.destination, 'node_modules/@openai/codex/package.json');
    fs.writeFileSync(packagePath, JSON.stringify({ name: '@openai/codex', version: `${fixture.version}-mismatch` }));
    expect(() => verifyInstalledToolchain(root, fixture)).toThrow(/version mismatch/);
    fs.writeFileSync(packagePath, JSON.stringify({ name: '@openai/codex', version: fixture.version }));
    fs.appendFileSync(bin, 'tamper');
    expect(() => verifyInstalledToolchain(root, fixture)).toThrow(/integrity/);
  });
  it.runIf(process.platform === 'darwin' && process.arch === 'arm64')('recreates a launchable .bin entry from an empty fixture without fetching or calling a model', async () => {
    const root = temp(), input = temp();
    const wrapper = Buffer.from('#!/usr/bin/env node\nconsole.log("codex-cli 0.153.4");\n');
    const binary = Buffer.from('fixture native binary, never executed');
    const archives = [];
    for (const [index, version] of [manifest.version, `${manifest.version}-darwin-arm64`].entries()) {
      const source = path.join(input, `source-${index}`);
      write(source, 'package/package.json', JSON.stringify({ name: '@openai/codex', version }));
      write(source, index === 0 ? 'package/bin/codex.js' : 'package/vendor/aarch64-apple-darwin/bin/codex', index === 0 ? wrapper : binary);
      const tar = path.join(input, `package-${index}.tgz`);
      execFileSync('tar', ['-czf', tar, '-C', source, 'package']);
      archives.push(fs.readFileSync(tar));
    }
    const fixture = { ...manifest, binarySha256: crypto.createHash('sha256').update(binary).digest('hex'), wrapperSha256: crypto.createHash('sha256').update(wrapper).digest('hex'), packages: manifest.packages.map((pkg, i) => ({ ...pkg, integrity: `sha512-${crypto.createHash('sha512').update(archives[i]).digest('base64')}` })) };
    const fetchArchive = vi.fn(async (url) => archives[fixture.packages.findIndex((pkg) => pkg.url === url)]);
    const installed = await installToolchain(root, fixture, fetchArchive);
    expect(execFileSync(installed.command, ['--version'], { encoding: 'utf8' }).trim()).toBe('codex-cli 0.153.4');
    expect(fetchArchive).toHaveBeenCalledTimes(2);
    expect((await installToolchain(root, fixture, fetchArchive)).verified).toBe(true);
    expect(fetchArchive).toHaveBeenCalledTimes(2);
  });
});
