import type http from 'http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DialogHistoryInputError } from './dialog-history.js';
import {
  createDashboardServer,
  isDashboardChatJid,
  tokenMatches,
} from './server.js';

const TOKEN = 'dashboard-test-token-123';
const servers: http.Server[] = [];

function dialogAnchor(jid = 'tg:123456789', id = 'message-42'): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      source: jid.startsWith('tg:') ? 'telegram' : 'whatsapp',
      jid,
      timestamp: '2026-07-15T10:00:00.000Z',
      id,
    }),
    'utf8',
  ).toString('base64url');
}

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function overview(enabled = true) {
  return {
    workspace: {
      enabled,
      configured: enabled,
      missing: [],
      scopesHuman: [],
      defaultScriptId: null,
      crm: null,
    },
    calendar: {
      enabled,
      configured: enabled,
      calendarId: enabled ? 'primary' : null,
      timezone: 'Asia/Almaty',
      keyFileFound: enabled,
      mirroredTasks: 0,
    },
  };
}

describe('tokenMatches (вход в панель)', () => {
  it('пустой/отсутствующий токен никогда не проходит', () => {
    expect(tokenMatches(null, 'anything')).toBe(false);
    expect(tokenMatches('expected-token-16chars', null)).toBe(false);
    expect(tokenMatches('expected-token-16chars', '')).toBe(false);
    expect(tokenMatches(null, null)).toBe(false);
  });

  it('сравнение точное, разная длина отклоняется без исключений', () => {
    expect(tokenMatches('abcdef0123456789', 'abcdef0123456789')).toBe(true);
    expect(tokenMatches('abcdef0123456789', 'abcdef012345678')).toBe(false);
    expect(tokenMatches('abcdef0123456789', 'abcdef0123456780')).toBe(false);
  });
});

describe('isDashboardChatJid', () => {
  it.each([
    'tg:123456789',
    '77012345678@s.whatsapp.net',
    '77012345678:12@s.whatsapp.net',
    '120363400001234567@g.us',
    '120363400001234567-1740000000@g.us',
    '123456789012345@lid',
  ])('принимает поддерживаемый JID %s', (jid) => {
    expect(isDashboardChatJid(jid)).toBe(true);
  });

  it.each([
    '',
    'tg:-1',
    'tg:123 OR 1=1',
    '1234@s.whatsapp.net',
    '77012345678@s.whatsapp.invalid',
    '120363400001234567@g.us;DROP TABLE messages',
    '../store/messages.db',
    '123456789012345@lid\n/api/log',
  ])('отвергает произвольный или инъекционный JID %j', (jid) => {
    expect(isDashboardChatJid(jid)).toBe(false);
  });
});

describe('dialog history API', () => {
  it('returns paged messages, clamps limits, and forwards cursors', async () => {
    const collectMessagePage = vi.fn(
      (
        _jid: string,
        options: { limit?: number; cursor?: string; anchor?: string },
      ) => ({
        messages: [],
        hasMore: false,
        nextCursor: null,
        anchored: Boolean(options.anchor),
      }),
    );
    const server = createDashboardServer(
      { host: '127.0.0.1', port: 0, token: TOKEN },
      { collectMessagePage },
    );
    const base = await listen(server);
    const response = await fetch(
      `${base}/api/chat-messages?jid=tg%3A123456789&limit=500&cursor=opaque`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      messages: [],
      hasMore: false,
      nextCursor: null,
      anchored: false,
    });
    expect(collectMessagePage).toHaveBeenCalledWith('tg:123456789', {
      limit: 100,
      cursor: 'opaque',
      anchor: undefined,
    });
  });

  it('rejects invalid cursor/anchor combinations and bad limits as 400', async () => {
    const collectMessagePage = vi.fn(() => {
      throw new DialogHistoryInputError('некорректный курсор');
    });
    const server = createDashboardServer(
      { host: '127.0.0.1', port: 0, token: TOKEN },
      { collectMessagePage },
    );
    const base = await listen(server);
    const headers = { Authorization: `Bearer ${TOKEN}` };

    const malformed = await fetch(
      `${base}/api/chat-messages?jid=tg%3A123456789&cursor=broken`,
      { headers },
    );
    expect(malformed.status).toBe(400);

    const both = await fetch(
      `${base}/api/chat-messages?jid=tg%3A123456789&cursor=a&anchor=b`,
      { headers },
    );
    expect(both.status).toBe(400);

    const emptyAnchor = await fetch(
      `${base}/api/chat-messages?jid=tg%3A123456789&anchor=`,
      { headers },
    );
    expect(emptyAnchor.status).toBe(400);

    const badLimit = await fetch(
      `${base}/api/chat-messages?jid=tg%3A123456789&limit=1.5`,
      { headers },
    );
    expect(badLimit.status).toBe(400);
  });

  it('searches only after auth, validates q, and caps result limits', async () => {
    const search = vi.fn(() => [
      {
        channel: 'telegram' as const,
        jid: 'tg:123456789',
        chatName: 'Чат',
        kind: 'text',
        isoTime: '2026-07-15T10:00:00.000Z',
        sender: 'Собеседник',
        snippet: 'искомая фраза',
        anchor: 'opaque',
      },
    ]);
    const server = createDashboardServer(
      { host: '127.0.0.1', port: 0, token: TOKEN },
      { search },
    );
    const base = await listen(server);

    const unauthorized = await fetch(
      `${base}/api/dialog-search?q=${encodeURIComponent('искомая')}`,
    );
    expect(unauthorized.status).toBe(401);
    expect(search).not.toHaveBeenCalled();

    const tooShort = await fetch(`${base}/api/dialog-search?q=я`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(tooShort.status).toBe(400);
    expect(search).not.toHaveBeenCalled();

    const response = await fetch(
      `${base}/api/dialog-search?q=${encodeURIComponent('  искомая  ')}&limit=999`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as any).toHaveProperty('results');
    expect(search).toHaveBeenCalledWith('искомая', 80, undefined);
  });

  it('validates search filters and derives active/important JIDs before search', async () => {
    const search = vi.fn(
      (_query: string, _limit?: number, _options?: any) => [],
    );
    const collectChats = vi.fn(
      () =>
        [
          {
            jid: 'tg:111111111',
            messages24h: 3,
            pinned: false,
            needsReply: false,
          },
          {
            jid: '77012345678@s.whatsapp.net',
            messages24h: 0,
            pinned: true,
            needsReply: false,
          },
          {
            jid: 'tg:222222222',
            messages24h: 1,
            pinned: false,
            needsReply: true,
          },
        ] as any,
    );
    const server = createDashboardServer(
      { host: '127.0.0.1', port: 0, token: TOKEN },
      { search, collectChats },
    );
    const base = await listen(server);
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const request = (filter: string) =>
      fetch(
        `${base}/api/dialog-search?q=${encodeURIComponent('искомая')}&filter=${encodeURIComponent(filter)}`,
        { headers },
      );

    expect((await request('telegram')).status).toBe(200);
    expect(search).toHaveBeenLastCalledWith('искомая', undefined, {
      channel: 'telegram',
    });
    expect((await request('whatsapp')).status).toBe(200);
    expect(search).toHaveBeenLastCalledWith('искомая', undefined, {
      channel: 'whatsapp',
    });
    expect((await request('media')).status).toBe(200);
    expect(search).toHaveBeenLastCalledWith('искомая', undefined, {
      mediaOnly: true,
    });
    expect(collectChats).not.toHaveBeenCalled();

    expect((await request('active')).status).toBe(200);
    expect(search).toHaveBeenLastCalledWith('искомая', undefined, {
      allowedJids: ['tg:111111111', 'tg:222222222'],
    });
    expect((await request('important')).status).toBe(200);
    expect(search).toHaveBeenLastCalledWith('искомая', undefined, {
      allowedJids: ['77012345678@s.whatsapp.net', 'tg:222222222'],
    });
    expect(collectChats).toHaveBeenCalledTimes(2);

    search.mockClear();
    const invalid = await request('unknown');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'некорректный фильтр' });
    expect(search).not.toHaveBeenCalled();

    const empty = await request('');
    expect(empty.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it('attaches only opaque local media descriptors to message pages', async () => {
    const anchor = dialogAnchor();
    const collectMessagePage = vi.fn(() => ({
      messages: [
        {
          anchor,
          isoTime: '2026-07-15T10:00:00.000Z',
          time: '15:00',
          fromBot: false,
          outgoing: false,
          sender: 'Собеседник',
          text: 'Голосовое',
          kind: 'voice',
          mediaEnriched: true,
        },
      ],
      hasMore: false,
      nextCursor: null,
      anchored: false,
    }));
    const listMedia = vi.fn(
      async () =>
        new Map([
          [
            'message-42',
            [
              {
                mediaId: '1234567890abcdef12345678',
                type: 'voice' as const,
                kind: 'audio' as const,
                label: 'Голосовое',
                sizeBytes: 128,
                mime: 'audio/ogg',
              },
            ],
          ],
        ]),
    );
    const server = createDashboardServer(
      { host: '127.0.0.1', port: 0, token: TOKEN },
      { collectMessagePage, listMedia },
    );
    const base = await listen(server);
    const response = await fetch(
      `${base}/api/chat-messages?jid=tg%3A123456789`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.messages[0].media).toEqual([
      expect.objectContaining({
        mediaId: '1234567890abcdef12345678',
        kind: 'audio',
      }),
    ]);
    expect(body.messages[0]).not.toHaveProperty('messageId');
    expect(listMedia).toHaveBeenCalledWith('tg:123456789', ['message-42']);
  });

  it('authenticates media requests and decodes the bound opaque anchor', async () => {
    const anchor = dialogAnchor();
    const serveMedia = vi.fn(async (_req: any, res: any, params: any) => {
      res.writeHead(200, { 'content-type': 'audio/ogg' });
      res.end('local');
      expect(params).toEqual({
        jid: 'tg:123456789',
        messageId: 'message-42',
        mediaId: '1234567890abcdef12345678',
      });
      return 'served' as const;
    });
    const server = createDashboardServer(
      { host: '127.0.0.1', port: 0, token: TOKEN },
      { serveMedia },
    );
    const base = await listen(server);
    const url = `${base}/api/dialog-media?jid=tg%3A123456789&anchor=${encodeURIComponent(anchor)}&mediaId=1234567890abcdef12345678`;

    expect((await fetch(url)).status).toBe(401);
    expect(serveMedia).not.toHaveBeenCalled();

    const valid = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(valid.status).toBe(200);
    expect(await valid.text()).toBe('local');
    expect(serveMedia).toHaveBeenCalledOnce();

    const tampered = await fetch(
      `${base}/api/dialog-media?jid=tg%3A123456789&anchor=${encodeURIComponent(`${anchor}x`)}&mediaId=1234567890abcdef12345678`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(tampered.status).toBe(400);
    expect(serveMedia).toHaveBeenCalledOnce();
  });

  it('returns the honest WhatsApp snapshot through an authenticated route', async () => {
    const collectWhatsAppStatus = vi.fn(() => ({
      state: 'warn' as const,
      detail: 'Данные поступали недавно.',
      channelEnabled: true,
      observerEnabled: true,
      tableAvailable: true,
      lastObservedAt: '2026-07-15T10:00:00.000Z',
      lastObservedAgo: 'только что',
      messages24h: 12,
      media24h: 3,
      unprocessedMedia: 1,
      lastEnrichedAt: null,
      lastEnrichedAgo: null,
    }));
    const server = createDashboardServer(
      { host: '127.0.0.1', port: 0, token: TOKEN },
      { collectWhatsAppStatus },
    );
    const base = await listen(server);
    expect((await fetch(`${base}/api/whatsapp-status`)).status).toBe(401);
    const response = await fetch(`${base}/api/whatsapp-status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: 'warn',
      messages24h: 12,
      media24h: 3,
    });
  });
});

describe('личная панель без расходов', () => {
  it('не показывает расходы и кредиты и не отдаёт старый API', async () => {
    const server = createDashboardServer({
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
    });
    const base = await listen(server);
    const headers = { Authorization: `Bearer ${TOKEN}` };

    const page = await fetch(`${base}/`, { headers });
    expect(page.status).toBe(200);
    const html = (await page.text()).toLocaleLowerCase('ru-RU');
    expect(html).not.toContain('расходы');
    expect(html).not.toContain('кредитов');

    const usage = await fetch(`${base}/api/usage`, { headers });
    expect(usage.status).toBe(404);
  });
});

describe('removed module routes', () => {
  it('does not expose the retired Roy API', async () => {
    const server = createDashboardServer({
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
    });
    const base = await listen(server);
    const response = await fetch(`${base}/api/roy`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });
});

describe('Google dashboard verification route', () => {
  it('keeps GET side-effect free even with a legacy verify query', async () => {
    const verifyWorkspace = vi.fn(async () => ({
      ok: true as const,
      account: 'owner@example.com',
      accountName: 'Owner',
    }));
    const server = createDashboardServer(
      { host: '127.0.0.1', port: 0, token: TOKEN },
      {
        collectOverview: () => overview(),
        verifyWorkspace,
      },
    );
    const base = await listen(server);
    const response = await fetch(`${base}/api/google?verify=1`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('verify');
    expect(verifyWorkspace).not.toHaveBeenCalled();
  });

  it('requires same-origin POST before any live verification', async () => {
    const verifyWorkspace = vi.fn();
    const verifyCalendar = vi.fn();
    const server = createDashboardServer(
      { host: '127.0.0.1', port: 0, token: TOKEN },
      {
        collectOverview: () => overview(),
        verifyWorkspace,
        verifyCalendar,
      },
    );
    const base = await listen(server);
    const response = await fetch(`${base}/api/google/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(403);
    expect(verifyWorkspace).not.toHaveBeenCalled();
    expect(verifyCalendar).not.toHaveBeenCalled();
  });

  it('single-flights concurrent checks and enforces a cooldown', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verifyWorkspace = vi.fn(async () => {
      await gate;
      return {
        ok: true as const,
        account: 'owner@example.com',
        accountName: 'Owner',
      };
    });
    const verifyCalendar = vi.fn(async () => {
      await gate;
      return { ok: true as const, upcoming: [] };
    });
    const server = createDashboardServer(
      { host: '127.0.0.1', port: 0, token: TOKEN },
      {
        collectOverview: () => overview(),
        verifyWorkspace,
        verifyCalendar,
      },
    );
    const base = await listen(server);
    const request = () =>
      fetch(`${base}/api/google/verify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Origin: base,
        },
      });
    const first = request();
    const second = request();
    await vi.waitFor(() => expect(verifyWorkspace).toHaveBeenCalledOnce());
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    const cooledDown = await request();
    expect(cooledDown.status).toBe(429);
    expect(Number(cooledDown.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(verifyWorkspace).toHaveBeenCalledOnce();
    expect(verifyCalendar).toHaveBeenCalledOnce();
  });

  it('rejects cross-origin, unauthenticated, and non-empty verify requests', async () => {
    const verifyWorkspace = vi.fn();
    const verifyCalendar = vi.fn();
    const server = createDashboardServer(
      { host: '127.0.0.1', port: 0, token: TOKEN },
      {
        collectOverview: () => overview(),
        verifyWorkspace,
        verifyCalendar,
      },
    );
    const base = await listen(server);
    const crossOrigin = await fetch(`${base}/api/google/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'http://127.0.0.1:1',
      },
      body: '{}',
    });
    expect(crossOrigin.status).toBe(403);

    const unauthenticated = await fetch(`${base}/api/google/verify`, {
      method: 'POST',
      headers: { Origin: base },
      body: '{}',
    });
    expect(unauthenticated.status).toBe(401);

    const nonEmpty = await fetch(`${base}/api/google/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: base,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ unexpected: true }),
    });
    expect(nonEmpty.status).toBe(400);
    expect(verifyWorkspace).not.toHaveBeenCalled();
    expect(verifyCalendar).not.toHaveBeenCalled();
  });

  it('accepts same-origin cookie auth and rejects oversized bodies', async () => {
    const verifyWorkspace = vi.fn(async () => ({
      ok: true as const,
      account: 'owner@example.com',
      accountName: 'Owner',
    }));
    const verifyCalendar = vi.fn(async () => ({
      ok: true as const,
      upcoming: [],
    }));
    const server = createDashboardServer(
      { host: '127.0.0.1', port: 0, token: TOKEN },
      {
        collectOverview: () => overview(),
        verifyWorkspace,
        verifyCalendar,
      },
    );
    const base = await listen(server);
    const oversized = await fetch(`${base}/api/google/verify`, {
      method: 'POST',
      headers: {
        Cookie: `skoobi_dash=${encodeURIComponent(TOKEN)}`,
        Origin: base,
      },
      body: JSON.stringify({ padding: 'x'.repeat(65 * 1024) }),
    });
    expect(oversized.status).toBe(400);

    const valid = await fetch(`${base}/api/google/verify`, {
      method: 'POST',
      headers: {
        Cookie: `skoobi_dash=${encodeURIComponent(TOKEN)}`,
        Origin: base,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(valid.status).toBe(200);
    expect(verifyWorkspace).toHaveBeenCalledOnce();
    expect(verifyCalendar).toHaveBeenCalledOnce();
  });

  it('re-evaluates enabled state after the cooldown instead of serving stale success', async () => {
    let enabled = true;
    let now = 1_000;
    const verifyWorkspace = vi.fn(async () => ({
      ok: true as const,
      account: 'owner@example.com',
      accountName: 'Owner',
    }));
    const verifyCalendar = vi.fn(async () => ({
      ok: true as const,
      upcoming: [],
    }));
    const server = createDashboardServer(
      { host: '127.0.0.1', port: 0, token: TOKEN },
      {
        collectOverview: () => overview(enabled),
        verifyWorkspace,
        verifyCalendar,
        now: () => now,
      },
    );
    const base = await listen(server);
    const request = () =>
      fetch(`${base}/api/google/verify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Origin: base,
          'content-type': 'application/json',
        },
        body: '{}',
      });
    expect((await request()).status).toBe(200);
    enabled = false;
    now += 31_000;
    const disabled = await request();
    expect(disabled.status).toBe(200);
    const body = (await disabled.json()) as any;
    expect(body.verify.workspace.ok).toBe(false);
    expect(body.verify.calendar.ok).toBe(false);
    expect(verifyWorkspace).toHaveBeenCalledOnce();
    expect(verifyCalendar).toHaveBeenCalledOnce();
  });

  it('does not call disabled Google services', async () => {
    const verifyWorkspace = vi.fn();
    const verifyCalendar = vi.fn();
    const server = createDashboardServer(
      { host: '127.0.0.1', port: 0, token: TOKEN },
      {
        collectOverview: () => overview(false),
        verifyWorkspace,
        verifyCalendar,
      },
    );
    const base = await listen(server);
    const response = await fetch(`${base}/api/google/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: base,
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.verify.workspace.ok).toBe(false);
    expect(body.verify.calendar.ok).toBe(false);
    expect(verifyWorkspace).not.toHaveBeenCalled();
    expect(verifyCalendar).not.toHaveBeenCalled();
  });
});
