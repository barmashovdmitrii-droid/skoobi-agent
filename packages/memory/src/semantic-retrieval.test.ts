import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  createLocalSemanticEncoder,
  exactMemoryAnchors,
  memorySearchTokens,
  validEmbedding,
  SEMANTIC_FINGERPRINT,
} from './semantic-retrieval.js';

describe('bounded local semantic protocol', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });
  function fixture(body: string, timeoutMs = 1000) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-protocol-'));
    const worker = path.join(dir, 'fixture.cjs'),
      executable = path.join(dir, 'python-fixture');
    fs.writeFileSync(worker, body);
    const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    fs.writeFileSync(
      executable,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(worker)}\n`,
      { mode: 0o700 },
    );
    for (const file of ['model.onnx', 'tokenizer.json'])
      fs.writeFileSync(path.join(dir, file), 'protocol fixture only');
    const encoder = createLocalSemanticEncoder({
      pythonPath: executable,
      workerPath: worker,
      modelDir: dir,
      timeoutMs,
    })!;
    cleanup.push(() => {
      encoder.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return encoder;
  }
  it('requires local absolute installed paths and makes no setup/network attempt', () => {
    expect(
      createLocalSemanticEncoder({
        pythonPath: 'python',
        workerPath: 'worker.py',
        modelDir: 'model',
      }),
    ).toBeUndefined();
    expect(
      createLocalSemanticEncoder({
        pythonPath: '/missing/python',
        workerPath: '/missing/worker.py',
        modelDir: '/missing/model',
      }),
    ).toBeUndefined();
  });
  it('validates dimensions, finite normalized vectors and exact anchors', () => {
    expect(validEmbedding([1, 0, 0], 3)).toBe(true);
    expect(validEmbedding([1, 1, 0], 3)).toBe(false);
    expect(validEmbedding([NaN, 0, 0], 3)).toBe(false);
    expect(validEmbedding([1, 0], 3)).toBe(false);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(exactMemoryAnchors('У «Северный Дом» лимит 6400')).toEqual([
      'северный',
      'дом',
      '6400',
    ]);
    expect(memorySearchTokens('Ёлка ELK-42')).toEqual(['елка', 'elk', '42']);
  });
  it('serializes a real local child request and rejects busy callers without a second child', async () => {
    const encoder = fixture(
      `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>setTimeout(()=>{const x=JSON.parse(line);console.log(JSON.stringify({fingerprint:${JSON.stringify(SEMANTIC_FINGERPRINT)},vectors:x.texts.map(()=>[1,...Array(383).fill(0)])}));},25));`,
    );
    const first = encoder.encode(['Synthetic text'], 'passage');
    await expect(encoder.encode(['Concurrent'], 'query')).rejects.toThrow(
      'local_embedding_unavailable',
    );
    expect((await first)[0]).toHaveLength(384);
    expect((await encoder.encode(['Query'], 'query'))[0][0]).toBe(1);
  });
  it('bounds malformed or noisy child output without exposing stderr', async () => {
    const malformed = fixture(
      `process.stderr.write('synthetic-secret-exception');process.stdin.once('data',()=>console.log('not json'));`,
    );
    await expect(malformed.encode(['Private input'], 'query')).rejects.toThrow(
      /^local_embedding_unavailable$/,
    );
    const noisy = fixture(
      `process.stdin.once('data',()=>process.stdout.write('x'.repeat(1024*1024+1)));`,
    );
    await expect(noisy.encode(['Input'], 'query')).rejects.toThrow(
      /^local_embedding_unavailable$/,
    );
  });
  it('times out a hung worker and close rejects any pending request', async () => {
    const hanging = fixture(`process.stdin.resume();setInterval(()=>{},1000);`);
    const start = Date.now();
    await expect(hanging.encode(['Input'], 'query')).rejects.toThrow(
      'local_embedding_unavailable',
    );
    expect(Date.now() - start).toBeLessThan(2500);
    const pending = hanging.encode(['Again'], 'query');
    hanging.close?.();
    await expect(pending).rejects.toThrow('local_embedding_unavailable');
  });
});
