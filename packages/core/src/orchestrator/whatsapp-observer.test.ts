import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  buildWhatsAppObserverContext,
  getObservedWhatsAppMessagesForRequest,
  getRecentObservedWhatsAppMessages,
  listObservedWhatsAppMessages,
  pruneObservedWhatsAppMessages,
  searchObservedWhatsAppMessages,
  storeObservedWhatsAppMessage,
  storeObservedWhatsAppMessagesBatch,
  isExplicitWhatsAppCorrespondenceRequest,
  whatsappObserverRangeForRequest,
  whatsappObserverSinceForRequest,
  type ObservedWhatsAppMessageInput,
  type ObservedWhatsAppMessageRecord,
} from './whatsapp-observer.js';

const NOW = '2026-07-14T12:00:00.000Z';
const RETENTION = { retentionDays: 30, maxRows: 100, now: NOW };

function observed(
  overrides: Partial<ObservedWhatsAppMessageInput> = {},
): ObservedWhatsAppMessageInput {
  return {
    messageId: 'message-1',
    chatJid: 'chat-1@s.whatsapp.net',
    chatLabel: 'Анна',
    senderLabel: 'Анна',
    content: 'Привет',
    timestamp: '2026-07-14T11:00:00.000Z',
    fromMe: false,
    messageKind: 'text',
    upsertType: 'notify',
    ...overrides,
  };
}

function record(
  overrides: Partial<ObservedWhatsAppMessageRecord> = {},
): ObservedWhatsAppMessageRecord {
  const input = observed(overrides);
  return {
    messageId: input.messageId,
    chatJid: input.chatJid,
    chatLabel: input.chatLabel || '',
    senderLabel: input.senderLabel || '',
    content: input.content,
    timestamp: input.timestamp,
    fromMe: input.fromMe,
    messageKind: input.messageKind,
    upsertType: input.upsertType,
    observedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
});

describe('observed WhatsApp storage', () => {
  it('deduplicates by message and chat while updating the local record', () => {
    expect(storeObservedWhatsAppMessage(observed(), RETENTION)).toMatchObject({
      inserted: true,
      updated: false,
      retained: true,
    });
    expect(
      storeObservedWhatsAppMessage(
        observed({
          content: 'Исправленный текст',
          senderLabel: 'Анна П.',
          upsertType: 'append',
        }),
        RETENTION,
      ),
    ).toMatchObject({ inserted: false, updated: true, retained: true });

    const rows = listObservedWhatsAppMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      content: 'Исправленный текст',
      senderLabel: 'Анна П.',
      upsertType: 'append',
    });

    storeObservedWhatsAppMessage(
      observed({ chatJid: 'different-chat@g.us' }),
      RETENTION,
    );
    expect(listObservedWhatsAppMessages()).toHaveLength(2);
  });

  it('upserts a duplicate-key history batch atomically with last value winning', () => {
    const result = storeObservedWhatsAppMessagesBatch(
      [
        observed({ content: 'Первая версия' }),
        observed({ content: 'Финальная версия', upsertType: 'append' }),
        observed({
          messageId: 'message-2',
          content: 'Другое сообщение',
          timestamp: '2026-07-14T11:30:00.000Z',
        }),
      ],
      RETENTION,
    );

    expect(result).toEqual({
      processed: 3,
      inserted: 2,
      updated: 1,
      retained: 3,
      pruned: 0,
      results: [
        { inserted: true, updated: false, retained: true },
        { inserted: false, updated: true, retained: true },
        { inserted: true, updated: false, retained: true },
      ],
    });
    const rows = listObservedWhatsAppMessages({ limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.messageId === 'message-1')).toMatchObject({
      content: 'Финальная версия',
      upsertType: 'append',
    });
  });

  it('does not let a raw history replay erase completed media enrichment', () => {
    storeObservedWhatsAppMessage(
      observed({
        messageKind: 'voice',
        content: '[Голосовое: локальная расшифровка]',
        mediaEnriched: true,
      }),
      RETENTION,
    );
    storeObservedWhatsAppMessage(
      observed({
        messageKind: 'voice',
        content: '[Голосовое: ожидает локальной расшифровки]',
        upsertType: 'append',
        mediaEnriched: false,
      }),
      RETENTION,
    );

    expect(listObservedWhatsAppMessages()).toMatchObject([
      {
        content: '[Голосовое: локальная расшифровка]',
        mediaEnriched: true,
        upsertType: 'append',
      },
    ]);
  });

  it('runs age and row-count retention once after all batch upserts', () => {
    const result = storeObservedWhatsAppMessagesBatch(
      [
        observed({
          messageId: 'expired',
          timestamp: '2026-07-01T00:00:00.000Z',
        }),
        observed({
          messageId: 'oldest-retained-window',
          timestamp: '2026-07-12T00:00:00.000Z',
        }),
        observed({
          messageId: 'middle',
          timestamp: '2026-07-13T00:00:00.000Z',
        }),
        observed({
          messageId: 'newest',
          timestamp: '2026-07-14T00:00:00.000Z',
        }),
      ],
      { retentionDays: 5, maxRows: 2, now: NOW },
    );

    expect(result).toMatchObject({
      processed: 4,
      inserted: 2,
      updated: 0,
      retained: 2,
      pruned: 2,
    });
    expect(result.results.map((item) => item.retained)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(
      listObservedWhatsAppMessages({ limit: 10 }).map(
        (message) => message.messageId,
      ),
    ).toEqual(['newest', 'middle']);
  });

  it('validates the complete batch before writing and gives chunk guidance', () => {
    storeObservedWhatsAppMessage(
      observed({ content: 'Исходное значение' }),
      RETENTION,
    );
    expect(() =>
      storeObservedWhatsAppMessagesBatch(
        [
          observed({ content: 'Не должно записаться' }),
          observed({ messageId: 'invalid', timestamp: 'not-a-timestamp' }),
        ],
        RETENTION,
      ),
    ).toThrow(/inputs\[1\]\.timestamp/);
    expect(listObservedWhatsAppMessages()).toMatchObject([
      { messageId: 'message-1', content: 'Исходное значение' },
    ]);

    expect(() =>
      storeObservedWhatsAppMessagesBatch(
        Array.from({ length: 5_001 }, () => observed()),
        RETENTION,
      ),
    ).toThrow(/split history into chunks of at most 5000/);
  });

  it('prunes expired records and enforces the global maximum row count', () => {
    const bounds = { retentionDays: 5, maxRows: 2, now: NOW };
    const expired = storeObservedWhatsAppMessage(
      observed({
        messageId: 'expired',
        timestamp: '2026-07-01T00:00:00.000Z',
      }),
      bounds,
    );
    expect(expired).toEqual({
      inserted: false,
      updated: false,
      retained: false,
      pruned: 1,
    });

    for (const [messageId, timestamp] of [
      ['one', '2026-07-12T00:00:00.000Z'],
      ['two', '2026-07-13T00:00:00.000Z'],
      ['three', '2026-07-14T00:00:00.000Z'],
    ]) {
      storeObservedWhatsAppMessage(observed({ messageId, timestamp }), bounds);
    }

    const rows = listObservedWhatsAppMessages({ limit: 10 });
    expect(rows.map((row) => row.messageId)).toEqual(['three', 'two']);
  });

  it('prunes expired rows when time passes without a new insert', () => {
    storeObservedWhatsAppMessage(
      observed({ timestamp: '2026-07-14T10:00:00.000Z' }),
      RETENTION,
    );

    expect(
      pruneObservedWhatsAppMessages({
        retentionDays: 1,
        maxRows: 100,
        now: '2026-07-16T10:00:00.000Z',
      }),
    ).toEqual({ pruned: 1, remaining: 0 });
    expect(listObservedWhatsAppMessages()).toEqual([]);
  });

  it('validates retention and timestamps before writing', () => {
    expect(() =>
      storeObservedWhatsAppMessage(observed(), {
        retentionDays: 0,
        maxRows: 10,
      }),
    ).toThrow(/retentionDays/);
    expect(() =>
      storeObservedWhatsAppMessage(observed(), {
        retentionDays: 1,
        maxRows: 0,
      }),
    ).toThrow(/maxRows/);
    expect(() =>
      storeObservedWhatsAppMessage(
        observed({ timestamp: 'not-a-timestamp' }),
        RETENTION,
      ),
    ).toThrow(/timestamp/);
    expect(listObservedWhatsAppMessages()).toEqual([]);
  });

  it('lists, filters, and searches Unicode labels/content newest-first', () => {
    storeObservedWhatsAppMessage(
      observed({
        messageId: 'old',
        content: 'СЕКРЕТНЫЙ договор',
        timestamp: '2026-07-14T10:00:00.000Z',
        messageKind: 'text',
      }),
      RETENTION,
    );
    storeObservedWhatsAppMessage(
      observed({
        messageId: 'new',
        chatJid: 'work@g.us',
        chatLabel: 'Рабочий чат',
        senderLabel: 'Борис',
        content: 'Готово',
        timestamp: '2026-07-14T11:30:00.000Z',
        fromMe: true,
        messageKind: 'image',
      }),
      RETENTION,
    );

    expect(getRecentObservedWhatsAppMessages({ limit: 1 })[0].messageId).toBe(
      'new',
    );
    expect(
      listObservedWhatsAppMessages({
        chatJid: 'work@g.us',
        fromMe: true,
        messageKinds: ['image'],
      }).map((row) => row.messageId),
    ).toEqual(['new']);
    expect(searchObservedWhatsAppMessages('секретный')[0].messageId).toBe(
      'old',
    );
    expect(
      searchObservedWhatsAppMessages('рабочий', { includeContent: false })[0]
        .messageId,
    ).toBe('new');
    expect(
      searchObservedWhatsAppMessages('секретный', { includeContent: false }),
    ).toEqual([]);
    expect(searchObservedWhatsAppMessages('   ')).toEqual([]);
  });

  it('finds an older named/opaque chat beyond the newest 500 by labels only', () => {
    const retention = {
      retentionDays: 365,
      maxRows: 2_000,
      now: '2026-07-15T00:00:00.000Z',
    };
    storeObservedWhatsAppMessage(
      observed({
        messageId: 'anna-old',
        chatJid: 'anna-old@s.whatsapp.net',
        chatLabel: 'Анна',
        senderLabel: 'Анна',
        content: 'Старое, но нужное сообщение Анны',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      retention,
    );
    const noiseStart = Date.parse('2026-07-14T00:00:00.000Z');
    for (let index = 0; index < 501; index += 1) {
      storeObservedWhatsAppMessage(
        observed({
          messageId: `noise-${index}`,
          chatJid: 'noise@s.whatsapp.net',
          chatLabel: 'Борис',
          senderLabel: 'Борис',
          // Candidate selection must not mistake body text for a label match.
          content: `В теле упомянута Анна ${index}`,
          timestamp: new Date(noiseStart + index * 1_000).toISOString(),
        }),
        retention,
      );
    }
    expect(
      getRecentObservedWhatsAppMessages({ limit: 500 }).some(
        (message) => message.messageId === 'anna-old',
      ),
    ).toBe(false);

    const namedMessages = getObservedWhatsAppMessagesForRequest(
      'Покажи что Анна написала',
    );
    expect(namedMessages.map((message) => message.messageId)).toEqual([
      'anna-old',
    ]);
    const namedContext = buildWhatsAppObserverContext({
      request: 'Покажи что Анна написала',
      messages: namedMessages,
    });
    expect(namedContext.mode).toBe('transcript');
    expect(namedContext.xml).toContain('Старое, но нужное сообщение Анны');
    const [annaRef] = namedContext.selectedChatRefs;

    const referencedMessages = getObservedWhatsAppMessagesForRequest(
      `Покажи переписку ${annaRef}`,
    );
    expect(referencedMessages.map((message) => message.messageId)).toEqual([
      'anna-old',
    ]);
  });

  it('applies yesterday since/before in candidate and transcript SQL reads', () => {
    const retention = {
      retentionDays: 30,
      maxRows: 100,
      now: '2026-07-15T00:00:00.000Z',
    };
    storeObservedWhatsAppMessage(
      observed({
        messageId: 'yesterday',
        content: 'Вчерашнее',
        timestamp: '2026-07-14T18:59:59.000Z',
      }),
      retention,
    );
    storeObservedWhatsAppMessage(
      observed({
        messageId: 'today',
        content: 'Сегодняшнее',
        timestamp: '2026-07-14T19:00:00.000Z',
      }),
      retention,
    );

    const messages = getObservedWhatsAppMessagesForRequest(
      'Покажи сообщения Анны за вчера',
      {
        now: '2026-07-14T20:30:00.000Z',
        timeZone: 'Asia/Almaty',
      },
    );
    expect(messages.map((message) => message.messageId)).toEqual(['yesterday']);
  });

  it('keeps an explicit generic no-target request on the recent path', () => {
    storeObservedWhatsAppMessage(
      observed({ messageId: 'older', timestamp: '2026-07-14T10:00:00.000Z' }),
      RETENTION,
    );
    storeObservedWhatsAppMessage(
      observed({ messageId: 'newer', timestamp: '2026-07-14T11:00:00.000Z' }),
      RETENTION,
    );
    expect(
      getObservedWhatsAppMessagesForRequest('Что нового в переписках?', {
        recentLimit: 1,
      }).map((message) => message.messageId),
    ).toEqual(['newer']);
  });
});

describe('buildWhatsAppObserverContext', () => {
  const correspondence = [
    record({
      messageId: 'anna-1',
      chatJid: '77000000001@s.whatsapp.net',
      chatLabel: 'Анна & партнёры',
      senderLabel: 'Анна',
      content: 'Привет <Пользователь> & доброе утро',
      timestamp: '2026-07-14T09:00:00.000Z',
    }),
    record({
      messageId: 'anna-2',
      chatJid: '77000000001@s.whatsapp.net',
      chatLabel: 'Анна & партнёры',
      senderLabel: '+7 700 000 00 01',
      content: 'Ответ про встречу',
      timestamp: '2026-07-14T10:00:00.000Z',
      fromMe: true,
    }),
    record({
      messageId: 'alice-1',
      chatJid: 'alice-chat@g.us',
      chatLabel: 'Project Alice',
      senderLabel: 'Alice',
      content: 'English private text',
      timestamp: '2026-07-14T11:00:00.000Z',
    }),
  ];

  it('returns a metadata-only index unless correspondence is explicitly requested', () => {
    const result = buildWhatsAppObserverContext({
      request: 'Помоги подготовиться к встрече',
      messages: correspondence,
    });

    expect(result.mode).toBe('index');
    expect(result.messageCount).toBe(0);
    expect(result.xml).toContain('<chat ref="wa_');
    expect(result.xml).toContain('Анна &amp; партнёры');
    expect(result.xml).not.toContain('Привет');
    expect(result.xml).not.toContain('English private text');
    expect(result.xml).not.toContain('@s.whatsapp.net');
    expect(result.xml).not.toContain('@g.us');
    expect(result.xml).not.toContain('+7 700 000 00 01');
  });

  it('ranks a Russian contact label and exposes only the requested transcript', () => {
    const result = buildWhatsAppObserverContext({
      request: 'Покажи переписку с Анной',
      messages: correspondence,
    });

    expect(result.mode).toBe('transcript');
    expect(result.chatCount).toBe(1);
    expect(result.messageCount).toBe(2);
    expect(result.xml).toContain(
      'Привет &lt;Пользователь&gt; &amp; доброе утро',
    );
    expect(result.xml).toContain('sender="Я"');
    expect(result.xml).not.toContain('English private text');
    expect(result.xml).not.toContain('77000000001');
  });

  it('treats a name-free request for today messages as explicit recent correspondence', () => {
    const result = buildWhatsAppObserverContext({
      request: 'Что мне написали за сегодня?',
      messages: correspondence,
      now: NOW,
    });

    expect(result.mode).toBe('transcript');
    expect(result.chatCount).toBe(2);
    expect(result.xml).toContain('Привет &lt;Пользователь&gt;');
    expect(result.xml).toContain('English private text');
  });

  it.each([
    'Посмотри последние сообщения за час',
    'Кто мне писал за последние два дня?',
  ])('does not mistake temporal words for a contact: %s', (request) => {
    const result = buildWhatsAppObserverContext({
      request,
      messages: correspondence,
      now: NOW,
    });
    expect(result.mode).toBe('transcript');
    expect(result.messageCount).toBeGreaterThan(0);
  });

  it.each([
    'Что ответить Анне?',
    'Подготовь ответ Анне',
    'Напиши черновик ответа Анне',
    'Что мне написала Анна?',
  ])('recognizes explicit summary/draft request: %s', (request) => {
    expect(isExplicitWhatsAppCorrespondenceRequest(request)).toBe(true);
    const result = buildWhatsAppObserverContext({
      request,
      messages: correspondence,
    });
    expect(result.mode).toBe('transcript');
    expect(result.xml).toContain('Привет &lt;Пользователь&gt;');
    expect(result.xml).not.toContain('English private text');
  });

  it.each([
    ['Покажи что Анна написала', 1],
    ['посмотри последнее от Анны', 1],
    ['что там Анна пишет?', 1],
    ['что нового в переписках?', 2],
  ])(
    'recognizes natural observer wording: %s',
    (request, expectedChatCount) => {
      expect(isExplicitWhatsAppCorrespondenceRequest(request)).toBe(true);
      const result = buildWhatsAppObserverContext({
        request,
        messages: correspondence,
      });
      expect(result.mode).toBe('transcript');
      expect(result.chatCount).toBe(expectedChatCount);
      expect(result.xml).toContain('Привет &lt;Пользователь&gt;');
      if (expectedChatCount === 1) {
        expect(result.xml).not.toContain('English private text');
      } else {
        expect(result.xml).toContain('English private text');
      }
    },
  );

  it('parses common relative ranges for bounded database reads', () => {
    const now = '2026-07-14T12:00:00.000Z';
    expect(whatsappObserverSinceForRequest('за последний час', now)).toBe(
      '2026-07-14T11:00:00.000Z',
    );
    expect(whatsappObserverSinceForRequest('последние два дня', now)).toBe(
      '2026-07-12T12:00:00.000Z',
    );
    expect(whatsappObserverSinceForRequest('переписка с Анной', now)).toBe(
      undefined,
    );
  });

  it('parses today and yesterday from local midnight in Asia/Almaty', () => {
    const now = '2026-07-14T20:30:00.000Z'; // 01:30 on July 15 in Almaty.
    expect(whatsappObserverSinceForRequest('сообщения за сегодня', now)).toBe(
      '2026-07-14T19:00:00.000Z',
    );
    expect(whatsappObserverSinceForRequest('сообщения за вчера', now)).toBe(
      '2026-07-13T19:00:00.000Z',
    );
    expect(whatsappObserverRangeForRequest('сообщения за вчера', now)).toEqual({
      since: '2026-07-13T19:00:00.000Z',
      before: '2026-07-14T19:00:00.000Z',
    });
    expect(
      whatsappObserverSinceForRequest(
        'messages today',
        now,
        'America/New_York',
      ),
    ).toBe('2026-07-14T04:00:00.000Z');
  });

  it('clamps hostile numeric ranges and never throws on invalid dates/zones', () => {
    const now = '2026-07-14T12:00:00.000Z';
    const hugeRequest = `за последние ${'9'.repeat(10_000)} дней`;
    let bounded: string | undefined;
    expect(() => {
      bounded = whatsappObserverSinceForRequest(hugeRequest, now);
    }).not.toThrow();
    expect(Number.isFinite(Date.parse(bounded || ''))).toBe(true);
    expect(Date.parse(now) - Date.parse(bounded || '')).toBeLessThanOrEqual(
      10 * 366 * 24 * 60 * 60 * 1000,
    );
    expect(
      whatsappObserverSinceForRequest('сообщения сегодня', now, 'Bad/Zone'),
    ).toBe(undefined);
    expect(
      whatsappObserverSinceForRequest('за последний час', 'invalid-date'),
    ).toBe(undefined);
  });

  it('filters supplied records to the requested relative window', () => {
    const result = buildWhatsAppObserverContext({
      request: 'Покажи последние сообщения за час',
      messages: correspondence,
      now: '2026-07-14T12:00:00.000Z',
    });

    expect(result.mode).toBe('transcript');
    expect(result.messageCount).toBe(1);
    expect(result.xml).toContain('English private text');
    expect(result.xml).not.toContain('Ответ про встречу');
    expect(result.xml).not.toContain('Привет &lt;Пользователь&gt;');
  });

  it('uses a local yesterday window, including its upper boundary', () => {
    const result = buildWhatsAppObserverContext({
      request: 'Покажи сообщения за вчера',
      messages: [
        record({
          messageId: 'yesterday',
          content: 'вчерашнее сообщение',
          timestamp: '2026-07-14T18:59:59.000Z',
        }),
        record({
          messageId: 'today',
          content: 'сегодняшнее сообщение',
          timestamp: '2026-07-14T19:00:00.000Z',
        }),
      ],
      now: '2026-07-14T20:30:00.000Z',
      timeZone: 'Asia/Almaty',
    });

    expect(result.mode).toBe('transcript');
    expect(result.xml).toContain('вчерашнее сообщение');
    expect(result.xml).not.toContain('сегодняшнее сообщение');
  });

  it('returns an explicit empty marker after a bounded check finds nothing', () => {
    const result = buildWhatsAppObserverContext({
      request: 'Покажи последние сообщения за час',
      messages: correspondence,
      now: '2026-07-15T12:00:00.000Z',
    });

    expect(result).toMatchObject({
      mode: 'empty',
      reason: 'no_messages',
      messageCount: 0,
      chatCount: 0,
      truncated: false,
    });
    expect(result.xml).toBe(
      '<whatsapp_observer_context mode="empty" reason="no_messages" />',
    );
  });

  it.each([
    'один',
    'одна',
    'одну',
    'два',
    'две',
    'три',
    'one',
    'two',
    'three',
    'four',
  ])('does not treat parsed number word as a contact: %s', (numberWord) => {
    const result = buildWhatsAppObserverContext({
      request: `Покажи последние сообщения за ${numberWord} часа`,
      messages: [record({ timestamp: NOW })],
      now: NOW,
    });
    expect(result.mode).toBe('transcript');
    expect(result.messageCount).toBe(1);
  });

  it('ranks English chat/contact labels', () => {
    const result = buildWhatsAppObserverContext({
      request: 'Show the conversation with Alice',
      messages: correspondence,
    });
    expect(result.mode).toBe('transcript');
    expect(result.xml).toContain('English private text');
    expect(result.xml).not.toContain('Ответ про встречу');
  });

  it('fails closed to an index for ambiguous contact matches', () => {
    const messages = [
      record({
        messageId: 'one',
        chatJid: 'one@g.us',
        chatLabel: 'Первый проект',
        senderLabel: 'Анна',
        content: 'first secret',
      }),
      record({
        messageId: 'two',
        chatJid: 'two@g.us',
        chatLabel: 'Второй проект',
        senderLabel: 'Анна',
        content: 'second secret',
      }),
    ];
    const result = buildWhatsAppObserverContext({
      request: 'Покажи сообщения от Анны',
      messages,
    });
    expect(result.mode).toBe('ambiguous');
    expect(result.reason).toBe('ambiguous_contact_match');
    expect(result.messageCount).toBe(0);
    expect(result.xml).not.toContain('first secret');
    expect(result.xml).not.toContain('second secret');
  });

  it('uses an exact opaque ambiguity ref to select one transcript', () => {
    const messages = [
      record({
        messageId: 'one',
        chatJid: 'one@g.us',
        chatLabel: 'Первый проект',
        senderLabel: 'Анна',
        content: 'first secret',
        timestamp: '2026-07-14T10:00:00.000Z',
      }),
      record({
        messageId: 'two',
        chatJid: 'two@g.us',
        chatLabel: 'Второй проект',
        senderLabel: 'Анна',
        content: 'second secret',
        timestamp: '2026-07-14T11:00:00.000Z',
      }),
    ];
    const ambiguous = buildWhatsAppObserverContext({
      request: 'Покажи сообщения от Анны',
      messages,
    });
    expect(ambiguous.mode).toBe('ambiguous');
    const selectedRef = ambiguous.selectedChatRefs[0];

    const selected = buildWhatsAppObserverContext({
      request: `Покажи переписку ${selectedRef}`,
      messages,
    });
    expect(selected.mode).toBe('transcript');
    expect(selected.selectedChatRefs).toEqual([selectedRef]);
    expect(selected.xml).toContain('second secret');
    expect(selected.xml).not.toContain('first secret');
  });

  it('returns a safe index when an explicitly named contact is absent', () => {
    const result = buildWhatsAppObserverContext({
      request: 'Прочитай переписку с Виктором',
      messages: correspondence,
    });
    expect(result.mode).toBe('index');
    expect(result.reason).toBe('no_matching_chat');
    expect(result.messageCount).toBe(0);
    expect(result.xml).not.toContain('Привет');
  });

  it('enforces chat, message, and character bounds with valid closing XML', () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      record({
        messageId: `m-${index}`,
        chatJid: `chat-${Math.floor(index / 4)}@g.us`,
        chatLabel: `Команда ${Math.floor(index / 4)}`,
        senderLabel: 'Участник',
        content: `${'<важно>&'.repeat(100)}-${index}`,
        timestamp: `2026-07-14T${String(index + 1).padStart(2, '0')}:00:00.000Z`,
      }),
    );
    const result = buildWhatsAppObserverContext({
      request: 'Покажи последние сообщения',
      messages: many,
      maxChats: 1,
      maxMessagesPerChat: 2,
      maxChars: 500,
    });
    expect(result.mode).toBe('transcript');
    expect(result.chatCount).toBe(1);
    expect(result.messageCount).toBeLessThanOrEqual(2);
    expect(result.xml.length).toBeLessThanOrEqual(500);
    expect(result.xml).toMatch(/<\/whatsapp_observer_context>$/);
    expect(result.truncated).toBe(true);
  });

  it('handles empty inputs and bounds without exposing anything', () => {
    expect(buildWhatsAppObserverContext({ request: '', messages: [] })).toEqual(
      {
        mode: 'empty',
        reason: 'no_messages',
        xml: '',
        selectedChatRefs: [],
        chatCount: 0,
        messageCount: 0,
        truncated: false,
      },
    );
    expect(
      buildWhatsAppObserverContext({
        request: 'Покажи сообщения',
        messages: correspondence,
        maxChars: 0,
      }).xml,
    ).toBe('');
  });

  it('keeps an explicit empty-store check visible to the prompt builder', () => {
    expect(
      buildWhatsAppObserverContext({
        request: 'Покажи что Анна написала',
        messages: getObservedWhatsAppMessagesForRequest(
          'Покажи что Анна написала',
        ),
      }),
    ).toMatchObject({
      mode: 'empty',
      reason: 'no_messages',
      xml: '<whatsapp_observer_context mode="empty" reason="no_messages" />',
      messageCount: 0,
    });
  });
});
