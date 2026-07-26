import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { listMedia } from '../media-manifest.js';
import {
  main as backfillMain,
  parseTimestampFromBasename,
} from './backfill-media-index.js';

describe('parseTimestampFromBasename', () => {
  it('parses an ISO-with-dashes timestamp', () => {
    const d = parseTimestampFromBasename(
      '2026-05-11T10-20-30-456Z-voice-abcd1234.oga',
    );
    expect(d?.toISOString()).toBe('2026-05-11T10:20:30.456Z');
  });

  it('returns null for non-matching names', () => {
    expect(parseTimestampFromBasename('random-file.oga')).toBeNull();
    expect(parseTimestampFromBasename('')).toBeNull();
  });
});

describe('backfill-media-index (script)', () => {
  let root: string;
  let groupsDir: string;
  let dbPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'backfill-test-'));
    groupsDir = path.join(root, 'groups');
    dbPath = path.join(root, 'store', 'messages.db');
    await fs.mkdir(path.dirname(dbPath), { recursive: true });

    // Create a fake messages.db with registered_groups + messages.
    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE messages (
        id TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        sender TEXT,
        sender_name TEXT,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER,
        is_bot_message INTEGER DEFAULT 0,
        PRIMARY KEY (id, chat_jid)
      );
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT,
        folder TEXT
      );`,
    );
    db.prepare(
      'INSERT INTO registered_groups (jid, name, folder) VALUES (?,?,?)',
    ).run('tg:111', 'Fixture', 'fixture_group');
    db.prepare(
      'INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?,?,?,?,?,?,0)',
    ).run('1001', 'tg:111', 'u', 'User', '[Voice]', '2026-05-11T10:20:30.456Z');
    db.prepare(
      'INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?,?,?,?,?,?,0)',
    ).run('1002', 'tg:111', 'u', 'User', '[Photo]', '2026-05-11T11:00:00.000Z');
    db.close();

    // Build group folder + received with synthetic media.
    const received = path.join(groupsDir, 'fixture_group', 'received');
    await fs.mkdir(received, { recursive: true });
    await fs.writeFile(
      path.join(received, '2026-05-11T10-20-30-456Z-voice-abcd1234.oga'),
      'fake-voice',
    );
    await fs.writeFile(
      path.join(received, '2026-05-11T11-00-00-000Z-photo-deadbeef.jpg'),
      'fake-photo-data',
    );
    await fs.writeFile(
      path.join(received, '2026-05-11T12-00-00-000Z-video-note-cafef00d.mp4'),
      'fake-video',
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('dry run reports entries without writing the manifest', async () => {
    await backfillMain([
      'node',
      'backfill-media-index.js',
      '--dry',
      '--groups-dir',
      groupsDir,
      '--db',
      dbPath,
    ]);

    const folderAbs = path.join(groupsDir, 'fixture_group');
    // Manifest should not have been created.
    await expect(
      fs.access(path.join(folderAbs, '.media-index.jsonl')),
    ).rejects.toBeDefined();
  });

  it('writes manifest entries with inferred types and resolved message_id', async () => {
    await backfillMain([
      'node',
      'backfill-media-index.js',
      '--groups-dir',
      groupsDir,
      '--db',
      dbPath,
    ]);

    const folderAbs = path.join(groupsDir, 'fixture_group');
    const entries = await listMedia(folderAbs);
    expect(entries).toHaveLength(3);

    const voice = entries.find((e) => e.type === 'voice');
    expect(voice).toBeDefined();
    expect(voice?.message_id).toBe('1001');
    expect(voice?.chat_jid).toBe('tg:111');
    expect(voice?.size_bytes).toBeGreaterThan(0);

    const photo = entries.find((e) => e.type === 'photo');
    expect(photo?.message_id).toBe('1002');

    const videoNote = entries.find((e) => e.type === 'video-note');
    expect(videoNote).toBeDefined();
    // No matching message → message_id stays empty, chat_jid hint from registered_groups.
    expect(videoNote?.message_id).toBe('');
    expect(videoNote?.chat_jid).toBe('tg:111');
  });

  it('is idempotent: re-running skips already-recorded basenames', async () => {
    await backfillMain([
      'node',
      'backfill-media-index.js',
      '--groups-dir',
      groupsDir,
      '--db',
      dbPath,
    ]);
    await backfillMain([
      'node',
      'backfill-media-index.js',
      '--groups-dir',
      groupsDir,
      '--db',
      dbPath,
    ]);

    const entries = await listMedia(path.join(groupsDir, 'fixture_group'));
    expect(entries).toHaveLength(3);
  });

  it('respects --folder to limit to a single group', async () => {
    // Create a second folder
    const second = path.join(groupsDir, 'fixture_other', 'received');
    await fs.mkdir(second, { recursive: true });
    await fs.writeFile(
      path.join(second, '2026-05-11T13-00-00-000Z-voice-aaaabbbb.oga'),
      'other-voice',
    );

    await backfillMain([
      'node',
      'backfill-media-index.js',
      '--folder',
      'fixture_group',
      '--groups-dir',
      groupsDir,
      '--db',
      dbPath,
    ]);

    const first = await listMedia(path.join(groupsDir, 'fixture_group'));
    const other = await listMedia(path.join(groupsDir, 'fixture_other'));
    expect(first.length).toBe(3);
    expect(other.length).toBe(0);
  });

  // Regression for finding #73: the chat_jid hint must come from the real
  // `registered_groups.jid` column, and a file must never be attributed to
  // another tenant's message just because its timestamp is within ±5s.
  it('does not cross-attribute media to another tenant whose message is within 5s', async () => {
    // Register a SECOND tenant and give it a message ('2001') whose timestamp
    // is ~2s away from the first tenant's video-note file
    // (2026-05-11T12-00-00-000Z). With a schema-correct per-folder hint, the
    // file in fixture_group must NOT resolve to the other tenant's message.
    const db = new Database(dbPath);
    db.prepare(
      'INSERT INTO registered_groups (jid, name, folder) VALUES (?,?,?)',
    ).run('tg:222', 'Other', 'fixture_other');
    db.prepare(
      'INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?,?,?,?,?,?,0)',
    ).run('2001', 'tg:222', 'u', 'User', '[Voice]', '2026-05-11T12:00:02.000Z');
    db.close();

    await backfillMain([
      'node',
      'backfill-media-index.js',
      '--folder',
      'fixture_group',
      '--groups-dir',
      groupsDir,
      '--db',
      dbPath,
    ]);

    const entries = await listMedia(path.join(groupsDir, 'fixture_group'));
    const videoNote = entries.find((e) => e.type === 'video-note');
    expect(videoNote).toBeDefined();
    // The hint scopes matching to tg:111, so the tg:222 message is ignored:
    // no message_id is resolved, and the chat_jid stays this group's hint.
    expect(videoNote?.message_id).toBe('');
    expect(videoNote?.chat_jid).toBe('tg:111');
    // The first tenant's own messages still resolve correctly.
    const voice = entries.find((e) => e.type === 'voice');
    expect(voice?.message_id).toBe('1001');
    expect(voice?.chat_jid).toBe('tg:111');
  });
});
