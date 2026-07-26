import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import {
  sanitizeContent,
  isLegacyPathPlaceholder,
  main as sanitizeMain,
} from './sanitize-messages-content.js';

const macUserPath = (username: string, ...segments: string[]): string =>
  ['', 'Users', username, ...segments].join('/');

describe('sanitizeContent regexes', () => {
  it('strips voice path before transcript colon', () => {
    const input =
      '[Voice saved at /Users/example/my-assistant/claudeclaw/groups/telegram_fixture_user/received/2026-05-11T10-00-00-000Z-voice-aaa.oga: Привет, как дела?]';
    const output = sanitizeContent(input);
    expect(output).toBe('[Voice: Привет, как дела?]');
    expect(output).not.toContain('/Users/example/');
  });

  it('strips voice path before "— transcription failed"', () => {
    const input =
      '[Voice saved at /Users/example/foo/groups/telegram_main/received/x.oga — transcription failed]';
    const output = sanitizeContent(input);
    expect(output).toBe('[Voice — transcription failed]');
    expect(output).not.toContain('/Users/example/');
  });

  it('strips photo "Image saved at ..." with Read-tool hint', () => {
    const input =
      '[Image saved at /Users/example/groups/telegram_main/received/2026-05-11T11-00-00-000Z-deadbeef.jpg — use Read tool to view it. Caption: hi]';
    const output = sanitizeContent(input);
    expect(output).not.toContain('/Users/example/');
    expect(output).not.toContain('use Read tool');
    // Caption should survive
    expect(output).toContain('Caption: hi');
  });

  it('strips video-note path embedded inside placeholder', () => {
    const input =
      '[Video note saved at /Users/example/foo/bar/received/clip.mp4. Transcript: hello world]';
    const output = sanitizeContent(input);
    expect(output).not.toContain('/Users/example/');
    expect(output).toContain('Transcript: hello world');
  });

  it('handles audio variant with same shape as voice', () => {
    const input =
      '[Audio saved at /Users/example/my-assistant/claudeclaw/groups/telegram_main/received/x.mp3: lorem ipsum]';
    const output = sanitizeContent(input);
    expect(output).toBe('[Audio: lorem ipsum]');
    expect(output).not.toContain('/Users/example/');
  });

  it('leaves clean content untouched', () => {
    expect(sanitizeContent('Hello, world!')).toBe('Hello, world!');
    expect(sanitizeContent('[Voice: hi]')).toBe('[Voice: hi]');
  });

  it('PRESERVES free-form messages that merely mention a /Users/ path', () => {
    // Regression: the old catch-all regex destroyed any absolute macOS
    // home-path substring in any content. A real user message that quotes a
    // path must survive verbatim — it is not a media placeholder.
    const input =
      'See /Users/example/groups/telegram_main/received/foo.txt for details';
    const output = sanitizeContent(input);
    expect(output).toBe(input);
    expect(output).toContain('/Users/example/');
  });

  it('PRESERVES a real chat message asking about a code path', () => {
    const input =
      'Can you open /Users/you/projects/app/src/index.ts and fix the bug on line 42?';
    expect(sanitizeContent(input)).toBe(input);
  });

  it('PRESERVES bracketed text that is not a media placeholder', () => {
    // Starts with `[` but the type word is unknown, so it must not be touched
    // even though it embeds a /Users/ path.
    const input = '[Note] my logs live in /Users/username/Library/Logs/app.log';
    expect(sanitizeContent(input)).toBe(input);
  });

  it('PRESERVES a placeholder-looking prefix without the saved-at marker', () => {
    // `[Voice ...` but no ` saved at /Users/` artefact → leave untouched.
    const input = '[Voice memo] reminder: back up /Users/example/store today';
    expect(sanitizeContent(input)).toBe(input);
  });

  it('strips legacy paths from another macOS username', () => {
    const input =
      '[Voice saved at /Users/example/my-assistant/claudeclaw/groups/telegram_main/received/x.oga: Привет!]';
    const output = sanitizeContent(input);
    expect(output).toBe('[Voice: Привет!]');
    expect(output).not.toContain('/Users/example/');
  });

  it('preserves photo captions when removing legacy image paths', () => {
    const input =
      '[Image saved at /Users/example/my-assistant/claudeclaw/groups/telegram_main/received/x.jpg Caption: объект на фото]';
    const output = sanitizeContent(input);
    expect(output).toBe('[Photo Caption: объект на фото]');
    expect(output).not.toContain('/Users/example/');
  });

  it('PRESERVES a user /Users/ path inside a legacy placeholder caption (finding #76)', () => {
    // The save-path artefact is removed, but a /Users/ path that the user
    // typed into their own caption must survive verbatim. Previously the
    // unanchored belt-and-braces regex deleted EVERY /Users/ token in the
    // whole string, silently corrupting the caption text.
    const input =
      '[Photo saved at /Users/example/g/received/p.jpg Caption: see /Users/you/secret/path.txt please]';
    const output = sanitizeContent(input);
    expect(output).toBe(
      '[Photo Caption: see /Users/you/secret/path.txt please]',
    );
    // Save-path artefact gone, user-authored path kept.
    expect(output).not.toContain('/Users/example/g/received/p.jpg');
    expect(output).toContain('/Users/you/secret/path.txt');
  });

  it('PRESERVES a user /Users/ path inside a legacy voice transcript (finding #76)', () => {
    const input =
      '[Voice saved at /Users/example/foo/received/x.oga: please open /Users/username/notes and check it]';
    const output = sanitizeContent(input);
    expect(output).toBe(
      '[Voice: please open /Users/username/notes and check it]',
    );
    expect(output).not.toContain('/Users/example/');
    expect(output).toContain('/Users/username/notes');
  });

  it('strips document paths with spaces in the filename', () => {
    const input =
      '[Document "example-report-v1.2.3 (draft).txt" saved at /Users/example/my-assistant/claudeclaw/groups/whatsapp_fixture_chat/received/2026-04-28T12-55-43-699Z-example-report-v1.2.3 (draft).txt]';
    const output = sanitizeContent(input);
    expect(output).toBe('[Document "example-report-v1.2.3 (draft).txt"]');
    expect(output).not.toContain('/Users/example/');
  });

  it('PRESERVES bare home directory paths in free-form text', () => {
    // Regression: previously stripped to "working dir: only". A non-placeholder
    // message must keep its path intact.
    const input = 'working dir: /Users/example/ only';
    const output = sanitizeContent(input);
    expect(output).toBe(input);
    expect(output).toContain('/Users/example/');
  });

  it('isLegacyPathPlaceholder gates strictly on prefix + saved-at marker', () => {
    expect(
      isLegacyPathPlaceholder('[Voice saved at /Users/example/x.oga: hi]'),
    ).toBe(true);
    expect(
      isLegacyPathPlaceholder(
        '[Document "a.txt" saved at /Users/example/r/a.txt]',
      ),
    ).toBe(true);
    // Free-form text that mentions a path is NOT a placeholder.
    expect(isLegacyPathPlaceholder('open /Users/you/x.ts please')).toBe(false);
    // Placeholder prefix but no path artefact.
    expect(isLegacyPathPlaceholder('[Voice: hi]')).toBe(false);
    // Path artefact but unknown leading bracket type.
    expect(
      isLegacyPathPlaceholder(
        `[Note] /Users/you/x saved at ${macUserPath('username')}`,
      ),
    ).toBe(false);
    // A non-allowlisted synthetic username is still recognized at runtime;
    // constructing it from components keeps the source fixture anonymous.
    const arbitraryUserPlaceholder = `[Voice saved at ${macUserPath('fixture-person', 'x.oga')}: hi]`;
    expect(isLegacyPathPlaceholder(arbitraryUserPlaceholder)).toBe(true);
    expect(sanitizeContent(arbitraryUserPlaceholder)).toBe('[Voice: hi]');
  });
});

describe('sanitize-messages-content (script, sqlite fixture)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'sanitize-test-'));
    dbPath = path.join(dir, 'messages.db');
    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE messages (
        id TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        content TEXT,
        timestamp TEXT,
        PRIMARY KEY (id, chat_jid)
      );`,
    );
    const ins = db.prepare(
      'INSERT INTO messages (id, chat_jid, content, timestamp) VALUES (?, ?, ?, ?)',
    );
    ins.run(
      '1',
      'tg:1',
      '[Voice saved at /Users/example/foo/received/x.oga: Привет!]',
      '2026-05-11T10:00:00Z',
    );
    ins.run(
      '2',
      'tg:1',
      '[Image saved at /Users/example/foo/received/y.jpg — use Read tool to view it.]',
      '2026-05-11T10:00:30Z',
    );
    ins.run('3', 'tg:1', 'plain text, no path', '2026-05-11T10:00:40Z');
    // Free-form message that merely mentions a /Users/ path — must survive
    // the migration untouched (regression for the catch-all over-match).
    ins.run(
      '4',
      'tg:1',
      'please read /Users/example/my-assistant/claudeclaw/src/index.ts',
      '2026-05-11T10:00:50Z',
    );
    db.close();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('dry run does not modify rows and produces no backup file', async () => {
    const before = await listAll(dbPath);
    await sanitizeMain([
      'node',
      'sanitize-messages-content.js',
      '--dry',
      '--db',
      dbPath,
    ]);
    const after = await listAll(dbPath);
    expect(after).toEqual(before);

    const sibling = await fs.readdir(dir);
    const hasBackup = sibling.some((f) => f.includes('before-sanitize-'));
    expect(hasBackup).toBe(false);
  });

  it('--run rewrites rows and writes a backup snapshot', async () => {
    await sanitizeMain([
      'node',
      'sanitize-messages-content.js',
      '--run',
      '--db',
      dbPath,
    ]);

    const after = await listAll(dbPath);
    expect(after).toHaveLength(4);
    expect(after.find((r) => r.id === '1')?.content).toBe('[Voice: Привет!]');
    expect(after.find((r) => r.id === '2')?.content.includes('/Users/')).toBe(
      false,
    );
    // Plain row unchanged.
    expect(after.find((r) => r.id === '3')?.content).toBe(
      'plain text, no path',
    );
    // Free-form message that mentions a /Users/ path is preserved verbatim.
    expect(after.find((r) => r.id === '4')?.content).toBe(
      'please read /Users/example/my-assistant/claudeclaw/src/index.ts',
    );

    const sibling = await fs.readdir(dir);
    const hasBackup = sibling.some((f) => f.includes('before-sanitize-'));
    expect(hasBackup).toBe(true);
  });
});

async function listAll(
  dbPath: string,
): Promise<{ id: string; content: string }[]> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT id, content FROM messages ORDER BY id').all() as {
      id: string;
      content: string;
    }[];
  } finally {
    db.close();
  }
}
