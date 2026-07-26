import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findTranscriptPath,
  resolveResumeSessionId,
  rotateTranscriptIfTooLarge,
  type RotateHooks,
} from './transcript-rotation.js';

const GROUP = 'guest_example';
const SESSION = '00000000-0000-4000-8000-000000000001';
const PROJECT_KEY = '-Users-example-project-groups-guest-example';
const FIXED_NOW = () => new Date(2026, 5, 7, 15, 11, 4); // 2026-06-07 15:11:04 local

let root: string;
let dataDir: string;
let storeDir: string;

function transcriptDir(): string {
  return path.join(
    dataDir,
    'sessions',
    GROUP,
    '.claude',
    'projects',
    PROJECT_KEY,
  );
}

function writeTranscript(sessionId: string, bytes: number): string {
  const dir = transcriptDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61));
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-rotation-'));
  dataDir = path.join(root, 'data');
  storeDir = path.join(root, 'store');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('findTranscriptPath', () => {
  it('finds the transcript under the group project dir', () => {
    const file = writeTranscript(SESSION, 10);
    expect(findTranscriptPath(GROUP, SESSION, dataDir)).toBe(
      fs.realpathSync(file),
    );
  });

  it('returns undefined when there is no projects dir', () => {
    expect(findTranscriptPath(GROUP, SESSION, dataDir)).toBeUndefined();
  });

  it('returns undefined when the session file is absent', () => {
    writeTranscript('some-other-session', 10);
    expect(findTranscriptPath(GROUP, SESSION, dataDir)).toBeUndefined();
  });

  it('rejects traversal-shaped session ids before constructing a filename', () => {
    writeTranscript(SESSION, 10);
    expect(findTranscriptPath(GROUP, '../../outside', dataDir)).toBeUndefined();
  });

  it('rejects a symlinked or hard-linked transcript final entry', () => {
    const dir = transcriptDir();
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(root, 'outside.jsonl');
    fs.writeFileSync(outside, 'secret');
    const candidate = path.join(dir, `${SESSION}.jsonl`);
    fs.symlinkSync(outside, candidate);
    expect(findTranscriptPath(GROUP, SESSION, dataDir)).toBeUndefined();

    fs.unlinkSync(candidate);
    fs.linkSync(outside, candidate);
    expect(findTranscriptPath(GROUP, SESSION, dataDir)).toBeUndefined();
  });

  it('rejects a symlinked project directory', () => {
    const projects = path.dirname(transcriptDir());
    const outsideProject = path.join(root, 'outside-project');
    fs.mkdirSync(outsideProject, { recursive: true });
    fs.writeFileSync(path.join(outsideProject, `${SESSION}.jsonl`), 'secret');
    fs.mkdirSync(projects, { recursive: true });
    fs.symlinkSync(
      outsideProject,
      path.join(projects, 'poisoned-project'),
      'dir',
    );
    expect(findTranscriptPath(GROUP, SESSION, dataDir)).toBeUndefined();
  });
});

describe('rotateTranscriptIfTooLarge', () => {
  const opts = () => ({ dataDir, storeDir, maxBytes: 100, now: FIXED_NOW });

  it('does not rotate a transcript within the cap', () => {
    const file = writeTranscript(SESSION, 100); // exactly at cap → keep
    const result = rotateTranscriptIfTooLarge(GROUP, SESSION, opts());
    expect(result).toBeNull();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('does not rotate when the transcript is absent', () => {
    expect(rotateTranscriptIfTooLarge(GROUP, SESSION, opts())).toBeNull();
  });

  it('archives an over-cap transcript and reports the move', () => {
    const file = writeTranscript(SESSION, 101); // over cap
    const result = rotateTranscriptIfTooLarge(GROUP, SESSION, opts());

    expect(result).not.toBeNull();
    expect(result!.bytes).toBe(101);
    expect(result!.archiveError).toBeUndefined();

    // Original is gone, archive exists with the conventional name.
    expect(fs.existsSync(file)).toBe(false);
    const expectedArchive = path.join(
      storeDir,
      'archive',
      'sessions',
      `${SESSION}.archived-20260607-151104.jsonl`,
    );
    expect(result!.archivedPath).toBe(expectedArchive);
    expect(fs.existsSync(expectedArchive)).toBe(true);
    expect(fs.statSync(expectedArchive).size).toBe(101);
  });

  it('respects the configured byte cap', () => {
    writeTranscript(SESSION, 50_000);
    // 40MB-style cap: 50KB transcript stays put.
    expect(
      rotateTranscriptIfTooLarge(GROUP, SESSION, {
        dataDir,
        storeDir,
        maxBytes: 40 * 1024 * 1024,
        now: FIXED_NOW,
      }),
    ).toBeNull();
  });
});

describe('resolveResumeSessionId', () => {
  function hooks(spy: {
    cleared: string[];
    rotated: Array<{ bytes: number; folder: string }>;
    errors: unknown[];
  }): RotateHooks {
    return {
      clearSession: (folder) => spy.cleared.push(folder),
      onRotated: (info, folder) =>
        spy.rotated.push({ bytes: info.bytes, folder }),
      onError: (err) => spy.errors.push(err),
    };
  }

  function spy() {
    return {
      cleared: [] as string[],
      rotated: [] as Array<{ bytes: number; folder: string }>,
      errors: [] as unknown[],
    };
  }

  it('returns the same id and does nothing when undefined', () => {
    const s = spy();
    expect(
      resolveResumeSessionId(GROUP, undefined, hooks(s), {
        dataDir,
        storeDir,
        maxBytes: 100,
      }),
    ).toBeUndefined();
    expect(s.cleared).toEqual([]);
    expect(s.rotated).toEqual([]);
  });

  it('returns the same id when the transcript is healthy', () => {
    writeTranscript(SESSION, 10);
    const s = spy();
    const out = resolveResumeSessionId(GROUP, SESSION, hooks(s), {
      dataDir,
      storeDir,
      maxBytes: 100,
    });
    expect(out).toBe(SESSION);
    expect(s.cleared).toEqual([]);
    expect(s.rotated).toEqual([]);
  });

  it('rejects and clears an unsafe stored session id', () => {
    const s = spy();
    expect(
      resolveResumeSessionId(GROUP, '../../outside', hooks(s), {
        dataDir,
        storeDir,
        maxBytes: 100,
      }),
    ).toBeUndefined();
    expect(s.cleared).toEqual([GROUP]);
    expect(s.rotated).toEqual([]);
  });

  it('rotates, clears the session, and forces a fresh id when over cap', () => {
    writeTranscript(SESSION, 200);
    const s = spy();
    const out = resolveResumeSessionId(GROUP, SESSION, hooks(s), {
      dataDir,
      storeDir,
      maxBytes: 100,
      now: FIXED_NOW,
    });
    expect(out).toBeUndefined(); // fresh session forced
    expect(s.cleared).toEqual([GROUP]);
    expect(s.rotated).toEqual([{ bytes: 200, folder: GROUP }]);
    expect(s.errors).toEqual([]);
  });

  it('never throws and keeps the session if clearSession throws', () => {
    writeTranscript(SESSION, 200);
    const s = spy();
    const out = resolveResumeSessionId(
      GROUP,
      SESSION,
      {
        clearSession: () => {
          throw new Error('db locked');
        },
        onRotated: (info, folder) =>
          s.rotated.push({ bytes: info.bytes, folder }),
        onError: (err) => s.errors.push(err),
      },
      { dataDir, storeDir, maxBytes: 100, now: FIXED_NOW },
    );
    // Still rolls onto a fresh session (rotation already moved the file).
    expect(out).toBeUndefined();
    expect(s.errors).toHaveLength(1);
    expect(s.rotated).toHaveLength(1);
  });
});
