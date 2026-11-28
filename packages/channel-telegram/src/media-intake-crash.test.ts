import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  createMediaIntakeStore,
  pendingMediaIntakeDispatches,
} from '@skoobi/core/media-intake-store';
import { MediaIntakeWorker } from './media-intake-worker.js';

describe('real media-worker process interruption', () => {
  it.each([
    'accepted',
    'prepared',
    'downloaded',
    'transcribed',
    'materialized',
  ])(
    'survives SIGKILL after %s without replaying a confirmed stage',
    async (stage) => {
      const root = await fs.mkdtemp(
        path.join(tmpdir(), 'media-process-crash-'),
      );
      await fs.chmod(root, 0o700);
      const group = path.join(root, 'group');
      await fs.mkdir(group, { mode: 0o700 });
      const filename = path.join(root, 'fixture.db');
      const fixture = fileURLToPath(
        new URL('../test-fixtures/media-intake-crash.ts', import.meta.url),
      );
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', fixture, filename, group, stage],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            SKOOBI_TEST_STATE_ROOT: path.join(root, 'state'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const exited = once(child, 'exit');
      let diagnostic = '';
      child.stderr.on('data', (chunk) => {
        diagnostic = (diagnostic + String(chunk)).slice(-2000);
      });
      let db: Database.Database | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          let output = '';
          const timer = setTimeout(
            () => reject(new Error('Synthetic worker stage timeout')),
            10_000,
          );
          child.stdout.on('data', (chunk) => {
            output += String(chunk);
            if (output.split('\n').includes(stage)) {
              clearTimeout(timer);
              resolve();
            }
          });
          child.once('close', (code, signal) => {
            clearTimeout(timer);
            reject(
              new Error(
                'Synthetic worker exited before checkpoint: ' +
                  JSON.stringify({ code, signal, diagnostic, output }),
              ),
            );
          });
        });
        child.kill('SIGKILL');
        expect(await exited).toEqual([null, 'SIGKILL']);
        db = new Database(filename);
        db.pragma('foreign_keys = ON');
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
          writeMessage(
            database: Database.Database,
            message: { content: string; id: string; chat_jid: string },
          ) {
            expect(database.inTransaction).toBe(true);
            database
              .prepare(
                'UPDATE messages SET content=? WHERE id=? AND chat_jid=?',
              )
              .run(message.content, message.id, message.chat_jid);
          },
        };
        const original = db
          .prepare('SELECT sequence FROM message_ingestion')
          .get() as { sequence: number };
        const download = vi.fn(
          async (_job: unknown, control: { destinationPath: string }) => {
            await fs.appendFile(path.join(group, 'download-count'), '1\n');
            await fs.writeFile(control.destinationPath, 'synthetic audio', {
              flag: 'wx',
            });
          },
        );
        const transcribe = vi.fn(async () => {
          await fs.appendFile(path.join(group, 'transcription-count'), '1\n');
          return 'Exact synthetic text';
        });
        const worker = new MediaIntakeWorker({
          adapter: createMediaIntakeStore(db, options),
          groupDirectory: () => group,
          download,
          transcribe,
        });
        await worker.wake();
        await worker.wake();
        await worker.stop();
        expect(
          await fs.readFile(path.join(group, 'download-count'), 'utf8'),
        ).toBe('1\n');
        expect(
          await fs.readFile(path.join(group, 'transcription-count'), 'utf8'),
        ).toBe('1\n');
        expect(download).toHaveBeenCalledTimes(stage === 'accepted' ? 1 : 0);
        expect(transcribe).toHaveBeenCalledTimes(
          ['transcribed', 'materialized'].includes(stage) ? 0 : 1,
        );
        expect(db.prepare('SELECT content FROM messages').all()).toEqual([
          { content: '[Voice: Exact synthetic text]' },
        ]);
        expect(
          db.prepare('SELECT sequence FROM message_ingestion').all(),
        ).toEqual([original]);
        expect(db.prepare('SELECT stage FROM media_intake_jobs').get()).toEqual(
          { stage: 'materialized' },
        );
        expect(pendingMediaIntakeDispatches(db)).toEqual([
          { jobId: expect.any(String), chatJid: scope.chatJid },
        ]);
        db.close();
        db = new Database(filename);
        await new MediaIntakeWorker({
          adapter: createMediaIntakeStore(db, options),
          groupDirectory: () => group,
          download,
          transcribe,
        }).wake();
        expect(
          await fs.readFile(path.join(group, 'download-count'), 'utf8'),
        ).toBe('1\n');
        expect(
          await fs.readFile(path.join(group, 'transcription-count'), 'utf8'),
        ).toBe('1\n');
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
        db?.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
