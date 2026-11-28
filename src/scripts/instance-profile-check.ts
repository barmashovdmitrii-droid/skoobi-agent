/**
 * Says whether the instance profile of this installation (config/instance.json,
 * see @skoobi/shared/instance-profile) is in place and fully used.
 *
 * The loader never stops the service over a bad profile: it logs an error and
 * goes on with the neutral defaults. This check is the gate for that case, to
 * run after an edit and from a health check:
 *
 *   node dist/scripts/instance-profile-check.js [--require-file]
 *
 * One line on stdout, key names only (values are never printed).
 * Exit 0: the file was read cleanly, or there is none and none is required.
 * Exit 1: the file is ignored as a whole, has keys that are not used, or is
 *         required (--require-file: an installation that runs on its own
 *         profile) and missing.
 */
import {
  loadInstanceProfile,
  type LoadedInstanceProfile,
} from '@skoobi/shared/instance-profile';

export interface InstanceProfileCheck {
  readonly ok: boolean;
  /** What to show: a verdict without values and without the file location. */
  readonly line: string;
}

function listed(keys: readonly string[]): string {
  return keys.join(', ');
}

/** The verdict for one load of the profile. */
export function checkInstanceProfile(
  loaded: Pick<LoadedInstanceProfile, 'file' | 'unusable' | 'problems'>,
  requireFile: boolean,
): InstanceProfileCheck {
  if (loaded.unusable !== null) {
    return {
      ok: false,
      line: `the file is ignored (${loaded.unusable}); neutral defaults apply`,
    };
  }
  if (loaded.file === null) {
    return requireFile
      ? { ok: false, line: 'no file found; neutral defaults apply' }
      : { ok: true, line: 'no file, neutral defaults apply' };
  }
  const { invalidKeys, unknownKeys } = loaded.problems;
  const parts: string[] = [];
  if (invalidKeys.length > 0) {
    parts.push(`invalid values (defaults apply): ${listed(invalidKeys)}`);
  }
  if (unknownKeys.length > 0) {
    parts.push(`unknown keys (ignored): ${listed(unknownKeys)}`);
  }
  return parts.length > 0
    ? { ok: false, line: parts.join('; ') }
    : { ok: true, line: 'the file is read and every key is used' };
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/instance-profile-check.js') ||
  process.argv[1]?.endsWith('/instance-profile-check.ts');

if (isMain) {
  const check = checkInstanceProfile(
    loadInstanceProfile(),
    process.argv.slice(2).includes('--require-file'),
  );
  console.log(check.line);
  process.exit(check.ok ? 0 : 1);
}
