import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitProgressDelivery, sendLongRunProgressNotice } from './message-loop.js';

afterEach(() => vi.useRealTimers());

describe('progress delivery receipts', () => {
  it('does not confuse a timeout or a dropped envelope with confirmed delivery', async () => {
    vi.useFakeTimers();
    const pending = awaitProgressDelivery(new Promise(() => {}));
    const check = expect(pending).rejects.toThrow('Progress delivery timed out');
    await vi.advanceTimersByTimeAsync(9000);
    await check;
    expect(await awaitProgressDelivery(Promise.resolve(null))).toBe(false);
    expect(await awaitProgressDelivery(Promise.resolve('delivered'))).toBe(true);
  });

  it('routes a host heartbeat to the same editable turn status as model progress', async () => {
    const route = vi.fn().mockResolvedValue('delivered'); const send = vi.fn();
    expect(await sendLongRunProgressNotice({
      chatJid: 'tg:123', elapsedMs: 600000, noticeIndex: 2, progressKey: 'turn-1',
      currentStep: 'Checking the saved file',
      registeredGroups: { 'tg:123': { name: 'Test', folder: 'test', trigger: '', added_at: '', requiresTrigger: false } },
      router: { send, route },
    })).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(route).toHaveBeenCalledWith(expect.objectContaining({
      chatJid: 'tg:123', meta: { kind: 'host_progress', progressKey: 'turn-1' },
    }));
  });

  it('«всё ещё работаю» в чате владельца подсказывает «стоп», у гостя — нет (W23-ост-а)', async () => {
    const texts: string[] = [];
    const route = vi.fn(async (input: { text: string }) => {
      texts.push(input.text);
      return 'delivered';
    });
    const group = { name: 'Test', folder: 'test', trigger: '', added_at: '', requiresTrigger: false };
    for (const isMain of [true, false]) {
      await sendLongRunProgressNotice({
        chatJid: 'tg:123', elapsedMs: 600000, noticeIndex: 2, progressKey: 'turn-1',
        registeredGroups: { 'tg:123': { ...group, isMain } },
        router: { send: vi.fn(), route },
      });
    }
    expect(texts[0]).toBe('⏳ Всё ещё работаю, уже 10 мин.\nОстановить — напиши «стоп».');
    expect(texts[1]).toBe('⏳ Всё ещё работаю, уже 10 мин.');
  });

  it('в WhatsApp владельца подсказки «стоп» нет: там хост его не ловит (ревью r1111)', async () => {
    const texts: string[] = [];
    const route = vi.fn(async (input: { text: string }) => {
      texts.push(input.text);
      return 'delivered';
    });
    const group = { name: 'Test', folder: 'test', trigger: '', added_at: '', requiresTrigger: false, isMain: true };
    for (const chatJid of ['77000000000@s.whatsapp.net', '120363012345678901@g.us']) {
      await sendLongRunProgressNotice({
        chatJid, elapsedMs: 600000, noticeIndex: 2, progressKey: 'turn-1',
        registeredGroups: { [chatJid]: group },
        router: { send: vi.fn(), route },
      });
    }
    expect(texts).toEqual(['⏳ Всё ещё работаю, уже 10 мин.', '⏳ Всё ещё работаю, уже 10 мин.']);
  });

  it('does not claim a host status was delivered when a hook dropped it', async () => {
    expect(await sendLongRunProgressNotice({
      chatJid: 'tg:123', elapsedMs: 600000, noticeIndex: 2, progressKey: 'turn-1',
      registeredGroups: { 'tg:123': { name: 'Test', folder: 'test', trigger: '', added_at: '', requiresTrigger: false } },
      router: { send: vi.fn(), route: vi.fn().mockResolvedValue(null) },
    })).toBe(false);
  });
});
