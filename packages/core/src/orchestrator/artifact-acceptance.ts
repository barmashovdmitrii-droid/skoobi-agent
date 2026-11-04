import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';
import {
  checkCalculationDocuments,
  validateCalculationCriteria,
  type CalculationCriteria,
} from './document-reconciliation.js';
import { trustedDocumentRuntime } from './document-trust.js';
import {
  ARTIFACT_JOB_POLICY,
  consumeArtifactJobAttestation,
  type ArtifactJobAttestation,
} from './artifact-job.js';

export const ARTIFACT_VALIDATOR = 'browser-archive-route';
export const ARTIFACT_VALIDATOR_VERSION = 1;
// Updated together with the reviewed checker. Never derive this from agent input.
export const ARTIFACT_CHECKER_SHA256 =
  '2d33ddf3b2df341766f68383c5c01e02cc2721aa4d147af36f82f0e7ddd433b7';
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 8192;
const MAX_RECEIPT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ID = /^[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
const SELECTOR = /^(?:[a-zA-Z][\w-]*|[.#][a-zA-Z_][\w-]*)$/;
const activeChecks = new Set<string>();

export interface ArtifactExpectation {
  selector: string;
  text: string;
}
export interface BrowserArtifactAcceptanceRequirements {
  schema: 1;
  kind: 'browser-archive';
  entrypoint: string;
  initial: ArtifactExpectation;
  steps: Array<{
    action: 'click' | 'press';
    selector: string;
    key?:
      | 'Enter'
      | 'Space'
      | 'ArrowLeft'
      | 'ArrowRight'
      | 'ArrowUp'
      | 'ArrowDown';
    expect: ArtifactExpectation;
    path?: string;
  }>;
  /** Trusted caller must refresh these digests when its source inputs change. */
  inputSha256?: string[];
}
export interface CalculationArtifactAcceptanceRequirements {
  schema: 1;
  kind: 'calculation-v1';
  criteria: CalculationCriteria;
  sources: Array<{ path: string; sha256: string }>;
}
export type ArtifactAcceptanceRequirements =
  | BrowserArtifactAcceptanceRequirements
  | CalculationArtifactAcceptanceRequirements;
export interface ArtifactAcceptanceHost {
  /** Must be outside every writable agent root; never passed to the checker. */
  stateDir: string;
  agentWritableRoots: string[];
  checkerPath: string;
  /** Legacy deployment metadata only. Never grants producer attestation or signing. */
  boundary: 'workspace-isolated' | 'owner-full-access';
  pythonCommand?: string;
  /** Optional trusted deployment path; absent means resolve installed Playwright. */
  playwrightModule?: string;
  browserExecutable?: string;
  documentScriptsDirectory?: string;
  sofficeCommand?: string;
}
export type ArtifactCheckStatus = 'passed' | 'failed' | 'inconclusive';
interface CheckerResult {
  status: ArtifactCheckStatus;
  code: string;
  checks: Array<{ id: string; outcome: 'passed' }>;
}
export interface ArtifactAcceptanceReceipt {
  payload: {
    schema: 1;
    id: string;
    issuedAt: string;
    artifact: { sha256: string; size: number };
    requirementsSha256: string;
    validator: { id: string; version: number; checkerSha256: string };
    assurance: 'workspace-isolated';
    result: CheckerResult;
    delivery: 'not_recorded';
    humanAcceptance: 'not_recorded';
    trace?: { sha256: string; size: number };
    sources?: Array<{ path: string; sha256: string; size: number }>;
    visualReview?: 'not_recorded';
    renderAssessment?: 'openability_and_text_smoke_only';
    producerIsolation: ArtifactJobAttestation;
    browserRuntimeSha256?: string;
  };
  signature: string;
}
export interface ArtifactAcceptanceRun {
  status: ArtifactCheckStatus;
  code: string;
  receipt?: ArtifactAcceptanceReceipt;
}
export interface ArtifactAcceptanceVerification {
  status: ArtifactCheckStatus | 'stale' | 'untrusted';
  code: string;
  /** No receipt in this mechanism records a delivery or human approval. */
  humanAcceptance: 'not_recorded';
}

const digest = (bytes: Buffer | string): string =>
  crypto.createHash('sha256').update(bytes).digest('hex');

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function relativeFile(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 200 &&
    /^[a-zA-Z0-9_./-]+$/.test(value) &&
    value
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
function expectation(value: unknown): value is ArtifactExpectation {
  return (
    record(value) &&
    keys(value, ['selector', 'text']) &&
    typeof value.selector === 'string' &&
    SELECTOR.test(value.selector) &&
    value.selector.length <= 100 &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    value.text.length <= 500 &&
    value.text === value.text.replace(/\s+/g, ' ').trim()
  );
}
export function validateArtifactAcceptanceRequirements(
  value: unknown,
): value is ArtifactAcceptanceRequirements {
  if (record(value) && value.kind === 'calculation-v1') {
    try {
      validateCalculationCriteria(value.criteria);
      return (
        keys(value, ['schema', 'kind', 'criteria', 'sources']) &&
        value.schema === 1 &&
        Array.isArray(value.sources) &&
        value.sources.length >= 1 &&
        value.sources.length <= 8 &&
        value.sources.every(
          (source) =>
            record(source) &&
            keys(source, ['path', 'sha256']) &&
            typeof source.path === 'string' &&
            source.path.length <= 500 &&
            path.isAbsolute(source.path) &&
            !/[\u0000-\u001f]/.test(source.path) &&
            ['.pdf', '.xlsx'].includes(
              path.extname(source.path).toLowerCase(),
            ) &&
            typeof source.sha256 === 'string' &&
            HASH.test(source.sha256),
        ) &&
        new Set(
          value.sources.map((source) => (source as { path: string }).path),
        ).size === value.sources.length
      );
    } catch {
      return false;
    }
  }
  if (
    !record(value) ||
    !keys(value, [
      'schema',
      'kind',
      'entrypoint',
      'initial',
      'steps',
      'inputSha256',
    ]) ||
    value.schema !== 1 ||
    value.kind !== 'browser-archive' ||
    !relativeFile(value.entrypoint) ||
    !expectation(value.initial) ||
    !Array.isArray(value.steps) ||
    value.steps.length < 1 ||
    value.steps.length > 4
  )
    return false;
  if (
    value.inputSha256 !== undefined &&
    (!Array.isArray(value.inputSha256) ||
      value.inputSha256.length > 16 ||
      !value.inputSha256.every(
        (hash) => typeof hash === 'string' && HASH.test(hash),
      ))
  )
    return false;
  return value.steps.every(
    (step) =>
      record(step) &&
      keys(step, ['action', 'selector', 'key', 'expect', 'path']) &&
      typeof step.selector === 'string' &&
      step.selector.length <= 100 &&
      SELECTOR.test(step.selector) &&
      expectation(step.expect) &&
      (step.path === undefined || relativeFile(step.path)) &&
      ((step.action === 'click' && step.key === undefined) ||
        (step.action === 'press' &&
          [
            'Enter',
            'Space',
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
          ].includes(String(step.key)))),
  );
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
function trustedPath(filename: string, roots: string[]): string {
  const real = fs.realpathSync(filename);
  if (roots.some((root) => inside(real, root)))
    throw new Error('untrusted_host_path');
  return real;
}
function privateDirectory(directory: string): string {
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('unsafe_host_directory');
  return fs.realpathSync(directory);
}

/** No mkdir, copying or capability inference on service startup. */
export function defaultArtifactAcceptanceHost(
  instanceRoot: string,
): ArtifactAcceptanceHost {
  const root = fs.realpathSync(instanceRoot);
  const stateDir = path.join(
    os.homedir(),
    '.skoobi-host-checks',
    digest(root).slice(0, 16),
  );
  return {
    stateDir,
    agentWritableRoots: [root],
    checkerPath: path.join(stateDir, 'checker.mjs'),
    boundary: 'owner-full-access',
    documentScriptsDirectory: path.join(root, 'scripts'),
  };
}

/** Explicit host administration only; copied checker must match reviewed bytes. */
export function prepareArtifactAcceptanceHost(
  instanceRoot: string,
  sourceCheckerPath: string,
): ArtifactAcceptanceHost {
  const host = defaultArtifactAcceptanceHost(instanceRoot);
  const bytes = readBoundedRegularFileNoFollowSync(sourceCheckerPath, {
    maxBytes: 64 * 1024,
    oversize: 'reject',
    requireSingleLink: true,
  }).buffer;
  if (digest(bytes) !== ARTIFACT_CHECKER_SHA256)
    throw new Error('checker_untrusted');
  const parent = path.dirname(host.stateDir);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
  privateDirectory(parent);
  if (!fs.existsSync(host.stateDir))
    fs.mkdirSync(host.stateDir, { mode: 0o700 });
  privateDirectory(host.stateDir);
  if (
    host.agentWritableRoots.some((root) =>
      inside(fs.realpathSync(host.stateDir), root),
    )
  )
    throw new Error('unsafe_host_directory');
  const temporary = path.join(
    host.stateDir,
    `.checker-${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, host.checkerPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return host;
}
function hostState(
  host: ArtifactAcceptanceHost,
  create: boolean,
  requireKey = true,
): {
  directory: string;
  roots: string[];
  checker: string;
  key: Buffer;
} {
  if (!host.agentWritableRoots.length) throw new Error('isolation_unavailable');
  const roots = host.agentWritableRoots.map((root) => fs.realpathSync(root));
  const parent = fs.realpathSync(path.dirname(host.stateDir));
  const intended = path.join(parent, path.basename(host.stateDir));
  if (roots.some((root) => inside(intended, root) || inside(root, intended)))
    throw new Error('unsafe_host_directory');
  if (create && !fs.existsSync(intended))
    fs.mkdirSync(intended, { mode: 0o700 });
  const directory = privateDirectory(intended);
  trustedPath(directory, roots);
  // Read a pinned snapshot, not the file path again at child launch.
  const checker = readBoundedRegularFileNoFollowSync(host.checkerPath, {
    maxBytes: 64 * 1024,
    oversize: 'reject',
    requireSingleLink: true,
  }).buffer;
  trustedPath(host.checkerPath, roots);
  if (digest(checker) !== ARTIFACT_CHECKER_SHA256)
    throw new Error('checker_untrusted');
  if (!requireKey)
    return {
      directory,
      roots,
      checker: checker.toString('utf8'),
      key: Buffer.alloc(0),
    };
  const keyPath = path.join(directory, 'key.bin');
  if (create && !fs.existsSync(keyPath)) {
    try {
      fs.writeFileSync(keyPath, crypto.randomBytes(32), {
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const keyStat = fs.lstatSync(keyPath);
  if (
    (keyStat.mode & 0o077) !== 0 ||
    (process.getuid && keyStat.uid !== process.getuid())
  )
    throw new Error('unsafe_key');
  const key = readBoundedRegularFileNoFollowSync(keyPath, {
    maxBytes: 32,
    oversize: 'reject',
    requireSingleLink: true,
  }).buffer;
  if (key.length !== 32) throw new Error('unsafe_key');
  return { directory, roots, checker: checker.toString('utf8'), key };
}

/** Host registry support. This never returns the signing key to the caller. */
export function artifactAcceptanceHostDirectory(
  host: ArtifactAcceptanceHost,
  create = false,
): string {
  const state = hostState(host, create, create);
  state.key.fill(0);
  return state.directory;
}

/** Bounded host-only scratch; stale remnants of interrupted checks are removed. */
export function createArtifactAcceptanceScratch(
  directory: string,
  kind: 'work' | 'delivery',
): string {
  privateDirectory(directory);
  let count = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!/^(work|delivery)-[a-zA-Z0-9]+$/.test(name)) continue;
    const filename = path.join(directory, name);
    const stat = fs.lstatSync(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('unsafe_scratch');
    if (Date.now() - stat.mtimeMs > 60 * 60 * 1000)
      fs.rmSync(filename, { recursive: true });
    else count += 1;
  }
  if (count >= 8) throw new Error('scratch_limit');
  const temporary = fs.mkdtempSync(path.join(directory, `${kind}-`));
  fs.chmodSync(temporary, 0o700);
  return temporary;
}
function artifactBytes(filename: string): Buffer {
  return readBoundedRegularFileNoFollowSync(filename, {
    maxBytes: MAX_ARCHIVE_BYTES,
    oversize: 'reject',
    requireSingleLink: true,
  }).buffer;
}
/** Version evidence includes executable bytes and the installed Playwright JS. */
function browserRuntime(
  host: ArtifactAcceptanceHost,
  roots: string[],
): {
  playwrightModule: string;
  browserExecutable: string;
  pythonCommand: string;
  fingerprint: string;
} {
  const pythonCommand = trustedPath(
    host.pythonCommand ?? '/usr/bin/python3',
    roots,
  );
  const playwrightModule = trustedPath(
    host.playwrightModule ??
      createRequire(import.meta.url).resolve('playwright'),
    roots,
  );
  const core = trustedPath(
    createRequire(playwrightModule).resolve('playwright-core'),
    roots,
  );
  const playwright = createRequire(import.meta.url)(playwrightModule) as {
    chromium: { executablePath(): string };
  };
  const browserExecutable = trustedPath(
    host.browserExecutable ?? playwright.chromium.executablePath(),
    roots,
  );
  const files = new Set([
    pythonCommand,
    fs.realpathSync(process.execPath),
    playwrightModule,
    core,
    browserExecutable,
  ]);
  for (const entry of [playwrightModule, core]) {
    const directory = path.dirname(entry);
    if (roots.some((root) => inside(root, directory)))
      throw new Error('untrusted_host_path');
    const visit = (folder: string, depth: number): void => {
      if (depth > 12) throw new Error('runtime_limit');
      for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
        const filename = path.join(folder, item.name);
        if (item.isSymbolicLink()) throw new Error('runtime_symlink');
        if (item.isDirectory()) {
          if (item.name !== 'node_modules') visit(filename, depth + 1);
        } else if (item.isFile() && /\.(?:c?js|mjs|json)$/.test(item.name))
          files.add(trustedPath(filename, roots));
        if (files.size > 2048) throw new Error('runtime_limit');
      }
    };
    visit(directory, 0);
  }
  if (roots.some((root) => inside(root, path.dirname(browserExecutable))))
    throw new Error('untrusted_host_path');
  // macOS Chrome's executable is a small launcher; bind its actual framework too.
  const bundle = browserExecutable.split('.app/Contents/MacOS/')[0];
  if (process.platform === 'darwin' && bundle !== browserExecutable) {
    const frameworks = path.join(bundle + '.app', 'Contents/Frameworks');
    for (const name of fs
      .readdirSync(frameworks)
      .filter((name) => name.endsWith('.framework'))) {
      const framework = path.join(
        frameworks,
        name,
        'Versions/Current',
        name.slice(0, -10),
      );
      files.add(trustedPath(framework, roots));
    }
  }
  let total = 0;
  const hash = crypto.createHash('sha256'),
    buffer = Buffer.alloc(64 * 1024);
  for (const filename of [...files].sort()) {
    const fd = fs.openSync(
      filename,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const before = fs.fstatSync(fd);
      total += before.size;
      if (
        !before.isFile() ||
        before.size > 512 * 1024 * 1024 ||
        total > 640 * 1024 * 1024
      )
        throw new Error('runtime_limit');
      hash.update(filename + '\0' + before.size + '\0');
      let bytes = 0,
        count: number;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        bytes += count;
        if (bytes > before.size) throw new Error('runtime_changed');
        hash.update(buffer.subarray(0, count));
      }
      const after = fs.fstatSync(fd);
      if (
        bytes !== before.size ||
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error('runtime_changed');
    } finally {
      fs.closeSync(fd);
    }
  }
  return {
    playwrightModule,
    browserExecutable,
    pythonCommand,
    fingerprint: hash.digest('hex'),
  };
}
function sign(
  payload: ArtifactAcceptanceReceipt['payload'],
  key: Buffer,
): string {
  return crypto
    .createHmac('sha256', key)
    .update(canonical(payload))
    .digest('hex');
}
function childResult(value: unknown): value is CheckerResult {
  const codes = [
    'checks_passed',
    'archive_invalid',
    'archive_unsafe',
    'archive_limit',
    'entry_missing',
    'scenario_failed',
    'network_blocked',
    'environment_unavailable',
    'checker_error',
  ];
  return (
    record(value) &&
    keys(value, ['status', 'code', 'checks']) &&
    ['passed', 'failed', 'inconclusive'].includes(String(value.status)) &&
    codes.includes(String(value.code)) &&
    Array.isArray(value.checks) &&
    value.checks.length <= 6 &&
    value.checks.every(
      (check) =>
        record(check) &&
        keys(check, ['id', 'outcome']) &&
        /^(archive_safety|entry_opened|step_[1-4])$/.test(String(check.id)) &&
        check.outcome === 'passed',
    ) &&
    (value.status !== 'passed' || value.code === 'checks_passed')
  );
}

function runChecker(
  code: string,
  input: object,
  cwd: string,
): Promise<CheckerResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=128', '--input-type=module', '-e', code],
      {
        cwd,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        // Deliberately do not inherit auth credentials, model settings or the key.
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      },
    );
    let output = Buffer.alloc(0);
    let settled = false;
    let forced: CheckerResult | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (result: CheckerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(forced ?? result);
    };
    const stop = () => {
      try {
        if (child.pid && process.platform !== 'win32')
          process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* Already exited. */
      }
    };
    const cancel = (code: string) => {
      forced ??= { status: 'inconclusive', code, checks: [] };
      child.kill('SIGTERM');
      killTimer ??= setTimeout(stop, 2000);
    };
    const timer = setTimeout(() => cancel('checker_timeout'), 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 8192) cancel('checker_output_limit');
      else output = Buffer.concat([output, chunk]);
    });
    child.stderr.on('data', () => {
      /* Browser errors may contain paths; discard. */
    });
    child.stdin.on('error', () => {});
    child.on('error', () =>
      finish({
        status: 'inconclusive',
        code: 'environment_unavailable',
        checks: [],
      }),
    );
    child.on('close', (exitCode) => {
      try {
        const parsed: unknown = JSON.parse(output.toString('utf8'));
        finish(
          exitCode === 0 && childResult(parsed)
            ? parsed
            : { status: 'inconclusive', code: 'checker_error', checks: [] },
        );
      } catch {
        finish({ status: 'inconclusive', code: 'checker_error', checks: [] });
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function prune(directory: string): void {
  for (const [suffix, count] of [
    ['.json', 128],
    ['.trace.zip', 8],
  ] as const) {
    const files = fs
      .readdirSync(directory)
      .filter(
        (name) =>
          name.endsWith(suffix) && ID.test(name.slice(0, -suffix.length)),
      )
      .map((name) => ({ name, stat: fs.lstatSync(path.join(directory, name)) }))
      .filter(({ stat }) => stat.isFile() && !stat.isSymbolicLink())
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const [index, file] of files.entries()) {
      if (index >= count || Date.now() - file.stat.mtimeMs > MAX_RECEIPT_AGE_MS)
        fs.unlinkSync(path.join(directory, file.name));
    }
  }
}

function currentCalculationSources(
  requirements: CalculationArtifactAcceptanceRequirements,
): Array<{ path: string; sha256: string; size: number }> | undefined {
  try {
    return requirements.sources.map((source) => {
      const bytes = artifactBytes(source.path);
      if (
        fs.realpathSync(source.path) !== source.path ||
        digest(bytes) !== source.sha256
      )
        throw new Error('source_changed');
      return { ...source, size: bytes.length };
    });
  } catch {
    return undefined;
  }
}
export function calculationAcceptanceSourcesCurrent(
  requirements: CalculationArtifactAcceptanceRequirements,
): boolean {
  return currentCalculationSources(requirements) !== undefined;
}

async function runCalculationAcceptance(options: {
  artifactPath: string;
  requirements: CalculationArtifactAcceptanceRequirements;
  host: ArtifactAcceptanceHost;
  isolation: ArtifactJobAttestation;
}): Promise<ArtifactAcceptanceRun> {
  const id = crypto.randomUUID();
  let work: string | undefined, key: Buffer | undefined;
  try {
    const state = hostState(options.host, true);
    key = state.key;
    if (activeChecks.size >= 2)
      return { status: 'inconclusive', code: 'checker_busy' };
    activeChecks.add(id);
    const extension = path.extname(options.artifactPath).toLowerCase();
    if (
      !['.pdf', '.xlsx'].includes(extension) ||
      !options.host.documentScriptsDirectory
    )
      return { status: 'inconclusive', code: 'environment_unavailable' };
    const runtime = trustedDocumentRuntime({
      scriptsDirectory: options.host.documentScriptsDirectory,
      roots: state.roots,
      pythonCommand: options.host.pythonCommand || '/usr/bin/python3',
      sofficeCommand: options.host.sofficeCommand,
      needsSpreadsheet: extension === '.xlsx',
    });
    const bytes = artifactBytes(options.artifactPath),
      sha256 = digest(bytes);
    const requirements = structuredClone(options.requirements);
    if (!calculationAcceptanceSourcesCurrent(requirements))
      return { status: 'inconclusive', code: 'source_changed' };
    work = createArtifactAcceptanceScratch(state.directory, 'work');
    const artifact = path.join(work, `final${extension}`);
    fs.writeFileSync(artifact, bytes, { flag: 'wx', mode: 0o600 });
    const sources: Array<{ path: string; sha256: string; size: number }> = [];
    const sourcePaths: string[] = [];
    for (const [index, source] of requirements.sources.entries()) {
      const content = artifactBytes(source.path);
      if (digest(content) !== source.sha256)
        return { status: 'inconclusive', code: 'source_changed' };
      const filename = path.join(
        work,
        `source-${index}${path.extname(source.path).toLowerCase()}`,
      );
      fs.writeFileSync(filename, content, { flag: 'wx', mode: 0o600 });
      sourcePaths.push(filename);
      sources.push({ ...source, size: content.length });
    }
    const report = await checkCalculationDocuments({
      sources: sourcePaths,
      final: artifact,
      criteria: requirements.criteria,
      reader: runtime,
      render: {
        outputDirectory: path.join(work, 'renders'),
        rendererPath: runtime.rendererPath,
        sofficeCommand: runtime.sofficeCommand,
      },
    });
    if (digest(artifactBytes(options.artifactPath)) !== sha256)
      return { status: 'inconclusive', code: 'artifact_changed_during_check' };
    if (!calculationAcceptanceSourcesCurrent(requirements))
      return { status: 'inconclusive', code: 'source_changed' };
    const status =
      report.status === 'pass'
        ? 'passed'
        : report.status === 'fail'
          ? 'failed'
          : 'inconclusive';
    const result: CheckerResult = {
      status,
      code:
        status === 'passed'
          ? 'checks_passed'
          : status === 'failed'
            ? 'document_mismatch'
            : 'document_incomplete',
      checks:
        status === 'passed'
          ? [
              { id: 'full_source_read', outcome: 'passed' },
              { id: 'exact_decimal_reconciliation', outcome: 'passed' },
              { id: 'final_reopened_and_rendered', outcome: 'passed' },
            ]
          : [],
    };
    const payload: ArtifactAcceptanceReceipt['payload'] = {
      schema: 1,
      id,
      issuedAt: new Date().toISOString(),
      artifact: { sha256, size: bytes.length },
      sources,
      requirementsSha256: digest(canonical(requirements)),
      validator: {
        id: 'calculation-document',
        version: 1,
        checkerSha256: runtime.fingerprint,
      },
      assurance: 'workspace-isolated',
      result,
      delivery: 'not_recorded',
      humanAcceptance: 'not_recorded',
      visualReview: 'not_recorded',
      renderAssessment: 'openability_and_text_smoke_only',
      producerIsolation: options.isolation,
    };
    const receipt = { payload, signature: sign(payload, key) };
    const encoded = JSON.stringify(receipt);
    if (encoded.length > MAX_RECEIPT_BYTES)
      return { status: 'inconclusive', code: 'receipt_limit' };
    fs.writeFileSync(path.join(state.directory, `${id}.json`), encoded, {
      flag: 'wx',
      mode: 0o600,
    });
    prune(state.directory);
    return { status, code: result.code, receipt };
  } catch (error) {
    const code =
      error instanceof Error &&
      [
        'isolation_unavailable',
        'checker_untrusted',
        'unsafe_host_directory',
        'untrusted_host_path',
        'environment_unavailable',
      ].includes(error.message)
        ? error.message
        : 'acceptance_unavailable';
    return { status: 'inconclusive', code };
  } finally {
    key?.fill(0);
    activeChecks.delete(id);
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
}

export async function runArtifactAcceptance(options: {
  artifactPath: string;
  requirements: ArtifactAcceptanceRequirements;
  host: ArtifactAcceptanceHost;
  jobAttestation?: object;
}): Promise<ArtifactAcceptanceRun> {
  if (!validateArtifactAcceptanceRequirements(options.requirements))
    return { status: 'inconclusive', code: 'requirements_invalid' };
  let isolation: ArtifactJobAttestation | undefined;
  try {
    isolation = consumeArtifactJobAttestation(options.jobAttestation, {
      artifactSha256: digest(artifactBytes(options.artifactPath)),
      requirementsSha256: digest(canonical(options.requirements)),
      hostDirectory: options.host.stateDir,
    });
  } catch {}
  if (!isolation)
    return { status: 'inconclusive', code: 'isolation_unavailable' };
  if (options.requirements.kind === 'calculation-v1')
    return runCalculationAcceptance({
      ...options,
      requirements: options.requirements,
      isolation,
    });
  const id = crypto.randomUUID();
  let work: string | undefined;
  let key: Buffer | undefined;
  try {
    const state = hostState(options.host, true);
    key = state.key;
    if (activeChecks.size >= 2)
      return { status: 'inconclusive', code: 'checker_busy' };
    activeChecks.add(id);
    const bytes = artifactBytes(options.artifactPath);
    const sha256 = digest(bytes);
    const requirements = structuredClone(options.requirements);
    let runtime: ReturnType<typeof browserRuntime>;
    try {
      runtime = browserRuntime(options.host, state.roots);
    } catch {
      return { status: 'inconclusive', code: 'environment_unavailable' };
    }
    const { pythonCommand, playwrightModule, browserExecutable } = runtime;
    work = createArtifactAcceptanceScratch(state.directory, 'work');
    const archive = path.join(work, 'artifact.zip');
    const directory = path.join(work, 'extracted');
    const tracePath = path.join(work, 'failure.trace.zip');
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(archive, bytes, { mode: 0o600, flag: 'wx' });
    const result = await runChecker(
      state.checker,
      {
        archive,
        directory,
        tracePath,
        requirements,
        playwrightModule,
        browserExecutable,
        pythonCommand,
      },
      work,
    );
    const expectedChecks = [
      'archive_safety',
      'entry_opened',
      ...requirements.steps.map((_, index) => `step_${index + 1}`),
    ];
    if (
      result.status === 'passed' &&
      canonical(result.checks.map((check) => check.id)) !==
        canonical(expectedChecks)
    ) {
      return { status: 'inconclusive', code: 'checker_incomplete' };
    }
    // The receipt always covers the snapshot tested. Changed originals get no pass.
    if (digest(artifactBytes(options.artifactPath)) !== sha256)
      return { status: 'inconclusive', code: 'artifact_changed_during_check' };
    const payload: ArtifactAcceptanceReceipt['payload'] = {
      schema: 1,
      id,
      issuedAt: new Date().toISOString(),
      artifact: { sha256, size: bytes.length },
      requirementsSha256: digest(canonical(requirements)),
      validator: {
        id: ARTIFACT_VALIDATOR,
        version: ARTIFACT_VALIDATOR_VERSION,
        checkerSha256: ARTIFACT_CHECKER_SHA256,
      },
      assurance: 'workspace-isolated',
      result,
      delivery: 'not_recorded',
      humanAcceptance: 'not_recorded',
      producerIsolation: isolation,
      browserRuntimeSha256: runtime.fingerprint,
    };
    if (result.status === 'failed' && fs.existsSync(tracePath)) {
      const trace = readBoundedRegularFileNoFollowSync(tracePath, {
        maxBytes: 8 * 1024 * 1024,
        oversize: 'reject',
      }).buffer;
      fs.writeFileSync(path.join(state.directory, `${id}.trace.zip`), trace, {
        flag: 'wx',
        mode: 0o600,
      });
      payload.trace = { sha256: digest(trace), size: trace.length };
    }
    const receipt: ArtifactAcceptanceReceipt = {
      payload,
      signature: sign(payload, key),
    };
    const encoded = JSON.stringify(receipt);
    if (encoded.length > MAX_RECEIPT_BYTES)
      return { status: 'inconclusive', code: 'receipt_limit' };
    fs.writeFileSync(path.join(state.directory, `${id}.json`), encoded, {
      mode: 0o600,
      flag: 'wx',
    });
    prune(state.directory);
    return { status: result.status, code: result.code, receipt };
  } catch (error) {
    const code =
      error instanceof Error &&
      [
        'isolation_unavailable',
        'checker_untrusted',
        'unsafe_host_directory',
        'untrusted_host_path',
      ].includes(error.message)
        ? error.message
        : 'acceptance_unavailable';
    return { status: 'inconclusive', code };
  } finally {
    key?.fill(0);
    activeChecks.delete(id);
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Only the host registry supplies IDs; arbitrary workspace receipt paths are not read. */
export function loadArtifactAcceptanceReceipt(
  id: string,
  host: ArtifactAcceptanceHost,
): ArtifactAcceptanceReceipt | undefined {
  if (!ID.test(id)) return undefined;
  let key: Buffer | undefined;
  try {
    const state = hostState(host, false);
    key = state.key;
    return JSON.parse(
      readBoundedRegularFileNoFollowSync(
        path.join(state.directory, `${id}.json`),
        {
          maxBytes: MAX_RECEIPT_BYTES,
          oversize: 'reject',
          requireSingleLink: true,
        },
      ).buffer.toString('utf8'),
    ) as ArtifactAcceptanceReceipt;
  } catch {
    return undefined;
  } finally {
    key?.fill(0);
  }
}

/** Re-hash immediately before using a receipt. Delivery still needs its own receipt. */
export function verifyArtifactAcceptanceReceipt(options: {
  artifactPath: string;
  requirements: ArtifactAcceptanceRequirements;
  receipt: unknown;
  host: ArtifactAcceptanceHost;
}): ArtifactAcceptanceVerification {
  const answer = (
    status: ArtifactAcceptanceVerification['status'],
    code: string,
  ): ArtifactAcceptanceVerification => ({
    status,
    code,
    humanAcceptance: 'not_recorded',
  });
  let key: Buffer | undefined;
  try {
    if (!validateArtifactAcceptanceRequirements(options.requirements))
      return answer('inconclusive', 'requirements_invalid');
    const state = hostState(options.host, false);
    key = state.key;
    const encoded = JSON.stringify(options.receipt);
    if (
      !encoded ||
      encoded.length > MAX_RECEIPT_BYTES ||
      !record(options.receipt)
    )
      return answer('untrusted', 'receipt_invalid');
    const receipt = options.receipt as unknown as ArtifactAcceptanceReceipt;
    if (
      !record(receipt.payload) ||
      typeof receipt.signature !== 'string' ||
      !HASH.test(receipt.signature)
    )
      return answer('untrusted', 'receipt_invalid');
    const signature = sign(receipt.payload, key);
    if (
      !crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(receipt.signature, 'hex'),
      )
    )
      return answer('untrusted', 'signature_invalid');
    const p = receipt.payload;
    if (
      !p.producerIsolation ||
      p.producerIsolation.policy !== ARTIFACT_JOB_POLICY ||
      p.producerIsolation.artifactSha256 !== p.artifact.sha256 ||
      p.producerIsolation.requirementsSha256 !== p.requirementsSha256 ||
      !Array.isArray(p.producerIsolation.writableRoots) ||
      p.producerIsolation.writableRoots.length !== 1 ||
      !path.isAbsolute(p.producerIsolation.writableRoots[0])
    )
      return answer('stale', 'isolation_attestation_missing');
    const documentRuntime =
      options.requirements.kind === 'calculation-v1'
        ? trustedDocumentRuntime({
            scriptsDirectory: options.host.documentScriptsDirectory || '',
            roots: p.producerIsolation.writableRoots,
            pythonCommand: options.host.pythonCommand || '/usr/bin/python3',
            sofficeCommand: options.host.sofficeCommand,
            needsSpreadsheet:
              path.extname(options.artifactPath).toLowerCase() === '.xlsx',
          })
        : undefined;
    if (
      p.schema !== 1 ||
      !ID.test(p.id) ||
      p.assurance !== 'workspace-isolated' ||
      p.delivery !== 'not_recorded' ||
      p.humanAcceptance !== 'not_recorded' ||
      p.validator.id !==
        (documentRuntime ? 'calculation-document' : ARTIFACT_VALIDATOR) ||
      p.validator.version !==
        (documentRuntime ? 1 : ARTIFACT_VALIDATOR_VERSION) ||
      p.validator.checkerSha256 !==
        (documentRuntime?.fingerprint || ARTIFACT_CHECKER_SHA256)
    )
      return answer('stale', 'validator_changed');
    if (!documentRuntime) {
      try {
        if (
          p.browserRuntimeSha256 !==
          browserRuntime(options.host, p.producerIsolation.writableRoots)
            .fingerprint
        )
          return answer('stale', 'validator_changed');
      } catch {
        return answer('inconclusive', 'environment_unavailable');
      }
    }
    const issued = Date.parse(p.issuedAt);
    if (
      !Number.isFinite(issued) ||
      issued > Date.now() + 1000 ||
      Date.now() - issued > MAX_RECEIPT_AGE_MS
    )
      return answer('stale', 'receipt_expired');
    if (p.requirementsSha256 !== digest(canonical(options.requirements)))
      return answer('stale', 'requirements_changed');
    if (options.requirements.kind === 'calculation-v1') {
      const sources = currentCalculationSources(options.requirements);
      if (!sources || canonical(p.sources) !== canonical(sources))
        return answer('stale', 'source_changed');
    }
    const bytes = artifactBytes(options.artifactPath);
    if (p.artifact.sha256 !== digest(bytes) || p.artifact.size !== bytes.length)
      return answer('stale', 'artifact_changed');
    return answer(p.result.status, p.result.code);
  } catch {
    return answer('inconclusive', 'acceptance_unavailable');
  } finally {
    key?.fill(0);
  }
}
