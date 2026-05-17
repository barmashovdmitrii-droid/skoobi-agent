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

    router.addPreHook(async () => ({ action: 'drop' as const, reason: 'blocked' }));

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

  it('warns when no channel owns the JID', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    await expect(router.route({
      chatJid: 'unknown-jid',
      text: 'hello',
      triggerType: 'agent-response',
    })).rejects.toThrow('No connected channel for JID');

    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it('throws when the owning channel fails delivery', async () => {
    const slack = mockChannel('slack', 'C');
    vi.mocked(slack.sendMessage).mockRejectedValueOnce(new Error('send failed'));
    const router = createMessageRouter([slack]);

    await expect(router.route({
      chatJid: 'C123',
      text: 'hello',
      triggerType: 'agent-response',
    })).rejects.toThrow('send failed');
  });
});
