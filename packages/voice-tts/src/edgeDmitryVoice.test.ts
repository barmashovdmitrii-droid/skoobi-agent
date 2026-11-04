import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ synthesize: vi.fn() }));
vi.mock('node-edge-tts', () => ({
  EdgeTTS: class {
    ttsPromise(text: string, file: string) {
      return calls.synthesize(text, file);
    }
  },
}));

import { synthesizeDmitryVoice } from './edgeDmitryVoice.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

it('uses the bundled TTS client when an optional helper is absent', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-tts-test-'));
  directories.push(outputDir);
  calls.synthesize.mockImplementation(async (_text: string, file: string) => {
    fs.writeFileSync(file, Buffer.from('synthetic audio'));
  });

  const result = await synthesizeDmitryVoice('Synthetic voice reply', {
    outputDir,
    edgeTtsScript: path.join(outputDir, 'missing-helper.py'),
    attempts: 1,
  });

  expect(calls.synthesize).toHaveBeenCalledOnce();
  expect(calls.synthesize).toHaveBeenCalledWith(
    'Synthetic voice reply',
    result.filePath,
  );
  expect(result.mimeType).toBe('audio/mpeg');
  expect(fs.readFileSync(result.filePath, 'utf8')).toBe('synthetic audio');
  expect(fs.existsSync(path.join(outputDir, 'reply.txt'))).toBe(false);
});
