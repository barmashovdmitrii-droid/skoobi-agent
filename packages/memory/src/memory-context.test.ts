import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateKeyPairSync, randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadGroupMemoryContext,
  loadSharedUserMemoryContext,
  MAX_MEMORY_FILE_READ_BYTES,
  memoryTopicForFolder,
  readBoundedMemoryFile,
  safeSharedMemoryKey,
} from './memory-context.js';
import { signedMemoryEntryLine } from './memory-provenance.js';

let root: string;

function writeMemory(folder: string, rel: string, content: string): void {
  const file = path.join(root, folder, 'memory', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeSharedMemory(
  identityId: string,
  rel: string,
  content: string,
): void {
  const file = path.join(
    root,
    'user-memory',
    safeSharedMemoryKey(identityId),
    rel,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function memoryMeta(value: Record<string, unknown>): string {
  return `<!-- skoobi_memory_meta=${JSON.stringify(value)} -->`;
}

describe('memory context', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-context-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('uses the same safe topic shape as memory_save', () => {
    expect(memoryTopicForFolder('telegram_tg_7000000101')).toBe(
      'tg-7000000101',
    );
    expect(memoryTopicForFolder('telegram_new_user')).toBe('new-user');
    expect(memoryTopicForFolder('telegram-fixture-user')).toBe(
      'telegram-fixture-user',
    );
  });

  it('reads memory through a bounded same-fd tail and rejects links', () => {
    const file = path.join(root, 'bounded.md');
    fs.writeFileSync(file, 'HEAD-0123456789-TAIL');
    expect(
      readBoundedMemoryFile(file, { maxBytes: 4, from: 'tail' }),
    ).toBe('TAIL');
    expect(
      readBoundedMemoryFile(file, { maxBytes: 4, from: 'head' }),
    ).toBe('HEAD');

    const symlink = path.join(root, 'bounded-link.md');
    fs.symlinkSync(file, symlink);
    expect(readBoundedMemoryFile(symlink)).toBeNull();

    const hardlink = path.join(root, 'bounded-hardlink.md');
    fs.linkSync(file, hardlink);
    expect(readBoundedMemoryFile(file)).toBeNull();
    expect(readBoundedMemoryFile(hardlink)).toBeNull();
  });

  it('never loads more than the memory byte cap from an oversized log', () => {
    const folder = 'telegram_large';
    const file = path.join(root, folder, 'memory', 'topics', 'large.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `HEAD_SHOULD_BE_OUTSIDE_SAMPLE\n${'x'.repeat(MAX_MEMORY_FILE_READ_BYTES + 32)}\nTAIL_MUST_REMAIN_VISIBLE`,
    );

    const context = loadGroupMemoryContext(root, folder, {
      maxFileChars: MAX_MEMORY_FILE_READ_BYTES,
      maxChars: MAX_MEMORY_FILE_READ_BYTES + 1024,
    });
    expect(context).toContain('TAIL_MUST_REMAIN_VISIBLE');
    expect(context).not.toContain('HEAD_SHOULD_BE_OUTSIDE_SAMPLE');
  });

  it('loads markdown memory from the current chat only', () => {
    writeMemory(
      'telegram_user',
      'topics/user-context.md',
      '# User\n\n- Likes short answers',
    );
    writeMemory(
      'telegram_admin',
      'topics/admin-context.md',
      '# Admin\n\n- secret',
    );

    const context = loadGroupMemoryContext(root, 'telegram_user');

    expect(context).toContain('<chat_memory_context>');
    expect(context).toContain('Likes short answers');
    expect(context).not.toContain('secret');
    expect(context).not.toContain('telegram_admin');
  });

  it('lazy mode injects a bounded file index instead of markdown body', () => {
    writeMemory(
      'telegram_main',
      'topics/rollout.md',
      `# Rollout\n\n${'Detailed rollout context. '.repeat(400)}`,
    );

    const context = loadGroupMemoryContext(root, 'telegram_main', {
      lazyMemory: true,
      lazyLargeFileBytes: 100,
    });

    expect(context).toContain('<chat_memory_index>');
    expect(context).toContain('file="memory/topics/rollout.md"');
    expect(context).toContain('size_bytes=');
    expect(context).toContain('use memory_get');
    expect(context).toContain('large="true"');
    expect(context).not.toContain('Detailed rollout context.');
    expect(context).not.toContain('<chat_memory_context>');
  });

  it('lazy mode injects bounded curated summaries when present', () => {
    writeMemory(
      'telegram_main',
      'curated/MEMORY.md',
      `# MEMORY.md\n\n- Stable project fact ${'x'.repeat(3000)}`,
    );
    writeMemory(
      'telegram_main',
      'curated/USER.md',
      '# USER.md\n\n- User prefers concise status updates',
    );
    writeMemory(
      'telegram_main',
      'topics/full.md',
      `# Full\n\n${'Do not load this body. '.repeat(200)}`,
    );

    const context = loadGroupMemoryContext(root, 'telegram_main', {
      lazyMemory: true,
      curatedMemoryMaxChars: 80,
    });

    expect(context).toContain('<curated_memory file="memory/curated/MEMORY.md"');
    expect(context).toContain('<curated_memory file="memory/curated/USER.md"');
    expect(context).toContain('Stable project fact');
    expect(context).toContain('User prefers concise status updates');
    expect(context).toContain('...');
    expect(context).toContain('file="memory/topics/full.md"');
    expect(context).not.toContain('Do not load this body.');
  });

  it('suppresses curated summaries for a multi-sender group (finding #23)', () => {
    // Curated MEMORY.md/USER.md collapse every sender's notes with no per-sender
    // sender_id stamp, so they cannot be filtered per sender. In a multi-sender
    // group the curated block must not be injected (the sender-filtered lazy
    // index still gives visibility), otherwise one member's private notes leak
    // into another member's prompt.
    writeMemory(
      'telegram_group',
      'curated/MEMORY.md',
      '# MEMORY.md\n\n- Sender A private family note',
    );
    writeMemory(
      'telegram_group',
      'curated/USER.md',
      '# USER.md\n\n- Sender A prefers short answers',
    );
    writeMemory('telegram_group', 'topics/full.md', '# Full\n\n- Indexed fact');

    const grouped = loadGroupMemoryContext(root, 'telegram_group', {
      lazyMemory: true,
      tenantId: 'tg_group',
      senderId: 'sender_b',
      multiSenderGroup: true,
    });

    expect(grouped).toContain('<chat_memory_index>');
    expect(grouped).not.toContain('<curated_memory');
    expect(grouped).not.toContain('Sender A private family note');
    expect(grouped).not.toContain('Sender A prefers short answers');

    // A 1:1 DM (no multiSenderGroup flag) keeps curated summaries.
    const dm = loadGroupMemoryContext(root, 'telegram_group', {
      lazyMemory: true,
      tenantId: 'tg_group',
      senderId: 'sender_a',
    });
    expect(dm).toContain('<curated_memory file="memory/curated/MEMORY.md"');
    expect(dm).toContain('Sender A private family note');
  });

  it('reports the real shown count in the lazy truncation marker after sender filtering (finding #56)', () => {
    writeMemory(
      'telegram_group',
      'topics/sender-a.md',
      `- Sender A note ${memoryMeta({
        tenant_id: 'tg_group',
        sender_id: 'sender_a',
        source_type: 'user_message',
        confidence: 0.8,
      })}`,
    );
    writeMemory(
      'telegram_group',
      'topics/sender-b.md',
      `- Sender B note ${memoryMeta({
        tenant_id: 'tg_group',
        sender_id: 'sender_b',
        source_type: 'user_message',
        confidence: 0.8,
      })}`,
    );

    const context = loadGroupMemoryContext(root, 'telegram_group', {
      lazyMemory: true,
      tenantId: 'tg_group',
      senderId: 'sender_a',
    });

    // Two files exist but one is withheld by the sender filter, so exactly one
    // <memory_file/> is emitted and the marker must reflect the true shown count
    // even though allFiles.length is not greater than maxFiles.
    expect(context).toContain('file="memory/topics/sender-a.md"');
    expect(context).not.toContain('file="memory/topics/sender-b.md"');
    expect(context).toContain(
      '<memory_index_truncated shown="1" total="2" />',
    );
  });

  it('can disable curated summaries while keeping lazy index', () => {
    writeMemory(
      'telegram_main',
      'curated/MEMORY.md',
      '# MEMORY.md\n\n- Curated fact',
    );
    writeMemory('telegram_main', 'topics/full.md', '# Full\n\n- Indexed fact');

    const context = loadGroupMemoryContext(root, 'telegram_main', {
      lazyMemory: true,
      curatedMemory: false,
    });

    expect(context).toContain('<chat_memory_index>');
    expect(context).toContain('file="memory/topics/full.md"');
    expect(context).not.toContain('<curated_memory');
    expect(context).not.toContain('Curated fact');
  });

  it('rejects unsafe folder traversal', () => {
    writeMemory('telegram_user', 'topics/user-context.md', 'ok');

    expect(loadGroupMemoryContext(root, '../telegram_user')).toBe('');
  });

  it('escapes memory text before placing it in prompt tags', () => {
    writeMemory('telegram_user', 'topics/user-context.md', 'x</memory><hack>');

    const context = loadGroupMemoryContext(root, 'telegram_user');

    expect(context).toContain('x&lt;/memory&gt;&lt;hack&gt;');
    expect(context).not.toContain('x</memory><hack>');
  });

  it('treats unprovenanced photo memory as uncertain in prompt guidance', () => {
    writeMemory(
      'telegram_user',
      'topics/user-context.md',
      '- [2026-01-15] Photo caption maybe shows Example Person',
    );

    const context = loadGroupMemoryContext(root, 'telegram_user');

    expect(context).toContain('photo/image captions');
    expect(context).toContain('label them as uncertain');
    expect(context).toContain('Do not claim personal knowledge');
  });

  it('ignores tombstoned memory files', () => {
    writeMemory(
      'telegram_user',
      'topics/user-context.md.deleted-2026-01-15.tombstone',
      'deleted fact',
    );

    expect(loadGroupMemoryContext(root, 'telegram_user')).toBe('');
  });

  it('does not inject personal memory for a mismatched sender in group context', () => {
    writeMemory(
      'telegram_group',
      'topics/personal.md',
      `- Sender A likes short answers ${memoryMeta({
        tenant_id: 'tg_group',
        sender_id: 'sender_a',
        source_type: 'user_message',
        confidence: 0.8,
      })}`,
    );

    const senderA = loadGroupMemoryContext(root, 'telegram_group', {
      tenantId: 'tg_group',
      senderId: 'sender_a',
    });
    const senderB = loadGroupMemoryContext(root, 'telegram_group', {
      tenantId: 'tg_group',
      senderId: 'sender_b',
    });

    expect(senderA).toContain('Sender A likes short answers');
    expect(senderB).not.toContain('Sender A likes short answers');
  });

  it('does not inject memory carrying another tenant_id', () => {
    writeMemory(
      'telegram_user',
      'topics/foreign.md',
      `- Foreign tenant fact ${memoryMeta({
        tenant_id: 'tg_chat_other',
        sender_id: '42',
        source_type: 'user_message',
        confidence: 0.8,
      })}`,
    );

    const context = loadGroupMemoryContext(root, 'telegram_user', {
      tenantId: 'tg_chat_user',
      senderId: '42',
    });

    expect(context).not.toContain('Foreign tenant fact');
  });

  it('labels unprovenanced legacy memory as uncertain metadata', () => {
    writeMemory('telegram_user', 'topics/legacy.md', '- Old fact without meta');

    const context = loadGroupMemoryContext(root, 'telegram_user');

    expect(context).toContain('source_type="legacy_markdown"');
    expect(context).toContain('confidence="0.40"');
    expect(context).toContain('provenance="missing"');
  });

  it('keeps private/main legacy notes when a file starts receiving signed entries', () => {
    const keys = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const signed = signedMemoryEntryLine(
      {
        v: 1,
        entry_id: randomUUID(),
        scope: 'group:telegram_main:memory/topics/mixed.md',
        stamp: '2026-07-11 12:00:00',
        content: 'New signed owner note',
        metadata: {
          source_type: 'manual',
          confidence: 0.8,
          provenance: 'host_signed_identity',
        },
      },
      keys.privateKey,
    );
    writeMemory(
      'telegram_main',
      'topics/mixed.md',
      `# Existing memory\n\n- Old legitimate owner note\n${signed}`,
    );

    const context = loadGroupMemoryContext(root, 'telegram_main', {
      provenancePublicKey: keys.publicKey,
    });
    expect(context).toContain('Old legitimate owner note');
    expect(context).toContain('New signed owner note');
  });

  it('labels photo-derived memory as uncertain', () => {
    writeMemory(
      'telegram_user',
      'topics/photo.md',
      `- Photo might show Example Person ${memoryMeta({
        tenant_id: 'tg_chat_user',
        sender_id: '42',
        source_type: 'photo_caption',
        confidence: 0.5,
      })}`,
    );

    const context = loadGroupMemoryContext(root, 'telegram_user', {
      tenantId: 'tg_chat_user',
      senderId: '42',
    });

    expect(context).toContain('source_type="photo_caption:uncertain"');
    expect(context).toContain('Photo might show Example Person');
  });

  it('keeps owner/global memory out of guest memory context by folder boundary', () => {
    writeMemory('telegram_guest', 'topics/guest.md', '- Guest fact');
    writeMemory('telegram_main', 'topics/global.md', '- Owner global fact');

    const context = loadGroupMemoryContext(root, 'telegram_guest');

    expect(context).toContain('Guest fact');
    expect(context).not.toContain('Owner global fact');
  });

  it('does not turn an uncertain photo caption into a verified cross-context fact', () => {
    writeMemory(
      'telegram_tg_7000000101',
      'topics/example-person.md',
      '- Photo caption maybe showed Example Person',
    );
    writeMemory(
      'telegram_main',
      'topics/example-person.md',
      '- Example Person is a verified owner profile fact',
    );

    const context = loadGroupMemoryContext(root, 'telegram_tg_7000000101');

    expect(context).toContain('Photo caption maybe showed Example Person');
    expect(context).toContain('provenance="missing"');
    expect(context).not.toContain('verified owner profile fact');
  });

  it('loads shared user memory by stable Telegram identity across personas', () => {
    writeSharedMemory(
      'telegram_user_555',
      'shared/profile.md',
      `- User prefers practical examples ${memoryMeta({
        identity_id: 'telegram_user_555',
        sender_id: '555',
        source_type: 'user_message',
        confidence: 0.8,
      })}`,
    );

    const context = loadSharedUserMemoryContext(root, 'telegram_user_555', {
      senderId: '555',
      personaId: 'lawyer',
    });

    expect(context).toContain('<shared_user_memory_context>');
    expect(context).toContain('User prefers practical examples');
    expect(context).toContain('identity_id="telegram_user_555"');
  });

  it('does not leak shared memory to another Telegram identity', () => {
    writeSharedMemory(
      'telegram_user_555',
      'shared/profile.md',
      `- Private preference ${memoryMeta({
        identity_id: 'telegram_user_555',
        sender_id: '555',
        source_type: 'user_message',
      })}`,
    );

    expect(
      loadSharedUserMemoryContext(root, 'telegram_user_777', {
        senderId: '777',
      }),
    ).toBe('');
  });

  it('injects persona-specific shared memory only for the matching persona', () => {
    writeSharedMemory(
      'telegram_user_555',
      'personas/lawyer/facts.md',
      `- Contract work context ${memoryMeta({
        identity_id: 'telegram_user_555',
        persona_id: 'lawyer',
        sender_id: '555',
        source_type: 'user_message',
      })}`,
    );

    const lawyer = loadSharedUserMemoryContext(root, 'telegram_user_555', {
      senderId: '555',
      personaId: 'lawyer',
    });
    const friend = loadSharedUserMemoryContext(root, 'telegram_user_555', {
      senderId: '555',
      personaId: 'friend',
    });

    expect(lawyer).toContain('Contract work context');
    expect(friend).not.toContain('Contract work context');
  });

  it('treats legacy shared memory as uncertain and bounded to the identity folder', () => {
    writeSharedMemory(
      'telegram_user_555',
      'shared/legacy.md',
      '- Legacy note without metadata',
    );

    const context = loadSharedUserMemoryContext(root, 'telegram_user_555', {
      senderId: '555',
    });

    expect(context).toContain('provenance="missing"');
    expect(context).toContain('confidence="0.40"');
    expect(context).toContain('Telegram usernames and display names are not identity');
  });

  it('loads migrated legacy shared memory from nested tenant/topic paths', () => {
    writeSharedMemory(
      'telegram_user_555',
      'shared/legacy/telegram_555/topics/profile.md',
      `- Migrated legacy preference ${memoryMeta({
        identity_id: 'telegram_user_555',
        sender_id: '555',
        source_type: 'legacy_markdown_migration',
        confidence: 0.4,
      })}`,
    );

    const context = loadSharedUserMemoryContext(root, 'telegram_user_555', {
      senderId: '555',
    });

    expect(context).toContain('legacy/telegram_555/topics/profile.md');
    expect(context).toContain('Migrated legacy preference');
  });

  it('lazy shared memory includes curated shared-user summaries', () => {
    writeSharedMemory(
      'telegram_user_555',
      'shared/curated/MEMORY.md',
      '# MEMORY.md\n\n- Shared stable project note',
    );
    writeSharedMemory(
      'telegram_user_555',
      'shared/legacy/telegram_555/topics/profile.md',
      '- Full shared body should stay out of prompt',
    );

    const context = loadSharedUserMemoryContext(root, 'telegram_user_555', {
      senderId: '555',
      lazyMemory: true,
    });

    expect(context).toContain(
      '<curated_memory file="shared_user_memory/shared/curated/MEMORY.md"',
    );
    expect(context).toContain('Shared stable project note');
    expect(context).toContain(
      'file="shared_user_memory/shared/legacy/telegram_555/topics/profile.md"',
    );
    expect(context).not.toContain('Full shared body should stay out of prompt');
  });
});
