import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createSchema,
  getDb,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  INITIAL_INGESTION_CURSOR,
  ingestionCursor,
  loadMessageIngestionState,
  messageCursor,
  migrateMessageIngestionCursors,
  saveMessageIngestionState,
  setRouterState,
  storeMessage,
} from './db.js';
import {
  cursorAfterDeliveredIpc,
  cursorAfterPreSendError,
  hasUnconfirmedPipedMessages,
  pendingMessageCursor,
  sequentialImageMessageBatch,
  triggerBatchDecision,
} from './message-loop.js';
import { ASSISTANT_NAME } from './config.js';
import type { NewMessage } from './types.js';

const JID = 'tg:10001';
const SAME_SECOND = '2026-01-01T10:00:00.000Z';
const message = (
  id: string,
  overrides: Partial<NewMessage> = {},
): NewMessage => ({
  id,
  chat_jid: JID,
  sender: 'synthetic',
  sender_name: 'Synthetic',
  content: `test ${id}`,
  timestamp: SAME_SECOND,
  ...overrides,
});

beforeEach(() => _initTestDatabase());

describe('durable ingestion checkpoints', () => {
  it('pages 451 same-second messages oldest-first without loss or duplication', () => {
    for (let i = 0; i < 451; i++) storeMessage(message(`m-${i}`));
    let cursor = INITIAL_INGESTION_CURSOR;
    const received: string[] = [];
    for (let page = 0; page < 4; page++) {
      const result = getNewMessages([JID], cursor, 'Assistant');
      received.push(...result.messages.map((m) => m.id));
      cursor = result.newTimestamp;
    }
    expect(received).toEqual(Array.from({ length: 451 }, (_, i) => `m-${i}`));
    expect(new Set(received).size).toBe(451);
    const first = getMessagesSince(JID, INITIAL_INGESTION_CURSOR, 'Assistant');
    const second = getMessagesSince(
      JID,
      messageCursor(first.at(-1)!),
      'Assistant',
    );
    const third = getMessagesSince(
      JID,
      messageCursor(second.at(-1)!),
      'Assistant',
    );
    expect([first.length, second.length, third.length]).toEqual([200, 200, 51]);
    expect(first[0].id).toBe('m-0');
    expect(third.at(-1)!.id).toBe('m-450');
  });

  it('processes same-second and older delayed arrivals after confirmed delivery', () => {
    storeMessage(message('first'));
    const first = getNewMessages([JID], INITIAL_INGESTION_CURSOR, 'Assistant');
    saveMessageIngestionState(first.newTimestamp, {
      [JID]: first.newTimestamp,
    });
    storeMessage(message('same-second'));
    storeMessage(message('late', { timestamp: '2025-12-31T01:00:00.000Z' }));
    // Reload persisted state as a restarted process does, with no in-memory ids.
    const restarted = loadMessageIngestionState();
    expect(
      getNewMessages([JID], restarted.lastCursor, 'Assistant').messages.map(
        (m) => m.id,
      ),
    ).toEqual(['same-second', 'late']);
    const pending = getMessagesSince(
      JID,
      restarted.agentCursors[JID],
      'Assistant',
    );
    expect(pending.map((m) => m.id)).toEqual(['same-second', 'late']);
    expect(pending[1].timestamp).toBe('2025-12-31T01:00:00.000Z');
  });

  it('allocates a checkpoint only when delayed empty media first materializes', () => {
    storeMessage(message('media', { content: '' }));
    storeMessage(message('text'));
    const seen = getNewMessages(
      [JID],
      INITIAL_INGESTION_CURSOR,
      'Assistant',
    ).newTimestamp;
    storeMessage(message('media', { content: '[voice] Synthetic transcript' }));
    const enriched = getNewMessages([JID], seen, 'Assistant');
    expect(enriched.messages.map((m) => m.id)).toEqual(['media']);
    storeMessage(message('media', { content: '' }));
    expect(
      getNewMessages([JID], enriched.newTimestamp, 'Assistant').messages,
    ).toEqual([]);
    expect(getMessagesSince(JID, seen, 'Assistant')[0].content).toBe(
      '[voice] Synthetic transcript',
    );
  });

  it('ignores forged channel cursor, preserves provenance and sequence on redelivery', () => {
    storeMessage(
      message('one', {
        telegram_update_id: 'synthetic-update',
        ingestion_cursor: ingestionCursor(9000),
      }),
    );
    const first = getNewMessages([JID], INITIAL_INGESTION_CURSOR, 'Assistant');
    expect(first.newTimestamp).toBe(ingestionCursor(1));
    storeMessage(message('one'));
    expect(
      getNewMessages([JID], first.newTimestamp, 'Assistant').messages,
    ).toEqual([]);
    expect(
      getMessagesSince(JID, INITIAL_INGESTION_CURSOR, 'Assistant')[0]
        .telegram_update_id,
    ).toBe('synthetic-update');
  });

  it('rolls back chat, message, provenance and ledger together on storage failure', () => {
    getDb().exec(`CREATE TRIGGER fail_metadata BEFORE INSERT ON message_metadata
      BEGIN SELECT RAISE(ABORT, 'synthetic persistence error'); END;`);
    expect(() =>
      storeMessage(message('failed', { telegram_update_id: 'update' })),
    ).toThrow();
    for (const table of [
      'chats',
      'messages',
      'message_metadata',
      'message_ingestion',
    ]) {
      expect(
        getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(),
      ).toEqual({ n: 0 });
    }
    getDb().exec('DROP TRIGGER fail_metadata');
    storeMessage(message('failed', { telegram_update_id: 'update' }));
    expect(
      getNewMessages([JID], INITIAL_INGESTION_CURSOR, 'Assistant').messages,
    ).toHaveLength(1);
  });

  it('keeps the delivery cursor before an unconfirmed same-second piped reply', () => {
    storeMessage(message('initial'));
    const target = getNewMessages(
      [JID],
      INITIAL_INGESTION_CURSOR,
      'Assistant',
    ).newTimestamp;
    storeMessage(message('follow-up'));
    const piped = getNewMessages([JID], target, 'Assistant').newTimestamp;
    const firstDelivery = cursorAfterDeliveredIpc({
      initialDeliveryConfirmed: false,
      currentCursor: INITIAL_INGESTION_CURSOR,
      targetCursor: target,
      pipedCursor: piped,
    });
    expect(firstDelivery.cursor).toBe(target);
    expect(firstDelivery.foldedPiped).toBe(false);
    expect(hasUnconfirmedPipedMessages(piped, firstDelivery.cursor)).toBe(true);
    const retriedCursor = cursorAfterPreSendError(
      firstDelivery.cursor,
      INITIAL_INGESTION_CURSOR,
    );
    saveMessageIngestionState(piped, { [JID]: retriedCursor });
    expect(
      getMessagesSince(
        JID,
        loadMessageIngestionState().agentCursors[JID],
        'Assistant',
      ).map((m) => m.id),
    ).toEqual(['follow-up']);
    const confirmed = cursorAfterDeliveredIpc({
      initialDeliveryConfirmed: true,
      currentCursor: retriedCursor,
      targetCursor: target,
      pipedCursor: piped,
    });
    expect(confirmed.cursor).toBe(piped);
    expect(getMessagesSince(JID, confirmed.cursor, 'Assistant')).toEqual([]);
  });

  it('does not pipe an active initial batch twice before its first reply', () => {
    expect(
      pendingMessageCursor(
        INITIAL_INGESTION_CURSOR,
        undefined,
        ingestionCursor(8),
      ),
    ).toBe(ingestionCursor(8));
    expect(
      pendingMessageCursor(
        ingestionCursor(4),
        ingestionCursor(9),
        ingestionCursor(8),
      ),
    ).toBe(ingestionCursor(9));
  });

  it('does not hide a same-second normal message behind an image-turn checkpoint', () => {
    storeMessage(message('image', { content: 'Нарисуй кота' }));
    storeMessage(message('follow-up', { content: 'Как дела?' }));
    const batch = getMessagesSince(
      JID,
      INITIAL_INGESTION_CURSOR,
      ASSISTANT_NAME,
    );
    const imageBatch = sequentialImageMessageBatch(batch);
    expect(imageBatch.messages.map((m) => m.id)).toEqual(['image']);
    expect(imageBatch.deferred).toBe(true);
    expect(
      getMessagesSince(
        JID,
        messageCursor(imageBatch.messages[0]),
        ASSISTANT_NAME,
      ).map((m) => m.id),
    ).toEqual(['follow-up']);
  });

  it('inspects passive pages without delivery so a trigger beyond 200 rows remains reachable', () => {
    for (let i = 0; i < 401; i++) storeMessage(message(`passive-${i}`));
    storeMessage(
      message('denied-trigger', {
        sender: 'denied',
        content: `@${ASSISTANT_NAME} denied request`,
      }),
    );
    storeMessage(
      message('allowed-trigger', {
        content: `@${ASSISTANT_NAME} allowed request`,
      }),
    );
    let cursor = INITIAL_INGESTION_CURSOR;
    const dispatched: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const batch = getMessagesSince(JID, cursor, ASSISTANT_NAME);
      const decision = triggerBatchDecision(
        batch,
        (m) => m.sender !== 'denied',
      );
      if (decision.triggered) dispatched.push(batch.map((m) => m.id));
      else cursor = decision.passiveCursor!;
    }
    expect(cursor).toBe(ingestionCursor(400));
    expect(dispatched).toEqual([
      ['passive-400', 'denied-trigger', 'allowed-trigger'],
    ]);
    const rejectedOnly = triggerBatchDecision(
      [
        message('denied-only', {
          content: `@${ASSISTANT_NAME} denied request`,
          ingestion_cursor: ingestionCursor(404),
        }),
      ],
      () => false,
    );
    expect(rejectedOnly).toEqual({
      triggered: false,
      passiveCursor: ingestionCursor(404),
    });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual(
      { n: 403 },
    );
  });

  it('fails closed on corrupt persisted checkpoints instead of replaying history', () => {
    setRouterState('last_agent_ingestion_cursor', '{broken');
    expect(() => loadMessageIngestionState()).toThrow();
    expect(() => saveMessageIngestionState(SAME_SECOND, {})).toThrow();
    expect(() => getNewMessages([JID], 'i:corrupted', 'Assistant')).toThrow();
  });

  it('atomically saves seen/confirmed checkpoints and keeps legacy keys untouched', () => {
    setRouterState('last_timestamp', SAME_SECOND);
    getDb().exec(`CREATE TRIGGER fail_checkpoint BEFORE INSERT ON router_state
      WHEN NEW.key = 'last_agent_ingestion_cursor'
      BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint error'); END;`);
    expect(() =>
      saveMessageIngestionState(ingestionCursor(9), {
        [JID]: ingestionCursor(8),
      }),
    ).toThrow();
    expect(getRouterState('last_ingestion_cursor')).toBe(
      INITIAL_INGESTION_CURSOR,
    );
    expect(getRouterState('last_timestamp')).toBe(SAME_SECOND);
  });

  it('excludes bot echoes without preventing subsequent client arrivals', () => {
    storeMessage(message('bot', { is_bot_message: true, is_from_me: true }));
    storeMessage(message('user'));
    expect(
      getNewMessages([JID], INITIAL_INGESTION_CURSOR, 'Assistant').messages.map(
        (m) => m.id,
      ),
    ).toEqual(['user']);
  });

  it('tracks direct SQL ingestion and never reuses retained-away sequence numbers', () => {
    storeMessage(message('old'));
    const prior = getNewMessages(
      [JID],
      INITIAL_INGESTION_CURSOR,
      'Assistant',
    ).newTimestamp;
    getDb().pragma('foreign_keys = OFF');
    getDb().prepare('DELETE FROM messages WHERE chat_jid = ?').run(JID);
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM message_ingestion').get(),
    ).toEqual({ n: 0 });
    getDb()
      .prepare(
        `INSERT INTO messages(id, chat_jid, content, timestamp, is_bot_message)
      VALUES ('dashboard', ?, 'synthetic', ?, 0)`,
      )
      .run(JID, SAME_SECOND);
    const result = getNewMessages([JID], prior, 'Assistant');
    expect(result.messages.map((m) => m.id)).toEqual(['dashboard']);
    expect(result.newTimestamp > prior).toBe(true);
  });
});

describe('legacy delivery checkpoint migration', () => {
  function legacyDatabase(): Database.Database {
    const database = new Database(':memory:');
    createSchema(database);
    database.prepare('INSERT INTO chats(jid) VALUES (?)').run(JID);
    // Deliberately insert out of chronological order to exercise sorted seeding.
    for (const [id, time] of [
      ['pending', '2026-01-02'],
      ['old', '2025-12-01'],
      ['boundary', SAME_SECOND],
    ]) {
      database
        .prepare(
          `INSERT INTO messages(id, chat_jid, content, timestamp, is_bot_message)
        VALUES (?, ?, 'synthetic', ?, 0)`,
        )
        .run(id, JID, time);
    }
    database
      .prepare('INSERT INTO router_state(key, value) VALUES (?, ?)')
      .run('last_timestamp', SAME_SECOND);
    database
      .prepare('INSERT INTO router_state(key, value) VALUES (?, ?)')
      .run('last_agent_timestamp', JSON.stringify({ [JID]: SAME_SECOND }));
    return database;
  }

  it('does not replay historical/boundary rows; retains outstanding and future late events', () => {
    const database = legacyDatabase();
    try {
      migrateMessageIngestionCursors(database);
      const state = Object.fromEntries(
        (
          database
            .prepare('SELECT key, value FROM router_state')
            .all() as Array<{ key: string; value: string }>
        ).map((row) => [row.key, row.value]),
      );
      expect(state.last_ingestion_cursor).toBe(ingestionCursor(2));
      expect(JSON.parse(state.last_agent_ingestion_cursor)[JID]).toBe(
        ingestionCursor(2),
      );
      expect(state.last_timestamp).toBe(SAME_SECOND);
      const unread = () =>
        database
          .prepare(
            'SELECT id FROM message_ingestion WHERE sequence > 2 ORDER BY sequence',
          )
          .all();
      expect(unread()).toEqual([{ id: 'pending' }]);
      database
        .prepare(
          `INSERT INTO messages(id, chat_jid, content, timestamp, is_bot_message)
        VALUES ('late', ?, 'synthetic', '2025-01-01', 0)`,
        )
        .run(JID);
      migrateMessageIngestionCursors(database); // Restart must not reseed/rebase.
      expect(unread()).toEqual([{ id: 'pending' }, { id: 'late' }]);
    } finally {
      database.close();
    }
  });

  it('rolls the migration back completely when legacy state is malformed', () => {
    const database = legacyDatabase();
    try {
      database
        .prepare(
          "UPDATE router_state SET value = '{bad' WHERE key = 'last_agent_timestamp'",
        )
        .run();
      expect(() => migrateMessageIngestionCursors(database)).toThrow();
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'message_ingestion'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        database
          .prepare(
            "SELECT value FROM router_state WHERE key = 'last_ingestion_cursor'",
          )
          .get(),
      ).toBeUndefined();
      database
        .prepare(
          "UPDATE router_state SET value = '{}' WHERE key = 'last_agent_timestamp'",
        )
        .run();
      expect(() => migrateMessageIngestionCursors(database)).not.toThrow();
    } finally {
      database.close();
    }
  });
});
