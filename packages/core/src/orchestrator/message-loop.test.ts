/**
 * Regression tests for suppressing agent STDOUT routing.
 *
 * Background: a supplier-facing group needed to send explicit acknowledgements
 * through the send-message MCP tool while automatic STDOUT delivery remained
 * disabled. Setting `inboundOnly: false` also re-enabled the orchestrator's
 * automatic route and exposed internal narrative as a chat message.
 *
 * Hardening: `suppressAgentStdoutRouting` independently blocks automatic STDOUT
 * routing. Either flag set to `true` is sufficient, so a future change to
 * `inboundOnly` alone cannot re-open the leak.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect } from 'vitest';

import { ASSISTANT_NAME } from './config.js';

import {
  adminFastCommandIsOwnerAuthored,
  buildAdminFastCommandReply,
  buildCrossChannelOwnerPromptContext,
  channelJidFromEnvelopeJid,
  buildPromptMemoryContexts,
  buildPromptSkillContexts,
  buildWhatsAppObserverPromptContext,
  canPipeIntoActiveChatRun,
  classifyIpcDelivery,
  codexDesktopStopReplyText,
  codexDesktopManagedTaskStatusText,
  codexDesktopTaskBelongsToRunWindow,
  codexOnlyFailureReplyText,
  codexFullAgentProviderSucceeded,
  createProviderCircuitOutcomeLatch,
  directOwnerCodexDesktopStopMessage,
  directOwnerCodexGuiControlMessage,
  agentRunHasAmbiguousSideEffect,
  cursorAfterAmbiguousSideEffect,
  cursorAfterConfirmedSend,
  cursorAfterDeliveredIpc,
  cursorAfterPreSendError,
  cursorAfterRunnerTurn,
  extractImageGenerationPrompt,
  isBypassTriggerIngestedMessage,
  interruptCodexDesktopFromHost,
  readCodexDesktopStatusFromHost,
  inheritThreadClaudeInstructions,
  isMultiSenderChat,
  friendlyTransientAgentFailure,
  hasUnconfirmedPipedMessages,
  homogeneousMemoryRunIdentity,
  isRecoverableClaudeApiError,
  isTrustedOwnerContextRequest,
  isTrustedOwnerContextHistoryMessage,
  resolvePlanPurchaseTenantId,
  imageGenerationSafetyBlockReason,
  isTrustedWhatsAppObserverRequest,
  loadLegacyDefaultTelegramUserMemoryContext,
  linkedOwnerContextJids,
  memoryPromptSenderIdentityForMessages,
  memoryWriteAllowedForMessages,
  memoryProvenanceGrantPolicy,
  memoryRunIdentityForBinding,
  shouldIssueMemoryProvenanceGrant,
  shouldRotateActiveRunForMessages,
  shouldStartFreshRunForImageMessages,
  messagesRequestImageGeneration,
  messagesRequestVoiceReply,
  messagesMatchMemoryRunIdentity,
  parseAdminFastCommandText,
  isCodexDesktopStopCommandText,
  isExplicitCodexGuiControlCommandText,
  parseImageGenerationIntent,
  ownerCodexFullAgentSelectionReason,
  observedWhatsAppSelfHistoryMessages,
  ownerSurfaceCanReadWhatsAppObserver,
  OWNER_CROSS_CHANNEL_CONTEXT_MAX_CHARS,
  outboundEnvelopeAdvancesChatCursor,
  providerModelForAgentRunUsage,
  prependLegacyWebSearchInstruction,
  prependTenantLongTermPromptContext,
  promptRequiresDurableMemoryTools,
  isSandboxCodexPrimaryInstance,
  promptRequiresOwnerAdminRuntime,
  promptRequiresLegacyMediaVision,
  promptRequiresLegacyWebSearch,
  removeFalseVoiceCapabilityRefusal,
  resolveAdminFastCommand,
  resolveCodexCircuitProbeTimeoutMs,
  resolveCodexReserveTimeoutMs,
  resolveCodexReserveTimeoutMsForRun,
  resolveDeliveredIpcTarget,
  rewriteTransientApiError,
  sanitizeCodexRuntimeProviderClaims,
  sequentialImageMessageBatch,
  shouldUseOwnerCodexFullAgentPrimary,
  shouldUseSharedOwnerProviderCircuit,
  shouldRecordTelegramInboundEvent,
  shouldAcquirePrimaryCodexCircuitProbe,
  shouldAutoRouteAgentOutput,
  sendFirstRetryScheduledNotice,
  shouldUseCodexReserveFallback,
  shouldReconcileCodexDesktopFailure,
  stripVoiceDeliveryDirective,
  stripTenantLongTermPromptContext,
  telegramInboundEventPayload,
  textRequestsVoiceReply,
  textRequestsImageGeneration,
  whatsappObserverRequestText,
} from './message-loop.js';
import type { GroupQueueStatus } from './group-queue.js';
import type { AgentConfig, NewMessage, RegisteredGroup } from './types.js';
import type { ObservedWhatsAppMessageRecord } from './whatsapp-observer.js';
import { formatMessages } from './router.js';
import {
  createTelegramSenderIdentity,
  parseOwnerAllowlistConfig,
  type TenantRecord,
} from './tenant-registry.js';

const observedWhatsAppFixture: ObservedWhatsAppMessageRecord[] = [
  {
    messageId: 'wa-message-1',
    chatJid: '77000000000@s.whatsapp.net',
    chatLabel: 'Рабочий чат',
    senderLabel: 'Коллега',
    content: 'Встреча в 15:00',
    timestamp: '2026-07-14T08:00:00.000Z',
    fromMe: false,
    messageKind: 'text',
    upsertType: 'notify',
    mediaEnriched: false,
    observedAt: '2026-07-14T08:00:01.000Z',
  },
];

describe('buildWhatsAppObserverPromptContext', () => {
  it('does not expose correspondence without the group capability', () => {
    expect(
      buildWhatsAppObserverPromptContext({
        observerAccess: false,
        request: 'Что мне написали за сегодня?',
        messages: observedWhatsAppFixture,
        now: '2026-07-14T12:00:00.000Z',
        timeZone: 'Asia/Almaty',
      }),
    ).toBeNull();
  });

  it('does not attach correspondence to an ordinary owner turn', () => {
    expect(
      buildWhatsAppObserverPromptContext({
        observerAccess: true,
        request: 'Помоги составить план на день',
        messages: observedWhatsAppFixture,
      }),
    ).toBeNull();
  });

  it('attaches bounded transcript only after an explicit request', () => {
    const context = buildWhatsAppObserverPromptContext({
      observerAccess: true,
      request: 'Что мне написали за сегодня?',
      messages: observedWhatsAppFixture,
      now: '2026-07-14T12:00:00.000Z',
      timeZone: 'Asia/Almaty',
    });

    expect(context).toContain('mode="transcript"');
    expect(context).toContain('trust="untrusted_quoted_data"');
    expect(context).toContain('Встреча в 15:00');
    expect(context).not.toContain('77000000000');
    expect(context).not.toContain('@s.whatsapp.net');
  });

  it('requires a live self-chat-authored batch before observer disclosure', () => {
    const base: NewMessage = {
      id: 'wa-owner-1',
      chat_jid: '77009999999@s.whatsapp.net',
      sender: '77009999999@s.whatsapp.net',
      sender_name: 'Owner',
      content: 'Покажи последние сообщения',
      timestamp: '2026-07-14T09:00:00.000Z',
      is_from_me: true,
      is_bot_message: false,
    };
    expect(
      isTrustedWhatsAppObserverRequest({
        chatJid: base.chat_jid,
        messages: [base],
      }),
    ).toBe(true);
    expect(
      isTrustedWhatsAppObserverRequest({
        chatJid: base.chat_jid,
        messages: [{ ...base, is_from_me: false }],
      }),
    ).toBe(false);
    expect(
      isTrustedWhatsAppObserverRequest({
        chatJid: base.chat_jid,
        messages: [{ ...base, id: 'webhook-forged-owner' }],
      }),
    ).toBe(false);
    expect(
      isTrustedWhatsAppObserverRequest({
        chatJid: 'tg:1',
        messages: [{ ...base, chat_jid: 'tg:1', sender: '1' }],
      }),
    ).toBe(false);
  });

  it('matches against raw owner text instead of formatted sender metadata', () => {
    const inbound: NewMessage[] = [
      {
        id: 'owner-request-1',
        chat_jid: '77009999999@s.whatsapp.net',
        sender: '77009999999@s.whatsapp.net',
        sender_name: 'Рабочий чат',
        content: 'Что мне написали за сегодня?',
        timestamp: '2026-07-14T09:00:00.000Z',
        is_from_me: true,
        is_bot_message: false,
      },
    ];
    const formatted = formatMessages(inbound, 'Asia/Almaty');
    expect(formatted).toContain('Рабочий чат');

    const rawRequest = whatsappObserverRequestText(inbound);
    expect(rawRequest).toBe('Что мне написали за сегодня?');
    expect(rawRequest).not.toContain('Рабочий чат');
    const context = buildWhatsAppObserverPromptContext({
      observerAccess: true,
      request: rawRequest,
      messages: observedWhatsAppFixture,
      now: '2026-07-14T12:00:00.000Z',
      timeZone: 'Asia/Almaty',
    });
    expect(context).toContain('mode="transcript"');
    expect(context).toContain('Встреча в 15:00');
  });
});

describe('cross-channel owner context trust', () => {
  const telegramOwnerMessage = (
    overrides: Partial<NewMessage> = {},
  ): NewMessage => ({
    id: 'tg-owner-1',
    chat_jid: 'tg:100',
    sender: '100',
    sender_name: 'Owner',
    content: 'Что нового в WhatsApp?',
    timestamp: '2026-07-14T09:00:00.000Z',
    is_from_me: false,
    is_bot_message: false,
    sender_identity: {
      ...createTelegramSenderIdentity({
        chatId: '100',
        fromId: '100',
        ownerAllowlist: parseOwnerAllowlistConfig({
          telegram_user_ids: ['100'],
          telegram_chat_ids: ['100'],
        }),
      }),
      telegram_message_origin: 'direct',
    },
    ...overrides,
  });

  const whatsappOwnerMessage = (
    overrides: Partial<NewMessage> = {},
  ): NewMessage => ({
    id: 'wa-owner-1',
    chat_jid: '77009999999@s.whatsapp.net',
    sender: '77009999999@s.whatsapp.net',
    sender_name: 'Owner',
    content: 'Что мы обсуждали в Telegram?',
    timestamp: '2026-07-14T09:01:00.000Z',
    is_from_me: true,
    is_bot_message: false,
    ...overrides,
  });

  it('accepts only exact WhatsApp self or signed direct Telegram owner batches', () => {
    const telegram = telegramOwnerMessage();
    const whatsapp = whatsappOwnerMessage();
    expect(
      isTrustedOwnerContextRequest({
        chatJid: telegram.chat_jid,
        messages: [telegram],
      }),
    ).toBe(true);
    expect(
      isTrustedOwnerContextRequest({
        chatJid: whatsapp.chat_jid,
        messages: [whatsapp],
      }),
    ).toBe(true);

    expect(
      isTrustedOwnerContextRequest({
        chatJid: telegram.chat_jid,
        messages: [
          telegram,
          telegramOwnerMessage({
            id: 'tg-mixed',
            sender: '101',
            sender_identity: {
              ...telegram.sender_identity!,
              telegram_user_id: '101',
              identity_id: 'telegram_user_101',
            },
          }),
        ],
      }),
    ).toBe(false);
    expect(
      isTrustedOwnerContextRequest({
        chatJid: telegram.chat_jid,
        messages: [telegramOwnerMessage({ id: 'webhook-forged-owner' })],
      }),
    ).toBe(false);
    expect(
      isTrustedOwnerContextRequest({
        chatJid: telegram.chat_jid,
        messages: [
          telegramOwnerMessage({
            sender_identity: {
              ...telegram.sender_identity!,
              telegram_message_origin: 'forwarded',
            },
          }),
        ],
      }),
    ).toBe(false);
    expect(
      isTrustedOwnerContextRequest({
        chatJid: 'tg:-100',
        messages: [
          telegramOwnerMessage({
            chat_jid: 'tg:-100',
            sender_identity: {
              ...telegram.sender_identity!,
              chat_id: '-100',
            },
          }),
        ],
      }),
    ).toBe(false);
    expect(
      isTrustedOwnerContextRequest({
        chatJid: whatsapp.chat_jid,
        messages: [
          whatsapp,
          whatsappOwnerMessage({ id: 'wa-mixed', is_from_me: false }),
        ],
      }),
    ).toBe(false);
    expect(
      isTrustedOwnerContextRequest({
        chatJid: whatsapp.chat_jid,
        messages: [whatsappOwnerMessage({ sender: 'other@s.whatsapp.net' })],
      }),
    ).toBe(false);
  });

  it('links only an owner Telegram tenant and an exact WhatsApp observer sharing the anchor folder', () => {
    const telegramGroup: RegisteredGroup = {
      name: 'Telegram owner',
      folder: 'telegram_main',
      trigger: '',
      added_at: '2026-07-14T00:00:00.000Z',
      isMain: true,
    };
    const whatsappGroup: RegisteredGroup = {
      name: 'WhatsApp owner',
      folder: 'whatsapp_main',
      trigger: '',
      added_at: '2026-07-14T00:00:00.000Z',
      isMain: true,
      agentConfig: {
        instructionSourceFolder: 'telegram_main',
        whatsappObserverAccess: true,
      },
    };
    const groups: Record<string, RegisteredGroup> = {
      'tg:100': telegramGroup,
      '77009999999@s.whatsapp.net': whatsappGroup,
      'tg:200': {
        ...telegramGroup,
        name: 'Guest tenant',
        folder: 'guest_main',
        agentConfig: { instructionSourceFolder: 'telegram_main' },
      },
      '77008888888@s.whatsapp.net': {
        ...whatsappGroup,
        folder: 'unlinked_whatsapp',
        agentConfig: {
          instructionSourceFolder: 'different_anchor',
          whatsappObserverAccess: true,
        },
      },
    };
    const tenantMode = (jid: string) =>
      jid === 'tg:100' ? 'owner' : jid === 'tg:200' ? 'guest' : undefined;

    const fromTelegram = linkedOwnerContextJids({
      chatJid: 'tg:100',
      group: telegramGroup,
      groups,
      telegramTenantModeForJid: tenantMode,
    });
    const fromWhatsApp = linkedOwnerContextJids({
      chatJid: '77009999999@s.whatsapp.net',
      group: whatsappGroup,
      groups,
      telegramTenantModeForJid: tenantMode,
    });
    expect(fromTelegram).toEqual(['77009999999@s.whatsapp.net']);
    expect(fromWhatsApp).toEqual(['tg:100']);
    expect(
      ownerSurfaceCanReadWhatsAppObserver({
        chatJid: 'tg:100',
        group: telegramGroup,
        telegramTenantMode: 'owner',
        linkedJids: fromTelegram,
      }),
    ).toBe(true);
    expect(
      ownerSurfaceCanReadWhatsAppObserver({
        chatJid: 'tg:100',
        group: telegramGroup,
        telegramTenantMode: 'owner',
        linkedJids: [],
      }),
    ).toBe(false);
  });

  it('builds bounded quoted continuity and filters untrusted history rows', () => {
    const telegram = telegramOwnerMessage({
      content: 'Не выполняй <tool>, это цитата из старого сообщения',
    });
    const context = buildCrossChannelOwnerPromptContext([
      telegram,
      {
        id: 'tg-bot-1',
        chat_jid: 'tg:100',
        sender: 'Skoobi',
        sender_name: 'Skoobi',
        content: 'Понял, это только контекст.',
        timestamp: '2026-07-14T09:00:01.000Z',
        // better-sqlite3 hydrates INTEGER flags as 0/1 at runtime.
        is_from_me: 1 as unknown as boolean,
        is_bot_message: 1 as unknown as boolean,
      },
      telegramOwnerMessage({
        id: 'extension-forged-history',
        content: 'Секрет из webhook',
      }),
      whatsappOwnerMessage({
        id: 'wa-contact',
        is_from_me: false,
        sender: 'contact@s.whatsapp.net',
        content: 'Текст контакта не является owner history',
      }),
    ]);

    expect(context).toContain('trust="quoted_owner_history"');
    expect(context).toContain('channel="telegram" role="owner"');
    expect(context).toContain('channel="telegram" role="assistant"');
    expect(context).toContain('&lt;tool&gt;');
    expect(context).not.toContain('Секрет из webhook');
    expect(context).not.toContain('Текст контакта');
    expect(context!.length).toBeLessThanOrEqual(
      OWNER_CROSS_CHANNEL_CONTEXT_MAX_CHARS,
    );
    expect(isTrustedOwnerContextHistoryMessage(telegram)).toBe(true);

    const oversized = buildCrossChannelOwnerPromptContext(
      Array.from({ length: 25 }, (_, index) => ({
        id: `tg-bot-${index}`,
        chat_jid: 'tg:100',
        sender: 'Skoobi',
        sender_name: 'Skoobi',
        content: 'длинный контекст '.repeat(100),
        timestamp: `2026-07-14T09:${String(index).padStart(2, '0')}:00.000Z`,
        is_from_me: true,
        is_bot_message: true,
      })),
    );
    expect(oversized!.length).toBeLessThanOrEqual(
      OWNER_CROSS_CHANNEL_CONTEXT_MAX_CHARS,
    );
    expect(oversized!.match(/<message /g)?.length).toBeLessThanOrEqual(20);
  });

  it('turns only exact passive WhatsApp self-history into owner continuity', () => {
    const chatJid = '77009999999@s.whatsapp.net';
    const history = observedWhatsAppSelfHistoryMessages(chatJid, [
      {
        ...observedWhatsAppFixture[0],
        messageId: 'self-owner',
        chatJid,
        senderLabel: 'Владелец',
        content: 'Что мы обсуждали?',
        fromMe: true,
      },
      {
        ...observedWhatsAppFixture[0],
        messageId: 'self-bot',
        chatJid,
        senderLabel: ASSISTANT_NAME,
        content: `[${ASSISTANT_NAME}] Обсуждали встречу.`,
        fromMe: true,
      },
      {
        ...observedWhatsAppFixture[0],
        messageId: 'contact',
        chatJid,
        senderLabel: 'Контакт',
        content: 'Чужое сообщение',
        fromMe: false,
      },
    ]);

    expect(history).toHaveLength(2);
    expect(history.map((message) => message.is_bot_message)).toEqual([
      false,
      true,
    ]);
    expect(buildCrossChannelOwnerPromptContext(history)).toContain(
      'Обсуждали встречу.',
    );
  });

  it('allows an explicit observer query from the linked Telegram owner surface', () => {
    const request = telegramOwnerMessage({
      content: 'Что мне написали за сегодня?',
    });
    const telegramGroup: RegisteredGroup = {
      name: 'Telegram owner',
      folder: 'telegram_main',
      trigger: '',
      added_at: '2026-07-14T00:00:00.000Z',
      isMain: true,
    };
    const access =
      isTrustedOwnerContextRequest({
        chatJid: request.chat_jid,
        messages: [request],
      }) &&
      ownerSurfaceCanReadWhatsAppObserver({
        chatJid: request.chat_jid,
        group: telegramGroup,
        telegramTenantMode: 'owner',
        linkedJids: ['77009999999@s.whatsapp.net'],
      });
    const context = buildWhatsAppObserverPromptContext({
      observerAccess: access,
      request: request.content,
      messages: observedWhatsAppFixture,
      now: '2026-07-14T12:00:00.000Z',
      timeZone: 'Asia/Almaty',
    });

    expect(context).toContain('Встреча в 15:00');
    expect(context).toContain('trust="untrusted_quoted_data"');
  });
});

describe('shouldAutoRouteAgentOutput', () => {
  it('returns true when agentConfig is undefined (default behaviour)', () => {
    expect(shouldAutoRouteAgentOutput(undefined)).toBe(true);
  });

  it('returns true when agentConfig is an empty object', () => {
    expect(shouldAutoRouteAgentOutput({})).toBe(true);
  });

  it('returns true when both flags are explicitly false', () => {
    expect(
      shouldAutoRouteAgentOutput({
        inboundOnly: false,
        suppressAgentStdoutRouting: false,
      }),
    ).toBe(true);
  });

  it('blocks routing when inboundOnly is true (legacy gate)', () => {
    expect(shouldAutoRouteAgentOutput({ inboundOnly: true })).toBe(false);
  });

  it('blocks routing when suppressAgentStdoutRouting is true (defense-in-depth gate)', () => {
    expect(
      shouldAutoRouteAgentOutput({ suppressAgentStdoutRouting: true }),
    ).toBe(false);
  });

  it('blocks routing when both flags are true', () => {
    expect(
      shouldAutoRouteAgentOutput({
        inboundOnly: true,
        suppressAgentStdoutRouting: true,
      }),
    ).toBe(false);
  });

  // Hardening regression: inboundOnly may be false when explicit outbound is
  // needed, but suppressAgentStdoutRouting must still block automatic delivery
  // of the agent's internal narrative.
  it('blocks routing on supplier-facing group config (inboundOnly:false + suppressAgentStdoutRouting:true)', () => {
    const supplierFacingConfig: AgentConfig = {
      model: 'claude-opus-4-7',
      effort: 'medium',
      systemPrompt: 'live supplier persona',
      allowedTools: ['Bash', 'Read'],
      disallowedTools: ['Write', 'Edit', 'mcp__claudeclaw__send_voice_message'],
      noSandbox: true,
      fullAccess: true,
      mediaIngestion: true,
      inboundOnly: false,
      suppressAgentStdoutRouting: true,
    };
    expect(shouldAutoRouteAgentOutput(supplierFacingConfig)).toBe(false);
  });

  it('still allows routing for groups that opt in (no flags set, telegram_main-style)', () => {
    const ownerControlGroupConfig: AgentConfig = {
      model: 'claude-opus-4-7',
      systemPrompt: 'owner control group',
      noSandbox: true,
      fullAccess: true,
      // no inboundOnly, no suppressAgentStdoutRouting
    };
    expect(shouldAutoRouteAgentOutput(ownerControlGroupConfig)).toBe(true);
  });
});

describe('outboundEnvelopeAdvancesChatCursor', () => {
  it('keeps ordinary agent IPC delivery cursor semantics', () => {
    expect(
      outboundEnvelopeAdvancesChatCursor({
        chatJid: 'tg:1',
        text: 'done',
        triggerType: 'ipc',
      }),
    ).toBe(true);
  });

  it('does not let persisted image recovery acknowledge an unrelated run', () => {
    expect(
      outboundEnvelopeAdvancesChatCursor({
        chatJid: 'tg:1',
        text: 'Готово.',
        triggerType: 'ipc',
        meta: {
          kind: 'image_job_photo',
          suppressCursorAdvance: true,
          imageJobId: 'img-1',
        },
      }),
    ).toBe(false);
  });
});

describe('canPipeIntoActiveChatRun', () => {
  it('keeps follow-ups queued while an image-generation turn is active', () => {
    expect(canPipeIntoActiveChatRun(true, true)).toBe(false);
    expect(canPipeIntoActiveChatRun(true, false)).toBe(true);
    expect(canPipeIntoActiveChatRun(false, false)).toBe(false);
  });

  it('forces an image follow-up onto a fresh host-owned run', () => {
    const imageMessage: NewMessage = {
      id: 'image-follow-up',
      chat_jid: 'tg:1',
      sender: 'user',
      sender_name: 'User',
      content: 'Нарисуй кота',
      timestamp: '2026-07-13T12:00:00.500000000001Z',
    };
    expect(shouldStartFreshRunForImageMessages(true, [imageMessage])).toBe(
      true,
    );
    expect(shouldStartFreshRunForImageMessages(false, [imageMessage])).toBe(
      false,
    );
    expect(
      shouldStartFreshRunForImageMessages(true, [
        imageMessage,
        {
          ...imageMessage,
          id: 'ordinary-follow-up',
          content: 'и пришли сюда',
          timestamp: '2026-07-13T12:00:01.500000000002Z',
        },
      ]),
    ).toBe(true);
  });
});

describe('sendFirstRetryScheduledNotice', () => {
  const group = (
    overrides: Partial<RegisteredGroup> = {},
  ): RegisteredGroup => ({
    name: 'Test',
    folder: 'test',
    trigger: '@bot',
    added_at: '2026-07-11T00:00:00.000Z',
    ...overrides,
  });

  it('sends exactly on the first retry for a direct-reply group', async () => {
    const sent: string[] = [];
    const router = {
      send: async (chatJid: string) => {
        sent.push(chatJid);
      },
    };
    const registeredGroups = { 'tg:1': group() };

    await expect(
      sendFirstRetryScheduledNotice({
        chatJid: 'tg:1',
        retryCount: 1,
        registeredGroups,
        router,
      }),
    ).resolves.toBe(true);
    await expect(
      sendFirstRetryScheduledNotice({
        chatJid: 'tg:1',
        retryCount: 2,
        registeredGroups,
        router,
      }),
    ).resolves.toBe(false);
    expect(sent).toEqual(['tg:1']);
  });

  it('suppresses notices for missing, inbound-only, stdout-suppressed, and trigger-only groups', async () => {
    let calls = 0;
    const router = {
      send: async () => {
        calls++;
      },
    };
    const cases: Array<Record<string, RegisteredGroup>> = [
      {},
      { 'tg:1': group({ agentConfig: { inboundOnly: true } }) },
      {
        'tg:1': group({
          agentConfig: { suppressAgentStdoutRouting: true },
        }),
      },
      { 'tg:1': group({ requiresTrigger: true }) },
    ];
    for (const registeredGroups of cases) {
      await expect(
        sendFirstRetryScheduledNotice({
          chatJid: 'tg:1',
          retryCount: 1,
          registeredGroups,
          router,
        }),
      ).resolves.toBe(false);
    }
    expect(calls).toBe(0);
  });

  it('swallows delivery failures so the queue can continue', async () => {
    await expect(
      sendFirstRetryScheduledNotice({
        chatJid: 'tg:1',
        retryCount: 1,
        registeredGroups: { 'tg:1': group() },
        router: {
          send: async () => {
            throw new Error('network down');
          },
        },
      }),
    ).resolves.toBe(false);
  });
});

describe('Codex circuit probe timeout selection', () => {
  it('uses the 900s full-agent timeout and honours an explicit reserve override', () => {
    expect(resolveCodexReserveTimeoutMs({})).toBe(900_000);
    expect(
      resolveCodexReserveTimeoutMs({
        SKOOBI_CODEX_RESERVE_TIMEOUT_MS: '1200000',
      }),
    ).toBe(1_200_000);
    expect(
      resolveCodexCircuitProbeTimeoutMs({
        fullAgent: true,
        reserveTimeoutMs: 900_000,
        codexTimeoutMs: 90_000,
        searchTimeoutMs: 45_000,
      }),
    ).toBe(900_000);
  });

  it('widens direct-owner Desktop-capable runs to 30 minutes without changing guest runs', () => {
    expect(
      resolveCodexReserveTimeoutMsForRun({
        codexGuiControlAuthorized: false,
        env: {},
      }),
    ).toBe(900_000);
    expect(
      resolveCodexReserveTimeoutMsForRun({
        codexGuiControlAuthorized: true,
        env: {},
      }),
    ).toBe(1_800_000);
    expect(
      resolveCodexReserveTimeoutMsForRun({
        codexGuiControlAuthorized: false,
        codexDesktopControlRunEligible: true,
        env: {},
      }),
    ).toBe(1_800_000);
    expect(
      resolveCodexReserveTimeoutMsForRun({
        codexGuiControlAuthorized: true,
        env: { SKOOBI_CODEX_RESERVE_TIMEOUT_MS: '2400000' },
      }),
    ).toBe(2_400_000);
  });

  it('budgets the configured one/two thin attempts and adds sequential search', () => {
    expect(
      resolveCodexCircuitProbeTimeoutMs({
        fullAgent: false,
        codexTimeoutMs: 90_000,
        codexAttemptCount: 1,
      }),
    ).toBe(90_000);
    expect(
      resolveCodexCircuitProbeTimeoutMs({
        fullAgent: false,
        codexTimeoutMs: 90_000,
        codexAttemptCount: 2,
      }),
    ).toBe(180_000);
    expect(
      resolveCodexCircuitProbeTimeoutMs({
        fullAgent: false,
        includeSearch: true,
        codexTimeoutMs: 90_000,
        codexAttemptCount: 2,
        searchTimeoutMs: 45_000,
      }),
    ).toBe(225_000);
  });

  it('does not acquire a probe for requests already committed to a pre-skip path', () => {
    const base = {
      tenantAvailable: true,
      liveModeSelected: true,
      providerFallbackActive: false,
      ownerFullAgentCandidate: false,
      mediaVisionNeedsLegacy: false,
      webSearchNeedsLegacy: false,
      codexWebSearchEnabled: true,
    };
    expect(
      shouldAcquirePrimaryCodexCircuitProbe({
        ...base,
        providerFallbackActive: true,
      }),
    ).toBe(false);
    expect(
      shouldAcquirePrimaryCodexCircuitProbe({
        ...base,
        mediaVisionNeedsLegacy: true,
      }),
    ).toBe(false);
    expect(
      shouldAcquirePrimaryCodexCircuitProbe({
        ...base,
        webSearchNeedsLegacy: true,
        codexWebSearchEnabled: false,
      }),
    ).toBe(false);
  });

  it('acquires only when thin or full-agent Codex will actually run', () => {
    const base = {
      tenantAvailable: true,
      liveModeSelected: true,
      providerFallbackActive: false,
      ownerFullAgentCandidate: false,
      mediaVisionNeedsLegacy: false,
      webSearchNeedsLegacy: false,
      codexWebSearchEnabled: true,
    };
    expect(shouldAcquirePrimaryCodexCircuitProbe(base)).toBe(true);
    expect(
      shouldAcquirePrimaryCodexCircuitProbe({
        ...base,
        webSearchNeedsLegacy: true,
      }),
    ).toBe(true);
    expect(
      shouldAcquirePrimaryCodexCircuitProbe({
        ...base,
        ownerFullAgentCandidate: true,
        mediaVisionNeedsLegacy: true,
        webSearchNeedsLegacy: true,
        codexWebSearchEnabled: false,
      }),
    ).toBe(true);
  });

  it('settles full-agent health from provider outcome, not auto-route delivery', () => {
    expect(
      codexFullAgentProviderSucceeded({
        active: true,
        runStatus: 'success',
        hadError: false,
        answerPartCount: 1,
        outputSentToUser: false,
      }),
    ).toBe(true);
    // A delivered first turn stays a provider success even if a later
    // follow-up failed before the runner exited.
    expect(
      codexFullAgentProviderSucceeded({
        active: true,
        runStatus: 'error',
        hadError: true,
        answerPartCount: 1,
        outputSentToUser: true,
      }),
    ).toBe(true);
    expect(
      codexFullAgentProviderSucceeded({
        active: true,
        runStatus: 'error',
        hadError: true,
        answerPartCount: 0,
        outputSentToUser: false,
      }),
    ).toBe(false);
  });

  it('suppresses replay after a streamed host action even with a synthetic success exit', () => {
    expect(
      agentRunHasAmbiguousSideEffect({
        status: 'error',
        sideEffected: true,
      }),
    ).toBe(true);
    expect(
      agentRunHasAmbiguousSideEffect({
        status: 'success',
        hadError: true,
        sideEffected: true,
      }),
    ).toBe(true);
    expect(
      agentRunHasAmbiguousSideEffect({
        status: 'success',
        sideEffected: true,
        outputSentToUser: false,
      }),
    ).toBe(true);
    expect(
      agentRunHasAmbiguousSideEffect({
        status: 'success',
        sideEffected: true,
        outputSentToUser: true,
      }),
    ).toBe(false);
    expect(
      agentRunHasAmbiguousSideEffect({
        status: 'error',
        sideEffected: false,
      }),
    ).toBe(false);
  });

  it('confirms the piped boundary only when the side effect followed an initial reply', () => {
    expect(
      cursorAfterAmbiguousSideEffect({
        currentCursor: '001',
        targetCursor: '010',
        pipedCursor: '020',
        initialBatchDelivered: false,
      }),
    ).toBe('010');
    expect(
      cursorAfterAmbiguousSideEffect({
        currentCursor: '010',
        targetCursor: '010',
        pipedCursor: '020',
        initialBatchDelivered: true,
      }),
    ).toBe('020');
  });

  it('settles provider success once before a deferred delivery can finish', async () => {
    const calls: string[] = [];
    const latch = createProviderCircuitOutcomeLatch<string>({
      onSuccess: () => calls.push('provider-success'),
      onFailure: (reason) => calls.push(`provider-failure:${reason}`),
    });
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const deliver = async () => {
      latch.settleSuccess();
      calls.push('delivery-wait');
      await deliveryGate;
      calls.push('delivery-done');
    };

    const pendingDelivery = deliver();
    expect(latch.outcome()).toBe('success');
    expect(calls).toEqual(['provider-success', 'delivery-wait']);
    expect(latch.settleFailure('late-follow-up-error')).toBe(false);
    expect(latch.settleSuccess()).toBe(false);
    releaseDelivery();
    await pendingDelivery;
    expect(calls).toEqual([
      'provider-success',
      'delivery-wait',
      'delivery-done',
    ]);
  });
});

describe('admin fast command parsing', () => {
  function message(content: string): NewMessage {
    return {
      id: Math.random().toString(36),
      chat_jid: 'tg:100000001',
      sender: '100000001',
      sender_name: 'Owner',
      content,
      timestamp: '2026-06-09T08:41:21.000Z',
      is_bot_message: false,
    };
  }

  it('recognizes an explicit Sonnet model switch', () => {
    expect(parseAdminFastCommandText('Давай на соннет переключай')).toEqual({
      kind: 'model_switch',
      model: 'claude-sonnet-4-6',
      label: 'Sonnet',
    });
  });

  it('recognizes an explicit Opus model switch', () => {
    expect(parseAdminFastCommandText('Скуби, поставь Opus')).toEqual({
      kind: 'model_switch',
      model: 'claude-opus-4-8',
      label: 'Opus',
    });
  });

  it('recognizes Fable 5 / Mythos model switches', () => {
    expect(parseAdminFastCommandText('Поставь Митос')).toEqual({
      kind: 'model_switch',
      model: 'claude-fable-5',
      label: 'Fable 5 / Mythos',
    });
    expect(parseAdminFastCommandText('switch to Fable')).toEqual({
      kind: 'model_switch',
      model: 'claude-fable-5',
      label: 'Fable 5 / Mythos',
    });
  });

  it('recognizes short status pings', () => {
    expect(parseAdminFastCommandText('Ну как?')).toEqual({ kind: 'status' });
    expect(parseAdminFastCommandText('Ау')).toEqual({ kind: 'status' });
    expect(parseAdminFastCommandText('Ты тут?')).toEqual({ kind: 'status' });
    expect(parseAdminFastCommandText('Что молчишь?')).toEqual({
      kind: 'status',
    });
    expect(parseAdminFastCommandText('Что с ботом')).toEqual({
      kind: 'status',
    });
  });

  it('strips only a complete configured assistant mention', () => {
    expect(parseAdminFastCommandText(`@${ASSISTANT_NAME} Ну как?`)).toEqual({
      kind: 'status',
    });
    expect(parseAdminFastCommandText(`@${ASSISTANT_NAME}2 Ну как?`)).toBeNull();
  });

  it('fails closed without throwing for non-string command input', () => {
    expect(() =>
      parseAdminFastCommandText(undefined as unknown as string),
    ).not.toThrow();
    expect(
      parseAdminFastCommandText(undefined as unknown as string),
    ).toBeNull();
    expect(() =>
      parseAdminFastCommandText(Symbol('command') as unknown as string),
    ).not.toThrow();
    expect(isCodexDesktopStopCommandText(null as unknown as string)).toBe(
      false,
    );
  });

  it('recognizes manual unstick commands', () => {
    expect(parseAdminFastCommandText('/unstick')).toEqual({ kind: 'unstick' });
    expect(parseAdminFastCommandText('Скуби, сними зависание')).toEqual({
      kind: 'unstick',
    });
    expect(parseAdminFastCommandText('перезапусти агента')).toEqual({
      kind: 'unstick',
    });
  });

  it('recognizes synthetic deterministic operational questions', () => {
    expect(
      parseAdminFastCommandText(
        'Посчитай активные запланированные задачи этого чата, но не показывай их текст или расписание. Ничего не создавай.',
      ),
    ).toEqual({ kind: 'task_count' });
    expect(
      parseAdminFastCommandText(
        'Что происходит при первом автоматическом retry задачи и уведомляется ли чат? Ничего не запускай.',
      ),
    ).toEqual({ kind: 'retry_policy' });
    expect(
      parseAdminFastCommandText(
        'Можно ли из обычного Telegram-запроса запускать вложенные Codex или Claude coding agents? Ответь по своей действующей политике.',
      ),
    ).toEqual({ kind: 'nested_agent_policy' });
  });

  it('returns the latest read-only operational command in a fast-command batch', () => {
    expect(
      resolveAdminFastCommand([
        message('Ну как?'),
        message(
          'Что происходит при первом автоматическом retry задачи и уведомляется ли чат?',
        ),
      ]),
    ).toEqual({ kind: 'retry_policy' });
  });

  it('does not intercept ordinary admin investigation requests', () => {
    expect(
      parseAdminFastCommandText('посмотри логи сервиса и проверь почему долго'),
    ).toBeNull();
    expect(
      parseAdminFastCommandText('проведи полный аудит админского чата'),
    ).toBeNull();
    expect(
      parseAdminFastCommandText(
        'проверь статус выполнения миграции в логах и исправь ошибки',
      ),
    ).toBeNull();
  });

  it('handles a recovery batch of model switch plus follow-up pings', () => {
    expect(
      resolveAdminFastCommand([
        message('Давай на соннет переключай'),
        message('Ну как?'),
        message('Что молчишь?'),
      ]),
    ).toEqual({
      kind: 'model_switch',
      model: 'claude-sonnet-4-6',
      label: 'Sonnet',
    });
  });

  it('does not intercept mixed batches with normal work', () => {
    expect(
      resolveAdminFastCommand([
        message('Ну как?'),
        message('посмотри переписку в админском чате'),
      ]),
    ).toBeNull();
  });

  it('reports the effective Codex model instead of the dormant Claude preset', () => {
    const reply = buildAdminFastCommandReply({
      command: { kind: 'status' },
      group: {
        name: 'Admin',
        folder: 'telegram_main',
        trigger: '@Skoobi',
        added_at: '2026-07-10T00:00:00.000Z',
        isMain: true,
        agentConfig: { model: 'claude-opus-4-8' },
      },
      effectiveModel: 'gpt-5.6-sol',
      queueStatus: {
        active: false,
        activeForMs: null,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        groupFolder: null,
        containerName: null,
        retryCount: 0,
      },
      changed: false,
    });

    expect(reply).toContain('`gpt-5.6-sol`');
    expect(reply).not.toContain('`claude-opus-4-8`');
  });

  it('reports a managed Desktop task even when the Telegram runner is idle', () => {
    const reply = buildAdminFastCommandReply({
      command: { kind: 'status' },
      group: {
        name: 'Admin',
        folder: 'telegram_main',
        trigger: '@Skoobi',
        added_at: '2026-07-10T00:00:00.000Z',
        isMain: true,
      },
      queueStatus: {
        active: false,
        activeForMs: null,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        groupFolder: null,
        containerName: null,
        retryCount: 0,
      },
      codexDesktopTask: {
        status: 'completed',
        startedAt: '2026-07-24T09:14:08.000Z',
        updatedAt: '2026-07-24T09:33:50.000Z',
        completedAt: '2026-07-24T09:33:50.000Z',
      },
      changed: false,
    });

    expect(reply).toContain('активного agent-run сейчас нет');
    expect(reply).toContain('задача Codex Desktop завершена');
    expect(reply).not.toContain('taskTitle');
    expect(reply).not.toContain('cwd');

    const combinedReply = buildAdminFastCommandReply({
      command: { kind: 'status' },
      group: {
        name: 'Admin',
        folder: 'telegram_main',
        trigger: '@Skoobi',
        added_at: '2026-07-10T00:00:00.000Z',
        isMain: true,
      },
      queueStatus: {
        active: false,
        activeForMs: null,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        groupFolder: null,
        containerName: null,
        retryCount: 0,
      },
      imageJobStatusText: 'Изображение готово.',
      codexDesktopTask: {
        status: 'inProgress',
        startedAt: '2026-07-24T09:14:08.000Z',
        updatedAt: '2026-07-24T09:20:00.000Z',
        completedAt: null,
      },
      changed: false,
    });
    expect(combinedReply).toContain('Изображение готово.');
    expect(combinedReply).toContain('Codex Desktop сейчас выполняется');
  });

  it('does not claim a Claude switch changed the active Codex runtime', () => {
    const reply = buildAdminFastCommandReply({
      command: {
        kind: 'model_switch',
        model: 'claude-opus-4-8',
        label: 'Opus',
      },
      group: {
        name: 'Admin',
        folder: 'telegram_main',
        trigger: '@Skoobi',
        added_at: '2026-07-10T00:00:00.000Z',
        isMain: true,
        agentConfig: { model: 'claude-opus-4-8' },
      },
      previousModel: 'claude-opus-4-8',
      effectiveModel: 'gpt-5.6-sol',
      modelSwitchBlockedByCodex: true,
      queueStatus: {
        active: false,
        activeForMs: null,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        groupFolder: null,
        containerName: null,
        retryCount: 0,
      },
      changed: false,
    });

    expect(reply).toContain('`gpt-5.6-sol`');
    expect(reply).toContain('не применил');
    expect(reply).not.toContain('админский чат переключил');
  });

  it('answers operational questions from host state without model guesses', () => {
    const group: RegisteredGroup = {
      name: 'Admin',
      folder: 'telegram_main',
      trigger: '@Skoobi',
      added_at: '2026-07-10T00:00:00.000Z',
      isMain: true,
    };
    const queueStatus: GroupQueueStatus = {
      active: false,
      activeForMs: null,
      idleWaiting: false,
      isTaskContainer: false,
      runningTaskId: null,
      pendingMessages: false,
      groupFolder: null,
      containerName: null,
      retryCount: 0,
    };

    const taskReply = buildAdminFastCommandReply({
      command: { kind: 'task_count' },
      group,
      queueStatus,
      activeTaskCount: 1,
      changed: false,
    });
    expect(taskReply).toContain('задач: 1');
    expect(taskReply).toContain('Текст и расписание задач не раскрываю');

    const retryReply = buildAdminFastCommandReply({
      command: { kind: 'retry_policy' },
      group,
      queueStatus,
      changed: false,
    });
    expect(retryReply).toContain('через 5 секунд');
    expect(retryReply).toContain('через 5 минут');
    expect(retryReply).toContain('отдельного сообщения');

    const policyReply = buildAdminFastCommandReply({
      command: { kind: 'nested_agent_policy' },
      group,
      queueStatus,
      changed: false,
    });
    expect(policyReply).toContain('не запускаю вложенные Codex или Claude');
    expect(policyReply).toContain('даже по явной просьбе');
    expect(policyReply).toContain('настольном Codex');
  });
});

describe('cursorAfterConfirmedSend', () => {
  it('advances to the target cursor when no piped messages were sent', () => {
    expect(
      cursorAfterConfirmedSend(
        '2026-05-09T08:47:29.000Z',
        '2026-05-09T08:47:52.000Z',
      ),
    ).toBe('2026-05-09T08:47:52.000Z');
  });

  it('advances to the piped cursor when it is newer than the initial batch', () => {
    expect(
      cursorAfterConfirmedSend(
        '2026-05-09T08:47:29.000Z',
        '2026-05-09T08:47:29.000Z',
        '2026-05-09T08:47:56.000Z',
      ),
    ).toBe('2026-05-09T08:47:56.000Z');
  });

  it('never moves the cursor backwards on later results from the same runner', () => {
    expect(
      cursorAfterConfirmedSend(
        '2026-05-09T08:47:56.000Z',
        '2026-05-09T08:47:29.000Z',
      ),
    ).toBe('2026-05-09T08:47:56.000Z');
  });
});

describe('promptRequiresDurableMemoryTools', () => {
  it('flags memory verbs and only memory verbs (guest escalation reuses it)', () => {
    expect(promptRequiresDurableMemoryTools('запомни: я люблю чай')).toBe(true);
    expect(promptRequiresDurableMemoryTools('запиши себе мой размер 42')).toBe(
      true,
    );
    expect(
      promptRequiresDurableMemoryTools('сохрани в память адрес склада'),
    ).toBe(true);
    // Not memory: plain chat, a past-tense form, a non-memory «запиши».
    expect(promptRequiresDurableMemoryTools('все норм?')).toBe(false);
    expect(promptRequiresDurableMemoryTools('я запомнил твой совет')).toBe(
      false,
    );
    expect(promptRequiresDurableMemoryTools('запиши меня к врачу')).toBe(false);
    // Admin/scheduling verbs must NOT light this up — guests get memory only.
    expect(promptRequiresDurableMemoryTools('посмотри логи сервиса')).toBe(
      false,
    );
    expect(
      promptRequiresDurableMemoryTools('поставь напоминание на четверг'),
    ).toBe(false);
  });
});

describe('promptRequiresOwnerAdminRuntime', () => {
  it('keeps simple owner conversation eligible for Codex live', () => {
    expect(promptRequiresOwnerAdminRuntime('все норм?')).toBe(false);
    expect(promptRequiresOwnerAdminRuntime('объясни коротко идею')).toBe(false);
  });

  it('routes local admin operations to the protected admin runtime', () => {
    expect(promptRequiresOwnerAdminRuntime('посмотри логи сервиса')).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('закоммить локально')).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('npm test и проверь build')).toBe(
      true,
    );
    expect(promptRequiresOwnerAdminRuntime('прочитай .env проекта')).toBe(true);
  });

  it('routes durable-memory writes to the full agent (thin live has no memory_save)', () => {
    expect(
      promptRequiresOwnerAdminRuntime(
        'запомни: тестовый стенд обновляется 1 января',
      ),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime(
        'Запомните пожалуйста номер тестового заказа',
      ),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime(
        'запиши себе что тестовый провайдер включён',
      ),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime('сохрани в память адрес склада'),
    ).toBe(true);
  });

  it('keeps everyday «запиши/сохрани» requests on the fast live path', () => {
    expect(
      promptRequiresOwnerAdminRuntime('запиши меня к врачу на среду'),
    ).toBe(false);
    expect(
      promptRequiresOwnerAdminRuntime('сохрани спокойствие и ответь коротко'),
    ).toBe(false);
  });

  it('routes reminder/scheduling requests to the full agent (thin live has no schedule_task)', () => {
    expect(
      promptRequiresOwnerAdminRuntime(
        'поставь напоминание на четверг 10:00 проверить тестовый стенд',
      ),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime('напомни мне завтра про оплату домена'),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime('отмени напоминание про тестовый стенд'),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime('запланируй созвон с коллегой на утро'),
    ).toBe(true);
    // «напомнил/напоминает» (past/3rd person narration) must not escalate.
    expect(
      promptRequiresOwnerAdminRuntime('он мне напомнил про долг, смешно'),
    ).toBe(false);
  });

  it('isSandboxCodexPrimaryInstance follows the instance env flag', () => {
    // Codex-only instances: tenant-less turns (WhatsApp)
    // must run the Codex full agent instead of the credential-less claude_sdk.
    const prev = process.env.SKOOBI_SANDBOX_CODEX_PRIMARY;
    try {
      process.env.SKOOBI_SANDBOX_CODEX_PRIMARY = 'true';
      expect(isSandboxCodexPrimaryInstance()).toBe(true);
      process.env.SKOOBI_SANDBOX_CODEX_PRIMARY = 'false';
      expect(isSandboxCodexPrimaryInstance()).toBe(false);
      delete process.env.SKOOBI_SANDBOX_CODEX_PRIMARY;
      expect(isSandboxCodexPrimaryInstance()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SKOOBI_SANDBOX_CODEX_PRIMARY;
      else process.env.SKOOBI_SANDBOX_CODEX_PRIMARY = prev;
    }
  });

  it('routes scheduler task management to the full agent (thin live has no cancel/cleanup tools)', () => {
    // Task-management requests need the full runtime because the thin path has
    // no cancellation or cleanup tools.
    expect(
      promptRequiresOwnerAdminRuntime('удали у себя все завершенные задачи'),
    ).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('очисти завершённые задачи')).toBe(
      true,
    );
    expect(
      promptRequiresOwnerAdminRuntime('отмени задачу про тестовый отчёт'),
    ).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('убери старые задачи')).toBe(true);
    // Plain conversation about tasks (no modification verb) stays live.
    expect(promptRequiresOwnerAdminRuntime('как у тебя дела с задачами?')).toBe(
      false,
    );
  });

  it('routes synthetic Raspberry Pi service operations to the protected admin runtime', () => {
    expect(
      promptRequiresOwnerAdminRuntime('зайди на пи и проверь тестовый сервис'),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime(
        'поправь на распберри конфигурацию тестового сервиса',
      ),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime('посмотри логи fixture-service на rpi'),
    ).toBe(true);
    // «пи» must not fire inside ordinary words («напиши», «спит»).
    expect(promptRequiresOwnerAdminRuntime('напиши стишок про пирог')).toBe(
      false,
    );
    expect(
      promptRequiresOwnerAdminRuntime('покажи число пи до 20 знаков'),
    ).toBe(false);
    expect(promptRequiresOwnerAdminRuntime('посмотри на малинку на фото')).toBe(
      false,
    );
    expect(promptRequiresOwnerAdminRuntime('расскажи про Raspberry Pi')).toBe(
      false,
    );
    expect(
      promptRequiresOwnerAdminRuntime('подключись к тестовой малинке по ssh'),
    ).toBe(true);
  });

  it('routes Google Workspace/Calendar work to the full agent (thin live has no google_* tools)', () => {
    // Named Google-table writes need the full runtime because the thin path has
    // no Google Workspace tools.
    expect(
      promptRequiresOwnerAdminRuntime(
        'в гугл ТЕСТОВАЯ ТАБЛИЦА добавь три строки',
      ),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime('добавь в таблицу строку: тест, 123'),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime('прочитай что в гугл таблице на листе 1'),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime('скинь файл отчёта на гугл диск'),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime(
        'посмотри что у меня в календаре на завтра',
      ),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime(
        'создай гугл документ с планом на неделю и пришли ссылку',
      ),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime('проверь последние письма в Gmail'),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime(
        'Скуби, покажи последние непрочитанные письма в Gmail',
      ),
    ).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('проверь почту')).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('check email')).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('show my inbox')).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('show my emails')).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('search Gmail for invoices')).toBe(
      true,
    );
    expect(promptRequiresOwnerAdminRuntime('list unread mail')).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('list unread emails')).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('open latest email')).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('what is in my inbox')).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('who emailed me?')).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('find email in Gmail')).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime('найди в почте письмо от Ивана'),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime('проверь непрочитанные письма в Gmail'),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime('сколько непрочитанных в почте'),
    ).toBe(true);
    expect(promptRequiresOwnerAdminRuntime('что нового во входящих?')).toBe(
      true,
    );
    expect(
      promptRequiresOwnerAdminRuntime('найди документ где мы писали про смету'),
    ).toBe(true);
    // Synthetic voice fixtures cover colloquial infinitives and the diminutive
    // «табличке», rather than only imperative commands.
    expect(
      promptRequiresOwnerAdminRuntime(
        '[Voice: Скуби, можешь посмотреть, что записано в тестовой табличке Ledger в Google таблицах?]',
      ),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime(
        '[Voice: Скуби, доступ к Google таблицам снова работает, попробуй добавить тестовую строку в табель Ledger.]',
      ),
    ).toBe(true);
    expect(
      promptRequiresOwnerAdminRuntime('глянь что в таблице по учёту'),
    ).toBe(true);
    // Bare content question without any verb still escalates (read intent).
    expect(
      promptRequiresOwnerAdminRuntime('что там нового в гугл таблице?'),
    ).toBe(true);
    // Google/tables as mere conversation topic (no action verb) stays live.
    expect(
      promptRequiresOwnerAdminRuntime('чем гугл таблицы лучше экселя?'),
    ).toBe(false);
    expect(promptRequiresOwnerAdminRuntime('напиши письмо другу')).toBe(false);
    expect(promptRequiresOwnerAdminRuntime('проверь входящие данные')).toBe(
      false,
    );
    for (const command of [
      'проверь почтовый модуль',
      'найди почтальона',
      'посмотри почтовый сервер',
      'check email validation',
      'show mail server logs',
      'find mailbox parser code',
      'найди почту компании Acme',
      'find email address for Acme company',
      'покажи почту Ивана',
      "find Ivan's email",
      'find email for Ivan',
      'find email from Ivan in Telegram',
      'find email from Ivan in Slack',
      'find email from Ivan on Telegram',
      'find emails on Slack',
      'find email in this chat',
      'find email in this message',
      'find email in the PDF',
      'find emails in this document',
      'show emails in the CSV',
      'show email copied into Telegram',
      'read the email pasted below',
      'read this email',
      'read the following email',
      'what is my Gmail password?',
      'покажи пароль от Gmail',
    ]) {
      expect(promptRequiresOwnerAdminRuntime(command), command).toBe(false);
    }
    // Plain poem without any Google object stays live too.
    expect(promptRequiresOwnerAdminRuntime('напиши стишок про лошадку')).toBe(
      false,
    );
  });
});

describe('shouldUseOwnerCodexFullAgentPrimary', () => {
  it('uses Codex full-agent only for enabled owner admin live turns', () => {
    expect(
      shouldUseOwnerCodexFullAgentPrimary({
        liveModeSelected: true,
        isOwnerTenant: true,
        ownerAdminRuntimeRequired: true,
        enabled: true,
      }),
    ).toBe(true);

    expect(
      shouldUseOwnerCodexFullAgentPrimary({
        liveModeSelected: true,
        isOwnerTenant: true,
        ownerAdminRuntimeRequired: true,
        enabled: false,
      }),
    ).toBe(false);
    expect(
      shouldUseOwnerCodexFullAgentPrimary({
        liveModeSelected: true,
        isOwnerTenant: false,
        ownerAdminRuntimeRequired: true,
        enabled: true,
      }),
    ).toBe(false);
    expect(
      shouldUseOwnerCodexFullAgentPrimary({
        liveModeSelected: true,
        isOwnerTenant: true,
        ownerAdminRuntimeRequired: false,
        enabled: true,
      }),
    ).toBe(false);
    expect(
      shouldUseOwnerCodexFullAgentPrimary({
        liveModeSelected: true,
        isOwnerTenant: true,
        ownerAdminRuntimeRequired: false,
        enabled: false,
        forcedByGroup: true,
      }),
    ).toBe(false);
    expect(
      shouldUseOwnerCodexFullAgentPrimary({
        liveModeSelected: true,
        isOwnerTenant: true,
        ownerAdminRuntimeRequired: false,
        enabled: true,
        forcedByGroup: true,
      }),
    ).toBe(true);
    expect(
      shouldUseOwnerCodexFullAgentPrimary({
        liveModeSelected: true,
        isOwnerTenant: false,
        ownerAdminRuntimeRequired: false,
        enabled: false,
        forcedByGroup: true,
      }),
    ).toBe(false);
    expect(
      shouldUseOwnerCodexFullAgentPrimary({
        liveModeSelected: true,
        isOwnerTenant: true,
        ownerAdminRuntimeRequired: false,
        enabled: true,
        mode: 'always',
      }),
    ).toBe(true);
    expect(
      shouldUseOwnerCodexFullAgentPrimary({
        liveModeSelected: true,
        isOwnerTenant: true,
        ownerAdminRuntimeRequired: true,
        enabled: true,
        mode: 'always',
        forcedByGroup: true,
        providerFallbackActive: true,
      }),
    ).toBe(false);
  });
});

describe('ownerCodexFullAgentSelectionReason', () => {
  it('explains per-group forced full-agent routing', () => {
    expect(
      ownerCodexFullAgentSelectionReason({
        active: true,
        mode: 'auto',
        ownerAdminRuntimeRequired: false,
        forcedByGroup: true,
      }),
    ).toBe('owner_group_forced');
  });

  it('explains always-mode full-agent routing even for ordinary owner turns', () => {
    expect(
      ownerCodexFullAgentSelectionReason({
        active: true,
        mode: 'always',
        ownerAdminRuntimeRequired: false,
      }),
    ).toBe('owner_mode_always');
  });

  it('explains auto-mode full-agent routing for admin runtime prompts', () => {
    expect(
      ownerCodexFullAgentSelectionReason({
        active: true,
        mode: 'auto',
        ownerAdminRuntimeRequired: true,
      }),
    ).toBe('owner_admin_runtime_required');
  });

  it('omits a reason when full-agent routing is inactive', () => {
    expect(
      ownerCodexFullAgentSelectionReason({
        active: false,
        mode: 'always',
        ownerAdminRuntimeRequired: true,
      }),
    ).toBeUndefined();
  });
});

describe('providerModelForAgentRunUsage', () => {
  it('records Codex full-agent primary usage as codex-subscription', () => {
    expect(
      providerModelForAgentRunUsage({
        ownerCodexFullAgentPrimaryActive: true,
        agentModel: 'claude-opus-4-8',
      }),
    ).toBe('codex-subscription');
  });

  it('records Claude fallback usage as the configured agent model', () => {
    expect(
      providerModelForAgentRunUsage({
        ownerCodexFullAgentPrimaryActive: true,
        providerFallbackAttempt: {
          provider: 'codex_subscription_cli',
          status: 'failed',
          reason: 'runtime_error',
        },
        agentModel: 'claude-opus-4-8',
      }),
    ).toBe('claude-opus-4-8');
  });
});

describe('rewriteTransientApiError', () => {
  it('rewrites JSON Anthropic overloaded errors into a friendly message', () => {
    expect(
      rewriteTransientApiError(
        'API Error: 529 {"error":{"type":"overloaded_error","message":"Overloaded"}}',
      ),
    ).toContain('Сейчас модель перегружена');
  });

  it('rewrites plain-text 529 overload errors into a friendly message', () => {
    expect(
      rewriteTransientApiError(
        'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
      ),
    ).toContain('Лимит за этот сбой не списан');
  });

  it('rewrites provider rate-limit and usage-limit API errors without leaking provider text', () => {
    expect(
      rewriteTransientApiError(
        'API Error: 429 Your credit balance is too low. request_id=secret-ish-debug-id',
      ),
    ).toBe(
      'Сейчас модель упёрлась во временный лимит. Лимит за этот сбой не списан.',
    );
    expect(
      rewriteTransientApiError('API Error: 400 Usage limit exceeded'),
    ).toBe(
      'Сейчас модель упёрлась во временный лимит. Лимит за этот сбой не списан.',
    );
    expect(
      rewriteTransientApiError(
        "You've hit your limit · resets Jun 9 at 1am (Asia/Almaty)",
      ),
    ).toBe(
      'Сейчас модель упёрлась во временный лимит. Лимит за этот сбой не списан.',
    );
  });

  it('marks Claude limit and 5xx API envelopes as recoverable for Codex reserve fallback', () => {
    expect(isRecoverableClaudeApiError('API Error: 429 rate limit')).toBe(true);
    expect(isRecoverableClaudeApiError('API Error: 529 Overloaded')).toBe(true);
    expect(isRecoverableClaudeApiError('API Error: 400 usage limit')).toBe(
      true,
    );
    expect(
      isRecoverableClaudeApiError(
        "You've hit your limit · resets Jun 9 at 1am (Asia/Almaty)",
      ),
    ).toBe(true);
    expect(isRecoverableClaudeApiError('API Error: 401 unauthorized')).toBe(
      false,
    );
  });

  it('rewrites plain 5xx API errors without leaking provider text', () => {
    const rewritten = rewriteTransientApiError(
      'API Error: 500 Internal server error. request_id=secret-ish-debug-id',
    );
    expect(rewritten).toBe(
      'Временный сбой API модели. Попробуй ещё раз. Лимит за этот сбой не списан.',
    );
  });

  it('does not rewrite non-transient API errors', () => {
    expect(
      rewriteTransientApiError('API Error: 401 {"error":{"type":"auth"}}'),
    ).toBeNull();
  });
});

describe('friendlyTransientAgentFailure', () => {
  it('turns generic server_error stop failures into a safe user message', () => {
    expect(friendlyTransientAgentFailure('server_error')).toBe(
      'Модель сейчас не ответила из-за временного сбоя. Попробуй ещё раз через минуту. Лимит за этот сбой не списан.',
    );
  });

  it('does not rewrite unknown non-transient agent errors', () => {
    expect(friendlyTransientAgentFailure('permission denied')).toBeNull();
  });
});

describe('sanitizeCodexRuntimeProviderClaims', () => {
  it('removes stale Claude-provider limit wording from Codex-delivered text', () => {
    expect(
      sanitizeCodexRuntimeProviderClaims(
        'Claude сейчас упёрся в лимит. Лимит за этот сбой не списан.',
      ),
    ).toBe(
      'Сейчас модель упёрлась во временный лимит. Лимит за этот сбой не списан.',
    );
  });

  it('keeps unrelated Claude discussion intact', () => {
    expect(
      sanitizeCodexRuntimeProviderClaims(
        'Гайд по Claude Fable 5 сохранил как справку на будущее.',
      ),
    ).toBe('Гайд по Claude Fable 5 сохранил как справку на будущее.');
  });
});

describe('shouldUseCodexReserveFallback', () => {
  it('uses Codex reserve when Claude errors before sending a user answer', () => {
    expect(
      shouldUseCodexReserveFallback({
        runStatus: 'error',
        outputSentToUser: false,
        autoRoute: true,
        tenantAvailable: true,
        reserveEnabled: true,
        legacyAnswerPartCount: 0,
      }),
    ).toBe(true);
  });

  it('uses Codex reserve when Claude exits successfully but emits no answer', () => {
    expect(
      shouldUseCodexReserveFallback({
        runStatus: 'success',
        outputSentToUser: false,
        autoRoute: true,
        tenantAvailable: true,
        reserveEnabled: true,
        legacyAnswerPartCount: 0,
      }),
    ).toBe(true);
  });

  it('does not use Codex reserve after Claude already sent an answer', () => {
    expect(
      shouldUseCodexReserveFallback({
        runStatus: 'success',
        outputSentToUser: true,
        autoRoute: true,
        tenantAvailable: true,
        reserveEnabled: true,
        legacyAnswerPartCount: 1,
      }),
    ).toBe(false);
  });

  it('does not use Codex reserve when the feature flag is disabled', () => {
    expect(
      shouldUseCodexReserveFallback({
        runStatus: 'error',
        outputSentToUser: false,
        autoRoute: true,
        tenantAvailable: true,
        reserveEnabled: false,
        legacyAnswerPartCount: 0,
      }),
    ).toBe(false);
  });
});

describe('promptRequiresLegacyMediaVision', () => {
  it('routes old video-note placeholders that need Read tool to legacy vision', () => {
    expect(
      promptRequiresLegacyMediaVision(
        '[Video note Transcript: где я? Key frames: received/frame-01.jpg — use Read tool to inspect visual context]',
      ),
    ).toBe(true);
  });

  it('routes new video-note placeholders without visual summary to legacy vision', () => {
    expect(
      promptRequiresLegacyMediaVision(
        '[Video note Transcript: где я? Key-frame files: received/frame-01.jpg]',
      ),
    ).toBe(true);
  });

  it('keeps video-note placeholders eligible for Codex live when safe image attachments are available', () => {
    expect(
      promptRequiresLegacyMediaVision(
        '[Video note Transcript: где я? Key-frame files: received/frame-01.jpg]',
        true,
      ),
    ).toBe(false);
  });

  it('keeps video-note placeholders with visual summary eligible for live text runtime', () => {
    expect(
      promptRequiresLegacyMediaVision(
        '[Video note Transcript: где я? Visual summary: человек стоит на пляже. Key-frame files: received/frame-01.jpg]',
      ),
    ).toBe(false);
  });

  it('routes uncaptained photo placeholders that require Read tool to legacy vision', () => {
    expect(
      promptRequiresLegacyMediaVision(
        '[Photo. File: received/photo.jpg — use Read tool to inspect visual context]',
      ),
    ).toBe(true);
  });

  it('keeps uncaptained photo placeholders eligible for Codex live when image attachments are available', () => {
    expect(
      promptRequiresLegacyMediaVision(
        '[Photo. File: received/photo.jpg — use Read tool to inspect visual context]',
        true,
      ),
    ).toBe(false);
  });

  it('does not route plain voice transcripts to legacy vision', () => {
    expect(promptRequiresLegacyMediaVision('[Voice: привет]')).toBe(false);
  });
});

describe('promptRequiresLegacyWebSearch', () => {
  it('routes explicit Russian internet lookup requests to legacy web search', () => {
    expect(
      promptRequiresLegacyWebSearch(
        '<message sender="User">Посмотри в интернете свежие новости OpenAI</message>',
      ),
    ).toBe(true);
  });

  it('routes public business contact list requests to web search even without the word internet', () => {
    expect(
      promptRequiresLegacyWebSearch(
        '<message sender="User">Дай список книжных магазинов в тестовом городе с телефонами, адресами, почтой и сайтами</message>',
      ),
    ).toBe(true);
    expect(
      promptRequiresLegacyWebSearch(
        '<message sender="User">Собери поставщиков канцтоваров: телефон, WhatsApp, адрес и сайт</message>',
      ),
    ).toBe(true);
  });

  it('routes explicit English web lookup requests to legacy web search', () => {
    expect(
      promptRequiresLegacyWebSearch(
        '<message sender="User">Please search the web for today news about OpenAI</message>',
      ),
    ).toBe(true);
  });

  it('does not route local memory/chat searches to web search', () => {
    expect(
      promptRequiresLegacyWebSearch(
        '<message sender="User">Найди в памяти, что я писал про отпуск</message>',
      ),
    ).toBe(false);
  });

  it('honors explicit no-search wording', () => {
    expect(
      promptRequiresLegacyWebSearch(
        '<message sender="User">Без интернета, объясни что такое инфляция</message>',
      ),
    ).toBe(false);
  });

  it('does not route ordinary chat to legacy web search', () => {
    expect(
      promptRequiresLegacyWebSearch(
        '<message sender="User">Напиши поздравление другу</message>',
      ),
    ).toBe(false);
  });

  it('adds a compact WebSearch instruction for Claude fallback', () => {
    const prompt = prependLegacyWebSearchInstruction('USER: найди компании', {
      providerFallback: true,
    });
    expect(prompt).toContain('Codex web search failed');
    expect(prompt).toContain('use WebSearch/WebFetch');
    expect(prompt).toContain('Do not invent contacts');
  });
});

describe('image generation intent detection', () => {
  it('detects explicit Russian draw requests and extracts only the image prompt', () => {
    expect(
      textRequestsImageGeneration('Нарисуй чёрного пса в стиле стикера'),
    ).toBe(true);
    expect(
      extractImageGenerationPrompt('Сгенерируй картинку: уютный робот в саду'),
    ).toBe('уютный робот в саду');
    expect(
      extractImageGenerationPrompt('Создай логотип для кофейни у моря'),
    ).toBe('для кофейни у моря');
    expect(parseImageGenerationIntent('Нарисуй')).toEqual({
      requested: true,
      prompt: '',
      requiresSourceImage: false,
    });
  });

  it('detects explicit English image requests', () => {
    expect(
      extractImageGenerationPrompt('Generate an image of a black dog mascot'),
    ).toBe('a black dog mascot');
    expect(textRequestsImageGeneration('Draw a cyberpunk city')).toBe(true);
  });

  it('does not trigger on explanations, local search, or explicit no-image wording', () => {
    expect(textRequestsImageGeneration('Объясни как нарисовать кота')).toBe(
      false,
    );
    expect(textRequestsImageGeneration('Сделай таблицу расходов')).toBe(false);
    expect(textRequestsImageGeneration('Generate a poem about robots')).toBe(
      false,
    );
    expect(textRequestsImageGeneration('Не рисуй, просто опиши идею')).toBe(
      false,
    );
    expect(textRequestsImageGeneration('Найди картинки в интернете')).toBe(
      false,
    );
  });

  it('checks only user messages in the current turn', () => {
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'tg:1',
        sender: 'bot',
        sender_name: 'Skoobi',
        content: 'Нарисуй картинку',
        timestamp: '2026-05-19T00:00:00.000Z',
        is_bot_message: true,
      },
      {
        id: '2',
        chat_jid: 'tg:1',
        sender: 'user',
        sender_name: 'User',
        content: 'Нарисуй кота космонавта',
        timestamp: '2026-05-19T00:00:01.000Z',
      },
    ];
    expect(messagesRequestImageGeneration(messages)).toEqual({
      requested: true,
      prompt: 'кота космонавта',
      requiresSourceImage: false,
    });
    expect(messagesRequestImageGeneration([messages[0]])).toBeNull();
  });

  it('keeps each image request on its own cursor boundary', () => {
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'tg:1',
        sender: 'user',
        sender_name: 'User',
        content: 'Нарисуй кота',
        timestamp: '2026-05-19T00:00:00.000Z',
      },
      {
        id: '2',
        chat_jid: 'tg:1',
        sender: 'user',
        sender_name: 'User',
        content: 'Нарисуй собаку',
        timestamp: '2026-05-19T00:00:01.000Z',
      },
    ];

    expect(sequentialImageMessageBatch(messages)).toEqual({
      messages: [messages[0]],
      deferred: true,
    });
  });

  it('keeps a same-second Telegram cohort atomic and requests every image', () => {
    const timestamp = '2026-05-19T00:00:00.000Z';
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'tg:1',
        sender: 'user',
        sender_name: 'User',
        content: 'Нарисуй кота',
        timestamp,
      },
      {
        id: '2',
        chat_jid: 'tg:1',
        sender: 'user',
        sender_name: 'User',
        content: 'Нарисуй собаку',
        timestamp,
      },
    ];

    expect(sequentialImageMessageBatch(messages)).toEqual({
      messages,
      deferred: false,
    });
    expect(messagesRequestImageGeneration(messages)?.prompt).toBe(
      'Создай 2 отдельные картинки в указанном порядке:\n1. кота\n2. собаку',
    );
  });

  it('answers ordinary messages before starting a later image job', () => {
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'tg:1',
        sender: 'user',
        sender_name: 'User',
        content: 'Сколько сейчас времени?',
        timestamp: '2026-05-19T00:00:00.000Z',
      },
      {
        id: '2',
        chat_jid: 'tg:1',
        sender: 'user',
        sender_name: 'User',
        content: 'Нарисуй часы',
        timestamp: '2026-05-19T00:00:01.000Z',
      },
    ];

    expect(sequentialImageMessageBatch(messages)).toEqual({
      messages: [messages[0]],
      deferred: true,
    });
  });

  it('keeps an immediately preceding photo with its image-edit command', () => {
    const messages: NewMessage[] = [
      {
        id: 'photo',
        chat_jid: 'tg:1',
        sender: 'user',
        sender_name: 'User',
        content: '[Photo File: /workspace/group/received/source.jpg]',
        timestamp: '2026-05-19T00:00:00.000Z',
      },
      {
        id: 'edit',
        chat_jid: 'tg:1',
        sender: 'user',
        sender_name: 'User',
        content: 'Сделай по этому фото портрет в стиле акварели',
        timestamp: '2026-05-19T00:00:01.000Z',
      },
    ];

    expect(sequentialImageMessageBatch(messages)).toEqual({
      messages,
      deferred: false,
    });
    expect(messagesRequestImageGeneration(messages)).toMatchObject({
      requested: true,
      requiresSourceImage: true,
    });
  });

  it('does not reuse an older image prompt when the latest user message is not an image request', () => {
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'tg:1',
        sender: 'user',
        sender_name: 'User',
        content: 'Нарисуй тестовый пейзаж',
        timestamp: '2026-05-19T00:00:00.000Z',
      },
      {
        id: '2',
        chat_jid: 'tg:1',
        sender: 'user',
        sender_name: 'User',
        content: 'Что это?',
        timestamp: '2026-05-19T00:00:01.000Z',
      },
    ];

    expect(messagesRequestImageGeneration(messages)).toBeNull();
  });

  it('does not guess bare "а/тогда + phrase" follow-ups as image requests (context-free → false positives in normal chat)', () => {
    // A bare continuation is indistinguishable from ordinary chat without image
    // context, so it must NOT be treated as an image request. The last entries
    // are synthetic regression phrases that must remain ordinary chat.
    for (const text of [
      'Тогда парусник',
      'А лошадь',
      'А сейчас',
      'А сейчас как',
      'А теперь почему',
      'А что это',
      'А сухой как',
      'А тестовый сервис будет отвечать автоматически',
      'а в карточке контакта нет поля для сайта',
    ]) {
      expect(parseImageGenerationIntent(text)).toEqual({
        requested: false,
        prompt: '',
        requiresSourceImage: false,
      });
    }
  });

  it('detects natural voice-transcript phrasing with "надо нарисовать"', () => {
    expect(
      parseImageGenerationIntent(
        '[Voice: Нет, мне тестового зелёного робота надо нарисовать красивого, фотореалистичного.]',
      ),
    ).toEqual({
      requested: true,
      prompt: 'тестового зелёного робота красивого, фотореалистичного',
      requiresSourceImage: false,
    });
    expect(
      parseImageGenerationIntent('Нужно нарисовать красивую собаку'),
    ).toEqual({
      requested: true,
      prompt: 'красивую собаку',
      requiresSourceImage: false,
    });
    expect(
      parseImageGenerationIntent(
        '[Voice: Нарисую красивого фотореалистичного тестового робота.]',
      ),
    ).toEqual({
      requested: true,
      prompt: 'красивого фотореалистичного тестового робота',
      requiresSourceImage: false,
    });
    expect(parseImageGenerationIntent('Не надо рисовать собаку')).toEqual({
      requested: false,
      prompt: '',
      requiresSourceImage: false,
    });
  });

  it('detects a synthetic Skoobi voice request and removes Telegram delivery wording from the visual prompt', () => {
    expect(
      parseImageGenerationIntent(
        '[Voice: Скубин нарисуй тестовый зелёный парк и воздушного змея. И эту картинку мне пришли сюда в телеграмм.]',
      ),
    ).toEqual({
      requested: true,
      prompt: 'тестовый зелёный парк и воздушного змея',
      requiresSourceImage: false,
    });
    expect(
      parseImageGenerationIntent(
        'Скуби, нарисуй рыжего кота и отправь картинку в Telegram',
      ),
    ).toEqual({
      requested: true,
      prompt: 'рыжего кота',
      requiresSourceImage: false,
    });
  });

  it('asks for description instead of trying to draw the user from memory', () => {
    expect(parseImageGenerationIntent('Нарисуй меня')).toEqual({
      requested: true,
      prompt: '',
      requiresSourceImage: true,
    });
  });

  it('blocks sexualized nudity image prompts before provider generation', () => {
    expect(imageGenerationSafetyBlockReason('сиськи')).toBe('sexual_nudity');
    expect(imageGenerationSafetyBlockReason('nude woman')).toBe(
      'sexual_nudity',
    );
    expect(imageGenerationSafetyBlockReason('эротическая анатомия тела')).toBe(
      'sexual_nudity',
    );
    expect(imageGenerationSafetyBlockReason('девушка в платье')).toBeNull();
  });

  it('allows non-sexual medical or educational anatomy image prompts', () => {
    expect(
      imageGenerationSafetyBlockReason(
        'учебная медицинская анатомическая схема обнаженного тела',
      ),
    ).toBeNull();
    expect(
      imageGenerationSafetyBlockReason('clinical anatomy diagram of nude body'),
    ).toBeNull();
    expect(
      imageGenerationSafetyBlockReason('анатомическая схема молочной железы'),
    ).toBeNull();
  });

  it('treats short unsafe image follow-ups as host-blocked image requests', () => {
    expect(parseImageGenerationIntent('А сиськи')).toEqual({
      requested: true,
      prompt: 'сиськи',
      requiresSourceImage: false,
    });
    expect(parseImageGenerationIntent('Просто сиськи')).toEqual({
      requested: true,
      prompt: 'сиськи',
      requiresSourceImage: false,
    });
    expect(parseImageGenerationIntent('Что такое сиськи?')).toEqual({
      requested: false,
      prompt: '',
      requiresSourceImage: false,
    });
  });

  it('marks source photo edit requests as unsupported source-image generation', () => {
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'tg:1',
        sender: 'user',
        sender_name: 'User',
        content:
          '[Photo. File: received/photo.jpg — use Read tool to inspect visual context]',
        timestamp: '2026-05-19T00:00:00.000Z',
      },
      {
        id: '2',
        chat_jid: 'tg:1',
        sender: 'user',
        sender_name: 'User',
        content: '[Voice: измени на этом фото цвет куртки на зелёный]',
        timestamp: '2026-05-19T00:00:01.000Z',
      },
    ];

    expect(messagesRequestImageGeneration(messages)).toMatchObject({
      requested: true,
      requiresSourceImage: true,
    });
  });
});

describe('voice reply request detection', () => {
  it('detects explicit Russian voice requests', () => {
    expect(textRequestsVoiceReply('Ответь мне голосом, пожалуйста')).toBe(true);
    expect(textRequestsVoiceReply('Озвучь это нормальным голосом')).toBe(true);
    expect(textRequestsVoiceReply('Запиши голосовое сообщение')).toBe(true);
    expect(textRequestsVoiceReply('Голосом стих хочу')).toBe(true);
    expect(
      textRequestsVoiceReply(
        '[Voice: Расскажи голосом короткий тестовый стишок.]',
      ),
    ).toBe(true);
  });

  it('detects explicit English voice requests', () => {
    expect(textRequestsVoiceReply('Please send a voice reply')).toBe(true);
    expect(textRequestsVoiceReply('Read it aloud')).toBe(true);
  });

  it('honors explicit text-only wording', () => {
    expect(textRequestsVoiceReply('Не голосом, ответь текстом')).toBe(false);
    expect(textRequestsVoiceReply('text only, no voice')).toBe(false);
  });

  it('does not trigger on media placeholder words alone', () => {
    expect(
      textRequestsVoiceReply('[Voice saved at received/a.oga: привет]'),
    ).toBe(false);
    expect(
      textRequestsVoiceReply('[Voice saved at received/a.oga: ответь голосом]'),
    ).toBe(true);
  });

  it('checks only user messages in the current turn', () => {
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'tg:1',
        sender: 'bot',
        sender_name: 'Skoobi',
        content: 'Могу ответить голосом',
        timestamp: '2026-05-19T00:00:00.000Z',
        is_from_me: true,
      },
      {
        id: '2',
        chat_jid: 'tg:1',
        sender: 'user',
        sender_name: 'User',
        content: 'Скажи это голосом',
        timestamp: '2026-05-19T00:00:01.000Z',
      },
    ];
    expect(messagesRequestVoiceReply(messages)).toBe(true);
    expect(messagesRequestVoiceReply([messages[0]])).toBe(false);
  });

  it('strips voice delivery wording before the model sees the prompt', () => {
    expect(stripVoiceDeliveryDirective('Расскажи голосом стишок')).toBe(
      'Расскажи стишок',
    );
    expect(stripVoiceDeliveryDirective('Голосом стих хочу')).toBe('стих хочу');
    expect(stripVoiceDeliveryDirective('Озвучь это для меня')).toBe(
      'напиши это для меня',
    );
  });

  it('removes false voice capability refusals before host TTS delivery', () => {
    expect(
      removeFalseVoiceCapabilityRefusal(
        'Пользователь, голосом отправить не могу, только текстом. Вот тестовый текст:\n\nПример ответа.',
      ),
    ).toBe('Вот тестовый текст:\n\nПример ответа.');
    expect(
      removeFalseVoiceCapabilityRefusal(
        'Голосом не могу, пользователь. Только текстом:\n\nПример.',
      ),
    ).toBe('Пример.');
  });
});

describe('hasUnconfirmedPipedMessages', () => {
  it('returns false when there is no piped cursor', () => {
    expect(
      hasUnconfirmedPipedMessages(undefined, '2026-05-09T08:47:56.000Z'),
    ).toBe(false);
  });

  it('returns true when piped cursor is newer than confirmed cursor', () => {
    expect(
      hasUnconfirmedPipedMessages(
        '2026-05-09T08:48:10.000Z',
        '2026-05-09T08:47:56.000Z',
      ),
    ).toBe(true);
  });

  it('returns false when piped cursor was already confirmed', () => {
    expect(
      hasUnconfirmedPipedMessages(
        '2026-05-09T08:47:56.000Z',
        '2026-05-09T08:47:56.000Z',
      ),
    ).toBe(false);
  });
});

describe('cursorAfterRunnerTurn', () => {
  const T0 = '2026-06-02T10:00:00.000Z'; // cursor before the batch
  const T1 = '2026-06-02T10:00:05.000Z'; // initial batch (targetCursor)
  const T2 = '2026-06-02T10:00:09.000Z'; // follow-up piped during the run

  it('advances the initial batch reply to targetCursor only, NOT folding the piped window', () => {
    // First delivered turn answers the initial batch. A follow-up piped in
    // afterwards has NOT been answered yet, so it must not be folded into the
    // cursor (H2) — and the piped window must be kept (foldedPiped=false).
    expect(
      cursorAfterRunnerTurn({
        initialBatchDelivered: false,
        currentCursor: T0,
        targetCursor: T1,
        pipedCursor: T2,
      }),
    ).toEqual({ cursor: T1, foldedPiped: false });
  });

  it('folds the piped window once a follow-up turn has been delivered', () => {
    expect(
      cursorAfterRunnerTurn({
        initialBatchDelivered: true,
        currentCursor: T1,
        targetCursor: T1,
        pipedCursor: T2,
      }),
    ).toEqual({ cursor: T2, foldedPiped: true });
  });

  it('advances to targetCursor on the initial batch when there is no piped follow-up', () => {
    expect(
      cursorAfterRunnerTurn({
        initialBatchDelivered: false,
        currentCursor: T0,
        targetCursor: T1,
        pipedCursor: undefined,
      }),
    ).toEqual({ cursor: T1, foldedPiped: false });
  });

  it('never moves the cursor backward on a later result from the same runner', () => {
    expect(
      cursorAfterRunnerTurn({
        initialBatchDelivered: true,
        currentCursor: T2,
        targetCursor: T1,
        pipedCursor: undefined,
      }),
    ).toEqual({ cursor: T2, foldedPiped: true });
  });

  // The core H2 regression: a follow-up message piped into a runner that then
  // dies after answering ONLY the initial batch must survive (not be folded
  // past the cursor and silently lost). Modelled as the real state machine:
  // onOutput(turn) advances the cursor; post-run reconciliation re-checks the
  // piped window when the run ends with an error.
  it('regression: a piped follow-up survives when the runner dies after answering only the initial batch (H2)', () => {
    let cursor: string | undefined = T0;
    let pipedCursor: string | undefined = T2; // M2 piped during B1's turn
    let initialBatchDelivered = false;

    // Turn 1: runner answers the initial batch B1; reply delivered.
    const turn1 = cursorAfterRunnerTurn({
      initialBatchDelivered,
      currentCursor: cursor,
      targetCursor: T1,
      pipedCursor,
    });
    cursor = turn1.cursor;
    if (turn1.foldedPiped) pipedCursor = undefined;
    initialBatchDelivered = true;

    // Initial batch confirmed, but M2 is NOT yet folded into the cursor.
    expect(cursor).toBe(T1);
    expect(turn1.foldedPiped).toBe(false);
    expect(pipedCursor).toBe(T2);

    // Runner dies/idle-closes before answering M2. Post-run reconciliation
    // (outputSentToUser was true) detects the still-unconfirmed piped window
    // and re-dispatches it instead of silently losing it.
    expect(hasUnconfirmedPipedMessages(pipedCursor, cursor)).toBe(true);

    // The already-delivered initial batch is NOT re-processed (cursor is past
    // it); only the unanswered follow-up M2 (T2 > cursor) is re-read.
    expect(T1 > (cursor || '')).toBe(false);
    expect(T2 > (cursor || '')).toBe(true);
  });

  it('a healthy multi-turn run folds each follow-up exactly once — no loss, no duplicate', () => {
    let cursor: string | undefined = T0;
    let pipedCursor: string | undefined = T2;
    let initialBatchDelivered = false;

    // Turn 1: B1 answered → cursor=T1, piped window kept.
    const t1 = cursorAfterRunnerTurn({
      initialBatchDelivered,
      currentCursor: cursor,
      targetCursor: T1,
      pipedCursor,
    });
    cursor = t1.cursor;
    if (t1.foldedPiped) pipedCursor = undefined;
    initialBatchDelivered = true;
    expect(cursor).toBe(T1);
    expect(pipedCursor).toBe(T2);

    // Turn 2: M2 answered → cursor=T2, piped window folded & cleared.
    const t2 = cursorAfterRunnerTurn({
      initialBatchDelivered,
      currentCursor: cursor,
      targetCursor: T1,
      pipedCursor,
    });
    cursor = t2.cursor;
    if (t2.foldedPiped) pipedCursor = undefined;
    expect(t2.foldedPiped).toBe(true);
    expect(cursor).toBe(T2);
    expect(pipedCursor).toBeUndefined();

    // Clean exit: nothing unconfirmed → no fresh re-dispatch (no duplicate).
    expect(hasUnconfirmedPipedMessages(pipedCursor, cursor)).toBe(false);
  });
});

describe('cursorAfterDeliveredIpc', () => {
  const T0 = '2026-06-02T10:00:00.000Z'; // cursor before the batch
  const T1 = '2026-06-02T10:00:05.000Z'; // initial batch (targetCursor)
  const T2 = '2026-06-02T10:00:09.000Z'; // follow-up piped during the run

  it('advances the initial IPC delivery to targetCursor only, NOT folding the piped window', () => {
    // The FIRST confirmed IPC delivery answers the initial batch. A follow-up
    // piped in afterwards has NOT been answered yet, so it must not be folded
    // into the cursor (H2) — and the piped window must be kept
    // (foldedPiped=false), mirroring the stdout path exactly.
    expect(
      cursorAfterDeliveredIpc({
        initialDeliveryConfirmed: false,
        currentCursor: T0,
        targetCursor: T1,
        pipedCursor: T2,
      }),
    ).toEqual({ cursor: T1, foldedPiped: false });
  });

  it('folds the piped window once an initial IPC delivery has been confirmed', () => {
    expect(
      cursorAfterDeliveredIpc({
        initialDeliveryConfirmed: true,
        currentCursor: T1,
        targetCursor: T1,
        pipedCursor: T2,
      }),
    ).toEqual({ cursor: T2, foldedPiped: true });
  });

  it('advances to targetCursor on the initial delivery when there is no piped follow-up', () => {
    expect(
      cursorAfterDeliveredIpc({
        initialDeliveryConfirmed: false,
        currentCursor: T0,
        targetCursor: T1,
        pipedCursor: undefined,
      }),
    ).toEqual({ cursor: T1, foldedPiped: false });
  });

  it('never moves the cursor backward on a later IPC delivery from the same runner', () => {
    expect(
      cursorAfterDeliveredIpc({
        initialDeliveryConfirmed: true,
        currentCursor: T2,
        targetCursor: T1,
        pipedCursor: undefined,
      }),
    ).toEqual({ cursor: T2, foldedPiped: true });
  });

  // The IPC-path H2 regression: a follow-up piped into a runner that delivers
  // its initial batch via the send-message MCP tool (IPC) and then dies before
  // answering the follow-up via a SECOND IPC send must survive. Modelled as the
  // real advanceCursorAfterDeliveredIpc state machine: the first confirmed IPC
  // delivery advances the cursor but keeps the piped window; post-run
  // reconciliation re-checks it when the runner exits.
  it('regression: a piped follow-up survives when the runner dies after one IPC delivery (H2 on the IPC path)', () => {
    let cursor: string | undefined = T0;
    let pipedCursor: string | undefined = T2; // M2 piped during B1's turn
    let initialDeliveryConfirmed = false;

    // First confirmed IPC delivery answers the initial batch B1.
    const d1 = cursorAfterDeliveredIpc({
      initialDeliveryConfirmed,
      currentCursor: cursor,
      targetCursor: T1,
      pipedCursor,
    });
    cursor = d1.cursor;
    if (d1.foldedPiped) pipedCursor = undefined;
    initialDeliveryConfirmed = true;

    // Initial batch confirmed, but M2 is NOT yet folded into the cursor — this
    // is the whole fix: the OLD code folded T2 into the cursor and deleted the
    // piped window on this first delivery, so the dying runner lost M2.
    expect(cursor).toBe(T1);
    expect(d1.foldedPiped).toBe(false);
    expect(pipedCursor).toBe(T2);

    // Runner dies/idle-closes before its second IPC send. Post-run
    // reconciliation detects the still-unconfirmed piped window and
    // re-dispatches M2 instead of silently losing it.
    expect(hasUnconfirmedPipedMessages(pipedCursor, cursor)).toBe(true);

    // The already-delivered initial batch is NOT re-processed (cursor is past
    // it); only the unanswered follow-up M2 (T2 > cursor) is re-read.
    expect(T1 > (cursor || '')).toBe(false);
    expect(T2 > (cursor || '')).toBe(true);
  });

  it('a healthy multi-turn IPC run folds each follow-up exactly once — no loss, no duplicate', () => {
    let cursor: string | undefined = T0;
    let pipedCursor: string | undefined = T2;
    let initialDeliveryConfirmed = false;

    // Delivery 1: B1 answered → cursor=T1, piped window kept.
    const d1 = cursorAfterDeliveredIpc({
      initialDeliveryConfirmed,
      currentCursor: cursor,
      targetCursor: T1,
      pipedCursor,
    });
    cursor = d1.cursor;
    if (d1.foldedPiped) pipedCursor = undefined;
    initialDeliveryConfirmed = true;
    expect(cursor).toBe(T1);
    expect(pipedCursor).toBe(T2);

    // Delivery 2: M2 answered → cursor=T2, piped window folded & cleared.
    const d2 = cursorAfterDeliveredIpc({
      initialDeliveryConfirmed,
      currentCursor: cursor,
      targetCursor: T1,
      pipedCursor,
    });
    cursor = d2.cursor;
    if (d2.foldedPiped) pipedCursor = undefined;
    expect(d2.foldedPiped).toBe(true);
    expect(cursor).toBe(T2);
    expect(pipedCursor).toBeUndefined();

    // Clean exit: nothing unconfirmed → no fresh re-dispatch (no duplicate).
    expect(hasUnconfirmedPipedMessages(pipedCursor, cursor)).toBe(false);
  });
});

describe('resolveDeliveredIpcTarget', () => {
  const T1 = '2026-06-02T10:00:05.000Z'; // run's batch boundary
  const T2 = '2026-06-02T10:00:09.000Z'; // a later/active boundary

  it('uses the active-run target while the run is live', () => {
    expect(
      resolveDeliveredIpcTarget({
        activeRunTarget: T2,
        survivingTarget: T1,
        pipedCursor: undefined,
      }),
    ).toEqual({ target: T2, skip: false });
  });

  // The residual bug: activeRunTargetTimestamp is deleted in the run's finally
  // (endActiveRun) BEFORE the IPC watcher processes the agent's final
  // send-message envelope. With only the active target the hook saw target='',
  // no piped window, and early-returned — so the cursor never advanced and the
  // just-delivered message was re-read & re-processed next dispatch (duplicate).
  // The surviving target (lastDeliveredIpcTarget) keeps the boundary alive so the
  // late delivery still advances the cursor instead of skipping.
  it('regression: a late delivery after the run ended still resolves the boundary (no skip)', () => {
    const resolved = resolveDeliveredIpcTarget({
      activeRunTarget: undefined, // endActiveRun already deleted it
      survivingTarget: T1, // recorded at run start, survives endActiveRun
      pipedCursor: undefined, // single-batch run, no follow-ups
    });
    // Before the fix this combination produced target='' + skip=true (the
    // early-return that dropped the cursor advance). It must now resolve to the
    // real boundary and NOT skip.
    expect(resolved.skip).toBe(false);
    expect(resolved.target).toBe(T1);
  });

  it('skips only when active, surviving, AND piped are all absent', () => {
    expect(
      resolveDeliveredIpcTarget({
        activeRunTarget: undefined,
        survivingTarget: undefined,
        pipedCursor: undefined,
      }),
    ).toEqual({ target: '', skip: true });
  });

  it('still processes a piped-only window after the run ended (no target, but piped present)', () => {
    expect(
      resolveDeliveredIpcTarget({
        activeRunTarget: undefined,
        survivingTarget: undefined,
        pipedCursor: T2,
      }),
    ).toEqual({ target: '', skip: false });
  });
});

describe('classifyIpcDelivery (cross-run guard, finding #24)', () => {
  const RUN_A_BOUNDARY = '2026-06-02T10:00:05.000Z';
  const LATER = '2026-06-02T10:00:09.000Z';

  it('treats a delivery as current when no prior boundary is pending', () => {
    expect(
      classifyIpcDelivery({
        priorBoundary: undefined,
        currentCursor: RUN_A_BOUNDARY,
      }),
    ).toEqual({ kind: 'current' });
  });

  it('attributes the delivery to the prior run when its boundary is still ahead of the cursor', () => {
    // Run A's late envelope arrives during run B: it must advance only to run A's
    // own boundary, never consuming run B's guard or pushing to run B's target.
    expect(
      classifyIpcDelivery({
        priorBoundary: RUN_A_BOUNDARY,
        currentCursor: '2026-06-02T09:59:00.000Z',
      }),
    ).toEqual({ kind: 'prior-run', boundary: RUN_A_BOUNDARY });
  });

  it('consumes a stale prior boundary already covered by the cursor without re-attributing', () => {
    // Run A's delivery never arrived and the cursor already moved past its
    // boundary: the marker is stale, so drop it and handle as a current delivery.
    expect(
      classifyIpcDelivery({
        priorBoundary: RUN_A_BOUNDARY,
        currentCursor: LATER,
      }),
    ).toEqual({ kind: 'consume-stale' });
    // Exact-equality boundary counts as covered (>=), so it is also stale.
    expect(
      classifyIpcDelivery({
        priorBoundary: RUN_A_BOUNDARY,
        currentCursor: RUN_A_BOUNDARY,
      }),
    ).toEqual({ kind: 'consume-stale' });
  });
});

describe('isBypassTriggerIngestedMessage (finding #25)', () => {
  it('recognizes host-stamped webhook/cron/extension ingestion ids', () => {
    expect(isBypassTriggerIngestedMessage('webhook-1717322481000-abcd')).toBe(
      true,
    );
    expect(isBypassTriggerIngestedMessage('cron-1717322481000-abcd')).toBe(
      true,
    );
    expect(isBypassTriggerIngestedMessage('extension-1717322481000-abcd')).toBe(
      true,
    );
  });

  it('does not treat plain channel (Telegram message) ids as bypass-ingested', () => {
    // Telegram channel messages use the numeric message_id as the id; a guest
    // cannot forge the host-stamped ingestion prefixes.
    expect(isBypassTriggerIngestedMessage('123456')).toBe(false);
    expect(isBypassTriggerIngestedMessage('ipc-123-abc')).toBe(false);
    expect(isBypassTriggerIngestedMessage(undefined)).toBe(false);
    expect(isBypassTriggerIngestedMessage('')).toBe(false);
  });
});

describe('adminFastCommandIsOwnerAuthored (finding #57)', () => {
  function msg(content: string, isOwner: boolean): NewMessage {
    return {
      id: Math.random().toString(36),
      chat_jid: 'tg:100000001',
      sender: '100000001',
      sender_name: 'Co-member',
      content,
      timestamp: '2026-06-09T08:41:21.000Z',
      is_bot_message: false,
      sender_identity: {
        channel: 'telegram',
        chat_id: '100000001',
        telegram_user_id: '100000001',
        identity_id: 'id-1',
        is_owner_sender: isOwner,
        telegram_message_origin: 'direct',
      },
    };
  }

  it('is true when a non-bot human message is from the owner', () => {
    expect(adminFastCommandIsOwnerAuthored([msg('поставь Opus', true)])).toBe(
      true,
    );
  });

  it('is false when only non-owner co-members authored the messages', () => {
    expect(adminFastCommandIsOwnerAuthored([msg('поставь Opus', false)])).toBe(
      false,
    );
  });

  it.each(['forwarded', 'quoted', undefined] as const)(
    'rejects an owner fast command with %s or legacy provenance',
    (origin) => {
      const command = msg('поставь Opus', true);
      command.sender_identity = {
        ...command.sender_identity!,
        telegram_message_origin: origin,
      };
      expect(adminFastCommandIsOwnerAuthored([command])).toBe(false);
    },
  );

  it('does not let an unrelated owner ping authorize a co-member command (#15)', () => {
    expect(
      adminFastCommandIsOwnerAuthored([
        msg('поставь Opus', false),
        msg('что там', true),
      ]),
    ).toBe(false);
  });

  it('keeps an owner command authorized when a co-member only asks for status', () => {
    expect(
      adminFastCommandIsOwnerAuthored([
        msg('поставь Opus', true),
        msg('что там', false),
      ]),
    ).toBe(true);
  });

  it('binds authorization to the latest selected model switch', () => {
    expect(
      adminFastCommandIsOwnerAuthored([
        msg('поставь Opus', true),
        msg('поставь Sonnet', false),
      ]),
    ).toBe(false);
    expect(
      adminFastCommandIsOwnerAuthored([
        msg('поставь Opus', false),
        msg('поставь Sonnet', true),
      ]),
    ).toBe(true);
  });

  it('allows admin-only fast commands from Owner and User B but not random users', () => {
    const ownerAllowlist = parseOwnerAllowlistConfig({
      telegram_user_ids: '100000001,7000000002',
    });
    const adminMsg = (userId: string, name: string): NewMessage => ({
      id: `m-${userId}`,
      chat_jid: `tg:${userId}`,
      sender: userId,
      sender_name: name,
      content: 'поставь Opus',
      timestamp: '2026-07-05T08:41:21.000Z',
      is_bot_message: false,
      sender_identity: {
        ...createTelegramSenderIdentity({
          chatId: userId,
          fromId: userId,
          displayNameHint: name,
          ownerAllowlist,
        }),
        telegram_message_origin: 'direct',
      },
    });

    expect(
      adminFastCommandIsOwnerAuthored([adminMsg('100000001', 'Owner')]),
    ).toBe(true);
    expect(
      adminFastCommandIsOwnerAuthored([adminMsg('7000000002', 'User B')]),
    ).toBe(true);
    expect(adminFastCommandIsOwnerAuthored([adminMsg('555', 'Random')])).toBe(
      false,
    );
    expect(resolveAdminFastCommand([adminMsg('7000000002', 'User B')])).toEqual(
      {
        kind: 'model_switch',
        model: 'claude-opus-4-8',
        label: 'Opus',
      },
    );
  });

  it('ignores empty content and missing identity', () => {
    const blank: NewMessage = {
      id: 'x',
      chat_jid: 'tg:1',
      sender: '1',
      sender_name: 'n',
      content: '   ',
      timestamp: '2026-06-09T08:41:21.000Z',
      is_bot_message: false,
    };
    expect(adminFastCommandIsOwnerAuthored([blank])).toBe(false);
  });
});

describe('direct owner Codex Desktop stop', () => {
  function stopMessage(
    content: string,
    owner = true,
    origin: 'direct' | 'forwarded' | 'quoted' | undefined = 'direct',
  ): NewMessage {
    return {
      id: 'stop-1',
      chat_jid: 'tg:100000001',
      sender: '100000001',
      sender_name: 'Owner',
      content,
      timestamp: '2026-07-18T10:00:00.000Z',
      is_bot_message: false,
      sender_identity: {
        channel: 'telegram',
        chat_id: '100000001',
        telegram_user_id: '100000001',
        identity_id: 'telegram:owner',
        is_owner_sender: owner,
        telegram_message_origin: origin,
      },
    };
  }

  it.each([
    'стоп',
    'Стоп!',
    '/stop',
    'останови задачу',
    'останови текущую задачу Codex',
    'прекрати кодекс',
  ])('recognizes the exact high-priority command: %s', (text) => {
    expect(isCodexDesktopStopCommandText(text)).toBe(true);
  });

  it.each(['не останавливай', 'стоп, а потом продолжи', 'расскажи про stop'])(
    'does not treat ordinary text as a stop command: %s',
    (text) => {
      expect(isCodexDesktopStopCommandText(text)).toBe(false);
    },
  );

  it('binds stop authority to the latest exact direct owner command', () => {
    expect(
      directOwnerCodexDesktopStopMessage([
        stopMessage('продолжай работу'),
        stopMessage('стоп'),
      ]),
    ).toMatchObject({ id: 'stop-1' });
    expect(
      directOwnerCodexDesktopStopMessage([
        stopMessage('стоп'),
        { ...stopMessage('что происходит?'), id: 'later-message' },
      ]),
    ).toMatchObject({ content: 'стоп' });
    expect(
      directOwnerCodexDesktopStopMessage([stopMessage('стоп', false)]),
    ).toBeNull();
    expect(
      directOwnerCodexDesktopStopMessage([
        stopMessage('стоп', true, 'forwarded'),
      ]),
    ).toBeNull();
  });

  it('calls only the loopback helper and does not expose response details on failure', async () => {
    const revokedCodexControlRunId = '00000000-0000-4000-8000-000000000003';
    let requestUrl = '';
    let requestHeaders: Record<string, string> | undefined;
    const success = await interruptCodexDesktopFromHost({
      chatJid: 'tg:100000001',
      helperSecret: 'test-helper-secret',
      helperPort: '4321',
      revokedCodexControlRunId,
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestHeaders = init?.headers as Record<string, string> | undefined;
        return new Response(JSON.stringify({ ok: true, confirmed: true }), {
          status: 200,
        });
      },
    });
    expect(requestUrl).toBe('http://127.0.0.1:4321/codex_desktop/interrupt');
    expect(requestHeaders).toMatchObject({
      'X-Helper-Secret': 'test-helper-secret',
      'X-Skoobi-Chat-Jid': 'tg:100000001',
      'X-Skoobi-Revoke-Codex-Control-Run-Id': revokedCodexControlRunId,
    });
    expect(success).toMatchObject({
      ok: true,
      result: { confirmed: true },
    });

    const rejected = await interruptCodexDesktopFromHost({
      chatJid: 'tg:100000001',
      helperSecret: 'test-helper-secret',
      fetchImpl: async () =>
        new Response('SENSITIVE_PROMPT_OR_RESULT', { status: 500 }),
    });
    expect(rejected).toEqual({
      ok: false,
      error: 'helper_rejected_stop',
      status: 500,
    });
    expect(JSON.stringify(rejected)).not.toContain('SENSITIVE');

    await expect(
      interruptCodexDesktopFromHost({
        chatJid: 'tg:100000001',
        helperSecret: 'test-helper-secret',
        helperPort: '3200@external.invalid',
        fetchImpl: async () => {
          throw new Error('must not make a request');
        },
      }),
    ).resolves.toEqual({ ok: false, error: 'invalid_helper_port' });

    let invalidFetchCalled = false;
    await expect(
      interruptCodexDesktopFromHost({
        chatJid: 'tg:100000001',
        helperSecret: 'test-helper-secret',
        revokedCodexControlRunId: 'not-a-uuid',
        fetchImpl: async () => {
          invalidFetchCalled = true;
          throw new Error('must not make a request');
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid_codex_control_run_id',
    });
    expect(invalidFetchCalled).toBe(false);
  });

  it('never claims success for an unmanaged or unregistered task', () => {
    expect(
      codexDesktopStopReplyText({
        ok: true,
        result: { confirmed: false, unmanagedActive: true },
      }),
    ).toMatch(/не подтверждаю/u);
    expect(
      codexDesktopStopReplyText({
        ok: true,
        result: { confirmed: false, noManagedTask: true },
      }),
    ).toMatch(/не найдено.*не подтверждаю/u);
    expect(
      codexDesktopStopReplyText({
        ok: true,
        result: { confirmed: true, alreadyStopped: true },
      }),
    ).toMatch(/задачи Codex нет.*уже завершена/u);
    expect(
      codexDesktopStopReplyText({
        ok: true,
        result: { confirmed: true },
      }),
    ).toMatch(/Остановка подтверждена/u);
  });
});

describe('read-only Codex Desktop status', () => {
  const completedTask = {
    status: 'completed' as const,
    startedAt: '2026-07-24T09:14:08.000Z',
    updatedAt: '2026-07-24T09:33:50.000Z',
    completedAt: '2026-07-24T09:33:50.000Z',
  };

  it('extracts only managed status and timestamps from the helper response', async () => {
    let requestUrl = '';
    let requestHeaders: Record<string, string> | undefined;
    const result = await readCodexDesktopStatusFromHost({
      chatJid: 'tg:100000001',
      helperSecret: 'test-helper-secret',
      helperPort: '4321',
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestHeaders = init?.headers as Record<string, string> | undefined;
        return new Response(
          JSON.stringify({
            appServer: { running: true },
            stateError: null,
            authorizedRoots: ['/PRIVATE/ROOT'],
            task: {
              ...completedTask,
              taskTitle: 'PRIVATE TASK TITLE',
              cwd: '/PRIVATE/CWD',
              taskId: 'private-task-id',
              threadId: 'private-thread-id',
              turnId: 'private-turn-id',
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(requestUrl).toBe('http://127.0.0.1:4321/codex_desktop/status');
    expect(requestHeaders).toMatchObject({
      'X-Helper-Secret': 'test-helper-secret',
      'X-Skoobi-Chat-Jid': 'tg:100000001',
    });
    expect(result).toEqual({ ok: true, task: completedTask });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('rejects malformed or unsafe helper state without echoing it', async () => {
    const invalidStatus = await readCodexDesktopStatusFromHost({
      chatJid: 'tg:100000001',
      helperSecret: 'test-helper-secret',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            task: {
              ...completedTask,
              status: 'ownerSecretState',
              taskTitle: 'SENSITIVE',
            },
          }),
          { status: 200 },
        ),
    });
    expect(invalidStatus).toEqual({
      ok: false,
      error: 'invalid_helper_response',
    });
    expect(JSON.stringify(invalidStatus)).not.toContain('SENSITIVE');

    const stateError = await readCodexDesktopStatusFromHost({
      chatJid: 'tg:100000001',
      helperSecret: 'test-helper-secret',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            stateError: '/PRIVATE/state-file: parse failed',
            task: null,
          }),
          { status: 200 },
        ),
    });
    expect(stateError).toEqual({
      ok: false,
      error: 'helper_state_unavailable',
    });
  });

  it('distinguishes a lost Telegram controller from saved Desktop work', () => {
    const active = codexOnlyFailureReplyText({
      codexGuiControlAuthorized: true,
      codexDesktopTask: { ...completedTask, status: 'inProgress' },
    });
    expect(active).toContain('Telegram-сеанс управления завершился');
    expect(active).toContain('Codex Desktop сейчас выполняется');
    expect(active).not.toContain('Codex не смог');

    const completed = codexOnlyFailureReplyText({
      codexGuiControlAuthorized: true,
      codexDesktopTask: completedTask,
    });
    expect(completed).toContain('задача Codex Desktop уже завершена');
    expect(completed).not.toContain('Codex не смог');

    expect(
      codexOnlyFailureReplyText({
        codexGuiControlAuthorized: false,
        codexDesktopTask: completedTask,
      }),
    ).toContain('Codex не смог');
    expect(codexDesktopManagedTaskStatusText(completedTask)).toContain(
      'завершена',
    );
  });

  it('reconciles only a current run that actually called Desktop control', () => {
    const runStartedAt = Date.parse('2026-07-24T09:14:00.000Z');
    expect(
      codexDesktopTaskBelongsToRunWindow(completedTask, runStartedAt),
    ).toBe(true);
    expect(
      shouldReconcileCodexDesktopFailure({
        eligible: true,
        runStatus: 'error',
        outputSentToUser: false,
        sideEffectTools: ['codex_desktop_control'],
        task: completedTask,
        runStartedAt,
      }),
    ).toBe(true);
    expect(
      shouldReconcileCodexDesktopFailure({
        eligible: true,
        runStatus: 'error',
        outputSentToUser: false,
        sideEffectTools: ['google_sheets_append_values'],
        task: completedTask,
        runStartedAt,
      }),
    ).toBe(false);
    expect(
      shouldReconcileCodexDesktopFailure({
        eligible: false,
        runStatus: 'error',
        outputSentToUser: false,
        sideEffectTools: ['codex_desktop_control'],
        task: completedTask,
        runStartedAt,
      }),
    ).toBe(false);
    expect(
      codexOnlyFailureReplyText({
        codexGuiControlAuthorized: false,
        codexDesktopControlObserved: true,
        runStartedAt,
        codexDesktopTask: completedTask,
      }),
    ).toContain('задача Codex Desktop уже завершена');
  });
});

describe('direct owner Codex GUI authorization', () => {
  const guiMessage = (
    content: string,
    owner = true,
    origin: 'direct' | 'forwarded' | 'quoted' | undefined = 'direct',
  ): NewMessage => ({
    id: 'gui-1',
    chat_jid: 'tg:100000001',
    sender: '100000001',
    sender_name: 'Owner',
    content,
    timestamp: '2026-07-18T10:00:00.000Z',
    is_bot_message: false,
    sender_identity: {
      channel: 'telegram',
      chat_id: '100000001',
      telegram_user_id: '100000001',
      identity_id: 'telegram:owner',
      is_owner_sender: owner,
      telegram_message_origin: origin,
    },
  });

  it('requires the exact /codex-gui command prefix', () => {
    expect(
      isExplicitCodexGuiControlCommandText(
        '/codex-gui открой Codex и проверь этот чат',
      ),
    ).toBe(true);
    expect(
      isExplicitCodexGuiControlCommandText(
        '/codex_gui открой Codex и проверь этот чат',
      ),
    ).toBe(true);
    expect(isExplicitCodexGuiControlCommandText('/codex-gui')).toBe(true);
    expect(isExplicitCodexGuiControlCommandText('/codex_gui')).toBe(true);
    expect(
      isExplicitCodexGuiControlCommandText('открой Codex и проверь чат'),
    ).toBe(false);
    expect(
      isExplicitCodexGuiControlCommandText('расскажи про /codex-gui'),
    ).toBe(false);
  });

  it('accepts authorization only from the concrete direct owner message', () => {
    expect(
      directOwnerCodexGuiControlMessage([
        guiMessage('/codex-gui проверь окно'),
      ]),
    ).toMatchObject({ id: 'gui-1' });
    expect(
      directOwnerCodexGuiControlMessage([
        guiMessage('/codex-gui проверь окно', false),
      ]),
    ).toBeNull();
    expect(
      directOwnerCodexGuiControlMessage([
        guiMessage('/codex-gui проверь окно', true, 'forwarded'),
      ]),
    ).toBeNull();
    expect(
      directOwnerCodexGuiControlMessage([guiMessage('обычная задача Codex')]),
    ).toBeNull();
  });
});

describe('shouldUseSharedOwnerProviderCircuit (#20)', () => {
  const message = (isOwner: boolean): NewMessage => ({
    id: isOwner ? 'owner' : 'guest',
    chat_jid: 'tg:-100123',
    sender: isOwner ? '100000001' : '999',
    sender_name: isOwner ? 'Owner' : 'Guest',
    content: 'ответь',
    timestamp: '2026-07-11T10:00:00.000Z',
    is_bot_message: false,
    sender_identity: {
      channel: 'telegram',
      chat_id: '-100123',
      telegram_user_id: isOwner ? '100000001' : '999',
      identity_id: isOwner ? 'telegram:owner' : 'telegram:guest',
      is_owner_sender: isOwner,
      telegram_message_origin: 'direct',
    },
  });

  it('keeps guest failures and probes out of the shared owner breaker', () => {
    expect(
      shouldUseSharedOwnerProviderCircuit({
        tenantMode: 'guest',
        groupIsMain: false,
        chatJid: 'tg:999',
        messages: [message(false)],
      }),
    ).toBe(false);
    expect(
      shouldUseSharedOwnerProviderCircuit({
        tenantMode: 'owner',
        groupIsMain: true,
        chatJid: 'tg:-100123',
        messages: [message(true), message(false)],
      }),
    ).toBe(false);
    expect(
      shouldUseSharedOwnerProviderCircuit({
        tenantMode: 'owner',
        groupIsMain: true,
        chatJid: 'tg:bot=123456:-100123',
        messages: [message(true), message(false)],
      }),
    ).toBe(false);
  });

  it('preserves owner DM and owner-only main-group breaker behavior', () => {
    expect(
      shouldUseSharedOwnerProviderCircuit({
        tenantMode: 'owner',
        groupIsMain: true,
        chatJid: 'tg:100000001',
        messages: [message(true)],
      }),
    ).toBe(true);
    expect(
      shouldUseSharedOwnerProviderCircuit({
        tenantMode: 'owner',
        groupIsMain: true,
        chatJid: 'tg:-100123',
        messages: [message(true)],
      }),
    ).toBe(true);
  });

  it('allows the shared owner route only for fromMe messages in a WhatsApp self-chat', () => {
    expect(
      shouldUseSharedOwnerProviderCircuit({
        tenantMode: 'owner',
        groupIsMain: true,
        chatJid: '15551234567@s.whatsapp.net',
        messages: [
          {
            id: 'wa-owner',
            chat_jid: '15551234567@s.whatsapp.net',
            sender: '15551234567',
            sender_name: 'Owner',
            content: 'hello',
            timestamp: '2026-07-11T10:00:00.000Z',
            is_from_me: true,
          },
        ],
      }),
    ).toBe(true);

    expect(
      shouldUseSharedOwnerProviderCircuit({
        tenantMode: 'owner',
        groupIsMain: true,
        chatJid: '15551234567@s.whatsapp.net',
        messages: [
          {
            id: 'wa-contact',
            chat_jid: '15551234567@s.whatsapp.net',
            sender: '15550000000',
            sender_name: 'Contact',
            content: 'hello',
            timestamp: '2026-07-11T10:00:00.000Z',
            is_from_me: false,
          },
        ],
      }),
    ).toBe(false);
  });

  it.each(['forwarded', 'quoted', undefined] as const)(
    'keeps %s or legacy owner messages out of the shared owner route',
    (origin) => {
      const untrusted = message(true);
      untrusted.sender_identity = {
        ...untrusted.sender_identity!,
        telegram_message_origin: origin,
      };
      expect(
        shouldUseSharedOwnerProviderCircuit({
          tenantMode: 'owner',
          groupIsMain: true,
          chatJid: 'tg:100000001',
          messages: [untrusted],
        }),
      ).toBe(false);
    },
  );
});

describe('cursorAfterPreSendError', () => {
  const PREVIOUS = '2026-06-02T10:00:05.000Z';

  it('keeps previousCursor when nothing advanced during the run', () => {
    expect(cursorAfterPreSendError(PREVIOUS, PREVIOUS)).toBe(PREVIOUS);
  });

  it('preserves a concurrent quota-block advance instead of rolling it back (M1)', () => {
    // maybeBlockTelegramQuota advanced the cursor forward mid-run; a pre-send
    // error must NOT move it backward (monotonicity invariant).
    const advanced = '2026-06-02T10:00:09.000Z';
    expect(cursorAfterPreSendError(advanced, PREVIOUS)).toBe(advanced);
  });

  it('restores previousCursor if the cursor somehow regressed below it', () => {
    expect(cursorAfterPreSendError('2026-06-02T09:59:00.000Z', PREVIOUS)).toBe(
      PREVIOUS,
    );
  });

  it('treats an empty/undefined cursor as a regression and restores previousCursor', () => {
    expect(cursorAfterPreSendError(undefined, PREVIOUS)).toBe(PREVIOUS);
    expect(cursorAfterPreSendError('', PREVIOUS)).toBe(PREVIOUS);
  });
});

describe('channelJidFromEnvelopeJid', () => {
  it('returns a plain channel JID unchanged', () => {
    expect(channelJidFromEnvelopeJid('tg:100200300')).toBe('tg:100200300');
  });

  it('maps a thread JID back to its owning channel JID (L3)', () => {
    expect(channelJidFromEnvelopeJid('tg:100200300:42')).toBe('tg:100200300');
  });

  it('keeps a negative (group) channel id and strips only the thread segment', () => {
    expect(channelJidFromEnvelopeJid('tg:-1001234567:9981')).toBe(
      'tg:-1001234567',
    );
  });

  it('preserves bot-prefixed channels and strips only a real thread suffix', () => {
    expect(channelJidFromEnvelopeJid('tg:skoobi_friend:100200300')).toBe(
      'tg:skoobi_friend:100200300',
    );
    expect(channelJidFromEnvelopeJid('tg:skoobi_friend:100200300:42')).toBe(
      'tg:skoobi_friend:100200300',
    );
    expect(channelJidFromEnvelopeJid('tg:bot=9000000001:100200300')).toBe(
      'tg:bot=9000000001:100200300',
    );
    expect(channelJidFromEnvelopeJid('tg:bot=9000000001:100200300:42')).toBe(
      'tg:bot=9000000001:100200300',
    );
  });

  it('returns a colon-less JID unchanged', () => {
    expect(channelJidFromEnvelopeJid('local')).toBe('local');
  });
});

describe('resolvePlanPurchaseTenantId', () => {
  it('prefers the explicit input tenant id', () => {
    expect(resolvePlanPurchaseTenantId('tenant_a', 'tenant_b')).toBe(
      'tenant_a',
    );
  });

  it('falls back to the resolved tenant id', () => {
    expect(resolvePlanPurchaseTenantId(undefined, 'tenant_b')).toBe('tenant_b');
  });

  it('returns undefined when neither resolves so the caller refuses the purchase (M2)', () => {
    expect(resolvePlanPurchaseTenantId(undefined, undefined)).toBeUndefined();
  });
});

describe('telegramInboundEventPayload', () => {
  it('records append-only Telegram events only for Telegram JIDs', () => {
    expect(shouldRecordTelegramInboundEvent('tg:100200300')).toBe(true);
    expect(shouldRecordTelegramInboundEvent('123@s.whatsapp.net')).toBe(false);
    expect(shouldRecordTelegramInboundEvent('123@g.us')).toBe(false);
  });

  it('preserves Telegram update_id in the append-only event payload when available', () => {
    expect(
      telegramInboundEventPayload('tg:100200300', {
        id: '42',
        chat_jid: 'tg:100200300',
        sender: '99001',
        sender_name: 'Alice',
        content: 'hello',
        timestamp: '2026-05-16T01:00:00.000Z',
        is_from_me: false,
        telegram_update_id: '777888',
        sender_identity: {
          channel: 'telegram',
          chat_id: '100200300',
          telegram_user_id: '99001',
          identity_id: 'telegram_user_99001',
          bot_id: 'skoobi_friend_bot',
          persona_id: 'friend',
          is_owner_sender: false,
          telegram_message_origin: 'direct',
        },
      }),
    ).toMatchObject({
      message_id: '42',
      update_id: '777888',
      chat_jid: 'tg:100200300',
      sender_id: '99001',
      identity_id: 'telegram_user_99001',
      bot_id: 'skoobi_friend_bot',
      persona_id: 'friend',
      telegram_message_origin: 'direct',
    });
  });
});

describe('loadLegacyDefaultTelegramUserMemoryContext', () => {
  function group(folder: string): RegisteredGroup {
    return {
      name: folder,
      folder,
      trigger: '@Skoobi',
      added_at: '2026-05-22T00:00:00.000Z',
      requiresTrigger: false,
    };
  }

  it('loads legacy default-bot private memory for the same Telegram user in a persona bot', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-legacy-memory-'),
    );
    try {
      fs.mkdirSync(path.join(root, 'telegram_main', 'memory'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(root, 'telegram_main', 'memory', 'profile.md'),
        'User likes concise technical answers.',
      );

      const context = loadLegacyDefaultTelegramUserMemoryContext(
        'tg:skoobi_friend:100000001',
        '100000001',
        {
          'tg:100000001': group('telegram_main'),
          'tg:skoobi_friend:100000001': group('guest_example'),
        },
        root,
      );

      expect(context).toContain('<legacy_same_user_memory_context>');
      expect(context).toContain('legacy default Skoobi bot');
      expect(context).toContain('User likes concise technical answers.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not inject private legacy memory into a group chat', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-legacy-memory-'),
    );
    try {
      fs.mkdirSync(path.join(root, 'telegram_main', 'memory'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(root, 'telegram_main', 'memory', 'profile.md'),
        'Private user memory.',
      );

      const context = loadLegacyDefaultTelegramUserMemoryContext(
        'tg:skoobi_friend:-100123',
        '100000001',
        {
          'tg:100000001': group('telegram_main'),
          'tg:skoobi_friend:-100123': group('telegram_group'),
        },
        root,
      );

      expect(context).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildPromptMemoryContexts', () => {
  function group(folder: string, isMain = false): RegisteredGroup {
    return {
      name: folder,
      folder,
      trigger: '@Skoobi',
      added_at: '2026-05-22T00:00:00.000Z',
      requiresTrigger: false,
      isMain,
    };
  }

  function tenant(input: {
    folder: string;
    chatId: string;
    mode: 'guest' | 'owner';
    group: RegisteredGroup;
  }): TenantRecord {
    return {
      tenant_id: `tg_chat_${input.chatId}`,
      folder: input.folder,
      channel: 'telegram',
      chat_id: input.chatId,
      bot_id: 'telegram_default',
      persona_id: 'default',
      mode: input.mode,
      runtime: 'claude_sdk',
      approved_senders: [],
      models: {},
      quota: { enabled: true },
      legacy_jid: `tg:${input.chatId}`,
      source: 'legacy_registered_group',
      group: input.group,
    };
  }

  it('injects current owner/main memory so Codex reserve keeps Claude SDK continuity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-admin-memory-'));
    const dataRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-admin-data-'),
    );
    try {
      fs.mkdirSync(path.join(root, 'telegram_main', 'memory', 'topics'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(root, 'telegram_main', 'memory', 'topics', 'admin.md'),
        'Админ предпочитает, чтобы Скуби отвечал по делу и помнил локальный rollout.',
      );

      const mainGroup = group('telegram_main', true);
      const contexts = buildPromptMemoryContexts({
        chatJid: 'tg:100000001',
        senderId: '100000001',
        senderIdentity: {
          channel: 'telegram',
          chat_id: '100000001',
          telegram_user_id: '100000001',
          identity_id: 'telegram_user_100000001',
          is_owner_sender: true,
          telegram_message_origin: 'direct',
        },
        tenant: tenant({
          folder: 'telegram_main',
          chatId: '100000001',
          mode: 'owner',
          group: mainGroup,
        }),
        group: mainGroup,
        groups: { 'tg:100000001': mainGroup },
        groupsDir: root,
        dataDir: dataRoot,
      });

      const joined = contexts.join('\n\n');
      expect(joined).toContain('<chat_memory_context>');
      expect(joined).toContain('Админ предпочитает');
      expect(joined).toContain('same chat only');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('injects only a memory index when agentConfig.lazyMemory is enabled', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-lazy-memory-'));
    const dataRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-lazy-data-'),
    );
    try {
      fs.mkdirSync(path.join(root, 'telegram_main', 'memory', 'topics'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(root, 'telegram_main', 'memory', 'topics', 'heavy.md'),
        'Secretly very long admin memory body that should not be injected.',
      );

      const mainGroup = {
        ...group('telegram_main', true),
        agentConfig: { lazyMemory: true },
      };
      const contexts = buildPromptMemoryContexts({
        chatJid: 'tg:100000001',
        senderId: '100000001',
        senderIdentity: {
          channel: 'telegram',
          chat_id: '100000001',
          telegram_user_id: '100000001',
          identity_id: 'telegram_user_100000001',
          is_owner_sender: true,
          telegram_message_origin: 'direct',
        },
        tenant: tenant({
          folder: 'telegram_main',
          chatId: '100000001',
          mode: 'owner',
          group: mainGroup,
        }),
        group: mainGroup,
        groups: { 'tg:100000001': mainGroup },
        groupsDir: root,
        dataDir: dataRoot,
      });

      const joined = contexts.join('\n\n');
      expect(joined).toContain('<chat_memory_index>');
      expect(joined).toContain('memory/topics/heavy.md');
      expect(joined).not.toContain('Secretly very long admin memory body');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('reads bounded same-owner memory from an explicit companion source folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-wa-memory-'));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-wa-data-'));
    try {
      fs.mkdirSync(path.join(root, 'telegram_main', 'memory'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(root, 'telegram_main', 'memory', 'owner.md'),
        'Главный Скуби помнит предпочтения владельца.',
      );
      const whatsappGroup: RegisteredGroup = {
        ...group('whatsapp_main', true),
        runtime: 'sandbox',
        agentConfig: {
          memoryContextFolder: 'telegram_main',
          lazyMemory: false,
          disallowedTools: ['*'],
        },
      };

      const contexts = buildPromptMemoryContexts({
        chatJid: '77009999999@s.whatsapp.net',
        senderId: '77009999999@s.whatsapp.net',
        group: whatsappGroup,
        groups: { '77009999999@s.whatsapp.net': whatsappGroup },
        groupsDir: root,
        dataDir: dataRoot,
      });

      expect(contexts.join('\n')).toContain(
        'Главный Скуби помнит предпочтения владельца.',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('does not inject owner/main memory into a guest Codex context', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-guest-memory-'));
    const dataRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-guest-data-'),
    );
    try {
      fs.mkdirSync(path.join(root, 'telegram_main', 'memory', 'topics'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(root, 'telegram_main', 'memory', 'topics', 'admin.md'),
        'Owner-only rollout secret context.',
      );
      fs.mkdirSync(path.join(root, 'telegram_guest', 'memory', 'topics'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(root, 'telegram_guest', 'memory', 'topics', 'guest.md'),
        'Guest likes short practical answers.',
      );

      const ownerGroup = group('telegram_main', true);
      const guestGroup = group('telegram_guest');
      const contexts = buildPromptMemoryContexts({
        chatJid: 'tg:555',
        senderId: '555',
        senderIdentity: {
          channel: 'telegram',
          chat_id: '555',
          telegram_user_id: '555',
          identity_id: 'telegram_user_555',
          is_owner_sender: false,
          telegram_message_origin: 'direct',
        },
        tenant: tenant({
          folder: 'telegram_guest',
          chatId: '555',
          mode: 'guest',
          group: guestGroup,
        }),
        group: guestGroup,
        groups: {
          'tg:100000001': ownerGroup,
          'tg:555': guestGroup,
        },
        groupsDir: root,
        dataDir: dataRoot,
      });

      const joined = contexts.join('\n\n');
      expect(joined).toContain('Guest likes short practical answers.');
      expect(joined).not.toContain('Owner-only rollout secret context.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

describe('buildPromptSkillContexts', () => {
  it('injects only selected Hermes-style procedural skills', () => {
    const skillsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-ml-skills-'),
    );
    try {
      fs.mkdirSync(path.join(skillsDir, 'web-search-workflow'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(skillsDir, 'web-search-workflow', 'SKILL.md'),
        [
          '---',
          'name: web-search-workflow',
          'description: Use search for current facts.',
          'status: active',
          'created_by: operator',
          'triggers: ["найди"]',
          '---',
          '',
          'Use SearchGateway.',
        ].join('\n'),
      );
      fs.mkdirSync(path.join(skillsDir, 'voice-response'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(skillsDir, 'voice-response', 'SKILL.md'),
        [
          '---',
          'name: voice-response',
          'description: Use voice.',
          'status: active',
          'created_by: operator',
          'triggers: ["голосом"]',
          '---',
          '',
          'Use TTS.',
        ].join('\n'),
      );

      const result = buildPromptSkillContexts({
        text: 'найди контакты компании',
        chatJid: 'tg:100000001',
        group: {
          name: 'telegram_main',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-06-09T00:00:00.000Z',
          requiresTrigger: false,
          isMain: true,
        },
        skillsDir,
      });

      const joined = result.contexts.join('\n');
      expect(result.selected).toEqual(['web-search-workflow']);
      expect(joined).toContain('<skoobi_skills>');
      expect(joined).toContain('Use SearchGateway.');
      expect(joined).not.toContain('Use TTS.');
    } finally {
      fs.rmSync(skillsDir, { recursive: true, force: true });
    }
  });
});

describe('prependTenantLongTermPromptContext', () => {
  it('adds same-tenant CLAUDE.md memory for live/shadow model prompts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-live-memory-'));
    try {
      fs.mkdirSync(path.join(root, 'guest_example'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'guest_example', 'CLAUDE.md'),
        '- Контакт пользователя — Example A.\n- Коллега пользователя — Example B.\n',
      );

      const prompt = prependTenantLongTermPromptContext(
        '<messages>как зовут моего сына</messages>',
        'guest_example',
        root,
      );

      expect(prompt).toContain('<tenant_long_term_context source="CLAUDE.md">');
      expect(prompt).toContain('Контакт пользователя — Example A');
      expect(prompt).toContain('Коллега пользователя — Example B');
      expect(prompt).toContain('<messages>как зовут моего сына</messages>');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not load long-term memory through an unsafe group folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-live-memory-'));
    try {
      fs.mkdirSync(path.join(root, 'guest_example'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'guest_example', 'CLAUDE.md'),
        'Private memory',
      );

      expect(
        prependTenantLongTermPromptContext('hello', '../guest_example', root),
      ).toBe('hello');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('strips only the host-generated leading block for an isolated guest run', () => {
    const wrapped = [
      '<tenant_long_term_context source="CLAUDE.md">',
      'OWNER_ONLY',
      '</tenant_long_term_context>',
      '',
      '<messages>guest prompt</messages>',
    ].join('\n');
    expect(stripTenantLongTermPromptContext(wrapped)).toBe(
      '<messages>guest prompt</messages>',
    );
    expect(stripTenantLongTermPromptContext('plain prompt')).toBe(
      'plain prompt',
    );
  });
});

describe('thread CLAUDE.md inheritance host-read safety', () => {
  it('copies an ordinary bounded regular parent file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-inherit-'));
    try {
      const source = path.join(root, 'parent-CLAUDE.md');
      const targetDir = path.join(root, 'thread');
      const target = path.join(targetDir, 'CLAUDE.md');
      fs.mkdirSync(targetDir);
      fs.writeFileSync(source, 'legitimate parent instructions');
      expect(inheritThreadClaudeInstructions(source, target)).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe(
        'legitimate parent instructions',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects symlink, hardlink, oversized source, and a pre-existing target symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-inherit-'));
    try {
      const outside = path.join(root, 'outside-secret');
      const targetDir = path.join(root, 'thread');
      fs.mkdirSync(targetDir);
      fs.writeFileSync(outside, 'HOST_SECRET');

      const symlinkSource = path.join(root, 'symlink-CLAUDE.md');
      fs.symlinkSync(outside, symlinkSource);
      expect(
        inheritThreadClaudeInstructions(
          symlinkSource,
          path.join(targetDir, 'symlink-target.md'),
        ),
      ).toBe(false);

      const hardlinkSource = path.join(root, 'hardlink-CLAUDE.md');
      fs.linkSync(outside, hardlinkSource);
      expect(
        inheritThreadClaudeInstructions(
          hardlinkSource,
          path.join(targetDir, 'hardlink-target.md'),
        ),
      ).toBe(false);

      const hugeSource = path.join(root, 'huge-CLAUDE.md');
      fs.writeFileSync(hugeSource, Buffer.alloc(256 * 1024 + 1, 0x61));
      expect(
        inheritThreadClaudeInstructions(
          hugeSource,
          path.join(targetDir, 'huge-target.md'),
        ),
      ).toBe(false);

      const safeSource = path.join(root, 'safe-CLAUDE.md');
      const poisonedTarget = path.join(targetDir, 'CLAUDE.md');
      fs.writeFileSync(safeSource, 'SAFE');
      fs.symlinkSync(outside, poisonedTarget);
      expect(inheritThreadClaudeInstructions(safeSource, poisonedTarget)).toBe(
        false,
      );
      expect(fs.readFileSync(outside, 'utf8')).toBe('HOST_SECRET');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('isMultiSenderChat (finding #23: protect curated memory across senders)', () => {
  it('treats a Telegram group/supergroup (tg:-100…) as multi-sender', () => {
    expect(isMultiSenderChat('tg:-1001234567890')).toBe(true);
  });

  it('detects groups behind symbolic and numeric bot-id prefixes', () => {
    expect(isMultiSenderChat('tg:skoobi_friend:-1001234567890')).toBe(true);
    expect(isMultiSenderChat('tg:bot=9000000001:-1001234567890')).toBe(true);
    expect(isMultiSenderChat('tg:bot=9000000001:100000001')).toBe(false);
  });

  it('treats a WhatsApp group (…@g.us) as multi-sender', () => {
    expect(isMultiSenderChat('120363012345678901@g.us')).toBe(true);
  });

  it('treats a Discord channel (dc:…) as multi-sender', () => {
    expect(isMultiSenderChat('dc:9876543210')).toBe(true);
  });

  it('treats a Telegram 1:1 DM (positive id) as single-sender', () => {
    expect(isMultiSenderChat('tg:100000001')).toBe(false);
  });

  it('treats a WhatsApp 1:1 DM (…@s.whatsapp.net) as single-sender', () => {
    expect(isMultiSenderChat('77001234567@s.whatsapp.net')).toBe(false);
  });

  it('defaults unknown shapes to single-sender (keep curated memory)', () => {
    expect(isMultiSenderChat('some-unknown-jid')).toBe(false);
    expect(isMultiSenderChat('')).toBe(false);
  });

  it('does not throw and returns false for non-string input', () => {
    expect(isMultiSenderChat(undefined as unknown as string)).toBe(false);
    expect(isMultiSenderChat(null as unknown as string)).toBe(false);
    expect(isMultiSenderChat(12345 as unknown as string)).toBe(false);
  });
});

describe('multi-sender active memory identity binding', () => {
  function message(id: string, senderId: string): NewMessage {
    return {
      id,
      chat_jid: 'tg:-100123',
      sender: senderId,
      sender_name: `user-${senderId}`,
      content: `message from ${senderId}`,
      timestamp: `2026-07-11T12:00:0${id}.000Z`,
      sender_identity: {
        channel: 'telegram',
        chat_id: '-100123',
        telegram_user_id: senderId,
        identity_id: `telegram_user_${senderId}`,
        is_owner_sender: false,
        telegram_message_origin: 'direct',
      },
    };
  }

  it('keeps normal piping for follow-ups from the same authoritative sender', () => {
    const active = memoryRunIdentityForBinding(
      'tg:-100123',
      message('1', '111').sender_identity,
      true,
    );
    expect(active).toEqual({
      senderId: '111',
      identityId: 'telegram_user_111',
    });
    expect(
      messagesMatchMemoryRunIdentity(
        [message('1', '111'), message('2', '111')],
        active,
      ),
    ).toBe(true);
  });

  it('refuses piping when a different member follows the active sender', () => {
    const active = {
      senderId: '111',
      identityId: 'telegram_user_111',
    };
    expect(messagesMatchMemoryRunIdentity([message('1', '222')], active)).toBe(
      false,
    );
  });

  it('marks an initial A+B batch non-homogeneous so memory_save fails closed', () => {
    expect(
      homogeneousMemoryRunIdentity([message('1', '111'), message('2', '222')]),
    ).toBeNull();
    expect(
      memoryPromptSenderIdentityForMessages([
        message('1', '111'),
        message('2', '222'),
      ]),
    ).toBeUndefined();
    expect(
      shouldIssueMemoryProvenanceGrant({
        isMain: false,
        chatJid: 'tg:-100123',
        memoryWriteAllowed: false,
      }),
    ).toBe(false);
  });

  it('keeps personal memory reads for a homogeneous same-sender batch', () => {
    expect(
      memoryPromptSenderIdentityForMessages([
        message('1', '111'),
        message('2', '111'),
      ]),
    ).toMatchObject({
      telegram_user_id: '111',
      identity_id: 'telegram_user_111',
    });
    expect(
      shouldIssueMemoryProvenanceGrant({
        isMain: false,
        chatJid: 'tg:-100123',
        memoryWriteAllowed: true,
      }),
    ).toBe(true);
  });

  it('preserves non-Telegram private memory while keeping groups closed', () => {
    const whatsappMessage: NewMessage = {
      id: 'wa-1',
      chat_jid: '15551234567@s.whatsapp.net',
      sender: '15551234567',
      sender_name: 'Owner',
      content: 'remember this',
      timestamp: '2026-07-11T12:00:00.000Z',
    };
    expect(
      memoryWriteAllowedForMessages(
        whatsappMessage.chat_jid,
        [whatsappMessage],
        undefined,
      ),
    ).toBe(true);
    expect(
      memoryWriteAllowedForMessages(
        'family@g.us',
        [{ ...whatsappMessage, chat_jid: 'family@g.us' }],
        undefined,
      ),
    ).toBe(false);
  });

  it.each(['forwarded', 'quoted', undefined] as const)(
    'does not issue memory identity for %s or legacy provenance',
    (origin) => {
      const untrusted = message('1', '111');
      untrusted.sender_identity = {
        ...untrusted.sender_identity!,
        telegram_message_origin: origin,
      };
      expect(homogeneousMemoryRunIdentity([untrusted])).toBeNull();
      expect(
        memoryPromptSenderIdentityForMessages([untrusted]),
      ).toBeUndefined();
      expect(
        shouldRotateActiveRunForMessages(true, [untrusted], {
          senderId: '111',
          identityId: 'telegram_user_111',
        }),
      ).toBe(true);
      expect(
        memoryProvenanceGrantPolicy({
          groupIsMain: true,
          credentialProxyTier: 'guest',
          chatJid: 'tg:111',
          memoryWriteAllowed: false,
        }),
      ).toEqual({ issueGrant: false, contextIsMain: false });
    },
  );

  it('keeps direct owner DM follow-ups pipeable but rotates an indirect one', () => {
    const direct = message('1', '111');
    direct.chat_jid = 'tg:111';
    const active = memoryRunIdentityForBinding(
      direct.chat_jid,
      direct.sender_identity,
      true,
    );
    expect(active).toEqual({
      senderId: '111',
      identityId: 'telegram_user_111',
    });
    expect(shouldRotateActiveRunForMessages(true, [direct], active)).toBe(
      false,
    );
    const forwarded = {
      ...direct,
      sender_identity: {
        ...direct.sender_identity!,
        telegram_message_origin: 'forwarded' as const,
      },
    };
    expect(shouldRotateActiveRunForMessages(true, [forwarded], active)).toBe(
      true,
    );
    expect(
      shouldRotateActiveRunForMessages(
        true,
        [
          {
            ...direct,
            chat_jid: '15551234567@s.whatsapp.net',
            sender_identity: undefined,
          },
        ],
        undefined,
      ),
    ).toBe(false);
  });

  it('does not upgrade a homogeneous co-member run in the main directory to owner memory', () => {
    expect(
      memoryProvenanceGrantPolicy({
        groupIsMain: true,
        credentialProxyTier: 'guest',
        chatJid: 'tg:-100123',
        memoryWriteAllowed: true,
      }),
    ).toEqual({ issueGrant: true, contextIsMain: false });
  });

  it('denies a mixed co-member main batch but preserves owner-main and private DM grants', () => {
    expect(
      memoryProvenanceGrantPolicy({
        groupIsMain: true,
        credentialProxyTier: 'guest',
        chatJid: 'tg:-100123',
        memoryWriteAllowed: false,
      }),
    ).toEqual({ issueGrant: false, contextIsMain: false });
    expect(
      memoryProvenanceGrantPolicy({
        groupIsMain: true,
        credentialProxyTier: 'owner',
        chatJid: 'tg:100000001',
        memoryWriteAllowed: true,
      }),
    ).toEqual({ issueGrant: true, contextIsMain: true });
    expect(
      memoryProvenanceGrantPolicy({
        groupIsMain: false,
        credentialProxyTier: 'guest',
        chatJid: 'tg:777',
        memoryWriteAllowed: true,
      }),
    ).toEqual({ issueGrant: true, contextIsMain: false });
  });

  it('fails closed for a metadata-less batch instead of treating undefined identities as equal', () => {
    const withoutIdentity = message('1', '111');
    delete withoutIdentity.sender_identity;
    expect(homogeneousMemoryRunIdentity([withoutIdentity])).toBeNull();
    expect(messagesMatchMemoryRunIdentity([withoutIdentity], null)).toBe(false);
  });

  it('does not pipe an A follow-up into a mixed-batch run with no active binding', () => {
    // Mixed batches deliberately do not install an active identity binding;
    // the next homogeneous message must start a fresh, writable capability.
    const identity = message('1', '111').sender_identity;
    const mixedRunBinding = memoryRunIdentityForBinding(
      'tg:-100123',
      identity,
      false,
    );
    expect(mixedRunBinding).toBeNull();
    expect(
      messagesMatchMemoryRunIdentity([message('1', '111')], mixedRunBinding),
    ).toBe(false);
  });
});
