import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import { eventSessionIdForTenant, getEventsForTenant } from './event-store.js';
import {
  buildLiveModelRequest,
  chargeLiveUsage,
  liveModeSelectionReason,
  loadLiveCanaryConfig,
  resolveCurrentTurnImageAttachments,
  resolvePromptImageAttachments,
  runLiveModelTurn,
  shouldStartLiveMode,
} from './live-mode.js';
import type { ModelGateway } from './model-gateway.js';
import {
  chargeQuotaUsage,
  loadBillingConfig,
  quotaIdempotencyKey,
} from './quota.js';
import type { TenantRecord } from './tenant-registry.js';

function tenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  const base: TenantRecord = {
    tenant_id: 'tg_chat_-1001',
    folder: 'telegram_guest',
    channel: 'telegram',
    chat_id: '-1001',
    mode: 'guest',
    runtime: 'skoobi_live',
    approved_senders: [],
    models: {},
    quota: { enabled: true },
    legacy_jid: 'tg:-1001',
    source: 'tenant_json',
    group: {
      name: 'Guest',
      folder: 'telegram_guest',
      trigger: '@Skoobi',
      added_at: '2026-05-15T00:00:00.000Z',
    },
  };
  const merged = { ...base, ...overrides };
  // Production invariant: an owner tenant IS a main group (tenant.mode is
  // derived from group.isMain in tenant-registry, and owner authority now
  // requires the trusted group.isMain flag — finding #69). Reflect that here so
  // owner fixtures are realistic; otherwise `tenant({ mode: 'owner' })` would
  // classify as a guest and wrongly expose guest tools.
  if (
    merged.mode === 'owner' &&
    merged.group &&
    merged.group.isMain === undefined
  ) {
    merged.group = { ...merged.group, isMain: true };
  }
  return merged;
}

beforeEach(() => {
  _initTestDatabase();
});

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(
    path.join(process.env.TMPDIR || '/tmp', 'live-mode-test-'),
  );
  tempRoots.push(root);
  return root;
}

function writeRasterFixture(filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  const bytes =
    ext === '.png'
      ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : ext === '.webp'
        ? Buffer.from('RIFF\u0004\u0000\u0000\u0000WEBP', 'binary')
        : Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  fs.writeFileSync(filePath, bytes);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('skoobi_live canary selection', () => {
  it('keeps Codex reserve fallback separate from live-mode selection', () => {
    const config = {
      enabled: false,
      telegramGuestLiveEnabled: false,
      telegramOwnerLiveEnabled: false,
      codexReserveFallbackEnabled: true,
    };

    expect(shouldStartLiveMode(tenant({ runtime: 'claude_sdk' }), config)).toBe(
      false,
    );
    expect(config.codexReserveFallbackEnabled).toBe(true);
  });

  it('loads the Codex reserve fallback flag from env-style overrides', () => {
    expect(
      loadLiveCanaryConfig({ codexReserveFallbackEnabled: true })
        .codexReserveFallbackEnabled,
    ).toBe(true);
  });

  it('loads the owner Codex full-agent flag from env-style overrides', () => {
    expect(
      loadLiveCanaryConfig({ codexOwnerFullAgentEnabled: true })
        .codexOwnerFullAgentEnabled,
    ).toBe(true);
  });

  it('loads the owner Codex full-agent mode from env-style overrides', () => {
    expect(
      loadLiveCanaryConfig({ codexOwnerFullAgentMode: 'always' })
        .codexOwnerFullAgentMode,
    ).toBe('always');
    expect(
      loadLiveCanaryConfig({ codexOwnerFullAgentMode: 'bogus' as 'auto' })
        .codexOwnerFullAgentMode,
    ).toBe('auto');
  });

  it('can disable legacy Claude fallback for Codex-only live mode', () => {
    expect(
      loadLiveCanaryConfig({ claudeFallbackEnabled: false })
        .claudeFallbackEnabled,
    ).toBe(false);
    expect(
      loadLiveCanaryConfig({ claudeFallbackEnabled: true })
        .claudeFallbackEnabled,
    ).toBe(true);
  });

  it('defaults legacy Claude fallback to disabled unless explicitly enabled', () => {
    expect(loadLiveCanaryConfig().claudeFallbackEnabled).toBe(false);
  });

  it('defaults the Codex reserve mode to full when no source specifies it', () => {
    // Empty-string override behaves like "unset" → full default.
    expect(
      loadLiveCanaryConfig({ codexReserveMode: '' as 'full' | 'text' })
        .codexReserveMode,
    ).toBe('full');
  });

  it('honours the text reserve mode from an override (case-insensitive)', () => {
    expect(
      loadLiveCanaryConfig({ codexReserveMode: 'text' }).codexReserveMode,
    ).toBe('text');
    expect(
      loadLiveCanaryConfig({ codexReserveMode: 'TEXT' as 'full' | 'text' })
        .codexReserveMode,
    ).toBe('text');
  });

  it('falls back to full mode on an unknown reserve mode value', () => {
    expect(
      loadLiveCanaryConfig({ codexReserveMode: 'hybrid' as 'full' | 'text' })
        .codexReserveMode,
    ).toBe('full');
  });

  it('starts live mode only for one enabled guest tenant canary', () => {
    const config = { enabled: true, tenantId: 'tg_chat_-1001' };

    expect(shouldStartLiveMode(tenant(), config)).toBe(true);
    expect(
      shouldStartLiveMode(tenant({ tenant_id: 'tg_chat_-1002' }), config),
    ).toBe(false);
    expect(
      shouldStartLiveMode(tenant({ runtime: 'skoobi_shadow' }), config),
    ).toBe(false);
    expect(shouldStartLiveMode(tenant({ runtime: 'claude_sdk' }), config)).toBe(
      false,
    );
    expect(shouldStartLiveMode(tenant({ mode: 'owner' }), config)).toBe(false);
    expect(
      shouldStartLiveMode(tenant(), {
        enabled: false,
        tenantId: 'tg_chat_-1001',
      }),
    ).toBe(false);
  });

  it('also supports selecting the canary by Telegram chat_id', () => {
    expect(
      shouldStartLiveMode(tenant(), { enabled: true, chatId: '-1001' }),
    ).toBe(true);
  });

  it('can enable global Telegram guest live rollout while excluding owner and shadow tenants', () => {
    const config = { enabled: false, telegramGuestLiveEnabled: true };

    expect(shouldStartLiveMode(tenant({ runtime: 'claude_sdk' }), config)).toBe(
      true,
    );
    expect(
      shouldStartLiveMode(tenant({ tenant_id: 'tg_chat_other' }), config),
    ).toBe(true);
    expect(
      shouldStartLiveMode(tenant({ runtime: 'skoobi_shadow' }), config),
    ).toBe(false);
    expect(shouldStartLiveMode(tenant({ mode: 'owner' }), config)).toBe(false);
    expect(
      shouldStartLiveMode(
        tenant({ mode: 'guest', group: { ...tenant().group, isMain: true } }),
        config,
      ),
    ).toBe(false);
  });

  it('can explicitly enable owner/admin live rollout while still excluding shadow tenants', () => {
    const config = { enabled: false, telegramOwnerLiveEnabled: true };

    expect(
      shouldStartLiveMode(
        tenant({
          mode: 'owner',
          runtime: 'claude_sdk',
          group: { ...tenant().group, isMain: true },
        }),
        config,
      ),
    ).toBe(true);
    expect(
      shouldStartLiveMode(
        tenant({
          mode: 'owner',
          runtime: 'skoobi_shadow',
          group: { ...tenant().group, isMain: true },
        }),
        config,
      ),
    ).toBe(false);
    expect(shouldStartLiveMode(tenant({ mode: 'guest' }), config)).toBe(false);
  });

  it('pins excluded folders to the Claude SDK runtime even when guest-live is globally enabled (finding #21)', () => {
    const config = {
      enabled: false,
      telegramGuestLiveEnabled: true,
      excludeFolders: ['telegram_guest_canary'],
    };

    // Excluded folder stays off Codex live mode despite the global guest toggle.
    expect(
      shouldStartLiveMode(tenant({ folder: 'telegram_guest_canary' }), config),
    ).toBe(false);
    // Other guest folders are still routed to live mode.
    expect(
      shouldStartLiveMode(tenant({ folder: 'telegram_other_guest' }), config),
    ).toBe(true);
    // The selection reason also reflects the pin (delegates to shouldStartLiveMode).
    expect(
      liveModeSelectionReason(
        tenant({ folder: 'telegram_guest_canary' }),
        config,
      ),
    ).toBe(null);
  });

  it('normalizes the exclude-folders override into a trimmed, de-duped list', () => {
    expect(
      loadLiveCanaryConfig({
        excludeFolders: [' telegram_a ', 'telegram_b', 'telegram_a', '  '],
      }).excludeFolders,
    ).toEqual(['telegram_a', 'telegram_b']);
  });
});

describe('live model request', () => {
  it('builds a guest text-only request with no owner tools visible', () => {
    const request = buildLiveModelRequest({
      tenant: tenant(),
      prompt: 'Hello',
      senderId: '42',
    });

    expect(request).toMatchObject({
      tenant_id: 'tg_chat_-1001',
      model_role: 'default',
      metadata: {
        channel: 'telegram',
        chat_id: '-1001',
        sender_id: '42',
        tenant_mode: 'guest',
      },
    });
    expect(request.tools.map((tool) => tool.name)).toEqual(['echo_diagnostic']);
    expect(
      request.tools.some((tool) =>
        tool.policy_tags.some((tag) => tag.startsWith('owner')),
      ),
    ).toBe(false);
  });

  it('builds owner live requests without exposing tools or guest metadata', () => {
    const request = buildLiveModelRequest({
      tenant: tenant({ mode: 'owner' }),
      prompt: 'Привет',
      senderId: '42',
      modelRole: 'owner',
    });

    expect(request.model_role).toBe('owner');
    expect(request.metadata.tenant_mode).toBe('owner');
    expect(request.metadata.task_type).toBe('admin');
    expect(request.tools).toEqual([]);
    expect(request.messages[0].content).toContain('<skoobi_truthfulness>');
    expect(request.messages[0].content).toContain('Do not invent facts');
    expect(request.messages[0].content).toContain(
      'administrator Telegram tenant',
    );
    expect(request.messages[0].content).toContain(
      '<protected_admin_runtime_continuity',
    );
    expect(request.messages[0].content).toContain(
      'Keep Skoobi continuity across provider changes',
    );
    expect(request.messages[0].content).toContain(
      'This Codex adapter must not claim direct shell',
    );
    expect(request.messages[0].content).toContain(
      'without presenting yourself as a different bot or blaming another provider',
    );
  });

  it('summarizes protected admin runtime config without exposing secrets', () => {
    const request = buildLiveModelRequest({
      tenant: tenant({
        mode: 'owner',
        group: {
          name: 'Admin',
          folder: 'telegram_main',
          trigger: '@Skoobi',
          added_at: '2026-05-15T00:00:00.000Z',
          isMain: true,
          agentConfig: {
            model: 'claude-opus-4-8',
            effort: 'max',
            noSandbox: true,
            fullAccess: true,
            allowedTools: ['Bash', 'Read'],
            disallowedTools: ['Write'],
            systemPrompt:
              'FULL ACCESS MODE. token=secret-value. Use local deployment knowledge.',
          },
        },
      }),
      prompt: 'Что ты умеешь?',
      senderId: '42',
      modelRole: 'owner',
    });

    const system = request.messages[0].content;
    expect(system).toContain('model="claude-opus-4-8"');
    expect(system).toContain('effort="max"');
    expect(system).toContain('full_access="true"');
    expect(system).toContain('allowed_tools="Bash, Read"');
    expect(system).toContain(
      '<admin_runtime_instruction_excerpt>FULL ACCESS MODE.',
    );
    expect(system).toContain('token=[redacted]');
    expect(system).not.toContain('secret-value');
    expect(request.tools).toEqual([]);
  });

  it('builds degraded quota requests with the cheap model role', () => {
    const request = buildLiveModelRequest({
      tenant: tenant(),
      prompt: 'Hello',
      senderId: '42',
      modelRole: 'cheap',
    });

    expect(request.model_role).toBe('cheap');
    expect(request.metadata.tenant_mode).toBe('guest');
  });

  it('adds persona metadata and concise persona instructions to live requests', () => {
    const request = buildLiveModelRequest({
      tenant: tenant({
        bot_id: 'skoobi_lawyer',
        persona_id: 'lawyer',
      }),
      prompt: 'Проверь договор',
      senderId: '42',
    });

    expect(request.messages[0].content).toContain(
      '<skoobi_persona id="lawyer"',
    );
    expect(request.messages[0].content).toContain('legal assistant');
    expect(request.metadata.bot_id).toBe('skoobi_lawyer');
    expect(request.metadata.persona_id).toBe('lawyer');
  });

  it('passes host-provided SearchGateway context without enabling model-side search', () => {
    const request = buildLiveModelRequest({
      tenant: tenant(),
      prompt: 'Собери список компаний',
      senderId: '42',
      webSearchContext:
        '<web_search_results provider="codex_cli">[1] Example\nURL: https://example.com</web_search_results>',
      webSearchProvider: 'codex_cli',
      webSearchResultCount: 1,
    });

    expect(request.messages.at(-1)?.content).toContain(
      '<web_search_results provider="codex_cli">',
    );
    expect(request.messages.at(-1)?.content).toContain(
      'Собери список компаний',
    );
    expect(request.metadata.web_search_context_provided).toBe(true);
    expect(request.metadata.web_search_provider).toBe('codex_cli');
    expect(request.metadata.web_search_result_count).toBe(1);
  });

  it('keeps voice delivery as host metadata instead of prompt instruction', () => {
    const request = buildLiveModelRequest({
      tenant: tenant(),
      prompt: 'Расскажи голосом стишок',
      senderId: '42',
      voiceReplyRequested: true,
    });

    expect(request.messages[0].content).not.toContain('voice reply');
    expect(request.messages[0].content).not.toContain('voice note');
    expect(request.metadata.voice_reply_requested).toBe(true);
  });
});

describe('resolvePromptImageAttachments', () => {
  it('resolves up to three received image refs inside the tenant folder', () => {
    const groupsDir = tempRoot();
    const receivedDir = path.join(groupsDir, 'telegram_guest', 'received');
    fs.mkdirSync(receivedDir, { recursive: true });
    for (const name of [
      'frame-01.jpg',
      'frame-02.png',
      'frame-03.webp',
      'frame-04.jpg',
    ]) {
      writeRasterFixture(path.join(receivedDir, name));
    }

    const images = resolvePromptImageAttachments(
      'Key-frame files: received/frame-01.jpg, received/frame-02.png, received/frame-01.jpg, received/frame-03.webp, received/frame-04.jpg',
      'telegram_guest',
      { groupsDir },
    );

    expect(images.map((image) => path.basename(image))).toEqual([
      'frame-01.jpg',
      'frame-02.png',
      'frame-03.webp',
    ]);
    const receivedReal = fs.realpathSync(receivedDir);
    expect(images.every((image) => image.startsWith(receivedReal))).toBe(true);
  });

  it('ignores symlink escapes from received media', () => {
    const groupsDir = tempRoot();
    const receivedDir = path.join(groupsDir, 'telegram_guest', 'received');
    fs.mkdirSync(receivedDir, { recursive: true });
    const outsideImage = path.join(groupsDir, 'outside.jpg');
    writeRasterFixture(outsideImage);
    fs.symlinkSync(outsideImage, path.join(receivedDir, 'escape.jpg'));
    writeRasterFixture(path.join(receivedDir, 'safe.jpg'));

    const images = resolvePromptImageAttachments(
      'received/escape.jpg received/safe.jpg',
      'telegram_guest',
      { groupsDir },
    );

    expect(images.map((image) => path.basename(image))).toEqual(['safe.jpg']);
  });

  it('rejects extension-only and over-15MiB image attachments', () => {
    const groupsDir = tempRoot();
    const receivedDir = path.join(groupsDir, 'telegram_guest', 'received');
    fs.mkdirSync(receivedDir, { recursive: true });
    fs.writeFileSync(path.join(receivedDir, 'fake.jpg'), 'not an image');
    const huge = path.join(receivedDir, 'huge.jpg');
    writeRasterFixture(huge);
    fs.truncateSync(huge, 15 * 1024 * 1024 + 1);

    expect(
      resolvePromptImageAttachments(
        'received/fake.jpg received/huge.jpg',
        'telegram_guest',
        { groupsDir },
      ),
    ).toEqual([]);
  });

  it('prioritizes current turn image refs over older history refs', () => {
    const groupsDir = tempRoot();
    const receivedDir = path.join(groupsDir, 'telegram_guest', 'received');
    fs.mkdirSync(receivedDir, { recursive: true });
    for (const name of [
      'old-frame-01.jpg',
      'old-frame-02.jpg',
      'new-frame-01.jpg',
      'new-frame-02.jpg',
    ]) {
      writeRasterFixture(path.join(receivedDir, name));
    }

    const images = resolveCurrentTurnImageAttachments(
      {
        currentPrompt:
          '[Video note Key-frame files: received/new-frame-01.jpg, received/new-frame-02.jpg]',
        fullPrompt:
          '[Recent: received/old-frame-01.jpg, received/old-frame-02.jpg]\n\n[Video note Key-frame files: received/new-frame-01.jpg, received/new-frame-02.jpg]',
        groupFolder: 'telegram_guest',
      },
      { groupsDir },
    );

    expect(images.map((image) => path.basename(image))).toEqual([
      'new-frame-01.jpg',
      'new-frame-02.jpg',
    ]);
  });

  it('does not attach old history image refs to unrelated text turns', () => {
    const groupsDir = tempRoot();
    const receivedDir = path.join(groupsDir, 'telegram_guest', 'received');
    fs.mkdirSync(receivedDir, { recursive: true });
    writeRasterFixture(path.join(receivedDir, 'old-frame-01.jpg'));

    const images = resolveCurrentTurnImageAttachments(
      {
        currentPrompt: 'Привет, ответь коротко',
        fullPrompt:
          '[Recent: received/old-frame-01.jpg]\n\nПривет, ответь коротко',
        groupFolder: 'telegram_guest',
      },
      { groupsDir },
    );

    expect(images).toEqual([]);
  });

  it('falls back to history image refs when the current turn asks about media', () => {
    const groupsDir = tempRoot();
    const receivedDir = path.join(groupsDir, 'telegram_guest', 'received');
    fs.mkdirSync(receivedDir, { recursive: true });
    writeRasterFixture(path.join(receivedDir, 'old-frame-01.jpg'));

    const images = resolveCurrentTurnImageAttachments(
      {
        currentPrompt: 'Что на этом фото?',
        fullPrompt: '[Recent: received/old-frame-01.jpg]\n\nЧто на этом фото?',
        groupFolder: 'telegram_guest',
      },
      { groupsDir },
    );

    expect(images.map((image) => path.basename(image))).toEqual([
      'old-frame-01.jpg',
    ]);
  });

  it('does not attach old history frames to a current video placeholder without frames', () => {
    const groupsDir = tempRoot();
    const receivedDir = path.join(groupsDir, 'telegram_guest', 'received');
    fs.mkdirSync(receivedDir, { recursive: true });
    writeRasterFixture(path.join(receivedDir, 'old-frame-01.jpg'));

    const images = resolveCurrentTurnImageAttachments(
      {
        currentPrompt: '[Video]',
        fullPrompt: '[Recent: received/old-frame-01.jpg]\n\n[Video]',
        groupFolder: 'telegram_guest',
      },
      { groupsDir },
    );

    expect(images).toEqual([]);
  });
});

describe('live model turn', () => {
  it('records a live response trace and usage event', async () => {
    const t = tenant();
    const gateway: ModelGateway = {
      complete: async () => ({
        text: 'Skoobi live answer',
        tool_calls: [],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cost_usd: 0.002,
          provider_model: 'provider-model',
        },
        provider_response_id: 'resp-live-1',
      }),
    };

    const run = await runLiveModelTurn({
      tenant: t,
      prompt: 'Prompt',
      senderId: '42',
      gateway,
      now: Date.now(),
    });

    expect(run).toMatchObject({
      status: 'success',
      answerText: 'Skoobi live answer',
      toolCallsRequested: 0,
      toolCallsDenied: 0,
    });
    const trace = getDb()
      .prepare(`SELECT * FROM model_traces WHERE id = ?`)
      .get(run.traceId) as {
      run_mode: string;
      status: string;
      input_tokens: number;
      output_tokens: number;
      payload_json: string;
    };
    const usage = getDb()
      .prepare(`SELECT * FROM usage_events WHERE tenant_id = ?`)
      .get(t.tenant_id) as { input_tokens: number; cost_usd: number };
    const events = getEventsForTenant(t.tenant_id).map((event) => event.type);

    expect(trace).toMatchObject({
      run_mode: 'live',
      status: 'success',
      input_tokens: 11,
      output_tokens: 7,
    });
    expect(JSON.parse(trace.payload_json)).toMatchObject({
      provider_response_id: 'resp-live-1',
      live_answer_sent_to_user: false,
      visible_tools: ['echo_diagnostic'],
      owner_tools_visible: false,
    });
    expect(usage).toMatchObject({ input_tokens: 11, cost_usd: 0.002 });
    expect(events).toContain('model_gateway_live_response');
  });

  it('logs policy denial when the live model requests an unknown tool', async () => {
    const t = tenant();
    const gateway: ModelGateway = {
      complete: async () => ({
        text: '',
        tool_calls: [
          {
            id: 'call-unknown',
            name: 'owner_shell',
            arguments_json: '{}',
          },
        ],
      }),
    };

    const run = await runLiveModelTurn({
      tenant: t,
      prompt: 'Prompt',
      senderId: '42',
      gateway,
    });

    expect(run.status).toBe('success');
    if (run.status !== 'success') return;
    expect(run.answerText).toBe('This tool is not available in this tenant.');
    expect(run.toolCallsRequested).toBe(1);
    expect(run.toolCallsDenied).toBe(1);
    expect(getEventsForTenant(t.tenant_id).map((event) => event.type)).toEqual([
      'session_started',
      'tool_call_requested',
      'tool_policy_denied',
      'model_gateway_live_response',
    ]);
    const denied = getDb()
      .prepare(
        `SELECT status, tool_name FROM tool_calls WHERE status = 'denied'`,
      )
      .get() as { status: string; tool_name: string };
    expect(denied).toEqual({ status: 'denied', tool_name: 'owner_shell' });
  });

  it('can execute the safe echo_diagnostic tool and log completion', async () => {
    const t = tenant();
    const gateway: ModelGateway = {
      complete: async () => ({
        text: '',
        tool_calls: [
          {
            id: 'call-echo',
            name: 'echo_diagnostic',
            arguments_json: JSON.stringify({ message: 'pong' }),
          },
        ],
      }),
    };

    const run = await runLiveModelTurn({
      tenant: t,
      prompt: 'Prompt',
      senderId: '42',
      gateway,
    });

    expect(run.status).toBe('success');
    if (run.status !== 'success') return;
    expect(run.answerText).toBe('Диагностика: pong');
    expect(run.toolCallsAllowed).toBe(1);
    const statuses = getDb()
      .prepare(`SELECT status FROM tool_calls ORDER BY created_at, rowid`)
      .all() as Array<{ status: string }>;
    expect(statuses.map((row) => row.status)).toEqual([
      'requested',
      'allowed',
      'completed',
    ]);
  });

  it('records provider errors without charging quota', async () => {
    const t = tenant();
    const gateway: ModelGateway = {
      complete: async () => {
        throw new Error('provider unavailable');
      },
    };

    const run = await runLiveModelTurn({
      tenant: t,
      prompt: 'Prompt',
      senderId: '42',
      gateway,
    });

    expect(run).toMatchObject({
      status: 'error',
      error: { message: 'provider unavailable' },
    });
    expect(
      (
        getDb().prepare(`SELECT COUNT(*) AS c FROM usage_ledger`).get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });
});

describe('live quota charging', () => {
  const billingEnabledConfig = loadBillingConfig({ enabled: true });

  it('charges live usage once by idempotency key', async () => {
    const t = tenant();
    const gateway: ModelGateway = {
      complete: async () => ({
        text: 'Skoobi live answer',
        tool_calls: [],
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cost_usd: 0.001,
          provider_model: 'provider-model',
        },
      }),
    };
    const run = await runLiveModelTurn({
      tenant: t,
      prompt: 'Prompt',
      senderId: '42',
      gateway,
    });

    const first = chargeLiveUsage({
      tenant: t,
      run,
      senderId: '42',
      targetCursor: '2026-05-16T01:00:00.000Z',
      createdAt: 10,
      config: billingEnabledConfig,
    });
    const second = chargeLiveUsage({
      tenant: t,
      run,
      senderId: '42',
      targetCursor: '2026-05-16T01:00:00.000Z',
      createdAt: 11,
      config: billingEnabledConfig,
    });

    expect(first?.charged).toBe(true);
    expect(second?.duplicate).toBe(true);
    expect(
      (
        getDb().prepare(`SELECT COUNT(*) AS c FROM usage_ledger`).get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
    expect(
      getEventsForTenant(t.tenant_id).filter(
        (event) => event.type === 'quota_charged',
      ),
    ).toHaveLength(1);
  });

  it('does not bill shadow-mode tenants via the Codex reserve-fallback path', async () => {
    const t = tenant({ runtime: 'skoobi_shadow' });
    const gateway: ModelGateway = {
      complete: async () => ({
        text: 'Skoobi shadow answer',
        tool_calls: [],
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cost_usd: 0.001,
          provider_model: 'provider-model',
        },
      }),
    };
    const run = await runLiveModelTurn({
      tenant: t,
      prompt: 'Prompt',
      senderId: '42',
      gateway,
    });

    const charge = chargeLiveUsage({
      tenant: t,
      run,
      senderId: '42',
      targetCursor: '2026-05-16T01:00:00.000Z',
      createdAt: 10,
      config: billingEnabledConfig,
    });

    expect(charge?.charged).toBe(false);
    expect(charge?.skippedReason).toBe('shadow');
    expect(
      (
        getDb().prepare(`SELECT COUNT(*) AS c FROM usage_ledger`).get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(
      getEventsForTenant(t.tenant_id).filter(
        (event) => event.type === 'quota_charged',
      ),
    ).toHaveLength(0);
  });

  it('still bills live-mode tenants normally', async () => {
    const t = tenant({ runtime: 'skoobi_live' });
    const gateway: ModelGateway = {
      complete: async () => ({
        text: 'Skoobi live answer',
        tool_calls: [],
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cost_usd: 0.001,
          provider_model: 'provider-model',
        },
      }),
    };
    const run = await runLiveModelTurn({
      tenant: t,
      prompt: 'Prompt',
      senderId: '42',
      gateway,
    });

    const charge = chargeLiveUsage({
      tenant: t,
      run,
      senderId: '42',
      targetCursor: '2026-05-16T02:00:00.000Z',
      createdAt: 10,
      config: billingEnabledConfig,
    });

    expect(charge?.charged).toBe(true);
    expect(charge?.skippedReason).toBeUndefined();
    expect(
      (
        getDb().prepare(`SELECT COUNT(*) AS c FROM usage_ledger`).get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
  });

  it('does not double-charge when Codex fails and Claude fallback succeeds for the same logical request', async () => {
    const t = tenant();
    const failingGateway: ModelGateway = {
      complete: async () => {
        throw new Error('Codex CLI rate limited');
      },
    };
    const targetCursor = 'same-logical-failover-request';
    const failedCodexRun = await runLiveModelTurn({
      tenant: t,
      prompt: 'Prompt',
      senderId: '42',
      gateway: failingGateway,
    });

    const codexCharge = chargeLiveUsage({
      tenant: t,
      run: failedCodexRun,
      senderId: '42',
      targetCursor,
      config: billingEnabledConfig,
    });
    const sessionId = eventSessionIdForTenant(t);
    const idempotencyKey = quotaIdempotencyKey({
      tenantId: t.tenant_id,
      sessionId,
      channel: t.channel,
      chatId: t.chat_id,
      channelUserId: '42',
      targetCursor,
    });
    const fallbackCharge = chargeQuotaUsage({
      tenantId: t.tenant_id,
      sessionId,
      channel: t.channel,
      chatId: t.chat_id,
      channelUserId: '42',
      modelRole: 'default',
      providerModel: 'claude-opus-4-7',
      inputTokens: 10,
      outputTokens: 5,
      providerCostUsd: null,
      idempotencyKey,
      runStatus: 'success',
      isShadow: false,
      config: billingEnabledConfig,
    });
    const duplicateFallbackCharge = chargeQuotaUsage({
      tenantId: t.tenant_id,
      sessionId,
      channel: t.channel,
      chatId: t.chat_id,
      channelUserId: '42',
      modelRole: 'default',
      providerModel: 'claude-opus-4-7',
      inputTokens: 10,
      outputTokens: 5,
      providerCostUsd: null,
      idempotencyKey,
      runStatus: 'success',
      isShadow: false,
      config: billingEnabledConfig,
    });

    expect(codexCharge).toBeUndefined();
    expect(fallbackCharge.charged).toBe(true);
    expect(duplicateFallbackCharge.duplicate).toBe(true);
    expect(
      (
        getDb().prepare(`SELECT COUNT(*) AS c FROM usage_ledger`).get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
  });
});
