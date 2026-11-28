import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCodexReserveInputConfig,
  codexThreadRotationReason,
} from './message-loop.js';

vi.mock('./codex-accounting.js', async (original) => ({
  ...(await original<typeof import('./codex-accounting.js')>()),
  codexAccountUsedPercentAcrossHomes: () => 89,
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

function withEnvFile(lines: string[]): void {
  const dir = fs.mkdtempSync(
    path.join(process.env.SKOOBI_TEST_STATE_ROOT!, 'tier-rotate-'),
  );
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, lines.join('\n'));
  vi.stubEnv('CLAUDECLAW_ENV_FILE', envPath);
}

const LIVE_ENV = [
  'SKOOBI_CODEX_SUBSCRIPTION_ENABLED=true',
  'SKOOBI_CODEX_MODEL=gpt-6-astra',
  'SKOOBI_CODEX_REASONING_EFFORT=xhigh',
  'SKOOBI_CODEX_SERVICE_TIER=priority',
  'SKOOBI_CODEX_SERVICE_TIER_MAX_USED_PERCENT=100',
];

describe('W02: the tier rotation switch reaches the runner only when the owner sets it', () => {
  it('is off by default: an .env without the key', () => {
    withEnvFile(LIVE_ENV);
    const config = buildCodexReserveInputConfig(undefined, { hardCapMs: 60_000 });
    expect(config.tierRotate).toBeUndefined();
    // Fast and its ceiling stay exactly as configured.
    expect(config).toMatchObject({
      serviceTier: 'priority',
      serviceTierMaxUsedPercent: 100,
      accountUsedPercent: 89,
    });
  });

  it('SKOOBI_CODEX_TIER_ROTATE=true turns it on; anything else leaves it off', () => {
    withEnvFile([...LIVE_ENV, 'SKOOBI_CODEX_TIER_ROTATE=true']);
    expect(
      buildCodexReserveInputConfig(undefined, { hardCapMs: 60_000 }).tierRotate,
    ).toBe(true);
    withEnvFile([...LIVE_ENV, 'SKOOBI_CODEX_TIER_ROTATE=false']);
    expect(
      buildCodexReserveInputConfig(undefined, { hardCapMs: 60_000 }).tierRotate,
    ).toBeUndefined();
    withEnvFile([...LIVE_ENV, 'SKOOBI_CODEX_TIER_ROTATE=maybe']);
    expect(
      buildCodexReserveInputConfig(undefined, { hardCapMs: 60_000 }).tierRotate,
    ).toBeUndefined();
  });

  it('works without Fast too: a thread born with Fast is moved off it', () => {
    withEnvFile([
      'SKOOBI_CODEX_SUBSCRIPTION_ENABLED=true',
      'SKOOBI_CODEX_TIER_ROTATE=1',
    ]);
    const config = buildCodexReserveInputConfig(undefined, { hardCapMs: 60_000 });
    expect(config.tierRotate).toBe(true);
    expect(config.serviceTier).toBeUndefined();
  });
});

describe('codex_thread_rotated reason', () => {
  it('keeps the known reasons, tier-changed included', () => {
    for (const reason of [
      'context-changed',
      'expired',
      'oversized',
      'tier-changed',
      'stale',
      'resume-error',
    ]) {
      expect(codexThreadRotationReason(reason)).toBe(reason);
    }
    expect(codexThreadRotationReason('whatever')).toBe('unknown');
    expect(codexThreadRotationReason(undefined)).toBe('unknown');
  });
});
