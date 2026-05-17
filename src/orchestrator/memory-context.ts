import fs from 'fs';
import path from 'path';

import { escapeXml } from './router.js';

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_MAX_FILE_CHARS = 1500;

type MemoryMetadata = {
  source_type: string;
  confidence: number;
  provenance: 'present' | 'missing';
  sender_id: string | null;
  tenant_id: string | null;
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

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return (
    rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
  );
}

function markdownFiles(root: string, depth = 0): string[] {
  if (depth > 2) return [];
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
    provenance: 'present',
    sender_id:
      typeof record.sender_id === 'string' && record.sender_id.trim()
        ? record.sender_id.trim()
        : null,
    tenant_id:
      typeof record.tenant_id === 'string' && record.tenant_id.trim()
        ? record.tenant_id.trim()
        : null,
  };
}

function extractMemoryMetadata(content: string): MemoryMetadata {
  const match = content.match(/skoobi_memory_meta=({[^]*?})\s*-->/);
  if (!match) return normalizeMemoryMetadata(null);
  try {
    return normalizeMemoryMetadata(JSON.parse(match[1]));
  } catch {
    return normalizeMemoryMetadata(null);
  }
}

function shouldInjectMemory(
  metadata: MemoryMetadata,
  opts: { senderId?: string | null; tenantId?: string | null },
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
  return true;
}

export function loadGroupMemoryContext(
  groupsDir: string,
  groupFolder: string,
  opts: {
    maxFiles?: number;
    maxChars?: number;
    maxFileChars?: number;
    senderId?: string | null;
    tenantId?: string | null;
  } = {},
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
      content = fs.readFileSync(resolved, 'utf-8').trim();
    } catch {
      continue;
    }
    if (!content) continue;
    const metadata = extractMemoryMetadata(content);
    if (!shouldInjectMemory(metadata, opts)) continue;
    if (content.length > maxFileChars) {
      content = `${content.slice(0, maxFileChars).trimEnd()}\n...`;
    }

    const rel = path.relative(memoryRoot, resolved).split(path.sep).join('/');
    const sourceType =
      metadata.source_type === 'photo_caption' ||
      metadata.source_type === 'image'
        ? `${metadata.source_type}:uncertain`
        : metadata.source_type;
    const section = `<memory file="${escapeXml(rel)}" source_type="${escapeXml(sourceType)}" confidence="${metadata.confidence.toFixed(2)}" provenance="${metadata.provenance}" sender_id="${escapeXml(metadata.sender_id || '')}">\n${escapeXml(content)}\n</memory>`;
    if (used + section.length > maxChars) break;
    sections.push(section);
    used += section.length;
  }

  if (sections.length === 0) return '';
  return [
    '<chat_memory_context>',
    'Persistent notes from this same chat only. Use as continuity hints; Telegram display names remain unverified.',
    'If memory entries conflict, lack provenance, or come from photo/image captions, label them as uncertain instead of asserting them as facts. Do not claim personal knowledge unless stable same-chat memory explicitly supports it.',
    ...sections,
    '</chat_memory_context>',
  ].join('\n');
}
