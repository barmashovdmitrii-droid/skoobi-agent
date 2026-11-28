#!/usr/bin/env node

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STRICT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !['--installer', '--package', '--tag', '--commit'].includes(name) ||
      !value
    ) {
      fail(
        'Usage: prepare-release-installer --installer <path> --package <path> --tag <tag> --commit <sha>',
      );
    }
    if (values.has(name)) fail(`Duplicate argument: ${name}`);
    values.set(name, value);
  }
  for (const name of ['--installer', '--package', '--tag', '--commit']) {
    if (!values.has(name)) fail(`Missing argument: ${name}`);
  }
  return {
    installer: values.get('--installer'),
    packageFile: values.get('--package'),
    tag: values.get('--tag'),
    commit: values.get('--commit'),
  };
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function prepareReleaseInstaller({
  installerText,
  packageText,
  tag,
  commit,
}) {
  let packageJson;
  try {
    packageJson = JSON.parse(packageText);
  } catch (error) {
    fail(`Cannot parse package metadata: ${error.message}`);
  }
  const version = packageJson?.version;
  if (typeof version !== 'string' || !STRICT_SEMVER.test(version)) {
    fail('Package version must be strict SemVer without build metadata');
  }
  if (tag !== `v${version}`) {
    fail('Release tag does not match package version');
  }
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    fail('Release commit must be 40 lowercase hexadecimal characters');
  }

  const replacements = new Map([
    [
      'REF_DEFAULT="main"',
      `REF_DEFAULT=${shellSingleQuote(`refs/tags/${tag}`)}`,
    ],
    [
      'EXPECTED_COMMIT_DEFAULT=""',
      `EXPECTED_COMMIT_DEFAULT=${shellSingleQuote(commit)}`,
    ],
  ]);
  let output = installerText;
  for (const [before, after] of replacements) {
    if (output.split(before).length !== 2) {
      fail(`Expected exactly one installer placeholder: ${before}`);
    }
    output = output.replace(before, after);
  }
  return output;
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const output = prepareReleaseInstaller({
      installerText: readFileSync(args.installer, 'utf8'),
      packageText: readFileSync(args.packageFile, 'utf8'),
      tag: args.tag,
      commit: args.commit,
    });
    writeFileSync(args.installer, output, { encoding: 'utf8', flag: 'w' });
  } catch (error) {
    console.error(
      `prepare-release-installer: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
