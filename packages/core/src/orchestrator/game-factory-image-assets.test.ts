import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FactoryActor } from './game-factory-contracts.js';
import {
  importFactoryImageAsset,
  observeFactoryImageJob,
} from './game-factory-image-assets.js';

const actor: FactoryActor = {
  identityId: 'fixture-image-owner',
  tenantId: 'fixture-tenant',
  chatJid: 'tg:7000001',
  channelChatId: '7000001',
  sourceGroup: 'fixture-main',
  senderId: '7000001',
  currentMessageIds: ['explicit-link'],
  runId: 'fixture-run',
};
const jobId = 'img-12345678-abcd-4321-abcd-123456789abc';
const artifactId = 'fixture-selected-image';
const sourceIdentity = {
  channel: 'telegram',
  chat_id: actor.channelChatId,
  identity_id: actor.identityId,
  telegram_user_id: actor.senderId,
  is_owner_sender: true,
  telegram_message_origin: 'direct',
};
const now = '2026-11-04T12:00:00.000Z';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nS8AAAAASUVORK5CYII=',
  'base64',
);
let db: Database.Database,
  root: string,
  groupsRoot: string,
  staged: string,
  destination: string;
const host = () => ({ db, groupsRoot });
const copy = () =>
  importFactoryImageAsset(
    { actor, jobId, artifactId, destinationRoot: destination },
    host(),
  );

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'factory-image-assets-')),
  );
  fs.chmodSync(root, 0o700);
  groupsRoot = path.join(root, 'groups');
  const imageRoot = path.join(
    groupsRoot,
    actor.sourceGroup,
    'output',
    'imagegen',
  );
  fs.mkdirSync(imageRoot, { recursive: true, mode: 0o700 });
  staged = path.join(imageRoot, `${jobId}-123456789abcdef0.png`);
  fs.writeFileSync(staged, png, { mode: 0o600 });
  fs.mkdirSync(path.join(root, 'project-assets'), { mode: 0o700 });
  destination = path.join(root, 'project-assets', 'selected');
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE image_jobs(id TEXT PRIMARY KEY,request_key TEXT,chat_jid TEXT,group_folder TEXT,provider TEXT,prompt_hash TEXT,status TEXT,generation_completed_at TEXT,updated_at TEXT);
    CREATE TABLE image_job_artifacts(id TEXT PRIMARY KEY,job_id TEXT,call_id TEXT,source_path TEXT,staged_path TEXT,ordinal INTEGER,status TEXT);
    CREATE TABLE messages(id TEXT,chat_jid TEXT,sender TEXT,is_bot_message INTEGER,is_from_me INTEGER,content TEXT);
    CREATE TABLE message_ingestion(sequence INTEGER,id TEXT,chat_jid TEXT);
    CREATE TABLE message_metadata(id TEXT,chat_jid TEXT,sender_identity_json TEXT);
    CREATE TABLE registered_groups(jid TEXT,folder TEXT,is_main INTEGER);
    CREATE TABLE tenants(tenant_id TEXT,folder TEXT,mode TEXT,channel TEXT,chat_id TEXT);
    CREATE TABLE events(event_id TEXT,type TEXT,actor TEXT,channel TEXT,tenant_id TEXT,chat_id TEXT,sender_id TEXT,payload_json TEXT,created_at INTEGER);
  `);
  db.prepare('INSERT INTO image_jobs VALUES(?,?,?,?,?,?,?,?,?)').run(
    jobId,
    `${actor.chatJid}:i:0000000000000001`,
    actor.chatJid,
    actor.sourceGroup,
    'codex_builtin',
    'a'.repeat(64),
    'delivering',
    now,
    now,
  );
  db.prepare('INSERT INTO image_job_artifacts VALUES(?,?,?,?,?,?,?)').run(
    artifactId,
    jobId,
    'fixture-call',
    '/must-not-read/original-private-path',
    staged,
    0,
    'generated',
  );
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(
    'original-image-message',
    actor.chatJid,
    actor.senderId,
    0,
    0,
    'PRIVATE ORIGINAL PROMPT: never expose this text',
  );
  db.prepare('INSERT INTO message_ingestion VALUES(?,?,?)').run(
    1,
    'original-image-message',
    actor.chatJid,
  );
  db.prepare('INSERT INTO message_metadata VALUES(?,?,?)').run(
    'original-image-message',
    actor.chatJid,
    JSON.stringify(sourceIdentity),
  );
  db.prepare('INSERT INTO registered_groups VALUES(?,?,?)').run(
    actor.chatJid,
    actor.sourceGroup,
    1,
  );
  db.prepare('INSERT INTO tenants VALUES(?,?,?,?,?)').run(
    actor.tenantId,
    actor.sourceGroup,
    'owner',
    'telegram',
    actor.channelChatId,
  );
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)').run(
    'host-image-event',
    'image_generation_requested',
    'system',
    'telegram',
    actor.tenantId,
    actor.channelChatId,
    actor.senderId,
    JSON.stringify({
      image_job_id: jobId,
      provider: 'codex_builtin',
      group_folder: actor.sourceGroup,
      prompt_hash: 'a'.repeat(16),
    }),
    1,
  );
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it('returns selected job metadata with verified origin and unknown cost/rights, without original text or identity', () => {
  const result = observeFactoryImageJob(actor, jobId, host());
  expect(result).toMatchObject({
    jobId,
    status: 'delivering',
    generationCompletedAt: now,
    artifacts: [{ id: artifactId, ordinal: 0, status: 'generated' }],
    cost: { status: 'unknown' },
    rights: { status: 'not_verified' },
  });
  expect(result.origin).toMatchObject({
    trust: 'host_verified',
    receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  for (const excluded of [
    'PRIVATE ORIGINAL',
    actor.identityId,
    actor.tenantId,
    actor.chatJid,
    'original-image-message',
    staged,
    'must-not-read',
  ])
    expect(JSON.stringify(result)).not.toContain(excluded);
});

it.each([
  { identityId: 'different-user' },
  { tenantId: 'different-tenant' },
  { senderId: 'different-sender' },
  { channelChatId: 'different-chat' },
  { chatJid: 'tg:7000002' },
  { sourceGroup: 'other-main' },
])(
  'denies cross-actor ownership even when the same job ID is known: %j',
  (change) => {
    expect(() =>
      observeFactoryImageJob({ ...actor, ...change }, jobId, host()),
    ).toThrow('image_job_unavailable');
  },
);

it.each([
  "UPDATE message_metadata SET sender_identity_json='null'",
  `UPDATE message_metadata SET sender_identity_json='${JSON.stringify({ ...sourceIdentity, telegram_message_origin: 'forwarded' })}'`,
  `UPDATE message_metadata SET sender_identity_json='${JSON.stringify({ ...sourceIdentity, is_owner_sender: false })}'`,
  "UPDATE image_jobs SET request_key='tg:7000001:2026-11-04T12:00:00.000Z'",
  "UPDATE events SET sender_id='different-sender'",
  "UPDATE events SET actor='agent'",
  "UPDATE events SET tenant_id='different-tenant'",
  'DELETE FROM events',
  "UPDATE tenants SET folder='other-main'",
  'UPDATE registered_groups SET is_main=0',
])(
  'fails closed for missing, legacy or inconsistent provenance: %s',
  (mutation) => {
    db.exec(mutation);
    expect(() => observeFactoryImageJob(actor, jobId, host())).toThrow(
      'image_job_unavailable',
    );
  },
);

it('imports only the selected image bytes and retries the exact immutable copy', async () => {
  fs.writeFileSync(
    path.join(path.dirname(staged), 'unrelated-owner-image.png'),
    Buffer.concat([png, Buffer.from('PRIVATE SIBLING')]),
    { mode: 0o600 },
  );
  const first = await copy();
  expect(first).toMatchObject({
    root: destination,
    jobId,
    artifactId,
    file: { path: path.basename(staged), size: png.length },
    cost: { status: 'unknown' },
    rights: { status: 'not_verified' },
  });
  expect(fs.readdirSync(destination)).toEqual([path.basename(staged)]);
  expect(fs.readFileSync(path.join(destination, first.file.path))).toEqual(png);
  expect(await copy()).toEqual(first);
  fs.appendFileSync(staged, 'changed source');
  await expect(copy()).rejects.toThrow();
  expect(fs.readFileSync(path.join(destination, first.file.path))).toEqual(png);
});

it('does not infer generation completion or delivery from an existing artifact', async () => {
  db.exec(
    "UPDATE image_jobs SET status='generating', generation_completed_at=NULL",
  );
  expect(observeFactoryImageJob(actor, jobId, host())).toMatchObject({
    status: 'generating',
    generationCompletedAt: null,
  });
  expect(await copy()).toMatchObject({
    artifactId,
    cost: { status: 'unknown' },
  });
  expect(db.prepare('SELECT status FROM image_jobs').get()).toEqual({
    status: 'generating',
  });
});

it.each(['path', 'name', 'symlink', 'hardlink'])(
  'rejects a substituted staged %s without reading a private source',
  async (kind) => {
    const outside = path.join(root, 'private-source.png');
    fs.writeFileSync(outside, png, { mode: 0o600 });
    if (kind === 'path')
      db.prepare('UPDATE image_job_artifacts SET staged_path=?').run(outside);
    else if (kind === 'name') {
      const other = path.join(path.dirname(staged), 'another-job.png');
      fs.renameSync(staged, other);
      db.prepare('UPDATE image_job_artifacts SET staged_path=?').run(other);
    } else {
      fs.unlinkSync(staged);
      if (kind === 'symlink') fs.symlinkSync(outside, staged);
      else fs.linkSync(outside, staged);
    }
    await expect(copy()).rejects.toThrow();
    expect(fs.readFileSync(outside)).toEqual(png);
    expect(fs.existsSync(destination)).toBe(false);
  },
);

it('rechecks exact actor provenance after asynchronous copy before issuing a receipt', async () => {
  const pending = copy();
  db.exec("UPDATE events SET tenant_id='revoked-tenant'");
  await expect(pending).rejects.toThrow('image_job_unavailable');
});
