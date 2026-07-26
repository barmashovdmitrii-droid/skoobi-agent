import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const messagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: messagesCreate };
    constructor(_opts: unknown) {}
  }
  return { default: MockAnthropic };
});

vi.mock('@skoobi/core/cost-tracking', () => ({
  logAgentRun: vi.fn(),
}));

// Import AFTER mocks are set up.
import { captionPhoto } from './photo-caption.js';
import { logAgentRun } from '@skoobi/core/cost-tracking';

describe('captionPhoto', () => {
  let dir: string;
  let photoPath: string;
  let prevKey: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'photo-caption-test-'));
    photoPath = path.join(dir, 'photo.jpg');
    // Minimal JPEG-like bytes; we never decode it — Anthropic does.
    await fs.writeFile(photoPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
    prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    messagesCreate.mockReset();
    vi.mocked(logAgentRun).mockReset();
  });

  afterEach(async () => {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns caption text on success and records cost', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Кошка лежит на подоконнике.' }],
      usage: {
        input_tokens: 1500,
        output_tokens: 18,
        cache_creation_input_tokens: 80,
        cache_read_input_tokens: 0,
      },
    });

    const result = await captionPhoto(photoPath, {
      groupFolder: 'telegram_main',
      chatJid: 'tg:1',
    });

    expect(result).toBe('Кошка лежит на подоконнике.');
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const call = messagesCreate.mock.calls[0][0];
    expect(call.model).toMatch(/haiku/i);
    // Prompt caching marker present on the system message
    expect(call.system[0].cache_control).toEqual({ type: 'ephemeral' });
    // Image content present
    expect(call.messages[0].content[0].type).toBe('image');
    expect(call.messages[0].content[0].source.media_type).toBe('image/jpeg');

    expect(logAgentRun).toHaveBeenCalledTimes(1);
    expect(logAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        groupFolder: 'telegram_main',
        chatJid: 'tg:1',
        inputTokens: 1500,
        outputTokens: 18,
        cacheCreationTokens: 80,
        status: 'success',
      }),
    );
  });

  it('returns null when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await captionPhoto(photoPath);
    expect(result).toBeNull();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('returns null on network/API error', async () => {
    messagesCreate.mockRejectedValueOnce(new Error('network down'));
    const result = await captionPhoto(photoPath);
    expect(result).toBeNull();
    expect(logAgentRun).not.toHaveBeenCalled();
  });

  it('returns null on empty model response', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [], usage: {} });
    const result = await captionPhoto(photoPath);
    expect(result).toBeNull();
  });

  it('returns null for unsupported file types', async () => {
    const txtPath = path.join(dir, 'note.txt');
    await fs.writeFile(txtPath, 'hello');
    const result = await captionPhoto(txtPath);
    expect(result).toBeNull();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('returns null if the photo file cannot be read', async () => {
    const result = await captionPhoto(path.join(dir, 'missing.jpg'));
    expect(result).toBeNull();
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});
