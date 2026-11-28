import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createSchema, migrateMessageIngestionCursors } from '@skoobi/core/db';
import {
  createMediaIntakeStore,
  ensureMediaIntakeSchema,
} from '@skoobi/core/media-intake-store';
import type { NewMessage } from '@skoobi/shared/channel-types';
import type {
  MediaIntakeInput,
  MediaIntakeScope,
} from '@skoobi/shared/media-intake';
import { MediaIntakeWorker } from './media-intake-worker.js';
import type { LocalTranscriptionResult } from '@skoobi/shared/transcription-result';

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
    JSON.stringify(message.sender_identity),
  );
}

describe('media worker with real durable SQLite adapter', () => {
  it.each(['retry', 'empty', 'cancelled'] as const)(
    'persists detailed %s evidence without a second hidden legacy pipeline',
    async (mode) => {
      const root = await fs.mkdtemp(path.join(tmpdir(), 'media-typed-sqlite-'));
      const filename = path.join(root, 'fixture.db');
      let db = new Database(filename);
      const scope: MediaIntakeScope = {
        botId: 'fixture',
        tenantId: 'fixture',
        chatJid: 'tg:fixture:101',
        groupFolder: 'fixture',
      };
      const options = {
        botId: 'fixture',
        resolveScope: () => scope,
        isAdmitted: () => true,
        writeMessage,
      };
      const input: MediaIntakeInput = {
        message: {
          id: 'typed',
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
        ...(mode === 'cancelled'
          ? { caption: 'Synthetic caption must not run' }
          : {}),
      };
      const base: LocalTranscriptionResult = {
        schema: 1,
        status: 'technical_error',
        text: null,
        originalText: null,
        selectedPassIndex: null,
        passes: [],
        recheck: {
          reason: null,
          comparison: 'not_run',
          comparedPassIndices: [],
        },
        uncertainty: [],
        ambiguities: [],
        error: { stage: 'whisper', code: 'process_timeout', retryable: true },
        metrics: { queueWaitMs: 0, processingMs: 10, audioDurationMs: 1000 },
      };
      const success: LocalTranscriptionResult = {
        ...base,
        status: 'success',
        text: 'Exact text',
        originalText: 'Exact text',
        selectedPassIndex: 1,
        passes: [
          {
            index: 1,
            requestedLanguage: 'auto',
            detectedLanguage: 'en',
            languageProbability: 0.99,
            meanTokenLogProbability: -0.01,
            text: 'Exact text',
            valid: true,
            invalidReason: null,
            outcome: 'completed',
          },
        ],
      };
      delete success.error;
      const empty: LocalTranscriptionResult = {
        ...base,
        status: 'empty',
        emptyReason: 'no_speech',
        originalText: '[BLANK_AUDIO]',
        passes: [
          {
            index: 1,
            requestedLanguage: 'auto',
            detectedLanguage: 'en',
            languageProbability: 0.99,
            meanTokenLogProbability: null,
            text: '[BLANK_AUDIO]',
            valid: false,
            invalidReason: 'no_speech',
            outcome: 'completed',
          },
        ],
      };
      delete empty.error;
      const cancelled: LocalTranscriptionResult = {
        ...base,
        status: 'cancelled',
        error: { stage: 'queue', code: 'aborted', retryable: false },
      };
      const transcribe = vi.fn(async () => {
        throw new Error('Legacy fallback must not execute');
      });
      const transcribeDetailed = vi.fn(async () =>
        mode === 'empty' ? empty : mode === 'cancelled' ? cancelled : base,
      );
      if (mode === 'retry')
        transcribeDetailed
          .mockResolvedValueOnce(base)
          .mockResolvedValueOnce(success);
      const download = vi.fn(
        async (_job: unknown, control: { destinationPath: string }) => {
          await fs.writeFile(control.destinationPath, 'synthetic audio', {
            flag: 'wx',
          });
        },
      );
      try {
        createSchema(db);
        migrateMessageIngestionCursors(db);
        ensureMediaIntakeSchema(db);
        const adapter = createMediaIntakeStore(db, options);
        expect(adapter.accept(input).kind).toBe('accepted');
        const worker = new MediaIntakeWorker({
          adapter,
          groupDirectory: () => root,
          download,
          transcribe,
          transcribeDetailed,
        });
        await worker.wake();
        await worker.stop();
        const row = db
          .prepare('SELECT stage,job_json FROM media_intake_jobs')
          .get() as { stage: string; job_json: string };
        expect(row.stage).toBe(
          mode === 'retry'
            ? 'materialized'
            : mode === 'empty'
              ? 'failed'
              : 'cancelled',
        );
        const job = JSON.parse(row.job_json);
        expect(
          job.transcriptionAttemptsEvidence.map(
            (item: LocalTranscriptionResult) => item.status,
          ),
        ).toEqual(
          mode === 'retry'
            ? ['technical_error', 'success']
            : mode === 'empty'
              ? ['empty']
              : ['cancelled'],
        );
        expect(transcribeDetailed).toHaveBeenCalledTimes(
          mode === 'retry' ? 2 : 1,
        );
        expect(transcribe).not.toHaveBeenCalled();
        expect(download).toHaveBeenCalledTimes(1);
        expect(db.prepare('SELECT content FROM messages').all()).toEqual([
          { content: mode === 'retry' ? '[Voice: Exact text]' : '' },
        ]);
        expect(
          db.prepare('SELECT count(*) AS count FROM message_ingestion').get(),
        ).toEqual({ count: 1 });
        expect(
          db
            .prepare('SELECT count(*) AS count FROM media_intake_notices')
            .get(),
        ).toEqual({ count: mode === 'empty' ? 1 : 0 });
        db.close();
        db = new Database(filename);
        await new MediaIntakeWorker({
          adapter: createMediaIntakeStore(db, options),
          groupDirectory: () => root,
          download,
          transcribe,
          transcribeDetailed,
        }).wake();
        expect(transcribeDetailed).toHaveBeenCalledTimes(
          mode === 'retry' ? 2 : 1,
        );
      } finally {
        db.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['prepared', 'transcribed'] as const)(
    'reopens a %s checkpoint and delivers one input at the reserved cursor',
    async (checkpoint) => {
      const root = await fs.mkdtemp(
        path.join(tmpdir(), 'media-worker-sqlite-'),
      );
      const filename = path.join(root, 'fixture.db');
      let db = new Database(filename);
      const group = path.join(root, 'group');
      await fs.mkdir(group);
      const scope: MediaIntakeScope = {
        botId: 'fixture',
        tenantId: 'fixture',
        chatJid: 'tg:fixture:101',
        groupFolder: 'fixture',
      };
      const input: MediaIntakeInput = {
        message: {
          id: 'first',
          chat_jid: scope.chatJid,
          sender: '102',
          sender_name: 'Fixture',
          timestamp: '2026-01-01T00:00:00Z',
          sender_identity: {
            channel: 'telegram',
            chat_id: '101',
            telegram_user_id: '102',
            identity_id: 'fixture',
            bot_id: 'fixture',
            is_owner_sender: true,
            telegram_message_origin: 'forwarded',
          },
        },
        media: { kind: 'voice', fileId: 'synthetic-file' },
        isGroup: false,
      };
      const options = {
        botId: 'fixture',
        resolveScope: () => scope,
        isAdmitted: () => true,
        writeMessage,
      };
      try {
        createSchema(db);
        migrateMessageIngestionCursors(db);
        ensureMediaIntakeSchema(db);
        let adapter = createMediaIntakeStore(db, options);
        const accepted = adapter.accept(input);
        if (accepted.kind !== 'accepted')
          throw new Error('Fixture accept failed');
        const originalCursor = accepted.job.ingestionCursor;
        const claim = adapter.claim(accepted.job.id)!;
        const attempt = adapter.beginAttempt(claim.lease, 'download')!;
        const bytes = Buffer.from('synthetic audio');
        const artifact = {
          relativePath: attempt.destinationRelativePath!,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
        const final = path.join(group, artifact.relativePath);
        await fs.mkdir(path.dirname(final), { recursive: true });
        await fs.writeFile(final + '.part', bytes);
        const prepared = adapter.prepareDownload(attempt, artifact)!;
        let lease = prepared.lease;
        if (checkpoint === 'transcribed') {
          await fs.rename(final + '.part', final);
          const saved = adapter.checkpointDownload(prepared, artifact)!;
          const stt = adapter.beginAttempt(saved.lease, 'transcribe')!;
          lease = adapter.checkpointTranscription(stt, {
            text: 'Exact saved text',
            sourceSha256: artifact.sha256,
          })!.lease;
        }
        // Graceful interrupted worker releases ownership; reopening disk preserves
        // prepared/result evidence. Core tests separately exercise dead-PID claims.
        adapter.release(lease, 'interrupted');
        db.close();
        db = new Database(filename);
        db.pragma('foreign_keys = ON');
        adapter = createMediaIntakeStore(db, options);
        const download = vi.fn(async () => {
          throw new Error('Must reuse persisted source');
        });
        const transcribe = vi.fn(async (source: string) => {
          expect(await fs.readFile(source)).toEqual(bytes);
          return 'Exact saved text';
        });
        const worker = new MediaIntakeWorker({
          adapter,
          groupDirectory: () => group,
          download,
          transcribe,
        });
        await worker.wake();
        await worker.wake();
        await worker.stop();
        expect(download).not.toHaveBeenCalled();
        expect(transcribe).toHaveBeenCalledTimes(
          checkpoint === 'prepared' ? 1 : 0,
        );
        expect(
          db
            .prepare(
              "SELECT stage,json_extract(job_json,'$.failure') AS failure FROM media_intake_jobs",
            )
            .get(),
        ).toEqual({ stage: 'materialized', failure: null });
        expect(
          db
            .prepare('SELECT content FROM messages WHERE id=? AND chat_jid=?')
            .get(input.message.id, scope.chatJid),
        ).toEqual({ content: '[Voice: Exact saved text]' });
        const rows = db
          .prepare(
            'SELECT sequence FROM message_ingestion WHERE id=? AND chat_jid=?',
          )
          .all(input.message.id, scope.chatJid) as Array<{ sequence: number }>;
        expect(rows).toHaveLength(1);
        expect(`i:${String(rows[0].sequence).padStart(16, '0')}`).toBe(
          originalCursor,
        );
        expect(
          (
            db
              .prepare(
                'SELECT sender_identity_json FROM message_metadata WHERE id=? AND chat_jid=?',
              )
              .get(input.message.id, scope.chatJid) as {
              sender_identity_json: string;
            }
          ).sender_identity_json,
        ).toContain('forwarded');
        expect(adapter.accept(input).kind).toBe('already_materialized');
      } finally {
        db.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
