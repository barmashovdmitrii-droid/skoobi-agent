/** Synthetic subprocess fixture. No Telegram, audio decoder or external service. */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  createSchema,
  migrateMessageIngestionCursors,
} from '../../core/src/orchestrator/db.ts';
import {
  createMediaIntakeStore,
  ensureMediaIntakeSchema,
} from '../../core/src/orchestrator/media-intake-store.ts';
import { MediaIntakeWorker } from '../src/media-intake-worker.ts';
import type { NewMessage } from '@skoobi/shared/channel-types';

const [filename, group, stage] = process.argv.slice(2);
const db = new Database(filename);
createSchema(db);
migrateMessageIngestionCursors(db);
ensureMediaIntakeSchema(db);
const scope = {
  botId: 'fixture',
  tenantId: 'fixture',
  chatJid: 'tg:fixture:101',
  groupFolder: 'fixture',
};
const options = {
  botId: 'fixture',
  resolveScope: () => scope,
  isAdmitted: () => true,
  writeMessage(database: Database.Database, message: NewMessage) {
    if (!database.inTransaction) throw new Error('Expected outer transaction');
    database
      .prepare('INSERT OR IGNORE INTO chats(jid) VALUES(?)')
      .run(message.chat_jid);
    database
      .prepare(
        'INSERT INTO messages(id,chat_jid,sender,sender_name,content,timestamp,is_from_me,is_bot_message) VALUES(?,?,?,?,?,?,0,0) ON CONFLICT(id,chat_jid) DO UPDATE SET content=excluded.content',
      )
      .run(
        message.id,
        message.chat_jid,
        message.sender,
        message.sender_name,
        message.content,
        message.timestamp,
      );
    database
      .prepare(
        'INSERT INTO message_metadata(id,chat_jid,sender_identity_json) VALUES(?,?,?) ON CONFLICT(id,chat_jid) DO UPDATE SET sender_identity_json=excluded.sender_identity_json',
      )
      .run(
        message.id,
        message.chat_jid,
        JSON.stringify(message.sender_identity),
      );
  },
};
const adapter = createMediaIntakeStore(db, options);
const accepted = adapter.accept({
  message: {
    id: 'synthetic-input',
    chat_jid: scope.chatJid,
    sender: '102',
    sender_name: 'Fixture',
    timestamp: '2026-01-01T00:00:00Z',
    sender_identity: {
      channel: 'telegram',
      chat_id: '101',
      telegram_user_id: '102',
      identity_id: 'fixture',
      is_owner_sender: true,
      telegram_message_origin: 'direct',
    },
  },
  media: { kind: 'voice', fileId: 'synthetic-file' },
  isGroup: false,
});
if (accepted.kind !== 'accepted')
  throw new Error('Synthetic accept: ' + accepted.kind);
function boundary(name: string) {
  if (stage !== name) return;
  fs.writeSync(1, name + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const errors: string[] = [];
const worker = new MediaIntakeWorker({
  onError: (code) => errors.push(code),
  adapter: {
    ...adapter,
    claim(id) {
      const result = adapter.claim(id);
      if (result) boundary('accepted');
      return result;
    },
    prepareDownload(attempt, result) {
      const receipt = adapter.prepareDownload(attempt, result);
      if (receipt) boundary('prepared');
      return receipt;
    },
    checkpointDownload(attempt, result) {
      const receipt = adapter.checkpointDownload(attempt, result);
      if (receipt) boundary('downloaded');
      return receipt;
    },
    checkpointTranscription(attempt, result) {
      const receipt = adapter.checkpointTranscription(attempt, result);
      if (receipt) boundary('transcribed');
      return receipt;
    },
    materialize(lease) {
      const receipt = adapter.materialize(lease);
      if (receipt.kind === 'materialized') boundary('materialized');
      return receipt;
    },
  },
  groupDirectory: () => group,
  async download(_job, control) {
    fs.appendFileSync(path.join(group, 'download-count'), '1\n');
    await fs.promises.writeFile(control.destinationPath, 'synthetic audio', {
      flag: 'wx',
    });
  },
  async transcribe() {
    fs.appendFileSync(path.join(group, 'transcription-count'), '1\n');
    return 'Exact synthetic text';
  },
});
await worker.wake();
await worker.stop();
const summary = db
  .prepare(
    "SELECT stage,json_extract(job_json,'$.failure') AS failure FROM media_intake_jobs",
  )
  .all();
db.close();
throw new Error(
  'Synthetic checkpoint not reached: ' + JSON.stringify({ summary, errors }),
);
