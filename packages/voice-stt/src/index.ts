// @skoobi/voice-stt — распознавание голоса (speech-to-text).
// Public API: transcribeAudioFile (any audio file → text via local whisper),
// unlinkPartialBeforeRetry (уборка недокачанного файла перед повтором загрузки).
export * from './transcription.js';
export * from './partial-download.js';
