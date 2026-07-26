import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { createUserMemoryMigrationManifest } from '../orchestrator/user-memory-migration.js';
import type { RegisteredGroup } from '../orchestrator/types.js';

interface Args {
  root: string;
  groupsDir: string;
  dataDir: string;
  dbPath: string;
  identityId: string | null;
  output: string | null;
  approveSafe: boolean;
  json: boolean;
  help: boolean;
}

function usage(): string {
  return [
    'Usage: skoobi-memory-review [options]',
    '',
    'Creates a dry-run legacy memory migration manifest. It reads registered_groups and memory markdown files, but does not move or delete anything.',
    '',
    'Options:',
    '  --identity <identity_id>  Limit review to one stable identity, e.g. telegram_user_100000001',
    '  --output <path|->        Write manifest path, or - for stdout',
    '  --approve-safe          Mark low/medium-risk move_to_shared_uncertain entries approved for copy',
    '  --root <path>            Skoobi state root (default: cwd)',
    '  --groups-dir <path>      Groups directory (default: <root>/groups)',
    '  --data-dir <path>        Data directory (default: <root>/data)',
    '  --db <path>              SQLite DB path (default: <root>/store/messages.db)',
    '  --json                   Print summary as JSON',
    '  --help                   Show help',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const root = process.cwd();
  const args: Args = {
    root,
    groupsDir: path.join(root, 'groups'),
    dataDir: path.join(root, 'data'),
    dbPath: path.join(root, 'store', 'messages.db'),
    identityId: null,
    output: null,
    approveSafe: false,
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
    if (arg === '--identity') args.identityId = next();
    else if (arg === '--output') args.output = next();
    else if (arg === '--approve-safe') args.approveSafe = true;
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
  return args;
}

function readRegisteredGroups(dbPath: string): Record<string, RegisteredGroup> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
      jid: string;
      name: string;
      folder: string;
      trigger_pattern: string;
      added_at: string;
      container_config: string | null;
      requires_trigger: number | null;
      is_main: number | null;
      agent_config: string | null;
      runtime: string | null;
    }>;
    const groups: Record<string, RegisteredGroup> = {};
    for (const row of rows) {
      groups[row.jid] = {
        name: row.name,
        folder: row.folder,
        trigger: row.trigger_pattern,
        added_at: row.added_at,
        containerConfig: row.container_config
          ? JSON.parse(row.container_config)
          : undefined,
        requiresTrigger:
          row.requires_trigger === null
            ? undefined
            : row.requires_trigger === 1,
        isMain: row.is_main === 1 ? true : undefined,
        agentConfig: row.agent_config
          ? JSON.parse(row.agent_config)
          : undefined,
        runtime: (row.runtime as RegisteredGroup['runtime']) || undefined,
      };
    }
    return groups;
  } finally {
    db.close();
  }
}

function defaultOutputPath(dataDir: string, identityId: string | null): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = identityId
    ? `review-${identityId}-${stamp}.json`
    : `review-all-${stamp}.json`;
  return path.join(dataDir, 'memory-migration', name);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const groups = readRegisteredGroups(args.dbPath);
  const manifest = createUserMemoryMigrationManifest({
    rootDir: args.root,
    groupsDir: args.groupsDir,
    registeredGroups: groups,
    identityId: args.identityId,
  });
  if (args.approveSafe) {
    for (const entry of manifest.entries) {
      entry.approved = entry.recommendation === 'move_to_shared_uncertain';
      if (entry.approved) {
        entry.operator_note =
          'Auto-approved by --approve-safe; source will be copied as low-confidence shared legacy memory.';
      }
    }
  }

  const output =
    args.output || defaultOutputPath(args.dataDir, args.identityId);
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  if (output === '-') {
    process.stdout.write(body);
  } else {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, body, { mode: 0o600 });
  }

  const summary = {
    status: 'PASS',
    output: output === '-' ? 'stdout' : output,
    identity_id: manifest.identity_id,
    ...manifest.summary,
    approved_entries: manifest.entries.filter((entry) => entry.approved)
      .length,
    note: args.approveSafe
      ? 'Dry-run only. Safe move candidates were marked approved; apply still requires skoobi-memory-migrate --apply --confirm.'
      : 'Dry-run only. Edit manifest entries and set approved=true before apply.',
  };
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`memory review manifest: ${summary.output}`);
    console.log(
      `entries=${summary.entries_total} safe_candidates=${summary.safe_move_candidates} review=${summary.requires_operator_review} do_not_migrate=${summary.do_not_migrate}`,
    );
    console.log(summary.note);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`skoobi-memory-review failed: ${message}`);
  process.exit(1);
}
