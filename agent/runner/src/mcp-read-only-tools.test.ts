import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import {
  READ_ONLY_CLAUDECLAW_TOOLS,
  withReadOnlyToolHint,
} from './mcp-read-only-tools.js';

describe('readOnlyHint for the reading claudeclaw tools (W15)', () => {
  it('lists the reading tools and nothing that sends, saves or drives the Mac', () => {
    expect([...READ_ONLY_CLAUDECLAW_TOOLS].sort()).toEqual([
      'chat_history',
      'check_user_updates',
      'codex_quota_status',
      'delivery_status',
      'list_tasks',
      'memory_get',
      'memory_search',
      'memory_state_read',
      'skill_list',
      'skill_view',
      'wait_until',
    ]);
    for (const name of READ_ONLY_CLAUDECLAW_TOOLS) {
      expect(name).not.toMatch(
        /send|save|schedule|cancel|update_task|computer|codex_desktop|google|gmail/,
      );
    }
  });

  it('reaches the MCP client through the real SDK, also for an empty schema', async () => {
    const server = new McpServer({ name: 'claudeclaw-test', version: '1.0.0' });
    const register = (...args: unknown[]) =>
      (server.tool as unknown as (...a: unknown[]) => unknown)(
        ...withReadOnlyToolHint(args),
      );
    const text = () => ({ content: [{ type: 'text' as const, text: 'ok' }] });
    register('memory_search', 'Search memory', { query: z.string() }, text);
    register('check_user_updates', 'Read new input', {}, text);
    register('send_message', 'Send a message', { text: z.string() }, text);

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'probe', version: '1.0.0' });
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      expect(byName.get('memory_search')?.annotations).toEqual({
        readOnlyHint: true,
      });
      expect(byName.get('check_user_updates')?.annotations).toEqual({
        readOnlyHint: true,
      });
      expect(byName.get('send_message')?.annotations).toBeUndefined();
      // The schema survives the extra argument.
      expect(
        byName.get('memory_search')?.inputSchema.properties,
      ).toHaveProperty('query');
      const called = await client.callTool({
        name: 'memory_search',
        arguments: { query: 'x' },
      });
      expect(called.content).toEqual([{ type: 'text', text: 'ok' }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('leaves any other call shape untouched', () => {
    const handler = () => undefined;
    const plain = ['send_message', 'Send', {}, handler];
    expect(withReadOnlyToolHint(plain)).toBe(plain);
    const already = ['memory_get', 'Read', {}, { readOnlyHint: true }, handler];
    expect(withReadOnlyToolHint(already)).toBe(already);
  });
});
