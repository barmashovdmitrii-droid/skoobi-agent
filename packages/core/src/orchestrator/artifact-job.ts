import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import {
  artifactAcceptanceHostDirectory,
  createArtifactAcceptanceScratch,
  runArtifactAcceptance,
  validateArtifactAcceptanceRequirements,
  type ArtifactAcceptanceHost,
  type ArtifactAcceptanceRequirements,
  type ArtifactAcceptanceRun,
} from './artifact-acceptance.js';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';
import {
  prepareArtifactJobCodex,
  startArtifactModelProxy,
  type ArtifactJobCodexConfig,
} from './artifact-job-model.js';

export { configuredArtifactJobCodex } from './artifact-job-model.js';

export const ARTIFACT_JOB_POLICY = 'macos-seatbelt-artifact-v1';
export interface ArtifactJobAttestation {
  policy: typeof ARTIFACT_JOB_POLICY;
  id: string;
  profileSha256: string;
  executableSha256: string;
  supportExecutableSha256?: string;
  artifactSha256: string;
  requirementsSha256: string;
  writableRoots: string[];
  startedAt: string;
  finishedAt: string;
}
interface PendingAttestation {
  evidence: ArtifactJobAttestation;
  hostDirectory: string;
}
const attestations = new WeakMap<object, PendingAttestation>();
let activeJob = false;
const hash = (bytes: Buffer | string) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}
function inside(filename: string, root: string): boolean {
  const relative = path.relative(root, filename);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
function relativeFile(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[a-zA-Z0-9_.\/-]+$/.test(value) &&
    value
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/** No mint API exists. Only an actual successful controller launch registers a token. */
export function consumeArtifactJobAttestation(
  token: unknown,
  binding: {
    artifactSha256: string;
    requirementsSha256: string;
    hostDirectory: string;
  },
): ArtifactJobAttestation | undefined {
  if (!token || typeof token !== 'object') return undefined;
  const registered = attestations.get(token);
  attestations.delete(token);
  if (
    !registered ||
    registered.hostDirectory !== fs.realpathSync(binding.hostDirectory) ||
    registered.evidence.artifactSha256 !== binding.artifactSha256 ||
    registered.evidence.requirementsSha256 !== binding.requirementsSha256
  )
    return undefined;
  return structuredClone(registered.evidence);
}

export interface IsolatedArtifactJobOptions {
  host: ArtifactAcceptanceHost;
  requirements: ArtifactAcceptanceRequirements;
  producer: { executable: string; args: string[]; readOnlyPaths?: string[] };
  /** Copies are private and read-only to the producer, under inputs/. */
  inputs: Array<{ sourcePath: string; relativePath: string }>;
  artifactRelativePath: string;
  timeoutMs?: number;
  codex?: ArtifactJobCodexConfig;
}
export interface IsolatedArtifactJobResult extends ArtifactAcceptanceRun {
  jobId?: string;
  artifactPath?: string;
  cleanup?: () => void;
  containmentFailures?: string[];
}

function profileFor(
  workspace: string,
  readPaths: string[],
  proxyPort?: number,
): string {
  const standard = [
    '/System/Library',
    '/usr',
    '/bin',
    '/sbin',
    '/Library/Apple',
    '/Library/Developer/CommandLineTools',
    '/opt/homebrew/Cellar',
    '/opt/homebrew/opt',
  ].filter((filename) => fs.existsSync(filename));
  const reads = [...new Set([...standard, ...readPaths, workspace])];
  const writes = ['output', 'scratch', 'home'].map((name) =>
    path.join(workspace, name),
  );
  return (
    [
      '(version 1)',
      '(deny default)',
      '(deny job-creation)',
      '(allow process-exec)',
      '(allow process-fork)',
      '(allow process-info* (target same-sandbox))',
      '(allow signal (target same-sandbox))',
      '(allow mach-priv-task-port (target same-sandbox))',
      '(allow sysctl-read)',
      '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
      '(allow file-read-metadata (vnode-type DIRECTORY))',
      '(allow file-read-data (literal "/"))',
      // Codex must observe mandatory system requirements, including their absence.
      '(allow file-read* (literal "/etc/ssl/cert.pem") (literal "/private/etc/ssl/cert.pem"))',
      '(allow file-read-metadata (literal "/etc") (literal "/var") (literal "/tmp"))',
      '(allow file-read* (literal "/etc/codex/requirements.toml") (literal "/private/etc/codex/requirements.toml") (literal "/etc/codex/managed_config.toml") (literal "/private/etc/codex/managed_config.toml"))',
      ...reads.map(
        (filename) =>
          `(allow file-read* (subpath ${JSON.stringify(filename)}))`,
      ),
      ...writes.map(
        (filename) =>
          `(allow file-write* (subpath ${JSON.stringify(filename)}))`,
      ),
      '(allow file-read* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',
      '(allow file-write* file-ioctl (literal "/dev/null"))',
      ...(proxyPort
        ? [
            `(allow network-outbound (remote ip "localhost:${proxyPort}"))`,
            '(allow mach-lookup (global-name "com.apple.cfprefsd.agent") (global-name "com.apple.cfprefsd.daemon") (local-name "com.apple.cfprefsd.agent"))',
            '(allow user-preference-read (preference-domain "com.openai.codex"))',
            '(deny user-preference-write)',
            `(allow ipc-posix-shm-read* (ipc-posix-name "apple.cfprefs.${process.getuid?.()}v1") (ipc-posix-name "apple.cfprefs.daemonv1"))`,
          ]
        : []),
      // Only Codex policy preferences may use Mach; no app launch, keychain, PTY or host MCP bridge.
    ].join('\n') + '\n'
  );
}

async function launched(
  profile: string,
  executable: string,
  args: string[],
  workspace: string,
  timeoutMs: number,
  extra?: { env: Record<string, string>; input: string },
): Promise<{ code: number | null; stdout: string; failed: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(
      '/usr/bin/sandbox-exec',
      ['-f', profile, executable, ...args],
      {
        cwd: workspace,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          HOME: path.join(workspace, 'home'),
          TMPDIR: path.join(workspace, 'scratch'),
          OPENSSL_CONF: '/dev/null',
          SSL_CERT_FILE: '/etc/ssl/cert.pem',
          LANG: 'en_US.UTF-8',
          ...extra?.env,
        },
      },
    );
    let size = 0,
      failed = false;
    const output: Buffer[] = [];
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => {
      failed = true;
      stop();
    }, timeoutMs);
    const collect = (chunk: Buffer, stdout: boolean) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        failed = true;
        stop();
      } else if (stdout) output.push(chunk);
    };
    child.stdout.on('data', (chunk) => collect(chunk, true));
    child.stderr.on('data', (chunk) => collect(chunk, false));
    child.stdin.on('error', () => {});
    child.stdin.end(extra?.input || '');
    child.on('error', () => {
      clearTimeout(timer);
      failed = true;
      resolve({ code: null, stdout: '', failed });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      stop();
      resolve({ code, stdout: Buffer.concat(output).toString('utf8'), failed });
    });
  });
}

const PREFLIGHT = String.raw`
const fs = require('node:fs'), cp = require('node:child_process'), net = require('node:net');
const [canary, socket, port] = process.argv.slice(1); const checks = [];
const denied = (name, action) => { try { action(); checks.push([name,false]); } catch(e) { checks.push([name,['EPERM','EACCES'].includes(e.code)]); } };
fs.writeFileSync('output/allowed','ok');
denied('readonly-input',()=>fs.writeFileSync('inputs/injected','bad'));
denied('read',()=>fs.readFileSync(canary));
denied('data-volume-alias',()=>fs.readFileSync('/System/Volumes/Data'+canary));
denied('write',()=>fs.writeFileSync(canary,'changed'));
denied('rename',()=>fs.renameSync(canary,'output/moved'));
fs.symlinkSync(canary,'output/link'); denied('symlink',()=>fs.readFileSync('output/link'));
try { fs.linkSync(canary,'output/hardlink'); denied('hardlink',()=>fs.readFileSync('output/hardlink')); } catch(e) { checks.push(['hardlink',['EPERM','EACCES'].includes(e.code)]); }
const nested=cp.spawnSync(process.execPath,['-e','try{require("fs").readFileSync(process.argv[1]);process.exit(9)}catch(e){process.exit(["EPERM","EACCES"].includes(e.code)?0:8)}',canary],{env:process.env});checks.push(['child',nested.status===0]);
const loosen=cp.spawnSync('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)','/bin/cat',canary],{env:process.env});checks.push(['nested-sandbox',loosen.status!==0]);
const bridge=canary+'.bridge';
const shellQuote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
const touch='/usr/bin/touch '+shellQuote(bridge);
const osa=cp.spawnSync('/usr/bin/osascript',['-e','do shell script '+JSON.stringify(touch)],{env:process.env,timeout:2000});checks.push(['osascript',osa.status!==0&&!fs.existsSync(bridge)]);
// launchctl print is read-only and can succeed; query the launch authority itself.
const launch=cp.spawnSync('/usr/bin/python3',['-c','import ctypes,os,sys; lib=ctypes.CDLL("/usr/lib/libsandbox.1.dylib"); lib.sandbox_check.restype=ctypes.c_int; sys.exit(0 if lib.sandbox_check(os.getpid(),b"job-creation",0)==1 else 9)'],{env:{...process.env,DEVELOPER_DIR:'/Library/Developer/CommandLineTools'},timeout:2000});checks.push(['launchd-job-creation',launch.status===0]);
const prefs=cp.spawnSync('/usr/bin/python3',['-c','import ctypes,os,sys; lib=ctypes.CDLL("/usr/lib/libsandbox.1.dylib"); lib.sandbox_check.restype=ctypes.c_int; sys.exit(0 if lib.sandbox_check(os.getpid(),b"user-preference-write",0)==1 else 9)'],{env:{...process.env,DEVELOPER_DIR:'/Library/Developer/CommandLineTools'},timeout:2000});checks.push(['preference-write-authority',prefs.status===0]);
fs.mkdirSync('output/Probe.app/Contents/MacOS',{recursive:true});
fs.writeFileSync('output/Probe.app/Contents/Info.plist','<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>com.example.artifactprobe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
fs.writeFileSync('output/Probe.app/Contents/MacOS/probe','#!/bin/sh\n'+touch+'\n',{mode:0o700});
const opened=cp.spawnSync('/usr/bin/open',['-W','-n','output/Probe.app'],{env:process.env,timeout:2000});checks.push(['launchservices',opened.status!==0&&!fs.existsSync(bridge)]);
async function blocked(name, address) { await new Promise(resolve=> { const client=net.createConnection(address); client.on('connect',()=>{checks.push([name,false]);client.destroy();resolve()});client.on('error',e=>{checks.push([name,['EPERM','EACCES'].includes(e.code)]);resolve()});setTimeout(()=>{client.destroy();checks.push([name,false]);resolve()},1000).unref(); }); }
(async()=>{await blocked('unix-socket',{path:socket});await blocked('local-port',{host:'127.0.0.1',port:Number(port)});process.stdout.write(JSON.stringify(checks));process.exit(checks.length===15&&checks.every(x=>x[1])?0:5)})().catch(()=>process.exit(6));
`;

async function preflight(
  profile: string,
  workspace: string,
  hostDirectory: string,
): Promise<{ passed: boolean; failures: string[] }> {
  const canary = path.join(hostDirectory, `probe-${crypto.randomUUID()}`);
  const socketDirectory = fs.mkdtempSync('/private/tmp/skaj-');
  fs.chmodSync(socketDirectory, 0o700);
  const socket = path.join(socketDirectory, 's');
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(canary, secret, { flag: 'wx', mode: 0o600 });
  let contacted = false;
  const unix = net.createServer((client) => {
    contacted = true;
    client.destroy();
  });
  const tcp = net.createServer((client) => {
    contacted = true;
    client.destroy();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      unix.once('error', reject);
      unix.listen(socket, resolve);
    });
    await new Promise<void>((resolve, reject) => {
      tcp.once('error', reject);
      tcp.listen(0, '127.0.0.1', resolve);
    });
    const address = tcp.address() as net.AddressInfo;
    const result = await launched(
      profile,
      process.execPath,
      ['-e', PREFLIGHT, canary, socket, String(address.port)],
      workspace,
      10_000,
    );
    const checks = JSON.parse(result.stdout) as Array<[string, boolean]>;
    const failures = checks
      .filter((check) => check[1] !== true)
      .map((check) => check[0]);
    const passed =
      result.code === 0 &&
      !result.failed &&
      !contacted &&
      !fs.existsSync(`${canary}.bridge`) &&
      fs.readFileSync(canary).equals(secret);
    return {
      passed,
      failures: failures.length
        ? failures
        : passed
          ? []
          : ['preflight_incomplete'],
    };
  } catch {
    return { passed: false, failures: ['preflight_incomplete'] };
  } finally {
    unix.close();
    tcp.close();
    fs.rmSync(socket, { force: true });
    fs.rmSync(socketDirectory, { recursive: true, force: true });
    fs.rmSync(canary, { force: true });
    fs.rmSync(`${canary}.bridge`, { force: true });
  }
}

/** Entire producer process tree starts inside Seatbelt; no ordinary runner bypass is used. */
export async function runIsolatedArtifactJob(
  options: IsolatedArtifactJobOptions,
): Promise<IsolatedArtifactJobResult> {
  if (process.platform !== 'darwin')
    return { status: 'inconclusive', code: 'isolation_platform_unsupported' };
  if (activeJob) return { status: 'inconclusive', code: 'artifact_job_busy' };
  if (
    !options.producer ||
    !Array.isArray(options.producer.args) ||
    !Array.isArray(options.inputs) ||
    (options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) ||
        options.timeoutMs < 1000 ||
        options.timeoutMs > 300_000)) ||
    !validateArtifactAcceptanceRequirements(options.requirements) ||
    !relativeFile(options.artifactRelativePath) ||
    !options.artifactRelativePath.startsWith('output/') ||
    !options.inputs.length ||
    options.inputs.length > 16 ||
    options.inputs.some((i) => !i || !relativeFile(i.relativePath)) ||
    options.producer.args.length > 32 ||
    options.producer.args.some(
      (a) => typeof a !== 'string' || a.length > 16_384 || a.includes('\0'),
    )
  )
    return { status: 'inconclusive', code: 'artifact_job_invalid' };
  activeJob = true;
  const jobId = crypto.randomUUID();
  let workspace: string | undefined, evidenceDirectory: string | undefined;
  let modelProxy:
    | Awaited<ReturnType<typeof startArtifactModelProxy>>
    | undefined;
  try {
    if (fs.realpathSync('/usr/bin/sandbox-exec') !== '/usr/bin/sandbox-exec')
      throw new Error('isolation_unavailable');
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-artifact-producer-')),
    );
    fs.chmodSync(workspace, 0o700);
    for (const name of ['inputs', 'output', 'scratch', 'home'])
      fs.mkdirSync(path.join(workspace, name), { mode: 0o700 });
    const effectiveHost: ArtifactAcceptanceHost = {
      ...options.host,
      agentWritableRoots: [workspace],
      boundary: 'workspace-isolated',
    };
    const hostDirectory = artifactAcceptanceHostDirectory(effectiveHost, true);
    const executable = fs.realpathSync(options.producer.executable);
    const readPaths = [
      executable,
      process.execPath,
      ...(options.codex ? [path.dirname(executable)] : []),
      ...(options.producer.readOnlyPaths || []),
    ].map((filename) => fs.realpathSync(filename));
    if (
      [
        '/System/Library',
        '/usr',
        '/bin',
        '/sbin',
        '/Library/Apple',
        '/Library/Developer/CommandLineTools',
        '/opt/homebrew/Cellar',
        '/opt/homebrew/opt',
      ].some((root) => inside(hostDirectory, root))
    )
      throw new Error('artifact_job_invalid');
    if (
      readPaths.length > 16 ||
      readPaths.some(
        (filename) =>
          filename === path.parse(filename).root ||
          inside(hostDirectory, filename) ||
          inside(filename, workspace!),
      )
    )
      throw new Error('artifact_job_invalid');
    const copied = new Set<string>();
    let total = 0;
    for (const input of options.inputs) {
      const destination = path.join(workspace, 'inputs', input.relativePath);
      if (copied.has(destination)) throw new Error('artifact_job_invalid');
      copied.add(destination);
      const bytes = readBoundedRegularFileNoFollowSync(input.sourcePath, {
        maxBytes: 16 * 1024 * 1024,
        oversize: 'reject',
        requireSingleLink: true,
      }).buffer;
      total += bytes.length;
      if (total > 32 * 1024 * 1024) throw new Error('artifact_job_invalid');
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
    }
    let codexLaunch: ReturnType<typeof prepareArtifactJobCodex> | undefined;
    let supportExecutableSha256: string | undefined;
    if (options.codex)
      supportExecutableSha256 = hash(
        readBoundedRegularFileNoFollowSync(
          path.join(path.dirname(executable), 'codex-code-mode-host'),
          {
            maxBytes: 128 * 1024 * 1024,
            oversize: 'reject',
            requireSingleLink: true,
          },
        ).buffer,
      );
    if (options.codex) {
      if (options.producer.args.length) throw new Error('artifact_job_invalid');
      codexLaunch = prepareArtifactJobCodex(workspace, options.codex);
      modelProxy = await startArtifactModelProxy();
      const url = `http://127.0.0.1:${modelProxy.port}`;
      Object.assign(codexLaunch.env, {
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
        http_proxy: url,
        https_proxy: url,
        NO_PROXY: '',
        no_proxy: '',
      });
    }
    const profile = profileFor(workspace, readPaths, modelProxy?.port);
    const profilePath = path.join(hostDirectory, `profile-${jobId}.sb`);
    fs.writeFileSync(profilePath, profile, { flag: 'wx', mode: 0o600 });
    try {
      const isolation = await preflight(profilePath, workspace, hostDirectory);
      if (!isolation.passed)
        return {
          status: 'inconclusive',
          code: 'isolation_preflight_failed',
          containmentFailures: isolation.failures,
          jobId,
        };
      fs.rmSync(path.join(workspace, 'output'), { recursive: true });
      fs.mkdirSync(path.join(workspace, 'output'), { mode: 0o700 });
      const startedAt = new Date().toISOString();
      const producer = await launched(
        profilePath,
        executable,
        codexLaunch?.args || options.producer.args,
        workspace,
        Math.min(Math.max(options.timeoutMs || 60_000, 1000), 300_000),
        codexLaunch,
      );
      if (producer.code !== 0 || producer.failed)
        return { status: 'inconclusive', code: 'producer_failed', jobId };
      const produced = path.join(workspace, options.artifactRelativePath);
      if (!fs.existsSync(produced))
        return {
          status: 'inconclusive',
          code: 'producer_artifact_missing',
          jobId,
        };
      if (!inside(fs.realpathSync(produced), path.join(workspace, 'output')))
        throw new Error('artifact_job_invalid');
      const bytes = readBoundedRegularFileNoFollowSync(produced, {
        maxBytes: 16 * 1024 * 1024,
        oversize: 'reject',
        requireSingleLink: true,
      }).buffer;
      evidenceDirectory = createArtifactAcceptanceScratch(
        hostDirectory,
        'delivery',
      );
      const artifactPath = path.join(
        evidenceDirectory,
        path.basename(produced),
      );
      fs.writeFileSync(artifactPath, bytes, { flag: 'wx', mode: 0o600 });
      const token = Object.freeze({});
      attestations.set(token, {
        hostDirectory,
        evidence: {
          policy: ARTIFACT_JOB_POLICY,
          id: jobId,
          profileSha256: hash(profile),
          executableSha256: hash(fs.readFileSync(executable)),
          ...(supportExecutableSha256 ? { supportExecutableSha256 } : {}),
          artifactSha256: hash(bytes),
          requirementsSha256: hash(canonical(options.requirements)),
          writableRoots: [workspace],
          startedAt,
          finishedAt: new Date().toISOString(),
        },
      });
      const result = await runArtifactAcceptance({
        artifactPath,
        requirements: options.requirements,
        host: effectiveHost,
        jobAttestation: token,
      });
      const owned = evidenceDirectory;
      evidenceDirectory = undefined;
      return {
        ...result,
        jobId,
        artifactPath,
        cleanup: () => fs.rmSync(owned!, { recursive: true, force: true }),
      };
    } finally {
      fs.rmSync(profilePath, { force: true });
    }
  } catch (error) {
    return {
      status: 'inconclusive',
      code:
        error instanceof Error &&
        ['isolation_unavailable', 'artifact_job_invalid'].includes(
          error.message,
        )
          ? error.message
          : 'artifact_job_unavailable',
      jobId,
    };
  } finally {
    if (modelProxy) await modelProxy.close();
    activeJob = false;
    if (evidenceDirectory)
      fs.rmSync(evidenceDirectory, { recursive: true, force: true });
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  }
}
