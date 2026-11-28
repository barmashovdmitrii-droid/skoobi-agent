import { describe, expect, it } from 'vitest';

import {
  checkFactoryPlatformManifest,
  getFactoryPlatformProfile,
} from './game-factory-platforms.js';
import type { FactoryManifest } from './game-factory-artifacts.js';

const manifest: FactoryManifest = {
  sourceRoot: '/fixture',
  entrypoint: 'index.html',
  totalBytes: 100,
  manifestSha256: 'a'.repeat(64),
  files: [{ path: 'index.html', sha256: 'b'.repeat(64), size: 100 }],
};

describe('dated factory platform preflight', () => {
  it('separates CrazyGames Basic from Full without implying monetization or portal approval', () => {
    expect(getFactoryPlatformProfile('crazygames', 'basic').sdk).toBe(
      'optional',
    );
    expect(getFactoryPlatformProfile('crazygames', 'full').sdk).toBe(
      'required',
    );
    expect(
      getFactoryPlatformProfile('crazygames', 'basic').manualRequirements.join(
        ' ',
      ),
    ).toContain('monetization disabled');
    const result = checkFactoryPlatformManifest({
      platform: 'crazygames',
      manifest,
    });
    expect(result.status).toBe('pass');
    expect(result.releaseReady).toBe(false);
    expect(result.checks.some((check) => check.result === 'unknown')).toBe(
      true,
    );
  });

  it('checks actual Yandex bundle limits and names without pretending to test the SDK', () => {
    const result = checkFactoryPlatformManifest({
      platform: 'yandex',
      manifest: {
        ...manifest,
        entrypoint: 'nested/game.html',
        totalBytes: 100_000_001,
        files: [
          { path: 'nested/игра one.html', sha256: 'a'.repeat(64), size: 100 },
        ],
      },
    });
    expect(
      result.checks
        .filter((check) => check.result === 'fail')
        .map((check) => check.id),
    ).toEqual([
      'html_entrypoint',
      'total_bytes',
      'root_index',
      'portable_names',
    ]);
    expect(result.profile.sdk).toBe('required');
  });

  it('enforces CrazyGames file count and requires the separate Roblox engine path', () => {
    const result = checkFactoryPlatformManifest({
      platform: 'crazygames',
      manifest: {
        ...manifest,
        files: Array.from({ length: 1501 }, (_, i) => ({
          path: i === 0 ? 'index.html' : `${i}.js`,
          size: 0,
          sha256: 'a'.repeat(64),
        })),
      },
    });
    expect(result.status).toBe('fail');
    const roblox = checkFactoryPlatformManifest({
      platform: 'roblox',
      manifest,
    });
    expect(roblox.status).toBe('not_applicable');
    expect(roblox.profile.enginePath).toBe('roblox_studio');
    expect(roblox.releaseReady).toBe(false);
  });
});
