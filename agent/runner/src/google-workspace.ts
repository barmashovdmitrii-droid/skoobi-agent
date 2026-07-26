import { createDecipheriv, hkdfSync, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

/** Public Google tools that the sandbox may ask the trusted host to execute. */
export const GOOGLE_HOST_TOOL_NAMES = [
  'google_workspace_status',
  'google_drive_list_files',
  'google_sheets_create',
  'google_docs_create',
  'google_docs_read',
  'google_docs_replace_content',
  'google_sheets_get_values',
  'google_sheets_append_values',
  'google_sheets_update_values',
  'google_apps_script_get_content',
  'google_apps_script_update_file',
  'google_calendar_list_events',
  'gmail_search_threads',
  'gmail_get_thread',
] as const;

export type GoogleHostToolName = (typeof GOOGLE_HOST_TOOL_NAMES)[number];

export interface GoogleApiRequestEnvelope {
  readonly type: 'google_api';
  readonly request_id: string;
  readonly tool: GoogleHostToolName;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface AuthorizedGoogleHostOperation {
  readonly grant: string;
  /** Canonical base64url encoding of 32 response-sealing key bytes. */
  readonly responseKey: string;
}

export type AuthorizeHostGoogleOperation = (
  envelope: Readonly<GoogleApiRequestEnvelope>,
) =>
  | AuthorizedGoogleHostOperation
  | null
  | undefined
  | Promise<AuthorizedGoogleHostOperation | null | undefined>;

export interface RequestHostGoogleOperationOptions {
  /** Trusted IPC root shared with the host. Requests use its `google` child. */
  readonly ipcDir: string;
  readonly tool: GoogleHostToolName;
  readonly args: Readonly<Record<string, unknown>>;
  /** Mints an exact one-use grant and an in-memory-only response sealing key. */
  readonly authorize: AuthorizeHostGoogleOperation;
  readonly timeoutMs?: number;
}

const GOOGLE_TOOL_NAME_SET = new Set<string>(GOOGLE_HOST_TOOL_NAMES);
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ONE_USE_GRANT_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_PLAINTEXT_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_SEALED_RESULT_BYTES = 6 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 100_000;
// A single broker operation can make several bounded provider requests in
// sequence (for example, read/verify/write).  Keep the runner wait longer than
// the host's worst-case request chain so a successful mutation is not reported
// as a timeout and then retried by the model.
const DEFAULT_TIMEOUT_MS = 150_000;
const MAX_TIMEOUT_MS = 180_000;
const RESULT_POLL_MS = 20;
const GOOGLE_RESULT_TYPE = 'google_api_result';
const GOOGLE_SEALED_RESULT_TYPE = 'google_api_sealed_result';
const GOOGLE_SEALED_RESULT_VERSION = 1;
const GOOGLE_SEALED_RESULT_DOMAIN = 'skoobi.google_api.sealed_result.v1';
const RESPONSE_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

interface DirectoryIdentity {
  readonly rootPath: string;
  readonly rootDev: number;
  readonly rootIno: number;
  readonly googlePath: string;
  readonly googleDev: number;
  readonly googleIno: number;
}

type JsonClone =
  | null
  | boolean
  | number
  | string
  | JsonClone[]
  | { [key: string]: JsonClone };

export function isGoogleHostToolName(
  value: unknown,
): value is GoogleHostToolName {
  return typeof value === 'string' && GOOGLE_TOOL_NAME_SET.has(value);
}

function decodeCanonicalBase64Url(
  value: unknown,
  description: string,
  options: { readonly exactBytes?: number; readonly maxBytes?: number },
): Buffer {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    throw new Error(`${description} is not canonical base64url.`);
  }
  const maxBytes = options.exactBytes ?? options.maxBytes;
  if (maxBytes !== undefined && value.length > Math.ceil((maxBytes * 4) / 3)) {
    throw new Error(`${description} exceeds the safe size limit.`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    decoded.fill(0);
    throw new Error(`${description} is not canonical base64url.`);
  }
  if (
    (options.exactBytes !== undefined &&
      decoded.length !== options.exactBytes) ||
    (options.maxBytes !== undefined && decoded.length > options.maxBytes)
  ) {
    decoded.fill(0);
    throw new Error(`${description} has an invalid length.`);
  }
  return decoded;
}

function deriveGoogleResultKey(responseKey: Buffer, requestId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      responseKey,
      Buffer.from(GOOGLE_SEALED_RESULT_DOMAIN, 'utf8'),
      Buffer.from(requestId, 'utf8'),
      32,
    ),
  );
}

function googleResultAad(requestId: string): Buffer {
  return Buffer.from(`${GOOGLE_SEALED_RESULT_DOMAIN}\0${requestId}`, 'utf8');
}

function operationTimeoutError(): Error {
  return new Error('Timed out waiting for the Google host operation.');
}

function assertTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `Google host operation timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} ms.`,
    );
  }
  return timeoutMs;
}

function assertBeforeDeadline(deadline: number): void {
  if (performance.now() >= deadline) {
    throw operationTimeoutError();
  }
}

async function awaitBeforeDeadline<T>(
  value: Promise<T>,
  deadline: number,
): Promise<T> {
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) throw operationTimeoutError();

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(operationTimeoutError()), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForNextPoll(deadline: number): Promise<void> {
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) throw operationTimeoutError();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.min(RESULT_POLL_MS, remainingMs));
  });
  assertBeforeDeadline(deadline);
}

function isOrdinaryObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(
  value: unknown,
  depth: number,
  state: { nodes: number; readonly ancestors: Set<object> },
): JsonClone {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) {
    throw new Error('Google host operation arguments are too complex.');
  }
  if (depth > MAX_JSON_DEPTH) {
    throw new Error('Google host operation arguments are nested too deeply.');
  }

  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        'Google host operation arguments must contain finite numbers.',
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new Error('Google host operation arguments must be JSON values.');
  }
  if (state.ancestors.has(value)) {
    throw new Error('Google host operation arguments must not contain cycles.');
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_JSON_NODES) {
        throw new Error('Google host operation arguments are too complex.');
      }
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' ||
              !/^(0|[1-9][0-9]*)$/.test(key) ||
              Number(key) >= value.length),
        )
      ) {
        throw new Error(
          'Google host operation arrays must not have extra properties.',
        );
      }
      const clone: JsonClone[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error(
            'Google host operation arrays must be dense data arrays.',
          );
        }
        clone.push(cloneJsonValue(descriptor.value, depth + 1, state));
      }
      return Object.freeze(clone) as JsonClone;
    }

    if (!isOrdinaryObject(value)) {
      throw new Error(
        'Google host operation arguments must use plain objects.',
      );
    }

    const clone: { [key: string]: JsonClone } = Object.create(null) as {
      [key: string]: JsonClone;
    };
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new Error(
          'Google host operation arguments must not use symbol keys.',
        );
      }
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(
          `Google host operation argument key "${key}" is not allowed.`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new Error(
          'Google host operation arguments must use enumerable data properties.',
        );
      }
      clone[key] = cloneJsonValue(descriptor.value, depth + 1, state);
    }
    return Object.freeze(clone) as JsonClone;
  } finally {
    state.ancestors.delete(value);
  }
}

function cloneAndFreezeArgs(
  args: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('Google host operation args must be a plain object.');
  }
  const clone = cloneJsonValue(args, 0, {
    nodes: 0,
    ancestors: new Set<object>(),
  });
  if (Array.isArray(clone) || clone === null || typeof clone !== 'object') {
    throw new Error('Google host operation args must be a plain object.');
  }
  return clone as Readonly<Record<string, unknown>>;
}

function assertDirectoryStat(
  stat: fs.Stats,
  description: string,
): asserts stat is fs.Stats {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${description} must be a real directory, not a symlink.`);
  }
}

function prepareGoogleDirectory(ipcDir: string): DirectoryIdentity {
  if (typeof ipcDir !== 'string' || ipcDir.length === 0) {
    throw new Error('A Google IPC directory is required.');
  }

  const requestedRoot = path.resolve(ipcDir);
  const requestedRootStat = fs.lstatSync(requestedRoot);
  assertDirectoryStat(requestedRootStat, 'Google IPC root');

  const rootPath = fs.realpathSync(requestedRoot);
  const rootStat = fs.lstatSync(rootPath);
  assertDirectoryStat(rootStat, 'Google IPC root');
  if (
    rootStat.dev !== requestedRootStat.dev ||
    rootStat.ino !== requestedRootStat.ino
  ) {
    throw new Error('Google IPC root changed while it was being resolved.');
  }

  const googlePath = path.join(rootPath, 'google');
  try {
    fs.mkdirSync(googlePath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const googleStat = fs.lstatSync(googlePath);
  assertDirectoryStat(googleStat, 'Google IPC request directory');
  if (fs.realpathSync(googlePath) !== googlePath) {
    throw new Error(
      'Google IPC request directory must not traverse a symlink.',
    );
  }

  return {
    rootPath,
    rootDev: rootStat.dev,
    rootIno: rootStat.ino,
    googlePath,
    googleDev: googleStat.dev,
    googleIno: googleStat.ino,
  };
}

function directoryStillMatches(directory: DirectoryIdentity): boolean {
  try {
    const rootStat = fs.lstatSync(directory.rootPath);
    const googleStat = fs.lstatSync(directory.googlePath);
    return (
      rootStat.isDirectory() &&
      !rootStat.isSymbolicLink() &&
      rootStat.dev === directory.rootDev &&
      rootStat.ino === directory.rootIno &&
      googleStat.isDirectory() &&
      !googleStat.isSymbolicLink() &&
      googleStat.dev === directory.googleDev &&
      googleStat.ino === directory.googleIno &&
      fs.realpathSync(directory.googlePath) === directory.googlePath
    );
  } catch {
    return false;
  }
}

function assertDirectoryStillMatches(directory: DirectoryIdentity): void {
  if (!directoryStillMatches(directory)) {
    throw new Error(
      'Google IPC request directory changed during the operation.',
    );
  }
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(
      fd,
      data,
      offset,
      data.length - offset,
      offset,
    );
    if (written <= 0) {
      throw new Error('Could not write the Google host request completely.');
    }
    offset += written;
  }
}

/**
 * Publishes a complete request with the repository's standard safe pattern:
 * create an unpredictable temp O_EXCL + O_NOFOLLOW, then atomically rename
 * that directory entry over the public leaf without following its target.
 */
function writeRequestAtomically(
  directory: DirectoryIdentity,
  requestPath: string,
  data: Buffer,
): void {
  const tempPath = path.join(
    directory.googlePath,
    `.${path.basename(requestPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  let openedStat: fs.Stats | undefined;

  try {
    assertDirectoryStillMatches(directory);
    fd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    openedStat = fs.fstatSync(fd);
    if (!openedStat.isFile() || openedStat.nlink !== 1) {
      throw new Error('Google host request temporary file is not safe.');
    }
    writeAll(fd, data);
    fs.fsyncSync(fd);
    const completedStat = fs.fstatSync(fd);
    if (
      !completedStat.isFile() ||
      completedStat.dev !== openedStat.dev ||
      completedStat.ino !== openedStat.ino ||
      completedStat.size !== data.length
    ) {
      throw new Error(
        'Google host request temporary file changed while writing.',
      );
    }
    fs.closeSync(fd);
    fd = undefined;

    assertDirectoryStillMatches(directory);
    const tempStat = fs.lstatSync(tempPath);
    if (
      tempStat.isSymbolicLink() ||
      !tempStat.isFile() ||
      tempStat.dev !== openedStat.dev ||
      tempStat.ino !== openedStat.ino ||
      tempStat.size !== data.length ||
      tempStat.nlink !== 1
    ) {
      throw new Error('Google host request temporary file was replaced.');
    }

    fs.renameSync(tempPath, requestPath);

    let requestStat: fs.Stats;
    try {
      requestStat = fs.lstatSync(requestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // The host may consume the one-shot request immediately after rename.
        assertDirectoryStillMatches(directory);
        return;
      }
      throw error;
    }
    if (
      requestStat.isSymbolicLink() ||
      !requestStat.isFile() ||
      requestStat.dev !== openedStat.dev ||
      requestStat.ino !== openedStat.ino ||
      requestStat.size !== data.length ||
      requestStat.nlink !== 1
    ) {
      throw new Error(
        'Published Google host request is not a safe regular file.',
      );
    }
    assertDirectoryStillMatches(directory);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort descriptor cleanup after a primary failure.
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Preserve the primary error; the unpredictable temp name is never used
        // again and the outer cleanup still removes the public request/result.
      }
    }
  }
}

function readBoundedResultNoFollow(
  directory: DirectoryIdentity,
  resultPath: string,
): Buffer | null {
  assertDirectoryStillMatches(directory);
  let fd: number;
  try {
    fd = fs.openSync(
      resultPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Google host result is not a safe regular file.');
  }

  try {
    assertDirectoryStillMatches(directory);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) {
      throw new Error('Google host result is not a safe regular file.');
    }
    if (before.size <= 0) {
      throw new Error('Google host result is empty.');
    }
    if (before.size > MAX_SEALED_RESULT_BYTES) {
      throw new Error('Sealed Google host result exceeds the safe size limit.');
    }

    const data = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < data.length) {
      const bytesRead = fs.readSync(
        fd,
        data,
        offset,
        data.length - offset,
        offset,
      );
      if (bytesRead <= 0) {
        throw new Error('Google host result changed while it was being read.');
      }
      offset += bytesRead;
    }

    const growthProbe = Buffer.allocUnsafe(1);
    if (fs.readSync(fd, growthProbe, 0, 1, data.length) !== 0) {
      throw new Error('Google host result grew while it was being read.');
    }
    const after = fs.fstatSync(fd);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error('Google host result changed while it was being read.');
    }
    return data;
  } finally {
    fs.closeSync(fd);
  }
}

function decryptSealedGoogleResult(
  data: Buffer,
  requestId: string,
  responseKey: Buffer,
): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8')) as unknown;
  } catch {
    throw new Error('Sealed Google host result is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Google host result is not a sealed envelope.');
  }

  const sealed = parsed as Record<string, unknown>;
  const expectedKeys = [
    'type',
    'request_id',
    'v',
    'nonce',
    'ciphertext',
    'tag',
  ];
  const actualKeys = Object.keys(sealed);
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some(
      (key) => !Object.prototype.hasOwnProperty.call(sealed, key),
    )
  ) {
    throw new Error('Google host result has an invalid sealed envelope.');
  }
  if (sealed.type !== GOOGLE_SEALED_RESULT_TYPE) {
    throw new Error('Google host result is not a sealed envelope.');
  }
  if (sealed.request_id !== requestId) {
    throw new Error(
      'Sealed Google host result request_id does not match the request.',
    );
  }
  if (sealed.v !== GOOGLE_SEALED_RESULT_VERSION) {
    throw new Error('Google host result has an unsupported seal version.');
  }

  const nonce = decodeCanonicalBase64Url(
    sealed.nonce,
    'Google host result nonce',
    { exactBytes: GCM_NONCE_BYTES },
  );
  const ciphertext = decodeCanonicalBase64Url(
    sealed.ciphertext,
    'Google host result ciphertext',
    { maxBytes: MAX_PLAINTEXT_RESULT_BYTES },
  );
  const tag = decodeCanonicalBase64Url(sealed.tag, 'Google host result tag', {
    exactBytes: GCM_TAG_BYTES,
  });
  const encryptionKey = deriveGoogleResultKey(responseKey, requestId);
  let updatedPlaintext: Buffer | undefined;
  let finalPlaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(googleResultAad(requestId));
    decipher.setAuthTag(tag);
    updatedPlaintext = decipher.update(ciphertext);
    finalPlaintext = decipher.final();
    const plaintext = Buffer.concat([updatedPlaintext, finalPlaintext]);
    if (plaintext.length > MAX_PLAINTEXT_RESULT_BYTES) {
      plaintext.fill(0);
      throw new Error(
        'Decrypted Google host result exceeds the safe size limit.',
      );
    }
    return plaintext;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        'Decrypted Google host result exceeds the safe size limit.'
    ) {
      throw error;
    }
    throw new Error('Could not authenticate the sealed Google host result.');
  } finally {
    updatedPlaintext?.fill(0);
    finalPlaintext?.fill(0);
    encryptionKey.fill(0);
  }
}

function parseGoogleResult(
  data: Buffer,
  requestId: string,
):
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8')) as unknown;
  } catch {
    throw new Error('Google host result is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Google host result has an invalid envelope.');
  }
  const result = parsed as Record<string, unknown>;
  if (result.type !== GOOGLE_RESULT_TYPE) {
    throw new Error('Google host result type does not match the request.');
  }
  if (result.request_id !== requestId) {
    throw new Error(
      'Google host result request_id does not match the request.',
    );
  }
  if (typeof result.ok !== 'boolean') {
    throw new Error('Google host result has an invalid status.');
  }
  if (result.ok) {
    return { ok: true, result: result.result };
  }
  if (result.error !== undefined && typeof result.error !== 'string') {
    throw new Error('Google host result has an invalid error.');
  }
  const error = (result.error || 'The host rejected the Google operation.')
    .slice(0, 4_096)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return { ok: false, error };
}

function cleanupOperationFiles(
  directory: DirectoryIdentity,
  paths: readonly string[],
): void {
  if (!directoryStillMatches(directory)) return;
  for (const filePath of paths) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Cleanup must not replace the operation's primary result/error.
      }
    }
  }
}

/**
 * Ask the trusted host to execute one public Google operation.
 *
 * The authorization callback receives only the exact, immutable request
 * envelope and returns an envelope-bound one-use grant plus a response key.
 * No long-lived host capability or response key is accepted as a disk field
 * or serialized into the IPC directory.
 */
export async function requestHostGoogleOperation<T = unknown>(
  options: RequestHostGoogleOperationOptions,
): Promise<T> {
  const timeoutMs = assertTimeoutMs(options.timeoutMs);
  const deadline = performance.now() + timeoutMs;
  if (!isGoogleHostToolName(options.tool)) {
    throw new Error('Unsupported public Google host tool.');
  }
  if (typeof options.authorize !== 'function') {
    throw new Error('A Google host operation authorizer is required.');
  }

  const args = cloneAndFreezeArgs(options.args);
  const requestId = randomUUID();
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Could not create a safe Google host request id.');
  }
  const envelope = Object.freeze({
    type: 'google_api' as const,
    request_id: requestId,
    tool: options.tool,
    args,
  });
  const serializedEnvelope = JSON.stringify(envelope);
  const envelopeBytes = Buffer.byteLength(serializedEnvelope, 'utf8');
  if (envelopeBytes > MAX_REQUEST_BYTES) {
    throw new Error(
      'Google host operation request exceeds the safe size limit.',
    );
  }

  const directory = prepareGoogleDirectory(options.ipcDir);
  const requestPath = path.join(
    directory.googlePath,
    `${requestId}.request.json`,
  );
  const resultPath = path.join(
    directory.googlePath,
    `${requestId}.result.json`,
  );
  let responseKeyBytes: Buffer | undefined;

  try {
    assertBeforeDeadline(deadline);
    const authorization = Promise.resolve().then(() =>
      options.authorize(envelope),
    );
    const authorized = await awaitBeforeDeadline(authorization, deadline);
    assertBeforeDeadline(deadline);
    if (authorized === null || authorized === undefined) {
      throw new Error('Google host operation was not authorized.');
    }
    if (
      typeof authorized !== 'object' ||
      Array.isArray(authorized) ||
      (Object.getPrototypeOf(authorized) !== Object.prototype &&
        Object.getPrototypeOf(authorized) !== null)
    ) {
      throw new Error(
        'Google host operation authorizer returned an invalid response.',
      );
    }
    const authorizationKeys = Reflect.ownKeys(authorized);
    const grantDescriptor = Object.getOwnPropertyDescriptor(
      authorized,
      'grant',
    );
    const responseKeyDescriptor = Object.getOwnPropertyDescriptor(
      authorized,
      'responseKey',
    );
    if (
      authorizationKeys.length !== 2 ||
      !grantDescriptor?.enumerable ||
      !('value' in grantDescriptor) ||
      !responseKeyDescriptor?.enumerable ||
      !('value' in responseKeyDescriptor)
    ) {
      throw new Error(
        'Google host operation authorizer returned an invalid response.',
      );
    }
    const grant = grantDescriptor.value;
    const responseKey = responseKeyDescriptor.value;
    if (typeof grant !== 'string' || !ONE_USE_GRANT_PATTERN.test(grant)) {
      throw new Error(
        'Google host operation authorizer returned an invalid grant.',
      );
    }
    responseKeyBytes = decodeCanonicalBase64Url(
      responseKey,
      'Google host operation response key',
      { exactBytes: RESPONSE_KEY_BYTES },
    );

    const requestData = Buffer.from(
      `${serializedEnvelope.slice(0, -1)},"ownerAuthorizationGrant":${JSON.stringify(grant)}}`,
      'utf8',
    );
    if (requestData.length > MAX_REQUEST_BYTES) {
      throw new Error(
        'Google host operation request exceeds the safe size limit.',
      );
    }
    writeRequestAtomically(directory, requestPath, requestData);

    for (;;) {
      assertBeforeDeadline(deadline);
      const resultData = readBoundedResultNoFollow(directory, resultPath);
      if (resultData !== null) {
        const plaintext = decryptSealedGoogleResult(
          resultData,
          requestId,
          responseKeyBytes,
        );
        try {
          const result = parseGoogleResult(plaintext, requestId);
          if (!result.ok) {
            throw new Error(`Google host operation failed: ${result.error}`);
          }
          return result.result as T;
        } finally {
          plaintext.fill(0);
        }
      }
      await waitForNextPoll(deadline);
    }
  } finally {
    responseKeyBytes?.fill(0);
    cleanupOperationFiles(directory, [requestPath, resultPath]);
  }
}
