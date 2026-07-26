import path from 'path';

import {
  defaultSkillsDir,
  listSkills,
  writeSkill,
  type SkillFrontmatter,
} from '../orchestrator/skill-registry.js';

type Args = {
  root: string;
  skillsDir: string;
  overwrite: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
};

type SeedSkill = {
  frontmatter: SkillFrontmatter;
  body: string;
};

function usage(): string {
  return [
    'Usage: skoobi-skills-seed [options]',
    '',
    'Creates local Hermes-style Skoobi skill files under data/skills without reading secrets.',
    '',
    'Options:',
    '  --root <path>        Skoobi state root (default: cwd)',
    '  --skills-dir <path>  Skills directory (default: <root>/data/skills)',
    '  --overwrite          Replace existing seed skill files',
    '  --dry-run            Print what would be written',
    '  --json               Print JSON result',
    '  --help               Show help',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const root = process.cwd();
  const args: Args = {
    root,
    skillsDir: defaultSkillsDir(path.join(root, 'data')),
    overwrite: false,
    dryRun: false,
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
    else if (arg === '--overwrite') args.overwrite = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

const seedSkills: SeedSkill[] = [
  {
    frontmatter: {
      name: 'web-search-workflow',
      description:
        'Use Skoobi SearchGateway / Codex web search for current public facts, company contacts, news, prices, and local business lookup instead of claiming no internet.',
      status: 'active',
      created_by: 'memory_seed',
      pinned: true,
      tags: ['web', 'search', 'internet', 'contacts', 'work'],
      triggers: [
        'интернет',
        'найди',
        'поищи',
        'актуальн',
        'телефон',
        'адрес',
        'контакты',
        'search',
        'latest',
      ],
      channels: ['tg'],
      version: '1.0.0',
    },
    body: `
# Web Search Workflow

Use when the user asks for current information, company lists, phones, addresses, prices, news, weather, or anything that should not be invented from memory.

1. Prefer the host-provided SearchGateway/web-search context when present.
2. If search context is unavailable, say that live search failed and answer only from reliable known context.
3. Never invent phone numbers, addresses, prices, or company contacts.
4. Cite source names/URLs when search results provide them.
5. For business-contact tasks, return a useful table: name, address, phone, site/social link, what they sell, notes, source.
6. Do not ask the user to open 2GIS/Yandex manually if Skoobi already has search capability.
`,
  },
  {
    frontmatter: {
      name: 'voice-response',
      description:
        'When the user explicitly asks for a voice reply, send a normal-quality Telegram voice note using the host TTS pipeline and avoid false capability refusals.',
      status: 'active',
      created_by: 'memory_seed',
      pinned: true,
      tags: ['voice', 'tts', 'telegram'],
      triggers: ['голос', 'голосом', 'озвучь', 'скажи вслух', 'voice', 'audio'],
      channels: ['tg'],
      version: '1.0.0',
    },
    body: `
# Voice Response

Use only when the user explicitly asks to answer by voice or the conversation context clearly expects a voice note.

1. Prepare the same answer quality as text; do not shorten just because it is voice.
2. Prefer clear spoken Russian without tables or code blocks.
3. Use the voice delivery tool when available; after explicit voice delivery, avoid sending a duplicate service explanation.
4. If TTS fails, gracefully fall back to a normal text answer and mention the voice failure briefly.
5. Never claim that Skoobi cannot speak if the host voice pipeline is available.
`,
  },
  {
    frontmatter: {
      name: 'memory-continuity',
      description:
        'Use tenant-scoped and sender-scoped memory carefully: search first, verify uncertain facts, and avoid leaking owner/global memory into guest chats.',
      status: 'active',
      created_by: 'memory_seed',
      pinned: true,
      tags: ['memory', 'privacy', 'continuity'],
      triggers: [
        'помнишь',
        'что ты знаешь',
        'запомни',
        'память',
        'кто я',
        'memory',
        'remember',
      ],
      channels: ['tg'],
      version: '1.0.0',
    },
    body: `
# Memory Continuity

Use when continuity, personal context, or saved facts matter.

1. Treat curated memory as a short lossy summary, not proof.
2. Use memory_search for recall and memory_get for exact files when details matter.
3. Use only this tenant's memory and this sender's shared-user memory. Never use owner/global memory as a guest-user fact.
4. If memory is legacy, unprovenanced, assistant-created, photo-derived, or contradictory, label it as uncertain.
5. Save durable user-confirmed facts with memory_save and provenance metadata. Do not save guesses, secrets, tokens, or credentials.
6. For delete/forget requests, require the exact confirmation flow; do not delete audit/accounting/message history.
`,
  },
  {
    frontmatter: {
      name: 'admin-ops-safety',
      description:
        'Admin chat operations safety: inspect local state, avoid secrets, make backups before risky changes, and report exact evidence.',
      status: 'active',
      created_by: 'memory_seed',
      pinned: true,
      tags: ['admin', 'ops', 'safety', 'github', 'service'],
      triggers: [
        'проверь',
        'почини',
        'коммить',
        'пушь',
        'рестарт',
        'сервис',
        'логи',
        'github',
        'deploy',
      ],
      folders: ['telegram_main'],
      channels: ['tg'],
      version: '1.0.0',
    },
    body: `
# Admin Ops Safety

Use only in owner/admin chats.

1. Inspect before changing: git status, relevant logs, runtime status, DB evidence.
2. Do not print or read auth/session files, cookies, browser tokens, or .env secrets.
3. Before DB/runtime-wide changes, create a backup and record the backup path.
4. Do not touch WhatsApp, owner/main rollout, MCP, owner shell/write tools, or production secrets unless explicitly asked.
5. After edits, run focused tests first, then broader tests/build when risk is meaningful.
6. Final report should include what changed, verification, runtime impact, rollback path, and unresolved risks.
      `,
  },
  {
    frontmatter: {
      name: 'self-improvement-skills',
      description:
        'Hermes-style self-improvement rules for Skoobi procedural skills: propose reusable skills after repeated successful workflows, but do not auto-activate risky changes.',
      status: 'active',
      created_by: 'memory_seed',
      pinned: true,
      tags: ['skills', 'curator', 'self-improvement'],
      triggers: [
        'скил',
        'скилл',
        'обуч',
        'самообуч',
        'как у гермеса',
        'skill',
        'curator',
      ],
      channels: ['tg'],
      version: '1.0.0',
    },
    body: `
# Self-Improvement Skills

Use when a workflow repeats, the operator teaches a better procedure, or a hard task succeeds after several corrections.

1. Prefer small procedural skills over adding huge permanent prompt text.
2. A good skill has trigger conditions, exact steps, pitfalls, and verification.
3. Propose new skills as drafts first; do not activate/delete/archive skills without operator approval.
4. Mark source and provenance. Never put secrets, tokens, private chat IDs, or raw user data into a public/repo skill.
5. Curator behavior should be recoverable: archive, not delete; pinned skills are protected.
`,
  },
];

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const results = [];
  for (const skill of seedSkills) {
    if (args.dryRun) {
      results.push({
        name: skill.frontmatter.name,
        action: 'would_write',
      });
      continue;
    }
    const written = writeSkill({
      skillsDir: args.skillsDir,
      frontmatter: skill.frontmatter,
      body: skill.body,
      overwrite: args.overwrite,
    });
    results.push({
      name: skill.frontmatter.name,
      action: written.created ? 'created' : 'kept',
      path: written.path,
    });
  }

  const skills = listSkills({ skillsDir: args.skillsDir });
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          skillsDir: args.skillsDir,
          results,
          activeCount: skills.filter((skill) => skill.status === 'active')
            .length,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Skoobi skills dir: ${args.skillsDir}`);
    for (const result of results) {
      console.log(`- ${result.name}: ${result.action}`);
    }
    console.log(`Active skills: ${skills.length}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
