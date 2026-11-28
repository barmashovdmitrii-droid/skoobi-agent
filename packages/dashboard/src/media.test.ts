import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { MediaEntry } from '@skoobi/shared/media-manifest';

import {
  listDashboardMediaForMessages,
  parseDashboardMediaRange,
  serveDashboardMedia,
} from './media.js';

const temporaryRoots: string[] = [];
const servers: http.Server[] = [];

async function fixture(entryOverrides: Partial<MediaEntry> = {}): Promise<{
  groupsRoot: string;
  folder: string;
  entry: MediaEntry;
  body: Buffer;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-media-test-'));
  temporaryRoots.push(root);
  const groupsRoot = path.join(root, 'groups');
  const folder = path.join(groupsRoot, 'telegram_main');
  fs.mkdirSync(path.join(folder, 'received'), { recursive: true });
  const body = Buffer.from('local-media-body');
  const entry: MediaEntry = {
    message_id: 'message-42',
    chat_jid: 'tg:123456789',
    basename: 'voice-42.ogg',
    type: 'voice',
    size_bytes: body.length,
    has_transcript: true,
    has_caption: false,
    transcript_chars: 12,
    created_at: '2026-07-15T10:00:00.000Z',
    keep: false,
    ...entryOverrides,
  };
  fs.writeFileSync(
    path.join(folder, '.media-index.jsonl'),
    `${JSON.stringify(entry)}\n`,
    { mode: 0o600 },
  );
  if (
    typeof entry.basename === 'string' &&
    !entry.basename.includes('/') &&
    !entry.basename.includes('\\')
  ) {
    fs.writeFileSync(path.join(folder, 'received', entry.basename), body);
  }
  return { groupsRoot, folder, entry, body };
}

async function listenMedia(
  groupsRoot: string,
  params: { jid: string; messageId: string; mediaId: string },
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const result = await serveDashboardMedia(req, res, params, groupsRoot);
    if (result === 'not-found') {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('dashboard local media index', () => {
  it('returns only an opaque descriptor for an existing indexed file', async () => {
    const { groupsRoot, entry } = await fixture();
    const indexed = await listDashboardMediaForMessages(
      entry.chat_jid,
      [entry.message_id],
      groupsRoot,
    );
    const media = indexed.get(entry.message_id);
    expect(media).toHaveLength(1);
    expect(media?.[0]).toMatchObject({
      kind: 'audio',
      type: 'voice',
      label: 'Голосовое',
      mime: 'audio/ogg',
    });
    expect(media?.[0].mediaId).toMatch(/^[a-f0-9]{24}$/u);
    expect(JSON.stringify(media)).not.toContain(entry.basename);
    expect(JSON.stringify(media)).not.toContain(groupsRoot);
  });

  it('does not expose deleted, missing, traversal, symlink, or wrong-chat files', async () => {
    const missing = await fixture({ basename: 'missing.ogg' });
    fs.unlinkSync(path.join(missing.folder, 'received', 'missing.ogg'));
    expect(
      (
        await listDashboardMediaForMessages(
          missing.entry.chat_jid,
          [missing.entry.message_id],
          missing.groupsRoot,
        )
      ).size,
    ).toBe(0);

    const traversal = await fixture({ basename: '../../../secret.txt' });
    expect(
      (
        await listDashboardMediaForMessages(
          traversal.entry.chat_jid,
          [traversal.entry.message_id],
          traversal.groupsRoot,
        )
      ).size,
    ).toBe(0);

    const symlinked = await fixture({ basename: 'linked.ogg' });
    const linkedPath = path.join(symlinked.folder, 'received', 'linked.ogg');
    fs.unlinkSync(linkedPath);
    fs.symlinkSync('/etc/hosts', linkedPath);
    expect(
      (
        await listDashboardMediaForMessages(
          symlinked.entry.chat_jid,
          [symlinked.entry.message_id],
          symlinked.groupsRoot,
        )
      ).size,
    ).toBe(0);

    const valid = await fixture();
    expect(
      (
        await listDashboardMediaForMessages(
          'tg:999999999',
          [valid.entry.message_id],
          valid.groupsRoot,
        )
      ).size,
    ).toBe(0);
  });
});

describe('dashboard media byte ranges', () => {
  it('parses regular, open-ended, and suffix ranges', () => {
    expect(parseDashboardMediaRange(undefined, 100)).toBeNull();
    expect(parseDashboardMediaRange('bytes=10-19', 100)).toEqual({
      start: 10,
      end: 19,
    });
    expect(parseDashboardMediaRange('bytes=90-', 100)).toEqual({
      start: 90,
      end: 99,
    });
    expect(parseDashboardMediaRange('bytes=-7', 100)).toEqual({
      start: 93,
      end: 99,
    });
  });

  it.each([
    'bytes=100-101',
    'bytes=20-10',
    'bytes=',
    'items=1-2',
    'bytes=1-2,4-5',
  ])('rejects malformed or unsatisfiable range %s', (value) => {
    expect(() => parseDashboardMediaRange(value, 100)).toThrow(RangeError);
  });

  it('streams the verified file and supports partial playback', async () => {
    const { groupsRoot, entry, body } = await fixture();
    const descriptor = (
      await listDashboardMediaForMessages(
        entry.chat_jid,
        [entry.message_id],
        groupsRoot,
      )
    ).get(entry.message_id)?.[0];
    expect(descriptor).toBeTruthy();
    const base = await listenMedia(groupsRoot, {
      jid: entry.chat_jid,
      messageId: entry.message_id,
      mediaId: descriptor!.mediaId,
    });

    const complete = await fetch(base);
    expect(complete.status).toBe(200);
    expect(complete.headers.get('content-type')).toBe('audio/ogg');
    expect(complete.headers.get('content-disposition')).toContain('inline');
    expect(Buffer.from(await complete.arrayBuffer())).toEqual(body);

    const partial = await fetch(base, { headers: { Range: 'bytes=2-6' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(
      `bytes 2-6/${body.length}`,
    );
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(
      body.subarray(2, 7),
    );

    const invalid = await fetch(base, {
      headers: { Range: `bytes=${body.length}-` },
    });
    expect(invalid.status).toBe(416);
  });

  it('returns not-found when the opaque id is altered', async () => {
    const { groupsRoot, entry } = await fixture();
    const base = await listenMedia(groupsRoot, {
      jid: entry.chat_jid,
      messageId: entry.message_id,
      mediaId: '000000000000000000000000',
    });
    expect((await fetch(base)).status).toBe(404);
  });
});
