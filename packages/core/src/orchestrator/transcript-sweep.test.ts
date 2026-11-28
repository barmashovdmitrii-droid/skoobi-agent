// INTENDED REPO PATH: src/orchestrator/transcript-sweep.test.ts
//
// Mirrors the temp-dir style of transcript-rotation.test.ts.
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listAllTranscripts,
  sweepOverCapTranscripts,
} from './transcript-sweep.js';

const FIXED_NOW = () => new Date(2026, 5, 7, 15, 11, 4); // 2026-06-07 15:11:04 local

let root: string;
let dataDir: string;
let storeDir: string;

/**
 * Write a transcript at
 *   <dataDir>/sessions/<folder>/.claude/projects/<projectKey>/<id>.jsonl
 * The projectKey is arbitrary here — findTranscriptPath/the walker match on
 * the `<id>.jsonl` filename, not on a reconstructed path encoding.
 */
function writeTranscript(
  folder: string,
  sessionId: string,
  bytes: number,
  projectKey = '-Users-example-project-groups-' + folder,
): string {
  const dir = path.join(
    dataDir,
    'sessions',
    folder,
    '.claude',
    'projects',
    projectKey,
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61));
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-sweep-'));
  dataDir = path.join(root, 'data');
  storeDir = path.join(root, 'store');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('listAllTranscripts', () => {
  it('returns empty when there is no sessions dir', () => {
    expect(listAllTranscripts(dataDir)).toEqual([]);
  });

  it('walks every group/project/jsonl and parses the session id', () => {
    writeTranscript('telegram_a', 'aaaa-1111', 10);
    writeTranscript('telegram_b', 'bbbb-2222', 10);
    const found = listAllTranscripts(dataDir).sort((x, y) =>
      x.sessionId.localeCompare(y.sessionId),
    );
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      groupFolder: 'telegram_a',
      sessionId: 'aaaa-1111',
    });
    expect(found[1]).toMatchObject({
      groupFolder: 'telegram_b',
      sessionId: 'bbbb-2222',
    });
    expect(fs.existsSync(found[0].transcriptPath)).toBe(true);
  });

  it('ignores non-.jsonl files', () => {
    const dir = path.join(
      dataDir,
      'sessions',
      'telegram_a',
      '.claude',
      'projects',
      'k',
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'sess.jsonl'), 'y');
    const found = listAllTranscripts(dataDir);
    expect(found.map((f) => f.sessionId)).toEqual(['sess']);
  });
});

describe('sweepOverCapTranscripts — dry run (default)', () => {
  it('reports over-cap files but moves nothing', () => {
    const big = writeTranscript('telegram_a', 'orphan-1', 200);
    const small = writeTranscript('telegram_b', 'pinned-1', 50);

    const r = sweepOverCapTranscripts({
      dataDir,
      storeDir,
      maxBytes: 100,
      now: FIXED_NOW,
      // no apply → dry
    });

    expect(r.apply).toBe(false);
    expect(r.scanned).toBe(2);
    expect(r.overCap).toBe(1);
    expect(r.reclaimableBytes).toBe(200);
    expect(r.swept).toHaveLength(1);
    expect(r.swept[0]).toMatchObject({
      sessionId: 'orphan-1',
      action: 'would-archive',
      pinned: false,
    });

    // Nothing moved.
    expect(fs.existsSync(big)).toBe(true);
    expect(fs.existsSync(small)).toBe(true);
    expect(fs.existsSync(path.join(storeDir, 'archive', 'sessions'))).toBe(
      false,
    );
  });

  it('marks a pinned file pinned even in dry run', () => {
    writeTranscript('telegram_a', 'pinned-9', 200);
    const r = sweepOverCapTranscripts({
      dataDir,
      storeDir,
      maxBytes: 100,
      getSessions: () => ({ telegram_a: 'pinned-9' }),
    });
    expect(r.swept[0]).toMatchObject({ pinned: true, action: 'would-archive' });
  });
});

describe('sweepOverCapTranscripts — apply', () => {
  it('archives an over-cap ORPHAN and never clears a session', () => {
    const file = writeTranscript('telegram_a', 'orphan-1', 200);
    const cleared: string[] = [];

    const r = sweepOverCapTranscripts({
      dataDir,
      storeDir,
      maxBytes: 100,
      now: FIXED_NOW,
      apply: true,
      getSessions: () => ({}), // nothing pinned
      clearSession: (f) => cleared.push(f),
    });

    expect(r.apply).toBe(true);
    expect(r.overCap).toBe(1);
    expect(r.swept[0].action).toBe('archived');
    expect(r.swept[0].pinned).toBe(false);
    expect(r.swept[0].sessionCleared).toBeUndefined();
    expect(cleared).toEqual([]); // orphan → no clear

    // Original gone, archived with the conventional name.
    expect(fs.existsSync(file)).toBe(false);
    const expected = path.join(
      storeDir,
      'archive',
      'sessions',
      'orphan-1.archived-20260607-151104.jsonl',
    );
    expect(r.swept[0].archivedPath).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.statSync(expected).size).toBe(200);
  });

  it('archives an over-cap PINNED file AND clears its session', () => {
    const file = writeTranscript('telegram_a', 'pinned-7', 300);
    const cleared: string[] = [];

    const r = sweepOverCapTranscripts({
      dataDir,
      storeDir,
      maxBytes: 100,
      now: FIXED_NOW,
      apply: true,
      getSessions: () => ({ telegram_a: 'pinned-7' }),
      clearSession: (f) => cleared.push(f),
    });

    expect(r.swept[0].action).toBe('archived');
    expect(r.swept[0].pinned).toBe(true);
    expect(r.swept[0].sessionCleared).toBe(true);
    expect(cleared).toEqual(['telegram_a']);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('leaves within-cap files alone', () => {
    const small = writeTranscript('telegram_a', 's', 50);
    const r = sweepOverCapTranscripts({
      dataDir,
      storeDir,
      maxBytes: 100,
      apply: true,
      now: FIXED_NOW,
    });
    expect(r.overCap).toBe(0);
    expect(r.swept).toEqual([]);
    expect(fs.existsSync(small)).toBe(true);
  });

  it('captures a clearSession failure without aborting the sweep', () => {
    writeTranscript('telegram_a', 'pinned-x', 300);
    writeTranscript('telegram_b', 'orphan-y', 300);

    const r = sweepOverCapTranscripts({
      dataDir,
      storeDir,
      maxBytes: 100,
      now: FIXED_NOW,
      apply: true,
      getSessions: () => ({ telegram_a: 'pinned-x' }),
      clearSession: () => {
        throw new Error('db locked');
      },
    });

    // Both files still archived; the pinned one records the clear error.
    expect(r.overCap).toBe(2);
    const pinned = r.swept.find((s) => s.sessionId === 'pinned-x')!;
    const orphan = r.swept.find((s) => s.sessionId === 'orphan-y')!;
    expect(pinned.action).toBe('archived');
    expect(pinned.error).toContain('clearSession failed');
    expect(pinned.sessionCleared).toBeUndefined();
    expect(orphan.action).toBe('archived');
    expect(orphan.error).toBeUndefined();
  });

  it('is idempotent: a second apply run finds nothing', () => {
    writeTranscript('telegram_a', 'orphan-1', 200);
    const opts = {
      dataDir,
      storeDir,
      maxBytes: 100,
      now: FIXED_NOW,
      apply: true,
    };
    const first = sweepOverCapTranscripts(opts);
    expect(first.overCap).toBe(1);
    const second = sweepOverCapTranscripts(opts);
    expect(second.overCap).toBe(0);
    expect(second.swept).toEqual([]);
  });
});
