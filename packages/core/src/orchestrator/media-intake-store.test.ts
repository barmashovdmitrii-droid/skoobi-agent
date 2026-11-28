import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MediaIntakePersistenceError,
  type MediaIntakeAdapter,
  type MediaIntakeInput,
  type MediaIntakeJob,
  type MediaIntakeScope,
} from '@skoobi/shared/media-intake';
import type { NewMessage } from '@skoobi/shared/channel-types';
import type { LocalTranscriptionResult } from '@skoobi/shared/transcription-result';
import {
  createSchema,
  migrateMessageIngestionCursors,
  _initTestDatabase,
  getDb,
  storeMessage,
} from './db.js';
import {
  acknowledgeMediaIntakeDispatch,
  cancelMediaIntakeBefore,
  claimMediaIntakeNotice,
  createMediaIntakeStore,
  earliestMediaIntakeCursor,
  ensureMediaIntakeSchema,
  pendingMediaIntakeDispatches,
  settleMediaIntakeNotice,
  readMediaTranscriptionEvidence,
} from './media-intake-store.js';

function uncertainSpeech(): LocalTranscriptionResult {
  const texts = ['Отправь 15 деталей', 'Отправь 25 деталей'];
  return { schema: 1, status: 'doubtful', text: texts[1], originalText: texts[0], selectedPassIndex: 2,
    passes: texts.map((text, i) => ({ index: i + 1, requestedLanguage: i ? 'ru' : 'auto',
      detectedLanguage: 'ru', languageProbability: 0.8, meanTokenLogProbability: -0.3,
      text, valid: true, invalidReason: null, outcome: 'completed' })),
    recheck: { reason: 'low_mean_token_log_probability', comparison: 'different', comparedPassIndices: [1, 2] },
    uncertainty: ['candidate_disagreement', 'number_disagreement'],
    ambiguities: [{ kind: 'number', passIndices: [1, 2], variants: ['15', '25'] }],
    metrics: { queueWaitMs: 0, processingMs: 12, audioDurationMs: null } };
}
function technicalSpeech(code: 'process_timeout' | 'missing_model' | 'aborted'): LocalTranscriptionResult {
  return { schema: 1, status: code === 'aborted' ? 'cancelled' : 'technical_error', text: null,
    originalText: null, selectedPassIndex: null, passes: [],
    recheck: { reason: null, comparison: 'not_run', comparedPassIndices: [] }, uncertainty: [], ambiguities: [],
    error: { stage: code === 'missing_model' ? 'configuration' : 'whisper', code, retryable: code === 'process_timeout' },
    metrics: { queueWaitMs: 0, processingMs: 1, audioDurationMs: null } };
}

const scope: MediaIntakeScope = {
  botId: 'fixture-bot',
  tenantId: 'fixture-tenant',
  chatJid: 'tg:fixture-chat',
  groupFolder: 'telegram_fixture',
};
const digest = createHash('sha256')
  .update('synthetic audio bytes')
  .digest('hex');
const input = (
  id = 'one',
  changes: Partial<MediaIntakeInput> = {},
): MediaIntakeInput => ({
  message: {
    id,
    chat_jid: scope.chatJid,
    sender: 'fixture-sender',
    sender_name: 'Synthetic sender',
    timestamp: '2026-11-04T00:00:00.000Z',
    telegram_update_id: `update-${id}`,
    sender_identity: {
      channel: 'telegram',
      chat_id: 'fixture-chat',
      telegram_user_id: 'fixture-sender',
      identity_id: 'fixture-identity',
      bot_id: scope.botId,
      is_owner_sender: true,
      telegram_message_origin: 'direct',
    },
  },
  media: {
    kind: 'voice',
    fileId: `file-${id}`,
    fileUniqueId: `unique-${id}`,
    declaredBytes: 21,
  },
  isGroup: false,
  ...changes,
});
/** Production-equivalent SQL writer on the supplied test connection, with actual
 * ingestion triggers from db.ts. Tests also exercise the real global writer below.
 */
function writeMessage(db: Database.Database, message: NewMessage): void {
  expect(db.inTransaction).toBe(true);
  db.prepare('INSERT OR IGNORE INTO chats(jid) VALUES(?)').run(
    message.chat_jid,
  );
  db.prepare(
    `INSERT INTO messages(id,chat_jid,sender,sender_name,content,timestamp,is_from_me,is_bot_message)
    VALUES(?,?,?,?,?,?,0,0) ON CONFLICT(id,chat_jid) DO UPDATE SET content=excluded.content`,
  ).run(
    message.id,
    message.chat_jid,
    message.sender,
    message.sender_name,
    message.content,
    message.timestamp,
  );
  db.prepare(
    `INSERT INTO message_metadata(id,chat_jid,telegram_update_id,sender_identity_json) VALUES(?,?,?,?)
    ON CONFLICT(id,chat_jid) DO UPDATE SET telegram_update_id=excluded.telegram_update_id,sender_identity_json=excluded.sender_identity_json`,
  ).run(
    message.id,
    message.chat_jid,
    message.telegram_update_id ?? null,
    JSON.stringify(message.sender_identity ?? null),
  );
}

describe('durable voice intake on the existing ingestion schema', () => {
  let root: string,
    filename: string,
    db: Database.Database,
    adapter: MediaIntakeAdapter;
  let time: number,
    admitted: boolean,
    runnable: boolean,
    activeScope: MediaIntakeScope;
  const options = () => ({
    botId: scope.botId,
    resolveScope: () => activeScope,
    isAdmitted: () => admitted,
    canProcess: () => runnable,
    writeMessage,
    now: () => time,
  });
  const refresh = () => {
    adapter = createMediaIntakeStore(db, options());
  };
  const accept = (source = input()) => {
    const result = adapter.accept(source);
    if (result.kind !== 'accepted' && result.kind !== 'duplicate')
      throw new Error('Expected accepted fixture');
    return result.job;
  };
  const read = (id: string): MediaIntakeJob => {
    const row = db
      .prepare(
        'SELECT job_json,stage,revision FROM media_intake_jobs WHERE job_id=?',
      )
      .get(id) as {
      job_json: string;
      stage: MediaIntakeJob['stage'];
      revision: number;
    };
    return {
      ...JSON.parse(row.job_json),
      stage: row.stage,
      revision: row.revision,
    };
  };
  const toDownloaded = (id: string, target = adapter) => {
    const claim = target.claim(id)!;
    const work = target.beginAttempt(claim.lease, 'download')!;
    const data = {
      relativePath: work.destinationRelativePath!,
      bytes: 21,
      sha256: digest,
    };
    const prepared = target.prepareDownload(work, data)!;
    return target.checkpointDownload(prepared, data)!;
  };
  const toTranscribed = (
    id: string,
    transcript: string | null = 'Synthetic request',
    target = adapter,
  ) => {
    const downloaded = toDownloaded(id, target);
    const work = target.beginAttempt(downloaded.lease, 'transcribe')!;
    return target.checkpointTranscription(work, {
      text: transcript,
      sourceSha256: digest,
    })!;
  };

  it('persists original/candidates once, and reads only the unchanged admitted source in its exact scope', () => {
    const accepted = accept();
    const downloaded = toDownloaded(accepted.id);
    const work = adapter.beginAttempt(downloaded.lease, 'transcribe')!;
    const result = uncertainSpeech();
    const checkpoint = adapter.checkpointTranscription(work, { text: result.text, sourceSha256: digest, result })!;
    expect(checkpoint.job.stage).toBe('transcribed');
    expect(adapter.checkpointTranscription(work, { text: result.text, sourceSha256: digest, result })).toBeUndefined();
    expect(read(accepted.id).transcriptionAttemptsEvidence).toEqual([result]);
    expect(adapter.materialize(checkpoint.lease).kind).toBe('materialized');
    expect(readMediaTranscriptionEvidence(db, scope, ['one'], () => true)).toEqual([{ messageId: 'one', result }]);
    expect(readMediaTranscriptionEvidence(db, { ...scope, tenantId: 'other' }, ['one'], () => true)).toEqual([]);
    expect(readMediaTranscriptionEvidence(db, scope, ['one'], () => false)).toEqual([]);
    db.prepare('UPDATE messages SET content=? WHERE id=? AND chat_jid=?').run('Исправлено пользователем', 'one', scope.chatJid);
    expect(readMediaTranscriptionEvidence(db, scope, ['one'], () => true)).toEqual([]);
    db.prepare('DELETE FROM messages WHERE id=? AND chat_jid=?').run('one', scope.chatJid);
    expect(readMediaTranscriptionEvidence(db, scope, ['one'], () => true)).toEqual([]);
  });

  it('retries only typed transient failures within the charged two-pipeline budget, retaining both outcomes', () => {
    const accepted = accept();
    const downloaded = toDownloaded(accepted.id);
    let work = adapter.beginAttempt(downloaded.lease, 'transcribe')!;
    const result = technicalSpeech('process_timeout');
    const retry = adapter.checkpointTranscription(work, { text: null, sourceSha256: digest, result })!;
    expect(retry.job.stage).toBe('downloaded');
    expect(adapter.isCurrent(retry.lease)).toBe(false);
    expect(adapter.beginAttempt(retry.lease, 'transcribe')).toBeUndefined();
    work = adapter.beginAttempt(adapter.claim(accepted.id)!.lease, 'transcribe')!;
    const stopped = adapter.checkpointTranscription(work, { text: null, sourceSha256: digest, result })!;
    expect(stopped.job.stage).toBe('failed');
    expect(stopped.job.transcriptionAttempts).toBe(2);
    expect(stopped.job.transcriptionAttemptsEvidence).toEqual([result, result]);
    expect(adapter.claim(accepted.id)).toBeUndefined();
    expect(claimMediaIntakeNotice(db, { now: () => time })?.reason).toBe('transcription_timeout');
  });

  it('does not retry missing configuration, and cancellation never executes the caption', () => {
    for (const code of ['missing_model', 'aborted'] as const) {
      const accepted = accept(input(code, { caption: 'Synthetic caption command' }));
      const downloaded = toDownloaded(accepted.id);
      const work = adapter.beginAttempt(downloaded.lease, 'transcribe')!;
      const result = technicalSpeech(code);
      const end = adapter.checkpointTranscription(work, { text: null, sourceSha256: digest, result })!;
      expect(end.job.stage).toBe(code === 'aborted' ? 'cancelled' : 'failed');
      expect(end.job.transcriptionAttempts).toBe(1);
      expect(adapter.claim(accepted.id)).toBeUndefined();
      const row = db.prepare('SELECT content FROM messages WHERE id=? AND chat_jid=?').get(code, scope.chatJid) as { content: string };
      if (code === 'aborted') expect(row.content).toBe('');
      else expect(row.content).toContain('Synthetic caption command');
    }
  });

  it('rejects contradictory detailed/legacy text before updating the checkpoint', () => {
    const accepted = accept();
    const downloaded = toDownloaded(accepted.id);
    const work = adapter.beginAttempt(downloaded.lease, 'transcribe')!;
    expect(adapter.checkpointTranscription(work, { text: 'different text', sourceSha256: digest, result: uncertainSpeech() })).toBeUndefined();
    expect(read(accepted.id).transcriptionAttemptsEvidence).toBeUndefined();
    expect(read(accepted.id).stage).toBe('downloaded');
  });
  const previousOwnerDied = () => {
    const previous = randomUUID(),
      dead = spawnSync(process.execPath, ['-e', '']).pid;
    const active = db
      .prepare('SELECT owner_id FROM media_intake_owners WHERE pid=? LIMIT 1')
      .get(process.pid) as { owner_id: string };
    db.prepare(
      'UPDATE media_intake_owners SET owner_id=?,pid=? WHERE owner_id=?',
    ).run(previous, dead, active.owner_id);
    db.prepare('UPDATE media_intake_jobs SET owner_id=? WHERE owner_id=?').run(
      previous,
      active.owner_id,
    );
    db.prepare(
      'UPDATE media_intake_notices SET owner_id=? WHERE owner_id=?',
    ).run(previous, active.owner_id);
  };
  const reopen = () => {
    db.close();
    db = new Database(filename);
    db.pragma('foreign_keys=ON');
    ensureMediaIntakeSchema(db);
    refresh();
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-intake-'));
    filename = path.join(root, 'state.sqlite');
    db = new Database(filename);
    db.pragma('foreign_keys=ON');
    createSchema(db);
    migrateMessageIngestionCursors(db);
    time = 1_000_000;
    admitted = true;
    runnable = true;
    activeScope = { ...scope };
    refresh();
  });
  afterEach(() => {
    if (db.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reserves the original order without runnable content and keeps it when materialized', () => {
    const a = accept();
    db.transaction(() =>
      writeMessage(db, {
        ...input('later').message,
        content: 'Later correction',
      }),
    )();
    const later = db
      .prepare("SELECT sequence FROM message_ingestion WHERE id='later'")
      .get() as { sequence: number };
    expect(Number(a.ingestionCursor.slice(2))).toBeLessThan(later.sequence);
    expect(
      db.prepare("SELECT count(*) AS n FROM messages WHERE content<>''").get(),
    ).toEqual({ n: 1 });
    expect(earliestMediaIntakeCursor(db, scope.chatJid)).toBe(
      a.ingestionCursor,
    );
    const ready = toTranscribed(a.id);
    expect(adapter.materialize(ready.lease)).toEqual({
      kind: 'materialized',
      ingestionCursor: a.ingestionCursor,
    });
    expect(adapter.materialize(ready.lease).kind).toBe('already_materialized');
    expect(adapter.accept(input()).kind).toBe('already_materialized');
    expect(
      db.prepare('SELECT id FROM message_ingestion ORDER BY sequence').all(),
    ).toEqual([{ id: 'one' }, { id: 'later' }]);
    expect(earliestMediaIntakeCursor(db, scope.chatJid)).toBeUndefined();
    expect(pendingMediaIntakeDispatches(db)).toEqual([
      { jobId: a.id, chatJid: scope.chatJid },
    ]);
    acknowledgeMediaIntakeDispatch(db, a.id);
    expect(pendingMediaIntakeDispatches(db)).toEqual([]);
  });

  it('deduplicates immutable sources, rejects conflicts and never rewrites sender provenance', () => {
    const source = input();
    source.message.sender_identity!.telegram_message_origin = 'forwarded';
    const a = accept(source);
    expect(adapter.accept(source)).toMatchObject({
      kind: 'duplicate',
      job: { id: a.id },
    });
    const forged = structuredClone(source);
    forged.message.sender_identity!.telegram_message_origin = 'direct';
    expect(adapter.accept(forged)).toEqual({
      kind: 'rejected',
      reason: 'source_conflict',
    });
    const changedFile = structuredClone(source);
    changedFile.media.fileId = 'different-file';
    expect(adapter.accept(changedFile)).toEqual({
      kind: 'rejected',
      reason: 'source_conflict',
    });
    const ready = toTranscribed(a.id);
    adapter.materialize(ready.lease);
    reopen();
    const metadata = db
      .prepare('SELECT sender_identity_json FROM message_metadata WHERE id=?')
      .get('one') as { sender_identity_json: string };
    expect(
      JSON.parse(metadata.sender_identity_json).telegram_message_origin,
    ).toBe('forwarded');
    expect(
      read(a.id).input.message.sender_identity!.telegram_message_origin,
    ).toBe('forwarded');
  });

  it('atomically rolls back placeholder, metadata, reserved sequence and job on failed acceptance', () => {
    const failing = createMediaIntakeStore(db, {
      ...options(),
      writeMessage(database, message) {
        writeMessage(database, message);
        throw new Error('synthetic storage error');
      },
    });
    expect(() => failing.accept(input())).toThrow(MediaIntakePersistenceError);
    for (const table of [
      'messages',
      'message_metadata',
      'message_ingestion',
      'media_intake_jobs',
    ])
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({
        n: 0,
      });
  });

  it('rolls back final content and stage together, then retries exact stored transcript once', () => {
    const a = accept(),
      ready = toTranscribed(a.id);
    const failing = createMediaIntakeStore(db, {
      ...options(),
      writeMessage(database, message) {
        writeMessage(database, message);
        throw new Error('synthetic final write failure');
      },
    });
    expect(() => failing.materialize(ready.lease)).toThrow(
      MediaIntakePersistenceError,
    );
    expect(read(a.id).stage).toBe('transcribed');
    expect(
      db.prepare('SELECT content FROM messages WHERE id=?').get('one'),
    ).toEqual({ content: '' });
    expect(adapter.materialize(ready.lease).kind).toBe('materialized');
    expect(
      db.prepare('SELECT count(*) AS n FROM message_ingestion').get(),
    ).toEqual({ n: 1 });
  });

  it('uses the real global db writer inside the same outer SQLite transaction', () => {
    _initTestDatabase();
    const real = getDb();
    const realAdapter = createMediaIntakeStore(real, {
      ...options(),
      writeMessage(passed, message) {
        expect(passed).toBe(real);
        expect(passed.inTransaction).toBe(true);
        storeMessage(message);
      },
    });
    const result = realAdapter.accept(input());
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') throw new Error('Expected fixture');
    const ready = toTranscribed(
      result.job.id,
      'Real writer result',
      realAdapter,
    );
    expect(realAdapter.materialize(ready.lease).kind).toBe('materialized');
    expect(
      real.prepare('SELECT count(*) AS n FROM message_ingestion').get(),
    ).toEqual({ n: 1 });
    real.close();
  });

  it('allows only one connection to claim and holds other live owners even after the deadline', () => {
    const a = accept();
    const first = adapter.claim(a.id)!;
    const otherDb = new Database(filename);
    try {
      const other = createMediaIntakeStore(otherDb, options());
      expect(other.claim(a.id)).toBeUndefined();
      time += 30 * 60_000;
      expect(other.claim(a.id)).toBeUndefined();
      expect(read(a.id).stage).toBe('accepted');
      expect(adapter.isCurrent(first.lease)).toBe(false);
      expect(read(a.id).failure).toBe('deadline_expired');
    } finally {
      otherDb.close();
    }
  });

  it('restarts after accepted and after a prepared file publication without resetting attempts', () => {
    const a = accept();
    reopen();
    const initial = adapter.claim(a.id)!,
      work = adapter.beginAttempt(initial.lease, 'download')!;
    const data = {
      relativePath: work.destinationRelativePath!,
      bytes: 21,
      sha256: digest,
    };
    const prepared = adapter.prepareDownload(work, data)!;
    previousOwnerDied();
    reopen();
    const recovered = adapter.claim(a.id)!;
    expect(recovered.job.preparedDownload).toEqual(data);
    expect(recovered.job.downloadAttempts).toBe(1);
    expect(adapter.checkpointDownload(prepared, data)).toBeUndefined();
    const resume = adapter.beginAttempt(recovered.lease, 'download')!;
    expect(resume.attempt).toBe(1);
    expect(resume.destinationRelativePath).toBe(data.relativePath);
    expect(
      adapter.checkpointDownload(resume, { ...data, sha256: 'a'.repeat(64) }),
    ).toBeUndefined();
    expect(adapter.checkpointDownload(resume, data)?.job.stage).toBe(
      'downloaded',
    );
  });

  it('reuses a committed transcript after restart without another STT pipeline', () => {
    const a = accept();
    toTranscribed(a.id, 'Exact persisted wording');
    previousOwnerDied();
    reopen();
    const recovered = adapter.claim(a.id)!;
    expect(recovered.job.transcribed?.text).toBe('Exact persisted wording');
    expect(adapter.beginAttempt(recovered.lease, 'transcribe')).toBeUndefined();
    expect(adapter.materialize(recovered.lease).kind).toBe('materialized');
    expect(read(a.id).transcriptionAttempts).toBe(1);
    reopen();
    expect(pendingMediaIntakeDispatches(db)).toEqual([
      { jobId: a.id, chatJid: scope.chatJid },
    ]);
  });

  it('charges download reservations before work and keeps caps and deadline through crashes', () => {
    const a = accept(),
      first = adapter.claim(a.id)!;
    const download1 = adapter.beginAttempt(first.lease, 'download')!;
    expect(read(a.id).downloadAttempts).toBe(1);
    previousOwnerDied();
    reopen();
    time += 1000;
    const second = adapter.claim(a.id)!,
      download2 = adapter.beginAttempt(second.lease, 'download')!;
    expect(download1.destinationRelativePath).not.toBe(
      download2.destinationRelativePath,
    );
    expect(download2.job.deadlineAtMs).toBe(a.deadlineAtMs);
    previousOwnerDied();
    reopen();
    const third = adapter.claim(a.id)!;
    expect(adapter.beginAttempt(third.lease, 'download')).toBeUndefined();
    expect(read(a.id)).toMatchObject({
      stage: 'failed',
      failure: 'attempts_exhausted',
      downloadAttempts: 2,
    });
  });

  it('permits only the second technical/interrupted STT pipeline, never quality retries', () => {
    const a = accept(),
      downloaded = toDownloaded(a.id);
    const first = adapter.beginAttempt(downloaded.lease, 'transcribe')!;
    adapter.failAttempt(first, 'transcription_technical_error');
    const retry = adapter.claim(a.id)!,
      second = adapter.beginAttempt(retry.lease, 'transcribe')!;
    expect(second.job.transcriptionAttempts).toBe(2);
    adapter.failAttempt(second, 'transcription_timeout');
    expect(adapter.claim(a.id)).toBeUndefined();
    expect(read(a.id).stage).toBe('failed');
    const b = accept(input('quality'));
    const nullResult = toTranscribed(b.id, null);
    expect(
      adapter.beginAttempt(nullResult.lease, 'transcribe'),
    ).toBeUndefined();
    expect(adapter.materialize(nullResult.lease).kind).toBe('failed');
    expect(read(b.id).transcriptionAttempts).toBe(1);
    expect(
      db.prepare('SELECT content FROM messages WHERE id=?').get('quality'),
    ).toEqual({ content: '' });
  });

  it('preserves a caption on unusable audio as one ordinary input, without a second notice', () => {
    const a = accept(
      input('caption', { caption: 'Keep this explicit text request' }),
    );
    const ready = toTranscribed(a.id, null);
    expect(adapter.materialize(ready.lease).kind).toBe('materialized');
    expect(
      db.prepare('SELECT content FROM messages WHERE id=?').get('caption'),
    ).toEqual({
      content:
        '[Voice — transcription unavailable] Keep this explicit text request',
    });
    expect(claimMediaIntakeNotice(db)).toBeUndefined();
  });

  it('preserves the exact caption after terminal download failure without a second notice', () => {
    const a = accept(
      input('technical-caption', { caption: 'Use this original text request' }),
    );
    const first = adapter.beginAttempt(adapter.claim(a.id)!.lease, 'download')!;
    expect(first.destinationRelativePath).not.toContain(first.lease.token);
    adapter.failAttempt(first, 'transport_failure');
    const second = adapter.beginAttempt(
      adapter.claim(a.id)!.lease,
      'download',
    )!;
    adapter.failAttempt(second, 'transport_failure');
    expect(read(a.id)).toMatchObject({
      stage: 'failed',
      failure: 'transport_failure',
      transcriptionAttempts: 0,
    });
    expect(
      db
        .prepare('SELECT content FROM messages WHERE id=?')
        .get('technical-caption'),
    ).toEqual({
      content:
        '[Voice — media unavailable: transport_failure] Use this original text request',
    });
    expect(claimMediaIntakeNotice(db)).toBeUndefined();
    expect(pendingMediaIntakeDispatches(db)).toEqual([
      { jobId: a.id, chatJid: scope.chatJid },
    ]);
    expect(
      db.prepare('SELECT count(*) AS n FROM message_ingestion').get(),
    ).toEqual({ n: 1 });
  });

  it('never executes a caption after revocation, changed source or cancellation', () => {
    const a = accept(input('revoked-caption', { caption: 'Original caption' }));
    const lease = adapter.claim(a.id)!.lease;
    admitted = false;
    expect(adapter.isCurrent(lease)).toBe(false);
    expect(
      db
        .prepare('SELECT content FROM messages WHERE id=?')
        .get('revoked-caption'),
    ).toEqual({ content: '' });
    admitted = true;
    const b = accept(input('changed-caption', { caption: 'Original caption' }));
    adapter.terminate(adapter.claim(b.id)!.lease, 'source_changed');
    expect(
      db
        .prepare('SELECT content FROM messages WHERE id=?')
        .get('changed-caption'),
    ).toEqual({ content: '' });
    const c = accept(
      input('cancelled-caption', { caption: 'Original caption' }),
    );
    cancelMediaIntakeBefore(db, scope, 'fixture-sender', c.ingestionCursor);
    expect(
      db
        .prepare('SELECT content FROM messages WHERE id=?')
        .get('cancelled-caption'),
    ).toEqual({ content: '' });
  });

  it('applies capacity to media processing while retaining its already-admitted caption once', () => {
    for (let i = 0; i < 32; i++) accept(input(`capacity-held-${i}`));
    const denied = adapter.accept(
      input('capacity-caption', {
        caption: 'Original caption despite media capacity',
      }),
    );
    expect(denied).toMatchObject({
      kind: 'rejected',
      reason: 'capacity',
      job: { stage: 'failed' },
    });
    expect(
      db
        .prepare('SELECT content FROM messages WHERE id=?')
        .get('capacity-caption'),
    ).toEqual({
      content:
        '[Voice — media unavailable: capacity] Original caption despite media capacity',
    });
    expect(claimMediaIntakeNotice(db)).toBeUndefined();
  });

  it('fences cancelled results, enforces sender/cutoff, and retains newer input', () => {
    const a = accept(),
      work = adapter.beginAttempt(adapter.claim(a.id)!.lease, 'download')!;
    const b = accept(input('after-stop'));
    expect(
      cancelMediaIntakeBefore(db, scope, 'different-sender', b.ingestionCursor),
    ).toBe(0);
    expect(
      cancelMediaIntakeBefore(
        db,
        { ...scope, tenantId: 'other' },
        'fixture-sender',
        b.ingestionCursor,
      ),
    ).toBe(0);
    expect(
      cancelMediaIntakeBefore(db, scope, 'fixture-sender', a.ingestionCursor),
    ).toBe(1);
    expect(
      adapter.prepareDownload(work, {
        relativePath: work.destinationRelativePath!,
        bytes: 21,
        sha256: digest,
      }),
    ).toBeUndefined();
    expect(adapter.materialize(work.lease).kind).toBe('cancelled');
    expect(adapter.isCurrent(work.lease)).toBe(false);
    expect(earliestMediaIntakeCursor(db, scope.chatJid)).toBe(
      b.ingestionCursor,
    );
    expect(adapter.claim(b.id)).toBeDefined();
    expect(claimMediaIntakeNotice(db)).toBeUndefined();
  });

  it('distinguishes temporary holds from access revocation and never revives a changed scope', () => {
    const a = accept();
    runnable = false;
    expect(adapter.claim(a.id)).toBeUndefined();
    expect(read(a.id).stage).toBe('accepted');
    runnable = true;
    const work = adapter.claim(a.id)!;
    runnable = false;
    adapter.release(work.lease, 'interrupted');
    runnable = true;
    expect(adapter.claim(a.id)).toBeDefined();
    admitted = false;
    const row = db
      .prepare(
        'SELECT lease_token,revision FROM media_intake_jobs WHERE job_id=?',
      )
      .get(a.id) as { lease_token: string; revision: number };
    expect(
      adapter.isCurrent({
        jobId: a.id,
        token: row.lease_token,
        revision: row.revision,
      }),
    ).toBe(false);
    expect(read(a.id).failure).toBe('access_revoked');
    admitted = true;
    const b = accept(input('scope-change'));
    activeScope = { ...scope, tenantId: 'replacement-tenant' };
    expect(adapter.claim(b.id)).toBeUndefined();
    expect(read(b.id).failure).toBe('scope_changed');
  });

  it('does not reclaim foreign-host, reused-PID or permission-unknown owners', () => {
    const a = accept();
    adapter.claim(a.id);
    db.prepare('UPDATE media_intake_owners SET owner_id=?').run(
      'synthetic-other-owner',
    );
    db.prepare('UPDATE media_intake_jobs SET owner_id=?').run(
      'synthetic-other-owner',
    );
    expect(adapter.claim(a.id)).toBeUndefined();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('fixture'), { code: 'EPERM' });
    });
    try {
      expect(adapter.claim(a.id)).toBeUndefined();
    } finally {
      kill.mockRestore();
    }
    db.prepare("UPDATE media_intake_owners SET host_key='other-host'").run();
    const gone = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('fixture'), { code: 'ESRCH' });
    });
    try {
      expect(adapter.claim(a.id)).toBeUndefined();
      expect(gone).not.toHaveBeenCalled();
    } finally {
      gone.mockRestore();
    }
  });

  it('allows release after a committed checkpoint even when caller retained the older revision', () => {
    const a = accept(),
      claim = adapter.claim(a.id)!,
      work = adapter.beginAttempt(claim.lease, 'download')!;
    const prepared = adapter.prepareDownload(work, {
      relativePath: work.destinationRelativePath!,
      bytes: 21,
      sha256: digest,
    })!;
    adapter.release(claim.lease, 'shutdown');
    expect(adapter.isCurrent(prepared.lease)).toBe(false);
    const next = adapter.claim(a.id)!;
    expect(next.lease.token).not.toBe(claim.lease.token);
    adapter.release(claim.lease, 'shutdown');
    expect(adapter.isCurrent(next.lease)).toBe(true);
  });

  it('never promotes a caller-modified attempt snapshot or arbitrary path into authority', () => {
    const a = accept(),
      work = adapter.beginAttempt(adapter.claim(a.id)!.lease, 'download')!;
    const forged = {
      ...work,
      job: {
        ...work.job,
        scope: { ...work.job.scope, chatJid: 'other-chat' },
        downloadAttempts: 0,
      },
      destinationRelativePath: '../../escape',
      attempt: 0,
    };
    expect(
      adapter.prepareDownload(forged, {
        relativePath: '../../escape',
        bytes: 21,
        sha256: digest,
      }),
    ).toBeUndefined();
    const actual = {
      relativePath: work.destinationRelativePath!,
      bytes: 21,
      sha256: digest,
    };
    expect(adapter.checkpointDownload(work, actual)).toBeUndefined();
    const prepared = adapter.prepareDownload(forged, actual)!;
    expect(prepared.job.scope.chatJid).toBe(scope.chatJid);
    expect(prepared.attempt).toBe(1);
    expect(adapter.checkpointDownload(work, actual)).toBeUndefined(); // stale revision
  });

  it('makes capacity rejection durable and coalesces its pending host notice', () => {
    for (let i = 0; i < 32; i++) accept(input(`pending-${i}`));
    const denied = adapter.accept(input('capacity-1'));
    expect(denied).toMatchObject({
      kind: 'rejected',
      reason: 'capacity',
      job: { stage: 'failed', failure: 'capacity' },
    });
    expect(adapter.accept(input('capacity-2'))).toMatchObject({
      kind: 'rejected',
      reason: 'capacity',
    });
    expect(
      db.prepare('SELECT count(*) AS n FROM media_intake_notices').get(),
    ).toEqual({ n: 1 });
    reopen();
    expect(adapter.accept(input('capacity-1'))).toMatchObject({
      kind: 'duplicate',
      job: { stage: 'failed' },
    });
  });

  it('returns one FIFO head per chat so a paused backlog cannot hide another chat', () => {
    const otherScope = {
      ...scope,
      chatJid: 'tg:second-chat',
      groupFolder: 'telegram_second',
    };
    const fair = createMediaIntakeStore(db, {
      ...options(),
      resolveScope: (source) =>
        source.message.chat_jid === scope.chatJid ? scope : otherScope,
      canProcess: (owner) => owner.chatJid !== scope.chatJid,
    });
    for (let i = 0; i < 32; i++)
      expect(fair.accept(input(`held-${i}`)).kind).toBe('accepted');
    const other = input('eligible');
    other.message.chat_jid = otherScope.chatJid;
    const accepted = fair.accept(other);
    if (accepted.kind !== 'accepted') throw new Error('Expected fixture');
    const candidates = fair.listReady(32);
    expect(candidates.map((candidate) => candidate.input.message.id)).toEqual([
      'held-0',
      'eligible',
    ]);
    expect(fair.claim(candidates[0].id)).toBeUndefined();
    expect(fair.claim(accepted.job.id)).toBeDefined();
    expect(candidates[0].stage).toBe('accepted');
  });

  it('claims notices before send, filters current access, and never retries unknown sends', () => {
    const a = accept();
    const ready = toTranscribed(a.id, null);
    adapter.materialize(ready.lease);
    expect(
      claimMediaIntakeNotice(db, { canDeliver: () => false }),
    ).toBeUndefined();
    const notice = claimMediaIntakeNotice(db, {
      canDeliver: (entry, source) =>
        entry.jobId === a.id && source.scope.tenantId === scope.tenantId,
    })!;
    expect(notice.reason).toBe('transcription_unusable');
    expect(claimMediaIntakeNotice(db)).toBeUndefined();
    previousOwnerDied();
    reopen();
    expect(claimMediaIntakeNotice(db)).toBeUndefined();
    expect(db.prepare('SELECT status FROM media_intake_notices').get()).toEqual(
      { status: 'unknown' },
    );
    settleMediaIntakeNotice(db, notice.id, 'confirmed');
    expect(db.prepare('SELECT status FROM media_intake_notices').get()).toEqual(
      { status: 'unknown' },
    );
  });

  it('does not let a blocked notice starve a later eligible chat', () => {
    const a = accept();
    adapter.terminate(adapter.claim(a.id)!.lease, 'source_unavailable');
    activeScope = {
      ...scope,
      chatJid: 'tg:another-fixture',
      groupFolder: 'telegram_other',
    };
    const secondInput = input('second');
    secondInput.message.chat_jid = activeScope.chatJid;
    const b = accept(secondInput);
    adapter.terminate(adapter.claim(b.id)!.lease, 'source_unavailable');
    const notice = claimMediaIntakeNotice(db, {
      canDeliver: (entry) => entry.chatJid === activeScope.chatJid,
    })!;
    expect(notice.jobId).toBe(b.id);
    settleMediaIntakeNotice(db, notice.id, 'confirmed');
    expect(
      claimMediaIntakeNotice(db, { canDeliver: () => false }),
    ).toBeUndefined();
  });

  it('preserves original source metadata and does not silently promote unknown origin', () => {
    const source = input();
    delete source.message.sender_identity!.telegram_message_origin;
    const a = accept(source);
    const done = toTranscribed(a.id);
    adapter.materialize(done.lease);
    reopen();
    expect(
      read(a.id).input.message.sender_identity!.telegram_message_origin,
    ).toBeUndefined();
    const metadata = db
      .prepare('SELECT sender_identity_json FROM message_metadata')
      .get() as { sender_identity_json: string };
    expect(
      JSON.parse(metadata.sender_identity_json).telegram_message_origin,
    ).toBeUndefined();
  });

  it('fails closed on unavailable persistence and rejects bounded-input violations', () => {
    expect(
      adapter.accept(input('oversized', { caption: 'x'.repeat(4097) })),
    ).toEqual({ kind: 'rejected', reason: 'source_conflict' });
    db.close();
    expect(() => adapter.accept(input())).toThrowError(
      'Media intake persistence unavailable',
    );
    expect(() => ensureMediaIntakeSchema(db)).toThrow(
      MediaIntakePersistenceError,
    );
  });
});
