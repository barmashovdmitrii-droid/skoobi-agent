import fs from 'fs';
import path from 'path';

import { escapeXml } from '@skoobi/shared';

import { extractVerifiedMemoryEntries } from './memory-provenance.js';

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_MAX_FILE_CHARS = 1500;
const DEFAULT_SHARED_MAX_FILES = 6;
const DEFAULT_SHARED_MAX_CHARS = 4000;
const DEFAULT_LAZY_MAX_FILES = 80;
const DEFAULT_LAZY_LARGE_FILE_BYTES = 24 * 1024;
const DEFAULT_CURATED_MEMORY_CHARS = 2200;
const DEFAULT_CURATED_USER_CHARS = 1375;
export const MAX_MEMORY_FILE_READ_BYTES = 2 * 1024 * 1024;
const MAX_CURATED_FILE_READ_BYTES = 256 * 1024;

type MemoryMetadata = {
  source_type: string;
  confidence: number;
  provenance: 'present' | 'missing' | 'host_signed_identity';
  sender_id: string | null;
  tenant_id: string | null;
  identity_id: string | null;
  persona_id: string | null;
  bot_id: string | null;
};

export type MemoryContextOptions = {
  maxFiles?: number;
  maxChars?: number;
  maxFileChars?: number;
  senderId?: string | null;
  tenantId?: string | null;
  identityId?: string | null;
  personaId?: string | null;
  lazyMemory?: boolean;
  curatedMemory?: boolean;
  curatedMemoryMaxChars?: number;
  curatedUserMaxChars?: number;
  lazyMaxFiles?: number;
  lazyLargeFileBytes?: number;
  // SECURITY (finding #23): true when this read is for a multi-sender group
  // chat (e.g. a negative-chat-id Telegram group with several distinct
  // senders). Curated MEMORY.md/USER.md summaries are produced by collapsing
  // EVERY *.md under the group's memory root — including per-sender topics —
  // and the curator strips the skoobi_memory_meta comment, so curated bullets
  // carry no sender_id and cannot be filtered per-sender. Injecting them into a
  // group would fold one member's private notes into another member's prompt,
  // silently defeating the per-sender shouldInjectMemory isolation that the
  // file index enforces. When this is set, curated injection is suppressed.
  multiSenderGroup?: boolean;
  /** Host-generated Ed25519 public key used to verify per-entry provenance. */
  provenancePublicKey?: string;
  /** Fail closed instead of treating unsigned markdown as legacy memory. */
  requireSignedEntries?: boolean;
};

export function memoryTopicForFolder(folder: string): string {
  const base = folder.replace(/^telegram_/, '');
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'chat'
  );
}

function isSafeGroupFolder(folder: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(folder);
}

export function safeSharedMemoryKey(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'unknown'
  );
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return (
    rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
  );
}

/**
 * Read guest-writable memory through one verified descriptor with a hard cap.
 * Large append-only logs are sampled from the tail so recent entries and the
 * last provenance marker remain useful without ever materializing the whole
 * file. Curated summaries use the head because their stable digest is bounded
 * and begins at the top of the file.
 */
export function readBoundedMemoryFile(
  file: string,
  options: { maxBytes?: number; from?: 'head' | 'tail' } = {},
): string | null {
  const maxBytes = Math.max(
    1,
    Math.min(
      MAX_MEMORY_FILE_READ_BYTES,
      Math.trunc(options.maxBytes ?? MAX_MEMORY_FILE_READ_BYTES),
    ),
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0),
    );
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < 0) return null;
    const length = Math.min(before.size, maxBytes);
    if (length === 0) return '';
    const start =
      options.from === 'head' ? 0 : Math.max(0, before.size - length);
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        offset,
        length - offset,
        start + offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fs.fstatSync(fd);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.gid !== before.gid ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      !after.isFile() ||
      after.nlink !== 1
    ) {
      return null;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
}

function markdownFiles(root: string, depth = 0): string[] {
  if (depth > 5) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(full, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

function normalizeMemoryMetadata(raw: unknown): MemoryMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      source_type: 'legacy_markdown',
      confidence: 0.4,
      provenance: 'missing',
      sender_id: null,
      tenant_id: null,
      identity_id: null,
      persona_id: null,
      bot_id: null,
    };
  }
  const record = raw as Record<string, unknown>;
  const sourceType =
    typeof record.source_type === 'string' && record.source_type.trim()
      ? record.source_type.trim()
      : 'legacy_markdown';
  const confidence = Number(record.confidence);
  return {
    source_type: sourceType,
    confidence: Number.isFinite(confidence)
      ? Math.min(1, Math.max(0, confidence))
      : sourceType === 'legacy_markdown'
        ? 0.4
        : 0.6,
    provenance:
      record.provenance === 'host_signed_identity'
        ? 'host_signed_identity'
        : 'present',
    sender_id:
      typeof record.sender_id === 'string' && record.sender_id.trim()
        ? record.sender_id.trim()
        : null,
    tenant_id:
      typeof record.tenant_id === 'string' && record.tenant_id.trim()
        ? record.tenant_id.trim()
        : null,
    identity_id:
      typeof record.identity_id === 'string' && record.identity_id.trim()
        ? record.identity_id.trim()
        : null,
    persona_id:
      typeof record.persona_id === 'string' && record.persona_id.trim()
        ? record.persona_id.trim()
        : null,
    bot_id:
      typeof record.bot_id === 'string' && record.bot_id.trim()
        ? record.bot_id.trim()
        : null,
  };
}

type MemoryScopeForRel = (rel: string) => string;

function trustedFileView(
  content: string,
  rel: string,
  opts: MemoryContextOptions,
  scopeForRel?: MemoryScopeForRel,
): { content: string; metadata: MemoryMetadata } | null {
  if (opts.provenancePublicKey && scopeForRel) {
    const verified = extractVerifiedMemoryEntries(
      content,
      opts.provenancePublicKey,
      scopeForRel(rel),
    );
    if (verified.length > 0) {
      const matching = verified
        .map((entry) => ({
          entry,
          metadata: normalizeMemoryMetadata(entry.payload.metadata),
        }))
        .filter(({ metadata }) => {
          if (
            opts.requireSignedEntries &&
            (!opts.senderId ||
              !opts.tenantId ||
              !opts.identityId ||
              !metadata.sender_id ||
              !metadata.tenant_id ||
              !metadata.identity_id)
          ) {
            return false;
          }
          return shouldInjectMemory(metadata, opts);
        });
      const visibleParts = matching.map(
        ({ entry }) => `- [${entry.payload.stamp}] ${entry.payload.content}`,
      );
      let fallbackMetadata: MemoryMetadata | null = null;
      if (!opts.requireSignedEntries) {
        // Private/owner roots keep pre-v2 notes during migration. New signed
        // entries are deliberately one physical line, so remove every such
        // line and apply the legacy file-level rules only to the remainder.
        const legacyContent = content
          .split('\n')
          .filter((line) => !line.includes('skoobi_memory_v2='))
          .join('\n')
          .trim();
        if (legacyContent) {
          const legacyMetadata = extractMemoryMetadata(legacyContent);
          if (shouldInjectMemory(legacyMetadata, opts)) {
            visibleParts.unshift(legacyContent);
            fallbackMetadata = legacyMetadata;
          }
        }
      }
      if (visibleParts.length === 0) return null;
      return {
        content: visibleParts.join('\n'),
        metadata: matching[0]?.metadata || fallbackMetadata!,
      };
    }
  }
  if (opts.requireSignedEntries) return null;
  const metadata = extractMemoryMetadata(content);
  if (!shouldInjectMemory(metadata, opts)) return null;
  return { content, metadata };
}

function extractMemoryMetadata(content: string): MemoryMetadata {
  // Use the LAST marker, not the first. memory_save always appends the real
  // `<!-- skoobi_memory_meta={…} -->` at the END of an entry, AFTER the
  // (untrusted) content, so the last marker in the file is always a
  // server-written one. A first-match let a guest embed a forged marker inside
  // the content of a new entry and shadow the real trailing stamp to spoof
  // sender/tenant/identity scope (ultra-review 2026-07-11 #9).
  const all = [...content.matchAll(/skoobi_memory_meta=({[^]*?})\s*-->/g)];
  if (all.length === 0) return normalizeMemoryMetadata(null);
  try {
    return normalizeMemoryMetadata(JSON.parse(all[all.length - 1][1]));
  } catch {
    return normalizeMemoryMetadata(null);
  }
}

function shouldInjectMemory(
  metadata: MemoryMetadata,
  opts: MemoryContextOptions,
): boolean {
  if (
    metadata.tenant_id &&
    opts.tenantId &&
    metadata.tenant_id !== opts.tenantId
  ) {
    return false;
  }
  if (
    metadata.sender_id &&
    opts.senderId &&
    metadata.sender_id !== opts.senderId
  ) {
    return false;
  }
  if (
    metadata.identity_id &&
    opts.identityId &&
    metadata.identity_id !== opts.identityId
  ) {
    return false;
  }
  if (
    metadata.persona_id &&
    opts.personaId &&
    metadata.persona_id !== opts.personaId
  ) {
    return false;
  }
  return true;
}

function memorySourceType(metadata: MemoryMetadata): string {
  return metadata.source_type === 'photo_caption' ||
    metadata.source_type === 'image'
    ? `${metadata.source_type}:uncertain`
    : metadata.source_type;
}

function memorySectionsFromRoot(
  memoryRoot: string,
  opts: MemoryContextOptions,
  scopeForRel?: MemoryScopeForRel,
): string[] {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxFileChars = opts.maxFileChars ?? DEFAULT_MAX_FILE_CHARS;

  const files = markdownFiles(memoryRoot)
    .map((file) => {
      try {
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item): item is { file: string; mtimeMs: number } => Boolean(item))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles);

  const sections: string[] = [];
  let used = 0;
  for (const { file } of files) {
    const resolved = path.resolve(file);
    if (!isWithin(memoryRoot, resolved)) continue;
    let content: string;
    try {
      content = (
        readBoundedMemoryFile(resolved, { from: 'tail' }) || ''
      ).trim();
    } catch {
      continue;
    }
    if (!content) continue;
    const rel = path.relative(memoryRoot, resolved).split(path.sep).join('/');
    const trusted = trustedFileView(content, rel, opts, scopeForRel);
    if (!trusted) continue;
    content = trusted.content;
    const metadata = trusted.metadata;
    if (content.length > maxFileChars) {
      content = `${content.slice(0, maxFileChars).trimEnd()}\n...`;
    }

    const section = `<memory file="${escapeXml(rel)}" source_type="${escapeXml(memorySourceType(metadata))}" confidence="${metadata.confidence.toFixed(2)}" provenance="${metadata.provenance}" sender_id="${escapeXml(metadata.sender_id || '')}" identity_id="${escapeXml(metadata.identity_id || '')}" persona_id="${escapeXml(metadata.persona_id || '')}">\n${escapeXml(content)}\n</memory>`;
    if (used + section.length > maxChars) break;
    sections.push(section);
    used += section.length;
  }

  return sections;
}

function markdownFileStats(
  root: string,
  depth = 0,
): Array<{
  file: string;
  rel: string;
  sizeBytes: number;
  mtimeMs: number;
}> {
  if (depth > 5) return [];
  const rootReal = fs.realpathSync(root);
  const files = markdownFiles(rootReal)
    .map((file) => {
      try {
        const resolved = fs.realpathSync(file);
        if (!isWithin(rootReal, resolved)) return null;
        const stat = fs.statSync(resolved);
        return {
          file: resolved,
          rel: path.relative(rootReal, resolved).split(path.sep).join('/'),
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter(
      (
        item,
      ): item is {
        file: string;
        rel: string;
        sizeBytes: number;
        mtimeMs: number;
      } => Boolean(item),
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

function memoryIndexSectionsFromRoot(
  memoryRoot: string,
  opts: MemoryContextOptions,
  labelFile: (relFromRoot: string) => string,
  scopeForRel?: MemoryScopeForRel,
): string[] {
  const maxFiles = opts.lazyMaxFiles ?? DEFAULT_LAZY_MAX_FILES;
  const largeFileBytes =
    opts.lazyLargeFileBytes ?? DEFAULT_LAZY_LARGE_FILE_BYTES;
  const allFiles = markdownFileStats(memoryRoot);
  const files = allFiles.slice(0, maxFiles);
  const sections: string[] = [];

  for (const file of files) {
    let trusted: { content: string; metadata: MemoryMetadata } | null = null;
    try {
      const content = readBoundedMemoryFile(file.file, { from: 'tail' });
      trusted = content
        ? trustedFileView(content, file.rel, opts, scopeForRel)
        : null;
    } catch {
      // Metadata is best-effort; lazy index must never block agent startup.
    }
    if (!trusted) continue;
    const metadata = trusted.metadata;
    const label = labelFile(file.rel);
    const modified = new Date(file.mtimeMs).toISOString();
    const sizeLabel =
      file.sizeBytes >= 1024
        ? `${(file.sizeBytes / 1024).toFixed(1)} KiB`
        : `${file.sizeBytes} B`;
    const largeHint =
      file.sizeBytes >= largeFileBytes
        ? ' large="true" note="large file not loaded; use memory_get for exact details"'
        : '';

    sections.push(
      `<memory_file file="${escapeXml(label)}" size_bytes="${file.sizeBytes}" size="${escapeXml(sizeLabel)}" modified="${modified}" source_type="${escapeXml(memorySourceType(metadata))}" confidence="${metadata.confidence.toFixed(2)}" provenance="${metadata.provenance}" sender_id="${escapeXml(metadata.sender_id || '')}" identity_id="${escapeXml(metadata.identity_id || '')}" persona_id="${escapeXml(metadata.persona_id || '')}"${largeHint} />`,
    );
  }

  // CORRECTNESS (finding #56): report the count actually emitted, not maxFiles.
  // After the top-maxFiles slice we drop any file whose metadata fails
  // shouldInjectMemory, so sections.length can be < maxFiles. Reporting
  // shown=maxFiles overstated visibility, and emitting the marker only when
  // allFiles.length > maxFiles meant the model was told nothing was withheld
  // even when sender/tenant-scoped files were filtered out of a small set.
  // Emit the marker whenever fewer sections were shown than files exist
  // (whether due to the maxFiles cap or isolation filtering), with the true
  // shown count.
  if (sections.length < allFiles.length) {
    sections.push(
      `<memory_index_truncated shown="${sections.length}" total="${allFiles.length}" />`,
    );
  }

  return sections;
}

function curatedFileSectionsFromRoot(
  root: string,
  opts: MemoryContextOptions,
  labelFile: (file: 'MEMORY.md' | 'USER.md') => string,
): string[] {
  if (opts.curatedMemory === false) return [];
  // SECURITY (finding #23): curated summaries are an undivided digest of every
  // sender's notes in this memory root with no per-sender sender_id stamp, so
  // there is no way to keep one group member's private bullets out of another
  // member's prompt. For multi-sender group chats we therefore refuse to inject
  // the curated block at all — the lazy file index (which IS sender-filtered via
  // shouldInjectMemory) still gives the agent visibility. 1:1 DMs and the
  // single-identity shared-user trees do not set this flag and keep curated
  // summaries.
  if (opts.multiSenderGroup) return [];
  const curatedRoot = path.join(root, 'curated');
  let curatedRootReal: string;
  try {
    curatedRootReal = fs.realpathSync(curatedRoot);
  } catch {
    return [];
  }
  const sections: string[] = [];
  const files: Array<{
    name: 'MEMORY.md' | 'USER.md';
    maxChars: number;
  }> = [
    {
      name: 'MEMORY.md',
      maxChars: opts.curatedMemoryMaxChars ?? DEFAULT_CURATED_MEMORY_CHARS,
    },
    {
      name: 'USER.md',
      maxChars: opts.curatedUserMaxChars ?? DEFAULT_CURATED_USER_CHARS,
    },
  ];
  for (const file of files) {
    let resolved: string;
    try {
      resolved = fs.realpathSync(path.join(curatedRootReal, file.name));
    } catch {
      continue;
    }
    if (!isWithin(curatedRootReal, resolved)) continue;
    let content = '';
    try {
      content = (
        readBoundedMemoryFile(resolved, {
          from: 'head',
          maxBytes: MAX_CURATED_FILE_READ_BYTES,
        }) || ''
      ).trim();
    } catch {
      continue;
    }
    if (!content) continue;
    // SECURITY (finding #23): defense in depth. Today's curator strips the
    // skoobi_memory_meta stamp from bullets and writes a header with no
    // sender/tenant/identity/persona scope, so this is a no-op for current
    // curated files. But if a future curator ever stamps a curated summary with
    // a sender_id/tenant_id/etc., honor the same isolation boundary as the file
    // index so the scoped summary is never read by a non-matching sender.
    if (!shouldInjectMemory(extractMemoryMetadata(content), opts)) continue;
    if (content.length > file.maxChars) {
      content = `${content.slice(0, file.maxChars).trimEnd()}\n...`;
    }
    sections.push(
      `<curated_memory file="${escapeXml(labelFile(file.name))}" max_chars="${file.maxChars}">\n${escapeXml(content)}\n</curated_memory>`,
    );
  }
  return sections;
}

export function loadGroupMemoryContext(
  groupsDir: string,
  groupFolder: string,
  opts: MemoryContextOptions = {},
): string {
  if (!isSafeGroupFolder(groupFolder)) return '';

  let groupsRoot: string;
  let groupRoot: string;
  try {
    groupsRoot = fs.realpathSync(path.resolve(groupsDir));
    groupRoot = fs.realpathSync(path.join(groupsRoot, groupFolder));
  } catch {
    return '';
  }
  if (!isWithin(groupsRoot, groupRoot)) return '';

  let memoryRoot: string;
  try {
    memoryRoot = fs.realpathSync(path.join(groupRoot, 'memory'));
  } catch {
    return '';
  }
  if (!isWithin(groupRoot, memoryRoot)) return '';

  const curatedSections = opts.lazyMemory
    ? curatedFileSectionsFromRoot(
        memoryRoot,
        opts,
        (file) => `memory/curated/${file}`,
      )
    : [];
  const sections = opts.lazyMemory
    ? [
        ...curatedSections,
        ...memoryIndexSectionsFromRoot(
          memoryRoot,
          opts,
          (rel) => `memory/${rel}`,
          (rel) => `group:${groupFolder}:memory/${rel}`,
        ),
      ]
    : memorySectionsFromRoot(
        memoryRoot,
        opts,
        (rel) => `group:${groupFolder}:memory/${rel}`,
      );

  if (sections.length === 0) return '';
  if (opts.lazyMemory) {
    return [
      '<chat_memory_index>',
      'Lazy memory is enabled. This is only a file index for this same chat; file contents are intentionally not loaded into the prompt.',
      'If curated_memory blocks are present, treat them as short lossy summaries and verify exact facts with memory_search/memory_get when needed.',
      'Use memory_search for keyword recall and memory_get with the listed file path when exact details are needed. Do not guess from filenames alone.',
      'Telegram display names remain unverified. If entries lack provenance or come from photo/image captions, treat them as uncertain.',
      ...sections,
      '</chat_memory_index>',
    ].join('\n');
  }
  return [
    '<chat_memory_context>',
    'Persistent notes from this same chat only. Use as continuity hints; Telegram display names remain unverified.',
    'If memory entries conflict, lack provenance, or come from photo/image captions, label them as uncertain instead of asserting them as facts. Do not claim personal knowledge unless stable same-chat memory explicitly supports it.',
    ...sections,
    '</chat_memory_context>',
  ].join('\n');
}

export function loadSharedUserMemoryContext(
  dataDir: string,
  identityId: string | null | undefined,
  opts: MemoryContextOptions = {},
): string {
  if (!identityId || identityId === 'telegram_user_unknown') return '';
  const identityKey = safeSharedMemoryKey(identityId);
  if (identityKey === 'unknown') return '';

  let dataRoot: string;
  let identityRoot: string;
  try {
    dataRoot = fs.realpathSync(path.resolve(dataDir));
    identityRoot = fs.realpathSync(
      path.join(dataRoot, 'user-memory', identityKey),
    );
  } catch {
    return '';
  }
  if (!isWithin(dataRoot, identityRoot)) return '';

  const baseOpts = {
    ...opts,
    identityId,
    maxFiles: opts.maxFiles ?? DEFAULT_SHARED_MAX_FILES,
    maxChars: opts.maxChars ?? DEFAULT_SHARED_MAX_CHARS,
  };
  const sections: string[] = [];
  const curatedSections: string[] = [];

  try {
    const sharedRoot = fs.realpathSync(path.join(identityRoot, 'shared'));
    if (isWithin(identityRoot, sharedRoot)) {
      if (opts.lazyMemory) {
        curatedSections.push(
          ...curatedFileSectionsFromRoot(
            sharedRoot,
            baseOpts,
            (file) => `shared_user_memory/shared/curated/${file}`,
          ),
        );
      }
      sections.push(
        ...(opts.lazyMemory
          ? memoryIndexSectionsFromRoot(
              sharedRoot,
              baseOpts,
              (rel) => `shared_user_memory/shared/${rel}`,
              (rel) => `shared:${identityKey}:shared/${rel}`,
            )
          : memorySectionsFromRoot(
              sharedRoot,
              baseOpts,
              (rel) => `shared:${identityKey}:shared/${rel}`,
            )),
      );
    }
  } catch {
    // Shared user memory is optional.
  }

  if (opts.personaId) {
    try {
      const personaRoot = fs.realpathSync(
        path.join(
          identityRoot,
          'personas',
          safeSharedMemoryKey(opts.personaId),
        ),
      );
      if (isWithin(identityRoot, personaRoot)) {
        const personaKey = safeSharedMemoryKey(opts.personaId);
        if (opts.lazyMemory) {
          curatedSections.push(
            ...curatedFileSectionsFromRoot(
              personaRoot,
              baseOpts,
              (file) =>
                `shared_user_memory/personas/${safeSharedMemoryKey(opts.personaId || '')}/curated/${file}`,
            ),
          );
        }
        sections.push(
          ...(opts.lazyMemory
            ? memoryIndexSectionsFromRoot(
                personaRoot,
                baseOpts,
                (rel) =>
                  `shared_user_memory/personas/${safeSharedMemoryKey(opts.personaId || '')}/${rel}`,
                (rel) => `shared:${identityKey}:personas/${personaKey}/${rel}`,
              )
            : memorySectionsFromRoot(
                personaRoot,
                baseOpts,
                (rel) => `shared:${identityKey}:personas/${personaKey}/${rel}`,
              )),
        );
      }
    } catch {
      // Persona-specific user memory is optional.
    }
  }

  if (sections.length === 0 && curatedSections.length === 0) return '';
  if (opts.lazyMemory) {
    return [
      '<shared_user_memory_index>',
      'Lazy shared-user memory is enabled. This is only a file index scoped to this Telegram identity; file contents are intentionally not loaded into the prompt.',
      'If curated_memory blocks are present, treat them as short lossy summaries and verify exact facts with memory_search when needed.',
      'Use memory_search for keyword recall. Read exact details only when needed; do not infer facts from filenames alone.',
      'Do not expose or infer memory from other Telegram users, other tenants, owner/main chats, or global memory.',
      ...curatedSections,
      ...sections,
      '</shared_user_memory_index>',
    ].join('\n');
  }
  return [
    '<shared_user_memory_context>',
    'Persistent notes scoped to this Telegram user identity across Skoobi personas. Use as continuity hints only; Telegram usernames and display names are not identity.',
    'Do not expose or infer memory from other Telegram users, other tenants, owner/main chats, or global memory. If entries lack provenance, label them as uncertain.',
    ...sections,
    '</shared_user_memory_context>',
  ].join('\n');
}
