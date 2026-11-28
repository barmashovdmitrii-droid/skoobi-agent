/**
 * Instance profile: the owner-specific values of ONE installation.
 *
 * Code that needs a value tied to a particular owner (a calendar, an admin
 * chat, a name form, a launchd job list) reads it from here instead of
 * carrying a literal. The values live in one tracked file,
 * `config/instance.json`:
 *   - in the private tree it holds what production uses;
 *   - the public export replaces it with the neutral
 *     `public-release/overlay/config/instance.json` (a policy overlay, the
 *     same way `config/retention.json` is replaced).
 * A missing file, a missing key or a key of the wrong type gives the neutral
 * default (NEUTRAL_INSTANCE_PROFILE below), so a public install behaves as the
 * public line always did and exported sources carry no personal data.
 *
 * Where the file is looked for (the first existing file wins, files are not
 * merged; a key the file lacks falls back to the neutral default):
 *   1. SKOOBI_INSTANCE_PROFILE_FILE in the process environment: that path only;
 *   2. <working directory>/config/instance.json, like config/retention.json:
 *      production runs from the repository root, and a public install may keep
 *      a per-instance file in its instance directory;
 *   3. <code root>/config/instance.json: the tree this module runs from, so a
 *      build started with another working directory (the image bot, a public
 *      instance directory) still gets the profile shipped with the code.
 * The file is read once per process; a restart picks up an edit. Loading never
 * throws: a missing file is normal, an unreadable or malformed one is logged
 * once as an error (key names only, never values) and the neutral defaults
 * apply. Because the service then keeps running on defaults,
 * instanceProfileStatus() says how the load went: the Telegram /status
 * command shows a file that was ignored or only partly used as a problem.
 *
 * Usage:
 *   import { instanceProfile } from '@skoobi/shared/instance-profile';
 *   const calendarId = instanceProfile().google.defaultCalendarId;
 * Read the value where it is used (inside the function). A module-level
 * constant freezes it at import, before a test can inject anything (and, in
 * the agent runner, before the run input has arrived). A set or a regular
 * expression built from a profile list is kept with
 * derivedFromInstanceProfile(), which rebuilds it when the profile changes:
 *   const curatorKeywords = derivedFromInstanceProfile(
 *     (profile) => new Set(profile.memory.curatorKeywords),
 *   );
 *   ... curatorKeywords().has(word)
 *
 * Tests never read config/instance.json: setup/vitest-env.ts starts every
 * test file with an empty injected profile (the neutral defaults, no disk
 * access) and points SKOOBI_INSTANCE_PROFILE_FILE at a missing file. A test
 * that needs owner values injects synthetic ones:
 *   beforeEach(() =>
 *     setInstanceProfileForTests({
 *       google: { defaultCalendarId: 'calendar@example.com' },
 *     }),
 *   );
 *   afterEach(() => resetInstanceProfileForTests());
 * Keys that are not injected stay neutral; an invalid profile throws. The
 * injected profile is kept on globalThis, so it survives vi.resetModules().
 * Under that setup a reset goes back to the empty injected profile, not to
 * the disk. A test that starts another process hands it
 * SKOOBI_INSTANCE_PROFILE_FILE (a synthetic file or a missing path): a child
 * with a clean environment would read the repository's own file.
 *
 * Shell and Python scripts read the same file as plain JSON, looking where
 * this loader looks: the path in SKOOBI_INSTANCE_PROFILE_FILE when it is set
 * (only that one), else config/instance.json of the working directory, else
 * the one of the repository the script is in. A missing or unreadable file, a
 * missing key or a value of another type means the neutral default written
 * in the script; values are never printed.
 *
 * The agent runner (agent/runner) is a separate package that runs inside the
 * sandbox and cannot import this module. The host sends it
 * runnerInstanceProfile() with every run input (serializeRunnerInput in
 * packages/core/src/runtimes/container-runner.ts); the runner reads it through
 * agent/runner/src/instance-profile.ts.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from './logger.js';

/** One row of the launchd job list shown by the panel and by /status. */
export interface InstanceLaunchdUnit {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  /** `daemon` keeps a pid forever; `periodic` is idle between runs. */
  readonly kind: 'daemon' | 'periodic';
  /** Nominal period in seconds (periodic jobs). */
  readonly periodSec?: number;
  /**
   * Log the job appends to on every run. A path template: `{home}`,
   * `{instance}` (launchd.instanceDir) and `{watchdog}` (launchd.watchdogDir)
   * are substituted by the caller.
   */
  readonly heartbeatLog?: string;
}

/** A skill the seeding script writes in addition to the built-in ones. */
export interface InstanceSeedSkill {
  /** Skill front matter (`name` and `description` are required). */
  readonly frontmatter: Readonly<Record<string, unknown>> & {
    readonly name: string;
    readonly description: string;
  };
  readonly body: string;
  /**
   * Name of the built-in seed skill this one is written in front of. Absent,
   * or not the name of a built-in skill: after the built-in ones.
   */
  readonly before?: string;
}

/** A selection pattern for the skills of this installation. */
export interface InstanceSkillSelectionPattern {
  /** The pattern applies to skills whose name contains this text. */
  readonly nameIncludes: string;
  /** Word stems: a message with a word that starts with one of them matches. */
  readonly stems: readonly string[];
  /** Score a matching skill gets. */
  readonly bonus: number;
}

export interface InstanceProfile {
  readonly assistant: {
    /** Assistant name when ASSISTANT_NAME is not set. */
    readonly defaultName: string;
    /** Title of the local macOS notifications the service raises. */
    readonly notificationTitle: string;
    /**
     * Extra ways the owner addresses the assistant at the start of a message
     * besides the built-in product names, e.g. the bot's Telegram username
     * with its leading «@».
     */
    readonly addressHandles: readonly string[];
  };
  readonly owner: {
    /**
     * Forms of the owner's name accepted after «Для » in a scheduled-task
     * result line, in addition to the built-in «владельца».
     */
    readonly taskResultNameForms: readonly string[];
    /**
     * Addressee words a reminder text may start with and that are stripped
     * from its title, next to the built-in «мне», «меня», «пользователю».
     */
    readonly reminderLeadForms: readonly string[];
    /**
     * The owner's work folders outside the chat folders, relative to the home
     * directory. Files in them may be attached in the owner's own chat.
     */
    readonly workFolders: readonly string[];
    /**
     * Extra word stems that name something only the owner's admin runtime
     * can reach (next to the built-in ones: logs, repository, service…). A
     * message with an action verb and one of them is routed there.
     */
    readonly adminObjectStems: readonly string[];
  };
  readonly telegram: {
    /** Chats that get operational alerts when SKOOBI_TELEGRAM_ADMIN_ALERT_JIDS is unset. */
    readonly adminAlertJids: readonly string[];
    /** How users are told to reach the administrator when SKOOBI_ADMIN_CONTACT is unset. */
    readonly adminContact: string;
    /**
     * Folder under groups/ that guest prompts and guest memory seeds name as
     * the administrator's private chat folder.
     */
    readonly guestPromptOwnerFolder: string;
  };
  readonly google: {
    /** Calendar used when SKOOBI_GOOGLE_CALENDAR_ID is unset; empty = none. */
    readonly defaultCalendarId: string;
  };
  readonly dashboard: {
    /** sender_name stored for messages sent from the panel chat. */
    readonly panelSenderName: string;
    /** Extra services the panel may restart: unit key → launchd label. */
    readonly restartableUnits: Readonly<Record<string, string>>;
    /**
     * Legacy CRM topic file read when no default spreadsheet is configured,
     * relative to the state root; empty = none.
     */
    readonly legacyCrmTopicFile: string;
  };
  readonly launchd: {
    /** launchd label of the main service when SKOOBI_SERVICE_LABEL is unset. */
    readonly mainLabel: string;
    /** Home directory assumed when HOME is unset; empty = ask the system. */
    readonly fallbackHome: string;
    /** Instance directory for `{instance}` in unit paths; may use `{home}`. */
    readonly instanceDir: string;
    /** Watchdog directory for `{watchdog}` in unit paths; may use `{home}`. */
    readonly watchdogDir: string;
    /** Jobs shown by the panel and by /status, in display order. */
    readonly units: readonly InstanceLaunchdUnit[];
  };
  readonly voice: {
    /** Microsoft Edge voice that voice replies are spoken with. */
    readonly edgeVoice: string;
    /** Azure voice used when AZURE_TTS_VOICE is unset. */
    readonly azureVoice: string;
    /**
     * Other values of TTS_PROVIDER that mean the Edge voice, next to the
     * built-in «edge». Lower case; a built-in provider name is not accepted.
     */
    readonly edgeProviderAliases: readonly string[];
  };
  readonly memory: {
    /** Extra keywords (stems) that raise a memory line's score in the curator. */
    readonly curatorKeywords: readonly string[];
  };
  readonly chatSecrets: {
    /**
     * Extra words that follow a number as a unit of count («1500 <word>»),
     * next to the built-in ones (currency, pieces, minutes, people, orders…).
     * In a reply to the bot's request for a password or a code such a number
     * is an amount, not a secret, and stays unmasked. One word each, in the
     * form that follows a number.
     */
    readonly unitWords: readonly string[];
  };
  /**
   * Extra words of the memory credential detector. A word in one of these
   * lists is read as a holder, a name, a service or an account, not as a
   * secret value. Lower case, one word each.
   */
  readonly credentialDetector: {
    /** People and roles who hold a secret (added to the built-in list). */
    readonly peopleWords: readonly string[];
    /** First names, used as written: no case forms are derived. */
    readonly nameWords: readonly string[];
    /** Services and brands a note names instead of a value. */
    readonly serviceWords: readonly string[];
    /** Account words («от <word>» names an account, not a value). */
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
  readonly retention: {
    /** Chat for the retention report when no chat is configured; null = no report. */
    readonly reportChatId: number | null;
  };
  readonly skillsSeed: {
    /** Chat folders of the owner/admin operations seed skill. */
    readonly adminFolders: readonly string[];
    /** Seed skills of this installation, next to the built-in ones. */
    readonly extraSkills: readonly InstanceSeedSkill[];
  };
  readonly skills: {
    /**
     * Selection patterns added to the built-in ones (web, voice, memory,
     * image): a skill whose name contains `nameIncludes` gets `bonus` when
     * the message has a word starting with one of `stems`.
     */
    readonly selectionPatterns: readonly InstanceSkillSelectionPattern[];
  };
}

/** The part of the profile the agent runner needs (sent with every run). */
export type RunnerInstanceProfile = Pick<
  InstanceProfile,
  'credentialDetector' | 'prompts'
>;

/** What a test may inject: any subset of groups and of their keys. */
export type InstanceProfileInput = {
  readonly [Group in keyof InstanceProfile]?: Partial<InstanceProfile[Group]>;
};

export const INSTANCE_PROFILE_FILE_ENV = 'SKOOBI_INSTANCE_PROFILE_FILE';
export const INSTANCE_PROFILE_RELATIVE_PATH = 'config/instance.json';

const MAX_INSTANCE_PROFILE_BYTES = 1024 * 1024;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * The public defaults: what every key is when the file or the key is absent.
 * public-release/overlay/config/instance.json carries exactly these values.
 */
export const NEUTRAL_INSTANCE_PROFILE = deepFreeze<InstanceProfile>({
  assistant: {
    defaultName: 'Skoobi',
    notificationTitle: 'Skoobi',
    addressHandles: [],
  },
  owner: {
    taskResultNameForms: [],
    reminderLeadForms: ['владельцу', 'владельца'],
    workFolders: [],
    adminObjectStems: [],
  },
  telegram: {
    adminAlertJids: [],
    adminContact: 'the bot owner',
    guestPromptOwnerFolder: 'owner_main',
  },
  google: {
    defaultCalendarId: '',
  },
  dashboard: {
    panelSenderName: 'Owner (dashboard)',
    restartableUnits: {},
    legacyCrmTopicFile: '',
  },
  launchd: {
    mainLabel: 'com.skoobi.default',
    fallbackHome: '',
    instanceDir: '',
    watchdogDir: '',
    units: [
      {
        id: 'main',
        name: 'Скуби',
        label: 'com.skoobi.default',
        kind: 'daemon',
      },
      {
        id: 'dashboard',
        name: 'Локальная панель',
        label: 'com.skoobi.dashboard',
        kind: 'daemon',
      },
    ],
  },
  voice: {
    edgeVoice: 'ru-RU-SvetlanaNeural',
    azureVoice: 'ru-RU-SvetlanaNeural',
    edgeProviderAliases: [],
  },
  memory: {
    curatorKeywords: [],
  },
  chatSecrets: {
    unitWords: [],
  },
  credentialDetector: {
    peopleWords: [],
    nameWords: [],
    serviceWords: [],
    accountWords: [],
  },
  prompts: {
    ownerName: 'the owner',
    secretHolderExample: 'бухгалтера',
    helperUnreachableHint:
      'check that the configured local helper service is running and that its loopback port is reachable.',
    helperPermissionTarget: 'the Node.js executable that runs the helper',
    workTargetHint: 'Exact execution environment and project.',
    taskTitleExample: 'Слежка за обновлением сервиса',
  },
  retention: {
    reportChatId: null,
  },
  skillsSeed: {
    adminFolders: ['telegram_main'],
    extraSkills: [],
  },
  skills: {
    selectionPatterns: [],
  },
});

// --- Validation ---------------------------------------------------------------
// A check returns the accepted value (a frozen copy for lists and objects) or
// undefined when the value is not usable; the key then keeps its neutral
// default. Values are never changed: what the file says is what code gets.

type Check<T> = (value: unknown) => T | undefined;

// Control characters and the line and paragraph separators.
const CONTROL_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const GROUP_FOLDER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const LAUNCHD_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UNIT_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const GOOGLE_CALENDAR_ID = /^[A-Za-z0-9.!#$%&'*+=?^_`{|}~@-]{1,256}$/u;
// One word a regular expression can take as it is: letters, marks, digits,
// «'», «’», «_» and «-».
const WORD = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}'’_-]{0,63}$/u;
// A name form may consist of several such words.
const WORD_FORM =
  /^[\p{L}][\p{L}\p{M}'’-]{0,63}(?: [\p{L}][\p{L}\p{M}'’-]{0,63}){0,3}$/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A single line of text of 1..max characters (or empty when allowed). */
function text(max: number, allowEmpty = false): Check<string> {
  return (value) =>
    typeof value === 'string' &&
    value.length <= max &&
    (allowEmpty || value.trim().length > 0) &&
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

function matching(pattern: RegExp, allowEmpty = false): Check<string> {
  return (value) =>
    typeof value === 'string' &&
    ((allowEmpty && value === '') || pattern.test(value))
      ? value
      : undefined;
}

function listOf<T>(item: Check<T>, maxItems: number): Check<readonly T[]> {
  return (value) => {
    if (!Array.isArray(value) || value.length > maxItems) return undefined;
    const out: T[] = [];
    for (const entry of value) {
      const checked = item(entry);
      if (checked === undefined) return undefined;
      out.push(checked);
    }
    return Object.freeze(out);
  };
}

/** A path below some root: no leading slash, no «.» or «..» segments. */
function isRelativePath(value: string): boolean {
  if (value.length < 1 || value.length > 512) return false;
  if (CONTROL_CHARACTER.test(value) || value.includes('\\')) return false;
  return value
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

const relativePath: Check<string> = (value) =>
  typeof value === 'string' && isRelativePath(value) ? value : undefined;

const optionalRelativePath: Check<string> = (value) =>
  value === '' ? '' : relativePath(value);

/** Empty, or an absolute path that may start with the `{home}` placeholder. */
const directoryTemplate: Check<string> = (value) =>
  typeof value === 'string' &&
  value.length <= 512 &&
  !CONTROL_CHARACTER.test(value) &&
  (value === '' || value.startsWith('/') || value.startsWith('{home}/'))
    ? value
    : undefined;

const absolutePathOrEmpty: Check<string> = (value) =>
  typeof value === 'string' &&
  value.length <= 512 &&
  !CONTROL_CHARACTER.test(value) &&
  (value === '' || value.startsWith('/'))
    ? value
    : undefined;

const restartableUnits: Check<Readonly<Record<string, string>>> = (value) => {
  if (!isPlainObject(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 32) return undefined;
  const out: Record<string, string> = {};
  for (const [key, label] of entries) {
    // «main» is the main service: its label comes from launchd.mainLabel.
    if (key === 'main' || !UNIT_KEY.test(key)) return undefined;
    if (typeof label !== 'string' || !LAUNCHD_LABEL.test(label)) {
      return undefined;
    }
    out[key] = label;
  }
  return Object.freeze(out);
};

const launchdUnit: Check<InstanceLaunchdUnit> = (value) => {
  if (!isPlainObject(value)) return undefined;
  const allowed = ['id', 'name', 'label', 'kind', 'periodSec', 'heartbeatLog'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    return undefined;
  }
  const { id, name, label, kind, periodSec, heartbeatLog } = value;
  if (typeof id !== 'string' || !UNIT_KEY.test(id)) return undefined;
  if (text(120)(name) === undefined) return undefined;
  if (typeof label !== 'string' || !LAUNCHD_LABEL.test(label)) return undefined;
  if (kind !== 'daemon' && kind !== 'periodic') return undefined;
  if (
    periodSec !== undefined &&
    (typeof periodSec !== 'number' ||
      !Number.isSafeInteger(periodSec) ||
      periodSec < 1)
  ) {
    return undefined;
  }
  if (heartbeatLog !== undefined && text(512)(heartbeatLog) === undefined) {
    return undefined;
  }
  return Object.freeze({
    id,
    name: name as string,
    label,
    kind,
    ...(periodSec === undefined ? {} : { periodSec: periodSec as number }),
    ...(heartbeatLog === undefined
      ? {}
      : { heartbeatLog: heartbeatLog as string }),
  });
};

const launchdUnits: Check<readonly InstanceLaunchdUnit[]> = (value) => {
  const units = listOf(launchdUnit, 64)(value);
  if (!units) return undefined;
  const ids = new Set(units.map((unit) => unit.id));
  return ids.size === units.length ? units : undefined;
};

/** JSON-only data (what a profile file can hold), copied and frozen. */
function jsonCopy(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) {
      const copy = jsonCopy(entry, depth + 1);
      if (copy === undefined) return undefined;
      out.push(copy);
    }
    return Object.freeze(out);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const copy = jsonCopy(entry, depth + 1);
      if (copy === undefined) return undefined;
      out[key] = copy;
    }
    return Object.freeze(out);
  }
  return undefined;
}

const seedSkill: Check<InstanceSeedSkill> = (value) => {
  if (!isPlainObject(value)) return undefined;
  const allowed = ['frontmatter', 'body', 'before'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    return undefined;
  }
  const frontmatter = jsonCopy(value.frontmatter);
  if (!isPlainObject(frontmatter)) return undefined;
  if (
    typeof frontmatter.name !== 'string' ||
    !SKILL_NAME.test(frontmatter.name) ||
    typeof frontmatter.description !== 'string' ||
    frontmatter.description.trim() === ''
  ) {
    return undefined;
  }
  const { body, before } = value;
  if (typeof body !== 'string' || body.length > 64 * 1024) {
    return undefined;
  }
  if (
    before !== undefined &&
    (typeof before !== 'string' || !SKILL_NAME.test(before))
  ) {
    return undefined;
  }
  return Object.freeze({
    frontmatter: frontmatter as InstanceSeedSkill['frontmatter'],
    body,
    ...(before === undefined ? {} : { before }),
  });
};

const reportChatId: Check<number | null> = (value) =>
  value === null ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value !== 0)
    ? value
    : undefined;

const words = listOf(matching(WORD), 500);

const skillSelectionPattern: Check<InstanceSkillSelectionPattern> = (value) => {
  if (!isPlainObject(value)) return undefined;
  const allowed = ['nameIncludes', 'stems', 'bonus'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    return undefined;
  }
  const { nameIncludes, bonus } = value;
  if (typeof nameIncludes !== 'string' || !SKILL_NAME.test(nameIncludes)) {
    return undefined;
  }
  const stems = listOf(matching(WORD), 64)(value.stems);
  if (!stems || stems.length === 0) return undefined;
  if (
    typeof bonus !== 'number' ||
    !Number.isSafeInteger(bonus) ||
    bonus < 1 ||
    bonus > 100
  ) {
    return undefined;
  }
  return Object.freeze({ nameIncludes, stems, bonus });
};
const wordForms = listOf(matching(WORD_FORM), 32);

// A Microsoft voice name: «ru-RU-SvetlanaNeural», «en-US-Ava:DragonHDLatestNeural».
const VOICE_NAME = /^[A-Za-z]{2,3}-[A-Za-z0-9]{2,8}-[A-Za-z0-9:_-]{1,64}$/u;
// The names tts.ts gives its own providers: an alias must not take one.
const TTS_PROVIDER_NAMES = new Set([
  'azure',
  'edge',
  'espeak',
  'espeak-ng',
  'local',
  'openai',
  'rhvoice',
]);
const ttsProviderAlias: Check<string> = (value) =>
  typeof value === 'string' &&
  /^[a-z0-9][a-z0-9_-]{0,31}$/u.test(value) &&
  !TTS_PROVIDER_NAMES.has(value)
    ? value
    : undefined;

type ProfileChecks = {
  readonly [Group in keyof InstanceProfile]: {
    readonly [Key in keyof InstanceProfile[Group]]: Check<
      InstanceProfile[Group][Key]
    >;
  };
};

const CHECKS: ProfileChecks = {
  assistant: {
    defaultName: matching(/^[\p{L}\p{N}_-]{1,64}$/u),
    notificationTitle: matching(/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,63}$/u),
    addressHandles: listOf(matching(/^@[A-Za-z0-9_]{5,32}$/u), 16),
  },
  owner: {
    taskResultNameForms: wordForms,
    reminderLeadForms: wordForms,
    workFolders: listOf(relativePath, 16),
    adminObjectStems: listOf(matching(WORD), 64),
  },
  telegram: {
    adminAlertJids: listOf(matching(/^(?:tg:)?-?\d{1,20}$/u), 32),
    adminContact: text(64),
    guestPromptOwnerFolder: matching(GROUP_FOLDER),
  },
  google: {
    defaultCalendarId: matching(GOOGLE_CALENDAR_ID, true),
  },
  dashboard: {
    panelSenderName: text(64),
    restartableUnits,
    legacyCrmTopicFile: optionalRelativePath,
  },
  launchd: {
    mainLabel: matching(LAUNCHD_LABEL),
    fallbackHome: absolutePathOrEmpty,
    instanceDir: directoryTemplate,
    watchdogDir: directoryTemplate,
    units: launchdUnits,
  },
  voice: {
    edgeVoice: matching(VOICE_NAME),
    azureVoice: matching(VOICE_NAME),
    edgeProviderAliases: listOf(ttsProviderAlias, 8),
  },
  memory: {
    curatorKeywords: words,
  },
  chatSecrets: {
    unitWords: listOf(matching(WORD), 64),
  },
  credentialDetector: {
    peopleWords: words,
    nameWords: words,
    serviceWords: words,
    accountWords: words,
  },
  prompts: {
    ownerName: text(64),
    secretHolderExample: matching(WORD_FORM),
    helperUnreachableHint: text(400),
    helperPermissionTarget: text(200),
    workTargetHint: text(400),
    taskTitleExample: quotedExample(60),
  },
  retention: {
    reportChatId,
  },
  skillsSeed: {
    adminFolders: listOf(matching(GROUP_FOLDER), 32),
    extraSkills: listOf(seedSkill, 32),
  },
  skills: {
    selectionPatterns: listOf(skillSelectionPattern, 16),
  },
};

export interface InstanceProfileProblems {
  /** Keys whose value was not usable: they keep the neutral default. */
  readonly invalidKeys: string[];
  /** Keys the profile does not know (a typo, or a key of a newer version). */
  readonly unknownKeys: string[];
}

/** Keys starting with «_» are notes for people and are skipped. */
function isNoteKey(key: string): boolean {
  return key.startsWith('_');
}

function keyForLog(key: string): string {
  return key.replace(/[^\w.-]/gu, '?').slice(0, 64);
}

/**
 * Build a full profile from parsed JSON: every known key that is present and
 * valid is taken, everything else is the neutral default. Never throws.
 */
export function normalizeInstanceProfile(
  raw: unknown,
  problems: InstanceProfileProblems = { invalidKeys: [], unknownKeys: [] },
): InstanceProfile {
  const source = isPlainObject(raw) ? raw : {};
  if (raw !== undefined && !isPlainObject(raw)) {
    problems.invalidKeys.push('<root>');
  }
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(CHECKS, key) && !isNoteKey(key)) {
      problems.unknownKeys.push(keyForLog(key));
    }
  }

  const profile: Record<string, unknown> = {};
  for (const group of Object.keys(CHECKS) as Array<keyof InstanceProfile>) {
    const checks = CHECKS[group] as Record<string, Check<unknown>>;
    const neutral = NEUTRAL_INSTANCE_PROFILE[group] as Record<string, unknown>;
    const given = Object.hasOwn(source, group) ? source[group] : undefined;
    const groupSource = isPlainObject(given) ? given : {};
    if (given !== undefined && !isPlainObject(given)) {
      problems.invalidKeys.push(group);
    }
    for (const key of Object.keys(groupSource)) {
      if (!Object.hasOwn(checks, key) && !isNoteKey(key)) {
        problems.unknownKeys.push(`${group}.${keyForLog(key)}`);
      }
    }

    const values: Record<string, unknown> = {};
    for (const key of Object.keys(checks)) {
      values[key] = neutral[key];
      if (!Object.hasOwn(groupSource, key)) continue;
      const checked = checks[key](groupSource[key]);
      if (checked === undefined) problems.invalidKeys.push(`${group}.${key}`);
      else values[key] = checked;
    }
    profile[group] = Object.freeze(values);
  }
  return Object.freeze(profile) as unknown as InstanceProfile;
}

// --- Loading ------------------------------------------------------------------

// packages/shared/{src|dist}/instance-profile.{ts|js} → the repository root.
// The real path: under `node --preserve-symlinks` the module is known by its
// node_modules/@skoobi/shared link, three levels above which is not the root.
function codeRoot(): string {
  let moduleFile = fileURLToPath(import.meta.url);
  try {
    moduleFile = fs.realpathSync(moduleFile);
  } catch {
    // Keep the path the module was loaded by.
  }
  return path.resolve(path.dirname(moduleFile), '..', '..', '..');
}

const CODE_ROOT = codeRoot();

export interface InstanceProfileLocation {
  env?: Record<string, string | undefined>;
  cwd?: string;
  codeRoot?: string;
}

/** The files a profile is looked for in, in order. */
export function instanceProfileCandidatePaths(
  location: InstanceProfileLocation = {},
): string[] {
  const env = location.env ?? process.env;
  const explicit = env[INSTANCE_PROFILE_FILE_ENV];
  if (explicit) {
    try {
      return [path.resolve(explicit)];
    } catch {
      // A relative path and the working directory is gone: no file to read.
      return [];
    }
  }

  const candidates: string[] = [];
  let cwd = location.cwd;
  if (cwd === undefined) {
    try {
      cwd = process.cwd();
    } catch {
      // The working directory is gone: only the code root is left.
    }
  }
  if (cwd !== undefined) {
    candidates.push(path.resolve(cwd, INSTANCE_PROFILE_RELATIVE_PATH));
  }
  const fromCode = path.resolve(
    location.codeRoot ?? CODE_ROOT,
    INSTANCE_PROFILE_RELATIVE_PATH,
  );
  if (!candidates.includes(fromCode)) candidates.push(fromCode);
  return candidates;
}

type ProfileFileRead =
  | { status: 'missing' }
  | { status: 'unusable'; reason: string }
  | { status: 'ok'; value: unknown };

function readProfileFile(file: string): ProfileFileRead {
  let content: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { status: 'unusable', reason: 'not a file' };
    if (stat.size > MAX_INSTANCE_PROFILE_BYTES) {
      return { status: 'unusable', reason: 'file is too large' };
    }
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing' };
    return { status: 'unusable', reason: code || 'read failed' };
  }
  try {
    return { status: 'ok', value: JSON.parse(content.replace(/^\uFEFF/u, '')) };
  } catch {
    // The parser's own message quotes the text around the error: not logged.
    return { status: 'unusable', reason: 'invalid JSON' };
  }
}

export interface LoadedInstanceProfile {
  readonly profile: InstanceProfile;
  /** The file the profile came from; null when the defaults apply. */
  readonly file: string | null;
  /** Why the file found could not be used (it is then ignored as a whole). */
  readonly unusable: string | null;
  readonly problems: InstanceProfileProblems;
}

/** Read the profile from disk without caching or logging. Never throws. */
export function loadInstanceProfile(
  location: InstanceProfileLocation = {},
): LoadedInstanceProfile {
  const problems: InstanceProfileProblems = {
    invalidKeys: [],
    unknownKeys: [],
  };
  for (const file of instanceProfileCandidatePaths(location)) {
    const read = readProfileFile(file);
    if (read.status === 'missing') continue;
    if (read.status === 'unusable') {
      return {
        profile: NEUTRAL_INSTANCE_PROFILE,
        file,
        unusable: read.reason,
        problems,
      };
    }
    if (!isPlainObject(read.value)) {
      return {
        profile: NEUTRAL_INSTANCE_PROFILE,
        file,
        unusable: 'not a JSON object',
        problems,
      };
    }
    return {
      profile: normalizeInstanceProfile(read.value, problems),
      file,
      unusable: null,
      problems,
    };
  }
  return {
    profile: NEUTRAL_INSTANCE_PROFILE,
    file: null,
    unusable: null,
    problems,
  };
}

function logLoaded(loaded: LoadedInstanceProfile): void {
  // A logger a test replaced with a partial double must not break loading.
  try {
    if (loaded.unusable) {
      // An installation that has a profile and silently runs without it is
      // misconfigured (no alert chat, no calendar, another job list): an
      // error, so that whatever watches the log for errors sees it.
      logger.error(
        { file: loaded.file, reason: loaded.unusable },
        'Instance profile is unusable, neutral defaults apply',
      );
    } else if (loaded.problems.invalidKeys.length > 0) {
      logger.error(
        {
          file: loaded.file,
          invalidKeys: loaded.problems.invalidKeys,
          unknownKeys: loaded.problems.unknownKeys,
        },
        'Instance profile has unusable keys, neutral defaults apply to them',
      );
    } else if (loaded.problems.unknownKeys.length > 0) {
      // A key of another version or a typo: nothing fell back to a default.
      logger.warn(
        {
          file: loaded.file,
          invalidKeys: loaded.problems.invalidKeys,
          unknownKeys: loaded.problems.unknownKeys,
        },
        'Instance profile has unknown keys, they are ignored',
      );
    } else if (loaded.file === null) {
      logger.debug('Instance profile not found, neutral defaults apply');
    } else {
      logger.debug({ file: loaded.file }, 'Instance profile loaded');
    }
  } catch {
    // Logging is best effort.
  }
}

// --- The profile of this process ------------------------------------------------

// Shared with agent/runner/src/instance-profile.ts, so one injection reaches
// both copies of code that exists on the host and in the runner.
const TEST_OVERRIDE_KEY = Symbol.for('skoobi.instance-profile.test-override');
// What a reset goes back to. setup/vitest-env.ts puts the empty profile here,
// so a test that resets does not start reading files.
const TEST_BASELINE_KEY = Symbol.for('skoobi.instance-profile.test-baseline');

type OverrideHolder = {
  [TEST_OVERRIDE_KEY]?: unknown;
  [TEST_BASELINE_KEY]?: unknown;
};

/** How the profile of this process was loaded: key names only, no values. */
export interface InstanceProfileStatus {
  /** The file the profile was looked up in; null when none was found. */
  readonly file: string | null;
  /** Why the file found was ignored as a whole; null when it was read. */
  readonly unusable: string | null;
  /** Keys whose value was not usable: they have the neutral default. */
  readonly invalidKeys: readonly string[];
  /** Keys the profile does not know: they are ignored. */
  readonly unknownKeys: readonly string[];
}

const CLEAN_STATUS: InstanceProfileStatus = deepFreeze({
  file: null,
  unusable: null,
  invalidKeys: [],
  unknownKeys: [],
});

let cached: InstanceProfile | undefined;
let cachedStatus: InstanceProfileStatus | undefined;
let cachedOverrideSource: unknown;
let cachedOverride: InstanceProfile | undefined;

/**
 * The profile of this installation. Loaded once; never throws. The same
 * object is returned until the profile changes (a test injects another one).
 */
export function instanceProfile(): InstanceProfile {
  const override = (globalThis as OverrideHolder)[TEST_OVERRIDE_KEY];
  if (override !== undefined) {
    if (cachedOverrideSource !== override || !cachedOverride) {
      cachedOverride = normalizeInstanceProfile(override);
      cachedOverrideSource = override;
    }
    return cachedOverride;
  }
  if (!cached) {
    let loaded: LoadedInstanceProfile;
    try {
      loaded = loadInstanceProfile();
    } catch {
      loaded = {
        profile: NEUTRAL_INSTANCE_PROFILE,
        file: null,
        unusable: 'could not be read',
        problems: { invalidKeys: [], unknownKeys: [] },
      };
    }
    logLoaded(loaded);
    cachedStatus = deepFreeze({
      file: loaded.file,
      unusable: loaded.unusable,
      invalidKeys: [...loaded.problems.invalidKeys],
      unknownKeys: [...loaded.problems.unknownKeys],
    });
    cached = loaded.profile;
  }
  return cached;
}

/**
 * How the profile of this process was loaded. A file that was ignored
 * (`unusable`) or only partly used (`invalidKeys`, `unknownKeys`) means the
 * installation runs on neutral defaults it did not ask for. A missing file is
 * not a problem here: an installation may have none. Never throws; with a
 * profile injected by a test the status is clean.
 */
export function instanceProfileStatus(): InstanceProfileStatus {
  if ((globalThis as OverrideHolder)[TEST_OVERRIDE_KEY] !== undefined) {
    return CLEAN_STATUS;
  }
  instanceProfile();
  return cachedStatus ?? CLEAN_STATUS;
}

/** True when a profile file exists but was ignored or only partly used. */
export function instanceProfileNeedsAttention(
  status: InstanceProfileStatus = instanceProfileStatus(),
): boolean {
  return (
    status.unusable !== null ||
    status.invalidKeys.length > 0 ||
    status.unknownKeys.length > 0
  );
}

/**
 * A value computed from the profile and kept until the profile changes: for
 * sets and regular expressions built from profile lists. Call the returned
 * function where the value is used; do not store its result in a module-level
 * constant.
 */
export function derivedFromInstanceProfile<T>(
  compute: (profile: InstanceProfile) => T,
): () => T {
  let source: InstanceProfile | undefined;
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

/** The part of the profile sent to the agent runner with every run. */
export function runnerInstanceProfile(
  profile: InstanceProfile = instanceProfile(),
): RunnerInstanceProfile {
  return {
    credentialDetector: profile.credentialDetector,
    prompts: profile.prompts,
  };
}

/**
 * Tests: use this synthetic profile instead of any file. Keys that are not
 * given stay neutral. Throws on a key the profile does not know or a value it
 * would not accept, so a test cannot inject something production would drop.
 */
export function setInstanceProfileForTests(input: InstanceProfileInput): void {
  const problems: InstanceProfileProblems = {
    invalidKeys: [],
    unknownKeys: [],
  };
  normalizeInstanceProfile(input, problems);
  if (problems.invalidKeys.length > 0 || problems.unknownKeys.length > 0) {
    throw new Error(
      `Invalid instance profile for tests: ${[
        ...problems.invalidKeys,
        ...problems.unknownKeys,
      ].join(', ')}`,
    );
  }
  (globalThis as OverrideHolder)[TEST_OVERRIDE_KEY] = deepFreeze(
    JSON.parse(JSON.stringify(input)),
  );
}

/**
 * Tests: drop the injected profile and the cached file read. Under
 * setup/vitest-env.ts the profile is then the empty injected one again (the
 * neutral defaults); without that setup the next read looks for the file.
 */
export function resetInstanceProfileForTests(): void {
  const holder = globalThis as OverrideHolder;
  if (holder[TEST_BASELINE_KEY] !== undefined) {
    holder[TEST_OVERRIDE_KEY] = holder[TEST_BASELINE_KEY];
  } else {
    delete holder[TEST_OVERRIDE_KEY];
  }
  cached = undefined;
  cachedStatus = undefined;
  cachedOverride = undefined;
  cachedOverrideSource = undefined;
}
