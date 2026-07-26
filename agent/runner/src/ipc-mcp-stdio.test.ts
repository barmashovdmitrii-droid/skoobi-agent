import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  createDecipheriv,
  createHmac,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
} from 'crypto';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture every server.tool(name, description, schema, handler) registration so
// tests can invoke the real handlers without a live MCP transport.
const registeredTools = new Map<
  string,
  (args: unknown, extra?: unknown) => unknown
>();

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    constructor(_opts: unknown) {}
    tool(...callArgs: unknown[]) {
      const name = callArgs[0] as string;
      const handler = callArgs[callArgs.length - 1] as (
        args: unknown,
        extra?: unknown,
      ) => unknown;
      registeredTools.set(name, handler);
      return {};
    }
    async connect() {
      /* no-op: never opens stdio in tests */
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

const COMPUTER_TOOLS = [
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_open_app',
  'computer_mouse_move',
  'computer_screen_size',
];

const CODEX_DESKTOP_TOOLS = ['codex_desktop_status', 'codex_desktop_control'];

const MINIMAL_ARGS: Record<string, unknown> = {
  computer_screenshot: {},
  computer_click: { x: 10, y: 20 },
  computer_type: { text: 'hi' },
  computer_key: { keys: 'return' },
  computer_open_app: { name: 'Safari' },
  computer_mouse_move: { x: 5, y: 5 },
  computer_screen_size: {},
  codex_desktop_status: { action: 'status' },
  codex_desktop_control: {
    action: 'open',
    thread_id: '00000000-0000-0000-0000-000000000000',
  },
};

function openTaskAuthorizationEnvelopeForTest(
  request: Record<string, unknown>,
  capabilitySecret: string,
): Record<string, unknown> {
  const capabilityId = String(request.capability_id);
  const requestId = String(request.request_id);
  const action = String(request.action);
  const sealed = request.sealed_envelope as Record<string, unknown>;
  const key = createHmac('sha256', Buffer.from(capabilitySecret, 'base64url'))
    .update('skoobi.task_authorization.envelope.key.v1')
    .update('\0')
    .update(capabilityId)
    .digest();
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(String(sealed.iv), 'base64url'),
    );
    decipher.setAAD(
      Buffer.from(
        JSON.stringify([
          'skoobi.task_authorization.envelope.aad.v1',
          capabilityId,
          requestId,
          action,
        ]),
      ),
    );
    decipher.setAuthTag(Buffer.from(String(sealed.tag), 'base64url'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(String(sealed.ciphertext), 'base64url')),
        decipher.final(),
      ]).toString('utf8'),
    ) as Record<string, unknown>;
  } finally {
    key.fill(0);
  }
}

function setBaseEnv() {
  process.env.CLAUDECLAW_CHAT_JID = 'tg:-100123:456';
  process.env.CLAUDECLAW_GROUP_FOLDER = 'telegram_guest-chat';
  process.env.CLAUDECLAW_IPC_DIR = '/tmp/ipc-mcp-stdio-test';
  delete process.env.CLAUDECLAW_GROUP_DIR;
  delete process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN;
  delete process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN;
  delete process.env.CLAUDECLAW_CODEX_GUI_CONTROL_AUTHORIZED;
  delete process.env.CLAUDECLAW_CODEX_CONTROL_RUN_ID;
  // HELPER_SECRET present so that, absent the gate, callHelper would attempt a
  // real fetch — letting the test prove the gate short-circuits before that.
  process.env.HELPER_SECRET = 'test-secret';
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  registeredTools.clear();
  vi.resetModules();
  setBaseEnv();
  fetchSpy = vi.fn(async () => {
    throw new Error('fetch must not be called for a denied guest');
  });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLAUDECLAW_IS_MAIN;
  delete process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN;
  delete process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN;
  delete process.env.CLAUDECLAW_CODEX_GUI_CONTROL_AUTHORIZED;
  delete process.env.CLAUDECLAW_CODEX_CONTROL_RUN_ID;
  delete process.env.CLAUDECLAW_GROUP_DIR;
  delete process.env.CLAUDECLAW_SKILLS_DIR;
  delete process.env.CLAUDECLAW_MEMORY_WRITE_CAPABILITY;
  delete process.env.CLAUDECLAW_MEMORY_PROVENANCE_PUBLIC_KEY;
  delete process.env.CLAUDECLAW_TENANT_ID;
  delete process.env.CLAUDECLAW_SENDER_ID;
  delete process.env.CLAUDECLAW_IDENTITY_ID;
  delete process.env.CLAUDECLAW_BOT_ID;
  delete process.env.CLAUDECLAW_PERSONA_ID;
  delete process.env.CLAUDECLAW_SHARED_USER_MEMORY_DIR;
  delete process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY;
});

describe('memory_save trusted provenance boundary', () => {
  it('queues only content hints and appends a host-signed identity-bound entry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-save-signed-'));
    const groupDir = path.join(root, 'group');
    const ipcDir = path.join(root, 'ipc');
    const memoryIpcDir = path.join(ipcDir, 'memory');
    fs.mkdirSync(path.join(groupDir, 'memory', 'topics'), {
      recursive: true,
    });
    fs.mkdirSync(memoryIpcDir, { recursive: true });
    const keys = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    process.env.CLAUDECLAW_GROUP_DIR = groupDir;
    process.env.CLAUDECLAW_IPC_DIR = ipcDir;
    process.env.CLAUDECLAW_CHAT_JID = 'tg:-100123';
    process.env.CLAUDECLAW_GROUP_FOLDER = 'telegram_guest-chat';
    process.env.CLAUDECLAW_IS_MAIN = '0';
    process.env.CLAUDECLAW_TENANT_ID = 'tenant_a';
    process.env.CLAUDECLAW_SENDER_ID = 'sender_a';
    process.env.CLAUDECLAW_IDENTITY_ID = 'identity_a';
    process.env.CLAUDECLAW_BOT_ID = 'bot_a';
    process.env.CLAUDECLAW_PERSONA_ID = 'persona_a';
    const capabilityId = 'm'.repeat(43);
    const capabilitySecret = Buffer.alloc(32, 0x5a).toString('base64url');
    process.env.CLAUDECLAW_MEMORY_WRITE_CAPABILITY = `${capabilityId}.${capabilitySecret}`;
    process.env.CLAUDECLAW_MEMORY_PROVENANCE_PUBLIC_KEY = keys.publicKey;

    try {
      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_save');
      expect(handler).toBeTypeOf('function');

      let observedRequest: Record<string, unknown> | undefined;
      let hostEnvelope = '';
      const responder = new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const poll = () => {
          try {
            const requestFile = fs
              .readdirSync(memoryIpcDir)
              .find((name) => name.endsWith('.request.json'));
            if (!requestFile) {
              if (Date.now() >= deadline) {
                reject(new Error('memory signing request not observed'));
                return;
              }
              setTimeout(poll, 10);
              return;
            }
            observedRequest = JSON.parse(
              fs.readFileSync(path.join(memoryIpcDir, requestFile), 'utf8'),
            ) as Record<string, unknown>;
            const requestId = String(observedRequest.request_id);
            const label = 'memory/topics/profile.md';
            const payload = {
              v: 1,
              entry_id: randomUUID(),
              scope: `group:telegram_guest-chat:${label}`,
              stamp: '2026-07-11 12:00:00',
              content: observedRequest.content,
              metadata: {
                source_type: 'user_message',
                confidence: 0.9,
                group_folder: 'telegram_guest-chat',
                chat_jid: 'tg:-100123',
                tenant_id: 'tenant_a',
                sender_id: 'sender_a',
                identity_id: 'identity_a',
                bot_id: 'bot_a',
                persona_id: 'persona_a',
                provenance: 'host_signed_identity',
              },
            };
            const payloadBytes = Buffer.from(JSON.stringify(payload));
            const envelope = `${payloadBytes.toString('base64url')}.${cryptoSign(null, payloadBytes, keys.privateKey).toString('base64url')}`;
            hostEnvelope = envelope;
            fs.writeFileSync(
              path.join(memoryIpcDir, `${requestId}.result.json`),
              JSON.stringify({
                type: 'memory_sign_result',
                request_id: requestId,
                ok: true,
                entries: [
                  {
                    target: 'group',
                    label,
                    entry_line: `- [${payload.stamp}] ${payload.content} <!-- skoobi_memory_v2=${envelope} -->\n`,
                  },
                ],
              }),
            );
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        poll();
      });

      const result = (await handler!({
        content: 'Likes concise answers',
        category: 'topic',
        topic: 'profile',
        source_type: 'user_message',
        confidence: 0.9,
        sender_id: 'ATTACKER_SELECTED_SENDER',
        tenant_id: 'ATTACKER_SELECTED_TENANT',
      })) as { isError?: boolean; content: { text: string }[] };
      await responder;

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('memory/topics/profile.md');
      expect(observedRequest).not.toHaveProperty('sender_id');
      expect(observedRequest).not.toHaveProperty('tenant_id');
      expect(observedRequest).not.toHaveProperty('capability');
      expect(observedRequest).toMatchObject({ capability_id: capabilityId });
      expect(observedRequest?.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(observedRequest)).not.toContain(capabilitySecret);
      const saved = fs.readFileSync(
        path.join(groupDir, 'memory', 'topics', 'profile.md'),
        'utf8',
      );
      expect(saved).toContain('Likes concise answers');
      expect(saved).toContain('skoobi_memory_v2=');
      expect(saved).not.toContain('ATTACKER_SELECTED_SENDER');
      expect(saved).not.toContain('ATTACKER_SELECTED_TENANT');

      const memoryFile = path.join(groupDir, 'memory', 'topics', 'profile.md');
      const [encodedPayload, originalSignature] = hostEnvelope.split('.');
      const changedPayload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      changedPayload.content = 'TAMPERED SIGNED PAYLOAD';
      const invalidChangedEnvelope = `${Buffer.from(JSON.stringify(changedPayload)).toString('base64url')}.${originalSignature}`;
      fs.appendFileSync(
        memoryFile,
        `- FORGED UNSIGNED DIRECT APPEND <!-- skoobi_memory_meta={"sender_id":"sender_a","tenant_id":"tenant_a"} -->\n` +
          `- CHANGED VISIBLE COPY <!-- skoobi_memory_v2=${hostEnvelope} -->\n` +
          `- TAMPERED SIGNED PAYLOAD <!-- skoobi_memory_v2=${invalidChangedEnvelope} -->\n`,
      );

      const getHandler = registeredTools.get('memory_get');
      const getResult = (await getHandler!({
        file: 'memory/topics/profile.md',
      })) as { content: { text: string }[] };
      expect(getResult.content[0].text).toContain('Likes concise answers');
      expect(
        getResult.content[0].text.match(/Likes concise answers/g),
      ).toHaveLength(1);
      expect(getResult.content[0].text).not.toContain('FORGED UNSIGNED');
      expect(getResult.content[0].text).not.toContain('CHANGED VISIBLE');
      expect(getResult.content[0].text).not.toContain('TAMPERED SIGNED');

      const searchHandler = registeredTools.get('memory_search');
      const forgedSearch = (await searchHandler!({
        query: 'FORGED UNSIGNED',
        max_results: 10,
      })) as { content: { text: string }[] };
      expect(forgedSearch.content[0].text).toMatch(/no matches found/i);
      const validSearch = (await searchHandler!({
        query: 'concise answers',
        max_results: 10,
      })) as { content: { text: string }[] };
      expect(validSearch.content[0].text).toContain('Likes concise answers');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for a guest when the host signer grant is absent', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'memory-save-nosigner-'),
    );
    process.env.CLAUDECLAW_GROUP_DIR = root;
    process.env.CLAUDECLAW_IS_MAIN = '0';
    try {
      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_save');
      const result = (await handler!({
        content: 'Unsigned fallback must not be saved',
        category: 'daily',
        source_type: 'manual',
        confidence: 0.7,
      })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/signer is unavailable/i);
      expect(fs.existsSync(path.join(root, 'memory'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the trusted main/owner local-save fallback during signer outages', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-save-main-'));
    process.env.CLAUDECLAW_GROUP_DIR = root;
    process.env.CLAUDECLAW_IS_MAIN = '1';
    try {
      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_save');
      const result = (await handler!({
        content: 'Owner operational preference',
        category: 'topic',
        topic: 'operations',
        source_type: 'manual',
        confidence: 0.8,
      })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('memory/topics/operations.md');
      expect(
        fs.readFileSync(
          path.join(root, 'memory', 'topics', 'operations.md'),
          'utf8',
        ),
      ).toContain('Owner operational preference');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('denyHostControlIfNotMain', () => {
  it('returns an isError deny result for guest groups', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '0';
    const mod = await import('./ipc-mcp-stdio.js');
    const denied = mod.denyHostControlIfNotMain(false);
    expect(denied).not.toBeNull();
    expect(denied?.isError).toBe(true);
    expect(denied?.content[0].text).toMatch(/main\/owner group/i);
  });

  it('returns null for the main group (allowed)', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    const mod = await import('./ipc-mcp-stdio.js');
    expect(mod.denyHostControlIfNotMain(true)).toBeNull();
  });
});

describe('computer_* tools are gated behind isMain', () => {
  it('denies every host-control tool for a guest chat without calling the helper', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '0';
    await import('./ipc-mcp-stdio.js');

    for (const name of COMPUTER_TOOLS) {
      const handler = registeredTools.get(name);
      expect(handler, `tool ${name} should be registered`).toBeTypeOf(
        'function',
      );
      const result = (await handler!(MINIMAL_ARGS[name])) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError, `${name} must be denied for guests`).toBe(true);
      expect(result.content[0].text).toMatch(/main\/owner group/i);
    }

    // The gate must short-circuit before any helper network call.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets the main group reach the helper (proxies past the gate)', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    // For main, the gate returns null and the handler proceeds to callHelper,
    // which performs a fetch. Stub a successful helper response.
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ path: '/tmp/shot.png', bytes: 1234 });
      },
    }));
    await import('./ipc-mcp-stdio.js');

    const handler = registeredTools.get('computer_screenshot');
    expect(handler).toBeTypeOf('function');
    const result = (await handler!({})) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      'X-Skoobi-Codex-Gui-Authorized',
    );
    expect(result.content[0].text).toMatch(/Screenshot saved/);
  });

  it('adds Codex GUI authorization only for the explicit direct owner run', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '1';
    process.env.CLAUDECLAW_CODEX_GUI_CONTROL_AUTHORIZED = '1';
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ path: '/tmp/shot.png', bytes: 1234 });
      },
    }));
    await import('./ipc-mcp-stdio.js');

    await registeredTools.get('computer_screenshot')!({});
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      'X-Skoobi-Codex-Gui-Authorized': '1',
    });
  });

  it('ignores a forged Codex GUI flag in a scheduled owner run', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '0';
    process.env.CLAUDECLAW_CODEX_GUI_CONTROL_AUTHORIZED = '1';
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ path: '/tmp/shot.png', bytes: 1234 });
      },
    }));
    await import('./ipc-mcp-stdio.js');

    await registeredTools.get('computer_screenshot')!({});
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      'X-Skoobi-Codex-Gui-Authorized',
    );
  });
});

describe('Codex Desktop tools are main-only', () => {
  it('does not register either bridge tool for a guest chat', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '0';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '1';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY = 'forged';
    await import('./ipc-mcp-stdio.js');

    for (const name of CODEX_DESKTOP_TOOLS) {
      expect(
        registeredTools.has(name),
        `${name} must be absent for guests`,
      ).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('registers both bridge tools for the trusted main group', async () => {
    const codexControlRunId = '00000000-0000-4000-8000-000000000002';
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '1';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY =
      'direct-owner-run-capability';
    process.env.CLAUDECLAW_CODEX_CONTROL_RUN_ID = codexControlRunId;
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ appServer: { running: true }, task: null });
      },
    }));
    await import('./ipc-mcp-stdio.js');

    for (const name of CODEX_DESKTOP_TOOLS) {
      expect(registeredTools.get(name)).toBeTypeOf('function');
    }
    const status = (await registeredTools.get('codex_desktop_status')!({
      action: 'status',
    })) as { isError?: boolean; content: { text: string }[] };
    expect(status.isError).toBeUndefined();
    expect(status.content[0].text).toContain('appServer');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      'X-Skoobi-Chat-Jid': process.env.CLAUDECLAW_CHAT_JID,
      'X-Skoobi-Codex-Control-Run-Id': codexControlRunId,
    });

    await registeredTools.get('codex_desktop_control')!({
      action: 'start',
      cwd: '/tmp/safe-project',
      prompt: 'safe test',
    });
    expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({
      'X-Skoobi-Codex-Control-Run-Id': codexControlRunId,
    });
  });

  it('surfaces safe bridge diagnostics and rejects unsafe raw detail', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '1';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY =
      'direct-owner-run-capability';
    process.env.CLAUDECLAW_CODEX_CONTROL_RUN_ID =
      '00000000-0000-4000-8000-000000000003';
    fetchSpy
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        async text() {
          return JSON.stringify({
            error: 'cwd_not_authorized',
            detail:
              'cwd is outside the authorized Codex Desktop project roots. Inspect status before retrying.',
          });
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        async text() {
          return JSON.stringify({
            error: 'codex_desktop_internal_error',
            detail:
              'SECRET_TOKEN=must-not-leak at /private/credentials/service.json',
          });
        },
      });
    await import('./ipc-mcp-stdio.js');

    const handler = registeredTools.get('codex_desktop_control');
    const publicFailure = (await handler!({
      action: 'start',
      cwd: '/outside',
      prompt: 'safe test',
    })) as { isError?: boolean; content: { text: string }[] };
    expect(publicFailure.isError).toBe(true);
    expect(publicFailure.content[0].text).toContain('cwd_not_authorized');
    expect(publicFailure.content[0].text).toContain(
      'Inspect status before retrying',
    );

    const internalFailure = (await handler!({
      action: 'open',
      thread_id: '00000000-0000-0000-0000-000000000000',
    })) as { isError?: boolean; content: { text: string }[] };
    expect(internalFailure.isError).toBe(true);
    expect(internalFailure.content[0].text).toContain(
      'codex_desktop_internal_error',
    );
    expect(internalFailure.content[0].text).not.toContain('SECRET_TOKEN');
    expect(internalFailure.content[0].text).not.toContain(
      '/private/credentials',
    );
  });

  it('keeps every bridge tool absent from a main-group guest run', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '0';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '1';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY = 'forged';
    await import('./ipc-mcp-stdio.js');

    expect(registeredTools.has('codex_desktop_status')).toBe(false);
    expect(registeredTools.has('codex_desktop_control')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps every bridge tool absent from a trusted scheduled owner run', async () => {
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IS_TRUSTED_OWNER_RUN = '1';
    process.env.CLAUDECLAW_IS_DIRECT_OWNER_RUN = '0';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY =
      'scheduled-owner-capability';
    await import('./ipc-mcp-stdio.js');

    expect(registeredTools.has('codex_desktop_status')).toBe(false);
    expect(registeredTools.has('codex_desktop_control')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('memory_search', () => {
  it('rejects oversized and hardlinked memory before get/search can read it', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-memory-bounds-'),
    );
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_CHAT_JID = 'tg:123';
      process.env.CLAUDECLAW_IS_MAIN = '1';
      const topics = path.join(root, 'memory', 'topics');
      fs.mkdirSync(topics, { recursive: true });
      const large = path.join(topics, 'large.md');
      fs.writeFileSync(large, 'OVERSIZED_MEMORY_MARKER');
      fs.truncateSync(large, 2 * 1024 * 1024 + 1);
      const original = path.join(root, 'original.md');
      fs.writeFileSync(original, 'HARDLINK_MEMORY_MARKER');
      fs.linkSync(original, path.join(topics, 'hardlink.md'));

      await import('./ipc-mcp-stdio.js');
      const getHandler = registeredTools.get('memory_get');
      for (const file of [
        'memory/topics/large.md',
        'memory/topics/hardlink.md',
      ]) {
        const result = (await getHandler!({ file })) as {
          content: { text: string }[];
        };
        expect(result.content[0].text).toBe('');
      }

      const searchHandler = registeredTools.get('memory_search');
      for (const query of [
        'OVERSIZED_MEMORY_MARKER',
        'HARDLINK_MEMORY_MARKER',
      ]) {
        const result = (await searchHandler!({ query, max_results: 5 })) as {
          content: { text: string }[];
        };
        expect(result.content[0].text).not.toContain(query);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for sender-less background reads in a multi-member chat', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-memory-background-'),
    );
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_CHAT_JID = 'tg:-100123';
      process.env.CLAUDECLAW_IS_MAIN = '0';
      fs.mkdirSync(path.join(root, 'memory', 'topics'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'memory', 'topics', 'other-member.md'),
        'OTHER_MEMBER_PRIVATE_MARKER',
      );

      await import('./ipc-mcp-stdio.js');
      const getHandler = registeredTools.get('memory_get');
      const getResult = (await getHandler!({
        file: 'memory/topics/other-member.md',
      })) as { content: { text: string }[] };
      expect(getResult.content[0].text).toBe('');

      const searchHandler = registeredTools.get('memory_search');
      const searchResult = (await searchHandler!({
        query: 'OTHER_MEMBER_PRIVATE_MARKER',
        max_results: 5,
      })) as { content: { text: string }[] };
      expect(searchResult.content[0].text).toMatch(/no matches found/i);
      expect(searchResult.content[0].text).not.toContain('other-member.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses SQLite FTS5/BM25 when the local index is available', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-fts-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      fs.mkdirSync(path.join(root, 'memory', 'topics'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'memory', 'topics', 'suppliers.md'),
        'Fixture City: библиотека Example хранит книги и журналы.',
      );

      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_search');
      expect(handler).toBeTypeOf('function');
      const result = (await handler!({
        query: 'библиотека Fixture City',
        max_results: 5,
      })) as { content: { text: string }[] };

      expect(result.content[0].text).toContain('SQLite FTS5/BM25');
      expect(result.content[0].text).toContain('memory/topics/suppliers.md');
      expect(result.content[0].text).toContain('библиотека');
      expect(
        fs.existsSync(path.join(root, '.skoobi', 'memory-search.sqlite')),
      ).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to grep when the SQLite index path is broken', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-memory-grep-'));
    try {
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IS_MAIN = '1';
      fs.mkdirSync(path.join(root, 'memory', 'topics'), { recursive: true });
      fs.writeFileSync(path.join(root, '.skoobi'), 'not a directory');
      fs.writeFileSync(
        path.join(root, 'memory', 'topics', 'fallback.md'),
        'Fallback search should find this rare-keyword line.',
      );

      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('memory_search');
      expect(handler).toBeTypeOf('function');
      const result = (await handler!({
        query: 'rare-keyword',
        max_results: 5,
      })) as { content: { text: string }[] };

      expect(result.content[0].text).toContain('grep fallback');
      expect(result.content[0].text).toContain('memory/topics/fallback.md');
      expect(result.content[0].text).toContain('rare-keyword');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('owner send exact-authorization boundary', () => {
  it('uses PoP without serializing the secret and queues only the returned exact grant', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-send-auth-'));
    const ipcDir = path.join(root, 'ipc');
    const memoryDir = path.join(ipcDir, 'memory');
    const messagesDir = path.join(ipcDir, 'messages');
    const reportPath = path.join(root, 'owner-report.pdf');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(reportPath, 'OWNER_REPORT');
    const capabilityId = 't'.repeat(22);
    const capabilitySecret = Buffer.alloc(32, 0x6b).toString('base64url');
    process.env.CLAUDECLAW_IS_MAIN = '1';
    process.env.CLAUDECLAW_IPC_DIR = ipcDir;
    process.env.CLAUDECLAW_CHAT_JID = 'tg:100000001';
    process.env.CLAUDECLAW_GROUP_FOLDER = 'telegram_main';
    process.env.CLAUDECLAW_TASK_AUTHORIZATION_CAPABILITY = `${capabilityId}.${capabilitySecret}`;

    try {
      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('send_document');
      expect(handler).toBeTypeOf('function');

      let observedRequest: Record<string, unknown> | undefined;
      const exactGrant = 'g'.repeat(43);
      const responder = new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const poll = () => {
          try {
            const requestFile = fs
              .readdirSync(memoryDir)
              .find((name) => name.endsWith('.request.json'));
            if (!requestFile) {
              if (Date.now() >= deadline) {
                reject(new Error('task authorization request not observed'));
                return;
              }
              setTimeout(poll, 10);
              return;
            }
            observedRequest = JSON.parse(
              fs.readFileSync(path.join(memoryDir, requestFile), 'utf8'),
            ) as Record<string, unknown>;
            const requestId = String(observedRequest.request_id);
            const proofPayload = {
              type: observedRequest.type,
              request_id: observedRequest.request_id,
              action: observedRequest.action,
              sealed_envelope: observedRequest.sealed_envelope,
            };
            expect(observedRequest).toMatchObject({
              type: 'task_authorize',
              action: 'document',
              capability_id: capabilityId,
            });
            expect(observedRequest).not.toHaveProperty('capability');
            expect(observedRequest).not.toHaveProperty('envelope');
            expect(observedRequest.sealed_envelope).toMatchObject({
              v: 1,
              alg: 'A256GCM',
            });
            expect(JSON.stringify(observedRequest)).not.toContain(
              fs.realpathSync(reportPath),
            );
            expect(JSON.stringify(observedRequest)).not.toContain(
              'owner report',
            );
            expect(JSON.stringify(observedRequest)).not.toContain(
              capabilitySecret,
            );
            expect(observedRequest.proof).toBe(
              createHmac('sha256', capabilitySecret)
                .update(JSON.stringify(proofPayload))
                .digest('base64url'),
            );
            expect(
              openTaskAuthorizationEnvelopeForTest(
                observedRequest,
                capabilitySecret,
              ),
            ).toMatchObject({
              type: 'document',
              chatJid: 'tg:100000001',
              filePath: fs.realpathSync(reportPath),
              caption: 'owner report',
            });
            fs.writeFileSync(
              path.join(memoryDir, `${requestId}.result.json`),
              JSON.stringify({
                type: 'task_authorize_result',
                request_id: requestId,
                ok: true,
                grant: exactGrant,
              }),
            );
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        poll();
      });

      const result = (await handler!({
        filePath: fs.realpathSync(reportPath),
        caption: 'owner report',
      })) as { isError?: boolean; content: { text: string }[] };
      await responder;

      expect(result.isError).toBeUndefined();
      const queuedFiles = fs
        .readdirSync(messagesDir)
        .filter((name) => name.endsWith('.json'));
      expect(queuedFiles).toHaveLength(1);
      const queued = JSON.parse(
        fs.readFileSync(path.join(messagesDir, queuedFiles[0]), 'utf8'),
      ) as Record<string, unknown>;
      expect(queued).toMatchObject({
        type: 'document',
        chatJid: 'tg:100000001',
        filePath: fs.realpathSync(reportPath),
        caption: 'owner report',
        ownerAuthorizationGrant: exactGrant,
      });
      expect(JSON.stringify(queued)).not.toContain(capabilitySecret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bounded same-fd IPC response reads', () => {
  it('reads exact regular files at the task and memory limits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-ipc-response-'));
    try {
      const { readBoundedIpcResponseFile } = await import('./ipc-mcp-stdio.js');
      const taskResponse = path.join(root, 'task.result.json');
      const taskData = Buffer.from('{"ok":true}');
      fs.writeFileSync(taskResponse, taskData);
      expect(readBoundedIpcResponseFile(taskResponse, 64 * 1024)).toEqual(
        taskData,
      );

      const memoryResponse = path.join(root, 'memory.result.json');
      fs.writeFileSync(memoryResponse, Buffer.alloc(2 * 1024 * 1024, 0x61));
      expect(
        readBoundedIpcResponseFile(memoryResponse, 2 * 1024 * 1024),
      ).toHaveLength(2 * 1024 * 1024);
      fs.appendFileSync(memoryResponse, 'x');
      expect(() =>
        readBoundedIpcResponseFile(memoryResponse, 2 * 1024 * 1024),
      ).toThrow(/oversized/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinks, hardlinks, and FIFOs without blocking', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-ipc-unsafe-'));
    try {
      const { readBoundedIpcResponseFile } = await import('./ipc-mcp-stdio.js');
      const target = path.join(root, 'target.json');
      fs.writeFileSync(target, '{"ok":true}');

      const symlink = path.join(root, 'symlink.result.json');
      fs.symlinkSync(target, symlink);
      expect(() => readBoundedIpcResponseFile(symlink, 64 * 1024)).toThrow(
        /safe regular file/i,
      );

      const hardlink = path.join(root, 'hardlink.result.json');
      fs.linkSync(target, hardlink);
      expect(() => readBoundedIpcResponseFile(hardlink, 64 * 1024)).toThrow(
        /unsafe/i,
      );

      const fifo = path.join(root, 'fifo.result.json');
      execFileSync('mkfifo', [fifo]);
      const started = Date.now();
      expect(() => readBoundedIpcResponseFile(fifo, 64 * 1024)).toThrow(
        /unsafe/i,
      );
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('send_voice_message input-size cap (finding #14)', () => {
  it('rejects oversized text before writing an IPC voice envelope', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-voice-cap-'));
    try {
      process.env.CLAUDECLAW_IS_MAIN = '0';
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('send_voice_message');
      expect(handler).toBeTypeOf('function');

      // 12001 chars is one over the cap → fan-out abuse, must be rejected.
      const result = (await handler!({ text: 'a'.repeat(12001) })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/too long/i);

      // No voice envelope should have been enqueued for the rejected call.
      const messagesDir = path.join(ipcDir, 'messages');
      const enqueued = fs.existsSync(messagesDir)
        ? fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'))
        : [];
      expect(enqueued).toHaveLength(0);
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });

  it('accepts text at the cap and enqueues a voice envelope', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-voice-ok-'));
    try {
      process.env.CLAUDECLAW_IS_MAIN = '0';
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      await import('./ipc-mcp-stdio.js');
      const handler = registeredTools.get('send_voice_message');
      expect(handler).toBeTypeOf('function');

      const result = (await handler!({ text: 'a'.repeat(12000) })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toMatch(/queued for delivery/i);

      const messages = fs
        .readdirSync(path.join(ipcDir, 'messages'))
        .filter((f) => f.endsWith('.json'));
      expect(messages).toHaveLength(1);
      const envelope = JSON.parse(
        fs.readFileSync(path.join(ipcDir, 'messages', messages[0]), 'utf8'),
      );
      expect(envelope.type).toBe('voice');
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });
});

describe('send_photo/send_document sensitive-file blocklist (finding #35)', () => {
  it('denies a guest sending a credential file from its own workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-send-deny-'));
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-send-ipc-'));
    try {
      process.env.CLAUDECLAW_IS_MAIN = '0';
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      // A real credential-bearing file inside the guest's own workspace.
      fs.writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=sk-secret');

      await import('./ipc-mcp-stdio.js');
      const sendPhoto = registeredTools.get('send_photo');
      expect(sendPhoto).toBeTypeOf('function');

      const result = (await sendPhoto!({ filePath: '.env' })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/credential or key files/i);

      // Nothing should have been queued for delivery.
      const messagesDir = path.join(ipcDir, 'messages');
      const enqueued = fs.existsSync(messagesDir)
        ? fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'))
        : [];
      expect(enqueued).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });

  it('still allows a guest to send a normal image from its workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-send-ok-'));
    const ipcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-send-ok-ipc-'),
    );
    try {
      process.env.CLAUDECLAW_IS_MAIN = '0';
      process.env.CLAUDECLAW_GROUP_DIR = root;
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      fs.mkdirSync(path.join(root, 'output'), { recursive: true });
      fs.writeFileSync(path.join(root, 'output', 'chart.png'), 'PNGDATA');

      await import('./ipc-mcp-stdio.js');
      const sendPhoto = registeredTools.get('send_photo');
      expect(sendPhoto).toBeTypeOf('function');

      const result = (await sendPhoto!({
        filePath: 'output/chart.png',
      })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toMatch(/queued for delivery/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });
});

describe('skill_* tools', () => {
  it('lists and views active skills without loading drafts by default', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-runner-skills-'),
    );
    try {
      process.env.CLAUDECLAW_SKILLS_DIR = root;
      fs.mkdirSync(path.join(root, 'web-search-workflow'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(root, 'web-search-workflow', 'SKILL.md'),
        [
          '---',
          'name: web-search-workflow',
          'description: Search workflow.',
          'status: active',
          'created_by: operator',
          'triggers: ["найди"]',
          '---',
          '',
          'Use SearchGateway.',
        ].join('\n'),
      );
      fs.mkdirSync(path.join(root, 'draft-skill'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'draft-skill', 'SKILL.md'),
        [
          '---',
          'name: draft-skill',
          'description: Draft.',
          'status: draft',
          'created_by: agent_proposal',
          '---',
          '',
          'Draft body.',
        ].join('\n'),
      );

      await import('./ipc-mcp-stdio.js');
      const list = registeredTools.get('skill_list');
      const view = registeredTools.get('skill_view');
      expect(list).toBeTypeOf('function');
      expect(view).toBeTypeOf('function');

      const listResult = (await list!({})) as { content: { text: string }[] };
      expect(listResult.content[0].text).toContain('web-search-workflow');
      expect(listResult.content[0].text).not.toContain('draft-skill');

      const viewResult = (await view!({
        name: 'web-search-workflow',
      })) as { content: { text: string }[] };
      expect(viewResult.content[0].text).toContain('Use SearchGateway.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unsafe skill names and secret-looking proposals', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-runner-skill-deny-'),
    );
    try {
      process.env.CLAUDECLAW_SKILLS_DIR = root;
      await import('./ipc-mcp-stdio.js');
      const view = registeredTools.get('skill_view');
      const propose = registeredTools.get('skill_propose');
      expect(view).toBeTypeOf('function');
      expect(propose).toBeTypeOf('function');

      const unsafe = (await view!({ name: '../escape' })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(unsafe.isError).toBe(true);

      const secret = (await propose!({
        name: 'bad-skill',
        description: 'bad',
        body: 'OPENAI_API_KEY=sk-test-secret',
      })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(secret.isError).toBe(true);
      expect(secret.content[0].text).toMatch(/credential|secret/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes skill proposals to the host over IPC (never writes the active skills dir)', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-runner-skill-propose-'),
    );
    const ipcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'skoobi-runner-skill-ipc-'),
    );
    try {
      // Skills dir is mounted READ-ONLY for guests; the proposal must NOT be
      // written to it directly — it is enqueued as an IPC 'propose_skill' task
      // for the host to validate and write into `.proposals`.
      process.env.CLAUDECLAW_SKILLS_DIR = root;
      process.env.CLAUDECLAW_IPC_DIR = ipcDir;
      await import('./ipc-mcp-stdio.js');
      const propose = registeredTools.get('skill_propose');
      const list = registeredTools.get('skill_list');
      expect(propose).toBeTypeOf('function');
      expect(list).toBeTypeOf('function');

      const proposed = (await propose!({
        name: 'repeatable-check',
        description: 'A repeatable check.',
        body: '# Repeatable Check\n\n1. Inspect.\n2. Verify.',
        tags: ['ops'],
        triggers: ['проверка'],
      })) as { content: { text: string }[] };
      expect(proposed.content[0].text).toMatch(
        /submitted for operator review/i,
      );

      // No direct write into the (read-only) skills dir.
      expect(
        fs.existsSync(
          path.join(root, '.proposals', 'repeatable-check', 'SKILL.md'),
        ),
      ).toBe(false);

      // Exactly one IPC task envelope of type 'propose_skill' was enqueued.
      const taskFiles = fs
        .readdirSync(path.join(ipcDir, 'tasks'))
        .filter((f) => f.endsWith('.json'));
      expect(taskFiles).toHaveLength(1);
      const envelope = JSON.parse(
        fs.readFileSync(path.join(ipcDir, 'tasks', taskFiles[0]), 'utf8'),
      );
      expect(envelope.type).toBe('propose_skill');
      expect(envelope.name).toBe('repeatable-check');
      expect(envelope.body).toContain('Repeatable Check');
      expect(envelope.tags).toEqual(['ops']);

      const activeList = (await list!({})) as { content: { text: string }[] };
      expect(activeList.content[0].text).not.toContain('repeatable-check');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Server-side tool lockout (CLAUDECLAW_DISALLOWED_TOOLS). The Claude SDK
// enforces disallowedTools client-side; alternate-provider runs (codex
// reserve) rely on the server not registering the tool at all.
// ---------------------------------------------------------------------------
describe('CLAUDECLAW_DISALLOWED_TOOLS server-side lockout', () => {
  it('parses bare, prefixed and wildcard entries', async () => {
    const { parseDisallowedTools } = await import('./ipc-mcp-stdio.js');
    const parsed = parseDisallowedTools(
      'mcp__claudeclaw__memory_save, memory_search,, *',
    );
    expect(parsed.has('memory_save')).toBe(true);
    expect(parsed.has('memory_search')).toBe(true);
    expect(parsed.has('*')).toBe(true);
    expect(parseDisallowedTools(undefined).size).toBe(0);
  });

  it('does not register disallowed tools (fresh import with env set)', async () => {
    const prev = process.env.CLAUDECLAW_DISALLOWED_TOOLS;
    try {
      vi.resetModules();
      registeredTools.clear();
      process.env.CLAUDECLAW_DISALLOWED_TOOLS =
        'mcp__claudeclaw__memory_save,memory_search';
      await import('./ipc-mcp-stdio.js');
      expect(registeredTools.has('memory_save')).toBe(false);
      expect(registeredTools.has('memory_search')).toBe(false);
      // Non-disallowed tools still register.
      expect(registeredTools.has('send_message')).toBe(true);
      expect(registeredTools.has('memory_get')).toBe(true);
    } finally {
      // Restore the full registration set for any later tests.
      if (prev !== undefined) process.env.CLAUDECLAW_DISALLOWED_TOOLS = prev;
      else delete process.env.CLAUDECLAW_DISALLOWED_TOOLS;
      vi.resetModules();
      registeredTools.clear();
      await import('./ipc-mcp-stdio.js');
    }
  });
});

describe('Google Workspace per-turn server-side allowlist', () => {
  it('parses only closed public tool names', async () => {
    const { parseAllowedGoogleTools, parseGoogleSheetTargetHints } =
      await import('./ipc-mcp-stdio.js');
    expect(
      [
        ...parseAllowedGoogleTools(
          'google_docs_read,mcp__claudeclaw__google_calendar_list_events,gmail_search_threads,google_sheets_append_values,google_drive_delete',
        ),
      ].sort(),
    ).toEqual([
      'gmail_search_threads',
      'google_calendar_list_events',
      'google_docs_read',
      'google_sheets_append_values',
    ]);
    expect(parseAllowedGoogleTools(undefined).size).toBe(0);

    const exactHint = {
      label: 'ledger',
      spreadsheetId: 'public-fixture-spreadsheet-id-0001',
      range: "'Ledger'!A2:G1000",
      columnCount: 7,
      maxRowsPerCall: 1,
    };
    expect(parseGoogleSheetTargetHints(JSON.stringify([exactHint]))).toEqual([
      exactHint,
    ]);
    expect(
      parseGoogleSheetTargetHints(
        JSON.stringify([{ ...exactHint, maxRowsPerCall: 2 }]),
      ),
    ).toEqual([]);
    expect(
      parseGoogleSheetTargetHints(
        JSON.stringify([{ ...exactHint, credential: 'must-not-pass' }]),
      ),
    ).toEqual([]);
  });

  it('registers exactly the host-published Google wrappers', async () => {
    const previousAllowed = process.env.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS;
    const previousDisallowed = process.env.CLAUDECLAW_DISALLOWED_TOOLS;
    try {
      vi.resetModules();
      registeredTools.clear();
      process.env.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS =
        'google_docs_read,gmail_search_threads';
      delete process.env.CLAUDECLAW_DISALLOWED_TOOLS;
      await import('./ipc-mcp-stdio.js');
      expect(registeredTools.has('google_docs_read')).toBe(true);
      expect(registeredTools.has('gmail_search_threads')).toBe(true);
      expect(registeredTools.has('gmail_get_thread')).toBe(false);
      expect(registeredTools.has('google_docs_replace_content')).toBe(false);
      expect(registeredTools.has('google_workspace_status')).toBe(false);
    } finally {
      if (previousAllowed === undefined) {
        delete process.env.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS;
      } else {
        process.env.CLAUDECLAW_GOOGLE_ALLOWED_TOOLS = previousAllowed;
      }
      if (previousDisallowed === undefined) {
        delete process.env.CLAUDECLAW_DISALLOWED_TOOLS;
      } else {
        process.env.CLAUDECLAW_DISALLOWED_TOOLS = previousDisallowed;
      }
      vi.resetModules();
      registeredTools.clear();
      await import('./ipc-mcp-stdio.js');
    }
  });
});
