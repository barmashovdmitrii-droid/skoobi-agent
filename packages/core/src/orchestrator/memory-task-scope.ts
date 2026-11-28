import { createHash, randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { RegisteredGroup, ScheduledTask } from './types.js';
import { TenantRegistry, loadOwnerAllowlistFromEnv } from './tenant-registry.js';
import { buildStructuredMemoryContext } from './memory-state-context.js';
import { getMemoryProject, listMemoryState, memoryProjectRevisionFingerprint,
  type MemoryStateScope } from './memory-state-store.js';
import { registerMemoryReadCapability } from './memory-provenance.js';

type Task = Omit<ScheduledTask, 'last_run' | 'last_result'>;
type Groups = Record<string, RegisteredGroup>;
type Binding = { task_id: string; fingerprint: string; revision: number;
  binding_id: string;
  group_folder: string; chat_jid: string; tenant_id: string; identity_id: string;
  sender_id: string; project_key: string };
const PROJECT_KEY = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u;

function tableExists(db: Database.Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_task_read_bindings'").get());
}
function binding(db: Database.Database, taskId: string): Binding | undefined {
  if (!tableExists(db)) return undefined;
  return db.prepare('SELECT * FROM memory_task_read_bindings WHERE task_id=?').get(taskId) as Binding | undefined;
}
export function scheduledMemoryTaskFingerprint(task: Task): string {
  return createHash('sha256').update(JSON.stringify([
    task.id, task.group_folder, task.chat_jid, task.prompt, task.schedule_type,
    task.schedule_value, task.context_mode, task.created_at, task.run_profile ?? null,
    task.creator_authorization, task.creator_identity_id, task.creator_sender_id,
  ])).digest('hex');
}
function currentScope(task: Task, groups: Groups): MemoryStateScope | null {
  const group = groups[task.chat_jid];
  if (!group?.isMain || group.folder !== task.group_folder ||
      task.creator_authorization !== 'owner_sender' ||
      !task.creator_identity_id || !task.creator_sender_id) return null;
  const owners = loadOwnerAllowlistFromEnv().telegram_user_ids;
  if (owners.size && !owners.has(task.creator_sender_id)) return null;
  const tenant = TenantRegistry.fromRegisteredGroups(groups).resolveTelegramJid(task.chat_jid);
  if (!tenant || tenant.folder !== task.group_folder) return null;
  return { chatJid: task.chat_jid, tenantId: tenant.tenant_id,
    identityId: task.creator_identity_id };
}

/** Called only after consuming an exact owner task-operation grant. No prompt inference. */
export function validateScheduledMemoryBinding(
  db: Database.Database, task: Task, projectKey: unknown, groups: Groups,
  actor: { sourceGroup: string; creatorIdentityId: string; creatorSenderId: string },
): MemoryStateScope {
  if (actor.sourceGroup !== task.group_folder ||
      actor.creatorIdentityId !== task.creator_identity_id ||
      actor.creatorSenderId !== task.creator_sender_id)
    throw new Error('memory_task_owner_scope_mismatch');
  const scope = currentScope(task, groups);
  if (!scope) throw new Error('memory_task_owner_scope_unavailable');
  if (projectKey === null) return scope;
  if (typeof projectKey !== 'string' || !PROJECT_KEY.test(projectKey))
    throw new Error('memory_project_key_invalid');
  // Do not initialize a memory store or fall back to another chat on a miss.
  if (!getMemoryProject(db, scope, projectKey)?.project)
    throw new Error('memory_project_missing_in_current_scope');
  return scope;
}

export function bindScheduledMemoryRead(
  db: Database.Database, task: Task, projectKey: string | null, scope: MemoryStateScope,
): void {
  if (projectKey === null) {
    if (tableExists(db)) db.prepare('DELETE FROM memory_task_read_bindings WHERE task_id=?').run(task.id);
    return;
  }
  db.exec(`CREATE TABLE IF NOT EXISTS memory_task_read_bindings (
    task_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL,
    group_folder TEXT NOT NULL, chat_jid TEXT NOT NULL, tenant_id TEXT NOT NULL,
    identity_id TEXT NOT NULL, sender_id TEXT NOT NULL, project_key TEXT NOT NULL,
    binding_id TEXT NOT NULL)`);
  db.prepare(`INSERT INTO memory_task_read_bindings VALUES (?,?,1,?,?,?,?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET fingerprint=excluded.fingerprint,
    revision=memory_task_read_bindings.revision+1, group_folder=excluded.group_folder,
    chat_jid=excluded.chat_jid, tenant_id=excluded.tenant_id,
    identity_id=excluded.identity_id, sender_id=excluded.sender_id,
    project_key=excluded.project_key, binding_id=excluded.binding_id`)
    .run(task.id, scheduledMemoryTaskFingerprint(task), task.group_folder, task.chat_jid,
      scope.tenantId, scope.identityId, task.creator_sender_id, projectKey, randomUUID());
}

export type ScheduledMemoryPreparation =
  | { status: 'unbound'; capability?: undefined; context: '' }
  | { status: 'unavailable'; capability?: undefined; context: ''; reason: string }
  | { status: 'ready'; capability: string; context: string; projectKey: string; projectRevision: number };

/** Per-run bounded read grant; current DB/config is checked again for EVERY request. */
export function prepareScheduledMemoryRead(
  db: Database.Database, task: ScheduledTask, registeredGroups: () => Groups,
): ScheduledMemoryPreparation {
  const saved = binding(db, task.id);
  if (!saved) return { status: 'unbound', context: '' };
  try {
    const scope = currentScope(task, registeredGroups());
    if (!scope || saved.fingerprint !== scheduledMemoryTaskFingerprint(task) ||
        saved.group_folder !== task.group_folder || saved.chat_jid !== scope.chatJid ||
        saved.tenant_id !== scope.tenantId || saved.identity_id !== scope.identityId ||
        saved.sender_id !== task.creator_sender_id)
      throw new Error('scheduled_memory_binding_stale_or_revoked');
    const project = getMemoryProject(db, scope, saved.project_key)?.project;
    if (!project) throw new Error('scheduled_memory_project_missing');
    const revision = memoryProjectRevisionFingerprint(db, scope, saved.project_key);
    const validateCurrent = (): string | null => {
      const freshTask = db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(task.id) as ScheduledTask | undefined;
      const freshBinding = binding(db, task.id);
      if (!freshTask || freshTask.status !== 'active' ||
          scheduledMemoryTaskFingerprint(freshTask) !== saved.fingerprint ||
          !freshBinding || freshBinding.revision !== saved.revision ||
          freshBinding.binding_id !== saved.binding_id ||
          freshBinding.project_key !== saved.project_key ||
          freshBinding.fingerprint !== saved.fingerprint)
        return 'scheduled_memory_task_changed_or_revoked';
      const freshScope = currentScope(freshTask, registeredGroups());
      if (!freshScope || JSON.stringify(freshScope) !== JSON.stringify(scope))
        return 'scheduled_memory_owner_scope_revoked';
      return memoryProjectRevisionFingerprint(db, scope, saved.project_key) === revision
        ? null : 'scheduled_memory_project_revision_changed';
    };
    const listing = listMemoryState(db, scope, { projectKey: saved.project_key, limit: 200 });
    const context = buildStructuredMemoryContext(listing, saved.project_key).context;
    const capability = registerMemoryReadCapability({
      groupFolder: task.group_folder, chatJid: task.chat_jid, isMain: true,
      tenantId: scope.tenantId, senderIdentity: {
        channel: 'telegram', chat_id: TenantRegistry.fromRegisteredGroups(registeredGroups()).resolveTelegramJid(task.chat_jid)!.chat_id,
        telegram_user_id: task.creator_sender_id!, identity_id: scope.identityId,
        is_owner_sender: true,
        // No direct source is invented; the grant's task binding is its authority.
      },
      projectReadScope: { taskId: task.id, projectKey: saved.project_key,
        projectRevision: project.revision, validateCurrent },
    });
    return { status: 'ready', capability, projectKey: saved.project_key,
      projectRevision: project.revision, context };
  } catch (error) {
    return { status: 'unavailable', context: '', reason: error instanceof Error ? error.message : 'scheduled_memory_scope_unavailable' };
  }
}
