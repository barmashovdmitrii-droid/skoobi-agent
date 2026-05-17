/**
 * Retention classifier (Tier 1, dry-by-default).
 *
 * Pure logic that decides which media manifest entries are eligible for
 * deletion. Kept in its own module so unit tests do not have to spin up
 * the script entrypoint or touch the filesystem.
 *
 * Decision tree (per entry):
 *   1. `keep === true` → KEEP (user pinned).
 *   2. Photo without a caption → KEEP (we still owe it a caption).
 *   3. Voice/video-note without a transcript → KEEP (still owe transcript).
 *   4. Age > TTL for its type → CANDIDATE.
 *   5. Otherwise → KEEP.
 *
 * The caller then runs two passes on top of the CANDIDATE set:
 *   a) Per-user (per-folder) byte limit: if a folder's total bytes
 *      exceed `perUserBytesLimit`, the OLDEST non-keep entries are also
 *      marked CANDIDATE until the folder fits.
 *   b) Global byte limit: same idea across all folders.
 */

import type { MediaEntry, MediaType } from './media-manifest.js';

export interface RetentionConfig {
  defaultMaxAgeDays: number;
  voiceMaxAgeDays: number;
  videoNoteMaxAgeDays: number;
  photoMaxAgeDays: number;
  documentMaxAgeDays: number;
  perUserBytesLimit: number;
  globalBytesLimit: number;
  mode: {
    voice: 'dry' | 'run';
    videoNote: 'dry' | 'run';
    photo: 'dry' | 'run';
    document: 'dry' | 'run';
  };
}

export type RetentionDecision = 'keep' | 'candidate';

export interface ClassifiedEntry {
  entry: MediaEntry;
  decision: RetentionDecision;
  reason:
    | 'pinned'
    | 'photo-needs-caption'
    | 'voice-needs-transcript'
    | 'video-note-needs-transcript'
    | 'age-exceeded'
    | 'within-ttl'
    | 'over-user-bytes'
    | 'over-global-bytes'
    | 'already-deleted';
}

function ttlForType(type: MediaType, config: RetentionConfig): number {
  switch (type) {
    case 'voice':
      return config.voiceMaxAgeDays;
    case 'video-note':
      return config.videoNoteMaxAgeDays;
    case 'photo':
      return config.photoMaxAgeDays;
    case 'document':
      return config.documentMaxAgeDays;
    case 'audio':
    case 'video':
    default:
      return config.defaultMaxAgeDays;
  }
}

export function ageDays(entry: MediaEntry, now = new Date()): number {
  const created = new Date(entry.created_at);
  if (isNaN(created.getTime())) return 0;
  return (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Classify a single entry against the age and content rules. Does NOT
 * factor in per-user or global byte limits — those are layered on top by
 * `applyByteLimits`.
 */
export function classifyEntry(
  entry: MediaEntry,
  config: RetentionConfig,
  now = new Date(),
): ClassifiedEntry {
  if (entry.deleted_at) {
    return { entry, decision: 'keep', reason: 'already-deleted' };
  }
  if (entry.keep) {
    return { entry, decision: 'keep', reason: 'pinned' };
  }
  if (entry.type === 'photo' && !entry.has_caption) {
    return { entry, decision: 'keep', reason: 'photo-needs-caption' };
  }
  if (entry.type === 'voice' && !entry.has_transcript) {
    return { entry, decision: 'keep', reason: 'voice-needs-transcript' };
  }
  if (entry.type === 'video-note' && !entry.has_transcript) {
    return { entry, decision: 'keep', reason: 'video-note-needs-transcript' };
  }
  const ttl = ttlForType(entry.type, config);
  if (ageDays(entry, now) > ttl) {
    return { entry, decision: 'candidate', reason: 'age-exceeded' };
  }
  return { entry, decision: 'keep', reason: 'within-ttl' };
}

export function classifyFolder(
  entries: MediaEntry[],
  config: RetentionConfig,
  now = new Date(),
): ClassifiedEntry[] {
  return entries.map((e) => classifyEntry(e, config, now));
}

/**
 * Layer per-user (folder) byte limit on top of the age-based candidates.
 * Mutates the classification array in place: if the folder's total bytes
 * (across non-deleted entries) exceed `perUserBytesLimit`, mark the
 * oldest non-keep entries as candidates until the budget fits.
 *
 * "non-keep" here means `!entry.keep` AND not currently classified as
 * `keep` due to pending caption/transcript work — those still need to
 * stick around. Pinned and pending-work items count toward the budget
 * but are never evicted.
 */
export function applyPerUserBytes(
  classifications: ClassifiedEntry[],
  config: RetentionConfig,
): void {
  const totalBytes = classifications
    .filter((c) => !c.entry.deleted_at)
    .reduce((acc, c) => acc + (c.entry.size_bytes || 0), 0);
  if (totalBytes <= config.perUserBytesLimit) return;

  // Candidates already over TTL stay candidates. We look for additional
  // eviction candidates among entries currently in `keep` status that
  // are NOT pinned and NOT pending caption/transcript work.
  const evictable = classifications
    .filter(
      (c) =>
        c.decision === 'keep' &&
        c.reason === 'within-ttl' &&
        !c.entry.keep &&
        !c.entry.deleted_at,
    )
    .sort(
      (a, b) =>
        new Date(a.entry.created_at).getTime() -
        new Date(b.entry.created_at).getTime(),
    );

  let candidateBytes = classifications
    .filter((c) => c.decision === 'candidate')
    .reduce((acc, c) => acc + (c.entry.size_bytes || 0), 0);

  for (const item of evictable) {
    if (totalBytes - candidateBytes <= config.perUserBytesLimit) break;
    item.decision = 'candidate';
    item.reason = 'over-user-bytes';
    candidateBytes += item.entry.size_bytes || 0;
  }
}

/**
 * Aggregate folder summaries used by the retention sweep when deciding
 * which folders to evict additional bytes from to satisfy the global
 * byte budget.
 */
export interface FolderSummary {
  folder: string;
  classifications: ClassifiedEntry[];
}

/**
 * Layer global byte limit across folders. Iterates folders in descending
 * size order and evicts their oldest non-keep entries until the global
 * total fits inside `globalBytesLimit`.
 */
export function applyGlobalBytes(
  summaries: FolderSummary[],
  config: RetentionConfig,
): void {
  const totalBytes = summaries
    .flatMap((s) => s.classifications)
    .filter((c) => !c.entry.deleted_at)
    .reduce((acc, c) => acc + (c.entry.size_bytes || 0), 0);
  if (totalBytes <= config.globalBytesLimit) return;

  // Pool evictable entries across all folders.
  type Entry = { folder: string; item: ClassifiedEntry };
  const pool: Entry[] = [];
  for (const s of summaries) {
    for (const item of s.classifications) {
      if (
        item.decision === 'keep' &&
        item.reason === 'within-ttl' &&
        !item.entry.keep &&
        !item.entry.deleted_at
      ) {
        pool.push({ folder: s.folder, item });
      }
    }
  }
  pool.sort(
    (a, b) =>
      new Date(a.item.entry.created_at).getTime() -
      new Date(b.item.entry.created_at).getTime(),
  );

  let candidateBytes = summaries
    .flatMap((s) => s.classifications)
    .filter((c) => c.decision === 'candidate')
    .reduce((acc, c) => acc + (c.entry.size_bytes || 0), 0);

  for (const p of pool) {
    if (totalBytes - candidateBytes <= config.globalBytesLimit) break;
    p.item.decision = 'candidate';
    p.item.reason = 'over-global-bytes';
    candidateBytes += p.item.entry.size_bytes || 0;
  }
}
