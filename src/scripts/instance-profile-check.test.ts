import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  INSTANCE_PROFILE_FILE_ENV,
  loadInstanceProfile,
} from '@skoobi/shared/instance-profile';

import { checkInstanceProfile } from './instance-profile-check.js';

const temporaryDirectories: string[] = [];

/** The profile as the loader reads it from a synthetic file (never the real one). */
function loadedFrom(contents: string | null) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'skoobi-profile-check-'),
  );
  temporaryDirectories.push(directory);
  const file = path.join(directory, 'instance.json');
  if (contents !== null) fs.writeFileSync(file, contents);
  return loadInstanceProfile({ env: { [INSTANCE_PROFILE_FILE_ENV]: file } });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('instance profile check', () => {
  it('passes a file that is read and fully used', () => {
    const loaded = loadedFrom(
      JSON.stringify({
        _readme: 'a note',
        telegram: { adminContact: '@owner_fixture' },
      }),
    );
    for (const requireFile of [false, true]) {
      expect(checkInstanceProfile(loaded, requireFile)).toEqual({
        ok: true,
        line: 'the file is read and every key is used',
      });
    }
  });

  it('fails a file the loader ignores, without quoting it', () => {
    const check = checkInstanceProfile(
      loadedFrom('{ "google": { "defaultCalendarId": "calendar@example.com"'),
      false,
    );
    expect(check).toEqual({
      ok: false,
      line: 'the file is ignored (invalid JSON); neutral defaults apply',
    });
  });

  it('fails keys that are not used and names them, never their values', () => {
    const check = checkInstanceProfile(
      loadedFrom(
        JSON.stringify({
          google: { defaultCalendarId: 'not a calendar id' },
          telegram: { adminAlertJids: ['tg:100123', 42] },
          typo: 'value-that-stays-private',
        }),
      ),
      false,
    );
    expect(check).toEqual({
      ok: false,
      line:
        'invalid values (defaults apply): telegram.adminAlertJids, google.defaultCalendarId; ' +
        'unknown keys (ignored): typo',
    });
    expect(check.line).not.toMatch(/not a calendar|100123|stays-private/u);
  });

  it('treats a missing file as a failure only where the installation needs one', () => {
    const loaded = loadedFrom(null);
    expect(checkInstanceProfile(loaded, false)).toEqual({
      ok: true,
      line: 'no file, neutral defaults apply',
    });
    expect(checkInstanceProfile(loaded, true)).toEqual({
      ok: false,
      line: 'no file found; neutral defaults apply',
    });
  });

  it('never shows where the file is', () => {
    const loaded = loadedFrom('[]');
    expect(loaded.file).toContain('skoobi-profile-check-');
    const check = checkInstanceProfile(loaded, true);
    expect(check.ok).toBe(false);
    expect(check.line).toBe(
      'the file is ignored (not a JSON object); neutral defaults apply',
    );
  });
});
