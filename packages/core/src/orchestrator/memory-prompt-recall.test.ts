import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SemanticEncoder } from '@skoobi/memory/semantic-retrieval';
import {
  buildRecalledStructuredMemoryContext,
  createConfiguredMemoryEncoderProvider,
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
      source(),
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
    fact('decision', 'Private uniqueNeedle value');
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
              key: 'decision',
            },
            { ...source(), explicitForget: true },
            { now },
          );
        }
      }),
    );
    expect(result.context).not.toContain('Private uniqueNeedle value');
    expect(result.excludeLegacyMemory).toBe(true);
    expect(result.context).toContain('forgotten_memory');
  });
  it('discards a previously focused project when focus changes during the await', async () => {
    project('beta');
    project('alpha');
    fact('alpha-rule', 'OLD_ALPHA_CONTEXT', 'alpha');
    fact('beta-rule', 'CURRENT_BETA_CONTEXT', 'beta');
    let done = false;
    const result = await recall(
      { ...input, currentText: 'продолжай' },
      encoder((kind) => {
        if (kind === 'query' && !done) {
          done = true;
          mutateMemoryState(
            db,
            scope,
            {
              kind: 'project_activate',
              projectKey: 'beta',
              operationId: 'activate-beta',
              expectedRevision: 1,
            },
            { ...source(), explicitActivate: true },
            { now },
          );
        }
      }),
    );
    expect(result.context).not.toContain('OLD_ALPHA_CONTEXT');
    expect(result.context).toContain('CURRENT_BETA_CONTEXT');
  });
  it('does not revive a cancelled focus when the old passage finishes embedding', async () => {
    project('alpha');
    fact('alpha-rule', 'CANCELLED_ALPHA_CONTEXT', 'alpha');
    let done = false;
    const result = await recall(
      { ...input, currentText: 'продолжай' },
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
  it('rejects forwarded, mismatched sender/chat/bot and missing tenant before any read or embedding', async () => {
    db.close();
    let calls = 0;
    const variants: MemoryPromptIdentityInput[] = [
      { ...input, senderId: '202' },
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
