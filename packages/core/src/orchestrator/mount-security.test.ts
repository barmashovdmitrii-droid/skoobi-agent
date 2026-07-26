import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalHome = process.env.HOME;
const originalCwd = process.cwd();
let cleanupDirs: string[] = [];

function mkdirp(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeFile(p: string, content = 'x'): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

async function loadWithIsolatedConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-security-test-'));
  cleanupDirs.push(root);
  const home = mkdirp(path.join(root, 'home'));
  const stateRoot = mkdirp(path.join(root, 'state'));
  const allowedRoot = mkdirp(path.join(root, 'allowed'));
  const configDir = mkdirp(path.join(home, '.config', 'claudeclaw'));
  fs.writeFileSync(
    path.join(configDir, 'mount-allowlist.json'),
    JSON.stringify(
      {
        allowedRoots: [
          {
            path: root,
            allowReadWrite: true,
            description: 'wide test root',
          },
        ],
        blockedPatterns: [],
        nonMainReadOnly: false,
        disableDefaultBlockedPatterns: true,
      },
      null,
      2,
    ),
  );

  process.env.HOME = home;
  process.chdir(stateRoot);
  vi.resetModules();
  const mod = await import('./mount-security.js');
  return { ...mod, root, stateRoot, allowedRoot };
}

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  vi.resetModules();
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('mount-security guest hardening', () => {
  it('forces non-main mounts read-only and keeps default sensitive blocks even for broad allowlists', async () => {
    const { validateMount, stateRoot, allowedRoot } =
      await loadWithIsolatedConfig();
    const publicFile = writeFile(path.join(allowedRoot, 'public.txt'));
    const sshKey = writeFile(path.join(allowedRoot, '.ssh', 'id_ed25519'));
    const envFile = writeFile(path.join(allowedRoot, '.env'));
    const rawDb = writeFile(path.join(stateRoot, 'store', 'messages.db'));
    const otherTenantFile = writeFile(
      path.join(stateRoot, 'groups', 'other-tenant', 'secret.txt'),
    );

    expect(
      validateMount(
        { hostPath: publicFile, containerPath: 'public.txt', readonly: false },
        false,
      ),
    ).toMatchObject({ allowed: true, effectiveReadonly: true });

    for (const hostPath of [sshKey, envFile, rawDb, otherTenantFile]) {
      expect(
        validateMount(
          { hostPath, containerPath: path.basename(hostPath) },
          false,
        ),
      ).toMatchObject({ allowed: false });
    }
  });

  it('keeps guest mounts read-only even when nonMainReadOnly:false (field cannot grant write)', async () => {
    // Finding #58: the isolated config sets nonMainReadOnly:false. A non-main
    // group requesting read-write under a writable allowed root must STILL be
    // forced read-only — the field can only ever add restriction, never weaken
    // guest isolation. A trusted main group on the same mount keeps read-write.
    const { validateMount, allowedRoot } = await loadWithIsolatedConfig();
    const writableFile = writeFile(path.join(allowedRoot, 'rw.txt'));

    expect(
      validateMount(
        { hostPath: writableFile, containerPath: 'rw.txt', readonly: false },
        false,
      ),
    ).toMatchObject({ allowed: true, effectiveReadonly: true });

    expect(
      validateMount(
        { hostPath: writableFile, containerPath: 'rw.txt', readonly: false },
        true,
      ),
    ).toMatchObject({ allowed: true, effectiveReadonly: false });
  });
});
