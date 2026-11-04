import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _initTestDatabase,
  getDb,
  storeChatMetadata,
  storeMessage,
} from '../packages/core/src/orchestrator/db.js';
import {
  _clearMemoryWriteCapabilities,
  registerMemoryWriteCapability,
} from '../packages/core/src/orchestrator/memory-provenance.js';
import {
  ensureMemoryStateSchema,
  mutateMemoryState,
} from '../packages/core/src/orchestrator/memory-state-store.js';
import { handleMemoryStateWireRequest } from '../packages/core/src/orchestrator/memory-state-service.js';

const handlers = new Map<
  string,
  (
    args: unknown,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
>();
vi.mock(
  '../agent/runner/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js',
  () => ({
    McpServer: class {
      tool(...args: unknown[]) {
        handlers.set(args[0] as string, args.at(-1) as never);
        return {};
      }
      async connect() {}
    },
  }),
);
vi.mock(
  '../agent/runner/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',
  () => ({
    StdioServerTransport: class {},
  }),
);
let root: string;
let cap: string;
const envKeys = [
  'CLAUDECLAW_IPC_DIR',
  'CLAUDECLAW_GROUP_FOLDER',
  'CLAUDECLAW_CHAT_JID',
  'CLAUDECLAW_MEMORY_WRITE_CAPABILITY',
  'CLAUDECLAW_DISALLOWED_TOOLS',
];
const savedEnv = new Map<string, string | undefined>();
beforeEach(() => {
  vi.resetModules();
  handlers.clear();
  _initTestDatabase();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-mcp-'));
  const identity = {
    channel: 'telegram' as const,
    chat_id: '101',
    telegram_user_id: '101',
    identity_id: 'identity-a',
    telegram_message_origin: 'direct' as const,
    is_owner_sender: true,
  };
  storeChatMetadata('tg:101', '2026-10-01T00:00:00.000Z');
  storeMessage({
    id: '10',
    chat_jid: 'tg:101',
    sender: '101',
    sender_name: 'Test',
    content: 'Я предпочитаю чай.',
    timestamp: '2026-10-01T00:00:00.000Z',
    sender_identity: identity,
  });
  cap = registerMemoryWriteCapability(
    {
      groupFolder: 'test-memory-main',
      chatJid: 'tg:101',
      isMain: true,
      tenantId: 'tenant-a',
      senderIdentity: identity,
      memoryWriteAllowed: true,
      currentMessageIds: ['10'],
    },
    path.join(root, 'data'),
  ).capability;
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
  process.env.CLAUDECLAW_IPC_DIR = path.join(root, 'ipc');
  process.env.CLAUDECLAW_GROUP_FOLDER = 'test-memory-main';
  process.env.CLAUDECLAW_CHAT_JID = 'tg:101';
  process.env.CLAUDECLAW_MEMORY_WRITE_CAPABILITY = cap;
  delete process.env.CLAUDECLAW_DISALLOWED_TOOLS;
});
afterEach(() => {
  _clearMemoryWriteCapabilities();
  getDb().close();
  fs.rmSync(root, { recursive: true, force: true });
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
async function respond(
  tamper: false | true | 'request' | 'wrong-cap' | 'delete' = false,
): Promise<Record<string, unknown>> {
  const dir = path.join(root, 'ipc', 'memory');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const file =
      fs.existsSync(dir) &&
      fs.readdirSync(dir).find((name) => name.endsWith('.request.json'));
    if (file) {
      const request = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (tamper === 'request') request.sealed_payload.tag = 'A'.repeat(22);
      if (tamper === 'wrong-cap') request.capability_id = 'x'.repeat(43);
      const response = handleMemoryStateWireRequest(
        request,
        'test-memory-main',
      );
      if (response.sealed_payload) {
        expect(JSON.stringify(response)).not.toContain('Чай');
        expect(JSON.stringify(response)).not.toContain('предпочитаю');
      }
      if (!tamper) expect(typeof response.ok).toBe('boolean'); // host IPC sees status without decrypting content
      if (tamper === true)
        (response.sealed_payload as { tag: string }).tag = 'A'.repeat(22);
      if (tamper !== 'delete')
        fs.writeFileSync(
          path.join(dir, `${request.request_id}.result.json`),
          JSON.stringify(response),
        );
      fs.unlinkSync(path.join(dir, file));
      return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('No structured-memory IPC request observed');
}
describe('real MCP to authenticated structured-memory service', () => {
  it('round-trips typed project observations and requested comparison over sealed IPC without mutating on read', async () => {
    const db = getDb();
    ensureMemoryStateSchema(db);
    const scope = {
      chatJid: 'tg:101',
      identityId: 'identity-a',
      tenantId: 'tenant-a',
    };
    for (const projectKey of ['alpha', 'beta'])
      mutateMemoryState(
        db,
        scope,
        {
          kind: 'project_upsert',
          operationId: `seed-${projectKey}`,
          expectedRevision: 0,
          projectKey,
          card: {
            title: `Project ${projectKey}`,
            goal: 'Synthetic goal',
            status: 'active',
            pending: [],
            completed: [],
            waiting: null,
            artifacts: [],
          },
        },
        { kind: 'assistant_report', at: '2026-10-01T00:00:00.000Z' },
      );
    await import('../agent/runner/src/ipc-mcp-stdio.js');
    const pending = handlers.get('memory_state')!({
      operation: {
        kind: 'fact_upsert',
        operationId: 'typed-project-benefit',
        expectedRevision: 0,
        projectKey: 'alpha',
        key: 'benefit',
        value: 'Synthetic expected benefit',
        detail: {
          kind: 'project_value',
          category: 'expected_benefit',
          basis: 'expectation',
        },
      },
      source: { kind: 'assistant_report' },
    });
    const request = await respond();
    expect(JSON.stringify(request)).not.toContain('Synthetic expected benefit');
    expect(await pending).not.toHaveProperty('isError', true);
    const before = db.serialize();
    const reading = handlers.get('memory_state_read')!({
      action: 'compare_projects',
      projectKeys: ['alpha', 'beta'],
    });
    const readRequest = await respond();
    expect(readRequest).not.toHaveProperty('payload');
    const result = await reading;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: true,
      data: {
        kind: 'project_comparison',
        readOnly: true,
        projects: [
          {
            projectKey: 'alpha',
            observations: [
              { category: 'expected_benefit', basis: 'expectation' },
            ],
          },
          { projectKey: 'beta', observations: [] },
        ],
      },
    });
    expect(db.serialize()).toEqual(before);
  });

  it('round-trips mutation and read without serializing the capability secret', async () => {
    await import('../agent/runner/src/ipc-mcp-stdio.js');
    const write = handlers.get('memory_state')!({
      operation: {
        kind: 'fact_upsert',
        operationId: 'tea-preference',
        expectedRevision: 0,
        projectKey: null,
        key: 'drink',
        value: 'Чай',
      },
      source: {
        kind: 'direct_user',
        messageId: '10',
        quote: 'Я предпочитаю чай.',
      },
    });
    const request = await respond();
    expect(JSON.stringify(request)).not.toContain(cap.split('.')[1]);
    expect(JSON.stringify(request)).not.toContain('предпочитаю');
    expect(request).not.toHaveProperty('payload');
    expect(request).toHaveProperty('sealed_payload');
    expect(await write).not.toHaveProperty('isError', true);
    const read = handlers.get('memory_state_read')!({ action: 'list' });
    await respond();
    const result = await read;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: true,
      data: { facts: [{ value: 'Чай' }] },
    });
  });
  it('rejects a tampered host response instead of presenting forged memory', async () => {
    await import('../agent/runner/src/ipc-mcp-stdio.js');
    const read = handlers.get('memory_state_read')!({ action: 'list' });
    await respond(true);
    expect(await read).toMatchObject({
      isError: true,
      content: [{ text: 'Unauthenticated structured memory response.' }],
    });
  });
  it.each(['request', 'wrong-cap'] as const)(
    'rejects changed encrypted request or capability: %s',
    async (tamper) => {
      await import('../agent/runner/src/ipc-mcp-stdio.js');
      const read = handlers.get('memory_state_read')!({ action: 'list' });
      await respond(tamper);
      expect(await read).toMatchObject({ isError: true });
    },
  );
  it('cleans up timed-out requests and handles a deleted response without exposing plaintext', async () => {
    const module = await import('../agent/runner/src/ipc-mcp-stdio.js');
    const timedOut = module.requestHostMemoryState({ action: 'list' }, 80);
    await respond('delete');
    expect(await timedOut).toMatchObject({ isError: true });
    expect(fs.readdirSync(path.join(root, 'ipc', 'memory'))).toEqual([]);
    expect(
      await module.requestHostMemoryState({ action: 'list' }, 1),
    ).toMatchObject({ isError: true });
    expect(fs.readdirSync(path.join(root, 'ipc', 'memory'))).toEqual([]);
  });
  it('reads more than 128KiB over encrypted pages and rejects a cursor from another namespace', async () => {
    const db = getDb();
    ensureMemoryStateSchema(db);
    const scope = {
      chatJid: 'tg:101',
      identityId: 'identity-a',
      tenantId: 'tenant-a',
    };
    for (let index = 0; index < 35; index++)
      mutateMemoryState(
        db,
        scope,
        {
          kind: 'fact_upsert',
          operationId: `wire-page-${index}`,
          expectedRevision: 0,
          projectKey: null,
          key: `item-${String(index).padStart(3, '0')}`,
          value: 'Ж'.repeat(4000),
        },
        { kind: 'assistant_report', at: '2026-10-01T00:00:00.000Z' },
      );
    await import('../agent/runner/src/ipc-mcp-stdio.js');
    let cursor: string | undefined, firstCursor: string | undefined;
    const seen: string[] = [];
    let pages = 0;
    do {
      const pending = handlers.get('memory_state_read')!({
        action: 'list',
        pageSize: 100,
        ...(cursor ? { cursor } : {}),
      });
      await respond();
      const result = await pending;
      expect(result.isError).not.toBe(true);
      const data = JSON.parse(result.content[0].text).data;
      expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(
        96 * 1024,
      );
      seen.push(...data.facts.map((row: { key: string }) => row.key));
      cursor = data.nextCursor ?? undefined;
      firstCursor ??= cursor;
      pages++;
    } while (cursor && pages < 20);
    expect(seen).toHaveLength(35);
    expect(new Set(seen).size).toBe(35);
    expect(pages).toBeGreaterThan(1);
    const mismatch = handlers.get('memory_state_read')!({
      action: 'list',
      projectKey: null,
      cursor: firstCursor,
    });
    await respond();
    expect(JSON.parse((await mismatch).content[0].text)).toMatchObject({
      ok: false,
      error: 'invalid_cursor_scope',
    });
  });
  it('honors quarantined tool names and rejects a missing capability', async () => {
    process.env.CLAUDECLAW_DISALLOWED_TOOLS = 'memory_state,memory_state_read';
    await import('../agent/runner/src/ipc-mcp-stdio.js');
    expect(handlers.has('memory_state')).toBe(false);
    expect(handlers.has('memory_state_read')).toBe(false);
    vi.resetModules();
    handlers.clear();
    delete process.env.CLAUDECLAW_DISALLOWED_TOOLS;
    delete process.env.CLAUDECLAW_MEMORY_WRITE_CAPABILITY;
    await import('../agent/runner/src/ipc-mcp-stdio.js');
    expect(
      await handlers.get('memory_state_read')!({ action: 'list' }),
    ).toMatchObject({ isError: true });
    expect(fs.existsSync(path.join(root, 'ipc', 'memory'))).toBe(false);
  });
});
