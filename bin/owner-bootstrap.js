import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const MAX_ENV_BYTES = 1024 * 1024;
const OWNER_FOLDER = 'telegram_main';
const DEFAULT_BOT_ID = 'telegram_default';
const TELEGRAM_USER_ID = /^[1-9][0-9]{0,19}$/;
const TELEGRAM_CHAT_ID = /^-?[1-9][0-9]{0,19}$/;
const REQUIRED_GROUP_COLUMNS = new Set([
  'jid',
  'name',
  'folder',
  'trigger_pattern',
  'added_at',
  'requires_trigger',
  'is_main',
  'runtime',
]);

function ownerUid() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function assertOwner(stat, label) {
  const uid = ownerUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${label} must be owned by the current user`);
  }
}

function assertPrivateDirectory(dir, label) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    throw new Error(`${label} is missing; install the instance first`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  assertOwner(stat, label);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible to group or other users`);
  }
}

function assertSafeFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(
      `${label} is missing; install and start the instance first`,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  assertOwner(stat, label);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must be readable only by the current user`);
  }
  return stat;
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readSafeEnvFile(file) {
  assertSafeFile(file, 'Instance .env');
  let fd;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 0 ||
      before.size > MAX_ENV_BYTES
    ) {
      throw new Error('Instance .env has unsafe metadata');
    }
    assertOwner(before, 'Instance .env');
    const content = fs.readFileSync(fd, 'utf8');
    const after = fs.fstatSync(fd);
    if (
      Buffer.byteLength(content) !== before.size ||
      !sameFileSnapshot(before, after)
    ) {
      throw new Error('Instance .env changed while it was being read');
    }
    return { content, stat: after };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function fsyncDirectory(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // The file itself was fsynced. Some filesystems do not permit directory
    // fsync, so this durability enhancement remains best-effort.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function atomicReplaceEnv(
  file,
  expected,
  content,
  mode = expected.stat.mode & 0o777,
) {
  const current = readSafeEnvFile(file);
  if (
    current.content !== expected.content ||
    !sameFileSnapshot(current.stat, expected.stat)
  ) {
    throw new Error('Instance .env changed concurrently; no owner was added');
  }

  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.env.owner-${process.pid}-${randomBytes(12).toString('hex')}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      mode,
    );
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    const beforeRename = readSafeEnvFile(file);
    if (
      beforeRename.content !== expected.content ||
      !sameFileSnapshot(beforeRename.stat, expected.stat)
    ) {
      throw new Error('Instance .env changed concurrently; no owner was added');
    }
    fs.renameSync(tmp, file);
    fs.chmodSync(file, mode);
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The temporary file is absent after a successful rename.
    }
  }
}

function envEntries(content, key) {
  const matches = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const match = line.match(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/);
    if (match?.[1] === key) matches.push({ index, raw: match[2] });
  }
  if (matches.length > 1) {
    throw new Error(`Instance .env contains duplicate ${key} entries`);
  }
  return matches;
}

function decodeEnvValue(raw, key) {
  const value = raw.trim();
  if (!value) return '';
  const first = value[0];
  if (first === '"' || first === "'") {
    if (value.length < 2 || value.at(-1) !== first) {
      throw new Error(`Instance .env contains malformed ${key}`);
    }
    return value.slice(1, -1);
  }
  return value;
}

function envValue(content, key) {
  const matches = envEntries(content, key);
  return matches.length === 0 ? '' : decodeEnvValue(matches[0].raw, key);
}

function setEnvValue(content, key, value) {
  const lines = content.split(/\r?\n/);
  const matches = envEntries(content, key);
  const replacement = `${key}="${value}"`;
  if (matches.length === 1) {
    lines[matches[0].index] = replacement;
  } else {
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(replacement);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function parseIdList(content, key, pattern = TELEGRAM_USER_ID) {
  const raw = envValue(content, key);
  if (!raw) return new Set();
  const ids = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.some((id) => !pattern.test(id))) {
    throw new Error(`Instance .env contains an invalid ${key} entry`);
  }
  return new Set(ids);
}

function safeBotId(content) {
  const configured = envValue(content, 'SKOOBI_TELEGRAM_BOT_ID');
  const normalized = (configured || DEFAULT_BOT_ID)
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || DEFAULT_BOT_ID;
}

function botJidSegment(botId) {
  return /^-?\d+$/.test(botId) ? `bot=${botId}` : botId;
}

function jidForPrivateUser(userId, botId) {
  return botId === DEFAULT_BOT_ID
    ? `tg:${userId}`
    : `tg:${botJidSegment(botId)}:${userId}`;
}

function parseOwnerArgument(value, botId) {
  const trimmed = String(value || '').trim();
  if (TELEGRAM_USER_ID.test(trimmed)) {
    return {
      userId: trimmed,
      jid: jidForPrivateUser(trimmed, botId),
    };
  }

  const expectedPrefix =
    botId === DEFAULT_BOT_ID ? 'tg:' : `tg:${botJidSegment(botId)}:`;
  if (!trimmed.startsWith(expectedPrefix)) {
    throw new Error(
      'Use the numeric private Telegram ID or exact tg: value from /chatid',
    );
  }
  const userId = trimmed.slice(expectedPrefix.length);
  if (!TELEGRAM_USER_ID.test(userId)) {
    throw new Error(
      'The owner must be a private Telegram user with a numeric ID',
    );
  }
  return { userId, jid: trimmed };
}

function assertManagedStatePaths(paths) {
  if (
    !path.isAbsolute(paths.prefix) ||
    paths.prefix.includes('\n') ||
    paths.prefix.includes('\r')
  ) {
    throw new Error('Install prefix must be an absolute safe path');
  }
  assertPrivateDirectory(paths.prefix, 'Install prefix');
  assertPrivateDirectory(
    path.join(paths.prefix, 'instances'),
    'Instances directory',
  );
  assertPrivateDirectory(paths.instanceDir, 'Instance directory');
  assertPrivateDirectory(
    path.join(paths.instanceDir, 'store'),
    'Instance store',
  );
  assertPrivateDirectory(
    path.join(paths.instanceDir, 'groups'),
    'Instance groups',
  );
  assertSafeFile(paths.envFile, 'Instance .env');
  assertSafeFile(paths.dbFile, 'Instance database');
}

function acquireOperationLock(paths) {
  const lockDir = path.join(paths.prefix, '.skoobi-operation.lock');
  try {
    fs.mkdirSync(lockDir, { mode: 0o700 });
  } catch (err) {
    if (err?.code === 'EEXIST') {
      throw new Error(
        'Another Skoobi install, update, uninstall, or owner setup is in progress',
      );
    }
    throw err;
  }
  const stat = fs.lstatSync(lockDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Could not acquire a safe Skoobi operation lock');
  }
  assertOwner(stat, 'Skoobi operation lock');
  return { lockDir, stat };
}

function releaseOperationLock(lock) {
  const current = fs.lstatSync(lock.lockDir);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== lock.stat.dev ||
    current.ino !== lock.stat.ino
  ) {
    throw new Error('Skoobi operation lock changed unexpectedly');
  }
  fs.rmdirSync(lock.lockDir);
}

function assertSchema(database) {
  const columns = database
    .prepare(`PRAGMA table_info(registered_groups)`)
    .all()
    .map((row) => row.name);
  if (
    columns.length === 0 ||
    [...REQUIRED_GROUP_COLUMNS].some((column) => !columns.includes(column))
  ) {
    throw new Error(
      'Instance database is not initialized; start Skoobi once and retry',
    );
  }
}

function mainRows(database) {
  return database
    .prepare(
      `SELECT jid, folder, requires_trigger, runtime
       FROM registered_groups
       WHERE is_main = 1
       ORDER BY jid`,
    )
    .all();
}

function validateRegistrationState(database, jid) {
  const mains = mainRows(database);
  if (
    mains.length > 1 ||
    (mains.length === 1 &&
      (mains[0].jid !== jid || mains[0].folder !== OWNER_FOLDER))
  ) {
    throw new Error(
      'A different or ambiguous main registration already exists; refusing to replace it',
    );
  }

  const jidRow = database
    .prepare(
      `SELECT jid, folder, requires_trigger, is_main, runtime
       FROM registered_groups
       WHERE jid = ?`,
    )
    .get(jid);
  if (jidRow && (jidRow.folder !== OWNER_FOLDER || jidRow.is_main !== 1)) {
    throw new Error(
      'This Telegram identity already has a different registration; refusing to replace it',
    );
  }
  if (
    jidRow &&
    (jidRow.requires_trigger !== 0 || jidRow.runtime !== 'sandbox')
  ) {
    throw new Error(
      'The existing main registration is not owner-ready; refusing to modify it',
    );
  }

  const folderRow = database
    .prepare(
      `SELECT jid, folder, is_main
       FROM registered_groups
       WHERE folder = ?`,
    )
    .get(OWNER_FOLDER);
  if (folderRow && folderRow.jid !== jid) {
    throw new Error(
      'The owner workspace already belongs to another registration; refusing to replace it',
    );
  }
  return Boolean(jidRow);
}

function assertOwnerWorkspace(
  paths,
  allowExistingData,
  created = [],
  modeChanges = [],
) {
  const base = path.join(paths.instanceDir, 'groups');
  const ownerDir = path.join(base, OWNER_FOLDER);
  if (fs.existsSync(ownerDir)) {
    const ownerStat = fs.lstatSync(ownerDir);
    if (!ownerStat.isDirectory() || ownerStat.isSymbolicLink()) {
      throw new Error('Owner workspace contains an unsafe path');
    }
    assertOwner(ownerStat, 'Owner workspace');
    if (!allowExistingData) {
      for (const entry of fs.readdirSync(ownerDir)) {
        if (entry !== 'logs') {
          throw new Error(
            'An unregistered owner workspace already contains data; refusing to attach it',
          );
        }
        const child = path.join(ownerDir, entry);
        const stat = fs.lstatSync(child);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          fs.readdirSync(child).length !== 0
        ) {
          throw new Error(
            'An unregistered owner workspace already contains data; refusing to attach it',
          );
        }
        assertOwner(stat, 'Owner workspace');
      }
    }
  }

  for (const dir of [ownerDir, path.join(ownerDir, 'logs')]) {
    if (fs.existsSync(dir)) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Owner workspace contains an unsafe path');
      }
      assertOwner(stat, 'Owner workspace');
      const mode = stat.mode & 0o777;
      if (mode !== 0o700) {
        modeChanges.push({ dir, dev: stat.dev, ino: stat.ino, mode });
      }
    } else {
      fs.mkdirSync(dir);
      const stat = fs.lstatSync(dir);
      created.push({ dir, dev: stat.dev, ino: stat.ino });
    }
    fs.chmodSync(dir, 0o700);
  }
  return created;
}

function restoreWorkspaceModes(modeChanges) {
  for (const entry of [...modeChanges].reverse()) {
    try {
      const stat = fs.lstatSync(entry.dir);
      if (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.dev === entry.dev &&
        stat.ino === entry.ino
      ) {
        fs.chmodSync(entry.dir, entry.mode);
      }
    } catch {
      // Preserve any path that changed or disappeared during recovery.
    }
  }
}

function removeEmptyCreatedWorkspaceDirs(created) {
  for (const entry of [...created].reverse()) {
    try {
      const stat = fs.lstatSync(entry.dir);
      if (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.dev === entry.dev &&
        stat.ino === entry.ino &&
        fs.readdirSync(entry.dir).length === 0
      ) {
        fs.rmdirSync(entry.dir);
      }
    } catch {
      // Preserve any path that changed or became non-empty during recovery.
    }
  }
}

function openDatabase(paths, readonly = false) {
  assertSafeFile(paths.dbFile, 'Instance database');
  const database = new Database(paths.dbFile, {
    fileMustExist: true,
    readonly,
  });
  try {
    database.pragma('busy_timeout = 5000');
    assertSchema(database);
    return database;
  } catch (err) {
    database.close();
    throw err;
  }
}

function ownerRegistrationReady(database, jid) {
  const row = database
    .prepare(
      `SELECT jid, folder, requires_trigger, is_main, runtime
       FROM registered_groups
       WHERE jid = ?`,
    )
    .get(jid);
  return (
    row?.jid === jid &&
    row.folder === OWNER_FOLDER &&
    row.requires_trigger === 0 &&
    row.is_main === 1 &&
    row.runtime === 'sandbox' &&
    mainRows(database).length === 1
  );
}

export function initializeTelegramOwner(paths, ownerArgument) {
  assertPrivateDirectory(paths.prefix, 'Install prefix');
  const lock = acquireOperationLock(paths);
  try {
    assertManagedStatePaths(paths);
    const env = readSafeEnvFile(paths.envFile);
    if (!envValue(env.content, 'TELEGRAM_BOT_TOKEN')) {
      throw new Error(
        'Telegram bot token is not configured; rerun the installer with --reconfigure',
      );
    }

    const botId = safeBotId(env.content);
    const { userId, jid } = parseOwnerArgument(ownerArgument, botId);
    const ownerIds = parseIdList(env.content, 'OWNER_TELEGRAM_USER_IDS');
    const chatIds = parseIdList(
      env.content,
      'OWNER_TELEGRAM_CHAT_IDS',
      TELEGRAM_CHAT_ID,
    );
    if (ownerIds.size > 0 && !ownerIds.has(userId)) {
      throw new Error(
        'A different owner allowlist already exists; refusing to add another owner',
      );
    }
    if (chatIds.size > 0 && !chatIds.has(userId)) {
      throw new Error(
        'The existing Telegram chat allowlist excludes this private chat; refusing to widen it',
      );
    }
    const nextEnv =
      ownerIds.size > 0
        ? env.content
        : setEnvValue(env.content, 'OWNER_TELEGRAM_USER_IDS', userId);

    const database = openDatabase(paths);
    let inserted = false;
    let envWriteAttempted = false;
    let commitAttempted = false;
    const createdWorkspaceDirs = [];
    const workspaceModeChanges = [];
    try {
      database.exec('BEGIN IMMEDIATE');
      const alreadyRegistered = validateRegistrationState(database, jid);
      assertOwnerWorkspace(
        paths,
        alreadyRegistered,
        createdWorkspaceDirs,
        workspaceModeChanges,
      );
      if (!alreadyRegistered) {
        const insertedAt = new Date().toISOString();
        database
          .prepare(
            `INSERT INTO registered_groups
               (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main, runtime)
             VALUES (?, ?, ?, ?, ?, 0, 1, 'sandbox')`,
          )
          .run(jid, 'Owner', OWNER_FOLDER, '@Skoobi', insertedAt);
        inserted = true;
      }
      if (nextEnv !== env.content) {
        envWriteAttempted = true;
        atomicReplaceEnv(paths.envFile, env, nextEnv);
      }
      commitAttempted = true;
      database.exec('COMMIT');
    } catch (err) {
      let commitVerified = false;
      if (commitAttempted && !database.inTransaction) {
        try {
          const current = readSafeEnvFile(paths.envFile);
          commitVerified =
            current.content === nextEnv &&
            ownerRegistrationReady(database, jid);
        } catch {
          commitVerified = false;
        }
      }
      if (commitVerified) {
        // SQLite committed but the driver reported an ambiguous post-commit
        // failure. The exact owner row and env state prove the operation won.
      } else {
        let envRecoveryFailed = false;
        try {
          database.exec('ROLLBACK');
        } catch {
          // Closing the connection below is the final SQLite rollback attempt.
        }
        if (envWriteAttempted) {
          try {
            const current = readSafeEnvFile(paths.envFile);
            if (current.content === nextEnv) {
              atomicReplaceEnv(paths.envFile, current, env.content);
            } else if (current.content !== env.content) {
              throw new Error('unexpected content');
            }
          } catch {
            envRecoveryFailed = true;
          }
        }
        restoreWorkspaceModes(workspaceModeChanges);
        removeEmptyCreatedWorkspaceDirs(createdWorkspaceDirs);
        if (envRecoveryFailed) {
          throw new Error(
            'Owner setup did not commit, but .env recovery needs manual review before restart',
          );
        }
        throw err;
      }
    } finally {
      database.close();
    }

    assertOwnerWorkspace(paths, true);
    return { created: inserted, jid };
  } finally {
    releaseOperationLock(lock);
  }
}

export function inspectTelegramOwner(paths) {
  assertManagedStatePaths(paths);
  const env = readSafeEnvFile(paths.envFile);
  const tokenConfigured = Boolean(envValue(env.content, 'TELEGRAM_BOT_TOKEN'));
  const ownerIds = parseIdList(env.content, 'OWNER_TELEGRAM_USER_IDS');
  const chatIds = parseIdList(
    env.content,
    'OWNER_TELEGRAM_CHAT_IDS',
    TELEGRAM_CHAT_ID,
  );
  const botId = safeBotId(env.content);
  const gatewayType =
    envValue(env.content, 'SKOOBI_MODEL_GATEWAY_TYPE') || 'disabled';
  const gatewayKeyConfigured = Boolean(
    envValue(env.content, 'SKOOBI_MODEL_GATEWAY_KEY'),
  );
  const anthropicAuthConfigured = Boolean(
    envValue(env.content, 'ANTHROPIC_API_KEY') ||
    envValue(env.content, 'CLAUDE_CODE_OAUTH_TOKEN') ||
    envValue(env.content, 'ANTHROPIC_AUTH_TOKEN'),
  );
  const codexCommand = envValue(env.content, 'SKOOBI_CODEX_COMMAND') || 'codex';
  const isTrue = (key) => /^(1|true|yes|on)$/i.test(envValue(env.content, key));
  const ownerCodexConfigured =
    gatewayType === 'codex_subscription_cli' &&
    isTrue('SKOOBI_CODEX_SUBSCRIPTION_ENABLED') &&
    isTrue('SKOOBI_TELEGRAM_OWNER_LIVE_ENABLED') &&
    isTrue('SKOOBI_CODEX_OWNER_FULL_AGENT_ENABLED') &&
    isTrue('SKOOBI_SCHEDULED_TASKS_CODEX_PRIMARY') &&
    (envValue(env.content, 'SKOOBI_CODEX_OWNER_FULL_AGENT_MODE') || 'auto') ===
      'always';
  const database = openDatabase(paths, true);
  try {
    const mains = mainRows(database);
    const matching =
      mains.length === 1 &&
      mains[0].folder === OWNER_FOLDER &&
      mains[0].requires_trigger === 0 &&
      mains[0].runtime === 'sandbox' &&
      [...ownerIds].some(
        (userId) =>
          mains[0].jid === jidForPrivateUser(userId, botId) &&
          (chatIds.size === 0 || chatIds.has(userId)),
      );
    return {
      tokenConfigured,
      ownerConfigured: matching,
      mainCount: mains.length,
      gatewayType,
      gatewayKeyConfigured,
      anthropicAuthConfigured,
      codexCommand,
      ownerCodexConfigured,
    };
  } finally {
    database.close();
  }
}
