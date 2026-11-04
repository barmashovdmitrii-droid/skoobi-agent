import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  artifactAcceptanceHostDirectory,
  calculationAcceptanceSourcesCurrent,
  createArtifactAcceptanceScratch,
  loadArtifactAcceptanceReceipt,
  runArtifactAcceptance,
  validateArtifactAcceptanceRequirements,
  verifyArtifactAcceptanceReceipt,
  type ArtifactAcceptanceHost,
  type ArtifactAcceptanceReceipt,
  type ArtifactAcceptanceRequirements,
  type ArtifactAcceptanceRun,
  type ArtifactAcceptanceVerification,
} from './artifact-acceptance.js';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';

interface ArtifactContract {
  schema: 1;
  artifactPath: string;
  requestedPath: string;
  requirements: ArtifactAcceptanceRequirements;
  receiptId?: string;
}
export interface ArtifactDeliveryDecision {
  required: boolean;
  status: ArtifactAcceptanceVerification['status'] | 'not_required';
  code: string;
  snapshotPath?: string;
  cleanup?: () => void;
}

function registryDirectory(
  host: ArtifactAcceptanceHost,
  create = false,
): string {
  // A host registry is not a producer-isolation claim.
  return artifactAcceptanceHostDirectory(host, create);
}

/** Attach only an authentic host-issued result for these exact bytes and criteria. */
export function bindRegisteredArtifactAcceptanceReceipt(options: {
  artifactPath: string;
  receipt: unknown;
  host: ArtifactAcceptanceHost;
}): ArtifactAcceptanceVerification {
  const unavailable = (code: string): ArtifactAcceptanceVerification => ({
    status: 'inconclusive',
    code,
    humanAcceptance: 'not_recorded',
  });
  try {
    const directory = registryDirectory(options.host);
    const contract = readContract(directory, options.artifactPath);
    if (!contract) return unavailable('contract_missing');
    const verified = verifyArtifactAcceptanceReceipt({
      artifactPath: options.artifactPath,
      requirements: contract.requirements,
      receipt: options.receipt,
      host: options.host,
    });
    if (verified.status !== 'passed' && verified.status !== 'failed')
      return verified;
    const receipt = options.receipt as ArtifactAcceptanceReceipt;
    const retained = loadArtifactAcceptanceReceipt(
      receipt.payload.id,
      options.host,
    );
    if (!retained || retained.signature !== receipt.signature)
      return unavailable('receipt_unavailable');
    const current = readContract(directory, options.artifactPath);
    if (
      !current ||
      JSON.stringify(current.requirements) !==
        JSON.stringify(contract.requirements)
    )
      return unavailable('contract_changed');
    writeContract(directory, { ...contract, receiptId: receipt.payload.id });
    return verified;
  } catch {
    return unavailable('acceptance_unavailable');
  }
}
const contractName = (artifactPath: string): string =>
  `contract-${crypto.createHash('sha256').update(artifactPath).digest('hex')}.json`;

function writeContract(directory: string, contract: ArtifactContract): void {
  const data = JSON.stringify(contract);
  if (data.length > 16_384) throw new Error('contract_limit');
  const names = new Set(
    [contract.artifactPath, contract.requestedPath].map(contractName),
  );
  const existing = fs
    .readdirSync(directory)
    .filter((name) => /^contract-[a-f0-9]{64}\.json$/.test(name));
  if (new Set([...existing, ...names]).size > 128)
    throw new Error('contract_limit');
  for (const name of names) {
    const target = path.join(directory, name);
    if (fs.existsSync(target) && !fs.lstatSync(target).isFile())
      throw new Error('contract_invalid');
    const temporary = path.join(
      directory,
      `.contract-${crypto.randomUUID()}.tmp`,
    );
    try {
      fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
function readContract(
  directory: string,
  filename: string,
): ArtifactContract | undefined {
  const requested = path.resolve(filename);
  const candidates = [requested];
  try {
    candidates.push(fs.realpathSync(requested));
  } catch {
    /* Preserve a required missing-file contract. */
  }
  for (const candidate of new Set(candidates)) {
    const contractPath = path.join(directory, contractName(candidate));
    if (!fs.existsSync(contractPath)) continue;
    const value = JSON.parse(
      readBoundedRegularFileNoFollowSync(contractPath, {
        maxBytes: 16_384,
        oversize: 'reject',
        requireSingleLink: true,
      }).buffer.toString('utf8'),
    ) as ArtifactContract;
    if (
      value.schema !== 1 ||
      ![value.artifactPath, value.requestedPath].includes(candidate) ||
      !validateArtifactAcceptanceRequirements(value.requirements) ||
      (value.receiptId !== undefined &&
        !/^[a-f0-9-]{36}$/.test(value.receiptId))
    )
      throw new Error('contract_invalid');
    return value;
  }
  return undefined;
}

/** Host CLI/config only: no model-facing IPC endpoint creates or relaxes a contract. */
export function registerArtifactAcceptanceContract(options: {
  artifactPath: string;
  requirements: ArtifactAcceptanceRequirements;
  host: ArtifactAcceptanceHost;
}): void {
  if (!validateArtifactAcceptanceRequirements(options.requirements))
    throw new Error('requirements_invalid');
  if (
    options.requirements.kind === 'calculation-v1' &&
    !calculationAcceptanceSourcesCurrent(options.requirements)
  )
    throw new Error('source_changed');
  const directory = registryDirectory(options.host, true);
  // A final symlink or special file cannot become a registered artifact.
  readBoundedRegularFileNoFollowSync(options.artifactPath, {
    maxBytes: 16 * 1024 * 1024,
    oversize: 'reject',
    requireSingleLink: true,
  });
  const contract: ArtifactContract = {
    schema: 1,
    artifactPath: fs.realpathSync(options.artifactPath),
    requestedPath: path.resolve(options.artifactPath),
    requirements: structuredClone(options.requirements),
  };
  writeContract(directory, contract); // Changed requirements deliberately clear the old receipt.
}

/** Legacy direct-check entry: without a real producer token it cannot sign. */
export async function checkRegisteredArtifactAcceptance(options: {
  artifactPath: string;
  host: ArtifactAcceptanceHost;
}): Promise<ArtifactAcceptanceRun> {
  try {
    const directory = registryDirectory(options.host);
    const contract = readContract(directory, options.artifactPath);
    if (!contract) return { status: 'inconclusive', code: 'contract_missing' };
    const result = await runArtifactAcceptance({
      artifactPath: options.artifactPath,
      requirements: contract.requirements,
      host: options.host,
    });
    // Do not attach a result to criteria that changed while the checker ran.
    const current = readContract(directory, options.artifactPath);
    if (
      !current ||
      JSON.stringify(current.requirements) !==
        JSON.stringify(contract.requirements)
    ) {
      return { status: 'inconclusive', code: 'contract_changed' };
    }
    // An unavailable unisolated check must not erase a previously valid result.
    if (result.receipt)
      writeContract(directory, {
        ...contract,
        receiptId: result.receipt.payload.id,
      });
    return result;
  } catch {
    return { status: 'inconclusive', code: 'acceptance_unavailable' };
  }
}

/**
 * Delivery must use snapshotPath and call cleanup in finally. Rechecking the
 * mutable original before an asynchronous transport open is not sufficient.
 * Unregistered artifacts retain ordinary delivery; this is not a global gate.
 */
export function createArtifactAcceptanceDeliveryPolicy(
  host: ArtifactAcceptanceHost,
): (artifactPath: string) => Promise<ArtifactDeliveryDecision> {
  return async (artifactPath) => {
    let temporary: string | undefined;
    try {
      if (!fs.existsSync(host.stateDir))
        return {
          required: false,
          status: 'not_required',
          code: 'contract_missing',
        };
      const directory = registryDirectory(host);
      const contract = readContract(directory, artifactPath);
      if (!contract)
        return {
          required: false,
          status: 'not_required',
          code: 'contract_missing',
        };
      if (!contract.receiptId)
        return {
          required: true,
          status: 'inconclusive',
          code: 'receipt_missing',
        };
      const receipt = loadArtifactAcceptanceReceipt(contract.receiptId, host);
      if (!receipt)
        return {
          required: true,
          status: 'inconclusive',
          code: 'receipt_unavailable',
        };
      // A protected copy becomes the actual transport input, closing the mutable
      // workspace race without holding an untrusted pathname open across awaits.
      const bytes = readBoundedRegularFileNoFollowSync(artifactPath, {
        maxBytes: 16 * 1024 * 1024,
        oversize: 'reject',
        requireSingleLink: true,
      }).buffer;
      temporary = createArtifactAcceptanceScratch(directory, 'delivery');
      const snapshotPath = path.join(
        temporary,
        path.basename(contract.artifactPath),
      );
      fs.writeFileSync(snapshotPath, bytes, { flag: 'wx', mode: 0o600 });
      const verified = verifyArtifactAcceptanceReceipt({
        artifactPath: snapshotPath,
        requirements: contract.requirements,
        receipt,
        host,
      });
      if (verified.status !== 'passed') {
        fs.rmSync(temporary, { recursive: true, force: true });
        temporary = undefined;
        return { required: true, status: verified.status, code: verified.code };
      }
      const owned = temporary;
      temporary = undefined;
      return {
        required: true,
        status: 'passed',
        code: 'checks_passed',
        snapshotPath,
        cleanup: () => fs.rmSync(owned, { recursive: true, force: true }),
      };
    } catch {
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
      return {
        required: true,
        status: 'inconclusive',
        code: 'acceptance_unavailable',
      };
    }
  };
}
