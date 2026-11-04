import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SEMANTIC_DIMENSIONS = 384;
export const SEMANTIC_MODEL_REVISION =
  '614241f622f53c4eeff9890bdc4f31cfecc418b3';
export const SEMANTIC_FINGERPRINT = `multilingual-e5-small:${SEMANTIC_MODEL_REVISION}:mean-l2:512:v1`;
export interface SemanticEncoder {
  readonly fingerprint: string;
  readonly dimensions: number;
  encode(
    texts: readonly string[],
    kind: 'query' | 'passage',
  ): Promise<number[][]>;
  close?(): void;
}
export function validEmbedding(
  value: unknown,
  dimensions = SEMANTIC_DIMENSIONS,
): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === dimensions &&
    value.every(
      (x) =>
        typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1.001,
    ) &&
    Math.abs(value.reduce((n, x) => n + x * x, 0) - 1) < 0.02
  );
}
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  return a.length === b.length
    ? a.reduce((sum, n, i) => sum + n * b[i], 0)
    : -1;
}
export function memorySearchTokens(value: string): string[] {
  return [
    ...new Set(
      value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  ].slice(0, 2048);
}
/** Exact identifiers/numbers are not inferred from vector similarity. */
export function exactMemoryAnchors(query: string): string[] {
  const quoted = [...query.matchAll(/[«"“]([^»"”]{2,100})[»"”]/gu)].flatMap(
    (match) => memorySearchTokens(match[1]),
  );
  const tokens = memorySearchTokens(query);
  const named = [...query.matchAll(/\p{Lu}[\p{L}\p{N}]+/gu)]
    .filter(
      (match) =>
        (match.index! > 0 || /\p{Lu}/u.test(match[0].slice(1))) &&
        !/^(?:Как|Что|Где|Когда|Можно|Нужно|Найди|Какой|Какая|Какие|Кто|Что|What|Where|When|Find|How)$/u.test(
          match[0],
        ),
    )
    .flatMap((match) => memorySearchTokens(match[0]));
  return [
    ...new Set([
      ...quoted,
      ...named,
      ...tokens.filter((token) => /\d/u.test(token)),
    ]),
  ];
}

/** Host-configured local executable only. No model download or HTTP client is
 * reachable here. One bounded lazy worker, one active request; busy callers use
 * lexical fallback. Stderr/texts are never added to diagnostics. */
export function createLocalSemanticEncoder(options: {
  pythonPath: string;
  workerPath: string;
  modelDir: string;
  timeoutMs?: number;
  idleMs?: number;
}): SemanticEncoder | undefined {
  if (
    ![options.pythonPath, options.workerPath, options.modelDir].every(
      path.isAbsolute,
    )
  )
    return;
  if (
    ![
      options.pythonPath,
      options.workerPath,
      path.join(options.modelDir, 'model.onnx'),
      path.join(options.modelDir, 'tokenizer.json'),
    ].every((file) => fs.existsSync(file))
  )
    return;
  let child: ChildProcessWithoutNullStreams | undefined;
  let pending:
    | {
        resolve(v: number[][]): void;
        reject(e: Error): void;
        count: number;
        timer: NodeJS.Timeout;
      }
    | undefined;
  let idle: NodeJS.Timeout | undefined;
  let buffer = '';
  const timeoutMs = Math.max(1000, Math.min(60000, options.timeoutMs ?? 15000));
  const fail = () => {
    const active = pending;
    pending = undefined;
    if (active) {
      clearTimeout(active.timer);
      active.reject(new Error('local_embedding_unavailable'));
    }
    if (idle) clearTimeout(idle);
    const previous = child;
    child = undefined;
    buffer = '';
    previous?.kill('SIGKILL');
  };
  const start = () => {
    child = spawn(
      options.pythonPath,
      ['-I', options.workerPath, '--model-dir', options.modelDir],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin',
          PYTHONNOUSERSITE: '1',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          TOKENIZERS_PARALLELISM: 'false',
        },
      },
    );
    const current = child;
    current.stderr.resume();
    current.on('error', () => {
      if (child === current) fail();
    });
    current.on('close', () => {
      if (child === current) fail();
    });
    current.stdout.on('data', (chunk: Buffer) => {
      if (child !== current) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > 1024 * 1024) return fail();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const result = JSON.parse(line);
        if (
          !pending ||
          result.fingerprint !== SEMANTIC_FINGERPRINT ||
          !Array.isArray(result.vectors) ||
          result.vectors.length !== pending.count ||
          !result.vectors.every((v: unknown) => validEmbedding(v))
        )
          return fail();
        const active = pending;
        pending = undefined;
        clearTimeout(active.timer);
        active.resolve(result.vectors);
        idle = setTimeout(
          fail,
          Math.max(1000, Math.min(300000, options.idleMs ?? 60000)),
        );
        idle.unref();
      } catch {
        fail();
      }
    });
  };
  return {
    fingerprint: SEMANTIC_FINGERPRINT,
    dimensions: SEMANTIC_DIMENSIONS,
    encode(texts, kind) {
      if (
        pending ||
        !['query', 'passage'].includes(kind) ||
        texts.length < 1 ||
        texts.length > 64 ||
        texts.some(
          (text) =>
            typeof text !== 'string' || !text.trim() || text.length > 6000,
        )
      )
        return Promise.reject(new Error('local_embedding_unavailable'));
      if (idle) clearTimeout(idle);
      return new Promise((resolve, reject) => {
        pending = {
          resolve,
          reject,
          count: texts.length,
          timer: setTimeout(fail, timeoutMs),
        };
        try {
          if (!child) start();
          child!.stdin.write(
            `${JSON.stringify({ kind, texts })}\n`,
            (error) => {
              if (error) fail();
            },
          );
        } catch {
          fail();
        }
      });
    },
    close: fail,
  };
}
