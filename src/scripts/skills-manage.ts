import fs from 'fs';
import path from 'path';

import {
  archiveSkill,
  approveVerifiedSkill,
  adoptLegacySkillVerification,
  defaultSkillsDir,
  defaultSkillVerificationHost,
  isSafeSkillName,
  listSkills,
  SKILL_FILE_NAME,
  SKILL_PROPOSALS_DIR_NAME,
  registerSkillVerification,
  reproduceSkill,
  inspectSkillVerification,
  invalidateSkillVerification,
  readSkillVerificationSource,
  type SkillVerificationContract,
} from '../orchestrator/skill-registry.js';

type Args = {
  root: string;
  skillsDir: string;
  action: string;
  name?: string;
  yes: boolean;
  json: boolean;
  help: boolean;
  contract?: string;
};

function usage(): string {
  return [
    'Usage: skoobi-skills-manage <action> [name] [options]',
    '',
    'Operator-only management for Hermes-style Skoobi skills.',
    '',
    'Actions:',
    '  list                 List active/draft skills',
    '  proposals            List draft proposals',
    '  approve <name>       Activate the exact reviewed draft only with current host verification',
    '  verification <name>  Show evidence status; usage counts and frontmatter are not proof',
    '  verify-register <name> --contract <file>  Register an operator-reviewed synthetic reproduction contract',
    '  verify <name>        Reproduce both declared examples and check actual outputs',
    '  fail <name>          Invalidate the current proof after a host-observed failure',
    '  adopt-legacy <name>  Pin an explicitly reviewed historical active skill as unverified; refuses new proposals',
    '  archive <name>       Archive an active non-pinned skill',
    '',
    'Options:',
    '  --root <path>        Skoobi state root (default: cwd)',
    '  --skills-dir <path>  Skills directory (default: <root>/data/skills)',
    '  --yes               Confirm mutating actions',
    '  --json              Print JSON result',
    '  --help              Show help',
    '',
    'verify uses the shipped isolated-job controller; unavailable containment is inconclusive.',
    'Unisolated runs and trust labels cannot establish proof; no CLI flag promotes the boundary.',
    'Generalize the draft manually before registration. Example contents stay private and are never added to the skill.',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const root = process.cwd();
  const args: Args = {
    root,
    skillsDir: defaultSkillsDir(path.join(root, 'data')),
    action: argv[0] || 'list',
    name: argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined,
    yes: false,
    json: false,
    help: false,
  };
  for (let i = args.name ? 2 : 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === '--root') {
      args.root = path.resolve(next());
      args.skillsDir = defaultSkillsDir(path.join(args.root, 'data'));
    } else if (arg === '--skills-dir') args.skillsDir = path.resolve(next());
    else if (arg === '--contract') args.contract = path.resolve(next());
    else if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

function proposalsDir(skillsDir: string): string {
  return path.join(skillsDir, SKILL_PROPOSALS_DIR_NAME);
}

function listProposalNames(skillsDir: string): string[] {
  const root = proposalsDir(skillsDir);
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafeSkillName(entry.name))
      .filter((entry) =>
        fs.existsSync(path.join(root, entry.name, SKILL_FILE_NAME)),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function approveProposal(args: Args): { approved: boolean; path?: string } {
  if (!args.name || !isSafeSkillName(args.name)) {
    throw new Error('approve requires a safe skill name');
  }
  if (!args.yes) {
    throw new Error('approve is mutating; rerun with --yes after review');
  }
  return approveVerifiedSkill({
    name: args.name,
    skillsDir: args.skillsDir,
    host: defaultSkillVerificationHost(args.skillsDir, args.root),
  });
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  fs.mkdirSync(args.skillsDir, { recursive: true, mode: 0o700 });

  let result: unknown;
  if (args.action === 'list') {
    result = {
      skills: listSkills({
        skillsDir: args.skillsDir,
        includeDraft: true,
      }).map((skill) => ({
        name: skill.name,
        version: skill.version,
        status: skill.status,
        createdBy: skill.createdBy,
        pinned: skill.pinned,
        verification: skill.verification,
      })),
      proposals: listProposalNames(args.skillsDir),
    };
  } else if (args.action === 'proposals') {
    result = { proposals: listProposalNames(args.skillsDir) };
  } else if (args.action === 'approve') {
    result = approveProposal(args);
  } else if (
    [
      'verify-register',
      'verify',
      'verification',
      'fail',
      'adopt-legacy',
    ].includes(args.action)
  ) {
    if (!args.name || !isSafeSkillName(args.name))
      throw new Error('A safe skill name is required');
    if (args.action !== 'verification' && !args.yes)
      throw new Error(
        'Mutating skill verification requires --yes after review',
      );
    const host = defaultSkillVerificationHost(args.skillsDir, args.root);
    const markdown = readSkillVerificationSource(
      args.skillsDir,
      args.name,
      args.action === 'verify-register' ||
        args.action === 'verify' ||
        !fs.existsSync(path.join(args.skillsDir, args.name, SKILL_FILE_NAME)),
    );
    if (args.action === 'adopt-legacy') {
      adoptLegacySkillVerification({ name: args.name, markdown, host });
      result = { status: 'legacy_adopted', verified: false };
    } else if (args.action === 'verify-register') {
      if (!args.contract || fs.statSync(args.contract).size > 32_768)
        throw new Error('A bounded host-reviewed contract is required');
      const contract = JSON.parse(
        fs.readFileSync(args.contract, 'utf8'),
      ) as SkillVerificationContract;
      if (contract.name !== args.name)
        throw new Error('Skill contract name mismatch');
      registerSkillVerification({ contract, markdown, host });
      result = { status: 'registered', verified: false };
    } else if (args.action === 'verify') {
      result = await reproduceSkill({ name: args.name, markdown, host });
    } else if (args.action === 'verification') {
      result = inspectSkillVerification({ name: args.name, markdown, host });
    } else {
      invalidateSkillVerification({
        name: args.name,
        host,
        reason: 'observed_failure',
      });
      result = { status: 'failed', code: 'observed_failure' };
    }
  } else if (args.action === 'archive') {
    if (!args.name) throw new Error('archive requires a skill name');
    if (!args.yes) {
      throw new Error('archive is mutating; rerun with --yes after review');
    }
    result = archiveSkill({ name: args.name, skillsDir: args.skillsDir });
  } else {
    throw new Error(`Unknown action: ${args.action}`);
  }

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`skillsDir: ${args.skillsDir}`);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
