import fs from 'fs';
import path from 'path';

import {
  archiveSkill,
  defaultSkillsDir,
  isSafeSkillName,
  listSkills,
  SKILL_FILE_NAME,
  SKILL_PROPOSALS_DIR_NAME,
} from '../orchestrator/skill-registry.js';

type Args = {
  root: string;
  skillsDir: string;
  action: string;
  name?: string;
  yes: boolean;
  json: boolean;
  help: boolean;
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
    '  approve <name>       Move .proposals/<name>/SKILL.md to active data/skills/<name>/SKILL.md',
    '  archive <name>       Archive an active non-pinned skill',
    '',
    'Options:',
    '  --root <path>        Skoobi state root (default: cwd)',
    '  --skills-dir <path>  Skills directory (default: <root>/data/skills)',
    '  --yes               Confirm mutating actions',
    '  --json              Print JSON result',
    '  --help              Show help',
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
  const proposalDir = path.join(proposalsDir(args.skillsDir), args.name);
  const proposalFile = path.join(proposalDir, SKILL_FILE_NAME);
  if (!fs.existsSync(proposalFile)) {
    throw new Error(`Proposal not found: ${args.name}`);
  }
  const activeDir = path.join(args.skillsDir, args.name);
  const activeFile = path.join(activeDir, SKILL_FILE_NAME);
  if (fs.existsSync(activeFile)) {
    throw new Error(`Active skill already exists: ${args.name}`);
  }
  fs.mkdirSync(activeDir, { recursive: true, mode: 0o700 });
  let content = fs.readFileSync(proposalFile, 'utf8');
  content = content.replace(/^status:\s*draft$/m, 'status: active');
  fs.writeFileSync(activeFile, content, { mode: 0o600 });
  fs.rmSync(proposalDir, { recursive: true, force: true });
  return { approved: true, path: activeFile };
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
        status: skill.status,
        createdBy: skill.createdBy,
        pinned: skill.pinned,
      })),
      proposals: listProposalNames(args.skillsDir),
    };
  } else if (args.action === 'proposals') {
    result = { proposals: listProposalNames(args.skillsDir) };
  } else if (args.action === 'approve') {
    result = approveProposal(args);
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
