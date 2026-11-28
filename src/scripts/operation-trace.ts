#!/usr/bin/env node
/** Local operator diagnostics. Read-only DB; never exports legacy event payloads. */
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  findOperationTraceForMessage,
  queryOperationTimeline,
  type OperationTraceChannel,
} from '@skoobi/core/operation-trace-store';

const help = `Usage: node dist/scripts/operation-trace.js --tenant <tenant> --chat <chat> --message <message> [--channel telegram|whatsapp|webhook|other] [--db <messages.db>]
Read-only local diagnostic export: opaque operation/attempt IDs, stages, timing and bounded metrics only.
API acknowledgement does not establish human receipt. Unknown external outcomes do not authorize replay.
`;
function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(help);
    return;
  }
  const options = new Map<string, string>();
  const accepted = new Set([
    '--tenant',
    '--chat',
    '--message',
    '--channel',
    '--db',
  ]);
  for (let i = 0; i < args.length; i += 2) {
    if (!accepted.has(args[i]) || !args[i + 1] || options.has(args[i]))
      throw new Error('Invalid arguments');
    options.set(args[i], args[i + 1]);
  }
  const tenantId = options.get('--tenant'),
    chatId = options.get('--chat'),
    message = options.get('--message');
  if (!tenantId || !chatId || !message)
    throw new Error('Missing required scope or message');
  const channel = options.get('--channel') ?? 'telegram';
  if (!['telegram', 'whatsapp', 'webhook', 'other'].includes(channel))
    throw new Error('Invalid channel');
  const database = new Database(
    options.get('--db') ?? path.join(process.cwd(), 'store', 'messages.db'),
    {
      readonly: true,
      fileMustExist: true,
    },
  );
  try {
    const scope = { tenantId, chatId };
    const observer = findOperationTraceForMessage(
      database,
      scope,
      message,
      channel as OperationTraceChannel,
    );
    const operationId = observer?.operationIds[0];
    if (!operationId) {
      process.stdout.write('{"status":"not_found"}\n');
      return;
    }
    const result = queryOperationTimeline(database, scope, operationId, {
      limit: 500,
    });
    if (!result) throw new Error('Diagnostic read unavailable');
    let next = result.nextSequence;
    // Bounded by the store's hard context and attempt limits, never unbounded
    // event-store pagination or payload reconstruction.
    for (let page = 0; next !== undefined && page < 128; page++) {
      const more = queryOperationTimeline(database, scope, operationId, {
        limit: 500,
        afterSequence: next,
      });
      if (!more) throw new Error('Diagnostic read unavailable');
      result.spans.push(...more.spans);
      next = more.nextSequence;
    }
    result.nextSequence = next;
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    database.close();
  }
}
try {
  main();
} catch {
  // Paths, identifiers, SQL and exception strings are deliberately excluded.
  process.stderr.write(
    'Diagnostic export unavailable; check local arguments and database access.\n',
  );
  process.exitCode = 1;
}
