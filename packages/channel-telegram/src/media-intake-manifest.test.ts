import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MediaIntakeJob } from '@skoobi/shared/media-intake';
import { listMedia } from '@skoobi/shared/media-manifest';

import {
  publishMaterializedMedia,
  receivedMediaName,
} from './media-intake-manifest.js';

let root: string;
let group: string;
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'media-intake-manifest-')),
  );
  group = path.join(root, 'telegram_main');
  await fs.mkdir(path.join(group, 'received', 'media-intake'), {
    recursive: true,
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const NOW = new Date('2026-11-05T09:02:04.070Z');
function job(over: Partial<MediaIntakeJob['input']> = {}): MediaIntakeJob {
  return {
    id: randomUUID(),
    revision: 3,
    scope: {
      botId: 'bot',
      tenantId: 'tenant',
      chatJid: 'tg:owner',
      groupFolder: 'telegram_main',
    },
    input: {
      message: {
        id: '27450',
        chat_jid: 'tg:owner',
        sender: '1',
        sender_name: 'Owner',
        timestamp: '2026-11-05T09:01:58.000Z',
      },
      media: { kind: 'voice', fileId: 'AwACAgIAAxkBAAIDeQADjrgXPQQ' },
      isGroup: false,
      ...over,
    },
    ingestionCursor: 'i:0000000000000001',
    acceptedAtMs: NOW.getTime(),
    deadlineAtMs: NOW.getTime() + 60_000,
    stage: 'materialized',
    downloadAttempts: 1,
    transcriptionAttempts: 1,
    transcribed: { text: 'Купи хлеба', sourceSha256: 'a'.repeat(64) },
  };
}

describe('media pipeline voice notes in the media manifest (W13)', () => {
  it('writes a flat received/ copy and the same entry the old path wrote', async () => {
    const bytes = Buffer.from('OggS synthetic voice');
    const entry = await publishMaterializedMedia({
      groupDirectory: group,
      job: job(),
      bytes,
      now: NOW,
    });
    expect(entry).toEqual({
      message_id: '27450',
      chat_jid: 'tg:owner',
      basename: receivedMediaName(job(), NOW),
      type: 'voice',
      size_bytes: bytes.length,
      has_transcript: true,
      has_caption: false,
      transcript_chars: 'Купи хлеба'.length,
      created_at: NOW.toISOString(),
      keep: false,
    });
    expect(entry!.basename).toMatch(
      /^2026-11-05T09-02-04-070Z-voice-[A-Za-z0-9_-]{1,8}\.oga$/,
    );
    const file = path.join(group, 'received', entry!.basename);
    expect(await fs.readFile(file)).toEqual(bytes);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await listMedia(group)).toEqual([entry]);
  });

  it('keeps an audio file extension and never overwrites an existing name', async () => {
    const audio = job({
      media: { kind: 'audio', fileId: 'CQACAgIAAxkB', fileName: 'Песня.MP3' },
      caption: 'послушай',
    });
    expect(receivedMediaName(audio, NOW)).toMatch(
      /-audio-[A-Za-z0-9_-]+\.mp3$/,
    );
    const first = await publishMaterializedMedia({
      groupDirectory: group,
      job: audio,
      bytes: Buffer.from('ID3 one'),
      now: NOW,
    });
    expect(first).toMatchObject({ type: 'audio', has_caption: true });
    await expect(
      publishMaterializedMedia({
        groupDirectory: group,
        job: audio,
        bytes: Buffer.from('ID3 two'),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(
      await fs.readFile(path.join(group, 'received', first!.basename), 'utf8'),
    ).toBe('ID3 one');
    expect(await listMedia(group)).toHaveLength(1);
  });

  it('writes nothing through a received/ that is a symlink', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.rm(path.join(group, 'received'), { recursive: true });
    await fs.symlink(elsewhere, path.join(group, 'received'));
    expect(
      await publishMaterializedMedia({
        groupDirectory: group,
        job: job(),
        bytes: Buffer.from('x'),
        now: NOW,
      }),
    ).toBeNull();
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });
});
