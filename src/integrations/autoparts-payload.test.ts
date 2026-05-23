import { describe, expect, it, vi } from 'vitest';

import {
  AutopartsPayloadClient,
  AutopartsWhatsAppBridge,
  shouldCreateAutopartsRequest,
  type AutopartsFetch,
} from './autoparts-payload.js';

function response(status: number, body: unknown = {}) {
  return {
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function createBridge(fetchImpl: AutopartsFetch): AutopartsWhatsAppBridge {
  return new AutopartsWhatsAppBridge(
    new AutopartsPayloadClient({
      baseUrl: 'http://payload.test',
      email: 'bot@example.com',
      password: 'secret',
      privacyPolicyVersion: 'test-policy',
      fetchImpl,
    }),
  );
}

describe('shouldCreateAutopartsRequest', () => {
  it('accepts clear autoparts inquiries', () => {
    expect(
      shouldCreateAutopartsRequest({
        text: 'Мне нужна фара на Киа Сид 2010 года',
        content: 'Мне нужна фара на Киа Сид 2010 года',
      }),
    ).toBe(true);
  });

  it('does not create requests for unrelated delivery spam', () => {
    expect(
      shouldCreateAutopartsRequest({
        text: 'Тегін жеткізу қызметі !!!',
        content: 'Тегін жеткізу қызметі !!!',
      }),
    ).toBe(false);
  });

  it('accepts customer media that needs operator follow-up', () => {
    expect(
      shouldCreateAutopartsRequest({
        text: '',
        content: '[image]',
        mediaKind: 'image',
      }),
    ).toBe(true);
  });
});

describe('AutopartsWhatsAppBridge', () => {
  it('creates a whatsapp CustomerRequest for a new inbound parts inquiry', async () => {
    const year = new Date().getFullYear();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/api/users/login')) {
        return response(200, { token: 'jwt', exp: 4_102_444_800 });
      }
      if (
        init?.method === 'GET' &&
        url.includes('/api/customer-requests?') &&
        url.includes('customerWhatsapp')
      ) {
        return response(200, { docs: [] });
      }
      if (
        init?.method === 'GET' &&
        url.includes('/api/customer-requests?') &&
        url.includes('requestNumber')
      ) {
        return response(200, {
          docs: [{ requestNumber: `REQ-${year}-000008` }],
        });
      }
      if (init?.method === 'POST' && url.endsWith('/api/customer-requests')) {
        return response(200, {
          doc: {
            id: 9,
            requestNumber: `REQ-${year}-000009`,
          },
        });
      }
      if (init?.method === 'POST' && url.endsWith('/api/whatsapp-messages')) {
        return response(200, { id: 1 });
      }
      if (init?.method === 'POST' && url.endsWith('/api/lead-events')) {
        return response(200, { id: 1 });
      }
      return response(404, { error: 'unexpected' });
    }) as unknown as AutopartsFetch;
    const bridge = createBridge(fetchImpl);

    await bridge.recordInbound({
      chatJid: 'wa:79539531700',
      phone: '79539531700',
      pushName: 'Oxy',
      text: 'Мне нужна фара на Киа Сид 2010 года',
      content: 'Мне нужна фара на Киа Сид 2010 года',
      mediaKind: null,
      whatsappMessageId: 'm1',
      timestamp: '2026-05-23T08:21:37.000Z',
    });

    const requestCreate = calls.find((call) =>
      call.url.endsWith('/api/customer-requests'),
    );
    expect(JSON.parse(String(requestCreate?.init?.body))).toMatchObject({
      requestNumber: `REQ-${year}-000009`,
      channel: 'whatsapp',
      status: 'new',
      customerName: 'Oxy',
      customerWhatsapp: '+79539531700',
      queryText: 'Мне нужна фара на Киа Сид 2010 года',
      sourcePage: 'whatsapp:skoobi',
      privacyPolicyVersion: 'test-policy',
      city: 'Актау',
    });

    const messageCreate = calls.find((call) =>
      call.url.endsWith('/api/whatsapp-messages'),
    );
    expect(JSON.parse(String(messageCreate?.init?.body))).toMatchObject({
      direction: 'incoming',
      customerRequest: 9,
      fromPhone: '+79539531700',
      text: 'Мне нужна фара на Киа Сид 2010 года',
      whatsappMessageId: 'm1',
      pushName: 'Oxy',
    });
  });

  it('reuses and updates an existing request for follow-up messages', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/api/users/login')) {
        return response(200, { token: 'jwt', exp: 4_102_444_800 });
      }
      if (init?.method === 'GET' && url.includes('/api/customer-requests?')) {
        return response(200, {
          docs: [
            {
              id: 42,
              requestNumber: 'REQ-2026-000010',
              queryText: 'Фара на Kia Ceed 2010',
              rawMessage: '[2026-05-23T08:21:37.000Z] Oxy: Фара',
            },
          ],
        });
      }
      if (
        init?.method === 'PATCH' &&
        url.endsWith('/api/customer-requests/42')
      ) {
        return response(200, {
          doc: {
            id: 42,
            requestNumber: 'REQ-2026-000010',
          },
        });
      }
      if (init?.method === 'POST' && url.endsWith('/api/whatsapp-messages')) {
        return response(200, { id: 2 });
      }
      if (init?.method === 'POST' && url.endsWith('/api/lead-events')) {
        return response(200, { id: 2 });
      }
      return response(404, { error: 'unexpected' });
    }) as unknown as AutopartsFetch;
    const bridge = createBridge(fetchImpl);

    await bridge.recordInbound({
      chatJid: 'wa:79539531700',
      phone: '79539531700',
      pushName: 'Oxy',
      text: 'Левая',
      content: 'Левая',
      whatsappMessageId: 'm2',
      timestamp: '2026-05-23T08:21:53.000Z',
    });

    expect(
      calls.some(
        (call) =>
          call.init?.method === 'POST' &&
          call.url.endsWith('/api/customer-requests'),
      ),
    ).toBe(false);
    const patch = calls.find((call) => call.init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.init?.body))).toMatchObject({
      queryText: 'Фара на Kia Ceed 2010\nЛевая',
    });
  });

  it('saves delivered Skoobi replies against the existing request', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/api/users/login')) {
        return response(200, { token: 'jwt', exp: 4_102_444_800 });
      }
      if (init?.method === 'GET' && url.includes('/api/customer-requests?')) {
        return response(200, {
          docs: [{ id: 7, requestNumber: 'REQ-2026-000007' }],
        });
      }
      if (init?.method === 'POST' && url.endsWith('/api/whatsapp-messages')) {
        return response(200, { id: 3 });
      }
      return response(404, { error: 'unexpected' });
    }) as unknown as AutopartsFetch;
    const bridge = createBridge(fetchImpl);

    await bridge.recordOutbound({
      chatJid: 'wa:79539531700',
      text: 'Передаю оператору.',
    });

    const messageCreate = calls.find((call) =>
      call.url.endsWith('/api/whatsapp-messages'),
    );
    expect(JSON.parse(String(messageCreate?.init?.body))).toMatchObject({
      direction: 'outgoing',
      customerRequest: 7,
      toPhone: '+79539531700',
      text: 'Передаю оператору.',
      isAutoReply: true,
    });
  });
});
