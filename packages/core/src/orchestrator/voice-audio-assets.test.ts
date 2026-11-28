import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, it, expect, vi } from 'vitest';
import {
  generateVoiceAudioAsset,
  readVoiceAudioAsset,
  resolveVoiceAudioFile,
} from './voice-audio-assets.js';
const roots: string[] = [],
  dbs: Database.Database[] = [];
const fixture = () => {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'voice-store-')),
  );
  roots.push(tmp);
  const db = new Database(path.join(tmp, 'state.db'));
  dbs.push(db);
  return {
    db,
    root: path.join(tmp, 'audio'),
    scope: {
      sourceGroup: 'voice-fixture',
      chatJid: 'test:recipient',
      ownerAuthorized: true,
    },
    assetId: randomUUID(),
    text: 'Fixture spoken text',
  };
};
const source = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-source-'));
  roots.push(root);
  const part = {
    ogg: path.join(root, 'a.ogg'),
    mp3: path.join(root, 'a.mp3'),
    wav: path.join(root, 'a.wav'),
  };
  fs.writeFileSync(part.ogg, 'OggS synthetic');
  fs.writeFileSync(part.mp3, 'ID3 synthetic');
  const wav = Buffer.alloc(48);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(40, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(4, 40);
  fs.writeFileSync(part.wav, wav);
  return {
    parts: [part],
    configuredProvider: 'fixture-no-network',
    configuredVoice: 'fixture',
    cleanup: vi.fn(() => fs.rmSync(root, { recursive: true, force: true })),
  };
};
afterEach(() => {
  dbs.splice(0).forEach((d) => {
    if (d.open) d.close();
  });
  roots
    .splice(0)
    .forEach((p) => fs.rmSync(p, { recursive: true, force: true }));
});
it('status of an absent asset is readonly and creates neither DB table nor directory', () => {
  const f = fixture();
  expect(readVoiceAudioAsset(f.db, f.scope, f.assetId)).toBeNull();
  expect(
    f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
  ).toEqual([]);
  expect(fs.existsSync(f.root)).toBe(false);
});
it('persists exact three formats independently from cleanup and database restart', async () => {
  const f = fixture(),
    audio = source(),
    generate = vi.fn(async () => audio);
  const result = await generateVoiceAudioAsset({ ...f, generate });
  expect(result.state).toBe('ready');
  expect(result.files).toHaveLength(3);
  expect(audio.cleanup).toHaveBeenCalledOnce();
  expect(fs.existsSync(audio.parts[0].ogg)).toBe(false);
  f.db.close();
  const db = new Database(path.join(path.dirname(f.root), 'state.db'));
  dbs.push(db);
  for (const format of ['ogg', 'mp3', 'wav'] as const) {
    const file = resolveVoiceAudioFile({ ...f, db, format, part: 1 });
    expect(fs.existsSync(file.path)).toBe(true);
    expect(fs.statSync(file.path).mode & 0o777).toBe(0o600);
  }
  expect(
    JSON.stringify(readVoiceAudioAsset(db, f.scope, f.assetId)),
  ).not.toContain(f.root);
  await generateVoiceAudioAsset({ ...f, db, generate });
  expect(generate).toHaveBeenCalledOnce();
});
it('deduplicates concurrent generation and prevents repeated provider call after a lost outcome', async () => {
  const f = fixture();
  let reject!: (e: Error) => void;
  const generate = vi.fn(
    () =>
      new Promise<ReturnType<typeof source>>((_resolve, r) => {
        reject = r;
      }),
  );
  const pending = generateVoiceAudioAsset({ ...f, generate });
  const same = await generateVoiceAudioAsset({
    ...f,
    assetId: randomUUID(),
    generate,
  });
  expect(same).toMatchObject({ assetId: f.assetId, state: 'generating' });
  reject(new Error('synthetic timeout'));
  expect((await pending).state).toBe('unknown');
  expect(
    (await generateVoiceAudioAsset({ ...f, assetId: randomUUID(), generate }))
      .state,
  ).toBe('unknown');
  expect(generate).toHaveBeenCalledOnce();
});
it('rejects cross-chat, cross-authority, modified bytes, symlinks and expired retrieval', async () => {
  const f = fixture();
  const ready = await generateVoiceAudioAsset({
    ...f,
    generate: async () => source(),
  });
  expect(
    readVoiceAudioAsset(
      f.db,
      { ...f.scope, ownerAuthorized: false },
      f.assetId,
    ),
  ).toBeNull();
  expect(
    readVoiceAudioAsset(f.db, { ...f.scope, chatJid: 'test:other' }, f.assetId),
  ).toBeNull();
  const p = resolveVoiceAudioFile({ ...f, format: 'mp3', part: 1 }).path;
  fs.writeFileSync(p, 'ID3 changed');
  expect(() => resolveVoiceAudioFile({ ...f, format: 'mp3', part: 1 })).toThrow(
    'audio_asset_changed',
  );
  fs.unlinkSync(p);
  fs.symlinkSync('/dev/null', p);
  expect(() =>
    resolveVoiceAudioFile({ ...f, format: 'mp3', part: 1 }),
  ).toThrow();
  expect(() =>
    resolveVoiceAudioFile({
      ...f,
      format: 'ogg',
      part: 1,
      now: Date.parse(ready.expiresAt) + 1,
    }),
  ).toThrow('audio_asset_not_ready');
});
it('fresh authorization is required after provider await; cleanup always occurs', async () => {
  const f = fixture(),
    audio = source();
  let allowed = true;
  const result = await generateVoiceAudioAsset({
    ...f,
    stillAuthorized: () => allowed,
    generate: async () => {
      allowed = false;
      return audio;
    },
  });
  expect(result.state).toBe('unknown');
  expect(audio.cleanup).toHaveBeenCalledOnce();
  expect(fs.existsSync(path.join(f.root, f.assetId))).toBe(false);
});
it('rejects mismatched generation identity and bounds pending storage before provider calls', async () => {
  const f = fixture();
  await generateVoiceAudioAsset({ ...f, generate: async () => source() });
  await expect(
    generateVoiceAudioAsset({ ...f, text: 'different', generate: vi.fn() }),
  ).rejects.toThrow('audio_id_conflict');
  const metadata = JSON.stringify({ files: [{ bytes: 240 * 1024 * 1024 }] });
  f.db.prepare('UPDATE voice_audio_assets SET metadata=?').run(metadata);
  const generate = vi.fn();
  await expect(
    generateVoiceAudioAsset({
      ...f,
      assetId: randomUUID(),
      text: 'fresh',
      generate,
    }),
  ).rejects.toThrow('audio_storage_limit');
  expect(generate).not.toHaveBeenCalled();
});
it('interrupted generation remains unknown across restart and readonly status leaves it unchanged', async () => {
  const f = fixture();
  await generateVoiceAudioAsset({ ...f, generate: async () => source() });
  f.db
    .prepare(
      "UPDATE voice_audio_assets SET state='generating',owner='previous-host'",
    )
    .run();
  expect(readVoiceAudioAsset(f.db, f.scope, f.assetId)?.state).toBe('unknown');
  expect(
    (
      f.db.prepare('SELECT state FROM voice_audio_assets').get() as {
        state: string;
      }
    ).state,
  ).toBe('generating');
  const generate = vi.fn();
  expect((await generateVoiceAudioAsset({ ...f, generate })).state).toBe(
    'unknown',
  );
  expect(generate).not.toHaveBeenCalled();
});

it('bounded expiry cleanup releases ready rows while unknown generation identities remain nonreplayable', async () => {
  const f = fixture();
  await generateVoiceAudioAsset({ ...f, generate: async () => source() });
  const original = f.db
    .prepare('SELECT * FROM voice_audio_assets LIMIT 1')
    .get() as Record<string, unknown>;
  const insert = f.db.prepare(
    'INSERT INTO voice_audio_assets VALUES(?,?,?,?,?,?,?)',
  );
  f.db.transaction(() => {
    for (let i = 0; i < 511; i++)
      insert.run(
        randomUUID(),
        original.scope,
        `expired-${i}`,
        'ready',
        1,
        '{"files":[]}',
        'prior',
      );
  })();
  const fresh = await generateVoiceAudioAsset({
    ...f,
    assetId: randomUUID(),
    text: 'new after expiry',
    generate: async () => source(),
  });
  expect(fresh.state).toBe('ready');
  expect(
    (
      f.db.prepare('SELECT count(*) n FROM voice_audio_assets').get() as {
        n: number;
      }
    ).n,
  ).toBe(481);
  f.db
    .prepare("UPDATE voice_audio_assets SET state='unknown',expires_at=1")
    .run();
  f.db.transaction(() => {
    for (let i = 0; i < 31; i++)
      insert.run(
        randomUUID(),
        original.scope,
        `unknown-${i}`,
        'unknown',
        1,
        '{"files":[]}',
        'prior',
      );
  })();
  const generate = vi.fn();
  await expect(
    generateVoiceAudioAsset({
      ...f,
      assetId: randomUUID(),
      text: 'new blocked',
      generate,
    }),
  ).rejects.toThrow('audio_journal_limit_review_unknown');
  expect(generate).not.toHaveBeenCalled();
});

it('a bounded generation timeout remains unknown and cleans late provider output', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(),
      audio = source();
    let release!: (value: typeof audio) => void;
    const generate = vi.fn(
      () =>
        new Promise<typeof audio>((resolve) => {
          release = resolve;
        }),
    );
    const pending = generateVoiceAudioAsset({ ...f, generate });
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect((await pending).state).toBe('unknown');
    release(audio);
    await Promise.resolve();
    await Promise.resolve();
    expect(audio.cleanup).toHaveBeenCalledOnce();
    expect((await generateVoiceAudioAsset({ ...f, generate })).state).toBe(
      'unknown',
    );
    expect(generate).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
