import { describe, it, expect } from 'vitest';
import type { MediaEntry } from './media-manifest.js';
import {
  classifyEntry,
  classifyFolder,
  applyPerUserBytes,
  applyGlobalBytes,
  type RetentionConfig,
  type FolderSummary,
} from './retention-classifier.js';

const NOW = new Date('2026-05-11T12:00:00.000Z');

const baseConfig: RetentionConfig = {
  defaultMaxAgeDays: 30,
  voiceMaxAgeDays: 7,
  videoNoteMaxAgeDays: 7,
  photoMaxAgeDays: 14,
  documentMaxAgeDays: 30,
  perUserBytesLimit: 10_000,
  globalBytesLimit: 25_000,
  mode: { voice: 'dry', videoNote: 'dry', photo: 'dry', document: 'dry' },
};

function entry(over: Partial<MediaEntry>): MediaEntry {
  return {
    message_id: '1',
    chat_jid: 'tg:1',
    basename: 'a.bin',
    type: 'voice',
    size_bytes: 1000,
    has_transcript: false,
    has_caption: false,
    transcript_chars: 0,
    created_at: NOW.toISOString(),
    keep: false,
    ...over,
  };
}

describe('classifyEntry', () => {
  it('keeps pinned entries regardless of age', () => {
    const r = classifyEntry(
      entry({ keep: true, type: 'voice', has_transcript: true, created_at: '2020-01-01T00:00:00Z' }),
      baseConfig,
      NOW,
    );
    expect(r.decision).toBe('keep');
    expect(r.reason).toBe('pinned');
  });

  it('keeps photos that still need a caption', () => {
    const r = classifyEntry(
      entry({ type: 'photo', has_caption: false, created_at: '2020-01-01T00:00:00Z' }),
      baseConfig,
      NOW,
    );
    expect(r.decision).toBe('keep');
    expect(r.reason).toBe('photo-needs-caption');
  });

  it('keeps voice that still needs a transcript', () => {
    const r = classifyEntry(
      entry({ type: 'voice', has_transcript: false, created_at: '2020-01-01T00:00:00Z' }),
      baseConfig,
      NOW,
    );
    expect(r.decision).toBe('keep');
    expect(r.reason).toBe('voice-needs-transcript');
  });

  it('keeps video-note that still needs a transcript', () => {
    const r = classifyEntry(
      entry({ type: 'video-note', has_transcript: false, created_at: '2020-01-01T00:00:00Z' }),
      baseConfig,
      NOW,
    );
    expect(r.decision).toBe('keep');
    expect(r.reason).toBe('video-note-needs-transcript');
  });

  it('candidates voice older than voiceMaxAgeDays', () => {
    const r = classifyEntry(
      entry({
        type: 'voice',
        has_transcript: true,
        // 30d ago — well past 7d voice TTL
        created_at: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      baseConfig,
      NOW,
    );
    expect(r.decision).toBe('candidate');
    expect(r.reason).toBe('age-exceeded');
  });

  it('keeps photo within photo TTL when caption exists', () => {
    const r = classifyEntry(
      entry({
        type: 'photo',
        has_caption: true,
        created_at: new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      baseConfig,
      NOW,
    );
    expect(r.decision).toBe('keep');
    expect(r.reason).toBe('within-ttl');
  });

  it('keeps entries that already have deleted_at set', () => {
    const r = classifyEntry(
      entry({
        deleted_at: '2026-05-01T00:00:00Z',
        type: 'voice',
        has_transcript: true,
        created_at: '2020-01-01T00:00:00Z',
      }),
      baseConfig,
      NOW,
    );
    expect(r.decision).toBe('keep');
    expect(r.reason).toBe('already-deleted');
  });
});

describe('applyPerUserBytes', () => {
  it('promotes oldest within-ttl items when folder exceeds quota', () => {
    const entries = classifyFolder(
      [
        entry({
          basename: 'a',
          size_bytes: 4000,
          type: 'voice',
          has_transcript: true,
          created_at: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        }),
        entry({
          basename: 'b',
          size_bytes: 4000,
          type: 'voice',
          has_transcript: true,
          created_at: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        }),
        entry({
          basename: 'c',
          size_bytes: 4000,
          type: 'voice',
          has_transcript: true,
          // OLDEST among the three within-ttl entries
          created_at: new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      baseConfig,
      NOW,
    );

    // Folder total = 12 000 bytes, limit = 10 000 → evict 1 oldest (c).
    applyPerUserBytes(entries, baseConfig);
    const labelled = Object.fromEntries(
      entries.map((c) => [c.entry.basename, c]),
    );
    expect(labelled['c'].decision).toBe('candidate');
    expect(labelled['c'].reason).toBe('over-user-bytes');
    expect(labelled['a'].decision).toBe('keep');
    expect(labelled['b'].decision).toBe('keep');
  });

  it('does nothing when under quota', () => {
    const entries = classifyFolder(
      [
        entry({
          basename: 'a',
          size_bytes: 2000,
          type: 'voice',
          has_transcript: true,
        }),
      ],
      baseConfig,
      NOW,
    );
    applyPerUserBytes(entries, baseConfig);
    expect(entries[0].decision).toBe('keep');
  });

  it('never evicts pinned items even when over quota', () => {
    const entries = classifyFolder(
      [
        entry({
          basename: 'pinned',
          size_bytes: 15_000,
          type: 'voice',
          has_transcript: true,
          keep: true,
        }),
      ],
      baseConfig,
      NOW,
    );
    applyPerUserBytes(entries, baseConfig);
    expect(entries[0].decision).toBe('keep');
    expect(entries[0].reason).toBe('pinned');
  });
});

describe('applyGlobalBytes', () => {
  it('evicts oldest across folders to satisfy global limit', () => {
    const folderA = classifyFolder(
      [
        entry({
          basename: 'a1',
          size_bytes: 10_000,
          type: 'voice',
          has_transcript: true,
          created_at: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      baseConfig,
      NOW,
    );
    const folderB = classifyFolder(
      [
        entry({
          basename: 'b1',
          size_bytes: 10_000,
          type: 'voice',
          has_transcript: true,
          created_at: new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        }),
        entry({
          basename: 'b2',
          size_bytes: 10_000,
          type: 'voice',
          has_transcript: true,
          created_at: new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      baseConfig,
      NOW,
    );

    const summaries: FolderSummary[] = [
      { folder: 'A', classifications: folderA },
      { folder: 'B', classifications: folderB },
    ];

    // Total = 30k. Limit = 25k. Must evict 5k worth — picks 1 oldest (b1).
    applyGlobalBytes(summaries, baseConfig);

    const all = [...folderA, ...folderB];
    const labelled = Object.fromEntries(all.map((c) => [c.entry.basename, c]));
    expect(labelled['b1'].decision).toBe('candidate');
    expect(labelled['b1'].reason).toBe('over-global-bytes');
    expect(labelled['a1'].decision).toBe('keep');
    expect(labelled['b2'].decision).toBe('keep');
  });
});
