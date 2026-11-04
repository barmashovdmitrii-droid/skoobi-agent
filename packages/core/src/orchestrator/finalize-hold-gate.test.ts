


import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STATE_ROOT } from './config.js';
import { finalizeHoldEnabledForGroup } from './live-mode.js';
import {
  finalizeHoldEventPayload,
  finalizeHoldForRun,
} from './message-loop.js';

describe('гейт доработки (SKOOBI_FINALIZE_HOLD_GROUPS)', () => {
  const KEYS = ['SKOOBI_FINALIZE_HOLD_GROUPS', 'CLAUDECLAW_ENV_FILE'] as const;
  const saved: Record<string, string | undefined> = {};
  const killSwitch = path.join(STATE_ROOT, 'store', 'finalize-hold.disabled');
  let envDir = '';

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    for (const key of KEYS) delete process.env[key];
    // Tests use isolated configuration and do not load a local .env file.
    envDir = fs.mkdtempSync(path.join(STATE_ROOT, 'hold-env-'));
    process.env.CLAUDECLAW_ENV_FILE = path.join(envDir, 'missing.env');
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(killSwitch, { force: true });
    fs.rmSync(envDir, { recursive: true, force: true });
  });

  it('без ключа — только чат владельца, у остальных выключено', () => {
    expect(finalizeHoldEnabledForGroup('telegram_main')).toBe(true);
    expect(finalizeHoldEnabledForGroup('telegram_admin')).toBe(false);
    expect(finalizeHoldEnabledForGroup('whatsapp_main')).toBe(false);
    expect(finalizeHoldEnabledForGroup('')).toBe(false);
  });

  it('список из .env заменяет умолчание; off — выключено везде', () => {
    process.env.SKOOBI_FINALIZE_HOLD_GROUPS = 'telegram_main, telegram_admin';
    expect(finalizeHoldEnabledForGroup('telegram_admin')).toBe(true);
    process.env.SKOOBI_FINALIZE_HOLD_GROUPS = 'telegram_admin';
    expect(finalizeHoldEnabledForGroup('telegram_main')).toBe(false);
    for (const off of ['off', 'none', 'OFF']) {
      process.env.SKOOBI_FINALIZE_HOLD_GROUPS = off;
      expect(finalizeHoldEnabledForGroup('telegram_main'), off).toBe(false);
    }
  });

  it('читает .env, когда в окружении ключа нет', () => {
    const envFile = path.join(envDir, '.env');
    fs.writeFileSync(envFile, 'SKOOBI_FINALIZE_HOLD_GROUPS=none\n');
    process.env.CLAUDECLAW_ENV_FILE = envFile;
    expect(finalizeHoldEnabledForGroup('telegram_main')).toBe(false);
  });

  it('store/finalize-hold.disabled выключает без рестарта', () => {
    fs.mkdirSync(path.dirname(killSwitch), { recursive: true });
    fs.writeFileSync(killSwitch, '');
    expect(finalizeHoldEnabledForGroup('telegram_main')).toBe(false);
    fs.rmSync(killSwitch);
    expect(finalizeHoldEnabledForGroup('telegram_main')).toBe(true);
  });
});

describe('finalizeHoldForRun', () => {
  const plainOwnerTurn = {
    folder: 'telegram_main',
    autoRoute: true,
    inboundOnly: false,
    voiceReplyRequested: false,
    indirectOwnerContent: false,
    untrustedContentAttached: false,
    imageJob: false,
  };
  const enabled = (folder: string) => folder === 'telegram_main';

  it('выдаётся обычному текстовому ходу включённой группы', () => {
    expect(finalizeHoldForRun(plainOwnerTurn, enabled)).toBe(true);
    expect(
      finalizeHoldForRun(
        { ...plainOwnerTurn, folder: 'telegram_admin' },
        enabled,
      ),
    ).toBe(false);
  });

  it('никогда — ходу с чужим текстом, голосом, картинкой или без автоответа', () => {
    for (const override of [
      { indirectOwnerContent: true },
      { untrustedContentAttached: true },
      { voiceReplyRequested: true },
      { inboundOnly: true },
      { autoRoute: false },
      { imageJob: true },
    ]) {
      expect(
        finalizeHoldForRun({ ...plainOwnerTurn, ...override }, enabled),
        JSON.stringify(override),
      ).toBe(false);
    }
  });
});

describe('событие late_followup_merged из кадра раннера', () => {
  it('берёт исход, код причины и целые неотрицательные числа', () => {
    expect(
      finalizeHoldEventPayload({
        outcome: 'merged',
        newerMessages: 1,
        turnAgeMs: 205_000,
        holdMs: 41_000,
      }),
    ).toEqual({
      outcome: 'merged',
      newer_messages: 1,
      turn_age_ms: 205_000,
      hold_ms: 41_000,
    });
    expect(
      finalizeHoldEventPayload({
        outcome: 'skipped',
        reason: 'long-message',
        newerMessages: 2,
        turnAgeMs: 780_000,
        text: 'Да нужен автомат',
      }),
    ).toEqual({
      outcome: 'skipped',
      reason: 'long-message',
      newer_messages: 2,
      turn_age_ms: 780_000,
    });
  });

  it('кривой кадр не становится событием, кривая причина отбрасывается', () => {
    expect(finalizeHoldEventPayload(null)).toBeNull();
    expect(finalizeHoldEventPayload(['merged'])).toBeNull();
    expect(
      finalizeHoldEventPayload({
        outcome: 'rewrote-everything',
        newerMessages: 1,
        turnAgeMs: 1,
      }),
    ).toBeNull();
    expect(
      finalizeHoldEventPayload({
        outcome: 'ping',
        newerMessages: 1.5,
        turnAgeMs: 1,
      }),
    ).toBeNull();
    expect(
      finalizeHoldEventPayload({ outcome: 'ping', newerMessages: 1 }),
    ).toBeNull();
    expect(
      finalizeHoldEventPayload({
        outcome: 'failed',
        reason: 'Error: boom at /Users/example/project',
        newerMessages: 1,
        turnAgeMs: 1,
        holdMs: -5,
      }),
    ).toEqual({ outcome: 'failed', newer_messages: 1, turn_age_ms: 1 });
  });
});
