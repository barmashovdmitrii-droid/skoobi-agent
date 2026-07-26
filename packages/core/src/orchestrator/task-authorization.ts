import {
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

import type { SenderIdentity } from './types.js';
import type { GoogleOperationPolicy } from './google-workspace-policy.js';
import {
  GOOGLE_WORKSPACE_DESTRUCTIVE_TOOLS,
  GOOGLE_WORKSPACE_WRITE_TOOLS,
  googleWorkspaceOperationFingerprint,
  parseGoogleWorkspaceOperation,
  type GoogleWorkspaceOperation,
  type GoogleWorkspaceTool,
} from './google-workspace-operation.js';

const TASK_CAPABILITY_TTL_MS = 2 * 60 * 60 * 1000;
// The IPC watcher is a single sequential loop and may await up to 50 earlier
// network sends before it reaches a newly queued envelope. Keep the exact,
// one-shot grant alive long enough for a legitimate owner send under backlog;
// exact-envelope binding and burn-on-presentation keep the wider window safe.
const TASK_OPERATION_GRANT_TTL_MS = 5 * 60_000;
const MAX_TASK_OPERATION_GRANTS_PER_CAPABILITY = 100;
const MAX_TASK_AUTHORIZATION_REQUESTS_PER_CAPABILITY = 200;
const MAX_TASK_AUTHORIZATION_ENVELOPE_BYTES = 2 * 1024 * 1024;
const TASK_AUTHORIZATION_ENVELOPE_KEY_CONTEXT =
  'skoobi.task_authorization.envelope.key.v1';
const TASK_AUTHORIZATION_ENVELOPE_AAD_CONTEXT =
  'skoobi.task_authorization.envelope.aad.v1';

const MAX_IPC_MESSAGE_TEXT_CHARS = 64 * 1024;
const MAX_IPC_VOICE_TEXT_CHARS = 12_000;
const MAX_IPC_CAPTION_CHARS = 1024;
const MAX_IPC_CHAT_JID_CHARS = 256;
const MAX_IPC_FILE_PATH_CHARS = 4096;

export type TaskAuthorizationAction =
  | 'schedule_task'
  | 'pause_task'
  | 'resume_task'
  | 'cancel_task'
  | 'cleanup_tasks'
  | 'update_task'
  | 'register_group'
  | 'refresh_groups'
  | 'message'
  | 'photo'
  | 'document'
  | 'voice'
  | 'google_api';

interface ActiveTaskCapability {
  secret: string;
  groupFolder: string;
  creatorIdentityId: string;
  creatorSenderId: string;
  expiresAt: number;
  grants: number;
  seenRequestIds: Set<string>;
  googleOperationPolicy?: GoogleOperationPolicy;
}

interface ActiveTaskOperationGrant {
  capabilityId: string;
  action: TaskAuthorizationAction;
  sourceGroup: string;
  envelopeFingerprint: string;
  creatorIdentityId: string;
  creatorSenderId: string;
  expiresAt: number;
  googleIntentId?: string;
  googleOperationKey?: string;
  googleTool?: GoogleWorkspaceTool;
  googleResponseKey?: string;
}

export interface TaskAuthorizationResponse {
  type: 'task_authorize_result';
  request_id: string;
  ok: boolean;
  grant?: string;
  error?: string;
}

export interface SealedTaskAuthorizationEnvelope {
  v: 1;
  alg: 'A256GCM';
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface ConsumedTaskOwnerAuthorization {
  creatorAuthorization: 'owner_sender';
  creatorIdentityId: string;
  creatorSenderId: string;
  googleIntentId?: string;
  googleOperationKey?: string;
  googleTool?: GoogleWorkspaceTool;
  googleResponseKey?: string;
}

const activeCapabilities = new Map<string, ActiveTaskCapability>();
const activeOperationGrants = new Map<string, ActiveTaskOperationGrant>();

function validRequestId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value)
    ? value
    : null;
}

function validTaskId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Validate non-emptiness with trim, but bind the grant to the exact raw ID.
  // IPC lookup uses the raw string; canonicalizing here would let a grant for
  // a harmless whitespace-padded no-op be replayed against the real ID.
  return trimmed && value.length <= 256 ? value : null;
}

function optionalString(
  value: unknown,
  max: number,
): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) return undefined;
  return value;
}

type CanonicalOptionalString = ['absent'] | ['string', string];

function canonicalOptionalString(
  raw: Record<string, unknown>,
  key: string,
  max: number,
  allowEmpty = true,
): CanonicalOptionalString | null {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) return ['absent'];
  const value = raw[key];
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    return null;
  }
  return ['string', value];
}

function normalizedEnvelope(
  action: TaskAuthorizationAction,
  raw: Record<string, unknown>,
): unknown[] | null {
  if (action === 'google_api') {
    const { ownerAuthorizationGrant: _grant, ...operation } = raw;
    const parsed = parseGoogleWorkspaceOperation(operation);
    return parsed.ok ? [action, parsed.value] : null;
  }
  if (action === 'message' || action === 'voice') {
    const chatJid = optionalString(raw.chatJid, MAX_IPC_CHAT_JID_CHARS);
    const text = optionalString(
      raw.text,
      action === 'voice'
        ? MAX_IPC_VOICE_TEXT_CHARS
        : MAX_IPC_MESSAGE_TEXT_CHARS,
    );
    return typeof chatJid === 'string' && typeof text === 'string'
      ? [action, chatJid, text]
      : null;
  }

  if (action === 'photo' || action === 'document') {
    const chatJid = optionalString(raw.chatJid, MAX_IPC_CHAT_JID_CHARS);
    const filePath = optionalString(raw.filePath, MAX_IPC_FILE_PATH_CHARS);
    const caption = canonicalOptionalString(
      raw,
      'caption',
      MAX_IPC_CAPTION_CHARS,
    );
    return typeof chatJid === 'string' &&
      typeof filePath === 'string' &&
      caption !== null
      ? [action, chatJid, filePath, caption]
      : null;
  }

  if (action === 'schedule_task') {
    const taskId = validTaskId(raw.taskId);
    const prompt = optionalString(raw.prompt, 1024 * 1024);
    const scheduleValue = optionalString(raw.schedule_value, 4096);
    const targetJid = optionalString(raw.targetJid, 256);
    if (
      !taskId ||
      typeof prompt !== 'string' ||
      !['cron', 'interval', 'once'].includes(String(raw.schedule_type)) ||
      typeof scheduleValue !== 'string' ||
      typeof targetJid !== 'string'
    ) {
      return null;
    }
    const calendarEvent = Object.prototype.hasOwnProperty.call(
      raw,
      'calendar_event',
    )
      ? typeof raw.calendar_event === 'boolean'
        ? ['boolean', raw.calendar_event]
        : null
      : ['absent'];
    const calendarReminderMinutes = Object.prototype.hasOwnProperty.call(
      raw,
      'calendar_reminder_minutes',
    )
      ? typeof raw.calendar_reminder_minutes === 'number' &&
        Number.isInteger(raw.calendar_reminder_minutes) &&
        raw.calendar_reminder_minutes >= 0 &&
        raw.calendar_reminder_minutes <= 40320
        ? ['number', raw.calendar_reminder_minutes]
        : null
      : ['absent'];
    if (!calendarEvent || !calendarReminderMinutes) return null;
    return [
      action,
      taskId,
      prompt,
      raw.schedule_type,
      scheduleValue,
      raw.context_mode === 'group' ? 'group' : 'isolated',
      targetJid,
      calendarEvent,
      calendarReminderMinutes,
    ];
  }

  if (
    action === 'pause_task' ||
    action === 'resume_task' ||
    action === 'cancel_task'
  ) {
    const taskId = validTaskId(raw.taskId);
    return taskId ? [action, taskId] : null;
  }

  if (action === 'cleanup_tasks') {
    const statuses = Array.isArray(raw.statuses)
      ? [
          ...new Set(
            raw.statuses.filter((v) => v === 'completed' || v === 'cancelled'),
          ),
        ].sort()
      : ['cancelled', 'completed'];
    const target = canonicalOptionalString(raw, 'targetGroupFolder', 64);
    if (target === null) return null;
    return [action, statuses, target];
  }

  if (action === 'register_group') {
    const jid = optionalString(raw.jid, 256);
    const name = optionalString(raw.name, 256);
    const folder = optionalString(raw.folder, 64);
    const trigger = optionalString(raw.trigger, 256);
    if (
      typeof jid !== 'string' ||
      typeof name !== 'string' ||
      typeof folder !== 'string' ||
      typeof trigger !== 'string'
    ) {
      return null;
    }
    let containerConfig: string;
    try {
      containerConfig = JSON.stringify(raw.containerConfig ?? null);
    } catch {
      return null;
    }
    if (containerConfig.length > 64 * 1024) return null;
    const requiresTrigger = Object.prototype.hasOwnProperty.call(
      raw,
      'requiresTrigger',
    )
      ? typeof raw.requiresTrigger === 'boolean'
        ? ['boolean', raw.requiresTrigger]
        : null
      : ['absent'];
    if (!requiresTrigger) return null;
    return [
      action,
      jid,
      name,
      folder,
      trigger,
      requiresTrigger,
      containerConfig,
    ];
  }

  if (action === 'refresh_groups') return [action];

  const taskId = validTaskId(raw.taskId);
  if (!taskId) return null;
  const prompt = canonicalOptionalString(raw, 'prompt', 1024 * 1024, false);
  const scheduleType = canonicalOptionalString(raw, 'schedule_type', 16);
  const scheduleValue = canonicalOptionalString(raw, 'schedule_value', 4096);
  if (
    prompt === null ||
    scheduleType === null ||
    scheduleValue === null ||
    (scheduleType[0] === 'string' &&
      !['cron', 'interval', 'once'].includes(scheduleType[1])) ||
    (scheduleValue[0] === 'string' && scheduleValue[1].length === 0)
  ) {
    return null;
  }
  return [action, taskId, prompt, scheduleType, scheduleValue];
}

function envelopeFingerprint(
  action: TaskAuthorizationAction,
  raw: Record<string, unknown>,
): string | null {
  const normalized = normalizedEnvelope(action, raw);
  if (!normalized) return null;
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function canonicalGooglePolicyQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function matchingGoogleCreateTarget(
  policy: GoogleOperationPolicy,
  operation: GoogleWorkspaceOperation,
): GoogleOperationPolicy['allowedCreateTargets'][number] | null {
  if (
    operation.tool !== 'google_sheets_create' &&
    operation.tool !== 'google_docs_create'
  ) {
    return null;
  }
  const locationMatches = (
    target: GoogleOperationPolicy['allowedCreateTargets'][number],
  ): boolean =>
    target.root
      ? operation.args.folderId === undefined
      : Boolean(target.folderId && target.folderId === operation.args.folderId);
  const candidates = policy.allowedCreateTargets.filter(
    (target) => target.tool === operation.tool && locationMatches(target),
  );
  return (
    candidates.find((target) => target.title === operation.args.title) ??
    candidates.find((target) => target.title === undefined) ??
    null
  );
}

function googleMutationSlotDescriptor(
  policy: GoogleOperationPolicy,
  operation: GoogleWorkspaceOperation,
): unknown[] | null {
  if (
    operation.tool === 'google_sheets_create' ||
    operation.tool === 'google_docs_create'
  ) {
    const target = matchingGoogleCreateTarget(policy, operation);
    if (!target) return null;
    return [
      'create',
      target.tool,
      target.title === undefined ? ['generic'] : ['title', target.title],
      target.root ? ['root'] : ['folder', target.folderId],
    ];
  }
  if (operation.tool === 'google_docs_replace_content') {
    return ['document', operation.args.documentId];
  }
  if (operation.tool === 'google_sheets_append_values') {
    return ['sheet-append', operation.args.spreadsheetId, operation.args.range];
  }
  // Sheet overwrites and Apps Script writes fail closed before this point. Any
  // future write must define an explicit stable mutation target here first.
  return null;
}

function googleOperationResourceAllowed(
  policy: GoogleOperationPolicy,
  operation: GoogleWorkspaceOperation,
): boolean {
  switch (operation.tool) {
    case 'google_workspace_status':
      return !operation.args.verify || policy.allowStatusVerify;
    case 'google_drive_list_files': {
      if (!policy.allowDriveSearch) return false;
      return policy.allowedDriveSearchTargets.some((target) => {
        const nameMatches = target.nameQuery
          ? Boolean(
              operation.args.query &&
              canonicalGooglePolicyQuery(operation.args.query) ===
                canonicalGooglePolicyQuery(target.nameQuery),
            )
          : operation.args.query === undefined;
        const contentMatches = target.contentQuery
          ? Boolean(
              operation.args.contentQuery &&
              canonicalGooglePolicyQuery(operation.args.contentQuery) ===
                canonicalGooglePolicyQuery(target.contentQuery),
            )
          : operation.args.contentQuery === undefined;
        const typeMatches =
          target.type === 'any' || operation.args.type === target.type;
        const folderMatches = target.folderId
          ? operation.args.folderId === target.folderId
          : operation.args.folderId === undefined;
        const rootMatches = target.rootOnly === operation.args.rootOnly;
        return (
          Boolean(
            target.nameQuery ||
            target.contentQuery ||
            target.folderId ||
            target.rootOnly ||
            target.unfiltered,
          ) &&
          nameMatches &&
          contentMatches &&
          typeMatches &&
          folderMatches &&
          rootMatches
        );
      });
    }
    case 'google_sheets_create':
    case 'google_docs_create':
      return matchingGoogleCreateTarget(policy, operation) !== null;
    case 'google_docs_read':
    case 'google_docs_replace_content':
      return policy.allowedDocumentIds.includes(operation.args.documentId);
    case 'google_sheets_get_values':
    case 'google_sheets_update_values':
      return policy.allowedSheetTargets.some(
        (target) =>
          target.spreadsheetId === operation.args.spreadsheetId &&
          target.range === operation.args.range,
      );
    case 'google_sheets_append_values': {
      const target = policy.allowedSheetAppendTargets.find(
        (candidate) =>
          candidate.spreadsheetId === operation.args.spreadsheetId &&
          candidate.range === operation.args.range,
      );
      return Boolean(
        target &&
        operation.args.values.length >= 1 &&
        operation.args.values.length <= target.maxRowsPerCall &&
        operation.args.values.every(
          (row) =>
            row.length === target.columnCount &&
            row.every((cell) => cell !== null),
        ),
      );
    }
    case 'google_apps_script_get_content':
      return policy.allowedScriptIds.includes(operation.args.scriptId);
    case 'google_apps_script_update_file':
      return policy.confirmedScriptUpdateTargets.some(
        (target) =>
          target.scriptId === operation.args.scriptId &&
          target.fileName === operation.args.fileName,
      );
    case 'google_calendar_list_events': {
      const earliest = Date.parse(policy.calendarEarliestTime || '');
      const latest = Date.parse(policy.calendarLatestTime || '');
      const timeMin = Date.parse(operation.args.timeMin);
      const timeMax = Date.parse(operation.args.timeMax);
      if (
        ![earliest, latest, timeMin, timeMax].every(Number.isFinite) ||
        timeMin < earliest ||
        timeMax > latest ||
        timeMax - timeMin > 31 * 24 * 60 * 60 * 1000
      ) {
        return false;
      }
      return policy.allowedCalendarTargets.some((target) => {
        if (target.calendarId !== operation.args.calendarId) return false;
        return target.query === undefined
          ? operation.args.query === undefined
          : Boolean(
              operation.args.query &&
              canonicalGooglePolicyQuery(operation.args.query) ===
                canonicalGooglePolicyQuery(target.query),
            );
      });
    }
    case 'gmail_search_threads':
    case 'gmail_get_thread':
      // Gmail thread IDs are discovered dynamically by the search operation,
      // so the explicit owner-turn tool allowlist is the resource boundary.
      return true;
  }
}

function googleDestructiveOperationConfirmed(
  policy: GoogleOperationPolicy,
  operation: GoogleWorkspaceOperation,
): boolean {
  if (!GOOGLE_WORKSPACE_DESTRUCTIVE_TOOLS.has(operation.tool)) return true;
  switch (operation.tool) {
    case 'google_docs_replace_content':
      return policy.confirmedDocumentReplaceIds.includes(
        operation.args.documentId,
      );
    case 'google_sheets_update_values':
      return policy.confirmedSheetUpdateTargets.some(
        (target) =>
          target.spreadsheetId === operation.args.spreadsheetId &&
          target.range === operation.args.range,
      );
    case 'google_apps_script_update_file':
      return policy.confirmedScriptUpdateTargets.some(
        (target) =>
          target.scriptId === operation.args.scriptId &&
          target.fileName === operation.args.fileName,
      );
    default:
      // Future destructive registry entries fail closed until this switch gets
      // an explicit policy rule and regression test.
      return false;
  }
}

function authorizeGoogleOperationForCapability(
  capability: ActiveTaskCapability,
  raw: Record<string, unknown>,
):
  | {
      ok: true;
      operation: GoogleWorkspaceOperation;
      intentId: string;
      operationKey: string;
      responseKey: string;
    }
  | { ok: false; error: string } {
  const policy = capability.googleOperationPolicy;
  if (!policy) return { ok: false, error: 'google_policy_unavailable' };
  const parsed = parseGoogleWorkspaceOperation(raw);
  if (!parsed.ok) return { ok: false, error: 'invalid_google_operation' };
  const operation = parsed.value;
  if (!operation.request_id) {
    return { ok: false, error: 'google_request_id_required' };
  }
  // These provider APIs offer no atomic compare-and-swap precondition. A
  // read-digest-then-PUT sequence can overwrite a concurrent owner edit, so
  // policy construction and this authoritative host boundary both deny them.
  if (
    operation.tool === 'google_sheets_update_values' ||
    operation.tool === 'google_apps_script_update_file'
  ) {
    return {
      ok: false,
      error: 'google_atomic_precondition_unavailable',
    };
  }
  if (!policy.allowedTools.includes(operation.tool)) {
    return { ok: false, error: 'google_tool_not_allowed_for_turn' };
  }
  if (!googleOperationResourceAllowed(policy, operation)) {
    return { ok: false, error: 'google_resource_not_allowed_for_turn' };
  }
  if (!googleDestructiveOperationConfirmed(policy, operation)) {
    return { ok: false, error: 'google_destructive_confirmation_required' };
  }
  const mutationSlot = GOOGLE_WORKSPACE_WRITE_TOOLS.has(operation.tool)
    ? googleMutationSlotDescriptor(policy, operation)
    : null;
  if (GOOGLE_WORKSPACE_WRITE_TOOLS.has(operation.tool) && !mutationSlot) {
    return { ok: false, error: 'google_mutation_target_unavailable' };
  }
  return {
    ok: true,
    operation,
    intentId: policy.intentId,
    // Exact envelope integrity is already enforced by the one-use grant. For
    // mutations the durable journal uses a stable owner-authorized target slot
    // so fallback cannot repeat a write by varying payload/digest, while one
    // explicit turn may still update two distinct approved targets.
    operationKey: GOOGLE_WORKSPACE_WRITE_TOOLS.has(operation.tool)
      ? createHash('sha256')
          .update(
            JSON.stringify([
              'skoobi.google.mutation-slot.v3',
              operation.tool,
              mutationSlot,
            ]),
          )
          .digest('hex')
      : googleWorkspaceOperationFingerprint(operation),
    responseKey: createHmac('sha256', capability.secret)
      .update('skoobi.google.ipc.response.v1\0')
      .update(operation.request_id)
      .digest('base64url'),
  };
}

function deny(requestId: string, error: string): TaskAuthorizationResponse {
  return {
    type: 'task_authorize_result',
    request_id: requestId,
    ok: false,
    error,
  };
}

function capabilityId(value: string): string {
  return value.split('.', 1)[0] || '';
}

function strictBase64Url(
  value: unknown,
  minBytes: number,
  maxBytes: number,
): Buffer | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > Math.ceil((maxBytes * 4) / 3) + 4 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length >= minBytes &&
      decoded.length <= maxBytes &&
      decoded.toString('base64url') === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function taskAuthorizationEnvelopeKey(
  capabilityIdValue: string,
  capabilitySecret: string,
): Buffer | null {
  const secret = strictBase64Url(capabilitySecret, 32, 32);
  if (!secret) return null;
  try {
    return createHmac('sha256', secret)
      .update(TASK_AUTHORIZATION_ENVELOPE_KEY_CONTEXT)
      .update('\0')
      .update(capabilityIdValue)
      .digest();
  } finally {
    secret.fill(0);
  }
}

function taskAuthorizationEnvelopeAad(
  capabilityIdValue: string,
  requestId: string,
  action: string,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      TASK_AUTHORIZATION_ENVELOPE_AAD_CONTEXT,
      capabilityIdValue,
      requestId,
      action,
    ]),
  );
}

function openTaskAuthorizationEnvelope(input: {
  capabilityId: string;
  capabilitySecret: string;
  requestId: string;
  action: TaskAuthorizationAction;
  sealed: unknown;
}): Record<string, unknown> | null {
  if (
    !input.sealed ||
    typeof input.sealed !== 'object' ||
    Array.isArray(input.sealed)
  ) {
    return null;
  }
  const sealed = input.sealed as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(sealed);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (
    JSON.stringify(Object.keys(sealed).sort()) !==
      JSON.stringify(['alg', 'ciphertext', 'iv', 'tag', 'v']) ||
    sealed.v !== 1 ||
    sealed.alg !== 'A256GCM'
  ) {
    return null;
  }

  const iv = strictBase64Url(sealed.iv, 12, 12);
  const tag = strictBase64Url(sealed.tag, 16, 16);
  const ciphertext = strictBase64Url(
    sealed.ciphertext,
    1,
    MAX_TASK_AUTHORIZATION_ENVELOPE_BYTES,
  );
  if (!iv || !tag || !ciphertext) return null;
  const key = taskAuthorizationEnvelopeKey(
    input.capabilityId,
    input.capabilitySecret,
  );
  if (!key) return null;

  let plaintext: Buffer | null = null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(
      taskAuthorizationEnvelopeAad(
        input.capabilityId,
        input.requestId,
        input.action,
      ),
    );
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (
      plaintext.length === 0 ||
      plaintext.length > MAX_TASK_AUTHORIZATION_ENVELOPE_BYTES
    ) {
      return null;
    }
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const envelope = parsed as Record<string, unknown>;
    const envelopePrototype = Object.getPrototypeOf(envelope);
    if (
      (envelopePrototype !== Object.prototype && envelopePrototype !== null) ||
      envelope.type !== input.action
    ) {
      return null;
    }
    return envelope;
  } catch {
    return null;
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}

function taskAuthorizationProofPayload(
  record: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: record.type,
    request_id: record.request_id,
    action: record.action,
    sealed_envelope: record.sealed_envelope,
  });
}

function validProof(secret: string, record: Record<string, unknown>): boolean {
  if (typeof record.proof !== 'string') return false;
  try {
    const supplied = Buffer.from(record.proof, 'base64url');
    const expected = createHmac('sha256', secret)
      .update(taskAuthorizationProofPayload(record))
      .digest();
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    );
  } catch {
    return false;
  }
}

/**
 * Mint a host-held bearer only for an authoritatively owner-authored main run.
 * The bearer itself never becomes durable task provenance: it can only ask the
 * host for a short-lived, exact-envelope operation grant below.
 */
export function registerTaskAuthorizationCapability(input: {
  groupFolder: string;
  isMain: boolean;
  credentialProxyTier?: 'owner' | 'guest';
  senderIdentity?: SenderIdentity;
  homogeneousOwnerBatch: boolean;
  googleOperationPolicy?: GoogleOperationPolicy;
}): string | null {
  if (
    input.isMain !== true ||
    input.credentialProxyTier !== 'owner' ||
    input.homogeneousOwnerBatch !== true ||
    input.senderIdentity?.is_owner_sender !== true ||
    input.senderIdentity.telegram_message_origin !== 'direct' ||
    !input.senderIdentity.identity_id ||
    !input.senderIdentity.telegram_user_id
  ) {
    return null;
  }
  const id = randomBytes(16).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  activeCapabilities.set(id, {
    secret,
    groupFolder: input.groupFolder,
    creatorIdentityId: input.senderIdentity.identity_id,
    creatorSenderId: input.senderIdentity.telegram_user_id,
    expiresAt: Date.now() + TASK_CAPABILITY_TTL_MS,
    grants: 0,
    seenRequestIds: new Set(),
    googleOperationPolicy: input.googleOperationPolicy,
  });
  return `${id}.${secret}`;
}

export function revokeTaskAuthorizationCapability(capability: string): void {
  const id = capabilityId(capability);
  activeCapabilities.delete(id);
  // A response may have been minted just before the owner process crashed,
  // leaving its exact grant in the shared group IPC tree. Once the run-scoped
  // capability is revoked, no later co-member may present that orphaned grant.
  for (const [grantValue, grant] of activeOperationGrants) {
    if (grant.capabilityId === id) activeOperationGrants.delete(grantValue);
  }
}

/** Host request-response boundary used by the MCP process. */
export function authorizeTaskOperationRequest(
  raw: unknown,
  sourceGroup: string,
): TaskAuthorizationResponse {
  const record =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const requestId = validRequestId(record.request_id) || 'invalid';
  if (record.type !== 'task_authorize') {
    return deny(requestId, 'invalid_request_type');
  }
  if (requestId === 'invalid') return deny(requestId, 'invalid_request_id');
  if (typeof record.capability_id !== 'string') {
    return deny(requestId, 'missing_capability_id');
  }
  const capability = activeCapabilities.get(record.capability_id);
  if (!capability || capability.expiresAt < Date.now()) {
    activeCapabilities.delete(record.capability_id);
    return deny(requestId, 'invalid_or_expired_capability');
  }
  if (capability.seenRequestIds.has(requestId)) {
    return deny(requestId, 'replayed_request_id');
  }
  if (!validProof(capability.secret, record)) {
    return deny(requestId, 'invalid_proof');
  }
  if (
    capability.seenRequestIds.size >=
    MAX_TASK_AUTHORIZATION_REQUESTS_PER_CAPABILITY
  ) {
    return deny(requestId, 'task_authorization_request_limit_reached');
  }
  capability.seenRequestIds.add(requestId);
  if (capability.groupFolder !== sourceGroup) {
    return deny(requestId, 'capability_group_mismatch');
  }
  if (capability.grants >= MAX_TASK_OPERATION_GRANTS_PER_CAPABILITY) {
    return deny(requestId, 'task_operation_limit_reached');
  }
  if (
    typeof record.action !== 'string' ||
    ![
      'schedule_task',
      'pause_task',
      'resume_task',
      'cancel_task',
      'cleanup_tasks',
      'update_task',
      'register_group',
      'refresh_groups',
      'message',
      'photo',
      'document',
      'voice',
      'google_api',
    ].includes(record.action)
  ) {
    return deny(requestId, 'invalid_action');
  }
  if (Object.prototype.hasOwnProperty.call(record, 'envelope')) {
    return deny(requestId, 'plaintext_envelope_not_allowed');
  }
  const action = record.action as TaskAuthorizationAction;
  const envelope = openTaskAuthorizationEnvelope({
    capabilityId: record.capability_id,
    capabilitySecret: capability.secret,
    requestId,
    action,
    sealed: record.sealed_envelope,
  });
  if (!envelope) return deny(requestId, 'invalid_sealed_envelope');
  const googleAuthorization =
    action === 'google_api'
      ? authorizeGoogleOperationForCapability(capability, envelope)
      : undefined;
  if (googleAuthorization && !googleAuthorization.ok) {
    return deny(requestId, googleAuthorization.error);
  }
  const fingerprint = envelopeFingerprint(action, envelope);
  if (!fingerprint) return deny(requestId, 'invalid_envelope');

  const grant = randomBytes(32).toString('base64url');
  activeOperationGrants.set(grant, {
    capabilityId: record.capability_id,
    action,
    sourceGroup,
    envelopeFingerprint: fingerprint,
    creatorIdentityId: capability.creatorIdentityId,
    creatorSenderId: capability.creatorSenderId,
    expiresAt: Date.now() + TASK_OPERATION_GRANT_TTL_MS,
    ...(googleAuthorization?.ok
      ? {
          googleIntentId: googleAuthorization.intentId,
          googleOperationKey: googleAuthorization.operationKey,
          googleTool: googleAuthorization.operation.tool,
          googleResponseKey: googleAuthorization.responseKey,
        }
      : {}),
  });
  capability.grants += 1;
  return {
    type: 'task_authorize_result',
    request_id: requestId,
    ok: true,
    grant,
  };
}

/**
 * Consume an exact, one-use operation grant. Arbitrary JSON fields such as
 * `isMain`, `createdBy`, or creator booleans never carry authority.
 */
export function consumeTaskOperationGrant(
  raw: Record<string, unknown>,
  sourceGroup: string,
): ConsumedTaskOwnerAuthorization | null {
  if (typeof raw.ownerAuthorizationGrant !== 'string') return null;
  const grant = activeOperationGrants.get(raw.ownerAuthorizationGrant);
  if (!grant) return null;
  // Strict one-shot semantics: even a malformed/mismatched presentation burns
  // the grant. This prevents probing one bearer against multiple operations.
  activeOperationGrants.delete(raw.ownerAuthorizationGrant);
  if (grant.expiresAt < Date.now()) {
    return null;
  }
  if (raw.type !== grant.action || sourceGroup !== grant.sourceGroup)
    return null;
  const fingerprint = envelopeFingerprint(grant.action, raw);
  if (!fingerprint || fingerprint !== grant.envelopeFingerprint) return null;

  return {
    creatorAuthorization: 'owner_sender',
    creatorIdentityId: grant.creatorIdentityId,
    creatorSenderId: grant.creatorSenderId,
    ...(grant.googleIntentId ? { googleIntentId: grant.googleIntentId } : {}),
    ...(grant.googleOperationKey
      ? { googleOperationKey: grant.googleOperationKey }
      : {}),
    ...(grant.googleTool ? { googleTool: grant.googleTool } : {}),
    ...(grant.googleResponseKey
      ? { googleResponseKey: grant.googleResponseKey }
      : {}),
  };
}

/** @internal tests only */
export function _clearTaskAuthorizationState(): void {
  activeCapabilities.clear();
  activeOperationGrants.clear();
}
