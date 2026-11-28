/**
 * Runner-side view of the instance profile.
 *
 * The owner-specific values of an installation live in config/instance.json
 * on the host and are read there by @skoobi/shared/instance-profile. The
 * runner is a separate package inside the sandbox: it cannot import that
 * module and does not read host files. The values it needs travel with the
 * run:
 *
 *   host    serializeRunnerInput() (packages/core/src/runtimes/
 *           container-runner.ts) adds `instanceProfile`, the result of
 *           runnerInstanceProfile(), to the run input written to stdin;
 *   runner  main() in index.ts hands it to adoptInstanceProfile(), and
 *           buildClaudeclawMcpEnv() passes it on to the IPC MCP server
 *           (ipc-mcp-stdio.ts, a process of its own) as JSON in the
 *           CLAUDECLAW_INSTANCE_PROFILE_JSON variable;
 *   both    processes read it with instanceProfile().
 *
 * Only the groups of RunnerInstanceProfile are sent. Their shape, checks and
 * neutral defaults repeat the host module's for the same groups
 * (packages/shared/src/instance-profile.test.ts compares the two). A missing
 * or unusable value is the neutral public default, never an error.
 *
 * Code kept as an exact copy on the host and in the runner (the memory
 * credential detector) imports `./instance-profile.js` and calls
 * instanceProfile() or derivedFromInstanceProfile() on both sides: the host
 * has a module of that name with the same functions.
 *
 * Read the value where it is used, never into a module-level constant: the
 * main runner process imports its modules before the run input arrives, so a
 * constant would hold the neutral defaults for the whole run.
 *
 * Tests: setInstanceProfileForTests() / resetInstanceProfileForTests(), as on
 * the host. The injected profile is kept under the same globalThis key, so one
 * injection reaches the host copy and the runner copy.
 */

export interface RunnerInstanceProfile {
  /**
   * Extra words of the memory credential detector. A word in one of these
   * lists is read as a holder, a name, a service or an account, not as a
   * secret value. Lower case, one word each.
   */
  readonly credentialDetector: {
    readonly peopleWords: readonly string[];
    readonly nameWords: readonly string[];
    readonly serviceWords: readonly string[];
    readonly accountWords: readonly string[];
  };
  /** Fragments of model-visible text that name this installation. */
  readonly prompts: {
    /** How English tool text names the owner. */
    readonly ownerName: string;
    /** Who holds a password in refusal-hint examples: «пароль хранится у …». */
    readonly secretHolderExample: string;
    /** What to check when the local helper cannot be reached. */
    readonly helperUnreachableHint: string;
    /** What to grant the missing macOS permissions to. */
    readonly helperPermissionTarget: string;
    /** Description of the «target» field of a work checkpoint. */
    readonly workTargetHint: string;
    /**
     * Example of a good background-task title in the schedule_task tool text
     * («e.g. "<example>"»): one line, at most 60 characters, no double quote.
     */
    readonly taskTitleExample: string;
  };
}

/** What a test may inject: any subset of groups and of their keys. */
export type RunnerInstanceProfileInput = {
  readonly [Group in keyof RunnerInstanceProfile]?: Partial<
    RunnerInstanceProfile[Group]
  >;
};

export const INSTANCE_PROFILE_ENV = 'CLAUDECLAW_INSTANCE_PROFILE_JSON';

/** The public defaults: the same values as on the host. */
export const NEUTRAL_INSTANCE_PROFILE: RunnerInstanceProfile = Object.freeze({
  credentialDetector: Object.freeze({
    peopleWords: Object.freeze([] as string[]),
    nameWords: Object.freeze([] as string[]),
    serviceWords: Object.freeze([] as string[]),
    accountWords: Object.freeze([] as string[]),
  }),
  prompts: Object.freeze({
    ownerName: 'the owner',
    secretHolderExample: 'бухгалтера',
    helperUnreachableHint:
      'check that the configured local helper service is running and that its loopback port is reachable.',
    helperPermissionTarget: 'the Node.js executable that runs the helper',
    workTargetHint: 'Exact execution environment and project.',
    taskTitleExample: 'Слежка за обновлением сервиса',
  }),
});

type Check<T> = (value: unknown) => T | undefined;

// Control characters and the line and paragraph separators.
const CONTROL_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const WORD = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}'’_-]{0,63}$/u;
const WORD_FORM =
  /^[\p{L}][\p{L}\p{M}'’-]{0,63}(?: [\p{L}][\p{L}\p{M}'’-]{0,63}){0,3}$/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(max: number): Check<string> {
  return (value) =>
    typeof value === 'string' &&
    value.length <= max &&
    value.trim().length > 0 &&
    !CONTROL_CHARACTER.test(value)
      ? value
      : undefined;
}

/** Text that is shown to the model inside double quotes. */
function quotedExample(max: number): Check<string> {
  const check = text(max);
  return (value) => {
    const checked = check(value);
    return checked !== undefined && !checked.includes('"') ? checked : undefined;
  };
}

const wordForm: Check<string> = (value) =>
  typeof value === 'string' && WORD_FORM.test(value) ? value : undefined;

const words: Check<readonly string[]> = (value) => {
  if (!Array.isArray(value) || value.length > 500) return undefined;
  if (value.some((word) => typeof word !== 'string' || !WORD.test(word))) {
    return undefined;
  }
  return Object.freeze([...(value as string[])]);
};

const CHECKS: {
  readonly [Group in keyof RunnerInstanceProfile]: {
    readonly [Key in keyof RunnerInstanceProfile[Group]]: Check<
      RunnerInstanceProfile[Group][Key]
    >;
  };
} = {
  credentialDetector: {
    peopleWords: words,
    nameWords: words,
    serviceWords: words,
    accountWords: words,
  },
  prompts: {
    ownerName: text(64),
    secretHolderExample: wordForm,
    helperUnreachableHint: text(400),
    helperPermissionTarget: text(200),
    workTargetHint: text(400),
    taskTitleExample: quotedExample(60),
  },
};

/**
 * Build the runner profile from what the host sent: a known key that is
 * present and valid is taken, everything else is the neutral default. Keys of
 * other groups are ignored. Never throws; `invalidKeys` collects what was not
 * usable.
 */
export function normalizeInstanceProfile(
  raw: unknown,
  invalidKeys: string[] = [],
): RunnerInstanceProfile {
  const source = isPlainObject(raw) ? raw : {};
  if (raw !== undefined && !isPlainObject(raw)) invalidKeys.push('<root>');

  const profile: Record<string, unknown> = {};
  for (const group of Object.keys(CHECKS) as Array<
    keyof RunnerInstanceProfile
  >) {
    const checks = CHECKS[group] as Record<string, Check<unknown>>;
    const neutral = NEUTRAL_INSTANCE_PROFILE[group] as Record<string, unknown>;
    const given = Object.hasOwn(source, group) ? source[group] : undefined;
    const groupSource = isPlainObject(given) ? given : {};
    if (given !== undefined && !isPlainObject(given)) invalidKeys.push(group);

    const values: Record<string, unknown> = {};
    for (const key of Object.keys(checks)) {
      values[key] = neutral[key];
      if (!Object.hasOwn(groupSource, key)) continue;
      const checked = checks[key](groupSource[key]);
      if (checked === undefined) invalidKeys.push(`${group}.${key}`);
      else values[key] = checked;
    }
    profile[group] = Object.freeze(values);
  }
  return Object.freeze(profile) as unknown as RunnerInstanceProfile;
}

/**
 * The value of CLAUDECLAW_INSTANCE_PROFILE_JSON for the IPC MCP server: the
 * checked profile as JSON, or an empty string when it is all neutral.
 */
export function instanceProfileEnvValue(raw: unknown): string {
  const value = JSON.stringify(normalizeInstanceProfile(raw));
  return value === JSON.stringify(NEUTRAL_INSTANCE_PROFILE) ? '' : value;
}

// The same keys as in packages/shared/src/instance-profile.ts.
const TEST_OVERRIDE_KEY = Symbol.for('skoobi.instance-profile.test-override');
// What a reset goes back to (the test setup puts the empty profile here).
const TEST_BASELINE_KEY = Symbol.for('skoobi.instance-profile.test-baseline');

type OverrideHolder = {
  [TEST_OVERRIDE_KEY]?: unknown;
  [TEST_BASELINE_KEY]?: unknown;
};

let adopted: RunnerInstanceProfile | undefined;
let fromEnv: RunnerInstanceProfile | undefined;
let cachedOverrideSource: unknown;
let cachedOverride: RunnerInstanceProfile | undefined;

/** Main runner process: take the profile that came with the run input. */
export function adoptInstanceProfile(raw: unknown): void {
  adopted = normalizeInstanceProfile(raw);
}

function profileFromEnv(): RunnerInstanceProfile {
  const raw = process.env[INSTANCE_PROFILE_ENV];
  if (!raw) return NEUTRAL_INSTANCE_PROFILE;
  try {
    return normalizeInstanceProfile(JSON.parse(raw));
  } catch {
    // stderr only: stdout of the MCP server carries the protocol. The
    // parser's message would quote the value, so it is not printed.
    console.error(
      `[instance-profile] ${INSTANCE_PROFILE_ENV} is not valid JSON, neutral defaults apply`,
    );
    return NEUTRAL_INSTANCE_PROFILE;
  }
}

/**
 * The profile of this run. Never throws. The same object is returned until
 * the profile changes (the run input is adopted, a test injects another one).
 */
export function instanceProfile(): RunnerInstanceProfile {
  const override = (globalThis as OverrideHolder)[TEST_OVERRIDE_KEY];
  if (override !== undefined) {
    if (cachedOverrideSource !== override || !cachedOverride) {
      cachedOverride = normalizeInstanceProfile(override);
      cachedOverrideSource = override;
    }
    return cachedOverride;
  }
  if (adopted) return adopted;
  if (!fromEnv) fromEnv = profileFromEnv();
  return fromEnv;
}

/**
 * A value computed from the profile and kept until the profile changes: for
 * sets and regular expressions built from profile lists. Call the returned
 * function where the value is used; do not store its result in a module-level
 * constant.
 */
export function derivedFromInstanceProfile<T>(
  compute: (profile: RunnerInstanceProfile) => T,
): () => T {
  let source: RunnerInstanceProfile | undefined;
  let value: T | undefined;
  return () => {
    const profile = instanceProfile();
    if (profile !== source) {
      value = compute(profile);
      source = profile;
    }
    return value as T;
  };
}

/**
 * Tests: use this synthetic profile. Keys that are not given stay neutral; a
 * value the runner would not accept throws.
 */
export function setInstanceProfileForTests(
  input: RunnerInstanceProfileInput,
): void {
  const invalidKeys: string[] = [];
  normalizeInstanceProfile(input, invalidKeys);
  if (invalidKeys.length > 0) {
    throw new Error(
      `Invalid instance profile for tests: ${invalidKeys.join(', ')}`,
    );
  }
  (globalThis as OverrideHolder)[TEST_OVERRIDE_KEY] = JSON.parse(
    JSON.stringify(input),
  );
}

/**
 * Tests: drop the injected, adopted and cached profile. Under the test setup
 * the profile is then the empty injected one again (the neutral defaults).
 */
export function resetInstanceProfileForTests(): void {
  const holder = globalThis as OverrideHolder;
  if (holder[TEST_BASELINE_KEY] !== undefined) {
    holder[TEST_OVERRIDE_KEY] = holder[TEST_BASELINE_KEY];
  } else {
    delete holder[TEST_OVERRIDE_KEY];
  }
  adopted = undefined;
  fromEnv = undefined;
  cachedOverride = undefined;
  cachedOverrideSource = undefined;
}
