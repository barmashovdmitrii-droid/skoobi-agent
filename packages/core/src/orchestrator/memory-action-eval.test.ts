import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGroupMemoryContext } from '@skoobi/memory/memory-context';
import {
  _clearMemoryWriteCapabilities,
  authorizeMemoryStateRequest,
  registerMemoryWriteCapability,
} from './memory-provenance.js';
import { handleMemoryStateRequest } from './memory-state-service.js';
import {
  ensureMemoryStateSchema,
  type MemoryStateListing,
} from './memory-state-store.js';
import type { SenderIdentity } from './types.js';

// Deterministic action-level evaluations of the real authenticated service and
// durable SQLite state. These are not model-behavior or prompt-following scores.
const identity: SenderIdentity = {
  channel: 'telegram',
  chat_id: '1001',
  telegram_user_id: '1001',
  identity_id: 'fixture-owner',
  is_owner_sender: true,
  telegram_message_origin: 'direct',
};
const folder = 'action_eval_owner';
let root: string;
let db: Database.Database;
let capability: string;
const input = (id: string, content: string, who = identity) => {
  const chat = `tg:${who.chat_id}`;
  const timestamp = new Date(
    Date.UTC(2026, 9, 1, 12, 0, Number(id)),
  ).toISOString();
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,0)').run(
    id,
    chat,
    who.telegram_user_id,
    content,
    timestamp,
  );
  db.prepare('INSERT INTO message_metadata VALUES (?,?,?)').run(
    id,
    chat,
    JSON.stringify(who),
  );
  db.prepare('INSERT INTO message_ingestion(id,chat_jid) VALUES (?,?)').run(
    id,
    chat,
  );
  return { kind: 'direct_user' as const, messageId: id, quote: content };
};
const grant = (id: string, who = identity, tenantId = 'fixture-tenant') =>
  registerMemoryWriteCapability(
    {
      groupFolder: folder,
      chatJid: `tg:${who.chat_id}`,
      isMain: who.is_owner_sender,
      tenantId,
      senderIdentity: who,
      memoryWriteAllowed: true,
      currentMessageIds: [id],
    },
    path.join(root, 'keys'),
  ).capability;
const call = (payload: unknown, cap = capability) => {
  const fields = {
    type: 'memory_state' as const,
    request_id: randomUUID(),
    payload,
  };
  return handleMemoryStateRequest(
    { ...fields, ...authorizeMemoryStateRequest(cap, fields) },
    folder,
    db,
  );
};
const fact = (
  value: string,
  revision: number,
  operationId: string = randomUUID(),
) => ({
  kind: 'fact_upsert',
  key: 'цвет',
  projectKey: null,
  value,
  factType: 'decision',
  expectedRevision: revision,
  operationId,
});
const restart = (latest: string) => {
  db.close();
  _clearMemoryWriteCapabilities();
  db = new Database(path.join(root, 'state.sqlite'));
  ensureMemoryStateSchema(db);
  capability = grant(latest);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-action-eval-'));
  db = new Database(path.join(root, 'state.sqlite'));
  db.exec(`CREATE TABLE messages(id TEXT,chat_jid TEXT,sender TEXT,content TEXT,timestamp TEXT,is_bot_message INTEGER,PRIMARY KEY(id,chat_jid));
    CREATE TABLE message_metadata(id TEXT,chat_jid TEXT,sender_identity_json TEXT,PRIMARY KEY(id,chat_jid));
    CREATE TABLE message_ingestion(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT,chat_jid TEXT);`);
  ensureMemoryStateSchema(db);
});
afterEach(() => {
  _clearMemoryWriteCapabilities();
  if (db.open) db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('memory action scenarios across transport retry, restart and identity boundaries', () => {
  it('keeps the corrected decision after a lost receipt and restart; stale recollection cannot replace it', () => {
    const old = input('1', 'Для подписей выбираем красный цвет.');
    capability = grant('1');
    expect(
      call({ action: 'mutate', operation: fact('Красный', 0), source: old }).ok,
    ).toBe(true);
    const corrected = input('2', 'Исправление: цвет подписи теперь синий.');
    capability = grant('2');
    const change = {
      action: 'mutate',
      operation: fact('Синий', 1, 'correction-retry'),
      source: corrected,
    };
    expect(call(change).ok).toBe(true); // receipt lost; caller does not know yet
    restart('2');
    expect(call(change)).toMatchObject({
      ok: true,
      data: { revision: 2, replayed: true },
    });
    expect(
      call({ action: 'mutate', operation: fact('Красный', 2), source: old }),
    ).toMatchObject({ ok: false, error: 'stale_source' });
    expect(
      call({
        action: 'mutate',
        operation: fact('Красный', 2),
        source: { kind: 'assistant_report' },
      }),
    ).toMatchObject({ ok: false, error: 'direct_fact_priority' });
    const listing = call({ action: 'list' });
    expect(listing.data).toMatchObject({
      facts: [
        {
          value: 'Синий',
          revision: 2,
          source: {
            messageId: '2',
            sourceReferenceTrust: 'verified_quote',
            contentTrust: 'agent_interpreted',
          },
        },
      ],
    });
    expect(JSON.stringify(listing.data)).not.toContain('Красный');
  });

  it('keeps an unfinished deliverable visible across restart without giving its claims to another identity', () => {
    const source = input('1', 'Подготовь пакет Атлас и проверь запуск.');
    capability = grant('1');
    const artifact = path.join(root, 'atlas-package.txt');
    fs.writeFileSync(artifact, 'fixture package');
    const card = {
      title: 'Атлас',
      goal: 'Подготовить пакет и проверить запуск',
      status: 'waiting',
      completed: ['Файл пакета создан'],
      pending: ['Проверить запуск в чистой папке', 'Доставить пакет'],
      waiting: 'Проверка результата',
      artifacts: [{ path: artifact, state: 'created' }],
    };
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'project_upsert',
          projectKey: 'atlas',
          card,
          expectedRevision: 0,
          operationId: 'project-create',
        },
        source,
      }).ok,
    ).toBe(true);
    restart('1');
    const recovered = call({ action: 'get_project', projectKey: 'atlas' });
    expect(recovered.data).toMatchObject({
      project: {
        card: {
          status: 'waiting',
          pending: ['Проверить запуск в чистой папке', 'Доставить пакет'],
          artifacts: [{ state: 'created' }],
        },
        evidence: 'reported_not_verified',
      },
    });
    const stranger = {
      ...identity,
      chat_id: '2002',
      telegram_user_id: '2002',
      identity_id: 'fixture-other',
      is_owner_sender: false,
    };
    input('3', 'Покажи мою память.', stranger);
    const otherCapability = grant('3', stranger, 'other-tenant');
    expect(call({ action: 'list' }, otherCapability).data).toMatchObject({
      projects: [],
      facts: [],
    });
    expect(
      call({ action: 'get_project', projectKey: 'atlas' }, otherCapability),
    ).toMatchObject({ ok: true, data: null });
    expect(
      call(
        { action: 'mutate', operation: fact('Придуманный', 0), source },
        otherCapability,
      ),
    ).toMatchObject({ ok: false, error: 'source_quote_mismatch' });
    expect(fs.readFileSync(artifact, 'utf8')).toBe('fixture package');
  });

  it('forgets current and historical structured values, suppresses raw automatic recall after restart, and blocks resurrection', () => {
    const original = input('1', 'Выбран цвет ультрамарин.');
    capability = grant('1');
    const remember = {
      action: 'mutate',
      operation: fact('Ультрамарин', 0, 'initial-memory'),
      source: original,
    };
    expect(call(remember).ok).toBe(true);
    const memoryPath = path.join(
      root,
      'groups',
      folder,
      'memory',
      'topics',
      'atlas.md',
    );
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    fs.writeFileSync(memoryPath, '- Атлас цвет: ультрамарин.');
    const remove = input('2', 'Забудь цвет.');
    capability = grant('2');
    expect(
      call({
        action: 'mutate',
        operation: {
          kind: 'forget',
          target: 'fact',
          projectKey: null,
          key: 'цвет',
          operationId: 'forget-color',
          expectedRevision: 1,
        },
        source: remove,
      }).ok,
    ).toBe(true);
    restart('2');
    const listing = call({ action: 'list' }).data as MemoryStateListing;
    expect(listing.facts).toEqual([]);
    expect(listing.hasTombstones).toBe(true);
    const stored = db
      .prepare('SELECT body_json,source_json FROM memory_state_versions')
      .all();
    expect(JSON.stringify(stored)).not.toContain('ультрамарин');
    expect(JSON.stringify(stored)).not.toContain('Ультрамарин');
    const oldRetry = call(remember);
    // A changed host authorization may reject the historical operation; either
    // allowed response must leave the erased value absent and unrecoverable.
    if (oldRetry.ok)
      expect(oldRetry.data).toMatchObject({ record: null, replayed: true });
    else expect(oldRetry.error).toBe('idempotency_conflict');
    expect((call({ action: 'list' }).data as MemoryStateListing).facts).toEqual(
      [],
    );
    expect(
      call({
        action: 'mutate',
        operation: fact('Ультрамарин', 2),
        source: original,
      }).ok,
    ).toBe(false);
    expect(
      loadGroupMemoryContext(path.join(root, 'groups'), folder, {
        lazyMemory: true,
        query: 'Атлас цвет',
        excludeLegacyMemory: listing.hasTombstones,
      }),
    ).toBe('');
    expect(fs.existsSync(memoryPath)).toBe(true); // forgetting never falsely claims archive wiping
    const fresh = input('3', 'Запомни цвет: теперь зелёный.');
    capability = grant('3');
    expect(
      call({ action: 'mutate', operation: fact('Зелёный', 2), source: fresh }),
    ).toMatchObject({
      ok: true,
      data: { revision: 3, record: { value: 'Зелёный' } },
    });
  });
});
