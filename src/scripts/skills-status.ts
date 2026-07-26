import fs from 'fs';
import path from 'path';

import {
  defaultSkillsDir,
  listSkills,
  SKILL_USAGE_FILE_NAME,
} from '../orchestrator/skill-registry.js';

type Args = {
  root: string;
  skillsDir: string;
  json: boolean;
  help: boolean;
};

function usageText(): string {
  return [
    'Usage: skoobi-skills-status [options]',
    '',
    'Shows local Hermes-style Skoobi skills without printing secrets.',
    '',
    'Options:',
    '  --root <path>        Skoobi state root (default: cwd)',
    '  --skills-dir <path>  Skills directory (default: <root>/data/skills)',
    '  --json               Print JSON',
    '  --help               Show help',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const root = process.cwd();
  const args: Args = {
    root,
    skillsDir: defaultSkillsDir(path.join(root, 'data')),
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
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
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

function readUsage(skillsDir: string): Record<string, unknown> {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(skillsDir, SKILL_USAGE_FILE_NAME), 'utf8'),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usageText());
    process.exit(0);
  }
  const skills = listSkills({
    skillsDir: args.skillsDir,
    includeDraft: true,
    includeArchived: false,
  });
  const usage = readUsage(args.skillsDir);
  const rows = skills.map((skill) => ({
    name: skill.name,
    status: skill.status,
    createdBy: skill.createdBy,
    pinned: skill.pinned,
    tags: skill.tags.join(','),
    triggers: skill.triggers.length,
    folders: skill.folders.join(','),
    usage: usage[skill.name] || null,
  }));
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          skillsDir: args.skillsDir,
          count: rows.length,
          rows,
        },
        null,
        2,
      ),
    );
  } else {
    console.log('Skoobi skills status');
    console.log(`skillsDir: ${args.skillsDir}`);
    console.log(`skills: ${rows.length}`);
    for (const row of rows) {
      console.log(
        `- ${row.name} [${row.status}] pinned=${row.pinned} createdBy=${row.createdBy} folders=${row.folders || '*'}`,
      );
    }
    console.log('secrets: not inspected');
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
