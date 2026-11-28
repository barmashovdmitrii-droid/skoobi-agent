import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { secureAuthDirectory, writePrivateFile } from './auth-storage.js';

describe('WhatsApp private auth storage', () => {
  let root: string;
  let originalUmask: number;

  beforeEach(() => {
    originalUmask = process.umask();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-wa-auth-'));
  });

  afterEach(() => {
    process.umask(originalUmask);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('enforces directory 0700, file 0600, and umask 077', () => {
    const authDir = path.join(root, 'auth');
    const nested = path.join(authDir, 'keys');
    fs.mkdirSync(nested, { recursive: true, mode: 0o755 });
    const keyFile = path.join(nested, 'key.json');
    fs.writeFileSync(keyFile, '{}', { mode: 0o644 });
    fs.chmodSync(authDir, 0o755);
    fs.chmodSync(nested, 0o755);
    fs.chmodSync(keyFile, 0o644);

    secureAuthDirectory(authDir);

    expect(fs.statSync(authDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(nested).mode & 0o777).toBe(0o700);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(process.umask()).toBe(0o077);
  });

  it('fails closed when the auth root is a symlink', () => {
    const target = path.join(root, 'target');
    const authLink = path.join(root, 'auth');
    fs.mkdirSync(target);
    fs.symlinkSync(target, authLink);

    expect(() => secureAuthDirectory(authLink)).toThrow('real directory');
  });

  it('fails closed when an auth entry is a symlink', () => {
    const authDir = path.join(root, 'auth');
    fs.mkdirSync(authDir);
    fs.symlinkSync(path.join(root, 'outside'), path.join(authDir, 'key.json'));

    expect(() => secureAuthDirectory(authDir)).toThrow(
      'must not contain symlinks',
    );
  });

  it('fails closed when the auth tree contains a special file', async () => {
    const authDir = path.join(root, 'auth');
    const socketPath = path.join(authDir, 'unexpected.sock');
    fs.mkdirSync(authDir);
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      expect(() => secureAuthDirectory(authDir)).toThrow('special file');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('writes setup status and QR files as 0600', () => {
    const statusFile = path.join(root, 'store', 'auth-status.txt');
    writePrivateFile(statusFile, 'ready');

    expect(fs.readFileSync(statusFile, 'utf8')).toBe('ready');
    expect(fs.statSync(statusFile).mode & 0o777).toBe(0o600);
  });

  it('does not follow a dangling symlink for a private setup file', () => {
    const storeDir = path.join(root, 'store');
    const outside = path.join(root, 'outside-secret');
    const statusFile = path.join(storeDir, 'auth-status.txt');
    fs.mkdirSync(storeDir);
    fs.symlinkSync(outside, statusFile);

    expect(() => writePrivateFile(statusFile, 'secret')).toThrow(
      'regular file',
    );
    expect(fs.existsSync(outside)).toBe(false);
  });
});
