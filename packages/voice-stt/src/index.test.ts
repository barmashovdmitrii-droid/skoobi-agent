import { describe, expect, it } from 'vitest';

import * as voiceStt from './index.js';

// r1111 (SEC-09): transcribeTelegramVoice (сам скачивал голосовое через
// Bot API по токену) никто не вызывал — голос в Telegram идёт через
// transcribeAudioFile после общей загрузки медиа. Из пакета остаётся только
// то, чем пользуются.
describe('@skoobi/voice-stt: публичное API', () => {
  it('отдаёт распознавание файла и помощник повторной загрузки, без мёртвого Telegram-пути', () => {
    expect(typeof voiceStt.transcribeAudioFile).toBe('function');
    expect(typeof voiceStt.unlinkPartialBeforeRetry).toBe('function');
    expect('transcribeTelegramVoice' in voiceStt).toBe(false);
  });
});
