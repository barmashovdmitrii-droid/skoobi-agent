import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

describe('Skoobi helper module-path resolution', () => {
  let tempRoot;

  afterEach(() => {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('reads .env from a project path containing spaces and Unicode', () => {
    tempRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-helper-path-')),
    );
    const projectRoot = path.join(tempRoot, 'Skoobi helper Юникод');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.cpSync(
      path.join(REPO_ROOT, 'helper'),
      path.join(projectRoot, 'helper'),
      {
        recursive: true,
      },
    );
    fs.writeFileSync(
      path.join(projectRoot, '.env'),
      'HELPER_SECRET=test-only-secret\nHELPER_PORT=0\n',
      { mode: 0o600 },
    );

    const result = spawnSync(
      process.execPath,
      [path.join(projectRoot, 'helper', 'skoobi-helper.js')],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          HOME: path.join(tempRoot, 'home'),
          PATH: process.env.PATH,
        },
        timeout: 10_000,
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'HELPER_PORT must be an integer between 1 and 65535.',
    );
    expect(result.stderr).not.toContain('HELPER_SECRET missing');
  });
});
