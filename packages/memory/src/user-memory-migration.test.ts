import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  applyUserMemoryMigrationManifest,
  createUserMemoryMigrationManifest,
  type MemoryMigrationGroup,
} from './user-memory-migration.js';

// Фикстура в форме ядрового RegisteredGroup (пакет не импортирует root src);
// самим функциям миграции по контракту нужен только MemoryMigrationGroup.
type RegisteredGroupFixture = MemoryMigrationGroup & {
  name: string;
  trigger: string;
  added_at: string;
  requiresTrigger?: boolean;
};

function group(folder: string, isMain = false): RegisteredGroupFixture {
  return {
    name: folder,
    folder,
    trigger: '@Skoobi',
    added_at: '2026-05-22T00:00:00.000Z',
    requiresTrigger: false,
    isMain: isMain ? true : undefined,
  };
}

function writeMemory(
  root: string,
  folder: string,
  rel: string,
  content: string,
): string {
  const file = path.join(root, 'groups', folder, 'memory', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe('user memory migration review', () => {
  it('creates a dry-run manifest without moving legacy files automatically', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-memory-migration-'),
    );
    try {
      writeMemory(
        root,
        'telegram_user',
        'topics/profile.md',
        '- Prefers practical examples.',
      );
      writeMemory(
        root,
        'telegram_group',
        'topics/group.md',
        '- Group context.',
      );
      writeMemory(
        root,
        'telegram_sensitive',
        'topics/secret.md',
        '- Mentions .env and api key.',
      );
      writeMemory(
        root,
        'telegram_main',
        'topics/admin.md',
        '- Admin operational context.',
      );
      writeMemory(
        root,
        'telegram_user',
        'topics/user-to-admin.md',
        '- Please pass this private note to admin.',
      );

      const manifest = createUserMemoryMigrationManifest({
        rootDir: root,
        groupsDir: path.join(root, 'groups'),
        registeredGroups: {
          'tg:111': group('telegram_user'),
          'tg:-100123': group('telegram_group'),
          'tg:222': group('telegram_sensitive'),
          'tg:333': group('telegram_main', true),
        },
        now: new Date('2026-05-22T00:00:00.000Z'),
      });

      expect(manifest.summary.entries_total).toBe(5);
      const user = manifest.entries.find((entry) =>
        entry.source_rel.endsWith('telegram_user/memory/topics/profile.md'),
      );
      expect(user).toMatchObject({
        identity_id: 'telegram_user_111',
        recommendation: 'move_to_shared_uncertain',
        approved: false,
      });
      expect(user?.recommended_target_rel).toContain(
        'user-memory/telegram_user_111/shared/legacy/telegram_user',
      );

      const groupEntry = manifest.entries.find((entry) =>
        entry.source_rel.endsWith('telegram_group/memory/topics/group.md'),
      );
      expect(groupEntry?.recommendation).toBe('keep_as_tenant_memory');

      const sensitive = manifest.entries.find((entry) =>
        entry.source_rel.endsWith('telegram_sensitive/memory/topics/secret.md'),
      );
      expect(sensitive?.recommendation).toBe('do_not_migrate');

      const owner = manifest.entries.find((entry) =>
        entry.source_rel.endsWith('telegram_main/memory/topics/admin.md'),
      );
      expect(owner?.recommendation).toBe('requires_operator_review');

      const handoff = manifest.entries.find((entry) =>
        entry.source_rel.endsWith(
          'telegram_user/memory/topics/user-to-admin.md',
        ),
      );
      expect(handoff?.risks).toContain('owner_or_admin_context');
      expect(handoff?.recommendation).toBe('requires_operator_review');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies only approved safe entries and preserves source memory', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-memory-migration-'),
    );
    try {
      const source = writeMemory(
        root,
        'telegram_user',
        'topics/profile.md',
        '- Prefers practical examples.',
      );
      const manifest = createUserMemoryMigrationManifest({
        rootDir: root,
        groupsDir: path.join(root, 'groups'),
        registeredGroups: {
          'tg:111': group('telegram_user'),
        },
        now: new Date('2026-05-22T00:00:00.000Z'),
      });

      const dry = applyUserMemoryMigrationManifest(manifest, {
        groupsDir: path.join(root, 'groups'),
        dataDir: path.join(root, 'data'),
        now: new Date('2026-05-22T00:01:00.000Z'),
      });
      expect(dry.applied).toBe(0);
      expect(dry.skipped_reasons.not_approved).toBe(1);

      manifest.entries[0].approved = true;
      const applied = applyUserMemoryMigrationManifest(manifest, {
        groupsDir: path.join(root, 'groups'),
        dataDir: path.join(root, 'data'),
        now: new Date('2026-05-22T00:02:00.000Z'),
      });

      expect(applied.applied).toBe(1);
      expect(fs.existsSync(source)).toBe(true);
      const target = applied.written_files[0];
      const targetContent = fs.readFileSync(target, 'utf8');
      expect(target).toContain(
        'data/user-memory/telegram_user_111/shared/legacy',
      );
      expect(targetContent).toContain('skoobi_memory_meta=');
      expect(targetContent).toContain('"identity_id":"telegram_user_111"');
      expect(targetContent).toContain('- Prefers practical examples.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('disambiguates source files whose sanitized names collide so none are dropped', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-memory-migration-'),
    );
    try {
      // Both names sanitize to 'topics/a_b' via safeSharedMemoryKey (which
      // collapses any run of [^a-z0-9_-] to '_'); without disambiguation they
      // map to the same shared target and the second silently drops.
      writeMemory(root, 'telegram_user', 'topics/a.b.md', '- ALPHA note.');
      writeMemory(root, 'telegram_user', 'topics/a_b.md', '- BETA note.');

      const manifest = createUserMemoryMigrationManifest({
        rootDir: root,
        groupsDir: path.join(root, 'groups'),
        registeredGroups: {
          'tg:111': group('telegram_user'),
        },
        now: new Date('2026-05-22T00:00:00.000Z'),
      });

      const movable = manifest.entries.filter(
        (entry) => entry.recommendation === 'move_to_shared_uncertain',
      );
      expect(movable.length).toBe(2);

      // The two distinct source files must NOT collapse to one target.
      const targets = movable.map((entry) => entry.recommended_target_rel);
      expect(new Set(targets).size).toBe(2);

      for (const entry of manifest.entries) entry.approved = true;
      const applied = applyUserMemoryMigrationManifest(manifest, {
        groupsDir: path.join(root, 'groups'),
        dataDir: path.join(root, 'data'),
        now: new Date('2026-05-22T00:02:00.000Z'),
      });

      // Both distinct notes land in the shared tree; neither is dropped as
      // 'target_exists'.
      expect(applied.applied).toBe(2);
      expect(applied.skipped_reasons.target_exists).toBeUndefined();
      expect(new Set(applied.written_files).size).toBe(2);

      const bodies = applied.written_files.map((file) =>
        fs.readFileSync(file, 'utf8'),
      );
      expect(bodies.some((body) => body.includes('- ALPHA note.'))).toBe(true);
      expect(bodies.some((body) => body.includes('- BETA note.'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stamps tenant_id:null on shared migrations so other personas/tenants can read them', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-memory-migration-'),
    );
    try {
      writeMemory(
        root,
        'telegram_user',
        'topics/profile.md',
        '- Prefers practical examples.',
      );
      const manifest = createUserMemoryMigrationManifest({
        rootDir: root,
        groupsDir: path.join(root, 'groups'),
        registeredGroups: {
          'tg:111': group('telegram_user'),
        },
        now: new Date('2026-05-22T00:00:00.000Z'),
      });

      // Source review entry still carries a source-tenant id for provenance.
      expect(manifest.entries[0].tenant_id).toBe('tg_chat_111');

      manifest.entries[0].approved = true;
      const applied = applyUserMemoryMigrationManifest(manifest, {
        groupsDir: path.join(root, 'groups'),
        dataDir: path.join(root, 'data'),
        now: new Date('2026-05-22T00:02:00.000Z'),
      });
      expect(applied.applied).toBe(1);

      const targetContent = fs.readFileSync(applied.written_files[0], 'utf8');
      const meta = JSON.parse(
        targetContent.match(/skoobi_memory_meta=({[^]*?})\s*-->/)![1],
      );

      // The content lives in the SHARED (cross-persona) tree, so it must NOT
      // be stamped with a concrete tenant_id; otherwise shouldInjectMemory()
      // hides it from every other persona/tenant of the same identity.
      expect(meta.tenant_id).toBeNull();
      // Cross-persona scoping keys are preserved.
      expect(meta.identity_id).toBe('telegram_user_111');
      expect(meta.sender_id).toBe('111');
      // Regression guard: the source-tenant id must not leak onto the stamp.
      expect(meta.tenant_id).not.toBe('tg_chat_111');

      // Mirror memory-context.ts shouldInjectMemory() tenant gate: a different
      // reading tenant must still see the shared note.
      const tenantGateHides =
        meta.tenant_id &&
        'tg_chat_999' &&
        meta.tenant_id !== 'tg_chat_999';
      expect(tenantGateHides).toBeFalsy();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
