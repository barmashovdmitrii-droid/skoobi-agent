import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { GeneratedVoiceAudio } from '@skoobi/shared/channel-types';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';
import type { FileDeliveryScope } from './file-delivery.js';
export type VoiceFormat = 'ogg' | 'mp3' | 'wav';
interface VoiceFile {
  part: number;
  format: VoiceFormat;
  name: string;
  bytes: number;
  sha256: string;
}
export interface VoiceAudioAsset {
  assetId: string;
  state: 'generating' | 'ready' | 'unknown' | 'expired';
  code: string;
  files: VoiceFile[];
  expiresAt: string;
  configuredProvider?: string;
  configuredVoice?: string;
  derivation?: 'wav_mp3_from_generated_ogg';
  durationSeconds?: number;
  textSha256?: string;
}
interface Row {
  id: string;
  scope: string;
  text_hash: string;
  state: string;
  expires_at: number;
  metadata: string;
  owner: string;
}
const active = new Set<string>(),
  processOwner = randomUUID();
const TTL = 7 * 86400_000,
  MAX_BYTES = 96 * 1024 * 1024,
  SCOPE_BYTES = 256 * 1024 * 1024,
  GLOBAL_BYTES = 1024 * 1024 * 1024;
const idOk = (id: string) =>
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id);
const hash = (b: string | Buffer) =>
  createHash('sha256').update(b).digest('hex');
const scopeHash = (s: FileDeliveryScope) =>
  hash(JSON.stringify([s.sourceGroup, s.chatJid, s.ownerAuthorized === true]));
function table(db: Database.Database) {
  return !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE name='voice_audio_assets' AND type='table'",
    )
    .get();
}
function schema(db: Database.Database) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS voice_audio_assets(id TEXT PRIMARY KEY,scope TEXT NOT NULL,text_hash TEXT NOT NULL,state TEXT NOT NULL,expires_at INTEGER NOT NULL,metadata TEXT NOT NULL,owner TEXT NOT NULL); CREATE INDEX IF NOT EXISTS voice_audio_scope ON voice_audio_assets(scope,text_hash);`,
  );
}
function view(r: Row, now: number): VoiceAudioAsset {
  const meta = JSON.parse(r.metadata) as Partial<VoiceAudioAsset>;
  const state =
    r.expires_at <= now
      ? 'expired'
      : r.state === 'generating' &&
          (r.owner !== processOwner || !active.has(r.id))
        ? 'unknown'
        : (r.state as VoiceAudioAsset['state']);
  return {
    assetId: r.id,
    state,
    code:
      state === 'ready'
        ? 'audio_saved'
        : state === 'expired'
          ? 'audio_expired'
          : state === 'generating'
            ? 'audio_generation_pending'
            : 'audio_generation_unknown_do_not_regenerate',
    files: meta.files ?? [],
    expiresAt: new Date(r.expires_at).toISOString(),
    textSha256: r.text_hash,
    ...(typeof meta.durationSeconds === 'number'
      ? { durationSeconds: meta.durationSeconds }
      : {}),
    ...(meta.configuredProvider
      ? { configuredProvider: meta.configuredProvider }
      : {}),
    ...(meta.configuredVoice ? { configuredVoice: meta.configuredVoice } : {}),
    ...(meta.derivation ? { derivation: meta.derivation } : {}),
  };
}
export function readVoiceAudioAsset(
  db: Database.Database,
  scope: FileDeliveryScope,
  id: string,
  now = Date.now(),
): VoiceAudioAsset | null {
  if (!idOk(id) || !table(db)) return null;
  const r = db
    .prepare('SELECT * FROM voice_audio_assets WHERE id=? AND scope=?')
    .get(id, scopeHash(scope)) as Row | undefined;
  return r ? view(r, now) : null;
}
function safeDirectory(root: string, create = false): string {
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const real = fs.realpathSync(root),
    stat = fs.lstatSync(root);
  const expected =
    process.platform === 'darwin'
      ? path
          .resolve(root)
          .replace(/^\/tmp(?=\/|$)/, '/private/tmp')
          .replace(/^\/var(?=\/|$)/, '/private/var')
      : path.resolve(root);
  if (
    real !== expected ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('audio_store_unsafe');
  return real;
}
function readAudio(file: string, format: VoiceFormat) {
  const { buffer } = readBoundedRegularFileNoFollowSync(file, {
    maxBytes: 32 * 1024 * 1024,
    oversize: 'reject',
    requireSingleLink: true,
  });
  const valid =
    format === 'ogg'
      ? buffer.subarray(0, 4).toString() === 'OggS'
      : format === 'wav'
        ? buffer.subarray(0, 4).toString() === 'RIFF' &&
          buffer.subarray(8, 12).toString() === 'WAVE'
        : buffer.subarray(0, 3).toString() === 'ID3' ||
          (buffer[0] === 255 && (buffer[1] & 0xe0) === 0xe0);
  if (!valid) throw new Error('audio_format_invalid');
  return buffer;
}
/** Returns a host-only path after checking scope, TTL and exact saved bytes. */
export function resolveVoiceAudioFile(input: {
  db: Database.Database;
  root: string;
  scope: FileDeliveryScope;
  assetId: string;
  format: VoiceFormat;
  part: number;
  now?: number;
}): { path: string; file: VoiceFile } {
  const asset = readVoiceAudioAsset(
    input.db,
    input.scope,
    input.assetId,
    input.now,
  );
  if (asset?.state !== 'ready') throw new Error('audio_asset_not_ready');
  const file = asset.files.find(
    (f) => f.part === input.part && f.format === input.format,
  );
  if (!file || file.name !== `part-${input.part}.${input.format}`)
    throw new Error('audio_file_missing');
  const root = safeDirectory(input.root);
  const directory = safeDirectory(path.join(root, input.assetId));
  const filename = path.join(directory, file.name),
    bytes = readAudio(filename, file.format);
  if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
    throw new Error('audio_asset_changed');
  return { path: filename, file };
}

/** Durable intent precedes provider work; an interrupted request is never replayed.
 * Cleanup is bounded and only removes expired directories named by this journal. */
export async function generateVoiceAudioAsset(input: {
  db: Database.Database;
  root: string;
  scope: FileDeliveryScope;
  assetId: string;
  text: string;
  now?: () => number;
  generate: () => Promise<GeneratedVoiceAudio>;
  stillAuthorized?: () => boolean;
}): Promise<VoiceAudioAsset> {
  const { db } = input,
    now = input.now ?? Date.now;
  if (!idOk(input.assetId) || !input.text.trim() || input.text.length > 12_000)
    throw new Error('invalid_voice_request');
  schema(db);
  const scope = scopeHash(input.scope),
    textHash = hash(input.text);
  safeDirectory(input.root, true);
  const old = db
    .prepare('SELECT * FROM voice_audio_assets WHERE id=?')
    .get(input.assetId) as Row | undefined;
  if (old) {
    if (old.scope !== scope || old.text_hash !== textHash)
      throw new Error('audio_id_conflict');
    return view(old, now());
  }
  const same = db
    .prepare(
      "SELECT * FROM voice_audio_assets WHERE scope=? AND text_hash=? AND (expires_at>? OR state IN ('unknown','generating')) ORDER BY expires_at DESC LIMIT 1",
    )
    .get(scope, textHash, now()) as Row | undefined;
  if (same) return view(same, now());
  const rows = db
    .prepare('SELECT * FROM voice_audio_assets LIMIT 4097')
    .all() as Row[];
  for (const row of rows.filter((r) => r.expires_at <= now()).slice(0, 32)) {
    if (idOk(row.id) && !active.has(row.id)) {
      fs.rmSync(path.join(input.root, row.id), {
        recursive: true,
        force: true,
      });
      if (row.state === 'ready')
        db.prepare(
          "DELETE FROM voice_audio_assets WHERE id=? AND state='ready' AND expires_at<=?",
        ).run(row.id, now());
    }
  }
  const count = db
    .prepare('SELECT count(*) n FROM voice_audio_assets WHERE scope=?')
    .get(scope) as { n: number };
  const globalCount = db
    .prepare('SELECT count(*) n FROM voice_audio_assets')
    .get() as { n: number };
  if (count.n >= 512 || globalCount.n >= 4096)
    throw new Error('audio_journal_limit_review_unknown');
  const size = (r: Row) => {
    try {
      return (JSON.parse(r.metadata).files ?? []).reduce(
        (sum: number, f: VoiceFile) => sum + f.bytes,
        0,
      );
    } catch {
      return GLOBAL_BYTES;
    }
  };
  const retained = rows.filter((r) => r.expires_at > now());
  // Reserve worst-case space before asynchronous generation. Pending rows count too.
  const charge = (r: Row) => (r.state !== 'ready' ? MAX_BYTES : size(r));
  if (
    retained.reduce((s, r) => s + charge(r), 0) + MAX_BYTES > GLOBAL_BYTES ||
    retained
      .filter((r) => r.scope === scope)
      .reduce((s, r) => s + charge(r), 0) +
      MAX_BYTES >
      SCOPE_BYTES
  )
    throw new Error('audio_storage_limit');
  if (input.stillAuthorized && !input.stillAuthorized())
    throw new Error('audio_authorization_revoked');
  db.prepare('INSERT INTO voice_audio_assets VALUES(?,?,?,?,?,?,?)').run(
    input.assetId,
    scope,
    textHash,
    'generating',
    now() + TTL,
    JSON.stringify({ files: [] }),
    processOwner,
  );
  active.add(input.assetId);
  let generated: GeneratedVoiceAudio | undefined;
  let temp: string | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const pending = input.generate();
    void pending
      .then((late) => {
        if (timedOut) {
          try {
            late.cleanup();
          } catch {
            /* provider finished after the request was marked unknown */
          }
        }
      })
      .catch(() => {});
    generated = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          timedOut = true;
          reject(new Error('audio_generation_timeout'));
        }, 10 * 60_000);
        deadline.unref?.();
      }),
    ]);
    if (input.stillAuthorized && !input.stillAuthorized())
      throw new Error('audio_authorization_revoked');
    if (!generated.parts.length || generated.parts.length > 8)
      throw new Error('audio_parts_invalid');
    temp = fs.mkdtempSync(path.join(input.root, '.voice-'));
    fs.chmodSync(temp, 0o700);
    const files: VoiceFile[] = [];
    let bytes = 0;
    let durationSeconds = 0;
    for (const [index, part] of generated.parts.entries())
      for (const format of ['ogg', 'mp3', 'wav'] as const) {
        const data = readAudio(part[format], format);
        if (format === 'wav') durationSeconds += wavDuration(data);
        bytes += data.length;
        if (bytes > MAX_BYTES) throw new Error('audio_size_limit');
        const name = `part-${index + 1}.${format}`;
        fs.writeFileSync(path.join(temp, name), data, {
          flag: 'wx',
          mode: 0o600,
        });
        files.push({
          part: index + 1,
          format,
          name,
          bytes: data.length,
          sha256: hash(data),
        });
      }
    const metadata = {
      files,
      durationSeconds,
      sourceText: input.text,
      configuredProvider: generated.configuredProvider.slice(0, 80),
      configuredVoice: generated.configuredVoice.slice(0, 160),
      derivation: 'wav_mp3_from_generated_ogg',
    };
    fs.writeFileSync(
      path.join(temp, 'metadata.json'),
      JSON.stringify(metadata),
      { flag: 'wx', mode: 0o600 },
    );
    const target = path.join(input.root, input.assetId);
    if (fs.existsSync(target)) throw new Error('audio_target_exists');
    fs.renameSync(temp, target);
    temp = undefined;
    db.prepare(
      "UPDATE voice_audio_assets SET state='ready',metadata=? WHERE id=? AND scope=? AND state='generating'",
    ).run(JSON.stringify(metadata), input.assetId, scope);
  } catch {
    db.prepare(
      "UPDATE voice_audio_assets SET state='unknown' WHERE id=? AND scope=?",
    ).run(input.assetId, scope);
  } finally {
    if (deadline) clearTimeout(deadline);
    active.delete(input.assetId);
    try {
      generated?.cleanup();
    } catch {
      /* persisted assets are independent */
    }
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
  return readVoiceAudioAsset(db, input.scope, input.assetId, now())!;
}

/** Duration from the generated PCM WAV; no decoder or network needed. */
export function wavDuration(buffer: Buffer): number {
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new Error('audio_wav_invalid');
  let byteRate = 0,
    dataSize = 0;
  for (let pos = 12; pos + 8 <= buffer.length; ) {
    const size = buffer.readUInt32LE(pos + 4),
      end = pos + 8 + size;
    if (end > buffer.length) throw new Error('audio_wav_invalid');
    const kind = buffer.toString('ascii', pos, pos + 4);
    if (kind === 'fmt ') {
      if (size < 16 || buffer.readUInt16LE(pos + 8) !== 1)
        throw new Error('audio_wav_invalid');
      byteRate = buffer.readUInt32LE(pos + 16);
    }
    if (kind === 'data') dataSize += size;
    pos = end + (size % 2);
  }
  const duration = dataSize / byteRate;
  if (!byteRate || !dataSize || !Number.isFinite(duration) || duration > 3600)
    throw new Error('audio_wav_invalid');
  return duration;
}
