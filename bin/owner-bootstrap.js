import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const MAX_ENV_BYTES = 1024 * 1024;
const OWNER_FOLDER = 'telegram_main';
const DEFAULT_BOT_ID = 'telegram_default';
const TELEGRAM_USER_ID = /^[1-9][0-9]{0,19}$/;
const TELEGRAM_CHAT_ID = /^-?[1-9][0-9]{0,19}$/;
const TELEGRAM_BOT_TOKEN =
  /^[1-9][0-9]{5,19}:[A-Za-z0-9_-]{30,100}$/;
const OPERATION_LOCK_FORMAT = '1';
const OPERATION_LOCK_OWNER_MAX_BYTES = 4096;
const OPERATION_LOCK_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const OPERATION_LOCK_BOOT_ID =
  /^(?:linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|darwin:[0-9]+:[0-9]+)$/;
const OPERATION_LOCK_START_ID =
  /^(?:linux:[0-9]+|darwin:(?:0|[1-9][0-9]*):(Sun|Mon|Tue|Wed|Thu|Fri|Sat):(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec):(?:[1-9]|[12][0-9]|3[01]):(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]:[0-9]{4})$/;
const OPERATION_LOCK_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const OPERATION_LOCK_BUSY =
  'Another Skoobi install, update, uninstall, or owner setup is in progress';
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

function lstatIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return undefined;
    throw err;
  }
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPrivateLockDirectory(stat) {
  const uid = ownerUid();
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    (uid === undefined || stat.uid === uid) &&
    (stat.mode & 0o777) === 0o700
  );
}

function isOwnedRealDirectory(stat) {
  const uid = ownerUid();
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    (uid === undefined || stat.uid === uid)
  );
}

function parseLinuxProcessStart(content, expectedPid) {
  const close = content.lastIndexOf(')');
  if (
    close < 3 ||
    content[0] !== String(expectedPid)[0] ||
    content.slice(0, content.indexOf(' ')) !== String(expectedPid)
  ) {
    return undefined;
  }
  const fields = content.slice(close + 1).trim().split(/\s+/);
  const start = fields[19];
  return /^[0-9]+$/.test(start || '') ? `linux:${start}` : undefined;
}

function currentBootId() {
  if (process.platform === 'linux') {
    const value = fs
      .readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
      .trim()
      .toLowerCase();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value,
      )
    ) {
      throw new Error('Linux boot identity is unavailable');
    }
    return `linux:${value}`;
  }

  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 4096,
    });
    if (result.status !== 0 || result.error) {
      throw new Error('macOS boot identity is unavailable');
    }
    const match = result.stdout.match(
      /\bsec\s*=\s*([0-9]+)\s*,\s*usec\s*=\s*([0-9]+)/,
    );
    if (!match) throw new Error('macOS boot identity is unavailable');
    return `darwin:${Number(match[1])}:${Number(match[2])}`;
  }

  throw new Error('Operation locks are supported only on Linux and macOS');
}

function processStartState(pid) {
  if (process.platform === 'linux') {
    try {
      const content = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const startId = parseLinuxProcessStart(content, pid);
      return startId
        ? { state: 'present', startId }
        : { state: 'unknown' };
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ESRCH') {
        return { state: 'absent' };
      }
      return { state: 'unknown' };
    }
  }

  if (process.platform === 'darwin') {
    const result = spawnSync(
      '/bin/ps',
      ['-p', String(pid), '-o', 'uid=', '-o', 'lstart='],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        maxBuffer: 4096,
      },
    );
    const fields = String(result.stdout || '')
      .trim()
      .split(/\s+/);
    if (
      result.status === 0 &&
      !result.error &&
      fields.length === 6 &&
      /^(0|[1-9][0-9]*)$/.test(fields[0]) &&
      /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/.test(fields[1]) &&
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(
        fields[2],
      ) &&
      /^(?:[1-9]|[12][0-9]|3[01])$/.test(fields[3]) &&
      /^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/.test(fields[4]) &&
      /^[0-9]{4}$/.test(fields[5])
    ) {
      return {
        state: 'present',
        startId: `darwin:${fields.join(':')}`,
      };
    }
    try {
      process.kill(pid, 0);
      return { state: 'unknown' };
    } catch (err) {
      return err?.code === 'ESRCH'
        ? { state: 'absent' }
        : { state: 'unknown' };
    }
  }

  return { state: 'unknown' };
}

function operationOwnerContent(operation) {
  const uid = ownerUid();
  if (
    uid === undefined ||
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    !OPERATION_LOCK_NAME.test(operation)
  ) {
    throw new Error('Could not create Skoobi operation lock metadata');
  }
  const processState = processStartState(process.pid);
  if (processState.state !== 'present') {
    throw new Error('Could not determine the current process identity');
  }
  const token = randomBytes(32).toString('hex');
  const record = {
    format: OPERATION_LOCK_FORMAT,
    token,
    pid: process.pid,
    uid,
    bootId: currentBootId(),
    startId: processState.startId,
    operation,
    createdAt: Math.floor(Date.now() / 1000),
  };
  const content = [
    `format=${record.format}`,
    `token=${record.token}`,
    `pid=${record.pid}`,
    `uid=${record.uid}`,
    `boot_id=${record.bootId}`,
    `start_id=${record.startId}`,
    `operation=${record.operation}`,
    `created_at=${record.createdAt}`,
    '',
  ].join('\n');
  return { record, content: Buffer.from(content, 'utf8') };
}

function parseOperationOwner(content) {
  const text = content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(content)) return undefined;
  const lines = text.split('\n');
  if (lines.length !== 9 || lines.at(-1) !== '') return undefined;
  const expectedKeys = [
    'format',
    'token',
    'pid',
    'uid',
    'boot_id',
    'start_id',
    'operation',
    'created_at',
  ];
  const values = {};
  for (const [index, key] of expectedKeys.entries()) {
    const prefix = `${key}=`;
    if (!lines[index].startsWith(prefix)) return undefined;
    values[key] = lines[index].slice(prefix.length);
  }
  if (
    values.format !== OPERATION_LOCK_FORMAT ||
    !OPERATION_LOCK_TOKEN.test(values.token) ||
    !/^[1-9][0-9]*$/.test(values.pid) ||
    !/^(0|[1-9][0-9]*)$/.test(values.uid) ||
    !OPERATION_LOCK_BOOT_ID.test(values.boot_id) ||
    !OPERATION_LOCK_START_ID.test(values.start_id) ||
    !OPERATION_LOCK_NAME.test(values.operation) ||
    !/^(0|[1-9][0-9]*)$/.test(values.created_at)
  ) {
    return undefined;
  }
  const pid = Number(values.pid);
  const uid = Number(values.uid);
  const createdAt = Number(values.created_at);
  if (
    !Number.isSafeInteger(pid) ||
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(createdAt)
  ) {
    return undefined;
  }
  return {
    format: values.format,
    token: values.token,
    pid,
    uid,
    bootId: values.boot_id,
    startId: values.start_id,
    operation: values.operation,
    createdAt,
  };
}

function readOperationOwner(ownerFile) {
  let fd;
  try {
    fd = fs.openSync(
      ownerFile,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(fd);
    const uid = ownerUid();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > OPERATION_LOCK_OWNER_MAX_BYTES ||
      (uid !== undefined && before.uid !== uid) ||
      (before.mode & 0o777) !== 0o600
    ) {
      return undefined;
    }
    const content = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (
      content.length !== before.size ||
      !sameFileSnapshot(before, after)
    ) {
      return undefined;
    }
    const pathStat = lstatIfPresent(ownerFile);
    if (!pathStat || !sameFileSnapshot(after, pathStat)) return undefined;
    const record = parseOperationOwner(content);
    return record ? { stat: after, content, record } : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function operationLockSnapshot(lockDir, entriesExpected) {
  try {
    const before = lstatIfPresent(lockDir);
    if (!before) return { state: 'vanished' };
    if (!isPrivateLockDirectory(before)) return { state: 'unknown' };
    const entries = fs.readdirSync(lockDir).sort();
    if (
      entries.length !== entriesExpected.length ||
      entries.some((entry, index) => entry !== entriesExpected[index])
    ) {
      return { state: 'unknown' };
    }
    const owner = readOperationOwner(path.join(lockDir, 'owner'));
    if (!owner) return { state: 'unknown' };
    const after = lstatIfPresent(lockDir);
    if (
      !after ||
      !isPrivateLockDirectory(after) ||
      !sameFileSnapshot(before, after)
    ) {
      return { state: 'unknown' };
    }
    const entriesAfter = fs.readdirSync(lockDir).sort();
    if (
      entriesAfter.length !== entriesExpected.length ||
      entriesAfter.some((entry, index) => entry !== entriesExpected[index])
    ) {
      return { state: 'unknown' };
    }
    return { state: 'read', stat: after, owner };
  } catch {
    try {
      return lstatIfPresent(lockDir)
        ? { state: 'unknown' }
        : { state: 'vanished' };
    } catch {
      return { state: 'unknown' };
    }
  }
}

function classifyOperationOwner(owner) {
  const uid = ownerUid();
  if (uid === undefined || owner.uid !== uid) return 'unknown';
  if (owner.bootId.split(':')[0] !== owner.startId.split(':')[0]) {
    return 'unknown';
  }
  if (
    owner.startId.startsWith('darwin:') &&
    Number(owner.startId.split(':')[1]) !== owner.uid
  ) {
    return 'unknown';
  }
  let bootId;
  try {
    bootId = currentBootId();
  } catch {
    return 'unknown';
  }
  if (owner.bootId !== bootId) return 'stale';
  const processState = processStartState(owner.pid);
  if (processState.state === 'absent') return 'stale';
  if (processState.state !== 'present') return 'unknown';
  return processState.startId === owner.startId ? 'active' : 'stale';
}

function unknownOperationLock(lockDir) {
  return new Error(
    `${OPERATION_LOCK_BUSY}, or its lock is in an unknown state; inspect ${lockDir}`,
  );
}

function removeExactEmptyDirectory(dir, expected) {
  try {
    const current = lstatIfPresent(dir);
    if (
      !current ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameInode(current, expected) ||
      fs.readdirSync(dir).length !== 0
    ) {
      return false;
    }
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

function removeExactFile(file, expected) {
  try {
    const current = lstatIfPresent(file);
    if (
      !current ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameFileSnapshot(current, expected)
    ) {
      return false;
    }
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function initializeCreatedOperationLock(
  paths,
  lockDir,
  lockStat,
  metadata,
) {
  const ownerFile = path.join(lockDir, 'owner');
  const tmpFile = path.join(lockDir, `.owner-${metadata.record.token}.tmp`);
  let fd;
  let ownedFileStat;
  let ownedFilePath = tmpFile;
  try {
    if (!isOwnedRealDirectory(lockStat)) {
      throw new Error('Could not acquire a safe Skoobi operation lock');
    }
    fs.chmodSync(lockDir, 0o700);
    const securedLockStat = fs.lstatSync(lockDir);
    if (
      !isPrivateLockDirectory(securedLockStat) ||
      !sameInode(lockStat, securedLockStat)
    ) {
      throw new Error('Could not acquire a safe Skoobi operation lock');
    }
    fd = fs.openSync(
      tmpFile,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(fd, 0o600);
    ownedFileStat = fs.fstatSync(fd);
    if (
      !ownedFileStat.isFile() ||
      ownedFileStat.nlink !== 1 ||
      (ownedFileStat.mode & 0o777) !== 0o600
    ) {
      throw new Error('Could not create safe operation lock metadata');
    }
    assertOwner(ownedFileStat, 'Skoobi operation lock owner');
    fs.writeFileSync(fd, metadata.content);
    fs.fsyncSync(fd);
    const writtenStat = fs.fstatSync(fd);
    if (
      writtenStat.size !== metadata.content.length ||
      !sameInode(ownedFileStat, writtenStat)
    ) {
      throw new Error('Could not write safe operation lock metadata');
    }
    ownedFileStat = writtenStat;
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpFile, ownerFile);
    ownedFilePath = ownerFile;
    const renamedStat = fs.lstatSync(ownerFile);
    if (!sameInode(renamedStat, ownedFileStat)) {
      throw new Error('Operation lock metadata changed during rename');
    }
    ownedFileStat = renamedStat;
    fsyncDirectory(lockDir);

    const snapshot = operationLockSnapshot(lockDir, ['owner']);
    if (
      snapshot.state !== 'read' ||
      !sameInode(snapshot.stat, lockStat) ||
      !snapshot.owner.content.equals(metadata.content) ||
      snapshot.owner.record.token !== metadata.record.token ||
      snapshot.owner.record.pid !== process.pid ||
      !sameFileSnapshot(snapshot.owner.stat, ownedFileStat)
    ) {
      throw new Error('Could not verify Skoobi operation lock metadata');
    }
    fsyncDirectory(paths.prefix);
    return {
      lockDir,
      stat: snapshot.stat,
      ownerStat: snapshot.owner.stat,
      ownerContent: metadata.content,
      token: metadata.record.token,
      pid: process.pid,
    };
  } catch (err) {
    if (fd !== undefined) fs.closeSync(fd);
    let cleaned = true;
    try {
      if (ownedFileStat && lstatIfPresent(ownedFilePath)) {
        cleaned = removeExactFile(ownedFilePath, ownedFileStat) && cleaned;
      }
      cleaned = removeExactEmptyDirectory(lockDir, lockStat) && cleaned;
    } catch {
      cleaned = false;
    }
    if (!cleaned) {
      throw new Error(
        `Could not initialize the operation lock safely; inspect ${lockDir}`,
        { cause: err },
      );
    }
    throw err;
  }
}

function reclaimOperationLock(paths, lockDir, initial) {
  const reclaimDir = path.join(lockDir, 'reclaim');
  let reclaimStat;
  let ownerDeleted = false;
  try {
    try {
      fs.mkdirSync(reclaimDir, { mode: 0o700 });
    } catch (err) {
      if (err?.code === 'ENOENT') return true;
      throw unknownOperationLock(lockDir);
    }
    const createdReclaim = fs.lstatSync(reclaimDir);
    if (!isOwnedRealDirectory(createdReclaim)) {
      throw unknownOperationLock(lockDir);
    }
    fs.chmodSync(reclaimDir, 0o700);
    reclaimStat = fs.lstatSync(reclaimDir);
    if (
      !isPrivateLockDirectory(reclaimStat) ||
      !sameInode(createdReclaim, reclaimStat)
    ) {
      throw unknownOperationLock(lockDir);
    }

    const current = operationLockSnapshot(lockDir, ['owner', 'reclaim']);
    if (current.state === 'vanished') return true;
    if (
      current.state !== 'read' ||
      !sameInode(current.stat, initial.stat) ||
      !sameFileSnapshot(current.owner.stat, initial.owner.stat) ||
      !current.owner.content.equals(initial.owner.content)
    ) {
      throw unknownOperationLock(lockDir);
    }
    const currentReclaim = lstatIfPresent(reclaimDir);
    if (
      !currentReclaim ||
      !isPrivateLockDirectory(currentReclaim) ||
      !sameInode(currentReclaim, reclaimStat) ||
      fs.readdirSync(reclaimDir).length !== 0
    ) {
      throw unknownOperationLock(lockDir);
    }
    const classification = classifyOperationOwner(current.owner.record);
    if (classification === 'active') throw new Error(OPERATION_LOCK_BUSY);
    if (classification !== 'stale') throw unknownOperationLock(lockDir);

    const finalOwner = readOperationOwner(path.join(lockDir, 'owner'));
    const finalDir = lstatIfPresent(lockDir);
    if (
      !finalOwner ||
      !finalDir ||
      !sameInode(finalDir, initial.stat) ||
      !sameFileSnapshot(finalOwner.stat, current.owner.stat) ||
      !finalOwner.content.equals(current.owner.content) ||
      classifyOperationOwner(finalOwner.record) !== 'stale'
    ) {
      throw unknownOperationLock(lockDir);
    }
    if (!removeExactFile(path.join(lockDir, 'owner'), finalOwner.stat)) {
      throw unknownOperationLock(lockDir);
    }
    ownerDeleted = true;
    if (!removeExactEmptyDirectory(reclaimDir, reclaimStat)) {
      throw unknownOperationLock(lockDir);
    }
    const emptyLock = lstatIfPresent(lockDir);
    if (
      !emptyLock ||
      !sameInode(emptyLock, initial.stat) ||
      !removeExactEmptyDirectory(lockDir, initial.stat)
    ) {
      throw unknownOperationLock(lockDir);
    }
    fsyncDirectory(paths.prefix);
    return true;
  } finally {
    if (!ownerDeleted && reclaimStat) {
      removeExactEmptyDirectory(reclaimDir, reclaimStat);
    }
  }
}

function acquireOperationLock(paths) {
  const lockDir = path.join(paths.prefix, '.skoobi-operation.lock');
  const metadata = operationOwnerContent('owner-init');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let createdStat;
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      createdStat = fs.lstatSync(lockDir);
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    if (createdStat) {
      return initializeCreatedOperationLock(
        paths,
        lockDir,
        createdStat,
        metadata,
      );
    }

    const snapshot = operationLockSnapshot(lockDir, ['owner']);
    if (snapshot.state === 'vanished') continue;
    if (snapshot.state !== 'read') throw unknownOperationLock(lockDir);
    const classification = classifyOperationOwner(snapshot.owner.record);
    if (classification === 'active') throw new Error(OPERATION_LOCK_BUSY);
    if (classification !== 'stale') throw unknownOperationLock(lockDir);
    reclaimOperationLock(paths, lockDir, snapshot);
  }
  throw unknownOperationLock(lockDir);
}

function releaseOperationLock(lock) {
  const snapshot = operationLockSnapshot(lock.lockDir, ['owner']);
  if (
    snapshot.state !== 'read' ||
    !sameInode(snapshot.stat, lock.stat) ||
    !sameFileSnapshot(snapshot.owner.stat, lock.ownerStat) ||
    !snapshot.owner.content.equals(lock.ownerContent) ||
    snapshot.owner.record.token !== lock.token ||
    snapshot.owner.record.pid !== lock.pid ||
    lock.pid !== process.pid
  ) {
    throw new Error('Skoobi operation lock changed unexpectedly');
  }
  const finalOwner = readOperationOwner(path.join(lock.lockDir, 'owner'));
  const finalDir = lstatIfPresent(lock.lockDir);
  if (
    !finalOwner ||
    !finalDir ||
    !sameInode(finalDir, lock.stat) ||
    !sameFileSnapshot(finalOwner.stat, lock.ownerStat) ||
    !finalOwner.content.equals(lock.ownerContent) ||
    finalOwner.record.token !== lock.token ||
    finalOwner.record.pid !== lock.pid
  ) {
    throw new Error('Skoobi operation lock changed unexpectedly');
  }
  if (!removeExactFile(path.join(lock.lockDir, 'owner'), lock.ownerStat)) {
    throw new Error('Skoobi operation lock changed unexpectedly');
  }
  if (!removeExactEmptyDirectory(lock.lockDir, lock.stat)) {
    throw new Error('Skoobi operation lock changed unexpectedly');
  }
  fsyncDirectory(path.dirname(lock.lockDir));
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
    const telegramToken = envValue(env.content, 'TELEGRAM_BOT_TOKEN');
    if (!telegramToken) {
      throw new Error(
        'Telegram bot token is not configured; rerun the installer with --reconfigure',
      );
    }
    if (!TELEGRAM_BOT_TOKEN.test(telegramToken)) {
      throw new Error(
        'Telegram bot token format is invalid; rerun the installer with --reconfigure',
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
  const tokenConfigured = TELEGRAM_BOT_TOKEN.test(
    envValue(env.content, 'TELEGRAM_BOT_TOKEN'),
  );
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
