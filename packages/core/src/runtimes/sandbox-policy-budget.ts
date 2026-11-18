import fs from 'node:fs';
import { readBoundedRegularFileNoFollowSync } from '../orchestrator/safe-file-read.js';
import type { ContainerOutput } from './container-runner.js';
import type { SandboxSettings } from './sandbox-runner.js';

export type SandboxPolicyLimitReason =
  | 'list_entries'
  | 'total_entries'
  | 'entry_bytes'
  | 'policy_bytes';

export interface SandboxPolicyLimits {
  readonly listEntries: number;
  readonly totalEntries: number;
  readonly entryBytes: number;
  readonly policyBytes: number;
}

export const SANDBOX_POLICY_LIMITS: SandboxPolicyLimits = Object.freeze({
  listEntries: 1024,
  totalEntries: 4096,
  entryBytes: 4096,
  policyBytes: 256 * 1024,
});

export class SandboxPolicyLimitError extends Error {
  constructor(readonly reason: SandboxPolicyLimitReason) {
    super('Sandbox policy limit exceeded: ' + reason);
  }
}

// The host marks its own pre-spawn outcome. Output parsed from a child can
// have identical text or properties without gaining this delivery authority.
const refusals = new WeakMap<object, SandboxPolicyLimitReason>();

export function sandboxPolicyRefusal(
  reason: SandboxPolicyLimitReason,
): ContainerOutput {
  const result: ContainerOutput = {
    status: 'error',
    result: null,
    error: 'Sandbox policy limit exceeded: ' + reason,
  };
  refusals.set(result, reason);
  return result;
}

export function sandboxPolicyLimitReason(
  output: unknown,
): SandboxPolicyLimitReason | undefined {
  return output !== null && typeof output === 'object'
    ? refusals.get(output)
    : undefined;
}

function itemBytes(value: string, limits: SandboxPolicyLimits): number {
  if (typeof value !== 'string')
    throw new Error('Invalid sandbox policy entry');
  // The UTF-8 length is at least the UTF-16 code-unit count.
  if (value.length > limits.entryBytes)
    throw new SandboxPolicyLimitError('entry_bytes');
  const bytes = Buffer.byteLength(value);
  if (bytes > limits.entryBytes)
    throw new SandboxPolicyLimitError('entry_bytes');
  return bytes;
}

function assertSandboxPolicyCounts(
  lengths: readonly number[],
  limits: SandboxPolicyLimits,
): void {
  let total = 0;
  for (const length of lengths) {
    if (length > limits.listEntries)
      throw new SandboxPolicyLimitError('list_entries');
    total += length;
  }
  if (total > limits.totalEntries)
    throw new SandboxPolicyLimitError('total_entries');
}

// Check raw inputs before spreading, normalizing or comparing domain/path
// lists. Duplicate and filtered values still consume work during assembly.
export function assertSandboxPolicyInputs(
  mounts: readonly { hostPath: string }[],
  domainSources: readonly (readonly string[])[],
  limits: SandboxPolicyLimits = SANDBOX_POLICY_LIMITS,
): void {
  const domains = domainSources.reduce(
    (count, source) => count + source.length,
    0,
  );
  if (mounts.length > limits.listEntries || domains > limits.listEntries)
    throw new SandboxPolicyLimitError('list_entries');
  if (mounts.length + domains > limits.totalEntries)
    throw new SandboxPolicyLimitError('total_entries');
  let bytes = 0;
  function count(value: string): void {
    bytes += itemBytes(value, limits);
    if (bytes > limits.policyBytes)
      throw new SandboxPolicyLimitError('policy_bytes');
  }
  for (const mount of mounts) count(mount.hostPath);
  for (const source of domainSources)
    for (const domain of source) count(domain);
}

export function encodeSandboxPolicy(
  settings: SandboxSettings,
  limits: SandboxPolicyLimits = SANDBOX_POLICY_LIMITS,
): Buffer {
  const { network, filesystem } = settings;
  const lists = [
    network.allowedDomains,
    network.deniedDomains,
    filesystem.allowRead,
    filesystem.denyRead,
    filesystem.allowWrite,
    filesystem.denyWrite,
  ];
  assertSandboxPolicyCounts(
    lists.map((list) => list.length),
    limits,
  );
  let bytes = 0;
  for (const list of lists) {
    for (const value of list) {
      bytes += itemBytes(value, limits);
      if (bytes > limits.policyBytes)
        throw new SandboxPolicyLimitError('policy_bytes');
    }
  }
  // The wire budget includes formatting, JSON escapes and UTF-8 encoding.
  const json = JSON.stringify(settings, null, 2);
  if (Buffer.byteLength(json) > limits.policyBytes)
    throw new SandboxPolicyLimitError('policy_bytes');
  return Buffer.from(json);
}

export function persistSandboxPolicy(file: string, encoded: Buffer): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, encoded);
    } finally {
      fs.closeSync(fd);
    }
    const observed = readBoundedRegularFileNoFollowSync(file, {
      maxBytes: encoded.length,
      oversize: 'reject',
      requireSingleLink: true,
    });
    if (!observed.buffer.equals(encoded))
      throw new Error('Sandbox settings changed after validation');
  } catch (err) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* The file may already be gone. */
    }
    throw err;
  }
}
