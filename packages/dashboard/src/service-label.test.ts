import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveMainServiceLabel,
  validateMainServiceLabel,
} from './service-label.js';

const originalCwd = process.cwd();
const originalEnvFile = process.env.CLAUDECLAW_ENV_FILE;
const originalServiceLabel = process.env.SKOOBI_SERVICE_LABEL;
const temporaryDirectories = new Set<string>();

afterEach(() => {
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

describe('validateMainServiceLabel', () => {
  it('uses the managed default instance when no label is configured', () => {
    expect(validateMainServiceLabel(undefined)).toBe('com.skoobi.default');
  });

  it('accepts only managed Skoobi instance labels', () => {
    expect(validateMainServiceLabel('com.skoobi.team_1')).toBe(
      'com.skoobi.team_1',
    );
    for (const value of [
      'com.example.skoobi',
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
