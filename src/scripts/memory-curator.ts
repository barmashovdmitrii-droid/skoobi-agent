import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { curateMemoryRoot } from '../orchestrator/memory-curator.js';

type Args = {
  root: string;
  groupsDir: string;
  dataDir: string;
  dbPath: string;
  groupFolders: string[];
  allGroups: boolean;
  activeTelegram: boolean;
  allUserMemory: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
};

type RegisteredGroupRow = {
  jid: string;
  name: string;
  folder: string;
  is_main: number | null;
};

function usage(): string {
  return [
    'Usage: skoobi-memory-curate [options]',
    '',
    'Builds bounded memory/curated/MEMORY.md and USER.md summaries without deleting or migrating legacy markdown memory.',
    '',
    'Default scope: --active-telegram.',
    '',
    'Options:',
    '  --active-telegram       Curate currently active Telegram registered groups and their shared user memory (default)',
    '  --group <folder>        Curate one group folder; can be repeated',
    '  --all-groups            Curate every registered group folder',
    '  --all-user-memory       Curate every data/user-memory/*/shared root',
    '  --dry-run               Analyze and print what would be written',
    '  --root <path>           Skoobi state root (default: cwd)',
    '  --groups-dir <path>     Groups directory (default: <root>/groups)',
    '  --data-dir <path>       Data directory (default: <root>/data)',
    '  --db <path>             SQLite DB path (default: <root>/store/messages.db)',
    '  --json                  Print full result as JSON',
    '  --help                  Show help',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const root = process.cwd();
  const args: Args = {
    root,
    groupsDir: path.join(root, 'groups'),
    dataDir: path.join(root, 'data'),
    dbPath: path.join(root, 'store', 'messages.db'),
    groupFolders: [],
    allGroups: false,
    activeTelegram: false,
    allUserMemory: false,
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
    if (arg === '--group') args.groupFolders.push(next());
    else if (arg === '--all-groups') args.allGroups = true;
    else if (arg === '--active-telegram') args.activeTelegram = true;
    else if (arg === '--all-user-memory') args.allUserMemory = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--root') {
      args.root = path.resolve(next());
      args.groupsDir = path.join(args.root, 'groups');
      args.dataDir = path.join(args.root, 'data');
      args.dbPath = path.join(args.root, 'store', 'messages.db');
    } else if (arg === '--groups-dir') args.groupsDir = path.resolve(next());
    else if (arg === '--data-dir') args.dataDir = path.resolve(next());
    else if (arg === '--db') args.dbPath = path.resolve(next());
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (
    !args.activeTelegram &&
    !args.allGroups &&
    !args.allUserMemory &&
    args.groupFolders.length === 0
  ) {
    args.activeTelegram = true;
  }
  return args;
}

function safeFolder(folder: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(folder);
}

function readRegisteredGroups(dbPath: string): RegisteredGroupRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT jid, name, folder, is_main FROM registered_groups ORDER BY folder`,
      )
      .all() as RegisteredGroupRow[];
  } finally {
    db.close();
  }
}

function readTelegramAccessState(
  dataDir: string,
): Record<string, { status?: string }> {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dataDir, 'telegram-access-control.json'), 'utf8'),
    ) as Record<string, { status?: string }>;
  } catch {
    return {};
  }
}

function sharedMemoryRootForJid(dataDir: string, jid: string): string | null {
  const match = jid.match(/^tg:(?:[^:]+:)?(\d+)$/);
  if (!match) return null;
  return path.join(dataDir, 'user-memory', `telegram_user_${match[1]}`, 'shared');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const groups = readRegisteredGroups(args.dbPath);
  const groupFolders: string[] = [];
  const sharedRoots: string[] = [];

  for (const folder of args.groupFolders) {
    if (!safeFolder(folder)) throw new Error(`Unsafe group folder: ${folder}`);
    groupFolders.push(folder);
  }

  if (args.allGroups) {
    groupFolders.push(...groups.map((group) => group.folder));
  }

  if (args.activeTelegram) {
    const access = readTelegramAccessState(args.dataDir);
    for (const group of groups) {
      if (!group.jid.startsWith('tg:')) continue;
      const status = access[group.jid]?.status || 'active';
      if (status === 'paused' || status === 'banned') continue;
      groupFolders.push(group.folder);
      const sharedRoot = sharedMemoryRootForJid(args.dataDir, group.jid);
      if (sharedRoot) sharedRoots.push(sharedRoot);
    }
  }

  if (args.allUserMemory) {
    const userMemoryRoot = path.join(args.dataDir, 'user-memory');
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(userMemoryRoot, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      sharedRoots.push(path.join(userMemoryRoot, entry.name, 'shared'));
    }
  }

  const results = [];
  for (const folder of unique(groupFolders).sort()) {
    if (!safeFolder(folder)) continue;
    const memoryRoot = path.join(args.groupsDir, folder, 'memory');
    if (!fs.existsSync(memoryRoot)) continue;
    results.push({
      scope: 'group',
      folder,
      ...curateMemoryRoot(memoryRoot, { dryRun: args.dryRun }),
    });
  }
  for (const root of unique(sharedRoots).sort()) {
    if (!fs.existsSync(root)) continue;
    results.push({
      scope: 'shared_user',
      ...curateMemoryRoot(root, { dryRun: args.dryRun }),
    });
  }

  const summary = {
    status: 'PASS',
    dry_run: args.dryRun,
    roots: results.length,
    written: results.filter((result) => result.written).length,
    source_files: results.reduce((sum, result) => sum + result.sourceFiles, 0),
    memory_lines: results.reduce((sum, result) => sum + result.memoryLines, 0),
    user_lines: results.reduce((sum, result) => sum + result.userLines, 0),
  };
  if (args.json) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    console.log(
      `memory curate: ${summary.status} roots=${summary.roots} written=${summary.written} dry_run=${summary.dry_run}`,
    );
    console.log(
      `source_files=${summary.source_files} memory_lines=${summary.memory_lines} user_lines=${summary.user_lines}`,
    );
    for (const result of results) {
      console.log(
        `- ${result.scope}: ${result.memoryRoot} -> MEMORY=${result.memoryLines}/${result.memoryChars} chars, USER=${result.userLines}/${result.userChars} chars`,
      );
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`skoobi-memory-curate failed: ${message}`);
  process.exit(1);
}
