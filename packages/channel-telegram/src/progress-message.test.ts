import { describe, expect, it, vi } from 'vitest';
import { ProgressMessages } from './progress-message.js';

describe('one progress message per turn', () => {
  function fixture() {
    return {
      chat: 'chat-a',
      turn: 'turn-a',
      send: vi.fn().mockResolvedValue(10),
      edit: vi.fn().mockResolvedValue(undefined),
    };
  }
  it('serializes concurrent statuses into one message and keeps the newest text', async () => {
    const messages = new ProgressMessages();
    const f = fixture();
    await Promise.all(
      ['Starting', 'Checking', 'Finishing'].map((text) =>
        messages.update({ ...f, text }),
      ),
    );
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.edit.mock.calls.map((args) => args.slice(0, 2))).toEqual([
      [10, 'Checking'],
      [10, 'Finishing'],
    ]);
  });
  it('separates chats and turns and skips identical text', async () => {
    const messages = new ProgressMessages();
    const f = fixture();
    await messages.update({ ...f, text: 'Working' });
    await messages.update({ ...f, text: 'Working' });
    await messages.update({ ...f, turn: 'turn-b', text: 'Working' });
    await messages.update({ ...f, chat: 'chat-b', text: 'Working' });
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(f.edit).not.toHaveBeenCalled();
  });
  it('does not invent delivery or duplicate a message on ambiguous edit failure', async () => {
    const messages = new ProgressMessages();
    const f = fixture();
    await messages.update({ ...f, text: 'Starting' });
    f.edit.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(messages.update({ ...f, text: 'Checking' })).rejects.toThrow(
      'ENOTFOUND',
    );
    expect(f.send).toHaveBeenCalledTimes(1);
    await messages.update({ ...f, text: 'Checking' });
    expect(f.edit).toHaveBeenCalledTimes(2);
  });
  it('replaces a definitely deleted progress message', async () => {
    const messages = new ProgressMessages();
    const f = fixture();
    await messages.update({ ...f, text: 'Starting' });
    f.edit.mockRejectedValueOnce({
      description: 'Bad Request: message to edit not found',
    });
    await messages.update({ ...f, text: 'Checking' });
    expect(f.send.mock.calls.map((args) => args.slice(0, 1))).toEqual([['Starting'], ['Checking']]);
  });
  it('accepts Telegram not-modified without sending a new message', async () => {
    const messages = new ProgressMessages();
    const f = fixture();
    await messages.update({ ...f, text: 'Starting' });
    f.edit.mockRejectedValueOnce({
      description: 'Bad Request: message is not modified',
    });
    await messages.update({ ...f, text: 'Checking' });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('aborts and drains a pending status before final delivery; queued statuses skip', async () => {
    const messages = new ProgressMessages();
    const f = fixture();
    let finishSend!: (id: number) => void;
    let signal!: AbortSignal;
    f.send.mockImplementation((_text, pendingSignal) => {
      signal = pendingSignal;
      return new Promise((resolve) => { finishSend = resolve; });
    });
    const first = messages.update({ ...f, text: 'Starting' });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    const queued = messages.update({ ...f, text: 'Later status' });
    const final = vi.fn();
    const finishing = messages.finish(f.chat, f.turn).then(final);
    expect(signal.aborted).toBe(true);
    expect(final).not.toHaveBeenCalled();
    finishSend(10);
    expect(await first).toBe(false);
    expect(await queued).toBe(false);
    await finishing;
    expect(final).toHaveBeenCalledOnce();
    expect(f.edit).not.toHaveBeenCalled();
    expect(await messages.update({ ...f, text: 'Too late' })).toBe(false);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('remembers a finished turn even if its first progress was delayed', async () => {
    const messages = new ProgressMessages();
    const f = fixture();
    await messages.finish(f.chat, f.turn);
    expect(await messages.update({ ...f, text: 'Late first status' })).toBe(false);
    expect(await messages.update({ ...f, turn: 'next-turn', text: 'Working' })).toBe(true);
    expect(await messages.update({ ...f, chat: 'other-chat', text: 'Working' })).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('treats transport cancellation as skipped rather than delivered progress', async () => {
    const messages = new ProgressMessages();
    const f = fixture();
    f.send.mockImplementation((_text, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const pending = messages.update({ ...f, text: 'Starting' });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    await messages.finish(f.chat, f.turn);
    expect(await pending).toBe(false);
  });

  it('does not repeat an initial send whose outcome is unknown', async () => {
    const messages = new ProgressMessages();
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error('response lost'));
    await expect(messages.update({ ...f, text: 'Starting' })).rejects.toThrow('response lost');
    expect(await messages.update({ ...f, text: 'Checking' })).toBe(false);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('bounds retained messages and completed-turn tombstones', async () => {
    const messages = new ProgressMessages();
    const f = fixture();
    for (let i = 0; i < 300; i++) {
      await messages.update({ ...f, turn: `t-${i}`, text: 'Working' });
    }
    expect((messages as any).entries.size).toBeLessThanOrEqual(256);
    for (let i = 0; i < 300; i++) await messages.finish(f.chat, `t-${i}`);
    expect((messages as any).closed.size).toBeLessThanOrEqual(256);
    expect((messages as any).chains.size).toBe(0);
    expect((messages as any).controllers.size).toBe(0);
  });
});
