import type Database from 'better-sqlite3';
import { z } from 'zod';

import { getDb } from './db.js';
import {
  compareProjectInsights,
  projectValueDetailSchema,
} from './project-insights.js';
import {
  editorialFeedbackDetailSchema,
  verifyEditorialMessageArtifact,
} from './editorial-feedback.js';
import {
  authenticateMemoryStateRequest,
  signMemoryStateResponse,
  openMemoryStateWireRequest,
  sealMemoryStateWireResponse,
  type AuthenticatedMemoryStateContext,
} from './memory-provenance.js';
import {
  ensureMemoryStateSchema,
  getMemoryProject,
  listMemoryState,
  readMemoryStatePage,
  getMemoryProjectPage,
  mutateMemoryState,
  MemoryStateError,
  type MemoryStateOperation,
  type MemoryStateSource,
} from './memory-state-store.js';

const key = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u);
const operationBase = {
  operationId: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
};
const card = z
  .object({
    title: z.string().min(1).max(200),
    goal: z.string().min(1).max(4000),
    status: z.enum(['active', 'waiting', 'completed', 'cancelled']),
    pending: z.array(z.string().min(1).max(1000)).max(30),
    completed: z.array(z.string().min(1).max(1000)).max(30),
    waiting: z.string().max(2000).nullable(),
    artifacts: z
      .array(
        z
          .object({
            path: z.string().min(1).max(2048),
            state: z.enum(['created', 'verified', 'delivered']),
            note: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
const operationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...operationBase,
      kind: z.literal('project_upsert'),
      projectKey: key,
      card,
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('project_activate'),
      projectKey: key,
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('fact_upsert'),
      projectKey: key.nullable(),
      key,
      value: z.string().min(1).max(4000),
      factType: z
        .enum(['fact', 'decision', 'preference', 'permission_note'])
        .optional(),
      validUntil: z.string().datetime().nullable().optional(),
      detail: z
        .discriminatedUnion('kind', [
          projectValueDetailSchema,
          editorialFeedbackDetailSchema,
        ])
        .optional(),
    })
    .strict(),
  z
    .object({
      ...operationBase,
      kind: z.literal('forget'),
      target: z.enum(['fact', 'project']),
      projectKey: key.nullable(),
      key: key.optional(),
    })
    .strict(),
]);

const sourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('direct_user'),
      messageId: z.string().min(1).max(256),
      quote: z.string().min(1).max(2000),
    })
    .strict(),
  z.object({ kind: z.literal('assistant_report') }).strict(),
]);
const requestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('compare_projects'),
      projectKeys: z
        .array(key.transform((value) => value.normalize('NFKC').toLowerCase()))
        .min(2)
        .max(3)
        .refine((keys) => new Set(keys).size === keys.length),
    })
    .strict(),
  z
    .object({
      action: z.literal('mutate'),
      operation: operationSchema,
      source: sourceSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('list'),
      projectKey: key.nullable().optional(),
      cursor: z.string().min(1).max(2048).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('get_project'),
      projectKey: key,
      cursor: z.string().min(1).max(2048).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
]);

interface SourceMessage {
  id: string;
  sender: string;
  content: string;
  timestamp: string;
  is_bot_message: number;
  sender_identity_json: string | null;
  sequence: number;
}
function directSource(
  db: Database.Database,
  context: AuthenticatedMemoryStateContext,
  messageId: string,
): SourceMessage | null {
  const row = db
    .prepare(
      `SELECT m.id,m.sender,m.content,m.timestamp,m.is_bot_message,mm.sender_identity_json,mi.sequence
    FROM messages m JOIN message_ingestion mi ON mi.id=m.id AND mi.chat_jid=m.chat_jid
    LEFT JOIN message_metadata mm ON mm.id=m.id AND mm.chat_jid=m.chat_jid WHERE m.chat_jid=? AND m.id=?`,
    )
    .get(context.chatJid, messageId) as SourceMessage | undefined;
  if (
    !row ||
    row.is_bot_message ||
    row.sender !== context.senderIdentity.telegram_user_id
  )
    return null;
  try {
    const identity = JSON.parse(row.sender_identity_json || 'null');
    if (
      identity?.telegram_message_origin !== 'direct' ||
      identity.identity_id !== context.senderIdentity.identity_id ||
      identity.telegram_user_id !== context.senderIdentity.telegram_user_id ||
      identity.chat_id !== context.senderIdentity.chat_id ||
      identity.channel !== 'telegram'
    )
      return null;
  } catch {
    return null;
  }
  // Telegram's durable cursor embeds message_id below millisecond precision.
  // Memory stores canonical wall time; messageId remains the tie-breaker for
  // sources in the same millisecond. Do not alter the original message cursor.
  const timestamp = Date.parse(row.timestamp);
  if (!Number.isFinite(timestamp)) return null;
  return { ...row, timestamp: new Date(timestamp).toISOString() };
}

// Authorization binds the initial imperative to its first named target. Mere
// occurrence elsewhere in a sentence is not a grant ("delete beta, not alpha").
function normalizedTarget(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function authorizedTarget(
  text: string,
  kind: 'forget' | 'remember' | 'activate',
  aliases: string[],
  targetKind: 'fact' | 'project',
  projectAliases?: string[],
): boolean {
  const prefix = '^(?:\\s*(?:пожалуйста|please|да)[,!:]?\\s+)?';
  const verbs = {
    forget: 'забудь(?:те)?|удали(?:те)?|сотри(?:те)?|forget|delete|remove',
    remember:
      'запомни(?:те)?|сохрани(?:те)?|восстанови(?:те)?|верни(?:те)?|remember|restore|reinstate|save',
    activate:
      'продолжай(?:те)?|продолжи(?:те)?|возобнови(?:те)?|активируй(?:те)?|доделай(?:те)?|вернись|resume|activate|continue',
  }[kind];
  const directText = text
    .trim()
    .replace(/^\[(?:Voice|Audio):\s*([\s\S]*?)\]$/, '$1');
  const match = new RegExp(
    prefix + '(?:' + verbs + ')(?=$|[^\\p{L}\\p{N}_])\\s*(.*)$',
    'isu',
  ).exec(directText.trim());
  if (!match) return false;
  const sentences = match[1]
    .split(/[.!?\n]+/)
    .map(normalizedTarget)
    .filter(Boolean);
  const body = sentences[0] ?? '';
  const negative =
    /(?:^|[^\p{L}\p{N}_])(?:не|нет|но|кроме|если|not|don't|but|except|unless|if)(?=$|[^\p{L}\p{N}_])/iu;
  if (negative.test(body)) return false;
  // A global fact must not consume a command explicitly scoped to a project;
  // likewise a project command cannot authorize deletion of a same-key fact.
  if (targetKind === 'fact') {
    if (/^(?:проект|проекта|проектом|проекту|project)\s/u.test(body))
      return false;
    if (
      !projectAliases &&
      /(?:в проекте|из проекта|для проекта|in project|from project)\s/u.test(
        body,
      )
    )
      return false;
  } else if (
    /^(?:факт|запись|настройку|предпочтение|решение|fact|entry|preference|decision)\s/u.test(
      body,
    )
  )
    return false;
  // A separate delivery constraint is not a cancellation of the memory command.
  // An explicit retraction, or a later opposing clause naming this target, is.
  if (
    sentences.slice(1).some((sentence) => {
      if (
        /^(?:нет|стоп|отмена|cancel|stop)(?=$|[^\p{L}\p{N}_])/iu.test(sentence)
      )
        return true;
      const opposing =
        negative.test(sentence) ||
        /^(?:оставь|сохрани|keep|preserve|leave)(?=$|[^\p{L}\p{N}_])/iu.test(
          sentence,
        );
      return (
        opposing &&
        aliases.some((alias) => {
          const target = normalizedTarget(alias);
          return target.length > 0 && sentence.includes(target);
        })
      );
    })
  )
    return false;
  const targetClause = body
    .split(/[:,;\n]/, 1)[0]
    .replace(
      /^(?:работу над |work on )?(?:(?:проект|проектом|проекту|проекта|факт|запись|настройку|предпочтение|решение|project|fact|preference|decision|entry)\s+)?/u,
      '',
    );
  const bound = aliases.some((alias) => {
    const target = normalizedTarget(alias);
    if (!target || !targetClause.startsWith(target)) return false;
    const rest = targetClause.slice(target.length);
    if (/^[\p{L}\p{N}_]/u.test(rest)) return false;
    return !/(?:^|[^\p{L}\p{N}_])(?:и|and|or|или)(?=$|[^\p{L}\p{N}_])/iu.test(
      rest,
    );
  });
  if (!bound) return false;
  if (!projectAliases) return true;
  return projectAliases.some((alias) => {
    const target = normalizedTarget(alias);
    return [
      'в проекте ',
      'из проекта ',
      'для проекта ',
      'in project ',
      'from project ',
    ].some((prefix) => {
      const at = body.indexOf(prefix + target);
      return (
        at >= 0 &&
        !/^[\p{L}\p{N}_]/u.test(body.slice(at + prefix.length + target.length))
      );
    });
  });
}
const SECRET_CONTENT_RE =
  /(api[_-]?key|token|password|secret|authorization|cookie|\.env|private key|ssh key|парол|токен|секретн|ключ\s+(?:api|доступа|авторизац))/i;
function containsSecretText(value: unknown): boolean {
  if (typeof value === 'string') return SECRET_CONTENT_RE.test(value);
  if (Array.isArray(value)) return value.some(containsSecretText);
  return Boolean(
    value &&
    typeof value === 'object' &&
    Object.values(value).some(containsSecretText),
  );
}

export interface MemoryStateResponse {
  type: 'memory_state_result';
  request_id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  currentRevision?: number;
  response_proof?: string;
}

/** Authenticated IPC boundary: model input never chooses tenant, identity or chat. */
function processMemoryStateRequest(
  raw: unknown,
  sourceGroup: string,
  db: Database.Database,
): MemoryStateResponse {
  const auth = authenticateMemoryStateRequest(raw, sourceGroup);
  const deny = (error: string): MemoryStateResponse => ({
    type: 'memory_state_result',
    request_id: auth.requestId,
    ok: false,
    error,
  });
  if (!auth.ok) return deny(auth.error);
  const parsed = requestSchema.safeParse(auth.payload);
  if (!parsed.success) return deny('invalid_memory_state_payload');
  const payload = parsed.data;
  const context = auth.context;
  // The capability names a live run, and each authorization message must
  // independently retain its direct sender provenance in the authoritative DB.
  const current = context.currentMessageIds.map((id) =>
    directSource(db, context, id),
  );
  if (current.some((row) => !row) || !current.length)
    return deny('current_direct_source_required');
  const latest = current
    .filter((row): row is SourceMessage => row !== null)
    .sort((a, b) => a.sequence - b.sequence)
    .at(-1)!;
  // A cancellation may already be ingested before the polling loop has piped
  // it into this runner. Such a newer direct message revokes old mutation grants.
  const recentIds = db
    .prepare(
      `SELECT m.id FROM messages m
    JOIN message_ingestion mi ON mi.id=m.id AND mi.chat_jid=m.chat_jid
    WHERE m.chat_jid=? AND m.sender=? AND m.is_bot_message=0
    ORDER BY mi.sequence DESC LIMIT 200`,
    )
    .all(context.chatJid, context.senderIdentity.telegram_user_id) as Array<{
    id: string;
  }>;
  const latestDatabaseDirect = recentIds
    .map((row) => directSource(db, context, row.id))
    .find((row) => row !== null);
  const scope = {
    chatJid: context.chatJid,
    tenantId: context.tenantId,
    identityId: context.senderIdentity.identity_id,
  };
  try {
    ensureMemoryStateSchema(db);
    if (payload.action === 'compare_projects') {
      const projects = payload.projectKeys.map((projectKey) => {
        let page = getMemoryProjectPage(db, scope, projectKey, {
          pageSize: 100,
        });
        const project = page?.project ?? null;
        const facts = page?.facts.slice() ?? [];
        let pages = 1;
        while (page?.nextCursor && pages < 20) {
          page = getMemoryProjectPage(db, scope, projectKey, {
            pageSize: 100,
            cursor: page.nextCursor,
          });
          if (page) facts.push(...page.facts);
          pages++;
        }
        return { projectKey, project, facts, complete: !page?.nextCursor };
      });
      const data = compareProjectInsights(projects);
      if (Buffer.byteLength(JSON.stringify(data)) > 128 * 1024)
        return deny('memory_result_too_large_select_project');
      return {
        type: 'memory_state_result',
        request_id: auth.requestId,
        ok: true,
        data,
      };
    }
    if (payload.action === 'list' || payload.action === 'get_project') {
      const data =
        payload.action === 'list'
          ? readMemoryStatePage(db, scope, {
              projectKey: payload.projectKey,
              cursor: payload.cursor,
              pageSize: payload.pageSize,
            })
          : getMemoryProjectPage(db, scope, payload.projectKey, {
              cursor: payload.cursor,
              pageSize: payload.pageSize,
            });
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 128 * 1024)
        return deny('memory_result_too_large_select_project');
      return {
        type: 'memory_state_result',
        request_id: auth.requestId,
        ok: true,
        data,
      };
    }
    const operation = payload.operation as MemoryStateOperation;
    if (containsSecretText(operation) || containsSecretText(payload.source))
      return deny('memory_content_looks_secret');
    let source: MemoryStateSource;
    if (payload.source.kind === 'assistant_report') {
      // This is a claim by the agent, not a verified action or user permission.
      source = {
        kind: 'assistant_report',
        messageId: latest.id,
        at: latest.timestamp,
      };
    } else {
      const cited = directSource(db, context, payload.source.messageId);
      if (!cited || !cited.content.includes(payload.source.quote))
        return deny('source_quote_mismatch');
      const isLatest =
        cited.id === latest.id && cited.id === latestDatabaseDirect?.id;
      const target =
        operation.kind === 'forget' && operation.target === 'fact'
          ? operation.key || ''
          : operation.kind === 'fact_upsert'
            ? operation.key
            : operation.projectKey || '';
      const aliases = [target];
      let projectAliases: string[] | undefined;
      if (operation.projectKey) {
        const project = getMemoryProject(db, scope, operation.projectKey);
        const title =
          operation.kind === 'project_upsert'
            ? operation.card.title
            : project?.project?.card?.title;
        const peers = listMemoryState(db, scope, { limit: 200 }).projects;
        const titleIsUnique =
          typeof title === 'string' &&
          peers.length < 200 &&
          !peers.some(
            (peer) =>
              peer.projectKey !== operation.projectKey &&
              (normalizedTarget(peer.card.title) === normalizedTarget(title) ||
                normalizedTarget(peer.projectKey) === normalizedTarget(title)),
          );
        const names = [
          operation.projectKey,
          ...(titleIsUnique ? [title as string] : []),
        ];
        if (
          operation.kind === 'fact_upsert' ||
          (operation.kind === 'forget' && operation.target === 'fact')
        )
          projectAliases = names;
        else aliases.push(...names);
      }
      const targetKind =
        operation.kind === 'fact_upsert' ||
        (operation.kind === 'forget' && operation.target === 'fact')
          ? 'fact'
          : 'project';
      source = {
        kind: 'direct_user',
        messageId: cited.id,
        quote: payload.source.quote,
        at: cited.timestamp,
        ...(isLatest ? { currentDirectInput: true } : {}),
        ...(isLatest &&
        authorizedTarget(
          cited.content,
          'forget',
          aliases,
          targetKind,
          projectAliases,
        )
          ? { explicitForget: true }
          : {}),
        ...(isLatest &&
        authorizedTarget(
          cited.content,
          'remember',
          aliases,
          targetKind,
          projectAliases,
        )
          ? { explicitRemember: true }
          : {}),
        ...(isLatest &&
        authorizedTarget(
          cited.content,
          'activate',
          aliases,
          targetKind,
          projectAliases,
        )
          ? { explicitActivate: true }
          : {}),
      };
    }
    if (
      operation.kind === 'fact_upsert' &&
      operation.detail?.kind === 'editorial_feedback' &&
      operation.detail.artifact.kind === 'assistant_message'
    ) {
      const evidence = verifyEditorialMessageArtifact(
        db,
        context.chatJid,
        operation.detail.artifact,
      );
      if (!evidence) return deny('editorial_artifact_version_mismatch');
      source.editorialArtifactEvidence = evidence;
    }
    const result = mutateMemoryState(db, scope, operation, source);
    return {
      type: 'memory_state_result',
      request_id: auth.requestId,
      ok: true,
      data: result,
    };
  } catch (error) {
    if (error instanceof MemoryStateError)
      return {
        ...deny(error.code),
        ...(error.currentRevision === undefined
          ? {}
          : { currentRevision: error.currentRevision }),
      };
    return deny('memory_state_operation_failed');
  }
}

export function handleMemoryStateRequest(
  raw: unknown,
  sourceGroup: string,
  db: Database.Database = getDb(),
): MemoryStateResponse {
  const response = processMemoryStateRequest(raw, sourceGroup, db);
  const proof = signMemoryStateResponse(raw, response);
  return { ...response, ...(proof ? { response_proof: proof } : {}) };
}

/** Shared IPC transport wrapper. Plaintext requests are internal test/API only. */
export function handleMemoryStateWireRequest(
  raw: unknown,
  sourceGroup: string,
  db: Database.Database = getDb(),
): Record<string, unknown> {
  let response: MemoryStateResponse;
  try {
    response = handleMemoryStateRequest(
      openMemoryStateWireRequest(raw, sourceGroup),
      sourceGroup,
      db,
    );
  } catch {
    response = {
      type: 'memory_state_result',
      request_id:
        raw &&
        typeof raw === 'object' &&
        typeof (raw as Record<string, unknown>).request_id === 'string'
          ? (raw as Record<string, string>).request_id
          : 'invalid',
      ok: false,
      error: 'invalid_memory_state_transport',
    };
  }
  return sealMemoryStateWireResponse(raw, sourceGroup, response);
}
