import { getTelegramMessageEditBindingHashFrom, getTelegramMessageEditRevisionFrom } from './telegram-message-edit-store.js';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { parseTelegramJid, safeTelegramBotId } from '@skoobi/shared';
import { directSource } from './memory-source-message.js';
import type { MemoryStateRecord, MemoryStateScope, MemoryStateSearchHit, StoredMemoryStateSource } from './memory-state-store.js';

type Fact = Extract<MemoryStateRecord, { kind: 'fact' }>;
export type PriorDecision = { revision: number; value: string; source: StoredMemoryStateSource };
export type SourceReference = {
  status: 'same_chat_message' | 'unversioned_quote_match';
  messageId: string;
  url?: string;
} | { status: 'source_edited_review_required' };

export function quoteTrustAtRead(status: SourceReference['status'] | 'source_unavailable') {
  switch (status) {
    case 'same_chat_message': return 'verified_quote';
    case 'unversioned_quote_match': return 'quoted_words_only';
    case 'source_edited_review_required': return 'original_message_changed';
    case 'source_unavailable': return 'current_source_unavailable';
  }
}

/** The digest covers the entire message. A surviving short quote alone cannot
 * establish that the original instruction has retained its meaning. */
export function messageContentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** A citation is a reference to the speaker's words, not proof that work ran.
 * Reports store the triggering input ID, which is not a receipt for the report. */
function verifiedMemoryMessage(
  db: Database.Database,
  scope: MemoryStateScope,
  senderId: string,
  source: StoredMemoryStateSource,
): SourceReference | undefined {
  if (source.kind !== 'direct_user' || !source.quote || !source.messageId) return;
  const jid = parseTelegramJid(scope.chatJid);
  if (!jid) return;
  const senderIdentity = {
    telegram_user_id: senderId,
    identity_id: scope.identityId,
    chat_id: jid.chatId,
  };
  // Some readers have a memory-only DB; an inaccessible source is not a
  // reason to suppress a readable decision or invent a Telegram permalink.
  try {
    const message = directSource(db, { chatJid: scope.chatJid, senderIdentity }, source.messageId);
    if (!message || message.timestamp !== source.at) return;
    const sourceIdentity = JSON.parse(message.sender_identity_json!);
    if (safeTelegramBotId(sourceIdentity.bot_id) !== safeTelegramBotId(jid.botId)) return;
    const revision = getTelegramMessageEditRevisionFrom(db, scope.chatJid, message.id);
    if ((revision ?? 0) !== (source.messageEditRevision ?? 0) ||
        getTelegramMessageEditBindingHashFrom(db, scope.chatJid, message.id) !== source.messageBindingHash)
      return { status: 'source_edited_review_required' };
    if (source.messageContentSha256 && messageContentDigest(message.content) !== source.messageContentSha256)
      return { status: 'source_edited_review_required' };
    if (!message.content.includes(source.quote)) return;
    const channel = /^-100([1-9]\d*)$/.exec(jid.chatId);
    const url = channel && /^[1-9]\d*$/.test(message.id)
      ? `https://t.me/c/${channel[1]}/${message.id}`
      : undefined;
    return {
      status: source.messageContentSha256 ? 'same_chat_message' : 'unversioned_quote_match',
      messageId: message.id,
      ...(url ? { url } : {}),
    };
  } catch {
    return;
  }
}

/** At most the preceding revision of an explicitly queried current decision.
 * A forget may be followed by a fresh remember; never cross that boundary.
 * Keep earlier decisions out of the semantic index and ordinary prompts. */
function previousMemoryDecision(
  db: Database.Database,
  scope: MemoryStateScope,
  fact: Fact,
  now: string,
): PriorDecision | undefined {
  if (fact.factType !== 'decision' || fact.revision < 2 || !fact.projectKey) return;
  const scopeId = JSON.stringify([scope.chatJid.trim(), scope.identityId.trim(), scope.tenantId.trim()]);
  const recordKey = JSON.stringify(['fact', fact.projectKey, fact.key]);
  const row = db.prepare(`
    SELECT v.revision,v.body_json,v.source_json FROM memory_state_versions v
    JOIN memory_state_records r ON r.scope_key=v.scope_key AND r.record_key=v.record_key
    LEFT JOIN memory_state_tombstones t ON t.scope_key=v.scope_key AND t.record_key=v.record_key
    WHERE r.scope_key=? AND r.record_key=? AND r.revision=? AND r.forgotten=0
      AND v.revision=r.revision-1 AND v.revision>COALESCE(t.revision,0)
      AND v.forgotten=0 AND v.body_json IS NOT NULL AND v.source_json IS NOT NULL
      AND json_extract(v.body_json,'$.factType')='decision'
      AND (json_extract(v.body_json,'$.validUntil') IS NULL OR json_extract(v.body_json,'$.validUntil')>?)
  `).get(scopeId, recordKey, fact.revision, now) as
    { revision: number; body_json: string; source_json: string } | undefined;
  if (!row) return;
  const previous = JSON.parse(row.body_json) as Fact;
  if (previous.detail || previous.value === fact.value || typeof previous.value !== 'string') return;
  return { revision: row.revision, value: previous.value, source: JSON.parse(row.source_json) };
}


/** Manual IPC reads may be followed directly by actions. Mark a matching
 * excerpt as unversioned, and never pass the old payload as present evidence
 * after a known edit. All mutations here affect detached return objects. */
export function memoryReadEvidence(db: Database.Database, scope: MemoryStateScope, senderId: string) {
  const check = (record: MemoryStateRecord) => verifiedMemoryMessage(db, scope, senderId, record.source)?.status;
  const review = (record: MemoryStateRecord) => {
    if (record.source.kind !== 'direct_user') return false;
    const status = check(record) ?? 'source_unavailable';
    Object.assign(record.source, { referenceStatus: status, sourceReferenceTrust: quoteTrustAtRead(status) });
    if (status !== 'source_edited_review_required') return false;
    delete record.source.quote;
    delete record.source.messageId;
    Object.assign(record, { requiresSourceReview: true });
    return true;
  };
  return {
    reviewFact(fact: Fact) {
      if (!review(fact)) return;
      fact.value = '';
      delete fact.detail;
    },
    reviewProject(project: Extract<MemoryStateRecord, { kind: 'project' }>) {
      if (!review(project)) return;
      const { title, status } = project.card;
      project.card = { title, status, goal:'', pending:[], completed:[], waiting:null, artifacts:[] };
      delete project.waitingState;
    },
    reviewSearchHit(hit: MemoryStateSearchHit, record: MemoryStateRecord) {
      if (record.source.kind !== 'direct_user') return hit;
      const status = check(record) ?? 'source_unavailable';
      return {
        ...hit, referenceStatus: status,
        ...(status === 'source_edited_review_required' ? { excerpt: '', requiresSourceReview: true } : {}),
      };
    },
  };
}

export function memoryDecisionEvidence(
  db: Database.Database, scope: MemoryStateScope, senderId: string, now: string,
) {
  return {
    resolveSource: (source: StoredMemoryStateSource) => verifiedMemoryMessage(db, scope, senderId, source),
    previousDecision: (fact: Fact) => previousMemoryDecision(db, scope, fact, now),
  };
}
