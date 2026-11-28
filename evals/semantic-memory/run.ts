import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { createLocalSemanticEncoder } from '../../packages/memory/src/semantic-retrieval.js';
import {
  ensureMemoryStateSchema,
  mutateMemoryState,
} from '../../packages/core/src/orchestrator/memory-state-store.js';
import {
  ensureMemorySemanticSchema,
  recallStructuredMemory,
} from '../../packages/core/src/orchestrator/memory-semantic-store.js';

/** Explicit local action evaluation; synthetic corpus only. No private chat load.
 * An evaluator may supply a separate sealed query file after model/ranking are frozen. */
const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const corpusPath = arg('--corpus'),
  runtime = arg('--runtime');
if (!process.argv.includes('--corpus') || !process.argv.includes('--runtime'))
  throw new Error('--corpus and --runtime required');
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as {
  id: string;
  fact: string;
  query?: string;
  scope?: string;
  project?: string;
}[];
if (
  !Array.isArray(corpus) ||
  corpus.length > 2000 ||
  corpus.some(
    (item) =>
      typeof item.id !== 'string' ||
      typeof item.fact !== 'string' ||
      item.fact.length > 4000,
  )
)
  throw new Error('invalid_fixture');
const queries: { id: string; query: string }[] = process.argv.includes(
  '--queries',
)
  ? JSON.parse(fs.readFileSync(arg('--queries'), 'utf8'))
  : corpus.filter(
      (item): item is typeof item & { query: string } =>
        typeof item.query === 'string',
    );
const encoder = createLocalSemanticEncoder({
  pythonPath: path.join(runtime, 'venv/bin/python'),
  modelDir: path.join(runtime, 'model'),
  workerPath: path.resolve('scripts/memory-embedding-worker.py'),
  timeoutMs: 60000,
  idleMs: 300000,
});
if (!encoder) throw new Error('local_model_not_installed');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-eval-'));
const db = new Database(path.join(dir, 'memory.sqlite'));
const scope = {
  chatJid: 'tg:synthetic-eval',
  identityId: 'synthetic-eval-owner',
  tenantId: 'synthetic-eval-tenant',
};
try {
  ensureMemoryStateSchema(db);
  ensureMemorySemanticSchema(db);
  for (const item of corpus)
    mutateMemoryState(
      db,
      scope,
      {
        kind: 'fact_upsert',
        operationId: item.id,
        expectedRevision: 0,
        projectKey: null,
        key: item.id,
        value: item.fact,
      },
      { kind: 'assistant_report', at: new Date().toISOString() },
    );
  const rows = [];
  let coldMs = 0;
  for (const [index, item] of queries.entries()) {
    const lexical = await recallStructuredMemory(db, scope, {
      query: item.query,
      projectKey: null,
      limit: 3,
    });
    const started = performance.now();
    const hybrid = await recallStructuredMemory(db, scope, {
      query: item.query,
      projectKey: null,
      limit: 3,
      encoder,
    });
    const durationMs = performance.now() - started;
    if (index === 0) coldMs = durationMs;
    rows.push({
      id: item.id,
      lexicalHit: lexical.facts.some((fact) => fact.key === item.id),
      hybridHit: hybrid.facts.some((fact) => fact.key === item.id),
      lexicalKeys: lexical.facts.map((fact) => fact.key),
      hybridKeys: hybrid.facts.map((fact) => fact.key),
      mode: hybrid.mode,
      durationMs: Math.round(durationMs),
    });
  }
  const warm = rows
    .slice(1)
    .map((item) => item.durationMs)
    .sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        model: encoder.fingerprint,
        queries: rows.length,
        lexicalRecall3:
          rows.filter((item) => item.lexicalHit).length / rows.length,
        hybridRecall3:
          rows.filter((item) => item.hybridHit).length / rows.length,
        coldMs: Math.round(coldMs),
        warmP95Ms: warm[Math.floor((warm.length - 1) * 0.95)] ?? null,
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  encoder.close?.();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
