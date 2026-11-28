import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveBinary } from './binary-paths.js';

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('resolveBinary', () => {
  it('uses the first existing fallback when the name is absent from PATH', () => {
    const directory = mkdtempSync(join(tmpdir(), 'skoobi-binary-path-'));
    temporaryPaths.push(directory);
    const executable = join(directory, 'tool');
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });

    expect(
      resolveBinary('skoobi-definitely-missing-binary', [
        join(directory, 'missing'),
        executable,
      ]),
    ).toBe(executable);
  });

  it('returns the executable name when no fallback exists', () => {
    expect(
      resolveBinary('skoobi-definitely-missing-binary', [
        '/skoobi/example/missing',
      ]),
    ).toBe('skoobi-definitely-missing-binary');
  });
});
