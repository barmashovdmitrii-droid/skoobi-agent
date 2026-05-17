/**
 * Owner-only admin storage helpers (Phase 5).
 *
 * Implements the read-only side of `/storage`, `/storage <folder>`, and
 * `/keep last` in a way that can be unit tested without standing up the
 * full Telegram channel.
 *
 * Naming convention: every public helper returns a `string` ready to be
 * sent as a Telegram message. The caller is responsible for owner check
 * and the actual `replySafely`.
 */

import { promises as fs } from 'fs';
import path from 'path';

import { listMedia, setKeep, type MediaEntry } from './media-manifest.js';

/** Recursively sum file sizes under `dir`. Best-effort: unreadable
 *  files / directories are skipped silently. */
export async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += await folderBytes(full);
    } else if (e.isFile()) {
      try {
        const stat = await fs.stat(full);
        total += stat.size;
      } catch {
        // skip
      }
    }
  }
  return total;
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Top-level storage overview for `/storage`. Lists every group with its
 * folder size and the top three media types by bytes (across all
 * folders). No absolute paths in the output.
 */
export async function storageOverview(groupsDir: string): Promise<string> {
  let entries;
  try {
    entries = await fs.readdir(groupsDir, { withFileTypes: true });
  } catch {
    return 'Папка groups недоступна.';
  }
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);

  const folderRows: { name: string; bytes: number }[] = [];
  const typeBytes: Record<string, number> = {};

  for (const name of folders) {
    const abs = path.join(groupsDir, name);
    const bytes = await folderBytes(abs);
    folderRows.push({ name, bytes });
    try {
      const media = await listMedia(abs);
      for (const m of media) {
        typeBytes[m.type] = (typeBytes[m.type] ?? 0) + (m.size_bytes || 0);
      }
    } catch {
      // ignore
    }
  }

  folderRows.sort((a, b) => b.bytes - a.bytes);
  const total = folderRows.reduce((acc, r) => acc + r.bytes, 0);

  const lines: string[] = [];
  lines.push(`Storage overview (${humanBytes(total)} total)`);
  for (const row of folderRows) {
    lines.push(`  ${row.name}: ${humanBytes(row.bytes)}`);
  }

  const topTypes = Object.entries(typeBytes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (topTypes.length > 0) {
    lines.push('');
    lines.push('Top media types (manifest):');
    for (const [t, b] of topTypes) lines.push(`  ${t}: ${humanBytes(b)}`);
  }
  return lines.join('\n');
}

/**
 * Detailed view for `/storage <folder>`. Returns counts per type, total
 * size from the manifest, oldest mtime, and how many entries are pinned.
 */
export async function storageForFolder(
  groupsDir: string,
  folder: string,
): Promise<string> {
  const abs = path.join(groupsDir, folder);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return `Группа ${folder} не найдена.`;
  }
  if (!stat.isDirectory()) {
    return `Группа ${folder} не найдена.`;
  }

  const media = await listMedia(abs).catch(() => [] as MediaEntry[]);
  const byType: Record<string, { entries: number; bytes: number }> = {};
  let totalBytes = 0;
  let keepCount = 0;
  let oldest: string | null = null;
  for (const m of media) {
    const v = (byType[m.type] = byType[m.type] || { entries: 0, bytes: 0 });
    v.entries++;
    v.bytes += m.size_bytes || 0;
    totalBytes += m.size_bytes || 0;
    if (m.keep) keepCount++;
    if (!oldest || m.created_at < oldest) oldest = m.created_at;
  }

  const dirBytes = await folderBytes(abs);

  const lines: string[] = [];
  lines.push(`Storage / ${folder}`);
  lines.push(
    `Manifest entries: ${media.length} (${humanBytes(totalBytes)}), pinned: ${keepCount}`,
  );
  lines.push(`Folder size (du): ${humanBytes(dirBytes)}`);
  lines.push(`Oldest entry: ${oldest ?? 'n/a'}`);
  lines.push('By type:');
  for (const [t, v] of Object.entries(byType).sort(
    (a, b) => b[1].bytes - a[1].bytes,
  )) {
    lines.push(`  ${t}: ${v.entries} (${humanBytes(v.bytes)})`);
  }
  return lines.join('\n');
}

/**
 * Pin the most recently appended media entry in `folder` so retention
 * keeps it indefinitely. Returns a Telegram-ready message describing the
 * outcome.
 */
export async function pinLastMedia(
  groupsDir: string,
  folder: string,
): Promise<string> {
  const abs = path.join(groupsDir, folder);
  const media = await listMedia(abs).catch(() => [] as MediaEntry[]);
  if (media.length === 0) return `В группе ${folder} нет медиа.`;
  const latest = media[media.length - 1];
  const ok = await setKeep(abs, latest.basename, true);
  if (!ok) return `Не удалось обновить манифест для ${latest.basename}.`;
  return `Pinned: ${latest.basename}`;
}
