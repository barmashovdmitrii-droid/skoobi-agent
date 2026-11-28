import { ownerReadNameSource } from '../../test/read-name-message.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SemanticEncoder } from '@skoobi/memory/semantic-retrieval';
import {
  buildRecalledStructuredMemoryContext,
  createConfiguredMemoryEncoderProvider,
  createStructuredMemoryWarmer,
  memoryWarmEnabled,
  type MemoryPromptIdentityInput,
} from './memory-prompt-recall.js';
import {
  ensureMemoryStateSchema,
  mutateMemoryState,
  listMemoryState,
} from './memory-state-store.js';
import { ensureMemorySemanticSchema } from './memory-semantic-store.js';

const now = '2026-11-04T08:00:00.000Z';
const scope = {
  chatJid: 'tg:101',
  identityId: 'synthetic-owner',
  tenantId: 'synthetic-tenant',
};
const input: MemoryPromptIdentityInput = {
  chatJid: scope.chatJid,
  senderId: '101',
  senderIdentity: {
    chat_id: '101',
    telegram_user_id: '101',
    identity_id: scope.identityId,
    telegram_message_origin: 'direct',
    bot_id: 'telegram_default',
  },
  tenant: { tenant_id: scope.tenantId },
  currentText: 'Какой uniqueNeedle?',
};
describe('production prompt recall boundary', () => {
  let db: Database.Database, dir: string, seq: number;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-prompt-recall-'));
    db = new Database(path.join(dir, 'db.sqlite'));
    ensureMemoryStateSchema(db);
    ensureMemorySemanticSchema(db);
    seq = 0;
  });
  afterEach(() => {
    if (db.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const source = () => ({
    kind: 'direct_user' as const,
    at: now,
    messageId: String(++seq),
    quote: 'Synthetic direct instruction',
    currentDirectInput: true,
  });
  const fact = (key: string, value: string, projectKey: string | null = null) =>
    mutateMemoryState(
      db,
      scope,
      {
        kind: 'fact_upsert',
        key,
        value,
        projectKey,
        operationId: `put-${++seq}`,
        expectedRevision: 0,
      },
      source(),
      { now },
    );
  const project = (key: string) =>
    mutateMemoryState(
      db,
      scope,
      {
        kind: 'project_upsert',
        projectKey: key,
        operationId: `project-${key}`,
        expectedRevision: 0,
        card: {
          title: key,
          goal: 'Synthetic task',
          status: 'active',
          pending: [],
          completed: [],
          waiting: null,
          artifacts: [],
        },
      },
      { ...source(), quote: 'Подготовь ' + key },
      { now },
    );
  const encoder = (action?: (kind: string) => void): SemanticEncoder => ({
    fingerprint: 'synthetic-prompt-v1',
    dimensions: 3,
    async encode(texts, kind) {
      action?.(kind);
      return texts.map(() => [1, 0, 0]);
    },
  });
  const recall = (request = input, model?: SemanticEncoder) =>
    buildRecalledStructuredMemoryContext(db, request, {
      encoder: model,
      now: () => now,
    });

  // Week review (W07): the recall mode and counters were computed and
  // dropped; they now go to the memory_recall event, without any text.
  it('reports content-free recall counters, project selection and global facts', async () => {
    fact('token-economy', 'Экономить токены: uniqueNeedle только один день');
    project('alpha');
    fact('alpha-step', 'Alpha uniqueNeedle step', 'alpha');
    const plain = await recall(input, encoder());
    expect(plain.mode).toBe('hybrid');
    expect(plain.stats).toEqual({
      scanned: 1,
      cached: 0,
      embedded: 1,
      projectSelected: false,
      selectedBy: null,
      injectedFacts: 1,
      injectedGlobalFacts: 1,
    });
    const named = await recall({ ...input, currentText: 'Что по alpha uniqueNeedle?' });
    expect(named.stats).toMatchObject({
      reason: 'not_configured',
      projectSelected: true,
      selectedBy: 'explicit',
      injectedFacts: 2,
      injectedGlobalFacts: 1,
    });
    expect(JSON.stringify(named.stats)).not.toMatch(/alpha|uniqueNeedle|токены/);
  });

  it('supplements current exact records beyond the listing budget after authoritative recheck', async () => {
    fact('zz-target', 'Current uniqueNeedle value');
    for (let i = 0; i < 205; i++) fact(`noise-${i}`, 'Unrelated filler');
    expect(
      listMemoryState(db, scope, { now, limit: 200 }).facts.some(
        (f) => f.key === 'zz-target',
      ),
    ).toBe(false);
    const result = await recall();
    expect(result.context).toContain('Current uniqueNeedle value');
    expect(result.mode).toBe('lexical');
  });
  it('forgets during async embedding without stale content or legacy recall', async () => {
    const forgottenName = 'orchid-copper-fixture';
    fact(forgottenName, 'Private uniqueNeedle value');
    let done = false;
    const result = await recall(
      input,
      encoder((kind) => {
        if (kind === 'query' && !done) {
          done = true;
          mutateMemoryState(
            db,
            scope,
            {
              kind: 'forget',
              operationId: 'forget',
              expectedRevision: 1,
              target: 'fact',
              projectKey: null,
              key: forgottenName,
            },
            { ...source(), explicitForget: true },
            { now },
          );
        }
      }),
    );
    const checkErased = (output: typeof result) => {
      expect(output.excludeLegacyMemory).toBe(true);
      expect(output.context).toContain('forgotten_memory');
      expect(output.context.includes(forgottenName)).toBe(false);
      expect(output.context.includes('Private uniqueNeedle value')).toBe(false);
      // Explicit state inspection still provides the exact forget receipt.
      expect(listMemoryState(db, scope, { now }).tombstones.some(t => t.key === forgottenName)).toBe(true);
    };
    checkErased(result);
    db.close();
    db = new Database(path.join(dir, 'db.sqlite'));
    checkErased(await recall({ ...input, currentText: forgottenName }));
  });
  function beginVerifiedFollowUp() {
    db.exec(`CREATE TABLE messages(id TEXT,chat_jid TEXT,sender TEXT,content TEXT,timestamp TEXT,is_bot_message INTEGER);
      CREATE TABLE message_ingestion(id TEXT,chat_jid TEXT,sequence INTEGER);
      CREATE TABLE message_metadata(id TEXT,chat_jid TEXT,sender_identity_json TEXT);`);
    const addTurn = (id: string, content: string) => {
      db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,0)').run(id,scope.chatJid,input.senderId,content,now);
      db.prepare('INSERT INTO message_ingestion VALUES(?,?,?)').run(id,scope.chatJid,++seq);
      db.prepare('INSERT INTO message_metadata VALUES(?,?,?)').run(id,scope.chatJid,JSON.stringify({...input.senderIdentity,channel:'telegram'}));
    };
    const state = listMemoryState(db,scope,{now});
    addTurn(state.focusedSourceId!, 'Подготовь '+state.focusedProjectKey);
    addTurn('follow', 'продолжай');
    return addTurn;
  }
  it('discards a previously focused project when focus changes during the await', async () => {
    project('beta');
    project('alpha');
    fact('alpha-rule', 'OLD_ALPHA_CONTEXT', 'alpha');
    fact('beta-rule', 'CURRENT_BETA_CONTEXT', 'beta');
    const addTurn = beginVerifiedFollowUp();
    let done = false;
    const result = await recall(
      { ...input, currentText: 'продолжай', currentMessageId: 'follow' },
      encoder((kind) => {
        if (kind === 'query' && !done) {
          done = true;
          const next = {...source(), quote:'Продолжай beta', explicitActivate:true};
          addTurn(next.messageId, next.quote);
          mutateMemoryState(
            db,
            scope,
            {
              kind: 'project_activate',
              projectKey: 'beta',
              operationId: 'activate-beta',
              expectedRevision: 1,
            },
            next,
            { now },
          );
        }
      }),
    );
    expect(result.context).not.toContain('OLD_ALPHA_CONTEXT');
    expect(done).toBe(true);
    expect(result.context).not.toContain('CURRENT_BETA_CONTEXT');
    expect(result.stats?.projectSelected).toBe(false);
  });
  it('does not revive a cancelled focus when the old passage finishes embedding', async () => {
    project('alpha');
    fact('alpha-rule', 'CANCELLED_ALPHA_CONTEXT', 'alpha');
    beginVerifiedFollowUp();
    let done = false;
    const result = await recall(
      { ...input, currentText: 'продолжай', currentMessageId: 'follow' },
      encoder((kind) => {
        if (kind === 'query' && !done) {
          done = true;
          mutateMemoryState(
            db,
            scope,
            {
              kind: 'project_upsert',
              projectKey: 'alpha',
              operationId: 'cancel-alpha',
              expectedRevision: 1,
              card: {
                title: 'alpha',
                goal: 'Synthetic task',
                status: 'cancelled',
                pending: [],
                completed: [],
                waiting: null,
                artifacts: [],
              },
            },
            source(),
            { now },
          );
        }
      }),
    );
    expect(result.context).not.toContain('CANCELLED_ALPHA_CONTEXT');
  });
  it('revalidates the authorized link after async lookup, including results outside the 200-row listing', async () => {
    project('archive');
    project('workshop');
    const card = listMemoryState(db, scope, { now }).projects.find(p => p.projectKey === 'workshop')!.card;
    const link = (keys: string[], expectedRevision: number) => mutateMemoryState(db, scope, {
      kind: 'project_upsert', projectKey: 'workshop', card: { ...card, relatedProjectKeys: keys },
      expectedRevision, operationId: 'links-' + expectedRevision,
    }, ownerReadNameSource(db,scope,source().messageId,now,
      keys.length ? 'Свяжи проект workshop с проектом archive' : 'Убери связь проекта workshop с проектом archive'), { now });
    link(['archive'], 1);
    fact('zzz-needle', 'uniqueNeedle historical outcome', 'archive');
    for (let i = 0; i < 201; i++) fact('noise-' + i, 'Archive filler', 'archive');
    const message = { ...input, currentText: 'workshop uniqueNeedle' };
    const included = await recall(message);
    expect(included.context).toContain('uniqueNeedle historical outcome');
    expect(included.context).toContain('relatedHistory');
    let removed = false;
    const result = await recall(message, encoder((kind) => {
      if (kind === 'query' && !removed) { removed = true; link([], 2); }
    }));
    expect(result.context).not.toContain('historical outcome');
    expect(result.context).not.toContain('related_history');
  });

  it('rejects forwarded, mismatched sender/chat/bot and missing tenant before any read or embedding', async () => {
    db.close();
    let calls = 0;
    const variants: MemoryPromptIdentityInput[] = [
      { ...input, senderId: '202' },
      { ...input, chatJid: 'tg:alternate:101',
        senderIdentity: { ...input.senderIdentity!, bot_id: undefined } },
      { ...input, tenant: null },
      {
        ...input,
        senderIdentity: {
          ...input.senderIdentity!,
          telegram_message_origin: 'forwarded',
        },
      },
      {
        ...input,
        senderIdentity: { ...input.senderIdentity!, chat_id: '202' },
      },
      {
        ...input,
        senderIdentity: { ...input.senderIdentity!, bot_id: 'other' },
      },
    ];
    for (const request of variants) {
      const result = await recall(
        request,
        encoder(() => calls++),
      );
      expect(result.context).toBe('');
      expect(result.excludeLegacyMemory).toBe(true);
    }
    expect(calls).toBe(0);
  });
  it('suppresses legacy rather than returning an old snapshot when authoritative storage fails', async () => {
    fact('decision', 'Private uniqueNeedle value');
    const result = await recall(
      input,
      encoder((kind) => {
        if (kind === 'query') db.close();
      }),
    );
    expect(result.context).toContain('unavailable="true"');
    expect(result.context).not.toContain('Private uniqueNeedle value');
    expect(result.excludeLegacyMemory).toBe(true);
  });
  it('keeps fresh structured context but suppresses legacy when the optional FTS index is unavailable', async () => {
    fact('decision', 'Current uniqueNeedle value');
    db.exec('DROP TABLE memory_semantic_fts');
    const result = await recall();
    expect(result.context).toContain('Current uniqueNeedle value');
    expect(result.excludeLegacyMemory).toBe(true);
  });
  it('uses a single lazy encoder for repeated calls and defaults to no model', () => {
    const code = path.join(dir, 'code'),
      state = path.join(dir, 'state'),
      runtime = path.join(dir, 'model-runtime');
    for (const p of [code, state, runtime]) fs.mkdirSync(p);
    let config: Record<string, string | undefined> = {},
      created = 0,
      closed = 0;
    const model = encoder();
    model.close = () => closed++;
    const provider = createConfiguredMemoryEncoderProvider({
      codeRoot: code,
      stateRoot: state,
      readConfig: () => config,
      createEncoder: () => {
        created++;
        return model;
      },
    });
    expect(provider()).toBeUndefined();
    expect(created).toBe(0);
    config = {
      SKOOBI_MEMORY_SEMANTIC: 'local-e5',
      SKOOBI_MEMORY_EMBEDDINGS_DIR: runtime,
    };
    expect(provider()).toBe(model);
    expect(provider()).toBe(model);
    expect(created).toBe(1);
    config = {};
    expect(provider()).toBeUndefined();
    expect(closed).toBe(1);
    config = {
      SKOOBI_MEMORY_SEMANTIC: 'local-e5',
      SKOOBI_MEMORY_EMBEDDINGS_DIR: state,
    };
    expect(provider()).toBeUndefined();
    expect(created).toBe(1);
  });
});

// Week review (W07): the host warms vectors right after a memory write,
// in the background, one job at a time, never on the reply path.
describe('background vector warm after a memory write', () => {
  const encoder: SemanticEncoder = {
    fingerprint: 'synthetic-test-v1',
    dimensions: 3,
    async encode(texts) {
      return texts.map(() => [1, 0, 0]);
    },
  };
  const fakeDb = {} as Database.Database;
  it('runs after the write returns, merges repeats of one project and keeps going after a failure', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const warmer = createStructuredMemoryWarmer({
      encoder: () => encoder,
      enabled: () => true,
      warm: async (_db, _scope, options) => {
        calls.push(String(options.projectKey));
        if (options.projectKey === 'alpha') await gate;
        if (options.projectKey === 'beta') throw new Error('boom');
        return { scanned: 1, cached: 0, embedded: 1 };
      },
    });
    warmer.schedule(fakeDb, scope, 'alpha');
    expect(calls).toEqual([]); // nothing on the caller's tick
    await new Promise((resolve) => setImmediate(resolve));
    warmer.schedule(fakeDb, scope, 'beta');
    warmer.schedule(fakeDb, scope, 'gamma');
    warmer.schedule(fakeDb, scope, 'gamma');
    release();
    await warmer.idle();
    expect(calls).toEqual(['alpha', 'beta', 'gamma']);
  });
  it('does nothing when switched off or when no encoder is configured', async () => {
    const calls: unknown[] = [];
    const warm = async (..._args: unknown[]) => {
      calls.push(_args);
      return { scanned: 0, cached: 0, embedded: 0 };
    };
    const off = createStructuredMemoryWarmer({ encoder: () => encoder, enabled: () => false, warm });
    off.schedule(fakeDb, scope, 'alpha');
    await off.idle();
    const none = createStructuredMemoryWarmer({ encoder: () => undefined, enabled: () => true, warm });
    none.schedule(fakeDb, scope, null);
    await none.idle();
    expect(calls).toEqual([]);
  });
  it('the switch reads SKOOBI_MEMORY_SEMANTIC_WARM: on by default, 0/off/false turns it off', () => {
    expect(memoryWarmEnabled({})).toBe(true);
    for (const value of ['0', 'off', 'false', 'OFF', ' no '])
      expect(memoryWarmEnabled({ SKOOBI_MEMORY_SEMANTIC_WARM: value })).toBe(false);
    expect(memoryWarmEnabled({ SKOOBI_MEMORY_SEMANTIC_WARM: '1' })).toBe(true);
  });
  it('a real warm fills the vectors a later recall reuses', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-warm-'));
    const db = new Database(path.join(dir, 'memory.sqlite'));
    try {
      ensureMemoryStateSchema(db);
      ensureMemorySemanticSchema(db);
      mutateMemoryState(db, scope, {
        kind: 'project_upsert', projectKey: 'alpha', expectedRevision: 0, operationId: 'warm-project',
        card: { title: 'alpha', goal: 'Synthetic', status: 'active', pending: [], completed: [], waiting: null, artifacts: [] },
      }, { kind: 'direct_user', at: now, quote: 'alpha', messageId: 'w1' }, { now });
      mutateMemoryState(db, scope, {
        kind: 'fact_upsert', projectKey: 'alpha', key: 'rule', value: 'Alpha rule', expectedRevision: 0, operationId: 'warm-fact',
      }, { kind: 'direct_user', at: now, quote: 'Alpha rule', messageId: 'w2' }, { now });
      const warmer = createStructuredMemoryWarmer({ encoder: () => encoder, enabled: () => true });
      warmer.schedule(db, scope, 'alpha');
      await warmer.idle();
      expect(db.prepare('SELECT COUNT(*) AS n FROM memory_semantic_vectors').get()).toEqual({ n: 1 });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('decision evidence in the normal prompt', () => {
  const scope = { chatJid: 'tg:-1001234567890', identityId: 'test-speaker', tenantId: 'test-room' };
  const identity = {
    channel: 'telegram' as const, chat_id: '-1001234567890', telegram_user_id: '319',
    identity_id: scope.identityId, telegram_message_origin: 'direct' as const, is_owner_sender: true,
  };
  const old = '2024-02-07T12:00:00.000Z', current = '2024-06-03T09:00:00.000Z', later = '2024-06-04T09:00:00.000Z';
  let db: Database.Database;
  let writeMessage: typeof import('./db.js').storeMessage;
  const projectKey = 'glass';
  const direct = (at: string, id: string, quote: string) => ({ kind: 'direct_user' as const, at, messageId: id, quote });
  const saveDecision = (revision: number, value: string, id: string, at: string, remember = false) => {
    writeMessage({ id, content: value, timestamp: at, chat_jid: scope.chatJid, sender: '319', sender_name: 'Test', sender_identity: identity });
    return mutateMemoryState(db, scope, {
      kind: 'fact_upsert', projectKey, key: 'application', factType: 'decision',
      expectedRevision: revision, operationId: 'record-' + id, value,
    }, { ...direct(at, id, value), explicitRemember: remember }, { now: later });
  };
  const request = (query: string, model?: SemanticEncoder) => buildRecalledStructuredMemoryContext(db, {
    chatJid: scope.chatJid, senderId: '319', senderIdentity: identity,
    tenant: { tenant_id: scope.tenantId }, currentText: query,
  }, { now: () => later, encoder: model });
  beforeEach(async () => {
    const database = await import('./db.js');
    database._initTestDatabase();
    db = database.getDb();
    writeMessage = database.storeMessage;
    database.storeChatMetadata(scope.chatJid, old);
    ensureMemoryStateSchema(db);
    ensureMemorySemanticSchema(db);
    mutateMemoryState(db, scope, {
      kind: 'project_upsert', projectKey, expectedRevision: 0, operationId: 'glass-card',
      card: { title: 'Glass', goal: 'Synthetic application', status: 'active',
        pending: [], completed: [], waiting: null, artifacts: [{ path: 'test/build', state: 'delivered' }],
        work: { target: 'Fixture build', executor: 'Test', requirementsRevision: 1, nextStep: null,
          criteria: [{ key: 'compile', description: 'Build compiles', state: 'passed', checkedRevision: 1, evidence: 'build-report' }] },
      },
    }, { kind: 'assistant_report', at: old, messageId: '314' }, { now: later });
    saveDecision(0, 'Request declined; reason remains unconfirmed.', '311', old);
    saveDecision(1, 'Submit a new request; approval pending.', '312', current);
  });
  afterEach(() => { if (db.open) db.close(); });
  it('gives the current dated correction first and labels superseded history only on request', async () => {
    const ordinary = await request('Что решили по Glass?');
    expect(ordinary.context).toContain('approval pending');
    expect(ordinary.context).toContain('https://t.me/c/1234567890/312');
    expect(ordinary.context).toContain(current);
    expect(ordinary.context).not.toContain('declined');
    expect(ordinary.context).toContain('report_without_receipt');
    expect(ordinary.context).not.toContain('/314');
    expect(ordinary.context).toContain('reportedChecks');
    expect(ordinary.context).toContain('build-report');
    expect(ordinary.context).toContain('reportedState');
    const history = (await request('История решений Glass, что изменилось?')).context;
    expect(history.indexOf('approval pending')).toBeLessThan(history.indexOf('<superseded_decision>'));
    expect(history).toContain('reason remains unconfirmed');
    expect(history).toContain('https://t.me/c/1234567890/311');
    expect(history).toContain(old);
    expect(history.length).toBeLessThanOrEqual(6500);
  });
  it('retains uncertainty when the original message is edited or belongs to another speaker', async () => {
    db.prepare('UPDATE messages SET content=? WHERE id=? AND chat_jid=?').run('Edited text', '312', scope.chatJid);
    db.prepare('UPDATE messages SET sender=? WHERE id=? AND chat_jid=?').run('401', '311', scope.chatJid);
    const result = await request('История решений Glass');
    expect(result.context).toContain('approval pending');
    expect(result.context).toContain('source_unavailable');
    expect(result.context).not.toContain('https://t.me/c/');
  });
  it('withholds a stored message pointer when its Telegram bot metadata no longer matches', async () => {
    db.prepare("UPDATE message_metadata SET sender_identity_json=json_set(sender_identity_json,'$.bot_id',?) WHERE id=? AND chat_jid=?")
      .run('different-bot', '312', scope.chatJid);
    const answer = await request('Что решили по Glass?');
    expect(answer.context).toContain('approval pending');
    expect(answer.context).toContain('source_unavailable');
    expect(answer.context).not.toContain('https://t.me/c/');
  });
  it('takes the opposite scoped correction written while the encoder is awaiting the query', async () => {
    const encoder: SemanticEncoder = { dimensions: 3, fingerprint: 'fixture-evidence', async encode(texts, kind) {
      if (kind === 'query') saveDecision(2, 'Withdraw the new request.', '315', later);
      return texts.map(() => [1,0,0]);
    } };
    const result = await request('Что решили по Glass?', encoder);
    expect(result.context).toContain('Withdraw the new request.');
    expect(result.context).toContain('https://t.me/c/1234567890/315');
    expect(result.context).not.toContain('approval pending');
    expect(result.context).not.toContain('https://t.me/c/1234567890/312');
  });
  it('keeps forgotten revisions, legacy excerpts and vectors out of historical recall after reopening', async () => {
    await request('История решений Glass', {
      dimensions: 3, fingerprint: 'fixture-before-forget', async encode(texts) { return texts.map(() => [1,0,0]); },
    });
    mutateMemoryState(db, scope, { kind: 'forget', target: 'fact', projectKey, key: 'application',
      operationId: 'forget-application', expectedRevision: 2 },
      { ...direct(later, '316', 'Forget application'), explicitForget: true }, { now: later });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-decision-reopen-'));
    try {
      const file = path.join(dir, 'snapshot.db');
      await db.backup(file);
      db.close();
      db = new Database(file);
      const forgotten = await request('История решений Glass');
      expect(forgotten.excludeLegacyMemory).toBe(true);
      expect(forgotten.context).not.toContain('approval pending');
      expect(forgotten.context).not.toContain('declined');
      expect(db.prepare('SELECT count(*) AS n FROM memory_semantic_vectors').get()).toEqual({ n: 0 });
      mutateMemoryState(db, scope, { kind: 'fact_upsert', projectKey, key: 'application', factType: 'decision',
        expectedRevision: 3, operationId: 'remember-fresh', value: 'Fresh review only.' },
        { ...direct(later, '317', 'Fresh review only.'), explicitRemember: true }, { now: later });
      const fresh = await request('История решений Glass');
      expect(fresh.context).toContain('Fresh review only.');
      expect(fresh.context).not.toContain('<superseded_decision>');
      expect(fresh.context).not.toContain('declined');
    } finally { if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
