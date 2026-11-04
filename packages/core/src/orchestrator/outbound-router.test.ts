import { describe, it, expect, vi } from 'vitest';
import { createMessageRouter } from './outbound-router.js';
import type { Channel, OutboundEnvelope } from './types.js';

function mockChannel(name: string, jidPrefix: string): Channel {
  return {
    name,
    connect: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    ownsJid: (jid: string) => jid.startsWith(jidPrefix),
    disconnect: vi.fn(),
  };
}

describe('MessageRouter', () => {
  it('drains only the explicitly finished progress turn before sending its final', async () => {
    const channel = mockChannel('telegram', 'tg:');
    const calls: string[] = [];
    let release!: () => void;
    channel.finishProgress = vi.fn().mockImplementation(async (_jid, key) => {
      calls.push(`finish:${key}`);
      await new Promise<void>((resolve) => { release = resolve; });
    });
    channel.sendMessage = vi.fn().mockImplementation(async () => { calls.push('final'); });
    const router = createMessageRouter([channel]);
    const pending = router.route({ chatJid: 'tg:123', text: 'Done', triggerType: 'agent-response',
      meta: { progressKey: 'turn-1', progressFinal: true } });
    await vi.waitFor(() => expect(channel.finishProgress).toHaveBeenCalledOnce());
    expect(calls).toEqual(['finish:turn-1']);
    release();
    expect(await pending).toBe('Done');
    expect(calls).toEqual(['finish:turn-1', 'final']);
  });

  it('does not close live progress for an unrelated background result', async () => {
    const channel = mockChannel('telegram', 'tg:');
    channel.finishProgress = vi.fn();
    const router = createMessageRouter([channel]);
    await router.route({ chatJid: 'tg:123', text: 'Other task completed', triggerType: 'extension' });
    expect(channel.finishProgress).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledOnce();
  });

  it('does not count a closed turn status as delivered', async () => {
    const channel = mockChannel('telegram', 'tg:');
    channel.sendProgress = vi.fn().mockResolvedValue(false);
    const router = createMessageRouter([channel]);
    const observer = vi.fn(); router.addPostHook(observer);
    expect(await router.route({ chatJid: 'tg:123', text: 'Stale progress', triggerType: 'agent-response',
      meta: { kind: 'agent_progress', progressKey: 'closed' } })).toBeNull();
    expect(observer).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('updates progress in place but delivers a final answer as a separate message', async () => {
    const channel = mockChannel('telegram', 'tg:');
    channel.sendProgress = vi.fn().mockResolvedValue(true);
    const router = createMessageRouter([channel]);
    const observer = vi.fn();
    router.addPostHook(observer);
    await router.route({
      chatJid: 'tg:123',
      text: 'Starting',
      triggerType: 'agent-response',
      meta: { kind: 'agent_progress', progressKey: 'turn-1' },
    });
    await router.route({
      chatJid: 'tg:123',
      text: 'Checking',
      triggerType: 'extension',
      meta: { kind: 'host_progress', progressKey: 'turn-1' },
    });
    await router.route({
      chatJid: 'tg:123',
      text: 'Complete',
      triggerType: 'agent-response',
    });
    expect(channel.sendProgress).toHaveBeenNthCalledWith(
      1,
      'tg:123',
      'Starting',
      'turn-1',
    );
    expect(channel.sendProgress).toHaveBeenNthCalledWith(
      2,
      'tg:123',
      'Checking',
      'turn-1',
    );
    expect(channel.sendMessage).toHaveBeenCalledExactlyOnceWith(
      'tg:123',
      'Complete',
    );
    expect(observer).toHaveBeenCalledTimes(3);
  });

  it('does not report progress as delivered when its update fails', async () => {
    const channel = mockChannel('telegram', 'tg:');
    channel.sendProgress = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const router = createMessageRouter([channel]);
    const observer = vi.fn();
    router.addPostHook(observer);
    await expect(
      router.route({
        chatJid: 'tg:123',
        text: 'Starting',
        triggerType: 'agent-response',
        meta: { kind: 'agent_progress', progressKey: 'turn-1' },
      }),
    ).rejects.toThrow('ENOTFOUND');
    expect(observer).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps ordinary delivery for channels without editable progress', async () => {
    const channel = mockChannel('whatsapp', 'wa:');
    const router = createMessageRouter([channel]);
    await router.route({
      chatJid: 'wa:123',
      text: 'Working',
      triggerType: 'agent-response',
      meta: { kind: 'agent_progress', progressKey: 'turn-1' },
    });
    expect(channel.sendMessage).toHaveBeenCalledExactlyOnceWith(
      'wa:123',
      'Working',
    );
  });
  it('routes message to correct channel', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    const delivered = await router.route({
      chatJid: 'C123',
      text: 'hello',
      triggerType: 'agent-response',
    });

    expect(delivered).toBe('hello');
    expect(slack.sendMessage).toHaveBeenCalledWith('C123', 'hello');
  });

  it('strips internal tags from text', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    await router.route({
      chatJid: 'C123',
      text: 'visible <internal>hidden</internal> text',
      triggerType: 'agent-response',
    });

    expect(slack.sendMessage).toHaveBeenCalledWith('C123', 'visible  text');
  });

  it('does not deliver empty text after formatting', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    await router.route({
      chatJid: 'C123',
      text: '<internal>only internal</internal>',
      triggerType: 'agent-response',
    });

    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it('send() convenience method works', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    await router.send('C123', 'hello');

    expect(slack.sendMessage).toHaveBeenCalledWith('C123', 'hello');
  });

  it('pre-hook can drop message', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    router.addPreHook(async () => ({
      action: 'drop' as const,
      reason: 'blocked',
    }));

    await router.route({
      chatJid: 'C123',
      text: 'hello',
      triggerType: 'agent-response',
    });

    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it('pre-hook can modify envelope', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    router.addPreHook(async (envelope) => ({
      action: 'modify' as const,
      envelope: { ...envelope, text: envelope.text + ' [modified]' },
    }));

    await router.route({
      chatJid: 'C123',
      text: 'hello',
      triggerType: 'agent-response',
    });

    expect(slack.sendMessage).toHaveBeenCalledWith('C123', 'hello [modified]');
  });

  it('post-hook receives envelope after delivery', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    await router.route({
      chatJid: 'C123',
      text: 'hello',
      triggerType: 'agent-response',
    });

    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'C123', text: 'hello' }),
    );
  });

  // L28: route() must hand the post-hook the text actually DELIVERED (internal
  // tags stripped), not the raw envelope text with <internal>...</internal>.
  it('post-hook records the delivered (stripped) text, not the raw text', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    await router.route({
      chatJid: 'C123',
      text: 'visible <internal>secret</internal> text',
      triggerType: 'ipc',
    });

    // Channel got the stripped text...
    expect(slack.sendMessage).toHaveBeenCalledWith('C123', 'visible  text');
    // ...and so did the observer (no <internal> content leaks into the audit log).
    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'C123', text: 'visible  text' }),
    );
    const recordedText = postHook.mock.calls[0][0].text as string;
    expect(recordedText).not.toContain('secret');
    expect(recordedText).not.toContain('<internal>');
  });

  // L27: an effectively-empty IPC send (all-<internal> / whitespace) must STILL
  // fire the post-hook so the IPC cursor advances on the confirmed no-op
  // delivery; otherwise the runner's turn is re-processed. The text passed to
  // the observer is the delivered (empty) text, not the raw <internal> payload.
  it('fires post-hook for empty-after-format IPC sends (cursor advance) with empty text', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    const delivered = await router.route({
      chatJid: 'C123',
      text: '<internal>only internal</internal>',
      triggerType: 'ipc',
    });

    // No user-visible text was delivered.
    expect(delivered).toBeNull();
    expect(slack.sendMessage).not.toHaveBeenCalled();
    // But the cursor-advance post-hook still ran (records the empty delivered text).
    expect(postHook).toHaveBeenCalledTimes(1);
    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'C123',
        triggerType: 'ipc',
        text: '',
      }),
    );
  });

  // L27 guard: a non-IPC empty-after-format send must remain a pure no-op — no
  // observer fired (avoids recording phantom empty agent-response events).
  it('does not fire post-hook for empty-after-format non-IPC sends', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    const delivered = await router.route({
      chatJid: 'C123',
      text: '<internal>only internal</internal>',
      triggerType: 'agent-response',
    });

    expect(delivered).toBeNull();
    expect(slack.sendMessage).not.toHaveBeenCalled();
    expect(postHook).not.toHaveBeenCalled();
  });

  it('post-hook receives envelope after photo delivery', async () => {
    const slack = {
      ...mockChannel('slack', 'C'),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
    };
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    await router.sendPhoto('C123', '/tmp/photo.jpg', 'caption');

    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'C123',
        text: 'caption',
        triggerType: 'ipc',
        meta: { kind: 'photo', filePath: '/tmp/photo.jpg' },
      }),
    );
  });

  it('preserves host-owned photo metadata for cursor-independent recovery', async () => {
    const slack = {
      ...mockChannel('slack', 'C'),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
    };
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    await router.sendPhoto('C123', '/tmp/photo.jpg', 'caption', {
      suppressCursorAdvance: true,
      meta: { kind: 'image_job_photo', imageJobId: 'img-1' },
    });

    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'C123',
        triggerType: 'ipc',
        meta: {
          kind: 'image_job_photo',
          filePath: '/tmp/photo.jpg',
          imageJobId: 'img-1',
          suppressCursorAdvance: true,
        },
      }),
    );
  });

  it('post-hook receives envelope after voice delivery', async () => {
    const slack = {
      ...mockChannel('slack', 'C'),
      sendVoice: vi.fn().mockResolvedValue(undefined),
    };
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    await router.sendVoice('C123', 'spoken reply');

    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'C123',
        text: 'spoken reply',
        triggerType: 'ipc',
        meta: { kind: 'voice' },
      }),
    );
  });

  it('post-hook receives envelope after document delivery', async () => {
    const slack = {
      ...mockChannel('slack', 'C'),
      sendDocument: vi.fn().mockResolvedValue(undefined),
    };
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    await router.sendDocument('C123', '/tmp/report.docx', 'edited');

    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'C123',
        text: 'edited',
        triggerType: 'ipc',
        meta: { kind: 'document', filePath: '/tmp/report.docx' },
      }),
    );
  });

  it('host-owned document sends can suppress the IPC cursor advance', async () => {
    const slack = {
      ...mockChannel('slack', 'C'),
      sendDocument: vi.fn().mockResolvedValue(undefined),
    };
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    await router.sendDocument('C123', '/tmp/report.pdf', undefined, {
      suppressCursorAdvance: true,
      meta: { kind: 'local_file_document' },
    });

    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'C123',
        triggerType: 'ipc',
        meta: {
          kind: 'local_file_document',
          filePath: '/tmp/report.pdf',
          suppressCursorAdvance: true,
        },
      }),
    );
  });

  it('warns when no channel owns the JID', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    let deliveryError: unknown;
    try {
      await router.route({
        chatJid: 'unknown-jid',
        text: 'hello',
        triggerType: 'agent-response',
      });
    } catch (error) {
      deliveryError = error;
    }
    expect(deliveryError).toBeInstanceOf(Error);
    expect((deliveryError as Error).message).toContain(
      'No connected channel for JID',
    );
    expect((deliveryError as Error).message).not.toContain('unknown-jid');

    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it('throws when the owning channel fails delivery', async () => {
    const slack = mockChannel('slack', 'C');
    vi.mocked(slack.sendMessage).mockRejectedValueOnce(
      new Error('send failed'),
    );
    const router = createMessageRouter([slack]);

    await expect(
      router.route({
        chatJid: 'C123',
        text: 'hello',
        triggerType: 'agent-response',
      }),
    ).rejects.toThrow('send failed');
  });
});
