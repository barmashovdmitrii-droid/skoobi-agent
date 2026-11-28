import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runIsolatedArtifactJob } from './artifact-job.js';

import {
  validateArtifactAcceptanceRequirements,
  verifyArtifactAcceptanceReceipt,
  type ArtifactAcceptanceHost,
  type ArtifactAcceptanceReceipt,
  type ArtifactAcceptanceRequirements,
} from './artifact-acceptance.js';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';

/** Host administration only. No IPC accepts this contract or an asserted pass. */
export interface SkillVerificationContract {
  schema: 1;
  name: string;
  version: string;
  skillSha256: string;
  applicability: { folders: string[]; channels: string[]; triggers: string[] };
  provenance: 'operator-reviewed-synthetic';
  procedure: { path: string; sha256: string };
  dependencies: Array<{ path: string; sha256: string }>;
  cases: Array<{
    id: string;
    input: { path: string; sha256: string };
    requirements: ArtifactAcceptanceRequirements;
  }>;
}
export type SkillVerificationStatus =
  | 'unverified'
  | 'verified'
  | 'stale'
  | 'failed'
  | 'inconclusive';
export interface SkillVerificationResult {
  status: SkillVerificationStatus;
  code: string;
  /** A bounded example check never grants permission or proves general utility. */
  assurance: 'declared-procedure-and-cases-only';
  verifiedCases: number;
  knownFailures?: string[];
}
interface RecordData {
  schema: 1;
  generation: string;
  contract: SkillVerificationContract;
  status: 'registered' | 'checking' | 'verified' | 'failed' | 'inconclusive';
  code: string;
  nodeSha256?: string;
  evidence?: Array<{
    artifactPath: string;
    requirements: ArtifactAcceptanceRequirements;
    receipt: ArtifactAcceptanceReceipt;
  }>;
  work?: string;
  knownFailures?: string[];
}
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_SKILL = 16_384;
const sha = (bytes: Buffer | string): string =>
  crypto.createHash('sha256').update(bytes).digest('hex');
const result = (
  status: SkillVerificationStatus,
  code: string,
  verifiedCases = 0,
): SkillVerificationResult => ({
  status,
  code,
  verifiedCases,
  assurance: 'declared-procedure-and-cases-only',
});
const read = (filename: string, maxBytes: number): Buffer =>
  readBoundedRegularFileNoFollowSync(filename, {
    maxBytes,
    oversize: 'reject',
    requireSingleLink: true,
  }).buffer;
let nodeFingerprint: { stat: string; sha256: string } | undefined;
function nodeHash(host: ArtifactAcceptanceHost): string {
  const filename = protectedPath(process.execPath, host);
  const stat = fs.statSync(filename);
  const identity = JSON.stringify([
    filename,
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ]);
  if (nodeFingerprint?.stat !== identity)
    nodeFingerprint = {
      stat: identity,
      sha256: sha(read(filename, 256 * 1024 * 1024)),
    };
  return nodeFingerprint.sha256;
}
function inside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}
function protectedPath(filename: string, host: ArtifactAcceptanceHost): string {
  const real = fs.realpathSync(filename);
  if (
    host.agentWritableRoots.some((root) => inside(real, fs.realpathSync(root)))
  )
    throw new Error('untrusted_procedure_or_fixture');
  return real;
}
/** Only lifecycle fields differ between a reviewed draft and its active copy. */
export function skillVerificationDigest(markdown: string): string {
  const end = markdown.startsWith('---\n') ? markdown.indexOf('\n---', 4) : -1;
  if (end < 0) throw new Error('skill_frontmatter_required');
  return sha(
    markdown
      .slice(0, end)
      .split('\n')
      .filter((line) => !/^(?:status|verification):/.test(line))
      .join('\n') + markdown.slice(end),
  );
}
export function readSkillVerificationSource(
  skillsDir: string,
  name: string,
  proposal = false,
): string {
  if (!NAME.test(name)) throw new Error('invalid_skill');
  const base = fs.realpathSync(skillsDir);
  const parent = path.join(base, ...(proposal ? ['.proposals'] : []), name);
  if (!fs.lstatSync(parent).isDirectory() || fs.realpathSync(parent) !== parent)
    throw new Error('invalid_skill_path');
  if (
    proposal &&
    fs.realpathSync(path.join(base, '.proposals')) !==
      path.join(base, '.proposals')
  )
    throw new Error('invalid_skill_path');
  return read(path.join(parent, 'SKILL.md'), MAX_SKILL).toString('utf8');
}
function directory(host: ArtifactAcceptanceHost, create = false): string {
  // Pending drafts need durable host ownership before any checker is installed.
  // This registry contains no signing key and cannot mint artifact attestations.
  const roots = host.agentWritableRoots.map((root) => fs.realpathSync(root));
  const intended = path.resolve(host.stateDir);
  if (
    !roots.length ||
    roots.some((root) => inside(intended, root) || inside(root, intended))
  )
    throw new Error('unsafe_skill_state');
  if (create)
    fs.mkdirSync(path.dirname(intended), { recursive: true, mode: 0o700 });
  const parent = fs.realpathSync(path.dirname(intended));
  const base = path.join(parent, path.basename(intended));
  if (roots.some((root) => inside(base, root) || inside(root, base)))
    throw new Error('unsafe_skill_state');
  if (create && !fs.existsSync(base)) fs.mkdirSync(base, { mode: 0o700 });
  const baseStat = fs.lstatSync(base);
  if (
    !baseStat.isDirectory() ||
    baseStat.isSymbolicLink() ||
    baseStat.mode & 0o077 ||
    (process.getuid && baseStat.uid !== process.getuid())
  )
    throw new Error('unsafe_skill_state');
  const target = path.join(base, 'skill-verification');
  if (create && !fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error('unsafe_skill_state');
  return target;
}
function recordPath(root: string, name: string): string {
  if (!NAME.test(name)) throw new Error('invalid_skill');
  return path.join(root, `contract-${name}.json`);
}
function load(root: string, name: string): RecordData | undefined {
  const filename = recordPath(root, name);
  if (!fs.existsSync(filename)) return undefined;
  const value = JSON.parse(
    read(filename, 196_608).toString('utf8'),
  ) as RecordData;
  if (value.schema !== 1 || value.contract.name !== name)
    throw new Error('invalid_skill_state');
  validateContract(value.contract);
  return value;
}
function save(root: string, value: RecordData): void {
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > 196_608) throw new Error('skill_state_limit');
  const temporary = path.join(root, `.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, recordPath(root, value.contract.name));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function validateContract(value: SkillVerificationContract): void {
  const exact = (v: unknown, names: string[]): boolean =>
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).every((key) => names.includes(key));
  const strings = (xs: unknown, max = 16): xs is string[] =>
    Array.isArray(xs) &&
    xs.length <= max &&
    xs.every(
      (x) =>
        typeof x === 'string' &&
        x.length > 0 &&
        x.length <= 100 &&
        !/[\r\n\u0000]/.test(x),
    );
  const file = (v: { path: string; sha256: string }) =>
    exact(v, ['path', 'sha256']) &&
    typeof v.path === 'string' &&
    path.isAbsolute(v.path) &&
    v.path.length <= 1024 &&
    HASH.test(v.sha256);
  if (
    !exact(value, [
      'schema',
      'name',
      'version',
      'skillSha256',
      'applicability',
      'provenance',
      'procedure',
      'dependencies',
      'cases',
    ]) ||
    value.schema !== 1 ||
    !NAME.test(value.name) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.version) ||
    !HASH.test(value.skillSha256) ||
    value.provenance !== 'operator-reviewed-synthetic' ||
    !value.applicability ||
    !exact(value.applicability, ['folders', 'channels', 'triggers']) ||
    !strings(value.applicability.folders) ||
    !strings(value.applicability.channels) ||
    !strings(value.applicability.triggers) ||
    !file(value.procedure) ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > 8 ||
    !value.dependencies.every(file) ||
    !Array.isArray(value.cases) ||
    value.cases.length !== 2 ||
    value.cases.some(
      (c) =>
        !exact(c, ['id', 'input', 'requirements']) ||
        !NAME.test(c.id) ||
        !file(c.input) ||
        !validateArtifactAcceptanceRequirements(c.requirements),
    ) ||
    new Set(value.cases.map((c) => c.id)).size !== 2 ||
    new Set(value.cases.map((c) => c.input.sha256)).size !== 2
  )
    throw new Error('invalid_skill_contract');
}
function currentInputs(
  contract: SkillVerificationContract,
  host: ArtifactAcceptanceHost,
): { procedure: Buffer; inputs: Buffer[]; nodeSha256: string } {
  const checked = (
    item: { path: string; sha256: string },
    max: number,
  ): Buffer => {
    const bytes = read(protectedPath(item.path, host), max);
    if (sha(bytes) !== item.sha256) throw new Error('dependency_changed');
    return bytes;
  };
  const procedure = checked(contract.procedure, 65_536);
  // A reviewed self-contained bundle is the supported unit. This is a format
  // restriction, not an OS sandbox: the deployment boundary is still required.
  // No third-party imports, loaders, require, eval or dynamic compilation may
  // silently add code outside the checksummed bundle and Node installation.
  const source = procedure.toString('utf8');
  const withoutImports = source.replace(
    /\bimport\s+(?:[\w*{},\s]+\s+from\s+)?['"]node:(?:fs|path|crypto|zlib)['"]\s*;?/g,
    '',
  );
  if (
    /\b(?:import|require|eval|Function|createRequire|_load|binding|dlopen)\b/.test(
      withoutImports,
    ) ||
    /(?:__proto__|constructor|NODE_OPTIONS|child_process|process\s*\.\s*(?:mainModule|execArgv))/.test(
      source,
    )
  )
    throw new Error('unsupported_procedure_bundle');
  for (const dependency of contract.dependencies)
    checked(dependency, 4 * 1024 * 1024);
  const inputs = contract.cases.map((c) => checked(c.input, 16_384));
  // Fixtures are reviewed synthetic JSON. They are never copied into SKILL.md.
  inputs.forEach((input) => JSON.parse(input.toString('utf8')));
  const nodeSha256 = nodeHash(host);
  return { procedure, inputs, nodeSha256 };
}
function metadataMatches(
  markdown: string,
  contract: SkillVerificationContract,
): boolean {
  const header = markdown.slice(4, markdown.indexOf('\n---', 4));
  const scalar = (name: string) =>
    new RegExp(`^${name}:\\s*([^\\n]*)$`, 'm')
      .exec(header)?.[1]
      ?.replace(/^["']|["']$/g, '');
  const array = (name: string) =>
    (scalar(name) || '')
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((v) => v.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  return (
    skillVerificationDigest(markdown) === contract.skillSha256 &&
    scalar('name') === contract.name &&
    scalar('version') === contract.version &&
    ['folders', 'channels', 'triggers'].every(
      (key) =>
        JSON.stringify(array(key)) ===
        JSON.stringify(
          contract.applicability[
            key as keyof SkillVerificationContract['applicability']
          ],
        ),
    )
  );
}
/** Host must review exact generic skill text and both synthetic examples first. */
export function registerSkillVerification(options: {
  contract: SkillVerificationContract;
  markdown: string;
  host: ArtifactAcceptanceHost;
}): void {
  validateContract(options.contract);
  if (!metadataMatches(options.markdown, options.contract))
    throw new Error('skill_changed');
  currentInputs(options.contract, options.host);
  const root = directory(options.host, true);
  if (
    !load(root, options.contract.name) &&
    fs.readdirSync(root).filter((n) => n.startsWith('contract-')).length >= 32
  )
    throw new Error('skill_contract_limit');
  const prior = load(root, options.contract.name);
  save(root, {
    schema: 1,
    generation: crypto.randomUUID(),
    contract: structuredClone(options.contract),
    status: 'registered',
    code: 'verification_required',
  });
  if (prior?.work && inside(prior.work, root))
    fs.rmSync(prior.work, { recursive: true, force: true });
}
let running = false;
/** Two independent local executions, each followed by the actual host checker. */
export async function reproduceSkill(options: {
  name: string;
  markdown: string;
  host: ArtifactAcceptanceHost;
}): Promise<SkillVerificationResult> {
  if (running) return result('inconclusive', 'verification_busy');
  running = true;
  let root: string | undefined,
    record: RecordData | undefined,
    work: string | undefined;
  try {
    root = directory(options.host);
    record = load(root, options.name);
    if (!record) return result('unverified', 'contract_missing');
    if (!metadataMatches(options.markdown, record.contract))
      return result('stale', 'skill_changed');
    const oldWork = record.work;
    record = {
      ...record,
      generation: crypto.randomUUID(),
      status: 'checking',
      code: 'reproduction_interrupted',
      evidence: undefined,
      work: undefined,
    };
    save(root, record); // Invalidates an earlier pass BEFORE any new work.
    if (oldWork && inside(oldWork, root))
      fs.rmSync(oldWork, { recursive: true, force: true });
    const inputs = currentInputs(record.contract, options.host);
    if (fs.readdirSync(root).filter((n) => n.startsWith('run-')).length >= 64)
      throw new Error('verification_storage_limit');
    work = fs.mkdtempSync(path.join(root, 'run-'));
    fs.chmodSync(work, 0o700);
    record.work = work;
    record.nodeSha256 = inputs.nodeSha256;
    save(root, record);
    const procedure = path.join(work, 'procedure.mjs');
    const skill = path.join(work, 'SKILL.md');
    fs.writeFileSync(procedure, inputs.procedure, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(skill, options.markdown, { flag: 'wx', mode: 0o600 });
    const evidence: NonNullable<RecordData['evidence']> = [];
    for (const [index, example] of record.contract.cases.entries()) {
      const destination = path.join(work, `case-${index}`);
      fs.mkdirSync(destination, { mode: 0o700 });
      const input = path.join(destination, 'input.json');
      const artifactName =
        example.requirements.kind === 'browser-archive'
          ? 'artifact.zip'
          : 'artifact.pdf';
      const artifact = path.join(destination, artifactName);
      fs.writeFileSync(input, inputs.inputs[index], {
        flag: 'wx',
        mode: 0o600,
      });
      const checked = await runIsolatedArtifactJob({
        host: options.host,
        requirements: example.requirements,
        producer: {
          executable: process.execPath,
          args: [
            '--max-old-space-size=128',
            'inputs/procedure.mjs',
            'inputs/input.json',
            'inputs/SKILL.md',
            `output/${artifactName}`,
          ],
        },
        inputs: [
          { sourcePath: procedure, relativePath: 'procedure.mjs' },
          { sourcePath: input, relativePath: 'input.json' },
          { sourcePath: skill, relativePath: 'SKILL.md' },
        ],
        artifactRelativePath: `output/${artifactName}`,
        timeoutMs: 10_000,
      });
      try {
        if (
          checked.status !== 'passed' ||
          !checked.receipt ||
          !checked.artifactPath
        )
          throw new Error(
            checked.status === 'failed'
              ? 'example_failed'
              : [
                    'isolation_preflight_failed',
                    'isolation_unavailable',
                    'isolation_platform_unsupported',
                    'artifact_job_busy',
                    'artifact_job_unavailable',
                    'producer_failed',
                  ].includes(checked.code)
                ? checked.code
                : 'checker_inconclusive',
          );
        const bytes = read(checked.artifactPath, 16 * 1024 * 1024);
        if (sha(bytes) !== checked.receipt.payload.artifact.sha256)
          throw new Error('example_failed');
        fs.writeFileSync(artifact, bytes, { flag: 'wx', mode: 0o600 });
        evidence.push({
          artifactPath: artifact,
          requirements: example.requirements,
          receipt: checked.receipt,
        });
      } finally {
        checked.cleanup?.();
      }
    }
    if (
      new Set(evidence.map((e) => e.receipt.payload.artifact.sha256)).size !== 2
    )
      throw new Error('examples_not_independent');
    if (
      currentInputs(record.contract, options.host).nodeSha256 !==
      inputs.nodeSha256
    )
      throw new Error('dependency_changed');
    if (load(root, options.name)?.generation !== record.generation)
      return result('stale', 'contract_changed');
    record.status = 'verified';
    record.code = 'two_examples_reproduced';
    record.evidence = evidence;
    save(root, record);
    work = undefined; // Retained privately for signed receipt freshness checks.
    return result('verified', record.code, 2);
  } catch (error) {
    const code =
      error instanceof Error &&
      [
        'procedure_failed',
        'example_failed',
        'examples_not_independent',
        'dependency_changed',
        'checker_inconclusive',
        'unsupported_procedure_bundle',
        'isolation_preflight_failed',
        'isolation_unavailable',
        'isolation_platform_unsupported',
        'artifact_job_busy',
        'artifact_job_unavailable',
        'producer_failed',
      ].includes(error.message)
        ? error.message
        : 'verification_unavailable';
    const status = [
      'procedure_failed',
      'example_failed',
      'examples_not_independent',
    ].includes(code)
      ? 'failed'
      : 'inconclusive';
    if (
      root &&
      record &&
      load(root, options.name)?.generation === record.generation
    ) {
      record.status = status;
      record.code = code;
      record.evidence = undefined;
      record.work = undefined;
      record.knownFailures = [
        ...new Set([...(record.knownFailures || []), code]),
      ].slice(-8);
      save(root, record);
    }
    return result(status, code);
  } finally {
    running = false;
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
}
export function inspectSkillVerification(options: {
  name: string;
  markdown: string;
  host: ArtifactAcceptanceHost;
}): SkillVerificationResult {
  try {
    const root = directory(options.host);
    const record = load(root, options.name);
    if (!record) {
      const legacyPath = path.join(root, `legacy-${options.name}.json`);
      if (NAME.test(options.name) && fs.existsSync(legacyPath)) {
        const legacy = JSON.parse(read(legacyPath, 1024).toString('utf8'));
        return legacy.schema === 1 &&
          legacy.name === options.name &&
          legacy.sha256 === skillVerificationDigest(options.markdown)
          ? result('unverified', 'legacy_operator_adopted')
          : result('stale', 'legacy_skill_changed');
      }
      return result('unverified', 'contract_missing');
    }
    if (!metadataMatches(options.markdown, record.contract))
      return result('stale', 'skill_changed');
    if (record.status !== 'verified' || record.evidence?.length !== 2)
      return {
        ...result(
          record.status === 'failed' ? 'failed' : 'inconclusive',
          record.code,
        ),
        knownFailures: record.knownFailures || [],
      };
    if (
      currentInputs(record.contract, options.host).nodeSha256 !==
      record.nodeSha256
    )
      return result('stale', 'dependency_changed');
    for (const evidence of record.evidence) {
      const checked = verifyArtifactAcceptanceReceipt({
        ...evidence,
        host: options.host,
      });
      if (checked.status !== 'passed') return result('stale', checked.code);
    }
    return {
      ...result('verified', 'two_examples_reproduced', 2),
      knownFailures: record.knownFailures || [],
    };
  } catch {
    return result('stale', 'dependency_or_evidence_unavailable');
  }
}
/** Removing a model-writable frontmatter marker cannot bypass a host contract. */
export function hasSkillVerificationContract(
  name: string,
  host: ArtifactAcceptanceHost,
): boolean {
  if (!fs.existsSync(path.join(host.stateDir, 'skill-verification')))
    return false;
  try {
    const root = directory(host);
    return (
      !!load(root, name) ||
      fs.existsSync(path.join(root, `pending-${name}.json`)) ||
      fs.existsSync(path.join(root, `legacy-${name}.json`))
    );
  } catch {
    return true;
  } // Corrupt/inaccessible host state never revives a candidate.
}
export function markSkillProposalPending(
  name: string,
  host: ArtifactAcceptanceHost,
): void {
  if (!NAME.test(name)) throw new Error('invalid_skill');
  const root = directory(host, true);
  const filename = path.join(root, `pending-${name}.json`);
  if (fs.existsSync(filename)) {
    read(filename, 1024);
    return;
  }
  if (
    fs.readdirSync(root).filter((n) => n.startsWith('pending-')).length >= 256
  )
    throw new Error('skill_proposal_limit');
  fs.writeFileSync(
    filename,
    JSON.stringify({ schema: 1, name, status: 'requires_verification' }),
    { flag: 'wx', mode: 0o600 },
  );
}
/** Explicit controlled cutover only; never inferred from a file's age or author. */
export function adoptLegacySkillVerification(options: {
  name: string;
  markdown: string;
  host: ArtifactAcceptanceHost;
}): void {
  if (
    !NAME.test(options.name) ||
    !/^status:\s*active$/m.test(
      options.markdown.slice(0, options.markdown.indexOf('\n---', 4)),
    )
  )
    throw new Error('active_legacy_skill_required');
  const root = directory(options.host, true);
  if (
    load(root, options.name) ||
    fs.existsSync(path.join(root, `pending-${options.name}.json`))
  )
    throw new Error('new_proposal_cannot_be_legacy');
  const filename = path.join(root, `legacy-${options.name}.json`);
  const data = JSON.stringify({
    schema: 1,
    name: options.name,
    sha256: skillVerificationDigest(options.markdown),
  });
  if (fs.existsSync(filename)) {
    if (read(filename, 1024).toString('utf8') !== data)
      throw new Error('legacy_baseline_changed');
    return;
  }
  if (
    fs.readdirSync(root).filter((name) => name.startsWith('legacy-')).length >=
    256
  )
    throw new Error('legacy_skill_limit');
  fs.writeFileSync(filename, data, { flag: 'wx', mode: 0o600 });
}
/** Records only a finite host-observed failure; model claims cannot call this API. */
export function invalidateSkillVerification(options: {
  name: string;
  host: ArtifactAcceptanceHost;
  reason: 'observed_failure' | 'dependency_changed';
}): void {
  const root = directory(options.host);
  const record = load(root, options.name);
  if (!record) return;
  record.generation = crypto.randomUUID();
  record.status = 'failed';
  record.code = options.reason;
  record.knownFailures = [
    ...new Set([...(record.knownFailures || []), options.reason]),
  ].slice(-8);
  save(root, record);
}
