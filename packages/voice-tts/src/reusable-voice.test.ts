import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it, expect, vi } from 'vitest';
import { synthesizeReusableVoice } from './tts.js';
it('creates reusable editing derivatives without sending or invoking a provider', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-fixture-'));
  const ogg = path.join(root, 'voice.ogg');
  fs.writeFileSync(ogg, 'OggS fixture');
  const cleanup = vi.fn(() =>
    fs.rmSync(root, { recursive: true, force: true }),
  );
  const synthesize = vi.fn(async () => ({ files: [ogg], cleanup }));
  const convert = vi.fn(
    async (_input: string, out: string, format: 'mp3' | 'wav') => {
      fs.writeFileSync(
        out,
        format === 'mp3' ? 'ID3 fixture' : 'RIFF0000WAVE fixture',
      );
    },
  );
  const audio = await synthesizeReusableVoice('Synthetic spoken text', {
    synthesize,
    convert,
  });
  expect(synthesize).toHaveBeenCalledOnce();
  expect(convert).toHaveBeenCalledTimes(2);
  expect(audio.parts).toHaveLength(1);
  expect(fs.existsSync(audio.parts[0].wav)).toBe(true);
  expect(cleanup).not.toHaveBeenCalled();
  audio.cleanup();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(fs.existsSync(audio.parts[0].mp3)).toBe(false);
});
it('conversion failure cleans both temporary roots and never retries synthesis', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-failure-')),
    ogg = path.join(root, 'voice.ogg');
  fs.writeFileSync(ogg, 'OggS fixture');
  const cleanup = vi.fn(() =>
    fs.rmSync(root, { recursive: true, force: true }),
  );
  const synthesize = vi.fn(async () => ({ files: [ogg], cleanup }));
  await expect(
    synthesizeReusableVoice('Synthetic', {
      synthesize,
      convert: async () => {
        throw new Error('synthetic conversion failure');
      },
    }),
  ).rejects.toThrow();
  expect(synthesize).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
});
