import { containsMemoryCredentials } from './memory-credential-content.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';

import { getTelegramMessageEditBindingHashFrom, getTelegramMessageEditRevisionFrom, isTelegramMessageAdmissionCurrentFrom } from './telegram-message-edit-store.js';
import { getDb } from './db.js';
import { instanceProfile } from './instance-profile.js';
import { directSource, type SourceMessage } from './memory-source-message.js';
import { messageContentDigest, memoryReadEvidence } from './memory-decision-evidence.js';
import { isoDateTime } from './iso-date-time.js';
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
} from './memory-provenance.js';
import { scheduleStructuredMemoryWarm } from './memory-prompt-recall.js';
import {
  ensureMemoryStateSchema,
  getMemoryProject,
  listMemoryState,
  readMemoryStatePage,
  getMemoryProjectPage,
  mutateMemoryState,
  readMemoryOperationStatus,
  searchMemoryState,
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
    work: z.unknown().optional(), // Bounded and normalized by the durable store.
    aliases: z.array(z.string().trim().min(3).max(80)).max(8).optional(),
    relatedProjectKeys: z.array(key).max(3).optional(),
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
      .max(20, { error: issue => `operation.card.artifacts contains ${Array.isArray(issue.input) ? issue.input.length : 'too many'} entries (limit 20). Keep every reference in an index and attach the index once.` }),
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
      validUntil: isoDateTime().nullable().optional(),
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
  z.object({ action: z.literal('operation_status'), operationId: operationBase.operationId }).strict(),
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
  z
    .object({
      action: z.literal('search'),
      // Spaces only are no query (searchMemoryState would throw invalid_input).
      query: z.string().trim().min(1).max(500),
      projectKey: key.nullable().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    })
    .strict(),
]);

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


export interface MemoryStateResponse {
  type: 'memory_state_result';
  request_id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  currentRevision?: number;
  /** Plain advice for the agent on a refusal: what would unlock it. Not part
   * of the response proof; the sealed transport still authenticates it. */
  hint?: string;
  response_proof?: string;
}

// Only words that authorizedTarget accepts as «<word> <project>»: «вернись»
// needs «к …», which does not bind to the target, so it is not advertised.
const ACTIVATION_WORDS =
  'продолжи, возобнови, активируй, доделай, resume, activate, continue';
/** Week review (W12): bare refusal codes made the agent retry the same
 * source 13+5 times a week. Advice only — it never relaxes the check. */
export function memoryStateRefusalHint(
  error: string,
  target?: string,
  /** Project of a project-scoped fact: its forget must also say «в проекте <key>». */
  factProject?: string,
): string | undefined {
  const name = target || '<project>';
  if (error === 'explicit_activation_required')
    return `Resuming a project needs the person's own latest message to start with an activation word and name this project, e.g. «Продолжай ${name}» (also: ${ACTIVATION_WORDS}); the project key always works, the exact title only when no other card has that title. Cite that message as source kind direct_user with its exact quote. Do not retry with another source; if the person did not ask to resume this project, leave the card as it is and carry on.`;
  if (error === 'project_names_require_direct_source')
    return `Update only the names/links of an existing exact-key card using the owner's complete latest message. Each changed value needs its own line: «Добавь имя «имя» проекту ${target || '<key>'}», «Удали имя «имя» у проекта ${target || '<key>'}», «Свяжи проект ${target || '<key>'} с проектом <key>», or «Убери связь проекта ${target || '<key>'} с проектом <key>». Omit metadata to preserve it. Do not use a quotation inside another message as authorization.`;
  if (error === 'explicit_forget_required')
    return `Deleting needs the person's own latest message to start with «Забудь ${target || '<record>'}${factProject ? ` в проекте ${factProject}` : ''}» (also: удали, сотри, forget, delete, remove) and name this exact record${factProject ? ' and its project' : ''}. Cite that message as source kind direct_user with its exact quote. Do not retry otherwise.`;
  if (error === 'memory_content_looks_secret' || error === 'credential_content')
    // The holder named in the last example is the installation's own
    // (instance profile, prompts.secretHolderExample).
    return `The text has what looks like a secret value: a password, token, key or cookie value near its label (also in a field named like kaspi_password), or a key format (sk-…, ghp_…, Bearer …, eyJ… JWT, -----BEGIN … PRIVATE KEY-----, user:password@ in a link). Moving the value to another line, into brackets, a table, a list or another field, or splitting it, does not help. Rewrite the text without the value itself and keep the fact («пароль от почты: <value>» → «пароль от почты у владельца»); a single word after «Пароль:» or «password is» is read as the value, so name who has it or where it is with a preposition («пароль у Гульнары», «password is in Bitwarden»). Then send again; sending the same text again gets the same refusal. A note about a password or key without its value is fine («токен истёк», «пароль хранится у ${instanceProfile().prompts.secretHolderExample}», «ключ API в .env»).`;
  return undefined;
}

/** Authenticated IPC boundary: model input never chooses tenant, identity or chat. */
function processMemoryStateRequest(
  raw: unknown,
  sourceGroup: string,
  db: Database.Database,
): MemoryStateResponse {
  const auth = authenticateMemoryStateRequest(raw, sourceGroup);
  let hintTarget: string | undefined;
  let hintFactProject: string | undefined;
  const deny = (error: string): MemoryStateResponse => {
    const hint = memoryStateRefusalHint(error, hintTarget, hintFactProject);
    return {
      type: 'memory_state_result',
      request_id: auth.requestId,
      ok: false,
      error,
      ...(hint ? { hint } : {}),
    };
  };
  if (!auth.ok) return deny(auth.error);
  const parsed = requestSchema.safeParse(auth.payload);
  if (!parsed.success) {
    const artifactLimit = parsed.error.issues.find(issue =>
      issue.code === 'too_big' && issue.path.join('.') === 'operation.card.artifacts');
    return {
      ...deny('invalid_memory_state_payload'),
      hint: artifactLimit?.message ?? 'Check the required fields and types before submitting the corrected request.',
    };
  }
  const payload = parsed.data;
  const context = auth.context;
  const scope = { chatJid: context.chatJid, tenantId: context.tenantId,
    identityId: context.senderIdentity.identity_id };
  const readEvidence = memoryReadEvidence(db, scope, context.senderIdentity.telegram_user_id ?? '');
  if (context.projectReadScope) {
    if ((payload.action !== 'list' && payload.action !== 'get_project' &&
         payload.action !== 'search') ||
        payload.projectKey !== context.projectReadScope.projectKey)
      return deny('scheduled_memory_read_only');
    try {
      if (payload.action === 'search') {
        // A scheduled run searches only the project its task is bound to.
        const found = searchMemoryState(db, scope, {
          reviewSearchHit: readEvidence.reviewSearchHit,
          query: payload.query,
          projectKey: context.projectReadScope.projectKey,
          limit: payload.limit,
        });
        return { type: 'memory_state_result', request_id: auth.requestId, ok: true, data: found };
      }
      const data = payload.action === 'list'
        ? readMemoryStatePage(db, scope, payload)
        : getMemoryProjectPage(db, scope, payload.projectKey, payload);
      if (data) {
        data.facts.forEach(readEvidence.reviewFact);
        // The task can read this card but has no grant for its linked projects.
        const projects = 'projects' in data ? data.projects : [data.project];
        for (const project of projects) {
          readEvidence.reviewProject(project);
          delete project.card.relatedProjectKeys;
          // A metadata command may itself name a linked project outside the grant.
          delete project.source.quote;
        }
        // Global focus/tombstone metadata must not leak another project's key.
        data.focusedProjectKey = data.focusedProjectKey === context.projectReadScope.projectKey
          ? context.projectReadScope.projectKey : null;
        data.hasTombstones = data.tombstones.length > 0;
      }
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 128 * 1024)
        return deny('memory_result_too_large_select_project');
      return { type: 'memory_state_result', request_id: auth.requestId, ok: true, data };
    } catch (error) {
      // A bad cursor or query is the caller's mistake, not a revoked scope:
      // the runner quarantines every read of the run on scheduled_memory_*.
      if (error instanceof MemoryStateError) return deny(error.code);
      return deny('scheduled_memory_scope_unavailable');
    }
  }
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
  try {
    if (payload.action === 'operation_status') {
      return { type: 'memory_state_result', request_id: auth.requestId, ok: true,
        data: readMemoryOperationStatus(db, scope, payload.operationId) };
    }
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
        facts.forEach(readEvidence.reviewFact);
        if (project) readEvidence.reviewProject(project);
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
    if (payload.action === 'search') {
      const data = searchMemoryState(db, scope, {
        reviewSearchHit: readEvidence.reviewSearchHit,
        query: payload.query,
        projectKey: payload.projectKey,
        limit: payload.limit,
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
      if (data) {
        data.facts.forEach(readEvidence.reviewFact);
        const projects = 'projects' in data ? data.projects : [data.project];
        projects.forEach(readEvidence.reviewProject);
      }
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 128 * 1024)
        return deny('memory_result_too_large_select_project');
      return {
        type: 'memory_state_result',
        request_id: auth.requestId,
        ok: true,
        data,
      };
    }
    if (!context.currentMessageIds.every(id => isTelegramMessageAdmissionCurrentFrom(db, context.chatJid, id)))
      return deny('current_direct_source_required');
    const operation = payload.operation as MemoryStateOperation;
    hintTarget =
      operation.kind === 'fact_upsert' ||
      (operation.kind === 'forget' && operation.target === 'fact')
        ? operation.key
        : (operation.projectKey ?? undefined);
    // A project fact is authorized only with «в проекте <key>» (authorizedTarget).
    hintFactProject =
      operation.kind === 'forget' && operation.target === 'fact'
        ? (operation.projectKey ?? undefined)
        : undefined;
    if (containsMemoryCredentials(operation) || containsMemoryCredentials(payload.source))
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
        messageContentSha256: messageContentDigest(cited.content),
        messageEditRevision: getTelegramMessageEditRevisionFrom(db, context.chatJid, cited.id),
        messageBindingHash: getTelegramMessageEditBindingHashFrom(db, context.chatJid, cited.id),
        at: cited.timestamp,
        ...(isLatest ? { currentDirectInput: true } : {}),
        ...(operation.kind === 'project_upsert' && isLatest && context.senderIdentity.is_owner_sender === true
          ? { projectNamesMessage: cited.content, projectNamesOnly: true } : {}),
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
    // A names-only instruction cannot be reused for a different write or an
    // extra no-op revision. The store still resolves a known receipt first.
    const metadataCommand = /^\s*(?:Добавь имя «|Удали имя «|Свяжи проект |Убери связь проекта )/iu;
    if (metadataCommand.test(latest.content) || source.projectNamesMessage && metadataCommand.test(source.projectNamesMessage))
      source.metadataTurn = true;
    // Retention and ingest can also write from a different SQLite connection.
    // Recheck the grant and its cited version under the same lock as the mutation.
    const result = db.transaction(() => {
      if (context.validateCurrentMutation?.() === false) return;
      if (source.kind === 'direct_user' && source.messageId) {
        const cited = directSource(db, context, source.messageId);
        if (!cited || cited.timestamp !== source.at || messageContentDigest(cited.content) !== source.messageContentSha256 ||
            getTelegramMessageEditRevisionFrom(db, context.chatJid, cited.id) !== source.messageEditRevision ||
            getTelegramMessageEditBindingHashFrom(db, context.chatJid, cited.id) !== source.messageBindingHash) return;
      }
      return mutateMemoryState(db, scope, operation, source);
    }).immediate();
    if (!result) return deny('current_direct_source_required');
    if (result.record?.kind === 'fact') readEvidence.reviewFact(result.record);
    if (result.record?.kind === 'project') readEvidence.reviewProject(result.record);
    // W07: vectors of the written project, in the background (off the reply).
    if (operation.kind !== 'forget')
      scheduleStructuredMemoryWarm(db, scope, operation.projectKey);
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
        ...(error.workReview && {
          hint: error.code === 'work_evidence_revision_required'
            ? `Read the exact card at record revision ${error.currentRevision}, requirementsRevision ${error.workReview.requirementsRevision}. An earlier check was reused. Save revised criteria as pending, then cite the observation or run that checked the revised criteria: ${error.workReview.criterionKeys.join(', ')}.`
            : `Read the exact project card at record revision ${error.currentRevision}, requirementsRevision ${error.workReview.requirementsRevision}. After changing requirements, increase requirementsRevision and recheck these criteria: ${error.workReview.criterionKeys.join(', ')}. Prior acceptance cannot verify revised requirements.`,
        }),
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

/** Shared IPC transport wrapper. Plaintext requests are internal test/API only.
 * `reason` is the plain refusal code for the host journal only: on the wire it
 * stays inside the sealed payload (outer error: memory_state_rejected), so a
 * log reading «memory_state_rejected» said nothing (week review, W12). */
export function handleMemoryStateWireRequestWithReason(
  raw: unknown,
  sourceGroup: string,
  db: Database.Database = getDb(),
): { wire: Record<string, unknown>; reason?: string } {
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
  const wire = sealMemoryStateWireResponse(raw, sourceGroup, response);
  const code =
    !response.ok &&
    typeof response.error === 'string' &&
    /^[a-z0-9_]{1,100}$/.test(response.error)
      ? response.error
      : undefined;
  return code ? { wire, reason: code } : { wire };
}

/** Wire-only form of the same transport, kept for callers that do not log
 * the refusal code (setup/ MCP checks, the evals model trial). */
export function handleMemoryStateWireRequest(
  raw: unknown,
  sourceGroup: string,
  db: Database.Database = getDb(),
): Record<string, unknown> {
  return handleMemoryStateWireRequestWithReason(raw, sourceGroup, db).wire;
}
