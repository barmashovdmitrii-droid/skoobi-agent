import { describe, it, expect } from 'vitest';

import {
  buildClaudeclawMcpEnv,
  buildSdkEnv,
  CODEX_THREAD_MAX_AGE_MS,
  CODEX_THREAD_MAX_ROLLOUT_BYTES,
  codexTurnErrorOutput,
  isErrorResultMessage,
  neutralizeOutputMarkers,
  memoryRuntimeIsolationOptions,
  shouldRetryCodexStaleThreadFresh,
  shouldRotateCodexThread,
} from './index.js';

describe('buildClaudeclawMcpEnv owner-only gates', () => {
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
      expect(scheduledOwner.CLAUDECLAW_GOOGLE_SHEET_TARGET_HINTS_JSON).toBe(
        '[]',
      );

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
    over: Partial<{ preambleHash: string; createdAt: string }> = {},
  ) => ({
    preambleHash: 'hash-a',
    createdAt: '2026-07-04T00:00:00Z',
    ...over,
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

  it('rotates an oversized rollout, resumes just under the byte cap', () => {
    expect(
      shouldRotateCodexThread(
        meta(),
        'hash-a',
        NOW,
        CODEX_THREAD_MAX_ROLLOUT_BYTES + 1,
      ),
    ).toBe('oversized');
    expect(
      shouldRotateCodexThread(
        meta(),
        'hash-a',
        NOW,
        CODEX_THREAD_MAX_ROLLOUT_BYTES,
      ),
    ).toBeNull();
  });

  it('skips the byte check when rolloutBytes is 0/undefined (file not found)', () => {
    expect(shouldRotateCodexThread(meta(), 'hash-a', NOW, 0)).toBeNull();
    expect(
      shouldRotateCodexThread(meta(), 'hash-a', NOW, undefined),
    ).toBeNull();
  });

  it('context-change and expiry take precedence over the byte check', () => {
    const huge = CODEX_THREAD_MAX_ROLLOUT_BYTES + 1;
    expect(shouldRotateCodexThread(meta(), 'hash-b', NOW, huge)).toBe(
      'context-changed',
    );
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
