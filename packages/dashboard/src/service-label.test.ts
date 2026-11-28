import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resetInstanceProfileForTests,
  setInstanceProfileForTests,
} from '@skoobi/shared/instance-profile';

import {
  resolveMainServiceLabel,
  validateMainServiceLabel,
} from './service-label.js';

const originalCwd = process.cwd();
const originalEnvFile = process.env.CLAUDECLAW_ENV_FILE;
const originalServiceLabel = process.env.SKOOBI_SERVICE_LABEL;
const temporaryDirectories = new Set<string>();

afterEach(() => {
  resetInstanceProfileForTests();
  process.chdir(originalCwd);
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
  if (originalEnvFile === undefined) delete process.env.CLAUDECLAW_ENV_FILE;
  else process.env.CLAUDECLAW_ENV_FILE = originalEnvFile;
  if (originalServiceLabel === undefined)
    delete process.env.SKOOBI_SERVICE_LABEL;
  else process.env.SKOOBI_SERVICE_LABEL = originalServiceLabel;
});

// The label an installation that predates SKOOBI_SERVICE_LABEL names in its
// instance profile (launchd.mainLabel). Synthetic: tests never read a profile.
const LEGACY_LABEL = 'com.example.fixture-main';

describe('validateMainServiceLabel', () => {
  it('uses the default label when no label is configured', () => {
    expect(validateMainServiceLabel(undefined)).toBe('com.skoobi.default');
    expect(validateMainServiceLabel('  ')).toBe('com.skoobi.default');
    expect(validateMainServiceLabel('com.skoobi.default')).toBe(
      'com.skoobi.default',
    );
    // Another installation's legacy label means nothing here.
    expect(() => validateMainServiceLabel(LEGACY_LABEL)).toThrow(
      /Invalid SKOOBI_SERVICE_LABEL/u,
    );
  });

  it('keeps the legacy main label when no label is configured', () => {
    setInstanceProfileForTests({ launchd: { mainLabel: LEGACY_LABEL } });
    expect(validateMainServiceLabel(undefined)).toBe(LEGACY_LABEL);
    expect(validateMainServiceLabel('  ')).toBe(LEGACY_LABEL);
    expect(validateMainServiceLabel(LEGACY_LABEL)).toBe(LEGACY_LABEL);
  });

  it('accepts only managed Skoobi instance labels', () => {
    setInstanceProfileForTests({ launchd: { mainLabel: LEGACY_LABEL } });
    expect(validateMainServiceLabel('com.skoobi.team_1')).toBe(
      'com.skoobi.team_1',
    );
    for (const value of [
      'com.example.skoobi',
      'com.example.fixture-other',
      `${LEGACY_LABEL}-extra`,
      'com.skoobi.',
      'com.skoobi.team/../other',
      'com.skoobi.team.other',
      'com.skoobi.dashboard',
      'com.skoobi.Dashboard',
      `com.skoobi.${'a'.repeat(64)}`,
    ]) {
      expect(() => validateMainServiceLabel(value)).toThrow(
        /Invalid SKOOBI_SERVICE_LABEL/u,
      );
    }
  });

  it('reads the custom main label from the dashboard working-directory .env', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-dashboard-label-'),
    );
    temporaryDirectories.add(directory);
    fs.writeFileSync(
      path.join(directory, '.env'),
      'SKOOBI_SERVICE_LABEL=com.skoobi.team_1\n',
      { mode: 0o600 },
    );
    delete process.env.CLAUDECLAW_ENV_FILE;
    delete process.env.SKOOBI_SERVICE_LABEL;
    process.chdir(directory);

    expect(resolveMainServiceLabel()).toBe('com.skoobi.team_1');
  });
});
