/**
 * Voice and audio of the durable media pipeline in the group's media
 * manifest (W13).
 *
 * Before the pipeline every voice note was saved as received/<ts>-voice-<tag>.oga
 * and listed in <group>/.media-index.jsonl; the dashboard's media tab, the
 * retention sweep and the offsite archive all read that manifest and the
 * flat received/ folder. The pipeline keeps its own copy under
 * received/media-intake/<job>/ and wrote no manifest entry at all: from then on
 * the media tab listed no voice notes for a chat at all. After a new
 * materialization the worker hands over the verified bytes; they are written
 * as a new flat file (never through an existing name or a symlinked
 * received/) and listed exactly like the old path did.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { MediaIntakeJob } from '@skoobi/shared/media-intake';
import {
  appendMediaEntry,
  isSafeMediaBasename,
  type MediaEntry,
} from '@skoobi/shared/media-manifest';

import { safeTelegramAudioFileTag } from './audio-telegram.js';

/** The received/ name the pre-04.11 path gave the same file. */
export function receivedMediaName(
  job: Readonly<MediaIntakeJob>,
  now: Date,
): string {
  const kind = job.input.media.kind;
  const named = path.extname(job.input.media.fileName ?? '').toLowerCase();
  const ext =
    kind === 'voice'
      ? '.oga'
      : /^\.[a-z0-9]{1,5}$/.test(named)
        ? named
        : '.mp3';
  const ts = now.toISOString().replace(/[:.]/g, '-');
  return `${ts}-${kind}-${safeTelegramAudioFileTag(job.input.media.fileId)}${ext}`;
}

/**
 * Write the verified bytes to received/ and append the manifest entry.
 * Returns the entry, or null when received/ is not a plain directory of the
 * group. Throws on a storage error; the caller logs it.
 */
export async function publishMaterializedMedia(input: {
  groupDirectory: string;
  job: Readonly<MediaIntakeJob>;
  bytes: Buffer;
  now?: Date;
}): Promise<MediaEntry | null> {
  const now = input.now ?? new Date();
  const groupReal = await fs.realpath(input.groupDirectory);
  const received = path.join(groupReal, 'received');
  const stat = await fs.lstat(received);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  const name = receivedMediaName(input.job, now);
  if (!isSafeMediaBasename(name)) return null;
  const target = path.join(received, name);
  // 'wx': a new file only — never over an existing name or a planted link.
  await fs.writeFile(target, input.bytes, { flag: 'wx', mode: 0o600 });
  if (path.dirname(await fs.realpath(target)) !== received) {
    // received/ was swapped for a link meanwhile: take the file back.
    await fs.unlink(target).catch(() => undefined);
    return null;
  }
  const transcript = input.job.transcribed?.text ?? '';
  const entry: MediaEntry = {
    message_id: input.job.input.message.id,
    chat_jid: input.job.scope.chatJid,
    basename: name,
    type: input.job.input.media.kind,
    size_bytes: input.bytes.length,
    has_transcript: transcript.length > 0,
    has_caption: Boolean(input.job.input.caption?.trim()),
    transcript_chars: transcript.length,
    created_at: now.toISOString(),
    keep: false,
  };
  await appendMediaEntry(input.groupDirectory, entry);
  return entry;
}
