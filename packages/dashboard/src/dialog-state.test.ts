import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isDialogStateJid,
  readDialogState,
  setDialogAlias,
  setDialogLink,
  setDialogPinned,
} from './dialog-state.js';

let root: string;
let stateFile: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-dialog-state-'));
  stateFile = path.join(root, 'store', 'dashboard-dialog-state.json');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('dialog local state', () => {
  it('stores pins and aliases atomically in a private local file', () => {
    setDialogPinned('tg:123456789', true, stateFile);
    setDialogAlias('tg:123456789', '  Главный   чат  ', stateFile);
    expect(readDialogState(stateFile)).toMatchObject({
      pinned: ['tg:123456789'],
      aliases: { 'tg:123456789': 'Главный чат' },
    });
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);

    setDialogPinned('tg:123456789', false, stateFile);
    setDialogAlias('tg:123456789', '', stateFile);
    expect(readDialogState(stateFile)).toMatchObject({
      pinned: [],
      aliases: {},
    });
  });

  it('links and unlinks two dialogs symmetrically', () => {
    const telegram = 'tg:123456789';
    const whatsapp = '77012345678@s.whatsapp.net';
    setDialogLink(telegram, whatsapp, true, stateFile);
    expect(readDialogState(stateFile).links).toEqual({
      [telegram]: [whatsapp],
      [whatsapp]: [telegram],
    });
    setDialogLink(telegram, whatsapp, false, stateFile);
    expect(readDialogState(stateFile).links).toEqual({});
  });

  it('does not overwrite a corrupted existing state file', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '{broken', { mode: 0o600 });
    expect(() => setDialogPinned('tg:123456789', true, stateFile)).toThrow(
      'повреждён',
    );
    expect(fs.readFileSync(stateFile, 'utf-8')).toBe('{broken');

    fs.writeFileSync(stateFile, JSON.stringify({ pinned: 'not-an-array' }));
    expect(() => setDialogPinned('tg:123456789', true, stateFile)).toThrow(
      'повреждён',
    );
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8'))).toEqual({
      pinned: 'not-an-array',
    });
  });

  it.each([
    '../secret',
    'tg:1 OR 1=1',
    '1234@s.whatsapp.net',
    '77012345678@s.whatsapp.invalid',
  ])('rejects malformed identifiers %s', (jid) => {
    expect(isDialogStateJid(jid)).toBe(false);
    expect(() => setDialogPinned(jid, true, stateFile)).toThrow();
  });

  it('rejects aliases with controls or excessive length', () => {
    expect(() =>
      setDialogAlias('tg:123456789', 'x'.repeat(81), stateFile),
    ).toThrow();
    expect(() =>
      setDialogAlias('tg:123456789', 'name\u0000hidden', stateFile),
    ).toThrow();
  });
});
