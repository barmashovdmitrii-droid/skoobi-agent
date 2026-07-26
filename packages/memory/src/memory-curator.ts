import fs from 'fs';
import path from 'path';

import { writeDirectChildFileNoFollowSync } from '@skoobi/shared/safe-child-write';

import { readBoundedMemoryFile } from './memory-context.js';

const CURATED_DIR = 'curated';
export const CURATED_MEMORY_FILE = 'MEMORY.md';
export const CURATED_USER_FILE = 'USER.md';

const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
const DEFAULT_USER_CHAR_LIMIT = 1375;
const DEFAULT_MAX_SOURCE_FILES = 80;
const DEFAULT_MAX_LINES = 80;
const MAX_DISCOVERED_ENTRIES = 10_000;
const MAX_CURATED_FILE_BYTES = 64 * 1024;

type CuratedCandidate = {
  rel: string;
  text: string;
  mtimeMs: number;
  kind: 'user' | 'memory';
  score: number;
};

export type CurateMemoryOptions = {
  memoryCharLimit?: number;
  userCharLimit?: number;
  maxSourceFiles?: number;
  maxLines?: number;
  dryRun?: boolean;
  now?: Date;
};

export type CuratedMemoryResult = {
  memoryRoot: string;
  sourceFiles: number;
  candidates: number;
  memoryLines: number;
  userLines: number;
  memoryChars: number;
  userChars: number;
  written: boolean;
  files: {
    memory: string;
    user: string;
  };
};

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return (
    rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
  );
}

function markdownFiles(
  root: string,
  depth = 0,
  budget: { entries: number } = { entries: 0 },
): string[] {
  if (depth > 5) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    budget.entries += 1;
    if (budget.entries > MAX_DISCOVERED_ENTRIES) break;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === CURATED_DIR) continue;
      files.push(...markdownFiles(full, depth + 1, budget));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

function stripMemoryMeta(line: string): string {
  return line
    .replace(/<!--\s*skoobi_memory_meta=\{[^]*?\}\s*-->/g, '')
    .replace(/<!--[^]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksSecret(text: string): boolean {
  return /(api[_-]?key|token|password|secret|authorization|cookie|\.env|private key|ssh key|bearer\s+[a-z0-9._-]+)/i.test(
    text,
  );
}

function normalizeMemoryLine(line: string): string | null {
  const stripped = stripMemoryMeta(line);
  if (!stripped) return null;
  if (looksSecret(stripped)) return null;
  if (/^#/.test(stripped)) return null;
  const withoutBullet = stripped
    .replace(/^[-*]\s*/, '')
    .replace(/^\[\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?\]\s*/, '')
    .trim();
  if (withoutBullet.length < 12) return null;
  if (/^(memory|shared memory|память)\s*[—-]/i.test(withoutBullet)) {
    return null;
  }
  return withoutBullet.length > 260
    ? `${withoutBullet.slice(0, 257).trimEnd()}...`
    : withoutBullet;
}

function classifyLine(rel: string, text: string): 'user' | 'memory' {
  const target = `${rel}\n${text}`.toLowerCase();
  if (
    /(persona|profile|family|privacy|context|preferences|предпоч|любит|не любит|семь|жена|муж|дет|контекст|профиль|пользователь|зовут|обращайся|стиль|tone|личн)/i.test(
      target,
    )
  ) {
    return 'user';
  }
  return 'memory';
}

function scoreLine(rel: string, text: string, mtimeMs: number): number {
  let score = 0;
  if (/topics\//.test(rel)) score += 3;
  if (
    /(decision|решил|важно|правило|доступ|проект|задач|работ|бот|sku|скооби)/i.test(
      text,
    )
  ) {
    score += 3;
  }
  if (
    /(предпоч|любит|не любит|зовут|стиль|контекст|family|privacy|persona)/i.test(
      text,
    )
  ) {
    score += 2;
  }
  if (/(uncertain|непровер|предполож|photo|фото|image)/i.test(text)) {
    score -= 1;
  }
  score += Math.min(5, Math.max(0, mtimeMs / 1_000_000_000_000));
  return score;
}

function collectCandidates(
  memoryRoot: string,
  opts: Required<Pick<CurateMemoryOptions, 'maxSourceFiles'>>,
): CuratedCandidate[] {
  const rootReal = fs.realpathSync(memoryRoot);
  const files = markdownFiles(rootReal)
    .map((file) => {
      try {
        const resolved = fs.realpathSync(file);
        if (!isWithin(rootReal, resolved)) return null;
        const stat = fs.statSync(resolved);
        return {
          file: resolved,
          rel: path.relative(rootReal, resolved).split(path.sep).join('/'),
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
        mtimeMs: number;
      } => Boolean(item),
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, opts.maxSourceFiles);

  const candidates: CuratedCandidate[] = [];
  for (const file of files) {
    const content = readBoundedMemoryFile(file.file, { from: 'tail' });
    if (content === null) continue;
    for (const rawLine of content.split(/\r?\n/)) {
      const text = normalizeMemoryLine(rawLine);
      if (!text) continue;
      const kind = classifyLine(file.rel, text);
      candidates.push({
        rel: file.rel,
        text,
        mtimeMs: file.mtimeMs,
        kind,
        score: scoreLine(file.rel, text, file.mtimeMs),
      });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
}

function boundedBullets(
  title: string,
  candidates: CuratedCandidate[],
  charLimit: number,
  maxLines: number,
  now: Date,
): { text: string; lines: number } {
  const header = [
    `# ${title}`,
    '',
    `<!-- skoobi_memory_meta=${JSON.stringify({
      source_type: 'summary',
      confidence: 0.55,
      provenance: 'present',
      created_at: now.toISOString(),
      curator: 'skoobi-deterministic-v1',
    })} -->`,
    '',
    'Curated, bounded memory summary. Treat as hints, not proof; use memory_search and memory_get for exact details.',
    '',
  ].join('\n');
  let text = header;
  let lines = 0;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (lines >= maxLines) break;
    const key = candidate.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const bullet = `- ${candidate.text} _(source: ${candidate.rel})_\n`;
    if (text.length + bullet.length > charLimit) break;
    text += bullet;
    lines++;
  }
  if (lines === 0) {
    const fallback =
      '- No stable curated notes yet; use memory_search for details.\n';
    if (text.length + fallback.length <= charLimit) text += fallback;
  }
  return { text: text.trimEnd() + '\n', lines };
}

function safeWriteCuratedFile(
  memoryRoot: string,
  fileName: string,
  data: string,
): string {
  return writeDirectChildFileNoFollowSync({
    parentDirectory: memoryRoot,
    childDirectoryName: CURATED_DIR,
    fileName,
    data,
    maxBytes: MAX_CURATED_FILE_BYTES,
  });
}

function backupIfExists(memoryRoot: string, fileName: string, now: Date): void {
  const file = path.join(memoryRoot, CURATED_DIR, fileName);
  const content = readBoundedMemoryFile(file, { from: 'head' });
  if (content === null) return;
  // Legitimate curator output is only a few KiB. An attacker-inflated legacy
  // file must not turn the optional backup into a fail-closed permanent DoS;
  // skip that backup and let the bounded canonical file replace it safely.
  if (Buffer.byteLength(content, 'utf8') > MAX_CURATED_FILE_BYTES) return;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  safeWriteCuratedFile(memoryRoot, `${fileName}.bak-${stamp}`, content);
}

export function curateMemoryRoot(
  memoryRoot: string,
  options: CurateMemoryOptions = {},
): CuratedMemoryResult {
  const requestedRoot = path.resolve(memoryRoot);
  const requestedStat = fs.lstatSync(requestedRoot);
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    throw new Error('Unsafe memory curator root');
  }
  const rootReal = fs.realpathSync(memoryRoot);
  const parentReal = fs.realpathSync(path.dirname(requestedRoot));
  if (
    path.dirname(rootReal) !== parentReal ||
    path.basename(rootReal) !== path.basename(requestedRoot)
  ) {
    throw new Error('Unsafe memory curator root');
  }
  const now = options.now || new Date();
  const maxSourceFiles = options.maxSourceFiles ?? DEFAULT_MAX_SOURCE_FILES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const memoryCharLimit = options.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT;
  const userCharLimit = options.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT;
  const candidates = collectCandidates(rootReal, { maxSourceFiles });
  const memoryCandidates = candidates.filter((item) => item.kind === 'memory');
  const userCandidates = candidates.filter((item) => item.kind === 'user');
  const memory = boundedBullets(
    CURATED_MEMORY_FILE,
    memoryCandidates.length > 0 ? memoryCandidates : candidates,
    memoryCharLimit,
    maxLines,
    now,
  );
  const user = boundedBullets(
    CURATED_USER_FILE,
    userCandidates.length > 0 ? userCandidates : candidates,
    userCharLimit,
    maxLines,
    now,
  );

  const curatedRoot = path.join(rootReal, CURATED_DIR);
  const memoryFile = path.join(curatedRoot, CURATED_MEMORY_FILE);
  const userFile = path.join(curatedRoot, CURATED_USER_FILE);
  if (!options.dryRun) {
    // `curated` lives under a guest-writable memory root. A normal mkdir/copy/
    // write sequence follows a planted parent or final symlink and turns this
    // host-side curator into an arbitrary-file writer. The helper anchors every
    // operation to open directory descriptors and atomically replaces final
    // entries, so hardlinks and parent-swap races are not followed.
    backupIfExists(rootReal, CURATED_MEMORY_FILE, now);
    backupIfExists(rootReal, CURATED_USER_FILE, now);
    safeWriteCuratedFile(rootReal, CURATED_MEMORY_FILE, memory.text);
    safeWriteCuratedFile(rootReal, CURATED_USER_FILE, user.text);
  }

  return {
    memoryRoot: rootReal,
    sourceFiles: markdownFiles(rootReal).length,
    candidates: candidates.length,
    memoryLines: memory.lines,
    userLines: user.lines,
    memoryChars: memory.text.length,
    userChars: user.text.length,
    written: options.dryRun !== true,
    files: {
      memory: memoryFile,
      user: userFile,
    },
  };
}
