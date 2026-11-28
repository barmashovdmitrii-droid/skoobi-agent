import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';

afterEach(() => vi.restoreAllMocks());

describe('readBoundedRegularFileNoFollowSync', () => {
  it('reads one stable single-link regular file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-safe-read-'));
    const file = path.join(root, 'value');
    fs.writeFileSync(file, 'stable');
    try {
      expect(
        readBoundedRegularFileNoFollowSync(file, {
          maxBytes: 64,
          oversize: 'reject',
          requireSingleLink: true,
        }).buffer.toString('utf8'),
      ).toBe('stable');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when same-fd metadata changes during the read', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-safe-race-'));
    const file = path.join(root, 'value');
    fs.writeFileSync(file, 'stable');
    const originalFstat = fs.fstatSync.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const stat = originalFstat(fd);
      calls += 1;
      if (calls === 2) {
        Object.defineProperty(stat, 'ctimeMs', {
          value: stat.ctimeMs + 1,
        });
      }
      return stat;
    }) as typeof fs.fstatSync);
    try {
      expect(() =>
        readBoundedRegularFileNoFollowSync(file, {
          maxBytes: 64,
          oversize: 'reject',
          requireSingleLink: true,
        }),
      ).toThrow(/changed while being read/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
