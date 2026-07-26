import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  appendMediaEntry,
  listMedia,
  updateMediaEntry,
  getMediaForMessage,
  setKeep,
  folderFromMediaPath,
  folderAbsFromMediaPath,
  isSafeMediaBasename,
  type MediaEntry,
} from './media-manifest.js';

function makeEntry(overrides: Partial<MediaEntry> = {}): MediaEntry {
  return {
    message_id: '1',
    chat_jid: 'tg:1',
    basename: '2026-05-11T10-00-00-000Z-voice-aaa.oga',
    type: 'voice',
    size_bytes: 1234,
    has_transcript: false,
    has_caption: false,
    transcript_chars: 0,
    created_at: '2026-05-11T10:00:00.000Z',
    keep: false,
    ...overrides,
  };
}

describe('media-manifest', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'mm-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('appends and lists 3 entries in order', async () => {
    await appendMediaEntry(dir, makeEntry({ message_id: '1' }));
    await appendMediaEntry(
      dir,
      makeEntry({
        message_id: '2',
        basename: '2026-05-11T10-01-00-000Z-photo-bbb.jpg',
        type: 'photo',
      }),
    );
    await appendMediaEntry(
      dir,
      makeEntry({
        message_id: '3',
        basename: '2026-05-11T10-02-00-000Z-video-note-ccc.mp4',
        type: 'video-note',
      }),
    );

    const all = await listMedia(dir);
    expect(all).toHaveLength(3);
    expect(all[0].message_id).toBe('1');
    expect(all[1].type).toBe('photo');
    expect(all[2].type).toBe('video-note');
  });

  it('filter callback narrows the result set', async () => {
    await appendMediaEntry(dir, makeEntry({ message_id: '1', type: 'voice' }));
    await appendMediaEntry(
      dir,
      makeEntry({
        message_id: '2',
        basename: 'x.jpg',
        type: 'photo',
      }),
    );

    const photos = await listMedia(dir, (e) => e.type === 'photo');
    expect(photos).toHaveLength(1);
    expect(photos[0].message_id).toBe('2');
  });

  it('updateMediaEntry folds an append-only patch without changing peers', async () => {
    await appendMediaEntry(dir, makeEntry({ basename: 'a.oga' }));
    await appendMediaEntry(
      dir,
      makeEntry({ basename: 'b.oga', message_id: '2' }),
    );

    const ok = await updateMediaEntry(dir, 'a.oga', {
      has_transcript: true,
      transcript_chars: 42,
    });
    expect(ok).toBe(true);

    const all = await listMedia(dir);
    expect(all).toHaveLength(2);
    const a = all.find((e) => e.basename === 'a.oga')!;
    expect(a.has_transcript).toBe(true);
    expect(a.transcript_chars).toBe(42);
    // unchanged fields preserved
    expect(a.size_bytes).toBe(1234);
    // other entries left alone
    const b = all.find((e) => e.basename === 'b.oga')!;
    expect(b.has_transcript).toBe(false);
  });

  it('updateMediaEntry returns false for unknown basename', async () => {
    await appendMediaEntry(dir, makeEntry({ basename: 'a.oga' }));
    const ok = await updateMediaEntry(dir, 'missing.oga', { has_caption: true });
    expect(ok).toBe(false);
  });

  it('updateMediaEntry returns false when manifest is absent', async () => {
    const ok = await updateMediaEntry(dir, 'x.oga', { has_caption: true });
    expect(ok).toBe(false);
  });

  it('updateMediaEntry appends a logical patch without duplicating the entry', async () => {
    await appendMediaEntry(dir, makeEntry({ basename: 'a.oga' }));
    const manifest = path.join(dir, '.media-index.jsonl');
    expect(await updateMediaEntry(dir, 'a.oga', { has_transcript: true })).toBe(
      true,
    );
    const lines = (await fs.readFile(manifest, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({
      skoobi_media_patch_v1: 1,
      basename: 'a.oga',
      patch: { has_transcript: true },
    });
    const all = await listMedia(dir);
    expect(all).toHaveLength(1);
    expect(all.find((e) => e.basename === 'a.oga')!.has_transcript).toBe(true);
  });

  it('refuses a symlink or hardlink manifest without changing its target', async () => {
    const target = path.join(dir, 'target.txt');
    const manifest = path.join(dir, '.media-index.jsonl');
    await fs.writeFile(target, 'do-not-touch');

    await fs.symlink(target, manifest);
    await expect(appendMediaEntry(dir, makeEntry())).rejects.toBeTruthy();
    expect(await fs.readFile(target, 'utf8')).toBe('do-not-touch');

    await fs.unlink(manifest);
    await fs.link(target, manifest);
    await expect(appendMediaEntry(dir, makeEntry())).rejects.toBeTruthy();
    expect(await fs.readFile(target, 'utf8')).toBe('do-not-touch');
  });

  it('fast-rejects FIFO and oversized manifests', async () => {
    const manifest = path.join(dir, '.media-index.jsonl');
    execFileSync('mkfifo', [manifest]);
    await expect(appendMediaEntry(dir, makeEntry())).rejects.toBeTruthy();

    await fs.unlink(manifest);
    const handle = await fs.open(manifest, 'wx', 0o600);
    await handle.truncate(8 * 1024 * 1024 + 1);
    await handle.close();
    await expect(listMedia(dir)).rejects.toMatchObject({ code: 'EFBIG' });
  });

  it('append-only patches do not drop concurrent entries or independent fields', async () => {
    await appendMediaEntry(dir, makeEntry({ basename: 'a.oga', message_id: '1' }));
    await appendMediaEntry(
      dir,
      makeEntry({ basename: 'b.oga', message_id: '2' }),
    );

    const [transcriptUpdated, captionUpdated] = await Promise.all([
      updateMediaEntry(dir, 'a.oga', { has_transcript: true }),
      updateMediaEntry(dir, 'a.oga', { has_caption: true }),
      appendMediaEntry(
        dir,
        makeEntry({ basename: 'c.oga', message_id: '3' }),
      ).then(() => true),
    ]);
    expect(transcriptUpdated).toBe(true);
    expect(captionUpdated).toBe(true);

    const all = await listMedia(dir);
    const basenames = all.map((e) => e.basename).sort();
    // All three survive: the patched 'a', untouched 'b', and the concurrently
    // appended 'c' (which the old read-modify-write would have lost).
    expect(basenames).toEqual(['a.oga', 'b.oga', 'c.oga']);
    expect(all.find((e) => e.basename === 'a.oga')!.has_transcript).toBe(true);
    expect(all.find((e) => e.basename === 'a.oga')!.has_caption).toBe(true);
  });

  it('rejects the 50,001st record before writing without narrowing the exact cap', async () => {
    const manifest = path.join(dir, '.media-index.jsonl');
    await fs.writeFile(manifest, '{}\n'.repeat(49_999), 'utf8');

    await appendMediaEntry(dir, makeEntry({ basename: 'at-cap.oga' }));
    const atCap = await fs.readFile(manifest);
    expect(atCap.toString('utf8').trimEnd().split('\n')).toHaveLength(50_000);

    await expect(
      appendMediaEntry(dir, makeEntry({ basename: 'over-cap.oga' })),
    ).rejects.toMatchObject({ code: 'EFBIG' });
    expect(await fs.readFile(manifest)).toEqual(atCap);
  });

  it('keeps a small cross-process cap-boundary overshoot readable but sealed', async () => {
    const manifest = path.join(dir, '.media-index.jsonl');
    // Models two independent writers that both observed 49,999 before their
    // atomic appends. The strict writer cap is still 50,000, but readers retain
    // bounded headroom so this unavoidable race cannot poison the manifest.
    await fs.writeFile(manifest, '{}\n'.repeat(50_001), 'utf8');

    expect(await listMedia(dir)).toHaveLength(50_001);
    const before = await fs.readFile(manifest);
    await expect(
      appendMediaEntry(dir, makeEntry({ basename: 'sealed.oga' })),
    ).rejects.toMatchObject({ code: 'EFBIG' });
    expect(await fs.readFile(manifest)).toEqual(before);
  });

  it('cancels a queued writer on timeout so it cannot append later', async () => {
    vi.useFakeTimers();
    const realOpen = fs.open.bind(fs) as any;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let first = true;
    vi.spyOn(fs, 'open').mockImplementation((async (...args: any[]) => {
      if (first) {
        first = false;
        await firstGate;
      }
      return realOpen(...args);
    }) as any);

    const firstWrite = appendMediaEntry(
      dir,
      makeEntry({ basename: 'first.oga' }),
    );
    await Promise.resolve();
    const timedOutWrite = appendMediaEntry(
      dir,
      makeEntry({ basename: 'must-not-appear.oga' }),
    );
    const rejection = expect(timedOutWrite).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
    await vi.advanceTimersByTimeAsync(5_001);
    await rejection;

    releaseFirst();
    await firstWrite;
    await vi.runAllTimersAsync();
    expect((await listMedia(dir)).map((entry) => entry.basename)).toEqual([
      'first.oga',
    ]);
  });

  it('does not report timeout after a filesystem write has started', async () => {
    vi.useFakeTimers();
    const realOpen = fs.open.bind(fs) as any;
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    vi.spyOn(fs, 'open').mockImplementation((async (...args: any[]) => {
      await openGate;
      return realOpen(...args);
    }) as any);

    let settled = false;
    const write = appendMediaEntry(
      dir,
      makeEntry({ basename: 'slow-started.oga' }),
    ).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);

    releaseOpen();
    await write;
    expect(settled).toBe(true);
  });

  it('getMediaForMessage returns the matching entry', async () => {
    await appendMediaEntry(dir, makeEntry({ message_id: '1', chat_jid: 'tg:1' }));
    await appendMediaEntry(
      dir,
      makeEntry({
        message_id: '2',
        chat_jid: 'tg:1',
        basename: 'second.oga',
      }),
    );

    const hit = await getMediaForMessage(dir, '2', 'tg:1');
    expect(hit?.basename).toBe('second.oga');

    const miss = await getMediaForMessage(dir, '99', 'tg:1');
    expect(miss).toBeNull();
  });

  it('setKeep flips the keep flag', async () => {
    await appendMediaEntry(dir, makeEntry({ basename: 'a.oga', keep: false }));
    const ok = await setKeep(dir, 'a.oga', true);
    expect(ok).toBe(true);
    const all = await listMedia(dir);
    expect(all[0].keep).toBe(true);
  });

  it('listMedia on missing folder returns empty array', async () => {
    const empty = await listMedia(path.join(dir, 'does-not-exist'));
    expect(empty).toEqual([]);
  });

  it('listMedia skips malformed lines', async () => {
    await appendMediaEntry(dir, makeEntry({ basename: 'a.oga' }));
    await fs.appendFile(
      path.join(dir, '.media-index.jsonl'),
      'this-is-not-json\n',
      'utf8',
    );
    await appendMediaEntry(dir, makeEntry({ basename: 'b.oga', message_id: '2' }));

    const all = await listMedia(dir);
    expect(all).toHaveLength(2);
  });
});

describe('folderFromMediaPath', () => {
  it('returns the folder name for a received-media path', () => {
    expect(
      folderFromMediaPath(
        '/Users/example/my-assistant/claudeclaw/groups/telegram_fixture_user/received/x.oga',
      ),
    ).toBe('telegram_fixture_user');
  });

  it('returns null for non-received paths', () => {
    expect(folderFromMediaPath('/tmp/foo.oga')).toBeNull();
    expect(
      folderFromMediaPath('/Users/example/no-received-here/foo.oga'),
    ).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(folderFromMediaPath('')).toBeNull();
    expect(folderFromMediaPath(undefined as unknown as string)).toBeNull();
  });
});

describe('folderAbsFromMediaPath', () => {
  it('returns the absolute folder for received-media path', () => {
    expect(
      folderAbsFromMediaPath('/srv/groups/telegram_main/received/x.oga'),
    ).toBe('/srv/groups/telegram_main');
  });

  it('returns null when not under received/', () => {
    expect(folderAbsFromMediaPath('/srv/groups/telegram_main/x.oga')).toBeNull();
  });
});

describe('isSafeMediaBasename (retention path-traversal guard)', () => {
  it('accepts plain single-segment file names', () => {
    expect(isSafeMediaBasename('2026-05-11T10-00-00-000Z-voice-aaa.oga')).toBe(
      true,
    );
    expect(isSafeMediaBasename('photo.jpg')).toBe(true);
  });

  it('rejects path traversal, separators, absolute and special names', () => {
    expect(isSafeMediaBasename('../../../.env')).toBe(false);
    expect(isSafeMediaBasename('../secret.p12')).toBe(false);
    expect(isSafeMediaBasename('a/b.jpg')).toBe(false);
    expect(isSafeMediaBasename('a\\b.jpg')).toBe(false);
    expect(isSafeMediaBasename('/etc/passwd')).toBe(false);
    expect(isSafeMediaBasename('..')).toBe(false);
    expect(isSafeMediaBasename('.')).toBe(false);
    expect(isSafeMediaBasename('with\0null.jpg')).toBe(false);
    expect(isSafeMediaBasename('')).toBe(false);
  });

  it('rejects non-string and oversized names', () => {
    expect(isSafeMediaBasename(undefined)).toBe(false);
    expect(isSafeMediaBasename(null)).toBe(false);
    expect(isSafeMediaBasename(42)).toBe(false);
    expect(isSafeMediaBasename('a'.repeat(256))).toBe(false);
  });
});
