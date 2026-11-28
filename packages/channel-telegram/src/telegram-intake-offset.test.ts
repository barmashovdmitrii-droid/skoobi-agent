import { Bot, type BotConfig, type Context, type Transformer } from 'grammy';
import { describe, expect, it } from 'vitest';
import { MediaIntakePersistenceError } from '@skoobi/shared/media-intake';

describe('grammY durable acceptance acknowledgement boundary', () => {
  it('does not acknowledge an unsaved update when the persistence failure propagates', async () => {
    const offsets: number[] = [];
    const bot = new Bot('123:synthetic-token', {
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: 'Fixture',
        username: 'fixture_bot',
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
      },
      client: {
        fetch: (() => {
          throw new Error('Network prohibited in this fixture');
        }) as unknown as NonNullable<BotConfig<Context>['client']>['fetch'],
      },
    });
    bot.api.config.use((async (_previous, method, payload) => {
      if (method === 'deleteWebhook') return { ok: true, result: true };
      if (method !== 'getUpdates')
        throw new Error('Unexpected fixture request');
      offsets.push((payload as { offset: number }).offset);
      return {
        ok: true,
        result: [
          {
            update_id: 17,
            message: {
              message_id: 5,
              date: 1,
              chat: { id: 101, type: 'private', first_name: 'Fixture' },
              from: { id: 102, is_bot: false, first_name: 'Fixture' },
              voice: {
                file_id: 'fixture-file',
                file_unique_id: 'fixture-unique',
                duration: 1,
              },
            },
          },
        ],
      };
    }) as Transformer);
    bot.on('message:voice', () => {
      throw new MediaIntakePersistenceError();
    });
    bot.catch((error) => {
      throw error;
    });
    await expect(bot.start()).rejects.toMatchObject({
      error: expect.any(MediaIntakePersistenceError),
    });
    expect(bot.isRunning()).toBe(false);
    await bot.stop(); // after loop exit, cleanup cannot advance the offset either.
    expect(offsets).toEqual([1]);
  });
});
