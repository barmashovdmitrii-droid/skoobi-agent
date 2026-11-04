import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  cosineSimilarity,
  exactMemoryAnchors,
  memorySearchTokens,
  validEmbedding,
  type SemanticEncoder,
} from '@skoobi/memory/semantic-retrieval';
import type {
  MemoryStateRecord,
  MemoryStateScope,
} from './memory-state-store.js';

type Fact = Extract<MemoryStateRecord, { kind: 'fact' }>;
type Row = {
  scope_key: string;
  record_key: string;
  project_key: string;
  item_key: string;
  revision: number;
  body_json: string;
  source_json: string;
  updated_at: string;
};
type Candidate = { row: Row; fact: Fact; text: string; hash: string };
export interface MemoryRecallResult {
  facts: Fact[];
  mode: 'lexical' | 'hybrid' | 'hybrid_partial';
  reason?: 'not_configured' | 'embedding_unavailable' | 'storage_unavailable';
  scanned: number;
  cached: number;
  embedded: number;
}

/** Derived private data only; never an independent source of truth. Invalidation
 * shares the authoritative mutation transaction, including forget cascades. */
export function ensureMemorySemanticSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_semantic_vectors (
      scope_key TEXT NOT NULL, record_key TEXT NOT NULL, revision INTEGER NOT NULL,
      content_hash TEXT NOT NULL, model TEXT NOT NULL, dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(scope_key,record_key,model)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_semantic_fts USING fts5(
      scope_key UNINDEXED,record_key UNINDEXED,revision UNINDEXED,text,
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS memory_semantic_current_updated AFTER UPDATE ON memory_state_records BEGIN
      DELETE FROM memory_semantic_vectors WHERE scope_key=OLD.scope_key AND record_key=OLD.record_key;
      DELETE FROM memory_semantic_fts WHERE scope_key=OLD.scope_key AND record_key=OLD.record_key;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_semantic_current_deleted AFTER DELETE ON memory_state_records BEGIN
      DELETE FROM memory_semantic_vectors WHERE scope_key=OLD.scope_key AND record_key=OLD.record_key;
      DELETE FROM memory_semantic_fts WHERE scope_key=OLD.scope_key AND record_key=OLD.record_key;
    END;
  `);
}
function scopeKey(scope: MemoryStateScope): string {
  const fields = [scope.chatJid, scope.identityId, scope.tenantId];
  if (
    fields.some(
      (value) =>
        typeof value !== 'string' || !value.trim() || value.length > 400,
    )
  )
    throw new Error('invalid_memory_scope');
  return JSON.stringify(fields.map((value) => value.trim()));
}
function namespace(value: string | null): string {
  if (value === null) return '';
  const key = value.trim().normalize('NFKC').toLowerCase();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,79}$/u.test(key))
    throw new Error('invalid_memory_project');
  return key;
}
function currentCandidates(
  db: Database.Database,
  scope: string,
  project: string,
  now: string,
): Candidate[] {
  const rows = db
    .prepare(
      `SELECT * FROM memory_state_records
    WHERE scope_key=? AND kind='fact' AND forgotten=0 AND body_json IS NOT NULL AND source_json IS NOT NULL
      AND (project_key='' OR project_key=?)
      AND (json_extract(body_json,'$.validUntil') IS NULL OR json_extract(body_json,'$.validUntil')>?)
      AND (project_key='' OR EXISTS (SELECT 1 FROM memory_state_records p WHERE p.scope_key=memory_state_records.scope_key AND p.project_key=memory_state_records.project_key AND p.kind='project' AND p.forgotten=0))
    ORDER BY record_key LIMIT 2000`,
    )
    .all(scope, project, now) as Row[];
  return rows.map((row) => {
    const body = JSON.parse(row.body_json),
      source = JSON.parse(row.source_json);
    const fact: Fact = {
      ...body,
      kind: 'fact',
      projectKey: row.project_key || null,
      key: row.item_key,
      revision: row.revision,
      updatedAt: row.updated_at,
      source,
      evidence: 'reported_not_verified',
    };
    // Editorial interpretations are not standing tastes. Search the literal
    // current feedback only; ordinary quotes are excluded (may repeat old values).
    const content =
      body.detail?.kind === 'editorial_feedback'
        ? String(source.quote ?? '')
        : String(body.value ?? '');
    const text = `${row.item_key} ${content}`.slice(0, 6000);
    return {
      row,
      fact,
      text,
      hash: createHash('sha256').update(text).digest('hex'),
    };
  });
}
function syncLexical(
  db: Database.Database,
  scope: string,
  candidates: Candidate[],
  now: string,
): void {
  db.transaction(() => {
    // Expiry is not a SQL mutation: purge derived text/vectors on scoped recall.
    for (const table of ['memory_semantic_vectors', 'memory_semantic_fts'])
      db.prepare(
        `DELETE FROM ${table} WHERE scope_key=? AND NOT EXISTS (SELECT 1 FROM memory_state_records r WHERE r.scope_key=${table}.scope_key AND r.record_key=${table}.record_key AND r.forgotten=0 AND (json_extract(r.body_json,'$.validUntil') IS NULL OR json_extract(r.body_json,'$.validUntil')>?))`,
      ).run(scope, now);
    const existing = new Map(
      (
        db
          .prepare(
            'SELECT record_key,revision FROM memory_semantic_fts WHERE scope_key=?',
          )
          .all(scope) as { record_key: string; revision: number }[]
      ).map((row) => [row.record_key, Number(row.revision)]),
    );
    const insert = db.prepare(
      'INSERT INTO memory_semantic_fts(scope_key,record_key,revision,text) VALUES (?,?,?,?)',
    );
    for (const candidate of candidates)
      if (existing.get(candidate.row.record_key) !== candidate.row.revision) {
        db.prepare(
          'DELETE FROM memory_semantic_fts WHERE scope_key=? AND record_key=?',
        ).run(scope, candidate.row.record_key);
        insert.run(
          scope,
          candidate.row.record_key,
          candidate.row.revision,
          candidate.text,
        );
      }
  })();
}
function lexicalRanks(
  db: Database.Database,
  scope: string,
  query: string,
  candidates: Candidate[],
): Map<string, number> {
  const stop = new Set(
    'a an and are as at be by for from how in is it of on or that the this to was what when where which who with как какой какая какие что где когда кто почему ли на по под над от до из для при за во во не но и или а о об это этого этой этом эти тот та те то если чтобы бы быть был была были будет можно нужно надо найди найти мне мы ты он она они you your is can should do does about'.split(
      ' ',
    ),
  );
  const tokens = memorySearchTokens(query)
    .filter((token) => token.length >= 2 && !stop.has(token))
    .slice(0, 32);
  if (!tokens.length) return new Map();
  // Quoted tokens only; no caller-supplied FTS syntax. Prefix matching covers
  // common suffix changes while the separate exact pass protects identifiers.
  const match = tokens.map((token) => `"${token}"*`).join(' OR ');
  // FTS only locates possible matches. Global FTS IDF would allow another
  // identity/project's corpus to change ranking: calculate BM25 over the already
  // scope/project-filtered current candidates instead.
  const matches = new Set(
    (
      db
        .prepare(
          'SELECT record_key FROM memory_semantic_fts WHERE memory_semantic_fts MATCH ? AND scope_key=? LIMIT 2000',
        )
        .all(match, scope) as { record_key: string }[]
    ).map((row) => row.record_key),
  );
  const docs = candidates.map((item) => ({
    item,
    words: (
      item.text
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .match(/[\p{L}\p{N}]+/gu) ?? []
    ).slice(0, 2048),
  }));
  const avg =
    docs.reduce((n, doc) => n + doc.words.length, 0) / Math.max(1, docs.length);
  const frequencies = tokens.map(
    (token) =>
      docs.filter((doc) => doc.words.some((word) => word.startsWith(token)))
        .length,
  );
  const scored = docs
    .filter((doc) => matches.has(doc.item.row.record_key))
    .map((doc) => ({
      key: doc.item.row.record_key,
      score: tokens.reduce((sum, token, index) => {
        const tf = doc.words.filter((word) => word.startsWith(token)).length;
        const idf = Math.log(
          1 +
            (docs.length - frequencies[index] + 0.5) /
              (frequencies[index] + 0.5),
        );
        return (
          sum +
          (idf * (tf * 2.2)) /
            (tf + 1.2 * (0.25 + (0.75 * doc.words.length) / Math.max(1, avg)))
        );
      }, 0),
    }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return new Map(scored.map((row, rank) => [row.key, rank + 1]));
}
function vectorFrom(buffer: Buffer, dimensions: number): number[] | undefined {
  if (!Buffer.isBuffer(buffer) || buffer.length !== dimensions * 4) return;
  const vector = Array.from({ length: dimensions }, (_, index) =>
    buffer.readFloatLE(index * 4),
  );
  return validEmbedding(vector, dimensions) ? vector : undefined;
}

/** Scope/project are selected by the authenticated host BEFORE embedding. No
 * shared legacy index, historical versions, or model-provided identity is used.
 * Existing lexical memory APIs remain intact. Missing model is a normal fallback.
 */
export async function recallStructuredMemory(
  db: Database.Database,
  scope: MemoryStateScope,
  options: {
    query: string;
    projectKey: string | null;
    encoder?: SemanticEncoder;
    limit?: number;
    now?: string;
  },
): Promise<MemoryRecallResult> {
  const scopeId = scopeKey(scope),
    project = namespace(options.projectKey);
  const now = () => options.now ?? new Date().toISOString();
  const query = options.query.trim().slice(-1600);
  const limit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 10)));
  if (!Number.isFinite(limit) || !Number.isFinite(Date.parse(now())))
    throw new Error('invalid_memory_recall');
  const result: MemoryRecallResult = {
    facts: [],
    mode: 'lexical',
    reason: 'not_configured',
    scanned: 0,
    cached: 0,
    embedded: 0,
  };
  if (!query) return result;
  let candidates: Candidate[], lexical: Map<string, number>;
  try {
    candidates = currentCandidates(db, scopeId, project, now());
    syncLexical(db, scopeId, candidates, now());
    lexical = lexicalRanks(db, scopeId, query, candidates);
  } catch {
    return { ...result, reason: 'storage_unavailable' };
  }
  result.scanned = candidates.length;
  const vectors = new Map<string, number[]>();
  let queryVector: number[] | undefined;
  const encoder = options.encoder;
  if (
    encoder &&
    encoder.fingerprint.length <= 200 &&
    Number.isInteger(encoder.dimensions) &&
    encoder.dimensions > 0 &&
    encoder.dimensions <= 1024 &&
    candidates.length
  ) {
    try {
      const cache = db
        .prepare(
          'SELECT record_key,revision,content_hash,vector FROM memory_semantic_vectors WHERE scope_key=? AND model=? AND dimensions=?',
        )
        .all(scopeId, encoder.fingerprint, encoder.dimensions) as {
        record_key: string;
        revision: number;
        content_hash: string;
        vector: Buffer;
      }[];
      const current = new Map(
        candidates.map((item) => [item.row.record_key, item]),
      );
      for (const saved of cache) {
        const record = current.get(saved.record_key);
        const vector = vectorFrom(saved.vector, encoder.dimensions);
        if (
          record &&
          record.row.revision === saved.revision &&
          record.hash === saved.content_hash &&
          vector
        )
          vectors.set(saved.record_key, vector);
      }
      result.cached = vectors.size;
      const missing = candidates
        .filter((item) => !vectors.has(item.row.record_key))
        .sort(
          (a, b) =>
            (lexical.get(a.row.record_key) ?? 9999) -
            (lexical.get(b.row.record_key) ?? 9999),
        )
        .slice(0, 64);
      if (missing.length) {
        const encoded = await encoder.encode(
          missing.map((item) => item.text),
          'passage',
        );
        if (
          encoded.length !== missing.length ||
          !encoded.every((vector) => validEmbedding(vector, encoder.dimensions))
        )
          throw new Error('invalid_embedding');
        // Async work may overlap a correction/forget. INSERT SELECT fences every
        // vector to the exact revision and current bytes within this transaction.
        db.transaction(() => {
          const insert = db.prepare(
            `INSERT OR REPLACE INTO memory_semantic_vectors SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM memory_state_records WHERE scope_key=? AND record_key=? AND revision=? AND body_json=? AND source_json=? AND forgotten=0)`,
          );
          missing.forEach((item, index) => {
            const buffer = Buffer.alloc(encoder.dimensions * 4);
            encoded[index].forEach((v, i) => buffer.writeFloatLE(v, i * 4));
            const written = insert.run(
              scopeId,
              item.row.record_key,
              item.row.revision,
              item.hash,
              encoder.fingerprint,
              encoder.dimensions,
              buffer,
              now(),
              scopeId,
              item.row.record_key,
              item.row.revision,
              item.row.body_json,
              item.row.source_json,
            );
            if (written.changes) {
              vectors.set(item.row.record_key, encoded[index]);
              result.embedded++;
            }
          });
          db.prepare(
            'DELETE FROM memory_semantic_vectors WHERE rowid IN (SELECT rowid FROM memory_semantic_vectors ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET 20000)',
          ).run();
        })();
      }
      const encoded = await encoder.encode([query], 'query');
      if (
        encoded.length !== 1 ||
        !validEmbedding(encoded[0], encoder.dimensions)
      )
        throw new Error('invalid_embedding');
      queryVector = encoded[0];
      result.mode =
        vectors.size === candidates.length ? 'hybrid' : 'hybrid_partial';
      delete result.reason;
    } catch {
      result.reason = 'embedding_unavailable';
      vectors.clear();
    }
  }
  // Authoritative second read after all awaits; never return a cached old value.
  try {
    const latest = currentCandidates(db, scopeId, project, now());
    const previous = new Map(
      candidates.map((item) => [item.row.record_key, item]),
    );
    candidates = latest;
    syncLexical(db, scopeId, candidates, now());
    lexical = lexicalRanks(db, scopeId, query, candidates);
    for (const item of candidates)
      if (
        previous.get(item.row.record_key)?.hash !== item.hash ||
        previous.get(item.row.record_key)?.row.revision !== item.row.revision
      )
        vectors.delete(item.row.record_key);
  } catch {
    return { ...result, facts: [], reason: 'storage_unavailable' };
  }
  const semanticRanks = new Map(
    queryVector
      ? candidates
          .filter((item) => vectors.has(item.row.record_key))
          .map((item) => ({
            key: item.row.record_key,
            score: cosineSimilarity(
              queryVector!,
              vectors.get(item.row.record_key)!,
            ),
          }))
          .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
          .map((item, index) => [item.key, index + 1])
      : [],
  );
  const anchors = exactMemoryAnchors(query);
  const score = (item: Candidate): [number, number] => {
    const tokens = new Set(memorySearchTokens(item.text));
    const exact = anchors.length
      ? anchors.filter((anchor) => tokens.has(anchor)).length / anchors.length
      : 0;
    const lex = lexical.get(item.row.record_key),
      sem = semanticRanks.get(item.row.record_key);
    return [
      exact,
      (sem ? 1 / (20 + sem) : 0) +
        (lex ? (queryVector ? 0.1 : 1) / (20 + lex) : 0),
    ];
  };
  result.facts = candidates
    .filter(
      (item) =>
        lexical.has(item.row.record_key) ||
        semanticRanks.has(item.row.record_key),
    )
    .sort((a, b) => {
      const left = score(a),
        right = score(b);
      return (
        right[0] - left[0] ||
        right[1] - left[1] ||
        a.row.record_key.localeCompare(b.row.record_key)
      );
    })
    .slice(0, limit)
    .map((item) => item.fact);
  return result;
}
