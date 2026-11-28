import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import {
  assembleSystemContext,
  buildClaudeclawMcpEnv,
  codexSleepToolReplaced,
  buildCodexPreambleSet,
  buildSdkEnv,
  CODEX_THREAD_MAX_AGE_MS,
  CODEX_THREAD_MAX_ROLLOUT_BYTES,
  CODEX_THREAD_OVERSIZE_IDLE_MS,
  CODEX_THREAD_ROLLOUT_HARD_BYTES,
  codexHeartbeatAlive,
  codexPreambleForFreshThread,
  codexRolloutStat,
  codexThreadPersistenceDecision,
  codexTurnErrorOutput,
  codexTurnTelemetry,
  codexFastTierDropNote,
  combineTurnAccounting,
  countPipedMessages,
  drainIpcInputDetailed,
  deferredResultDraft,
  elideUnchangedStandingBlocks,
  FOLLOW_UP_CONTINUATION_NOTE,
  followUpContinuationNote,
  interimProgressSuppressedOnRetry,
  ipcBatchArrivedDuringTurn,
  isErrorResultMessage,
  linkCheckGateForInput,
  mergeTurnAccounting,
  neutralizeOutputMarkers,
  memoryRuntimeIsolationOptions,
  persistCodexThread,
  promptCarriesHostClaudeMd,
  shouldClearThreadAfterResumeError,
  shouldDropAnchoredFreshThread,
  shouldRetryCodexStaleThreadFresh,
  shouldRotateCodexThread,
  standingBlocksHeldAfterCompaction,
  STANDING_STUB_MAX_BYTES,
  standingStateAfterCompaction,
  standingStateAfterTurn,
  standingStateFromMeta,
} from './index.js';
import {
  buildCodexPreamble,
  CODEX_KEPT_IMAGE_BYTES,
  codexCompactionRetainedUserTexts,
} from './codex-exec.js';
import {
  FINALIZE_HOLD_FALLBACK_NOTE,
  finalizeHoldFallbackNote,
  joinIpcInputWithHoldNote,
  markFailedHoldInput,
  peekIpcInputFiles,
  runFinalizeHold,
  takeIpcInputFiles,
} from './finalize-hold.js';

import {
  TASK_CONTINUITY_POLICY,
  withTaskContinuityPolicy,
} from './task-continuity.js';

describe('deferred image evidence', () => {
  it('keeps generated artifact references in the persisted continuation without claiming delivery', () => {
    const draft = deferredResultDraft({
      text: 'The draft illustration is ready.',
      imageGenerationCompleted: true,
      imageArtifacts: [
        { callId: 'fixture-image', savedPath: '/tmp/fixture-output.png' },
      ],
    });
    expect(draft).toContain('fixture-image');
    expect(draft).toContain('/tmp/fixture-output.png');
    expect(draft).toContain('доставка пользователю не подтверждена');
    expect(draft).toContain('не отправляй старый вариант автоматически');
    expect(draft).toContain('The draft illustration is ready.');
  });
});

describe('task continuity context wiring', () => {
  it('updates a resumed thread without changing its existing preamble identity', () => {
    const input = {
      prompt: 'continue', groupFolder: 'test', chatJid: 'tg:1', isMain: true,
      agentConfig: { systemPrompt: 'Existing scoped rules.' },
    };
    const legacy = buildCodexPreambleSet({
      systemContext: 'Existing scoped rules.', cwd: '/nonexistent-test-workspace',
      includeWorkspaceClaudeMd: false,
    });
    const current = buildCodexPreambleSet({
      systemContext: assembleSystemContext(input, false),
      cwd: '/nonexistent-test-workspace', includeWorkspaceClaudeMd: false,
    });
    expect(current.identityHash).toBe(legacy.identityHash);
    expect(current.bare).toBe(legacy.bare);
    expect(assembleSystemContext(input)).toContain(TASK_CONTINUITY_POLICY);
    const prompt = withTaskContinuityPolicy('continue the existing task');
    const first = elideUnchangedStandingBlocks(prompt, {});
    expect(first.prompt).toContain(TASK_CONTINUITY_POLICY);
    expect(first.blocks.task_continuity).toBeTruthy();
    const resumed = elideUnchangedStandingBlocks(prompt, first.blocks);
    expect(resumed.prompt).toContain('<task_continuity unchanged="true"/>');
    expect(resumed.prompt).toContain('continue the existing task');
    expect(resumed.prompt).not.toContain(TASK_CONTINUITY_POLICY);
    // The production runner clears standing hashes on compaction/fresh retry.
    expect(elideUnchangedStandingBlocks(prompt, {}).prompt).toBe(prompt);
    const changed = prompt.replace('Keep the latest unfinished', 'Preserve the latest unfinished');
    expect(elideUnchangedStandingBlocks(changed, first.blocks).prompt).toBe(changed);
  });

  it('adds the same policy without erasing guest identity and memory boundaries', () => {
    const context = assembleSystemContext({
      prompt: 'continue', groupFolder: 'test-guest', chatJid: 'tg:2', isMain: false,
      agentConfig: { systemPrompt: 'Guest scoped rules.' },
    });
    expect(context).toContain('<task_continuity>');
    expect(context).toContain('Guest scoped rules.');
    expect(context).toContain('SECURITY BOUNDARY: This is a non-main guest chat');
    expect(context).toContain('do not infer, search for, or reuse administrator or other-user memory');
  });
});

describe('W23: codex sleep gives way to wait_until', () => {
  it('only on a direct owner run that keeps wait_until', () => {
    const env = (direct: string, disallowed = '') => ({
      CLAUDECLAW_IS_DIRECT_OWNER_RUN: direct,
      CLAUDECLAW_DISALLOWED_TOOLS: disallowed,
    });
    expect(codexSleepToolReplaced(env('1'))).toBe(true);
    expect(codexSleepToolReplaced(env('0'))).toBe(false);
    expect(codexSleepToolReplaced(env('1', 'memory_save,wait_until'))).toBe(false);
    expect(codexSleepToolReplaced(env('1', 'mcp__claudeclaw__wait_until'))).toBe(false);
    expect(codexSleepToolReplaced(env('1', '*'))).toBe(false);
  });

  it('the standing rule says to wait with wait_until and to check rarely', () => {
    expect(TASK_CONTINUITY_POLICY).toContain('wait_until');
    expect(TASK_CONTINUITY_POLICY).toMatch(/rarely/);
  });

  // W23-1: правило уходит в каждый ход codex, а wait_until есть только в
  // прямом ходе владельца; плановым, гостевым и WhatsApp-ходам sleep оставлен.
  it('W23-1: a run without wait_until is not told to never sleep', () => {
    const prompt = withTaskContinuityPolicy('Дождись сборки');
    expect(codexSleepToolReplaced({ CLAUDECLAW_IS_DIRECT_OWNER_RUN: '0', CLAUDECLAW_DISALLOWED_TOOLS: '' })).toBe(false);
    expect(prompt).not.toMatch(/never sleep/i);
    expect(prompt).toContain('use wait_until if it is available, instead of sleep');
    expect(prompt).toContain('Without wait_until, wait with sleep.');
    // «Check rarely» holds whatever the waiting tool is.
    expect(prompt).toMatch(/Either way, check a long job's status rarely/);
    expect(prompt).not.toContain('waiting with wait_until in between');
  });
});

describe('buildClaudeclawMcpEnv instance profile', () => {
  const base = { prompt: 'test', groupFolder: 'profile-test', chatJid: 'tg:fixture', isMain: false };

  it('passes the profile of the run input on to the MCP server', () => {
    const env = buildClaudeclawMcpEnv(
      { ...base, instanceProfile: { credentialDetector: { peopleWords: ['образец'] }, prompts: { ownerName: 'Sample Owner' } } },
      undefined,
    );
    const sent = JSON.parse(env.CLAUDECLAW_INSTANCE_PROFILE_JSON);
    expect(sent.credentialDetector.peopleWords).toEqual(['образец']);
    expect(sent.prompts.ownerName).toBe('Sample Owner');
    // Keys the run input did not set travel as their neutral defaults.
    expect(sent.prompts.secretHolderExample).toBe('бухгалтера');
  });

  it('passes nothing for a run without a profile, a neutral one or an unusable one', () => {
    expect(buildClaudeclawMcpEnv(base, undefined).CLAUDECLAW_INSTANCE_PROFILE_JSON).toBe('');
    expect(buildClaudeclawMcpEnv({ ...base, instanceProfile: {} }, undefined).CLAUDECLAW_INSTANCE_PROFILE_JSON).toBe('');
    expect(buildClaudeclawMcpEnv({ ...base, instanceProfile: 'not an object' }, undefined).CLAUDECLAW_INSTANCE_PROFILE_JSON).toBe('');
    // An invalid value falls back to its neutral default instead of travelling on.
    expect(buildClaudeclawMcpEnv({ ...base, instanceProfile: { prompts: { ownerName: 'line\nbreak' } } }, undefined)
      .CLAUDECLAW_INSTANCE_PROFILE_JSON).toBe('');
  });
});

describe('buildClaudeclawMcpEnv owner-only gates', () => {
  it('keeps factory authority separate from Google and out of guest, scheduled and SDK environments', () => {
    const base = { prompt: 'test', groupFolder: 'factory-test', chatJid: 'tg:fixture', isMain: true, credentialProxyTier: 'owner' as const, gameFactoryCapability: 'factory-test-capability' };
    const direct = buildClaudeclawMcpEnv(base, undefined);
    expect(direct.CLAUDECLAW_GAME_FACTORY_CAPABILITY).toBe('factory-test-capability');
    expect(direct.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY).toBe('');
    expect(direct.CLAUDECLAW_IS_DIRECT_OWNER_RUN).toBe('0');
    expect(direct.CLAUDECLAW_CODEX_GUI_CONTROL_AUTHORIZED).toBe('0');
    for (const input of [{ ...base, credentialProxyTier: 'guest' as const }, { ...base, isMain: false }, { ...base, isScheduledTask: true }]) {
      expect(buildClaudeclawMcpEnv(input, undefined).CLAUDECLAW_GAME_FACTORY_CAPABILITY).toBe('');
    }
    expect(buildSdkEnv({ CLAUDECLAW_GAME_FACTORY_CAPABILITY: 'private-capability' })).not.toHaveProperty('CLAUDECLAW_GAME_FACTORY_CAPABILITY');
  });

  it('W27: gives the quota tool this chat\'s CODEX_HOME and the host reading only on an owner run', () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/data/codex-homes/telegram_main';
    const base = { prompt: 'test', groupFolder: 'main', chatJid: 'tg:fixture', isMain: true,
      credentialProxyTier: 'owner' as const, codex: { command: 'codex', model: 'gpt-5.5', accountUsedPercent: 96 } };
    try {
      const owner = buildClaudeclawMcpEnv(base, undefined);
      expect(owner.CLAUDECLAW_CODEX_QUOTA_HOME).toBe('/data/codex-homes/telegram_main');
      expect(owner.CLAUDECLAW_CODEX_HOST_USED_PERCENT).toBe('96');
      // W27-1: the host reading is no later than this runner's start.
      expect(Number(owner.CLAUDECLAW_CODEX_HOST_READ_BY_MS)).toBeGreaterThan(0);
      expect(Number(owner.CLAUDECLAW_CODEX_HOST_READ_BY_MS)).toBeLessThanOrEqual(Date.now());
      expect(buildClaudeclawMcpEnv(base, undefined).CLAUDECLAW_CODEX_HOST_READ_BY_MS)
        .toBe(owner.CLAUDECLAW_CODEX_HOST_READ_BY_MS);
      // An older host passes no snapshot time: the run-start rule stays.
      expect(owner.CLAUDECLAW_CODEX_HOST_READING_AT_MS).toBe('');
      // Сведение с r1110: the host snapshot's own time reaches the tool.
      const timed = buildClaudeclawMcpEnv(
        { ...base, codex: { ...base.codex, accountReadingAtMs: 1_762_700_000_000 } }, undefined);
      expect(timed.CLAUDECLAW_CODEX_HOST_READING_AT_MS).toBe('1762700000000');
      // Review r1111 (turn-2): the host snapshot's windows, only with its time
      // and only to an owner; odd fields stay behind.
      expect(timed.CLAUDECLAW_CODEX_HOST_WINDOWS).toBe('');
      const windows = [{ usedPercent: 96, windowMinutes: 10080, resetsAtMs: 1_794_482_241_000, extra: 'x' }];
      const withWindows = buildClaudeclawMcpEnv(
        { ...base, codex: { ...base.codex, accountReadingAtMs: 1_762_700_000_000, accountWindows: windows } }, undefined);
      expect(JSON.parse(withWindows.CLAUDECLAW_CODEX_HOST_WINDOWS)).toEqual([
        { usedPercent: 96, windowMinutes: 10080, resetsAtMs: 1_794_482_241_000 },
      ]);
      expect(buildClaudeclawMcpEnv({ ...base, codex: { ...base.codex, accountWindows: windows } }, undefined)
        .CLAUDECLAW_CODEX_HOST_WINDOWS).toBe('');
      expect(buildClaudeclawMcpEnv({ ...base, credentialProxyTier: 'guest' as const,
        codex: { ...base.codex, accountReadingAtMs: 1_762_700_000_000, accountWindows: windows } }, undefined)
        .CLAUDECLAW_CODEX_HOST_WINDOWS).toBe('');
      const noHost = buildClaudeclawMcpEnv({ ...base, codex: { ...base.codex, accountUsedPercent: null, accountReadingAtMs: 1_762_700_000_000 } }, undefined);
      expect(noHost.CLAUDECLAW_CODEX_HOST_USED_PERCENT).toBe('');
      expect(noHost.CLAUDECLAW_CODEX_HOST_READ_BY_MS).toBe('');
      expect(noHost.CLAUDECLAW_CODEX_HOST_READING_AT_MS).toBe('');
      for (const input of [{ ...base, credentialProxyTier: 'guest' as const }, { ...base, isMain: false }]) {
        const env = buildClaudeclawMcpEnv(input, undefined);
        expect(env.CLAUDECLAW_CODEX_QUOTA_HOME).toBe('');
        expect(env.CLAUDECLAW_CODEX_HOST_USED_PERCENT).toBe('');
        expect(env.CLAUDECLAW_CODEX_HOST_READ_BY_MS).toBe('');
        expect(buildClaudeclawMcpEnv({ ...input, codex: { ...base.codex, accountReadingAtMs: 1_762_700_000_000 } }, undefined)
          .CLAUDECLAW_CODEX_HOST_READING_AT_MS).toBe('');
      }
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  it('never forwards host Google OAuth and gates helper/public tools on owner tier', () => {
    const codexControlRunId = '00000000-0000-4000-8000-000000000001';
    const previousHelper = process.env.HELPER_SECRET;
    const previousGoogle = process.env.SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN;
    process.env.HELPER_SECRET = 'helper-secret';
    process.env.SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN = 'google-refresh-secret';
    const base = {
      prompt: 'test',
      groupFolder: 'test',
      chatJid: 'tg:1',
      isMain: true,
      agentConfig: {},
      googleAllowedTools: ['google_docs_read'],
      googleSheetTargetHints: [
        {
          label: 'ledger',
          spreadsheetId: 'public-fixture-spreadsheet-id-0001',
          range: "'Лист1'!A47:G1000",
          columnCount: 7,
          maxRowsPerCall: 1,
        },
      ],
    };
    try {
      const downgraded = buildClaudeclawMcpEnv(
        { ...base, credentialProxyTier: 'guest' },
        undefined,
      );
      expect(downgraded.HELPER_SECRET).toBe('');
      expect(downgraded.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS).toBe('');
      expect(downgraded.CLAUDECLAW_GOOGLE_SHEET_TARGET_HINTS_JSON).toBe('[]');
      expect(downgraded.CLAUDECLAW_IS_TRUSTED_OWNER_RUN).toBe('0');
      expect(downgraded.CLAUDECLAW_IS_DIRECT_OWNER_RUN).toBe('0');
      expect(downgraded.CLAUDECLAW_CODEX_GUI_CONTROL_AUTHORIZED).toBe('0');
      expect(downgraded.CLAUDECLAW_CODEX_CONTROL_RUN_ID).toBe('');

      const directOwner = buildClaudeclawMcpEnv(
        {
          ...base,
          credentialProxyTier: 'owner',
          taskAuthorizationCapability: 'direct-capability',
          codexControlRunId,
        },
        undefined,
      );
      expect(directOwner.HELPER_SECRET).toBe('helper-secret');
      expect(directOwner.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS).toBe(
        'google_docs_read',
      );
      expect(
        JSON.parse(directOwner.CLAUDECLAW_GOOGLE_SHEET_TARGET_HINTS_JSON),
      ).toEqual(base.googleSheetTargetHints);
      expect(directOwner.CLAUDECLAW_IS_TRUSTED_OWNER_RUN).toBe('1');
      expect(directOwner.CLAUDECLAW_IS_DIRECT_OWNER_RUN).toBe('1');
      expect(directOwner.CLAUDECLAW_CODEX_GUI_CONTROL_AUTHORIZED).toBe('0');
      expect(directOwner.CLAUDECLAW_CODEX_CONTROL_RUN_ID).toBe(
        codexControlRunId,
      );

      const explicitCodexGuiOwner = buildClaudeclawMcpEnv(
        {
          ...base,
          credentialProxyTier: 'owner',
          taskAuthorizationCapability: 'direct-capability',
          codexGuiControlAuthorized: true,
        },
        undefined,
      );
      expect(
        explicitCodexGuiOwner.CLAUDECLAW_CODEX_GUI_CONTROL_AUTHORIZED,
      ).toBe('1');

      const scheduledOwner = buildClaudeclawMcpEnv(
        {
          ...base,
          credentialProxyTier: 'owner',
          isScheduledTask: true,
          taskAuthorizationCapability: 'scheduled-capability',
          codexGuiControlAuthorized: true,
          codexControlRunId,
        },
        undefined,
      );
      expect(scheduledOwner.CLAUDECLAW_IS_TRUSTED_OWNER_RUN).toBe('1');
      expect(scheduledOwner.CLAUDECLAW_IS_DIRECT_OWNER_RUN).toBe('0');
      expect(scheduledOwner.CLAUDECLAW_CODEX_GUI_CONTROL_AUTHORIZED).toBe('0');
      expect(scheduledOwner.CLAUDECLAW_CODEX_CONTROL_RUN_ID).toBe('');
      // An owner-created scheduled task holding the host capability gets the
      // Google wrappers and the append coordinates its host policy allows,
      // like a direct owner turn (standing access, 28.09).
      expect(scheduledOwner.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS).toBe(
        'google_docs_read',
      );
      expect(
        JSON.parse(scheduledOwner.CLAUDECLAW_GOOGLE_SHEET_TARGET_HINTS_JSON),
      ).toEqual(base.googleSheetTargetHints);
      expect(scheduledOwner.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY).toBe(
        'scheduled-capability',
      );

      const scheduledOwnerWithoutCapability = buildClaudeclawMcpEnv(
        { ...base, credentialProxyTier: 'owner', isScheduledTask: true },
        undefined,
      );
      expect(
        scheduledOwnerWithoutCapability.CLAUDECLAW_GOOGLE_SHEET_TARGET_HINTS_JSON,
      ).toBe('[]');

      const scheduledGuest = buildClaudeclawMcpEnv(
        {
          ...base,
          credentialProxyTier: 'guest',
          isScheduledTask: true,
          taskAuthorizationCapability: 'scheduled-capability',
        },
        undefined,
      );
      expect(scheduledGuest.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS).toBe('');
      expect(scheduledGuest.CLAUDECLAW_GOOGLE_SHEET_TARGET_HINTS_JSON).toBe(
        '[]',
      );
      expect(scheduledGuest.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY).toBe('');

      const scheduledNonMainOwner = buildClaudeclawMcpEnv(
        {
          ...base,
          isMain: false,
          credentialProxyTier: 'owner',
          isScheduledTask: true,
          taskAuthorizationCapability: 'scheduled-capability',
        },
        undefined,
      );
      expect(scheduledNonMainOwner.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS).toBe('');
      expect(
        scheduledNonMainOwner.CLAUDECLAW_GOOGLE_SHEET_TARGET_HINTS_JSON,
      ).toBe('[]');

      const ownerWithoutCapability = buildClaudeclawMcpEnv(
        { ...base, credentialProxyTier: 'owner' },
        undefined,
      );
      expect(ownerWithoutCapability.CLAUDECLAW_IS_TRUSTED_OWNER_RUN).toBe('1');
      expect(ownerWithoutCapability.CLAUDECLAW_IS_DIRECT_OWNER_RUN).toBe('0');
      expect(ownerWithoutCapability.CLAUDECLAW_CODEX_CONTROL_RUN_ID).toBe('');
      expect(
        ownerWithoutCapability.CLAUDECLAW_GOOGLE_SHEET_TARGET_HINTS_JSON,
      ).toBe('[]');
      expect(
        Object.keys(directOwner).some((key) =>
          key.startsWith('SKOOBI_GOOGLE_'),
        ),
      ).toBe(false);
      expect(Object.values(directOwner)).not.toContain('google-refresh-secret');
    } finally {
      if (previousHelper === undefined) delete process.env.HELPER_SECRET;
      else process.env.HELPER_SECRET = previousHelper;
      if (previousGoogle === undefined) {
        delete process.env.SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN;
      } else {
        process.env.SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN = previousGoogle;
      }
    }
  });

  it('passes the chat_history grant only to owner-tier, non-scheduled runs', () => {
    const fixtureSelfJid = `${['1', '555', '000', '0009'].join('')}@s.whatsapp.net`;
    const grant = {
      dbPath: '/state/store/messages.db',
      timeZone: 'Asia/Almaty',
      sources: ['bot', 'whatsapp'] as Array<'bot' | 'whatsapp'>,
      botChatJids: ['tg:100', fixtureSelfJid],
      mediaRoots: { 'tg:100': '/state/groups/telegram_main' },
      observerMediaRoot: '/state/groups/whatsapp_main',
    };
    const base = {
      prompt: 'test',
      groupFolder: 'telegram_main',
      chatJid: 'tg:100',
      isMain: true,
      agentConfig: {},
      chatHistory: grant,
    };

    const owner = buildClaudeclawMcpEnv(
      { ...base, credentialProxyTier: 'owner' },
      undefined,
    );
    expect(owner.CLAUDECLAW_CHAT_HISTORY_DB).toBe('/state/store/messages.db');
    expect(owner.CLAUDECLAW_CHAT_HISTORY_TZ).toBe('Asia/Almaty');
    expect(owner.CLAUDECLAW_CHAT_HISTORY_SOURCES).toBe('bot,whatsapp');
    expect(owner.CLAUDECLAW_CHAT_HISTORY_BOT_JIDS).toBe(
      `tg:100,${fixtureSelfJid}`,
    );
    expect(JSON.parse(owner.CLAUDECLAW_CHAT_HISTORY_MEDIA_ROOTS_JSON)).toEqual(
      grant.mediaRoots,
    );
    expect(owner.CLAUDECLAW_CHAT_HISTORY_OBSERVER_MEDIA_ROOT).toBe(
      '/state/groups/whatsapp_main',
    );

    for (const denied of [
      { ...base, credentialProxyTier: 'guest' as const },
      { ...base, credentialProxyTier: 'owner' as const, isMain: false },
      {
        ...base,
        credentialProxyTier: 'owner' as const,
        isScheduledTask: true,
      },
      {
        ...base,
        credentialProxyTier: 'owner' as const,
        chatHistory: undefined,
      },
      {
        ...base,
        credentialProxyTier: 'owner' as const,
        chatHistory: { ...grant, dbPath: 'store/messages.db' },
      },
      {
        ...base,
        credentialProxyTier: 'owner' as const,
        chatHistory: { ...grant, dbPath: '/state/store/other.db' },
      },
      {
        ...base,
        credentialProxyTier: 'owner' as const,
        chatHistory: {
          ...grant,
          sources: ['bot'] as Array<'bot' | 'whatsapp'>,
          botChatJids: ['not a jid', 'tg:1; DROP'],
        },
      },
    ]) {
      const env = buildClaudeclawMcpEnv(denied, undefined);
      for (const [key, value] of Object.entries(env)) {
        if (key.startsWith('CLAUDECLAW_CHAT_HISTORY_')) {
          expect(value, `${key} for ${JSON.stringify(denied)}`).toBe('');
        }
      }
    }

    // Malformed parts are dropped, never widened.
    const partial = buildClaudeclawMcpEnv(
      {
        ...base,
        credentialProxyTier: 'owner',
        chatHistory: {
          ...grant,
          botChatJids: ['tg:100', 'evil jid'],
          mediaRoots: {
            'tg:100': 'relative/dir',
            'tg:999': '/state/groups/other',
          },
          observerMediaRoot: 'relative',
        },
      },
      undefined,
    );
    expect(partial.CLAUDECLAW_CHAT_HISTORY_BOT_JIDS).toBe('tg:100');
    expect(partial.CLAUDECLAW_CHAT_HISTORY_MEDIA_ROOTS_JSON).toBe('{}');
    expect(partial.CLAUDECLAW_CHAT_HISTORY_OBSERVER_MEDIA_ROOT).toBe('');
  });
});

describe('пометка догоняющему ходу (проверка 09.10, Q4)', () => {
  it('ставится, если хотя бы один IPC-файл лёг до ответа предыдущего хода', () => {
    const note = followUpContinuationNote({
      arrivedDuringTurn: 1,
      messageCount: 1,
    });
    expect(note).toBe(FOLLOW_UP_CONTINUATION_NOTE);
    // Runner output is not a delivery receipt, nor proof the late input
    // was addressed. Preserve pending work instead of only acknowledging it.
    expect(note).toContain('не подтверждает отправку или доставку');
    expect(note).toContain('не означает, что новые сообщения уже учтены');
    expect(note).toContain('незавершённой целью и прежними разрешениями');
    expect(note).toContain('явную отмену, замену задачи и новые ограничения выполни');
    expect(note).toContain('если пользователь его не видел или переспрашивает');
    expect(note).not.toContain('ответ на них уже отправлен');
  });

  it('после сорвавшейся доработки говорит, что ушёл только первый ответ (C12)', () => {
    const note = followUpContinuationNote({
      arrivedDuringTurn: 1,
      messageCount: 1,
      afterFailedHold: true,
    });
    expect(note).toBe(FINALIZE_HOLD_FALLBACK_NOTE);
    expect(note).toBe(finalizeHoldFallbackNote());
    expect(
      followUpContinuationNote({
        arrivedDuringTurn: 2,
        messageCount: 2,
        afterFailedHold: true,
      }),
    ).toContain(`${FINALIZE_HOLD_FALLBACK_NOTE}\n[Это 2 сообщения одной серии`);
  });

  it('после сорвавшейся доработки, которая уже что-то сделала, называет сделанное', () => {
    expect(
      followUpContinuationNote({
        arrivedDuringTurn: 1,
        messageCount: 1,
        afterFailedHold: true,
        holdDoneTools: ['schedule_task'],
      }),
    ).toBe(
      finalizeHoldFallbackNote(['schedule_task']),
    );
  });

  it('не ставится для сообщений, подхваченных после ответа (реакция в 15-секундном ожидании)', () => {
    expect(
      followUpContinuationNote({ arrivedDuringTurn: 0, messageCount: 3 }),
    ).toBeNull();
  });

  it('при нескольких сообщениях добавляет строку про серию', () => {
    const note = followUpContinuationNote({
      arrivedDuringTurn: 2,
      messageCount: 3,
    });
    expect(note).toContain(FOLLOW_UP_CONTINUATION_NOTE);
    expect(note).toContain(
      '[Это 3 сообщения одной серии — ответь на все одним сообщением.]',
    );
    expect(
      followUpContinuationNote({ arrivedDuringTurn: 5, messageCount: 5 }),
    ).toContain('Это 5 сообщений одной серии');
    expect(
      followUpContinuationNote({ arrivedDuringTurn: 1, messageCount: 21 }),
    ).toContain('Это 21 сообщение одной серии');
  });

  it('считает сообщения по обёрткам <message>, а без них — по файлам', () => {
    const twoFiles = [
      '<context timezone="Asia/Almaty" />\n<messages>\n<message sender="A" time="1">раз</message>\n<message sender="A" time="2">два</message>\n</messages>',
      '<context timezone="Asia/Almaty" />\n<messages>\n<message sender="A" time="3">три</message>\n</messages>',
    ].join('\n');
    expect(countPipedMessages(twoFiles, 2)).toBe(3);
    expect(countPipedMessages('голый текст', 2)).toBe(2);
    expect(countPipedMessages('голый текст', 0)).toBe(1);
  });

  it('файл считается «во время хода» по mtime относительно момента ответа', () => {
    const answeredAt = 1_000_000;
    const batch = [
      { mtimeMs: answeredAt - 5_000 },
      { mtimeMs: answeredAt },
      { mtimeMs: answeredAt + 3_000 },
    ];
    expect(ipcBatchArrivedDuringTurn(batch, answeredAt)).toBe(2);
    expect(ipcBatchArrivedDuringTurn(batch, undefined)).toBe(0);
    expect(ipcBatchArrivedDuringTurn([], answeredAt)).toBe(0);
  });
});

describe('повторный «⏳» на перезапуске хода (проверка 09.10, Q2)', () => {
  it('первая попытка хода говорит свободно', () => {
    expect(
      interimProgressSuppressedOnRetry({
        progressEmitted: false,
        progressAttempt: 0,
        supersedeRestarts: 0,
      }),
    ).toBe(false);
    expect(
      interimProgressSuppressedOnRetry({
        progressEmitted: true,
        progressAttempt: 0,
        supersedeRestarts: 0,
      }),
    ).toBe(false);
  });

  it('перезапуск по supersede молчит, если на первой попытке уже что-то ушло', () => {
    expect(
      interimProgressSuppressedOnRetry({
        progressEmitted: true,
        progressAttempt: 0,
        supersedeRestarts: 1,
      }),
    ).toBe(true);
    // Ничего не уходило — перезапущенная попытка говорит сама.
    expect(
      interimProgressSuppressedOnRetry({
        progressEmitted: false,
        progressAttempt: 0,
        supersedeRestarts: 2,
      }),
    ).toBe(false);
  });

  it('свежий тред после stale — как раньше', () => {
    expect(
      interimProgressSuppressedOnRetry({
        progressEmitted: true,
        progressAttempt: 1,
        supersedeRestarts: 0,
      }),
    ).toBe(true);
  });
});

describe('codexTurnErrorOutput', () => {
  it('preserves an ambiguous host-side effect for the orchestrator', () => {
    expect(
      codexTurnErrorOutput({
        status: 'error',
        text: null,
        error: 'stream disconnected',
        modelUsed: 'test-model',
        sideEffected: true,
        sideEffectTools: ['codex_desktop_control'],
      }),
    ).toMatchObject({
      status: 'error',
      error: 'stream disconnected',
      sideEffected: true,
      sideEffectTools: ['codex_desktop_control'],
    });
  });

  it('carries what a failed turn ran with and called', () => {
    const output = codexTurnErrorOutput(
      {
        status: 'error',
        text: null,
        error: 'codex turn timed out: no activity for 600000ms',
        modelUsed: 'test-model',
        modelRequests: 4,
        appliedServiceTier: null,
        accountUsedPercent: 71,
        toolCalls: { exec_command: 3 },
      },
      { requestedServiceTier: null, fastTierDroppedForQuota: true },
    );
    expect(output.codexTurn).toEqual({
      modelRequests: 4,
      serviceTier: null,
      accountUsedPercent: 71,
      toolCalls: { exec_command: 3 },
      requestedServiceTier: null,
      fastTierDroppedForQuota: true,
    });
    // Nothing observed, nothing claimed.
    expect(
      codexTurnErrorOutput({ status: 'error', text: null, modelUsed: 'm' }).codexTurn,
    ).toBeUndefined();
  });

  it('carries the tokens a failed turn burned, and its requests as turns', () => {
    // 25.10: a scheduled turn cut at its 30-minute cap had spent 22.6 M
    // tokens and was written down as 0.
    const output = codexTurnErrorOutput({
      status: 'error',
      text: null,
      error: 'codex turn timed out after 1800000ms',
      modelUsed: 'test-model',
      stopKind: 'cap',
      usage: { inputTokens: 22_400_000, outputTokens: 110_000, cacheReadInputTokens: 21_000_000 },
      usageSource: 'turn_delta',
      modelRequests: 61,
    });
    expect(output.usage).toEqual({
      inputTokens: 22_400_000,
      outputTokens: 110_000,
      cacheReadInputTokens: 21_000_000,
    });
    expect(output.turns).toBe(61);
    expect(output.codexTurn?.usageSource).toBe('turn_delta');
    // A turn that died before the model: still no numbers at all.
    const silent = codexTurnErrorOutput({ status: 'error', text: null, modelUsed: 'm' });
    expect(silent.usage).toBeUndefined();
    expect(silent.turns).toBeUndefined();
  });
});

describe('codexTurnTelemetry', () => {
  it('adds up the turn and its correction, keeps the newest settings and the requested tier', () => {
    expect(
      codexTurnTelemetry(
        {
          usage: { inputTokens: 300, outputTokens: 30 },
          usageSource: 'turn_delta',
          modelRequests: 3,
          appliedServiceTier: 'priority',
          appliedReasoningEffort: 'xhigh',
          accountUsedPercent: 48,
          toolCalls: { view_image: 2, exec_command: 1 },
        },
        {
          usage: { inputTokens: 50, outputTokens: 5 },
          usageSource: 'turn_delta',
          modelRequests: 1,
          appliedServiceTier: 'priority',
          appliedReasoningEffort: 'medium',
          accountUsedPercent: 48.5,
          toolCalls: { exec_command: 1 },
        },
        { requestedServiceTier: 'priority', fastTierDroppedForQuota: false },
      ),
    ).toEqual({
      usageSource: 'turn_delta',
      modelRequests: 4,
      serviceTier: 'priority',
      reasoningEffort: 'medium',
      accountUsedPercent: 48.5,
      toolCalls: { view_image: 2, exec_command: 2 },
      requestedServiceTier: 'priority',
    });
  });

  it('is as honest as its weaker half and empty when nothing was observed', () => {
    expect(
      codexTurnTelemetry(
        { usageSource: 'turn_delta', modelRequests: 2 },
        { usageSource: 'cumulative_counter_reset', modelRequests: 1 },
      ),
    ).toEqual({ usageSource: 'cumulative_counter_reset', modelRequests: 3 });
    expect(
      codexTurnTelemetry({ usageSource: 'cumulative_first_turn' }, { usageSource: 'turn_delta' }),
    ).toEqual({ usageSource: 'cumulative_first_turn' });
    expect(codexTurnTelemetry({ usage: { inputTokens: 1, outputTokens: 1 } })).toBeUndefined();
  });

  it('passes on why the fast tier was dropped (r1109, item 5)', () => {
    expect(
      codexTurnTelemetry({ modelRequests: 1 }, undefined, {
        requestedServiceTier: null,
        fastTierDroppedForQuota: true,
        fastTierDroppedReason: 'no_quota_reading',
      }),
    ).toEqual({
      modelRequests: 1,
      requestedServiceTier: null,
      fastTierDroppedForQuota: true,
      fastTierDroppedReason: 'no_quota_reading',
    });
    // Not dropped: no reason, whatever is passed along.
    expect(
      codexTurnTelemetry({ modelRequests: 1 }, undefined, {
        requestedServiceTier: 'priority',
        fastTierDroppedForQuota: false,
      }),
    ).toEqual({ modelRequests: 1, requestedServiceTier: 'priority' });
    // The line the runner logs, worded as the host's.
    expect(
      codexFastTierDropNote({ fastTierDroppedForQuota: true, fastTierDroppedReason: 'no_quota_reading' }),
    ).toBe(', fast dropped: no quota reading');
    expect(
      codexFastTierDropNote({ fastTierDroppedForQuota: true, fastTierDroppedReason: 'quota_ceiling' }),
    ).toBe(', fast dropped for quota');
    expect(codexFastTierDropNote({ fastTierDroppedForQuota: false })).toBe('');
  });

  it('passes on why a link/overload failure was not retried (W10)', () => {
    expect(codexTurnTelemetry({ transientRetrySkipped: 'acted:command_execution' }))
      .toEqual({ transientRetrySkipped: 'acted:command_execution' });
    expect(codexTurnTelemetry({ modelRequests: 1 })).toEqual({ modelRequests: 1 });
  });

  it('adds up the sub-agent tokens of the turn and its correction', () => {
    expect(
      codexTurnTelemetry({ subagentTokens: 4_000_000 }, { subagentTokens: 770_000 }),
    ).toEqual({ subagentTokens: 4_770_000 });
  });

  it('adds up tool failures and timings, keeps the newest CLI version', () => {
    expect(
      codexTurnTelemetry(
        {
          toolErrors: { view_image: 1, exec: 1 },
          toolExitNonzero: 3,
          toolWallMsTotal: 4_000,
          toolWallMsMax: 2_500,
          codexCliVersion: '0.156.0',
        },
        { toolErrors: { exec: 1 }, toolWallMsTotal: 900, toolWallMsMax: 900 },
      ),
    ).toEqual({
      toolErrors: { view_image: 1, exec: 2 },
      toolExitNonzero: 3,
      toolWallMsTotal: 4_900,
      toolWallMsMax: 2_500,
      codexCliVersion: '0.156.0',
    });
  });
});

describe('memoryRuntimeIsolationOptions', () => {
  it('disables every filesystem memory source and SDK auto-memory for multi-sender guests', () => {
    const options = memoryRuntimeIsolationOptions({
      chatJid: 'tg:-100123',
      isMain: false,
      agentConfig: {},
    });
    expect(options.autoMemoryEnabled).toBe(false);
    expect(options.settingSources).toEqual([]);
    expect(options.sdkEnvOverrides).toEqual({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    });
  });

  it('treats numeric-bot and symbolic-bot Telegram groups as multi-sender', () => {
    for (const chatJid of [
      'tg:bot=9000000001:-100123',
      'tg:skoobi_friend:-100123',
    ]) {
      expect(
        memoryRuntimeIsolationOptions({
          chatJid,
          isMain: false,
          agentConfig: {},
        }),
      ).toMatchObject({
        autoMemoryEnabled: false,
        settingSources: [],
      });
    }
  });

  it('keeps private DM and main project/user sources unchanged', () => {
    expect(
      memoryRuntimeIsolationOptions({
        chatJid: 'tg:555',
        isMain: false,
        agentConfig: {},
      }),
    ).toMatchObject({
      autoMemoryEnabled: true,
      settingSources: ['project', 'user'],
      sdkEnvOverrides: {},
    });
    expect(
      memoryRuntimeIsolationOptions({
        chatJid: 'tg:-100123',
        isMain: true,
        agentConfig: {},
      }),
    ).toMatchObject({
      autoMemoryEnabled: true,
      settingSources: ['project', 'user'],
      sdkEnvOverrides: {},
    });
  });
});

// Must mirror the constants in index.ts (the host stream parser in
// src/runtimes/sandbox-runner.ts locates frames with indexOf on these exact
// strings).
const OUTPUT_START_MARKER = '---CLAUDECLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CLAUDECLAW_OUTPUT_END---';

// A hostile snapshot used to prove the runner's second boundary: unrelated
// host secrets are dropped, while auth-shaped values are assumed to be only
// the one-run credential-proxy placeholders installed by the host runtime.
function sampleHostEnv(): NodeJS.ProcessEnv {
  return {
    // ---- secrets that MUST NOT reach the untrusted guest tool runtime ----
    HELPER_SECRET: 'super-secret-helper-token',
    HELPER_PORT: '3200',
    TELEGRAM_BOT_TOKEN: '123456:telegram-bot-token',
    OPENAI_API_KEY: 'sk-openai-leak',
    AWS_SECRET_ACCESS_KEY: 'aws-leak',
    SOME_OTHER_HOST_SECRET: 'leak-me-not',
    // ---- host-proxy placeholders + endpoint (never real provider auth) ----
    ANTHROPIC_API_KEY: 'one-run-api-placeholder',
    CLAUDE_CODE_OAUTH_TOKEN: 'one-run-oauth-placeholder',
    ANTHROPIC_AUTH_TOKEN: 'real-auth-token-must-not-pass',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
    ANTHROPIC_CUSTOM_HEADERS:
      'x-skoobi-credential-proxy-identity: signed-guest-capability',
    // ---- runtime essentials the SDK / CLI / Bash tool genuinely need ----
    PATH: '/usr/bin:/bin',
    HOME: '/data/sessions/telegram_guest',
    TZ: 'Europe/Moscow',
    SHELL: '/bin/zsh',
    USER: 'node',
    LOGNAME: 'node',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    CLAUDE_TMPDIR: '/data/sessions/telegram_guest/tmp',
    TMPDIR: '/data/sessions/telegram_guest/tmp',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/extra.pem',
    NODE_OPTIONS: '--require=/host/preload.js',
    NODE_PATH: '/host/injected-modules',
    // ---- ClaudeClaw path/IPC wiring (CLAUDECLAW_* family) ----
    CLAUDECLAW_GROUP_DIR: '/data/sessions/telegram_guest/group',
    CLAUDECLAW_IPC_DIR: '/data/sessions/telegram_guest/ipc',
    CLAUDECLAW_SHARED_USER_MEMORY_DIR: '/data/user-memory',
    CLAUDECLAW_RUNNER_IDLE_WAIT_MS: '15000',
    CLAUDECLAW_EXTRA_DIR: '/data/sessions/telegram_guest/extra',
    CLAUDECLAW_EXTRA_DIRS: '["/data/sessions/telegram_guest/extra"]',
    CLAUDECLAW_SKILLS_DIR: '/data/skills',
    CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY: 'future-capability-leak',
    CLAUDECLAW_FAKE_CAPABILITY: 'arbitrary-prefix-leak',
    // ---- prefix families that should pass through ----
    LC_ALL: 'en_US.UTF-8',
    XDG_CONFIG_HOME: '/data/sessions/telegram_guest/.config',
  };
}

describe('buildSdkEnv (guest CLI env allow-list)', () => {
  it('does NOT forward host secrets to the guest tool runtime', () => {
    const env = buildSdkEnv(sampleHostEnv());
    // The shared helper secret must never land in the guest Bash env — it is
    // delivered to the IPC MCP server through its own mcpServers env block.
    expect(env.HELPER_SECRET).toBeUndefined();
    expect(env.HELPER_PORT).toBeUndefined();
    // Unrelated host secrets must be dropped entirely.
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.SOME_OTHER_HOST_SECRET).toBeUndefined();
    // And the values must not have leaked under any other key.
    expect(Object.values(env)).not.toContain('super-secret-helper-token');
    expect(Object.values(env)).not.toContain('123456:telegram-bot-token');
    expect(Object.values(env)).not.toContain('sk-openai-leak');
    expect(Object.values(env)).not.toContain('leak-me-not');
    expect(Object.values(env)).not.toContain('real-auth-token-must-not-pass');
    expect(env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY).toBeUndefined();
    expect(env.CLAUDECLAW_FAKE_CAPABILITY).toBeUndefined();
    expect(Object.values(env)).not.toContain('future-capability-leak');
    expect(Object.values(env)).not.toContain('arbitrary-prefix-leak');
  });

  it('keeps only the host-proxy placeholder + endpoint the CLI needs for model auth', () => {
    const env = buildSdkEnv(sampleHostEnv());
    expect(env.ANTHROPIC_API_KEY).toBe('one-run-api-placeholder');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('one-run-oauth-placeholder');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4000');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      'x-skoobi-credential-proxy-identity: signed-guest-capability',
    );
  });

  it('keeps the runtime essentials the SDK / CLI / Bash tool require', () => {
    const env = buildSdkEnv(sampleHostEnv());
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/data/sessions/telegram_guest');
    expect(env.TZ).toBe('Europe/Moscow');
    expect(env.SHELL).toBe('/bin/zsh');
    expect(env.CLAUDE_TMPDIR).toBe('/data/sessions/telegram_guest/tmp');
    expect(env.TMPDIR).toBe('/data/sessions/telegram_guest/tmp');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/extra.pem');
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
  });

  it('drops credentialed proxy URLs and non-absolute TLS paths', () => {
    const env = buildSdkEnv({
      PATH: '/usr/bin',
      HTTPS_PROXY: [
        'http://proxy-user:',
        'proxy-password',
        '@',
        'proxy.example:8080',
      ].join(''),
      HTTP_PROXY: 'http://127.0.0.1:8123',
      NO_PROXY: '127.0.0.1,localhost',
      SSL_CERT_FILE: 'relative/host-secret.pem',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/extra.pem',
      ANTHROPIC_BASE_URL: [
        'https://user:',
        'password',
        '@',
        'api.example.test',
      ].join(''),
    });
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:8123');
    expect(env.NO_PROXY).toBe('127.0.0.1,localhost');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/extra.pem');
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.SSL_CERT_FILE).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("keeps the MCP transport's default-inherited vars so the IPC server still spawns", () => {
    // @modelcontextprotocol StdioClientTransport spawns the claudeclaw MCP
    // server with getDefaultEnvironment() (HOME, LOGNAME, PATH, SHELL, TERM,
    // USER on POSIX) computed from the CLI's env. If buildSdkEnv stripped any
    // of these, the MCP server could fail to resolve `node`.
    const env = buildSdkEnv(sampleHostEnv());
    for (const key of ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']) {
      expect(env[key], `MCP default-inherited var ${key} must survive`).toBe(
        sampleHostEnv()[key],
      );
    }
  });

  it('forwards the CLAUDECLAW_*/LC_*/XDG_* families and drops everything else', () => {
    const env = buildSdkEnv(sampleHostEnv());
    expect(env.CLAUDECLAW_GROUP_DIR).toBe(
      '/data/sessions/telegram_guest/group',
    );
    expect(env.CLAUDECLAW_IPC_DIR).toBe('/data/sessions/telegram_guest/ipc');
    expect(env.CLAUDECLAW_SHARED_USER_MEMORY_DIR).toBe('/data/user-memory');
    expect(env.CLAUDECLAW_RUNNER_IDLE_WAIT_MS).toBe('15000');
    expect(env.CLAUDECLAW_EXTRA_DIR).toBe(
      '/data/sessions/telegram_guest/extra',
    );
    expect(env.CLAUDECLAW_EXTRA_DIRS).toBe(
      '["/data/sessions/telegram_guest/extra"]',
    );
    expect(env.CLAUDECLAW_SKILLS_DIR).toBe('/data/skills');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.XDG_CONFIG_HOME).toBe('/data/sessions/telegram_guest/.config');
    // Sanity: the result is a strict subset of the source — no invented keys.
    const source = sampleHostEnv();
    for (const key of Object.keys(env)) {
      expect(source).toHaveProperty(key);
    }
  });

  it('omits allow-listed keys that are absent from the source (no undefined injection of secrets)', () => {
    // Minimal env: only PATH present. buildSdkEnv must not fabricate keys.
    const env = buildSdkEnv({ PATH: '/usr/bin' });
    expect(env.PATH).toBe('/usr/bin');
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
    expect('HELPER_SECRET' in env).toBe(false);
    expect(Object.keys(env)).toEqual(['PATH']);
  });
});

describe('isErrorResultMessage (finding #13: do not report error results as success)', () => {
  it('treats a clean success result as NOT an error', () => {
    expect(isErrorResultMessage({ subtype: 'success', is_error: false })).toBe(
      false,
    );
  });

  it('flags every SDKResultError subtype as an error', () => {
    for (const subtype of [
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
    ]) {
      expect(
        isErrorResultMessage({ subtype, is_error: true }),
        `subtype=${subtype} must be classified as error`,
      ).toBe(true);
    }
  });

  it('flags a result marked is_error:true even if the subtype is "success"', () => {
    // Defensive: the SDK type allows is_error on a success-subtype result; if it
    // is ever set we must not deliver that as a clean reply.
    expect(isErrorResultMessage({ subtype: 'success', is_error: true })).toBe(
      true,
    );
  });
});

describe('neutralizeOutputMarkers (finding #34: model text cannot forge frame markers)', () => {
  it('removes the exact END marker so the host indexOf scan cannot split a frame early', () => {
    // A reply that literally contains the END marker (trivially triggerable by
    // asking the agent to print it). Before the fix, the host sliced the frame
    // off at this embedded marker and JSON.parse threw, dropping the reply.
    const output = {
      status: 'success' as const,
      result: `here is the marker: ${OUTPUT_END_MARKER} done`,
      newSessionId: 'sess-123',
    };
    const serialized = neutralizeOutputMarkers(JSON.stringify(output));
    // The serialized envelope must no longer contain the exact marker substring
    // the host searches for.
    expect(serialized.includes(OUTPUT_END_MARKER)).toBe(false);
    expect(serialized.includes(OUTPUT_START_MARKER)).toBe(false);
    // It must still be valid JSON the host can parse, with continuity intact.
    const parsed = JSON.parse(serialized);
    expect(parsed.newSessionId).toBe('sess-123');
    // The reply text survives (only a zero-width breaker was inserted), so the
    // user still gets their answer rather than a dropped turn.
    expect(parsed.result.replace(/​/g, '')).toBe(output.result);
  });

  it('also neutralizes an embedded START marker', () => {
    const serialized = neutralizeOutputMarkers(
      JSON.stringify({ result: `prefix ${OUTPUT_START_MARKER} suffix` }),
    );
    expect(serialized.includes(OUTPUT_START_MARKER)).toBe(false);
    const parsed = JSON.parse(serialized);
    expect(parsed.result.replace(/​/g, '')).toBe(
      `prefix ${OUTPUT_START_MARKER} suffix`,
    );
  });

  it('leaves marker-free payloads byte-for-byte unchanged', () => {
    const serialized = JSON.stringify({
      status: 'success',
      result: 'a perfectly normal reply with no markers',
      newSessionId: 'abc',
    });
    expect(neutralizeOutputMarkers(serialized)).toBe(serialized);
  });
});

describe('shouldRotateCodexThread', () => {
  const NOW = Date.parse('2026-07-04T12:00:00Z');
  const meta = (
    over: Partial<{
      preambleHash: string;
      createdAt: string;
      workspaceClaudeMdHash: string;
    }> = {},
  ) => ({
    preambleHash: 'hash-a',
    createdAt: '2026-07-04T00:00:00Z',
    ...over,
  });

  describe('the runner copy of CLAUDE.md (C25)', () => {
    const rotate = (
      m: ReturnType<typeof meta>,
      workspaceClaudeMdHash: string | undefined,
    ) =>
      shouldRotateCodexThread(
        m,
        'hash-a',
        NOW,
        undefined,
        undefined,
        workspaceClaudeMdHash,
      );

    it('a run with the host copy never rotates for CLAUDE.md', () => {
      expect(
        rotate(meta({ workspaceClaudeMdHash: 'md-old' }), undefined),
      ).toBeNull();
    });

    it('a thread holding the runner copy rotates when that copy changed', () => {
      const held = meta({ workspaceClaudeMdHash: 'md-old' });
      expect(rotate(held, 'md-old')).toBeNull();
      expect(rotate(held, 'md-new')).toBe('context-changed');
      // The file is gone, or the chat may not get it: the copy is stale.
      expect(rotate(held, '')).toBe('context-changed');
    });

    it('a host-copy thread rotates once a run relies on the runner copy', () => {
      expect(rotate(meta(), 'md-new')).toBe('context-changed');
      // No copy on either side (a multi-sender chat): nothing to compare.
      expect(rotate(meta(), '')).toBeNull();
    });
  });

  it('resumes when hash matches and thread is young', () => {
    expect(shouldRotateCodexThread(meta(), 'hash-a', NOW)).toBeNull();
  });

  it('rotates when the preamble hash changed (persona/CLAUDE.md edit)', () => {
    expect(shouldRotateCodexThread(meta(), 'hash-b', NOW)).toBe(
      'context-changed',
    );
  });

  it('rotates a pre-meta (legacy) thread', () => {
    expect(shouldRotateCodexThread(null, 'hash-a', NOW)).toBe(
      'context-changed',
    );
  });

  it('rotates past the age cap, resumes just under it', () => {
    const created = '2026-06-01T00:00:00Z';
    expect(
      shouldRotateCodexThread(meta({ createdAt: created }), 'hash-a', NOW),
    ).toBe('expired');
    expect(
      shouldRotateCodexThread(
        meta({ createdAt: created }),
        'hash-a',
        Date.parse(created) + CODEX_THREAD_MAX_AGE_MS - 1,
      ),
    ).toBeNull();
  });

  it('does not expire a thread with an unparseable createdAt', () => {
    expect(
      shouldRotateCodexThread(meta({ createdAt: 'garbage' }), 'hash-a', NOW),
    ).toBeNull();
  });

  it('rotates a rollout past the soft cap once it has sat idle, resumes just under the cap', () => {
    const idleSince = NOW - CODEX_THREAD_OVERSIZE_IDLE_MS;
    expect(
      shouldRotateCodexThread(
        meta(),
        'hash-a',
        NOW,
        CODEX_THREAD_MAX_ROLLOUT_BYTES + 1,
        idleSince,
      ),
    ).toBe('oversized');
    expect(
      shouldRotateCodexThread(
        meta(),
        'hash-a',
        NOW,
        CODEX_THREAD_MAX_ROLLOUT_BYTES,
        idleSince,
      ),
    ).toBeNull();
  });

  it('never cuts a thread past the soft cap while it is in use', () => {
    // A 224MB fixture — 4 turns, context 0.67 full — would have
    // been dropped on his next message under the old 40MB rule.
    expect(
      shouldRotateCodexThread(
        meta(),
        'hash-a',
        NOW,
        CODEX_THREAD_MAX_ROLLOUT_BYTES + 1,
        NOW - CODEX_THREAD_OVERSIZE_IDLE_MS + 60_000,
      ),
    ).toBeNull();
    // Unknown last write counts as in use.
    expect(
      shouldRotateCodexThread(
        meta(),
        'hash-a',
        NOW,
        CODEX_THREAD_MAX_ROLLOUT_BYTES + 1,
      ),
    ).toBeNull();
  });

  it('rotates past the hard cap even while the thread is in use', () => {
    expect(
      shouldRotateCodexThread(
        meta(),
        'hash-a',
        NOW,
        CODEX_THREAD_ROLLOUT_HARD_BYTES + 1,
        NOW,
      ),
    ).toBe('oversized');
    expect(
      shouldRotateCodexThread(
        meta(),
        'hash-a',
        NOW,
        CODEX_THREAD_ROLLOUT_HARD_BYTES + 1,
      ),
    ).toBe('oversized');
  });

  it('skips the byte check when rolloutBytes is 0/undefined (file not found)', () => {
    expect(shouldRotateCodexThread(meta(), 'hash-a', NOW, 0)).toBeNull();
    expect(
      shouldRotateCodexThread(meta(), 'hash-a', NOW, undefined),
    ).toBeNull();
  });

  it('context-change and expiry take precedence over the byte check', () => {
    const huge = CODEX_THREAD_ROLLOUT_HARD_BYTES + 1;
    expect(shouldRotateCodexThread(meta(), 'hash-b', NOW, huge, 0)).toBe(
      'context-changed',
    );
    expect(
      shouldRotateCodexThread(
        meta({ createdAt: '2026-06-01T00:00:00Z' }),
        'hash-a',
        NOW,
        huge,
        0,
      ),
    ).toBe('expired');
  });
});

describe('CODEX_THREAD_MAX_ROLLOUT_BYTES env override', () => {
  /** Re-import the module with a specific env so the module-load-time
   * constant is recomputed (same shape as RUNNER_IDLE_WAIT_MS). */
  const loadWith = async (value: string | undefined) => {
    const previous = process.env.CLAUDECLAW_CODEX_THREAD_MAX_ROLLOUT_BYTES;
    if (value === undefined)
      delete process.env.CLAUDECLAW_CODEX_THREAD_MAX_ROLLOUT_BYTES;
    else process.env.CLAUDECLAW_CODEX_THREAD_MAX_ROLLOUT_BYTES = value;
    vi.resetModules();
    try {
      return (await import('./index.js')).CODEX_THREAD_MAX_ROLLOUT_BYTES;
    } finally {
      if (previous === undefined)
        delete process.env.CLAUDECLAW_CODEX_THREAD_MAX_ROLLOUT_BYTES;
      else process.env.CLAUDECLAW_CODEX_THREAD_MAX_ROLLOUT_BYTES = previous;
      vi.resetModules();
    }
  };

  it('defaults to 512MB when unset', async () => {
    expect(await loadWith(undefined)).toBe(512 * 1024 * 1024);
  });

  it('honours an operator-configured cap', async () => {
    expect(await loadWith(String(12 * 1024 * 1024))).toBe(12 * 1024 * 1024);
  });

  it('floors at 1MB so a misconfiguration cannot cause rotation churn', async () => {
    expect(await loadWith('1024')).toBe(1024 * 1024);
  });

  it('falls back to the default on a non-numeric value', async () => {
    expect(await loadWith('not-a-number')).toBe(512 * 1024 * 1024);
  });
});

describe('rollout hard cap and idle-age env overrides', () => {
  const HARD = 'CLAUDECLAW_CODEX_THREAD_ROLLOUT_HARD_BYTES';
  const IDLE = 'CLAUDECLAW_CODEX_THREAD_OVERSIZE_IDLE_MS';
  /** Re-import with both keys set (one import per case keeps the module's
   * process listeners under the default limit). */
  const loadWith = async (
    hard: string | undefined,
    idle: string | undefined,
  ) => {
    const previous = { hard: process.env[HARD], idle: process.env[IDLE] };
    const set = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    set(HARD, hard);
    set(IDLE, idle);
    vi.resetModules();
    try {
      const mod = await import('./index.js');
      return {
        hard: mod.CODEX_THREAD_ROLLOUT_HARD_BYTES,
        idle: mod.CODEX_THREAD_OVERSIZE_IDLE_MS,
      };
    } finally {
      set(HARD, previous.hard);
      set(IDLE, previous.idle);
      vi.resetModules();
    }
  };

  it('defaults to a 2GB hard cap and 3 hours of idleness', async () => {
    expect(await loadWith(undefined, undefined)).toEqual({
      hard: 2 * 1024 * 1024 * 1024,
      idle: 3 * 60 * 60 * 1000,
    });
  });

  it('honours operator-configured values', async () => {
    expect(await loadWith(String(900 * 1024 * 1024), '3600000')).toEqual({
      hard: 900 * 1024 * 1024,
      idle: 3_600_000,
    });
  });

  it('floors the hard cap at 1MB and ignores a non-numeric idle age', async () => {
    expect(await loadWith('1024', 'soon')).toEqual({
      hard: 1024 * 1024,
      idle: 3 * 60 * 60 * 1000,
    });
  });
});

describe('CLAUDE.md in the codex preamble (C25)', () => {
  const HOST_BLOCK =
    '<tenant_long_term_context source="CLAUDE.md">\nLong-term same-chat instructions and memory.\n# Правила\n</tenant_long_term_context>\n\n<messages>…</messages>';
  let cwd: string;

  const set = (includeWorkspaceClaudeMd = true) =>
    buildCodexPreambleSet({
      systemContext: 'PERSONA: Скуби.',
      cwd,
      includeWorkspaceClaudeMd,
    });

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-preamble-set-'));
    fs.writeFileSync(
      path.join(cwd, 'CLAUDE.md'),
      '# Правила чата\nОдна мысль.',
    );
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('recognises only the host copy of CLAUDE.md itself', () => {
    expect(promptCarriesHostClaudeMd(HOST_BLOCK)).toBe(true);
    // AGENT.md/SKOOBI.md is another file: CLAUDE.md still needs the copy.
    expect(
      promptCarriesHostClaudeMd(
        '<tenant_long_term_context source="AGENT.md">x</tenant_long_term_context>',
      ),
    ).toBe(false);
    // The stub of an unchanged block is not a copy, and plain text is not one.
    expect(
      promptCarriesHostClaudeMd('<tenant_long_term_context unchanged="true"/>'),
    ).toBe(false);
    expect(promptCarriesHostClaudeMd('<messages>привет</messages>')).toBe(
      false,
    );
  });

  it('a fresh thread with the host copy gets one copy, not two', () => {
    const fresh = codexPreambleForFreshThread(set(), HOST_BLOCK);
    expect(fresh.preamble).not.toContain('<workspace_claude_md');
    expect(fresh.preamble).toContain('PERSONA: Скуби.');
    expect(fresh.workspaceClaudeMdHash).toBeUndefined();
  });

  it('a fresh thread without it (scheduled task, WhatsApp) keeps the runner copy', () => {
    const preambles = set();
    const fresh = codexPreambleForFreshThread(
      preambles,
      '[SCHEDULED TASK - …]\n\nСводка за день',
    );
    expect(fresh.preamble).toContain(
      '<workspace_claude_md source="CLAUDE.md">',
    );
    expect(fresh.preamble).toContain('Одна мысль.');
    expect(fresh.workspaceClaudeMdHash).toBe(preambles.claudeMdCopyHash);
    expect(preambles.claudeMdCopyHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('an edit of CLAUDE.md does not change the thread identity, only the copy hash', () => {
    const before = set();
    fs.writeFileSync(
      path.join(cwd, 'CLAUDE.md'),
      '# Правила чата\nОдна мысль.\nНовое правило.',
    );
    const after = set();
    expect(after.identityHash).toBe(before.identityHash);
    expect(after.claudeMdCopyHash).not.toBe(before.claudeMdCopyHash);
  });

  it('a chat that may not get the copy has none to hash', () => {
    const guest = set(false);
    expect(guest.claudeMdCopyHash).toBe('');
    expect(guest.withClaudeMd).toBe(guest.bare);
    const fresh = codexPreambleForFreshThread(guest, 'привет');
    expect(fresh.preamble).not.toContain('<workspace_claude_md');
    expect(fresh.workspaceClaudeMdHash).toBeUndefined();
  });
});

describe('codexRolloutStat', () => {
  it('finds the rollout by thread id and reports size and last write', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stat-'));
    try {
      const dir = path.join(home, 'sessions', '2026', '09', '28');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'rollout-2026-09-28T09-31-53-th-stat.jsonl');
      fs.writeFileSync(file, 'x'.repeat(1234));
      const mtime = new Date('2026-09-28T01:00:00Z');
      fs.utimesSync(file, mtime, mtime);
      expect(codexRolloutStat(home, 'th-stat')).toEqual({
        bytes: 1234,
        mtimeMs: mtime.getTime(),
      });
      expect(codexRolloutStat(home, 'th-missing')).toBeNull();
      expect(codexRolloutStat(undefined, 'th-stat')).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('shouldRetryCodexStaleThreadFresh', () => {
  it('allows a clean stale resume retry and blocks it after image generation', () => {
    expect(
      shouldRetryCodexStaleThreadFresh({
        status: 'error',
        staleThread: true,
      }),
    ).toBe(true);
    expect(
      shouldRetryCodexStaleThreadFresh({
        status: 'error',
        staleThread: true,
        sideEffected: true,
      }),
    ).toBe(false);
    expect(
      shouldRetryCodexStaleThreadFresh({
        status: 'error',
        staleThread: true,
        imageArtifacts: [
          { callId: 'exec-image', savedPath: '/tmp/exec-image.png' },
        ],
      }),
    ).toBe(false);
  });

  it('never retries a non-stale or successful result', () => {
    expect(
      shouldRetryCodexStaleThreadFresh({
        status: 'error',
        staleThread: false,
      }),
    ).toBe(false);
    expect(
      shouldRetryCodexStaleThreadFresh({
        status: 'success',
        staleThread: true,
      }),
    ).toBe(false);
  });
});

describe('codexThreadPersistenceDecision', () => {
  it('saves a fresh thread after a success or an interruption, never after a plain failure', () => {
    expect(
      codexThreadPersistenceDecision(
        { status: 'success', threadId: 'new-1' },
        undefined,
        undefined,
      ),
    ).toBe('persist');
    // 27.09: the Phaser task timed out at 15 min; the fresh thread was
    // dropped and «Попробуй доделать» started over.
    expect(
      codexThreadPersistenceDecision(
        { status: 'error', threadId: 'new-1', interrupted: true },
        undefined,
        undefined,
      ),
    ).toBe('persist');
    expect(
      codexThreadPersistenceDecision(
        { status: 'error', threadId: 'new-1' },
        undefined,
        undefined,
      ),
    ).toBe('keep');
  });

  it('never saves a new thread cut short before codex recorded its preamble', () => {
    // Stopped between thread creation and the preamble message (~1.8 s): the
    // thread may lack the operating context.
    expect(
      codexThreadPersistenceDecision(
        {
          status: 'error',
          threadId: 'new-1',
          interrupted: true,
          anchored: false,
        },
        undefined,
        undefined,
      ),
    ).toBe('keep');
    expect(
      codexThreadPersistenceDecision(
        {
          status: 'error',
          threadId: 'new-1',
          interrupted: true,
          anchored: true,
        },
        undefined,
        undefined,
      ),
    ).toBe('persist');
    // A completed turn answered the message that carried the preamble.
    expect(
      codexThreadPersistenceDecision(
        { status: 'success', threadId: 'new-1', anchored: false },
        undefined,
        undefined,
      ),
    ).toBe('persist');
    // Resumed attempts are never anchored; the flag does not apply.
    expect(
      codexThreadPersistenceDecision(
        {
          status: 'error',
          threadId: 'resumed',
          interrupted: true,
          anchored: false,
        },
        'resumed',
        'resumed',
      ),
    ).toBe('keep');
  });

  it('refuses a thread codex switched to when asked to resume another', () => {
    expect(
      codexThreadPersistenceDecision(
        { status: 'success', threadId: 'other' },
        'resumed',
        'resumed',
      ),
    ).toBe('mismatch');
    expect(
      codexThreadPersistenceDecision(
        { status: 'success', threadId: 'resumed' },
        'resumed',
        'resumed',
      ),
    ).toBe('keep');
  });
});

describe('elideUnchangedStandingBlocks', () => {
  const prompt = [
    '<tenant_long_term_context source="CLAUDE.md">\nПравила чата\n</tenant_long_term_context>',
    '<chat_memory_index>\n<memory_file path="memory/a.md"/>\n</chat_memory_index>',
    '<cross_channel_owner_context>история WhatsApp</cross_channel_owner_context>',
    '<skoobi_skills>\n<skill name="voice-response">голосом</skill>\n</skoobi_skills>',
    '<messages><message>Привет</message></messages>',
  ].join('\n\n');

  it('sends everything on a fresh thread and reports the block hashes', () => {
    const first = elideUnchangedStandingBlocks(prompt, undefined);
    expect(first.prompt).toBe(prompt);
    expect(Object.keys(first.blocks).sort()).toEqual([
      'chat_memory_index',
      'cross_channel_owner_context',
      'skoobi_skills',
      'tenant_long_term_context',
    ]);
  });

  // До проверки 09.10.2026 этот тест закреплял, что cross_channel_owner_context
  // всегда уходит свежим («quoted owner history»). Контракт снят (MEM-5): блок
  // был одинаков во всех 30/30 ходах владельца (5 238 зн., один md5 — входящих
  // WhatsApp нет), а стаб ставится только при равном хеше и сбрасывается после
  // компакции, так что свежая история по-прежнему доходит целиком. То же для
  // skoobi_skills repeated in each conversation turn.
  it('replaces only the blocks the thread already has, keeps the rest', () => {
    const { blocks } = elideUnchangedStandingBlocks(prompt, undefined);
    const again = elideUnchangedStandingBlocks(prompt, blocks);
    expect(again.prompt).toContain('<tenant_long_term_context unchanged="true"/>');
    expect(again.prompt).toContain('<chat_memory_index unchanged="true"/>');
    expect(again.prompt).toContain(
      '<cross_channel_owner_context unchanged="true"/>',
    );
    expect(again.prompt).toContain('<skoobi_skills unchanged="true"/>');
    expect(again.prompt).not.toContain('Правила чата');
    expect(again.prompt).not.toContain('история WhatsApp');
    expect(again.prompt).not.toContain('voice-response');
    expect(again.prompt).toContain('<message>Привет</message>');
  });

  it('sends a changed block in full', () => {
    const { blocks } = elideUnchangedStandingBlocks(prompt, undefined);
    const changed = prompt
      .replace('memory/a.md', 'memory/b.md')
      .replace('история WhatsApp', 'новое сообщение')
      .replace('voice-response', 'web-search');
    const next = elideUnchangedStandingBlocks(changed, blocks);
    expect(next.prompt).toContain('memory/b.md');
    expect(next.prompt).toContain('новое сообщение');
    expect(next.prompt).toContain('web-search');
    expect(next.prompt).toContain('<tenant_long_term_context unchanged="true"/>');
    expect(next.blocks.chat_memory_index).not.toBe(blocks.chat_memory_index);
    expect(next.blocks.cross_channel_owner_context).not.toBe(
      blocks.cross_channel_owner_context,
    );
    expect(next.blocks.skoobi_skills).not.toBe(blocks.skoobi_skills);
  });

  // Индекс памяти в формате memory-context.ts: размер, дата и порядок (новые
  // сверху) меняются при каждой записи в память — раньше индекс (15,5 КБ)
  // уходил заново в 21 из 30 ходов владельца (MEM-5).
  const indexWith = (
    files: Array<{ file: string; size: number; modified: string }>,
    extra = '',
  ): string =>
    [
      '<chat_memory_index>',
      'Lazy memory is enabled.',
      ...files.map(
        (f) =>
          `<memory_file file="${f.file}" size_bytes="${f.size}" size="${f.size} B" modified="${f.modified}" source_type="user_message" confidence="0.70" provenance="signed"${extra} />`,
      ),
      '</chat_memory_index>',
    ].join('\n');

  it('hashes the memory index without size, date and order of its files', () => {
    const before = indexWith([
      { file: 'memory/topics/a.md', size: 100, modified: '2026-10-08T10:00:00.000Z' },
      { file: 'memory/topics/b.md', size: 200, modified: '2026-10-07T10:00:00.000Z' },
    ]);
    const { blocks } = elideUnchangedStandingBlocks(before, undefined);
    // b.md got a memory_save: bigger, newer, now first in the index.
    const afterWrite = indexWith([
      { file: 'memory/topics/b.md', size: 260, modified: '2026-10-09T09:00:00.000Z' },
      { file: 'memory/topics/a.md', size: 100, modified: '2026-10-08T10:00:00.000Z' },
    ]);
    const next = elideUnchangedStandingBlocks(afterWrite, blocks);
    expect(next.blocks.chat_memory_index).toBe(blocks.chat_memory_index);
    expect(next.prompt).toBe('<chat_memory_index unchanged="true"/>');
  });

  it('sends the memory index in full when a file appears, disappears or turns large', () => {
    const base = [
      { file: 'memory/topics/a.md', size: 100, modified: '2026-10-08T10:00:00.000Z' },
    ];
    const { blocks } = elideUnchangedStandingBlocks(indexWith(base), undefined);

    const added = elideUnchangedStandingBlocks(
      indexWith([
        ...base,
        { file: 'memory/topics/c.md', size: 10, modified: '2026-10-09T10:00:00.000Z' },
      ]),
      blocks,
    );
    expect(added.blocks.chat_memory_index).not.toBe(blocks.chat_memory_index);
    expect(added.prompt).toContain('memory/topics/c.md');

    const removed = elideUnchangedStandingBlocks(indexWith([]), blocks);
    expect(removed.blocks.chat_memory_index).not.toBe(blocks.chat_memory_index);

    const large = elideUnchangedStandingBlocks(
      indexWith(base, ' large="true" note="large file not loaded; use memory_get for exact details"'),
      blocks,
    );
    expect(large.blocks.chat_memory_index).not.toBe(blocks.chat_memory_index);
    expect(large.prompt).toContain('large="true"');
  });

  it('hashes the skills block without the per-turn match score', () => {
    const skills = (score: number, name = 'voice-response'): string =>
      [
        '<skoobi_skills>',
        'Procedural skill memory selected for this turn.',
        `<skill name="${name}" source="${name}/SKILL.md" score="${score}">`,
        'Answer by voice.',
        '</skill>',
        '</skoobi_skills>',
      ].join('\n');
    const { blocks } = elideUnchangedStandingBlocks(skills(28), undefined);
    const rescored = elideUnchangedStandingBlocks(skills(52), blocks);
    expect(rescored.blocks.skoobi_skills).toBe(blocks.skoobi_skills);
    expect(rescored.prompt).toBe('<skoobi_skills unchanged="true"/>');
    const other = elideUnchangedStandingBlocks(skills(28, 'web-search'), blocks);
    expect(other.blocks.skoobi_skills).not.toBe(blocks.skoobi_skills);
    expect(other.prompt).toContain('web-search');
  });

  it('hashes CLAUDE.md text that merely mentions a memory_file as is', () => {
    const block =
      '<tenant_long_term_context source="CLAUDE.md">\n&lt;memory_file size="1"/&gt; size="2"\n</tenant_long_term_context>';
    const { blocks } = elideUnchangedStandingBlocks(block, undefined);
    const edited = elideUnchangedStandingBlocks(
      block.replace('size="2"', 'size="3"'),
      blocks,
    );
    expect(edited.blocks.tenant_long_term_context).not.toBe(
      blocks.tenant_long_term_context,
    );
  });
});

describe('standingBlocksHeldAfterCompaction (W29)', () => {
  const claudeMd = (rules: string) =>
    `<tenant_long_term_context source="CLAUDE.md">\n${rules}\n</tenant_long_term_context>`;
  const memoryIndex = (file: string, modified: string) =>
    [
      '<chat_memory_index>',
      'Lazy memory is enabled.',
      `<memory_file file="${file}" size_bytes="10" size="10 B" modified="${modified}" />`,
      '</chat_memory_index>',
    ].join('\n');
  // A host prompt as the runner sends it (task_continuity included).
  const hostPrompt = (rules: string, message: string) =>
    withTaskContinuityPolicy(
      [
        claudeMd(rules),
        memoryIndex('memory/a.md', '2026-11-03T10:00:00.000Z'),
        '<cross_channel_owner_context>история WhatsApp</cross_channel_owner_context>',
        `<messages><message>${message}</message></messages>`,
      ].join('\n\n'),
    );
  // What a fresh thread's first user message holds: preamble + prompt. The
  // preamble mentions «<tenant_long_term_context>» itself.
  const firstMessage = (prompt: string) =>
    `${buildCodexPreamble({ cwd: '/nonexistent' })}\n\n${prompt}`;

  it('gives the same hashes as the blocks the runner sent, past the preamble', () => {
    const prompt = hostPrompt('Правила v1', 'Привет');
    const sent = elideUnchangedStandingBlocks(prompt, undefined).blocks;
    const resumed = elideUnchangedStandingBlocks(
      hostPrompt('Правила v1', 'Ещё'),
      sent,
    ).prompt;
    const held = standingBlocksHeldAfterCompaction([
      firstMessage(prompt),
      resumed,
    ]);
    expect(held).toEqual(sent);
    // The next turn therefore gets stubs instead of a third copy.
    const next = elideUnchangedStandingBlocks(
      hostPrompt('Правила v1', 'Что дальше?'),
      held,
    );
    expect(next.prompt).toContain(
      '<tenant_long_term_context unchanged="true"/>',
    );
    expect(next.prompt).toContain('<chat_memory_index unchanged="true"/>');
    expect(next.prompt).toContain('<task_continuity unchanged="true"/>');
    expect(next.prompt).not.toContain('Правила v1');
  });

  it('takes the latest full copy: a newer CLAUDE.md wins, a reverted one goes again', () => {
    const v1 = hostPrompt('Правила v1', 'Привет');
    const v2 = hostPrompt('Правила v2', 'Правила поменялись');
    const held = standingBlocksHeldAfterCompaction([v1, v2]);
    const sentV2 = elideUnchangedStandingBlocks(v2, undefined).blocks;
    expect(held.tenant_long_term_context).toBe(sentV2.tenant_long_term_context);
    expect(elideUnchangedStandingBlocks(v1, held).prompt).toContain(
      'Правила v1',
    );
  });

  it('holds nothing for stubs alone or a summary-only compaction', () => {
    expect(
      standingBlocksHeldAfterCompaction([
        '<tenant_long_term_context unchanged="true"/>\n<chat_memory_index unchanged="true"/>\nПривет',
      ]),
    ).toEqual({});
    expect(standingBlocksHeldAfterCompaction([])).toEqual({});
  });

  it('does not count a copy codex shortened: cut-off end or middle', () => {
    const prompt = hostPrompt('Правила v1', 'Привет');
    const sent = elideUnchangedStandingBlocks(prompt, undefined).blocks;
    // «…N tokens truncated…» removed the end of the memory index.
    const cutEnd = prompt.slice(0, prompt.indexOf('</chat_memory_index>'));
    const heldCutEnd = standingBlocksHeldAfterCompaction([prompt, cutEnd]);
    expect(heldCutEnd.chat_memory_index).toBeUndefined();
    expect(heldCutEnd.tenant_long_term_context).toBe(
      sent.tenant_long_term_context,
    );
    // The middle of CLAUDE.md is gone, both tags survived: a different hash.
    const cutMiddle = prompt.replace(
      'Правила v1',
      'Пра…120 tokens truncated…1',
    );
    const heldCutMiddle = standingBlocksHeldAfterCompaction([cutMiddle]);
    expect(heldCutMiddle.tenant_long_term_context).toBeDefined();
    expect(heldCutMiddle.tenant_long_term_context).not.toBe(
      sent.tenant_long_term_context,
    );
    expect(
      elideUnchangedStandingBlocks(prompt, heldCutMiddle).prompt,
    ).toContain('Правила v1');
  });

  it('a memory index that differs only in sizes and dates still counts as held', () => {
    const kept = memoryIndex('memory/a.md', '2026-11-03T10:00:00.000Z');
    const now = memoryIndex('memory/a.md', '2026-11-08T08:00:00.000Z');
    const held = standingBlocksHeldAfterCompaction([kept]);
    expect(elideUnchangedStandingBlocks(now, held).prompt).toBe(
      '<chat_memory_index unchanged="true"/>',
    );
  });
});

describe('W29: a stub points only to a copy a compaction would keep', () => {
  const claudeMd = (rules: string) =>
    `<tenant_long_term_context source="CLAUDE.md">\n${rules}\n</tenant_long_term_context>`;
  const hostPrompt = (rules: string, message: string) =>
    withTaskContinuityPolicy(
      [
        claudeMd(rules),
        '<chat_memory_index>\nLazy memory is enabled.\n<memory_file file="memory/a.md" size_bytes="10" size="10 B" modified="2026-11-03T10:00:00.000Z" />\n</chat_memory_index>',
        '<cross_channel_owner_context>история WhatsApp</cross_channel_owner_context>',
        `<messages><message>${message}</message></messages>`,
      ].join('\n\n'),
    );
  const ALL = [
    'tenant_long_term_context',
    'chat_memory_index',
    'cross_channel_owner_context',
    'task_continuity',
  ];
  const each = (n: number) => Object.fromEntries(ALL.map((tag) => [tag, n]));

  it('is about 78 % of the ~256 000 bytes codex 0.166 keeps at a compaction', () => {
    expect(STANDING_STUB_MAX_BYTES).toBe(200_000);
  });

  it('stubs a block only while its copy plus this prompt fit the limit', () => {
    const sent = elideUnchangedStandingBlocks(
      hostPrompt('Правила v1', 'Привет'),
      undefined,
    ).blocks;
    const next = hostPrompt('Правила v1', 'Ещё');
    const fresh = elideUnchangedStandingBlocks(next, sent, each(1_000));
    expect([...fresh.elided].sort()).toEqual([...ALL].sort());
    expect(fresh.prompt).not.toContain('Правила v1');
    // The prompt itself counts: exactly at the limit is still a stub, one
    // byte over and the block goes in full.
    const size = Buffer.byteLength(fresh.prompt, 'utf8');
    const limit = 50_000;
    const atLimit = elideUnchangedStandingBlocks(
      next,
      sent,
      { ...each(1_000), tenant_long_term_context: limit - size },
      limit,
    );
    expect(atLimit.elided).toContain('tenant_long_term_context');
    const over = elideUnchangedStandingBlocks(
      next,
      sent,
      { ...each(1_000), tenant_long_term_context: limit - size + 1 },
      limit,
    );
    expect(over.elided).not.toContain('tenant_long_term_context');
    expect(over.prompt).toContain('Правила v1');
    expect(over.prompt).toContain('<chat_memory_index unchanged="true"/>');
    expect(over.blocks).toEqual(fresh.blocks);
    // No number for a block (an older meta): it goes in full.
    const unknown = elideUnchangedStandingBlocks(next, sent, {});
    expect(unknown.elided).toEqual([]);
    expect(unknown.prompt).toBe(next);
  });

  it('a block that goes in full can push another stub over the limit', () => {
    const big = 'Правило. '.repeat(500);
    const sent = elideUnchangedStandingBlocks(
      hostPrompt(big, 'Привет'),
      undefined,
    ).blocks;
    const next = hostPrompt(big, 'Ещё');
    const allStubs = elideUnchangedStandingBlocks(next, sent, each(0));
    const small = Buffer.byteLength(allStubs.prompt, 'utf8');
    const limit = 100_000;
    // CLAUDE.md has no number; the WhatsApp block would fit only next to a
    // stub of it, not next to its full copy.
    const result = elideUnchangedStandingBlocks(
      next,
      sent,
      {
        chat_memory_index: 0,
        task_continuity: 0,
        cross_channel_owner_context: limit - small - 100,
      },
      limit,
    );
    expect(result.elided).not.toContain('tenant_long_term_context');
    expect(result.elided).not.toContain('cross_channel_owner_context');
    expect(result.elided).toEqual(['chat_memory_index', 'task_continuity']);
    expect(result.prompt).toContain('история WhatsApp');
  });

  it('L8: the attached images of this turn count against the limit', () => {
    const sent = elideUnchangedStandingBlocks(
      hostPrompt('Правила v1', 'Привет'),
      undefined,
    ).blocks;
    const next = hostPrompt('Правила v1', 'Альбом');
    const size = Buffer.byteLength(
      elideUnchangedStandingBlocks(next, sent, each(0)).prompt,
      'utf8',
    );
    // The copy fits next to the text alone…
    const since = { ...each(0), tenant_long_term_context: STANDING_STUB_MAX_BYTES - size - 5 * CODEX_KEPT_IMAGE_BYTES };
    expect(elideUnchangedStandingBlocks(next, sent, since).elided).toContain('tenant_long_term_context');
    expect(
      elideUnchangedStandingBlocks(next, sent, since, STANDING_STUB_MAX_BYTES, 5 * CODEX_KEPT_IMAGE_BYTES).elided,
    ).toContain('tenant_long_term_context');
    // …but not next to an album of eight: it goes in full.
    const album = elideUnchangedStandingBlocks(next, sent, since, STANDING_STUB_MAX_BYTES, 8 * CODEX_KEPT_IMAGE_BYTES);
    expect(album.elided).not.toContain('tenant_long_term_context');
    expect(album.prompt).toContain('Правила v1');
  });

  it('L8: images codex kept after a copy make that copy older', () => {
    const t0 = hostPrompt('Правила v1', 'Привет');
    const image = '<image name=[Image #1]>';
    const t1 = 'Вот фото';
    const plain = standingStateAfterCompaction([t0, t1]);
    const withImages = standingStateAfterCompaction([t0, image, '<image name=[Image #12]>', t1]);
    const marker = (text: string) => Buffer.byteLength(text, 'utf8');
    expect(withImages.blocks).toEqual(plain.blocks);
    expect(withImages.bytes.tenant_long_term_context).toBe(
      plain.bytes.tenant_long_term_context! + marker(image) + marker('<image name=[Image #12]>') + 2 * CODEX_KEPT_IMAGE_BYTES,
    );
    // Only codex's own marker counts as an image, not a message quoting it.
    const quoted = standingStateAfterCompaction([t0, `смотри ${image}`]);
    expect(quoted.bytes.tenant_long_term_context).toBe(
      plain.bytes.tenant_long_term_context! - marker(t1) + marker(`смотри ${image}`),
    );
  });

  // L8-1: настоящий маркер codex 0.166 несёт путь файла — старое выражение
  // его не узнавало, и альбом после сжатия не учитывался.
  it('L8-1: the real codex 0.166 compacted record with path markers counts its images', () => {
    const t0 = hostPrompt('Правила v1', 'Привет');
    const imageMessage = (n: number) => ({
      type: 'message', role: 'user', content: [
        { type: 'input_text', text: `<image name=[Image #${n}] path="/workspace/group/media/фото ${n}.jpg">` },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA', detail: 'high' },
        { type: 'input_text', text: '</image>' },
        { type: 'input_text', text: `Вот фото ${n}` },
      ],
    });
    const texts = codexCompactionRetainedUserTexts({
      type: 'compacted',
      payload: { message: '', replacement_history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: t0 }] },
        imageMessage(1), imageMessage(2),
      ] },
    })!;
    const markers = texts.filter((text) => text.startsWith('<image'));
    expect(markers).toHaveLength(2);
    const plainTexts = texts.filter((text) => !text.startsWith('<image'));
    const withImages = standingStateAfterCompaction(texts);
    const plain = standingStateAfterCompaction(plainTexts);
    const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
    expect(withImages.blocks).toEqual(plain.blocks);
    expect(withImages.bytes.tenant_long_term_context).toBe(
      plain.bytes.tenant_long_term_context! + bytes(markers[0]) + bytes(markers[1]) + 2 * CODEX_KEPT_IMAGE_BYTES,
    );
    // Still the whole text only: a quoted marker in a message is no image.
    const quote = `смотри ${markers[0]}`;
    expect(standingStateAfterCompaction([t0, quote]).bytes.tenant_long_term_context).toBe(
      standingStateAfterCompaction([t0]).bytes.tenant_long_term_context! + bytes(quote),
    );
  });

  it('counts the bytes from the text with the latest copy to the newest kept text', () => {
    const t0 = hostPrompt('Правила v1', 'Привет');
    const sent = elideUnchangedStandingBlocks(t0, undefined).blocks;
    const t1 = elideUnchangedStandingBlocks(
      hostPrompt('Правила v1', 'Ещё'),
      sent,
    ).prompt;
    const t2 = hostPrompt('Правила v2', 'Правила поменялись');
    const state = standingStateAfterCompaction([t0, t1, t2]);
    const bytes = (...texts: string[]) =>
      texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
    // t2 carries every block in full again: all of them count from t2.
    expect(state.bytes).toEqual(each(bytes(t2)));
    expect(bytes(t2)).toBeGreaterThan(t2.length);
    const older = standingStateAfterCompaction([t0, t1]);
    expect(older.blocks).toEqual(sent);
    expect(older.bytes).toEqual(each(bytes(t0, t1)));
    // A cut copy is not held, and has no number.
    const cut = t0.slice(0, t0.indexOf('</chat_memory_index>'));
    const partly = standingStateAfterCompaction([cut, t1]);
    expect(partly.blocks.chat_memory_index).toBeUndefined();
    expect(partly.bytes.chat_memory_index).toBeUndefined();
    expect(partly.bytes.tenant_long_term_context).toBe(bytes(cut, t1));
    expect(standingBlocksHeldAfterCompaction([cut, t1])).toEqual(
      partly.blocks,
    );
  });

  it('without a compaction a turn makes every copy older and its full blocks the latest', () => {
    const before = {
      blocks: { tenant_long_term_context: 'h1', chat_memory_index: 'h2' },
      bytes: { tenant_long_term_context: 100, chat_memory_index: 50 },
    };
    expect(
      standingStateAfterTurn({
        before,
        sent: {
          blocks: { tenant_long_term_context: 'h1', task_continuity: 'h3' },
          elided: ['tenant_long_term_context'],
        },
        inputBytes: 30,
      }),
    ).toEqual({
      blocks: {
        tenant_long_term_context: 'h1',
        chat_memory_index: 'h2',
        task_continuity: 'h3',
      },
      bytes: {
        tenant_long_term_context: 130,
        chat_memory_index: 80,
        task_continuity: 30,
      },
    });
    // codex did not record the input: nothing changes.
    expect(
      standingStateAfterTurn({
        before,
        sent: { blocks: { task_continuity: 'h3' }, elided: [] },
      }),
    ).toEqual(before);
    // An extra turn without standing blocks (a link correction).
    expect(standingStateAfterTurn({ before, inputBytes: 7 }).bytes).toEqual({
      tenant_long_term_context: 107,
      chat_memory_index: 57,
    });
  });

  it('after a compaction the thread holds what codex kept — plus an input recorded after it', () => {
    const v1 = hostPrompt('Правила v1', 'Привет');
    const kept = standingStateAfterCompaction([v1]);
    // The turn sends a changed CLAUDE.md in full, the rest as stubs.
    const v2 = elideUnchangedStandingBlocks(
      hostPrompt('Правила v2', 'Правила поменялись'),
      kept.blocks,
      kept.bytes,
    );
    expect(v2.elided).not.toContain('tenant_long_term_context');
    const v2Bytes = Buffer.byteLength(v2.prompt, 'utf8');
    // Compacted mid-turn: the kept history already has the input.
    const mid = standingStateAfterCompaction([v1, v2.prompt]);
    expect(
      standingStateAfterTurn({
        before: kept,
        sent: v2,
        inputBytes: v2Bytes,
        compaction: { state: mid, inputRecorded: true },
      }),
    ).toEqual(mid);
    // Compacted at the very start of the turn, before codex recorded the
    // input: the input came after the kept history (2 of 47 compactions).
    const after = standingStateAfterTurn({
      before: kept,
      sent: v2,
      inputBytes: v2Bytes,
      compaction: { state: kept, inputRecorded: false },
    });
    expect(after.blocks.tenant_long_term_context).toBe(
      v2.blocks.tenant_long_term_context,
    );
    expect(after.bytes.tenant_long_term_context).toBe(v2Bytes);
    expect(after.bytes.chat_memory_index).toBe(
      kept.bytes.chat_memory_index + v2Bytes,
    );
    // So rules back at v1 go in full: the latest copy the model saw is v2.
    // Holding only what codex kept (v1) would send a stub it reads as v2.
    const back = elideUnchangedStandingBlocks(
      hostPrompt('Правила v1', 'Вернул как было'),
      after.blocks,
      after.bytes,
    );
    expect(back.prompt).toContain('Правила v1');
    expect(back.prompt).toContain('<chat_memory_index unchanged="true"/>');
    // The same compaction with the input never recorded: only what was kept.
    expect(
      standingStateAfterTurn({
        before: kept,
        sent: v2,
        compaction: { state: kept, inputRecorded: false },
      }),
    ).toEqual(kept);
  });

  it('reads the meta: numbers only for held blocks; an older meta stubs nothing', () => {
    expect(
      standingStateFromMeta({
        standingBlocks: { tenant_long_term_context: 'h1', chat_memory_index: 'h2' },
        standingBytes: {
          tenant_long_term_context: 120,
          chat_memory_index: -1,
          task_continuity: 5,
        } as Record<string, number>,
      }),
    ).toEqual({
      blocks: { tenant_long_term_context: 'h1', chat_memory_index: 'h2' },
      bytes: { tenant_long_term_context: 120 },
    });
    const legacy = standingStateFromMeta({
      standingBlocks: elideUnchangedStandingBlocks(
        hostPrompt('Правила v1', 'Привет'),
        undefined,
      ).blocks,
    });
    expect(legacy.bytes).toEqual({});
    const next = hostPrompt('Правила v1', 'Ещё');
    expect(
      elideUnchangedStandingBlocks(next, legacy.blocks, legacy.bytes).prompt,
    ).toBe(next);
    expect(standingStateFromMeta(null)).toEqual({ blocks: {}, bytes: {} });
  });
});

describe('codexHeartbeatAlive', () => {
  const NOW = 10_000_000;

  it('keeps the old 5-minute window without an idle stop', () => {
    expect(
      codexHeartbeatAlive({
        now: NOW,
        lastEventAt: NOW - 299_000,
        itemsInFlight: 0,
      }),
    ).toBe(true);
    expect(
      codexHeartbeatAlive({
        now: NOW,
        lastEventAt: NOW - 300_000,
        itemsInFlight: 0,
      }),
    ).toBe(false);
  });

  it('runs a minute past the idle stop when one is configured', () => {
    const inactivityMs = 600_000;
    expect(
      codexHeartbeatAlive({
        now: NOW,
        lastEventAt: NOW - 659_000,
        itemsInFlight: 0,
        inactivityMs,
      }),
    ).toBe(true);
    expect(
      codexHeartbeatAlive({
        now: NOW,
        lastEventAt: NOW - 660_000,
        itemsInFlight: 0,
        inactivityMs,
      }),
    ).toBe(false);
  });

  it('stays alive while an item is in flight', () => {
    expect(
      codexHeartbeatAlive({ now: NOW, lastEventAt: 0, itemsInFlight: 1 }),
    ).toBe(true);
    expect(
      codexHeartbeatAlive({
        now: NOW,
        lastEventAt: 0,
        itemsInFlight: 2,
        inactivityMs: 600_000,
      }),
    ).toBe(true);
  });
});

describe('shouldDropAnchoredFreshThread', () => {
  it('drops a saved-early thread whose first turn failed without doing anything', () => {
    expect(
      shouldDropAnchoredFreshThread({
        status: 'error',
        error: 'codex exited with code 1: bad config',
      }),
    ).toBe(true);
  });

  it('keeps it after an interruption, an action, a side effect or a service hiccup', () => {
    const base = {
      status: 'error' as const,
      error: 'codex exited with code 1',
    };
    expect(shouldDropAnchoredFreshThread({ ...base, interrupted: true })).toBe(
      false,
    );
    expect(
      shouldDropAnchoredFreshThread({
        ...base,
        interrupted: true,
        superseded: true,
      }),
    ).toBe(false);
    expect(shouldDropAnchoredFreshThread({ ...base, acted: true })).toBe(false);
    expect(shouldDropAnchoredFreshThread({ ...base, sideEffected: true })).toBe(
      false,
    );
    expect(
      shouldDropAnchoredFreshThread({
        ...base,
        error: 'stream disconnected before completion',
      }),
    ).toBe(false);
    expect(
      shouldDropAnchoredFreshThread({ ...base, error: 'usage limit reached' }),
    ).toBe(false);
    expect(
      shouldDropAnchoredFreshThread({
        ...base,
        error: 'workspace routing discovery unauthorized (401)',
      }),
    ).toBe(false);
    expect(shouldDropAnchoredFreshThread({ status: 'success' })).toBe(false);
  });
});

describe('shouldClearThreadAfterResumeError', () => {
  const thread = '01a00000-0000-7000-8000-000000000001';

  it('drops a thread that failed to resume for an unknown reason', () => {
    expect(
      shouldClearThreadAfterResumeError(
        { status: 'error', error: 'failed to load rollout' },
        thread,
      ),
    ).toBe(true);
  });

  it('keeps the thread when codex lost the link before the turn', () => {
    // These three were every «resume-error» rotation on record: the owner's
    // thread was dropped by a network outage, not by a broken thread.
    for (const error of [
      'workspace routing discovery failed',
      'workspace routing discovery timed out',
      'Reconnecting... waiting for network (Connection failed: tls handshake eof)',
    ]) {
      expect(
        shouldClearThreadAfterResumeError({ status: 'error', error }, thread),
      ).toBe(false);
      // A fresh thread saved early is not dropped for it either: the next
      // attempt would otherwise start one more empty thread (four of them
      // in twelve minutes were seen).
      expect(shouldDropAnchoredFreshThread({ status: 'error', error })).toBe(
        false,
      );
    }
  });

  it('keeps the thread when codex lost its login (26.10)', () => {
    for (const error of [
      'workspace routing discovery unauthorized (401)',
      'Your session has ended. Please log in again.',
    ]) {
      expect(
        shouldClearThreadAfterResumeError({ status: 'error', error }, thread),
      ).toBe(false);
    }
  });

  it('keeps it after a network hiccup, an action, or with no thread at all', () => {
    expect(
      shouldClearThreadAfterResumeError(
        { status: 'error', error: 'stream disconnected before completion' },
        thread,
      ),
    ).toBe(false);
    expect(
      shouldClearThreadAfterResumeError(
        { status: 'error', error: 'boom', sideEffected: true },
        thread,
      ),
    ).toBe(false);
    expect(
      shouldClearThreadAfterResumeError(
        { status: 'error', error: 'boom' },
        undefined,
      ),
    ).toBe(false);
    expect(
      shouldClearThreadAfterResumeError({ status: 'success' }, thread),
    ).toBe(false);
  });
});

describe('persistCodexThread', () => {
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-persist-'));
    return {
      dir,
      idFile: path.join(dir, '.codex-thread-id'),
      metaFile: path.join(dir, '.codex-thread-meta.json'),
    };
  };
  const meta = {
    preambleHash: 'hash-a',
    createdAt: '2026-09-28T04:31:55.000Z',
    standingBlocks: { chat_memory_index: 'abc' },
  };

  it('writes the meta before the id, each through an atomic rename', () => {
    const { dir, idFile, metaFile } = setup();
    const renamed: string[] = [];
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      renamed.push(String(to));
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
    });
    try {
      expect(
        persistCodexThread({
          idFile,
          metaFile,
          threadId: '00000000-0000-7000-8000-000000000099',
          meta,
          sharesChatThread: true,
        }),
      ).toBe(true);
      expect(renamed).toEqual([metaFile, idFile]);
      expect(fs.readFileSync(idFile, 'utf-8')).toBe(
        '00000000-0000-7000-8000-000000000099',
      );
      expect(JSON.parse(fs.readFileSync(metaFile, 'utf-8'))).toEqual(meta);
      // No temp files left behind.
      expect(fs.readdirSync(dir).sort()).toEqual(
        ['.codex-thread-id', '.codex-thread-meta.json'].sort(),
      );
    } finally {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing for a run that does not share the chat thread', () => {
    const { dir, idFile, metaFile } = setup();
    try {
      expect(
        persistCodexThread({
          idFile,
          metaFile,
          threadId: 'th-task',
          meta,
          sharesChatThread: false,
        }),
      ).toBe(false);
      expect(fs.existsSync(idFile)).toBe(false);
      expect(fs.existsSync(metaFile)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves no id behind when the meta cannot be written', () => {
    const { dir, idFile } = setup();
    try {
      expect(
        persistCodexThread({
          idFile,
          metaFile: path.join(dir, 'missing-dir', 'meta.json'),
          threadId: 'th-x',
          meta,
          sharesChatThread: true,
        }),
      ).toBe(false);
      expect(fs.existsSync(idFile)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('linkCheckGateForInput', () => {
  const granted = { linkCheck: { mode: 'fix' as const, fixReasoningEffort: 'medium' } };

  it('runs only when the host granted it', () => {
    expect(linkCheckGateForInput({}, {})).toEqual({
      allowed: false,
      reason: 'not-granted',
    });
    expect(linkCheckGateForInput(granted, {})).toEqual({
      allowed: true,
      mode: 'fix',
      fixReasoningEffort: 'medium',
    });
  });

  it('never runs for scheduled tasks, forwarded content or behind a proxy', () => {
    expect(
      linkCheckGateForInput({ ...granted, isScheduledTask: true }, {}),
    ).toMatchObject({ allowed: false, reason: 'scheduled-task' });
    expect(
      linkCheckGateForInput({ ...granted, indirectOwnerContent: true }, {}),
    ).toMatchObject({ allowed: false, reason: 'indirect-content' });
    expect(
      linkCheckGateForInput(granted, { HTTPS_PROXY: 'http://127.0.0.1:9' }),
    ).toMatchObject({ allowed: false, reason: 'proxy' });
    expect(
      linkCheckGateForInput(granted, { all_proxy: 'socks5://127.0.0.1:9' }),
    ).toMatchObject({ allowed: false, reason: 'proxy' });
  });

  it('refuses an unknown mode and drops an unknown effort', () => {
    expect(
      linkCheckGateForInput(
        { linkCheck: { mode: 'rewrite' as unknown as 'fix' } },
        {},
      ),
    ).toMatchObject({ allowed: false, reason: 'bad-mode' });
    expect(
      linkCheckGateForInput(
        { linkCheck: { mode: 'fix', fixReasoningEffort: 'ultra' } },
        {},
      ),
    ).toEqual({ allowed: true, mode: 'fix' });
  });
});

describe('combineTurnAccounting (finalize hold, C12)', () => {
  it('without a hold turn the turn passes through as is', () => {
    const turn = { usage: { inputTokens: 10, outputTokens: 2 }, modelRequests: 1 };
    expect(combineTurnAccounting(turn)).toBe(turn);
  });

  it('adds the hold turn up, newest settings win, side effects stay', () => {
    const combined = combineTurnAccounting(
      {
        usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 80 },
        usageSource: 'turn_delta',
        modelRequests: 3,
        appliedServiceTier: 'priority',
        appliedReasoningEffort: 'xhigh',
        accountUsedPercent: 40,
        toolCalls: { web__run: 2 },
        sideEffectTools: ['memory_save'],
        sideEffected: true,
      },
      {
        usage: { inputTokens: 30, outputTokens: 5, cacheReadInputTokens: 25 },
        usageSource: 'turn_delta',
        modelRequests: 1,
        appliedServiceTier: 'priority',
        appliedReasoningEffort: 'xhigh',
        accountUsedPercent: 41,
        toolCalls: { web__run: 1, exec_command: 1 },
      },
    );
    expect(combined).toEqual({
      usage: { inputTokens: 130, outputTokens: 25, cacheReadInputTokens: 105 },
      usageSource: 'turn_delta',
      modelRequests: 4,
      appliedServiceTier: 'priority',
      appliedReasoningEffort: 'xhigh',
      accountUsedPercent: 41,
      toolCalls: { web__run: 3, exec_command: 1 },
      sideEffected: true,
      sideEffectTools: ['memory_save'],
    });
    // A link fix on top still adds up through the usual helpers.
    expect(
      mergeTurnAccounting(combined, { usage: { inputTokens: 5, outputTokens: 1 } })
        .usage,
    ).toEqual({ inputTokens: 135, outputTokens: 26, cacheReadInputTokens: 105 });
  });

  it('M-G2.3a: adds up the screen-control commands of the turn and its correction', () => {
    const combined = combineTurnAccounting(
      { usage: { inputTokens: 1, outputTokens: 1 }, screenControlCommands: { cliclick: 2, osascript: 1 } },
      { usage: { inputTokens: 1, outputTokens: 1 }, screenControlCommands: { cliclick: 1, screencapture: 1 } },
    );
    expect(combined.screenControlCommands).toEqual({ cliclick: 3, osascript: 1, screencapture: 1 });
    expect(codexTurnTelemetry(combined)).toMatchObject({
      screenControlCommands: { cliclick: 3, osascript: 1, screencapture: 1 },
    });
    expect(combineTurnAccounting({ usage: { inputTokens: 1, outputTokens: 1 } }).screenControlCommands).toBeUndefined();
  });

  it('keeps the turn telemetry of both turns: sub-agents, tool failures, CLI version', () => {
    const combined = combineTurnAccounting(
      {
        usage: { inputTokens: 100, outputTokens: 20 },
        subagentTokens: 4_000,
        toolErrors: { exec: 1 },
        toolExitNonzero: 2,
        toolWallMsTotal: 900,
        toolWallMsMax: 700,
        codexCliVersion: '0.156.0',
      },
      {
        usage: { inputTokens: 30, outputTokens: 5 },
        subagentTokens: 1_000,
        toolErrors: { exec: 1, mcp__claudeclaw__memory_search: 1 },
        toolWallMsTotal: 300,
        toolWallMsMax: 300,
      },
    );
    expect(combined).toMatchObject({
      subagentTokens: 5_000,
      toolErrors: { exec: 2, mcp__claudeclaw__memory_search: 1 },
      toolExitNonzero: 2,
      toolWallMsTotal: 1_200,
      toolWallMsMax: 700,
      codexCliVersion: '0.156.0',
    });
    // The success frame's telemetry is built from the combined turn.
    expect(codexTurnTelemetry(combined)).toMatchObject({
      subagentTokens: 5_000,
      toolErrors: { exec: 2, mcp__claudeclaw__memory_search: 1 },
      codexCliVersion: '0.156.0',
    });
  });
});

describe('mergeTurnAccounting', () => {
  it('passes the turn through untouched without a correction', () => {
    expect(
      mergeTurnAccounting({
        usage: { inputTokens: 10, outputTokens: 2 },
        sideEffected: undefined,
        sideEffectTools: undefined,
      }),
    ).toEqual({
      usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: undefined },
      sideEffected: undefined,
      sideEffectTools: undefined,
    });
  });

  it('sums tokens and keeps side effects of both turns visible', () => {
    expect(
      mergeTurnAccounting(
        {
          usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 80 },
          sideEffected: true,
          sideEffectTools: ['send_document'],
        },
        {
          usage: { inputTokens: 30, outputTokens: 5 },
          sideEffected: true,
          sideEffectTools: ['send_message', 'send_document'],
        },
      ),
    ).toEqual({
      usage: { inputTokens: 130, outputTokens: 25, cacheReadInputTokens: 80 },
      sideEffected: true,
      sideEffectTools: ['send_document', 'send_message'],
    });
    expect(
      mergeTurnAccounting(
        { usage: undefined },
        { usage: { inputTokens: 1, outputTokens: 1 }, sideEffected: true },
      ),
    ).toEqual({
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: undefined },
      sideEffected: true,
      sideEffectTools: undefined,
    });
  });
});

describe('сорвавшаяся доработка: ipc/input до следующего хода или запуска (C12)', () => {
  let dir: string;
  const HELD = '1700000000000-ab12.json';
  const NEWER = '1700000000500-cd34.json';
  const heldText =
    '<messages>\n<message sender="Тест" time="13:25">а ещё X</message>\n</messages>';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-hold-ipc-'));
    fs.writeFileSync(
      path.join(dir, HELD),
      JSON.stringify({ type: 'message', text: heldText }),
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A meaningful follow-up is deferred without an auxiliary model turn. */
  async function failedHoldWithClose(): Promise<void> {
    const out = await runFinalizeHold(
      {
        result: { text: 'Советую механику Wave: она проще.' },
        threadId: 'thread-test',
        threadOk: true,
        contextFill: 0.2,
        turnStartedAt: 1_000_000,
        turnDeadlineAt: 1_000_000 + 15 * 60_000,
      },
      {
        peekPending: () => peekIpcInputFiles(dir),
        takePending: (files) => takeIpcInputFiles(dir, files),
        markFailed: (files, doneTools, draft) =>
          markFailedHoldInput(dir, files, () => {}, doneTools, draft),
        runHoldTurn: async () => {
          throw new Error('auxiliary turn must not run');
        },
        log: () => {},
        now: () => 1_000_000 + 200_000,
      },
    );
    expect(out.deferred).toBe(true);
    expect(out.text).toBeNull();
    expect(out.absorbed).toBe(0);
    fs.writeFileSync(path.join(dir, '_close'), '');
  }

  it('после _close сообщение ждёт на диске, следующий запуск получает его с пометкой', async () => {
    await failedHoldWithClose();
    // The runner exits on `_close` without draining: the file stays.
    expect(fs.existsSync(path.join(dir, HELD))).toBe(true);
    fs.writeFileSync(
      path.join(dir, NEWER),
      JSON.stringify({ type: 'message', text: 'новое' }),
    );
    // The next run's initial drain (main()).
    const pending = drainIpcInputDetailed(dir);
    expect(pending.map((file) => [file.name, file.afterFailedHold])).toEqual([
      [HELD, true],
      [NEWER, undefined],
    ]);
    expect(joinIpcInputWithHoldNote(pending)).toContain(
      FINALIZE_HOLD_FALLBACK_NOTE,
    );
    expect(joinIpcInputWithHoldNote(pending)).toContain(
      'Советую механику Wave: она проще.',
    );
    expect(joinIpcInputWithHoldNote(pending)).toContain(`${heldText}\nновое`);
    expect(fs.readdirSync(dir)).toEqual(['_close']);
  });

  it('без _close догоняющий ход того же запуска берёт его с пометкой «итог не отправлен»', async () => {
    await failedHoldWithClose();
    fs.rmSync(path.join(dir, '_close'));
    const batch = drainIpcInputDetailed(dir);
    const answeredAt = Date.now();
    expect(
      followUpContinuationNote({
        arrivedDuringTurn: ipcBatchArrivedDuringTurn(batch, answeredAt),
        messageCount: countPipedMessages(
          batch.map((file) => file.text).join('\n'),
          batch.length,
        ),
        afterFailedHold: batch.some((file) => file.afterFailedHold === true),
        holdOriginalText: batch[0].holdOriginalText,
      }),
    ).toBe(
      finalizeHoldFallbackNote(undefined, 'Советую механику Wave: она проще.'),
    );
  });
});
