import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { appendMediaEntry, listMedia } from '@skoobi/shared/media-manifest';
import {
  storageOverview,
  storageForFolder,
  pinLastMedia,
  folderBytes,
  humanBytes,
} from './admin-storage.js';

describe('admin-storage helpers', () => {
  let groupsDir: string;

  beforeEach(async () => {
    groupsDir = await fs.mkdtemp(path.join(tmpdir(), 'admin-storage-'));
    const a = path.join(groupsDir, 'group_a', 'received');
    await fs.mkdir(a, { recursive: true });
    await fs.writeFile(path.join(a, 'one.oga'), Buffer.alloc(1024));
    await appendMediaEntry(path.join(groupsDir, 'group_a'), {
      message_id: '1',
      chat_jid: 'tg:1',
      basename: 'one.oga',
      type: 'voice',
      size_bytes: 1024,
      has_transcript: true,
      has_caption: false,
      transcript_chars: 4,
      created_at: '2026-05-10T00:00:00Z',
      keep: false,
    });

    const b = path.join(groupsDir, 'group_b', 'received');
    await fs.mkdir(b, { recursive: true });
    await fs.writeFile(path.join(b, 'pic.jpg'), Buffer.alloc(2048));
    await appendMediaEntry(path.join(groupsDir, 'group_b'), {
      message_id: '1',
      chat_jid: 'tg:2',
      basename: 'pic.jpg',
      type: 'photo',
      size_bytes: 2048,
      has_transcript: false,
      has_caption: true,
      transcript_chars: 0,
      created_at: '2026-05-09T00:00:00Z',
      keep: false,
    });
  });

  afterEach(async () => {
    await fs.rm(groupsDir, { recursive: true, force: true });
  });

  it('folderBytes sums file sizes recursively', async () => {
    const bytes = await folderBytes(path.join(groupsDir, 'group_a'));
    expect(bytes).toBeGreaterThanOrEqual(1024);
  });

  it('humanBytes formats common scales', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(2048)).toMatch(/KB$/);
    expect(humanBytes(5 * 1024 * 1024)).toMatch(/MB$/);
    expect(humanBytes(3 * 1024 * 1024 * 1024)).toMatch(/GB$/);
  });

  it('storageOverview lists groups sorted by size and never leaks absolute paths', async () => {
    const out = await storageOverview(groupsDir);
    expect(out).not.toContain('/Users/example/');
    expect(out).not.toContain(groupsDir);
    expect(out).toContain('group_a');
    expect(out).toContain('group_b');
    // Top types section should mention voice / photo
    expect(out).toMatch(/voice|photo/);
  });

  it('storageForFolder reports manifest counts and pinned count', async () => {
    const out = await storageForFolder(groupsDir, 'group_a');
    expect(out).toContain('group_a');
    expect(out).toContain('Manifest entries: 1');
    expect(out).toContain('voice');
    expect(out).not.toContain('/Users/example/');
  });

  it('storageForFolder handles missing folders gracefully', async () => {
    const out = await storageForFolder(groupsDir, 'nope');
    expect(out).toContain('не найдена');
  });

  it('pinLastMedia flips keep on the most recent entry', async () => {
    const out = await pinLastMedia(groupsDir, 'group_a');
    expect(out).toMatch(/^Pinned: one\.oga$/);
    const media = await listMedia(path.join(groupsDir, 'group_a'));
    expect(media[0].keep).toBe(true);
  });

  it('pinLastMedia reports gracefully when manifest is empty', async () => {
    const empty = path.join(groupsDir, 'group_c');
    await fs.mkdir(empty, { recursive: true });
    const out = await pinLastMedia(groupsDir, 'group_c');
    expect(out).toContain('нет медиа');
  });

  // --- L20/L2: path traversal on unvalidated folder argument ---

  it('storageForFolder rejects path traversal and never reads outside groupsDir', async () => {
    // A sentinel directory living OUTSIDE groupsDir (as a sibling). Before the
    // containment guard, `path.join(groupsDir, '../<sibling>')` would resolve
    // into it and report its recursive size back to the caller.
    const parent = path.dirname(groupsDir);
    const sentinel = await fs.mkdtemp(path.join(parent, 'admin-storage-secret-'));
    try {
      await fs.writeFile(path.join(sentinel, 'leak.bin'), Buffer.alloc(4096));
      const rel = `../${path.basename(sentinel)}`;
      const out = await storageForFolder(groupsDir, rel);
      // Must be treated as a non-existent group, not enumerated.
      expect(out).toBe(`Группа ${rel} не найдена.`);
    } finally {
      await fs.rm(sentinel, { recursive: true, force: true });
    }
  });

  it('pinLastMedia rejects path traversal in the folder argument', async () => {
    const out = await pinLastMedia(groupsDir, '../../../../etc');
    expect(out).toContain('не найдена');
    // It must not have pinned anything (no success message).
    expect(out).not.toMatch(/^Pinned:/);
  });

  it.each(['..', 'a/b', 'a\\b', '../group_a'])(
    'storageForFolder refuses invalid folder name %j',
    async (bad) => {
      const out = await storageForFolder(groupsDir, bad);
      expect(out).toContain('не найдена');
      expect(out).not.toContain('Manifest entries');
    },
  );

  // --- L21: pinLastMedia must skip soft-deleted (tombstoned) entries ---

  it('pinLastMedia skips a soft-deleted last entry and pins the prior live one', async () => {
    // group_a already has one live entry "one.oga". Append a SECOND, newer
    // entry that has already been reclaimed by retention (deleted_at stamped).
    await appendMediaEntry(path.join(groupsDir, 'group_a'), {
      message_id: '2',
      chat_jid: 'tg:1',
      basename: 'two.oga',
      type: 'voice',
      size_bytes: 512,
      has_transcript: true,
      has_caption: false,
      transcript_chars: 4,
      created_at: '2026-05-11T00:00:00Z',
      keep: false,
      deleted_at: '2026-05-12T00:00:00Z',
    });

    const out = await pinLastMedia(groupsDir, 'group_a');
    // Must NOT report success for the tombstoned "two.oga".
    expect(out).toBe('Pinned: one.oga');

    const media = await listMedia(path.join(groupsDir, 'group_a'));
    const one = media.find((m) => m.basename === 'one.oga');
    const two = media.find((m) => m.basename === 'two.oga');
    expect(one?.keep).toBe(true);
    // The deleted tombstone must remain unpinned.
    expect(two?.keep).toBe(false);
  });

  it('pinLastMedia reports no media when every entry is soft-deleted', async () => {
    const folder = 'group_d';
    await fs.mkdir(path.join(groupsDir, folder, 'received'), { recursive: true });
    await appendMediaEntry(path.join(groupsDir, folder), {
      message_id: '1',
      chat_jid: 'tg:9',
      basename: 'gone.jpg',
      type: 'photo',
      size_bytes: 100,
      has_transcript: false,
      has_caption: false,
      transcript_chars: 0,
      created_at: '2026-05-11T00:00:00Z',
      keep: false,
      deleted_at: '2026-05-12T00:00:00Z',
    });

    const out = await pinLastMedia(groupsDir, folder);
    expect(out).toContain('нет медиа');
    expect(out).not.toMatch(/^Pinned:/);
  });
});
