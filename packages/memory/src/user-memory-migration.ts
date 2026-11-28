import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import {
  parseTelegramJid,
  telegramJidToBotId,
  defaultTelegramIdentityId,
} from '@skoobi/shared/telegram-jid';
import { safeSharedMemoryKey } from './memory-context.js';

// Структурное подмножество ядрового RegisteredGroup: миграции памяти нужны
// только folder + isMain, а пакеты не импортируют root src. Полный
// RegisteredGroup подходит по структуре — вызывающие ничего не меняют.
export type MemoryMigrationGroup = {
  folder: string;
  isMain?: boolean;
};

export type MemoryMigrationAction =
  | 'keep_as_tenant_memory'
  | 'move_to_shared_uncertain'
  | 'requires_operator_review'
  | 'do_not_migrate';

export type MemoryMigrationRiskLevel = 'low' | 'medium' | 'high';

export interface LegacyMemoryReviewEntry {
  id: string;
  source_file: string;
  source_rel: string;
  folder: string;
  chat_jid: string;
  chat_id: string | null;
  bot_id: string | null;
  tenant_id: string;
  identity_id: string | null;
  file_size_bytes: number;
  last_modified: string;
  has_metadata: boolean;
  likely_scope: 'tenant' | 'sender' | 'group' | 'owner_main' | 'unknown';
  risk_level: MemoryMigrationRiskLevel;
  risks: string[];
  recommendation: MemoryMigrationAction;
  recommended_target_rel: string | null;
  approved: boolean;
  operator_note: string;
}

export interface UserMemoryMigrationManifest {
  schema_version: 1;
  created_at: string;
  mode: 'dry_run_review';
  identity_id: string | null;
  entries: LegacyMemoryReviewEntry[];
  summary: {
    entries_total: number;
    safe_move_candidates: number;
    requires_operator_review: number;
    do_not_migrate: number;
    keep_as_tenant_memory: number;
  };
}

export interface MemoryMigrationApplyResult {
  applied: number;
  skipped: number;
  skipped_reasons: Record<string, number>;
  written_files: string[];
}

interface ReviewOptions {
  rootDir: string;
  groupsDir: string;
  registeredGroups: Record<string, MemoryMigrationGroup>;
  identityId?: string | null;
  now?: Date;
}

interface ApplyOptions {
  groupsDir: string;
  dataDir: string;
  now?: Date;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return (
    rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
  );
}

function walkMarkdownFiles(root: string, out: string[] = []): string[] {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tombstones') continue;
      walkMarkdownFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function hasSkoobiMemoryMetadata(content: string): boolean {
  return /skoobi_memory_meta=({[^]*?})\s*-->/.test(content);
}

function riskPatterns(content: string, rel: string): string[] {
  const haystack = `${rel}\n${content}`;
  const risks: string[] = [];
  const checks: Array<[string, RegExp]> = [
    [
      'secret_or_token_reference',
      /\b(token|secret|api[_-]?key|private key|ssh key|password|oauth|bearer)\b/i,
    ],
    [
      'environment_or_db_reference',
      /(\.env|store\/messages\.db|messages\.db|\.ssh|\.codex|\.claude)/i,
    ],
    [
      'owner_or_admin_context',
      /(owner\/global|owner memory|telegram_main|administrator|admin|to-admin|to_admin|for-admin|for_admin|админ|администратор|администратору)/i,
    ],
    [
      'assistant_guess_or_uncertain_context',
      /(возможно|кажется|предполож|might|maybe|uncertain|guess)/i,
    ],
    [
      'photo_or_image_derived_context',
      /(photo|image|caption|фото|скрин|картинк)/i,
    ],
  ];
  for (const [name, pattern] of checks) {
    if (pattern.test(haystack)) risks.push(name);
  }
  return risks;
}

function riskLevel(risks: string[]): MemoryMigrationRiskLevel {
  if (
    risks.includes('secret_or_token_reference') ||
    risks.includes('environment_or_db_reference') ||
    risks.includes('owner_or_admin_context')
  ) {
    return 'high';
  }
  return risks.length > 0 ? 'medium' : 'low';
}

function recommendationFor(entry: {
  isMain: boolean;
  chatId: string | null;
  identityId: string | null;
  risks: string[];
  level: MemoryMigrationRiskLevel;
}): MemoryMigrationAction {
  if (
    entry.risks.includes('secret_or_token_reference') ||
    entry.risks.includes('environment_or_db_reference')
  ) {
    return 'do_not_migrate';
  }
  if (entry.isMain || entry.risks.includes('owner_or_admin_context')) {
    return 'requires_operator_review';
  }
  if (!entry.chatId || entry.chatId.startsWith('-') || !entry.identityId) {
    return 'keep_as_tenant_memory';
  }
  if (entry.level === 'high') return 'requires_operator_review';
  return 'move_to_shared_uncertain';
}

function likelyScope(
  group: MemoryMigrationGroup,
  chatId: string | null,
): LegacyMemoryReviewEntry['likely_scope'] {
  if (group.isMain) return 'owner_main';
  if (chatId?.startsWith('-')) return 'group';
  if (chatId && !chatId.startsWith('-')) return 'sender';
  return 'unknown';
}

function targetFor(entry: {
  identityId: string | null;
  folder: string;
  relFromMemoryRoot: string;
  recommendation: MemoryMigrationAction;
}): string | null {
  if (
    !entry.identityId ||
    entry.recommendation !== 'move_to_shared_uncertain'
  ) {
    return null;
  }
  const identityKey = safeSharedMemoryKey(entry.identityId);
  const safeFolder = safeSharedMemoryKey(entry.folder);
  const segments = entry.relFromMemoryRoot.split(/[\\/]+/);
  const safeRel = segments
    .map((part) => safeSharedMemoryKey(part.replace(/\.md$/i, '')) || 'memory')
    .join('/');
  // safeSharedMemoryKey() lowercases and collapses any run of [^a-z0-9_-] to a
  // single '_', so distinct source files (e.g. 'topics/a.b.md', 'topics/a_b.md',
  // 'topics/A B.md') would all sanitize to the same target and the apply step
  // would silently drop every collision after the first (reason 'target_exists').
  // Disambiguate by appending a short hash of the original (pre-sanitized) path
  // so each distinct legacy file keeps a distinct shared-tree target.
  const relHash = createHash('sha256')
    .update(`${entry.folder}\0${entry.relFromMemoryRoot}`)
    .digest('hex')
    .slice(0, 8);
  return path.posix.join(
    'user-memory',
    identityKey,
    'shared',
    'legacy',
    safeFolder,
    `${safeRel}.${relHash}.md`,
  );
}

export function createUserMemoryMigrationManifest(
  opts: ReviewOptions,
): UserMemoryMigrationManifest {
  const rootDir = path.resolve(opts.rootDir);
  const groupsDir = path.resolve(opts.groupsDir);
  const identityFilter = opts.identityId?.trim() || null;
  const entries: LegacyMemoryReviewEntry[] = [];

  for (const [chatJid, group] of Object.entries(opts.registeredGroups)) {
    const parsed = parseTelegramJid(chatJid);
    const chatId = parsed?.chatId ?? null;
    const identityId =
      chatId && !chatId.startsWith('-')
        ? defaultTelegramIdentityId(chatId)
        : null;
    if (identityFilter && identityId !== identityFilter) continue;

    const groupRoot = path.resolve(groupsDir, group.folder);
    const memoryRoot = path.join(groupRoot, 'memory');
    if (!isWithin(groupsDir, groupRoot)) continue;
    for (const file of walkMarkdownFiles(memoryRoot)) {
      const resolved = path.resolve(file);
      if (!isWithin(memoryRoot, resolved)) continue;
      let content = '';
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
        content = fs.readFileSync(resolved, 'utf8');
      } catch {
        continue;
      }
      const sourceRel = path
        .relative(rootDir, resolved)
        .split(path.sep)
        .join('/');
      const relFromMemoryRoot = path
        .relative(memoryRoot, resolved)
        .split(path.sep)
        .join('/');
      const risks = riskPatterns(content, sourceRel);
      if (!hasSkoobiMemoryMetadata(content)) {
        risks.push('missing_provenance_metadata');
      }
      const level = riskLevel(risks);
      const recommendation = recommendationFor({
        isMain: group.isMain === true,
        chatId,
        identityId,
        risks,
        level,
      });
      const target = targetFor({
        identityId,
        folder: group.folder,
        relFromMemoryRoot,
        recommendation,
      });
      const id = createHash('sha256')
        .update(`${chatJid}\0${sourceRel}`)
        .digest('hex')
        .slice(0, 16);
      entries.push({
        id,
        source_file: resolved,
        source_rel: sourceRel,
        folder: group.folder,
        chat_jid: chatJid,
        chat_id: chatId,
        bot_id: telegramJidToBotId(chatJid) ?? null,
        tenant_id: `tg_chat_${(chatId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')}`,
        identity_id: identityId,
        file_size_bytes: stat.size,
        last_modified: new Date(stat.mtimeMs).toISOString(),
        has_metadata: hasSkoobiMemoryMetadata(content),
        likely_scope: likelyScope(group, chatId),
        risk_level: level,
        risks: Array.from(new Set(risks)).sort(),
        recommendation,
        recommended_target_rel: target,
        approved: false,
        operator_note:
          recommendation === 'move_to_shared_uncertain'
            ? 'Review content, then set approved=true to copy as low-confidence shared legacy memory.'
            : 'Manual review required; do not auto-apply.',
      });
    }
  }

  entries.sort((a, b) => a.source_rel.localeCompare(b.source_rel));
  return {
    schema_version: 1,
    created_at: (opts.now || new Date()).toISOString(),
    mode: 'dry_run_review',
    identity_id: identityFilter,
    entries,
    summary: {
      entries_total: entries.length,
      safe_move_candidates: entries.filter(
        (e) => e.recommendation === 'move_to_shared_uncertain',
      ).length,
      requires_operator_review: entries.filter(
        (e) => e.recommendation === 'requires_operator_review',
      ).length,
      do_not_migrate: entries.filter(
        (e) => e.recommendation === 'do_not_migrate',
      ).length,
      keep_as_tenant_memory: entries.filter(
        (e) => e.recommendation === 'keep_as_tenant_memory',
      ).length,
    },
  };
}

function memoryHeader(entry: LegacyMemoryReviewEntry, now: Date): string {
  const meta = {
    source_type: 'legacy_markdown_migration',
    confidence: 0.4,
    provenance: 'present',
    sender_id:
      entry.chat_id && !entry.chat_id.startsWith('-') ? entry.chat_id : null,
    // Migrated notes are written into the SHARED (cross-persona) user-memory
    // tree, so they must not carry a source tenant_id. shouldInjectMemory()
    // (memory-context.ts) hides shared entries whose stamped tenant_id differs
    // from the reading tenant, which would silently break cross-persona sharing
    // for every other persona/tenant of the same identity. Scope stays on
    // identity_id/sender_id instead.
    tenant_id: null,
    identity_id: entry.identity_id,
    bot_id: entry.bot_id,
    persona_id: null,
    migrated_at: now.toISOString(),
    source_file: entry.source_rel,
    source_chat_jid: entry.chat_jid,
  };
  return `<!-- skoobi_memory_meta=${JSON.stringify(meta)} -->\n\n`;
}

function bumpReason(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] || 0) + 1;
}

export function applyUserMemoryMigrationManifest(
  manifest: UserMemoryMigrationManifest,
  opts: ApplyOptions,
): MemoryMigrationApplyResult {
  const groupsDir = path.resolve(opts.groupsDir);
  const dataDir = path.resolve(opts.dataDir);
  const now = opts.now || new Date();
  const result: MemoryMigrationApplyResult = {
    applied: 0,
    skipped: 0,
    skipped_reasons: {},
    written_files: [],
  };

  for (const entry of manifest.entries) {
    if (!entry.approved) {
      result.skipped += 1;
      bumpReason(result.skipped_reasons, 'not_approved');
      continue;
    }
    if (entry.recommendation !== 'move_to_shared_uncertain') {
      result.skipped += 1;
      bumpReason(result.skipped_reasons, 'unsupported_recommendation');
      continue;
    }
    if (!entry.identity_id || !entry.recommended_target_rel) {
      result.skipped += 1;
      bumpReason(result.skipped_reasons, 'missing_target');
      continue;
    }

    const source = path.resolve(entry.source_file);
    if (!isWithin(groupsDir, source)) {
      result.skipped += 1;
      bumpReason(result.skipped_reasons, 'source_outside_groups');
      continue;
    }
    const target = path.resolve(dataDir, entry.recommended_target_rel);
    if (!isWithin(dataDir, target)) {
      result.skipped += 1;
      bumpReason(result.skipped_reasons, 'target_outside_data');
      continue;
    }
    if (fs.existsSync(target)) {
      result.skipped += 1;
      bumpReason(result.skipped_reasons, 'target_exists');
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(source, 'utf8').trim();
    } catch {
      result.skipped += 1;
      bumpReason(result.skipped_reasons, 'source_read_failed');
      continue;
    }
    if (!content) {
      result.skipped += 1;
      bumpReason(result.skipped_reasons, 'empty_source');
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${memoryHeader(entry, now)}${content}\n`, {
      mode: 0o600,
    });
    result.applied += 1;
    result.written_files.push(target);
  }

  return result;
}
