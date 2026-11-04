import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { CODE_ROOT } from './config.js';
import { getDb } from './db.js';
import { FactoryError, type FactoryActor } from './game-factory-contracts.js';
import { GameFactoryStore } from './game-factory-store.js';
import {
  readGameFactoryConfiguration,
  validateGameFactoryDatabaseLocation,
} from './game-factory-service.js';
import {
  readFactoryPeerBinding,
  projectFactoryPeerState,
} from './game-factory-peer-state.js';
import { buildGameFactoryPeerContext } from './game-factory-peer-adapter.js';
import {
  importFactorySourceAsync,
  type FactoryManifest,
} from './game-factory-artifacts.js';
import { peerCanonicalJson } from './peer-context.js';
import type { PeerInboxEvent } from './peer-inbox.js';

const digest = (value: unknown) =>
  createHash('sha256').update(peerCanonicalJson(value)).digest('hex');
const bytesHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 16 * 1024 * 1024;
function denied(): never {
  throw new FactoryError('peer_result_unavailable');
}
export interface FactoryPeerResultHost {
  inboxDb?: Database.Database;
}
export interface FactoryPeerResultInspection {
  jobId: string;
  projectId: string;
  briefRevision: number;
  contextSha256: string;
  resultSha256: string;
  artifacts: Array<{
    name: string;
    sha256: string;
    bytes: number;
    kind: 'document' | 'photo';
  }>;
  workerClaimsAreNotAcceptance: true;
}
type Artifact = {
  name: string;
  displayName?: string;
  sha256: string;
  bytes: number;
  kind: 'document' | 'photo';
  localPath: string;
};

async function retainedResult(
  actor: FactoryActor,
  input: { projectId: string; jobId: string },
  host: FactoryPeerResultHost,
  importing = false,
) {
  const config = readGameFactoryConfiguration();
  const callerPolicy = config?.actors.find(
    (actorPolicy) =>
      actorPolicy.identityId === actor.identityId &&
      actorPolicy.tenantId === actor.tenantId,
  );
  if (
    !config?.enabled ||
    !callerPolicy ||
    (importing && !callerPolicy.backends.includes('peer')) ||
    !validateGameFactoryDatabaseLocation(config.databasePath)
  )
    denied();
  const db = new Database(config.databasePath, { readonly: true });
  try {
    const store = new GameFactoryStore(db);
    store.requireRole(
      actor,
      input.projectId,
      importing
        ? ['owner', 'editor']
        : ['owner', 'editor', 'reviewer', 'reader'],
    );
    const binding = readFactoryPeerBinding(db, input.jobId);
    if (!binding || binding.projectId !== input.projectId) denied();
    const bound = projectFactoryPeerState(db, config, binding),
      context = buildGameFactoryPeerContext(bound);
    // Transport expiry prevents another execution. An already received result
    // remains importable while its project requirements and ACL are unchanged.
    if (!bound.retainedResultCurrent || !bound.routeAllowed) denied();
    const operation = store
      .read(actor, input.projectId)
      .operations.find(
        (o) => o.kind === 'peer' && o.externalId === input.jobId,
      );
    if (
      !operation ||
      operation.state !== 'completed' ||
      operation.evidence !== 'host_observed' ||
      operation.resultConflict
    )
      denied();
    const core = await import(
      pathToFileURL(path.join(CODE_ROOT, 'ops/peer/skoobi-peer-core.mjs')).href
    );
    const acceptance = await import(
      pathToFileURL(path.join(CODE_ROOT, 'ops/peer/skoobi-peer-acceptance.mjs'))
        .href
    );
    const coordinator = core.loadConfig(binding.dispatch.coordinatorConfigPath);
    if (
      coordinator.role !== 'coordinator' ||
      coordinator.networkId !== bound.networkId
    )
      denied();
    // Inspecting an absent queue never creates its jobs/snapshots directories.
    for (const directory of ['jobs', 'snapshots'])
      core.privateDirectory(path.join(coordinator.stateRoot, directory));
    const jobs = new core.JobStore(coordinator.stateRoot),
      state = jobs.state(input.jobId),
      payload = jobs.payload(input.jobId);
    const expectedPacket = jobs.packet({
      schema: 2,
      id: input.jobId,
      ...binding.dispatch.options,
      context,
    });
    if (
      state.schema !== 2 ||
      state.state !== 'succeeded' ||
      state.revision !== bound.peerRevision ||
      state.contextInvalidated ||
      state.localConclusion ||
      state.requestedRevision > state.revision ||
      state.pendingRevision ||
      state.inputHash !== expectedPacket.inputHash ||
      peerCanonicalJson(payload) !==
        peerCanonicalJson(expectedPacket.payload) ||
      !state.remoteResult ||
      state.remoteResult.state !== 'succeeded' ||
      peerCanonicalJson(payload.context) !== peerCanonicalJson(context) ||
      payload.contract.parentTaskId !== bound.parentTaskId ||
      payload.contract.projectKey !== input.projectId ||
      payload.contract.revision !== bound.peerRevision ||
      state.remoteResult.result?.revision !== bound.peerRevision ||
      state.remoteResult.result?.contextSha256 !== context.sha256
    )
      denied();
    const artifacts = state.localArtifacts as Artifact[];
    if (!Array.isArray(artifacts) || !artifacts.length || artifacts.length > 20)
      denied();
    const sourceRoot = path.join(jobs.dir(input.jobId), 'artifacts');
    core.privateDirectory(sourceRoot);
    const displayNames = new Set<string>();
    let total = 0;
    for (const artifact of artifacts) {
      const display = artifact.displayName || artifact.name;
      if (
        !/^[a-f0-9]{64}(?:\.[A-Za-z0-9.]{1,15})?$/.test(artifact.name) ||
        !HASH.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.bytes) ||
        artifact.bytes < 1 ||
        artifact.bytes > MAX_BYTES ||
        !['photo', 'document'].includes(artifact.kind) ||
        artifact.localPath !== path.join(sourceRoot, artifact.name) ||
        !display ||
        display.length > 128 ||
        /[\\/\0\r\n]/.test(display) ||
        display.startsWith('.') ||
        displayNames.has(display.toLowerCase()) ||
        !payload.contract.expectedOutputs.some(
          (o: { name: string }) => o.name === display,
        )
      )
        denied();
      displayNames.add(display.toLowerCase());
      total += artifact.bytes;
    }
    if (total > MAX_BYTES || total > payload.contract.execution.maxOutputBytes)
      denied();
    const resultHash = acceptance.peerResultDigest(
      state.remoteResult,
      artifacts,
    );
    if (
      !HASH.test(resultHash) ||
      state.assessment?.resultHash !== resultHash ||
      operation.resultHash !== resultHash ||
      typeof state.resultEventId !== 'string'
    )
      denied();
    const inbox = host.inboxDb ?? getDb();
    const accepted = inbox
      .prepare(
        "SELECT event_id,payload_json,payload_hash FROM peer_result_events WHERE job_id=? AND revision=? AND event_kind='result' AND result_hash=?",
      )
      .get(input.jobId, bound.peerRevision, resultHash) as
      | { event_id: string; payload_json: string; payload_hash: string }
      | undefined;
    const recorded = db
      .prepare(
        'SELECT event_sha256 FROM factory_peer_events WHERE event_id=? AND job_id=?',
      )
      .get(accepted?.event_id ?? '', input.jobId) as
      | { event_sha256: string }
      | undefined;
    if (
      !accepted ||
      !recorded ||
      Buffer.byteLength(accepted.payload_json) > 128 * 1024 ||
      bytesHash(accepted.payload_json) !== accepted.payload_hash
    )
      denied();
    const event = JSON.parse(accepted.payload_json) as PeerInboxEvent;
    if (
      digest(event) !== recorded.event_sha256 ||
      event.eventKind !== 'result' ||
      event.resultState !== 'succeeded' ||
      event.resultHash !== resultHash ||
      event.contextHash !== context.sha256 ||
      event.contextValidity.scopeRevisionHash !== bound.scopeRevisionHash ||
      event.contextValidity.expiresAt !== bound.expiresAt ||
      event.projectKey !== input.projectId ||
      event.parentTaskId !== bound.parentTaskId ||
      event.revision !== bound.peerRevision ||
      event.artifacts.length !== artifacts.length ||
      !artifacts.every((a) =>
        event.artifacts.some(
          (e) =>
            e.name === a.name &&
            e.sha256 === a.sha256 &&
            e.bytes === a.bytes &&
            e.kind === a.kind,
        ),
      )
    )
      denied();
    const inspection: FactoryPeerResultInspection = {
      jobId: input.jobId,
      projectId: input.projectId,
      briefRevision: bound.briefRevision,
      contextSha256: context.sha256,
      resultSha256: resultHash,
      artifacts: artifacts.map((a) => ({
        name: a.displayName || a.name,
        sha256: a.sha256,
        bytes: a.bytes,
        kind: a.kind,
      })),
      workerClaimsAreNotAcceptance: true,
    };
    return {
      inspection,
      sourceRoot,
      artifacts,
      declaredFileNames: payload.contract.expectedOutputs
        .filter((output: { kind: string }) => output.kind !== 'text')
        .map((output: { name: string }) => output.name) as string[],
      proof: digest({ inspection, eventSha256: recorded.event_sha256 }),
    };
  } finally {
    db.close();
  }
}

/* The source paths below come only from the exact received host artifact
 * manifest. No shell, imported code or archive extraction APIs are executed.
 * Every file/ancestor is opened with nofollow; ZIP bytes are snapshotted and
 * hashed before parsing; output is written descriptor-relative under a fresh
 * private temp directory. Final publication uses the existing factory helper. */
const UNPACK = String.raw`
import hashlib, io, json, os, stat, sys, unicodedata, zipfile
q=json.load(sys.stdin)
DIR=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK
FILE=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK
MAX=16*1024*1024
ALLOW={'.html','.htm','.js','.mjs','.cjs','.ts','.tsx','.jsx','.css','.json','.webmanifest','.wasm','.png','.jpg','.jpeg','.webp','.avif','.gif','.svg','.ico','.bmp','.ktx','.ktx2','.basis','.mp3','.ogg','.oga','.opus','.wav','.m4a','.aac','.flac','.mp4','.webm','.woff','.woff2','.ttf','.otf','.eot','.glb','.gltf','.obj','.mtl','.bin','.atlas','.tmx','.xml','.csv','.frag','.vert','.glsl','.wgsl','.fnt'}
BLOCK={'node_modules','logs','log','store','state','sessions','session','memory','conversations','credentials','secrets','auth','ipc','cache','archives','archive','backups','backup','coverage'}
PRIVATE={'package-lock.json','npm-shrinkwrap.json','auth.json','credentials.json','secrets.json','tokens.json','config.local.json'}
NOTICES={'license','licence','notice','credits','attribution','ofl','ofl.txt','license.txt','licence.txt','notice.txt','credits.txt','attribution.txt','license.md','licence.md','notice.md','credits.md','attribution.md'}
def fail(): raise ValueError('peer_archive_invalid')
def stable(s):return(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_nlink)
def identity(s):return(s.st_dev,s.st_ino)
def directory(filename):
    if filename!=os.path.abspath(filename) or filename!=os.path.realpath(filename):fail()
    current=os.open('/',DIR);chain=[];fds=[current]
    try:
        for part in filename.split('/')[1:]:
            if not part or part in ('.','..'):fail()
            before=os.stat(part,dir_fd=current,follow_symlinks=False)
            child=os.open(part,DIR,dir_fd=current)
            if identity(before)!=identity(os.fstat(child)):os.close(child);fail()
            chain.append((current,part,child));fds.append(child);current=child
        return current,chain,fds
    except:
        for fd in reversed(fds):os.close(fd)
        raise
def verify(chain):
    for parent,name,child in chain:
        if identity(os.stat(name,dir_fd=parent,follow_symlinks=False))!=identity(os.fstat(child)):fail()
def private(fd):
    s=os.fstat(fd)
    if s.st_uid!=os.geteuid() or stat.S_IMODE(s.st_mode)&0o077:fail()
def read_source(source):
    if os.path.dirname(source['path'])!=q['sourceRoot']:fail()
    parent,chain,fds=directory(q['sourceRoot']);fd=None
    try:
        private(parent);name=os.path.basename(source['path']);before=os.stat(name,dir_fd=parent,follow_symlinks=False)
        fd=os.open(name,FILE,dir_fd=parent);s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or stable(s)!=stable(before) or s.st_size!=source['bytes'] or s.st_size>MAX:fail()
        private(fd);parts=[];remaining=s.st_size
        while remaining:
            data=os.read(fd,min(65536,remaining))
            if not data:fail()
            parts.append(data);remaining-=len(data)
        data=b''.join(parts)
        if os.read(fd,1) or hashlib.sha256(data).hexdigest()!=source['sha256'] or stable(s)!=stable(os.fstat(fd)) or stable(s)!=stable(os.stat(name,dir_fd=parent,follow_symlinks=False)):fail()
        verify(chain);return data
    finally:
        if fd is not None:os.close(fd)
        for item in reversed(fds):os.close(item)
def safe_path(name,directory_entry=False):
    if not isinstance(name,str) or not name or len(name.encode('utf8'))>512 or name.startswith('/') or '\\' in name or ':' in name or any(unicodedata.category(c).startswith('C') for c in name):fail()
    parts=name.rstrip('/').split('/')
    if len(parts)>24:fail()
    for part in parts:
        low=part.lower()
        if part in ('','.','..') or part.startswith('.') or low in BLOCK or low in PRIVATE or low.startswith(('credentials.','secrets.','tokens.','auth.','id_rsa','id_ed25519')) or low.endswith(('.private.json','.private.txt','.private.md')):fail()
    if not directory_entry:
        low=parts[-1].lower();ext=os.path.splitext(low)[1]
        notice=low in NOTICES or (low.startswith(('ofl-','license-','licence-','notice-','credits-','attribution-')) and ext in ('.txt','.md'))
        if ext not in ALLOW and not notice:fail()
    return parts
sources=q['sources']
if not sources or len(sources)>20 or sum(s['bytes'] for s in sources)>MAX:fail()
data=[read_source(s) for s in sources]
if q['operation']=='verify':print(json.dumps({'verified':True}));sys.exit(0)
entries=[];names=set();kinds={};spellings={};total=0
def register(name,is_dir,size):
    global total
    parts=safe_path(name,is_dir);key=unicodedata.normalize('NFC','/'.join(parts)).casefold()
    if key in names:fail()
    names.add(key)
    for i in range(1,len(parts)+1):
        spelling='/'.join(parts[:i]); folded=unicodedata.normalize('NFC',spelling).casefold()
        if folded in spellings and spellings[folded]!=spelling:fail()
        spellings[folded]=spelling
    if len(spellings)>8192:fail()
    if key in kinds and kinds[key]!=is_dir:fail()
    kinds[key]=is_dir
    for i in range(1,len(parts)):
        parent=unicodedata.normalize('NFC','/'.join(parts[:i])).casefold()
        if parent in kinds and not kinds[parent]:fail()
        kinds[parent]=True
    total+=size
    if size<0 or size>32*1024*1024 or total>100*1024*1024:fail()
    return parts
archive=None
if q['format']=='zip':
    if len(data)!=1:fail()
    archive=zipfile.ZipFile(io.BytesIO(data[0]));infos=archive.infolist()
    if not infos or len(infos)>4096:fail()
    for info in infos:
        mode=info.external_attr>>16
        if info.filename!=info.orig_filename or info.flag_bits&1 or info.compress_type not in (0,8) or stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR) or info.file_size>max(4096,info.compress_size)*100:fail()
        parts=register(info.filename,info.is_dir(),info.file_size)
        entries.append((parts,info.is_dir(),info.file_size,info))
else:
    for source,body in zip(sources,data):entries.append((register(source['name'],False,len(body)),False,len(body),body))
output,chain,fds=directory(q['output']);private(output);files=[]
try:
    if os.listdir(output):fail()
    for parts,is_dir,size,source in entries:
        current=os.dup(output)
        try:
            for part in parts if is_dir else parts[:-1]:
                try:os.mkdir(part,0o700,dir_fd=current)
                except FileExistsError:pass
                child=os.open(part,DIR,dir_fd=current);private(child);os.close(current);current=child
            if is_dir:continue
            fd=os.open(parts[-1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=current)
            stream=archive.open(source) if archive else io.BytesIO(source);count=0
            try:
                while True:
                    block=stream.read(65536)
                    if not block:break
                    count+=len(block)
                    if count>size or count>32*1024*1024:fail()
                    view=memoryview(block)
                    while view:view=view[os.write(fd,view):]
                if count!=size:fail()
                os.fsync(fd)
            finally:stream.close();os.close(fd)
            files.append('/'.join(parts))
        finally:os.close(current)
    verify(chain)
    if not files or q['entrypoint'] not in files:fail()
    print(json.dumps({'files':sorted(files)}))
finally:
    if archive:archive.close()
    for fd in reversed(fds):os.close(fd)
`;

async function fileOperation(
  request: unknown,
): Promise<{ verified?: boolean; files?: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-c', UNPACK], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    let output = '',
      failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill('SIGKILL');
    }, 30000);
    child.stdout.on('data', (data) => {
      output += data.toString('utf8');
      if (Buffer.byteLength(output) > 4 * 1024 * 1024) {
        failed = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', () => {
      clearTimeout(timer);
      reject(new FactoryError('peer_archive_unavailable'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failed || code !== 0)
        return reject(new FactoryError('peer_archive_invalid'));
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new FactoryError('peer_archive_invalid'));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
function sources(artifacts: Artifact[]) {
  return artifacts.map((a) => ({
    path: a.localPath,
    name: a.displayName || a.name,
    sha256: a.sha256,
    bytes: a.bytes,
  }));
}

export async function inspectFactoryPeerResult(
  actor: FactoryActor,
  input: { projectId: string; jobId: string },
  host: FactoryPeerResultHost = {},
): Promise<FactoryPeerResultInspection> {
  const before = await retainedResult(actor, input, host);
  await fileOperation({
    operation: 'verify',
    sourceRoot: before.sourceRoot,
    sources: sources(before.artifacts),
  });
  if ((await retainedResult(actor, input, host)).proof !== before.proof)
    throw new FactoryError('peer_result_changed');
  return before.inspection;
}

export async function importFactoryPeerResult(
  input: {
    actor: FactoryActor;
    projectId: string;
    jobId: string;
    artifactName?: string;
    entrypoint: string;
    destinationRoot: string;
  },
  host: FactoryPeerResultHost = {},
): Promise<
  FactoryManifest & {
    peerReceipt: {
      jobId: string;
      resultSha256: string;
      contextSha256: string;
      artifactSha256: string;
      artifactHashKind: 'file_bytes' | 'selected_manifest';
    };
    qualityAccepted: false;
  }
> {
  const before = await retainedResult(input.actor, input, host, true);
  const selected = input.artifactName
    ? before.artifacts.filter(
        (a) => (a.displayName || a.name) === input.artifactName,
      )
    : before.artifacts;
  if (!selected.length || (input.artifactName && selected.length !== 1))
    denied();
  if (
    !input.artifactName &&
    before.declaredFileNames.some(
      (name) =>
        !selected.some(
          (artifact) => (artifact.displayName || artifact.name) === name,
        ),
    )
  )
    throw new FactoryError('peer_result_incomplete');
  const zipped =
    !!input.artifactName && input.artifactName.toLowerCase().endsWith('.zip');
  if (
    !zipped &&
    selected.some((a) =>
      (a.displayName || a.name).toLowerCase().endsWith('.zip'),
    )
  )
    throw new FactoryError('select_peer_archive_explicitly');
  const temporary = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-peer-result-')),
  );
  fs.chmodSync(temporary, 0o700);
  const unpacked = path.join(temporary, 'unpacked');
  fs.mkdirSync(unpacked, { mode: 0o700 });
  try {
    const result = await fileOperation({
      operation: 'unpack',
      format: zipped ? 'zip' : 'files',
      sourceRoot: before.sourceRoot,
      sources: sources(selected),
      output: unpacked,
      entrypoint: input.entrypoint,
    });
    const manifest = await importFactorySourceAsync({
      sourceRoot: unpacked,
      entrypoint: input.entrypoint,
      allowedRoots: [temporary],
      destinationRoot: input.destinationRoot,
    });
    // A complete selected result must not silently lose excluded files.
    if (
      peerCanonicalJson(manifest.files.map((f) => f.path).sort()) !==
      peerCanonicalJson(result.files)
    )
      throw new FactoryError('peer_archive_incomplete');
    if (
      (await retainedResult(input.actor, input, host, true)).proof !==
      before.proof
    )
      throw new FactoryError('peer_result_changed');
    return {
      ...manifest,
      peerReceipt: {
        jobId: input.jobId,
        resultSha256: before.inspection.resultSha256,
        contextSha256: before.inspection.contextSha256,
        artifactSha256:
          selected.length === 1
            ? selected[0].sha256
            : digest(
                selected.map((a) => ({
                  name: a.displayName || a.name,
                  sha256: a.sha256,
                  bytes: a.bytes,
                })),
              ),
        artifactHashKind:
          selected.length === 1 ? 'file_bytes' : 'selected_manifest',
      },
      qualityAccepted: false,
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
