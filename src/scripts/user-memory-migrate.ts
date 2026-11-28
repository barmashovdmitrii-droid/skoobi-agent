import fs from 'fs';
import path from 'path';

import {
  applyUserMemoryMigrationManifest,
  type UserMemoryMigrationManifest,
} from '../orchestrator/user-memory-migration.js';

interface Args {
  root: string;
  groupsDir: string;
  dataDir: string;
  manifestPath: string | null;
  apply: boolean;
  confirm: string | null;
  json: boolean;
  help: boolean;
}

const CONFIRM_PHRASE = 'APPLY_USER_MEMORY_MIGRATION';

function usage(): string {
  return [
    'Usage: skoobi-memory-migrate --manifest <path> [--apply --confirm APPLY_USER_MEMORY_MIGRATION]',
    '',
    'Applies approved entries from a memory review manifest. Without --apply it only reports what would happen.',
    '',
    'Safety:',
    '  - source files are never deleted',
    '  - messages/events/usage/model_traces are never touched',
    '  - only entries with approved=true and recommendation=move_to_shared_uncertain are copied',
    '',
    'Options:',
    '  --manifest <path>        Review manifest path',
    '  --apply                  Copy approved entries into data/user-memory',
    `  --confirm ${CONFIRM_PHRASE}`,
    '  --root <path>            Skoobi state root (default: cwd)',
    '  --groups-dir <path>      Groups directory (default: <root>/groups)',
    '  --data-dir <path>        Data directory (default: <root>/data)',
    '  --json                   Print result as JSON',
    '  --help                   Show help',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const root = process.cwd();
  const args: Args = {
    root,
    groupsDir: path.join(root, 'groups'),
    dataDir: path.join(root, 'data'),
    manifestPath: null,
    apply: false,
    confirm: null,
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
    if (arg === '--manifest') args.manifestPath = path.resolve(next());
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--confirm') args.confirm = next();
    else if (arg === '--root') {
      args.root = path.resolve(next());
      args.groupsDir = path.join(args.root, 'groups');
      args.dataDir = path.join(args.root, 'data');
    } else if (arg === '--groups-dir') args.groupsDir = path.resolve(next());
    else if (arg === '--data-dir') args.dataDir = path.resolve(next());
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

function readManifest(file: string): UserMemoryMigrationManifest {
  const parsed = JSON.parse(
    fs.readFileSync(file, 'utf8'),
  ) as UserMemoryMigrationManifest;
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('Invalid memory migration manifest');
  }
  return parsed;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.manifestPath) throw new Error('--manifest is required');
  const manifest = readManifest(args.manifestPath);
  const approved = manifest.entries.filter(
    (entry) =>
      entry.approved === true &&
      entry.recommendation === 'move_to_shared_uncertain',
  );

  if (!args.apply) {
    const result = {
      status: 'DRY_RUN',
      manifest: args.manifestPath,
      approved_entries_that_would_apply: approved.length,
      total_entries: manifest.entries.length,
      note: `Nothing changed. To apply approved entries, pass --apply --confirm ${CONFIRM_PHRASE}.`,
    };
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`manifest: ${result.manifest}`);
      console.log(`approved entries that would apply: ${approved.length}`);
      console.log(result.note);
    }
    process.exit(0);
  }

  if (args.confirm !== CONFIRM_PHRASE) {
    throw new Error(`Refusing apply without --confirm ${CONFIRM_PHRASE}`);
  }
  const result = applyUserMemoryMigrationManifest(manifest, {
    groupsDir: args.groupsDir,
    dataDir: args.dataDir,
  });
  if (args.json)
    console.log(JSON.stringify({ status: 'APPLIED', ...result }, null, 2));
  else {
    console.log(`applied=${result.applied} skipped=${result.skipped}`);
    console.log(`written_files=${result.written_files.length}`);
    if (Object.keys(result.skipped_reasons).length > 0) {
      console.log(`skipped_reasons=${JSON.stringify(result.skipped_reasons)}`);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`skoobi-memory-migrate failed: ${message}`);
  process.exit(1);
}
