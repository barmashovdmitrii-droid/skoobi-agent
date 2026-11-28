import fs from 'node:fs';
import path from 'node:path';
import { Api, Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { synthesizeVoice } from '@skoobi/voice-tts';
import { DATA_DIR } from './channel-config.js';
import { TelegramChannel, type TelegramChannelHost } from './telegram.js';

vi.mock('./channel-config.js', async (importOriginal) => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'telegram-edit-test-'));
  return {
    ...await importOriginal<typeof import('./channel-config.js')>(),
    DATA_DIR: root,
    GROUPS_DIR: join(root, 'groups'),
  };
});

vi.mock('@skoobi/voice-tts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@skoobi/voice-tts')>(),
  synthesizeVoice: vi.fn(),
}));

const me: UserFromGetMe = {
  id: 910, is_bot: true, first_name: 'Bot', username: 'fixture_bot',
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false,
};
const jid = 'tg:fixture:901';
const original = {
  message_id: 7, date: 1770000000,
  from: { id: 901, is_bot: false, first_name: 'Fixture' },
  chat: { id: 901, type: 'private' as const, first_name: 'Fixture' },
  text: 'Previous value',
};

let channel: TelegramChannel;
async function fixture(failedPoll?: 'original' | 'edit' | 'metadata') {
  let bot!: Bot;
  const apiCall = vi.fn(() => { throw new Error('Unexpected Telegram API call'); });
  vi.spyOn(Api.prototype, 'setMyCommands').mockResolvedValue(true);
  const start = Bot.prototype.start;
  const offsets: number[] = [];
  let polling: Promise<void> | undefined;
  vi.spyOn(Bot.prototype, 'start').mockImplementation(async function (this: Bot, options) {
    bot = this;
    bot.botInfo = me;
    bot.api.config.use(apiCall);
    if (failedPoll) {
      vi.spyOn(bot.api, 'deleteWebhook').mockResolvedValue(true);
      vi.spyOn(bot.api, 'getUpdates').mockImplementation(async options => {
        if (offsets.length || typeof options?.offset !== 'number') throw new Error('Unexpected polling request');
        offsets.push(options.offset);
        const update: Update = failedPoll === 'edit'
          ? { update_id: 18, edited_message: { ...original, edit_date: original.date + 3, text: 'Updated' } }
          : { update_id: 17, message: original };
        return [update];
      });
      polling = start.call(this, options);
      return polling;
    }
    await options?.onStart?.(me);
  });
  if (!failedPoll) vi.spyOn(Bot.prototype, 'stop').mockResolvedValue();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const onMessage = vi.fn(), onTelegramMessageEdit = vi.fn(), onChatMetadata = vi.fn();
  if (failedPoll) {
    const callback = failedPoll === 'edit' ? onTelegramMessageEdit : failedPoll === 'metadata' ? onChatMetadata : onMessage;
    callback.mockImplementation(() => { throw new Error('synthetic storage detail'); });
  }
  const host = {
    privateAdminModeEnabled: () => true,
    isPrivateAdminTelegramUser: vi.fn(() => true),
  };
  channel = new TelegramChannel('synthetic', {
    botId: 'fixture', personaId: 'fixture-persona',
    host: host as unknown as TelegramChannelHost,
    onMessage, onTelegramMessageEdit, onChatMetadata,
    registeredGroups: () => ({
      [jid]: { folder: 'fixture-group', name: 'Fixture', trigger: '', added_at: '2025-01-01T00:00:00Z' },
    }),
  });
  await channel.connect();
  const edit = (changes: Record<string, unknown>, key = 'edited_message') =>
    bot.handleUpdate({
      update_id: 18,
      [key]: { ...original, edit_date: original.date + 3, text: 'Updated value', ...changes },
    } as Update);
  return { bot, edit, onMessage, onTelegramMessageEdit, onChatMetadata, apiCall, host, polling, offsets };
}

afterEach(async () => {
  await channel?.disconnect();
  vi.restoreAllMocks();
  for (const file of fs.readdirSync(DATA_DIR)) {
    fs.rmSync(path.join(DATA_DIR, file), { recursive: true, force: true });
  }
});
afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

describe('Telegram text edits through grammY', () => {
  it('binds the ordinary message and sends its edit to the same registered profile without a second intake', async () => {
    const f = await fixture();
    await f.bot.handleUpdate({ update_id: 17, message: original });
    const inbox = path.join(DATA_DIR, 'telegram-inbox', 'fixture-group.jsonl');
    const access = path.join(DATA_DIR, 'telegram-access-control.json');
    const oldInbox = fs.readFileSync(inbox), oldAccess = fs.readFileSync(access);
    await f.edit({});
    expect(f.onMessage).toHaveBeenCalledTimes(1);
    const [, first] = f.onMessage.mock.calls[0];
    expect(first).toMatchObject({
      id: '7', sender: '901', chat_jid: jid, content: original.text, telegram_update_id: '17',
      telegram_editable: true, telegram_receiver_id: String(me.id), telegram_edit_group_folder: 'fixture-group',
    });
    expect(f.onTelegramMessageEdit).toHaveBeenCalledExactlyOnceWith(jid, {
      ...first, content: 'Updated value', telegram_update_id: '18',
    }, original.date + 3);
    expect(f.onChatMetadata).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(inbox)).toEqual(oldInbox);
    expect(fs.readFileSync(access)).toEqual(oldAccess);
    expect(f.apiCall).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown chat', { from: { ...original.from, id: 902 }, chat: { ...original.chat, id: 902 } }],
    ['different DM sender', { from: { ...original.from, id: 902 } }],
    ['bot sender', { from: { ...original.from, is_bot: true } }],
    ['group', { chat: { ...original.chat, type: 'supergroup' } }],
    ['forward by the sender', { forward_origin: { type: 'user', sender_user: original.from } }],
    ['inline bot', { via_bot: me }],
    ['business sender', { sender_business_bot: me }],
    ['sender chat', { sender_chat: original.chat }],
    ['external reply', { external_reply: { origin: { type: 'channel' } } }],
    ['native quote', { quote: { text: 'Quoted', position: 0 } }],
    ['caption', { text: undefined, caption: 'Updated caption', photo: [] }],
    ['edit before original date', { edit_date: original.date - 1 }],
  ])('ignores an edit from an ineligible source (%s)', async (_name, fields) => {
    const f = await fixture();
    await f.edit(fields as Record<string, unknown>);
    expect(f.onTelegramMessageEdit).not.toHaveBeenCalled();
    expect(f.onMessage).not.toHaveBeenCalled();
    expect(f.onChatMetadata).not.toHaveBeenCalled();
    expect(f.apiCall).not.toHaveBeenCalled();
  });

  it('withholds editable blockquote contents and keeps a quoted original outside direct text bindings', async () => {
    const f = await fixture();
    await f.bot.handleUpdate({ update_id: 17, message: original });
    expect(f.onMessage.mock.calls[0][1].telegram_editable).toBe(true);
    const entities = [{ type: 'blockquote' as const, offset: 0, length: 4 }];
    await f.edit({ entities });
    expect(f.onTelegramMessageEdit).toHaveBeenCalledExactlyOnceWith(jid, expect.objectContaining({
      telegram_editable: false, telegram_edit_local_quote: true, content: '', sender_identity: expect.objectContaining({ telegram_message_origin: 'quoted' }),
    }), original.date + 3);
    await f.bot.handleUpdate({ update_id: 19, message: { ...original, message_id: 8, entities } });
    expect(f.onMessage.mock.calls[1][1].telegram_editable).toBeUndefined();
    expect(f.onMessage.mock.calls[1][1].telegram_edit_local_quote).toBeUndefined();
    expect(f.apiCall).not.toHaveBeenCalled();
  });

  it.each(['edited_channel_post', 'edited_business_message'])('ignores %s', async (key) => {
    const f = await fixture();
    await f.edit({}, key);
    expect(f.onTelegramMessageEdit).not.toHaveBeenCalled();
    expect(f.onMessage).not.toHaveBeenCalled();
    expect(f.apiCall).not.toHaveBeenCalled();
  });

  it.each([
    ['registered command', '/start', [{ type: 'bot_command', offset: 0, length: 6 }]],
    ['unknown annotated command', '/fixture', [{ type: 'bot_command', offset: 0, length: 8 }]],
    ['plain stop command', '/stop', []],
    ['desktop command', '/remote-control', []],
    ['privacy intent', 'удали всю память', []],
  ])('withholds command text from an authenticated edit (%s)', async (_name, text, entities) => {
    const f = await fixture();
    await f.edit({ text, entities });
    expect(f.onTelegramMessageEdit).toHaveBeenCalledExactlyOnceWith(jid,
      expect.objectContaining({ content: '', telegram_editable: false }), original.date + 3);
    expect(f.apiCall).not.toHaveBeenCalled();
    expect(f.onMessage).not.toHaveBeenCalled();
  });

  it.each(['/tmp', '/fixtures/input.txt'])('preserves an unmarked file path (%s)', async (text) => {
    const f = await fixture();
    await f.edit({ text });
    expect(f.onTelegramMessageEdit).toHaveBeenCalledExactlyOnceWith(jid,
      expect.objectContaining({ content: text, telegram_editable: true }), original.date + 3);
  });

  it('rechecks current private-admin authorization before forwarding an edit', async () => {
    const f = await fixture();
    f.host.isPrivateAdminTelegramUser.mockReturnValue(false);
    await f.edit({});
    expect(f.onTelegramMessageEdit).not.toHaveBeenCalled();
    expect(f.apiCall).not.toHaveBeenCalled();
  });

  it.each(['paused', 'banned', 'bad-date'])('respects the current guest access state (%s)', async (status) => {
    const f = await fixture();
    const access = path.join(DATA_DIR, 'telegram-access-control.json');
    const state = status === 'bad-date' ? { deferAgentUntil: 'invalid' } : { status };
    fs.writeFileSync(access, JSON.stringify({ [jid]: state }));
    await f.edit({});
    expect(f.onTelegramMessageEdit).not.toHaveBeenCalled();
    expect(f.onMessage).not.toHaveBeenCalled();
    expect(f.apiCall).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(access, 'utf8'))).toEqual({ [jid]: state });
  });

  it('updates a deferred text without clearing the hold or counting a second intake', async () => {
    const f = await fixture();
    const access = path.join(DATA_DIR, 'telegram-access-control.json');
    const hold = new Date(Date.now() + 60_000).toISOString();
    fs.writeFileSync(access, JSON.stringify({ [jid]: { deferAgentUntil: hold } }));
    await f.bot.handleUpdate({ update_id: 17, message: original });
    const previous = fs.readFileSync(access, 'utf8');
    await f.edit({});
    expect(f.onMessage.mock.calls[0][1].telegram_editable).toBe(true);
    expect(f.onTelegramMessageEdit).toHaveBeenCalledExactlyOnceWith(jid, expect.objectContaining({
      telegram_editable: true, content: 'Updated value',
    }), original.date + 3);
    expect(fs.readFileSync(access, 'utf8')).toBe(previous);
    expect(JSON.parse(previous)[jid].deferAgentUntil).toBe(hold);
    expect(f.apiCall).not.toHaveBeenCalled();
  });

  it('rechecks a turn after synthesis before sending the voice file', async () => {
    await fixture();
    let current = true;
    const cleanup = vi.fn();
    vi.mocked(synthesizeVoice).mockImplementationOnce(async () => {
      current = false;
      return { files: ['fixture.ogg'], cleanup } as Awaited<ReturnType<typeof synthesizeVoice>>;
    });
    const api = vi.spyOn(Api.prototype, 'sendVoice');
    await expect(channel.sendVoice(jid, 'Synthetic voice', { canSend: () => current })).rejects.toThrow('saved_final_superseded');
    expect(api).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each(['edit', 'original', 'metadata'] as const)('stops polling before acknowledging a failed %s write', async (kind) => {
    const f = await fixture(kind);
    await expect(f.polling).rejects.toThrow(`Unable to persist Telegram text ${kind === 'edit' ? 'edit' : 'original'}`);
    if (kind === 'metadata') expect(f.onMessage).not.toHaveBeenCalled();
    expect(f.offsets).toEqual([1]);
    expect(f.bot.isRunning()).toBe(false);
    await f.bot.stop();
    expect(f.offsets).toEqual([1]);
  });
});
