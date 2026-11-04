import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  inspectSkillVerification,
  invalidateSkillVerification,
  registerSkillVerification,
  reproduceSkill,
  skillVerificationDigest,
  adoptLegacySkillVerification,
  type SkillVerificationContract,
} from './skill-verification.js';
import {
  approveVerifiedSkill,
  listSkills,
  proposeSkill,
  selectSkills,
} from './skill-registry.js';
import {
  runArtifactAcceptance,
  type ArtifactAcceptanceHost,
  type BrowserArtifactAcceptanceRequirements,
} from './artifact-acceptance.js';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-proof-'));
const workspace = path.join(temporary, 'producer');
const trusted = path.join(temporary, 'reviewed');
const skills = path.join(temporary, 'skills');
for (const directory of [workspace, trusted, skills])
  fs.mkdirSync(directory, { mode: 0o700 });
afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));
const hash = (bytes: string | Buffer) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
const host: ArtifactAcceptanceHost = {
  stateDir: path.join(temporary, 'host'),
  agentWritableRoots: [workspace],
  checkerPath: path.resolve('scripts/artifact-acceptance-checker.mjs'),
  boundary: 'owner-full-access',
};
const procedurePath = path.join(trusted, 'package.mjs');
// Reviewed single-file procedure: two independently supplied synthetic labels
// produce distinct real archives. No external program, library or model report.
const procedure = String.raw`import fs from 'node:fs';
const [input, skill, output] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(input, 'utf8'));
if (!fs.readFileSync(skill, 'utf8').includes('Build the local package')) throw Error('skill');
const files = [['index.html','<!doctype html><meta charset="utf-8"><p id="status">'+data.label+'</p><a id="go" href="done.html">Go</a>'],['done.html','<!doctype html><p id="status">done</p>']];
const locals = [], centrals = []; let offset = 0;
for (const [name, text] of files) {
const content = Buffer.from(text);
const filename = Buffer.from(name);
let crc = 0xffffffff;
for (const byte of content) { crc ^= byte; for(let j=0;j<8;j++) crc = (crc>>>1)^((crc&1)?0xedb88320:0); }
crc = (crc ^ 0xffffffff) >>> 0;
const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt32LE(crc,14); local.writeUInt32LE(content.length,18); local.writeUInt32LE(content.length,22); local.writeUInt16LE(filename.length,26);
const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt32LE(crc,16); central.writeUInt32LE(content.length,20); central.writeUInt32LE(content.length,24); central.writeUInt16LE(filename.length,28);
central.writeUInt32LE(offset,42); const entry=Buffer.concat([local,filename,content]); locals.push(entry); centrals.push(Buffer.concat([central,filename])); offset+=entry.length;
}
const central=Buffer.concat(centrals);
const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(2,8); end.writeUInt16LE(2,10); end.writeUInt32LE(central.length,12); end.writeUInt32LE(offset,16);
fs.writeFileSync(output, Buffer.concat([...locals,central,end]), { flag:'wx' });
`;
fs.writeFileSync(procedurePath, procedure, { mode: 0o600 });
const inputPaths = ['alpha', 'beta'].map((label, index) => {
  const filename = path.join(trusted, `case-${index}.json`);
  fs.writeFileSync(filename, JSON.stringify({ label: `synthetic-${label}` }), {
    mode: 0o600,
  });
  return filename;
});
const proposed = proposeSkill({
  skillsDir: skills,
  verificationHost: host,
  frontmatter: {
    name: 'package-pilot',
    description: 'Build a local synthetic package.',
    version: '1.0.0',
    folders: ['demo'],
    channels: ['tg'],
    triggers: ['package'],
  },
  body: 'Build the local package from the supplied generic input. Open it and check the button. This instruction grants no authority for external actions.',
});
const markdown = fs.readFileSync(proposed.path, 'utf8');
const criteria = (label: string): BrowserArtifactAcceptanceRequirements => ({
  schema: 1,
  kind: 'browser-archive',
  entrypoint: 'index.html',
  initial: { selector: '#status', text: label },
  steps: [
    {
      action: 'click',
      selector: '#go',
      expect: { selector: '#status', text: 'done' },
    },
  ],
});
const contract: SkillVerificationContract = {
  schema: 1,
  name: 'package-pilot',
  version: '1.0.0',
  skillSha256: skillVerificationDigest(markdown),
  applicability: { folders: ['demo'], channels: ['tg'], triggers: ['package'] },
  provenance: 'operator-reviewed-synthetic',
  procedure: { path: procedurePath, sha256: hash(procedure) },
  dependencies: [],
  cases: inputPaths.map((filename, index) => ({
    id: `case-${index}`,
    input: { path: filename, sha256: hash(fs.readFileSync(filename)) },
    requirements: criteria(`synthetic-${index ? 'beta' : 'alpha'}`),
  })),
};

describe('host skill contracts reject self-attestation and uncontrolled code', () => {
  it('requires independent fixtures, exact version/applicability and protected code', () => {
    const check = (value: SkillVerificationContract) =>
      registerSkillVerification({ contract: value, markdown, host });
    expect(() =>
      check({ ...contract, cases: [contract.cases[0], contract.cases[0]] }),
    ).toThrow();
    expect(() => check({ ...contract, version: '2.0.0' })).toThrow();
    expect(() =>
      check({
        ...contract,
        applicability: { ...contract.applicability, folders: [] },
      }),
    ).toThrow();
    const writable = path.join(workspace, 'procedure.mjs');
    fs.writeFileSync(writable, procedure);
    expect(() =>
      check({
        ...contract,
        procedure: { path: writable, sha256: hash(procedure) },
      }),
    ).toThrow('untrusted');
    const dynamic = path.join(trusted, 'dynamic.mjs');
    fs.writeFileSync(dynamic, 'await import(process.argv[2]);');
    expect(() =>
      check({
        ...contract,
        procedure: { path: dynamic, sha256: hash(fs.readFileSync(dynamic)) },
      }),
    ).toThrow('unsupported_procedure');
  });
  it('does not approve a draft from usage counters or a forged verification file', () => {
    fs.writeFileSync(
      path.join(skills, '.usage.json'),
      JSON.stringify({ 'package-pilot': { use_count: 9999, verified: true } }),
    );
    expect(() =>
      approveVerifiedSkill({ skillsDir: skills, name: contract.name, host }),
    ).toThrow('verification required');
    expect(fs.existsSync(path.join(skills, contract.name))).toBe(false);
    expect(() =>
      adoptLegacySkillVerification({
        name: contract.name,
        markdown: markdown.replace('status: draft', 'status: active'),
        host,
      }),
    ).toThrow('new_proposal_cannot_be_legacy');
  });
});

// Positive containment is never mocked on platforms without the shipped adapter.
describe.runIf(process.platform === 'darwin')(
  'independent real contained reproductions and browser checks',
  () => {
    beforeAll(async () => {
      registerSkillVerification({ contract, markdown, host });
      const checked = await reproduceSkill({
        name: contract.name,
        markdown,
        host,
      });
      expect(
        checked,
        'The macOS isolated job controller and installed Playwright must execute both real cases.',
      ).toMatchObject({ status: 'verified', verifiedCases: 2 });
    }, 60_000);
    it('activates only the reviewed draft, preserves scope, and keeps all example content out of the shared skill', () => {
      const approved = approveVerifiedSkill({
        name: contract.name,
        skillsDir: skills,
        host,
      });
      const active = fs.readFileSync(approved.path, 'utf8');
      expect(skillVerificationDigest(active)).toBe(contract.skillSha256);
      expect(active).not.toContain('synthetic-alpha');
      expect(active).not.toContain(inputPaths[0]);
      const listed = listSkills({ skillsDir: skills, verificationHost: host });
      expect(listed.find((s) => s.name === contract.name)).toMatchObject({
        status: 'active',
        verification: { status: 'verified', verifiedCases: 2 },
      });
      const group = {
        name: 'demo',
        folder: 'demo',
        trigger: '',
        added_at: '2026-01-01',
        requiresTrigger: false,
      };
      const base = {
        skillsDir: skills,
        verificationHost: host,
        group,
        text: 'package',
        chatJid: 'tg:100123',
      };
      expect(selectSkills(base).map((s) => s.name)).toEqual([contract.name]);
      expect(
        selectSkills({ ...base, group: { ...group, folder: 'foreign' } }),
      ).toEqual([]);
      fs.writeFileSync(
        approved.path,
        active
          .replace('created_by: agent_proposal', 'created_by: operator')
          .replace('verification: required\n', ''),
      );
      try {
        expect(
          listSkills({ skillsDir: skills, verificationHost: host }).find(
            (s) => s.name === contract.name,
          )?.status,
        ).toBe('stale');
      } finally {
        fs.writeFileSync(approved.path, active);
      }
    });
    it('invalidates on skill, fixture or dependency change without accepting a model verified flag', () => {
      expect(
        inspectSkillVerification({
          name: contract.name,
          markdown: markdown + '\nverified: true',
          host,
        }).status,
      ).toBe('stale');
      fs.appendFileSync(inputPaths[0], ' ');
      try {
        expect(
          inspectSkillVerification({ name: contract.name, markdown, host })
            .status,
        ).toBe('stale');
      } finally {
        fs.writeFileSync(
          inputPaths[0],
          JSON.stringify({ label: 'synthetic-alpha' }),
        );
      }
      fs.appendFileSync(procedurePath, '\n');
      try {
        expect(
          inspectSkillVerification({ name: contract.name, markdown, host })
            .status,
        ).toBe('stale');
      } finally {
        fs.writeFileSync(procedurePath, procedure);
      }
    });
    it('cannot obtain a fresh signed pass by only changing the boundary label', async () => {
      const files = fs
        .readdirSync(path.join(host.stateDir, 'skill-verification'))
        .filter((n) => n.startsWith('run-'));
      const artifact = path.join(
        host.stateDir,
        'skill-verification',
        files[0],
        'case-0',
        'artifact.zip',
      );
      expect(
        (
          await runArtifactAcceptance({
            artifactPath: artifact,
            requirements: criteria('synthetic-alpha'),
            host: { ...host, boundary: 'workspace-isolated' },
          })
        ).status,
      ).toBe('inconclusive');
    });
    it('a host-observed failure removes the candidate from automatic selection until reproduction', () => {
      invalidateSkillVerification({
        name: contract.name,
        host,
        reason: 'observed_failure',
      });
      expect(
        inspectSkillVerification({ name: contract.name, markdown, host }),
      ).toMatchObject({ status: 'failed', code: 'observed_failure' });
      expect(
        listSkills({ skillsDir: skills, verificationHost: host }).find(
          (s) => s.name === contract.name,
        )?.status,
      ).toBe('stale');
    });
    it('a real failing reproduction cannot retain or resurrect an earlier pass', async () => {
      const changed = structuredClone(contract);
      changed.cases[0].requirements = criteria(
        'deliberately-wrong-expected-result',
      );
      registerSkillVerification({ contract: changed, markdown, host });
      expect(
        inspectSkillVerification({ name: contract.name, markdown, host })
          .status,
      ).not.toBe('verified');
      expect(
        await reproduceSkill({ name: contract.name, markdown, host }),
      ).toMatchObject({ status: 'failed', code: 'example_failed' });
      expect(
        listSkills({ skillsDir: skills, verificationHost: host }).find(
          (s) => s.name === contract.name,
        )?.status,
      ).toBe('stale');
    }, 30_000);
  },
);
