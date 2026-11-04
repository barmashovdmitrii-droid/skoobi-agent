import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, describe, expect, it } from 'vitest';

const source = fileURLToPath(
  new URL('./service-lifecycle.ts', import.meta.url),
);
const project = fileURLToPath(new URL('../../', import.meta.url));
const tsxLoader = path.join(project, 'node_modules/tsx/dist/loader.mjs');
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  }
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

type ExitResult = { code: number | null; signal: NodeJS.Signals | null };

async function startRecorder(
  graceful: false | 'after' | 'before-once' = false,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-lifecycle-test-'));
  roots.push(root);
  const fixture = path.join(root, 'fixture.mjs');
  fs.writeFileSync(
    fixture,
    `import fs from 'node:fs';
     import { initServiceLifecycle } from ${JSON.stringify(source)};
     const gracefulStop = () => {
       setTimeout(() => {
         fs.writeFileSync('graceful-finished', 'yes');
         process.exit(0);
       }, 100);
     };
     ${graceful === 'before-once' ? "process.once('SIGTERM', gracefulStop);" : ''}
     initServiceLifecycle();
     initServiceLifecycle(); // repeated initialization must not add observers
     ${graceful === 'after' ? "process.on('SIGTERM', gracefulStop);" : ''}
     setInterval(() => {}, 1000);
     process.stdout.write('READY\\n');
    `,
  );
  // SIGQUIT normally permits a core dump; disable it for this synthetic child.
  const child = spawn(
    '/bin/sh',
    [
      '-c',
      'ulimit -c 0; exec "$@"',
      'lifecycle-test',
      process.execPath,
      '--import',
      tsxLoader,
      fixture,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        SKOOBI_TEST_STATE_ROOT: root,
        CLAUDECLAW_ENV_FILE: path.join(root, 'missing.env'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Lifecycle fixture did not become ready')),
      5000,
    );
    let output = '';
    const onData = (chunk: Buffer) => {
      output += String(chunk);
      if (output.includes('READY\n')) {
        clearTimeout(timeout);
        child.stdout!.removeListener('data', onData);
        resolve();
      }
    };
    child.stdout!.on('data', onData);
    void closed.then(() => {
      clearTimeout(timeout);
      reject(new Error(`Lifecycle fixture exited before readiness: ${stderr}`));
    }, reject);
  });
  return { root, child, closed };
}

async function waitForExit(closed: Promise<ExitResult>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Lifecycle observer swallowed the signal')),
          3000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function stops(root: string) {
  return fs
    .readFileSync(path.join(root, 'logs/service-lifecycle.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((record) => record.event === 'stop');
}

describe.skipIf(process.platform === 'win32')(
  'service lifecycle signal observer',
  () => {
    it.each(['SIGTERM', 'SIGHUP', 'SIGQUIT'] as const)(
      'preserves default %s termination before a shutdown handler exists',
      async (signal) => {
        const fixture = await startRecorder();
        fixture.child.kill(signal);
        expect(await waitForExit(fixture.closed)).toEqual({
          code: null,
          signal,
        });
        expect(stops(fixture.root)).toEqual([
          expect.objectContaining({ reason: `signal ${signal}` }),
        ]);
      },
    );

    it.each(['after', 'before-once'] as const)(
      'lets an asynchronous SIGTERM handler finish (%s)',
      async (registration) => {
        const fixture = await startRecorder(registration);
        fixture.child.kill('SIGTERM');
        expect(await waitForExit(fixture.closed)).toEqual({
          code: 0,
          signal: null,
        });
        expect(
          fs.readFileSync(path.join(fixture.root, 'graceful-finished'), 'utf8'),
        ).toBe('yes');
        expect(stops(fixture.root)).toEqual([
          expect.objectContaining({ reason: 'signal SIGTERM' }),
        ]);
      },
    );
  },
);
