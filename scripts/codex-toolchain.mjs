import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const digest = (bytes, algorithm, encoding) => crypto.createHash(algorithm).update(bytes).digest(encoding);

export function validateToolchainManifest(manifest) {
  if (manifest.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
      manifest.destination !== `node_modules/.skoobi-codex-${manifest.version}` ||
      !/^[a-f0-9]{64}$/.test(manifest.binarySha256) || manifest.platform !== 'darwin' || manifest.arch !== 'arm64' ||
      !/^[a-f0-9]{64}$/.test(manifest.wrapperSha256) || manifest.launcher !== 'node_modules/.bin/codex' ||
      manifest.binary !== 'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex' ||
      !Array.isArray(manifest.packages) || manifest.packages.length !== 2) throw new Error('Invalid Codex toolchain manifest');
  const directories = new Set();
  for (const pkg of manifest.packages) {
    if (!['node_modules/@openai/codex', 'node_modules/@openai/codex-darwin-arm64'].includes(pkg.directory) || directories.has(pkg.directory) ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity) ||
        !pkg.url.startsWith(`https://registry.npmjs.org/@openai/codex/-/codex-${manifest.version}`) || !pkg.url.endsWith('.tgz')) throw new Error('Invalid pinned Codex package');
    directories.add(pkg.directory);
  }
  return manifest;
}

export function verifyPackageIntegrity(bytes, expected) {
  const actual = `sha512-${digest(bytes, 'sha512', 'base64')}`;
  if (actual !== expected) throw new Error('Codex package integrity mismatch');
}

export function verifyInstalledToolchain(root, manifest) {
  validateToolchainManifest(manifest);
  const binary = path.join(root, manifest.destination, manifest.binary);
  const stat = fs.lstatSync(binary);
  if (!stat.isFile() || stat.isSymbolicLink() || digest(fs.readFileSync(binary), 'sha256', 'hex') !== manifest.binarySha256) throw new Error('Codex binary integrity mismatch');
  const prefix = path.join(root, manifest.destination);
  const wrapper = path.join(prefix, 'node_modules/@openai/codex/bin/codex.js');
  if (!fs.lstatSync(wrapper).isFile() || digest(fs.readFileSync(wrapper), 'sha256', 'hex') !== manifest.wrapperSha256) throw new Error('Codex wrapper integrity mismatch');
  const command = path.join(prefix, manifest.launcher);
  if (!fs.lstatSync(command).isSymbolicLink() || fs.realpathSync(command) !== fs.realpathSync(wrapper)) throw new Error('Codex launcher mismatch');
  for (const [directory, version] of [['node_modules/@openai/codex', manifest.version], ['node_modules/@openai/codex-darwin-arm64', `${manifest.version}-darwin-arm64`]]) {
    const pkg = JSON.parse(fs.readFileSync(path.join(prefix, directory, 'package.json'), 'utf8'));
    if (pkg.name !== '@openai/codex' || pkg.version !== version) throw new Error('Codex package version mismatch');
  }
  return { version: manifest.version, binary, command, verified: true };
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 256 * 1024 * 1024) throw new Error('Codex package download failed');
  let total = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > 256 * 1024 * 1024) throw new Error('Codex package too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Explicit installation only, never invokes npm scripts or replaces an install. */
export async function installToolchain(root, manifest, fetchArchive = download) {
  validateToolchainManifest(manifest);
  if (process.platform !== manifest.platform || process.arch !== manifest.arch) throw new Error('Codex toolchain platform mismatch');
  const destination = path.join(root, manifest.destination);
  if (fs.existsSync(destination)) return verifyInstalledToolchain(root, manifest);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  if (!fs.lstatSync(parent).isDirectory()) throw new Error('Unsafe node_modules directory');
  const work = fs.mkdtempSync(path.join(parent, '.codex-install-'));
  try {
    const staged = path.join(work, 'install');
    fs.mkdirSync(staged);
    for (const [index, pkg] of manifest.packages.entries()) {
      const bytes = await fetchArchive(pkg.url);
      verifyPackageIntegrity(bytes, pkg.integrity);
      const archive = path.join(work, `package-${index}.tgz`);
      fs.writeFileSync(archive, bytes, { mode: 0o600 });
      const target = path.join(staged, pkg.directory);
      fs.mkdirSync(target, { recursive: true });
      execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', target], { stdio: 'pipe', timeout: 60_000 });
    }
    const bin = path.join(staged, manifest.binary);
    if (digest(fs.readFileSync(bin), 'sha256', 'hex') !== manifest.binarySha256) throw new Error('Codex installed binary checksum mismatch');
    fs.chmodSync(bin, 0o755);
    const wrapper = path.join(staged, 'node_modules/@openai/codex/bin/codex.js');
    if (digest(fs.readFileSync(wrapper), 'sha256', 'hex') !== manifest.wrapperSha256) throw new Error('Codex wrapper checksum mismatch');
    fs.chmodSync(wrapper, 0o755);
    fs.mkdirSync(path.join(staged, 'node_modules/.bin'));
    fs.symlinkSync('../@openai/codex/bin/codex.js', path.join(staged, manifest.launcher));
    // Do not replace a concurrently installed directory or an existing file.
    if (fs.existsSync(destination)) throw new Error('Codex install appeared concurrently');
    fs.renameSync(staged, destination);
    return verifyInstalledToolchain(root, manifest);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => !['--check', '--install'].includes(arg)) || args.length > 1) throw new Error('Use --check (default) or --install');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'codex-toolchain.json'), 'utf8'));
    const result = args.includes('--install') ? await installToolchain(root, manifest) : verifyInstalledToolchain(root, manifest);
    console.log(JSON.stringify(result));
  } catch (err) { console.error(`Codex toolchain: ${err.message}`); process.exitCode = 1; }
}
