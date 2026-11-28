import { execFileSync } from 'child_process';
import path from 'path';

import { describe, expect, it } from 'vitest';

function missingScopes(requested: string[], granted: string | null): string[] {
  const scriptPath = path.join(
    process.cwd(),
    'scripts',
    'google-workspace-refresh-token.py',
  );
  const code = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("oauth_helper", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'requested = tuple(json.loads(sys.argv[2]))',
    'granted = json.loads(sys.argv[3])',
    'print(json.dumps(module.missing_granted_scopes(requested, granted)))',
  ].join('\n');
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        code,
        scriptPath,
        JSON.stringify(requested),
        JSON.stringify(granted),
      ],
      { encoding: 'utf8' },
    ),
  ) as string[];
}

describe('Google Workspace OAuth refresh helper', () => {
  it('requires every requested scope before replacing the refresh token', () => {
    const sheets = 'https://www.googleapis.com/auth/spreadsheets';
    const drive = 'https://www.googleapis.com/auth/drive';
    expect(missingScopes([drive, sheets], `${sheets} ${drive}`)).toEqual([]);
    expect(missingScopes([drive, sheets], drive)).toEqual([sheets]);
    expect(missingScopes([drive, sheets], null)).toEqual([drive, sheets]);
  });
});
