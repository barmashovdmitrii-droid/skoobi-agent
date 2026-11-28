import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _initTestDatabase,
  createSchema,
  createTask,
  dropRetiredWhatsAppCampaignData,
  getDb,
  getMessagesSince,
  INITIAL_INGESTION_CURSOR,
  loadMessageIngestionState,
  messageCursor,
  saveMessageIngestionState,
  storeMessage,
} from './db.js';

const retiredTables = [
  'whatsapp_campaign_decisions',
  'whatsapp_campaign_state',
  'whatsapp_campaign_leads',
  'whatsapp_campaign_chat_controls',
  'whatsapp_campaign_admin_policy',
  'whatsapp_campaign_escalations',
  'whatsapp_campaign_global_rate_claims',
];

function addRetiredFixtures(): void {
  for (const table of retiredTables) {
    getDb().exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, value TEXT);
      INSERT INTO ${table}(id, value) VALUES('synthetic', 'retired');`);
  }
}

function tableNames(): string[] {
  return (
    getDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

beforeEach(() => _initTestDatabase());

describe('retired WhatsApp campaign migration', () => {
  it('never creates campaign tables on a fresh instance', () => {
    expect(
      tableNames().filter((name) => name.startsWith('whatsapp_campaign_')),
    ).toEqual([]);
  });

  it('removes all seven retired tables on startup without touching messages, tasks or ingestion', () => {
    const jid = 'tg:10001';
    const message = (id: string) => ({
      id,
      chat_jid: jid,
      sender: 'synthetic',
      sender_name: 'Synthetic',
      content: 'ordinary message',
      timestamp: '2026-01-01T00:00:00.000Z',
      telegram_update_id: `update-${id}`,
    });
    storeMessage(message('first'));
    const cursor = messageCursor(
      getMessagesSince(jid, INITIAL_INGESTION_CURSOR, 'Assistant')[0],
    );
    saveMessageIngestionState(cursor, { [jid]: cursor });
    createTask({
      id: 'ordinary-task',
      group_folder: 'synthetic',
      chat_jid: jid,
      prompt: 'ordinary task',
      schedule_type: 'once',
      schedule_value: '2026-12-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-12-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    getDb()
      .exec(`CREATE TABLE unrelated_user_state(id TEXT PRIMARY KEY, value TEXT);
      INSERT INTO unrelated_user_state VALUES('keep', 'unchanged');
      INSERT INTO sessions(group_folder, session_id) VALUES('synthetic', 'ordinary-session');
      INSERT INTO observed_whatsapp_messages(message_id, chat_jid, timestamp, observed_at)
        VALUES('passive', 'synthetic@s.whatsapp.net', '2026-01-01', '2026-01-01');`);
    const preservedTables = [
      'messages',
      'message_metadata',
      'message_ingestion',
      'router_state',
      'scheduled_tasks',
      'sessions',
      'observed_whatsapp_messages',
      'unrelated_user_state',
    ];
    const snapshot = () =>
      Object.fromEntries(
        preservedTables.map((table) => [
          table,
          getDb().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ]),
      );
    const before = snapshot();
    addRetiredFixtures();
    createSchema(getDb());
    expect(
      tableNames().filter((name) => name.startsWith('whatsapp_campaign_')),
    ).toEqual([]);
    expect(snapshot()).toEqual(before);
    createSchema(getDb());
    dropRetiredWhatsAppCampaignData(getDb());
    expect(snapshot()).toEqual(before);
    expect(loadMessageIngestionState().agentCursors[jid]).toBe(cursor);
    storeMessage(message('late-same-second'));
    expect(getMessagesSince(jid, cursor, 'Assistant').map((m) => m.id)).toEqual(
      ['late-same-second'],
    );
    expect(getDb().pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('rolls back all drops when cleanup fails and supports a safe repeat', () => {
    addRetiredFixtures();
    const database = getDb();
    const originalExec = database.exec.bind(database);
    const spy = vi.spyOn(database, 'exec').mockImplementation((sql) => {
      if (sql.includes('DROP TABLE IF EXISTS whatsapp_campaign_leads')) {
        throw new Error('synthetic migration failure');
      }
      return originalExec(sql);
    });
    try {
      expect(() => dropRetiredWhatsAppCampaignData(database)).toThrow(
        'synthetic migration failure',
      );
      expect(tableNames()).toEqual(expect.arrayContaining(retiredTables));
      expect(
        database.prepare('SELECT value FROM whatsapp_campaign_decisions').get(),
      ).toEqual({ value: 'retired' });
    } finally {
      spy.mockRestore();
    }
    dropRetiredWhatsAppCampaignData(database);
    dropRetiredWhatsAppCampaignData(database);
    expect(
      tableNames().filter((name) => name.startsWith('whatsapp_campaign_')),
    ).toEqual([]);
  });
});
