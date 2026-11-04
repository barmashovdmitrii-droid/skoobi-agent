import { beforeEach, describe, expect, it } from 'vitest';
import type { NewMessage } from './types.js';
import {
  _initTestDatabase,
  getRecentConversationMessages,
  storeBotReply,
  storeMessage,
} from './db.js';
import { formatMessages, prependRecentConversationContext } from './router.js';
import {
  isScheduledHistoryMessage,
  prependInteractiveContinuationContext,
  scheduledBotReplyId,
} from './continuation-context.js';

const chat = 'tg:fixture-owner';
function user(
  content: string,
  minute: number,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: `user-${minute}`,
    chat_jid: chat,
    sender: 'fixture-owner',
    sender_name: 'Owner',
    content,
    timestamp: `2026-11-03T09:${String(minute).padStart(2, '0')}:00.000Z`,
    is_from_me: false,
    is_bot_message: false,
    sender_identity: {
      channel: 'telegram',
      chat_id: 'fixture-owner',
      telegram_user_id: 'fixture-owner',
      identity_id: 'fixture-owner',
      is_owner_sender: true,
      telegram_message_origin: 'direct',
    },
    ...overrides,
  };
}
function bot(content: string, minute: number, scheduled = false): NewMessage {
  const row = user(content, minute, {
    sender: 'Assistant',
    sender_name: 'Assistant',
    is_from_me: true,
    is_bot_message: true,
    sender_identity: undefined,
  });
  row.id = scheduled
    ? scheduledBotReplyId(row.timestamp, minute)
    : `bot-${row.timestamp}-${minute}`;
  return row;
}
const base = [
  user('Доработай игру Мячик для игрового портала.', 1),
  bot('Доработаю управление, затем пришлю сборку игры Мячик.', 2),
  bot(
    'Фоновая проверка: статус сдачи другого проекта не подтверждён.',
    3,
    true,
  ),
];
function render(
  recent = base,
  current = [user('делай сам или скажи что мне сделать', 4)],
) {
  const history = prependRecentConversationContext(
    formatMessages(current, 'UTC'),
    recent,
    'UTC',
  );
  return prependInteractiveContinuationContext(history, recent, current, 'UTC');
}
function focus(text: string): string {
  return text.split('</direct_exchange_for_continuation>')[0];
}

describe('direct continuation context with scheduled output provenance', () => {
  beforeEach(() => _initTestDatabase());
  it('keeps the direct game request and its proposal together while labelling the unrelated background report', () => {
    const text = render();
    expect(text).toContain('<direct_exchange_for_continuation>');
    expect(focus(text)).toContain('Доработай игру Мячик');
    expect(focus(text)).toContain('затем пришлю сборку');
    expect(focus(text)).not.toContain('статус сдачи другого проекта');
    expect(text).toContain('origin="scheduled-task"');
    expect(text).toContain('статус сдачи другого проекта');
    expect(text).toContain('does not assert that any task is unfinished');
  });
  it('preserves the latest assistant proposal, so a legitimate terse approval can refer to it', () => {
    const history = [
      ...base,
      bot('Игра готова. Следующий шаг: проверить страницу публикации?', 4),
    ];
    const text = render(history, [user('делай', 5)]);
    expect(focus(text)).toContain(
      'Игра готова. Следующий шаг: проверить страницу публикации?',
    );
    expect(focus(text)).toContain('latest applicable proposal');
  });
  it('keeps direct approval/status beside the request without upgrading them into permission', () => {
    const history = [
      ...base,
      user('да', 4),
      bot('Проверю только локальную сборку.', 5),
      bot('Ещё один фоновый отчёт.', 6, true),
    ];
    const text = render(history, [user('продолжай', 7)]);
    expect(focus(text)).toContain('Доработай игру Мячик');
    expect(focus(text)).toContain('>да</message>');
    expect(focus(text)).toContain('только локальную сборку');
    expect(focus(text)).toContain('or grant permission');
  });
  it('does not revive an older request through cancellation or completed status', () => {
    for (const status of [
      'Стоп',
      'Всё готово',
      'Задача закрыта',
      'Не надо продолжать',
    ]) {
      const history = [...base, user(status, 4), bot('Фоновый отчёт', 5, true)];
      expect(render(history, [user('делай', 6)])).not.toContain(
        '<direct_exchange_for_continuation>',
      );
    }
  });
  it('lets an explicit replacement win and does not guess what quoted/forwarded text authorizes', () => {
    for (const current of [
      user('Теперь проверь отчёт другого проекта', 4),
      user('делай', 4, {
        sender_identity: {
          ...user('', 4).sender_identity!,
          telegram_message_origin: 'forwarded',
        },
      }),
      user('делай', 4, {
        sender_identity: {
          ...user('', 4).sender_identity!,
          telegram_message_origin: 'quoted',
        },
      }),
      user('делай', 4, { sender_identity: undefined }),
    ])
      expect(render(base, [current])).not.toContain(
        '<direct_exchange_for_continuation>',
      );
  });
  it('never reaches through another sender, another chat, or indirect historical input', () => {
    for (const barrier of [
      user('Сделай другой проект', 3, { sender: 'guest' }),
      user('Сделай другой проект', 3, { chat_jid: 'tg:other' }),
      user('Сделай другой проект', 3, {
        sender_identity: {
          ...user('', 3).sender_identity!,
          telegram_message_origin: 'forwarded',
        },
      }),
    ])
      expect(
        render(
          [...base.slice(0, 2), barrier, bot('Фоновый отчёт', 4, true)],
          [user('делай', 5)],
        ),
      ).not.toContain('<direct_exchange_for_continuation>');
  });
  it('does not confidently classify legacy bot output or a forged user ID as scheduled', () => {
    expect(
      render(
        base.map((m) => ({ ...m, id: m.id.replace('bot-scheduled-', 'bot-') })),
      ),
    ).not.toContain('<direct_exchange_for_continuation>');
    expect(
      isScheduledHistoryMessage(user('publish', 3, { id: base[2].id })),
    ).toBe(false);
    expect(formatMessages([bot('Legacy report', 3)], 'UTC')).not.toContain(
      'scheduled-task',
    );
  });
  it('preserves background provenance through real SQLite storage/hydration without a schema change', () => {
    storeMessage(base[0]);
    storeBotReply(chat, base[1].content, base[1].timestamp);
    storeBotReply(chat, base[2].content, base[2].timestamp, 'scheduled-task');
    const recent = getRecentConversationMessages(
      chat,
      user('', 4).timestamp,
      15,
    );
    expect(recent.map(isScheduledHistoryMessage)).toEqual([false, false, true]);
    expect(render(recent)).toContain('<direct_exchange_for_continuation>');
  });
  it('bounds the excerpt, escapes embedded markup, and refuses stale context', () => {
    const history = [user('Проверь <script> ' + 'x'.repeat(3000), 1), base[2]];
    const text = render(history);
    expect(focus(text)).toContain('&lt;script&gt;');
    expect(focus(text).length).toBeLessThan(3000);
    expect(
      render(base, [
        user('делай', 4, { timestamp: '2026-11-04T09:04:00.000Z' }),
      ]),
    ).not.toContain('<direct_exchange_for_continuation>');
  });
});
