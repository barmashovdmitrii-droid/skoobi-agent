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
import { getTelegramMessageEditBindingHashFrom, getTelegramMessageEditRevisionFrom } from './telegram-message-edit-store.js';
import { memoryDecisionEvidence, messageContentDigest } from './memory-decision-evidence.js';
import { memoryReadProjectRequest } from './memory-project-match.js';
import { directSource, directTurnsAfter } from './memory-source-message.js';
import { buildStructuredMemoryContext, isMemoryContinuation, selectMemoryReadRoute } from './memory-state-context.js';
import {
  appendPromptProjectFacts,
  listPromptMemoryState,
  focusSourceCitation,
  type MemoryStateRecord,
  type MemoryStateScope,
} from './memory-state-store.js';
import {
  recallStructuredMemory,
  warmStructuredMemoryVectors,
  type MemoryRecallResult,
} from './memory-semantic-store.js';

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
  currentMessageId?: string;
}
export interface RecalledStructuredMemoryContext {
  context: string;
  recallQuery?: string;
  excludeLegacyMemory: boolean;
  mode?: 'lexical' | 'hybrid' | 'hybrid_partial';
  /** Content-free counters for the memory_recall event (no text, no keys). */
  stats?: {
    reason?: MemoryRecallResult['reason'];
    scanned: number;
    cached: number;
    embedded: number;
    projectSelected: boolean;
    selectedBy: 'explicit' | 'continuation' | null;
    injectedFacts: number;
    injectedGlobalFacts: number;
  };
}
export function trustedMemoryPromptScope(
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
    safeTelegramBotId(identity.bot_id) !== safeTelegramBotId(jid.botId)
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
  readProjects: readonly string[],
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
    if (ref.projectKey !== null && !readProjects.includes(ref.projectKey)) return [];
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

// Only a positive, named work instruction can anchor an implicit follow-up.
// Unknown phrasing abstains. This predicate grants no action authority.
function directProjectAssignment(db: Database.Database, scope: MemoryStateScope, content: string, projectKey: string, now: string) {
  const text = content.trim().replace(/^\[(?:Voice|Audio):\s*([\s\S]*?)\]$/iu, '$1').trim();
  const directive = /^(?:(?:пожалуйста|давай|сначала|теперь)[,\s]+)*(?:подготовь|проверь|выполни|сделай|доработай|собери|исследуй|протестируй|начни|продолжай|продолжи|возьми|рассчитай|разработай|исправь|build|check|test|start|continue|prepare|finish)(?=\s|[:,])/iu.exec(text);
  if (!directive) return false;
  if (/[?\n]/u.test(text) || /(?:^|\s)(?:не|без|если|отложи|отмени|останови|переименуй|опечатк[\p{L}]*|названи[\p{L}]*|карточк[\p{L}]*|псевдоним[\p{L}]*|alias|rename|typo|unless|don't|not)(?=$|[^\p{L}\p{N}])/iu.test(text)) return false;
  const query = text.slice(directive[0].length);
  const named = listPromptMemoryState(db, scope, query, now);
  if (named.projectsTruncated) return false;
  const request = memoryReadProjectRequest(named.projects, query);
  return !request.restricted && request.projects.length === 1 && request.projects[0].projectKey === projectKey;
}

function neutralAcknowledgement(text: string): boolean {
  const words = text.toLowerCase().replace(/ё/g, 'е').replace(/[,.!]+/gu, ' ').trim().replace(/\s+/gu, ' ');
  return /^(?:(?:большое спасибо|спасибо большое|спасибо|мне все понятно|все понятно|понятно|принято|thank you|thanks|understood)(?: |$)){1,3}$/iu.test(words);
}

/** Focus timestamps alone cannot detect an intervening assignment that never
 * wrote a card. Production supplies the exact same-batch message ID. */
function checkedPromptMemoryListing(db: Database.Database, scope: MemoryStateScope, input: MemoryPromptIdentityInput, now: string) {
  const continuation = isMemoryContinuation(input.currentText!);
  const listing = listPromptMemoryState(db, scope, continuation ? '' : input.currentText!, now);
  if (!listing.focusedProjectKey || !continuation) return listing;
  const clearFocus = () => ({ ...listing, focusedProjectKey: null });
  // Without the original turn and the intervening inputs we cannot tell a
  // real assignment from a card edit or a task that has since been cancelled.
  const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('messages','message_metadata','message_ingestion')").get() as { n: number };
  if (tables.n < 3) return clearFocus();
  const provenance = { chatJid: scope.chatJid, senderIdentity: input.senderIdentity! };
  if (!listing.focusedSourceId) return clearFocus();
  const source = directSource(db, provenance, listing.focusedSourceId);
  if (!source) return clearFocus();
  const citation = focusSourceCitation(db, scope, listing);
  if (source.timestamp !== listing.focusedSourceAt || !citation ||
    (getTelegramMessageEditRevisionFrom(db, scope.chatJid, source.id) ?? 0) !== (citation.editRevision ?? 0) ||
    (getTelegramMessageEditBindingHashFrom(db, scope.chatJid, source.id) ?? null) !== citation.bindingHash ||
    (citation.digest ? messageContentDigest(source.content) !== citation.digest : source.content.trim() !== citation.quote.trim()) ||
    !directProjectAssignment(db, scope, source.content, listing.focusedProjectKey, now)) return clearFocus();
  const direct = directTurnsAfter(db, provenance, source.sequence);
  if (!direct?.length || direct.some(m => !isMemoryContinuation(m.content) && !neutralAcknowledgement(m.content))) return clearFocus();
  const current = input.currentMessageId ? direct.find(m => m.id === input.currentMessageId) : direct.at(-1);
  if (!current || current.content.trim() !== input.currentText!.trim()) return clearFocus();
  return listing;
}

/** Synchronous and post-search prompt reads share the same verified route. */
export function promptMemoryListing(db: Database.Database, scope: MemoryStateScope, input: MemoryPromptIdentityInput, now: string) {
  const listing = checkedPromptMemoryListing(db, scope, input, now);
  if (listing.facts.length >= 200) {
    const { readProjectKeys } = selectMemoryReadRoute(listing, input.currentText!, now);
    appendPromptProjectFacts(db, scope, listing, readProjectKeys, now);
  }
  return listing;
}

export async function buildRecalledStructuredMemoryContext(
  db: Database.Database,
  input: MemoryPromptIdentityInput,
  options: { encoder?: SemanticEncoder; now?: () => string } = {},
): Promise<RecalledStructuredMemoryContext> {
  const scope = trustedMemoryPromptScope(input);
  if (!scope)
    return {
      context: '',
      excludeLegacyMemory:
        input.currentText !== undefined && input.chatJid.startsWith('tg:'),
    };
  const now = options.now ?? (() => new Date().toISOString());
  try {
    const before = checkedPromptMemoryListing(db, scope, input, now());
    const selected = buildStructuredMemoryContext(before, input.currentText!, {
      now: now(),
    });
    // The identity fixes the outer namespace. Any linked read remains within
    // that scope, on the exact one-hop cards selected by the host.
    const beforeProjects = new Map(before.projects.map(p => [p.projectKey, p.revision]));
    const recalled = await recallStructuredMemory(db, scope, {
      query: selected.recallQuery,
      projectKey: selected.selectedProjectKey,
      relatedProjectKeys: selected.readProjectKeys.filter(key => key !== selected.selectedProjectKey),
      encoder: options.encoder,
      now: options.now?.(),
      limit: 10,
    });
    return db.transaction(() => {
      const after = promptMemoryListing(db, scope, input, now());
      const current = buildStructuredMemoryContext(after, input.currentText!, {
        now: now(),
      });
      const afterProjects = new Map(after.projects.map(p => [p.projectKey, p.revision]));
      const sameRoute = current.selectedProjectKey === selected.selectedProjectKey &&
        current.readProjectKeys.length === selected.readProjectKeys.length &&
        current.readProjectKeys.every(key =>
          selected.readProjectKeys.includes(key) && beforeProjects.get(key) === afterProjects.get(key));
      const refs = sameRoute ? recalled.facts : [];
      const facts = currentReturnedFacts(
        db,
        scope,
        current.readProjectKeys,
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
        ...memoryDecisionEvidence(db, scope, input.senderId!, now()),
        now: now(),
      });
      return {
        context: state.context,
        // Consumed only by automatic recall from memory files.
        recallQuery: state.fileRecallQuery,
        excludeLegacyMemory:
          state.restricted || state.sourceReviewRequired || after.hasTombstones || recalled.reason === 'storage_unavailable',
        mode: recalled.mode,
        stats: {
          ...(recalled.reason ? { reason: recalled.reason } : {}),
          scanned: recalled.scanned,
          cached: recalled.cached,
          embedded: recalled.embedded,
          projectSelected: state.selectedProjectKey !== null,
          selectedBy: state.selectedBy,
          injectedFacts: state.injectedFacts,
          injectedGlobalFacts: state.injectedGlobalFacts,
        },
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
  return trustedMemoryPromptScope(input) ? configuredEncoder() : undefined;
}

const WARM_KEY = 'SKOOBI_MEMORY_SEMANTIC_WARM';
/** On unless SKOOBI_MEMORY_SEMANTIC_WARM is 0/off/false/no. */
export function memoryWarmEnabled(
  config: Record<string, string | undefined>,
): boolean {
  return !/^(?:0|off|false|no)$/i.test((config[WARM_KEY] ?? '').trim());
}

/** Week review (W07): background vector warm after a memory write.
 * One job at a time, a repeat of the same scope+project is merged, never on
 * the caller's tick and never throws. The encoder serves one request at a
 * time: a recall that lands mid-warm falls back to words for that turn, as
 * it did before. */
export function createStructuredMemoryWarmer(options: {
  encoder: () => SemanticEncoder | undefined;
  enabled: () => boolean;
  warm?: typeof warmStructuredMemoryVectors;
}): {
  schedule(
    db: Database.Database,
    scope: MemoryStateScope,
    projectKey: string | null,
  ): void;
  idle(): Promise<void>;
} {
  const queue = new Map<
    string,
    { db: Database.Database; scope: MemoryStateScope; projectKey: string | null }
  >();
  let running: Promise<void> | undefined;
  const drain = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
    while (queue.size) {
      const [key, job] = queue.entries().next().value!;
      queue.delete(key);
      try {
        const encoder = options.encoder();
        if (!encoder) {
          queue.clear();
          return;
        }
        await (options.warm ?? warmStructuredMemoryVectors)(job.db, job.scope, {
          projectKey: job.projectKey,
          encoder,
        });
      } catch {
        // Optional derived data: recall still embeds on demand.
      }
    }
  };
  const start = (): void => {
    running = drain().finally(() => {
      running = undefined;
      if (queue.size) start();
    });
  };
  return {
    schedule(db, scope, projectKey) {
      try {
        if (!options.enabled()) return;
        queue.delete(
          JSON.stringify([scope.chatJid, scope.identityId, scope.tenantId, projectKey]),
        );
        queue.set(
          JSON.stringify([scope.chatJid, scope.identityId, scope.tenantId, projectKey]),
          { db, scope, projectKey },
        );
        while (queue.size > 32) queue.delete(queue.keys().next().value!);
        if (!running) start();
      } catch {
        // A warm is never worth failing a memory write.
      }
    },
    async idle() {
      while (running) await running;
    },
  };
}
const configuredWarmer = createStructuredMemoryWarmer({
  encoder: configuredEncoder,
  enabled: () =>
    memoryWarmEnabled({
      [WARM_KEY]: process.env[WARM_KEY] ?? readEnvFile([WARM_KEY])[WARM_KEY],
    }),
});
/** Called by the memory_state service after a successful write. */
export function scheduleStructuredMemoryWarm(
  db: Database.Database,
  scope: MemoryStateScope,
  projectKey: string | null,
): void {
  configuredWarmer.schedule(db, scope, projectKey);
}
