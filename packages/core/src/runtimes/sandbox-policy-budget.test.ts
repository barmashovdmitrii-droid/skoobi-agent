import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSandboxPolicyInputs,
  encodeSandboxPolicy,
  persistSandboxPolicy,
  sandboxPolicyRefusal,
  sandboxPolicyLimitReason,
} from './sandbox-policy-budget.js';

const limits = {
  listEntries: 3,
  totalEntries: 9,
  entryBytes: 40,
  policyBytes: 1024,
};
const policy = () => ({
  filesystem: {
    allowRead: ['/界'],
    denyRead: ['/a"b'],
    allowWrite: [] as string[],
    denyWrite: [] as string[],
  },
  network: {
    allowedDomains: ['api.anthropic.com'],
    deniedDomains: [] as string[],
    allowLocalBinding: true,
  },
});

describe('sandbox policy budgets', () => {
  it('counts each of the six policy lists and never truncates on refusal', () => {
    for (const key of [
      'allowRead',
      'denyRead',
      'allowWrite',
      'denyWrite',
      'allowedDomains',
      'deniedDomains',
    ] as const) {
      const settings = policy();
      const target = { ...settings.filesystem, ...settings.network }[key];
      target.splice(0, target.length, 'one', 'two', 'three', 'four');
      const before = structuredClone(settings);
      expect(() => encodeSandboxPolicy(settings, limits)).toThrow(
        'list_entries',
      );
      expect(settings).toEqual(before);
    }
  });
  it('counts across lists, raw mount and combined domain sources before deduplication', () => {
    expect(() =>
      encodeSandboxPolicy(policy(), { ...limits, totalEntries: 2 }),
    ).toThrow('total_entries');
    expect(() =>
      assertSandboxPolicyInputs(Array(4).fill({ hostPath: '/a' }), [], limits),
    ).toThrow('list_entries');
    expect(() =>
      assertSandboxPolicyInputs(
        [],
        [
          ['a', 'a'],
          ['a', 'a'],
        ],
        limits,
      ),
    ).toThrow('list_entries');
    expect(() =>
      assertSandboxPolicyInputs([{ hostPath: '/a' }], [['a', 'b']], {
        ...limits,
        totalEntries: 2,
      }),
    ).toThrow('total_entries');
    expect(() =>
      assertSandboxPolicyInputs([{ hostPath: '/界' }], [['x']], {
        ...limits,
        entryBytes: 3,
      }),
    ).toThrow('entry_bytes');
  });
  it('counts UTF-8 bytes of an entry and the exact indented and escaped encoding', () => {
    const settings = policy();
    settings.network.allowedDomains = ['a'];
    const bytes = Buffer.from(JSON.stringify(settings, null, 2));
    expect(
      encodeSandboxPolicy(settings, {
        ...limits,
        entryBytes: 4,
        policyBytes: bytes.length,
      }),
    ).toEqual(bytes);
    expect(() =>
      encodeSandboxPolicy(settings, { ...limits, entryBytes: 3 }),
    ).toThrow('entry_bytes');
    expect(() =>
      encodeSandboxPolicy(settings, {
        ...limits,
        policyBytes: bytes.length - 1,
      }),
    ).toThrow('policy_bytes');
  });
  it('marks only host-created preflight errors', () => {
    const refused = sandboxPolicyRefusal('entry_bytes');
    expect(sandboxPolicyLimitReason(refused)).toBe('entry_bytes');
    expect(sandboxPolicyLimitReason({ ...refused })).toBeUndefined();
    expect(sandboxPolicyLimitReason(null)).toBeUndefined();
  });
});

describe('sandbox policy round trip', () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  it('persists exactly the checked policy and refuses to replace a previous file', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sandbox-policy-'));
    const file = path.join(dir, 'policy.json');
    const encoded = encodeSandboxPolicy(policy(), limits);
    persistSandboxPolicy(file, encoded);
    expect(fs.readFileSync(file)).toEqual(encoded);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => persistSandboxPolicy(file, Buffer.from('x'))).toThrow();
    expect(fs.readFileSync(file)).toEqual(encoded);
  });
  it('rejects a changed policy and removes the failed file', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sandbox-policy-'));
    const file = path.join(dir, 'policy.json');
    const original = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((fd) =>
      original(fd, 'y'),
    );
    expect(() => persistSandboxPolicy(file, Buffer.from('x'))).toThrow(
      'changed',
    );
    expect(fs.existsSync(file)).toBe(false);
  });
});
