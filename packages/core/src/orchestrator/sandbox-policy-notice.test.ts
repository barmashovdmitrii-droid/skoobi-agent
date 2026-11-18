import fs from 'node:fs';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn(() => {
    throw new Error('No child process may start in this test');
  }),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn,
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  spawn.mockClear();
});

it.each([
  'ack',
  'offline',
  'ack-lost',
  'silent',
  'redirect',
  'image-ack-lost',
  'correction',
  'cancel',
] as const)(
  'delivers the sandbox refusal in its original chat without restarting work (%s)',
  async (outcome) => {
    const id = String(
      485300 +
        [
          'ack',
          'offline',
          'ack-lost',
          'silent',
          'redirect',
          'image-ack-lost',
          'correction',
          'cancel',
        ].indexOf(outcome),
    );
    const chat = 'tg:' + id;
    const otherChat = 'tg:485399';
    const folder = 'policy-fixture-' + id;
    const stateRoot = process.env.SKOOBI_TEST_STATE_ROOT!;
    const fixtureHome = path.join(stateRoot, 'home', folder);
    const codexHome = path.join(fixtureHome, '.codex');
    const fixtureAuth = JSON.stringify({ fixture: 'sandbox-policy-notice' });
    fs.mkdirSync(codexHome, { recursive: true });
    vi.stubEnv('HOME', fixtureHome);
    vi.stubEnv('CODEX_HOME', codexHome);
    if (outcome === 'image-ack-lost') {
      // Codex primary prepares its isolated home before checking the policy.
      fs.writeFileSync(path.join(codexHome, 'auth.json'), fixtureAuth, {
        mode: 0o600,
      });
    }
    vi.stubEnv(
      'SKOOBI_SANDBOX_CODEX_PRIMARY',
      outcome === 'image-ack-lost' ? 'true' : 'false',
    );
    vi.stubEnv('OWNER_TELEGRAM_USER_IDS', id);
    vi.stubEnv('OWNER_TELEGRAM_CHAT_IDS', id);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 403 })),
    );
    vi.resetModules();

    const db = await import('./db.js');
    const loop = await import('./message-loop.js');
    const runtime = await import('../runtimes/sandbox-runner.js');
    const budget = await import('../runtimes/sandbox-policy-budget.js');
    const { sandboxPolicyNotices } = await import('./sandbox-policy-notice.js');
    const gateway = await import('./live-mode.js');
    const { createMessageRouter } = await import('./outbound-router.js');
    const { createTelegramSenderIdentity, loadOwnerAllowlistFromEnv } =
      await import('@skoobi/shared/telegram-identity');
    const { getExtensionDbSchema } = await import('./extensions.js');
    db.initDatabase(getExtensionDbSchema());
    db.setRegisteredGroup(chat, {
      name: 'Policy fixture',
      folder,
      isMain: true,
      trigger: '',
      requiresTrigger: false,
      runtime: 'sandbox',
      added_at: new Date().toISOString(),
      agentConfig: { suppressAgentStdoutRouting: outcome === 'silent' },
    });
    loop._loadStateForTest();

    vi.spyOn(gateway, 'loadLiveCanaryConfig').mockReturnValue({
      enabled: false,
      chatId: id,
      telegramOwnerLiveEnabled: false,
      codexOwnerFullAgentEnabled: false,
      claudeFallbackEnabled: true,
      codexReserveFallbackEnabled: true,
      codexReserveMode: 'full',
    });
    const gatewayRun = vi.spyOn(gateway, 'runLiveModelTurn');
    const run = vi.spyOn(runtime, 'runSandboxAgent');
    const check = budget.assertSandboxPolicyInputs;
    const guard = vi
      .spyOn(budget, 'assertSandboxPolicyInputs')
      .mockImplementation((mounts, domains) =>
        check(mounts, domains, {
          ...budget.SANDBOX_POLICY_LIMITS,
          entryBytes: 1,
        }),
      );
    let connected = true;
    const sent: Array<[string, string]> = [];
    const channel = {
      name: 'telegram',
      ownsJid: (jid: string) => jid === chat || jid === otherChat,
      isConnected: () => connected,
      setTyping: vi.fn(async () => {}),
      sendMessage: vi.fn(async (jid: string, text: string) => {
        sent.push([jid, text]);
        if (outcome === 'ack-lost' || outcome === 'image-ack-lost')
          throw new Error('transport acknowledgement unavailable');
      }),
    };
    loop._setChannelsForTest([channel as never]);
    const router = createMessageRouter([channel as never]);
    if (outcome === 'redirect')
      router.addPreHook(async (envelope) => ({
        action: 'modify',
        envelope: { ...envelope, chatJid: otherChat },
      }));
    const startsOffline =
      outcome === 'offline' || outcome === 'correction' || outcome === 'cancel';
    if (startsOffline)
      router.addPreHook(async (envelope) => {
        if (sent.length === 0 && envelope.meta?.kind === 'sandbox_policy_limit')
          connected = false;
        return { action: 'continue' };
      });

    const identity = createTelegramSenderIdentity({
      chatId: id,
      fromId: id,
      ownerAllowlist: loadOwnerAllowlistFromEnv(),
    });
    db.storeMessage({
      id: 'policy-input',
      content:
        outcome === 'image-ack-lost'
          ? 'Нарисуй полосатого кота'
          : 'Подготовь план работы.',
      chat_jid: chat,
      sender: id,
      sender_name: 'Fixture',
      timestamp: new Date().toISOString(),
      sender_identity: { ...identity, telegram_message_origin: 'direct' },
    });
    const first = await loop.processGroupMessages(chat, router);
    expect(first).toBe(!startsOffline);
    if (outcome === 'image-ack-lost') {
      const dataDir = path.join(stateRoot, 'data');
      expect(
        fs.readFileSync(path.join(dataDir, 'codex-auth', 'auth.json'), 'utf8'),
      ).toBe(fixtureAuth);
      expect(
        fs.existsSync(path.join(runtime.codexHomeDirFor(folder), 'auth.json')),
      ).toBe(false);
      const job = db.getRecentImageJob(chat);
      expect(job).toMatchObject({
        status: 'failed',
        generation_attempts: 1,
        failure_notified_at: null,
      });
      expect(
        db
          .getImageJobsPendingFailureNotice()
          .some((item) => item.id === job!.id),
      ).toBe(false);
      const { recoverPendingImageJobs } = await import('./image-pipeline.js');
      const fallbackNotice = vi.fn();
      await recoverPendingImageJobs({
        router,
        includeFreshGenerating: true,
        onTerminalFailure: fallbackNotice,
      });
      expect(fallbackNotice).not.toHaveBeenCalled();
    }
    expect(guard).toHaveBeenCalledTimes(1);
    loop._loadStateForTest();
    connected = true;
    if (outcome === 'correction' || outcome === 'cancel') {
      db.storeMessage({
        id: 'follow-up',
        chat_jid: chat,
        sender: id,
        sender_name: 'Fixture',
        content:
          outcome === 'cancel'
            ? 'Отмени задачу'
            : 'Поправка: сделай план на два дня.',
        timestamp: new Date().toISOString(),
        sender_identity: { ...identity, telegram_message_origin: 'direct' },
      });
      if (outcome === 'correction')
        run.mockResolvedValueOnce(budget.sandboxPolicyRefusal('list_entries'));
    }
    const recoveredRouter = createMessageRouter([channel as never]);
    expect(await loop.processGroupMessages(chat, recoveredRouter)).toBe(true);
    expect(await loop.processGroupMessages(chat, recoveredRouter)).toBe(true);
    expect(run).toHaveBeenCalledTimes(outcome === 'correction' ? 2 : 1);
    expect(gatewayRun).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    if (outcome === 'cancel') {
      expect(sent.map(([, text]) => text)).not.toContain(
        sandboxPolicyNotices.entry_bytes,
      );
    } else if (outcome === 'correction') {
      expect(run.mock.calls[1]?.[1].prompt).toContain(
        'Поправка: сделай план на два дня.',
      );
      expect(sent).toEqual([[chat, sandboxPolicyNotices.list_entries]]);
    } else {
      expect(sent).toEqual(
        outcome === 'silent' || outcome === 'redirect'
          ? []
          : [[chat, sandboxPolicyNotices.entry_bytes]],
      );
    }
    expect(
      db.getRouterState(
        'sandbox_policy_notice:' + JSON.stringify([chat, folder]),
      ),
    ).toBe('');
  },
  30_000,
);
