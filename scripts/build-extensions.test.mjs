import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExtensions } from './build-extensions.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-build-'));
  roots.push(root);
  for (const name of ['claudeclaw-good', 'claudeclaw-optional']) fs.mkdirSync(path.join(root, 'extensions', name), { recursive: true });
  fs.writeFileSync(path.join(root, 'extensions', 'claudeclaw-good', 'tsconfig.json'), '{}');
  return root;
}

describe('extension build status', () => {
  it('skips only absent tsconfig and propagates a successful compiler status', () => {
    const compile = vi.fn(() => ({ status: 0 }));
    expect(buildExtensions({ root: fixture(), compile })).toBe(0);
    expect(compile).toHaveBeenCalledTimes(1);
  });
  it.each([{ status: 2 }, { status: null, signal: 'SIGTERM' }, { status: null, error: new Error('spawn failed') }])('fails the overall build on compiler failure', (result) => {
    expect(buildExtensions({ root: fixture(), compile: () => result, report: vi.fn() })).toBe(1);
  });
});
