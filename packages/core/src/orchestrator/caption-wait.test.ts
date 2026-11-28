/**
 * W31: человек получает по два ответа на одну мысль. Фото, видео или документ
 * без текста — запуск ждёт подпись до 12 с (голосовое и пересланное — нет);
 * повтор того же ответа и «молчаливый» догоняющий ход хост не отправляет, если
 * прошлый ответ этого запуска доставлен. Всё это выключено, пока чат не
 * указан в .env (решение владельца).
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import { CAPTION_WAIT_MS, captionWaitRemainingMs } from './caption-wait.js';
import { STATE_ROOT } from './config.js';
import {
  captionWaitEnabledForGroup,
  followUpSilenceEnabledForGroup,
} from './live-mode.js';
import type { NewMessage } from './types.js';

const NOW = Date.parse('2026-11-06T18:39:50.000Z');

function message(
  content: string,
  secondsAgo: number,
  origin: 'direct' | 'forwarded' = 'direct',
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: `m-${content.length}-${secondsAgo}`,
    chat_jid: 'tg:admin',
    sender: 'admin',
    sender_name: 'Admin',
    content,
    timestamp: new Date(NOW - secondsAgo * 1000).toISOString(),
    is_bot_message: false,
    sender_identity: {
      channel: 'telegram',
      chat_id: 'admin',
      telegram_user_id: 'admin',
      identity_id: 'telegram:admin',
      is_owner_sender: true,
      telegram_message_origin: origin,
    },
    ...overrides,
  };
}

const PHOTO = '[Photo. File: received/2026-11-01T16-32-08-627Z-FixtureA.jpg — use Read tool to inspect visual context]';

describe('caption wait', () => {
  it('photo without text, 3 s ago: wait the remaining 9 s', () => {
    expect(captionWaitRemainingMs([message(PHOTO, 3)], NOW)).toBe(9_000);
  });

  it('a document without text waits; a voice note is the request itself and does not', () => {
    expect(captionWaitRemainingMs([message('[Document: дело.pdf. File: received/x.pdf]', 0)], NOW)).toBe(CAPTION_WAIT_MS);
    // In two months only 6 % of one chat's voice notes had anything within 12 s.
    expect(captionWaitRemainingMs([message('[Voice: Скажи, куда подключать?]', 1)], NOW)).toBe(0);
    expect(captionWaitRemainingMs([message('[Video note: привет]', 1)], NOW)).toBe(0);
    expect(captionWaitRemainingMs([message('[Audio: запись.m4a]', 1)], NOW)).toBe(0);
    // A photo right after a voice note still waits for its caption.
    expect(
      captionWaitRemainingMs([message('[Voice: смотри]', 3), message(PHOTO, 2)], NOW),
    ).toBe(10_000);
  });

  it('forwarded news does not wait — merged with «Это правда?» it would be read-only', () => {
    expect(
      captionWaitRemainingMs([message('Налоговая России выигрывает уже 95% споров', 2, 'forwarded')], NOW),
    ).toBe(0);
    expect(captionWaitRemainingMs([message(PHOTO, 2, 'forwarded')], NOW)).toBe(0);
  });

  it('no wait: photo with a caption, text after it, old photo, album with its caption', () => {
    expect(captionWaitRemainingMs([message(`${PHOTO} Что выбрать?`, 1)], NOW)).toBe(0);
    expect(captionWaitRemainingMs([message(PHOTO, 9), message('Что выбрать', 0)], NOW)).toBe(0);
    expect(captionWaitRemainingMs([message(PHOTO, 15)], NOW)).toBe(0);
    expect(
      captionWaitRemainingMs([message(`${PHOTO} Какой из двух?`, 2), message(PHOTO, 2)], NOW),
    ).toBe(0);
    expect(captionWaitRemainingMs([message('Привет', 1)], NOW)).toBe(0);
    expect(captionWaitRemainingMs([], NOW)).toBe(0);
  });

  it('a bot line after the photo does not count as the last message', () => {
    expect(
      captionWaitRemainingMs(
        [message(PHOTO, 2), message('⏳ Смотрю фото', 1, 'direct', { is_bot_message: true })],
        NOW,
      ),
    ).toBe(10_000);
  });
});

describe('W31 switches', () => {
  it('off by default (owner decides); the env list, «off» and the kill switch work', () => {
    const keys = ['SKOOBI_CAPTION_WAIT_GROUPS', 'SKOOBI_FOLLOW_UP_SILENCE_GROUPS'] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const kill = path.join(STATE_ROOT, 'store', 'caption-wait.disabled');
    try {
      for (const key of keys) delete process.env[key];
      // The corrected proposal (specs W31): not now — nowhere until listed.
      expect(captionWaitEnabledForGroup('telegram_admin')).toBe(false);
      expect(captionWaitEnabledForGroup('telegram_main')).toBe(false);
      expect(followUpSilenceEnabledForGroup('telegram_admin')).toBe(false);
      expect(followUpSilenceEnabledForGroup('telegram_main')).toBe(false);
      process.env.SKOOBI_CAPTION_WAIT_GROUPS = 'telegram_admin';
      process.env.SKOOBI_FOLLOW_UP_SILENCE_GROUPS = 'telegram_admin';
      expect(captionWaitEnabledForGroup('telegram_admin')).toBe(true);
      expect(captionWaitEnabledForGroup('telegram_main')).toBe(false);
      expect(followUpSilenceEnabledForGroup('telegram_admin')).toBe(true);
      process.env.SKOOBI_CAPTION_WAIT_GROUPS = 'telegram_main,telegram_admin';
      expect(captionWaitEnabledForGroup('telegram_main')).toBe(true);
      process.env.SKOOBI_FOLLOW_UP_SILENCE_GROUPS = 'off';
      expect(followUpSilenceEnabledForGroup('telegram_admin')).toBe(false);
      fs.mkdirSync(path.dirname(kill), { recursive: true });
      fs.writeFileSync(kill, '');
      expect(captionWaitEnabledForGroup('telegram_admin')).toBe(false);
    } finally {
      fs.rmSync(kill, { force: true });
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});

// The first test of a file imports the whole dispatcher: slow on a loaded host.
const DISPATCHER_TIMEOUT_MS = 30_000;

describe('W31 in the real dispatcher', () => {
  async function setup(folder: string, chatJid: string) {
    const db = await import('./db.js');
    const runtime = await import('../runtimes/sandbox-runner.js');
    const loop = await import('./message-loop.js');
    const group = {
      name: 'Admin', folder, trigger: '@test', added_at: '2026-01-01T00:00:00Z',
      requiresTrigger: false, isMain: true, runtime: 'sandbox' as const,
      agentConfig: { fullAccess: true },
    };
    const channel = {
      name: 'w31-test', ownsJid: (jid: string) => jid === chatJid,
      isConnected: () => true, setTyping: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
    };
    const routed: string[] = [];
    const router = {
      send: vi.fn(async (_jid: string, text: string) => { routed.push(text); }),
      route: vi.fn(async (envelope: { text: string }) => {
        const text = envelope.text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        if (!text) return null;
        routed.push(text);
        return text;
      }),
    };
    db.initDatabase();
    db.setRegisteredGroup(chatJid, group);
    loop._setRegisteredGroups({ [chatJid]: group });
    loop._setChannelsForTest([channel as never]);
    const store = (id: string, content: string, at: number) =>
      db.storeMessage({
        id, chat_jid: chatJid, sender: chatJid.slice(3), sender_name: 'Admin', content,
        timestamp: new Date(at).toISOString(), sender_identity: {
          channel: 'telegram', chat_id: chatJid.slice(3), telegram_user_id: chatJid.slice(3),
          identity_id: `telegram:${chatJid.slice(3)}`, bot_id: 'test', is_owner_sender: true,
          telegram_message_origin: 'direct',
        },
      });
    return { db, loop, runtime, router, routed, store };
  }

  function withEnv(values: Record<string, string>, body: () => Promise<void>) {
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
    return body().finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.restoreAllMocks();
    });
  }

  it('photo first: no run yet; the caption 9 s later starts one run for both', () =>
    withEnv({ SKOOBI_CAPTION_WAIT_GROUPS: 'w31-caption' }, async () => {
      const chatJid = 'tg:100000001';
      const { loop, runtime, router, store } = await setup('w31-caption', chatJid);
      const prompts: string[] = [];
      vi.spyOn(runtime, 'runSandboxAgent').mockImplementation((async (_g: unknown, input: { prompt: string }) => {
        prompts.push(input.prompt);
        return { status: 'success' as const, result: null };
      }) as never);
      const now = Date.now();
      store('26993', PHOTO, now - 1_000);
      expect(await loop.processGroupMessages(chatJid, router as never)).toBe(true);
      expect(prompts).toHaveLength(0);
      store('26994', 'Что выбрать', now);
      await loop.processGroupMessages(chatJid, router as never);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('Что выбрать');
      expect(prompts[0]).toContain('FixtureA.jpg');
    }), DISPATCHER_TIMEOUT_MS);

  it('a catch-up turn that stays silent or repeats the delivered answer sends nothing more', () =>
    withEnv({
      SKOOBI_SANDBOX_CODEX_PRIMARY: 'true',
      SKOOBI_CAPTION_WAIT_GROUPS: 'off',
      SKOOBI_FOLLOW_UP_SILENCE_GROUPS: 'w31-silence',
    }, async () => {
      const chatJid = 'tg:100000002';
      const { loop, runtime, router, routed, store } = await setup('w31-silence', chatJid);
      const answer = 'Выбирай динамический IP: роутер сам получит адрес.';
      vi.spyOn(runtime, 'runSandboxAgent').mockImplementation((async (
        _g: unknown, _input: unknown, _onProcess: unknown,
        onOutput?: (output: Record<string, unknown>) => Promise<void>,
      ) => {
        await onOutput?.({ status: 'success', result: answer });
        await onOutput?.({ status: 'success', result: answer, repeatsPreviousAnswer: true });
        await onOutput?.({ status: 'success', result: '<internal>уже ответил</internal>', silentFollowUp: true });
        return { status: 'success' as const, result: null };
      }) as never);
      store('26961', 'Какой тип подключения выбрать?', Date.now() - 1_000);
      await loop.processGroupMessages(chatJid, router as never);
      expect(routed).toEqual([answer]);
      // The repeat and the silence never reach the router.
      expect(router.route).toHaveBeenCalledTimes(1);
    }), DISPATCHER_TIMEOUT_MS);

  it('outside the W31 chats a repeat flagged by the runner is sent as usual', () =>
    withEnv({ SKOOBI_SANDBOX_CODEX_PRIMARY: 'true', SKOOBI_CAPTION_WAIT_GROUPS: 'off', SKOOBI_FOLLOW_UP_SILENCE_GROUPS: 'off' }, async () => {
      const chatJid = 'tg:100123';
      const { loop, runtime, router, routed, store } = await setup('w31-not-listed', chatJid);
      const answer = 'Выбирай динамический IP: роутер сам получит адрес.';
      vi.spyOn(runtime, 'runSandboxAgent').mockImplementation((async (
        _g: unknown, _input: unknown, _onProcess: unknown,
        onOutput?: (output: Record<string, unknown>) => Promise<void>,
      ) => {
        await onOutput?.({ status: 'success', result: answer });
        await onOutput?.({ status: 'success', result: answer, repeatsPreviousAnswer: true });
        return { status: 'success' as const, result: null };
      }) as never);
      store('26962', 'Какой тип подключения выбрать?', Date.now() - 1_000);
      await loop.processGroupMessages(chatJid, router as never);
      expect(routed).toEqual([answer, answer]);
    }), DISPATCHER_TIMEOUT_MS);

  it('a repeat is dropped only against the last final that went out, and only of exactly its text', () =>
    withEnv({
      SKOOBI_SANDBOX_CODEX_PRIMARY: 'true',
      SKOOBI_CAPTION_WAIT_GROUPS: 'off',
      SKOOBI_FOLLOW_UP_SILENCE_GROUPS: 'w31-last-final',
    }, async () => {
      const chatJid = 'tg:100777';
      const { loop, runtime, router, routed, store } = await setup('w31-last-final', chatJid);
      const first = 'Выбирай динамический IP: роутер сам получит адрес.';
      const second = 'И ещё: перезагрузи роутер после смены типа.';
      const other = 'Лучше статический IP, если провайдер его даёт.';
      // The second answer's send fails once.
      let failNext = false;
      const route = router.route.getMockImplementation()!;
      router.route.mockImplementation(async (envelope: { text: string }) => {
        if (failNext) {
          failNext = false;
          return null;
        }
        return route(envelope);
      });
      vi.spyOn(runtime, 'runSandboxAgent').mockImplementation((async (
        _g: unknown, _input: unknown, _onProcess: unknown,
        onOutput?: (output: Record<string, unknown>) => Promise<void>,
      ) => {
        await onOutput?.({ status: 'success', result: first });
        failNext = true;
        await onOutput?.({ status: 'success', result: second });
        // The person never got `second`: its repeat is sent.
        await onOutput?.({ status: 'success', result: second, repeatsPreviousAnswer: true });
        // Flagged as a repeat, but not the text that went out last: sent.
        await onOutput?.({ status: 'success', result: other, repeatsPreviousAnswer: true });
        // A real repeat of the last delivered final: dropped.
        await onOutput?.({ status: 'success', result: other, repeatsPreviousAnswer: true });
        return { status: 'success' as const, result: null };
      }) as never);
      store('26963', 'Какой тип подключения выбрать?', Date.now() - 1_000);
      await loop.processGroupMessages(chatJid, router as never);
      expect(routed).toEqual([first, second, other]);
    }), DISPATCHER_TIMEOUT_MS);

  it('silence after a final that did not go out is not accepted', () =>
    withEnv({
      SKOOBI_SANDBOX_CODEX_PRIMARY: 'true',
      SKOOBI_CAPTION_WAIT_GROUPS: 'off',
      SKOOBI_FOLLOW_UP_SILENCE_GROUPS: 'w31-silence-undelivered',
    }, async () => {
      const chatJid = 'tg:100999';
      const { loop, runtime, router, routed, store } = await setup('w31-silence-undelivered', chatJid);
      const first = 'Выбирай динамический IP: роутер сам получит адрес.';
      const second = 'И ещё: перезагрузи роутер после смены типа.';
      let failNext = false;
      const route = router.route.getMockImplementation()!;
      router.route.mockImplementation(async (envelope: { text: string }) => {
        if (failNext) {
          failNext = false;
          return null;
        }
        return route(envelope);
      });
      const silent = vi.fn();
      vi.spyOn(runtime, 'runSandboxAgent').mockImplementation((async (
        _g: unknown, _input: unknown, _onProcess: unknown,
        onOutput?: (output: Record<string, unknown>) => Promise<void>,
      ) => {
        await onOutput?.({ status: 'success', result: first });
        failNext = true;
        await onOutput?.({ status: 'success', result: second });
        await onOutput?.({ status: 'success', result: '<internal>уже ответил</internal>', silentFollowUp: true });
        silent();
        return { status: 'success' as const, result: null };
      }) as never);
      store('26964', 'Какой тип подключения выбрать?', Date.now() - 1_000);
      await loop.processGroupMessages(chatJid, router as never);
      expect(silent).toHaveBeenCalled();
      expect(routed).toEqual([first]);
      // Not taken as covered: the silent final goes the usual way (and sends
      // nothing, being <internal>), so the messages stay unanswered.
      expect(router.route).toHaveBeenCalledTimes(3);
    }), DISPATCHER_TIMEOUT_MS);

  it('silence before any delivered answer is not accepted as an answer', () =>
    withEnv({ SKOOBI_SANDBOX_CODEX_PRIMARY: 'true', SKOOBI_CAPTION_WAIT_GROUPS: 'off', SKOOBI_FOLLOW_UP_SILENCE_GROUPS: 'w31-silence-first' }, async () => {
      const chatJid = 'tg:100000003';
      const { db, loop, runtime, router, routed, store } = await setup('w31-silence-first', chatJid);
      vi.spyOn(runtime, 'runSandboxAgent').mockImplementation((async (
        _g: unknown, _input: unknown, _onProcess: unknown,
        onOutput?: (output: Record<string, unknown>) => Promise<void>,
      ) => {
        await onOutput?.({ status: 'success', result: '<internal>уже ответил</internal>', silentFollowUp: true });
        return { status: 'success' as const, result: null };
      }) as never);
      store('27001', 'Это правда?', Date.now() - 1_000);
      const before = db.loadMessageIngestionState();
      await loop.processGroupMessages(chatJid, router as never);
      expect(routed).toEqual([]);
      // The question was not marked answered: it stays for the next run.
      expect(db.loadMessageIngestionState()).toEqual(before);
    }), DISPATCHER_TIMEOUT_MS);
});
