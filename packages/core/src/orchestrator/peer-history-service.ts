import path from 'path';
import { randomUUID, createHash } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { readEnvFile } from './env.js';
import { getDb, getAllRegisteredGroups } from './db.js';
import { TenantRegistry, loadOwnerAllowlistFromEnv } from './tenant-registry.js';
import { handlePeerHistoryCapabilityRequest, type PeerHistoryOwnerContext } from './task-authorization.js';
import type { RegisteredGroup } from './types.js';

const canonicalDate = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const requestSchema = z.object({
  type: z.literal('peer_codex_history'),
  selector: z.union([
    z.object({ threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }).strict(),
    z.object({ exactTitle: z.string().min(1).max(200).refine(value => Boolean(value.trim()) && !/[\0\r\n]/.test(value)) }).strict(),
  ]),
  from: canonicalDate, to: canonicalDate,
  maxBytes: z.number().int().min(1024).max(65536).default(32768),
}).strict().refine(value => Date.parse(value.to) > Date.parse(value.from) && Date.parse(value.to) - Date.parse(value.from) <= 31 * 86400000);

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
type Groups = Record<string, RegisteredGroup>;
type Source = { id: string; sender: string; content: string; is_bot_message: number; sequence: number; sender_identity_json: string | null };
export interface PeerHistoryBackend {
  loadConfig: (file: string) => { role: string; ownerJid: string; ownerGroupFolder: string; [key: string]: unknown };
  read: (config: Record<string, unknown>, scope: Record<string, unknown>) => Promise<unknown>;
}

/** Current authoritative ingestion, not prompt text or a model-provided sender. */
function currentSource(db: Database.Database, groups: Groups, owner: PeerHistoryOwnerContext): { chatJid: string; latest: Source; sources: Source[] } {
  const entries = Object.entries(groups).filter(([jid, group]) => group.folder === owner.sourceGroup && group.isMain &&
    TenantRegistry.fromRegisteredGroups(groups).resolveTelegramJid(jid)?.chat_id === owner.channelChatId);
  if (entries.length !== 1) fail('history_owner_scope_changed');
  const chatJid = entries[0][0];
  const owners = loadOwnerAllowlistFromEnv().telegram_user_ids;
  if (owners.size && !owners.has(owner.senderId)) fail('history_owner_revoked');
  const sources = owner.sourceMessageIds.map(id => {
    const row = db.prepare(`SELECT m.id,m.sender,m.content,m.is_bot_message,mi.sequence,mm.sender_identity_json
      FROM messages m JOIN message_ingestion mi ON mi.id=m.id AND mi.chat_jid=m.chat_jid
      LEFT JOIN message_metadata mm ON mm.id=m.id AND mm.chat_jid=m.chat_jid WHERE m.chat_jid=? AND m.id=?`).get(chatJid, id) as Source | undefined;
    if (!row || row.is_bot_message || row.sender !== owner.senderId || !Number.isSafeInteger(row.sequence)) fail('history_direct_source_required');
    let identity: Record<string, unknown>;
    try { identity = JSON.parse(row.sender_identity_json || 'null'); } catch { fail('history_direct_source_required'); }
    if (!identity || identity.channel !== 'telegram' || identity.telegram_message_origin !== 'direct' ||
      identity.is_owner_sender !== true || identity.identity_id !== owner.identityId ||
      identity.telegram_user_id !== owner.senderId || identity.chat_id !== owner.channelChatId) fail('history_direct_source_required');
    return row;
  });
  if (!sources.length) fail('history_direct_source_required');
  const latest = sources.reduce((a, b) => a.sequence > b.sequence ? a : b);
  const newest = db.prepare(`SELECT MAX(mi.sequence) AS sequence FROM messages m
    JOIN message_ingestion mi ON mi.id=m.id AND mi.chat_jid=m.chat_jid
    WHERE m.chat_jid=? AND m.sender=? AND m.is_bot_message=0`).get(chatJid, owner.senderId) as { sequence: number | null };
  // A new correction/stop already in the durable inbox revokes the old read,
  // even while the message loop has not yet delivered it to the running model.
  if (newest.sequence !== latest.sequence) fail('history_newer_owner_message');
  return { chatJid, latest, sources };
}

async function defaultBackend(): Promise<PeerHistoryBackend> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const core = await import(pathToFileURL(path.join(root, 'ops/peer/skoobi-peer-core.mjs')).href);
  const history = await import(pathToFileURL(path.join(root, 'ops/peer/skoobi-peer-history.mjs')).href);
  return { loadConfig: core.loadConfig, read: history.readPeerCodexHistory };
}
const activeGroups = new Set<string>();

function exactNamedSelector(text: string, selector: { threadId: string } | { exactTitle: string }): boolean {
  if ('threadId' in selector) {
    // IDs cannot be prefixes/suffixes of another identifier.
    return new RegExp(`(?:^|[^A-Za-z0-9_-])${selector.threadId}(?:$|[^A-Za-z0-9_-])`).test(text);
  }
  // An arbitrary substring is not an exact thread selection ("new" inside
  // "new site"). Preserve title case as the peer API does; ask for quotes on
  // an ambiguous/unquoted title instead of enumerating private conversations.
  const quotes = /«([^»\r\n]{1,200})»|"([^"\r\n]{1,200})"|“([^”\r\n]{1,200})”|„([^“\r\n]{1,200})“/g;
  for (const match of text.matchAll(quotes)) if (match.slice(1).some(value => value === selector.exactTitle)) return true;
  return false;
}

/** Host-only, async read. No remote result, UI action, new model run or job is
 * synthesized here. The worker's separate opt-in and 45-second bound still apply. */
export function handlePeerCodexHistoryWireRequest(raw: unknown, sourceGroup: string, deps: {
  db?: Database.Database;
  groups?: () => Groups;
  configPath?: () => string | undefined;
  backend?: () => Promise<PeerHistoryBackend>;
} = {}): Promise<Record<string, unknown>> {
  return handlePeerHistoryCapabilityRequest(raw, sourceGroup, async (owner, rawPayload, capabilityCurrent) => {
    const parsed = requestSchema.safeParse(rawPayload);
    if (!parsed.success) fail('history_scope_invalid');
    const payload = parsed.data;
    const db = deps.db ?? getDb(), groups = deps.groups ?? getAllRegisteredGroups;
    const source = currentSource(db, groups(), owner);
    if (!source.sources.some(row => exactNamedSelector(row.content, payload.selector)))
      fail('history_named_thread_required');
    // Relative natural-language dates remain an agent interpretation. When the
    // current request supplies an explicit ISO pair, never silently widen it.
    const explicitDates = [...new Set(source.sources.flatMap(row => row.content.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g) ?? []))];
    if (explicitDates.length >= 2 && (explicitDates.length !== 2 || payload.from !== explicitDates[0] || payload.to !== explicitDates[1]))
      fail('history_explicit_date_range_mismatch');
    const configPath = deps.configPath ?? (() => process.env.SKOOBI_PEER_COORDINATOR_CONFIG || readEnvFile(['SKOOBI_PEER_COORDINATOR_CONFIG']).SKOOBI_PEER_COORDINATOR_CONFIG);
    const file = configPath();
    if (!file || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) fail('history_coordinator_unconfigured');
    if (activeGroups.has(sourceGroup) || activeGroups.size >= 2) fail('history_read_busy');
    activeGroups.add(sourceGroup);
    try {
      const backend = await (deps.backend ?? defaultBackend)();
      const config = backend.loadConfig(file);
      if (config.role !== 'coordinator' || config.ownerJid !== source.chatJid || config.ownerGroupFolder !== sourceGroup)
        fail('history_coordinator_owner_mismatch');
      const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const configHash = digest(config);
      const sourceHash = digest(source.sources);
      const checkCurrent = () => {
        if (!capabilityCurrent() || configPath() !== file) fail('history_owner_revoked');
        const fresh = currentSource(db, groups(), owner);
        if (fresh.chatJid !== source.chatJid || fresh.latest.id !== source.latest.id || digest(fresh.sources) !== sourceHash || digest(backend.loadConfig(file)) !== configHash)
          fail('history_owner_scope_changed');
      };
      checkCurrent();
      const expiresAt = Math.min(owner.expiresAt, Date.now() + 60_000);
      if (expiresAt - Date.now() < 1000) fail('history_capability_expired');
      const result = await backend.read(config, { schema: 1, jobId: randomUUID(), revision: 1,
        sourceMessageId: source.latest.id, selector: payload.selector, from: payload.from, to: payload.to,
        expiresAt: new Date(expiresAt).toISOString(), maxBytes: payload.maxBytes });
      checkCurrent();
      return result;
    } finally { activeGroups.delete(sourceGroup); }
  });
}
