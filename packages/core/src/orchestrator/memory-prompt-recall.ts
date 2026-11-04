import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { parseTelegramJid, safeTelegramBotId } from '@skoobi/shared';
import {
  createLocalSemanticEncoder,
  type SemanticEncoder,
} from '@skoobi/memory/semantic-retrieval';
import { CODE_ROOT, STATE_ROOT } from './config.js';
import { readEnvFile } from './env.js';
import { buildStructuredMemoryContext } from './memory-state-context.js';
import {
  listMemoryState,
  type MemoryStateRecord,
  type MemoryStateScope,
} from './memory-state-store.js';
import { recallStructuredMemory } from './memory-semantic-store.js';

export interface MemoryPromptIdentityInput {
  chatJid: string;
  senderId: string | null | undefined;
  senderIdentity?: {
    telegram_message_origin?: string;
    telegram_user_id?: string;
    identity_id?: string;
    chat_id?: string;
    bot_id?: string;
  } | null;
  tenant?: { tenant_id: string } | null;
  currentText?: string;
}
export interface RecalledStructuredMemoryContext {
  context: string;
  recallQuery?: string;
  excludeLegacyMemory: boolean;
  mode?: 'lexical' | 'hybrid' | 'hybrid_partial';
}
function trustedScope(
  input: MemoryPromptIdentityInput,
): MemoryStateScope | undefined {
  const identity = input.senderIdentity,
    jid = parseTelegramJid(input.chatJid);
  if (
    input.currentText === undefined ||
    !jid ||
    identity?.telegram_message_origin !== 'direct' ||
    !identity.identity_id ||
    !identity.telegram_user_id ||
    !input.tenant?.tenant_id ||
    input.senderId !== identity.telegram_user_id ||
    identity.chat_id !== jid.chatId ||
    (identity.bot_id &&
      safeTelegramBotId(identity.bot_id) !== safeTelegramBotId(jid.botId))
  )
    return;
  return {
    chatJid: input.chatJid,
    identityId: identity.identity_id,
    tenantId: input.tenant.tenant_id,
  };
}
const unavailable = (): RecalledStructuredMemoryContext => ({
  excludeLegacyMemory: true,
  context:
    '<structured_memory unavailable="true">Current records could not be read. Do not infer that memory is empty or claim a change was saved.</structured_memory>',
});

/** Revalidate the exact returned IDs inside the final read transaction. This
 * supplements listing's 200-row budget without trusting detached cache results.
 * Neither ids nor vectors can supply facts, change scope, or select a project. */
function currentReturnedFacts(
  db: Database.Database,
  scope: MemoryStateScope,
  selected: string | null,
  refs: readonly Extract<MemoryStateRecord, { kind: 'fact' }>[],
  now: string,
): Extract<MemoryStateRecord, { kind: 'fact' }>[] {
  const scopeId = JSON.stringify([
    scope.chatJid.trim(),
    scope.identityId.trim(),
    scope.tenantId.trim(),
  ]);
  const get = db.prepare(
    `SELECT item_key,project_key,revision,body_json,source_json,updated_at FROM memory_state_records WHERE scope_key=? AND record_key=? AND kind='fact' AND revision=? AND forgotten=0 AND body_json IS NOT NULL AND source_json IS NOT NULL AND (json_extract(body_json,'$.validUntil') IS NULL OR json_extract(body_json,'$.validUntil')>?)`,
  );
  return refs.slice(0, 20).flatMap((ref) => {
    if (ref.projectKey !== null && ref.projectKey !== selected) return [];
    const row = get.get(
      scopeId,
      JSON.stringify(['fact', ref.projectKey, ref.key]),
      ref.revision,
      now,
    ) as
      | {
          item_key: string;
          project_key: string;
          revision: number;
          body_json: string;
          source_json: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return [];
    return [
      {
        ...JSON.parse(row.body_json),
        kind: 'fact',
        projectKey: row.project_key || null,
        key: row.item_key,
        revision: row.revision,
        updatedAt: row.updated_at,
        source: JSON.parse(row.source_json),
        evidence: 'reported_not_verified',
      },
    ];
  });
}

export async function buildRecalledStructuredMemoryContext(
  db: Database.Database,
  input: MemoryPromptIdentityInput,
  options: { encoder?: SemanticEncoder; now?: () => string } = {},
): Promise<RecalledStructuredMemoryContext> {
  const scope = trustedScope(input);
  if (!scope)
    return {
      context: '',
      excludeLegacyMemory:
        input.currentText !== undefined && input.chatJid.startsWith('tg:'),
    };
  const now = options.now ?? (() => new Date().toISOString());
  try {
    const before = listMemoryState(db, scope, { limit: 200, now: now() });
    const selected = buildStructuredMemoryContext(before, input.currentText!);
    const recalled = await recallStructuredMemory(db, scope, {
      query: selected.recallQuery,
      projectKey: selected.selectedProjectKey,
      encoder: options.encoder,
      now: options.now?.(),
      limit: 10,
    });
    return db.transaction(() => {
      const after = listMemoryState(db, scope, { limit: 200, now: now() });
      const current = buildStructuredMemoryContext(after, input.currentText!);
      const refs =
        current.selectedProjectKey === selected.selectedProjectKey
          ? recalled.facts
          : [];
      const facts = currentReturnedFacts(
        db,
        scope,
        current.selectedProjectKey,
        refs,
        now(),
      );
      const keys = new Set(
        facts.map((f) => JSON.stringify([f.projectKey, f.key])),
      );
      after.facts = [
        ...facts,
        ...after.facts.filter(
          (f) => !keys.has(JSON.stringify([f.projectKey, f.key])),
        ),
      ];
      const state = buildStructuredMemoryContext(after, input.currentText!, {
        recalledFacts: facts,
      });
      return {
        context: state.context,
        recallQuery: state.recallQuery,
        excludeLegacyMemory:
          after.hasTombstones || recalled.reason === 'storage_unavailable',
        mode: recalled.mode,
      };
    })();
  } catch {
    return unavailable();
  }
}

const KEYS = ['SKOOBI_MEMORY_SEMANTIC', 'SKOOBI_MEMORY_EMBEDDINGS_DIR'];
/** One service-wide lazy encoder. Only explicit host configuration opts in.
 * A missing installation is retried at most once/minute; no runtime installer. */
export function createConfiguredMemoryEncoderProvider(
  options: {
    readConfig?: () => Record<string, string | undefined>;
    codeRoot?: string;
    stateRoot?: string;
    createEncoder?: typeof createLocalSemanticEncoder;
    now?: () => number;
  } = {},
): () => SemanticEncoder | undefined {
  let encoder: SemanticEncoder | undefined,
    previous = '',
    retryAt = 0;
  return () => {
    try {
      const config =
        options.readConfig?.() ??
        (() => {
          const file = readEnvFile(KEYS);
          return Object.fromEntries(
            KEYS.map((key) => [key, process.env[key] ?? file[key]]),
          );
        })();
      const directory = config.SKOOBI_MEMORY_EMBEDDINGS_DIR;
      const key = JSON.stringify([config.SKOOBI_MEMORY_SEMANTIC, directory]);
      const now = options.now?.() ?? Date.now();
      if (key === previous && (encoder || now < retryAt)) return encoder;
      encoder?.close?.();
      encoder = undefined;
      previous = key;
      retryAt = now + 60000;
      if (
        config.SKOOBI_MEMORY_SEMANTIC !== 'local-e5' ||
        !directory ||
        !path.isAbsolute(directory)
      )
        return;
      const real = fs.realpathSync(directory);
      for (const denied of [
        options.codeRoot ?? CODE_ROOT,
        options.stateRoot ?? STATE_ROOT,
      ]) {
        const relative = path.relative(fs.realpathSync(denied), real);
        if (
          relative === '' ||
          (!relative.startsWith('..' + path.sep) &&
            relative !== '..' &&
            !path.isAbsolute(relative))
        )
          return;
      }
      encoder = (options.createEncoder ?? createLocalSemanticEncoder)({
        pythonPath: path.join(real, 'venv/bin/python'),
        modelDir: path.join(real, 'model'),
        workerPath: path.join(
          options.codeRoot ?? CODE_ROOT,
          'scripts/memory-embedding-worker.py',
        ),
      });
      return encoder;
    } catch {
      return;
    }
  };
}
const configuredEncoder = createConfiguredMemoryEncoderProvider();
export function configuredMemoryRecallEncoder(
  input: MemoryPromptIdentityInput,
): SemanticEncoder | undefined {
  // Forwarded/ambiguous inputs do not even initialize a personal recall worker.
  return trustedScope(input) ? configuredEncoder() : undefined;
}
