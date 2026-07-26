import { EventEmitter } from 'node:events';
import https from 'node:https';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';

import { appendMediaEntry, listMedia } from '../media-manifest.js';
import {
  main as retentionMain,
  sendTelegramMessage,
} from './retention.js';

const SAFE_UNLINK_HELPER = fileURLToPath(
  new URL('../../scripts/safe-unlink-received.py', import.meta.url),
);
const PYTHON_BIN =
  process.platform === 'darwin' ? '/usr/bin/python3' : 'python3';

describe('retention (dry-run, end-to-end)', () => {
  let root: string;
  let groupsDir: string;
  let configPath: string;
  let logsDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'retention-test-'));
    groupsDir = path.join(root, 'groups');
    logsDir = path.join(root, 'logs');
    configPath = path.join(root, 'retention.json');
    await fs.mkdir(groupsDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        defaultMaxAgeDays: 30,
        voiceMaxAgeDays: 1,
        videoNoteMaxAgeDays: 1,
        photoMaxAgeDays: 1,
        documentMaxAgeDays: 1,
        perUserBytesLimit: 1_000_000_000,
        globalBytesLimit: 1_000_000_000,
        mode: { voice: 'dry', videoNote: 'dry', photo: 'dry', document: 'dry' },
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes retention.log with aggregate counts and no paths', async () => {
    const folderName = 'fixture_group';
    const folderAbs = path.join(groupsDir, folderName);
    const received = path.join(folderAbs, 'received');
    await fs.mkdir(received, { recursive: true });

    // Old voice WITH transcript → candidate
    await fs.writeFile(path.join(received, 'old-voice.oga'), 'voice-bytes');
    await appendMediaEntry(folderAbs, {
      message_id: '1',
      chat_jid: 'tg:1',
      basename: 'old-voice.oga',
      type: 'voice',
      size_bytes: 11,
      has_transcript: true,
      has_caption: false,
      transcript_chars: 4,
      created_at: '2026-04-01T00:00:00Z',
      keep: false,
    });
    // Fresh voice WITHOUT transcript → keep (needs transcript)
    await fs.writeFile(path.join(received, 'fresh-voice.oga'), 'voice-bytes');
    await appendMediaEntry(folderAbs, {
      message_id: '2',
      chat_jid: 'tg:1',
      basename: 'fresh-voice.oga',
      type: 'voice',
      size_bytes: 11,
      has_transcript: false,
      has_caption: false,
      transcript_chars: 0,
      created_at: new Date().toISOString(),
      keep: false,
    });
    // Pinned old photo → keep
    await fs.writeFile(path.join(received, 'pinned.jpg'), 'photo-bytes');
    await appendMediaEntry(folderAbs, {
      message_id: '3',
      chat_jid: 'tg:1',
      basename: 'pinned.jpg',
      type: 'photo',
      size_bytes: 12,
      has_transcript: false,
      has_caption: true,
      transcript_chars: 0,
      created_at: '2024-01-01T00:00:00Z',
      keep: true,
    });

    await retentionMain([
      'node',
      'retention.js',
      '--dry',
      '--config',
      configPath,
      '--groups-dir',
      groupsDir,
      '--logs-dir',
      logsDir,
      '--no-report',
    ]);

    const logContent = await fs.readFile(
      path.join(logsDir, 'retention.log'),
      'utf8',
    );

    // No absolute /Users paths and no individual basenames leaked.
    expect(logContent).not.toContain('/Users/example/');
    expect(logContent).not.toContain('old-voice.oga');
    expect(logContent).not.toContain('pinned.jpg');

    // But aggregate signals must be present.
    expect(logContent).toContain('fixture_group');
    expect(logContent).toMatch(/candidates 1/);

    // Files should still exist (dry-run never deletes).
    await expect(
      fs.stat(path.join(received, 'old-voice.oga')),
    ).resolves.toBeDefined();
  });

  it('does not delete files when mode is dry even on aged entries', async () => {
    const folderName = 'fixture_group2';
    const folderAbs = path.join(groupsDir, folderName);
    const received = path.join(folderAbs, 'received');
    await fs.mkdir(received, { recursive: true });

    await fs.writeFile(path.join(received, 'ancient.jpg'), 'photo-bytes');
    await appendMediaEntry(folderAbs, {
      message_id: '10',
      chat_jid: 'tg:2',
      basename: 'ancient.jpg',
      type: 'photo',
      size_bytes: 12,
      has_transcript: false,
      has_caption: true,
      transcript_chars: 0,
      created_at: '2020-01-01T00:00:00Z',
      keep: false,
    });

    await retentionMain([
      'node',
      'retention.js',
      '--config',
      configPath,
      '--groups-dir',
      groupsDir,
      '--logs-dir',
      logsDir,
      '--no-report',
    ]);

    // File still present because mode=dry.
    await expect(
      fs.stat(path.join(received, 'ancient.jpg')),
    ).resolves.toBeDefined();
  });

  it('does NOT delete aged video/audio when only document mode is run (no fallthrough to document)', async () => {
    // Regression: the modeKey switch used to fall through to 'document' for
    // every type except video-note/voice/photo. That meant real `video` and
    // `audio` entries — which have no keep-gate — were deleted under the
    // `document` mode rather than their own. Here we flip ONLY `document` to
    // 'run'. The document file must be deleted (proving the run path is live),
    // while video/audio must survive (they resolve to their own dry mode).
    const folderName = 'fixture_av';
    const folderAbs = path.join(groupsDir, folderName);
    const received = path.join(folderAbs, 'received');
    await fs.mkdir(received, { recursive: true });

    // Config: every type dry EXCEPT document, which is 'run'. No video/audio
    // keys present (mirrors the shipped config that predates those types).
    await fs.writeFile(
      configPath,
      JSON.stringify({
        defaultMaxAgeDays: 1,
        voiceMaxAgeDays: 1,
        videoNoteMaxAgeDays: 1,
        photoMaxAgeDays: 1,
        documentMaxAgeDays: 1,
        perUserBytesLimit: 1_000_000_000,
        globalBytesLimit: 1_000_000_000,
        mode: { voice: 'dry', videoNote: 'dry', photo: 'dry', document: 'run' },
      }),
    );

    // Aged video → must survive.
    await fs.writeFile(path.join(received, 'old-clip.mp4'), 'video-bytes');
    await appendMediaEntry(folderAbs, {
      message_id: '20',
      chat_jid: 'tg:3',
      basename: 'old-clip.mp4',
      type: 'video',
      size_bytes: 11,
      has_transcript: false,
      has_caption: false,
      transcript_chars: 0,
      created_at: '2020-01-01T00:00:00Z',
      keep: false,
    });
    // Aged audio → must survive.
    await fs.writeFile(path.join(received, 'old-song.mp3'), 'audio-bytes');
    await appendMediaEntry(folderAbs, {
      message_id: '21',
      chat_jid: 'tg:3',
      basename: 'old-song.mp3',
      type: 'audio',
      size_bytes: 11,
      has_transcript: false,
      has_caption: false,
      transcript_chars: 0,
      created_at: '2020-01-01T00:00:00Z',
      keep: false,
    });
    // Aged document → SHOULD be deleted (document mode is 'run').
    await fs.writeFile(path.join(received, 'old-doc.pdf'), 'doc-bytes');
    await appendMediaEntry(folderAbs, {
      message_id: '22',
      chat_jid: 'tg:3',
      basename: 'old-doc.pdf',
      type: 'document',
      size_bytes: 11,
      has_transcript: false,
      has_caption: false,
      transcript_chars: 0,
      created_at: '2020-01-01T00:00:00Z',
      keep: false,
    });

    await retentionMain([
      'node',
      'retention.js',
      '--config',
      configPath,
      '--groups-dir',
      groupsDir,
      '--logs-dir',
      logsDir,
      '--no-report',
    ]);

    // video + audio survive on disk and are NOT tombstoned in the manifest.
    await expect(
      fs.stat(path.join(received, 'old-clip.mp4')),
    ).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(received, 'old-song.mp3')),
    ).resolves.toBeDefined();

    const entries = await listMedia(folderAbs);
    const video = entries.find((e) => e.basename === 'old-clip.mp4');
    const audio = entries.find((e) => e.basename === 'old-song.mp3');
    const doc = entries.find((e) => e.basename === 'old-doc.pdf');
    expect(video?.deleted_at).toBeUndefined();
    expect(audio?.deleted_at).toBeUndefined();

    // Sanity: the document file genuinely was deleted, so survival of
    // video/audio is due to per-type mode resolution, not an inert sweep.
    await expect(fs.stat(path.join(received, 'old-doc.pdf'))).rejects.toThrow();
    expect(doc?.deleted_at).toBeDefined();
  });

  it('does NOT count aged video/audio (no config.mode key) toward report candidates/freed_bytes', async () => {
    // Regression (finding #75): byte-cap/freed-bytes accounting used to count
    // ALL `candidate` entries, including `video`/`audio`, which have no key in
    // config.mode and are therefore NEVER unlinked. That overstated freed_bytes
    // and let the byte cap believe it reclaimed disk that stays on disk. Here an
    // aged video and an aged document are both age-candidates; only the
    // deletable `document` (which HAS a mode key) may be counted. The video must
    // not appear as a candidate in the report's by_type breakdown or the count.
    const folderName = 'fixture_av_count';
    const folderAbs = path.join(groupsDir, folderName);
    const received = path.join(folderAbs, 'received');
    await fs.mkdir(received, { recursive: true });

    // All dry, short TTLs so both entries are age-expired candidates.
    await fs.writeFile(
      configPath,
      JSON.stringify({
        defaultMaxAgeDays: 1,
        voiceMaxAgeDays: 1,
        videoNoteMaxAgeDays: 1,
        photoMaxAgeDays: 1,
        documentMaxAgeDays: 1,
        perUserBytesLimit: 1_000_000_000,
        globalBytesLimit: 1_000_000_000,
        // No video/audio keys (mirrors shipped config that predates them).
        mode: { voice: 'dry', videoNote: 'dry', photo: 'dry', document: 'dry' },
      }),
    );

    // Aged video → age-candidate, but type has NO mode key → must NOT be counted.
    await fs.writeFile(path.join(received, 'aged-clip.mp4'), 'video-bytes');
    await appendMediaEntry(folderAbs, {
      message_id: '40',
      chat_jid: 'tg:7',
      basename: 'aged-clip.mp4',
      type: 'video',
      size_bytes: 5000,
      has_transcript: false,
      has_caption: false,
      transcript_chars: 0,
      created_at: '2020-01-01T00:00:00Z',
      keep: false,
    });
    // Aged document → age-candidate AND deletable (has a mode key) → counted.
    await fs.writeFile(path.join(received, 'aged-doc.pdf'), 'doc-bytes');
    await appendMediaEntry(folderAbs, {
      message_id: '41',
      chat_jid: 'tg:7',
      basename: 'aged-doc.pdf',
      type: 'document',
      size_bytes: 9,
      has_transcript: false,
      has_caption: false,
      transcript_chars: 0,
      created_at: '2020-01-01T00:00:00Z',
      keep: false,
    });

    await retentionMain([
      'node',
      'retention.js',
      '--config',
      configPath,
      '--groups-dir',
      groupsDir,
      '--logs-dir',
      logsDir,
      '--no-report',
    ]);

    const logContent = await fs.readFile(
      path.join(logsDir, 'retention.log'),
      'utf8',
    );

    // Only the deletable document counts as a candidate: exactly 1, not 2.
    expect(logContent).toMatch(/candidates 1/);
    // by_type breakdown: document is flagged as a candidate, video is NOT.
    expect(logContent).toContain('document=1(cand:1)');
    expect(logContent).toContain('video=1');
    expect(logContent).not.toContain('video=1(cand:');
  });

  it('actually deletes entries promoted by the GLOBAL byte cap (cap is enforced, not just reported)', async () => {
    // Regression: physical deletion used to happen inside the per-folder
    // loop, BEFORE applyGlobalBytes ran. So entries promoted to candidate by
    // the global byte cap (reason 'over-global-bytes') were reported as freed
    // but never unlinked, leaving the cap ineffective and run.deleted
    // inconsistent with freed bytes. The fix finalizes the candidate set
    // (per-user + global) across all folders, then deletes in a second pass.
    const folderName = 'fixture_global';
    const folderAbs = path.join(groupsDir, folderName);
    const received = path.join(folderAbs, 'received');
    await fs.mkdir(received, { recursive: true });

    // Two FRESH documents (within TTL, not pinned, no age-based candidacy).
    // documentMaxAgeDays is large enough that neither is age-expired; only
    // the global byte cap can evict them. document mode is 'run'.
    await fs.writeFile(
      configPath,
      JSON.stringify({
        defaultMaxAgeDays: 3650,
        voiceMaxAgeDays: 3650,
        videoNoteMaxAgeDays: 3650,
        photoMaxAgeDays: 3650,
        documentMaxAgeDays: 3650,
        perUserBytesLimit: 1_000_000_000, // per-user cap never trips
        globalBytesLimit: 150, // total is 200 → exactly one 100B doc evicted
        mode: { voice: 'dry', videoNote: 'dry', photo: 'dry', document: 'run' },
      }),
    );

    // Older fresh doc (evicted first by global cap, oldest-first).
    await fs.writeFile(path.join(received, 'doc-old.pdf'), 'x'.repeat(100));
    await appendMediaEntry(folderAbs, {
      message_id: '30',
      chat_jid: 'tg:5',
      basename: 'doc-old.pdf',
      type: 'document',
      size_bytes: 100,
      has_transcript: false,
      has_caption: false,
      transcript_chars: 0,
      created_at: '2026-05-01T00:00:00Z',
      keep: false,
    });
    // Newer fresh doc (survives: evicting one 100B doc brings 200→100 ≤ 150).
    await fs.writeFile(path.join(received, 'doc-new.pdf'), 'x'.repeat(100));
    await appendMediaEntry(folderAbs, {
      message_id: '31',
      chat_jid: 'tg:5',
      basename: 'doc-new.pdf',
      type: 'document',
      size_bytes: 100,
      has_transcript: false,
      has_caption: false,
      transcript_chars: 0,
      created_at: '2026-05-30T00:00:00Z',
      keep: false,
    });

    await retentionMain([
      'node',
      'retention.js',
      '--config',
      configPath,
      '--groups-dir',
      groupsDir,
      '--logs-dir',
      logsDir,
      '--no-report',
    ]);

    // The global-cap candidate must be physically gone AND tombstoned.
    await expect(fs.stat(path.join(received, 'doc-old.pdf'))).rejects.toThrow();
    // The fitting entry must survive untouched.
    await expect(
      fs.stat(path.join(received, 'doc-new.pdf')),
    ).resolves.toBeDefined();

    const entries = await listMedia(folderAbs);
    const oldDoc = entries.find((e) => e.basename === 'doc-old.pdf');
    const newDoc = entries.find((e) => e.basename === 'doc-new.pdf');
    expect(oldDoc?.deleted_at).toBeDefined();
    expect(newDoc?.deleted_at).toBeUndefined();

    // run.deleted is consistent with what was reported freed: exactly one
    // candidate (1 deleted). The report must show "deleted 1".
    const logContent = await fs.readFile(
      path.join(logsDir, 'retention.log'),
      'utf8',
    );
    expect(logContent).toMatch(/deleted 1/);
  });
});

describe('retention path-traversal containment (RUN mode)', () => {
  let root: string;
  let groupsDir: string;
  let logsDir: string;
  let runConfigPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'retention-traversal-'));
    groupsDir = path.join(root, 'groups');
    logsDir = path.join(root, 'logs');
    runConfigPath = path.join(root, 'retention.json');
    await fs.mkdir(groupsDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(
      runConfigPath,
      JSON.stringify({
        defaultMaxAgeDays: 30,
        voiceMaxAgeDays: 1,
        videoNoteMaxAgeDays: 1,
        photoMaxAgeDays: 1,
        documentMaxAgeDays: 1,
        perUserBytesLimit: 1_000_000_000,
        globalBytesLimit: 1_000_000_000,
        // voice is in RUN mode so a candidate voice entry would be deleted.
        mode: { voice: 'run', videoNote: 'dry', photo: 'dry', document: 'dry' },
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not unlink a file outside received/ via a poisoned manifest basename', async () => {
    const folderName = 'attacker_group';
    const folderAbs = path.join(groupsDir, folderName);
    const received = path.join(folderAbs, 'received');
    await fs.mkdir(received, { recursive: true });

    // Sentinel one level above received/ (i.e. inside the group folder) that a
    // '../sentinel.txt' basename would target.
    const sentinel = path.join(folderAbs, 'sentinel.txt');
    await fs.writeFile(sentinel, 'do-not-delete');

    // A real candidate (aged voice with transcript) so the RUN path engages.
    await fs.writeFile(path.join(received, 'legit.oga'), 'voice-bytes');
    await appendMediaEntry(folderAbs, {
      message_id: '1',
      chat_jid: 'tg:1',
      basename: 'legit.oga',
      type: 'voice',
      size_bytes: 11,
      has_transcript: true,
      has_caption: false,
      transcript_chars: 4,
      created_at: '2026-04-01T00:00:00Z',
      keep: false,
    });
    // A POISONED candidate whose basename escapes received/.
    await appendMediaEntry(folderAbs, {
      message_id: '2',
      chat_jid: 'tg:1',
      basename: '../sentinel.txt',
      type: 'voice',
      size_bytes: 13,
      has_transcript: true,
      has_caption: false,
      transcript_chars: 4,
      created_at: '2026-04-01T00:00:00Z',
      keep: false,
    });

    await retentionMain([
      'node',
      'retention.js',
      '--config',
      runConfigPath,
      '--groups-dir',
      groupsDir,
      '--logs-dir',
      logsDir,
      '--no-report',
    ]);

    // The traversal target MUST survive…
    await expect(fs.stat(sentinel)).resolves.toBeDefined();
    expect(await fs.readFile(sentinel, 'utf8')).toBe('do-not-delete');
    // …while the legitimate in-received candidate was deleted as normal.
    await expect(fs.stat(path.join(received, 'legit.oga'))).rejects.toThrow();
  });

  it('fails closed when received/ is a stable symlink to an outside directory', async () => {
    const folderAbs = path.join(groupsDir, 'symlink_group');
    const outside = path.join(root, 'outside');
    await fs.mkdir(folderAbs, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'candidate.oga'), 'outside-sentinel');
    await fs.symlink(outside, path.join(folderAbs, 'received'));

    await appendMediaEntry(folderAbs, {
      message_id: 'stable-symlink',
      chat_jid: 'tg:1',
      basename: 'candidate.oga',
      type: 'voice',
      size_bytes: 16,
      has_transcript: true,
      has_caption: false,
      transcript_chars: 4,
      created_at: '2020-01-01T00:00:00Z',
      keep: false,
    });

    await retentionMain([
      'node',
      'retention.js',
      '--config',
      runConfigPath,
      '--groups-dir',
      groupsDir,
      '--logs-dir',
      logsDir,
      '--no-report',
    ]);

    expect(await fs.readFile(path.join(outside, 'candidate.oga'), 'utf8')).toBe(
      'outside-sentinel',
    );
    const entry = (await listMedia(folderAbs)).find(
      (item) => item.basename === 'candidate.oga',
    );
    expect(entry?.deleted_at).toBeUndefined();
  });

  it('detects a received symlink swap after open and never unlinks either target', async () => {
    const folderAbs = path.join(groupsDir, 'swap_group');
    const received = path.join(folderAbs, 'received');
    const parkedReceived = path.join(folderAbs, 'received-before-swap');
    const outside = path.join(root, 'swap-outside');
    await fs.mkdir(received, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(received, 'candidate.oga'), 'original-media');
    await fs.writeFile(path.join(outside, 'candidate.oga'), 'outside-sentinel');

    // Import the helper and inject a deterministic swap exactly after it has
    // opened received/ but before its identity re-check. The production CLI
    // never supplies this callback.
    const harness = [
      'import importlib.util, json, os, sys',
      'helper_path, folder, outside = sys.argv[1:4]',
      'spec = importlib.util.spec_from_file_location("safe_unlink_received", helper_path)',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'def swap():',
      '    os.rename(os.path.join(folder, "received"), os.path.join(folder, "received-before-swap"))',
      '    os.symlink(outside, os.path.join(folder, "received"))',
      'print(json.dumps(module.safe_unlink_received(folder, "candidate.oga", swap)))',
    ].join('\n');
    const result = JSON.parse(
      execFileSync(
        PYTHON_BIN,
        ['-I', '-c', harness, SAFE_UNLINK_HELPER, folderAbs, outside],
        {
          encoding: 'utf8',
          timeout: 10_000,
        },
      ),
    ) as { status: string; reason?: string };

    expect(result).toMatchObject({
      status: 'unsafe',
      reason: 'received-changed',
    });
    expect(
      await fs.readFile(path.join(parkedReceived, 'candidate.oga'), 'utf8'),
    ).toBe('original-media');
    expect(await fs.readFile(path.join(outside, 'candidate.oga'), 'utf8')).toBe(
      'outside-sentinel',
    );
  });
});

describe('retention Telegram report transport', () => {
  afterEach(() => vi.restoreAllMocks());

  function fakeRequest(statusCode = 200) {
    const response = Object.assign(new EventEmitter(), {
      statusCode,
      destroy: vi.fn((error?: Error) => {
        if (error) response.emit('error', error);
        response.emit('close');
      }),
    });
    const request = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn((error?: Error) => {
        if (error) request.emit('error', error);
      }),
    });
    vi.spyOn(https, 'request').mockImplementation((...args: any[]) => {
      const callback = args.at(-1) as (res: typeof response) => void;
      request.end.mockImplementationOnce(() => callback(response));
      return request as any;
    });
    return { request, response };
  }

  it('rejects a response-stream error instead of hanging the sweep', async () => {
    const { response } = fakeRequest();
    const pending = sendTelegramMessage('test-token', 123, 'report');
    response.emit('error', new Error('mid-body reset'));
    await expect(pending).rejects.toThrow('mid-body reset');
  });

  it('preserves the ordinary successful owner report path', async () => {
    const { response } = fakeRequest();
    const pending = sendTelegramMessage('test-token', 123, 'report');
    response.emit('data', Buffer.from('{"ok":true}'));
    response.emit('end');
    response.emit('close');
    await expect(pending).resolves.toBeUndefined();
  });
});
